import http from 'node:http';
import { createHmac, scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const hmac = (s, key) => createHmac('sha256', key).update(s).digest('base64url');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hash = (v) => { const s = randomBytes(16).toString('hex'); return s + ':' + scryptSync(v, s, 32).toString('hex'); };
const check = (v, h) => { const [s, k] = h.split(':'); return same(scryptSync(v, s, 32).toString('hex'), k); };
const str = (v) => (typeof v === 'string' ? v : '');

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'welcome123', 'abc12345', '11111111', '00000000', 'letmein123', 'passw0rd', 'nigeria123', 'naija123', 'vendly123', 'football1', 'monkey123', 'dragon123']);
const pwProblem = (pw, name, phone) => {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return 'Use both upper and lower case letters in your password.';
  if (!/\d/.test(pw)) return 'Add at least one number to your password.';
  const l = pw.toLowerCase();
  if (COMMON.has(l)) return 'That password is too common. Choose another.';
  const words = String(name).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.some((w) => l.includes(w)) || (phone.length >= 7 && (l.includes(phone) || l.includes(phone.slice(-7))))) return 'Your password can’t contain your name or phone number.';
  return null;
};
const BAD_PINS = new Set(['1212', '2121', '1122', '6969', '1004', '2000', '2580', '1357', '2468']);
const pinProblem = (pin) => {
  if (!/^\d{4}$/.test(pin)) return 'PIN must be 4 digits.';
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0]) || d.every((x, i) => !i || x === d[i - 1] + 1) || d.every((x, i) => !i || x === d[i - 1] - 1) || BAD_PINS.has(pin)) return 'Choose a PIN that isn’t easy to guess (not 1234, 1111 or similar).';
  return null;
};

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m, c = 400) => { throw new HttpError(c, m); };

// PHASE 3 replaces this with the real VTpass call. For now it is a safe stand-in.
async function deliver(tx, cfg) {
  if (cfg.mode !== 'sandbox') throw new Error('Live provider not connected yet');
  if (tx.detail.endsWith('0000')) return { ok: false }; // test hook: forces a failure so refunds can be checked
  return { ok: true, token: tx.kind === 'power' ? Array.from({ length: 5 }, () => 1000 + randomBytes(2).readUInt16BE() % 9000).join('-') : null };
}

