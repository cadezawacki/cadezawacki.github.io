/* Headless checks for the Word Search engine (generation, selection, scoring,
 * CPU race, hints, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/wordsearch/wordsearch.test.js */
'use strict';
var assert = require('assert');
var E = require('./wordsearch.js');
var DATA = require('./wordsearch-data.js');

var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./wordsearch.js')];
require('./wordsearch.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function themeWords(i) { return DATA.themes[i][3].split(' '); }
function checkPuzzle(pz) {
  var N = pz.size;
  assert.strictEqual(pz.grid.length, N * N);
  assert.ok(/^[A-Z]+$/.test(pz.grid), 'grid letters');
  pz.words.forEach(function (w, i) {
    var cells = E.wordCells(pz, i), s = cells.map(function (c) { return pz.grid.charAt(c); }).join('');
    assert.strictEqual(s, w.w, 'word in place: ' + w.w);
    cells.forEach(function (c) { assert.ok(c >= 0 && c < N * N); });
    // exactly one place in the grid spells it (either way)
    assert.strictEqual(E.occurrences(pz.grid, N, w.w).length, 1, 'unique ' + w.w + ' in seed ' + pz.seed);
  });
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Word Search' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'wordsearch.css');
  assert.strictEqual(widget._engine.TURN_SEC, E.TURN_SEC);
});

test('data: 20+ themes x 30+ words, clean and distinct', function () {
  assert.ok(DATA.themes.length >= 20);
  var ids = {};
  DATA.themes.forEach(function (t) {
    assert.ok(!ids[t[0]], 'dup theme ' + t[0]); ids[t[0]] = 1;
    var ws = t[3].split(' '), seen = {};
    assert.ok(ws.length >= 30, t[0] + ' has ' + ws.length);
    ws.forEach(function (w) {
      var k = E.norm(w);
      assert.ok(k.length >= 3 && k.length <= 15, w);
      assert.ok(!seen[k], 'dup ' + w + ' in ' + t[0]); seen[k] = 1;
    });
    // enough words fit the smallest grid
    assert.ok(ws.filter(function (w) { return E.norm(w).length <= 8; }).length >= 20, t[0] + ' short words');
  });
});

test('norm / disp', function () {
  assert.strictEqual(E.norm('Crème brûlée!'), 'CREMEBRULEE');
  assert.strictEqual(E.norm('ice-cream'), 'ICECREAM');
  assert.strictEqual(E.disp('ice-cream'), 'Ice cream');
  assert.strictEqual(E.disp('PARIS'), 'Paris');
  assert.strictEqual(E.disp('iPhone'), 'IPhone');
});

test('pickWords: fits, dedupes, no word inside another or its reverse', function () {
  var r = E.rng(5);
  var out = E.pickWords(['cat', 'Cat', 'category', 'tac', 'dog', 'god', 'elephantine', 'bird', 'x', 'ab'], 10, 8, r);
  var ws = out.map(function (o) { return o.w; });
  assert.ok(ws.indexOf('ELEPHANTINE') < 0, 'too long');
  assert.ok(ws.indexOf('X') < 0 && ws.indexOf('AB') < 0, 'too short');
  for (var i = 0; i < ws.length; i++) for (var j = 0; j < ws.length; j++) {
    if (i === j) continue;
    assert.ok(ws[i].indexOf(ws[j]) < 0, ws[i] + ' contains ' + ws[j]);
    assert.ok(ws[i].indexOf(ws[j].split('').reverse().join('')) < 0, ws[i] + ' contains reverse ' + ws[j]);
  }
  assert.strictEqual(ws.filter(function (w) { return w === 'CAT'; }).length <= 1, true);
});

test('generate: every level, many seeds, all themes — words placed, unique, sizes right', function () {
  E.LEVEL_IDS.forEach(function (lid) {
    var L = E.LEVELS[lid];
    for (var s = 0; s < 40; s++) {
      var t = s % DATA.themes.length, pz = E.generate(themeWords(t), lid, 1000 + s * 7919, { theme: DATA.themes[t][0] });
      assert.strictEqual(pz.size, L.size);
      assert.ok(pz.size >= 8 && pz.size <= 15);
      assert.ok(pz.words.length >= L.words - 1, lid + ' placed ' + pz.words.length + '/' + L.words + ' (' + DATA.themes[t][0] + ')');
      checkPuzzle(pz);
      pz.words.forEach(function (w) { assert.ok(L.dirs.indexOf(w.d) >= 0, lid + ' direction allowed'); });
    }
  });
});

