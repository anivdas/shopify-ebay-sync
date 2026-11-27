import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRetry } from '../src/http.ts';

const dropped = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code} api.ebay.com`), { code }) });
const mock = (failures: Error[]) => {
  let calls = 0;
  globalThis.fetch = (async () => {
    if (calls++ < failures.length) throw failures[calls - 1];
    return new Response('ok');
  }) as typeof fetch;
  return () => calls;
};

test('a DNS hiccup is retried and the request then succeeds', async () => {
  const calls = mock([dropped('EAI_AGAIN'), dropped('ENOTFOUND')]);
  const res = await fetchRetry('https://api.ebay.com/x', () => ({ method: 'POST' }), { delayMs: 1 });
  assert.equal(await res.text(), 'ok');
  assert.equal(calls(), 3);
});

test('a dropped connection is not retried for requests that are unsafe to repeat', async () => {
  const calls = mock([dropped('ECONNRESET')]);
  await assert.rejects(fetchRetry('https://api.ebay.com/x', () => ({ method: 'POST' }), { delayMs: 1 }), /Network error reaching api\.ebay\.com: ECONNRESET/);
  assert.equal(calls(), 1);
});

test('safe requests are retried on any network error, and the final error names the host and cause', async () => {
  const calls = mock([dropped('ECONNRESET'), dropped('ECONNRESET'), dropped('ECONNRESET'), dropped('ECONNRESET')]);
  await assert.rejects(fetchRetry('https://shop.myshopify.com/x', () => ({}), { idempotent: true, delayMs: 1 }), /shop\.myshopify\.com: ECONNRESET .*after 4 tries/);
  assert.equal(calls(), 4);
});
