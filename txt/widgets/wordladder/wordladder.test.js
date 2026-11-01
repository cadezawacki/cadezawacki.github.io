/* Headless checks for the Word Ladder engine (word lists, solver, rules,
 * scoring, CPU racer, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/wordladder/wordladder.test.js */
'use strict';
var assert = require('assert');
var path = require('path');

var E = require('./wordladder.js');
var D = require('./wordladder-words.js');
var widget = null, css = [], assets = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { assets.push(p); return p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./wordladder.js')];
require('./wordladder.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var LEX = E.parseLists(D);

test('registers as a widget with its css and word file', function () {
  assert.ok(widget && widget.name === 'Word Ladder' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'wordladder.css');
  assert.deepStrictEqual(assets, ['wordladder-words.js']);
  assert.deepStrictEqual(widget._engine.RANGES, E.RANGES);
  assert.strictEqual(typeof widget._engine.solve, 'function');
});

test('word lists: sorted, right lengths, disjoint tiers, sensible sizes', function () {
  E.LENS.forEach(function (n) {
    var L = LEX[n];
    assert.ok(L.core.length > 300, n + ' core ' + L.core.length);
    assert.ok(L.validSet.size > L.solve.length, n + ' valid > solve');
    L.solve.forEach(function (w) { assert.strictEqual(w.length, n); assert.ok(/^[a-z]+$/.test(w)); assert.ok(L.validSet.has(w)); });
    for (var i = 1; i < L.core.length; i++) assert.ok(L.core[i - 1] < L.core[i], 'core sorted/unique ' + L.core[i]);
    ['core', 'common', 'extra'].forEach(function (k) { assert.strictEqual(D[n][k].length % n, 0); });
  });
  ['cold', 'cord', 'card', 'ward', 'warm', 'cat', 'dog', 'stone', 'money'].forEach(function (w) { assert.ok(LEX[w.length].validSet.has(w), w); });
});

test('no crude words in the puzzle tiers', function () {
  var rot = function (s) { return s.replace(/[a-z]/g, function (c) { return String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97); }); };
  rot('shpx fuvg phag ovgpu juber fyhg chffl').split(' ').forEach(function (w) {
    assert.ok(!LEX[w.length].solveSet.has(w), 'solver has a crude word');
  });
});

test('oneApart / diffAt / matches', function () {
  assert.ok(E.oneApart('cold', 'cord'));
  assert.ok(!E.oneApart('cold', 'cold'));
  assert.ok(!E.oneApart('cold', 'card'));
  assert.ok(!E.oneApart('cold', 'colds'));
  assert.strictEqual(E.diffAt('cold', 'cord'), 2);
  assert.strictEqual(E.matches('ward', 'warm'), 3);
});

test('BFS solver finds a shortest valid ladder', function () {
  var p = E.solve(LEX[4], 'cold', 'warm');
  assert.ok(p, 'cold→warm solvable');
  assert.strictEqual(p[0], 'cold'); assert.strictEqual(p[p.length - 1], 'warm');
  assert.strictEqual(p.length - 1, 4, 'cold→warm in 4');
  for (var i = 1; i < p.length; i++) { assert.ok(E.oneApart(p[i - 1], p[i])); assert.ok(LEX[4].solveSet.has(p[i])); }
  var d = E.distances(LEX[4], 'cold');
  assert.strictEqual(d.get('warm'), 4);
  assert.deepStrictEqual(E.solve(LEX[3], 'cat', 'cat'), ['cat']);
  assert.strictEqual(E.solve(LEX[3], 'cat', 'zzzz'), null);
  // avoid set is honoured
  var p2 = E.solve(LEX[4], 'cold', 'warm', new Set([p[1]]));
  assert.ok(p2 && p2.indexOf(p[1]) < 0);
});

test('random puzzles are solvable and in their par range', function () {
  var r = E.rng(123);
  E.LENS.forEach(function (n) {
    E.DIFFS.forEach(function (diff) {
      for (var k = 0; k < 6; k++) {
        var pz = E.genPuzzle(LEX, n, diff, r);
        assert.ok(pz, n + diff);
        assert.ok(LEX[n].coreSet.has(pz.start) && LEX[n].coreSet.has(pz.end));
        var path = E.solve(LEX[n], pz.start, pz.end);
        assert.ok(path, 'solvable ' + pz.start + '→' + pz.end);
        assert.strictEqual(path.length - 1, pz.par, 'par is the shortest');
        assert.ok(pz.par >= 2);
        var R = E.RANGES[n][diff];
        assert.ok(pz.par >= R[0] - 1 && pz.par <= R[1] + 3, n + ' ' + diff + ' par ' + pz.par);
      }
    });
  });
});

test('daily puzzle is deterministic per day and length, varies across days', function () {
  var a = E.dailyPuzzle(LEX, 4, 1000), b = E.dailyPuzzle(LEX, 4, 1000), c = E.dailyPuzzle(LEX, 4, 1001), d = E.dailyPuzzle(LEX, 5, 1000);
  assert.deepStrictEqual(a, b);
  assert.ok(a.start + a.end !== c.start + c.end);
  assert.strictEqual(d.n, 5);
  assert.strictEqual(a.day, 1000);
  for (var day = 900; day < 930; day++) E.LENS.forEach(function (n) {
    var p = E.dailyPuzzle(LEX, n, day);
    assert.ok(p && E.solve(LEX[n], p.start, p.end).length - 1 === p.par, 'daily ' + day + ' ' + n);
  });
  var t = new Date(2024, 0, 1, 15, 0), t2 = new Date(2024, 0, 2, 0, 5);
  assert.strictEqual(E.dayNumber(t), 0); assert.strictEqual(E.dayNumber(t2), 1);
});

test('rules: each rung changes one letter and is a word; the end auto-completes', function () {
  var g = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  assert.strictEqual(E.check(LEX, g, 'col').err, 'length');
  assert.strictEqual(E.check(LEX, g, 'cxld').err, 'unknown');
  assert.strictEqual(E.check(LEX, g, 'cold').err, 'same');
  assert.strictEqual(E.check(LEX, g, 'card').err, 'notone');
  assert.ok(E.climb(LEX, g, 'CORD').ok, 'case-insensitive');
  assert.strictEqual(E.check(LEX, g, 'cold').err, 'repeat');
  assert.ok(E.climb(LEX, g, 'card').ok);
  var r = E.climb(LEX, g, 'ward');
  assert.ok(r.ok && r.auto && r.finished, 'ward is one from warm: done');
  assert.deepStrictEqual(g.rungs, ['cold', 'cord', 'card', 'ward', 'warm']);
  assert.ok(g.done && g.solved);
  assert.strictEqual(E.moves(g), 4);
  assert.strictEqual(E.check(LEX, g, 'word').err, 'done');
  var sc = E.score(g);
  assert.strictEqual(sc.diff, 0); assert.strictEqual(sc.label, 'Par'); assert.strictEqual(sc.stars, 3);
});

test('rare (extra) words are accepted as rungs', function () {
  var L = LEX[4], extra = null;
  L.validSet.forEach(function (w) { if (!extra && !L.solveSet.has(w) && E.neighbors(L, w).length) extra = w; });
  assert.ok(extra);
  var nb = E.neighbors(L, extra)[0];
  var g = E.newGame({ n: 4, start: nb, end: L.core[0] === nb ? L.core[1] : L.core[0], par: 9 });
  var r = E.climb(LEX, g, extra);
  assert.ok(r.ok, 'extra word ' + extra + ' after ' + nb);
});

test('undo and hint', function () {
  var g = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  assert.strictEqual(E.undo(g), null);
  E.climb(LEX, g, 'bold');
  assert.strictEqual(E.undo(g), 'bold');
  assert.deepStrictEqual(g.rungs, ['cold']);
  var h = E.hint(LEX, g);
  assert.ok(h.word && E.oneApart('cold', h.word) && h.left === 4);
  // following hints always finishes at par
  for (var i = 0; i < 10 && !g.done; i++) { var hh = E.hint(LEX, g); assert.ok(E.climb(LEX, g, hh.word).ok); g.hints++; }
  assert.ok(g.solved); assert.strictEqual(E.moves(g), 4);
  var sc = E.score(g);
  assert.ok(sc.stars < 3 && sc.points < 100);
  // a detour then hints still finishes
  var g2 = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  E.climb(LEX, g2, 'bold'); E.climb(LEX, g2, 'bolt');
  while (!g2.done) { var h2 = E.hint(LEX, g2); assert.ok(h2 && h2.word, 'hint from ' + E.last(g2)); E.climb(LEX, g2, h2.word); }
  assert.ok(E.score(g2).diff > 0);
});

test('hint suggests stepping back from a dead end', function () {
  var L = LEX[5], dead = null;
  // a valid word whose only common neighbour is its predecessor
  for (var k = 0; k < L.solve.length && !dead; k++) {
    var w = L.solve[k], nb = E.neighbors(L, w);
    if (nb.length === 1 && L.coreSet.has(nb[0])) dead = [nb[0], w];
  }
  assert.ok(dead, 'found a dead end');
  var end = L.core.find(function (w) { return w !== dead[0] && w !== dead[1] && !E.oneApart(w, dead[1]) && E.solve(L, dead[0], w); });
  var g = E.newGame({ n: 5, start: dead[0], end: end, par: 5 });
  if (!E.oneApart(dead[1], end)) {
    assert.ok(E.climb(LEX, g, dead[1]).ok);
    assert.ok(E.hint(LEX, g).back);
  }
});

test('reveal gives up with a shortest solution; scoring labels', function () {
  var g = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  E.climb(LEX, g, 'bold');
  var sol = E.reveal(LEX, g);
  assert.strictEqual(sol.length - 1, 4);
  assert.ok(g.done && !g.solved && g.revealed);
  assert.strictEqual(E.score(g).points, 0);
  var f = function (m, par, h) { var x = E.newGame({ n: 4, start: 'aaaa', end: 'bbbb', par: par }); x.rungs = new Array(m + 1).fill('x'); x.done = x.solved = true; x.hints = h || 0; return E.score(x); };
  assert.strictEqual(f(3, 4).label, 'Birdie! -1');
  assert.ok(f(3, 4).points > f(4, 4).points);
  assert.ok(f(4, 4).points > f(5, 4).points);
  assert.strictEqual(f(6, 4).label, 'Double bogey +2');
  assert.ok(f(30, 4).points >= 10, 'never below 10 when solved');
});

test('2-player compare: solved > fewer moves (+hints) > faster', function () {
  var a = { solved: true, moves: 5, hints: 0, time: 50 }, b = { solved: true, moves: 6, hints: 0, time: 20 };
  assert.strictEqual(E.compare(a, b), 1);
  assert.strictEqual(E.compare(b, a), 2);
  assert.strictEqual(E.compare({ solved: true, moves: 4, hints: 2, time: 10 }, a), 2);
  assert.strictEqual(E.compare({ solved: true, moves: 5, hints: 0, time: 40 }, a), 1);
  assert.strictEqual(E.compare({ solved: false, moves: 2, hints: 0, time: 1 }, a), 2);
  assert.strictEqual(E.compare({ solved: false, moves: 2, hints: 0, time: 1 }, { solved: false, moves: 9, hints: 0, time: 9 }), 0);
  assert.strictEqual(E.compare(a, { solved: true, moves: 5, hints: 0, time: 50.05 }), 0);
});

test('CPU racer: legal ladder, monotone timing, levels ordered', function () {
  var p = E.genPuzzle(LEX, 4, 'medium', E.rng(5)), tot = {};
  E.DIFFS.forEach(function (lv) {
    var sum = 0;
    for (var s = 1; s <= 40; s++) {
      var plan = E.cpuPlan(LEX, p, lv, E.rng(s));
      for (var i = 1; i < plan.path.length; i++) assert.ok(E.oneApart(plan.path[i - 1], plan.path[i]));
      assert.strictEqual(plan.times.length, p.par + plan.wasted);
      for (i = 1; i < plan.times.length; i++) assert.ok(plan.times[i] > plan.times[i - 1]);
      assert.strictEqual(E.cpuAt(plan, 0), 0);
      assert.ok(E.cpuProgress(plan, plan.total).done);
      assert.ok(!E.cpuProgress(plan, plan.total - 0.01).done);
      if (lv === 'hard') assert.strictEqual(plan.wasted, 0);
      sum += plan.total;
    }
    tot[lv] = sum / 40;
  });
  assert.ok(tot.easy > tot.medium && tot.medium > tot.hard, JSON.stringify(tot));
  // deterministic for a seed
  assert.deepStrictEqual(E.cpuPlan(LEX, p, 'easy', E.rng(9)), E.cpuPlan(LEX, p, 'easy', E.rng(9)));
});

test('save normalisation is defensive', function () {
  var s = E.normSave(null);
  assert.strictEqual(s.len, 4); assert.deepStrictEqual(s.games.practice, {});
  s = E.normSave({ len: 9, diff: 'insane', cpu: 'x', stats: { 4: { played: -3, solved: 'NaN', dist: [1, 'a'] } }, daily: { streak: 'z', done: { 'bad': 1, '10:4': { m: 5, p: 4, ok: 1 } } }, race: { easy: { w: 3 } }, games: { practice: { n: 4, start: 'cold', end: 'warm', rungs: ['cold', 'card'] } } });
  assert.strictEqual(s.len, 4); assert.strictEqual(s.diff, 'medium'); assert.strictEqual(s.cpu, 'medium');
  assert.strictEqual(s.stats[4].played, 0); assert.strictEqual(s.stats[4].solved, 0); assert.strictEqual(s.stats[4].dist[0], 1);
  assert.deepStrictEqual(Object.keys(s.daily.done), ['10:4']);
  assert.ok(s.daily.done['10:4'].ok);
  assert.strictEqual(s.race.easy.w, 3);
  assert.deepStrictEqual(s.games.practice, {}, 'illegal ladder dropped');
  var g = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  E.climb(LEX, g, 'cord'); g.hints = 1; g.time = 12.5;
  var round = E.normSave(JSON.parse(JSON.stringify({ games: { practice: g, daily: { n: 4, start: 'cold', end: 'warm', rungs: ['cold'], par: 4 } } })));
  assert.deepStrictEqual(round.games.practice[4].rungs, ['cold', 'cord']);
  assert.strictEqual(round.games.practice[4].hints, 1);
  assert.deepStrictEqual(round.games.daily, {}, 'daily without a day dropped');
  assert.doesNotThrow(function () { E.normSave('junk'); E.normSave({ stats: 5, daily: [], games: 'x' }); });
});

test('record: stats, daily streak counted once per day and length', function () {
  var sv = E.newSave();
  function play(day, n, solved) {
    var p = E.dailyPuzzle(LEX, n, day), g = E.newGame(p), path = E.solve(LEX[n], p.start, p.end);
    if (solved) { for (var i = 1; i < path.length; i++) E.climb(LEX, g, path[i]); } else E.reveal(LEX, g);
    g.time = 30;
    return E.record(sv, 'daily', g);
  }
  var r = play(100, 4, true);
  assert.strictEqual(r.streak, 1); assert.strictEqual(r.score.diff, 0);
  play(100, 3, true);
  assert.strictEqual(sv.daily.streak, 1, 'same day, other length: same streak');
  play(101, 4, true);
  assert.strictEqual(sv.daily.streak, 2);
  play(103, 4, true);
  assert.strictEqual(sv.daily.streak, 1, 'missed a day');
  assert.strictEqual(sv.daily.best, 2);
  play(103, 5, false);
  assert.strictEqual(sv.stats[4].played, 3); assert.strictEqual(sv.stats[4].solved, 3); assert.strictEqual(sv.stats[4].atPar, 3);
  assert.strictEqual(sv.stats[5].played, 1); assert.strictEqual(sv.stats[5].solved, 0);
  assert.strictEqual(E.liveStreak(sv, 104), 1); assert.strictEqual(E.liveStreak(sv, 105), 0);
  var again = E.normSave(JSON.parse(JSON.stringify(sv)));
  assert.strictEqual(again.daily.best, 2); assert.strictEqual(again.stats[4].atPar, 3);
});

test('graph build is fast enough for a phone', function () {
  var lex = E.parseLists(D), t = Date.now();
  E.LENS.forEach(function (n) { E.genPuzzle(lex, n, 'hard', E.rng(1)); });
  assert.ok(Date.now() - t < 1500, 'took ' + (Date.now() - t) + ' ms');
});

test('saves keep one unfinished game per mode and length (and migrate the old single slot)', function () {
  var a = E.newGame({ n: 3, start: 'cat', end: 'dog', par: 3, day: 7 }), b = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4, day: 7 });
  E.climb(LEX, a, 'cot'); E.climb(LEX, b, 'cord');
  var s = E.normSave(JSON.parse(JSON.stringify({ games: { daily: { 3: a, 4: b, 5: 'junk' }, practice: { 4: b } } })));
  assert.deepStrictEqual(s.games.daily[3].rungs, ['cat', 'cot']);
  assert.deepStrictEqual(s.games.daily[4].rungs, ['cold', 'cord']);
  assert.ok(!s.games.daily[5]);
  assert.strictEqual(s.games.practice[4].start, 'cold');
  var old = E.normSave(JSON.parse(JSON.stringify({ games: { daily: a, practice: b } })));
  assert.strictEqual(old.games.daily[3].day, 7, 'old single daily slot migrates');
  assert.strictEqual(old.games.practice[4].end, 'warm', 'old single practice slot migrates');
  var done = E.newGame({ n: 3, start: 'cat', end: 'cot', par: 1, day: 1 }); done.done = true;
  assert.ok(!E.normSave({ games: { daily: { 3: done } } }).games.daily[3], 'finished games are not kept');
});

