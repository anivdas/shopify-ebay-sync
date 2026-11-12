import { ebayConf } from './credentials.ts';
import { all, get, getSettings, json, nowIso, run, tx, type Row, type Settings } from './db.ts';
import * as ebay from './ebay.ts';
import {
  cleanAspects,
  ebayQuantity,
  ebaySku,
  gtinFields,
  inferAspects,
  optionsLabel,
  renderDescription,
  renderTitle,
  stripHtml,
} from './listing-builder.ts';
import { logActivity } from './log.ts';
import { bestOfferThresholds, effectiveBase, priceAtPct, type PricingRules } from './pricing.ts';
import { excludedReasonFor, profileFor, profileRules } from './rules.ts';
import { getBoxes, packageWeightAndSize, resolveBox, toOunces } from './shipping.ts';

const normVendor = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** True for vendors buyers don't search for (e.g. Walmart, Best Buy), from Settings > Templates. */
export const isIgnoredVendor = (vendor: string | null | undefined, settings: Settings) =>
  !!vendor?.trim() &&
  String(settings.ignoredVendors ?? '')
    .split(',')
    .map((v) => normVendor(v))
    .filter(Boolean)
    .includes(normVendor(vendor));

/** The vendor as eBay brand (title + Brand item specific), unless it's an ignored retailer or Vendor isn't the brand. */
export const brandFromVendor = (vendor: string | null | undefined, settings: Settings) =>
  settings.vendorMode === 'brand' && vendor?.trim() && !isIgnoredVendor(vendor, settings) ? vendor.trim() : null;

/** The complete Shopify name (product + variant), shown in the eBay description so nothing is lost when the title is shortened. */
export const fullProductTitle = (productTitle: string, variantTitle: string | null) =>
  variantTitle && variantTitle !== 'Default Title' ? `${productTitle} - ${variantTitle}` : productTitle;
import * as shopify from './shopify.ts';

