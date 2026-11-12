import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { safeEqual } from './crypto.ts';
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

const attempts = new Map<string, { count: number; until: number }>();

/** Simple brute-force protection: 10 failures locks that IP out for 15 minutes. */
export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.count < 10 || a.until < Date.now();
}

export function recordLogin(ip: string, ok: boolean) {
  if (ok) return attempts.delete(ip);
  const a = attempts.get(ip);
  const count = a && a.until > Date.now() ? a.count + 1 : 1;
  attempts.set(ip, { count, until: Date.now() + 15 * 60_000 });
}
