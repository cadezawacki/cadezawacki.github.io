/* Spin & Solve — a wheel-spinning, letter-guessing phrase puzzle game for Cade.txt.
 * 1-4 players pass-and-play on one device, any seat a CPU (easy / normal / hard /
 * expert). Each game: toss-up puzzles that fill in by themselves until someone buzzes,
 * main rounds on a physics wheel (flick it, or hold SPIN for power: real angular
 * velocity, friction and ticking pegs) with cash wedges that grow each round,
 * BANKRUPT, LOSE A TURN, FREE PLAY, WILD, MYSTERY and PRIZE wedges; buy vowels for
 * $250; solve by typing the blanks on the on-screen keyboard. The final round runs on
 * a clock: when it runs out the wheel spins once more and it turns into a speed-up
 * round (one fixed value, vowels free, one letter and one guess each). The game's
 * winner plays the bonus round: R S T L N E given, pick 3 consonants and a vowel
 * (+1 with the WILD card), 10 seconds to solve, prize in an envelope from the bonus
 * wheel. Season stats, a leaderboard, settings, a recently-used puzzle list and a game
 * in progress persist in Cade.store (cade-wheel-*). Puzzles live in wheel-data.js,
 * loaded on first open. No assets, no network. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var VER = 1;
  var VOWELS = 'AEIOU', CONS = 'BCDFGHJKLMNPQRSTVWXYZ', ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var VOWEL_COST = 250, MIN_WIN = 1000, MYSTERY_CASH = 10000, FREE_VAL = 500;
  var ROW_CAP = [12, 14, 14, 12], ROW_OFF = [1, 0, 0, 1], COLS = 14;
  var FREQ_CONS = 'TNSRHLDCMFPGWYBVKXJQZ', FREQ_VOW = 'EAOIU';
  var BONUS_GIVEN = 'RSTLNE';
  var DIFFS = ['Human', 'Easy', 'Normal', 'Hard', 'Expert'];

  function isL(ch) { return ch >= 'A' && ch <= 'Z'; }
  function isV(ch) { return VOWELS.indexOf(ch) >= 0; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function norm(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[‘’]/g, "'").replace(/[^A-Z &'\-?!.,]/g, '').replace(/\s+/g, ' ').trim();
  }
  function lettersOnly(s) { return norm(s).replace(/[^A-Z]/g, ''); }
  function hashId(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // the game carries its own RNG state, so a saved game resumes deterministically
  function rnd(g) {
    var a = (g.rs = (g.rs + 0x6D2B79F5) | 0);
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rint(g, n) { return Math.floor(rnd(g) * n); }

  // ---- the puzzle bank ----
  function parseBank(data) {
    var out = [], seen = {};
    var cats = data && Array.isArray(data.cats) ? data.cats : [];
    cats.forEach(function (c) {
      String(c.p || '').split('|').forEach(function (t) {
        t = norm(t);
        if (!t || seen[t] || !/[A-Z]/.test(t) || !layoutBoard(t)) return;
        seen[t] = 1;
        out.push({ id: hashId(t), cat: String(c.c || 'Phrase'), text: t });
      });
    });
    return out;
  }
  function bonusOk(p) {
    var n = lettersOnly(p.text).length, w = p.text.split(' ').length;
    return n >= 5 && n <= 15 && w <= 3 && p.text.indexOf('&') < 0;
  }
  // a random puzzle not on the recent list (falls back to anything), optionally
  // avoiding a category; 'bonus' wants a short one
  function pickPuzzle(bank, recent, r01, kind, avoidCat) {
    var rec = {};
    (recent || []).forEach(function (id) { rec[id] = 1; });
    var pool = bank.filter(function (p) { return (kind !== 'bonus' || bonusOk(p)); });
    var fresh = pool.filter(function (p) { return !rec[p.id] && p.cat !== avoidCat; });
    if (!fresh.length) fresh = pool.filter(function (p) { return !rec[p.id]; });
    if (!fresh.length) fresh = pool;
    if (!fresh.length) return null;
    return fresh[Math.floor(r01() * fresh.length) % fresh.length];
  }
  function noteRecent(recent, id, cap) {
    var out = (recent || []).filter(function (x) { return x !== id; });
    out.push(id);
    cap = cap || 400;
    while (out.length > cap) out.shift();
    return out;
  }

  // ---- the board: 4 rows of 12 / 14 / 14 / 12 tiles, word-wrapped, centered ----
  var ROWSETS = { 1: [[1]], 2: [[1, 2]], 3: [[0, 1, 2], [1, 2, 3]], 4: [[0, 1, 2, 3]] };
  function splits(words, k) {
    var out = [];
    (function rec(start, left, acc) {
      if (left === 1) { out.push(acc.concat([words.slice(start).join(' ')])); return; }
      for (var e = start + 1; e <= words.length - (left - 1); e++) rec(e, left - 1, acc.concat([words.slice(start, e).join(' ')]));
    })(0, k, []);
    return out;
  }
  function layoutBoard(text) {
    text = norm(text);
    if (!text) return null;
    var words = text.split(' '), best = null;
    for (var k = 1; k <= 4 && k <= words.length; k++) {
      splits(words, k).forEach(function (lines) {
        var mx = 0;
        lines.forEach(function (l) { if (l.length > mx) mx = l.length; });
        ROWSETS[k].forEach(function (rs, ri) {
          for (var j = 0; j < k; j++) if (lines[j].length > ROW_CAP[rs[j]]) return;
          var score = k * 4 + mx + ri * 0.5;
          if (!best || score < best.score) best = { score: score, lines: lines, rows: rs };
        });
      });
    }
    if (!best) return null;
    var cells = [], pos = 0;
    best.lines.forEach(function (line, j) {
      var r = best.rows[j], c0 = ROW_OFF[r] + Math.floor((ROW_CAP[r] - line.length) / 2);
      for (var x = 0; x < line.length; x++) if (line.charAt(x) !== ' ') cells.push({ r: r, c: c0 + x, i: pos + x, ch: line.charAt(x) });
      pos += line.length + 1;
    });
    return { lines: best.lines, rows: best.rows, cells: cells };
  }

  // ---- puzzle state helpers ----
  function newRev(text, given) {
    var rev = [];
    for (var i = 0; i < text.length; i++) { var ch = text.charAt(i); rev.push(!isL(ch) || (given ? given.indexOf(ch) >= 0 : false)); }
    return rev;
  }
  function hiddenIdx(r, L) {
    var out = [];
    for (var i = 0; i < r.text.length; i++) if (!r.rev[i] && (L == null || r.text.charAt(i) === L)) out.push(i);
    return out;
  }
  function leftOf(r, set) {
    var s = '';
    for (var i = 0; i < r.text.length; i++) {
      var ch = r.text.charAt(i);
      if (!r.rev[i] && set.indexOf(ch) >= 0 && s.indexOf(ch) < 0) s += ch;
    }
    return s;
  }
  function consLeft(r) { return leftOf(r, CONS).length > 0; }
  function vowelsLeft(r) { return leftOf(r, VOWELS).length > 0; }
  function allShown(r) { return hiddenIdx(r).length === 0; }
  function revealAll(r) { var idx = hiddenIdx(r); idx.forEach(function (i) { r.rev[i] = true; }); return idx; }
  function solveMatches(text, guess) { return lettersOnly(text) === lettersOnly(guess); }

  // ---- the wheels ----
  var BASE = ['top', 600, 400, 300, 'bk', 900, 'free', 500, 800, 'mys', 700, 'lose', 650, 500, 'wild', 900, 'bk', 600, 'prize', 550, 'mys', 450, 800, 350];
  var TOPS = [2500, 3500, 5000];
  function makeWheel(m) {
    m = Math.max(0, m | 0);
    return BASE.map(function (x, i) {
      if (x === 'top') return { k: 'cash', v: TOPS[Math.min(m, 2)], top: 1 };
      if (typeof x === 'number') return { k: 'cash', v: x + 100 * Math.min(m, 4) };
      if (m >= 3 && i === 23) return { k: 'bk', v: 0 };          // a late round grows a third BANKRUPT
      return { k: x, v: x === 'mys' ? 1000 : (x === 'bk' || x === 'lose') ? 0 : FREE_VAL };
    });
  }
  var ENV = [40000, 45000, 35000, 'car', 50000, 30000, 40000, 35000, 25000, 100000, 45000, 30000, 40000, 35000, 50000, 'car', 30000, 25000, 40000, 45000, 35000, 30000, 50000, 40000];
  function bonusWheel() {
    return ENV.map(function (v) { return v === 'car' ? { k: 'env', v: 32000, car: 1 } : { k: 'env', v: v }; });
  }
  function envLabel(w) { return w.car ? 'A NEW CAR' : '$' + fmt(w.v); }
  var PRIZES = [
    { n: 'Tropical Getaway', v: 5500 }, { n: 'Mountain Ski Trip', v: 4800 }, { n: 'Home Theater', v: 3200 },
    { n: 'Backyard Hot Tub', v: 6000 }, { n: 'Cooking Class for Two', v: 2500 }, { n: 'Shopping Spree', v: 3000 },
    { n: 'Island Cruise', v: 7500 }, { n: 'Pair of E-Bikes', v: 3600 }, { n: 'Deluxe Camping Gear', v: 2400 },
    { n: 'Hot Air Balloon Ride', v: 2800 }, { n: 'City Weekend Escape', v: 4100 }, { n: 'Grand Piano', v: 6800 }
  ];
  function wedgeOf(r, i) {
    var w = r.wheel[((i % r.wheel.length) + r.wheel.length) % r.wheel.length];
    if ((w.k === 'wild' && r.taken.wild) || (w.k === 'prize' && r.taken.prize)) return { k: 'cash', v: FREE_VAL, was: w.k };
    if (w.k === 'mys' && r.mysDone) return { k: 'cash', v: 1000, was: 'mys' };
    return w;
  }
  function fmt(n) { n = Math.round(n || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // ---- spin physics (angle in radians, clockwise; the pointer sits at the top) ----
  var SPIN_FR = 0.6, SPIN_DRAG = 0.55, PEG_LOSS = 0.012, SPIN_MIN = 3, SPIN_MAX = 19, SPIN_STOP = 0.03;
  var TAU = Math.PI * 2;
  function wedgeAt(a, n) {
    var W = TAU / n, l = ((-a % TAU) + TAU) % TAU;
    return Math.floor(l / W + 1e-9) % n;
  }
  function spinStep(sp, dt, n) {
    var W = TAU / n, a0 = sp.a, sg = sp.w < 0 ? -1 : 1, m = Math.abs(sp.w);
    m -= (SPIN_FR + SPIN_DRAG * m) * dt;
    if (m < 0) m = 0;
    sp.a += sg * m * dt;
    var ticks = Math.abs(Math.floor(sp.a / W) - Math.floor(a0 / W));
    m = Math.max(0, m - ticks * PEG_LOSS);
    sp.w = m < SPIN_STOP ? 0 : sg * m;
    return ticks;
  }
  // where a spin from angle a with speed w comes to rest (same steps as the live wheel)
  function spinRest(a, w, n) {
    var sp = { a: a, w: w }, t = 0;
    while (sp.w !== 0 && t < 60) { spinStep(sp, 1 / 120, n); t += 1 / 120; }
    return { a: sp.a, t: t, i: wedgeAt(sp.a, n) };
  }

  // ---- a game ----
  function buildSeq(n) {
    n = clamp(n | 0 || 3, 1, 6);
    var s = [];
    for (var m = 0; m < n; m++) {
      if (m < 2) s.push({ t: 'toss', v: (m + 1) * 1000 });
      s.push({ t: 'main', m: m, final: m === n - 1 });
    }
    s.push({ t: 'bonus' });
    return s;
  }
  function newGame(o) {
    o = o || {};
    var pl = (o.players && o.players.length ? o.players : [{ name: 'You', color: 0, cpu: 0 }]).slice(0, 4);
    return {
      v: VER, rs: (o.seed >>> 0) || 1, ri: -1, r: null, tossWin: -1, over: false,
      clock: clamp(+o.clock || 45, 15, 180), rounds: clamp(o.rounds | 0 || 3, 1, 6), seq: buildSeq(o.rounds),
      players: pl.map(function (p, i) {
        return { name: String(p.name || 'Player ' + (i + 1)).slice(0, 12), color: (p.color | 0) % 8, cpu: clamp(p.cpu | 0, 0, 4),
          round: 0, total: 0, won: [], wild: false, bonus: 0, bonusPrize: '', best: 0, solves: 0 };
      })
    };
  }
  function nextKind(g) { var s = g.seq[g.ri + 1]; return s ? s.t : null; }
  function stage(g) { return g.seq[g.ri] || null; }
  function bonusPlayer(g) {
    var b = 0;
    g.players.forEach(function (p, i) { if (p.total > g.players[b].total) b = i; });
    return b;
  }
  function startRound(g, puz) {
    g.ri++;
    var st = g.seq[g.ri], n = g.players.length, text = norm(puz.text), bonus = st.t === 'bonus';
    var r = {
      t: st.t, m: st.m || 0, final: !!st.final, val: st.v || 0, id: puz.id || hashId(text), cat: puz.cat || 'Phrase', text: text,
      rev: newRev(text, bonus ? BONUS_GIVEN : ''), used: bonus ? BONUS_GIVEN : '', turn: 0, phase: '', from: '',
      wheel: null, wi: -1, wv: 0, taken: {}, mysDone: false, held: g.players.map(function () { return []; }), prize: null,
      clock: 0, speed: 0, locked: [], order: [], winner: -1, bank: 0, picks: '', need: null, env: -1, won: false, last: ''
    };
    g.players.forEach(function (p) { p.round = 0; });
    if (st.t === 'main') {
      r.wheel = makeWheel(r.m);
      r.prize = PRIZES[rint(g, PRIZES.length)];
      r.turn = g.tossWin >= 0 ? g.tossWin : r.m % n;
      g.tossWin = -1;
      r.phase = 'turn';
      if (r.final) r.clock = g.clock;
    } else if (st.t === 'toss') {
      var idx = hiddenIdx(r);
      for (var i = idx.length - 1; i > 0; i--) { var j = rint(g, i + 1), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
      r.order = idx;
      r.phase = 'toss';
      r.turn = -1;
    } else {
      r.turn = bonusPlayer(g);
      r.wheel = bonusWheel();
      r.need = { c: 3 + (g.players[r.turn].wild ? 1 : 0), v: 1 };
      r.phase = 'bspin';
    }
    g.r = r;
    return r;
  }
  function cur(g) { return g.r && g.r.turn >= 0 ? g.players[g.r.turn] : null; }
  // the final round's clock: once it has run out the next turn starts with the final spin
  function settle(g) {
    var r = g.r;
    if (r && r.t === 'main' && r.final && !r.speed && r.clock <= 0 && r.phase === 'turn') r.phase = 'final';
    if (r && r.speed && r.phase === 'speedCall' && allShown(r)) r.phase = 'speedSolve';
  }
  function tickClock(g, dt) {
    var r = g.r;
    if (!r || r.t !== 'main' || !r.final || r.speed || r.clock <= 0) return false;
    if (!/^(turn|call|vowel|free|mystery|solve)$/.test(r.phase)) return false;
    r.clock = Math.max(0, r.clock - dt);
    if (r.clock <= 0) { settle(g); return true; }
    return false;
  }
  function nextTurn(g) {
    var r = g.r;
    r.turn = (r.turn + 1) % g.players.length;
    r.phase = r.speed ? 'speedCall' : 'turn';
    r.from = '';
    settle(g);
  }
  function canSpin(g) { var r = g.r; return !!r && r.phase === 'turn' && consLeft(r); }
  function canBuy(g) { var r = g.r, p = cur(g); return !!r && r.phase === 'turn' && !!p && p.round >= VOWEL_COST && vowelsLeft(r); }
  function startSpin(g) { if (g.r.phase === 'turn' || g.r.phase === 'bspin' || g.r.phase === 'final') { g.r.from = g.r.phase; g.r.phase = 'spin'; return true; } return false; }
  function spinLand(g, wi) {
    var r = g.r, p = cur(g);
    if (r.phase === 'spin') r.phase = r.from || 'turn';
    if (r.t === 'bonus') { r.env = wi; r.phase = 'bpick'; return { ev: 'env' }; }
    if (r.phase === 'final') return enterSpeed(g, wi);
    var w = wedgeOf(r, wi);
    r.wi = wi; r.wv = 0;
    if (w.k === 'bk') {
      var lost = p.round;
      p.round = 0; p.wild = false; r.held[r.turn] = [];
      nextTurn(g);
      return { ev: 'bk', lost: lost };
    }
    if (w.k === 'lose') { nextTurn(g); return { ev: 'lose' }; }
    if (w.k === 'free') { r.wv = FREE_VAL; r.phase = 'free'; return { ev: 'free' }; }
    r.wv = w.v;
    r.phase = 'call';
    return { ev: w.k, v: w.v };
  }
  function enterSpeed(g, wi) {
    var r = g.r, w = r.wheel[wi % r.wheel.length];
    r.speed = (w && w.k === 'cash' ? w.v : FREE_VAL) + 1000;
    r.phase = 'speedCall';
    r.clock = 0;
    settle(g);
    return { ev: 'speed', v: r.speed };
  }
  function buyVowel(g) { if (!canBuy(g)) return false; g.r.phase = 'vowel'; return true; }
  function cancelVowel(g) { if (g.r.phase === 'vowel') { g.r.phase = 'turn'; return true; } return false; }
  // call a letter in the current phase: 'call' (a consonant on a wedge), 'vowel'
  // (a bought vowel), 'free' (any letter, misses cost nothing) or 'speedCall'
  function callLetter(g, L) {
    var r = g.r, p = cur(g), ph = r.phase;
    L = String(L || '').toUpperCase();
    if (!p || L.length !== 1 || !isL(L)) return { ok: false, ev: 'invalid' };
    if ((ph === 'call' && isV(L)) || (ph === 'vowel' && !isV(L)) || !/^(call|vowel|free|speedCall)$/.test(ph)) return { ok: false, ev: 'invalid' };
    var vow = isV(L);
    if (ph === 'vowel') p.round -= VOWEL_COST;
    if (r.used.indexOf(L) >= 0) {
      r.last = L;
      if (ph === 'free') { r.phase = 'turn'; return { ok: true, ev: 'used', n: 0, idx: [], L: L, keep: true }; }
      nextTurn(g);
      return { ok: true, ev: 'used', n: 0, idx: [], L: L };
    }
    r.used += L; r.last = L;
    var idx = hiddenIdx(r, L);
    idx.forEach(function (i) { r.rev[i] = true; });
    var n = idx.length, earn = 0, res = { ok: true, ev: n ? 'hit' : 'miss', n: n, idx: idx, L: L };
    if (ph === 'speedCall') {
      if (!n) { nextTurn(g); return res; }
      if (!vow) earn = r.speed * n;
      p.round += earn; res.earn = earn;
      r.phase = 'speedSolve';
      return res;
    }
    if (ph === 'free') {
      if (n && !vow) earn = FREE_VAL * n;
      p.round += earn; res.earn = earn;
      r.phase = 'turn';
      if (!n) res.keep = true;
      settle(g);
      return res;
    }
    if (!n) { nextTurn(g); return res; }
    if (ph === 'call') {
      earn = r.wv * n;
      p.round += earn; res.earn = earn;
      var w = wedgeOf(r, r.wi);
      if (w.k === 'wild') { p.wild = true; r.taken.wild = true; res.wild = true; }
      if (w.k === 'prize' && r.prize) { r.held[r.turn].push(r.prize); r.taken.prize = true; res.prize = r.prize; }
      if (w.k === 'mys') { r.phase = 'mystery'; res.mys = true; return res; }
    }
    r.phase = 'turn';
    settle(g);
    return res;
  }
  // the mystery wedge: flip it for $10,000 … or BANKRUPT
  function mystery(g, flip) {
    var r = g.r, p = cur(g);
    if (r.phase !== 'mystery') return { ok: false };
    r.mysDone = true;
    if (!flip) { r.phase = 'turn'; settle(g); return { ok: true, ev: 'keep' }; }
    if (rnd(g) < 0.5) { p.round += MYSTERY_CASH; r.phase = 'turn'; settle(g); return { ok: true, ev: 'mys-win', v: MYSTERY_CASH }; }
    var lost = p.round;
    p.round = 0; p.wild = false; r.held[r.turn] = [];
    nextTurn(g);
    return { ok: true, ev: 'mys-bk', lost: lost };
  }
  function startSolve(g) {
    var r = g.r;
    if (!/^(turn|free|speedSolve)$/.test(r.phase)) return false;
    r.from = r.phase; r.phase = 'solve';
    return true;
  }
  function cancelSolve(g) {
    var r = g.r;
    if (r.phase !== 'solve' || r.from === 'speedSolve') return false;
    r.phase = r.from || 'turn'; r.from = '';
    settle(g);
    return true;
  }
  function buzz(g, pi) {
    var r = g.r;
    if (!r || r.phase !== 'toss' || pi < 0 || pi >= g.players.length || r.locked.indexOf(pi) >= 0) return false;
    r.turn = pi; r.phase = 'tossSolve';
    return true;
  }
  // the next tile of a toss-up; never the last hidden letter
  function tossReveal(g) {
    var r = g.r;
    if (r.phase !== 'toss') return -1;
    var hid = hiddenIdx(r);
    if (hid.length <= 1) return -1;
    while (r.order.length) {
      var i = r.order.shift();
      if (!r.rev[i]) { r.rev[i] = true; return i; }
    }
    return -1;
  }
  function tossEnd(g) {
    var r = g.r;
    r.phase = 'done'; r.winner = -1; r.turn = -1;
    return { ev: 'nowin', idx: revealAll(r) };
  }
  function finishRound(g, pi) {
    var r = g.r, p = g.players[pi], idx = revealAll(r), res = { ok: true, ev: 'solved', idx: idx, who: pi };
    r.winner = pi; r.turn = pi;
    if (r.t === 'toss') {
      p.total += r.val; r.bank = r.val; g.tossWin = pi;
      res.amount = r.val;
    } else {
      var amt = Math.max(p.round, MIN_WIN), pz = r.held[pi] || [], pv = 0;
      pz.forEach(function (z) { pv += z.v; p.won.push(z.n); });
      p.total += amt + pv; r.bank = amt + pv; p.best = Math.max(p.best, amt + pv);
      res.amount = amt; res.prizes = pz;
    }
    p.solves++;
    g.players.forEach(function (q) { q.round = 0; });
    r.phase = 'done';
    return res;
  }
  function trySolve(g, guess) {
    var r = g.r, ok = solveMatches(r.text, guess);
    if (r.phase === 'bsolve') {
      if (!ok) return { ok: false, ev: 'wrong' };
      var p = cur(g), w = r.wheel[r.env] || { v: 25000 };
      p.bonus = w.v; p.bonusPrize = envLabel(w);
      r.won = true; r.phase = 'bdone'; g.over = true;
      return { ok: true, ev: 'bonus-win', idx: revealAll(r), v: w.v };
    }
    if (r.phase === 'tossSolve') {
      if (ok) return finishRound(g, r.turn);
      return tossFail(g);
    }
    if (r.phase !== 'solve') return { ok: false, ev: 'invalid' };
    if (ok) return finishRound(g, r.turn);
    var from = r.from;
    if (from === 'free') { r.phase = 'turn'; r.from = ''; settle(g); return { ok: false, ev: 'wrong', keep: true }; }
    nextTurn(g);
    return { ok: false, ev: 'wrong' };
  }
  function tossFail(g) {
    var r = g.r;
    if (r.locked.indexOf(r.turn) < 0) r.locked.push(r.turn);
    r.turn = -1;
    if (r.locked.length >= g.players.length) { var e = tossEnd(g); e.ok = false; e.ev = 'wrong-end'; return e; }
    r.phase = 'toss';
    return { ok: false, ev: 'wrong' };
  }
  function passSpeed(g) { if (g.r.phase === 'speedSolve') { nextTurn(g); return true; } return false; }
  // the turn timer ran out (or a fixed solve clock)
  function timeout(g) {
    var r = g.r;
    if (!r) return { ev: 'none' };
    if (r.phase === 'tossSolve') return tossFail(g);
    if (r.phase === 'bsolve' || r.phase === 'bpick') return bonusTimeout(g);
    if (/^(turn|call|vowel|free|mystery|solve|speedCall|speedSolve)$/.test(r.phase)) {
      if (r.phase === 'mystery') r.mysDone = true;
      nextTurn(g);
      return { ev: 'time' };
    }
    return { ev: 'none' };
  }
  function bonusPick(g, L) {
    var r = g.r;
    L = String(L || '').toUpperCase();
    if (r.phase !== 'bpick' || !isL(L) || r.used.indexOf(L) >= 0 || r.picks.indexOf(L) >= 0) return { ok: false, ev: 'invalid' };
    var nv = 0, nc = 0;
    for (var i = 0; i < r.picks.length; i++) { if (isV(r.picks.charAt(i))) nv++; else nc++; }
    if (isV(L) ? nv >= r.need.v : nc >= r.need.c) return { ok: false, ev: isV(L) ? 'full-v' : 'full-c' };
    r.picks += L;
    return { ok: true, ev: 'pick', done: r.picks.length >= r.need.v + r.need.c };
  }
  function bonusUnpick(g) {
    var r = g.r;
    if (r.phase !== 'bpick' || !r.picks) return false;
    r.picks = r.picks.slice(0, -1);
    return true;
  }
  function bonusReveal(g) {
    var r = g.r;
    if (r.phase !== 'bpick' || r.picks.length < r.need.v + r.need.c) return null;
    var idx = [];
    for (var i = 0; i < r.picks.length; i++) {
      var L = r.picks.charAt(i);
      r.used += L;
      hiddenIdx(r, L).forEach(function (j) { r.rev[j] = true; idx.push(j); });
    }
    r.phase = 'bsolve';
    return idx;
  }
  function bonusTimeout(g) {
    var r = g.r;
    r.won = false; r.phase = 'bdone'; g.over = true;
    return { ok: false, ev: 'bonus-lose', idx: revealAll(r) };
  }
  function finalTotal(p) { return p.total + p.bonus; }
  function standings(g) {
    return g.players.map(function (p, i) { return i; }).sort(function (a, b) { return finalTotal(g.players[b]) - finalTotal(g.players[a]) || a - b; });
  }

  // ---- the CPU: word-level pattern matching against the bank's vocabulary ----
  function buildDict(bank) {
    var d = {};
    bank.forEach(function (p) {
      p.text.split(' ').forEach(function (w) {
        if (!/[A-Z]/.test(w)) return;
        var b = d[w.length] || (d[w.length] = {});
        b[w] = 1;
      });
    });
    var out = {};
    for (var k in d) out[k] = Object.keys(d[k]);
    return out;
  }
  function wordsOf(text) {
    var out = [], s = 0;
    text.split(' ').forEach(function (w) { if (/[A-Z]/.test(w)) out.push({ w: w, s: s }); s += w.length + 1; });
    return out;
  }
  function cands(r, wd, dict) {
    var list = dict[wd.w.length] || [], out = [];
    for (var k = 0; k < list.length; k++) {
      var c = list[k], ok = true;
      for (var j = 0; j < c.length && ok; j++) {
        var ch = wd.w.charAt(j), cj = c.charAt(j), i = wd.s + j;
        if (!isL(ch) || r.rev[i]) ok = cj === ch;
        else ok = isL(cj) && r.used.indexOf(cj) < 0;
      }
      if (ok) out.push(c);
    }
    return out;
  }
  // how well the puzzle can be read: revealed share blended with words pinned down
  function knowledge(r, dict) {
    var T = 0, R = 0, wk = 0;
    wordsOf(r.text).forEach(function (wd) {
      var Lw = 0, Rw = 0;
      for (var j = 0; j < wd.w.length; j++) if (isL(wd.w.charAt(j))) { Lw++; if (r.rev[wd.s + j]) Rw++; }
      T += Lw; R += Rw;
      if (Rw === Lw) { wk += Lw; return; }
      var cs = cands(r, wd, dict), f = Rw / Lw;
      if (cs.length === 1 && f >= 0.34) wk += Lw;
      else if (cs.length <= 3 && f >= 0.5) wk += Lw * 0.6;
    });
    if (!T) return 1;
    return 0.4 * (R / T) + 0.6 * (wk / T);
  }
  var KNOW_TH = [1, 0.92, 0.8, 0.68, 0.58];
  function cpuKnows(g, pi, dict, bias) {
    var r = g.r, p = g.players[pi];
    if (allShown(r)) return true;
    var th = KNOW_TH[clamp(p.cpu, 1, 4)] + (rnd(g) - 0.5) * 0.1 - (bias || 0);
    return knowledge(r, dict) >= th;
  }
  function letterScores(r, dict, set) {
    var sc = {};
    for (var k = 0; k < set.length; k++) if (r.used.indexOf(set.charAt(k)) < 0) sc[set.charAt(k)] = 0;
    wordsOf(r.text).forEach(function (wd) {
      var hid = [];
      for (var j = 0; j < wd.w.length; j++) if (isL(wd.w.charAt(j)) && !r.rev[wd.s + j]) hid.push(j);
      if (!hid.length) return;
      var cs = cands(r, wd, dict);
      if (!cs.length) {
        Object.keys(sc).forEach(function (L) {
          var f = FREQ_CONS.indexOf(L) >= 0 ? (21 - FREQ_CONS.indexOf(L)) / 21 : (5 - FREQ_VOW.indexOf(L)) / 5;
          sc[L] += 0.3 * f * Math.min(1, hid.length / 3);
        });
        return;
      }
      Object.keys(sc).forEach(function (L) {
        var hit = 0;
        cs.forEach(function (c) { for (var q = 0; q < hid.length; q++) if (c.charAt(hid[q]) === L) { hit++; return; } });
        sc[L] += hit / cs.length;
      });
    });
    return sc;
  }
  function bestOf(sc, g, noise) {
    var best = null, bv = -1;
    Object.keys(sc).forEach(function (L) {
      var v = sc[L] + (noise ? rnd(g) * noise : 0);
      if (v > bv) { bv = v; best = L; }
    });
    return best;
  }
  function freqPick(g, r, order) {
    var left = order.split('').filter(function (L) { return r.used.indexOf(L) < 0; }).slice(0, 7);
    return left.length ? left[rint(g, left.length)] : null;
  }
  function cpuLetter(g, pi, dict, set) {
    var r = g.r, d = clamp(g.players[pi].cpu, 1, 4), x = rnd(g);
    var usedSet = r.used.split('').filter(function (L) { return set.indexOf(L) >= 0 && BONUS_GIVEN.indexOf(L) < 0; });
    var slip = [0, 0.08, 0.03, 0.005, 0][d];
    if (x < slip && usedSet.length && r.t !== 'bonus') return usedSet[rint(g, usedSet.length)];   // "was that one called already?"
    var sc = letterScores(r, dict, set);
    if (!Object.keys(sc).length) return null;
    var lazy = [0, 0.55, 0.3, 0.06, 0][d];
    if (rnd(g) < lazy) { var f = freqPick(g, r, set === VOWELS ? FREQ_VOW : set === CONS ? FREQ_CONS : FREQ_CONS + FREQ_VOW); if (f) return f; }
    return bestOf(sc, g, [0, 0.5, 0.25, 0.05, 0][d]);
  }
  function cpuTurn(g, pi, dict) {
    var r = g.r, p = g.players[pi], d = clamp(p.cpu, 1, 4);
    if (allShown(r)) return 'solve';
    if (cpuKnows(g, pi, dict)) return 'solve';
    var cl = consLeft(r), buy = p.round >= VOWEL_COST && vowelsLeft(r);
    if (!cl) return buy ? 'vowel' : 'guess';
    if (buy) {
      var sc = letterScores(r, dict, VOWELS), bv = 0;
      Object.keys(sc).forEach(function (L) { bv = Math.max(bv, sc[L]); });
      if (d >= 3 && bv >= 0.85 && rnd(g) < 0.7) return 'vowel';
      if (d === 2 && rnd(g) < 0.28) return 'vowel';
      if (d === 1 && rnd(g) < 0.35) return 'vowel';
    }
    return 'spin';
  }
  function cpuFlip(g, pi) {
    var p = g.players[pi], d = clamp(p.cpu, 1, 4);
    if (d >= 3) return p.round < 2000 && rnd(g) < 0.65;
    return rnd(g) < 0.45;
  }
  // a CPU's answer: right when it knows, else its best reading of each word
  function cpuGuess(g, pi, dict, knows) {
    var r = g.r;
    if (knows) return r.text;
    var chars = r.text.split('');
    wordsOf(r.text).forEach(function (wd) {
      var cs = cands(r, wd, dict), pick = cs.length ? cs[rint(g, cs.length)] : null;
      for (var j = 0; j < wd.w.length; j++) {
        var i = wd.s + j;
        if (!r.rev[i] && isL(chars[i])) chars[i] = pick ? pick.charAt(j) : 'E';
      }
    });
    return chars.join('');
  }
  function cpuBonusPicks(g, pi, dict) {
    var r = g.r, d = clamp(g.players[pi].cpu, 1, 4), out = '';
    var sc = letterScores(r, dict, CONS);
    for (var k = 0; k < r.need.c; k++) {
      var L = d <= 1 && rnd(g) < 0.6 ? null : bestOf(sc, g, [0, 0.6, 0.3, 0.08, 0][d]);
      if (!L || out.indexOf(L) >= 0) { var pool = 'CDMGHPBKWFY'.split('').filter(function (x) { return out.indexOf(x) < 0 && r.used.indexOf(x) < 0; }); L = pool[rint(g, pool.length)]; }
      out += L; delete sc[L];
    }
    var sv = letterScores(r, dict, VOWELS), V = d <= 1 ? 'AOIU'.charAt(rint(g, 4)) : bestOf(sv, g, 0.1);
    return out + (V || 'A');
  }
  function cpuSpin(g) { return 7.5 + rnd(g) * 10; }

  // ---- settings, stats, saves ----
  function normSettings(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      rounds: clamp(o.rounds | 0 || 3, 1, 5), diff: clamp(o.diff | 0 || 2, 1, 4),
      timer: [0, 10, 15, 20, 30].indexOf(o.timer | 0) >= 0 ? o.timer | 0 : 0,
      clock: [30, 45, 60, 90].indexOf(o.clock | 0) >= 0 ? o.clock | 0 : 45,
      anim: ['slow', 'normal', 'fast'].indexOf(o.anim) >= 0 ? o.anim : 'normal'
    };
  }
  function newStats() { return { v: 1, games: 0, wins: 0, bestBank: 0, bestRound: 0, bonusPlays: 0, bonusWins: 0, solves: 0, earned: 0, board: [] }; }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    ['games', 'wins', 'bestBank', 'bestRound', 'bonusPlays', 'bonusWins', 'solves', 'earned'].forEach(function (k) { s[k] = Math.max(0, +o[k] || 0); });
    if (Array.isArray(o.board)) s.board = o.board.filter(function (e) { return e && typeof e.n === 'string' && isFinite(e.v); }).slice(0, 10);
    return s;
  }
  function recordGame(stats, g, date) {
    var s = normStats(stats), win = standings(g)[0], r = g.r, humans = 0;
    g.players.forEach(function (p, i) {
      if (p.cpu) return;
      humans++;
      var t = finalTotal(p);
      s.earned += t; s.bestBank = Math.max(s.bestBank, t); s.bestRound = Math.max(s.bestRound, p.best); s.solves += p.solves;
      s.board.push({ n: p.name, v: t, b: p.bonus > 0 ? 1 : 0, d: date || '' });
    });
    if (!humans) return s;
    s.games++;
    if (!g.players[win].cpu) s.wins++;
    if (r && r.t === 'bonus' && r.turn >= 0 && !g.players[r.turn].cpu && (r.phase === 'bdone')) { s.bonusPlays++; if (r.won) s.bonusWins++; }
    s.board.sort(function (a, b) { return b.v - a.v; });
    s.board = s.board.slice(0, 10);
    return s;
  }
  function normGame(o) {
    if (!o || o.v !== VER || !Array.isArray(o.players) || !o.players.length || o.players.length > 4 || !Array.isArray(o.seq) || !o.r || typeof o.r.text !== 'string') return null;
    if (o.over) return null;
    var r = o.r;
    if (!Array.isArray(r.rev) || r.rev.length !== r.text.length) return null;
    if (r.phase === 'spin') r.phase = r.from || 'turn';
    if (r.phase === 'solve') { r.phase = r.from === 'speedSolve' ? 'speedSolve' : (r.from || 'turn'); r.from = ''; }
    if (r.phase === 'tossSolve') { r.phase = 'toss'; r.turn = -1; }
    if (r.phase === 'bsolve' || r.phase === 'bdone' || r.phase === 'done') return null;   // nothing worth resuming mid-reveal
    return o;
  }

  var ENGINE = {
    VER: VER, VOWELS: VOWELS, CONS: CONS, ALPHA: ALPHA, VOWEL_COST: VOWEL_COST, MIN_WIN: MIN_WIN, ROW_CAP: ROW_CAP, ROW_OFF: ROW_OFF, COLS: COLS,
    BONUS_GIVEN: BONUS_GIVEN, DIFFS: DIFFS, PRIZES: PRIZES, SPIN_MIN: SPIN_MIN, SPIN_MAX: SPIN_MAX, TAU: TAU,
    norm: norm, lettersOnly: lettersOnly, hashId: hashId, mulberry32: mulberry32, rnd: rnd, fmt: fmt,
    parseBank: parseBank, pickPuzzle: pickPuzzle, noteRecent: noteRecent, bonusOk: bonusOk, layoutBoard: layoutBoard,
    newRev: newRev, hiddenIdx: hiddenIdx, leftOf: leftOf, consLeft: consLeft, vowelsLeft: vowelsLeft, allShown: allShown, solveMatches: solveMatches,
    makeWheel: makeWheel, bonusWheel: bonusWheel, envLabel: envLabel, wedgeOf: wedgeOf, wedgeAt: wedgeAt, spinStep: spinStep, spinRest: spinRest,
    buildSeq: buildSeq, newGame: newGame, nextKind: nextKind, stage: stage, startRound: startRound, cur: cur, settle: settle, tickClock: tickClock,
    nextTurn: nextTurn, canSpin: canSpin, canBuy: canBuy, startSpin: startSpin, spinLand: spinLand, enterSpeed: enterSpeed, buyVowel: buyVowel, cancelVowel: cancelVowel,
    callLetter: callLetter, mystery: mystery, startSolve: startSolve, cancelSolve: cancelSolve, trySolve: trySolve, buzz: buzz, tossReveal: tossReveal,
    tossEnd: tossEnd, tossFail: tossFail, passSpeed: passSpeed, timeout: timeout, bonusPlayer: bonusPlayer, bonusPick: bonusPick, bonusUnpick: bonusUnpick,
    bonusReveal: bonusReveal, bonusTimeout: bonusTimeout, finalTotal: finalTotal, standings: standings,
    buildDict: buildDict, cands: cands, wordsOf: wordsOf, knowledge: knowledge, cpuKnows: cpuKnows, letterScores: letterScores, cpuLetter: cpuLetter,
    cpuTurn: cpuTurn, cpuFlip: cpuFlip, cpuGuess: cpuGuess, cpuBonusPicks: cpuBonusPicks, cpuSpin: cpuSpin,
    normSettings: normSettings, newStats: newStats, normStats: normStats, recordGame: recordGame, normGame: normGame
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade, E = ENGINE;
  Cade.loadCSS('wheel.css');
  var DATA_URL = Cade.asset('wheel-data.js');   // resolve now, while currentScript is us

  var PANEL_ID = 'wheel-panel', NAME = 'Spin & Solve';
  var KEY = 'cade-wheel-', SET_KEY = KEY + 'settings', STATS_KEY = KEY + 'stats', RECENT_KEY = KEY + 'recent', GAME_KEY = KEY + 'game',
    SOUND_KEY = KEY + 'sound', SETUP_KEY = KEY + 'setup', SEEN_KEY = KEY + 'seen';
  var S = null, DATA = null, loading = null, BANK = null, DICT = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.wheel = { live: function () { return S; }, engine: ENGINE };

  var FUN = ['Ace', 'Blaze', 'Comet', 'Dazzle', 'Echo', 'Fizz', 'Gizmo', 'Hazel', 'Iggy', 'Jazz', 'Kiki', 'Lucky', 'Maple', 'Nova', 'Ollie', 'Pip',
    'Quinn', 'Rory', 'Sunny', 'Tango', 'Waffles', 'Yoyo', 'Ziggy', 'Biscuit', 'Pickles', 'Rocket', 'Sprout', 'Noodle', 'Cosmo', 'Mochi', 'Pepper',
    'Juniper', 'Dash', 'Clover', 'Marbles', 'Toffee', 'Bingo', 'Sparky', 'Lulu', 'Taffy'];
  var NCOL = 8;
  var SPF = { slow: 1.5, normal: 1, fast: 0.55 };
  var ART = [
    '  .-"""-.    S P I N',
    ' / \\ | / \\     &   ',
    '|-- (*) --|  S O L V E',
    ' \\ / | \\ /          ',
    "  '-...-'   *  *  *  *"
  ].join('\n');

  function loadData() {
    if (DATA) return Promise.resolve(DATA);
    if (window.__cadeWheelData) { DATA = window.__cadeWheelData; return Promise.resolve(DATA); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = DATA_URL; s.async = true;
      s.onload = function () {
        if (window.__cadeWheelData && window.__cadeWheelData.cats) { DATA = window.__cadeWheelData; resolve(DATA); }
        else { loading = null; reject(new Error('no data')); }
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function money(n) { return (n < 0 ? '-$' : '$') + fmt(Math.abs(n)); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function normSetup(o) {
    o = o && typeof o === 'object' ? o : {};
    var seats = Array.isArray(o.seats) && o.seats.length ? o.seats.slice(0, 4) : [{ name: 'You', color: 0, cpu: 0 }, { name: 'Comet', color: 1, cpu: 2 }, { name: 'Maple', color: 2, cpu: 2 }];
    return {
      mode: o.mode === 'party' ? 'party' : 'solo',
      seats: seats.map(function (s, i) {
        return { name: String(s && s.name || FUN[i]).slice(0, 12) || FUN[i], color: ((s && s.color | 0) % NCOL + NCOL) % NCOL, cpu: clamp(s && s.cpu | 0, 0, 4) };
      })
    };
  }
  function persistSetup() { if (S) sset(SETUP_KEY, JSON.stringify(S.setup)); }
  function persistSettings() { if (S) sset(SET_KEY, JSON.stringify(S.set)); }
  function persistStats() { if (S) sset(STATS_KEY, JSON.stringify(S.stats)); }
  function saveGame() {
    if (!S || !S.g) return;
    if (S.g.over) { sdel(GAME_KEY); return; }
    try { sset(GAME_KEY, JSON.stringify(S.g)); } catch (e) {}
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.lastTick = 0; }
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
  Snd.prototype.tick = function () {
    var ac = this.ac;
    if (!ac) return;
    var t = ac.currentTime;
    if (t - this.lastTick < 0.025) return;
    this.lastTick = t;
    this.tone(2100, 0.018, 'square', 0.022);
  };
  Snd.prototype.ding = function (d) { this.tone(1318, 0.32, 'sine', 0.05, 0, d); this.tone(2637, 0.18, 'sine', 0.015, 0, d); };
  Snd.prototype.flip = function () { this.tone(700, 0.04, 'triangle', 0.025, 420); };
  Snd.prototype.buzz = function () { this.tone(140, 0.38, 'sawtooth', 0.045, 90); this.tone(147, 0.38, 'square', 0.02, 95); };
  Snd.prototype.bank = function () { this.tone(520, 0.9, 'sawtooth', 0.05, 60); this.tone(380, 0.9, 'square', 0.02, 45, 0.05); };
  Snd.prototype.cash = function () { this.tone(1568, 0.07, 'square', 0.025); this.tone(2093, 0.12, 'square', 0.025, 0, 0.07); };
  Snd.prototype.buzzer = function () { this.tone(660, 0.16, 'square', 0.04); this.tone(880, 0.2, 'square', 0.035, 0, 0.1); };
  Snd.prototype.beep = function () { this.tone(990, 0.06, 'sine', 0.035); };
  Snd.prototype.fanfare = function () {
    var self = this;
    [523, 659, 784, 1047, 784, 1047].forEach(function (f, i) { self.tone(f, i === 5 ? 0.5 : 0.14, 'triangle', 0.05, 0, i * 0.11); });
  };
  Snd.prototype.whoosh = function () { this.tone(240, 0.35, 'sawtooth', 0.018, 900); };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_TROPHY = svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>');

  // ---- theme (canvas colors come from CSS custom properties) ----
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function lum(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = lum(bg) < 0.45, T = { dark: dark, bg: bg, text: tx, acc: ac, w: [], p: [] };
    T.muted = parseCol(v('--text-muted'), mix(bg, tx, 0.55));
    T.surface = parseCol(v('--surface'), mix(bg, tx, 0.04));
    T.font = (v('--font-mono') || '').trim() || 'ui-monospace, monospace';
    for (var i = 0; i < 8; i++) {
      T.w.push(parseCol(v('--wh-w' + i), [200, 80, 80]));
      T.p.push(parseCol(v('--wh-c' + i), ac));
    }
    T.gold = parseCol(v('--wh-gold'), [212, 160, 23]);
    T.bk = [18, 18, 20];
    T.lose = [244, 243, 238];
    T.vio = parseCol(v('--wh-vio'), [110, 70, 190]);
    T.free = parseCol(v('--wh-free'), [40, 160, 90]);
    S.T = T;
    S.faceKey = '';
  }

  // ---- jobs: a pause-safe scheduler on the game clock ----
  function after(ms, fn, tag) { if (!S) return; S.jobs.push({ at: S.now + ms, fn: fn, tag: tag || '' }); ensureLoop(); }
  function cancelJobs(tag) { if (S) S.jobs = S.jobs.filter(function (j) { return j.tag !== tag; }); }
  function hasJob(tag) { return !!S && S.jobs.some(function (j) { return j.tag === tag; }); }
  function runJobs() {
    if (!S.jobs.length) return;
    var now = S.now, due = [];
    S.jobs = S.jobs.filter(function (j) { if (j.at <= now) { due.push(j); return false; } return true; });
    due.sort(function (a, b) { return a.at - b.at; });
    for (var i = 0; i < due.length; i++) { if (!S) return; due[i].fn(); }
  }

  // ---- the board ----
  function buildBoard() {
    var h = '';
    for (var r = 0; r < 4; r++) for (var c = 0; c < 14; c++) {
      var gap = (r === 0 || r === 3) && (c === 0 || c === 13);
      h += '<div class="wh-t' + (gap ? ' gap' : '') + '" data-r="' + r + '" data-c="' + c + '"><span></span></div>';
    }
    S.boardEl.innerHTML = h;
    S.tiles = Array.prototype.slice.call(S.boardEl.children);
  }
  function newBoard() {
    var r = S.g.r, lay = layoutBoard(r.text);
    S.tileOf = {}; S.shown = []; S.lit = []; S.fill = null;
    S.tiles.forEach(function (t) { t.className = t.classList.contains('gap') ? 'wh-t gap' : 'wh-t'; t.removeAttribute('data-i'); t.firstChild.textContent = ''; });
    for (var i = 0; i < r.text.length; i++) { S.shown.push(!isL(r.text.charAt(i))); S.lit.push(false); }
    (lay ? lay.cells : []).forEach(function (cell) {
      var t = S.tiles[cell.r * 14 + cell.c];
      t.classList.add('in');
      t.setAttribute('data-i', cell.i);
      S.tileOf[cell.i] = t;
    });
    S.boardId = r.id + ':' + S.g.ri;
    paintTiles();
  }
  function paintTile(i, flip) {
    var t = S.tileOf[i];
    if (!t) return;
    var r = S.g.r, ch = r.text.charAt(i), sh = S.shown[i], f = S.fill && !sh ? S.fill[i] : '';
    var curI = S.fill && S.slots ? S.slots[S.cur] : -1;
    t.firstChild.textContent = sh ? ch : (f || '');
    t.classList.toggle('sh', !!sh);
    t.classList.toggle('lit', !!S.lit[i] && !sh);
    t.classList.toggle('typ', !!f);
    t.classList.toggle('cur', i === curI);
    t.classList.toggle('slot', !!S.fill && !sh);
    if (flip) { t.classList.remove('flip'); void t.offsetWidth; t.classList.add('flip'); }
  }
  function paintTiles() { if (!S.g || !S.g.r) return; for (var k in S.tileOf) paintTile(+k, false); }
  // light the tiles, then turn them one at a time (reading order), then cb
  function revealSeq(idx, opt, cb) {
    opt = opt || {};
    idx = idx.filter(function (i) { return !S.shown[i]; }).sort(function (a, b) { return a - b; });
    if (!idx.length) { if (cb) cb(); return; }
    S.busy++;
    var spf = S.spf, gap = (opt.fast ? 110 : 430) * spf, t0 = (opt.fast ? 120 : 520) * spf;
    idx.forEach(function (i, k) {
      S.lit[i] = true; paintTile(i);
      if (!opt.quiet && !opt.fast) after(k * 110 * spf, function () { S.snd.ding(); });
    });
    idx.forEach(function (i, k) {
      after(t0 + k * gap, function () { S.lit[i] = false; S.shown[i] = true; paintTile(i, true); if (!opt.quiet) S.snd.flip(); });
    });
    after(t0 + idx.length * gap + 160 * spf, function () { S.busy = Math.max(0, S.busy - 1); if (cb) cb(); });
  }
  function boardFx(cls, ms) {
    var w = S.boardW;
    w.classList.remove(cls); void w.offsetWidth; w.classList.add(cls);
    clearTimeout(S['fx_' + cls]);
    S['fx_' + cls] = setTimeout(function () { if (S) w.classList.remove(cls); }, ms || 1200);
  }
  function buildLights() {
    var w = S.boardW.offsetWidth, h = S.boardW.offsetHeight;
    if (!w || !h) return;
    var key = w + 'x' + h;
    if (S.lightsKey === key) return;
    S.lightsKey = key;
    var step = 14, per = 2 * (w + h), n = Math.max(12, Math.round(per / step)), out = '';
    for (var k = 0; k < n; k++) {
      var d = (k / n) * per, x, y;
      if (d < w) { x = d; y = 0; } else if (d < w + h) { x = w; y = d - w; } else if (d < 2 * w + h) { x = w - (d - w - h); y = h; } else { x = 0; y = h - (d - 2 * w - h); }
      out += '<i style="left:' + (x / w * 100).toFixed(2) + '%;top:' + (y / h * 100).toFixed(2) + '%" class="l' + (k % 3) + '"></i>';
    }
    S.lightsEl.innerHTML = out;
  }

  // ---- the keyboard ----
  function buildKb() {
    var h = '';
    for (var k = 0; k < 26; k++) {
      var L = ALPHA.charAt(k);
      h += '<button type="button" class="wh-k' + (isV(L) ? ' v' : '') + '" data-l="' + L + '" tabindex="-1">' + L + '</button>';
    }
    h += '<button type="button" class="wh-k bk" data-l="back" tabindex="-1" aria-label="Backspace">&#9003;</button>';
    S.kb.innerHTML = h;
    S.keys = {};
    Array.prototype.forEach.call(S.kb.children, function (b) { S.keys[b.getAttribute('data-l')] = b; });
  }
  function solving(ph) { return ph === 'solve' || ph === 'tossSolve' || ph === 'bsolve'; }
  function paintKb() {
    var g = S.g, r = g && g.r, p = g && E.cur(g), ph = r ? r.phase : '', human = !!p && !p.cpu && S.mode === 'play';
    var set = '';
    if (human && !S.busy) {
      if (ph === 'call') set = CONS;
      else if (ph === 'vowel') set = VOWELS;
      else if (ph === 'free' || ph === 'speedCall' || ph === 'bpick') set = ALPHA;
      else if (solving(ph)) set = ALPHA;
    }
    for (var k = 0; k < 26; k++) {
      var L = ALPHA.charAt(k), b = S.keys[L], used = !!r && r.used.indexOf(L) >= 0, pk = !!r && ph === 'bpick' && r.picks.indexOf(L) >= 0;
      var on = set.indexOf(L) >= 0 && (solving(ph) || (!used && !pk));
      b.classList.toggle('used', used);
      b.classList.toggle('pk', pk);
      b.classList.toggle('on', on);
      b.disabled = !on;
    }
    var bb = S.keys.back, bon = human && !S.busy && (solving(ph) || (ph === 'bpick' && !!r.picks));
    bb.classList.toggle('on', bon); bb.disabled = !bon;
    S.kb.classList.toggle('solve', solving(ph));
  }
  function pressKey(L) {
    var b = S.keys[L];
    if (!b) return;
    b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
  }

  // ---- HUD / category / message ----
  function renderHud() {
    var g = S.g;
    if (!g) { S.hud.innerHTML = ''; return; }
    var r = g.r, main = r && (r.t === 'main');
    S.hud.innerHTML = g.players.map(function (p, i) {
      var on = r && r.turn === i && r.phase !== 'done', locked = r && r.t === 'toss' && r.locked.indexOf(i) >= 0;
      var held = r && r.held && r.held[i] && r.held[i].length ? '<em title="Prize">&#127873;</em>' : '';
      return '<div class="wh-pl wc' + p.color + (on ? ' on' : '') + (locked ? ' lk' : '') + '" data-p="' + i + '">' +
        '<div class="wh-pn">' + (p.cpu ? '<i>&#129302;</i>' : '') + esc(p.name) + (p.wild ? '<em title="WILD card">W</em>' : '') + held + '</div>' +
        '<div class="wh-pr">' + (main || (r && r.t === 'bonus') ? money(r && r.t === 'bonus' ? p.total : p.round) : (r && r.t === 'toss' ? (locked ? 'LOCKED' : '&mdash;') : '$0')) + '</div>' +
        '<div class="wh-pt">' + (main ? 'bank ' + money(p.total) : r && r.t === 'bonus' ? 'bonus' : 'bank ' + money(p.total)) + '<b class="wh-tm"></b></div></div>';
    }).join('');
    paintTimer(true);
  }
  function paintTimer(force) {
    if (!S.g || !S.g.r) return;
    var r = S.g.r, txt = '';
    if (S.tm && S.tm.total && r.turn >= 0) txt = Math.ceil(Math.max(0, S.tm.left)) + 's';
    var el = S.hud.querySelector('.wh-pl.on .wh-tm');
    if (el && (force || el.textContent !== txt)) el.textContent = txt ? ' \u23F1' + txt : '';
    if (el) el.parentNode.parentNode.classList.toggle('hurry', !!txt && S.tm.left <= 5);
    paintCat();
  }
  function paintCat() {
    var g = S.g, r = g && g.r;
    if (!r) { S.catEl.innerHTML = ''; return; }
    var st = E.stage(g), lab;
    if (r.t === 'toss') lab = 'TOSS-UP ' + money(r.val);
    else if (r.t === 'bonus') lab = 'BONUS ROUND';
    else lab = 'ROUND ' + (r.m + 1) + (st && st.final ? ' \u00B7 FINAL' : '');
    var extra = '';
    if (r.t === 'main' && r.speed) extra = '<b class="wh-spd">SPEED-UP ' + money(r.speed) + '</b>';
    else if (r.t === 'main' && r.final) { var s = Math.ceil(r.clock); extra = '<b class="wh-clk' + (s <= 10 ? ' hurry' : '') + '">\u23F0 ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + '</b>'; }
    else if (r.t === 'bonus' && r.env >= 0) extra = '<b>&#9993; sealed</b>';
    var html = '<span class="wh-cn">' + esc(r.cat) + '</span><span class="wh-rn">' + lab + '</span>' + extra;
    if (html !== S.catHtml) { S.catHtml = html; S.catEl.innerHTML = html; }
  }
  function say(html, cls) {
    S.msgEl.innerHTML = html;
    S.msgEl.className = 'wh-msg' + (cls ? ' ' + cls : '');
    var t = S.msgEl.textContent;
    if (S.live && t) S.live.textContent = t;
  }
  function nm(i) { var p = S.g.players[i]; return '<b class="wc' + p.color + '">' + esc(p.name) + '</b>'; }

  // ---- the action row ----
  function btn(act, label, cls, extra) { return '<button type="button" class="wh-a' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' + (extra || '') + '>' + label + '</button>'; }
  function renderAct(force) {
    var g = S.g, r = g && g.r, p = g && E.cur(g), ph = r ? r.phase : '', human = !!p && !p.cpu;
    var key = [S.mode, g ? g.ri : -1, ph, r ? r.turn : -1, S.busy ? 1 : 0, r ? r.used : '', r ? r.picks : '', r ? (r.locked || []).join() : '', S.card || '', S.wmodal ? 1 : 0].join('|');
    if (!force && key === S.actKey) return;
    S.actKey = key;
    var h = '';
    var k = S.coarse ? '' : 1;
    function kh(s) { return k ? '<small>' + s + '</small>' : ''; }
    if (!r || S.mode !== 'play') h = '';
    else if (ph === 'toss') {
      h = '<div class="wh-buzz">' + g.players.map(function (q, i) {
        var lk = r.locked.indexOf(i) >= 0;
        return '<button type="button" class="wh-bz wc' + q.color + (q.cpu ? ' cpu' : '') + (lk ? ' lk' : '') + '" data-buzz="' + i + '"' + (q.cpu || lk ? ' disabled' : '') + '>' +
          '<b>' + (q.cpu ? '&#129302; ' : '&#128276; ') + esc(q.name) + '</b><small>' + (lk ? 'locked out' : q.cpu ? 'CPU' : (S.coarse ? 'tap to buzz' : 'key ' + (i + 1))) + '</small></button>';
      }).join('') + '</div>';
    } else if (ph === 'done' || ph === 'bdone') h = btn('next', 'Continue &#9656;', 'go');
    else if (S.busy && ph !== 'spin') h = '<div class="wh-wait">&middot; &middot; &middot;</div>';
    else if (!human) h = '<div class="wh-wait">' + (p ? '&#129302; ' + esc(p.name) + ' is ' + (ph === 'spin' ? 'spinning' : 'thinking') + '&hellip;' : '') + '</div>';
    else if (ph === 'turn') {
      h = btn('spin', '<span class="wh-pow"><i></i></span>SPIN' + kh(S.wmodal ? 'hold Space' : 'hold Space / flick'), 'spin', E.canSpin(g) ? '' : ' disabled') +
        btn('vowel', 'VOWEL<small>' + money(VOWEL_COST) + (k ? ' &middot; V' : '') + '</small>', 'alt', E.canBuy(g) ? '' : ' disabled') +
        btn('solve', 'SOLVE' + kh('Enter'), 'alt');
    } else if (ph === 'bspin' || ph === 'final') {
      h = ph === 'final' ? '<div class="wh-wait">&#9200; final spin&hellip;</div>' : btn('spin', '<span class="wh-pow"><i></i></span>SPIN FOR AN ENVELOPE' + kh('hold Space'), 'spin');
    } else if (ph === 'spin') h = '<div class="wh-wait">round and round&hellip;</div>';
    else if (ph === 'call') h = '<div class="wh-hint">Call a <b>consonant</b> &middot; ' + money(r.wv) + ' each</div>';
    else if (ph === 'vowel') h = '<div class="wh-hint">Pick a <b>vowel</b></div>' + btn('cancel', 'Cancel', 'alt sm');
    else if (ph === 'free') h = '<div class="wh-hint"><b>FREE PLAY</b> &middot; any letter</div>' + btn('solve', 'SOLVE', 'alt sm');
    else if (ph === 'mystery') h = btn('flip', 'FLIP IT!<small>$10,000 or BANKRUPT' + (k ? ' &middot; Y' : '') + '</small>', 'go') + btn('keep', 'NO THANKS' + kh('N'), 'alt');
    else if (solving(ph)) {
      h = (ph === 'solve' && r.from !== 'speedSolve' ? btn('cancel', 'Back', 'alt sm') : '') + '<div class="wh-hint">Fill the blanks</div>' + btn('enter', 'SOLVE &#10003;' + kh('Enter'), 'go');
    } else if (ph === 'speedCall') h = '<div class="wh-hint">Any letter &middot; consonants ' + money(r.speed) + ', vowels free</div>';
    else if (ph === 'speedSolve') h = btn('solve', 'SOLVE' + kh('Enter'), 'go') + btn('pass', 'PASS' + kh('Esc'), 'alt');
    else if (ph === 'bpick') {
      var need = r.need, slots = '';
      for (var q = 0; q < need.c + need.v; q++) {
        var ch = '', want = q < need.c ? 'c' : 'v', nc = 0, nv = 0;
        for (var z = 0; z < r.picks.length; z++) {
          var L = r.picks.charAt(z), isv = isV(L);
          if (!isv) { if (want === 'c' && nc === q) ch = L; nc++; } else { if (want === 'v' && nv === q - need.c) ch = L; nv++; }
        }
        slots += '<i class="' + want + (ch ? ' f' : '') + '">' + (ch || (want === 'v' ? 'v' : 'c')) + '</i>';
      }
      h = '<div class="wh-picks">' + slots + '</div>' + btn('enter', 'GO &#9656;', 'go', r.picks.length >= need.c + need.v ? '' : ' disabled');
    }
    S.act.innerHTML = h;
  }

  // ---- the wheel ----
  function wheelList() { var r = S.g && S.g.r; return r && r.wheel ? r.wheel : E.makeWheel(0); }
  function wedgeLook(w, r) {
    var T = S.T, lab, col, big = false;
    if (r && w.k !== 'env') w = r.t === 'main' ? E.wedgeOf(r, r.wheel.indexOf(w)) : w;
    switch (w.k) {
      case 'bk': col = T.bk; lab = 'BANKRUPT'; break;
      case 'lose': col = T.lose; lab = 'LOSE A TURN'; break;
      case 'free': col = T.free; lab = 'FREE PLAY'; break;
      case 'wild': col = T.vio; lab = 'WILD'; break;
      case 'mys': col = mix(T.vio, T.bk, 0.45); lab = '?'; big = true; break;
      case 'prize': col = T.gold; lab = 'PRIZE'; break;
      case 'env': col = null; lab = ''; break;
      default: col = w.top ? T.gold : null; lab = '$' + w.v;
    }
    return { col: col, lab: lab, big: big };
  }
  function buildFace() {
    var D = S.wD, dpr = S.wDpr, n, list = wheelList(), r = S.g && S.g.r;
    var key = [D, dpr, S.g ? S.g.ri : -1, r ? JSON.stringify(r.taken) + r.mysDone : '', S.T.dark, list.length].join('|');
    if (key === S.faceKey && S.face) return;
    S.faceKey = key;
    var cv = S.face || (S.face = document.createElement('canvas'));
    cv.width = Math.round(D * dpr); cv.height = Math.round(D * dpr);
    var x = cv.getContext('2d'), T = S.T, c = D / 2, R = S.wR;
    n = list.length;
    var W = TAU / n;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, D, D);
    x.translate(c, c);
    for (var i = 0; i < n; i++) {
      var w = list[i], lk = wedgeLook(w, w.k === 'env' ? null : r), col = lk.col || (w.k === 'env' ? (i % 2 ? T.acc : mix(T.acc, T.bk, 0.35)) : T.w[i % 8]);
      var a0 = -Math.PI / 2 + i * W;
      x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R, a0, a0 + W); x.closePath();
      var grd = x.createRadialGradient(0, 0, R * 0.15, 0, 0, R);
      grd.addColorStop(0, rgb(mix(col, [255, 255, 255], 0.12))); grd.addColorStop(1, rgb(mix(col, [0, 0, 0], 0.08)));
      x.fillStyle = grd; x.fill();
      x.lineWidth = Math.max(1, R * 0.012); x.strokeStyle = rgb(mix(T.bk, T.gold, 0.25), 0.7); x.stroke();
      // the label, stacked from the rim toward the hub
      x.save();
      x.rotate(a0 + W / 2 + Math.PI / 2);
      var txc = lum(col) > 0.55 ? '#141414' : '#ffffff';
      x.fillStyle = txc; x.textAlign = 'center'; x.textBaseline = 'middle';
      if (w.k === 'env') {
        var ey = -R * 0.72, ew = R * 0.16, eh = R * 0.11;
        x.fillStyle = '#fbf8ef'; x.fillRect(-ew / 2, ey - eh / 2, ew, eh);
        x.strokeStyle = '#444'; x.lineWidth = 1; x.strokeRect(-ew / 2, ey - eh / 2, ew, eh);
        x.beginPath(); x.moveTo(-ew / 2, ey - eh / 2); x.lineTo(0, ey + eh * 0.1); x.lineTo(ew / 2, ey - eh / 2); x.stroke();
        if (w.car || w.v >= 100000) { x.fillStyle = txc; x.font = '700 ' + Math.round(R * 0.08) + 'px ' + T.font; x.fillText('\u2605', 0, -R * 0.5); }
      } else {
        var lab = lk.lab.replace(/ /g, ''), len = lab.length, fs = lk.big ? R * 0.2 : Math.min(R * 0.115, (R * 0.7) / Math.max(1, len));
        x.font = '700 ' + Math.round(fs) + 'px ' + T.font;
        for (var j = 0; j < len; j++) x.fillText(lab.charAt(j), 0, -R * 0.89 + fs * 0.5 + j * fs * 0.98);
      }
      x.restore();
    }
    // pegs on the rim between wedges
    for (var k = 0; k < n; k++) {
      var a = -Math.PI / 2 + k * W;
      x.beginPath(); x.arc(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95, Math.max(1.5, R * 0.018), 0, TAU);
      x.fillStyle = rgb(T.gold); x.fill();
      x.lineWidth = 0.8; x.strokeStyle = 'rgba(0,0,0,0.4)'; x.stroke();
    }
  }
  function drawWheel() {
    if (!S.wctx || !S.wD) return;
    buildFace();
    var x = S.wctx, D = S.wD, dpr = S.wDpr, c = D / 2, R = S.wR, T = S.T, n = wheelList().length, now = S.now / 1000;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, D, D);
    // the outer ring + chaser bulbs
    x.beginPath(); x.arc(c, c, R + R * 0.075, 0, TAU);
    x.fillStyle = rgb(mix(T.bk, T.gold, T.dark ? 0.18 : 0.12)); x.fill();
    var nb = 36, spd = S.spin.on ? 10 + Math.abs(S.spin.w) * 1.4 : 3, ph = Math.floor(now * spd);
    for (var b = 0; b < nb; b++) {
      var ba = b / nb * TAU, on = (b + ph) % 3 === 0;
      x.beginPath(); x.arc(c + Math.cos(ba) * R * 1.04, c + Math.sin(ba) * R * 1.04, Math.max(1.5, R * 0.022), 0, TAU);
      x.fillStyle = on ? '#fff6c8' : rgb(mix(T.gold, T.bk, 0.45));
      x.fill();
    }
    x.save();
    x.translate(c, c); x.rotate(S.spin.a);
    x.drawImage(S.face, -c, -c, D, D);
    // the landed wedge glows for a moment
    if (S.hiW >= 0 && S.now - S.hiT < 2200) {
      var W = TAU / n, a0 = -Math.PI / 2 + S.hiW * W, al = 0.5 + 0.5 * Math.sin((S.now - S.hiT) / 90);
      x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R, a0, a0 + W); x.closePath();
      x.lineWidth = Math.max(2, R * 0.03); x.strokeStyle = 'rgba(255,246,200,' + (0.4 + 0.6 * al).toFixed(2) + ')'; x.stroke();
    }
    x.restore();
    // hub
    var hr = R * 0.2;
    var hg = x.createRadialGradient(c - hr * 0.3, c - hr * 0.3, hr * 0.1, c, c, hr);
    hg.addColorStop(0, rgb(mix(T.gold, [255, 255, 255], 0.5))); hg.addColorStop(1, rgb(mix(T.gold, T.bk, 0.3)));
    x.beginPath(); x.arc(c, c, hr, 0, TAU); x.fillStyle = hg; x.fill();
    x.lineWidth = 2; x.strokeStyle = rgb(mix(T.gold, T.bk, 0.5)); x.stroke();
    x.fillStyle = '#1a1406'; x.textAlign = 'center'; x.textBaseline = 'middle';
    var hub = S.hubTxt || (S.g && S.g.r && S.g.r.t === 'bonus' ? 'BONUS' : 'SPIN');
    x.font = '700 ' + Math.round(Math.min(hr * 0.5, (hr * 1.7) / Math.max(4, hub.length))) + 'px ' + T.font;
    x.fillText(hub, c, c + 1);
    // the pointer (a flapper that kicks on every peg)
    x.save();
    x.translate(c, c - R * 1.1);
    x.rotate(S.flap);
    x.beginPath(); x.moveTo(-R * 0.075, 0); x.lineTo(R * 0.075, 0); x.lineTo(0, R * 0.2); x.closePath();
    x.fillStyle = rgb(T.acc); x.fill();
    x.lineWidth = 1.5; x.strokeStyle = T.dark ? '#fff' : '#111'; x.stroke();
    x.beginPath(); x.arc(0, 0, R * 0.04, 0, TAU); x.fillStyle = T.dark ? '#fff' : '#111'; x.fill();
    x.restore();
    // the power meter for a held SPIN
    if (S.pow) {
      var v = powVal();
      x.beginPath(); x.arc(c, c, R * 0.27, -Math.PI / 2, -Math.PI / 2 + TAU * v);
      x.lineWidth = Math.max(3, R * 0.05); x.strokeStyle = v > 0.8 ? '#e5484d' : v > 0.5 ? rgb(T.gold) : rgb(T.free); x.stroke();
    }
  }
  function powVal() {
    if (!S.pow) return 0;
    var t = (S.now - S.pow.t0) / 1300, f = t - Math.floor(t);
    var tri = f < 0.5 ? f * 2 : 2 - f * 2;
    return 0.3 + 0.7 * tri;
  }

  // ---- confetti ----
  function confetti(n, color) {
    if (S.rm) return;
    var W = S.fxW, cols = S.T.p.concat([S.T.gold, S.T.acc]);
    for (var i = 0; i < n; i++) {
      S.conf.push({
        x: Math.random() * W, y: -10 - Math.random() * 60, vx: (Math.random() - 0.5) * 120, vy: 60 + Math.random() * 120,
        a: Math.random() * TAU, va: (Math.random() - 0.5) * 12, w: 4 + Math.random() * 5, h: 6 + Math.random() * 6,
        c: rgb(color != null && Math.random() < 0.5 ? S.T.p[color] : cols[Math.floor(Math.random() * cols.length)]), life: 3 + Math.random() * 1.5
      });
    }
    if (S.conf.length > 360) S.conf.splice(0, S.conf.length - 360);
    ensureLoop();
  }
  function stepFx(dt) {
    var x = S.fxCtx;
    if (!x) return;
    if (!S.conf.length) { if (S.fxDirty) { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, S.fx.width, S.fx.height); S.fxDirty = false; } return; }
    var dpr = S.fxDpr;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, S.fxW, S.fxH);
    S.conf = S.conf.filter(function (p) {
      p.vy += 160 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.va * dt; p.life -= dt;
      if (p.life <= 0 || p.y > S.fxH + 20) return false;
      x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.scale(1, Math.abs(Math.cos(p.a * 1.3)) + 0.2);
      x.fillStyle = p.c; x.globalAlpha = Math.min(1, p.life);
      x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      x.restore();
      return true;
    });
    S.fxDirty = true;
  }

  // ---- the loop ----
  function running() { return !!S && S.mode === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && S.panel.isConnected; }
  function ensureLoop() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(loop); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function loop(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected || !running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    S.now += dt * 1000;
    // the wheel: fixed 120 Hz steps
    if (S.spin.on) {
      S.acc += dt;
      var n = wheelList().length;
      while (S.acc >= 1 / 120) {
        S.acc -= 1 / 120;
        var tk = E.spinStep(S.spin, 1 / 120, n);
        if (tk) { S.flap = Math.max(-0.55, Math.min(0.55, S.flap - (S.spin.w >= 0 ? 0.32 : -0.32))); S.snd.tick(); }
        if (S.spin.w === 0) { S.acc = 0; spinDone(); break; }
      }
    }
    S.flap *= Math.pow(0.0008, dt);
    var g = S.g, r = g && g.r;
    // clocks: the turn timer and the final round's clock run only while play is live
    if (g && r && !S.busy && !S.card) {
      if (E.tickClock(g, dt)) { renderAct(); if (r.phase === 'final') advance(); }
      if (S.tm && S.tm.total && S.tm.left > 0) {
        var was = Math.ceil(S.tm.left);
        S.tm.left -= dt;
        if (Math.ceil(S.tm.left) !== was && S.tm.left <= 5 && S.tm.left > 0) S.snd.beep();
        if (S.tm.left <= 0) onTimeout();
      }
      if (S.now - S.tmPaint > 200) { S.tmPaint = S.now; paintTimer(); }
    }
    runJobs();
    if (!S) return;
    var wv = !S.wmodal || S.wst.classList.contains('show');
    if (wv && (S.spin.on || S.pow || S.now - S.wPaint > 110 || Math.abs(S.flap) > 0.01 || S.drag)) { S.wPaint = S.now; drawWheel(); }
    if (S.pow) { var pv = S.act.querySelector('.wh-pow i'); if (pv) pv.style.width = Math.round(powVal() * 100) + '%'; }
    stepFx(dt);
    S.raf = requestAnimationFrame(loop);
  }

  // ---- the flow ----
  function setTimerFor() {
    var g = S.g, r = g.r, p = E.cur(g), ph = r.phase, secs = 0;
    if (ph === 'tossSolve' || ph === 'bsolve') secs = 10;
    else if (ph === 'speedSolve' || (ph === 'solve' && r.from === 'speedSolve')) secs = 8;
    else if (p && !p.cpu && /^(turn|call|vowel|free|mystery|solve|speedCall|bpick)$/.test(ph)) secs = ph === 'bpick' ? 0 : S.set.timer;
    var key = [g.ri, r.turn, ph, r.used.length].join(':');
    if (S.tm && S.tm.key === key) return;
    S.tm = { key: key, left: secs, total: secs };
    paintTimer(true);
  }
  // decide what happens next; called whenever the state settles
  function advance() {
    if (!S || !S.g || S.mode !== 'play') return;
    var g = S.g, r = g.r;
    renderHud(); paintKb(); renderAct(); paintCat();
    if (S.busy || S.paused || S.card) return;
    if (!solving(r.phase)) { if (S.fill) { S.fill = null; paintTiles(); } }
    else if (!S.fill) beginFill();
    setTimerFor();
    if (r.phase !== 'toss') { cancelJobs('toss'); cancelJobs('cpubuzz'); }
    saveIfStable();
    var p = E.cur(g);
    cancelJobs('cpu');
    switch (r.phase) {
      case 'done': roundOver(); return;
      case 'bdone': return;
      case 'final':
        say('&#9200; <b>Time&rsquo;s up!</b> One final spin sets the speed-up value&hellip;', 'big');
        after(1300 * S.spf, function () { if (S && S.g === g && r.phase === 'final' && !S.busy) doSpin(E.cpuSpin(g)); }, 'cpu');
        return;
      case 'toss':
        if (!hasJob('toss')) after(tossMs(), tossStep, 'toss');
        return;
    }
    if (p && p.cpu) after(cpuDelay(r.phase), cpuAct, 'cpu');
    else if (p) humanPrompt();
  }
  function saveIfStable() {
    var ph = S.g.r.phase;
    if (/^(turn|toss|bspin|bpick|speedCall|speedSolve|final|call|vowel|free|mystery)$/.test(ph)) saveGame();
  }
  function cpuDelay(ph) {
    var base = ph === 'turn' ? 1100 : ph === 'bpick' ? 900 : ph === 'tossSolve' ? 500 : 800;
    return (base + Math.random() * 500) * S.spf;
  }
  function tossMs() { return 1100 * S.spf; }
  function humanPrompt() {
    var g = S.g, r = g.r, i = r.turn;
    switch (r.phase) {
      case 'turn':
        if (!E.consLeft(r) && !E.canBuy(g)) say(nm(i) + ', no consonants left &mdash; time to <b>solve</b>!');
        else say(nm(i) + ', <b>spin</b>, buy a vowel or solve.');
        break;
      case 'bspin': say(nm(i) + ', spin the bonus wheel to pick a sealed envelope.'); break;
      case 'bpick': say('Given: <b>R S T L N E</b>. Pick ' + r.need.c + ' consonants and 1 vowel.'); break;
      case 'bsolve': say('<b>10 seconds!</b> Fill in the blanks.', 'big'); break;
      case 'tossSolve': say(nm(i) + ' buzzed in &mdash; solve it!'); break;
      case 'speedCall': say(nm(i) + ', call a letter.'); break;
      case 'speedSolve': say(nm(i) + ', solve it or pass.'); break;
      case 'solve': say(nm(i) + ', fill in the blanks.'); break;
    }
    S.lastHuman = i;
  }
  function beginFill() {
    var r = S.g.r;
    S.slots = E.hiddenIdx(r).sort(function (a, b) { return a - b; });
    S.fill = {}; S.cur = 0;
    paintTiles();
  }
  function onTimeout() {
    var g = S.g, r = g.r;
    S.tm.left = 0; S.tm.total = 0;
    var who = r.turn, ph = r.phase;
    var res = E.timeout(g);
    if (res.ev === 'none') return;
    S.snd.buzz();
    S.fill = null;
    if (ph === 'bsolve' || ph === 'bpick') { bonusEnd(res); return; }
    if (res.ev === 'wrong-end' || r.phase === 'done') {
      say('&#9201; Time&rsquo;s up &mdash; nobody solved the toss-up.');
      revealSeq(res.idx || [], { fast: true, quiet: true }, function () { after(900, advance); });
      return;
    }
    say('&#9201; Time&rsquo;s up' + (who >= 0 ? ', ' + nm(who) : '') + '!', 'bad');
    paintTiles();
    after(1000 * S.spf, advance);
    renderAct(); paintKb(); renderHud();
  }

  // a human input: buttons, keys, the keyboard
  function input(kind, v) {
    if (!S || !S.g || S.mode !== 'play' || S.paused || S.card) return;
    var g = S.g, r = g.r, p = E.cur(g), ph = r.phase;
    S.snd.ensure();
    if (kind === 'buzz') { doBuzz(v); return; }
    if (kind === 'next') { if (ph === 'done') roundOver(true); else if (ph === 'bdone') showCard('over'); return; }
    if (S.busy || !p || p.cpu) return;
    if (ph === 'turn') {
      if (kind === 'vowel' && E.buyVowel(g)) { say(nm(r.turn) + ' buys a vowel (' + money(VOWEL_COST) + ').'); advance(); }
      else if (kind === 'solve' && E.startSolve(g)) advance();
      return;
    }
    if (ph === 'vowel' && kind === 'cancel') { E.cancelVowel(g); advance(); return; }
    if ((ph === 'free' || ph === 'speedSolve') && kind === 'solve') { if (E.startSolve(g)) advance(); return; }
    if (ph === 'speedSolve' && kind === 'pass') { var w0 = r.turn; E.passSpeed(g); say(nm(w0) + ' passes.'); advance(); return; }
    if (ph === 'mystery' && (kind === 'flip' || kind === 'keep')) { doMystery(kind === 'flip'); return; }
    if (/^(call|vowel|free|speedCall)$/.test(ph) && kind === 'letter') { doCall(v); return; }
    if (solving(ph)) {
      if (kind === 'letter') typeFill(v);
      else if (kind === 'back') backFill();
      else if (kind === 'enter') submitSolve();
      else if (kind === 'cancel' && ph === 'solve' && E.cancelSolve(g)) { S.fill = null; paintTiles(); advance(); }
      else if (kind === 'slot') { var k = S.slots.indexOf(v); if (k >= 0) { S.cur = k; paintTiles(); } }
      return;
    }
    if (ph === 'bpick') {
      if (kind === 'letter') {
        var res = E.bonusPick(g, v);
        if (!res.ok) { S.snd.buzz(); say(res.ev === 'full-v' ? 'Just one vowel!' : res.ev === 'full-c' ? 'That&rsquo;s all your consonants.' : 'R S T L N E are already given.', 'bad'); return; }
        S.snd.beep(); pressKey(v); paintKb(); renderAct();
      } else if (kind === 'back') { if (E.bonusUnpick(g)) { paintKb(); renderAct(); } }
      else if (kind === 'enter') bonusGo();
    }
  }
  function typeFill(L) {
    if (!S.fill || S.cur >= S.slots.length) { S.snd.beep(); return; }
    S.fill[S.slots[S.cur]] = L; S.cur++;
    S.snd.tone(1200, 0.03, 'square', 0.015);
    paintTiles();
  }
  function backFill() {
    if (!S.fill) return;
    if (S.cur > 0 && !S.fill[S.slots[S.cur]]) S.cur--;
    delete S.fill[S.slots[S.cur]];
    paintTiles();
  }
  function guessText() {
    var r = S.g.r, ch = r.text.split('');
    for (var i = 0; i < ch.length; i++) if (!r.rev[i] && isL(ch[i])) ch[i] = (S.fill && S.fill[i]) || '_';
    return ch.join('');
  }
  function submitSolve(guess) {
    var g = S.g, r = g.r, ph = r.phase, who = r.turn;
    var res = E.trySolve(g, guess != null ? guess : guessText());
    S.fill = null;
    if (res.ok) {
      if (res.ev === 'bonus-win') { bonusEnd(res); return; }
      onSolved(res);
      return;
    }
    S.snd.buzz(); boardFx('shk', 500);
    if (ph === 'bsolve') { beginFill(); say('Not quite &mdash; keep trying!', 'bad'); return; }
    if (res.ev === 'wrong-end') {
      say('Nobody solved the toss-up. It was&hellip;');
      revealSeq(res.idx, { fast: true, quiet: true }, function () { after(1000, advance); });
      return;
    }
    if (ph === 'tossSolve') say(nm(who) + ' is wrong &mdash; locked out of this toss-up.', 'bad');
    else if (res.keep) say('Not it &mdash; but on a FREE PLAY ' + nm(who) + ' keeps the turn.', 'bad');
    else say('Sorry, ' + nm(who) + ', that&rsquo;s not it.', 'bad');
    paintTiles();
    renderHud(); paintKb(); renderAct();
    after(1100 * S.spf, advance);
  }
  function onSolved(res) {
    var g = S.g, r = g.r, i = res.who;
    S.busy++;
    paintTiles();
    revealSeq(res.idx, { fast: true, quiet: true }, function () {
      S.busy = Math.max(0, S.busy - 1);
      S.snd.fanfare();
      boardFx('party', 2600);
      confetti(140, g.players[i].color);
      say(nm(i) + ' solves it! ' + (r.t === 'toss' ? '+' + money(res.amount) : 'Banks ' + money(res.amount) + (res.prizes && res.prizes.length ? ' + ' + res.prizes.map(function (z) { return esc(z.n); }).join(', ') : '')), 'win');
      renderHud(); paintKb(); renderAct();
      saveGame();
      after(1700 * S.spf, function () { if (S && S.g === g && r.phase === 'done') roundOver(); });
    });
  }
  function doCall(L) {
    var g = S.g, r = g.r, i = r.turn, ph = r.phase, p = g.players[i];
    var res = E.callLetter(g, L);
    if (!res.ok) return;
    pressKey(L); paintKb();
    if (res.ev === 'used') {
      S.snd.buzz();
      say(nm(i) + ' calls <b>' + L + '</b> &mdash; already called!' + (res.keep ? ' (free play: no harm done)' : ''), 'bad');
      renderHud(); renderAct();
      after(1100 * S.spf, advance);
      return;
    }
    if (!res.n) {
      S.snd.buzz();
      say(nm(i) + ' calls <b>' + L + '</b>&hellip; no ' + L + '.' + (res.keep ? ' Free play &mdash; keep going!' : ''), 'bad');
      renderHud(); renderAct();
      after(1000 * S.spf, advance);
      return;
    }
    var line = nm(i) + ': <b>' + L + '</b> &mdash; ' + (res.n === 1 ? 'there is one ' + L : 'there are ' + res.n + ' ' + L + '&rsquo;s') +
      (res.earn ? '! <b class="cash">+' + money(res.earn) + '</b>' : '!');
    say(line, 'good');
    renderHud(); renderAct();
    revealSeq(res.idx, {}, function () {
      if (res.earn) S.snd.cash();
      var extra = [];
      if (res.wild) extra.push(nm(i) + ' picks up the <b>WILD</b> card &mdash; an extra consonant in the bonus round!');
      if (res.prize) extra.push(nm(i) + ' holds the <b>' + esc(res.prize.n) + '</b> (' + money(res.prize.v) + ') &mdash; solve to keep it!');
      if (res.mys) extra.push('<b>MYSTERY</b> wedge: flip it for $10,000&hellip; or BANKRUPT?');
      if (extra.length) say(extra.join(' '), 'good');
      advance();
    });
  }
  function doMystery(flip) {
    var g = S.g, r = g.r, i = r.turn;
    var res = E.mystery(g, flip);
    if (!res.ok) return;
    if (!flip) { say(nm(i) + ' keeps it safe.'); advance(); return; }
    S.busy++;
    say(nm(i) + ' flips the mystery wedge&hellip;', 'big');
    S.snd.whoosh();
    renderAct();
    after(1300 * S.spf, function () {
      S.busy = Math.max(0, S.busy - 1);
      if (res.ev === 'mys-win') { S.snd.fanfare(); confetti(60, g.players[i].color); say('&#127881; <b>$10,000!</b> ' + nm(i) + ' wins the mystery prize!', 'win'); }
      else { S.snd.bank(); boardFx('bkf', 900); say('&#128165; <b>BANKRUPT!</b> ' + nm(i) + ' loses ' + money(res.lost) + '.', 'bad'); }
      renderHud();
      after(1300 * S.spf, advance);
    });
  }
  function doBuzz(pi) {
    var g = S.g, r = g.r;
    if (r.phase !== 'toss' || !g.players[pi]) return;
    if (!E.buzz(g, pi)) return;
    cancelJobs('toss'); cancelJobs('cpubuzz');
    S.snd.buzzer();
    boardFx('party', 700);
    advance();
    say(nm(pi) + ' buzzes in!', 'big');
  }
  function tossStep() {
    var g = S.g, r = g.r;
    if (!S || r.phase !== 'toss') return;
    var i = E.tossReveal(g);
    if (i < 0) {
      say('Last chance to buzz&hellip;');
      after(3500 * S.spf, function () {
        if (!S || S.g !== g || r.phase !== 'toss') return;
        var res = E.tossEnd(g);
        say('Nobody buzzed in. It was&hellip;');
        revealSeq(res.idx, { fast: true, quiet: true }, function () { after(900, advance); });
      }, 'toss');
      return;
    }
    S.shown[i] = true; paintTile(i, true); S.snd.flip();
    // CPU buzz-ins: each CPU that can read it reacts after a moment
    if (!hasJob('cpubuzz')) {
      var best = -1, bestT = 1e9;
      g.players.forEach(function (p, pi) {
        if (!p.cpu || r.locked.indexOf(pi) >= 0) return;
        if (E.cpuKnows(g, pi, DICT, 0.02)) {
          var t = (500 + Math.random() * 900) * (1.25 - p.cpu * 0.12);
          if (t < bestT) { bestT = t; best = pi; }
        }
      });
      if (best >= 0) after(bestT * S.spf, function () { if (S && S.g === g && r.phase === 'toss') doBuzz(best); }, 'cpubuzz');
    }
    after(tossMs(), tossStep, 'toss');
  }
  // ---- spins ----
  function canHumanSpin() {
    var g = S.g, r = g && g.r, p = g && E.cur(g);
    return !!r && !S.busy && !S.card && !S.paused && S.mode === 'play' && !!p && !p.cpu && ((r.phase === 'turn' && E.canSpin(g)) || r.phase === 'bspin');
  }
  function doSpin(w) {
    var g = S.g, r = g.r;
    if (!E.startSpin(g)) return;
    w = clamp(w, -SPIN_MAX, SPIN_MAX);
    if (Math.abs(w) < SPIN_MIN) w = w < 0 ? -SPIN_MIN : SPIN_MIN;
    S.busy++;
    S.spin.on = true; S.spin.w = w; S.acc = 0; S.hiW = -1; S.hubTxt = '';
    if (S.wmodal) S.wst.classList.add('show');
    S.snd.whoosh();
    renderAct(); paintKb();
    ensureLoop();
  }
  function spinDone() {
    var g = S.g, r = g.r, n = wheelList().length, wi = E.wedgeAt(S.spin.a, n), i = r.turn, from = r.from;
    S.spin.on = false;
    S.busy = Math.max(0, S.busy - 1);
    S.hiW = wi; S.hiT = S.now;
    var res = E.spinLand(g, wi), w = r.wheel[wi], lk = wedgeLook(w, r.t === 'bonus' ? null : r);
    S.hubTxt = r.t === 'bonus' ? '\u2709' : lk.lab.length <= 6 ? lk.lab : (w.k === 'bk' ? 'BUST' : w.k === 'lose' ? 'LOSE' : w.k === 'free' ? 'FREE' : lk.lab.slice(0, 5));
    drawWheel();
    var hide = function () { if (S && S.wmodal) S.wst.classList.remove('show'); };
    var d = 1;
    switch (res.ev) {
      case 'bk':
        S.snd.bank(); boardFx('bkf', 900);
        say('&#128165; <b>BANKRUPT!</b> ' + nm(i) + (res.lost ? ' loses ' + money(res.lost) + '.' : '.'), 'bad'); d = 1.6; break;
      case 'lose': S.snd.buzz(); say(nm(i) + ' lands on <b>LOSE A TURN</b>.', 'bad'); d = 1.4; break;
      case 'free': S.snd.cash(); say('<b>FREE PLAY!</b> Any letter: consonants ' + money(500) + ', vowels free, no penalty for a miss.', 'good'); break;
      case 'env': S.snd.cash(); say(nm(i) + ' lands on a sealed envelope &mdash; it stays closed until the end.'); d = 1.4; break;
      case 'speed':
        S.snd.fanfare();
        say('&#9889; <b>SPEED-UP!</b> Consonants are worth ' + money(res.v) + ', vowels are free. One letter and one guess each!', 'big'); d = 2; break;
      case 'wild': S.snd.cash(); say(nm(i) + ' lands on <b>WILD</b> (' + money(res.v) + ') &mdash; hit a consonant to take the card!'); break;
      case 'mys': S.snd.cash(); say(nm(i) + ' lands on <b>MYSTERY</b> &mdash; ' + money(res.v) + ' a letter, and a chance to flip it.'); break;
      case 'prize': S.snd.cash(); say(nm(i) + ' lands on <b>PRIZE</b>: ' + esc(r.prize ? r.prize.n : '') + ' &mdash; hit a consonant to grab it!'); break;
      default: S.snd.cash(); say(nm(i) + ' lands on <b>' + money(res.v) + '</b>' + (w.top ? ' &#11088;' : '') + ' &mdash; call a consonant!');
    }
    renderHud();
    after(900 * d * S.spf, function () { hide(); advance(); });
    renderAct();
    void from;
  }
  // ---- the CPU ----
  function cpuAct() {
    if (!S || !S.g || S.busy || S.card) return;
    var g = S.g, r = g.r, pi = r.turn, p = g.players[pi];
    if (!p || !p.cpu) return;
    switch (r.phase) {
      case 'turn': {
        var c = E.cpuTurn(g, pi, DICT);
        if (c === 'spin') { say(nm(pi) + ' spins&hellip;'); after(350 * S.spf, function () { if (S && r.phase === 'turn') doSpin(E.cpuSpin(g)); }, 'cpu'); }
        else if (c === 'vowel') { E.buyVowel(g); say(nm(pi) + ' buys a vowel.'); renderHud(); renderAct(); after(800 * S.spf, function () { cpuCall(VOWELS); }, 'cpu'); }
        else { E.startSolve(g); say(nm(pi) + ' would like to solve&hellip;', 'big'); cpuType(c === 'solve'); }
        return;
      }
      case 'call': cpuCall(CONS); return;
      case 'vowel': cpuCall(VOWELS); return;
      case 'free':
        if (E.cpuKnows(g, pi, DICT)) { E.startSolve(g); say(nm(pi) + ' uses the free play to solve&hellip;', 'big'); cpuType(true); }
        else cpuCall(E.consLeft(r) ? CONS : VOWELS);
        return;
      case 'mystery': doMystery(E.cpuFlip(g, pi)); return;
      case 'speedCall': cpuCall(E.consLeft(r) ? CONS : VOWELS); return;
      case 'speedSolve':
        if (E.cpuKnows(g, pi, DICT, 0.06)) { E.startSolve(g); say(nm(pi) + ' tries to solve&hellip;', 'big'); cpuType(true); }
        else { E.passSpeed(g); say(nm(pi) + ' passes.'); advance(); }
        return;
      case 'tossSolve': cpuType(true); return;
      case 'bspin': say(nm(pi) + ' spins the bonus wheel&hellip;'); doSpin(E.cpuSpin(g)); return;
      case 'bpick': {
        var picks = E.cpuBonusPicks(g, pi, DICT);
        say(nm(pi) + ' picks&hellip;');
        S.busy++;
        picks.split('').forEach(function (L, k) {
          after((k + 1) * 550 * S.spf, function () { E.bonusPick(g, L); pressKey(L); S.snd.beep(); paintKb(); renderAct(); });
        });
        after((picks.length + 1) * 550 * S.spf + 200, function () { S.busy = Math.max(0, S.busy - 1); bonusGo(); });
        return;
      }
      case 'bsolve':
        if (E.cpuKnows(g, pi, DICT, 0.12)) after((1500 + Math.random() * 4500) * S.spf, function () { if (S && r.phase === 'bsolve') cpuType(true); }, 'cpu');
        return;
    }
  }
  function cpuCall(set) {
    var g = S.g, r = g.r, L = E.cpuLetter(g, r.turn, DICT, set);
    if (!L) { var ph = r.phase; if (ph === 'vowel') E.cancelVowel(g); advance(); return; }
    var b = S.keys[L];
    if (b) b.classList.add('aim');
    after(450 * S.spf, function () { if (b) b.classList.remove('aim'); if (S && S.g === g) doCall(L); }, 'cpu');
  }
  // the CPU types its answer into the blanks, then submits
  function cpuType(knows) {
    var g = S.g, r = g.r, pi = r.turn, guess = E.cpuGuess(g, pi, DICT, knows);
    if (!S.fill) beginFill();
    S.busy++;
    renderAct(); paintKb();
    var slots = S.slots.slice(), step = Math.max(60, Math.min(170, 2400 / Math.max(1, slots.length))) * S.spf;
    slots.forEach(function (idx, k) {
      after(300 + k * step, function () { if (S && S.fill) { S.fill[idx] = guess.charAt(idx); S.cur = k + 1; paintTiles(); S.snd.tone(1200, 0.03, 'square', 0.012); } });
    });
    after(300 + slots.length * step + 450 * S.spf, function () {
      if (!S || S.g !== g) return;
      S.busy = Math.max(0, S.busy - 1);
      if (!solving(r.phase)) { advance(); return; }
      submitSolve(guess);
    });
  }
  // ---- bonus ----
  function bonusGo() {
    var g = S.g, r = g.r;
    var idx = E.bonusReveal(g);
    if (!idx) return;
    say('Revealing <b>' + r.picks.split('').join(' ') + '</b>&hellip;');
    revealSeq(idx, {}, function () { say('<b>10 seconds!</b> Solve it!', 'big'); advance(); });
  }
  function bonusEnd(res) {
    var g = S.g, r = g.r, p = E.cur(g), w = r.wheel[r.env] || { v: 0 };
    S.busy++;
    S.tm = null;
    paintTiles();
    revealSeq(res.idx || [], { fast: true, quiet: true }, function () {
      S.busy = Math.max(0, S.busy - 1);
      if (r.won) { S.snd.fanfare(); boardFx('party', 3000); confetti(220, p.color); say(nm(r.turn) + ' solves the bonus puzzle!', 'win'); }
      else { S.snd.buzz(); say('Out of time! The answer is on the board.', 'bad'); }
      finishGame();
      renderHud(); renderAct(); paintKb();
      after(1800 * S.spf, function () { if (S && S.g === g) showCard('envelope'); });
      void w;
    });
  }
  function finishGame() {
    var g = S.g;
    if (S.recorded === g) return;
    S.recorded = g;
    var d = new Date(), ds = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    S.stats = E.recordGame(S.stats, g, ds);
    persistStats();
    sdel(GAME_KEY);
  }
  // ---- rounds ----
  function roundOver(go) {
    var g = S.g;
    if (!go) { showCard('result'); return; }
    hideCard();
    nextStage();
  }
  function nextStage() {
    var g = S.g;
    var kind = E.nextKind(g);
    if (!kind) { showCard('over'); return; }
    var last = g.r ? g.r.cat : '';
    var puz = E.pickPuzzle(BANK, S.recent, Math.random, kind, last);
    S.recent = E.noteRecent(S.recent, puz.id, Math.min(400, Math.floor(BANK.length * 0.6)));
    sset(RECENT_KEY, JSON.stringify(S.recent));
    E.startRound(g, puz);
    S.tm = null; S.hiW = -1; S.hubTxt = ''; S.faceKey = '';
    newBoard();
    S.spin.a = Math.random() * TAU;
    drawWheel();
    say('');
    renderHud(); paintKb(); renderAct(); paintCat();
    saveGame();
    showCard('intro');
    after(2300 * S.spf, function () { if (S && S.card === 'intro' && S.g === g) introDone(); }, 'intro');
  }
  function introDone() {
    var g = S.g, r = g.r;
    cancelJobs('intro');
    hideCard();
    S.snd.whoosh();
    boardFx('party', 900);
    if (r.t === 'bonus') {
      var giv = [];
      for (var gi = 0; gi < r.text.length; gi++) if (isL(r.text.charAt(gi)) && r.rev[gi]) giv.push(gi);
      say('Here come <b>R S T L N E</b>&hellip;');
      revealSeq(giv, {}, function () { advance(); });
      return;
    }
    if (r.t === 'toss') say('<b>TOSS-UP</b> for ' + money(r.val) + ' &mdash; buzz in as soon as you know it!', 'big');
    else if (r.final) say('<b>Final round!</b> When the clock runs out it becomes a speed-up round.', 'big');
    else say('Round ' + (r.m + 1) + ': ' + nm(r.turn) + ' starts.');
    after(400, advance);
  }
  // ---- start / resume / quit ----
  function startGame(resume) {
    var g;
    if (resume) g = resume;
    else {
      var players = S.setup.seats.map(function (s) { return { name: s.name, color: s.color, cpu: S.setup.mode === 'party' ? 0 : s.cpu }; });
      g = E.newGame({ players: players, rounds: S.set.rounds, clock: S.set.clock, seed: (Date.now() ^ (Math.random() * 1e9)) >>> 0 });
    }
    S.g = g; S.mode = 'play'; S.jobs = []; S.busy = 0; S.recorded = null; S.tm = null; S.conf = [];
    S.spin.on = false; S.spin.w = 0;
    hideCard();
    ensureLoop();
    if (resume && g.r) {
      newBoard();
      for (var i = 0; i < g.r.text.length; i++) S.shown[i] = g.r.rev[i];
      paintTiles();
      S.faceKey = '';
      drawWheel();
      say('Welcome back! ' + (g.r.turn >= 0 ? nm(g.r.turn) + '&rsquo;s turn.' : ''));
      advance();
    } else nextStage();
    syncHead();
  }
  function toMenu() {
    S.mode = 'menu'; S.jobs = []; S.busy = 0; S.spin.on = false; S.pow = null; S.drag = null;
    stopLoop();
    S.resume = E.normGame(sjson(GAME_KEY));
    showCard('menu');
    syncHead();
  }
  function pause() {
    if (!S || S.paused || S.mode !== 'play') return;
    S.paused = true; S.pow = null;
    stopLoop();
    saveIfStable();
    showCard('pause');
    syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    hideCard();
    if (S.cardUnder) { var c = S.cardUnder; S.cardUnder = null; showCard(c); }
    ensureLoop();
    syncHead();
    if (!S.card) advance();
  }

  // ---- overlay cards ----
  function hideCard() {
    if (!S) return;
    S.card = null;
    S.ovl.style.display = 'none';
    S.ovl.innerHTML = '';
    S.root.classList.remove('dim');
  }
  function chip(act, val, label, on, extra) {
    return '<button type="button" class="wh-chip' + (on ? ' on' : '') + '" data-act="' + act + '" data-v="' + esc(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (extra || '') + '>' + label + '</button>';
  }
  function go(act, label, cls) { return '<button type="button" class="wh-go' + (cls ? ' ' + cls : '') + '" data-act="' + act + '">' + label + '</button>'; }
  function sec(h, body) { return '<div class="wh-sec"><div class="wh-h">' + h + '</div>' + body + '</div>'; }
  function standingsTable(g, withBonus) {
    return '<table class="wh-tab">' + E.standings(g).map(function (i, k) {
      var p = g.players[i];
      return '<tr class="' + (k === 0 ? 'top' : '') + '"><td>' + (k + 1) + '.</td><td><b class="wc' + p.color + '">' + (p.cpu ? '&#129302; ' : '') + esc(p.name) + '</b>' +
        (p.wild ? ' <em>W</em>' : '') + '</td><td>' + money(withBonus ? E.finalTotal(p) : p.total) + '</td></tr>';
    }).join('') + '</table>';
  }
  function showCard(name) {
    if (!S) return;
    if (S.paused && name !== 'pause' && name !== 'help') { S.cardUnder = name; return; }
    if (name === 'pause' && S.card && S.card !== 'pause' && S.card !== 'help') S.cardUnder = S.card;
    S.card = name;
    var h = '', g = S.g, r = g && g.r;
    if (name === 'menu') h = menuCard();
    else if (name === 'help') h = helpCard();
    else if (name === 'pause') {
      h = '<div class="wh-card"><div class="wh-title">PAUSED</div>' + (g ? standingsTable(g, false) : '') +
        '<div class="wh-btns">' + go('resume', 'Resume &#9656;') + '</div><div class="wh-btns">' + go('help', 'How to play', 'alt') + go('quit', S.quitArm ? 'Really quit?' : 'Quit to menu', 'alt' + (S.quitArm ? ' danger' : '')) + '</div>' +
        '<p class="wh-note">The game is saved &mdash; quit and resume any time.</p></div>';
    } else if (name === 'intro') {
      var lab = r.t === 'toss' ? 'TOSS-UP' : r.t === 'bonus' ? 'BONUS ROUND' : r.final ? 'FINAL ROUND' : 'ROUND ' + (r.m + 1);
      var sub = r.t === 'toss' ? 'Worth ' + money(r.val) + ' &middot; the board fills itself in &mdash; buzz when you know it' :
        r.t === 'bonus' ? nm(r.turn) + ' plays for a sealed envelope!' :
          'Top wedge ' + money(r.wheel[0].v) + (r.final ? ' &middot; ' + g.clock + 's on the clock' : '') + ' &middot; ' + nm(r.turn) + ' starts';
      h = '<div class="wh-card intro" data-act="intro-go"><div class="wh-lights2"></div><div class="wh-big">' + lab + '</div><div class="wh-sub">Category</div><div class="wh-catbig">' + esc(r.cat) + '</div>' +
        '<p class="wh-sub">' + sub + '</p>' + go('intro-go', 'Let&rsquo;s go! &#9656;') + '</div>';
    } else if (name === 'result') {
      var who = r.winner;
      h = '<div class="wh-card"><div class="wh-title">' + (r.t === 'toss' ? 'TOSS-UP' : 'ROUND ' + (r.m + 1)) + '</div>' +
        (who >= 0 ? '<div class="wh-big">' + nm(who) + '</div><p class="wh-sub">banks <b>' + money(r.bank) + '</b></p>' : '<div class="wh-big">No winner</div>') +
        '<p class="wh-ans">' + esc(r.text) + '</p>' + standingsTable(g, false) +
        '<div class="wh-btns">' + go('next', (E.nextKind(g) === 'bonus' ? 'To the bonus round' : 'Next') + ' &#9656;') + '</div></div>';
    } else if (name === 'envelope') {
      var p = E.cur(g), w = r.wheel[r.env] || { v: 0 };
      h = '<div class="wh-card"><div class="wh-title">THE ENVELOPE</div><pre class="wh-art">' + ' _______________\n|\\             /|\n| \\___________/ |\n|_______________|' + '</pre>' +
        '<div class="wh-big">' + esc(E.envLabel(w)) + '</div><p class="wh-sub">' + (r.won ? nm(r.turn) + ' wins it!' : 'So close &mdash; that was the prize.') + '</p>' +
        '<div class="wh-btns">' + go('over', 'Final scores &#9656;') + '</div></div>';
      if (r.won) S.snd.fanfare();
      void p;
    } else if (name === 'over') h = overCard();
    S.ovl.innerHTML = h;
    S.ovl.style.display = '';
    S.root.classList.toggle('dim', name !== 'intro');
    var f = S.ovl.querySelector('.wh-go');
    if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    S.ovl.scrollTop = 0;
  }
  function overCard() {
    var g = S.g, win = E.standings(g)[0], wp = g.players[win], st = S.stats;
    return '<div class="wh-card"><div class="wh-title">GAME OVER</div><div class="wh-big">' + nm(win) + ' wins!</div><p class="wh-sub">' + money(E.finalTotal(wp)) +
      (wp.bonus ? ' including the bonus' : '') + '</p>' + standingsTable(g, true) +
      '<p class="wh-note">Season: ' + plural(st.games, 'game') + ' &middot; ' + st.wins + ' won &middot; best ' + money(st.bestBank) + ' &middot; bonus ' + st.bonusWins + '/' + st.bonusPlays + '</p>' +
      '<div class="wh-btns">' + go('menu', 'Menu', 'alt') + go('again', 'Play again &#9656;') + '</div></div>';
  }
  function helpCard() {
    var k = S.coarse;
    return '<div class="wh-card"><div class="wh-title">HOW TO PLAY</div><pre class="wh-art">' + ART + '</pre>' +
      '<p><b>Main rounds:</b> spin, then call a consonant &mdash; each one on the board pays the wedge value. Buy vowels for ' + money(VOWEL_COST) + '. Solve to bank your round money (at least $1,000). A miss, a repeat letter, BANKRUPT or LOSE A TURN passes play.</p>' +
      '<p><b>Wedges:</b> FREE PLAY (any letter, no penalty) &middot; WILD (keep it for an extra bonus-round consonant) &middot; MYSTERY (flip for $10,000&hellip; or BANKRUPT) &middot; PRIZE (keep it if you solve).</p>' +
      '<p><b>Toss-ups:</b> letters appear by themselves &mdash; buzz first and type the answer. Wrong? You&rsquo;re locked out.</p>' +
      '<p><b>Final round:</b> on a clock; when it hits zero the last spin sets a speed-up value &mdash; vowels are free and everyone gets one letter and one guess.</p>' +
      '<p><b>Bonus:</b> the leader gets R S T L N E, picks 3 consonants + 1 vowel and has 10 seconds.</p>' +
      '<div class="wh-keys">' + (k ? '<span><b>Flick</b> the wheel or <b>hold SPIN</b> and let go</span><span>Tap letters on the keyboard; tap a blank to jump to it</span>' :
        '<span><b>Space</b> hold &amp; release to spin &middot; or drag the wheel</span><span><b>V</b> buy a vowel &middot; <b>Enter</b> solve / submit</span><span><b>A-Z</b> call / type &middot; <b>Backspace</b> erase</span><span><b>1-4</b> buzz in on a toss-up &middot; <b>Y / N</b> mystery</span><span><b>Esc</b> pause</span>') + '</div>' +
      go('help-close', 'Got it') + '</div>';
  }
  function menuCard() {
    var su = S.setup, st = S.stats, set = S.set, tab = S.tab || 'play', party = su.mode === 'party';
    var h = '<div class="wh-card menu"><pre class="wh-art">' + ART + '</pre>';
    h += '<div class="wh-tabs">' + ['play', 'settings', 'stats'].map(function (t) { return '<button type="button" class="' + (tab === t ? 'on' : '') + '" data-act="tab" data-v="' + t + '">' + t.toUpperCase() + '</button>'; }).join('') + '</div>';
    if (tab === 'play') {
      if (S.resume) {
        var rg = S.resume, rr = rg.r;
        h += '<button type="button" class="wh-resume" data-act="resume-game"><b>&#9656; RESUME GAME</b><span>' + rg.players.map(function (p) { return esc(p.name) + ' ' + money(p.total); }).join(' &middot; ') +
          ' &mdash; ' + (rr.t === 'toss' ? 'toss-up' : rr.t === 'bonus' ? 'bonus round' : 'round ' + (rr.m + 1)) + '</span></button>';
      }
      h += sec('Mode', '<div class="wh-chips">' + chip('mode', 'solo', 'Solo vs CPU', !party) + chip('mode', 'party', 'Party (all human)', party) + '</div>');
      h += sec('Players <i>tap a name for a new one &middot; &#9998; to type</i>', '<div class="wh-seats">' + su.seats.map(function (s, i) {
        var editing = S.editSeat === i;
        return '<div class="wh-seat">' +
          '<button type="button" class="wh-sw wc' + s.color + '" data-act="color" data-v="' + i + '" aria-label="Change color">&#9679;</button>' +
          (editing ? '<input class="wh-in" type="text" maxlength="12" data-seat="' + i + '" value="' + esc(s.name) + '" aria-label="Player name" autocomplete="off" autocapitalize="words" enterkeyhint="done">' :
            '<button type="button" class="wh-nm wc' + s.color + '" data-act="name" data-v="' + i + '">' + esc(s.name) + '</button>') +
          '<button type="button" class="wh-ed" data-act="edit" data-v="' + i + '" aria-label="Type a name">&#9998;</button>' +
          (party ? '<span class="wh-kind">human</span>' : '<button type="button" class="wh-kind' + (s.cpu ? ' cpu' : '') + '" data-act="kind" data-v="' + i + '">' + (s.cpu ? '&#129302; ' + DIFFS[s.cpu] : '&#128100; Human') + '</button>') +
          '</div>';
      }).join('') + '<div class="wh-chips">' + (su.seats.length < 4 ? chip('add', 1, '+ add player', false) : '') + (su.seats.length > 1 ? chip('del', 1, '&minus; remove', false) : '') + '</div></div>');
      h += sec('Main rounds', '<div class="wh-chips">' + [1, 2, 3, 4, 5].map(function (n) { return chip('rounds', n, String(n), set.rounds === n); }).join('') + '</div>');
      h += go('play', 'LET&rsquo;S PLAY! &#9656;', 'big');
    } else if (tab === 'settings') {
      h += sec('CPU difficulty <i>for every CPU seat</i>', '<div class="wh-chips">' + [1, 2, 3, 4].map(function (d) { return chip('diff', d, DIFFS[d], set.diff === d); }).join('') + '</div>');
      h += sec('Turn timer', '<div class="wh-chips">' + [0, 10, 15, 20, 30].map(function (t) { return chip('timer', t, t ? t + 's' : 'Off', set.timer === t); }).join('') + '</div>');
      h += sec('Final round clock', '<div class="wh-chips">' + [30, 45, 60, 90].map(function (t) { return chip('clock', t, t + 's', set.clock === t); }).join('') + '</div>');
      h += sec('Reveal speed', '<div class="wh-chips">' + ['slow', 'normal', 'fast'].map(function (t) { return chip('anim', t, t, set.anim === t); }).join('') + '</div>');
      h += sec('Sound', '<div class="wh-chips">' + chip('sound', 1, 'On', S.snd.on) + chip('sound', 0, 'Off', !S.snd.on) + '</div>');
      h += '<p class="wh-note">' + BANK.length + ' puzzles in the bank &middot; ' + S.recent.length + ' recently played are skipped</p>';
    } else {
      h += '<div class="wh-stats">' +
        [['Games', st.games], ['Wins', st.wins], ['Best game', money(st.bestBank)], ['Best round', money(st.bestRound)], ['Bonus', st.bonusWins + ' / ' + st.bonusPlays], ['Solves', st.solves], ['Lifetime', money(st.earned)]]
          .map(function (x) { return '<div><i>' + x[0] + '</i><b>' + x[1] + '</b></div>'; }).join('') + '</div>';
      h += sec('Leaderboard', st.board.length ? '<table class="wh-tab">' + st.board.map(function (e, i) {
        return '<tr' + (i === 0 ? ' class="top"' : '') + '><td>' + (i + 1) + '.</td><td>' + esc(e.n) + (e.b ? ' &#9993;' : '') + '</td><td>' + money(e.v) + '</td><td class="d">' + esc(e.d || '') + '</td></tr>';
      }).join('') + '</table>' : '<p class="wh-note">Play a game to get on the board.</p>');
      h += S.resetArm ? '<div class="wh-btns">' + go('reset-no', 'Keep', 'alt') + go('reset-yes', 'Erase stats', 'alt danger') + '</div>' : '<button type="button" class="wh-lnk" data-act="reset">reset season stats</button>';
    }
    return h + '</div>';
  }
  function cardAction(a, v, b) {
    var su = S.setup, set = S.set, re = true;
    switch (a) {
      case 'tab': S.tab = v; S.resetArm = false; S.editSeat = -1; break;
      case 'mode':
        su.mode = v;
        if (v === 'party') { su.seats.forEach(function (s) { s.cpu = 0; }); if (su.seats.length < 2) su.seats.push(newSeat(0)); }
        else su.seats.forEach(function (s, i) { s.cpu = i === 0 ? 0 : (s.cpu || set.diff); });
        break;
      case 'name': {
        var s = su.seats[+v], used = su.seats.map(function (x) { return x.name; }), pool = FUN.filter(function (n) { return used.indexOf(n) < 0; });
        s.name = pool[Math.floor(Math.random() * pool.length)] || s.name;
        S.editSeat = -1;
        break;
      }
      case 'edit': S.editSeat = S.editSeat === +v ? -1 : +v; break;
      case 'color': {
        var st = su.seats[+v], taken = su.seats.map(function (x) { return x.color; });
        for (var k = 1; k <= NCOL; k++) { var c = (st.color + k) % NCOL; if (taken.indexOf(c) < 0 || k === NCOL) { st.color = c; break; } }
        break;
      }
      case 'kind': { var sk = su.seats[+v]; sk.cpu = (sk.cpu + 1) % 5; if (su.seats.every(function (x) { return x.cpu; }) && su.seats.length === 1) sk.cpu = 0; break; }
      case 'add': if (su.seats.length < 4) su.seats.push(newSeat(su.mode === 'party' ? 0 : set.diff)); break;
      case 'del': if (su.seats.length > 1) su.seats.pop(); break;
      case 'rounds': set.rounds = +v; break;
      case 'diff': set.diff = +v; su.seats.forEach(function (s) { if (s.cpu) s.cpu = +v; }); break;
      case 'timer': set.timer = +v; break;
      case 'clock': set.clock = +v; break;
      case 'anim': set.anim = v; S.spf = SPF[v] || 1; break;
      case 'sound': S.snd.on = v === '1'; sset(SOUND_KEY, S.snd.on ? '1' : '0'); S.snd.ensure(); syncHead(); break;
      case 'reset': S.resetArm = true; break;
      case 'reset-no': S.resetArm = false; break;
      case 'reset-yes': S.stats = E.newStats(); persistStats(); S.resetArm = false; break;
      case 'play': commitEdit(); persistSetup(); persistSettings(); sdel(GAME_KEY); startGame(null); return;
      case 'resume-game': if (S.resume) { var o = S.resume; S.resume = null; startGame(o); } return;
      case 'resume': resume(); return;
      case 'help': S.helpFrom = S.card; showCard('help'); return;
      case 'help-close':
        sset(SEEN_KEY, '1');
        if (S.paused) showCard('pause'); else if (S.mode === 'menu') showCard('menu'); else { hideCard(); if (S.helpFrom && S.helpFrom !== 'help') showCard(S.helpFrom); else advance(); }
        return;
      case 'quit':
        if (!S.quitArm) { S.quitArm = true; showCard('pause'); return; }
        S.quitArm = false; S.paused = false; saveIfStable(); S.cardUnder = null; toMenu(); return;
      case 'intro-go': introDone(); return;
      case 'next': roundOver(true); return;
      case 'over': showCard('over'); return;
      case 'menu': S.g = null; toMenu(); return;
      case 'again': startGame(null); return;
      default: re = false;
    }
    if (!re) return;
    persistSetup(); persistSettings();
    showCard('menu');
    if (a === 'edit' && S.editSeat >= 0) {
      var inp = S.ovl.querySelector('.wh-in');
      if (inp) { try { inp.focus(); inp.select(); } catch (e) {} }
    } else if (b && !S.coarse) {
      var sel = S.ovl.querySelector('[data-act="' + a + '"][data-v="' + v + '"]') || S.ovl.querySelector('[data-act="' + a + '"]');
      if (sel) { try { sel.focus({ preventScroll: true }); } catch (e) {} }
    }
  }
  function newSeat(cpu) {
    var su = S.setup, used = su.seats.map(function (x) { return x.name; }), cols = su.seats.map(function (x) { return x.color; });
    var pool = FUN.filter(function (n) { return used.indexOf(n) < 0; }), c = 0;
    while (cols.indexOf(c) >= 0 && c < NCOL - 1) c++;
    return { name: pool[Math.floor(Math.random() * pool.length)] || 'Player', color: c, cpu: cpu };
  }
  function commitEdit() {
    var inp = S.ovl.querySelector('.wh-in');
    if (!inp) return;
    var i = +inp.getAttribute('data-seat'), v = String(inp.value || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (S.setup.seats[i] && v) S.setup.seats[i].name = v;
    S.editSeat = -1;
    persistSetup();
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var wide = vw >= 900 && vh >= 600;
    S.panel.classList.toggle('wh-wide', wide);
    var colW = wide ? 470 : Math.floor(Math.min(vw - (phone ? (solo ? 20 : 34) : 48), 540));
    S.root.style.setProperty('--wh-col', colW + 'px');
    var tw = Math.floor((colW - 14 - 13 * 3) / 14), th = Math.min(Math.round(tw * 1.3), 52);
    S.root.style.setProperty('--wh-tw', tw + 'px');
    S.root.style.setProperty('--wh-th', th + 'px');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var r = S.panel.getBoundingClientRect(), top = Math.max(0, Math.min(r.top || 0, 140)), mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    var room = vh - top - 10;
    if (mh > 0) room = Math.min(room, mh);
    var D;
    S.wmodal = false;
    if (wide) D = clamp(Math.min(room - 70, 430), 240, 430);
    else {
      var chrome = chromeNow(r);
      if (!r.height) chrome = 470;
      D = Math.min(colW, room - chrome - 4, 400);
      if (D < 170) { S.wmodal = true; D = Math.min(colW - 16, Math.round(vh * 0.55), 360); }
    }
    D = Math.max(120, Math.floor(D));
    S.panel.classList.toggle('wh-wmodal', S.wmodal);
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (D !== S.wD || dpr !== S.wDpr) {
      S.wD = D; S.wDpr = dpr; S.wR = D / 2 / 1.16;
      S.wcv.width = Math.round(D * dpr); S.wcv.height = Math.round(D * dpr);
      S.wcv.style.width = D + 'px'; S.wcv.style.height = D + 'px';
      S.faceKey = '';
    }
    S.wst.style.setProperty('--wh-wd', D + 'px');
    // the confetti layer covers the whole game
    var rr = S.root.getBoundingClientRect(), fd = Math.min(1.5, dpr);
    S.fxW = Math.max(1, Math.round(rr.width)); S.fxH = Math.max(1, Math.round(rr.height)); S.fxDpr = fd;
    S.fx.width = Math.round(S.fxW * fd); S.fx.height = Math.round(S.fxH * fd);
    S.lay = { vw: vw, vh: vh, chrome: chromeNow(S.panel.getBoundingClientRect()) };
    buildLights();
    drawWheel();
  }
  // the panel's height without the wheel (when the wheel sits in the column)
  function chromeNow(r) {
    var inFlow = !S.panel.classList.contains('wh-wmodal') && !S.panel.classList.contains('wh-wide');
    return (r.height || 0) - (inFlow ? (S.wst.offsetHeight || 0) : 0);
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeNow(S.panel.getBoundingClientRect());
    if (Math.abs(ch - S.lay.chrome) > 2 || S.lightsKey !== S.boardW.offsetWidth + 'x' + S.boardW.offsetHeight) layout();
  }
  function syncHead() {
    if (!S) return;
    var s = S.head.querySelector('[data-h="sound"]'), p = S.head.querySelector('[data-h="pause"]');
    s.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    s.title = S.snd.on ? 'Sound on' : 'Sound off'; s.setAttribute('aria-label', s.title);
    s.classList.toggle('on', S.snd.on);
    p.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    p.title = S.paused ? 'Resume' : 'Pause (Esc)'; p.setAttribute('aria-label', p.title);
    p.disabled = S.mode !== 'play';
  }

  // ---- keys ----
  function onKey(e) {
    if (!S || !S.panel.isConnected) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.classList && t.classList.contains('wh-in')) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); commitEdit(); showCard('menu'); }
      return;
    }
    // only when our panel is in charge: focus inside it, or no other text field focused
    var inPanel = t && S.panel.contains(t);
    if (!inPanel && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key, up = k && k.length === 1 ? k.toUpperCase() : k;
    var g = S.g, r = g && g.r, ph = r ? r.phase : '';
    function eat() { e.preventDefault(); e.stopPropagation(); }
    if (k === 'Escape') {
      eat();
      if (S.card === 'help') { cardAction('help-close'); return; }
      if (S.mode === 'play' && ph === 'speedSolve' && !S.paused && !S.card) { input('pass'); return; }
      if (S.paused) resume(); else pause();
      return;
    }
    if (S.card) {
      if ((k === 'Enter' || k === ' ') && (S.card === 'intro' || S.card === 'result')) { eat(); cardAction(S.card === 'intro' ? 'intro-go' : 'next'); }
      return;
    }
    if (S.mode !== 'play' || !g) return;
    if (S.paused) return;
    if (k === 'p' || k === 'P') {
      if (!/^(call|vowel|free|speedCall|bpick|solve|tossSolve|bsolve)$/.test(ph)) { eat(); pause(); return; }
    }
    if (/^[1-4]$/.test(k) && ph === 'toss') { eat(); var pi = +k - 1; if (g.players[pi] && !g.players[pi].cpu) input('buzz', pi); return; }
    if (k === ' ' || k === 'Spacebar') {
      eat();
      if (e.repeat) return;
      if (ph === 'done' || ph === 'bdone') { input('next'); return; }
      if (canHumanSpin()) startPow();
      return;
    }
    if (k === 'Enter') {
      eat();
      if (ph === 'turn' || ph === 'free' || ph === 'speedSolve') input('solve');
      else if (ph === 'done' || ph === 'bdone') input('next');
      else input('enter');
      return;
    }
    if (k === 'Backspace') { eat(); input('back'); return; }
    if (/^[A-Z]$/.test(up)) {
      if (ph === 'turn' && up === 'V') { eat(); input('vowel'); return; }
      if (ph === 'turn' && up === 'S' && canHumanSpin()) { eat(); if (!e.repeat) startPow(); return; }
      if (ph === 'mystery' && (up === 'Y' || up === 'N')) { eat(); input(up === 'Y' ? 'flip' : 'keep'); return; }
      if (/^(call|vowel|free|speedCall|bpick|solve|tossSolve|bsolve)$/.test(ph)) { eat(); input('letter', up); }
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 's' || e.key === 'S') && S.pow && S.pow.src === 'key') { e.preventDefault(); releasePow(); }
  }
  function startPow(src) {
    if (S.pow || !canHumanSpin()) return;
    S.snd.ensure();
    S.pow = { t0: S.now, src: src || 'key' };
    if (S.wmodal) S.wst.classList.add('show');
    var b = S.act.querySelector('[data-act="spin"]');
    if (b) b.classList.add('hold');
    ensureLoop();
  }
  function releasePow() {
    if (!S.pow) return;
    var v = powVal();
    S.pow = null;
    var b = S.act.querySelector('[data-act="spin"]');
    if (b) b.classList.remove('hold');
    if (!canHumanSpin()) { if (S.wmodal) S.wst.classList.remove('show'); return; }
    doSpin(5.5 + v * 13);
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    ['fx_party', 'fx_shk', 'fx_bkf'].forEach(function (k) { clearTimeout(s[k]); });
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    if (s.mode === 'play' && s.g && !s.g.over) {
      var ph = s.g.r && s.g.r.phase;
      if (ph && /^(turn|toss|bspin|bpick|speedCall|speedSolve|final|call|vowel|free|mystery|spin|solve|tossSolve)$/.test(ph)) { try { sset(GAME_KEY, JSON.stringify(s.g)); } catch (e) {} }
    }
    s.snd.close();
    [s.wcv, s.fx, s.face].forEach(function (c) { if (c) { c.width = 0; c.height = 0; } });
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
    var body = '<div class="wh"><div class="wh-hud"></div><div class="wh-main">' +
      '<div class="wh-left"><div class="wh-boardw"><div class="wh-lights" aria-hidden="true"></div><div class="wh-board" role="img" aria-label="Puzzle board"></div></div>' +
      '<div class="wh-cat"></div><div class="wh-msg"></div></div>' +
      '<div class="wh-wst"><canvas class="wh-wcv" aria-label="The wheel"></canvas></div>' +
      '<div class="wh-ctl"><div class="wh-act"></div><div class="wh-kb"></div></div></div>' +
      '<canvas class="wh-fx" aria-hidden="true"></canvas><div class="wh-ovl" style="display:none"></div><div class="wh-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\uD83C\uDFA1 Spin & Solve', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'wh-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="stats" title="Season stats" aria-label="Season stats">' + IC_TROPHY + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, set = E.normSettings(sjson(SET_KEY));
    S = {
      panel: p, head: hb, root: p.querySelector('.wh'), hud: p.querySelector('.wh-hud'), boardW: p.querySelector('.wh-boardw'), boardEl: p.querySelector('.wh-board'),
      lightsEl: p.querySelector('.wh-lights'), catEl: p.querySelector('.wh-cat'), msgEl: p.querySelector('.wh-msg'), wst: p.querySelector('.wh-wst'),
      wcv: p.querySelector('.wh-wcv'), act: p.querySelector('.wh-act'), kb: p.querySelector('.wh-kb'), fx: p.querySelector('.wh-fx'), ovl: p.querySelector('.wh-ovl'),
      live: p.querySelector('.wh-live'),
      set: set, spf: SPF[set.anim] || 1, setup: normSetup(sjson(SETUP_KEY)), stats: E.normStats(sjson(STATS_KEY)),
      recent: (function () { var a = sjson(RECENT_KEY); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }).slice(-400) : []; })(),
      snd: new Snd(sget(SOUND_KEY) !== '0'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: 'load', g: null, card: null, paused: false, busy: 0, jobs: [], now: 0, last: 0, raf: 0, acc: 0,
      spin: { a: 0, w: 0, on: false }, flap: 0, pow: null, drag: null, hiW: -1, hiT: 0, hubTxt: '', wPaint: -1e9, tmPaint: 0, tm: null,
      tileOf: {}, shown: [], lit: [], fill: null, slots: [], cur: 0, conf: [], fxDirty: false, tab: 'play', editSeat: -1, quitArm: false, resetArm: false,
      wD: 0, wDpr: 1, wR: 1, faceKey: '', face: null, actKey: '', catHtml: ''
    };
    S.wctx = S.wcv.getContext('2d');
    S.fxCtx = S.fx.getContext('2d');
    p._onClose = teardown;
    buildBoard(); buildKb();
    readTheme();
    layout();
    syncHead();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S && S.pow) { S.pow = null; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (!S || S.panel !== p) return; if (S.themeDirty) { S.themeDirty = false; readTheme(); } layout(); drawWheel(); });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.hud); S.ro.observe(S.act); S.ro.observe(S.msgEl);
    } catch (e) {}
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); drawWheel();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (e) {}

    // header buttons
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
        if (S.card === 'menu') showCard('menu');
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.mode === 'play' && !S.paused) pause();
        if (S.card === 'help') cardAction('help-close'); else if (S.mode !== 'load') { S.helpFrom = S.card; showCard('help'); }
      } else if (h === 'stats') {
        if (S.mode === 'play' && !S.paused) { pause(); return; }
        if (S.mode === 'menu') { S.tab = 'stats'; showCard('menu'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // no zoom, select, callouts
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.wcv.addEventListener('touchstart', noTouch, { passive: false });
    S.wcv.addEventListener('touchmove', noTouch, { passive: false });
    S.ctlEl = p.querySelector('.wh-ctl');
    S.ctlEl.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      noTouch(e);
      if (b.getAttribute('data-act') === 'spin' || b.hasAttribute('data-buzz')) return;   // handled on pointer down/up
      if (!b.disabled) b.click();
    }, { passive: false });
    S.ctlEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.wcv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // the keyboard + action row
    S.kb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-l]') : null;
      if (!b || b.disabled) return;
      var L = b.getAttribute('data-l');
      if (L === 'back') input('back'); else input('letter', L);
    });
    S.act.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      if (b.hasAttribute('data-buzz')) { e.preventDefault(); input('buzz', +b.getAttribute('data-buzz')); return; }
      if (b.getAttribute('data-act') === 'spin') {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch (x) {}
        startPow('btn');
      }
    });
    function spinUp(e) {
      if (!S || !S.pow || S.pow.src !== 'btn') return;
      var b = e.target.closest ? e.target.closest('[data-act="spin"]') : null;
      if (!b) return;
      releasePow();
    }
    S.act.addEventListener('pointerup', spinUp);
    S.act.addEventListener('pointercancel', function () { if (S && S.pow && S.pow.src === 'btn') { S.pow = null; if (S.wmodal) S.wst.classList.remove('show'); } });
    S.act.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || !S || b.disabled) return;
      var a = b.getAttribute('data-act');
      if (a === 'spin') return;
      input(a);
    });
    // the board: tap a blank to move the cursor while solving
    S.boardEl.addEventListener('pointerdown', function (e) {
      var t = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!t || !S || !S.fill) return;
      e.preventDefault();
      input('slot', +t.getAttribute('data-i'));
    });
    // flick the wheel
    function wAng(e) {
      var rc = S.wcv.getBoundingClientRect();
      return Math.atan2(e.clientY - (rc.top + rc.height / 2), e.clientX - (rc.left + rc.width / 2));
    }
    S.wcv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!canHumanSpin() || S.drag) return;
      try { S.wcv.setPointerCapture(e.pointerId); } catch (x) {}
      var a = wAng(e);
      S.drag = { id: e.pointerId, last: a, smp: [{ t: performance.now(), a: S.spin.a }] };
      ensureLoop();
    });
    S.wcv.addEventListener('pointermove', function (e) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      if (!canHumanSpin()) { S.drag = null; return; }
      var a = wAng(e), d = a - S.drag.last;
      if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
      S.drag.last = a;
      var W = TAU / wheelList().length, before = Math.floor(S.spin.a / W);
      S.spin.a += d;
      if (Math.floor(S.spin.a / W) !== before) { S.snd.tick(); S.flap = Math.max(-0.5, Math.min(0.5, S.flap - (d >= 0 ? 0.3 : -0.3))); }
      var now = performance.now();
      S.drag.smp.push({ t: now, a: S.spin.a });
      while (S.drag.smp.length > 2 && now - S.drag.smp[0].t > 120) S.drag.smp.shift();
    });
    function dragEnd(e, cancel) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      var d = S.drag; S.drag = null;
      if (cancel || !canHumanSpin()) return;
      var now = performance.now(), s0 = d.smp[0], s1 = d.smp[d.smp.length - 1];
      var dt = Math.max(0.016, (now - s0.t) / 1000), w = (s1.a - s0.a) / dt;
      if (now - s1.t > 140) w = 0;
      if (Math.abs(w) >= SPIN_MIN) doSpin(w * 1.1);
      else if (Math.abs(s1.a - d.smp[0].a) > 0.05 || d.smp.length > 2) say('Give it a real flick! (or hold SPIN)');
    }
    S.wcv.addEventListener('pointerup', function (e) { dragEnd(e, false); });
    S.wcv.addEventListener('pointercancel', function (e) { dragEnd(e, true); });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      if (b.tagName === 'INPUT') return;
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (a !== 'quit') S.quitArm = false;
      cardAction(a, b.getAttribute('data-v'), e.detail === 0);
      S.snd.tone(988, 0.04, 'sine', 0.025);
    });
    S.ovl.addEventListener('focusout', function (e) {
      if (S && e.target && e.target.classList && e.target.classList.contains('wh-in')) {
        setTimeout(function () { if (S && S.editSeat >= 0 && !S.ovl.contains(document.activeElement)) { commitEdit(); if (S.card === 'menu') showCard('menu'); } }, 0);
      }
    });

    // the stylesheet arrives asynchronously: re-read the theme and fit once it applies
    (function waitCss(n) {
      if (!S || S.panel !== p) return;
      if (getComputedStyle(p).getPropertyValue('--wh-w0').trim() || n > 80) { readTheme(); layout(); drawWheel(); requestAnimationFrame(function () { if (S && S.panel === p) layout(); }); return; }
      setTimeout(function () { waitCss(n + 1); }, 50);
    })(0);
    say('Loading puzzles&hellip;');
    loadData().then(function (d) {
      if (!S || S.panel !== p) return;
      if (!BANK) { BANK = E.parseBank(d); DICT = E.buildDict(BANK); }
      S.mode = 'menu';
      say('');
      toMenu();
      if (!sget(SEEN_KEY)) showCard('help');
      requestAnimationFrame(function () { if (S && S.panel === p) { layout(); drawWheel(); } });
    }, function () {
      if (!S || S.panel !== p) return;
      say('Could not load the puzzle bank. Close and try again.', 'bad');
    });
    drawWheel();
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Spin the wheel, call letters, buy vowels and solve the puzzle \u2014 1-4 players or vs CPU',
    icon: '\uD83C\uDFA1',
    tags: 'game,word,party,puzzle,wheel,phrase,multiplayer,pass and play,cpu,2 player,fun',
    open: open,
    _engine: ENGINE
  });
})();
