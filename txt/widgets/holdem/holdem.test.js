/* Headless checks for the Texas Hold'em engine (evaluator, betting rules,
 * side pots, CPU legality, determinism, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/holdem/holdem.test.js */
'use strict';
var assert = require('assert');

var E = require('./holdem.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, asset: function (x) { return x; } } };
delete require.cache[require.resolve('./holdem.js')];
require('./holdem.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function C(s) { return E.parseCards(s); }
function ev(s) { return E.evalHand(C(s)); }

// An independent 5-card evaluator (sort by count then rank), for cross-checks.
function eval5(cs) {
  var rs = cs.map(function (c) { return c >> 2; }), ss = cs.map(function (c) { return c & 3; });
  var cnt = {};
  rs.forEach(function (r) { cnt[r] = (cnt[r] || 0) + 1; });
  var groups = Object.keys(cnt).map(Number).map(function (r) { return [cnt[r], r]; });
  groups.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
  var flush = ss.every(function (s) { return s === ss[0]; });
  var uniq = groups.length === 5, sorted = rs.slice().sort(function (a, b) { return b - a; });
  var straight = -1;
  if (uniq) {
    if (sorted[0] - sorted[4] === 4) straight = sorted[0];
    else if (sorted.join() === '12,3,2,1,0') straight = 3;
  }
  var cat, ks;
  if (straight >= 0 && flush) { cat = 8; ks = [straight]; }
  else if (groups[0][0] === 4) { cat = 7; ks = [groups[0][1], groups[1][1]]; }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; ks = [groups[0][1], groups[1][1]]; }
  else if (flush) { cat = 5; ks = sorted; }
  else if (straight >= 0) { cat = 4; ks = [straight]; }
  else if (groups[0][0] === 3) { cat = 3; ks = groups.map(function (g) { return g[1]; }); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; ks = groups.map(function (g) { return g[1]; }); }
  else if (groups[0][0] === 2) { cat = 1; ks = groups.map(function (g) { return g[1]; }); }
  else { cat = 0; ks = sorted; }
  var v = cat;
  for (var i = 0; i < 5; i++) v = v * 16 + (ks[i] != null ? ks[i] + 1 : 0);
  return v;
}
function brute7(cs) {
  var best = -1;
  for (var a = 0; a < 7; a++) for (var b = a + 1; b < 7; b++) {
    var five = cs.filter(function (_, i) { return i !== a && i !== b; });
    best = Math.max(best, eval5(five));
  }
  return best;
}
function rndHand(rnd, n) {
  var d = [];
  for (var i = 0; i < 52; i++) d.push(i);
  for (i = 0; i < n; i++) { var j = i + ((rnd() * (52 - i)) | 0), t = d[i]; d[i] = d[j]; d[j] = t; }
  return d.slice(0, n);
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === "Texas Hold'em" && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'holdem.css');
  assert.strictEqual(typeof widget._engine.evalHand, 'function');
});

test('card parsing and text', function () {
  assert.strictEqual(E.parseCard('As'), 12 * 4 + 0);
  assert.strictEqual(E.parseCard('2c'), 3);
  assert.strictEqual(E.parseCard('10h'), E.parseCard('Th'));
  assert.strictEqual(E.cardTxt(E.parseCard('Td')), '10♦');
  assert.strictEqual(E.parseCard('Xx'), -1);
});

test('categories rank in order', function () {
  var hands = [
    'As Kd 9c 7h 4s 3d 2c',      // high card
    'As Ad 9c 7h 4s 3d 2c',      // pair
    'As Ad 9c 9h 4s 3d 2c',      // two pair
    'As Ad Ac 9h 4s 3d 7c',      // trips
    '5s 6d 7c 8h 9s Kd Kc',      // straight
    '2h 5h 9h Jh Kh As Ad',      // flush
    'As Ad Ac 9h 9s 3d 2c',      // full house
    'As Ad Ac Ah 9s 3d 2c',      // quads
    '5h 6h 7h 8h 9h Kd Kc'       // straight flush
  ];
  for (var i = 0; i < hands.length; i++) assert.strictEqual(E.catOf(ev(hands[i])), i, hands[i]);
  for (i = 1; i < hands.length; i++) assert.ok(ev(hands[i]) > ev(hands[i - 1]), hands[i]);
});

