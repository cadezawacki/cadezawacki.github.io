/* Headless checks for the Road Hopper engine (lanes, hops, rides, deaths,
 * bays, levels, endless generation, fixed-step determinism, the save).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/roadhopper/roadhopper.test.js */
'use strict';
var assert = require('assert');

var E = require('./roadhopper.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./roadhopper.js')];
require('./roadhopper.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function steps(g, n) { for (var i = 0; i < n; i++) { E.step(g); } g.events.length = 0; g.pops.length = 0; }
function settleHop(g) { var n = 0; while (g.h.hop && n++ < 200) E.step(g); }
// an empty, safe board to stage situations on
function calm(g) {
  g.lanes.forEach(function (L) { if (L) { L.objs = []; L.hurt = L.k === 'road'; } });
  g.bayT = 1e9; g.buddyT = 1e9; g.buddy = null;
  return g;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Road Hopper' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'roadhopper.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('classic board: roads, a median, the river, the bays', function () {
  var g = E.newGame({ seed: 5 });
  assert.strictEqual(g.lanes.length, E.ROWS);
  assert.strictEqual(g.lanes[0].k, 'safe');
  for (var r = 1; r <= 5; r++) assert.strictEqual(g.lanes[r].k, 'road');
  assert.strictEqual(g.lanes[6].k, 'safe');
  for (r = 7; r <= 11; r++) assert.strictEqual(g.lanes[r].k, 'water');
  assert.strictEqual(g.lanes[12].k, 'home');
  assert.strictEqual(g.bays.length, 5);
  assert.deepStrictEqual([g.h.x, g.h.y], [E.START_COL, 0]);
  assert.strictEqual(g.lives, E.DIFFS.normal.lives);
  // adjacent river lanes flow opposite ways, so there's always a way across
  for (r = 7; r < 11; r++) assert.ok(Math.sign(g.lanes[r].v) !== Math.sign(g.lanes[r + 1].v) || r === 8, 'row ' + r);
});

test('lane objects wrap within the loop and are a pure function of lane time', function () {
  var g = E.newGame({ seed: 9 }), L = g.lanes[1], o = L.objs[0];
  for (var t = 0; t < 200; t += 0.37) {
    var x = E.objX(L, o, t);
    assert.ok(x >= -E.MARG && x < E.LOOP - E.MARG, 'x in range at ' + t);
  }
  assert.ok(Math.abs(E.objX(L, o, 3) - E.objX(L, o, 3 + E.LOOP / Math.abs(L.v))) < 1e-9, 'periodic');
  // an object is fully off screen when it wraps
  assert.ok(E.LOOP - E.MARG >= E.COLS && E.MARG >= 6);
});

test('hops move one cell on the grid and are eased, with a buffered next hop', function () {
  var g = calm(E.newGame({ seed: 1 }));
  assert.ok(E.hop(g, 0));
  assert.ok(g.h.hop);
  E.hop(g, 1);                              // buffered while in the air
  assert.strictEqual(g.h.q, 1);
  var mid = 0;
  for (var i = 0; i < Math.ceil(E.HOP_T / E.STEP); i++) { E.step(g); if (g.h.z > mid) mid = g.h.z; }
  assert.ok(mid > 0.9, 'arc in the air');
  assert.strictEqual(g.h.y, 1);
  assert.ok(g.h.hop, 'buffered hop started on landing');
  settleHop(g);
  assert.deepStrictEqual([g.h.x, g.h.y], [E.START_COL + 1, 1]);
  assert.strictEqual(g.score, 10, '+10 for the new row only');
});

test('edges, back hops and the start row bump', function () {
  var g = calm(E.newGame({ seed: 1 }));
  assert.strictEqual(E.hop(g, 2), false, 'nothing below the start row');
  g.h.x = 0;
  assert.strictEqual(E.hop(g, 3), false, 'left edge');
  g.h.x = E.COLS - 1;
  assert.strictEqual(E.hop(g, 1), false, 'right edge');
  assert.ok(g.events.indexOf('bump') >= 0);
});

test('traffic squashes, a clear road is safe', function () {
  var g = calm(E.newGame({ seed: 2 }));
  E.hop(g, 0); settleHop(g);
  steps(g, 120);
  assert.strictEqual(g.phase, 'play');
  var L = g.lanes[1];
  L.v = 1; L.t = 0;
  L.objs = [{ x: E.MARG + g.h.x - 2.5, len: 2, ty: 'car', dive: false, ph: 0 }];
  for (var i = 0; i < 240 && g.phase === 'play'; i++) E.step(g);
  assert.strictEqual(g.phase, 'dying');
  assert.strictEqual(g.cause, 'squash');
  assert.strictEqual(g.lives, E.DIFFS.normal.lives - 1);
  steps(g, Math.ceil(E.DIE_T / E.STEP) + 2);
  assert.strictEqual(g.phase, 'play', 'respawned');
  assert.deepStrictEqual([g.h.x, g.h.y], [E.START_COL, 0]);
});

test('the river: no log is a splash; a log carries you; drifting off the edge kills', function () {
  var g = calm(E.newGame({ seed: 3 }));
  g.h.y = 6; g.h.top = 6;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.cause, 'splash');

  g = calm(E.newGame({ seed: 3 }));
  g.h.y = 6; g.h.top = 6;
  var L = g.lanes[7];
  L.v = 1.5; L.t = 0;
  L.objs = [{ x: E.MARG + E.START_COL - 1.5, len: 4, ty: 'log', dive: false, ph: 0 }];
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.phase, 'play', 'landed on the log');
  var x0 = g.h.x;
  steps(g, 60);
  assert.ok(Math.abs(g.h.x - (x0 + 0.75)) < 0.02, 'carried at the lane speed');
  for (var i = 0; i < 2000 && g.phase === 'play'; i++) E.step(g);
  assert.strictEqual(g.cause, 'drift');
});

