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

const FORMAT_RULES: [inTitle: RegExp, inValue: RegExp, label: string][] = [
  [/\b(4K|UHD|Ultra HD)\b/i, /4K|UHD/i, '4K UHD'],
  [/\b3D\b/i, /3D/i, 'Blu-ray 3D'],
  [/\bBlu-?\s?ray\b/i, /Blu-?\s?ray/i, 'Blu-ray'],
  [/\bDVD\b/i, /DVD/i, 'DVD'],
];

/**
 * Infers the eBay "Format" from a product title. When eBay's allowed values are given,
 * returns the shortest matching allowed value (e.g. "Blu-ray" rather than "Blu-ray 3D").
 */
export function inferFormat(title: string, allowed: string[] = []): string | null {
  for (const [inTitle, inValue, label] of FORMAT_RULES) {
    if (!inTitle.test(title)) continue;
    if (!allowed.length) return label;
    const hit = allowed.filter((v) => inValue.test(v)).sort((a, b) => a.length - b.length)[0];
    if (hit) return hit;
  }
  return null;
}

type AspectDef = { name: string; values: string[]; freeText: boolean };

/**
 * Fills item specifics eBay requires/recommends for media from the product title and description,
 * using eBay's allowed values so they're accepted. Only returns aspects that are currently empty.
 */
export function inferAspects(input: { title: string; description?: string; brand?: string | null }, defs: AspectDef[], existing: Record<string, string[]> = {}): Record<string, string[]> {
  const text = `${input.title} ${input.description ?? ''}`;
  const pick = (d: AspectDef, re: RegExp, label: string) => d.values.filter((v) => re.test(v)).sort((a, b) => a.length - b.length)[0] ?? (d.freeText ? label : null);
  const out: Record<string, string[]> = {};
  for (const d of defs) {
    if (existing[d.name]?.length) continue;
    let v: string | null = null;
    if (/^format$/i.test(d.name)) v = inferFormat(input.title, d.values) ?? (d.freeText ? inferFormat(input.title) : null);
    else if (/movie.*title/i.test(d.name)) v = inferMovieTitle(input.title, input.brand);
    else if (/^case type$/i.test(d.name) && /steel\s?book/i.test(input.title)) v = pick(d, /steel\s?book/i, 'Steelbook');
    else if (/^region code$/i.test(d.name) && /region[\s-]*free|all regions/i.test(text)) v = pick(d, /region free|all region/i, 'Region Free');
    if (v) out[d.name] = [v];
  }
  return out;
}

/** Words that mark the end of the movie name in a typical product title. */
const TITLE_END = /\s(?:[-–|(\[]|\b(?:4K|UHD|Ultra HD|Blu-?\s?ray|DVD|3D|2D|Steelbook|Limited|Collector'?s|Special Edition|Deluxe|Anniversary|Director'?s Cut|Extended|Box Set|Complete Series|Season \d|Exclusive|Region|Slip ?cover|Lenticular|Full Slip|Mediabook)\b)/i;

/** Infers the eBay "Movie/TV Title" item specific: the part of the title before format/edition words. */
export function inferMovieTitle(title: string, brand?: string | null): string {
  let t = collapse(title);
  if (brand) t = t.replace(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*[:\\-|]?\\s*`, 'i'), '');
  const m = TITLE_END.exec(t);
  const name = (m && m.index > 0 ? t.slice(0, m.index) : t).replace(/[\s:,\-–|]+$/, '');
  return name || t;
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
  const body = tpl
    .replace(/\{\{\s*full_title\s*\}\}/g, full)
    .replace(/\{\{\s*title\s*\}\}/g, escHtml(vars.title))
    .replace(/\{\{\s*description\s*\}\}/g, normalizeStyles(sanitizeHtml(vars.description)));
  return sanitizeHtml(`<div style="${DESCRIPTION_STYLE}">\n${body}\n</div>`);
}

/** One font for every listing; set on a wrapper so template and Shopify content look the same. */
export const DESCRIPTION_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:900px;margin:0 auto';

/** Drops font/size/color styling pasted into Shopify descriptions; keeps bold, italics, alignment, lists, links. */
export function normalizeStyles(html: string): string {
  return html
    .replace(/<\/?font\b[^>]*>/gi, '')
    .replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (_, q, css: string) => {
      const kept = css
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !/^(font-family|font-size|font|color|line-height|background(-color)?|letter-spacing|word-spacing|text-shadow|mso-[\w-]+)\s*:/i.test(d));
      return kept.length ? ` style=${q}${kept.join(';')}${q}` : '';
    })
    .replace(/<span>([\s\S]*?)<\/span>/gi, '$1');
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
