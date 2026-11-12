/**
 * SKU generator: BRAND-MODEL-VARIANT, e.g.
 *   Sony "WH-1000XM5 Wireless Headphones" Black      -> SONY-WH1000XM5-BLK
 *   Acme "Organic Cotton Crew Tee" Navy / XL         -> ACME-ORGCOTCRE-NAV-XL
 *   Apple "AirPods Pro (2nd Gen)"                    -> APPL-AIRPODSPRO2
 * Rules: uppercase A-Z/0-9 and dashes, max 50 chars (eBay limit), deterministic,
 * and unique across the whole catalog (collisions get -2, -3, ...).
 */

const STOPWORDS = new Set(['THE', 'AND', 'FOR', 'WITH', 'OF', 'A', 'AN', 'IN', 'ON', 'TO', 'BY', 'NEW', 'BRAND', 'GENUINE', 'ORIGINAL', 'OFFICIAL', 'PACK', 'SET']);

const COLORS: Record<string, string> = {
  BLACK: 'BLK', WHITE: 'WHT', RED: 'RED', BLUE: 'BLU', GREEN: 'GRN', GREY: 'GRY', GRAY: 'GRY', NAVY: 'NAV', PINK: 'PNK',
  PURPLE: 'PUR', ORANGE: 'ORG', YELLOW: 'YEL', BROWN: 'BRN', BEIGE: 'BGE', SILVER: 'SLV', GOLD: 'GLD', ROSE: 'RSE',
  TAN: 'TAN', CREAM: 'CRM', IVORY: 'IVR', OLIVE: 'OLV', TEAL: 'TEL', MAROON: 'MRN', BURGUNDY: 'BRG', CHARCOAL: 'CHR',
  KHAKI: 'KHK', CLEAR: 'CLR', TRANSPARENT: 'CLR', MULTI: 'MLT', MULTICOLOR: 'MLT', SPACE: 'SPC', MIDNIGHT: 'MID', STARLIGHT: 'STR',
};

const SIZES: Record<string, string> = {
  'EXTRA SMALL': 'XS', 'X SMALL': 'XS', SMALL: 'S', MEDIUM: 'M', LARGE: 'L', 'EXTRA LARGE': 'XL', 'X LARGE': 'XL',
  'XX LARGE': 'XXL', 'XXX LARGE': '3XL', 'ONE SIZE': 'OS',
};

const clean = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function brandCode(vendor: string | null | undefined): string {
  const words = clean(vendor ?? '').split(' ').filter((w) => w && !STOPWORDS.has(w));
  if (!words.length) return 'GEN';
  // 3+ words -> initials ("Procter and Gamble Co" -> PGC); 2 words -> 4 letters + initial ("Bang & Olufsen" -> BANGO)
  if (words.length >= 3) return words.map((w) => w[0]).join('').slice(0, 5);
  return (words.length === 2 ? words[0].slice(0, 4) + words[1][0] : words[0].slice(0, 4)).slice(0, 5);
}

/** Model numbers look like WH-1000XM5, A2084, RTX4090, 1080P: letters and digits together, or long digit runs. */
function modelTokens(title: string): string[] {
  return (title.toUpperCase().match(/[A-Z0-9]+(?:[-./][A-Z0-9]+)*/g) ?? [])
    .map((t) => t.replace(/[-./]/g, ''))
    .filter((t) => t.length >= 4 && /\d/.test(t) && (/[A-Z]/.test(t) || t.length >= 5));
}

export function productCode(title: string, vendor?: string | null): string {
  const brandWords = new Set(clean(vendor ?? '').split(' '));
  const models = modelTokens(title);
  if (models.length) return models[0].slice(0, 12);
  const words = clean(title)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w) && !brandWords.has(w));
  if (!words.length) return 'ITEM';
  if (words.length === 1) return words[0].slice(0, 8);
  // Short words with digits ("2ND", "64GB") are kept whole; others contribute 3 letters
  return words
    .slice(0, 4)
    .map((w) => (/\d/.test(w) ? w : w.slice(0, 3)))
    .join('')
    .slice(0, 12);
}

export function optionCode(value: string): string {
  const v = clean(value);
  if (!v || v === 'DEFAULT TITLE') return '';
  if (SIZES[v]) return SIZES[v];
  if (/^(X{0,3}S|S|M|L|X{1,3}L|\d?XL|OS)$/.test(v)) return v;
  // Numbers with units: 10, 10.5 -> 105, 64GB, 1TB, 500ML
  if (/^\d[\d ]*[A-Z]{0,3}$/.test(v)) return v.replace(/ /g, '').slice(0, 6);
  const words = v.split(' ');
  const colorParts = words.map((w) => COLORS[w]).filter(Boolean);
  if (colorParts.length === words.length) return colorParts.join('').slice(0, 6);
  if (words.length === 1) return words[0].slice(0, 4);
  return words
    .map((w) => COLORS[w] ?? w.slice(0, 2))
    .join('')
    .slice(0, 6);
}

export type SkuInput = { vendor: string | null; title: string; options: { name: string; value: string }[] };

export function generateSku(input: SkuInput): string {
  const parts = [brandCode(input.vendor), productCode(input.title, input.vendor), ...input.options.map((o) => optionCode(o.value))].filter(Boolean);
  return parts.join('-').slice(0, 46).replace(/-+$/, '');
}

/** Valid for eBay and safe everywhere: 1-50 chars of letters, digits, dash, underscore, dot. */
export const isUsableSku = (sku: string | null | undefined) => !!sku && sku.trim().length > 0 && sku.length <= 50 && /^[A-Za-z0-9_.\-]+$/.test(sku.trim());

/** Makes `sku` unique against `taken` (case-insensitive) by appending -2, -3, ... */
export function uniquify(sku: string, taken: Set<string>): string {
  let candidate = sku;
  for (let n = 2; taken.has(candidate.toUpperCase()); n++) candidate = `${sku.slice(0, 46)}-${n}`;
  taken.add(candidate.toUpperCase());
  return candidate;
}
