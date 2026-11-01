/* Headless checks for the Checkers engine (rules, search, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/checkers/checkers.test.js */
'use strict';
var assert = require('assert');

var E = require('./checkers.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./checkers.js')];
require('./checkers.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// board from a map { square(1-based): piece }
function board(map) {
  var b = []; for (var i = 0; i < 32; i++) b.push(0);
  for (var k in map) b[k - 1] = map[k];
  return b;
}
function paths(moves) { return moves.map(function (m) { return m.path.map(function (s) { return s + 1; }).join('-'); }).sort(); }
var R = 1, RK = 2, W = -1, WK = -2;

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Checkers' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'checkers.css');
  assert.strictEqual(widget._engine.WIN, E.WIN);
});
test('geometry: 32 dark squares, standard numbering', function () {
  assert.deepStrictEqual([E.ROW[0], E.COL[0]], [0, 1]);
  assert.deepStrictEqual([E.ROW[4], E.COL[4]], [1, 0]);
  assert.deepStrictEqual([E.ROW[31], E.COL[31]], [7, 6]);
  for (var i = 0; i < 32; i++) assert.strictEqual(E.sqAt(E.ROW[i], E.COL[i]), i);
  assert.strictEqual(E.sqAt(0, 0), -1);
});
test('perft from the start (American): 7, 49, 302, 1469, 7361, 36768', function () {
  var b = E.initBoard(), want = [1, 7, 49, 302, 1469, 7361, 36768];
  for (var d = 0; d <= 6; d++) assert.strictEqual(E.perft(b, E.RED, 'american', d), want[d], 'depth ' + d);
  assert.deepStrictEqual(b, E.initBoard(), 'make/unmake restores the board');
});
test('opening moves are the seven standard ones', function () {
  var g = E.newGame('american');
  assert.deepStrictEqual(E.legal(g).map(E.notation).sort(), ['10-14', '10-15', '11-15', '11-16', '12-16', '9-13', '9-14'].sort());
});
test('captures are forced', function () {
  // Red man on 14, White man on 18 (14 jumps to 23); Red also has a quiet man on 1
  var b = board({ 14: R, 18: W, 1: R, 30: W });
  var ms = E.genMoves(b, R, 'american');
  assert.deepStrictEqual(paths(ms), ['14-23']);
  assert.deepStrictEqual(ms[0].caps, [17]);
});
test('men jump forward only (American); backward too with flying rules', function () {
  var b = board({ 18: R, 14: W, 5: W });
  assert.ok(E.genMoves(b, R, 'american').every(function (m) { return !m.caps.length; }));
  var f = E.genMoves(b, R, 'flying');
  assert.deepStrictEqual(paths(f), ['18-9']);
});
test('multi-jumps continue and offer route choice', function () {
  // Red man 1 jumps 6 -> 10, then from 10 either 15 -> 19 or 14 -> 17
  var b = board({ 1: R, 6: W, 15: W, 14: W, 32: W });
  var ms = E.genMoves(b, R, 'american');
  assert.deepStrictEqual(paths(ms), ['1-10-17', '1-10-19']);
  ms.forEach(function (m) { assert.strictEqual(m.caps.length, 2); });
});
test('American: no maximum-capture rule; flying: must take the most', function () {
  // Red man 1 can take one (1x10); Red man 4 can take two (4x11x20)
  var b = board({ 1: R, 6: W, 4: R, 8: W, 16: W, 32: W });
  var am = E.genMoves(b, R, 'american');
  var counts = am.map(function (m) { return m.caps.length; }).sort();
  assert.ok(counts[0] === 1 && counts[counts.length - 1] === 2, 'both short and long jumps allowed: ' + paths(am));
  var fl = E.genMoves(b, R, 'flying');
  assert.ok(fl.length && fl.every(function (m) { return m.caps.length === 2; }), 'flying keeps only the longest');
});
test('a man crowned by a jump stops there (American)', function () {
  // Red man 22 jumps 26 to 31 (row 7: crowned); a king on 31 could jump 27 next, a man may not
  var b = board({ 22: R, 26: W, 27: W, 5: W });
  var ms = E.genMoves(b, R, 'american');
  assert.deepStrictEqual(paths(ms), ['22-31']);
  var u = E.makeMove(b, ms[0]);
  assert.ok(u.promo && b[30] === RK && b[25] === 0);
  E.unmakeMove(b, ms[0], u);
  assert.ok(b[21] === R && b[25] === W && b[30] === 0);
});
test('kings move both ways one square (American), fly (flying)', function () {
  var b = board({ 18: RK, 1: W });
  assert.strictEqual(E.genMoves(b, R, 'american').length, 4);
  assert.strictEqual(E.genMoves(b, R, 'flying').length, 13);  // every square along the four diagonals from 18
  // flying king captures from afar and may land on any square beyond
  var c = board({ 29: RK, 11: W, 1: W });
  // 29 -> up-right diagonal: 25, 22, 18, 15, 11 (white), 8, 4
  var ms = E.genMoves(c, R, 'flying');
  assert.ok(ms.length >= 2 && ms.every(function (m) { return m.caps.length === 1 && m.caps[0] === 10; }), paths(ms).join(' '));
});
test('pieces cannot be jumped twice, captured pieces block', function () {
  // a king circling: K on 10; whites on 14, 15, 23, 22 — a loop that would revisit
  var b = board({ 10: RK, 14: W, 15: W, 22: W, 23: W });
  var ms = E.genMoves(b, R, 'american');
  ms.forEach(function (m) {
    var seen = {};
    m.caps.forEach(function (c) { assert.ok(!seen[c], 'double jump of ' + c); seen[c] = 1; });
  });
  assert.ok(ms.some(function (m) { return m.caps.length === 4; }), 'the full loop is found: ' + paths(ms).join(' '));
});
test('game: play / undo / notation / result by no moves', function () {
  var g = E.newGame('american');
  assert.ok(E.play(g, [10, 14]));       // 11-15
  assert.strictEqual(g.moves[0].n, '11-15');
  assert.strictEqual(g.side, E.WHITE);
  assert.strictEqual(E.play(g, [10, 14]), null, 'illegal path rejected');
  E.undo(g);
  assert.deepStrictEqual(g.b, E.initBoard());
  assert.strictEqual(g.side, E.RED);
  // White has one man left; Red takes it → White has no pieces
  var w = E.newGame('american', board({ 14: R, 18: W }), E.RED);
  var rec = E.play(w, [13, 22]);
  assert.ok(rec && rec.n === '14x23');
  assert.deepStrictEqual(w.result, { winner: E.RED, reason: 'captured' });
  // blocked: White man on 5 with Red men on 1 and 2 blocking? White man moves up; block on 1 & 2
  var bl = E.newGame('american', board({ 5: W, 1: R, 9: R }), E.WHITE);
  assert.ok(E.legal(bl).length === 0 || bl.result);
  assert.deepStrictEqual(E.outcome(bl), { winner: E.RED, reason: 'blocked' });
});
test('draws: threefold repetition and the 40-move rule', function () {
  var g = E.newGame('american', board({ 1: RK, 32: WK }), E.RED);
  var seq = [[0, 4], [31, 27], [4, 0], [27, 31]];
  for (var i = 0; i < 8 && !g.result; i++) assert.ok(E.play(g, seq[i % 4]), 'move ' + i);
  assert.deepStrictEqual(g.result, { winner: 0, reason: 'repetition' });
  var h = E.newGame('american', board({ 1: RK, 32: WK, 3: WK }), E.RED);
  var n = 0;
  while (!h.result && n < 200) {
    var ms = E.legal(h);
    // pick a move that avoids immediate repetition by cycling through moves deterministically
    var m = ms[(n * 7) % ms.length];
    E.play(h, m.path); n++;
  }
  assert.ok(h.result && h.result.winner === 0, JSON.stringify(h.result));
  assert.ok(h.result.reason === 'forty' || h.result.reason === 'repetition');
  // forty specifically: count reaches 80
  var q = E.newGame('american', board({ 1: RK, 32: WK }), E.RED);
  q.quiet = 79;
  E.play(q, E.legal(q)[0].path);
  assert.deepStrictEqual(q.result, { winner: 0, reason: 'forty' });
  E.undo(q);
  assert.strictEqual(q.quiet, 79);
});
test('alpha-beta equals plain minimax', function () {
  var r = E.rng(7);
  for (var t = 0; t < 12; t++) {
    var g = E.newGame(t % 3 ? 'american' : 'flying');
    for (var k = 0; k < 6 + (t * 3) % 15 && !g.result; k++) { var ms = E.legal(g); E.play(g, ms[Math.floor(r() * ms.length)].path); }
    if (g.result) continue;
    for (var d = 1; d <= 4; d++) {
      var ab = E.search(E.searchPos(g), { depth: d, plain: true });
      var mm = E.minimax(g.b.slice(), g.side, g.v, d);
      if (Math.abs(mm) < E.WIN - 1000) assert.strictEqual(ab.score, mm, 'test ' + t + ' depth ' + d);
      else assert.ok(Math.abs(ab.score) > E.WIN - 1000);
    }
  }
});
test('search finds a two-for-one shot and a forced win', function () {
  // Red may take one (1x10) or two (4x11x20): American rules allow either; the search takes two
  var b = board({ 1: R, 6: W, 4: R, 8: W, 16: W, 30: W });
  var g = E.newGame('american', b, E.RED);
  var res = E.search(E.searchPos(g), { depth: 6 });
  assert.strictEqual(res.move.caps.length, 2, 'takes the double: ' + E.notation(res.move));
  // K+K vs K in the open: the search sees a big advantage
  var k = E.newGame('american', board({ 14: RK, 19: RK, 30: W }), E.RED);
  var r2 = E.search(E.searchPos(k), { depth: 10, time: 1500 });
  assert.ok(r2.score > 150, 'winning eval ' + r2.score);
});
test('search avoids hanging a piece; levels pick legal moves deterministically', function () {
  var g = E.newGame('american');
  for (var lv = 1; lv <= 4; lv++) {
    var o = E.levelSearchOpts(lv, 42);
    o.time = Math.min(o.time, 300);
    var a = E.search(E.searchPos(g), o), b = E.search(E.searchPos(g), o);
    assert.ok(E.findMove(E.legal(g), a.path), 'legal at level ' + lv);
    if (lv <= 3) assert.deepStrictEqual(a.path, b.path, 'same seed, same move at level ' + lv);
  }
  // Red man on 14 could step to 18 (into a jump by 23) or 17 (safe) — a Club search steps safely
  var h = E.newGame('american', board({ 14: R, 23: W, 32: W, 1: R, 5: W }), E.RED);
  var r = E.search(E.searchPos(h), { depth: 5 });
  assert.notStrictEqual(E.notation(r.move), '14-18');
});
test('worker handle(): replays moves and answers with a legal path', function () {
  var g = E.newGame('american');
  E.play(g, [10, 14]); E.play(g, [22, 17]);
  var out = E.handle({ id: 9, v: 'american', moves: g.moves.map(function (m) { return m.path; }), level: 5, timeCap: 200 });
  assert.strictEqual(out.id, 9);
  assert.ok(E.findMove(E.legal(g), out.path), 'legal reply');
  var hnt = E.handle({ id: 10, v: 'american', moves: [], hint: true, time: 150 });
  assert.ok(E.findMove(E.legal(E.newGame('american')), hnt.path));
});
test('CPU self-play: games end, every move legal, no crash (both variants)', function () {
  ['american', 'flying'].forEach(function (v, vi) {
    var g = E.newGame(v), n = 0;
    while (!g.result && n < 300) {
      var r = E.search(E.searchPos(g), { depth: 3, margin: 30, seed: n + vi * 1000 });
      assert.ok(r.path && E.play(g, r.path), 'legal ' + n);
      n++;
    }
    assert.ok(g.result, v + ' game ended (' + n + ' plies)');
  });
});
test('saves: game round trip and normalisation', function () {
  var g = E.newGame('american');
  g.mode = 'cpu'; g.level = 4; g.human = E.WHITE; g.id = 3; g.t = 123; g.undos = 1; g.hints = 2; g.autoFlip = false; g.recorded = false;
  E.play(g, [10, 14]); E.play(g, [22, 17]); E.play(g, [8, 13]);
  var s = JSON.parse(JSON.stringify(E.gameSave(g)));
  var n = E.normGame(s);
  assert.deepStrictEqual(n.b, g.b);
  assert.strictEqual(n.side, g.side);
  assert.ok(n.mode === 'cpu' && n.level === 4 && n.human === E.WHITE && n.undos === 1 && n.hints === 2);
  // junk is cut at the first illegal move and fields are clamped
  var bad = E.normGame({ v: 'nope', mode: 'x', level: 99, moves: [[10, 14], [0, 31], 'x'], undos: -4 });
  assert.ok(bad.v === 'american' && bad.mode === 'cpu' && bad.level === 6 && bad.moves.length === 1 && bad.undos === 0 && !bad.ok);
  assert.strictEqual(E.normGame(null), null);
  assert.strictEqual(E.normGame({ moves: 'x' }), null);
  // resignations survive a reload
  var rs = E.gameSave(g); rs.result = { winner: E.RED, reason: 'resign' };
  assert.deepStrictEqual(E.normGame(JSON.parse(JSON.stringify(rs))).result, { winner: E.RED, reason: 'resign' });
});
test('stats: record wins, losses, streaks, pvp; normalise junk', function () {
  var st = E.newStats();
  function fin(winner, mode, level, human, plies) {
    var g = { result: { winner: winner, reason: 'blocked' }, moves: new Array(plies || 40) };
    return E.recordResult(st, g, { mode: mode, level: level, human: human });
  }
  assert.ok(fin(E.RED, 'cpu', 3, E.RED, 40).won);
  var w2 = fin(E.RED, 'cpu', 3, E.RED, 30);
  assert.ok(w2.won && w2.newStreak && w2.fast && st.lv[3].fast === 15);
  assert.ok(fin(E.RED, 'cpu', 3, E.WHITE).lost && st.streak === 0 && st.bestStreak === 2);
  assert.ok(fin(0, 'cpu', 5, E.RED).draw && st.lv[5].d === 1);
  fin(E.WHITE, 'pvp'); fin(0, 'pvp');
  assert.deepStrictEqual(st.pvp, { n: 2, r: 0, w: 1, d: 1 });
  assert.strictEqual(st.games, 6);
  assert.deepStrictEqual(E.normStats(JSON.parse(JSON.stringify(st))), st);
  var j = E.normStats({ lv: { 1: { w: -3, l: 'x' } }, streak: 5, bestStreak: 2, pvp: 7 });
  assert.ok(j.lv[1].w === 0 && j.lv[1].l === 0 && j.bestStreak === 5 && j.pvp.n === 0 && j.lv[6].w === 0);
  var p = E.normPrefs({ mode: 'pvp', level: 0, color: 'q', v: 'flying', nums: false });
  assert.deepStrictEqual(p, { mode: 'pvp', level: 1, color: 'r', v: 'flying', autoFlip: false, nums: false, fast: false });
});

