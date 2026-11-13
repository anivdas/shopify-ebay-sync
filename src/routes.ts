import { randomBytes } from 'node:crypto';
import { runAutoList } from './autolist.ts';
import * as catalog from './catalog.ts';
import { eligibility, listOverrides, setOverride } from './rules.ts';
import { countryValue, inferAspects, renderDescription, smartTitle, stripHtml } from './listing-builder.ts';
import { config, MARKETPLACES } from './config.ts';
import { describeCredentials, ebayConf, ebayConfigured, saveCredentials, shopifyConf, shopifyConfigured } from './credentials.ts';
import { all, defaultSettings, get, getSettings, getState, json, run, setState, updateSettings } from './db.ts';
import * as ebay from './ebay.ts';
import { HttpError, num, Router, type Ctx } from './http.ts';
import { enqueue, JOBS, jobStatus, queueWebhookSync, runJob } from './jobs.ts';
import * as L from './listings.ts';
import { logActivity, sendAlert } from './log.ts';
import { effectiveBase, estimateProfit, recommend } from './pricing.ts';
import { latestSnapshot, researchItem, researchVariant, snapshotHistory } from './research.ts';
import * as shopify from './shopify.ts';
import { approveHeldPrice, staleListings } from './sync.ts';

export const router = new Router();
const oauthStates = new Map<string, number>();
const OAUTH_STATE_TTL = 30 * 60_000;

/** CSV cell: quoted when needed; cells a spreadsheet would run as a formula (=, +, -, @) are neutralised. */
export const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const REQUIRED_SHOPIFY_SCOPES = ['write_products', 'read_inventory', 'write_inventory', 'read_locations'];

const id = (ctx: Ctx) => {
  const n = Number(ctx.params.id);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id');
  return n;
};

// ============ Status & setup checklist ============