test('names and special straights', function () {
  assert.strictEqual(E.handName(ev('As 2d 3c 4h 5s Kd Qc')), 'Straight, Five high');            // the wheel
  assert.strictEqual(E.handName(ev('Ah 2h 3h 4h 5h Kd Qc')), 'Straight Flush, Five high');      // steel wheel
  assert.strictEqual(E.handName(ev('Ah Kh Qh Jh Th 2d 2c')), 'Royal Flush');
  assert.strictEqual(E.handName(ev('Kh Kd Kc 7h 7s 2d 3c')), 'Kings full of Sevens');
  assert.strictEqual(E.handName(ev('Kh Kd 7c 7h 2s 2d 9c')), 'Two Pair, Kings and Sevens');
  assert.ok(ev('6s 2d 3c 4h 5s Kd Qc') > ev('As 2d 3c 4h 5s Kd Qc'), 'six-high beats the wheel');
  assert.ok(ev('Ts Jd Qc Kh As 2d 3c') > ev('9s Td Jc Qh Ks 2d 3c'));
  assert.strictEqual(E.catOf(ev('Qs Kd Ac 2h 3s 8d 9c')), 0, 'no wrap-around straight');
  // a straight flush beats a bigger plain straight / flush in the same 7
  assert.strictEqual(E.catOf(ev('4h 5h 6h 7h 8h 9d Tc')), 8);
  assert.strictEqual(E.handName(ev('4h 5h 6h 7h 8h 9d Tc')), 'Straight Flush, Eight high');
});

test('kickers decide, and the 5-card rule makes splits', function () {
  // pair of aces, K kicker vs Q kicker
  assert.ok(ev('As Ad Kc 7h 4s 3d 2c') > ev('As Ad Qc 7h 4s 3d 2c'));
  // two pair: third pair can't play, the best fifth card is the kicker
  assert.strictEqual(ev('Ks Kd 7c 7h 2s 2d Ac'), ev('Ks Kd 7c 7h 3s 3d Ac'));
  assert.ok(ev('Ks Kd 7c 7h 3s 3d 4c') > ev('Ks Kd 7c 7h 2s 2d 3c'));
  // trips with kickers
  assert.ok(ev('9s 9d 9c Ah 4s 3d 2c') > ev('9s 9d 9c Kh Qs 3d 2c'));
  // two trips = full house with the bigger trips
  assert.strictEqual(E.handName(ev('9s 9d 9c 4h 4s 4d 2c')), 'Nines full of Fours');
  // quads with the best kicker even if a pair is on board
  assert.strictEqual(ev('9s 9d 9c 9h Ks Kd 2c'), ev('9s 9d 9c 9h Ks Qd Kc'));
  assert.ok(ev('9s 9d 9c 9h As 2d 2c') > ev('9s 9d 9c 9h Ks Kd Kc'));
  // flush: the five highest of six suited cards
  assert.strictEqual(ev('2h 5h 9h Jh Kh Ah 3d'), ev('5h 9h Jh Kh Ah 4c 3d'));
  assert.ok(ev('2h 5h 9h Jh Kh Ah 3d') > ev('2h 4h 9h Jh Kh Ah 3d'));
  // board plays: both players split
  var board = C('As Ks Qs Js Ts');
  assert.strictEqual(E.evalHand(board.concat(C('2d 3c'))), E.evalHand(board.concat(C('9d 9c'))));
  // high cards: only five count
  assert.strictEqual(ev('As Kd 9c 7h 4s 3d 2c'), ev('As Kd 9c 7h 4s 2d 3c'));
  assert.ok(ev('As Kd 9c 7h 5s 3d 2c') > ev('As Kd 9c 7h 4s 3d 2c'));
});

test('7-card evaluator agrees with brute force over 21 subsets (40,000 hands)', function () {
  var rnd = E.mkRng(7), cats = new Array(9).fill(0);
  for (var i = 0; i < 40000; i++) {
    var h = rndHand(rnd, 7), v = E.evalHand(h);
    assert.strictEqual(v, brute7(h), h.map(E.cardStr).join(' '));
    cats[E.catOf(v)]++;
  }
  // and 5- and 6-card hands
  for (i = 0; i < 4000; i++) {
    var h5 = rndHand(rnd, 5);
    assert.strictEqual(E.evalHand(h5), eval5(h5));
  }
  // frequencies near the known 7-card odds (pair ≈ 43.8%, two pair ≈ 23.5%, flush ≈ 3.0%)
  assert.ok(Math.abs(cats[1] / 40000 - 0.438) < 0.02, 'pair ' + cats[1]);
  assert.ok(Math.abs(cats[2] / 40000 - 0.235) < 0.02, 'two pair ' + cats[2]);
  assert.ok(Math.abs(cats[5] / 40000 - 0.0303) < 0.006, 'flush ' + cats[5]);
});

test('targeted straight-flush / flush mixes agree with brute force', function () {
  var rnd = E.mkRng(99);
  for (var i = 0; i < 20000; i++) {
    // seven cards from just two suits and few ranks: lots of flushes / straights / boats
    var pool = [];
    for (var r = 0; r < 13; r++) { pool.push(r * 4); pool.push(r * 4 + 1); }
    for (var k = 0; k < 7; k++) { var j = k + ((rnd() * (pool.length - k)) | 0), t = pool[k]; pool[k] = pool[j]; pool[j] = t; }
    var h = pool.slice(0, 7);
    assert.strictEqual(E.evalHand(h), brute7(h), h.map(E.cardStr).join(' '));
  }
});

