# Adestra double opt-in proof of concept

Small Node app (no dependencies, Node 18+) that takes an email address, adds it to an
Adestra list and sends a welcome / double-opt-in email, with a browser UI that shows each
API step as it happens.

## Setup

```bash
cp .env.example .env     # then fill in ADESTRA_API_TOKEN, ADESTRA_LIST_ID, ADESTRA_CAMPAIGN_ID
node server.js
```

Open http://localhost:3000.

To try the UI without credentials set `ADESTRA_MOCK=1` in `.env` (all API calls are faked).

## What it calls (Adestra REST API v1, `Authorization: TOKEN <key>`)

| Step | Request | Purpose |
|---|---|---|
| 1 | `GET /api/rest/1/lists/{list_id}` | Verifies the token and list, and returns the list's `table_id` (core table) needed to create contacts. |
| 2 | `POST /api/rest/1/contacts` `{table_id, contact_data:{email}, dedupe_field:"email"}` | Creates the contact, or updates the existing one with that email. |
| 3 | `POST /api/rest/1/contacts/{contact_id}/lists/{list_id}` | Adds the contact to the list (no-op if already on it). |
| 4 | `POST /api/rest/1/campaigns/{campaign_id}/send_single` | Sends the campaign as a single transactional email to that contact. |

Step 4 passes `transaction_data` (`email`, `list_id`, `contact_id`, `requested_at`) which your
campaign template can use as the `transaction` variable, e.g. to build a confirmation link.

## Debugging

- **Test connection** (button in the UI, or `GET /api/diagnostics`) shows the public IP Adestra
  sees, DNS for the API host, the masked token, and runs a read-only `GET /lists/{id}` probe.
- Every step shows the HTTP round trip: method, URL, status, duration, request body, response
  headers, raw response body, and a curl command to reproduce it (token masked). Tick
  **show HTTP details** to expand them by default.
- Known errors get a plain-language hint, e.g. `401 {"error":"ip"}` means the token is fine but
  this machine's IP is not on the token's allowlist in Adestra.
- The **Event log** card keeps a timestamped record of everything for the session; **copy** puts it
  on the clipboard for pasting into a ticket.
- The server also logs each API call with status and timing to stdout.

## Things to know

- The welcome campaign must be **published**, otherwise Adestra answers 409 "Campaign has not been published".
- It must not be attached to a **dynamic list** (409).
- If the address is on the unsubscribe list or known to bounce, Adestra accepts the call but
  reports `suppressed: true`. The UI shows this as a warning on step 4.
- The API token only needs write access to contacts, lists and campaigns.
- Docs: https://app.adestra.com/doc/page/current/index/api/rest/contact and
  https://app.adestra.com/doc/page/current/index/api/rest/campaign
