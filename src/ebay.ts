import { ebayConf, ebayConfigured } from './credentials.ts';
import { deleteToken, getToken, setToken } from './db.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];
const APP_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const INSIGHTS_SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';

export type EbayErrorItem = { errorId?: number; message?: string; longMessage?: string; parameters?: { name: string; value: string }[] };

export class EbayError extends Error {
  status: number;
  errors: EbayErrorItem[];
  constructor(status: number, errors: EbayErrorItem[], fallback: string) {
    super(errors.map((e) => e.longMessage || e.message).filter(Boolean).join(' | ') || fallback);
    this.status = status;
    this.errors = errors;
  }
}

const basicAuth = () => `Basic ${Buffer.from(`${ebayConf().clientId}:${ebayConf().clientSecret}`).toString('base64')}`;
const apizBase = () => ebayConf().apizBase;

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${ebayConf().apiBase}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new EbayError(res.status, [{ message: body.error_description || body.error }], `eBay token error ${res.status}`);
  return body as { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number };
}

export function authUrl(state: string) {
  const qs = new URLSearchParams({
    client_id: ebayConf().clientId,
    redirect_uri: ebayConf().ruName,
    response_type: 'code',
    scope: USER_SCOPES.join(' '),
    state,
    prompt: 'login',
  });
  return `${ebayConf().authBase}/oauth2/authorize?${qs}`;
}

export async function exchangeCode(code: string) {
  const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: ebayConf().ruName });
  setToken('ebay_access', body.access_token, Date.now() + body.expires_in * 1000);
  if (body.refresh_token) setToken('ebay_refresh', body.refresh_token, Date.now() + (body.refresh_token_expires_in ?? 0) * 1000);
}

export function disconnect() {
  deleteToken('ebay_access');
  deleteToken('ebay_refresh');
}

export const ebayConnected = () => !!getToken('ebay_refresh')?.value;
export const refreshTokenExpiry = () => getToken('ebay_refresh')?.expiresAt ?? null;

async function userToken(): Promise<string> {
  const cached = getToken('ebay_access');
  if (cached?.value && cached.expiresAt && cached.expiresAt - 2 * 60_000 > Date.now()) return cached.value;
  const refresh = getToken('ebay_refresh');
  if (!refresh?.value) throw new EbayError(401, [{ message: 'eBay account is not connected. Go to Settings > Connections.' }], 'not connected');
  const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh.value, scope: USER_SCOPES.join(' ') });
  setToken('ebay_access', body.access_token, Date.now() + body.expires_in * 1000);
  return body.access_token;
}

async function appToken(scope = APP_SCOPE): Promise<string> {
  const name = `ebay_app:${scope}`;
  const cached = getToken(name);
  if (cached?.value && cached.expiresAt && cached.expiresAt - 2 * 60_000 > Date.now()) return cached.value;
  const body = await tokenRequest({ grant_type: 'client_credentials', scope });
  setToken(name, body.access_token, Date.now() + body.expires_in * 1000);
  return body.access_token;
}

type RequestOpts = {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  auth?: 'user' | 'app' | 'insights';
  base?: string;
  headers?: Record<string, string>;
};

