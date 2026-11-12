import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-cat-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't' });

const { updateSettings } = await import('../src/db.ts');
const catalog = await import('../src/catalog.ts');

const variant = (n: number, o: Partial<{ sku: string | null; barcode: string; tracked: boolean; cost: string | null; title: string; vendor: string; productId: string; option: string; weightless: boolean; country: string | null }>) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  title: o.option ?? 'Default Title',
  sku: o.sku ?? null,
  inventoryQuantity: 3,
  selectedOptions: [{ name: o.option ? 'Color' : 'Title', value: o.option ?? 'Default Title' }],
  barcodes: { nodes: o.barcode ? [{ value: o.barcode, type: null }] : [] },
  inventoryItem: {
    id: `gid://shopify/InventoryItem/${n}`,
    tracked: o.tracked ?? true,
    unitCost: o.cost === null ? null : { amount: o.cost ?? '5.00' },
    measurement: { weight: o.weightless ? null : { unit: 'POUNDS', value: 1.5 } },
    countryCodeOfOrigin: o.country === undefined ? 'JP' : o.country,
  },
  product: { id: o.productId ?? `gid://shopify/Product/${n}`, title: o.title ?? 'WH-1000XM5 Headphones', vendor: o.vendor ?? 'Sony', status: 'ACTIVE', featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg', width: 1000, height: 1000 } } } },
});

const store = [
  variant(1, { sku: 'SONY-1', barcode: '012345678905', productId: 'P1', option: 'Black' }),
  variant(2, { sku: null, barcode: '012345678906', productId: 'P1', option: 'Silver' }),
  variant(3, { sku: 'DUP', title: 'Mug', vendor: 'Acme', tracked: false, cost: null, weightless: true, country: null }),
  variant(4, { sku: 'dup', title: 'Cup', vendor: 'Acme' }),
  variant(5, { sku: 'has space', title: 'Plate', vendor: '' }),
];

const mutations: any[] = [];
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  if (body.query.includes('productVariants(')) return new Response(JSON.stringify({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: store } } }));
  if (body.query.includes('productVariantsBulkUpdate')) {
    mutations.push(body.variables);
    return new Response(JSON.stringify({ data: { productVariantsBulkUpdate: { userErrors: [] } } }));
  }
  throw new Error('unmocked');
}) as typeof fetch;

test('GTIN check digits', () => {
  assert.ok(catalog.isValidGtin('012345678905'));
  assert.ok(!catalog.isValidGtin('012345678906'));
  assert.ok(catalog.isValidGtin('4006381333931'));
  assert.ok(!catalog.isValidGtin('12345'));
});

test('scan finds the problems', async () => {
  const { rows } = await catalog.scanCatalog();
  const issues = (n: number) => rows.find((r) => r.variantId.endsWith(`/${n}`))!.issues;
  assert.deepEqual(issues(1), []);
  assert.deepEqual(issues(2), ['sku_missing', 'barcode_invalid']);
  assert.ok(issues(3).includes('sku_duplicate') && issues(3).includes('not_tracked') && issues(3).includes('no_cost') && issues(3).includes('no_weight') && issues(3).includes('no_country'));
  assert.ok(!issues(4).includes('no_country'));
  assert.ok(issues(4).includes('sku_duplicate'));
  assert.ok(issues(5).includes('sku_invalid') && issues(5).includes('no_vendor'));
  const s = catalog.summarize(rows);
  assert.equal(s.variants, 5);
  assert.equal(s.healthy, 1);
});

test('SKU proposals only touch what needs fixing', async () => {
  const { rows } = await catalog.scanCatalog();
  const missing = catalog.proposeSkus(rows, 'missing');
  assert.deepEqual(missing.map((p) => p.proposed), ['SONY-WH1000XM5-SLV']);
  const problems = catalog.proposeSkus(rows, 'problems');
  assert.deepEqual(problems.map((p) => p.variantId.split('/').pop()), ['2', '4', '5'], 'first duplicate keeps its SKU');
  assert.equal(new Set(catalog.proposeSkus(rows, 'all').map((p) => p.proposed)).size, 5, 'all unique');
});

test('applying writes SKU via inventoryItem and barcode via barcodes, and can be undone', async () => {
  updateSettings({ dryRun: false });
  await catalog.scanCatalog();
  mutations.length = 0;
  const res = await catalog.applyChanges(
    [
      { variantId: 'gid://shopify/ProductVariant/2', productId: 'P1', sku: 'SONY-WH1000XM5-SLV', barcode: '012345678912' },
      { variantId: 'gid://shopify/ProductVariant/3', productId: 'gid://shopify/Product/3', tracked: true, cost: 2.5, country: 'KR' },
    ],
    'test',
  );
  assert.equal(res.done, 2);
  assert.equal(mutations.length, 2, 'one call per product');
  assert.deepEqual(mutations[0].variants[0], { id: 'gid://shopify/ProductVariant/2', inventoryItem: { sku: 'SONY-WH1000XM5-SLV' }, barcodes: [{ value: '012345678912' }] });
  assert.deepEqual(mutations[1].variants[0].inventoryItem, { cost: 2.5, tracked: true, countryCodeOfOrigin: 'KR' });

  mutations.length = 0;
  await catalog.undoLast();
  assert.deepEqual(mutations[0].variants[0], { id: 'gid://shopify/ProductVariant/2', inventoryItem: { sku: '' }, barcodes: [{ value: '012345678906' }] });
  assert.deepEqual(mutations[1].variants[0].inventoryItem, { cost: null, tracked: false, countryCodeOfOrigin: null });
});

test('invalid country codes are rejected before anything is sent', async () => {
  await catalog.scanCatalog();
  await assert.rejects(catalog.applyChanges([{ variantId: 'gid://shopify/ProductVariant/3', productId: 'gid://shopify/Product/3', country: 'Korea' }], 't'), /2-letter country code/);
});

test('dry-run blocks catalog changes', async () => {
  updateSettings({ dryRun: true });
  await assert.rejects(catalog.applyChanges([{ variantId: 'x', productId: 'y', sku: 'A' }], 't'), /Dry-run/);
  updateSettings({ dryRun: false });
});
