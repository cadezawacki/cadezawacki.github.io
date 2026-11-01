/* Headless checks for the Cave Flyer engine (cave, physics, near misses, items, economy).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/caveflyer/caveflyer.test.js */
'use strict';
var assert = require('assert');

var E = require('./caveflyer.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./caveflyer.js')];
require('./caveflyer.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function fly(f, hold, steps) {
  for (var i = 0; i < steps && f.phase !== 'done'; i++) { E.stepRun(f, typeof hold === 'function' ? hold(f) : hold); f.events.length = 0; f.hits.length = 0; }
  return f;
}

test('registers as a widget with its css and the manifest name', function () {
  assert.ok(widget && widget.name === 'Cave Flyer' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'caveflyer.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('cave walls are continuous, ordered and never pinch shut', function () {
  E.MODE_IDS.forEach(function (m) {
    var c = E.newCave(99, m);
    E.ensure(c, 30000);
    var pc = E.ceilAt(c, -100), pf = E.floorAt(c, -100), minGap = 1e9;
    for (var x = -99.9; x < 30000; x += 0.5) {
      var ce = E.ceilAt(c, x), fl = E.floorAt(c, x);
      assert.ok(Math.abs(ce - pc) < 3 && Math.abs(fl - pf) < 3, m + ': wall jumps at ' + x);
      minGap = Math.min(minGap, ce - fl);
      pc = ce; pf = fl;
    }
    assert.ok(minGap > 4 * E.R + 20, m + ': the cave pinched to ' + minGap.toFixed(1));
  });
});

test('the cave narrows and wiggles more with distance', function () {
  var c = E.newCave(7, 'normal');
  E.ensure(c, 14000);
  function stats(x0, x1) {
    var g = 0, n = 0, wig = 0, py = E.midAt(c, x0);
    for (var x = x0; x < x1; x += 4) { g += E.ceilAt(c, x) - E.floorAt(c, x); n++; var y = E.midAt(c, x); wig += Math.abs(y - py); py = y; }
    return { gap: g / n, wig: wig / (x1 - x0) };
  }
  var a = stats(0, 2000), b = stats(11000, 13000);
  assert.ok(b.gap < a.gap * 0.7, 'gap ' + a.gap.toFixed(0) + ' -> ' + b.gap.toFixed(0));
  assert.ok(b.wig > a.wig * 2, 'wiggle ' + a.wig.toFixed(3) + ' -> ' + b.wig.toFixed(3));
  assert.ok(E.speedAt(E.MODES.normal, 12000) > E.speedAt(E.MODES.normal, 0) * 1.5);
});

test('blocks leave a flyable pass and stay clear of the start', function () {
  E.MODE_IDS.forEach(function (m) {
    var c = E.newCave(1234, m);
    E.ensure(c, 20000);
    assert.ok(c.blocks.length > 20, m + ': only ' + c.blocks.length + ' blocks');
    var kinds = {};
    c.blocks.forEach(function (b, i) {
      kinds[b.t] = 1;
      assert.ok(b.x0 > E.START_CLEAR, 'a block at the start');
      if (i) assert.ok(b.x0 >= c.blocks[i - 1].x1, 'blocks out of order / overlapping');
      var sp = E.spanMin(c, b.x0, b.x1), room;
      if (b.t === 'top') room = b.y0 - sp.floor;
      else if (b.t === 'bot') room = sp.ceil - b.y1;
      else room = Math.max(b.y0 - sp.floor, sp.ceil - b.y1);
      assert.ok(room >= 4 * E.R + 20, m + ': pass of ' + room.toFixed(1) + ' at ' + b.x0.toFixed(0));
    });
    assert.ok(kinds.top && kinds.bot && (m === 'calm' || kinds.slab), m + ': kinds ' + Object.keys(kinds));
  });
});

test('pickups sit in open air, never inside rock or a block', function () {
  var c = E.newCave(55, 'wild'), k = {};
  E.ensure(c, 20000);
  c.items.forEach(function (it) {
    k[it.k] = (k[it.k] || 0) + 1;
    assert.ok(it.y < E.ceilAt(c, it.x) - 6 && it.y > E.floorAt(c, it.x) + 6, it.k + ' in the rock at ' + it.x.toFixed(0));
    assert.ok(E.clearAt(c, it.x, it.y) > 0, it.k + ' inside a block at ' + it.x.toFixed(0));
  });
  assert.ok(k.coin > 100 && k.fuel > 8 && k.shield >= 1, JSON.stringify(k));
});

test('generation is deterministic and independent of how far ahead it was asked for', function () {
  var a = E.newCave(4321, 'normal'), b = E.newCave(4321, 'normal');
  E.ensure(a, 9000);
  for (var x = 0; x < 9000; x += 500) E.ensure(b, x);
  E.ensure(b, 9000);
  for (x = 0; x < 9000; x += 3.7) assert.strictEqual(E.ceilAt(a, x), E.ceilAt(b, x));
  assert.deepStrictEqual(a.blocks.slice(0, 20), b.blocks.slice(0, 20));
  var c = E.newCave(4322, 'normal');
  E.ensure(c, 9000);
  assert.notStrictEqual(E.ceilAt(a, 5000), E.ceilAt(c, 5000));
});

test('ready: nothing moves until the first hold', function () {
  var f = E.newRun(3, 'normal');
  fly(f, false, 600);
  assert.strictEqual(f.phase, 'ready');
  assert.strictEqual(f.x, 0); assert.strictEqual(f.t, 0);
  E.stepRun(f, true);
  assert.strictEqual(f.phase, 'run');
  assert.ok(f.x > 0);
});

test('momentum: thrust changes the climb rate smoothly, never in one step', function () {
  var f = E.newRun(3, 'calm'), maxDv = 0, pv = 0;
  E.stepRun(f, true);
  pv = f.vy;
  for (var i = 0; i < 240 && f.phase === 'run'; i++) {
    E.stepRun(f, (i % 50) < 22);
    maxDv = Math.max(maxDv, Math.abs(f.vy - pv));
    pv = f.vy; f.events.length = 0;
  }
  assert.ok(maxDv <= (E.THRUST + E.G + E.DRAG * E.VY_MAX) * E.STEP + 1e-9, 'vy jumped by ' + maxDv);
  // holding climbs, letting go falls
  var up = E.newRun(3, 'calm'); fly(up, true, 30); assert.ok(up.vy > 50 && up.y > 0);
  var dn = E.newRun(3, 'calm'); E.stepRun(dn, true); fly(dn, false, 30); assert.ok(dn.vy < -50 && dn.y < 0);
  // terminal speeds are bounded
  var t = E.newRun(3, 'calm'); E.stepRun(t, true); fly(t, true, 2000);
  assert.ok(t.phase !== 'run' || Math.abs(t.vy) <= E.VY_MAX);
});

test('the fixed step makes a flight frame-rate independent (60 vs 120 vs 144 Hz)', function () {
  function go(hz) {
    var f = E.newRun(77, 'normal'), T = 0, dt = 1 / hz;
    while (T < 6 && f.phase !== 'done') {
      var hold = f.phase === 'ready' || f.t % 0.6 < 0.27;
      E.advance(f, dt, hold); T += dt; f.events.length = 0; f.hits.length = 0;
    }
    return f;
  }
  var a = go(60), b = go(120), c = go(144);
  // inputs are sampled per frame, so only nearly equal — but never wildly different
  assert.ok(Math.abs(a.x - b.x) < 30 && Math.abs(b.x - c.x) < 30, a.x + ' ' + b.x + ' ' + c.x);
  // identical inputs per step give identical runs
  var p = E.newRun(5, 'wild'), q = E.newRun(5, 'wild');
  for (var i = 0; i < 2000; i++) { var h = i % 70 < 30 || i === 0; E.stepRun(p, h); E.stepRun(q, h); }
  assert.strictEqual(p.x, q.x); assert.strictEqual(p.y, q.y); assert.strictEqual(p.score, q.score);
});

test('advance returns a valid interpolation alpha and caps a long stall', function () {
  var f = E.newRun(2, 'normal');
  E.stepRun(f, true);
  var a = E.advance(f, 0.0123, true);
  assert.ok(a >= 0 && a < 1);
  var s0 = f.steps;
  E.advance(f, 5, true);
  assert.ok(f.steps - s0 <= Math.ceil(0.25 / E.STEP) + 1, 'a stall ran ' + (f.steps - s0) + ' steps');
});

test('doing nothing crashes into the floor; holding forever hits the ceiling', function () {
  var f = E.simulate(9, null, 30, 'normal');
  assert.ok(f.phase === 'done' && f.cause === 'rock' && f.y < 0);
  var g = E.simulate(9, function () { return true; }, 30, 'normal');
  assert.ok(g.phase === 'done' && g.cause === 'rock' && g.y > 0);
});

test('the autopilot proves the cave is flyable (every mode, several seeds)', function () {
  E.MODE_IDS.forEach(function (m) {
    for (var s = 1; s <= 3; s++) {
      var f = E.simulate(s * 7919 + m.length, E.autopilot, 70, m);
      assert.ok(f.phase === 'run', m + ' seed ' + s + ' crashed (' + f.cause + ') at ' + f.dist.toFixed(0) + ' m');
      assert.ok(f.fuel > 0 && f.fuelGot > 0 && f.coins > 0);
      assert.ok(f.score >= Math.floor(f.dist), 'score below distance');
    }
  });
});

test('near misses score, chain into a combo, and the combo times out', function () {
  var f = E.newRun(1, 'normal');
  E.stepRun(f, true);
  f.events.length = 0;
  // fake a skim: clearance under NEAR for a while, then away
  var floor = E.floorAt(f.c, f.x);
  f.y = floor + E.R + 4; f.vy = 0;
  var got = 0;
  for (var i = 0; i < 400 && got < 2; i++) {
    var fl = E.floorAt(f.c, f.x);
    if (i < 20) { f.y = fl + E.R + 4; f.vy = 0; }
    else if (i < 60) { f.y = E.midAt(f.c, f.x); f.vy = 0; }
    else if (i < 80) { f.y = fl + E.R + 4; f.vy = 0; }
    else { f.y = E.midAt(f.c, f.x); f.vy = 0; }
    E.stepRun(f, false);
    f.events.forEach(function (e) { if (e === 'near') got++; });
    f.events.length = 0;
  }
  assert.strictEqual(f.phase, 'run');
  assert.strictEqual(got, 2);
  assert.strictEqual(f.combo, 2);
  assert.ok(f.bonus > 0 && f.near === 2);
  for (i = 0; i < 4 / E.STEP; i++) { f.y = E.midAt(f.c, f.x); f.vy = 0; E.stepRun(f, false); f.events.length = 0; }
  assert.strictEqual(f.combo, 0, 'combo should time out');
  assert.strictEqual(f.bestCombo, 2);
});

test('pickups: coins, fuel and a shield that absorbs one crash', function () {
  var f = E.newRun(11, 'normal');
  E.stepRun(f, true);
  var c = f.c;
  c.items.splice(0, c.items.length,
    { k: 'coin', x: f.x + 3, y: f.y, hit: false }, { k: 'fuel', x: f.x + 4, y: f.y, hit: false }, { k: 'shield', x: f.x + 5, y: f.y, hit: false });
  f.ii = 0; f.fuel = 30;
  E.stepRun(f, false);
  assert.strictEqual(f.coins, 1);
  assert.strictEqual(f.fuel > 30 + E.FUEL_CAN - 1, true);
  assert.strictEqual(f.shield, 1);
  // ram the floor: the shield breaks, the run goes on
  f.events.length = 0;
  f.y = E.floorAt(c, f.x) + 1;
  E.stepRun(f, false);
  assert.strictEqual(f.phase, 'run');
  assert.ok(f.events.indexOf('shieldhit') >= 0 && f.shield === 0 && f.inv > 0);
  assert.ok(E.clearAt(c, f.x, f.y) > -E.R, 'bounced back towards the open');
});

test('fuel drains (faster under thrust); an empty tank sputters', function () {
  var a = E.newRun(4, 'calm'), b = E.newRun(4, 'calm');
  E.stepRun(a, true); E.stepRun(b, true);
  for (var i = 0; i < 120; i++) {
    a.y = E.midAt(a.c, a.x); a.vy = 0; b.y = E.midAt(b.c, b.x); b.vy = 0;
    E.stepRun(a, false); E.stepRun(b, true);
  }
  assert.ok(b.fuel < a.fuel && a.fuel < E.FUEL_MAX);
  var f = E.newRun(4, 'calm'); E.stepRun(f, true); f.fuel = 0.001; f.y = E.midAt(f.c, f.x); f.vy = 0;
  f.events.length = 0;
  for (i = 0; i < 60; i++) { E.stepRun(f, true); }
  assert.ok(f.events.indexOf('empty') >= 0);
  assert.ok(f.vy < 0, 'a sputtering thruster cannot hold altitude');
});

test('zones: every 250 m, with a bonus', function () {
  var f = E.newRun(8, 'calm');
  E.stepRun(f, true);
  var z = 0;
  for (var i = 0; i < 60 / E.STEP && f.phase === 'run'; i++) {
    E.stepRun(f, E.autopilot(f));
    if (f.events.indexOf('zone') >= 0) z++;
    f.events.length = 0; f.hits.length = 0;
  }
  assert.strictEqual(f.zone, Math.floor(f.x / E.ZONE_W));
  assert.ok(z >= 1 && z === f.zone);
  assert.strictEqual(E.zoneAt(2499), 0); assert.strictEqual(E.zoneAt(2500), 1);
});

test('a crash ends the run after a short wreck, with a summary', function () {
  var f = E.simulate(3, null, 20, 'wild');
  assert.strictEqual(f.phase, 'done');
  var s = E.summary(f);
  assert.strictEqual(s.mode, 'wild');
  assert.strictEqual(s.cause, 'rock');
  assert.ok(s.dist > 0 && s.zone === 1 && s.time > E.DEATH_T);
  E.stepRun(f, true);
  assert.strictEqual(f.phase, 'done', 'a done run stays done');
});

test('save normalisation survives garbage', function () {
  [null, 1, 'x', [], { wallet: -5, rec: 'nope', own: { body: 'dart' } }, { wallet: 'NaN', seed: -1, mode: 'zzz', rec: { calm: { score: 'a' } }, best: { combo: -2 } }]
    .forEach(function (o) {
      var s = E.normSave(o);
      assert.ok(s.wallet >= 0 && s.seed > 0 && E.MODES[s.mode]);
      E.MODE_IDS.forEach(function (m) { assert.ok(s.rec[m].score >= 0 && s.rec[m].dist >= 0); });
      assert.ok(s.own.body.indexOf('dart') >= 0 && s.sel.body === 'dart');
      assert.ok(s.best.combo >= 0);
    });
  var good = E.newSave();
  good.wallet = 500; good.mode = 'wild'; good.own.body.push('jet', 'bogus'); good.sel.body = 'jet'; good.sel.color = 'rainbow';
  var n = E.normSave(JSON.parse(JSON.stringify(good)));
  assert.strictEqual(n.wallet, 500); assert.strictEqual(n.mode, 'wild');
  assert.deepStrictEqual(n.own.body, ['dart', 'jet']);
  assert.strictEqual(n.sel.body, 'jet');
  assert.strictEqual(n.sel.color, 'accent', 'cannot wear an unowned colour');
});

test('the hangar: buy, wear, can\'t afford, can\'t buy locked items', function () {
  var s = E.newSave();
  assert.ok(!E.buy(s, 'body', 'jet'));
  s.wallet = 100;
  assert.ok(E.buy(s, 'body', 'jet'));
  assert.strictEqual(s.wallet, 40); assert.strictEqual(s.sel.body, 'jet');
  assert.ok(!E.buy(s, 'body', 'jet'), 'bought twice');
  assert.ok(E.wear(s, 'body', 'dart')); assert.strictEqual(s.sel.body, 'dart');
  s.wallet = 99999;
  assert.ok(!E.buy(s, 'body', 'ghost'), 'bought a locked craft');
  assert.ok(!E.wear(s, 'trail', 'sparkle'));
  E.BODIES.concat(E.COLORS, E.TRAILS).forEach(function (it) {
    assert.ok(it.need || it.price >= 0);
    if (it.s) for (var i = 0; i < it.s.length; i++) assert.ok(it.s.charCodeAt(i) < 128, 'glyph outside the atlas: ' + it.s);
  });
});

test('settle: wallet, per-mode records, achievements unlock craft', function () {
  var s = E.newSave();
  var c = E.settle(s, { mode: 'wild', score: 900, dist: 1600, coins: 40, near: 12, combo: 6, zone: 7, fuel: 3, time: 90 });
  assert.strictEqual(c.pay, 60, 'wild pays x1.5');
  assert.strictEqual(s.wallet, 60); assert.strictEqual(s.runs, 1);
  assert.strictEqual(s.rec.wild.score, 900); assert.strictEqual(s.rec.normal.score, 0);
  assert.ok(c.best.score);
  var names = c.unlocked.map(function (it) { return it.id; }).sort();
  assert.deepStrictEqual(names, ['ace', 'ghost']);
  assert.ok(E.owns(s, 'body', 'ace') && E.owns(s, 'body', 'ghost'));
  var c2 = E.settle(s, { mode: 'wild', score: 100, dist: 10, coins: 1, near: 0, combo: 0, zone: 1, fuel: 0, time: 5 });
  assert.ok(!c2.best.score && c2.unlocked.length === 0);
  assert.strictEqual(s.rec.wild.score, 900);
  assert.notStrictEqual(E.runSeed(s), E.runSeed(E.newSave()));
});

test('a shielded hit on a stalactite knocks the craft down and out, not up into it', function () {
  ['top', 'bot', 'slab'].forEach(function (t) {
    var f = E.newRun(21, 'normal');
    E.stepRun(f, true);
    var c = f.c, x = f.x + 6, ce = E.ceilAt(c, x), fl = E.floorAt(c, x), mid = (ce + fl) / 2;
    // a block whose open side is away from the middle: the old "towards the middle" bounce pushed into it
    var b = t === 'top' ? { x0: x, x1: x + 24, y0: fl + 20, y1: ce + 400, t: 'top' } :
      t === 'bot' ? { x0: x, x1: x + 24, y0: fl - 400, y1: ce - 20, t: 'bot' } :
      { x0: x, x1: x + 24, y0: mid - 6, y1: mid + 6, t: 'slab' };
    b.near = 1e9;
    c.blocks.splice(0, c.blocks.length, b); c.items.length = 0; f.bi = 0;
    f.shield = 1;
    f.y = t === 'top' ? mid - 10 : t === 'bot' ? mid + 10 : mid + 3; f.vy = 0;
    var dir = 0;
    for (var i = 0; i < 1.5 / E.STEP && f.phase === 'run'; i++) {
      E.stepRun(f, t === 'bot' ? f.vy < 120 : f.vy < -60 ? true : false);
      if (f.events.indexOf('shieldhit') >= 0 && !dir) dir = f.vy;
      f.events.length = 0;
      if (f.x > b.x1 + 20) break;
    }
    assert.ok(dir !== 0, t + ': the shield should break on the block');
    if (t === 'top') assert.ok(dir < 0, 'knocked down off a stalactite');
    if (t === 'bot') assert.ok(dir > 0, 'knocked up off a stalagmite');
    if (t === 'slab') assert.ok(dir > 0, 'knocked off the slab face it is nearer');
    assert.strictEqual(f.phase, 'run', t + ': the shield should carry the craft past the block');
  });
});

test('quitting keeps "quit" as the cause even after a shield took a hit', function () {
  var f = E.newRun(3, 'normal');
  E.stepRun(f, true);
  f.cause = 'rock'; f.fuel = 0; f.phase = 'done';
  f.cause = 'quit';
  assert.strictEqual(E.summary(f).cause, 'quit');
  f.cause = 'rock';
  assert.strictEqual(E.summary(f).cause, 'fuel');
});

test('a quick tap between frames still gets thrust (advance with a 1-frame hold)', function () {
  var a = E.newRun(9, 'normal'); E.stepRun(a, true);
  a.y = E.midAt(a.c, a.x); a.vy = 0;
  E.advance(a, 1 / 60, true);
  assert.ok(a.vy > -E.G / 60, 'thrust applied during the frame');
  var n0 = a.steps; E.advance(a, 0.5, false);
  assert.ok(a.steps - n0 <= Math.ceil(0.25 / E.STEP) + 1, 'a long stall is capped');
});

console.log(passed + ' passed');
if (process.exitCode) console.log('some checks failed');
