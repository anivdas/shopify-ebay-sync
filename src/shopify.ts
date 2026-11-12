import { createHmac, timingSafeEqual } from 'node:crypto';
import { shopifyConf, shopifyConfigured } from './credentials.ts';
import { uuidFrom } from './crypto.ts';
import { getToken, setToken } from './db.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShopifyError extends Error {
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

async function accessToken(): Promise<string> {
  if (shopifyConf().accessToken) return shopifyConf().accessToken;
  const cached = getToken('shopify_access');
  if (cached && cached.expiresAt && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.value;
  const res = await fetch(`https://${shopifyConf().shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: shopifyConf().clientId,
      client_secret: shopifyConf().clientSecret,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new ShopifyError(`Shopify token request failed: ${body.error_description || body.error || res.status}`);
  setToken('shopify_access', body.access_token, Date.now() + (body.expires_in ?? 86399) * 1000);
  return body.access_token;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!shopifyConfigured()) throw new ShopifyError('Shopify is not configured (check SHOPIFY_* env vars)');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${shopifyConf().shop}.myshopify.com/admin/api/${shopifyConf().apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && !shopifyConf().accessToken && attempt === 0) {
      setToken('shopify_access', '', 0);
      continue;
    }
    if (!res.ok || body.errors?.length) {
      throw new ShopifyError(`Shopify API error: ${body.errors?.map((e) => e.message).join('; ') || res.status}`, body.errors);
    }
    return body.data as T;
  }
}

export type InventoryItemInfo = {
  id: string;
  tracked: boolean;
  unitCost: { amount: string } | null;
  measurement?: { weight: { unit: string; value: number } | null } | null;
};

export type ShopifyVariant = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  image: { url: string } | null;
  inventoryItem: InventoryItemInfo;
};

export type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: string;
  tags: string[];
  descriptionHtml?: string;
  totalInventory?: number;
  featuredMedia: { preview: { image: { url: string; width?: number; height?: number } | null } | null } | null;
  media?: { nodes: { image?: { url: string; width?: number; height?: number } }[] };
  options?: { name: string; values: string[] }[];
  collections?: string[];
  variants: { nodes: ShopifyVariant[] };
};

/** Collections are only used for rules; the query asks for titles and we flatten them to string[]. */
const flattenCollections = (p: any) => (p?.collections?.nodes ? { ...p, collections: p.collections.nodes.map((c: { title: string }) => c.title) } : p);

// Uses the current (non-deprecated) `barcodes` and `media` fields; normalized into `barcode` / `image` below.
const VARIANT_FIELDS = `
  id title sku price compareAtPrice inventoryQuantity
  barcodes(first: 2) { nodes { value type } }
  selectedOptions { name value }
  media(first: 1) { nodes { preview { image { url } } } }
  inventoryItem { id tracked unitCost { amount } measurement { weight { unit value } } }
`;

type RawVariant = Omit<ShopifyVariant, 'barcode' | 'image'> & {
  barcodes?: { nodes: { value: string; type: string | null }[] };
  media?: { nodes: { preview?: { image?: { url: string } | null } | null }[] };
};

/** Picks the GTIN-style barcode (UPC/EAN) if a variant has several. */
export function pickBarcode(nodes: { value: string; type: string | null }[] = []): string | null {
  const gtin = nodes.find((b) => /^\d{12,14}$/.test(b.value.trim()));
  return (gtin ?? nodes[0])?.value.trim() || null;
}

const normalizeVariant = (v: RawVariant): ShopifyVariant => {
  const { barcodes, media, ...rest } = v;
  const url = media?.nodes[0]?.preview?.image?.url;
  return { ...rest, barcode: pickBarcode(barcodes?.nodes), image: url ? { url } : null };
};

const normalizeProduct = (p: any): ShopifyProduct => ({ ...flattenCollections(p), variants: { nodes: (p.variants?.nodes ?? []).map(normalizeVariant) } });

export type ProductSummary = {
  id: string;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  totalInventory: number | null;
  hasOnlyDefaultVariant: boolean;
  variantsCount: { count: number };
  priceRangeV2: { minVariantPrice: { amount: string }; maxVariantPrice: { amount: string } };
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  tags: string[];
  collections: string[];
};

/** Lightweight product list (variants are loaded per product to stay under Shopify's query cost limit). */
export async function listProducts(opts: { query?: string; after?: string | null; first?: number }) {
  const data = await gql<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: any[] } }>(
    `query ($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title vendor productType status totalInventory hasOnlyDefaultVariant tags
          variantsCount { count }
          priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
          featuredMedia { preview { image { url } } }
          collections(first: 5) { nodes { title } }
        }
      }
    }`,
    { first: Math.min(opts.first ?? 50, 50), after: opts.after ?? null, query: opts.query || null },
  );
  return { pageInfo: data.products.pageInfo, nodes: data.products.nodes.map(flattenCollections) as ProductSummary[] };
}

export type RuleScanProduct = { id: string; title: string; vendor: string; productType: string; status: string; tags: string[]; collections: string[] };

/** Every product with just the fields rules need (for auto-listing when a product stops being excluded). */
export async function* allProductsForRules(): AsyncGenerator<RuleScanProduct[]> {
  let after: string | null = null;
  for (;;) {
    const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: any[] } } = await gql(
      `query ($after: String) {
        products(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id title vendor productType status tags collections(first: 5) { nodes { title } } }
        }
      }`,
      { after },
    );
    yield data.products.nodes.map(flattenCollections);
    if (!data.products.pageInfo.hasNextPage) return;
    after = data.products.pageInfo.endCursor;
  }
}

export type CatalogVariant = {
  id: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  selectedOptions: { name: string; value: string }[];
  barcodes: { nodes: { value: string; type: string | null }[] };
  inventoryItem: InventoryItemInfo;
  product: { id: string; title: string; vendor: string; status: string; featuredMedia: { preview: { image: { url: string; width: number | null; height: number | null } | null } | null } | null };
};

/** Iterates every variant in the store (flat pagination keeps each query cheap). */
export async function* allVariants(): AsyncGenerator<CatalogVariant[]> {
  let after: string | null = null;
  for (;;) {
    const data: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CatalogVariant[] } } = await gql(
      `query ($after: String) {
        productVariants(first: 80, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title sku inventoryQuantity
            selectedOptions { name value }
            barcodes(first: 3) { nodes { value type } }
            inventoryItem { id tracked unitCost { amount } measurement { weight { unit value } } }
            product { id title vendor status featuredMedia { preview { image { url width height } } } }
          }
        }
      }`,
      { after },
    );
    yield data.productVariants.nodes;
    if (!data.productVariants.pageInfo.hasNextPage) return;
    after = data.productVariants.pageInfo.endCursor;
  }
}

export async function getProduct(id: string): Promise<ShopifyProduct | null> {
  const data = await gql<{ product: any }>(
    `query ($id: ID!) {
      product(id: $id) {
        id title handle vendor productType status tags descriptionHtml totalInventory
        featuredMedia { preview { image { url width height } } }
        options { name values }
        collections(first: 10) { nodes { title } }
        media(first: 24) { nodes { ... on MediaImage { image { url width height } } } }
        variants(first: 100) { nodes { ${VARIANT_FIELDS} } }
      }
    }`,
    { id },
  );
  return data.product ? normalizeProduct(data.product) : null;
}

export type VariantPatch = { id: string; sku?: string; barcode?: string; cost?: number | null; tracked?: boolean };

/** Updates SKU / barcode / cost / tracking for variants of one product in a single call (needs write_products). */
export async function updateVariants(productId: string, patches: VariantPatch[]) {
  const variants = patches.map((p) => {
    const inventoryItem: Record<string, unknown> = {};
    if (p.sku !== undefined) inventoryItem.sku = p.sku;
    if (p.cost !== undefined) inventoryItem.cost = p.cost;
    if (p.tracked !== undefined) inventoryItem.tracked = p.tracked;
    return {
      id: p.id,
      ...(Object.keys(inventoryItem).length ? { inventoryItem } : {}),
      ...(p.barcode !== undefined ? { barcodes: p.barcode ? [{ value: p.barcode }] : [] } : {}),
    };
  });
  const data = await gql<{ productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants },
  );
  const errors = data.productVariantsBulkUpdate.userErrors;
  if (errors.length) throw new ShopifyError(errors.map((e) => e.message).join('; '), errors);
}

export type VariantState = {
  id: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: InventoryItemInfo;
  product: { id: string; status: string; title?: string; vendor?: string; productType?: string; tags?: string[]; collections?: string[] };
};

export async function getVariantStates(ids: string[]): Promise<Map<string, VariantState>> {
  const out = new Map<string, VariantState>();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql<{ nodes: (any | null)[] }>(
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id price compareAtPrice inventoryQuantity
            inventoryItem { id tracked unitCost { amount } measurement { weight { unit value } } }
            product { id status title vendor productType tags collections(first: 5) { nodes { title } } }
          }
        }
      }`,
      { ids: ids.slice(i, i + 50) },
    );
    for (const n of data.nodes) if (n?.id) out.set(n.id, { ...n, product: flattenCollections(n.product) });
  }
  return out;
}

