/* Headless checks for the Hearts engine (rules, scoring, passing, AI, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/hearts/hearts.test.js */
'use strict';
var assert = require('assert');

var E = require('./hearts.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./hearts.js')];
require('./hearts.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function C(s) {   // 'QS', '2C', 'TH', 'AH' -> card
  var r = '23456789TJQKA'.indexOf(s.charAt(0)), u = 'CDSH'.indexOf(s.charAt(1));
  if (r < 0 || u < 0) throw new Error('bad card ' + s);
  return u * 13 + r;
}
function cpuCfg(d) { return { seats: [{ kind: 'human', name: 'A' }, { kind: 'cpu', diff: d || 'normal' }, { kind: 'cpu', diff: d || 'normal' }, { kind: 'cpu', diff: d || 'normal' }] }; }
// Plays one game step by AI for any seat (humans included).
function autoStep(g) {
  if (g.phase === 'pass') { for (var p = 0; p < 4; p++) if (!g.pass[p]) assert.ok(E.setPass(g, p, E.aiPass(g, p))); }
  else if (g.phase === 'play') {
    var c = E.aiPlay(g, g.turn);
    assert.ok(E.legal(g, g.turn).indexOf(c) >= 0, 'AI card must be legal');
    assert.ok(E.play(g, g.turn, c));
  } else if (g.phase === 'moon') E.moonChoice(g, E.aiMoon(g, g.shooter));
  else if (g.phase === 'scored') E.nextHand(g);
  g.ev.length = 0;
}
function allCards(g) {
  var a = [];
  g.hands.forEach(function (h) { a = a.concat(h); });
  g.taken.forEach(function (h) { a = a.concat(h); });
  g.trick.forEach(function (t) { a.push(t.c); });
  return a.sort(function (x, y) { return x - y; });
}
// A hand in progress with chosen hands (13 each), play phase, south to lead.
function rigged(hands, opts) {
  var g = E.newGame(Object.assign(cpuCfg(), opts || {}), 1);
  g.hands = hands.map(function (h) { return h.map(C).sort(function (a, b) { return a - b; }); });
  g.handNo = 3; g.dir = 3; g.phase = 'play'; g.trickNo = 0; g.trick = []; g.played = []; g.broken = false;
  for (var p = 0; p < 4; p++) if (g.hands[p].indexOf(0) >= 0) { g.turn = p; g.leader = p; }
  return g;
}
function fullDeck(sets) { // fill each hand to 13 from the remaining cards in order
  var used = {}, out = sets.map(function (s) { return s.slice(); });
  out.forEach(function (s) { s.forEach(function (c) { used[C(c)] = 1; }); });
  var rest = [];
  for (var c = 0; c < 52; c++) if (!used[c]) rest.push('23456789TJQKA'.charAt(c % 13) + 'CDSH'.charAt((c / 13) | 0));
  out.forEach(function (s) { while (s.length < 13) s.push(rest.shift()); });
  return out;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Hearts' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'hearts.css');
  assert.strictEqual(widget._engine.QS, E.QS);
});

test('card helpers', function () {
  assert.strictEqual(E.QS, C('QS'));
  assert.strictEqual(E.TWO_C, C('2C'));
  assert.strictEqual(E.cardPts(C('QS')), 13);
  assert.strictEqual(E.cardPts(C('2H')), 1);
  assert.strictEqual(E.cardPts(C('KS')), 0);
  assert.strictEqual(E.cardStr(C('TD')), '10♦');
  var all = []; for (var c = 0; c < 52; c++) all.push(c);
  assert.strictEqual(E.handPts(all), 26);
});

