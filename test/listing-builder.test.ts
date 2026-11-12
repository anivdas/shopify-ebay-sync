import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAspects, cleanDescription, countryValue, DESCRIPTION_STYLE, ebayQuantity, ebaySku, gtinFields, inferAspects, inferFormat, inferMovieTitle, normalizeStyles, optionsLabel, renderDescription, renderTitle, sanitizeHtml, smartTitle, truncateWords } from '../src/listing-builder.ts';

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
  assert.equal(unwrap(out), '<p>A&lt;B</p><p>x</p>');
});

test('renderDescription adds the full Shopify name on top (inside the wrapper) unless the template places it', () => {
  const out = unwrap(renderDescription('{{description}}', { title: 'Movie', fullTitle: 'Movie 4K Steelbook - Region Free', description: '<p>d</p>' }));
  assert.match(out, /^<p>This listing is for: Movie 4K Steelbook - Region Free<\/p>/);
  const placed = unwrap(renderDescription('<h2>{{full_title}}</h2>{{description}}', { title: 'Movie', fullTitle: 'Movie Full', description: '' }));
  assert.equal(placed, '<p>Movie Full</p>');
});

test('cleanDescription strips all formatting into plain paragraphs and bullets', () => {
  const html =
    '<p><span style="font-family:Times;font-size:18px;color:#c00">*Perfect Condition Sealed (No Dents)</span><br><br>*Limited Edition<br><br><font face="Comic Sans">Playback</font><br>Region&nbsp;Free</p><table><tr><td>Disc &amp; case</td></tr></table><ul><li><b>Bonus</b> art</li></ul>';
  assert.equal(
    cleanDescription(html),
    ['<ul><li>Perfect Condition Sealed (No Dents)</li><li>Limited Edition</li></ul>', '<p>Playback</p>', '<p>Region Free</p>', '<p>Disc &amp; case</p>', '<ul><li>Bonus art</li></ul>'].join('\n'),
  );
});

test('renderDescription cleans the Shopify description by default and accepts {single} braces', () => {
  const out = unwrap(renderDescription('<div style="font-family:Times">{title}</div><h3 style="color:red"><b>Ship</b></h3><hr>{description}', { title: 'Movie', description: '<p style="color:red">Hello</p>', showFullTitle: false }));
  assert.equal(out, '<div>Movie</div><p>Ship</p><p>Hello</p>');
  const kept = unwrap(renderDescription('{{description}}', { title: 'M', description: '<p><b>Hi</b></p>', showFullTitle: false, keepFormatting: true }));
  assert.equal(kept, '<p><b>Hi</b></p>');
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

test('countryValue maps Shopify ISO codes to eBay country values', () => {
  assert.equal(countryValue('KR', ['United Kingdom', 'Korea, Republic of', 'Japan']), 'Korea, Republic of');
  assert.equal(countryValue('KR', ['South Korea']), 'South Korea');
  assert.equal(countryValue('JP', ['United Kingdom', 'Japan']), 'Japan');
  assert.equal(countryValue('KR'), 'South Korea');
  assert.equal(countryValue('ZZZ'), null);
  assert.equal(countryValue('KR', ['Japan']), null);
  const defs = [{ name: 'Country of Origin', values: ['United Kingdom', 'South Korea'], freeText: true }];
  assert.deepEqual(inferAspects({ title: 'x', countryOfOrigin: 'KR' }, defs), { 'Country of Origin': ['South Korea'] });
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
