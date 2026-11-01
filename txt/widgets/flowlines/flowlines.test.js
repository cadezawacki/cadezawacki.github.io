/* Headless checks for the Flow Lines engine (generator, solver, drawing rules, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/flowlines/flowlines.test.js */
'use strict';
var assert = require('assert');

var E = require('./flowlines.js');
// …and the widget registers itself when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./flowlines.js')];
require('./flowlines.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// a tiny hand-made puzzle (3 colours on 5x5 would be too small: build a custom one)
//   A A A B B
//   C C A B B ... built from explicit solution paths
function mk(n, sol) {
  return { n: n, seed: 0, pairs: sol.map(function (s) { return { a: s[0], b: s[s.length - 1] }; }), sol: sol };
}
// 5x5: rows are paths A (row 0), B (row 1), C (rows 2-4 snake)
var P5 = mk(5, [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14, 19, 18, 17, 16, 15, 20, 21, 22, 23, 24]
]);
function drag(g, cells) {
  assert.ok(E.beginDrag(g, cells[0]), 'begin at ' + cells[0]);
  for (var i = 1; i < cells.length; i++) E.dragToward(g, cells[i]);
  return E.endDrag(g);
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Flow Lines' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'flowlines.css');
  assert.strictEqual(widget._engine.PACK_LEN, E.PACK_LEN);
});

test('rng / hash are deterministic', function () {
  var a = E.rng(42), b = E.rng(42);
  for (var i = 0; i < 20; i++) assert.strictEqual(a(), b());
  assert.strictEqual(E.hash2(5, 7), E.hash2(5, 7));
  assert.notStrictEqual(E.hash2(5, 7), E.hash2(7, 5));
});

test('Hamiltonian paths visit every cell once along grid edges', function () {
  [5, 7, 10].forEach(function (n) {
    var p = E.hamPath(n, E.rng(n * 3));
    assert.strictEqual(p.length, n * n);
    assert.strictEqual(new Set(p).size, n * n);
    for (var i = 1; i < p.length; i++) assert.ok(E.adj(n, p[i - 1], p[i]));
  });
});

test('generated puzzles are valid full-fill puzzles, every size, and deterministic', function () {
  E.SIZES.forEach(function (n) {
    var rg = E.colourRange(n);
    for (var l = 1; l <= 8; l++) {
      var p = E.genPuzzle(n, E.packSeed(n, l));
      assert.strictEqual(p.n, n);
      assert.ok(E.checkSolution(p, p.sol), n + 'x' + n + ' #' + l + ' solution');
      assert.ok(p.pairs.length >= 2 && p.pairs.length <= E.MAX_COL);
      assert.ok(p.pairs.length >= rg[0] - 1 && p.pairs.length <= rg[1] + 1, 'colour count ' + p.pairs.length);
      p.sol.forEach(function (s) { assert.ok(s.length >= 3, 'no trivial pairs'); });
      p.pairs.forEach(function (q) { assert.notStrictEqual(q.a, q.b); });
      var q = E.genPuzzle(n, E.packSeed(n, l));
      assert.deepStrictEqual(q.pairs, p.pairs);
    }
  });
  assert.notDeepStrictEqual(E.genPuzzle(6, 1).pairs, E.genPuzzle(6, 2).pairs);
});

test('the solver confirms uniqueness and finds ambiguity', function () {
  var p = E.genPuzzle(6, E.packSeed(6, 3));
  assert.strictEqual(E.countSolutions(p, 2, 1e6), p.unique ? 1 : 2);
  // two pairs on an open 5x5: many ways to share the middle
  var amb = { n: 5, pairs: [{ a: 0, b: 3 }, { a: 20, b: 24 }] };
  assert.strictEqual(E.countSolutions(amb, 2, 1e6), 2);
  assert.strictEqual(E.countSolutions(P5, 2, 1e6), 2, "the snake can wind either way");
  var none = { n: 5, pairs: [{ a: 0, b: 24 }, { a: 4, b: 20 }] };       // crossing diagonals: impossible
  assert.strictEqual(E.countSolutions(none, 2, 1e6), 0);
});

