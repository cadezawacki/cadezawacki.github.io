/* Headless checks for the Bug Swarm engine (movement rules, shooting, splitting,
 * extras, lives, waves, determinism, saves). Not loaded by the app (not in the
 * manifest). Run: node txt/widgets/bugswarm/bugswarm.test.js */
'use strict';
var assert = require('assert');

var E = require('./bugswarm.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./bugswarm.js')];
require('./bugswarm.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var C = E.COLS, R = E.ROWS;
// An empty field with one bug placed by hand, frozen extras.
function bare(seed) {
  var g = E.newGame(seed || 1);
  g.m.fill(0); g.pz.fill(0); g.bugs = []; g.foes = []; g.grace = 0;
  g.skT = g.tickT = g.hornetT = 1e9; g.sideT = 1e9;
  return g;
}
function seg(g, c, r, d) { var s = E.mkSeg(c, r, d); s.pr = r; s.y = s.oy = r; g.bugs.push({ segs: [s], t: 0, v: 8 }); return s; }
function mushCount(g) { var n = 0; for (var i = 0; i < g.m.length; i++) if (g.m[i]) n++; return n; }
function play(g, secs, pilot) {
  var n = Math.round(secs / E.STEP), ev = {};
  for (var i = 0; i < n && g.phase !== 'over'; i++) {
    E.step(g, pilot ? pilot(g) : null);
    g.ev.forEach(function (e) { ev[e.k] = (ev[e.k] || 0) + 1; });
    g.ev.length = 0;
    if (g.phase === 'down') E.respawn(g);
  }
  return ev;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Bug Swarm' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'bugswarm.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('a new field: mushrooms placed, the top row and the start clear, same for a seed', function () {
  var g = E.newGame(42), n = mushCount(g);
  assert.strictEqual(n, E.DIFFS.normal.mush);
  for (var c = 0; c < C; c++) assert.ok(!g.m[E.idx(c, 0)], 'row 0 clear');
  for (var r = R - 3; r < R; r++) for (c = 12; c < 16; c++) assert.ok(!g.m[E.idx(c, r)], 'start clear');
  assert.deepStrictEqual(Array.from(E.newGame(42).m), Array.from(g.m));
  assert.notDeepStrictEqual(Array.from(E.newGame(43).m), Array.from(g.m));
  assert.strictEqual(E.newGame(1, { diff: 'hard' }).lives, 3);
  assert.strictEqual(mushCount(E.newGame(1, { diff: 'easy' })), E.DIFFS.easy.mush);
  assert.strictEqual(E.segCount(g), E.BUG_LEN);
  assert.strictEqual(g.bugs.length, 1);
});

test('a segment walks sideways, drops a row at a wall and turns around', function () {
  var g = bare(), s = seg(g, C - 2, 3, 1);
  E.decide(g, s); assert.deepStrictEqual([s.c, s.r, s.d], [C - 1, 3, 1]);
  E.decide(g, s); assert.deepStrictEqual([s.c, s.r, s.d], [C - 1, 4, -1]);
  E.decide(g, s); assert.deepStrictEqual([s.c, s.r, s.d], [C - 2, 4, -1]);
});

test('a mushroom turns it too; a poisoned one sends it diving to the bottom', function () {
  var g = bare(), s = seg(g, 5, 3, 1);
  g.m[E.idx(6, 3)] = 4;
  E.decide(g, s); assert.deepStrictEqual([s.c, s.r, s.d], [5, 4, -1]);
  var p = seg(g, 10, 2, 1);
  g.m[E.idx(11, 2)] = 4; g.pz[E.idx(11, 2)] = 1;
  E.decide(g, p);
  assert.ok(p.poison && p.r === 3 && p.c === 10);
  for (var i = 0; i < 40 && p.poison; i++) { assert.strictEqual(p.c, 10, 'straight down'); E.decide(g, p); }
  assert.ok(!p.poison && p.r === R - 1, 'dived to the bottom row');
});

test('in the garden it bounces between the bottom and the garden top', function () {
  var g = bare(), s = seg(g, 0, R - 1, -1);
  var rows = [];
  for (var i = 0; i < 400; i++) { E.decide(g, s); rows.push(s.r); }
  var lo = Math.min.apply(null, rows), hi = Math.max.apply(null, rows);
  assert.strictEqual(hi, R - 1);
  assert.strictEqual(lo, E.ZONE_TOP);
});

test('a bug entering from above follows its head in a line', function () {
  var g = bare();
  E.addBug(g, 5, 10, 1, 0);
  for (var i = 0; i < 600; i++) E.stepBugs(g, E.STEP);
  var segs = g.bugs[0].segs;
  for (i = 1; i < segs.length; i++) {
    var a = segs[i - 1], b = segs[i];
    assert.strictEqual(Math.abs(a.pc - b.pc) + Math.abs(a.pr - b.pr), 1, 'segments are neighbours');
  }
});

test('shooting mid-body splits the bug, leaves a mushroom, scores 10; a head scores 100', function () {
  var g = bare();
  E.addBug(g, 6, 10, 1, 5);
  var b = g.bugs[0];
  b.segs.forEach(function (s, i) { s.c = s.pc = 10 - i; s.r = s.pr = 5; s.x = s.c; s.y = 5; });
  assert.ok(E.hitAt(g, 8.5, 5.5));
  assert.strictEqual(g.score, 10);
  assert.strictEqual(g.bugs.length, 2);
  assert.deepStrictEqual(g.bugs.map(function (x) { return x.segs.length; }), [2, 3]);
  assert.strictEqual(g.m[E.idx(8, 5)], E.MUSH_HP, 'a mushroom where it was');
  assert.ok(E.hitAt(g, 10.5, 5.5));
  assert.strictEqual(g.score, 110);
  assert.ok(g.ev.some(function (e) { return e.k === 'kill' && e.head; }));
  assert.ok(g.ev.some(function (e) { return e.k === 'split'; }));
  assert.strictEqual(E.segCount(g), 4);
});

test('mushrooms take four hits, one point when they go', function () {
  var g = bare();
  g.m[E.idx(4, 10)] = 4;
  for (var i = 0; i < 3; i++) { assert.ok(E.hitAt(g, 4.5, 10.5)); assert.ok(g.m[E.idx(4, 10)]); }
  assert.ok(E.hitAt(g, 4.5, 10.5));
  assert.strictEqual(g.m[E.idx(4, 10)], 0);
  assert.strictEqual(g.score, 1);
  assert.ok(!E.hitAt(g, 4.5, 10.5));
});

test('one shot in the air at a time, and it flies up', function () {
  var g = bare();
  E.addBug(g, 1, 0, 1, -40);              // far away, so the wave does not end
  E.step(g, { fire: true });
  assert.ok(g.b.on);
  var y0 = g.b.y;
  E.step(g, { fire: true });
  assert.strictEqual(g.st.shots, 1);
  assert.ok(g.b.y < y0 - 0.4);
  for (var i = 0; i < 120 && g.b.on; i++) E.step(g, { fire: false });
  assert.ok(!g.b.on, 'leaves the top');
  E.step(g, { fire: true });
  assert.strictEqual(g.st.shots, 2);
});

test('the player stays in the garden and is stopped by mushrooms', function () {
  var g = bare();
  E.addBug(g, 1, 0, 1, -40);
  for (var i = 0; i < 300; i++) E.step(g, { ay: -1 });
  assert.ok(Math.abs(g.p.y - (E.ZONE_TOP + E.PR)) < 1e-6, 'top of the garden');
  for (i = 0; i < 300; i++) E.step(g, { ax: -1 });
  assert.ok(Math.abs(g.p.x - E.PR) < 1e-6, 'left wall');
  g.p.x = 10.5; g.p.y = R - 0.5;
  g.m[E.idx(12, R - 1)] = 4;
  for (i = 0; i < 200; i++) E.step(g, { ax: 1 });
  assert.ok(g.p.x <= 12 - E.PR + 1e-6 && g.p.x > 11, 'flush against the mushroom: ' + g.p.x);
  // drag target: moves at a capped speed toward it
  g.p.x = 3.5; g.p.y = R - 0.5;
  E.step(g, { tx: 9.5, ty: R - 0.5 });
  assert.ok(g.p.x > 3.5 && g.p.x < 3.9);
  for (i = 0; i < 120; i++) E.step(g, { tx: 9.5, ty: R - 0.5 });
  assert.ok(Math.abs(g.p.x - 9.5) < 1e-6);
});

test('skitter points depend on how close it is', function () {
  var g = bare();
  g.p.y = R - 0.5;
  E.addFoe(g, 'skitter', 5, R - 1, 1, 1, 0.95, 0.5);
  E.hitFoe(g, 0); assert.strictEqual(g.score, 900);
  E.addFoe(g, 'skitter', 5, R - 4.5, 1, 1, 0.95, 0.5);
  E.hitFoe(g, 0); assert.strictEqual(g.score, 1500);
  E.addFoe(g, 'skitter', 5, R - 6, 1, 1, 0.95, 0.5);
  E.hitFoe(g, 0); assert.strictEqual(g.score, 1800);
});

test('a skitter eats mushrooms and leaves; it stays in the low band', function () {
  var g = bare();
  E.addBug(g, 1, 0, 1, -400);
  for (var c = 0; c < C; c++) for (var r = E.ZONE_TOP - 2; r < R; r++) g.m[E.idx(c, r)] = 4;
  var before = mushCount(g);
  E.addFoe(g, 'skitter', -1, E.ZONE_TOP, 5, 6, 0.95, 0.5);
  var minY = 99, maxY = -99, f = g.foes[0];
  for (var i = 0; i < 120 * 30 && g.foes.length; i++) { E.stepFoes(g, E.STEP); minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y); }
  assert.strictEqual(g.foes.length, 0, 'it left the field');
  assert.ok(mushCount(g) < before, 'ate some');
  assert.ok(minY >= E.ZONE_TOP - 2.5 - 1e-9 && maxY <= R - 0.5 + 1e-9);
});

test('a tick takes two hits (faster after the first) and sows mushrooms', function () {
  var g = bare();
  E.addFoe(g, 'tick', 7.5, -0.5, 0, 10, 0.45, 0.5, 2);
  var f = g.foes[0];
  E.hitFoe(g, 0); assert.strictEqual(g.foes.length, 1); assert.strictEqual(f.vy, 20); assert.strictEqual(g.score, 0);
  E.hitFoe(g, 0); assert.strictEqual(g.foes.length, 0); assert.strictEqual(g.score, 200);
  var sown = 0;
  for (var k = 0; k < 20; k++) {
    var h = bare(100 + k);
    E.addFoe(h, 'tick', 3.5, -0.5, 0, 10, 0.45, 0.5, 2);
    for (var i = 0; i < 600 && h.foes.length; i++) E.stepFoes(h, E.STEP);
    sown += mushCount(h);
  }
  assert.ok(sown > 20, 'sowed ' + sown);
});

test('a hornet poisons the mushrooms it crosses', function () {
  var g = bare();
  for (var c = 0; c < C; c += 3) g.m[E.idx(c, 6)] = 4;
  E.addFoe(g, 'hornet', -1.5, 6.5, 6, 0, 1.1, 0.45);
  for (var i = 0; i < 1200 && g.foes.length; i++) E.stepFoes(g, E.STEP);
  for (c = 0; c < C; c += 3) assert.ok(g.pz[E.idx(c, 6)], 'poisoned ' + c);
  assert.strictEqual(g.foes.length, 0);
  E.addFoe(g, 'hornet', 4, 6.5, 6, 0, 1.1, 0.45);
  E.hitFoe(g, 0);
  assert.strictEqual(g.score, 1000);
});

test('extra life at each bonus threshold', function () {
  var g = E.newGame(5), L = g.lives, B = g.D.bonus;
  E.addScore(g, B - 1); assert.strictEqual(g.lives, L);
  E.addScore(g, 1); assert.strictEqual(g.lives, L + 1);
  E.addScore(g, 2 * B); assert.strictEqual(g.lives, L + 3);
  assert.strictEqual(g.nextLife, 4 * B);
});

test('losing a life: regrow damaged / poisoned mushrooms (+5 each), then the bug comes back with its segments', function () {
  var g = bare();
  E.addBug(g, 7, 10, 1, 4);
  E.addBug(g, 1, 3, 1, 4);
  g.m[E.idx(2, 2)] = 2; g.m[E.idx(3, 9)] = 4; g.pz[E.idx(3, 9)] = 1; g.m[E.idx(5, 5)] = 4;
  var L = g.lives;
  g.p.x = 10.5; g.p.y = R - 0.5;
  var h = g.bugs[1].segs[0]; h.c = h.pc = 10; h.r = h.pr = R - 1;   // right on top of the player
  E.step(g, null);
  assert.strictEqual(g.phase, 'dying');
  assert.strictEqual(g.lives, L - 1);
  for (var i = 0; i < 2000 && g.phase !== 'down'; i++) E.step(g, null);
  assert.strictEqual(g.phase, 'down');
  assert.strictEqual(g.score, 10, 'two mushrooms regrown');
  assert.ok(g.m[E.idx(2, 2)] === 4 && !g.pz[E.idx(3, 9)]);
  assert.ok(E.respawn(g));
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(E.segCount(g), 8);
  assert.strictEqual(g.bugs.length, 2);
  assert.ok(!E.respawn(g), 'only once');
});

test('the last life ends the game', function () {
  var g = bare();
  g.lives = 1;
  E.addBug(g, 1, 10, 1, 0);
  var h = g.bugs[0].segs[0]; h.c = h.pc = Math.floor(g.p.x); h.r = h.pr = R - 1;
  E.step(g, null);
  for (var i = 0; i < 2000 && g.phase !== 'over'; i++) E.step(g, null);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.lives, 0);
});

