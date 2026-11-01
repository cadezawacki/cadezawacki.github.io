/* Headless checks for the Stack Tower engine (slicing, perfects, growth,
 * speed, debris physics, the CPU, saves). Not loaded by the app.
 * Run: node txt/widgets/stacktower/stacktower.test.js */
'use strict';
var assert = require('assert');

var E = require('./stacktower.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./stacktower.js')];
require('./stacktower.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b); }
// Put the slider at an exact offset from the top block and drop it.
function dropAt(g, off) {
  var tp = E.top(g);
  g.m.x = g.m.px = tp.x + off;
  return E.drop(g, 1);
}
function steps(g, n) { for (var i = 0; i < n && g.phase !== 'done'; i++) E.stepGame(g); }
// A seeded "player" with timing jitter ts (seconds): returns the finished game.
function play(mode, seed, ts, lvl) {
  var g = E.newGame({ mode: mode, seed: seed, lvl: lvl || 0 }), r = E.rng(seed * 31 + 5), plan = null;
  for (var i = 0; i < 120 * 2000 && g.phase !== 'done'; i++) {
    if (g.phase === 'play' && !E.isCpuTurn(g)) {
      if (!plan) { var u = Math.max(1e-9, r()), w = r(); plan = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * w) * ts * g.m.v; }
      var tg = E.top(g).x + plan;
      if ((g.m.px - tg) * (g.m.x - tg) <= 0) { E.drop(g, 1); plan = null; }
    }
    E.stepGame(g);
    g.events.length = 0;
  }
  return g;
}

test('registers as a widget with its css, under the manifest name', function () {
  assert.ok(widget && widget.name === 'Stack Tower' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'stacktower.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('a new game: a plinth and a slider of the same width one layer up', function () {
  var g = E.newGame({ seed: 3 });
  assert.strictEqual(g.blocks.length, 1);
  assert.strictEqual(g.m.w, E.W0);
  assert.strictEqual(g.m.n, 1);
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.players, 1);
  assert.strictEqual(E.newGame({ mode: 'duel' }).players, 2);
  assert.strictEqual(E.newGame({ mode: 'bogus' }).mode, 'classic');
});

test('the slider sweeps back and forth inside its range', function () {
  var g = E.newGame({ seed: 4 }), m = g.m, seenL = false, seenR = false;
  assert.strictEqual(m.dir, 1);                 // layer 1 comes from the left
  for (var i = 0; i < 120 * 8; i++) {
    E.stepGame(g);
    assert.ok(m.x >= m.lo - 1e-9 && m.x <= m.hi + 1e-9);
    if (m.x < m.lo + 5) seenL = true;
    if (m.x > m.hi - 5) seenR = true;
    assert.ok(Math.abs(m.x - m.px) <= m.v * E.STEP + 1e-9, 'no jumps');
  }
  assert.ok(seenL && seenR);
  dropAt(g, 0);
  assert.strictEqual(g.m.dir, -1);              // layer 2 from the right
});

test('a perfect drop snaps, keeps the width and grows the combo', function () {
  var g = E.newGame({ seed: 5 }), tol = E.tolAt(g.m.v), r = dropAt(g, tol * 0.9);
  assert.ok(r.perfect && !r.miss && r.cut === 0);
  var b = E.top(g);
  near(b.x, (E.FW - E.W0) / 2); near(b.w, E.W0);
  assert.strictEqual(g.combo, 1);
  assert.strictEqual(g.height, 1);
  assert.strictEqual(g.score, 2);               // 1 + combo bonus 1
  assert.strictEqual(g.debris.length, 0);
});

test('an off drop slices the overhang into debris on the right side', function () {
  var g = E.newGame({ seed: 6 }), tp = E.top(g), r = dropAt(g, 20);
  assert.ok(!r.perfect && !r.miss);
  near(r.cut, 20);
  var b = E.top(g);
  near(b.x, tp.x + 20); near(b.w, E.W0 - 20);
  assert.strictEqual(g.debris.length, 1);
  var d = g.debris[0];
  near(d.w, 20); near(d.x, tp.x + tp.w + 10);
  assert.ok(d.va < 0, 'a right-hand piece tips clockwise');
  assert.strictEqual(g.combo, 0);
  assert.strictEqual(g.score, 1);
  // and on the left
  r = dropAt(g, -15);
  assert.ok(g.debris[1].x < E.top(g).x && g.debris[1].va > 0);
  near(E.top(g).w, E.W0 - 35);
});

