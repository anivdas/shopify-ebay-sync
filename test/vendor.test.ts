import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-vendor-'));
const { defaultSettings } = await import('../src/db.ts');
const { brandFromVendor } = await import('../src/listings.ts');
const { renderTitle } = await import('../src/listing-builder.ts');

test('vendor is only used as brand when the store says so', () => {
  assert.equal(brandFromVendor('Sony', { ...defaultSettings, vendorMode: 'brand' }), 'Sony');
  assert.equal(brandFromVendor('HDzeta', { ...defaultSettings, vendorMode: 'ignore' }), null);
  assert.equal(brandFromVendor('Best Buy', { ...defaultSettings, vendorMode: 'aspect' }), null);
  assert.equal(brandFromVendor('  ', { ...defaultSettings, vendorMode: 'brand' }), null);
});

test('boutique labels are kept, big retailers are ignored', () => {
  assert.equal(brandFromVendor('HDzeta', defaultSettings), 'HDzeta');
  assert.equal(brandFromVendor('WeET COLLECTION', defaultSettings), 'WeET COLLECTION');
  assert.equal(brandFromVendor('Best Buy', defaultSettings), null);
  assert.equal(brandFromVendor('bestbuy', defaultSettings), null, 'spacing/case-insensitive');
  assert.equal(brandFromVendor('Walmart', defaultSettings), null);
  assert.equal(
    renderTitle('{title} {brand} {options}', { brand: brandFromVendor('HDzeta', defaultSettings), title: 'Blade Runner 4K Blu-ray Steelbook' }),
    'Blade Runner 4K Blu-ray Steelbook HDzeta',
  );
});

test('titles do not get a retailer prefix when vendor is not the brand', () => {
  const brand = brandFromVendor('HDzeta', { ...defaultSettings, vendorMode: 'ignore' });
  assert.equal(renderTitle('{brand} {title} {options}', { brand, title: 'Blade Runner 4K Blu-ray Steelbook' }), 'Blade Runner 4K Blu-ray Steelbook');
});
