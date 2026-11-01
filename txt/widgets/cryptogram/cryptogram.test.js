/* Headless checks for the Cryptogram engine (cipher, rules, scoring, daily, saves, note picking).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/cryptogram/cryptogram.test.js */
'use strict';
var assert = require('assert');

var E = require('./cryptogram.js');
var Q = require('./cryptogram-quotes.js');
// The module registers the same engine on the widget when a Cade core is present.
var widget = null, css = [], assets = [];
global.window = {
  Cade: {
    loadCSS: function (p) { css.push(p); }, asset: function (p) { assets.push(p); return './txt/widgets/cryptogram/' + p; },
    registerWidget: function (w) { widget = w; }
  }
};
delete require.cache[require.resolve('./cryptogram.js')];
require('./cryptogram.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function solveAll(puz, game) {
  puz.letters.forEach(function (c) { E.assign(puz, game, c, puz.sol[c]); });
}

test('registers as a widget with its css and quote book', function () {
  assert.ok(widget && widget.name === 'Cryptogram' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'cryptogram.css');
  assert.deepStrictEqual(assets, ['cryptogram-quotes.js']);
  assert.deepStrictEqual(widget._engine.DIFFS, E.DIFFS);
});

test('the quote book: 300+ well-formed, unique quotes with authors', function () {
  assert.ok(Array.isArray(Q) && Q.length >= 300, 'only ' + Q.length);
  var seen = {};
  Q.forEach(function (line, i) {
    assert.strictEqual(line.split('|').length, 2, 'bad line ' + i);
    var q = E.parseQuote(line);
    assert.ok(q.text && q.author, 'missing part ' + i);
    assert.ok(/^[\x20-\x7e]+$/.test(q.text + q.author), 'non-ascii in ' + i);
    assert.ok(E.letters(q.text).length >= 8, 'too short ' + i);
    var k = q.text.toUpperCase();
    assert.ok(!seen[k], 'duplicate ' + i + ': ' + q.text);
    seen[k] = 1;
  });
});

test('every difficulty has a deep pool', function () {
  ['easy', 'medium', 'hard'].forEach(function (d) {
    var p = E.pool(Q, d);
    assert.ok(p.length >= 40, d + ' pool is ' + p.length);
    p.forEach(function (i) {
      var n = E.letters(E.parseQuote(Q[i]).text).length;
      assert.ok(n >= E.DIFFS[d].min && n <= E.DIFFS[d].max);
    });
  });
});

test('keys are derangements: a bijection where no letter maps to itself', function () {
  for (var s = 1; s < 400; s++) {
    var k = E.makeKey(E.rng(s)), used = {};
    E.ALPHA.split('').forEach(function (p) {
      assert.notStrictEqual(k[p], p, 'fixed point at seed ' + s);
      assert.ok(/^[A-Z]$/.test(k[p]));
      assert.ok(!used[k[p]], 'not a bijection'); used[k[p]] = 1;
    });
  }
});

test('encode keeps punctuation, spacing and length; invert decodes', function () {
  var k = E.makeKey(E.rng(7)), s = "Don't panic, it's 42!";
  var c = E.encode(s, k);
  assert.strictEqual(c.length, s.length);
  assert.strictEqual(c.replace(/[A-Z]/g, 'x'), s.toUpperCase().replace(/[A-Z]/g, 'x'));
  var inv = E.invert(k), back = c.replace(/[A-Z]/g, function (ch) { return inv[ch]; });
  assert.strictEqual(back, s.toUpperCase());
});

