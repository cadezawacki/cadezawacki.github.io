/* Headless checks for the Dots and Boxes engine (rules, chains, AI, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/dotsboxes/dotsboxes.test.js */
'use strict';
var assert = require('assert');

var E = require('./dotsboxes.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./dotsboxes.js')];
require('./dotsboxes.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  var t0 = Date.now();
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
  if (process.env.VERBOSE) console.log((Date.now() - t0) + 'ms  ' + name);
}
function H(g, r, c) { return r * g.w + c; }                         // horizontal edge
function V(g, r, c) { return g.G.NH + r * (g.w + 1) + c; }          // vertical edge
function playAll(g, list) { list.forEach(function (e) { assert.ok(E.play(g, e), 'legal ' + e); }); }
// A bare AI board on any size (the game clamps to 3..8; the engine itself doesn't care).
function rawBoard(w, h, edges) {
  var G = E.geo(w, h), B = { G: G, ed: new Uint8Array(G.NE), sd: new Uint8Array(G.NB), left: G.NB, h1: 0, h2: 0 };
  (edges || []).forEach(function (e) { E.draw(B, e); });
  return B;
}
// Full minimax over every legal line, memoised on the edge set: the ground truth.
function brute(B) {
  var memo = new Map();
  function rec() {
    if (!B.left) return 0;
    var key = B.h1 + ':' + B.h2, m = memo.get(key);
    if (m !== undefined) return m;
    var best = -Infinity;
    for (var e = 0; e < B.G.NE; e++) {
      if (B.ed[e]) continue;
      var c = E.draw(B, e), v = c ? c + rec() : -rec();
      E.undraw(B, e, c);
      if (v > best) best = v;
    }
    best += 0;
    memo.set(key, best);
    return best;
  }
  return rec();
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Dots and Boxes' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'dotsboxes.css');
  assert.strictEqual(widget._engine.MAX_N, 8);
});

test('geometry: every box has 4 distinct edges, every edge 1 or 2 boxes', function () {
  for (var w = 2; w <= 8; w++) for (var h = 2; h <= 8; h++) {
    var G = E.geo(w, h);
    assert.strictEqual(G.NE, (h + 1) * w + h * (w + 1));
    var cnt = new Uint8Array(G.NE);
    for (var b = 0; b < G.NB; b++) {
      var s = {};
      for (var k = 0; k < 4; k++) { var e = G.be[b * 4 + k]; assert.ok(!s[e]); s[e] = 1; cnt[e]++; assert.ok(G.eb[e * 2] === b || G.eb[e * 2 + 1] === b); }
    }
    for (var e2 = 0; e2 < G.NE; e2++) {
      assert.ok(cnt[e2] === 1 || cnt[e2] === 2);
      var border = G.y1[e2] === G.y2[e2] ? (G.y1[e2] === 0 || G.y1[e2] === h) : (G.x1[e2] === 0 || G.x1[e2] === w);
      assert.strictEqual(cnt[e2] === 1, border);
      assert.strictEqual(Math.abs(G.x2[e2] - G.x1[e2]) + Math.abs(G.y2[e2] - G.y1[e2]), 1);
    }
  }
});

test('rules: closing a box scores and moves again; two at once; undo restores', function () {
  var g = E.newGame({ w: 3, h: 3, n: 2, first: 0 });
  playAll(g, [H(g, 0, 0), V(g, 0, 0), H(g, 1, 0)]);   // P0, P1, P0
  assert.strictEqual(g.turn, 1);
  var got = E.play(g, V(g, 0, 1));                        // P1 closes box 0
  assert.deepStrictEqual(got, [0]);
  assert.ok(g.turn === 1 && g.score[1] === 1 && g.own[0] === 1);
  assert.strictEqual(E.play(g, V(g, 0, 1)), null, 'no line twice');
  // box 1 (r0 c1): top, right, bottom drawn by P1, P0, P1... set up a double
  playAll(g, [H(g, 0, 1), H(g, 1, 1)]);                  // P1 (passes to P0), then P0 → P1
  assert.strictEqual(g.turn, 1);
  // box 3 (r1 c0) needs left, bottom, right; box 1 needs right
  var before = JSON.stringify({ ed: Array.from(g.ed), sd: Array.from(g.sd), own: Array.from(g.own), sc: g.score, t: g.turn });
  var m = E.play(g, V(g, 0, 2));
  assert.deepStrictEqual(m, [1]);
  E.undo(g);
  assert.strictEqual(JSON.stringify({ ed: Array.from(g.ed), sd: Array.from(g.sd), own: Array.from(g.own), sc: g.score, t: g.turn }), before);
  // a line that closes two boxes at once
  var g2 = E.newGame({ w: 3, h: 3 });
  playAll(g2, [H(g2, 0, 0), H(g2, 1, 0), V(g2, 0, 0), H(g2, 0, 1), H(g2, 1, 1), V(g2, 0, 2)]);
  var t = g2.turn, two = E.play(g2, V(g2, 0, 1));
  assert.strictEqual(two.length, 2);
  assert.ok(g2.score[t] === 2 && g2.turn === t);
});

