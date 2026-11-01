/* Headless checks for the Blackjack engine (shoe, rules, payouts, strategy, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/blackjack/blackjack.test.js */
'use strict';
var assert = require('assert');

var E = require('./blackjack.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./blackjack.js')];
require('./blackjack.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// card helpers: rank 'A','2'..'10','J','Q','K', suit 0..3
function C(r, s) { return (s || 0) * 13 + E.RANKS.indexOf(String(r)); }
function cards(list) { return list.map(function (r) { return C(r); }); }
// a table whose shoe deals exactly these cards (in this order) from the top
function rigged(order, rules) {
  var t = E.newTable(rules || {}, 7);
  var rest = t.shoe.cards.slice(order.length);
  t.shoe.cards = order.map(function (r) { return typeof r === 'number' ? r : C(r); }).concat(rest);
  t.shoe.pos = 0;
  return t;
}
// deal order for 1 seat: p1, d-up, p2, d-hole, then hits…
function one(t, bet, bank) { return E.startRound(t, [{ w: 'solo', bet: bet || 10, kind: 'human' }], { solo: bank == null ? 1000 : bank }); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Blackjack' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'blackjack.css');
  assert.strictEqual(widget._engine.MAX_HANDS, 4);
});
test('hand values: soft and hard totals, naturals', function () {
  assert.deepStrictEqual(E.handValue(cards(['A', '6'])), { total: 17, soft: true });
  assert.deepStrictEqual(E.handValue(cards(['A', '6', '10'])), { total: 17, soft: false });
  assert.deepStrictEqual(E.handValue(cards(['A', 'A', '9'])), { total: 21, soft: true });
  assert.deepStrictEqual(E.handValue(cards(['K', 'Q', '5'])), { total: 25, soft: false });
  assert.ok(E.isNatural(cards(['A', 'K'])) && !E.isNatural(cards(['7', '7', '7'])));
  assert.strictEqual(E.hiLo(C('5')), 1); assert.strictEqual(E.hiLo(C('8')), 0); assert.strictEqual(E.hiLo(C('Q')), -1); assert.strictEqual(E.hiLo(C('A')), -1);
});
test('shoe: right composition for every deck count, deterministic shuffle', function () {
  E.DECKS.forEach(function (d) {
    var s = E.newShoe(d, 42), n = {};
    assert.strictEqual(s.cards.length, d * 52);
    s.cards.forEach(function (c) { n[c] = (n[c] || 0) + 1; });
    for (var c = 0; c < 52; c++) assert.strictEqual(n[c], d);
    assert.ok(s.cut > s.cards.length * 0.6 && s.cut < s.cards.length);
  });
  assert.deepStrictEqual(E.newShoe(6, 9).cards, E.newShoe(6, 9).cards);
  assert.notDeepStrictEqual(E.newShoe(6, 9).cards, E.newShoe(6, 10).cards);
});
test('a full shoe of Hi-Lo counts sums to zero; reshuffle at the cut card', function () {
  var t = E.newTable({ decks: 2 }, 5), sum = 0;
  t.shoe.cards.forEach(function (c) { sum += E.hiLo(c); });
  assert.strictEqual(sum, 0);
  t.shoe.pos = t.shoe.cut;
  assert.ok(E.needShuffle(t));
  one(t, 10);
  assert.strictEqual(t.shuffles, 1);
  assert.ok(t.shoe.pos < 10 && t.ev.indexOf('shuffle') >= 0);
});
test('stand and win; dealer draws to 17 and stands on soft 17 (S17)', function () {
  var t = rigged(['10', 'A', '9', '6', '2'], { h17: false });   // you 19, dealer A6 soft 17
  var rd = one(t, 10);
  assert.strictEqual(rd.phase, 'insurance');                       // ace up: insurance first
  assert.ok(E.act(t, 'decline'));
  assert.strictEqual(rd.phase, 'play');
  assert.ok(E.act(t, 'stand'));
  assert.strictEqual(rd.phase, 'done');
  assert.strictEqual(rd.dealer.cards.length, 2, 'S17: stands on soft 17');
  assert.strictEqual(rd.seats[0].hands[0].res, 'win');
  assert.strictEqual(rd.wallets.solo, 1010);
});
test('H17: dealer hits soft 17', function () {
  var t = rigged(['10', 'A', '9', '6', '2'], { h17: true });
  var rd = one(t, 10);
  E.act(t, 'decline'); E.act(t, 'stand');
  assert.strictEqual(rd.dealer.cards.length, 3);
  assert.strictEqual(E.handValue(rd.dealer.cards).total, 19);
  assert.strictEqual(rd.seats[0].hands[0].res, 'push');
  assert.strictEqual(rd.wallets.solo, 1000);
});
test('blackjack pays 3:2 and ends the hand at once', function () {
  var t = rigged(['A', '9', 'K', '7', '5']);
  var rd = one(t, 10);
  assert.strictEqual(rd.phase, 'done');
  assert.strictEqual(rd.seats[0].hands[0].res, 'bj');
  assert.strictEqual(rd.wallets.solo, 1015);
  assert.strictEqual(rd.dealer.cards.length, 2, 'dealer does not draw against a lone blackjack');
});
test('dealer blackjack: peek ends the round; insurance pays 2:1; a player blackjack pushes', function () {
  var t = rigged(['9', 'A', '8', 'K']);
  var rd = one(t, 20);
  assert.strictEqual(rd.phase, 'insurance');
  assert.ok(E.legal(t).insure);
  E.act(t, 'insure');
  assert.strictEqual(rd.seats[0].ins, 10);
  assert.strictEqual(rd.seats[0].insRet, 30);
  assert.strictEqual(rd.phase, 'done');
  assert.ok(rd.dealerBJ && rd.dealer.up);
  assert.strictEqual(rd.seats[0].hands[0].res, 'lose');
  assert.strictEqual(rd.wallets.solo, 1000, 'insurance covers the lost bet');
  assert.strictEqual(rd.seats[0].net, 0);
  var t2 = rigged(['A', '10', 'K', 'A']);    // you BJ vs dealer 10 up, ace hole
  var r2 = one(t2, 10);
  assert.strictEqual(r2.phase, 'done');
  assert.strictEqual(r2.seats[0].hands[0].res, 'push');
  assert.strictEqual(r2.wallets.solo, 1000);
});
test('insurance lost when the dealer has no blackjack', function () {
  var t = rigged(['10', 'A', '9', '6', '3']);
  var rd = one(t, 20);
  E.act(t, 'insure');
  assert.strictEqual(rd.phase, 'play');
  E.act(t, 'stand');   // dealer A6 = 17 stands
  assert.strictEqual(rd.seats[0].hands[0].res, 'win');
  assert.strictEqual(rd.wallets.solo, 1010);      // -10 insurance +20 win
});
test('double: one card, twice the bet; bust on a hit', function () {
  var t = rigged(['6', '9', '5', '7', '10', '10']);   // you 11 vs 9 → double gets 10 = 21; dealer 16 draws 10 bust
  var rd = one(t, 10);
  assert.ok(E.legal(t).double);
  E.act(t, 'double');
  var hd = rd.seats[0].hands[0];
  assert.ok(hd.dbl && hd.bet === 20 && hd.cards.length === 3);
  assert.strictEqual(hd.res, 'win');
  assert.strictEqual(rd.wallets.solo, 1020);
  var t2 = rigged(['10', '9', '6', '8', 'K']);
  var r2 = one(t2, 10);
  E.act(t2, 'hit');
  assert.strictEqual(r2.seats[0].hands[0].res, 'bust');
  assert.strictEqual(r2.phase, 'done');
  assert.strictEqual(r2.wallets.solo, 990);
  assert.strictEqual(r2.dealer.cards.length, 2, 'no draw when every hand is bust');
  assert.ok(r2.dealer.up, 'hole card still shown');
});
test('split, re-split up to four hands, double after split', function () {
  // you 8 8 vs dealer 6; split → 8,8 (re-split) → 8,8 (re-split) → 8,8 → four hands, then 3s and doubles
  var t = rigged(['8', '6', '8', '10', '8', '8', '3', '10', '3', '10', '3', '10', '3', '10', '10']);
  var rd = one(t, 10);
  E.act(t, 'split');
  var seat = rd.seats[0];
  assert.strictEqual(seat.hands.length, 2);
  assert.ok(E.legal(t).split);
  E.act(t, 'split');
  E.act(t, 'split');
  assert.strictEqual(seat.hands.length, 4);
  assert.ok(!E.legal(t).split, 'four hands is the limit');
  assert.ok(E.legal(t).double, 'double after split');
  assert.ok(!E.legal(t).surrender, 'no surrender after a split');
  // each hand 8+3 = 11: double each
  for (var i = 0; i < 4; i++) { assert.strictEqual(rd.phase, 'play'); assert.ok(E.act(t, 'double'), 'double ' + i); }
  assert.strictEqual(rd.phase, 'done');
  seat.hands.forEach(function (h) { assert.strictEqual(E.handValue(h.cards).total, 21); assert.ok(h.fromSplit); });
  assert.strictEqual(seat.hands[0].res, 'win');
  assert.strictEqual(rd.wallets.solo, 1000 + 80);
});
test('split aces get one card each and 21 is not blackjack', function () {
  var t = rigged(['A', '9', 'A', '7', 'K', 'Q', '10']);
  var rd = one(t, 10);
  E.act(t, 'split');
  assert.strictEqual(rd.phase, 'done', 'both split aces finished automatically');
  var hs = rd.seats[0].hands;
  assert.ok(hs[0].splitAces && hs[1].splitAces && hs[0].cards.length === 2 && hs[1].cards.length === 2);
  assert.strictEqual(hs[0].res, 'win');
  assert.strictEqual(hs[0].net, 10, 'paid 1:1, not 3:2');
  assert.strictEqual(rd.wallets.solo, 1020);
});
test('late surrender returns half; not allowed when the rule is off', function () {
  var t = rigged(['10', '10', '6', '8']);
  var rd = one(t, 10);
  assert.ok(E.legal(t).surrender);
  E.act(t, 'surrender');
  assert.strictEqual(rd.seats[0].hands[0].res, 'surrender');
  assert.strictEqual(rd.wallets.solo, 995);
  var t2 = rigged(['10', '10', '6', '8'], { surr: false });
  one(t2, 10);
  assert.ok(!E.legal(t2).surrender && !E.act(t2, 'surrender'));
});
test('bets: limits and bank checked; illegal moves refused', function () {
  var t = E.newTable({}, 3);
  assert.strictEqual(E.startRound(t, [{ w: 'solo', bet: 2, kind: 'human' }], { solo: 1000 }), null);
  assert.strictEqual(E.startRound(t, [{ w: 'solo', bet: 5000, kind: 'human' }], { solo: 9000 }), null);
  assert.strictEqual(E.startRound(t, [{ w: 'solo', bet: 600, kind: 'human' }, { w: 'solo', bet: 600, kind: 'human' }], { solo: 1000 }), null);
  var t2 = rigged(['10', '9', '7', '8']);
  var rd = one(t2, 100, 100);   // all-in: no chips left to double or split
  assert.strictEqual(rd.wallets.solo, 0);
  var L = E.legal(t2);
  assert.ok(!L.double && !L.split && L.hit && L.stand);
  assert.ok(!E.act(t2, 'double') && !E.act(t2, 'insure'));
});
test('multi-seat round: play order, separate wallets, the count follows visible cards', function () {
  var t = E.newTable({ decks: 6 }, 11);
  var rd = E.startRound(t, [{ w: 'p1', bet: 25, kind: 'human' }, { w: 'p2', bet: 50, kind: 'human' }, { w: 'cpu1', bet: 10, kind: 'cpu' }], { p1: 100, p2: 100, cpu1: 50 });
  assert.ok(rd);
  assert.strictEqual(rd.wallets.p1, 75); assert.strictEqual(rd.wallets.p2, 50); assert.strictEqual(rd.wallets.cpu1, 40);
  var guard = 0;
  while (rd.phase !== 'done' && guard++ < 50) assert.ok(E.act(t, E.cpuMove(t, 'book')));
  assert.strictEqual(rd.phase, 'done');
  var rc = 0;
  rd.seats.forEach(function (s) { s.hands.forEach(function (h) { h.cards.forEach(function (c) { rc += E.hiLo(c); }); }); });
  rd.dealer.cards.forEach(function (c) { rc += E.hiLo(c); });
  assert.strictEqual(t.rc, rc);
});
test('hole card is not counted until it is turned over', function () {
  var t = rigged(['10', '9', '9', '2', '8']);
  one(t, 10);
  assert.strictEqual(t.rc, -1 + 0 + 0, 'hole 2 not counted yet');
  E.act(t, 'stand');
  assert.strictEqual(t.rc, -1 + 1 + 0);    // 10, 9, 9, 2, 8 → -1 0 0 +1 0
});
test('basic strategy: classic chart cells', function () {
  var S = function (h, up, r) { return E.strategy(cards(h), C(up), r || {}); };
  assert.strictEqual(S(['10', '6'], '10'), 'R');
  assert.strictEqual(S(['10', '6'], '10', {}), 'R');
  assert.strictEqual(E.strategy(cards(['10', '6']), C('10'), {}, { double: true, split: true, surrender: false }), 'H');
  assert.strictEqual(S(['10', '6'], '6'), 'S');
  assert.strictEqual(S(['10', '2'], '3'), 'H');
  assert.strictEqual(S(['10', '2'], '4'), 'S');
  assert.strictEqual(S(['6', '5'], 'A'), 'H');
  assert.strictEqual(S(['6', '5'], 'A', { h17: true }), 'D');
  assert.strictEqual(S(['5', '4'], '3'), 'D');
  assert.strictEqual(S(['5', '4'], '2'), 'H');
  assert.strictEqual(S(['A', '7'], '9'), 'H');
  assert.strictEqual(S(['A', '7'], '7'), 'S');
  assert.strictEqual(S(['A', '7'], '4'), 'D');
  assert.strictEqual(E.strategy(cards(['A', '7']), C('4'), {}, { double: false, split: true, surrender: true }), 'S');
  assert.strictEqual(S(['A', 'A'], '10'), 'P');
  assert.strictEqual(S(['8', '8'], '10'), 'P');
  assert.strictEqual(S(['8', '8'], 'A', { h17: true }), 'R');
  assert.strictEqual(S(['9', '9'], '7'), 'S');
  assert.strictEqual(S(['9', '9'], '8'), 'P');
  assert.strictEqual(S(['5', '5'], '6'), 'D');
  assert.strictEqual(S(['10', '10'], '6'), 'S');
  assert.strictEqual(S(['4', '4'], '5'), 'P');
  assert.strictEqual(S(['4', '4'], '4'), 'H');
  assert.strictEqual(S(['10', '5', '2'], '10'), 'S');
  assert.strictEqual(S(['10', '4', '2'], '10'), 'H', 'no surrender on 3 cards: hit 16');
});
test('describe and coach advice follow the legal moves', function () {
  assert.strictEqual(E.describe(cards(['8', '8']), C('A')), 'pair of 8s vs A');
  assert.strictEqual(E.describe(cards(['A', '6']), C('10')), 'soft 17 vs 10');
  var t = rigged(['8', '6', '8', '10']);
  one(t, 10);
  assert.strictEqual(E.advice(t), 'split');
  var t2 = rigged(['8', '6', '8', '10']);
  one(t2, 10, 10);
  assert.strictEqual(E.advice(t2), 'stand', 'cannot afford the split: hard 16 vs 6 stands');
  assert.ok(E.insuranceAdvice(3) && !E.insuranceAdvice(1));
});
test('basic strategy over many hands keeps the house edge small (sanity)', function () {
  var t = E.newTable({ decks: 6 }, 2024), wagered = 0, net = 0;
  for (var n = 0; n < 60000; n++) {
    var rd = E.startRound(t, [{ w: 'a', bet: 10, kind: 'human' }], { a: 1e9 });
    var g = 0;
    while (rd.phase !== 'done' && g++ < 40) {
      var mv = rd.phase === 'insurance' ? 'decline' : E.advice(t);
      assert.ok(E.act(t, mv), 'legal advice ' + mv);
    }
    rd.seats[0].hands.forEach(function (h) { wagered += h.bet; });
    net += rd.seats[0].net;
  }
  var edge = net / (60000 * 10);
  assert.ok(edge > -0.025 && edge < 0.015, 'player edge per initial bet ' + edge);
  assert.ok(wagered > 60000 * 10);
});
test('the "hunch" table-mate never busts by hitting a hard 12+', function () {
  var t = E.newTable({}, 99), hits = 0;
  for (var n = 0; n < 2000; n++) {
    var rd = E.startRound(t, [{ w: 'k', bet: 10, kind: 'cpu' }], { k: 1e9 });
    while (rd.phase !== 'done') {
      if (rd.phase === 'play') {
        var v = E.handValue(E.curHand(t).cards), mv = E.cpuMove(t, 'hunch');
        if (mv === 'hit') { hits++; assert.ok(v.soft || v.total < 12); }
        assert.ok(E.act(t, mv));
      } else E.act(t, 'decline');
    }
  }
  assert.ok(hits > 100);
});
test('same seed, same moves → identical rounds (determinism)', function () {
  function play(seed) {
    var t = E.newTable({ decks: 2 }, seed), log = [];
    for (var n = 0; n < 200; n++) {
      var rd = E.startRound(t, [{ w: 'a', bet: 10, kind: 'human' }, { w: 'b', bet: 25, kind: 'human' }], { a: 1e6, b: 1e6 });
      while (rd.phase !== 'done') E.act(t, rd.phase === 'insurance' ? 'decline' : E.advice(t));
      log.push(rd.seats.map(function (s) { return s.net; }).join(',') + '|' + rd.dealer.cards.map(function (c) { return c.c; }).join(','));
    }
    return log.join(';') + '#' + t.rc + '#' + t.shuffles;
  }
  assert.strictEqual(play(77), play(77));
  assert.notStrictEqual(play(77), play(78));
});
test('tally: stats, banks and streaks from a finished round', function () {
  var sv = E.newSave();
  var t = rigged(['A', '9', 'K', '7', '5']);
  E.startRound(t, [{ w: 'solo', bet: 10, kind: 'human' }], { solo: sv.banks.solo });
  var nets = E.tally(sv, t);
  assert.strictEqual(nets.solo, 15);
  assert.strictEqual(sv.banks.solo, 1015);
  assert.ok(sv.stats.bjs === 1 && sv.stats.wins === 1 && sv.stats.rounds === 1 && sv.stats.streak === 1 && sv.stats.peak === 1015);
  assert.deepStrictEqual(E.tally(sv, t), {}, 'tallied once');
  var t2 = rigged(['10', '9', '6', '8', 'K']);
  E.startRound(t2, [{ w: 'p2', bet: 10, kind: 'human' }, { w: 'cpu1', bet: 10, kind: 'cpu' }], { p2: 50, cpu1: 50 });
  while (t2.round.phase !== 'done') E.act(t2, 'stand');
  E.tally(sv, t2);
  assert.strictEqual(sv.mstats.p2.hands, 1);
  assert.strictEqual(sv.stats.rounds, 1, 'pass-and-play rounds do not touch solo stats');
  assert.strictEqual(sv.banks.cpu1, undefined);
});
test('save normalisation: round trip, junk, a saved hand in progress', function () {
  var s = E.newSave();
  s.banks.solo = 512.5; s.opts.count = 'quiz'; s.rules.decks = 2;
  var t = E.newTable(s.rules, 4);
  E.startRound(t, [{ w: 'solo', bet: 25, kind: 'human' }], { solo: 512.5 });
  s.table = t; t.ev = [];
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(n.banks.solo, 512.5);
  assert.strictEqual(n.opts.count, 'quiz');
  assert.strictEqual(n.rules.decks, 2);
  assert.ok(n.table && n.table.round && n.table.round.seats[0].hands[0].bet === 25);
  assert.deepStrictEqual(n.table.shoe.cards, t.shoe.cards);
  var bad = E.normSave({ banks: { solo: -4, p1: 'x' }, rules: { decks: 3 }, opts: { spots: 3, mates: 2, coach: 'yes' }, stats: { wins: -3, net: -40.5 }, table: { shoe: { cards: [1, 2] } } });
  assert.strictEqual(bad.banks.solo, 1000); assert.strictEqual(bad.banks.p1, 1000);
  assert.strictEqual(bad.rules.decks, 6);
  assert.strictEqual(bad.opts.mates, 0, 'spots + mates never exceed 3 seats');
  assert.strictEqual(bad.opts.coach, 'flag');
  assert.strictEqual(bad.stats.wins, 0); assert.strictEqual(bad.stats.net, -40.5);
  assert.strictEqual(bad.table, null);
  assert.strictEqual(E.normSave(null).banks.solo, 1000);
  assert.strictEqual(E.normSave('junk').opts.mode, 'solo');
  // a corrupt round is dropped but the shoe kept
  var j = JSON.parse(JSON.stringify(s));
  j.table.round.seats[0].hands[0].cards = [{ c: 99, id: 1 }];
  var n2 = E.normSave(j);
  assert.ok(n2.table && n2.table.round === null);
  // a saved shoe from a different deck count is not reused
  var k = JSON.parse(JSON.stringify(s)); k.rules.decks = 8;
  assert.strictEqual(E.normSave(k).table, null);
});
test('a one-deck shoe never runs dry mid-round', function () {
  var t = E.newTable({ decks: 1 }, 1234);
  for (var n = 0; n < 400; n++) {
    var rd = E.startRound(t, [{ w: 'a', bet: 10, kind: 'human' }, { w: 'a', bet: 10, kind: 'human' }, { w: 'a', bet: 10, kind: 'human' }], { a: 1e9 });
    while (rd.phase !== 'done') E.act(t, rd.phase === 'insurance' ? 'decline' : E.advice(t));
    assert.ok(t.shoe.pos <= t.shoe.cards.length);
  }
  assert.ok(t.shuffles > 20);
});

