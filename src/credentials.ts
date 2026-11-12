import { env, ENV_CREDENTIALS, MARKETPLACES, SECRET_CREDENTIALS, type CredentialKey } from './config.ts';
import { deleteToken, getToken, setToken } from './db.ts';

type Stored = Partial<Record<CredentialKey, string>>;

const load = (): Stored => {
  const t = getToken('credentials');
  return t ? (JSON.parse(t.value) as Stored) : {};
};

let cache: Stored | null = null;

export function credential(key: CredentialKey): string {
  const fromEnv = env(ENV_CREDENTIALS[key]);
  if (fromEnv) return fromEnv;
  cache ??= load();
  return (cache[key] ?? '').trim();
}

export function saveCredentials(patch: Stored) {
  const current = load();
  for (const [k, v] of Object.entries(patch) as [CredentialKey, string | undefined][]) {
    if (!(k in ENV_CREDENTIALS) || v === undefined) continue;
    // Masked placeholders coming back from the UI mean "unchanged"
    if (SECRET_CREDENTIALS.includes(k) && /^•+$/.test(v)) continue;
    if (v === '') delete current[k];
    else current[k] = v.trim();
  }
  if (current.shopifyShop) current.shopifyShop = current.shopifyShop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
  setToken('credentials', JSON.stringify(current), null);
  cache = current;
  // Credentials changed: drop cached access tokens so new ones are fetched
  deleteToken('shopify_access');
}

/** For the settings UI: secrets are masked, and fields set via env vars are flagged read-only. */
export function describeCredentials() {
  return Object.fromEntries(
    (Object.keys(ENV_CREDENTIALS) as CredentialKey[]).map((k) => {
      const value = credential(k);
      const fromEnv = !!env(ENV_CREDENTIALS[k]);
      return [k, { value: SECRET_CREDENTIALS.includes(k) && value ? '••••••••' : value, fromEnv, set: !!value }];
    }),
  );
}

export function shopifyConf() {
  return {
    shop: credential('shopifyShop').replace(/\.myshopify\.com$/, ''),
    clientId: credential('shopifyClientId'),
    clientSecret: credential('shopifyClientSecret'),
    accessToken: credential('shopifyAccessToken'),
    webhookSecret: credential('shopifyWebhookSecret') || credential('shopifyClientSecret'),
    apiVersion: credential('shopifyApiVersion') || '2026-10',
  };
}

export function ebayConf() {
  const sandbox = credential('ebayEnv') === 'sandbox';
  const marketplaceId = credential('ebayMarketplaceId') || 'EBAY_US';
  const mp = MARKETPLACES[marketplaceId] ?? MARKETPLACES.EBAY_US;
  return {
    env: sandbox ? 'sandbox' : 'production',
    clientId: credential('ebayClientId'),
    clientSecret: credential('ebayClientSecret'),
    ruName: credential('ebayRuName'),
    marketplaceId,
    currency: mp.currency,
    contentLanguage: mp.language,
    country: mp.country,
    apiBase: sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    apizBase: sandbox ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com',
    authBase: sandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com',
    webBase: sandbox ? 'https://sandbox.ebay.com' : `https://${mp.web}`,
  };
}

export const shopifyConfigured = () => {
  const c = shopifyConf();
  return !!c.shop && (!!c.accessToken || (!!c.clientId && !!c.clientSecret));
};

export const ebayConfigured = () => {
  const c = ebayConf();
  return !!c.clientId && !!c.clientSecret && !!c.ruName;
};
