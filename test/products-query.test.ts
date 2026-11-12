import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-pq-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't' });

let sent: any = null;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  sent = JSON.parse(String(init?.body)).variables;
  return new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }));
}) as typeof fetch;

const { listProducts, productQuery } = await import('../src/shopify.ts');

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
