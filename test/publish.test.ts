import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-pub-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't', EBAY_CLIENT_ID: 'c', EBAY_CLIENT_SECRET: 's', EBAY_RUNAME: 'r' });

const { get, run, setToken, updateSettings } = await import('../src/db.ts');
const { publishListing } = await import('../src/listings.ts');

const calls: { method: string; url: string; body: any }[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? 'GET', url, body });
  const ok = (data: unknown = {}, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
  if (url.includes('/inventory_item/') || url.includes('/inventory_item_group/')) return ok(undefined, 204);
  if (url.includes('/sell/inventory/v1/offer?')) return ok({}, 404);
  if (url.endsWith('/sell/inventory/v1/offer')) return ok({ offerId: `OFF-${body.sku}` }, 201);
  if (url.includes('publish_by_inventory_item_group')) return ok({ listingId: '1234567890' });
  throw new Error(`Unmocked ${url}`);
}) as typeof fetch;

setToken('ebay_refresh', 'x', Date.now() + 1e10);
setToken('ebay_access', 'x', Date.now() + 3600_000);
updateSettings({ dryRun: false, charmPricing: true });

test('multi-variation listing is published in the order eBay requires', async () => {
  const res = run(
    `INSERT INTO ebay_listings (kind, group_key, shopify_product_id, product_title, brand, title, category_id, aspects, description_html, image_urls, varies_by,
       fulfillment_policy_id, payment_policy_id, return_policy_id, merchant_location_key)
     VALUES ('group', 'SHP-1', 'gid://shopify/Product/1', 'Tee', 'Acme', 'Acme Tee', '15687', ?, '<p>Soft</p>', ?, ?, 'F', 'P', 'R', 'LOC')`,
    JSON.stringify({ Brand: ['Acme'], Size: ['ignored'] }),
    JSON.stringify(['https://cdn.shopify.com/a.jpg']),
    JSON.stringify(['Size']),
  );
  const lid = Number(res.lastInsertRowid);
  for (const [n, size, qty] of [[1, 'S', 3], [2, 'M', 0]] as const) {
    run(
      `INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status, barcode)
       VALUES (?, ?, ?, ?, ?, 20, ?, 'ACTIVE', '012345678905')`,
      lid, `gid://shopify/ProductVariant/${n}`, `gid://shopify/InventoryItem/${n}`, `TEE-${size}`, JSON.stringify({ Size: size }), qty,
    );
  }

  await publishListing(lid, { skipValidation: true });

  const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  const firstGroup = seq.findIndex((s) => s.includes('inventory_item_group'));
  const firstOffer = seq.findIndex((s) => s === 'POST /sell/inventory/v1/offer');
  const lastItem = seq.map((s, i) => (s.includes('/inventory_item/') ? i : -1)).filter((i) => i >= 0).pop()!;
  assert.ok(lastItem < firstGroup && firstGroup < firstOffer, `order was: ${seq.join(' | ')}`);

  const group = calls.find((c) => c.url.includes('inventory_item_group'))!.body;
  assert.deepEqual(group.variantSKUs, ['TEE-S', 'TEE-M']);
  assert.deepEqual(group.variesBy.specifications, [{ name: 'Size', values: ['S', 'M'] }]);
  assert.equal(group.aspects.Size, undefined, 'variation aspect is not a shared aspect');

  const itemS = calls.find((c) => c.url.includes('/inventory_item/TEE-S'))!.body;
  assert.deepEqual(itemS.product.aspects.Size, ['S']);
  assert.deepEqual(itemS.product.upc, ['012345678905']);
  assert.equal(itemS.product.brand, 'Acme');
  assert.equal(itemS.product.mpn, 'Does not apply', 'eBay rejects a brand without an MPN (BrandMPN error)');
  assert.equal(itemS.availability.shipToLocationAvailability.quantity, 3);

  const offers = calls.filter((c) => c.url.endsWith('/sell/inventory/v1/offer')).map((c) => c.body);
  for (const o of offers) {
    const price = Number(o.pricingSummary.price.value);
    assert.ok(price >= 23 && price <= 23.4, `offer price ${price} must be within +15..17% of $20`);
    assert.equal(o.listingDescription, undefined, 'group listings take the description from the group');
    assert.equal(o.listingPolicies.bestOfferTerms, undefined);
  }
  assert.equal(offers.find((o) => o.sku === 'TEE-M').availableQuantity, 0);

  const l = get<{ status: string; ebay_listing_id: string }>('SELECT status, ebay_listing_id FROM ebay_listings WHERE id = ?', lid)!;
  assert.equal(l.status, 'published');
  assert.equal(l.ebay_listing_id, '1234567890');
});