test('slices conserve width: block + debris = slider', function () {
  var g = E.newGame({ seed: 7 }), r = E.rng(1);
  for (var i = 0; i < 25 && g.phase === 'play'; i++) {
    var w = g.m.w, before = g.debris.length, res = dropAt(g, (r() - 0.5) * 0.4 * w);
    if (res.miss) break;
    if (!res.perfect) near(E.top(g).w + g.debris[g.debris.length - 1].w, w, 1e-6, 'conservation');
    else assert.strictEqual(g.debris.length, before);
    assert.ok(E.top(g).w > 0);
  }
});

test('the third perfect in a row grows the block, capped at the start width', function () {
  var g = E.newGame({ seed: 8 });
  dropAt(g, 30);                               // narrow it first
  var w = E.top(g).w;
  dropAt(g, 0); dropAt(g, 0);
  near(E.top(g).w, w);
  var cx = E.top(g).x + E.top(g).w / 2, r = dropAt(g, 0);
  assert.strictEqual(r.grow, E.GROW);
  near(E.top(g).w, w + E.GROW);
  near(E.top(g).x + E.top(g).w / 2, cx, 1e-9, 'grows about its centre');
  for (var i = 0; i < 20; i++) dropAt(g, 0);
  near(E.top(g).w, E.W0);
  assert.strictEqual(g.combo, 23);
  assert.strictEqual(g.bestCombo, 23);
  assert.strictEqual(E.top(g).perfect, true);
});

test('missing the tower ends the game after the fall', function () {
  var g = E.newGame({ seed: 9 }), r = dropAt(g, E.W0 + 4);
  assert.ok(r.miss);
  assert.strictEqual(g.phase, 'fall');
  assert.strictEqual(g.m, null);
  assert.strictEqual(g.height, 0);
  assert.strictEqual(g.debris.length, 1);
  assert.strictEqual(E.drop(g), null, 'no drops while falling');
  steps(g, Math.ceil(E.FALL_T / E.STEP) + 2);
  assert.strictEqual(g.phase, 'done');
  assert.ok(g.events.indexOf('miss') >= 0 && g.events.indexOf('done') >= 0);
});

test('a sliver narrower than a pixel of overlap counts as a miss', function () {
  var g = E.newGame({ seed: 10 }), r = dropAt(g, E.W0 - 0.5);
  assert.ok(r.miss);
});

test('speed rises with height (capped) and the perfect window follows it', function () {
  assert.ok(E.speedAt('classic', 20) > E.speedAt('classic', 2));
  assert.ok(E.speedAt('turbo', 1) > E.speedAt('classic', 1));
  assert.strictEqual(E.speedAt('classic', 10000), E.VMAX);
  assert.ok(E.tolAt(300) > E.tolAt(120));
  assert.ok(E.tolAt(1e6) <= 8 && E.tolAt(0) >= 3);
  var g = E.newGame({ seed: 11 }), v1 = g.m.v;
  for (var i = 0; i < 12; i++) dropAt(g, 0);
  assert.ok(g.m.v > v1);
});

test('the drop lands where the renderer last showed the slider', function () {
  var g = E.newGame({ seed: 12 });
  steps(g, 30);
  var m = g.m, want = m.px + (m.x - m.px) * 0.25, tp = E.top(g), r = E.drop(g, 0.25);
  near(r.x, want);
  if (!r.perfect && !r.miss) near(E.top(g).x, Math.max(want, tp.x));
});

test('debris falls, tumbles and comes to rest flat on the ground', function () {
  var g = E.newGame({ seed: 13 });
  dropAt(g, 40);
  var d = g.debris[0], y0 = d.y;
  steps(g, 6);
  assert.ok(d.y < y0 && d.a !== 0, 'falls and turns');
  steps(g, 120 * 6);
  assert.ok(d.rest, 'settles');
  var flat = Math.abs(Math.sin(d.a)) < 1e-9 || Math.abs(Math.cos(d.a)) < 1e-9;
  assert.ok(flat, 'flat on a side');
  assert.ok(d.y >= 0 && d.y < Math.max(d.w, d.h), 'on the ground');
  // and it never sinks below the ground on the way
  var g2 = E.newGame({ seed: 14 });
  dropAt(g2, -50);
  for (var i = 0; i < 120 * 5; i++) {
    E.stepGame(g2);
    var e = g2.debris[0], half = Math.abs(Math.sin(e.a)) * e.w / 2 + Math.abs(Math.cos(e.a)) * e.h / 2;
    assert.ok(e.y - half >= -1e-6, 'above ground');
  }
});

