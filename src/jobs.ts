import { runAutoList } from './autolist.ts';
import { ebayConfigured, shopifyConfigured } from './credentials.ts';
import { all, getSettings, nowIso, run, type Settings } from './db.ts';
import { ebayConnected } from './ebay.ts';
import { logActivity } from './log.ts';
import { researchAll } from './research.ts';
import { backupAndPrune, checkSellerStandards, checkStale, processEbayOrders, syncFinances, syncShopifyToEbay, verifyListings } from './sync.ts';

type Job = { label: string; description: string; interval: (s: Settings) => number; fn: () => Promise<string> | string; needsShopify: boolean };

const MIN = 60_000;
const HOUR = 60 * MIN;

export const JOBS: Record<string, Job> = {
  orders: { label: 'eBay sales -> Shopify stock', description: 'Reduces Shopify stock when items sell on eBay', interval: (s) => s.ordersIntervalMin * MIN, fn: processEbayOrders, needsShopify: true },
  sync: { label: 'Shopify -> eBay price & stock', description: 'Pushes Shopify price/quantity changes to eBay', interval: (s) => s.syncIntervalMin * MIN, fn: () => syncShopifyToEbay(), needsShopify: true },
  autolist: { label: 'Rules & auto-listing', description: 'Lists products once they stop matching an exclusion rule (e.g. preorders)', interval: () => 30 * MIN, fn: runAutoList, needsShopify: true },
  research: { label: 'Market price research', description: 'Checks active & sold brand-new comps on eBay', interval: (s) => s.researchIntervalHours * HOUR, fn: researchAll, needsShopify: false },
  verify: { label: 'Listing health check', description: 'Compares live eBay listings with expected values', interval: (s) => s.verifyIntervalHours * HOUR, fn: verifyListings, needsShopify: true },
  finances: { label: 'eBay fees & payouts', description: 'Imports real eBay fees for profit reports', interval: (s) => s.financeIntervalHours * HOUR, fn: syncFinances, needsShopify: false },
  standards: { label: 'Seller standards', description: 'Watches your eBay seller level', interval: (s) => s.standardsIntervalHours * HOUR, fn: checkSellerStandards, needsShopify: false },
  stale: { label: 'Stale listings', description: 'Flags listings with no recent sales', interval: () => 24 * HOUR, fn: checkStale, needsShopify: false },
  backup: { label: 'Database backup', description: 'Nightly backup of the app database', interval: () => 24 * HOUR, fn: backupAndPrune, needsShopify: false },
};

let chain: Promise<unknown> = Promise.resolve();
const running = new Set<string>();

/** Jobs run one at a time so they never fight over the same rows or API rate limits. */
export function enqueue<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const p = chain.then(async () => {
    running.add(name);
    try {
      return await fn();
    } finally {
      running.delete(name);
    }
  });
  chain = p.catch(() => undefined);
  return p;
}

export function runJob(name: string): Promise<string> {
  const job = JOBS[name];
  if (!job) return Promise.reject(new Error(`Unknown job ${name}`));
  run(`INSERT INTO job_runs (name, last_start) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_start = excluded.last_start`, name, nowIso());
  return enqueue(name, async () => {
    try {
      const summary = await job.fn();
      run('UPDATE job_runs SET last_end = ?, last_ok = 1, last_error = NULL, last_summary = ? WHERE name = ?', nowIso(), summary, name);
      return summary;
    } catch (e) {
      const message = (e as Error).message;
      run('UPDATE job_runs SET last_end = ?, last_ok = 0, last_error = ? WHERE name = ?', nowIso(), message, name);
      logActivity('error', `job.${name}`, `${job.label} failed: ${message}`);
      throw e;
    }
  });
}

export function jobStatus() {
  const rows = new Map(all<{ name: string; last_start: string; last_end: string; last_ok: number; last_error: string; last_summary: string }>('SELECT * FROM job_runs').map((r) => [r.name, r]));
  const settings = getSettings();
  return Object.entries(JOBS).map(([name, job]) => {
    const r = rows.get(name);
    const next = r?.last_start ? new Date(new Date(r.last_start).getTime() + job.interval(settings)).toISOString() : null;
    return { name, label: job.label, description: job.description, running: running.has(name), lastStart: r?.last_start ?? null, lastEnd: r?.last_end ?? null, ok: r ? !!r.last_ok : null, error: r?.last_error ?? null, summary: r?.last_summary ?? null, next };
  });
}

const ready = (job: Job) => ebayConfigured() && ebayConnected() && (!job.needsShopify || shopifyConfigured());

export function startScheduler() {
  const tick = () => {
    const settings = getSettings();
    const rows = new Map(all<{ name: string; last_start: string | null }>('SELECT name, last_start FROM job_runs').map((r) => [r.name, r.last_start]));
    for (const [name, job] of Object.entries(JOBS)) {
      if (running.has(name) || !ready(job) || job.interval(settings) <= 0) continue;
      const last = rows.get(name);
      if (!last || Date.now() - new Date(last).getTime() >= job.interval(settings)) runJob(name).catch(() => undefined);
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, 30_000);
}

// --------- Shopify webhook debounce ---------
const pending = { inventory: new Set<string>(), products: new Set<string>() };
let timer: NodeJS.Timeout | null = null;

export function queueWebhookSync(kind: 'inventory' | 'products', id: string) {
  pending[kind].add(id);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const inventoryItemIds = [...pending.inventory];
    const productIds = [...pending.products];
    pending.inventory.clear();
    pending.products.clear();
    enqueue('webhook-sync', () => syncShopifyToEbay({ inventoryItemIds, productIds })).catch((e) => logActivity('error', 'webhook.sync', (e as Error).message));
  }, 4_000);
}
