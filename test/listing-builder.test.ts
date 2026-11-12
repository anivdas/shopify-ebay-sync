import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAspects, DESCRIPTION_STYLE, ebayQuantity, ebaySku, gtinFields, inferAspects, inferFormat, inferMovieTitle, normalizeStyles, optionsLabel, renderDescription, renderTitle, sanitizeHtml, smartTitle, truncateWords } from '../src/listing-builder.ts';

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

const unwrap = (html: string) => html.replace(new RegExp(`^<div style="${DESCRIPTION_STYLE}">\\n`), '').replace(/\n<\/div>$/, '');

test('renderDescription escapes title and inserts description in one consistent wrapper', () => {
  const out = renderDescription('<h1>{{title}}</h1>{{description}}', { title: 'A<B', description: '<b>x</b>', showFullTitle: false });
  assert.ok(out.startsWith(`<div style="${DESCRIPTION_STYLE}">`));
  assert.equal(unwrap(out), '<h1>A&lt;B</h1><b>x</b>');
});

test('renderDescription adds the full Shopify name on top (inside the wrapper) unless the template places it', () => {
  const out = unwrap(renderDescription('{{description}}', { title: 'Movie', fullTitle: 'Movie 4K Steelbook - Region Free', description: '<p>d</p>' }));
  assert.match(out, /^<p[^>]*><b>This listing is for:<\/b> Movie 4K Steelbook - Region Free<\/p>/);
  const placed = unwrap(renderDescription('<h2>{{full_title}}</h2>{{description}}', { title: 'Movie', fullTitle: 'Movie Full', description: '' }));
  assert.equal(placed, '<h2>Movie Full</h2>');
});

test('normalizeStyles removes pasted fonts and colors but keeps structure', () => {
  const html = '<p style="font-family:Times;font-size:18px;text-align:center;color:red"><font face="Comic Sans">Hi</font> <span style="font-size:20px">there</span> <b style="color:#000">bold</b></p>';
  assert.equal(normalizeStyles(html), '<p style="text-align:center">Hi there <b>bold</b></p>');
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

test('inferFormat detects format and maps to eBay allowed values', () => {
  assert.equal(inferFormat('Blade Runner 4K Ultra HD Blu-ray'), '4K UHD');
  assert.equal(inferFormat('Movie Blu-ray Steelbook'), 'Blu-ray');
  assert.equal(inferFormat('Movie DVD'), 'DVD');
  assert.equal(inferFormat('The Substance Blu-ray TheOn KimchiDVD Exclusive'), 'Blu-ray', 'DVD inside a word is ignored');
  assert.equal(inferFormat('Movie'), null);
  const allowed = ['Blu-ray', 'Blu-ray 3D', '4K UHD Blu-ray', 'DVD', 'HD DVD'];
  assert.equal(inferFormat('Dune 4K Blu-ray Steelbook', allowed), '4K UHD Blu-ray');
  assert.equal(inferFormat('Dune Blu-ray Steelbook', allowed), 'Blu-ray');
  assert.equal(inferFormat('Dune DVD', allowed), 'DVD');
});

test('inferMovieTitle extracts the movie name', () => {
  assert.equal(inferMovieTitle('Blade Runner 4K Ultra HD Blu-ray Steelbook'), 'Blade Runner');
  assert.equal(inferMovieTitle('The Matrix 4K UHD Limited Edition Steelbook', 'Warner'), 'The Matrix');
  assert.equal(inferMovieTitle('HDzeta Blade Runner 2049 Steelbook', 'HDzeta'), 'Blade Runner 2049');
  assert.equal(inferMovieTitle('The Substance 4K Blu-ray Steelbook TheOn KimchiDVD Exclusive #44 One Click Box Set'), 'The Substance');
  assert.equal(inferMovieTitle('The Substance (4K UHD + 2D Blu-ray) Steelbook Limited Edition'), 'The Substance');
  assert.equal(inferMovieTitle('Back to the Future - 40th Anniversary 4K'), 'Back to the Future');
  assert.equal(inferMovieTitle('Superman (2025) 4K Blu-ray Steelbook'), 'Superman');
  assert.equal(inferMovieTitle('Tokyo Ghoul - The Complete Series Blu-ray'), 'Tokyo Ghoul');
  assert.equal(inferMovieTitle('Inception'), 'Inception');
});

test('inferAspects fills only empty aspects using allowed values', () => {
  const defs = [
    { name: 'Format', values: ['Blu-ray', '4K UHD Blu-ray', 'DVD'], freeText: false },
    { name: 'Movie/TV Title', values: [], freeText: true },
    { name: 'Case Type', values: ['Standard', 'Steelbook'], freeText: false },
    { name: 'Region Code', values: ['Region Free', 'A/1 (North America)'], freeText: false },
    { name: 'Genre', values: ['Horror'], freeText: true },
  ];
  const out = inferAspects({ title: 'The Substance 4K Blu-ray Steelbook', description: 'Playback: Region Free' }, defs, { 'Case Type': ['Standard'] });
  assert.deepEqual(out, { Format: ['4K UHD Blu-ray'], 'Movie/TV Title': ['The Substance'], 'Region Code': ['Region Free'] });
});