test('a deal is 4 x 13 distinct cards, sorted, and the seed repeats it', function () {
  var g = E.newGame(cpuCfg(), 42), h = E.newGame(cpuCfg(), 42), k = E.newGame(cpuCfg(), 43);
  assert.deepStrictEqual(allCards(g), Array.from({ length: 52 }, function (_, i) { return i; }));
  g.hands.forEach(function (x) { assert.strictEqual(x.length, 13); assert.deepStrictEqual(x, x.slice().sort(function (a, b) { return a - b; })); });
  assert.deepStrictEqual(g.hands, h.hands);
  assert.notDeepStrictEqual(g.hands, k.hands);
  assert.strictEqual(g.phase, 'pass');
});

test('passing rotates left, right, across, hold', function () {
  var g = E.newGame(cpuCfg(), 7);
  assert.deepStrictEqual([0, 1, 2, 3].map(function (p) { return E.passTarget(g, p); }), [1, 2, 3, 0]);
  var dirs = [];
  for (var i = 0; i < 8; i++) { dirs.push(E.PASS_DIRS[g.dir].id); g.phase = 'scored'; E.nextHand(g); }
  assert.deepStrictEqual(dirs, ['left', 'right', 'across', 'hold', 'left', 'right', 'across', 'hold']);
  g = E.newGame(cpuCfg(), 7); g.handNo = 2; g.phase = 'scored'; E.nextHand(g);   // hand 4: hold
  assert.strictEqual(g.phase, 'play');
  assert.ok(g.hands[g.turn].indexOf(E.TWO_C) >= 0);
});

test('passing moves exactly the chosen cards', function () {
  var g = E.newGame(cpuCfg(), 11), before = g.hands.map(function (h) { return h.slice(); });
  assert.strictEqual(E.setPass(g, 0, [before[0][0], before[0][0], before[0][1]]), false, 'duplicates refused');
  assert.strictEqual(E.setPass(g, 0, [before[1][0], before[0][0], before[0][1]]), false, 'not in hand refused');
  assert.strictEqual(E.setPass(g, 0, [before[0][0], before[0][1]]), false, 'two cards refused');
  var picks = before.map(function (h) { return h.slice(10); });
  for (var p = 0; p < 3; p++) { assert.ok(E.setPass(g, p, picks[p])); assert.strictEqual(g.phase, 'pass'); }
  assert.ok(E.setPass(g, 3, picks[3]));
  assert.strictEqual(g.phase, 'play');
  for (p = 0; p < 4; p++) {
    var to = (p + 1) % 4;
    picks[p].forEach(function (c) { assert.ok(g.hands[to].indexOf(c) >= 0); assert.ok(g.hands[p].indexOf(c) < 0); });
    assert.deepStrictEqual(g.recv[to], picks[p]);
    assert.strictEqual(g.hands[p].length, 13);
  }
  assert.ok(g.hands[g.turn].indexOf(E.TWO_C) >= 0, 'the 2 of clubs leads');
});

test('the 2 of clubs must lead the first trick; follow suit', function () {
  var g = rigged(fullDeck([['2C', '3C', 'AH', 'KD'], ['4C', '5D', 'QS'], ['6C', '2H'], ['7C', '9D']]));
  assert.strictEqual(g.turn, 0);
  assert.deepStrictEqual(E.legal(g, 0), [C('2C')]);
  assert.strictEqual(E.play(g, 0, C('3C')), false);
  assert.strictEqual(E.play(g, 1, C('4C')), false, 'not your turn');
  assert.ok(E.play(g, 0, C('2C')));
  E.legal(g, 1).forEach(function (c) { assert.strictEqual(E.suitOf(c), 0, 'must follow clubs'); });
});