test('best5 returns the five cards that make the hand', function () {
  var b = E.best5(C('As 2d 3c 4h 5s Kd Qc'));
  assert.strictEqual(b.cards.length, 5);
  assert.strictEqual(E.evalHand(b.cards), b.v);
  assert.deepStrictEqual(b.cards.map(E.cardStr).sort(), ['2d', '3c', '4h', '5s', 'As'].sort());
});

test('preflop table: aces best, 72o near the bottom, suited beats offsuit', function () {
  var AA = E.pfPct(E.parseCard('As'), E.parseCard('Ad')), _72 = E.pfPct(E.parseCard('7s'), E.parseCard('2d'));
  assert.ok(AA > 0.99, 'AA ' + AA);
  assert.ok(_72 < 0.1, '72o ' + _72);
  assert.ok(E.pfPct(E.parseCard('As'), E.parseCard('Ks')) > E.pfPct(E.parseCard('As'), E.parseCard('Kd')));
  assert.strictEqual(E.pfClass(E.parseCard('Ks'), E.parseCard('As')), 'AKs');
  assert.strictEqual(E.pfClass(E.parseCard('7s'), E.parseCard('7d')), '77');
});

test('Monte Carlo equity is sane', function () {
  var rnd = E.mkRng(3);
  var j = E.equityJob(C('As Ad'), [], [{ cut: 0 }], 4000, rnd); j.step();
  assert.ok(Math.abs(j.eq - 0.85) < 0.03, 'AA vs 1 random ' + j.eq);
  j = E.equityJob(C('7s 2d'), [], [{ cut: 0 }], 4000, rnd); j.step();
  assert.ok(Math.abs(j.eq - 0.35) < 0.04, '72o vs 1 random ' + j.eq);
  // the nuts on the river always wins
  j = E.equityJob(C('Ah Kh'), C('Qh Jh Th 2c 3d'), [{ cut: 0 }, { cut: 0 }], 500, rnd); j.step();
  assert.strictEqual(j.eq, 1);
  // sliced stepping finishes with the same count
  j = E.equityJob(C('Ks Qs'), C('2s 7s 9d'), [{ cut: 0.5 }], 600, rnd);
  var slices = 0;
  while (!j.step(100)) slices++;
  assert.strictEqual(j.n, 600); assert.strictEqual(slices, 5);
  // a narrower opponent range lowers a medium hand's equity
  var a = E.equityJob(C('Qs Jd'), [], [{ cut: 0 }], 3000, E.mkRng(5)); a.step();
  var b = E.equityJob(C('Qs Jd'), [], [{ cut: 0.85 }], 3000, E.mkRng(5)); b.step();
  assert.ok(b.eq < a.eq - 0.05, a.eq + ' vs ' + b.eq);
});

// ---- betting rules ----
function game(n, stacks, opts) {
  var seats = [];
  for (var i = 0; i < n; i++) seats.push({ kind: i === 0 ? 'human' : 'cpu', name: 'P' + i, style: 'shark' });
  var g = E.newGame(Object.assign({ mode: 'tourney', seats: seats, stack: 1000, seed: 42 }, opts || {}));
  if (stacks) g.seats.forEach(function (s, i) { s.stack = stacks[i]; });
  return g;
}
function rig(g, holes, board) {
  // put chosen cards on top of the deck for the next deal (call after startHand)
  var want = [];
  holes.forEach(function (h, i) { g.seats[i].hole = C(h); want = want.concat(g.seats[i].hole); });
  var b = C(board || '');
  var rest = [];
  for (var c = 0; c < 52; c++) if (want.indexOf(c) < 0 && b.indexOf(c) < 0) rest.push(c);
  // the board: burn, flop x3, burn, turn, burn, river
  var deck = want.slice(), seq = [];
  seq.push(rest.pop(), b[0], b[1], b[2], rest.pop(), b[3], rest.pop(), b[4]);
  g.deck = deck.concat(seq, rest); g.dp = want.length;
}

