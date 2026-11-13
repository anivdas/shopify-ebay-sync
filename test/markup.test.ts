import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-markup-'));

const { get: dbGet, run, updateSettings } = await import('../src/db.ts');
const { router } = await import('../src/routes.ts');
const { priceAtExactPct } = await import('../src/pricing.ts');
const call = async (method: string, url: string, body?: unknown) => {
  const u = new URL(url, 'http://x');
  const m = router.match(method, u.pathname)!;
  return (await m.route.handler({ params: m.params, query: u.searchParams, url: u, body } as any)) as any;
};

updateSettings({ markupMinPct: 15, markupMaxPct: 17, charmPricing: false, useShopifySalePrice: true });
const lid = Number(run(`INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title) VALUES ('single', 'gid://shopify/Product/1', 'x', 'x')`).lastInsertRowid);
const iid = Number(
  run(`INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status) VALUES (?, 'v1', 'i', 'S1', '{}', 100, 1, 'ACTIVE')`, lid).lastInsertRowid,
);
const item = async () => (await call('GET', `/api/listings/${lid}`)).listing.items[0];

test('a markup typed on a listing is used exactly, even outside the min/max range', async () => {
  assert.equal((await item()).target_price, 116, 'automatic: middle of 15-17%');
  await call('PUT', `/api/listings/${lid}`, { items: [{ id: iid, markup_pct: 40 }] });
  const i = await item();
  assert.equal(i.target_price, 140);
  assert.equal(i.markup_manual, true);
  await call('PUT', `/api/listings/${lid}`, { items: [{ id: iid, markup_pct: null }] });
  assert.deepEqual([(await item()).target_price, (await item()).markup_manual], [116, false], 'clearing goes back to automatic');
});

test('applying a market suggestion makes the markup automatic again', async () => {
  await call('PUT', `/api/listings/${lid}`, { items: [{ id: iid, markup_pct: 40 }] });
  run(`INSERT INTO market_snapshots (shopify_variant_id, match_type, recommended_pct) VALUES ('v1', 'gtin', 16)`);
  await call('POST', `/api/items/${iid}/apply-suggestion`);
  assert.equal(dbGet<{ markup_manual: number }>('SELECT markup_manual FROM listing_items WHERE id = ?', iid)!.markup_manual, 0);
});

test('invalid markups are rejected', async () => {
  await assert.rejects(call('PUT', `/api/listings/${lid}`, { items: [{ id: iid, markup_pct: -100 }] }), /Markup must be/);
  await assert.rejects(call('PUT', `/api/listings/${lid}`, { items: [{ id: iid, markup_pct: 'abc' }] }), /Markup must be/);
});

test('exact markup still gets a .99 ending when charm pricing is on', () => {
  assert.equal(priceAtExactPct(100, 40, true), 139.99);
  assert.equal(priceAtExactPct(100, 40, false), 140);
});
