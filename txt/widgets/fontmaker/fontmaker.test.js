/* Checks for Font Maker: glyph-set bookkeeping, stroke capture maths
 * (units, pressure, smoothing), stroke → outline (closed, simple, correctly
 * oriented contours; unions; holes), metrics, the OpenType build re-parsed with
 * the vendored opentype.js (glyph count, cmap, advances, names, GSUB), the
 * WOFF wrapper, the image text layout, and that the widget registers as the
 * manifest entry says. Not loaded by the app.
 * Run: node txt/widgets/fontmaker/fontmaker.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), zlib = require('zlib');
var FM = require('./fontmaker-core.js');
var ot = require('./opentype.min.js');
var passed = 0, pending = [];
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(function () { passed++; }, function (e) { fail(name, e); }));
    else passed++;
  } catch (e) { fail(name, e); }
}
function fail(name, e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' ≉ ' + b + ' (±' + tol + ')'); }

// ---- the proposed manifest entry ----
var ENTRY = {
  id: 'fontmaker', type: 'widget', name: 'Font Maker',
  description: 'Turn your handwriting into a real font — draw each letter with a finger or Apple Pencil, save it as an .otf, use it in the app and make pictures of text in it',
  icon: '✍️',
  tags: 'font,font maker,handwriting,hand writing,typeface,otf,woff,opentype,glyph,letters,lettering,calligraphy,pencil,apple pencil,draw,image,png,card',
  entry: 'widgets/fontmaker/fontmaker.js', css: 'widgets/fontmaker/fontmaker.css',
  precache: ['widgets/fontmaker/fontmaker-core.js', 'widgets/fontmaker/opentype.min.js'],
  prefs: {
    title: 'Font Maker',
    fields: [
      { key: 'ghost', type: 'toggle', label: 'Show a faint letter to trace over', default: true },
      { key: 'pencil', type: 'toggle', label: 'Pencil only once a pen is used', default: true, hint: 'On an iPad: after the Apple Pencil touches the drawing square, fingers and palms no longer draw' },
      { key: 'autoNext', type: 'toggle', label: 'Go to the next letter after a pause', default: false, hint: '1.5 s after you lift the pen' },
      { key: 'preview', type: 'text', label: 'Preview word', default: 'Hamburgefonts', placeholder: 'Hamburgefonts', maxLength: 40 }
    ]
  }
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}
function loadWidget() {
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'fontmaker.js'), 'utf8');
  var win = { Cade: { loadCSS: function (p) { css.push(p); }, baseURL: function () { return './txt/widgets/fontmaker/'; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } };
  new Function('window', src)(win);
  return { reg: reg, css: css, win: win };
}
test('widget registers with the manifest entry\'s name, description, icon, tags and prefs', function () {
  var w = loadWidget(), entries = [ENTRY], live = manifestEntry('fontmaker');
  if (live) entries.push(live);
  assert.ok(w.reg, 'registered');
  assert.deepStrictEqual(w.css, ['fontmaker.css']);
  entries.forEach(function (e) {
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(w.reg[k], e[k], k); });
    assert.deepStrictEqual(w.reg.prefsFields, e.prefs.fields, 'prefs fields');
    assert.strictEqual(e.entry, 'widgets/fontmaker/fontmaker.js');
    e.precache.concat([e.entry, e.css]).forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f + ' exists'); });
  });
  assert.strictEqual(typeof w.reg.open, 'function');
});
test('vendored opentype.js keeps its MIT licence header', function () {
  var head = fs.readFileSync(path.join(__dirname, 'opentype.min.js'), 'utf8').slice(0, 1500);
  assert.ok(/opentype\.js 1\.3\.4/.test(head) && /MIT License/.test(head) && /Permission is hereby granted/.test(head));
});

// ---- glyph sets + bookkeeping ----
test('glyph sets: quick set first, then digits and punctuation; unique valid glyph names', function () {
  assert.deepStrictEqual(FM.SETS.map(function (s) { return [s.id, s.chars.length]; }), [['quick', 52], ['digits', 10], ['punct', 19]]);
  assert.strictEqual(new Set(FM.ALL).size, FM.ALL.length);
  var names = FM.ALL.map(function (c) { return FM.glyphName(c, 0); }).concat(FM.ALL.map(function (c) { return FM.glyphName(c, 2); }));
  assert.strictEqual(new Set(names).size, names.length);
  names.forEach(function (n) { assert.ok(/^[A-Za-z][A-Za-z0-9._]*$/.test(n), n); });
  assert.strictEqual(FM.glyphName('?', 1), 'question.alt1');
  '.,!?\'"-:;()&@#$%/+='.split('').forEach(function (c) { assert.ok(FM.ALL.indexOf(c) >= 0, c); });
});
function line(x0, y0, x1, y1, n, p) { var o = []; n = n || 20; for (var i = 0; i <= n; i++) o.push({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n, p: p == null ? 0.5 : p }); return o; }
function circle(cx, cy, r, n) { var o = []; for (var i = 0; i <= n; i++) { var a = i / n * Math.PI * 2; o.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), p: 0.5 }); } return o; }
test('bookkeeping: add / undo / clear / versions / progress / step', function () {
  var f = FM.newFont('Mine');
  assert.ok(f.id && f.name === 'Mine' && f.sync === false);
  assert.deepStrictEqual(f.settings, FM.DEFAULTS);
  assert.strictEqual(FM.addStroke(f, 'é', 0, [0, 0, 50]), false, 'unknown char');
  assert.strictEqual(FM.addStroke(f, 'a', 3, [0, 0, 50]), false, 'too many versions');
  assert.strictEqual(FM.addStroke(f, 'a', 0, []), false, 'empty');
  assert.ok(FM.addStroke(f, 'a', 0, FM.finishStroke(line(0, 0, 0, 400))));
  assert.ok(FM.addStroke(f, 'a', 0, FM.finishStroke(line(0, 0, 200, 0))));
  assert.ok(FM.addStroke(f, 'a', 1, FM.finishStroke(line(0, 0, 0, 300))));
  assert.ok(FM.addStroke(f, 'Z', 0, [10, 10, 50]));
  assert.deepStrictEqual(FM.progress(f, 'quick'), { done: 2, total: 52 });
  assert.deepStrictEqual(FM.progress(f), { done: 2, total: 81 });
  assert.strictEqual(FM.variants(f, 'a').length, 2);
  assert.ok(FM.undoStroke(f, 'a', 0));
  assert.strictEqual(f.glyphs.a[0].length, 1);
  FM.clearGlyph(f, 'a', 0);
  assert.strictEqual(FM.variants(f, 'a').length, 1, 'v2 still drawn');
  assert.ok(FM.hasGlyph(f, 'a'));
  FM.clearGlyph(f, 'a', 1);
  assert.ok(!f.glyphs.a, 'empty glyph removed');
  assert.strictEqual(FM.undoStroke(f, 'a', 0), null);
  FM.addStroke(f, 'b', 0, [1, 1, 50]); FM.addStroke(f, 'b', 1, [2, 2, 50]); FM.addStroke(f, 'b', 2, [3, 3, 50]);
  FM.removeVariant(f, 'b', 1);
  assert.deepStrictEqual(f.glyphs.b.map(function (v) { return v[0][0]; }), [1, 3], 'later versions shift down');
  var abc = ['a', 'b', 'c', 'd'];
  assert.strictEqual(FM.step(f, abc, 'a', 1), 'b');
  assert.strictEqual(FM.step(f, abc, 'a', -1), 'd', 'wraps');
  assert.strictEqual(FM.step(f, abc, 'a', 1, true), 'c', 'skips drawn');
  assert.strictEqual(FM.step(f, abc, null, 1, true), 'a');
  assert.strictEqual(FM.glyphCount(f), 2);
});
test('normFont repairs junk from storage / another device; cloneFont is independent', function () {
  var f = FM.normFont({ id: 'x', name: 42, settings: { weight: 9999, slant: 'a', spacing: -5 }, glyphs: { a: [[[1.4, 2.6, 500, 7]], [], 'no'], '€': [[[0, 0, 0]]], b: 'bad', c: [[], []] }, sync: 1 });
  assert.strictEqual(f.name, '42');
  assert.deepStrictEqual(f.settings, { weight: 90, spacing: 0, slant: 0, space: 300 });
  assert.deepStrictEqual(f.glyphs, { a: [[[1, 3, 100]]] }, 'rounded, clamped, trailing empties and unknown chars dropped');
  assert.strictEqual(f.sync, true);
  assert.strictEqual(FM.normFont(null), null);
  var c = FM.cloneFont(f, 'Copy');
  assert.ok(c.id !== f.id && c.name === 'Copy' && c.sync === false);
  c.glyphs.a[0][0][0] = 99;
  assert.strictEqual(f.glyphs.a[0][0][0], 1);
});

// ---- capture ----
test('canvas pixels ↔ font units', function () {
  var V = FM.VIEW;
  assert.deepStrictEqual(FM.toUnits(0, 0, 300, 300), { x: V.x0, y: V.y1 });
  assert.deepStrictEqual(FM.toUnits(300, 300, 300, 300), { x: V.x1, y: V.y0 });
  var b = FM.fromUnits(0, 0, 360, 360);   // baseline / left edge of the em
  near(b.x, 30, 1e-9); near(b.y, 270, 1e-9);
  var u = FM.toUnits(123.4, 56.7, 333, 333), p = FM.fromUnits(u.x, u.y, 333, 333);
  near(p.x, 123.4, 1e-9); near(p.y, 56.7, 1e-9);
  assert.strictEqual(FM.METRICS.unitsPerEm, 1000);
});
test('pressure: mice and fingers are flat, pens vary within bounds', function () {
  assert.strictEqual(FM.normPressure(0, 'mouse'), 0.5);
  assert.strictEqual(FM.normPressure(1, 'touch'), 0.5);
  assert.strictEqual(FM.normPressure(0, 'pen'), 0.5);
  assert.strictEqual(FM.normPressure(0.9, 'pen'), 0.9);
  assert.strictEqual(FM.normPressure(3, 'pen'), 1);
  assert.ok(FM.radiusAt(30, 1) > FM.radiusAt(30, 0.5) && FM.radiusAt(30, 0.5) > FM.radiusAt(30, 0));
  near(FM.radiusAt(30, 0.5), 30, 1e-9);
  assert.ok(FM.radiusAt(30, 1) / FM.radiusAt(30, 0) < 1.6, 'only a little');
});
test('finishStroke smooths jitter, simplifies, keeps the ends, stores ints', function () {
  var pts = [];
  for (var i = 0; i <= 200; i++) pts.push({ x: i * 2, y: 100 + (i % 2 ? 3 : -3), p: 0.5 });
  var s = FM.finishStroke(pts);
  assert.strictEqual(s.length % 3, 0);
  assert.ok(s.length / 3 < 30, 'simplified: ' + s.length / 3 + ' points');
  s.forEach(function (v) { assert.strictEqual(v, Math.round(v)); });
  assert.deepStrictEqual(s.slice(0, 2), [0, 97]);
  assert.deepStrictEqual(s.slice(-3, -1), [400, 97]);
  for (i = 3; i < s.length - 3; i += 3) assert.ok(Math.abs(s[i + 1] - 100) <= 2, 'jitter smoothed: ' + s[i + 1]);
  assert.deepStrictEqual(FM.finishStroke([{ x: 5.2, y: 6.7, p: 1 }]), [5, 7, 100], 'a dot');
  assert.deepStrictEqual(FM.finishStroke([{ x: 1, y: 1 }, { x: 1.2, y: 1.1 }]), [1, 1, 50], 'duplicates merged');
  assert.strictEqual(FM.finishStroke([]), null);
  var c = FM.finishStroke(circle(0, 0, 200, 120));
  assert.ok(c.length / 3 >= 12 && c.length / 3 < 70, 'curve keeps enough points: ' + c.length / 3);
});

// ---- outline ----
function segsIntersect(a, b, c, d) {
  function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
  var d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function assertSimple(poly, label) {
  var n = poly.length;
  assert.ok(n >= 3, label + ': ≥ 3 points');
  for (var i = 0; i < n; i++) {
    var a = poly[i], b = poly[(i + 1) % n];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01, label + ': no zero-length edge at ' + i);
    for (var j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      assert.ok(!segsIntersect(a, b, poly[j], poly[(j + 1) % n]), label + ': edges ' + i + ' and ' + j + ' cross');
    }
  }
  assert.ok(Math.abs(FM.polyArea(poly)) > 10, label + ': not degenerate');
}
function inside(poly, x, y) {
  var c = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function totalArea(polys) { return polys.reduce(function (s, p) { return s + FM.polyArea(p); }, 0); }
test('a straight stroke becomes one closed counter-clockwise capsule of the right size', function () {
  var r = 30, polys = FM.strokeContours([FM.finishStroke(line(0, 0, 0, 500))], r);
  assert.strictEqual(polys.length, 1);
  assertSimple(polys[0], 'capsule');
  assert.ok(FM.polyArea(polys[0]) > 0, 'outer contour CCW');
  near(FM.polyArea(polys[0]), 2 * r * 500 + Math.PI * r * r, (2 * r * 500 + Math.PI * r * r) * 0.03, 'area');
  var xs = polys[0].map(function (q) { return q[0]; }), ys = polys[0].map(function (q) { return q[1]; });
  near(Math.min.apply(null, xs), -r, 2); near(Math.max.apply(null, xs), r, 2);
  near(Math.min.apply(null, ys), -r, 2); near(Math.max.apply(null, ys), 500 + r, 2);
});
test('a closed loop gives an outer contour and a hole of opposite orientation', function () {
  var polys = FM.strokeContours([FM.finishStroke(circle(250, 250, 200, 90))], 30);
  assert.strictEqual(polys.length, 2);
  polys.forEach(function (p, i) { assertSimple(p, 'o' + i); });
  var outer = polys.filter(function (p) { return FM.polyArea(p) > 0; }), hole = polys.filter(function (p) { return FM.polyArea(p) < 0; });
  assert.strictEqual(outer.length, 1); assert.strictEqual(hole.length, 1);
  assert.ok(inside(outer[0], 250, 250) && inside(hole[0], 250, 250), 'hole nested in the outer contour');
  near(totalArea(polys), Math.PI * (230 * 230 - 170 * 170), Math.PI * (230 * 230 - 170 * 170) * 0.03, 'ring area');
});
test('crossing strokes are merged (no overlapping contours); separate strokes stay separate', function () {
  var x = FM.strokeContours([FM.finishStroke(line(0, 0, 400, 400)), FM.finishStroke(line(0, 400, 400, 0))], 25);
  assert.strictEqual(x.length, 1, 'X is one contour');
  assertSimple(x[0], 'X');
  var two = FM.strokeContours([FM.finishStroke(line(0, 0, 0, 300)), FM.finishStroke(line(300, 0, 300, 300))], 25);
  assert.strictEqual(two.length, 2);
  two.forEach(function (p) { assert.ok(FM.polyArea(p) > 0); });
});
test('tight scribbles (zigzags, hairpins, self-crossing loops, dots) give simple contours', function () {
  var zig = [];
  for (var i = 0; i <= 12; i++) zig.push({ x: i * 25, y: i % 2 ? 300 : 0, p: 0.5 });
  var hair = line(0, 0, 0, 400, 10).concat(line(8, 400, 8, 0, 10));
  var loopy = [];
  for (i = 0; i <= 300; i++) { var t = i / 300 * Math.PI * 6; loopy.push({ x: t * 40 + 60 * Math.cos(t), y: 200 + 120 * Math.sin(t), p: 0.3 + 0.7 * (i % 7) / 7 }); }
  [[zig, 'zigzag'], [hair, 'hairpin'], [loopy, 'loops'], [[{ x: 50, y: 50, p: 1 }], 'dot']].forEach(function (c) {
    var polys = FM.strokeContours([FM.finishStroke(c[0])], 34);
    assert.ok(polys.length >= 1, c[1]);
    polys.forEach(function (p, k) { assertSimple(p, c[1] + k); });
    assert.ok(totalArea(polys) > 0, c[1] + ': ink, not a hole');
  });
});
test('pressure widens the outline', function () {
  var light = FM.strokeContours([FM.finishStroke(line(0, 0, 0, 400, 20, 0.1))], 30), heavy = FM.strokeContours([FM.finishStroke(line(0, 0, 0, 400, 20, 1))], 30);
  assert.ok(totalArea(heavy) > totalArea(light) * 1.2);
});
test('contourToPath: one M, a Q per vertex, Z; on-curve points are edge midpoints', function () {
  var sq = [[0, 0], [100, 0], [100, 100], [0, 100]], c = FM.contourToPath(sq);
  assert.deepStrictEqual(c.map(function (x) { return x.type; }).join(''), 'MQQQQZ');
  assert.deepStrictEqual([c[0].x, c[0].y], [0, 50]);
  assert.deepStrictEqual([c[1].x1, c[1].y1, c[1].x, c[1].y], [0, 0, 50, 0]);
  assert.deepStrictEqual([c[4].x, c[4].y], [0, 50], 'closes where it started');
});
test('glyphShape: side bearings, advance from ink bounds, weight and slant', function () {
  var strokes = [FM.finishStroke(line(100, 0, 100, 700)), FM.finishStroke(line(100, 700, 400, 700))];
  var st = { weight: 30, spacing: 50, slant: 0, space: 300 };
  var s = FM.glyphShape(strokes, st);
  near(s.xMin, 50, 0.01, 'left bearing');
  near(s.advance, s.xMax - s.xMin + 100, 1, 'advance = ink + bearings');
  near(s.advance, 300 + 60 + 100, 4);
  near(s.yMin, -30, 2); near(s.yMax, 730, 2);
  assert.strictEqual(s.commands[0].type, 'M');
  assert.strictEqual(s.commands[s.commands.length - 1].type, 'Z');
  var heavy = FM.glyphShape(strokes, { weight: 60, spacing: 50, slant: 0 });
  near(heavy.advance - s.advance, 60, 4, 'weight adds to the ink width');
  var wide = FM.glyphShape(strokes, { weight: 30, spacing: 120, slant: 0 });
  near(wide.advance - s.advance, 140, 1, 'spacing on both sides');
  var sl = FM.glyphShape(strokes, { weight: 30, spacing: 50, slant: 20 });
  var tn = Math.tan(20 * Math.PI / 180);
  assert.ok(sl.advance - s.advance > tn * 700 && sl.advance - s.advance < tn * 770, 'slant shears by height: ' + (sl.advance - s.advance));
  near(sl.xMin, 50, 0.01);
  assert.strictEqual(FM.glyphShape([], st), null);
  assert.ok(/^M[-\d. ]+Q/.test(FM.pathToSvg(s.commands)));
});

// ---- the font ----
function sampleFont() {
  var f = FM.newFont('Ünïcode Hand 2');
  FM.addStroke(f, 'H', 0, FM.finishStroke(line(100, 0, 100, 700)));
  FM.addStroke(f, 'H', 0, FM.finishStroke(line(450, 0, 450, 700)));
  FM.addStroke(f, 'H', 0, FM.finishStroke(line(100, 350, 450, 350)));
  FM.addStroke(f, 'o', 0, FM.finishStroke(circle(250, 240, 200, 80)));
  FM.addStroke(f, 'l', 0, FM.finishStroke(line(100, 0, 100, 760)));
  FM.addStroke(f, 'l', 1, FM.finishStroke(line(100, 0, 140, 760)));
  FM.addStroke(f, 'l', 1, FM.finishStroke(line(100, 0, 300, 50)));
  FM.addStroke(f, 'l', 2, FM.finishStroke(line(100, 0, 60, 760)));
  FM.addStroke(f, 'e', 0, FM.finishStroke(circle(200, 200, 150, 40)));
  FM.addStroke(f, 'e', 1, FM.finishStroke(circle(200, 220, 170, 40)));
  FM.addStroke(f, '!', 0, FM.finishStroke(line(80, 200, 80, 700)));
  FM.addStroke(f, '!', 0, [80, 20, 50]);
  FM.addStroke(f, '7', 0, FM.finishStroke(line(50, 700, 400, 700).concat(line(400, 700, 150, 0))));
  f.settings.space = 260;
  return f;
}
function parse(buf) { return ot.parse(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); }
test('buildFont → .otf that opentype.js parses back: glyphs, cmap, advances, names, metrics', function () {
  var f = sampleFont(), list = FM.buildGlyphList(f);
  var font = FM.buildFont(ot, f), buf = font.toArrayBuffer();
  var p = parse(buf);
  assert.strictEqual(p.unitsPerEm, 1000);
  assert.strictEqual(p.glyphs.length, 2 + list.length, '.notdef + space + drawn versions');
  assert.strictEqual(list.length, 9, 'H o l×3 e×2 ! 7');
  assert.strictEqual(p.glyphs.get(0).name, '.notdef');
  var cmap = Object.keys(p.tables.cmap.glyphIndexMap).map(Number).sort(function (a, b) { return a - b; }).map(function (c) { return String.fromCharCode(c); }).join('');
  assert.strictEqual(cmap, ' !7Hello'.split('').filter(function (c, i, a) { return a.indexOf(c) === i; }).sort().join(''));
  assert.strictEqual(p.charToGlyph(' ').advanceWidth, 260);
  list.forEach(function (g) {
    var pg = null;
    for (var i = 0; i < p.glyphs.length; i++) if (p.glyphs.get(i).name === g.name) pg = p.glyphs.get(i);
    assert.ok(pg, g.name + ' present');
    assert.strictEqual(pg.advanceWidth, g.advance, g.name + ' advance');
    var bb = pg.getBoundingBox();
    assert.ok(bb.x2 - bb.x1 > 20 && bb.y2 - bb.y1 > 20, g.name + ' has ink');
    near(bb.x1, f.settings.spacing, 3, g.name + ' left bearing');
  });
  assert.strictEqual(p.charToGlyph('l').name, 'l');
  assert.strictEqual(p.charToGlyph('H').path.commands.filter(function (c) { return c.type === 'M'; }).length, 1, 'H strokes merged into one contour');
  assert.strictEqual(p.charToGlyph('o').path.commands.filter(function (c) { return c.type === 'M'; }).length, 2, 'o has a counter');
  assert.strictEqual(p.names.fontFamily.en, 'Ünïcode Hand 2');
  assert.strictEqual(p.names.postScriptName.en, 'UnicodeHand2-Regular');
  assert.ok(p.tables.os2.sTypoAscender >= 900 && p.tables.os2.sTypoDescender <= -300);
  assert.ok(buf.byteLength < 20000, 'small: ' + buf.byteLength);
});
test('drawn versions → GSUB calt (cycling) + salt; none without versions', function () {
  var p = parse(FM.buildFont(ot, sampleFont()).toArrayBuffer()), g = p.tables.gsub;
  assert.deepStrictEqual(g.features.map(function (x) { return x.tag; }), ['calt', 'salt']);
  assert.deepStrictEqual(g.scripts.map(function (x) { return x.tag; }), ['DFLT', 'latn']);
  var types = g.lookups.map(function (l) { return l.lookupType; });
  assert.deepStrictEqual(types, [1, 1, 6, 3]);
  var id = function (n) { for (var i = 0; i < p.glyphs.length; i++) if (p.glyphs.get(i).name === n) return i; return -1; };
  var l1 = g.lookups[0].subtables[0];
  assert.deepStrictEqual(l1.coverage.glyphs.map(function (i) { return p.glyphs.get(i).name; }), ['e', 'l']);
  assert.deepStrictEqual(l1.substitute, [id('e.alt1'), id('l.alt1')]);
  var calt = g.lookups[2].subtables;
  assert.strictEqual(calt.length, 2);
  assert.deepStrictEqual(calt[0].backtrackCoverage[0].glyphs, [id('e.alt1'), id('l.alt1')], 'after a version-2 glyph → version 3');
  assert.deepStrictEqual(calt[0].inputCoverage[0].glyphs, [id('l')]);
  assert.ok(calt[1].backtrackCoverage[0].glyphs.indexOf(id('H')) >= 0 && calt[1].backtrackCoverage[0].glyphs.indexOf(id('l.alt1')) < 0);
  var salt = g.lookups[3].subtables[0];
  assert.deepStrictEqual(salt.alternateSets, [[id('e.alt1')], [id('l.alt1'), id('l.alt2')]]);
  var plain = FM.newFont('Plain');
  FM.addStroke(plain, 'a', 0, [0, 0, 50, 100, 100, 50]);
  assert.ok(!parse(FM.buildFont(ot, plain).toArrayBuffer()).tables.gsub, 'no GSUB');
});
test('makeWoff wraps the .otf (deflated or stored) and opentype.js reads it', function () {
  var otf = new Uint8Array(FM.buildFont(ot, sampleFont()).toArrayBuffer());
  return Promise.all([FM.makeWoff(otf, function (b) { return zlib.deflateSync(b); }), FM.makeWoff(otf)]).then(function (ws) {
    var z = ws[0], raw = ws[1];
    [z, raw].forEach(function (w, k) {
      assert.strictEqual(Buffer.from(w.slice(0, 4)).toString('latin1'), 'wOFF');
      var dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
      assert.strictEqual(dv.getUint32(8), w.length, 'length field');
      assert.strictEqual(dv.getUint32(16) % 4, 0, 'totalSfntSize padded');
      var p = parse(w);
      assert.strictEqual(p.glyphs.length, parse(otf).glyphs.length, 'woff ' + k);
      assert.strictEqual(p.charToGlyph('H').advanceWidth, parse(otf).charToGlyph('H').advanceWidth);
    });
    assert.ok(z.length < raw.length, 'compressed is smaller');
  });
});
test('a full alphabet builds in reasonable time and stays syncable', function () {
  var f = FM.newFont('Full');
  FM.ALL.forEach(function (ch, i) {
    for (var v = 0; v < (i % 3 === 0 ? 2 : 1); v++) {
      FM.addStroke(f, ch, v, FM.finishStroke(circle(250 + v * 10, 250, 120 + (i % 5) * 20, 50)));
      FM.addStroke(f, ch, v, FM.finishStroke(line(80, -50 + i, 420, 600 - i)));
    }
  });
  var t0 = Date.now(), p = parse(FM.buildFont(ot, f).toArrayBuffer()), ms = Date.now() - t0;
  assert.strictEqual(Object.keys(p.tables.cmap.glyphIndexMap).length, FM.ALL.length + 1);
  assert.ok(ms < 8000, 'built in ' + ms + ' ms');
  assert.ok(JSON.stringify(f).length < 60000, 'stored size ' + JSON.stringify(f).length);
});

// ---- image layout ----
function info(adv) { return function (ch) { if (ch === '~') return { n: 0 }; return { n: ch === 'a' ? 3 : 1, adv: function () { return adv; } }; }; }
test('layoutText wraps to the width, aligns, flags missing glyphs', function () {
  var L = FM.layoutText('aaaa aaaa aaaa\n\nbb ~', info(500), { size: 100, width: 300, lineHeight: 1.5, align: 'left', space: 250 });
  assert.deepStrictEqual(L.lines.map(function (l) { return l.items.map(function (i) { return i.ch; }).join(''); }), ['aaaa', 'aaaa', 'aaaa', '', 'bb ~']);
  L.lines.forEach(function (l) { assert.ok(l.w <= 300 + 1e-9, 'fits'); });
  near(L.lines[1].y - L.lines[0].y, 150, 1e-9, 'line height');
  assert.ok(L.lines[4].items[3].missing && !L.lines[4].items[0].missing);
  var R = FM.layoutText('aa', info(500), { size: 100, width: 1000, align: 'right' }).lines[0];
  near(R.items[0].x, 900, 1e-9, 'right aligned');
  var C = FM.layoutText('aa', info(500), { size: 100, width: 1000, align: 'center' }).lines[0];
  near(C.items[0].x, 450, 1e-9);
  var long = FM.layoutText('aaaaaaaaaaaaaaaaaaaaaaaaa', info(500), { size: 100, width: 1000 });
  assert.strictEqual(long.lines.length, 2, 'an over-long word is broken');
});
test('versions alternate (never the same twice running) and layout is deterministic per seed', function () {
  var L = FM.layoutText('aaaaaaaaaaaa', info(400), { size: 50, width: 1e6, seed: 3 });
  var vs = L.lines[0].items.map(function (i) { return i.vi; });
  for (var i = 1; i < vs.length; i++) assert.notStrictEqual(vs[i], vs[i - 1]);
  assert.ok(new Set(vs).size === 3, 'all versions used');
  assert.deepStrictEqual(FM.layoutText('aaaaaaaaaaaa', info(400), { size: 50, width: 1e6, seed: 3 }), L);
  var J = FM.layoutText('aaaa', info(400), { size: 50, width: 1e6, jitter: 1, seed: 5 }).lines[0].items;
  assert.ok(J.some(function (it) { return it.y !== J[0].y; }) && J.some(function (it) { return it.rot !== 0; }), 'wobble');
  J.forEach(function (it) { assert.ok(Math.abs(it.y - 45) < 50 * 0.08 && Math.abs(it.rot) < 0.04); });
  var N = FM.layoutText('aaaa', info(400), { size: 50, width: 1e6, jitter: 0 }).lines[0].items;
  N.forEach(function (it) { assert.strictEqual(it.y, 45); assert.strictEqual(it.rot, 0); assert.strictEqual(it.scale, 1); });
});
test('psName is ASCII without spaces', function () {
  assert.strictEqual(FM.psName('Cade’s Hand'), 'CadesHand-Regular');
  assert.strictEqual(FM.psName('???'), 'MyHand-Regular');
  assert.strictEqual(FM.psName('Crème brûlée'), 'Cremebrulee-Regular');
});

Promise.all(pending).then(function () { console.log('fontmaker: ' + passed + ' passed'); });
