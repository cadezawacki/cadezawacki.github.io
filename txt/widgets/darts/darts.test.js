/* Headless checks for the Darts engine (board, rules, checkouts, CPU, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/darts/darts.test.js */
'use strict';
var assert = require('assert');

var E = require('./darts.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./darts.js')];
require('./darts.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function H(n, m) { return { n: n, m: m }; }
function at(n, m) { var p = E.aimPoint(n, m); return E.scoreAt(p.x, p.y); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Darts' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'darts.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('segment order runs clockwise from 20 at the top', function () {
  assert.deepStrictEqual(E.ORDER, [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]);
  assert.strictEqual(E.scoreAt(0, 0.4).n, 20);       // straight up
  assert.strictEqual(E.scoreAt(0.4, 0).n, 6);        // right
  assert.strictEqual(E.scoreAt(0, -0.4).n, 3);       // down
  assert.strictEqual(E.scoreAt(-0.4, 0).n, 11);      // left
  // clockwise next to 20 is 1, anticlockwise 5
  var a = 18 * Math.PI / 180;
  assert.strictEqual(E.scoreAt(0.4 * Math.sin(a), 0.4 * Math.cos(a)).n, 1);
  assert.strictEqual(E.scoreAt(-0.4 * Math.sin(a), 0.4 * Math.cos(a)).n, 5);
  // the edges of the 20 bed sit at ±9°
  var e = 8.9 * Math.PI / 180, f = 9.1 * Math.PI / 180;
  assert.strictEqual(E.scoreAt(0.4 * Math.sin(e), 0.4 * Math.cos(e)).n, 20);
  assert.strictEqual(E.scoreAt(0.4 * Math.sin(f), 0.4 * Math.cos(f)).n, 1);
});

test('rings: bulls, trebles, doubles, singles, off the board', function () {
  assert.deepStrictEqual(E.scoreAt(0, 0), H(25, 2));
  assert.deepStrictEqual(E.scoreAt(0.08, 0), H(25, 1));
  assert.deepStrictEqual(E.scoreAt(0, (E.R_T0 + E.R_T1) / 2), H(20, 3));
  assert.deepStrictEqual(E.scoreAt(0, (E.R_D0 + E.R_D1) / 2), H(20, 2));
  assert.deepStrictEqual(E.scoreAt(0, 0.3), H(20, 1));
  assert.deepStrictEqual(E.scoreAt(0, 0.8), H(20, 1));
  assert.deepStrictEqual(E.scoreAt(0, 1.01), H(0, 0));
  assert.deepStrictEqual(E.scoreAt(NaN, 0), H(0, 0));
  // every aim point lands in its own bed
  E.ORDER.forEach(function (n) {
    [1, 1.5, 2, 3].forEach(function (m) { var h = at(n, m); assert.strictEqual(h.n, n); assert.strictEqual(h.m, m === 1.5 ? 1 : m); });
  });
  assert.deepStrictEqual(at(25, 2), H(25, 2));
  assert.strictEqual(E.label(H(20, 3)), 'T20');
  assert.strictEqual(E.label(H(16, 2)), 'D16');
  assert.strictEqual(E.label(H(25, 2)), 'BULL');
  assert.strictEqual(E.label(H(25, 1)), '25');
  assert.strictEqual(E.label(H(0, 0)), 'MISS');
});

test('the sway: steadies with a held breath, tires when held too long', function () {
  assert.strictEqual(E.steadyAmp(-1), 1);
  assert.ok(E.steadyAmp(0.3) < 1 && E.steadyAmp(0.3) > E.steadyAmp(0.8));
  assert.ok(Math.abs(E.steadyAmp(E.HOLD_BEST + 0.1) - 0.36) < 1e-9);
  assert.ok(E.steadyAmp(E.HOLD_TIRE + 1) > 0.5 && E.steadyAmp(10) > 1.2);
  for (var t = 0; t < 30; t += 0.37) {
    var w = E.wobble(t, -1, 0.14, 1.2), s = E.wobble(t, 1.4, 0.14, 1.2);
    assert.ok(Math.hypot(w.x, w.y) <= 0.14 * 1.2 + 1e-9);
    assert.ok(Math.hypot(s.x, s.y) <= 0.14 * 0.36 * 1.2 + 1e-9);
  }
  // smooth: no jumps between 120 Hz steps
  var prev = E.wobble(0, -1, 0.14, 0);
  for (t = E.STEP; t < 10; t += E.STEP) {
    var cur = E.wobble(t, -1, 0.14, 0);
    assert.ok(Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.01, 'jump at ' + t);
    prev = cur;
  }
});

test('checkouts: the classic routes and the bogey numbers', function () {
  function r(n, d) { return E.routeLabel(E.checkout(n, d == null ? 3 : d, true)); }
  assert.strictEqual(r(170), 'T20 T20 BULL');
  assert.strictEqual(r(167), 'T20 T19 BULL');
  assert.strictEqual(r(160), 'T20 T20 D20');
  assert.strictEqual(r(100), 'T20 D20');
  assert.strictEqual(r(40), 'D20');
  assert.strictEqual(r(32), 'D16');
  assert.strictEqual(r(50), 'BULL');
  assert.strictEqual(r(2), 'D1');
  [169, 168, 166, 165, 163, 162, 159].forEach(function (n) { assert.strictEqual(E.checkout(n, 3, true), null, n + ' has no out'); });
  assert.strictEqual(E.checkout(1, 3, true), null);
  assert.strictEqual(E.checkout(171, 3, true), null);
  assert.strictEqual(E.checkout(100, 1, true), null);
  assert.strictEqual(E.checkout(41, 1, true), null);
  // every route really finishes: right total, ends on a double, never too many darts
  for (var n = 2; n <= 170; n++) {
    for (var d = 1; d <= 3; d++) {
      var co = E.checkout(n, d, true);
      if (!co) continue;
      assert.ok(co.length <= d);
      assert.strictEqual(co.reduce(function (s, h) { return s + E.value(h); }, 0), n);
      assert.strictEqual(co[co.length - 1].m, 2);
    }
  }
  // without double-out anything up to 180 in three goes when it's reachable
  assert.strictEqual(E.routeLabel(E.checkout(180, 3, false)), 'T20 T20 T20');
  assert.strictEqual(E.routeLabel(E.checkout(1, 1, false)), '1');
});

test('x01: scoring, bust rules and double-out', function () {
  var G = E.newGame({ mode: 'x01', start: 301, players: [{ name: 'A' }, { name: 'B', cpu: 2 }] });
  E.throwDart(G, H(20, 3)); E.throwDart(G, H(20, 3)); var ev = E.throwDart(G, H(20, 3));
  assert.ok(ev.turnOver && G.phase === 'turnover' && G.players[0].score === 121 && G.players[0].n180 === 1);
  assert.strictEqual(E.throwDart(G, H(1, 1)), null, 'no throws between turns');
  E.nextTurn(G);
  assert.strictEqual(G.cur, 1);
  E.throwDart(G, H(1, 1)); E.throwDart(G, H(1, 1)); E.throwDart(G, H(0, 0));
  E.nextTurn(G);
  assert.strictEqual(G.round, 2);
  // 121: T20 then 61 → T17 leaves 10, then a single 10 → 0 not on a double: bust
  E.throwDart(G, H(20, 3)); E.throwDart(G, H(17, 3));
  ev = E.throwDart(G, H(10, 1));
  assert.ok(ev.bust && G.players[0].score === 121 && G.phase === 'turnover');
  assert.strictEqual(G.players[0].points, 180, 'a bust turn scores nothing');
  E.nextTurn(G); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.nextTurn(G);
  // leaving 1 busts; going below busts — and ends the turn at once
  G.players[0].score = 41; G.turnStart = 41;
  ev = E.throwDart(G, H(20, 2));
  assert.ok(ev.bust && G.players[0].score === 41 && G.turn.length === 1 && G.phase === 'turnover');
  E.nextTurn(G); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.nextTurn(G);
  ev = E.throwDart(G, H(9, 1));
  assert.ok(!ev.bust && G.players[0].score === 32);
  ev = E.throwDart(G, H(16, 2));
  assert.ok(ev.legWon && ev.gameOver && G.phase === 'over' && G.winner === 0 && ev.checkout === 41);
  assert.strictEqual(G.players[0].hiOut, 41);
  // the bull counts as a double
  G = E.newGame({ mode: 'x01', start: 301, players: [{}] });
  G.players[0].score = 50; G.turnStart = 50;
  assert.ok(E.throwDart(G, H(25, 2)).legWon);
  // single-out: any dart finishes
  G = E.newGame({ mode: 'x01', start: 301, doubleOut: false, players: [{}] });
  G.players[0].score = 7; G.turnStart = 7;
  assert.ok(E.throwDart(G, H(7, 1)).legWon);
  assert.ok(E.busts(1, H(1, 1), true) && !E.busts(1, H(1, 1), false));
});

test('x01: legs rotate the throw and first to N takes the match', function () {
  var G = E.newGame({ mode: 'x01', start: 301, legs: 2, players: [{ name: 'A' }, { name: 'B' }] });
  G.players[0].score = 40; G.turnStart = 40;
  var ev = E.throwDart(G, H(20, 2));
  assert.ok(ev.legWon && !ev.gameOver && G.phase === 'legover' && G.players[0].legs === 1);
  assert.ok(E.nextLeg(G));
  assert.ok(G.cur === 1 && G.starter === 1 && G.leg === 2 && G.players[0].score === 301 && G.players[1].score === 301);
  G.players[1].score = 32; G.turnStart = 32;
  E.throwDart(G, H(16, 2));
  E.nextLeg(G);
  assert.strictEqual(G.cur, 0);
  G.players[0].score = 2; G.turnStart = 2;
  ev = E.throwDart(G, H(1, 2));
  assert.ok(ev.gameOver && G.winner === 0 && G.players[0].legs === 2);
});

test('cricket: marks, closing, points only while open, the win', function () {
  var G = E.newGame({ mode: 'cricket', players: [{ name: 'A' }, { name: 'B' }] });
  var ev = E.throwDart(G, H(20, 3));
  assert.ok(ev.closed && G.players[0].marks[20] === 3 && G.players[0].pts === 0);
  ev = E.throwDart(G, H(20, 2));
  assert.ok(ev.scored === 40 && G.players[0].pts === 40);
  E.throwDart(G, H(14, 3));                       // not a cricket number
  assert.strictEqual(G.players[0].markCount, 5);
  E.nextTurn(G);
  ev = E.throwDart(G, H(20, 1)); E.throwDart(G, H(20, 1)); ev = E.throwDart(G, H(20, 2));
  assert.ok(G.players[1].marks[20] === 3 && G.players[1].pts === 0, 'closing 20 against a closed 20 scores nothing');
  E.nextTurn(G);
  ev = E.throwDart(G, H(20, 3));
  assert.ok(ev.scored === 0 && G.players[0].pts === 40, 'a dead number scores nothing');
  // the bull: 25 is one mark, the inner bull two
  E.throwDart(G, H(25, 2)); E.throwDart(G, H(25, 1));
  assert.strictEqual(G.players[0].marks[25], 3);
  E.nextTurn(G);
  // close the rest for A and win with the lead
  E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.nextTurn(G);
  [19, 18].forEach(function (n) { E.throwDart(G, H(n, 3)); });
  E.throwDart(G, H(17, 3)); E.nextTurn(G);
  E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0)); E.nextTurn(G);
  E.throwDart(G, H(16, 3));
  ev = E.throwDart(G, H(15, 3));
  assert.ok(ev.legWon && G.phase === 'over' && G.winner === 0 && E.cricketClosedAll(G.players[0]));
});

