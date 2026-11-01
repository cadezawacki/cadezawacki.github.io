/* Headless checks for the Finish the Phrase engine (data, normalising, fuzzy
 * scoring, the bot, rounds, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/autocomplete/autocomplete.test.js */
'use strict';
var assert = require('assert');

var E = require('./autocomplete.js');
var DATA = require('./autocomplete-data.js');
// …and the module registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./autocomplete.js')];
require('./autocomplete.js');
delete global.window;

var P = E.parseData(DATA.p);
function ph(start) { var p = P.filter(function (x) { return x.start === start; })[0]; assert.ok(p, 'phrase ' + start); return p; }
function sc(start, ans) { return E.grade(ph(start), ans).score; }

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Finish the Phrase' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'autocomplete.css');
  assert.strictEqual(widget._engine.ROUND_N, E.ROUND_N);
});

test('data: 400+ well-formed phrases in every category and difficulty', function () {
  assert.ok(P.length >= 400, 'got ' + P.length);
  assert.strictEqual(P.length, DATA.p.length, 'every line parses');
  var starts = {}, byCat = {}, byD = {};
  P.forEach(function (p) {
    var k = E.norm(p.start);
    assert.ok(!starts[k], 'duplicate start: ' + p.start);
    starts[k] = 1;
    byCat[p.cat] = (byCat[p.cat] || 0) + 1;
    byD[p.d] = (byD[p.d] || 0) + 1;
    assert.ok(E.tokens(p.end).length > 0 && E.tokens(p.start).length > 0, p.start);
    p.alts.forEach(function (a) { assert.strictEqual(E.grade(p, a).score, 1, 'own ending scores 100%: ' + p.start + ' / ' + a); });
  });
  E.CATS.forEach(function (c) { assert.ok(byCat[c.id] >= 40, c.id + ' has ' + byCat[c.id]); });
  [1, 2, 3].forEach(function (d) { assert.ok(byD[d] >= 60, 'difficulty ' + d); });
  assert.deepStrictEqual(E.parseData(['x|1|a|b', 'p|9|a|b', 'p|1||b', 'p|1|a|', 42, 'p|2|ok|fine~good']).map(function (p) { return p.alts; }), [['fine', 'good']]);
});

test('normalising: case, punctuation, apostrophes, accents, spellings, numbers', function () {
  assert.deepStrictEqual(E.tokens("Don't  STOP—believin'!"), ['dont', 'stop', 'believin']);
  assert.strictEqual(E.norm('Café & Crème'), 'cafe and creme');
  assert.strictEqual(E.norm('the colour grey'), E.norm('the color gray'));
  assert.strictEqual(E.norm('ninety-nine percent'), E.norm('99%'));
  assert.strictEqual(E.norm('Three hundred'), '300');
  assert.strictEqual(E.norm('300,000 km'), E.norm('300000 kilometers'));
  assert.strictEqual(E.norm('3.14'), '314');
  assert.deepStrictEqual(E.tokens(''), []);
  assert.deepStrictEqual(E.tokens(null), []);
});

test('edit distance and word credit', function () {
  assert.strictEqual(E.lev('kitten', 'sitting'), 3);
  assert.strictEqual(E.lev('weird', 'wierd'), 1, 'a swap is one edit');
  assert.strictEqual(E.lev('', 'abc'), 3);
  assert.strictEqual(E.wordCredit('cake', 'cake'), 1);
  assert.strictEqual(E.wordCredit('cake', 'bake'), 0, 'short words must match');
  assert.strictEqual(E.wordCredit('the', 'thy'), 0);
  assert.strictEqual(E.wordCredit('12', '13'), 0, 'numbers must match');
  var c = E.wordCredit('nevermore', 'nevrmore');
  assert.ok(c > 0.9 && c < 1);
  assert.strictEqual(E.wordCredit('flock', 'stick'), 0);
});

