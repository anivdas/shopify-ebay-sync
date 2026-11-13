import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-sec-local-'));
const { isPrivateAddress } = await import('../src/auth.ts');
const { csvCell } = await import('../src/routes.ts');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ses-sec-')), APP_PASSWORD: '', SHOPIFY_SHOP: '', EBAY_CLIENT_ID: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server.kill());

const cookieOf = (r: Response) => r.headers.get('set-cookie')?.split(';')[0] ?? '';
const call = (p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) =>
  fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

test('security headers are sent', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'no inline scripts except the hashed theme script');
  if ((await fetch(`${base}/`)).headers.get('content-type')?.includes('text/html') && csp.includes('sha256-')) assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
});

test('sessions: login works, password change and "sign out everywhere" revoke other sessions', async () => {
  const setup = await call('/api/setup/password', { method: 'POST', body: { password: 'first-password' } });
  assert.equal(setup.status, 200, 'setup allowed from localhost');
  const a = cookieOf(setup);
  const b = cookieOf(await call('/api/login', { method: 'POST', body: { password: 'first-password' } }));
  assert.equal((await call('/api/status', { cookie: a })).status, 200);
  assert.equal((await call('/api/status', { cookie: b })).status, 200);

  const changed = await call('/api/password', { method: 'POST', cookie: a, body: { current: 'first-password', password: 'second-password' } });
  assert.equal(changed.status, 200);
  const a2 = cookieOf(changed);
  assert.equal((await call('/api/status', { cookie: b })).status, 401, 'other device signed out after password change');
  assert.equal((await call('/api/status', { cookie: a })).status, 401, 'old cookie of this device is replaced');
  assert.equal((await call('/api/status', { cookie: a2 })).status, 200, 'this device stays signed in');

  const c = cookieOf(await call('/api/login', { method: 'POST', body: { password: 'second-password' } }));
  const revoked = await call('/api/sessions/revoke', { method: 'POST', cookie: a2 });
  assert.equal((await call('/api/status', { cookie: c })).status, 401, 'sign out everywhere');
  assert.equal((await call('/api/status', { cookie: cookieOf(revoked) })).status, 200);
});

test('state-changing calls need the app header (CSRF) and a session', async () => {
  const noHeader = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 401);
  const login = cookieOf(await call('/api/login', { method: 'POST', body: { password: 'second-password' } }));
  const csrf = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: login }, body: '{}' });
  assert.equal(csrf.status, 403);
});

test('malformed URLs and cookies are rejected cleanly, not with a 500', async () => {
  assert.equal((await fetch(`${base}/api/listings/%E0%A4%A`, { headers: { Cookie: 'sid=%E0%A4%A' } })).status, 400);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: 'sid=%E0%A4%A' } })).status, 401, 'bad cookie = signed out');
  const login = cookieOf(await call('/api/login', { method: 'POST', body: { password: 'second-password' } }));
  assert.equal((await call('/api/ebay/locations/%E0%A4%A', { method: 'PUT', cookie: login, body: {} })).status, 400);
});

test('first-run setup is only allowed from private networks', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '100.101.102.103', 'fd00::1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '::ffff:203.0.113.9', '172.32.0.1', '100.128.0.1', '2001:db8::1', undefined]) assert.ok(!isPrivateAddress(a), String(a));
});

test('CSV export neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('Dune, 4K'), '"Dune, 4K"');
  assert.equal(csvCell(12.5), '12.5');
});