// ---- reviewer additions: edge cases ----
test('dealer does not draw when every hand is busted or surrendered', function () {
  var t = rigged(['10', '6', '6', '10', 'K', '5']);   // you 16 vs 6, hit K = bust; dealer 16 must not draw
  var rd = one(t, 10);
  E.act(t, 'hit');
  assert.strictEqual(rd.phase, 'done');
  assert.strictEqual(rd.dealer.cards.length, 2);
  assert.ok(rd.dealer.up, 'hole card still shown');
  assert.strictEqual(rd.seats[0].hands[0].res, 'bust');
  var t2 = rigged(['10', '10', '6', '6', '5']);
  var r2 = one(t2, 10);
  assert.ok(E.act(t2, 'surrender'));
  assert.strictEqual(r2.dealer.cards.length, 2);
  assert.strictEqual(r2.wallets.solo, 995);
});
test('even money: a natural that insures against an ace nets +1x either way', function () {
  var t = rigged(['A', 'A', 'K', 'K']);      // you BJ, dealer BJ
  var rd = one(t, 20);
  assert.strictEqual(rd.phase, 'insurance');
  E.act(t, 'insure');
  assert.strictEqual(rd.seats[0].net, 20);
  assert.strictEqual(rd.wallets.solo, 1020);
  var t2 = rigged(['A', 'A', 'K', '7']);     // you BJ, dealer soft 18
  var r2 = one(t2, 20);
  E.act(t2, 'insure');
  assert.strictEqual(r2.phase, 'done', 'the lone natural is settled after the peek');
  assert.strictEqual(r2.seats[0].net, 20);   // +30 blackjack - 10 insurance
  assert.strictEqual(r2.wallets.solo, 1020);
});
test('split: ten-value cards split; no split or double without the chips; four hands max', function () {
  var t = rigged(['K', '7', '10', '9']);
  one(t, 10);
  assert.ok(E.legal(t).split, 'K and 10 are a pair by value');
  var t2 = rigged(['8', '7', '8', '9']);
  one(t2, 10, 15);                           // bank 15: 10 bet leaves 5
  var L = E.legal(t2);
  assert.ok(!L.split && !L.double && L.hit && L.surrender);
  assert.strictEqual(E.act(t2, 'split'), false);
  assert.strictEqual(E.advice(t2) !== 'split' && E.advice(t2) !== 'double', true, 'coach only suggests legal moves');
  var t3 = rigged(['8', '7', '8', '9', '8', '8', '8', '8', '8', '8']);
  var r3 = one(t3, 10);
  var n = 0;
  while (E.legal(t3).split && n++ < 10) E.act(t3, 'split');
  assert.strictEqual(r3.seats[0].hands.length, 4);
  assert.ok(!E.legal(t3).split);
  assert.ok(!E.legal(t3).surrender, 'no surrender after a split');
});
test('fuzz: computer styles and the coach only ever choose legal moves; money is conserved', function () {
  ['book', 'hunch'].forEach(function (style) {
    for (var seed = 1; seed <= 150; seed++) {
      var t = E.newTable({ decks: E.DECKS[seed % 4], h17: !!(seed & 1), surr: !!(seed & 2) }, seed);
      var banks = { a: 40, b: 1000 };
      for (var r = 0; r < 25; r++) {
        var spots = [{ w: 'b', bet: 25, kind: 'cpu' }];
        if (banks.a >= 5) spots.push({ w: 'a', bet: Math.min(25, Math.floor(banks.a / 5) * 5), kind: 'cpu' });
        var rd = E.startRound(t, spots, banks), g = 0;
        assert.ok(rd);
        var before = banks.a + banks.b;
        while (rd.phase !== 'done') {
          assert.ok(g++ < 60, 'round finishes');
          var mv = E.cpuMove(t, style);
          assert.ok(E.legal(t)[mv], style + ' chose an illegal ' + mv);
          assert.ok(E.act(t, mv));
        }
        var paid = 0;
        rd.seats.forEach(function (st) { paid += st.net; });
        banks = { a: rd.wallets.a != null ? rd.wallets.a : banks.a, b: rd.wallets.b };
        assert.ok(Math.abs(banks.a + banks.b - before - paid) < 1e-6, 'wallets move by exactly the net result');
        assert.ok(banks.a >= 0 && banks.b >= 0);
        if (banks.b < 100) banks.b = 1000;
      }
    }
  });
});
test('a saved hand mid-insurance and mid-play resumes; a finished current hand is rejected', function () {
  var t = rigged(['10', 'A', '9', '6', '3']);
  one(t, 20);
  var s = E.newSave(); s.table = t;
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(n.table.round.phase, 'insurance');
  assert.ok(E.act(n.table, 'decline'));
  assert.strictEqual(n.table.round.phase, 'play');
  var j = JSON.parse(JSON.stringify({ rules: s.rules, table: n.table }));
  j.table.round.seats[0].hands[0].done = true;
  assert.strictEqual(E.normSave(j).table.round, null);
});
test('the running count matches every visible card, round after round', function () {
  for (var seed = 1; seed < 60; seed++) {
    var t = E.newTable({ decks: seed % 2 ? 1 : 6 }, seed);
    for (var r = 0; r < 30; r++) {
      var rd = E.startRound(t, [{ w: 'a', bet: 10 }, { w: 'a', bet: 10 }], { a: 1e9 });
      while (rd.phase !== 'done') E.act(t, E.cpuMove(t, 'book'));
      var sum = 0;
      for (var i = 0; i < t.shoe.pos; i++) sum += E.hiLo(t.shoe.cards[i]);
      assert.strictEqual(t.rc, sum);
    }
  }
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