test('most pack puzzles are proven unique', function () {
  var u = 0, t = 0;
  [5, 7, 9].forEach(function (n) { for (var l = 1; l <= 5; l++) { t++; if (E.genPuzzle(n, E.packSeed(n, l)).unique) u++; } });
  assert.ok(u >= t - 2, u + '/' + t);
});

test('drawing a path from a dot to its partner joins it', function () {
  var g = E.newGame(P5);
  var r = drag(g, [0, 4]);
  assert.ok(r.changed && r.done && E.isDone(g, 0));
  assert.deepStrictEqual(g.paths[0], [0, 1, 2, 3, 4]);
  assert.strictEqual(g.moves, 1);
  assert.ok(g.ev.some(function (e) { return e.t === 'join' && e.c === 0; }));
});

test('paths cannot enter another colour\'s dot and stop at their partner', function () {
  var g = E.newGame(P5);
  E.beginDrag(g, 0);
  assert.strictEqual(E.stepTo(g, 5), 'block', 'B dot');
  assert.strictEqual(E.stepTo(g, 1), 'ok');
  assert.strictEqual(E.stepTo(g, 3), 'block', 'not adjacent');
  E.dragToward(g, 4);
  assert.strictEqual(E.stepTo(g, 9), 'block', 'joined: only back up');
  assert.strictEqual(E.stepTo(g, 3), 'back');
  assert.deepStrictEqual(g.paths[0], [0, 1, 2, 3]);
  E.endDrag(g);
});

test('crossing a path cuts it, and backing up during the drag restores it', function () {
  var g = E.newGame(P5);
  drag(g, [10, 14]);                         // C runs along row 2
  assert.deepStrictEqual(g.paths[2], [10, 11, 12, 13, 14]);
  E.beginDrag(g, 5);                         // B goes down into row 2 at col 1
  E.stepTo(g, 6);
  E.stepTo(g, 11);
  assert.strictEqual(g.paths[2].length, 0, 'a one-cell stub is cleared');
  E.stepTo(g, 6);                            // back up: C comes back
  assert.deepStrictEqual(g.paths[2], [10, 11, 12, 13, 14]);
  E.stepTo(g, 7); E.stepTo(g, 12);
  assert.deepStrictEqual(g.paths[2], [10, 11]);
  E.endDrag(g);                              // the cut becomes permanent
  assert.deepStrictEqual(g.paths[2], [10, 11]);
  assert.strictEqual(g.moves, 2);
});

test('grabbing the middle of a path truncates it there; a dot restarts it', function () {
  var g = E.newGame(P5);
  drag(g, [0, 4]);
  E.beginDrag(g, 2);
  assert.deepStrictEqual(g.paths[0], [0, 1, 2]);
  E.endDrag(g);
  assert.deepStrictEqual(g.paths[0], [0, 1, 2]);
  drag(g, [0, 4]);
  E.beginDrag(g, 4);                         // the other dot: restart from it
  assert.deepStrictEqual(g.paths[0], []);
  E.dragToward(g, 2);
  assert.deepStrictEqual(g.paths[0], [4, 3, 2]);
  E.endDrag(g);
  assert.ok(!E.beginDrag(g, 12), 'empty cells cannot start a drag');
});

test('moves count colour changes only; undo and restart', function () {
  var g = E.newGame(P5);
  drag(g, [0, 2]);
  drag(g, [2, 4]);                           // continuing the same colour: no new move
  assert.strictEqual(g.moves, 1);
  drag(g, [5, 9]);
  assert.strictEqual(g.moves, 2);
  assert.ok(E.undo(g));
  assert.strictEqual(g.moves, 1);
  assert.deepStrictEqual(g.paths[1], []);
  assert.ok(E.restart(g));
  assert.ok(g.paths.every(function (p) { return !p.length; }));
  assert.ok(!E.restart(g), 'nothing to clear');
  assert.ok(E.undo(g));
  assert.deepStrictEqual(g.paths[0], [0, 1, 2, 3, 4]);
});

