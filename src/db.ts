import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';

mkdirSync(config.dataDir, { recursive: true });
export const dbPath = path.join(config.dataDir, 'app.db');
export const db = new DatabaseSync(dbPath);

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category_id TEXT,
  category_name TEXT,
  fulfillment_policy_id TEXT,
  payment_policy_id TEXT,
  return_policy_id TEXT,
  merchant_location_key TEXT,
  title_template TEXT,
  description_template TEXT,
  default_aspects TEXT NOT NULL DEFAULT '{}',
  best_offer_enabled INTEGER,
  markup_min_pct REAL,
  markup_max_pct REAL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS ebay_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'single',
  group_key TEXT UNIQUE,
  shopify_product_id TEXT NOT NULL,
  product_title TEXT,
  brand TEXT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category_id TEXT,
  category_name TEXT,
  aspects TEXT NOT NULL DEFAULT '{}',
  description_html TEXT NOT NULL DEFAULT '',
  image_urls TEXT NOT NULL DEFAULT '[]',
  condition TEXT NOT NULL DEFAULT 'NEW',
  varies_by TEXT NOT NULL DEFAULT '[]',
  fulfillment_policy_id TEXT,
  payment_policy_id TEXT,
  return_policy_id TEXT,
  merchant_location_key TEXT,
  best_offer_enabled INTEGER NOT NULL DEFAULT 0,
  locked_fields TEXT NOT NULL DEFAULT '[]',
  ebay_listing_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  last_error TEXT,
  last_sale_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_listing_product ON ebay_listings (shopify_product_id);

CREATE TABLE IF NOT EXISTS listing_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES ebay_listings(id) ON DELETE CASCADE,
  shopify_variant_id TEXT NOT NULL UNIQUE,
  shopify_inventory_item_id TEXT,
  sku TEXT NOT NULL UNIQUE,
  variant_title TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  barcode TEXT,
  mpn TEXT,
  image_url TEXT,
  offer_id TEXT,
  shopify_price REAL,
  shopify_compare_at REAL,
  shopify_qty INTEGER,
  shopify_status TEXT,
  inventory_tracked INTEGER NOT NULL DEFAULT 1,
  unit_cost REAL,
  ebay_price REAL,
  ebay_qty INTEGER,
  markup_pct REAL,
  price_locked INTEGER NOT NULL DEFAULT 0,
  manual_price REAL,
  held_price REAL,
  held_reason TEXT,
  last_synced_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_listing ON listing_items (listing_id);