test('sinking lily pads drop you when they go under', function () {
  var o = { x: 0, len: 2, ty: 'lily', dive: true, ph: 0 };
  assert.ok(E.padUp(o, 1) && E.padUp(o, 5) && !E.padUp(o, 5.6) && !E.padUp(o, 6.4) && E.padUp(o, 6.8));
  assert.deepStrictEqual([0, 4.5, 5.6, 6.4, 6.8].map(function (t) { return E.padState(o, t); }), [0, 1, 2, 3, 0]);
  var g = calm(E.newGame({ seed: 4 }));
  g.h.y = 6; g.h.top = 6;
  var L = g.lanes[7];
  L.v = 0.001; L.t = 0;
  L.objs = [{ x: E.MARG + E.START_COL - 0.5, len: 2, ty: 'lily', dive: true, ph: 3 }];
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.phase, 'play');
  for (var i = 0; i < 1200 && g.phase === 'play'; i++) E.step(g);
  assert.strictEqual(g.cause, 'splash');
  assert.ok(g.t > 2 && g.t < 3, 'went under on time');
});

test('bays: a home scores and respawns; hedges, filled bays and eels kill', function () {
  var g = calm(E.newGame({ seed: 6 }));
  g.h.y = 11; g.h.x = 4.3; g.h.top = 11; g.time = 20;
  g.lanes[11].objs = [{ x: E.MARG + 2, len: 6, ty: 'log', dive: false, ph: 0 }]; g.lanes[11].v = 0;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.homes, 1);
  assert.ok(g.bays[1].fill, 'snapped into the nearest bay');
  assert.strictEqual(g.score, 50 + 10 * 20);
  assert.deepStrictEqual([g.h.x, g.h.y], [E.START_COL, 0]);
  assert.strictEqual(g.time, g.timeMax);

  g.h.y = 11; g.h.x = 4; E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.cause, 'hedge', 'a filled bay is a wall');
  g = calm(E.newGame({ seed: 6 }));
  g.h.y = 11; g.h.x = 2.5; g.lanes[11].objs = [{ x: E.MARG, len: 6, ty: 'log', dive: false, ph: 0 }]; g.lanes[11].v = 0;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.cause, 'hedge');
  g = calm(E.newGame({ seed: 6 }));
  g.h.y = 11; g.h.x = 7; g.bays[2].item = 'eel'; g.bays[2].t = 9;
  g.lanes[11].objs = [{ x: E.MARG + 5, len: 6, ty: 'log', dive: false, ph: 0 }]; g.lanes[11].v = 0;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.cause, 'eel');
});

