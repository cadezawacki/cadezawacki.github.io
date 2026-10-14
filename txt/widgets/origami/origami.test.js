/* Unit tests for Origami's layout tree (split, close, swap, resize, presets,
 * normalising saved layouts). Not loaded by the app.
 * Run: node txt/widgets/origami/origami.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var O = require('./origami.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
var n = 0; function id() { return 'p' + (n++); }
function ids(t) { return O.panes(t).map(function (p) { return p.id; }).join(','); }
function sum(f) { return f.reduce(function (s, x) { return s + x; }, 0); }
function shape(t) { return t.t === 'p' ? t.id : t.d + '(' + t.k.map(shape).join(' ') + ')'; }

test('split right / down builds the tree; same direction adds a sibling', function () {
  var t = O.mkPane('a', 'Notes');
  t = O.splitAt(t, 'a', 'h', O.mkPane('b', 'Notes'));
  assert.strictEqual(shape(t), 'h(a b)');
  t = O.splitAt(t, 'b', 'h', O.mkPane('c', 'Todo'));
  assert.strictEqual(shape(t), 'h(a b c)', 'a third column, not a nested split');
  assert.ok(Math.abs(sum(t.f) - 1) < 1e-9);
  assert.deepStrictEqual(t.f.map(function (x) { return +x.toFixed(3); }), [0.5, 0.25, 0.25], 'b gave half its width to c');
  t = O.splitAt(t, 'a', 'v', O.mkPane('d', 'Log'), true);
  assert.strictEqual(shape(t), 'h(v(d a) b c)', 'before = above');
  assert.strictEqual(ids(t), 'd,a,b,c');
  assert.strictEqual(O.locate(t, 'c').node.room, 'Todo');
});

test('the pane limit holds', function () {
  var t = O.mkPane('x0', 'r');
  for (var i = 1; i < 10; i++) t = O.splitAt(t, 'x0', i % 2 ? 'h' : 'v', O.mkPane('x' + i, 'r'));
  assert.strictEqual(O.panes(t).length, O.MAX_PANES);
});

test('closing a pane folds single-kid splits and merges same-direction ones', function () {
  var t = O.mkSplit('h', [O.mkPane('a'), O.mkSplit('v', [O.mkPane('b'), O.mkPane('c')]), O.mkPane('d')], [0.3, 0.4, 0.3]);
  t = O.removePane(t, 'b');
  assert.strictEqual(shape(t), 'h(a c d)', 'the column with one pane left folds into its parent');
  assert.ok(Math.abs(sum(t.f) - 1) < 1e-9);
  t = O.removePane(t, 'a'); t = O.removePane(t, 'd');
  assert.strictEqual(shape(t), 'c', 'down to one pane: the root is the pane');
  assert.strictEqual(O.removePane(t, 'c'), t, 'the last pane stays');
  // a nested split of the grandparent's direction merges into it
  var g = O.mkSplit('h', [O.mkSplit('v', [O.mkPane('a'), O.mkSplit('h', [O.mkPane('b'), O.mkPane('c')])]), O.mkPane('d')]);
  g = O.removePane(g, 'a');
  assert.strictEqual(shape(g), 'h(b c d)');
  assert.ok(Math.abs(sum(g.f) - 1) < 1e-9);
});

test('swap, resize with a minimum, even out', function () {
  var t = O.mkSplit('h', [O.mkPane('a', 'A'), O.mkPane('b', 'B'), O.mkPane('c', 'C')]);
  O.swapPanes(t, 'a', 'c');
  assert.strictEqual(ids(t), 'c,b,a');
  assert.strictEqual(t.k[0].room, 'C');
  assert.ok(O.resize(t, 0, 0.2));
  assert.ok(Math.abs(t.f[0] - (1 / 3 + 0.2)) < 1e-9 && Math.abs(t.f[1] - (1 / 3 - 0.2)) < 1e-9);
  O.resize(t, 0, 0.9);
  assert.ok(Math.abs(t.f[1] - O.MIN_FRAC) < 1e-9, 'never below the minimum');
  assert.ok(Math.abs(sum(t.f) - 1) < 1e-9);
  assert.strictEqual(O.resize(t, 2, 0.1), false, 'no divider after the last kid');
  O.equalize(t);
  t.f.forEach(function (x) { assert.ok(Math.abs(x - 1 / 3) < 1e-9); });
});

test('presets fill from the room list (live room first, repeats when short)', function () {
  n = 0;
  var rooms = ['Live', 'Two', 'Three', 'Four'];
  O.PRESETS.forEach(function (P) {
    var t = O.preset(P.id, rooms, id);
    assert.strictEqual(O.panes(t).length, P.n, P.id);
    assert.strictEqual(O.panes(t)[0].room, 'Live', P.id + ' starts with the live room');
  });
  assert.strictEqual(shape(O.preset('grid', rooms, function () { return 'q' + (n++); })).replace(/q\d+/g, 'p'), 'v(h(p p) h(p p))');
  assert.deepStrictEqual(O.panes(O.preset('cols3', ['Only'], id)).map(function (p) { return p.room; }), ['Only', 'Only', 'Only']);
  var m = O.preset('main2', rooms, id);
  assert.deepStrictEqual(m.f, [0.6, 0.4]);
  assert.ok(O.PRESETS.some(function (P) { return P.id === 'single'; }) && O.PRESETS.filter(function (P) { return P.phone; }).every(function (P) { return P.id === 'single' || /^rows/.test(P.id); }));
});

test('saved layouts are normalised; junk is rejected', function () {
  var good = O.mkSplit('h', [O.mkPane('a', 'A'), O.mkSplit('v', [O.mkPane('b', 'B'), O.mkPane('c', 'C')], [3, 1])], [1, 1]);
  var t = O.normalize(JSON.parse(JSON.stringify(good)));
  assert.strictEqual(shape(t), 'h(a v(b c))');
  assert.ok(Math.abs(t.k[1].f[0] - 0.75) < 1e-9, 'fractions renormalised');
  assert.strictEqual(O.normalize(null), null);
  assert.strictEqual(O.normalize({ t: 'x' }), null);
  assert.strictEqual(O.normalize({ t: 's', d: 'h', k: [] }), null);
  assert.strictEqual(shape(O.normalize({ t: 's', d: 'h', k: [{ t: 'p', id: 'a' }, { t: 'p', id: 'a' }, 7] })), 'a', 'duplicate ids and junk kids dropped; one kid → the pane');
  assert.strictEqual(O.normalize({ t: 'p', id: '<img>' }), null, 'ids are plain');
  var big = { t: 's', d: 'v', k: [] };
  for (var i = 0; i < 12; i++) big.k.push({ t: 'p', id: 'z' + i, room: 'r' });
  assert.strictEqual(O.panes(O.normalize(big)).length, O.MAX_PANES, 'capped');
  var deep = { t: 'p', id: 'leaf' };
  for (i = 0; i < 12; i++) deep = { t: 's', d: 'h', k: [deep, { t: 'p', id: 'd' + i }] };
  assert.ok(O.normalize(deep) === null || O.panes(O.normalize(deep)).length <= O.MAX_PANES, 'deep nesting stays bounded');
  assert.strictEqual(O.normalize({ t: 'p', id: 'a', room: 5 }).room, '');
});

test('manifest entry matches the widget', function () {
  var widget = null;
  global.window = { Cade: { loadCSS: function () {}, registerWidget: function (w) { widget = w; }, CM: { EditorView: function () {}, EditorState: {} } } };
  delete require.cache[require.resolve('./origami.js')];
  require('./origami.js');
  delete global.window;
  var e = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'origami'; })[0];
  assert.ok(widget && e, 'registered and in the manifest');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(e[k], widget[k], k); });
  assert.strictEqual(e.entry, 'widgets/origami/origami.js'); assert.strictEqual(e.css, 'widgets/origami/origami.css');
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
