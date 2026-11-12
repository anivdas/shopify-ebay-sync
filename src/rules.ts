import { all, get, json, run, type Settings } from './db.ts';

export type RuleField = 'title' | 'tag' | 'type' | 'vendor' | 'collection';
export type Rule = { field: RuleField; value: string };
export type ProfileRule = Rule & { profileId: number };
export type OverrideMode = 'allow' | 'block';

export type RuleProduct = {
  id?: string;
  title: string;
  tags?: string[] | null;
  productType?: string | null;
  vendor?: string | null;
  collections?: string[] | null;
};

export const FIELD_LABELS: Record<RuleField, string> = {
  title: 'Title',
  tag: 'Tag',
  type: 'Product type',
  vendor: 'Vendor (brand)',
  collection: 'Collection',
};

const FIELDS = Object.keys(FIELD_LABELS) as RuleField[];
const norm = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();

function cleanRules<T extends Rule>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => r && FIELDS.includes(r.field) && String(r.value ?? '').trim())
    .map((r) => ({ ...r, value: String(r.value).trim() })) as T[];
}

export const excludeRules = (s: Settings) => cleanRules<Rule>(json(s.excludeRules, []));
export const profileRules = (s: Settings) => cleanRules<ProfileRule>(json(s.profileRules, [])).filter((r) => Number(r.profileId) > 0);

function values(p: RuleProduct, field: RuleField): string[] {
  if (field === 'title') return [p.title];
  if (field === 'tag') return p.tags ?? [];
  if (field === 'type') return p.productType ? [p.productType] : [];
  if (field === 'vendor') return p.vendor ? [p.vendor] : [];
  return p.collections ?? [];
}

/** "contains", case-insensitive; spaces, dashes and underscores are treated alike ("pre-order" = "pre order"). */
export function matches(p: RuleProduct, rule: Rule): boolean {
  const needle = norm(rule.value);
  return values(p, rule.field).some((v) => norm(v).includes(needle));
}

/** Keyword rules only (no exceptions). Returns a human-readable reason or null. */
export function exclusionReason(p: RuleProduct, rules: Rule[]): string | null {
  const hit = rules.find((r) => matches(p, r));
  return hit ? `${FIELD_LABELS[hit.field]} contains "${hit.value}"` : null;
}

export function profileFor(p: RuleProduct, rules: ProfileRule[]): number | null {
  return rules.find((r) => matches(p, r))?.profileId ?? null;
}

// ---------------- Exceptions ----------------

export const getOverride = (productId: string | undefined) =>
  productId ? (get<{ mode: OverrideMode }>('SELECT mode FROM product_overrides WHERE product_id = ?', productId)?.mode ?? null) : null;

export function setOverride(productId: string, mode: OverrideMode | null, title?: string) {
  if (!mode) return run('DELETE FROM product_overrides WHERE product_id = ?', productId);
  run(
    `INSERT INTO product_overrides (product_id, mode, title) VALUES (?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET mode = excluded.mode, title = COALESCE(excluded.title, product_overrides.title)`,
    productId,
    mode,
    title ?? null,
  );
}

export const listOverrides = () => all<{ product_id: string; mode: OverrideMode; title: string | null; created_at: string }>('SELECT * FROM product_overrides ORDER BY created_at DESC');

const hasTag = (p: RuleProduct, tag: string) => !!tag.trim() && (p.tags ?? []).some((t) => norm(t) === norm(tag));

export type Eligibility = { excluded: string | null; exception: string | null };

/**
 * Final decision for a product. Priority:
 *   1. "Never list" (app exception or block tag) -> excluded
 *   2. "Allow anyway" (app exception or allow tag) -> eligible, even if a keyword rule matches
 *   3. keyword rules (e.g. title contains "preorder")
 */
export function eligibility(p: RuleProduct, settings: Settings, override: OverrideMode | null = getOverride(p.id)): Eligibility {
  if (override === 'block') return { excluded: 'Never list on eBay (exception set in the app)', exception: 'block' };
  if (hasTag(p, settings.blockTag)) return { excluded: `Has the "${settings.blockTag}" tag (never list)`, exception: 'block-tag' };
  const rule = exclusionReason(p, excludeRules(settings));
  if (override === 'allow') return { excluded: null, exception: rule ? `Allowed despite: ${rule} (exception set in the app)` : 'Always allowed (exception set in the app)' };
  if (hasTag(p, settings.allowTag)) return { excluded: null, exception: rule ? `Allowed despite: ${rule} ("${settings.allowTag}" tag)` : null };
  return { excluded: rule, exception: null };
}

export const excludedReasonFor = (p: RuleProduct, settings: Settings) => eligibility(p, settings).excluded;