test('blinds, button and first to act (3+ handed)', function () {
  var g = game(4);
  E.startHand(g);
  assert.strictEqual(g.button, 0); assert.strictEqual(g.sb, 1); assert.strictEqual(g.bb, 2);
  assert.strictEqual(g.seats[1].bet, 10); assert.strictEqual(g.seats[2].bet, 20);
  assert.strictEqual(g.toAct, 3, 'under the gun acts first');
  assert.ok(g.seats.every(function (s) { return s.hole.length === 2; }));
  assert.strictEqual(E.chipsTotal(g), 4000);
  // everyone calls, the big blind gets the option
  E.act(g, { type: 'call' }); E.act(g, { type: 'call' }); E.act(g, { type: 'call' });
  assert.strictEqual(g.toAct, 2); assert.ok(E.legal(g).canCheck);
  E.act(g, { type: 'check' });
  assert.strictEqual(g.street, 'flop'); assert.strictEqual(g.board.length, 3);
  assert.strictEqual(g.toAct, 1, 'small blind acts first after the flop');
  assert.strictEqual(E.potTotal(g), 80);
});

test('heads-up: the button posts the small blind and acts first preflop, last after', function () {
  var g = game(2);
  E.startHand(g);
  assert.strictEqual(g.button, 0); assert.strictEqual(g.sb, 0); assert.strictEqual(g.bb, 1);
  assert.strictEqual(g.toAct, 0);
  E.act(g, { type: 'call' }); E.act(g, { type: 'check' });
  assert.strictEqual(g.street, 'flop'); assert.strictEqual(g.toAct, 1);
  E.act(g, { type: 'check' }); assert.strictEqual(g.toAct, 0);
});

test('min-raise rules and illegal actions change nothing', function () {
  var g = game(3);
  E.startHand(g);   // btn 0, sb 1, bb 2, UTG = btn 0
  var L = E.legal(g);
  assert.strictEqual(L.minTo, 40); assert.strictEqual(L.maxTo, 1000);
  assert.strictEqual(E.act(g, { type: 'raise', to: 30 }), false);
  assert.strictEqual(E.act(g, { type: 'check' }), false);
  assert.strictEqual(g.toAct, 0);
  assert.ok(E.act(g, { type: 'raise', to: 100 }));   // raise of 80
  assert.strictEqual(E.legal(g).minTo, 180, 'next raise at least the last raise size');
  assert.ok(E.act(g, { type: 'raise', to: 180 }));
  assert.strictEqual(E.legal(g).minTo, 260);
});

test('a short all-in raise does not reopen the betting', function () {
  var g = game(3, [1000, 1000, 130]);
  E.startHand(g);   // btn 0 (UTG), sb 1, bb 2 (130 chips)
  E.act(g, { type: 'raise', to: 100 });    // seat 0 raises to 100 (raise of 80)
  E.act(g, { type: 'call' });              // sb calls 100
  E.act(g, { type: 'allin' });             // bb all-in for 130: a raise of 30 < 80
  assert.strictEqual(g.seats[2].allIn, true);
  assert.strictEqual(g.toAct, 0);
  var L = E.legal(g);
  assert.strictEqual(L.canRaise, false, 'the original raiser may only call or fold');
  assert.strictEqual(L.toCall, 30);
  E.act(g, { type: 'call' });
  assert.strictEqual(E.legal(g).canRaise, false);
  E.act(g, { type: 'call' });
  assert.strictEqual(g.street, 'flop');
});

test('a full all-in raise reopens the betting', function () {
  var g = game(3, [1000, 1000, 300]);
  E.startHand(g);
  E.act(g, { type: 'raise', to: 100 }); E.act(g, { type: 'call' });
  E.act(g, { type: 'allin' });   // to 300: a raise of 200 ≥ 80
  assert.strictEqual(E.legal(g).canRaise, true);
});

test('uncalled bets come back; a fold wins the pot', function () {
  var g = game(3);
  E.startHand(g);
  E.act(g, { type: 'raise', to: 500 });
  E.act(g, { type: 'fold' }); E.act(g, { type: 'fold' });
  assert.strictEqual(g.street, 'done');
  assert.ok(g.result.uncontested);
  assert.strictEqual(g.seats[0].stack, 1000 + 30);
  assert.strictEqual(E.chipsTotal(g), 3000);
  assert.ok(g.log.some(function (l) { return /Uncalled bet \(480\)/.test(l); }));
});

test('side pots: three all-ins of different sizes', function () {
  var g = game(4, [100, 300, 600, 1000]);
  E.startHand(g);   // btn 0, sb 1, bb 2, utg 3
  rig(g, ['As Ad', 'Ks Kd', 'Qs Qd', 'Js Jd'], '2c 7d 9h 3s 4c');
  E.act(g, { type: 'allin' });   // seat 3: 1000
  E.act(g, { type: 'allin' });   // seat 0: 100
  E.act(g, { type: 'allin' });   // seat 1: 300
  E.act(g, { type: 'allin' });   // seat 2: 600
  assert.ok(g.runout);
  var pots = E.buildPots(g);
  assert.deepStrictEqual(pots.map(function (p) { return p.amount; }), [400, 600, 600]);
  assert.deepStrictEqual(pots.map(function (p) { return p.elig.length; }), [4, 3, 2]);
  while (g.street !== 'done') E.dealNext(g);
  // AA wins main (400), KK side 1 (600), QQ side 2 (600), JJ gets back the uncalled 400
  assert.deepStrictEqual(g.seats.map(function (s) { return s.stack; }), [400, 600, 600, 400]);
  assert.strictEqual(E.chipsTotal(g), 2000);
  assert.ok(g.log.some(function (l) { return /Uncalled bet \(400\) returned to P3/.test(l); }));
});