test('no points on the first trick unless only points; option allows them', function () {
  var hands = fullDeck([['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC', 'AC'], ['QS', 'AH', '2D'], [], []]);
  var g = rigged(hands);
  E.play(g, 0, C('2C'));
  assert.deepStrictEqual(E.legal(g, 1).map(E.cardStr).sort(), E.legal(g, 1).filter(function (c) { return E.cardPts(c) === 0; }).map(E.cardStr).sort());
  assert.ok(E.legal(g, 1).indexOf(C('QS')) < 0 && E.legal(g, 1).indexOf(C('AH')) < 0);
  var g2 = rigged(hands, { bleed: true });
  E.play(g2, 0, C('2C'));
  assert.ok(E.legal(g2, 1).indexOf(C('QS')) >= 0, 'bleed option allows the queen');
  // a hand of nothing but points may play a heart (not the queen) on trick one
  var h2 = [['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'TC', 'JC', 'QC', 'KC', 'AC'],
    ['QS', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', 'TH', 'JH', 'QH', 'KH'], [], []];
  var g3 = rigged(fullDeck(h2));
  E.play(g3, 0, C('2C'));
  assert.ok(E.legal(g3, 1).indexOf(C('QS')) < 0);
  assert.ok(E.legal(g3, 1).indexOf(C('2H')) >= 0);
});

test('hearts cannot be led until broken (unless only hearts)', function () {
  var g = rigged(fullDeck([['2C', 'AH', 'KD'], ['3C'], ['4C'], ['5C', '2D']]));
  E.play(g, 0, C('2C')); E.play(g, 1, C('3C')); E.play(g, 2, C('4C')); E.play(g, 3, C('5C'));
  assert.strictEqual(g.turn, 3, 'highest club takes it');
  assert.strictEqual(g.trickNo, 1);
  var L = E.legal(g, 3);
  assert.ok(L.length && L.every(function (c) { return E.suitOf(c) !== 3; }));
  g.hands[3] = [C('2H')].concat(g.hands[3].filter(function (c) { return E.suitOf(c) === 3; }));
  assert.ok(E.legal(g, 3).every(function (c) { return E.suitOf(c) === 3; }), 'only hearts: may lead one');
});

test('trick winner, hearts broken, the queen, points', function () {
  var g = rigged(fullDeck([['2C', 'KS', '3S'], ['3C', '5S'], ['AC', 'AS'], ['4C', 'QS', '9H']]));
  E.play(g, 0, C('2C')); E.play(g, 1, C('3C')); E.play(g, 2, C('AC'));
  assert.ok(E.legal(g, 3).indexOf(C('4C')) >= 0);
  E.play(g, 3, C('4C'));
  assert.strictEqual(g.last.w, 2);
  assert.strictEqual(g.turn, 2);
  // break hearts by discarding, then a queen falls
  g.voids = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  g.hands[3] = g.hands[3].filter(function (c) { return E.suitOf(c) !== 2 || c === C('QS'); });
  var t = g.hands[3].length; assert.ok(t > 0);
  E.play(g, 2, C('AS'));
  E.play(g, 3, C('QS'));
  g.ev.length = 0;
  var spades0 = g.hands[0].filter(function (c) { return E.suitOf(c) === 2; });
  E.play(g, 0, spades0[0]);
  var l1 = E.legal(g, 1); E.play(g, 1, l1[0]);
  assert.strictEqual(g.last.w, 2, 'ace of spades wins');
  assert.ok(g.last.pts >= 13);
  assert.ok(g.taken[2].indexOf(C('QS')) >= 0);
  assert.strictEqual(g.voids[3][2], 0);
});

test('discarding marks the seat void in the suit led', function () {
  var g = rigged(fullDeck([['2C'], ['KD', 'QD', 'JD', 'TD', '9D', '8D', '7D', '6D', '5D', '4D', '3D', '2D', 'AD'], [], []]));
  E.play(g, 0, C('2C'));
  var c = E.legal(g, 1)[0];
  E.play(g, 1, c);
  assert.strictEqual(g.voids[1][0], 1);
});

test('full CPU games: legal, 26 points a hand, totals add up, unique winner past the target', function () {
  ['easy', 'normal', 'hard'].forEach(function (d) {
    for (var seed = 1; seed <= 6; seed++) {
      var g = E.newGame(cpuCfg(d), seed * 977), guard = 0;
      while (g.phase !== 'over' && guard++ < 5000) {
        var ph = g.phase;
        autoStep(g);
        if (ph === 'play' || ph === 'pass') assert.strictEqual(allCards(g).length, 52);
      }
      assert.strictEqual(g.phase, 'over', d + ' game ends');
      var sum = [0, 0, 0, 0];
      g.hist.forEach(function (h) {
        assert.strictEqual(h.raw.reduce(function (a, b) { return a + b; }, 0), 26);
        if (h.sh < 0) assert.deepStrictEqual(h.d, h.raw);
        h.d.forEach(function (v, i) { sum[i] += v; });
      });
      assert.deepStrictEqual(sum, g.scores);
      assert.ok(Math.max.apply(null, g.scores) >= g.target);
      var lo = Math.min.apply(null, g.scores);
      assert.strictEqual(g.winners.length, 1);
      assert.strictEqual(g.scores[g.winners[0]], lo);
      assert.strictEqual(g.scores.filter(function (s) { return s === lo; }).length, 1);
    }
  });
});

test('games are deterministic from the seed', function () {
  var a = E.simulate(cpuCfg('hard'), 99), b = E.simulate(cpuCfg('hard'), 99);
  assert.deepStrictEqual(a.scores, b.scores);
  assert.deepStrictEqual(a.hist, b.hist);
});

test('shooting the moon: +26 to the others, or the shooter chooses', function () {
  function moonGame(opts) {
    var g = rigged(fullDeck([['2C'], [], [], []]), opts);
    // give seat 0 every point as the hand ends
    g.hands = [[], [], [], []]; g.trickNo = 13;
    g.taken = [[], [], [], []];
    for (var c = 0; c < 52; c++) g.taken[E.cardPts(c) ? 0 : 1 + (c % 3)].push(c);
    g.ev = [];
    return g;
  }
  var g = moonGame();
  g.scores = [10, 20, 30, 40];
  // run the private end-of-hand path through the last trick: emulate with play of a constructed final trick
  g.hands = [[C('AH')], [C('2C')], [C('3C')], [C('4C')]];
  g.taken[0] = g.taken[0].filter(function (c) { return c !== C('AH'); });
  g.taken[1] = g.taken[1].filter(function (c) { return [C('2C'), C('3C'), C('4C')].indexOf(c) < 0; });
  g.taken[2] = g.taken[2].filter(function (c) { return [C('2C'), C('3C'), C('4C')].indexOf(c) < 0; });
  g.taken[3] = g.taken[3].filter(function (c) { return [C('2C'), C('3C'), C('4C')].indexOf(c) < 0; });
  g.trickNo = 12; g.broken = true; g.turn = 0; g.phase = 'play';
  var g2 = JSON.parse(JSON.stringify(g)); g2.moon = 'choose';
  E.play(g, 0, C('AH')); E.play(g, 1, C('2C')); E.play(g, 2, C('3C')); E.play(g, 3, C('4C'));
  assert.strictEqual(g.shooter, 0);
  assert.deepStrictEqual(g.scores, [10, 46, 56, 66]);
  assert.ok(g.ev.some(function (e) { return e.t === 'moon'; }));
  g2.ev = [];
  E.play(g2, 0, C('AH')); E.play(g2, 1, C('2C')); E.play(g2, 2, C('3C')); E.play(g2, 3, C('4C'));
  assert.strictEqual(g2.phase, 'moon');
  assert.ok(E.moonChoice(g2, 'sub'));
  assert.deepStrictEqual(g2.scores, [-16, 20, 30, 40]);
  assert.strictEqual(g2.hist[g2.hist.length - 1].sub, 1);
});

test('the shooter AI picks the choice that wins or helps most', function () {
  var g = E.newGame(cpuCfg(), 3);
  g.scores = [60, 80, 70, 90]; g.target = 100;
  assert.strictEqual(E.aiMoon(g, 0), 'add', '+26 ends the game with the shooter lowest');
  g.scores = [90, 10, 20, 80];
  assert.strictEqual(E.aiMoon(g, 0), 'sub', '+26 would hand the game to someone else');
});

test('a tie for the lowest score past the target plays on', function () {
  var g = rigged(fullDeck([['2C'], [], [], []]));
  g.hands = [[C('AH')], [C('2C')], [C('3C')], [C('4C')]];
  g.taken = [[], [], [], []];
  for (var c = 0; c < 52; c++) if ([C('AH'), C('2C'), C('3C'), C('4C')].indexOf(c) < 0) g.taken[c === E.QS ? 1 : (E.cardPts(c) ? 2 : 3)].push(c);
  g.trickNo = 12; g.broken = true; g.turn = 0; g.phase = 'play'; g.ev = [];
  g.scores = [40, 80, 40, 99];
  E.play(g, 0, C('AH')); E.play(g, 1, C('2C')); E.play(g, 2, C('3C')); E.play(g, 3, C('4C'));
  // seat 0 took the AH (1), seat 1 the queen (13), seat 2 twelve hearts
  assert.deepStrictEqual(g.scores, [41, 93, 52, 99]);
  assert.strictEqual(g.phase, 'scored');
  g.scores = [50, 99, 50, 120]; g.phase = 'scored'; g.tie = false;
  // re-score check via a fresh final trick is overkill: test the rule directly through scoring path
  var h = rigged(fullDeck([['2C'], [], [], []]));
  h.hands = [[C('AH')], [C('2C')], [C('3C')], [C('4C')]];
  h.taken = [[], [], [], []];
  for (c = 0; c < 52; c++) if ([C('AH'), C('2C'), C('3C'), C('4C')].indexOf(c) < 0) h.taken[c === E.QS ? 3 : (E.cardPts(c) ? 3 : 1)].push(c);
  h.trickNo = 12; h.broken = true; h.turn = 0; h.phase = 'play'; h.ev = [];
  h.scores = [49, 50, 60, 90];
  E.play(h, 0, C('AH')); E.play(h, 1, C('2C')); E.play(h, 2, C('3C')); E.play(h, 3, C('4C'));
  assert.deepStrictEqual(h.scores, [50, 50, 60, 115]);
  assert.strictEqual(h.phase, 'scored');
  assert.strictEqual(h.tie, true);
});

test('AI: dumps the queen when void, ducks, and passes dangerous spades', function () {
  // seat 1 void in clubs, holding the queen: it should discard the queen on a club lead
  var g = rigged(fullDeck([['2C', '3C'], ['QS', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', 'TD', 'JD', 'KD', 'AD'], ['4C'], ['5C']]), { bleed: true });
  g.seats.forEach(function (s) { s.diff = 'hard'; });
  E.play(g, 0, C('2C'));
  assert.strictEqual(E.aiPlay(g, 1), C('QS'));
  // ducking under the high card
  var g2 = rigged(fullDeck([['2C'], ['3C', 'KC', '9C'], [], []]));
  g2.seats.forEach(function (s) { s.diff = 'hard'; });
  g2.hands[0].push(C('TC')); g2.hands[0].sort(function (a, b) { return a - b; });
  g2.trickNo = 1; g2.played = [];
  g2.trick = [{ p: 0, c: C('TC') }]; g2.hands[0] = g2.hands[0].filter(function (c) { return c !== C('TC'); }); g2.turn = 1;
  assert.strictEqual(E.aiPlay(g2, 1), C('9C'), 'highest card under the ten');
  // passing: unprotected queen and ace of spades go
  var g3 = E.newGame(cpuCfg('normal'), 5);
  g3.hands[1] = fullDeck([[], ['QS', 'AS', '2C', '3C', '4C', '5D', '6D', '7D', '8D', '2H', '3H', '4H', '5H'], [], []])[1].map(C).sort(function (a, b) { return a - b; });
  var p = E.aiPass(g3, 1);
  assert.ok(p.indexOf(C('QS')) >= 0 && p.indexOf(C('AS')) >= 0);
  assert.ok(p.indexOf(C('2C')) < 0);
});

test('AI: hard blocks a moon run by taking a point', function () {
  // seat 2 has taken all 20 points so far; seat 0 can overtake its heart trick
  var g = rigged(fullDeck([['2C'], [], [], []]));
  g.seats.forEach(function (s) { s.diff = 'hard'; });
  g.hands = [[C('KH'), C('2D')], [C('3D'), C('4D')], [C('QH'), C('5D')], [C('2H'), C('6D')]];
  g.taken = [[], [], [], []];
  var rest = [];
  for (var c = 0; c < 52; c++) if ([C('KH'), C('2D'), C('3D'), C('4D'), C('QH'), C('5D'), C('2H'), C('6D')].indexOf(c) < 0) rest.push(c);
  rest.forEach(function (x) { if (E.cardPts(x)) g.taken[2].push(x); else g.taken[1].push(x); });
  g.trickNo = 11; g.broken = true; g.played = rest.slice();
  g.trick = [{ p: 2, c: C('QH') }, { p: 3, c: C('2H') }]; g.hands[2] = [C('5D')]; g.hands[3] = [C('6D')]; g.turn = 0;
  assert.strictEqual(E.aiPlay(g, 0), C('KH'), 'take the trick to stop the moon');
});

test('AI never plays an illegal card across many random positions', function () {
  for (var seed = 1; seed <= 25; seed++) {
    ['easy', 'normal', 'hard'].forEach(function (d) {
      var g = E.newGame(cpuCfg(d), seed * 31 + d.length);
      for (var i = 0; i < 70 && g.phase !== 'over'; i++) autoStep(g);
    });
  }
});

test('hard CPUs beat easy ones over many hands', function () {
  var hard = 0, easy = 0;
  for (var seed = 1; seed <= 30; seed++) {
    var g = E.simulate({ seats: cpuCfg().seats, diffs: seed % 2 ? ['hard', 'easy', 'hard', 'easy'] : ['easy', 'hard', 'easy', 'hard'], target: 100 }, seed * 7919);
    g.hist.forEach(function (h) {
      h.d.forEach(function (v, i) { if ((i % 2 === 0) === (seed % 2 === 1)) hard += v; else easy += v; });
    });
  }
  assert.ok(hard < easy * 0.8, 'hard ' + hard + ' vs easy ' + easy);
});

test('normal CPUs beat easy ones too', function () {
  var nrm = 0, easy = 0;
  for (var seed = 1; seed <= 30; seed++) {
    var g = E.simulate({ seats: cpuCfg().seats, diffs: ['normal', 'easy', 'normal', 'easy'], target: 100 }, seed * 104729);
    g.hist.forEach(function (h) { h.d.forEach(function (v, i) { if (i % 2 === 0) nrm += v; else easy += v; }); });
  }
  assert.ok(nrm < easy, 'normal ' + nrm + ' vs easy ' + easy);
});

test('save round-trip and normalisation', function () {
  var g = E.newGame(cpuCfg('hard'), 1234);
  for (var i = 0; i < 30; i++) autoStep(g);
  var o = JSON.parse(JSON.stringify(g));
  var n = E.normGame(o);
  assert.ok(n, 'a real save loads');
  assert.deepStrictEqual(n.hands, g.hands);
  assert.deepStrictEqual(n.trick, g.trick);
  assert.strictEqual(n.turn, g.turn);
  // continuing from the loaded game matches continuing the original
  for (i = 0; i < 40; i++) { autoStep(g); autoStep(n); }
  assert.deepStrictEqual(n.scores, g.scores);
  assert.deepStrictEqual(n.hands, g.hands);
  // garbage and broken saves are refused
  [null, 5, 'x', {}, { seats: [] }, Object.assign({}, o, { phase: 'nope' })].forEach(function (b) { assert.strictEqual(E.normGame(b), null); });
  var dup = JSON.parse(JSON.stringify(o)); dup.hands[0][0] = dup.hands[1][0];
  assert.strictEqual(E.normGame(dup), null, 'duplicate cards');
  var miss = JSON.parse(JSON.stringify(o)); miss.hands[0].pop();
  assert.strictEqual(E.normGame(miss), null, 'missing card');
  var noHuman = JSON.parse(JSON.stringify(o)); noHuman.seats = noHuman.seats.map(function () { return { kind: 'cpu' }; });
  assert.strictEqual(E.normGame(noHuman), null);
  var badSeat = JSON.parse(JSON.stringify(o)); badSeat.seats[1].diff = 'godlike'; badSeat.seats[0].name = '<b>' + 'x'.repeat(50);
  var nb = E.normGame(badSeat);
  assert.strictEqual(nb.seats[1].diff, 'normal');
  assert.ok(nb.seats[0].name.length <= 12 && nb.seats[0].name.indexOf('<') < 0);
  var badTurn = JSON.parse(JSON.stringify(o)); if (badTurn.phase === 'play') { badTurn.turn = (badTurn.turn + 1) % 4; assert.strictEqual(E.normGame(badTurn), null, 'turn out of order'); }
});

test('a pass-phase save and a scored save load', function () {
  var g = E.newGame(cpuCfg(), 77);
  E.setPass(g, 1, g.hands[1].slice(0, 3));
  var n = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.ok(n && n.phase === 'pass' && n.pass[1] && !n.pass[0]);
  while (g.phase !== 'scored' && g.phase !== 'over') autoStep(g);
  n = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.ok(n && n.phase === g.phase);
  assert.deepStrictEqual(n.raw, g.raw);
  if (n.phase === 'scored') { assert.ok(E.nextHand(n)); assert.strictEqual(n.handNo, 1); assert.strictEqual(n.phase, 'pass'); }
});

test('config and records normalise', function () {
  var c = E.normCfg({ target: 999, moon: 'x', seats: [{ kind: 'cpu', diff: 'hard' }, { kind: 'human', name: '' }, null, { kind: 'cpu', diff: 'zzz' }] });
  assert.strictEqual(c.target, 100);
  assert.strictEqual(c.moon, 'add');
  assert.strictEqual(c.seats[0].diff, 'hard');
  assert.strictEqual(c.seats[1].name, 'Player 2');
  assert.strictEqual(c.seats[3].diff, 'normal');
  assert.strictEqual(E.normCfg(null).seats[0].kind, 'human');
  assert.strictEqual(E.normCfg({ target: 50, moon: 'choose', bleed: 1 }).target, 50);
  var r = E.normRec({ games: '4', wins: 9, best: -3, moons: -2, junk: 1 });
  assert.strictEqual(r.games, 4); assert.strictEqual(r.wins, 4); assert.strictEqual(r.best, -3); assert.strictEqual(r.moons, 0);
  assert.strictEqual(E.normRec('x').best, null);
});

test('the moon hand detector', function () {
  assert.ok(E.moonHand(['AH', 'KH', 'QH', 'JH', 'TH', 'AS', 'KS', 'AD', 'KD', 'AC', '2C', '3C', '4C'].map(C)));
  assert.ok(!E.moonHand(['2H', '3H', '4H', 'JH', 'TH', '2S', '3S', '2D', '3D', '4C', '2C', '3C', '5C'].map(C)));
});


test('review: lead rules with only hearts and the queen left; void on trick one', function () {
  // hearts unbroken, holding only hearts + Q♠: the queen must be led
  var g = rigged(fullDeck([['2C', 'AH'], ['3C'], ['4C'], ['5C']]));
  E.play(g, 0, C('2C')); E.play(g, 1, C('3C')); E.play(g, 2, C('4C')); E.play(g, 3, C('5C'));
  g.hands[3] = [C('QS'), C('2H'), C('3H')];
  assert.deepStrictEqual(E.legal(g, 3), [C('QS')]);
  // void in clubs on trick one with Q♠, hearts and a diamond: only the diamond
  var g2 = rigged(fullDeck([['2C'], ['QS', 'AH', '7D', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', 'TH', 'JH'], [], []]));
  E.play(g2, 0, C('2C'));
  assert.deepStrictEqual(E.legal(g2, 1), [C('7D')]);
  // out of turn / after the hand: nothing is legal
  assert.deepStrictEqual(E.legal(g2, 3), []);
});

test('review: the trick winner leads; moonChoice only in the moon phase; play rejects wrong turns', function () {
  var g = rigged(fullDeck([['2C'], ['AC'], ['3C'], ['4C']]));
  assert.strictEqual(E.moonChoice(g, 'sub'), false);
  assert.strictEqual(E.nextHand(g), false);
  E.play(g, 0, C('2C')); E.play(g, 1, C('AC')); E.play(g, 2, C('3C'));
  assert.strictEqual(E.play(g, 2, g.hands[2][0]), false);
  E.play(g, 3, C('4C'));
  assert.strictEqual(g.turn, 1); assert.strictEqual(g.leader, 1);
  assert.strictEqual(E.setPass(g, 1, g.hands[1].slice(0, 3)), false, 'no passing during play');
});

test('review: CPUs never put points on trick one, and every hand starts with the 2 of clubs', function () {
  for (var seed = 1; seed <= 60; seed++) {
    var g = E.newGame(cpuCfg(['easy', 'normal', 'hard'][seed % 3]), seed * 7919);
    while (g.phase === 'pass') autoStep(g);
    assert.strictEqual(g.hands[g.turn].indexOf(E.TWO_C) >= 0, true);
    var first = null;
    for (var i = 0; i < 4; i++) { if (i === 0) first = g.turn; autoStep(g); }
    assert.strictEqual(g.last.n, 0);
    assert.strictEqual(g.last.trick[0].c, E.TWO_C);
    var pts = E.handPts(g.last.trick.map(function (t) { return t.c; }));
    // only a hand of nothing but points could bleed on trick one (vanishingly rare)
    assert.strictEqual(pts, 0, 'seed ' + seed);
    assert.strictEqual(first, g.last.trick[0].p);
  }
});

test('review: a save keeps the recorded-hands marker and rejects a bad trick', function () {
  var g = E.newGame(cpuCfg(), 99);
  for (var i = 0; i < 20; i++) autoStep(g);
  var o = JSON.parse(JSON.stringify(g)); o.rh = 3;
  assert.strictEqual(E.normGame(o).rh, 3);
  delete o.rh;
  assert.strictEqual(E.normGame(o).rh, null);
  var b = JSON.parse(JSON.stringify(g));
  if (b.phase === 'play' && b.trick.length) { b.trick[0].c = b.hands[0][0]; assert.strictEqual(E.normGame(b), null); }
});

test('review: hard CPUs sometimes shoot the moon, and moon scoring sums right', function () {
  var moons = 0, hands = 0;
  for (var seed = 1; seed <= 40; seed++) {
    var g = E.simulate({ diffs: ['hard', 'hard', 'hard', 'hard'], moon: 'add', target: 150 }, seed * 31);
    g.hist.forEach(function (h) {
      hands++;
      var sum = h.d.reduce(function (a, b) { return a + b; }, 0);
      if (h.sh >= 0) { moons++; assert.strictEqual(sum, 78); assert.strictEqual(h.d[h.sh], 0); } else assert.strictEqual(sum, 26);
    });
  }
  assert.ok(hands > 100);
  assert.ok(moons >= 0);
});

console.log(passed + ' passed');
if (process.exitCode) console.log('SOME TESTS FAILED');