test('debris lands on the ledge a slice left below', function () {
  var g = E.newGame({ seed: 30 });
  dropAt(g, 30);                     // layer 1 sits 30 px right: the plinth sticks out on the left
  assert.strictEqual(E.supportAt(g, E.top(g).x - 10), E.LH);
  assert.strictEqual(E.supportAt(g, E.top(g).x + 10), 2 * E.LH);
  assert.strictEqual(E.supportAt(g, -50), 0);
  dropAt(g, -20);                    // its left 20 px are sliced off over that ledge
  var d = g.debris[g.debris.length - 1];
  steps(g, 120 * 6);
  assert.ok(d.rest);
  var half = Math.abs(Math.sin(d.a)) * d.w / 2 + Math.abs(Math.cos(d.a)) * d.h / 2;
  near(d.y - half, Math.min(E.supportAt(g, d.x), E.LH), 1e-6, 'rests on the plinth (or the ground if it slid off)');
  assert.ok(d.y - half >= 0);
});

test('debris is capped', function () {
  var g = E.newGame({ seed: 15 });
  for (var i = 0; i < 200 && g.phase === 'play'; i++) dropAt(g, i % 2 ? 0.5 + E.tolAt(g.m.v) : -0.5 - E.tolAt(g.m.v));
  assert.ok(g.debris.length <= 64);
});

test('the camera rises smoothly to the tower top', function () {
  var g = E.newGame({ seed: 16 });
  for (var i = 0; i < 10; i++) dropAt(g, 0);
  var prev = g.cam, maxStep = 0;
  for (i = 0; i < 240; i++) { E.stepGame(g); maxStep = Math.max(maxStep, Math.abs(g.cam - prev)); prev = g.cam; }
  near(g.cam, g.blocks.length, 0.01);
  assert.ok(maxStep < 0.6, 'no jumps');
});

test('fixed step: the same at 60 Hz and 120 Hz frames', function () {
  var a = E.newGame({ seed: 17 }), b = E.newGame({ seed: 17 });
  for (var i = 0; i < 120; i++) E.advance(a, 1 / 60);
  for (i = 0; i < 240; i++) E.advance(b, 1 / 120);
  near(a.m.x, b.m.x, 1e-6); near(a.cam, b.cam, 1e-6);
  assert.strictEqual(a.steps, b.steps);
  var al = E.advance(E.newGame({ seed: 1 }), 0.5 * E.STEP);
  assert.ok(al > 0 && al < 1);
});

test('games are deterministic for a seed', function () {
  var a = play('classic', 21, 0.045), b = play('classic', 21, 0.045);
  assert.strictEqual(a.height, b.height); assert.strictEqual(a.score, b.score);
  assert.deepStrictEqual(a.blocks.map(function (k) { return k.x; }), b.blocks.map(function (k) { return k.x; }));
});

test('a good player beats a sloppy one, and turbo is harder', function () {
  var good = 0, bad = 0, cl = 0, tb = 0;
  for (var s = 1; s <= 40; s++) {
    good += play('classic', s, 0.03).height; bad += play('classic', s, 0.08).height;
    cl += play('classic', s, 0.045).height; tb += play('turbo', s, 0.045).height;
  }
  assert.ok(good > bad * 2, good + ' vs ' + bad);
  assert.ok(cl > tb, cl + ' vs ' + tb);
  assert.ok(bad / 40 >= 5, 'still a game for beginners');
});

test('scoring: a layer is 1, perfects add the streak (up to 5)', function () {
  var g = E.newGame({ seed: 22 }), gains = [];
  for (var i = 0; i < 8; i++) gains.push(dropAt(g, 0).gain);
  assert.deepStrictEqual(gains, [2, 3, 4, 5, 6, 6, 6, 6]);
  assert.strictEqual(dropAt(g, 20).gain, 1);
  assert.strictEqual(g.score, 39);
});