export async function ebay<T = any>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  if (!ebayConfigured()) throw new EbayError(0, [{ message: 'eBay is not configured (check EBAY_* env vars)' }], 'not configured');
  const url = new URL(`${opts.base ?? ebayConf().apiBase}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const token = opts.auth === 'app' ? await appToken() : opts.auth === 'insights' ? await appToken(INSIGHTS_SCOPE) : await userToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Accept-Language': ebayConf().contentLanguage,
        'Content-Language': ebayConf().contentLanguage,
        'X-EBAY-C-MARKETPLACE-ID': ebayConf().marketplaceId,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && attempt === 0 && (opts.auth ?? 'user') === 'user') {
      deleteToken('ebay_access');
      continue;
    }
    const text = await res.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { errors: [{ message: text.slice(0, 300) }] };
    }
    if (!res.ok) throw new EbayError(res.status, body.errors ?? [], `eBay ${method} ${path} failed (${res.status})`);
    if (body.warnings?.length) console.warn(`eBay warnings for ${method} ${path}:`, JSON.stringify(body.warnings));
    return body as T;
  }
}

// ---------- Identity ----------
export const getUser = () => ebay<{ username: string; userId: string }>('GET', '/commerce/identity/v1/user/', { base: apizBase() });

// ---------- Account / policies ----------
export async function getPolicies() {
  const q = { marketplace_id: ebayConf().marketplaceId };
  const [f, p, r] = await Promise.all([
    ebay<{ fulfillmentPolicies?: { fulfillmentPolicyId: string; name: string }[] }>('GET', '/sell/account/v1/fulfillment_policy', { query: q }),
    ebay<{ paymentPolicies?: { paymentPolicyId: string; name: string }[] }>('GET', '/sell/account/v1/payment_policy', { query: q }),
    ebay<{ returnPolicies?: { returnPolicyId: string; name: string }[] }>('GET', '/sell/account/v1/return_policy', { query: q }),
  ]);
  return {
    fulfillment: (f.fulfillmentPolicies ?? []).map((x) => ({ id: x.fulfillmentPolicyId, name: x.name })),
    payment: (p.paymentPolicies ?? []).map((x) => ({ id: x.paymentPolicyId, name: x.name })),
    returns: (r.returnPolicies ?? []).map((x) => ({ id: x.returnPolicyId, name: x.name })),
  };
}

export async function businessPoliciesOptedIn() {
  const res = await ebay<{ programs?: { programType: string }[] }>('GET', '/sell/account/v1/program/get_opted_in_programs');
  return (res.programs ?? []).some((p) => p.programType === 'SELLING_POLICY_MANAGEMENT');
}

export const optInBusinessPolicies = () =>
  ebay('POST', '/sell/account/v1/program/opt_in', { body: { programType: 'SELLING_POLICY_MANAGEMENT' } });

export async function getLocations() {
  const res = await ebay<{ locations?: { merchantLocationKey: string; name?: string; merchantLocationStatus: string; location?: any }[] }>(
    'GET',
    '/sell/inventory/v1/location',
    { query: { limit: 100 } },
  );
  return res.locations ?? [];
}

export const createLocation = (key: string, loc: { name: string; postalCode: string; country: string; city?: string; stateOrProvince?: string }) =>
  ebay('POST', `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
    body: {
      name: loc.name,
      merchantLocationStatus: 'ENABLED',
      locationTypes: ['WAREHOUSE'],
      location: { address: { postalCode: loc.postalCode, country: loc.country, city: loc.city, stateOrProvince: loc.stateOrProvince } },
    },
  });

// ---------- Taxonomy ----------
let treeId: string | null = null;
async function categoryTreeId() {
  if (!treeId) {
    const res = await ebay<{ categoryTreeId: string }>('GET', '/commerce/taxonomy/v1/get_default_category_tree_id', {
      auth: 'app',
      query: { marketplace_id: ebayConf().marketplaceId },
    });
    treeId = res.categoryTreeId;
  }
  return treeId;
}

export async function suggestCategories(q: string) {
  const id = await categoryTreeId();
  try {
    const res = await ebay<{ categorySuggestions?: { category: { categoryId: string; categoryName: string }; categoryTreeNodeAncestors?: { categoryName: string }[] }[] }>(
      'GET',
      `/commerce/taxonomy/v1/category_tree/${id}/get_category_suggestions`,
      { auth: 'app', query: { q: q.slice(0, 350) } },
    );
    return (res.categorySuggestions ?? []).map((s) => ({
      id: s.category.categoryId,
      name: s.category.categoryName,
      path: [...(s.categoryTreeNodeAncestors ?? []).map((a) => a.categoryName).reverse(), s.category.categoryName].join(' > '),
    }));
  } catch (err) {
    if (err instanceof EbayError && err.status === 204) return [];
    throw err;
  }
}