test('cricket: closing out while behind on points does not win', function () {
  var G = E.newGame({ mode: 'cricket', players: [{ name: 'A' }, { name: 'B' }] });
  E.CRICKET_NUMS.forEach(function (n) { G.players[0].marks[n] = 3; });
  G.players[0].marks[15] = 2; G.players[1].pts = 60;
  var ev = E.throwDart(G, H(15, 1));
  assert.ok(!ev.legWon && G.phase === 'aim' && E.cricketClosedAll(G.players[0]));
});

test('cricket: the round cap decides on points', function () {
  var G = E.newGame({ mode: 'cricket', players: [{ name: 'A' }, { name: 'B' }] });
  for (var r = 0; r < E.CRICKET_ROUNDS * 2 && G.phase !== 'over'; r++) {
    E.throwDart(G, H(G.cur === 0 ? 20 : 1, 1)); E.throwDart(G, H(0, 0)); E.throwDart(G, H(0, 0));
    if (G.phase === 'turnover') E.nextTurn(G);
  }
  assert.ok(G.phase === 'over' && G.winner === 0 && G.round === E.CRICKET_ROUNDS, 'round ' + G.round);
});

test('around the clock: in order, doubles and trebles skip, the bull ends it', function () {
  var G = E.newGame({ mode: 'atc', players: [{}] });
  E.throwDart(G, H(2, 1));
  assert.strictEqual(G.players[0].idx, 0, 'out of order does not count');
  E.throwDart(G, H(1, 3));
  assert.strictEqual(E.atcTarget(G.players[0]), 4);
  E.throwDart(G, H(4, 2));
  assert.strictEqual(E.atcTarget(G.players[0]), 6);
  G.players[0].idx = 19; E.nextTurn(G);
  E.throwDart(G, H(20, 3));
  assert.strictEqual(E.atcTarget(G.players[0]), 25, 'a treble 20 cannot skip the bull');
  var ev = E.throwDart(G, H(25, 1));
  assert.ok(ev.legWon && G.phase === 'over' && G.players[0].bestLeg === G.players[0].darts);
});

