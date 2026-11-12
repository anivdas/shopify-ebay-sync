import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/db.ts';
import { estimateProfit, recommend } from '../src/pricing.ts';
import { getBoxes, packageWeightAndSize, resolveBox, toOunces } from '../src/shipping.ts';

const settings = {
  ...defaultSettings,
  defaultBoxId: 'm',
  shippingBoxes: JSON.stringify([
    { id: 's', name: 'Small', length: 8, width: 6, height: 4, unit: 'INCH', emptyWeightOz: 3, packageType: 'MAILING_BOX' },
    { id: 'm', name: 'Medium', length: 12, width: 10, height: 6, unit: 'INCH', emptyWeightOz: 6, packageType: 'MAILING_BOX' },
    { id: 'bad', name: 'No dims' },
  ]),
};

test('boxes parse and invalid ones are dropped', () => {
  assert.deepEqual(getBoxes(settings).map((b) => b.id), ['s', 'm']);
});

test('listing box beats profile box beats default', () => {
  assert.equal(resolveBox(settings, 's', 'm')?.id, 's');
  assert.equal(resolveBox(settings, null, 's')?.id, 's');
  assert.equal(resolveBox(settings, null, null)?.id, 'm');
  assert.equal(resolveBox({ ...settings, defaultBoxId: '' }, null)?.id, undefined);
});

test('weight conversion from Shopify units', () => {
  assert.equal(toOunces(1, 'POUNDS'), 16);
  assert.equal(toOunces(8, 'OUNCES'), 8);
  assert.ok(Math.abs(toOunces(1000, 'GRAMS') - 35.274) < 0.01);
  assert.equal(toOunces(0, 'POUNDS'), 0);
});

test('eBay package = box dims + product weight + empty box weight, rounded up to 0.1 lb', () => {
  const pkg = packageWeightAndSize(resolveBox(settings, 's'), 26)!;
  assert.deepEqual(pkg.dimensions, { length: 8, width: 6, height: 4, unit: 'INCH' });
  assert.deepEqual(pkg.weight, { value: 1.9, unit: 'POUND' }, '26 oz + 3 oz box = 1.81 lb, rounded up');
  assert.equal(pkg.packageType, 'PACKAGE_THICK_ENVELOPE', 'eBay US rejects MAILING_BOX (Invalid <ShippingPackage>)');
  assert.equal(packageWeightAndSize(resolveBox(settings, 's'), 26, 'EBAY_AU')!.packageType, 'MAILING_BOX');
  assert.equal(packageWeightAndSize(null, 0), undefined);
});

test('competitor totals are compared against your price + shipping', () => {
  const rules = { minPct: 15, maxPct: 17, undercut: 0.01, charm: false, ownShipping: 8 };
  const r = recommend(100, { activeMin: 124.5, activeMedian: null, soldMedian: null }, rules);
  assert.equal(r.price, 116.49);
  const noShip = recommend(100, { activeMin: 124.5, activeMedian: null, soldMedian: null }, { ...rules, ownShipping: 0 });
  assert.equal(noShip.position, 'market_above_ceiling');
});

test('profit includes shipping charged and fees on the total', () => {
  const p = estimateProfit(100, { cost: 50, feePct: 10, fixedFee: 0, shipping: 7, shippingCharged: 10 });
  assert.equal(p.fees, 11);
  assert.equal(p.net, 42);
});