test('scoring: exact, typos, partial, extra and missing words', function () {
  assert.strictEqual(sc('A penny saved', 'is a penny earned'), 1);
  assert.strictEqual(sc('A penny saved', 'IS A PENNY EARNED!!'), 1);
  assert.ok(sc('A penny saved', 'is a pnny earnd') >= 0.9, 'typos barely cost');
  assert.ok(sc('A penny saved', 'penny earned') >= 0.7, 'little words weigh less');
  var part = sc('A penny saved', 'is a penny');
  assert.ok(part >= 0.4 && part < 0.7, 'half the words: partial ' + part);
  assert.ok(sc('A penny saved', 'is a penny earned my friend') < 1 && sc('A penny saved', 'is a penny earned my friend') >= 0.7);
  assert.strictEqual(sc('A penny saved', 'gathers no moss'), 0);
  assert.strictEqual(sc('A penny saved', ''), 0);
  assert.strictEqual(sc('Let them eat', 'bake'), 0);
  assert.ok(sc('Let them eat', 'cakes') >= 0.9);
  assert.ok(sc('Birds of a feather', 'stick together') < 0.7, 'a swapped key word is not "close"');
  var oo = sc('Birds of a feather', 'together flock');
  assert.ok(oo > 0.5 && oo < 1, 'out of order earns part credit ' + oo);
});

test('scoring: variants, retyped prompt, split words, numbers', function () {
  assert.strictEqual(sc('Fortune favors', 'the brave'), 1, 'accepted variant');
  var g = E.grade(ph('Fortune favors'), 'the brave');
  assert.strictEqual(g.alt, 1);
  assert.strictEqual(g.ending, 'the brave');
  assert.strictEqual(sc('A penny saved', 'A penny saved is a penny earned'), 1, 'retyping the start is fine');
  assert.strictEqual(sc('A penny saved', 'saved is a penny earned'), 1);
  assert.strictEqual(sc('Good night, sleep tight,', 'dont let the bed bugs bite'), 1, 'bedbugs / bed bugs');
  assert.strictEqual(sc('The mitochondria is', 'the power house of the cell'), 1);
  assert.strictEqual(sc('Water boils at', '100 degrees celsius'), 1);
  assert.strictEqual(sc('Water boils at', 'one hundred degrees Celsius'), 1);
  assert.strictEqual(sc('Genius is one percent inspiration,', '99% perspiration'), 1);
  assert.strictEqual(sc('E equals', 'mc^2'), 1);
});

test('grade: highlights words on both sides', function () {
  var g = E.grade(ph('A penny saved'), 'a penny saved is a peny');
  assert.deepStrictEqual(g.endWords.map(function (w) { return w.hit; }), [1, 1, 1, 0]);
  assert.deepStrictEqual(g.ansWords.map(function (w) { return w.hit; }), [-1, -1, -1, 1, 1, 1], 'echoed prompt is marked apart');
  var g2 = E.grade(ph('Birds of a feather'), 'together flock');
  assert.ok(g2.endWords.every(function (w) { return w.hit > 0; }));
  assert.ok(g2.endWords.some(function (w) { return w.hit === 0.5; }), 'out of order is a half hit');
  assert.strictEqual(E.grade(ph('A penny saved'), '').ansWords.length, 0);
});

test('verdicts and points', function () {
  assert.strictEqual(E.verdictOf(1).id, 'perfect');
  assert.strictEqual(E.verdictOf(0.75).id, 'close');
  assert.strictEqual(E.verdictOf(0.5).id, 'partial');
  assert.strictEqual(E.verdictOf(0.2).id, 'stretch');
  assert.strictEqual(E.verdictOf(0).id, 'miss');
  assert.strictEqual(E.basePts(1), 100);
  assert.strictEqual(E.basePts(1, true), 50);
  assert.strictEqual(E.basePts(0.1), 0);
  assert.ok(E.basePts(0.6) > 0 && E.basePts(0.6) < 100);
  var a = E.soloPoints(1, { time: 0, limit: 20, streak: 1 });
  assert.deepStrictEqual(a, { base: 100, speed: 30, streak: 0, total: 130 });
  var b = E.soloPoints(1, { time: 10, limit: 20, streak: 4 });
  assert.strictEqual(b.speed, 15); assert.strictEqual(b.streak, 30);
  assert.strictEqual(E.soloPoints(1, { time: 0, limit: 20, streak: 99 }).streak, 50, 'streak bonus is capped');
  assert.strictEqual(E.soloPoints(0, { time: 0, limit: 20, streak: 3 }).total, 0);
  assert.strictEqual(E.soloPoints(1, { time: 30, limit: 20 }).speed, 0, 'out of time: no speed bonus');
  P.forEach(function (p) { var t = E.timeLimit(p); assert.ok(t >= 18 && t <= 45); });
});

