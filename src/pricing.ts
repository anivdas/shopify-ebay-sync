export type PricingRules = {
  minPct: number;
  maxPct: number;
  undercut: number;
  charm: boolean;
  /** What eBay buyers typically pay you for shipping; competitors are compared on item + shipping. */
  ownShipping?: number;
};

export type MarketStats = {
  activeMin: number | null;
  activeMedian: number | null;
  soldMedian: number | null;
};

export type Position = 'no_data' | 'in_range' | 'market_below_floor' | 'market_above_ceiling';

export type Recommendation = {
  price: number;
  pct: number;
  floor: number;
  ceiling: number;
  position: Position;
  reason: string;
};

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

export function bounds(base: number, rules: Pick<PricingRules, 'minPct' | 'maxPct'>) {
  const floor = Math.ceil(base * (1 + rules.minPct / 100) * 100 - 1e-6);
  const ceiling = Math.max(floor, Math.floor(base * (1 + rules.maxPct / 100) * 100 + 1e-6));
  return { floor, ceiling };
}

/** Rounds a target (in cents) to a .99 ending when that still fits inside [floor, ceiling]. */
function charmRound(target: number, floor: number, ceiling: number): number {
  let candidate = Math.floor(target / 100) * 100 + 99;
  if (candidate > target) candidate -= 100;
  return candidate >= floor && candidate <= ceiling ? candidate : target;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pctOf = (price: number, base: number) => +(((price / base) - 1) * 100).toFixed(2);

/** Price for a fixed markup %, always kept inside the allowed range. */
export function priceAtPct(base: number, pct: number, rules: PricingRules): number {
  const { floor, ceiling } = bounds(base, rules);
  const target = clamp(toCents(base * (1 + pct / 100)), floor, ceiling);
  return fromCents(rules.charm ? charmRound(target, floor, ceiling) : target);
}

/** Price for a markup % the seller chose on a listing: used as-is, outside the min/max range if need be. */
export function priceAtExactPct(base: number, pct: number, charm: boolean): number {
  const target = toCents(base * (1 + pct / 100));
  return fromCents(charm ? charmRound(target, target - 99, target) : target);
}

/**
 * Picks an eBay price strictly between +minPct% and +maxPct% of the Shopify price,
 * positioned just under the cheapest identical brand-new competitor when possible.
 */
export function recommend(base: number, market: MarketStats, rules: PricingRules): Recommendation {
  const { floor, ceiling } = bounds(base, rules);
  const mid = toCents(base * (1 + (rules.minPct + rules.maxPct) / 200));
  let target: number;
  let position: Position;
  let reason: string;

  const anchor = market.activeMin ?? market.soldMedian;
  if (anchor === null || !Number.isFinite(anchor)) {
    target = mid;
    position = 'no_data';
    reason = 'No matching brand-new listings found; using the middle of your markup range.';
  } else {
    const ship = market.activeMin !== null ? (rules.ownShipping ?? 0) : 0;
    const desired = toCents(anchor) - toCents(market.activeMin !== null ? rules.undercut : 0) - toCents(ship);
    const source =
      market.activeMin !== null
        ? `lowest active new listing ($${anchor.toFixed(2)} incl. shipping${ship ? `; your ~$${ship.toFixed(2)} shipping is deducted` : ''})`
        : `median sold price ($${anchor.toFixed(2)})`;
    if (desired < floor) {
      target = floor;
      position = 'market_below_floor';
      reason = `Market is cheaper than your floor: ${source} is below +${rules.minPct}%. Holding at the floor.`;
    } else if (desired > ceiling) {
      target = ceiling;
      position = 'market_above_ceiling';
      reason = `Market is above your ceiling: ${source}. Priced at the +${rules.maxPct}% cap; you are the cheapest.`;
    } else {
      target = desired;
      position = 'in_range';
      reason = `Undercutting the ${source} while staying in your markup range.`;
    }
  }

  target = clamp(target, floor, ceiling);
  const cents = rules.charm ? charmRound(target, floor, ceiling) : target;
  return { price: fromCents(cents), pct: pctOf(fromCents(cents), base), floor: fromCents(floor), ceiling: fromCents(ceiling), position, reason };
}

export function effectiveBase(price: number, compareAt: number | null, useSalePrice: boolean): number {
  return !useSalePrice && compareAt && compareAt > price ? compareAt : price;
}

/** eBay's final value fee applies to the total the buyer pays (item + shipping). */
export function estimateProfit(price: number, opts: { cost: number | null; feePct: number; fixedFee: number; shipping: number; shippingCharged?: number }) {
  const charged = opts.shippingCharged ?? 0;
  const fees = +((price + charged) * (opts.feePct / 100) + opts.fixedFee).toFixed(2);
  const net = +(price + charged - fees - opts.shipping - (opts.cost ?? 0)).toFixed(2);
  return { fees, net, margin: price > 0 ? +((net / price) * 100).toFixed(1) : 0, hasCost: opts.cost !== null };
}

/** Best Offer thresholds: auto-accept at/above acceptPct markup, auto-decline anything below the floor. */
export function bestOfferThresholds(price: number, base: number, rules: PricingRules, acceptPct: number, autoDecline: boolean) {
  const { floor } = bounds(base, rules);
  const listCents = toCents(price);
  let accept = clamp(toCents(base * (1 + acceptPct / 100)), floor, listCents - 1);
  const decline = autoDecline ? floor - 1 : null;
  if (accept <= floor || accept >= listCents) accept = 0;
  return {
    autoAccept: accept ? fromCents(accept) : null,
    autoDecline: decline !== null && decline > 0 && (!accept || decline < accept) && decline < listCents ? fromCents(decline) : null,
  };
}

export function stats(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { min: null, median: null, avg: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { min: v[0], median: +median.toFixed(2), avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) };
}

/** Returns a reason string if a price change looks dangerous and should be held for review. */
export function guardPriceChange(oldPrice: number | null, newPrice: number, guardPct: number): string | null {
  if (!Number.isFinite(newPrice) || newPrice <= 0) return `Invalid price ${newPrice}`;
  if (oldPrice && guardPct > 0) {
    const change = Math.abs(newPrice - oldPrice) / oldPrice;
    if (change * 100 > guardPct) return `Price change of ${(change * 100).toFixed(0)}% ($${oldPrice.toFixed(2)} -> $${newPrice.toFixed(2)}) exceeds the ${guardPct}% safety limit`;
  }
  return null;
}
