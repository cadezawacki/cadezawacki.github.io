/* Hearts — the classic four-handed trick-taking game, for Cade.txt.
 * Pass three cards (left, right, across, hold — the rotation repeats), the
 * two of clubs leads the first trick, follow suit when you can, no hearts on
 * a lead until they are broken, and (by default) no points on the first trick.
 * Every heart is a point, the queen of spades thirteen; take all 26 and you
 * shoot the moon — 26 to everyone else (or, by option, the shooter chooses
 * between that and minus 26). First to the target (100) ends the game; lowest
 * score wins, a tie for the lead plays on.
 * Three computer players at easy / normal / hard: they choose passes to void
 * short suits and shed the dangerous spades, duck and dump, "smoke out" the
 * queen, track who is void in what, count cards (hard), spot an opponent's
 * run at the moon and stop it, and now and then go for it themselves (hard).
 * Up to four humans can play pass-and-play on one device, with a privacy
 * screen before every human turn; empty seats are CPUs.
 * Monospace cards drawn with DOM, a trick that flies in from each seat and is
 * swept to the winner, a per-hand score table, records, sound (off by
 * default) and a save after every card, so the game resumes where it stopped.
 * Persists in Cade.store (cade-hearts-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Cards are 0..51: suit = c / 13 | 0 (0 clubs, 1 diamonds, 2 spades, 3 hearts),
  // rank = c % 13 (0 = deuce .. 12 = ace). Numeric order sorts a hand by suit then rank.
  // Seats run clockwise 0..3; play passes to (p + 1) % 4 ("left").
  var RANKS = '23456789TJQKA';
  var GLYPH = ['♣', '♦', '♠', '♥'];
  var SUIT_NAME = ['clubs', 'diamonds', 'spades', 'hearts'];
  var RANK_NAME = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
  var CLUBS = 0, SPADES = 2, HEARTS = 3;
  var TWO_C = 0, QS = 2 * 13 + 10, KS = QS + 1, AS = QS + 2;
  var PASS_DIRS = [
    { id: 'left', off: 1, arrow: '←', name: 'left' },
    { id: 'right', off: 3, arrow: '→', name: 'right' },
    { id: 'across', off: 2, arrow: '↑', name: 'across' },
    { id: 'hold', off: 0, arrow: '·', name: 'hold' }
  ];
  // CPU levels. noise: chance of a random legal card; count: remembers every card played;
  // voids: tracks who is out of what; guard: points an opponent must hold (all of them)
  // before the CPU starts blocking a moon; shoot: tries the moon itself; keepQ: low spades
  // needed to keep the queen instead of passing it.
  var DIFFS = {
    easy: { name: 'Easy', noise: 0.38, count: false, voids: false, guard: 99, shoot: false, keepQ: 9 },
    normal: { name: 'Normal', noise: 0.04, count: false, voids: true, guard: 15, shoot: false, keepQ: 4 },
    hard: { name: 'Hard', noise: 0, count: true, voids: true, guard: 7, shoot: true, keepQ: 3 }
  };
  var DIFF_IDS = ['easy', 'normal', 'hard'];
  var TARGETS = [50, 75, 100, 150];
  var CPU_NAMES = ['South', 'West', 'North', 'East'];

  function suitOf(c) { return (c / 13) | 0; }
  function rankOf(c) { return c % 13; }
  function cardPts(c) { return c === QS ? 13 : suitOf(c) === HEARTS ? 1 : 0; }
  function handPts(cards) { var t = 0; for (var i = 0; i < cards.length; i++) t += cardPts(cards[i]); return t; }
  function num(a, b) { return a - b; }
  function cardStr(c) { return (rankOf(c) === 8 ? '10' : RANKS.charAt(rankOf(c))) + GLYPH[suitOf(c)]; }
  function cardName(c) { return RANK_NAME[rankOf(c)] + ' of ' + SUIT_NAME[suitOf(c)]; }

  // mulberry32 on g.rs: the deal and every CPU choice are reproducible from the seed.
  function rnd(g) {
    g.rs = (g.rs + 0x6D2B79F5) | 0;
    var t = Math.imul(g.rs ^ (g.rs >>> 15), 1 | g.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function defaultCfg() {
    return {
      seats: [{ kind: 'human', name: 'You' }, { kind: 'cpu', diff: 'normal' }, { kind: 'cpu', diff: 'normal' }, { kind: 'cpu', diff: 'normal' }],
      target: 100, moon: 'add', bleed: false
    };
  }
  function cleanName(s, i) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
    return s || (i === 0 ? 'You' : 'Player ' + (i + 1));
  }
  function normCfg(o) {
    var d = defaultCfg();
    if (!o || typeof o !== 'object') return d;
    var c = {
      target: TARGETS.indexOf(+o.target) >= 0 ? +o.target : 100,
      moon: o.moon === 'choose' ? 'choose' : 'add',
      bleed: !!o.bleed, seats: []
    };
    for (var i = 0; i < 4; i++) {
      var s = Array.isArray(o.seats) ? o.seats[i] : null;
      if (s && s.kind === 'human') c.seats.push({ kind: 'human', name: cleanName(s.name, i) });
      else if (s && s.kind === 'cpu') c.seats.push({ kind: 'cpu', diff: DIFFS[s.diff] ? s.diff : 'normal' });
      else c.seats.push(d.seats[i]);
    }
    return c;
  }
  function seatName(s, i) { return s.kind === 'human' ? cleanName(s.name, i) : CPU_NAMES[i]; }

  function newGame(cfg, seed) {
    cfg = normCfg(cfg);
    var g = {
      v: 1, seats: cfg.seats.map(function (s, i) { return s.kind === 'human' ? { kind: 'human', name: s.name } : { kind: 'cpu', diff: s.diff, name: CPU_NAMES[i] }; }),
      target: cfg.target, moon: cfg.moon, bleed: cfg.bleed, rs: seed | 0,
      scores: [0, 0, 0, 0], hist: [], handNo: 0, dir: 0, phase: 'pass', winners: [], tie: false
    };
    deal(g);
    return g;
  }
  function blank4() { return [null, null, null, null]; }
  function deal(g) {
    var d = [], i, j, t;
    for (i = 0; i < 52; i++) d.push(i);
    for (i = 51; i > 0; i--) { j = Math.floor(rnd(g) * (i + 1)); t = d[i]; d[i] = d[j]; d[j] = t; }
    g.hands = [0, 1, 2, 3].map(function (p) { return d.slice(p * 13, p * 13 + 13).sort(num); });
    g.taken = [[], [], [], []];
    g.pass = blank4(); g.recv = blank4(); g.sent = blank4();
    g.trick = []; g.trickNo = 0; g.broken = false; g.played = [];
    g.voids = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    g.last = null; g.raw = null; g.shooter = -1; g.moonTry = [0, 0, 0, 0];
    g.dir = g.handNo % 4; g.ev = [];
    if (PASS_DIRS[g.dir].off === 0) startPlay(g);
    else { g.phase = 'pass'; g.turn = -1; g.leader = -1; }
  }
  function startPlay(g) {
    g.phase = 'play';
    for (var p = 0; p < 4; p++) if (g.hands[p].indexOf(TWO_C) >= 0) g.leader = p;
    g.turn = g.leader; g.trick = [];
  }
  function passTarget(g, p) { return (p + PASS_DIRS[g.dir].off) % 4; }

  function setPass(g, p, cards) {
    if (g.phase !== 'pass' || !Array.isArray(cards) || cards.length !== 3) return false;
    var h = g.hands[p], seen = {};
    for (var i = 0; i < 3; i++) { var c = cards[i]; if (h.indexOf(c) < 0 || seen[c]) return false; seen[c] = 1; }
    g.pass[p] = cards.slice().sort(num);
    if (g.pass.every(function (x) { return x; })) doPass(g);
    return true;
  }
  function doPass(g) {
    var p, out = g.pass.slice();
    for (p = 0; p < 4; p++) g.hands[p] = g.hands[p].filter(function (c) { return out[p].indexOf(c) < 0; });
    for (p = 0; p < 4; p++) {
      var to = passTarget(g, p);
      g.hands[to] = g.hands[to].concat(out[p]).sort(num);
      g.recv[to] = out[p].slice();
      g.sent[p] = { to: to, cards: out[p].slice() };
    }
    g.pass = blank4();
    if (g.ev) g.ev.push({ t: 'passed' });
    startPlay(g);
  }

  // The cards seat p may play now.
  function legal(g, p) {
    if (g.phase !== 'play' || p !== g.turn) return [];
    var h = g.hands[p], out;
    if (!h.length) return [];
    if (!g.trick.length) {
      if (g.trickNo === 0 && h.indexOf(TWO_C) >= 0) return [TWO_C];
      if (!g.broken) { out = h.filter(function (c) { return suitOf(c) !== HEARTS; }); if (out.length) return out; }
      return h.slice();
    }
    var ls = suitOf(g.trick[0].c);
    out = h.filter(function (c) { return suitOf(c) === ls; });
    if (out.length) return out;
    if (g.trickNo === 0 && !g.bleed) {
      out = h.filter(function (c) { return cardPts(c) === 0; });
      if (out.length) return out;
      out = h.filter(function (c) { return c !== QS; });   // only points left: a heart, not the queen
      if (out.length) return out;
    }
    return h.slice();
  }
  function trickWinner(trick) {
    var ls = suitOf(trick[0].c), w = trick[0];
    for (var i = 1; i < trick.length; i++) if (suitOf(trick[i].c) === ls && trick[i].c > w.c) w = trick[i];
    return w;
  }
  function play(g, p, c) {
    if (legal(g, p).indexOf(c) < 0) return false;
    var h = g.hands[p];
    h.splice(h.indexOf(c), 1);
    if (g.trick.length) { var ls = suitOf(g.trick[0].c); if (suitOf(c) !== ls) g.voids[p][ls] = 1; }
    g.trick.push({ p: p, c: c });
    g.played.push(c);
    g.ev.push({ t: 'play', p: p, c: c });
    if (suitOf(c) === HEARTS && !g.broken) { g.broken = true; g.ev.push({ t: 'broken', p: p }); }
    if (c === QS) g.ev.push({ t: 'queen', p: p });
    if (g.trick.length < 4) { g.turn = (p + 1) % 4; return true; }
    var w = trickWinner(g.trick), cards = g.trick.map(function (t) { return t.c; }), pts = handPts(cards);
    g.taken[w.p] = g.taken[w.p].concat(cards);
    g.last = { trick: g.trick.slice(), w: w.p, pts: pts, n: g.trickNo };
    g.trick = []; g.trickNo++; g.turn = w.p; g.leader = w.p;
    g.ev.push({ t: 'trick', w: w.p, pts: pts, q: cards.indexOf(QS) >= 0 });
    if (g.trickNo === 13) endHand(g);
    return true;
  }
  function endHand(g) {
    g.raw = g.taken.map(handPts);
    g.shooter = g.raw.indexOf(26);
    g.turn = -1;
    if (g.shooter >= 0) {
      g.ev.push({ t: 'moon', p: g.shooter });
      if (g.moon === 'choose') { g.phase = 'moon'; g.turn = g.shooter; return; }
    }
    scoreHand(g, 'add');
  }
  function moonDelta(sh, choice) { return [0, 1, 2, 3].map(function (p) { return choice === 'sub' ? (p === sh ? -26 : 0) : (p === sh ? 0 : 26); }); }
  function scoreHand(g, choice) {
    var sh = g.shooter, d = sh >= 0 ? moonDelta(sh, choice) : g.raw.slice(), qp = -1;
    for (var p = 0; p < 4; p++) { g.scores[p] += d[p]; if (g.taken[p].indexOf(QS) >= 0) qp = p; }
    g.hist.push({ raw: g.raw.slice(), d: d, sh: sh, dir: g.dir, q: qp, sub: sh >= 0 && choice === 'sub' ? 1 : 0 });
    g.ev.push({ t: 'hand' });
    var hi = Math.max.apply(null, g.scores), lo = Math.min.apply(null, g.scores);
    g.tie = false;
    if (hi >= g.target) {
      var w = [0, 1, 2, 3].filter(function (q) { return g.scores[q] === lo; });
      if (w.length === 1) { g.phase = 'over'; g.winners = w; g.ev.push({ t: 'over', w: w[0] }); return; }
      g.tie = true;
    }
    g.phase = 'scored';
  }
  function moonChoice(g, choice) {
    if (g.phase !== 'moon') return false;
    scoreHand(g, choice === 'sub' ? 'sub' : 'add');
    return true;
  }
  function nextHand(g) {
    if (g.phase !== 'scored') return false;
    g.handNo++;
    deal(g);
    return true;
  }
  function takenPts(g) { return g.taken.map(handPts); }

  // ---- the computer players ----
  function diffOf(g, p) { return DIFFS[(g.seats[p] && g.seats[p].diff) || 'normal'] || DIFFS.normal; }
  // Cards seat p cannot see: not in its hand, not played (the counting CPU), or — for a
  // CPU that does not count — every card not in its hand nor on the table right now.
  function outSet(g, p, D) {
    var gone = {}, i;
    g.hands[p].forEach(function (c) { gone[c] = 1; });
    if (D.count) g.played.forEach(function (c) { gone[c] = 1; });
    else for (i = 0; i < g.trick.length; i++) gone[g.trick[i].c] = 1;
    return gone;
  }
  function higherOut(gone, c) { var n = 0, s = suitOf(c) * 13; for (var x = c + 1; x < s + 13; x++) if (!gone[x]) n++; return n; }
  function lowerOut(gone, c) { var n = 0, s = suitOf(c) * 13; for (var x = s; x < c; x++) if (!gone[x]) n++; return n; }
  function moonHand(h) {
    var hearts = h.filter(function (c) { return suitOf(c) === HEARTS; }), high = h.filter(function (c) { return rankOf(c) >= 10; }).length;
    var topH = hearts.filter(function (c) { return rankOf(c) >= 10; }).length;
    return hearts.length >= 5 && topH >= 3 && high >= 8;
  }
  function aiPass(g, p) {
    var D = diffOf(g, p), h = g.hands[p].slice(), cnt = [0, 0, 0, 0];
    if (D.noise > 0.2) {
      return h.map(function (c) { return { c: c, s: rankOf(c) + (c === QS ? 4 : 0) + rnd(g) * 6 }; })
        .sort(function (a, b) { return b.s - a.s; }).slice(0, 3).map(function (x) { return x.c; }).sort(num);
    }
    if (D.shoot && moonHand(h)) {
      g.moonTry[p] = 1;
      return h.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || (suitOf(a) === HEARTS) - (suitOf(b) === HEARTS); }).slice(0, 3).sort(num);
    }
    h.forEach(function (c) { cnt[suitOf(c)]++; });
    var hasQ = h.indexOf(QS) >= 0, lowSp = h.filter(function (c) { return suitOf(c) === SPADES && c < QS; }).length;
    var keepQ = hasQ && lowSp >= D.keepQ;
    // the shortest minor suit is the one worth voiding
    var shortS = -1;
    [0, 1].forEach(function (s) { if (cnt[s] > 0 && cnt[s] <= 3 && (shortS < 0 || cnt[s] < cnt[shortS])) shortS = s; });
    var scored = h.map(function (c) {
      var su = suitOf(c), rk = rankOf(c), s = rk;
      if (c === QS) s = keepQ ? -3 : 40;
      else if (c === KS || c === AS) s = keepQ ? rk : (hasQ ? 30 : (lowSp >= 3 ? 5 + rk / 4 : 24 + rk / 4));
      else if (su === SPADES) s = rk - 12;              // low spades guard the queen: keep them
      else if (su === HEARTS) s = rk >= 9 ? rk + 4 : rk - 5;
      else if (su === shortS) s = rk + 7;
      if (c === TWO_C) s = -6;
      return { c: c, s: s + rnd(g) * 0.5 };
    });
    return scored.sort(function (a, b) { return b.s - a.s; }).slice(0, 3).map(function (x) { return x.c; }).sort(num);
  }
  function lowest(L) { return L.reduce(function (a, c) { return rankOf(c) < rankOf(a) ? c : a; }, L[0]); }
  function highest(L) { return L.reduce(function (a, c) { return rankOf(c) > rankOf(a) ? c : a; }, L[0]); }
  function noQ(L) { var o = L.filter(function (c) { return c !== QS; }); return o.length ? o : L; }
  function aiPlay(g, p) {
    var L = legal(g, p);
    if (L.length <= 1) return L[0];
    var D = diffOf(g, p);
    if (D.noise && rnd(g) < D.noise) return L[Math.floor(rnd(g) * L.length)];
    var h = g.hands[p], gone = outSet(g, p, D), tp = takenPts(g), tot = tp[0] + tp[1] + tp[2] + tp[3];
    var cnt = [0, 0, 0, 0]; h.forEach(function (c) { cnt[suitOf(c)]++; });
    var hasQ = h.indexOf(QS) >= 0, qOut = !hasQ && g.played.indexOf(QS) < 0;
    var trick = g.trick, trickPts = handPts(trick.map(function (t) { return t.c; }));
    // somebody else is running at the moon: everything taken so far is theirs
    var threat = -1;
    for (var q = 0; q < 4; q++) if (q !== p && tot >= D.guard && tp[q] === tot) threat = q;
    // ...or we are: hard CPUs with all the points so far and a hand full of winners
    var boss = h.filter(function (c) { return higherOut(gone, c) === 0; }).length;
    var myMoon = D.shoot && tp[p] === tot && (g.moonTry[p] || (tot >= 14 && boss >= h.length - 1)) && (tot > 0 || g.moonTry[p]);
    if (!trick.length) return aiLead(g, p, L, D, gone, cnt, hasQ, qOut, myMoon, threat);
    var ls = suitOf(trick[0].c), win = trickWinner(trick), last = trick.length === 3;
    var follow = suitOf(L[0]) === ls;
    if (follow) {
      var ducks = L.filter(function (c) { return c < win.c; }), overs = L.filter(function (c) { return c > win.c; });
      if (myMoon) return overs.length ? highest(overs) : lowest(L);
      if (threat >= 0 && win.p === threat && (trickPts > 0 || ls === HEARTS || (last && trickPts > 0)) && overs.length) {
        return lowest(noQ(overs));                        // take a point off the moon runner
      }
      if (ls === SPADES && L.indexOf(QS) >= 0 && win.c > QS) return QS;
      if (ducks.length) {
        if (last && trickPts === 0 && ls !== HEARTS && overs.length) {
          var free = noQ(overs);
          if (free[0] !== QS) return highest(free);       // a pointless trick: win it with a high card
        }
        var d2 = ducks;
        if (ls === SPADES && qOut && !last) d2 = ducks;   // under the K/A: fine
        return highest(d2);
      }
      // every card we hold wins for now
      if (last) return highest(noQ(L));
      if (trickPts === 0 && ls !== HEARTS) {
        if (ls === SPADES && qOut) return lowest(noQ(L));
        var voidSeen = false;
        for (var k = 1; k < 4; k++) { var s = (p + k) % 4; if (!trick.some(function (t) { return t.p === s; }) && D.voids && g.voids[s][ls]) voidSeen = true; }
        var roundOf = g.played.filter(function (c) { return suitOf(c) === ls; }).length - trick.length;
        if (!voidSeen && roundOf < 4) return highest(noQ(L));
      }
      return lowest(noQ(L));
    }
    // void in the suit led: discard
    if (myMoon) {
      var keep = L.filter(function (c) { return suitOf(c) !== HEARTS && c !== QS; });
      return lowest(keep.length ? keep : L);
    }
    var feedThreat = threat >= 0 && win.p === threat;
    var best = null, bs = -1e9;
    L.forEach(function (c) {
      var su = suitOf(c), rk = rankOf(c), s;
      if (c === QS) s = 100;
      else if ((c === AS || c === KS) && qOut) s = 50 + rk;
      else if (su === HEARTS) s = (rk >= 4 ? 20 : 12) + rk;
      else s = rk + (cnt[su] <= 2 ? 4 : 0) + (D.count && higherOut(gone, c) === 0 ? 2 : 0);
      if (feedThreat && cardPts(c) > 0) s -= 200;
      if (!feedThreat && threat >= 0 && cardPts(c) > 0) s += 30;   // points to anyone but the runner
      if (s > bs) { bs = s; best = c; }
    });
    return best;
  }
  function aiLead(g, p, L, D, gone, cnt, hasQ, qOut, myMoon, threat) {
    if (myMoon) {
      var bosses = L.filter(function (c) { return higherOut(gone, c) === 0; });
      return bosses.length ? highest(bosses) : highest(L);
    }
    var best = null, bs = 1e9;
    L.forEach(function (c) {
      var su = suitOf(c), rk = rankOf(c), hi = higherOut(gone, c), lo = lowerOut(gone, c);
      var pWin = hi === 0 ? 1 : (lo === 0 ? 0.02 : Math.min(0.9, lo / (lo + hi)) * 0.6);
      var cost = su === HEARTS ? 3.5 : 0.6;
      if (su === SPADES && qOut && (c === KS || c === AS)) cost += 13 * 0.85;
      if (c === QS) cost += 13;
      if (su === SPADES && qOut && c < QS) cost -= 1.2;           // smoke the queen out
      if (su === SPADES && hasQ && c !== QS) cost += 1.5;
      if (D.voids) {
        for (var k = 1; k < 4; k++) if (g.voids[(p + k) % 4][su]) cost += su === HEARTS ? 1 : (qOut || hasQ ? 7 : 3);
      }
      if (threat >= 0 && su === HEARTS) cost -= 2;               // hearts lead to spread the points
      var score = pWin * cost + cnt[su] * 0.04 + rk * 0.01;
      if (score < bs) { bs = score; best = c; }
    });
    return best;
  }
  // The shooter's best choice when the rule lets them pick (+26 to the others or -26 to self).
  function aiMoon(g, p) {
    function eval_(choice) {
      var d = moonDelta(p, choice), s = g.scores.map(function (x, i) { return x + d[i]; });
      var mine = s[p], others = s.filter(function (x, i) { return i !== p; });
      var ends = Math.max.apply(null, s) >= g.target, lowO = Math.min.apply(null, others);
      if (ends) return mine < lowO ? 1000 : -1000;
      return lowO - mine;
    }
    return eval_('add') >= eval_('sub') ? 'add' : 'sub';
  }

  // ---- saves ----
  function isCard(c) { return typeof c === 'number' && c >= 0 && c < 52 && c === Math.floor(c); }
  function int(x, d) { x = Math.round(+x); return isFinite(x) ? x : d; }
  function cardList(a, max) {
    if (!Array.isArray(a) || a.length > max) return null;
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) { if (!isCard(a[i]) || seen[a[i]]) return null; seen[a[i]] = 1; out.push(a[i]); }
    return out;
  }
  function normGame(o) {
    try {
      if (!o || typeof o !== 'object' || !Array.isArray(o.seats) || o.seats.length !== 4) return null;
      var PH = ['pass', 'play', 'moon', 'scored', 'over'];
      if (PH.indexOf(o.phase) < 0) return null;
      var g = {
        v: 1, seats: o.seats.map(function (s, i) {
          return s && s.kind === 'human' ? { kind: 'human', name: cleanName(s.name, i) } : { kind: 'cpu', diff: s && DIFFS[s.diff] ? s.diff : 'normal', name: CPU_NAMES[i] };
        }),
        target: TARGETS.indexOf(+o.target) >= 0 ? +o.target : 100, moon: o.moon === 'choose' ? 'choose' : 'add', bleed: !!o.bleed,
        rs: int(o.rs, 1) | 0, scores: [0, 1, 2, 3].map(function (i) { return int(o.scores && o.scores[i], 0); }),
        handNo: Math.max(0, int(o.handNo, 0)), phase: o.phase, tie: !!o.tie, ev: [], rh: o.rh == null ? null : Math.max(0, int(o.rh, 0))
      };
      if (!g.seats.some(function (s) { return s.kind === 'human'; })) return null;
      g.dir = g.handNo % 4;
      g.hist = (Array.isArray(o.hist) ? o.hist : []).slice(-200).filter(function (x) { return x && Array.isArray(x.d) && x.d.length === 4; }).map(function (x) {
        return { raw: [0, 1, 2, 3].map(function (i) { return int(x.raw && x.raw[i], 0); }), d: x.d.map(function (v) { return int(v, 0); }), sh: int(x.sh, -1), dir: int(x.dir, 0) & 3, q: int(x.q, -1), sub: x.sub ? 1 : 0 };
      });
      g.hands = []; g.taken = [];
      var all = {}, n = 0;
      for (var p = 0; p < 4; p++) {
        var h = cardList(o.hands && o.hands[p], 13), t = cardList(o.taken && o.taken[p], 52);
        if (!h || !t) return null;
        g.hands.push(h.sort(num)); g.taken.push(t);
        h.concat(t).forEach(function (c) { if (!all[c]) { all[c] = 1; n++; } else n = -999; });
      }
      var tr = Array.isArray(o.trick) ? o.trick : [];
      if (tr.length > 3) return null;
      g.trick = [];
      for (var i = 0; i < tr.length; i++) {
        if (!tr[i] || !isCard(tr[i].c) || all[tr[i].c]) return null;
        all[tr[i].c] = 1; n++;
        g.trick.push({ p: int(tr[i].p, 0) & 3, c: tr[i].c });
      }
      if (n !== 52) return null;
      g.played = cardList(o.played, 52) || [];
      g.trickNo = Math.max(0, Math.min(13, int(o.trickNo, 0)));
      g.broken = !!o.broken;
      g.turn = int(o.turn, -1); g.leader = int(o.leader, -1);
      g.voids = [0, 1, 2, 3].map(function (p) { return [0, 1, 2, 3].map(function (s) { return o.voids && o.voids[p] && o.voids[p][s] ? 1 : 0; }); });
      g.pass = [0, 1, 2, 3].map(function (p) { var x = cardList(o.pass && o.pass[p], 3); return x && x.length === 3 && x.every(function (c) { return g.hands[p].indexOf(c) >= 0; }) ? x : null; });
      g.recv = [0, 1, 2, 3].map(function (p) { var x = cardList(o.recv && o.recv[p], 3); return x && x.length === 3 ? x : null; });
      g.sent = [0, 1, 2, 3].map(function (p) { var x = o.sent && o.sent[p]; var cl = x && cardList(x.cards, 3); return cl && cl.length === 3 ? { to: int(x.to, 0) & 3, cards: cl } : null; });
      g.moonTry = [0, 1, 2, 3].map(function (p) { return o.moonTry && o.moonTry[p] ? 1 : 0; });
      g.last = null;
      if (o.last && Array.isArray(o.last.trick) && o.last.trick.length === 4) {
        var lt = o.last.trick.map(function (t) { return { p: int(t && t.p, 0) & 3, c: t && isCard(t.c) ? t.c : 0 }; });
        g.last = { trick: lt, w: int(o.last.w, 0) & 3, pts: int(o.last.pts, 0), n: int(o.last.n, 0) };
      }
      g.raw = Array.isArray(o.raw) && o.raw.length === 4 ? o.raw.map(function (v) { return int(v, 0); }) : null;
      g.shooter = int(o.shooter, -1);
      g.winners = Array.isArray(o.winners) ? o.winners.map(function (v) { return int(v, 0) & 3; }) : [];
      // consistency per phase
      var sizes = g.hands.map(function (h) { return h.length; });
      if (g.phase === 'pass') {
        if (g.trickNo || g.trick.length || PASS_DIRS[g.dir].off === 0 || sizes.some(function (s) { return s !== 13; })) return null;
        g.turn = -1;
      } else if (g.phase === 'play') {
        if (g.turn < 0 || g.turn > 3 || g.trickNo > 12) return null;
        var lead = g.trick.length ? g.trick[0].p : g.turn;
        for (i = 0; i < g.trick.length; i++) if (g.trick[i].p !== (lead + i) % 4) return null;
        if ((lead + g.trick.length) % 4 !== g.turn) return null;
        for (p = 0; p < 4; p++) {
          var played = g.trick.some(function (t) { return t.p === p; }) ? 1 : 0;
          if (sizes[p] !== 13 - g.trickNo - played) return null;
        }
        if (!g.hands[g.turn].length) return null;
        g.leader = lead;
      } else if (g.phase === 'moon' || g.phase === 'scored' || g.phase === 'over') {
        if (sizes.some(function (s) { return s; })) return null;
        g.raw = g.taken.map(handPts);
        g.shooter = g.raw.indexOf(26);
        if (g.phase === 'moon' && (g.shooter < 0 || g.moon !== 'choose')) return null;
        if (g.phase === 'moon') g.turn = g.shooter;
        if (g.phase === 'over' && !g.winners.length) return null;
      }
      return g;
    } catch (e) { return null; }
  }

  function newRec() {
    return { games: 0, wins: 0, hands: 0, pts: 0, moons: 0, queens: 0, clean: 0, best: null, streak: 0, bestStreak: 0, mp: 0, lastWin: 0 };
  }
  function normRec(o) {
    var r = newRec();
    if (!o || typeof o !== 'object') return r;
    Object.keys(r).forEach(function (k) {
      if (k === 'best') { var b = Math.round(+o.best); r.best = o.best != null && isFinite(b) ? b : null; return; }
      var v = Math.round(+o[k]); r[k] = isFinite(v) && v > 0 ? v : 0;
    });
    if (r.wins > r.games) r.wins = r.games;
    return r;
  }

  // CPU-only simulation (tests / balance): plays whole games, all seats by the AI.
  function simulate(cfg, seed, maxHands) {
    var g = newGame(cfg, seed), hands = 0;
    g.seats.forEach(function (s, i) { if (s.kind === 'human') g.seats[i] = { kind: 'cpu', diff: 'normal', name: CPU_NAMES[i] }; });
    if (cfg && cfg.diffs) g.seats.forEach(function (s, i) { s.diff = cfg.diffs[i]; });
    while (g.phase !== 'over' && hands < (maxHands || 500)) {
      if (g.phase === 'pass') { for (var p = 0; p < 4; p++) if (!g.pass[p]) setPass(g, p, aiPass(g, p)); }
      else if (g.phase === 'play') { if (!play(g, g.turn, aiPlay(g, g.turn))) throw new Error('AI played an illegal card'); }
      else if (g.phase === 'moon') moonChoice(g, aiMoon(g, g.shooter));
      else if (g.phase === 'scored') { hands++; nextHand(g); }
      g.ev.length = 0;
    }
    return g;
  }

  var ENGINE = {
    RANKS: RANKS, GLYPH: GLYPH, SUIT_NAME: SUIT_NAME, PASS_DIRS: PASS_DIRS, DIFFS: DIFFS, DIFF_IDS: DIFF_IDS, TARGETS: TARGETS,
    TWO_C: TWO_C, QS: QS, KS: KS, AS: AS, CPU_NAMES: CPU_NAMES,
    suitOf: suitOf, rankOf: rankOf, cardPts: cardPts, handPts: handPts, cardStr: cardStr, cardName: cardName,
    defaultCfg: defaultCfg, normCfg: normCfg, seatName: seatName, newGame: newGame, deal: deal, passTarget: passTarget,
    setPass: setPass, legal: legal, play: play, trickWinner: trickWinner, moonChoice: moonChoice, nextHand: nextHand, takenPts: takenPts,
    aiPass: aiPass, aiPlay: aiPlay, aiMoon: aiMoon, moonHand: moonHand, normGame: normGame, newRec: newRec, normRec: normRec, simulate: simulate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= widget (DOM) =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('hearts.css');

  var PANEL_ID = 'hearts-panel', NAME = 'Hearts';
  var KEY = 'cade-hearts-', GAME_KEY = KEY + 'game', CFG_KEY = KEY + 'cfg', REC_KEY = KEY + 'rec', SOUND_KEY = KEY + 'sound', PREF_KEY = KEY + 'prefs';
  var PACE = {
    relaxed: { name: 'Relaxed', cpu: 720, hold: 1150, sweep: 420 },
    brisk: { name: 'Brisk', cpu: 380, hold: 720, sweep: 320 },
    fast: { name: 'Fast', cpu: 170, hold: 420, sweep: 240 }
  };
  var POS = ['b', 'l', 't', 'r'];
  var S = null;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function jget(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function normPrefs(o) {
    o = o && typeof o === 'object' ? o : {};
    return { pace: PACE[o.pace] ? o.pace : 'relaxed', confirm: !!o.confirm };
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
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
    card: function (s) { s.tone(1700, 0.03, 'triangle', 0.03, 1100); },
    pick: function (s) { s.tone(1250, 0.03, 'sine', 0.03); },
    trick: function (s, pts) { s.tone(520, 0.06, 'triangle', 0.03, 380); if (pts) s.tone(300, 0.12, 'sine', 0.035, 220, 0.06); },
    broken: function (s) { s.tone(660, 0.1, 'sine', 0.04, 990); s.tone(990, 0.16, 'sine', 0.035, 0, 0.09); },
    queen: function (s) { s.tone(196, 0.32, 'sawtooth', 0.025, 98); s.tone(147, 0.4, 'triangle', 0.04, 0, 0.08); },
    pass: function (s) { for (var i = 0; i < 3; i++) s.tone(1500 + i * 180, 0.035, 'triangle', 0.025, 1000, i * 0.06); },
    turn: function (s) { s.tone(880, 0.07, 'sine', 0.03); },
    moon: function (s) { [392, 523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.18, 'triangle', 0.035, 0, i * 0.08); }); },
    win: function (s) { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.16, 'triangle', 0.035, 0, i * 0.09); }); },
    lose: function (s) { s.tone(392, 0.18, 'triangle', 0.03); s.tone(311, 0.3, 'triangle', 0.03, 0, 0.16); },
    bad: function (s) { s.tone(180, 0.09, 'square', 0.02, 140); }
  };

  function svg(path) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_TAB = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>');
  var IC_HOME = svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>');

  // ---- cards (monospace faces) ----
  function rk(c) { return rankOf(c) === 8 ? '10' : RANKS.charAt(rankOf(c)); }
  function red(c) { var s = suitOf(c); return s === 1 || s === 3; }
  function cardHtml(c, cls, attrs) {
    return '<span class="ht-c ' + (red(c) ? 'red' : 'blk') + (c === QS ? ' qs' : '') + (cls ? ' ' + cls : '') + '"' + (attrs || '') +
      ' aria-label="' + esc(cardName(c)) + '"><b>' + rk(c) + '</b><i>' + GLYPH[suitOf(c)] + '</i><u>' + GLYPH[suitOf(c)] + '</u></span>';
  }
  function backHtml(cls) { return '<span class="ht-c back' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><i>#</i></span>'; }

  // ---- persistence ----
  function persist() {
    if (!S || !S.g) return;
    var o = {}, g = S.g;
    for (var k in g) if (k !== 'ev') o[k] = g[k];
    sset(GAME_KEY, JSON.stringify(o));
  }
  function saveRec() { if (S) sset(REC_KEY, JSON.stringify(S.rec)); }
  function saveCfg() { if (S) sset(CFG_KEY, JSON.stringify(S.cfg)); }
  function savePrefs() { if (S) sset(PREF_KEY, JSON.stringify(S.prefs)); }

  // ---- who sees what ----
  function humanSeats(g) { var o = []; g.seats.forEach(function (s, i) { if (s.kind === 'human') o.push(i); }); return o; }
  function multi() { return !!(S && S.g && humanSeats(S.g).length > 1); }
  function nm(g, p) { return seatName(g.seats[p], p); }
  // The seat at the bottom of the table.
  function viewSeat() {
    var g = S.g;
    if (!g) return 0;
    if (!multi()) return humanSeats(g)[0];
    return S.revealed >= 0 ? S.revealed : S.lastView;
  }
  function posOf(p) { return POS[(p - viewSeat() + 4) % 4]; }
  function canSee(p) { var g = S.g; return g.seats[p].kind === 'human' && (!multi() || S.revealed === p); }
  function myTurn() {
    var g = S.g;
    if (!g || S.hold || S.card) return false;
    if (g.phase === 'play') return g.turn === viewSeat() && canSee(g.turn);
    if (g.phase === 'pass') { var v = viewSeat(); return canSee(v) && !g.pass[v]; }
    return false;
  }

  // ---- rendering ----
  function seatHtml(g, p) {
    var pos = posOf(p), s = g.seats[p], tp = handPts(g.taken[p]);
    var act = (g.phase === 'play' && g.turn === p && !S.hold) || (g.phase === 'pass' && !g.pass[p] && s.kind === 'human' && !canSee(p));
    var cls = 'ht-seat p-' + pos + (act ? ' act' : '') + (s.kind === 'human' ? ' human' : '') + (S.hold && S.hold.w === p && S.holdStage > 0 ? ' won' : '');
    var tag = s.kind === 'human' ? (multi() ? 'human' : 'you') : 'cpu · ' + DIFFS[s.diff].name.toLowerCase();
    var status = '';
    if (g.phase === 'pass') status = g.pass[p] ? '<span class="ok">passed ✓</span>' : (s.kind === 'cpu' ? 'choosing' : 'to pass');
    else if (g.phase === 'play' && g.turn === p && !S.hold) status = '<span class="go">' + (s.kind === 'cpu' ? 'thinking<span class="ht-dots"></span>' : 'to play') + '</span>';
    var n = g.hands[p].length, fan = '';
    for (var i = 0; i < Math.min(n, 13); i++) fan += '<i></i>';
    var pts = tp ? '<span class="pts' + (g.taken[p].indexOf(QS) >= 0 ? ' q' : '') + '">+' + tp + (g.taken[p].indexOf(QS) >= 0 ? ' Q♠' : '') + '</span>' : '<span class="pts z">+0</span>';
    return '<div class="' + cls + '" data-seat="' + p + '"><div class="ht-sn"><b>' + esc(nm(g, p)) + '</b><em>' + tag + '</em></div>' +
      '<div class="ht-ss"><span class="sc">' + g.scores[p] + '</span>' + pts + '</div>' +
      '<div class="ht-fan" aria-label="' + n + ' cards">' + fan + '</div><div class="ht-st">' + (status || '&nbsp;') + '</div></div>';
  }
  function trickHtml(g) {
    var cards = S.hold ? S.hold.trick : g.trick, h = '';
    var winP = S.hold ? S.hold.w : (g.trick.length ? trickWinner(g.trick).p : -1);
    cards.forEach(function (t) {
      var pos = posOf(t.p), cls = 'ht-tc s-' + pos;
      if (S.fresh === t.c && !(S.hold && S.holdStage > 0)) cls += ' in';
      if (S.hold && S.holdStage === 2) cls += ' sweep to-' + posOf(S.hold.w);
      if (t.p === winP && cards.length > 1) cls += ' lead';
      h += cardHtml(t.c, cls);
    });
    return h;
  }
  function infoHtml(g) {
    if (g.phase === 'pass') {
      var D = PASS_DIRS[g.dir];
      return '<div class="ht-pdir"><b>' + D.arrow + '</b>pass ' + D.name + '</div>';
    }
    if (g.phase === 'play' && !g.trick.length && !S.hold && g.trickNo === 0) return '<div class="ht-pdir"><b>2♣</b>leads</div>';
    return '';
  }
  function handHtml(g) {
    var v = viewSeat(), h = g.hands[v], see = canSee(v), out = '';
    if (!h.length) return '<div class="ht-empty">' + (g.phase === 'play' ? '' : '&nbsp;') + '</div>';
    var L = g.phase === 'play' && g.turn === v && see && !S.hold ? legal(g, v) : null;
    var passing = g.phase === 'pass' && see && !g.pass[v];
    var recv = see && g.recv[v] && g.trickNo === 0 ? g.recv[v] : [];
    var passed = g.phase === 'pass' && see && g.pass[v] ? g.pass[v] : [];
    var prevSuit = -1;
    h.forEach(function (c, i) {
      var cls = 'ht-hc';
      if (suitOf(c) !== prevSuit && i) cls += ' gap';
      prevSuit = suitOf(c);
      if (!see) { out += '<span class="' + cls + '">' + backHtml() + '</span>'; return; }
      var cc = '';
      if (L) cc += L.indexOf(c) >= 0 ? ' ok' : ' no';
      if (passing && S.sel.indexOf(c) >= 0) cc += ' up';
      if (passed.indexOf(c) >= 0) cc += ' up gone';
      if (L && S.lift === c) cc += ' up';
      if (recv.indexOf(c) >= 0) cc += ' new';
      if (S.kb === c && !S.coarse) cc += ' kb';
      out += '<button type="button" class="' + cls + '" data-c="' + c + '"' + (L && L.indexOf(c) < 0 ? ' aria-disabled="true"' : '') + '>' + cardHtml(c, cc.trim()) + '</button>';
    });
    return out;
  }
  function meHtml(g) {
    var v = viewSeat(), s = g.seats[v], tp = handPts(g.taken[v]), act = g.phase === 'play' && g.turn === v && !S.hold;
    return '<span class="ht-mn' + (act ? ' act' : '') + '"><b>' + esc(nm(g, v)) + '</b></span><span class="ht-msc">' + g.scores[v] + ' <i>pts</i></span>' +
      '<span class="pts' + (g.taken[v].indexOf(QS) >= 0 ? ' q' : '') + (tp ? '' : ' z') + '">this hand +' + tp + (g.taken[v].indexOf(QS) >= 0 ? ' Q♠' : '') + '</span>' +
      '<span class="ht-hn">hand ' + (g.handNo + 1) + ' · to ' + g.target + '</span>' + (s.kind === 'human' ? '' : '');
  }
  function barHtml(g) {
    var v = viewSeat();
    if (g.phase === 'pass') {
      var D = PASS_DIRS[g.dir], to = (v + D.off) % 4;
      if (canSee(v) && !g.pass[v]) {
        var n = S.sel.length;
        return '<div class="ht-hint">Choose 3 cards to pass ' + D.name + ' to <b>' + esc(nm(g, to)) + '</b></div>' +
          '<div class="ht-acts"><button type="button" class="ht-a pri" data-act="pass"' + (n === 3 ? '' : ' disabled') + '>' +
          (n === 3 ? 'Pass ' + D.arrow + ' ' + esc(nm(g, to)) : 'Pick ' + (3 - n) + ' more') + '</button></div>';
      }
      return '<div class="ht-hint">Waiting for the others to pass<span class="ht-dots"></span></div>';
    }
    if (g.phase === 'play') {
      if (S.hold) return '<div class="ht-hint">' + esc(nm(g, S.hold.w)) + ' takes the trick' + (S.hold.pts ? ' <b class="r">+' + S.hold.pts + '</b>' : '') + '</div>';
      if (g.turn === v && canSee(v)) {
        var t;
        if (!g.trick.length) t = g.trickNo === 0 ? 'Lead the <b>2♣</b>' : (g.broken ? 'Your lead' : 'Your lead — hearts not broken yet');
        else {
          var ls = suitOf(g.trick[0].c), has = g.hands[v].some(function (c) { return suitOf(c) === ls; });
          t = has ? 'Follow <b class="' + (ls % 2 ? 'r' : '') + '">' + GLYPH[ls] + '</b>' : 'No ' + GLYPH[ls] + ' — discard' + (g.trickNo === 0 && !g.bleed ? ' (no points on trick 1)' : ' anything');
        }
        if (S.prefs.confirm) t += S.lift != null ? ' · tap again to play' : ' · tap twice to play';
        return '<div class="ht-hint you">' + t + '</div>';
      }
      return '<div class="ht-hint">' + esc(nm(g, g.turn)) + (g.seats[g.turn].kind === 'cpu' ? ' is thinking' : ' to play') + '<span class="ht-dots"></span></div>';
    }
    return '<div class="ht-hint">&nbsp;</div>';
  }
  // Only touch an element when its markup changed, so running animations (a card
  // flying in, the dots) are not restarted by unrelated re-renders.
  function put(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
  function render() {
    if (!S) return;
    var g = S.g;
    if (!g) { put(S.hand, ''); put(S.me, ''); put(S.bar, ''); S.table.style.display = 'none'; syncHead(); return; }
    S.table.style.display = '';
    S.root.style.setProperty('--ht-sweep', pace().sweep + 'ms');
    var v = viewSeat();
    for (var k = 1; k < 4; k++) put(S.slots[POS[k]], seatHtml(g, (v + k) % 4));
    put(S.trickEl, trickHtml(g));
    put(S.infoEl, infoHtml(g));
    put(S.me, meHtml(g));
    put(S.hand, handHtml(g));
    S.hand.classList.toggle('turn', myTurn());
    put(S.bar, barHtml(g));
    syncHead();
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.classList.toggle('on', S.snd.on);
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    S.head.querySelector('[data-h="home"]').disabled = !S.g;
    S.head.querySelector('[data-h="table"]').disabled = !S.g || !S.g.hist.length;
  }
  function say(t) { if (S && S.liveEl) S.liveEl.textContent = t; }
  function flash(msg, cls, ms) {
    S.msg = msg; S.msgCls = cls || '';
    var m = S.msgEl;
    m.className = 'ht-msg ' + (cls || ''); m.innerHTML = msg; void m.offsetWidth; m.classList.add('pop');
    clearTimeout(S.msgT);
    S.msgT = setTimeout(function () { if (!S) return; S.msg = ''; S.msgEl.innerHTML = ''; S.msgEl.className = 'ht-msg'; }, ms || 1800);
  }
  function burst(glyphs, n, cls) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var fx = S.fxEl;
    if (!fx) return;
    for (var i = 0; i < n; i++) {
      var e = document.createElement('span');
      e.className = 'ht-pt ' + (cls || '');
      e.textContent = glyphs.charAt(Math.floor(Math.random() * glyphs.length));
      var a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 80;
      e.style.setProperty('--x', Math.round(Math.cos(a) * d) + 'px');
      e.style.setProperty('--y', Math.round(Math.sin(a) * d - 20) + 'px');
      e.style.setProperty('--r', Math.round(Math.random() * 120 - 60) + 'deg');
      e.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      fx.appendChild(e);
    }
    setTimeout(function () { if (fx && fx.parentNode) fx.innerHTML = ''; }, 1500);
  }

  // ---- overlay cards ----
  function pill(set, v, label, on) { return '<button type="button" data-set="' + set + '" data-v="' + v + '" class="' + (on ? 'on' : '') + '">' + label + '</button>'; }
  function homeHtml() {
    var c = S.cfg, rows = '', hs = 0;
    c.seats.forEach(function (s) { if (s.kind === 'human') hs++; });
    c.seats.forEach(function (s, i) {
      var seatLbl = ['S', 'W', 'N', 'E'][i];
      rows += '<div class="ht-row"><span class="ht-ix">' + seatLbl + '</span>' +
        '<button type="button" class="ht-kind' + (s.kind === 'human' ? ' human' : '') + '" data-kind="' + i + '">' + (s.kind === 'human' ? 'Human' : 'CPU') + '</button>' +
        (s.kind === 'human'
          ? '<input class="ht-in" data-name="' + i + '" maxlength="12" value="' + esc(s.name) + '" aria-label="Seat ' + seatLbl + ' name" autocomplete="off" spellcheck="false">'
          : '<span class="ht-cpu">' + CPU_NAMES[i] + '</span><button type="button" class="ht-dif d-' + s.diff + '" data-dif="' + i + '">' + DIFFS[s.diff].name + '</button>') +
        '</div>';
    });
    var sv = S.saved, cont = '';
    if (sv) {
      var hv = humanSeats(sv)[0];
      cont = '<button type="button" class="ht-go" data-act="continue">Continue game <span>hand ' + (sv.handNo + 1) + ' · ' +
        sv.seats.map(function (s, i) { return esc(seatName(s, i)) + ' ' + sv.scores[i]; }).join(' · ') + '</span></button>';
      if (hv == null) cont = '';
    }
    var arm = S.newArm ? '<div class="ht-confirm">Abandon the saved game? <button type="button" class="ht-lnk danger" data-act="start-yes">Yes, new game</button> <button type="button" class="ht-lnk" data-act="start-no">Keep it</button></div>' : '';
    return '<div class="ht-card home"><pre class="ht-art">' + esc(ART) + '</pre>' +
      '<div class="ht-sub">avoid hearts · dodge the Q♠ · or take them all</div>' + cont +
      '<div class="ht-sec"><div class="ht-h">Seats <span>' + (hs > 1 ? '· ' + hs + ' players pass the device' : '· vs 3 CPUs') + '</span></div><div class="ht-rows">' + rows + '</div></div>' +
      '<div class="ht-sec"><div class="ht-h">Game to</div><div class="ht-seg">' + TARGETS.map(function (t) { return pill('target', t, t, c.target === t); }).join('') + '</div></div>' +
      '<div class="ht-sec"><div class="ht-h">Shooting the moon</div><div class="ht-seg">' + pill('moon', 'add', '+26 to the others', c.moon === 'add') + pill('moon', 'choose', 'Shooter chooses', c.moon === 'choose') + '</div></div>' +
      '<div class="ht-sec"><div class="ht-h">First trick</div><div class="ht-seg">' + pill('bleed', '0', 'No points', !c.bleed) + pill('bleed', '1', 'Points allowed', c.bleed) + '</div></div>' +
      '<div class="ht-sec"><div class="ht-h">Pace</div><div class="ht-seg">' + Object.keys(PACE).map(function (k) { return pill('pace', k, PACE[k].name, S.prefs.pace === k); }).join('') + '</div></div>' +
      '<div class="ht-sec"><div class="ht-h">Playing a card</div><div class="ht-seg">' + pill('confirm', '0', 'One tap', !S.prefs.confirm) + pill('confirm', '1', 'Tap twice', S.prefs.confirm) + '</div></div>' +
      arm + '<button type="button" class="ht-go pri" data-act="start">' + (sv ? 'New game' : 'Deal') + '</button>' +
      '<div class="ht-foot"><button type="button" class="ht-lnk" data-act="records">Records</button><button type="button" class="ht-lnk" data-act="help">How to play</button></div></div>';
  }
  var ART = [' _   _ _____    _    ____ _____ ____ ', '| | | | ____|  / \\  |  _ \\_   _/ ___|', '| |_| |  _|   / _ \\ | |_) || | \\___ \\', '|  _  | |___ / ___ \\|  _ < | |  ___) |', '|_| |_|_____/_/   \\_\\_| \\_\\|_| |____/'].join('\n');
  function helpHtml() {
    return '<div class="ht-card"><div class="ht-title">HOW TO PLAY</div>' +
      '<p>Four players, thirteen tricks a hand. <b>Lowest score wins.</b> Every <b class="r">♥</b> you take is <b>1</b> point and the <b>Q♠</b> is <b>13</b>.</p>' +
      '<p><b>Passing.</b> Before each hand pass three cards: left, right, across, then a hold hand with no pass — and round again.</p>' +
      '<p><b>Play.</b> The <b>2♣</b> leads the first trick. Follow the suit led if you can; otherwise play anything. The highest card of the suit led takes the trick and leads the next.</p>' +
      '<p><b>Hearts</b> may not be led until one has been discarded (hearts are “broken”) — unless you hold nothing else. By default no points may be played on the first trick.</p>' +
      '<p><b>Shoot the moon:</b> take all 13 hearts and the queen and the others get 26 each instead of you (or, with “shooter chooses”, you may take −26 yourself).</p>' +
      '<p>When anyone reaches the target the lowest score wins; a tie for lowest plays on.</p>' +
      '<div class="ht-keys"><span><b>←/→</b> pick a card · <b>Enter</b>/<b>Space</b> play or select</span><span><b>P</b> pass the chosen three · <b>T</b> score table</span><span><b>N</b> next hand · <b>Esc</b> close a card</span></div>' +
      '<p class="ht-note">CPU levels: <b>Easy</b> plays loose, <b>Normal</b> ducks, dumps and watches voids, <b>Hard</b> also counts every card, smokes out the queen, blocks moon runs and shoots the moon itself.</p>' +
      '<button type="button" class="ht-go" data-act="close">Got it</button></div>';
  }
  function tableHtml(g, scoredNow) {
    var head = '  #   ' + [0, 1, 2, 3].map(function (p) { return pad(nm(g, p).slice(0, 7), 8); }).join('');
    var lines = ['<b>' + esc(head) + '</b>'];
    var run = [0, 0, 0, 0];
    g.hist.forEach(function (h, i) {
      var l = pad(String(i + 1), 3, true) + ' ' + PASS_DIRS[h.dir].arrow + ' ';
      var cells = h.d.map(function (d, p) {
        run[p] += d;
        var s = (d > 0 ? '+' : '') + d + (h.sh === p ? '☾' : (h.q === p ? 'Q' : ''));
        return pad(s, 8);
      }).join('');
      var cls = scoredNow && i === g.hist.length - 1 ? 'g' : '';
      lines.push(cls ? '<span class="g">' + esc(l + cells) + '</span>' : esc(l + cells));
    });
    var lo = Math.min.apply(null, g.scores);
    lines.push(esc('      ' + [0, 1, 2, 3].map(function () { return '------  '; }).join('')));
    lines.push('<b>' + esc('total ') + '</b>' + g.scores.map(function (s) { var t = pad(String(s), 8); return s === lo ? '<span class="g"><b>' + esc(t) + '</b></span>' : '<b>' + esc(t) + '</b>'; }).join(''));
    return '<pre class="ht-tab">' + lines.join('\n') + '</pre><div class="ht-note">☾ shot the moon · Q took the Q♠ · ' + PASS_DIRS.map(function (d) { return d.arrow + ' ' + d.name; }).join(' ') + '</div>';
  }
  function pad(s, n, left) { s = String(s); while (s.length < n) s = left ? ' ' + s : s + ' '; return s; }
  function scoredHtml() {
    var g = S.g, h = g.hist[g.hist.length - 1], v = viewSeat(), big = '';
    if (h.sh >= 0) big = '<div class="ht-big moon">☾ ' + (!multi() && h.sh === v ? 'You' : esc(nm(g, h.sh))) + ' shot the moon!</div><div class="ht-sub">' + (h.sub ? (!multi() && h.sh === v ? 'you take −26' : esc(nm(g, h.sh)) + ' takes −26') : '+26 to everyone else') + '</div>';
    else {
      var mine = h.d[v];
      big = '<div class="ht-big' + (multi() ? '' : mine ? ' bad' : ' clean') + '">' + (multi() ? 'Hand ' + g.hist.length : (mine ? 'You took ' + mine : 'Clean hand!')) + '</div>' +
        (h.q >= 0 ? '<div class="ht-sub">Q♠ went to <b>' + esc(nm(g, h.q)) + '</b></div>' : '');
    }
    var tie = g.tie ? '<div class="ht-note r">Tied for the lowest score — play on!</div>' : '';
    var nextD = PASS_DIRS[(g.handNo + 1) % 4];
    return '<div class="ht-card wide"><div class="ht-title">HAND ' + g.hist.length + '</div>' + big + tableHtml(g, true) + tie +
      '<div class="ht-btns"><button type="button" class="ht-go pri" data-act="next">Next hand <span>' + (nextD.off ? 'pass ' + nextD.name : 'hold — no pass') + '</span></button></div></div>';
  }
  function moonHtml() {
    var g = S.g, p = g.shooter, me = !multi() && p === humanSeats(g)[0];
    function after(choice) {
      var d = choice === 'sub' ? [0, 1, 2, 3].map(function (q) { return q === p ? -26 : 0; }) : [0, 1, 2, 3].map(function (q) { return q === p ? 0 : 26; });
      return g.seats.map(function (s, i) { return esc(nm(g, i)) + ' ' + (g.scores[i] + d[i]); }).join(' · ');
    }
    return '<div class="ht-card"><div class="ht-title">SHOT THE MOON</div><pre class="ht-art moonart">' + esc(MOON_ART) + '</pre>' +
      '<div class="ht-big moon">' + (me ? 'You took' : esc(nm(g, p)) + ' took') + ' all 26!</div><p>Choose how to score it:</p>' +
      '<div class="ht-btns col"><button type="button" class="ht-go pri" data-act="moon-add">+26 to everyone else<span>' + after('add') + '</span></button>' +
      '<button type="button" class="ht-go" data-act="moon-sub">−26 for ' + (me ? 'yourself' : esc(nm(g, p))) + '<span>' + after('sub') + '</span></button></div>' +
      '<div class="ht-note">Game to ' + g.target + ' · lowest score wins</div></div>';
  }
  var MOON_ART = ['    .--.  *', '   /  .\'  ', '  |  (    .', '   \\  \'.  ', ' *  \'--\'  '].join('\n');
  function overHtml() {
    var g = S.g, w = g.winners[0], hs = humanSeats(g), v = hs[0];
    var order = [0, 1, 2, 3].sort(function (a, b) { return g.scores[a] - g.scores[b]; });
    var won = !multi() && w === v, title = multi() ? esc(nm(g, w)) + ' wins!' : (won ? 'You win!' : esc(nm(g, w)) + ' wins');
    var place = ['1st', '2nd', '3rd', '4th'];
    var st = order.map(function (p, i) { return '<span class="' + (i === 0 ? 'g' : '') + '">' + esc(pad(place[i], 4) + ' ' + pad(nm(g, p), 12) + pad(String(g.scores[p]), 4, true)) + '</span>'; }).join('\n');
    return '<div class="ht-card wide"><div class="ht-title">GAME OVER</div><div class="ht-big' + (won || multi() ? '' : ' lose') + '">' + title + '</div>' +
      '<pre class="ht-tab">' + st + '</pre>' + (S.recNote ? '<div class="ht-new">' + S.recNote + '</div>' : '') +
      '<details class="ht-det"><summary>Score table</summary>' + tableHtml(g, false) + '</details>' +
      '<div class="ht-btns"><button type="button" class="ht-go pri" data-act="again">Play again</button><button type="button" class="ht-go" data-act="lobby">Lobby</button></div></div>';
  }
  function recordsHtml() {
    var r = S.rec, pct = r.games ? Math.round(100 * r.wins / r.games) : 0, avg = r.hands ? (r.pts / r.hands).toFixed(1) : '–';
    var rows = [
      ['Games', r.games], ['Wins', r.wins + (r.games ? '  (' + pct + '%)' : '')], ['Best streak', r.bestStreak], ['Best final', r.best == null ? '–' : r.best],
      ['Hands', r.hands], ['Avg pts/hand', avg], ['Clean hands', r.clean], ['Moons shot', r.moons], ['Q♠ taken', r.queens], ['Pass & play', r.mp]
    ];
    var tab = rows.map(function (x) { return esc(pad(x[0], 14)) + '<b>' + esc(String(x[1])) + '</b>'; }).join('\n');
    var reset = S.resetArm
      ? '<div class="ht-confirm">Reset all records? <button type="button" class="ht-lnk danger" data-act="reset-yes">Reset</button> <button type="button" class="ht-lnk" data-act="reset-no">Cancel</button></div>'
      : '<button type="button" class="ht-lnk" data-act="reset">Reset records</button>';
    return '<div class="ht-card"><div class="ht-title">RECORDS</div><pre class="ht-tab">' + tab + '</pre>' +
      '<div class="ht-note">Solo games vs the CPUs count here; pass-and-play games are tallied apart.</div>' +
      '<button type="button" class="ht-go" data-act="close">Back</button>' + reset + '</div>';
  }
  function privHtml() {
    var g = S.g, p = S.privFor;
    var what = g.phase === 'pass' ? 'to choose a pass' : 'to play';
    return '<div class="ht-card priv"><div class="ht-title">PASS THE DEVICE</div><pre class="ht-art">.------.\n|♥ ♠ ♦ |\n|  ??  |\n| ♣ ♥ ♠|\n\'------\'</pre>' +
      '<div class="ht-big">' + esc(nm(g, p)) + '</div><div class="ht-sub">your turn ' + what + ' — others look away</div>' +
      '<button type="button" class="ht-go pri" data-act="reveal">I\'m ' + esc(nm(g, p)) + ' — show my cards</button></div>';
  }
  function scoresCardHtml() {
    return '<div class="ht-card wide"><div class="ht-title">SCORES</div>' + tableHtml(S.g, false) + '<button type="button" class="ht-go" data-act="close">Back</button></div>';
  }

  function showCard(kind) {
    S.card = kind || null;
    var h = '';
    if (kind === 'home') h = homeHtml();
    else if (kind === 'help') h = helpHtml();
    else if (kind === 'records') h = recordsHtml();
    else if (kind === 'scored') h = scoredHtml();
    else if (kind === 'moon') h = moonHtml();
    else if (kind === 'over') h = overHtml();
    else if (kind === 'priv') h = privHtml();
    else if (kind === 'scores') h = scoresCardHtml();
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.wrap.classList.toggle('dim', !!kind);
    S.wrap.classList.toggle('priv', kind === 'priv');
    S.wrap.classList.toggle('lobby', !!kind && !S.g);
    S.ovl.scrollTop = 0;
    if (kind && !S.coarse && kind !== 'home') {
      var f = S.ovl.querySelector('.ht-go.pri') || S.ovl.querySelector('.ht-go');
      if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
    syncHead();
  }
  // Cards the player opened over a running game (help, scores, records) return to the game.
  function closeCard() {
    if (!S) return;
    var k = S.card;
    if (!S.g) { showCard('home'); return; }
    if (k === 'priv' || k === 'scored' || k === 'over' || k === 'moon') return;
    showCard(null);
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
    flow();
  }

  // ---- game flow ----
  function cancel() { if (S) { clearTimeout(S.timer); S.timer = 0; S.tok++; } }
  function later(ms, fn) {
    var tok = S.tok;
    clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      if (!S || S.tok !== tok) return;
      S.timer = 0;
      // a hidden tab or minimized panel: stop here; onVis / restore picks the game back up
      if (paused()) { if (S.hold) { S.hold = null; S.holdStage = 0; } return; }
      fn();
    }, ms);
  }
  function paused() { return !S || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function pace() { return PACE[S.prefs.pace] || PACE.relaxed; }

  function flow() {
    if (!S || !S.g || S.card || S.hold || S.timer) return;
    if (paused()) return;
    var g = S.g;
    if (g.phase === 'pass') {
      var p;
      for (p = 0; p < 4; p++) if (g.seats[p].kind === 'cpu' && !g.pass[p]) setPass(g, p, aiPass(g, p));
      if (g.phase === 'play') { afterPass(); return; }
      var need = humanSeats(g).filter(function (q) { return !g.pass[q]; });
      if (!need.length) return;
      if (multi() && S.revealed !== need[0]) {
        if (S.privOk === need[0]) { S.revealed = need[0]; S.lastView = need[0]; } else { askPrivacy(need[0]); return; }
      }
      render();
      return;
    }
    if (g.phase === 'play') {
      var t = g.turn;
      if (g.seats[t].kind === 'cpu') {
        render();
        later(pace().cpu * (0.75 + Math.random() * 0.5), function () { var c = aiPlay(g, t); doPlay(t, c); });
        return;
      }
      if (multi() && S.revealed !== t) {
        if (S.privOk === t) { S.revealed = t; S.lastView = t; } else { askPrivacy(t); return; }
      }
      render();
      if (!S.turnBeep) { S.turnBeep = true; SFX.turn(S.snd); }
      return;
    }
    if (g.phase === 'moon') {
      var sh = g.shooter;
      if (g.seats[sh].kind === 'cpu') {
        render();
        later(pace().hold, function () { var ch = aiMoon(g, sh); moonChoice(g, ch); drain(); flash(esc(nm(g, sh)) + ' chooses ' + (ch === 'sub' ? '−26' : '+26 for all'), 'moon', 2200); persist(); flow(); });
        return;
      }
      render(); showCard('moon'); return;
    }
    if (g.phase === 'scored') { recordHand(); render(); showCard('scored'); return; }
    if (g.phase === 'over') { recordHand(); recordGame(); render(); showCard('over'); }
  }
  function askPrivacy(p) {
    S.revealed = -1; S.privFor = p; S.lastView = p; S.sel = []; S.lift = null;
    render();
    showCard('priv');
  }
  function reveal() {
    S.revealed = S.privFor; S.lastView = S.privFor; S.privOk = S.privFor; S.turnBeep = false;
    showCard(null);
    var g = S.g;
    if (g.phase === 'play' && g.trickNo === 0 && g.recv[S.revealed] && !g.trick.some(function (t) { return t.p === S.revealed; })) showRecv(S.revealed);
    flow();
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }
  function afterPass() {
    var g = S.g;
    SFX.pass(S.snd);
    persist();
    S.sel = [];
    if (!multi()) showRecv(humanSeats(g)[0]);
    else S.revealed = -1;
    render();
    later(multi() ? 50 : 900, flow);
  }
  function showRecv(p) {
    var g = S.g, r = g.recv[p];
    if (!r) return;
    var from = (p - PASS_DIRS[g.dir].off + 4) % 4;
    render();
    flash('from ' + esc(nm(g, from)) + ': ' + r.map(function (c) { return '<span class="' + (red(c) ? 'r' : '') + '">' + cardStr(c) + '</span>'; }).join(' '), 'recv', 2600);
  }
  function drain() {
    var g = S.g, evs = g.ev.splice(0);
    evs.forEach(function (e) {
      if (e.t === 'play') { S.fresh = e.c; SFX.card(S.snd); }
      else if (e.t === 'broken') { setTimeout(function () { if (!S) return; flash('♥ hearts broken', 'r'); burst('♥♡', 10, 'r'); }, 30); SFX.broken(S.snd); }
      else if (e.t === 'queen') { setTimeout(function () { if (!S) return; flash('Q♠ from ' + esc(nm(g, e.p)) + '!', 'q'); }, 30); SFX.queen(S.snd); Cade.haptic && Cade.haptic(30); }
      else if (e.t === 'moon') { SFX.moon(S.snd); }
    });
    return evs;
  }
  function doPlay(p, c) {
    var g = S.g;
    if (!play(g, p, c)) return false;
    S.lift = null; S.kb = null; S.turnBeep = false;
    if (multi() && g.seats[p].kind === 'human') S.revealed = -1;   // the next player must not see this hand
    var evs = drain(), tr = null;
    evs.forEach(function (e) { if (e.t === 'trick') tr = e; });
    say(nm(g, p) + ' plays the ' + cardName(c));
    persist();
    if (tr) {
      S.hold = { trick: g.last.trick, w: tr.w, pts: tr.pts }; S.holdStage = 0;
      render();
      var P = pace();
      later(Math.max(160, P.hold * 0.35), function () {
        S.holdStage = 1; render();
        if (tr.pts) { var me = viewSeat(); if (tr.w === me && canSee(me) && !multi()) Cade.haptic && Cade.haptic(18); }
        later(P.hold * 0.65, function () {
          S.holdStage = 2; render(); SFX.trick(S.snd, tr.pts);
          later(P.sweep, function () {
            S.hold = null; S.holdStage = 0;
            if (g.phase !== 'play') {
              var sh = g.shooter;
              if (sh >= 0) { flash('☾ ' + esc(nm(g, sh)) + ' shot the moon!', 'moon', 2600); burst('☾★✦*', 22, 'moon'); }
              render();
              later(sh >= 0 ? 1500 : 450, flow);
            } else flow();
          });
        });
      });
    } else { render(); flow(); }
    return true;
  }
  function humanPlay(c) {
    var g = S.g, v = viewSeat();
    if (!myTurn() || g.phase !== 'play') return;
    var L = legal(g, v);
    if (L.indexOf(c) < 0) {
      SFX.bad(S.snd);
      var why = '';
      if (!g.trick.length && g.trickNo === 0) why = 'The 2♣ leads the first trick';
      else if (!g.trick.length) why = 'Hearts are not broken yet';
      else if (g.hands[v].some(function (x) { return suitOf(x) === suitOf(g.trick[0].c); })) why = 'Follow suit: play a ' + GLYPH[suitOf(g.trick[0].c)];
      else why = 'No points on the first trick';
      flash(why, 'warn', 1500);
      var el = S.hand.querySelector('[data-c="' + c + '"] .ht-c');
      if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
      return;
    }
    if (S.prefs.confirm && S.lift !== c) { S.lift = c; SFX.pick(S.snd); render(); return; }
    doPlay(v, c);
  }
  function togglePass(c) {
    var g = S.g, v = viewSeat();
    if (g.phase !== 'pass' || !canSee(v) || g.pass[v]) return;
    var i = S.sel.indexOf(c);
    if (i >= 0) S.sel.splice(i, 1);
    else { if (S.sel.length >= 3) S.sel.shift(); S.sel.push(c); }
    SFX.pick(S.snd);
    render();
  }
  function confirmPass() {
    var g = S.g, v = viewSeat();
    if (g.phase !== 'pass' || S.sel.length !== 3 || !canSee(v) || g.pass[v]) return;
    setPass(g, v, S.sel.slice());
    S.sel = [];
    SFX.pick(S.snd);
    if (g.phase === 'play') { afterPass(); return; }
    persist();
    if (multi()) S.revealed = -1;
    render();
    flow();
  }

  // ---- records ----
  function recordHand() {
    var g = S.g, key = g.hist.length;
    if (S.recHand === key || !g.hist.length) return;
    S.recHand = key; g.rh = key; persist();
    if (multi()) return;
    var v = humanSeats(g)[0], h = g.hist[g.hist.length - 1], r = S.rec;
    r.hands++; r.pts += Math.max(0, h.d[v]);
    if (h.sh === v) r.moons++;
    if (h.q === v) r.queens++;
    if (h.raw[v] === 0) r.clean++;
    saveRec();
  }
  function recordGame() {
    var g = S.g;
    if (S.recGame === g.rs + ':' + g.hist.length) return;
    S.recGame = g.rs + ':' + g.hist.length;
    sdel(GAME_KEY); S.saved = null;
    var r = S.rec;
    S.recNote = '';
    if (multi()) { r.mp++; saveRec(); SFX.win(S.snd); return; }
    var v = humanSeats(g)[0], won = g.winners[0] === v;
    r.games++;
    if (won) {
      r.wins++; r.streak++; r.bestStreak = Math.max(r.bestStreak, r.streak);
      if (r.best == null || g.scores[v] < r.best) { if (r.best != null) S.recNote = 'New best final score!'; r.best = g.scores[v]; }
      if (r.streak > 1) S.recNote = (S.recNote ? S.recNote + ' · ' : '') + r.streak + ' wins in a row';
      SFX.win(S.snd);
      setTimeout(function () { if (S) burst('♥♣♦♠★', 24); }, 60);
    } else { r.streak = 0; SFX.lose(S.snd); }
    saveRec();
  }

  // ---- start / continue ----
  function startGame() {
    var cfg = S.cfg, seed = (Math.random() * 4294967296) | 0;
    S.g = newGame(cfg, seed);
    S.saved = null; S.recHand = 0; S.recGame = ''; S.recNote = '';
    initView();
    persist();
    showCard(null);
    SFX.pass(S.snd);
    render();
    flow();
  }
  function continueGame() {
    S.g = S.saved; S.saved = null;
    S.g.ev = [];
    S.recHand = S.g.rh != null ? S.g.rh : S.g.hist.length; S.recGame = ''; S.recNote = '';
    initView();
    showCard(null);
    render();
    flow();
  }
  function initView() {
    S.revealed = -1; S.privFor = -1; S.privOk = -1; S.lastView = humanSeats(S.g)[0]; S.sel = []; S.lift = null; S.kb = null; S.hold = null; S.msg = ''; S.turnBeep = false;
  }
  function toLobby() {
    cancel();
    if (S.g && S.g.phase !== 'over') { persist(); S.saved = normGame(jget(GAME_KEY)); }
    S.g = null; S.hold = null; S.newArm = false;
    render();
    showCard('home');
  }

  // ---- input ----
  function onKey(e) {
    if (!S || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var t = e.target, k = e.key;
    // keys typed in the panel, or with nothing focused (a re-rendered card button had it)
    if (!t || !(S.panel.contains(t) || t === document.body || t === document.documentElement)) return;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape' && S.card && S.g) { if (['help', 'scores', 'records'].indexOf(S.card) >= 0) { e.preventDefault(); closeCard(); } return; }
    if (S.card) {
      if ((k === 'n' || k === 'N') && S.card === 'scored') { e.preventDefault(); next(); }
      return;
    }
    var g = S.g;
    if (!g) return;
    if (k === 't' || k === 'T') { if (g.hist.length) { e.preventDefault(); cancel(); showCard('scores'); } return; }
    if (k === '?' || k === 'h' || k === 'H') { e.preventDefault(); cancel(); showCard('help'); return; }
    if (!myTurn()) return;
    var v = viewSeat(), h = g.hands[v];
    var pool = g.phase === 'play' ? legal(g, v) : h;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      var i = pool.indexOf(S.kb);
      i = i < 0 ? (k === 'ArrowLeft' ? pool.length - 1 : 0) : (i + (k === 'ArrowLeft' ? -1 : 1) + pool.length) % pool.length;
      S.kb = pool[i];
      if (g.phase === 'play' && S.prefs.confirm) S.lift = null;
      render();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      var fc = t.closest ? t.closest('[data-c]') : null;
      if ((S.kb == null || h.indexOf(S.kb) < 0) && fc && S.hand.contains(fc)) S.kb = +fc.getAttribute('data-c');
      if (S.kb == null || h.indexOf(S.kb) < 0) { if (g.phase === 'pass' && S.sel.length === 3) confirmPass(); return; }
      if (g.phase === 'play') { var c = S.kb; if (S.prefs.confirm) S.lift = c; doPlay(v, c); }
      else togglePass(S.kb);
      return;
    }
    if ((k === 'p' || k === 'P') && g.phase === 'pass') { e.preventDefault(); confirmPass(); }
  }
  function next() {
    var g = S.g;
    if (!g || g.phase !== 'scored') return;
    nextHand(g);
    drain();
    persist();
    showCard(null);
    if (multi()) S.revealed = -1;
    S.sel = [];
    SFX.pass(S.snd);
    render();
    flow();
  }

  function teardown() {
    if (!S) return;
    var s = S;
    cancel();
    clearTimeout(s.msgT);
    persist();
    S = null;
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('resize', s.onResize);
    window.removeEventListener('focus', s.onVis);
    document.removeEventListener('keydown', onKey);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="ht" tabindex="-1"><div class="ht-wrap"><div class="ht-table"><div class="ht-slot p-t"></div><div class="ht-slot p-l"></div>' +
      '<div class="ht-mid"><div class="ht-trick"></div><div class="ht-info"></div><div class="ht-msg"></div><div class="ht-fx"></div></div><div class="ht-slot p-r"></div></div>' +
      '<div class="ht-me"></div><div class="ht-hand"></div>' +
      '<div class="ht-bar"></div><div class="ht-ovl" style="display:none"></div></div><div class="ht-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '♥️ Hearts', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ht-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="Lobby (the game is saved)" aria-label="Lobby">' + IC_HOME + '</button>' +
      '<button type="button" data-h="table" title="Score table (T)" aria-label="Score table">' + IC_TAB + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, saved = normGame(jget(GAME_KEY));
    if (saved && saved.phase === 'over') { saved = null; sdel(GAME_KEY); }
    S = {
      panel: p, head: hb, root: p.querySelector('.ht'), wrap: p.querySelector('.ht-wrap'), table: p.querySelector('.ht-table'),
      me: p.querySelector('.ht-me'), hand: p.querySelector('.ht-hand'), bar: p.querySelector('.ht-bar'), ovl: p.querySelector('.ht-ovl'),
      liveEl: p.querySelector('.ht-live'), trickEl: p.querySelector('.ht-trick'), infoEl: p.querySelector('.ht-info'), msgEl: p.querySelector('.ht-msg'),
      fxEl: p.querySelector('.ht-fx'), slots: { l: p.querySelector('.ht-slot.p-l'), t: p.querySelector('.ht-slot.p-t'), r: p.querySelector('.ht-slot.p-r') }, cfg: normCfg(jget(CFG_KEY)), rec: normRec(jget(REC_KEY)), prefs: normPrefs(jget(PREF_KEY)),
      snd: new Snd(sget(SOUND_KEY) === '1'), saved: saved, coarse: !!(mm && mm('(pointer: coarse)').matches),
      g: null, card: null, tok: 0, timer: 0, hold: null, holdStage: 0, sel: [], lift: null, kb: null, revealed: -1, privFor: -1, lastView: 0,
      msg: '', msgCls: '', fresh: -1, newArm: false, resetArm: false, recHand: 0, recGame: '', recNote: ''
    };
    p._onClose = teardown;

    S.onVis = function () { if (S && !document.hidden && !S.timer && !S.hold) flow(); else if (S && S.hold && !S.timer) { S.hold = null; render(); flow(); } };
    document.addEventListener('visibilitychange', S.onVis);
    window.addEventListener('focus', S.onVis);
    S.onResize = function () { if (S) S.coarse = !!(mm && mm('(pointer: coarse)').matches); };
    window.addEventListener('resize', S.onResize);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { cancel(); if (S.hold) { S.hold = null; render(); } } });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p && S.g) { cancel(); flow(); } });
    try {
      S.themeObs = new MutationObserver(function () { if (S) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

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
      } else if (h === 'help') { if (S.card === 'help') closeCard(); else if (!S.card || S.card === 'scores' || S.card === 'records' || !S.g) { if (S.g) cancel(); showCard('help'); } }
      else if (h === 'table') { if (S.card === 'scores') closeCard(); else if (S.g && S.g.hist.length && (!S.card || S.card === 'help')) { cancel(); showCard('scores'); } }
      else if (h === 'home') { if (S.g) toLobby(); }
      try { b.blur(); } catch (er) {}
    });
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    // the table and the hand are play surfaces: quick taps never zoom or start a scroll
    [S.table, S.hand].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
      el.addEventListener('touchend', function (e) {
        if (!e.cancelable || e.touches.length) return;
        e.preventDefault();
        var b = e.target.closest ? e.target.closest('button') : null;
        if (b) b.click();
      }, { passive: false });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
    document.addEventListener('keydown', onKey);

    S.hand.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-c]') : null;
      if (!b || !S || !S.g) return;
      S.snd.ensure();
      var c = +b.getAttribute('data-c');
      S.kb = null;
      if (!S.coarse) { try { S.root.focus({ preventScroll: true }); } catch (er) {} }
      if (S.g.phase === 'pass') togglePass(c); else humanPlay(c);
    });
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      if (b.getAttribute('data-act') === 'pass') confirmPass();
    });
    S.bar.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && e.cancelable) { e.preventDefault(); if (!b.disabled) b.click(); }
    }, { passive: false });

    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var c = S.cfg, a = b.getAttribute('data-act'), set = b.getAttribute('data-set');
      if (set) {
        var v = b.getAttribute('data-v');
        if (set === 'target') c.target = +v;
        else if (set === 'moon') c.moon = v;
        else if (set === 'bleed') c.bleed = v === '1';
        else if (set === 'pace') { S.prefs.pace = v; savePrefs(); }
        else if (set === 'confirm') { S.prefs.confirm = v === '1'; savePrefs(); }
        saveCfg(); rehome(); return;
      }
      if (b.hasAttribute('data-kind')) {
        var i = +b.getAttribute('data-kind'), s = c.seats[i];
        if (s.kind === 'human') {
          if (c.seats.filter(function (x) { return x.kind === 'human'; }).length <= 1) { if (Cade.showToast) Cade.showToast('At least one human has to play', 'info', 1600); return; }
          c.seats[i] = { kind: 'cpu', diff: 'normal' };
        } else c.seats[i] = { kind: 'human', name: 'Player ' + (i + 1) };
        // "You" only makes sense with one human at the table
        var hs = c.seats.filter(function (x) { return x.kind === 'human'; });
        c.seats.forEach(function (x, k) {
          if (x.kind !== 'human') return;
          if (hs.length > 1 && x.name === 'You') x.name = 'Player ' + (k + 1);
          if (hs.length === 1 && /^Player \d$/.test(x.name)) x.name = 'You';
        });
        saveCfg(); rehome(); return;
      }
      if (b.hasAttribute('data-dif')) {
        var j = +b.getAttribute('data-dif'), cur = DIFF_IDS.indexOf(c.seats[j].diff);
        c.seats[j].diff = DIFF_IDS[(cur + 1) % 3];
        saveCfg(); rehome(); return;
      }
      if (a === 'start') { if (S.saved) { S.newArm = true; rehome(); } else startGame(); }
      else if (a === 'start-yes') { sdel(GAME_KEY); S.saved = null; S.newArm = false; startGame(); }
      else if (a === 'start-no') { S.newArm = false; rehome(); }
      else if (a === 'continue') continueGame();
      else if (a === 'records') { S.resetArm = false; showCard('records'); }
      else if (a === 'help') showCard('help');
      else if (a === 'close') closeCard();
      else if (a === 'reveal') reveal();
      else if (a === 'next') next();
      else if (a === 'moon-add' || a === 'moon-sub') {
        var g = S.g;
        moonChoice(g, a === 'moon-sub' ? 'sub' : 'add'); drain(); persist(); showCard(null); flow();
      }
      else if (a === 'again') { sdel(GAME_KEY); startGame(); }
      else if (a === 'lobby') { S.g = null; showCard('home'); render(); }
      else if (a === 'reset') { S.resetArm = true; showCard('records'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('records'); }
      else if (a === 'reset-yes') { S.rec = newRec(); saveRec(); S.resetArm = false; showCard('records'); if (Cade.showToast) Cade.showToast('Records reset', 'info', 1500); }
    });
    S.ovl.addEventListener('input', function (e) {
      var t = e.target;
      if (!S || !t.hasAttribute('data-name')) return;
      var i = +t.getAttribute('data-name');
      S.cfg.seats[i].name = t.value.slice(0, 12);
      saveCfg();
    });
    S.ovl.addEventListener('change', function (e) {
      var t = e.target;
      if (!S || !t.hasAttribute('data-name')) return;
      var i = +t.getAttribute('data-name');
      S.cfg.seats[i].name = cleanName(t.value, i);
      saveCfg();
    });
    function rehome() { var y = S.ovl.scrollTop; showCard('home'); S.ovl.scrollTop = y; }

    render();
    showCard('home');
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Classic trick-taking Hearts — pass, avoid points, shoot the moon',
    icon: '♥️',
    tags: 'game,cards,hearts,tricks,cpu,pass and play,2 player,multiplayer,queen of spades,shoot the moon',
    open: open,
    _engine: ENGINE
  });
})();