test('generate: easy never overlaps or reads backwards; expert does both', function () {
  var ov = 0, back = 0;
  for (var s = 0; s < 30; s++) {
    var e = E.generate(themeWords(s % 30), 'easy', s);
    var used = {};
    e.words.forEach(function (w, i) {
      assert.ok(!E.isBack(w) && !E.isDiag(w));
      E.wordCells(e, i).forEach(function (c) { assert.ok(!used[c], 'easy overlap'); used[c] = 1; });
    });
    var x = E.generate(themeWords(s % 30), 'expert', s), u2 = {};
    x.words.forEach(function (w, i) {
      if (E.isBack(w)) back++;
      E.wordCells(x, i).forEach(function (c) { if (u2[c]) ov++; u2[c] = 1; });
    });
  }
  assert.ok(ov > 10, 'expert overlaps: ' + ov);
  assert.ok(back > 30, 'expert backwards: ' + back);
});

test('generate: deterministic for a seed', function () {
  var a = E.generate(themeWords(3), 'hard', 42), b = E.generate(themeWords(3), 'hard', 42), c = E.generate(themeWords(3), 'hard', 43);
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.grid, c.grid);
});

test('snap: 8 directions, clamped to the grid', function () {
  var N = 10;
  var s = E.snap(N, 2, 2, 2.6, 7.4);           // to the right
  assert.deepStrictEqual([s.r1, s.c1, E.DIR_NAMES[s.d]], [2, 7, 'E']);
  s = E.snap(N, 2, 2, 6.2, 6.9);               // down-right, a bit off the diagonal
  assert.deepStrictEqual([s.r1, s.c1, E.DIR_NAMES[s.d]], [6, 6, 'SE']);
  s = E.snap(N, 5, 5, 0.5, 9.9);               // up-right, past the edge
  assert.strictEqual(E.DIR_NAMES[s.d], 'NE');
  assert.ok(s.r1 >= 0 && s.c1 <= 9);
  s = E.snap(N, 5, 5, -3, 5.5);                // straight up, off the top
  assert.deepStrictEqual([s.r1, s.c1, E.DIR_NAMES[s.d]], [0, 5, 'N']);
  s = E.snap(N, 3, 3, 3.6, 3.4);               // barely moved: one cell
  assert.strictEqual(s.n, 1);
  for (var k = 0; k < 500; k++) {
    var r0 = k % N, c0 = (k * 7) % N, fy = (k * 13 % 97) / 97 * 14 - 2, fx = (k * 31 % 89) / 89 * 14 - 2, q = E.snap(N, r0, c0, fy, fx);
    var cells = E.lineCells(N, q.r0, q.c0, q.r1, q.c1);
    assert.ok(cells && cells.length === q.n, 'snap gives a straight in-grid line');
  }
});

test('lineCells rejects bent lines', function () {
  assert.strictEqual(E.lineCells(8, 0, 0, 2, 3), null);
  assert.deepStrictEqual(E.lineCells(8, 0, 0, 2, 2), [0, 9, 18]);
  assert.deepStrictEqual(E.lineCells(8, 1, 3, 1, 1), [11, 10, 9]);
});

test('submit: forwards and backwards both count; misses do not', function () {
  var pz = E.generate(themeWords(0), 'hard', 7), g = E.newGame(pz, { mode: 'solo' });
  var c = E.wordCells(pz, 0);
  assert.strictEqual(E.submit(g, c.slice(0, -1)), null);
  assert.strictEqual(g.misses, 1);
  var r = E.submit(g, c.slice().reverse());
  assert.ok(r && r.i === 0 && r.pts === E.wordPoints(pz.words[0]));
  assert.strictEqual(E.submit(g, c), null, 'already found');
  for (var i = 1; i < pz.words.length; i++) assert.ok(E.submit(g, E.wordCells(pz, i)));
  assert.ok(g.done && g.nFound === pz.words.length);
});

test('points: letters +1 diagonal +2 backwards', function () {
  assert.strictEqual(E.wordPoints({ w: 'TIGER', d: 0 }), 5);
  assert.strictEqual(E.wordPoints({ w: 'TIGER', d: 2 }), 6);
  assert.strictEqual(E.wordPoints({ w: 'TIGER', d: 4 }), 7);
  assert.strictEqual(E.wordPoints({ w: 'TIGER', d: 6 }), 8);
});

