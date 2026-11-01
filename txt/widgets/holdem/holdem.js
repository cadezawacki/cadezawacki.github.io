/* Texas Hold'em — no-limit hold'em at a felt of monospace cards, for Cade.txt.
 * Two to six seats, each a human (pass-and-play on one device, with a privacy
 * screen between turns) or a computer player with its own style: rock, shark,
 * loose cannon, calling station, bluffer or maniac, at three levels. CPUs weigh
 * Monte Carlo equity against the hands they think you hold (a range read from
 * your actions and your habits), pot odds, position and a dash of bluffing; the
 * simulation runs in small slices off the UI thread's critical path.
 * Tournament (blinds rise every few hands, last stack standing) or cash game
 * (fixed blinds, rebuys, CPUs come and go). Full no-limit rules: blinds (the
 * heads-up button posts the small blind), minimum raises, short all-ins that
 * don't reopen the betting, uncalled bets returned, side pots, split pots with
 * the odd chip left of the button, a correct 7-card evaluator, and a hand
 * history. The game saves after every action and resumes where it stopped.
 * Records persist in Cade.store (cade-holdem-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Cards are 0..51: rank = c >> 2 (0 = deuce .. 12 = ace), suit = c & 3.
  var RANKS = '23456789TJQKA', SUITS = 'shdc';
  var SUIT_GLYPH = ['♠', '♥', '♦', '♣'];
  var RANK_NAME = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  var RANK_PL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
  var CAT_NAME = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  var STREETS = ['preflop', 'flop', 'turn', 'river'];

  function rankOf(c) { return c >> 2; }
  function suitOf(c) { return c & 3; }
  function cardStr(c) { return RANKS.charAt(c >> 2) + SUITS.charAt(c & 3); }
  function cardTxt(c) { return (c >> 2 === 8 ? '10' : RANKS.charAt(c >> 2)) + SUIT_GLYPH[c & 3]; }
  function parseCard(s) {
    s = String(s).trim();
    var r = RANKS.indexOf(s.charAt(0).toUpperCase()), u = SUITS.indexOf(s.charAt(1).toLowerCase());
    if (s.length === 3 && s.slice(0, 2) === '10') { r = 8; u = SUITS.indexOf(s.charAt(2).toLowerCase()); }
    return r < 0 || u < 0 ? -1 : r * 4 + u;
  }
  function parseCards(s) { return String(s).trim().split(/\s+/).filter(Boolean).map(parseCard); }

  // ---- seeded PRNG (mulberry32) whose state is a plain number, so a game saves ----
  function rngNext(o) {
    o.rs = (o.rs + 0x6D2B79F5) | 0;
    var t = Math.imul(o.rs ^ (o.rs >>> 15), 1 | o.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function mkRng(seed) { var o = { rs: seed | 0 }; return function () { return rngNext(o); }; }

  // ---- the 7-card evaluator ----
  // A hand's value is one integer: category * 16^5 + up to five tie-break
  // ranks (rank + 1, most significant first). Bigger is better; equal is a split.
  var B16 = [1048576, 65536, 4096, 256, 16, 1];
  function pack(cat, a, b, c, d, e) {
    return cat * B16[0] + (a + 1 || 0) * B16[1] + (b + 1 || 0) * B16[2] + (c + 1 || 0) * B16[3] + (d + 1 || 0) * B16[4] + (e + 1 || 0);
  }
  // Highest straight in a 13-bit rank mask (the ace also plays low): its top rank, or -1.
  function straightHigh(m) {
    var m2 = ((m << 1) | ((m >> 12) & 1)) >>> 0;   // bit 0 = ace low, bit r+1 = rank r
    for (var h = 13; h >= 4; h--) if (((m2 >> (h - 4)) & 31) === 31) return h - 1;
    return -1;
  }
  var RC = new Int8Array(13), SM = new Int32Array(4), SCN = new Int8Array(4);
  function evalHand(cs, n) {
    n = n == null ? cs.length : n;
    var i, r, s, mask = 0;
    for (i = 0; i < 13; i++) RC[i] = 0;
    SM[0] = SM[1] = SM[2] = SM[3] = 0; SCN[0] = SCN[1] = SCN[2] = SCN[3] = 0;
    for (i = 0; i < n; i++) { r = cs[i] >> 2; s = cs[i] & 3; RC[r]++; SM[s] |= 1 << r; SCN[s]++; mask |= 1 << r; }
    var fs = -1;
    for (s = 0; s < 4; s++) if (SCN[s] >= 5) fs = s;
    if (fs >= 0) { var sf = straightHigh(SM[fs]); if (sf >= 0) return pack(8, sf); }
    var q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1, p3 = -1;
    for (r = 12; r >= 0; r--) {
      var k = RC[r];
      if (k === 4) q = r;
      else if (k === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
      else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; else if (p3 < 0) p3 = r; }
    }
    if (q >= 0) { for (r = 12; r >= 0; r--) if (r !== q && RC[r]) break; return pack(7, q, r); }
    if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return pack(6, t1, Math.max(t2, p1));
    var top = [], need = 5;
    if (fs >= 0) {
      for (r = 12; r >= 0 && top.length < need; r--) if (SM[fs] & (1 << r)) top.push(r);
      return pack(5, top[0], top[1], top[2], top[3], top[4]);
    }
    var st = straightHigh(mask);
    if (st >= 0) return pack(4, st);
    if (t1 >= 0) {
      for (r = 12; r >= 0 && top.length < 2; r--) if (r !== t1 && RC[r]) top.push(r);
      return pack(3, t1, top[0], top[1]);
    }
    if (p2 >= 0) {
      for (r = 12; r >= 0; r--) if (r !== p1 && r !== p2 && RC[r]) break;
      return pack(2, p1, p2, r);
    }
    if (p1 >= 0) {
      for (r = 12; r >= 0 && top.length < 3; r--) if (r !== p1 && RC[r]) top.push(r);
      return pack(1, p1, top[0], top[1], top[2]);
    }
    for (r = 12; r >= 0 && top.length < 5; r--) if (RC[r]) top.push(r);
    return pack(0, top[0], top[1], top[2], top[3], top[4]);
  }
  function catOf(v) { return Math.floor(v / B16[0]); }
  function kicks(v) { var a = []; for (var i = 1; i < 6; i++) a.push(Math.floor(v / B16[i]) % 16 - 1); return a; }
  function handName(v) {
    var c = catOf(v), k = kicks(v);
    switch (c) {
      case 8: return k[0] === 12 ? 'Royal Flush' : 'Straight Flush, ' + RANK_NAME[k[0]] + ' high';
      case 7: return 'Four ' + RANK_PL[k[0]];
      case 6: return RANK_PL[k[0]] + ' full of ' + RANK_PL[k[1]];
      case 5: return 'Flush, ' + RANK_NAME[k[0]] + ' high';
      case 4: return 'Straight, ' + RANK_NAME[k[0]] + ' high';
      case 3: return 'Three ' + RANK_PL[k[0]];
      case 2: return 'Two Pair, ' + RANK_PL[k[0]] + ' and ' + RANK_PL[k[1]];
      case 1: return 'Pair of ' + RANK_PL[k[0]];
      default: return 'High Card, ' + RANK_NAME[k[0]];
    }
  }
  // Display order: bigger groups first, then higher ranks (K K 7 7 A, Q Q Q 4 4).
  function order5(cs) {
    var n = {};
    cs.forEach(function (c) { n[c >> 2] = (n[c >> 2] || 0) + 1; });
    return cs.sort(function (a, b) { return n[b >> 2] - n[a >> 2] || (b >> 2) - (a >> 2) || (a & 3) - (b & 3); });
  }
  // The five cards that make the hand (for display): the first 5-card subset worth the full value.
  function best5(cs) {
    var v = evalHand(cs), n = cs.length, sub = [0, 0, 0, 0, 0];
    if (n <= 5) return { v: v, cards: cs.slice() };
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) for (var c = b + 1; c < n; c++) for (var d = c + 1; d < n; d++) for (var e = d + 1; e < n; e++) {
      sub[0] = cs[a]; sub[1] = cs[b]; sub[2] = cs[c]; sub[3] = cs[d]; sub[4] = cs[e];
      if (evalHand(sub, 5) === v) return { v: v, cards: order5(sub.slice()) };
    }
    return { v: v, cards: cs.slice(0, 5) };
  }

  // ---- starting hands: a strength percentile for each of the 169 classes ----
  // Bill Chen's published point formula, ranked by the share of all 1326 combos it beats.
  function chen(r1, r2, suited) {
    var hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    var pts = hi === 12 ? 10 : hi === 11 ? 8 : hi === 10 ? 7 : hi === 9 ? 6 : (hi + 2) / 2;
    if (hi === lo) return Math.max(5, pts * 2);
    if (suited) pts += 2;
    var gap = hi - lo - 1;
    pts -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 10) pts += 1;
    return Math.ceil(pts);
  }
  var PF = (function () {
    var cls = [], i, j;
    for (i = 0; i < 13; i++) for (j = 0; j < 13; j++) {
      if (i < j) continue;
      if (i === j) cls.push({ k: i * 13 + j, s: chen(i, j, false), w: 6 });
      else { cls.push({ k: i * 13 + j, s: chen(i, j, false), w: 12 }); cls.push({ k: j * 13 + i, s: chen(i, j, true), w: 4 }); }
    }
    // tie-break equal scores by high card then low card so the table is total
    cls.sort(function (a, b) { return a.s - b.s || (Math.max(a.k / 13 | 0, a.k % 13) - Math.max(b.k / 13 | 0, b.k % 13)) || ((a.k / 13 | 0) + a.k % 13 - (b.k / 13 | 0) - b.k % 13); });
    var tab = new Float32Array(169), below = 0, tot = 1326;
    for (i = 0; i < cls.length; i++) { tab[cls[i].k] = (below + cls[i].w / 2) / tot; below += cls[i].w; }
    return tab;
  })();
  // Class key: high*13+low offsuit (pairs on the diagonal), low*13+high suited.
  function pfKey(c1, c2) {
    var r1 = c1 >> 2, r2 = c2 >> 2, hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    if (hi === lo) return hi * 13 + hi;
    return (c1 & 3) === (c2 & 3) ? lo * 13 + hi : hi * 13 + lo;
  }
  function pfPct(c1, c2) { return PF[pfKey(c1, c2)]; }
  function pfClass(c1, c2) {
    var r1 = c1 >> 2, r2 = c2 >> 2, hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    return RANKS.charAt(hi) + RANKS.charAt(lo) + (hi === lo ? '' : (c1 & 3) === (c2 & 3) ? 's' : 'o');
  }

  // ---- Monte Carlo equity: hero's hole + the board vs opponents drawn from ranges ----
  // opps: [{ cut }] — an opponent's hand is accepted when its preflop percentile is
  // at least `cut` (0 = any two cards); after a few misses any hand is taken.
  // Returns a job you step in slices: job.step(n) → true when done; job.eq ∈ [0,1].
  function equityJob(hole, board, opps, iters, rnd) {
    var known = {}, deck = [], i;
    for (i = 0; i < hole.length; i++) known[hole[i]] = 1;
    for (i = 0; i < board.length; i++) known[board[i]] = 1;
    for (i = 0; i < 52; i++) if (!known[i]) deck.push(i);
    var nOpp = Math.max(1, opps.length), hand = new Array(7), oh = [], bd = new Array(5), L;
    for (i = 0; i < nOpp; i++) oh.push([0, 0]);
    var job = { eq: 0, n: 0, win: 0, iters: iters, done: false };
    function draw() { var k = (rnd() * L) | 0, c = deck[k]; L--; deck[k] = deck[L]; deck[L] = c; return c; }
    job.step = function (k) {
      var end = Math.min(job.iters, job.n + (k || job.iters));
      for (; job.n < end; job.n++) {
        L = deck.length;
        for (var o = 0; o < nOpp; o++) {
          var cut = opps[o] ? opps[o].cut || 0 : 0, a, b, tries = 0;
          for (;;) {
            var ia = (rnd() * L) | 0, ib = (rnd() * (L - 1)) | 0;
            if (ib >= ia) ib++;
            a = deck[ia]; b = deck[ib];
            if (cut <= 0 || tries >= 8 || PF[pfKey(a, b)] >= cut) {
              // remove both (higher index first so the swap doesn't move the other)
              var hiI = Math.max(ia, ib), loI = Math.min(ia, ib), t;
              L--; t = deck[hiI]; deck[hiI] = deck[L]; deck[L] = t;
              L--; t = deck[loI]; deck[loI] = deck[L]; deck[L] = t;
              break;
            }
            tries++;
          }
          oh[o][0] = a; oh[o][1] = b;
        }
        for (i = 0; i < board.length; i++) bd[i] = board[i];
        for (; i < 5; i++) bd[i] = draw();
        for (i = 0; i < 5; i++) hand[i] = bd[i];
        hand[5] = hole[0]; hand[6] = hole[1];
        var hv = evalHand(hand, 7), best = -1, ties = 0;
        for (o = 0; o < nOpp; o++) {
          hand[5] = oh[o][0]; hand[6] = oh[o][1];
          var ov = evalHand(hand, 7);
          if (ov > best) { best = ov; ties = 0; }
          if (ov === hv) ties++;
        }
        if (hv > best) job.win += 1;
        else if (hv === best) job.win += 1 / (ties + 1);
      }
      job.eq = job.n ? job.win / job.n : 0;
      job.done = job.n >= job.iters;
      return job.done;
    };
    return job;
  }

  // ---- players ----
  // vpip: share of hands played; agg: bet/raise vs call; bluff: how often air bets.
  var STYLES = {
    shark: { name: 'Shark', tag: 'tight-aggressive', vpip: 0.22, agg: 0.72, bluff: 0.08 },
    rock: { name: 'Rock', tag: 'tight-passive', vpip: 0.13, agg: 0.3, bluff: 0.02 },
    cannon: { name: 'Loose Cannon', tag: 'loose-aggressive', vpip: 0.4, agg: 0.75, bluff: 0.14 },
    station: { name: 'Calling Station', tag: 'loose-passive', vpip: 0.5, agg: 0.18, bluff: 0.03 },
    bluffer: { name: 'Bluffer', tag: 'tricky, bluffs a lot', vpip: 0.3, agg: 0.6, bluff: 0.3 },
    maniac: { name: 'Maniac', tag: 'raises anything', vpip: 0.62, agg: 0.9, bluff: 0.24 }
  };
  var STYLE_IDS = ['shark', 'rock', 'cannon', 'station', 'bluffer', 'maniac'];
  var CPU_NAMES = ['Vega', 'Brick', 'Juno', 'Rex', 'Pip', 'Sable', 'Lou', 'Mira', 'Otto', 'Kit', 'Nell', 'Hux', 'Ivy', 'Bram', 'Zeke', 'Tess', 'Arlo', 'Wren'];
  var DIFFS = {
    easy: { name: 'Easy', iters: 160, noise: 0.13, ranges: false, pos: false, slice: 80 },
    normal: { name: 'Normal', iters: 450, noise: 0.06, ranges: true, pos: true, slice: 150 },
    hard: { name: 'Hard', iters: 1100, noise: 0.025, ranges: true, pos: true, slice: 220 }
  };
  // Tournament structure: small/big blind per level.
  var LEVELS = [[10, 20], [15, 30], [25, 50], [40, 80], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000], [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000]];
  var SPEEDS = { slow: { name: 'Slow', hands: 12 }, normal: { name: 'Normal', hands: 8 }, turbo: { name: 'Turbo', hands: 5 } };
  var STAKES = { low: { name: '5/10', sb: 5, bb: 10, buyin: 1000 }, mid: { name: '25/50', sb: 25, bb: 50, buyin: 5000 } };

  function mkSeat(def, i, stack) {
    var cpu = def.kind !== 'human';
    return {
      id: i, name: String(def.name || (cpu ? CPU_NAMES[i] : 'Player ' + (i + 1))).slice(0, 14), kind: cpu ? 'cpu' : 'human',
      style: cpu ? (STYLES[def.style] ? def.style : 'shark') : '', stack: stack, hole: [], folded: false, allIn: false,
      bet: 0, total: 0, acted: false, actedAt: -1, mayRaise: true, out: false, place: 0, last: '', vp: false, pfr: false, aggN: 0, buyins: 1, won: 0
    };
  }
  // cfg: { mode: 'tourney'|'cash', seats: [{ kind, name, style }], diff, speed, stakes, stack, seed }
  function newGame(cfg) {
    cfg = cfg || {};
    var mode = cfg.mode === 'cash' ? 'cash' : 'tourney', stake = STAKES[cfg.stakes] || STAKES.low;
    var stack = mode === 'cash' ? stake.buyin : Math.max(100, Math.round(cfg.stack || 1500));
    var defs = (cfg.seats || []).slice(0, 6);
    while (defs.length < 2) defs.push({ kind: 'cpu', style: STYLE_IDS[defs.length % STYLE_IDS.length] });
    var seed = (cfg.seed == null ? 12345 : cfg.seed) | 0;
    var g = {
      v: 1, mode: mode, diff: DIFFS[cfg.diff] ? cfg.diff : 'normal', speed: SPEEDS[cfg.speed] ? cfg.speed : 'normal',
      stakes: STAKES[cfg.stakes] ? cfg.stakes : 'low', startStack: stack,
      seats: defs.map(function (d, i) { return mkSeat(d, i, stack); }),
      button: -1, sb: -1, bb: -1, sbAmt: 0, bbAmt: 0, level: 0, handNo: 0,
      deck: [], dp: 0, board: [], street: 'idle', toAct: -1, curBet: 0, minRaise: 0, lastAgg: -1,
      runout: false, exposed: false, result: null, over: false, winner: -1, bustN: 0,
      log: [], hist: [], ev: [], stats: [], rs: seed, nameN: 0
    };
    g.seats.forEach(function () { g.stats.push({ h: 0, vp: 0, pfr: 0 }); });
    var used = {};
    g.seats.forEach(function (s, i) {   // unique names
      if (!s.name || used[s.name]) s.name = (s.name || 'Seat') + ' ' + (i + 1);
      used[s.name] = 1;
    });
    return g;
  }
  function blindsFor(g) {
    if (g.mode === 'cash') { var st = STAKES[g.stakes] || STAKES.low; return [st.sb, st.bb]; }
    return LEVELS[Math.min(g.level, LEVELS.length - 1)];
  }
  function levelOf(g, handNo) { return Math.floor(Math.max(0, handNo - 1) / SPEEDS[g.speed].hands); }
  function handsToNextLevel(g) { var per = SPEEDS[g.speed].hands; return per - ((g.handNo - 1) % per); }
  function alive(g) { return g.seats.filter(function (s) { return !s.out; }); }
  function nextSeat(g, from, pred) {
    var n = g.seats.length;
    for (var k = 1; k <= n; k++) { var i = (from + k + n) % n; if (pred(g.seats[i], i)) return i; }
    return -1;
  }
  function isAlive(s) { return !s.out; }
  function inHand(s) { return !s.out && !s.folded && s.hole.length === 2; }
  function canAct(s) { return inHand(s) && !s.allIn; }
  function potTotal(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].total; return t; }
  function chipsTotal(g) { var t = 0; for (var i = 0; i < g.seats.length; i++) t += g.seats[i].stack + g.seats[i].total; return t; }
  // A player named "You" takes the plain verb: "You win", "You are all-in".
  function you(line) {
    if (!/^You /.test(line)) return line;
    return line.replace(/^You has /, 'You have ').replace(/^You is /, 'You are ').replace(/^You (\w+?)s\b/, 'You $1').replace(/ and is all-in/, ' and are all-in');
  }
  function logl(g, s) { g.log.push(you(s)); }
  function cardsTxt(cs) { return '[' + cs.map(cardTxt).join(' ') + ']'; }
  function shuffle(g) {
    var d = [];
    for (var i = 0; i < 52; i++) d.push(i);
    for (i = 51; i > 0; i--) { var j = (rngNext(g) * (i + 1)) | 0, t = d[i]; d[i] = d[j]; d[j] = t; }
    g.deck = d; g.dp = 0;
  }
  function deal(g) { return g.deck[g.dp++]; }

  // Busts: a seat with no chips is out (tournament places count down from the field).
  function settleBusts(g) {
    var busted = g.seats.filter(function (s) { return !s.out && s.stack <= 0; });
    if (!busted.length) return busted;
    if (g.mode === 'tourney') {
      var left = alive(g).length;
      // bigger stack at the start of the hand finishes higher
      busted.sort(function (a, b) { return (b.startHand || 0) - (a.startHand || 0); });
      busted.forEach(function (s, k) { s.place = left - (busted.length - 1 - k); });
      busted.forEach(function (s) { s.out = true; g.bustN++; logl(g, s.name + ' is out in ' + ordinal(s.place) + ' place'); });
    } else busted.forEach(function (s) { s.out = true; s.broke = true; });
    return busted;
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // Start the next hand. Returns false when the game is over.
  function startHand(g) {
    if (g.street !== 'idle' && g.street !== 'done') return false;
    if (g.hist.length > 40) g.hist.splice(0, g.hist.length - 40);
    if (g.log.length) g.hist.push(g.log);
    g.log = []; g.ev = [];
    settleBusts(g);
    var al = alive(g);
    if (al.length < 2 || (g.mode === 'cash' && !al.some(function (s) { return s.kind === 'human'; }))) {
      g.over = true; g.street = 'done'; g.toAct = -1;
      g.winner = al.length === 1 ? al[0].id : -1;
      if (g.winner >= 0 && g.mode === 'tourney') g.seats[g.winner].place = 1;
      return false;
    }
    g.handNo++;
    if (g.mode === 'tourney') {
      var lv = levelOf(g, g.handNo);
      if (lv !== g.level) { g.level = lv; g.ev.push('level'); }
    }
    var bl = blindsFor(g);
    g.sbAmt = bl[0]; g.bbAmt = bl[1];
    g.seats.forEach(function (s) {
      s.hole = []; s.folded = false; s.allIn = false; s.bet = 0; s.total = 0; s.acted = false; s.actedAt = -1; s.mayRaise = true;
      s.last = ''; s.vp = false; s.pfr = false; s.aggN = 0; s.won = 0; s.startHand = s.stack; s.shown = false;
    });
    g.board = []; g.result = null; g.runout = false; g.exposed = false; g.lastAgg = -1;
    // the button moves to the next live seat; heads-up the button posts the small blind
    g.button = nextSeat(g, g.button < 0 ? -1 : g.button, isAlive);
    if (al.length === 2) { g.sb = g.button; g.bb = nextSeat(g, g.button, isAlive); }
    else { g.sb = nextSeat(g, g.button, isAlive); g.bb = nextSeat(g, g.sb, isAlive); }
    shuffle(g);
    logl(g, '--- Hand #' + g.handNo + ' --- blinds ' + g.sbAmt + '/' + g.bbAmt + (g.mode === 'tourney' ? ' (level ' + (g.level + 1) + ')' : ''));
    logl(g, g.seats[g.button].name + ' has the button');
    // two cards each, one at a time from the small blind round
    var order = [], i = g.sb;
    for (var k = 0; k < al.length; k++) { order.push(i); i = nextSeat(g, i, isAlive); }
    for (var r = 0; r < 2; r++) order.forEach(function (si) { g.seats[si].hole.push(deal(g)); });
    order.forEach(function (si) { g.stats[si].h++; });
    post(g, g.sb, g.sbAmt, 'small blind');
    post(g, g.bb, g.bbAmt, 'big blind');
    g.street = 'preflop';
    g.curBet = g.bbAmt; g.minRaise = g.bbAmt;
    g.ev.push('deal');
    g.toAct = firstToAct(g, g.bb);
    if (g.toAct < 0) closeRound(g);
    return true;
  }
  function post(g, si, amt, what) {
    var s = g.seats[si], a = Math.min(amt, s.stack);
    s.stack -= a; s.bet += a; s.total += a;
    if (s.stack === 0) s.allIn = true;
    s.last = what === 'small blind' ? 'SB ' + a : 'BB ' + a;
    logl(g, s.name + ' posts ' + what + ' ' + a + (s.allIn ? ' (all-in)' : ''));
  }
  // The next seat after `from` that still has a decision this round, or -1.
  // The biggest bet in front of anyone else still in the hand.
  function topOther(g, si) {
    var t = 0;
    for (var i = 0; i < g.seats.length; i++) if (i !== si && inHand(g.seats[i]) && g.seats[i].bet > t) t = g.seats[i].bet;
    return t;
  }
  function firstToAct(g, from) {
    var actors = 0, last = -1;
    for (var i = 0; i < g.seats.length; i++) if (canAct(g.seats[i])) { actors++; last = i; }
    if (actors === 0) return -1;
    if (actors === 1) {   // nobody left to bet against: only a call of a live bet remains
      var s = g.seats[last];
      return s.bet < Math.min(g.curBet, topOther(g, last)) ? last : -1;
    }
    return nextSeat(g, from, function (s) { return canAct(s) && (!s.acted || s.bet < g.curBet); });
  }

  // What the player to act may do.
  function legal(g) {
    var si = g.toAct;
    if (si < 0 || g.street === 'done' || g.street === 'idle') return null;
    var s = g.seats[si], maxTo = s.bet + s.stack;
    var others = g.seats.some(function (o, i) { return i !== si && canAct(o); });
    // with everyone else all-in, a call only has to match the biggest of their bets
    // (a big blind all-in for less than the small blind leaves nothing to call)
    var facing = others ? g.curBet : Math.min(g.curBet, topOther(g, si));
    var toCall = Math.max(0, Math.min(facing - s.bet, s.stack));
    var canRaise = s.mayRaise && others && maxTo > g.curBet;
    var minTo = Math.min(maxTo, g.curBet + Math.max(g.minRaise, g.bbAmt));
    return {
      seat: si, toCall: toCall, canCheck: s.bet >= facing, canCall: s.bet < facing, callAllIn: toCall >= s.stack,
      canRaise: canRaise, minTo: canRaise ? minTo : 0, maxTo: canRaise ? maxTo : 0, isBet: g.curBet === 0,
      pot: potTotal(g), stack: s.stack, bet: s.bet, curBet: g.curBet
    };
  }

  // Apply an action { type: 'fold'|'check'|'call'|'raise'|'allin', to } for the
  // player to act. Returns true if it was legal (an illegal one changes nothing).
  function act(g, a) {
    var L = legal(g);
    if (!L || !a) return false;
    var si = L.seat, s = g.seats[si], type = a.type;
    if (type === 'allin') {
      if (L.canRaise) { type = 'raise'; a = { type: 'raise', to: L.maxTo }; }
      else if (L.canCall) type = 'call';
      else type = 'check';
    }
    if (type === 'check' && !L.canCheck) return false;
    if (type === 'call' && !L.canCall) { if (L.canCheck) type = 'check'; else return false; }
    if (type === 'raise') {
      if (!L.canRaise) return false;
      var to = Math.round(+a.to);
      if (!(to >= L.minTo && to <= L.maxTo)) return false;
    }
    var pre = g.street === 'preflop';
    if (type === 'fold') {
      s.folded = true; s.last = 'fold';
      logl(g, s.name + ' folds');
      g.ev.push('fold');
    } else if (type === 'check') {
      s.last = 'check';
      logl(g, s.name + ' checks');
      g.ev.push('check');
    } else if (type === 'call') {
      var c = L.toCall;
      s.stack -= c; s.bet += c; s.total += c;
      if (s.stack === 0) s.allIn = true;
      s.last = s.allIn ? 'all-in ' + s.bet : 'call ' + c;
      logl(g, s.name + ' calls ' + c + (s.allIn ? ' and is all-in' : ''));
      if (pre && !s.vp) { s.vp = true; g.stats[si].vp++; }
      g.ev.push(s.allIn ? 'allin' : 'call');
    } else {
      var add = to - s.bet, size = to - g.curBet, wasBet = g.curBet === 0;
      s.stack -= add; s.bet = to; s.total += add;
      if (s.stack === 0) s.allIn = true;
      var full = size >= Math.max(g.minRaise, g.bbAmt);
      // A short all-in doesn't reopen the betting for a player who already acted,
      // unless the bets since their action add up to a full raise (TDA rule).
      var fullSize = Math.max(g.minRaise, g.bbAmt);
      g.seats.forEach(function (o, i) {
        if (i === si || !canAct(o)) return;
        if (full) o.mayRaise = true;
        else if (o.actedAt >= 0) o.mayRaise = to - o.actedAt >= fullSize;
        o.acted = false;
      });
      if (full) g.minRaise = size;
      g.curBet = to; g.lastAgg = si;
      s.last = (s.allIn ? 'all-in ' : wasBet ? 'bet ' : 'raise ') + to;
      logl(g, s.name + (wasBet ? ' bets ' + to : ' raises to ' + to) + (s.allIn ? ' and is all-in' : ''));
      if (pre) { if (!s.vp) { s.vp = true; g.stats[si].vp++; } if (!s.pfr) { s.pfr = true; g.stats[si].pfr++; } }
      else s.aggN++;
      g.ev.push(s.allIn ? 'allin' : wasBet ? 'bet' : 'raise');
    }
    s.acted = true; s.actedAt = g.curBet;
    if (type === 'raise') s.mayRaise = true;
    // one player left: they win without a showdown
    var live = g.seats.filter(inHand);
    if (live.length === 1) { returnUncalled(g); awardUncontested(g, live[0]); return true; }
    var nx = firstToAct(g, si);
    if (nx >= 0) g.toAct = nx;
    else closeRound(g);
    return true;
  }
  // The part of the top bet nobody matched goes back to its owner.
  function returnUncalled(g) {
    var top = -1, hi = 0, second = 0;
    g.seats.forEach(function (s, i) {
      if (s.bet > hi) { second = hi; hi = s.bet; top = i; }
      else if (s.bet > second) second = s.bet;
    });
    if (top >= 0 && hi > second) {
      var s = g.seats[top], back = hi - second;
      s.bet -= back; s.total -= back; s.stack += back;
      if (s.stack > 0) { s.allIn = false; if (/^all-in/.test(s.last)) s.last = (second ? 'raise ' : 'bet ') + s.bet; }
      logl(g, 'Uncalled bet (' + back + ') returned to ' + s.name);
    }
  }
  // End of a betting round: next street, a run-out, or the showdown.
  function closeRound(g) {
    returnUncalled(g);
    g.seats.forEach(function (s) { s.bet = 0; s.acted = false; s.actedAt = -1; s.mayRaise = true; if (canAct(s)) s.last = ''; });
    g.curBet = 0; g.minRaise = g.bbAmt; g.toAct = -1;
    var live = g.seats.filter(inHand), actors = live.filter(function (s) { return !s.allIn; });
    if (g.street === 'river') { showdown(g); return; }
    if (actors.length <= 1) {   // all-in: turn the cards over and run the board out
      if (!g.runout) {
        g.runout = true; g.exposed = true;
        live.forEach(function (s) { logl(g, s.name + ' shows ' + cardsTxt(s.hole)); });
        g.ev.push('runout');
      }
      return;
    }
    dealStreet(g);
    g.toAct = firstToAct(g, g.button);
    if (g.toAct < 0) closeRound(g);
  }
  function dealStreet(g) {
    var i = STREETS.indexOf(g.street);
    g.dp++;   // burn
    if (i === 0) { g.board.push(deal(g), deal(g), deal(g)); g.street = 'flop'; }
    else if (i === 1) { g.board.push(deal(g)); g.street = 'turn'; }
    else { g.board.push(deal(g)); g.street = 'river'; }
    logl(g, '*** ' + g.street.toUpperCase() + ' *** ' + cardsTxt(g.board));
    g.ev.push(g.street);
  }
  // While running out (no more betting): deal the next street, or show down after the river.
  function dealNext(g) {
    if (!g.runout || g.street === 'done') return false;
    if (g.street === 'river') showdown(g);
    else dealStreet(g);
    return true;
  }
  function awardUncontested(g, s) {
    var pot = potTotal(g);
    g.seats.forEach(function (o) { o.total = 0; o.bet = 0; });
    s.stack += pot; s.won = pot;
    logl(g, s.name + ' wins ' + pot + ' (uncontested)');
    g.result = { uncontested: true, pots: [{ amount: pot, winners: [s.id], elig: [s.id], name: '' }], shows: {} };
    endHand(g);
  }
  // Pots from each player's total contribution: a main pot and side pots by all-in level.
  function buildPots(g) {
    var seats = g.seats, contenders = seats.filter(inHand), levels = [], pots = [], prev = 0, i;
    contenders.forEach(function (s) { if (levels.indexOf(s.total) < 0 && s.total > 0) levels.push(s.total); });
    levels.sort(function (a, b) { return a - b; });
    for (i = 0; i < levels.length; i++) {
      var L = levels[i], amt = 0;
      seats.forEach(function (s) { amt += Math.min(s.total, L) - Math.min(s.total, prev); });
      var elig = contenders.filter(function (s) { return s.total >= L; }).map(function (s) { return s.id; });
      var last = pots[pots.length - 1];
      if (last && last.elig.join() === elig.join()) last.amount += amt;
      else if (amt > 0) pots.push({ amount: amt, elig: elig });
      prev = L;
    }
    var sum = 0;
    pots.forEach(function (p) { sum += p.amount; });
    var all = potTotal(g);
    if (pots.length && sum < all) pots[pots.length - 1].amount += all - sum;   // dead money above every contender
    return pots;
  }
  function showdown(g) {
    g.street = 'showdown';
    var live = g.seats.filter(inHand), shows = {}, i;
    live.forEach(function (s) {
      var b = best5(s.hole.concat(g.board));
      shows[s.id] = { v: b.v, cards: b.cards, name: handName(b.v) };
      s.shown = true;
      logl(g, s.name + ' shows ' + cardsTxt(s.hole) + ' — ' + handName(b.v));
    });
    var pots = buildPots(g), n = g.seats.length;
    pots.forEach(function (p, pi) {
      var best = -1, w = [];
      p.elig.forEach(function (id) { var v = shows[id].v; if (v > best) { best = v; w = [id]; } else if (v === best) w.push(id); });
      // odd chips: first winners clockwise from the button
      w.sort(function (a, b) { return ((a - g.button - 1 + n) % n) - ((b - g.button - 1 + n) % n); });
      var share = Math.floor(p.amount / w.length), odd = p.amount - share * w.length;
      w.forEach(function (id, k) {
        var amt = share + (k < odd ? 1 : 0), s = g.seats[id];
        s.stack += amt; s.won += amt;
      });
      p.winners = w; p.name = handName(best);
      var lbl = pots.length > 1 ? (pi === 0 ? 'the main pot' : 'side pot ' + pi) : 'the pot';
      if (w.length > 1) logl(g, w.map(function (id) { return g.seats[id].name; }).join(' & ') + ' split ' + lbl + ' (' + p.amount + ') with ' + p.name);
      else logl(g, g.seats[w[0]].name + ' wins ' + lbl + ' (' + p.amount + ') with ' + p.name);
    });
    g.seats.forEach(function (s) { s.total = 0; s.bet = 0; });
    g.result = { uncontested: false, pots: pots, shows: shows };
    endHand(g);
  }
  function endHand(g) {
    g.street = 'done'; g.toAct = -1; g.runout = false;
    g.ev.push('win');
    var al = g.seats.filter(function (s) { return !s.out && s.stack > 0; });
    if (al.length < 2 && g.mode === 'tourney') {
      settleBusts(g);
      g.over = true; g.winner = al.length ? al[0].id : -1;
      if (g.winner >= 0) { g.seats[g.winner].place = 1; logl(g, g.seats[g.winner].name + ' wins the tournament!'); }
    }
  }
  // Cash game: a busted seat buys back in (humans choose; CPUs are replaced).
  function rebuy(g, si) {
    var s = g.seats[si], st = STAKES[g.stakes] || STAKES.low;
    if (!s || g.mode !== 'cash' || s.stack > 0 || (g.street !== 'done' && g.street !== 'idle')) return false;
    s.stack = st.buyin; s.out = false; s.broke = false; s.buyins++;
    logl(g, s.name + ' buys in for ' + st.buyin);
    return true;
  }
  function replaceCpu(g, si, rnd) {
    var s = g.seats[si], st = STAKES[g.stakes] || STAKES.low;
    var taken = {};
    g.seats.forEach(function (o) { taken[o.name] = 1; });
    var pool = CPU_NAMES.filter(function (n) { return !taken[n]; }), nm = pool.length ? pool[(rnd() * pool.length) | 0] : 'Guest ' + (++g.nameN);
    var old = s.name;
    var ns = mkSeat({ kind: 'cpu', name: nm, style: STYLE_IDS[(rnd() * STYLE_IDS.length) | 0] }, si, st.buyin);
    g.seats[si] = ns;
    g.stats[si] = { h: 0, vp: 0, pfr: 0 };
    return old;
  }
  // Seats leaving: a human may stand up in cash games.
  function leave(g, si) {
    var s = g.seats[si];
    if (!s || (g.street !== 'done' && g.street !== 'idle')) return false;
    s.out = true; s.left = true;
    return true;
  }

  // ---- the computer players ----
  // How wide a range an opponent shows: from what they did this hand and (on
  // the higher levels) their habits so far. Returns the preflop percentile cut.
  function oppCut(g, o, diff) {
    var D = DIFFS[diff] || DIFFS.normal;
    if (!D.ranges) return 0;
    var st = g.stats[o.id], h = st ? st.h : 0, vpip = (st ? st.vp : 0) + 0.3 * 4, n = h + 4;
    var vr = Math.min(0.85, Math.max(0.1, vpip / n)), pr = Math.min(0.6, Math.max(0.05, ((st ? st.pfr : 0) + 0.12 * 4) / n));
    if (diff !== 'hard') { vr = 0.35; pr = 0.15; }
    var width = 1;
    if (o.pfr) width = pr * 1.4;
    else if (o.vp) width = vr;
    else if (g.street !== 'preflop' && o.id === g.bb) width = 1;   // checked the big blind: anything
    else width = Math.max(vr, 0.5);
    for (var k = 0; k < o.aggN; k++) width *= 0.7;
    width = Math.max(0.06, Math.min(1, width));
    return 1 - width;
  }
  function eqOpps(g, si) {
    return g.seats.filter(function (o, i) { return i !== si && inHand(o); }).map(function (o) { return { cut: oppCut(g, o, g.diff) }; });
  }
  // Seats left to act after `si` this street (a measure of position: 0 = last).
  function behind(g, si) {
    var n = g.seats.length, k = 0;
    if (g.street === 'preflop') {
      for (var j = 1; j < n; j++) { var i = (si + j) % n; if (canAct(g.seats[i])) k++; if (i === g.bb) break; }
      return si === g.bb ? 0 : k;
    }
    for (j = 1; j < n; j++) { i = (si + j) % n; if (canAct(g.seats[i])) k++; if (i === g.button) break; }
    return si === g.button ? 0 : k;
  }
  function roundTo(x, unit) { return Math.max(unit, Math.round(x / unit) * unit); }
  // Decide, given the equity the simulation found. rnd: a 0..1 source.
  function cpuDecide(g, si, eq, rnd) {
    var L = legal(g);
    if (!L || L.seat !== si) return null;
    var s = g.seats[si], st = STYLES[s.style] || STYLES.shark, D = DIFFS[g.diff] || DIFFS.normal;
    var bb = g.bbAmt, pot = L.pot, nOpp = Math.max(1, g.seats.filter(function (o, i) { return i !== si && inHand(o); }).length);
    var pre = g.street === 'preflop', pos = behind(g, si), late = pos === 0 || (pre && pos <= 1);
    var noise = (rnd() * 2 - 1) * D.noise;
    var e = Math.max(0, Math.min(1, eq + noise + (D.pos && late ? 0.03 : 0) - (D.pos && pos >= 3 ? 0.02 : 0)));
    var fair = 1 / (nOpp + 1), edge = (e - fair) / (1 - fair);   // 0 = an average hand, 1 = a lock
    var toCall = L.toCall, po = toCall > 0 ? toCall / (pot + toCall) : 0;
    var eff = s.stack + s.bet, spr = eff / Math.max(1, pot);
    var r = rnd();
    function raiseTo(x) {
      if (!L.canRaise) return toCall > 0 ? { type: 'call' } : { type: 'check' };
      var to = Math.round(x);
      if (to >= L.maxTo * 0.8) to = L.maxTo;      // most of the stack in: just shove
      to = Math.max(L.minTo, Math.min(L.maxTo, to));
      return { type: 'raise', to: to };
    }
    function potBet(frac) {   // a bet / raise of `frac` of the pot (after calling)
      return L.curBet + roundTo(Math.max(bb, (pot + toCall) * frac), Math.max(1, Math.round(bb / 2)));
    }
    if (pre) {
      var pf = pfPct(s.hole[0], s.hole[1]);
      // fewer players dealt in: every range widens (heads-up nearly doubles)
      var dealt = g.seats.filter(function (o) { return !o.out && o.hole.length === 2; }).length;
      var width = Math.min(0.9, st.vpip * Math.sqrt(6 / Math.max(2, dealt)) * (D.pos ? (late ? 1.3 : pos >= 3 ? 0.8 : 1) : 1));
      var raisers = g.seats.filter(function (o) { return o.pfr && inHand(o) && o.id !== si; }).length;
      var bbs = eff / bb;
      // short stacks: push or fold (the higher levels know this)
      if (D.pos && bbs <= 12 && toCall < s.stack) {
        var pushT = 1 - Math.min(0.6, st.vpip * (bbs <= 7 ? 1.5 : 1.1) * (late ? 1.3 : 1));
        if (pf >= pushT + raisers * 0.08) return { type: 'allin' };
        if (L.canCheck) return { type: 'check' };
        if (po < 0.2 && pf > pushT - 0.15) return { type: 'call' };
        return { type: 'fold' };
      }
      var playT = 1 - width - (noise * 0.5);
      if (raisers) playT = Math.min(0.97, playT + 0.12 + raisers * 0.06 + Math.min(0.15, (g.curBet / bb - 3) * 0.01));
      var raiseT = 1 - width * (0.25 + 0.45 * st.agg);
      if (raisers) raiseT = Math.max(raiseT, 0.92 - st.agg * 0.06);
      if (pf >= raiseT && L.canRaise && (r < 0.55 + st.agg * 0.45 || pf > 0.97)) {
        var limpers = g.seats.filter(function (o) { return o.vp && !o.pfr && o.id !== si && inHand(o); }).length;
        var target = raisers ? g.curBet * (2.6 + rnd() * 0.8) : bb * (2.2 + rnd() * 0.8 + st.agg * 0.5) + limpers * bb;
        return raiseTo(target);
      }
      // a light 3-bet / steal
      if (L.canRaise && r < st.bluff * (late ? 0.6 : 0.25) && pf > 0.35 && (!raisers || r < st.bluff * 0.2)) return raiseTo(raisers ? g.curBet * 3 : bb * 2.5);
      if (L.canCheck) return { type: 'check' };
      if (pf >= playT || (po <= 0.2 && pf >= playT - 0.12) || (s.id === g.sb && toCall <= bb / 2 && pf >= playT - 0.2 - st.vpip * 0.2)) {
        // facing a big bet, weaker hands lean on the equity the sim found
        if (toCall > eff * 0.35 && e < po + 0.04) return { type: 'fold' };
        return { type: 'call' };
      }
      return { type: 'fold' };
    }
    // ---- after the flop ----
    var valueT = 0.55 - 0.2 * st.agg;   // edge needed to bet / raise for value
    if (L.canCheck) {
      if (edge > valueT && L.canRaise) {
        var slow = edge > 0.8 && r < 0.18 * (1 - st.agg);   // slow-play a monster now and then
        if (!slow) return raiseTo(potBet(edge > 0.8 ? 0.65 + rnd() * 0.45 : 0.45 + rnd() * 0.3));
      }
      // bluffs: fewer opponents, later street, when last to act or the aggressor
      var bl = st.bluff * (nOpp === 1 ? 1.2 : nOpp === 2 ? 0.55 : 0.2) * (g.street === 'river' ? 1.1 : 1) * (late ? 1.4 : 0.8) * (g.lastAgg === si || s.pfr ? 1.5 : 1);
      if (L.canRaise && r < bl) return raiseTo(potBet(0.5 + rnd() * 0.35));
      return { type: 'check' };
    }
    // facing a bet
    var need = po * (1 - (st.vpip - 0.25) * 0.3);           // loose players call a little lighter
    var draws = g.street !== 'river' ? 0.02 : 0;               // implied odds while cards are to come
    if (edge > valueT + 0.2 && L.canRaise && r < 0.4 + st.agg * 0.6) {
      if (spr < 1.2 || (edge > 0.85 && r < 0.3)) return { type: 'allin' };
      return raiseTo(L.curBet + Math.max(L.curBet, (pot + toCall) * (0.6 + rnd() * 0.4)));
    }
    if (e + draws >= need) {
      if (L.canRaise && r < st.bluff * 0.18 && nOpp === 1 && g.street !== 'river') return raiseTo(L.curBet * 2.5 + pot * 0.3);
      return { type: 'call' };
    }
    if (L.canRaise && r < st.bluff * 0.1 && nOpp === 1 && toCall < pot * 0.5) return raiseTo(L.curBet * 3);
    return { type: 'fold' };
  }
  // Plays one CPU decision synchronously (the UI slices the simulation instead).
  function cpuActNow(g, rnd, iters) {
    var si = g.toAct;
    if (si < 0) return null;
    var s = g.seats[si], D = DIFFS[g.diff] || DIFFS.normal;
    var job = equityJob(s.hole, g.board, eqOpps(g, si), iters || D.iters, rnd);
    job.step();
    var a = cpuDecide(g, si, job.eq, rnd) || { type: 'fold' };
    if (!act(g, a)) act(g, legal(g).canCheck ? { type: 'check' } : { type: 'fold' });
    return a;
  }

  // ---- save normalisation: a game from storage is rebuilt field by field ----
  function isCard(c) { return typeof c === 'number' && c >= 0 && c < 52 && c === Math.floor(c); }
  function nonNeg(x) { x = Math.floor(+x); return isFinite(x) && x > 0 ? x : 0; }
  function normGame(o) {
    try {
      if (!o || typeof o !== 'object' || !Array.isArray(o.seats) || o.seats.length < 2 || o.seats.length > 6) return null;
      var g = newGame({
        mode: o.mode, diff: o.diff, speed: o.speed, stakes: o.stakes, stack: o.startStack, seed: o.rs | 0,
        seats: o.seats.map(function (s) { return { kind: s && s.kind === 'human' ? 'human' : 'cpu', name: s && s.name, style: s && s.style }; })
      });
      var seen = {}, okCards = true;
      function cards(a, max) {
        if (!Array.isArray(a)) return [];
        var out = [];
        a.slice(0, max).forEach(function (c) { if (isCard(c) && !seen[c]) { seen[c] = 1; out.push(c); } else okCards = false; });
        return out;
      }
      g.seats.forEach(function (s, i) {
        var q = o.seats[i] || {};
        s.stack = nonNeg(q.stack); s.bet = nonNeg(q.bet); s.total = Math.max(nonNeg(q.total), s.bet);
        s.hole = cards(q.hole, 2);
        ['folded', 'allIn', 'acted', 'out', 'vp', 'pfr', 'shown', 'broke', 'left'].forEach(function (k) { s[k] = !!q[k]; });
        s.mayRaise = q.mayRaise !== false;
        var aa = Math.floor(+q.actedAt); s.actedAt = isFinite(aa) && aa >= 0 ? aa : -1;
        s.place = nonNeg(q.place); s.aggN = nonNeg(q.aggN); s.won = nonNeg(q.won); s.buyins = Math.max(1, nonNeg(q.buyins));
        s.startHand = nonNeg(q.startHand); s.last = typeof q.last === 'string' ? q.last.slice(0, 24) : '';
      });
      g.board = cards(o.board, 5);
      var n = g.seats.length;
      function seatIdx(x) { x = Math.floor(+x); return x >= 0 && x < n ? x : -1; }
      g.button = seatIdx(o.button); g.sb = seatIdx(o.sb); g.bb = seatIdx(o.bb);
      g.sbAmt = nonNeg(o.sbAmt); g.bbAmt = nonNeg(o.bbAmt); g.level = nonNeg(o.level); g.handNo = nonNeg(o.handNo);
      g.curBet = nonNeg(o.curBet); g.minRaise = nonNeg(o.minRaise); g.lastAgg = seatIdx(o.lastAgg); g.toAct = seatIdx(o.toAct);
      g.runout = !!o.runout; g.exposed = !!o.exposed; g.over = !!o.over; g.winner = seatIdx(o.winner); g.bustN = nonNeg(o.bustN); g.nameN = nonNeg(o.nameN);
      g.street = ['idle', 'preflop', 'flop', 'turn', 'river', 'showdown', 'done'].indexOf(o.street) >= 0 ? o.street : 'idle';
      g.rs = (o.rs | 0) || 1;
      g.log = Array.isArray(o.log) ? o.log.filter(function (x) { return typeof x === 'string'; }).slice(-200) : [];
      g.hist = Array.isArray(o.hist) ? o.hist.filter(Array.isArray).slice(-40).map(function (h) { return h.filter(function (x) { return typeof x === 'string'; }); }) : [];
      g.stats = g.seats.map(function (s, i) { var q = (o.stats || [])[i] || {}; return { h: nonNeg(q.h), vp: nonNeg(q.vp), pfr: nonNeg(q.pfr) }; });
      if (o.result && typeof o.result === 'object' && Array.isArray(o.result.pots)) {
        g.result = {
          uncontested: !!o.result.uncontested,
          pots: o.result.pots.map(function (p) {
            return { amount: nonNeg(p && p.amount), winners: (p && Array.isArray(p.winners) ? p.winners : []).map(seatIdx).filter(function (x) { return x >= 0; }), elig: (p && Array.isArray(p.elig) ? p.elig : []).map(seatIdx).filter(function (x) { return x >= 0; }), name: p && typeof p.name === 'string' ? p.name : '' };
          }),
          shows: {}
        };
        var sh = o.result.shows || {};
        Object.keys(sh).forEach(function (k) {
          var id = seatIdx(k), q = sh[k];
          if (id < 0 || !q || !Array.isArray(q.cards)) return;
          var cs = q.cards.filter(isCard).slice(0, 5);
          g.result.shows[id] = { v: nonNeg(q.v), cards: cs, name: typeof q.name === 'string' ? q.name : '' };
        });
      }
      // the deck: the rest of a valid permutation (rebuilt if damaged)
      var deck = Array.isArray(o.deck) && o.deck.length === 52 ? o.deck : null, dseen = {};
      if (deck && deck.every(function (c) { if (!isCard(c) || dseen[c]) return false; dseen[c] = 1; return true; })) { g.deck = deck.slice(); g.dp = Math.min(52, nonNeg(o.dp)); }
      else okCards = false;
      if (!g.seats.some(function (s) { return s.kind === 'human'; })) return null;
      var mid = g.street !== 'idle' && g.street !== 'done';
      if (mid) {
        // a hand in progress must be consistent, or the hand is abandoned (bets back)
        var live = g.seats.filter(inHand);
        var bad = !okCards || live.length < 1 || (g.toAct >= 0 && !canAct(g.seats[g.toAct])) || (g.toAct < 0 && !g.runout) ||
          g.bbAmt <= 0 || g.button < 0 || g.seats.some(function (s) { return !s.out && !s.folded && s.hole.length !== 2; });
        if (bad) {
          g.seats.forEach(function (s) { s.stack += s.total; s.total = 0; s.bet = 0; s.hole = []; s.folded = false; s.allIn = false; });
          g.board = []; g.street = 'done'; g.toAct = -1; g.runout = false; g.result = null;
          if (!g.deck.length) shuffle(g);
        }
      }
      if (g.street === 'showdown') g.street = 'done';
      return g;
    } catch (e) { return null; }
  }
  // Records (kept for the human seats).
  function newRec() { return { hands: 0, won: 0, bigPot: 0, bestHand: 0, bestName: '', tourneys: 0, tWins: 0, bestPlace: 0, cashNet: 0, sessions: 0, showWon: 0, showdowns: 0 }; }
  function normRec(o) {
    var r = newRec();
    if (!o || typeof o !== 'object') return r;
    Object.keys(r).forEach(function (k) {
      if (k === 'bestName') r[k] = typeof o[k] === 'string' ? o[k].slice(0, 60) : '';
      else if (k === 'cashNet') { var x = Math.round(+o[k]); r[k] = isFinite(x) ? x : 0; }
      else r[k] = nonNeg(o[k]);
    });
    return r;
  }

  // Play whole games without a UI (tests, balancing).
  function simulate(cfg, maxHands, rnd, onStep) {
    var g = newGame(cfg);
    rnd = rnd || mkRng((cfg.seed || 1) ^ 0x5bd1);
    var hands = 0;
    while (!g.over && hands < (maxHands || 200)) {
      if (!startHand(g)) break;
      hands++;
      var guard = 0;
      while (g.street !== 'done' && guard++ < 500) {
        if (g.toAct >= 0) cpuActNow(g, rnd, cfg.iters || 60);
        else if (g.runout) dealNext(g);
        else break;
        if (onStep) onStep(g);
      }
    }
    return g;
  }

  var ENGINE = {
    RANKS: RANKS, SUITS: SUITS, SUIT_GLYPH: SUIT_GLYPH, CAT_NAME: CAT_NAME, STYLES: STYLES, STYLE_IDS: STYLE_IDS, DIFFS: DIFFS,
    LEVELS: LEVELS, SPEEDS: SPEEDS, STAKES: STAKES, CPU_NAMES: CPU_NAMES,
    rankOf: rankOf, suitOf: suitOf, cardStr: cardStr, cardTxt: cardTxt, parseCard: parseCard, parseCards: parseCards,
    mkRng: mkRng, rngNext: rngNext, evalHand: evalHand, catOf: catOf, handName: handName, best5: best5, straightHigh: straightHigh,
    chen: chen, pfPct: pfPct, pfClass: pfClass, equityJob: equityJob,
    newGame: newGame, startHand: startHand, legal: legal, act: act, dealNext: dealNext, buildPots: buildPots,
    potTotal: potTotal, chipsTotal: chipsTotal, blindsFor: blindsFor, handsToNextLevel: handsToNextLevel, alive: alive, inHand: inHand, canAct: canAct,
    you: you, rebuy: rebuy, replaceCpu: replaceCpu, leave: leave, settleBusts: settleBusts, ordinal: ordinal,
    oppCut: oppCut, eqOpps: eqOpps, behind: behind, cpuDecide: cpuDecide, cpuActNow: cpuActNow,
    normGame: normGame, newRec: newRec, normRec: normRec, simulate: simulate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('holdem.css');

  var PANEL_ID = 'holdem-panel', NAME = "Texas Hold'em";
  var KEY = 'cade-holdem-', GAME_KEY = KEY + 'game', CFG_KEY = KEY + 'cfg', REC_KEY = KEY + 'rec', SOUND_KEY = KEY + 'sound';
  var SLOTS = { 2: ['BC', 'TC'], 3: ['BC', 'TL', 'TR'], 4: ['BC', 'BL', 'TC', 'BR'], 5: ['BC', 'BL', 'TL', 'TR', 'BR'], 6: ['BC', 'BL', 'TL', 'TC', 'TR', 'BR'] };
  var PACE = { relaxed: { name: 'Relaxed', min: 700, max: 1200, deal: 650 }, brisk: { name: 'Brisk', min: 260, max: 480, deal: 380 } };
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.holdem = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function jget(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function rand() { return Math.random(); }

  // ---- setup (lobby) config ----
  function defaultCfg() {
    var st = STYLE_IDS.slice(), seats = [{ kind: 'human', name: 'You' }];
    for (var i = st.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0, t = st[i]; st[i] = st[j]; st[j] = t; }
    for (i = 0; i < 4; i++) seats.push({ kind: 'cpu', style: st[i] });
    return { mode: 'tourney', seats: seats, diff: 'normal', speed: 'normal', stakes: 'low', pace: 'relaxed' };
  }
  function normCfg(o) {
    var d = defaultCfg();
    if (!o || typeof o !== 'object') return d;
    var c = {
      mode: o.mode === 'cash' ? 'cash' : 'tourney', diff: DIFFS[o.diff] ? o.diff : 'normal', speed: SPEEDS[o.speed] ? o.speed : 'normal',
      stakes: STAKES[o.stakes] ? o.stakes : 'low', pace: PACE[o.pace] ? o.pace : 'relaxed', seats: []
    };
    (Array.isArray(o.seats) ? o.seats : []).slice(0, 6).forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      if (s.kind === 'human') c.seats.push({ kind: 'human', name: String(s.name || '').slice(0, 12) });
      else c.seats.push({ kind: 'cpu', style: STYLES[s.style] || s.style === 'random' ? s.style : 'random' });
    });
    if (c.seats.length < 2 || !c.seats.some(function (s) { return s.kind === 'human'; })) c.seats = d.seats;
    return c;
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
    card: function (s, d) { s.tone(1900, 0.025, 'triangle', 0.025, 1200, d || 0); },
    chips: function (s, n) { for (var i = 0; i < (n || 2); i++) s.tone(2300 + i * 260, 0.035, 'square', 0.014, 1700, i * 0.045); },
    check: function (s) { s.tone(260, 0.05, 'sine', 0.06, 180); s.tone(250, 0.05, 'sine', 0.05, 170, 0.09); },
    fold: function (s) { s.tone(330, 0.16, 'sine', 0.035, 160); },
    allin: function (s) { s.tone(220, 0.35, 'sawtooth', 0.02, 880); SFX.chips(s, 4); },
    turn: function (s) { s.tone(880, 0.09, 'sine', 0.035); s.tone(1320, 0.12, 'sine', 0.03, 0, 0.08); },
    win: function (s) { [523, 659, 784, 1047].forEach(function (f, i) { s.tone(f, 0.14, 'triangle', 0.035, 0, i * 0.07); }); },
    lose: function (s) { s.tone(392, 0.18, 'triangle', 0.03, 0); s.tone(311, 0.3, 'triangle', 0.03, 0, 0.16); },
    level: function (s) { s.tone(660, 0.1, 'square', 0.02); s.tone(990, 0.16, 'square', 0.02, 0, 0.1); },
    champ: function (s) { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.16, 'triangle', 0.035, 0, i * 0.09); }); }
  };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_LOG = svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>');
  var IC_HOME = svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>');

  // ---- cards (monospace faces) ----
  function rk(c) { var r = c >> 2; return r === 8 ? '10' : RANKS.charAt(r); }
  function cardHtml(c, cls, d) {
    var u = c & 3;
    return '<span class="hp-c ' + (u === 1 || u === 2 ? 'red' : 'blk') + (cls ? ' ' + cls : '') + '"' + (d != null ? ' style="--d:' + d + 'ms"' : '') +
      ' aria-label="' + esc(RANK_NAME[c >> 2] + ' of ' + ['spades', 'hearts', 'diamonds', 'clubs'][u]) + '"><b>' + rk(c) + '</b><i>' + SUIT_GLYPH[u] + '</i></span>';
  }
  function backHtml(cls, d) { return '<span class="hp-c back' + (cls ? ' ' + cls : '') + '"' + (d != null ? ' style="--d:' + d + 'ms"' : '') + ' aria-label="face-down card"><i>##<br>##</i></span>'; }
  function slotHtml() { return '<span class="hp-c slot" aria-hidden="true"></span>'; }

  // ---- persistence ----
  function persist() {
    if (!S || !S.g) return;
    var g = S.g, o = {};
    for (var k in g) if (k !== 'ev') o[k] = g[k];
    if (o.hist && o.hist.length > 25) o.hist = o.hist.slice(-25);
    try { sset(GAME_KEY, JSON.stringify(o)); } catch (e) {}
  }
  function saveRec() { if (S) sset(REC_KEY, JSON.stringify(S.rec)); }
  function saveCfg() { if (S) sset(CFG_KEY, JSON.stringify(S.cfg)); }

  // ---- who sees what ----
  function humans(g) { return g.seats.filter(function (s) { return s.kind === 'human'; }); }
  function multi() { return S.g && humans(S.g).length > 1; }
  function heroSeat(g) { for (var i = 0; i < g.seats.length; i++) if (g.seats[i].kind === 'human') return i; return 0; }
  function faceUp(g, i) {
    var s = g.seats[i];
    if (!s.hole.length) return false;
    if (g.result && !g.result.uncontested && g.result.shows[i]) return true;
    if (g.exposed && inHand(s)) return true;
    return mine(g, i);
  }
  // A human's own cards: always on show with one human; with several, only while they hold the device.
  function mine(g, i) { return g.seats[i].kind === 'human' && (!multi() || S.revealed === i); }

  // ---- rendering ----
  function seatHtml(g, i, slot) {
    var s = g.seats[i], st = STYLES[s.style], cls = 'hp-seat';
    var res = g.result, won = res && s.won > 0, show = res && res.shows[i];
    if (s.out) cls += ' out';
    else if (s.folded) cls += ' fold';
    if (g.toAct === i && g.street !== 'done') cls += ' act';
    if (S.thinking === i) cls += ' think';
    if (won && g.street === 'done') cls += ' win';
    if (s.kind === 'human') cls += ' human';
    if (slot === 'BC') cls += ' hero';
    var badges = '';
    if (!s.out && g.street !== 'idle') {
      if (i === g.button) badges += '<b class="hp-btn" title="Dealer button">D</b>';
      if (i === g.sb && g.seats.filter(function (x) { return !x.out; }).length > 2) badges += '<i>SB</i>';
      if (i === g.bb) badges += '<i>BB</i>';
    }
    var h = '<div class="' + cls + '" data-slot="' + slot + '" data-seat="' + i + '">';
    h += '<div class="hp-sn"><span class="hp-name">' + esc(s.name) + '</span>' + (badges ? '<span class="hp-bdg">' + badges + '</span>' : '') + '</div>';
    h += '<div class="hp-sub">' + (s.kind === 'cpu' ? '<span class="hp-sty" title="' + esc(st ? st.tag : '') + '">' + esc(st ? st.name.toLowerCase() : 'cpu') + '</span>' : '<span class="hp-sty you">' + (multi() ? 'player' : 'you') + '</span>') +
      '<span class="hp-stack">' + (s.out ? (g.mode === 'tourney' && s.place ? ordinal(s.place) : 'out') : '$' + fmt(s.stack)) + '</span></div>';
    // the hole cards
    var hole = '';
    if (s.hole.length === 2 && !s.out) {
      var fresh = S.dealtHand !== g.handNo, up = faceUp(g, i);
      if (s.folded && !mine(g, i)) hole = '<span class="hp-mucked">folded</span>';
      else for (var k = 0; k < 2; k++) {
        var d = fresh ? (k * g.seats.length + seatOrder(g, i)) * 70 : null, c2 = fresh ? 'hp-new' : '';
        if (up) {
          var hi = show && g.street === 'done' ? (show.cards.indexOf(s.hole[k]) >= 0 ? (won ? ' hi' : '') : ' lo') : '';
          hole += cardHtml(s.hole[k], c2 + hi, d);
        } else hole += backHtml(c2, d);
      }
    } else if (s.out) hole = '<span class="hp-mucked">' + (s.left ? 'left' : 'busted') + '</span>';
    h += '<div class="hp-hole">' + hole + '</div>';
    // the status line: action, thinking, the hand shown, the win
    var line = '', lc = '';
    if (S.thinking === i) { line = 'thinking<span class="hp-dots"></span>'; lc = 'th'; }
    else if (g.street === 'done' && won) { line = '+' + fmt(s.won); lc = 'won'; }
    else if (show && g.street === 'done') { line = esc(shortHand(show.v)); lc = 'sh'; }
    else if (s.last && s.last !== 'fold' && !/^[SB]B /.test(s.last)) { line = esc(s.last); lc = /^(raise|bet|all)/.test(s.last) ? 'agg' : s.last === 'fold' ? 'f' : ''; }
    if (show && g.street === 'done' && won) line += ' <span class="hp-hn">' + esc(shortHand(show.v)) + '</span>';
    h += '<div class="hp-sa ' + lc + '">' + (line || '&nbsp;') + '</div>';
    if (s.bet > 0 && g.street !== 'done') h += '<div class="hp-bet"><span>&#9679;</span>' + fmt(s.bet) + '</div>';
    return h + '</div>';
  }
  // Compact hand names for the narrow seats: "Two pair K/7", "Flush J-hi", "Full 8/4".
  function shortHand(v) {
    var k = kicks(v), R = function (i) { return k[i] === 8 ? '10' : RANKS.charAt(k[i]); };
    switch (catOf(v)) {
      case 8: return k[0] === 12 ? 'Royal flush' : 'Str. flush ' + R(0) + '-hi';
      case 7: return 'Quads ' + R(0);
      case 6: return 'Full ' + R(0) + '/' + R(1);
      case 5: return 'Flush ' + R(0) + '-hi';
      case 4: return 'Straight ' + R(0) + '-hi';
      case 3: return 'Trips ' + R(0);
      case 2: return 'Two pair ' + R(0) + '/' + R(1);
      case 1: return 'Pair of ' + R(0) + (k[0] === 8 ? 's' : 's');
      default: return R(0) + ' high';
    }
  }
  function seatOrder(g, i) { var n = g.seats.length; return (i - g.sb + n) % n; }
  // The pots as they stand from earlier streets (this street's bets are still in front of the players).
  function settledPots(g) {
    var bets = g.seats.map(function (x) { return x.bet; });
    g.seats.forEach(function (x) { x.total -= x.bet; });
    var pots = buildPots(g);
    g.seats.forEach(function (x, i) { x.total += bets[i]; });
    return pots.filter(function (p) { return p.elig.length > 1; });
  }
  function midHtml(g) {
    var h = '<div class="hp-mid">';
    var info = '';
    if (g.street !== 'idle') {
      info = 'Hand ' + g.handNo + ' &middot; blinds ' + fmt(g.sbAmt) + '/' + fmt(g.bbAmt);
      if (g.mode === 'tourney') {
        var nx = handsToNextLevel(g);
        info += g.level + 1 < LEVELS.length ? ' &middot; up in ' + nx : '';
      } else info += ' &middot; cash';
    }
    h += '<div class="hp-info">' + info + '</div>';
    // the board
    var res = g.result, win = res && !res.uncontested && res.pots.length ? res.shows[res.pots[0].winners[0]] : null;
    h += '<div class="hp-board">';
    for (var k = 0; k < 5; k++) {
      if (k < g.board.length) {
        var c = g.board[k], cls = k >= S.seenBoard ? 'hp-new' : '';
        if (win && g.street === 'done') cls += win.cards.indexOf(c) >= 0 ? ' hi' : ' lo';
        h += cardHtml(c, cls, k >= S.seenBoard ? (k - S.seenBoard) * 120 : null);
      } else h += slotHtml();
    }
    h += '</div>';
    var pot = potTotal(g), pots = g.street !== 'done' && pot && g.seats.some(function (x) { return inHand(x) && x.allIn; }) ? settledPots(g) : [];
    var pl = '';
    if (g.street === 'done' && res) {
      pl = res.pots.map(function (p, pi) { return (res.pots.length > 1 ? (pi ? 'side ' : 'main ') : 'pot ') + fmt(p.amount); }).join(' &middot; ');
    } else if (pot) {
      pl = 'POT <b>' + fmt(pot) + '</b>';
      if (pots.length > 1) pl += ' <span>(' + pots.map(function (p, pi) { return (pi ? 'side ' : 'main ') + fmt(p.amount); }).join(', ') + ')</span>';
    }
    h += '<div class="hp-pot">' + (pl || '&nbsp;') + '</div>';
    h += '<div class="hp-msg">' + (S.msg || '&nbsp;') + '</div>';
    return h + '</div>';
  }
  function renderTable() {
    var g = S.g;
    if (!g) { S.felt.innerHTML = idleFelt(); return; }
    var n = g.seats.length, hero = heroSeat(g), map = SLOTS[n] || SLOTS[6], h = '';
    for (var i = 0; i < n; i++) h += seatHtml(g, i, map[(i - hero + n) % n]);
    h += midHtml(g);
    S.felt.className = 'hp-felt n' + n;
    S.felt.innerHTML = h;
    if (g.street !== 'idle') S.dealtHand = g.handNo;
    S.seenBoard = g.board.length;
  }
  function idleFelt() {
    var deco = [48, 45, 38, 33, 12];
    return '<div class="hp-mid"><div class="hp-info">&nbsp;</div><div class="hp-board">' + deco.map(function (c) { return cardHtml(c, 'lo'); }).join('') + '</div><div class="hp-pot">&nbsp;</div><div class="hp-msg">&nbsp;</div></div>';
  }

  // ---- the action bar ----
  function stepOf(g) { return Math.max(1, g.sbAmt || 1); }
  function presetTo(L, frac) {
    var to = L.curBet + Math.round((L.pot + L.toCall) * frac);
    return Math.max(L.minTo, Math.min(L.maxTo, to));
  }
  function renderBar() {
    var g = S.g, h = '';
    S.barMode = '';
    if (!g) { S.bar.innerHTML = '<div class="hp-wait">&nbsp;</div>'; return; }
    if (g.over) {
      S.barMode = 'over';
      h = '<div class="hp-acts"><button type="button" class="hp-a pri" data-act="over">Results</button></div>';
    } else if (g.street === 'done' || g.street === 'idle') {
      S.barMode = 'next';
      h = '<div class="hp-acts"><button type="button" class="hp-a alt" data-act="log">Hand log</button>' +
        (g.mode === 'cash' && g.street === 'done' ? '<button type="button" class="hp-a alt' + (S.cashArm ? ' arm' : '') + '" data-act="cashout">' + (S.cashArm ? 'Sure? End it' : 'Cash out') + '</button>' : '') +
        '<button type="button" class="hp-a pri" data-act="next">' + (g.street === 'idle' ? 'Deal' : 'Next hand') + (S.coarse ? '' : ' <small>enter</small>') + '</button></div>';
    } else if (g.toAct >= 0 && g.seats[g.toAct].kind === 'human' && S.revealed === g.toAct && !S.card) {
      S.barMode = 'act';
      var L = legal(g), s = g.seats[g.toAct];
      if (S.raise == null || S.raiseFor !== g.toAct + ':' + g.street + ':' + g.curBet) { S.raise = L.minTo; S.raiseFor = g.toAct + ':' + g.street + ':' + g.curBet; }
      if (L.canRaise) {
        S.raise = Math.max(L.minTo, Math.min(L.maxTo, S.raise));
        var st = stepOf(g);
        h += '<div class="hp-sz">' +
          '<button type="button" class="hp-p" data-to="' + L.minTo + '">Min</button>' +
          '<button type="button" class="hp-p" data-to="' + presetTo(L, 0.5) + '">1/2</button>' +
          '<button type="button" class="hp-p" data-to="' + presetTo(L, 0.75) + '">3/4</button>' +
          '<button type="button" class="hp-p" data-to="' + presetTo(L, 1) + '">Pot</button>' +
          '<button type="button" class="hp-p" data-to="' + L.maxTo + '">All-in</button>' +
          '<span class="hp-rng"><button type="button" class="hp-p sq" data-nudge="-1" aria-label="Less">&minus;</button>' +
          '<input type="range" class="hp-slider" min="' + L.minTo + '" max="' + L.maxTo + '" step="' + st + '" value="' + S.raise + '" aria-label="Raise amount">' +
          '<button type="button" class="hp-p sq" data-nudge="1" aria-label="More">+</button></span></div>';
      }
      var callLbl = L.canCall ? (L.callAllIn ? 'Call all-in <b>' + fmt(L.toCall) + '</b>' : 'Call <b>' + fmt(L.toCall) + '</b>') : 'Check';
      h += '<div class="hp-acts">' +
        '<button type="button" class="hp-a fold" data-act="fold">Fold' + (S.coarse ? '' : ' <small>F</small>') + '</button>' +
        '<button type="button" class="hp-a" data-act="call">' + callLbl + (S.coarse ? '' : ' <small>C</small>') + '</button>' +
        (L.canRaise ? '<button type="button" class="hp-a pri" data-act="raise">' + raiseLbl(L) + (S.coarse ? '' : ' <small>R</small>') + '</button>' : '') + '</div>';
      // a coaching line: what you hold and what calling costs
      var hint = [], b = g.board;
      hint.push(b.length >= 3 ? handName(evalHand(s.hole.concat(b))) : pfClass(s.hole[0], s.hole[1]) + ' (top ' + Math.max(1, Math.round((1 - pfPct(s.hole[0], s.hole[1])) * 100)) + '%)');
      if (L.canCall) hint.push('pot odds ' + Math.round(L.toCall / (L.pot + L.toCall) * 100) + '%');
      if (multi()) hint.unshift(esc(s.name));
      h += '<div class="hp-hint">' + hint.map(esc).join(' &middot; ') + '</div>';
    } else {
      var who = g.toAct >= 0 ? g.seats[g.toAct] : null, txt;
      if (g.runout) txt = 'All in &mdash; running out the board';
      else if (who && who.kind === 'human') txt = 'Waiting for ' + esc(who.name);
      else if (who) txt = esc(who.name) + ' is thinking<span class="hp-dots"></span>';
      else txt = '&nbsp;';
      h = '<div class="hp-wait">' + txt + '</div>';
    }
    S.bar.innerHTML = h;
  }
  function raiseLbl(L) {
    var to = S.raise;
    if (to >= L.maxTo) return 'All-in <b>' + fmt(L.maxTo) + '</b>';
    return (L.isBet ? 'Bet ' : 'Raise to ') + '<b>' + fmt(to) + '</b>';
  }
  function syncRaise() {
    var g = S.g, L = g && legal(g);
    if (!L || !L.canRaise) return;
    var b = S.bar.querySelector('[data-act="raise"]'), sl = S.bar.querySelector('.hp-slider');
    if (b) b.innerHTML = raiseLbl(L) + (S.coarse ? '' : ' <small>R</small>');
    if (sl && +sl.value !== S.raise) sl.value = S.raise;
  }
  function render() {
    if (!S) return;
    renderTable(); renderBar(); syncHead();
  }
  function syncHead() {
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    S.head.querySelector('[data-h="log"]').disabled = !S.g;
    S.head.querySelector('[data-h="home"]').disabled = !S.g || S.card === 'home';
  }
  function say(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- cards over the table ----
  function showCard(kind) {
    S.card = kind || null;
    var h = '';
    if (kind === 'home') h = homeHtml();
    else if (kind === 'help') h = helpHtml();
    else if (kind === 'log') h = logHtml();
    else if (kind === 'pass') h = passHtml();
    else if (kind === 'over') h = overHtml();
    else if (kind === 'rebuy') h = rebuyHtml();
    else if (kind === 'records') h = recordsHtml();
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.wrap.classList.toggle('dim', !!kind);
    // no game on: the lobby cards sit in the panel's flow (it scrolls when tall)
    S.wrap.classList.toggle('lobby', !!kind && !S.g);
    S.panel.classList.toggle('hp-lobby', !!kind && !S.g);
    S.ovl.scrollTop = 0;
    if (kind) {
      var f = S.ovl.querySelector('.hp-go:not(.alt)') || S.ovl.querySelector('button');
      if (f && !S.coarse && kind !== 'home') { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
    renderBar(); syncHead();
  }
  function closeCard() {
    var k = S.card;
    S.card = null;
    S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.wrap.classList.remove('dim', 'lobby'); S.panel.classList.remove('hp-lobby');
    if (k === 'help' && !S.g) { showCard('home'); return; }
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
    flow();
  }
  function seg(name, opts, cur) {
    return '<div class="hp-seg" role="radiogroup">' + opts.map(function (o) {
      return '<button type="button" role="radio" aria-checked="' + (o[0] === cur) + '" class="' + (o[0] === cur ? 'on' : '') + '" data-set="' + name + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function homeHtml() {
    var c = S.cfg, sv = S.saved, h = '<div class="hp-card hp-home">';
    h += '<pre class="hp-art" aria-hidden="true">' + esc(".---.  .---.\n|A  |  |K  |\n| ♠ |  | ♥ |\n'---'  '---'") + '</pre>';
    h += '<div class="hp-title">TEXAS HOLD\'EM</div>';
    if (sv) {
      var left = sv.seats.filter(function (s) { return !s.out; }).length;
      h += '<button type="button" class="hp-go" data-act="continue">Continue &mdash; ' + (sv.mode === 'cash' ? 'cash game' : 'tournament') + ', hand ' + sv.handNo + ', ' + left + ' at the table</button>';
      h += '<div class="hp-h">or a new game</div>';
    }
    h += '<div class="hp-sec"><div class="hp-h">Game</div>' + seg('mode', [['tourney', 'Tournament'], ['cash', 'Cash game']], c.mode) + '</div>';
    h += '<div class="hp-sec"><div class="hp-h">Players <span>' + c.seats.length + ' seats &middot; tap to switch human / CPU</span></div><div class="hp-rows">';
    c.seats.forEach(function (s, i) {
      h += '<div class="hp-row"><span class="hp-ix">' + (i + 1) + '</span>';
      h += '<button type="button" class="hp-kind ' + s.kind + '" data-kind="' + i + '" title="Switch human / computer">' + (s.kind === 'human' ? 'Human' : 'CPU') + '</button>';
      if (s.kind === 'human') h += '<input class="hp-in" type="text" maxlength="12" autocomplete="off" spellcheck="false" data-name="' + i + '" value="' + esc(s.name || '') + '" placeholder="Player ' + (i + 1) + '" aria-label="Name of player ' + (i + 1) + '">';
      else {
        var st = STYLES[s.style];
        h += '<button type="button" class="hp-style" data-style="' + i + '" title="Change style">' + (st ? esc(st.name) + ' <i>' + esc(st.tag) + '</i>' : 'Random <i>any style</i>') + '</button>';
      }
      h += c.seats.length > 2 ? '<button type="button" class="hp-del" data-del="' + i + '" aria-label="Remove seat ' + (i + 1) + '">&times;</button>' : '<span class="hp-del"></span>';
      h += '</div>';
    });
    h += '</div>' + (c.seats.length < 6 ? '<button type="button" class="hp-lnk" data-act="add">+ add a seat</button>' : '') + '</div>';
    h += '<div class="hp-sec"><div class="hp-h">Computer level</div>' + seg('diff', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], c.diff) + '</div>';
    if (c.mode === 'tourney') h += '<div class="hp-sec"><div class="hp-h">Blinds go up <span>1,500 chips each</span></div>' + seg('speed', [['slow', 'Slowly'], ['normal', 'Steadily'], ['turbo', 'Turbo']], c.speed) + '</div>';
    else h += '<div class="hp-sec"><div class="hp-h">Stakes <span>buy in for 100 big blinds</span></div>' + seg('stakes', [['low', '5/10 ($1,000)'], ['mid', '25/50 ($5,000)']], c.stakes) + '</div>';
    h += '<div class="hp-sec"><div class="hp-h">Table pace</div>' + seg('pace', [['relaxed', 'Relaxed'], ['brisk', 'Brisk']], c.pace) + '</div>';
    if (S.newArm) h += '<div class="hp-confirm">Start over? The saved game is lost. <button type="button" class="hp-lnk danger" data-act="start-yes">Deal anyway</button> <button type="button" class="hp-lnk" data-act="start-no">Keep it</button></div>';
    h += '<button type="button" class="hp-go' + (sv ? ' alt' : '') + '" data-act="start">Shuffle up and deal</button>';
    h += '<div class="hp-foot"><button type="button" class="hp-lnk" data-act="records">Records</button><button type="button" class="hp-lnk" data-act="help">How to play</button></div>';
    return h + '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ? '' : '<div class="hp-keys"><div><b>F</b> fold &nbsp; <b>C</b> check / call &nbsp; <b>R</b> bet / raise</div><div><b>&uarr; &darr;</b> size the raise &nbsp; <b>A</b> all-in size</div><div><b>Enter</b> next hand &nbsp; <b>L</b> hand log &nbsp; <b>Esc</b> close</div></div>';
    var ranks = [
      ['Royal flush', 'A♠ K♠ Q♠ J♠ 10♠'], ['Straight flush', '9♥ 8♥ 7♥ 6♥ 5♥'], ['Four of a kind', 'Q Q Q Q 7'],
      ['Full house', 'K K K 4 4'], ['Flush', 'any five of one suit'], ['Straight', '9 8 7 6 5 (A-2-3-4-5 too)'],
      ['Three of a kind', '8 8 8 K 2'], ['Two pair', 'J J 4 4 A'], ['Pair', '10 10 A 7 3'], ['High card', 'A J 9 6 2']
    ];
    var h = '<div class="hp-card hp-help"><div class="hp-title">HOW TO PLAY</div>';
    h += '<p>Everyone gets <b>two hole cards</b>; five <b>community cards</b> come face up &mdash; three on the <b>flop</b>, one on the <b>turn</b>, one on the <b>river</b> &mdash; with a round of betting before each and after the last. Your best <b>five of seven</b> wins the pot, or bet so well that everyone else folds.</p>';
    h += '<p><b>No limit</b>: you may bet any amount up to your whole stack. A raise must be at least the size of the last bet or raise; an all-in for less doesn&rsquo;t reopen the betting. When someone is all-in, side pots keep it fair.</p>';
    h += '<pre class="hp-tab">' + ranks.map(function (r) { return '<b>' + esc(r[0]) + '</b>' + new Array(17 - r[0].length).join(' ') + esc(r[1]); }).join('\n') + '</pre>';
    h += '<p><b>Tournament</b>: everyone starts with 1,500 and the blinds rise every few hands; last player with chips wins. <b>Cash game</b>: blinds stay put, you can rebuy, computer players come and go; <b>Cash out</b> between hands to end the session and see your net result.</p>';
    h += '<p><b>Computer players</b> each have a style: <b>Shark</b> (tight, aggressive), <b>Rock</b> (only premium hands), <b>Loose Cannon</b> (plays and raises a lot), <b>Calling Station</b> (calls too much), <b>Bluffer</b> and <b>Maniac</b>. They estimate their chances by simulating the hands you might hold.</p>';
    h += '<p><b>Pass and play</b>: seat two or more humans. Between turns the screen asks you to pass the device, and only the player to act sees their cards.</p>';
    h += keys + '<button type="button" class="hp-go" data-act="close">Back</button></div>';
    return h;
  }
  function logHtml() {
    var g = S.g, hands = [];
    if (g) { if (g.log.length) hands.push(g.log); for (var i = g.hist.length - 1; i >= 0 && hands.length < 12; i--) hands.push(g.hist[i]); }
    var h = '<div class="hp-card hp-logc"><div class="hp-title">HAND LOG</div>';
    h += hands.length ? hands.map(function (L) {
      return '<pre class="hp-log">' + L.map(function (x) {
        if (/^--- /.test(x)) return '<b>' + esc(x) + '</b>';
        if (/^\*\*\* /.test(x)) return '<i>' + esc(x) + '</i>';
        if (/ wins | split /.test(x)) return '<span class="g">' + esc(x) + '</span>';
        return esc(x);
      }).join('\n') + '</pre>';
    }).join('') : '<p>No hands yet.</p>';
    return h + '<button type="button" class="hp-go" data-act="close">Back to the table</button></div>';
  }
  function passHtml() {
    var s = S.g.seats[S.g.toAct];
    return '<div class="hp-card hp-pass"><div class="hp-title">PASS</div>' +
      '<pre class="hp-art" aria-hidden="true">' + esc(".---. .---.\n|## | |## |\n| ##| | ##|\n'---' '---'") + '</pre>' +
      '<p class="hp-c1">Hand the device to <b>' + esc(s.name) + '</b>.</p><p class="hp-note">Everyone else, look away &mdash; the next screen shows ' + esc(s.name) + '&rsquo;s cards.</p>' +
      '<button type="button" class="hp-go" data-act="reveal">I&rsquo;m ' + esc(s.name) + ' &mdash; show my cards</button></div>';
  }
  function rebuyHtml() {
    var g = S.g, s = g.seats[S.rebuySeat], st = STAKES[g.stakes] || STAKES.low;
    return '<div class="hp-card"><div class="hp-title">BUSTED</div><p class="hp-c1"><b>' + esc(s.name) + '</b> is out of chips.</p>' +
      '<p class="hp-note">Buy-ins so far: ' + s.buyins + ' ($' + fmt(s.buyins * st.buyin) + ')</p>' +
      '<div class="hp-btns"><button type="button" class="hp-go" data-act="rebuy">Rebuy $' + fmt(st.buyin) + '</button><button type="button" class="hp-go alt" data-act="leave">Leave the table</button></div></div>';
  }
  function overHtml() {
    var g = S.g, h = '<div class="hp-card hp-over">', st = STAKES[g.stakes] || STAKES.low;
    if (g.mode === 'tourney') {
      var w = g.seats[g.winner], hw = w && w.kind === 'human';
      h += '<div class="hp-title">' + (hw ? 'CHAMPION' : 'TOURNAMENT OVER') + '</div>';
      h += '<div class="hp-big">' + esc(w ? w.name : '?') + '</div><div class="hp-sub">' + (hw ? 'takes every chip &mdash; well played' : 'wins the tournament') + '</div>';
      var order = g.seats.slice().sort(function (a, b) { return (a.place || 99) - (b.place || 99); });
      h += '<pre class="hp-tab">' + order.map(function (s) {
        var p = ordinal(s.place || g.seats.length), nm = s.name + (s.kind === 'cpu' ? ' (' + (STYLES[s.style] || STYLES.shark).name.toLowerCase() + ')' : '');
        return (s.kind === 'human' ? '<span class="g">' : '') + esc(p + new Array(6 - p.length).join(' ') + nm) + (s.kind === 'human' ? '</span>' : '');
      }).join('\n') + '</pre>';
      h += '<div class="hp-note">' + g.handNo + (g.handNo === 1 ? ' hand' : ' hands') + ' played</div>';
    } else {
      h += '<div class="hp-title">SESSION OVER</div>';
      h += '<pre class="hp-tab">' + humans(g).map(function (s) {
        var net = s.stack - s.buyins * st.buyin;
        return esc(s.name) + new Array(Math.max(2, 16 - s.name.length)).join(' ') + '<b>' + (net >= 0 ? '+' : '') + fmt(net) + '</b>';
      }).join('\n') + '</pre><div class="hp-note">' + g.handNo + (g.handNo === 1 ? ' hand' : ' hands') + ' played</div>';
    }
    return h + '<div class="hp-btns"><button type="button" class="hp-go" data-act="again">Play again</button><button type="button" class="hp-go alt" data-act="lobby">Lobby</button></div></div>';
  }
  function recordsHtml() {
    var r = S.rec;
    function line(a, b) { return esc(a) + new Array(Math.max(2, 27 - a.length - b.length)).join(' ') + '<b>' + esc(b) + '</b>'; }
    var rows = [
      line('Hands played', fmt(r.hands)), line('Hands won', fmt(r.won) + (r.hands ? ' (' + Math.round(r.won / r.hands * 100) + '%)' : '')),
      line('Showdowns won', r.showdowns ? r.showWon + '/' + r.showdowns : '-'), line('Biggest pot', r.bigPot ? '$' + fmt(r.bigPot) : '-'),
      line('Tournaments', fmt(r.tourneys)), line('Tournament wins', fmt(r.tWins)), line('Best finish', r.bestPlace ? ordinal(r.bestPlace) : '-'),
      line('Cash sessions', fmt(r.sessions)), line('Best cash session', r.sessions ? (r.cashNet >= 0 ? '+' : '') + fmt(r.cashNet) : '-')
    ];
    var h = '<div class="hp-card"><div class="hp-title">RECORDS</div><pre class="hp-tab">' + rows.join('\n') + '</pre>';
    if (r.bestName) h += '<div class="hp-note">Best hand: <b>' + esc(r.bestName) + '</b></div>';
    h += '<div class="hp-foot">' + (S.resetArm ? '<span class="hp-confirm">Erase all records?</span><span><button type="button" class="hp-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="hp-lnk" data-act="reset-no">Keep</button></span>' :
      '<span></span><button type="button" class="hp-lnk" data-act="reset">Reset records</button>') + '</div>';
    return h + '<button type="button" class="hp-go" data-act="lobby">Back</button></div>';
  }

  // ---- records ----
  function recordHand(g) {
    if (S.recorded === g.handNo + ':' + g.seats.length) return;
    S.recorded = g.handNo + ':' + g.seats.length;
    var r = S.rec, pot = 0;
    if (g.result) g.result.pots.forEach(function (p) { pot += p.amount; });
    humans(g).forEach(function (s) {
      if (s.hole.length !== 2 || (s.out && !s.startHand)) return;
      r.hands++;
      if (s.won > 0) { r.won++; r.bigPot = Math.max(r.bigPot, pot); }
      var sh = g.result && !g.result.uncontested && g.result.shows[s.id];
      if (sh) {
        r.showdowns++;
        if (s.won > 0) r.showWon++;
        if (sh.v > r.bestHand) { r.bestHand = sh.v; r.bestName = sh.name + ' (' + sh.cards.map(cardTxt).join(' ') + ')'; }
      }
    });
    saveRec();
  }
  function recordGameEnd(g) {
    if (S.recordedEnd === g) return;
    S.recordedEnd = g;
    var r = S.rec;
    if (g.mode === 'tourney') {
      r.tourneys++;
      var hs = humans(g), best = 99;
      hs.forEach(function (s) { if (s.place) best = Math.min(best, s.place); });
      if (best === 1 && hs.length < g.seats.length) r.tWins++;
      if (best < 99 && (!r.bestPlace || best < r.bestPlace)) r.bestPlace = best;
    } else {
      var st = STAKES[g.stakes] || STAKES.low, net = 0;
      humans(g).forEach(function (s) { net += s.stack - s.buyins * st.buyin; });
      r.cashNet = r.sessions ? Math.max(r.cashNet, net) : net;
      r.sessions++;
    }
    saveRec();
  }

  // ---- the game flow ----
  function cancel() { S.tok++; clearTimeout(S.timer); S.timer = 0; S.thinking = -1; S.job = null; }
  function later(ms, fn) {
    var tok = S.tok;
    clearTimeout(S.timer);
    S.timer = setTimeout(function () { if (S && S.tok === tok) fn(); }, ms);
  }
  function paused() { return !S || S.card || !S.g || (Cade.isMinimized && Cade.isMinimized(S.panel)) || !S.panel.isConnected; }
  // React to engine events (sound, messages), then render and schedule what comes next.
  function consume() {
    var g = S.g, ev = g.ev.splice(0), snd = S.snd;
    ev.forEach(function (e) {
      if (e === 'deal') { for (var i = 0; i < Math.min(8, g.seats.length * 2); i++) SFX.card(snd, i * 0.07); }
      else if (e === 'flop' || e === 'turn' || e === 'river') { SFX.card(snd); if (e === 'flop') { SFX.card(snd, 0.12); SFX.card(snd, 0.24); } }
      else if (e === 'check') SFX.check(snd);
      else if (e === 'call') SFX.chips(snd, 2);
      else if (e === 'bet' || e === 'raise') SFX.chips(snd, 3);
      else if (e === 'allin') SFX.allin(snd);
      else if (e === 'fold') SFX.fold(snd);
      else if (e === 'level') { SFX.level(snd); S.msg = 'Blinds up: ' + fmt(g.sbAmt) + '/' + fmt(g.bbAmt); Cade.showToast && Cade.showToast('Blinds up — ' + fmt(g.sbAmt) + '/' + fmt(g.bbAmt), 'info', 1800); }
      else if (e === 'runout') S.msg = 'All in!';
      else if (e === 'win') onHandEnd();
    });
  }
  function onHandEnd() {
    var g = S.g, res = g.result;
    if (!res) return;
    var p = res.pots[0], names = p.winners.map(function (id) { return g.seats[id].name; });
    var tot = 0;
    res.pots.forEach(function (q) { tot += q.amount; });
    if (res.uncontested) S.msg = esc(you(names[0] + ' takes ' + fmt(tot)));
    else if (p.winners.length > 1) S.msg = esc(names.join(' & ')) + ' split &mdash; ' + esc(p.name);
    else S.msg = esc(you(names[0] + ' wins ' + fmt(res.pots.length > 1 ? p.amount : tot))) + ' &mdash; ' + esc(p.name);
    if (res.pots.length > 1 && !res.uncontested) {
      var extra = res.pots.slice(1).map(function (q, i) { return 'side ' + (i + 1) + ': ' + q.winners.map(function (id) { return g.seats[id].name; }).join(' & '); });
      S.msg += '<br><span>' + esc(extra.join(' · ')) + '</span>';
    }
    say(S.msg.replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '-'));
    var humanWon = humans(g).some(function (s) { return s.won > 0; }), humanIn = humans(g).some(function (s) { return s.hole.length === 2 && (!s.folded || s.won); });
    if (humanWon) { SFX.win(S.snd); Cade.haptic && Cade.haptic(12); }
    else if (humanIn && !res.uncontested) SFX.lose(S.snd);
    else SFX.chips(S.snd, 2);
    recordHand(g);
    S.revealedEnd = true;
  }
  function flow() {
    if (!S) return;
    if (!S.g) { render(); return; }
    consume();
    render();
    persist();
    if (paused()) return;
    var g = S.g;
    if (g.over) { finishGame(); return; }
    if (g.street === 'done' || g.street === 'idle') return;   // the bar's Next hand button
    if (g.toAct < 0) {
      if (g.runout) later(PACE[S.cfg.pace].deal + 400, function () { dealNext(g); flow(); });
      return;
    }
    var s = g.seats[g.toAct];
    if (s.kind === 'cpu') think();
    else humanTurn();
  }
  function humanTurn() {
    var g = S.g, i = g.toAct;
    if (multi() && S.holder !== i) { S.revealed = -1; render(); showCard('pass'); return; }
    S.revealed = i; S.holder = i;
    render();
    SFX.turn(S.snd);
    var L = legal(g);
    say((multi() ? g.seats[i].name + ', your' : 'Your') + ' turn. ' + (L.canCall ? fmt(L.toCall) + ' to call.' : 'You can check.'));
    if (!S.coarse) { try { S.root.focus({ preventScroll: true }); } catch (e) {} }
  }
  // A CPU thinks: the equity simulation runs in slices, then it acts after a human-feeling pause.
  function think() {
    var g = S.g, si = g.toAct, s = g.seats[si], D = DIFFS[g.diff] || DIFFS.normal, P = PACE[S.cfg.pace];
    S.thinking = si;
    render();
    var humanLive = humans(g).some(function (h) { return inHand(h); });
    var wait = humanLive ? P.min + Math.random() * (P.max - P.min) : 140 + Math.random() * 120;
    var t0 = Date.now(), tok = S.tok, job = equityJob(s.hole, g.board, eqOpps(g, si), D.iters, rand);
    S.job = job;
    function slice() {
      if (!S || S.tok !== tok) return;
      if (!job.step(D.slice)) { S.timer = setTimeout(slice, 0); return; }
      later(Math.max(0, wait - (Date.now() - t0)), function () {
        if (paused()) return;
        S.thinking = -1;
        var a = cpuDecide(g, si, job.eq, rand) || { type: 'fold' };
        if (!act(g, a)) act(g, legal(g).canCheck ? { type: 'check' } : { type: 'fold' });
        var last = g.seats[si].last;
        say(s.name + ' ' + (last === 'fold' ? 'folds' : last === 'check' ? 'checks' : last));
        flow();
      });
    }
    S.timer = setTimeout(slice, 0);
  }
  function humanAct(type) {
    var g = S.g;
    if (!g || S.barMode !== 'act') return;
    var L = legal(g);
    if (!L) return;
    S.snd.ensure();
    var a = { type: type };
    if (type === 'call' && !L.canCall) a.type = 'check';
    if (type === 'raise') { if (!L.canRaise) return; a.to = S.raise >= L.maxTo ? L.maxTo : Math.max(L.minTo, Math.min(L.maxTo, S.raise)); }
    if (type === 'fold' && L.canCheck && !S.foldArm) {   // folding when you could check: ask once
      S.foldArm = true;
      Cade.showToast && Cade.showToast('You can check for free — tap Fold again to fold anyway', 'info', 2000);
      return;
    }
    S.foldArm = false;
    if (!act(g, a)) return;
    S.raise = null;
    if (multi()) S.revealed = -1;
    flow();
  }
  function nextHand() {
    var g = S.g;
    if (!g || (g.street !== 'done' && g.street !== 'idle') || g.over) return;
    S.snd.ensure();
    // cash game: CPUs who went broke leave, a new player sits down; busted humans choose
    if (g.mode === 'cash') {
      for (var i = 0; i < g.seats.length; i++) {
        var s = g.seats[i];
        if (s.stack > 0 || s.left) continue;
        if (s.kind === 'cpu') {
          var old = replaceCpu(g, i, rand), ns = g.seats[i];
          Cade.showToast && Cade.showToast(old + ' leaves — ' + ns.name + ' (' + STYLES[ns.style].name.toLowerCase() + ') sits down', 'info', 2200);
          g.log.push(old + ' leaves the table; ' + ns.name + ' sits down');
        } else if (!s.out || s.broke) { S.rebuySeat = i; showCard('rebuy'); return; }
      }
    }
    S.msg = ''; S.revealedEnd = false; S.cashArm = false;
    if (multi()) { S.revealed = -1; S.holder = -1; }   // a new deal: the device goes round again
    S.raise = null;
    if (!startHand(g)) { flow(); return; }
    if (!multi()) {   // single human: the log notes their cards (pass-and-play keeps them private)
      var hs = g.seats[heroSeat(g)];
      if (hs.hole.length === 2) g.log.splice(2, 0, 'Dealt to ' + hs.name + ' ' + cardsTxt(hs.hole));
    }
    // tournament: all humans are out — the CPUs play it out at once
    if (g.mode === 'tourney' && !humans(g).some(function (h) { return !h.out; })) { fastFinish(); return; }
    flow();
  }
  function fastFinish() {
    var g = S.g, guard = 0;
    while (!g.over && guard++ < 3000) {
      if (g.street === 'done') { if (!startHand(g)) break; continue; }
      if (g.toAct >= 0) cpuActNow(g, rand, 60);
      else if (g.runout) dealNext(g);
      else break;
    }
    g.ev = [];
    S.dealtHand = g.handNo; S.seenBoard = g.board.length;   // no deal animation for hands played off-screen
    flow();
  }
  function finishGame() {
    var g = S.g;
    recordGameEnd(g);
    persist();
    if (S.card !== 'over') {
      showCard('over');
      if (g.mode === 'tourney' && g.seats[g.winner] && g.seats[g.winner].kind === 'human') SFX.champ(S.snd);
    }
  }
  function startGame() {
    var c = S.cfg, seed = (Math.random() * 4294967295) | 0;
    var seats = c.seats.map(function (s, i) {
      var nm = (s.name || '').trim();
      if (humansIn(c) > 1 && (!nm || nm === 'You')) nm = 'Player ' + (i + 1);   // pass-and-play: nobody is "You"
      if (s.kind === 'human') return { kind: 'human', name: nm || 'You' };
      return { kind: 'cpu', style: STYLES[s.style] ? s.style : STYLE_IDS[(Math.random() * STYLE_IDS.length) | 0] };
    });
    // CPU names: distinct, shuffled
    var pool = CPU_NAMES.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0, t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    var taken = {};
    seats.forEach(function (s) { if (s.kind === 'human') taken[s.name] = 1; });
    seats.forEach(function (s) { if (s.kind === 'cpu') { while (taken[pool[0]]) pool.shift(); s.name = pool.shift() || 'CPU'; taken[s.name] = 1; } });
    S.g = newGame({ mode: c.mode, seats: seats, diff: c.diff, speed: c.speed, stakes: c.stakes, seed: seed });
    S.saved = null; S.revealed = -1; S.holder = -1; S.msg = ''; S.recorded = ''; S.recordedEnd = null; S.dealtHand = -1; S.seenBoard = 0;
    cancel();
    closeCard();
    nextHand();
  }
  function humansIn(c) { return c.seats.filter(function (s) { return s.kind === 'human'; }).length; }
  function toLobby() {
    cancel();
    if (S.g) { persist(); S.saved = S.g.over ? null : S.g; if (S.g.over) sdel(GAME_KEY); }
    S.g = null; S.newArm = false; S.resetArm = false;
    render();
    showCard('home');
  }
  function continueGame() {
    if (!S.saved) return;
    S.g = S.saved; S.saved = null;
    S.revealed = -1; S.holder = -1; S.msg = ''; S.dealtHand = S.g.handNo; S.seenBoard = S.g.board.length;
    S.recorded = S.g.handNo + ':' + S.g.seats.length;   // already counted
    cancel();
    closeCard();
  }

  // ---- input ----
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target, typing = t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'range';
    var k = e.key;
    if (k === 'Escape') {
      if (S.card && S.card !== 'home' && S.card !== 'pass' && S.card !== 'rebuy' && S.card !== 'over') { e.preventDefault(); e.stopPropagation(); if (S.card === 'records') showCard('home'); else closeCard(); }
      return;
    }
    if (typing) return;
    if (S.card) {
      if ((k === 'Enter' || k === ' ') && t && t.tagName === 'BUTTON') return;
      if (k === 'Enter' && S.card === 'pass') { e.preventDefault(); reveal(); }
      return;
    }
    var lk = k.toLowerCase();
    if (lk === 'l') { e.preventDefault(); if (S.g) { cancel(); render(); showCard('log'); } return; }
    if (S.barMode === 'next' && (k === 'Enter' || lk === 'n' || k === ' ')) {
      if (t && t.tagName === 'BUTTON' && k !== 'n' && S.panel.contains(t) && !t.matches('[data-act="next"]')) return;
      e.preventDefault(); nextHand(); return;
    }
    if (S.barMode !== 'act') return;
    var L = legal(S.g);
    if (lk === 'f') { e.preventDefault(); humanAct('fold'); }
    else if (lk === 'c' || lk === 'k') { e.preventDefault(); humanAct('call'); }
    else if (lk === 'r' || lk === 'b') { e.preventDefault(); humanAct('raise'); }
    else if (lk === 'a' && L.canRaise) { e.preventDefault(); S.raise = L.maxTo; syncRaise(); }
    else if ((k === 'ArrowUp' || k === 'ArrowRight' || k === '+' || k === '=') && L.canRaise && !(t && t.type === 'range')) { e.preventDefault(); nudge(1); }
    else if ((k === 'ArrowDown' || k === 'ArrowLeft' || k === '-') && L.canRaise && !(t && t.type === 'range')) { e.preventDefault(); nudge(-1); }
  }
  function nudge(d) {
    var g = S.g, L = legal(g);
    if (!L || !L.canRaise) return;
    var st = g.bbAmt;
    S.raise = Math.max(L.minTo, Math.min(L.maxTo, (S.raise >= L.maxTo && d < 0 ? Math.floor(L.maxTo / st) * st + st : S.raise) + d * st));
    if (S.raise > L.maxTo - st / 2 && d > 0) S.raise = Math.min(L.maxTo, S.raise);
    syncRaise();
  }
  function reveal() {
    if (!S || S.card !== 'pass') return;
    S.holder = S.g.toAct;
    S.snd.ensure();
    closeCard();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    cancel();
    persist();
    S = null;
    document.removeEventListener('visibilitychange', s.onVis);
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
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="hp" tabindex="-1"><div class="hp-wrap"><div class="hp-felt"></div><div class="hp-bar"></div>' +
      '<div class="hp-ovl" style="display:none"></div></div><div class="hp-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '♠️ Texas Hold’em', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'hp-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="Lobby (the game is saved)" aria-label="Lobby">' + IC_HOME + '</button>' +
      '<button type="button" data-h="log" title="Hand log (L)" aria-label="Hand log">' + IC_LOG + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, saved = normGame(jget(GAME_KEY));
    if (saved && saved.over) saved = null;
    S = {
      panel: p, head: hb, root: p.querySelector('.hp'), wrap: p.querySelector('.hp-wrap'), felt: p.querySelector('.hp-felt'), bar: p.querySelector('.hp-bar'),
      ovl: p.querySelector('.hp-ovl'), liveEl: p.querySelector('.hp-live'),
      cfg: normCfg(jget(CFG_KEY)), rec: normRec(jget(REC_KEY)), snd: new Snd(sget(SOUND_KEY) === '1'), saved: saved,
      coarse: !!(mm && mm('(pointer: coarse)').matches), g: null, card: null, tok: 0, timer: 0, thinking: -1, job: null,
      revealed: -1, holder: -1, msg: '', raise: null, raiseFor: '', dealtHand: -1, seenBoard: 0, barMode: '', recorded: '', recordedEnd: null,
      newArm: false, resetArm: false, foldArm: false, rebuySeat: -1
    };
    p._onClose = teardown;

    S.onVis = function () { if (S && !document.hidden && !S.timer) flow(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onResize = function () { if (S) S.coarse = !!(mm && mm('(pointer: coarse)').matches); };
    window.addEventListener('resize', S.onResize);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) cancel(); });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p && S.g && !S.card) { cancel(); flow(); } });
    try {
      S.themeObs = new MutationObserver(function () { if (S) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header buttons (the header drags the panel — these are controls)
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
      } else if (h === 'help') { if (S.card === 'help') closeCard(); else if (S.card !== 'pass') { cancel(); render(); showCard('help'); } }
      else if (h === 'log') { if (S.card === 'log') closeCard(); else if (S.g && S.card !== 'pass') { cancel(); render(); showCard('log'); } }
      else if (h === 'home') { if (S.g) toLobby(); }
      try { b.blur(); } catch (er) {}
    });
    // nothing in the panel may zoom, select or open a callout on fast taps
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    // the felt is a play surface: no double-tap zoom, no scroll-start on quick taps
    S.felt.addEventListener('touchend', function (e) { if (e.cancelable && e.touches.length === 0) e.preventDefault(); }, { passive: false });
    S.felt.addEventListener('touchstart', function (e) { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
    S.felt.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.root.addEventListener('keydown', onKey);

    // the action bar
    S.bar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      var act2 = b.getAttribute('data-act'), to = b.getAttribute('data-to'), nd = b.getAttribute('data-nudge');
      if (to) { S.raise = +to; syncRaise(); S.snd.tone(1400, 0.03, 'sine', 0.02); return; }
      if (nd) { nudge(+nd); return; }
      if (act2 !== 'cashout' && S.cashArm) S.cashArm = false;
      if (act2 === 'next') nextHand();
      else if (act2 === 'cashout') {
        // first tap arms, the second ends the session (net result on the results card)
        if (!S.cashArm) { S.cashArm = true; renderBar(); return; }
        S.cashArm = false;
        var cg = S.g;
        if (cg && cg.mode === 'cash' && cg.street === 'done' && !cg.over) { cg.over = true; logl(cg, 'The session ends'); flow(); }
      }
      else if (act2 === 'log') { cancel(); render(); showCard('log'); }
      else if (act2 === 'over') showCard('over');
      else if (act2) humanAct(act2);
    });
    S.bar.addEventListener('input', function (e) {
      if (!S || !e.target.classList.contains('hp-slider')) return;
      var g = S.g, L = g && legal(g);
      if (!L) return;
      var v = +e.target.value;
      if (v + stepOf(g) > L.maxTo) v = L.maxTo;
      S.raise = v; syncRaise();
    });
    ['touchstart', 'touchend'].forEach(function (t) {
      S.bar.addEventListener(t, function (e) {
        // quick taps on the action buttons never zoom (the slider keeps its drag)
        if (t === 'touchend' && e.cancelable && e.target.closest && e.target.closest('button')) { e.preventDefault(); e.target.closest('button').click(); }
      }, { passive: false });
    });

    // cards over the table
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var c = S.cfg, a = b.getAttribute('data-act'), set = b.getAttribute('data-set');
      if (set) { c[set] = b.getAttribute('data-v'); saveCfg(); rehome(); return; }
      if (b.hasAttribute('data-kind')) {
        var i = +b.getAttribute('data-kind'), s = c.seats[i];
        if (s.kind === 'human') {
          if (humansIn(c) <= 1) { Cade.showToast && Cade.showToast('At least one human has to play', 'info', 1600); return; }
          c.seats[i] = { kind: 'cpu', style: 'random' };
        } else c.seats[i] = { kind: 'human', name: humansIn(c) ? 'Player ' + (humansIn(c) + 1) : 'You' };
        saveCfg(); rehome(); return;
      }
      if (b.hasAttribute('data-style')) {
        var k2 = +b.getAttribute('data-style'), cur = c.seats[k2].style, list = ['random'].concat(STYLE_IDS);
        c.seats[k2].style = list[(list.indexOf(cur) + 1) % list.length];
        saveCfg(); rehome(); return;
      }
      if (b.hasAttribute('data-del')) {
        var d = +b.getAttribute('data-del');
        if (c.seats.length <= 2) return;
        if (c.seats[d].kind === 'human' && humansIn(c) <= 1) { Cade.showToast && Cade.showToast('At least one human has to play', 'info', 1600); return; }
        c.seats.splice(d, 1); saveCfg(); rehome(); return;
      }
      if (a === 'add') { if (c.seats.length < 6) { c.seats.push({ kind: 'cpu', style: 'random' }); saveCfg(); rehome(); } }
      else if (a === 'start') { if (S.saved) { S.newArm = true; rehome(); } else startGame(); }
      else if (a === 'start-yes') { if (S.saved && S.saved.mode === 'cash') recordGameEnd(S.saved); S.saved = null; sdel(GAME_KEY); S.newArm = false; startGame(); }
      else if (a === 'start-no') { S.newArm = false; rehome(); }
      else if (a === 'continue') continueGame();
      else if (a === 'records') { S.resetArm = false; showCard('records'); }
      else if (a === 'help') showCard('help');
      else if (a === 'close') closeCard();
      else if (a === 'lobby') {
        if (S.g && S.g.over) { sdel(GAME_KEY); S.g = null; S.saved = null; render(); }
        if (S.g) toLobby(); else showCard('home');
      }
      else if (a === 'again') { sdel(GAME_KEY); S.g = null; startGame(); }
      else if (a === 'reveal') reveal();
      else if (a === 'rebuy') { if (rebuy(S.g, S.rebuySeat)) { SFX.chips(S.snd, 4); S.card = null; closeCardQuiet(); nextHand(); } }
      else if (a === 'leave') {
        leave(S.g, S.rebuySeat); closeCardQuiet();
        if (!humans(S.g).some(function (h) { return !h.out; })) { S.g.over = true; flow(); } else nextHand();
      }
      else if (a === 'reset') { S.resetArm = true; showCard('records'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('records'); }
      else if (a === 'reset-yes') { S.rec = newRec(); saveRec(); S.resetArm = false; showCard('records'); Cade.showToast && Cade.showToast('Records reset', 'info', 1500); }
    });
    S.ovl.addEventListener('input', function (e) {
      var t = e.target;
      if (!S || !t.hasAttribute('data-name')) return;
      S.cfg.seats[+t.getAttribute('data-name')].name = t.value.slice(0, 12);
      saveCfg();
    });
    function rehome() { var y = S.ovl.scrollTop; showCard('home'); S.ovl.scrollTop = y; }
    function closeCardQuiet() { S.card = null; S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.wrap.classList.remove('dim', 'lobby'); S.panel.classList.remove('hp-lobby'); }

    render();
    showCard('home');
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: "No-limit hold'em vs 3–5 computer players with distinct styles — tournaments, cash games, side pots, pass-and-play",
    icon: '♠️',
    tags: 'game,cards,casino,poker,holdem,texas,no limit,tournament,cpu,pass and play,2 player,multiplayer',
    open: open,
    _engine: ENGINE
  });
})();
