const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const COUPON_PREFIX = process.env.COUPON_PREFIX || 'SAVE';

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_CSV = path.join(DATA_DIR, 'leads.csv');
const LAST_SENT_JSON = path.join(DATA_DIR, 'last_sent.json');
const SEEN_JSON = path.join(DATA_DIR, 'seen.json');
const WHATSAPP_TO = '15138373891';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const GOOGLE_SA_PATH = process.env.GOOGLE_SA_PATH || '/etc/secrets/google-service-account.json';
const GOOGLE_SA_FALLBACK = path.join(__dirname, 'secrets', 'google-service-account.json');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Leads';
const ENABLE_GOOGLE_SHEETS = (() => {
  if (process.env.ENABLE_GOOGLE_SHEETS !== undefined) {
    return String(process.env.ENABLE_GOOGLE_SHEETS).toLowerCase() === 'true';
  }
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
})();

const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LEADS_CSV)) {
  fs.writeFileSync(LEADS_CSV, 'timestamp,name,phone,email,looking_for,investment_range,coupon\n', 'utf8');
}
if (!fs.existsSync(LAST_SENT_JSON)) {
  fs.writeFileSync(LAST_SENT_JSON, JSON.stringify({}, null, 2), 'utf8');
}
if (!fs.existsSync(SEEN_JSON)) {
  fs.writeFileSync(SEEN_JSON, JSON.stringify({ emails: {}, phones: {} }, null, 2), 'utf8');
}

let seen = { emails: {}, phones: {} };
try {
  const parsedSeen = JSON.parse(fs.readFileSync(SEEN_JSON, 'utf8'));
  seen = {
    emails: parsedSeen.emails || {},
    phones: parsedSeen.phones || {}
  };
} catch {
  seen = { emails: {}, phones: {} };
}

const rateLimitStore = new Map();

function basicEmailValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function phoneValid(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function normalizePhone(raw) {
  const trimmed = String(raw || '').trim();
  const hasPlus = trimmed.startsWith('+');
  const cleaned = trimmed.replace(/[^0-9+]/g, '');
  if (hasPlus) {
    if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
    return cleaned;
  }
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return cleaned;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function generateCoupon(prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return `${prefix}-${out}`;
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
  const msgText = message ? `${message}${coupon ? ' Coupon: ' + coupon : ''}` : '';
  const msgClass = message ? (error ? 'err' : 'ok') : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claim Your Offer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --ink: #141414;
      --muted: #5c5c5c;
      --line: rgba(20, 20, 20, .12);
      --card: #ffffff;
      --accent: #b8903f;
      --accent-dark: #8a6a23;
      --bg1: #f6f3ee;
      --bg2: #efe7da;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Source Sans 3", system-ui, sans-serif;
      background:
        radial-gradient(1200px 600px at 10% -10%, #ffffff 0%, var(--bg1) 35%, var(--bg2) 100%),
        linear-gradient(135deg, #f8f6f2, #efe7da);
    }
    .wrap {
      max-width: 860px;
      margin: 0 auto;
      padding: 40px 20px 60px;
    }
    .hero {
      display: grid;
      gap: 18px;
      margin-bottom: 22px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo {
      width: 72px;
      height: 72px;
      border-radius: 14px;
      object-fit: cover;
      box-shadow: 0 8px 18px rgba(20, 20, 20, .12);
      border: 1px solid rgba(20, 20, 20, .08);
    }
    .eyebrow {
      letter-spacing: .18em;
      text-transform: uppercase;
      font-size: .95rem;
      color: var(--accent-dark);
      font-weight: 700;
    }
    .brand .eyebrow {
      font-size: 1rem;
    }
    h1 {
      font-family: "Playfair Display", serif;
      font-size: clamp(1.6rem, 2.1vw, 2.1rem);
      margin: 0;
      line-height: 1.25;
    }
    .sub {
      color: var(--muted);
      max-width: 42ch;
      margin: 0;
      font-size: 1rem;
    }
    .card {
      background: var(--card);
      border-radius: 18px;
      padding: 26px;
      box-shadow:
        0 24px 60px rgba(20, 20, 20, .12),
        0 2px 8px rgba(20, 20, 20, .06);
      border: 1px solid rgba(20, 20, 20, .05);
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    label {
      display: block;
      font-weight: 600;
      margin: 10px 0 6px;
      color: var(--ink);
    }
    input[type="text"], input[type="email"], input[type="tel"] {
      width: 100%;
      padding: 12px 14px;
      font-size: 1rem;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: #fff;
      outline: none;
    }
    input:focus {
      border-color: rgba(184, 144, 63, .6);
      box-shadow: 0 0 0 3px rgba(184, 144, 63, .15);
    }
    .group {
      margin: 16px 0 6px;
      font-weight: 700;
      color: var(--ink);
    }
    .options {
      display: grid;
      gap: 8px;
    }
    .option {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #faf8f5;
    }
    .option input { width: auto; }
    button {
      margin-top: 14px;
      width: 100%;
      padding: 12px 14px;
      font-size: 1rem;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent) 0%, #d1a24a 100%);
      color: #fff;
      font-weight: 700;
      letter-spacing: .02em;
      cursor: pointer;
    }
    button:hover { background: linear-gradient(135deg, var(--accent-dark), var(--accent)); }
    .msg { margin-top: 12px; font-size: .95rem; }
    .ok { color: #0a7f2e; }
    .err { color: #b42318; }
    .note { font-size: .85rem; color: var(--muted); margin-top: 8px; }
    @media (min-width: 780px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .full { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="brand">
        <img class="logo" src="/logo" alt="Aasritha Infra Projects logo" />
        <div class="eyebrow">AASRITHA INFRA PROJECTS</div>
      </div>
      <h1>Exclusive access to curated investment opportunities</h1>
      <p class="sub">Share your preferences and we’ll open WhatsApp to connect with a dedicated advisor.</p>
    </div>
    <div class="card">
      <form id="leadForm" method="post" action="/api/submit">
        <div class="grid">
          <div class="full">
            <label for="name">Full Name</label>
            <input id="name" name="name" type="text" required />
          </div>
          <div>
            <label for="phone">Phone Number</label>
            <input id="phone" name="phone" type="tel" placeholder="+14155552671" required />
          </div>
          <div>
            <label for="email">Email</label>
            <input id="email" name="email" type="email" required />
          </div>
          <div class="full">
            <div class="group">What are you looking for?</div>
            <div class="options">
              <label class="option"><input type="radio" name="looking_for" value="Investment opportunity" required /> Investment opportunity</label>
              <label class="option"><input type="radio" name="looking_for" value="Future retirement home" /> Future retirement home</label>
              <label class="option"><input type="radio" name="looking_for" value="Family home in Hyderabad" /> Family home in Hyderabad</label>
              <label class="option"><input type="radio" name="looking_for" value="Just exploring" /> Just exploring</label>
            </div>
          </div>
          <div class="full">
            <div class="group">What investment range are you considering?</div>
            <div class="options">
              <label class="option"><input type="radio" name="investment_range" value="$100k–200k" required /> $100k–200k</label>
              <label class="option"><input type="radio" name="investment_range" value="$200k–400k" /> $200k–400k</label>
              <label class="option"><input type="radio" name="investment_range" value="$400k+" /> $400k+</label>
              <label class="option"><input type="radio" name="investment_range" value="Not sure yet" /> Not sure yet</label>
            </div>
          </div>
        </div>
        <button type="submit">Get My Coupon</button>
        <div id="msg" class="msg ${msgClass}">${escapeHtml(msgText)}</div>
        <div class="note">You will be redirected to WhatsApp to send a message.</div>
      </form>
    </div>
  </div>
  <script>
    const form = document.getElementById('leadForm');
    const msg = document.getElementById('msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      msg.className = 'msg';
      const payload = {
        name: form.name.value,
        phone: form.phone.value,
        email: form.email.value,
        looking_for: form.looking_for.value,
        investment_range: form.investment_range.value
      };
      try {
        const res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload)
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Something went wrong');
        msg.textContent = out.message + ' Coupon: ' + out.coupon;
        msg.classList.add('ok');
        form.reset();
        const waText = encodeURIComponent('get my coupon');
        window.location.href = 'https://wa.me/${WHATSAPP_TO}?text=' + waText;
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add('err');
      }
    });
  </script>
</body>
</html>`;
}

function adminPage(rows) {
  const header = ['timestamp', 'name', 'phone', 'email', 'looking_for', 'investment_range', 'coupon'];
  const tableRows = rows.map((r) => {
    const cols = header.map((_, i) => `<td>${escapeHtml(r[i] || '')}</td>`).join('');
    return `<tr>${cols}</tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Leads</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7fb; color: #111; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 24px 18px 40px; }
    h1 { font-size: 1.5rem; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    th, td { padding: 10px 12px; border-bottom: 1px solid #eee; text-align: left; font-size: .95rem; }
    th { background: #f0f2f7; position: sticky; top: 0; }
    .meta { color: #555; margin-bottom: 10px; font-size: .9rem; }
    .actions { margin: 10px 0 16px; }
    .btn { padding: 8px 12px; border: 0; background: #e24c4b; color: #fff; border-radius: 8px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Leads (last ${rows.length})</h1>
    <div class="meta">Most recent first.</div>
    <div class="actions">
      <form method="post" action="/admin/reset" onsubmit="return confirm('Reset all leads and duplicate state?');">
        <button class="btn" type="submit">Reset Leads</button>
      </form>
    </div>
    <table>
      <thead>
        <tr>
          <th>timestamp</th>
          <th>name</th>
          <th>phone</th>
          <th>email</th>
          <th>looking_for</th>
          <th>investment_range</th>
          <th>coupon</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

function readServiceAccount() {
  const primary = GOOGLE_SA_PATH;
  const fallback = GOOGLE_SA_FALLBACK;
  const pathToUse = fs.existsSync(primary) ? primary : (fs.existsSync(fallback) ? fallback : null);
  if (!pathToUse) return null;
  try {
    return JSON.parse(fs.readFileSync(pathToUse, 'utf8'));
  } catch {
    return null;
  }
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwtRS256(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  const signature = signer.sign(privateKey);
  return `${data}.${base64url(signature)}`;
}

const tokenCache = { token: '', exp: 0 };

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 300 > now) return tokenCache.token;

  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const jwt = signJwtRS256(payload, sa.private_key);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  }).toString();

  const res = await httpsRequest({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (res.status < 200 || res.status >= 300) {
    throw new Error('Failed to obtain access token');
  }

  const out = JSON.parse(res.data || '{}');
  tokenCache.token = out.access_token || '';
  tokenCache.exp = now + (out.expires_in || 0);
  return tokenCache.token;
}

async function appendToSheet(row) {
  if (!ENABLE_GOOGLE_SHEETS) return;
  if (!GOOGLE_SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID');
  const sa = readServiceAccount();
  if (!sa) throw new Error('Missing service account JSON');

  const token = await getAccessToken(sa);
  const values = JSON.stringify({ values: [row] });
  const tab = encodeURIComponent(GOOGLE_SHEET_TAB);
  const pathName = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${tab}!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await httpsRequest({
    method: 'POST',
    hostname: 'sheets.googleapis.com',
    path: pathName,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(values)
    }
  }, values);

  if (res.status < 200 || res.status >= 300) {
    throw new Error('Sheets append failed');
  }
}

async function fetchSheetRows(limit) {
  if (!ENABLE_GOOGLE_SHEETS) return null;
  if (!GOOGLE_SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID');
  const sa = readServiceAccount();
  if (!sa) throw new Error('Missing service account JSON');

  const token = await getAccessToken(sa);
  const tab = encodeURIComponent(GOOGLE_SHEET_TAB);
  const pathName = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${tab}!A:G?majorDimension=ROWS`;

  const res = await httpsRequest({
    method: 'GET',
    hostname: 'sheets.googleapis.com',
    path: pathName,
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error('Sheets read failed');
  }

  const out = JSON.parse(res.data || '{}');
  const rows = out.values || [];
  if (rows.length === 0) return [];
  const withoutHeader = rows.slice(1);
  const last = withoutHeader.slice(-limit).reverse();
  return last;
}

async function fetchAllSheetRows() {
  if (!ENABLE_GOOGLE_SHEETS) return null;
  if (!GOOGLE_SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID');
  const sa = readServiceAccount();
  if (!sa) throw new Error('Missing service account JSON');

  const token = await getAccessToken(sa);
  const tab = encodeURIComponent(GOOGLE_SHEET_TAB);
  const pathName = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${tab}!A:G?majorDimension=ROWS`;

  const res = await httpsRequest({
    method: 'GET',
    hostname: 'sheets.googleapis.com',
    path: pathName,
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error('Sheets read failed');
  }

  const out = JSON.parse(res.data || '{}');
  const rows = out.values || [];
  if (rows.length === 0) return [];
  return rows.slice(1);
}

async function sheetHasDuplicate(email, phone) {
  const rows = await fetchAllSheetRows();
  const emailLower = String(email || '').toLowerCase();
  for (const row of rows) {
    const rowPhone = String(row[2] || '').trim();
    const rowEmail = String(row[3] || '').trim().toLowerCase();
    if (rowEmail && rowEmail === emailLower) return true;
    if (rowPhone && rowPhone === phone) return true;
  }
  return false;
}

async function clearSheetRows() {
  if (!ENABLE_GOOGLE_SHEETS) return;
  if (!GOOGLE_SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID');
  const sa = readServiceAccount();
  if (!sa) throw new Error('Missing service account JSON');

  const token = await getAccessToken(sa);
  const tab = encodeURIComponent(GOOGLE_SHEET_TAB);
  const pathName = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${tab}!A2:E:clear`;

  const res = await httpsRequest({
    method: 'POST',
    hostname: 'sheets.googleapis.com',
    path: pathName,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, '{}');

  if (res.status < 200 || res.status >= 300) {
    throw new Error('Sheets clear failed');
  }
}

function readLocalRows(limit) {
  const text = fs.readFileSync(LEADS_CSV, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= 1) return [];
  const dataLines = lines.slice(1);
  const last = dataLines.slice(-limit).reverse();
  return last.map(parseCsvLine);
}

function basicAuthOk(req) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Basic ')) return false;
  const raw = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const idx = raw.indexOf(':');
  if (idx === -1) return false;
  const user = raw.slice(0, idx);
  const pass = raw.slice(idx + 1);
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage());
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/logo') {
    const logoPath = path.join(__dirname, 'Aasritha_logo.jpeg');
    if (!fs.existsSync(logoPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const buf = fs.readFileSync(logoPath);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
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
    const email = String(body.email || '').trim().toLowerCase();
    const phone = normalizePhone(body.phone);
    const lookingFor = String(body.looking_for || '').trim();
    const investmentRange = String(body.investment_range || '').trim();

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
      res.end(htmlPage('', 'Phone must be E.164 like +15138373891. You can also enter 10-digit US numbers and we’ll format it.', true));
      return;
    }
    if (!lookingFor) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Please select what you are looking for.', true));
      return;
    }
    if (!investmentRange) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Please select an investment range.', true));
      return;
    }

    const now = Date.now();
    if (ENABLE_GOOGLE_SHEETS) {
      try {
        if (await sheetHasDuplicate(email, phone)) {
          const accept = req.headers['accept'] || '';
          if (accept.includes('application/json')) {
            res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Submission already received for this email or phone.' }));
            return;
          }
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlPage('', 'Submission already received for this email or phone.', true));
          return;
        }
      } catch (err) {
        console.error('Sheets duplicate check error:', err.message);
      }
    }

    if (seen.emails[email] || seen.phones[phone]) {
      const accept = req.headers['accept'] || '';
      if (accept.includes('application/json')) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Submission already received for this email or phone.' }));
        return;
      }
      res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('', 'Submission already received for this email or phone.', true));
      return;
    }

    const coupon = generateCoupon(COUPON_PREFIX);
    const timestamp = new Date().toISOString();
    const row = [timestamp, name, phone, email, lookingFor, investmentRange, coupon];
    const line = row.map(csvEscape).join(',') + '\n';
    fs.appendFileSync(LEADS_CSV, line, 'utf8');

    try {
      await appendToSheet(row);
    } catch (err) {
      console.error('Sheets append error:', err.message);
    }

    seen.emails[email] = now;
    seen.phones[phone] = now;
    fs.writeFileSync(SEEN_JSON, JSON.stringify(seen, null, 2), 'utf8');

    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, coupon, message: 'Coupon ready. Opening WhatsApp.' }));
      return;
    }

    const smsMsg = 'We are opening WhatsApp so you can send the message.';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage(coupon, smsMsg));
    return;
  }

  if (req.method === 'GET' && (parsed.pathname === '/admin' || parsed.pathname === '/admin/export')) {
    if (!basicAuthOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin"' });
      res.end('Unauthorized');
      return;
    }

    let rows = [];
    try {
      const sheetRows = await fetchSheetRows(200);
      rows = sheetRows || [];
    } catch (err) {
      console.error('Sheets read error:', err.message);
      rows = readLocalRows(200);
    }

    if (parsed.pathname === '/admin/export') {
      const header = 'timestamp,name,phone,email,looking_for,investment_range,coupon';
      const body = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
      const csv = header + (body ? '\n' + body : '') + '\n';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="leads.csv"'
      });
      res.end(csv);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(adminPage(rows));
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/admin/reset') {
    if (!basicAuthOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"Admin\"' });
      res.end('Unauthorized');
      return;
    }

    fs.writeFileSync(LAST_SENT_JSON, JSON.stringify({}, null, 2), 'utf8');
    fs.writeFileSync(SEEN_JSON, JSON.stringify({ emails: {}, phones: {} }, null, 2), 'utf8');
    fs.writeFileSync(LEADS_CSV, 'timestamp,name,phone,email,looking_for,investment_range,coupon\n', 'utf8');

    if (ENABLE_GOOGLE_SHEETS) {
      try {
        await clearSheetRows();
      } catch (err) {
        console.error('Sheets clear error:', err.message);
      }
    }

    console.log('[admin] reset performed');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: 'Leads and duplicate state cleared' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
