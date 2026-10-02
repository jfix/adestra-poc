# Adestra sign-up POC

Proof of concept for adding contacts to an Adestra (MessageFocus) list via the
[REST Contact API](https://app.adestra.com/doc/page/current/index/api/rest/contact),
with a small email sign-up form designed to be embedded in another page via an iframe.

## Requirements

- Node.js 24+ (uses built-in `fetch`, `--env-file` and `--use-system-ca`; no npm dependencies)
- An Adestra API token with **write** access

## Configuration

Copy `.env.example` to `.env` in the project root (it is git-ignored):

```powershell
Copy-Item .env.example .env
```

| Variable | Description |
|---|---|
| `ADESTRA_API_TOKEN` | API token (Adestra user panel → *Manage API tokens*) |
| `ADESTRA_TABLE_ID` | Core table the contact is stored in (`145` = "DKI testing list") |
| `ADESTRA_LIST_ID` | List the contact is added to; must belong to the same core table (`4508`, workspace 100) |
| `PORT` | Optional, web app port (default `3000`) |
| `ADESTRA_LANGUAGE` | Optional, `en` or `fr`; sent as the core-table field `language` by the server and CLI |
| `ADESTRA_SOURCE_PATH` | Optional, source page path (maximum 1024 characters); sent as the core-table field `source_path` by the server and CLI. Use an Adestra Large Text field for values longer than 255 characters. |

These values are shared defaults for this deployment, not automatically captured
from the embedding page. Both fields must exist on the configured core table.
Subsequent signups for the same email can overwrite them; they do not retain
per-newsletter signup history or automatically select an opt-in campaign.

## Usage

`--use-system-ca` makes Node trust the Windows certificate store. It is needed on
networks with TLS inspection, otherwise requests fail with `SELF_SIGNED_CERT_IN_CHAIN`.

### Web app (embeddable form)

```powershell
node --use-system-ca --env-file=.env server.mjs
```

Open http://localhost:3000, or embed it:

```html
<iframe src="http://localhost:3000/" height="120" style="border:0;width:100%"></iframe>
```

- The form is a fixed **120px** high; the result message replaces the form in the same space.
- `POST /api/subscribe` with `{ "email": "..." }` creates the contact server-side; the API token never reaches the browser.
- Adestra responses are translated into user-friendly messages; the raw response is logged to the server console.
- Basic protection: email validation, 1 KB request body limit, 5 requests/minute per IP (in memory).

### CLI script

Creates a single contact from the `ADESTRA_TEST_*` / name variables and prints the raw API response:

```powershell
node --use-system-ca --env-file=.env create-contact.mjs
```

## Project structure

```
server.mjs          Node HTTP server: static files + /api/subscribe
public/index.html   Sign-up form
public/app.js       Form submission and result display
public/style.css    Fixed-height layout
create-contact.mjs  One-off contact creation script
```

## Before going live

- Restrict `frame-ancestors` in `server.mjs` (currently `*`) to the embedding site's domain.
- Serve over HTTPS.
- Replace the in-memory rate limiter if running more than one instance.
- Set up the double opt-in automation program in Adestra (see the
  [Double Opt-in tutorial](https://app.adestra.com/doc/page/current/index/forms/tutorial-double-opt-in))
  and associate it with the list, so the confirmation email is actually sent.
