/* Blackjack — a multi-deck table for Cade.txt.
 * Shoe of 1 / 2 / 6 / 8 decks (reshuffled at the cut card), hit / stand /
 * double / split (re-split to four hands; split aces get one card each),
 * insurance, late surrender, dealer stands or hits soft 17, blackjack pays 3:2.
 * Play up to three spots alone (with optional computer table-mates), or pass
 * one device around for 2–3 players, each with their own chip bank.
 * A basic-strategy coach flags mistakes (or hints before you act) and a Hi-Lo
 * running / true count trainer can show the count or quiz you on it.
 * Cards are drawn as monospace "ASCII" cards in the theme's colours and fly
 * out of the shoe (Web Animations); the hole card flips over.
 * No real money: chips only, with a free rebuy when you're broke.
 * Everything persists in Cade.store (cade-blackjack-save) — including a hand
 * in progress, so closing the panel never loses a bet. Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var DECKS = [1, 2, 6, 8];
  var PEN = { 1: 0.65, 2: 0.7, 6: 0.75, 8: 0.78 };    // fraction dealt before the cut card
  var CHIPS = [5, 25, 100, 500];
  var MIN_BET = 5, MAX_BET = 1000, START_BANK = 1000, MAX_HANDS = 4;
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round2(v) { return Math.round(v * 100) / 100; }

  // cards are ints 0..51: suit = c / 13 (0 ♠ 1 ♥ 2 ♦ 3 ♣), rank = c % 13 (0 = A … 12 = K)
  function cc(x) { return typeof x === 'number' ? x : x.c; }
  function rankOf(c) { return cc(c) % 13; }
  function suitOf(c) { return Math.floor(cc(c) / 13); }
  function valOf(c) { var r = rankOf(c) + 1; return r > 10 ? 10 : r; }     // A = 1
  function hiLo(c) { var v = valOf(c); return v >= 2 && v <= 6 ? 1 : (v === 10 || v === 1) ? -1 : 0; }
  function handValue(cards) {
    var t = 0, aces = 0;
    for (var i = 0; i < cards.length; i++) { var v = valOf(cards[i]); t += v; if (v === 1) aces++; }
    var soft = aces > 0 && t + 10 <= 21;
    return { total: soft ? t + 10 : t, soft: soft };
  }
  function isNatural(cards) { return cards.length === 2 && handValue(cards).total === 21; }

  function normRules(r) {
    r = r && typeof r === 'object' ? r : {};
    return {
      decks: DECKS.indexOf(r.decks) >= 0 ? r.decks : 6,
      h17: r.h17 === true,
      surr: r.surr !== false,
      das: true, rsa: false, peek: true, insurance: true,
      maxHands: MAX_HANDS, bj: 1.5, min: MIN_BET, max: MAX_BET
    };
  }

  function newShoe(decks, seed) {
    var n = decks * 52, cards = new Array(n), r = rng(seed), i;
    for (i = 0; i < n; i++) cards[i] = i % 52;
    for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), x = cards[i]; cards[i] = cards[j]; cards[j] = x; }
    return { decks: decks, cards: cards, pos: 0, cut: Math.floor(n * (PEN[decks] || 0.75)) };
  }
  function newTable(rules, seed) {
    rules = normRules(rules);
    seed = (seed >>> 0) || 1;
    return { rules: rules, seed: seed, shoe: newShoe(rules.decks, hash2(seed, 0)), shuffles: 0, rc: 0, seq: 0, rounds: 0, round: null, ev: [] };
  }
  function needShuffle(t) { return t.shoe.pos >= t.shoe.cut; }
  function shuffle(t) {
    t.shuffles++;
    t.shoe = newShoe(t.rules.decks, hash2(t.seed, t.shuffles));
    t.rc = 0;
    t.ev.push('shuffle');
  }
  function cardsLeft(t) { return t.shoe.cards.length - t.shoe.pos; }
  function decksLeft(t) { return Math.max(0.5, Math.round(cardsLeft(t) / 26) / 2); }
  function trueCount(t) { return Math.round(t.rc / decksLeft(t) * 10) / 10; }
  function drawCard(t, up) {
    if (t.shoe.pos >= t.shoe.cards.length) shuffle(t);   // ran dry mid-round (1 deck, crowded table)
    var c = t.shoe.cards[t.shoe.pos++];
    if (up) t.rc += hiLo(c);
    return { c: c, id: ++t.seq };
  }

  function newHand(bet) { return { cards: [], bet: bet, dbl: false, fromSplit: false, splitAces: false, done: false, surr: false, res: '', ret: 0, net: 0 }; }

  // spots: [{ w: walletId, bet, kind: 'human'|'cpu', name }]; wallets: { id: chips }
  function startRound(t, spots, wallets) {
    var R = t.rules, need = {}, i;
    if (t.round && t.round.phase !== 'done') return null;
    if (!spots || !spots.length || spots.length > 3) return null;
    for (i = 0; i < spots.length; i++) {
      var sp = spots[i];
      if (!sp || typeof sp.w !== 'string' || !isNum(sp.bet) || sp.bet < R.min || sp.bet > R.max) return null;
      need[sp.w] = (need[sp.w] || 0) + sp.bet;
    }
    var W = {};
    for (var w in need) { if (!(isNum(wallets[w]) && wallets[w] + 1e-9 >= need[w])) return null; W[w] = wallets[w]; }
    if (needShuffle(t)) shuffle(t);
    var rd = { n: ++t.rounds, wallets: W, seats: [], dealer: { cards: [], up: false }, phase: 'deal', cur: { s: 0, h: 0 }, ins: -1, dealerBJ: false, tallied: false };
    for (i = 0; i < spots.length; i++) {
      var h = newHand(spots[i].bet);
      W[spots[i].w] = round2(W[spots[i].w] - spots[i].bet);
      rd.seats.push({ pi: isNum(spots[i].pi) ? spots[i].pi : i, w: spots[i].w, kind: spots[i].kind === 'cpu' ? 'cpu' : 'human', name: String(spots[i].name || ''), ins: 0, insRet: 0, net: 0, hands: [h] });
    }
    t.round = rd;
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < rd.seats.length; i++) rd.seats[i].hands[0].cards.push(drawCard(t, true));
      rd.dealer.cards.push(drawCard(t, pass === 0));
    }
    rd.holeShoe = t.shuffles;   // a mid-round reshuffle (1 deck, crowded table) drops the old hole card from the count
    if (R.insurance && valOf(rd.dealer.cards[0]) === 1) { rd.phase = 'insurance'; rd.ins = 0; }
    else peek(t);
    return rd;
  }
  function peek(t) {
    var rd = t.round, up = valOf(rd.dealer.cards[0]);
    rd.ins = -1;
    if (t.rules.peek && (up === 1 || up === 10) && isNatural(rd.dealer.cards)) {
      rd.dealerBJ = true;
      t.ev.push('dealer-bj');
      reveal(t); settle(t);
      return;
    }
    if (up === 1 || up === 10) t.ev.push('peek');
    rd.phase = 'play';
    rd.cur = { s: 0, h: 0 };
    for (var s = 0; s < rd.seats.length; s++) {
      var hd = rd.seats[s].hands[0];
      if (isNatural(hd.cards)) { hd.done = true; t.ev.push('bj'); }
    }
    advance(t);
  }
  function advance(t) {
    var rd = t.round, R = t.rules;
    for (var s = rd.cur.s; s < rd.seats.length; s++) {
      var hs = rd.seats[s].hands;
      for (var h = s === rd.cur.s ? rd.cur.h : 0; h < hs.length; h++) {
        var hand = hs[h];
        if (hand.done) continue;
        if (hand.cards.length === 1) {
          hand.cards.push(drawCard(t, true));
          if (hand.splitAces && !R.rsa) { hand.done = true; continue; }
        }
        if (handValue(hand.cards).total >= 21) { hand.done = true; if (handValue(hand.cards).total > 21) t.ev.push('bust'); continue; }
        rd.cur = { s: s, h: h };
        rd.phase = 'play';
        return;
      }
    }
    rd.cur = { s: rd.seats.length, h: 0 };
    dealerTurn(t);
  }
  function reveal(t) {
    var d = t.round.dealer;
    if (!d.up) { d.up = true; if (d.cards[1] && (t.round.holeShoe == null || t.round.holeShoe === t.shuffles)) t.rc += hiLo(d.cards[1]); }
  }
  function dealerTurn(t) {
    var rd = t.round, R = t.rules, live = false;
    rd.phase = 'dealer';
    reveal(t);
    for (var s = 0; s < rd.seats.length; s++) {
      var hs = rd.seats[s].hands;
      for (var h = 0; h < hs.length; h++) {
        var hd = hs[h];
        if (!hd.surr && handValue(hd.cards).total <= 21 && !(isNatural(hd.cards) && !hd.fromSplit)) live = true;
      }
    }
    if (live) {
      for (;;) {
        var v = handValue(rd.dealer.cards);
        if (v.total < 17 || (v.total === 17 && v.soft && R.h17)) rd.dealer.cards.push(drawCard(t, true));
        else break;
      }
      if (handValue(rd.dealer.cards).total > 21) t.ev.push('dealer-bust');
    }
    settle(t);
  }
  function settle(t) {
    var rd = t.round, R = t.rules, dv = handValue(rd.dealer.cards), dBJ = isNatural(rd.dealer.cards), dBust = dv.total > 21;
    for (var s = 0; s < rd.seats.length; s++) {
      var seat = rd.seats[s];
      seat.net = 0;
      for (var h = 0; h < seat.hands.length; h++) {
        var hd = seat.hands[h], v = handValue(hd.cards), nat = isNatural(hd.cards) && !hd.fromSplit, ret = 0, res;
        if (hd.surr) { res = 'surrender'; ret = hd.bet / 2; }
        else if (v.total > 21) res = 'bust';
        else if (nat) { if (dBJ) { res = 'push'; ret = hd.bet; } else { res = 'bj'; ret = hd.bet + hd.bet * R.bj; } }
        else if (dBJ) res = 'lose';
        else if (dBust || v.total > dv.total) { res = 'win'; ret = hd.bet * 2; }
        else if (v.total === dv.total) { res = 'push'; ret = hd.bet; }
        else res = 'lose';
        hd.done = true; hd.res = res; hd.ret = round2(ret); hd.net = round2(ret - hd.bet);
        seat.net += hd.net;
        rd.wallets[seat.w] = round2(rd.wallets[seat.w] + ret);
      }
      seat.insRet = seat.ins && dBJ ? seat.ins * 3 : 0;
      seat.net = round2(seat.net + seat.insRet - seat.ins);
      rd.wallets[seat.w] = round2(rd.wallets[seat.w] + seat.insRet);
    }
    rd.phase = 'done';
  }

  function curSeat(t) { var rd = t.round; return rd && rd.phase === 'play' ? rd.seats[rd.cur.s] : rd && rd.phase === 'insurance' ? rd.seats[rd.ins] : null; }
  function curHand(t) { var rd = t.round; return rd && rd.phase === 'play' ? rd.seats[rd.cur.s].hands[rd.cur.h] : null; }
  function insCost(seat) { return round2(seat.hands[0].bet / 2); }
  function legal(t) {
    var rd = t.round, R = t.rules, L = { hit: false, stand: false, double: false, split: false, surrender: false, insure: false, decline: false };
    if (!rd) return L;
    if (rd.phase === 'insurance') {
      var is = rd.seats[rd.ins];
      L.decline = true;
      L.insure = rd.wallets[is.w] + 1e-9 >= insCost(is);
      return L;
    }
    if (rd.phase !== 'play') return L;
    var seat = rd.seats[rd.cur.s], hd = seat.hands[rd.cur.h], w = rd.wallets[seat.w], v = handValue(hd.cards), two = hd.cards.length === 2;
    L.hit = !hd.splitAces && v.total < 21;
    L.stand = true;
    L.double = two && !hd.splitAces && w + 1e-9 >= hd.bet && (R.das || !hd.fromSplit);
    L.split = two && valOf(hd.cards[0]) === valOf(hd.cards[1]) && seat.hands.length < R.maxHands && w + 1e-9 >= hd.bet && !(hd.splitAces && !R.rsa);
    L.surrender = R.surr && two && !hd.fromSplit && seat.hands.length === 1;
    return L;
  }
  // a: hit | stand | double | split | surrender | insure | decline
  function act(t, a) {
    var rd = t.round;
    if (!rd) return false;
    var L = legal(t);
    if (!L[a]) return false;
    if (rd.phase === 'insurance') {
      var is = rd.seats[rd.ins];
      if (a === 'insure') { is.ins = insCost(is); rd.wallets[is.w] = round2(rd.wallets[is.w] - is.ins); }
      rd.ins++;
      if (rd.ins >= rd.seats.length) peek(t);
      return true;
    }
    var seat = rd.seats[rd.cur.s], hd = seat.hands[rd.cur.h];
    if (a === 'hit') {
      hd.cards.push(drawCard(t, true));
      var v = handValue(hd.cards).total;
      if (v > 21) t.ev.push('bust');
      if (v >= 21) { hd.done = true; advance(t); }
    } else if (a === 'stand') { hd.done = true; advance(t); }
    else if (a === 'double') {
      rd.wallets[seat.w] = round2(rd.wallets[seat.w] - hd.bet);
      hd.bet *= 2; hd.dbl = true;
      hd.cards.push(drawCard(t, true));
      if (handValue(hd.cards).total > 21) t.ev.push('bust');
      hd.done = true; advance(t);
    } else if (a === 'split') {
      rd.wallets[seat.w] = round2(rd.wallets[seat.w] - hd.bet);
      var aces = valOf(hd.cards[0]) === 1, nh = newHand(hd.bet);
      nh.cards.push(hd.cards.pop());
      hd.fromSplit = nh.fromSplit = true;
      hd.splitAces = nh.splitAces = aces;
      seat.hands.splice(rd.cur.h + 1, 0, nh);
      advance(t);
    } else if (a === 'surrender') { hd.surr = true; hd.done = true; advance(t); }
    return true;
  }

  // ---- basic strategy (multi-deck chart, double after split, late surrender) ----
  // H hit, S stand, D double, P split, R surrender. can: what is allowed right now.
  function strategy(cards, up, rules, can) {
    rules = rules || {}; can = can || { double: true, split: true, surrender: true };
    var v = handValue(cards), d = valOf(up), t = v.total, h17 = !!rules.h17;
    if (d === 1) d = 11;
    var pair = cards.length === 2 && valOf(cards[0]) === valOf(cards[1]) ? valOf(cards[0]) : 0;
    if (can.surrender && !v.soft && cards.length === 2) {
      if (pair === 8) { if (h17 && d === 11) return 'R'; }
      else if (t === 16 && d >= 9) return 'R';
      else if (t === 15 && (d === 10 || (h17 && d === 11))) return 'R';
      else if (t === 17 && h17 && d === 11) return 'R';
    }
    if (can.split && pair) {
      var sp = false;
      if (pair === 1 || pair === 8) sp = true;
      else if (pair === 9) sp = d <= 9 && d !== 7;
      else if (pair === 7 || pair === 3 || pair === 2) sp = d <= 7;
      else if (pair === 6) sp = d <= 6;
      else if (pair === 4) sp = d === 5 || d === 6;
      if (sp) return 'P';
    }
    var r;
    if (v.soft) {
      if (t >= 20) r = 'S';
      else if (t === 19) r = h17 && d === 6 ? 'Ds' : 'S';
      else if (t === 18) r = d <= 6 ? (h17 || d >= 3 ? 'Ds' : 'S') : d <= 8 ? 'S' : 'H';
      else if (t === 17) r = d >= 3 && d <= 6 ? 'D' : 'H';
      else if (t >= 15) r = d >= 4 && d <= 6 ? 'D' : 'H';
      else if (t >= 13) r = d >= 5 && d <= 6 ? 'D' : 'H';
      else r = 'H';
    } else {
      if (t >= 17) r = 'S';
      else if (t >= 13) r = d <= 6 ? 'S' : 'H';
      else if (t === 12) r = d >= 4 && d <= 6 ? 'S' : 'H';
      else if (t === 11) r = d === 11 && !h17 ? 'H' : 'D';
      else if (t === 10) r = d <= 9 ? 'D' : 'H';
      else if (t === 9) r = d >= 3 && d <= 6 ? 'D' : 'H';
      else r = 'H';
    }
    if (r === 'D') return can.double ? 'D' : 'H';
    if (r === 'Ds') return can.double ? 'D' : 'S';
    return r;
  }
  var ACTION_OF = { H: 'hit', S: 'stand', D: 'double', P: 'split', R: 'surrender' };
  // the coach's call for the hand in play
  function advice(t) {
    var hd = curHand(t);
    if (!hd) return null;
    var L = legal(t), code = strategy(hd.cards, t.round.dealer.cards[0], t.rules, { double: L.double, split: L.split, surrender: L.surrender });
    if (code === 'H' && !L.hit) code = 'S';
    return ACTION_OF[code];
  }
  function upName(c) { var v = valOf(c); return v === 1 ? 'A' : String(v); }
  function describe(cards, up) {
    var v = handValue(cards), pair = cards.length === 2 && valOf(cards[0]) === valOf(cards[1]);
    var me = pair ? 'pair of ' + (valOf(cards[0]) === 1 ? 'aces' : valOf(cards[0]) + 's') : (v.soft ? 'soft ' : 'hard ') + v.total;
    return me + ' vs ' + upName(up);
  }
  // Insurance is a side bet on the hole card: worth it at a true count of +3 or more.
  function insuranceAdvice(tc) { return tc >= 3; }

  // A whole hand for a computer seat: 'book' plays basic strategy, 'hunch' never risks a bust.
  function cpuMove(t, style) {
    var rd = t.round;
    if (!rd) return null;
    if (rd.phase === 'insurance') return 'decline';
    var hd = curHand(t);
    if (!hd) return null;
    if (style === 'hunch') {
      var L = legal(t), v = handValue(hd.cards);
      if (L.split && (valOf(hd.cards[0]) === 1 || valOf(hd.cards[0]) === 8)) return 'split';
      if (L.double && !v.soft && v.total === 11) return 'double';
      return v.total >= 12 && !v.soft || v.total >= 18 ? 'stand' : 'hit';
    }
    return advice(t);
  }

  // ---- persistence ----
  var STAT_KEYS = ['rounds', 'hands', 'wins', 'losses', 'pushes', 'bjs', 'busts', 'doubles', 'dblWins', 'splits', 'surrenders',
    'insTaken', 'insWon', 'rebuys', 'biggest', 'peak', 'coachOk', 'coachBad', 'quizOk', 'quizN', 'streak', 'bestStreak', 'wagered', 'net'];
  var OPT_ENUM = {
    mode: ['solo', 'multi'], coach: ['off', 'flag', 'hint'], count: ['off', 'show', 'quiz'], speed: ['normal', 'fast']
  };
  function newStats() { var s = {}; for (var i = 0; i < STAT_KEYS.length; i++) s[STAT_KEYS[i]] = 0; s.peak = START_BANK; return s; }
  function newSave() {
    return {
      v: 1,
      banks: { solo: START_BANK, p1: START_BANK, p2: START_BANK, p3: START_BANK },
      rules: normRules(),
      opts: { mode: 'solo', spots: 1, mates: 0, players: 2, coach: 'flag', count: 'off', speed: 'normal' },
      last: { solo: [25, 25, 25], multi: [25, 25, 25] },
      stats: newStats(),
      mstats: { p1: { hands: 0, net: 0, bjs: 0 }, p2: { hands: 0, net: 0, bjs: 0 }, p3: { hands: 0, net: 0, bjs: 0 } },
      table: null
    };
  }
  function intIn(v, a, b, d) { return isNum(v) && v >= a && v <= b ? Math.round(v) : d; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var k, i;
    if (o.banks && typeof o.banks === 'object') for (k in s.banks) if (isNum(o.banks[k]) && o.banks[k] >= 0) s.banks[k] = round2(Math.min(o.banks[k], 1e12));
    s.rules = normRules(o.rules);
    var op = o.opts && typeof o.opts === 'object' ? o.opts : {};
    for (k in OPT_ENUM) if (OPT_ENUM[k].indexOf(op[k]) >= 0) s.opts[k] = op[k];
    s.opts.spots = intIn(op.spots, 1, 3, 1);
    s.opts.mates = Math.min(intIn(op.mates, 0, 2, 0), 3 - s.opts.spots);
    s.opts.players = intIn(op.players, 2, 3, 2);
    if (o.last && typeof o.last === 'object') {
      ['solo', 'multi'].forEach(function (m) {
        var a = o.last[m];
        if (Array.isArray(a)) for (i = 0; i < 3; i++) s.last[m][i] = intIn(a[i], 0, MAX_BET, 25);
      });
    }
    if (o.stats && typeof o.stats === 'object') {
      for (i = 0; i < STAT_KEYS.length; i++) {
        k = STAT_KEYS[i];
        var v = o.stats[k];
        if (isNum(v)) s.stats[k] = k === 'net' ? round2(v) : Math.max(0, k === 'biggest' || k === 'peak' || k === 'wagered' ? round2(v) : Math.round(v));
      }
    }
    if (o.mstats && typeof o.mstats === 'object') {
      for (k in s.mstats) {
        var m = o.mstats[k];
        if (m && typeof m === 'object') {
          s.mstats[k].hands = intIn(m.hands, 0, 1e9, 0);
          s.mstats[k].bjs = intIn(m.bjs, 0, 1e9, 0);
          s.mstats[k].net = isNum(m.net) ? round2(m.net) : 0;
        }
      }
    }
    s.table = normTable(o.table, s.rules);
    return s;
  }
  function okCard(x) { return x && typeof x === 'object' && isNum(x.c) && x.c >= 0 && x.c < 52 && x.c % 1 === 0 && isNum(x.id); }
  function okCards(a, min, max) {
    if (!Array.isArray(a) || a.length < min || a.length > max) return false;
    for (var i = 0; i < a.length; i++) if (!okCard(a[i])) return false;
    return true;
  }
  // A saved table, checked thoroughly; anything off and the table starts over (null).
  function normTable(o, rules) {
    try {
      if (!o || typeof o !== 'object') return null;
      var R = normRules(rules), sh = o.shoe;
      if (!sh || sh.decks !== R.decks || !Array.isArray(sh.cards) || sh.cards.length !== R.decks * 52) return null;
      for (var i = 0; i < sh.cards.length; i++) { var c = sh.cards[i]; if (!isNum(c) || c < 0 || c > 51 || c % 1) return null; }
      if (!isNum(sh.pos) || sh.pos < 0 || sh.pos > sh.cards.length || !isNum(sh.cut)) return null;
      var t = {
        rules: R, seed: (o.seed >>> 0) || 1, shoe: { decks: sh.decks, cards: sh.cards.slice(), pos: sh.pos | 0, cut: sh.cut | 0 },
        shuffles: intIn(o.shuffles, 0, 1e9, 0), rc: isNum(o.rc) ? Math.round(o.rc) : 0, seq: intIn(o.seq, 0, 1e12, 0),
        rounds: intIn(o.rounds, 0, 1e12, 0), round: null, ev: []
      };
      var rd = o.round;
      if (rd && typeof rd === 'object') {
        var phases = ['insurance', 'play', 'done'];
        if (phases.indexOf(rd.phase) < 0 || !Array.isArray(rd.seats) || rd.seats.length < 1 || rd.seats.length > 3) return t;
        if (!rd.wallets || typeof rd.wallets !== 'object' || !rd.dealer || !okCards(rd.dealer.cards, 2, 12)) return t;
        for (var s = 0; s < rd.seats.length; s++) {
          var st = rd.seats[s];
          if (!st || typeof st.w !== 'string' || !isNum(rd.wallets[st.w]) || !Array.isArray(st.hands) || st.hands.length < 1 || st.hands.length > MAX_HANDS) return t;
          if (!isNum(st.ins) || !isNum(st.net)) return t;
          for (var h = 0; h < st.hands.length; h++) {
            var hd = st.hands[h];
            if (!hd || !okCards(hd.cards, 1, 12) || !isNum(hd.bet) || hd.bet <= 0) return t;
          }
        }
        if (!rd.cur || !isNum(rd.cur.s) || !isNum(rd.cur.h)) return t;
        if (rd.phase === 'play' && !(rd.seats[rd.cur.s] && rd.seats[rd.cur.s].hands[rd.cur.h] && !rd.seats[rd.cur.s].hands[rd.cur.h].done)) return t;
        if (rd.phase === 'insurance' && !(isNum(rd.ins) && rd.seats[rd.ins])) return t;
        t.round = JSON.parse(JSON.stringify(rd));
        t.round.dealer.up = !!rd.dealer.up;
        t.round.tallied = !!rd.tallied;
      }
      return t;
    } catch (e) { return null; }
  }
  // Fold a finished round into the stats. Only human seats count; solo seats feed
  // the main stats, pass-and-play seats their player's line. Returns per-wallet net.
  function tally(save, t) {
    var rd = t.round, nets = {};
    if (!rd || rd.phase !== 'done' || rd.tallied) return nets;
    rd.tallied = true;
    var st = save.stats, soloAny = false, soloNet = 0;
    for (var s = 0; s < rd.seats.length; s++) {
      var seat = rd.seats[s];
      if (seat.kind !== 'human') continue;
      nets[seat.w] = round2((nets[seat.w] || 0) + seat.net);
      if (seat.w === 'solo') {
        soloAny = true; soloNet += seat.net;
        if (seat.hands.length > 1) st.splits += seat.hands.length - 1;
        if (seat.ins) { st.insTaken++; if (seat.insRet) st.insWon++; }
        for (var h = 0; h < seat.hands.length; h++) {
          var hd = seat.hands[h];
          st.hands++;
          st.wagered = round2(st.wagered + hd.bet);
          if (hd.res === 'win' || hd.res === 'bj') st.wins++;
          else if (hd.res === 'push') st.pushes++;
          else st.losses++;
          if (hd.res === 'bj') st.bjs++;
          if (hd.res === 'bust') st.busts++;
          if (hd.res === 'surrender') st.surrenders++;
          if (hd.dbl) { st.doubles++; if (hd.res === 'win') st.dblWins++; }
        }
      } else if (save.mstats[seat.w]) {
        var m = save.mstats[seat.w];
        m.hands += seat.hands.length;
        m.net = round2(m.net + seat.net);
        for (var h2 = 0; h2 < seat.hands.length; h2++) if (seat.hands[h2].res === 'bj') m.bjs++;
      }
      if (isNum(rd.wallets[seat.w]) && save.banks[seat.w] !== undefined) save.banks[seat.w] = rd.wallets[seat.w];
    }
    if (soloAny) {
      st.rounds++;
      st.net = round2(st.net + soloNet);
      if (soloNet > st.biggest) st.biggest = round2(soloNet);
      if (soloNet > 0) { st.streak++; if (st.streak > st.bestStreak) st.bestStreak = st.streak; }
      else if (soloNet < 0) st.streak = 0;
      if (save.banks.solo > st.peak) st.peak = save.banks.solo;
    }
    return nets;
  }

  var ENGINE = {
    DECKS: DECKS, PEN: PEN, CHIPS: CHIPS, MIN_BET: MIN_BET, MAX_BET: MAX_BET, START_BANK: START_BANK, MAX_HANDS: MAX_HANDS, RANKS: RANKS, STAT_KEYS: STAT_KEYS,
    rng: rng, hash2: hash2, rankOf: rankOf, suitOf: suitOf, valOf: valOf, hiLo: hiLo, handValue: handValue, isNatural: isNatural,
    normRules: normRules, newShoe: newShoe, newTable: newTable, needShuffle: needShuffle, shuffle: shuffle, cardsLeft: cardsLeft,
    decksLeft: decksLeft, trueCount: trueCount, drawCard: drawCard, startRound: startRound, legal: legal, act: act,
    curSeat: curSeat, curHand: curHand, insCost: insCost, strategy: strategy, advice: advice, describe: describe,
    insuranceAdvice: insuranceAdvice, cpuMove: cpuMove, newSave: newSave, normSave: normSave, normTable: normTable, tally: tally, round2: round2
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('blackjack.css');

  var PANEL_ID = 'blackjack-panel', NAME = 'Blackjack';
  var SAVE_KEY = 'cade-blackjack-save', SOUND_KEY = 'cade-blackjack-sound';
  var SUIT_CH = ['♠︎', '♥︎', '♦︎', '♣︎'];
  var MATES = [{ name: 'Lou', style: 'book' }, { name: 'Kit', style: 'hunch' }];
  var QUIZ_EVERY = 4;
  var S = null;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() {
    if (!S) return;
    S.save.table = S.t;
    var ev = S.t.ev; S.t.ev = [];
    sset(SAVE_KEY, JSON.stringify(S.save));
    S.t.ev = ev;
  }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    var s = String(Math.floor(Math.abs(n))), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return s + out;
  }
  function money(n) {
    var a = Math.abs(n), cents = Math.round(a * 100) % 100;
    return (n < 0 ? '-' : '') + '$' + fmtInt(a) + (cents ? '.' + (cents < 10 ? '0' : '') + cents : '');
  }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n)); }

  // ---- sound ----
  function Snd(on) { this.on = !!on; this.ac = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  var SFX = {
    deal: function (d) { S.snd.tone(1900, 0.035, 'triangle', 0.025, 700, d); },
    chip: function () { S.snd.tone(2400, 0.03, 'square', 0.012); S.snd.tone(1900, 0.04, 'square', 0.01, 0, 0.035); },
    flip: function (d) { S.snd.tone(900, 0.05, 'triangle', 0.03, 1500, d); },
    win: function (d) { [660, 880, 1320].forEach(function (f, i) { S.snd.tone(f, 0.12, 'triangle', 0.04, 0, d + i * 0.07); }); },
    bj: function (d) { [523, 659, 784, 1047, 1319].forEach(function (f, i) { S.snd.tone(f, 0.16, 'square', 0.025, 0, d + i * 0.07); }); },
    lose: function (d) { S.snd.tone(260, 0.3, 'sine', 0.05, 150, d); },
    push: function (d) { S.snd.tone(520, 0.07, 'sine', 0.035, 0, d); S.snd.tone(520, 0.07, 'sine', 0.035, 0, d + 0.1); },
    bust: function (d) { S.snd.tone(170, 0.22, 'sawtooth', 0.025, 90, d); },
    shuffle: function () { for (var i = 0; i < 14; i++) S.snd.tone(1200 + (i % 3) * 300, 0.02, 'triangle', 0.018, 600, i * 0.045); },
    oops: function () { S.snd.tone(300, 0.08, 'square', 0.02, 240); },
    tick: function () { S.snd.tone(1200, 0.04, 'sine', 0.03); }
  };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

  // ---- seats for the next round, from the options ----
  function seatPlan() {
    var o = S.save.opts, out = [], i;
    if (o.mode === 'multi') {
      for (i = 0; i < o.players; i++) out.push({ w: 'p' + (i + 1), kind: 'human', name: 'Player ' + (i + 1) });
      return out;
    }
    var you = [];
    for (i = 0; i < o.spots; i++) you.push({ w: 'solo', kind: 'human', name: o.spots > 1 ? 'Spot ' + (i + 1) : 'You' });
    if (o.mates >= 1) out.push({ w: 'cpu1', kind: 'cpu', name: MATES[0].name, style: MATES[0].style });
    out = out.concat(you);
    if (o.mates >= 2) out.push({ w: 'cpu2', kind: 'cpu', name: MATES[1].name, style: MATES[1].style });
    return out;
  }
  function bankOf(w) {
    if (w === 'cpu1' || w === 'cpu2') return S.cpuBank[w];
    var rd = S.t.round;
    if (rd && !rd.tallied && isNum(rd.wallets[w])) return rd.wallets[w];
    return S.save.banks[w] || 0;
  }
  function setBank(w, v) {
    if (w === 'cpu1' || w === 'cpu2') S.cpuBank[w] = v; else S.save.banks[w] = v;
  }
  function betting() { var rd = S.t.round; return !rd || (rd.phase === 'done' && rd.tallied); }
  function styleOf(seat) {
    for (var i = 0; i < MATES.length; i++) if (MATES[i].name === seat.name) return MATES[i].style;
    return 'book';
  }

  // bets for the coming round (index = plan seat); prefilled from the last round
  function initBets() {
    var plan = seatPlan(), mode = S.save.opts.mode, last = S.save.last[mode], hi = 0;
    S.plan = plan;
    S.bets = plan.map(function (p) {
      if (p.kind === 'cpu') return 0;
      var b = last[hi++] || 0;
      return b;
    });
    fitBets();
    if (S.sel == null || !plan[S.sel] || plan[S.sel].kind !== 'human') S.sel = firstHuman();
  }
  function firstHuman() { for (var i = 0; i < S.plan.length; i++) if (S.plan[i].kind === 'human') return i; return 0; }
  // trim prefilled bets to what each bank can cover
  function fitBets() {
    var used = {};
    for (var i = 0; i < S.plan.length; i++) {
      var p = S.plan[i];
      if (p.kind !== 'human') continue;
      var avail = bankOf(p.w) - (used[p.w] || 0), b = Math.min(S.bets[i], MAX_BET);
      while (b > avail + 1e-9) b -= MIN_BET;
      if (b < MIN_BET) b = 0;
      S.bets[i] = b;
      used[p.w] = (used[p.w] || 0) + b;
    }
  }
  function walletUsed(w, except) {
    var u = 0;
    for (var i = 0; i < S.plan.length; i++) if (i !== except && S.plan[i].w === w) u += S.bets[i];
    return u;
  }

  // ---- rendering ----
  function cardHTML(card, hidden, extra) {
    if (hidden) return '<div class="bj-card back' + (extra || '') + '" data-id="' + card.id + '"><i>' + BACK_ART + '</i></div>';
    var r = rankOf(card.c), s = suitOf(card.c), red = s === 1 || s === 2, rk = RANKS[r], sc = SUIT_CH[s];
    var mid = r >= 10 ? '<b class="bj-face">' + rk + '</b>' : r === 0 ? '<b class="bj-ace">' + sc + '</b>' : '<b>' + sc + '</b>';
    return '<div class="bj-card' + (red ? ' red' : '') + (extra || '') + '" data-id="' + card.id + '" aria-label="' + rk + ' of ' + ['spades', 'hearts', 'diamonds', 'clubs'][s] + '">' +
      '<span class="bj-ix">' + rk + '<br>' + sc + '</span><span class="bj-mid">' + mid + '</span><span class="bj-ix bj-ix2">' + rk + '<br>' + sc + '</span></div>';
  }
  var BACK_ART = (function () { var row = '+ + + + + + +', a = []; for (var i = 0; i < 9; i++) a.push(i % 2 ? ' ' + row : row); return a.join('\n'); })();

  function totalLabel(cards, nat, live) {
    var v = handValue(cards);
    if (nat) return 'BJ';
    if (v.total > 21) return String(v.total);
    if (live && v.soft && v.total < 21) return (v.total - 10) + '/' + v.total;
    return String(v.total);
  }
  // [class, full stamp, compact stamp] — the compact one fits narrow split hands
  function resLabel(hd) {
    var amt = signed(hd.net);
    switch (hd.res) {
      case 'bj': return ['bj', 'BLACKJACK ' + amt, 'BJ ' + amt];
      case 'win': return ['win', 'WIN ' + amt, amt];
      case 'push': return ['push', 'PUSH', 'PUSH'];
      case 'bust': return ['lose', 'BUST ' + amt, amt];
      case 'surrender': return ['lose', 'SURR ' + amt, amt];
      case 'lose': return ['lose', 'LOSE ' + amt, amt];
    }
    return null;
  }

  function sizeCards(seats) {
    var fw = S.felt.clientWidth || 520, n = Math.max(1, seats.length), k = 4, hmax = 1, dk = 4;
    seats.forEach(function (st) {
      if (st.hands) {
        hmax = Math.max(hmax, st.hands.length);
        st.hands.forEach(function (h) { k = Math.max(k, h.cards.length); });
      }
    });
    var rd = S.t.round;
    if (rd && rd.dealer) dk = Math.max(dk, rd.dealer.cards.length);
    var perRow = Math.min(hmax, n === 1 ? 4 : 2), handW = 1 + (k - 1) * 0.46;
    var seatW = (fw - 16) / n - 12;
    var cw = (seatW - (perRow - 1) * 10) / (perRow * handW);
    cw = Math.max(28, Math.min(72, Math.floor(cw)));
    var dcw = Math.max(34, Math.min(72, Math.floor((fw * 0.8) / (1 + (dk - 1) * 0.46))));
    S.cw = cw;
    S.felt.style.setProperty('--cw', cw + 'px');
    S.felt.style.setProperty('--dcw', Math.max(cw, dcw) + 'px');
  }

  function render() {
    if (!S) return;
    var t = S.t, rd = t.round, bet = betting();
    if (bet && !S.plan) initBets();
    // shoe + count
    var left = cardsLeft(t), tot = t.shoe.cards.length, pctLeft = Math.round(left / tot * 100);
    var cnt = S.save.opts.count, cHtml = '';
    if (cnt === 'show') cHtml = '<span class="bj-cnt"><i>RC</i> <b>' + (t.rc > 0 ? '+' : '') + t.rc + '</b> <i>TC</i> <b>' + (trueCount(t) > 0 ? '+' : '') + trueCount(t).toFixed(1) + '</b></span>';
    else if (cnt === 'quiz') cHtml = '<span class="bj-cnt" title="Keep the running count yourself — a quiz comes every few rounds"><i>RC</i> <b>?</b></span>';
    S.top.innerHTML =
      (S.save.opts.mode === 'solo' ? '<div class="bj-bank" title="Your chips"><i>BANK</i> <b>' + money(bankOf('solo')) + '</b></div>' : '') +
      '<div class="bj-rules">' + t.rules.decks + 'D · ' + (t.rules.h17 ? 'H17' : 'S17') + ' · 3:2' + (t.rules.surr ? ' · LS' : '') + '</div>' + cHtml +
      '<div class="bj-shoe" title="' + left + ' cards left"><div class="bj-shoebox"><div class="bj-card back mini"><i>' + BACK_ART + '</i></div></div>' +
      '<div class="bj-shoeinfo"><b>' + pctLeft + '% <i>' + t.rules.decks + 'D</i></b><span class="bj-pen"><span style="width:' + pctLeft + '%"></span><em style="left:' + Math.round((1 - t.shoe.cut / tot) * 100) + '%"></em></span></div></div>';

    // seats to show: the live round's, or (betting) the plan with the last round's cards if it still matches
    var seats, showOld = false;
    if (bet) {
      seats = S.plan.map(function (p) { return { w: p.w, kind: p.kind, name: p.name, hands: null }; });
      if (rd && rd.tallied) {
        // last round's cards stay on the felt until the next deal (when the seats still match)
        showOld = true;
        for (var q = 0; q < rd.seats.length; q++) { var os = rd.seats[q], ns = seats[os.pi]; if (!ns || ns.w !== os.w) showOld = false; }
        if (showOld) for (q = 0; q < rd.seats.length; q++) { var o2 = rd.seats[q], n2 = seats[o2.pi]; n2.hands = o2.hands; n2.ins = o2.ins; n2.insRet = o2.insRet; }
      }
    } else seats = rd.seats;
    sizeCards(seats);

    // dealer
    var dh = '', dlab = '';
    if (rd && (!bet || showOld)) {
      var dc = rd.dealer.cards;
      for (var i = 0; i < dc.length; i++) dh += cardHTML(dc[i], i === 1 && !rd.dealer.up, i === 1 && rd.dealer.up && !S.holeShown ? ' flip' : '');
      if (rd.dealer.up) {
        var dv = handValue(dc);
        dlab = '<span class="bj-tot bj-late' + (dv.total > 21 ? ' bust' : '') + '">' + (isNatural(dc) ? 'BJ' : dv.total > 21 ? 'BUST ' + dv.total : dv.total) + '</span>';
      } else dlab = '<span class="bj-tot">' + (valOf(dc[0]) === 1 ? 'A' : valOf(dc[0])) + '</span>';
    } else dh = '<div class="bj-slot"></div><div class="bj-slot"></div>';
    S.dealer.className = 'bj-dealer' + (bet && showOld ? ' old' : '');
    S.dealer.innerHTML = '<div class="bj-lbl">DEALER ' + dlab + '</div><div class="bj-hand">' + dh + '</div>';

    // seats
    var cur = rd && rd.phase === 'play' ? rd.cur : null, insSeat = rd && rd.phase === 'insurance' ? rd.ins : -1, sh = '';
    for (var s = 0; s < seats.length; s++) {
      var st = seats[s], cls = 'bj-seat' + (st.kind === 'cpu' ? ' cpu' : ''), hands = '';
      if (!bet && ((cur && cur.s === s) || insSeat === s)) cls += ' act';
      if (bet && S.sel === s && st.kind === 'human' && humanCount() > 1) cls += ' sel';
      if (bet && showOld) cls += ' old';
      if (st.hands) {
        for (var h = 0; h < st.hands.length; h++) {
          var hd = st.hands[h], nat = isNatural(hd.cards) && !hd.fromSplit, hcl = 'bj-h';
          if (cur && cur.s === s && cur.h === h) hcl += ' act';
          if (hd.done && rd.phase === 'play' && !(cur && cur.s === s && cur.h === h)) hcl += ' fin';
          var cards = '';
          for (var j = 0; j < hd.cards.length; j++) cards += cardHTML(hd.cards[j], false, hd.dbl && j === 2 ? ' dbl' : '');
          var v = handValue(hd.cards), rl = rd && rd.phase === 'done' ? resLabel(hd) : null;
          if ((S.cw || 60) * (1 + (hd.cards.length - 1) * 0.46) < 74) hcl += ' cmp';
          hands += '<div class="' + hcl + '">' +
            '<div class="bj-hv bj-late' + (v.total > 21 ? ' bust' : nat ? ' nat' : '') + '">' + totalLabel(hd.cards, nat, !hd.done) + '</div>' +
            '<div class="bj-hand">' + cards + '</div>' +
            '<div class="bj-hbet"><span class="bj-chip c' + chipTier(hd.bet) + '"></span>' + money(hd.bet) + (hd.dbl ? ' <em>×2</em>' : '') + '</div>' +
            (rl ? '<div class="bj-res bj-late r-' + rl[0] + '"><span class="lg">' + rl[1] + '</span><span class="sm">' + rl[2] + '</span></div>' : '') +
            '</div>';
        }
        if (st.ins) hands += '<div class="bj-insb bj-late">INS ' + (rd.phase === 'done' ? (st.insRet ? signed(st.insRet - st.ins) : signed(-st.ins)) : money(st.ins)) + '</div>';
      }
      if (!st.hands) hands = '<div class="bj-h empty"><div class="bj-hand"><div class="bj-slot"></div></div></div>';
      var betLine = '';
      if (bet) {
        var b = S.bets[s];
        betLine = st.kind === 'cpu' ? '<div class="bj-spot cpu">' + (S.cpuStyleLbl[st.w] || '') + '</div>' :
          '<div class="bj-spot' + (b ? ' on' : '') + '" data-seat="' + s + '"><span class="bj-chip c' + chipTier(b) + '"></span>' + (b ? money(b) : 'no bet') + '</div>';
      }
      sh += '<div class="' + cls + '" data-seat="' + s + '"><div class="bj-hands">' + hands + '</div>' + betLine +
        '<div class="bj-name">' + esc(st.name) + (st.kind === 'cpu' ? ' <i>cpu</i>' : '') + (st.w === 'solo' ? '' : ' <b>' + money(bankOf(st.w)) + '</b>') + '</div></div>';
    }
    S.seats.className = 'bj-seats n' + seats.length;
    S.seats.innerHTML = sh;

    renderMsg();
    renderPad();
    syncHead();
    return animate();
  }
  function humanCount() { var n = 0; for (var i = 0; i < S.plan.length; i++) if (S.plan[i].kind === 'human') n++; return n; }
  function chipTier(b) { return b >= 500 ? 4 : b >= 100 ? 3 : b >= 25 ? 2 : 1; }

  // fly new cards out of the shoe, flip the hole card; returns ms until the table settles
  function animate() {
    var rd = S.t.round, els = S.felt.querySelectorAll('.bj-card[data-id]'), fresh = [], flip = null, maxId = S.maxId, i;
    for (i = 0; i < els.length; i++) {
      var id = +els[i].getAttribute('data-id');
      if (id > S.maxId && !els[i].classList.contains('mini')) fresh.push(els[i]);
      if (id > maxId) maxId = id;
      if (els[i].classList.contains('flip')) flip = els[i];
    }
    S.maxId = maxId;
    if (rd && rd.dealer.up) S.holeShown = true;
    fresh.sort(function (a, b) { return a.getAttribute('data-id') - b.getAttribute('data-id'); });
    var fast = S.save.opts.speed === 'fast', dur = S.rm ? 0 : fast ? 170 : 280, gap = S.rm ? 0 : fast ? 95 : 190, T = 0;
    var shoe = S.top.querySelector('.bj-shoebox'), sr = shoe ? shoe.getBoundingClientRect() : null;
    var canAnim = !!(fresh.length || flip) && typeof Element !== 'undefined' && Element.prototype.animate;
    // the hole card flips first when the dealer's turn begins, unless it's part of a fresh deal
    var flipFirst = flip && fresh.indexOf(flip) < 0;
    if (flipFirst) {
      if (canAnim && !S.rm) flip.animate([{ transform: 'perspective(400px) rotateY(90deg)' }, { transform: 'none' }], { duration: fast ? 160 : 260, easing: 'ease-out', fill: 'backwards' });
      SFX.flip(0);
      T += S.rm ? 0 : fast ? 200 : 340;
    }
    for (i = 0; i < fresh.length; i++) {
      var el = fresh[i], d = T + i * gap;
      if (canAnim && sr && dur) {
        var r = el.getBoundingClientRect(), dx = sr.left - r.left, dy = sr.top - r.top;
        el.animate([
          { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(-14deg) scale(0.55)', opacity: 0.4 },
          { transform: 'translate(' + (dx * 0.1) + 'px,' + (dy * 0.1) + 'px) rotate(-2deg)', opacity: 1, offset: 0.8 },
          { transform: 'none', opacity: 1 }
        ], { duration: dur, delay: d, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
      }
      SFX.deal(d / 1000);
    }
    if (fresh.length) T += (fresh.length - 1) * gap + dur;
    S.root.style.setProperty('--late', T + 'ms');
    return T;
  }

  function renderMsg() {
    var t = S.t, rd = t.round, m = '', cls = '';
    if (S.shuffling) m = 'Shuffling the shoe…';
    else if (betting()) {
      if (rd && rd.tallied && S.lastMsg) { m = S.lastMsg; cls = S.lastCls || ''; }
      else {
        var p = S.plan[S.sel];
        m = humanCount() > 1 && p ? (S.save.opts.mode === 'multi' ? p.name + ': place your bet' : 'Bet on each spot (tap a spot)') : 'Place your bet';
      }
    } else if (rd.phase === 'insurance') {
      var is = rd.seats[rd.ins];
      m = 'Dealer shows an ace — ' + (is.kind === 'cpu' ? is.name + ' is deciding…' : (multiHumans() ? is.name + ', insurance?' : 'insurance?'));
    } else if (rd.phase === 'play') {
      var seat = rd.seats[rd.cur.s], hd = seat.hands[rd.cur.h];
      if (seat.kind === 'cpu') m = seat.name + ' is playing…';
      else {
        m = (multiHumans() ? seat.name + ' — ' : seat.hands.length > 1 ? 'Hand ' + (rd.cur.h + 1) + ' — ' : '') + describe(hd.cards, rd.dealer.cards[0]);
        cls = 'turn';
      }
    } else m = 'Dealer plays…';
    S.msg.className = 'bj-msg ' + cls;
    S.msg.innerHTML = m;
    S.live.textContent = m.replace(/<[^>]+>/g, '');
  }
  function multiHumans() { var rd = S.t.round, n = 0; if (!rd) return false; rd.seats.forEach(function (s) { if (s.kind === 'human') n++; }); return n > 1 && S.save.opts.mode === 'multi'; }

  function renderPad() {
    var t = S.t, rd = t.round, h = '', coach = S.save.opts.coach;
    if (S.shuffling) h = '<div class="bj-row"><button class="bj-act alt" disabled>shuffling…</button></div>';
    else if (betting()) {
      var p = S.plan[S.sel] || S.plan[firstHuman()], w = p.w, bank = bankOf(w), avail = bank - walletUsed(w, -1), anyBet = false;
      for (var i = 0; i < S.bets.length; i++) if (S.bets[i]) anyBet = true;
      var broke = bank < MIN_BET && walletUsed(w, -1) === 0;
      h = '<div class="bj-row bj-chips">';
      CHIPS.forEach(function (c, ci) {
        h += '<button class="bj-chipbtn c' + (ci + 1) + '" data-chip="' + c + '"' + (c > avail + 1e-9 || S.bets[S.sel] + c > MAX_BET ? ' disabled' : '') + ' aria-label="Bet ' + c + '"><span>' + c + '</span></button>';
      });
      h += '</div><div class="bj-row">';
      if (broke) h += '<button class="bj-act alt" data-a="rebuy">rebuy <small>+' + money(START_BANK) + '</small></button>';
      else h += '<button class="bj-act alt" data-a="clear"' + (S.bets[S.sel] ? '' : ' disabled') + '>clear <small>⌫</small></button>' +
        '<button class="bj-act alt" data-a="x2"' + (S.bets[S.sel] && S.bets[S.sel] <= avail + 1e-9 && S.bets[S.sel] * 2 <= MAX_BET ? '' : ' disabled') + '>×2</button>';
      h += '<button class="bj-act go" data-a="deal"' + (anyBet ? '' : ' disabled') + '>deal <small>↵</small></button></div>';
    } else if (rd.phase === 'insurance' && rd.seats[rd.ins].kind === 'human') {
      var L0 = legal(t), cost = insCost(rd.seats[rd.ins]), nat = isNatural(rd.seats[rd.ins].hands[0].cards);
      var recIns = coach === 'hint' ? (insuranceAdvice(trueCount(t)) && S.save.opts.count !== 'off' ? 'insure' : 'decline') : '';
      h = '<div class="bj-row">' +
        '<button class="bj-act' + (recIns === 'insure' ? ' rec' : '') + '" data-a="insure"' + (L0.insure ? '' : ' disabled') + '>' + (nat ? 'even money' : 'insure') + ' <small>' + money(cost) + ' · Y</small></button>' +
        '<button class="bj-act alt' + (recIns === 'decline' ? ' rec' : '') + '" data-a="decline">no thanks <small>N</small></button></div>';
    } else if (rd.phase === 'play' && rd.seats[rd.cur.s].kind === 'human') {
      var L = legal(t), rec = coach === 'hint' ? advice(t) : '';
      var btn = function (a, label, key) {
        return '<button class="bj-act' + (a === 'hit' || a === 'stand' ? '' : ' alt2') + (rec === a ? ' rec' : '') + '" data-a="' + a + '"' + (L[a] ? '' : ' disabled') + '>' + label + ' <small>' + key + '</small></button>';
      };
      h = '<div class="bj-row">' + btn('hit', 'hit', 'H') + btn('stand', 'stand', 'S') + '</div>' +
        '<div class="bj-row">' + btn('double', 'double', 'D') + btn('split', 'split', 'P') + (t.rules.surr ? btn('surrender', 'surr', 'R') : '') + '</div>';
    } else h = '<div class="bj-row"><button class="bj-act alt" disabled>' + (rd.phase === 'play' || rd.phase === 'insurance' ? 'table-mate’s turn' : 'dealer’s turn') + '</button></div>';
    S.pad.innerHTML = h;
    // coach line
    var cl = '';
    if (S.coachMsg) cl = S.coachMsg;
    else if (coach === 'hint' && rd && rd.phase === 'play' && rd.seats[rd.cur.s].kind === 'human' && !betting()) cl = '<span class="tip">coach: <b>' + advice(t) + '</b></span>';
    S.coach.innerHTML = cl;
  }

  function syncHead() {
    if (!S) return;
    var b = S.head.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.classList.toggle('on', S.snd.on);
    b.title = S.snd.on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-label', b.title);
  }

  // ---- flow ----
  function later(fn, ms) { var id = setTimeout(function () { S && S.timers && (S.timers = S.timers.filter(function (x) { return x !== id; })); if (S) fn(); }, ms); S.timers.push(id); return id; }
  function clearTimers() { if (S) { S.timers.forEach(clearTimeout); S.timers = []; } }
  // after every change: draw, then (once the cards land) let the computer move / finish the round
  function step() {
    var T = render();
    S.busy = true;
    persist();
    later(function () { S.busy = false; pump(); }, T + 40);
  }
  function pump() {
    var t = S.t, rd = t.round;
    if (!rd) return;
    // the table waits while the panel is minimized (table-mates don't play on unseen)
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.busy = true; S.waitMin = true; return; }
    if (rd.phase === 'done') { if (!rd.tallied) finishRound(); return; }
    var seat = curSeat(t);
    if (seat && seat.kind === 'cpu') {
      S.busy = true;
      later(function () {
        S.busy = false;
        var mv = cpuMove(t, styleOf(seat));
        if (mv) act(t, mv);
        step();
      }, S.save.opts.speed === 'fast' ? 260 : 520);
      return;
    }
    // pass-and-play: say whose turn it is when the device should change hands
    if (seat && multiHumans() && S.lastTurn !== seat.w) { S.lastTurn = seat.w; banner(seat.name + ' — your turn'); }
  }
  function banner(text) {
    var b = document.createElement('div');
    b.className = 'bj-banner';
    b.innerHTML = '<span>' + esc(text) + '</span>';
    S.felt.appendChild(b);
    later(function () { if (b.parentNode) b.parentNode.removeChild(b); }, S.rm ? 900 : 1300);
  }

  function deal() {
    if (S.busy || !betting()) return;
    var plan = S.plan, spots = [], wallets = {}, i, any = false;
    for (i = 0; i < plan.length; i++) if (plan[i].kind === 'human' && S.bets[i] >= MIN_BET) any = true;
    if (!any) { nudge('Place a bet first'); return; }
    // computer table-mates bet a few chips each round
    for (i = 0; i < plan.length; i++) {
      var p = plan[i], b = S.bets[i];
      if (p.kind === 'cpu') {
        if (S.cpuBank[p.w] < 100) S.cpuBank[p.w] = START_BANK;
        b = CHIPS[Math.floor(Math.random() * 3)] * (1 + Math.floor(Math.random() * 3));
        b = Math.min(b, 100);
      }
      if (b >= MIN_BET) { spots.push({ pi: i, w: p.w, bet: b, kind: p.kind, name: p.name }); wallets[p.w] = bankOf(p.w); }
    }
    // remember the human bets (per spot) for the next deal
    var mode = S.save.opts.mode, hi = 0;
    for (i = 0; i < plan.length; i++) if (plan[i].kind === 'human') S.save.last[mode][hi++] = S.bets[i];
    var go = function () {
      var rd = startRound(S.t, spots, wallets);
      if (!rd) { nudge('Not enough chips'); render(); return; }
      S.holeShown = false; S.coachMsg = ''; S.lastMsg = ''; S.lastTurn = null;
      for (var w in rd.wallets) setBank(w, rd.wallets[w]);
      S.t.ev = [];
      step();
    };
    if (needShuffle(S.t)) {
      shuffle(S.t); S.t.ev = [];
      S.shuffling = true; S.busy = true;
      SFX.shuffle();
      render();
      S.felt.classList.add('shuf');
      later(function () { S.shuffling = false; S.felt.classList.remove('shuf'); S.busy = false; go(); }, S.rm ? 300 : 900);
    } else go();
  }

  function doAct(a) {
    if (S.busy || betting()) return;
    var t = S.t, rd = t.round, seat = curSeat(t);
    if (!seat || seat.kind !== 'human') return;
    var L = legal(t);
    if (!L[a]) { SFX.oops(); return; }
    S.snd.ensure();
    // the coach grades the move before it is made
    var coach = S.save.opts.coach, msg = '';
    if (coach !== 'off') {
      var st = S.save.stats, solo = seat.w === 'solo';
      if (rd.phase === 'insurance') {
        var good = insuranceAdvice(trueCount(t)) && S.save.opts.count !== 'off' ? 'insure' : 'decline';
        if (a === good) { if (solo) st.coachOk++; msg = '<span class="ok">✓ ' + (a === 'decline' ? 'Right — insurance is a losing side bet without a high count' : 'Good call at a true count of +' + trueCount(t)) + '</span>'; }
        else { if (solo) st.coachBad++; msg = '<span class="bad">✗ Coach: ' + (good === 'decline' ? 'skip insurance — it only pays off at a true count of +3 or more' : 'take insurance — the true count is +' + trueCount(t)) + '</span>'; SFX.oops(); }
      } else {
        var rec = advice(t), hd = curHand(t), desc = describe(hd.cards, rd.dealer.cards[0]);
        if (a === rec) { if (solo) st.coachOk++; msg = '<span class="ok">✓ ' + a.toUpperCase() + ' on ' + desc + '</span>'; }
        else { if (solo) st.coachBad++; msg = '<span class="bad">✗ Basic strategy: <b>' + rec.toUpperCase() + '</b> on ' + desc + ' (you chose ' + a + ')</span>'; SFX.oops(); }
      }
    }
    S.coachMsg = msg;
    act(t, a);
    if (a === 'split') SFX.chip();
    if (a === 'double' || a === 'insure') SFX.chip();
    for (var w in rd.wallets) setBank(w, rd.wallets[w]);
    var evs = t.ev; t.ev = [];
    if (evs.indexOf('bust') >= 0) later(function () { SFX.bust(0); }, 260);
    step();
  }

  function finishRound() {
    var t = S.t, rd = t.round, nets = tally(S.save, t);
    for (var w in rd.wallets) setBank(w, rd.wallets[w]);
    t.ev = [];
    // the headline: the humans' net result
    var parts = [], total = 0, anyBJ = false, anyWin = false, anyLose = false, humans = 0;
    rd.seats.forEach(function (st) {
      if (st.kind !== 'human') return;
      humans++;
      st.hands.forEach(function (hd) { if (hd.res === 'bj') anyBJ = true; if (hd.net > 0) anyWin = true; if (hd.net < 0) anyLose = true; });
    });
    var dv = handValue(rd.dealer.cards), dmsg = isNatural(rd.dealer.cards) ? 'Dealer has blackjack' : dv.total > 21 ? 'Dealer busts' : 'Dealer ' + dv.total;
    if (S.save.opts.mode === 'multi') {
      for (var k in nets) parts.push(seatName(k) + ' ' + (nets[k] ? signed(nets[k]) : 'even'));
      S.lastMsg = dmsg + ' — ' + parts.join(' · ');
    } else {
      total = nets.solo || 0;
      S.lastMsg = dmsg + ' — ' + (total > 0 ? 'you win ' + money(total) : total < 0 ? 'you lose ' + money(-total) : 'push');
    }
    if (S.save.opts.mode === 'multi') { var nv = Object.keys(nets).map(function (k) { return nets[k]; }); total = 0; S.lastCls = nv.every(function (x) { return x > 0; }) ? 'good' : nv.every(function (x) { return x < 0; }) ? 'bad' : ''; }
    else S.lastCls = anyBJ || total > 0 ? 'good' : total < 0 ? 'bad' : '';
    if (!humans) S.lastMsg = dmsg;
    // juice: sounds, floating chips, sparkles
    if (anyBJ) SFX.bj(0); else if (anyWin) SFX.win(0); else if (anyLose) SFX.lose(0); else SFX.push(0);
    if (anyBJ || total > 0) { try { Cade.haptic && Cade.haptic(anyBJ ? 18 : 8); } catch (e) {} }
    S.plan = null; S.bets = null;
    if (S.save.opts.mode === 'multi') S.sel = null;   // betting starts again with player 1
    initBets();
    persist();
    render();
    floaters();
    // count trainer: every few rounds, what's the running count?
    if (S.save.opts.count === 'quiz') {
      S.quizN = (S.quizN || 0) + 1;
      if (S.quizN >= QUIZ_EVERY) { S.quizN = 0; later(function () { if (betting() && !S.cardKind) showCard('quiz'); }, S.rm ? 300 : 1100); }
    }
  }
  function seatName(w) { return w === 'solo' ? 'You' : w.charAt(0) === 'p' ? 'P' + w.slice(1) : w; }
  function floaters() {
    var rd = S.t.round;
    if (!rd || S.rm) return;
    var seatEls = S.seats.querySelectorAll('.bj-seat'), fr = S.felt.getBoundingClientRect();
    rd.seats.forEach(function (st, i) {
      var el = seatEls[isNum(st.pi) ? st.pi : i];
      if (!el || !st.net) return;
      var r = el.getBoundingClientRect(), f = document.createElement('div');
      f.className = 'bj-float ' + (st.net > 0 ? 'up' : 'dn');
      f.textContent = signed(st.net);
      f.style.left = (r.left - fr.left + r.width / 2) + 'px';
      f.style.top = (r.top - fr.top + 10) + 'px';
      S.felt.appendChild(f);
      later(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1500);
      var bj = st.hands.some(function (h) { return h.res === 'bj'; });
      if (bj || st.net >= 100) sparkle(r.left - fr.left + r.width / 2, r.top - fr.top + r.height * 0.35, bj ? 18 : 10);
    });
  }
  function sparkle(x, y, n) {
    var glyphs = ['*', '+', '$', '♦︎', '·', '♠︎'];
    for (var i = 0; i < n; i++) {
      var sp = document.createElement('span'), a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 60;
      sp.className = 'bj-spark';
      sp.textContent = glyphs[i % glyphs.length];
      sp.style.left = x + 'px'; sp.style.top = y + 'px';
      S.felt.appendChild(sp);
      if (sp.animate) sp.animate([{ transform: 'translate(-50%,-50%) scale(0.6)', opacity: 1 }, { transform: 'translate(calc(-50% + ' + Math.cos(a) * d + 'px), calc(-50% + ' + (Math.sin(a) * d - 20) + 'px)) scale(1.1)', opacity: 0 }],
        { duration: 700 + Math.random() * 500, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
      (function (el) { later(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1300); })(sp);
    }
  }
  function nudge(text) {
    SFX.oops();
    S.pad.classList.remove('shake'); void S.pad.offsetWidth; S.pad.classList.add('shake');
    if (Cade.showToast) Cade.showToast(text, 'info', 1500);
  }

  // betting controls
  function addChip(c) {
    if (S.busy || !betting()) return;
    var p = S.plan[S.sel];
    if (!p || p.kind !== 'human') return;
    var avail = bankOf(p.w) - walletUsed(p.w, -1);
    if (c > avail + 1e-9) { nudge('Not enough chips'); return; }
    if (S.bets[S.sel] + c > MAX_BET) { nudge('Table limit is ' + money(MAX_BET)); return; }
    S.bets[S.sel] += c;
    S.snd.ensure(); SFX.chip();
    S.lastMsg = '';
    render();
    var spot = S.seats.querySelector('.bj-spot[data-seat="' + S.sel + '"]');
    if (spot && spot.animate && !S.rm) spot.animate([{ transform: 'scale(1.15)' }, { transform: 'none' }], { duration: 160 });
  }
  function betCmd(a) {
    if (S.busy || !betting()) return;
    var p = S.plan[S.sel];
    if (a === 'clear') { S.bets[S.sel] = 0; SFX.tick(); }
    else if (a === 'x2') {
      var avail = bankOf(p.w) - walletUsed(p.w, -1);
      if (S.bets[S.sel] && S.bets[S.sel] <= avail + 1e-9 && S.bets[S.sel] * 2 <= MAX_BET) { S.bets[S.sel] *= 2; SFX.chip(); }
      else { nudge('Not enough chips'); return; }
    } else if (a === 'rebuy') {
      setBank(p.w, round2(bankOf(p.w) + START_BANK));
      if (p.w === 'solo') S.save.stats.rebuys++;
      SFX.win(0);
      if (Cade.showToast) Cade.showToast('Rebought ' + money(START_BANK) + ' in chips', 'success', 1600);
      if (!S.bets[S.sel]) S.bets[S.sel] = 25;
      persist();
    }
    S.lastMsg = '';
    render();
  }
  function selectSeat(i) {
    if (!betting() || !S.plan[i] || S.plan[i].kind !== 'human' || S.sel === i) return;
    S.sel = i; SFX.tick(); S.lastMsg = ''; render();
  }
  function cycleSeat(dir) {
    var n = S.plan.length;
    for (var k = 1; k <= n; k++) { var i = (S.sel + dir * k + n * 3) % n; if (S.plan[i].kind === 'human') { selectSeat(i); return; } }
  }

  // ---- overlay cards ----
  function chipRow(key, val, opts, dis) {
    return '<div class="bj-chips2">' + opts.map(function (o) {
      return '<button class="bj-opt' + (o[0] === val ? ' on' : '') + '" data-k="' + key + '" data-v="' + o[0] + '"' + (dis && dis(o[0]) ? ' disabled' : '') + '>' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function statsHTML() {
    var s = S.save.stats, pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; };
    var rows = [
      ['Bank', money(S.save.banks.solo)], ['Peak bank', money(s.peak)], ['Net', '<span class="' + (s.net >= 0 ? 'g' : 'r') + '">' + signed(s.net) + '</span>'],
      ['Rounds', fmtInt(s.rounds)], ['Hands', fmtInt(s.hands)], ['Won / lost / push', s.wins + ' / ' + s.losses + ' / ' + s.pushes],
      ['Win rate', pct(s.wins, s.wins + s.losses)], ['Blackjacks', s.bjs], ['Busts', s.busts], ['Doubles won', s.dblWins + ' of ' + s.doubles],
      ['Splits', s.splits], ['Surrenders', s.surrenders], ['Insurance won', s.insWon + ' of ' + s.insTaken], ['Biggest win', money(s.biggest)],
      ['Win streak', s.streak + ' (best ' + s.bestStreak + ')'], ['Wagered', money(s.wagered)],
      ['Coach accuracy', pct(s.coachOk, s.coachOk + s.coachBad) + (s.coachOk + s.coachBad ? ' <i>(' + s.coachOk + '/' + (s.coachOk + s.coachBad) + ')</i>' : '')],
      ['Count quiz', pct(s.quizOk, s.quizN) + (s.quizN ? ' <i>(' + s.quizOk + '/' + s.quizN + ')</i>' : '')], ['Rebuys', s.rebuys]
    ];
    var h = '<div class="bj-tab two">' + rows.map(function (r) { return '<div><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('') + '</div>';
    var m = S.save.mstats, mp = [];
    ['p1', 'p2', 'p3'].forEach(function (k, i) { if (m[k].hands) mp.push('<div><span>Player ' + (i + 1) + '</span><b>' + money(S.save.banks[k]) + ' <i>' + m[k].hands + (m[k].hands === 1 ? ' hand, ' : ' hands, ') + signed(m[k].net) + '</i></b></div>'); });
    if (mp.length) h += '<div class="bj-h2">pass &amp; play</div><div class="bj-tab">' + mp.join('') + '</div>';
    h += '<div class="bj-foot">' + (S.resetArm ? '<span>Reset all banks and stats?</span><button class="bj-lnk danger" data-act="reset-yes">reset</button><button class="bj-lnk" data-act="reset-no">keep</button>' :
      '<span></span><button class="bj-lnk" data-act="reset">reset banks &amp; stats</button>') + '</div>';
    return h;
  }
  function showCard(kind) {
    S.cardKind = kind;
    var o = S.save.opts, R = S.save.rules, h = '', mid = !betting();
    if (kind === 'menu') {
      var tab = S.tab || 'table';
      h = '<div class="bj-card2"><div class="bj-title">BLACKJACK</div>' +
        '<div class="bj-big">' + (o.mode === 'multi' ? 'pass &amp; play' : money(S.save.banks.solo)) + '</div>' +
        '<div class="bj-tabs">' + [['table', 'Table'], ['rules', 'Rules'], ['stats', 'Stats']].map(function (x) {
          return '<button data-tab="' + x[0] + '" class="' + (tab === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
        }).join('') + '</div>';
      if (tab === 'table') {
        h += (mid ? '<p class="bj-note">Finish this hand to change the table.</p>' : '') +
          '<div class="bj-sec"><div class="bj-h2">players</div>' + chipRow('who', o.mode === 'solo' ? 'solo' : 'm' + o.players, [['solo', 'Solo'], ['m2', '2 players'], ['m3', '3 players']], function () { return mid; }) + '</div>';
        if (o.mode === 'solo') {
          h += '<div class="bj-sec"><div class="bj-h2">your spots</div>' + chipRow('spots', o.spots, [[1, '1 hand'], [2, '2 hands'], [3, '3 hands']], function () { return mid; }) + '</div>' +
            '<div class="bj-sec"><div class="bj-h2">computer table-mates</div>' + chipRow('mates', o.mates, [[0, 'none'], [1, 'Lou'], [2, 'Lou + Kit']], function (v) { return mid || v + o.spots > 3; }) +
            '<p class="bj-note">Lou plays by the book; Kit never risks a bust. More players at the table burn the shoe faster.</p></div>';
        } else {
          h += '<div class="bj-sec"><div class="bj-h2">banks</div><div class="bj-tab">';
          for (var i = 1; i <= o.players; i++) h += '<div><span>Player ' + i + '</span><b>' + money(S.save.banks['p' + i]) + '</b></div>';
          h += '</div><p class="bj-note">Pass the device around — each player bets and plays their own spot, with their own chip bank.</p></div>';
        }
      } else if (tab === 'rules') {
        h += (mid ? '<p class="bj-note">Finish this hand to change the shoe or dealer rules.</p>' : '') +
          '<div class="bj-sec"><div class="bj-h2">decks in the shoe</div>' + chipRow('decks', R.decks, [[1, '1'], [2, '2'], [6, '6'], [8, '8']], function () { return mid; }) + '</div>' +
          '<div class="bj-sec"><div class="bj-h2">dealer soft 17</div>' + chipRow('h17', R.h17 ? 1 : 0, [[0, 'stands (S17)'], [1, 'hits (H17)']], function () { return mid; }) + '</div>' +
          '<div class="bj-sec"><div class="bj-h2">late surrender</div>' + chipRow('surr', R.surr ? 1 : 0, [[1, 'allowed'], [0, 'off']], function () { return mid; }) + '</div>' +
          '<div class="bj-sec"><div class="bj-h2">strategy coach</div>' + chipRow('coach', o.coach, [['off', 'off'], ['flag', 'flag mistakes'], ['hint', 'show hints']]) + '</div>' +
          '<div class="bj-sec"><div class="bj-h2">hi-lo count trainer</div>' + chipRow('count', o.count, [['off', 'off'], ['show', 'show count'], ['quiz', 'quiz me']]) + '</div>' +
          '<div class="bj-sec"><div class="bj-h2">deal speed</div>' + chipRow('speed', o.speed, [['normal', 'normal'], ['fast', 'fast']]) + '</div>';
      } else h += statsHTML();
      h += '<div class="bj-btns"><button class="bj-go" data-act="play">' + (mid ? 'back to the hand' : 'play') + '</button></div></div>';
    } else if (kind === 'help') {
      h = '<div class="bj-card2"><div class="bj-title">HOW TO PLAY</div>' +
        '<p>Beat the dealer: get closer to <b>21</b> without going over. Cards 2–10 count their number, J Q K count 10, an ace counts 1 or 11 (a <b>soft</b> hand). An ace with a ten-card on the first two cards is <b>blackjack</b> and pays <b>3:2</b>.</p>' +
        '<p><b>Hit</b> takes a card, <b>stand</b> stops. <b>Double</b> doubles the bet for exactly one more card. <b>Split</b> a pair into two hands (re-split up to four; split aces get one card each). <b>Surrender</b> gives up half the bet on your first two cards.</p>' +
        '<p>When the dealer shows an ace you may buy <b>insurance</b> (half your bet, pays 2:1 if the dealer has blackjack). The dealer checks for blackjack, then draws to 17 — ' + (R.h17 ? 'and <b>hits</b> soft 17.' : 'and <b>stands</b> on soft 17.') + '</p>' +
        '<p>The <b>coach</b> knows the basic-strategy chart and flags plays that cost you money. The <b>count trainer</b> keeps a Hi-Lo count: 2–6 are +1, 7–9 are 0, tens and aces are −1; the true count divides it by the decks left.</p>' +
        '<div class="bj-keys"><div><b>H</b> hit · <b>S</b> stand · <b>D</b> double · <b>P</b> split · <b>R</b> surrender</div>' +
        '<div><b>1–4</b> chips · <b>⌫</b> clear · <b>← →</b> spot · <b>Enter</b> deal · <b>Y / N</b> insurance</div></div>' +
        '<p class="bj-note">Chips only — no real money. Broke? Rebuy for free.</p>' +
        '<div class="bj-btns"><button class="bj-go" data-act="close">got it</button></div></div>';
    } else if (kind === 'quiz') {
      var rc = S.t.rc, offs = [-3, -2, -1, 1, 2, 3].sort(function () { return Math.random() - 0.5; }).slice(0, 3), ch = offs.map(function (x) { return rc + x; }).concat([rc]);
      ch.sort(function (a, b) { return a - b; });
      S.quizAns = rc;
      h = '<div class="bj-card2"><div class="bj-title">COUNT CHECK</div><p class="bj-sub">What is the <b>running count</b> right now?</p>' +
        '<div class="bj-chips2 quiz">' + ch.map(function (v) { return '<button class="bj-opt" data-quiz="' + v + '">' + (v > 0 ? '+' : '') + v + '</button>'; }).join('') + '</div>' +
        '<p class="bj-note">' + Math.round(cardsLeft(S.t) / 52 * 10) / 10 + ' decks left in the shoe</p>' +
        '<div class="bj-btns"><button class="bj-go alt" data-act="close">skip</button></div></div>';
    }
    S.ovl.innerHTML = h;
    S.ovl.style.display = '';
    S.root.classList.add('dim');
    var c2 = S.ovl.querySelector('.bj-card2');
    S.root.style.minHeight = c2 ? (c2.offsetHeight + 16) + 'px' : '';
    var first = S.ovl.querySelector('.bj-go');
    if (first && !S.coarse) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }
  function hideCard() {
    S.cardKind = null; S.resetArm = false;
    S.ovl.style.display = 'none'; S.ovl.innerHTML = '';
    S.root.classList.remove('dim');
    S.root.style.minHeight = '';
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }
  function setOpt(k, v) {
    var o = S.save.opts, R = S.save.rules, mid = !betting(), tableChange = false;
    if (k === 'who') { if (mid) return; if (v === 'solo') o.mode = 'solo'; else { o.mode = 'multi'; o.players = v === 'm3' ? 3 : 2; } tableChange = true; }
    else if (k === 'spots') { if (mid) return; o.spots = +v; o.mates = Math.min(o.mates, 3 - o.spots); tableChange = true; }
    else if (k === 'mates') { if (mid) return; o.mates = Math.min(+v, 3 - o.spots); tableChange = true; }
    else if (k === 'decks' || k === 'h17' || k === 'surr') {
      if (mid) return;
      if (k === 'decks') R.decks = +v; else R[k] = v === '1';
      S.save.rules = normRules(R);
      if (k === 'decks') { S.t = newTable(S.save.rules, (Math.random() * 4294967295) >>> 0); S.maxId = 0; }
      else { S.t.rules = S.save.rules; }
    } else if (k === 'coach' || k === 'count' || k === 'speed') { o[k] = v; if (k === 'count') S.quizN = 0; }
    if (tableChange) { S.plan = null; S.bets = null; S.sel = null; S.lastMsg = ''; }
    SFX.tick();
    persist();
    if (tableChange || !S.plan) initBets();
    render();
    showCard('menu');
  }

  // ---- input ----
  var KEY_ACT = { KeyH: 'hit', KeyS: 'stand', KeyD: 'double', KeyP: 'split', KeyR: 'surrender', KeyY: 'insure', KeyN: 'decline' };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    // only while the panel has focus or nothing else does (keep the editor's typing)
    var ae = document.activeElement;
    if (ae && ae !== document.body && !S.panel.contains(ae)) return;
    var code = e.code || '';
    if (code === 'Escape') { e.preventDefault(); if (S.cardKind) hideCard(); else showCard('menu'); return; }
    if (S.cardKind) {
      if ((code === 'Enter' || code === 'Space') && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); hideCard(); }
      return;
    }
    if (e.repeat) return;
    var rd = S.t.round;
    if (betting()) {
      if (/^Digit[1-4]$/.test(code) || /^Numpad[1-4]$/.test(code)) { e.preventDefault(); addChip(CHIPS[+code.slice(-1) - 1]); }
      else if (code === 'Backspace' || code === 'Delete' || code === 'KeyC') { e.preventDefault(); betCmd('clear'); }
      else if (code === 'KeyX') { e.preventDefault(); betCmd('x2'); }
      else if (code === 'ArrowLeft' || code === 'ArrowRight') { e.preventDefault(); cycleSeat(code === 'ArrowLeft' ? -1 : 1); }
      else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
        e.preventDefault(); S.snd.ensure(); deal();
      }
      return;
    }
    if (rd && KEY_ACT[code]) { e.preventDefault(); doAct(KEY_ACT[code]); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    clearTimers();
    S = null;
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="bj" tabindex="-1"><div class="bj-felt"><div class="bj-top"></div><div class="bj-dealer"></div>' +
      '<div class="bj-arc">BLACKJACK PAYS 3 TO 2 · DEALER DRAWS TO 17</div><div class="bj-msg"></div><div class="bj-seats"></div></div><div class="bj-coach"></div><div class="bj-pad"></div>' +
      '<div class="bj-ovl" style="display:none"></div><div class="bj-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🃏 Blackjack', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'bj-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="menu" title="Table, rules &amp; stats" aria-label="Table, rules and stats">' + IC_MENU + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.bj'), felt: p.querySelector('.bj-felt'), top: p.querySelector('.bj-top'),
      dealer: p.querySelector('.bj-dealer'), msg: p.querySelector('.bj-msg'), seats: p.querySelector('.bj-seats'),
      coach: p.querySelector('.bj-coach'), pad: p.querySelector('.bj-pad'), ovl: p.querySelector('.bj-ovl'), live: p.querySelector('.bj-live'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'), timers: [], busy: false, maxId: 0, holeShown: false,
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      plan: null, bets: null, sel: null, cardKind: null, tab: 'table', coachMsg: '', lastMsg: '', lastCls: '',
      cpuBank: { cpu1: START_BANK, cpu2: START_BANK }, cpuStyleLbl: { cpu1: 'by the book', cpu2: 'never busts' }, quizN: 0
    };
    S.t = S.save.table || newTable(S.save.rules, (Math.random() * 4294967295) >>> 0);
    if (S.t.rules.decks !== S.save.rules.decks) S.t = newTable(S.save.rules, (Math.random() * 4294967295) >>> 0);
    S.t.rules = S.save.rules;
    // cards already on the table appear without flying in
    S.maxId = S.t.seq;
    if (S.t.round && S.t.round.dealer.up) S.holeShown = true;
    // a resumed round's computer seats need their wallets
    if (S.t.round) for (var w in S.t.round.wallets) if (w === 'cpu1' || w === 'cpu2') S.cpuBank[w] = S.t.round.wallets[w];
    p._onClose = teardown;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) render(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    p.addEventListener('cade-panel-restore', function () {
      if (S && S.panel === p) requestAnimationFrame(function () {
        if (!S) return;
        render();
        if (S.waitMin) { S.waitMin = false; S.busy = false; pump(); }
      });
    });

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'help') { if (S.cardKind === 'help') hideCard(); else showCard('help'); }
      else if (h === 'menu') { if (S.cardKind === 'menu') hideCard(); else { S.resetArm = false; showCard('menu'); } }
      try { b.blur(); } catch (er) {}
    });

    // fast taps must never zoom, select or open callouts
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (tp) { p.addEventListener(tp, noTouch, { passive: false }); });
    S.felt.addEventListener('touchend', function (e) { if (e.cancelable && !(e.target.closest && e.target.closest('button'))) e.preventDefault(); }, { passive: false });
    S.felt.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    S.felt.addEventListener('pointerdown', function (e) {
      if (!S) return;
      S.snd.ensure();
      var seatEl = e.target.closest ? e.target.closest('.bj-seat') : null;
      if (seatEl && betting()) selectSeat(+seatEl.getAttribute('data-seat'));
    });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var chip = b.getAttribute('data-chip'), a = b.getAttribute('data-a');
      if (chip) addChip(+chip);
      else if (a === 'deal') deal();
      else if (a === 'clear' || a === 'x2' || a === 'rebuy') betCmd(a);
      else if (a) doAct(a);
      try { if (S.coarse) b.blur(); } catch (er) {}
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) { if (e.target === S.ovl && S.cardKind !== 'quiz') hideCard(); return; }
      S.snd.ensure();
      var tab = b.getAttribute('data-tab'), k = b.getAttribute('data-k'), act2 = b.getAttribute('data-act'), qz = b.getAttribute('data-quiz');
      if (tab) { S.tab = tab; S.resetArm = false; SFX.tick(); showCard('menu'); }
      else if (k) { if (!b.disabled) setOpt(k, b.getAttribute('data-v')); }
      else if (qz != null) {
        var ok = +qz === S.quizAns;
        S.save.stats.quizN++; if (ok) S.save.stats.quizOk++;
        persist();
        if (ok) SFX.win(0); else SFX.oops();
        b.classList.add(ok ? 'right' : 'wrong');
        var rb = S.ovl.querySelector('[data-quiz="' + S.quizAns + '"]');
        if (rb) rb.classList.add('right');
        var note = S.ovl.querySelector('.bj-note');
        if (note) note.innerHTML = ok ? '✓ Spot on — true count ' + (trueCount(S.t) > 0 ? '+' : '') + trueCount(S.t).toFixed(1) : '✗ It was ' + (S.quizAns > 0 ? '+' : '') + S.quizAns + ' — true count ' + trueCount(S.t).toFixed(1);
        Array.prototype.forEach.call(S.ovl.querySelectorAll('[data-quiz]'), function (x) { x.disabled = true; });
        var go = S.ovl.querySelector('.bj-go'); if (go) go.textContent = 'continue';
      }
      else if (act2 === 'play' || act2 === 'close') hideCard();
      else if (act2 === 'reset') { S.resetArm = true; showCard('menu'); }
      else if (act2 === 'reset-no') { S.resetArm = false; showCard('menu'); }
      else if (act2 === 'reset-yes') {
        var keep = { opts: S.save.opts, rules: S.save.rules };
        S.save = newSave(); S.save.opts = keep.opts; S.save.rules = keep.rules;
        S.t = newTable(S.save.rules, (Math.random() * 4294967295) >>> 0); S.maxId = 0;
        S.plan = null; S.lastMsg = ''; S.resetArm = false;
        initBets(); persist(); render();
        if (Cade.showToast) Cade.showToast('Banks and stats reset', 'info', 1600);
        showCard('menu');
      }
    });

    try {
      S.themeObs = new MutationObserver(function () { if (S) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    initBets();
    render();
    if (S.t.round && !betting()) { S.busy = false; later(pump, 300); }
    else if (S.t.round && S.t.round.phase === 'done' && !S.t.round.tallied) later(pump, 100);
    if (ld.fresh) showCard('help');
    requestAnimationFrame(function () { if (S && S.panel === p) render(); });
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Hit, stand, double, split — with a basic-strategy coach and a chip bank',
    icon: '🃏',
    tags: 'game,cards,casino,blackjack,21,card counting,hi-lo,basic strategy,pass and play',
    open: open,
    _engine: ENGINE
  });
})();