test('clearing every segment starts the next wave: shorter bug, more heads, faster', function () {
  var g = E.newGame(9);
  var v1 = E.bugSpeed(g);
  g.bugs = [];
  E.step(g, null);
  assert.strictEqual(g.wave, 2);
  assert.strictEqual(g.bugs.length, 2);
  assert.strictEqual(E.segCount(g), E.BUG_LEN);
  assert.strictEqual(g.bugs[0].segs.length, E.BUG_LEN - 1);
  assert.ok(E.bugSpeed(g) > v1);
  g.wave = 40; assert.strictEqual(E.bugSpeed(g), g.D.vmax);
});

test('loose heads join from the sides once the bug reaches the bottom', function () {
  var g = bare();
  E.addBug(g, 1, 3, 1, -300);
  g.bottom = true; g.sideT = 0.001;
  E.step(g, null);
  assert.strictEqual(g.bugs.length, 2);
  var h = g.bugs[1].segs[0];
  assert.ok(h.c === -1 || h.c === C);
  for (var i = 0; i < 60; i++) E.stepBugs(g, E.STEP);
  assert.ok(h.c >= 0 && h.c < C, 'walked in');
});

test('fixed step: the same game at 60 Hz and 144 Hz frames', function () {
  function run(fps) {
    var g = E.newGame(77), t = 0;
    while (t < 20) { E.advance(g, 1 / fps, E.autopilot(g)); t += 1 / fps; if (g.phase === 'down') E.respawn(g); }
    return g;
  }
  var a = run(60), b = run(120);
  // both have run the same number of fixed steps (± one) with the same inputs per step
  assert.ok(Math.abs(a.steps - b.steps) <= 1);
  var alpha = E.advance(E.newGame(1), 0.5 / 120, null);
  assert.ok(alpha > 0.49 && alpha < 0.51);
});