test('random games: scores add up, game ends exactly when the last box closes, undo to start', function () {
  var R = E.rng(7);
  for (var it = 0; it < 60; it++) {
    var n = 2 + (it % 3), w = 3 + (it % 6), h = 3 + ((it * 5) % 6);
    var g = E.newGame({ w: w, h: h, n: n, first: it % n });
    while (!g.over) { var l = E.legal(g); E.play(g, l[(R() * l.length) | 0]); }
    assert.strictEqual(g.score.reduce(function (a, b) { return a + b; }, 0), w * h);
    assert.strictEqual(E.legal(g).length, 0);
    assert.ok(E.winners(g).length >= 1);
    var re = E.replay({ w: w, h: h, n: n, first: it % n }, g.moves.map(function (m) { return m.e; }));
    assert.deepStrictEqual(re.score, g.score);
    while (g.moves.length) E.undo(g);
    assert.ok(g.score.every(function (s) { return s === 0; }) && g.turn === it % n && g.left === w * h);
    assert.ok(Array.prototype.every.call(g.ed, function (x) { return !x; }));
  }
});

test('strings: chains, loops and their ends', function () {
  // 3x1 strip with all horizontal lines drawn: a chain of 3 open at both ends (ground)
  var G = E.geo(3, 1), es = [];
  for (var c = 0; c < 3; c++) es.push(c, G.NH - 3 + c + 3 - 3 + 3);
  var B = rawBoard(3, 1, [0, 1, 2, 3, 4, 5]);
  var s = E.strings(B);
  assert.strictEqual(s.length, 1);
  assert.ok(!s[0].loop && s[0].k === 3 && s[0].edges.length === 4 && s[0].ends[0] === -1 && s[0].ends[1] === -1);
  // 2x2 with only the four outer... inner cross drawn → no: a loop needs the outside drawn
  var G2 = E.geo(2, 2), outer = [];
  for (var e = 0; e < G2.NE; e++) {
    var hor = G2.y1[e] === G2.y2[e];
    if (hor ? (G2.y1[e] === 0 || G2.y1[e] === 2) : (G2.x1[e] === 0 || G2.x1[e] === 2)) outer.push(e);
  }
  var L = rawBoard(2, 2, outer), sl = E.strings(L);
  assert.ok(sl.length === 1 && sl[0].loop && sl[0].k === 4 && sl[0].edges.length === 4);
  assert.deepStrictEqual(E.openers(sl[0]).length, 1);
  void es;
});

test('chain values: the classic small cases', function () {
  assert.strictEqual(E.compValue([]), 0);
  assert.strictEqual(E.compValue([3]), -3);
  assert.strictEqual(E.compValue([3, 3]), -2);          // open one: they take 1, hand back 2, you open the other
  assert.strictEqual(E.compValue([-4]), -4);
  assert.strictEqual(E.compValue([1, 1]), 0);
  assert.strictEqual(E.compValue([1, 3]), 2);           // give the 1 away (-1): now they must open the 3 (+3)
  assert.strictEqual(E.compValue([2, 3]), 1);           // a 2 opened in the middle: no double-cross
  assert.strictEqual(E.compValue([3, 3, 3]), -1);
  assert.strictEqual(E.compValue([-4, -4]), 0);          // whoever takes the first loop gains nothing either way
});