test('a bonus coin and a rescued buddy pay 200 each', function () {
  var g = calm(E.newGame({ seed: 7 }));
  g.h.y = 11; g.h.x = 10; g.h.top = 11; g.time = 0.5;
  g.lanes[11].objs = [{ x: E.MARG + 8, len: 6, ty: 'log', dive: false, ph: 0 }]; g.lanes[11].v = 0;
  g.bays[3].item = 'coin'; g.bays[3].t = 5;
  g.buddy = { row: 11, obj: 0, off: 2, dir: 1, t: 10 };
  steps(g, 1);
  assert.ok(g.h.carry, 'picked up the buddy');
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.score, 50 + 10 + 200 + 200);
  assert.strictEqual(g.bonus, 2);
  assert.strictEqual(g.buddy, null);
});

test('filling all five bays clears the level; the next is faster', function () {
  var g = calm(E.newGame({ seed: 8 }));
  var v1 = Math.abs(E.newGame({ seed: 8 }).lanes[1].v);
  for (var b = 0; b < 4; b++) g.bays[b].fill = true;
  g.h.y = 11; g.h.x = 13; g.lanes[11].objs = [{ x: E.MARG + 10, len: 5, ty: 'log', dive: false, ph: 0 }]; g.lanes[11].v = 0;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.phase, 'clear');
  assert.ok(g.score >= 1000);
  steps(g, Math.ceil(E.CLEAR_T / E.STEP) + 2);
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.level, 2);
  assert.ok(g.bays.every(function (x) { return !x.fill; }));
  assert.ok(Math.abs(g.lanes[1].v) > v1, 'faster traffic');
  var g5 = E.newGame({ seed: 8 }); g5.level = 5; E.buildClassic(g5);
  assert.ok(g5.lanes[6].hurt && g5.lanes[6].objs[0].ty === 'snake', 'a snake on the median by level 3+');
});

test('the trip timer runs out; lives run out; extra life at 10,000', function () {
  var g = calm(E.newGame({ seed: 10, diff: 'easy' }));
  assert.strictEqual(g.lives, 5);
  steps(g, Math.ceil(E.DIFFS.easy.time / E.STEP) + 2);
  assert.strictEqual(g.cause, 'time');
  g = calm(E.newGame({ seed: 10 }));
  g.lives = 1; E.die(g, 'squash');
  steps(g, Math.ceil(E.DIE_T / E.STEP) + 2);
  assert.strictEqual(g.phase, 'over');
  g = calm(E.newGame({ seed: 10 }));
  g.score = 9995; g.h.top = -1; E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.lives, 4);
});

