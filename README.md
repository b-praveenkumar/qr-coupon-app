# QR Coupon Capture (No External Deps)

## Prereqs
- Node.js 18+ (no npm install required)

## Setup
1. Optional env file:
   - `cp .env.example .env`
2. Set env vars if needed (see below).

## Run locally
- `node server.js`
- Open `http://localhost:3000`

## Environment variables
- `PORT` (default `3000`)
- `COUPON_PREFIX` (default `SAVE`)
- Twilio placeholders (unused in this no-deps version):
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_FROM_PHONE`

## Data files
- `data/leads.csv` stores submissions
- `data/last_sent.json` stores last SMS timestamps per phone
- `data/sms_outbox.log` stores SMS log lines

## Generate a QR code PNG
Use the built-in script (no install required):
- `./scripts/make-qr.sh https://your-domain.com`

If `qrencode` is installed, it will generate `qr.png`.
Otherwise, it will print instructions to use any QR generator website.