test('hints', function () {
  assert.strictEqual(E.hintText(ph('A penny saved')), 'is a p____ e_____');
  assert.strictEqual(E.hintText(ph('Let them eat')), 'c___');
  assert.strictEqual(E.hintText(ph('Good night, sleep tight,')), "don't l__ t__ b______ b___");
});

test('rounds: pools, no repeats, easy → hard, fresh first, deterministic', function () {
  var opt = { diff: 'mixed', cats: ['p', 'i'] };
  var pool = E.poolOf(P, opt);
  assert.ok(pool.every(function (p) { return (p.cat === 'p' || p.cat === 'i') && p.d <= 2; }));
  var ids = E.pickRound(P, opt, E.rng(7), 10, []);
  assert.strictEqual(ids.length, 10);
  assert.strictEqual(new Set(ids).size, 10);
  var byId = {}; P.forEach(function (p) { byId[p.id] = p; });
  for (var i = 1; i < ids.length; i++) assert.ok(byId[ids[i]].d >= byId[ids[i - 1]].d, 'sorted by difficulty');
  assert.deepStrictEqual(E.pickRound(P, opt, E.rng(7), 10, []), ids, 'same seed, same round');
  var recent = pool.slice(0, pool.length - 10).map(function (p) { return p.id; });
  var fresh = E.pickRound(P, opt, E.rng(3), 10, recent);
  assert.ok(fresh.every(function (id) { return recent.indexOf(id) < 0; }), 'unseen phrases first');
  var all = E.pickRound(P, opt, E.rng(3), 10, pool.map(function (p) { return p.id; }));
  assert.strictEqual(all.length, 10, 'everything seen: still a full round');
  assert.strictEqual(E.pickRound(P, { diff: 'hard', cats: ['s'] }, E.rng(1), 10, []).length, 10);
  var d1 = E.dailyRound(P, '2026-10-31');
  assert.deepStrictEqual(E.dailyRound(P, '2026-10-31'), d1);
  assert.notDeepStrictEqual(E.dailyRound(P, '2026-11-01'), d1);
  assert.strictEqual(new Set(d1).size, 10);
  assert.strictEqual(E.dateKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('bot: legal answers, accuracy follows its level, sometimes silly', function () {
  var stats = {};
  E.CPU_LEVELS.forEach(function (L) {
    var r = E.rng(99), tot = 0, kinds = {};
    for (var i = 0; i < 1500; i++) {
      var p = P[Math.floor(r() * P.length)];
      var g = E.cpuGuess(p, L.id, r, P);
      assert.strictEqual(typeof g.text, 'string');
      assert.ok(g.think > 0 && g.think < 12);
      assert.ok(['exact', 'typo', 'close', 'wrong', 'silly', 'blank'].indexOf(g.kind) >= 0);
      if (g.kind === 'exact') assert.strictEqual(E.grade(p, g.text).score, 1);
      tot += E.grade(p, g.text).score;
      kinds[g.kind] = (kinds[g.kind] || 0) + 1;
    }
    stats[L.id] = { avg: tot / 1500, kinds: kinds };
  });
  assert.ok(stats.easy.avg < stats.medium.avg && stats.medium.avg < stats.hard.avg, JSON.stringify(stats));
  assert.ok(stats.hard.avg > 0.7 && stats.easy.avg < 0.6);
  assert.ok(stats.easy.kinds.silly > 20 && stats.easy.kinds.wrong > 20, 'funny wrong answers happen');
  var a = E.cpuGuess(P[5], 'medium', E.rng(4), P), b = E.cpuGuess(P[5], 'medium', E.rng(4), P);
  assert.deepStrictEqual(a, b, 'deterministic for a seed');
  assert.ok(E.cpuGuess(P[5], 'nope', E.rng(4), P).text != null, 'unknown level falls back');
});

test('saves: new, normalise junk, settle solo / daily / cpu', function () {
  var s = E.newSave();
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({ solo: { best: -4, games: 'x', last: [1, 'a', 3] }, daily: { date: 'nope', best: 5 }, cpu: { hard: { w: 2, l: -1 } }, cat: { p: { n: 2, s: 9 } }, recent: [1, -2, 3.5, 'x', 4] });
  assert.strictEqual(bad.solo.best, 0); assert.strictEqual(bad.solo.games, 0);
  assert.deepStrictEqual(bad.solo.last, [1, 0, 3]);
  assert.strictEqual(bad.daily.date, ''); assert.strictEqual(bad.daily.best, 5);
  assert.deepStrictEqual(bad.cpu.hard, { w: 2, l: 0, d: 0 });
  assert.deepStrictEqual(bad.cat.p, { n: 2, s: 2 });
  assert.deepStrictEqual(bad.recent, [1, 4]);
  assert.deepStrictEqual(E.normSave(null), s);
  assert.deepStrictEqual(E.normSave('junk'), s);

  var r1 = E.settleSolo(s, { score: 900, bestStreak: 4, perfects: 5, answered: 10, acc: 7.5 });
  assert.ok(r1.best && r1.streak);
  assert.strictEqual(s.solo.best, 900); assert.strictEqual(s.solo.answered, 10);
  var r2 = E.settleSolo(s, { score: 400, bestStreak: 1, perfects: 0, answered: 10, acc: 3 });
  assert.ok(!r2.best && !r2.streak);
  assert.deepStrictEqual(s.solo.last, [900, 400]);
  var d1 = E.settleSolo(s, { score: 500, bestStreak: 0, perfects: 0, answered: 10, acc: 5, daily: true, date: '2026-10-30' });
  assert.ok(d1.dailyFirst && d1.daily); assert.strictEqual(s.daily.streak, 1);
  E.settleSolo(s, { score: 300, bestStreak: 0, perfects: 0, answered: 10, acc: 5, daily: true, date: '2026-10-31' });
  assert.strictEqual(s.daily.streak, 2, 'next day extends the streak');
  assert.strictEqual(s.daily.best, 500);
  E.settleSolo(s, { score: 700, bestStreak: 0, perfects: 0, answered: 10, acc: 5, daily: true, date: '2026-10-31' });
  assert.strictEqual(s.daily.score, 700); assert.strictEqual(s.daily.played, 2, 'replay the same day: not another day');
  E.settleSolo(s, { score: 100, bestStreak: 0, perfects: 0, answered: 10, acc: 5, daily: true, date: '2026-11-05' });
  assert.strictEqual(s.daily.streak, 1, 'a gap resets the streak');

  assert.strictEqual(E.settleCpu(s, 'hard', 500, 400), 'w');
  assert.strictEqual(E.settleCpu(s, 'hard', 300, 400), 'l');
  assert.strictEqual(E.settleCpu(s, 'easy', 300, 300), 'd');
  assert.deepStrictEqual(s.cpu.hard, { w: 1, l: 1, d: 0 });
  E.addCat(s, ph('A penny saved'), 0.5);
  assert.deepStrictEqual(s.cat.p, { n: 1, s: 0.5 });
  E.remember(s, [1, 2, 3]);
  assert.deepStrictEqual(s.recent, [1, 2, 3]);
  var big = []; for (var i = 0; i < 400; i++) big.push(i);
  E.remember(s, big);
  assert.strictEqual(s.recent.length, 150);
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s, 'round-trips through JSON');
});

test('setup: normalise', function () {
  var d = E.newSetup();
  assert.deepStrictEqual(E.normSetup(null), d);
  var n = E.normSetup({ mode: 'party', diff: 'zzz', cats: ['q', 'nope'], cpu: 'hard', n: 9, names: ['Ann', 7, 'a very long name indeed'], rounds: 4, timer: false });
  assert.strictEqual(n.mode, 'party'); assert.strictEqual(n.diff, 'mixed');
  assert.deepStrictEqual(n.cats, ['q']); assert.strictEqual(n.cpu, 'hard');
  assert.strictEqual(n.n, 5); assert.deepStrictEqual(n.names, ['Ann', '', 'a very long na', '', '']);
  assert.strictEqual(n.rounds, 5); assert.strictEqual(n.timer, false);
  assert.deepStrictEqual(E.normSetup({ cats: [] }).cats, d.cats, 'never no categories');
  assert.strictEqual(E.normSetup({ n: 1 }).n, 2);
});

test('party: turn order rotates, standings rank ties', function () {
  assert.deepStrictEqual(E.turnOrder(3, 0), [0, 1, 2]);
  assert.deepStrictEqual(E.turnOrder(3, 1), [1, 2, 0]);
  assert.deepStrictEqual(E.turnOrder(3, 5), [2, 0, 1]);
  var st = E.standings([{ score: 300, perfects: 1 }, { score: 500, perfects: 2 }, { score: 300, perfects: 1 }, { score: 300, perfects: 2 }]);
  assert.deepStrictEqual(st.map(function (x) { return [x.i, x.rank]; }), [[1, 1], [3, 2], [0, 3], [2, 3]]);
});

test('a whole simulated solo round with the bot as the player', function () {
  var r = E.rng(2024), ids = E.pickRound(P, { diff: 'all' }, r, 10, []), total = 0, streak = 0, best = 0;
  ids.forEach(function (id) {
    var p = P.filter(function (x) { return x.id === id; })[0];
    var g = E.cpuGuess(p, 'hard', r, P), gr = E.grade(p, g.text);
    streak = gr.score >= E.STREAK_AT ? streak + 1 : 0;
    best = Math.max(best, streak);
    var pts = E.soloPoints(gr.score, { time: g.think, limit: E.timeLimit(p), streak: streak });
    assert.ok(pts.total >= 0 && pts.total <= 180);
    total += pts.total;
  });
  assert.ok(total > 0 && total <= 1800);
});

test('anti-farming: word salad and echoing the prompt score nothing', function () {
  // the most common ending words, crammed into one 200-char answer
  var freq = {};
  P.forEach(function (p) { E.tokens(p.end).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; }); });
  var spam = '';
  Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).forEach(function (w) { if ((spam + ' ' + w).length <= 200) spam += (spam ? ' ' : '') + w; });
  var tot = 0, partial = 0;
  P.forEach(function (p) { var s = E.grade(p, spam).score; tot += s; if (s >= 0.4) partial++; });
  assert.ok(tot / P.length < 0.06, 'spam average ' + (tot / P.length));
  assert.strictEqual(partial, 0, 'spam never reaches PARTIAL');
  // retyping just the start (or its last words) earns nothing
  assert.strictEqual(sc('A penny saved', 'A penny saved'), 0);
  assert.strictEqual(sc('A penny saved', 'penny saved'), 0);
  var g = E.grade(ph('A penny saved'), 'a penny saved');
  assert.ok(g.ansWords.every(function (w) { return w.hit === -1; }), 'echoed words are marked as echo');
  // …but a right answer with a few extra words still does well, and the right answer is still 100%
  assert.ok(sc('A penny saved', 'is a penny earned and then some more words here') >= 0.5);
  assert.ok(sc('A penny saved', 'is a penny earned, my friend') >= 0.7);
  assert.strictEqual(sc('A penny saved', 'a penny saved is a penny earned'), 1);
  assert.strictEqual(sc('Better late', 'late than never'), 1);
  // endings that begin like the start are not mistaken for an echo
  P.forEach(function (p) { assert.strictEqual(E.grade(p, p.start + ' ' + p.end).score, 1, 'start+end: ' + p.start); });
});

test('CPU answers are always strings and never hang (all levels, every phrase)', function () {
  var r = E.rng(7);
  ['easy', 'medium', 'hard', 'bogus'].forEach(function (lv) {
    P.forEach(function (p) {
      var g = E.cpuGuess(p, lv, r, P);
      assert.strictEqual(typeof g.text, 'string');
      assert.ok(isFinite(g.think) && g.think > 0 && g.think < 10);
      assert.ok(g.text.length <= 200);
      var s = E.grade(p, g.text).score;
      assert.ok(s >= 0 && s <= 1);
    });
  });
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