test('puzzles are deterministic from their descriptor', function () {
  var d = { kind: 'practice', diff: 'medium', qi: 12, seed: 99 };
  var a = E.buildPuzzle(d, Q), b = E.buildPuzzle(JSON.parse(JSON.stringify(d)), Q);
  assert.strictEqual(a.ctext, b.ctext);
  assert.deepStrictEqual(a.given, b.given);
  var c = E.buildPuzzle({ kind: 'practice', diff: 'medium', qi: 12, seed: 100 }, Q);
  assert.notStrictEqual(a.ctext, c.ctext);
  // the cipher hides every plain letter, the author is encrypted with the same key
  for (var i = 0; i < a.text.length; i++) if (/[A-Z]/.test(a.text[i])) assert.notStrictEqual(a.text[i], a.ctext[i]);
  assert.strictEqual(a.cauthor, E.encode(a.author, a.key));
  // frequencies add up to the letter count
  var sum = 0; a.letters.forEach(function (l) { sum += a.freq[l]; });
  assert.strictEqual(sum, a.nLetters);
});

test('givens follow difficulty and are pre-filled and locked', function () {
  var counts = { easy: 3, medium: 1, hard: 0 };
  Object.keys(counts).forEach(function (d) {
    for (var s = 0; s < 30; s++) {
      var desc = E.practiceDesc(Q, d, E.rng(s), []), puz = E.buildPuzzle(desc, Q), g = E.newGame(puz);
      assert.strictEqual(puz.given.length, counts[d], d);
      puz.given.forEach(function (c) {
        assert.strictEqual(g.g[c], puz.sol[c]);
        assert.ok(E.locked(puz, g, c));
        assert.strictEqual(E.assign(puz, g, c, 'Q'), false);
        assert.strictEqual(g.g[c], puz.sol[c]);
      });
      assert.ok(!E.isSolved(puz, g));
    }
  });
});

test('daily is the same for a date, differs across dates, and walks the pool', function () {
  var a = E.dailyDesc(Q, '2026-10-31'), b = E.dailyDesc(Q, '2026-10-31'), c = E.dailyDesc(Q, '2026-11-02');
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.seed, c.seed);
  assert.strictEqual(E.buildPuzzle(a, Q).ctext, E.buildPuzzle(b, Q).ctext);
  // weekday difficulty: 2026-11-01 is a Sunday (easy), 2026-10-30 a Friday (hard), 2026-10-28 a Wednesday
  assert.strictEqual(E.dailyDiff('2026-11-01'), 'easy');
  assert.strictEqual(E.dailyDiff('2026-10-30'), 'hard');
  assert.strictEqual(E.dailyDiff('2026-10-31'), 'hard');
  assert.strictEqual(E.dailyDiff('2026-10-28'), 'medium');
  // consecutive medium days don't repeat a quote for the length of the pool
  var seen = {}, n = 0, day = E.dayNum('2026-01-05'), pl = E.pool(Q, 'medium').length;
  for (var i = 0; n < Math.min(pl, 60); i++) {
    var dt = E.numDate(day + i);
    if (E.dailyDiff(dt) !== 'medium') continue;
    var q = E.dailyDesc(Q, dt).qi;
    assert.ok(!seen[q], 'repeat at ' + dt); seen[q] = 1; n++;
  }
});

test('conflicts: duplicate answers and letters set to themselves', function () {
  var puz = E.buildPuzzle({ kind: 'practice', diff: 'hard', qi: E.pool(Q, 'hard')[0], seed: 5 }, Q), g = E.newGame(puz);
  var a = puz.letters[0], b = puz.letters[1];
  E.assign(puz, g, a, 'E'); E.assign(puz, g, b, 'E');
  var cf = E.conflicts(puz, g);
  assert.strictEqual(cf[a], 'dup'); assert.strictEqual(cf[b], 'dup');
  E.assign(puz, g, b, b);
  cf = E.conflicts(puz, g);
  assert.ok(!cf[a]); assert.strictEqual(cf[b], 'self');
  E.assign(puz, g, b, null);
  assert.ok(!g.g[b]);
  assert.strictEqual(E.assign(puz, g, 'a', 'E') || E.assign(puz, g, puz.letters[0], '3'), false);
});

