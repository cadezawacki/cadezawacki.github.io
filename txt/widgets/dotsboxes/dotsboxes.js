/* Dots and Boxes — the pencil-and-paper classic, for Cade.txt.
 * Take turns drawing a line between two neighbouring dots. Draw the fourth side
 * of a box and it is yours (your glyph goes in it) and you must move again.
 * When every box is taken, most boxes wins. Boards from 3×3 to 8×8 boxes.
 * Play vs the computer (Easy: random safe lines; Medium: never hands over a box
 * while it has a choice and gives away the smallest chain when it must; Hard:
 * chain counting with Monte-Carlo rollouts for the long-chain fight, the
 * double-cross (all-but-two / all-but-four of a loop), and an exact alpha-beta
 * endgame search over chains and loops with a transposition table) or
 * pass-and-play for 2 to 4 people on one device. Lines draw themselves in,
 * boxes pop with sparks, chains get a combo call-out. Undo, hints, autosave /
 * resume and records (per level, streaks, biggest turn).
 * The board is a canvas drawn in monospace glyphs and theme colours; menus and
 * results are DOM cards. Saves live in Cade.store under cade-dotsboxes-*.
 * Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // A board of w × h boxes has (w+1) × (h+1) dots. Edges are numbered:
  // horizontal ones first, row r (0..h) column c (0..w-1) → r*w + c; then the
  // vertical ones, row r (0..h-1) column c (0..w) → NH + r*(w+1) + c.
  // Box (r, c) = r*w + c has edges top, right, bottom, left.
  var MIN_N = 3, MAX_N = 8;
  var LEVELS = ['easy', 'medium', 'hard'];
  var GEOS = {};

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clampInt(v, a, b, d) { v = Math.round(+v); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; }

  function geo(w, h) {
    var key = w + 'x' + h;
    if (GEOS[key]) return GEOS[key];
    var NH = (h + 1) * w, NV = h * (w + 1), NE = NH + NV, NB = w * h, i, r, c;
    var eb = new Int16Array(NE * 2), be = new Int16Array(NB * 4);
    var x1 = new Int8Array(NE), y1 = new Int8Array(NE), x2 = new Int8Array(NE), y2 = new Int8Array(NE);
    for (i = 0; i < NE * 2; i++) eb[i] = -1;
    function link(e, b) { if (eb[e * 2] < 0) eb[e * 2] = b; else eb[e * 2 + 1] = b; }
    for (r = 0; r < h; r++) {
      for (c = 0; c < w; c++) {
        var b = r * w + c, t = r * w + c, bo = (r + 1) * w + c, l = NH + r * (w + 1) + c, ri = l + 1;
        be[b * 4] = t; be[b * 4 + 1] = ri; be[b * 4 + 2] = bo; be[b * 4 + 3] = l;
        link(t, b); link(ri, b); link(bo, b); link(l, b);
      }
    }
    for (r = 0; r <= h; r++) for (c = 0; c < w; c++) { i = r * w + c; x1[i] = c; y1[i] = r; x2[i] = c + 1; y2[i] = r; }
    for (r = 0; r < h; r++) for (c = 0; c <= w; c++) { i = NH + r * (w + 1) + c; x1[i] = c; y1[i] = r; x2[i] = c; y2[i] = r + 1; }
    var R = rng(0xD075 + w * 97 + h), z1 = new Int32Array(NE), z2 = new Int32Array(NE);
    for (i = 0; i < NE; i++) { z1[i] = (R() * 4294967296) | 0; z2[i] = (R() * 4294967296) | 0; }
    GEOS[key] = { w: w, h: h, NH: NH, NV: NV, NE: NE, NB: NB, eb: eb, be: be, x1: x1, y1: y1, x2: x2, y2: y2, z1: z1, z2: z2 };
    return GEOS[key];
  }

  // ---- the game ----
  function newGame(o) {
    o = o || {};
    var w = clampInt(o.w, MIN_N, MAX_N, 5), h = clampInt(o.h == null ? w : o.h, MIN_N, MAX_N, w);
    var n = clampInt(o.n, 2, 4, 2), G = geo(w, h), sc = [];
    for (var i = 0; i < n; i++) sc.push(0);
    var own = new Int8Array(G.NB);
    for (i = 0; i < G.NB; i++) own[i] = -1;
    return {
      w: w, h: h, n: n, G: G, ed: new Uint8Array(G.NE), sd: new Uint8Array(G.NB), own: own,
      score: sc, first: clampInt(o.first, 0, n - 1, 0), turn: clampInt(o.first, 0, n - 1, 0), moves: [], left: G.NB, over: false
    };
  }
  // Draw edge e for the player to move. Returns the boxes it closed ([] = turn passes), or null if illegal.
  function play(g, e) {
    if (g.over || !(e >= 0 && e < g.G.NE) || g.ed[e]) return null;
    var p = g.turn, G = g.G, got = [];
    g.ed[e] = p + 1;
    for (var k = 0; k < 2; k++) {
      var b = G.eb[e * 2 + k];
      if (b >= 0 && ++g.sd[b] === 4) { g.own[b] = p; got.push(b); }
    }
    g.score[p] += got.length; g.left -= got.length;
    g.moves.push({ e: e, p: p, got: got });
    if (!got.length) g.turn = (p + 1) % g.n;
    if (!g.left) g.over = true;
    return got;
  }
  function undo(g) {
    var m = g.moves.pop();
    if (!m) return null;
    var G = g.G;
    g.ed[m.e] = 0;
    for (var k = 0; k < 2; k++) { var b = G.eb[m.e * 2 + k]; if (b >= 0) g.sd[b]--; }
    for (k = 0; k < m.got.length; k++) g.own[m.got[k]] = -1;
    g.score[m.p] -= m.got.length; g.left += m.got.length;
    g.turn = m.p; g.over = false;
    return m;
  }
  function legal(g) { var out = []; if (g.over) return out; for (var e = 0; e < g.G.NE; e++) if (!g.ed[e]) out.push(e); return out; }
  function winners(g) {
    var best = -1, w = [];
    for (var i = 0; i < g.n; i++) { if (g.score[i] > best) { best = g.score[i]; w = [i]; } else if (g.score[i] === best) w.push(i); }
    return w;
  }
  // Replay a list of edges into a fresh game (stops at the first illegal one).
  function replay(o, moves) {
    var g = newGame(o);
    for (var i = 0; i < (moves || []).length; i++) if (!play(g, moves[i])) break;
    return g;
  }

  // ---- the AI's working board: edges 0/1, side counts, an incremental hash ----
  function board(g) {
    var ed = new Uint8Array(g.G.NE), h1 = 0, h2 = 0;
    for (var e = 0; e < g.G.NE; e++) if (g.ed[e]) { ed[e] = 1; h1 ^= g.G.z1[e]; h2 ^= g.G.z2[e]; }
    return { G: g.G, ed: ed, sd: new Uint8Array(g.sd), left: g.left, h1: h1, h2: h2 };
  }
  function cloneB(B) { return { G: B.G, ed: new Uint8Array(B.ed), sd: new Uint8Array(B.sd), left: B.left, h1: B.h1, h2: B.h2 }; }
  function draw(B, e) {
    var G = B.G, c = 0;
    B.ed[e] = 1; B.h1 ^= G.z1[e]; B.h2 ^= G.z2[e];
    var b = G.eb[e * 2]; if (b >= 0 && ++B.sd[b] === 4) c++;
    b = G.eb[e * 2 + 1]; if (b >= 0 && ++B.sd[b] === 4) c++;
    B.left -= c;
    return c;
  }
  function undraw(B, e, c) {
    var G = B.G;
    B.ed[e] = 0; B.h1 ^= G.z1[e]; B.h2 ^= G.z2[e];
    var b = G.eb[e * 2]; if (b >= 0) B.sd[b]--;
    b = G.eb[e * 2 + 1]; if (b >= 0) B.sd[b]--;
    B.left += c;
  }
  function other(G, e, b) { var a = G.eb[e * 2]; return a === b ? G.eb[e * 2 + 1] : a; }
  function missing(B, b, not) {
    var be = B.G.be;
    for (var k = 0; k < 4; k++) { var e = be[b * 4 + k]; if (!B.ed[e] && e !== not) return e; }
    return -1;
  }
  // A safe line gives no box its third side.
  function isSafe(B, e) {
    var G = B.G, b = G.eb[e * 2];
    if (b >= 0 && B.sd[b] >= 2) return false;
    b = G.eb[e * 2 + 1];
    return !(b >= 0 && B.sd[b] >= 2);
  }
  function safeMoves(B) { var out = []; for (var e = 0; e < B.G.NE; e++) if (!B.ed[e] && isSafe(B, e)) out.push(e); return out; }
  function capturable(B) { for (var b = 0; b < B.G.NB; b++) if (B.sd[b] === 3) return b; return -1; }
  // Take every box on offer (in place). Returns how many.
  function greedy(B) {
    var n = 0, b;
    while ((b = capturable(B)) >= 0) n += draw(B, missing(B, b));
    return n;
  }

  // Strings: maximal runs of boxes with exactly two sides drawn (two lines left),
  // ending at the edge of the board (-1), at a junction box (0 or 1 sides), or
  // closing on themselves (a loop). Each: { boxes, edges (k+1 for a chain, k for a loop), k, loop, ends }.
  function strings(B) {
    var G = B.G, NB = G.NB, vis = new Uint8Array(NB), out = [];
    for (var b0 = 0; b0 < NB; b0++) {
      if (B.sd[b0] !== 2 || vis[b0]) continue;
      vis[b0] = 1;
      var e1 = missing(B, b0), e2 = missing(B, b0, e1), sides = [], loop = false;
      for (var s = 0; s < 2 && !loop; s++) {
        var cur = b0, e = s ? e2 : e1, bx = [], ex = [], end = -1;
        for (;;) {
          ex.push(e);
          var nb = other(G, e, cur);
          if (nb === b0) { loop = true; break; }
          if (nb < 0 || B.sd[nb] !== 2) { end = nb; break; }
          vis[nb] = 1; bx.push(nb);
          e = missing(B, nb, e); cur = nb;
        }
        sides.push({ bx: bx, ex: ex, end: end });
      }
      var st;
      if (loop) st = { boxes: [b0].concat(sides[0].bx), edges: sides[0].ex, loop: true, ends: [] };
      else {
        st = {
          boxes: sides[0].bx.slice().reverse().concat([b0], sides[1].bx),
          edges: sides[0].ex.slice().reverse().concat(sides[1].ex), loop: false, ends: [sides[0].end, sides[1].end]
        };
      }
      st.k = st.boxes.length;
      out.push(st);
    }
    out.sort(function (a, b) { return a.k - b.k || (a.loop ? 1 : 0) - (b.loop ? 1 : 0); });
    return out;
  }
  // Lines that open a string, one per way of opening that can matter:
  // a 2-chain in the middle (no double-cross possible) or at an end.
  function openers(st) {
    if (st.loop) return [st.edges[0]];
    if (st.k === 2) return [st.edges[1], st.edges[0]];
    return [st.edges[0]];
  }

  // Value (net boxes for the player who must open next) of a set of independent
  // chains and loops, with perfect play: the capturer of a chain of k ≥ 3 may take
  // all and move on, or take k-2 and hand back the last 2 (a double-cross) to keep
  // control; a loop leaves 4. Memoised on the multiset.
  var VMEMO = new Map();
  function openVal(c, v) {
    var k = Math.abs(c);
    if (c < 0) return -Math.max(k + v, k - 8 - v);                 // a loop (stored negative)
    if (k <= 2) return -(k + v);                                     // 1, or a 2 opened in the middle
    return -Math.max(k + v, k - 4 - v);
  }
  function compValue(list) {
    if (!list.length) return 0;
    if (list.length > 8) return orderValue(list);
    var key = list.join(',');
    var hit = VMEMO.get(key);
    if (hit !== undefined) return hit;
    var best = -Infinity, seen = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (seen[c]) continue;
      seen[c] = 1;
      var val = openVal(c, compValue(list.slice(0, i).concat(list.slice(i + 1))));
      if (val > best) best = val;
    }
    best += 0;                                                       // no -0
    if (VMEMO.size > 50000) VMEMO.clear();
    VMEMO.set(key, best);
    return best;
  }
  // Many components: the opener sacrifices in the usual order (short chains, then
  // loops, then chains by size) and the taker decides each time. Linear, close to exact.
  function orderValue(list) {
    var o = list.slice().sort(function (a, b) {
      var ka = Math.abs(a), kb = Math.abs(b), ra = ka <= 2 && a > 0 ? 0 : a < 0 ? 1 : 2, rb = kb <= 2 && b > 0 ? 0 : b < 0 ? 1 : 2;
      return ra - rb || ka - kb;
    });
    var v = 0;
    for (var i = o.length - 1; i >= 0; i--) v = openVal(o[i], v);
    return v + 0;
  }
  function compList(sts) {
    var l = sts.map(function (s) { return s.loop ? -s.k : s.k; });
    l.sort(function (a, b) { return a - b; });
    return l;
  }
  // Estimated net for the player to move once no safe line is left: chains and
  // loops as if independent; the junction boxes go the way of control.
  function loonyValue(B) {
    var sts = strings(B), v = compValue(compList(sts)), n = 0;
    for (var i = 0; i < sts.length; i++) n += sts[i].k;
    var j = B.left - n;
    return v + (v > 0 ? j : v < 0 ? -j : 0);
  }

  // ---- exact search (2 players; value = net boxes still to come for the mover) ----
  // Move generation keeps only moves that can matter:
  // · a box is on offer: take it — unless it is the second-last of a chain (or the
  //   fourth-last of a loop), where declining with the far line (a double-cross) is the alternative;
  // · else safe lines (plus short sacrifices, in the opening);
  // · else one opener per chain / loop.
  function genMoves(B, sac) {
    var G = B.G, NB = G.NB, dd = -1, de = -1, b, e, o;
    for (b = 0; b < NB; b++) {
      if (B.sd[b] !== 3) continue;
      e = missing(B, b); o = other(G, e, b);
      if (o < 0 || B.sd[o] !== 2) return [e];
      if (dd < 0) { dd = o; de = e; }
    }
    if (dd >= 0) {
      var f = missing(B, dd, de), C = other(G, f, dd);
      if (C < 0 || B.sd[C] <= 1) return [de, f];
      if (B.sd[C] === 2) {
        var g2 = missing(B, C, f), D = other(G, g2, C);
        if (D >= 0 && B.sd[D] === 3 && missing(B, D) === g2) return [de, f];
      }
      return [de];
    }
    var safe = safeMoves(B);
    var sts = (!safe.length || sac) ? strings(B) : null, out = safe;
    if (sts) {
      for (var i = 0; i < sts.length; i++) {
        if (safe.length && (sts[i].loop || sts[i].k > 2)) continue;
        out = out.concat(openers(sts[i]));
      }
    }
    return out;
  }
  var ABORT = { abort: true };
  function negamax(B, alpha, beta, X) {
    if (!B.left) return 0;
    if (++X.nodes > X.max) throw ABORT;
    var key = (B.h1 >>> 0) * 2097152 + (B.h2 >>> 11), t = X.tt.get(key);
    if (t) {
      if (t.f === 0) return t.v;
      if (t.f === 1 && t.v >= beta) return t.v;
      if (t.f === -1 && t.v <= alpha) return t.v;
    }
    var moves = genMoves(B, X.sac), best = -Infinity, a0 = alpha;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], c = draw(B, m), v;
      try { v = c ? c + negamax(B, alpha - c, beta - c, X) : -negamax(B, -beta, -alpha, X); }
      finally { undraw(B, m, c); }
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    best += 0;
    X.tt.set(key, { v: best, f: best <= a0 ? -1 : best >= beta ? 1 : 0 });
    return best;
  }
  // Best move by exact search, or null if it needs more than maxNodes.
  function solve(B, maxNodes, sac) {
    var X = { nodes: 0, max: maxNodes || 200000, tt: new Map(), sac: !!sac };
    var moves = genMoves(B, X.sac), best = -Infinity, bm = -1, alpha = -Infinity;
    try {
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i], c = draw(B, m), v;
        try { v = c ? c + negamax(B, alpha - c, Infinity, X) : -negamax(B, -Infinity, -alpha, X); }
        finally { undraw(B, m, c); }
        if (v > best) { best = v; bm = m; }
        if (best > alpha) alpha = best;
      }
    } catch (x) {
      if (x === ABORT) return null;
      throw x;
    }
    return { move: bm, value: best + 0, nodes: X.nodes };
  }

  // ---- Monte-Carlo for the long-chain fight: random safe play to the end of the
  // safe lines, then the chain value above ----
  function rollout(B, me, R) {
    // B: a scratch board; me: true if the root player is to move. Returns net for the root player.
    var net = 0, NE = B.G.NE, c, b;
    while ((b = capturable(B)) >= 0) { c = draw(B, missing(B, b)); net += me ? c : -c; }
    var list = [];
    for (var e = 0; e < NE; e++) if (!B.ed[e] && isSafe(B, e)) list.push(e);
    while (list.length) {
      var i = (R() * list.length) | 0, x = list[i];
      list[i] = list[list.length - 1]; list.pop();
      if (B.ed[x] || !isSafe(B, x)) continue;
      draw(B, x); me = !me;
    }
    if (!B.left) return net;
    var v = loonyValue(B);
    return net + (me ? v : -v);
  }
  function monteCarlo(B, cands, R, total) {
    var per = Math.max(6, Math.floor(total / cands.length)), best = -Infinity, bm = cands[0];
    for (var i = 0; i < cands.length; i++) {
      var sum = 0;
      for (var j = 0; j < per; j++) {
        var T = cloneB(B), c = draw(T, cands[i]);
        sum += c + rollout(T, c > 0, R);
      }
      var avg = sum / per + R() * 1e-6;
      if (avg > best) { best = avg; bm = cands[i]; }
    }
    return bm;
  }

  // Chain-rule play without search (the fallback once the safe lines are gone).
  function loonyPlay(B) {
    var opts = genMoves(B, false), b = capturable(B);
    if (b >= 0) {
      if (opts.length === 1) return opts[0];
      // the double-cross question: take everything and open the next chain, or hand back the last 2 (4)?
      var T = cloneB(B), got = greedy(T), v1 = loonyValue(T), f = opts[1];
      var U = cloneB(B), cf = draw(U, f);
      var give = cf ? 0 : greedy(U), keep = got - give;
      return keep - give - v1 > got + v1 ? f : opts[0];
    }
    var sts = strings(B);
    if (!sts.length) return opts[0];
    var all = compList(sts), best = -Infinity, bm = opts[0];
    for (var i = 0; i < sts.length; i++) {
      var s = sts[i], k = s.k, key = s.loop ? -k : k, rest = all.slice(), at = rest.indexOf(key);
      rest.splice(at, 1);
      var val = openVal(key, compValue(rest));
      if (val > best) { best = val; bm = openers(s)[0]; }
    }
    return bm;
  }

  // Pick the CPU's line. level: 'easy' | 'medium' | 'hard'; R: a () → [0,1) source.
  function aiMove(g, level, R, opt) {
    R = R || Math.random; opt = opt || {};
    var B = board(g), L = LEVELS.indexOf(level) < 0 ? 'medium' : level;
    var all = [], e;
    for (e = 0; e < g.G.NE; e++) if (!B.ed[e]) all.push(e);
    if (!all.length) return -1;
    function pick(a) { return a[(R() * a.length) | 0]; }
    var cb = capturable(B), safe = safeMoves(B);
    if (L === 'easy') {
      if (cb >= 0 && R() < 0.8) return missing(B, cb);
      if (safe.length && R() < 0.88) return pick(safe);
      return pick(all);
    }
    if (L === 'medium') {
      if (cb >= 0) return missing(B, cb);
      if (safe.length) return pick(safe);
      var sts = strings(B);
      if (!sts.length) return pick(all);
      var k0 = sts[0].k, small = sts.filter(function (s) { return s.k === k0; }), s0 = pick(small);
      return pick(s0.edges);
    }
    // hard
    var budget = opt.nodes || 150000;
    if (cb >= 0) {
      var T = cloneB(B);
      greedy(T);
      if (safeMoves(T).length) return missing(B, cb);   // boxes now, the fight comes later
      var r = solve(B, budget);
      return r ? r.move : loonyPlay(B);
    }
    if (!safe.length) {
      var r2 = solve(B, budget);
      return r2 ? r2.move : loonyPlay(B);
    }
    if (safe.length <= (opt.exactSafe || 9)) {
      var r3 = solve(B, budget, true);
      if (r3) return r3.move;
    }
    if (safe.length > 44) {
      // the opening: anything safe, preferring lines that keep boxes open (fewer 2-sided boxes)
      var calm = safe.filter(function (x) {
        var a = g.G.eb[x * 2], b2 = g.G.eb[x * 2 + 1];
        return (a < 0 || B.sd[a] === 0) && (b2 < 0 || B.sd[b2] === 0);
      });
      return pick(calm.length && R() < 0.6 ? calm : safe);
    }
    var cands = safe.slice(), sts2 = strings(B);
    for (var i = 0; i < sts2.length; i++) if (!sts2[i].loop && sts2[i].k <= 2) cands = cands.concat(openers(sts2[i]).slice(0, 1));
    return monteCarlo(B, cands, R, opt.rollouts || 2400);
  }

  // ---- saves ----
  function normOpts(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      mode: o.mode === 'pp' ? 'pp' : 'cpu',
      size: clampInt(o.size, MIN_N, MAX_N, 5),
      level: LEVELS.indexOf(o.level) >= 0 ? o.level : 'medium',
      players: clampInt(o.players, 2, 4, 2),
      first: ['you', 'cpu', 'alt'].indexOf(o.first) >= 0 ? o.first : 'alt',
      nextFirst: clampInt(o.nextFirst, 0, 1, 0)
    };
  }
  function newStats() {
    var s = { cpu: {}, pp: { games: 0, by: { 2: 0, 3: 0, 4: 0 } }, boxes: 0, bigTurn: 0, games: 0 };
    LEVELS.forEach(function (l) { s.cpu[l] = { p: 0, w: 0, l: 0, d: 0, streak: 0, best: 0, margin: 0 }; });
    return s;
  }
  function nn(v) { v = Math.floor(+v); return isFinite(v) && v > 0 ? v : 0; }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    LEVELS.forEach(function (l) {
      var c = o.cpu && o.cpu[l];
      if (!c || typeof c !== 'object') return;
      for (var k in s.cpu[l]) s.cpu[l][k] = nn(c[k]);
      var t = s.cpu[l];
      if (t.w + t.l + t.d > t.p) t.p = t.w + t.l + t.d;
      if (t.best < t.streak) t.best = t.streak;
    });
    if (o.pp && typeof o.pp === 'object') {
      s.pp.games = nn(o.pp.games);
      if (o.pp.by) for (var n = 2; n <= 4; n++) s.pp.by[n] = nn(o.pp.by[n]);
    }
    s.boxes = nn(o.boxes); s.bigTurn = nn(o.bigTurn); s.games = nn(o.games);
    return s;
  }
  // A game in progress: options + the move list (replayed and checked on load).
  function saveGame(g, meta) {
    return { v: 1, mode: meta.mode, level: meta.level, cpu: meta.cpu, w: g.w, h: g.h, n: g.n, first: g.first, moves: g.moves.map(function (m) { return m.e; }) };
  }
  function normGame(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.moves)) return null;
    var mode = o.mode === 'pp' ? 'pp' : 'cpu', n = mode === 'cpu' ? 2 : clampInt(o.n, 2, 4, 2);
    var g = newGame({ w: o.w, h: o.h, n: n, first: o.first });
    for (var i = 0; i < o.moves.length; i++) if (!play(g, o.moves[i] | 0)) return null;
    if (g.over) return null;
    return {
      game: g,
      meta: { mode: mode, level: LEVELS.indexOf(o.level) >= 0 ? o.level : 'medium', cpu: mode === 'cpu' ? (o.cpu === 0 ? 0 : 1) : -1 }
    };
  }
  // Fold a finished game into the stats. human: the human's seat vs the CPU (-1 in pass-and-play).
  // Returns notes for the result card.
  function settle(st, g, meta) {
    // vs the CPU only your own turns count towards 'most boxes in one turn'
    var notes = { result: 'draw', best: false, streak: 0 }, big = bigTurn(g, meta.mode === 'cpu' ? 1 - meta.cpu : -1);
    st.games++;
    if (big > st.bigTurn) { st.bigTurn = big; notes.bigTurn = big; }
    if (meta.mode === 'cpu') {
      var me = 1 - meta.cpu, t = st.cpu[meta.level] || st.cpu.medium, diff = g.score[me] - g.score[meta.cpu];
      st.boxes += g.score[me];
      t.p++;
      if (diff > 0) {
        t.w++; t.streak++; notes.result = 'win';
        if (t.streak > t.best) { t.best = t.streak; notes.best = t.streak > 1; }
        if (diff > t.margin) { t.margin = diff; notes.margin = diff; }
      } else if (diff < 0) { t.l++; t.streak = 0; notes.result = 'loss'; }
      else { t.d++; notes.result = 'draw'; }
      notes.streak = t.streak;
    } else {
      st.pp.games++; st.pp.by[g.n] = (st.pp.by[g.n] || 0) + 1;
      notes.result = winners(g).length > 1 ? 'draw' : 'win';
    }
    return notes;
  }
  // Most boxes one player (or only seat `only`, when given and >= 0) took in a single turn.
  function bigTurn(g, only) {
    var best = 0, run = 0, who = -1;
    for (var i = 0; i < g.moves.length; i++) {
      var m = g.moves[i];
      if (m.p !== who) { run = 0; who = m.p; }
      run += m.got.length;
      if (run > best && !(only >= 0 && m.p !== only)) best = run;
      if (!m.got.length) { run = 0; who = -1; }
    }
    return best;
  }

  var ENGINE = {
    MIN_N: MIN_N, MAX_N: MAX_N, LEVELS: LEVELS, rng: rng, geo: geo,
    newGame: newGame, play: play, undo: undo, legal: legal, winners: winners, replay: replay,
    board: board, cloneB: cloneB, draw: draw, undraw: undraw, isSafe: isSafe, safeMoves: safeMoves, capturable: capturable,
    greedy: greedy, strings: strings, openers: openers, compValue: compValue, loonyValue: loonyValue,
    genMoves: genMoves, solve: solve, loonyPlay: loonyPlay, aiMove: aiMove,
    normOpts: normOpts, newStats: newStats, normStats: normStats, saveGame: saveGame, normGame: normGame, settle: settle, bigTurn: bigTurn
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('dotsboxes.css');

  var PANEL_ID = 'dotsboxes-panel', NAME = 'Dots and Boxes';
  var KEY = 'cade-dotsboxes-', OPTS_KEY = KEY + 'opts', STATS_KEY = KEY + 'stats', GAME_KEY = KEY + 'game', SOUND_KEY = KEY + 'sound';
  var GLYPHS = ['X', '@', '#', '&'];
  var LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.dotsboxes = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
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

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
  var IC_HINT = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>');
  var IC_FLAG = svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
  var IC_AGAIN = svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>');

  // ---- theme colours (from the app's CSS variables) ----
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
  function css(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var pc = [ac, parseCol(dark ? '#f06a6a' : '#cf3f3f'), parseCol(dark ? '#f2c544' : '#b07d06'), parseCol(dark ? '#b79cf5' : '#7351c4')];
    S.dark = dark;
    S.pal = {
      bg: css(bg), text: css(tx), muted: css(mu), faint: css(fa), guide: css(mix(bg, tx, dark ? 0.3 : 0.24)), acc: css(ac),
      p: pc.map(function (c) { return css(c); }),
      pa: pc.map(function (c) { return function (a) { return css(c, a); }; }),
      tint: pc.map(function (c) { return css(mix(bg, c, dark ? 0.2 : 0.14)); }),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
  }

  // ---- who's who ----
  function seatColor(i) { return S.meta.mode === 'cpu' ? (i === S.meta.cpu ? 1 : 0) : i; }
  function seatGlyph(i) { return S.meta.mode === 'cpu' ? GLYPHS[i === S.meta.cpu ? 1 : 0] : GLYPHS[i]; }
  function seatName(i, short) {
    if (S.meta.mode === 'cpu') return i === S.meta.cpu ? 'CPU' : 'You';
    return short ? 'P' + (i + 1) : 'Player ' + (i + 1);
  }
  function isCpuTurn() { return !!S.g && !S.g.over && S.meta.mode === 'cpu' && S.g.turn === S.meta.cpu; }
  function canAct() { return !!S.g && !S.preview && !S.g.over && !S.card && !isCpuTurn(); }

  // ---- persistence ----
  function persistGame() {
    if (!S.g || S.g.over || !S.g.moves.length) { sdel(GAME_KEY); return; }
    sset(GAME_KEY, JSON.stringify(saveGame(S.g, S.meta)));
  }
  function persistOpts() { sset(OPTS_KEY, JSON.stringify(S.opts)); }
  function persistStats() { sset(STATS_KEY, JSON.stringify(S.stats)); }

  // ---- layout ----
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var W = Math.max(250, Math.floor(phone ? vw - 34 : Math.min(vw - 48, solo ? 720 : 470)));
    // the panel's chrome around the board, measured part by part (the panel may be clipped by its max-height)
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head');
    var chrome = (hd ? hd.offsetHeight : 40) + (S.bar.offsetHeight || 34) + (S.status.offsetHeight || 18) + (S.pad.offsetHeight || 44) +
      18 + (phone ? 16 : 20) + 4 + (S.coarse ? 10 : 0);
    var ah = Math.max(250, vh - (solo ? 0 : Math.min(Math.max(0, r.top), 140)) - chrome - 10);
    var w = S.g ? S.g.w : S.opts.size, h = S.g ? S.g.h : S.opts.size;
    var cell = Math.min(W / (w + 0.9), ah / (h + 0.9), solo ? 112 : 86);
    var H = Math.floor(Math.max(cell * (h + 0.9), Math.min(ah, phone ? 420 : 380), 300));
    var dpr = Math.min(2.5, window.devicePixelRatio || 1);
    S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
    S.root.style.setProperty('--db-w', W + 'px');
    S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
    S.L = { W: W, H: H, cell: cell, ox: (W - cell * w) / 2, oy: (H - cell * h) / 2, dpr: dpr, w: w, h: h };
    S.phone = phone;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }

  // ---- hit-testing: the nearest undrawn line to a point (generous: half a box) ----
  function ptToEdge(px, py) {
    var g = S.g, L = S.L;
    if (!g) return -1;
    var u = (px - L.ox) / L.cell, v = (py - L.oy) / L.cell, G = g.G, best = -1, bd = 0.62;
    var c0 = Math.max(0, Math.min(g.w - 1, Math.floor(u))), r0 = Math.max(0, Math.min(g.h - 1, Math.floor(v)));
    for (var r = Math.max(0, r0 - 1); r <= Math.min(g.h - 1, r0 + 1); r++) {
      for (var c = Math.max(0, c0 - 1); c <= Math.min(g.w - 1, c0 + 1); c++) {
        for (var k = 0; k < 4; k++) {
          var e = G.be[(r * g.w + c) * 4 + k];
          if (g.ed[e]) continue;
          var d = segDist(u, v, G.x1[e], G.y1[e], G.x2[e], G.y2[e]);
          if (d < bd) { bd = d; best = e; }
        }
      }
    }
    return best;
  }
  function segDist(u, v, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, t = ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    var X = x1 + dx * t - u, Y = y1 + dy * t - v;
    return Math.sqrt(X * X + Y * Y) + (t === 0 || t === 1 ? 0.05 : 0);
  }
  function evPt(e) { var r = S.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---- drawing ----
  function easeOutBack(t) { var c = 1.7; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; }
  function render() {
    if (!S || !S.ctx || !S.pal) return;
    var c = S.ctx, L = S.L, P = S.pal, t = now(), g = S.g;
    c.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    c.clearRect(0, 0, L.W, L.H);
    var A = S.anim, live = false;
    if (!g) return;
    var G = g.G, cell = L.cell, ox = L.ox, oy = L.oy, lw = Math.max(2.6, cell * 0.085), e, b;
    function X(x) { return ox + x * cell; }
    function Y(y) { return oy + y * cell; }
    c.lineCap = 'round';
    // boxes
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (b = 0; b < G.NB; b++) {
      var o = g.own[b];
      if (o < 0) continue;
      var r = (b / g.w) | 0, col = b % g.w, t0 = A.boxes[b], k = 1;
      if (t0 != null) {
        var p = (t - t0) / 320;
        if (p < 0) { live = true; continue; }
        if (p < 1) { k = Math.max(0.05, easeOutBack(p)); live = true; } else delete A.boxes[b];
      }
      var ci = seatColor(o), cx = X(col + 0.5), cy = Y(r + 0.5), half = (cell / 2 - lw * 0.9) * Math.min(1, k);
      c.fillStyle = P.tint[ci];
      c.fillRect(cx - half, cy - half, half * 2, half * 2);
      c.fillStyle = P.p[ci];
      c.font = '700 ' + (cell * 0.5 * k).toFixed(1) + 'px ' + P.font;
      c.fillText(seatGlyph(o), cx, cy + cell * 0.02);
    }
    // guides: faint dotted lines where a line can go
    c.strokeStyle = P.guide; c.lineWidth = Math.max(1.2, cell * 0.035);
    c.setLineDash([0.1, Math.max(5, cell / 7)]);
    c.beginPath();
    for (e = 0; e < G.NE; e++) {
      if (g.ed[e]) continue;
      c.moveTo(X(G.x1[e]), Y(G.y1[e])); c.lineTo(X(G.x2[e]), Y(G.y2[e]));
    }
    c.stroke();
    c.setLineDash([]);
    // drawn lines, in the colour of whoever drew them; the newest grows in
    var last = g.moves.length ? g.moves[g.moves.length - 1].e : -1;
    for (var i = 0; i < g.moves.length; i++) {
      var m = g.moves[i], x1 = X(G.x1[m.e]), y1 = Y(G.y1[m.e]), x2 = X(G.x2[m.e]), y2 = Y(G.y2[m.e]), f = 1, la = A.lines[m.e];
      if (la != null) {
        f = (t - la) / 150;
        if (f < 1) { live = true; f = Math.max(0, 1 - Math.pow(1 - f, 3)); } else { delete A.lines[m.e]; f = 1; }
      }
      var ci2 = seatColor(m.p);
      if (m.e === last) {
        c.strokeStyle = P.pa[ci2](S.dark ? 0.28 : 0.2); c.lineWidth = lw * 2.8;
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f); c.stroke();
      }
      c.strokeStyle = P.p[ci2]; c.lineWidth = lw;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f); c.stroke();
    }
    // hint (pulsing), then the hover / keyboard cursor
    if (S.hint >= 0 && !g.ed[S.hint]) {
      var hp = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t / 140));
      if (t - S.hintT < 4000) live = true; else S.hint = -1;
      if (S.hint >= 0) {
        c.strokeStyle = P.pa[seatColor(g.turn)](hp); c.lineWidth = lw * 2.4;
        c.beginPath(); c.moveTo(X(G.x1[S.hint]), Y(G.y1[S.hint])); c.lineTo(X(G.x2[S.hint]), Y(G.y2[S.hint])); c.stroke();
      }
    }
    var hv = canAct() ? (S.kbd ? S.cursor : S.hover) : -1;
    if (hv >= 0 && !g.ed[hv]) {
      var hc = seatColor(g.turn);
      c.strokeStyle = P.pa[hc](0.18); c.lineWidth = lw * 3.2;
      c.beginPath(); c.moveTo(X(G.x1[hv]), Y(G.y1[hv])); c.lineTo(X(G.x2[hv]), Y(G.y2[hv])); c.stroke();
      c.strokeStyle = P.pa[hc](0.75); c.lineWidth = lw;
      c.setLineDash([lw * 1.2, lw * 1.6]);
      c.beginPath(); c.moveTo(X(G.x1[hv]), Y(G.y1[hv])); c.lineTo(X(G.x2[hv]), Y(G.y2[hv])); c.stroke();
      c.setLineDash([]);
    }
    // dots
    c.fillStyle = P.text;
    var dr = Math.max(2.4, cell * 0.075);
    for (var yy = 0; yy <= g.h; yy++) for (var xx = 0; xx <= g.w; xx++) {
      c.beginPath(); c.arc(X(xx), Y(yy), dr, 0, Math.PI * 2); c.fill();
    }
    // sparks and call-outs (monospace glyphs)
    if (A.parts.length) {
      live = true;
      c.font = '700 ' + Math.max(10, cell * 0.26).toFixed(1) + 'px ' + P.font;
      for (i = A.parts.length - 1; i >= 0; i--) {
        var q = A.parts[i], age = (t - q.t0) / 1000;
        if (age < 0) continue;
        if (age > q.life) { A.parts.splice(i, 1); continue; }
        var px = q.x + q.vx * age, py = q.y + q.vy * age + 0.5 * 900 * age * age * q.g;
        c.globalAlpha = Math.max(0, 1 - age / q.life);
        c.fillStyle = P.p[q.ci];
        c.fillText(q.ch, px, py);
      }
      c.globalAlpha = 1;
    }
    if (A.floats.length) {
      live = true;
      for (i = A.floats.length - 1; i >= 0; i--) {
        var fl = A.floats[i], fa = (t - fl.t0) / 1000;
        if (fa < 0) continue;
        if (fa > fl.life) { A.floats.splice(i, 1); continue; }
        var sc = fl.big ? Math.min(1, 0.6 + fa * 4) : 1;
        c.globalAlpha = Math.max(0, Math.min(1, (fl.life - fa) / 0.35));
        c.font = '700 ' + (fl.size * sc).toFixed(1) + 'px ' + P.font;
        c.lineWidth = 4; c.strokeStyle = P.bg; c.lineJoin = 'round';
        c.strokeText(fl.text, fl.x, fl.y - fa * 26);
        c.fillStyle = P.p[fl.ci];
        c.fillText(fl.text, fl.x, fl.y - fa * 26);
      }
      c.globalAlpha = 1;
    }
    return live;
  }
  function frame() {
    if (!S) return;
    S.raf = 0;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    if (render()) S.raf = requestAnimationFrame(frame);
  }
  function kick() { if (S && !S.raf && !document.hidden) S.raf = requestAnimationFrame(frame); }
  function redraw() { if (!S) return; if (S.raf) return; render(); }

  // box pop: sparks fly out of it, a +1 rises
  function burst(b, ci, delay) {
    var g = S.g, L = S.L, r = (b / g.w) | 0, col = b % g.w, t0 = now() + delay, chars = '*+.*+:';
    if (S.rm) return;
    for (var i = 0; i < 9; i++) {
      var a = Math.random() * Math.PI * 2, sp = 90 + Math.random() * 120;
      S.anim.parts.push({
        x: L.ox + (col + 0.5) * L.cell, y: L.oy + (r + 0.5) * L.cell, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 90,
        g: 0.7, life: 0.35 + Math.random() * 0.25, ch: chars.charAt((Math.random() * chars.length) | 0), ci: ci, t0: t0
      });
    }
  }
  // particles are stored in pixels; render maps them through X()/Y() helpers, so convert back
  function floatText(text, x, y, ci, big, delay) {
    S.anim.floats.push({ text: text, x: x, y: y, ci: ci, big: !!big, size: big ? Math.max(18, S.L.cell * 0.42) : Math.max(13, S.L.cell * 0.3), life: big ? 1.3 : 0.8, t0: now() + (delay || 0) });
  }

  // ---- the scoreboard, status and pad ----
  function renderBar() {
    var g = S.g;
    if (!g) { S.bar.innerHTML = ''; return; }
    var lead = Math.max.apply(null, g.score), h = '', short = g.n > 2 && S.phone;
    for (var i = 0; i < g.n; i++) {
      var on = !g.over && !S.preview && g.turn === i, win = g.over && g.score[i] === lead;
      h += '<div class="db-pl db-c' + seatColor(i) + (on ? ' on' : '') + (win ? ' win' : '') + '">' +
        '<b class="db-g">' + esc(seatGlyph(i)) + '</b><span class="db-nm">' + esc(seatName(i, short)) +
        (on && isCpuTurn() ? '<em class="db-think"><b>.</b><b>.</b><b>.</b></em>' : '') + '</span>' +
        '<i class="db-sc">' + g.score[i] + '</i></div>';
    }
    S.bar.innerHTML = h;
    S.bar.setAttribute('data-n', g.n);
  }
  function setStatus(msg) { S.msg = msg; renderStatus(); }
  function renderStatus() {
    var g = S.g, t = '';
    if (!g || S.preview) t = S.coarse ? 'Pick a board and tap Play' : 'Pick a board and press Play';
    else if (g.over) {
      var w = winners(g);
      t = (w.length > 1 ? 'Draw' : S.meta.mode === 'cpu' ? (w[0] === S.meta.cpu ? 'CPU wins' : 'You win') : seatName(w[0]) + ' wins') +
        ' · ' + g.score.join('–') + ' · <u>results</u>';
    } else if (S.msg) t = S.msg;
    else if (isCpuTurn()) t = 'CPU is thinking…';
    else t = (S.meta.mode === 'cpu' ? 'Your turn' : seatName(g.turn) + '’s turn') + ' · ' + g.left + ' box' + (g.left === 1 ? '' : 'es') + ' left';
    S.status.innerHTML = t;
    S.status.classList.toggle('link', !!(g && g.over));
    var ub = S.pad.querySelector('[data-act="undo"]'), hb = S.pad.querySelector('[data-act="hint"]');
    if (ub) ub.disabled = !canUndo();
    if (hb) hb.disabled = !canAct();
    S.pad.classList.toggle('over', !!(g && g.over));
  }
  function announce(s) { if (S && S.live) S.live.textContent = s; }
  function syncHead() {
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function renderPad() {
    var k = !S.coarse;
    S.pad.innerHTML =
      '<button type="button" class="db-act alt" data-act="undo" title="Undo (U)">' + IC_UNDO + '<span>Undo</span>' + (k ? '<small>U</small>' : '') + '</button>' +
      '<button type="button" class="db-act alt" data-act="hint" title="Hint (H)">' + IC_HINT + '<span>Hint</span>' + (k ? '<small>H</small>' : '') + '</button>' +
      '<button type="button" class="db-act alt db-onover" data-act="results">' + IC_FLAG + '<span>Results</span></button>' +
      '<button type="button" class="db-act db-onover" data-act="again">' + IC_AGAIN + '<span>Rematch</span></button>';
  }
  function renderAll() { renderBar(); renderStatus(); redraw(); }

  // ---- playing ----
  function canUndo() {
    var g = S.g;
    if (!g || g.over || S.card || !g.moves.length) return false;
    if (S.meta.mode !== 'cpu') return true;
    for (var i = 0; i < g.moves.length; i++) if (g.moves[i].p !== S.meta.cpu) return true;
    return false;
  }
  function doPlay(e, byCpu) {
    var g = S.g, p = g.turn, got = play(g, e);
    if (!got) return false;
    var t = now(), ci = seatColor(p), L = S.L;
    S.anim.lines[e] = t;
    S.hint = -1; S.msg = '';
    if (S.lastP !== p) S.run = 0;
    S.lastP = p;
    if (got.length) {
      S.run += got.length;
      for (var i = 0; i < got.length; i++) {
        S.anim.boxes[got[i]] = t + 110;
        burst(got[i], ci, 110);
      }
      var b0 = got[0], r0 = (b0 / g.w) | 0, c0 = b0 % g.w;
      floatText('+' + got.length, L.ox + (c0 + 0.5) * L.cell, L.oy + (r0 + 0.2) * L.cell, ci, false, 120);
      if (S.run >= 3 && (S.run === 3 || S.run % 2 === 1 || g.over)) floatText('CHAIN x' + S.run, L.W / 2, L.H / 2, ci, true, 150);
      var f = 660 * Math.pow(2, Math.min(S.run - 1, 14) / 12);
      S.snd.tone(f, 0.09, 'square', 0.03, 0, 0.1);
      S.snd.tone(f * 1.5, 0.12, 'square', 0.022, 0, 0.17);
      if (Cade.haptic) Cade.haptic(got.length > 1 ? 18 : 12);
      if (!g.over) S.msg = byCpu ? 'CPU took ' + (S.run === 1 ? 'a box' : S.run + ' boxes') + '…' :
        (S.meta.mode === 'cpu' ? 'Box! Go again' : seatName(p) + ': box! Go again');
      announce(seatName(p) + ' closed ' + (got.length === 1 ? 'a box' : got.length + ' boxes') + '. ' + g.score.join(' to ') + '.');
    } else {
      S.snd.tone(byCpu ? 440 : 520 + p * 50, 0.05, 'triangle', 0.035);
      if (Cade.haptic && !byCpu) Cade.haptic(6);
      S.run = 0;
      if (!byCpu && S.meta.mode === 'pp' && !g.over) {
        // pass-and-play hand-off: name who gets the device next
        S.msg = 'Pass to ' + seatName(g.turn) + ' · ' + g.left + ' box' + (g.left === 1 ? '' : 'es') + ' left';
        announce(seatName(g.turn) + '’s turn');
      }
    }
    if (S.kbd && g.ed[S.cursor]) S.cursor = nearestFree(S.cursor);
    persistGame();
    if (g.over) finish();
    renderAll(); kick();
    scheduleCpu();
    return true;
  }
  function tryPlay(e) {
    if (!S || !canAct() || e < 0 || S.g.ed[e]) return;
    S.snd.ensure();
    doPlay(e, false);
  }
  function scheduleCpu() {
    clearTimeout(S.cpuT); S.cpuT = 0;
    if (!isCpuTurn() || S.card || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var g = S.g, last = g.moves[g.moves.length - 1], cont = last && last.p === S.meta.cpu && last.got.length;
    S.cpuT = setTimeout(cpuStep, cont ? 210 : (S.meta.level === 'hard' ? 520 : 600));
    renderBar(); renderStatus();
  }
  function cpuStep() {
    if (!S) return;
    S.cpuT = 0;
    if (!isCpuTurn() || S.card || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var m = aiMove(S.g, S.meta.level, Math.random);
    if (m >= 0) doPlay(m, true);
  }
  function undoMove() {
    if (!canUndo()) return;
    clearTimeout(S.cpuT); S.cpuT = 0;
    var g = S.g;
    if (S.meta.mode === 'cpu') {
      while (g.moves.length && g.moves[g.moves.length - 1].p === S.meta.cpu) undo(g);
      undo(g);
    } else undo(g);
    S.anim.lines = {}; S.anim.boxes = {}; S.anim.parts.length = 0; S.anim.floats.length = 0;
    S.hint = -1; S.run = 0; S.lastP = -1; S.msg = 'Undone';
    S.snd.tone(420, 0.08, 'sine', 0.03, 300);
    persistGame();
    renderAll();
    scheduleCpu();
  }
  function hint() {
    if (!canAct()) return;
    S.snd.ensure();
    var e = aiMove(S.g, 'hard', Math.random, { nodes: 120000 });
    if (e < 0) return;
    S.hint = e; S.hintT = now();
    S.hints = (S.hints || 0) + 1;
    S.msg = 'Try the glowing line';
    S.snd.tone(988, 0.06, 'sine', 0.03); S.snd.tone(1319, 0.08, 'sine', 0.025, 0, 0.06);
    renderStatus(); kick();
  }
  function finish() {
    clearTimeout(S.cpuT); S.cpuT = 0;
    var g = S.g;
    S.notes = settle(S.stats, g, S.meta);
    persistStats();
    sdel(GAME_KEY);
    var w = winners(g), meWin = S.notes.result;
    if (S.meta.mode === 'cpu' && meWin === 'loss') {
      S.snd.tone(392, 0.22, 'triangle', 0.04, 0, 0.35); S.snd.tone(262, 0.4, 'triangle', 0.04, 196, 0.58);
    } else if (w.length > 1) {
      S.snd.tone(523, 0.16, 'sine', 0.04, 0, 0.35); S.snd.tone(523, 0.3, 'sine', 0.04, 0, 0.55);
    } else {
      [523, 659, 784, 1047].forEach(function (f, i) { S.snd.tone(f, 0.18, 'square', 0.03, 0, 0.35 + i * 0.1); });
    }
    if (Cade.haptic) Cade.haptic(30);
    clearTimeout(S.resT);
    S.resT = setTimeout(function () { if (S && S.g === g && !S.card) showCard('result'); }, 1100);
  }
  function startGame() {
    var o = S.opts, first = 0;
    clearTimeout(S.cpuT); clearTimeout(S.resT);
    if (o.mode === 'cpu') {
      first = o.first === 'you' ? 0 : o.first === 'cpu' ? 1 : o.nextFirst;
      if (o.first === 'alt') o.nextFirst = 1 - o.nextFirst;
      S.meta = { mode: 'cpu', level: o.level, cpu: 1 };
      S.g = newGame({ w: o.size, h: o.size, n: 2, first: first });
    } else {
      S.meta = { mode: 'pp', level: o.level, cpu: -1 };
      S.g = newGame({ w: o.size, h: o.size, n: o.players, first: 0 });
    }
    persistOpts();
    sdel(GAME_KEY);
    S.anim = { lines: {}, boxes: {}, parts: [], floats: [] };
    S.hint = -1; S.hover = -1; S.cursor = -1; S.run = 0; S.lastP = -1; S.hints = 0; S.preview = false;
    S.msg = S.meta.mode === 'cpu' ? (first === 0 ? 'You go first' : 'CPU goes first') : 'Player 1 goes first — pass the device each turn';
    showCard(null);
    layout();
    renderAll();
    S.snd.tone(660, 0.06, 'sine', 0.03); S.snd.tone(880, 0.08, 'sine', 0.03, 0, 0.07);
    scheduleCpu();
  }

  // ---- keyboard: a cursor that walks the lines ----
  function mid(e) { var G = S.g.G; return [G.x1[e] + G.x2[e], G.y1[e] + G.y2[e]]; }
  function nearestFree(from) {
    var g = S.g, best = -1, bd = Infinity, m0 = from >= 0 ? mid(from) : [g.w, g.h];
    for (var e = 0; e < g.G.NE; e++) {
      if (g.ed[e]) continue;
      var m = mid(e), d = Math.abs(m[0] - m0[0]) + Math.abs(m[1] - m0[1]);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  function moveCursor(dx, dy) {
    var g = S.g;
    if (S.cursor < 0 || g.ed[S.cursor] || !S.kbd) { S.kbd = true; S.cursor = nearestFree(S.cursor); return; }
    var m0 = mid(S.cursor), best = -1, bd = Infinity;
    for (var e = 0; e < g.G.NE; e++) {
      if (g.ed[e] || e === S.cursor) continue;
      var m = mid(e), ax = (m[0] - m0[0]) * dx + (m[1] - m0[1]) * dy;
      if (ax <= 0) continue;
      var perp = Math.abs((m[0] - m0[0]) * dy) + Math.abs((m[1] - m0[1]) * dx), d = ax + perp * 2.2;
      if (d < bd) { bd = d; best = e; }
    }
    if (best >= 0) S.cursor = best;
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
    var k = e.key, onBtn = t && t.tagName === 'BUTTON' && S.panel.contains(t), handled = true;
    if (k === 'Escape') {
      if (S.card === 'help' || S.card === 'stats') closeCard();
      else if (S.card === 'result') showCard(null);
      else if (S.card === 'menu') { if (S.g && !S.g.over && !S.preview) closeCard(); else handled = false; }
      else if (S.kbd || S.hint >= 0) { S.kbd = false; S.hint = -1; redraw(); }
      else handled = false;
      if (handled) e.preventDefault();
      return;
    }
    if (S.card) {
      if ((k === 'Enter' || k === ' ') && !onBtn) {
        e.preventDefault();
        if (S.card === 'menu') startGame(); else if (S.card === 'result') startGame(); else closeCard();
      }
      return;
    }
    var g = S.g;
    if (!g) return;
    if (k === 'ArrowLeft') { moveCursor(-1, 0); redraw(); }
    else if (k === 'ArrowRight') { moveCursor(1, 0); redraw(); }
    else if (k === 'ArrowUp') { moveCursor(0, -1); redraw(); }
    else if (k === 'ArrowDown') { moveCursor(0, 1); redraw(); }
    else if ((k === 'Enter' || k === ' ') && !onBtn) {
      if (g.over) showCard('result');
      else if (S.kbd && S.cursor >= 0 && !g.ed[S.cursor]) tryPlay(S.cursor);
      else { S.kbd = true; S.cursor = nearestFree(S.cursor); redraw(); }
    }
    else if (k === 'u' || k === 'U' || k === 'Backspace') undoMove();
    else if (k === 'h' || k === 'H') hint();
    else if (k === 'n' || k === 'N' || k === 'm' || k === 'M') showCard('menu');
    else if (k === '?') showCard('help');
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---- cards ----
  function chip(attr, val, label, on, extra) {
    return '<button type="button" class="db-chip' + (on ? ' on' : '') + '" ' + attr + '="' + val + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + (extra || '') + '</button>';
  }
  function recLine(l) {
    var t = S.stats.cpu[l];
    return t.p ? t.w + '-' + t.l + (t.d ? '-' + t.d : '') : '';
  }
  function menuHtml() {
    var o = S.opts, h = '<div class="db-card">' +
      '<div class="db-title">DOTS &amp; BOXES</div>' +
      '<pre class="db-art" aria-hidden="true">' + '<i>+</i>---<i>+</i>---<i>+</i>---<i>+</i>\n|<b class="db-c0"> X </b>|<b class="db-c1"> @ </b>|   \n<i>+</i>---<i>+</i>---<i>+</i>   <i>+</i>' + '</pre>' +
      '<div class="db-tabs" role="tablist">' +
      '<button type="button" role="tab" data-mode="cpu" class="' + (o.mode === 'cpu' ? 'on' : '') + '" aria-selected="' + (o.mode === 'cpu') + '">vs CPU</button>' +
      '<button type="button" role="tab" data-mode="pp" class="' + (o.mode === 'pp' ? 'on' : '') + '" aria-selected="' + (o.mode === 'pp') + '">Pass &amp; play</button></div>' +
      '<div class="db-sec"><div class="db-h">Board</div><div class="db-chips">';
    for (var n = MIN_N; n <= MAX_N; n++) h += chip('data-size', n, n + '×' + n, o.size === n);
    h += '</div></div>';
    if (o.mode === 'cpu') {
      h += '<div class="db-sec"><div class="db-h">Level</div><div class="db-chips">';
      LEVELS.forEach(function (l) { var rl = recLine(l); h += chip('data-level', l, LEVEL_NAME[l], o.level === l, rl ? ' <i title="won-lost">' + rl + '</i>' : ''); });
      h += '</div></div><div class="db-sec"><div class="db-h">First line</div><div class="db-chips">' +
        chip('data-first', 'you', 'You', o.first === 'you') + chip('data-first', 'cpu', 'CPU', o.first === 'cpu') +
        chip('data-first', 'alt', 'Take turns', o.first === 'alt') + '</div></div>';
    } else {
      h += '<div class="db-sec"><div class="db-h">Players</div><div class="db-chips">';
      for (var p = 2; p <= 4; p++) {
        var gl = '';
        for (var q = 0; q < p; q++) gl += '<b class="db-c' + q + '">' + GLYPHS[q] + '</b>';
        h += chip('data-players', p, p + ' <span class="db-gls">' + gl + '</span>', o.players === p);
      }
      h += '</div><p class="db-tip">One device: pass it to whoever’s glyph is lit.</p></div>';
    }
    var resumable = S.g && !S.g.over && !S.preview;
    h += '<div class="db-btns"><button type="button" class="db-go" data-act="play">' + (resumable ? 'New game' : 'Play') + '</button>' +
      (resumable ? '<button type="button" class="db-go alt" data-act="close">Resume</button>' : '') + '</div>' +
      '<div class="db-foot"><button type="button" class="db-lnk" data-act="help">How to play</button>' +
      '<button type="button" class="db-lnk" data-act="stats">Records</button></div></div>';
    return h;
  }
  function helpHtml() {
    var k = !S.coarse;
    return '<div class="db-card">' +
      '<div class="db-title">HOW TO PLAY</div>' +
      '<p>Take turns drawing a line between two neighbouring dots — ' + (S.coarse ? 'tap near a gap (slide your finger to adjust, lift to draw)' : 'click near a gap') + '.</p>' +
      '<p>Draw the <b>fourth side</b> of a box and it is yours: your glyph goes in and you <b>must draw again</b>. Most boxes when the board is full wins.</p>' +
      '<div class="db-h">Strategy</div>' +
      '<p>Never draw a box’s <b>third side</b> if you can help it — that hands it over. Late in the game every line does, and the board falls into <b>chains</b> (and loops) of boxes.</p>' +
      '<p><b>Double-cross:</b> when you take a long chain, stop two boxes short and draw the far line instead. Your rival gets those two — then has to open the next chain for you. (In a loop, leave four.)</p>' +
      '<p><b>Long-chain rule:</b> add up the dots and the long chains (3+ boxes). The first player wants that total even, the second wants it odd. Sacrifice a box or two early to steer it — whoever wins this fight usually wins the game.</p>' +
      (k ? '<div class="db-keys"><span><b>Arrows</b> move the cursor · <b>Enter</b> draws</span><span><b>U</b> undo · <b>H</b> hint · <b>N</b> menu · <b>Esc</b> back</span></div>' : '') +
      '<div class="db-btns"><button type="button" class="db-go" data-act="close">' + (S.g && !S.g.over ? 'Back to the game' : 'Got it') + '</button></div></div>';
  }
  function statsHtml() {
    var st = S.stats, h = '<div class="db-card"><div class="db-title">RECORDS</div><pre class="db-tab">' +
      '<i>' + pad('level', 8) + padL('won', 5) + padL('lost', 5) + padL('draw', 5) + padL('streak', 8) + padL('best', 5) + padL('max', 5) + '</i>\n';
    LEVELS.forEach(function (l) {
      var t = st.cpu[l];
      h += '<b>' + pad(LEVEL_NAME[l], 8) + '</b>' + padL(t.w, 5) + padL(t.l, 5) + padL(t.d, 5) + padL(t.streak, 8) + padL(t.best, 5) + padL(t.margin ? '+' + t.margin : '-', 5) + '\n';
    });
    h += '</pre><p class="db-tip db-dim">streak: wins in a row · best: longest streak · max: biggest winning margin</p><p>Pass &amp; play games: <b>' + st.pp.games + '</b>' + (st.pp.games ? ' <span class="db-dim">(2p ' + st.pp.by[2] + ' · 3p ' + st.pp.by[3] + ' · 4p ' + st.pp.by[4] + ')</span>' : '') + '</p>' +
      '<p>Boxes you’ve taken off the CPU: <b>' + st.boxes + '</b></p>' +
      '<p>Most boxes in one turn: <b>' + st.bigTurn + '</b></p>' +
      '<div class="db-btns"><button type="button" class="db-go" data-act="back">Back</button></div>' +
      '<div class="db-foot">' + (S.resetArm ? '<span class="db-confirm">Reset all records?</span><button type="button" class="db-lnk danger" data-act="reset-yes">Reset</button><button type="button" class="db-lnk" data-act="reset-no">Keep</button>' :
        '<span></span><button type="button" class="db-lnk" data-act="reset">Reset records</button>') + '</div></div>';
    return h;
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function resultHtml() {
    var g = S.g, w = winners(g), N = S.notes || {}, title, sub = '';
    if (S.meta.mode === 'cpu') {
      title = w.length > 1 ? 'DRAW' : w[0] === S.meta.cpu ? 'CPU WINS' : 'YOU WIN';
      sub = LEVEL_NAME[S.meta.level] + ' · ' + g.w + '×' + g.h;
    } else {
      title = w.length > 1 ? 'TIE' : seatName(w[0]).toUpperCase() + ' WINS';
      sub = g.n + ' players · ' + g.w + '×' + g.h;
    }
    var h = '<div class="db-card"><div class="db-title">' + esc(title) + '</div><div class="db-sub">' + esc(sub) + '</div>';
    var order = [];
    for (var i = 0; i < g.n; i++) order.push(i);
    order.sort(function (a, b) { return g.score[b] - g.score[a] || a - b; });
    if (g.n === 2) {
      var a = S.meta.mode === 'cpu' ? 1 - S.meta.cpu : 0, b = 1 - a;
      h += '<div class="db-big"><span class="db-c' + seatColor(a) + '">' + g.score[a] + '</span><i>–</i><span class="db-c' + seatColor(b) + '">' + g.score[b] + '</span></div>' +
        '<div class="db-note">' + esc(seatName(a)) + ' vs ' + esc(seatName(b)) + '</div>';
    } else {
      h += '<pre class="db-tab">';
      order.forEach(function (s, r) {
        h += '<span class="db-c' + seatColor(s) + '">' + (r + 1) + '. ' + seatGlyph(s) + ' ' + pad(seatName(s), 9) + '</span><b>' + padL(g.score[s], 3) + '</b>\n';
      });
      h += '</pre>';
    }
    var notes = [];
    if (S.meta.mode === 'cpu') {
      var t = S.stats.cpu[S.meta.level];
      if (N.best) notes.push('*New best streak: ' + N.streak + ' wins in a row!');
      else if (N.result === 'win' && N.streak > 1) notes.push('Streak: ' + N.streak);
      if (N.margin) notes.push('*Biggest win yet on ' + LEVEL_NAME[S.meta.level] + ': +' + N.margin);
      notes.push(LEVEL_NAME[S.meta.level] + ' record: ' + t.w + ' won · ' + t.l + ' lost' + (t.d ? ' · ' + t.d + ' drawn' : ''));
    }
    var big = bigTurn(g, S.meta.mode === 'cpu' ? 1 - S.meta.cpu : -1), yours = S.meta.mode === 'cpu' ? 'Your biggest turn: ' : 'Biggest turn: ';
    if (N.bigTurn && big > 1) notes.unshift('*New record: ' + big + ' boxes in one turn!');
    else notes.push(yours + big + ' box' + (big === 1 ? '' : 'es'));
    h += notes.map(function (s) { var hot = s.charAt(0) === '*'; return '<div class="' + (hot ? 'db-new' : 'db-note') + '">' + esc(hot ? s.slice(1) : s) + '</div>'; }).join('');
    h += '<div class="db-btns"><button type="button" class="db-go" data-act="play">Rematch</button><button type="button" class="db-go alt" data-act="menu">Menu</button></div>' +
      '<div class="db-foot"><span></span><button type="button" class="db-lnk" data-act="board">See the board</button></div></div>';
    return h;
  }
  function showCard(kind) {
    S.card = kind;
    S.resetArm = kind === 'stats' ? S.resetArm : false;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml() : kind === 'stats' ? statsHtml() : kind === 'result' ? resultHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    if (kind) { S.ovl.scrollTop = 0; clearTimeout(S.cpuT); S.cpuT = 0; }
    renderBar(); renderStatus();
    if (!kind) scheduleCpu();
    redraw();
  }
  function closeCard() {
    if (S.card === 'stats' || (S.card === 'help' && S.cardBack === 'menu')) { S.cardBack = null; showCard('menu'); return; }
    if (!S.g || S.preview) { showCard('menu'); return; }
    showCard(null);
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.cpuT); clearTimeout(s.resT); clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    document.removeEventListener('visibilitychange', s.onVis);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    s.cv.width = 0; s.cv.height = 0;   // hand the canvas memory back now (iOS)
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
    var body = '<div class="db"><div class="db-bar"></div>' +
      '<div class="db-stage"><canvas class="db-cv" role="img"></canvas><div class="db-ovl" style="display:none"></div></div>' +
      '<div class="db-status" aria-live="polite"></div><div class="db-pad"></div><div class="db-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '✏️ Dots and Boxes', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'db-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="New game (N)" aria-label="New game">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var root = p.querySelector('.db'), mm = window.matchMedia;
    S = {
      panel: p, root: root, head: hb, bar: root.querySelector('.db-bar'), stage: root.querySelector('.db-stage'), cv: root.querySelector('.db-cv'),
      ovl: root.querySelector('.db-ovl'), status: root.querySelector('.db-status'), pad: root.querySelector('.db-pad'), live: root.querySelector('.db-live'),
      snd: new Snd(sget(SOUND_KEY) === '1'), opts: normOpts(sjson(OPTS_KEY)), stats: normStats(sjson(STATS_KEY)),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches), phone: false,
      g: null, meta: { mode: 'cpu', level: 'medium', cpu: 1 }, anim: { lines: {}, boxes: {}, parts: [], floats: [] },
      hover: -1, cursor: -1, kbd: false, hint: -1, hintT: 0, down: null, cpuT: 0, resT: 0, raf: 0, card: null, cardBack: null,
      msg: '', run: 0, lastP: -1, notes: null, resetArm: false, pal: null, L: null
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    renderPad();
    readTheme();
    syncHead();

    var saved = normGame(sjson(GAME_KEY));
    if (saved) { S.g = saved.game; S.meta = saved.meta; S.msg = 'Welcome back — your game is as you left it'; }
    layout();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (S && document.hidden && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } };
    document.addEventListener('visibilitychange', S.onVis);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      clearTimeout(S.cpuT); S.cpuT = 0; S.hover = -1;
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); renderAll(); scheduleCpu();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); render(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); render();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: menu / help / sound (the header drags the panel — these are controls)
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
      } else if (h === 'help') {
        if (S.card === 'help') closeCard();
        else { S.cardBack = S.card === 'menu' ? 'menu' : null; showCard('help'); }
      } else if (h === 'menu') {
        if (S.card === 'menu' && S.g && !S.g.over && !S.preview) showCard(null); else showCard('menu');
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout: the canvas takes
    // its touches outright; the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && !b.disabled) { noTouch(e); b.click(); }
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.cv.addEventListener('contextmenu', noTouch);

    // the board: point at a gap (hover / finger down), lift to draw
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!canAct()) return;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      var q = evPt(e);
      S.down = e.pointerId; S.kbd = false; S.hover = ptToEdge(q.x, q.y);
      redraw();
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S) return;
      if (S.down == null && e.pointerType !== 'mouse') return;
      var q = evPt(e), hv = canAct() ? ptToEdge(q.x, q.y) : -1;
      if (e.pointerType === 'mouse' && S.down == null && S.kbd && hv === S.hover) return;
      if (hv !== S.hover || S.kbd) { S.hover = hv; S.kbd = false; redraw(); }
    });
    S.cv.addEventListener('pointerup', function (e) {
      if (!S || S.down !== e.pointerId) return;
      S.down = null;
      var q = evPt(e), hit = ptToEdge(q.x, q.y);
      if (e.pointerType !== 'mouse') S.hover = -1;
      if (hit >= 0) tryPlay(hit); else redraw();
    });
    S.cv.addEventListener('pointercancel', function () { if (S) { S.down = null; S.hover = -1; redraw(); } });
    S.cv.addEventListener('pointerleave', function (e) { if (S && e.pointerType === 'mouse' && S.down == null) { S.hover = -1; redraw(); } });

    S.status.addEventListener('click', function () { if (S && S.g && S.g.over) showCard('result'); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var a = b.getAttribute('data-act');
      if (a === 'undo') undoMove();
      else if (a === 'hint') hint();
      else if (a === 'results') showCard('result');
      else if (a === 'again') startGame();
      try { if (S.coarse) b.blur(); } catch (er) {}
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var o = S.opts, a = b.getAttribute('data-act'), v;
      if ((v = b.getAttribute('data-mode'))) o.mode = v;
      else if ((v = b.getAttribute('data-size'))) o.size = +v;
      else if ((v = b.getAttribute('data-level'))) o.level = v;
      else if ((v = b.getAttribute('data-first'))) o.first = v;
      else if ((v = b.getAttribute('data-players'))) o.players = +v;
      else if (a === 'play') { startGame(); return; }
      else if (a === 'close') { closeCard(); return; }
      else if (a === 'back') { S.resetArm = false; showCard('menu'); return; }
      else if (a === 'help') { S.cardBack = 'menu'; showCard('help'); return; }
      else if (a === 'stats') { showCard('stats'); return; }
      else if (a === 'menu') { showCard('menu'); return; }
      else if (a === 'board') { showCard(null); return; }
      else if (a === 'reset') { S.resetArm = true; showCard('stats'); return; }
      else if (a === 'reset-no') { S.resetArm = false; showCard('stats'); return; }
      else if (a === 'reset-yes') {
        S.stats = newStats(); persistStats(); S.resetArm = false;
        if (Cade.showToast) Cade.showToast('Records reset', 'info', 1600);
        showCard('stats'); return;
      } else return;
      // an option chip changed: keep it, refresh the menu (keeping keyboard focus on the same chip)
      S.opts = normOpts(o); persistOpts();
      S.snd.tone(988, 0.04, 'sine', 0.025);
      var sel = ['data-mode', 'data-size', 'data-level', 'data-first', 'data-players'].filter(function (x) { return b.hasAttribute(x); })[0];
      var sv = sel && b.getAttribute(sel);
      showCard('menu');
      if (!S.g || S.preview || S.g.over) { previewBoard(); layout(); renderAll(); }
      var nb = e.detail === 0 && sel && S.ovl.querySelector('[' + sel + '="' + sv + '"]');
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
    });

    if (S.g) { renderAll(); scheduleCpu(); }
    else { previewBoard(); showCard('menu'); }
    // measure again once the panel is laid out, and redraw when the mono font has loaded
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); render(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 16px ' + S.pal.font).then(function () { if (S && S.panel === p) render(); }, function () {});
      }
    } catch (e) {}
  }
  // Behind the menu with no game yet: an empty board of the chosen size.
  function previewBoard() {
    S.meta = { mode: S.opts.mode, level: S.opts.level, cpu: S.opts.mode === 'cpu' ? 1 : -1 };
    S.g = newGame({ w: S.opts.size, h: S.opts.size, n: S.opts.mode === 'cpu' ? 2 : S.opts.players });
    S.preview = true;
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Draw lines, close boxes, chain captures — vs CPU or pass-and-play',
    icon: '✏️',
    tags: 'game,pencil,dots,boxes,2 player,cpu,pass and play,strategy,chains,paper',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