export async function findVariantBySku(sku: string) {
  const data = await gql<{ productVariants: { nodes: { id: string; sku: string; inventoryItem: { id: string } }[] } }>(
    `query ($q: String!) { productVariants(first: 5, query: $q) { nodes { id sku inventoryItem { id } } } }`,
    { q: `sku:${JSON.stringify(sku)}` },
  );
  return data.productVariants.nodes.find((v) => v.sku === sku) ?? null;
}

export async function getLocations() {
  const data = await gql<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(
    `{ locations(first: 50) { nodes { id name isActive } } }`,
  );
  return data.locations.nodes;
}

async function inventoryLevels(inventoryItemId: string) {
  const data = await gql<{
    inventoryItem: { inventoryLevels: { nodes: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] }[] } } | null;
  }>(
    `query ($id: ID!) {
      inventoryItem(id: $id) {
        inventoryLevels(first: 25) { nodes { location { id name } quantities(names: ["available"]) { name quantity } } }
      }
    }`,
    { id: inventoryItemId },
  );
  return (data.inventoryItem?.inventoryLevels.nodes ?? []).map((n) => ({
    locationId: n.location.id,
    locationName: n.location.name,
    available: n.quantities.find((q) => q.name === 'available')?.quantity ?? 0,
  }));
}