test('endless lanes: deterministic per seed, varied, crossable', function () {
  var a = E.newGame({ mode: 'endless', seed: 77 }), b = E.newGame({ mode: 'endless', seed: 77 }), c = E.newGame({ mode: 'endless', seed: 78 });
  E.genEndless(a, 600); E.genEndless(b, 600); E.genEndless(c, 600);
  assert.strictEqual(JSON.stringify(a.lanes), JSON.stringify(b.lanes));
  assert.notStrictEqual(JSON.stringify(a.lanes), JSON.stringify(c.lanes));
  var kinds = {}, prevGrass = null;
  for (var r = 0; r <= 600; r++) {
    var L = a.lanes[r];
    kinds[L.k] = (kinds[L.k] || 0) + 1;
    if (r < 3) assert.strictEqual(L.k, 'safe');
    if (L.k === 'safe') {
      assert.ok(L.trees.length <= 5, 'not a wall of trees');
      assert.ok(L.coin < 0 || L.trees.indexOf(L.coin) < 0, 'coin not in a tree');
      if (prevGrass === r - 1) {
        var open = 0;
        for (var col = 0; col < E.COLS; col++) if (L.trees.indexOf(col) < 0 && a.lanes[r - 1].trees.indexOf(col) < 0) open++;
        assert.ok(open >= 3, 'a way between grass rows');
      }
      prevGrass = r;
    }
    if (L.k === 'water') {
      assert.ok(L.objs.length >= 2);
      var xs = L.objs.map(function (o) { return [o.x, o.x + o.len]; });
      for (var i = 1; i < xs.length; i++) assert.ok(xs[i][0] - xs[i - 1][1] <= 4.01 && xs[i][0] - xs[i - 1][1] >= 1.19, 'river gaps hop-able');
      assert.ok(Math.abs(L.v) <= 2.6 * E.DIFFS.normal.speed + 1e-9);
    }
    if (L.k === 'road') {
      assert.ok(L.objs.length >= 1);
      for (i = 1; i < L.objs.length; i++) assert.ok(L.objs[i].x - (L.objs[i - 1].x + L.objs[i - 1].len) >= 1.99, 'gaps between cars');
    }
  }
  ['safe', 'road', 'water', 'rail'].forEach(function (k) { assert.ok(kinds[k] > 20, 'has ' + k); });
});

test('endless: trees block, coins pay, trains pass, the edge creeps', function () {
  var g = E.newGame({ mode: 'endless', seed: 3 });
  g.lanes[2] = { k: 'safe', v: 0, t: 0, objs: [], hurt: false, trees: [E.START_COL], coin: -1 };
  assert.strictEqual(E.hop(g, 0), false, 'a tree in the way');
  g.lanes[2].trees = []; g.lanes[2].coin = E.START_COL;
  E.hop(g, 0); settleHop(g);
  assert.strictEqual(g.coins, 1);
  assert.strictEqual(g.score, 10 + 25);
  // a train: idle → warn → pass → idle, and it kills on the way
  var R = { k: 'rail', v: 18, t: 0, objs: [], hurt: false, trees: [], coin: -1, st: 'idle', tm: 0.2, tx: -20, cyc: 0, seed: 5 };
  g.lanes[3] = R;
  E.hop(g, 0); settleHop(g);
  var seen = {};
  for (var i = 0; i < 600 && g.phase === 'play'; i++) { E.step(g); seen[R.st] = 1; }
  assert.ok(seen.warn && seen.pass);
  assert.strictEqual(g.cause, 'train');
  // the creeping edge catches a hopper that waits
  g = E.newGame({ mode: 'endless', seed: 3 });
  g.lanes.forEach(function (L) { if (L) { L.objs = []; L.hurt = false; if (L.k === 'rail') L.k = 'safe'; } });
  E.hop(g, 0); settleHop(g);
  for (i = 0; i < 120 * 60 && g.phase === 'play'; i++) E.step(g);
  assert.strictEqual(g.cause, 'behind');
  assert.ok(E.creepSpeed(g) > 0);
});

test('fixed step: identical games stay identical whatever the frame rate', function () {
  function play(dt) {
    var g = E.newGame({ seed: 21 }), k = 0;
    while (g.steps < 1200) {
      E.advance(g, dt);
      if (g.steps >= k * 90) { E.hop(g, [0, 0, 1, 0, 3, 2][k % 6]); k++; }
      g.events.length = 0; g.pops.length = 0;
    }
    return g;
  }
  var a = play(1 / 60), b = play(1 / 120), c = play(1 / 144);
  [a, b, c].forEach(function (g) { assert.ok(g.steps >= 1200 && g.steps < 1210); });
  // lane positions depend only on the step count
  assert.ok(Math.abs(a.lanes[3].t - a.steps * E.STEP) < 1e-6);
  // advance returns an interpolation alpha in [0, 1)
  var g = E.newGame({ seed: 1 }), al = E.advance(g, 0.013);
  assert.ok(al >= 0 && al < 1);
  // a long hitch is clamped (no spiral of death)
  var s0 = g.steps; E.advance(g, 5); assert.ok(g.steps - s0 <= Math.ceil(0.25 / E.STEP) + 1);
});

