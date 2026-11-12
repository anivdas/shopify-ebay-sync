import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-routes-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't', EBAY_CLIENT_ID: 'c', EBAY_CLIENT_SECRET: 's', EBAY_RUNAME: 'r' });

const countries = [...Array.from({ length: 230 }, (_, i) => `Aland ${i}`), 'Korea, North', 'Korea, South', 'United Kingdom'];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
  if (url.includes('/oauth2/token')) return json({ access_token: 'x', expires_in: 7200 });
  if (url.includes('get_default_category_tree_id')) return json({ categoryTreeId: '0' });
  if (url.includes('get_item_aspects_for_category'))
    return json({
      aspects: [
        { localizedAspectName: 'Format', aspectConstraint: { aspectRequired: true, aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: 'Blu-ray' }, { localizedValue: '4K UHD Blu-ray' }] },
        { localizedAspectName: 'Country of Origin', aspectConstraint: { aspectMode: 'SELECTION_ONLY' }, aspectValues: countries.map((c) => ({ localizedValue: c })) },
      ],
    });
  if (url.includes('graphql.json')) {
    const q = JSON.parse(String(init?.body)).query as string;
    if (q.includes('product(id:'))
      return json({
        data: {
          product: {
            id: 'gid://shopify/Product/9', title: 'Dune 4K Blu-ray Steelbook', handle: 'd', vendor: 'Label', productType: '', status: 'ACTIVE', tags: [], descriptionHtml: '', totalInventory: 1,
            featuredMedia: null, options: [], collections: { nodes: [] }, media: { nodes: [] },
            variants: { nodes: [{ id: 'gid://shopify/ProductVariant/9', title: 'Default Title', sku: 'D', price: '10', compareAtPrice: null, inventoryQuantity: 1, barcodes: { nodes: [] }, selectedOptions: [], media: { nodes: [] }, inventoryItem: { id: 'gid://shopify/InventoryItem/9', tracked: true, unitCost: null, measurement: null, countryCodeOfOrigin: 'KR' } }] },
          },
        },
      });
  }
  throw new Error(`Unmocked ${url}`);
}) as typeof fetch;

const { run, updateSettings } = await import('../src/db.ts');
const { router } = await import('../src/routes.ts');

const call = async (method: string, url: string, body?: unknown) => {
  const u = new URL(url, 'http://x');
  const m = router.match(method, u.pathname);
  assert.ok(m, `no route for ${method} ${u.pathname}`);
  return (await m.route.handler({ params: m.params, query: u.searchParams, body, url: u } as any)) as any;
};

test('Auto-fill picks the Shopify country of origin from a long eBay country list', async () => {
  const lid = Number(
    run(`INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title, category_id) VALUES ('single', 'gid://shopify/Product/9', 'Dune 4K Blu-ray Steelbook', 'Dune', '617')`).lastInsertRowid,
  );
  run(
    `INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status) VALUES (?, 'gid://shopify/ProductVariant/9', 'gid://shopify/InventoryItem/9', 'D', '{}', 10, 1, 'ACTIVE')`,
    lid,
  );
  const r = await call('POST', `/api/listings/${lid}/infer-aspects`, { aspects: {} });
  assert.deepEqual(r.aspects['Country of Origin'], ['Korea, South']);
  assert.deepEqual(r.aspects.Format, ['4K UHD Blu-ray']);
  assert.deepEqual(r.notes, []);
});

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
