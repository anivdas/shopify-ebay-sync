import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-rules-'));
const { defaultSettings } = await import('../src/db.ts');
const { eligibility, exclusionReason, matches, profileFor, setOverride } = await import('../src/rules.ts');

const settings = { ...defaultSettings };
const rules = JSON.parse(settings.excludeRules);

test('default rules catch every spelling of preorder', () => {
  for (const t of ['Dune Part Two PREORDER', 'Dune [Pre-Order] 4K', 'Dune pre order Steelbook', 'Dune (Pre_Order)']) {
    assert.ok(exclusionReason({ title: t }, rules), t);
  }
  assert.equal(exclusionReason({ title: 'Dune Part Two 4K' }, rules), null);
});

test('rules can match tags, type, vendor and collections', () => {
  assert.ok(matches({ title: 'x', tags: ['Pre-Order', 'sale'] }, { field: 'tag', value: 'preorder'.replace('pre', 'pre-') }));
  assert.ok(matches({ title: 'x', productType: 'Blu-ray Movie' }, { field: 'type', value: 'blu-ray' }));
  assert.ok(matches({ title: 'x', vendor: 'Criterion' }, { field: 'vendor', value: 'criterion' }));
  assert.ok(matches({ title: 'x', collections: ['Coming Soon'] }, { field: 'collection', value: 'coming soon' }));
  assert.ok(!matches({ title: 'x', collections: [] }, { field: 'collection', value: 'coming soon' }));
});

test('exceptions: block beats allow beats rules', () => {
  const preorder = { id: 'P1', title: 'Movie PREORDER', tags: [] as string[] };
  assert.match(eligibility(preorder, settings, null).excluded ?? '', /preorder/);
  assert.equal(eligibility({ ...preorder, tags: ['ebay-allow'] }, settings, null).excluded, null, 'allow tag');
  assert.equal(eligibility(preorder, settings, 'allow').excluded, null, 'app exception');
  assert.match(eligibility({ ...preorder, tags: ['ebay-allow', 'ebay-block'] }, settings, null).excluded ?? '', /never list/);
  assert.match(eligibility({ id: 'P2', title: 'Normal movie' }, settings, 'block').excluded ?? '', /Never list/);
});

test('app exceptions are stored per product', () => {
  setOverride('gid://shopify/Product/9', 'allow', 'Movie PREORDER');
  assert.equal(eligibility({ id: 'gid://shopify/Product/9', title: 'Movie PREORDER' }, settings).excluded, null);
  setOverride('gid://shopify/Product/9', null);
  assert.ok(eligibility({ id: 'gid://shopify/Product/9', title: 'Movie PREORDER' }, settings).excluded);
});

test('profile rules pick the first match', () => {
  const pr = [
    { field: 'type' as const, value: '4K', profileId: 2 },
    { field: 'type' as const, value: 'Blu-ray', profileId: 1 },
  ];
  assert.equal(profileFor({ title: 'x', productType: '4K Blu-ray' }, pr), 2);
  assert.equal(profileFor({ title: 'x', productType: 'Blu-ray' }, pr), 1);
  assert.equal(profileFor({ title: 'x', productType: 'DVD' }, pr), null);
});
