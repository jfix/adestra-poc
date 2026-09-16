// Adestra double opt-in proof of concept.
// Zero dependencies. Requires Node 18+ (built-in fetch).
//
// Flow per request:
//   1. GET  /lists/{list_id}                       -> verify token + list, learn table_id
//   2. POST /contacts  {table_id, contact_data}    -> create (or dedupe-update) contact by email
//   3. POST /contacts/{contact_id}/lists/{list_id} -> add contact to the list
//   4. POST /campaigns/{campaign_id}/send_single   -> send the welcome / opt-in email
//
// Config comes from .env (see .env.example). The API token never leaves this process.

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- config ----------
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env, rely on environment */ }
}
loadEnv(path.join(__dirname, ".env"));

const CONFIG = {
  domain: process.env.ADESTRA_DOMAIN || "app.adestra.com",
  token: process.env.ADESTRA_API_TOKEN || "",
  listId: process.env.ADESTRA_LIST_ID || "",
  campaignId: process.env.ADESTRA_CAMPAIGN_ID || "",
  mock: process.env.ADESTRA_MOCK === "1",
  port: Number(process.env.PORT || 3000),
};
const BASE = `https://${CONFIG.domain}/api/rest/1`;

// ---------- Adestra client ----------
function maskToken(t) { return t ? `${t.slice(0, 4)}…${t.slice(-2)} (${t.length} chars)` : "(none)"; }