test('solving, checking, hints and score', function () {
  var desc = { kind: 'practice', diff: 'medium', qi: E.pool(Q, 'medium')[3], seed: 11 };
  var puz = E.buildPuzzle(desc, Q), g = E.newGame(puz);
  // a wrong guess is marked by check; changing it clears the mark
  var x = puz.letters.filter(function (c) { return !E.locked(puz, g, c); })[0], wrongP = puz.sol[x] === 'Z' ? 'Y' : 'Z';
  E.assign(puz, g, x, wrongP);
  assert.strictEqual(E.check(puz, g), 1);
  assert.ok(g.wrong[x]);
  E.assign(puz, g, x, puz.sol[x]);
  assert.ok(!g.wrong[x]);
  assert.strictEqual(E.check(puz, g), 0);
  assert.strictEqual(g.checks, 2);
  // a hint reveals the preferred letter, locks it and clears a stale guess that used its answer
  var y = puz.letters.filter(function (c) { return !E.locked(puz, g, c) && c !== x; })[0];
  var z = puz.letters.filter(function (c) { return !E.locked(puz, g, c) && c !== x && c !== y; })[0];
  E.assign(puz, g, z, puz.sol[y]);
  assert.strictEqual(E.hint(puz, g, y), y);
  assert.strictEqual(g.g[y], puz.sol[y]);
  assert.ok(E.locked(puz, g, y));
  assert.ok(!g.g[z], 'stale guess cleared');
  // without a preference, the commonest unsolved letter
  var h2 = E.hint(puz, g, null), need = puz.letters.filter(function (c) { return c !== h2 && g.g[c] !== puz.sol[c]; });
  need.forEach(function (c) { assert.ok(puz.freq[c] <= puz.freq[h2]); });
  solveAll(puz, g);
  assert.ok(E.isSolved(puz, g));
  g.t = 50000;
  assert.ok(E.finish(puz, g));
  assert.ok(g.done && !E.finish(puz, g));
  assert.strictEqual(g.score, E.score(puz, g, 50));
  assert.strictEqual(E.hint(puz, g, null), null);
  assert.strictEqual(E.assign(puz, g, x, 'Q'), false, 'no edits once solved');
});

test('score: faster is better, hints and checks cost, never below a floor', function () {
  var puz = E.buildPuzzle({ kind: 'practice', diff: 'hard', qi: E.pool(Q, 'hard')[2], seed: 3 }, Q), g = E.newGame(puz);
  var fast = E.score(puz, g, 10), slow = E.score(puz, g, 5000);
  assert.ok(fast > slow);
  assert.strictEqual(slow, puz.base);
  g.hints = ['A']; g.checks = 1;
  assert.strictEqual(E.score(puz, g, 5000), puz.base - E.HINT_COST - E.CHECK_COST);
  g.hints = new Array(30).join('A').split('');
  assert.strictEqual(E.score(puz, g, 5000), Math.round(puz.base * 0.1));
});

test('saved games normalise defensively', function () {
  var desc = E.dailyDesc(Q, '2026-10-31'), puz = E.buildPuzzle(desc, Q);
  var junk = [null, 5, 'x', { g: 'no' }, { g: { a: 'B', '1': 'C', ZZ: 'Q' }, hints: [1, 'zz'], checks: -4, t: 'NaN', wrong: { Q: 1 }, done: true, score: 1e9 }];
  junk.forEach(function (o) {
    var g = E.normGame(o, puz);
    assert.ok(!g.done);
    assert.ok(g.checks >= 0 && g.t >= 0);
    Object.keys(g.g).forEach(function (c) { assert.ok(puz.freq[c] && /^[A-Z]$/.test(g.g[c])); });
    puz.given.forEach(function (c) { assert.strictEqual(g.g[c], puz.sol[c]); });
  });
  // a real save round-trips
  var g0 = E.newGame(puz), c0 = puz.letters.filter(function (c) { return !E.locked(puz, g0, c); });
  E.assign(puz, g0, c0[0], 'K'); E.hint(puz, g0, c0[1]); E.check(puz, g0); g0.t = 1234;
  var g1 = E.normGame(JSON.parse(JSON.stringify(g0)), puz);
  assert.deepStrictEqual(g1.g, g0.g); assert.deepStrictEqual(g1.hints, g0.hints);
  assert.strictEqual(g1.checks, 1); assert.strictEqual(g1.t, 1234);
  // a "done" flag on an unsolved board is ignored; on a solved one it's kept
  var g2 = E.newGame(puz); solveAll(puz, g2); g2.t = 9000; E.finish(puz, g2);
  var g3 = E.normGame(JSON.parse(JSON.stringify(g2)), puz);
  assert.ok(g3.done); assert.strictEqual(g3.score, g2.score);
  // descriptors
  assert.strictEqual(E.normDesc(null, Q), null);
  assert.strictEqual(E.normDesc({ kind: 'practice', qi: 1e6, seed: 1 }, Q), null);
  assert.strictEqual(E.normDesc({ kind: 'daily', qi: 1, seed: 1, date: '2026-02-31' }, Q), null);
  assert.deepStrictEqual(E.normDesc({ kind: 'practice', qi: 3, seed: '7', diff: 'weird' }, Q), { kind: 'practice', diff: 'medium', qi: 3, seed: 7 });
  assert.strictEqual(E.normDesc({ kind: 'note', text: 'ab', seed: 1 }, Q), null);
  assert.strictEqual(E.normDesc({ kind: 'note', text: 'A perfectly fine sentence here.', seed: 1 }, Q).kind, 'note');
});