const INDEX = (() => { try { return readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'); } catch { return null; } })();
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const STATIC = {};
for (const [path, file, type, cache] of [
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  ['/sw.js', 'sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/icons/icon-192.png', 'icons/icon-192.png', 'image/png', 'public, max-age=86400'],
  ['/icons/icon-512.png', 'icons/icon-512.png', 'image/png', 'public, max-age=86400'],
  ['/icons/maskable-512.png', 'icons/maskable-512.png', 'image/png', 'public, max-age=86400'],
  ['/icons/apple-touch-icon.png', 'icons/apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  ['/favicon.ico', 'icons/icon-192.png', 'image/png', 'public, max-age=86400'],
]) { try { STATIC[path] = { body: readFileSync(new URL('../web/' + file, import.meta.url)), type, cache }; } catch {} }
const HOME = (mode) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendly API</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem}code{background:#8882;padding:.1em .4em;border-radius:6px}</style><h1>Vendly API is running</h1><p>Mode: <code>${mode}</code></p><p>Health check: <a href="/api/health"><code>/api/health</code></a></p>`;

export function createServer(cfg) {
  const db = openDb(cfg.dbPath);
  const hits = new Map();
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const now = () => Date.now();
  const balance = (uid) => q('SELECT COALESCE(SUM(amount),0) b FROM ledger WHERE user_id=?', uid).b;
  const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone, since: u.created_at });
  const pubTx = (t) => ({ id: t.id, ref: t.ref, kind: t.kind, title: t.title, detail: t.detail, amount: t.amount, status: t.status, token: t.token, created_at: t.created_at });
  const tokenFor = (uid) => { const p = b64(JSON.stringify({ uid, iat: now(), exp: now() + 7 * 864e5 })); return p + '.' + hmac(p, cfg.secret); };
  const who = (req) => {
    const [p, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
    if (!p || !sig || !same(sig, hmac(p, cfg.secret))) bad('Please log in again.', 401);
    const d = JSON.parse(Buffer.from(p, 'base64url'));
    if (d.exp < now()) bad('Session expired. Log in again.', 401);
    const u = q('SELECT * FROM users WHERE id=?', d.uid) || bad('Account not found.', 401);
    if ((d.iat || 0) < u.pw_changed_at) bad('Please log in again.', 401); // password changed: older sessions end
    return u;
  };
  const limit = (req) => {
    const ip = cfg.trustProxy ? str(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
    if (hits.size > 5000) hits.clear();
    const h = (hits.get(ip) || []).filter((t) => t > now() - 6e4); h.push(now()); hits.set(ip, h);
    if (h.length > 10) bad('Too many attempts. Wait a minute.', 429);
  };
  const pinCheck = (u, pin) => {
    if (u.locked_until > now()) bad('PIN locked. Try again in a few minutes.', 423);
    if (check(str(pin), u.pin_hash)) { if (u.pin_fails) run('UPDATE users SET pin_fails=0 WHERE id=?', u.id); return; }
    const f = u.pin_fails + 1, lock = f >= 5;
    run('UPDATE users SET pin_fails=?, locked_until=? WHERE id=?', lock ? 0 : f, lock ? now() + 15 * 6e4 : 0, u.id);
    bad(lock ? 'Too many wrong PINs. Locked for 15 minutes.' : 'Incorrect PIN.', lock ? 423 : 403);
  };
  const atomic = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const routes = {
    'GET /': () => [200, INDEX || HOME(cfg.mode)],

    'GET /api/health': () => {
      let commit = null; try { commit = readFileSync(process.env.COMMIT_FILE, 'utf8').trim(); } catch {}
      return [200, { ok: true, mode: cfg.mode, commit }];
    },

    'POST /api/register': (req, b) => {
      limit(req);
      const name = str(b.name).trim(), phone = str(b.phone), password = str(b.password), pin = str(b.pin);
      if (name.length < 2 || name.length > 60) bad('Enter your name.');
      if (!/^0\d{10}$/.test(phone)) bad('Enter a valid 11-digit phone number.');
      const pw = pwProblem(password, name, phone); if (pw) bad(pw);
      const pp = pinProblem(pin); if (pp) bad(pp);
      if (b.agreed !== true) bad('Please accept the Terms and Privacy Policy.');
      try {
        const r = run('INSERT INTO users(phone,name,pass_hash,pin_hash,created_at,terms_at) VALUES(?,?,?,?,?,?)', phone, name, hash(password), hash(pin), now(), now());
        const u = q('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
        return [201, { token: tokenFor(u.id), user: pub(u), balance: 0 }];
      } catch (e) { if (/UNIQUE/.test(e.message)) bad('That phone number is already registered.', 409); throw e; }
    },

    'POST /api/login': (req, b) => {
      limit(req);
      const u = q('SELECT * FROM users WHERE phone=?', str(b.phone));
      if (!u || !check(str(b.password), u.pass_hash)) bad('Wrong phone number or password.', 401);
      return [200, { token: tokenFor(u.id), user: pub(u), balance: balance(u.id) }];
    },

    'POST /api/password': (req, b) => {
      limit(req);
      const u = who(req);
      if (!check(str(b.current), u.pass_hash)) bad('Your current password is wrong.', 403);
      const next = str(b.next), pw = pwProblem(next, u.name, u.phone);
      if (pw) bad(pw);
      run('UPDATE users SET pass_hash=?, pw_changed_at=? WHERE id=?', hash(next), now(), u.id);
      return [200, { token: tokenFor(u.id) }];
    },

    'POST /api/pin': (req, b) => {
      const u = who(req);
      pinCheck(u, b.current);
      const next = str(b.next), pp = pinProblem(next);
      if (pp) bad(pp);
      run('UPDATE users SET pin_hash=? WHERE id=?', hash(next), u.id);
      return [200, { ok: true }];
    },

    'GET /api/me': (req) => { const u = who(req); return [200, { user: pub(u), balance: balance(u.id) }]; },

    'GET /api/transactions': (req) => {
      const u = who(req);
      const rows = db.prepare('SELECT * FROM tx WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id);
      return [200, { transactions: rows.map(pubTx) }];
    },

    // Test money. Exists only in sandbox mode. Phase 3 adds real Paystack funding.
    'POST /api/wallet/fund-test': (req, b) => {
      if (cfg.mode !== 'sandbox') bad('Not available.', 403);
      const u = who(req);
      if (!Number.isInteger(b.amount) || b.amount < 1 || b.amount > 100000) bad('Invalid amount.');
      run('INSERT INTO ledger(user_id,amount,ref,note,created_at) VALUES(?,?,?,?,?)', u.id, b.amount, 'fund:' + randomUUID(), 'Test funding', now());
      return [200, { balance: balance(u.id) }];
    },

    'POST /api/purchase': async (req, b) => {
      const u = who(req), amount = b.amount;
      const kind = str(b.kind), title = str(b.title), detail = str(b.detail), reqId = str(b.requestId);
      if (!['airtime', 'data', 'power', 'tv'].includes(kind)) bad('Unknown service.');
      if (!Number.isInteger(amount) || amount < 50 || amount > 500000) bad('Invalid amount.');
      if (!title || title.length > 80 || !detail || detail.length > 60) bad('Invalid purchase details.');
      if (reqId.length < 8 || reqId.length > 64) bad('Missing request id.');

      const prev = q('SELECT * FROM tx WHERE user_id=? AND req_id=?', u.id, reqId);
      if (prev) return [200, { tx: pubTx(prev), balance: balance(u.id), replay: true }]; // same request twice = one charge

      pinCheck(u, b.pin);
      const ref = 'VND' + randomBytes(5).toString('hex').toUpperCase();
      const tx = atomic(() => {
        if (balance(u.id) < amount) bad('Wallet balance is too low.', 402);
        run('INSERT INTO tx(user_id,req_id,kind,title,detail,amount,status,ref,created_at) VALUES(?,?,?,?,?,?,?,?,?)', u.id, reqId, kind, title, detail, amount, 'pending', ref, now());
        run('INSERT INTO ledger(user_id,amount,ref,note,created_at) VALUES(?,?,?,?,?)', u.id, -amount, 'debit:' + ref, title, now());
        return q('SELECT * FROM tx WHERE ref=?', ref);
      });

      let out; try { out = await deliver(tx, cfg); } catch { out = { ok: false }; }
      if (out.ok) run("UPDATE tx SET status='success', token=? WHERE id=?", out.token || null, tx.id);
      else atomic(() => { // failed: give the money back exactly once (ledger ref is unique)
        run("UPDATE tx SET status='refunded' WHERE id=?", tx.id);
        run('INSERT INTO ledger(user_id,amount,ref,note,created_at) VALUES(?,?,?,?,?)', u.id, amount, 'refund:' + ref, 'Refund: ' + title, now());
      });
      return [200, { tx: pubTx(q('SELECT * FROM tx WHERE id=?', tx.id)), balance: balance(u.id) }];
    },
  };

  const server = http.createServer(async (req, res) => {
    const send = (c, o) => {
      const html = typeof o === 'string';
      res.writeHead(c, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...(html && { 'content-security-policy': CSP }) });
      res.end(html ? o : JSON.stringify(o));
    };
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      const st = req.method === 'GET' && STATIC[pathname];
      if (st) { res.writeHead(200, { 'content-type': st.type, 'cache-control': st.cache, 'x-content-type-options': 'nosniff' }); return res.end(st.body); }
      const h = routes[req.method + ' ' + pathname];
      if (!h) return send(404, { error: 'Not found.' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 10000) bad('Request too large.', 413); }
        try { body = raw ? JSON.parse(raw) : {}; } catch { bad('Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Invalid JSON.');
      }
      const [code, out] = await h(req, body);
      send(code, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.code, { error: e.message });
      console.error(e); send(500, { error: 'Something went wrong. Please try again.' });
    }
  });
  server.db = db;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.env.MODE === 'live' ? 'live' : 'sandbox';
  let secret = process.env.SECRET;
  if (!secret) {
    if (mode === 'live') throw new Error('SECRET is required in live mode');
    secret = randomBytes(32).toString('hex');
    console.warn('No SECRET set: logins reset whenever the server restarts.');
  }
  const port = Number(process.env.PORT) || 3000;
  createServer({ mode, secret, dbPath: process.env.DB_PATH || './data/vendly.db', trustProxy: process.env.TRUST_PROXY === '1' })
    .listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Vendly API (${mode}) on port ${port}`));
}
