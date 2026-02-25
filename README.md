# QR Coupon Capture (No External Deps)

## Prereqs
- Node.js 18+

## Google Sheets setup (Service Account)
1. Create a Google Sheet and add a header row:
   - `timestamp, name, email, phone, coupon`
2. Google Cloud Console:
   - Enable **Google Sheets API** for your project.
   - Create a **Service Account**.
   - Create a **JSON key** for the service account.
3. Share the sheet with the service account email (Editor access).

## Local setup
1. Put the service account JSON at:
   - `./secrets/google-service-account.json`
2. Set env vars (examples):
   - `export GOOGLE_SHEET_ID="<sheet-id>"`
   - `export GOOGLE_SHEET_TAB="Leads"`
   - `export ENABLE_GOOGLE_SHEETS="true"`
   - `export ADMIN_USER="admin"`
   - `export ADMIN_PASS="change-me"`

## Render setup
1. Add a **Secret File** at:
   - `/etc/secrets/google-service-account.json`
2. Set env vars:
   - `GOOGLE_SHEET_ID` (required when sheets enabled)
   - `GOOGLE_SHEET_TAB` (default `Leads`)
   - `ENABLE_GOOGLE_SHEETS` (defaults to `true` in prod)
   - `ADMIN_USER`, `ADMIN_PASS`

## Run locally
- `node server.js`
- Open `http://localhost:3000`

## Environment variables
- `PORT` (default `3000`)
- `COUPON_PREFIX` (default `SAVE`)
- `GOOGLE_SA_PATH` (default `/etc/secrets/google-service-account.json`, fallback `./secrets/google-service-account.json`)
- `GOOGLE_SHEET_ID` (required when Sheets enabled)
- `GOOGLE_SHEET_TAB` (default `Leads`)
- `ENABLE_GOOGLE_SHEETS` (default `true` in prod, `false` otherwise)
- `ADMIN_USER` / `ADMIN_PASS` (required for `/admin` and `/admin/export`)
- Twilio (optional SMS sending):
  - `ENABLE_TWILIO` (set to `true` to send real SMS)
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_FROM_PHONE`

## Data files (local fallback / logs)
- `data/leads.csv` stores submissions
- `data/last_sent.json` stores last SMS timestamps per phone
- `data/sms_outbox.log` stores SMS log lines

## Twilio setup (optional)
1. Create or log into your Twilio account (trial is fine).
2. Get an SMS-capable phone number.
3. For trial accounts, verify your destination phone number in Twilio.
4. Set env vars:
   - `ENABLE_TWILIO=true`
   - `TWILIO_ACCOUNT_SID=...`
   - `TWILIO_AUTH_TOKEN=...`
   - `TWILIO_FROM_PHONE=+14155552671`

If Twilio is not enabled or sending fails, the app falls back to logging SMS to `data/sms_outbox.log`.

## Render env vars to add
- `ENABLE_TWILIO=true`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_PHONE`

## Admin
- `/admin` shows last 200 leads (most recent first)
- `/admin/export` downloads CSV of last 200 leads
- If Google Sheets is disabled/unavailable, admin reads from `data/leads.csv`

## QR code generation
- `./scripts/make-qr.sh https://your-domain.com`
- If `qrencode` is installed, it generates `qr.png`.
- Otherwise it prints the URL and a fallback instruction.