export type Listing = {
  id: number;
  kind: 'single' | 'group';
  group_key: string | null;
  shopify_product_id: string;
  product_title: string;
  brand: string | null;
  profile_id: number | null;
  title: string;
  category_id: string | null;
  category_name: string | null;
  aspects: string;
  description_html: string;
  image_urls: string;
  condition: string;
  varies_by: string;
  fulfillment_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  merchant_location_key: string | null;
  best_offer_enabled: number;
  box_id: string | null;
  excluded_reason: string | null;
  auto_publish: number;
  full_title: string | null;
  locked_fields: string;
  ebay_listing_id: string | null;
  status: string;
  last_error: string | null;
  last_sale_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Item = {
  id: number;
  listing_id: number;
  shopify_variant_id: string;
  shopify_inventory_item_id: string | null;
  sku: string;
  variant_title: string | null;
  options: string;
  barcode: string | null;
  mpn: string | null;
  image_url: string | null;
  offer_id: string | null;
  shopify_price: number | null;
  shopify_compare_at: number | null;
  shopify_qty: number | null;
  shopify_status: string | null;
  inventory_tracked: number;
  unit_cost: number | null;
  weight_value: number | null;
  weight_unit: string | null;
  ebay_price: number | null;
  ebay_qty: number | null;
  markup_pct: number | null;
  price_locked: number;
  manual_price: number | null;
  held_price: number | null;
  held_reason: string | null;
  last_synced_at: string | null;
  last_error: string | null;
};

export type Profile = {
  id: number;
  name: string;
  category_id: string | null;
  category_name: string | null;
  fulfillment_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  merchant_location_key: string | null;
  title_template: string | null;
  description_template: string | null;
  default_aspects: string;
  best_offer_enabled: number | null;
  markup_min_pct: number | null;
  markup_max_pct: number | null;
  box_id: string | null;
};

export const getListing = (id: number) => get<Listing>('SELECT * FROM ebay_listings WHERE id = ?', id);
export const getItems = (listingId: number) => all<Item>('SELECT * FROM listing_items WHERE listing_id = ? ORDER BY id', listingId);
export const getProfile = (id: number | null | undefined) => (id ? get<Profile>('SELECT * FROM profiles WHERE id = ?', id) : undefined);
export const listProfiles = () => all<Profile>('SELECT * FROM profiles ORDER BY name');

export function rulesFor(listing: Pick<Listing, 'profile_id'>, settings: Settings = getSettings()): PricingRules {
  const profile = getProfile(listing.profile_id);
  return {
    minPct: profile?.markup_min_pct ?? settings.markupMinPct,
    maxPct: profile?.markup_max_pct ?? settings.markupMaxPct,
    undercut: settings.undercutAmount,
    charm: settings.charmPricing,
    ownShipping: settings.buyerShippingEstimate,
  };
}

/** The price this item should have on eBay right now (before safety guards). */
export function targetPrice(item: Item, rules: PricingRules, settings: Settings): number | null {
  if (item.shopify_price === null) return null;
  if (item.price_locked && item.manual_price) return item.manual_price;
  const base = effectiveBase(item.shopify_price, item.shopify_compare_at, settings.useShopifySalePrice);
  const pct = item.markup_pct ?? (rules.minPct + rules.maxPct) / 2;
  return priceAtPct(base, pct, rules);
}

export function targetQuantity(item: Item, settings: Settings): number {
  return ebayQuantity(item.shopify_qty, {
    tracked: !!item.inventory_tracked,
    active: item.shopify_status === 'ACTIVE',
    buffer: settings.quantityBuffer,
    max: settings.maxListQuantity,
    minToList: settings.minShopifyQtyToList,
  });
}

// ---------------- Profiles ----------------

const PROFILE_FIELDS = [
  'name',
  'category_id',
  'category_name',
  'fulfillment_policy_id',
  'payment_policy_id',
  'return_policy_id',
  'merchant_location_key',
  'title_template',
  'description_template',
  'default_aspects',
  'best_offer_enabled',
  'markup_min_pct',
  'markup_max_pct',
  'box_id',
] as const;

export function saveProfile(input: Partial<Profile> & { name: string }, id?: number): Profile {
  const values = PROFILE_FIELDS.map((f) => {
    const v = (input as Record<string, unknown>)[f];
    if (f === 'default_aspects') return JSON.stringify(cleanAspects(typeof v === 'string' ? json(v, {}) : ((v as Record<string, unknown>) ?? {})));
    return v === '' || v === undefined ? null : (v as any);
  });
  if (id) {
    run(`UPDATE profiles SET ${PROFILE_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...values, id);
    return getProfile(id)!;
  }
  const res = run(`INSERT INTO profiles (${PROFILE_FIELDS.join(', ')}) VALUES (${PROFILE_FIELDS.map(() => '?').join(', ')})`, ...values);
  return getProfile(Number(res.lastInsertRowid))!;
}

export const deleteProfile = (id: number) => run('DELETE FROM profiles WHERE id = ?', id);

// ---------------- Drafts ----------------

export type DraftMode = 'auto' | 'group' | 'separate';

function itemFromVariant(v: shopify.ShopifyVariant) {
  const options = Object.fromEntries(v.selectedOptions.filter((o) => o.value !== 'Default Title').map((o) => [o.name, o.value]));
  return {
    shopify_variant_id: v.id,
    shopify_inventory_item_id: v.inventoryItem.id,
    sku: ebaySku(v.sku, shopify.numericId(v.id)),
    variant_title: v.title === 'Default Title' ? null : v.title,
    options,
    barcode: v.barcode || null,
    image_url: v.image?.url ?? null,
    shopify_price: Number(v.price),
    shopify_compare_at: v.compareAtPrice ? Number(v.compareAtPrice) : null,
    shopify_qty: v.inventoryQuantity ?? 0,
    inventory_tracked: v.inventoryItem.tracked ? 1 : 0,
    unit_cost: v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) : null,
    weight_value: v.inventoryItem.measurement?.weight?.value ?? null,
    weight_unit: v.inventoryItem.measurement?.weight?.unit ?? null,
  };
}

function uniqueSku(sku: string, variantGid: string): string {
  const clash = get<{ shopify_variant_id: string }>('SELECT shopify_variant_id FROM listing_items WHERE sku = ?', sku);
  return clash && clash.shopify_variant_id !== variantGid ? `SHV-${shopify.numericId(variantGid)}` : sku;
}

async function defaultCategory(product: shopify.ShopifyProduct) {
  try {
    const [top] = await ebay.suggestCategories(`${product.title} ${product.productType}`.trim());
    return top ? { id: top.id, name: top.path } : null;
  } catch {
    return null;
  }
}

/**
 * Creates draft eBay listing(s) for a Shopify product.
 * - auto: products with several selected variants become one multi-variation listing
 * - separate: every selected variant becomes its own listing
 */
export async function createDrafts(opts: { productId: string; variantIds?: string[]; mode?: DraftMode; profileId?: number | null }): Promise<number[]> {
  const settings = getSettings();
  const product = await shopify.getProduct(opts.productId);
  if (!product) throw new Error('Shopify product not found');
  const ruleProduct = { id: product.id, title: product.title, tags: product.tags, productType: product.productType, vendor: product.vendor, collections: product.collections };
  const profile = getProfile(opts.profileId ?? profileFor(ruleProduct, profileRules(settings)));
  const excluded = excludedReasonFor(ruleProduct, settings);
  let variants = product.variants.nodes;
  if (opts.variantIds?.length) variants = variants.filter((v) => opts.variantIds!.includes(v.id));
  const taken = new Set(all<{ shopify_variant_id: string }>('SELECT shopify_variant_id FROM listing_items').map((r) => r.shopify_variant_id));
  variants = variants.filter((v) => !taken.has(v.id));
  if (!variants.length) throw new Error('All selected variants are already linked to an eBay listing');

  const category = profile?.category_id ? { id: profile.category_id, name: profile.category_name ?? '' } : await defaultCategory(product);
  const images = (product.media?.nodes ?? []).map((m) => m.image?.url).filter((u): u is string => !!u).slice(0, 24);
  const optionNames = (product.options ?? []).map((o) => o.name).filter((n) => n !== 'Title');
  const asGroup = opts.mode !== 'separate' && variants.length > 1 && optionNames.length > 0;
  const groups = asGroup ? [variants] : variants.map((v) => [v]);
  const ids: number[] = [];

  for (const groupVariants of groups) {
    const first = itemFromVariant(groupVariants[0]);
    const aspects: Record<string, string[]> = { ...json<Record<string, string[]>>(profile?.default_aspects, {}) };
    const brand = brandFromVendor(product.vendor, settings);
    if (brand) aspects.Brand = [brand];
    else if (settings.vendorMode === 'aspect' && product.vendor?.trim() && !isIgnoredVendor(product.vendor, settings) && settings.vendorAspectName.trim())
      aspects[settings.vendorAspectName.trim()] = [product.vendor.trim()];
    if (product.productType && !aspects.Type) aspects.Type = [product.productType];
    if (!asGroup) {
      for (const [k, v] of Object.entries(first.options)) aspects[k] = [v];
      const gtin = gtinFields(first.barcode);
      if (gtin.aspect) aspects[gtin.aspect[0]] = [gtin.aspect[1]];
    }
    if (category?.id) {
      const defs = await ebay.getAspects(category.id).catch(() => []);
      Object.assign(aspects, inferAspects({ title: product.title, description: stripHtml(product.descriptionHtml ?? ''), brand }, defs, aspects));
    }
    const fullTitle = fullProductTitle(product.title, asGroup ? null : first.variant_title);
    const title = renderTitle(profile?.title_template || settings.titleTemplate, {
      brand,
      title: product.title,
      options: asGroup ? '' : optionsLabel(first.options),
      productType: product.productType,
      sku: first.sku,
    });
    const description = renderDescription(profile?.description_template || settings.descriptionTemplate, {
      title: product.title,
      fullTitle,
      showFullTitle: settings.showFullTitleInDescription,
      keepFormatting: settings.keepDescriptionFormatting,
      description: product.descriptionHtml ?? '',
    });
    const varyingOptions = asGroup ? optionNames.filter((n) => new Set(groupVariants.map((v) => v.selectedOptions.find((o) => o.name === n)?.value)).size > 1) : [];
    const groupKey = asGroup ? `SHP-${shopify.numericId(product.id)}` : null;
    const listingImages = images.length ? images : [first.image_url].filter((u): u is string => !!u);

    const listingId = tx(() => {
      const res = run(
        `INSERT INTO ebay_listings (kind, group_key, shopify_product_id, product_title, brand, profile_id, title, category_id, category_name,
           aspects, description_html, image_urls, varies_by, fulfillment_policy_id, payment_policy_id, return_policy_id, merchant_location_key, best_offer_enabled, box_id,
           full_title, excluded_reason, auto_publish)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        asGroup ? 'group' : 'single',
        groupKey,
        product.id,
        product.title,
        brand,
        profile?.id ?? null,
        title,
        category?.id ?? null,
        category?.name ?? null,
        JSON.stringify(cleanAspects(aspects)),
        description,
        JSON.stringify(listingImages),
        JSON.stringify(varyingOptions),
        profile?.fulfillment_policy_id || settings.fulfillmentPolicyId || null,
        profile?.payment_policy_id || settings.paymentPolicyId || null,
        profile?.return_policy_id || settings.returnPolicyId || null,
        profile?.merchant_location_key || settings.merchantLocationKey || null,
        !asGroup && (profile?.best_offer_enabled ?? (settings.bestOfferDefault ? 1 : 0)) ? 1 : 0,
        profile?.box_id || null,
        fullTitle,
        excluded,
        excluded ? 1 : 0,
      );
      const id = Number(res.lastInsertRowid);
      for (const v of groupVariants) {
        const it = itemFromVariant(v);
        run(
          `INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, variant_title, options, barcode, image_url,
             shopify_price, shopify_compare_at, shopify_qty, shopify_status, inventory_tracked, unit_cost, weight_value, weight_unit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          it.shopify_variant_id,
          it.shopify_inventory_item_id,
          uniqueSku(it.sku, it.shopify_variant_id),
          it.variant_title,
          JSON.stringify(it.options),
          it.barcode,
          it.image_url,
          it.shopify_price,
          it.shopify_compare_at,
          it.shopify_qty,
          product.status,
          it.inventory_tracked,
          it.unit_cost,
          it.weight_value,
          it.weight_unit,
        );
      }
      return id;
    });
    ids.push(listingId);
    logActivity('info', 'listing.draft', `Draft created: ${title}${excluded ? ` (waiting: ${excluded}; publishes automatically once that changes)` : ''}`, { listingId, variants: groupVariants.length });
  }
  return ids;
}

const LISTING_EDITABLE = [
  'title',
  'category_id',
  'category_name',
  'aspects',
  'description_html',
  'image_urls',
  'condition',
  'varies_by',
  'fulfillment_policy_id',
  'payment_policy_id',
  'return_policy_id',
  'merchant_location_key',
  'best_offer_enabled',
  'locked_fields',
  'profile_id',
  'box_id',
] as const;

export function updateListing(id: number, patch: Record<string, unknown>) {
  const listing = getListing(id);
  if (!listing) throw new Error('Listing not found');
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of LISTING_EDITABLE) {
    if (!(f in patch)) continue;
    let v = patch[f];
    if (f === 'aspects') v = JSON.stringify(cleanAspects(typeof v === 'string' ? json(v, {}) : (v as Record<string, unknown>)));
    else if (f === 'image_urls' || f === 'varies_by' || f === 'locked_fields') v = JSON.stringify(Array.isArray(v) ? v : json(String(v), []));
    else if (f === 'best_offer_enabled') v = v && listing.kind === 'single' ? 1 : 0;
    else if (f === 'title') v = String(v).slice(0, 80);
    sets.push(`${f} = ?`);
    vals.push(v === '' ? null : v);
  }
  if (Array.isArray(patch.items)) {
    for (const p of patch.items as Record<string, unknown>[]) {
      const item = get<Item>('SELECT * FROM listing_items WHERE id = ? AND listing_id = ?', p.id, id);
      if (!item) continue;
      if ('price_locked' in p) run('UPDATE listing_items SET price_locked = ? WHERE id = ?', p.price_locked ? 1 : 0, item.id);
      if ('manual_price' in p) run('UPDATE listing_items SET manual_price = ? WHERE id = ?', p.manual_price ? Number(p.manual_price) : null, item.id);
      if ('markup_pct' in p && p.markup_pct !== null && p.markup_pct !== '') run('UPDATE listing_items SET markup_pct = ? WHERE id = ?', Number(p.markup_pct), item.id);
      if ('mpn' in p) run('UPDATE listing_items SET mpn = ? WHERE id = ?', p.mpn || null, item.id);
      if ('sku' in p && listing.status === 'draft' && p.sku) run('UPDATE listing_items SET sku = ? WHERE id = ?', String(p.sku).slice(0, 50), item.id);
    }
  }
  if (sets.length) run(`UPDATE ebay_listings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
  return getListing(id)!;
}

/** Re-pulls content and price/stock from Shopify, keeping any fields the user locked. */
export async function refreshFromShopify(id: number) {
  const listing = getListing(id);
  if (!listing) throw new Error('Listing not found');
  const product = await shopify.getProduct(listing.shopify_product_id);
  if (!product) throw new Error('The Shopify product no longer exists');
  const settings = getSettings();
  const profile = getProfile(listing.profile_id);
  const locked = new Set(json<string[]>(listing.locked_fields, []));
  const items = getItems(id);
  const patch: Record<string, unknown> = {};
  if (!locked.has('title')) {
    const first = items[0] ? json<Record<string, string>>(items[0].options, {}) : {};
    patch.title = renderTitle(profile?.title_template || settings.titleTemplate, {
      brand: brandFromVendor(product.vendor, settings),
      title: product.title,
      options: listing.kind === 'group' ? '' : optionsLabel(first),
      productType: product.productType,
      sku: items[0]?.sku,
    });
  }
  const fullTitle = fullProductTitle(product.title, listing.kind === 'group' ? null : items[0]?.variant_title ?? null);
  if (!locked.has('description'))
    patch.description_html = renderDescription(profile?.description_template || settings.descriptionTemplate, {
      title: product.title,
      fullTitle,
      showFullTitle: settings.showFullTitleInDescription,
      keepFormatting: settings.keepDescriptionFormatting,
      description: product.descriptionHtml ?? '',
    });
  const excluded = excludedReasonFor(
    { id: product.id, title: product.title, tags: product.tags, productType: product.productType, vendor: product.vendor, collections: product.collections },
    settings,
  );
  run('UPDATE ebay_listings SET full_title = ?, excluded_reason = ? WHERE id = ?', fullTitle, excluded, id);
  if (!locked.has('images')) {
    const imgs = (product.media?.nodes ?? []).map((m) => m.image?.url).filter(Boolean).slice(0, 24);
    if (imgs.length) patch.image_urls = imgs;
  }
  updateListing(id, patch);
  for (const item of items) {
    const v = product.variants.nodes.find((x) => x.id === item.shopify_variant_id);
    if (!v) {
      run(`UPDATE listing_items SET shopify_status = 'DELETED' WHERE id = ?`, item.id);
      continue;
    }
    const it = itemFromVariant(v);
    run(
      `UPDATE listing_items SET shopify_price = ?, shopify_compare_at = ?, shopify_qty = ?, shopify_status = ?, inventory_tracked = ?, unit_cost = ?,
         barcode = ?, image_url = ?, options = ?, variant_title = ?, weight_value = ?, weight_unit = ? WHERE id = ?`,
      it.shopify_price,
      it.shopify_compare_at,
      it.shopify_qty,
      product.status,
      it.inventory_tracked,
      it.unit_cost,
      it.barcode,
      it.image_url,
      JSON.stringify(it.options),
      it.variant_title,
      it.weight_value,
      it.weight_unit,
      item.id,
    );
  }
  run('UPDATE ebay_listings SET product_title = ?, brand = ? WHERE id = ?', product.title, brandFromVendor(product.vendor, settings), id);
}

// ---------------- Validation ----------------

export type Issue = { level: 'error' | 'warning'; field: string; message: string };

export async function validateListing(id: number): Promise<Issue[]> {
  const listing = getListing(id);
  if (!listing) throw new Error('Listing not found');
  const items = getItems(id);
  const settings = getSettings();
  const issues: Issue[] = [];
  const err = (field: string, message: string) => issues.push({ level: 'error', field, message });
  const warn = (field: string, message: string) => issues.push({ level: 'warning', field, message });

  if (listing.excluded_reason)
    warn('excluded', `Excluded by your rules (${listing.excluded_reason}). It will publish automatically once that no longer applies.`);
  if (!listing.title.trim()) err('title', 'Title is required');
  if (listing.title.length > 80) err('title', 'Title must be 80 characters or fewer');
  if (!listing.category_id) err('category_id', 'Choose an eBay category');
  if (!listing.fulfillment_policy_id && !settings.fulfillmentPolicyId) err('fulfillment_policy_id', 'Choose a shipping (fulfillment) policy');
  if (!listing.payment_policy_id && !settings.paymentPolicyId) err('payment_policy_id', 'Choose a payment policy');
  if (!listing.return_policy_id && !settings.returnPolicyId) err('return_policy_id', 'Choose a return policy');
  if (!listing.merchant_location_key && !settings.merchantLocationKey) err('merchant_location_key', 'Choose an inventory location (Settings > eBay defaults)');
  const images = json<string[]>(listing.image_urls, []);
  if (!images.length) err('image_urls', 'At least one image is required');
  if (images.some((u) => !u.startsWith('https://'))) err('image_urls', 'All image URLs must use https');
  if (!listing.description_html.trim()) warn('description_html', 'Description is empty');
  if (!items.length) err('items', 'Listing has no variants');

  const aspects = json<Record<string, string[]>>(listing.aspects, {});
  const varies = json<string[]>(listing.varies_by, []);
  if (listing.category_id) {
    try {
      const defs = await ebay.getAspects(listing.category_id);
      for (const a of defs.filter((d) => d.required)) {
        const coveredByVariation = listing.kind === 'group' && varies.includes(a.name);
        const coveredByItems = items.every((i) => json<Record<string, string>>(i.options, {})[a.name]);
        if (!aspects[a.name]?.length && !coveredByVariation && !coveredByItems) err(`aspects.${a.name}`, `Item specific "${a.name}" is required for this category`);
      }
      for (const a of defs.filter((d) => d.recommended && !d.required).slice(0, 8)) {
        if (!aspects[a.name]?.length) warn(`aspects.${a.name}`, `Recommended item specific "${a.name}" is missing (helps search ranking)`);
      }
      if (listing.kind === 'group') {
        for (const name of varies) {
          const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
          if (def && !def.variationAllowed) err('varies_by', `"${name}" can't be used as a variation in this category`);
        }
      }
    } catch (e) {
      warn('aspects', `Could not load item specifics for the category: ${(e as Error).message}`);
    }
  }
  if (listing.kind === 'group') {
    if (!varies.length) err('varies_by', 'Multi-variation listing needs at least one varying option (e.g. Size, Color)');
    if (items.length > 250) err('items', 'eBay allows at most 250 variations per listing');
    const combos = new Set(items.map((i) => varies.map((n) => json<Record<string, string>>(i.options, {})[n]).join('|')));
    if (combos.size !== items.length) err('varies_by', 'Two variants have the same option values; eBay needs each variation to be unique');
  }
  const box = resolveBox(settings, listing.box_id, getProfile(listing.profile_id)?.box_id);
  if (!box)
    warn(
      'box_id',
      getBoxes(settings).length
        ? 'No package size chosen. Calculated shipping needs box dimensions (pick one under Policies & options).'
        : 'No shipping boxes set up yet (Settings > Shipping). Calculated shipping policies need box dimensions.',
    );
  const rules = rulesFor(listing, settings);
  for (const item of items) {
    if (toOunces(item.weight_value, item.weight_unit) <= 0) warn(`items.${item.id}`, `${item.variant_title ?? item.sku}: no weight in Shopify (needed for calculated shipping)`);
    const price = targetPrice(item, rules, settings);
    if (!price || price <= 0) err(`items.${item.id}`, `${item.variant_title ?? item.sku}: price is missing`);
    if (item.shopify_status && item.shopify_status !== 'ACTIVE') warn(`items.${item.id}`, `${item.variant_title ?? item.sku}: Shopify product is ${item.shopify_status.toLowerCase()} (will list with 0 quantity)`);
    if (item.unit_cost === null) warn(`items.${item.id}`, `${item.variant_title ?? item.sku}: no cost in Shopify, profit can't be calculated`);
    if (!gtinFields(item.barcode).aspect) warn(`items.${item.id}`, `${item.variant_title ?? item.sku}: no UPC/EAN barcode - price research will use a less exact title search`);
  }
  return issues;
}

// ---------------- Publish / end ----------------

function inventoryPayload(listing: Listing, item: Item, qty: number, settings: Settings): ebay.InventoryItemPayload {
  const box = resolveBox(settings, listing.box_id, getProfile(listing.profile_id)?.box_id);
  const pkg = packageWeightAndSize(box, toOunces(item.weight_value, item.weight_unit), ebayConf().marketplaceId);
  const shared = json<Record<string, string[]>>(listing.aspects, {});
  const opts = json<Record<string, string>>(item.options, {});
  const aspects: Record<string, string[]> = { ...shared };
  for (const [k, v] of Object.entries(opts)) aspects[k] = [v];
  const gtin = gtinFields(item.barcode);
  if (gtin.aspect) aspects[gtin.aspect[0]] = [gtin.aspect[1]];
  const images = json<string[]>(listing.image_urls, []);
  const itemImages = listing.kind === 'group' ? [item.image_url ?? images[0]].filter(Boolean) : images;
  const brand = listing.brand ?? shared.Brand?.[0];
  // eBay rejects a brand without an MPN ("BrandMPN is invalid or missing"); media etc. have no part number.
  const mpn = item.mpn || shared.MPN?.[0] || (brand ? MPN_NOT_APPLICABLE : undefined);
  return {
    availability: { shipToLocationAvailability: { quantity: qty } },
    condition: listing.condition || 'NEW',
    ...(pkg ? { packageWeightAndSize: pkg } : {}),
    product: {
      title: listing.title,
      description: stripHtml(listing.description_html).slice(0, 3990),
      aspects: cleanAspects(aspects),
      imageUrls: itemImages as string[],
      brand,
      mpn,
      ...(gtin.upc ? { upc: gtin.upc } : {}),
      ...(gtin.ean ? { ean: gtin.ean } : {}),
    },
  };
}

export const MPN_NOT_APPLICABLE = 'Does not apply';

export function offerPayload(listing: Listing, item: Item, price: number, qty: number, settings: Settings): ebay.OfferPayload {
  const conf = ebayConf();
  const money = (v: number) => ({ value: v.toFixed(2), currency: conf.currency });
  const offer: ebay.OfferPayload = {
    sku: item.sku,
    marketplaceId: conf.marketplaceId,
    format: 'FIXED_PRICE',
    availableQuantity: qty,
    categoryId: listing.category_id!,
    merchantLocationKey: (listing.merchant_location_key || settings.merchantLocationKey)!,
    pricingSummary: { price: money(price) },
    listingPolicies: {
      fulfillmentPolicyId: (listing.fulfillment_policy_id || settings.fulfillmentPolicyId)!,
      paymentPolicyId: (listing.payment_policy_id || settings.paymentPolicyId)!,
      returnPolicyId: (listing.return_policy_id || settings.returnPolicyId)!,
    },
  };
  if (listing.kind === 'single') offer.listingDescription = listing.description_html;
  if (listing.kind === 'single' && listing.best_offer_enabled && item.shopify_price) {
    const base = effectiveBase(item.shopify_price, item.shopify_compare_at, settings.useShopifySalePrice);
    const t = bestOfferThresholds(price, base, rulesFor(listing, settings), settings.bestOfferAutoAcceptPct, settings.bestOfferAutoDecline);
    offer.listingPolicies.bestOfferTerms = {
      bestOfferEnabled: true,
      ...(t.autoAccept ? { autoAcceptPrice: money(t.autoAccept) } : {}),
      ...(t.autoDecline ? { autoDeclinePrice: money(t.autoDecline) } : {}),
    };
  }
  return offer;
}

function groupPayload(listing: Listing, items: Item[]): ebay.ItemGroupPayload {
  const varies = json<string[]>(listing.varies_by, []);
  const specs = varies.map((name) => ({
    name,
    values: [...new Set(items.map((i) => json<Record<string, string>>(i.options, {})[name]).filter(Boolean))],
  }));
  const imageAspect = varies.find((n) => /colou?r/i.test(n)) ?? null;
  const hasVariantImages = new Set(items.map((i) => i.image_url).filter(Boolean)).size > 1;
  return {
    title: listing.title,
    description: listing.description_html,
    imageUrls: json<string[]>(listing.image_urls, []).slice(0, 24),
    aspects: Object.fromEntries(Object.entries(json<Record<string, string[]>>(listing.aspects, {})).filter(([k]) => !varies.includes(k))),
    variantSKUs: items.map((i) => i.sku),
    variesBy: { specifications: specs, ...(imageAspect && hasVariantImages ? { aspectsImageVariesBy: [imageAspect] } : {}) },
  };
}

/** Pushes the full listing (content + offers) to eBay and publishes it. Safe to call repeatedly. */
export async function publishListing(id: number, opts: { skipValidation?: boolean } = {}) {
  const listing = getListing(id);
  if (!listing) throw new Error('Listing not found');
  if (listing.excluded_reason) {
    run('UPDATE ebay_listings SET auto_publish = 1 WHERE id = ?', id);
    throw new Error(`Not published: ${listing.excluded_reason} (exclusion rule). It will publish automatically when that changes in Shopify.`);
  }
  if (!opts.skipValidation) {
    const errors = (await validateListing(id)).filter((i) => i.level === 'error');
    if (errors.length) throw new Error(`Fix these first: ${errors.map((e) => e.message).join('; ')}`);
  }
  const settings = getSettings();
  if (settings.dryRun) {
    logActivity('warn', 'listing.dryrun', `Dry-run mode: would publish "${listing.title}"`);
    return getListing(id)!;
  }
  const items = getItems(id);
  const rules = rulesFor(listing, settings);
  try {
    // Order matters for eBay: inventory items -> (item group) -> offers -> publish
    for (const item of items) await ebay.putInventoryItem(item.sku, inventoryPayload(listing, item, targetQuantity(item, settings), settings));
    if (listing.kind === 'group') await ebay.putItemGroup(listing.group_key!, groupPayload(listing, items));
    for (const item of items) {
      const qty = targetQuantity(item, settings);
      const price = targetPrice(item, rules, settings)!;
      const offerId = await ebay.upsertOffer(offerPayload(listing, item, price, qty, settings), item.offer_id);
      run('UPDATE listing_items SET offer_id = ?, ebay_price = ?, ebay_qty = ?, last_synced_at = ?, last_error = NULL WHERE id = ?', offerId, price, qty, nowIso(), item.id);
    }
    let listingId: string;
    if (listing.kind === 'group') {
      listingId = (await ebay.publishGroup(listing.group_key!)).listingId;
    } else {
      const offerId = get<{ offer_id: string }>('SELECT offer_id FROM listing_items WHERE listing_id = ?', id)!.offer_id;
      listingId = (await ebay.publishOffer(offerId)).listingId;
    }
    const totalQty = items.reduce((s, i) => s + targetQuantity(i, settings), 0);
    run(
      `UPDATE ebay_listings SET ebay_listing_id = ?, status = ?, last_error = NULL, auto_publish = 0, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`,
      listingId,
      totalQty > 0 ? 'published' : 'out_of_stock',
      nowIso(),
      nowIso(),
      id,
    );
    logActivity('success', 'listing.published', `Published "${listing.title}" (eBay item ${listingId})`, { listingId, id });
  } catch (e) {
    const message = (e as Error).message;
    run(`UPDATE ebay_listings SET status = CASE WHEN ebay_listing_id IS NULL THEN 'error' ELSE status END, last_error = ?, updated_at = ? WHERE id = ?`, message, nowIso(), id);
    logActivity('error', 'listing.publish', `Publishing "${listing.title}" failed: ${message}`, { id });
    throw e;
  }
  return getListing(id)!;
}

export async function endListing(id: number) {
  const listing = getListing(id);
  if (!listing) throw new Error('Listing not found');
  if (!getSettings().dryRun) {
    if (listing.kind === 'group' && listing.group_key) await ebay.withdrawGroup(listing.group_key);
    else for (const item of getItems(id)) if (item.offer_id) await ebay.withdrawOffer(item.offer_id);
  }
  run(`UPDATE ebay_listings SET status = 'ended', updated_at = ? WHERE id = ?`, nowIso(), id);
  logActivity('info', 'listing.ended', `Ended "${listing.title}" on eBay`, { id });
}

/** Removes the listing from this app; if it was ever on eBay its inventory records there are deleted too. */
export async function deleteListing(id: number) {
  const listing = getListing(id);
  if (!listing) return;
  if (['published', 'out_of_stock'].includes(listing.status)) throw new Error('End the listing on eBay before deleting it');
  const items = getItems(id);
  if (items.some((i) => i.offer_id)) {
    for (const item of items) await ebay.deleteInventoryItem(item.sku).catch(() => undefined);
    if (listing.group_key) await ebay.deleteItemGroup(listing.group_key).catch(() => undefined);
  }
  run('DELETE FROM ebay_listings WHERE id = ?', id);
  logActivity('info', 'listing.deleted', `Removed "${listing.title}" from the app`, { id });
}

export function listingWithItems(id: number) {
  const listing = getListing(id);
  if (!listing) return null;
  return { ...decodeListing(listing), items: getItems(id).map(decodeItem) };
}

/** The box and per-item package eBay gets for calculated shipping (same code as publishing), for display. */
export function listingPackage(listing: Listing, settings = getSettings()) {
  const box = resolveBox(settings, listing.box_id, getProfile(listing.profile_id)?.box_id);
  return {
    box,
    item: (i: Item) => {
      const productOz = toOunces(i.weight_value, i.weight_unit);
      return { product_oz: productOz, package: packageWeightAndSize(box, productOz, ebayConf().marketplaceId) ?? null };
    },
  };
}

export const decodeListing = (l: Listing | Row) => ({
  ...l,
  aspects: json(l.aspects, {}),
  image_urls: json(l.image_urls, []),
  varies_by: json(l.varies_by, []),
  locked_fields: json(l.locked_fields, []),
  best_offer_enabled: !!l.best_offer_enabled,
  ebay_url: l.ebay_listing_id ? ebay.listingUrl(l.ebay_listing_id) : null,
  shopify_url: shopify.adminProductUrl(l.shopify_product_id),
});

export const decodeItem = (i: Item | Row) => ({ ...i, options: json(i.options, {}), price_locked: !!i.price_locked, inventory_tracked: !!i.inventory_tracked });