test('hints: first letter, then last; time penalty solo, points in matches', function () {
  var pz = E.generate(themeWords(2), 'medium', 9), g = E.newGame(pz, { mode: 'solo' });
  var n = pz.words.length;
  for (var k = 0; k < n; k++) assert.ok(E.hint(g));
  assert.strictEqual(E.hintCells(g).length, n);
  g.hints.forEach(function (h) { assert.strictEqual(h, 1); });
  for (k = 0; k < n; k++) assert.ok(E.hint(g));
  assert.strictEqual(E.hint(g), null, 'out of hints');
  assert.strictEqual(E.hintCells(g).length, 2 * n);
  assert.strictEqual(g.penalty, 2 * n * E.HINT_SEC);
  var first = E.hintCells(g)[0];
  assert.strictEqual(first, E.wordCells(pz, 0)[0]);
  var m = E.newGame(pz, { mode: 'cpu' });
  E.hint(m);
  assert.strictEqual(m.score[0], -E.HINT_PTS);
  assert.strictEqual(m.penalty, 0);
});

test('vs CPU: finds only unfound words over time, harder CPU is faster', function () {
  function race(level, seed) {
    var pz = E.generate(themeWords(seed % 30), 'medium', seed), g = E.newGame(pz, { mode: 'cpu', cpu: level }), seen = {};
    for (var s = 0; s < 20000 && !g.done; s++) {
      E.tick(g, 0.05).forEach(function (e) {
        assert.ok(e.cpu >= 0 && !seen[e.cpu], 'cpu finds a new word'); seen[e.cpu] = 1;
        assert.strictEqual(g.found[e.cpu].by, 2);
      });
    }
    assert.ok(g.done, 'cpu finishes alone');
    assert.strictEqual(E.outcome(g), -1);
    return g.t;
  }
  var te = 0, th = 0;
  for (var s = 1; s <= 12; s++) { te += race('easy', s); th += race('hard', s); }
  assert.ok(te > th * 1.8, 'easy ' + te.toFixed(0) + ' vs hard ' + th.toFixed(0));
  // it leaves the player's words alone
  var pz = E.generate(themeWords(4), 'medium', 77), g = E.newGame(pz, { mode: 'cpu', cpu: 'hard' });
  E.submit(g, E.wordCells(pz, 0), 0);
  while (!g.done) E.tick(g, 0.5);
  assert.strictEqual(g.found[0].by, 0);
  assert.strictEqual(g.score[0] + g.score[2], pz.words.reduce(function (a, w) { return a + E.wordPoints(w); }, 0));
});

test('vs CPU is deterministic for a seed', function () {
  var pz = E.generate(themeWords(5), 'hard', 99);
  function trace() { var g = E.newGame(pz, { mode: 'cpu', cpu: 'medium' }), t = []; while (!g.done) E.tick(g, 0.1).forEach(function (e) { t.push(e.cpu + '@' + g.t.toFixed(1)); }); return t.join(); }
  assert.strictEqual(trace(), trace());
});

test('2P alternate: turns switch on a find and on the turn clock', function () {
  var pz = E.generate(themeWords(6), 'easy', 3), g = E.newGame(pz, { mode: 'alt' });
  assert.strictEqual(g.turn, 0);
  E.submit(g, E.wordCells(pz, 0));
  assert.strictEqual(g.found[0].by, 0);
  assert.strictEqual(g.turn, 1);
  E.submit(g, [0, 1]);   // a miss keeps the turn
  assert.strictEqual(g.turn, 1);
  var ev = [];
  for (var i = 0; i < 50; i++) ev = ev.concat(E.tick(g, 1));
  assert.ok(ev.some(function (e) { return e.timeout === 1; }));
  assert.strictEqual(g.turn, 0);
  E.submit(g, E.wordCells(pz, 1));
  assert.strictEqual(g.found[1].by, 0);
  assert.strictEqual(g.score[0], E.wordPoints(pz.words[0]) + E.wordPoints(pz.words[1]));
  assert.strictEqual(E.outcome(g), 1);
});

