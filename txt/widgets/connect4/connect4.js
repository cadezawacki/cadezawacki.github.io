/* Connect Four — drop discs, line up four. Play the computer (Easy / Normal /
 * Hard) or a friend on the same device.
 *
 * ENGINE: C4Core() is pure and self-contained (no outer references) so its
 * source can be shipped to a Blob-URL Web Worker — the Hard search never
 * blocks the UI thread (it falls back to the main thread if Workers are
 * unavailable). A position is two bitboards (one per player) in the classic
 * 7-bits-per-column layout (6 rows + an empty sentinel bit, so shifts can't
 * wrap between columns). 49 bits don't fit JS's 32-bit bitwise ops, so each
 * board is a PAIR of ints: lo = columns 0-3 (28 bits), hi = columns 4-6
 * (21 bits); the shift helpers carry bits across the pair.
 * Hard = negamax + alpha-beta, iterative deepening inside a ~150 ms budget, a
 * typed-array transposition table, TT-move / threat-count / center-first move
 * ordering, Pascal Pons' "non-losing moves" pruning (forced blocks, never play
 * under an enemy threat) and a threat + parity + center evaluation at the
 * horizon. Normal = a shallow search with a little noise; Easy is random-ish.
 *
 * PLAY: tap a column (press-and-slide to aim on touch), or keys 1-7,
 * ←/→ + Enter/Space. U / Ctrl+Z undo (vs the computer the pair is undone),
 * N new game, Esc closes. The game in progress is saved in Cade.store.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('connect4.css');

  // ---- pure engine ---------------------------------------------------------
  function C4Core() {
    var M28 = 0x0FFFFFFF, M21 = 0x1FFFFF;
    var WIN = 1042;                   // win with stone k on the board scores WIN - k (sooner = bigger)
    var ORDER = [3, 2, 4, 1, 5, 0, 6];
    var BOT_L = 0, BOT_H = 0, BRD_L = 0, BRD_H = 0, ODD_L = 0, ODD_H = 0, EVN_L = 0, EVN_H = 0, c, r, k;
    for (c = 0; c < 7; c++) {
      var sh = c < 4 ? c * 7 : (c - 4) * 7;
      // rows 0,2,4 are the 1st/3rd/5th rows (odd threats suit the first player).
      if (c < 4) { BOT_L |= 1 << sh; BRD_L |= 0x3F << sh; ODD_L |= 0x15 << sh; EVN_L |= 0x2A << sh; }
      else { BOT_H |= 1 << sh; BRD_H |= 0x3F << sh; ODD_H |= 0x15 << sh; EVN_H |= 0x2A << sh; }
    }
    // Cell weight = how many of the 69 possible fours pass through it.
    var WT = new Int32Array(49), DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (c = 0; c < 7; c++) for (r = 0; r < 6; r++) for (var d = 0; d < 4; d++) {
      var dc = DIRS[d][0], dr = DIRS[d][1], ec = c + 3 * dc, er = r + 3 * dr;
      if (ec < 0 || ec > 6 || er < 0 || er > 5) continue;
      for (k = 0; k < 4; k++) WT[(c + k * dc) * 7 + r + k * dr]++;
    }

    // -- pair-bitboard helpers (results in sL/sH, wL/wH: no allocation) --
    var sL = 0, sH = 0, wL = 0, wH = 0;
    function shr(L, H, s) { sL = ((L >>> s) | (H << (28 - s))) & M28; sH = H >>> s; }
    function shl(L, H, s) { sL = (L << s) & M28; sH = ((H << s) | (L >>> (28 - s))) & M21; }
    function pop(x) {
      x = x - ((x >>> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
    }
    // Four in a row anywhere on board (pL,pH)?
    function aligned(pL, pH) {
      var steps = [7, 6, 8, 1];
      for (var i = 0; i < 4; i++) {
        var s = steps[i], mL, mH;
        shr(pL, pH, s); mL = pL & sL; mH = pH & sH;
        shr(mL, mH, 2 * s);
        if ((mL & sL) | (mH & sH)) return true;
      }
      return false;
    }
    // Empty cells that would complete a four for board p (mask = all stones).
    function winPos(pL, pH, mL, mH) {
      var rL, rH, aL, aH;
      shl(pL, pH, 1); rL = sL; rH = sH;
      shl(pL, pH, 2); rL &= sL; rH &= sH;
      shl(pL, pH, 3); rL &= sL; rH &= sH;
      for (var i = 6; i <= 8; i++) {
        shl(pL, pH, i); aL = sL; aH = sH;
        shl(pL, pH, 2 * i); aL &= sL; aH &= sH;
        shl(pL, pH, 3 * i); rL |= aL & sL; rH |= aH & sH;
        shr(pL, pH, i); rL |= aL & sL; rH |= aH & sH;
        shr(pL, pH, i); aL = sL; aH = sH;
        shr(pL, pH, 2 * i); aL &= sL; aH &= sH;
        shl(pL, pH, i); rL |= aL & sL; rH |= aH & sH;
        shr(pL, pH, 3 * i); rL |= aL & sL; rH |= aH & sH;
      }
      wL = rL & (BRD_L ^ mL); wH = rH & (BRD_H ^ mH);
    }

    // -- position --
    var bL = new Int32Array(2), bH = new Int32Array(2), hgt = new Int32Array(7), psum = new Int32Array(2), n = 0;
    function reset() { bL[0] = bL[1] = bH[0] = bH[1] = psum[0] = psum[1] = 0; n = 0; for (var i = 0; i < 7; i++) hgt[i] = i * 7; }
    function canPlay(col) { return col >= 0 && col < 7 && hgt[col] < col * 7 + 6; }
    function play(col) {
      var b = hgt[col], p = n & 1;
      if (b < 28) bL[p] |= 1 << b; else bH[p] |= 1 << (b - 28);
      psum[p] += WT[b]; hgt[col] = b + 1; n++;
    }
    function unplay(col) {
      var b = --hgt[col]; n--;
      var p = n & 1;
      if (b < 28) bL[p] &= ~(1 << b); else bH[p] &= ~(1 << (b - 28));
      psum[p] -= WT[b];
    }
    function load(moves) {
      reset();
      for (var i = 0; i < moves.length; i++) { var m = +moves[i]; if (!canPlay(m)) return false; play(m); }
      return true;
    }
    // Would the side to move win by playing col?
    function winsAt(col) {
      if (!canPlay(col)) return false;
      play(col);
      var p = (n - 1) & 1, w = aligned(bL[p], bH[p]);
      unplay(col);
      return w;
    }
    function lastMoverWon() { var p = (n - 1) & 1; return n > 0 && aligned(bL[p], bH[p]); }

    // -- transposition table (allocated on first deep search only) --
    var TT_BITS = 19, TT_SHIFT = 32 - TT_BITS, ttA = null, ttB, ttV, ttD, ttF, ttM;
    function ttInit() {
      if (ttA) return;
      var N = 1 << TT_BITS;
      ttA = new Int32Array(N); ttB = new Int32Array(N); ttV = new Int16Array(N);
      ttD = new Int8Array(N); ttF = new Int8Array(N); ttM = new Int8Array(N);
    }
    var EXACT = 1, LOWER = 2, UPPER = 3;

    var MV = new Int8Array(44 * 7), MS = new Int32Array(44 * 7); // per-ply move lists
    var nodes = 0, deadline = 0, stopped = false, useTT = false;
    var clock = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };

    function evaluate(p, myL, myH, opL, opH) {
      var o = p ^ 1, s = psum[p] - psum[o];
      s += 8 * (pop(myL) + pop(myH) - pop(opL) - pop(opH));
      var mOL = p === 0 ? ODD_L : EVN_L, mOH = p === 0 ? ODD_H : EVN_H;
      var tOL = o === 0 ? ODD_L : EVN_L, tOH = o === 0 ? ODD_H : EVN_H;
      s += 4 * (pop(myL & mOL) + pop(myH & mOH) - pop(opL & tOL) - pop(opH & tOH));
      return s > 900 ? 900 : s < -900 ? -900 : s;
    }

    // Negamax from the side to move; assumes the previous move did not win.
    function negamax(alpha, beta, depth) {
      if ((++nodes & 1023) === 0 && clock() > deadline) stopped = true;
      if (stopped) return 0;
      var p = n & 1, o = p ^ 1;
      var mL = bL[0] | bL[1], mH = bH[0] | bH[1];
      var posL = (mL + BOT_L) & BRD_L, posH = (mH + BOT_H) & BRD_H;
      winPos(bL[p], bH[p], mL, mH);
      if ((wL & posL) | (wH & posH)) return WIN - n - 1;
      var myL = wL, myH = wH;
      winPos(bL[o], bH[o], mL, mH);
      var opL = wL, opH = wH, fL = posL & opL, fH = posH & opH;
      if (fL | fH) {
        if (pop(fL) + pop(fH) > 1) return -(WIN - n - 2);   // two threats to block: lost
        posL = fL; posH = fH;
      }
      posL &= ~(opL >>> 1); posH &= ~(opH >>> 1);            // never play right under an enemy threat
      if (!(posL | posH)) return -(WIN - n - 2);
      if (n >= 40) return 0;
      var max = WIN - n - 3;
      if (beta > max) { beta = max; if (alpha >= beta) return beta; }
      var min = -(WIN - n - 4);
      if (alpha < min) { alpha = min; if (alpha >= beta) return alpha; }
      if (depth <= 0) return evaluate(p, myL, myH, opL, opH);

      var a0 = alpha, ttMove = -1, h = 0, kA = 0, kB = 0;
      if (useTT) {
        kA = bL[p] + mL; kB = bH[p] + mH;             // current + mask: a unique position key
        h = (Math.imul(kA, 0x9E3779B1) ^ Math.imul(kB + 0x7F4A7C15, 0x85EBCA6B)) >>> TT_SHIFT;
        if (ttF[h] && ttA[h] === kA && ttB[h] === kB) {
          var tv = ttV[h], tf = ttF[h];
          ttMove = ttM[h];
          if (ttD[h] >= depth || (tf !== UPPER && tv >= 1000) || (tf !== LOWER && tv <= -1000)) {
            if (tf === EXACT) return tv;
            if (tf === LOWER && tv > alpha) alpha = tv;
            else if (tf === UPPER && tv < beta) beta = tv;
            if (alpha >= beta) return tv;
          }
        }
      }
      // Order: TT move, then most threats created, center-first on ties.
      var base = n * 7, cnt = 0, i, j;
      for (i = 0; i < 7; i++) {
        var col = ORDER[i], b = hgt[col];
        if (b >= col * 7 + 6) continue;
        if (b < 28 ? !(posL & (1 << b)) : !(posH & (1 << (b - 28)))) continue;
        var nL = bL[p], nH = bH[p];
        if (b < 28) nL |= 1 << b; else nH |= 1 << (b - 28);
        var nmL = mL, nmH = mH;
        if (b < 28) nmL |= 1 << b; else nmH |= 1 << (b - 28);
        winPos(nL, nH, nmL, nmH);
        var sc = (pop(wL) + pop(wH)) * 16 + (7 - i);
        if (col === ttMove) sc += 10000;
        for (j = cnt; j > 0 && MS[base + j - 1] < sc; j--) { MS[base + j] = MS[base + j - 1]; MV[base + j] = MV[base + j - 1]; }
        MS[base + j] = sc; MV[base + j] = col; cnt++;
      }
      var best = -100000, bestMove = MV[base];
      for (i = 0; i < cnt; i++) {
        var m = MV[base + i];
        play(m);
        var v = -negamax(-beta, -alpha, depth - 1);
        unplay(m);
        if (stopped) return 0;
        if (v > best) { best = v; bestMove = m; }
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      if (useTT) {
        ttA[h] = kA; ttB[h] = kB; ttV[h] = best; ttD[h] = depth > 127 ? 127 : depth; ttM[h] = bestMove;
        ttF[h] = best <= a0 ? UPPER : best >= beta ? LOWER : EXACT;
      }
      return best;
    }

    function legalMoves() { var out = []; for (var i = 0; i < 7; i++) if (canPlay(ORDER[i])) out.push(ORDER[i]); return out; }
    function threatCol(side) {     // a column where `side` could complete four right now
      var mL = bL[0] | bL[1], mH = bH[0] | bH[1];
      winPos(bL[side], bH[side], mL, mH);
      for (var i = 0; i < 7; i++) {
        var col = ORDER[i], b = hgt[col];
        if (b >= col * 7 + 6) continue;
        if (b < 28 ? (wL & (1 << b)) : (wH & (1 << (b - 28)))) return col;
      }
      return -1;
    }
    // Score every root move (full window when `all`, for Normal's noise).
    function root(depth, order, all) {
      var alpha = -100000, beta = 100000, best = -100000, bestCol = order[0], scores = {};
      for (var i = 0; i < order.length; i++) {
        var col = order[i];
        play(col);
        var v = -negamax(all ? -100000 : -beta, all ? 100000 : -alpha, depth - 1);
        unplay(col);
        if (stopped) return null;
        scores[col] = v;
        if (v > best) { best = v; bestCol = col; }
        if (!all && v > alpha) alpha = v;
      }
      return { col: bestCol, score: best, scores: scores };
    }

    // level: 'easy' | 'normal' | 'hard'. Returns { col, score, depth, nodes }.
    function search(moves, level, budgetMs, rnd) {
      rnd = rnd || Math.random;
      if (!load(moves || [])) return { col: -1, score: 0, depth: 0, nodes: 0 };
      var legal = legalMoves(), me = n & 1;
      nodes = 0; stopped = false;
      if (!legal.length) return { col: -1, score: 0, depth: 0, nodes: 0 };
      var win = threatCol(me), block = threatCol(me ^ 1);
      if (level === 'easy') {
        if (win >= 0 && rnd() < 0.75) return { col: win, score: 0, depth: 1, nodes: 0 };
        if (block >= 0 && rnd() < 0.55) return { col: block, score: 0, depth: 1, nodes: 0 };
        var wsum = 0, wts = [1, 2, 3, 4, 3, 2, 1], x;
        for (x = 0; x < legal.length; x++) wsum += wts[legal[x]];
        var pick = rnd() * wsum;
        for (x = 0; x < legal.length; x++) { pick -= wts[legal[x]]; if (pick < 0) return { col: legal[x], score: 0, depth: 0, nodes: 0 }; }
        return { col: legal[legal.length - 1], score: 0, depth: 0, nodes: 0 };
      }
      if (win >= 0) return { col: win, score: WIN - n - 1, depth: 1, nodes: 1 };
      if (block >= 0) return { col: block, score: 0, depth: 1, nodes: 1 };
      if (n === 0) return { col: 3, score: 0, depth: 0, nodes: 0 };       // the book move
      if (level === 'normal') {
        useTT = false; deadline = clock() + 2000;
        var res = root(5, legal, true);
        if (!res) return { col: legal[0], score: 0, depth: 0, nodes: nodes };
        // Pick among near-best moves so Normal isn't one fixed line; never a proven loss.
        var ok = [];
        for (x = 0; x < legal.length; x++) {
          var sv = res.scores[legal[x]];
          if (res.score >= 1000 ? sv === res.score : sv >= res.score - 14 && sv > -1000) ok.push(legal[x]);
        }
        return { col: ok.length ? ok[(rnd() * ok.length) | 0] : res.col, score: res.score, depth: 5, nodes: nodes };
      }
      ttInit(); useTT = true;
      deadline = clock() + (budgetMs || 150);
      var order = legal.slice(), best = { col: order[0], score: 0 }, reached = 0;
      for (var dpt = 1; dpt <= 42 - n; dpt++) {
        var rr = root(dpt, order, false);
        if (!rr) break;
        best = rr; reached = dpt;
        order = [rr.col].concat(order.filter(function (q) { return q !== rr.col; }));
        if (rr.score >= 1000 || rr.score <= -1000) break;               // proven: deeper can't change it
      }
      useTT = false;
      return { col: best.col, score: best.score, depth: reached, nodes: nodes };
    }

    return {
      search: search, load: load, play: play, unplay: unplay, canPlay: canPlay, winsAt: winsAt,
      lastMoverWon: lastMoverWon, threatCol: function (s) { return threatCol(s); }, sideToMove: function () { return n & 1; },
      aligned: aligned, WIN: WIN
    };
  }

  // ---- widget state ---------------------------------------------------------
  var PANEL_ID = 'connect4-panel';
  var C4_ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='2.5' y='4' width='19' height='16' rx='2.5'/><circle cx='7.5' cy='9' r='1.6'/><circle cx='12' cy='9' r='1.6'/><circle cx='16.5' cy='9' r='1.6' fill='currentColor'/><circle cx='7.5' cy='15' r='1.6' fill='currentColor'/><circle cx='12' cy='15' r='1.6' fill='currentColor'/><circle cx='16.5' cy='15' r='1.6'/></svg>";
  var SAVE_KEY = 'cade-connect4-save', STATS_KEY = 'cade-connect4-stats', PREFS_KEY = 'cade-connect4-prefs';
  var LEVELS = ['easy', 'normal', 'hard'];
  var LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  var HARD_BUDGET = 150;          // ms of search per Hard move
  var MIN_THINK = 420;            // the computer never answers faster than this (feels less abrupt)

  var core = null;                // main-thread C4Core (fallback engine + win checks)
  var game = null;                // { mode, level, first, moves[], over, winner, rec }
  var stats = {}, prefs = { mode: 'ai', level: 'normal', starts: 'me' };
  var ui = null, aim = 3, think = null, reqId = 0, host = null;

  // ---- helpers ------------------------------------------------------------------
  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function reduced() { return false; }
  function toast(msg, type) { try { Cade.showToast(msg, type || 'info', 2200); } catch (e) {} }
  function haptic(ms) { try { Cade.haptic(ms); } catch (e) {} }

  // Board from the move list: cells[c][r] = 0 red / 1 yellow / -1 empty (r=0 is the bottom).
  function board(moves, first) {
    var cells = [], h = [0, 0, 0, 0, 0, 0, 0];
    for (var c = 0; c < 7; c++) cells.push([-1, -1, -1, -1, -1, -1]);
    for (var i = 0; i < moves.length; i++) { var m = moves[i]; cells[m][h[m]++] = (first + i) & 1; }
    return { cells: cells, h: h };
  }
  // Every cell of any line of 4+ through (c, r).
  function lineAt(cells, c, r) {
    var who = cells[c][r], out = [], dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    if (who < 0) return out;
    for (var d = 0; d < 4; d++) {
      var run = [[c, r]], k, x, y;
      for (k = 1; k < 4; k++) { x = c + dirs[d][0] * k; y = r + dirs[d][1] * k; if (x < 0 || x > 6 || y < 0 || y > 5 || cells[x][y] !== who) break; run.push([x, y]); }
      for (k = 1; k < 4; k++) { x = c - dirs[d][0] * k; y = r - dirs[d][1] * k; if (x < 0 || x > 6 || y < 0 || y > 5 || cells[x][y] !== who) break; run.push([x, y]); }
      if (run.length >= 4) out = out.concat(run);
    }
    return out;
  }
  function turnColor() { return game ? (game.first + game.moves.length) & 1 : 0; }
  function aiTurn() { return !!(game && game.mode === 'ai' && !game.over && turnColor() === 1); }
  function humanMoves() {
    var k = 0;
    for (var i = 0; i < game.moves.length; i++) if (((game.first + i) & 1) === 0) k++;
    return k;
  }

  // ---- persistence -------------------------------------------------------------------
  function loadState() {
    var p = readJSON(PREFS_KEY, {});
    if (p && typeof p === 'object') {
      if (p.mode === 'ai' || p.mode === 'pvp') prefs.mode = p.mode;
      if (LEVELS.indexOf(p.level) !== -1) prefs.level = p.level;
      if (p.starts === 'me' || p.starts === 'them' || p.starts === 'alt') prefs.starts = p.starts;
    }
    stats = readJSON(STATS_KEY, {});
    if (!stats || typeof stats !== 'object') stats = {};
    var s = readJSON(SAVE_KEY, null);
    game = null;
    if (s && typeof s === 'object' && (s.mode === 'ai' || s.mode === 'pvp') && /^[0-6]{0,42}$/.test(String(s.moves || ''))) {
      var g = {
        mode: s.mode, level: LEVELS.indexOf(s.level) !== -1 ? s.level : 'normal', first: s.first ? 1 : 0,
        moves: String(s.moves || '').split('').filter(Boolean).map(Number), over: 0, winner: -1, rec: s.rec ? 1 : 0
      };
      if (core.load(g.moves)) { game = g; evalEnd(false); }
    }
  }
  function persist() {
    if (!game) return;
    writeJSON(SAVE_KEY, { mode: game.mode, level: game.level, first: game.first, moves: game.moves.join(''), rec: game.rec });
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function saveStats() { writeJSON(STATS_KEY, stats); }
  function statKey() { return game && game.mode === 'pvp' ? 'pvp' : (game ? game.level : prefs.level); }

  // ---- engine host: a Blob-URL Worker if possible, else the main thread ---------------
  function makeHost() {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && window.URL && URL.createObjectURL) {
      var url = null;
      try {
        var src = 'var core=(' + C4Core.toString() + ')();self.onmessage=function(e){var d=e.data,r=core.search(d.moves,d.level,d.budget);' +
          'self.postMessage({id:d.id,col:r.col,score:r.score,depth:r.depth,nodes:r.nodes});};';
        url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        var w = new Worker(url);
        URL.revokeObjectURL(url);
        var h = {
          worker: w,
          post: function (m) { w.postMessage(m); },
          kill: function () { try { w.terminate(); } catch (e) {} }
        };
        w.onmessage = function (e) { onAiResult(e.data); };
        w.onerror = function (e) {
          if (e && e.preventDefault) e.preventDefault();
          // A blocked/crashed worker: switch to the main thread and re-ask.
          if (host === h) { h.kill(); host = mainHost(); if (think) askAi(); }
        };
        return h;
      } catch (err) { if (url) try { URL.revokeObjectURL(url); } catch (e2) {} }
    }
    return mainHost();
  }
  function mainHost() {
    var eng = C4Core(), timer = 0;
    return {
      post: function (m) {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var r = eng.search(m.moves, m.level, Math.min(m.budget, 120));
          onAiResult({ id: m.id, col: r.col, score: r.score, depth: r.depth, nodes: r.nodes });
        }, 30);
      },
      kill: function () { clearTimeout(timer); }
    };
  }

  // ---- game flow ----------------------------------------------------------------------
  function newGame(keepFirst) {
    cancelThink();
    var first;
    if (keepFirst && game) first = game.first;
    else if (prefs.starts === 'me') first = 0;
    else if (prefs.starts === 'them') first = 1;
    else first = game ? 1 - game.first : 0;
    game = { mode: prefs.mode, level: prefs.level, first: first, moves: [], over: 0, winner: -1, rec: 0 };
    persist();
    hideOverlay();
    paintDiscs();
    render();
    if (aiTurn()) askAi();
  }

  // Sets game.over / winner (and records the result once when `record`).
  function evalEnd(record) {
    var g = game;
    g.over = 0; g.winner = -1; g.line = null;
    if (!g.moves.length) return;
    var b = board(g.moves, g.first), last = g.moves[g.moves.length - 1];
    var line = lineAt(b.cells, last, b.h[last] - 1);
    if (line.length) { g.over = 1; g.winner = b.cells[last][b.h[last] - 1]; g.line = line; }
    else if (g.moves.length >= 42) { g.over = 1; g.winner = 2; }
    if (g.over && record && !g.rec) {
      g.rec = 1;
      var key = g.mode === 'pvp' ? 'pvp' : g.level, st = stats[key] = stats[key] || {};
      if (g.mode === 'pvp') {
        if (g.winner === 0) st.r = (st.r || 0) + 1; else if (g.winner === 1) st.y = (st.y || 0) + 1; else st.d = (st.d || 0) + 1;
      } else {
        if (g.winner === 0) { st.w = (st.w || 0) + 1; st.cs = (st.cs || 0) + 1; st.bs = Math.max(st.bs || 0, st.cs); }
        else if (g.winner === 1) { st.l = (st.l || 0) + 1; st.cs = 0; }
        else st.d = (st.d || 0) + 1;
      }
      saveStats();
    }
  }

  function drop(col, byAi) {
    if (!game || game.over || !ui) return false;
    if (!byAi && (aiTurn() || think)) return false;
    var b = board(game.moves, game.first);
    if (col < 0 || col > 6 || b.h[col] >= 6) { if (!byAi) shakeCol(col); return false; }
    var row = b.h[col], color = turnColor();
    game.moves.push(col);
    evalEnd(true);
    persist();
    addDisc(col, row, color, true);
    haptic(byAi ? 6 : 10);
    if (game.over) {
      var delay = reduced() ? 0 : 420;
      setTimeout(function () { if (ui) paintWin(); }, delay);
      if (game.winner === 0 && game.mode === 'ai') haptic(30);
    }
    render();
    if (aiTurn()) askAi();
    return true;
  }

  function askAi() {
    if (!ui || !aiTurn()) return;
    if (!host) host = makeHost();
    var id = ++reqId;
    think = { id: id, t0: now() };
    host.post({ id: id, moves: game.moves.slice(), level: game.level, budget: HARD_BUDGET });
    render();
  }
  function onAiResult(m) {
    if (!think || !m || m.id !== think.id || !ui) return;
    var id = m.id, wait = Math.max(0, MIN_THINK - (now() - think.t0));
    think.timer = setTimeout(function () {
      if (!think || think.id !== id) return;
      think = null;
      var col = m.col;
      var b = board(game.moves, game.first);
      if (col < 0 || col > 6 || b.h[col] >= 6) {         // defensive: any legal column
        col = -1;
        for (var c = 0; c < 7; c++) if (b.h[[3, 2, 4, 1, 5, 0, 6][c]] < 6) { col = [3, 2, 4, 1, 5, 0, 6][c]; break; }
        if (col < 0) return;
      }
      drop(col, true);
    }, wait);
  }
  function cancelThink() {
    if (think && think.timer) clearTimeout(think.timer);
    think = null;
    reqId++;
  }

  function undo() {
    if (!game || !game.moves.length || !ui) return;
    if (game.mode === 'ai') {
      if (!humanMoves()) return;                    // nothing of yours to take back
      cancelThink();
      // Take back the computer's reply too, so it's your turn again.
      do { game.moves.pop(); } while (game.moves.length && turnColor() !== 0);
    } else {
      game.moves.pop();
    }
    evalEnd(false);
    persist();
    paintDiscs();
    render();
    if (aiTurn()) askAi();
  }

  // ---- rendering ------------------------------------------------------------------------
  function discEl(col, row, color) {
    var el = document.createElement('div');
    el.className = 'c4-d c4-p' + color;
    el.style.left = (col * 100 / 7) + '%';
    el.style.top = ((5 - row) * 100 / 6) + '%';
    el.setAttribute('data-c', col); el.setAttribute('data-r', row);
    return el;
  }
  function addDisc(col, row, color, animate) {
    var el = discEl(col, row, color);
    ui.discs.appendChild(el);
    if (!animate || reduced() || !el.animate) return;
    var fall = 6 - row;                          // cells from the preview row down to the slot
    var frames = [
      { transform: 'translateY(' + (-fall * 100) + '%)', easing: 'cubic-bezier(.55,0,1,.45)' },
      { transform: 'translateY(0)', offset: 0.68, easing: 'ease-out' }
    ];
    if (fall > 1) frames.push({ transform: 'translateY(' + (-Math.min(22, 6 + fall * 3)) + '%)', offset: 0.84, easing: 'ease-in' });
    frames.push({ transform: 'translateY(0)' });
    try { el.animate(frames, { duration: 170 + fall * 60 }); } catch (e) {}
  }
  function paintDiscs() {
    if (!ui) return;
    ui.discs.innerHTML = '';
    ui.discs.classList.remove('c4-done');
    if (!game) return;
    var b = board([], 0), first = game.first;
    for (var i = 0; i < game.moves.length; i++) {
      var m = game.moves[i];
      addDisc(m, b.h[m]++, (first + i) & 1, false);
    }
    if (game.over) paintWin();
  }
  function paintWin() {
    if (!ui || !game || !game.over) return;
    if (game.line) {
      ui.discs.classList.add('c4-done');
      var on = {};
      game.line.forEach(function (p) { on[p[0] + ',' + p[1]] = 1; });
      Array.prototype.forEach.call(ui.discs.children, function (el) {
        if (on[el.getAttribute('data-c') + ',' + el.getAttribute('data-r')]) el.classList.add('c4-win');
      });
    }
  }
  function shakeCol(col) {
    if (!ui || col < 0 || col > 6) return;
    var el = ui.cols[col];
    el.classList.remove('c4-shake'); void el.offsetWidth; el.classList.add('c4-shake');
  }

  function who(color) {
    if (!game || game.mode === 'pvp') return color === 0 ? 'Red' : 'Yellow';
    return color === 0 ? 'You' : 'Computer';
  }
  function render() {
    if (!ui) return;
    var g = game, mode = g ? g.mode : prefs.mode, lvl = g ? g.level : prefs.level;
    ui.root.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
    ui.root.querySelectorAll('[data-level]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-level') === lvl); });
    ui.levels.style.visibility = mode === 'ai' ? '' : 'hidden';
    // status
    var st = '', dot = -1, cls = '';
    if (!g) st = '';
    else if (g.over) {
      if (g.winner === 2) { st = 'Draw — the board is full'; cls = 'draw'; }
      else if (g.mode === 'ai') { st = g.winner === 0 ? 'You win! 🎉' : 'The computer wins'; dot = g.winner; cls = g.winner === 0 ? 'good' : 'bad'; }
      else { st = who(g.winner) + ' wins! 🎉'; dot = g.winner; cls = 'good'; }
    } else if (think) { st = 'Thinking'; dot = 1; cls = 'think'; }
    else {
      var t = turnColor();
      dot = t;
      st = g.mode === 'ai' ? (t === 0 ? 'Your turn' : 'Computer’s turn') : who(t) + '’s turn';
    }
    ui.status.className = 'c4-status ' + cls;
    ui.statusTxt.textContent = st;
    ui.statusDot.className = 'c4-dot' + (dot >= 0 ? ' c4-p' + dot : ' none');
    // tally (persistent, per difficulty / for 2 players)
    var s = stats[mode === 'pvp' ? 'pvp' : lvl] || {};
    ui.tally.innerHTML = mode === 'pvp'
      ? '<span class="c4-dot c4-p0"></span>Red <b>' + (s.r || 0) + '</b><span class="c4-sep">·</span><span class="c4-dot c4-p1"></span>Yellow <b>' + (s.y || 0) + '</b><span class="c4-sep">·</span>Draws <b>' + (s.d || 0) + '</b>'
      : 'You <b>' + (s.w || 0) + '</b><span class="c4-sep">·</span>Computer <b>' + (s.l || 0) + '</b><span class="c4-sep">·</span>Draws <b>' + (s.d || 0) + '</b>' +
        (s.cs > 1 ? '<span class="c4-sep">·</span>🔥 ' + s.cs : '');
    var sl = { me: mode === 'pvp' ? 'Red starts' : 'You start', them: mode === 'pvp' ? 'Yellow starts' : 'AI starts', alt: 'Alternate' }[prefs.starts];
    ui.startsLbl.textContent = sl;
    ui.undoBtn.disabled = !g || !g.moves.length || (g.mode === 'ai' && !humanMoves());
    // ghost / column highlight
    var canAim = !!(g && !g.over && !think && !aiTurn());
    ui.ghost.className = 'c4-ghost c4-p' + turnColor() + (canAim && ui.showAim ? ' show' : '');
    ui.ghost.style.left = (aim * 100 / 7) + '%';
    for (var c = 0; c < 7; c++) ui.cols[c].classList.toggle('hot', canAim && ui.showAim && c === aim);
    ui.root.classList.toggle('c4-over', !!(g && g.over));
    ui.newBtn.classList.toggle('c4-cta', !!(g && g.over));
  }

  // ---- overlays -------------------------------------------------------------------------
  function showOverlay(html) {
    if (!ui) return;
    ui.ovOpen = true;
    ui.ov.innerHTML = html;
    ui.ov.className = 'c4-ov show';
  }
  function hideOverlay() {
    if (!ui) return;
    ui.ovOpen = false;
    ui.ov.className = 'c4-ov';
    ui.ov.innerHTML = '';
  }
  function statsMenu() {
    var rows = '';
    LEVELS.forEach(function (l) {
      var s = stats[l] || {}, tot = (s.w || 0) + (s.l || 0) + (s.d || 0);
      rows += '<tr><td>' + LABEL[l] + '</td><td>' + (s.w || 0) + '</td><td>' + (s.l || 0) + '</td><td>' + (s.d || 0) +
        '</td><td>' + (tot ? Math.round(100 * (s.w || 0) / tot) + '%' : '—') + '</td><td>' + (s.bs || 0) + '</td></tr>';
    });
    var p = stats.pvp || {};
    showOverlay('<div class="c4-card"><b class="c4-title">Statistics</b>' +
      '<table class="c4-stats"><thead><tr><th></th><th>Won</th><th>Lost</th><th>Drawn</th><th>Win %</th><th>Best streak</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="c4-sub">Two players: Red ' + (p.r || 0) + ' · Yellow ' + (p.y || 0) + ' · Draws ' + (p.d || 0) + '</div>' +
      '<div class="c4-hint">Keys: 1–7 drop · ←/→ aim · Enter/Space drop · U undo · N new game · Esc close</div>' +
      '<div class="c4-acts"><button data-act="resetstats">Reset</button><button class="c4-primary" data-act="hide">Close</button></div></div>');
  }
  function confirmSwitch(apply) {
    // Switching mode/difficulty mid-game abandons the game in progress.
    if (game && game.moves.length && !game.over && !window.confirm('Abandon the game in progress?')) return;
    apply();
    savePrefs();
    newGame(false);
  }

  // ---- panel ----------------------------------------------------------------------------
  function buildHtml() {
    var holes = '';
    for (var c = 0; c < 7; c++) for (var r = 0; r < 6; r++) {
      var cx = 50 + c * 100, cy = 50 + r * 100;
      holes += 'M' + (cx - 38) + ' ' + cy + 'a38 38 0 1 0 76 0a38 38 0 1 0 -76 0Z';
    }
    var cols = '';
    for (c = 0; c < 7; c++) cols += '<div class="c4-col" data-col="' + c + '"></div>';
    return '<div class="c4" tabindex="-1">' +
      '<div class="c4-top">' +
        '<div class="c4-seg"><button data-mode="ai">vs Computer</button><button data-mode="pvp">2 Players</button></div>' +
        '<div class="c4-seg c4-levels"><button data-level="easy">Easy</button><button data-level="normal">Normal</button><button data-level="hard">Hard</button></div>' +
      '</div>' +
      '<div class="c4-status"><span class="c4-dot"></span><span class="c4-st"></span></div>' +
      '<div class="c4-wrap"><div class="c4-stage">' +
        '<div class="c4-ghost"></div>' +
        '<div class="c4-discs"></div>' +
        '<svg class="c4-board" viewBox="0 0 700 600" preserveAspectRatio="none" aria-hidden="true"><path fill-rule="evenodd" d="M24 0H676A24 24 0 0 1 700 24V576A24 24 0 0 1 676 600H24A24 24 0 0 1 0 576V24A24 24 0 0 1 24 0Z' + holes + '"/></svg>' +
        '<div class="c4-cols">' + cols + '</div>' +
      '</div><div class="c4-ov"></div></div>' +
      '<div class="c4-tally"></div>' +
      '<div class="c4-tools">' +
        '<button data-act="undo" title="Undo (U)"><span class="c4-ti">↶</span><span class="c4-tl">Undo</span></button>' +
        '<button data-act="starts" title="Who starts the next game"><span class="c4-ti">⇄</span><span class="c4-tl c4-starts"></span></button>' +
        '<button data-act="new" title="New game (N)"><span class="c4-ti">↻</span><span class="c4-tl">New game</span></button>' +
        '<button data-act="stats" title="Statistics"><span class="c4-ti">📊</span><span class="c4-tl">Stats</span></button>' +
      '</div></div>';
  }

  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function teardown() {
    if (!ui) return;
    cancelThink();
    persist();
    if (host) { host.kill(); host = null; }
    document.removeEventListener('keydown', ui.onKey, true);
    document.removeEventListener('visibilitychange', ui.onVis);
    window.removeEventListener('pagehide', ui.onHide);
    ui = null;
  }

  function colFromX(clientX) {
    var r = ui.stage.getBoundingClientRect();
    if (!r.width) return aim;
    return Math.max(0, Math.min(6, Math.floor((clientX - r.left) / (r.width / 7))));
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    core = core || C4Core();
    loadState();
    var p = Cade.mkPanel(PANEL_ID, '● Connect Four', buildHtml());
    try { Cade.markGamePanel(p); } catch (e) {}
    var root = p.querySelector('.c4');
    ui = {
      panel: p, root: root, stage: root.querySelector('.c4-stage'), discs: root.querySelector('.c4-discs'),
      ghost: root.querySelector('.c4-ghost'), ov: root.querySelector('.c4-ov'), status: root.querySelector('.c4-status'),
      statusTxt: root.querySelector('.c4-st'), statusDot: root.querySelector('.c4-status .c4-dot'),
      tally: root.querySelector('.c4-tally'), levels: root.querySelector('.c4-levels'),
      startsLbl: root.querySelector('.c4-starts'), undoBtn: root.querySelector('[data-act="undo"]'),
      newBtn: root.querySelector('.c4-tools [data-act="new"]'),
      cols: [], showAim: false, ovOpen: false, press: null
    };
    root.querySelectorAll('.c4-col').forEach(function (el) { ui.cols[+el.getAttribute('data-col')] = el; });
    p._onClose = teardown;

    ui.onKey = onKey;
    ui.onVis = function () { if (document.hidden) persist(); };
    ui.onHide = function () { persist(); };
    document.addEventListener('keydown', ui.onKey, true);
    document.addEventListener('visibilitychange', ui.onVis);
    window.addEventListener('pagehide', ui.onHide);

    // Aim + drop: hover shows the disc over a column (mouse); on touch, press
    // to preview, slide to re-aim, release to drop.
    var stage = ui.stage;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || ui.ovOpen) return;
      e.preventDefault();
      try { root.focus({ preventScroll: true }); } catch (x) {}
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      aim = colFromX(e.clientX);
      ui.press = { id: e.pointerId, y0: e.clientY };
      ui.showAim = true;
      render();
    });
    stage.addEventListener('pointermove', function (e) {
      if (ui.ovOpen) return;
      if (e.pointerType === 'mouse' || ui.press) {
        var c = colFromX(e.clientX);
        if (c !== aim || !ui.showAim) { aim = c; ui.showAim = true; render(); }
      }
    });
    function release(e, cancel) {
      if (!ui.press || ui.press.id !== e.pointerId) return;
      ui.press = null;
      var r = stage.getBoundingClientRect();
      // Sliding well off the board cancels the drop.
      var off = e.clientY < r.top - 40 || e.clientY > r.bottom + 40 || e.clientX < r.left - 30 || e.clientX > r.right + 30;
      if (e.pointerType !== 'mouse') ui.showAim = false;
      if (!cancel && !off) drop(colFromX(e.clientX), false);
      render();
    }
    stage.addEventListener('pointerup', function (e) { release(e, false); });
    stage.addEventListener('pointercancel', function (e) { release(e, true); });
    stage.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !ui.press) { ui.showAim = false; render(); } });

    root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      if (ui.ov.contains(b)) {
        var a0 = b.getAttribute('data-act');
        if (a0 === 'hide') hideOverlay();
        else if (a0 === 'resetstats') { if (window.confirm('Reset all Connect Four statistics?')) { stats = {}; saveStats(); statsMenu(); render(); } }
        return;
      }
      var mode = b.getAttribute('data-mode'), lvl = b.getAttribute('data-level'), act = b.getAttribute('data-act');
      if (mode && mode !== (game ? game.mode : prefs.mode)) confirmSwitch(function () { prefs.mode = mode; });
      else if (lvl && (lvl !== (game ? game.level : prefs.level) || (game && game.mode !== 'ai'))) confirmSwitch(function () { prefs.level = lvl; prefs.mode = 'ai'; });
      else if (act === 'undo') undo();
      else if (act === 'new') {
        if (game && game.moves.length && !game.over && !window.confirm('Start a new game?')) return;
        newGame(false);
      } else if (act === 'stats') statsMenu();
      else if (act === 'starts') {
        prefs.starts = { me: 'them', them: 'alt', alt: 'me' }[prefs.starts];
        savePrefs();
        // Nothing played yet: apply right away, otherwise from the next game.
        if (game && !game.moves.length) newGame(false);
        else if (game && !game.over) toast('Applies from the next game');
        render();
      }
    });

    try { root.focus({ preventScroll: true }); } catch (e) {}
    if (!game) newGame(false);
    else {
      prefs.mode = game.mode; prefs.level = game.level;
      paintDiscs(); render();
      if (aiTurn()) askAi();
    }
  }

  function onKey(e) {
    if (!ui) return;
    if (Cade.isMinimized && Cade.isMinimized(ui.panel)) return; // parked in the dock: keys belong to the editor
    var ae = document.activeElement;
    if (ae && ae !== document.body && !ui.panel.contains(ae) && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey, handled = true;
    if (k === 'Escape') { if (ui.ovOpen) hideOverlay(); else close(); }
    else if (mod && !e.altKey && (k === 'z' || k === 'Z')) undo();
    else if (mod || e.altKey) handled = false;
    else if (ui.ovOpen) { if (k === 'Enter' || k === ' ') hideOverlay(); else handled = false; }
    else if (/^[1-7]$/.test(k)) { aim = +k - 1; drop(aim, false); }
    else if (k === 'ArrowLeft') { aim = Math.max(0, aim - 1); ui.showAim = true; render(); }
    else if (k === 'ArrowRight') { aim = Math.min(6, aim + 1); ui.showAim = true; render(); }
    else if (k === 'Enter' || k === ' ') { if (game && game.over) newGame(false); else { ui.showAim = true; drop(aim, false); } }
    else if (k === 'u' || k === 'U' || k === 'Backspace') undo();
    else if (k === 'n' || k === 'N') { if (!game || !game.moves.length || game.over || window.confirm('Start a new game?')) newGame(false); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  Cade.registerWidget({
    name: 'Connect Four',
    description: 'Drop discs, line up four — vs the computer (Easy to Hard) or a friend',
    icon: C4_ICON,
    tags: 'game,connect four,connect 4,four in a row,board game,strategy,ai,2 players,fun,train',
    open: open,
    _core: function () { return C4Core(); }       // exposed for headless tests
  });
})();