function curlFor(method, url, body) {
  let c = `curl -X ${method} -H 'Authorization: TOKEN <token>' -H 'Accept: application/json'`;
  if (body !== undefined) c += ` -H 'Content-Type: application/json' --data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  return `${c} '${url}'`;
}

// Performs one API call. Returns { status, data, exchange } where exchange describes
// the raw HTTP round trip for debugging. On failure the thrown error carries the same exchange.
async function adestra(method, endpoint, body) {
  const url = `${BASE}${endpoint}`;
  const headers = { Authorization: `TOKEN ${CONFIG.token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const exchange = { method, url, requestBody: body ?? null, curl: curlFor(method, url, body), mock: CONFIG.mock, startedAt: new Date().toISOString() };
  const t0 = Date.now();

  if (CONFIG.mock) {
    try {
      const r = await mockResponse(method, endpoint, body);
      Object.assign(exchange, { status: r.status, durationMs: Date.now() - t0, responseBody: JSON.stringify(r.data), responseHeaders: { "x-mock": "1" } });
      return { ...r, exchange };
    } catch (e) {
      Object.assign(exchange, { status: e.status, durationMs: Date.now() - t0, responseBody: e.message });
      e.exchange = exchange; throw e;
    }
  }

  let res, text;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    text = await res.text();
  } catch (e) {
    Object.assign(exchange, { status: 0, durationMs: Date.now() - t0, responseBody: null, networkError: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}` });
    const err = new Error(`Network error: ${exchange.networkError}`);
    err.exchange = exchange; throw err;
  }
  const responseHeaders = {};
  for (const h of ["content-type", "content-length", "date", "server", "x-request-id", "x-ratelimit-remaining", "retry-after"]) {
    const v = res.headers.get(h); if (v) responseHeaders[h] = v;
  }
  Object.assign(exchange, { status: res.status, statusText: res.statusText, durationMs: Date.now() - t0, responseHeaders, responseBody: text });

  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.faultString || data.message || data.error)) || (typeof data === "string" ? data.slice(0, 200) : "") || res.statusText;
    const err = new Error(`HTTP ${res.status} ${msg}`.trim());
    err.status = res.status; err.data = data; err.exchange = exchange;
    throw err;
  }
  return { status: res.status, data, exchange };
}

// Fake responses so the UI can be exercised without credentials (ADESTRA_MOCK=1).
async function mockResponse(method, endpoint, body) {
  await new Promise((r) => setTimeout(r, 400));
  if (method === "GET" && /^\/lists\/\d+$/.test(endpoint))
    return { status: 200, data: { id: Number(endpoint.split("/")[2]), name: "Mock newsletter list", table_id: 1, count: 42, unsub_list_id: 9 } };
  if (method === "POST" && endpoint === "/contacts")
    return { status: 201, data: { id: 12345, email: body.contact_data.email } };
  if (method === "POST" && /^\/contacts\/\d+\/lists\/\d+$/.test(endpoint))
    return { status: 201, data: { contact_id: 12345, list_id: Number(endpoint.split("/")[4]) } };
  if (method === "POST" && /^\/campaigns\/\d+\/send_single$/.test(endpoint))
    return { status: 202, data: { contact_id: 12345, is_new_contact: false, suppressed: false } };
  const err = new Error(`HTTP 404 mock has no handler for ${method} ${endpoint}`);
  err.status = 404;
  throw err;
}

// Plain-language hints for the errors we have actually seen or that the docs call out.
function hintFor(e) {
  const body = e.exchange && e.exchange.responseBody ? String(e.exchange.responseBody) : "";
  if (e.exchange && e.exchange.networkError) return "Could not reach the API host at all. Check ADESTRA_DOMAIN, DNS and outbound HTTPS.";
  if (e.status === 401 && /"ip"/.test(body)) return "Token is valid but this machine's public IP is not on the token/user IP allowlist in Adestra. Allowlist the public IP shown in the connection test.";
  if (e.status === 401 && /Invalid account ID/i.test(body)) return "Adestra does not recognise this token. Check ADESTRA_API_TOKEN for typos or whitespace.";
  if (e.status === 401) return "Authentication failed. Check the token and that the user has API access enabled.";
  if (e.status === 403) return "Token authenticated but lacks permission for this object (needs write access to contacts/lists/campaigns, and access to this workspace).";
  if (e.status === 404) return "Object not found. Check the list id / campaign id, or the token cannot see that workspace.";
  if (e.status === 409 && /publish/i.test(body)) return "The campaign is not published. Publish it in Adestra, then retry.";
  if (e.status === 409 && /dynamic/i.test(body)) return "The campaign is attached to a dynamic list; send_single refuses those. Use a campaign on a regular list.";
  if (e.status === 409) return "Conflict. See the response body for the reason.";
  if (e.status === 422) return "Validation error: an email or field value was rejected. See the response body.";
  if (e.status === 429) return "Rate limited or over quota. Wait and retry.";
  if (e.status >= 500) return "Adestra-side error. Retry later.";
  return null;
}

// ---------- the opt-in flow, streamed as NDJSON events ----------
async function runOptIn({ email, firstname, listId, campaignId }, emit) {
  const step = async (n, title, fn) => {
    emit({ type: "step", n, title, state: "running" });
    try {
      const result = await fn();
      emit({ type: "step", n, title, state: "ok", ...result });
      return result;
    } catch (e) {
      emit({ type: "step", n, title, state: "error", message: e.message, detail: e.data ?? null, exchange: e.exchange ?? null, hint: hintFor(e) });
      throw e;
    }
  };

  const list = await step(1, `Look up list ${listId}`, async () => {
    const { data, exchange } = await adestra("GET", `/lists/${listId}`);
    return { message: `List "${data.name}" (core table ${data.table_id}, ${data.count} contacts)`, detail: data, exchange };
  });

  const contact = await step(2, `Create or update contact ${email}`, async () => {
    const contact_data = { email };
    if (firstname) contact_data.firstname = firstname;
    const { data, exchange } = await adestra("POST", "/contacts", { table_id: list.detail.table_id, contact_data, dedupe_field: "email" });
    return { message: `Contact id ${data.id}`, detail: data, exchange };
  });

  await step(3, `Add contact ${contact.detail.id} to list ${listId}`, async () => {
    const { data, exchange } = await adestra("POST", `/contacts/${contact.detail.id}/lists/${listId}`);
    const added = data && data.contact_id !== undefined;
    return { message: added ? "Added to list" : "Already on the list (no change)", detail: data, exchange };
  });

  await step(4, `Send opt-in email via campaign ${campaignId}`, async () => {
    const { data, exchange } = await adestra("POST", `/campaigns/${campaignId}/send_single`, {
      send_single_contact: contact.detail.id,
      transaction_data: { email, list_id: Number(listId), contact_id: contact.detail.id, requested_at: new Date().toISOString() },
      send_single_options: { suppression_info: true },
    });
    if (data && data.suppressed)
      return { message: `Accepted but SUPPRESSED (${data.suppressed_reason}). No email will be delivered.`, detail: data, warn: true, exchange };
    return { message: "Accepted for delivery", detail: data, exchange };
  });

  emit({ type: "done", ok: true });
}

// ---------- tiny HTTP server ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }

  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      domain: CONFIG.domain, baseUrl: BASE, tokenSet: Boolean(CONFIG.token), tokenMasked: maskToken(CONFIG.token),
      listId: CONFIG.listId, campaignId: CONFIG.campaignId, mock: CONFIG.mock, node: process.version,
    }));
  }

  // Connection test: what IP Adestra will see, DNS for the host, and a read-only probe of the list.
  if (req.method === "GET" && req.url.startsWith("/api/diagnostics")) {
    const q = new URL(req.url, "http://x").searchParams;
    const listId = q.get("listId") || CONFIG.listId;
    const out = { at: new Date().toISOString(), node: process.version, baseUrl: BASE, mock: CONFIG.mock, tokenMasked: maskToken(CONFIG.token) };
    try { out.publicIp = (await (await fetch("https://api.ipify.org?format=json")).json()).ip; } catch (e) { out.publicIp = `lookup failed: ${e.message}`; }
    try { out.dns = (await require("dns").promises.lookup(CONFIG.domain, { all: true })).map((a) => `${a.address} (v${a.family})`); } catch (e) { out.dns = `lookup failed: ${e.message}`; }
    if (!CONFIG.token && !CONFIG.mock) out.probe = { ok: false, message: "ADESTRA_API_TOKEN not set" };
    else if (!/^\d+$/.test(String(listId))) out.probe = { ok: false, message: "List id must be numeric" };
    else {
      try { const r = await adestra("GET", `/lists/${listId}`); out.probe = { ok: true, message: `OK: list "${r.data.name}" (table ${r.data.table_id}, ${r.data.count} contacts)`, exchange: r.exchange, data: r.data }; }
      catch (e) { out.probe = { ok: false, message: e.message, exchange: e.exchange ?? null, hint: hintFor(e) }; }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }

  if (req.method === "POST" && req.url === "/api/optin") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }

    const email = String(body.email || "").trim();
    const firstname = String(body.firstname || "").trim();
    const listId = String(body.listId || CONFIG.listId).trim();
    const campaignId = String(body.campaignId || CONFIG.campaignId).trim();

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    const emit = (ev) => res.write(JSON.stringify(ev) + "\n");

    const problems = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push("Enter a valid email address.");
    if (!CONFIG.token && !CONFIG.mock) problems.push("ADESTRA_API_TOKEN is not set in .env.");
    if (!/^\d+$/.test(listId)) problems.push("List ID must be a number (the Adestra list's numeric id).");
    if (!/^\d+$/.test(campaignId)) problems.push("Campaign ID must be a number (the published welcome/opt-in campaign).");
    if (problems.length) {
      emit({ type: "done", ok: false, message: problems.join(" ") });
      return res.end();
    }

    console.log(`[optin] ${email} -> list ${listId}, campaign ${campaignId}${CONFIG.mock ? " (MOCK)" : ""}`);
    const logEmit = (ev) => {
      if (ev.type === "step" && ev.exchange) console.log(`  ${ev.exchange.method} ${ev.exchange.url} -> ${ev.exchange.status} (${ev.exchange.durationMs} ms) ${ev.state === "error" ? ev.message : ""}`);
      emit(ev);
    };
    try { await runOptIn({ email, firstname, listId, campaignId }, logEmit); }
    catch (e) { emit({ type: "done", ok: false, message: e.message }); }
    return res.end();
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(CONFIG.port, () => {
  console.log(`Adestra opt-in PoC listening on http://localhost:${CONFIG.port}`);
  console.log(`  API base: ${BASE}${CONFIG.mock ? "  (MOCK MODE - no real calls)" : ""}`);
  console.log(`  token: ${CONFIG.token ? "set" : "MISSING"}  list: ${CONFIG.listId || "-"}  campaign: ${CONFIG.campaignId || "-"}`);
});
