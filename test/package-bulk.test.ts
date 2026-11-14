import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-pkg-'));

const { get: dbGet, run, updateSettings } = await import('../src/db.ts');
const { router } = await import('../src/routes.ts');
const call = async (method: string, url: string, body?: unknown) => {
  const u = new URL(url, 'http://x');
  const m = router.match(method, u.pathname)!;
  return (await m.route.handler({ params: m.params, query: u.searchParams, url: u, body } as any)) as any;
};

updateSettings({
  shippingBoxes: JSON.stringify([
    { id: 'small', name: 'Small', length: 10, width: 8, height: 4, unit: 'INCH', emptyWeightOz: 4, packageType: 'MAILING_BOX' },
    { id: 'oneclick', name: 'One Click Box', length: 10, width: 8, height: 6, unit: 'INCH', emptyWeightOz: 0, packageType: 'MAILING_BOX' },
  ]),
  defaultBoxId: 'small',
});
const draft = (n: number, oz: number) => {
  const lid = Number(run(`INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title) VALUES ('single', ?, 'x', ?)`, `gid://shopify/Product/${n}`, `Item ${n}`).lastInsertRowid);
  run(`INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status, weight_value, weight_unit) VALUES (?, ?, 'i', ?, '{}', 10, 1, 'ACTIVE', ?, 'OUNCES')`, lid, `v${n}`, `S${n}`, oz);
  return lid;
};
const a = draft(1, 64);
const b = draft(2, 8);

test('eBay listings include the box and the package weight eBay gets', async () => {
  const { listings } = await call('GET', '/api/listings');
  const one = listings.find((l: any) => l.id === a);
  assert.equal(one.box.id, 'small', 'falls back to the default box');
  assert.equal(one.items[0].package.weight.value, 4.3, '64 oz + 4 oz box, rounded up to 0.1 lb');
});

test('bulk "set-box" changes the box on every selected listing and can go back to the default', async () => {
  const r = await call('POST', '/api/listings/bulk-action', { ids: [a, b], action: 'set-box', boxId: 'oneclick' });
  assert.ok(r.results.every((x: any) => x.ok));
  for (const id of [a, b]) assert.equal(dbGet<{ box_id: string }>('SELECT box_id FROM ebay_listings WHERE id = ?', id)!.box_id, 'oneclick');
  const { listings } = await call('GET', '/api/listings');
  assert.equal(listings.find((l: any) => l.id === a).items[0].package.weight.value, 4, 'One Click Box adds no weight');
  await call('POST', '/api/listings/bulk-action', { ids: [a], action: 'set-box', boxId: null });
  assert.equal(dbGet<{ box_id: string | null }>('SELECT box_id FROM ebay_listings WHERE id = ?', a)!.box_id, null);
});

test('bulk "set-box" rejects a box that does not exist', async () => {
  await assert.rejects(call('POST', '/api/listings/bulk-action', { ids: [a], action: 'set-box', boxId: 'nope' }), /Unknown box/);
});