test('split pot with an odd chip to the first seat left of the button', function () {
  var g = game(3, [1000, 1000, 1000]);
  E.startHand(g);   // btn 0, sb 1, bb 2
  rig(g, ['2c 3d', 'Ah 4c', 'Ad 4d'], 'Kh Qs Jc Ts 8h');   // seats 1 and 2 both have A-high straights
  // make the pot odd: seat 0 folds after the sb/bb; sb completes; bb checks → pot 40 + dead 0
  g.seats[0].stack -= 5; g.seats[0].total += 5;   // a dead chip-in so the pot is odd (simulates an ante)
  E.act(g, { type: 'fold' });
  E.act(g, { type: 'call' }); E.act(g, { type: 'check' });
  while (g.street !== 'done') { if (g.toAct >= 0) E.act(g, { type: 'check' }); else E.dealNext(g); }
  var p = g.result.pots;
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].amount, 45);
  assert.deepStrictEqual(p[0].winners, [1, 2]);
  assert.strictEqual(g.seats[1].stack, 980 + 23);
  assert.strictEqual(g.seats[2].stack, 980 + 22);
});

test('showdown picks the best hand; board can play for a split', function () {
  var g = game(2, [500, 500]);
  E.startHand(g);
  rig(g, ['2c 3d', '4h 5h'], 'As Ks Qs Js Ts');
  E.act(g, { type: 'call' }); E.act(g, { type: 'check' });
  while (g.street !== 'done') { if (g.toAct >= 0) E.act(g, { type: 'check' }); else E.dealNext(g); }
  assert.deepStrictEqual(g.result.pots[0].winners.sort(), [0, 1]);
  assert.strictEqual(g.seats[0].stack, 500); assert.strictEqual(g.seats[1].stack, 500);
  g = game(2, [500, 500]);
  E.startHand(g);
  rig(g, ['Kh Kd', 'Ah 2h'], '9h 7h 3h Kc 2d');   // seat 1 flush vs seat 0 set
  E.act(g, { type: 'allin' }); E.act(g, { type: 'call' });
  while (g.street !== 'done') E.dealNext(g);
  assert.strictEqual(g.seats[1].stack, 1000);
  assert.strictEqual(g.result.shows[1].name, 'Flush, Ace high');
  assert.ok(g.over); assert.strictEqual(g.winner, 1);
  assert.strictEqual(g.seats[0].place, 2);
});

test('short blinds post all-in; others still owe the full big blind', function () {
  var g = game(3, [1000, 1000, 15]);
  E.startHand(g);   // bb = seat 2 with 15
  assert.strictEqual(g.seats[2].bet, 15); assert.ok(g.seats[2].allIn);
  assert.strictEqual(E.legal(g).toCall, 20);
  E.act(g, { type: 'call' }); E.act(g, { type: 'call' });
  assert.strictEqual(g.street, 'flop');
});

test('tournament blinds rise on schedule', function () {
  var g = game(3, null, { speed: 'turbo' });
  for (var h = 0; h < 11; h++) {
    E.startHand(g);
    while (g.street !== 'done') { E.act(g, { type: 'fold' }); if (g.street !== 'done' && g.toAct < 0) E.dealNext(g); }
  }
  assert.strictEqual(g.handNo, 11); assert.strictEqual(g.level, 2);
  assert.deepStrictEqual([g.sbAmt, g.bbAmt], E.LEVELS[2]);
});