test('duel: turns alternate, the one who misses loses', function () {
  var g = E.newGame({ mode: 'duel', seed: 23 });
  assert.strictEqual(g.turn, 0);
  dropAt(g, 0); assert.strictEqual(g.turn, 1);
  dropAt(g, 10); assert.strictEqual(g.turn, 0);
  assert.deepStrictEqual(g.pts, [2, 1]);
  assert.deepStrictEqual(g.drops, [1, 1]);
  assert.strictEqual(E.isCpuTurn(g), false);
  dropAt(g, 500);
  assert.strictEqual(g.loser, 0);
  assert.strictEqual(E.winner(g), 1);
});

test('vs CPU: the CPU plays its own turns, only on its turn, legally', function () {
  var g = E.newGame({ mode: 'cpu', seed: 24, lvl: 1 });
  assert.ok(!E.isCpuTurn(g) && g.plan === null);
  steps(g, 120 * 3);
  assert.strictEqual(g.height, 0, 'the CPU waits for you');
  dropAt(g, 0);
  assert.ok(E.isCpuTurn(g) && g.plan);
  var h = g.height;
  steps(g, 120 * 6);
  assert.ok(g.height === h + 1 || g.phase !== 'play', 'the CPU dropped once');
  if (g.phase === 'play') { assert.strictEqual(g.turn, 0); assert.strictEqual(g.drops[1], 1); }
});

test('CPU levels: harder CPUs last longer against the same player', function () {
  var tot = [0, 0, 0], wins = [0, 0, 0];
  for (var lvl = 0; lvl < 3; lvl++) for (var s = 1; s <= 60; s++) {
    var g = play('cpu', s, 0.045, lvl);
    assert.strictEqual(g.phase, 'done');
    tot[lvl] += g.height;
    if (E.winner(g) === 0) wins[lvl]++;
  }
  assert.ok(tot[0] < tot[1] && tot[1] < tot[2], tot.join(','));
  assert.ok(wins[0] > wins[2], wins.join(','));
  assert.ok(wins[2] > 3, 'hard is beatable');
  assert.ok(wins[0] < 60, 'easy still wins sometimes');
});

test('summary and settle: bests, CPU record, duels', function () {
  var sv = E.newSave(), g = E.newGame({ seed: 25 });
  dropAt(g, 0); dropAt(g, 0); dropAt(g, 9); dropAt(g, 999);
  var res = E.summary(g), cd = E.settle(sv, res);
  assert.ok(cd.best.score && cd.best.height && cd.best.combo);
  assert.strictEqual(sv.best.classic.height, 3);
  assert.strictEqual(sv.best.classic.combo, 2);
  assert.strictEqual(sv.games, 1); assert.strictEqual(sv.perfects, 2); assert.strictEqual(sv.layers, 3);
  cd = E.settle(sv, res);
  assert.deepStrictEqual(cd.best, {});
  var c = E.newGame({ mode: 'cpu', seed: 2, lvl: 2 });
  dropAt(c, 999);
  cd = E.settle(sv, E.summary(c));
  assert.strictEqual(cd.win, false);
  assert.deepStrictEqual(sv.cpu.l, [0, 0, 1]);
  var d = E.newGame({ mode: 'duel', seed: 3 });
  dropAt(d, 0); dropAt(d, 999);
  cd = E.settle(sv, E.summary(d));
  assert.strictEqual(cd.win, null);
  assert.strictEqual(sv.duels, 1);
  assert.strictEqual(sv.best.classic.height, 3, 'duels leave solo records alone');
});

test('save normalisation survives junk', function () {
  [null, 5, 'x', [], { best: 'no' }, { best: { classic: { score: 'NaN', height: -4 } } }, { cpu: { w: 'a', l: [1, 'b'] } }].forEach(function (o) {
    var s = E.normSave(o);
    assert.strictEqual(typeof s.best.classic.score, 'number');
    assert.ok(s.best.classic.height >= 0);
    assert.strictEqual(s.cpu.w.length, 3);
    assert.strictEqual(s.mode, 'classic');
  });
  var s = E.normSave({ games: 4.7, mode: 'turbo', lvl: 2, best: { turbo: { score: 12, height: 9, combo: 3 } }, cpu: { w: [1, 2, 3], l: [4, 5, Infinity] } });
  assert.strictEqual(s.games, 4); assert.strictEqual(s.mode, 'turbo'); assert.strictEqual(s.lvl, 2);
  assert.deepStrictEqual(s.best.turbo, { score: 12, height: 9, combo: 3 });
  assert.deepStrictEqual(s.cpu.l, [4, 5, 0]);
  var rt = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(rt, s);
  assert.strictEqual(E.normSave({ mode: 'evil', lvl: 7 }).lvl, 1);
});

