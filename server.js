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
async function adestra(method, endpoint, body) {
  const url = `${BASE}${endpoint}`;
  const headers = { Authorization: `TOKEN ${CONFIG.token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (CONFIG.mock) return mockResponse(method, endpoint, body);

  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.faultString || data.message || data.error)) || (typeof data === "string" ? data : "") || res.statusText;
    const err = new Error(`HTTP ${res.status} ${msg}`.trim());
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
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

// ---------- the opt-in flow, streamed as NDJSON events ----------
async function runOptIn({ email, firstname, listId, campaignId }, emit) {
  const step = async (n, title, fn) => {
    emit({ type: "step", n, title, state: "running" });
    try {
      const result = await fn();
      emit({ type: "step", n, title, state: "ok", ...result });
      return result;
    } catch (e) {
      emit({ type: "step", n, title, state: "error", message: e.message, detail: e.data ?? null });
      throw e;
    }
  };

  const list = await step(1, `Look up list ${listId}`, async () => {
    const { data } = await adestra("GET", `/lists/${listId}`);
    return { message: `List "${data.name}" (core table ${data.table_id}, ${data.count} contacts)`, detail: data };
  });

  const contact = await step(2, `Create or update contact ${email}`, async () => {
    const contact_data = { email };
    if (firstname) contact_data.firstname = firstname;
    const { data } = await adestra("POST", "/contacts", { table_id: list.detail.table_id, contact_data, dedupe_field: "email" });
    return { message: `Contact id ${data.id}`, detail: data };
  });

  await step(3, `Add contact ${contact.detail.id} to list ${listId}`, async () => {
    const { data } = await adestra("POST", `/contacts/${contact.detail.id}/lists/${listId}`);
    const added = data && data.contact_id !== undefined;
    return { message: added ? "Added to list" : "Already on the list (no change)", detail: data };
  });

  await step(4, `Send opt-in email via campaign ${campaignId}`, async () => {
    const { data } = await adestra("POST", `/campaigns/${campaignId}/send_single`, {
      send_single_contact: contact.detail.id,
      transaction_data: { email, list_id: Number(listId), contact_id: contact.detail.id, requested_at: new Date().toISOString() },
      send_single_options: { suppression_info: true },
    });
    if (data && data.suppressed)
      return { message: `Accepted but SUPPRESSED (${data.suppressed_reason}). No email will be delivered.`, detail: data, warn: true };
    return { message: "Accepted for delivery", detail: data };
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
      domain: CONFIG.domain, baseUrl: BASE, tokenSet: Boolean(CONFIG.token),
      listId: CONFIG.listId, campaignId: CONFIG.campaignId, mock: CONFIG.mock,
    }));
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
    try { await runOptIn({ email, firstname, listId, campaignId }, emit); }
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
