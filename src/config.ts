import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

export const env = (key: string, fallback = '') => (process.env[key] ?? fallback).trim();

const dataDir = path.resolve(env('DATA_DIR', './data'));
mkdirSync(dataDir, { recursive: true });

/** APP_SECRET from env, otherwise a key generated on first run and kept in the data folder. */
function loadSecret(): string {
  const fromEnv = env('APP_SECRET');
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('APP_SECRET must be at least 32 characters (or remove it to auto-generate one)');
    return fromEnv;
  }
  const file = path.join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
  return secret;
}

export const config = {
  port: Number(env('PORT', '8080')),
  dataDir,
  appSecret: loadSecret(),
  envPassword: env('APP_PASSWORD'),
  publicUrl: env('PUBLIC_URL').replace(/\/$/, ''),
  cookieSecure: env('COOKIE_SECURE') === 'true',
  version: '0.1.0',
};

/** Keys that can be supplied by environment variables (they override values saved in the UI). */
export const ENV_CREDENTIALS = {
  shopifyShop: 'SHOPIFY_SHOP',
  shopifyClientId: 'SHOPIFY_CLIENT_ID',
  shopifyClientSecret: 'SHOPIFY_CLIENT_SECRET',
  shopifyAccessToken: 'SHOPIFY_ACCESS_TOKEN',
  shopifyWebhookSecret: 'SHOPIFY_WEBHOOK_SECRET',
  shopifyApiVersion: 'SHOPIFY_API_VERSION',
  ebayEnv: 'EBAY_ENV',
  ebayClientId: 'EBAY_CLIENT_ID',
  ebayClientSecret: 'EBAY_CLIENT_SECRET',
  ebayRuName: 'EBAY_RUNAME',
  ebayMarketplaceId: 'EBAY_MARKETPLACE_ID',
} as const;

export type CredentialKey = keyof typeof ENV_CREDENTIALS;
export const SECRET_CREDENTIALS: CredentialKey[] = ['shopifyClientSecret', 'shopifyAccessToken', 'shopifyWebhookSecret', 'ebayClientSecret'];

export const MARKETPLACES: Record<string, { name: string; currency: string; language: string; country: string; web: string }> = {
  EBAY_US: { name: 'United States (ebay.com)', currency: 'USD', language: 'en-US', country: 'US', web: 'www.ebay.com' },
  EBAY_CA: { name: 'Canada (ebay.ca)', currency: 'CAD', language: 'en-CA', country: 'CA', web: 'www.ebay.ca' },
  EBAY_GB: { name: 'United Kingdom (ebay.co.uk)', currency: 'GBP', language: 'en-GB', country: 'GB', web: 'www.ebay.co.uk' },
  EBAY_AU: { name: 'Australia (ebay.com.au)', currency: 'AUD', language: 'en-AU', country: 'AU', web: 'www.ebay.com.au' },
  EBAY_DE: { name: 'Germany (ebay.de)', currency: 'EUR', language: 'de-DE', country: 'DE', web: 'www.ebay.de' },
  EBAY_FR: { name: 'France (ebay.fr)', currency: 'EUR', language: 'fr-FR', country: 'FR', web: 'www.ebay.fr' },
  EBAY_IT: { name: 'Italy (ebay.it)', currency: 'EUR', language: 'it-IT', country: 'IT', web: 'www.ebay.it' },
  EBAY_ES: { name: 'Spain (ebay.es)', currency: 'EUR', language: 'es-ES', country: 'ES', web: 'www.ebay.es' },
};