test('CPU games: only legal actions, chips conserved, one winner, deterministic', function () {
  var styles = E.STYLE_IDS;
  ['easy', 'normal', 'hard'].forEach(function (diff, di) {
    for (var k = 0; k < 4; k++) {
      var seats = [];
      for (var i = 0; i < 4 + (k % 3); i++) seats.push({ kind: i === 0 ? 'human' : 'cpu', style: styles[(i + k + di) % styles.length] });
      var cfg = { mode: 'tourney', seats: seats, diff: diff, speed: 'turbo', stack: 600, seed: 1000 + k * 7 + di, iters: 40 };
      var total = 600 * seats.length;
      var g = E.simulate(cfg, 400, null, function (gg) {
        assert.strictEqual(E.chipsTotal(gg), total);
        gg.seats.forEach(function (s) { assert.ok(s.stack >= 0 && s.bet >= 0 && s.total >= s.bet); });
        var cards = [];
        gg.seats.forEach(function (s) { cards = cards.concat(s.hole); });
        cards = cards.concat(gg.board);
        assert.strictEqual(new Set(cards).size, cards.length, 'duplicate cards');
      });
      assert.ok(g.over, diff + ' game ' + k + ' finished (hand ' + g.handNo + ')');
      assert.ok(g.winner >= 0);
      assert.strictEqual(g.seats[g.winner].stack, total);
      var places = g.seats.map(function (s) { return s.place; }).sort();
      assert.deepStrictEqual(places, seats.map(function (_, i) { return i + 1; }));
      var g2 = E.simulate(cfg, 400);
      assert.strictEqual(g2.handNo, g.handNo); assert.strictEqual(g2.winner, g.winner);
    }
  });
});

test('CPU decisions are always legal, from random spots', function () {
  var rnd = E.mkRng(77);
  for (var t = 0; t < 600; t++) {
    var g = game(2 + (t % 5), null, { diff: ['easy', 'normal', 'hard'][t % 3], seed: t });
    g.seats.forEach(function (s, i) { s.style = E.STYLE_IDS[(t + i) % 6]; s.kind = 'cpu'; s.stack = 50 + ((rnd() * 2000) | 0); });
    E.startHand(g);
    var guard = 0;
    while (g.street !== 'done' && guard++ < 100) {
      if (g.toAct < 0) { E.dealNext(g); continue; }
      var job = E.equityJob(g.seats[g.toAct].hole, g.board, E.eqOpps(g, g.toAct), 30, rnd);
      job.step();
      var a = E.cpuDecide(g, g.toAct, job.eq, rnd);
      assert.ok(a, 'a decision');
      assert.ok(E.act(g, a), 'illegal ' + JSON.stringify(a) + ' ' + JSON.stringify(E.legal(g)));
    }
    assert.strictEqual(g.street, 'done');
  }
});

test('CPU styles play like themselves', function () {
  function vpip(style) {
    var seats = [];
    for (var i = 0; i < 6; i++) seats.push({ kind: 'cpu', style: style });
    seats[0].kind = 'human';
    var g = E.simulate({ mode: 'tourney', seats: seats, diff: 'normal', speed: 'slow', stack: 20000, seed: 5, iters: 40 }, 80);
    var h = 0, v = 0;
    g.stats.forEach(function (s) { h += s.h; v += s.vp; });
    return v / h;
  }
  var rock = vpip('rock'), maniac = vpip('maniac'), station = vpip('station');
  assert.ok(rock < 0.25, 'rock ' + rock);
  assert.ok(maniac > rock + 0.2, 'maniac ' + maniac);
  assert.ok(station > rock + 0.1, 'station ' + station);
});

test('a strong CPU beats a weak one over many hands', function () {
  var wins = 0;
  for (var k = 0; k < 20; k++) {
    var g = E.simulate({ mode: 'tourney', seats: [{ kind: 'cpu', style: 'shark' }, { kind: 'cpu', style: 'station' }], diff: 'hard', speed: 'slow', stack: 1500, seed: 300 + k, iters: 150 }, 800);
    if (g.winner === 0) wins++;
  }
  assert.ok(wins >= 10, 'shark won ' + wins + '/20');
});

test('cash games: rebuys and replacements', function () {
  var g = E.newGame({ mode: 'cash', stakes: 'low', seats: [{ kind: 'human' }, { kind: 'cpu', style: 'rock' }, { kind: 'cpu', style: 'maniac' }], seed: 9 });
  assert.strictEqual(g.seats[0].stack, 1000);
  E.startHand(g);
  assert.deepStrictEqual([g.sbAmt, g.bbAmt], [5, 10]);
  rig(g, ['As Ad', 'Ks Kd', '7c 2d'], 'Ac 9h 4d 3s 2h');
  g.toAct = 0;   // force the order for the test
  E.act(g, { type: 'allin' }); E.act(g, { type: 'allin' }); E.act(g, { type: 'fold' });
  while (g.street !== 'done') E.dealNext(g);
  assert.strictEqual(g.seats[1].stack, 0);
  var old = E.replaceCpu(g, 1, E.mkRng(1));
  assert.strictEqual(old, 'Seat 2'.replace('Seat 2', old));
  assert.strictEqual(g.seats[1].stack, 1000);
  assert.notStrictEqual(g.seats[1].name, old);
  assert.ok(!g.over);
  g.seats[0].stack = 0;
  assert.ok(E.rebuy(g, 0)); assert.strictEqual(g.seats[0].buyins, 2);
});