test('exact search with pruned moves = full minimax once the safe lines are gone', function () {
  var R = E.rng(99), checked = 0, sizes = [[2, 2], [3, 2], [2, 3]];
  for (var it = 0; it < 400 && checked < 70; it++) {
    var sz = sizes[it % sizes.length], B = rawBoard(sz[0], sz[1]), tries = 0;
    // random lines until no safe line is left (captures included)
    while (E.safeMoves(B).length && tries++ < 100) {
      var s = E.safeMoves(B);
      E.draw(B, s[(R() * s.length) | 0]);
    }
    // sometimes also open something so a capture is on offer
    if (R() < 0.5 && B.left) {
      var all = [];
      for (var e = 0; e < B.G.NE; e++) if (!B.ed[e]) all.push(e);
      if (all.length) E.draw(B, all[(R() * all.length) | 0]);
    }
    if (!B.left || E.safeMoves(B).length) continue;
    var truth = brute(E.cloneB(B)), r = E.solve(E.cloneB(B), 1e6);
    assert.ok(r, 'solved');
    assert.strictEqual(r.value, truth, 'value at ' + Array.from(B.ed).join(''));
    // and the chosen move achieves it
    var T = E.cloneB(B), c = E.draw(T, r.move), after = c ? c + brute(T) : -brute(T);
    assert.strictEqual(after + 0, truth);
    checked++;
  }
  assert.ok(checked >= 40, 'checked ' + checked);
});

test('hard double-crosses: takes 1 of an opened 3-chain and hands back 2', function () {
  // 3x2 board: two horizontal chains of 3 (rows), opened: the top row is on offer from the left end
  var G = E.geo(3, 2), B = rawBoard(3, 2), e;
  for (e = 0; e < G.NH; e++) E.draw(B, e);                       // all horizontals: two separate 3-chains
  E.draw(B, G.NH + 0);                                            // open the top chain at its left end
  var r = E.solve(E.cloneB(B), 1e6);
  assert.strictEqual(r.value, brute(E.cloneB(B)));
  assert.strictEqual(r.value, 2);                                 // take 1, hand back 2, then get the whole other 3: 1-2+3
  // the first move takes box 0 (draw its right side)
  assert.strictEqual(r.move, G.NH + 1);
  var T = E.cloneB(B); E.draw(T, r.move);
  var r2 = E.solve(E.cloneB(T), 1e6);
  assert.strictEqual(r2.move, G.NH + 3, 'declines with the far line, leaving a domino');
  // the game-level AI agrees
  var g = E.newGame({ w: 3, h: 3 });
  void g;
  assert.strictEqual(E.loonyPlay(E.cloneB(T)), G.NH + 3);
});

test('medium never hands over a box while a safe line exists, and takes what is offered', function () {
  var R = E.rng(5);
  for (var it = 0; it < 30; it++) {
    var g = E.newGame({ w: 4, h: 4 });
    while (!g.over) {
      var B = E.board(g), safe = E.safeMoves(B), cb = E.capturable(B), m = E.aiMove(g, 'medium', R);
      assert.ok(m >= 0 && !g.ed[m]);
      if (cb >= 0) { var T = E.cloneB(B); assert.ok(E.draw(T, m) > 0, 'medium captures'); }
      else if (safe.length) assert.ok(E.isSafe(B, m), 'medium plays safe');
      E.play(g, m);
    }
  }
});

test('every level plays only legal lines on every size, deterministically', function () {
  ['easy', 'medium', 'hard'].forEach(function (lv) {
    for (var n = 3; n <= 8; n += (lv === 'hard' ? 5 : 1)) {
      var seq = [];
      for (var rep = 0; rep < 2; rep++) {
        var g = E.newGame({ w: n, h: n }), R = E.rng(1234 + n), moves = [];
        while (!g.over) {
          var m = E.aiMove(g, lv, R, { nodes: 30000, rollouts: 400 });
          assert.ok(m >= 0 && m < g.G.NE && !g.ed[m], lv + ' legal');
          E.play(g, m); moves.push(m);
        }
        seq.push(moves.join(','));
      }
      assert.strictEqual(seq[0], seq[1], lv + ' deterministic for a seed');
    }
  });
});

