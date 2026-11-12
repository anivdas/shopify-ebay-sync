import { getSettings, getState, setState } from './db.ts';
import { logActivity } from './log.ts';
import * as shopify from './shopify.ts';
import { generateSku, isUsableSku, uniquify } from './sku.ts';

export type IssueCode = 'sku_missing' | 'sku_duplicate' | 'sku_invalid' | 'barcode_missing' | 'barcode_invalid' | 'not_tracked' | 'no_weight' | 'no_cost' | 'no_vendor' | 'no_image' | 'small_image';

export const ISSUE_INFO: Record<IssueCode, { label: string; severity: 'high' | 'medium' | 'low'; help: string }> = {
  sku_missing: { label: 'No SKU', severity: 'high', help: 'eBay sales are matched to Shopify by SKU.' },
  sku_duplicate: { label: 'Duplicate SKU', severity: 'high', help: 'Two variants share a SKU, so a sale could reduce the wrong one.' },
  sku_invalid: { label: 'SKU not eBay-safe', severity: 'medium', help: 'Use letters, digits, dash, dot or underscore; max 50 characters.' },
  barcode_missing: { label: 'No UPC/EAN', severity: 'medium', help: 'Needed for exact price matching; many eBay categories require it for new items.' },
  barcode_invalid: { label: 'Invalid UPC/EAN', severity: 'medium', help: "The check digit doesn't match, or it isn't 12, 13 or 14 digits." },
  not_tracked: { label: 'Stock not tracked', severity: 'high', help: "Shopify isn't counting stock for this variant, so it can't sync." },
  no_weight: { label: 'No weight', severity: 'medium', help: 'Calculated shipping on eBay needs the product weight (Shopify product > Shipping > Weight).' },
  no_cost: { label: 'No cost', severity: 'low', help: 'Add "Cost per item" for profit reports.' },
  no_vendor: { label: 'No brand (vendor)', severity: 'medium', help: 'The vendor is used as the eBay Brand.' },
  no_image: { label: 'No photo', severity: 'high', help: 'eBay needs at least one photo.' },
  small_image: { label: 'Photo under 500px', severity: 'low', help: "eBay's minimum is 500px on the longest side." },
};

export type CatalogRow = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  vendor: string;
  status: string;
  sku: string | null;
  barcode: string | null;
  tracked: boolean;
  cost: number | null;
  qty: number | null;
  options: { name: string; value: string }[];
  image: string | null;
  issues: IssueCode[];
};

/** Validates the GS1 check digit of a UPC-A (12), EAN-13 or GTIN-14 barcode. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

let cache: { at: string; rows: CatalogRow[] } | null = null;

export async function scanCatalog(): Promise<{ at: string; rows: CatalogRow[] }> {
  const rows: CatalogRow[] = [];
  for await (const page of shopify.allVariants()) {
    for (const v of page) {
      const img = v.product.featuredMedia?.preview?.image ?? null;
      rows.push({
        variantId: v.id,
        productId: v.product.id,
        productTitle: v.product.title,
        variantTitle: v.title === 'Default Title' ? null : v.title,
        vendor: v.product.vendor,
        status: v.product.status,
        sku: v.sku?.trim() || null,
        barcode: shopify.pickBarcode(v.barcodes.nodes),
        tracked: v.inventoryItem.tracked,
        cost: v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) : null,
        qty: v.inventoryQuantity,
        options: v.selectedOptions.filter((o) => o.value !== 'Default Title'),
        image: img?.url ?? null,
        issues: [],
      });
      const r = rows[rows.length - 1];
      if (!r.sku) r.issues.push('sku_missing');
      else if (!isUsableSku(r.sku)) r.issues.push('sku_invalid');
      if (!r.barcode) r.issues.push('barcode_missing');
      else if (!isValidGtin(r.barcode)) r.issues.push('barcode_invalid');
      if (!r.tracked) r.issues.push('not_tracked');
      if (!(v.inventoryItem.measurement?.weight?.value && v.inventoryItem.measurement.weight.value > 0)) r.issues.push('no_weight');
      if (r.cost === null) r.issues.push('no_cost');
      if (!r.vendor?.trim()) r.issues.push('no_vendor');
      if (!img) r.issues.push('no_image');
      else if (img.width && img.height && Math.max(img.width, img.height) < 500) r.issues.push('small_image');
    }
  }
  const bySku = new Map<string, CatalogRow[]>();
  for (const r of rows) if (r.sku) bySku.set(r.sku.toUpperCase(), [...(bySku.get(r.sku.toUpperCase()) ?? []), r]);
  for (const group of bySku.values()) if (group.length > 1) for (const r of group) r.issues.push('sku_duplicate');
  cache = { at: new Date().toISOString(), rows };
  return cache;
}

export const cachedScan = () => cache;

export function summarize(rows: CatalogRow[]) {
  const counts = Object.fromEntries(Object.keys(ISSUE_INFO).map((k) => [k, 0])) as Record<IssueCode, number>;
  for (const r of rows) for (const i of r.issues) counts[i]++;
  return {
    variants: rows.length,
    products: new Set(rows.map((r) => r.productId)).size,
    healthy: rows.filter((r) => !r.issues.some((i) => ISSUE_INFO[i].severity !== 'low')).length,
    counts,
  };
}

export type SkuMode = 'missing' | 'problems' | 'all';

/** Proposes new SKUs. Existing good SKUs are never changed unless mode = 'all'. For duplicates, the first variant keeps its SKU. */
export function proposeSkus(rows: CatalogRow[], mode: SkuMode) {
  const seen = new Set<string>();
  const replace = new Set<string>();
  for (const r of rows) {
    const key = r.sku?.toUpperCase();
    const dupLater = !!key && seen.has(key);
    if (key) seen.add(key);
    if (mode === 'all' || !r.sku || (mode === 'problems' && (dupLater || r.issues.includes('sku_invalid')))) replace.add(r.variantId);
  }
  const taken = new Set(rows.filter((r) => r.sku && !replace.has(r.variantId)).map((r) => r.sku!.toUpperCase()));
  return rows
    .filter((r) => replace.has(r.variantId))
    .map((r) => ({
      variantId: r.variantId,
      productId: r.productId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      current: r.sku,
      proposed: uniquify(generateSku({ vendor: r.vendor, title: r.productTitle, options: r.options }), taken),
    }));
}