test('practice: never ends, counts a 3-dart average', function () {
  var G = E.newGame({ mode: 'practice', players: [{}, { cpu: 3 }] });
  assert.strictEqual(G.players.length, 1, 'practice is solo');
  for (var i = 0; i < 30; i++) { E.throwDart(G, H(20, 1)); if (G.phase === 'turnover') E.nextTurn(G); }
  assert.ok(G.phase === 'aim' && Math.abs(E.avg3(G.players[0]) - 60) < 1e-9 && G.players[0].best3 === 60);
});

test('CPU targets are sensible and legal', function () {
  var lv = E.CPU_LEVELS[3];
  assert.deepStrictEqual(E.x01Target(501, 3, true, lv), H(20, 3));
  assert.deepStrictEqual(E.x01Target(40, 3, true, lv), H(20, 2));
  assert.deepStrictEqual(E.x01Target(100, 2, true, lv), H(20, 3));
  assert.deepStrictEqual(E.x01Target(170, 3, true, lv), H(20, 3));
  // a 1-dart-left 41 can't be checked out: set up a double instead, never bust
  var t = E.x01Target(41, 1, true, lv);
  assert.ok(!E.busts(41, t, true) && 41 - E.value(t) >= 2);
  for (var rem = 2; rem <= 501; rem++) {
    for (var d = 1; d <= 3; d++) {
      var tg = E.x01Target(rem, d, true, E.CPU_LEVELS[1]);
      assert.ok(E.ORDER.indexOf(tg.n) >= 0 || tg.n === 25, rem + ' → ' + JSON.stringify(tg));
      assert.ok(!E.busts(rem, tg, true), rem + '/' + d + ' aims a bust: ' + E.label(tg));
    }
  }
  // cricket: goes for the highest open number, scores when behind on something it owns
  var G = E.newGame({ mode: 'cricket', players: [{}, { cpu: 4 }] });
  G.cur = 1;
  assert.deepStrictEqual(E.cpuTarget(G), H(20, 3));
  G.players[1].marks[20] = 3; G.players[0].pts = 40;
  assert.deepStrictEqual(E.cpuTarget(G), H(20, 3), 'scores on its own 20 while behind');
  G.players[0].marks[20] = 3;
  assert.deepStrictEqual(E.cpuTarget(G), H(19, 3), 'a dead 20 is left alone');
  // around the clock
  G = E.newGame({ mode: 'atc', players: [{}, { cpu: 1 }] }); G.cur = 1;
  assert.deepStrictEqual(E.cpuTarget(G), H(1, 1));
});

