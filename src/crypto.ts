import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

const key = () => createHash('sha256').update(`enc:${config.appSecret}`).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** `scope` ties sessions to the current password + session epoch, so changing either revokes every session. */
const sign = (value: string, scope: string) => createHmac('sha256', `session:${config.appSecret}:${scope}`).update(value).digest('base64url');

export function createSession(ttlMs: number, scope = ''): string {
  const payload = `${Date.now() + ttlMs}.${randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload, scope)}`;
}

export function verifySession(token: string | undefined, scope = ''): boolean {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const expected = Buffer.from(sign(payload, scope));
  const actual = Buffer.from(token.slice(idx + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  return Number(payload.split('.')[0]) > Date.now();
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function uuidFrom(s: string): string {
  const h = sha256(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