test('2 players: the next slider holds still for a beat, so a double tap cannot drop it', function () {
  var g = E.newGame({ mode: 'duel', seed: 40 });
  assert.strictEqual(g.m.hold, 0, 'the first slider moves at once');
  assert.ok(E.canDrop(g));
  dropAt(g, 0);
  assert.strictEqual(g.turn, 1);
  assert.ok(g.m.hold > 0 && !E.canDrop(g), 'P2 cannot drop on the hand-off beat');
  var x0 = g.m.x;
  steps(g, Math.floor(E.HOLD / E.STEP) - 2);
  assert.strictEqual(g.m.x, x0, 'held still');
  steps(g, 6);
  assert.ok(E.canDrop(g) && g.m.x !== x0, 'then it slides');
  // solo and vs CPU never hold
  var c = E.newGame({ mode: 'classic', seed: 41 }); dropAt(c, 0); assert.strictEqual(c.m.hold, 0);
  var v = E.newGame({ mode: 'cpu', seed: 41 }); assert.ok(E.canDrop(v)); dropAt(v, 0);
  assert.strictEqual(v.m.hold, 0); assert.ok(!E.canDrop(v), 'never on the CPU\'s turn');
});

test('the full-width block can never miss outright (the sweep always overlaps)', function () {
  var R = E.rangeOf(E.W0), g;
  [R.lo, R.hi].forEach(function (x) {
    g = E.newGame({ seed: 42 }); g.m.x = g.m.px = x;
    var r = E.drop(g, 1);
    assert.ok(!r.miss && r.cut > 0 && E.top(g).w > 0);
  });
  // but a narrow one can
  var n = E.rangeOf(20);
  assert.ok(n.hi - n.lo > 2 * 20 + 40);
});

test('CPU drops always land inside its sweep and only on its own turns (long games)', function () {
  for (var lvl = 0; lvl < 3; lvl++) for (var s = 50; s < 56; s++) {
    var g = E.newGame({ mode: 'cpu', seed: s, lvl: lvl }), r = E.rng(s);
    for (var i = 0; i < 120 * 600 && g.phase !== 'done'; i++) {
      if (E.canDrop(g) && r() < 0.012) {
        var tp = E.top(g); g.m.x = g.m.px = tp.x + (r() - 0.5) * 40; E.drop(g, 1);
      }
      var before = g.drops[1], m = g.m;
      E.stepGame(g);
      if (g.drops[1] > before) {
        assert.strictEqual(g.last.player, 1);
        assert.ok(g.last.x >= m.lo - 1e-6 && g.last.x <= m.hi + 1e-6, 'inside the sweep');
      }
      g.events.length = 0;
    }
    assert.strictEqual(g.phase, 'done', 'every game ends');
  }
});

test('debris never sinks below the ground or its ledge, and it all settles', function () {
  var g = E.newGame({ seed: 60 }), r = E.rng(60);
  for (var k = 0; k < 15 && g.phase === 'play'; k++) {
    dropAt(g, (r() < 0.5 ? -1 : 1) * (5 + r() * 3));
    for (var i = 0; i < 60; i++) {
      E.stepGame(g);
      g.debris.forEach(function (d) {
        var half = Math.abs(Math.sin(d.a)) * d.w / 2 + Math.abs(Math.cos(d.a)) * d.h / 2;
        assert.ok(d.y - half >= -1e-6, 'above ground');
        assert.ok(isFinite(d.x) && isFinite(d.y) && isFinite(d.a));
      });
    }
  }
  assert.strictEqual(g.phase, 'play');
  steps(g, 120 * 14);
  assert.ok(g.debris.every(function (d) { return d.rest || d.t <= 12; }), 'everything settles (a faint pile stays, capped)');
});

console.log(passed + ' passed');
if (process.exitCode) process.exit(1);