CREATE INDEX IF NOT EXISTS idx_items_inv ON listing_items (shopify_inventory_item_id);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_variant_id TEXT NOT NULL,
  taken_at TEXT NOT NULL DEFAULT ${NOW},
  match_type TEXT NOT NULL,
  query TEXT,
  active_count INTEGER NOT NULL DEFAULT 0,
  active_min REAL,
  active_median REAL,
  active_avg REAL,
  sold_available INTEGER NOT NULL DEFAULT 0,
  sold_count INTEGER NOT NULL DEFAULT 0,
  sold_qty INTEGER NOT NULL DEFAULT 0,
  sold_min REAL,
  sold_median REAL,
  sold_avg REAL,
  base_price REAL,
  recommended_price REAL,
  recommended_pct REAL,
  reason TEXT,
  comps TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_snap_variant ON market_snapshots (shopify_variant_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS processed_orders (
  order_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  ebay_listing_id TEXT,
  quantity INTEGER NOT NULL,
  unit_price REAL,
  total REAL,
  status TEXT NOT NULL,
  message TEXT,
  ordered_at TEXT,
  processed_at TEXT NOT NULL DEFAULT ${NOW},
  PRIMARY KEY (order_id, line_item_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON processed_orders (sku, ordered_at DESC);

CREATE TABLE IF NOT EXISTS finance_lines (
  transaction_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  order_id TEXT,
  transaction_type TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  booking TEXT,
  amount REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  sku TEXT,
  PRIMARY KEY (transaction_id, line_item_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_date ON finance_lines (transaction_date);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT ${NOW},
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (ts DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  name TEXT PRIMARY KEY,
  last_start TEXT,
  last_end TEXT,
  last_ok INTEGER,
  last_error TEXT,
  last_summary TEXT
);

CREATE TABLE IF NOT EXISTS retry_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL DEFAULT ${NOW},
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
`);

// ---- Lightweight migrations for columns added after the first release ----
function addColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('profiles', 'box_id', 'TEXT');
addColumn('ebay_listings', 'box_id', 'TEXT');
addColumn('listing_items', 'weight_value', 'REAL');
addColumn('listing_items', 'weight_unit', 'TEXT');

export type Row = Record<string, any>;

export const all = <T = Row>(sql: string, ...params: any[]) => db.prepare(sql).all(...params) as T[];
export const get = <T = Row>(sql: string, ...params: any[]) => db.prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);
export const nowIso = () => new Date().toISOString();

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const defaultSettings = {
  // pricing
  markupMinPct: 15,
  markupMaxPct: 17,
  undercutAmount: 0.01,
  charmPricing: true,
  autoReprice: true,
  useShopifySalePrice: true,
  priceGuardPct: 30,
  // Best Offer
  bestOfferDefault: false,
  bestOfferAutoAcceptPct: 16.5,
  bestOfferAutoDecline: true,
  // eBay fees (estimate until real fees arrive from the Finances API)
  ebayFeePct: 13.6,
  ebayFixedFee: 0.4,
  // shipping: what buyers typically pay you (calculated shipping varies) and what labels cost you
  buyerShippingEstimate: 0,
  avgShippingCost: 0,
  comparisonZip: '',
  // JSON array of { id, name, length, width, height, unit: 'INCH'|'CENTIMETER', emptyWeightOz, packageType }
  shippingBoxes: '[]',
  defaultBoxId: '',
  // inventory
  quantityBuffer: 0,
  maxListQuantity: 0,
  minShopifyQtyToList: 1,
  restockOnCancel: true,
  matchUnlinkedBySku: true,
  shopifyLocationId: '',
  // sync
  dryRun: false,
  syncIntervalMin: 5,
  ordersIntervalMin: 3,
  researchIntervalHours: 24,
  verifyIntervalHours: 6,
  financeIntervalHours: 6,
  standardsIntervalHours: 24,
  soldLookbackDays: 42,
  staleDays: 30,
  backupKeep: 14,
  // webhooks
  webhookPublicUrl: '',
  // eBay listing defaults
  ebayUsername: '',
  fulfillmentPolicyId: '',
  paymentPolicyId: '',
  returnPolicyId: '',
  merchantLocationKey: '',
  titleTemplate: '{brand} {title} {options}',
  descriptionTemplate: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:0 auto;color:#222;line-height:1.5">
  <h2 style="margin:0 0 12px">{{title}}</h2>
  <p style="background:#eef7ee;padding:8px 12px;border-radius:6px"><b>Condition:</b> Brand new.</p>
  <div>{{description}}</div>
  <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
  <h3>Shipping</h3><p>Ships fast with tracking on every order.</p>
  <h3>Returns</h3><p>See the returns section of this listing for details.</p>
</div>`,
  // alerts
  alertWebhookUrl: '',
  lowStockThreshold: 1,
};

export type Settings = typeof defaultSettings;

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key NOT LIKE 'state:%'`);
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...defaultSettings, ...stored };
}

export function updateSettings(patch: Partial<Record<keyof Settings, unknown>>): Settings {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in defaultSettings)) continue;
      const def = (defaultSettings as Record<string, unknown>)[key];
      const coerced = typeof def === 'number' ? Number(value) : typeof def === 'boolean' ? value === true || value === 'true' : String(value ?? '');
      if (typeof coerced === 'number' && !Number.isFinite(coerced)) continue;
      stmt.run(key, JSON.stringify(coerced));
    }
  });
  return getSettings();
}

export function getState<T>(key: string): T | undefined {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', `state:${key}`);
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setState(key: string, value: unknown) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `state:${key}`, JSON.stringify(value));
}

export function getToken(name: string): { value: string; expiresAt: number | null } | undefined {
  const row = get<{ value: string; expires_at: number | null }>('SELECT value, expires_at FROM tokens WHERE name = ?', name);
  if (!row) return undefined;
  try {
    return { value: decrypt(row.value), expiresAt: row.expires_at };
  } catch {
    return undefined;
  }
}

export function setToken(name: string, value: string, expiresAt: number | null) {
  run(
    'INSERT INTO tokens (name, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    name,
    encrypt(value),
    expiresAt,
  );
}

export const deleteToken = (name: string) => run('DELETE FROM tokens WHERE name = ?', name);

export function backupDatabase(): string {
  const dir = path.join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}
