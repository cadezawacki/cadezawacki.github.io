/* Headless checks for Chess Puzzles: every bundled puzzle is proven (forced
 * mate in exactly n, unique first move, a main line that ends in mate), plus
 * the rating, daily, picking and save logic. Not loaded by the app.
 * Run: node txt/widgets/chesspuzzles/chesspuzzles.test.js */
'use strict';
var assert = require('assert'), path = require('path');
var E = require('../chess/chess-engine.js');
var H = require('./chesspuzzles.js');

var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, baseURL: function () { return 'http://x/txt/widgets/chesspuzzles/'; }, asset: function (p) { return 'http://x/txt/widgets/chesspuzzles/' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./chesspuzzles.js')];
require('./chesspuzzles.js');
require(path.join(__dirname, 'chesspuzzles-data.js'));
var DATA = global.window.__cadeChessPuzzles;
delete global.window;
var PZ = H.parsePuzzles(DATA);

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Chess Puzzles' && typeof widget.open === 'function');
  assert.deepStrictEqual(css, ['chesspuzzles.css']);
});
test('the bundle: 150+ puzzles, all three lengths, well-formed and distinct', function () {
  assert.ok(PZ.length >= 150, PZ.length + ' puzzles');
  var byN = { 1: 0, 2: 0, 3: 0 }, seen = {};
  PZ.forEach(function (p) {
    byN[p.n]++;
    assert.ok(p.rating >= 400 && p.rating <= 2400);
    assert.strictEqual(p.line.length, 2 * p.n - 1, '#' + p.id + ' line length');
    var key = p.fen.split(' ').slice(0, 2).join(' ');
    assert.ok(!seen[key], '#' + p.id + ' duplicate position'); seen[key] = 1;
  });
  assert.ok(byN[1] >= 40 && byN[2] >= 40 && byN[3] >= 30, JSON.stringify(byN));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(DATA.epoch));
});
test('every puzzle: forced mate in exactly n, unique first move, main line ends in mate', function () {
  var t0 = Date.now();
  PZ.forEach(function (p) {
    var v = E.verifyPuzzle(p.fen, p.n);
    assert.ok(v.ok, '#' + p.id + ' ' + p.fen + ': ' + v.why);
    assert.strictEqual(v.uci, p.line[0], '#' + p.id + ' first move');
    var r = E.replay(p.fen, p.line);
    assert.ok(r, '#' + p.id + ' illegal line');
    assert.strictEqual(E.status(r.pos).reason, 'checkmate', '#' + p.id + ' line does not mate');
    // each defence in the line is the most stubborn one
    var pos = E.fromFEN(p.fen), memo = new Map();
    for (var i = 0; i < p.line.length; i++) {
      var m = E.fromUCI(pos, p.line[i]);
      pos.make(m);
      if (i % 2 === 0 && i + 1 < p.line.length) {
        var left = p.n - (i >> 1) - 1, d = E.bestDefence(pos, left, memo);
        var want = E.fromUCI(pos, p.line[i + 1]);
        pos.make(want); var kWant = E.mateDistance(pos, left, memo); pos.unmake();
        assert.strictEqual(kWant, d.n, '#' + p.id + ' defence at ply ' + (i + 1) + ' is not the longest');
      }
    }
  });
  assert.ok(Date.now() - t0 < 120000, 'verification is slow: ' + (Date.now() - t0) + ' ms');
});
test('judge: the first move and duals; wrong moves are wrong', function () {
  var p = PZ.filter(function (q) { return q.n === 2; })[0], pos = E.fromFEN(p.fen);
  var first = E.fromUCI(pos, p.line[0]);
  assert.strictEqual(H.judge(E, pos, first, 2, new Map()), 'ok');
  var others = pos.legalMoves().filter(function (m) { return m !== first; });
  others.slice(0, 8).forEach(function (m) { assert.strictEqual(H.judge(E, pos, m, 2, new Map()), 'wrong'); });
  var m1 = PZ.filter(function (q) { return q.n === 1; })[0], p1 = E.fromFEN(m1.fen);
  assert.strictEqual(H.judge(E, p1, E.fromUCI(p1, m1.line[0]), 1), 'mate');
  // judge leaves the position untouched
  assert.strictEqual(pos.fen(), p.fen);
});
test('daily: one puzzle a day, cycles through the bundle', function () {
  var n = PZ.length;
  assert.strictEqual(H.dailyIndex(DATA.epoch, DATA.epoch, n), 0);
  assert.strictEqual(H.dailyIndex('2026-11-02', '2026-11-01', n), 1);
  assert.strictEqual(H.dailyIndex('2026-10-31', '2026-11-01', n), n - 1);
  assert.strictEqual(H.dailyIndex('2027-01-01', '2026-11-01', 10), 61 % 10);
  assert.strictEqual(H.ymd(new Date(2026, 0, 5)), '2026-01-05');
});
test('rating: solves go up, misses go down, against the puzzle\'s rating', function () {
  assert.ok(H.rateAfter(1000, 1000, true, 30) > 1000 && H.rateAfter(1000, 1000, false, 30) < 1000);
  assert.ok(H.rateAfter(1000, 1600, true, 30) - 1000 > H.rateAfter(1000, 800, true, 30) - 1000, 'a harder solve gains more');
  assert.ok(H.rateAfter(1000, 400, true, 30) > 1000, 'any solve gains something');
  assert.ok(H.rateAfter(100, 2000, false, 0) >= 100 && H.rateAfter(3000, 400, true, 0) <= 3000);
  assert.ok(Math.abs(H.expected(1200, 1200) - 0.5) < 1e-9);
});
test('rated picks stay near the rating and avoid recent puzzles', function () {
  var r = E.rng(3), recent = [];
  for (var i = 0; i < 60; i++) {
    var p = H.pickRated(PZ, 1300, recent, r);
    assert.ok(p && recent.indexOf(p.id) < 0);
    assert.ok(Math.abs(p.rating - 1300) <= 500, 'picked ' + p.rating);
    recent.push(p.id); if (recent.length > 30) recent.shift();
  }
  assert.ok(H.pickRated(PZ, 5000, [], r), 'an extreme rating still gets a puzzle');
});
test('practice walks the filter, unsolved first', function () {
  var solved = {}, m2 = PZ.filter(function (q) { return q.n === 2; });
  var a = H.nextPractice(PZ, 2, solved, 0);
  assert.strictEqual(a.id, m2[0].id);
  solved[m2[1].id] = 1;
  assert.strictEqual(H.nextPractice(PZ, 2, solved, a.id).id, m2[2].id);
  m2.forEach(function (q) { solved[q.id] = 1; });
  assert.strictEqual(H.nextPractice(PZ, 2, solved, m2[m2.length - 1].id).id, m2[0].id, 'all solved: wraps around');
});
test('settle: rated streaks and rating, daily streaks across days', function () {
  var s = H.newSave(), p = PZ[0];
  var r1 = H.settle(s, p, 'rated', true, true);
  assert.ok(r1.delta > 0 && s.streak === 1 && s.solved[p.id] === 1 && s.played === 1);
  H.settle(s, PZ[1], 'rated', true, false);
  assert.strictEqual(s.streak, 0, 'a helped solve breaks the streak'); assert.strictEqual(s.solved[PZ[1].id], 2);
  H.settle(s, PZ[2], 'daily', true, true, '2026-11-01');
  H.settle(s, PZ[3], 'daily', true, false, '2026-11-02');
  assert.strictEqual(s.dailyStreak, 2);
  H.settle(s, PZ[3], 'daily', false, false, '2026-11-02');
  assert.strictEqual(s.daily['2026-11-02'], 'solved', 'a day is settled once');
  H.settle(s, PZ[4], 'daily', true, true, '2026-11-05');
  assert.strictEqual(s.dailyStreak, 1, 'a missed day restarts the streak'); assert.strictEqual(s.bestDaily, 2);
});
test('save normalisation is defensive', function () {
  assert.deepStrictEqual(H.normSave(null), H.newSave());
  var s = H.normSave({ rating: 'x', peak: 9999, streak: -3, solved: { 1: 1, 2: 5, 999: 1, a: 1 }, recent: [1, 'b', 3, 999], daily: { '2026-11-01': 'clean', nope: 'clean', '2026-11-02': 'meh' }, mode: 'rated', filter: 7, lastDaily: 'x' }, 172);
  assert.strictEqual(s.rating, 800); assert.strictEqual(s.peak, 3000); assert.strictEqual(s.streak, 0);
  assert.deepStrictEqual(s.solved, { 1: 1 }); assert.deepStrictEqual(s.recent, [1, 3]);
  assert.deepStrictEqual(s.daily, { '2026-11-01': 'clean' }); assert.strictEqual(s.mode, 'rated'); assert.strictEqual(s.filter, 0); assert.strictEqual(s.lastDaily, '');
});

test('practice resumes the puzzle you were on, or the next one once it is solved', function () {
  var a = H.resumePractice(PZ, 0, {}, 5);
  assert.strictEqual(a.id, 5);
  var solved = {}; solved[5] = 1;
  var b = H.resumePractice(PZ, 0, solved, 5);
  assert.ok(b.id !== 5 && !solved[b.id]);
  var c = H.resumePractice(PZ, 3, {}, PZ.filter(function (p) { return p.n === 1; })[0].id);
  assert.strictEqual(c.n, 3);
  assert.ok(H.resumePractice(PZ, 2, {}, 0).n === 2);
});

console.log(passed + ' passed');
