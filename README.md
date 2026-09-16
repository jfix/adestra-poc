# Adestra double opt-in proof of concept

Small Node app (no dependencies, Node 18+) with a sign-up form that stays on the page: the
browser posts to this server, the server relays the sign-up to Adestra, and the page shows a
"check your inbox" popup. Adestra sends the confirmation email and handles the confirmation
click. A debug panel shows every step and HTTP round trip.

Two mechanisms are built in, switchable in the UI:

- **Form relay** (default, recommended). The server posts the same fields an Adestra static /
  Form Builder form would post, server-to-server, to the Adestra form handler. Adestra then runs
  the form's actions. With Adestra's own double opt-in recipe ("Add to Program" action,
  automation sends the confirmation campaign, link-click filter adds verified contacts to the
  real list) the address is never on the mailing list before it is confirmed. No API token or
  IP allowlist is needed.
- **REST API**. Look up list, create contact, add to list, `send_single` the campaign. This is
  Adestra's documented API sign-up example; on its own it is single opt-in with a welcome email.

## Setup

```bash
cp .env.example .env     # then fill in ADESTRA_API_TOKEN, ADESTRA_LIST_ID, ADESTRA_CAMPAIGN_ID
node server.js
```

Open http://localhost:3000.

To try the UI without credentials set `ADESTRA_MOCK=1` in `.env` (all API calls are faked).

## Form relay: how it works

1. The page submits by AJAX to `POST /api/optin` on this server (no navigation).
2. The server builds the field set from `ADESTRA_FORM_HIDDEN` plus the email and first name,
   sets `_rp` (return URL) and POSTs it `application/x-www-form-urlencoded` to
   `ADESTRA_FORM_URL` with redirects disabled.
3. A `3xx` redirect to the return URL means Adestra accepted the submission. A `200` means the
   handler re-rendered the form (validation, CAPTCHA, missing field); `403` means server-side
   submissions are blocked. The UI shows the verdict and the raw response either way.
4. The page shows the popup. Everything after that (confirmation email, click, list membership)
   happens inside Adestra.

Getting the field names: in Adestra open the form, use **Download → Unstyled Form**, and copy the
`<form action>` into `ADESTRA_FORM_URL` and the hidden `<input>`s into `ADESTRA_FORM_HIDDEN`.
For a bespoke static form the documented fields are `_account_id`, `_table_id`, `_dedupe`,
`_email_field`, `_list_id` (repeatable) and `_rp`.

Things to confirm with Adestra support before relying on this: that the handler accepts
server-to-server POSTs, what it returns on success, and whether a CAPTCHA element can be
satisfied from an external page.

## REST API mode: what it calls (Adestra REST API v1, `Authorization: TOKEN <key>`)

| Step | Request | Purpose |
|---|---|---|
| 1 | `GET /api/rest/1/lists/{list_id}` | Verifies the token and list, and returns the list's `table_id` (core table) needed to create contacts. |
| 2 | `POST /api/rest/1/contacts` `{table_id, contact_data:{email}, dedupe_field:"email"}` | Creates the contact, or updates the existing one with that email. |
| 3 | `POST /api/rest/1/contacts/{contact_id}/lists/{list_id}` | Adds the contact to the list (no-op if already on it). |
| 4 | `POST /api/rest/1/campaigns/{campaign_id}/send_single` | Sends the campaign as a single transactional email to that contact. |

Step 4 passes `transaction_data` (`email`, `list_id`, `contact_id`, `requested_at`) which your
campaign template can use as the `transaction` variable, e.g. to build a confirmation link.

## Debugging

- **Test connection** (REST API mode; button in the UI, or `GET /api/diagnostics`) shows the public IP Adestra
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
- Docs: [double opt-in tutorial](https://app.adestra.com/doc/page/current/index/forms/tutorial-double-opt-in),
  [using forms](https://app.adestra.com/doc/page/current/index/forms/using-forms),
  [bespoke forms](https://app.adestra.com/doc/page/current/index/forms/bespoke-forms),
  [form actions](https://app.adestra.com/doc/page/current/index/forms/actions),
  [contact REST API](https://app.adestra.com/doc/page/current/index/api/rest/contact),
  [campaign REST API](https://app.adestra.com/doc/page/current/index/api/rest/campaign).
