import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-prof-'));
Object.assign(process.env, { SHOPIFY_SHOP: 's', SHOPIFY_ACCESS_TOKEN: 't' });

// Shopify: product 1 is tagged 3d-printed, product 2 is a movie
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const { variables } = JSON.parse(String(init?.body));
  const n = String(variables.id).split('/').pop();
  const product = { id: variables.id, title: n === '1' ? 'Dragon figure' : 'Alien 4K', handle: 'h', vendor: 'V', productType: '', status: 'ACTIVE', tags: n === '1' ? ['3d-printed'] : [], descriptionHtml: '', totalInventory: 1, featuredMedia: null, options: [], collections: { nodes: [] }, media: { nodes: [] }, variants: { nodes: [] } };
  return new Response(JSON.stringify({ data: { product } }));
}) as typeof fetch;

const { get: dbGet, run, updateSettings } = await import('../src/db.ts');
const L = await import('../src/listings.ts');
const { router } = await import('../src/routes.ts');
const call = async (method: string, url: string, body?: unknown) => {
  const u = new URL(url, 'http://x');
  const m = router.match(method, u.pathname)!;
  return (await m.route.handler({ params: m.params, query: u.searchParams, url: u, body } as any)) as any;
};

updateSettings({ fulfillmentPolicyId: 'MEDIA_MAIL', paymentPolicyId: 'PAY', returnPolicyId: 'RET', merchantLocationKey: 'loc' });
const printed = L.saveProfile({ name: '3D printed', fulfillment_policy_id: 'GROUND' } as any);
updateSettings({ profileRules: JSON.stringify([{ field: 'tag', value: '3d printed', profileId: printed.id }]) });
const listing = (n: number, extra = '') =>
  Number(run(`INSERT INTO ebay_listings (kind, shopify_product_id, product_title, title, fulfillment_policy_id ${extra ? ', status, ebay_listing_id' : ''}) VALUES ('single', ?, 'x', 'x', 'MEDIA_MAIL' ${extra})`, `gid://shopify/Product/${n}`).lastInsertRowid);
const policyOf = (id: number) => L.effectivePolicy(L.getListing(id)!, 'fulfillment_policy_id');

test('a listing uses its own policy, else its profile, else the default', () => {
  const id = listing(9);
  assert.equal(policyOf(id), 'MEDIA_MAIL');
  run('UPDATE ebay_listings SET fulfillment_policy_id = NULL WHERE id = ?', id);
  assert.equal(policyOf(id), 'MEDIA_MAIL', 'no profile: app default');
  run('UPDATE ebay_listings SET profile_id = ? WHERE id = ?', printed.id, id);
  assert.equal(policyOf(id), 'GROUND', 'profile wins over the default');
  assert.equal(L.inheritance(L.getListing(id)!).inherited.payment_policy_id.from, 'default', 'fields the profile leaves empty fall back to the default');
});

test('"Apply profile rules" moves matching listings to the profile and clears their own policy', async () => {
  const dragon = listing(1);
  const movie = listing(2);
  const r = await call('POST', '/api/listings/bulk-action', { ids: [dragon, movie], action: 'apply-rules' });
  assert.deepEqual(r.results.map((x: any) => x.note), ['3D printed', 'no rule matched']);
  assert.equal(policyOf(dragon), 'GROUND');
  assert.equal(L.getListing(dragon)!.fulfillment_policy_id, null, 'follows the profile from now on');
  assert.equal(policyOf(movie), 'MEDIA_MAIL', 'non-matching listings are untouched');
});

test('"Apply profile" can put listings on a profile or take them off', async () => {
  const id = listing(3);
  await call('POST', '/api/listings/bulk-action', { ids: [id], action: 'apply-profile', profileId: printed.id });
  assert.equal(policyOf(id), 'GROUND');
  await call('POST', '/api/listings/bulk-action', { ids: [id], action: 'apply-profile', profileId: null });
  assert.equal(L.getListing(id)!.profile_id, null);
  assert.equal(policyOf(id), 'MEDIA_MAIL');
});

test('changing a profile updates the live listings that follow it', async () => {
  const live = listing(4, ", 'published', '123'");
  L.applyProfile(live, printed.id);
  const r = await call('PUT', `/api/profiles/${printed.id}`, { ...printed, fulfillment_policy_id: 'PRIORITY' });
  assert.equal(r.updating, 1);
  assert.equal(policyOf(live), 'PRIORITY');
});

test('deleting a profile keeps what it gave its listings', () => {
  const p = L.saveProfile({ name: 'Temp', fulfillment_policy_id: 'TEMP', box_id: 'b1' } as any);
  const id = listing(5);
  L.applyProfile(id, p.id);
  L.deleteProfile(p.id);
  const l = dbGet<{ profile_id: number | null; fulfillment_policy_id: string; box_id: string }>('SELECT profile_id, fulfillment_policy_id, box_id FROM ebay_listings WHERE id = ?', id)!;
  assert.deepEqual([l.profile_id, l.fulfillment_policy_id, l.box_id], [null, 'TEMP', 'b1']);
});