async function testShopify() {
  const data = await shopify.gql<{ shop: { name: string; myshopifyDomain: string; currencyCode: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(
    `{ shop { name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`,
  );
  const scopes = data.currentAppInstallation.accessScopes.map((s) => s.handle);
  const missing = REQUIRED_SHOPIFY_SCOPES.filter((s) => !scopes.includes(s) && !(s.startsWith('read_') && scopes.includes(s.replace('read_', 'write_'))));
  const result = { ok: !missing.length, shop: data.shop.name, domain: data.shop.myshopifyDomain, currency: data.shop.currencyCode, missingScopes: missing, at: new Date().toISOString() };
  setState('shopifyTest', result);
  return result;
}

async function testEbay() {
  const user = await ebay.getUser();
  if (!getSettings().ebayUsername) updateSettings({ ebayUsername: user.username });
  const optedIn = await ebay.businessPoliciesOptedIn().catch(() => null);
  const insights = await ebay.searchSold({ q: 'iphone' }).then((r) => r !== null).catch(() => false);
  const result = { ok: true, username: user.username, policiesOptIn: optedIn, insightsAccess: insights, at: new Date().toISOString() };
  setState('ebayTest', result);
  return result;
}

function checklist() {
  const s = getSettings();
  const shopTest = getState<{ ok: boolean; currency: string; missingScopes: string[] }>('shopifyTest');
  const ebayTest = getState<{ ok: boolean; username: string; policiesOptIn: boolean | null; insightsAccess: boolean }>('ebayTest');
  const conf = ebayConf();
  const steps = [
    { key: 'shopify', title: 'Connect Shopify', done: shopifyConfigured() && !!shopTest?.ok, optional: false, detail: shopTest?.missingScopes?.length ? `Missing scopes: ${shopTest.missingScopes.join(', ')}` : undefined },
    { key: 'ebayKeys', title: 'Add eBay developer keys', done: ebayConfigured(), optional: false },
    { key: 'ebayConnect', title: 'Connect your eBay seller account', done: ebay.ebayConnected(), optional: false, detail: ebayTest?.username ? `Connected as ${ebayTest.username}` : undefined },
    { key: 'policies', title: 'Choose default eBay business policies', done: !!(s.fulfillmentPolicyId && s.paymentPolicyId && s.returnPolicyId), optional: false, detail: ebayTest?.policiesOptIn === false ? 'Opt in to business policies first' : undefined },
    { key: 'location', title: 'Choose an eBay inventory location', done: !!s.merchantLocationKey, optional: false },
    { key: 'pricing', title: 'Review pricing rules', done: !!getState('pricingReviewed'), optional: false },
    { key: 'insights', title: 'Sold-price data (Marketplace Insights API)', done: !!ebayTest?.insightsAccess, optional: true, detail: 'Requires approval from eBay; active-listing research works without it' },
    { key: 'webhooks', title: 'Instant Shopify updates (webhooks)', done: !!getState('webhooksRegistered'), optional: true, detail: 'Needs a public HTTPS URL, e.g. a free Cloudflare Tunnel' },
  ];
  const warnings: string[] = [];
  if (shopTest?.currency && shopTest.currency !== conf.currency) warnings.push(`Your Shopify currency (${shopTest.currency}) differs from the eBay marketplace currency (${conf.currency}). Prices are not converted.`);
  if (s.dryRun) warnings.push('Dry-run mode is ON: nothing is being changed on eBay or Shopify.');
  return { steps, warnings, complete: steps.filter((x) => !x.optional).every((x) => x.done) };
}

router.get('/api/status', () => {
  const counts = Object.fromEntries(all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ebay_listings GROUP BY status').map((r) => [r.status, r.n]));
  const sales30 = get<{ units: number; revenue: number }>(
    `SELECT COALESCE(SUM(quantity),0) AS units, COALESCE(SUM(total),0) AS revenue FROM processed_orders WHERE status = 'applied' AND ordered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`,
  );
  const salesByDay = all(
    `SELECT substr(ordered_at,1,10) AS day, SUM(quantity) AS units, ROUND(SUM(total),2) AS revenue FROM processed_orders
     WHERE status = 'applied' AND ordered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') GROUP BY day ORDER BY day`,
  );
  const alerts = all(`SELECT * FROM activity WHERE level IN ('warn','error') ORDER BY id DESC LIMIT 8`);
  const held = get<{ n: number }>('SELECT COUNT(*) AS n FROM listing_items WHERE held_price IS NOT NULL')!.n;
  const belowFloor = all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM listing_items i JOIN market_snapshots m ON m.id = (SELECT id FROM market_snapshots WHERE shopify_variant_id = i.shopify_variant_id ORDER BY taken_at DESC LIMIT 1)
     WHERE m.reason LIKE 'market_below_floor%'`,
  )[0].n;
  return {
    version: config.version,
    checklist: checklist(),
    shopify: { configured: shopifyConfigured(), shop: shopifyConf().shop, test: getState('shopifyTest') ?? null },
    ebay: { configured: ebayConfigured(), connected: ebay.ebayConnected(), env: ebayConf().env, marketplace: ebayConf().marketplaceId, country: ebayConf().country, currency: ebayConf().currency, test: getState('ebayTest') ?? null, refreshExpires: ebay.refreshTokenExpiry() },
    counts,
    sales30,
    salesByDay,
    alerts,
    held,
    belowFloor,
    stale: staleListings().length,
    standards: getState('sellerStandards') ?? null,
    jobs: jobStatus(),
    dryRun: getSettings().dryRun,
  };
});

// ============ Settings & credentials ============

router.get('/api/settings', () => ({ settings: getSettings(), defaults: { descriptionTemplate: defaultSettings.descriptionTemplate }, marketplaces: MARKETPLACES }));
router.put('/api/settings', ({ body }) => {
  const s = updateSettings(body ?? {});
  if (body && ('markupMinPct' in body || 'markupMaxPct' in body)) setState('pricingReviewed', true);
  if (s.markupMinPct > s.markupMaxPct) throw new HttpError(400, 'Minimum markup cannot exceed maximum markup');
  return { settings: s };
});
router.post('/api/settings/pricing-reviewed', () => (setState('pricingReviewed', true), { ok: true }));

router.get('/api/credentials', () => ({
  credentials: describeCredentials(),
  callbackUrl: `${config.publicUrl || '<your-app-url>'}/auth/ebay/callback`,
  marketplaces: MARKETPLACES,
}));
router.put('/api/credentials', ({ body }) => {
  saveCredentials(body ?? {});
  return { credentials: describeCredentials() };
});
router.post('/api/credentials/test', async ({ body }) => {
  try {
    return body?.which === 'ebay' ? await testEbay() : await testShopify();
  } catch (e) {
    const result = { ok: false, error: (e as Error).message, at: new Date().toISOString() };
    setState(body?.which === 'ebay' ? 'ebayTest' : 'shopifyTest', result);
    return result;
  }
});

// ============ eBay account ============

router.get('/api/ebay/connect-url', () => {
  if (!ebayConfigured()) throw new HttpError(400, 'Add your eBay developer keys first');
  const state = randomBytes(16).toString('hex');
  for (const [s, at] of oauthStates) if (Date.now() - at > OAUTH_STATE_TTL) oauthStates.delete(s);
  oauthStates.set(state, Date.now());
  return { url: ebay.authUrl(state) };
});

async function finishEbayConnect(code: string) {
  await ebay.exchangeCode(code);
  logActivity('success', 'ebay.connect', 'eBay account connected');
  await testEbay().catch(() => undefined);
}

router.get('/auth/ebay/callback', async ({ query, res }) => {
  const code = query.get('code');
  const state = query.get('state') ?? '';
  if (!code) throw new HttpError(400, `eBay did not return an authorization code${query.get('error') ? `: ${query.get('error')}` : ''}`);
  const issued = oauthStates.get(state);
  if (!issued || Date.now() - issued > OAUTH_STATE_TTL) throw new HttpError(400, 'This eBay login link has expired. Start again from Settings.');
  oauthStates.delete(state);
  await finishEbayConnect(code);
  res.writeHead(302, { Location: '/setup?ebay=connected' });
  res.end();
  return undefined;
});

router.post('/api/ebay/code', async ({ body }) => {
  const input = String(body?.code ?? '').trim();
  let code = input;
  try {
    // A pasted URL: URLSearchParams already decodes the value, so don't decode again
    code = new URL(input).searchParams.get('code') ?? '';
  } catch {
    // A bare code: decode only if it looks URL-encoded and decodes cleanly
    if (/%[0-9A-Fa-f]{2}/.test(code)) {
      try {
        code = decodeURIComponent(code);
      } catch {}
    }
  }
  if (!code) throw new HttpError(400, 'Paste the full address from your browser after approving on eBay (it contains "code=")');
  await finishEbayConnect(code);
  return { ok: true };
});

router.post('/api/ebay/disconnect', () => {
  ebay.disconnect();
  setState('ebayTest', null);
  logActivity('info', 'ebay.connect', 'eBay account disconnected');
  return { ok: true };
});

router.get('/api/ebay/policies', async () => ebay.getPolicies());
router.post('/api/ebay/opt-in', async () => {
  await ebay.optInBusinessPolicies();
  return { ok: true, note: 'eBay can take a few minutes (up to 24h) to enable business policies.' };
});
router.get('/api/ebay/locations', async () => ({ locations: await ebay.getLocations() }));
router.post('/api/ebay/locations', async ({ body }) => {
  const key = String(body?.key || 'main-warehouse').replace(/[^\w-]/g, '-').slice(0, 36);
  await ebay.createLocation(key, { name: body?.name || 'Main warehouse', postalCode: body?.postalCode, country: body?.country || ebayConf().country, city: body?.city, stateOrProvince: body?.stateOrProvince });
  updateSettings({ merchantLocationKey: key });
  return { key };
});
router.put('/api/ebay/locations/:key', async ({ params, body }) => {
  if (!body?.postalCode) throw new HttpError(400, 'ZIP / postal code is required');
  await ebay.updateLocation(params.key, { name: body.name || params.key, postalCode: body.postalCode, country: body.country || ebayConf().country, city: body.city, stateOrProvince: body.stateOrProvince });
  return { key: params.key };
});
router.del('/api/ebay/locations/:key', async ({ params }) => {
  const used = get<{ n: number }>("SELECT COUNT(*) AS n FROM ebay_listings WHERE merchant_location_key = ? AND status != 'draft'", params.key)?.n ?? 0;
  if (used) throw new HttpError(409, `${used} published listing(s) use this location. Edit it instead of deleting it.`);
  await ebay.deleteLocation(params.key);
  if (getSettings().merchantLocationKey === params.key) updateSettings({ merchantLocationKey: '' });
  return { key: params.key };
});
router.get('/api/ebay/categories', async ({ query }) => ({ categories: await ebay.suggestCategories(query.get('q') ?? '') }));
router.get('/api/ebay/aspects', async ({ query }) => ({ aspects: await ebay.getAspects(query.get('categoryId') ?? '') }));

// ============ Shopify ============

router.get('/api/shopify/products', async ({ query }) => {
  const first = Math.min(num(query.get('first'), 50), 50);
  const hideListed = query.get('hideListed') === '1';
  const linked = new Map<string, { listing_id: number; status: string; linked_variants: number }>(
    all<{ shopify_product_id: string; listing_id: number; status: string; linked_variants: number }>(
      `SELECT l.shopify_product_id, MIN(l.id) AS listing_id, MIN(l.status) AS status, COUNT(i.id) AS linked_variants
       FROM ebay_listings l JOIN listing_items i ON i.listing_id = l.id GROUP BY l.shopify_product_id`,
    ).map((r) => [r.shopify_product_id, r]),
  );
  const fullyListed = (p: shopify.ProductSummary) => (linked.get(p.id)?.linked_variants ?? 0) >= p.variantsCount.count;
  // Listing status lives in this app, not Shopify, so hidden products are skipped here and more pages are
  // read until the page is full; the cursor resumes right after the last product looked at.
  const nodes: shopify.ProductSummary[] = [];
  let after = query.get('after');
  let hasNextPage = false;
  for (let reads = 0; reads < 10; reads++) {
    const page = await shopify.listProducts({ query: query.get('q') ?? undefined, after, first, sort: (query.get('sort') ?? 'title') as shopify.ProductSort, inStock: query.get('inStock') === '1' });
    let i = 0;
    for (; i < page.nodes.length && nodes.length < first; i++) {
      after = page.nodes[i].cursor;
      if (!(hideListed && fullyListed(page.nodes[i]))) nodes.push(page.nodes[i]);
    }
    hasNextPage = i < page.nodes.length || page.pageInfo.hasNextPage;
    if (nodes.length >= first || !page.pageInfo.hasNextPage) break;
  }
  const settings = getSettings();
  const overrides = new Map(listOverrides().map((o) => [o.product_id, o.mode]));
  return {
    pageInfo: { hasNextPage, endCursor: after },
    products: nodes.map((p) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      status: p.status,
      totalInventory: p.totalInventory,
      variantsCount: p.variantsCount.count,
      minPrice: Number(p.priceRangeV2.minVariantPrice.amount),
      maxPrice: Number(p.priceRangeV2.maxVariantPrice.amount),
      image: p.featuredMedia?.preview?.image?.url ?? null,
      linked: linked.get(p.id) ?? null,
      override: overrides.get(p.id) ?? null,
      ...eligibility(p, settings, overrides.get(p.id) ?? null),
    })),
  };
});

// ============ Rules: per-product exceptions ============

router.get('/api/rules/overrides', () => ({ overrides: listOverrides() }));

/** mode: 'allow' (list even if a rule matches), 'block' (never list) or null (follow the rules). */
router.post('/api/products/:id/override', async ({ params, body }) => {
  const mode = body?.mode === 'allow' || body?.mode === 'block' ? body.mode : null;
  const product = await shopify.getProduct(params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  setOverride(product.id, mode, product.title);
  const settings = getSettings();
  const result = eligibility({ ...product, id: product.id }, settings, mode);
  run('UPDATE ebay_listings SET excluded_reason = ? WHERE shopify_product_id = ?', result.excluded, product.id);
  logActivity('info', 'rules', `${mode === 'allow' ? 'Allowed' : mode === 'block' ? 'Blocked' : 'Cleared exception for'} "${product.title}"`);
  // Apply right away: pause/resume live listings, publish waiting drafts / auto-list
  enqueue('rules', async () => {
    await import('./sync.ts').then((m) => m.syncShopifyToEbay({ productIds: [product.id] }));
    await runAutoList();
  }).catch(() => undefined);
  return { ok: true, ...result };
});

router.post('/api/tools/title-preview', ({ body }) => smartTitle(String(body?.title ?? '')));

const SAMPLE_DESCRIPTION =
  '<p><span style="font-family:Times New Roman;font-size:18px;color:#c00">*Perfect Condition Sealed</span><br><br>*Limited Edition<br><br><font face="Comic Sans MS">Playback</font><br>Region Free</p><p style="font-size:11px">Steelbook Disclaimer: we inspect every steelbook carefully.</p>';
router.post('/api/tools/description-preview', ({ body }) => {
  const title = String(body?.title ?? 'Sample product');
  return {
    html: renderDescription(String(body?.template ?? ''), {
      title,
      fullTitle: title,
      showFullTitle: body?.showFullTitle !== false,
      keepFormatting: !!body?.keepFormatting,
      description: SAMPLE_DESCRIPTION,
    }),
  };
});

router.post('/api/listings/:id/infer-aspects', async (ctx) => {
  const l = L.getListing(id(ctx));
  if (!l) throw new HttpError(404, 'Listing not found');
  const categoryId = String(ctx.body?.categoryId || l.category_id || '');
  if (!categoryId) throw new HttpError(400, 'Choose an eBay category first');
  const defs = await ebay.getAspects(categoryId);
  const title = l.product_title || l.title;
  const firstVariant = L.getItems(l.id)[0]?.shopify_variant_id;
  const product = await shopify.getProduct(l.shopify_product_id);
  const variant = product?.variants.nodes.find((v) => v.id === firstVariant) ?? product?.variants.nodes[0];
  const countryOfOrigin = variant?.inventoryItem.countryCodeOfOrigin ?? null;
  const existing = (ctx.body?.aspects ?? {}) as Record<string, string[]>;
  const aspects = inferAspects({ title, description: stripHtml(l.description_html), brand: l.brand, countryOfOrigin }, defs, existing);
  // Explain skipped country so a missed auto-fill is diagnosable instead of silent.
  const notes: string[] = [];
  const countryDef = defs.find((d) => /country.*(origin|manufacture)/i.test(d.name));
  if (countryDef && !existing[countryDef.name]?.length && !aspects[countryDef.name]) {
    if (!countryOfOrigin) notes.push(`${countryDef.name}: this product has no country of origin in Shopify.`);
    else notes.push(`${countryDef.name}: Shopify says "${countryOfOrigin}" (${countryValue(countryOfOrigin) ?? 'unknown code'}), but none of eBay's ${countryDef.values.length} values matched it. Please pick it from the list.`);
  }
  return { aspects, notes };
});

router.post('/api/alerts/test', async () => {
  if (!getSettings().alertWebhookUrl) throw new HttpError(400, 'Enter and save an alert webhook URL first');
  await sendAlert('Test alert: notifications are working.');
  return { ok: true };
});

router.get('/api/shopify/products/:id', async ({ params }) => {
  const product = await shopify.getProduct(params.id);
  if (!product) throw new HttpError(404, 'Product not found');
  const linked = new Map(
    all<{ shopify_variant_id: string; listing_id: number; status: string }>(
      'SELECT i.shopify_variant_id, i.listing_id, l.status FROM listing_items i JOIN ebay_listings l ON l.id = i.listing_id WHERE l.shopify_product_id = ?',
      product.id,
    ).map((r) => [r.shopify_variant_id, r]),
  );
  return { product: { ...product, variants: product.variants.nodes.map((v) => ({ ...v, linked: linked.get(v.id) ?? null })) } };
});
router.get('/api/shopify/locations', async () => ({ locations: await shopify.getLocations() }));
router.get('/api/shopify/webhooks', async () => ({ webhooks: await shopify.listWebhooks() }));
router.post('/api/shopify/webhooks/register', async ({ body }) => {
  const base = String(body?.url || getSettings().webhookPublicUrl || '').trim();
  if (!/^https:\/\//.test(base)) throw new HttpError(400, 'A public https:// URL is required (e.g. your Cloudflare Tunnel address)');
  updateSettings({ webhookPublicUrl: base });
  const result = await shopify.registerWebhooks(base);
  setState('webhooksRegistered', result.results.every((r) => r.ok));
  logActivity('info', 'webhooks', `Shopify webhooks registered at ${result.uri}`);
  return result;
});

router.post(
  '/webhooks/shopify',
  ({ req, rawBody, body }) => {
    if (!shopify.verifyWebhook(rawBody, req.headers['x-shopify-hmac-sha256'] as string | undefined)) throw new HttpError(401, 'Invalid webhook signature');
    const topic = String(req.headers['x-shopify-topic'] ?? '');
    if (topic === 'inventory_levels/update' && body?.inventory_item_id) queueWebhookSync('inventory', shopify.inventoryItemGid(body.inventory_item_id));
    else if ((topic === 'products/update' || topic === 'products/delete') && body?.id) queueWebhookSync('products', shopify.productGid(body.id));
    return { ok: true };
  },
  { public: true },
);

// ============ Catalog health (Shopify data quality) ============

const catalogResponse = (scan: { at: string; rows: catalog.CatalogRow[] } | null) =>
  scan ? { at: scan.at, summary: catalog.summarize(scan.rows), rows: scan.rows, issues: catalog.ISSUE_INFO, undo: catalog.lastUndo() } : { at: null, issues: catalog.ISSUE_INFO, undo: catalog.lastUndo() };

router.get('/api/catalog', () => catalogResponse(catalog.cachedScan()));
router.post('/api/catalog/scan', async () => catalogResponse(await catalog.scanCatalog()));
router.post('/api/catalog/sku-preview', ({ body }) => {
  const scan = catalog.cachedScan();
  if (!scan) throw new HttpError(400, 'Scan the catalog first');
  return { proposals: catalog.proposeSkus(scan.rows, (body?.mode ?? 'missing') as catalog.SkuMode) };
});
router.post('/api/catalog/apply', async ({ body }) => {
  if (!catalog.cachedScan()) throw new HttpError(400, 'Scan the catalog first');
  const changes = (body?.changes ?? []) as catalog.Change[];
  if (!changes.length) throw new HttpError(400, 'No changes selected');
  const res = await enqueue('catalog', () => catalog.applyChanges(changes, String(body?.label || 'Catalog update')));
  return { ...res, ...catalogResponse(catalog.cachedScan()) };
});
router.post('/api/catalog/track-all', async () => {
  const scan = catalog.cachedScan();
  if (!scan) throw new HttpError(400, 'Scan the catalog first');
  const changes = scan.rows.filter((r) => !r.tracked).map((r) => ({ variantId: r.variantId, productId: r.productId, tracked: true }));
  if (!changes.length) return { done: 0, failed: [] };
  const res = await enqueue('catalog', () => catalog.applyChanges(changes, 'Turn on inventory tracking'));
  return { ...res, ...catalogResponse(await catalog.scanCatalog()) };
});
router.post('/api/catalog/undo', async () => {
  const res = await enqueue('catalog', () => catalog.undoLast());
  return { ...res, ...catalogResponse(await catalog.scanCatalog()) };
});

// ============ Profiles ============

router.get('/api/profiles', () => ({ profiles: L.listProfiles().map((p) => ({ ...p, default_aspects: json(p.default_aspects, {}) })) }));
router.post('/api/profiles', ({ body }) => ({ profile: L.saveProfile(body) }));
router.put('/api/profiles/:id', (ctx) => ({ profile: L.saveProfile(ctx.body, id(ctx)) }));
router.del('/api/profiles/:id', (ctx) => (L.deleteProfile(id(ctx)), { ok: true }));

// ============ Listings ============

function enrichItem(item: L.Item, listing: L.Listing) {
  const settings = getSettings();
  const rules = L.rulesFor(listing, settings);
  const target = L.targetPrice(item, rules, settings);
  const snap = latestSnapshot(item.shopify_variant_id);
  const price = item.ebay_price ?? target ?? 0;
  const base = item.shopify_price !== null ? effectiveBase(item.shopify_price, item.shopify_compare_at, settings.useShopifySalePrice) : null;
  const lineFees = get<{ fees: number; gross: number }>(
    `SELECT SUM(f.fees) AS fees, SUM(f.amount) AS gross FROM finance_lines f JOIN processed_orders o ON o.line_item_id = f.line_item_id WHERE o.sku = ? AND f.transaction_type = 'SALE'`,
    item.sku,
  );
  const feePct = lineFees?.gross ? (lineFees.fees / lineFees.gross) * 100 : settings.ebayFeePct;
  return {
    ...L.decodeItem(item),
    target_price: target,
    target_qty: L.targetQuantity(item, settings),
    base_price: base,
    current_pct: base && price ? +(((price / base) - 1) * 100).toFixed(2) : null,
    floor: base ? +(base * (1 + rules.minPct / 100)).toFixed(2) : null,
    ceiling: base ? +(base * (1 + rules.maxPct / 100)).toFixed(2) : null,
    profit: price
      ? estimateProfit(price, { cost: item.unit_cost, feePct, fixedFee: lineFees?.gross ? 0 : settings.ebayFixedFee, shipping: settings.avgShippingCost, shippingCharged: settings.buyerShippingEstimate })
      : null,
    fee_source: lineFees?.gross ? 'actual' : 'estimate',
    market: snap,
    sold_30d: get<{ n: number }>(`SELECT COALESCE(SUM(quantity),0) AS n FROM processed_orders WHERE sku = ? AND status = 'applied' AND ordered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`, item.sku)!.n,
  };
}

router.get('/api/listings', ({ query }) => {
  const status = query.get('status');
  const q = query.get('q');
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) where.push('l.status = ?'), params.push(status);
  if (q) where.push('(l.title LIKE ? OR l.product_title LIKE ? OR EXISTS (SELECT 1 FROM listing_items i WHERE i.listing_id = l.id AND i.sku LIKE ?))'), params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  const rows = all<L.Listing>(`SELECT * FROM ebay_listings l ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.updated_at DESC`, ...params);
  const staleIds = new Set(staleListings().map((l) => l.id));
  return {
    listings: rows.map((l) => ({ ...L.decodeListing(l), stale: staleIds.has(l.id), items: L.getItems(l.id).map((i) => enrichItem(i, l)) })),
  };
});

router.get('/api/listings/:id', (ctx) => {
  const l = L.getListing(id(ctx));
  if (!l) throw new HttpError(404, 'Listing not found');
  const pkg = L.listingPackage(l);
  return { listing: { ...L.decodeListing(l), box: pkg.box, items: L.getItems(l.id).map((i) => ({ ...enrichItem(i, l), ...pkg.item(i) })) } };
});

router.post('/api/listings', async ({ body }) => {
  const ids = await L.createDrafts({ productId: body.productId, variantIds: body.variantIds, mode: body.mode, profileId: body.profileId });
  if (ebay.ebayConnected()) {
    enqueue('draft-research', async () => {
      for (const lid of ids) for (const item of L.getItems(lid)) await researchItem(item).catch(() => undefined);
    }).catch(() => undefined);
  }
  return { ids };
});

router.post('/api/listings/bulk', async ({ body }) => {
  const created: number[] = [];
  const errors: { productId: string; error: string }[] = [];
  for (const p of (body?.products ?? []) as { productId: string; variantIds?: string[] }[]) {
    try {
      const ids = await L.createDrafts({ productId: p.productId, variantIds: p.variantIds, mode: body.mode, profileId: body.profileId });
      // Excluded products become "waiting" drafts that publish once the rule stops matching
      created.push(...ids);
    } catch (e) {
      errors.push({ productId: p.productId, error: (e as Error).message });
    }
  }
  if (ebay.ebayConnected()) {
    enqueue('bulk', async () => {
      for (const lid of created) for (const item of L.getItems(lid)) await researchItem(item).catch(() => undefined);
      if (body?.publish) for (const lid of created) await L.publishListing(lid).catch(() => undefined);
    }).catch(() => undefined);
  }
  return { created, errors };
});

router.post('/api/listings/bulk-action', async ({ body }) => {
  const ids: number[] = (body?.ids ?? []).map(Number);
  const action = String(body?.action);
  const results: { id: number; ok: boolean; error?: string }[] = [];
  for (const lid of ids) {
    try {
      if (action === 'publish') await L.publishListing(lid);
      else if (action === 'end') await L.endListing(lid);
      else if (action === 'refresh') await L.refreshFromShopify(lid);
      else if (action === 'research') for (const item of L.getItems(lid)) await researchItem(item);
      else if (action === 'apply-suggestions') for (const item of L.getItems(lid)) applySuggestion(item.id);
      else if (action === 'delete') await L.deleteListing(lid);
      else throw new Error(`Unknown action ${action}`);
      results.push({ id: lid, ok: true });
    } catch (e) {
      results.push({ id: lid, ok: false, error: (e as Error).message });
    }
  }
  return { results };
});

router.put('/api/listings/:id', (ctx) => ({ listing: L.updateListing(id(ctx), ctx.body ?? {}) }));
router.post('/api/listings/:id/validate', async (ctx) => ({ issues: await L.validateListing(id(ctx)) }));
router.post('/api/listings/:id/publish', async (ctx) => ({ listing: await enqueue('publish', () => L.publishListing(id(ctx))) }));
router.post('/api/listings/:id/end', async (ctx) => (await enqueue('end', () => L.endListing(id(ctx))), { ok: true }));
router.post('/api/listings/:id/refresh', async (ctx) => (await L.refreshFromShopify(id(ctx)), { ok: true }));
router.post('/api/listings/:id/research', async (ctx) => {
  for (const item of L.getItems(id(ctx))) await researchItem(item);
  return { ok: true };
});
router.del('/api/listings/:id', async (ctx) => (await L.deleteListing(id(ctx)), { ok: true }));

function applySuggestion(itemId: number) {
  const item = get<L.Item>('SELECT * FROM listing_items WHERE id = ?', itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const snap = latestSnapshot(item.shopify_variant_id);
  if (!snap?.recommended_pct) throw new HttpError(400, 'No price suggestion yet. Run research first.');
  L.updateListing(item.listing_id, { items: [{ id: item.id, markup_pct: snap.recommended_pct, price_locked: false }] });
  return snap.recommended_pct;
}

router.post('/api/items/:id/apply-suggestion', async (ctx) => {
  const pct = applySuggestion(id(ctx));
  enqueue('sync', () => import('./sync.ts').then((m) => m.syncShopifyToEbay())).catch(() => undefined);
  return { ok: true, pct };
});
router.post('/api/items/:id/approve-price', async (ctx) => {
  approveHeldPrice(id(ctx));
  enqueue('sync', () => import('./sync.ts').then((m) => m.syncShopifyToEbay())).catch(() => undefined);
  return { ok: true };
});

// ============ Market research (also for products not yet listed) ============

router.get('/api/market/:variantId', ({ params }) => ({ latest: latestSnapshot(params.variantId), history: snapshotHistory(params.variantId) }));
router.post('/api/market/check', async ({ body }) => {
  const product = await shopify.getProduct(body.productId);
  const variant = product?.variants.nodes.find((v) => v.id === body.variantId) ?? product?.variants.nodes[0];
  if (!product || !variant) throw new HttpError(404, 'Product not found');
  const s = getSettings();
  const rules = { minPct: s.markupMinPct, maxPct: s.markupMaxPct, undercut: s.undercutAmount, charm: s.charmPricing, ownShipping: s.buyerShippingEstimate };
  const base = effectiveBase(Number(variant.price), variant.compareAtPrice ? Number(variant.compareAtPrice) : null, s.useShopifySalePrice);
  await researchVariant({
    variantId: variant.id,
    barcode: variant.barcode,
    brand: L.brandFromVendor(product.vendor, s),
    title: product.title,
    options: Object.fromEntries(variant.selectedOptions.filter((o) => o.value !== 'Default Title').map((o) => [o.name, o.value])),
    basePrice: base,
    rules,
  });
  return { latest: latestSnapshot(variant.id), preview: recommend(base, { activeMin: null, activeMedian: null, soldMedian: null }, rules) };
});

// ============ Orders, reports, activity, jobs ============

router.get('/api/orders', ({ query }) => ({
  orders: all('SELECT * FROM processed_orders ORDER BY COALESCE(ordered_at, processed_at) DESC LIMIT ?', num(query.get('limit'), 200)),
}));

router.get('/api/reports/profit', ({ query }) => {
  const months = num(query.get('months'), 12);
  const s = getSettings();
  const rows = all<{ month: string; sku: string; units: number; revenue: number; fees: number | null; cost: number | null }>(
    `SELECT substr(o.ordered_at,1,7) AS month, o.sku, SUM(o.quantity) AS units, SUM(COALESCE(o.total, o.unit_price * o.quantity)) AS revenue,
            (SELECT SUM(f.fees) FROM finance_lines f WHERE f.line_item_id IN (SELECT line_item_id FROM processed_orders p WHERE p.sku = o.sku AND substr(p.ordered_at,1,7) = substr(o.ordered_at,1,7))) AS fees,
            SUM(o.quantity * (SELECT unit_cost FROM listing_items i WHERE i.sku = o.sku)) AS cost
     FROM processed_orders o WHERE o.status IN ('applied','dry_run') AND o.ordered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
     GROUP BY month, o.sku ORDER BY month`,
    `-${months} months`,
  );
  const otherFees = all<{ month: string; fees: number }>(
    `SELECT substr(transaction_date,1,7) AS month, ROUND(SUM(-amount),2) AS fees FROM finance_lines WHERE transaction_type IN ('NON_SALE_CHARGE','SHIPPING_LABEL') GROUP BY month`,
  );
  const byMonth = new Map<string, { month: string; units: number; revenue: number; fees: number; cost: number; otherFees: number; estimatedFees: boolean }>();
  const bySku = new Map<string, { sku: string; title: string | null; units: number; revenue: number; fees: number; cost: number }>();
  for (const r of rows) {
    const fees = r.fees ?? r.revenue * (s.ebayFeePct / 100) + s.ebayFixedFee * r.units;
    const m = byMonth.get(r.month) ?? { month: r.month, units: 0, revenue: 0, fees: 0, cost: 0, otherFees: 0, estimatedFees: false };
    m.units += r.units;
    m.revenue += r.revenue;
    m.fees += fees;
    m.cost += r.cost ?? 0;
    m.estimatedFees ||= r.fees === null;
    byMonth.set(r.month, m);
    const k = bySku.get(r.sku) ?? { sku: r.sku, title: get<{ title: string }>('SELECT title FROM processed_orders WHERE sku = ? LIMIT 1', r.sku)?.title ?? null, units: 0, revenue: 0, fees: 0, cost: 0 };
    k.units += r.units;
    k.revenue += r.revenue;
    k.fees += fees;
    k.cost += r.cost ?? 0;
    bySku.set(r.sku, k);
  }
  for (const o of otherFees) if (byMonth.has(o.month)) byMonth.get(o.month)!.otherFees = o.fees;
  const round = (n: number) => +n.toFixed(2);
  return {
    months: [...byMonth.values()].map((m) => ({ ...m, revenue: round(m.revenue), fees: round(m.fees), cost: round(m.cost), net: round(m.revenue - m.fees - m.cost - m.otherFees - m.units * s.avgShippingCost) })),
    products: [...bySku.values()]
      .map((p) => ({ ...p, revenue: round(p.revenue), fees: round(p.fees), cost: round(p.cost), net: round(p.revenue - p.fees - p.cost - p.units * s.avgShippingCost) }))
      .sort((a, b) => b.net - a.net),
    stale: staleListings().map((l) => ({ id: l.id, title: l.title, last_sale_at: l.last_sale_at, published_at: l.published_at })),
  };
});

router.get('/api/activity', ({ query }) => {
  const level = query.get('level');
  const before = num(query.get('before'), Number.MAX_SAFE_INTEGER);
  const rows = level
    ? all('SELECT * FROM activity WHERE id < ? AND level = ? ORDER BY id DESC LIMIT ?', before, level, num(query.get('limit'), 100))
    : all('SELECT * FROM activity WHERE id < ? ORDER BY id DESC LIMIT ?', before, num(query.get('limit'), 100));
  return { activity: rows.map((r) => ({ ...r, data: json(r.data, null) })) };
});

router.get('/api/jobs', () => ({ jobs: jobStatus() }));
router.post('/api/jobs/:name/run', async ({ params }) => {
  if (!JOBS[params.name]) throw new HttpError(404, 'Unknown job');
  runJob(params.name).catch(() => undefined);
  return { ok: true };
});

router.get('/api/export/listings.csv', ({ res }) => {
  const rows = all(
    `SELECT l.title, l.status, l.ebay_listing_id, i.sku, i.variant_title, i.shopify_price, i.ebay_price, i.markup_pct, i.shopify_qty, i.ebay_qty, i.unit_cost
     FROM listing_items i JOIN ebay_listings l ON l.id = i.listing_id ORDER BY l.title`,
  );
  const header = ['title', 'status', 'ebay_listing_id', 'sku', 'variant', 'shopify_price', 'ebay_price', 'markup_pct', 'shopify_qty', 'ebay_qty', 'unit_cost'];
  const csv = [header.join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ebay-listings.csv"' });
  res.end(csv);
  return undefined;
});
