import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPassword, loginAllowed, passwordIsSet, recordLogin, setPassword } from './auth.ts';
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

const sessionCookie = (value: string, maxAge: number) =>
  `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${config.cookieSecure ? '; Secure' : ''}`;

router.get('/healthz', () => ({ ok: true, version: config.version }), { public: true });

router.get('/api/session', ({ req }) => ({
  authenticated: verifySession(parseCookies(req.headers.cookie).sid),
  needsPassword: !passwordIsSet(),
  version: config.version,
}), { public: true });

router.post('/api/setup/password', ({ body, res }) => {
  if (passwordIsSet()) throw new HttpError(409, 'A password is already set');
  setPassword(String(body?.password ?? ''));
  res.setHeader('Set-Cookie', sessionCookie(createSession(SESSION_TTL), SESSION_TTL));
  logActivity('info', 'auth', 'Admin password created');
  return { ok: true };
}, { public: true });

router.post('/api/login', ({ body, res, ip }) => {
  if (!loginAllowed(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const ok = checkPassword(String(body?.password ?? ''));
  recordLogin(ip, ok);
  if (!ok) throw new HttpError(401, 'Wrong password');
  res.setHeader('Set-Cookie', sessionCookie(createSession(SESSION_TTL), SESSION_TTL));
  return { ok: true };
}, { public: true });

router.post('/api/logout', ({ res }) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, { public: true });

router.post('/api/password', ({ body }) => {
  if (config.envPassword) throw new HttpError(400, 'The password is set by the APP_PASSWORD environment variable');
  if (!checkPassword(String(body?.current ?? ''))) throw new HttpError(401, 'Current password is wrong');
  setPassword(String(body?.password ?? ''));
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
      const authed = verifySession(parseCookies(req.headers.cookie).sid);
      if (!authed) {
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
      ip:
        (config.trustProxy && ((req.headers['cf-connecting-ip'] as string) || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim())) ||
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
