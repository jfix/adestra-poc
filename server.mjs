import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const {
  ADESTRA_API_TOKEN, ADESTRA_TABLE_ID, ADESTRA_LIST_ID,
  ADESTRA_LANGUAGE, ADESTRA_SOURCE_PATH, PORT = 3000,
  TURNSTILE_SITE_KEY = '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA',
  TURNSTILE_HOSTNAME,
} = process.env;

if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY) {
  console.error('Missing TURNSTILE_SITE_KEY or TURNSTILE_SECRET_KEY');
  process.exit(1);
}
const turnstileTestMode = /^[123]x0+/.test(TURNSTILE_SITE_KEY) || /^[123]x0+/.test(TURNSTILE_SECRET_KEY);
if (process.env.NODE_ENV === 'production' && (turnstileTestMode || !TURNSTILE_HOSTNAME)) {
  console.error('Production requires real Turnstile keys and TURNSTILE_HOSTNAME');
  process.exit(1);
}
if (turnstileTestMode) console.warn('Turnstile test keys enabled: this is not bot protection for production.');

if (!ADESTRA_API_TOKEN || !ADESTRA_TABLE_ID || !ADESTRA_LIST_ID) {
  console.error('Missing ADESTRA_API_TOKEN, ADESTRA_TABLE_ID or ADESTRA_LIST_ID in .env');
  process.exit(1);
}

if (ADESTRA_LANGUAGE && !['en', 'fr'].includes(ADESTRA_LANGUAGE)) {
  console.error('ADESTRA_LANGUAGE must be en or fr');
  process.exit(1);
}
if (ADESTRA_SOURCE_PATH && ADESTRA_SOURCE_PATH.length > 1024) {
  console.error('ADESTRA_SOURCE_PATH must not exceed 1024 characters');
  process.exit(1);
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/demo': ['demo.html', 'text/html; charset=utf-8'],
  '/demo.css': ['demo.css', 'text/css; charset=utf-8'],
  '/demo.js': ['demo.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  // POC: any site may embed the iframe; restrict frame-ancestors before going live
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors *",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 16 * 1024;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createContact(email) {
  const payload = {
    table_id: Number(ADESTRA_TABLE_ID),
    contact_data: {
      email,
      ...(ADESTRA_LANGUAGE ? { language: ADESTRA_LANGUAGE } : {}),
      ...(ADESTRA_SOURCE_PATH ? { source_path: ADESTRA_SOURCE_PATH } : {}),
    },
    options: { list_id: Number(ADESTRA_LIST_ID) },
  };
  const started = Date.now();
  const res = await fetch('https://app.adestra.com/api/rest/1/contacts', {
    method: 'POST',
    headers: {
      Authorization: `TOKEN ${ADESTRA_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return {
    status: res.status,
    text,
    debug: {
      request: { method: 'POST', url: res.url, body: payload },
      response: { status: res.status, statusText: res.statusText, body },
      durationMs: Date.now() - started,
    },
  };
}

async function verifyTurnstile(token) {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: TURNSTILE_SECRET_KEY, response: token }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Turnstile verification unavailable');
  const validation = await response.json();
  return validation.success === true
    && (turnstileTestMode || validation.action === 'subscribe')
    && (!TURNSTILE_HOSTNAME || validation.hostname === TURNSTILE_HOSTNAME);
}

async function handleSubscribe(req, res) {
  if (rateLimited(req.socket.remoteAddress)) {
    return sendJson(res, 429, { ok: false, message: 'Too many attempts. Please try again in a minute.' });
  }

  let email;
  let turnstileToken;
  try {
    const body = await readBody(req);
    email = String(body.email ?? '').trim();
    turnstileToken = body.turnstileToken;
  } catch {
    return sendJson(res, 400, { ok: false, message: 'Invalid request.' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return sendJson(res, 400, { ok: false, message: 'Please enter a valid email address.' });
  }
  if (typeof turnstileToken !== 'string' || !turnstileToken.trim() || turnstileToken.length > 2048) {
    return sendJson(res, 400, { ok: false, message: 'Please complete the verification.' });
  }

  try {
    if (!await verifyTurnstile(turnstileToken)) {
      return sendJson(res, 400, { ok: false, message: 'Verification failed or expired. Please try again.' });
    }
  } catch {
    return sendJson(res, 503, { ok: false, message: 'Verification is temporarily unavailable. Please try again.' });
  }

  try {
    const result = await createContact(email);
    console.log(new Date().toISOString(), 'Adestra', result.status, result.text);
    const { debug } = result;

    if (result.status === 201) {
      return sendJson(res, 200, { ok: true, message: 'Thanks! Please check your inbox to confirm.', debug });
    }
    if (result.status === 400) {
      return sendJson(res, 400, { ok: false, message: 'This email address was not accepted.', debug });
    }
    return sendJson(res, 502, { ok: false, message: 'Sign-up is temporarily unavailable. Please try later.', debug });
  } catch (err) {
    const cause = err.cause ?? err;
    console.error(new Date().toISOString(), 'Adestra request failed:', cause);
    const debug = { error: String(cause.message ?? cause), code: cause.code };
    return sendJson(res, 502, { ok: false, message: 'Could not reach the server. Please try later.', debug });
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/api/config') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { turnstileSiteKey: TURNSTILE_SITE_KEY });
  }

  if (req.method === 'POST' && pathname === '/api/subscribe') {
    return handleSubscribe(req, res);
  }

  const file = STATIC_FILES[pathname];
  if (req.method === 'GET' && file) {
    const [name, type] = file;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
    return res.end(await readFile(new URL(`./public/${name}`, import.meta.url)));
  }

  res.writeHead(404, SECURITY_HEADERS);
  res.end('Not found');
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
