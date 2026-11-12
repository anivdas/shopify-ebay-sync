import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-routes-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't', EBAY_CLIENT_ID: 'c', EBAY_CLIENT_SECRET: 's', EBAY_RUNAME: 'r' });

const { run, updateSettings } = await import('../src/db.ts');
const { router } = await import('../src/routes.ts');

const call = async (method: string, url: string, body?: unknown) => {
  const u = new URL(url, 'http://x');
  const m = router.match(method, u.pathname);
  assert.ok(m, `no route for ${method} ${u.pathname}`);
  return (await m.route.handler({ params: m.params, query: u.searchParams, body, url: u } as any)) as any;
};

test('listing editor API returns the package (box + Shopify weight) sent to eBay', async () => {
  updateSettings({ shippingBoxes: JSON.stringify([{ id: 'oc', name: 'One Click Box', length: 10, width: 8, height: 6, unit: 'INCH', emptyWeightOz: 4 }]) });
  const lid = Number(
    run(
      `INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title, box_id) VALUES ('single', 'gid://shopify/Product/1', 'Box Set', 'Box Set', 'oc')`,
    ).lastInsertRowid,
  );
  run(
    `INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status, weight_value, weight_unit)
     VALUES (?, 'gid://shopify/ProductVariant/1', 'gid://shopify/InventoryItem/1', 'BOX-1', '{}', 100, 1, 'ACTIVE', 4, 'POUNDS')`,
    lid,
  );
  const { listing } = await call('GET', `/api/listings/${lid}`);
  assert.equal(listing.box?.name, 'One Click Box');
  assert.equal(listing.items[0].product_oz, 64);
  assert.deepEqual(listing.items[0].package.weight, { value: 4.3, unit: 'POUND' });
  assert.deepEqual(listing.items[0].package.dimensions, { length: 10, width: 8, height: 6, unit: 'INCH' });
});