test('noteWords: distinct, frequent first, stopwords and links dropped', function () {
  var t = 'The garden needs water. Garden beds, garden tools! Water the tomatoes https://example.com/longlinkword ' +
    'tomatoes and basil; also basil. Café crème — naïve résumé about which there would be.';
  var w = E.noteWords(t, 40);
  assert.strictEqual(w[0], 'garden');
  assert.ok(w.indexOf('water') > 0 && w.indexOf('tomatoes') > 0 && w.indexOf('basil') > 0);
  assert.ok(w.indexOf('about') < 0 && w.indexOf('which') < 0 && w.indexOf('longlinkword') < 0);
  assert.strictEqual(new Set(w.map(E.norm)).size, w.length);
  assert.deepStrictEqual(E.noteWords('', 10), []);
  assert.deepStrictEqual(E.noteWords(null, 10), []);
  var pz = E.generate(w, 'easy', 1);
  checkPuzzle(pz);
});

test('parseList: separators, dedupe, bad entries', function () {
  var p = E.parseList('apple, Banana\nAPPLE; kiwi ;;  x , supercalifragilistic, ice cream');
  assert.deepStrictEqual(p.words, ['apple', 'Banana', 'kiwi', 'ice cream']);
  assert.deepStrictEqual(p.bad, ['x', 'supercalifragilistic']);
});

test('daily: stable per day, theme in range, streak counting', function () {
  var a = E.dailySpec(20000, 32), b = E.dailySpec(20000, 32), c = E.dailySpec(20001, 32);
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.seed, c.seed);
  assert.ok(a.theme >= 0 && a.theme < 32);
  assert.strictEqual(E.dayKey(E.dayNum(new Date(2026, 9, 31))), '2026-10-31');
  var d = {}; d[E.dayKey(99)] = 30; d[E.dayKey(98)] = 40; d[E.dayKey(96)] = 50;
  assert.strictEqual(E.streak(d, 99), 2);
  assert.strictEqual(E.streak(d, 100), 2, 'today not played yet keeps yesterday’s streak');
  assert.strictEqual(E.streak(d, 101), 0);
});

test('saves: normalise junk, keep good values', function () {
  var s = E.normSave(null);
  assert.strictEqual(s.prefs.level, 'medium');
  s = E.normSave({ best: { easy: 42, hard: -3, medium: 'x' }, daily: { '2026-01-01': 60, bad: 3, '2026-01-02': -1 }, cpu: { hard: { w: 2, l: 'z' } },
    stats: { played: 5, solved: NaN }, prefs: { mode: 'cpu', level: 'nope', theme: '<b>', p2: 'relay', src: 'note' } });
  assert.strictEqual(s.best.easy, 42); assert.strictEqual(s.best.hard, 0); assert.strictEqual(s.best.medium, 0);
  assert.deepStrictEqual(Object.keys(s.daily), ['2026-01-01']);
  assert.deepStrictEqual(s.cpu.hard, { w: 2, l: 0, d: 0 });
  assert.strictEqual(s.stats.played, 5); assert.strictEqual(s.stats.solved, 0);
  assert.strictEqual(s.prefs.mode, 'cpu'); assert.strictEqual(s.prefs.level, 'medium'); assert.strictEqual(s.prefs.theme, 'random');
  assert.strictEqual(s.prefs.p2, 'relay'); assert.strictEqual(s.prefs.src, 'note');
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
});

test('saved game: round trip, tampering rejected', function () {
  var pz = E.generate(themeWords(8), 'hard', 1234), g = E.newGame(pz, { mode: 'solo' });
  E.submit(g, E.wordCells(pz, 2)); E.hint(g); E.tick(g, 0.8); g.t = 61.25;
  var packed = JSON.parse(JSON.stringify(E.packGame(g)));
  var back = E.unpackGame(packed);
  assert.ok(back);
  assert.strictEqual(back.nFound, 1); assert.ok(back.found[2]);
  assert.strictEqual(back.penalty, E.HINT_SEC);
  assert.strictEqual(back.t, 61.3);
  var bad = JSON.parse(JSON.stringify(packed));
  bad.pz.grid = bad.pz.grid.slice(1) + 'A';
  assert.strictEqual(E.unpackGame(bad), null);
  bad = JSON.parse(JSON.stringify(packed)); bad.pz.words[0].d = 9;
  assert.strictEqual(E.unpackGame(bad), null);
  bad = JSON.parse(JSON.stringify(packed)); bad.mode = 'cpu';
  assert.strictEqual(E.unpackGame(bad), null);
  assert.strictEqual(E.unpackGame('nope'), null);
  assert.strictEqual(E.unpackGame(null), null);
});

