/* Checks for Photo Palette: the colour conversions (hex / rgb / hsl / OKLab /
 * OKLCH, round trips and published values), WCAG contrast, naming, the
 * extractor on synthetic RGBA pictures (known blocks and shares, a small
 * accent kept, near-duplicates merged, transparency ignored, determinism),
 * the copy / insert / PNG texts, and that the widget registers as the
 * manifest says. Not loaded by the app. Run: node txt/widgets/palette/palette.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var PC = require('./palette-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' ' + a + ' ≉ ' + b); }

// ---- synthetic pictures ----
function img(w, h, fn) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var c = fn(x, y), p = (y * w + x) * 4;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c.length > 3 ? c[3] : 255;
  }
  return { data: d, w: w, h: h };
}
var NAVY = [20, 33, 61], WHITE = [255, 255, 255], ORANGE = [252, 163, 17];
// 60% navy | 30% white | 10% orange, as vertical bands
function blocks(w, h) { return img(w, h, function (x) { var f = x / w; return f < 0.6 ? NAVY : f < 0.9 ? WHITE : ORANGE; }); }
function byHex(res, hex) { return res.colors.filter(function (c) { return c.hex === hex; })[0]; }
function ext(im, o) { return PC.extract(im.data, im.w, im.h, o); }

// ---- registration ----
var WIDGET_ENTRY = {
  id: 'palette', type: 'widget', name: 'Photo Palette',
  description: 'Pull the main colours out of a photo or the live camera — colour cards with HEX, RGB and HSL to copy, a palette for your note or a PNG strip',
  icon: '🖌',
  tags: 'palette,colour palette,color palette,colours,colors,extract,photo,picture,image,camera,swatch,swatches,hex,rgb,hsl,oklch,css,design,theme,scheme,copy',
  entry: 'widgets/palette/palette.js', css: 'widgets/palette/palette.css', precache: ['widgets/palette/palette-core.js']
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}
test('widget registers with the manifest entry\'s name, description, icon and tags', function () {
  var entries = [WIDGET_ENTRY], live = manifestEntry('palette');
  if (live) entries.push(live);
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'palette.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { loadCSS: function (p) { css.push(p); }, baseURL: function () { return './txt/widgets/palette/'; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  assert.ok(reg, 'registered');
  entries.forEach(function (entry) {
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], entry[k], k); });
    assert.strictEqual(entry.entry, 'widgets/palette/palette.js');
    assert.strictEqual(entry.css, 'widgets/palette/palette.css');
    entry.precache.forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f + ' exists'); });
  });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['palette.css']);
});
test('the icon is not used by any other module', function () {
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
  m.forEach(function (x) { if (x.id !== 'palette') assert.notStrictEqual(x.icon, WIDGET_ENTRY.icon, x.id); });
});

// ---- conversions ----
test('hex ⇄ rgb, short and long forms', function () {
  assert.deepStrictEqual(PC.hexToRgb('#1a2b3c'), { r: 26, g: 43, b: 60 });
  assert.deepStrictEqual(PC.hexToRgb('fff'), { r: 255, g: 255, b: 255 });
  assert.deepStrictEqual(PC.hexToRgb('#ABC'), { r: 170, g: 187, b: 204 });
  assert.strictEqual(PC.hexToRgb('#12345'), null);
  assert.strictEqual(PC.rgbToHex({ r: 26, g: 43, b: 60 }), '#1a2b3c');
  assert.strictEqual(PC.rgbToHex(0, 0, 0), '#000000');
  assert.strictEqual(PC.rgbToHex(300, -4, 254.6), '#ff00ff', 'clamped and rounded');
});
test('hsl: known values and a round trip through every 8th sRGB colour', function () {
  var h = PC.rgbToHsl({ r: 26, g: 43, b: 60 });
  near(h.h, 210, 0.01); near(h.s, 0.3953, 0.001); near(h.l, 0.1686, 0.001);
  assert.deepStrictEqual(PC.hslToRgb({ h: 0, s: 1, l: 0.5 }), { r: 255, g: 0, b: 0 });
  assert.deepStrictEqual(PC.hslToRgb({ h: 120, s: 1, l: 0.25 }), { r: 0, g: 128, b: 0 });
  assert.deepStrictEqual(PC.hslToRgb({ h: 30, s: 0, l: 0.5 }), { r: 128, g: 128, b: 128 });
  for (var r = 0; r < 256; r += 8) for (var g = 0; g < 256; g += 8) for (var b = 0; b < 256; b += 8) {
    var c = { r: r, g: g, b: b };
    assert.deepStrictEqual(PC.hslToRgb(PC.rgbToHsl(c)), c);
  }
});
test('OKLab / OKLCH: published values', function () {
  var w = PC.rgbToOklab(255, 255, 255);
  near(w.L, 1, 1e-4, 'white L'); near(w.a, 0, 1e-4); near(w.b, 0, 1e-4);
  var k = PC.rgbToOklab(0, 0, 0);
  near(k.L, 0, 1e-9);
  var red = PC.oklabToOklch(PC.rgbToOklab(255, 0, 0));       // oklch(62.8% 0.2577 29.23)
  near(red.L, 0.62796, 1e-4); near(red.C, 0.25768, 1e-4); near(red.h, 29.234, 0.02);
  var blue = PC.oklabToOklch(PC.rgbToOklab(0, 0, 255));      // oklch(45.2% 0.3132 264.05)
  near(blue.L, 0.45201, 1e-4); near(blue.C, 0.31321, 1e-4); near(blue.h, 264.05, 0.05);
  var lime = PC.rgbToOklab({ r: 0, g: 255, b: 0 });          // oklab(0.866 -0.234 0.179)
  near(lime.L, 0.86644, 1e-4); near(lime.a, -0.23389, 1e-4); near(lime.b, 0.17950, 1e-4);
});
test('OKLab and OKLCH round trips are exact to the 8-bit value', function () {
  for (var r = 0; r < 256; r += 5) for (var g = 0; g < 256; g += 5) for (var b = 0; b < 256; b += 5) {
    var c = { r: r, g: g, b: b }, lab = PC.rgbToOklab(c);
    assert.deepStrictEqual(PC.oklabToRgb(lab), c);
    var back = PC.oklabToRgb(PC.oklchToOklab(PC.oklabToOklch(lab)));
    assert.deepStrictEqual(back, c);
    var raw = PC.oklabToRgb(lab.L, lab.a, lab.b, false);
    near(raw.r, r, 2e-3); near(raw.g, g, 2e-3); near(raw.b, b, 2e-3);
  }
  // non-integer input takes the exact path
  near(PC.rgbToOklab(127.5, 127.5, 127.5).L, (PC.rgbToOklab(127, 127, 127).L + PC.rgbToOklab(128, 128, 128).L) / 2, 2e-3);
});
test('ΔE is a distance', function () {
  var a = PC.rgbToOklab(10, 20, 30), b = PC.rgbToOklab(200, 100, 50);
  near(PC.deltaE(a, a), 0, 1e-12);
  near(PC.deltaE(a, b), PC.deltaE(b, a), 1e-12);
  near(PC.deltaE(PC.rgbToOklab(0, 0, 0), PC.rgbToOklab(255, 255, 255)), 1, 1e-4);
});

// ---- the strings the cards copy ----
test('copy formats', function () {
  var c = { r: 26, g: 43, b: 60 };
  assert.strictEqual(PC.fmtHex(c), '#1a2b3c');
  assert.strictEqual(PC.fmtRgb(c), 'rgb(26, 43, 60)');
  assert.strictEqual(PC.fmtHsl(c), 'hsl(210, 40%, 17%)');
  assert.strictEqual(PC.fmtHsl({ r: 255, g: 0, b: 0 }), 'hsl(0, 100%, 50%)');
  assert.strictEqual(PC.fmtHsl({ r: 255, g: 0, b: 1 }), 'hsl(0, 100%, 50%)', 'hue 359.8 rounds to 0, not 360');
  assert.strictEqual(PC.fmtOklch({ r: 255, g: 0, b: 0 }), 'oklch(62.8% 0.258 29.2)');
  assert.strictEqual(PC.fmtOklch({ r: 255, g: 255, b: 255 }), 'oklch(100% 0 0)');
  assert.strictEqual(PC.fmtOklch({ r: 0, g: 0, b: 0 }), 'oklch(0% 0 0)');
  assert.strictEqual(PC.fmtOklch({ r: 128, g: 128, b: 128 }), 'oklch(60% 0 0)', 'greys have no chroma or hue; trailing zeros dropped');
  var nv = PC.oklabToOklch(PC.rgbToOklab(26, 43, 60));
  assert.strictEqual(PC.fmtOklch({ r: 26, g: 43, b: 60 }), 'oklch(' + (nv.L * 100).toFixed(1) + '% ' + nv.C.toFixed(3) + ' ' + nv.h.toFixed(1) + ')');
  assert.ok(/^oklch\(\d+(\.\d)?% 0\.\d{1,3} \d+(\.\d)?\)$/.test(PC.fmtOklch({ r: 26, g: 43, b: 60 })));
  // the editor's colour-chip pattern recognises what we write
  var CHIP = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_])|\b(?:rgba?|hsla?)\(\s*[-+\d.]+(?:deg|%)?\s*(?:,\s*|\s+)[-+\d.]+%?\s*(?:,\s*|\s+)[-+\d.]+%?\s*(?:(?:,|\/)\s*[\d.]+%?\s*)?\)/g;
  ['#1a2b3c', 'rgb(26, 43, 60)', 'hsl(210, 40%, 17%)'].forEach(function (s) { assert.deepStrictEqual(s.match(CHIP), [s]); });
});
test('readable text colour picks the higher WCAG contrast', function () {
  near(PC.contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 1e-9);
  near(PC.contrast({ r: 119, g: 119, b: 119 }, { r: 255, g: 255, b: 255 }), 4.48, 0.01);
  assert.strictEqual(PC.textColor({ r: 20, g: 33, b: 61 }).color, '#ffffff');
  assert.strictEqual(PC.textColor({ r: 255, g: 255, b: 255 }).color, '#000000');
  assert.strictEqual(PC.textColor({ r: 252, g: 163, b: 17 }).color, '#000000');
  assert.strictEqual(PC.textColor({ r: 0, g: 0, b: 255 }).color, '#ffffff');
  assert.strictEqual(PC.textColor({ r: 255, g: 255, b: 0 }).color, '#000000');
  // either way the choice is at least 4.5:1 … except for mid tones, where the best is still ≥ 4.58
  for (var v = 0; v < 256; v += 3) assert.ok(PC.textColor({ r: v, g: v, b: v }).ratio >= 4.58, 'grey ' + v);
});
test('naming: nearest CSS colour, plus a few everyday names', function () {
  assert.strictEqual(PC.nameOf({ r: 25, g: 25, b: 112 }), 'Midnight blue');
  assert.strictEqual(PC.nameOf({ r: 255, g: 255, b: 255 }), 'White');
  assert.strictEqual(PC.nameOf({ r: 0, g: 0, b: 0 }), 'Black');
  assert.strictEqual(PC.nameOf({ r: 254, g: 1, b: 2 }), 'Red');
  assert.strictEqual(PC.nameOf({ r: 128, g: 128, b: 128 }), 'Grey');
  assert.strictEqual(PC.nameOf({ r: 0x36, g: 0x45, b: 0x4f }), 'Charcoal');
  assert.strictEqual(PC.nameOf(PC.rgbToOklab(255, 165, 0)), 'Orange', 'accepts OKLab too');
  // every CSS entry is a valid colour and the names are unique
  var seen = {};
  PC.NAMES.forEach(function (n) {
    assert.ok(/^#[0-9a-f]{6}$/.test(n.hex), n.name);
    assert.ok(!seen[n.name], 'duplicate ' + n.name); seen[n.name] = 1;
    assert.strictEqual(PC.nameOf(n.rgb), n.name, 'a named colour is its own nearest');
  });
  assert.strictEqual(PC.NAMES.filter(function (n) { return !n.extra; }).length, 139, 'CSS named colours without aliases');
});

// ---- extraction ----
test('60% navy / 30% white / 10% orange → those three, those shares, ordered', function () {
  var res = ext(blocks(120, 80), { k: 6 });
  assert.strictEqual(res.colors.length, 3, 'only three colours exist');
  assert.deepStrictEqual(res.colors.map(function (c) { return c.hex; }), ['#14213d', '#ffffff', '#fca311']);
  near(byHex(res, '#14213d').share, 0.6, 0.005);
  near(byHex(res, '#ffffff').share, 0.3, 0.005);
  near(byHex(res, '#fca311').share, 0.1, 0.005);
  var sum = res.colors.reduce(function (s, c) { return s + c.share; }, 0);
  near(sum, 1, 1e-9, 'shares add up');
  var o = byHex(res, '#fca311');
  assert.strictEqual(o.rgb, 'rgb(252, 163, 17)');
  assert.strictEqual(o.text, '#000000');
  assert.strictEqual(byHex(res, '#14213d').text, '#ffffff');
  // markers sit inside their own block, away from the edges
  assert.ok(byHex(res, '#14213d').x < 0.6 && byHex(res, '#14213d').x > 0.05);
  assert.ok(byHex(res, '#ffffff').x > 0.6 && byHex(res, '#ffffff').x < 0.9);
  assert.ok(o.x > 0.9);
  res.colors.forEach(function (c) { assert.ok(c.y > 0.2 && c.y < 0.8, 'vertically central ' + c.y); });
});
test('noisy blocks still give the block colours and shares, at every count', function () {
  var R = PC.rng(42);
  var im = img(200, 150, function (x) {
    var f = x / 200, c = f < 0.6 ? NAVY : f < 0.9 ? WHITE : ORANGE, n = function () { return Math.round((R() - 0.5) * 12); };
    return [c[0] + n(), c[1] + n(), c[2] + n()];
  });
  PC.COUNTS.forEach(function (k) {
    var res = ext(im, { k: k });
    assert.ok(res.colors.length <= k && res.colors.length >= 3, 'k=' + k + ' got ' + res.colors.length);
    [[NAVY, 0.6], [WHITE, 0.3], [ORANGE, 0.1]].forEach(function (t) {
      var lab = PC.rgbToOklab(t[0][0], t[0][1], t[0][2]);
      var close = res.colors.filter(function (c) { return PC.deltaE(c.lab, lab) < 0.03; });
      assert.ok(close.length >= 1, 'k=' + k + ' finds ' + PC.rgbToHex(t[0][0], t[0][1], t[0][2]));
      var share = close.reduce(function (s, c) { return s + c.share; }, 0);
      near(share, t[1], 0.02, 'k=' + k + ' share');
    });
  });
});
test('a small vivid accent is kept ahead of bigger neutrals', function () {
  // six distinct greys of 16% each and a 4% red strip; only five colours wanted
  var G = [40, 70, 100, 135, 170, 210];
  var im = img(120, 100, function (x, y) { if (y < 4) return [230, 20, 40]; var g = G[Math.floor(x / 20)]; return [g, g, g]; });
  var res = ext(im, { k: 5 });
  assert.strictEqual(res.colors.length, 5);
  var red = byHex(res, '#e61428');
  assert.ok(red, 'the red accent survives');
  near(red.share, 0.04, 0.001);
  assert.strictEqual(res.colors.filter(function (c) { return c.r === c.g && c.g === c.b; }).length, 4, 'one grey made room for it');
  near(res.colors.reduce(function (s, c) { return s + c.share; }, 0), 1, 1e-9);
  // listing order stays mostly by area: 10% orange after 30% white (see above), 4% red last-ish
  assert.ok(res.colors.indexOf(red) >= 3, 'listed after the big greys');
  // but a tiny speck is not promoted
  var speck = ext(img(100, 100, function (x, y) { return x === 0 && y < 2 ? [255, 0, 0] : x < 50 ? [60, 60, 60] : [200, 200, 200]; }), { k: 2 });
  assert.ok(!speck.colors.some(function (c) { return c.hex === '#ff0000'; }), '0.02% red is noise');
});
test('near-duplicates are merged into one colour', function () {
  var im = img(100, 100, function (x) { return x < 25 ? [51, 102, 204] : x < 50 ? [52, 103, 203] : x < 60 ? [50, 101, 205] : [255, 255, 255]; });
  var res = ext(im, { k: 6 });
  assert.strictEqual(res.colors.length, 2);
  var blue = res.colors[0];
  assert.ok(PC.deltaE(blue.lab, PC.rgbToOklab(51, 102, 204)) < 0.01);
  near(blue.share, 0.6, 1e-9);
  // two genuinely different blues stay apart
  var two = ext(img(100, 100, function (x) { return x < 50 ? [51, 102, 204] : [20, 50, 140]; }), { k: 6 });
  assert.strictEqual(two.colors.length, 2);
  assert.ok(PC.MERGE_DE > 0.02 && PC.MERGE_DE < 0.06);
});
test('fully transparent pixels are ignored; translucent ones weigh less', function () {
  var im = img(100, 100, function (x) { return x < 50 ? [255, 0, 0, 0] : x < 75 ? [0, 0, 255, 255] : [0, 200, 0, 255]; });
  var res = ext(im, { k: 6 });
  assert.strictEqual(res.colors.length, 2, 'the invisible red is not a colour');
  assert.ok(!res.colors.some(function (c) { return c.r > 200 && c.g < 50; }));
  near(res.colors.filter(function (c) { return c.hex === '#0000ff'; })[0].share, 0.5, 1e-9);
  var none = ext(img(10, 10, function () { return [9, 9, 9, 0]; }), { k: 6 });
  assert.deepStrictEqual(none.colors, []);
  var half = ext(img(100, 100, function (x) { return x < 50 ? [0, 0, 255, 255] : [255, 255, 0, 85]; }), { k: 6 });
  near(half.colors.filter(function (c) { return c.hex === '#0000ff'; })[0].share, 0.75, 0.01, 'alpha 1/3 counts a third');
});
test('k-means is deterministic: same picture, same palette; the seed is what changes it', function () {
  var R = PC.rng(9);
  var im = img(160, 120, function (x, y) { return [Math.min(255, x + R() * 40) | 0, Math.min(255, y * 2 + R() * 40) | 0, (R() * 255) | 0]; });
  var a = ext(im, { k: 8 }), b = ext(im, { k: 8 });
  assert.deepStrictEqual(a.colors.map(function (c) { return c.hex + c.share + c.x + c.y; }), b.colors.map(function (c) { return c.hex + c.share + c.x + c.y; }));
  assert.strictEqual(a.colors.length, 8);
  // raw k-means: same seed → same centres
  var L = [0, 0.1, 0.5, 0.52, 0.9], A = [0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0], W = [1, 1, 1, 1, 1];
  assert.deepStrictEqual(PC.kmeans(L, A, B, W, 5, 3, 5), PC.kmeans(L, A, B, W, 5, 3, 5));
  var km = PC.kmeans(L, A, B, W, 5, 3, 5);
  assert.deepStrictEqual(km.L.slice().sort().map(function (v) { return Math.round(v * 100); }), [5, 51, 90]);
  // the PRNG itself
  var r1 = PC.rng(1), r2 = PC.rng(1);
  for (var i = 0; i < 20; i++) { var v = r1(); assert.strictEqual(v, r2()); assert.ok(v >= 0 && v < 1); }
});
test('a big picture is sampled, not read pixel by pixel', function () {
  var im = blocks(1000, 600);
  var res = ext(im, { k: 6 });
  assert.ok(res.w * res.h <= 40000, res.w + '×' + res.h);
  assert.strictEqual(res.colors.length, 3);
  near(res.colors[0].share, 0.6, 0.01);
});
test('each colour comes with every format, its share, text colour and name', function () {
  var c = ext(blocks(60, 40), { k: 6 }).colors[0];
  ['hex', 'rgb', 'hsl', 'oklch', 'name', 'text'].forEach(function (k) { assert.strictEqual(typeof c[k], 'string', k); });
  assert.strictEqual(c.hsl, PC.fmtHsl(c));
  assert.strictEqual(c.name, 'Oxford blue');
  assert.ok(c.contrast > 12);
  assert.ok(c.lch.C > 0.05 && c.lch.h > 250 && c.lch.h < 280, 'navy is a blue in OKLCH');
});

// ---- outputs ----
var SAMPLE = [
  PC.describe({ r: 26, g: 43, b: 60 }, 0.31), PC.describe({ r: 255, g: 255, b: 255 }, 0.6), PC.describe({ r: 252, g: 163, b: 17 }, 0.004)
];
test('copy-all formats: CSS variables, JSON and a hex list', function () {
  assert.strictEqual(PC.cssVars(SAMPLE), ':root {\n  --palette-1: #1a2b3c; /* ' + SAMPLE[0].name + ' */\n  --palette-2: #ffffff; /* White */\n  --palette-3: #fca311; /* ' + SAMPLE[2].name + ' */\n}');
  var j = JSON.parse(PC.jsonArray(SAMPLE));
  assert.strictEqual(j.length, 3);
  assert.deepStrictEqual(j[0], { hex: '#1a2b3c', rgb: [26, 43, 60], hsl: 'hsl(210, 40%, 17%)', oklch: SAMPLE[0].oklch, name: SAMPLE[0].name, share: 0.31 });
  assert.strictEqual(j[2].share, 0.004);
  assert.strictEqual(PC.hexList(SAMPLE), '#1a2b3c\n#ffffff\n#fca311');
});
test('the note block', function () {
  assert.strictEqual(PC.noteBlock(SAMPLE, ''), '### Palette\n' +
    '- #1a2b3c  rgb(26, 43, 60)  ' + SAMPLE[0].name + '  (31%)\n' +
    '- #ffffff  rgb(255, 255, 255)  White  (60%)\n' +
    '- #fca311  rgb(252, 163, 17)  ' + SAMPLE[2].name + '  (<1%)');
  assert.strictEqual(PC.noteBlock(SAMPLE.slice(0, 1), '  Pier at\n dusk  ').split('\n')[0], '### Palette — Pier at dusk');
  assert.strictEqual(PC.pct(0), '0%');
  assert.strictEqual(PC.pct(0.995), '100%');
});
test('insert plan: own lines with a blank line around; after a code block when inside one', function () {
  var B = '### Palette\n- #000000';
  var p = PC.insertPlan('', 0, 0, B);
  assert.deepStrictEqual(p, { from: 0, to: 0, insert: B + '\n', cursor: B.length });
  p = PC.insertPlan('Hello world', 5, 5, B);
  assert.strictEqual(p.insert, '\n\n' + B + '\n\n');
  assert.strictEqual(p.cursor, 5 + 2 + B.length);
  p = PC.insertPlan('a\n\nb', 2, 2, B);                 // on the empty line
  assert.strictEqual(p.insert, '\n' + B + '\n');
  p = PC.insertPlan('a\n', 2, 2, B);
  assert.strictEqual(p.insert, '\n' + B + '\n');
  p = PC.insertPlan('one two three', 4, 7, B);          // replaces a selection
  assert.deepStrictEqual([p.from, p.to], [4, 7]);
  var t = 'intro\n```js\nlet a = 1;\n```\nafter';
  p = PC.insertPlan(t, t.indexOf('let') + 2, t.indexOf('let') + 2, B);
  assert.strictEqual(p.from, t.indexOf('```\nafter') + 3, 'moved after the closing fence');
  var out = t.slice(0, p.from) + p.insert + t.slice(p.to);
  assert.strictEqual(out, 'intro\n```js\nlet a = 1;\n```\n\n' + B + '\n\nafter');
  // an unclosed fence runs to the end
  var u = 'x\n```\ncode';
  p = PC.insertPlan(u, 7, 7, B);
  assert.strictEqual(p.from, u.length);
  // outside any block nothing moves
  assert.strictEqual(PC.fenceEndAt(t, 2), -1);
  assert.strictEqual(PC.fenceEndAt(t, t.length), -1);
});
test('PNG strip: one swatch per colour, hex labels in the readable colour', function () {
  var calls = [], ctx = { set fillStyle(v) { calls.push(['fill', v]); }, set font(v) { calls.push(['font', v]); }, textAlign: '', textBaseline: '',
    fillRect: function (x, y, w, h) { calls.push(['rect', x, y, w, h]); }, fillText: function (s) { calls.push(['text', s]); } };
  var r = PC.drawStrip(ctx, SAMPLE, { caption: 'Pier' });
  assert.deepStrictEqual(r, PC.stripSize(3));
  var rects = calls.filter(function (c) { return c[0] === 'rect'; });
  assert.strictEqual(rects.length, 5, 'background + 3 swatches + the caption hairline');
  assert.strictEqual(rects[1][3] + rects[2][3] + rects[3][3], r.width, 'swatches tile the width');
  var texts = calls.filter(function (c) { return c[0] === 'text'; }).map(function (c) { return c[1]; });
  assert.deepStrictEqual(texts.slice(0, 2), ['#1A2B3C', SAMPLE[0].name + ' · 31%']);
  assert.ok(texts.indexOf('#FCA311') >= 0 && texts.indexOf('Pier') >= 0);
  // the hex is drawn in the swatch's text colour
  var i = calls.findIndex(function (c) { return c[0] === 'text' && c[1] === '#1A2B3C'; });
  var lastFill = calls.slice(0, i).filter(function (c) { return c[0] === 'fill'; }).pop();
  assert.strictEqual(lastFill[1], '#ffffff');
  assert.ok(PC.stripSize(10).width >= 1700, 'ten swatches get room');
  assert.strictEqual(PC.pngName('Pier at dusk!', new Date(2026, 9, 21)), 'palette-2026-10-21-pier-at-dusk.png');
  assert.strictEqual(PC.pngName('', new Date(2026, 0, 2)), 'palette-2026-01-02.png');
});

console.log('palette: ' + passed + ' passed');
