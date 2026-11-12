import { all, get, getSettings, json, run, type Row } from './db.ts';
import * as ebay from './ebay.ts';
import { gtinFields, optionsLabel } from './listing-builder.ts';
import { rulesFor, type Item } from './listings.ts';
import { logActivity } from './log.ts';
import { effectiveBase, recommend, stats, type PricingRules } from './pricing.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ResearchInput = {
  variantId: string;
  barcode: string | null;
  brand: string | null;
  title: string;
  options: Record<string, string>;
  categoryId?: string | null;
  basePrice: number;
  rules: PricingRules;
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** For title searches: a comp must mention the brand and every model-number-like token. */
export function titleMatches(compTitle: string, brand: string | null, title: string): boolean {
  const comp = ` ${normalize(compTitle)} `;
  if (brand && !comp.includes(` ${normalize(brand)} `)) return false;
  const modelTokens = normalize(title)
    .split(' ')
    .filter((t) => t.length >= 3 && /\d/.test(t) && /[a-z]/.test(t));
  return modelTokens.every((t) => comp.includes(` ${t} `) || comp.replace(/ /g, '').includes(t));
}

export async function researchVariant(input: ResearchInput) {
  const settings = getSettings();
  const gtin = gtinFields(input.barcode).aspect?.[1];
  const query = `${input.brand && !input.title.toLowerCase().includes(input.brand.toLowerCase()) ? input.brand + ' ' : ''}${input.title} ${optionsLabel(input.options)}`.trim();
  const excludeSeller = settings.ebayUsername || undefined;
  const zip = settings.comparisonZip || undefined;

  let matchType = 'gtin';
  let active = gtin ? await ebay.searchActive({ gtin, excludeSeller, zip }) : { total: 0, items: [] as ebay.ActiveComp[] };
  if (!active.items.length) {
    matchType = 'title';
    const res = await ebay.searchActive({ q: query, excludeSeller, categoryId: input.categoryId ?? undefined, zip });
    active = { total: res.total, items: res.items.filter((i) => titleMatches(i.title, input.brand, input.title)) };
  }

  const since = Date.now() - settings.soldLookbackDays * 86400_000;
  let soldRaw = gtin ? await ebay.searchSold({ gtin }) : null;
  if (soldRaw !== null && !soldRaw.length) soldRaw = await ebay.searchSold({ q: query, categoryId: input.categoryId ?? undefined });
  const soldAvailable = soldRaw !== null;
  const sold = (soldRaw ?? [])
    .filter((s) => new Date(s.lastSoldDate).getTime() >= since)
    .filter((s) => matchType === 'gtin' || titleMatches(s.title, input.brand, input.title));

  const a = stats(active.items.map((i) => i.total));
  const s = stats(sold.map((i) => i.price));
  const rec = recommend(input.basePrice, { activeMin: a.min, activeMedian: a.median, soldMedian: s.median }, input.rules);

  const comps = [
    ...[...active.items].sort((x, y) => x.total - y.total).slice(0, 12).map((c) => ({ type: 'active', ...c })),
    ...[...sold].sort((x, y) => y.lastSoldDate.localeCompare(x.lastSoldDate)).slice(0, 12).map((c) => ({ type: 'sold', ...c })),
  ];
  const prev = get<{ reason: string; recommended_price: number }>(
    'SELECT reason, recommended_price FROM market_snapshots WHERE shopify_variant_id = ? ORDER BY taken_at DESC LIMIT 1',
    input.variantId,
  );
  run(
    `INSERT INTO market_snapshots (shopify_variant_id, match_type, query, active_count, active_min, active_median, active_avg,
       sold_available, sold_count, sold_qty, sold_min, sold_median, sold_avg, base_price, recommended_price, recommended_pct, reason, comps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.variantId,
    matchType,
    matchType === 'gtin' ? gtin : query,
    active.items.length,
    a.min,
    a.median,
    a.avg,
    soldAvailable ? 1 : 0,
    sold.length,
    sold.reduce((n, x) => n + x.soldQty, 0),
    s.min,
    s.median,
    s.avg,
    input.basePrice,
    rec.price,
    rec.pct,
    `${rec.position}|${rec.reason}`,
    JSON.stringify(comps),
  );
  return { rec, prevPosition: prev?.reason.split('|')[0] ?? null };
}

export async function researchItem(item: Item) {
  const settings = getSettings();
  const listing = get<{ id: number; product_title: string; brand: string | null; category_id: string | null; profile_id: number | null; title: string }>(
    'SELECT id, product_title, brand, category_id, profile_id, title FROM ebay_listings WHERE id = ?',
    item.listing_id,
  );
  if (!listing || item.shopify_price === null) return null;
  const rules = rulesFor(listing, settings);
  const base = effectiveBase(item.shopify_price, item.shopify_compare_at, settings.useShopifySalePrice);
  const { rec, prevPosition } = await researchVariant({
    variantId: item.shopify_variant_id,
    barcode: item.barcode,
    brand: listing.brand,
    title: listing.product_title,
    options: json(item.options, {}),
    categoryId: listing.category_id,
    basePrice: base,
    rules,
  });
  if (settings.autoReprice && !item.price_locked) run('UPDATE listing_items SET markup_pct = ? WHERE id = ?', rec.pct, item.id);
  if (rec.position === 'market_below_floor' && prevPosition !== 'market_below_floor') {
    logActivity('warn', 'alert.undercut', `Competitors now sell "${listing.title}" below your +${rules.minPct}% floor ($${rec.floor.toFixed(2)})`, {
      listingId: listing.id,
      itemId: item.id,
    });
  }
  return rec;
}

export async function researchAll() {
  const items = all<Item>(
    `SELECT i.* FROM listing_items i JOIN ebay_listings l ON l.id = i.listing_id WHERE l.status IN ('draft','published','out_of_stock','error')`,
  );
  let done = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await researchItem(item);
      done++;
    } catch (e) {
      failed++;
      if (failed <= 3) logActivity('warn', 'research', `Price research failed for ${item.sku}: ${(e as Error).message}`);
    }
    await sleep(400);
  }
  return `${done} researched, ${failed} failed`;
}

export function latestSnapshot(variantId: string) {
  const row = get<Row>('SELECT * FROM market_snapshots WHERE shopify_variant_id = ? ORDER BY taken_at DESC LIMIT 1', variantId);
  if (!row) return null;
  const [position, reason] = String(row.reason ?? '').split('|');
  return { ...row, position, reason, comps: json<Row[]>(row.comps, []), sold_available: !!row.sold_available } as Row;
}

export const snapshotHistory = (variantId: string, days = 120) =>
  all(
    `SELECT taken_at, active_min, active_median, sold_median, recommended_price, base_price FROM market_snapshots
     WHERE shopify_variant_id = ? AND taken_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY taken_at`,
    variantId,
    `-${days} days`,
  );