test('the win needs every pair joined AND every cell filled', function () {
  var g = E.newGame(P5);
  drag(g, [0, 4]); drag(g, [5, 9]);
  drag(g, [10, 11, 16, 21, 22, 23, 24]);
  var st = E.status(g);
  assert.strictEqual(st.done, 3);
  assert.ok(!st.won && !g.won, 'joined but not filled');
  drag(g, [10, 14, 19, 15, 20, 24]);
  st = E.status(g);
  assert.ok(st.won && g.won && st.pct === 100);
  assert.ok(g.ev.some(function (e) { return e.t === 'win'; }));
  assert.ok(!E.beginDrag(g, 0), 'a solved board is frozen');
  assert.strictEqual(g.moves, 3);
  assert.strictEqual(E.starsFor(g.moves, 3, 0), 3);
});

test('playing the generated solution wins in a perfect number of moves', function () {
  E.SIZES.forEach(function (n) {
    var p = E.genPuzzle(n, E.packSeed(n, 2)), g = E.newGame(p);
    p.sol.forEach(function (s) { drag(g, s); });
    assert.ok(g.won, n + 'x' + n);
    assert.strictEqual(g.moves, p.pairs.length);
    assert.strictEqual(E.starsFor(g.moves, p.pairs.length, 0), 3);
  });
});

test('hints reveal solution paths and eventually solve the puzzle', function () {
  var p = E.genPuzzle(7, E.packSeed(7, 4)), g = E.newGame(p);
  drag(g, [p.pairs[1].a, p.pairs[1].a]);
  var used = 0;
  while (!g.won && used < 40) { assert.ok(E.hint(g) >= 0); used++; }
  assert.ok(g.won);
  assert.ok(used <= p.pairs.length);
  assert.strictEqual(g.hints, used);
  assert.strictEqual(E.hint(g), -1);
  assert.strictEqual(E.starsFor(g.moves, p.pairs.length, g.hints), 1);
  // a hint crossing a wrong path cuts it
  var g2 = E.newGame(P5);
  drag(g2, [5, 6, 11, 12, 7, 8, 9]);          // B dips into C's row
  E.hint(g2); E.hint(g2);
  assert.deepStrictEqual(g2.paths[1], [5, 6, 7, 8, 9]);
  E.hint(g2);
  assert.ok(g2.won);
  assert.ok(E.undo(g2) && !g2.won);
});

test('in-progress snapshots round-trip and reject bad paths', function () {
  var g = E.newGame(P5);
  drag(g, [0, 4]); drag(g, [10, 12]);
  var snap = JSON.parse(JSON.stringify(E.serialize(g)));
  var h = E.newGame(P5);
  assert.ok(E.restore(h, snap));
  assert.deepStrictEqual(h.paths, g.paths);
  assert.strictEqual(h.moves, 2);
  var bad = E.newGame(P5);
  assert.ok(!E.restore(bad, { paths: [[0, 2, 4], [5, 6, 0], [10, 'x']] }));
  assert.ok(bad.paths.every(function (p) { return !p.length; }));
  assert.ok(!E.restore(bad, null));
  var overlap = E.newGame(P5);
  E.restore(overlap, { paths: [[0, 1], [5, 6], [10, 11, 6]] });
  assert.deepStrictEqual(overlap.paths[2], [], 'overlapping paths are dropped');
});

