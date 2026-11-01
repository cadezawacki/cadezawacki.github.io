/* Checkers — 8x8 draughts for Cade.txt.
 * American rules: men move and jump diagonally forward, kings both ways one
 * square; captures are forced and a multi-jump must be finished (any route you
 * like, not necessarily the longest); a man that jumps onto the far row is
 * crowned and the move ends there. You win when the other side has no move
 * (no pieces, or every piece blocked). Draw by threefold repetition or the
 * 40-move rule (40 moves each with no capture and no man moved).
 * Variant "Flying kings" (international rules on 8x8): men also jump
 * backwards, kings fly along the diagonals, and you must take the most pieces.
 * Play vs the computer (six levels: an alpha-beta search with iterative
 * deepening, a transposition table and a positional evaluation, run in a Web
 * Worker built from this very file so the board never freezes) or pass-and-play
 * on one device. Move highlighting, multi-jump route choice, undo, hints, a
 * move list you can step back through, autosave / resume and records.
 * The board is DOM (a monospace-glyph look, theme colours); saves live in
 * Cade.store under cade-checkers-*. Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // Squares are numbered 0..31 (standard notation 1..32 = index + 1). Row 0 is
  // the top of the standard diagram; Red (side 1) starts on 1-12 and moves first
  // (down the board), White (side -1) starts on 21-32. Pieces: ±1 man, ±2 king.
  var RED = 1, WHITE = -1, WIN = 100000;
  var ROW = [], COL = [], NB = [], RAY = [];
  var DR = [-1, -1, 1, 1], DC = [-1, 1, -1, 1];
  function sqAt(r, c) { return (r < 0 || r > 7 || c < 0 || c > 7 || ((r + c) & 1) === 0) ? -1 : r * 4 + (c >> 1); }
  (function () {
    for (var i = 0; i < 32; i++) {
      var r = i >> 2, c = 2 * (i & 3) + ((r & 1) ? 0 : 1);
      ROW[i] = r; COL[i] = c; NB[i] = []; RAY[i] = [];
      for (var d = 0; d < 4; d++) {
        NB[i][d] = sqAt(r + DR[d], c + DC[d]);
        var ray = [];
        for (var k = 1; sqAt(r + DR[d] * k, c + DC[d] * k) >= 0; k++) ray.push(sqAt(r + DR[d] * k, c + DC[d] * k));
        RAY[i][d] = ray;
      }
    }
  })();
  var FWD = { 1: [2, 3], '-1': [0, 1] }, ALL = [0, 1, 2, 3];

  var VARIANTS = {
    american: { id: 'american', name: 'American', back: false, fly: false, maxCap: false, stopCrown: true, king: 135, info: 'men move & jump forward; kings one square; any capture route' },
    flying: { id: 'flying', name: 'Flying kings', back: true, fly: true, maxCap: true, stopCrown: false, king: 290, info: 'men jump backwards too; kings fly; take the most pieces' }
  };
  function V(v) { return VARIANTS[v] || VARIANTS.american; }

  function initBoard() {
    var b = [];
    for (var i = 0; i < 32; i++) b.push(i < 12 ? RED : i >= 20 ? WHITE : 0);
    return b;
  }
  function promoSq(sq, side) { return side === RED ? sq >= 28 : sq < 4; }

  // ---- move generation ----
  // A move: { from, to, path: [squares visited, from first], caps: [squares jumped] }.
  // Jumped pieces stay on the board until the move ends (they block, and can't be
  // jumped twice), the mover's own square is free to pass through.
  function genMoves(b, side, vid) {
    var vr = V(vid), caps = [], i, p;
    for (i = 0; i < 32; i++) {
      p = b[i];
      if (p * side > 0) capFrom(b, i, side, p === 2 * side, vr, caps);
    }
    if (caps.length) {
      if (vr.maxCap) {
        var mx = 0, j;
        for (j = 0; j < caps.length; j++) if (caps[j].caps.length > mx) mx = caps[j].caps.length;
        caps = caps.filter(function (m) { return m.caps.length === mx; });
      }
      return caps;
    }
    var out = [];
    for (i = 0; i < 32; i++) {
      p = b[i];
      if (p * side <= 0) continue;
      var king = p === 2 * side, dirs = king ? ALL : FWD[side];
      for (var k = 0; k < dirs.length; k++) {
        var d = dirs[k];
        if (king && vr.fly) {
          var ray = RAY[i][d];
          for (var q = 0; q < ray.length && b[ray[q]] === 0; q++) out.push({ from: i, to: ray[q], path: [i, ray[q]], caps: [] });
        } else {
          var n = NB[i][d];
          if (n >= 0 && b[n] === 0) out.push({ from: i, to: n, path: [i, n], caps: [] });
        }
      }
    }
    return out;
  }
  function capFrom(b, from, side, king, vr, out) {
    var pc = b[from], path = [from], capd = [];
    b[from] = 0;
    function taken(sq) { for (var t = 0; t < capd.length; t++) if (capd[t] === sq) return true; return false; }
    function dfs(sq, kg) {
      var found = false, dirs = kg || vr.back ? ALL : FWD[side];
      for (var k = 0; k < dirs.length; k++) {
        var d = dirs[k];
        if (kg && vr.fly) {
          var ray = RAY[sq][d], q = 0;
          while (q < ray.length && b[ray[q]] === 0) q++;
          if (q >= ray.length) continue;
          var o2 = ray[q];
          if (b[o2] * side >= 0 || taken(o2)) continue;
          for (q++; q < ray.length && b[ray[q]] === 0; q++) {
            found = true;
            capd.push(o2); path.push(ray[q]);
            dfs(ray[q], true);
            capd.pop(); path.pop();
          }
        } else {
          var o = NB[sq][d];
          if (o < 0 || b[o] * side >= 0 || taken(o)) continue;
          var l = NB[o][d];
          if (l < 0 || b[l] !== 0) continue;
          found = true;
          capd.push(o); path.push(l);
          if (!kg && promoSq(l, side) && vr.stopCrown) record(l);
          else dfs(l, kg);
          capd.pop(); path.pop();
        }
      }
      if (!found && capd.length) record(sq);
    }
    function record(sq) { out.push({ from: from, to: sq, path: path.slice(), caps: capd.slice() }); }
    dfs(from, king);
    b[from] = pc;
  }
  // Can `side` capture anything right now? (cheap: no routes)
  function canCapture(b, side, vid) {
    var vr = V(vid);
    for (var i = 0; i < 32; i++) {
      var p = b[i];
      if (p * side <= 0) continue;
      var king = p === 2 * side, dirs = king || vr.back ? ALL : FWD[side];
      for (var k = 0; k < dirs.length; k++) {
        var d = dirs[k];
        if (king && vr.fly) {
          var ray = RAY[i][d], q = 0;
          while (q < ray.length && b[ray[q]] === 0) q++;
          if (q + 1 < ray.length && b[ray[q]] * side < 0 && b[ray[q + 1]] === 0) return true;
        } else {
          var o = NB[i][d];
          if (o >= 0 && b[o] * side < 0) { var l = NB[o][d]; if (l >= 0 && b[l] === 0) return true; }
        }
      }
    }
    return false;
  }
  // Apply / take back on a board array. Returns an undo record.
  function makeMove(b, m) {
    var pc = b[m.from], cv = [], side = pc > 0 ? 1 : -1;
    b[m.from] = 0;
    for (var i = 0; i < m.caps.length; i++) { cv.push(b[m.caps[i]]); b[m.caps[i]] = 0; }
    var promo = (pc === 1 || pc === -1) && promoSq(m.to, side);
    b[m.to] = promo ? pc * 2 : pc;
    return { pc: pc, cv: cv, promo: promo };
  }
  function unmakeMove(b, m, u) {
    b[m.to] = 0;
    for (var i = 0; i < m.caps.length; i++) b[m.caps[i]] = u.cv[i];
    b[m.from] = u.pc;
  }
  function samePath(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function findMove(moves, path) {
    for (var i = 0; i < moves.length; i++) if (samePath(moves[i].path, path)) return moves[i];
    return null;
  }
  function notation(m) {
    if (!m) return '';
    if (m.caps && m.caps.length) return m.path.map(function (s) { return s + 1; }).join('x');
    return (m.from + 1) + '-' + (m.to + 1);
  }

  // ---- hashing (Zobrist, two 32-bit halves) ----
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var ZL = new Int32Array(32 * 5), ZH = new Int32Array(32 * 5), ZSL, ZSH;
  (function () {
    var r = rng(20240611);
    for (var i = 0; i < ZL.length; i++) { ZL[i] = (r() * 4294967296) | 0; ZH[i] = (r() * 4294967296) | 0; }
    ZSL = (r() * 4294967296) | 0; ZSH = (r() * 4294967296) | 0;
  })();
  var HL = 0, HH = 0;   // last hash (out-params of hashPos)
  function hashPos(b, side) {
    var lo = side === RED ? ZSL : 0, hi = side === RED ? ZSH : 0;
    for (var i = 0; i < 32; i++) {
      var p = b[i];
      if (p) { var k = i * 5 + p + 2; lo ^= ZL[k]; hi ^= ZH[k]; }
    }
    HL = lo; HH = hi;
    return lo;
  }
  function posKey(b, side) { hashPos(b, side); return (HH >>> 0).toString(36) + '.' + (HL >>> 0).toString(36); }

  // ---- evaluation (centipieces, from Red's point of view) ----
  var ADV = [0, 0, 1, 2, 4, 7, 11, 0];
  var CEN = [], KC = [];
  (function () {
    for (var i = 0; i < 32; i++) {
      var r = ROW[i], c = COL[i];
      var dc = Math.min(c, 7 - c), dr = Math.min(r, 7 - r);
      CEN[i] = (dc >= 2 && dr >= 2) ? 5 : (dc >= 1 && dr >= 1) ? 1 : (c === 0 || c === 7) ? -3 : 0;
      KC[i] = Math.min(dc, 3) * 3 + Math.min(dr, 3) * 3 - ((i === 3 || i === 28) ? 8 : 0);   // single corners trap kings
    }
  })();
  function evaluate(b, vid) {
    var vr = V(vid), mr = 0, mw = 0, kr = 0, kw = 0, pos = 0, i, p;
    for (i = 0; i < 32; i++) {
      p = b[i];
      if (!p) continue;
      if (p === 1) { mr++; pos += ADV[ROW[i]] + CEN[i]; }
      else if (p === -1) { mw++; pos -= ADV[7 - ROW[i]] + CEN[i]; }
      else if (p === 2) { kr++; pos += KC[i]; }
      else { kw++; pos -= KC[i]; }
    }
    var n = mr + mw + kr + kw, matR = mr * 100 + kr * vr.king, matW = mw * 100 + kw * vr.king, mat = matR - matW;
    if (n <= 14) pos = pos * 3 >> 1;                                 // racing to crown matters more late
    // the back rank keeps the other side from crowning — while they have no kings
    if (!kw && n > 12) {
      if (b[0] === 1) pos += 4; if (b[2] === 1) pos += 4; if (b[1] === 1) pos += 3;
      if (b[0] === 1 && b[2] === 1) pos += 6;
    }
    if (!kr && n > 12) {
      if (b[31] === -1) pos -= 4; if (b[29] === -1) pos -= 4; if (b[30] === -1) pos -= 3;
      if (b[31] === -1 && b[29] === -1) pos -= 6;
    }
    var s = mat + pos;
    if (mat) {
      // ahead: trade down. And with kings, go and hunt the rest down.
      s += (mat > 0 ? 1 : -1) * (24 - n) * 4;
      if (n <= 10) {
        var winSide = mat > 0 ? 2 : -2, prox = 0;
        for (i = 0; i < 32; i++) {
          if (b[i] !== winSide) continue;
          var best = 9;
          for (var j = 0; j < 32; j++) {
            if (b[j] * winSide >= 0) continue;
            var dd = Math.max(Math.abs(ROW[i] - ROW[j]), Math.abs(COL[i] - COL[j]));
            if (dd < best) best = dd;
          }
          prox += 9 - best;
        }
        s += (mat > 0 ? 1 : -1) * prox * 2;
      }
    }
    return s;
  }

  // ---- search: negamax alpha-beta, iterative deepening, TT, history ----
  var TT_BITS = 18, TT_N = 1 << TT_BITS, TT_MASK = TT_N - 1;
  var ttL = null, ttH, ttD, ttF, ttS, ttM, ttVar = null;
  function ttInit(vid) {
    vid = V(vid).id;
    // the hash does not include the rules: a table filled under one variant must not answer for the other
    if (ttL && ttVar !== vid) { ttL.fill(0); ttH.fill(0); ttD.fill(0); ttF.fill(0); ttS.fill(0); ttM.fill(0); }
    ttVar = vid;
    if (ttL) return;
    ttL = new Int32Array(TT_N); ttH = new Int32Array(TT_N); ttD = new Int8Array(TT_N); ttF = new Int8Array(TT_N);
    ttS = new Int32Array(TT_N); ttM = new Int32Array(TT_N);
  }
  function mcode(m) { return 1 + m.from + (m.path[1] << 5) + (m.to << 10) + (m.path.length << 15); }

  var LEVELS = [
    { id: 1, name: 'Novice', depth: 2, margin: 110, time: 400 },
    { id: 2, name: 'Casual', depth: 3, margin: 45, time: 500 },
    { id: 3, name: 'Club', depth: 5, margin: 14, time: 700 },
    { id: 4, name: 'Strong', depth: 12, time: 350 },
    { id: 5, name: 'Expert', depth: 30, time: 1000 },
    { id: 6, name: 'Master', depth: 48, time: 3000 }
  ];
  function levelOf(n) { n = Math.round(+n); if (!isFinite(n)) n = 3; return LEVELS[Math.max(1, Math.min(6, n)) - 1]; }

  // pos: { b, side, v, quiet, hist: [{lo, hi}] (positions since the last irreversible move, oldest first) }
  // opts: { depth, time, now, margin, seed, plain }  plain: no extensions/TT/repetition (for tests)
  function search(pos, opts) {
    opts = opts || {};
    ttInit(pos.v);
    var b = pos.b.slice(), side0 = pos.side, vid = pos.v, plain = !!opts.plain;
    var now = opts.now || function () { return Date.now(); };
    var t0 = now(), deadline = opts.time ? t0 + opts.time : Infinity, maxD = Math.max(1, opts.depth || 64);
    var rootBest = null, nodes = 0, stop = false, hist = new Int32Array(32 * 32 * 2);
    var stL = [], stH = [], stI = [], quietSt = [];     // position stack: hash, irreversible-arrival, quiet count
    var hp = pos.hist || [];
    for (var h = 0; h < hp.length; h++) { stL.push(hp[h].lo | 0); stH.push(hp[h].hi | 0); stI.push(h === 0 ? 1 : 0); quietSt.push(0); }
    hashPos(b, side0);
    stL.push(HL); stH.push(HH); stI.push(hp.length ? 0 : 1); quietSt.push(pos.quiet | 0);
    var rootIdx = stL.length - 1;

    function repeated() {
      var top = stL.length - 1, L = stL[top], H = stH[top];
      for (var k = top - 2; k >= 0; k -= 2) {
        if (stL[k] === L && stH[k] === H) return true;
        if (stI[k] || stI[k + 1]) break;
      }
      return false;
    }
    function order(moves, side, ttm) {
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        m.o = mcode(m) === ttm ? 1e9 : m.caps.length * 100000 + hist[(side > 0 ? 1024 : 0) + m.from * 32 + m.to] +
          ((b[m.from] === side) && promoSq(m.to, side) ? 50000 : 0);
      }
      moves.sort(function (x, y) { return y.o - x.o; });
    }
    function negamax(depth, alpha, beta, ply, side) {
      nodes++;
      if ((nodes & 1023) === 0 && now() > deadline) stop = true;
      if (stop) return 0;
      var moves = genMoves(b, side, vid);
      if (!moves.length) return -WIN + ply;
      if (!plain && ply > 0) {
        if (repeated()) return 0;
        if (quietSt[quietSt.length - 1] >= 80) return 0;
      }
      var capt = moves[0].caps.length > 0;
      if (!plain) {
        if (moves.length === 1 && ply < 40) depth++;                     // forced: look further
        if (depth <= 0 && !capt && ply < 48 && canCapture(b, -side, vid)) depth = 1;   // quiescence: the threat is pending
      }
      if (depth <= 0 && (plain || !capt || ply >= 60)) return side * evaluate(b, vid);
      var top = stL.length - 1, slot = stL[top] & TT_MASK, ttm = 0, a0 = alpha;
      if (!plain && ttL[slot] === stL[top] && ttH[slot] === stH[top]) {
        ttm = ttM[slot];
        if (ttD[slot] >= depth && ply > 0) {
          var ts = ttS[slot];
          if (ts > WIN - 1000) ts -= ply; else if (ts < -WIN + 1000) ts += ply;
          var f = ttF[slot];
          if (f === 0) return ts;
          if (f === 1 && ts >= beta) return ts;
          if (f === 2 && ts <= alpha) return ts;
        }
      }
      order(moves, side, ttm);
      var best = -Infinity, bestM = null;
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i], u = makeMove(b, m);
        hashPos(b, -side);
        stL.push(HL); stH.push(HH);
        var irr = m.caps.length > 0 || u.pc === side;
        stI.push(irr ? 1 : 0); quietSt.push(irr ? 0 : quietSt[quietSt.length - 1] + 1);
        var sc;
        if (i === 0 || plain) sc = -negamax(depth - 1, -beta, -alpha, ply + 1, -side);
        else {
          sc = -negamax(depth - 1, -alpha - 1, -alpha, ply + 1, -side);
          if (sc > alpha && sc < beta && !stop) sc = -negamax(depth - 1, -beta, -alpha, ply + 1, -side);
        }
        stL.pop(); stH.pop(); stI.pop(); quietSt.pop();
        unmakeMove(b, m, u);
        if (stop) return 0;
        if (sc > best) { best = sc; bestM = m; if (ply === 0) rootBest = m; }
        if (sc > alpha) alpha = sc;
        if (alpha >= beta) {
          if (!m.caps.length) hist[(side > 0 ? 1024 : 0) + m.from * 32 + m.to] += depth * depth;
          break;
        }
      }
      if (!plain && depth >= 0) {
        var ss = best;
        if (ss > WIN - 1000) ss += ply; else if (ss < -WIN + 1000) ss -= ply;
        ttL[slot] = stL[top]; ttH[slot] = stH[top]; ttD[slot] = Math.min(127, depth); ttS[slot] = ss; ttM[slot] = mcode(bestM);
        ttF[slot] = best <= a0 ? 2 : best >= beta ? 1 : 0;
      }
      return best;
    }

    var rootMoves = genMoves(b, side0, vid);
    var res = { move: null, path: null, score: 0, depth: 0, nodes: 0, time: 0, moves: rootMoves.length };
    if (!rootMoves.length) { res.score = -WIN; return res; }
    if (rootMoves.length === 1 && opts.margin == null && !opts.full && !plain) {
      res.move = rootMoves[0]; res.path = rootMoves[0].path.slice(); res.score = side0 * evaluate(b, vid);
      return res;
    }
    if (opts.margin != null || opts.full) {
      // score every root move with a full window (weaker levels pick among the near-best)
      var d0 = Math.min(maxD, opts.depth || 3), scored = null;
      for (var dd = 1; dd <= d0 && !stop; dd++) {
        var cur = [];
        for (var r = 0; r < rootMoves.length && !stop; r++) {
          var m0 = rootMoves[r], u0 = makeMove(b, m0);
          hashPos(b, -side0); stL.push(HL); stH.push(HH);
          var irr0 = m0.caps.length > 0 || u0.pc === side0;
          stI.push(irr0 ? 1 : 0); quietSt.push(irr0 ? 0 : (pos.quiet | 0) + 1);
          var sc0 = -negamax(dd - 1, -WIN - 1, WIN + 1, 1, -side0);
          stL.pop(); stH.pop(); stI.pop(); quietSt.pop();
          unmakeMove(b, m0, u0);
          if (!stop) cur.push({ m: m0, s: sc0 });
        }
        if (!stop || !scored) { scored = cur; res.depth = dd; }
      }
      if (!scored || !scored.length) scored = rootMoves.map(function (mm) { return { m: mm, s: 0 }; });
      var top = -Infinity;
      scored.forEach(function (x) { if (x.s > top) top = x.s; });
      var mg = opts.margin || 0, pool = scored.filter(function (x) { return x.s >= top - mg && (top < WIN - 1000 || x.s > WIN - 1000); });
      var rnd = rng(opts.seed == null ? 1 : opts.seed), pick = pool[Math.floor(rnd() * pool.length)] || scored[0];
      res.move = pick.m; res.path = pick.m.path.slice(); res.score = pick.s; res.best = top; res.scored = scored;
    } else {
      var bestMove = rootMoves[0], bestScore = 0;
      for (var depth = 1; depth <= maxD; depth++) {
        rootBest = null;
        var sc2 = negamax(depth, -WIN - 1, WIN + 1, 0, side0);
        if (stop && depth > 1) break;
        bestScore = sc2; res.depth = depth;
        if (rootBest) bestMove = rootBest;
        if (Math.abs(sc2) > WIN - 1000) break;                  // a forced win/loss found: deeper adds nothing
        if (stop) break;
        if (opts.time && now() - t0 > opts.time * 0.55) break;   // the next iteration would not finish
      }
      res.move = bestMove; res.path = bestMove.path.slice(); res.score = bestScore;
    }
    res.nodes = nodes; res.time = now() - t0;
    return res;
  }
  // Plain minimax (no pruning) — the reference the alpha-beta is checked against.
  function minimax(b, side, vid, depth) {
    var moves = genMoves(b, side, vid);
    if (!moves.length) return -WIN;
    if (depth <= 0) return side * evaluate(b, vid);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var u = makeMove(b, moves[i]);
      var s = -minimax(b, -side, vid, depth - 1);
      unmakeMove(b, moves[i], u);
      if (s > best) best = s;
    }
    return best;
  }
  function perft(b, side, vid, depth) {
    if (depth === 0) return 1;
    var moves = genMoves(b, side, vid), n = 0;
    if (depth === 1) return moves.length;
    for (var i = 0; i < moves.length; i++) {
      var u = makeMove(b, moves[i]);
      n += perft(b, -side, vid, depth - 1);
      unmakeMove(b, moves[i], u);
    }
    return n;
  }

  // ---- a game ----
  function newGame(vid, board, side) {
    var g = { v: V(vid).id, b: board ? board.slice() : initBoard(), side: side === WHITE ? WHITE : RED, moves: [], boards: [], keys: [], quiet: 0, result: null };
    g.boards.push(g.b.slice());
    g.keys.push(posKey(g.b, g.side));
    g.hl = [{ lo: HL, hi: HH, irr: true }];
    return g;
  }
  function legal(g) { return g.result ? [] : genMoves(g.b, g.side, g.v); }
  function counts(b) {
    var c = { rm: 0, rk: 0, wm: 0, wk: 0 };
    for (var i = 0; i < 32; i++) { var p = b[i]; if (p === 1) c.rm++; else if (p === 2) c.rk++; else if (p === -1) c.wm++; else if (p === -2) c.wk++; }
    return c;
  }
  function outcome(g) {
    var moves = genMoves(g.b, g.side, g.v);
    if (!moves.length) {
      var c = counts(g.b), mine = g.side === RED ? c.rm + c.rk : c.wm + c.wk;
      return { winner: -g.side, reason: mine ? 'blocked' : 'captured' };
    }
    var key = g.keys[g.keys.length - 1], n = 0;
    for (var i = g.keys.length - 1; i >= 0; i--) {
      if (g.keys[i] === key) n++;
      if (g.hl[i].irr) break;
    }
    if (n >= 3) return { winner: 0, reason: 'repetition' };
    if (g.quiet >= 80) return { winner: 0, reason: 'forty' };
    return null;
  }
  // Play the move with this path (validated). Returns the move record or null.
  function play(g, path) {
    if (g.result) return null;
    var m = findMove(genMoves(g.b, g.side, g.v), path);
    if (!m) return null;
    var u = makeMove(g.b, m), irr = m.caps.length > 0 || u.pc === g.side;
    var rec = { path: m.path.slice(), caps: m.caps.slice(), from: m.from, to: m.to, side: g.side, pc: u.pc, cv: u.cv, promo: u.promo, quiet0: g.quiet, n: notation(m) };
    g.moves.push(rec);
    g.quiet = irr ? 0 : g.quiet + 1;
    g.side = -g.side;
    g.boards.push(g.b.slice());
    g.keys.push(posKey(g.b, g.side));
    g.hl.push({ lo: HL, hi: HH, irr: irr });
    g.result = outcome(g);
    return rec;
  }
  function undo(g) {
    var rec = g.moves.pop();
    if (!rec) return null;
    g.boards.pop(); g.keys.pop(); g.hl.pop();
    g.b = g.boards[g.boards.length - 1].slice();
    g.side = rec.side; g.quiet = rec.quiet0; g.result = null;
    return rec;
  }
  function endGame(g, winner, reason) { if (!g.result) g.result = { winner: winner, reason: reason }; return g.result; }
  // Search input for the current position.
  function searchPos(g) {
    var hist = [], i = g.hl.length - 1;
    while (i > 0 && !g.hl[i].irr) i--;
    for (var k = i; k < g.hl.length - 1; k++) hist.push({ lo: g.hl[k].lo, hi: g.hl[k].hi });
    return { b: g.b.slice(), side: g.side, v: g.v, quiet: g.quiet, hist: hist };
  }
  // A custom starting position { b: [32 pieces], side } (set-ups), or null for the usual start.
  function normStart(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.b) || st.b.length !== 32) return null;
    var b = st.b.map(function (x) { x = Math.round(+x); return x >= -2 && x <= 2 ? x : 0; });
    return { b: b, side: st.side === WHITE ? WHITE : RED };
  }
  function replay(vid, paths, start) {
    start = normStart(start);
    var g = start ? newGame(vid, start.b, start.side) : newGame(vid), ok = true;
    if (start) g.start = start;
    if (Array.isArray(paths)) {
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (!Array.isArray(p) || !play(g, p.map(function (x) { return x | 0; }))) { ok = false; break; }
      }
    }
    g.ok = ok;
    return g;
  }
  function levelSearchOpts(level, seed) {
    var L = levelOf(level), o = { depth: L.depth, time: L.time, seed: seed >>> 0 };
    if (L.margin != null) o.margin = L.margin;
    return o;
  }
  // Worker / local request: { id, v, moves:[paths], level, seed, hint, time } → { id, path, score, depth, nodes, time }
  function handle(msg) {
    msg = msg || {};
    var g = replay(msg.v, msg.moves || [], msg.start);
    if (g.result) return { id: msg.id, path: null, done: true };
    var o = msg.hint ? { depth: 40, time: Math.max(150, Math.min(4000, msg.time || 800)) } : levelSearchOpts(msg.level, msg.seed || 1);
    if (msg.timeCap) o.time = Math.min(o.time, msg.timeCap);
    var r = search(searchPos(g), o);
    return { id: msg.id, path: r.path, score: r.score, depth: r.depth, nodes: r.nodes, time: r.time };
  }

  // ---- saves ----
  var MODES = { cpu: 1, pvp: 1 };
  function newStats() {
    var lv = {};
    for (var i = 1; i <= 6; i++) lv[i] = { w: 0, l: 0, d: 0, fast: 0 };
    return { lv: lv, pvp: { n: 0, r: 0, w: 0, d: 0 }, streak: 0, bestStreak: 0, games: 0 };
  }
  function nn(x) { x = Math.floor(+x); return isFinite(x) && x > 0 ? x : 0; }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    for (var i = 1; i <= 6; i++) {
      var l = o.lv && o.lv[i];
      if (l && typeof l === 'object') s.lv[i] = { w: nn(l.w), l: nn(l.l), d: nn(l.d), fast: nn(l.fast) };
    }
    if (o.pvp && typeof o.pvp === 'object') s.pvp = { n: nn(o.pvp.n), r: nn(o.pvp.r), w: nn(o.pvp.w), d: nn(o.pvp.d) };
    s.streak = nn(o.streak); s.bestStreak = Math.max(nn(o.bestStreak), s.streak); s.games = nn(o.games);
    return s;
  }
  // Record a finished game. g: game, info: { mode, level, human }. Returns { won, lost, draw, best }.
  function recordResult(st, g, info) {
    var r = g.result, out = { won: false, lost: false, draw: false, newStreak: false, fast: false };
    if (!r) return out;
    st.games++;
    if (info.mode === 'pvp') {
      st.pvp.n++;
      if (r.winner === RED) st.pvp.r++; else if (r.winner === WHITE) st.pvp.w++; else st.pvp.d++;
      return out;
    }
    var l = st.lv[levelOf(info.level).id], mv = Math.ceil(g.moves.length / 2);
    if (r.winner === 0) { l.d++; out.draw = true; }
    else if (r.winner === info.human) {
      l.w++; out.won = true; st.streak++;
      if (st.streak > st.bestStreak) { st.bestStreak = st.streak; out.newStreak = st.streak > 1; }
      if (!l.fast || mv < l.fast) { out.fast = !!l.fast; l.fast = mv; }
    } else { l.l++; out.lost = true; st.streak = 0; }
    return out;
  }
  function normPrefs(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      mode: MODES[o.mode] ? o.mode : 'cpu',
      level: levelOf(o.level == null ? 3 : o.level).id,
      color: o.color === 'w' || o.color === 'x' ? o.color : 'r',
      v: VARIANTS[o.v] ? o.v : 'american',
      autoFlip: !!o.autoFlip,
      nums: o.nums !== false,
      fast: !!o.fast
    };
  }
  // A saved game: { v, mode, level, human, moves:[paths], id, t, undos, hints, recorded, result? }
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.moves)) return null;
    var g = replay(o.v, o.moves.slice(0, 2000), o.start);
    g.mode = MODES[o.mode] ? o.mode : 'cpu';
    g.level = levelOf(o.level).id;
    g.human = o.human === WHITE ? WHITE : RED;
    g.id = nn(o.id) || 1; g.t = nn(o.t); g.undos = nn(o.undos); g.hints = nn(o.hints);
    g.autoFlip = !!o.autoFlip;
    g.recorded = !!o.recorded;
    if (!g.result && o.result && typeof o.result === 'object' && (o.result.reason === 'resign' || o.result.reason === 'agreed')) {
      var w = o.result.winner === RED ? RED : o.result.winner === WHITE ? WHITE : 0;
      g.result = { winner: w, reason: o.result.reason };
    }
    return g;
  }
  function gameSave(g) {
    return {
      v: g.v, start: g.start || undefined, mode: g.mode, level: g.level, human: g.human, moves: g.moves.map(function (m) { return m.path; }),
      id: g.id, t: g.t, undos: g.undos, hints: g.hints, autoFlip: g.autoFlip, recorded: !!g.recorded,
      result: g.result && (g.result.reason === 'resign' || g.result.reason === 'agreed') ? g.result : undefined
    };
  }

  var ENGINE = {
    RED: RED, WHITE: WHITE, WIN: WIN, VARIANTS: VARIANTS, LEVELS: LEVELS, ROW: ROW, COL: COL, NB: NB,
    sqAt: sqAt, initBoard: initBoard, genMoves: genMoves, canCapture: canCapture, makeMove: makeMove, unmakeMove: unmakeMove,
    findMove: findMove, samePath: samePath, notation: notation, posKey: posKey, evaluate: evaluate, search: search, minimax: minimax,
    perft: perft, newGame: newGame, legal: legal, play: play, undo: undo, endGame: endGame, outcome: outcome, counts: counts,
    searchPos: searchPos, replay: replay, normStart: normStart, levelOf: levelOf, levelSearchOpts: levelSearchOpts, handle: handle, rng: rng,
    newStats: newStats, normStats: normStats, recordResult: recordResult, normPrefs: normPrefs, normGame: normGame, gameSave: gameSave
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  // Loaded as a Web Worker (new Worker('checkers.js')): answer search requests.
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
  Cade.loadCSS('checkers.css');
  var WORKER_URL = Cade.asset('checkers.js');

  var PANEL_ID = 'checkers-panel', NAME = 'Checkers';
  var KEY = 'cade-checkers-', GAME_KEY = KEY + 'game', STATS_KEY = KEY + 'stats', PREFS_KEY = KEY + 'prefs', SOUND_KEY = KEY + 'sound';
  var S = null;
  if (window.__CADE_UNIT__) {
    window.__CADE_UNIT__.checkers = {     // test-only peek: the live session, and a way to set up a position
      live: function () { return S; },
      setup: function (board, side, o) {
        if (!S) return;
        o = o || {};
        startGame({ mode: o.mode || 'cpu', level: o.level || 1, color: o.color || 'r', v: o.v || 'american', autoFlip: !!o.autoFlip });
        cancelThink();
        var st = board ? normStart({ b: board, side: side }) : null;
        var g = st ? newGame(o.v || 'american', st.b, st.side) : newGame(o.v || 'american');
        if (st) g.start = st;
        g.mode = S.game.mode; g.level = S.game.level; g.human = S.game.human; g.autoFlip = S.game.autoFlip; g.id = S.game.id + 1; g.undos = 0; g.hints = 0;
        S.game = g; renderAll(); maybeThink();
      }
    };
  }

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(msg, ms) { if (Cade.showToast) Cade.showToast(msg, 'info', ms || 1800); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

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
  function sfx(k, n) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    if (k === 'move') { s.tone(330, 0.05, 'triangle', 0.05, 220); }
    else if (k === 'cap') { s.tone(520 + 60 * (n || 0), 0.09, 'square', 0.03, 260); }
    else if (k === 'king') { s.tone(659, 0.09, 'sine', 0.05); s.tone(880, 0.09, 'sine', 0.05, 0, 0.08); s.tone(1319, 0.18, 'sine', 0.045, 0, 0.16); }
    else if (k === 'sel') { s.tone(740, 0.035, 'sine', 0.03); }
    else if (k === 'bad') { s.tone(150, 0.12, 'sawtooth', 0.03, 110); }
    else if (k === 'click') { s.tone(880, 0.05, 'sine', 0.035); }
    else if (k === 'win') { [523, 659, 784, 1047].forEach(function (f, i) { s.tone(f, 0.16, 'triangle', 0.05, 0, i * 0.1); }); }
    else if (k === 'lose') { [392, 330, 262].forEach(function (f, i) { s.tone(f, 0.22, 'triangle', 0.045, 0, i * 0.14); }); }
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

  var SIDE_NAME = { 1: 'Red', '-1': 'White' };
  function sname(side) { return SIDE_NAME[side]; }
  function g0() { return S && S.game; }
  function live() { return S && S.view == null; }
  function humanTurn() { var g = S.game; return !!g && !g.result && (g.mode === 'pvp' || g.side === g.human); }
  function canAct() { return S && S.game && !S.game.result && live() && humanTurn() && !S.anim && !S.thinking && !S.card; }

  // ---- persistence ----
  function persist() { if (S && S.game) sset(GAME_KEY, JSON.stringify(gameSave(S.game))); }
  function persistStats() { if (S) sset(STATS_KEY, JSON.stringify(S.stats)); }
  function persistPrefs() { if (S) sset(PREFS_KEY, JSON.stringify(S.prefs)); }

  // ---- orientation ----
  function bottomSide() {
    var g = S.game, b;
    if (!g) b = RED;
    else if (g.mode === 'cpu') b = g.human;
    else b = g.autoFlip ? (g.result ? RED : g.side) : RED;
    return S.flip ? -b : b;
  }
  // display cell (0..7, 0..7 from the top-left) of a square
  function cellOf(sq) {
    var r = ROW[sq], c = COL[sq];
    return S.flipped ? [7 - r, 7 - c] : [r, c];
  }
  function sqOfCell(r, c) { return S.flipped ? sqAt(7 - r, 7 - c) : sqAt(r, c); }

  // ---- the board view ----
  function buildBoard() {
    var h = '';
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      var dark = ((r + c) & 1) === 1;
      h += '<div class="ck-sq ' + (dark ? 'd' : 'l') + '" data-r="' + r + '" data-c="' + c + '">' + (dark ? '<span class="ck-num"></span>' : '') + '</div>';
    }
    S.boardEl.innerHTML = h;
    S.cells = S.boardEl.children;
  }
  function boardShown() {
    var g = S.game;
    if (!g) return initBoard();
    return S.view == null ? g.b : g.boards[S.view];
  }
  function cellEl(sq) { var rc = cellOf(sq); return S.cells[rc[0] * 8 + rc[1]]; }

  function selCands() {
    if (!S.sel) return [];
    var st = S.sel.steps;
    return S.legal.filter(function (m) {
      if (m.path.length < st.length) return false;
      for (var i = 0; i < st.length; i++) if (m.path[i] !== st[i]) return false;
      return true;
    });
  }
  function movers() {
    var o = {};
    S.legal.forEach(function (m) { o[m.from] = 1; });
    return o;
  }

  function renderBoard() {
    var g = S.game, b = boardShown(), i, k;
    S.flipped = bottomSide() === RED;
    S.root.classList.toggle('nums', S.prefs.nums);
    // squares: numbers + classes
    for (k = 0; k < 64; k++) {
      var el = S.cells[k], r = k >> 3, c = k & 7, sq = sqOfCell(r, c);
      var cls = 'ck-sq ' + (sq >= 0 ? 'd' : 'l');
      if (sq >= 0) {
        var num = el.firstChild;
        if (num && num.textContent !== String(sq + 1)) num.textContent = String(sq + 1);
      }
      el.className = cls;
      el.removeAttribute('data-step');
    }
    function add(sq, c2) { if (sq >= 0) cellEl(sq).classList.add(c2); }
    // last move (of the position shown)
    var lastIdx = S.view == null ? g && g.moves.length - 1 : S.view - 1;
    var lm = g && lastIdx >= 0 ? g.moves[lastIdx] : null;
    if (lm) {
      for (i = 0; i < lm.path.length; i++) add(lm.path[i], i === 0 || i === lm.path.length - 1 ? 'last' : 'lastp');
      for (i = 0; i < lm.caps.length; i++) add(lm.caps[i], 'gone');
    }
    var act = canAct() || (S.view == null && g && !g.result && humanTurn() && !S.anim);
    if (live() && g && !g.result && humanTurn() && !S.anim) {
      if (S.sel) {
        var cands = selCands(), st = S.sel.steps;
        add(S.sel.from, 'sel');
        for (i = 1; i < st.length; i++) { add(st[i], 'step'); cellEl(st[i]).setAttribute('data-step', String(i)); }
        cands.forEach(function (m) {
          if (m.path.length > st.length) add(m.path[st.length], 'tgt');
          if (m.path.length > st.length + 1) add(m.to, 'fin');
        });
      } else if (act) {
        var mv = movers(), must = S.legal.length && S.legal[0].caps.length;
        for (k in mv) add(+k, must ? 'must' : 'can');
      }
      if (S.hint && S.hint.ply === g.moves.length && S.hint.path) {
        S.hint.path.forEach(function (sq, hi) { add(sq, 'hint'); if (hi) cellEl(sq).setAttribute('data-step', String(hi)); });
      }
    }
    if (S.cursor != null && S.kbd) { var ce = S.cells[S.cursor]; if (ce) ce.classList.add('cur'); }
    // pieces
    var h = '';
    for (i = 0; i < 32; i++) {
      var p = b[i];
      if (!p) continue;
      var rc = cellOf(i);
      h += '<div class="ck-pc ' + (p > 0 ? 'r' : 'w') + (p === 2 || p === -2 ? ' k' : '') + '" data-sq="' + i + '" style="left:' + (rc[1] * 12.5) + '%;top:' + (rc[0] * 12.5) + '%"><i></i></div>';
    }
    S.pcsEl.innerHTML = h;
    // pieces already jumped on a half-picked route
    if (S.sel && S.sel.steps.length > 1 && live()) {
      var c0 = selCands()[0];
      if (c0) for (i = 0; i < S.sel.steps.length - 1; i++) { var pe = pieceEl(c0.caps[i]); if (pe) pe.classList.add('doom'); }
    }
  }
  function pieceEl(sq) { return S.pcsEl.querySelector('[data-sq="' + sq + '"]'); }

  function renderBars() {
    var g = S.game, bs = bottomSide(), b = g ? g.b : initBoard();
    var cn = counts(S.view == null || !g ? b : g.boards[S.view]);
    [[S.barBot, bs], [S.barTop, -bs]].forEach(function (pr) {
      var el = pr[0], side = pr[1], who;
      if (!g) who = sname(side);
      else if (g.mode === 'cpu') who = side === g.human ? 'You' : 'CPU · ' + levelOf(g.level).name;
      else who = sname(side);
      var men = side === RED ? cn.rm : cn.wm, kings = side === RED ? cn.rk : cn.wk;
      var turn = g && !g.result && g.side === side && S.view == null;
      var think = turn && S.thinking && g.mode === 'cpu' && side !== g.human;
      var won = g && g.result && g.result.winner === side;
      var pcs = '';
      for (var i = 0; i < Math.min(12, men); i++) pcs += '<i></i>';
      for (i = 0; i < Math.min(12, kings); i++) pcs += '<i class="k"></i>';
      el.innerHTML = '<span class="ck-who ' + (side === RED ? 'r' : 'w') + (turn ? ' on' : '') + '"><span class="ck-dot"></span>' + esc(who) +
        (!g || g.mode === 'pvp' ? '' : '<span class="ck-sn">' + (side === RED ? ' (red)' : ' (white)') + '</span>') +
        (think ? '<span class="ck-think"><b>.</b><b>.</b><b>.</b></span>' : '') + (won ? '<span class="ck-crown"> ★ wins</span>' : '') + '</span>' +
        '<span class="ck-left ' + (side === RED ? 'r' : 'w') + '" title="' + men + ' men, ' + kings + ' kings">' + pcs + '<b>' + (men + kings) + '</b></span>';
    });
  }
  var REASONS = { blocked: 'no legal move left', captured: 'every piece taken', repetition: 'threefold repetition', forty: '40-move rule', resign: 'resignation', agreed: 'agreement' };
  function resultText(g) {
    var r = g.result;
    if (!r) return '';
    if (!r.winner) return 'Draw — ' + REASONS[r.reason];
    var who = g.mode === 'cpu' ? (r.winner === g.human ? 'You win' : 'CPU wins') : sname(r.winner) + ' wins';
    if (r.reason === 'resign') return who + ' — ' + (g.mode === 'cpu' && r.winner !== g.human ? 'you resigned' : sname(-r.winner) + ' resigned');
    return who + ' — ' + (r.reason === 'blocked' ? sname(-r.winner) + ' has no move' : r.reason === 'captured' ? 'all pieces taken' : REASONS[r.reason]);
  }
  function renderStatus() {
    var g = S.game, h;
    if (!g) { S.status.innerHTML = 'Pick a game.'; return; }
    if (S.view != null) h = '<b>Reviewing</b> ' + (S.view ? 'after move ' + Math.ceil(S.view / 2) + (S.view % 2 ? '' : '…') : 'the start') + '. <span class="ck-dim">' + (S.coarse ? 'Tap ▸| to return.' : 'End / ▸| returns.') + '</span>';
    else if (g.result) h = '<b>' + esc(resultText(g)) + '</b>';
    else if (S.thinking) h = 'CPU is thinking<span class="ck-think"><b>.</b><b>.</b><b>.</b></span>';
    else {
      var me = g.mode === 'cpu' ? 'Your move' : sname(g.side) + ' to move', must = S.legal.length && S.legal[0].caps.length;
      h = '<b>' + me + '.</b> ';
      if (S.hint && S.hint.ply === g.moves.length && S.hint.path) h += 'Hint: <b class="ck-acc">' + esc(notation(findMove(S.legal, S.hint.path) || { from: S.hint.path[0], to: S.hint.path[S.hint.path.length - 1], caps: [], path: S.hint.path })) + '</b>';
      else if (S.hintBusy) h += 'Finding a hint<span class="ck-think"><b>.</b><b>.</b><b>.</b></span>';
      else if (S.sel && selCands().length > 1 && selCands()[0].caps.length) h += '<span class="ck-acc">Pick the jump route</span> — tap each landing.';
      else if (must) {
        var n = 0, mx = 0; for (var k in movers()) n++;
        S.legal.forEach(function (m) { if (m.caps.length > mx) mx = m.caps.length; });
        h += '<span class="ck-must">Capture is forced</span>' + (mx > 1 ? ' — up to ' + mx + ' in one go.' : n > 1 ? ' — ' + n + ' pieces can jump.' : '.');
      } else if (g.quiet >= 60) h += '<span class="ck-dim">' + Math.ceil((80 - g.quiet) / 2) + ' moves to a 40-move draw.</span>';
      else h += '<span class="ck-dim">' + (S.sel ? 'Tap a marked square.' : 'Tap a piece, then where it goes.') + '</span>';
    }
    S.status.innerHTML = h;
  }
  function renderMoves() {
    var g = S.game, h = '';
    if (!g || !g.moves.length) h = '<div class="ck-empty">No moves yet. Red moves first.</div>';
    else {
      for (var i = 0; i < g.moves.length; i += 2) {
        h += '<span class="ck-mn">' + (i / 2 + 1) + '.</span>';
        for (var j = i; j < i + 2; j++) {
          if (j < g.moves.length) {
            var on = (S.view == null ? g.moves.length : S.view) === j + 1;
            h += '<button type="button" class="ck-mv' + (on ? ' on' : '') + (g.moves[j].caps.length ? ' x' : '') + '" data-ply="' + (j + 1) + '">' + esc(g.moves[j].n) + (g.moves[j].promo ? '<sup>K</sup>' : '') + '</button>';
          } else h += '<span class="ck-ph"></span>';
        }
      }
      if (g.result) h += '<div class="ck-res">' + esc(g.result.winner === RED ? '1-0' : g.result.winner === WHITE ? '0-1' : '½-½') + ' · ' + esc(REASONS[g.result.reason]) + '</div>';
    }
    S.movesEl.innerHTML = h;
    var on2 = S.movesEl.querySelector('.ck-mv.on');
    if (on2) {
      var me = S.movesEl;
      if (S.phone) me.scrollLeft = Math.max(0, on2.offsetLeft - me.clientWidth + on2.offsetWidth + 8);
      else if (on2.offsetTop + on2.offsetHeight > me.scrollTop + me.clientHeight || on2.offsetTop < me.scrollTop) me.scrollTop = on2.offsetTop - me.clientHeight / 2;
    } else if (S.view == null) { S.movesEl.scrollTop = S.movesEl.scrollHeight; S.movesEl.scrollLeft = S.movesEl.scrollWidth; }
  }
  function renderPad() {
    var g = S.game, l = live();
    function dis(a, d) { var b = S.pad.querySelector('[data-act="' + a + '"]'); if (b) b.disabled = !!d; }
    var undoable = g && !g.result && l && !S.anim && g.moves.length > 0 && (g.mode === 'pvp' || g.moves.some(function (m) { return m.side === g.human; }));
    dis('undo', !undoable);
    dis('hint', !(g && !g.result && l && humanTurn() && !S.thinking && !S.anim && !S.hintBusy));
    dis('resign', !(g && !g.result));
    var navs = S.nav.querySelectorAll('button'), cur = curPly(), n = g ? g.moves.length : 0;
    navs[0].disabled = navs[1].disabled = !g || cur <= 0;
    navs[2].disabled = navs[3].disabled = !g || cur >= n;
  }
  function syncHead() {
    var b = S.head.querySelector('[data-h="sound"]');
    b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    b.classList.toggle('on', S.snd.on);
    b.title = S.snd.on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-label', b.title);
  }
  function renderAll() {
    if (!S) return;
    S.legal = S.game && live() && !S.game.result ? legal(S.game) : [];
    renderBoard(); renderBars(); renderStatus(); renderMoves(); renderPad();
  }
  function say(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- effects ----
  function spark(sq, kind) {
    if (!S || S.rm) return;
    var rc = cellOf(sq), wrap = document.createElement('div');
    wrap.className = 'ck-spark ' + (kind || '');
    wrap.style.left = (rc[1] * 12.5 + 6.25) + '%'; wrap.style.top = (rc[0] * 12.5 + 6.25) + '%';
    var gl = kind === 'king' ? '*+*+*+*+' : '*x+.*x+.', h = '';
    for (var i = 0; i < gl.length; i++) {
      var a = (i / gl.length) * Math.PI * 2 + Math.random() * 0.5, d = 18 + Math.random() * 22;
      h += '<i style="--dx:' + Math.round(Math.cos(a) * d) + 'px;--dy:' + Math.round(Math.sin(a) * d) + 'px">' + gl[i] + '</i>';
    }
    if (kind === 'king') h += '<b>KING</b>';
    wrap.innerHTML = h;
    S.fxEl.appendChild(wrap);
    setTimeout(function () { wrap.remove(); }, kind === 'king' ? 1100 : 700);
  }
  function burst() {
    if (!S || S.rm) return;
    var wrap = document.createElement('div'), h = '', gl = '*+x#@%&o';
    wrap.className = 'ck-burst';
    for (var i = 0; i < 26; i++) {
      var a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 110;
      h += '<i class="c' + (i % 4) + '" style="--dx:' + Math.round(Math.cos(a) * d) + 'px;--dy:' + Math.round(Math.sin(a) * d) + 'px;animation-delay:' + Math.round(Math.random() * 250) + 'ms">' + gl[i % gl.length] + '</i>';
    }
    wrap.innerHTML = h;
    S.fxEl.appendChild(wrap);
    setTimeout(function () { wrap.remove(); }, 1700);
  }
  function shakeStatus() {
    S.status.classList.remove('shake'); void S.status.offsetWidth; S.status.classList.add('shake');
  }

  // Slide the moving piece along its path, then call done.
  function animate(path, caps, done) {
    var el = pieceEl(path[0]), step = S.prefs.fast ? 90 : 150;
    if (!el || S.rm || !el.animate) { done(); return; }
    S.anim = true;
    el.classList.add('moving');
    var frames = path.map(function (sq) { var rc = cellOf(sq); return { left: (rc[1] * 12.5) + '%', top: (rc[0] * 12.5) + '%' }; });
    var dur = step * (path.length - 1) + (caps.length ? 40 : 0), a;
    try { a = el.animate(frames, { duration: dur, easing: path.length > 2 ? 'linear' : 'ease-out', fill: 'forwards' }); } catch (e) { a = null; }
    caps.forEach(function (cq, i) {
      var ce = pieceEl(cq), t = step * (i + 0.5);
      setTimeout(function () {
        if (!S) return;
        if (ce) ce.classList.add('taken');
        spark(cq);
        sfx('cap', i);
        Cade.haptic && Cade.haptic(6);
      }, t);
    });
    var fin = false;
    function end() { if (fin) return; fin = true; if (S) S.anim = false; done(); }
    if (a) a.onfinish = end;
    setTimeout(end, dur + 120);
  }

  // ---- moves ----
  function commit(path) {
    var g = S.game, gid = g.id;
    S.sel = null; S.hint = null;
    var m = findMove(S.legal, path);
    if (!m) return;
    renderBoard();
    animate(m.path, m.caps, function () {
      if (!S || S.game !== g || g.id !== gid) return;
      var rec = play(g, m.path);
      if (!rec) { renderAll(); return; }
      afterMove(rec);
    });
  }
  function afterMove(rec) {
    var g = S.game;
    if (!rec.caps.length) sfx('move');
    if (rec.promo) {
      setTimeout(function () { if (S) { spark(rec.to, 'king'); sfx('king'); } }, 30);
      Cade.haptic && Cade.haptic(12);
    }
    say(sname(rec.side) + ' ' + rec.n + (rec.promo ? ', crowned' : ''));
    persist();
    renderAll();
    if (g.result) { finish(); return; }
    if (g.mode === 'pvp' && g.autoFlip) handOff();
    maybeThink();
  }
  function handOff() {
    var g = S.game, el = document.createElement('div');
    if (S.rm) return;
    el.className = 'ck-hand ' + (g.side === RED ? 'r' : 'w');
    el.innerHTML = '<span><i></i>' + sname(g.side) + ' to move</span>';
    S.fxEl.appendChild(el);
    setTimeout(function () { el.remove(); }, 1100);
  }
  function finish() {
    var g = S.game;
    if (!g.recorded) {
      var info = recordResult(S.stats, g, { mode: g.mode, level: g.level, human: g.human });
      g.recorded = true; g.last = info;
      persistStats(); persist();
    }
    var r = g.result, mine = g.mode === 'cpu' ? (r.winner === g.human ? 'w' : r.winner ? 'l' : 'd') : r.winner ? 'w' : 'd';
    setTimeout(function () { if (S && S.game === g) { sfx(mine === 'w' ? 'win' : mine === 'l' ? 'lose' : 'draw'); if (mine === 'w') burst(); } }, 150);
    say(resultText(g));
    S.resT = setTimeout(function () { if (S && S.game === g && g.result && !S.card) showCard('result'); }, 750);
  }
  function tapSquare(sq) {
    if (!S || !S.game) return;
    var g = S.game;
    if (S.view != null) { navTo(g.moves.length); return; }
    if (g.result || S.anim) return;
    if (!humanTurn() || S.thinking) { shakeStatus(); return; }
    S.snd.ensure();
    var b = g.b;
    if (S.sel) {
      var cands = selCands(), st = S.sel.steps;
      var next = cands.filter(function (m) { return m.path[st.length] === sq; });
      if (next.length) {
        st.push(sq);
        if (next.length === 1) { commit(next[0].path); return; }
        sfx('sel');
        renderBoard(); renderStatus();
        return;
      }
      var fin = cands.filter(function (m) { return m.to === sq; });
      if (fin.length === 1) { commit(fin[0].path); return; }
      if (fin.length > 1) {
        sfx('sel');
        toast('More than one route ends there — tap each landing square in turn', 2400);
        renderBoard(); renderStatus();
        return;
      }
    }
    if (b[sq] * g.side > 0) {
      var mv = movers();
      if (mv[sq]) {
        if (S.sel && S.sel.from === sq && S.sel.steps.length === 1) { S.sel = null; renderBoard(); renderStatus(); return; }
        S.sel = { from: sq, steps: [sq] };
        sfx('sel');
        // a lone capture route (or a single landing): nothing to choose
        var c2 = selCands();
        renderBoard(); renderStatus();
        void c2;
        return;
      }
      sfx('bad');
      if (S.legal.length && S.legal[0].caps.length) { shakeStatus(); toast('A capture is forced — jump with a glowing piece', 1800); }
      else toast('That piece has no move', 1400);
      S.sel = null; renderBoard();
      return;
    }
    if (S.sel) { S.sel = null; sfx('bad'); renderBoard(); renderStatus(); }
  }

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
    var id = ++S.reqId;
    msg.id = id; msg.v = S.game.v; if (S.game.start) msg.start = S.game.start; msg.moves = S.game.moves.map(function (m) { return m.path; });
    S.pending[id] = { msg: msg, cb: cb, gameId: S.game.id, ply: S.game.moves.length };
    var w = makeWorker();
    if (w) { try { w.postMessage(msg); return; } catch (e) { S.noWorker = true; } }
    runLocal(S.pending[id]);
  }
  function runLocal(p) {
    // no Worker: a short search on the page, after the board has painted
    setTimeout(function () {
      if (!S || !S.pending[p.msg.id]) return;
      p.msg.timeCap = 450;
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
    if (!g || g.result || g.mode !== 'cpu' || g.side === g.human || S.thinking) return;
    S.thinking = true;
    var t0 = now(), lv = g.level;
    renderBars(); renderStatus(); renderPad();
    ask({ level: lv, seed: (g.id * 7919 + g.moves.length * 104729 + (Date.now() & 0xffff)) >>> 0 }, function (r) {
      var wait = Math.max(0, (lv <= 2 ? 520 : 320) - (now() - t0));
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
    if (r.error || !r.path) { renderAll(); return; }
    S.cpuEval = r.score || 0;
    S.legal = legal(g);
    var m = findMove(S.legal, r.path);
    if (!m) { renderAll(); return; }
    renderBars(); renderStatus();
    var gid = g.id;
    animate(m.path, m.caps, function () {
      if (!S || S.game !== g || g.id !== gid) return;
      var rec = play(g, m.path);
      if (rec) afterMove(rec); else renderAll();
    });
  }
  function hint() {
    var g = S.game;
    if (!g || g.result || !live() || !humanTurn() || S.thinking || S.anim || S.hintBusy) return;
    var ply = g.moves.length;
    if (S.hint && S.hint.ply === ply) { renderBoard(); renderStatus(); return; }
    if (S.legal.length === 1) { S.hint = { ply: ply, path: S.legal[0].path }; g.hints++; persist(); sfx('hint'); renderBoard(); renderStatus(); return; }
    S.hintBusy = true; S.sel = null;
    renderBoard(); renderStatus(); renderPad();
    ask({ hint: true, time: 800 }, function (r) {
      S.hintBusy = false;
      if (!r.path) { renderAll(); return; }
      S.hint = { ply: ply, path: r.path };
      g.hints++; persist();
      sfx('hint');
      renderAll();
    });
  }
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
    g.undos++; S.sel = null; S.hint = null;
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
    S.sel = null;
    renderAll();
  }
  function flip() { S.flip = !S.flip; S.sel = null; renderAll(); sfx('click'); }

  // ---- new games ----
  function startGame(o) {
    cancelThink();
    clearTimeout(S.resT);
    var human = o.color === 'w' ? WHITE : o.color === 'x' ? (Math.random() < 0.5 ? RED : WHITE) : RED;
    var g = newGame(o.v);
    g.mode = o.mode; g.level = o.level; g.human = human; g.autoFlip = !!o.autoFlip;
    g.id = ((S.game && S.game.id) || 0) + 1; g.t = Date.now(); g.undos = 0; g.hints = 0; g.recorded = false;
    S.game = g; S.view = null; S.sel = null; S.hint = null; S.flip = false; S.cursor = null;
    S.prefs.mode = o.mode; S.prefs.level = o.level; S.prefs.color = o.color; S.prefs.v = g.v; S.prefs.autoFlip = g.autoFlip;
    persistPrefs(); persist();
    showCard(null);
    sfx('click');
    renderAll();
    say('New game. ' + (g.mode === 'cpu' ? 'You play ' + sname(human) + '.' : 'Red moves first.'));
    maybeThink();
  }
  function rematch() {
    var g = S.game;
    if (!g) return;
    var color = g.mode === 'cpu' ? (g.human === RED ? 'w' : 'r') : 'r';
    startGame({ mode: g.mode, level: g.level, color: color, v: g.v, autoFlip: g.autoFlip });
  }
  function resign() {
    var g = S.game;
    if (!g || g.result) return;
    cancelThink();
    var loser = g.mode === 'cpu' ? g.human : g.side;
    endGame(g, -loser, 'resign');
    persist(); showCard(null); renderAll(); finish();
  }
  function offerDraw() {
    var g = S.game;
    if (!g || g.result) return;
    if (g.mode === 'cpu') {
      // the CPU takes a draw when it isn't ahead (its last search said so) and the game is under way
      var sc = S.cpuEval || 0, ok = g.moves.length >= 16 && sc <= 25;
      if (!ok) { toast(g.moves.length < 16 ? 'CPU: too early for a draw — play on!' : 'CPU declines the draw', 2000); showCard(null); return; }
    }
    cancelThink();
    endGame(g, 0, 'agreed');
    persist(); showCard(null); renderAll(); finish();
  }

  // ---- cards ----
  function chip(attr, val, on, label, extra) {
    return '<button type="button" class="ck-chip' + (on ? ' on' : '') + '" data-' + attr + '="' + val + '">' + label + (extra || '') + '</button>';
  }
  function levelRec(i) {
    var l = S.stats.lv[i];
    return l.w + l.l + l.d ? ' <i>' + l.w + '-' + l.l + (l.d ? '-' + l.d : '') + '</i>' : '';
  }
  function cardHtml(kind) {
    var g = S.game, m = S.menu, h = '';
    if (kind === 'menu') {
      var resume = g && !g.result && S.cardBack;
      h = '<div class="ck-title">CHECKERS</div>' +
        '<pre class="ck-art">( ) ( ) ( ) \n ( ) (K) ( )\n( ) ( ) ( ) </pre>' +
        '<div class="ck-sec"><div class="ck-h">Opponent</div><div class="ck-chips">' +
        chip('mode', 'cpu', m.mode === 'cpu', 'vs CPU') + chip('mode', 'pvp', m.mode === 'pvp', '2 players · one device') + '</div></div>';
      if (m.mode === 'cpu') {
        h += '<div class="ck-sec"><div class="ck-h">Level</div><div class="ck-chips">';
        LEVELS.forEach(function (L) { h += chip('level', L.id, m.level === L.id, L.id + ' ' + L.name, levelRec(L.id)); });
        h += '</div></div><div class="ck-sec"><div class="ck-h">You play</div><div class="ck-chips">' +
          chip('color', 'r', m.color === 'r', '<span class="ck-sw r"></span>Red · first') + chip('color', 'w', m.color === 'w', '<span class="ck-sw w"></span>White') +
          chip('color', 'x', m.color === 'x', '? Random') + '</div></div>';
      } else {
        h += '<div class="ck-sec"><div class="ck-h">Board</div><div class="ck-chips">' +
          chip('af', '0', !m.autoFlip, 'Fixed (Red at the bottom)') + chip('af', '1', m.autoFlip, 'Turn to face the mover') + '</div></div>';
      }
      h += '<div class="ck-sec"><div class="ck-h">Rules</div><div class="ck-chips">' +
        chip('v', 'american', m.v === 'american', 'American') + chip('v', 'flying', m.v === 'flying', 'Flying kings') + '</div>' +
        '<p class="ck-tip">' + esc(VARIANTS[m.v].info) + '.</p></div>';
      h += '<div class="ck-btns">' + (resume ? '<button type="button" class="ck-go alt" data-act="close">Resume</button>' : '') +
        '<button type="button" class="ck-go" data-act="start">' + (resume ? 'New game' : 'Play') + '</button></div>' +
        '<div class="ck-foot"><button type="button" class="ck-lnk" data-act="stats">Records</button>' +
        '<button type="button" class="ck-lnk" data-act="help">How to play</button>' +
        (resume ? '<button type="button" class="ck-lnk" data-act="confirm">Resign / draw…</button>' : '') + '</div>';
    } else if (kind === 'help') {
      h = '<div class="ck-title">HOW TO PLAY</div>' +
        '<p><b>Move</b> one square diagonally forward onto an empty dark square. Red moves first.</p>' +
        '<p><b>Jump</b> an enemy piece next to you onto the empty square beyond to capture it, and keep jumping while you can. <b>Captures are forced</b> — glowing pieces must jump. With several routes, tap each landing in turn.</p>' +
        '<p><b>Kings</b> (a stacked piece marked K) are crowned on the far row and move both ways. A man crowned by a jump stops there.</p>' +
        '<p><b>Win</b> when the other side has no move. <b>Draw</b> by threefold repetition, the 40-move rule (40 moves each without a capture or a man moving) or agreement.</p>' +
        '<p><b>Flying kings</b>: men jump backwards too, kings fly along whole diagonals, and you must take the most pieces.</p>' +
        '<div class="ck-keys"><span><b>Tap / click</b> a piece, then a marked square. Or drag it.</span>' +
        '<span><b>Arrows</b> + <b>Enter</b> play from the keyboard</span>' +
        '<span><b>U</b> undo · <b>H</b> hint · <b>F</b> flip · <b>N</b> menu</span>' +
        '<span><b>, .</b> step through moves · <b>End</b> back to the game</span></div>' +
        '<div class="ck-btns"><button type="button" class="ck-go" data-act="close">Got it</button></div>';
    } else if (kind === 'result') {
      var r = g.result, info = g.last || {}, title, sub = resultText(g).replace(/^[^—]*— /, '');
      if (g.mode === 'cpu') title = r.winner === g.human ? 'YOU WIN' : r.winner ? 'CPU WINS' : 'DRAW';
      else title = r.winner ? sname(r.winner).toUpperCase() + ' WINS' : 'DRAW';
      var cn = counts(g.b), left = r.winner === RED ? cn.rm + cn.rk : r.winner === WHITE ? cn.wm + cn.wk : 0;
      h = '<div class="ck-title">' + title + '</div><div class="ck-sub">' + esc(sub) + '</div>' +
        '<div class="ck-big">' + Math.ceil(g.moves.length / 2) + ' <small>move' + (Math.ceil(g.moves.length / 2) === 1 ? '' : 's') + '</small></div>';
      var notes = [];
      if (r.winner && left) notes.push(left + ' piece' + (left > 1 ? 's' : '') + ' left standing');
      if (g.mode === 'cpu') {
        var l = S.stats.lv[g.level];
        notes.push(levelOf(g.level).name + ': ' + l.w + ' won · ' + l.l + ' lost · ' + l.d + ' drawn');
        if (g.undos || g.hints) notes.push(g.undos + ' undo' + (g.undos === 1 ? '' : 's') + ' · ' + g.hints + ' hint' + (g.hints === 1 ? '' : 's'));
      }
      h += notes.map(function (t) { return '<div class="ck-note">' + esc(t) + '</div>'; }).join('');
      if (info.newStreak) h += '<div class="ck-new">NEW BEST STREAK · ' + S.stats.bestStreak + ' WINS IN A ROW</div>';
      else if (info.fast) h += '<div class="ck-new">FASTEST WIN AT THIS LEVEL</div>';
      if (g.mode === 'cpu' && info.won && g.level < 6) h += '<div class="ck-note">Ready for ' + levelOf(g.level + 1).name + '?</div>';
      h += '<div class="ck-btns"><button type="button" class="ck-go alt" data-act="review">Review</button>' +
        (g.mode === 'cpu' && info.won && g.level < 6 ? '<button type="button" class="ck-go alt" data-act="next">Next level</button>' : '') +
        '<button type="button" class="ck-go" data-act="rematch">Rematch</button></div>' +
        '<div class="ck-foot"><button type="button" class="ck-lnk" data-act="menu">New game…</button><button type="button" class="ck-lnk" data-act="stats">Records</button></div>';
    } else if (kind === 'stats') {
      var st = S.stats, rows = '<b>level       won lost drawn  fastest</b>\n';
      LEVELS.forEach(function (L) {
        var l = st.lv[L.id], line = pad(L.id + ' ' + L.name, 11) + lpad(l.w, 4) + lpad(l.l, 5) + lpad(l.d, 6) + lpad(l.fast ? l.fast + ' mv' : '-', 9);
        rows += (l.w ? '<span class="g">' + line + '</span>' : l.w + l.l + l.d ? line : '<i>' + line + '</i>') + '\n';
      });
      h = '<div class="ck-title">RECORDS</div><pre class="ck-tab">' + rows + '</pre>' +
        '<div class="ck-note">win streak ' + st.streak + ' · best ' + st.bestStreak + ' · games ' + st.games + '</div>' +
        '<div class="ck-note">2 players: ' + st.pvp.n + ' games · Red ' + st.pvp.r + ' · White ' + st.pvp.w + ' · drawn ' + st.pvp.d + '</div>' +
        '<div class="ck-btns"><button type="button" class="ck-go" data-act="back">Back</button></div>' +
        '<div class="ck-foot">' + (S.resetArm ? '<span class="ck-confirm">Erase all records?</span><span><button type="button" class="ck-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="ck-lnk" data-act="reset-no">Keep</button></span>'
          : '<span></span><button type="button" class="ck-lnk" data-act="reset">Reset records</button>') + '</div>';
    } else if (kind === 'confirm') {
      h = '<div class="ck-title">END GAME?</div>' +
        '<p class="ck-sub">' + (g.mode === 'cpu' ? 'Resign counts as a loss. The CPU accepts a draw only when it is not ahead.' : sname(g.side) + ' to move. Resign hands the game to ' + sname(-g.side) + '.') + '</p>' +
        '<div class="ck-btns"><button type="button" class="ck-go alt" data-act="draw">' + (g.mode === 'cpu' ? 'Offer draw' : 'Agree a draw') + '</button>' +
        '<button type="button" class="ck-go danger" data-act="resign-yes">Resign</button></div>' +
        '<div class="ck-btns"><button type="button" class="ck-go alt" data-act="back">Keep playing</button></div>';
    }
    return '<div class="ck-card ck-' + kind + '" role="dialog" aria-label="' + kind + '">' + h + '</div>';
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function showCard(kind, back) {
    if (!S) return;
    if (kind && kind !== S.card && kind !== 'stats' && kind !== 'help' && kind !== 'confirm') S.cardFrom = null;
    if (kind === 'menu') {
      if (!S.card || S.card !== 'menu') {
        var p = S.prefs;
        S.menu = { mode: p.mode, level: p.level, color: p.color, v: p.v, autoFlip: p.autoFlip };
      }
      S.cardBack = back !== false && !!(S.game && !S.game.result);
    }
    S.card = kind || null;
    S.root.classList.toggle('dim', !!kind);
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; renderAll(); return; }
    S.ovl.innerHTML = cardHtml(kind);
    S.ovl.style.display = '';
    S.ovl.scrollTop = 0;
    renderPad();
    if (!S.coarse) { var f = S.ovl.querySelector('.ck-go:last-of-type') || S.ovl.querySelector('.ck-go'); if (f && kind !== 'menu') { try { f.focus({ preventScroll: true }); } catch (e) {} } }
  }
  function closeCard() {
    if (!S) return;
    var from = S.cardFrom;
    S.cardFrom = null;
    if (from) { showCard(from, S.cardBack); return; }
    if (S.card === 'menu' && !(S.game && !S.game.result)) return;   // nothing to go back to
    showCard(null);
    maybeThink();
  }

  // ---- keys ----
  function onKey(e) {
    if (!S) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) { if (!S.card) { e.preventDefault(); undoMove(); } return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (S.card) { if (S.card === 'result') showCard(null); else closeCard(); }
      else if (S.sel) { S.sel = null; renderBoard(); renderStatus(); }
      else if (S.view != null) navTo(S.game.moves.length);
      else closePanel();
      return;
    }
    if (S.card) {
      if ((k === 'Enter' || k === ' ') && S.card === 'menu' && !(t && t.tagName === 'BUTTON' && S.panel.contains(t))) { e.preventDefault(); startFromMenu(); }
      return;
    }
    var handled = true;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      if (S.cursor == null) { var first = S.sel ? S.sel.from : Object.keys(movers())[0]; var rc = first != null ? cellOf(+first) : [7, 0]; S.cursor = rc[0] * 8 + rc[1]; }
      else {
        var r = S.cursor >> 3, c = S.cursor & 7;
        if (k === 'ArrowLeft') c = Math.max(0, c - 1); else if (k === 'ArrowRight') c = Math.min(7, c + 1);
        else if (k === 'ArrowUp') r = Math.max(0, r - 1); else r = Math.min(7, r + 1);
        S.cursor = r * 8 + c;
      }
      S.kbd = true; renderBoard();
    } else if ((k === 'Enter' || k === ' ') && !(t && t.tagName === 'BUTTON' && S.panel.contains(t))) {
      if (S.cursor == null) { S.kbd = true; var f2 = Object.keys(movers())[0]; if (f2 != null) { var rc2 = cellOf(+f2); S.cursor = rc2[0] * 8 + rc2[1]; } renderBoard(); }
      else { var sq = sqOfCell(S.cursor >> 3, S.cursor & 7); if (sq >= 0) tapSquare(sq); }
    }
    else if (k === 'u' || k === 'U' || k === 'Backspace') undoMove();
    else if (k === 'h' || k === 'H' || k === '?') hint();
    else if (k === 'f' || k === 'F') flip();
    else if (k === 'n' || k === 'N' || k === 'm' || k === 'M') showCard('menu');
    else if (k === ',' || k === '<' || k === 'PageUp') navTo(curPly() - 1);
    else if (k === '.' || k === '>' || k === 'PageDown') navTo(curPly() + 1);
    else if (k === 'Home') navTo(0);
    else if (k === 'End') navTo(S.game ? S.game.moves.length : 0);
    else handled = false;
    if (handled) e.preventDefault();
  }
  function startFromMenu() {
    var m = S.menu;
    startGame({ mode: m.mode, level: m.level, color: m.color, v: m.v, autoFlip: m.autoFlip });
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
    var r = S.panel.getBoundingClientRect(), top = Math.min(Math.max(0, r.top || 50), 120), sz;
    if (phone) sz = Math.min(vw - 34, vh - top - (40 + 2 * 30 + 44 + 40 + (S.coarse ? 60 : 50) + 40));
    else sz = Math.min(solo ? 600 : 480, vh - top - (40 + 2 * 32 + 56 + 40), vw - 290);
    sz = Math.max(232, Math.floor(sz / 8) * 8);
    S.root.style.setProperty('--ck-sz', sz + 'px');
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    S = null;
    clearTimeout(s.cpuT); clearTimeout(s.resizeT); clearTimeout(s.resT);
    if (s.worker) { try { s.worker.terminate(); } catch (e) {} }
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
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
    var body = '<div class="ck">' +
      '<div class="ck-main"><div class="ck-bar top"></div>' +
      '<div class="ck-stage"><div class="ck-board"></div><div class="ck-pcs"></div><div class="ck-fx"></div></div>' +
      '<div class="ck-bar bot"></div></div>' +
      '<div class="ck-side"><div class="ck-status" aria-live="polite"></div><div class="ck-moves"></div>' +
      '<div class="ck-nav"><button type="button" data-nav="first" title="Start (Home)" aria-label="First move">' + IC_FIRST + '</button>' +
      '<button type="button" data-nav="prev" title="Back (,)" aria-label="Previous move">' + IC_PREV + '</button>' +
      '<button type="button" data-nav="next" title="Forward (.)" aria-label="Next move">' + IC_NEXT + '</button>' +
      '<button type="button" data-nav="last" title="Back to the game (End)" aria-label="Latest move">' + IC_LAST + '</button></div></div>' +
      '<div class="ck-pad"><button type="button" data-act="undo" title="Undo (U)">' + IC_UNDO + '<span>Undo</span></button>' +
      '<button type="button" data-act="hint" title="Hint (H)">' + IC_HINT + '<span>Hint</span></button>' +
      '<button type="button" data-act="flip" title="Flip the board (F)">' + IC_FLIP + '<span>Flip</span></button>' +
      '<button type="button" data-act="resign" title="Resign or offer a draw">' + IC_FLAG + '<span>End</span></button></div>' +
      '<div class="ck-ovl" style="display:none"></div><div class="ck-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '⛀ Checkers', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ck-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="New game (N)" aria-label="New game">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var root = p.querySelector('.ck'), mm = window.matchMedia;
    S = {
      panel: p, root: root, head: hb, stage: root.querySelector('.ck-stage'), boardEl: root.querySelector('.ck-board'), pcsEl: root.querySelector('.ck-pcs'),
      fxEl: root.querySelector('.ck-fx'), ovl: root.querySelector('.ck-ovl'), barTop: root.querySelector('.ck-bar.top'), barBot: root.querySelector('.ck-bar.bot'),
      status: root.querySelector('.ck-status'), movesEl: root.querySelector('.ck-moves'), nav: root.querySelector('.ck-nav'), pad: root.querySelector('.ck-pad'),
      liveEl: root.querySelector('.ck-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), prefs: normPrefs(sjson(PREFS_KEY)), stats: normStats(sjson(STATS_KEY)),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches), phone: false,
      game: null, legal: [], view: null, sel: null, hint: null, flip: false, flipped: false, cursor: null, kbd: false,
      thinking: false, hintBusy: false, anim: false, worker: null, noWorker: false, pending: {}, reqId: 0, cpuT: 0, cpuEval: 0, heldReply: null,
      card: null, cardBack: true, cardFrom: null, menu: null, resetArm: false, drag: null
    };
    buildBoard();
    p._onClose = teardown;
    layout();

    var saved = normGame(sjson(GAME_KEY));
    if (saved) S.game = saved;

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) { S.sel = null; S.drag = null; } });
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
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); renderAll(); } }, 120);
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

    // the board: tap / click a piece then a square, or drag a piece
    function sqFromPoint(x, y) {
      var rr = S.boardEl.getBoundingClientRect();
      if (!rr.width) return -1;
      var c = Math.floor((x - rr.left) / rr.width * 8), r = Math.floor((y - rr.top) / rr.height * 8);
      if (r < 0 || r > 7 || c < 0 || c > 7) return -1;
      return sqOfCell(r, c);
    }
    S.stage.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      S.kbd = false;
      var sq = sqFromPoint(e.clientX, e.clientY);
      if (sq < 0) return;
      var g = S.game, own = g && live() && !g.result && g.b[sq] * g.side > 0 && canAct();
      var isTgt = S.sel && selCands().some(function (m) { return m.path[S.sel.steps.length] === sq || m.to === sq; });
      tapSquare(sq);
      if (own && !isTgt && S.sel && S.sel.from === sq) {
        S.drag = { id: e.pointerId, sq: sq, x0: e.clientX, y0: e.clientY, moved: false, el: pieceEl(sq) };
        try { S.stage.setPointerCapture(e.pointerId); } catch (x) {}
      }
    });
    S.stage.addEventListener('pointermove', function (e) {
      var d = S && S.drag;
      if (!d || d.id !== e.pointerId) return;
      var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.moved && dx * dx + dy * dy < 49) return;
      d.moved = true;
      if (d.el) { d.el.classList.add('drag'); d.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.1)'; }
    });
    function endDrag(e, cancel) {
      var d = S && S.drag;
      if (!d || d.id !== e.pointerId) return;
      S.drag = null;
      if (d.el) { d.el.classList.remove('drag'); d.el.style.transform = ''; }
      if (!d.moved || cancel) return;
      var sq = sqFromPoint(e.clientX, e.clientY);
      if (sq >= 0 && sq !== d.sq) tapSquare(sq);
    }
    S.stage.addEventListener('pointerup', function (e) { endDrag(e, false); });
    S.stage.addEventListener('pointercancel', function (e) { endDrag(e, true); });

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
      else if (b.hasAttribute('data-color')) { m.color = b.getAttribute('data-color'); redo = true; }
      else if (b.hasAttribute('data-v')) { m.v = b.getAttribute('data-v'); redo = true; }
      else if (b.hasAttribute('data-af')) { m.autoFlip = b.getAttribute('data-af') === '1'; redo = true; }
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
      else if (a === 'next') { var g = S.game; startGame({ mode: 'cpu', level: g.level + 1, color: g.human === RED ? 'r' : 'w', v: g.v }); }
      else if (a === 'review') { showCard(null); navTo(0); }
      else if (a === 'menu') showCard('menu', false);
      else if (a === 'resign-yes') resign();
      else if (a === 'draw') offerDraw();
      if (redo) { sfx('click'); var keep = S.cardFrom; showCard('menu', S.cardBack); S.cardFrom = keep; }
      if (b.isConnected) return;
      var sel = ['data-mode', 'data-level', 'data-color', 'data-v', 'data-af'].filter(function (x) { return b.hasAttribute(x); })[0];
      if (sel && e.detail === 0) { var nb = S.ovl.querySelector('[' + sel + '="' + b.getAttribute(sel) + '"]'); if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} } }
    });

    syncHead();
    if (S.game && !S.game.result) {
      renderAll();
      maybeThink();
    } else {
      renderAll();
      if (!sget(PREFS_KEY) && !sget(STATS_KEY)) { S.cardFrom = 'menu'; showCard('help', false); S.cardBack = false; S.menu = { mode: S.prefs.mode, level: S.prefs.level, color: S.prefs.color, v: S.prefs.v, autoFlip: S.prefs.autoFlip }; }
      else showCard('menu', false);
    }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); renderAll(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Checkers with forced captures and kings — vs CPU or pass-and-play',
    icon: '⛀',
    tags: 'game,board,checkers,draughts,2 player,cpu',
    open: open,
    _engine: ENGINE
  });
})();
