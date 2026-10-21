/* Checks for ASCII Postcard: the converter (on synthetic RGBA buffers), the
 * palette, the note format and its codec (incl. the built-in inflate against
 * node's zlib), the renderer's colour batching, the editor plugin's block
 * finder, and that the widget / plugin register as the manifest says.
 * Not loaded by the app. Run: node txt/widgets/postcard/postcard.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), zlib = require('zlib');
var PC = require('./postcard-core.js');
var V = require('./postcard-view.js');
var passed = 0, pending = [];
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(function () { passed++; }, function (e) { fail(name, e); }));
    else passed++;
  } catch (e) { fail(name, e); }
}
function fail(name, e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }

// ---- synthetic pictures ----
function img(w, h, fn) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var c = fn(x, y), p = (y * w + x) * 4;
    if (typeof c === 'number') c = [c, c, c];
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c.length > 3 ? c[3] : 255;
  }
  return { data: d, w: w, h: h };
}
function conv(im, o) { return PC.convert(im.data, im.w, im.h, o); }
function rampIdx(card, ramp) { return card.lines.map(function (l) { return l.split('').map(function (ch) { return ramp.indexOf(ch); }); }); }
function nonDecreasing(a) { for (var i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return false; return true; }

// ---- registration ----
var WIDGET_ENTRY = {
  id: 'postcard', type: 'widget', name: 'ASCII Postcard',
  description: 'Turn a photo into coloured text art kept in your note — classic, dense, blocks, braille, edges or your own words; copy it, save a PNG or share it. A visual diary that is still just text',
  icon: '🖼',
  tags: 'ascii,ascii art,postcard,photo,picture,image,camera,text art,braille,diary,journal,memory,art,colour,color,png,share,convert,draw',
  entry: 'widgets/postcard/postcard.js', css: 'widgets/postcard/postcard.css', precache: ['widgets/postcard/postcard-core.js']
};
var PLUGIN_ENTRY = {
  id: 'postcard-view', type: 'plugin', name: 'ASCII postcards in the editor',
  description: 'Show ```postcard blocks (made with ASCII Postcard) as their coloured picture; put the caret in one to edit its text, or save it as a PNG',
  entry: 'widgets/postcard/postcard-view.js', css: 'widgets/postcard/postcard-view.css', precache: ['widgets/postcard/postcard-core.js'],
  settingKey: 'plugins.postcard-view', section: 'Editor', default: true
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}
test('widget registers with the manifest entry\'s name, description, icon and tags', function () {
  var entries = [WIDGET_ENTRY], live = manifestEntry('postcard');
  if (live) entries.push(live);
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'postcard.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './txt/widgets/postcard/' + p; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  assert.ok(reg, 'registered');
  entries.forEach(function (entry) {
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], entry[k], k); });
    assert.strictEqual(entry.entry, 'widgets/postcard/postcard.js');
    assert.strictEqual(entry.css, 'widgets/postcard/postcard.css');
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', entry.precache[0])), 'precached core exists');
  });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['postcard.css']);
});
test('editor plugin registers its StateField under the manifest id (and loads its css)', function () {
  var live = manifestEntry('postcard-view');
  [PLUGIN_ENTRY].concat(live ? [live] : []).forEach(function (e) {
    assert.strictEqual(e.settingKey, 'plugins.postcard-view'); assert.strictEqual(e.default, true); assert.strictEqual(e.section, 'Editor');
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', e.entry)) && fs.existsSync(path.join(__dirname, '..', '..', e.css)));
  });
  var reg = null, css = [], defined = null;
  function WT() {}
  var CM = {
    StateField: { define: function (spec) { defined = spec; return { field: true }; } },
    Decoration: { none: { size: 0 }, line: function () { return { range: function () {} }; }, replace: function () { return { range: function () {} }; }, set: function () {} },
    WidgetType: WT, EditorView: { decorations: { from: function () {} } }
  };
  var src = fs.readFileSync(path.join(__dirname, 'postcard-view.js'), 'utf8');
  var win = { Cade: { CM: CM, loadCSS: function (p) { css.push(p); }, asset: function (p) { return p; }, registerPlugin: function (o) { reg = o; } }, addEventListener: function () {} };
  new Function('window', 'module', src)(win, undefined);
  assert.ok(reg && reg.id === 'postcard-view' && reg.ext && reg.ext.field, 'registered');
  assert.ok(defined && typeof defined.create === 'function' && typeof defined.update === 'function' && typeof defined.provide === 'function');
  assert.deepStrictEqual(css, ['postcard-view.css']);
});

// ---- converter ----
test('grid: 0.5 cell aspect; width clamps to 24..160', function () {
  assert.deepStrictEqual(PC.gridSize(400, 300, 64), { cols: 64, rows: 24 });
  assert.strictEqual(PC.gridSize(400, 300, 5).cols, 24);
  assert.strictEqual(PC.gridSize(400, 300, 999).cols, 160);
  var c = conv(img(400, 300, function () { return 128; }), { cols: 64 });
  assert.strictEqual(c.lines.length, 24);
  c.lines.forEach(function (l) { assert.strictEqual(l.length, 64); });
});
test('gradient → ramp order (dark paper: bright = dense); light paper and invert reverse it', function () {
  var g = img(480, 120, function (x) { return Math.round(x / 479 * 255); });
  var R = PC.RAMPS.classic;
  var dark = rampIdx(conv(g, { cols: 48, style: 'classic', mode: 'mono', bg: 'dark', auto: false }), R);
  dark.forEach(function (row) { assert.ok(nonDecreasing(row), row.join(',')); });
  assert.strictEqual(dark[0][0], 0); assert.strictEqual(dark[0][47], R.length - 1);
  var light = rampIdx(conv(g, { cols: 48, style: 'classic', mode: 'mono', bg: 'light', auto: false }), R);
  assert.ok(nonDecreasing(light[0].slice().reverse()));
  assert.strictEqual(light[0][0], R.length - 1);
  var inv = rampIdx(conv(g, { cols: 48, style: 'classic', mode: 'mono', bg: 'dark', invert: true, auto: false }), R);
  assert.deepStrictEqual(inv[0], light[0], 'invert on dark = light paper');
  // dense and blocks ramps too
  var dn = rampIdx(conv(g, { cols: 70, style: 'dense', mode: 'mono', auto: false }), PC.RAMPS.dense)[0];
  assert.ok(nonDecreasing(dn) && dn[0] === 0 && dn[69] === PC.RAMPS.dense.length - 1);
  var bk = rampIdx(conv(g, { cols: 30, style: 'blocks', mode: 'mono', auto: false }), PC.RAMPS.blocks)[0];
  assert.ok(nonDecreasing(bk) && bk[0] === 0 && bk[29] === 4);
});
test('ramps hold no backtick (a ``` line ends the fence) and dense has ~70 levels', function () {
  Object.keys(PC.RAMPS).forEach(function (k) { assert.ok(PC.RAMPS[k].indexOf('`') < 0 && PC.RAMPS[k].indexOf('~') < 0, k); });
  assert.ok(PC.RAMPS.dense.length >= 66 && PC.RAMPS.dense.length <= 70, 'dense ' + PC.RAMPS.dense.length);
  assert.strictEqual(new Set(PC.RAMPS.dense.split('')).size, PC.RAMPS.dense.length, 'no duplicates');
});
test('brightness, contrast and gamma move the tones the right way', function () {
  var flat = img(96, 48, function () { return 100; });
  function lvl(o) { o.cols = 24; o.style = 'dense'; o.mode = 'mono'; o.auto = false; return PC.RAMPS.dense.indexOf(conv(flat, o).lines[0].charAt(0)); }
  var base = lvl({});
  assert.ok(lvl({ brightness: 0.5 }) > base && lvl({ brightness: -0.5 }) < base);
  assert.ok(lvl({ gamma: 2 }) > base && lvl({ gamma: 0.5 }) < base);
  assert.ok(lvl({ contrast: 1 }) < base, 'a dark-ish grey gets darker with more contrast');
});
test('braille: each lit 2×4 sub-pixel sets its own dot bit (U+2800 layout)', function () {
  // 48 × 8 px at 24 columns = exactly one pixel per sub-pixel (2 rows of cells)
  for (var sy = 0; sy < 8; sy++) for (var sx = 0; sx < 4; sx++) {
    var c = conv(img(48, 8, function (x, y) { return x === sx && y === sy ? 255 : 0; }), { cols: 24, style: 'braille', mode: 'mono', auto: false });
    assert.strictEqual(c.rows, 2);
    var cell = c.lines[sy >> 2].charCodeAt(sx >> 1) - 0x2800;
    assert.strictEqual(cell, PC.BRAILLE_BITS[sx & 1][sy & 3], 'sub-pixel ' + sx + ',' + sy);
    // every other cell blank
    var others = c.lines.join('').split('').filter(function (ch) { return ch !== '\u2800'; }).length;
    assert.strictEqual(others, 1);
  }
  assert.deepStrictEqual(PC.BRAILLE_BITS, [[1, 2, 4, 64], [8, 16, 32, 128]]);
  var full = conv(img(48, 8, function () { return 255; }), { cols: 24, style: 'braille', mode: 'mono', auto: false });
  assert.ok(full.lines.every(function (l) { return /^\u28ff+$/.test(l); }));
  // mid grey: ordered dither (default) and Floyd–Steinberg both light about half the dots
  function dots(c) { var n = 0; c.lines.join('').split('').forEach(function (ch) { var v = ch.charCodeAt(0) - 0x2800; while (v) { n += v & 1; v >>= 1; } }); return n / (c.cols * c.rows * 8); }
  [false, true].forEach(function (d) {
    var grey = conv(img(96, 48, function () { return 128; }), { cols: 48, style: 'braille', mode: 'mono', auto: false, dither: d });
    assert.ok(Math.abs(dots(grey) - 0.5) < 0.08, 'dither ' + d + ': ' + dots(grey));
  });
});
test('dithering: Floyd–Steinberg keeps every level in range and preserves the mean', function () {
  var vals = new Float32Array(400), i;
  for (i = 0; i < vals.length; i++) vals[i] = (i * 7919 % 400) / 400 * 1.6 - 0.3;  // -0.3 … 1.3
  [2, 5, 10, 68].forEach(function (n) {
    var q = PC.quantizeLevels(vals, 20, 20, n, true);
    for (var j = 0; j < q.length; j++) assert.ok(q[j] >= 0 && q[j] < n, n + ': ' + q[j]);
  });
  var mid = new Float32Array(1000); mid.fill(0.5);
  var q2 = PC.quantizeLevels(mid, 40, 25, 2, true), on = 0;
  for (i = 0; i < q2.length; i++) on += q2[i];
  assert.ok(Math.abs(on / 1000 - 0.5) < 0.03, 'half the dots on: ' + on);
  // through convert, extreme settings stay on the ramp
  var c = conv(img(300, 200, function (x, y) { return (x * 31 + y * 17) % 256; }), { cols: 50, style: 'classic', dither: true, contrast: 1, brightness: 0.4, mode: 'mono' });
  c.lines.forEach(function (l) { for (var k = 0; k < l.length; k++) assert.ok(PC.RAMPS.classic.indexOf(l.charAt(k)) >= 0); });
});
test('edges: a step reads as | or -, diagonals as / and \\', function () {
  function edgeChars(fn) {
    var c = conv(img(192, 96, fn), { cols: 48, style: 'edges', mode: 'mono', auto: false });
    return c.lines.join('').split('').filter(function (ch) { return '-|/\\'.indexOf(ch) >= 0; });
  }
  function mostly(chars, want) {
    var n = chars.filter(function (ch) { return ch === want; }).length;
    assert.ok(chars.length > 0 && n / chars.length > 0.8, want + ': ' + chars.join(''));
  }
  mostly(edgeChars(function (x) { return x < 96 ? 0 : 255; }), '|');
  mostly(edgeChars(function (x, y) { return y < 48 ? 0 : 255; }), '-');
  mostly(edgeChars(function (x, y) { return x + 2 * y > 190 ? 255 : 0; }), '/');   // bottom-left → top-right
  mostly(edgeChars(function (x, y) { return x - 2 * y > 0 ? 255 : 0; }), '\\');
  assert.strictEqual(PC.edgeChar(0), '-'); assert.strictEqual(PC.edgeChar(90), '|'); assert.strictEqual(PC.edgeChar(45), '\\'); assert.strictEqual(PC.edgeChar(135), '/');
  // flat areas get the light fill ramp, never an edge
  var flat = conv(img(96, 48, function () { return 200; }), { cols: 24, style: 'edges', mode: 'mono', auto: false });
  assert.ok(flat.lines.every(function (l) { return l.split('').every(function (ch) { return PC.EDGE_FILL.indexOf(ch) >= 0; }); }));
});
test('text style: the phrase repeats over the cells; colour mode keeps nearly all, mono blanks the faint parts', function () {
  var half = img(200, 100, function (x) { return x < 100 ? 0 : 255; });
  var c = conv(half, { cols: 40, style: 'text', phrase: 'Lisbon`', mode: 'mono', auto: false });
  var seq = 'Lisbon ', all = c.lines.join('');
  for (var i = 0; i < all.length; i++) if (all.charAt(i) !== ' ') assert.strictEqual(all.charAt(i), seq.charAt(i % seq.length));
  assert.ok(/^ +$/.test(c.lines[0].slice(0, 18)) && c.lines[0].slice(22).replace(/ /g, '').length > 10, c.lines[0]);
  assert.strictEqual(PC.cleanPhrase('a😀b\tc'), 'ab c');
});
test('colour mode: per-cell colours land on the right cells; mono modes carry none', function () {
  var four = img(160, 80, function (x, y) { return x < 80 ? (y < 40 ? [255, 0, 0] : [0, 255, 0]) : (y < 40 ? [0, 0, 255] : [255, 255, 0]); });
  var c = conv(four, { cols: 40, style: 'classic', mode: 'color', auto: false, colors: 8 });
  assert.ok(c.palette && c.idx && c.idx.length === c.cols * c.rows);
  function col(x, y) { var k = c.idx[y * c.cols + x] * 3; return [c.palette[k], c.palette[k + 1], c.palette[k + 2]]; }
  function dom(rgb) { return rgb.indexOf(Math.max.apply(null, rgb)); }
  assert.strictEqual(dom(col(2, 1)), 0, 'red top-left'); assert.strictEqual(dom(col(37, 1)), 2, 'blue top-right');
  assert.strictEqual(dom(col(2, c.rows - 1)), 1, 'green bottom-left');
  var y = col(37, c.rows - 1); assert.ok(y[0] > 150 && y[1] > 150 && y[2] < 80, 'yellow bottom-right ' + y);
  ['mono', 'tint', 'green', 'sepia'].forEach(function (m) { var k = conv(four, { cols: 30, mode: m }); assert.ok(!k.palette && !k.idx, m); });
});

// ---- palette ----
test('quantize: ≤ max colours, indices in range, exact colours kept when few, mask respected', function () {
  var n = 5000, rgb = new Uint8Array(n * 3), s = 12345, i;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s & 255; }
  for (i = 0; i < rgb.length; i++) rgb[i] = rnd();
  [1, 2, 8, 16, 32, 64, 200].forEach(function (max) {
    var q = PC.quantize(rgb, n, max);
    var k = q.palette.length / 3;
    assert.ok(k >= 1 && k <= Math.min(64, max), max + ' → ' + k);
    for (var j = 0; j < n; j++) assert.ok(q.idx[j] < k);
  });
  var few = [[10, 20, 30], [200, 100, 50], [0, 0, 0], [255, 255, 255], [90, 200, 120]], fr = new Uint8Array(300 * 3);
  for (i = 0; i < 300; i++) fr.set(few[i % 5], i * 3);
  var q = PC.quantize(fr, 300, 32);
  assert.strictEqual(q.palette.length / 3, 5);
  for (i = 0; i < 300; i++) assert.deepStrictEqual(Array.from(q.palette.slice(q.idx[i] * 3, q.idx[i] * 3 + 3)), few[i % 5]);
  // 64 colours of 1000 random: mean error is small
  var q64 = PC.quantize(rgb, n, 64), err = 0;
  for (i = 0; i < n; i++) for (var c = 0; c < 3; c++) err += Math.abs(rgb[i * 3 + c] - q64.palette[q64.idx[i] * 3 + c]);
  assert.ok(err / (n * 3) < 40, 'mean error ' + err / (n * 3));
  var mask = new Uint8Array(300); mask[0] = 1;
  assert.strictEqual(PC.quantize(fr, 300, 32, mask).palette.length / 3, 1, 'only masked cells count');
});

// ---- codec ----
var sunset = PC.demoImage(320, 200);
function sample(o) { return PC.convert(sunset.data, sunset.width, sunset.height, o); }
function sameCard(a, b, msg) {
  assert.strictEqual(b.cols, a.cols, msg); assert.strictEqual(b.rows, a.rows, msg);
  assert.deepStrictEqual(b.lines, a.lines, msg);
  if (a.palette) { assert.deepStrictEqual(Array.from(b.palette), Array.from(a.palette), msg); assert.deepStrictEqual(Array.from(b.idx), Array.from(a.idx), msg); }
  else assert.strictEqual(b.palette, null, msg);
}
test('inflate matches zlib (stored, fixed and dynamic blocks; sizes up to 64 KB)', function () {
  var inputs = [new Uint8Array(0), Buffer.from('a'), Buffer.from('hello hello hello hello'), Buffer.alloc(70000, 7)];
  var rnd = Buffer.alloc(30000), s = 7;
  for (var i = 0; i < rnd.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; rnd[i] = (s >>> 24) % (i % 3 ? 256 : 9); }
  inputs.push(rnd);
  var text = Buffer.from(fs.readFileSync(path.join(__dirname, 'postcard-core.js'), 'utf8').slice(0, 60000));
  inputs.push(text);
  inputs.forEach(function (inp, k) {
    [0, 1, 6, 9].forEach(function (level) {
      [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE].forEach(function (strategy) {
        var comp = zlib.deflateRawSync(inp, { level: level, strategy: strategy });
        var out = PC.inflateRaw(new Uint8Array(comp), Math.max(1, inp.length));
        assert.ok(Buffer.from(out).equals(Buffer.from(inp)), 'input ' + k + ' level ' + level + ' strategy ' + strategy);
      });
    });
  });
  assert.throws(function () { PC.inflateRaw(new Uint8Array(zlib.deflateRawSync(Buffer.alloc(100, 1))), 50); }, /too long/);
  assert.throws(function () { PC.inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 100); });
});
test('base64 round trip; junk is refused', function () {
  for (var n = 0; n < 40; n++) {
    var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = (i * 37 + n) & 255;
    var e = PC.b64encode(b);
    assert.strictEqual(e, Buffer.from(b).toString('base64'));
    assert.deepStrictEqual(Array.from(PC.b64decode(e)), Array.from(b));
  }
  assert.strictEqual(PC.b64decode('ab$d'), null);
  assert.strictEqual(PC.b64decode('abcde'), null);
});
test('codec round trip: card → text block → card gives identical characters and colours', function () {
  PC.STYLES.forEach(function (style) {
    [8, 64].forEach(function (colors) {
      var c = sample({ cols: 57, style: style, mode: 'color', colors: colors, caption: 'Lisbon, 21 Oct 2026', dither: style === 'classic' });
      var zl = PC.encodeColorsSync(c, function (b) { return zlib.deflateRawSync(b, { level: 9 }); });
      var raw = PC.encodeColorsSync(c);
      assert.ok(zl.length < raw.length, 'deflate helps');
      [zl, raw].forEach(function (line) {
        var t = PC.toText(c, line), d = PC.parseBlock(t);
        sameCard(c, d, style + '/' + colors);
        assert.strictEqual(d.caption, 'Lisbon, 21 Oct 2026'); assert.strictEqual(d.style, style); assert.strictEqual(d.mode, 'color'); assert.strictEqual(d.bg, 'dark');
        assert.strictEqual(d.colorError, false);
        var ls = t.split('\n');
        assert.strictEqual(ls.length, c.rows + 3);
        assert.strictEqual(ls[0], '```postcard 57x' + c.rows + ' ' + style + ' color dark "Lisbon, 21 Oct 2026"');
        ls.slice(1, 1 + c.rows).forEach(function (l) { assert.strictEqual(l.length, 57); assert.ok(l.indexOf('```') !== 0); });
        assert.ok(/^~ [A-Za-z0-9+/]+=*$/.test(ls[c.rows + 1]));
        assert.strictEqual(ls[ls.length - 1], '```');
      });
    });
  });
});
test('codec round trip through CompressionStream (async encode), when node has it', function () {
  if (typeof CompressionStream !== 'function') return;
  var c = sample({ cols: 80, style: 'braille', mode: 'color', caption: 'x' });
  return PC.cardToText(c).then(function (t) {
    var line = t.split('\n')[c.rows + 1], bytes = PC.b64decode(line.slice(2));
    assert.strictEqual(bytes[0], 1); assert.strictEqual(bytes[1], 1, 'deflated');
    sameCard(c, PC.parseBlock(t), 'async');
  });
});
test('mono / tint / green / sepia: no colour line, the mode lives in the fence info', function () {
  ['mono', 'green', 'sepia', 'tint'].forEach(function (m) {
    var c = sample({ cols: 30, mode: m, tint: '#3a8', bg: 'paper' });
    var t = PC.toText(c, PC.encodeColorsSync(c));
    assert.strictEqual(t.split('\n').length, c.rows + 2, m);
    var d = PC.parseBlock(t);
    assert.strictEqual(d.mode, m); assert.strictEqual(d.bg, 'paper'); sameCard(c, d, m);
    if (m === 'tint') { assert.ok(/ tint:#33aa88 /.test(t)); assert.strictEqual(d.tint, '#33aa88'); }
  });
});
test('corrupt or mismatched colour data degrades to monochrome, never throws', function () {
  var c = sample({ cols: 40, style: 'dense', mode: 'color' });
  var good = PC.toText(c, PC.encodeColorsSync(c, zlib.deflateRawSync)), ls = good.split('\n'), cl = ls[c.rows + 1];
  function withLine(l, head) { var a = ls.slice(); if (head) a[0] = head; a[c.rows + 1] = l; return a.join('\n'); }
  var bad = [
    cl.slice(0, cl.length - 9),                                  // truncated
    '~ ' + cl.slice(2).split('').reverse().join(''),              // scrambled
    cl.slice(0, 20) + 'AAAA' + cl.slice(24),                      // bit rot in the deflate stream
    '~ ' + PC.b64encode([2, 0, 1, 0, 0, 0]),                      // unknown version
    '~ ' + PC.b64encode([1, 4].concat([1, 0, 0, 0])),             // unknown flag
    '~ ' + PC.b64encode([1, 0, 2, 0, 0, 0, 9, 9, 9].concat(new Array(c.cols * c.rows).fill(5))), // index ≥ n
    '~ ' + PC.b64encode([1, 0, 1, 0, 0, 0, 0]),                   // too short for the grid
    '~ !!!!not base64',
  ];
  bad.forEach(function (l, k) {
    var d = PC.parseBlock(withLine(l));
    assert.ok(d, 'case ' + k);
    if (k === 7) { assert.strictEqual(d.lines.length, c.rows); return; }   // not a colour line at all: just art (mono)
    assert.strictEqual(d.palette, null, 'case ' + k); assert.strictEqual(d.colorError, true, 'case ' + k);
    assert.deepStrictEqual(d.lines, c.lines, 'art intact ' + k);
    assert.strictEqual(PC.colorsOf(d).palette.length, 1);
  });
  // the header says another size: colours can't line up → mono, art padded / cut to the header
  var d2 = PC.parseBlock(withLine(cl, '```postcard 41x' + c.rows + ' dense color'));
  assert.strictEqual(d2.palette, null); assert.strictEqual(d2.lines[0].length, 41);
  var d3 = PC.parseBlock(withLine(cl, '```postcard 39x' + (c.rows - 1) + ' dense color'));
  assert.strictEqual(d3.palette, null); assert.strictEqual(d3.lines.length, c.rows - 1); assert.strictEqual(d3.lines[0], c.lines[0].slice(0, 39));
  // short / missing lines are padded
  var cut = ls.slice(0, 4).concat([cl, '```']).join('\n'), d4 = PC.parseBlock(cut);
  assert.strictEqual(d4.lines.length, c.rows); assert.strictEqual(d4.lines[c.rows - 1], new Array(41).join(' '));
  assert.ok(d4.palette, 'colours still align by position');
  // an explicit mono in the info ignores the colour line
  assert.strictEqual(PC.parseBlock(withLine(cl, '```postcard 40x' + c.rows + ' dense mono')).palette, null);
  // fuzz: random edits anywhere never throw
  var s = 99;
  for (var f = 0; f < 400; f++) {
    var t = good.split(''), n = 1 + f % 6;
    for (var e = 0; e < n; e++) { s = (s * 1103515245 + 12345) & 0x7fffffff; t[s % t.length] = String.fromCharCode(32 + (s >> 8) % 95); }
    var r = PC.parseBlock(t.join(''));
    if (r) { assert.ok(Array.isArray(r.lines)); if (r.palette) assert.ok(r.idx.length === r.cols * r.rows); }
  }
  [null, undefined, '', '```', '```postcard', 'hello', '```js\nx\n```', '```postcard 0x0\n\n```', '```postcard 9999x9999 classic\nab\n```'].forEach(function (x) { PC.parseBlock(x); });
  assert.strictEqual(PC.decodeColors('~ AAAA', 0, 0), null);
});
test('fence info: tokens in any order, quoted caption, unknown tokens ignored', function () {
  var m = PC.parseInfo('postcard "Porto, at dusk" sepia 64x32 braille paper future-token');
  assert.strictEqual(m.cols, 64); assert.strictEqual(m.rows, 32); assert.strictEqual(m.style, 'braille'); assert.strictEqual(m.mode, 'sepia'); assert.strictEqual(m.bg, 'paper'); assert.strictEqual(m.caption, 'Porto, at dusk');
  assert.strictEqual(PC.parseInfo('python'), null);
  assert.strictEqual(PC.parseInfo('postcards 2x2'), null);
  assert.strictEqual(PC.parseInfo('postcard tint:#ABC').tint, '#aabbcc');
  var spec = PC.parseInfo('postcard 64x32 classic color "Lisbon, 21 Oct 2026"');      // the spec's own example
  assert.deepStrictEqual([spec.cols, spec.rows, spec.style, spec.mode, spec.bg, spec.caption], [64, 32, 'classic', 'color', 'dark', 'Lisbon, 21 Oct 2026']);
  var card = { cols: 3, rows: 1, style: 'classic', mode: 'mono', bg: 'dark', caption: 'say "hi" `now`\n', lines: ['.:-'] };
  assert.strictEqual(PC.infoOf(card), 'postcard 3x1 classic mono dark "say \'hi\' \'now\'"');
  // no size in the header: taken from the art
  var d = PC.parseBlock('```postcard\nabc\nde\n```');
  assert.deepStrictEqual([d.cols, d.rows, d.lines[1]], [3, 2, 'de ']);
});
test('findBlocks: the editor\'s fence rule, closed blocks only', function () {
  var c = sample({ cols: 24, mode: 'color' }), blk = PC.toText(c, PC.encodeColorsSync(c));
  var note = '# Diary\n\n```js\nlet a = 1\n```\n\n' + blk + '\n\ntext\n\n```\n```postcard 2x1 classic mono\n.:\n' + blk + '\n\n```postcard 2x1\nunclosed';
  var bl = PC.findBlocks(note);
  assert.strictEqual(bl.length, 2, 'the third ```postcard is inside a plain fence (it closes it); the last never closes');
  assert.strictEqual(bl[0].line, 7); assert.strictEqual(bl[0].text, blk); sameCard(c, bl[0].card, 'found');
  assert.strictEqual(note.slice(bl[1].from, bl[1].to), blk);
  assert.deepStrictEqual(PC.findBlocks('no cards here'), []);
});

// ---- renderer ----
function mockCtx() {
  var log = { fillStyle: [], text: 0, rect: 0, arc: 0, fill: 0 }, fs = '';
  return {
    log: log, globalAlpha: 1, font: '', textBaseline: '', textAlign: '',
    set fillStyle(v) { fs = v; log.fillStyle.push(v); }, get fillStyle() { return fs; },
    measureText: function () { return { width: 60 }; },
    fillRect: function () { log.rect++; }, fillText: function () { log.text++; },
    beginPath: function () {}, moveTo: function () {}, arc: function () { log.arc++; }, fill: function () { log.fill++; }
  };
}
test('renderer: one fillStyle per colour (+ background), runs not cells, blocks and braille as shapes', function () {
  var c = sample({ cols: 60, style: 'classic', mode: 'color', colors: 16 });
  var ctx = mockCtx(), L = PC.draw(ctx, c, { width: 620 });
  var used = {}, cells = 0;
  for (var i = 0; i < c.idx.length; i++) { var ch = c.lines[(i / c.cols) | 0].charAt(i % c.cols); if (ch !== ' ') { used[c.idx[i]] = 1; cells++; } }
  assert.strictEqual(ctx.log.fillStyle.length, 1 + Object.keys(used).length, 'bg + each colour once');
  assert.ok(ctx.log.text > 0 && ctx.log.text < cells / 2, 'text drawn in runs: ' + ctx.log.text + ' calls for ' + cells + ' cells');
  assert.deepStrictEqual([L.width, L.height], [620, Math.round(620 / 62 * (c.rows * 2 + 2))]);
  assert.strictEqual(L.height, V.cardHeight(c.cols, c.rows, 620), 'the plugin reserves the same height');
  var b = sample({ cols: 40, style: 'blocks', mode: 'mono' }), cb = mockCtx();
  PC.draw(cb, b, { width: 400 });
  assert.strictEqual(cb.log.text, 0); assert.ok(cb.log.rect > 40);
  var br = sample({ cols: 40, style: 'braille', mode: 'color', colors: 8 }), cr = mockCtx();
  PC.draw(cr, br, { width: 400 });
  assert.strictEqual(cr.log.text, 0); assert.ok(cr.log.arc > 100); assert.ok(cr.log.fill <= 8);
  var withCap = PC.layout(c, 620, true);
  assert.ok(withCap.capH > 0 && withCap.height === L.height + withCap.capH);
});
test('colours per paper: mono ink is the theme\'s text colour; tint / green / sepia one ink', function () {
  var base = { cols: 2, rows: 1, lines: ['@@'], style: 'classic', palette: null, idx: null };
  function ink(o) { var k = Object.assign({}, base, o); return PC.colorsOf(k); }
  assert.deepStrictEqual([ink({ mode: 'mono', bg: 'dark' }).palette[0], ink({ mode: 'mono', bg: 'dark' }).bg], ['#e7e5e3', '#111110']);
  assert.deepStrictEqual([ink({ mode: 'mono', bg: 'light' }).palette[0], ink({ mode: 'mono', bg: 'light' }).bg], ['#1c1917', '#fafaf9']);
  assert.strictEqual(ink({ mode: 'tint', tint: '#123456', bg: 'dark' }).palette[0], '#123456');
  assert.strictEqual(ink({ mode: 'green', bg: 'dark' }).palette[0], '#3dff7a');
});

// ---- editor plugin: the block finder ----
function Doc(text) {
  var ls = text.split('\n'), st = [], p = 0;
  for (var i = 0; i < ls.length; i++) { st.push(p); p += ls[i].length + 1; }
  this.length = text.length; this.lines = ls.length;
  this.line = function (n) { return { number: n, from: st[n - 1], to: st[n - 1] + ls[n - 1].length, text: ls[n - 1] }; };
  this.lineAt = function (pos) { var lo = 0, hi = st.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (st[m] <= pos) lo = m; else hi = m - 1; } return this.line(lo + 1); };
  this.sliceString = function (a, b) { return text.slice(a, b); };
  this.iterLines = function () { var i = -1; return { done: false, value: '', next: function () { i++; this.done = i >= ls.length; this.value = this.done ? '' : ls[i]; return this; } }; };
}
test('view: scan finds the same blocks as the core, with the header facts the bar needs', function () {
  var c = sample({ cols: 30, mode: 'color', caption: 'Lisbon' }), blk = PC.toText(c, PC.encodeColorsSync(c));
  var note = 'intro\n```py\nprint(1)\n```\n' + blk + '\nmid\n' + blk + '\n```postcard 3x1\n...';
  var sc = V.scan(new Doc(note)), core = PC.findBlocks(note);
  assert.strictEqual(sc.n, 3, 'three ```postcard lines'); assert.strictEqual(sc.blocks.length, 2);
  sc.blocks.forEach(function (b, i) {
    assert.strictEqual(b.from, core[i].from); assert.strictEqual(b.to, core[i].to); assert.strictEqual(b.text, blk);
    assert.deepStrictEqual([b.cols, b.rows, b.bg, b.cap, b.style, b.ok], [30, c.rows, 'dark', 'Lisbon', 'classic', true]);
  });
  assert.strictEqual(sc.blocks[0].h, sc.blocks[1].h, 'same content, same hash');
  assert.deepStrictEqual(V.scan(new Doc('plain\ntext\n```js\n```')), { n: 0, blocks: [] });
  assert.strictEqual(V.plainArt(blk), c.lines.join('\n'));
  assert.deepStrictEqual(V.head('```postcard "a 3x3 b" 10x4 paper'), { cols: 10, rows: 4, bg: 'paper', style: '', cap: 'a 3x3 b' });
});
test('view: a block opens (raw text) only while a selection end is inside it', function () {
  var blocks = [{ from: 10, to: 50 }, { from: 60, to: 90 }];
  function sel(pairs) { return { ranges: pairs.map(function (p) { return { anchor: p[0], head: p[1] }; }) }; }
  assert.strictEqual(V.openKey(sel([[0, 0]]), blocks), '00');
  assert.strictEqual(V.openKey(sel([[10, 10]]), blocks), '10');
  assert.strictEqual(V.openKey(sel([[50, 50]]), blocks), '10');
  assert.strictEqual(V.openKey(sel([[51, 51]]), blocks), '00');
  assert.strictEqual(V.openKey(sel([[0, 100]]), blocks), '00', 'select-all keeps the cards');
  assert.strictEqual(V.openKey(sel([[0, 70]]), blocks), '01');
  assert.strictEqual(V.openKey(sel([[0, 0], [65, 65]]), blocks), '01');
});

test('PNG file name: a slug of the caption, or the date when there is none', function () {
  assert.strictEqual(PC.pngName('Lisbon — 21 Oct 2026'), 'postcard-lisbon-21-oct-2026.png');
  assert.strictEqual(PC.pngName('  ¡Olá!  '), 'postcard-ol.png');
  assert.strictEqual(PC.pngName('', new Date(2026, 0, 5)), 'postcard-2026-01-05.png');
  assert.strictEqual(PC.pngName('🌅', new Date(2026, 9, 21)), 'postcard-2026-10-21.png');
  var long = PC.pngName(new Array(30).join('ab cd '));
  assert.ok(long.length <= 'postcard-.png'.length + 48 && !/-\.png$/.test(long), long);
});

Promise.all(pending).then(function () {
  console.log((process.exitCode ? 'FAILED, ' : '') + 'postcard: ' + passed + ' passed');
});