/**
 * Adjusts "available" stock by delta. The idempotency key is derived from `reference`, so
 * retrying the same eBay order line can never double-adjust Shopify.
 */
export async function adjustInventory(inventoryItemId: string, delta: number, reference: string, preferredLocationId?: string) {
  const levels = await inventoryLevels(inventoryItemId);
  if (!levels.length) throw new ShopifyError('Inventory item is not stocked at any location');
  const level =
    levels.find((l) => l.locationId === preferredLocationId) ??
    (delta < 0 ? [...levels].sort((a, b) => b.available - a.available)[0] : levels[0]);
  const data = await gql<{ inventoryAdjustQuantities: { userErrors: { field: string[]; message: string }[] } }>(
    `mutation ($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } }
    }`,
    {
      key: uuidFrom(`adjust:${reference}:${delta}`),
      input: {
        reason: 'correction',
        name: 'available',
        referenceDocumentUri: `gid://shopify-ebay-sync/EbayOrderLine/${encodeURIComponent(reference)}`,
        changes: [{ delta, inventoryItemId, locationId: level.locationId, changeFromQuantity: null }],
      },
    },
  );
  const errors = data.inventoryAdjustQuantities.userErrors;
  if (errors.length) throw new ShopifyError(errors.map((e) => e.message).join('; '), errors);
  return { locationName: level.locationName, before: level.available, after: level.available + delta };
}

export const WEBHOOK_TOPICS = ['INVENTORY_LEVELS_UPDATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'] as const;

export async function listWebhooks() {
  const data = await gql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(
    `{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  );
  return data.webhookSubscriptions.nodes;
}

export async function registerWebhooks(baseUrl: string) {
  const uri = `${baseUrl.replace(/\/$/, '')}/webhooks/shopify`;
  const existing = await listWebhooks();
  for (const hook of existing) {
    if (hook.uri.endsWith('/webhooks/shopify') && hook.uri !== uri) {
      await gql(`mutation ($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }`, { id: hook.id });
    }
  }
  const results: { topic: string; ok: boolean; message?: string }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((h) => h.topic === topic && h.uri === uri)) {
      results.push({ topic, ok: true, message: 'already registered' });
      continue;
    }
    const data = await gql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
      `mutation ($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } }
      }`,
      { topic, sub: { uri } },
    );
    const errs = data.webhookSubscriptionCreate.userErrors;
    results.push({ topic, ok: !errs.length, message: errs.map((e) => e.message).join('; ') || undefined });
  }
  return { uri, results };
}

export function verifyWebhook(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  const secret = shopifyConf().webhookSecret;
  if (!secret || !hmacHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(hmacHeader, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const numericId = (gid: string) => gid.split('/').pop() ?? gid;
export const variantGid = (id: string | number) => `gid://shopify/ProductVariant/${id}`;
export const inventoryItemGid = (id: string | number) => `gid://shopify/InventoryItem/${id}`;
export const productGid = (id: string | number) => `gid://shopify/Product/${id}`;
export const adminProductUrl = (gid: string) => `https://admin.shopify.com/store/${shopifyConf().shop}/products/${numericId(gid)}`;
