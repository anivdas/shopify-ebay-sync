import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { safeEqual, sha256 } from './crypto.ts';
import { getState, setState } from './db.ts';

export const passwordIsSet = () => !!config.envPassword || !!getState<string>('passwordHash');

export function setPassword(password: string) {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  setState('passwordHash', `${salt.toString('hex')}:${hash.toString('hex')}`);
}

export function checkPassword(password: string): boolean {
  if (config.envPassword) return safeEqual(password, config.envPassword);
  const stored = getState<string>('passwordHash');
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

/** Changes whenever the password changes or "sign out everywhere" is used; part of every session signature. */
export function sessionScope(): string {
  const pw = config.envPassword ? sha256(`env:${config.envPassword}`) : (getState<string>('passwordHash') ?? '');
  return `${sha256(pw).slice(0, 16)}:${getState<number>('sessionEpoch') ?? 0}`;
}

export const revokeAllSessions = () => setState('sessionEpoch', (getState<number>('sessionEpoch') ?? 0) + 1);

/** First-run password setup is only accepted from the local network / VPN, not from the internet. */
export function isPrivateAddress(addr: string | undefined): boolean {
  const a = (addr ?? '').replace(/^::ffff:/i, '');
  if (a === '::1' || /^(fc|fd|fe[89ab])/i.test(a)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
}

const attempts = new Map<string, { count: number; until: number }>();

/** Simple brute-force protection: 10 failures locks that IP out for 15 minutes. */
export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.count < 10 || a.until < Date.now();
}

export function recordLogin(ip: string, ok: boolean) {
  if (ok) return attempts.delete(ip);
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  const a = attempts.get(ip);
  const count = a && a.until > Date.now() ? a.count + 1 : 1;
  attempts.set(ip, { count, until: Date.now() + 15 * 60_000 });
}
