import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestOfferThresholds, bounds, effectiveBase, estimateProfit, guardPriceChange, priceAtPct, recommend, stats } from '../src/pricing.ts';

const rules = { minPct: 15, maxPct: 17, undercut: 0.01, charm: true };
const inRange = (price: number, base: number) => price >= base * 1.15 - 1e-9 && price <= base * 1.17 + 1e-9;

test('bounds are 15%..17% in cents', () => {
  assert.deepEqual(bounds(100, rules), { floor: 11500, ceiling: 11700 });
});

test('no market data uses the middle of the range', () => {
  const r = recommend(100, { activeMin: null, activeMedian: null, soldMedian: null }, { ...rules, charm: false });
  assert.equal(r.price, 116);
  assert.equal(r.position, 'no_data');
});

test('undercuts the cheapest competitor when inside the range', () => {
  const r = recommend(100, { activeMin: 116.5, activeMedian: 120, soldMedian: null }, { ...rules, charm: false });
  assert.equal(r.price, 116.49);
  assert.equal(r.position, 'in_range');
});

test('never goes below the floor even if the market is cheaper', () => {
  const r = recommend(100, { activeMin: 99, activeMedian: 105, soldMedian: 100 }, rules);
  assert.equal(r.price, 115);
  assert.equal(r.position, 'market_below_floor');
});

test('never exceeds the ceiling even if the market is pricier', () => {
  const r = recommend(100, { activeMin: 150, activeMedian: 160, soldMedian: null }, rules);
  assert.equal(r.position, 'market_above_ceiling');
  assert.ok(inRange(r.price, 100));
  assert.equal(r.price, 116.99);
});

test('falls back to sold median when no active comps', () => {
  const r = recommend(50, { activeMin: null, activeMedian: null, soldMedian: 58 }, { ...rules, charm: false });
  assert.equal(r.price, 58);
});

test('charm pricing stays inside the range', () => {
  for (const base of [3.5, 9.99, 19.95, 42, 87.3, 129, 999.99]) {
    for (const anchor of [null, base, base * 1.16, base * 2]) {
      const r = recommend(base, { activeMin: anchor, activeMedian: null, soldMedian: null }, rules);
      assert.ok(inRange(r.price, base) || r.price === r.floor, `base ${base} anchor ${anchor} -> ${r.price}`);
    }
  }
});

test('priceAtPct clamps to the range', () => {
  assert.equal(priceAtPct(100, 30, { ...rules, charm: false }), 117);
  assert.equal(priceAtPct(100, 0, { ...rules, charm: false }), 115);
});

test('effectiveBase ignores Shopify sale when configured', () => {
  assert.equal(effectiveBase(80, 100, true), 80);
  assert.equal(effectiveBase(80, 100, false), 100);
  assert.equal(effectiveBase(80, null, false), 80);
});

test('profit estimate', () => {
  const p = estimateProfit(116, { cost: 60, feePct: 13.6, fixedFee: 0.4, shipping: 10 });
  assert.equal(p.fees, 16.18);
  assert.equal(p.net, 29.82);
});

test('best offer thresholds respect the floor', () => {
  const t = bestOfferThresholds(116.99, 100, rules, 16.5, true);
  assert.equal(t.autoAccept, 116.5);
  assert.equal(t.autoDecline, 114.99);
});

test('price guard', () => {
  assert.equal(guardPriceChange(100, 110, 30), null);
  assert.match(guardPriceChange(100, 200, 30) ?? '', /exceeds/);
  assert.match(guardPriceChange(100, 0, 30) ?? '', /Invalid/);
});

test('stats', () => {
  assert.deepEqual(stats([3, 1, 2, 10]), { min: 1, median: 2.5, avg: 4 });
  assert.deepEqual(stats([]), { min: null, median: null, avg: null });
});
