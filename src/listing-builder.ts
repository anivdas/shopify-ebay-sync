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

/** Abbreviations buyers still search for. Applied (longest first) only when the title is too long. */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\b4K Ultra HD\b/gi, '4K UHD'],
  [/\bUltra HD\b/gi, 'UHD'],
  [/\bBlu-?ray Disc\b/gi, 'Blu-ray'],
  [/\bCollector'?s Edition\b/gi, 'Collectors Ed'],
  [/\bLimited Edition\b/gi, 'Ltd Ed'],
  [/\bSpecial Edition\b/gi, 'Special Ed'],
  [/\bDeluxe Edition\b/gi, 'Deluxe Ed'],
  [/\bAnniversary\b/gi, 'Anniv'],
  [/\bEdition\b/gi, 'Ed'],
  [/\bCollection\b/gi, 'Coll'],
  [/\bVolume\b/gi, 'Vol'],
  [/\bIncluding\b/gi, 'Incl'],
  [/\bIncludes\b/gi, 'Incl'],
  [/\bExclusive\b/gi, 'Excl'],
  [/\bWidescreen\b/gi, 'WS'],
  [/\bInternational\b/gi, 'Intl'],
  [/\bDirector'?s Cut\b/gi, 'Directors Cut'],
];
const FILLER = /\b(the|a|an|of|for|brand new|new)\b/gi;

export type SmartTitle = { title: string; shortened: boolean; removed: string[] };

/**
 * Fits a title into eBay's 80 characters while keeping as much meaning as possible:
 * 1) tidy separators/brackets and drop repeated words, 2) "and" -> "&", "with" -> "w/",
 * 3) common abbreviations, 4) drop filler words, 5) cut on a word boundary (reports what was cut).
 */
export function smartTitle(input: string, max = EBAY_TITLE_MAX): SmartTitle {
  let t = collapse(input);
  if (t.length <= max) return { title: t, shortened: false, removed: [] };
  const original = t;
  const steps: ((s: string) => string)[] = [
    (s) =>
      collapse(
        s
          .replace(/\s*[|•·~]\s*/g, ' ')
          .replace(/\s+[-–—]\s+/g, ' ')
          .replace(/[[\](){}]/g, ' ')
          .replace(/\s*,\s*/g, ' '),
      ),
    (s) => {
      const seen = new Set<string>();
      return s
        .split(' ')
        .filter((w) => {
          const k = w.toLowerCase();
          if (k.length > 2 && seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .join(' ');
    },
    (s) => collapse(s.replace(/\s+and\s+/gi, ' & ').replace(/\s+with\s+/gi, ' w/ ')),
    (s) => ABBREVIATIONS.reduce((acc, [re, rep]) => (acc.length > max ? acc.replace(re, rep) : acc), s),
    (s) => collapse(s.replace(FILLER, ' ')),
  ];
  for (const step of steps) {
    t = step(t);
    if (t.length <= max) return { title: t, shortened: true, removed: [] };
  }
  const cut = truncateWords(t, max);
  const kept = new Set(cut.toLowerCase().split(' '));
  const removed = t.split(' ').filter((w) => !kept.has(w.toLowerCase()));
  return { title: cut, shortened: cut !== original, removed };
}

export function composeTitle(template: string, vars: TitleVars): string {
  const brand = collapse(vars.brand ?? '');
  const title = collapse(vars.title);
  const brandInTitle = brand && title.toLowerCase().includes(brand.toLowerCase());
  return collapse(
    (template || '{brand} {title} {options}')
      .replace(/\{brand\}/g, brandInTitle ? '' : brand)
      .replace(/\{title\}/g, title)
      .replace(/\{options\}/g, vars.options ?? '')
      .replace(/\{type\}/g, vars.productType ?? '')
      .replace(/\{sku\}/g, vars.sku ?? ''),
  );
}

/** Renders a title template like "{brand} {title} {options}" into an eBay-safe title (<= 80 chars). */
export function renderTitle(template: string, vars: TitleVars): string {
  return smartTitle(composeTitle(template, vars)).title;
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

/** Infers eBay Format from a product title. Returns null if unclear. */
export function inferFormat(title: string): string | null {
  const t = title.toLowerCase();
  if (t.includes('4k') || t.includes('ultra hd')) return '4K UHD';
  if (t.includes('blu-ray') || t.includes('blu ray')) return 'Blu-ray';
  if (t.includes('dvd')) return 'DVD';
  return null;
}

/** Infers Movie/TV Title by removing format, edition, and vendor keywords. */
export function inferMovieTitle(title: string, brand?: string | null): string {
  let t = title;
  // Remove brand/vendor if present at start or end
  if (brand) {
    const brandLower = brand.toLowerCase();
    t = t.replace(new RegExp(`^${escapeRegex(brand)}\\s*[:\\-|]?\\s*`, 'i'), '');
    t = t.replace(new RegExp(`\\s*[:\\-|]?\\s*${escapeRegex(brand)}$`, 'i'), '');
  }
  // Remove format keywords
  t = t.replace(/\b(4K|4K UHD|Ultra HD|UHD|Blu-?ray|DVD|HD|SD)\b/gi, '');
  // Remove edition/collection keywords
  t = t.replace(/\b(Steelbook|Limited Edition|Collector'?s Edition|Special Edition|Deluxe Edition|Anniversary Edition|Director'?s Cut|Extended Cut|Theatrical Cut|Collection|Box Set)\b/gi, '');
  // Remove common suffixes
  t = t.replace(/\s*[:\-|]\s*$/, '');
  t = t.replace(/\s+\(.*?\)\s*$/, '');
  return collapse(t);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * {{title}} = product title, {{full_title}} = full Shopify name incl. variant, {{description}} = Shopify description.
 * If the template has no {{full_title}} and showFullTitle is on, a "This listing is for: ..." line is added on top,
 * so nothing is lost when the eBay title had to be shortened.
 */
export function renderDescription(template: string, vars: { title: string; description: string; fullTitle?: string; showFullTitle?: boolean }): string {
  const full = escHtml(collapse(vars.fullTitle ?? vars.title));
  let tpl = template || '{{description}}';
  if (vars.showFullTitle !== false && !/\{\{\s*full_title\s*\}\}/.test(tpl))
    tpl = `<p style="font-size:15px"><b>This listing is for:</b> {{full_title}}</p>\n${tpl}`;
  return sanitizeHtml(
    tpl
      .replace(/\{\{\s*full_title\s*\}\}/g, full)
      .replace(/\{\{\s*title\s*\}\}/g, escHtml(vars.title))
      .replace(/\{\{\s*description\s*\}\}/g, sanitizeHtml(vars.description)),
  );
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
