import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-aspects-'));
Object.assign(process.env, { EBAY_CLIENT_ID: 'c', EBAY_CLIENT_SECRET: 's', EBAY_RUNAME: 'r' });

const countries = Array.from({ length: 250 }, (_, i) => `Country ${String(i).padStart(3, '0')}`);
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
  if (url.includes('/oauth2/token')) return json({ access_token: 'x', expires_in: 7200 });
  if (url.includes('get_default_category_tree_id')) return json({ categoryTreeId: '0' });
  if (url.includes('get_item_aspects_for_category'))
    return json({
      aspects: [
        { localizedAspectName: 'Country of Origin', aspectConstraint: { aspectMode: 'SELECTION_ONLY' }, aspectValues: countries.map((c) => ({ localizedValue: c })) },
        { localizedAspectName: 'Actor', aspectConstraint: { aspectMode: 'FREE_TEXT' }, aspectValues: Array.from({ length: 1500 }, (_, i) => ({ localizedValue: `A${i}` })) },
      ],
    });
  throw new Error(`Unmocked ${url}`);
}) as typeof fetch;

const { getAspects } = await import('../src/ebay.ts');

test('selection-only aspect values are complete (countries past "S" were cut off)', async () => {
  const aspects = await getAspects('617');
  assert.equal(aspects.find((a) => a.name === 'Country of Origin')!.values.length, 250);
  assert.equal(aspects.find((a) => a.name === 'Actor')!.values.length, 1000, 'free-text suggestions are capped');
});