test('rules edge cases: case-insensitive input, non-letters, end word always accepted, hints from rare words', function () {
  var g = E.newGame({ n: 4, start: 'cold', end: 'warm', par: 4 });
  assert.ok(E.check(LEX, g, 'CORD').ok, 'upper case accepted');
  assert.strictEqual(E.check(LEX, g, 'co1d').err, 'unknown');
  assert.strictEqual(E.check(LEX, g, '').err, 'length');
  // a rare (extra-tier) rung still gets a hint that leads to the end
  var L = LEX[4], rare = null;
  for (var w of L.validSet) if (!L.solveSet.has(w) && E.neighbors(L, w).length && E.solve(L, w, 'warm')) { rare = w; break; }
  assert.ok(rare, 'found a rare connected word');
  var g2 = E.newGame({ n: 4, start: rare, end: 'warm', par: 9 });
  var h = E.hint(LEX, g2);
  assert.ok(h.word && E.oneApart(rare, h.word) && L.solveSet.has(h.word));
  // an end word outside every list is still reachable
  var g3 = E.newGame({ n: 4, start: 'cold', end: 'cxld', par: 2 });
  assert.ok(E.check(LEX, g3, 'cold').err === 'same');
  var r = E.climb(LEX, E.newGame({ n: 4, start: 'cold', end: 'colx', par: 1 }), 'colx');
  assert.ok(r.ok && r.finished, 'the end word is always a legal rung');
});

