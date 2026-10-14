/* Unit tests for the Score Keeper's DOM-free model (scores, count modes, steps,
 * undo history, rounds, standings table, layout, normalization of saved data).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/scorekeeper/scorekeeper.test.js */
'use strict';
var assert = require('assert');
var M = require('./scorekeeper.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function scores(g) { return g.players.map(function (p) { return p.score; }); }
function game(n, o) {
  var g = M.create();
  while (g.players.length < n) M.addPlayer(g);
  while (g.players.length > n) M.removePlayer(g);
  if (o) Object.keys(o).forEach(function (k) { g[k] = o[k]; });
  return g;
}
var T = 1e12; // a wall-clock "now"; separate actions are > 1.5 s apart

test('create: two players, count up, steps 1 / 5', function () {
  var g = M.create();
  assert.strictEqual(g.players.length, 2);
  assert.deepStrictEqual(scores(g), [0, 0]);
  assert.strictEqual(g.mode, 'up'); assert.strictEqual(g.step, 1); assert.strictEqual(g.big, 5);
  assert.deepStrictEqual(g.players.map(function (p) { return p.id; }), ['p1', 'p2']);
  assert.deepStrictEqual(g.players.map(function (p) { return p.color; }), [0, 1]);
  assert.strictEqual(M.displayName(g, 1), 'Player 2');
  assert.ok(M.pristine(g));
});
test('players: 1 … 8, ids and colours stay unique, removal drops that player\'s history', function () {
  var g = game(8);
  assert.strictEqual(M.addPlayer(g), null, 'max 8');
  var ids = g.players.map(function (p) { return p.id; }), cols = g.players.map(function (p) { return p.color; });
  assert.strictEqual(new Set(ids).size, 8); assert.strictEqual(new Set(cols).size, 8);
  M.add(g, 7, 5, T);
  M.add(g, 0, 2, T + 5000);
  M.removePlayer(g);
  assert.strictEqual(g.players.length, 7);
  assert.strictEqual(g.hist.length, 1);
  assert.strictEqual(g.hist[0].id, 'p1');
  while (g.players.length > 1) M.removePlayer(g);
  assert.strictEqual(M.removePlayer(g), null, 'at least one player');
  var p = M.addPlayer(g);
  assert.strictEqual(p.id, 'p2', 'the smallest free id');
  assert.strictEqual(p.color, 1, 'the first free colour');
});
test('count up: steps, big steps, decimals without float noise', function () {
  var g = game(3);
  M.add(g, 0, g.step, T);
  M.add(g, 0, g.big, T + 100);
  M.add(g, 1, -g.step, T + 200);
  assert.deepStrictEqual(scores(g), [6, -1, 0]);
  g.step = M.stepVal('0.1', 1);
  for (var i = 0; i < 3; i++) M.add(g, 2, g.step, T + 10000 * (i + 1));
  assert.strictEqual(g.players[2].score, 0.3, '0.1 + 0.1 + 0.1 is 0.3 here');
  assert.strictEqual(M.fmt(g.players[2].score), '0.3');
  assert.strictEqual(M.add(g, 0, 0, T), 0, 'a zero step does nothing');
  assert.strictEqual(M.add(g, 9, 1, T), 0, 'no such player');
});
test('stepVal: any positive number; junk → the default', function () {
  assert.strictEqual(M.stepVal(5, 1), 5);
  assert.strictEqual(M.stepVal('25', 1), 25);
  assert.strictEqual(M.stepVal(-10, 1), 10, 'the sign comes from the tap, not the step');
  assert.strictEqual(M.stepVal(0.25, 1), 0.25);
  [0, '', 'x', NaN, Infinity, null, undefined, {}, 1e9].forEach(function (j) { assert.strictEqual(M.stepVal(j, 7), 7, String(j)); });
});
test('count down from M: starts at M, marks anyone at / below 0, no leader star', function () {
  var g = game(3);
  M.newGame(g, T, 'down', 20);
  assert.strictEqual(g.mode, 'down');
  assert.deepStrictEqual(scores(g), [20, 20, 20]);
  assert.strictEqual(g.hist.length, 0, 'switching a pristine game needs no undo entry');
  M.add(g, 0, -20, T);
  M.add(g, 1, -25, T + 5000);
  M.add(g, 2, -3, T + 10000);
  assert.deepStrictEqual(M.outs(g), [0, 1]);
  assert.deepStrictEqual(M.leaders(g), []);
  var p = M.addPlayer(g);
  assert.strictEqual(p.score, 20, 'a new player joins at the start value');
});
test('leader: highest or lowest; ties share it; nobody while everyone is level', function () {
  var g = game(4);
  assert.deepStrictEqual(M.leaders(g), [], 'all level');
  M.add(g, 1, 7, T); M.add(g, 3, 7, T + 5000); M.add(g, 0, 2, T + 10000);
  assert.deepStrictEqual(M.leaders(g), [1, 3]);
  g.high = false;
  assert.deepStrictEqual(M.leaders(g), [2], 'golf / hearts: lowest leads');
  assert.deepStrictEqual(M.leaders(game(1)), [], 'one player: no leader');
  assert.deepStrictEqual(M.outs(g), [], 'count up: nobody is out');
});
test('undo: per action; a burst on one tile (< 1.5 s apart) is one action', function () {
  var g = game(2);
  M.add(g, 0, 1, T);
  M.add(g, 0, 1, T + 400);
  M.add(g, 0, 1, T + 800);
  M.add(g, 0, 5, T + 2200);                       // 1.4 s after the last tap: still the same burst
  assert.strictEqual(g.hist.length, 1);
  assert.strictEqual(g.hist[0].d, 8);
  M.add(g, 0, 1, T + 3800);                       // 1.6 s later: a new action
  M.add(g, 1, 1, T + 3900);                       // another player: a new action
  M.add(g, 0, 1, T + 4000);                       // back to player 1: a new action (not adjacent)
  assert.strictEqual(g.hist.length, 4);
  assert.deepStrictEqual(scores(g), [10, 1]);
  assert.strictEqual(M.undo(g).d, 1); assert.deepStrictEqual(scores(g), [9, 1]);
  assert.strictEqual(M.undo(g).id, 'p2'); assert.deepStrictEqual(scores(g), [9, 0]);
  M.undo(g); assert.deepStrictEqual(scores(g), [8, 0]);
  M.undo(g); assert.deepStrictEqual(scores(g), [0, 0]);
  assert.strictEqual(M.undo(g), null, 'nothing left');
  // +1 then −1 inside one burst cancels out: no entry at all
  M.add(g, 1, 1, T); M.add(g, 1, -1, T + 300);
  assert.strictEqual(g.hist.length, 0);
});
test('rounds: next round is an undoable action', function () {
  var g = game(2, { rounds: true });
  M.add(g, 0, 3, T);
  M.nextRound(g, T + 5000);
  M.add(g, 0, 2, T + 6000);
  assert.strictEqual(g.round, 2);
  M.undo(g); M.undo(g);
  assert.strictEqual(g.round, 1);
  assert.deepStrictEqual(scores(g), [3, 0]);
  M.undo(g);
  assert.strictEqual(g.round, 1, 'never below 1');
});
test('new game with the same players: scores back to the start, undoable (mode switch too)', function () {
  var g = game(3);
  g.players[0].name = 'Ann';
  M.add(g, 0, 12, T); M.add(g, 2, 4, T + 5000); M.nextRound(g, T + 6000); M.nextRound(g, T + 7000);
  assert.ok(!M.pristine(g));
  assert.strictEqual(M.newGame(g, T + 8000), true);
  assert.deepStrictEqual(scores(g), [0, 0, 0]);
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.players[0].name, 'Ann', 'same players');
  assert.strictEqual(M.newGame(g, T + 9000), false, 'already fresh');
  M.undo(g);
  assert.deepStrictEqual(scores(g), [12, 0, 4]);
  assert.strictEqual(g.round, 3);
  // switching to count-down mid-game is a new game too, and Undo restores mode + scores
  assert.strictEqual(M.newGame(g, T + 10000, 'down', 40), true);
  assert.deepStrictEqual(scores(g), [40, 40, 40]);
  M.add(g, 1, -7, T + 20000);
  M.undo(g); M.undo(g);
  assert.strictEqual(g.mode, 'up'); assert.strictEqual(g.start, 20);
  assert.deepStrictEqual(scores(g), [12, 0, 4]);
});
test('reset: two fresh players, history cleared, scoring settings kept', function () {
  var g = game(5, { step: 10, big: 50, rounds: true });
  M.newGame(g, T, 'down', 501);
  M.add(g, 4, -60, T); M.nextRound(g, T + 5000);
  M.reset(g);
  assert.strictEqual(g.players.length, 2);
  assert.deepStrictEqual(scores(g), [501, 501]);
  assert.strictEqual(g.hist.length, 0); assert.strictEqual(g.round, 1);
  assert.strictEqual(g.step, 10); assert.strictEqual(g.big, 50); assert.strictEqual(g.mode, 'down'); assert.ok(g.rounds);
});
test('rename: trimmed, one line, 24 chars max, the default name stays default', function () {
  var g = game(2);
  M.rename(g, 0, '  Ann \n Lee\t ');
  assert.strictEqual(g.players[0].name, 'Ann Lee');
  M.rename(g, 1, 'x'.repeat(40));
  assert.strictEqual(g.players[1].name.length, 24);
  M.rename(g, 1, 'Player 2');
  assert.strictEqual(g.players[1].name, '');
  assert.strictEqual(M.displayName(g, 1), 'Player 2');
  M.rename(g, 0, '   ');
  assert.strictEqual(M.displayName(g, 0), 'Player 1');
});
test('scores are clamped and never -0', function () {
  var g = game(1);
  M.add(g, 0, 5e9, T);
  assert.strictEqual(g.players[0].score, 1e9);
  assert.strictEqual(M.add(g, 0, 5, T + 1), 0, 'already at the cap: no change, no history');
  M.undo(g);
  assert.strictEqual(g.players[0].score, 0);
  assert.ok(!Object.is(g.players[0].score, -0));
  assert.strictEqual(M.fmt(-0), '0');
  assert.strictEqual(M.fmt(-12.5), '-12.5');
  assert.strictEqual(M.fmt(1 / 3), '0.333');
});
test('markdown: standings table, ranked, ties share a rank, aligned, pipes escaped', function () {
  var g = game(4);
  M.rename(g, 0, 'Ann');
  M.rename(g, 1, 'Bo|b');
  M.add(g, 0, 18, T); M.add(g, 1, 25, T + 5000); M.add(g, 2, 18, T + 10000); M.add(g, 3, -2, T + 15000);
  var md = M.markdown(g);
  assert.strictEqual(md, [
    '|   # | Player   | Score |',
    '|----:|:---------|------:|',
    '|   1 | Bo\\|b    |    25 |',
    '|   2 | Ann      |    18 |',
    '|   2 | Player 3 |    18 |',
    '|   4 | Player 4 |    -2 |',
  ].join('\n'));
  md.split('\n').forEach(function (l) { assert.strictEqual(l.length, md.split('\n')[0].length, 'aligned: ' + l); });
  g.high = false; g.rounds = true; g.round = 3;
  var lines = M.markdown(g).split('\n');
  assert.ok(/\| Score \(round 3\) \|$/.test(lines[0]), lines[0]);
  assert.ok(/^\|   1 \| Player 4 /.test(lines[2]), 'lowest first: ' + lines[2]);
  assert.strictEqual(M.markdown(game(1)).split('\n').length, 3, 'one player: header, rule, one row');
});
test('layout: halves, quadrants, 2×3, 2×4 (turned when wide)', function () {
  var L = M.layout;
  assert.deepStrictEqual(L(1, false), [1]);
  assert.deepStrictEqual(L(2, false), [1, 1]); assert.deepStrictEqual(L(2, true), [2]);
  assert.deepStrictEqual(L(3, false), [2, 1]); assert.deepStrictEqual(L(4, true), [2, 2]);
  assert.deepStrictEqual(L(5, false), [2, 2, 1]); assert.deepStrictEqual(L(5, true), [3, 2]);
  assert.deepStrictEqual(L(6, false), [2, 2, 2]); assert.deepStrictEqual(L(6, true), [3, 3]);
  assert.deepStrictEqual(L(7, false), [2, 2, 2, 1]); assert.deepStrictEqual(L(7, true), [4, 3]);
  assert.deepStrictEqual(L(8, false), [2, 2, 2, 2]); assert.deepStrictEqual(L(8, true), [4, 4]);
  for (var n = 1; n <= 8; n++) [false, true].forEach(function (land) {
    assert.strictEqual(L(n, land).reduce(function (a, b) { return a + b; }, 0), n);
  });
  assert.deepStrictEqual(L(0, false), [1]); assert.deepStrictEqual(L(99, false), [2, 2, 2, 2]);
});
test('normalize: a saved game round-trips through JSON', function () {
  var g = game(5, { step: 2.5, big: 25, rounds: true, high: false });
  M.newGame(g, T, 'down', 101);
  M.rename(g, 2, 'Cleo');
  g.players[3].rot = 180;
  M.add(g, 1, -10, T); M.nextRound(g, T + 5000); M.add(g, 1, 5, T + 6000);
  M.add(g, 0, 7, T + 9000); M.newGame(g, T + 12000); M.add(g, 4, -1, T + 15000);
  var back = M.normalize(JSON.parse(JSON.stringify(g)));
  assert.deepStrictEqual(back, g);
  M.undo(back); M.undo(back);
  assert.deepStrictEqual(scores(back), [108, 96, 101, 101, 101]);
  assert.strictEqual(back.round, 2);
});
test('normalize: junk saved data → a valid game', function () {
  [null, undefined, 0, 'x', [], [1, 2], { players: 'no' }, { players: [] }, { players: [null, 5, 'a'] }].forEach(function (j, k) {
    var g = M.normalize(j);
    assert.strictEqual(g.players.length, 2, 'junk #' + k);
    assert.deepStrictEqual(scores(g), [0, 0]);
    assert.strictEqual(g.mode, 'up');
  });
  var raw = {
    mode: 'sideways', start: 'abc', step: -0, big: 'huge', high: 'yes', rounds: 1, round: -7,
    players: [
      { id: 'p1', name: 42, color: 99, rot: 90, score: 'NaN' },
      { id: 'p1', name: 'Dup', color: 2, rot: 180, score: '7' },             // duplicate id → fresh id
      { id: '<script>', name: 'Bad id\u0000\n', color: 1.6, score: Infinity },
      { name: 'No id', score: 3e12 },
      {}, {}, {}, {}, {}, {},                                                // more than 8
    ],
    hist: [
      { k: 's', id: 'p1', d: 3, t: 1 }, { k: 's', id: 'ghost', d: 3, t: 1 }, { k: 's', id: 'p1', d: 0, t: 1 },
      { k: 's', id: 'p1', d: 'x', t: 1 }, { k: 'r' }, { k: 'r', t: 5 }, { k: 'zap', t: 1 }, null, 7,
      { k: 'n', t: 9, prev: { s: { p1: 4, ghost: 1, p2: 'q' }, round: 0, mode: 'down', start: 30 } },
      { k: 'n', t: 9, prev: { s: {}, round: 1, mode: 'diagonal', start: 1 } },
    ],
  };
  var g = M.normalize(raw);
  assert.strictEqual(g.mode, 'up');
  assert.strictEqual(g.start, 20);
  assert.strictEqual(g.step, 1);
  assert.strictEqual(g.big, 5);
  assert.strictEqual(g.high, true);
  assert.strictEqual(g.rounds, false, 'only a real true');
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.players.length, 8);
  var ids = g.players.map(function (p) { return p.id; });
  assert.strictEqual(new Set(ids).size, 8, 'unique ids: ' + ids);
  assert.strictEqual(g.players[0].name, '42');
  assert.strictEqual(g.players[0].rot, 0);
  assert.ok(g.players[0].color >= 0 && g.players[0].color < 8);
  assert.strictEqual(g.players[0].score, 0);
  assert.strictEqual(g.players[1].score, 7); assert.strictEqual(g.players[1].rot, 180); assert.strictEqual(g.players[1].name, 'Dup');
  assert.notStrictEqual(g.players[1].id, 'p1');
  assert.strictEqual(g.players[2].name, 'Bad id'); assert.strictEqual(g.players[2].color, 2); assert.strictEqual(g.players[2].score, 0);
  assert.strictEqual(g.players[3].score, 1e9, 'clamped');
  g.players.forEach(function (p) { assert.ok(typeof p.score === 'number' && isFinite(p.score)); });
  assert.deepStrictEqual(g.hist.map(function (e) { return e.k; }), ['s', 'r', 'n']);
  assert.deepStrictEqual(g.hist[2].prev, { s: { p1: 4 }, round: 1, mode: 'down', start: 30 });
  // whatever came in, the model works on it
  M.add(g, 7, 1, T); M.undo(g); M.undo(g); M.undo(g); M.undo(g);
  assert.strictEqual(g.mode, 'down');
  assert.strictEqual(M.undo(g), null);
  assert.ok(M.markdown(g).split('\n').length === 10);
  var big = { players: [{ id: 'a', score: 1 }], hist: [] };
  for (var i = 0; i < 1000; i++) big.hist.push({ k: 's', id: 'a', d: 1, t: i });
  assert.strictEqual(M.normalize(big).hist.length, M.MAX_HIST, 'history capped');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
