/* Sudoku — the classic 9×9 number puzzle: Easy → Expert, plus a shared Daily
 * puzzle (the same grid for everyone on a given date).
 *
 * ENGINE: SudokuCore() is pure (no DOM, no outer references). A bitmask
 * backtracking solver proves every generated puzzle has exactly ONE solution,
 * and a human-style grader (singles → locked candidates / pairs → triples,
 * X-Wing, XY-Wing, Swordfish) sets the level, so "Hard" really needs a Hard
 * technique. Generation runs in ~10 ms slices between frames, so even an
 * Expert puzzle (which may take dozens of attempts) never freezes the page.
 *
 * PLAY: tap a cell, type 1-9 or use the pad. N toggles notes (pencil marks),
 * Shift+digit writes a note directly, arrows move, Backspace erases,
 * Ctrl+Z / Ctrl+Y undo / redo, Space pauses, Esc closes. Every mode has its own
 * save slot in Cade.store, so closing the panel or switching level never loses
 * a game; the timer only runs while the board is visible.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('sudoku.css');

  // ---- pure engine ---------------------------------------------------------
  // Self-contained (no outer references) so its source can also be shipped to
  // a Blob-URL Worker: generation never blocks the UI thread.
  function SudokuCore() {
    var ALL = 511;
    var POP = new Uint8Array(512), LOW = new Int8Array(512);
    for (var m = 1; m < 512; m++) {
      POP[m] = POP[m >> 1] + (m & 1);
      LOW[m] = (m & 1) ? 1 : LOW[m >> 1] + 1;      // lowest set digit (1-9)
    }
    var ROW = [], COL = [], BOX = [], UNITS = [], PEERS = [], UNITS_OF = [];
    for (var i = 0; i < 81; i++) {
      ROW[i] = (i / 9) | 0; COL[i] = i % 9;
      BOX[i] = ((ROW[i] / 3) | 0) * 3 + ((COL[i] / 3) | 0);
    }
    for (var u = 0; u < 27; u++) UNITS.push([]);
    for (i = 0; i < 81; i++) {
      UNITS[ROW[i]].push(i); UNITS[9 + COL[i]].push(i); UNITS[18 + BOX[i]].push(i);
      UNITS_OF[i] = [ROW[i], 9 + COL[i], 18 + BOX[i]];
    }
    for (i = 0; i < 81; i++) {
      var ps = [];
      for (var j = 0; j < 81; j++) {
        if (j !== i && (ROW[j] === ROW[i] || COL[j] === COL[i] || BOX[j] === BOX[i])) ps.push(j);
      }
      PEERS[i] = ps;
    }

    // Small fast PRNG (sfc32) seeded from a string: same seed, same puzzle on
    // every device — that's what makes the Daily puzzle shared.
    function rngFrom(seed) {
      var h = 1779033703 ^ seed.length;
      for (var k = 0; k < seed.length; k++) {
        h = Math.imul(h ^ seed.charCodeAt(k), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      function mix() { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; }
      var a = mix(), b = mix(), c = mix(), d = mix();
      return function () {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        var t = (a + b) | 0;
        a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
      };
    }
    function shuffle(a, rnd) {
      for (var k = a.length - 1; k > 0; k--) { var r = (rnd() * (k + 1)) | 0, t = a[k]; a[k] = a[r]; a[r] = t; }
      return a;
    }

    // ---- backtracking solver (bitmasks + minimum-remaining-values) ----------
    // Counts solutions up to `limit` (2 is enough to prove uniqueness). With
    // `rnd` it tries digits in random order — used to make a random full grid.
    function search(grid, limit, rnd, out) {
      var g = grid.slice(), rows = [0, 0, 0, 0, 0, 0, 0, 0, 0], cols = rows.slice(), boxes = rows.slice();
      var empties = [], count = 0;
      for (var k = 0; k < 81; k++) {
        var v = g[k];
        if (!v) { empties.push(k); continue; }
        var bit = 1 << (v - 1);
        if ((rows[ROW[k]] | cols[COL[k]] | boxes[BOX[k]]) & bit) return 0; // givens clash
        rows[ROW[k]] |= bit; cols[COL[k]] |= bit; boxes[BOX[k]] |= bit;
      }
      var n = empties.length;
      function rec(depth) {
        if (depth === n) { count++; if (out && !out.length) for (var q = 0; q < 81; q++) out.push(g[q]); return count >= limit; }
        // pick the most constrained empty cell
        var best = -1, bestMask = 0, bestPop = 10;
        for (var e = depth; e < n; e++) {
          var c = empties[e], mask = ALL & ~(rows[ROW[c]] | cols[COL[c]] | boxes[BOX[c]]), p = POP[mask];
          if (p < bestPop) { bestPop = p; best = e; bestMask = mask; if (p <= 1) break; }
        }
        if (bestPop === 0) return false;
        var tmp = empties[depth]; empties[depth] = empties[best]; empties[best] = tmp;
        var cell = empties[depth], r = ROW[cell], cc = COL[cell], b = BOX[cell];
        var digits = [];
        for (var m2 = bestMask; m2; m2 &= m2 - 1) digits.push(LOW[m2]);
        if (rnd) shuffle(digits, rnd);
        for (var t = 0; t < digits.length; t++) {
          var d = digits[t], bt = 1 << (d - 1);
          g[cell] = d; rows[r] |= bt; cols[cc] |= bt; boxes[b] |= bt;
          var stop = rec(depth + 1);
          rows[r] &= ~bt; cols[cc] &= ~bt; boxes[b] &= ~bt; g[cell] = 0;
          if (stop) return true;
        }
        empties[best] = empties[depth]; empties[depth] = tmp;
        return false;
      }
      rec(0);
      return count;
    }
    function countSolutions(grid, limit) { return search(grid, limit || 2, null, null); }
    function solve(grid) { var out = []; return search(grid, 1, null, out) ? out : null; }
    function randomSolution(rnd) { var out = [], g = []; for (var k = 0; k < 81; k++) g.push(0); search(g, 1, rnd, out); return out; }

    // ---- logical grader -------------------------------------------------------
    // Solves the way a person would, recording the hardest technique tier
    // needed: 1 singles · 2 locked candidates / pairs · 3 triples, X-Wing,
    // Swordfish, XY-Wing · 4 none of these suffice. A puzzle the grader
    // finishes is also proven unique (every step was a forced deduction).
    function grade(grid, maxTier) {
      maxTier = maxTier || 3;
      var val = grid.slice(), cand = new Array(81), left = 0, tier = 0, k;
      for (k = 0; k < 81; k++) cand[k] = val[k] ? 0 : ALL;
      for (k = 0; k < 81; k++) if (val[k]) { var bt = ~(1 << (val[k] - 1)); var p = PEERS[k]; for (var q = 0; q < 20; q++) cand[p[q]] &= bt; }
      for (k = 0; k < 81; k++) if (!val[k]) left++;
      function place(c, dd) {
        val[c] = dd; cand[c] = 0; left--;
        var nb = ~(1 << (dd - 1)), p2 = PEERS[c];
        for (var q2 = 0; q2 < 20; q2++) cand[p2[q2]] &= nb;
      }
      function singles() {
        var did = false, c, uu, e;
        for (c = 0; c < 81; c++) {
          if (!val[c]) {
            if (!cand[c]) return -1;
            if (POP[cand[c]] === 1) { place(c, LOW[cand[c]]); did = true; }
          }
        }
        for (uu = 0; uu < 27; uu++) {
          var unit = UNITS[uu], once = 0, twice = 0, seen = 0;
          for (e = 0; e < 9; e++) { var cm = cand[unit[e]]; twice |= once & cm; once |= cm; if (val[unit[e]]) seen |= 1 << (val[unit[e]] - 1); }
          if ((once | seen) !== ALL) return -1;          // a digit has nowhere to go
          var only = once & ~twice & ~seen;
          for (; only; only &= only - 1) {
            var bit = only & -only;
            for (e = 0; e < 9; e++) if (cand[unit[e]] & bit) { place(unit[e], LOW[bit]); did = true; break; }
          }
        }
        return did ? 1 : 0;
      }
      function elim(c, mask) { if (cand[c] & mask) { cand[c] &= ~mask; return true; } return false; }
      // pointing / claiming
      function locked() {
        var did = false;
        for (var bx = 0; bx < 9; bx++) {
          var box = UNITS[18 + bx];
          for (var dg = 0; dg < 9; dg++) {
            var bit = 1 << dg, rs = -1, cs = -1, n = 0;
            for (var e = 0; e < 9; e++) {
              var c = box[e];
              if (cand[c] & bit) { n++; rs = rs === -1 || rs === ROW[c] ? ROW[c] : -2; cs = cs === -1 || cs === COL[c] ? COL[c] : -2; }
            }
            if (n < 2) continue;
            if (rs >= 0) { var ru = UNITS[rs]; for (e = 0; e < 9; e++) if (BOX[ru[e]] !== bx && elim(ru[e], bit)) did = true; }
            if (cs >= 0) { var cu = UNITS[9 + cs]; for (e = 0; e < 9; e++) if (BOX[cu[e]] !== bx && elim(cu[e], bit)) did = true; }
          }
        }
        for (var li = 0; li < 18; li++) {
          var line = UNITS[li];
          for (dg = 0; dg < 9; dg++) {
            bit = 1 << dg; var bs = -1; n = 0;
            for (e = 0; e < 9; e++) if (cand[line[e]] & bit) { n++; bs = bs === -1 || bs === BOX[line[e]] ? BOX[line[e]] : -2; }
            if (n < 2 || bs < 0) continue;
            var bu = UNITS[18 + bs];
            for (e = 0; e < 9; e++) if (line.indexOf(bu[e]) === -1 && elim(bu[e], bit)) did = true;
          }
        }
        return did;
      }
      // naked + hidden subsets of size `size` in every unit
      function subsets(size) {
        var did = false;
        for (var uu = 0; uu < 27; uu++) {
          var unit = UNITS[uu], open = [], e;
          for (e = 0; e < 9; e++) if (!val[unit[e]]) open.push(unit[e]);
          if (open.length <= size) continue;
          // naked: `size` cells whose candidates union to `size` digits
          var pick = [];
          (function nk(start, mask) {
            if (pick.length === size) {
              if (POP[mask] !== size) return;
              for (var x = 0; x < open.length; x++) if (pick.indexOf(open[x]) === -1 && elim(open[x], mask)) did = true;
              return;
            }
            for (var s = start; s < open.length; s++) {
              var cm = cand[open[s]], nm = mask | cm;
              if (POP[cm] < 2 || POP[nm] > size) continue;
              pick.push(open[s]); nk(s + 1, nm); pick.pop();
            }
          })(0, 0);
          // hidden: `size` digits confined to the same `size` cells
          var digs = [], where = [];
          for (var dg = 0; dg < 9; dg++) {
            var w = 0, bit = 1 << dg;
            for (e = 0; e < open.length; e++) if (cand[open[e]] & bit) w |= 1 << e;
            if (POP[w & 511] + POP[w >> 9] >= 2) { digs.push(bit); where.push(w); }
          }
          var dp = [];
          (function hd(start, cells, dmask) {
            if (dp.length === size) {
              if (POP[cells & 511] + POP[cells >> 9] !== size) return;
              for (var x = 0; x < open.length; x++) if ((cells >> x) & 1) { if (elim(open[x], ALL & ~dmask)) did = true; }
              return;
            }
            for (var s = start; s < digs.length; s++) {
              var nc = cells | where[s];
              if (POP[nc & 511] + POP[nc >> 9] > size) continue;
              dp.push(s); hd(s + 1, nc, dmask | digs[s]); dp.pop();
            }
          })(0, 0, 0);
        }
        return did;
      }
      // X-Wing (size 2) / Swordfish (size 3)
      function fish(size) {
        var did = false;
        for (var dg = 0; dg < 9; dg++) {
          var bit = 1 << dg;
          for (var dir = 0; dir < 2; dir++) {
            var base = [], masks = [];
            for (var li = 0; li < 9; li++) {
              var line = UNITS[dir * 9 + li], w = 0;
              for (var e = 0; e < 9; e++) if (cand[line[e]] & bit) w |= 1 << e;
              if (POP[w & 511] >= 2 && POP[w & 511] <= size) { base.push(li); masks.push(w); }
            }
            var chosen = [];
            (function f(start, cover) {
              if (chosen.length === size) {
                if (POP[cover] !== size) return;
                for (var ci = 0; ci < 9; ci++) {
                  if (!((cover >> ci) & 1)) continue;
                  var cross = UNITS[(1 - dir) * 9 + ci];
                  for (var e2 = 0; e2 < 9; e2++) if (chosen.indexOf(e2) === -1 && elim(cross[e2], bit)) did = true;
                }
                return;
              }
              for (var s = start; s < base.length; s++) {
                var nc = cover | masks[s];
                if (POP[nc] > size) continue;
                chosen.push(base[s]); f(s + 1, nc); chosen.pop();
              }
            })(0, 0);
          }
        }
        return did;
      }
      function xyWing() {
        var did = false;
        for (var pv = 0; pv < 81; pv++) {
          var pm = cand[pv];
          if (POP[pm] !== 2) continue;
          var wings = [], p3 = PEERS[pv];
          for (var q = 0; q < 20; q++) { var w = cand[p3[q]]; if (POP[w] === 2 && w !== pm && POP[w & pm] === 1) wings.push(p3[q]); }
          for (var a = 0; a < wings.length; a++) for (var b = a + 1; b < wings.length; b++) {
            var wa = cand[wings[a]], wb = cand[wings[b]];
            var z = wa & wb & ~pm;
            if (POP[z] !== 1 || (wa & pm) === (wb & pm)) continue;
            var pa = PEERS[wings[a]];
            for (var x = 0; x < 20; x++) {
              var c = pa[x];
              if (c !== pv && c !== wings[b] && PEERS[wings[b]].indexOf(c) !== -1 && elim(c, z)) did = true;
            }
          }
        }
        return did;
      }
      var guard = 0;
      while (left > 0 && guard++ < 500) {
        var r = singles();
        if (r < 0) return { solved: false, tier: 4, broken: true, grid: val };
        if (r) { tier = Math.max(tier, 1); continue; }
        if (left === 0) break;
        if (maxTier < 2) break;
        if (locked() || subsets(2)) { tier = Math.max(tier, 2); continue; }
        if (maxTier < 3) break;
        if (subsets(3) || fish(2) || xyWing() || fish(3)) { tier = 3; continue; }
        break;
      }
      if (left === 0) return { solved: true, tier: Math.max(1, tier), grid: val };
      return { solved: false, tier: 4, grid: val };
    }

    // ---- generator --------------------------------------------------------
    // Difficulty = clue budget + the technique tier a person needs:
    //   easy   36-40 clues, singles only
    //   medium 28-31 clues, needs no more than locked candidates / pairs
    //   hard   dug to minimal, MUST need locked candidates / pairs
    //   expert dug to minimal, MUST need triples / X-Wing / XY-Wing / Swordfish
    var LEVELS = {
      easy: { lo: 36, hi: 40, maxTier: 1, minTier: 1 },
      medium: { lo: 28, hi: 31, maxTier: 2, minTier: 1 },
      hard: { lo: 0, hi: 0, maxTier: 2, minTier: 2 },
      expert: { lo: 0, hi: 0, maxTier: 3, minTier: 3 }
    };
    // One attempt: random full grid, then remove symmetric pairs of clues while
    // the puzzle keeps exactly one solution (backtracking check) AND stays
    // within the level's technique ceiling. Returns null when the finished
    // puzzle falls short of the level's minimum tier (caller retries);
    // `relaxed` drops that minimum — a last resort after very many tries.
    function attempt(level, rnd, relaxed) {
      var L = LEVELS[level] || LEVELS.medium;
      var sol = randomSolution(rnd), puz = sol.slice(), clues = 81;
      var target = L.hi ? L.lo + ((rnd() * (L.hi - L.lo + 1)) | 0) : 0;
      var order = [];
      for (var k = 0; k <= 40; k++) order.push(k);
      shuffle(order, rnd);
      for (var o = 0; o < order.length; o++) {
        if (clues <= target) break;
        var a = order[o], b = 80 - a, n = a === b ? 1 : 2;
        if (clues - n < target) continue;
        var va = puz[a], vb = puz[b];
        puz[a] = 0; puz[b] = 0;
        if (countSolutions(puz, 2) === 1 && grade(puz, L.maxTier).solved) clues -= n;
        else { puz[a] = va; puz[b] = vb; }
      }
      var g = grade(puz, L.maxTier);
      if (!g.solved || (!relaxed && g.tier < L.minTier)) return null;
      return { puzzle: puz, solution: sol, clues: clues, tier: g.tier, level: level };
    }
    function generate(level, seed, maxAttempts) {
      var rnd = rngFrom(String(seed)), res = null, tries = 0;
      maxAttempts = maxAttempts || 400;
      while (!res && tries < maxAttempts) { tries++; res = attempt(level, rnd, tries > maxAttempts - 20); }
      if (res) res.attempts = tries;
      return res;
    }

    return {
      ALL: ALL, POP: POP, LOW: LOW, ROW: ROW, COL: COL, BOX: BOX, UNITS: UNITS, PEERS: PEERS,
      rngFrom: rngFrom, countSolutions: countSolutions, solve: solve, grade: grade,
      randomSolution: randomSolution, attempt: attempt, generate: generate, LEVELS: LEVELS
    };
  }

  // ---- widget state ---------------------------------------------------------
  var PANEL_ID = 'sudoku-panel';
  var SUDOKU_ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><path d='M9 3v18M15 3v18M3 9h18M3 15h18' stroke-width='1'/><text x='12' y='14.6' font-size='7.5' font-weight='bold' text-anchor='middle' fill='currentColor' stroke='none'>9</text></svg>";
  var SAVE_KEY = 'cade-sudoku-save', STATS_KEY = 'cade-sudoku-stats', PREFS_KEY = 'cade-sudoku-prefs';
  var LEVELS = ['easy', 'medium', 'hard', 'expert'];
  var LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', daily: 'Daily' };
  // The Daily follows the week like a newspaper puzzle: gentle Monday, tough Saturday.
  var DAILY_LEVEL = ['hard', 'easy', 'easy', 'medium', 'medium', 'hard', 'expert']; // Sun..Sat
  var MAX_UNDO = 400;
  var SLICE_MS = 10;              // generation work per frame
  var RELAX_AFTER = 600;          // attempts before a level's minimum tier is waived

  var core = null;                // SudokuCore(), built on first open
  var save = null;                // { cur: mode, slots: { mode: game } }
  var game = null;                // save.slots[save.cur]
  var stats = {}, prefs = { showWrong: true };
  var ui = null;                  // DOM refs while the panel is open
  var sel = -1, hlDigit = 0, notesMode = false, paused = false, active = true;
  var undoStack = [], redoStack = [];
  var runSince = 0, tickIv = 0, gen = null, winTimer = 0;
  var cellKey = [];               // last painted state per cell (skip no-op DOM writes)

  // ---- small helpers ----------------------------------------------------------
  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function today() { return dateKey(new Date()); }
  function yesterday() { var d = new Date(); d.setDate(d.getDate() - 1); return dateKey(d); }
  function parseDate(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dailyLevel(s) { return DAILY_LEVEL[parseDate(s).getDay()] || 'medium'; }
  function prettyDate(s) {
    try { return parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return s; }
  }
  function fmtTime(ms) {
    var s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function zeros() { var a = []; for (var k = 0; k < 81; k++) a.push(0); return a; }
  function toast(msg, type) { try { Cade.showToast(msg, type || 'info', 2200); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s)); }

  // ---- persistence ------------------------------------------------------------
  function serialize(g) {
    return {
      mode: g.mode, level: g.level, date: g.date, puz: g.puz.join(''), sol: g.sol.join(''), val: g.val.join(''),
      notes: g.notes.join(','), t: Math.round(g.t), mis: g.mis, hints: g.hints, hl: g.hl.join(','), done: g.done, rev: g.rev
    };
  }
  function digitArr(s, allowZero) {
    if (typeof s !== 'string' || !/^[0-9]{81}$/.test(s) || (!allowZero && s.indexOf('0') !== -1)) return null;
    var a = [];
    for (var k = 0; k < 81; k++) a.push(s.charCodeAt(k) - 48);
    return a;
  }
  function deserialize(o) {
    if (!o || typeof o !== 'object') return null;
    var puz = digitArr(o.puz, true), sol = digitArr(o.sol, false), val = digitArr(o.val, true);
    if (!puz || !sol || !val || !LABEL[o.level]) return null;
    var notes = String(o.notes || '').split(',').map(function (x) { return (+x || 0) & 511; });
    if (notes.length !== 81) notes = zeros();
    var hl = String(o.hl || '').split(',').filter(Boolean).map(Number).filter(function (x) { return x >= 0 && x < 81; });
    return {
      mode: o.mode, level: o.level, date: o.date || '', puz: puz, sol: sol, val: val, notes: notes,
      t: +o.t || 0, mis: +o.mis || 0, hints: +o.hints || 0, hl: hl, done: o.done ? 1 : 0, rev: o.rev ? 1 : 0, wrong: {}
    };
  }
  function loadState() {
    var s = readJSON(SAVE_KEY, null);
    save = { cur: '', slots: {} };
    if (s && s.slots && typeof s.slots === 'object') {
      for (var m in s.slots) {
        if (m !== 'daily' && LEVELS.indexOf(m) === -1) continue;
        var g = deserialize(s.slots[m]);
        if (g) { g.mode = m; save.slots[m] = g; }
      }
      save.cur = s.cur;
    }
    game = save.slots[save.cur] || null;
    stats = readJSON(STATS_KEY, {});
    if (!stats || typeof stats !== 'object') stats = {};
    var p = readJSON(PREFS_KEY, {});
    if (p && typeof p.showWrong === 'boolean') prefs.showWrong = p.showWrong;
  }
  function persist() {
    if (!save) return;
    foldClock();
    var out = { cur: save.cur, slots: {} };
    for (var m in save.slots) out.slots[m] = serialize(save.slots[m]);
    writeJSON(SAVE_KEY, out);
  }
  function saveStats() { writeJSON(STATS_KEY, stats); }

  // ---- clock: runs only while the board is actually visible -----------------------
  function elapsed() { return game ? game.t + (runSince ? now() - runSince : 0) : 0; }
  function foldClock() { if (runSince && game) { var n = now(); game.t += n - runSince; runSince = n; } }
  function stopClock() { foldClock(); runSince = 0; }
  function canRun() { return !!(ui && game && !game.done && !paused && !gen && !ui.ovKind && !document.hidden); }
  function syncClock() {
    if (canRun()) { if (!runSince) runSince = now(); } else stopClock();
    paintTime();
  }
  function paintTime() {
    if (!ui) return;
    var txt = !game ? '' : game.rev ? 'Revealed' : game.done ? 'Solved ' + fmtTime(game.t) : fmtTime(elapsed());
    if (ui.time.textContent !== txt) ui.time.textContent = txt;
  }

  // ---- game actions -------------------------------------------------------------
  var R = function (i) { return core.ROW[i]; }, Co = function (i) { return core.COL[i]; }, B = function (i) { return core.BOX[i]; };

  function resetSession() {
    sel = -1; hlDigit = 0; paused = false; undoStack = []; redoStack = []; cellKey = [];
    clearTimeout(winTimer);
    if (ui) ui.board.classList.remove('won');
  }
  function playable() { return !!(game && !game.done && !paused && !gen && ui && !ui.ovKind); }

  // changes: [cell, oldVal, oldNotes, newVal, newNotes]
  function apply(changes, from, to) {
    for (var k = 0; k < changes.length; k++) {
      var c = changes[k];
      game.val[c[0]] = c[3]; game.notes[c[0]] = c[4]; delete game.wrong[c[0]];
    }
    if (from) { from.push(changes); if (from.length > MAX_UNDO) from.shift(); }
    if (to === redoStack) redoStack = [];
    persist();
    render();
  }
  function invert(changes) { return changes.map(function (c) { return [c[0], c[3], c[4], c[1], c[2]]; }).reverse(); }
  function undo() {
    if (!playable() || !undoStack.length) return;
    var ch = undoStack.pop();
    apply(invert(ch), null, null);
    redoStack.push(ch);
    sel = ch[0][0];
    render();
  }
  function redo() {
    if (!playable() || !redoStack.length) return;
    var ch = redoStack.pop();
    apply(ch, null, null);
    undoStack.push(ch);
    sel = ch[0][0];
    render();
    checkWin();
  }
  function commit(changes) { if (changes.length) apply(changes, undoStack, redoStack); }

  function placeChanges(i, d) {
    var g = game, ch = [[i, g.val[i], g.notes[i], d, 0]], bit = 1 << (d - 1), peers = core.PEERS[i];
    // Placing a digit retires it from the notes of every cell it now sees.
    for (var k = 0; k < peers.length; k++) {
      var p = peers[k];
      if (!g.val[p] && (g.notes[p] & bit)) ch.push([p, 0, g.notes[p], 0, g.notes[p] & ~bit]);
    }
    return ch;
  }
  function inputDigit(d, asNote) {
    if (!playable()) return;
    var g = game;
    if (sel < 0 || g.puz[sel]) { hlDigit = hlDigit === d ? 0 : d; render(); return; }
    var i = sel;
    if (asNote || notesMode) {
      if (g.val[i]) return;
      commit([[i, 0, g.notes[i], 0, g.notes[i] ^ (1 << (d - 1))]]);
      return;
    }
    if (g.val[i] === d) { commit([[i, d, g.notes[i], 0, g.notes[i]]]); return; } // same digit again clears it
    if (d !== g.sol[i]) { g.mis++; try { Cade.haptic(18); } catch (e) {} }
    commit(placeChanges(i, d));
    checkWin();
  }
  function erase() {
    if (!playable() || sel < 0 || game.puz[sel]) return;
    var g = game, i = sel;
    if (g.val[i]) commit([[i, g.val[i], g.notes[i], 0, g.notes[i]]]);
    else if (g.notes[i]) commit([[i, 0, g.notes[i], 0, 0]]);
  }
  function toggleNotes() { notesMode = !notesMode; render(); }
  function move(dr, dc) {
    if (sel < 0) { sel = 40; render(); return; }
    var r = (R(sel) + dr + 9) % 9, c = (Co(sel) + dc + 9) % 9;
    sel = r * 9 + c;
    render();
  }
  function select(i) { sel = i; hlDigit = 0; render(); }

  function hint() {
    if (!playable()) return;
    var g = game, i = -1, k;
    if (sel >= 0 && !g.puz[sel] && g.val[sel] !== g.sol[sel]) i = sel;
    for (k = 0; k < 81 && i < 0; k++) if (g.val[k] && g.val[k] !== g.sol[k]) i = k;   // fix a mistake first
    if (i < 0) {                                                                     // else the most constrained empty cell
      var best = 10;
      for (k = 0; k < 81; k++) {
        if (g.val[k]) continue;
        var seen = 0, ps = core.PEERS[k];
        for (var q = 0; q < 20; q++) if (g.val[ps[q]]) seen |= 1 << (g.val[ps[q]] - 1);
        var n = core.POP[511 & ~seen];
        if (n < best) { best = n; i = k; }
      }
    }
    if (i < 0) return;
    g.hints++;
    if (g.hl.indexOf(i) === -1) g.hl.push(i);
    sel = i;
    commit(placeChanges(i, g.sol[i]));
    checkWin();
  }
  function check() {
    if (!playable()) return;
    var g = game, bad = 0, empty = 0;
    for (var k = 0; k < 81; k++) {
      if (g.puz[k]) continue;
      if (!g.val[k]) empty++;
      else if (g.val[k] !== g.sol[k]) { g.wrong[k] = 1; bad++; }
    }
    cellKey = [];
    render();
    if (bad) toast(bad + (bad === 1 ? ' number is' : ' numbers are') + ' wrong', 'error');
    else toast('All correct so far · ' + empty + ' to go', 'success');
  }
  function restart() {
    if (!game || game.done) return;
    if (!window.confirm('Clear all your entries and start this puzzle again? (The clock keeps running.)')) return;
    game.val = game.puz.slice(); game.notes = zeros(); game.wrong = {}; game.hl = [];
    resetSession(); hideOverlay(); persist(); render();
  }
  function reveal() {
    if (!game || game.done) return;
    if (!window.confirm('Reveal the solution? This ends the game and won’t count as a win.')) return;
    stopClock();
    game.val = game.sol.slice(); game.notes = zeros(); game.done = 1; game.rev = 1; game.wrong = {};
    resetSession(); hideOverlay(); persist(); render();
  }

  function checkWin() {
    var g = game;
    for (var k = 0; k < 81; k++) if (g.val[k] !== g.sol[k]) return false;
    stopClock();
    g.done = 1; sel = -1; hlDigit = 0;
    var t = g.t, st, firstWin = false, newBest = false, streak = 0;
    if (g.mode === 'daily') {
      st = stats.daily = stats.daily || {};
      // The streak counts dailies solved on their own day.
      if (g.date === today() && st.last !== g.date) {
        st.streak = st.last === yesterday() ? (st.streak || 0) + 1 : 1;
        st.max = Math.max(st.max || 0, st.streak);
        st.last = g.date;
      }
      streak = st.streak || 0;
    } else {
      st = stats[g.level] = stats[g.level] || {};
    }
    st.w = (st.w || 0) + 1;
    st.tot = (st.tot || 0) + t;
    firstWin = st.w === 1;
    if (!g.hints && (!st.best || t < st.best)) { newBest = !!st.best || firstWin; st.best = t; }
    saveStats();
    persist();
    render();
    try { Cade.haptic(30); } catch (e) {}
    if (ui) {
      ui.board.classList.add('won');
      var html = '<div class="sd-card sd-wincard"><div class="sd-big">🎉</div><b class="sd-title">Solved!</b>' +
        '<div class="sd-sub">' + esc(g.mode === 'daily' ? 'Daily · ' + prettyDate(g.date) + ' · ' + LABEL[g.level] : LABEL[g.level]) + '</div>' +
        '<div class="sd-wintime">' + fmtTime(t) + '</div>' +
        '<div class="sd-sub">' + (g.hints ? 'Hints used — best time not recorded' : newBest ? (firstWin ? 'First win!' : 'New best time!') : 'Best ' + fmtTime(st.best)) + '</div>' +
        '<div class="sd-sub">Mistakes ' + g.mis + ' · Hints ' + g.hints + (streak ? ' · Streak 🔥 ' + streak : '') + '</div>' +
        '<div class="sd-acts"><button class="sd-primary" data-act="newmenu">New game</button><button data-act="stats">Stats</button><button data-act="hide">View board</button></div></div>';
      clearTimeout(winTimer);
      winTimer = setTimeout(function () { if (ui && game === g) showOverlay('win', html); }, 1100);
    }
    return true;
  }

  // ---- generation (time-sliced; deterministic per seed) ------------------------
  function cancelGen() { if (gen) { clearTimeout(gen.timer); gen = null; } }
  function startNew(mode) {
    var level = mode === 'daily' ? dailyLevel(today()) : mode;
    var seed = mode === 'daily' ? 'cade-sudoku-daily-' + today() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    stopClock(); persist(); cancelGen();
    var rnd = core.rngFrom(seed), tries = 0, me = { timer: 0 };
    gen = me;
    showOverlay('gen', '<div class="sd-card sd-gen"><div class="sd-spin"></div>Generating ' + LABEL[level] + ' puzzle…</div>');
    function step() {
      if (gen !== me) return;
      var t0 = now(), r = null;
      while (!r && now() - t0 < SLICE_MS) { tries++; r = core.attempt(level, rnd, tries > RELAX_AFTER); }
      if (!r) { me.timer = setTimeout(step, 0); return; }
      gen = null;
      var g = {
        mode: mode, level: level, date: mode === 'daily' ? today() : '', puz: r.puzzle, sol: r.solution,
        val: r.puzzle.slice(), notes: zeros(), t: 0, mis: 0, hints: 0, hl: [], done: 0, rev: 0, wrong: {}
      };
      save.slots[mode] = g; save.cur = mode; game = g;
      var st = stats[mode] = stats[mode] || {};
      st.p = (st.p || 0) + 1;
      saveStats();
      resetSession(); hideOverlay(); persist(); render();
    }
    me.timer = setTimeout(step, 30); // let the overlay paint first
  }
  function switchTo(mode) {
    var g = save.slots[mode];
    if (!g || (mode === 'daily' && g.date !== today())) { startNew(mode); return; }
    stopClock(); persist();
    save.cur = mode; game = g;
    resetSession(); hideOverlay(); persist(); render();
  }

  // ---- overlays (generation, pause, menus, stats, win) --------------------------
  function showOverlay(kind, html) {
    if (!ui) return;
    ui.ovKind = kind;
    ui.ov.className = 'sd-ov show sd-ov-' + kind;
    ui.ov.innerHTML = html;
    // While a menu covers the board the clock stops, so hide the grid too.
    ui.wrap.classList.toggle('sd-veil', kind !== 'win' && kind !== 'gen');
    syncClock();
  }
  function hideOverlay() {
    if (!ui) return;
    ui.ovKind = '';
    ui.ov.className = 'sd-ov';
    ui.ov.innerHTML = '';
    ui.wrap.classList.remove('sd-veil');
    syncClock();
  }
  function pause() {
    if (!game || game.done || gen || !ui || ui.ovKind) return;
    paused = true;
    showOverlay('pause', '<div class="sd-card"><b class="sd-title">Paused</b><div class="sd-wintime">' + fmtTime(elapsed()) + '</div>' +
      '<div class="sd-acts"><button class="sd-primary" data-act="unpause">Resume</button></div></div>');
  }
  function unpause() { paused = false; hideOverlay(); }

  function newMenu() {
    var rows = '', td = today();
    LEVELS.concat('daily').forEach(function (m) {
      var g = save.slots[m], st = stats[m] || {}, live = g && !g.done && (m !== 'daily' || g.date === td);
      var sub = m === 'daily' ? prettyDate(td) + ' · ' + LABEL[dailyLevel(td)] : (st.best ? 'Best ' + fmtTime(st.best) : 'No wins yet');
      var dailyDone = m === 'daily' && g && g.date === td && g.done;
      var chip = '';
      if (live && game === g) chip = '<button class="sd-chip" data-act="hide">Continue</button>';
      else if (live) chip = '<button class="sd-chip" data-act="resume" data-mode="' + m + '">Resume ' + fmtTime(g.t) + '</button>';
      else if (dailyDone) chip = '<span class="sd-done">✓ ' + (g.rev ? 'Revealed' : fmtTime(g.t)) + '</span>';
      rows += '<div class="sd-row"><button class="sd-pick" data-act="' + (m === 'daily' ? 'resume' : 'new') + '" data-mode="' + m + '">' +
        '<b>' + (m === 'daily' ? '📅 ' : '') + LABEL[m] + '</b><span>' + esc(sub) + '</span></button>' + chip + '</div>';
    });
    showOverlay('menu', '<div class="sd-card"><b class="sd-title">New game</b>' + rows +
      (game ? '<div class="sd-acts"><button data-act="hide">Cancel</button></div>' : '') + '</div>');
  }
  function moreMenu() {
    var live = game && !game.done;
    showOverlay('menu', '<div class="sd-card"><b class="sd-title">Game</b>' +
      '<div class="sd-list">' +
      (live ? '<button data-act="restart">↺ Restart puzzle</button><button data-act="reveal">👁 Reveal solution</button>' : '') +
      '<button data-act="stats">📊 Statistics</button>' +
      '<button data-act="wrongpref" class="sd-tog' + (prefs.showWrong ? ' on' : '') + '">' + (prefs.showWrong ? '☑' : '☐') + ' Show mistakes as you type</button>' +
      '</div><div class="sd-hint">Keys: 1-9 · Shift+digit note · N notes · arrows · Backspace · Ctrl+Z/Y · Space pause · Esc close</div>' +
      '<div class="sd-acts"><button data-act="hide">Close</button></div></div>');
  }
  function statsMenu() {
    var rows = '';
    LEVELS.forEach(function (m) {
      var s = stats[m] || {};
      rows += '<tr><td>' + LABEL[m] + '</td><td>' + (s.w || 0) + '/' + (s.p || 0) + '</td><td>' + (s.best ? fmtTime(s.best) : '—') +
        '</td><td>' + (s.w ? fmtTime(s.tot / s.w) : '—') + '</td></tr>';
    });
    var d = stats.daily || {};
    var streak = d.last === today() || d.last === yesterday() ? d.streak || 0 : 0;
    rows += '<tr><td>Daily</td><td>' + (d.w || 0) + '/' + (d.p || 0) + '</td><td>' + (d.best ? fmtTime(d.best) : '—') +
      '</td><td>' + (d.w ? fmtTime(d.tot / d.w) : '—') + '</td></tr>';
    showOverlay('stats', '<div class="sd-card"><b class="sd-title">Statistics</b>' +
      '<table class="sd-stats"><thead><tr><th></th><th>Won</th><th>Best</th><th>Avg</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="sd-sub">Daily streak 🔥 ' + streak + ' · longest ' + (d.max || 0) + '</div>' +
      '<div class="sd-acts"><button data-act="resetstats">Reset</button><button class="sd-primary" data-act="hide">Close</button></div></div>');
  }

  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act'), mode = b.getAttribute('data-mode');
    if (act === 'hide') { if (game) hideOverlay(); }
    else if (act === 'new') startNew(mode);
    else if (act === 'resume') switchTo(mode);
    else if (act === 'newmenu') newMenu();
    else if (act === 'stats') statsMenu();
    else if (act === 'unpause') unpause();
    else if (act === 'restart') restart();
    else if (act === 'reveal') reveal();
    else if (act === 'wrongpref') { prefs.showWrong = !prefs.showWrong; writeJSON(PREFS_KEY, prefs); cellKey = []; render(); moreMenu(); }
    else if (act === 'resetstats') {
      if (window.confirm('Reset all Sudoku statistics?')) { stats = {}; saveStats(); statsMenu(); }
    }
  }

  // ---- rendering ----------------------------------------------------------------
  function conflictMap() {
    var bad = {}, U = core.UNITS;
    for (var u = 0; u < 27; u++) {
      var first = {}, unit = U[u];
      for (var e = 0; e < 9; e++) {
        var i = unit[e], v = game.val[i];
        if (!v) continue;
        if (first[v] !== undefined) { bad[i] = 1; bad[first[v]] = 1; } else first[v] = i;
      }
    }
    return bad;
  }
  function render() {
    if (!ui) return;
    var g = game, k;
    ui.lvl.textContent = !g ? 'Sudoku' : g.mode === 'daily' ? 'Daily · ' + LABEL[g.level] : LABEL[g.level];
    // With "show mistakes" off the counter would give wrong entries away.
    ui.mis.textContent = g && (prefs.showWrong || g.done) ? 'Mistakes ' + g.mis : '';
    ui.mis.classList.toggle('bad', !!(g && g.mis));
    paintTime();
    ui.root.classList.toggle('sd-over', !!(g && g.done));
    ui.notesBtn.classList.toggle('on', notesMode);
    ui.notesBtn.querySelector('.sd-tl').textContent = notesMode ? 'Notes on' : 'Notes';
    ui.undoBtn.disabled = !undoStack.length;
    ui.redoBtn.disabled = !redoStack.length;
    if (!g) {
      for (k = 0; k < 81; k++) if (cellKey[k] !== '') { cellKey[k] = ''; ui.cells[k].className = 'sd-cell'; ui.cells[k].textContent = ''; }
      return;
    }
    var conflicts = conflictMap(), live = !g.done;
    var sv = sel >= 0 ? g.val[sel] : 0, hd = live ? (sv || hlDigit) : 0;
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (k = 0; k < 81; k++) {
      var v = g.val[k], given = g.puz[k] !== 0, cls = 'sd-cell';
      counts[v]++;
      if (given) cls += ' given'; else if (v) cls += ' user';
      if (live && sel >= 0) {
        if (k === sel) cls += ' sel';
        else if (R(k) === R(sel) || Co(k) === Co(sel) || B(k) === B(sel)) cls += ' peer';
      }
      if (hd && v === hd && k !== sel) cls += ' same';
      if (live && conflicts[k]) cls += ' conflict';
      if (!given && v && v !== g.sol[k] && (prefs.showWrong || g.wrong[k])) cls += ' wrong';
      if (!given && g.hl.indexOf(k) !== -1 && v === g.sol[k]) cls += ' hinted';
      var n = v ? 0 : g.notes[k];
      var key = cls + '|' + v + '|' + n + '|' + (n ? hd : 0);
      if (cellKey[k] === key) continue;
      cellKey[k] = key;
      var el = ui.cells[k];
      el.className = cls;
      if (v) el.textContent = v;
      else if (n) {
        var h = '<div class="sd-n">';
        for (var d = 1; d <= 9; d++) {
          var on = n & (1 << (d - 1));
          h += '<span' + (on && d === hd ? ' class="hl"' : '') + '>' + (on ? d : '') + '</span>';
        }
        el.innerHTML = h + '</div>';
      } else el.textContent = '';
    }
    for (k = 1; k <= 9; k++) {
      var b = ui.pad[k], left = 9 - counts[k];
      b.classList.toggle('used', left <= 0);
      b.classList.toggle('hl', !!hd && hd === k);
      var c = b.querySelector('.sd-pc'), txt = left > 0 ? String(left) : '';
      if (c.textContent !== txt) c.textContent = txt;
    }
  }

  // ---- panel ------------------------------------------------------------------------
  function buildHtml() {
    var boxes = '';
    for (var bx = 0; bx < 9; bx++) {
      boxes += '<div class="sd-box">';
      for (var e = 0; e < 9; e++) {
        var r = ((bx / 3) | 0) * 3 + ((e / 3) | 0), c = (bx % 3) * 3 + (e % 3);
        boxes += '<div class="sd-cell" data-i="' + (r * 9 + c) + '" style="--d:' + (r + c) + '"></div>';
      }
      boxes += '</div>';
    }
    var pad = '';
    for (var d = 1; d <= 9; d++) pad += '<button class="sd-key" data-d="' + d + '" aria-label="' + d + '">' + d + '<span class="sd-pc"></span></button>';
    function tool(act, icon, label, title) {
      return '<button class="sd-tool" data-tool="' + act + '" title="' + title + '"><span class="sd-ti">' + icon + '</span><span class="sd-tl">' + label + '</span></button>';
    }
    return '<div class="sd" tabindex="-1">' +
      '<div class="sd-top"><span class="sd-lvl"></span><span class="sd-mis"></span>' +
        '<span class="sd-time" title="Pause (Space)"></span>' +
        '<button class="sd-btn" data-tool="pause" title="Pause (Space)" aria-label="Pause">⏸</button>' +
        '<button class="sd-btn" data-tool="new" title="New game">New</button>' +
        '<button class="sd-btn" data-tool="more" title="More" aria-label="More">⋯</button></div>' +
      '<div class="sd-wrap"><div class="sd-board">' + boxes + '</div><div class="sd-ov"></div></div>' +
      '<div class="sd-tools">' +
        tool('undo', '↶', 'Undo', 'Undo (Ctrl+Z)') + tool('redo', '↷', 'Redo', 'Redo (Ctrl+Y)') +
        tool('erase', '⌫', 'Erase', 'Erase (Backspace)') + tool('notes', '✎', 'Notes', 'Pencil marks (N)') +
        tool('hint', '💡', 'Hint', 'Fill one correct cell') + tool('check', '✓', 'Check', 'Mark wrong numbers') +
      '</div>' +
      '<div class="sd-pad">' + pad + '</div></div>';
  }

  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
    try { Cade.editor.focus(); } catch (e) {}
  }
  function teardown() {
    if (!ui) return;
    stopClock();
    cancelGen();
    persist();
    clearInterval(tickIv); tickIv = 0;
    clearTimeout(winTimer);
    document.removeEventListener('keydown', ui.onKey, true);
    document.removeEventListener('pointerdown', ui.onDocDown, true);
    document.removeEventListener('visibilitychange', ui.onVis);
    window.removeEventListener('pagehide', ui.onHide);
    ui = null;
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    core = core || SudokuCore();
    loadState();
    var p = Cade.mkPanel(PANEL_ID, '▦ Sudoku', buildHtml());
    var root = p.querySelector('.sd');
    ui = {
      panel: p, root: root, wrap: root.querySelector('.sd-wrap'), board: root.querySelector('.sd-board'),
      ov: root.querySelector('.sd-ov'), lvl: root.querySelector('.sd-lvl'), mis: root.querySelector('.sd-mis'),
      time: root.querySelector('.sd-time'), cells: [], pad: [], ovKind: '',
      notesBtn: root.querySelector('[data-tool="notes"]'), undoBtn: root.querySelector('[data-tool="undo"]'),
      redoBtn: root.querySelector('[data-tool="redo"]')
    };
    root.querySelectorAll('.sd-cell').forEach(function (el) { ui.cells[+el.getAttribute('data-i')] = el; });
    root.querySelectorAll('.sd-key').forEach(function (el) { ui.pad[+el.getAttribute('data-d')] = el; });
    resetSession();
    notesMode = false;
    active = true;
    p._onClose = teardown;

    // The puzzle owns the keyboard while it's the last thing you touched; a
    // click in the editor hands the keys back (so the panel can stay open).
    ui.onDocDown = function (e) { active = !!(ui && ui.panel.contains(e.target)); if (ui) ui.root.classList.toggle('sd-idle', !active); };
    ui.onKey = onKey;
    ui.onVis = function () {
      if (!ui) return;
      if (document.hidden) { if (game && !game.done && !ui.ovKind) pause(); persist(); }
      syncClock();
    };
    ui.onHide = function () { persist(); };
    document.addEventListener('keydown', ui.onKey, true);
    document.addEventListener('pointerdown', ui.onDocDown, true);
    document.addEventListener('visibilitychange', ui.onVis);
    window.addEventListener('pagehide', ui.onHide);

    // No text selection / focus theft: keep focus on the panel root.
    root.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault();
      try { root.focus({ preventScroll: true }); } catch (x) {}
      var cell = e.target.closest('.sd-cell');
      if (cell && game && !game.done && !paused && !gen && !ui.ovKind) select(+cell.getAttribute('data-i'));
    });
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (ui.ov.contains(t)) { onOverlayClick(e); return; }
      var key = t.closest('.sd-key'), tl = t.closest('[data-tool]');
      if (key) { inputDigit(+key.getAttribute('data-d'), false); return; }
      if (!tl) return;
      var a = tl.getAttribute('data-tool');
      if (a === 'undo') undo();
      else if (a === 'redo') redo();
      else if (a === 'erase') erase();
      else if (a === 'notes') toggleNotes();
      else if (a === 'hint') hint();
      else if (a === 'check') check();
      else if (a === 'pause') { if (paused) unpause(); else pause(); }
      else if (a === 'new') newMenu();
      else if (a === 'more') moreMenu();
    });
    ui.time.addEventListener('click', function () { if (paused) unpause(); else pause(); });

    try { Cade.editor.contentDOM.blur(); } catch (e) {}
    try { root.focus({ preventScroll: true }); } catch (e) {}
    tickIv = setInterval(paintTime, 500);
    render();
    if (!game) newMenu();
    else syncClock();
  }

  function onKey(e) {
    if (!ui || !active) return;
    var ae = document.activeElement;
    if (ae && ae !== document.body && !ui.panel.contains(ae)) return; // typing elsewhere (editor, palette…)
    var k = e.key, mod = e.ctrlKey || e.metaKey, handled = true;
    if (k === 'Escape') {
      if (ui.ovKind && ui.ovKind !== 'gen' && ui.ovKind !== 'pause' && game) hideOverlay();
      else close();
    } else if (mod && !e.altKey && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); }
    else if (mod && !e.altKey && (k === 'y' || k === 'Y')) redo();
    else if (mod || e.altKey) handled = false;
    else if (ui.ovKind) {
      if (ui.ovKind === 'pause' && (k === ' ' || k === 'Enter')) unpause();
      else handled = false;
    } else if (game && !game.done) {
      var m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
      var d = m ? +m[1] : (/^[0-9]$/.test(k) ? +k : -1);
      if (d > 0) inputDigit(d, e.shiftKey && !/^[0-9]$/.test(k)); // AZERTY digits need Shift: still a value
      else if (d === 0 || k === 'Backspace' || k === 'Delete') erase();
      else if (k === 'ArrowUp') move(-1, 0);
      else if (k === 'ArrowDown') move(1, 0);
      else if (k === 'ArrowLeft') move(0, -1);
      else if (k === 'ArrowRight') move(0, 1);
      else if (k === 'n' || k === 'N') toggleNotes();
      else if (k === ' ') pause();
      else handled = false;
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  Cade.registerWidget({
    name: 'Sudoku',
    description: 'Classic 9×9 number puzzle — Easy to Expert, plus a Daily',
    icon: SUDOKU_ICON,
    tags: 'game,sudoku,puzzle,numbers,logic,daily,brain,fun',
    open: open,
    _core: function () { return core || (core = SudokuCore()); }  // exposed for headless tests
  });
})();