test('CPU plans are legal ladders for many random puzzles; hints always step toward the end', function () {
  var rnd = E.rng(99);
  E.LENS.forEach(function (n) {
    E.DIFFS.forEach(function (d) {
      for (var k = 0; k < 6; k++) {
        var p = E.genPuzzle(LEX, n, d, rnd), plan = E.cpuPlan(LEX, p, d, rnd);
        assert.strictEqual(plan.path[0], p.start); assert.strictEqual(plan.path[plan.path.length - 1], p.end);
        for (var i = 1; i < plan.path.length; i++) assert.ok(E.oneApart(plan.path[i - 1], plan.path[i]) && LEX[n].validSet.has(plan.path[i]));
        assert.ok(plan.times.length >= p.par && plan.total > 0);
        assert.ok(E.cpuProgress(plan, plan.total).done && !E.cpuProgress(plan, plan.total - 0.01).done);
        // follow hints all the way: always finishes in exactly par
        var g = E.newGame(p), guard = 0;
        while (!g.done && guard++ < 50) { var h = E.hint(LEX, g); assert.ok(h && h.word); assert.ok(E.climb(LEX, g, h.word).ok); }
        assert.strictEqual(E.moves(g), p.par);
      }
    });
  });
});

console.log(passed + ' passed');
if (process.exitCode) console.log('some tests FAILED');