test('stats: bests, clean solves, the daily streak', function () {
  var st = E.normStats({ diff: { easy: { played: -1, solved: 'x', bestT: 1e12 } }, daily: { streak: 3, best: 1, last: 'nope', days: { bad: 1, '2026-01-01': { t: 5, s: 9, h: 99 } } } });
  assert.strictEqual(st.diff.easy.played, 0);
  assert.strictEqual(st.daily.best, 3);
  assert.strictEqual(st.daily.last, '');
  assert.deepStrictEqual(Object.keys(st.daily.days), ['2026-01-01']);
  assert.strictEqual(st.daily.days['2026-01-01'].h, 26);
  st = E.newStats();
  function solveDaily(date, secs, hints) {
    var puz = E.buildPuzzle(E.dailyDesc(Q, date), Q), g = E.newGame(puz);
    E.recordStart(st, puz.desc);
    for (var i = 0; i < hints; i++) E.hint(puz, g, null);
    solveAll(puz, g); g.t = secs * 1000; E.finish(puz, g);
    return E.recordSolve(st, puz, g);
  }
  assert.strictEqual(solveDaily('2026-10-27', 100, 0).streak, 1);
  assert.strictEqual(solveDaily('2026-10-28', 90, 1).streak, 2);
  assert.strictEqual(solveDaily('2026-10-28', 10, 0).streak, 0, 'a day counts once');
  assert.strictEqual(solveDaily('2026-10-29', 80, 0).streak, 3);
  assert.strictEqual(E.liveStreak(st, '2026-10-30'), 3);
  assert.strictEqual(E.liveStreak(st, '2026-11-01'), 0);
  assert.strictEqual(solveDaily('2026-10-31', 80, 0).streak, 1, 'missed a day');
  assert.strictEqual(st.daily.best, 3);
  assert.strictEqual(st.total.solved, 5);
  assert.ok(st.diff.medium.clean >= 1);
  var back = E.normStats(JSON.parse(JSON.stringify(st)));
  assert.deepStrictEqual(back, st);
});

