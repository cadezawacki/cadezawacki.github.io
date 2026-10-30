/* Headless checks for the Dusk Dash engine (terrain, physics, items, economy).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/duskdash/duskdash.test.js */
'use strict';
var assert = require('assert');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./duskdash.js');
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./duskdash.js')];
require('./duskdash.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// A fair pilot: heavy on the ground's downslopes and while falling onto one.
function pilot(f) {
  var w = f.w; E.groundY(w, f.x);
  if (f.gnd) return w.gs < -0.02;
  return f.vy < 0 && w.gs < -0.02;
}
function run(seed, p, steps) {
  var f = E.newRun(seed), ev = {};
  for (var i = 0; i < (steps || 1e6) && f.phase !== 'done'; i++) {
    E.stepRun(f, p ? p(f) : false);
    f.events.forEach(function (e) { ev[e] = (ev[e] || 0) + 1; });
    f.events.length = 0; f.hits.length = 0;
  }
  f.ev = ev;
  return f;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Dusk Dash' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'duskdash.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('terrain is continuous with a continuous slope', function () {
  var w = E.newWorld(42);
  E.ensure(w, 5000);
  var prevY = E.groundY(w, -50), prevS = w.gs;
  for (var x = -49.95; x < 5000; x += 0.05) {
    var y = E.groundY(w, x), s = w.gs;
    assert.ok(Math.abs(y - prevY) < 0.2, 'jump in height at ' + x);
    assert.ok(Math.abs(s - prevS) < 0.05, 'kink in slope at ' + x);
    assert.ok(Math.abs(s) < 1.6, 'cliff at ' + x);
    prevY = y; prevS = s;
  }
  // the analytic slope matches the numeric one
  for (x = 10; x < 3000; x += 37.3) {
    var a = E.groundY(w, x - 0.001), b = E.groundY(w, x + 0.001), sl = (E.groundY(w, x), w.gs);
    assert.ok(Math.abs((b - a) / 0.002 - sl) < 1e-3, 'slope at ' + x);
  }
});

test('the world is the same for a seed and different across seeds', function () {
  var a = E.newWorld(7), b = E.newWorld(7), c = E.newWorld(8);
  assert.deepStrictEqual(a.xs, b.xs);
  assert.deepStrictEqual(a.items.map(function (i) { return [i.k, i.x]; }), b.items.map(function (i) { return [i.k, i.x]; }));
  assert.notDeepStrictEqual(a.xs, c.xs);
});

test('islands tile the world, and hills grow', function () {
  var w = E.newWorld(3);
  E.ensure(w, 8000);
  for (var i = 1; i < w.isl.length; i++) assert.strictEqual(w.isl[i].x0, w.isl[i - 1].x1);
  function maxH(L) { var m = 0; for (var j = 0; j < w.xs.length; j++) if (w.xs[j] >= L.x0 && w.xs[j] <= L.x1) m = Math.max(m, w.ys[j]); return m; }
  assert.ok(maxH(w.isl[6]) > maxH(w.isl[0]));
  assert.strictEqual(E.islandAt(w, w.isl[2].x0 + 1), 2);
});

test('a run is deterministic and always moves forward', function () {
  var a = run(99, pilot, 6000), b = run(99, pilot, 6000);
  assert.strictEqual(a.x, b.x); assert.strictEqual(a.score, b.score);
  var f = E.newRun(5), lx = f.x;
  for (var i = 0; i < 6000; i++) {
    E.stepRun(f, i % 400 < 200);
    assert.ok(f.x >= lx, 'went backwards');
    assert.ok(isFinite(f.x) && isFinite(f.y) && isFinite(f.zoom), 'NaN');
    assert.ok(f.y >= E.groundY(f.w, f.x) - 1e-6, 'under the ground');
    lx = f.x;
  }
});

test('the dot never crawls to a halt in daylight', function () {
  var f = E.newRun(11);
  for (var i = 0; i < 40 / E.STEP; i++) { E.stepRun(f, true); if (f.phase === 'run' && f.t > 1) assert.ok(E.speedOf(f) >= 5.9, 'stalled at ' + f.x); }
});

test('crests throw a fast dot into the air; holding keeps it down', function () {
  var w = E.newWorld(1), f = E.newRun(1);
  f.s = 60; E.stepRun(f, false);
  var air = false;
  for (var i = 0; i < 600 && !air; i++) { E.stepRun(f, false); air = !f.gnd; }
  assert.ok(air, 'never launched');
  var g = E.newRun(1), launched = false;
  for (i = 0; i < 400; i++) { E.stepRun(g, true); if (!g.gnd) launched = true; }
  assert.ok(!launched, 'a slow held dot left the ground');
  void w;
});

test('landing along a downslope is perfect; into an upslope is a thud', function () {
  var f = E.newRun(1), w = f.w, x = 0, i;
  for (i = 2; i < w.xs.length - 1; i++) if (w.ys[i] > w.ys[i + 1] + 8) { x = (w.xs[i] + w.xs[i + 1]) / 2; break; }
  var y = E.groundY(w, x), a = Math.atan(w.gs);
  f.gnd = false; f.air = 1; f.x = x; f.y = y - 0.01; f.vx = 30 * Math.cos(a); f.vy = 30 * Math.sin(a);
  E.land(f);
  assert.ok(f.events.indexOf('perfect') >= 0 && f.s > 30 && f.chain === 1);
  var g = E.newRun(1);
  for (i = 2; i < w.xs.length - 1; i++) if (w.ys[i + 1] > w.ys[i] + 8) { x = (w.xs[i] + w.xs[i + 1]) / 2; break; }
  y = E.groundY(g.w, x);
  g.gnd = false; g.air = 1; g.chain = 2; g.x = x; g.y = y - 0.01; g.vx = 20; g.vy = -25;
  E.land(g);
  assert.ok(g.events.indexOf('thud') >= 0 && g.chain === 0 && g.s < 20);
});

test('three perfects in a row bring on the fever', function () {
  var f = E.newRun(1);
  f.chain = 2; f.air = 1; f.gnd = false;
  var w = f.w, x;
  for (var i = 2; i < w.xs.length; i++) if (w.ys[i] > w.ys[i + 1] + 8) { x = (w.xs[i] + w.xs[i + 1]) / 2; break; }
  E.groundY(w, x); var a = Math.atan(w.gs);
  f.x = x; f.y = E.groundY(w, x); f.vx = 25 * Math.cos(a); f.vy = 25 * Math.sin(a);
  E.land(f);
  assert.ok(f.fever > 0 && f.events.indexOf('fever') >= 0 && E.mult(f) === 2);
});

test('power-ups: picked up, timed, and they do their thing', function () {
  var f = E.newRun(1);
  f.w.items.push({ k: 'pw', p: 'rocket', x: f.x + 0.5, y: f.y, hit: false });
  f.w.items.sort(function (a, b) { return a.x - b.x; });
  E.touchItems(f);
  assert.ok(f.pw.rocket > 3 && f.pwGot === 1);
  var g = E.newRun(1), s0;
  for (var i = 0; i < 120; i++) { if (i === 60) { s0 = g.x; } E.stepRun(g, false); }
  var plain = g.x - s0;
  var h = E.newRun(1);
  for (i = 0; i < 120; i++) { if (i === 60) { s0 = h.x; h.pw.rocket = 3; } E.stepRun(h, false); }
  assert.ok(h.x - s0 > plain, 'the rocket did not push');
  var k = E.newRun(1), sun = k.sun;
  k.w.items.push({ k: 'pw', p: 'sun', x: k.x, y: k.y, hit: false }); k.w.items.sort(function (a, b) { return a.x - b.x; });
  E.touchItems(k);
  assert.ok(Math.abs(k.sun - (sun + E.SUNBEAM)) < 1e-9);
  var m = E.newRun(1);
  m.pw.magnet = 5;
  m.w.items.push({ k: 'coin', x: m.x + 12, y: m.y + 3, hit: false }); m.w.items.sort(function (a, b) { return a.x - b.x; });
  for (i = 0; i < 120 && !m.coins; i++) E.stepRun(m, false);
  assert.ok(m.coins >= 1, 'the magnet did not pull the coin in');
  var d = E.newRun(1);
  d.pw.x2 = 5; d.w.items.push({ k: 'coin', x: d.x, y: d.y, hit: false }); d.w.items.sort(function (a, b) { return a.x - b.x; });
  E.touchItems(d);
  assert.strictEqual(d.coins, 2);
});

test('the sun sets, the dot coasts, the run ends; islands buy time', function () {
  var f = run(7, pilot);
  assert.strictEqual(f.phase, 'done');
  assert.ok(f.ev.night === 1 && f.ev.done === 1);
  assert.ok(f.islands >= 1 && f.t > E.SUN0, 'islands should have bought daylight');
  var idle = run(7, null), skilled = run(7, pilot);
  assert.ok(idle.t < 200 && skilled.t < 300);
});

test('a decent pilot beats doing nothing', function () {
  var a = 0, b = 0;
  for (var s = 1; s <= 4; s++) { a += run(s * 31, null).x; b += run(s * 31, pilot).x; }
  assert.ok(b > a, 'pilot ' + b + ' vs idle ' + a);
});

test('advance runs fixed steps whatever the frame rate', function () {
  var a = E.newRun(3), b = E.newRun(3), i;
  for (i = 0; i < 120; i++) E.advance(a, 1 / 60, false);
  for (i = 0; i < 240; i++) E.advance(b, 1 / 120, false);
  assert.ok(Math.abs(a.steps - b.steps) <= 1);
  var c = E.newRun(3), al = E.advance(c, 0.013, false);
  assert.ok(al >= 0 && al < 1);
});

test('save: wardrobe purchases, wearing, unlocks, records', function () {
  var s = E.newSave();
  assert.ok(E.owns(s, 'body', 'dot') && !E.canBuy(s, 'body', 'star'));
  s.wallet = 100;
  assert.ok(E.buy(s, 'body', 'star') && s.wallet === 40 && s.sel.body === 'star');
  assert.ok(!E.buy(s, 'body', 'star'));
  assert.ok(E.wear(s, 'body', 'dot') && s.sel.body === 'dot');
  assert.ok(!E.wear(s, 'trail', 'sparkle'));
  assert.ok(!E.canBuy(s, 'body', 'mystery'), 'achievement looks are not for sale');
  var card = E.settle(s, { score: 500, dist: 900, coins: 30, islands: 4, chain: 8, air: 2 });
  assert.ok(card.best.score && s.wallet === 70 && s.rec.island === 5);
  assert.ok(E.owns(s, 'body', 'mystery') && E.owns(s, 'body', 'eight') && card.unlocked.length === 2);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ wallet: -5, own: { body: ['nope', 'star'] }, sel: { body: 'nope', trail: 'sparkle' } });
  assert.ok(bad.wallet === 0 && E.owns(bad, 'body', 'star') && bad.sel.body === 'dot' && bad.sel.trail === 'dots');
  assert.ok(E.normSave(null).wallet === 0);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