export type Aspect = {
  name: string;
  required: boolean;
  recommended: boolean;
  multi: boolean;
  freeText: boolean;
  values: string[];
  variationAllowed: boolean;
};

const aspectCache = new Map<string, { at: number; aspects: Aspect[] }>();
export async function getAspects(categoryId: string): Promise<Aspect[]> {
  const hit = aspectCache.get(categoryId);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.aspects;
  const id = await categoryTreeId();
  const res = await ebay<{ aspects?: any[] }>('GET', `/commerce/taxonomy/v1/category_tree/${id}/get_item_aspects_for_category`, {
    auth: 'app',
    query: { category_id: categoryId },
  });
  const aspects = (res.aspects ?? []).map((a) => ({
    name: a.localizedAspectName as string,
    required: !!a.aspectConstraint?.aspectRequired,
    recommended: a.aspectConstraint?.aspectUsage === 'RECOMMENDED',
    multi: a.aspectConstraint?.itemToAspectCardinality === 'MULTI',
    freeText: a.aspectConstraint?.aspectMode !== 'SELECTION_ONLY',
    values: (a.aspectValues ?? []).slice(0, 200).map((v: any) => v.localizedValue as string),
    variationAllowed: a.aspectConstraint?.aspectEnabledForVariations !== false,
  }));
  aspectCache.set(categoryId, { at: Date.now(), aspects });
  return aspects;
}

// ---------- Inventory API ----------
export type InventoryItemPayload = {
  availability: { shipToLocationAvailability: { quantity: number } };
  condition: string;
  product: {
    title: string;
    description?: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
    brand?: string;
    mpn?: string;
    upc?: string[];
    ean?: string[];
  };
};

export const putInventoryItem = (sku: string, item: InventoryItemPayload) =>
  ebay('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { body: item });

export const deleteInventoryItem = (sku: string) => ebay('DELETE', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);

export type ItemGroupPayload = {
  title: string;
  description: string;
  imageUrls: string[];
  aspects: Record<string, string[]>;
  variantSKUs: string[];
  variesBy: { aspectsImageVariesBy?: string[]; specifications: { name: string; values: string[] }[] };
};

export const putItemGroup = (key: string, group: ItemGroupPayload) =>
  ebay('PUT', `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(key)}`, { body: group });

export const deleteItemGroup = (key: string) => ebay('DELETE', `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(key)}`);

export type OfferPayload = {
  sku: string;
  marketplaceId: string;
  format: 'FIXED_PRICE';
  availableQuantity: number;
  categoryId: string;
  listingDescription?: string;
  merchantLocationKey: string;
  pricingSummary: { price: { value: string; currency: string } };
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    bestOfferTerms?: { bestOfferEnabled: boolean; autoAcceptPrice?: { value: string; currency: string }; autoDeclinePrice?: { value: string; currency: string } };
  };
};

export async function findOfferId(sku: string): Promise<string | null> {
  try {
    const res = await ebay<{ offers?: { offerId: string; marketplaceId: string }[] }>('GET', '/sell/inventory/v1/offer', {
      query: { sku, marketplace_id: ebayConf().marketplaceId },
    });
    return res.offers?.find((o) => o.marketplaceId === ebayConf().marketplaceId)?.offerId ?? null;
  } catch (err) {
    if (err instanceof EbayError && err.status === 404) return null;
    throw err;
  }
}

/** Creates the offer, or updates it if one already exists for this SKU (never creates duplicates). */
export async function upsertOffer(offer: OfferPayload, knownOfferId?: string | null): Promise<string> {
  const offerId = knownOfferId || (await findOfferId(offer.sku));
  if (offerId) {
    await ebay('PUT', `/sell/inventory/v1/offer/${offerId}`, { body: offer });
    return offerId;
  }
  const res = await ebay<{ offerId: string }>('POST', '/sell/inventory/v1/offer', { body: offer });
  return res.offerId;
}

export type OfferInfo = {
  offerId: string;
  sku: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
  availableQuantity?: number;
  pricingSummary?: { price?: { value: string } };
  listing?: { listingId?: string; listingStatus?: string; soldQuantity?: number };
};