function match(a, b, size, games, seed) {
  var R = E.rng(seed), score = { a: 0, b: 0, d: 0 };
  for (var i = 0; i < games; i++) {
    var g = E.newGame({ w: size, h: size, first: i % 2 }), lv = i % 2 ? [b, a] : [a, b];   // seat 0 plays lv[0]
    // seat 0 = a when i even, b when odd: alternate who moves first by swapping seats
    var who = i % 2 ? { 0: 'b', 1: 'a' } : { 0: 'a', 1: 'b' };
    g.first = 0; g.turn = 0;
    while (!g.over) E.play(g, E.aiMove(g, lv[g.turn], R, { nodes: 40000, rollouts: 700 }));
    var d = g.score[0] - g.score[1];
    if (d === 0) score.d++; else score[d > 0 ? who[0] : who[1]]++;
  }
  return score;
}
test('hard beats medium and medium beats easy (seeded matches)', function () {
  var m1 = match('hard', 'medium', 4, 12, 31);
  assert.ok(m1.a > m1.b + 3, 'hard vs medium 4x4: ' + JSON.stringify(m1));
  var m2 = match('medium', 'easy', 5, 12, 32);
  assert.ok(m2.a > m2.b + 3, 'medium vs easy 5x5: ' + JSON.stringify(m2));
  if (process.env.VERBOSE) console.log(JSON.stringify({ hardVsMedium: m1, mediumVsEasy: m2 }));
});

test('hard stays quick on the biggest board (node budget)', function () {
  var g = E.newGame({ w: 8, h: 8 }), R = E.rng(3), worst = 0;
  while (!g.over) {
    var t0 = Date.now(), m = E.aiMove(g, 'hard', R);
    worst = Math.max(worst, Date.now() - t0);
    E.play(g, m);
  }
  assert.ok(worst < 2500, 'worst move ' + worst + 'ms');
  if (process.env.VERBOSE) console.log('8x8 hard worst move ' + worst + 'ms');
});

test('saves: options, stats and games normalise defensively', function () {
  var o = E.normOpts({ mode: 'pp', size: 99, level: 'nope', players: 7, first: 'x' });
  assert.deepStrictEqual(o, { mode: 'pp', size: 8, level: 'medium', players: 4, first: 'alt', nextFirst: 0 });
  assert.deepStrictEqual(E.normOpts(null).mode, 'cpu');
  var s = E.normStats({ cpu: { hard: { p: -3, w: 2, l: 'x', d: 1.7, streak: 4, best: 1 } }, pp: { games: 5, by: { 3: 2 } }, boxes: 'a', bigTurn: 6 });
  assert.ok(s.cpu.hard.w === 2 && s.cpu.hard.l === 0 && s.cpu.hard.d === 1 && s.cpu.hard.p === 3 && s.cpu.hard.best === 4);
  assert.ok(s.pp.games === 5 && s.pp.by[3] === 2 && s.boxes === 0 && s.bigTurn === 6 && s.cpu.easy.p === 0);
  assert.deepStrictEqual(E.normStats(JSON.parse(JSON.stringify(s))), s);
  assert.deepStrictEqual(E.normStats('junk'), E.newStats());
  // a game round-trips; bad move lists are rejected
  var g = E.newGame({ w: 4, h: 3, n: 2, first: 1 }), R = E.rng(8);
  for (var i = 0; i < 12; i++) { var l = E.legal(g); E.play(g, l[(R() * l.length) | 0]); }
  var sv = E.saveGame(g, { mode: 'cpu', level: 'hard', cpu: 1 }), back = E.normGame(JSON.parse(JSON.stringify(sv)));
  assert.ok(back && back.meta.level === 'hard' && back.meta.cpu === 1);
  assert.deepStrictEqual(back.game.score, g.score);
  assert.strictEqual(back.game.turn, g.turn);
  assert.strictEqual(E.normGame({ moves: [0, 0] }), null, 'repeat line');
  assert.strictEqual(E.normGame({ moves: 'x' }), null);
  assert.strictEqual(E.normGame(null), null);
  assert.ok(E.normGame({ mode: 'pp', n: 9, w: 1, moves: [] }).game.n === 4);
});

