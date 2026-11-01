/* Word Ladder — change one letter at a time to climb from one word to another, for Cade.txt.
 * Every rung must be a real word, one letter different from the rung above.
 * 3-, 4- and 5-letter ladders. A BFS solver over a common-word graph makes
 * sure every puzzle is solvable and gives its PAR (the fewest moves), a hint
 * (the next word on a shortest path from where you stand) and the full
 * solution. Modes: the Daily ladder (one per length, seeded by the date,
 * streaks), Practice (random, easy / medium / hard), Race vs CPU (the CPU
 * climbs a rung every few seconds by level) and 2 Players pass-and-play (same
 * ladder, fewest moves wins, ties go to the faster climber).
 * Words load lazily from wordladder-words.js (~90 KB, precached; SCOWL +
 * word-list@4.1.0, see build-words.js). Rungs may use any word in the big
 * list; par, hints and solutions only ever use common words.
 * Type on the keyboard (Enter to climb, Backspace on an empty rung takes the
 * last rung back) or use the on-screen keys. Progress persists in Cade.store
 * (cade-wordladder-*). Offline once loaded. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var LENS = [3, 4, 5];
  var DIFFS = ['easy', 'medium', 'hard'];
  // Par (moves) ranges for random puzzles, by length and difficulty.
  var RANGES = {
    3: { easy: [2, 3], medium: [4, 4], hard: [5, 7] },
    4: { easy: [3, 4], medium: [5, 6], hard: [7, 10] },
    5: { easy: [3, 4], medium: [5, 7], hard: [8, 14] }
  };
  // The CPU racer: seconds per rung (before jitter), jitter, chance of a wasted rung.
  var CPU = {
    easy: { step: 17, jit: 0.35, detour: 0.3, name: 'Easy' },
    medium: { step: 11.5, jit: 0.3, detour: 0.12, name: 'Medium' },
    hard: { step: 7.5, jit: 0.25, detour: 0, name: 'Hard' }
  };
  var LEN_PACE = { 3: 0.8, 4: 1, 5: 1.2 };
  var EPOCH = Date.UTC(2024, 0, 1) / 864e5;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // Small seeded PRNG (mulberry32) and an integer hash, so puzzles are reproducible.
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
  // Local calendar day → a day number (2024-01-01 is day 0).
  function dayNumber(d) {
    d = d || new Date();
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5 - EPOCH);
  }

  function chop(s, n) {
    var out = [];
    if (typeof s !== 'string') return out;
    for (var i = 0; i + n <= s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  }
  // The data file's runs → per-length lexicons with a lazily built graph.
  function parseLists(D) {
    var lex = {};
    LENS.forEach(function (n) {
      var e = (D && (D[n] || D[String(n)])) || {};
      var core = chop(e.core, n), common = chop(e.common, n), extra = chop(e.extra, n);
      var L = { n: n, core: core, solve: core.concat(common).sort(), coreSet: new Set(core), solveSet: null, validSet: null, buckets: null };
      L.solveSet = new Set(L.solve);
      L.validSet = new Set(L.solve.concat(extra));
      lex[n] = L;
    });
    return lex;
  }
  function pat(w, i) { return w.slice(0, i) + '_' + w.slice(i + 1); }
  function buckets(L) {
    if (L.buckets) return L.buckets;
    var B = new Map();
    for (var k = 0; k < L.solve.length; k++) {
      var w = L.solve[k];
      for (var i = 0; i < w.length; i++) {
        var p = pat(w, i), a = B.get(p);
        if (a) a.push(w); else B.set(p, [w]);
      }
    }
    L.buckets = B;
    return B;
  }
  // Common words one letter away from w (w itself need not be common).
  function neighbors(L, w) {
    var B = buckets(L), out = [];
    for (var i = 0; i < w.length; i++) {
      var a = B.get(pat(w, i));
      if (a) for (var j = 0; j < a.length; j++) if (a[j] !== w) out.push(a[j]);
    }
    return out;
  }
  function oneApart(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i) && ++d > 1) return false;
    return d === 1;
  }
  function diffAt(a, b) {
    for (var i = 0; i < a.length; i++) if (a.charAt(i) !== b.charAt(i)) return i;
    return -1;
  }
  function matches(a, b) {
    var m = 0;
    for (var i = 0; i < a.length; i++) if (a.charAt(i) === b.charAt(i)) m++;
    return m;
  }
  // Shortest ladder from → to over the common-word graph, avoiding `avoid` words
  // (the ends are always allowed). Returns the words, ends included, or null.
  function solve(L, from, to, avoid) {
    if (!from || !to || from.length !== L.n || to.length !== L.n) return null;
    if (from === to) return [from];
    var prev = new Map(), q = [from], qi = 0;
    prev.set(from, '');
    var targetCommon = L.solveSet.has(to);
    while (qi < q.length) {
      var w = q[qi++], nb = neighbors(L, w);
      if (!targetCommon && oneApart(w, to)) nb.push(to);
      for (var i = 0; i < nb.length; i++) {
        var x = nb[i];
        if (prev.has(x) || (avoid && avoid.has(x) && x !== to)) continue;
        prev.set(x, w);
        if (x === to) {
          var path = [to], c = w;
          while (c) { path.push(c); c = prev.get(c); }
          return path.reverse();
        }
        q.push(x);
      }
    }
    return null;
  }
  // Distances (in moves) from a word to everything reachable.
  function distances(L, from) {
    var dist = new Map(), q = [from], qi = 0;
    dist.set(from, 0);
    while (qi < q.length) {
      var w = q[qi++], d = dist.get(w), nb = neighbors(L, w);
      for (var i = 0; i < nb.length; i++) if (!dist.has(nb[i])) { dist.set(nb[i], d + 1); q.push(nb[i]); }
    }
    return dist;
  }
  // A solvable puzzle: two core words whose shortest ladder is in the
  // difficulty's par range (widened if the dice are unkind).
  function genPuzzle(lex, n, diff, rnd) {
    var L = lex[n], R = (RANGES[n] || RANGES[4])[diff] || RANGES[n].medium;
    if (!L || L.core.length < 2) return null;
    var lo = R[0], hi = R[1], best = null;
    for (var tries = 0; tries < 160; tries++) {
      if (tries === 60) { lo = Math.max(2, lo - 1); hi += 1; }
      if (tries === 110) { lo = 2; hi += 3; }
      var start = L.core[Math.floor(rnd() * L.core.length)], dist = distances(L, start), cand = [];
      dist.forEach(function (d, w) { if (d >= lo && d <= hi && L.coreSet.has(w)) cand.push(w); });
      if (!cand.length) {
        // remember the farthest reachable core word as a fallback
        dist.forEach(function (d, w) { if (d >= 2 && L.coreSet.has(w) && (!best || d > best.par)) best = { start: start, end: w, par: d }; });
        continue;
      }
      cand.sort();
      var end = cand[Math.floor(rnd() * cand.length)];
      return { n: n, start: start, end: end, par: dist.get(end), diff: diff };
    }
    return best ? { n: n, start: best.start, end: best.end, par: best.par, diff: diff } : null;
  }
  function dailyPuzzle(lex, n, day) {
    var p = genPuzzle(lex, n, 'medium', rng(hash2(day * 7 + n, 0x1add3e)));
    if (p) { p.day = day; p.diff = 'daily'; }
    return p;
  }

  // ---- a game: the rungs climbed so far ----
  function newGame(p) {
    return { n: p.n, start: p.start, end: p.end, par: p.par, day: p.day == null ? null : p.day, diff: p.diff || 'medium',
      rungs: [p.start], hints: 0, undos: 0, revealed: false, done: false, solved: false, time: 0 };
  }
  function moves(g) { return g.rungs.length - 1; }
  function last(g) { return g.rungs[g.rungs.length - 1]; }
  // Check a word against the rules without changing the game.
  function check(lex, g, w) {
    w = String(w || '').toLowerCase();
    var L = lex[g.n];
    if (g.done) return { ok: false, err: 'done' };
    if (w.length !== g.n) return { ok: false, err: 'length' };
    if (!/^[a-z]+$/.test(w) || !L || !L.validSet.has(w) && w !== g.end) return { ok: false, err: 'unknown' };
    var p = last(g);
    if (w === p) return { ok: false, err: 'same' };
    if (!oneApart(p, w)) return { ok: false, err: 'notone' };
    if (g.rungs.indexOf(w) >= 0) return { ok: false, err: 'repeat' };
    return { ok: true, word: w };
  }
  // Climb a rung. A word one letter from the end completes the ladder.
  function climb(lex, g, w) {
    var r = check(lex, g, w);
    if (!r.ok) return r;
    g.rungs.push(r.word);
    if (r.word !== g.end && oneApart(r.word, g.end)) { g.rungs.push(g.end); r.auto = true; }
    if (last(g) === g.end) { g.done = true; g.solved = true; r.finished = true; }
    return r;
  }
  function undo(g) {
    if (g.done || g.rungs.length < 2) return null;
    g.undos++;
    return g.rungs.pop();
  }
  // The next word on a shortest ladder from where the player stands; if they
  // are stuck (a dead end), { back: true } suggests stepping back.
  function hint(lex, g) {
    if (g.done) return null;
    var path = solve(lex[g.n], last(g), g.end, new Set(g.rungs));
    if (!path || path.length < 2) return { back: true };
    return { word: path[1], left: path.length - 1 };
  }
  // Give up: the ladder is finished for you from the start (a clean shortest one).
  function reveal(lex, g) {
    var path = solve(lex[g.n], g.start, g.end);
    g.revealed = true; g.done = true; g.solved = false;
    return path;
  }
  // Score a finished game against par.
  function score(g) {
    var m = moves(g), d = m - g.par;
    if (!g.solved) return { moves: m, diff: d, label: 'Revealed', points: 0, stars: 0 };
    var label = d <= -2 ? 'Eagle! ' + d : d === -1 ? 'Birdie! -1' : d === 0 ? 'Par' : d === 1 ? 'Bogey +1' : d === 2 ? 'Double bogey +2' : '+' + d + ' over par';
    var pts = Math.max(10, 100 + 30 * Math.max(0, -d) - 15 * Math.max(0, d) - 20 * g.hints) * (g.n === 5 ? 1.5 : g.n === 3 ? 0.75 : 1);
    var stars = d <= 0 && !g.hints ? 3 : d <= 2 && g.hints <= 1 ? 2 : 1;
    return { moves: m, diff: d, label: label, points: Math.round(pts), stars: stars };
  }
  // Two players, same ladder: solved beats not; then fewer moves (+1 per hint); then faster.
  function effective(r) { return r.moves + r.hints; }
  function compare(a, b) {
    if (a.solved !== b.solved) return a.solved ? 1 : 2;
    if (!a.solved) return 0;
    var ea = effective(a), eb = effective(b);
    if (ea !== eb) return ea < eb ? 1 : 2;
    if (Math.abs(a.time - b.time) >= 0.1) return a.time < b.time ? 1 : 2;
    return 0;
  }
  // The CPU racer's plan: when (in seconds of play) it reaches each rung. It
  // climbs a shortest ladder; at lower levels it sometimes wastes a rung.
  function cpuPlan(lex, p, level, rnd) {
    var c = CPU[level] || CPU.medium, path = solve(lex[p.n], p.start, p.end) || [p.start, p.end];
    var times = [], t = 1.5, pace = LEN_PACE[p.n] || 1, wasted = 0;
    for (var i = 1; i < path.length; i++) {
      if (c.detour && rnd() < c.detour) { t += c.step * pace * (1 + c.jit * (rnd() * 2 - 1)); times.push(-t); wasted++; }
      t += c.step * pace * (1 + c.jit * (rnd() * 2 - 1));
      times.push(t);
    }
    return { path: path, times: times.map(Math.abs), wasted: wasted, total: times.length ? Math.abs(times[times.length - 1]) : 0 };
  }
  // Rungs the CPU has climbed by time t (wasted rungs count, then get taken back).
  function cpuAt(plan, t) {
    var k = 0;
    while (k < plan.times.length && plan.times[k] <= t) k++;
    return k;
  }
  function cpuProgress(plan, t) {
    var k = cpuAt(plan, t), n = plan.times.length;
    return { rungs: k, of: n, frac: n ? k / n : 1, done: k >= n };
  }

  // ---- the save ----
  function blankLenStats() { return { played: 0, solved: 0, atPar: 0, under: 0, hints: 0, points: 0, overSum: 0, bestTime: 0, dist: [0, 0, 0, 0, 0] }; }
  function newSave() {
    var s = { v: 1, len: 4, diff: 'medium', cpu: 'medium', stats: {}, daily: { streak: 0, best: 0, last: -1, done: {} }, race: {}, duo: { games: 0 }, games: { daily: {}, practice: {} }, seen: false };
    LENS.forEach(function (n) { s.stats[n] = blankLenStats(); });
    DIFFS.forEach(function (d) { s.race[d] = { w: 0, l: 0, best: 0 }; });
    return s;
  }
  function num(v, lo) { v = +v; return isFinite(v) ? Math.max(lo == null ? 0 : lo, v) : 0; }
  function isWord(w, n) { return typeof w === 'string' && w.length === n && /^[a-z]+$/.test(w); }
  function normGame(o) {
    if (!o || typeof o !== 'object') return null;
    var n = +o.n;
    if (LENS.indexOf(n) < 0 || !isWord(o.start, n) || !isWord(o.end, n) || !Array.isArray(o.rungs) || o.rungs[0] !== o.start) return null;
    var rungs = [];
    for (var i = 0; i < o.rungs.length && i < 60; i++) {
      if (!isWord(o.rungs[i], n) || (i && !oneApart(rungs[i - 1], o.rungs[i]))) return null;
      rungs.push(o.rungs[i]);
    }
    var g = newGame({ n: n, start: o.start, end: o.end, par: clamp(+o.par | 0, 1, 40), day: o.day == null ? null : (+o.day | 0), diff: DIFFS.indexOf(o.diff) >= 0 || o.diff === 'daily' ? o.diff : 'medium' });
    g.rungs = rungs; g.hints = num(o.hints) | 0; g.undos = num(o.undos) | 0; g.time = num(o.time);
    g.done = !!o.done; g.solved = g.done && !!o.solved && rungs[rungs.length - 1] === o.end; g.revealed = !!o.revealed;
    return g;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (LENS.indexOf(+o.len) >= 0) s.len = +o.len;
    if (DIFFS.indexOf(o.diff) >= 0) s.diff = o.diff;
    if (CPU[o.cpu]) s.cpu = o.cpu;
    s.seen = !!o.seen;
    if (o.stats && typeof o.stats === 'object') LENS.forEach(function (n) {
      var a = o.stats[n], b = s.stats[n];
      if (!a || typeof a !== 'object') return;
      ['played', 'solved', 'atPar', 'under', 'hints', 'points', 'overSum', 'bestTime'].forEach(function (k) { b[k] = num(a[k]); });
      b.solved = Math.min(b.solved, b.played); b.atPar = Math.min(b.atPar, b.solved); b.under = Math.min(b.under, b.atPar);
      if (Array.isArray(a.dist)) for (var i = 0; i < 5; i++) b.dist[i] = num(a.dist[i]) | 0;
    });
    var d = o.daily;
    if (d && typeof d === 'object') {
      s.daily.streak = num(d.streak) | 0; s.daily.best = Math.max(num(d.best) | 0, s.daily.streak); s.daily.last = isFinite(+d.last) ? +d.last | 0 : -1;
      if (d.done && typeof d.done === 'object') {
        var keys = Object.keys(d.done).filter(function (k) { return /^\d+:[345]$/.test(k); }).sort(function (a, b) { return parseInt(b, 10) - parseInt(a, 10); }).slice(0, 90);
        keys.forEach(function (k) {
          var r = d.done[k];
          if (r && typeof r === 'object') s.daily.done[k] = { m: num(r.m) | 0, p: num(r.p) | 0, h: num(r.h) | 0, ok: !!r.ok, t: num(r.t) };
        });
      }
    }
    if (o.race && typeof o.race === 'object') DIFFS.forEach(function (k) {
      var r = o.race[k];
      if (r && typeof r === 'object') { s.race[k].w = num(r.w) | 0; s.race[k].l = num(r.l) | 0; s.race[k].best = num(r.best); }
    });
    if (o.duo && typeof o.duo === 'object') s.duo.games = num(o.duo.games) | 0;
    // Unfinished games, one per mode and length (older saves kept one per mode).
    if (o.games && typeof o.games === 'object') ['daily', 'practice'].forEach(function (m) {
      var src = o.games[m], list = [];
      if (src && typeof src === 'object') list = Array.isArray(src.rungs) ? [src] : LENS.map(function (n) { return src[n]; });
      list.forEach(function (x) {
        var g = normGame(x);
        if (g && !g.done && (m === 'practice' || g.day != null)) s.games[m][g.n] = g;
      });
    });
    return s;
  }
  // Fold a finished solo game into the stats; returns what's new for the card.
  function record(save, mode, g) {
    var st = save.stats[g.n], sc = score(g), out = { score: sc, newBestTime: false, streak: 0 };
    st.played++;
    if (g.solved) {
      st.solved++; st.points += sc.points; st.hints += g.hints; st.overSum += Math.max(0, sc.diff);
      if (sc.diff <= 0) st.atPar++;
      if (sc.diff < 0) st.under++;
      st.dist[clamp(sc.diff, -1, 3) + 1]++;
      if (!g.hints && (!st.bestTime || g.time < st.bestTime)) { out.newBestTime = !!st.bestTime; st.bestTime = Math.round(g.time * 10) / 10; }
    }
    if (mode === 'daily' && g.day != null) {
      var D = save.daily, key = g.day + ':' + g.n;
      if (!D.done[key]) {
        D.done[key] = { m: moves(g), p: g.par, h: g.hints, ok: g.solved, t: Math.round(g.time) };
        if (g.solved && D.last !== g.day) {
          D.streak = D.last === g.day - 1 ? D.streak + 1 : 1;
          D.last = g.day;
          if (D.streak > D.best) D.best = D.streak;
        }
      }
      out.streak = D.streak;
    }
    return out;
  }
  // A streak counts if it was kept up yesterday or today.
  function liveStreak(save, today) { var D = save.daily; return D.last >= today - 1 ? D.streak : 0; }

  var ENGINE = {
    LENS: LENS, DIFFS: DIFFS, RANGES: RANGES, CPU: CPU, EPOCH: EPOCH,
    rng: rng, hash2: hash2, dayNumber: dayNumber, parseLists: parseLists, neighbors: neighbors, oneApart: oneApart, diffAt: diffAt, matches: matches,
    solve: solve, distances: distances, genPuzzle: genPuzzle, dailyPuzzle: dailyPuzzle,
    newGame: newGame, moves: moves, last: last, check: check, climb: climb, undo: undo, hint: hint, reveal: reveal, score: score,
    compare: compare, effective: effective, cpuPlan: cpuPlan, cpuAt: cpuAt, cpuProgress: cpuProgress,
    newSave: newSave, normSave: normSave, normGame: normGame, record: record, liveStreak: liveStreak
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('wordladder.css');
  var WORDS_URL = Cade.asset('wordladder-words.js'); // resolve now, while the loader context is ours

  var PANEL_ID = 'wordladder-panel', NAME = 'Word Ladder';
  var RACE_HINT = 5;      // seconds the CPU gains per hint in a race
  var KEY = 'cade-wordladder-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var S = null;           // the live session (one panel at a time)
  var LEX = null;         // parsed word lists (kept across opens)
  var loading = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.wordladder = { live: function () { return S; }, lex: function () { return LEX; } };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return normSave(o);
  }
  function persist() {
    if (!S) return;
    var sv = S.save;
    if ((S.mode === 'daily' || S.mode === 'practice') && S.g) { if (S.g.done) delete sv.games[S.mode][S.g.n]; else sv.games[S.mode][S.g.n] = S.g; }
    sset(SAVE_KEY, JSON.stringify(sv));
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function up(w) { return String(w).toUpperCase(); }
  function fmtTime(t) {
    t = Math.max(0, Math.floor(t));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function loadWords() {
    if (LEX) return Promise.resolve();
    if (window.__cadeWordLadderWords) { LEX = parseLists(window.__cadeWordLadderWords); return Promise.resolve(); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = WORDS_URL;
      s.onload = function () {
        loading = null;
        if (window.__cadeWordLadderWords) { LEX = parseLists(window.__cadeWordLadderWords); resolve(); } else reject(new Error('no data'));
      };
      s.onerror = function () { loading = null; s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  var SFX = {
    key: function (s) { s.tone(1400, 0.025, 'square', 0.012); },
    rung: function (s, k) { var f = 440 * Math.pow(2, Math.min(k, 12) / 12); s.tone(f, 0.09, 'triangle', 0.05); s.tone(f * 1.5, 0.12, 'sine', 0.03, 0, 0.06); },
    bad: function (s) { s.tone(160, 0.16, 'sawtooth', 0.03, 110); },
    hint: function (s) { s.tone(988, 0.08, 'sine', 0.04); s.tone(1319, 0.14, 'sine', 0.035, 0, 0.08); },
    undo: function (s) { s.tone(520, 0.08, 'triangle', 0.035, 380); },
    win: function (s) { [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.18, 'triangle', 0.05, 0, i * 0.08); }); },
    lose: function (s) { [392, 330, 262].forEach(function (f, i) { s.tone(f, 0.22, 'triangle', 0.045, 0, i * 0.14); }); },
    cpu: function (s) { s.tone(220, 0.06, 'square', 0.018); },
    tick: function (s, k) { s.tone(k ? 660 : 990, k ? 0.08 : 0.2, 'square', 0.03); }
  };
  function sfx(name, a) { if (S && S.snd.on) { S.snd.ensure(); SFX[name](S.snd, a); } }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_HOME = svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>');

  var ERR = {
    length: function (n) { return 'Needs ' + n + ' letters'; },
    unknown: function () { return 'Not in the word list'; },
    same: function () { return 'Change one letter'; },
    notone: function () { return 'Change exactly one letter'; },
    repeat: function () { return 'Already on your ladder'; }
  };
  var MODE_NAME = { daily: 'Daily', practice: 'Practice', race: 'Race', duo: '2 Players' };

  // ---------------- rendering ----------------
  function tilesHtml(w, n, cls, mark) {
    var h = '';
    for (var i = 0; i < n; i++) {
      var ch = w ? w.charAt(i) : '';
      h += '<b class="wl-t' + (i === mark ? ' chg' : '') + (cls ? ' ' + cls : '') + '">' + (ch ? esc(up(ch)) : '') + '</b>';
    }
    return h;
  }
  function meterHtml(w, end) {
    var m = matches(w, end), h = '';
    for (var i = 0; i < end.length; i++) h += i < m ? '<i class="on">&#9679;</i>' : '<i>&#9675;</i>';
    return '<span class="wl-meter" title="' + m + ' of ' + end.length + ' letters in place">' + h + '</span>';
  }
  function rungHtml(kind, w, idx, extra) {
    var g = S.g, n = g.n, prev = idx > 0 ? g.rungs[idx - 1] : null;
    var mark = prev && w ? diffAt(prev, w) : -1;
    var lab = kind === 'start' ? 'START' : kind === 'end' ? 'END' : String(idx);
    return '<div class="wl-rung ' + kind + (extra || '') + '" data-i="' + idx + '"><span class="wl-lab">' + lab + '</span>' +
      '<span class="wl-rail">' + tilesHtml(w, n, '', mark) + '</span>' + (w && kind !== 'end' ? meterHtml(w, g.end) : '<span class="wl-meter"></span>') + '</div>';
  }
  function inputHtml() {
    var g = S.g, n = g.n, prev = last(g), cur = S.cur, h = '';
    for (var i = 0; i < n; i++) {
      var ch = cur.charAt(i);
      var cls = ch ? (ch !== prev.charAt(i) ? ' chg' : '') : ' ghost' + (i === cur.length ? ' caret' : '');
      h += '<b class="wl-t' + cls + '">' + (ch ? esc(up(ch)) : esc(up(prev.charAt(i)))) + '</b>';
    }
    return '<div class="wl-rung input' + (S.hintWord ? ' hinted' : '') + '"><span class="wl-lab">' + (g.rungs.length) + '</span>' +
      '<span class="wl-rail">' + h + '</span><span class="wl-meter">' + (S.hintWord ? '<em>hint</em>' : '') + '</span></div>';
  }
  function ladderHtml() {
    var g = S.g, h = '', i;
    var rungs = g.rungs, endIn = g.done && g.solved;
    if (g.done && !g.solved && S.solution) rungs = [g.start];   // revealed: show the solver's ladder instead
    for (i = 0; i < rungs.length; i++) {
      if (endIn && i === rungs.length - 1) break;
      h += rungHtml(i === 0 ? 'start' : 'word' + (S.newIdx === i ? ' pop' : ''), rungs[i], i);
    }
    if (!g.done) {
      h += inputHtml();
      // dotted rungs left to make par
      var left = g.par - moves(g) - 2;
      for (i = 0; i < left && i < 12; i++) h += '<div class="wl-rung gap"><span class="wl-lab"></span><span class="wl-rail">' + tilesHtml('', g.n, 'gap', -1) + '</span><span class="wl-meter"></span></div>';
    } else if (!g.solved && S.solution) {
      for (i = 1; i < S.solution.length - 1; i++) h += '<div class="wl-rung sol"><span class="wl-lab">' + i + '</span><span class="wl-rail">' + tilesHtml(S.solution[i], g.n, '', diffAt(S.solution[i - 1], S.solution[i])) + '</span><span class="wl-meter"></span></div>';
    }
    var endIdx = endIn ? rungs.length - 1 : -1;
    h += '<div class="wl-rung end' + (endIn ? ' reached' + (S.newIdx === endIdx ? ' pop' : '') : '') + '"><span class="wl-lab">END</span><span class="wl-rail">' +
      tilesHtml(g.end, g.n, '', endIn ? diffAt(rungs[endIdx - 1], g.end) : -1) + '</span><span class="wl-meter"></span></div>';
    return h;
  }
  function paintLadder(scroll) {
    if (!S || !S.g) return;
    S.ladder.innerHTML = ladderHtml();
    S.newIdx = -1;
    if (scroll) {
      var el = S.ladder.querySelector('.wl-rung.input') || S.ladder.querySelector('.wl-rung.end');
      if (el) {
        var lt = S.ladder, top = el.offsetTop - lt.clientHeight / 2 + el.offsetHeight;
        lt.scrollTop = Math.max(0, top);
      }
    }
  }
  function paintInput() {
    var el = S.ladder.querySelector('.wl-rung.input');
    if (!el) { paintLadder(true); return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = inputHtml();
    el.replaceWith(tmp.firstChild);
  }
  function paintBar() {
    if (!S || !S.g) { S.bar.innerHTML = ''; return; }
    var g = S.g, m = moves(g), t = '';
    var who = S.mode === 'duo' ? '<b class="wl-who p' + S.duo.turn + '">P' + S.duo.turn + '</b>' : '<b>' + esc(MODE_NAME[S.mode] || '') + '</b>';
    if (S.mode === 'daily') who += ' <span>#' + (g.day + 1) + '</span>';
    else if (S.mode === 'practice') who += ' <span>' + esc(g.diff) + '</span>';
    t += '<span class="wl-bm">' + who + ' <span class="wl-dim">' + g.n + 'L</span></span>';
    t += '<span class="wl-bpar">moves <b>' + m + '</b> / par <b>' + g.par + '</b>' + (g.hints ? ' <span class="wl-dim">· ' + g.hints + ' hint' + (g.hints > 1 ? 's' : '') + '</span>' : '') + '</span>';
    t += '<span class="wl-clock">' + fmtTime(g.time) + '</span>';
    S.bar.innerHTML = t;
    S.clockEl = S.bar.querySelector('.wl-clock');
    S.shownSec = Math.floor(g.time);
  }
  function paintCpu() {
    if (!S || S.mode !== 'race' || !S.race || !S.g) { S.cpuEl.style.display = 'none'; return; }
    S.cpuEl.style.display = '';
    var pr = cpuProgress(S.race.plan, S.race.t), you = S.g ? Math.min(moves(S.g), S.race.plan.path.length - 1) : 0, par = S.g.par;
    var W = 14, cf = Math.round(W * pr.frac), yf = Math.round(W * clamp(you / Math.max(1, par), 0, 1));
    function bar(k, ch) { var s = ''; for (var i = 0; i < W; i++) s += i < k ? ch : '·'; return s; }
    S.cpuEl.innerHTML =
      '<div class="wl-trk you"><span>YOU</span><code>[' + bar(yf, '=') + ']</code><b>' + moves(S.g) + '/' + par + '</b></div>' +
      '<div class="wl-trk cpu' + (S.race.bump > 0 ? ' bump' : '') + '"><span>CPU</span><code>[' + bar(cf, '#') + ']</code><b>' + pr.rungs + '/' + pr.of + '</b></div>';
    S.cpuShown = pr.rungs;
  }
  function paintTools() {
    var g = S.g, h = '';
    if (!g) { S.tools.innerHTML = ''; return; }
    if (!g.done) {
      h += '<button type="button" class="wl-tb" data-act="undo"' + (g.rungs.length < 2 ? ' disabled' : '') + ' title="Take the last rung back (Backspace on an empty rung)">&#8630; Undo</button>';
      h += '<button type="button" class="wl-tb" data-act="hint" title="Fill in the next word on a shortest ladder (?)">? Hint</button>';
      h += '<button type="button" class="wl-tb' + (S.giveArm ? ' arm' : '') + '" data-act="give" title="Give up and show a solution">' + (S.giveArm ? 'Sure?' : (S.mode === 'race' ? 'Forfeit' : 'Solution')) + '</button>';
    } else {
      h += '<button type="button" class="wl-tb wide" data-act="result">Results</button>';
    }
    S.tools.innerHTML = h;
  }
  var KB_ROWS = ['qwertyuiop', 'asdfghjkl', '>zxcvbnm<'];
  function paintKb() {
    var h = '';
    KB_ROWS.forEach(function (r) {
      h += '<div class="wl-kr">';
      for (var i = 0; i < r.length; i++) {
        var c = r.charAt(i);
        if (c === '>') h += '<button type="button" class="wl-k wide" data-key="Enter" aria-label="Enter">ENTER</button>';
        else if (c === '<') h += '<button type="button" class="wl-k wide" data-key="Backspace" aria-label="Backspace">&#9003;</button>';
        else h += '<button type="button" class="wl-k" data-key="' + c + '">' + up(c) + '</button>';
      }
      h += '</div>';
    });
    S.kb.innerHTML = h;
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]'), pb = S.head.querySelector('[data-h="pause"]'), hb = S.head.querySelector('[data-h="home"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = sb.ariaLabel = S.snd.on ? 'Sound on' : 'Sound off';
    sb.classList.toggle('on', S.snd.on);
    var timed = S.g && !S.g.done && (S.mode === 'race' || S.mode === 'duo') && S.phase === 'play';
    pb.style.display = timed ? '' : 'none';
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.title = pb.ariaLabel = S.paused ? 'Resume' : 'Pause';
    hb.style.display = S.phase === 'home' ? 'none' : '';
  }
  function msg(text, kind, ms) {
    if (!S) return;
    S.msgEl.textContent = text || '';
    S.msgEl.className = 'wl-msg' + (kind ? ' ' + kind : '');
    clearTimeout(S.msgT);
    if (text && ms !== 0) S.msgT = setTimeout(function () { if (S) { S.msgEl.textContent = ''; S.msgEl.className = 'wl-msg'; } }, ms || 1600);
  }
  function shake() {
    var el = S.ladder.querySelector('.wl-rung.input');
    if (!el || S.rm) return;
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  }
  // Confetti: a few ASCII glyphs that fly out of an element and fall.
  function burst(fromEl, n, glyphs) {
    if (!S || S.rm || !fromEl || !S.fx.animate) return;
    var wr = S.wrap.getBoundingClientRect(), r = fromEl.getBoundingClientRect();
    var cx = r.left + r.width / 2 - wr.left, cy = r.top + r.height / 2 - wr.top;
    glyphs = glyphs || '*+.o#=';
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'wl-p c' + (i % 4);
      s.textContent = glyphs.charAt(i % glyphs.length);
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      S.fx.appendChild(s);
      var a = Math.random() * Math.PI * 2, v = 50 + Math.random() * 90, dx = Math.cos(a) * v, dy = Math.sin(a) * v * 0.7 - 40;
      var an = s.animate([
        { transform: 'translate(-50%,-50%) translate(0,0) rotate(0)', opacity: 1 },
        { transform: 'translate(-50%,-50%) translate(' + dx.toFixed(0) + 'px,' + (dy + 90).toFixed(0) + 'px) rotate(' + (Math.random() * 360 - 180).toFixed(0) + 'deg)', opacity: 0 }
      ], { duration: 700 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.4,1)' });
      an.onfinish = (function (el) { return function () { el.remove(); }; })(s);
    }
  }

  // ---------------- cards ----------------
  function seg(name, vals, cur, labels) {
    return '<div class="wl-seg" role="group">' + vals.map(function (v, i) {
      return '<button type="button" data-set="' + name + '" data-v="' + v + '" class="' + (String(v) === String(cur) ? 'on' : '') + '" aria-pressed="' + (String(v) === String(cur)) + '">' + esc(labels ? labels[i] : v) + '</button>';
    }).join('') + '</div>';
  }
  function dailyRow(n) {
    var sv = S.save, r = sv.daily.done[S.today + ':' + n], h = '';
    var dg = sv.games.daily[n], cur = dg && dg.day === S.today ? dg : null;
    var st = r ? (r.ok ? (r.m <= r.p ? '<span class="ok">' + (r.m < r.p ? 'under par' : 'par') + '</span>' : '<span class="meh">+' + (r.m - r.p) + '</span>') : '<span class="no">revealed</span>') :
      cur ? '<span class="dim">' + (cur.rungs.length - 1) + ' moves in</span>' : '<span class="dim">new</span>';
    h += '<button type="button" class="wl-day' + (r ? ' done' : '') + '" data-act="daily" data-n="' + n + '"><b>' + n + '</b><span>letters</span>' + st + '</button>';
    return h;
  }
  function homeHtml() {
    var sv = S.save, streak = liveStreak(sv, S.today), h = '';
    h += '<div class="wl-card wl-home">';
    h += '<pre class="wl-art" aria-hidden="true">|=[C][O][L][D]=|\n|=[C][O][R][D]=|\n|=[W][A][R][M]=|</pre>';
    h += '<div class="wl-title">WORD LADDER</div>';
    h += '<div class="wl-sec"><div class="wl-h">Daily ladder <span>#' + (S.today + 1) + (streak ? ' · streak ' + streak : '') + '</span></div><div class="wl-days">' + LENS.map(dailyRow).join('') + '</div></div>';
    h += '<div class="wl-sec"><div class="wl-h">Letters</div>' + seg('len', LENS, sv.len, ['3 letters', '4 letters', '5 letters']) + '</div>';
    h += '<div class="wl-sec"><div class="wl-h">Practice &middot; 2 players <span>difficulty</span></div>' + seg('diff', DIFFS, sv.diff, ['Easy', 'Medium', 'Hard']) +
      '<div class="wl-btns">' +
      '<button type="button" class="wl-go" data-act="practice">' + (sv.games.practice[sv.len] ? 'Continue' : 'Practice') + '</button>' +
      '<button type="button" class="wl-go alt" data-act="duo">2 Players</button></div></div>';
    h += '<div class="wl-sec"><div class="wl-h">Race vs CPU <span>W ' + sv.race[sv.cpu].w + ' &middot; L ' + sv.race[sv.cpu].l + '</span></div>' + seg('cpu', DIFFS, sv.cpu, ['Easy', 'Medium', 'Hard']) +
      '<div class="wl-btns"><button type="button" class="wl-go" data-act="race">Race the CPU</button></div></div>';
    h += '<div class="wl-foot"><button type="button" class="wl-lnk" data-act="stats">Stats</button><button type="button" class="wl-lnk" data-act="help">How to play</button></div>';
    return h + '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>tap the keys</b> &nbsp;to spell the next rung, <b>ENTER</b> to climb</div><div><b>&#9003;</b> on an empty rung &nbsp;takes the last rung back</div>' :
      '<div><b>type</b> the next word, <b>Enter</b> to climb</div><div><b>Backspace</b> on an empty rung &nbsp;takes the last rung back</div><div><b>?</b> &nbsp;hint &nbsp; <b>Esc</b> &nbsp;menu / pause</div>';
    return '<div class="wl-card wl-help">' +
      '<pre class="wl-art" aria-hidden="true">COLD\n C<u>O</u>RD\n C<u>A</u>RD\n <u>W</u>ARD\n WAR<u>M</u></pre>' +
      '<div class="wl-title">HOW TO PLAY</div>' +
      '<p>Climb from the <b>START</b> word to the <b>END</b> word. Each rung changes <b>exactly one letter</b> of the rung above and must be a <b>real word</b>.</p>' +
      '<div class="wl-keys">' + keys + '</div>' +
      '<p class="wl-tip"><b>Par</b> is the fewest moves the solver can do it in (the dotted rungs). Beat it with a rarer word for a <b>birdie</b>. The dots &#9679;&#9675; beside each rung count letters already in place.</p>' +
      '<p class="wl-tip"><b>Hint</b> fills in the next word of a shortest ladder from where you are (it costs a star). <b>Solution</b> gives up and shows one.</p>' +
      '<p class="wl-tip"><b>Daily</b>: one ladder per length a day, the same for everyone. <b>Race</b>: the CPU climbs a hidden ladder of its own &mdash; finish first (a hint gives it a ' + RACE_HINT + 's head start). <b>2 Players</b>: pass the device; same ladder, fewest moves wins (a hint counts as a move), ties go to the faster climber.</p>' +
      '<button type="button" class="wl-go" data-act="close-help">' + (S.g && !S.g.done && S.phase === 'play' ? 'Back to the ladder' : 'Got it') + '</button></div>';
  }
  function statsHtml() {
    var sv = S.save, rows = [];
    function line(a, b) { return esc(a) + new Array(Math.max(1, 28 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
    LENS.forEach(function (n) {
      var st = sv.stats[n];
      rows.push('<i>' + n + ' letters ' + new Array(19).join('-') + '</i>');
      rows.push(line('Solved', st.solved + ' / ' + st.played));
      if (st.solved) {
        rows.push(line('At or under par', Math.round(100 * st.atPar / st.solved) + '%'));
        rows.push(line('Avg over par', '+' + (st.overSum / st.solved).toFixed(1)));
        if (st.bestTime) rows.push(line('Fastest (no hints)', fmtTime(st.bestTime)));
        rows.push(line('Points', String(st.points)));
      }
    });
    rows.push('<i>' + new Array(29).join('-') + '</i>');
    rows.push(line('Daily streak', String(liveStreak(sv, S.today))));
    rows.push(line('Best streak', String(sv.daily.best)));
    DIFFS.forEach(function (d) { var r = sv.race[d]; rows.push(line('Race ' + CPU[d].name, r.w + 'W ' + r.l + 'L' + (r.best ? ' ' + fmtTime(r.best) : ''))); });
    rows.push(line('2-player games', String(sv.duo.games)));
    // par distribution across lengths
    var dist = [0, 0, 0, 0, 0];
    LENS.forEach(function (n) { for (var i = 0; i < 5; i++) dist[i] += sv.stats[n].dist[i]; });
    var mx = Math.max.apply(null, dist) || 1, labels = ['under', 'par', '+1', '+2', '+3..'];
    var bars = dist.map(function (v, i) {
      var w = Math.round(14 * v / mx);
      return '<div class="wl-dr"><span>' + labels[i] + '</span><code>' + new Array(w + 1).join('#') + (w ? '' : '·') + '</code><b>' + v + '</b></div>';
    }).join('');
    return '<div class="wl-card wl-stats"><div class="wl-title">STATS</div>' +
      '<pre class="wl-tab">' + rows.join('\n') + '</pre>' +
      '<div class="wl-h">Moves vs par</div><div class="wl-dist">' + bars + '</div>' +
      '<div class="wl-foot">' + (S.resetArm ?
        '<span class="wl-confirm">Erase all stats?</span><span><button type="button" class="wl-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="wl-lnk" data-act="reset-no">Keep</button></span>' :
        '<button type="button" class="wl-lnk" data-act="reset">Reset stats</button><button type="button" class="wl-lnk" data-act="home">Back</button>') + '</div></div>';
  }
  function ladderLine(rungs, sol) {
    return '<div class="wl-path">' + rungs.map(function (w, i) {
      var k = i ? diffAt(rungs[i - 1], w) : -1, s = '';
      for (var j = 0; j < w.length; j++) s += j === k ? '<u>' + esc(up(w.charAt(j))) + '</u>' : esc(up(w.charAt(j)));
      return '<span>' + s + '</span>';
    }).join(sol ? '<i>&rsaquo;</i>' : '<i>&rsaquo;</i>') + '</div>';
  }
  function starsHtml(k) { var s = ''; for (var i = 0; i < 3; i++) s += i < k ? '&#9733;' : '&#9734;'; return '<div class="wl-stars">' + s + '</div>'; }
  function resultHtml() {
    var g = S.g, R = S.res || {}, sc = score(g), h = '<div class="wl-card wl-res">';
    var sol = S.solution || solve(LEX[g.n], g.start, g.end);
    if (S.mode === 'race') {
      var won = R.won;
      h += '<div class="wl-title">' + (won ? 'YOU WIN' : R.forfeit ? 'FORFEIT' : 'CPU WINS') + '</div>';
      h += '<div class="wl-big' + (won ? '' : ' lose') + '">' + (won ? fmtTime(g.time) : R.forfeit ? 'flag down' : 'out-climbed') + '</div>';
      h += '<div class="wl-sub">' + (won ? 'beat the ' + CPU[S.race.level].name + ' CPU' + (R.cpuLeft ? ' with ' + R.cpuLeft + ' of its rungs to go' : '') :
        R.forfeit ? 'you left the race at ' + fmtTime(g.time) + ' &middot; ' + moves(g) + ' moves in' :
        'the ' + CPU[S.race.level].name + ' CPU reached ' + up(g.end) + ' at ' + fmtTime(S.race.plan.total) + ' &middot; you were ' + moves(g) + ' moves in') + '</div>';
    } else {
      h += '<div class="wl-title">' + (g.solved ? 'TOP OF THE LADDER' : 'SOLUTION') + '</div>';
      if (g.solved) h += starsHtml(sc.stars) + '<div class="wl-big">' + esc(sc.label) + '</div>';
      h += '<div class="wl-sub">' + (g.solved ? sc.moves + ' moves &middot; par ' + g.par + ' &middot; ' + fmtTime(g.time) + (g.hints ? ' &middot; ' + g.hints + ' hint' + (g.hints > 1 ? 's' : '') : '') : 'par ' + g.par + ' &mdash; one shortest ladder:') + '</div>';
      if (g.solved) h += '<div class="wl-pts">+' + sc.points + ' pts</div>';
    }
    if (g.solved) h += '<div class="wl-h">Your ladder</div>' + ladderLine(g.rungs);
    if (sol && (!g.solved || moves(g) > g.par || (S.mode === 'race' && !R.won))) h += '<div class="wl-h">' + (S.mode === 'race' && !R.won ? 'The CPU&rsquo;s ladder' : 'A shortest ladder') + '</div>' + ladderLine(sol, true);
    if (R.newBestTime) h += '<div class="wl-new">** new fastest ' + g.n + '-letter climb **</div>';
    if (S.mode === 'daily' && R.streak) h += '<div class="wl-new">daily streak ' + R.streak + '</div>';
    h += '<div class="wl-btns">';
    if (S.mode === 'daily') {
      var nextN = LENS.filter(function (n) { return !S.save.daily.done[S.today + ':' + n]; })[0];
      if (nextN) h += '<button type="button" class="wl-go" data-act="daily" data-n="' + nextN + '">Daily ' + nextN + 'L</button>';
      else h += '<button type="button" class="wl-go" data-act="practice-new">Practice</button>';
      h += '<button type="button" class="wl-go alt" data-act="copy">Copy result</button>';
    } else if (S.mode === 'race') h += '<button type="button" class="wl-go" data-act="race">Race again</button>';
    else h += '<button type="button" class="wl-go" data-act="practice-new">Next ladder</button>';
    h += '<button type="button" class="wl-go alt" data-act="home">Menu</button></div>';
    h += '<button type="button" class="wl-lnk" data-act="view">view the ladder</button>';
    return h + '</div>';
  }
  function passHtml() {
    var d = S.duo, n = d.turn, first = !d.res[1] && !d.res[2];
    return '<div class="wl-card wl-pass"><div class="wl-title">PLAYER ' + n + '</div>' +
      '<div class="wl-big p' + n + '">P' + n + '</div>' +
      '<div class="wl-sub">' + (first ? 'Same ladder for both of you. Player ' + (n === 1 ? 2 : 1) + ', look away.' : 'Pass to Player ' + n + ' &mdash; no peeking at the other ladder.') + '</div>' +
      '<pre class="wl-tab wl-c">' + up(S.duo.puz.start) + '  &rarr;  ' + up(S.duo.puz.end) + '\npar ' + S.duo.puz.par + '</pre>' +
      '<p class="wl-tip wl-c">Fewest moves wins (a hint counts as a move); a tie goes to the faster climber. The clock starts when you tap.</p>' +
      '<button type="button" class="wl-go" data-act="duo-go">Player ' + n + ' &mdash; tap when ready</button>' +
      '<div class="wl-note">Match: P1 ' + d.score[1] + ' &middot; P2 ' + d.score[2] + '</div></div>';
  }
  function duoResHtml() {
    var d = S.duo, a = d.res[1], b = d.res[2], w = compare(a, b);
    function col(r, n) {
      return '<div class="wl-pcol' + (w === n ? ' win' : '') + '"><div class="wl-h p' + n + '">Player ' + n + (w === n ? ' &#9733;' : '') + '</div>' +
        '<div class="wl-pstat">' + (r.solved ? '<b>' + r.moves + '</b> moves' + (r.hints ? ' +' + r.hints + 'h' : '') : '<b>gave up</b>') + ' &middot; ' + fmtTime(r.time) + '</div>' +
        (r.solved ? ladderLine(r.rungs) : '') + '</div>';
    }
    return '<div class="wl-card wl-res"><div class="wl-title">' + (w ? 'PLAYER ' + w + ' WINS' : 'A DRAW') + '</div>' +
      '<div class="wl-sub">' + up(d.puz.start) + ' &rarr; ' + up(d.puz.end) + ' &middot; par ' + d.puz.par + '</div>' +
      '<div class="wl-pcols">' + col(a, 1) + col(b, 2) + '</div>' +
      '<div class="wl-h">A shortest ladder</div>' + ladderLine(solve(LEX[d.puz.n], d.puz.start, d.puz.end) || [d.puz.start, d.puz.end], true) +
      '<div class="wl-note">Match: P1 ' + d.score[1] + ' &middot; P2 ' + d.score[2] + '</div>' +
      '<div class="wl-btns"><button type="button" class="wl-go" data-act="duo-next">Rematch</button><button type="button" class="wl-go alt" data-act="home">Menu</button></div></div>';
  }
  function pauseHtml() {
    return '<div class="wl-card wl-pause"><div class="wl-title">PAUSED</div><div class="wl-sub">' + (S.mode === 'race' ? 'The CPU waits too.' : 'The clock is stopped.') + '</div>' +
      '<div class="wl-btns"><button type="button" class="wl-go" data-act="resume">Resume</button><button type="button" class="wl-go alt" data-act="quit">' + (S.mode === 'race' ? 'Forfeit' : 'Give up') + '</button></div>' +
      '<div class="wl-note">' + (S.coarse ? 'The ladder is hidden while paused' : 'Space / Esc to resume') + '</div></div>';
  }
  function countHtml(k) {
    return '<div class="wl-card wl-count"><div class="wl-title">RACE</div><div class="wl-big">' + (k > 0 ? k : 'CLIMB!') + '</div>' +
      '<div class="wl-sub">' + up(S.race.puz.start) + ' &rarr; ' + up(S.race.puz.end) + ' &middot; par ' + S.race.puz.par + ' &middot; vs ' + CPU[S.race.level].name + ' CPU</div></div>';
  }
  function showCard(kind, arg) {
    if (!S) return;
    S.card = kind || null;
    var h = '';
    if (kind === 'home') h = homeHtml();
    else if (kind === 'help') h = helpHtml();
    else if (kind === 'stats') h = statsHtml();
    else if (kind === 'result') h = resultHtml();
    else if (kind === 'pass') h = passHtml();
    else if (kind === 'duores') h = duoResHtml();
    else if (kind === 'pause') h = pauseHtml();
    else if (kind === 'count') h = countHtml(arg);
    else if (kind === 'loading') h = '<div class="wl-card"><div class="wl-title">WORD LADDER</div><div class="wl-sub wl-loading">' + esc(arg || 'Loading words…') + '</div></div>';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.wrap.classList.toggle('carded', !!kind);
    S.wrap.classList.toggle('hide-play', kind === 'pause' || kind === 'pass' || (kind === 'home' && !S.g) || kind === 'loading');
    S.ovl.scrollTop = 0;
    syncHead();
  }

  // ---------------- game flow ----------------
  function setGame(mode, g) {
    S.mode = mode; S.g = g; S.cur = ''; S.hintWord = ''; S.solution = null; S.giveArm = false; S.res = null; S.newIdx = -1;
    S.phase = 'play'; S.paused = false;
    paintBar(); paintLadder(true); paintTools(); paintCpu(); msg('');
    showCard(null);
    persist();
    startLoop();
  }
  function startDaily(n) {
    var sv = S.save, g = null;
    var dg = sv.games.daily[n];
    if (dg && dg.day === S.today) g = dg;
    var done = sv.daily.done[S.today + ':' + n];
    if (!g) {
      var p = dailyPuzzle(LEX, n, S.today);
      if (!p) { msg('No daily ladder today', 'bad'); return; }
      g = newGame(p);
      if (done) {
        // replaying a finished daily: show its result card again
        S.mode = 'daily'; S.g = g; S.solution = solve(LEX[n], g.start, g.end);
        g.done = true; g.solved = false; g.revealed = true;
        if (done.ok) { g.rungs = S.solution.slice(); g.solved = true; g.revealed = false; }
        S.res = null; S.phase = 'over';
        paintBar(); paintLadder(true); paintTools(); paintCpu();
        showDoneDaily(done);
        return;
      }
    }
    setGame('daily', g);
  }
  function showDoneDaily(r) {
    var g = S.g;
    S.ovl.innerHTML = '<div class="wl-card wl-res"><div class="wl-title">DAILY #' + (S.today + 1) + ' &middot; ' + g.n + 'L</div>' +
      '<div class="wl-big">' + (r.ok ? (r.m < r.p ? 'Under par' : r.m === r.p ? 'Par' : '+' + (r.m - r.p)) : 'Revealed') + '</div>' +
      '<div class="wl-sub">' + (r.ok ? r.m + ' moves &middot; par ' + r.p + (r.h ? ' &middot; ' + r.h + ' hints' : '') + ' &middot; ' + fmtTime(r.t) : 'you looked at the solution') + '</div>' +
      '<div class="wl-h">A shortest ladder</div>' + ladderLine(S.solution, true) +
      '<div class="wl-note">Done for today &mdash; a new ladder at midnight.</div>' +
      '<div class="wl-btns"><button type="button" class="wl-go" data-act="copy">Copy result</button><button type="button" class="wl-go alt" data-act="home">Menu</button></div></div>';
    S.ovl.style.display = ''; S.card = 'result'; S.wrap.classList.add('carded'); S.wrap.classList.remove('hide-play');
    syncHead();
  }
  function startPractice(fresh) {
    var sv = S.save;
    if (!fresh) {
      var c = sv.games.practice[sv.len];
      if (c && !c.done) { setGame('practice', c); return; }
    }
    var p = genPuzzle(LEX, sv.len, sv.diff, Math.random);
    if (!p) { msg('Could not build a ladder', 'bad'); return; }
    setGame('practice', newGame(p));
  }
  function startRace() {
    var sv = S.save, p = genPuzzle(LEX, sv.len, 'medium', Math.random);
    if (!p) return;
    keepSolo();
    S.race = { puz: p, level: sv.cpu, plan: cpuPlan(LEX, p, sv.cpu, Math.random), t: 0, count: 3.2, bump: 0 };
    S.mode = 'race'; S.g = newGame(p); S.cur = ''; S.hintWord = ''; S.solution = null; S.giveArm = false; S.res = null;
    S.phase = 'count'; S.paused = false;
    paintBar(); paintLadder(true); paintTools(); paintCpu(); msg('');
    showCard('count', 3); sfx('tick', 1);
    startLoop();
  }
  function startDuo(keepScore) {
    var sv = S.save, p = genPuzzle(LEX, sv.len, sv.diff, Math.random);
    if (!p) return;
    keepSolo();
    var sc = keepScore && S.duo ? S.duo.score : { 1: 0, 2: 0 }, first = keepScore && S.duo ? (S.duo.first === 1 ? 2 : 1) : 1;
    S.duo = { puz: p, turn: first, first: first, res: {}, score: sc };
    S.mode = 'duo'; S.g = null; S.phase = 'pass'; S.race = null;
    S.bar.innerHTML = ''; S.ladder.innerHTML = ''; S.tools.innerHTML = ''; paintCpu();
    showCard('pass');
  }
  // Leaving a solo game: it stays in the save (one per mode) to be continued.
  function keepSolo() { if ((S.mode === 'daily' || S.mode === 'practice') && S.g) persist(); }
  function duoGo() {
    var d = S.duo;
    setGame('duo', newGame(d.puz));
  }
  function finish(won) {
    var g = S.g;
    S.phase = 'over'; S.paused = false; S.giveArm = false;
    if (!won) msg('');
    stopLoop();
    if (S.mode === 'daily' || S.mode === 'practice') {
      S.res = record(S.save, S.mode, g);
      persist();
      paintBar(); paintLadder(false); paintTools();
      if (g.solved) { sfx('win'); burst(S.ladder.querySelector('.wl-rung.end') || S.ladder, 26); Cade.haptic && Cade.haptic(12); }
      later(function () { if (S && S.g === g && S.phase === 'over') showCard('result'); }, g.solved ? 900 : 1300);
    } else if (S.mode === 'race') {
      var R = S.race, rec = S.save.race[R.level];
      var pr = cpuProgress(R.plan, R.t);
      S.res = { won: !!won, cpuLeft: pr.of - pr.rungs, forfeit: !won && !pr.done };
      if (won) { rec.w++; if (!rec.best || g.time < rec.best) rec.best = Math.round(g.time * 10) / 10; } else rec.l++;
      persist();
      paintBar(); paintLadder(false); paintTools(); paintCpu();
      if (won) { sfx('win'); burst(S.ladder.querySelector('.wl-rung.end') || S.ladder, 30); } else sfx('lose');
      later(function () { if (S && S.g === g && S.phase === 'over') showCard('result'); }, won ? 900 : 1500);
    } else if (S.mode === 'duo') {
      var d = S.duo;
      d.res[d.turn] = { solved: g.solved, moves: moves(g), hints: g.hints, time: g.time, rungs: g.rungs.slice() };
      paintBar(); paintLadder(false); paintTools();
      if (g.solved) { sfx('win'); burst(S.ladder.querySelector('.wl-rung.end') || S.ladder, 18); }
      later(function () {
        if (!S || S.duo !== d) return;
        if (d.res[1] && d.res[2]) {
          var w = compare(d.res[1], d.res[2]);
          if (w) d.score[w]++;
          S.save.duo.games++; persist();
          S.phase = 'over';
          showCard('duores');
          if (w) setTimeout(function () { if (S && S.card === 'duores') burst(S.ovl.querySelector('.wl-pcol.win') || S.ovl, 22); }, 120);
        } else {
          d.turn = d.turn === 1 ? 2 : 1; S.phase = 'pass'; S.g = null;
          S.bar.innerHTML = ''; S.ladder.innerHTML = ''; S.tools.innerHTML = '';
          showCard('pass');
        }
      }, g.solved ? 1000 : 1200);
    }
  }
  function later(fn, ms) { var t = setTimeout(function () { if (S) { S.timers.splice(S.timers.indexOf(t), 1); fn(); } }, ms); S.timers.push(t); }

  function canType() { return S && S.g && !S.g.done && S.phase === 'play' && !S.paused && !S.card; }
  function typeLetter(c) {
    if (!canType()) return;
    if (S.cur.length >= S.g.n) { shake(); return; }
    S.cur += c; S.hintWord = '';
    startLoop();   // a solo clock stopped while the window was away picks up again
    sfx('key');
    paintInput();
  }
  function backspace() {
    if (!canType()) return;
    if (S.cur.length) { S.cur = S.cur.slice(0, -1); S.hintWord = ''; paintInput(); return; }
    // an empty rung: take the last rung back to edit it
    var w = undo(S.g);
    if (w) { S.cur = w.slice(0, -1); sfx('undo'); afterChange(); }
  }
  function doUndo() {
    if (!canType()) return;
    var w = undo(S.g);
    if (w) { S.cur = ''; S.hintWord = ''; sfx('undo'); afterChange(); msg('Took back ' + up(w)); }
  }
  function afterChange() { S.giveArm = false; paintBar(); paintLadder(true); paintTools(); paintCpu(); persist(); }
  function submit() {
    if (!canType()) return;
    startLoop();
    var g = S.g, w = S.cur;
    var r = climb(LEX, g, w);
    if (!r.ok) {
      msg(ERR[r.err] ? ERR[r.err](g.n) : 'Try another word', 'bad');
      shake(); sfx('bad'); Cade.haptic && Cade.haptic(20);
      return;
    }
    S.cur = ''; S.hintWord = ''; S.giveArm = false;
    S.newIdx = r.finished ? g.rungs.length - 1 : g.rungs.length - 1;
    if (r.finished && r.auto) S.newIdx = g.rungs.length - 1;
    sfx('rung', moves(g));
    var m = matches(r.word, g.end);
    if (!r.finished) msg(m === g.n - 1 ? 'One letter to go!' : m > matches(g.rungs[g.rungs.length - 2], g.end) ? 'Closer' : '', 'good', 900);
    paintBar(); paintLadder(true); paintTools(); paintCpu();
    var nr = S.ladder.querySelector('.wl-rung.pop');
    if (nr && !r.finished) burst(nr, 6, '+.*');
    if (r.finished) {
      msg(r.auto ? up(r.word) + ' → ' + up(g.end) + '!' : 'Made it!', 'good', 1800);
      finish(true);
    } else persist();
  }
  function doHint() {
    if (!canType()) return;
    var h = hint(LEX, S.g);
    if (!h) return;
    if (h.back) { msg('Dead end — undo a rung or two', 'bad', 2200); sfx('bad'); return; }
    S.g.hints++; S.cur = h.word; S.hintWord = h.word; S.giveArm = false;
    sfx('hint');
    // racing: a hint isn't free — the CPU climbs on for a few seconds while you peek
    if (S.mode === 'race' && S.race) { S.race.t += RACE_HINT; paintCpu(); }
    msg('Hint: ' + up(h.word) + ' — ' + (S.mode === 'race' ? 'the CPU gains ' + RACE_HINT + 's' : h.left + ' move' + (h.left > 1 ? 's' : '') + ' left from here'), 'good', 2400);
    paintBar(); paintInput(); paintTools(); persist();
  }
  function giveUp() {
    if (!S || !S.g || S.g.done) return;
    if (!S.giveArm) { S.giveArm = true; paintTools(); msg(S.mode === 'race' ? 'Tap again to forfeit' : 'Tap again to see a solution', '', 2000); return; }
    S.solution = reveal(LEX, S.g);
    S.cur = '';
    finish(false);
  }

  // ---- the loop (only while a timed ladder is on screen) ----
  function running() {
    return !!S && !!S.g && !S.g.done && (S.phase === 'play' || S.phase === 'count') && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function startLoop() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!running()) return;
    var dt = S.last ? Math.min(0.25, (ts - S.last) / 1000) : 0;
    S.last = ts;
    if (S.phase === 'count') {
      var before = Math.ceil(S.race.count);
      S.race.count -= dt;
      var k = Math.ceil(S.race.count);
      if (k !== before) {
        if (k > 0) { showCard('count', k); sfx('tick', 1); }
        else { sfx('tick', 0); S.phase = 'play'; showCard(null); paintTools(); }
      }
    } else {
      S.g.time += dt;
      if (Math.floor(S.g.time) !== S.shownSec && S.clockEl) { S.shownSec = Math.floor(S.g.time); S.clockEl.textContent = fmtTime(S.g.time); if (S.shownSec % 5 === 0) persistSoon(); }
      if (S.mode === 'race') {
        var R = S.race;
        R.t += dt;
        if (R.bump > 0) R.bump -= dt;
        var pr = cpuProgress(R.plan, R.t);
        if (pr.rungs !== S.cpuShown) {
          R.bump = 0.35; sfx('cpu'); paintCpu();
          if (pr.of - pr.rungs === 1) msg('The CPU is one rung away!', 'bad', 1600);
        }
        if (pr.done) { S.solution = R.plan.path; S.g.done = true; S.g.solved = false; finish(false); return; }
      }
    }
    S.raf = requestAnimationFrame(frame);
  }
  function persistSoon() { if (S.mode === 'daily' || S.mode === 'practice') persist(); }
  function pause() {
    if (!S || !S.g || S.g.done || S.paused || (S.phase !== 'play' && S.phase !== 'count')) return;
    if (S.mode === 'race' || S.mode === 'duo') { S.paused = true; stopLoop(); showCard('pause'); }
    else { stopLoop(); persist(); }   // solo: the clock just stops while away
    syncHead();
  }
  function resume() {
    if (!S) return;
    if (S.paused) {
      S.paused = false;
      if (S.phase === 'count') showCard('count', Math.max(1, Math.ceil(S.race.count))); else showCard(null);
    }
    startLoop(); syncHead();
  }
  function toHome() {
    if (!S) return;
    stopLoop();
    if (S.g && !S.g.done && (S.mode === 'race' || S.mode === 'duo') && S.phase !== 'over') {
      // leaving a race / duel counts as a forfeit for the race
      if (S.mode === 'race' && S.phase === 'play') { S.save.race[S.race.level].l++; }
      S.g = null;
    }
    if (S.mode === 'duo' && S.phase === 'pass') S.g = null;
    if (S.g && S.g.done) S.g = null;
    if (S.mode === 'race' || S.mode === 'duo') { S.g = null; S.race = null; }
    persist();
    S.phase = 'home'; S.paused = false; S.resetArm = false;
    if (S.g) { paintBar(); paintLadder(true); paintTools(); } else { S.bar.innerHTML = ''; S.ladder.innerHTML = ''; S.tools.innerHTML = ''; }
    paintCpu();
    showCard('home');
  }
  function copyResult() {
    var g = S.g, r = S.save.daily.done[S.today + ':' + g.n];
    var sc = score(g);
    var lines = ['Word Ladder #' + (S.today + 1) + ' (' + g.n + ' letters)', up(g.start) + ' → ' + up(g.end)];
    if (r) lines.push(r.ok ? r.m + '/' + r.p + ' moves' + (r.h ? ' · ' + r.h + ' hint' + (r.h > 1 ? 's' : '') : '') + ' · ' + fmtTime(r.t) : 'revealed');
    else lines.push(sc.moves + '/' + g.par);
    if (r && r.ok) {
      var b = '', d = r.m - r.p;
      for (var i = 0; i < r.m; i++) b += i < r.p ? '🟩' : '🟨';
      if (d < 0) b += '⭐';
      lines.push(b);
    }
    var txt = lines.join('\n');
    try {
      navigator.clipboard.writeText(txt).then(function () { Cade.showToast && Cade.showToast('Result copied', 'info', 1400); }, function () { Cade.showToast && Cade.showToast(txt, 'info', 3000); });
    } catch (e) { Cade.showToast && Cade.showToast(txt, 'info', 3000); }
  }

  // ---------------- input ----------------
  function onKey(e) {
    if (!S || !S.active) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var k = e.key;
    if (k === 'Escape') {
      if (S.card === 'help' || S.card === 'stats') { if (S.g && !S.g.done && S.phase === 'play') showCard(null); else showCard('home'); }
      else if (S.paused) resume();
      else if (S.g && !S.g.done && S.phase === 'play' && (S.mode === 'race' || S.mode === 'duo')) pause();
      else if (S.phase === 'home') closePanel();
      else toHome();
    } else if (S.paused && (k === ' ' || k === 'Enter')) resume();
    else if (S.card && (k === 'Enter' || k === ' ')) {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;   // a focused button does its own job
      var b = S.ovl.querySelector('.wl-go');
      if (b) b.click(); else return;
    } else if (canType()) {
      if (k === 'Enter') submit();
      else if (k === 'Backspace') backspace();
      else if (k === '?' || k === '/') doHint();
      else if (k.length === 1 && /[a-z]/i.test(k)) typeLetter(k.toLowerCase());
      else return;
    } else if (S.card === 'help' && k.length === 1) { showCard(S.g && !S.g.done && S.phase === 'play' ? null : 'home'); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  // A press inside the panel arms keyboard capture; one elsewhere hands it back.
  function setActive(on) {
    if (!S || on === S.active) return;
    S.active = on;
    S.panel.classList.toggle('wl-idle', !on);
    if (on) blurEditor();
  }
  function onDocPointer(e) { if (S) setActive(S.panel.contains(e.target)); }
  function onDocFocus(e) {
    if (!S || S.panel.contains(e.target)) return;
    if (Date.now() - S.openedAt < 600) { blurEditor(); return; }
    setActive(false);
  }
  function blurEditor() { try { if (Cade.editor && Cade.editor.hasFocus) Cade.editor.contentDOM.blur(); } catch (e) {} }

  function onClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S.panel.contains(b) || b.disabled) return;
    S.snd.ensure();
    var key = b.getAttribute('data-key');
    if (key) {
      if (key === 'Enter') submit(); else if (key === 'Backspace') backspace(); else typeLetter(key);
      return;
    }
    var set = b.getAttribute('data-set');
    if (set) {
      var v = b.getAttribute('data-v');
      if (set === 'len') S.save.len = +v; else if (set === 'diff') S.save.diff = v; else if (set === 'cpu') S.save.cpu = v;
      persist(); sfx('key'); showCard('home');
      var nb = e.detail === 0 && S.ovl.querySelector('[data-set="' + set + '"][data-v="' + v + '"]');
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      return;
    }
    var act = b.getAttribute('data-act');
    if (!act) return;
    if (!LEX && act !== 'help' && act !== 'close-help') return;
    switch (act) {
      case 'daily': keepSolo(); startDaily(+b.getAttribute('data-n') || S.save.len); break;
      case 'practice': startPractice(false); break;
      case 'practice-new': startPractice(true); break;
      case 'race': startRace(); break;
      case 'duo': startDuo(false); break;
      case 'duo-go': duoGo(); break;
      case 'duo-next': startDuo(true); break;
      case 'stats': S.resetArm = false; showCard('stats'); break;
      case 'help': showCard('help'); break;
      case 'close-help': if (S.g && !S.g.done && S.phase === 'play') showCard(null); else if (S.phase === 'home' || !S.g) showCard('home'); else showCard(null); break;
      case 'home': toHome(); break;
      case 'reset': S.resetArm = true; showCard('stats'); break;
      case 'reset-no': S.resetArm = false; showCard('stats'); break;
      case 'reset-yes': {
        var keep = S.save, ns = newSave();
        ns.len = keep.len; ns.diff = keep.diff; ns.cpu = keep.cpu; ns.seen = true; ns.games = keep.games;
        S.save = ns; S.resetArm = false; persist(); showCard('stats');
        Cade.showToast && Cade.showToast('Stats reset', 'info', 1600);
        break;
      }
      case 'undo': doUndo(); break;
      case 'hint': doHint(); break;
      case 'give': giveUp(); break;
      case 'result': if (S.mode === 'duo') return; if (S.mode === 'daily' && !S.res) showDoneDaily(S.save.daily.done[S.today + ':' + S.g.n] || { ok: S.g.solved, m: moves(S.g), p: S.g.par, h: S.g.hints, t: S.g.time }); else showCard('result'); break;
      case 'view': showCard(null); break;
      case 'copy': copyResult(); break;
      case 'resume': resume(); break;
      case 'quit': S.paused = false; showCard(null); S.giveArm = true; giveUp(); break;
    }
    try { if (e.detail !== 0) b.blur(); } catch (er) {}
  }

  // ---- layout: on a phone (or a full-page panel) the game fills the visible height ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var solo = S.panel.classList.contains('cade-solo-panel'), top = S.wrap.getBoundingClientRect().top;
    if (vw <= 560 || solo) {
      var h = Math.floor(vh - Math.max(0, top) - (vw <= 560 ? 14 : 24));
      S.wrap.style.height = clamp(h, 440, solo && vw > 560 ? 760 : 2000) + 'px';
      S.wrap.classList.add('fill');
    } else { S.wrap.style.height = ''; S.wrap.classList.remove('fill'); }
  }

  // ---------------- open / close ----------------
  function teardown() {
    if (!S) return;
    var s = S;
    if (s.mode === 'race' && s.race && s.g && !s.g.done && s.phase === 'play') s.save.race[s.race.level].l++;   // walking out of a race forfeits it
    persist();
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.msgT);
    s.timers.forEach(clearTimeout);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('pointerdown', s.onDocPointer, true);
    document.removeEventListener('focusin', s.onDocFocus, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('focus', s.onFocus);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="wl"><div class="wl-bar"></div><div class="wl-cpu" style="display:none"></div>' +
      '<div class="wl-ladder" role="list" aria-label="Your ladder"></div><div class="wl-msg" aria-live="polite"></div>' +
      '<div class="wl-tools"></div><div class="wl-kb" aria-label="Keyboard"></div>' +
      '<div class="wl-ovl" style="display:none"></div><div class="wl-fx" aria-hidden="true"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🪜 Word Ladder', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'wl-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="Menu" aria-label="Menu">' + IC_HOME + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia;
    S = {
      panel: p, head: hb, wrap: p.querySelector('.wl'), bar: p.querySelector('.wl-bar'), cpuEl: p.querySelector('.wl-cpu'),
      ladder: p.querySelector('.wl-ladder'), msgEl: p.querySelector('.wl-msg'), tools: p.querySelector('.wl-tools'), kb: p.querySelector('.wl-kb'),
      ovl: p.querySelector('.wl-ovl'), fx: p.querySelector('.wl-fx'),
      save: loadSave(), snd: new Snd(sget(SOUND_KEY) === '1'), today: dayNumber(),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: '', g: null, cur: '', hintWord: '', solution: null, res: null, race: null, duo: null,
      phase: 'home', paused: false, card: null, raf: 0, last: 0, timers: [], msgT: 0, giveArm: false, resetArm: false,
      active: true, openedAt: Date.now(), newIdx: -1, cpuShown: 0, shownSec: -1, clockEl: null
    };
    p._onClose = teardown;
    paintKb(); syncHead();
    blurEditor();

    S.onKey = onKey; S.onDocPointer = onDocPointer; S.onDocFocus = onDocFocus;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('pointerdown', S.onDocPointer, true);
    document.addEventListener('focusin', S.onDocFocus, true);
    S.onVis = function () { if (document.hidden) pause(); else startLoop(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    // solo ladders just stop the clock while away; it restarts on return (race / duel wait for Resume)
    S.onFocus = function () { startLoop(); };
    window.addEventListener('focus', S.onFocus);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { pause(); stopLoop(); } });
    p.addEventListener('cade-panel-restore', function () { if (S && S.panel === p) { layout(); if (!S.paused) startLoop(); } });
    p.addEventListener('click', onClick);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    layout();
    requestAnimationFrame(function () { if (S && S.panel === p) layout(); });
    // Keys / buttons must not take focus or start a selection on fast taps.
    p.addEventListener('mousedown', function (e) { if (!(e.target.closest && e.target.closest('.cade-panel-head'))) e.preventDefault(); });

    // header: home / help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      e.stopPropagation();
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.card === 'help') { if (S.g && !S.g.done && S.phase === 'play') showCard(null); else showCard('home'); }
        else { if (S.mode === 'race' || S.mode === 'duo') pause(); if (!S.paused) showCard('help'); }
      } else if (h === 'home') toHome();
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout. CSS
    // does most of it; the keyboard and ladder also cancel their touches
    // (taps still click via pointer events) and the panel swallows gestures.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.kb.addEventListener('touchstart', function (e) {
      var b = e.target.closest ? e.target.closest('[data-key]') : null;
      if (!b) return;
      noTouch(e);
      S.snd.ensure();
      setActive(true);
      b.classList.add('down');
      var k = b.getAttribute('data-key');
      if (k === 'Enter') submit(); else if (k === 'Backspace') backspace(); else typeLetter(k);
    }, { passive: false });
    S.kb.addEventListener('touchend', function (e) {
      noTouch(e);
      var ds = S && S.kb.querySelectorAll('.down');
      if (ds) for (var i = 0; i < ds.length; i++) ds[i].classList.remove('down');
    }, { passive: false });
    S.kb.addEventListener('touchmove', noTouch, { passive: false });
    S.ladder.addEventListener('touchend', function (e) { if (e.touches && e.touches.length) noTouch(e); }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    p.addEventListener('contextmenu', function (e) { if (!(e.target.closest && e.target.closest('.cade-panel-head'))) e.preventDefault(); });

    showCard('loading');
    loadWords().then(function () {
      if (!S || S.panel !== p) return;
      var sv = S.save;
      if (!sv.seen) { sv.seen = true; persist(); S.phase = 'home'; showCard('home'); showCard('help'); return; }
      toHome();
    }, function () {
      if (!S || S.panel !== p) return;
      showCard('loading', 'Couldn’t load the word list' + (navigator.onLine ? '' : ' — it needs one online load to cache'));
    });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Change one letter at a time to climb from one word to another — daily par, hints, solver',
    icon: '🪜',
    tags: 'game,puzzle,word,ladder,doublets,daily,word game,race,vs cpu,2 player,pass and play',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
