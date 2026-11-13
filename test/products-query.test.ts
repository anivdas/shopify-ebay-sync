import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-pq-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't' });

// A fake store of 7 products, served in pages of `first` with per-product cursors.
const store = Array.from({ length: 7 }, (_, i) => ({
  id: `gid://shopify/Product/${i + 1}`, title: `P${i + 1}`, vendor: 'V', productType: '', status: 'ACTIVE', totalInventory: 1, hasOnlyDefaultVariant: true, tags: [],
  variantsCount: { count: 1 }, priceRangeV2: { minVariantPrice: { amount: '10' }, maxVariantPrice: { amount: '10' } }, featuredMedia: null, collections: { nodes: [] },
}));
let sent: any = null;
let calls = 0;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  sent = JSON.parse(String(init?.body)).variables;
  calls++;
  const start = sent.after ? Number(sent.after.slice(1)) : 0;
  const slice = store.slice(start, start + sent.first);
  const edges = slice.map((node, i) => ({ cursor: `c${start + i + 1}`, node }));
  return new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: start + sent.first < store.length, endCursor: edges.at(-1)?.cursor ?? null }, edges } } }));
}) as typeof fetch;

const { listProducts, productQuery } = await import('../src/shopify.ts');
const { run } = await import('../src/db.ts');
const { router } = await import('../src/routes.ts');
const get = async (url: string) => {
  const u = new URL(url, 'http://x');
  const m = router.match('GET', u.pathname)!;
  return (await m.route.handler({ params: m.params, query: u.searchParams, url: u } as any)) as any;
};

test('in-stock filter and search are combined into one Shopify query', () => {
  assert.equal(productQuery('', false), null);
  assert.equal(productQuery('', true), 'inventory_total:>0');
  assert.equal(productQuery('dune', true), '(dune) inventory_total:>0');
  assert.equal(productQuery(' dune ', false), '(dune)');
});

test('sorting by stock asks Shopify for most inventory first', async () => {
  await listProducts({ sort: 'stock', inStock: true });
  assert.deepEqual({ sortKey: sent.sortKey, reverse: sent.reverse, query: sent.query }, { sortKey: 'INVENTORY_TOTAL', reverse: true, query: 'inventory_total:>0' });
  await listProducts({});
  assert.deepEqual({ sortKey: sent.sortKey, reverse: sent.reverse, query: sent.query }, { sortKey: 'TITLE', reverse: false, query: null });
});

test('"Hide listed" fills each page from later Shopify pages and resumes without gaps or repeats', async () => {
  for (const n of [1, 2, 4]) {
    const lid = Number(run(`INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title) VALUES ('single', ?, 'x', 'x')`, `gid://shopify/Product/${n}`).lastInsertRowid);
    run(`INSERT INTO listing_items (listing_id, shopify_variant_id, shopify_inventory_item_id, sku, options, shopify_price, shopify_qty, shopify_status) VALUES (?, ?, 'i', ?, '{}', 1, 1, 'ACTIVE')`, lid, `v${n}`, `S${n}`);
  }
  calls = 0;
  const p1 = await get('/api/shopify/products?first=2&hideListed=1');
  assert.deepEqual(p1.products.map((p: any) => p.title), ['P3', 'P5']);
  assert.equal(p1.pageInfo.hasNextPage, true);
  const p2 = await get(`/api/shopify/products?first=2&hideListed=1&after=${p1.pageInfo.endCursor}`);
  assert.deepEqual(p2.products.map((p: any) => p.title), ['P6', 'P7']);
  const all = await get('/api/shopify/products?first=50');
  assert.equal(all.products.length, 7, 'without the filter, listed products are shown');
});

test('"Hide preorders" matches preorder spellings in titles only as a word', async () => {
  const { isPreorderTitle } = await import('../src/routes.ts');
  for (const t of ['Akira [PREORDER]', 'Pre-order: Alien 4K', 'Heat (Pre Order)', 'preorders ship in May']) assert.equal(isPreorderTitle(t), true, t);
  for (const t of ['The Substance 4K Steelbook', 'Spreorderly', 'Order of the Phoenix']) assert.equal(isPreorderTitle(t), false, t);
  store[2].title = 'P3 [Pre-Order]';
  const page = await get('/api/shopify/products?first=50&hidePreorder=1');
  assert.deepEqual(page.products.map((p: any) => p.title), ['P1', 'P2', 'P4', 'P5', 'P6', 'P7']);
  store[2].title = 'P3';
});
