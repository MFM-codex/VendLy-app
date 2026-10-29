import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './index.js';

async function boot(mode = 'sandbox') {
  const s = createServer({ mode, secret: 'test-secret', dbPath: ':memory:', trustProxy: false });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
    return { s: r.status, j: await r.json() };
  };
  return { s, call };
}
const user = { name: 'Ada', phone: '08031234567', password: 'Longpass9word', pin: '2846', agreed: true };
const buy = (o = {}) => ({ kind: 'airtime', title: 'MTN airtime', detail: '08031234567', amount: 500, pin: '2846', requestId: 'req-' + Math.random().toString(36).slice(2), ...o });
async function funded(amount = 5000) {
  const t = await boot(); const r = await t.call('POST', '/api/register', user);
  await t.call('POST', '/api/wallet/fund-test', { amount }, r.j.token);
  return { ...t, tk: r.j.token };
}

test('register, login, me', async () => {
  const { s, call } = await boot();
  const r = await call('POST', '/api/register', user);
  assert.equal(r.s, 201);
  assert.equal((await call('POST', '/api/register', user)).s, 409);
  assert.equal((await call('POST', '/api/login', { phone: user.phone, password: 'Wrongpass1x' })).s, 401);
  const l = await call('POST', '/api/login', { phone: user.phone, password: user.password });
  assert.equal(l.s, 200);
  const me = await call('GET', '/api/me', null, l.j.token);
  assert.equal(me.j.balance, 0);
  assert.equal((await call('GET', '/api/me', null, 'bad.token')).s, 401);
  assert.equal((await call('POST', '/api/register', { ...user, phone: '123', pin: 1234 })).s, 400);
  s.close();
});

test('purchase success debits once and lists the transaction', async () => {
  const { s, call, tk } = await funded();
  const p = await call('POST', '/api/purchase', buy(), tk);
  assert.equal(p.s, 200); assert.equal(p.j.tx.status, 'success'); assert.equal(p.j.balance, 4500);
  assert.equal((await call('GET', '/api/transactions', null, tk)).j.transactions.length, 1);
  s.close();
});

test('power purchase returns a token', async () => {
  const { s, call, tk } = await funded();
  const p = await call('POST', '/api/purchase', buy({ kind: 'power', title: 'Ikeja electricity', detail: 'Meter 45012345678', amount: 2000 }), tk);
  assert.match(p.j.tx.token, /^\d{4}(-\d{4}){4}$/);
  s.close();
});

test('too little money is refused and balance is unchanged', async () => {
  const { s, call, tk } = await funded(100);
  const p = await call('POST', '/api/purchase', buy({ amount: 500 }), tk);
  assert.equal(p.s, 402);
  assert.equal((await call('GET', '/api/me', null, tk)).j.balance, 100);
  s.close();
});

test('same requestId twice charges only once', async () => {
  const { s, call, tk } = await funded();
  const b = buy();
  await call('POST', '/api/purchase', b, tk);
  const again = await call('POST', '/api/purchase', b, tk);
  assert.equal(again.j.replay, true); assert.equal(again.j.balance, 4500);
  s.close();
});

test('failed delivery is refunded exactly once', async () => {
  const { s, call, tk } = await funded();
  const p = await call('POST', '/api/purchase', buy({ detail: '08030000000'.slice(0, 7) + '0000' }), tk);
  assert.equal(p.j.tx.status, 'refunded'); assert.equal(p.j.balance, 5000);
  assert.equal((await call('GET', '/api/me', null, tk)).j.balance, 5000);
  s.close();
});

test('five wrong PINs lock purchases, even with the right PIN', async () => {
  const { s, call, tk } = await funded();
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/purchase', buy({ pin: '9999' }), tk)).s, 403);
  assert.equal((await call('POST', '/api/purchase', buy({ pin: '9999' }), tk)).s, 423);
  assert.equal((await call('POST', '/api/purchase', buy(), tk)).s, 423);
  assert.equal((await call('GET', '/api/me', null, tk)).j.balance, 5000);
  s.close();
});