test('ids, packs and the daily puzzle', function () {
  var s = E.specOf('p7-12');
  assert.ok(s.kind === 'p' && s.n === 7 && s.lvl === 12 && s.seed === E.packSeed(7, 12));
  assert.strictEqual(E.specOf('p4-1'), null);
  assert.strictEqual(E.specOf('p5-31'), null);
  assert.strictEqual(E.specOf('nope'), null);
  var d = E.specOf('d2026-10-31');
  assert.ok(d.kind === 'd' && d.n >= 5 && d.n <= 10 && d.day === '2026-10-31');
  assert.deepStrictEqual(E.dailySpec('2026-10-31'), E.dailySpec('2026-10-31'));
  assert.notStrictEqual(E.dailySpec('2026-10-31').seed, E.dailySpec('2026-11-01').seed);
  assert.strictEqual(E.dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.ok(E.checkSolution(E.puzzleFor('d2026-10-31'), E.puzzleFor('d2026-10-31').sol));
});

test('records, stars, unlocking, next level and streaks', function () {
  var sv = E.newSave();
  assert.ok(E.isOpen(sv, 5, 1) && E.isOpen(sv, 5, 3) && !E.isOpen(sv, 5, 4));
  var r = E.record(sv, 'p5-1', 6, 6, 0, 30);
  assert.ok(r.first && r.best && r.rec.s === 3 && sv.solved === 1 && sv.perfect === 1);
  assert.ok(E.isOpen(sv, 5, 4) && !E.isOpen(sv, 5, 5));
  r = E.record(sv, 'p5-1', 9, 6, 0, 20);
  assert.ok(!r.first && !r.best && sv.lv['p5-1'].m === 6 && sv.lv['p5-1'].t === 20 && sv.solved === 1);
  assert.strictEqual(E.nextLevel(sv, 'p5-1'), 'p5-2');
  assert.strictEqual(E.packCount(sv, 5).solved, 1);
  assert.strictEqual(E.starsFor(7, 6, 0), 2);
  assert.strictEqual(E.starsFor(20, 6, 0), 1);
  E.record(sv, 'd2026-10-30', 9, 8, 1, 50);
  E.record(sv, 'd2026-10-29', 8, 8, 0, 50);
  assert.strictEqual(E.streak(sv, '2026-10-31'), 2, 'today still open');
  E.record(sv, 'd2026-10-31', 8, 8, 0, 50);
  assert.strictEqual(E.streak(sv, '2026-10-31'), 3);
  assert.strictEqual(sv.daily['2026-10-30'].s, 1, 'hinted');
  for (var l = 1; l <= E.PACK_LEN; l++) sv.lv['p6-' + l] = { m: 9, s: 1, t: 0 };
  assert.strictEqual(E.nextLevel(sv, 'p6-' + E.PACK_LEN), 'p7-1');
});

test('save normalisation is defensive', function () {
  var sv = E.newSave();
  E.record(sv, 'p8-3', 12, 10, 0, 99);
  sv.cur = 'p8-4'; sv.prog = { id: 'p8-4', paths: [[1, 2]], moves: 3, last: 0, hints: 0, t: 12 };
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(sv))), sv);
  var bad = E.normSave({ lv: { 'p8-3': { m: -1 }, 'zz': { m: 3 }, 'p5-2': { m: 4, s: 9, t: -3 } }, daily: { 'nope': { m: 2 } }, cur: 'p99-1', prog: { id: 'p5-1' }, solved: -4 });
  assert.deepStrictEqual(bad.lv, { 'p5-2': { m: 4, s: 3, t: 0 } });
  assert.deepStrictEqual(bad.daily, {});
  assert.ok(bad.cur === 'p5-1' && bad.prog === null && bad.solved === 0);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('every pack puzzle (6 packs x 30) is a valid full-fill puzzle with exactly one solution', function () {
  E.SIZES.forEach(function (n) {
    for (var l = 1; l <= E.PACK_LEN; l++) {
      var pz = E.puzzleFor('p' + n + '-' + l);
      assert.ok(E.checkSolution(pz, pz.sol), 'p' + n + '-' + l + ' solution');
      assert.ok(pz.unique, 'p' + n + '-' + l + ' unique');
      assert.ok(pz.pairs.length <= E.MAX_COL);
    }
  });
});

test('drag edge cases: own start dot backs up, no-op drags cost nothing, a dot ends a fast drag', function () {
  var g = E.newGame(P5);
  E.beginDrag(g, 0); E.dragToward(g, 2);
  assert.strictEqual(E.stepTo(g, 1), 'back');
  assert.strictEqual(E.dragToward(g, 0), 'back');
  assert.deepStrictEqual(g.drag.path, [0]);
  var r = E.endDrag(g);
  assert.ok(!r.changed && g.moves === 0 && g.undo.length === 0, 'tapping a dot is free');
  E.beginDrag(g, 10);
  var res = E.dragToward(g, 0);                // straight up: 5 is B's dot, so it stops at once
  assert.strictEqual(res, 'block');
  assert.deepStrictEqual(g.drag.path, [10]);
  E.cancelDrag(g);
  assert.ok(!g.drag && g.paths[2].length === 0);
  assert.strictEqual(E.dragToward(g, 3), 'block', 'no drag');
  assert.ok(!E.beginDrag(g, -1) && !E.beginDrag(g, 25));
});

