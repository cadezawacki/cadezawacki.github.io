/* Headless checks for the Layouts widget's saved-layout store.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/layouts/layouts.test.js */
'use strict';
var assert = require('assert');
var P = require('./layouts.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./layouts.js')];
require('./layouts.js');
delete global.window;

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function arr(n, extra) {
  var a = { v: 1, at: 5, panels: [], ws: null };
  for (var i = 0; i < n; i++) a.panels.push({ widget: 'W' + i, id: 'w' + i + '-panel', state: 'open', rect: { x: 0.1, y: 0.2, w: 0.3, h: null } });
  return Object.assign(a, extra || {});
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Layouts' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'layouts.css');
});
test('names are trimmed, collapsed and capped', function () {
  assert.strictEqual(P.cleanName('  my   desk \n '), 'my desk');
  assert.strictEqual(P.cleanName(null), '');
  assert.strictEqual(P.cleanName('x'.repeat(80)).length, 40);
});
test('arrangements are validated: bad panels dropped, numbers clamped', function () {
  var a = P.validArr({ panels: [
    { widget: 'Timer', id: 'timer-panel', state: 'open', snap: 'left' },
    { widget: 'Calc', id: 'calc-panel', state: 'float', slot: '2' },
    { widget: '', id: 'x', state: 'open' }, { widget: 'A', id: 'a', state: 'weird' }, null,
    { widget: 'B', id: 'b-panel', state: 'min', rect: { x: 9, y: 'no', w: 0.5, h: NaN } }
  ], ws: { layout: 'grid4', shape: ['h', 0.5, 'L', ['v', 0.3, 'L', 'L']], w: '800', h: 600 } });
  assert.strictEqual(a.panels.length, 3);
  assert.deepStrictEqual(a.panels[1], { widget: 'Calc', id: 'calc-panel', state: 'float', slot: 2 });
  assert.deepStrictEqual(a.panels[2].rect, { x: 1.5, y: 0, w: 0.5, h: null });
  assert.deepStrictEqual(a.ws, { layout: 'grid4', shape: ['h', 0.5, 'L', ['v', 0.3, 'L', 'L']], w: 800, h: 600 });
  assert.strictEqual(P.validArr({}), null);
  assert.strictEqual(P.validArr(null), null);
});
test('float window tile trees: valid shapes kept, bad ones dropped, at most 8 tiles', function () {
  assert.ok(P.shapeOk('L') && P.shapeOk(['h', 0.4, ['v', 0.7, 'L', 'L'], ['v', 0.25, 'L', ['v', 0.5, 'L', 'L']]]));
  assert.ok(!P.shapeOk(['x', 0.5, 'L', 'L']) && !P.shapeOk(['h', 1.5, 'L', 'L']) && !P.shapeOk(['h', 0.5, 'L']) && !P.shapeOk(null));
  var deep = 'L'; for (var i = 0; i < 12; i++) deep = ['v', 0.5, deep, 'L'];
  assert.ok(!P.shapeOk(deep));
  assert.strictEqual(P.shapeTiles(['h', 0.5, ['v', 0.5, 'L', 'L'], ['v', 1 / 3, 'L', ['v', 0.5, 'L', 'L']]]), 5);
  var nine = 'L'; for (i = 0; i < 8; i++) nine = ['h', 0.5, nine, 'L'];
  var a = P.validArr({ panels: [], ws: { shape: nine } });
  assert.strictEqual(a.ws.shape, null);                    // too many tiles: falls back to the preset
  assert.strictEqual(P.validArr({ panels: [], ws: { layout: 'cols2', colFr: [1, 1] } }).ws.layout, 'cols2');   // older saves still load
  assert.strictEqual(P.validArr({ panels: [], ws: { layout: 5 } }).ws, null);
});
test('save, overwrite by name (any case), newest first', function () {
  var st = P.normStore(null);
  assert.ok(P.upsert(st, 'Morning', arr(2), 1));
  assert.ok(P.upsert(st, 'Trading', arr(3), 2));
  assert.deepStrictEqual(st.items.map(function (i) { return i.name; }), ['Trading', 'Morning']);
  assert.ok(P.upsert(st, 'MORNING', arr(4), 3));
  assert.strictEqual(st.items.length, 2);
  assert.strictEqual(st.items[0].name, 'Morning');          // keeps its original spelling
  assert.strictEqual(st.items[0].arr.panels.length, 4);
  assert.ok(!P.upsert(st, '   ', arr(1), 4));
  assert.ok(!P.upsert(st, 'Bad', { nope: 1 }, 4));
});
test('rename refuses clashes and blanks; delete', function () {
  var st = P.normStore(null);
  P.upsert(st, 'A', arr(1), 1); P.upsert(st, 'B', arr(1), 2);
  assert.ok(!P.rename(st, 'A', 'b'));
  assert.ok(!P.rename(st, 'A', '  '));
  assert.ok(P.rename(st, 'A', 'a'));                         // a case change of itself is fine
  assert.ok(P.rename(st, 'a', 'Charts'));
  assert.ok(P.findItem(st, 'charts') >= 0);
  assert.ok(P.remove(st, 'CHARTS') && !P.remove(st, 'Charts'));
  assert.strictEqual(st.items.length, 1);
});
test('the store survives junk and caps its size', function () {
  var junk = { items: [null, { name: 'ok', arr: arr(1) }, { name: 'OK', arr: arr(2) }, { name: '', arr: arr(1) }, { name: 'bad', arr: 5 }] };
  var st = P.normStore(junk);
  assert.strictEqual(st.items.length, 1);
  assert.deepStrictEqual(P.normStore('nope'), { v: 1, items: [] });
  var big = { items: [] };
  for (var i = 0; i < 80; i++) big.items.push({ name: 'L' + i, arr: arr(1) });
  assert.strictEqual(P.normStore(big).items.length, P.MAX_ITEMS);
  var st2 = P.normStore(null);
  for (i = 0; i < 60; i++) P.upsert(st2, 'L' + i, arr(1), i);
  assert.strictEqual(st2.items.length, P.MAX_ITEMS);
  assert.strictEqual(st2.items[0].name, 'L59');
  assert.deepStrictEqual(P.normStore(JSON.parse(JSON.stringify(st2))), st2);   // round-trips
});
test('suggested names and summaries', function () {
  var st = P.normStore(null);
  assert.strictEqual(P.suggestName(st, ''), 'Layout');
  P.upsert(st, 'Layout', arr(1), 1); P.upsert(st, 'Layout 2', arr(1), 1);
  assert.strictEqual(P.suggestName(st, 'Layout'), 'Layout 3');
  assert.strictEqual(P.suggestName(st, 'layout'), 'layout 3');   // keeps the spelling it was given
  var a = P.validArr({ panels: [
    { widget: 'A', id: 'a', state: 'open' }, { widget: 'B', id: 'b', state: 'float', slot: 0 },
    { widget: 'B', id: 'b2', state: 'float', slot: 1 }, { widget: 'C', id: 'c', state: 'min' }] });
  assert.strictEqual(P.summary(a), '4 panels · 2 floating · 1 minimized');
  assert.strictEqual(P.summary(P.validArr({ panels: [{ widget: 'A', id: 'a', state: 'open' }] })), '1 panel');
  assert.deepStrictEqual(P.widgetNames(a), ['A', 'B', 'C']);
});
console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