test('flying kings: long-range capture lands on any square beyond; American king cannot', function () {
  var b = board({ 1: RK, 10: W, 32: W });
  assert.deepStrictEqual(paths(E.genMoves(b, R, 'flying')), ['1-15', '1-19', '1-24', '1-28']);
  assert.ok(E.genMoves(b, R, 'american').every(function (m) { return !m.caps.length; }));
});
test('flying: a man passing the far row mid-capture is not crowned; American stops and crowns', function () {
  var b = board({ 24: R, 27: W, 26: W, 5: W });
  var f = E.genMoves(b, R, 'flying');
  assert.deepStrictEqual(paths(f), ['24-31-22']);
  var u = E.makeMove(b, f[0]);
  assert.strictEqual(b[21], R, 'still a man'); assert.ok(!u.promo);
  E.unmakeMove(b, f[0], u);
  var a = E.genMoves(b, R, 'american');
  assert.deepStrictEqual(paths(a), ['24-31']);
  u = E.makeMove(b, a[0]); assert.strictEqual(b[30], RK); assert.ok(u.promo);
});
test('search: transposition table does not leak between variants', function () {
  // same position, different rules -> answers must match a fresh search of that variant
  var b = board({ 1: RK, 10: W, 14: W, 32: W, 29: W });
  var pf = { b: b, side: R, v: 'flying', quiet: 0, hist: [] }, pa = { b: b, side: R, v: 'american', quiet: 0, hist: [] };
  var f1 = E.search(pf, { depth: 5 });
  E.search(pa, { depth: 7 });
  var f2 = E.search(pf, { depth: 5 });
  assert.strictEqual(f1.score, f2.score);
  assert.ok(E.findMove(E.genMoves(b, R, 'flying'), f2.path), 'legal flying move');
});
test('custom start positions: normStart, replay and the worker handle()', function () {
  assert.strictEqual(E.normStart(null), null);
  assert.strictEqual(E.normStart({ b: [1, 2] }), null);
  var st = E.normStart({ b: board({ 14: R, 18: W, 32: 9 }), side: -1 });
  assert.strictEqual(st.side, E.WHITE); assert.strictEqual(st.b[31], 0);
  var r = E.handle({ id: 7, v: 'american', moves: [], start: { b: board({ 14: R, 18: W, 32: W }), side: E.WHITE }, level: 6, timeCap: 200 });
  assert.strictEqual(r.id, 7);
  assert.deepStrictEqual(r.path.map(function (s) { return s + 1; }), [18, 9], 'White takes the last red man');
  var g = E.replay('american', [[17, 8]], { b: board({ 14: R, 18: W, 32: W }), side: E.WHITE });
  assert.ok(g.ok && g.result && g.result.winner === E.WHITE);
  // saved with its start, a set-up game resumes in the same place
  g.mode = 'cpu'; g.level = 2; g.human = R; g.id = 1;
  var n = E.normGame(JSON.parse(JSON.stringify(E.gameSave(g))));
  assert.deepStrictEqual(n.b, g.b); assert.ok(n.result && n.result.winner === E.WHITE);
});
test('timed search respects its budget and always returns a legal move', function () {
  var g = E.newGame('american');
  E.play(g, [10, 14]); E.play(g, [22, 17]);
  var t0 = Date.now(), r = E.handle({ id: 1, v: 'american', moves: g.moves.map(function (m) { return m.path; }), level: 4 });
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0));
  assert.ok(E.findMove(E.legal(g), r.path));
  var h = E.handle({ id: 2, v: 'flying', moves: [], hint: true, time: 150 });
  assert.ok(E.findMove(E.legal(E.newGame('flying')), h.path));
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