test('CPU matches finish, are reproducible, and stronger levels score more', function () {
  var avgs = [];
  for (var lvl = 1; lvl <= 4; lvl++) {
    var tot = 0;
    for (var s = 1; s <= 12; s++) {
      var G = E.simulate({ mode: 'x01', players: [{}, { cpu: lvl }] }, s * 31 + lvl);
      assert.ok(G.phase === 'over' && G.winner >= 0, 'x01 L' + lvl + ' seed ' + s);
      assert.strictEqual(G.players[G.winner].score, 0);
      tot += E.avg3(G.players[1]);
    }
    avgs.push(tot / 12);
    var C = E.simulate({ mode: 'cricket', players: [{}, { cpu: lvl }, { cpu: lvl }] }, lvl * 7);
    assert.ok(C.phase === 'over', 'cricket L' + lvl);
    var A = E.simulate({ mode: 'atc', players: [{}, { cpu: lvl }] }, lvl * 11);
    assert.ok(A.phase === 'over' && A.players[A.winner].idx === E.ATC_SEQ.length, 'atc L' + lvl);
  }
  for (var i = 1; i < 4; i++) assert.ok(avgs[i] > avgs[i - 1], 'levels ordered: ' + avgs.map(Math.round).join(' < '));
  assert.ok(avgs[0] > 20 && avgs[3] < 110, 'sane averages ' + avgs.map(Math.round).join(','));
  var a = E.simulate({ mode: 'x01', players: [{}, { cpu: 3 }] }, 99), b = E.simulate({ mode: 'x01', players: [{}, { cpu: 3 }] }, 99);
  assert.deepStrictEqual(a, b);
  var c = E.simulate({ mode: 'x01', players: [{}, { cpu: 3 }] }, 100);
  assert.notDeepStrictEqual(a.players, c.players);
});

