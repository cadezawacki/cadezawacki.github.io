/* Headless checks for the Falling Sand engine (movement, reactions, sleeping
 * chunks, painting, presets, save compression and normalisation).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/fallingsand/fallingsand.test.js */
'use strict';
var assert = require('assert');

var E = require('./fallingsand.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, asset: function (p) { return p; } } };
delete require.cache[require.resolve('./fallingsand.js')];
require('./fallingsand.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function run(G, n) { for (var k = 0; k < n; k++) E.step(G); return G; }
function count(G, e) { return E.counts(G)[e]; }
function at(G, x, y) { return G.t[y * G.w + x]; }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Falling Sand' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'fallingsand.css');
  assert.strictEqual(widget._engine.SAND, E.SAND);
});
test('element table is consistent', function () {
  assert.strictEqual(E.ELS.length, E.NEL);
  E.ELS.forEach(function (el, i) { assert.strictEqual(el.id, i); assert.strictEqual(el.gl.length, 4); assert.ok(el.name); });
  E.TOOLS.forEach(function (k) { assert.ok(E.BYKEY[k] != null, k); });
  ['sand', 'water', 'stone', 'wood', 'fire', 'smoke', 'steam', 'oil', 'plant', 'lava', 'ice', 'acid', 'powder', 'salt', 'wall', 'erase', 'source', 'drain']
    .forEach(function (k) { assert.ok(E.TOOLS.indexOf(k) >= 0, 'tool ' + k); });
});
test('sand falls and piles; mass is conserved', function () {
  var G = E.newGrid(20, 20, 7);
  E.set(G, 10, E.SAND);
  run(G, 40);
  assert.strictEqual(at(G, 10, 19), E.SAND);
  E.paint(G, 10, 2, 3, E.SAND);
  var n = count(G, E.SAND);
  run(G, 200);
  assert.strictEqual(count(G, E.SAND), n);
  for (var x = 0; x < 20; x++) for (var y = 0; y < 19; y++) if (at(G, x, y) === E.SAND) assert.notStrictEqual(at(G, x, y + 1), E.EMPTY, 'no floating sand');
  // a pile, not a column: spreads
  var cols = 0;
  for (x = 0; x < 20; x++) if (at(G, x, 19) === E.SAND) cols++;
  assert.ok(cols > 3);
});
test('water levels out and stays put', function () {
  var G = E.newGrid(30, 12, 3);
  E.paint(G, 15, 3, 2, E.WATER);
  var n = count(G, E.WATER);
  run(G, 400);
  assert.strictEqual(count(G, E.WATER), n);
  var hi = 0;
  for (var x = 0; x < 30; x++) for (var y = 0; y < 12; y++) if (at(G, x, y) === E.WATER) hi = Math.max(hi, 12 - y);
  assert.ok(hi <= 2, 'flat: ' + hi);
});
test('density layering: oil floats, sand sinks through water', function () {
  var G = E.newGrid(8, 20, 5);
  for (var y = 10; y < 20; y++) for (var x = 0; x < 8; x++) E.set(G, y * 8 + x, E.WATER);
  for (y = 6; y < 8; y++) for (x = 0; x < 8; x++) E.set(G, y * 8 + x, E.SAND);
  run(G, 600);
  for (x = 0; x < 8; x++) assert.strictEqual(at(G, x, 19), E.SAND);
  var G2 = E.newGrid(6, 16, 9);
  for (y = 4; y < 10; y++) for (x = 0; x < 6; x++) E.set(G2, y * 6 + x, E.WATER);
  for (y = 10; y < 16; y++) for (x = 0; x < 6; x++) E.set(G2, y * 6 + x, E.OIL);
  run(G2, 1500);
  for (x = 0; x < 6; x++) { assert.strictEqual(at(G2, x, 15), E.WATER); assert.strictEqual(at(G2, x, 9), E.OIL); }
});
test('fire burns wood away and makes smoke; water puts fire out as steam', function () {
  var G = E.newGrid(20, 20, 11);
  for (var x = 4; x < 16; x++) for (var y = 15; y < 18; y++) E.set(G, y * 20 + x, E.WOOD);
  E.set(G, 15 * 20 + 4, E.FIRE, 128 | 100);
  var sawSmoke = false;
  for (var k = 0; k < 3000 && count(G, E.WOOD); k++) { E.step(G); if (count(G, E.SMOKE)) sawSmoke = true; }
  assert.strictEqual(count(G, E.WOOD), 0, 'wood burnt');
  assert.ok(sawSmoke);
  var G2 = E.newGrid(10, 10, 2);
  for (x = 0; x < 10; x++) for (var y = 6; y < 10; y++) E.set(G2, y * 10 + x, E.WATER);
  E.set(G2, 5 * 10 + 5, E.FIRE, 60); E.set(G2, 5 * 10 + 4, E.WALL); E.set(G2, 5 * 10 + 6, E.WALL); E.set(G2, 4 * 10 + 5, E.WALL);
  var steam = false;
  for (k = 0; k < 60; k++) { E.step(G2); if (count(G2, E.STEAM)) steam = true; }
  assert.ok(steam && G2.sizzles > 0);
});
test('lava + water → stone and steam; lava glazes sand to glass', function () {
  var G = E.newGrid(10, 10, 4);
  E.set(G, 9 * 10 + 4, E.WATER); E.set(G, 9 * 10 + 5, E.LAVA);
  run(G, 200);
  assert.strictEqual(count(G, E.LAVA), 0);
  assert.ok(count(G, E.STONE) >= 1);
  var G2 = E.newGrid(12, 8, 8);
  for (var x = 0; x < 12; x++) { E.set(G2, 7 * 12 + x, E.SAND); E.set(G2, 6 * 12 + x, E.LAVA); }
  run(G2, 3000);
  assert.ok(count(G2, E.GLASS) > 0);
});
test('gunpowder chain-explodes from one spark', function () {
  var G = E.newGrid(40, 20, 6);
  for (var y = 14; y < 20; y++) for (var x = 5; x < 35; x++) E.set(G, y * 40 + x, E.POWDER);
  for (x = 0; x < 40; x++) E.set(G, 0 * 40 + x, E.WALL);
  for (x = 5; x < 9; x++) E.set(G, 13 * 40 + x, E.FIRE, 40);
  run(G, 400);
  assert.ok(G.booms > 20, 'booms ' + G.booms);
  assert.ok(count(G, E.POWDER) < 30, 'left ' + count(G, E.POWDER));
  for (x = 0; x < 40; x++) assert.strictEqual(at(G, x, 0), E.WALL, 'walls survive');
});
test('plants drink water and grow; salt dissolves into brine; acid eats stone not glass', function () {
  var G = E.newGrid(20, 20, 13);
  E.set(G, 19 * 20 + 10, E.PLANT);
  for (var y = 14; y < 20; y++) for (var x = 0; x < 20; x++) if (!G.t[y * 20 + x]) E.set(G, y * 20 + x, E.WATER);
  var p0 = count(G, E.PLANT), w0 = count(G, E.WATER);
  run(G, 1500);
  assert.ok(count(G, E.PLANT) > p0 + 10 && count(G, E.WATER) < w0);
  var G2 = E.newGrid(10, 10, 21);
  for (x = 0; x < 10; x++) { E.set(G2, 9 * 10 + x, E.WATER); E.set(G2, 8 * 10 + x, E.WATER); }
  E.set(G2, 2 * 10 + 5, E.SALT);
  run(G2, 1500);
  assert.strictEqual(count(G2, E.SALT), 0); assert.strictEqual(count(G2, E.BRINE), 1);
  var G3 = E.newGrid(10, 10, 5);
  for (x = 0; x < 10; x++) { E.set(G3, 9 * 10 + x, E.GLASS); E.set(G3, 8 * 10 + x, E.STONE); }
  for (x = 2; x < 8; x++) E.set(G3, 7 * 10 + x, E.ACID);
  run(G3, 2000);
  assert.ok(count(G3, E.STONE) < 10, 'stone eaten');
  assert.strictEqual(count(G3, E.GLASS), 10, 'glass intact');
});
test('steam rises and rains back; ice melts; smoke fades', function () {
  var G = E.newGrid(10, 30, 3);
  E.set(G, 29 * 10 + 5, E.STEAM, 200);
  run(G, 30);
  var top = -1;
  for (var y = 0; y < 30 && top < 0; y++) for (var x = 0; x < 10; x++) if (at(G, x, y) === E.STEAM) top = y;
  assert.ok(top >= 0 && top < 20, 'steam rose');
  var G2 = E.newGrid(6, 6, 1);
  E.set(G2, 5 * 6 + 2, E.ICE); E.set(G2, 3 * 6 + 2, E.SMOKE, 30);
  run(G2, 40000);
  assert.strictEqual(count(G2, E.ICE), 0); assert.strictEqual(count(G2, E.SMOKE), 0);
});
test('sources pour, drains swallow', function () {
  var G = E.newGrid(16, 16, 2);
  E.paint(G, 8, 1, 0, E.SOURCE, E.SAND);
  assert.strictEqual(G.a[1 * 16 + 8], E.SAND);
  run(G, 300);
  assert.ok(count(G, E.SAND) > 20);
  E.paint(G, 8, 1, 0, E.SOURCE, E.WATER);
  assert.strictEqual(G.a[1 * 16 + 8], E.WATER, 'repaint changes material');
  for (var x = 0; x < 16; x++) E.set(G, 15 * 16 + x, E.DRAIN);
  var G2 = E.newGrid(10, 10, 4);
  for (x = 0; x < 10; x++) E.set(G2, 9 * 10 + x, E.DRAIN);
  E.paint(G2, 5, 3, 2, E.WATER);
  run(G2, 300);
  assert.strictEqual(count(G2, E.WATER), 0);
  assert.strictEqual(count(G2, E.DRAIN), 10);
});
test('painting: brush sizes, fills, eraser, walls resist paint', function () {
  var G = E.newGrid(30, 30, 1);
  E.paint(G, 15, 15, 0, E.STONE);
  assert.strictEqual(count(G, E.STONE), 1);
  E.paint(G, 15, 15, 3, E.WALL);
  var nw = count(G, E.WALL);
  assert.ok(nw > 20 && nw < 49);
  E.paint(G, 15, 15, 3, E.WOOD);
  assert.strictEqual(count(G, E.WOOD), 0, 'wood does not paint over walls');
  E.paint(G, 15, 15, 3, E.EMPTY);
  assert.strictEqual(count(G, E.WALL), 0);
  E.paintLine(G, 2, 2, 27, 27, 1, E.STONE);
  assert.ok(count(G, E.STONE) > 40);
  E.paint(G, 5, 25, 4, E.SAND);
  var ns = count(G, E.SAND);
  assert.ok(ns > 10 && ns < 60, 'powders paint sparse ' + ns);
  E.paint(G, -10, -10, 3, E.SAND); E.paint(G, 1000, 5, 3, E.SAND); // off-grid is safe
});
test('chunks sleep when everything has settled and wake on paint', function () {
  var G = E.newGrid(64, 64, 8);
  E.paint(G, 32, 10, 5, E.SAND);
  run(G, 400);
  assert.strictEqual(E.awakeChunks(G), 0, 'all asleep');
  E.set(G, 5 * 64 + 5, E.SAND);
  assert.ok(E.awakeChunks(G) >= 1 && E.awakeChunks(G) <= 4);
  run(G, 100);
  assert.strictEqual(E.awakeChunks(G), 0);
});
test('deterministic for a seed', function () {
  function sim(seed) {
    var G = E.newGrid(48, 40, seed);
    E.makePreset(G, 'volcano');
    run(G, 300);
    return E.encode(G);
  }
  assert.strictEqual(sim(42), sim(42));
  assert.notStrictEqual(sim(42), sim(43));
});
test('presets build on any size and run without errors', function () {
  [[20, 16], [64, 40], [46, 70], [180, 100]].forEach(function (sz) {
    E.PRESETS.forEach(function (p) {
      var G = E.newGrid(sz[0], sz[1], 3);
      assert.ok(E.makePreset(G, p.id));
      var n = E.counts(G);
      assert.ok(G.N - n[0] > 10, p.id + ' has stuff');
      run(G, 120);
      for (var i = 0; i < G.N; i++) assert.ok(G.t[i] < E.NEL);
    });
  });
  assert.ok(!E.makePreset(E.newGrid(10, 10), 'nope'));
});
test('save codes round-trip, compress, and resample', function () {
  var G = E.newGrid(90, 60, 5);
  E.makePreset(G, 'garden');
  run(G, 50);
  var s = E.encode(G), d = E.decode(s);
  assert.ok(d && d.w === 90 && d.h === 60);
  var G2 = E.loadCodes(E.newGrid(90, 60, 1), d);
  assert.deepStrictEqual(Array.from(G2.t), Array.from(G.t));
  for (var i = 0; i < G.N; i++) if (G.t[i] === E.SOURCE) assert.strictEqual(G2.a[i], G.a[i]);
  assert.ok(s.length < G.N, 'compressed: ' + s.length + ' < ' + G.N);
  var empty = E.encode(E.newGrid(200, 150));
  assert.ok(empty.length < 30, empty);
  var big = E.resize(G, 180, 120);
  assert.ok(big.w === 180 && Math.abs(E.counts(big)[E.SAND] / 4 - E.counts(G)[E.SAND]) < E.counts(G)[E.SAND] * 0.1);
  var u = new Uint8Array([0, 1, 2, 250, 255, 7, 8]);
  [1, 2, 3, 7].forEach(function (n) { assert.deepStrictEqual(Array.from(E.b64dec(E.b64enc(u, n))), Array.from(u.subarray(0, n))); });
  assert.strictEqual(E.b64enc(Buffer.from('hello'), 5), Buffer.from('hello').toString('base64'));
});
test('decode rejects malformed data', function () {
  [null, 5, '', 'fs1', 'fs1.10.10.', 'fs1.2.2.AAAA', 'fs2.10.10.AQ==', 'fs1.10.10.!!!!', 'fs1.10.10.' + E.b64enc(new Uint8Array([2, 50]), 2),
    'fs1.4.4.' + E.b64enc(new Uint8Array([99, 16]), 2), 'fs1.4.4.' + E.b64enc(new Uint8Array([2, 200]), 2), 'fs1.4.4.' + E.b64enc(new Uint8Array([64 + 1, 16]), 2)]
    .forEach(function (s) { assert.strictEqual(E.decode(s), null, String(s)); });
  assert.ok(E.decode('fs1.4.4.' + E.b64enc(new Uint8Array([64 + E.WATER, 16]), 2)));
});
test('prefs / slots / stats normalise defensively', function () {
  assert.deepStrictEqual(E.normPrefs(null), { tool: 'sand', src: 'water', brush: 2, speed: 2, grain: 1 });
  var p = E.normPrefs({ tool: 'lava', src: 'wall', brush: 99, speed: -1, grain: 2 });
  assert.ok(p.tool === 'lava' && p.src === 'water' && p.brush === 2 && p.speed === 2 && p.grain === 2);
  var G = E.newGrid(10, 10); E.makePreset(G, 'hourglass');
  var sl = E.normSlots({ slots: [{ name: 'A very long scene name that goes on', t: 5, d: E.encode(G) }, { d: 'junk' }, 7] });
  assert.strictEqual(sl.slots.length, E.SLOTS);
  assert.ok(sl.slots[0].name.length <= 24 && sl.slots[1] === null && sl.slots[2] === null);
  assert.strictEqual(E.normSlots('x').slots.length, E.SLOTS);
  assert.deepStrictEqual(E.normStats({ chain: '12', booms: -3, x: 1 }), { chain: 12, booms: 0, grown: 0, saves: 0 });
});
test('a busy 160x100 grid steps fast enough for 60 fps', function () {
  var G = E.newGrid(160, 100, 77);
  E.makePreset(G, 'volcano');
  E.paint(G, 40, 10, 8, E.WATER); E.paint(G, 120, 10, 8, E.SAND); E.paint(G, 80, 20, 6, E.OIL);
  run(G, 30);
  var t0 = Date.now(), n = 300;
  run(G, n);
  var ms = (Date.now() - t0) / n;
  assert.ok(ms < 6, 'ms/tick ' + ms.toFixed(2));
});