test('the look-ahead pilot plays legally and gets hoppers home', function () {
  var homes = 0, rows = 0;
  [1, 2, 3].forEach(function (seed) {
    var g = E.newGame({ seed: seed }), cl = E.clone(g);
    assert.deepStrictEqual(cl, g, 'clone is exact');
    while (g.phase !== 'over' && g.t < 50) {
      if (g.phase === 'play' && !g.h.hop) {
        var d = E.pilot(g, 1);
        assert.ok(d >= -2 && d <= 3);
        if (d >= 0) E.hop(g, d);
      }
      E.step(g); g.events.length = 0; g.pops.length = 0;
      assert.ok(g.h.x > -1 && g.h.x < E.COLS && g.h.y >= 0 && g.h.y <= 12);
    }
    homes += g.homes;
  });
  assert.ok(homes >= 3, 'pilot got ' + homes + ' home');
  var e = E.newGame({ mode: 'endless', seed: 4 });
  while (e.phase !== 'over' && e.t < 25) {
    if (e.phase === 'play' && !e.h.hop) { var d2 = E.pilot(e, 1); if (d2 >= 0) E.hop(e, d2); }
    E.step(e); e.events.length = 0; e.pops.length = 0;
  }
  rows = e.maxRow;
  assert.ok(rows > 20, 'endless pilot crossed ' + rows + ' rows');
});

test('difficulties change speed, lives and time', function () {
  var ez = E.newGame({ seed: 1, diff: 'easy' }), hd = E.newGame({ seed: 1, diff: 'hard' }), bad = E.newGame({ seed: 1, diff: 'nope' });
  assert.ok(Math.abs(ez.lanes[1].v) < Math.abs(hd.lanes[1].v));
  assert.ok(ez.timeMax > hd.timeMax && ez.lives > hd.lives);
  assert.strictEqual(bad.diff, 'normal');
});

test('the save normalises junk and records bests and top scores', function () {
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('x'), E.newSave());
  var s = E.normSave({ mode: 'endless', diff: 'hard', players: 2, games: -3, hops: 'many', rec: { 'endless-hard': { score: '120', row: 40 }, bogus: 1 },
    tops: { 'endless-hard': [{ s: 50, n: 3, d: '2026-01-01' }, null, { s: 'x' }, { s: 90, n: 4 }] } });
  assert.strictEqual(s.mode, 'endless'); assert.strictEqual(s.diff, 'hard'); assert.strictEqual(s.players, 2);
  assert.strictEqual(s.games, 0); assert.strictEqual(s.hops, 0);
  assert.strictEqual(s.rec['endless-hard'].score, 120);
  assert.ok(!s.rec.bogus);
  assert.deepStrictEqual(s.tops['endless-hard'].map(function (e) { return e.s; }), [90, 50]);
  var sv = E.newSave();
  var r1 = E.settle(sv, { mode: 'classic', diff: 'normal', score: 500, level: 1, homes: 2, hops: 30, coins: 0 }, '2026-10-31');
  assert.ok(r1.best && r1.rank === 1);
  var r2 = E.settle(sv, { mode: 'classic', diff: 'normal', score: 300, level: 2, homes: 1, hops: 10, coins: 0 }, '2026-10-31');
  assert.ok(!r2.best && r2.rank === 2 && r2.bestN);
  for (var i = 0; i < 6; i++) E.settle(sv, { mode: 'classic', diff: 'normal', score: 100 + i, level: 1, homes: 0, hops: 1 }, '');
  assert.strictEqual(sv.tops['classic-normal'].length, 5);
  assert.strictEqual(sv.games, 8); assert.strictEqual(sv.homes, 3);
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(sv))), sv, 'round-trips');
  assert.notStrictEqual(E.gameSeed(sv), E.gameSeed(E.newSave()));
});

