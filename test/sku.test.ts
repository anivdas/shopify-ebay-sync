import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandCode, generateSku, isUsableSku, optionCode, productCode, uniquify } from '../src/sku.ts';

const opt = (...values: string[]) => values.map((value, i) => ({ name: `O${i}`, value }));

test('brand codes', () => {
  assert.equal(brandCode('Sony'), 'SONY');
  assert.equal(brandCode('Apple'), 'APPL');
  assert.equal(brandCode('Bang & Olufsen'), 'BANGO');
  assert.equal(brandCode('The North Face'), 'NORTF');
  assert.equal(brandCode('Procter and Gamble Co'), 'PGC');
  assert.equal(brandCode(''), 'GEN');
  assert.equal(brandCode('Lévi’s'), 'LEVIS');
});

test('product codes prefer model numbers', () => {
  assert.equal(productCode('Sony WH-1000XM5 Wireless Headphones', 'Sony'), 'WH1000XM5');
  assert.equal(productCode('NVIDIA GeForce RTX 4090 Founders', 'NVIDIA'), 'GEFRTX4090FO');
  assert.equal(productCode('Organic Cotton Crew Tee', 'Acme'), 'ORGCOTCRETEE');
  assert.equal(productCode('Widget', 'Acme'), 'WIDGET');
});

test('option codes', () => {
  assert.equal(optionCode('Black'), 'BLK');
  assert.equal(optionCode('Space Gray'), 'SPCGRY');
  assert.equal(optionCode('Extra Large'), 'XL');
  assert.equal(optionCode('XL'), 'XL');
  assert.equal(optionCode('10.5'), '105');
  assert.equal(optionCode('64GB'), '64GB');
  assert.equal(optionCode('Default Title'), '');
  assert.equal(optionCode('Vanilla Bean'), 'VABE');
});

test('full SKUs are readable, valid and deterministic', () => {
  const a = generateSku({ vendor: 'Sony', title: 'WH-1000XM5 Wireless Headphones', options: opt('Black') });
  assert.equal(a, 'SONY-WH1000XM5-BLK');
  assert.equal(generateSku({ vendor: 'Acme', title: 'Organic Cotton Crew Tee', options: opt('Navy', 'XL') }), 'ACME-ORGCOTCRETEE-NAV-XL');
  assert.equal(generateSku({ vendor: 'Acme', title: 'Mug', options: opt('Default Title') }), 'ACME-MUG');
  assert.equal(a, generateSku({ vendor: 'Sony', title: 'WH-1000XM5 Wireless Headphones', options: opt('Black') }));
  const long = generateSku({ vendor: 'A Very Long Brand Name Incorporated', title: 'x'.repeat(200), options: opt('y'.repeat(50), 'z'.repeat(50)) });
  assert.ok(isUsableSku(long) && long.length <= 50, long);
});

test('uniquify resolves collisions case-insensitively', () => {
  const taken = new Set(['ACME-MUG']);
  assert.equal(uniquify('ACME-MUG', taken), 'ACME-MUG-2');
  assert.equal(uniquify('acme-mug', taken), 'acme-mug-3');
  assert.equal(uniquify('ACME-CUP', taken), 'ACME-CUP');
});

test('isUsableSku', () => {
  assert.ok(isUsableSku('ABC-123_x.1'));
  assert.ok(!isUsableSku(''));
  assert.ok(!isUsableSku('has space'));
  assert.ok(!isUsableSku('x'.repeat(51)));
});