// ---- reviewer edge cases ----
test('plants without water never grow; drains leave solids alone', function () {
  var G = E.newGrid(16, 16, 21);
  E.set(G, 15 * 16 + 8, E.PLANT);
  run(G, 2000);
  assert.strictEqual(count(G, E.PLANT), 1);
  var G2 = E.newGrid(10, 10, 4);
  E.set(G2, 5 * 10 + 5, E.DRAIN); E.set(G2, 4 * 10 + 5, E.STONE); E.set(G2, 5 * 10 + 4, E.WOOD); E.set(G2, 5 * 10 + 6, E.GLASS);
  run(G2, 200);
  assert.ok(at(G2, 5, 4) === E.STONE && at(G2, 4, 5) === E.WOOD && at(G2, 6, 5) === E.GLASS);
});
test('explosions at the grid corners and edges stay in bounds', function () {
  var G = E.newGrid(12, 12, 8);
  [[0, 0], [11, 0], [0, 11], [11, 11], [5, 0]].forEach(function (p) { E.explode(G, p[0], p[1], 3); });
  run(G, 300);
  assert.strictEqual(G.t.length, 144);
  for (var i = 0; i < G.N; i++) assert.ok(G.t[i] < E.NEL);
});
test('lava melts ice; ice by salt melts; steam at the ceiling rains', function () {
  var G = E.newGrid(10, 10, 13);
  for (var x = 0; x < 10; x++) { E.set(G, 9 * 10 + x, E.ICE); }
  E.set(G, 8 * 10 + 5, E.LAVA);
  var melted = false;
  for (var k = 0; k < 600 && !melted; k++) { E.step(G); if (count(G, E.ICE) < 10) melted = true; }
  assert.ok(melted, 'lava melts ice');
  var G2 = E.newGrid(10, 6, 2);
  for (x = 0; x < 10; x++) E.set(G2, x, E.STEAM, 250);
  var water = false;
  for (k = 0; k < 400 && !water; k++) { E.step(G2); if (count(G2, E.WATER)) water = true; }
  assert.ok(water, 'steam condenses');
});
test('every source material pours and nothing illegal is created', function () {
  E.TOOLS.forEach(function (key) {
    var e = key === 'erase' ? 0 : E.BYKEY[key];
    var G = E.newGrid(16, 16, 31);
    E.paint(G, 8, 8, 0, E.SOURCE, e);
    var aux = G.a[8 * 16 + 8];
    assert.ok(E.canSource(aux), key + ' → source pours ' + aux);
    run(G, 300);
    for (var i = 0; i < G.N; i++) assert.ok(G.t[i] < E.NEL);
    if (E.canSource(e) && e !== E.SMOKE && e !== E.STEAM && e !== E.FIRE) assert.ok(count(G, e) > 0 || e === E.SALT || e === E.ACID, key + ' poured');
  });
});
test('encode/decode round trip is exact on a random busy grid', function () {
  var G = E.newGrid(37, 23, 99);
  for (var i = 0; i < G.N; i++) { var e = (i * 7919) % E.NEL; if (e === E.SOURCE) E.set(G, i, E.SOURCE, E.LAVA); else E.set(G, i, e); }
  var d = E.decode(E.encode(G));
  assert.ok(d && d.w === 37 && d.h === 23);
  for (i = 0; i < G.N; i++) assert.strictEqual(d.codes[i] >= 64 ? E.SOURCE : d.codes[i], G.t[i]);
  var big = 'fs1.4.4.' + E.b64enc(new Uint8Array([2, 255, 255, 255, 255, 127]), 6);
  assert.strictEqual(E.decode(big), null, 'huge run rejected');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