test('settle: wins, streaks, margins, biggest turn', function () {
  var st = E.newStats(), g = E.newGame({ w: 3, h: 3 }), R = E.rng(4);
  while (!g.over) E.play(g, E.aiMove(g, g.turn === 0 ? 'hard' : 'easy', R, { nodes: 30000, rollouts: 300 }));
  var meta = { mode: 'cpu', level: 'easy', cpu: 1 }, n = E.settle(st, g, meta);
  var me = g.score[0] - g.score[1];
  assert.strictEqual(n.result, me > 0 ? 'win' : me < 0 ? 'loss' : 'draw');
  assert.strictEqual(st.cpu.easy.p, 1);
  assert.ok(st.bigTurn === E.bigTurn(g, 0));
  var p = E.newGame({ w: 3, h: 3, n: 3 });
  while (!p.over) { var l = E.legal(p); E.play(p, l[(R() * l.length) | 0]); }
  E.settle(st, p, { mode: 'pp', level: 'medium', cpu: -1 });
  assert.ok(st.pp.games === 1 && st.pp.by[3] === 1 && st.games === 2);
});

test('biggest turn vs the CPU counts only the human seat', function () {
  // 3x3: CPU (seat 1) sweeps a chain; the human takes nothing
  var g = E.newGame({ w: 3, h: 3, first: 0 });
  g.moves = [{ e: 0, p: 0, got: [] }, { e: 1, p: 1, got: [0] }, { e: 2, p: 1, got: [1, 2] }, { e: 3, p: 1, got: [] }, { e: 4, p: 0, got: [3] }];
  assert.strictEqual(E.bigTurn(g), 3);
  assert.strictEqual(E.bigTurn(g, 1), 3);
  assert.strictEqual(E.bigTurn(g, 0), 1);
  // settle on a real game where only the CPU scores
  var st = E.newStats(), h = E.newGame({ w: 3, h: 3, first: 1 }), R = E.rng(11);
  while (!h.over) {
    var m = h.turn === 1 ? E.aiMove(h, 'hard', R, { nodes: 30000, rollouts: 200 }) : E.aiMove(h, 'easy', R);
    E.play(h, m);
  }
  E.settle(st, h, { mode: 'cpu', level: 'hard', cpu: 1 });
  assert.strictEqual(st.bigTurn, E.bigTurn(h, 0));
  assert.ok(st.bigTurn <= h.score[0]);
});

test('hint / AI stays legal in 3-4 player games and on finished boards', function () {
  var R = E.rng(99);
  for (var n = 3; n <= 4; n++) for (var k = 0; k < 4; k++) {
    var g = E.newGame({ w: 3 + k, h: 3 + k, n: n });
    while (!g.over) {
      var m = E.aiMove(g, ['easy', 'medium', 'hard'][(g.turn + k) % 3], R, { nodes: 20000, rollouts: 150 });
      assert.ok(m >= 0 && !g.ed[m], 'legal line');
      assert.ok(E.play(g, m));
    }
    assert.strictEqual(E.aiMove(g, 'hard', R), -1);
    assert.strictEqual(g.score.reduce(function (a, b) { return a + b; }, 0), g.G.NB);
  }
});

test('hard never loses to random play on 3x3 when moving second', function () {
  for (var s = 1; s <= 12; s++) {
    var R = E.rng(s), g = E.newGame({ w: 3, h: 3, first: 0 });
    while (!g.over) {
      var m;
      if (g.turn === 1) m = E.aiMove(g, 'hard', R, { nodes: 60000, rollouts: 300 });
      else { var l = E.legal(g); m = l[(R() * l.length) | 0]; }
      E.play(g, m);
    }
    assert.ok(g.score[1] > g.score[0], 'seed ' + s + ' ' + g.score.join('-'));
  }
});

test('a saved game where the CPU moves first resumes on the CPU turn', function () {
  var g = E.newGame({ w: 4, h: 4, first: 1 });
  var sv = E.saveGame(g, { mode: 'cpu', level: 'hard', cpu: 1 });
  sv.moves = [0];
  var r = E.normGame(JSON.parse(JSON.stringify(sv)));
  assert.ok(r && r.game.first === 1 && r.game.turn === 0 && r.meta.cpu === 1 && r.meta.level === 'hard');
  assert.strictEqual(E.normGame({ mode: 'cpu', w: 4, moves: [0, 0] }), null);
  assert.strictEqual(E.normGame({ mode: 'cpu', w: 4, moves: [9999] }), null);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