test('scatter is centred with the right spread', function () {
  var r = E.rng(5), sx = 0, sy = 0, s2 = 0, n = 4000;
  for (var i = 0; i < n; i++) { var p = E.scatter(0.2, -0.1, 0.1, r); sx += p.x; sy += p.y; s2 += (p.x - 0.2) * (p.x - 0.2); }
  assert.ok(Math.abs(sx / n - 0.2) < 0.01 && Math.abs(sy / n + 0.1) < 0.01);
  assert.ok(Math.abs(Math.sqrt(s2 / n) - 0.1) < 0.008);
});

test('options are normalised', function () {
  var o = E.normOpts({ mode: 'nope', start: 999, legs: 9, players: [{ cpu: 3 }, { cpu: 99, name: 'A very long name indeed' }, {}, {}, {}, {}] });
  assert.ok(o.mode === 'x01' && o.start === 501 && o.legs === 3 && o.players.length === 4);
  assert.strictEqual(o.players[0].cpu, 0, 'seat one is always a person');
  assert.strictEqual(o.players[1].cpu, 4);
  assert.ok(o.players[1].name.length <= 12);
  assert.strictEqual(E.normOpts({ mode: 'cricket', legs: 3 }).legs, 1);
  assert.strictEqual(E.normOpts(null).players.length, 1);
});