test('settle: best times, daily, cpu record, stats', function () {
  var s = E.newSave(), pz = E.generate(themeWords(9), 'easy', 5), g = E.newGame(pz, { mode: 'solo' });
  pz.words.forEach(function (w, i) { E.submit(g, E.wordCells(pz, i)); });
  g.t = 90;
  var o = E.settle(s, g);
  assert.ok(o.newBest); assert.strictEqual(s.best.easy, 90); assert.strictEqual(s.bestClean.easy, 90);
  var g2 = E.newGame(pz, { mode: 'daily' });
  E.hint(g2);
  pz.words.forEach(function (w, i) { E.submit(g2, E.wordCells(pz, i)); });
  g2.t = 70;
  o = E.settle(s, g2, '2026-10-31');
  assert.strictEqual(o.time, 85, '70 s + one hint');
  assert.ok(o.newBest);
  assert.strictEqual(s.best.easy, 85); assert.strictEqual(s.bestClean.easy, 90);
  assert.strictEqual(s.daily['2026-10-31'], 85);
  var c = E.newGame(pz, { mode: 'cpu', cpu: 'easy' });
  pz.words.forEach(function (w, i) { E.submit(c, E.wordCells(pz, i), 0); });
  E.settle(s, c);
  assert.strictEqual(s.cpu.easy.w, 1);
  assert.strictEqual(s.stats.played, 3); assert.strictEqual(s.stats.solved, 3);
  assert.strictEqual(s.stats.words, 3 * pz.words.length);
});

// ---- reviewer additions ----
test('relay result: winner, dead heat, give-ups', function () {
  assert.strictEqual(E.relayResult(30, 40, true, true), 0);
  assert.strictEqual(E.relayResult(40, 30, true, true), 1);
  assert.strictEqual(E.relayResult(30.04, 30.08, true, true), -1, 'same tenth = dead heat');
  assert.strictEqual(E.relayResult(359999, 99, false, true), 1, 'P1 gave up');
  assert.strictEqual(E.relayResult(10, 0, true, false), 0, 'P2 gave up');
  assert.strictEqual(E.relayResult(359999, 5, false, false), -2, 'nobody finished');
});

test('every theme x level fills the full word count (25 seeds)', function () {
  var short = 0;
  for (var t = 0; t < DATA.themes.length; t++) {
    E.LEVEL_IDS.forEach(function (lv) {
      for (var sd = 0; sd < 25; sd++) {
        var pz = E.generate(themeWords(t), lv, sd * 7919 + t, {});
        if (pz.words.length < E.LEVELS[lv].words) short++;
      }
    });
  }
  assert.strictEqual(short, 0, short + ' puzzles came out short');
});

test('custom lists: palindromes, accents, long words and big lists stay solvable', function () {
  var pl = E.parseList('Level, radar; café\nnaïve, kayak, ab, ' + 'x'.repeat(16) + ', Level');
  assert.deepStrictEqual(pl.words.map(E.norm), ['LEVEL', 'RADAR', 'CAFE', 'NAIVE', 'KAYAK']);
  assert.strictEqual(pl.bad.length, 2);
  for (var sd = 1; sd < 30; sd++) {
    var pz = E.generate(pl.words, 'expert', sd, { size: 8, count: 5 });
    checkPuzzle(pz);
    var g = E.newGame(pz, { mode: 'solo' });
    pz.words.forEach(function (w, i) {
      var c = E.wordCells(pz, i);
      var r = E.submit(g, c.slice().reverse());   // dragging from the far end also counts
      assert.ok(r && r.i === i, 'reverse drag finds ' + w.w);
    });
    assert.ok(g.done);
  }
  var big = []; for (var i = 0; i < 60; i++) big.push(DATA.themes[i % DATA.themes.length][3].split(' ')[Math.floor(i / DATA.themes.length)]);
  var pz2 = E.generate(big, 'hard', 77, { size: 15, count: 24 });
  checkPuzzle(pz2);
  assert.ok(pz2.words.length >= 20, 'a 15x15 holds most of a 24-word list (' + pz2.words.length + ')');
});