export const getOffer = (offerId: string) => ebay<OfferInfo>('GET', `/sell/inventory/v1/offer/${offerId}`);
export const publishOffer = (offerId: string) => ebay<{ listingId: string }>('POST', `/sell/inventory/v1/offer/${offerId}/publish`);
export const withdrawOffer = (offerId: string) => ebay('POST', `/sell/inventory/v1/offer/${offerId}/withdraw`);
export const publishGroup = (key: string) =>
  ebay<{ listingId: string }>('POST', '/sell/inventory/v1/offer/publish_by_inventory_item_group', {
    body: { inventoryItemGroupKey: key, marketplaceId: ebayConf().marketplaceId },
  });
export const withdrawGroup = (key: string) =>
  ebay('POST', '/sell/inventory/v1/offer/withdraw_by_inventory_item_group', {
    body: { inventoryItemGroupKey: key, marketplaceId: ebayConf().marketplaceId },
  });

export const getListingFees = (offerIds: string[]) =>
  ebay<{ feeSummaries?: { fees?: { feeType: string; amount: { value: string } }[] }[] }>('POST', '/sell/inventory/v1/offer/get_listing_fees', {
    body: { offers: offerIds.map((offerId) => ({ offerId })) },
  });

export type PriceQtyUpdate = { sku: string; offerId: string; quantity?: number; price?: number };

export async function bulkUpdatePriceQuantity(updates: PriceQtyUpdate[]) {
  const results: { sku: string; ok: boolean; error?: string }[] = [];
  for (let i = 0; i < updates.length; i += 25) {
    const chunk = updates.slice(i, i + 25);
    const res = await ebay<{ responses?: { sku: string; statusCode: number; errors?: EbayErrorItem[] }[] }>(
      'POST',
      '/sell/inventory/v1/bulk_update_price_quantity',
      {
        body: {
          requests: chunk.map((u) => ({
            sku: u.sku,
            ...(u.quantity !== undefined ? { shipToLocationAvailability: { quantity: u.quantity } } : {}),
            offers: [
              {
                offerId: u.offerId,
                ...(u.quantity !== undefined ? { availableQuantity: u.quantity } : {}),
                ...(u.price !== undefined ? { price: { value: u.price.toFixed(2), currency: ebayConf().currency } } : {}),
              },
            ],
          })),
        },
      },
    );
    for (const r of res.responses ?? []) {
      results.push({
        sku: r.sku,
        ok: r.statusCode >= 200 && r.statusCode < 300,
        error: r.errors?.map((e) => e.longMessage || e.message).join(' | '),
      });
    }
  }
  return results;
}

// ---------- Browse (active comps) ----------
export type ActiveComp = { itemId: string; title: string; price: number; shipping: number; total: number; seller: string; url: string; image?: string };

export async function searchActive(params: { gtin?: string; q?: string; excludeSeller?: string; categoryId?: string }): Promise<{ total: number; items: ActiveComp[] }> {
  const filters = ['conditionIds:{1000}', 'buyingOptions:{FIXED_PRICE}', `deliveryCountry:${ebayConf().country}`];
  if (params.excludeSeller) filters.push(`excludeSellers:{${params.excludeSeller}}`);
  const res = await ebay<{ total?: number; itemSummaries?: any[] }>('GET', '/buy/browse/v1/item_summary/search', {
    auth: 'app',
    query: { gtin: params.gtin, q: params.gtin ? undefined : params.q, category_ids: params.categoryId, filter: filters.join(','), limit: 100 },
  });
  const items = (res.itemSummaries ?? [])
    .filter((i) => i.price?.currency === ebayConf().currency)
    .map((i) => {
      const price = Number(i.price.value);
      const ship = i.shippingOptions?.find((s: any) => s.shippingCost)?.shippingCost;
      const shipping = ship ? Number(ship.value) : 0;
      return { itemId: i.itemId, title: i.title, price, shipping, total: +(price + shipping).toFixed(2), seller: i.seller?.username ?? '', url: i.itemWebUrl, image: i.image?.imageUrl };
    });
  return { total: res.total ?? items.length, items };
}

