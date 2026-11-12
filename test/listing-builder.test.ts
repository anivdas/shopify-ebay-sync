import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAspects, ebayQuantity, ebaySku, gtinFields, optionsLabel, renderDescription, renderTitle, sanitizeHtml, smartTitle, truncateWords } from '../src/listing-builder.ts';

test('title template dedupes brand and limits to 80 chars', () => {
  assert.equal(renderTitle('{brand} {title} {options}', { brand: 'Sony', title: 'Sony WH-1000XM5 Headphones', options: 'Black' }), 'Sony WH-1000XM5 Headphones Black');
  assert.equal(renderTitle('{brand} {title}', { brand: 'Acme', title: 'Widget' }), 'Acme Widget');
  const long = renderTitle('{title}', { title: 'word '.repeat(40) });
  assert.ok(long.length <= 80);
  assert.ok(!long.endsWith(' '));
});

test('truncateWords cuts on word boundary', () => {
  assert.equal(truncateWords('alpha beta gamma', 12), 'alpha beta');
});

test('optionsLabel skips Default Title', () => {
  assert.equal(optionsLabel({ Title: 'Default Title' }), '');
  assert.equal(optionsLabel({ Color: 'Red', Size: 'XL' }), 'Red XL');
});

test('sanitizeHtml removes active content', () => {
  const out = sanitizeHtml('<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="x"></iframe><a href="javascript:evil()">l</a>');
  assert.equal(out, '<p>Hi</p><a href="#">l</a>');
});

test('renderDescription escapes title and inserts description', () => {
  assert.equal(renderDescription('<h1>{{title}}</h1>{{description}}', { title: 'A<B', description: '<b>x</b>', showFullTitle: false }), '<h1>A&lt;B</h1><b>x</b>');
});

test('renderDescription adds the full Shopify name on top unless the template places it', () => {
  const out = renderDescription('{{description}}', { title: 'Movie', fullTitle: 'Movie 4K Steelbook - Region Free', description: '<p>d</p>' });
  assert.match(out, /^<p[^>]*><b>This listing is for:<\/b> Movie 4K Steelbook - Region Free<\/p>/);
  const placed = renderDescription('<h2>{{full_title}}</h2>{{description}}', { title: 'Movie', fullTitle: 'Movie Full', description: '' });
  assert.equal(placed, '<h2>Movie Full</h2>');
});

test('smartTitle keeps short titles untouched', () => {
  assert.deepEqual(smartTitle('Sony WH-1000XM5 Headphones'), { title: 'Sony WH-1000XM5 Headphones', shortened: false, removed: [] });
});

test('smartTitle abbreviates before cutting words', () => {
  const r = smartTitle('The Lord of the Rings: The Return of the King 4K Ultra HD Blu-ray Disc + Digital Limited Edition Steelbook');
  assert.ok(r.title.length <= 80, r.title);
  assert.match(r.title, /4K UHD/);
  assert.match(r.title, /Steelbook/, 'keeps the end of the title thanks to abbreviations');
  assert.deepEqual(r.removed, []);
});

test('smartTitle tidies separators and duplicates first', () => {
  const r = smartTitle('Blade Runner 2049 | 4K Blu-ray | Steelbook | Brand New | Region Free | Blade Runner 2049 Collector Set Bonus Disc');
  assert.ok(r.title.length <= 80);
  assert.ok(!r.title.includes('|'));
  assert.equal((r.title.match(/2049/g) ?? []).length, 1);
});

test('smartTitle reports what was cut as a last resort', () => {
  const r = smartTitle('Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec');
  assert.ok(r.title.length <= 80);
  assert.ok(r.removed.length > 0);
  assert.ok(r.removed.includes('Quebec'));
});

test('gtinFields', () => {
  assert.deepEqual(gtinFields('012345678905'), { upc: ['012345678905'], aspect: ['UPC', '012345678905'] });
  assert.deepEqual(gtinFields('4006381333931').ean, ['4006381333931']);
  assert.deepEqual(gtinFields('ABC'), {});
  assert.deepEqual(gtinFields(null), {});
});

test('ebayQuantity applies buffer, max, minimum and status', () => {
  const base = { tracked: true, active: true, buffer: 0, max: 0, minToList: 1 };
  assert.equal(ebayQuantity(5, base), 5);
  assert.equal(ebayQuantity(5, { ...base, buffer: 2 }), 3);
  assert.equal(ebayQuantity(50, { ...base, max: 10 }), 10);
  assert.equal(ebayQuantity(1, { ...base, minToList: 2 }), 0);
  assert.equal(ebayQuantity(-3, base), 0);
  assert.equal(ebayQuantity(5, { ...base, active: false }), 0);
  assert.equal(ebayQuantity(null, { ...base, tracked: false, max: 3 }), 3);
});

test('ebaySku falls back for missing/long skus', () => {
  assert.equal(ebaySku('ABC-1', '99'), 'ABC-1');
  assert.equal(ebaySku('', '99'), 'SHV-99');
  assert.equal(ebaySku('x'.repeat(60), '99'), 'SHV-99');
});

test('cleanAspects normalizes', () => {
  assert.deepEqual(cleanAspects({ Brand: 'Sony', Color: ['Black', 'Black', ''], Empty: '' }), { Brand: ['Sony'], Color: ['Black'] });
});
