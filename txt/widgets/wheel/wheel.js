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
  //@@UI@@
})();
