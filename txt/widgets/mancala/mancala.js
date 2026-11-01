/* Mancala — the seed-sowing game, for Cade.txt.
 * Kalah rules: two rows of six pits (3-6 seeds each, 4 by default) and a store
 * at each end. Pick up every seed in one of your pits and sow them one by one
 * counter-clockwise, into your own store but never your opponent's. End in your
 * store and you move again; end in an empty pit on your side and you capture it
 * together with the pit opposite. When one row runs dry the game ends and each
 * player sweeps the seeds left on their side into their store. Most seeds wins.
 * Oware (abapa) rules: no sowing into the stores, a lap of 12+ skips the pit it
 * came from; end on the other side making 2 or 3 and you capture that pit and
 * the unbroken run of 2s and 3s before it (but never all of their seeds — a
 * grand slam captures nothing); you must leave your opponent something to play.
 * More than half the seeds wins.
 * Play vs the computer (six levels: an alpha-beta minimax with iterative
 * deepening and a transposition table, run in a Web Worker built from this very
 * file so the board never freezes) or pass-and-play on one device (the board
 * can turn to face whoever is moving). Seed-by-seed sowing animation (tap to
 * skip), landing preview on hover, hints, undo, a move list you can step back
 * through, autosave / resume, records.
 * The board is DOM (monospace glyph seeds, theme colours); saves live in
 * Cade.store under cade-mancala-*. Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // The board is 14 numbers. Side 0 (South) owns pits 0..5 (sown left to right)
  // and its store is 6; side 1 (North) owns pits 7..12 and its store is 13.
  // Sowing runs 0 → 13 and wraps: counter-clockwise seen from South. The pit
  // opposite pit i is 12 - i.
  var STORE = [6, 13], WIN = 10000, QUIET_MAX = 100, LETTERS = 'ABCDEF';
  var RULES = {
    kalah: { id: 'kalah', name: 'Kalah', info: 'Sow into your own store, skip theirs. End in your store: go again. End in an empty pit of yours: capture it and the pit opposite' },
    oware: { id: 'oware', name: 'Oware', info: 'Stores are only for captures. End on their side making 2 or 3 to capture it (and the 2s and 3s just before). Never leave them with nothing to play' }
  };
  var LEVELS = [
    { id: 1, name: 'Seedling', depth: 1, margin: 4, rand: 0.3 },
    { id: 2, name: 'Sprout', depth: 2, margin: 1.5, rand: 0.1 },
    { id: 3, name: 'Gardener', depth: 4, margin: 0.6, rand: 0 },
    { id: 4, name: 'Farmer', depth: 7, margin: 0.2, rand: 0 },
    { id: 5, name: 'Elder', depth: 12, margin: 0, rand: 0, time: 700 },
    { id: 6, name: 'Sage', depth: 40, margin: 0, rand: 0, time: 1500 }
  ];
  var HINT = { depth: 40, margin: 0, rand: 0, time: 900 };

  function ruleId(r) { return r === 'oware' ? 'oware' : 'kalah'; }
  function clampSeeds(n) { n = Math.round(+n); return isFinite(n) ? Math.max(3, Math.min(6, n)) : 4; }
  function levelOf(n) { n = Math.round(+n); if (!isFinite(n)) n = 3; return LEVELS[Math.max(1, Math.min(6, n)) - 1]; }
  function rowOf(i) { return i >= 0 && i <= 5 ? 0 : i >= 7 && i <= 12 ? 1 : -1; }
  function newBoard(n) { var b = []; for (var i = 0; i < 14; i++) b.push(i === 6 || i === 13 ? 0 : n); return b; }
  function sideSum(b, s) { var o = s * 7; return b[o] + b[o + 1] + b[o + 2] + b[o + 3] + b[o + 4] + b[o + 5]; }
  function total(b) { var t = 0; for (var i = 0; i < 14; i++) t += b[i]; return t; }
  function label(pit) { return LETTERS.charAt(pit % 7); }

  // Pits the side may sow from. Oware: when the other row is empty you must feed it.
  function legalMoves(b, side, rules) {
    var o = side * 7, out = [], k;
    for (k = 0; k < 6; k++) if (b[o + k] > 0) out.push(o + k);
    if (rules === 'oware' && sideSum(b, 1 - side) === 0) {
      var feed = [];
      for (k = 0; k < out.length; k++) if (b[out[k]] > 5 - (out[k] - o)) feed.push(out[k]);
      return feed;
    }
    return out;
  }
  // Each side takes the seeds left in its own row.
  function sweep(b, ev) {
    for (var s = 0; s < 2; s++) {
      var o = s * 7, n = 0, got = [];
      for (var k = 0; k < 6; k++) if (b[o + k]) { got.push(o + k); n += b[o + k]; b[STORE[s]] += b[o + k]; b[o + k] = 0; }
      if (ev && n) ev.push({ t: 'sweep', side: s, pits: got, n: n, store: STORE[s] });
    }
  }
  // Sow from `pit` (mutates b). ev, when given, collects the animation steps.
  // → { pit, n, last, extra, cap, capPits, next, over, slam }
  function step(b, rules, side, pit, ev) {
    var n = b[pit], seeds = n, ms = STORE[side], os = STORE[1 - side], i = pit, cap = 0, capPits = null, extra = false, slam = false, ow = rules === 'oware';
    b[pit] = 0;
    if (ev) ev.push({ t: 'pick', pit: pit, n: n });
    while (n > 0) {
      i = (i + 1) % 14;
      if (i === os || (ow && (i === ms || i === pit))) continue;
      b[i]++; n--;
      if (ev) ev.push({ t: 'drop', pit: i });
    }
    if (ow) {
      if (rowOf(i) === 1 - side && (b[i] === 2 || b[i] === 3)) {
        var lo = (1 - side) * 7, j = i, got = [], s = 0;
        while (j >= lo && (b[j] === 2 || b[j] === 3)) { got.push(j); s += b[j]; j--; }
        if (s < sideSum(b, 1 - side)) {
          for (var q = 0; q < got.length; q++) { b[ms] += b[got[q]]; b[got[q]] = 0; }
          cap = s; capPits = got;
          if (ev) ev.push({ t: 'cap', pits: got, n: s, store: ms });
        } else { slam = true; if (ev) ev.push({ t: 'slam', pits: got }); }
      }
    } else if (i === ms) {
      extra = true;
      if (ev) ev.push({ t: 'extra', side: side });
    } else if (rowOf(i) === side && b[i] === 1 && b[12 - i] > 0) {
      cap = b[12 - i] + 1; capPits = [12 - i, i];
      b[ms] += cap; b[i] = 0; b[12 - i] = 0;
      if (ev) ev.push({ t: 'cap', pits: capPits, n: cap, store: ms });
    }
    var next = extra ? side : 1 - side, over;
    if (ow) over = b[ms] * 2 > total(b) || legalMoves(b, next, rules).length === 0;
    else over = sideSum(b, 0) === 0 || sideSum(b, 1) === 0;
    if (over) sweep(b, ev);
    return { pit: pit, n: seeds, last: i, extra: extra, cap: cap, capPits: capPits, next: next, over: over, slam: slam };
  }
  // Where a move would end, without playing it (the hover preview).
  function preview(b, rules, side, pit) {
    var c = b.slice(), info = step(c, rules, side, pit, null);
    info.after = c;
    return info;
  }

  // ---- a game ----
  function newGame(rules, seeds) {
    var r = ruleId(rules), n = clampSeeds(seeds);
    return { r: r, n: n, b: newBoard(n), side: 0, moves: [], result: null, quiet: 0 };
  }
  function outcomeOf(b) {
    var d = b[6] - b[13];
    return d > 0 ? 0 : d < 0 ? 1 : -1;
  }
  function legal(g) { return g.result ? [] : legalMoves(g.b, g.side, g.r); }
  function notation(rec) { return label(rec.pit) + (rec.extra ? '+' : '') + (rec.cap ? 'x' + rec.cap : ''); }
  // Play a pit; → the move record (with its animation events), or null if illegal.
  function play(g, pit) {
    pit = pit | 0;
    if (g.result || legal(g).indexOf(pit) < 0) return null;
    var ev = [], side = g.side, info = step(g.b, g.r, side, pit, ev);
    var rec = { pit: pit, side: side, n: info.n, cap: info.cap, extra: info.extra, slam: info.slam, last: info.last, ev: ev };
    g.moves.push(rec);
    g.quiet = info.cap ? 0 : g.quiet + 1;
    g.side = info.next;
    if (info.over) g.result = { winner: outcomeOf(g.b), reason: 'end' };
    else if (g.r === 'oware' && g.quiet >= QUIET_MAX) {
      // seeds chasing each other round the board: each side keeps its own row
      sweep(g.b, ev);
      g.result = { winner: outcomeOf(g.b), reason: 'stall' };
    }
    rec.over = !!g.result;
    return rec;
  }
  function replay(rules, seeds, pits) {
    var g = newGame(rules, seeds);
    for (var i = 0; i < pits.length; i++) if (!play(g, pits[i])) return null;
    return g;
  }
  function boardAt(g, ply) {
    var h = replay(g.r, g.n, g.moves.slice(0, ply).map(function (m) { return m.pit; }));
    return h ? h.b : g.b.slice();
  }
  function undo(g) {
    if (!g.moves.length) return false;
    var pits = g.moves.map(function (m) { return m.pit; });
    pits.pop();
    var h = replay(g.r, g.n, pits);
    if (!h) return false;
    g.b = h.b; g.side = h.side; g.moves = h.moves; g.quiet = h.quiet; g.result = null;
    return true;
  }
  function endGame(g, winner, reason) { if (!g.result) g.result = { winner: winner, reason: reason }; return g.result; }

  // ---- the computer: negamax alpha-beta, iterative deepening, transposition table ----
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function evaluate(b, side, rules) {
    var me = STORE[side], op = STORE[1 - side], d = b[me] - b[op];
    // Kalah: seeds on your side are likely (not surely) yours at the sweep
    if (rules === 'kalah') d += 0.25 * (sideSum(b, side) - sideSum(b, 1 - side));
    else {
      // Oware: mobility and pits ripe for capture
      var o = (1 - side) * 7, so = side * 7, k;
      for (k = 0; k < 6; k++) {
        if (b[o + k] === 1 || b[o + k] === 2) d += 0.15;
        if (b[so + k] === 1 || b[so + k] === 2) d -= 0.15;
      }
    }
    return d;
  }
  function finalScore(b, side, ply) {
    var d = b[STORE[side]] - b[STORE[1 - side]];
    return d > 0 ? WIN - ply + d : d < 0 ? -WIN + ply + d : 0;
  }
  var ABORT = { abort: true };
  function search(pos, opts) {
    opts = opts || {};
    var rules = pos.r, tot = total(pos.b), maxD = opts.depth || 6, now = opts.now || function () { return Date.now(); };
    var t0 = now(), deadline = opts.time ? t0 + opts.time : Infinity, nodes = 0, tt = new Map(), r = rng(opts.seed || 1);
    var root = legalMoves(pos.b, pos.side, rules);
    if (!root.length) return { pit: -1, score: 0, depth: 0, nodes: 0, scores: [] };
    function order(b, side, moves, ttm) {
      var ms = STORE[side], sc = [];
      for (var i = 0; i < moves.length; i++) {
        var p = moves[i], n = b[p], o = 0;
        if (p === ttm) o = 1000;
        else if (rules === 'kalah') {
          var dist = ms - p;
          if (n === dist) o = 500;                                  // lands in the store: another turn
          else if (n < dist && b[p + n] === 0 && b[12 - p - n] > 0) o = 200 + b[12 - p - n];   // a capture
          else if (n === 13) o = 150 + b[12 - p];                   // a full lap that captures back home
        } else {
          var c = preview(b, rules, side, p);
          o = c.cap * 10;
        }
        sc.push({ p: p, o: o + p * 0.1 });
      }
      sc.sort(function (x, y) { return y.o - x.o; });
      return sc.map(function (x) { return x.p; });
    }
    function negamax(b, side, depth, alpha, beta, ply) {
      if ((++nodes & 1023) === 0 && now() > deadline) throw ABORT;
      var ms = b[STORE[side]], os = b[STORE[1 - side]];
      if (ms * 2 > tot) return WIN - ply + (ms - os);
      if (os * 2 > tot) return -WIN + ply + (ms - os);
      if (depth <= 0) return evaluate(b, side, rules);
      var moves = legalMoves(b, side, rules);
      if (!moves.length) { var c0 = b.slice(); sweep(c0); return finalScore(c0, side, ply); }
      var key = b.join(',') + (side ? 'n' : 's'), e = tt.get(key), ttm = -1, a0 = alpha;
      if (e) {
        ttm = e.m;
        if (e.d >= depth) {
          if (e.f === 0) return e.s;
          if (e.f === 1 && e.s >= beta) return e.s;
          if (e.f === -1 && e.s <= alpha) return e.s;
        }
      }
      moves = order(b, side, moves, ttm);
      var best = -Infinity, bm = moves[0];
      for (var i = 0; i < moves.length; i++) {
        var c = b.slice(), info = step(c, rules, side, moves[i], null), s;
        if (info.over) s = finalScore(c, side, ply + 1);
        else if (info.next === side) s = negamax(c, side, depth - 1, alpha, beta, ply + 1);
        else s = -negamax(c, 1 - side, depth - 1, -beta, -alpha, ply + 1);
        if (s > best) { best = s; bm = moves[i]; }
        if (s > alpha) alpha = s;
        if (alpha >= beta) break;
      }
      if (tt.size < 400000) tt.set(key, { d: depth, s: best, f: best <= a0 ? -1 : best >= beta ? 1 : 0, m: bm });
      return best;
    }
    function rootScores(depth, margin) {
      var out = [], alpha = -Infinity, rm = order(pos.b, pos.side, root, lastBest);
      for (var i = 0; i < rm.length; i++) {
        var c = pos.b.slice(), info = step(c, rules, pos.side, rm[i], null), s;
        // with a margin every root move needs a true score; without, alpha-beta at the root too
        var lo = margin > 0 ? -Infinity : alpha;
        if (info.over) s = finalScore(c, pos.side, 1);
        else if (info.next === pos.side) s = negamax(c, pos.side, depth - 1, lo, Infinity, 1);
        else s = -negamax(c, 1 - pos.side, depth - 1, -Infinity, -lo, 1);
        // a score at or under the window is only an upper bound: never a candidate
        out.push({ pit: rm[i], s: s, x: lo === -Infinity || s > lo || !!info.over });
        if (s > alpha) alpha = s;
      }
      return out;
    }
    var done = null, doneD = 0, lastBest = -1, margin = opts.margin || 0;
    for (var d = 1; d <= maxD; d++) {
      try {
        var sc = rootScores(d, margin);
        done = sc; doneD = d;
        var top = -Infinity;
        sc.forEach(function (x) { if (x.s > top) { top = x.s; lastBest = x.pit; } });
        if (Math.abs(top) > WIN - 500) break;      // the game is decided within the horizon
        if (root.length === 1) break;
      } catch (err) {
        if (err !== ABORT) throw err;
        break;
      }
    }
    if (!done) done = root.map(function (p) { return { pit: p, s: 0, x: true }; });
    var best = -Infinity;
    done.forEach(function (x) { if (x.s > best) best = x.s; });
    var pool = done.filter(function (x) { return x.x && x.s >= best - margin && (best < WIN - 500 || x.s > WIN - 500); });
    pool.sort(function (x, y) { return x.pit - y.pit; });
    var pick = pool[Math.floor(r() * pool.length)] || done[0];
    if (opts.rand && r() < opts.rand) pick = done[Math.floor(r() * done.length)];
    return { pit: pick.pit, score: pick.s, best: best, depth: doneD, nodes: nodes, time: now() - t0, scores: done };
  }
  function levelSearchOpts(level, seed) {
    var L = levelOf(level);
    return { depth: L.depth, margin: L.margin, rand: L.rand, time: L.time, seed: seed };
  }
  // Worker / local request: { id, r, n, pits, level, seed, hint, timeCap } → { id, pit, score, depth, nodes }
  function handle(msg) {
    var g = replay(msg.r, msg.n, (msg.pits || []).map(function (x) { return x | 0; }));
    if (!g || g.result) return { id: msg.id, pit: -1 };
    var o = msg.hint ? { depth: HINT.depth, margin: 0, rand: 0, time: HINT.time, seed: msg.seed } : levelSearchOpts(msg.level, msg.seed);
    if (msg.timeCap) o.time = Math.min(o.time || msg.timeCap, msg.timeCap);
    var res = search(g, o);
    return { id: msg.id, pit: res.pit, score: res.score, best: res.best, depth: res.depth, nodes: res.nodes };
  }

  // ---- records, prefs, saves (normalised defensively: another version may have written them) ----
  function nn(x) { x = Math.floor(+x); return isFinite(x) && x > 0 ? x : 0; }
  function newStats() {
    var lv = {};
    LEVELS.forEach(function (L) { lv[L.id] = { w: 0, l: 0, d: 0, best: 0 }; });
    return { games: 0, lv: lv, pvp: { n: 0, a: 0, b: 0, d: 0 }, streak: 0, bestStreak: 0, bigCap: 0, chain: 0, sown: 0, rules: { kalah: 0, oware: 0 } };
  }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    ['games', 'streak', 'bestStreak', 'bigCap', 'chain', 'sown'].forEach(function (k) { s[k] = nn(o[k]); });
    if (o.lv && typeof o.lv === 'object') LEVELS.forEach(function (L) { var l = o.lv[L.id]; if (l && typeof l === 'object') s.lv[L.id] = { w: nn(l.w), l: nn(l.l), d: nn(l.d), best: nn(l.best) }; });
    if (o.pvp && typeof o.pvp === 'object') s.pvp = { n: nn(o.pvp.n), a: nn(o.pvp.a), b: nn(o.pvp.b), d: nn(o.pvp.d) };
    if (o.rules && typeof o.rules === 'object') s.rules = { kalah: nn(o.rules.kalah), oware: nn(o.rules.oware) };
    if (s.bestStreak < s.streak) s.bestStreak = s.streak;
    return s;
  }
  // The longest run of extra turns one side took in a row.
  function longestChain(g, side) {
    var best = 0, run = 0;
    g.moves.forEach(function (m) {
      if (m.side !== side) { run = 0; return; }
      if (m.extra) { run++; if (run > best) best = run; } else run = 0;
    });
    return best;
  }
  function recordResult(st, g) {
    var r = g.result, info = { won: false, newStreak: false, newMargin: false, newCap: false, newChain: false };
    if (!r) return info;
    st.games++;
    st.rules[g.r] = (st.rules[g.r] || 0) + 1;
    var sides = g.mode === 'cpu' ? [g.human] : [0, 1], cap = 0, chain = 0;
    g.moves.forEach(function (m) { if (sides.indexOf(m.side) >= 0) { if (m.cap > cap) cap = m.cap; st.sown += m.n; } });
    sides.forEach(function (sd) { chain = Math.max(chain, longestChain(g, sd)); });
    if (cap > st.bigCap) { st.bigCap = cap; info.newCap = true; }
    if (chain > st.chain) { st.chain = chain; info.newChain = true; }
    if (g.mode === 'cpu') {
      var l = st.lv[levelOf(g.level).id], margin = g.b[STORE[g.human]] - g.b[STORE[1 - g.human]];
      if (r.winner === -1) { l.d++; st.streak = 0; }
      else if (r.winner === g.human) {
        l.w++; info.won = true; st.streak++;
        if (st.streak > st.bestStreak) { st.bestStreak = st.streak; info.newStreak = st.streak > 1; }
        if (margin > l.best) { info.newMargin = l.best > 0; l.best = margin; }
      } else { l.l++; st.streak = 0; }
    } else {
      st.pvp.n++;
      if (r.winner === 0) st.pvp.a++; else if (r.winner === 1) st.pvp.b++; else st.pvp.d++;
    }
    return info;
  }
  var SPEEDS = ['slow', 'normal', 'fast', 'instant'];
  function normPrefs(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      mode: o.mode === 'pvp' ? 'pvp' : 'cpu',
      level: levelOf(o.level == null ? 3 : o.level).id,
      first: o.first === 'cpu' || o.first === 'x' ? o.first : 'me',
      r: ruleId(o.r), n: clampSeeds(o.n == null ? 4 : o.n),
      speed: SPEEDS.indexOf(o.speed) >= 0 ? o.speed : 'normal',
      autoFlip: !!o.autoFlip, preview: o.preview !== false
    };
  }
  function gameSave(g) {
    return {
      r: g.r, n: g.n, mode: g.mode, level: g.level, human: g.human, pits: g.moves.map(function (m) { return m.pit; }),
      id: g.id, t: g.t, undos: g.undos, hints: g.hints, autoFlip: !!g.autoFlip, recorded: !!g.recorded,
      result: g.result && g.result.reason === 'resign' ? g.result : undefined
    };
  }
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.pits) || o.pits.length > 2000) return null;
    var g = replay(ruleId(o.r), clampSeeds(o.n), o.pits.map(function (x) { return x | 0; }));
    if (!g) return null;
    g.mode = o.mode === 'pvp' ? 'pvp' : 'cpu';
    g.level = levelOf(o.level).id;
    g.human = o.human === 1 ? 1 : 0;
    g.id = nn(o.id) || 1; g.t = +o.t || 0; g.undos = nn(o.undos); g.hints = nn(o.hints);
    g.autoFlip = !!o.autoFlip; g.recorded = !!o.recorded;
    if (!g.result && o.result && o.result.reason === 'resign' && (o.result.winner === 0 || o.result.winner === 1)) g.result = { winner: o.result.winner, reason: 'resign' };
    return g;
  }

  var ENGINE = {
    STORE: STORE, WIN: WIN, QUIET_MAX: QUIET_MAX, RULES: RULES, LEVELS: LEVELS, SPEEDS: SPEEDS,
    newBoard: newBoard, sideSum: sideSum, total: total, rowOf: rowOf, label: label, legalMoves: legalMoves, step: step, sweep: sweep, preview: preview,
    newGame: newGame, legal: legal, play: play, replay: replay, undo: undo, boardAt: boardAt, endGame: endGame, outcomeOf: outcomeOf, notation: notation,
    evaluate: evaluate, search: search, levelOf: levelOf, levelSearchOpts: levelSearchOpts, handle: handle, rng: rng,
    newStats: newStats, normStats: normStats, recordResult: recordResult, longestChain: longestChain,
    normPrefs: normPrefs, gameSave: gameSave, normGame: normGame, clampSeeds: clampSeeds
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  // Loaded as a Web Worker (new Worker('mancala.js')): answer search requests.
  if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
    self.onmessage = function (e) {
      var out;
      try { out = handle(e.data || {}); } catch (err) { out = { id: (e.data || {}).id, error: String(err && err.message || err) }; }
      self.postMessage(out);
    };
    return;
  }

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('mancala.css');
  var WORKER_URL = Cade.asset('mancala.js');
  var PANEL_ID = 'mancala-panel', NAME = 'Mancala';
  var KEY = 'cade-mancala-', GAME_KEY = KEY + 'game', STATS_KEY = KEY + 'stats', PREFS_KEY = KEY + 'prefs', SOUND_KEY = KEY + 'sound';
  var STEP_MS = { slow: 260, normal: 150, fast: 70, instant: 0 };
  var S = null;
  if (window.__CADE_UNIT__) {
    window.__CADE_UNIT__.mancala = {     // test-only peek: the live session, and a way to set up a position
      live: function () { return S; },
      setup: function (board, side, o) {
        if (!S) return;
        o = o || {};
        startGame({ mode: o.mode || 'cpu', level: o.level || 1, first: o.first || 'me', r: o.r || 'kalah', n: 4, autoFlip: !!o.autoFlip });
        cancelThink();
        S.game.b = board.slice(); S.game.side = side;
        renderAll(); maybeThink();
      }
    };
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(msg, ms) { if (Cade.showToast) Cade.showToast(msg, 'info', ms || 1800); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

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
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  var PENTA = [0, 2, 4, 7, 9];
  function sfx(k, n) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    if (k === 'drop') {
      // a woody tick climbing a pentatonic scale as the hand empties
      var i = (n || 0) % 15, f = 392 * Math.pow(2, (Math.floor(i / 5) * 12 + PENTA[i % 5]) / 12);
      s.tone(f, 0.06, 'triangle', 0.045, f * 0.8);
    }
    else if (k === 'pick') { s.tone(220, 0.07, 'sine', 0.05, 330); }
    else if (k === 'store') { s.tone(660, 0.08, 'sine', 0.05); }
    else if (k === 'extra') { [784, 988, 1175].forEach(function (f, j) { s.tone(f, 0.1, 'sine', 0.045, 0, j * 0.07); }); }
    else if (k === 'cap') { s.tone(330, 0.12, 'square', 0.03, 660); s.tone(523 + 20 * Math.min(10, n || 0), 0.16, 'triangle', 0.045, 0, 0.1); }
    else if (k === 'slam') { s.tone(180, 0.2, 'sawtooth', 0.025, 120); }
    else if (k === 'bad') { s.tone(150, 0.12, 'sawtooth', 0.03, 110); }
    else if (k === 'click') { s.tone(880, 0.05, 'sine', 0.035); }
    else if (k === 'turn') { s.tone(523, 0.06, 'sine', 0.03); s.tone(659, 0.08, 'sine', 0.03, 0, 0.06); }
    else if (k === 'win') { [523, 659, 784, 1047].forEach(function (f, j) { s.tone(f, 0.16, 'triangle', 0.05, 0, j * 0.1); }); }
    else if (k === 'lose') { [392, 330, 262].forEach(function (f, j) { s.tone(f, 0.22, 'triangle', 0.045, 0, j * 0.14); }); }
    else if (k === 'draw') { s.tone(440, 0.14, 'triangle', 0.045); s.tone(440, 0.2, 'triangle', 0.04, 0, 0.16); }
    else if (k === 'hint') { s.tone(988, 0.06, 'sine', 0.035); s.tone(1319, 0.08, 'sine', 0.03, 0, 0.06); }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 6h16M4 12h16M4 18h16"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
  var IC_HINT = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>');
  var IC_FLIP = svg('<path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4"/>');
  var IC_FLAG = svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
  var IC_FIRST = svg('<path d="M18 6l-6 6 6 6M7 6v12"/>');
  var IC_PREV = svg('<path d="M15 6l-6 6 6 6"/>');
  var IC_NEXT = svg('<path d="M9 6l6 6-6 6"/>');
  var IC_LAST = svg('<path d="M6 6l6 6-6 6M17 6v12"/>');

  // ---- seed layout: a golden-angle spiral, so a seed never moves when another lands ----
  var PIT_CAP = 24, STORE_CAP = 60, POS_PIT = [], POS_STORE = [];
  (function () {
    function h(k) { var x = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
    for (var k = 0; k < STORE_CAP; k++) {
      var a = k * 2.39996 + 0.7, jx = (h(k) - 0.5) * 5, jy = (h(k + 99) - 0.5) * 5;
      if (k < PIT_CAP) { var r = 4 + 31 * Math.sqrt(k / PIT_CAP); POS_PIT.push([50 + r * Math.cos(a) + jx, 50 + r * Math.sin(a) + jy]); }
      var r2 = 4 + 32 * Math.sqrt(k / STORE_CAP); POS_STORE.push([50 + r2 * Math.cos(a) * 1.05 + jx, 50 + r2 * Math.sin(a) + jy * 0.6]);
    }
  })();
  function seedHue(i, k) { var x = Math.sin(i * 91.7 + k * 17.3) * 9631.17; return Math.floor((x - Math.floor(x)) * 5); }
  function seedsHtml(i, n, store) {
    var cap = store ? STORE_CAP : PIT_CAP, P = store ? POS_STORE : POS_PIT, h = '';
    for (var k = 0; k < Math.min(n, cap); k++) h += '<i class="s' + seedHue(i, k) + '" style="left:' + P[k][0].toFixed(1) + '%;top:' + P[k][1].toFixed(1) + '%"></i>';
    return h;
  }

  // ---- session helpers ----
  function g0() { return S && S.game; }
  function live() { return S && S.view == null; }
  function humanTurn() { var g = S.game; return !!g && !g.result && (g.mode === 'pvp' || g.side === g.human); }
  function canAct() { return S && S.game && !S.game.result && live() && humanTurn() && !S.anim && !S.thinking && !S.card; }
  function persist() { if (S && S.game) sset(GAME_KEY, JSON.stringify(gameSave(S.game))); }
  function persistStats() { if (S) sset(STATS_KEY, JSON.stringify(S.stats)); }
  function persistPrefs() { if (S) sset(PREFS_KEY, JSON.stringify(S.prefs)); }
  function sideName(side, short) {
    var g = S.game;
    if (!g) return side ? 'North' : 'South';
    if (g.mode === 'cpu') return side === g.human ? 'You' : short ? 'CPU' : 'CPU · ' + levelOf(g.level).name;
    return 'Player ' + (side + 1);
  }
  // Who sits at the bottom: you vs the CPU; the mover in pass-and-play when the board turns.
  function bottomSide() {
    var g = S.game, s = 0;
    if (g) s = g.mode === 'cpu' ? g.human : (g.autoFlip ? S.face : 0);
    return S.flip ? 1 - s : s;
  }
  function shownBoard() {
    var g = S.game;
    if (!g) return newBoard(S.prefs.n);
    if (S.anim) return S.anim.d;
    if (S.view != null) return S.viewB || (S.viewB = boardAt(g, S.view));
    return g.b;
  }
  function stepMs() { return STEP_MS[S.prefs.speed] == null ? 150 : STEP_MS[S.prefs.speed]; }

  // ---- the board ----
  function buildBoard() {
    var h = '';
    for (var i = 0; i < 14; i++) {
      var st = i === 6 || i === 13;
      h += '<div class="mc-cell ' + (st ? 'mc-store' : 'mc-pit') + ' o' + (i < 7 ? 0 : 1) + '" data-i="' + i + '">' +
        '<div class="mc-cup">' + (st ? '' : '<i class="mc-lb">' + label(i) + '</i>') + '<span class="mc-sd"></span></div><b class="mc-n"></b></div>';
    }
    S.boardEl.innerHTML = h;
    S.cells = [].slice.call(S.boardEl.children);
    S.cells.forEach(function (c) { c._sd = c.querySelector('.mc-sd'); c._n = c.querySelector('.mc-n'); c._cup = c.querySelector('.mc-cup'); c._v = -1; });
  }
  function placeCells(bs) {
    if (S.placed === bs) return;
    S.placed = bs;
    S.root.classList.toggle('nb', bs === 1);
    for (var i = 0; i < 14; i++) {
      var c = S.cells[i], col, row;
      if (i === STORE[bs]) { col = '8'; row = '1 / span 2'; c.classList.add('right'); c.classList.remove('left'); }
      else if (i === STORE[1 - bs]) { col = '1'; row = '1 / span 2'; c.classList.add('left'); c.classList.remove('right'); }
      else if (rowOf(i) === bs) { col = String(2 + (i - bs * 7)); row = '2'; c.classList.add('bot'); c.classList.remove('top'); }
      else { col = String(7 - (i - (1 - bs) * 7)); row = '1'; c.classList.add('top'); c.classList.remove('bot'); }
      c.style.gridColumn = col; c.style.gridRow = row;
    }
  }
  function setCount(i, n) {
    var c = S.cells[i];
    if (c._v === n) return;
    c._v = n;
    c._sd.innerHTML = seedsHtml(i, n, i === 6 || i === 13);
    c._n.textContent = String(n);
    c.classList.toggle('empty', n === 0);
    c.classList.toggle('many', n > (i === 6 || i === 13 ? STORE_CAP : PIT_CAP));
  }
  function previewOf(pit) {
    var g = S.game;
    if (!g || g.result || S.anim || !live()) return null;
    if (legal(g).indexOf(pit) < 0) return null;
    return preview(g.b, g.r, g.side, pit);
  }
  function renderBoard() {
    if (!S) return;
    var g = S.game, b = shownBoard(), bs = bottomSide(), i;
    placeCells(bs);
    for (i = 0; i < 14; i++) setCount(i, b[i]);
    var act = canAct(), lm = act ? legal(g) : [], ply = S.view == null ? (g ? g.moves.length : 0) : S.view;
    var last = g && ply > 0 && !S.anim ? g.moves[ply - 1] : null, pv = null;
    var focus = S.kbd && S.cursor != null ? S.cursor : S.hover;
    if (act && focus != null && S.prefs.preview) pv = previewOf(focus);
    var hintPit = S.hint && g && S.hint.ply === g.moves.length && live() ? S.hint.pit : -1;
    for (i = 0; i < 14; i++) {
      var c = S.cells[i], cl = c.classList;
      cl.toggle('can', lm.indexOf(i) >= 0);
      cl.toggle('turn', !!g && !g.result && rowOf(i) === g.side && live());
      cl.toggle('lastp', !!last && last.pit === i);
      cl.toggle('lastl', !!last && last.last === i && last.last !== last.pit);
      cl.toggle('hint', hintPit === i);
      cl.toggle('cur', !!S.kbd && act && S.cursor === i);
      cl.toggle('land', !!pv && pv.last === i);
      cl.toggle('lcap', !!pv && !!pv.capPits && pv.capPits.indexOf(i) >= 0);
      cl.toggle('src', !!S.anim && S.anim.pit === i);
      c.setAttribute('aria-label', cellLabel(i, b[i]));
    }
    S.stage.classList.toggle('anim', !!S.anim);
    S.stage.classList.toggle('act', act);
  }
  function cellLabel(i, n) {
    if (i === 6 || i === 13) return sideName(i === 6 ? 0 : 1) + ' store: ' + plural(n, 'seed');
    return sideName(rowOf(i)) + ' pit ' + label(i) + ': ' + plural(n, 'seed');
  }
  function renderBars() {
    var g = S.game, bs = bottomSide(), b = shownBoard();
    [[S.barBot, bs], [S.barTop, 1 - bs]].forEach(function (pr) {
      var el = pr[0], sd = pr[1], on = g && !g.result && g.side === sd && live();
      var think = on && S.thinking && g.mode === 'cpu' && sd !== g.human;
      var won = g && g.result && g.result.winner === sd;
      el.className = 'mc-bar ' + (el === S.barTop ? 'top' : 'bot');
      el.innerHTML = '<span class="mc-who o' + sd + (on ? ' on' : '') + '"><span class="mc-dot"></span>' + esc(sideName(sd)) +
        (think ? '<em class="mc-think"><b>.</b><b>.</b><b>.</b></em>' : '') + (won ? ' <em class="mc-crown">wins</em>' : '') + '</span>' +
        '<span class="mc-tally"><i>' + sideSum(b, sd) + ' in play</i><b class="o' + sd + '">' + b[STORE[sd]] + '</b></span>';
    });
  }
  function resultText(g) {
    var r = g.result, a = g.b[6], c = g.b[13], hs = g.mode === 'cpu' ? g.human : 0;
    var sc = (hs === 0 ? a + '–' + c : c + '–' + a);
    if (r.reason === 'resign') return sideName(1 - r.winner) + ' resigned';
    if (r.winner === -1) return 'A draw, ' + sc;
    if (g.mode === 'cpu') return (r.winner === g.human ? 'You win ' : 'CPU wins ') + sc;
    return sideName(r.winner) + ' wins ' + (r.winner === 0 ? a + '–' + c : c + '–' + a);
  }
  function renderStatus() {
    var g = S.game, h = '';
    if (!g) h = 'Pick a game from the menu.';
    else if (S.view != null) h = '<b>Move ' + S.view + ' of ' + g.moves.length + '</b><br><span class="mc-dim">Looking back — the board waits. <b>End</b> / &#9654;| returns.</span>';
    else if (g.result) h = '<b class="mc-acc">' + esc(resultText(g)) + '</b><br><span class="mc-dim">' + (g.result.reason === 'stall' ? 'No capture in 50 moves: each side kept its own row. ' : '') + 'Undo is off — step back through the moves below.</span>';
    else if (S.anim) h = '<b>' + esc(sideName(S.anim.side)) + '</b> ' + (S.anim.side === (g.mode === 'cpu' ? g.human : -1) ? 'sow' : 'sows') + ' ' + plural(S.anim.n0, 'seed') + ' from ' + label(S.anim.pit) + '<br><span class="mc-dim">' + (S.coarse ? 'Tap the board' : 'Click / Space') + ' to skip</span>';
    else if (S.thinking) h = '<b>CPU</b> is thinking…';
    else if (S.hintBusy) h = 'Looking for a good move…';
    else {
      var me = g.mode === 'cpu' ? 'Your move' : sideName(g.side) + ' to move';
      var note = S.note && S.note.ply === g.moves.length ? S.note.html : '';
      var focus = S.kbd && S.cursor != null ? S.cursor : S.hover, pv = focus != null && S.prefs.preview ? previewOf(focus) : null;
      if (pv) note = '<b>' + label(focus) + '</b> · ' + plural(pv.n, 'seed') + ' → ' + describe(pv, g.side);
      else if (S.hint && S.hint.ply === g.moves.length) {
        var hp = preview(g.b, g.r, g.side, S.hint.pit);
        note = '<span class="mc-hn">Hint:</span> play <b>' + label(S.hint.pit) + '</b> — ' + describe(hp, g.side);
      }
      h = '<b>' + esc(me) + '</b>' + (note ? '<br>' + note : '<br><span class="mc-dim">' + (S.coarse ? 'Tap one of your pits.' : 'Click a pit, or keys 1-6.') + '</span>');
    }
    S.status.innerHTML = h;
  }
  function describe(pv, side) {
    if (pv.over) return 'ends the game';
    if (pv.extra) return '<span class="mc-acc">lands in the store: go again</span>';
    if (pv.cap) return '<span class="mc-acc">captures ' + pv.cap + '</span>';
    if (pv.slam) return 'grand slam — no capture';
    if (rowOf(pv.last) === side) return 'ends in ' + label(pv.last) + ' on your side';
    return 'ends in their ' + label(pv.last);
  }
  // Turns (a mover's run of moves, extra turns included) in rows of South | North.
  function renderMoves() {
    var g = S.game, el = S.movesEl;
    if (!g || !g.moves.length) { el.innerHTML = '<div class="mc-empty">' + (g ? 'No moves yet' : '') + '</div>'; renderNav(); return; }
    var turns = [], cur = null, ply = S.view == null ? g.moves.length : S.view;
    g.moves.forEach(function (m, i) {
      if (!cur || cur.side !== m.side) { cur = { side: m.side, ms: [] }; turns.push(cur); }
      cur.ms.push({ m: m, ply: i + 1 });
    });
    var h = '', row = 0;
    for (var t = 0; t < turns.length; t++) {
      var tn = turns[t];
      if (tn.side === 0 || t === 0) { row++; h += '<span class="mc-mn">' + row + '.</span>'; if (tn.side === 1) h += '<span class="mc-ph">…</span>'; }
      h += '<span class="mc-turn o' + tn.side + '">' + tn.ms.map(function (x) {
        return '<button type="button" class="mc-mv' + (x.ply === ply ? ' on' : '') + (x.m.cap ? ' x' : '') + '" data-ply="' + x.ply + '" title="' + esc(sideName(x.m.side, true) + ': ' + label(x.m.pit) + ', ' + plural(x.m.n, 'seed') + (x.m.extra ? ', extra turn' : '') + (x.m.cap ? ', captured ' + x.m.cap : '')) + '">' +
          label(x.m.pit) + (x.m.extra ? '<sup>+</sup>' : '') + (x.m.cap ? '<sub>x' + x.m.cap + '</sub>' : '') + '</button>';
      }).join('') + '</span>';
    }
    if (g.result) h += '<div class="mc-res">' + esc(resultText(g)) + '</div>';
    el.innerHTML = h;
    var on = el.querySelector('.mc-mv.on');
    if (on) {
      if (S.phone) el.scrollLeft = Math.max(0, on.offsetLeft - el.clientWidth / 2);
      else if (S.view == null) el.scrollTop = el.scrollHeight;
      else { var top = on.offsetTop - el.offsetTop; if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 24) el.scrollTop = top - el.clientHeight / 2; }
    }
    renderNav();
  }
  function renderNav() {
    var g = S.game, n = g ? g.moves.length : 0, p = S.view == null ? n : S.view, busy = !!S.anim;
    S.nav.querySelectorAll('button').forEach(function (b) {
      var k = b.getAttribute('data-nav');
      b.disabled = busy || !n || ((k === 'first' || k === 'prev') ? p === 0 : p === n);
    });
  }
  function renderPad() {
    var g = S.game, l = live();
    function dis(a, d) { var b = S.pad.querySelector('[data-act="' + a + '"]'); if (b) b.disabled = !!d; }
    var undoable = g && !g.result && l && !S.anim && g.moves.length > 0 && (g.mode === 'pvp' || g.moves.some(function (m) { return m.side === g.human; }));
    dis('undo', !undoable);
    dis('hint', !(g && !g.result && l && humanTurn() && !S.anim && !S.thinking && !S.hintBusy));
    dis('resign', !(g && !g.result));
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function renderAll() {
    if (!S) return;
    var g = S.game;
    if (g && !S.anim && !g.result) S.face = g.side;
    S.root.classList.toggle('swap', !!g && g.mode === 'cpu' && g.human === 1);
    renderBoard(); renderBars(); renderStatus(); renderMoves(); renderPad();
  }
  function say(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- effects: a hand that carries the seeds, sparks, pop-ups ----
  function centerOf(i) {
    var c = S.cells[i]._cup, r = c.getBoundingClientRect(), sr = S.stage.getBoundingClientRect();
    return [r.left - sr.left + r.width / 2, r.top - sr.top + r.height / 2];
  }
  function moveHand(i, n) {
    var h = S.hand, p = centerOf(i);
    h.style.transform = 'translate(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px)';
    h.firstChild.textContent = n > 0 ? String(n) : '';
    h.classList.toggle('on', n > 0);
  }
  function hideHand() { S.hand.classList.remove('on'); }
  function pulse(i, cls) {
    var c = S.cells[i];
    c.classList.remove(cls);
    void c.offsetWidth;
    c.classList.add(cls);
  }
  function fly(from, to, n, slow) {
    if (S.rm) return;
    var a = centerOf(from), b = centerOf(to), k = Math.min(n, 10), dur = slow ? 520 : 380;
    for (var j = 0; j < k; j++) {
      var e = document.createElement('i');
      e.className = 'mc-fly s' + seedHue(from, j);
      var jx = (Math.random() - 0.5) * 14, jy = (Math.random() - 0.5) * 14;
      e.style.transform = 'translate(' + (a[0] + jx) + 'px,' + (a[1] + jy) + 'px)';
      e.style.transitionDuration = dur + 'ms';
      e.style.transitionDelay = (j * 28) + 'ms';
      S.fx.appendChild(e);
      (function (el, x, y) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { el.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(0.7)'; el.style.opacity = '0.2'; }); });
        setTimeout(function () { el.remove(); }, dur + j * 28 + 80);
      })(e, b[0] + (Math.random() - 0.5) * 16, b[1] + (Math.random() - 0.5) * 24);
    }
  }
  function popup(i, text, cls) {
    var p = centerOf(i), e = document.createElement('b');
    e.className = 'mc-pop ' + (cls || '');
    e.textContent = text;
    e.style.left = p[0] + 'px'; e.style.top = p[1] + 'px';
    S.fx.appendChild(e);
    setTimeout(function () { e.remove(); }, 1200);
  }
  function sparks(i, n) {
    if (S.rm) return;
    var p = centerOf(i), G = ['*', '+', '.', 'o', "'"];
    for (var j = 0; j < n; j++) {
      var e = document.createElement('i'), a = Math.random() * Math.PI * 2, d = 18 + Math.random() * 30;
      e.className = 'mc-spark';
      e.textContent = G[j % G.length];
      e.style.left = p[0] + 'px'; e.style.top = p[1] + 'px';
      e.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      e.style.setProperty('--dy', (Math.sin(a) * d).toFixed(1) + 'px');
      S.fx.appendChild(e);
      setTimeout(function (el) { return function () { el.remove(); }; }(e), 750);
    }
  }
  function banner(text, cls) {
    var e = document.createElement('div');
    e.className = 'mc-banner ' + (cls || '');
    e.innerHTML = '<span>' + text + '</span>';
    S.fx.appendChild(e);
    setTimeout(function () { e.remove(); }, 1250);
  }
  function burst() {
    if (S.rm) return;
    var wrap = document.createElement('div'), G = ['*', 'o', '+', '@', '.'];
    wrap.className = 'mc-burst';
    for (var j = 0; j < 28; j++) {
      var e = document.createElement('i'), a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 110;
      e.className = 's' + (j % 5);
      e.textContent = G[j % G.length];
      e.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      e.style.setProperty('--dy', (Math.sin(a) * d * 0.7).toFixed(1) + 'px');
      e.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
      wrap.appendChild(e);
    }
    S.fx.appendChild(wrap);
    setTimeout(function () { wrap.remove(); }, 1700);
  }

  // ---- sowing, seed by seed ----
  function animate(before, rec, done) {
    var A = { d: before.slice(), ev: rec.ev, i: 0, done: done, side: rec.side, pit: rec.pit, n0: rec.n, n: 0, k: 0, t: 0, skip: false };
    S.anim = A; S.hover = null; S.viewB = null;
    A.skip = stepMs() === 0 || document.hidden || (Cade.isMinimized && Cade.isMinimized(S.panel));
    renderAll();
    animNext();
  }
  function animNext() {
    var A = S && S.anim;
    if (!A) return;
    var T = stepMs(), wait = T;
    if (A.n0 > 14) T = wait = Math.max(30, T * 0.7);
    do {
      if (A.i >= A.ev.length) { finishAnim(); return; }
      var e = A.ev[A.i++], d = A.d, fx = !A.skip;
      if (e.t === 'pick') {
        d[e.pit] = 0; A.n = e.n;
        if (fx) { moveHand(e.pit, A.n); pulse(e.pit, 'up'); sfx('pick'); wait = T * 1.4; }
      } else if (e.t === 'drop') {
        d[e.pit]++; A.n--; A.k++;
        if (fx) {
          moveHand(e.pit, A.n);
          pulse(e.pit, 'drop');
          sfx(e.pit === 6 || e.pit === 13 ? 'store' : 'drop', A.k);
          if (Cade.haptic && S.coarse && A.k % 2 === 0) Cade.haptic(3);
          wait = A.n ? T : T * 1.6;
        }
        if (!A.n) A.landed = e.pit;
      } else if (e.t === 'extra') {
        if (fx) { hideHand(); popup(STORE[e.side], 'again!', 'acc'); sparks(STORE[e.side], 8); sfx('extra'); wait = T * 2 + 260; }
      } else if (e.t === 'cap') {
        e.pits.forEach(function (p) { if (fx) fly(p, e.store, d[p]); d[e.store] += d[p]; d[p] = 0; });
        if (fx) {
          hideHand();
          e.pits.forEach(function (p) { pulse(p, 'gone'); });
          popup(e.store, '+' + e.n, 'acc big');
          sfx('cap', e.n);
          if (Cade.haptic) Cade.haptic(12);
          wait = Math.max(T * 3, 160) + 380;
        }
      } else if (e.t === 'slam') {
        if (fx) { hideHand(); e.pits.forEach(function (p) { pulse(p, 'shake'); }); popup(e.pits[0], 'grand slam: no capture', 'warn'); sfx('slam'); wait = T * 2 + 600; }
      } else if (e.t === 'sweep') {
        e.pits.forEach(function (p) { if (fx) fly(p, e.store, d[p], true); d[e.store] += d[p]; d[p] = 0; });
        if (fx) { hideHand(); popup(e.store, '+' + e.n, 'big'); sfx('store'); wait = T * 2 + 520; }
      }
      if (fx) { renderBoard(); renderBars(); }
    } while (A.skip);
    A.t = setTimeout(animNext, wait);
  }
  function skipAnim() {
    var A = S && S.anim;
    if (!A || A.skip) return;
    A.skip = true;
    clearTimeout(A.t);
    hideHand();
    animNext();
  }
  function finishAnim() {
    var A = S.anim;
    if (!A) return;
    clearTimeout(A.t);
    hideHand();
    S.anim = null;
    A.done();
  }

  // ---- playing ----
  function doMove(pit) {
    var g = S.game, before = g.b.slice(), gid = g.id;
    var rec = play(g, pit);
    if (!rec) return false;
    S.hint = null; S.cursor = S.kbd ? S.cursor : null; S.note = null;
    persist();
    say(sideName(rec.side) + ' plays ' + label(pit) + (rec.extra ? ', extra turn' : '') + (rec.cap ? ', captures ' + rec.cap : '') + '.');
    animate(before, rec, function () {
      if (!S || S.game !== g || g.id !== gid) return;
      afterMove(rec);
    });
    return true;
  }
  function afterMove(rec) {
    var g = S.game;
    var who = g.mode === 'cpu' ? (rec.side === g.human ? 'You' : 'CPU') : sideName(rec.side);
    if (rec.cap) S.note = { ply: g.moves.length, html: '<span class="mc-acc">' + esc(who) + ' captured ' + rec.cap + '!</span>' + (rec.extra ? '' : '') };
    else if (rec.extra && !g.result) S.note = { ply: g.moves.length, html: '<span class="mc-acc">' + esc(who === 'You' ? 'Your' : who + '’s') + ' last seed hit the store — go again!</span>' };
    else if (rec.slam) S.note = { ply: g.moves.length, html: 'Grand slam — taking every seed is not allowed, so nothing was captured.' };
    var prevFace = S.face;
    renderAll();
    if (g.result) { finish(); return; }
    if (g.mode === 'pvp' && rec.side !== g.side) {
      sfx('turn');
      if (g.autoFlip && prevFace !== S.face) banner(esc(sideName(g.side)) + '’s turn', 'o' + g.side);
    }
    if (canAct() && S.kbd) { var lm = legal(g); if (lm.indexOf(S.cursor) < 0) S.cursor = lm[0]; renderBoard(); }
    maybeThink();
  }
  function finish() {
    var g = S.game;
    var info = {};
    if (!g.recorded) { info = recordResult(S.stats, g); g.recorded = true; g.info = info; persistStats(); persist(); }
    else info = g.info || {};
    var r = g.result, good = g.mode === 'pvp' ? r.winner !== -1 : r.winner === g.human;
    sfx(r.winner === -1 ? 'draw' : good ? 'win' : 'lose');
    if (good) burst();
    say(resultText(g) + '.');
    clearTimeout(S.resT);
    S.resT = setTimeout(function () { if (S && S.game === g && g.result && !S.card) showCard('result'); }, r.reason === 'resign' ? 0 : 1100);
  }
  function tapPit(i) {
    var g = S.game;
    if (S.anim) { skipAnim(); return; }
    if (!g || S.card) return;
    if (!live()) { navTo(g.moves.length); return; }
    if (g.result) { showCard('result'); return; }
    if (!humanTurn() || S.thinking) { sfx('bad'); shakeStatus(); return; }
    if (legal(g).indexOf(i) < 0) {
      if (rowOf(i) === g.side) { sfx('bad'); S.note = { ply: g.moves.length, html: g.b[i] ? 'You must give them seeds to play — pick a pit that reaches their side.' : 'That pit is empty.' }; renderStatus(); shakeStatus(); }
      else if (rowOf(i) === 1 - g.side) { sfx('bad'); S.note = { ply: g.moves.length, html: 'Play from ' + (g.mode === 'cpu' ? 'your' : sideName(g.side) + '’s') + ' row.' }; renderStatus(); shakeStatus(); }
      return;
    }
    S.snd.ensure();
    doMove(i);
  }
  function shakeStatus() { S.status.classList.remove('shake'); void S.status.offsetWidth; S.status.classList.add('shake'); }
  function undoMove() {
    var g = S.game;
    if (!g || g.result || !live() || S.anim) return;
    cancelThink();
    var n = 0;
    if (g.mode === 'pvp') { if (undo(g)) n++; }
    else {
      if (!g.moves.some(function (m) { return m.side === g.human; })) { renderAll(); return; }
      while (g.moves.length && (n === 0 || g.side !== g.human)) { undo(g); n++; }
    }
    if (!n) return;
    g.undos++; S.hint = null; S.note = null;
    sfx('click');
    persist(); renderAll();
    maybeThink();
  }
  function curPly() { return S.view == null ? (S.game ? S.game.moves.length : 0) : S.view; }
  function navTo(p) {
    var g = S.game;
    if (!g || S.anim) return;
    p = Math.max(0, Math.min(g.moves.length, p));
    S.view = p === g.moves.length ? null : p;
    S.viewB = null;
    renderAll();
  }
  function flip() { S.flip = !S.flip; sfx('click'); renderAll(); }

  // ---- the computer ----
  function makeWorker() {
    if (S.worker || S.noWorker) return S.worker;
    try {
      S.worker = new Worker(WORKER_URL);
      S.worker.onmessage = function (e) { onEngine(e.data || {}); };
      S.worker.onerror = function () { killWorker(); S.noWorker = true; var p = S.pending; S.pending = {}; for (var k in p) runLocal(p[k]); };
    } catch (e) { S.worker = null; S.noWorker = true; }
    return S.worker;
  }
  function killWorker() { if (S && S.worker) { try { S.worker.terminate(); } catch (e) {} S.worker = null; } }
  function ask(msg, cb) {
    var id = ++S.reqId, g = S.game;
    msg.id = id; msg.r = g.r; msg.n = g.n; msg.pits = g.moves.map(function (m) { return m.pit; });
    S.pending[id] = { msg: msg, cb: cb, gameId: g.id, ply: g.moves.length };
    var w = makeWorker();
    if (w) { try { w.postMessage(msg); return; } catch (e) { S.noWorker = true; } }
    S.pending[id] && runLocal(S.pending[id]);
  }
  function runLocal(p) {
    // no Worker: a short search on the page, after the board has painted
    setTimeout(function () {
      if (!S || !S.pending[p.msg.id]) return;
      p.msg.timeCap = 400;
      var r;
      try { r = handle(p.msg); } catch (e) { r = { id: p.msg.id, error: String(e) }; }
      onEngine(r);
    }, 40);
  }
  function onEngine(r) {
    if (!S) return;
    var p = S.pending[r.id];
    if (!p) return;
    delete S.pending[r.id];
    if (!S.game || p.gameId !== S.game.id || p.ply !== S.game.moves.length) return;
    p.cb(r);
  }
  function cancelThink() {
    if (!S) return;
    var busy = false;
    for (var k in S.pending) { busy = true; break; }
    S.pending = {};
    if (busy) killWorker();
    S.thinking = false; S.hintBusy = false; S.heldReply = null;
    clearTimeout(S.cpuT);
  }
  function maybeThink() {
    var g = S.game;
    if (!g || g.result || g.mode !== 'cpu' || g.side === g.human || S.thinking || S.anim) return;
    S.thinking = true;
    var t0 = now(), lv = g.level;
    renderBars(); renderStatus(); renderPad(); renderBoard();
    ask({ level: lv, seed: (g.id * 7919 + g.moves.length * 104729 + (Date.now() & 0xffff)) >>> 0 }, function (r) {
      var last = g.moves[g.moves.length - 1], wait = Math.max(0, (last && last.side !== g.human ? 380 : lv <= 2 ? 650 : 450) - (now() - t0));
      S.cpuT = setTimeout(function () {
        if (!S || S.game !== g) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.heldReply = r; return; }
        applyCpu(r);
      }, wait);
    });
  }
  function applyCpu(r) {
    var g = S.game;
    S.thinking = false; S.heldReply = null;
    if (r.error || r.pit == null || legal(g).indexOf(r.pit) < 0) {
      var lm = legal(g);           // the engine failed: never stall the game
      if (!lm.length) { renderAll(); return; }
      r = { pit: lm[0] };
    }
    S.cpuEval = r.score || 0;
    doMove(r.pit);
  }
  function hint() {
    var g = S.game;
    if (!g || g.result || !live() || !humanTurn() || S.thinking || S.anim || S.hintBusy) return;
    var ply = g.moves.length, lm = legal(g);
    if (S.hint && S.hint.ply === ply) { renderBoard(); renderStatus(); return; }
    if (lm.length === 1) { S.hint = { ply: ply, pit: lm[0] }; g.hints++; persist(); sfx('hint'); renderAll(); return; }
    S.hintBusy = true;
    renderAll();
    ask({ hint: true, seed: ply + 1 }, function (r) {
      S.hintBusy = false;
      if (r.pit == null || r.pit < 0) { renderAll(); return; }
      S.hint = { ply: ply, pit: r.pit };
      if (S.kbd) S.cursor = r.pit;      // Enter plays the hint
      g.hints++; persist();
      sfx('hint');
      renderAll();
    });
  }

  // ---- new games ----
  function startGame(o) {
    cancelThink();
    if (S.anim) { clearTimeout(S.anim.t); S.anim = null; hideHand(); }
    clearTimeout(S.resT);
    var human = o.first === 'cpu' ? 1 : o.first === 'x' ? (Math.random() < 0.5 ? 0 : 1) : 0;
    var g = newGame(o.r, o.n);
    g.mode = o.mode; g.level = o.level; g.human = o.mode === 'cpu' ? human : 0; g.autoFlip = !!o.autoFlip;
    g.id = ((S.game && S.game.id) || 0) + 1; g.t = Date.now(); g.undos = 0; g.hints = 0; g.recorded = false;
    S.game = g; S.view = null; S.viewB = null; S.hint = null; S.note = null; S.flip = false; S.cursor = null; S.face = 0; S.hover = null;
    S.prefs.mode = o.mode; S.prefs.level = o.level; S.prefs.first = o.first; S.prefs.r = g.r; S.prefs.n = g.n; S.prefs.autoFlip = g.autoFlip;
    persistPrefs(); persist();
    showCard(null);
    sfx('click');
    renderAll();
    say('New game of ' + RULES[g.r].name + ', ' + g.n + ' seeds a pit. ' + (g.mode === 'cpu' ? (g.human === 0 ? 'You move first.' : 'The CPU moves first.') : 'Player 1 moves first.'));
    maybeThink();
  }
  function rematch() {
    var g = S.game;
    if (!g) return;
    // swap who starts against the CPU
    var first = g.mode === 'cpu' ? (g.human === 0 ? 'cpu' : 'me') : 'me';
    startGame({ mode: g.mode, level: g.level, first: first, r: g.r, n: g.n, autoFlip: g.autoFlip });
  }
  function resign() {
    var g = S.game;
    if (!g || g.result) return;
    cancelThink();
    if (S.anim) { clearTimeout(S.anim.t); S.anim = null; hideHand(); }
    var loser = g.mode === 'cpu' ? g.human : g.side;
    endGame(g, 1 - loser, 'resign');
    persist(); showCard(null); renderAll(); finish();
  }
  function startFromMenu() {
    var m = S.menu;
    startGame({ mode: m.mode, level: m.level, first: m.first, r: m.r, n: m.n, autoFlip: m.autoFlip });
  }

  // ---- cards ----
  function chip(attr, val, on, lab, extra) {
    return '<button type="button" class="mc-chip' + (on ? ' on' : '') + '" data-' + attr + '="' + val + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + lab + (extra || '') + '</button>';
  }
  function levelRec(i) {
    var l = S.stats.lv[i];
    return l.w + l.l + l.d ? ' <i>' + l.w + '-' + l.l + (l.d ? '-' + l.d : '') + '</i>' : '';
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  var ART = '  .-----------------------.\n ( o  (::) (o:) (:.) (o)  o )\n  \'-----------------------\'';
  function cardHtml(kind) {
    var g = S.game, m = S.menu, h = '';
    if (kind === 'menu') {
      var resume = g && !g.result && S.cardBack;
      h = '<div class="mc-title">MANCALA</div>' +
        '<pre class="mc-art" aria-hidden="true">' + esc(ART) + '</pre>' +
        '<div class="mc-sec"><div class="mc-h">Opponent</div><div class="mc-chips">' +
        chip('mode', 'cpu', m.mode === 'cpu', 'vs CPU') + chip('mode', 'pvp', m.mode === 'pvp', '2 players · one device') + '</div></div>';
      if (m.mode === 'cpu') {
        h += '<div class="mc-sec"><div class="mc-h">Level</div><div class="mc-chips">';
        LEVELS.forEach(function (L) { h += chip('level', L.id, m.level === L.id, L.id + ' ' + L.name, levelRec(L.id)); });
        h += '</div></div><div class="mc-sec"><div class="mc-h">First move</div><div class="mc-chips">' +
          chip('first', 'me', m.first === 'me', 'You') + chip('first', 'cpu', m.first === 'cpu', 'CPU') + chip('first', 'x', m.first === 'x', '? Random') + '</div></div>';
      } else {
        h += '<div class="mc-sec"><div class="mc-h">Board</div><div class="mc-chips">' +
          chip('af', '0', !m.autoFlip, 'Fixed (Player 1 at the bottom)') + chip('af', '1', m.autoFlip, 'Turn to face the mover') + '</div></div>';
      }
      h += '<div class="mc-sec"><div class="mc-h">Rules</div><div class="mc-chips">' +
        chip('r', 'kalah', m.r === 'kalah', 'Kalah') + chip('r', 'oware', m.r === 'oware', 'Oware (abapa)') + '</div>' +
        '<p class="mc-tip">' + esc(RULES[m.r].info) + '.</p></div>';
      h += '<div class="mc-sec"><div class="mc-h">Seeds per pit</div><div class="mc-chips">' +
        [3, 4, 5, 6].map(function (n) { return chip('n', n, m.n === n, String(n) + (n === 4 ? ' <i>classic</i>' : '')); }).join('') + '</div></div>';
      h += '<div class="mc-sec"><div class="mc-h">Sowing</div><div class="mc-chips">' +
        SPEEDS.map(function (sp) { return chip('speed', sp, S.prefs.speed === sp, sp.charAt(0).toUpperCase() + sp.slice(1)); }).join('') + '</div></div>';
      h += '<div class="mc-btns">' + (resume ? '<button type="button" class="mc-go alt" data-act="close">Resume</button>' : '') +
        '<button type="button" class="mc-go" data-act="start">' + (resume ? 'New game' : 'Play') + '</button></div>' +
        '<div class="mc-foot"><button type="button" class="mc-lnk" data-act="stats">Records</button>' +
        '<button type="button" class="mc-lnk" data-act="help">How to play</button>' +
        (resume ? '<button type="button" class="mc-lnk" data-act="confirm">Resign…</button>' : '') + '</div>';
    } else if (kind === 'help') {
      h = '<div class="mc-title">HOW TO PLAY</div>' +
        '<pre class="mc-art" aria-hidden="true">  (o:) -&gt; (o) (o) (o) -&gt; [store]</pre>' +
        '<p>Each side has <b>six pits</b> and a <b>store</b> on its right. On your turn pick up <b>every seed</b> in one of your pits and <b>sow</b> them one by one into the following pits, counter-clockwise.</p>' +
        '<p><b>Kalah.</b> Sow into your own store too (never your opponent&rsquo;s). Last seed in <b>your store</b>: <b>go again</b>. Last seed in an <b>empty pit of yours</b>: capture it and every seed in the pit <b>opposite</b>. When either row is empty the game ends and each side keeps the seeds left on its side. Most seeds wins.</p>' +
        '<p><b>Oware.</b> Seeds skip the stores; a lap of 12+ skips its own pit. If your last seed makes a pit on <b>their side</b> hold <b>2 or 3</b>, capture it and the unbroken 2s and 3s just before it &mdash; unless that would take all their seeds (a <b>grand slam</b>: no capture). If their row is empty you <b>must</b> feed it. More than half the seeds wins.</p>' +
        '<div class="mc-keys"><span><b>Tap / click</b> one of your pits to sow it' + (S.coarse ? '' : ' &mdash; hover to see where it lands') + '</span>' +
        (S.coarse ? '<span><b>Tap the board</b> while seeds are sown to skip ahead</span>' :
        '<span><b>1-6</b> sow pit A-F &middot; <b>&larr; &rarr;</b> + <b>Enter</b> pick a pit</span>' +
        '<span><b>U</b> undo &middot; <b>H</b> hint &middot; <b>F</b> flip &middot; <b>N</b> menu</span>' +
        '<span><b>, .</b> step through moves &middot; <b>Space</b> skip the sowing</span>') + '</div>' +
        '<p class="mc-tip">Move list: <b>C<sup>+</sup></b> an extra turn, <b>x5</b> a capture of five. Letters count from each player&rsquo;s own left.</p>' +
        '<div class="mc-btns"><button type="button" class="mc-go" data-act="close">Got it</button></div>';
    } else if (kind === 'result') {
      var r = g.result, info = g.info || {}, title, a = g.b[6], c = g.b[13];
      if (g.mode === 'cpu') title = r.winner === g.human ? 'YOU WIN' : r.winner === -1 ? 'DRAW' : 'CPU WINS';
      else title = r.winner === -1 ? 'DRAW' : 'PLAYER ' + (r.winner + 1) + ' WINS';
      var hs = g.mode === 'cpu' ? g.human : 0, mine = hs === 0 ? a : c, theirs = hs === 0 ? c : a;
      h = '<div class="mc-title">' + title + '</div>' +
        '<div class="mc-big"><span class="o' + hs + '">' + mine + '</span> <small>&ndash;</small> <span class="o' + (1 - hs) + '">' + theirs + '</span></div>' +
        '<div class="mc-sub">' + esc(g.mode === 'cpu' ? 'You vs CPU · ' + levelOf(g.level).name : 'Player 1 vs Player 2') + ' · ' + RULES[g.r].name + ', ' + g.n + ' seeds</div>';
      var notes = [];
      if (r.reason === 'resign') notes.push(sideName(1 - r.winner) + ' resigned');
      if (r.reason === 'stall') notes.push('no capture in 50 moves: each side kept its row');
      notes.push(plural(g.moves.length, 'move') + ' · ' + (g.mode === 'cpu' ? 'your' : 'the') + ' biggest capture ' + bigCap(g, g.mode === 'cpu' ? g.human : null));
      if (g.mode === 'cpu') {
        var l = S.stats.lv[g.level];
        notes.push(levelOf(g.level).name + ': ' + l.w + ' won · ' + l.l + ' lost · ' + l.d + ' drawn');
        if (g.undos || g.hints) notes.push(plural(g.undos, 'undo') + ' · ' + plural(g.hints, 'hint'));
      }
      h += notes.map(function (t) { return '<div class="mc-note">' + esc(t) + '</div>'; }).join('');
      if (info.newStreak) h += '<div class="mc-new">** best streak · ' + S.stats.bestStreak + ' wins in a row **</div>';
      else if (info.newMargin) h += '<div class="mc-new">** biggest win at this level **</div>';
      if (info.newCap) h += '<div class="mc-new">new record capture: ' + S.stats.bigCap + ' seeds</div>';
      if (info.newChain && S.stats.chain > 1) h += '<div class="mc-new">new record: ' + S.stats.chain + ' extra turns in a row</div>';
      var nxt = g.mode === 'cpu' && info.won && g.level < 6;
      if (nxt) h += '<div class="mc-note">Ready for ' + levelOf(g.level + 1).name + '?</div>';
      h += '<div class="mc-btns"><button type="button" class="mc-go alt" data-act="review">Review</button>' +
        (nxt ? '<button type="button" class="mc-go alt" data-act="next">Next level</button>' : '') +
        '<button type="button" class="mc-go" data-act="rematch">Rematch</button></div>' +
        '<div class="mc-foot"><button type="button" class="mc-lnk" data-act="menu">New game…</button><button type="button" class="mc-lnk" data-act="stats">Records</button></div>';
    } else if (kind === 'stats') {
      var st = S.stats, rows = '<b>level        won lost drawn  best</b>\n';
      LEVELS.forEach(function (L) {
        var lv = st.lv[L.id], line = pad(L.id + ' ' + L.name, 12) + lpad(lv.w, 4) + lpad(lv.l, 5) + lpad(lv.d, 6) + lpad(lv.best ? '+' + lv.best : '-', 6);
        rows += (lv.w ? '<span class="g">' + line + '</span>' : lv.w + lv.l + lv.d ? line : '<i>' + line + '</i>') + '\n';
      });
      h = '<div class="mc-title">RECORDS</div><pre class="mc-tab">' + rows + '</pre>' +
        '<div class="mc-note">win streak ' + st.streak + ' · best ' + st.bestStreak + ' · games ' + st.games + ' (Kalah ' + st.rules.kalah + ', Oware ' + st.rules.oware + ')</div>' +
        '<div class="mc-note">biggest capture ' + st.bigCap + ' · most extra turns in a row ' + st.chain + ' · seeds sown ' + st.sown + '</div>' +
        '<div class="mc-note">2 players: ' + st.pvp.n + ' games · P1 ' + st.pvp.a + ' · P2 ' + st.pvp.b + ' · drawn ' + st.pvp.d + '</div>' +
        '<div class="mc-btns"><button type="button" class="mc-go" data-act="back">Back</button></div>' +
        '<div class="mc-foot">' + (S.resetArm ? '<span class="mc-confirm">Erase all records?</span><span><button type="button" class="mc-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="mc-lnk" data-act="reset-no">Keep</button></span>'
          : '<span></span><button type="button" class="mc-lnk" data-act="reset">Reset records</button>') + '</div>';
    } else if (kind === 'confirm') {
      h = '<div class="mc-title">RESIGN?</div>' +
        '<p class="mc-sub">' + (g.mode === 'cpu' ? 'Resigning counts as a loss.' : esc(sideName(g.side)) + ' to move. Resigning hands the game to ' + esc(sideName(1 - g.side)) + '.') + '</p>' +
        '<div class="mc-btns"><button type="button" class="mc-go alt" data-act="back">Keep playing</button>' +
        '<button type="button" class="mc-go danger" data-act="resign-yes">Resign</button></div>';
    }
    return '<div class="mc-card mc-' + kind + '" role="dialog" aria-label="' + kind + '">' + h + '</div>';
  }
  function bigCap(g, side) {
    var b = 0;
    g.moves.forEach(function (m) { if ((side == null || m.side === side) && m.cap > b) b = m.cap; });
    return b;
  }
  function showCard(kind, back) {
    if (!S) return;
    if (kind && kind !== S.card && kind !== 'stats' && kind !== 'help' && kind !== 'confirm') S.cardFrom = null;
    if (kind === 'menu') {
      if (S.card !== 'menu') {
        var p = S.prefs;
        S.menu = { mode: p.mode, level: p.level, first: p.first, r: p.r, n: p.n, autoFlip: p.autoFlip };
      }
      S.cardBack = back !== false && !!(S.game && !S.game.result);
    }
    S.card = kind || null;
    S.root.classList.toggle('dim', !!kind);
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.root.style.minHeight = ''; renderAll(); return; }
    S.hover = null;
    S.ovl.innerHTML = cardHtml(kind);
    S.ovl.style.display = '';
    fitCard();
    S.ovl.scrollTop = 0;
    renderPad();
    if (!S.coarse) { var f = S.ovl.querySelector('.mc-go:last-of-type') || S.ovl.querySelector('.mc-go'); if (f && kind !== 'menu') { try { f.focus({ preventScroll: true }); } catch (e) {} } }
  }
  // The widget can be shorter than a menu card: let the card use the screen.
  function fitCard() {
    S.root.style.minHeight = '';
    var vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height) vh = Math.min(vh, vv.height);
    var top = S.root.getBoundingClientRect().top, card = S.ovl.firstChild;
    var want = Math.min((card ? card.scrollHeight : 0) + 20, vh - Math.max(0, top) - 12);
    if (want > S.root.offsetHeight) S.root.style.minHeight = Math.floor(want) + 'px';
  }
  function closeCard() {
    if (!S) return;
    var from = S.cardFrom;
    S.cardFrom = null;
    if (from) { showCard(from, S.cardBack); return; }
    if (S.card === 'menu' && !(S.game && !S.game.result) && !S.game) return;   // nothing to go back to
    showCard(null);
    maybeThink();
  }

  // ---- keys ----
  function moverPits() {
    var g = S.game, o = g.side * 7, out = [];
    for (var k = 0; k < 6; k++) out.push(o + k);
    // in screen order, left to right
    return rowOf(o) === bottomSide() ? out : out.reverse();
  }
  function onKey(e) {
    if (!S) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) { if (!S.card) { e.preventDefault(); undoMove(); } return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key, onBtn = t && t.tagName === 'BUTTON' && S.panel.contains(t);
    if (S.anim && (k === ' ' || k === 'Enter' || k === 'Escape')) { e.preventDefault(); skipAnim(); return; }
    if (k === 'Escape') {
      e.preventDefault();
      if (S.card) { if (S.card === 'result') showCard(null); else closeCard(); }
      else if (S.hint || S.cursor != null) { S.hint = null; S.cursor = null; S.kbd = false; renderAll(); }
      else if (S.view != null) navTo(S.game.moves.length);
      else closePanel();
      return;
    }
    if (S.card) {
      if ((k === 'Enter' || k === ' ') && S.card === 'menu' && !onBtn) { e.preventDefault(); startFromMenu(); }
      return;
    }
    var g = S.game, handled = true;
    if (!g) return;
    if (/^[1-6]$/.test(k)) {
      S.kbd = true;
      if (canAct()) tapPit(g.side * 7 + (+k - 1));
      else if (S.anim) skipAnim();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (!canAct()) { if (S.view != null || g.result) navTo(curPly() + (k === 'ArrowLeft' ? -1 : 1)); else handled = false; }
      else {
        var row = moverPits(), at = row.indexOf(S.cursor), lm = legal(g);
        if (at < 0) at = k === 'ArrowLeft' ? row.length : -1;
        do { at += k === 'ArrowLeft' ? -1 : 1; } while (at >= 0 && at < row.length && lm.indexOf(row[at]) < 0);
        if (at >= 0 && at < row.length) S.cursor = row[at];
        else if (S.cursor == null) S.cursor = lm[0];
        S.kbd = true; renderBoard(); renderStatus();
      }
    } else if ((k === 'Enter' || k === ' ') && !onBtn) {
      if (canAct()) {
        if (S.cursor == null || legal(g).indexOf(S.cursor) < 0) { S.kbd = true; S.cursor = moverPits().filter(function (p) { return legal(g).indexOf(p) >= 0; })[0]; renderBoard(); renderStatus(); }
        else tapPit(S.cursor);
      } else if (g.result && S.view == null) showCard('result');
    }
    else if (k === 'u' || k === 'U' || k === 'Backspace') undoMove();
    else if (k === 'h' || k === 'H' || k === '?') hint();
    else if (k === 'f' || k === 'F') flip();
    else if (k === 'n' || k === 'N' || k === 'm' || k === 'M') showCard('menu');
    else if (k === ',' || k === '<' || k === 'PageUp') navTo(curPly() - 1);
    else if (k === '.' || k === '>' || k === 'PageDown') navTo(curPly() + 1);
    else if (k === 'Home') navTo(0);
    else if (k === 'End') navTo(g.moves.length);
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---- layout ----
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 640, solo = S.panel.classList.contains('cade-solo-panel');
    S.phone = phone;
    S.root.classList.toggle('phone', phone);
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    var r = S.panel.getBoundingClientRect(), top = Math.min(Math.max(0, r.top || 50), 120), u;
    if (phone) u = Math.min((vw - 30) / 9.9, 50);
    else u = Math.min((Math.min(solo ? 1000 : 720, vw - 300)) / 9.9, solo ? 84 : 66);
    // keep the board, its bars, the status and the pad on screen
    var ph = phone ? 1.3 : 1, chrome = phone ? 300 : 210;
    u = Math.min(u, (vh - top - chrome) / (2 * ph + 1.6));
    u = Math.max(28, Math.floor(u));
    S.root.style.setProperty('--mc-u', u + 'px');
    S.root.style.setProperty('--mc-ph', String(ph));
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    S = null;
    clearTimeout(s.cpuT); clearTimeout(s.resizeT); clearTimeout(s.resT);
    if (s.anim) clearTimeout(s.anim.t);
    if (s.worker) { try { s.worker.terminate(); } catch (e) {} }
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    document.removeEventListener('visibilitychange', s.onVis);
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
    var body = '<div class="mc">' +
      '<div class="mc-main"><div class="mc-bar top"></div>' +
      '<div class="mc-stage"><div class="mc-board"></div><div class="mc-fx"><div class="mc-hand" aria-hidden="true"><b></b></div></div></div>' +
      '<div class="mc-bar bot"></div></div>' +
      '<div class="mc-side"><div class="mc-status" aria-live="polite"></div><div class="mc-moves"></div>' +
      '<div class="mc-nav"><button type="button" data-nav="first" title="Start (Home)" aria-label="First move">' + IC_FIRST + '</button>' +
      '<button type="button" data-nav="prev" title="Back (,)" aria-label="Previous move">' + IC_PREV + '</button>' +
      '<button type="button" data-nav="next" title="Forward (.)" aria-label="Next move">' + IC_NEXT + '</button>' +
      '<button type="button" data-nav="last" title="Back to the game (End)" aria-label="Latest move">' + IC_LAST + '</button></div></div>' +
      '<div class="mc-pad"><button type="button" data-act="undo" title="Undo (U)">' + IC_UNDO + '<span>Undo</span></button>' +
      '<button type="button" data-act="hint" title="Hint (H)">' + IC_HINT + '<span>Hint</span></button>' +
      '<button type="button" data-act="flip" title="Turn the board around (F)">' + IC_FLIP + '<span>Flip</span></button>' +
      '<button type="button" data-act="resign" title="Resign">' + IC_FLAG + '<span>Resign</span></button></div>' +
      '<div class="mc-ovl" style="display:none"></div><div class="mc-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🥜 Mancala', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'mc-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="New game (N)" aria-label="New game">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var root = p.querySelector('.mc'), mm = window.matchMedia;
    S = {
      panel: p, root: root, head: hb, stage: root.querySelector('.mc-stage'), boardEl: root.querySelector('.mc-board'),
      fx: root.querySelector('.mc-fx'), hand: root.querySelector('.mc-hand'), ovl: root.querySelector('.mc-ovl'),
      barTop: root.querySelector('.mc-bar.top'), barBot: root.querySelector('.mc-bar.bot'),
      status: root.querySelector('.mc-status'), movesEl: root.querySelector('.mc-moves'), nav: root.querySelector('.mc-nav'), pad: root.querySelector('.mc-pad'),
      liveEl: root.querySelector('.mc-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), prefs: normPrefs(sjson(PREFS_KEY)), stats: normStats(sjson(STATS_KEY)),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches), phone: false,
      game: null, view: null, viewB: null, hint: null, note: null, flip: false, face: 0, placed: -1, cursor: null, kbd: false, hover: null,
      thinking: false, hintBusy: false, anim: null, worker: null, noWorker: false, pending: {}, reqId: 0, cpuT: 0, cpuEval: 0, heldReply: null,
      card: null, cardBack: true, cardFrom: null, menu: null, resetArm: false
    };
    buildBoard();
    p._onClose = teardown;
    layout();

    var saved = normGame(sjson(GAME_KEY));
    if (saved) { S.game = saved; S.face = saved.side; }

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    // a hidden tab or a minimized panel finishes the sowing at once
    S.onVis = function () { if (S && document.hidden) skipAnim(); };
    document.addEventListener('visibilitychange', S.onVis);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { skipAnim(); S.hover = null; } });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        layout(); renderAll();
        if (S.heldReply) { var r = S.heldReply; S.heldReply = null; applyCpu(r); }
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); renderAll(); if (S.card) fitCard(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('click'); syncHead();
      } else if (h === 'help') {
        if (S.card === 'help') closeCard();
        else { S.cardFrom = S.card && S.card !== 'result' ? S.card : null; showCard('help', S.cardBack); }
      } else if (h === 'menu') {
        if (S.card === 'menu' && S.cardBack) closeCard(); else showCard('menu');
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout: the board
    // cancels its touches outright, the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.stage.addEventListener('touchstart', noTouch, { passive: false });
    S.stage.addEventListener('touchmove', noTouch, { passive: false });
    S.stage.addEventListener('touchend', noTouch, { passive: false });
    S.stage.addEventListener('contextmenu', noTouch);

    function cellAt(e) {
      var c = e.target.closest ? e.target.closest('[data-i]') : null;
      return c && S.boardEl.contains(c) ? +c.getAttribute('data-i') : -1;
    }
    S.stage.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      S.kbd = false;
      if (S.anim) { skipAnim(); return; }
      var i = cellAt(e);
      if (i < 0 || i === 6 || i === 13) { if (S.game && S.game.result && live() && !S.card) showCard('result'); return; }
      tapPit(i);
    });
    S.stage.addEventListener('pointermove', function (e) {
      if (!S || e.pointerType !== 'mouse') return;
      var i = cellAt(e), h = i >= 0 && i !== 6 && i !== 13 ? i : null;
      if (h !== S.hover) { S.hover = h; if (S.kbd && h != null) S.kbd = false; renderBoard(); renderStatus(); }
    });
    S.stage.addEventListener('pointerleave', function () { if (S && S.hover != null) { S.hover = null; renderBoard(); renderStatus(); } });

    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (S.card && S.card !== 'result') { if (S.card === 'menu' && !S.cardBack) return; showCard(null); }
      else if (S.card === 'result') showCard(null);
      if (a === 'undo') undoMove();
      else if (a === 'hint') hint();
      else if (a === 'flip') flip();
      else if (a === 'resign') showCard('confirm');
    });
    S.nav.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || !S.game) return;
      var n = b.getAttribute('data-nav');
      if (S.card === 'result') showCard(null);
      navTo(n === 'first' ? 0 : n === 'prev' ? curPly() - 1 : n === 'next' ? curPly() + 1 : S.game.moves.length);
    });
    S.movesEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ply]') : null;
      if (!b || !S) return;
      if (S.card === 'result') showCard(null);
      navTo(+b.getAttribute('data-ply'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var m = S.menu, a = b.getAttribute('data-act'), redo = false;
      if (b.hasAttribute('data-mode')) { m.mode = b.getAttribute('data-mode'); redo = true; }
      else if (b.hasAttribute('data-level')) { m.level = +b.getAttribute('data-level'); redo = true; }
      else if (b.hasAttribute('data-first')) { m.first = b.getAttribute('data-first'); redo = true; }
      else if (b.hasAttribute('data-r')) { m.r = b.getAttribute('data-r'); redo = true; }
      else if (b.hasAttribute('data-n')) { m.n = +b.getAttribute('data-n'); redo = true; }
      else if (b.hasAttribute('data-af')) { m.autoFlip = b.getAttribute('data-af') === '1'; redo = true; }
      else if (b.hasAttribute('data-speed')) { S.prefs.speed = b.getAttribute('data-speed'); persistPrefs(); redo = true; }
      else if (a === 'start') startFromMenu();
      else if (a === 'close') closeCard();
      else if (a === 'help') { S.cardFrom = S.card; showCard('help', S.cardBack); }
      else if (a === 'stats') { S.resetArm = false; var fr = S.card; showCard('stats', S.cardBack); S.cardFrom = fr; }
      else if (a === 'back') closeCard();
      else if (a === 'confirm') { var fr2 = S.card; showCard('confirm', S.cardBack); S.cardFrom = fr2; }
      else if (a === 'reset') { S.resetArm = true; showCard('stats', S.cardBack); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('stats', S.cardBack); }
      else if (a === 'reset-yes') { S.stats = newStats(); persistStats(); S.resetArm = false; toast('Records reset'); showCard('stats', S.cardBack); }
      else if (a === 'rematch') rematch();
      else if (a === 'next') { var g = S.game; startGame({ mode: 'cpu', level: g.level + 1, first: g.human === 0 ? 'me' : 'cpu', r: g.r, n: g.n }); }
      else if (a === 'review') { showCard(null); navTo(0); }
      else if (a === 'menu') showCard('menu', false);
      else if (a === 'resign-yes') resign();
      if (redo) { sfx('click'); var keep = S.cardFrom; showCard('menu', S.cardBack); S.cardFrom = keep; }
      if (b.isConnected) return;
      var sel = ['data-mode', 'data-level', 'data-first', 'data-r', 'data-n', 'data-af', 'data-speed'].filter(function (x) { return b.hasAttribute(x); })[0];
      if (sel && e.detail === 0) { var nb = S.ovl.querySelector('[' + sel + '="' + b.getAttribute(sel) + '"]'); if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
    });

    syncHead();
    renderAll();
    if (S.game && !S.game.result) maybeThink();
    else if (!sget(PREFS_KEY) && !sget(STATS_KEY)) {
      // first visit: the rules, then the menu
      showCard('menu', false); S.cardFrom = 'menu'; showCard('help', false);
    } else showCard('menu', false);
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); renderAll(); if (S.card) fitCard(); } });
    setTimeout(function () { if (S && S.panel === p && S.card) fitCard(); }, 400);   // after the web fonts settle
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Sow the seeds, capture, and fill your store — vs CPU or pass-and-play',
    icon: '🥜',
    tags: 'game,board,mancala,kalah,oware,awale,seeds,sowing,2 player,cpu',
    open: open,
    _engine: ENGINE
  });
})();