test('the save keeps the vs CPU choice and sorts before trimming the top table', function () {
  var s = E.normSave({ players: 2, cpu: true, cpuLv: 'ace' });
  assert.strictEqual(s.cpu, true); assert.strictEqual(s.cpuLv, 'ace');
  s = E.normSave({ players: 1, cpu: true, cpuLv: 'godlike' });
  assert.strictEqual(s.cpu, false, 'cpu needs the two-sided match'); assert.strictEqual(s.cpuLv, 'pro');
  s = E.normSave({ cpu: 'yes', players: 2 }); assert.strictEqual(s.cpu, false);
  var tops = [1, 2, 3, 4, 5, 6, 700].map(function (v) { return { s: v, n: 1 }; });
  s = E.normSave({ tops: { 'classic-normal': tops } });
  assert.deepStrictEqual(s.tops['classic-normal'].map(function (e) { return e.s; }), [700, 6, 5, 4, 3]);
});

function cpuRun(mode, lv, seed, cap) {
  var g = E.newGame({ mode: mode, seed: seed }), cpu = E.newCpu(lv, seed), hops = 0, maxMs = 0;
  while (g.phase !== 'over' && g.t < cap) {
    var wasHop = !!g.h.hop, ph = g.phase, t0 = Date.now();
    var d = E.cpuTick(g, cpu, E.STEP);
    maxMs = Math.max(maxMs, Date.now() - t0);
    if (d >= 0) {
      assert.ok(!wasHop && ph === 'play', 'the CPU only hops when it may');
      assert.ok(g.h.hop, 'a CPU hop is a real hop');
      hops++;
    }
    E.step(g); g.events.length = 0; g.pops.length = 0;
    assert.ok(g.h.x > -1 && g.h.x < E.COLS, 'stays on the board');
  }
  return { g: g, hops: hops, moves: cpu.moves, maxMs: maxMs };
}

test('the CPU rival: legal hops, deterministic, quick to think, and its levels are ranked', function () {
  var a = cpuRun('classic', 'pro', 3, 60), b = cpuRun('classic', 'pro', 3, 60);
  assert.strictEqual(a.g.score, b.g.score, 'same seed, same run');
  assert.strictEqual(a.hops, a.moves);
  assert.ok(a.hops > 30, 'it actually plays (' + a.hops + ' hops)');
  assert.ok(a.maxMs < 60, 'a decision never stalls the frame (' + a.maxMs + ' ms)');
  assert.ok(E.newCpu('bogus', 1).lv === 'pro');
  // rookies hesitate: fewer hops in the same time than an ace
  var rk = 0, ac = 0;
  [1, 2, 4].forEach(function (seed) {
    rk += cpuRun('endless', 'rookie', seed, 40).g.maxRow;
    ac += cpuRun('endless', 'ace', seed, 40).g.maxRow;
  });
  assert.ok(ac > rk, 'ace ' + ac + ' rows vs rookie ' + rk);
  // no CPU on a finished or paused-between-phases game
  var g = E.newGame({ seed: 2 }), cpu = E.newCpu('ace', 2);
  E.die(g, 'squash');
  for (var i = 0; i < 200; i++) assert.strictEqual(E.cpuTick(g, cpu, E.STEP), -1);
});

test('the pilot lines up the bays and clears a whole level', function () {
  var best = 0;
  [1, 2, 3].forEach(function (seed) {
    var g = E.newGame({ seed: seed });
    while (g.phase !== 'over' && g.t < 150 && g.level === 1) {
      if (g.phase === 'play' && !g.h.hop) { var d = E.pilot(g, 1); if (d >= 0) E.hop(g, d); }
      E.step(g); g.events.length = 0; g.pops.length = 0;
    }
    best = Math.max(best, g.level);
  });
  assert.ok(best >= 2, 'reached level ' + best);
});

test('a buddy lost with the hopper takes a while to turn up again', function () {
  var g = E.newGame({ seed: 4 });
  g.buddy = { row: 8, obj: 0, off: 0, dir: 1, t: 14 }; g.buddyT = 0; g.h.carry = true;
  E.die(g, 'squash');
  assert.strictEqual(g.buddy, null);
  assert.ok(g.buddyT >= 8, 'buddy timer reset');
  E.step(g);
  assert.strictEqual(g.buddy, null);
});

console.log(passed + ' passed');
