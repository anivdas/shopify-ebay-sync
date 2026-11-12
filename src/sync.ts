import { readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { ebayConf } from './credentials.ts';
import { all, backupDatabase, get, getSettings, getState, nowIso, run, setState } from './db.ts';
import * as ebay from './ebay.ts';
import { getItems, getListing, offerPayload, rulesFor, targetPrice, targetQuantity, type Item, type Listing } from './listings.ts';
import { logActivity, pruneActivity } from './log.ts';
import { guardPriceChange } from './pricing.ts';
import * as shopify from './shopify.ts';

const LIVE = `('published','out_of_stock')`;

// ======================= Shopify -> eBay =======================

export async function syncShopifyToEbay(opts: { inventoryItemIds?: string[]; productIds?: string[] } = {}): Promise<string> {
  const settings = getSettings();
  let items = all<Item & { l_status: string }>(
    `SELECT i.*, l.status AS l_status FROM listing_items i JOIN ebay_listings l ON l.id = i.listing_id WHERE l.status IN ${LIVE} AND i.offer_id IS NOT NULL`,
  );
  if (opts.inventoryItemIds || opts.productIds) {
    const inv = new Set(opts.inventoryItemIds ?? []);
    const prods = new Set(opts.productIds ?? []);
    const listingIds = new Set(all<{ id: number }>('SELECT id FROM ebay_listings WHERE shopify_product_id IN (' + [...prods].map(() => '?').join(',') + ')', ...prods).map((r) => r.id));
    items = items.filter((i) => inv.has(i.shopify_inventory_item_id ?? '') || listingIds.has(i.listing_id));
  }
  if (!items.length) return 'nothing to sync';

  const states = await shopify.getVariantStates(items.map((i) => i.shopify_variant_id));
  const updates: ebay.PriceQtyUpdate[] = [];
  const fullOfferUpdates: { item: Item; listing: Listing; price: number; qty: number }[] = [];
  const touched = new Set<number>();

  for (const item of items) {
    const s = states.get(item.shopify_variant_id);
    const prevQty = item.shopify_qty;
    item.shopify_price = s ? Number(s.price) : item.shopify_price;
    item.shopify_compare_at = s?.compareAtPrice ? Number(s.compareAtPrice) : null;
    item.shopify_qty = s ? (s.inventoryQuantity ?? 0) : 0;
    item.shopify_status = s ? s.product.status : 'DELETED';
    item.inventory_tracked = s ? (s.inventoryItem.tracked ? 1 : 0) : 1;
    item.unit_cost = s?.inventoryItem.unitCost ? Number(s.inventoryItem.unitCost.amount) : item.unit_cost;
    run(
      'UPDATE listing_items SET shopify_price = ?, shopify_compare_at = ?, shopify_qty = ?, shopify_status = ?, inventory_tracked = ?, unit_cost = ? WHERE id = ?',
      item.shopify_price,
      item.shopify_compare_at,
      item.shopify_qty,
      item.shopify_status,
      item.inventory_tracked,
      item.unit_cost,
      item.id,
    );
    if (!s) logActivity('warn', 'alert.shopify', `Shopify variant for SKU ${item.sku} was deleted; setting eBay quantity to 0`);
    if (prevQty !== null && prevQty > settings.lowStockThreshold && item.shopify_qty <= settings.lowStockThreshold && item.shopify_qty > 0)
      logActivity('warn', 'alert.lowstock', `Low stock: ${item.sku} has ${item.shopify_qty} left in Shopify`);

    const listing = getListing(item.listing_id)!;
    const rules = rulesFor(listing, settings);
    const qty = targetQuantity(item, settings);
    let price = targetPrice(item, rules, settings);
    if (price !== null && price !== item.ebay_price) {
      const problem = guardPriceChange(item.ebay_price, price, settings.priceGuardPct);
      if (problem) {
        if (item.held_price !== price) {
          run('UPDATE listing_items SET held_price = ?, held_reason = ? WHERE id = ?', price, problem, item.id);
          logActivity('warn', 'alert.guard', `Price change held for review on ${item.sku}: ${problem}`, { itemId: item.id });
        }
        price = item.ebay_price;
      } else if (item.held_price !== null) {
        run('UPDATE listing_items SET held_price = NULL, held_reason = NULL WHERE id = ?', item.id);
      }
    }
    const priceChanged = price !== null && price !== item.ebay_price;
    const qtyChanged = qty !== item.ebay_qty;
    if (!priceChanged && !qtyChanged) continue;
    touched.add(item.listing_id);
    if (priceChanged && listing.best_offer_enabled) fullOfferUpdates.push({ item, listing, price: price!, qty });
    else updates.push({ sku: item.sku, offerId: item.offer_id!, quantity: qtyChanged ? qty : undefined, price: priceChanged ? price! : undefined });
    item.ebay_qty = qty;
    item.ebay_price = price;
  }

  if (settings.dryRun) {
    const n = updates.length + fullOfferUpdates.length;
    if (n) logActivity('warn', 'sync.dryrun', `Dry-run: would update ${n} eBay offer(s)`, { updates, full: fullOfferUpdates.map((f) => f.item.sku) });
    return `dry-run: ${n} pending`;
  }

  let ok = 0;
  let failed = 0;
  const results = updates.length ? await ebay.bulkUpdatePriceQuantity(updates) : [];
  for (const u of updates) {
    const r = results.find((x) => x.sku === u.sku);
    if (r?.ok) {
      ok++;
      const sets = ['last_synced_at = ?', 'last_error = NULL'];
      const vals: unknown[] = [nowIso()];
      if (u.quantity !== undefined) sets.push('ebay_qty = ?'), vals.push(u.quantity);
      if (u.price !== undefined) sets.push('ebay_price = ?'), vals.push(u.price);
      run(`UPDATE listing_items SET ${sets.join(', ')} WHERE sku = ?`, ...vals, u.sku);
    } else {
      failed++;
      run('UPDATE listing_items SET last_error = ? WHERE sku = ?', r?.error ?? 'Unknown eBay error', u.sku);
      logActivity('error', 'sync.push', `eBay update failed for ${u.sku}: ${r?.error ?? 'unknown error'}`);
    }
  }
  for (const f of fullOfferUpdates) {
    try {
      await ebay.upsertOffer(offerPayload(f.listing, f.item, f.price, f.qty, settings), f.item.offer_id);
      run('UPDATE listing_items SET ebay_price = ?, ebay_qty = ?, last_synced_at = ?, last_error = NULL WHERE id = ?', f.price, f.qty, nowIso(), f.item.id);
      ok++;
    } catch (e) {
      failed++;
      run('UPDATE listing_items SET last_error = ? WHERE id = ?', (e as Error).message, f.item.id);
      logActivity('error', 'sync.push', `eBay offer update failed for ${f.item.sku}: ${(e as Error).message}`);
    }
  }
  for (const listingId of touched) await reconcileListingStatus(listingId);
  if (ok) logActivity('info', 'sync.push', `Updated ${ok} eBay offer(s) from Shopify`);
  return `${ok} updated, ${failed} failed, ${items.length} checked`;
}

/** Marks listings out-of-stock at 0 and republishes them automatically if eBay ended them. */
async function reconcileListingStatus(listingId: number) {
  const listing = getListing(listingId);
  if (!listing) return;
  const items = getItems(listingId);
  const total = items.reduce((s, i) => s + (i.ebay_qty ?? 0), 0);
  if (total === 0) {
    if (listing.status !== 'out_of_stock') {
      run(`UPDATE ebay_listings SET status = 'out_of_stock', updated_at = ? WHERE id = ?`, nowIso(), listingId);
      logActivity('info', 'listing.oos', `"${listing.title}" is out of stock on eBay`);
    }
    return;
  }
  if (listing.status === 'out_of_stock') {
    try {
      const offer = await ebay.getOffer(items[0].offer_id!);
      if (offer.status !== 'PUBLISHED' || offer.listing?.listingStatus === 'ENDED') {
        const res = listing.kind === 'group' ? await ebay.publishGroup(listing.group_key!) : await ebay.publishOffer(items[0].offer_id!);
        run('UPDATE ebay_listings SET ebay_listing_id = ? WHERE id = ?', res.listingId, listingId);
        logActivity('success', 'listing.relisted', `Back in stock: relisted "${listing.title}" (eBay item ${res.listingId})`);
      }
      run(`UPDATE ebay_listings SET status = 'published', last_error = NULL, updated_at = ? WHERE id = ?`, nowIso(), listingId);
    } catch (e) {
      run('UPDATE ebay_listings SET last_error = ? WHERE id = ?', (e as Error).message, listingId);
      logActivity('error', 'listing.relist', `Could not relist "${listing.title}": ${(e as Error).message}`);
    }
  }
}

export function approveHeldPrice(itemId: number) {
  const item = get<Item>('SELECT * FROM listing_items WHERE id = ?', itemId);
  if (!item?.held_price) throw new Error('No held price for this item');
  // Setting ebay_price to null bypasses the guard for exactly one sync of this item
  run('UPDATE listing_items SET ebay_price = NULL, held_price = NULL, held_reason = NULL WHERE id = ?', itemId);
  logActivity('info', 'sync.guard', `Price change approved for ${item.sku}`);
}

// ======================= eBay orders -> Shopify =======================

const MAX_ATTEMPTS = 8;

async function applyLine(order: ebay.EbayOrder, line: ebay.EbayOrder['lineItems'][number]): Promise<{ status: string; message: string; inventoryItemId?: string }> {
  const settings = getSettings();
  const sku = line.sku?.trim();
  if (!sku) return { status: 'unmatched', message: 'eBay line has no SKU' };
  let invId = get<{ shopify_inventory_item_id: string }>('SELECT shopify_inventory_item_id FROM listing_items WHERE sku = ?', sku)?.shopify_inventory_item_id;
  if (!invId && settings.matchUnlinkedBySku) invId = (await shopify.findVariantBySku(sku))?.inventoryItem.id;
  if (!invId) return { status: 'unmatched', message: `No Shopify variant with SKU ${sku}` };
  if (settings.dryRun) return { status: 'dry_run', message: `Would reduce Shopify stock by ${line.quantity}`, inventoryItemId: invId };
  const res = await shopify.adjustInventory(invId, -line.quantity, `${order.orderId}:${line.lineItemId}`, settings.shopifyLocationId || undefined);
  return { status: 'applied', message: `Shopify ${res.locationName}: ${res.before} -> ${res.after}`, inventoryItemId: invId };
}

export async function processEbayOrders(): Promise<string> {
  const settings = getSettings();
  const cursor = getState<string>('ordersCursor');
  const runStart = new Date();
  if (!cursor) {
    setState('ordersCursor', runStart.toISOString());
    logActivity('info', 'orders', 'Order tracking started. eBay sales from now on will reduce Shopify stock.');
    return 'initialized';
  }
  const since = new Date(new Date(cursor).getTime() - 15 * 60_000).toISOString();
  const orders = await ebay.getOrdersModifiedSince(since);
  const affected = new Set<string>();
  let applied = 0;
  let restocked = 0;

  for (const order of orders) {
    const cancelled = order.cancelStatus?.cancelState === 'CANCELED';
    for (const line of order.lineItems) {
      const existing = get<{ status: string; message: string | null }>(
        'SELECT status, message FROM processed_orders WHERE order_id = ? AND line_item_id = ?',
        order.orderId,
        line.lineItemId,
      );
      const unitPrice = line.lineItemCost ? Number(line.lineItemCost.value) / Math.max(1, line.quantity) : null;
      const total = line.total ? Number(line.total.value) : null;

      if (cancelled) {
        if (existing?.status === 'applied' && settings.restockOnCancel && !settings.dryRun) {
          const invId = get<{ shopify_inventory_item_id: string }>('SELECT shopify_inventory_item_id FROM listing_items WHERE sku = ?', line.sku)?.shopify_inventory_item_id
            ?? (line.sku ? (await shopify.findVariantBySku(line.sku))?.inventoryItem.id : undefined);
          if (invId) {
            await shopify.adjustInventory(invId, line.quantity, `${order.orderId}:${line.lineItemId}:cancel`, settings.shopifyLocationId || undefined);
            run(`UPDATE processed_orders SET status = 'restocked', message = 'Order cancelled; stock returned to Shopify' WHERE order_id = ? AND line_item_id = ?`, order.orderId, line.lineItemId);
            logActivity('info', 'orders.cancel', `eBay order ${order.orderId} cancelled: returned ${line.quantity} x ${line.sku} to Shopify`);
            affected.add(invId);
            restocked++;
          }
        } else if (!existing) {
          run(
            `INSERT INTO processed_orders (order_id, line_item_id, sku, title, ebay_listing_id, quantity, unit_price, total, status, message, ordered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', 'Cancelled before processing', ?)`,
            order.orderId, line.lineItemId, line.sku ?? null, line.title, line.legacyItemId ?? null, line.quantity, unitPrice, total, order.creationDate,
          );
        }
        continue;
      }
      if (order.orderPaymentStatus === 'FAILED') continue;
      const attempts = existing?.status === 'error' ? Number(existing.message?.match(/^\[(\d+)\]/)?.[1] ?? 1) : 0;
      if (existing && (existing.status !== 'error' || attempts >= MAX_ATTEMPTS)) continue;

      try {
        const res = await applyLine(order, line);
        run(
          `INSERT INTO processed_orders (order_id, line_item_id, sku, title, ebay_listing_id, quantity, unit_price, total, status, message, ordered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id, line_item_id) DO UPDATE SET status = excluded.status, message = excluded.message, processed_at = excluded.processed_at`,
          order.orderId, line.lineItemId, line.sku ?? null, line.title, line.legacyItemId ?? null, line.quantity, unitPrice, total, res.status, res.message, order.creationDate,
        );
        if (res.status === 'applied') {
          applied++;
          affected.add(res.inventoryItemId!);
          run('UPDATE listing_items SET ebay_qty = MAX(0, COALESCE(ebay_qty, 0) - ?), shopify_qty = COALESCE(shopify_qty, 0) - ? WHERE sku = ?', line.quantity, line.quantity, line.sku);
          run(`UPDATE ebay_listings SET last_sale_at = ? WHERE id = (SELECT listing_id FROM listing_items WHERE sku = ?)`, order.creationDate, line.sku);
          logActivity('success', 'orders.sale', `eBay sale: ${line.quantity} x ${line.title} (${line.sku}). ${res.message}`, { orderId: order.orderId });
        } else if (res.status === 'unmatched') {
          logActivity('warn', 'alert.unmatched', `eBay order ${order.orderId}: "${line.title}" did not match any Shopify product (${res.message}). Adjust Shopify stock manually.`);
        }
      } catch (e) {
        const msg = `[${attempts + 1}] ${(e as Error).message}`;
        run(
          `INSERT INTO processed_orders (order_id, line_item_id, sku, title, ebay_listing_id, quantity, unit_price, total, status, message, ordered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, ?)
           ON CONFLICT(order_id, line_item_id) DO UPDATE SET status = 'error', message = excluded.message, processed_at = excluded.processed_at`,
          order.orderId, line.lineItemId, line.sku ?? null, line.title, line.legacyItemId ?? null, line.quantity, unitPrice, total, msg, order.creationDate,
        );
        logActivity(attempts + 1 >= MAX_ATTEMPTS ? 'error' : 'warn', 'orders.apply', `Could not reduce Shopify stock for eBay order ${order.orderId} (${line.sku}): ${msg}`);
      }
    }
  }
  setState('ordersCursor', runStart.toISOString());
  if (affected.size) await syncShopifyToEbay({ inventoryItemIds: [...affected] }).catch((e) => logActivity('error', 'sync', (e as Error).message));
  return `${orders.length} orders checked, ${applied} sales applied, ${restocked} restocked`;
}

// ======================= Verification / drift =======================

export async function verifyListings(): Promise<string> {
  const listings = all<Listing>(`SELECT * FROM ebay_listings WHERE status IN ${LIVE}`);
  let drift = 0;
  for (const listing of listings) {
    for (const item of getItems(listing.id)) {
      if (!item.offer_id) continue;
      try {
        const offer = await ebay.getOffer(item.offer_id);
        const qty = offer.availableQuantity ?? null;
        const price = offer.pricingSummary?.price?.value ? Number(offer.pricingSummary.price.value) : null;
        if ((qty !== null && qty !== item.ebay_qty) || (price !== null && price !== item.ebay_price)) {
          drift++;
          run('UPDATE listing_items SET ebay_qty = ?, ebay_price = ? WHERE id = ?', qty, price, item.id);
          logActivity('warn', 'verify.drift', `eBay values for ${item.sku} differ from expected (qty ${item.ebay_qty}->${qty}, price ${item.ebay_price}->${price}); correcting`);
        }
        const ended = offer.status !== 'PUBLISHED' || offer.listing?.listingStatus === 'ENDED';
        if (ended && listing.status === 'published' && (item.ebay_qty ?? 0) > 0) {
          run(`UPDATE ebay_listings SET status = 'ended', last_error = 'Ended on eBay outside this app' WHERE id = ?`, listing.id);
          logActivity('warn', 'alert.ended', `"${listing.title}" was ended on eBay outside this app. Republish it from the Listings page if needed.`);
        }
        if (offer.listing?.listingId && offer.listing.listingId !== listing.ebay_listing_id)
          run('UPDATE ebay_listings SET ebay_listing_id = ? WHERE id = ?', offer.listing.listingId, listing.id);
      } catch (e) {
        if (e instanceof ebay.EbayError && e.status === 404) {
          run(`UPDATE ebay_listings SET status = 'error', last_error = 'Offer no longer exists on eBay' WHERE id = ?`, listing.id);
          logActivity('error', 'verify', `Offer for ${item.sku} no longer exists on eBay`);
        } else throw e;
      }
    }
  }
  if (drift) await syncShopifyToEbay();
  return `${listings.length} listings verified, ${drift} corrected`;
}

// ======================= Finances (real fees) =======================

export async function syncFinances(): Promise<string> {
  const from = getState<string>('financeCursor') ?? new Date(Date.now() - 90 * 86400_000).toISOString();
  const runStart = new Date().toISOString();
  const txns = await ebay.getTransactions(new Date(new Date(from).getTime() - 2 * 86400_000).toISOString());
  const upsert = `INSERT INTO finance_lines (transaction_id, line_item_id, order_id, transaction_type, transaction_date, booking, amount, fees, sku)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transaction_id, line_item_id) DO UPDATE SET amount = excluded.amount, fees = excluded.fees, sku = excluded.sku`;
  for (const t of txns) {
    const sign = t.bookingEntry === 'DEBIT' ? -1 : 1;
    if (t.orderLineItems?.length) {
      for (const li of t.orderLineItems) {
        const fees = (li.marketplaceFees ?? []).reduce((s, f) => s + Number(f.amount.value), 0);
        const sku = get<{ sku: string }>('SELECT sku FROM processed_orders WHERE line_item_id = ?', li.lineItemId)?.sku ?? null;
        run(upsert, t.transactionId, li.lineItemId, t.orderId ?? null, t.transactionType, t.transactionDate, t.bookingEntry, sign * Number(li.feeBasisAmount?.value ?? 0), fees, sku);
      }
    } else {
      run(upsert, t.transactionId, '-', t.orderId ?? null, t.transactionType, t.transactionDate, t.bookingEntry, sign * Number(t.amount.value), Number(t.totalFeeAmount?.value ?? 0), null);
    }
  }
  setState('financeCursor', runStart);
  return `${txns.length} transactions`;
}

// ======================= Seller standards =======================

const LEVEL_RANK: Record<string, number> = { BELOW_STANDARD: 0, ABOVE_STANDARD: 1, TOP_RATED: 2 };

export async function checkSellerStandards(): Promise<string> {
  const profiles = await ebay.getSellerStandards();
  const program = `PROGRAM_${ebayConf().country}`;
  const mine = profiles.filter((p) => p.program === program || p.defaultProgram);
  const current = mine.find((p) => p.cycle.cycleType === 'CURRENT');
  const projected = mine.find((p) => p.cycle.cycleType === 'PROJECTED');
  const prev = getState<{ current?: string; projected?: string; weak?: string[] }>('sellerStandards');
  const weak = (projected?.metrics ?? []).filter((m) => current && LEVEL_RANK[m.level] < LEVEL_RANK[current.standardsLevel]).map((m) => m.name);
  setState('sellerStandards', { current: current?.standardsLevel, projected: projected?.standardsLevel, weak, profiles: mine, at: nowIso() });

  if (current && projected && LEVEL_RANK[projected.standardsLevel] < LEVEL_RANK[current.standardsLevel] && prev?.projected !== projected.standardsLevel) {
    logActivity('warn', 'alert.standards', `Your eBay seller level is projected to drop from ${current.standardsLevel} to ${projected.standardsLevel}. Weak metrics: ${weak.join(', ') || 'see dashboard'}`);
  } else if (weak.length && JSON.stringify(weak) !== JSON.stringify(prev?.weak ?? [])) {
    logActivity('warn', 'alert.standards', `eBay seller metrics near a level change: ${weak.join(', ')}`);
  }
  const refreshExp = ebay.refreshTokenExpiry();
  if (refreshExp && refreshExp - Date.now() < 30 * 86400_000) {
    logActivity('warn', 'alert.token', 'Your eBay connection expires within 30 days. Reconnect eBay in Settings to keep syncing.');
  }
  return `${current?.standardsLevel ?? 'unknown'} (projected ${projected?.standardsLevel ?? 'unknown'})`;
}

// ======================= Stale listings =======================

export function staleListings() {
  const days = getSettings().staleDays;
  return all<Listing>(
    `SELECT * FROM ebay_listings WHERE status = 'published'
       AND COALESCE(last_sale_at, published_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
    `-${days} days`,
  );
}

export function checkStale(): string {
  const stale = staleListings();
  const prev = new Set(getState<number[]>('staleIds') ?? []);
  const fresh = stale.filter((l) => !prev.has(l.id));
  setState('staleIds', stale.map((l) => l.id));
  if (fresh.length) {
    logActivity('warn', 'alert.stale', `${fresh.length} listing(s) have had no sales in ${getSettings().staleDays}+ days: ${fresh.slice(0, 5).map((l) => l.title).join('; ')}${fresh.length > 5 ? '...' : ''}`);
  }
  return `${stale.length} stale`;
}

// ======================= Maintenance =======================

export function backupAndPrune(): string {
  const file = backupDatabase();
  const dir = path.join(config.dataDir, 'backups');
  const keep = Math.max(1, getSettings().backupKeep);
  const files = readdirSync(dir).filter((f) => f.startsWith('app-') && f.endsWith('.db')).sort().reverse();
  for (const f of files.slice(keep)) unlinkSync(path.join(dir, f));
  pruneActivity();
  return `backup ${path.basename(file)}`;
}
