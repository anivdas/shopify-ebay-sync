import { json, type Settings } from './db.ts';

export type Box = {
  id: string;
  name: string;
  length: number;
  width: number;
  height: number;
  unit: 'INCH' | 'CENTIMETER';
  emptyWeightOz: number;
  packageType: string;
};

export const PACKAGE_TYPES = ['MAILING_BOX', 'PACKAGE_THICK_ENVELOPE', 'PADDED_BAGS', 'LARGE_ENVELOPE', 'LETTER', 'TOUGH_BAGS', 'EXTRA_LARGE_PACK', 'BULKY_GOODS'];

export function getBoxes(settings: Settings): Box[] {
  return json<Partial<Box>[]>(settings.shippingBoxes, [])
    .filter((b) => b && b.id && b.length && b.width && b.height)
    .map((b) => ({
      id: String(b.id),
      name: String(b.name ?? b.id),
      length: Number(b.length),
      width: Number(b.width),
      height: Number(b.height),
      unit: b.unit === 'CENTIMETER' ? 'CENTIMETER' : 'INCH',
      emptyWeightOz: Number(b.emptyWeightOz ?? 0),
      packageType: PACKAGE_TYPES.includes(String(b.packageType)) ? String(b.packageType) : 'MAILING_BOX',
    }));
}

/** Listing's own box wins, then the profile's, then the default box. */
export function resolveBox(settings: Settings, ...ids: (string | null | undefined)[]): Box | null {
  const boxes = getBoxes(settings);
  for (const id of [...ids, settings.defaultBoxId]) {
    const box = id ? boxes.find((b) => b.id === id) : undefined;
    if (box) return box;
  }
  return null;
}

const TO_OZ: Record<string, number> = { OUNCES: 1, POUNDS: 16, GRAMS: 0.03527396, KILOGRAMS: 35.27396 };

/** Converts a Shopify weight (unit: GRAMS | KILOGRAMS | OUNCES | POUNDS) to ounces. */
export const toOunces = (value: number | null | undefined, unit: string | null | undefined) =>
  value && value > 0 ? value * (TO_OZ[String(unit).toUpperCase()] ?? 0) : 0;

/** eBay packageWeightAndSize: product weight + empty box weight, rounded up to 0.1 lb so labels are never under-charged. */
export function packageWeightAndSize(box: Box | null, productOz: number) {
  const totalOz = productOz + (box?.emptyWeightOz ?? 0);
  if (!box && totalOz <= 0) return undefined;
  return {
    ...(box ? { packageType: box.packageType, dimensions: { length: box.length, width: box.width, height: box.height, unit: box.unit } } : {}),
    ...(totalOz > 0 ? { weight: { value: Math.ceil((totalOz / 16) * 10) / 10, unit: 'POUND' } } : {}),
  };
}