test('save: normalised, stats settle, matches resume', function () {
  var s = E.newSave();
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({ setup: { mode: 'golf', start: 3, legs: -2, opp: 'x', level: 9, hand: 'a' }, stats: { x01: { games: -4, darts: 'x' }, cpu: [1, -1] }, match: { v: 1, players: 'no' } });
  assert.ok(bad.setup.mode === 'x01' && bad.setup.start === 501 && bad.setup.legs === 1 && bad.setup.opp === 'cpu' && bad.setup.level === 4 && bad.setup.hand === 1);
  assert.ok(bad.stats.x01.games === 0 && bad.stats.x01.darts === 0 && bad.stats.cpu[0] === 1 && bad.stats.cpu[1] === 0 && bad.match === null);
  assert.strictEqual(E.normSave('junk').setup.mode, 'x01');
  // settle a won x01 match against a Hard CPU
  var G = E.newGame({ mode: 'x01', start: 301, players: [{ name: 'You' }, { name: 'CPU', cpu: 3 }] });
  for (var i = 0; i < 4; i++) {
    E.throwDart(G, H(20, 3)); E.throwDart(G, H(20, 1)); E.throwDart(G, H(5, 1));
    E.nextTurn(G); E.throwDart(G, H(1, 1)); E.throwDart(G, H(1, 1)); E.throwDart(G, H(1, 1)); E.nextTurn(G);
  }
  // 301 - 4*85 < 0? no: 301-255=46 after 3 turns; the 4th turn busted on 46 → check state
  assert.strictEqual(G.players[0].score, 46);
  E.throwDart(G, H(6, 1)); E.throwDart(G, H(20, 2));
  assert.strictEqual(G.phase, 'over');
  var best = E.settle(s, G);
  assert.ok(s.stats.x01.games === 1 && s.stats.x01.wins === 1 && s.stats.cpu[2] === 1 && s.stats.cpuGames[2] === 1);
  assert.ok(best.hiOut && s.stats.x01.hiOut === 46 && s.stats.x01.bestLeg === G.players[0].darts);
  // a match in progress survives a round trip through JSON; junk doesn't
  var M = E.newGame({ mode: 'cricket', players: [{ name: 'You' }, { name: 'P2' }] });
  E.throwDart(M, H(20, 3)); E.throwDart(M, H(20, 1)); E.throwDart(M, H(19, 1)); E.nextTurn(M);
  var back = E.normMatch(JSON.parse(JSON.stringify(M)));
  assert.ok(back && back.cur === 1 && back.players[0].marks[20] === 3 && back.players[0].pts === 20 && back.players[0].marks[19] === 1);
  assert.strictEqual(E.normMatch({ v: 1, mode: 'x01', o: { mode: 'x01' }, players: [{}], phase: 'over' }), null);
  assert.strictEqual(E.normMatch({ v: 2 }), null);
  var x = E.newGame({ mode: 'x01', players: [{}, { cpu: 2 }] });
  var raw = JSON.parse(JSON.stringify(x)); raw.players[0].score = -50;
  assert.ok(E.normMatch(raw).players[0].score >= 2);
});

