import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPassword, isPrivateAddress, loginAllowed, passwordIsSet, recordLogin, revokeAllSessions, sessionScope, setPassword } from './auth.ts';
import { config } from './config.ts';
import { createSession, verifySession } from './crypto.ts';
import { db } from './db.ts';
import { HttpError, parseCookies, readBody, sendJson, type Ctx } from './http.ts';
import { startScheduler } from './jobs.ts';
import { logActivity } from './log.ts';
import { router } from './routes.ts';

const SESSION_TTL = 30 * 24 * 3600_000;
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const newSession = () => sessionCookie(createSession(SESSION_TTL, sessionScope()), SESSION_TTL);
const isAuthed = (req: import('node:http').IncomingMessage) => verifySession(parseCookies(req.headers.cookie).sid, sessionScope());

/** CSP allowing only our own scripts, plus the hash of the inline theme script in index.html. */
function contentSecurityPolicy(): string {
  const index = path.join(webRoot, 'index.html');
  const inline = existsSync(index)
    ? [...readFileSync(index, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
    : [];
  return [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
const CSP = contentSecurityPolicy();

const sessionCookie = (value: string, maxAge: number) =>
  `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${config.cookieSecure ? '; Secure' : ''}`;

router.get('/healthz', () => ({ ok: true, version: config.version }), { public: true });

router.get('/api/session', ({ req }) => ({
  authenticated: isAuthed(req),
  needsPassword: !passwordIsSet(),
  version: config.version,
}), { public: true });

router.post('/api/setup/password', ({ body, res, req }) => {
  if (passwordIsSet()) throw new HttpError(409, 'A password is already set');
  // Until a password exists anyone who can reach the app could claim it, so only allow this from the LAN/VPN.
  if (!isPrivateAddress(req.socket.remoteAddress) && process.env.ALLOW_REMOTE_SETUP !== 'true')
    throw new HttpError(403, 'Set the first password from your local network (or set APP_PASSWORD, or ALLOW_REMOTE_SETUP=true).');
  setPassword(String(body?.password ?? ''));
  res.setHeader('Set-Cookie', newSession());
  logActivity('info', 'auth', 'Admin password created');
  return { ok: true };
}, { public: true });

router.post('/api/login', ({ body, res, ip }) => {
  if (!loginAllowed(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const ok = checkPassword(String(body?.password ?? ''));
  recordLogin(ip, ok);
  if (!ok) throw new HttpError(401, 'Wrong password');
  res.setHeader('Set-Cookie', newSession());
  return { ok: true };
}, { public: true });

router.post('/api/logout', ({ res }) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, { public: true });

router.post('/api/password', ({ body, res }) => {
  if (config.envPassword) throw new HttpError(400, 'The password is set by the APP_PASSWORD environment variable');
  if (!checkPassword(String(body?.current ?? ''))) throw new HttpError(401, 'Current password is wrong');
  setPassword(String(body?.password ?? ''));
  // The new password changes the session scope: every other device is signed out; keep this one signed in.
  res.setHeader('Set-Cookie', newSession());
  logActivity('info', 'auth', 'Password changed; other sessions signed out');
  return { ok: true };
});

router.post('/api/sessions/revoke', ({ res }) => {
  revokeAllSessions();
  res.setHeader('Set-Cookie', newSession());
  logActivity('info', 'auth', 'Signed out all other devices');
  return { ok: true };
});

function serveStatic(urlPath: string, res: import('node:http').ServerResponse): boolean {
  if (!existsSync(webRoot)) return false;
  let file = path.join(webRoot, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!file.startsWith(webRoot)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
  if (!existsSync(file)) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const match = router.match(method, url.pathname);
    if (!match) {
      if (method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>UI not built</h1><p>Run <code>npm run build</code> (or use the Docker image).</p>');
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    if (!match.route.public) {
      if (!isAuthed(req)) {
        if (method === 'GET' && !url.pathname.startsWith('/api/')) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        throw new HttpError(401, 'Please log in');
      }
      // CSRF protection: state-changing API calls must come from our own pages
      if (method !== 'GET' && req.headers['x-requested-with'] !== 'app') throw new HttpError(403, 'Missing request header');
    }
    const rawBody = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown = undefined;
    if (rawBody.length && (req.headers['content-type'] ?? '').includes('application/json')) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
    }
    const ctx: Ctx = {
      req,
      res,
      url,
      params: match.params,
      query: url.searchParams,
      body,
      rawBody,
      // Behind a proxy, use the address the proxy saw: the LAST X-Forwarded-For entry (earlier ones are client-supplied).
      ip:
        (config.trustProxy && ((req.headers['cf-connecting-ip'] as string) || String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim())) ||
        req.socket.remoteAddress ||
        'unknown',
    };
    const result = await match.route.handler(ctx);
    if (!res.headersSent && result !== undefined) sendJson(res, 200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status && (err as { status: number }).status >= 400 ? (err as { status: number }).status : 500);
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status >= 400 && status < 600 ? status : 500, { error: (err as Error).message || 'Server error' });
  }
});

server.listen(config.port, () => {
  console.log(`Shopify <-> eBay Sync v${config.version} listening on http://0.0.0.0:${config.port}`);
  console.log(`Data folder: ${config.dataDir}`);
  startScheduler();
});

const shutdown = () => {
  console.log('Shutting down...');
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