test('no input after the end; hints run out; one-cell lines never count', function () {
  var pz = E.generate(themeWords(3), 'easy', 5, {}), g = E.newGame(pz, { mode: 'solo' });
  assert.strictEqual(E.submit(g, [0]), null);
  assert.strictEqual(g.misses, 0, 'a tap is not a miss');
  var n = 0; while (E.hint(g)) n++;
  assert.strictEqual(n, pz.words.length * 2, 'two hints per word');
  assert.strictEqual(E.hintCells(g).length, pz.words.length * 2);
  pz.words.forEach(function (w, i) { E.submit(g, E.wordCells(pz, i)); });
  assert.ok(g.done);
  assert.strictEqual(E.hintCells(g).length, 0, 'found words drop their hints');
  assert.strictEqual(E.submit(g, E.wordCells(pz, 0)), null);
  assert.strictEqual(E.hint(g), null);
  var t = g.t; E.tick(g, 0.5); assert.strictEqual(g.t, t, 'the clock stops at the end');
});

test('CPU race on many seeds: legal finds only, terminates, deterministic', function () {
  for (var sd = 0; sd < 60; sd++) {
    var lv = E.LEVEL_IDS[sd % 4], cpu = E.CPU_IDS[sd % 3];
    var pz = E.generate(themeWords(sd % DATA.themes.length), lv, sd + 1000, {}), g = E.newGame(pz, { mode: 'cpu', cpu: cpu });
    var seen = {}, steps = 0;
    while (!g.done && steps < 100000) {
      var ev = E.tick(g, 1 / 60); steps++;
      ev.forEach(function (e) {
        if (e.cpu == null) return;
        assert.ok(!seen[e.cpu], 'no double find');
        seen[e.cpu] = 1;
        var cells = g.found[e.cpu].cells, s = cells.map(function (c) { return pz.grid.charAt(c); }).join('');
        assert.strictEqual(s, pz.words[e.cpu].w, 'CPU marks the real cells');
      });
      if (sd % 5 === 0 && steps % 400 === 0) {   // the player chips in now and then
        var i = g.found.indexOf(null);
        if (i >= 0) E.submit(g, E.wordCells(pz, i), 0);
      }
    }
    assert.ok(g.done, 'race ends (seed ' + sd + ')');
    assert.strictEqual(g.score[0] + g.score[2], pz.words.reduce(function (a, w) { return a + E.wordPoints(w); }, 0));
  }
});

test('alt mode: the turn clock hands over, scores go to whoever found it', function () {
  var pz = E.generate(themeWords(9), 'medium', 31, {}), g = E.newGame(pz, { mode: 'alt' });
  for (var k = 0; k < E.TURN_SEC * 60 - 5; k++) E.tick(g, 1 / 60);
  assert.strictEqual(g.turn, 0);
  var ev = []; for (k = 0; k < 20; k++) ev = ev.concat(E.tick(g, 1 / 60));
  assert.strictEqual(g.turn, 1); assert.ok(ev.some(function (e) { return e.timeout === 0; }));
  var r = E.submit(g, E.wordCells(pz, 0));
  assert.ok(g.score[1] === r.pts && g.score[0] === 0 && g.turn === 0 && g.found[0].by === 1);
  E.hint(g);
  assert.strictEqual(g.score[0], -E.HINT_PTS, 'the hint costs the player whose turn it is');
});

test('saves: a finished or mismatched game is not resumable', function () {
  var pz = E.generate(themeWords(2), 'medium', 8, {}), g = E.newGame(pz, { mode: 'solo' });
  pz.words.forEach(function (w, i) { E.submit(g, E.wordCells(pz, i)); });
  assert.strictEqual(E.unpackGame(JSON.parse(JSON.stringify(E.packGame(g)))), null);
  var g2 = E.newGame(pz, { mode: 'solo' }); E.submit(g2, E.wordCells(pz, 0)); g2.t = 12;
  var pk = JSON.parse(JSON.stringify(E.packGame(g2)));
  pk.pz.words[1].r = (pk.pz.words[1].r + 1) % pz.size;
  assert.strictEqual(E.unpackGame(pk), null, 'word moved off its letters');
  pk = JSON.parse(JSON.stringify(E.packGame(g2))); pk.mode = 'cpu';
  assert.strictEqual(E.unpackGame(pk), null, 'only solo/daily resume');
  pk = JSON.parse(JSON.stringify(E.packGame(g2))); pk.t = -5; pk.hints = [9, 'x'];
  var u = E.unpackGame(pk);
  assert.ok(u && u.t === 0 && u.hints[0] === 2 && u.hints[1] === 0 && u.nFound === 1);
});

console.log(passed + ' passed');