test('review: any-out CPU never aims a bust, and a 1 left is a valid any-out score', function () {
  for (var r = 1; r <= 501; r++) for (var l = 1; l <= 3; l++) E.CPU_LEVELS.forEach(function (lv) {
    var t = E.x01Target(r, l, false, lv);
    assert.ok(!E.busts(r, H(t.n, t.m), false), 'any-out ' + r + '/' + l + ' aims ' + E.label(t));
    var u = E.x01Target(r, l, true, lv);
    if (r >= 2) assert.ok(!E.busts(r, H(u.n, u.m), true) || r < 2, 'double-out ' + r + '/' + l + ' aims ' + E.label(u));
  });
  var G = E.newGame({ mode: 'x01', start: 301, doubleOut: false, players: [{ name: 'You' }] });
  E.throwDart(G, H(20, 3)); E.throwDart(G, H(20, 3)); E.throwDart(G, H(20, 3)); E.nextTurn(G);
  E.throwDart(G, H(20, 3)); E.throwDart(G, H(20, 3));
  assert.strictEqual(G.players[0].score, 1);
  assert.strictEqual(E.normMatch(JSON.parse(JSON.stringify(G))).players[0].score, 1);
  E.throwDart(G, H(1, 1));
  assert.strictEqual(G.phase, 'over');
});

test('review: a half-thrown turn resumes with its darts, not three fresh ones', function () {
  var G = E.newGame({ mode: 'x01', start: 501, players: [{ name: 'You' }, { name: 'CPU', cpu: 2 }] });
  E.throwDart(G, H(20, 3)); E.throwDart(G, H(19, 3));
  var B = E.normMatch(JSON.parse(JSON.stringify(G)));
  assert.strictEqual(B.turn.length, 2);
  assert.strictEqual(B.turnStart, 501);
  assert.strictEqual(B.players[0].score, 384);
  E.throwDart(B, H(1, 1));                       // third dart ends the turn
  assert.strictEqual(B.phase, 'turnover');
  // a bust on the resumed dart restores the true turn start
  var C = E.newGame({ mode: 'x01', start: 301, players: [{ name: 'You' }] });
  C.players[0].score = 40; C.turnStart = 40;
  E.throwDart(C, H(20, 1));
  var D = E.normMatch(JSON.parse(JSON.stringify(C)));
  E.throwDart(D, H(20, 3));
  assert.ok(D.last.bust && D.players[0].score === 40);
  // junk turn entries are scrubbed
  var raw = JSON.parse(JSON.stringify(G)); raw.turn = [{ n: 99, m: 7 }, 'x'];
  var J = E.normMatch(raw);
  assert.ok(J.turn.length === 2 && J.turn[0].n === 0 && J.turn[1].lbl === 'MISS');
});

test('review: the cricket round cap counts the last turn once', function () {
  var G = E.newGame({ mode: 'cricket', players: [{ name: 'A' }, { name: 'B' }] });
  for (var r = 0; r < E.CRICKET_ROUNDS * 2 && G.phase !== 'over'; r++) {
    E.throwDart(G, H(G.cur ? 2 : 20, 1)); E.throwDart(G, H(2, 1)); E.throwDart(G, H(2, 1));
    if (G.phase === 'turnover') E.nextTurn(G);
  }
  assert.strictEqual(G.phase, 'over');
  assert.strictEqual(G.players[0].turns, E.CRICKET_ROUNDS);
  assert.strictEqual(G.players[1].turns, E.CRICKET_ROUNDS);
  assert.strictEqual(G.winner, 0);
});

test('review: every CPU dart in random matches is a legal hit and the turn order holds', function () {
  ['x01', 'cricket', 'atc'].forEach(function (mode) {
    for (var seed = 1; seed <= 25; seed++) {
      var G = E.simulate({ mode: mode, start: 301, doubleOut: seed % 2 === 0, legs: 1 + (seed % 3), players: [{ name: 'You' }, { cpu: 1 + seed % 4 }, { cpu: 1 }].slice(0, 2 + seed % 2) }, seed);
      assert.strictEqual(G.phase, 'over', mode + ' seed ' + seed + ' did not finish');
      G.players.forEach(function (p) {
        assert.ok(p.darts > 0 && isFinite(p.points));
        if (mode === 'x01') assert.ok(p.score >= 0);
      });
    }
  });
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
