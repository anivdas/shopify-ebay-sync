import { all, get, getSettings, nowIso, run } from './db.ts';
import { createDrafts, getItems, getListing, publishListing, validateListing, type Listing } from './listings.ts';
import { logActivity } from './log.ts';
import { excludedReasonFor, excludeRules, profileFor, profileRules } from './rules.ts';
import * as shopify from './shopify.ts';

/** Publishes a draft if it passes validation; otherwise leaves it as a draft and alerts. */
async function tryPublish(listing: Listing, why: string): Promise<boolean> {
  const errors = (await validateListing(listing.id)).filter((i) => i.level === 'error');
  if (errors.length) {
    run('UPDATE ebay_listings SET auto_publish = 0 WHERE id = ?', listing.id);
    logActivity('warn', 'alert.autolist', `"${listing.title}" ${why}, but needs review before it can go live: ${errors.map((e) => e.message).join('; ')}`, { listingId: listing.id });
    return false;
  }
  await publishListing(listing.id, { skipValidation: true });
  return true;
}

/**
 * 1) Waiting drafts (created while excluded) publish once their product no longer matches a rule.
 * 2) With "auto-list when eligible" on: products seen while excluded (e.g. preorders) are remembered,
 *    and listed automatically when the rule stops matching (e.g. "preorder" removed from the title).
 */
export async function runAutoList(): Promise<string> {
  const settings = getSettings();
  const rules = excludeRules(settings);
  let published = 0;
  let drafted = 0;

  // ---- 1) waiting drafts ----
  const waiting = all<Listing>(`SELECT * FROM ebay_listings WHERE status IN ('draft','error') AND (auto_publish = 1 OR excluded_reason IS NOT NULL)`);
  for (const listing of waiting) {
    const item = getItems(listing.id)[0];
    if (!item) continue;
    const state = (await shopify.getVariantStates([item.shopify_variant_id])).get(item.shopify_variant_id);
    if (!state) continue;
    const reason = excludedReasonFor({ ...state.product, title: state.product.title ?? '' }, settings);
    if (reason !== listing.excluded_reason) run('UPDATE ebay_listings SET excluded_reason = ? WHERE id = ?', reason, listing.id);
    if (reason || !listing.auto_publish || !settings.autoPublish || settings.dryRun) continue;
    try {
      if (await tryPublish({ ...listing, excluded_reason: null }, 'is no longer excluded')) published++;
    } catch (e) {
      logActivity('error', 'autolist', `Auto-publishing "${listing.title}" failed: ${(e as Error).message}`);
    }
  }

  // ---- 2) watch excluded products, list them when they become eligible ----
  if (settings.autoListWhenEligible && (rules.length || settings.blockTag)) {
    const linked = new Set(all<{ shopify_product_id: string }>('SELECT DISTINCT shopify_product_id FROM ebay_listings').map((r) => r.shopify_product_id));
    for await (const page of shopify.allProductsForRules()) {
      for (const p of page) {
        if (linked.has(p.id) || p.status !== 'ACTIVE') continue;
        const reason = excludedReasonFor(p, settings);
        const watched = get<{ product_id: string }>('SELECT product_id FROM watched_products WHERE product_id = ?', p.id);
        if (reason) {
          run(
            `INSERT INTO watched_products (product_id, title, reason) VALUES (?, ?, ?)
             ON CONFLICT(product_id) DO UPDATE SET title = excluded.title, reason = excluded.reason, last_seen = ?`,
            p.id, p.title, reason, nowIso(),
          );
          continue;
        }
        if (!watched) continue;
        if (settings.dryRun) {
          logActivity('warn', 'autolist.dryrun', `Dry-run: would list "${p.title}" on eBay (no longer excluded)`);
          continue;
        }
        try {
          const ids = await createDrafts({ productId: p.id, mode: 'auto', profileId: profileFor(p, profileRules(settings)) });
          drafted += ids.length;
          run('DELETE FROM watched_products WHERE product_id = ?', p.id);
          for (const id of ids) {
            const listing = getListing(id)!;
            if (settings.autoPublish && (await tryPublish(listing, 'is no longer excluded'))) published++;
            else logActivity('info', 'autolist', `"${listing.title}" is no longer excluded; a draft was created for you to review`, { listingId: id });
          }
        } catch (e) {
          logActivity('error', 'autolist', `Could not auto-list "${p.title}": ${(e as Error).message}`);
        }
      }
    }
  }
  if (published) logActivity('success', 'autolist', `Auto-listed ${published} product(s) that are no longer excluded`);
  return `${published} published, ${drafted} drafted, ${waiting.length} waiting checked`;
}
