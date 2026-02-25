const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const COUPON_PREFIX = process.env.COUPON_PREFIX || 'SAVE';

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_CSV = path.join(DATA_DIR, 'leads.csv');
const LAST_SENT_JSON = path.join(DATA_DIR, 'last_sent.json');
const SMS_OUTBOX = path.join(DATA_DIR, 'sms_outbox.log');

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LEADS_CSV)) {
  fs.writeFileSync(LEADS_CSV, 'timestamp,name,email,phone,coupon\n', 'utf8');
}
if (!fs.existsSync(LAST_SENT_JSON)) {
  fs.writeFileSync(LAST_SENT_JSON, JSON.stringify({}, null, 2), 'utf8');
}
if (!fs.existsSync(SMS_OUTBOX)) {
  fs.writeFileSync(SMS_OUTBOX, '', 'utf8');
}

let lastSent = {};
try {
  lastSent = JSON.parse(fs.readFileSync(LAST_SENT_JSON, 'utf8'));
} catch {
  lastSent = {};
}

const rateLimitStore = new Map();

function basicEmailValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function phoneValid(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function generateCoupon(prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return `${prefix}-${out}`;
}

function sendSms(to, body) {
  const line = `[${new Date().toISOString()}] to=${to} body=${body}\n`;
  fs.appendFileSync(SMS_OUTBOX, line, 'utf8');
  console.log('SMS OUTBOX:', line.trim());
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          reject(new Error('Invalid JSON'));
        }
        return;
      }
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve(obj);
        return;
      }
      resolve({});
    });
  });
}

function rateLimitOk(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimitStore.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

function htmlPage(coupon, message, error) {
  const msgHtml = message
    ? `<div class="msg ${error ? 'err' : 'ok'}">${message}${coupon ? ' Coupon: ' + coupon : ''}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Get Your Coupon</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7fb; color: #111; }
    .wrap { max-width: 520px; margin: 0 auto; padding: 28px 18px 40px; }
    .card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    h1 { font-size: 1.6rem; margin: 0 0 12px; }
    p { margin: 0 0 18px; color: #444; }
    label { display: block; font-weight: 600; margin: 12px 0 6px; }
    input { width: 100%; padding: 12px; font-size: 1rem; border-radius: 10px; border: 1px solid #ddd; }
    button { margin-top: 16px; width: 100%; padding: 12px; font-size: 1rem; border: 0; border-radius: 10px; background: #1f6feb; color: #fff; font-weight: 700; }
    .msg { margin-top: 12px; font-size: .95rem; }
    .ok { color: #0a7f2e; }
    .err { color: #b42318; }
    .note { font-size: .85rem; color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Claim your coupon</h1>
      <p>Enter your details and we will text your coupon code.</p>
      <form method="post" action="/api/submit">
        <label for="name">Name</label>
        <input id="name" name="name" required />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required />
        <label for="phone">Phone (E.164)</label>
        <input id="phone" name="phone" placeholder="+14155552671" required />
        <button type="submit">Get my coupon</button>
        ${msgHtml}
        <div class="note">SMS is queued locally (no external SMS integration required).</div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage());
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/submit') {
    if (!rateLimitOk(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Too many requests. Please try again later.', true));
      return;
    }

    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', err.message, true));
      return;
    }

    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();

    if (!name) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Name is required.', true));
      return;
    }
    if (!basicEmailValid(email)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Invalid email.', true));
      return;
    }
    if (!phoneValid(phone)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Phone must be E.164 like +14155552671.', true));
      return;
    }

    const now = Date.now();
    const last = lastSent[phone];
    if (last && now - last < 24 * 60 * 60 * 1000) {
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Coupon already sent to this phone in the last 24 hours.', true));
      return;
    }

    const coupon = generateCoupon(COUPON_PREFIX);
    const timestamp = new Date().toISOString();
    const line = [timestamp, name, email, phone, coupon].map(csvEscape).join(',') + '\n';
    fs.appendFileSync(LEADS_CSV, line, 'utf8');

    sendSms(phone, `Your coupon code is ${coupon}`);

    lastSent[phone] = now;
    fs.writeFileSync(LAST_SENT_JSON, JSON.stringify(lastSent, null, 2), 'utf8');

    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Thanks! Coupon generated.', coupon }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage(coupon, 'Thanks! We queued your SMS and here is your coupon.'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Twilio placeholders (unused): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_PHONE');
});
