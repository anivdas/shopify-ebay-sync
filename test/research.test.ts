import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ses-test-'));
const { titleMatches } = await import('../src/research.ts');

test('title matching requires brand and model numbers', () => {
  assert.ok(titleMatches('NEW Sony WH-1000XM5 Wireless Headphones Black', 'Sony', 'WH-1000XM5 Headphones'));
  assert.ok(!titleMatches('Sony WH-1000XM4 Wireless Headphones', 'Sony', 'WH-1000XM5 Headphones'));
  assert.ok(!titleMatches('Bose QC45 Headphones', 'Sony', 'Wireless Headphones'));
  assert.ok(titleMatches('Apple AirPods Pro 2nd Gen USB-C', 'Apple', 'AirPods Pro 2nd Gen'));
});