test('a hint overwrites a wrong path and cuts what it crosses; undo restores it', function () {
  var g = E.newGame(P5);
  drag(g, [5, 6, 11, 12, 7, 8, 9]);            // B detours through C's row
  assert.ok(E.isDone(g, 1));
  drag(g, [10, 11]);                           // C walks into B's path at 11 and cuts it back to [5, 6]
  assert.deepStrictEqual(g.paths[1], [5, 6]);
  var before = JSON.stringify(g.paths);
  var c = E.hint(g);
  assert.strictEqual(c, 0, 'the first colour off the solution (A, still empty) goes first');
  c = E.hint(g);
  assert.strictEqual(c, 1, 'then B, whose stub differs from the solution');
  assert.deepStrictEqual(g.paths[1], [5, 6, 7, 8, 9]);
  g.paths.forEach(function (p, i) { if (i !== 1) p.forEach(function (x) { assert.ok([5, 6, 7, 8, 9].indexOf(x) < 0); }); });
  assert.strictEqual(g.hints, 2);
  E.undo(g); E.undo(g);
  assert.strictEqual(JSON.stringify(g.paths), before);
});

test('restore rejects overlapping and malformed paths but keeps the good ones', function () {
  var g = E.newGame(P5);
  var ok = E.restore(g, { paths: [[0, 1, 2], [5, 6, 1], [10, 11, 'x']], moves: 4, last: 7, hints: -2 });
  assert.ok(ok);
  assert.deepStrictEqual(g.paths, [[0, 1, 2], [], []]);
  assert.ok(g.moves === 4 && g.last === -1 && g.hints === 0 && !g.won);
  var g2 = E.newGame(P5);
  assert.ok(!E.restore(g2, { paths: [[1, 2]] }), 'must start on its own dot');
  assert.ok(!E.restore(g2, null) && !E.restore(g2, { paths: 'no' }));
  var g3 = E.newGame(P5);
  E.restore(g3, { paths: P5.sol });
  assert.ok(g3.won, 'a restored full solution counts as solved');
});

test('boards left unfinished are parked and picked up again', function () {
  var sv = E.newSave();
  sv.cur = 'p5-1'; sv.prog = { id: 'p5-1', paths: [[0, 1]], moves: 1, last: 0, hints: 0, t: 5 };
  E.stashProg(sv);
  assert.ok(sv.prog === null && sv.wip['p5-1'].moves === 1);
  sv.prog = { id: 'p5-2', paths: [[], []], moves: 0, last: -1, hints: 0, t: 0 };
  E.stashProg(sv);
  assert.ok(!sv.wip['p5-2'], 'empty boards are not parked');
  var p = E.takeProg(sv, 'p5-1');
  assert.ok(p && p.paths[0][1] === 1 && !sv.wip['p5-1']);
  assert.strictEqual(E.takeProg(sv, 'p5-1'), null);
  for (var l = 1; l <= 20; l++) { sv.prog = { id: 'p6-' + l, paths: [[1, 2]], moves: 1, last: 0, hints: 0, t: 0 }; E.stashProg(sv); }
  assert.ok(Object.keys(sv.wip).length <= 12 && sv.wip['p6-20'] && !sv.wip['p6-1'], 'oldest dropped');
  var n = E.normSave(JSON.parse(JSON.stringify(sv)));
  assert.deepStrictEqual(n.wip, sv.wip);
  var bad = E.normSave({ cur: 'p5-1', wip: { 'p5-1': { paths: [] }, 'zz': { paths: [] }, 'p5-3': { paths: 'x' }, 'p5-4': { paths: [[0, 1]], moves: -3 } } });
  assert.deepStrictEqual(Object.keys(bad.wip), ['p5-4']);
  assert.strictEqual(bad.wip['p5-4'].moves, 0);
});

test('generation stays fast enough for a phone', function () {
  var t = Date.now();
  for (var l = 1; l <= 4; l++) E.genPuzzle(10, E.packSeed(10, l));
  assert.ok((Date.now() - t) / 4 < 400, 'avg ' + (Date.now() - t) / 4 + ' ms');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