test('deterministic: the same seed and pilot give the same game', function () {
  var a = E.newGame(1234), b = E.newGame(1234);
  play(a, 40, E.autopilot); play(b, 40, E.autopilot);
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.wave, b.wave);
  assert.deepStrictEqual(Array.from(a.m), Array.from(b.m));
});

test('a long autopilot game stays sane (no NaN, bounded field, scores, waves)', function () {
  var totals = { score: 0, waves: 0, ev: {} };
  ['easy', 'normal', 'hard'].forEach(function (d, i) {
    var g = E.newGame(500 + i, { diff: d });
    var ev = play(g, 240, function (gg) {
      var p = gg.p;
      assert.ok(isFinite(p.x) && isFinite(p.y));
      assert.ok(p.x >= E.PR - 1e-9 && p.x <= C - E.PR + 1e-9 && p.y >= E.ZONE_TOP + E.PR - 1e-9 && p.y <= R - E.PR + 1e-9);
      gg.bugs.forEach(function (b) {
        assert.ok(b.segs.length > 0);
        b.segs.forEach(function (s) { assert.ok(isFinite(s.x) && isFinite(s.y) && s.r <= R - 1 && s.c >= -1 && s.c <= C); });
      });
      return E.autopilot(gg);
    });
    Object.keys(ev).forEach(function (k) { totals.ev[k] = (totals.ev[k] || 0) + ev[k]; });
    totals.score += g.score; totals.waves += g.wave - 1;
    var res = E.summary(g);
    assert.ok(res.acc >= 0 && res.acc <= 100);
  });
  assert.ok(totals.score > 3000, 'score ' + totals.score);
  assert.ok(totals.waves >= 1, 'cleared a wave');
  assert.ok(totals.ev.kill > 30 && totals.ev.skitterIn > 0, JSON.stringify(totals.ev));
});