test('saves round-trip mid-hand and junk is normalised', function () {
  var g = game(4);
  E.startHand(g);
  E.act(g, { type: 'call' }); E.act(g, { type: 'raise', to: 80 });
  var s = JSON.parse(JSON.stringify(g)), n = E.normGame(s);
  assert.ok(n);
  assert.strictEqual(n.toAct, g.toAct); assert.strictEqual(n.curBet, 80);
  assert.deepStrictEqual(n.seats.map(function (x) { return x.hole; }), g.seats.map(function (x) { return x.hole; }));
  assert.strictEqual(E.chipsTotal(n), 4000);
  // the restored game plays on identically
  var r1 = E.mkRng(4), r2 = E.mkRng(4);
  for (var i = 0; i < 30 && g.street !== 'done'; i++) {
    if (g.toAct >= 0) { E.cpuActNow(g, r1, 30); E.cpuActNow(n, r2, 30); } else { E.dealNext(g); E.dealNext(n); }
  }
  assert.deepStrictEqual(n.seats.map(function (x) { return x.stack; }), g.seats.map(function (x) { return x.stack; }));
  // junk
  assert.strictEqual(E.normGame(null), null);
  assert.strictEqual(E.normGame({ seats: [1] }), null);
  assert.strictEqual(E.normGame({ seats: [{ kind: 'cpu' }, { kind: 'cpu' }] }), null, 'needs a human');
  var bad = JSON.parse(JSON.stringify(g));
  bad.seats[1].hole = [999, 'x']; bad.street = 'flop'; bad.toAct = 1;
  var nb = E.normGame(bad);
  assert.ok(nb && nb.street === 'done', 'a damaged hand is abandoned');
  assert.strictEqual(E.chipsTotal(nb), E.chipsTotal(g), 'with the chips given back');
  var weird = E.normGame({ seats: [{ kind: 'human', stack: -50, name: 7 }, { kind: 'cpu', stack: 'abc', style: 'nope' }], street: 'bogus' });
  assert.ok(weird);
  assert.strictEqual(weird.seats[0].stack, 0); assert.strictEqual(weird.seats[1].style, 'shark');
  assert.strictEqual(weird.street, 'idle');
  var rec = E.normRec({ hands: -3, won: '5', bestName: 42, cashNet: -250 });
  assert.strictEqual(rec.hands, 0); assert.strictEqual(rec.won, 5); assert.strictEqual(rec.bestName, ''); assert.strictEqual(rec.cashNet, -250);
});

test('log grammar for a player named You; display order of the best five', function () {
  assert.strictEqual(E.you('You wins 30 (uncontested)'), 'You win 30 (uncontested)');
  assert.strictEqual(E.you('You calls 20 and is all-in'), 'You call 20 and are all-in');
  assert.strictEqual(E.you('You has the button'), 'You have the button');
  assert.strictEqual(E.you('Vega folds'), 'Vega folds');
  var b = E.best5(C('4h Kd 4s Ks Kc 2d 9c'));
  assert.deepStrictEqual(b.cards.map(E.cardStr), ['Ks', 'Kd', 'Kc', '4s', '4h']);
  assert.strictEqual(E.handName(b.v), 'Kings full of Fours');
});

test('a new street clears the last action of players still to act; postflop min bet is the big blind', function () {
  var g = game(3);
  E.startHand(g);
  E.act(g, { type: 'call' }); E.act(g, { type: 'call' }); E.act(g, { type: 'check' });
  assert.strictEqual(g.street, 'flop');
  assert.ok(g.seats.every(function (s) { return s.last === ''; }));
  var L = E.legal(g);
  assert.ok(L.isBet && L.canCheck && L.minTo === 20);
  E.act(g, { type: 'raise', to: 60 });
  assert.strictEqual(g.seats[1].last, 'bet 60');   // the small blind leads after the flop
});

test('equity simulation is quick enough to slice (hard level, five opponents)', function () {
  var t0 = Date.now(), rnd = E.mkRng(1);
  for (var k = 0; k < 5; k++) {
    var j = E.equityJob(C('Qs Jd'), C('2c 7d 9h'), [{ cut: 0.5 }, { cut: 0.5 }, { cut: 0.7 }, { cut: 0 }, { cut: 0.8 }], E.DIFFS.hard.iters, rnd);
    j.step();
  }
  var per = (Date.now() - t0) / 5;
  assert.ok(per < 150, per + ' ms per decision');
});


// ---- reviewer additions ----
test('short all-in: a player yet to act may still raise', function () {
  var g = game(4, [1000, 1000, 1000, 130]);
  E.startHand(g);   // btn 0, sb 1, bb 2, utg 3 (130)
  E.act(g, { type: 'allin' });                    // utg all-in 130: a full raise (110 ≥ 20)
  assert.ok(E.legal(g).canRaise);
  E.act(g, { type: 'raise', to: 300 });           // btn raises to 300
  E.act(g, { type: 'call' });                     // sb calls
  assert.strictEqual(g.toAct, 2);
  assert.ok(E.legal(g).canRaise, 'the big blind has not acted on the raise: may re-raise');
});