test('live mode has no test funding', async () => {
  const { s, call } = await boot('live');
  const r = await call('POST', '/api/register', user);
  assert.equal((await call('POST', '/api/wallet/fund-test', { amount: 500 }, r.j.token)).s, 403);
  s.close();
});

test('home page and health check respond', async () => {
  const { s } = await boot();
  const base = `http://127.0.0.1:${s.address().port}`;
  const home = await fetch(base + '/');
  assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /text\/html/); assert.match(await home.text(), /<title>Vendly/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, true); assert.equal(h.mode, 'sandbox');
  s.close();
});

test('weak passwords, easy PINs and missing consent are refused at sign-up', async () => {
  const { s, call } = await boot();
  const bad = async (o) => (await call('POST', '/api/register', { ...user, ...o })).s;
  assert.equal(await bad({ password: 'short1A' }), 400);
  assert.equal(await bad({ password: 'alllowercase1' }), 400);
  assert.equal(await bad({ password: 'NoNumbersHere' }), 400);
  assert.equal(await bad({ password: 'Password123' }), 400);
  assert.equal(await bad({ password: 'MyAda2024xx' }), 400);
  assert.equal(await bad({ pin: '1234' }), 400);
  assert.equal(await bad({ pin: '1111' }), 400);
  assert.equal(await bad({ pin: '4321' }), 400);
  assert.equal(await bad({ agreed: false }), 400);
  assert.equal(await bad({}), 201);
  s.close();
});

test('changing the password ends older sessions and the new one works', async () => {
  const { s, call } = await boot();
  const r = await call('POST', '/api/register', user); const old = r.j.token;
  assert.equal((await call('POST', '/api/password', { current: 'Nope12345x', next: 'Fresh7Passw0rd' }, old)).s, 403);
  assert.equal((await call('POST', '/api/password', { current: user.password, next: 'weak' }, old)).s, 400);
  await new Promise((r) => setTimeout(r, 5));
  const c = await call('POST', '/api/password', { current: user.password, next: 'Fresh7Passw0rd' }, old);
  assert.equal(c.s, 200);
  assert.equal((await call('GET', '/api/me', null, old)).s, 401);
  assert.equal((await call('GET', '/api/me', null, c.j.token)).s, 200);
  assert.equal((await call('POST', '/api/login', { phone: user.phone, password: 'Fresh7Passw0rd' })).s, 200);
  assert.equal((await call('POST', '/api/login', { phone: user.phone, password: user.password })).s, 401);
  s.close();
});

test('changing the PIN needs the current PIN and rejects easy ones', async () => {
  const { s, call, tk } = await funded();
  assert.equal((await call('POST', '/api/pin', { current: '9999', next: '7391' }, tk)).s, 403);
  assert.equal((await call('POST', '/api/pin', { current: user.pin, next: '1234' }, tk)).s, 400);
  assert.equal((await call('POST', '/api/pin', { current: user.pin, next: '7391' }, tk)).s, 200);
  assert.equal((await call('POST', '/api/purchase', buy({ pin: '2846' }), tk)).s, 403);
  assert.equal((await call('POST', '/api/purchase', buy({ pin: '7391' }), tk)).s, 200);
  s.close();
});

test('install files are served: manifest, service worker and icons', async () => {
  const { s } = await boot();
  const base = `http://127.0.0.1:${s.address().port}`;
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /manifest\+json/);
  const j = await m.json(); assert.equal(j.display, 'standalone'); assert.ok(j.icons.some((i) => i.purpose === 'maskable'));
  const sw = await fetch(base + '/sw.js'); assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
  for (const i of j.icons) { const r = await fetch(base + i.src); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); }
  assert.equal((await fetch(base + '/icons/../server/index.js')).status, 404);
  s.close();
});