test('save: normalise defensively, table sorted and capped, records', function () {
  var s = E.newSave();
  var o = E.record(s, { score: 5000, wave: 3, diff: 'normal', segs: 40 }, '', '2026-10-31');
  assert.deepStrictEqual(o, { rank: 1, best: true });
  o = E.record(s, { score: 7000, wave: 4, diff: 'hard', segs: 50 }, 'P2', '2026-10-31');
  assert.strictEqual(o.rank, 1);
  o = E.record(s, { score: 100, wave: 1, diff: 'normal', segs: 1 }, '', '2026-10-31');
  assert.deepStrictEqual(o, { rank: 3, best: false });
  assert.strictEqual(s.games, 3); assert.strictEqual(s.segs, 91); assert.strictEqual(s.wave, 4);
  for (var i = 0; i < 12; i++) E.record(s, { score: 10000 + i, wave: 2, diff: 'easy', segs: 0 }, '', '');
  assert.strictEqual(s.table.length, E.TABLE_N);
  assert.strictEqual(s.table[0].s, 10011);
  assert.strictEqual(E.record(s, { score: 1, wave: 1, diff: 'easy', segs: 0 }).rank, 0);
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({ diff: 'insane', players: 7, auto: 'yes', best: { easy: -4, normal: 'x' }, table: [null, { s: 5, d: 'nope' }, { s: 9, d: 'hard', w: -1, t: 5 }, { s: 99, d: 'easy', w: 3 }], games: NaN });
  assert.strictEqual(bad.diff, 'normal'); assert.strictEqual(bad.players, 1); assert.strictEqual(bad.auto, true);
  assert.strictEqual(bad.best.easy, 0); assert.strictEqual(bad.best.normal, 0);
  assert.deepStrictEqual(bad.table.map(function (e) { return e.s; }), [99, 9]);
  assert.strictEqual(bad.table[1].w, 1); assert.strictEqual(bad.table[1].t, '');
  assert.strictEqual(bad.games, 0);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('the body traces the head even when a mushroom appears behind the head', function () {
  var g = bare();
  E.addBug(g, 6, 2, 1, 4);
  var b = g.bugs[0];
  b.segs.forEach(function (s, i) { s.c = 8 - i; s.pc = s.c - 1; s.r = s.pr = 4; s.d = 1; s.x = s.pc; s.y = 4; });
  b.v = 8;
  g.m[E.idx(6, 4)] = 4;                     // right in front of the third segment, behind the head
  for (var i = 0; i < 400; i++) {
    E.stepBugs(g, E.STEP);
    var segs = g.bugs[0].segs;
    for (var j = 1; j < segs.length; j++) {
      var a = segs[j - 1], c = segs[j];
      assert.strictEqual(Math.abs(a.pc - c.c) + Math.abs(a.pr - c.r), 0, 'segment ' + j + ' heads for the cell its leader left');
    }
  }
});

test('a bug that hits a poisoned mushroom dives, the whole body follows down the same column', function () {
  var g = bare();
  E.addBug(g, 4, 2, 1, 3);
  var b = g.bugs[0];
  b.segs.forEach(function (s, i) { s.c = s.pc = 5 - i; s.r = s.pr = 3; s.d = 1; s.x = s.c; s.y = 3; });
  g.m[E.idx(6, 3)] = 4; g.pz[E.idx(6, 3)] = 1;
  var cols = {};
  for (var i = 0; i < 120 * 5; i++) {
    E.stepBugs(g, E.STEP);
    g.bugs[0].segs.forEach(function (s) { if (s.r > 4 && s.r < E.ZONE_TOP) cols[s.c] = 1; });
  }
  assert.deepStrictEqual(Object.keys(cols), ['5'], 'all dived in column 5');
  assert.ok(g.bottom);
});

test('a split tail turns at the mushroom left by the shot segment', function () {
  var g = bare();
  E.addBug(g, 6, 10, 1, 5);
  var b = g.bugs[0];
  b.segs.forEach(function (s, i) { s.c = s.pc = 10 - i; s.r = s.pr = 5; s.d = 1; s.x = s.c; s.y = 5; });
  b.t = 0;
  E.hitSeg(g, 0, 2);
  var tail = g.bugs[1];
  assert.strictEqual(tail.segs.length, 3);
  for (var i = 0; i < 40; i++) E.stepBugs(g, E.STEP);   // ~1 cell
  assert.ok(g.bugs[1].segs[0].r === 6, 'the new head dropped a row instead of walking into the mushroom');
  assert.strictEqual(g.m[E.idx(8, 5)], E.MUSH_HP);
});

test('the wave ends only when the last segment goes; a wave never starts empty', function () {
  for (var w = 1; w <= 12; w++) {
    var g = E.newGame(w); g.wave = w; E.spawnWave(g);
    assert.strictEqual(E.segCount(g), E.BUG_LEN);
    g.bugs.forEach(function (bb) { assert.ok(bb.segs.length > 0); });
  }
});

test('respawn after losing a life keeps the player start clear of mushrooms', function () {
  var g = bare();
  for (var c = 0; c < C; c++) for (var r = R - 2; r < R; r++) g.m[E.idx(c, r)] = 4;
  E.addBug(g, 3, 10, 1, 2);
  g.phase = 'down';
  E.respawn(g);
  assert.ok(!E.caught(g));
  var x0 = g.p.x;
  for (var i = 0; i < 10; i++) E.movePlayer(g, { ax: 1 }, E.STEP);
  assert.ok(g.p.x > x0, 'can move a little');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
