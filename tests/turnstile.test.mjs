import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

async function harness({ validation = { success: true }, unavailable = false, env = {} } = {}) {
  let handler;
  const calls = [];
  const context = vm.createContext({
    process: {
      env: { ADESTRA_API_TOKEN: 'test-token', ADESTRA_TABLE_ID: '145', ADESTRA_LIST_ID: '4508', ...env },
      exit() { throw new Error('Startup rejected'); },
    },
    console: { log() {}, error() {}, warn() {} },
    URL, Buffer, AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes('siteverify')) {
        if (unavailable) throw new Error('Network unavailable');
        return { ok: true, json: async () => validation };
      }
      return { status: 201, statusText: 'Created', url, text: async () => '{}' };
    },
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    if (specifier === 'node:http') {
      return new vm.SyntheticModule(['createServer'], function () {
        this.setExport('createServer', (callback) => {
          handler = callback;
          return { listen() {} };
        });
      }, { context });
    }
    return new vm.SyntheticModule(['readFile'], function () {
      this.setExport('readFile', async () => '');
    }, { context });
  });
  await module.evaluate();
  return {
    calls,
    async request(body, path = '/api/subscribe', method = 'POST') {
      let status;
      let result;
      const req = {
        method, url: path, socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
      };
      await handler(req, {
        setHeader() {},
        writeHead(value) { status = value; },
        end(value) { result = JSON.parse(value); },
      });
      return { status, body: result };
    },
  };
}

test('verified token reaches Adestra, but token and secret do not enter its payload', async () => {
  const app = await harness();
  const token = 'a'.repeat(2048);
  const result = await app.request({ email: 'test@example.com', turnstileToken: token });
  assert.equal(result.status, 200);
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].body.response, token);
  assert.equal(app.calls[1].body.contact_data.email, 'test@example.com');
  assert.equal(JSON.stringify(app.calls[1].body).includes(token), false);
  assert.equal(JSON.stringify(result.body).includes(app.calls[0].body.secret), false);
});

for (const token of [undefined, '', ' ', 12, 'a'.repeat(2049)]) {
  test(`rejects missing or malformed token (${typeof token}, length ${token?.length})`, async () => {
    const app = await harness();
    assert.equal((await app.request({ email: 'test@example.com', turnstileToken: token })).status, 400);
    assert.equal(app.calls.length, 0);
  });
}

test('expired or reused tokens cannot reach Adestra', async () => {
  const app = await harness({ validation: { success: false, 'error-codes': ['timeout-or-duplicate'] } });
  assert.equal((await app.request({ email: 'test@example.com', turnstileToken: 'spent' })).status, 400);
  assert.equal(app.calls.length, 1);
});

test('Cloudflare failure fails closed', async () => {
  const app = await harness({ unavailable: true });
  assert.equal((await app.request({ email: 'test@example.com', turnstileToken: 'token' })).status, 503);
  assert.equal(app.calls.length, 1);
});

test('config endpoint exposes only the public site key', async () => {
  const app = await harness();
  const result = await app.request({}, '/api/config', 'GET');
  assert.deepEqual(Object.keys(result.body), ['turnstileSiteKey']);
});

test('production refuses test keys', async () => {
  await assert.rejects(harness({ env: { NODE_ENV: 'production' } }), /Startup rejected/);
});

test('real keys enforce the action and configured hostname', async () => {
  const env = { TURNSTILE_SITE_KEY: 'real-site-key', TURNSTILE_SECRET_KEY: 'real-secret', TURNSTILE_HOSTNAME: 'example.com' };
  for (const validation of [
    { success: true, action: 'other', hostname: 'example.com' },
    { success: true, action: 'subscribe', hostname: 'other.example.com' },
    { success: true, action: 'subscribe', hostname: 'example.com' },
  ]) {
    const app = await harness({ env, validation });
    const accepted = validation.action === 'subscribe' && validation.hostname === 'example.com';
    assert.equal((await app.request({ email: 'test@example.com', turnstileToken: 'token' })).status, accepted ? 200 : 400);
    assert.equal(app.calls.length, accepted ? 2 : 1);
  }
});