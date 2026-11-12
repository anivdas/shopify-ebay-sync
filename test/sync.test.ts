import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-sync-'));
Object.assign(process.env, {
  SHOPIFY_SHOP: 'test-store',
  SHOPIFY_ACCESS_TOKEN: 'shpat_test',
  EBAY_CLIENT_ID: 'cid',
  EBAY_CLIENT_SECRET: 'csecret',
  EBAY_RUNAME: 'ru',
});

const { get, run, setState, setToken, updateSettings } = await import('../src/db.ts');
const { processEbayOrders, syncShopifyToEbay } = await import('../src/sync.ts');

type Call = { url: string; body: any };
let calls: Call[] = [];
let shopifyAvailable = 5;
let variantPrice = '100.00';
let productTitle = 'Test item';
let orders: any[] = [];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, body });
  if (url.includes('myshopify.com') && url.includes('graphql')) {
    const q: string = body.query;
    if (q.includes('inventoryLevels'))
      return json({ data: { inventoryItem: { inventoryLevels: { nodes: [{ location: { id: 'gid://shopify/Location/1', name: 'Main' }, quantities: [{ name: 'available', quantity: shopifyAvailable }] }] } } } });
    if (q.includes('inventoryAdjustQuantities')) {
      shopifyAvailable += body.variables.input.changes[0].delta;
      return json({ data: { inventoryAdjustQuantities: { userErrors: [] } } });
    }
    if (q.includes('nodes(ids'))
      return json({
        data: {
          nodes: [{ id: 'gid://shopify/ProductVariant/11', price: variantPrice, compareAtPrice: null, inventoryQuantity: shopifyAvailable, inventoryItem: { id: 'gid://shopify/InventoryItem/22', tracked: true, unitCost: { amount: '60.00' } }, product: { id: 'gid://shopify/Product/33', status: 'ACTIVE', title: productTitle, tags: [], productType: '', vendor: '', collections: { nodes: [] } } }],
        },
      });
  }
  if (url.includes('/sell/fulfillment/v1/order')) return json({ orders, total: orders.length });
  if (url.includes('/bulk_update_price_quantity')) return json({ responses: body.requests.map((r: any) => ({ sku: r.sku, statusCode: 200 })) });
  if (url.includes('/sell/inventory/v1/offer/')) return json({ offerId: 'O1', sku: 'SKU1', status: 'PUBLISHED', listing: { listingId: 'L1', listingStatus: 'ACTIVE' } });
  throw new Error(`Unmocked fetch: ${url}`);
}) as typeof fetch;

setToken('ebay_refresh', 'refresh', Date.now() + 365 * 86400_000);
setToken('ebay_access', 'access', Date.now() + 3600_000);

const order = (cancelled = false) => ({
  orderId: 'ORD-1',
  creationDate: new Date().toISOString(),
  lastModifiedDate: new Date().toISOString(),
  orderFulfillmentStatus: 'NOT_STARTED',
  orderPaymentStatus: 'PAID',
  cancelStatus: { cancelState: cancelled ? 'CANCELED' : 'NONE_REQUESTED' },
  lineItems: [{ lineItemId: 'LI-1', sku: 'SKU1', title: 'Test item', quantity: 2, lineItemCost: { value: '233.98' }, total: { value: '233.98' } }],
});

beforeEach(() => {
  calls = [];
  run('DELETE FROM ebay_listings');
  run('DELETE FROM processed_orders');
  updateSettings({ dryRun: false, quantityBuffer: 0, priceGuardPct: 30, restockOnCancel: true });
  shopifyAvailable = 5;
  variantPrice = '100.00';
  productTitle = 'Test item';
  const res = run(
    `INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title, category_id, status, ebay_listing_id, fulfillment_policy_id, payment_policy_id, return_policy_id, merchant_location_key)
     VALUES ('single', 'gid://shopify/Product/33', 'Test item', 'Test item', '123', 'published', 'L1', 'f', 'p', 'r', 'loc')`,
  );
  run(
    `INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, offer_id, shopify_price, shopify_qty, shopify_status, ebay_price, ebay_qty, markup_pct)
     VALUES (?, 'gid://shopify/ProductVariant/11', 'gid://shopify/InventoryItem/22', 'SKU1', 'O1', 100, 5, 'ACTIVE', 116.99, 5, 16.99)`,
    Number(res.lastInsertRowid),
  );
  setState('ordersCursor', new Date(Date.now() - 3600_000).toISOString());
});