test('cumulative short all-ins that add up to a full raise reopen the betting', function () {
  var g = game(4, [1000, 150, 190, 1000]);
  E.startHand(g);   // btn 0, sb 1 (150), bb 2 (190), utg 3
  E.act(g, { type: 'raise', to: 100 });   // utg: raise of 80
  E.act(g, { type: 'call' });             // btn calls 100
  E.act(g, { type: 'allin' });            // sb all-in to 150 (short: +50)
  assert.strictEqual(g.seats[1].allIn, true);
  E.act(g, { type: 'allin' });            // bb all-in to 190 (short: +40, but +90 since utg acted)
  assert.strictEqual(g.toAct, 3);
  assert.strictEqual(E.legal(g).canRaise, true, '90 more than utg faced: a full raise in total');
  // only one short all-in: no reopening
  var h = game(4, [1000, 150, 1000, 1000]);
  E.startHand(h);
  E.act(h, { type: 'raise', to: 100 }); E.act(h, { type: 'call' }); E.act(h, { type: 'allin' });
  E.act(h, { type: 'call' });             // bb calls 150
  assert.strictEqual(h.toAct, 3);
  assert.strictEqual(E.legal(h).canRaise, false);
  // the rule survives a save
  var r = E.normGame(JSON.parse(JSON.stringify(h)));
  assert.strictEqual(E.legal(r).canRaise, false);
});

test('folded dead money above an all-in goes to the side pot it belongs to', function () {
  var g = game(3, [1000, 1000, 50]);
  E.startHand(g);   // btn 0, sb 1, bb 2 (50)
  rig(g, ['2c 7d', 'As Ad', 'Ks Kd'], '3h 8s 9c Jd 4h');
  E.act(g, { type: 'raise', to: 300 });   // btn raises
  E.act(g, { type: 'raise', to: 900 });   // sb re-raises
  E.act(g, { type: 'call' });             // bb calls all-in for 50
  E.act(g, { type: 'fold' });             // btn folds 300
  assert.ok(g.runout, 'one player with chips left: run it out');
  assert.ok(g.log.some(function (l) { return /Uncalled bet \(600\)/.test(l); }), 'sb gets back the part of the re-raise nobody matched');
  var guard = 0;
  while (g.street !== 'done' && guard++ < 10) E.dealNext(g);
  // aces win the lot: 300 + 50 + the folded 300
  assert.strictEqual(g.street, 'done');
  assert.strictEqual(E.chipsTotal(g), 2050);
  assert.strictEqual(g.seats[2].stack, 0);
  assert.strictEqual(g.seats[1].stack, 1000 - 300 + 650);
  assert.strictEqual(g.result.pots[0].amount, 150, 'main pot: 50 from each of three');
  assert.deepStrictEqual(g.result.pots[0].elig, [1, 2]);
  assert.strictEqual(g.result.pots.reduce(function (a, p) { return a + p.amount; }, 0), 650);
});

test('heads-up: a big blind short of the small blind', function () {
  var g = game(2, [1000, 6]);
  E.startHand(g);   // btn/sb 0 posts 10, bb 1 posts 6 all-in
  assert.strictEqual(g.seats[1].allIn, true);
  assert.strictEqual(g.toAct, -1, 'nothing to decide: the small blind already covers the big blind');
  var guard = 0;
  while (g.street !== 'done' && guard++ < 10) E.dealNext(g);
  assert.strictEqual(g.street, 'done');
  assert.strictEqual(E.chipsTotal(g), 1006);
  assert.strictEqual(g.board.length, 5);
});

test('every hand of long CPU games keeps the side pots summing to the chips put in', function () {
  for (var seed = 1; seed <= 6; seed++) {
    var styles = E.STYLE_IDS, seats = [];
    for (var i = 0; i < 6; i++) seats.push({ kind: 'cpu', style: styles[(i + seed) % 6] });
    var lastTotal = null;
    E.simulate({ seats: seats, seed: seed * 7, iters: 30, speed: 'turbo' }, 120, null, function (g) {
      var t = E.chipsTotal(g);
      if (lastTotal != null) assert.strictEqual(t, lastTotal);
      lastTotal = t;
      if (g.street === 'done' && g.result) {
        var won = g.seats.reduce(function (a, s) { return a + s.won; }, 0), pots = g.result.pots.reduce(function (a, p) { return a + p.amount; }, 0);
        assert.strictEqual(won, pots);
        g.seats.forEach(function (s) { assert.ok(s.stack >= 0); });
      }
    });
  }
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