export type Change = { variantId: string; productId: string; sku?: string; barcode?: string; cost?: number | null; tracked?: boolean };

/** Writes changes to Shopify grouped by product and remembers the previous values so the batch can be undone. */
export async function applyChanges(changes: Change[], label: string) {
  if (getSettings().dryRun) throw new Error('Dry-run mode is on. Turn it off in Settings to change Shopify products.');
  const byVariant = new Map(cache?.rows.map((r) => [r.variantId, r]) ?? []);
  for (const c of changes) {
    if (c.sku && !isUsableSku(c.sku)) throw new Error(`"${c.sku}" is not a valid SKU`);
    if (c.barcode && !/^\d{8,14}$/.test(c.barcode)) throw new Error(`"${c.barcode}" is not a valid barcode (digits only)`);
  }
  const undo: Change[] = changes.map((c) => {
    const prev = byVariant.get(c.variantId);
    return {
      variantId: c.variantId,
      productId: c.productId,
      ...(c.sku !== undefined ? { sku: prev?.sku ?? '' } : {}),
      ...(c.barcode !== undefined ? { barcode: prev?.barcode ?? '' } : {}),
      ...(c.cost !== undefined ? { cost: prev?.cost ?? null } : {}),
      ...(c.tracked !== undefined ? { tracked: prev?.tracked ?? false } : {}),
    };
  });
  const groups = new Map<string, Change[]>();
  for (const c of changes) groups.set(c.productId, [...(groups.get(c.productId) ?? []), c]);
  const failed: { productId: string; error: string }[] = [];
  let done = 0;
  for (const [productId, list] of groups) {
    try {
      await shopify.updateVariants(productId, list.map(({ variantId, sku, barcode, cost, tracked }) => ({ id: variantId, sku, barcode, cost, tracked })));
      done += list.length;
      for (const c of list) {
        const row = byVariant.get(c.variantId);
        if (!row) continue;
        if (c.sku !== undefined) row.sku = c.sku || null;
        if (c.barcode !== undefined) row.barcode = c.barcode || null;
        if (c.cost !== undefined) row.cost = c.cost;
        if (c.tracked !== undefined) row.tracked = c.tracked;
      }
    } catch (e) {
      failed.push({ productId, error: (e as Error).message });
    }
  }
  const succeeded = new Set([...groups.keys()].filter((p) => !failed.some((f) => f.productId === p)));
  setState('catalogUndo', { label, at: new Date().toISOString(), changes: undo.filter((u) => succeeded.has(u.productId)) });
  logActivity(failed.length ? 'warn' : 'success', 'catalog', `${label}: updated ${done} variant(s) in Shopify${failed.length ? `, ${failed.length} product(s) failed` : ''}`, { failed });
  return { done, failed };
}

export const lastUndo = () => getState<{ label: string; at: string; changes: Change[] }>('catalogUndo') ?? null;

export async function undoLast() {
  const u = lastUndo();
  if (!u?.changes.length) throw new Error('Nothing to undo');
  const res = await applyChanges(u.changes, `Undo "${u.label}"`);
  setState('catalogUndo', null);
  return res;
}