const adjustCalls = () => calls.filter((c) => c.body?.query?.includes('inventoryAdjustQuantities'));

test('an eBay sale reduces Shopify stock exactly once', async () => {
  orders = [order()];
  await processEbayOrders();
  assert.equal(shopifyAvailable, 3);
  const [adj] = adjustCalls();
  assert.equal(adj.body.variables.input.changes[0].delta, -2);
  assert.equal(adj.body.variables.input.changes[0].changeFromQuantity, null);
  assert.ok(adj.body.variables.key, 'idempotency key is sent');
  assert.equal(get<{ status: string }>(`SELECT status FROM processed_orders WHERE order_id = 'ORD-1'`)!.status, 'applied');

  calls = [];
  await processEbayOrders();
  assert.equal(adjustCalls().length, 0, 'the same order is never applied twice');
  assert.equal(shopifyAvailable, 3);
});

test('a cancelled eBay order puts the stock back', async () => {
  orders = [order()];
  await processEbayOrders();
  orders = [order(true)];
  await processEbayOrders();
  assert.equal(shopifyAvailable, 5);
  assert.equal(get<{ status: string }>(`SELECT status FROM processed_orders WHERE order_id = 'ORD-1'`)!.status, 'restocked');
});

test('Shopify stock changes are pushed to eBay with the buffer applied', async () => {
  updateSettings({ quantityBuffer: 1 });
  shopifyAvailable = 4;
  await syncShopifyToEbay();
  const push = calls.find((c) => c.url.includes('bulk_update_price_quantity'));
  assert.ok(push);
  assert.equal(push!.body.requests[0].shipToLocationAvailability.quantity, 3);
  assert.equal(get<{ ebay_qty: number }>(`SELECT ebay_qty FROM listing_items WHERE sku = 'SKU1'`)!.ebay_qty, 3);
});

test('a large price jump is held for review instead of pushed', async () => {
  variantPrice = '200.00';
  await syncShopifyToEbay();
  const push = calls.find((c) => c.url.includes('bulk_update_price_quantity'));
  assert.equal(push?.body.requests[0].offers[0].price, undefined, 'price not changed on eBay');
  const item = get<{ held_price: number; ebay_price: number }>(`SELECT held_price, ebay_price FROM listing_items WHERE sku = 'SKU1'`)!;
  assert.equal(item.ebay_price, 116.99);
  assert.ok(item.held_price > 230 && item.held_price <= 234);
});

test('price follows Shopify within the markup range', async () => {
  variantPrice = '110.00';
  await syncShopifyToEbay();
  const push = calls.find((c) => c.url.includes('bulk_update_price_quantity'))!;
  const price = Number(push.body.requests[0].offers[0].price.value);
  assert.ok(price >= 126.5 && price <= 128.7, `price ${price} within +15..17% of 110`);
});

test('a listing whose title gains "Pre-Order" is paused at 0 and resumes when it is removed', async () => {
  productTitle = 'Test item [Pre-Order]';
  await syncShopifyToEbay();
  let push = calls.find((c) => c.url.includes('bulk_update_price_quantity'))!;
  assert.equal(push.body.requests[0].shipToLocationAvailability.quantity, 0);
  let l = get<{ status: string; excluded_reason: string }>(`SELECT status, excluded_reason FROM ebay_listings`)!;
  assert.equal(l.status, 'paused');
  assert.match(l.excluded_reason, /pre-order/i);

  calls = [];
  productTitle = 'Test item';
  await syncShopifyToEbay();
  push = calls.find((c) => c.url.includes('bulk_update_price_quantity'))!;
  assert.equal(push.body.requests[0].shipToLocationAvailability.quantity, 5);
  l = get<{ status: string; excluded_reason: string }>(`SELECT status, excluded_reason FROM ebay_listings`)!;
  assert.equal(l.status, 'published');
  assert.equal(l.excluded_reason, null);
});

test('dry-run mode changes nothing', async () => {
  updateSettings({ dryRun: true });
  orders = [order()];
  await processEbayOrders();
  assert.equal(adjustCalls().length, 0);
  assert.equal(shopifyAvailable, 5);
});
