/* Headless checks for the Lunar Lander engine (terrain, physics, touchdowns,
 * autopilot, matches, save). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/lander/lander.test.js */
'use strict';
var assert = require('assert');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./lander.js');
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./lander.js')];
require('./lander.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function ap(sk) { return function (f) { return E.autopilot(f, sk); }; }
// A flight placed by hand right over a pad, with velocity / angle set.
function overPad(spec, vy, vx, a, mult) {
  var f = E.newFlight(spec), p = f.T.pads[0];
  if (mult) f.T.pads.forEach(function (q) { if (q.mult === mult) p = q; });
  f.x = (p.x0 + p.x1) / 2; f.y = p.y - E.FOOT_Y + 0.05 + (a ? Math.abs(Math.sin(a)) * E.FOOT_X : 0); f.vy = vy; f.vx = vx; f.a = a;
  f.cans = [];
  return { f: f, p: p };
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Lunar Lander' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'lander.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('terrain wraps, is continuous and has flat pads', function () {
  for (var li = 0; li < E.LEVELS.length; li++) {
    var spec = E.levelSpec(li), T = E.genTerrain(spec.seed, spec);
    assert.strictEqual(T.pads.length, spec.pads.length);
    assert.ok(Math.abs(E.groundY(T, 0) - E.groundY(T, E.WORLD_W)) < 1e-9, 'wraps');
    assert.ok(Math.abs(E.groundY(T, -5) - E.groundY(T, E.WORLD_W - 5)) < 1e-9, 'wraps negative');
    var prev = E.groundY(T, 0);
    for (var x = 0.5; x < E.WORLD_W; x += 0.5) {
      var y = E.groundY(T, x);
      assert.ok(Math.abs(y - prev) < 0.5 * spec.range, 'jump at ' + x);
      assert.ok(y >= 11.9 && y <= 12.1 + spec.range, 'height in range');
      prev = y;
    }
    T.pads.forEach(function (p, i) {
      for (var px = p.x0; px <= p.x1; px += 1) assert.ok(Math.abs(E.groundY(T, px) - p.y) < 1e-9, 'pad flat');
      assert.ok(E.padAt(T, (p.x0 + p.x1) / 2) === p);
      assert.ok(E.padAt(T, (p.x0 + p.x1) / 2 + E.WORLD_W * 3) === p, 'pad lookup wraps');
      if (i) assert.ok(p.x0 > T.pads[i - 1].x1, 'pads do not overlap');
      assert.ok(p.x1 - p.x0 >= 2 * E.FOOT_X + 4, 'a pad fits the legs');
    });
    assert.ok(E.maxGround(T, 0, E.WORLD_W) >= T.top - 1e-9);
  }
});

test('terrain is the same for a seed and differs across seeds', function () {
  var s = E.levelSpec(3), a = E.genTerrain(s.seed, s), b = E.genTerrain(s.seed, s), c = E.genTerrain(s.seed + 1, s);
  assert.deepStrictEqual(Array.from(a.ys), Array.from(b.ys));
  assert.notDeepStrictEqual(Array.from(a.ys), Array.from(c.ys));
});

test('free fall follows gravity; thrust pushes along the nose', function () {
  var spec = E.levelSpec(0), f = E.newFlight(spec);
  f.cans = []; f.vx = 0;
  for (var i = 0; i < 120; i++) E.stepFlight(f, { rot: 0, thrust: 0 });
  assert.ok(Math.abs(f.vy + spec.g) < 1e-6, 'one second of free fall: vy = -g');
  var g2 = E.newFlight(spec); g2.cans = []; g2.vx = 0; g2.a = Math.PI / 2;
  for (i = 0; i < 120; i++) E.stepFlight(g2, { rot: 0, thrust: 1 });
  assert.ok(Math.abs(g2.vx - E.THRUST) < 1e-6, 'nose right → pushed right');
  assert.ok(Math.abs(g2.fuel - (spec.fuel - E.BURN)) < 1e-6, 'burns fuel at BURN/s');
  // no fuel: no thrust, no rotation
  var h = E.newFlight(spec); h.cans = []; h.vx = 0; h.fuel = 0;
  for (i = 0; i < 60; i++) E.stepFlight(h, { rot: 1, thrust: 1 });
  assert.ok(h.vy < 0 && h.a === 0);
});

test('rotation eases in and is symmetric', function () {
  var f = E.newFlight(E.levelSpec(0)), g = E.newFlight(E.levelSpec(0));
  E.stepFlight(f, { rot: 1, thrust: 0 }); E.stepFlight(g, { rot: -1, thrust: 0 });
  assert.ok(f.a > 0 && f.a < E.ROT * E.STEP, 'eases in');
  assert.ok(Math.abs(f.a + g.a) < 1e-12);
  for (var i = 0; i < 120; i++) E.stepFlight(f, { rot: 1, thrust: 0 });
  assert.ok(f.a > 2 && f.a < 2.4, 'about ROT rad in a second');
});

test('the fixed step makes 60 Hz and 144 Hz frames agree', function () {
  var spec = E.levelSpec(6), a = E.newFlight(spec), b = E.newFlight(spec), inp = { rot: 0.3, thrust: 0.6 };
  for (var i = 0; i < 300; i++) E.advance(a, 1 / 60, inp);
  for (i = 0; i < 720; i++) E.advance(b, 1 / 144, inp);
  assert.ok(Math.abs(a.t - b.t) < E.STEP * 1.01);
  var steps = Math.min(a.steps, b.steps), c = E.newFlight(spec), d = E.newFlight(spec);
  for (i = 0; i < steps; i++) { E.stepFlight(c, inp); E.stepFlight(d, inp); }
  assert.deepStrictEqual([c.x, c.y, c.vx, c.vy, c.a, c.fuel], [d.x, d.y, d.vx, d.vy, d.a, d.fuel], 'deterministic');
  var al = E.advance(a, 0.003, inp);
  assert.ok(al >= 0 && al < 1, 'interpolation alpha in [0, 1)');
});

test('wind pushes, gusts vary, a calm level is calm', function () {
  var calm = E.newFlight(E.levelSpec(0)), windy = E.newFlight(E.levelSpec(3));
  calm.cans = []; windy.cans = []; calm.vx = windy.vx = 0;
  for (var i = 0; i < 240; i++) { E.stepFlight(calm, null); E.stepFlight(windy, null); }
  assert.strictEqual(calm.vx, 0);
  assert.ok(windy.vx > 0.1, 'wind 4 → drift right');
  var gusty = E.newFlight(E.levelSpec(6)), seen = {};
  for (i = 0; i < 120 * 30; i++) { E.stepFlight(gusty, { rot: 0, thrust: 0.4 }); seen[Math.round(gusty.wind)] = 1; if (gusty.phase !== 'fly') break; }
  assert.ok(Object.keys(seen).length >= 3, 'gusts change the wind');
});

test('a soft, level touchdown on a pad lands and is graded', function () {
  var o = overPad(E.levelSpec(0), -0.5, 0.1, 0, 3), f = o.f;
  for (var i = 0; i < 30 && f.phase === 'fly'; i++) E.stepFlight(f, null);
  assert.strictEqual(f.phase, 'landed');
  var r = f.result;
  assert.ok(r.landed && r.grade === 'S' && r.mult === 3 && r.score > 900, JSON.stringify(r));
  assert.ok(r.centre > 0.9, 'centred');
  assert.ok(f.events.indexOf('land') >= 0);
  // after landing nothing moves
  var y = f.y;
  for (i = 0; i < 60; i++) E.stepFlight(f, { rot: 1, thrust: 1 });
  assert.ok(f.y === y && f.vx === 0 && f.vy === 0);
});

test('grades follow the worst of the three limits', function () {
  assert.strictEqual(E.gradeOf(0.1).id, 'S');
  assert.strictEqual(E.gradeOf(0.5).id, 'A');
  assert.strictEqual(E.gradeOf(0.7).id, 'B');
  assert.strictEqual(E.gradeOf(0.95).id, 'C');
  assert.strictEqual(E.gradeOf(1.2), null);
  var o = overPad(E.levelSpec(0), -0.3, 0.1, E.ANG_SAFE * 0.7, 2), f = o.f;
  for (var i = 0; i < 30 && f.phase === 'fly'; i++) E.stepFlight(f, null);
  assert.ok(f.result.landed && f.result.grade === 'B', 'tilt 0.7 of the limit → GOOD');
  assert.ok(E.landScore(5, E.GRADES[0], 0, 0) > E.landScore(1, E.GRADES[0], 0, 0));
});

test('too fast, sliding, tilted or off the pad crashes', function () {
  [[-6, 0, 0, 'Came down too fast'], [-0.5, 4, 0, 'Sliding sideways'], [-0.5, 0, 0.5, 'Not level']].forEach(function (c) {
    var f = overPad(E.levelSpec(0), c[0], c[1], c[2]).f;
    for (var i = 0; i < 240 && f.phase === 'fly'; i++) E.stepFlight(f, null);
    assert.strictEqual(f.phase, 'crashed', c[3]);
    assert.strictEqual(f.result.reason, c[3]);
    assert.ok(f.events.indexOf('crash') >= 0 && f.result.score === 0);
  });
  // gently onto the rocks
  var g = E.newFlight(E.levelSpec(2)), T = g.T, x = 0;
  for (x = 0; x < E.WORLD_W; x += 3) if (!E.padAt(T, x - 8) && !E.padAt(T, x + 8)) break;
  g.x = x; g.y = E.maxGround(T, x - 6, x + 6) - E.FOOT_Y + 0.5; g.vx = 0; g.vy = -0.5; g.cans = [];
  for (var i = 0; i < 120 && g.phase === 'fly'; i++) E.stepFlight(g, null);
  assert.strictEqual(g.phase, 'crashed');
  assert.ok(/rocks/.test(g.result.reason), g.result.reason);
});

test('a fuel canister refuels once', function () {
  var f = E.newFlight(E.levelSpec(8));
  assert.ok(f.cans.length === 3);
  var c = f.cans[0];
  f.fuel = 100; f.x = c.x; f.y = c.y; f.vx = 0; f.vy = 0;
  E.stepFlight(f, null);
  assert.ok(c.got && Math.abs(f.fuel - Math.min(f.fuelMax, 100 + E.CAN_FUEL)) < 1);
  assert.ok(f.events.indexOf('can') >= 0);
  var fu = f.fuel; f.x = c.x; f.y = c.y; E.stepFlight(f, null);
  assert.ok(f.fuel <= fu, 'only once');
});

test('the camera zooms in near the ground and keeps the lander in frame', function () {
  var f = E.newFlight(E.levelSpec(0)), zHigh = f.z;
  var o = overPad(E.levelSpec(0), -1, 0, 0), g = o.f;
  for (var i = 0; i < 400; i++) { g.y += 0; E.stepFlight(g, { rot: 0, thrust: 0.22 }); }
  assert.ok(g.z > zHigh * 2, 'closer to the ground → zoomed in (' + zHigh.toFixed(2) + ' → ' + g.z.toFixed(2) + ')');
  for (i = 0; i < 120 * 20 && f.phase === 'fly'; i++) {
    E.stepFlight(f, { rot: 0, thrust: 0 });
    var vh = E.REF_H / f.z;
    assert.ok(f.y - f.cy < 0.33 * vh + 1e-6 && f.cy - f.y < 0.31 * vh + 1e-6, 'in frame');
    assert.ok(f.z >= E.ZMIN - 1e-9 && f.z <= E.ZMAX + 1e-9);
  }
});

test('the Ace autopilot lands every campaign level', function () {
  for (var i = 0; i < E.LEVELS.length; i++) {
    var f = E.simulate(E.levelSpec(i), ap('hard'), 240);
    assert.ok(f.result.landed, 'level ' + (i + 1) + ': ' + f.result.reason);
    assert.ok(E.GRADE_RANK[f.result.grade] >= 3, 'level ' + (i + 1) + ' graded ' + f.result.grade);
  }
});

test('autopilot skills: Ace ≥ Pilot ≥ Rookie on the duel rounds, all legal inputs', function () {
  var tot = { easy: 0, normal: 0, hard: 0 }, land = { easy: 0, normal: 0, hard: 0 };
  for (var s = 1; s <= 6; s++) {
    var D = E.newDuel(s * 977, 'normal');
    for (var k = 0; k < E.DUEL_N; k++) {
      D.k = k;
      Object.keys(tot).forEach(function (sk) {
        var f = E.simulate(E.duelSpec(D), function (fl) {
          var inp = E.autopilot(fl, sk);
          assert.ok(inp.rot >= -1 && inp.rot <= 1 && inp.thrust >= 0 && inp.thrust <= 1, 'legal input');
          return inp;
        }, 240);
        tot[sk] += f.result.score; if (f.result.landed) land[sk]++;
      });
    }
  }
  assert.ok(land.hard >= 29 && land.normal >= 27, JSON.stringify(land));
  assert.ok(land.easy >= 18, 'the Rookie mostly lands: ' + land.easy);
  assert.ok(tot.hard > tot.normal && tot.normal > tot.easy, JSON.stringify(tot));
});

test('Ace lands most endless sorties', function () {
  var ok = 0, n = 0;
  for (var s = 1; s <= 8; s++) for (var k = 0; k < 12; k++) {
    n++;
    if (E.simulate(E.sortieSpec(k, s * 31, 900), ap('hard'), 240).result.landed) ok++;
  }
  assert.ok(ok >= n - 2, ok + '/' + n);
});

test('sorties get harder', function () {
  var a = E.sortieSpec(0, 5), b = E.sortieSpec(12, 5);
  assert.ok(b.g > a.g && Math.abs(b.wind) > Math.abs(a.wind) && b.gust > a.gust && b.rough > a.rough);
  assert.deepStrictEqual(E.sortieSpec(3, 9), E.sortieSpec(3, 9));
  for (var i = 1; i < E.LEVELS.length; i++) assert.ok(E.LEVELS[i].g >= E.LEVELS[0].g);
});

test('endless: hulls, fuel carry-over and game over', function () {
  var R = E.newEndless(42);
  E.endlessSettle(R, { landed: true, grade: 'S', mult: 3, score: 1000, fuel: 300 });
  assert.ok(R.score === 1000 && R.k === 1 && R.fuel === 300 + E.fuelBonus({ landed: true, grade: 'S', mult: 3 }) && R.perfects === 1);
  assert.strictEqual(E.endlessSpec(R).fuel, R.fuel);
  for (var i = 0; i < E.HULLS - 1; i++) E.endlessSettle(R, { landed: false, fuel: 500 });
  assert.ok(!R.over && R.hulls === 1);
  E.endlessSettle(R, { landed: false, fuel: 500 });
  assert.ok(R.over && R.hulls === 0);
  var R2 = E.newEndless(1);
  E.endlessSettle(R2, { landed: false, fuel: 150 });
  assert.ok(R2.over, 'out of fuel');
});

test('duel: alternate turns over the same rounds; winner', function () {
  var D = E.newDuel(7, '');
  var s0 = E.duelSpec(D);
  E.duelSettle(D, { landed: true, score: 500 });
  assert.ok(D.turn === 1 && D.k === 0);
  assert.deepStrictEqual(E.duelSpec(D), s0, 'player 2 flies the same round');
  E.duelSettle(D, { landed: false, score: 0 });
  assert.ok(D.turn === 0 && D.k === 1);
  assert.notDeepStrictEqual(E.duelSpec(D).seed, s0.seed);
  for (var k = 1; k < E.DUEL_N; k++) { E.duelSettle(D, { landed: true, score: 100 }); E.duelSettle(D, { landed: true, score: 200 }); }
  assert.ok(D.over);
  assert.deepStrictEqual(E.duelTotals(D), [900, 800]);
  assert.strictEqual(E.duelWinner(D), 0);
  var sv = E.newSave();
  E.settleDuel(sv, D);
  assert.deepStrictEqual(sv.duel.pvp, [1, 0, 0]);
  D.cpu = 'hard'; E.settleDuel(sv, D);
  assert.deepStrictEqual(sv.duel.cpu.hard, [1, 0, 0]);
});

test('save: campaign progress, records, normalisation', function () {
  var s = E.newSave();
  assert.strictEqual(s.open, 1);
  var o = E.settleLevel(s, 0, { landed: false });
  assert.ok(!o.unlocked && s.open === 1);
  o = E.settleLevel(s, 0, { landed: true, grade: 'B', score: 400 });
  assert.ok(o.unlocked && s.open === 2 && s.best[0].g === 'B' && s.best[0].s === 400);
  o = E.settleLevel(s, 0, { landed: true, grade: 'S', score: 300 });
  assert.ok(o.gradeUp && !o.best && s.best[0].g === 'S' && s.best[0].s === 400 && s.open === 2);
  assert.strictEqual(E.campaignStars(s), 4);
  E.noteFlight(s, { landed: true, grade: 'S' }); E.noteFlight(s, { landed: false });
  assert.deepStrictEqual([s.stats.flights, s.stats.landings, s.stats.perfects, s.stats.crashes], [2, 1, 1, 1]);
  var R = E.newEndless(1); R.score = 1234; R.landings = 3;
  assert.ok(E.settleEndless(s, R).best && s.endless.score === 1234 && s.endless.sorties === 3);
  s.opt.tilt = true; s.opt.cpu = 'hard';
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({ open: 99, best: [{ s: -5, g: 'Z' }, null, 'x'], endless: { score: 'NaN' }, duel: { cpu: { hard: [1, -1] }, pvp: 'no' }, opt: { cpu: 'god', opp: 'x', tilt: 'yes' }, stats: { flights: Infinity } });
  assert.ok(bad.open === E.LEVELS.length && bad.best[0].s === 0 && bad.best[0].g === '' && bad.endless.score === 0);
  assert.deepStrictEqual(bad.duel.cpu.hard, [1, 0, 0]);
  assert.ok(bad.opt.cpu === 'normal' && bad.opt.opp === 'cpu' && bad.opt.tilt === false && bad.stats.flights === 0);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('one foot hanging off the pad edge is not a landing', function () {
  var o = overPad(E.levelSpec(0), -1, 0, 0, 1), f = o.f, p = o.p;
  f.x = p.x1 - E.FOOT_X + 1.5;            // right foot past the edge
  for (var i = 0; i < 240 && f.phase === 'fly'; i++) E.stepFlight(f, { rot: 0, thrust: 0 });
  assert.strictEqual(f.phase, 'crashed');
  assert.ok(/edge|rocks/i.test(f.result.reason), f.result.reason);
});

test('landing works the same many world-widths away (wrap)', function () {
  var spec = E.levelSpec(2), a = overPad(spec, -1, 0, 0), b = overPad(spec, -1, 0, 0);
  b.f.x += E.WORLD_W * 7; a.f.x -= E.WORLD_W * 3;
  [a, b].forEach(function (o) { for (var i = 0; i < 240 && o.f.phase === 'fly'; i++) E.stepFlight(o.f, { rot: 0, thrust: 0 }); });
  assert.strictEqual(a.f.phase, 'landed'); assert.strictEqual(b.f.phase, 'landed');
  assert.strictEqual(a.f.result.score, b.f.result.score);
});

test('junk input is ignored safely; NaN never reaches the state', function () {
  var f = E.newFlight(E.levelSpec(5));
  var junk = [null, undefined, {}, { rot: NaN, thrust: NaN }, { rot: 99, thrust: -5 }, { rot: 'x', thrust: '1' }];
  for (var i = 0; i < 600; i++) E.stepFlight(f, junk[i % junk.length]);
  ['x', 'y', 'vx', 'vy', 'a', 'fuel', 'z', 'cy'].forEach(function (k) { assert.ok(isFinite(f[k]), k + ' finite'); });
});

test('simulations are deterministic and the autopilot always gives legal, finite input', function () {
  ['easy', 'normal', 'hard'].forEach(function (sk) {
    var spec = E.sortieSpec(4, 1234, 900), bad = 0;
    var pilot = function (f) { var o = E.autopilot(f, sk); if (!(o.rot >= -1 && o.rot <= 1 && o.thrust >= 0 && o.thrust <= 1)) bad++; return o; };
    var a = E.simulate(spec, pilot, 200), b = E.simulate(spec, pilot, 200);
    assert.strictEqual(bad, 0, sk + ' illegal input');
    assert.deepStrictEqual(a.result, b.result, sk + ' deterministic');
  });
});

test('endless ends when fuel runs too low even with hulls left', function () {
  var En = E.newEndless(5);
  E.endlessSettle(En, { landed: true, grade: 'C', mult: 1, score: 100, fuel: 0 });
  assert.ok(!En.over && En.fuel >= 120, 'a landing refuels');
  En.fuel = 50;
  E.endlessSettle(En, { landed: false, fuel: 50, score: 0 });
  assert.ok(En.over && En.hulls === 2);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
