export const EBAY_TITLE_MAX = 80;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function truncateWords(s: string, max: number): string {
  s = collapse(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const idx = cut.lastIndexOf(' ');
  return (idx > max * 0.6 ? cut.slice(0, idx) : s.slice(0, max)).replace(/[\s,\-|/]+$/, '');
}

export type TitleVars = { brand?: string | null; title: string; options?: string; productType?: string | null; sku?: string | null };

/** Renders a title template like "{brand} {title} {options}" into an eBay-safe title (<= 80 chars). */
export function renderTitle(template: string, vars: TitleVars): string {
  const brand = collapse(vars.brand ?? '');
  const title = collapse(vars.title);
  const brandInTitle = brand && title.toLowerCase().includes(brand.toLowerCase());
  const out = (template || '{brand} {title} {options}')
    .replace(/\{brand\}/g, brandInTitle ? '' : brand)
    .replace(/\{title\}/g, title)
    .replace(/\{options\}/g, vars.options ?? '')
    .replace(/\{type\}/g, vars.productType ?? '')
    .replace(/\{sku\}/g, vars.sku ?? '');
  return truncateWords(out, EBAY_TITLE_MAX);
}

export function optionsLabel(options: Record<string, string>): string {
  return Object.values(options)
    .filter((v) => v && v.toLowerCase() !== 'default title')
    .join(' ');
}

/** Strips active content eBay rejects (scripts, iframes, forms, event handlers, js: urls). */
export function sanitizeHtml(html: string): string {
  return (html || '')
    .replace(/<(script|style|iframe|object|embed|form|noscript|link|meta)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim();
}

export const stripHtml = (html: string) =>
  collapse((html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));

export function renderDescription(template: string, vars: { title: string; description: string }): string {
  const esc = vars.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sanitizeHtml((template || '{{description}}').replace(/\{\{\s*title\s*\}\}/g, esc).replace(/\{\{\s*description\s*\}\}/g, sanitizeHtml(vars.description)));
}

export function gtinFields(barcode: string | null | undefined): { upc?: string[]; ean?: string[]; aspect?: [string, string] } {
  const digits = (barcode ?? '').replace(/\D/g, '');
  if (digits !== (barcode ?? '').trim() || !digits) return {};
  if (digits.length === 12) return { upc: [digits], aspect: ['UPC', digits] };
  if (digits.length === 13) return { ean: [digits], aspect: ['EAN', digits] };
  if (digits.length === 14) return { ean: [digits], aspect: ['EAN', digits] };
  return {};
}

export function ebayQuantity(shopifyQty: number | null, opts: { tracked: boolean; active: boolean; buffer: number; max: number; minToList: number; untrackedQty?: number }): number {
  if (!opts.active) return 0;
  if (!opts.tracked) return opts.max > 0 ? opts.max : (opts.untrackedQty ?? 1);
  const qty = Math.max(0, shopifyQty ?? 0);
  if (qty < Math.max(1, opts.minToList)) return 0;
  const listed = Math.max(0, qty - Math.max(0, opts.buffer));
  return opts.max > 0 ? Math.min(listed, opts.max) : listed;
}

/** Generates a stable eBay SKU (max 50 chars) when a Shopify variant has none or it's too long. */
export function ebaySku(shopifySku: string | null | undefined, variantNumericId: string): string {
  const sku = (shopifySku ?? '').trim();
  return sku && sku.length <= 50 && /^[\w\-.\/ ]+$/.test(sku) ? sku : `SHV-${variantNumericId}`;
}

export function cleanAspects(aspects: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(aspects ?? {})) {
    const name = collapse(k).slice(0, 65);
    const values = (Array.isArray(v) ? v : [v]).map((x) => collapse(String(x ?? '')).slice(0, 65)).filter(Boolean);
    if (name && values.length) out[name] = [...new Set(values)];
  }
  return out;
}