test('note mode: markdown is stripped and a good sentence is picked', function () {
  var note = '# Shopping\n- [ ] eggs\n\nSee https://example.com for more. The quick brown fox jumps over the lazy dog near the riverbank. ok.\n```js\nvar secretCodeThatShouldNotAppear = 1;\n```\nAnother **fine** sentence about [links](http://x.y) and things!';
  var c = E.noteCandidates(note);
  assert.ok(c.length >= 2, JSON.stringify(c));
  c.forEach(function (s) { assert.ok(!/https?:|secretCode|\*\*|\[|#/.test(s), s); });
  assert.ok(c.indexOf('Another fine sentence about links and things!') >= 0, JSON.stringify(c));
  // cursor inside the fox sentence picks it
  var at = note.indexOf('lazy dog');
  assert.strictEqual(E.pickNoteSentence(note, at, '', function () { return 0; }), 'The quick brown fox jumps over the lazy dog near the riverbank.');
  // a selection wins
  assert.strictEqual(E.pickNoteSentence(note, at, 'Selected words make a lovely puzzle today', null), 'Selected words make a lovely puzzle today');
  // nothing usable
  assert.strictEqual(E.pickNoteSentence('hi\nok', 0, '', null), '');
  // long sentences are trimmed at a word
  var long = E.trimSentence(new Array(60).join('word ') + 'end.', 50);
  assert.ok(long.length <= 53 && /\.\.\.$/.test(long));
  // a note puzzle encodes the sentence, accents folded
  var puz = E.buildPuzzle(E.noteDesc('Crème brûlée is a lovely dessert, isn’t it?', 4), Q);
  assert.strictEqual(puz.text, "CREME BRULEE IS A LOVELY DESSERT, ISN'T IT?");
  assert.strictEqual(puz.author, '');
  assert.strictEqual(puz.given.length, 1);
});

test('dates and formatting', function () {
  assert.strictEqual(E.prevDate('2026-03-01'), '2026-02-28');
  assert.ok(E.validDate('2026-10-31') && !E.validDate('2026-13-01') && !E.validDate(5));
  assert.strictEqual(E.fmtTime(65), '1:05');
  assert.strictEqual(E.fmtTime(3725), '1:02:05');
  var puz = E.buildPuzzle(E.dailyDesc(Q, '2026-10-31'), Q), g = E.newGame(puz);
  solveAll(puz, g); g.t = 61000; E.finish(puz, g);
  assert.ok(/^Cryptogram 2026-10-31 \(Hard\) -- solved in 1:01, \d+ pts, no hints$/.test(E.shareText(puz, g)), E.shareText(puz, g));
});

test('a simulated solver always finishes every difficulty', function () {
  ['easy', 'medium', 'hard'].forEach(function (d) {
    for (var s = 0; s < 25; s++) {
      var r = E.rng(1000 + s), puz = E.buildPuzzle(E.practiceDesc(Q, d, r, []), Q), g = E.newGame(puz), n = 0;
      // guess randomly, check, fix wrong ones with hints — the loop must terminate solved
      while (!E.isSolved(puz, g) && n++ < 200) {
        puz.letters.forEach(function (c) { if (!g.g[c]) E.assign(puz, g, c, E.ALPHA[Math.floor(r() * 26)]); });
        E.check(puz, g);
        var w = Object.keys(g.wrong);
        if (w.length) E.hint(puz, g, w[0]);
      }
      assert.ok(E.isSolved(puz, g), d + ' seed ' + s);
      g.t = 1000; assert.ok(E.finish(puz, g)); assert.ok(g.score > 0);
    }
  });
});

test('reviewer: weekday mapping of the daily on known dates', function () {
  assert.strictEqual(E.dailyDiff('2026-11-01'), 'easy');     // Sunday
  assert.strictEqual(E.dailyDiff('2026-11-02'), 'medium');   // Monday
  assert.strictEqual(E.dailyDiff('2026-11-05'), 'medium');   // Thursday
  assert.strictEqual(E.dailyDiff('2026-11-06'), 'hard');     // Friday
  assert.strictEqual(E.dailyDiff('2026-10-31'), 'hard');     // Saturday
  // every daily of a year is buildable, in its pool, and solvable
  for (var n = 0; n < 366; n++) {
    var date = E.numDate(E.dayNum('2026-01-01') + n), d = E.dailyDesc(Q, date);
    assert.ok(E.pool(Q, d.diff).indexOf(d.qi) >= 0, date);
    var puz = E.buildPuzzle(d, Q);
    puz.letters.forEach(function (c) { assert.notStrictEqual(puz.sol[c], c); });
  }
});

test('reviewer: locked letters, bad input and finished games are inert', function () {
  var puz = E.buildPuzzle(E.practiceDesc(Q, 'easy', E.rng(5), []), Q), g = E.newGame(puz), giv = puz.given[0];
  assert.ok(giv);
  assert.strictEqual(E.assign(puz, g, giv, 'Q'), false);
  assert.strictEqual(g.g[giv], puz.sol[giv]);
  var free = puz.letters.filter(function (c) { return puz.given.indexOf(c) < 0; })[0];
  assert.strictEqual(E.assign(puz, g, free, '1'), false);
  var absent = E.ALPHA.split('').filter(function (c) { return !puz.freq[c]; })[0];
  if (absent) assert.strictEqual(E.assign(puz, g, absent, 'A'), false);
  // a hint asked for a locked letter falls back to the commonest unsolved one
  var h = E.hint(puz, g, giv);
  assert.ok(h && h !== giv && E.locked(puz, g, h));
  puz.letters.forEach(function (c) { E.assign(puz, g, c, puz.sol[c]); });
  g.t = 12345; assert.ok(E.finish(puz, g));
  assert.strictEqual(g.t, 12000);
  var checks = g.checks;
  assert.strictEqual(E.check(puz, g), 0); assert.strictEqual(g.checks, checks);
  assert.strictEqual(E.hint(puz, g), null);
  assert.strictEqual(E.assign(puz, g, free, 'Z'), false);
  assert.strictEqual(E.finish(puz, g), false);
});

test('reviewer: score floor and penalties', function () {
  var puz = E.buildPuzzle(E.practiceDesc(Q, 'hard', E.rng(9), []), Q), g = E.newGame(puz);
  assert.strictEqual(E.score(puz, g, 0), puz.base + E.par(puz) * 4);
  g.hints = new Array(30).fill('A');
  assert.strictEqual(E.score(puz, g, 9999), Math.round(puz.base * 0.1));
  g.hints = ['A']; g.checks = 2;
  assert.strictEqual(E.score(puz, g, 99999), puz.base - E.HINT_COST - 2 * E.CHECK_COST);
});

test('reviewer: a save claiming done on an unsolved board is not trusted', function () {
  var puz = E.buildPuzzle(E.practiceDesc(Q, 'medium', E.rng(77), []), Q);
  var g = E.normGame({ g: {}, done: true, score: 99999, hints: [puz.given[0], 'nope', 5], checks: -4, t: 'x' }, puz);
  assert.strictEqual(g.done, false); assert.strictEqual(g.score, 0);
  assert.deepStrictEqual(g.hints, []); assert.strictEqual(g.checks, 0); assert.strictEqual(g.t, 0);
});

test('reviewer: streak survives month/year ends and ignores replays', function () {
  var st = E.newStats();
  ['2026-12-30', '2026-12-31', '2027-01-01'].forEach(function (date) {
    var puz = E.buildPuzzle(E.dailyDesc(Q, date), Q), g = E.newGame(puz);
    puz.letters.forEach(function (c) { E.assign(puz, g, c, puz.sol[c]); });
    g.t = 30000; E.finish(puz, g); E.recordSolve(st, puz, g);
    E.recordSolve(st, puz, g);   // replay of the same day: no double count
  });
  assert.strictEqual(st.daily.streak, 3); assert.strictEqual(st.daily.best, 3);
  assert.strictEqual(E.liveStreak(st, '2027-01-02'), 3);
  assert.strictEqual(E.liveStreak(st, '2027-01-03'), 0);
});

test('reviewer: note picking with the cursor at the very end / nothing usable', function () {
  var txt = 'Tiny.\nThe garden needs water every single morning in summer';
  assert.ok(/garden/.test(E.pickNoteSentence(txt, txt.length, '', E.rng(1))));
  assert.strictEqual(E.pickNoteSentence('ok. no. hi.', 3, '', E.rng(1)), '');
  assert.strictEqual(E.pickNoteSentence('', -1, '', null), '');
});

console.log(passed + ' passed');
if (process.exitCode) console.log('SOME TESTS FAILED');