// ---------- Marketplace Insights (sold comps; limited-release API) ----------
export type SoldComp = { itemId: string; title: string; price: number; soldQty: number; lastSoldDate: string; url: string };

export async function searchSold(params: { gtin?: string; q?: string; categoryId?: string }): Promise<SoldComp[] | null> {
  try {
    const res = await ebay<{ itemSales?: any[] }>('GET', '/buy/marketplace_insights/v1_beta/item_sales/search', {
      auth: 'insights',
      query: { gtin: params.gtin, q: params.gtin ? undefined : params.q, category_ids: params.categoryId, filter: 'conditionIds:{1000}', limit: 200 },
    });
    return (res.itemSales ?? [])
      .filter((i) => i.lastSoldPrice?.currency === ebayConf().currency)
      .map((i) => ({
        itemId: i.itemId,
        title: i.title,
        price: Number(i.lastSoldPrice.value),
        soldQty: Number(i.totalSoldQuantity ?? 1),
        lastSoldDate: i.lastSoldDate,
        url: i.itemWebUrl,
      }));
  } catch (err) {
    // 403 / invalid_scope means the app has not been granted Marketplace Insights access
    if (err instanceof EbayError && (err.status === 403 || err.status === 400 || err.status === 401)) return null;
    throw err;
  }
}

// ---------- Fulfillment (orders) ----------
export type EbayOrder = {
  orderId: string;
  creationDate: string;
  lastModifiedDate: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  cancelStatus?: { cancelState?: string };
  lineItems: { lineItemId: string; sku?: string; title: string; quantity: number; legacyItemId?: string; lineItemCost?: { value: string }; total?: { value: string } }[];
};

export async function getOrdersModifiedSince(sinceIso: string): Promise<EbayOrder[]> {
  const out: EbayOrder[] = [];
  for (let offset = 0; ; offset += 200) {
    const res = await ebay<{ orders?: EbayOrder[]; total?: number }>('GET', '/sell/fulfillment/v1/order', {
      query: { filter: `lastmodifieddate:[${sinceIso}..]`, limit: 200, offset },
    });
    out.push(...(res.orders ?? []));
    if (!res.orders?.length || out.length >= (res.total ?? 0)) return out;
  }
}

// ---------- Finances ----------
export type FinanceTxn = {
  transactionId: string;
  orderId?: string;
  transactionType: string;
  transactionDate: string;
  bookingEntry: 'CREDIT' | 'DEBIT';
  amount: { value: string };
  totalFeeAmount?: { value: string };
  orderLineItems?: { lineItemId: string; feeBasisAmount?: { value: string }; marketplaceFees?: { feeType: string; amount: { value: string } }[] }[];
};

export async function getTransactions(fromIso: string): Promise<FinanceTxn[]> {
  const out: FinanceTxn[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await ebay<{ transactions?: FinanceTxn[]; total?: number }>('GET', '/sell/finances/v1/transaction', {
      base: apizBase(),
      query: { filter: `transactionDate:[${fromIso}..${new Date().toISOString()}]`, limit: 1000, offset },
    });
    out.push(...(res.transactions ?? []));
    if (!res.transactions?.length || out.length >= (res.total ?? 0)) return out;
  }
}

// ---------- Analytics (seller standards) ----------
export type StandardsProfile = {
  program: string;
  standardsLevel: string;
  defaultProgram?: boolean;
  cycle: { cycleType: string; evaluationDate?: string };
  metrics?: { metricKey: string; name: string; level: string; value: any; thresholdUpperBound?: any; thresholdLowerBound?: any }[];
};

export async function getSellerStandards() {
  const res = await ebay<{ standardsProfiles?: StandardsProfile[] }>('GET', '/sell/analytics/v1/seller_standards_profile');
  return res.standardsProfiles ?? [];
}

export const listingUrl = (listingId: string) => `${ebayConf().webBase}/itm/${listingId}`;
