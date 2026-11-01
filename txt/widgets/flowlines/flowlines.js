/* Flow Lines — join matching dots with paths that fill the grid, for Cade.txt.
 * Every pair of same-lettered dots must be joined by a path; paths run between
 * edge-adjacent cells, may not cross or branch, and the puzzle is solved when
 * every pair is joined AND every cell of the grid is covered.
 * Puzzles are generated, never hand-made: a random Hamiltonian path over the
 * grid (a serpentine shuffled with "backbite" moves) is cut into segments, and
 * each segment's two ends become a pair — so every puzzle has at least one
 * full-fill solution, which the hint button reveals one path at a time.
 * Cuts are placed so a segment never runs alongside itself, which removes the
 * usual shortcut solutions and makes most puzzles unique.
 * Six numbered packs (5x5 … 10x10, deterministic seeds), a daily puzzle, undo,
 * restart, hints, a move counter (a move = drawing with a different colour
 * than last time; perfect = one move per pair) and per-level bests.
 * Drawn on a canvas in the house glyph style; drag with mouse / touch, or
 * steer with the keyboard (arrows + Space). Progress persists in Cade.store
 * (cade-flowlines-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var MIN_N = 5, MAX_N = 10, PACK_LEN = 30, MAX_COL = 16, OPEN_AHEAD = 3;
  var SIZES = [5, 6, 7, 8, 9, 10];
  var DAILY_SIZES = [8, 6, 7, 8, 9, 10, 7];   // Sun … Sat

  // mulberry32 and an integer hash: every puzzle is reproducible from (size, seed)
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
  function clampN(n) { n = n | 0; return n < MIN_N ? MIN_N : n > MAX_N ? MAX_N : n; }

  function nbrs(n, c) {
    var x = c % n, y = (c / n) | 0, o = [];
    if (y > 0) o.push(c - n);
    if (x < n - 1) o.push(c + 1);
    if (y < n - 1) o.push(c + n);
    if (x > 0) o.push(c - 1);
    return o;
  }
  function adj(n, a, b) {
    var d = a > b ? a - b : b - a;
    return d === n || (d === 1 && ((a / n) | 0) === ((b / n) | 0));
  }

  // A random Hamiltonian path: a serpentine, randomly oriented, then many backbite moves.
  function hamPath(n, r) {
    var p = [], x, y, tr = r() < 0.5;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var xx = (y % 2) ? n - 1 - x : x;
      p.push(tr ? xx * n + y : y * n + xx);
    }
    var N = n * n, pos = new Int32Array(N), i, k, iters = N * 40;
    for (i = 0; i < N; i++) pos[p[i]] = i;
    for (var it = 0; it < iters; it++) {
      if (r() < 0.5) p.reverse(), reindex(p, pos);
      var e = p[0], ns = nbrs(n, e), v = ns[(r() * ns.length) | 0];
      k = pos[v];
      if (k <= 1) continue;
      // join e–v and drop the edge p[k-1]–p[k]: reverse the prefix p[0..k-1]
      for (var a = 0, b = k - 1; a < b; a++, b--) { var t = p[a]; p[a] = p[b]; p[b] = t; pos[p[a]] = a; pos[p[b]] = b; }
    }
    return p;
  }
  function reindex(p, pos) { for (var i = 0; i < p.length; i++) pos[p[i]] = i; }

  // per size: [fewest, most] colours, and how long a segment must be before touching itself ends it
  // (bigger grids need more, shorter, never-self-touching paths to stay unique)
  var RANGE = { 5: [4, 7, 0.5], 6: [5, 8, 0.5], 7: [6, 9, 0.25], 8: [7, 11, 0.25], 9: [8, 14, 0], 10: [9, 16, 0] };
  function colourRange(n) { return RANGE[clampN(n)]; }

  // Cut a Hamiltonian path into segments of length ≥ 3; end a segment early
  // rather than let it touch itself (a self-touching path invites shortcuts).
  function cutPath(n, p, r, target) {
    var tf = colourRange(n)[2];
    var N = p.length, segs = [], cur = [p[0]], mark = new Int32Array(N), sid = 1, want = segLen(r, target);
    mark[p[0]] = sid;
    for (var i = 1; i < N; i++) {
      var x = p[i], last = cur[cur.length - 1], touch = false, ns = nbrs(n, x);
      for (var j = 0; j < ns.length; j++) if (ns[j] !== last && mark[ns[j]] === sid) { touch = true; break; }
      if (((touch && cur.length >= want * tf) || cur.length >= want) && cur.length >= 3 && N - i >= 3) {
        segs.push(cur); cur = []; sid++; want = segLen(r, target);
      }
      cur.push(x); mark[x] = sid;
    }
    if (cur.length < 3 && segs.length) segs[segs.length - 1] = segs[segs.length - 1].concat(cur);
    else segs.push(cur);
    return segs;
  }
  function segLen(r, target) { return Math.max(3, Math.round(target * (0.55 + r() * 0.9))); }

  // Count full-fill solutions (up to `limit`) by depth-first search. Every
  // colour grows from its first dot; each node branches on the most constrained
  // head (fewest legal steps). Prunings: no empty cell with fewer than two open
  // sides, every empty region must touch a growing head, and each head must
  // still share a region with (or touch) its target dot. Returns -1 when the
  // node budget runs out (unknown).
  function countSolutions(puz, limit, budget) {
    var n = puz.n, N = n * n, k = puz.pairs.length, o = new Int16Array(N), NB = [], i, c;
    for (i = 0; i < N; i++) { o[i] = -1; NB.push(nbrs(n, i)); }
    var head = new Int32Array(k), tgt = new Int32Array(k), done = new Int8Array(k), live = new Int16Array(N);
    for (c = 0; c < k; c++) { o[puz.pairs[c].a] = c; o[puz.pairs[c].b] = c; head[c] = puz.pairs[c].a; tgt[c] = puz.pairs[c].b; }
    // live[z] = 1 + colour when z is an unfinished head or target (an "open" side for its neighbours)
    for (c = 0; c < k; c++) { live[head[c]] = c + 1; live[tgt[c]] = c + 1; }
    var reg = new Int32Array(N), stack = new Int32Array(N), stamp = 0, sols = 0, nodes = 0, empty = N - 2 * k, left = k;
    var touchH = new Int32Array(N + 1), touchT = new Int32Array(N + 1);
    function check() {
      var a, b, z, m, y;
      // dead cells
      for (z = 0; z < N; z++) {
        if (o[z] !== -1) continue;
        m = NB[z]; var f = 0;
        for (b = 0; b < m.length; b++) { y = m[b]; if (o[y] === -1 || live[y]) f++; }
        if (f < 2) return false;
      }
      // regions: label them, note which heads / targets touch each
      var base = stamp;
      for (z = 0; z < N; z++) {
        if (o[z] !== -1 || reg[z] > base) continue;
        var id = ++stamp, sp = 0, touched = false;
        stack[sp++] = z; reg[z] = id;
        while (sp) {
          var q = stack[--sp]; m = NB[q];
          for (b = 0; b < m.length; b++) {
            y = m[b];
            if (o[y] === -1) { if (reg[y] !== id) { reg[y] = id; stack[sp++] = y; } }
            else if (live[y] && head[live[y] - 1] === y && !done[live[y] - 1]) touched = true;
          }
        }
        if (!touched) return false;
      }
      // each growing head must reach its target: adjacent, or through a common region
      for (a = 0; a < k; a++) {
        if (done[a]) continue;
        var h = head[a], t = tgt[a], mh = NB[h], mt = NB[t], ok = false;
        for (b = 0; b < mh.length && !ok; b++) if (mh[b] === t) ok = true;
        for (b = 0; b < mh.length && !ok; b++) {
          y = mh[b];
          if (o[y] !== -1 || reg[y] <= base) continue;
          for (var e = 0; e < mt.length; e++) if (o[mt[e]] === -1 && reg[mt[e]] === reg[y]) { ok = true; break; }
        }
        if (!ok) return false;
      }
      return true;
    }
    function options(a) {
      var h = head[a], m = NB[h], cnt = 0;
      for (var b = 0; b < m.length; b++) if (o[m[b]] === -1 || m[b] === tgt[a]) cnt++;
      return cnt;
    }
    function rec() {
      if (sols >= limit || nodes > budget) return;
      nodes++;
      if (!left) { if (!empty) sols++; return; }
      var bc = -1, bo = 9;
      for (var a = 0; a < k; a++) if (!done[a]) { var op = options(a); if (op < bo) { bo = op; bc = a; } }
      if (bo === 0) return;
      var h = head[bc], m = NB[h];
      for (var b = 0; b < m.length; b++) {
        var x = m[b];
        if (x === tgt[bc]) {
          done[bc] = 1; left--; live[h] = 0; live[x] = 0;
          if (!left ? !empty : check()) rec();
          done[bc] = 0; left++; live[h] = bc + 1; live[x] = bc + 1;
        } else if (o[x] === -1) {
          o[x] = bc; head[bc] = x; empty--; live[h] = 0; live[x] = bc + 1;
          if (check()) rec();
          o[x] = -1; head[bc] = h; empty++; live[x] = 0; live[h] = bc + 1;
        }
        if (sols >= limit || nodes > budget) return;
      }
    }
    if (check()) rec();
    return nodes > budget ? -1 : sols;
  }

  function md(n, p) { return Math.abs(p.a % n - p.b % n) + Math.abs(((p.a / n) | 0) - ((p.b / n) | 0)); }

  function finish(n, seed, segs) {
    // order the colours by where their first dot appears (reading order); each path starts at its lower dot
    segs = segs.map(function (s) { return s[0] < s[s.length - 1] ? s : s.slice().reverse(); });
    segs.sort(function (s, t) { return s[0] - t[0]; });
    return {
      n: n, seed: seed >>> 0,
      pairs: segs.map(function (s) { return { a: s[0], b: s[s.length - 1] }; }),
      sol: segs
    };
  }
  var GEN_BUDGET = 200000, GEN_TRIES = 200;
  // Generate the puzzle for (n, seed): pairs [{a, b}] and a solution (sol[c] runs a → b).
  // Candidates with a colour count in range are checked by the solver; the first
  // one proven unique wins, else the first one not proven ambiguous, else any.
  function genPuzzle(n, seed) {
    n = clampN(n);
    var r = rng(hash2(n * 7919 + 13, seed >>> 0)), rg = colourRange(n), best = null, bestD = 1e9, unk = null, multi = null;
    for (var att = 0; att < GEN_TRIES; att++) {
      var p = hamPath(n, r), target = (n * n) / (rg[0] + 1.5 + r() * (rg[1] - rg[0] - 1)), segs = cutPath(n, p, r, target);
      var d = segs.length < rg[0] ? rg[0] - segs.length : segs.length > rg[1] ? segs.length - rg[1] : 0;
      if (d < bestD) { best = segs; bestD = d; }
      if (d || segs.length > MAX_COL) continue;
      var cand = finish(n, seed, segs), cnt = countSolutions(cand, 2, GEN_BUDGET);
      if (cnt === 1) { cand.unique = true; return cand; }
      if (cnt < 0 && !unk) unk = cand;
      if (cnt === 2 && !multi) multi = cand;
    }
    if (unk || multi) return unk || multi;
    while (best.length > MAX_COL) {          // never happens in practice; keep the letters A–P
      var a2 = best.pop(); best[best.length - 1] = best[best.length - 1].concat(a2);
    }
    return finish(n, seed, best);
  }

  // Sanity check a puzzle + its solution (used by tests and for defensive loads).
  function checkSolution(puz, paths) {
    var n = puz.n, N = n * n, seen = new Int8Array(N), cnt = 0;
    if (!paths || paths.length !== puz.pairs.length) return false;
    for (var c = 0; c < paths.length; c++) {
      var s = paths[c], pr = puz.pairs[c];
      if (!s || s.length < 2) return false;
      var e0 = s[0], e1 = s[s.length - 1];
      if (!((e0 === pr.a && e1 === pr.b) || (e0 === pr.b && e1 === pr.a))) return false;
      for (var i = 0; i < s.length; i++) {
        if (!(s[i] >= 0 && s[i] < N) || seen[s[i]]) return false;
        if (i && !adj(n, s[i - 1], s[i])) return false;
        seen[s[i]] = 1; cnt++;
      }
    }
    return cnt === N;
  }

  // ---- level ids, packs, daily ----
  function packSeed(n, lvl) { return hash2(clampN(n) * 1000 + (lvl | 0), 0xF10F); }
  function pad2(v) { return (v < 10 ? '0' : '') + v; }
  function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDay(k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function dailySpec(key) {
    var d = parseDay(key) || new Date(2026, 0, 1), num = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    return { n: DAILY_SIZES[d.getDay()], seed: hash2(num, 0xDA11) };
  }
  // id: 'p<n>-<lvl>' for a pack level, 'd<YYYY-MM-DD>' for a daily
  function specOf(id) {
    var m = /^p(\d+)-(\d+)$/.exec(id || '');
    if (m && +m[1] >= MIN_N && +m[1] <= MAX_N && +m[2] >= 1 && +m[2] <= PACK_LEN) return { id: id, kind: 'p', n: +m[1], lvl: +m[2], seed: packSeed(+m[1], +m[2]) };
    m = /^d(\d{4}-\d{2}-\d{2})$/.exec(id || '');
    if (m && parseDay(m[1])) { var ds = dailySpec(m[1]); return { id: id, kind: 'd', day: m[1], n: ds.n, seed: ds.seed }; }
    return null;
  }
  function puzzleFor(id) { var s = specOf(id); return s ? genPuzzle(s.n, s.seed) : null; }

  // ---- a game in progress ----
  function newGame(puz) {
    var N = puz.n * puz.n, endC = new Int16Array(N), k = puz.pairs.length, paths = [];
    for (var i = 0; i < N; i++) endC[i] = -1;
    for (var c = 0; c < k; c++) { endC[puz.pairs[c].a] = c; endC[puz.pairs[c].b] = c; paths.push([]); }
    return { puz: puz, n: puz.n, k: k, endC: endC, paths: paths, moves: 0, last: -1, undo: [], drag: null, hints: 0, hinted: [], won: false, ev: [], owner: null };
  }
  function clonePaths(ps) { return ps.map(function (p) { return p.slice(); }); }
  function otherEnd(g, c, e) { var pr = g.puz.pairs[c]; return e === pr.a ? pr.b : pr.a; }
  function isDone(g, c) {
    var p = g.paths[c];
    if (p.length < 2) return false;
    var pr = g.puz.pairs[c], a = p[0], b = p[p.length - 1];
    return (a === pr.a && b === pr.b) || (a === pr.b && b === pr.a);
  }
  // owner grid: the colour covering each cell (dots always belong to their colour), −1 empty
  function owners(g) {
    var N = g.n * g.n, o = new Int16Array(N), c, i;
    for (i = 0; i < N; i++) o[i] = g.endC[i];
    for (c = 0; c < g.k; c++) for (i = 0; i < g.paths[c].length; i++) o[g.paths[c][i]] = c;
    return o;
  }
  function status(g) {
    var o = owners(g), filled = 0, done = 0;
    for (var i = 0; i < o.length; i++) if (o[i] >= 0) filled++;
    for (var c = 0; c < g.k; c++) if (isDone(g, c)) done++;
    return { done: done, total: g.k, filled: filled, cells: o.length, pct: Math.round(filled * 100 / o.length), won: done === g.k && filled === o.length };
  }

  // Start a drag at a cell: a dot (re)starts its colour from there; a path cell grabs that path there.
  function beginDrag(g, cell) {
    if (g.won || g.drag || !(cell >= 0 && cell < g.n * g.n)) return false;
    var c = g.endC[cell], path;
    if (c >= 0) path = [cell];
    else {
      for (var d = 0; d < g.k && c < 0; d++) {
        var j = g.paths[d].indexOf(cell);
        if (j >= 0) { c = d; path = g.paths[d].slice(0, j + 1); }
      }
      if (c < 0) return false;
    }
    g.drag = { c: c, base: clonePaths(g.paths), path: path, wasDone: isDone(g, c), snapMoves: g.moves, snapLast: g.last };
    applyDrag(g);
    return true;
  }
  // Rebuild g.paths from the drag's base: the active path, and every other path cut where it is crossed.
  function applyDrag(g) {
    var D = g.drag, set = {}, i;
    for (i = 0; i < D.path.length; i++) set[D.path[i]] = 1;
    for (var d = 0; d < g.k; d++) {
      if (d === D.c) { g.paths[d] = D.path.length > 1 ? D.path.slice() : []; continue; }
      var bp = D.base[d], k = -1;
      for (i = 0; i < bp.length; i++) if (set[bp[i]]) { k = i; break; }
      var np = k < 0 ? bp.slice() : bp.slice(0, k);
      g.paths[d] = np.length > 1 ? np : [];
    }
  }
  // One step of the drag to an edge-adjacent cell: 'ok' | 'back' | 'block' | 'same'.
  function stepTo(g, cell) {
    var D = g.drag;
    if (!D) return 'block';
    var p = D.path, head = p[p.length - 1];
    if (cell === head) return 'same';
    if (!adj(g.n, head, cell)) return 'block';
    var j = p.indexOf(cell);
    if (j >= 0) { D.path = p.slice(0, j + 1); applyDrag(g); return 'back'; }
    if (p.length > 1 && g.endC[head] === D.c) return 'block';            // already joined: only back up
    var e = g.endC[cell];
    if (e >= 0 && e !== D.c) return 'block';                            // another colour's dot
    var was = D.path.length > 1 && g.endC[D.path[D.path.length - 1]] === D.c;
    p.push(cell); applyDrag(g);
    if (!was && e === D.c) g.ev.push({ t: 'join', c: D.c, cell: cell });
    return 'ok';
  }
  // Drag towards any cell: back up straight to it if it is on the path, else walk there one cell at a time.
  function dragToward(g, cell) {
    var D = g.drag;
    if (!D || !(cell >= 0 && cell < g.n * g.n)) return 'block';
    var j = D.path.indexOf(cell);
    if (j >= 0) {
      if (j === D.path.length - 1) return 'same';
      D.path = D.path.slice(0, j + 1); applyDrag(g); return 'back';
    }
    var n = g.n, res = 'same';
    for (var guard = 0; guard < 4 * n; guard++) {
      var h = D.path[D.path.length - 1];
      if (h === cell) break;
      var hx = h % n, hy = (h / n) | 0, tx = cell % n, ty = (cell / n) | 0, dx = tx - hx, dy = ty - hy;
      var sx = dx ? h + (dx > 0 ? 1 : -1) : -1, sy = dy ? h + (dy > 0 ? n : -n) : -1;
      var first = Math.abs(dx) >= Math.abs(dy) ? sx : sy, second = first === sx ? sy : sx, r = 'block';
      if (first >= 0) r = stepTo(g, first);
      if (r === 'block' && second >= 0) r = stepTo(g, second);
      if (r === 'block') { if (res === 'same') res = 'block'; break; }
      res = r;
    }
    return res;
  }
  function samePaths(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) return false;
      for (var j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
    }
    return true;
  }
  // Finish the drag: count the move, keep an undo step, check for the win.
  function endDrag(g) {
    var D = g.drag;
    if (!D) return { changed: false };
    g.drag = null;
    var changed = !samePaths(D.base, g.paths);
    if (changed) {
      g.undo.push({ paths: D.base, moves: D.snapMoves, last: D.snapLast });
      if (g.undo.length > 300) g.undo.shift();
      if (D.c !== g.last) g.moves++;
      g.last = D.c;
      var st = status(g);
      if (st.won && !g.won) { g.won = true; g.ev.push({ t: 'win' }); }
    }
    return { changed: changed, c: D.c, done: isDone(g, D.c) };
  }
  function cancelDrag(g) {
    var D = g.drag;
    if (!D) return;
    g.paths = D.base; g.drag = null;
  }
  function undo(g) {
    if (g.drag) cancelDrag(g);
    var u = g.undo.pop();
    if (!u) return false;
    g.paths = u.paths; g.moves = u.moves; g.last = u.last; g.won = false;
    return true;
  }
  function restart(g) {
    if (g.drag) cancelDrag(g);
    var empty = g.paths.every(function (p) { return !p.length; });
    if (empty) return false;
    g.undo.push({ paths: clonePaths(g.paths), moves: g.moves, last: g.last });
    for (var c = 0; c < g.k; c++) g.paths[c] = [];
    g.won = false;
    return true;
  }
  function pathKey(p) { return p.slice().sort(function (a, b) { return a - b; }).join(','); }
  // Reveal one path from the solution: the first colour whose path isn't already the solution's.
  function hint(g) {
    if (g.won) return -1;
    if (g.drag) endDrag(g);
    var sol = g.puz.sol, c = -1, i;
    for (i = 0; i < g.k; i++) if (!(isDone(g, i) && pathKey(g.paths[i]) === pathKey(sol[i]))) { c = i; break; }
    if (c < 0) return -1;
    var base = clonePaths(g.paths), set = {};
    for (i = 0; i < sol[c].length; i++) set[sol[c][i]] = 1;
    for (var d = 0; d < g.k; d++) {
      if (d === c) { g.paths[d] = sol[c].slice(); continue; }
      var bp = base[d], k = -1;
      for (i = 0; i < bp.length; i++) if (set[bp[i]]) { k = i; break; }
      var np = k < 0 ? bp : bp.slice(0, k);
      g.paths[d] = np.length > 1 ? np : [];
    }
    g.undo.push({ paths: base, moves: g.moves, last: g.last });
    g.hints++;
    if (g.hinted.indexOf(c) < 0) g.hinted.push(c);
    g.ev.push({ t: 'join', c: c, cell: sol[c][sol[c].length - 1], hint: true });
    if (status(g).won) { g.won = true; g.ev.push({ t: 'win' }); }
    return c;
  }
  // stars: 3 = perfect (one move per pair, no hints), 2 = a few extra moves, 1 = solved
  function starsFor(moves, k, hints) {
    if (hints > 0) return 1;
    if (moves <= k) return 3;
    if (moves <= k + Math.max(2, Math.ceil(k / 3))) return 2;
    return 1;
  }

  // ---- in-progress snapshots (validated on load) ----
  function serialize(g) { return { paths: clonePaths(g.paths), moves: g.moves, last: g.last, hints: g.hints }; }
  function validPath(g, c, p) {
    if (!Array.isArray(p) || p.length < 2 || p.length > g.n * g.n) return false;
    if (g.endC[p[0]] !== c) return false;
    for (var i = 0; i < p.length; i++) {
      if (typeof p[i] !== 'number' || !(p[i] >= 0 && p[i] < g.n * g.n) || p[i] % 1) return false;
      if (i && !adj(g.n, p[i - 1], p[i])) return false;
      if (i && g.endC[p[i]] >= 0 && (g.endC[p[i]] !== c || i !== p.length - 1)) return false;
      if (p.indexOf(p[i]) !== i) return false;
    }
    return true;
  }
  function restore(g, data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.paths)) return false;
    var used = {}, ok = 0;
    for (var c = 0; c < g.k; c++) {
      var p = data.paths[c];
      if (!validPath(g, c, p)) continue;
      if (p.some(function (x) { return used[x]; })) continue;
      p.forEach(function (x) { used[x] = 1; });
      g.paths[c] = p.slice(); ok++;
    }
    g.moves = Math.max(0, Math.min(9999, data.moves | 0));
    g.last = (data.last | 0) >= 0 && (data.last | 0) < g.k ? data.last | 0 : -1;
    g.hints = Math.max(0, Math.min(99, data.hints | 0));
    g.won = status(g).won;
    return ok > 0;
  }

  // ---- the save ----
  function newSave() { return { v: 1, lv: {}, daily: {}, cur: 'p5-1', prog: null, wip: {}, solved: 0, perfect: 0, hints: 0 }; }
  var WIP_MAX = 12;
  function normProg(id, p) {
    if (!p || typeof p !== 'object' || !specOf(id) || !Array.isArray(p.paths)) return null;
    return { id: id, paths: p.paths.slice(0, MAX_COL), moves: Math.max(0, p.moves | 0), last: p.last | 0, hints: Math.max(0, p.hints | 0), t: Math.max(0, +p.t || 0) };
  }
  // Park the current board's progress when switching puzzles (a few boards are kept, oldest dropped).
  function stashProg(save) {
    var p = save.prog;
    save.prog = null;
    if (!p || !p.id || !p.paths || !p.paths.some(function (x) { return x && x.length; })) return;
    delete save.wip[p.id];
    save.wip[p.id] = p;
    var ks = Object.keys(save.wip);
    while (ks.length > WIP_MAX) delete save.wip[ks.shift()];
  }
  // Take a parked board back (it becomes the live progress again).
  function takeProg(save, id) {
    var p = save.wip[id] || null;
    delete save.wip[id];
    return p;
  }
  function normRec(r) {
    if (!r || typeof r !== 'object') return null;
    var m = r.m | 0, s = r.s | 0, t = +r.t || 0;
    if (m < 1 || m > 9999) return null;
    return { m: m, s: s < 1 ? 1 : s > 3 ? 3 : s, t: t > 0 && t < 864000 ? Math.round(t) : 0 };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    var k;
    if (o.lv && typeof o.lv === 'object') for (k in o.lv) {
      if (!Object.prototype.hasOwnProperty.call(o.lv, k) || !specOf(k) || specOf(k).kind !== 'p') continue;
      var r = normRec(o.lv[k]);
      if (r) s.lv[k] = r;
    }
    if (o.daily && typeof o.daily === 'object') for (k in o.daily) {
      if (!Object.prototype.hasOwnProperty.call(o.daily, k) || !parseDay(k)) continue;
      var rd = normRec(o.daily[k]);
      if (rd) s.daily[k] = rd;
    }
    if (typeof o.cur === 'string' && specOf(o.cur)) s.cur = o.cur;
    if (o.prog && typeof o.prog === 'object' && typeof o.prog.id === 'string' && specOf(o.prog.id) && o.prog.id === s.cur && Array.isArray(o.prog.paths)) {
      s.prog = normProg(o.prog.id, o.prog);
    }
    if (o.wip && typeof o.wip === 'object') for (k in o.wip) {
      if (!Object.prototype.hasOwnProperty.call(o.wip, k) || k === s.cur || Object.keys(s.wip).length >= WIP_MAX) continue;
      var wp = normProg(k, o.wip[k]);
      if (wp) s.wip[k] = wp;
    }
    s.solved = Math.max(0, o.solved | 0);
    s.perfect = Math.max(0, o.perfect | 0);
    s.hints = Math.max(0, o.hints | 0);
    return s;
  }
  // A level is open while fewer than OPEN_AHEAD levels before it are unsolved.
  function isOpen(save, n, lvl) {
    var miss = 0;
    for (var l = 1; l < lvl; l++) if (!save.lv['p' + n + '-' + l]) miss++;
    return miss < OPEN_AHEAD;
  }
  function packCount(save, n) {
    var c = 0, st = 0;
    for (var l = 1; l <= PACK_LEN; l++) { var r = save.lv['p' + n + '-' + l]; if (r) { c++; st += r.s; } }
    return { solved: c, stars: st };
  }
  // The next level to play after `id` in its pack: first unsolved open one after it, else after the start.
  function nextLevel(save, id) {
    var sp = specOf(id);
    if (!sp || sp.kind !== 'p') return null;
    var l;
    for (l = sp.lvl + 1; l <= PACK_LEN; l++) if (!save.lv['p' + sp.n + '-' + l] && isOpen(save, sp.n, l)) return 'p' + sp.n + '-' + l;
    for (l = 1; l <= PACK_LEN; l++) if (!save.lv['p' + sp.n + '-' + l] && isOpen(save, sp.n, l)) return 'p' + sp.n + '-' + l;
    if (sp.lvl < PACK_LEN) return 'p' + sp.n + '-' + (sp.lvl + 1);
    var ni = SIZES.indexOf(sp.n) + 1;
    return ni < SIZES.length ? 'p' + SIZES[ni] + '-1' : null;
  }
  // Record a solve; returns { rec, best, first } for the results card.
  function record(save, id, moves, k, hints, secs) {
    var sp = specOf(id);
    if (!sp) return null;
    var tbl = sp.kind === 'p' ? save.lv : save.daily, key = sp.kind === 'p' ? id : sp.day, old = tbl[key];
    var rec = { m: Math.max(1, moves | 0), s: starsFor(moves, k, hints), t: Math.max(0, Math.round(secs || 0)) };
    var out = { rec: rec, old: old || null, first: !old, best: false };
    if (!old) { tbl[key] = rec; save.solved++; out.best = true; }
    else {
      var nb = { m: Math.min(old.m, rec.m), s: Math.max(old.s, rec.s), t: old.t && rec.t ? Math.min(old.t, rec.t) : (old.t || rec.t) };
      out.best = rec.m < old.m || rec.s > old.s;
      tbl[key] = nb;
    }
    if (rec.s === 3 && (!old || old.s < 3)) save.perfect++;
    if (hints) save.hints += hints;
    return out;
  }
  // Days in a row with a solved daily, ending today (or yesterday, if today is still open).
  function streak(save, todayKey) {
    var d = parseDay(todayKey);
    if (!d) return 0;
    if (!save.daily[todayKey]) d.setDate(d.getDate() - 1);
    var n = 0;
    while (save.daily[dayKey(d)] && n < 4000) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  var ENGINE = {
    MIN_N: MIN_N, MAX_N: MAX_N, PACK_LEN: PACK_LEN, MAX_COL: MAX_COL, SIZES: SIZES, OPEN_AHEAD: OPEN_AHEAD,
    rng: rng, hash2: hash2, nbrs: nbrs, adj: adj, hamPath: hamPath, cutPath: cutPath, colourRange: colourRange,
    genPuzzle: genPuzzle, countSolutions: countSolutions, checkSolution: checkSolution, packSeed: packSeed, dayKey: dayKey, parseDay: parseDay,
    dailySpec: dailySpec, specOf: specOf, puzzleFor: puzzleFor,
    newGame: newGame, owners: owners, status: status, isDone: isDone, otherEnd: otherEnd,
    beginDrag: beginDrag, stepTo: stepTo, dragToward: dragToward, endDrag: endDrag, cancelDrag: cancelDrag,
    undo: undo, restart: restart, hint: hint, starsFor: starsFor, serialize: serialize, restore: restore,
    newSave: newSave, normSave: normSave, stashProg: stashProg, takeProg: takeProg, isOpen: isOpen, packCount: packCount, nextLevel: nextLevel, record: record, streak: streak
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('flowlines.css');

  var PANEL_ID = 'flowlines-panel', NAME = 'Flow Lines';
  var KEY = 'cade-flowlines-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var LETTERS = 'ABCDEFGHIJKLMNOP';
  // 16 hues, each [light theme, dark theme]: distinct, readable on --bg in both themes
  var HUES = [
    ['#d64545', '#ff6b6b'], ['#2f6fd6', '#5b9dff'], ['#2e9e4f', '#5fd47c'], ['#c99a06', '#f5d142'],
    ['#e0702a', '#ff9a4d'], ['#1b9fb5', '#4fd6e8'], ['#c23fa8', '#f07ad8'], ['#7451c9', '#a88bf5'],
    ['#8f5b34', '#c99466'], ['#13876f', '#3fc7a6'], ['#e0607e', '#ff9eb5'], ['#7a9e12', '#b8e04a'],
    ['#34488f', '#8fa4f0'], ['#9c2f3f', '#d8707f'], ['#5d6b7a', '#a7b4c2'], ['#8a7a2a', '#d1c06a']
  ];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.flowlines = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtTime(s) { s = Math.max(0, Math.round(s || 0)); var m = (s / 60) | 0; return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function starStr(n, tot) { var o = ''; for (var i = 0; i < (tot || 3); i++) o += i < n ? '*' : '.'; return o; }
  function today() { return dayKey(new Date()); }
  function dayLabel(k) { var d = parseDay(k); return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() : k; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

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
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>');
  var IC_RESET = svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>');
  var IC_HINT = svg('<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>');
  var IC_MENU = svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
  var IC_NEXT = svg('<path d="M5 12h14M13 6l6 6-6 6"/>');

  // ---- theme colours (derived from the app's CSS variables) ----
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
    var fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35)), bd = parseCol(v('--border'), mix(bg, tx, 0.15));
    var hue = HUES.map(function (h) { return parseCol(h[dark ? 1 : 0]); });
    S.dark = dark;
    S.col = {
      bg: css(bg), bgA: bg, text: css(tx), faint: css(fa), grid: css(mix(bg, bd, dark ? 0.9 : 1)), dot: css(mix(bg, fa, 0.75)),
      acc: css(ac), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      hue: hue.map(function (h) { return css(h); }),
      tint: hue.map(function (h) { return css(mix(bg, h, dark ? 0.2 : 0.14)); }),
      tintDone: hue.map(function (h) { return css(mix(bg, h, dark ? 0.32 : 0.24)); }),
      ink: hue.map(function (h) { var l = 0.2126 * h[0] + 0.7152 * h[1] + 0.0722 * h[2]; return l > 150 ? '#1b1b1b' : '#ffffff'; })
    };
    buildAtlas();
  }

  // ---- glyph atlas: each dot (disc + letter) and the spark glyphs, rendered once per size/theme ----
  var SPARKS = '*+.o';
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.col || !S.cell) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    var cp = Math.ceil(S.cell * S.k), cols = 16, rows = 1 + SPARKS.length;
    a.cp = cp;
    a.cv.width = cp * cols; a.cv.height = cp * rows;
    var c = a.cv.getContext('2d'), r = cp * 0.36;
    c.clearRect(0, 0, a.cv.width, a.cv.height);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (var i = 0; i < 16; i++) {
      var x = i * cp + cp / 2, y = cp / 2;
      c.fillStyle = S.col.hue[i];
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = S.col.ink[i];
      c.font = '700 ' + (cp * 0.42).toFixed(2) + 'px ' + S.col.font;
      c.fillText(LETTERS.charAt(i), x, y + cp * 0.02);
      c.font = '700 ' + (cp * 0.5).toFixed(2) + 'px ' + S.col.font;
      c.fillStyle = S.col.hue[i];
      for (var j = 0; j < SPARKS.length; j++) c.fillText(SPARKS.charAt(j), x, (j + 1) * cp + cp / 2);
    }
  }
  function stamp(c, row, ci, x, y, sc, alpha) {
    var a = S.atl, w = (row ? Math.min(S.cell, 48) : S.cell) * (sc || 1);
    if (alpha != null) c.globalAlpha = alpha;
    c.drawImage(a.cv, ci * a.cp, row * a.cp, a.cp, a.cp, x - w / 2, y - w / 2, w, w);
    if (alpha != null) c.globalAlpha = 1;
  }

  // ---- loading a puzzle ----
  function loadPuzzle(id, prog) {
    var sp = specOf(id) || specOf('p5-1');
    var puz = genPuzzle(sp.n, sp.seed), g = newGame(puz);
    if (prog && prog.id === sp.id) { restore(g, prog); S.tAcc = prog.t || 0; } else S.tAcc = 0;
    S.id = sp.id; S.spec = sp; S.g = g; S.lastAct = 0; S.reveal = null; S.win = null; S.fx.length = 0; S.pulses.length = 0;
    S.cur = S.cur && S.cur < puz.n * puz.n ? S.cur : 0;
    S.save.cur = sp.id;
    S.save.prog = prog && prog.id === sp.id ? prog : null;
    persist();
    layout(); readTheme(); syncHud(); draw();
  }
  function saveProg() {
    var g = S.g;
    if (g.won) S.save.prog = null;
    else {
      var p = serialize(g);
      p.id = S.id; p.t = Math.round(S.tAcc);
      S.save.prog = p;
    }
    persist();
  }
  function act() {
    var t = Date.now();
    if (S.lastAct) S.tAcc += Math.min(20, (t - S.lastAct) / 1000);
    S.lastAct = t;
  }

  // ---- HUD ----
  function recOf(id) {
    var sp = specOf(id);
    if (!sp) return null;
    return sp.kind === 'p' ? S.save.lv[id] : S.save.daily[sp.day];
  }
  function syncHud() {
    var g = S.g, st = status(g), sp = S.spec, rec = recOf(S.id);
    var title = sp.kind === 'p' ? '<b>' + sp.n + 'x' + sp.n + '</b> <span>level ' + sp.lvl + '</span>' : '<b>Daily</b> <span>' + dayLabel(sp.day) + ' · ' + sp.n + 'x' + sp.n + '</span>';
    if (rec) title += ' <i class="fl-st s' + rec.s + '">' + starStr(rec.s) + '</i>';
    S.hudL.innerHTML = title;
    S.hudR.innerHTML = 'moves <b>' + g.moves + '</b> <span>/ par ' + g.k + '</span>' + (rec ? ' <span>· best ' + rec.m + '</span>' : '');
    var W = 14, fill = Math.round(st.filled / st.cells * W), bar = '';
    for (var i = 0; i < W; i++) bar += i < fill ? '#' : '-';
    S.bar.innerHTML = '<span>flows <b>' + st.done + '/' + st.total + '</b></span><span class="fl-pipe">[<i>' + bar.slice(0, fill) + '</i>' + bar.slice(fill) + '] <b>' + st.pct + '%</b></span>';
    var un = S.pad.querySelector('[data-act="undo"]'), hi = S.pad.querySelector('[data-act="hint"]'), rs = S.pad.querySelector('[data-act="reset"]');
    if (un) un.disabled = !g.undo.length || g.won;
    if (hi) hi.disabled = g.won;
    if (rs) rs.disabled = g.won || g.paths.every(function (p) { return !p.length; });
    S.cv.setAttribute('aria-label', 'Flow Lines board, ' + g.n + ' by ' + g.n + ', ' + g.k + ' pairs; ' + st.done + ' joined, ' + st.pct + '% filled. Arrow keys move, Space grabs and drops a path.');
  }
  function say(t) { if (S && S.live) S.live.textContent = t; }
  function setPad() {
    var won = S.g && S.g.won, kb = !S.coarse;
    function b(a, ic, lab, k, cls) { return '<button type="button" class="fl-btn' + (cls ? ' ' + cls : '') + '" data-act="' + a + '" title="' + lab + (kb && k ? ' (' + k + ')' : '') + '">' + ic + '<span>' + lab + '</span></button>'; }
    S.pad.innerHTML = won
      ? b('menu', IC_MENU, 'Levels', 'L') + b('next', IC_NEXT, S.spec.kind === 'd' ? 'Levels' : 'Next', 'N', 'go')
      : b('undo', IC_UNDO, 'Undo', 'U') + b('reset', IC_RESET, 'Clear', 'R') + b('hint', IC_HINT, 'Hint', 'H') + b('menu', IC_MENU, 'Levels', 'L');
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 210 : 230);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 50) + (S.hud.offsetHeight || 40) + 50;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    if (!S || !S.g) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var maxW = phone ? vw - 34 : solo ? 640 : 440;
    var B = Math.floor(Math.max(240, Math.min(maxW, availH(vw, vh))));
    if (phone) B = Math.min(B, vw - 34);
    var n = S.g.n, dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = B + 'px'; S.cv.style.height = B + 'px';
    S.stage.style.width = B + 'px'; S.stage.style.height = B + 'px';
    S.panel.style.setProperty('--fl-w', B + 'px');
    S.cv.width = Math.round(B * dpr); S.cv.height = Math.round(B * dpr);
    S.B = B; S.k = S.cv.width / B; S.pad0 = 4; S.cell = (B - 2 * S.pad0) / n;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) buildAtlas();
  }

  // ---- drawing ----
  function cx(i) { return S.pad0 + (i % S.g.n + 0.5) * S.cell; }
  function cy(i) { return S.pad0 + (((i / S.g.n) | 0) + 0.5) * S.cell; }
  function draw() {
    if (!S || !S.ctx || !S.col || !S.g) return;
    var c = S.ctx, g = S.g, n = g.n, N = n * n, cell = S.cell, P = S.pad0, col = S.col, t = now(), i, p;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = col.bg; c.fillRect(0, 0, S.B, S.B);
    var own = owners(g), done = [];
    for (i = 0; i < g.k; i++) done.push(isDone(g, i));
    var drawn = new Int8Array(N);
    for (i = 0; i < g.k; i++) for (p = 0; p < g.paths[i].length; p++) drawn[g.paths[i][p]] = 1;
    var rv = S.reveal, rvN = -1;
    if (rv) {
      var f = Math.min(1, (t - rv.t0) / rv.dur);
      rvN = Math.max(1, Math.ceil(f * g.paths[rv.c].length));
      if (f >= 1) S.reveal = rv = null;
    }
    // win ripple: a wave of light along every path
    var W = S.win, wv = null;
    if (W) { wv = (t - W.t0) / 1000; }
    // cell tints
    for (i = 0; i < N; i++) {
      var o = own[i];
      if (o < 0 || !drawn[i]) continue;
      if (rv && rv.c === o && g.paths[o].indexOf(i) >= rvN) continue;
      var x0 = P + (i % n) * cell, y0 = P + ((i / n) | 0) * cell;
      c.fillStyle = done[o] ? col.tintDone[o] : col.tint[o];
      c.fillRect(x0 + 0.5, y0 + 0.5, cell - 1, cell - 1);
      if (wv != null) {
        var d = W.dist[i], a = 1 - Math.abs(wv * 14 - d) / 3;
        if (a > 0) { c.globalAlpha = a * 0.55; c.fillStyle = col.hue[o]; c.fillRect(x0 + 0.5, y0 + 0.5, cell - 1, cell - 1); c.globalAlpha = 1; }
      }
    }
    // the grid: thin lines and a faint dot in every empty cell (the glyph look)
    c.strokeStyle = col.grid; c.lineWidth = 1 / S.k * Math.max(1, Math.round(S.k * 0.75));
    c.beginPath();
    for (i = 1; i < n; i++) {
      var q = Math.round((P + i * cell) * S.k) / S.k + 0.5 / S.k;
      c.moveTo(q, P); c.lineTo(q, P + n * cell);
      c.moveTo(P, q); c.lineTo(P + n * cell, q);
    }
    c.stroke();
    c.fillStyle = col.dot; c.font = '600 ' + (cell * 0.36).toFixed(1) + 'px ' + col.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (i = 0; i < N; i++) if (own[i] < 0) c.fillText('.', cx(i), cy(i) - cell * 0.08);
    // the paths
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (i = 0; i < g.k; i++) {
      var ph = g.paths[i], m = ph.length;
      if (rv && rv.c === i) m = Math.min(m, rvN);
      if (m < 2) continue;
      c.strokeStyle = col.hue[i]; c.lineWidth = cell * (g.drag && g.drag.c === i ? 0.34 : 0.3);
      c.beginPath(); c.moveTo(cx(ph[0]), cy(ph[0]));
      for (p = 1; p < m; p++) c.lineTo(cx(ph[p]), cy(ph[p]));
      c.stroke();
    }
    // sparks (under the dots, so they never smudge a letter)
    for (i = 0; i < S.fx.length; i++) { var s = S.fx[i]; stamp(c, 1 + s.g, s.c, s.x, s.y, s.sc, Math.max(0, Math.min(1, s.life / s.l0 * 1.4))); }
    // the dots
    for (i = 0; i < g.k; i++) {
      var pr = g.puz.pairs[i];
      [pr.a, pr.b].forEach(function (e) {
        var sc = 1;
        if (W && wv != null) { var dd = W.dist[e], k2 = 1 - Math.abs(wv * 14 - dd) / 2.5; if (k2 > 0) sc += 0.18 * k2; }
        stamp(c, 0, i, cx(e), cy(e), sc);
        if (done[i]) {
          c.strokeStyle = col.hue[i]; c.lineWidth = Math.max(1.5, cell * 0.05);
          c.beginPath(); c.arc(cx(e), cy(e), cell * 0.43, 0, Math.PI * 2); c.stroke();
        }
      });
    }
    // the drag's head
    if (g.drag) {
      var dp = g.drag.path, hd = dp[dp.length - 1];
      c.fillStyle = col.hue[g.drag.c];
      c.beginPath(); c.arc(cx(hd), cy(hd), cell * 0.2, 0, Math.PI * 2); c.fill();
      if (S.finger && S.coarse) {   // the touch "lens": a soft disc under the finger in the path's colour
        c.globalAlpha = 0.22; c.beginPath(); c.arc(S.finger.x, S.finger.y, Math.max(cell * 0.85, 30), 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
      }
    }
    // pulses (a dot joined) and sparks
    for (i = S.pulses.length - 1; i >= 0; i--) {
      var pu = S.pulses[i], u = (t - pu.t0) / 520;
      if (u >= 1) { S.pulses.splice(i, 1); continue; }
      c.strokeStyle = col.hue[pu.c]; c.globalAlpha = 1 - u; c.lineWidth = Math.max(1.5, cell * 0.07 * (1 - u));
      c.beginPath(); c.arc(cx(pu.cell), cy(pu.cell), cell * (0.38 + 0.5 * u), 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
    }
    // keyboard cursor
    if (S.kbd && !S.ovlOn) {
      var kx = P + (S.cur % n) * cell, ky = P + ((S.cur / n) | 0) * cell;
      c.strokeStyle = col.acc; c.lineWidth = 2; c.setLineDash([4, 3]);
      c.strokeRect(kx + 2, ky + 2, cell - 4, cell - 4); c.setLineDash([]);
    }
  }
  function busy() { return S && (S.fx.length || S.pulses.length || S.reveal || (S.win && !S.win.over)); }
  function kick() { if (S && !S.raf && busy()) { S.last = now(); S.raf = requestAnimationFrame(frame); } }
  function frame() {
    if (!S) return;
    S.raf = 0;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = now(), dt = Math.min(0.05, (t - S.last) / 1000);
    S.last = t;
    for (var i = S.fx.length - 1; i >= 0; i--) {
      var s = S.fx[i];
      s.life -= dt;
      if (s.life <= 0) { S.fx.splice(i, 1); continue; }
      s.vy += 380 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.985;
    }
    if (S.win && !S.win.over && (t - S.win.t0) / 1000 > S.win.len) S.win.over = true;
    draw();
    if (busy()) S.raf = requestAnimationFrame(frame);
  }
  function burst(cell, c, k, spd) {
    if (S.rm) return;
    for (var j = 0; j < k; j++) {
      var a = Math.random() * Math.PI * 2, v = (spd || 120) * (0.4 + Math.random());
      // sparks start on the dot's rim so they never smudge its letter
      S.fx.push({ x: cx(cell) + Math.cos(a) * S.cell * 0.46, y: cy(cell) + Math.sin(a) * S.cell * 0.46, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 90, c: c, g: (Math.random() * SPARKS.length) | 0, sc: 0.6 + Math.random() * 0.45, life: 0.55 + Math.random() * 0.5, l0: 1 });
    }
    if (S.fx.length > 400) S.fx.splice(0, S.fx.length - 400);
  }
  function drainEvents() {
    var g = S.g, ev = g.ev.splice(0, g.ev.length);
    ev.forEach(function (e) {
      if (e.t === 'join') {
        var pr = g.puz.pairs[e.c];
        S.pulses.push({ cell: pr.a, c: e.c, t0: now() }, { cell: pr.b, c: e.c, t0: now() });
        burst(e.cell, e.c, 10, 110);
        S.snd.tone(523 + (e.c % 5) * 40, 0.08, 'triangle', 0.05); S.snd.tone(784 + (e.c % 5) * 60, 0.14, 'triangle', 0.045, 0, 0.06);
        if (Cade.haptic) Cade.haptic(10);
        say(LETTERS.charAt(e.c) + ' joined');
      } else if (e.t === 'win') startWin();
    });
    kick();
  }

  // ---- the win ----
  function startWin() {
    var g = S.g, N = g.n * g.n, dist = new Float32Array(N), i, p;
    // the wave runs along each path from its first dot
    for (i = 0; i < g.k; i++) for (p = 0; p < g.paths[i].length; p++) dist[g.paths[i][p]] = p;
    S.win = { t0: now(), dist: dist, len: (g.n * 1.6 + 6) / 14, over: false };
    act();
    var res = record(S.save, S.id, g.moves, g.k, g.hints, S.tAcc);
    S.result = res;
    S.save.prog = null; delete S.save.wip[S.id];
    if (S.spec.kind === 'p') { var nx = nextLevel(S.save, S.id); S.nextId = nx; }
    persist();
    for (i = 0; i < g.k; i++) { burst(g.puz.pairs[i].a, i, 7, 170); burst(g.puz.pairs[i].b, i, 7, 170); }
    [523, 659, 784, 1047, 1319].forEach(function (f, j) { S.snd.tone(f, 0.16, 'triangle', 0.05, 0, j * 0.08); });
    if (Cade.haptic) Cade.haptic(25);
    say('Solved in ' + g.moves + ' moves');
    setPad(); syncHud();
    clearTimeout(S.winT);
    S.winT = setTimeout(function () { if (S && S.g === g && g.won && !S.ovlOn) showCard('win'); }, S.rm ? 150 : 1000);
    kick();
  }

  // ---- cards ----
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml() : kind === 'win' ? winHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.ovlOn = !!kind;
    S.stage.classList.toggle('dim', !!kind);
    if (kind) {
      S.ovl.scrollTop = 0;
      var f = S.ovl.querySelector('[data-focus]');
      if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    } else if (!S.coarse) { try { S.cv.focus({ preventScroll: true }); } catch (e) {} }
    draw();
  }
  function helpHtml() {
    var kb = !S.coarse;
    return '<div class="fl-card" role="dialog" aria-label="How to play">' +
      '<div class="fl-title">FLOW LINES</div>' +
      '<pre class="fl-art" aria-hidden="true">' +
      '<i class="h0">A</i><i class="h0">===</i><i class="h0">+</i>  <i class="h1">B</i>\n' +
      '    <i class="h0">|</i>  <i class="h1">|</i>\n' +
      '<i class="h2">C</i>   <i class="h0">A</i>  <i class="h1">|</i>\n' +
      '<i class="h2">|</i>      <i class="h1">|</i>\n' +
      '<i class="h2">+</i><i class="h2">===</i><i class="h2">C</i>  <i class="h1">B</i></pre>' +
      '<p>Join every pair of matching <b>letters</b> with a path. Paths turn at right angles, may <b>not cross</b>, and the puzzle is solved only when <b>every cell</b> is filled.</p>' +
      '<p><b>Drag</b> from a dot to draw. Drag over a path to <b>cut</b> it (back up and it comes back). Grab a path anywhere to change it from there.</p>' +
      '<p>A <b>move</b> is drawing with a different colour than last time: one move per pair is <b>perfect</b> (***). Hints reveal one path but cost the stars.</p>' +
      (kb ? '<div class="fl-keys"><span><b>arrows</b> move · <b>space</b> grab / drop</span><span><b>U</b> undo · <b>R</b> clear · <b>H</b> hint · <b>L</b> levels</span></div>' : '') +
      '<button type="button" class="fl-go" data-act="close" data-focus>' + (S.g && S.g.moves ? 'Back to the puzzle' : 'Let’s play') + '</button></div>';
  }
  function winHtml() {
    var g = S.g, r = S.result || { rec: { m: g.moves, s: 1, t: 0 }, old: null, best: false, first: true }, sp = S.spec;
    var perfect = r.rec.s === 3;
    var head = perfect ? 'PERFECT' : 'SOLVED';
    var sub = sp.kind === 'p' ? sp.n + 'x' + sp.n + ' · level ' + sp.lvl : 'Daily · ' + dayLabel(sp.day);
    var note = r.first ? (sp.kind === 'd' ? 'daily streak ' + streak(S.save, today()) + ' day' + (streak(S.save, today()) === 1 ? '' : 's') : 'first clear') :
      r.best ? 'new best!' : 'best ' + r.old.m + ' moves';
    var nxt = sp.kind === 'p' && S.nextId ? '<button type="button" class="fl-go" data-act="next" data-focus>Next puzzle ' + (specOf(S.nextId).n !== sp.n ? '(' + specOf(S.nextId).n + 'x' + specOf(S.nextId).n + ')' : '') + '</button>' : '';
    return '<div class="fl-card" role="dialog" aria-label="Solved">' +
      '<div class="fl-title">' + head + '</div>' +
      '<div class="fl-sub">' + esc(sub) + '</div>' +
      '<div class="fl-stars s' + r.rec.s + '" aria-label="' + r.rec.s + ' of 3 stars">' + starStr(r.rec.s).split('').join(' ') + '</div>' +
      '<pre class="fl-tab">moves  <b>' + g.moves + '</b>  <i>par ' + g.k + '</i>\ntime   <b>' + fmtTime(S.tAcc) + '</b>' + (g.hints ? '\nhints  <b>' + g.hints + '</b>' : '') + '</pre>' +
      '<div class="fl-new' + (r.best && !r.first ? ' hot' : '') + '">' + esc(note) + '</div>' +
      (nxt || '<button type="button" class="fl-go" data-act="menu" data-focus>' + (sp.kind === 'd' ? 'More puzzles' : 'Levels') + '</button>') +
      '<div class="fl-btns">' + (nxt ? '<button type="button" class="fl-go alt" data-act="menu">Levels</button>' : '') +
      '<button type="button" class="fl-go alt" data-act="replay">Play again</button></div></div>';
  }
  function menuHtml() {
    var sv = S.save, tab = S.tab, h = '<div class="fl-card wide" role="dialog" aria-label="Levels">' +
      '<div class="fl-title">FLOW LINES</div>' +
      '<div class="fl-tabs" role="tablist">' +
      ['packs', 'daily', 'stats'].map(function (t) {
        return '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + (tab === t) + '" class="' + (tab === t ? 'on' : '') + '">' + (t === 'packs' ? 'Packs' : t === 'daily' ? 'Daily' : 'Stats') + '</button>';
      }).join('') + '</div>';
    if (tab === 'packs') {
      var pn = S.packN;
      h += '<div class="fl-chips">' + SIZES.map(function (n) {
        var pc = packCount(sv, n);
        return '<button type="button" class="fl-chip' + (n === pn ? ' on' : '') + '" data-pack="' + n + '">' + n + 'x' + n + ' <i>' + pc.solved + '/' + PACK_LEN + '</i></button>';
      }).join('') + '</div><div class="fl-grid">';
      for (var l = 1; l <= PACK_LEN; l++) {
        var id = 'p' + pn + '-' + l, r = sv.lv[id], open = isOpen(sv, pn, l), curr = id === S.id;
        h += '<button type="button" class="fl-lv' + (r ? ' done s' + r.s : '') + (open ? '' : ' locked') + (curr ? ' cur' : '') + '" data-lvl="' + id + '"' +
          (open ? '' : ' aria-disabled="true"') + ' aria-label="Level ' + l + (r ? ', solved, ' + r.s + ' stars' : open ? '' : ', locked') + '"' + (curr ? ' data-focus' : '') + '>' +
          '<b>' + l + '</b><i>' + (r ? starStr(r.s) : !open ? '#' : (sv.wip[id] || (sv.prog && sv.prog.id === id && !curr)) ? '~' : '') + '</i></button>';
      }
      h += '</div><div class="fl-note">' + packCount(sv, pn).stars + ' / ' + PACK_LEN * 3 + ' stars · solve levels to open the next ones</div>';
    } else if (tab === 'daily') {
      var tk = today(), ds = dailySpec(tk), tr = sv.daily[tk], st = streak(sv, tk);
      h += '<div class="fl-big">' + esc(dayLabel(tk)) + '</div>' +
        '<div class="fl-sub">today: ' + ds.n + 'x' + ds.n + ' · streak <b>' + st + '</b> day' + (st === 1 ? '' : 's') + '</div>' +
        (tr ? '<div class="fl-sub">solved in <b>' + tr.m + '</b> moves · <span class="fl-st s' + tr.s + '">' + starStr(tr.s) + '</span> · ' + fmtTime(tr.t) + '</div>' : '') +
        '<button type="button" class="fl-go" data-lvl="d' + tk + '" data-focus>' + (tr ? 'Play today’s again' : S.id === 'd' + tk && S.g.moves ? 'Continue today’s' : 'Play today’s puzzle') + '</button>' +
        '<div class="fl-h">this week</div><div class="fl-week">';
      var d = parseDay(tk);
      for (var k = 6; k >= 0; k--) {
        var dd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - k), key = dayKey(dd), rr = sv.daily[key];
        h += '<button type="button" class="fl-day' + (rr ? ' done' : '') + (k === 0 ? ' today' : '') + '" data-lvl="d' + key + '" aria-label="' + dayLabel(key) + (rr ? ', solved' : '') + '">' +
          '<i>' + 'SMTWTFS'.charAt(dd.getDay()) + '</i><b>' + (rr ? '#' : k === 0 ? '?' : '.') + '</b><i>' + dd.getDate() + '</i></button>';
      }
      h += '</div><div class="fl-note">a new puzzle every day, the same for everyone</div>';
    } else {
      var rows = SIZES.map(function (n) {
        var pc = packCount(sv, n), w = 10, f = pc.solved ? Math.max(1, Math.round(pc.solved / PACK_LEN * w)) : 0, bar = '';
        for (var i = 0; i < w; i++) bar += i < f ? '#' : '-';
        return n + 'x' + n + (n < 10 ? '   ' : ' ') + '[<span class="g">' + bar.slice(0, f) + '</span>' + bar.slice(f) + '] <b>' + (pc.solved < 10 ? ' ' : '') + pc.solved + '</b>/' + PACK_LEN + ' <i>' + pc.stars + '*</i>';
      }).join('\n');
      var dn = Object.keys(sv.daily).length;
      h += '<pre class="fl-tab">' + rows + '</pre>' +
        '<pre class="fl-tab">solved   <b>' + sv.solved + '</b>\nperfect  <b>' + sv.perfect + '</b>\ndailies  <b>' + dn + '</b>  <i>streak ' + streak(sv, today()) + '</i>\nhints    <b>' + sv.hints + '</b></pre>' +
        (S.resetArm
          ? '<div class="fl-foot"><span class="fl-confirm">Erase all progress?</span><span><button type="button" class="fl-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="fl-lnk" data-act="reset-no">Keep</button></span></div>'
          : '<div class="fl-foot"><span></span><button type="button" class="fl-lnk" data-act="reset-all">Reset progress</button></div>');
    }
    h += '<button type="button" class="fl-go alt" data-act="close">' + (S.g && S.g.won ? 'Close' : 'Back to the puzzle') + '</button></div>';
    return h;
  }
  function openMenu() {
    if (S.g && S.g.drag) finishDrag();
    S.tab = S.tab || 'packs'; S.resetArm = false;
    S.packN = S.spec.kind === 'p' ? S.spec.n : (S.packN || 5);
    showCard('menu');
  }
  function goLevel(id, replay) {
    var sp = specOf(id);
    if (!sp) return;
    if (sp.kind === 'p' && !isOpen(S.save, sp.n, sp.lvl)) {
      Cade.showToast && Cade.showToast('Locked — solve earlier levels in this pack first', 'info', 1800);
      S.snd.tone(150, 0.08, 'square', 0.02);
      return;
    }
    clearTimeout(S.winT);
    if (id === S.id && !replay && !(S.g && S.g.won)) { showCard(null); return; }
    var prog = null;
    if (id === S.id) S.save.prog = null;            // play again: a fresh board
    else {
      if (S.g && !S.g.won) saveProg();
      stashProg(S.save);                            // park this board, pick up the other one where it was left
      prog = replay ? null : takeProg(S.save, id);
      if (replay) delete S.save.wip[id];
    }
    loadPuzzle(id, prog);
    setPad(); syncHud(); showCard(null);
    S.snd.tone(660, 0.06, 'sine', 0.035);
    say((sp.kind === 'p' ? sp.n + ' by ' + sp.n + ' level ' + sp.lvl : 'Daily puzzle') + ', ' + S.g.k + ' pairs');
  }

  // ---- input ----
  function cellAt(e) {
    var r = S.cv.getBoundingClientRect(), sc = S.B / (r.width || S.B);
    var x = (e.clientX - r.left) * sc, y = (e.clientY - r.top) * sc, n = S.g.n;
    var gx = Math.floor((x - S.pad0) / S.cell), gy = Math.floor((y - S.pad0) / S.cell);
    gx = gx < 0 ? 0 : gx >= n ? n - 1 : gx; gy = gy < 0 ? 0 : gy >= n ? n - 1 : gy;
    return { cell: gy * n + gx, x: x, y: y };
  }
  function startDrag(cell) {
    var g = S.g;
    if (g.won || S.ovlOn) return false;
    if (!beginDrag(g, cell)) { S.snd.tone(140, 0.05, 'square', 0.015); return false; }
    act();
    S.snd.tone(392, 0.04, 'triangle', 0.035);
    syncHud(); draw();
    return true;
  }
  function moveDrag(cell) {
    var g = S.g;
    if (!g.drag) return;
    var before = g.drag.path.length, r = dragToward(g, cell);
    if (r === 'ok') S.snd.tone(300 + Math.min(40, g.drag.path.length) * 18, 0.035, 'triangle', 0.025);
    else if (r === 'back' && g.drag.path.length < before) S.snd.tone(250, 0.03, 'sine', 0.02);
    else if (r === 'block' && now() - (S.blockT || 0) > 220) { S.blockT = now(); S.snd.tone(110, 0.05, 'square', 0.012); }
    if (r !== 'same') { syncHud(); drainEvents(); draw(); }
  }
  function finishDrag() {
    var g = S.g;
    if (!g.drag) return;
    var res = endDrag(g);
    S.finger = null;
    if (res.changed) { act(); saveProg(); }
    syncHud(); drainEvents(); draw();
  }
  function doUndo() {
    if (!S.g || S.g.won) return;
    if (undo(S.g)) { S.snd.tone(330, 0.07, 'sine', 0.035, 220); act(); saveProg(); say('Undone'); }
    syncHud(); draw();
  }
  function doReset() {
    if (!S.g || S.g.won) return;
    if (restart(S.g)) { S.snd.tone(440, 0.12, 'sine', 0.035, 180); act(); saveProg(); say('Board cleared — undo brings it back'); }
    syncHud(); draw();
  }
  function doHint() {
    var g = S.g;
    if (!g || g.won) return;
    var c = hint(g);
    if (c < 0) return;
    act();
    S.reveal = { c: c, t0: now(), dur: S.rm ? 1 : 420 };
    S.snd.tone(440, 0.18, 'sine', 0.04, 880);
    say('Hint: ' + LETTERS.charAt(c) + ' revealed');
    saveProg(); syncHud();
    drainEvents();
    draw(); kick();
  }
  function padAction(a) {
    if (!S) return;
    S.snd.ensure();
    if (a === 'undo') doUndo();
    else if (a === 'reset') doReset();
    else if (a === 'hint') doHint();
    else if (a === 'menu') openMenu();
    else if (a === 'next') { if (S.spec.kind === 'p' && S.nextId) goLevel(S.nextId, true); else { S.tab = 'daily'; openMenu(); } }
  }
  function onKey(e) {
    if (!S || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var t = e.target, k = e.key, g = S.g;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.altKey || e.metaKey || (e.ctrlKey && !(k === 'z' || k === 'Z'))) return;
    if (k === 'Escape') {
      if (g.drag) { finishDrag(); e.preventDefault(); e.stopPropagation(); return; }
      if (S.ovlOn && S.cardKind !== 'win') { showCard(null); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (S.ovlOn) {
      if (S.cardKind === 'win' && (k === 'n' || k === 'N')) { padAction('next'); e.preventDefault(); }
      return;
    }
    var n = g.n, x = S.cur % n, y = (S.cur / n) | 0, mv = null;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') mv = [-1, 0];
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') mv = [1, 0];
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') mv = [0, -1];
    else if (k === 'ArrowDown' || k === 's' || k === 'S') mv = [0, 1];
    if (mv) {
      e.preventDefault();
      S.kbd = true;
      var nx = Math.max(0, Math.min(n - 1, x + mv[0])), ny = Math.max(0, Math.min(n - 1, y + mv[1])), nc = ny * n + nx;
      if (g.drag) {
        moveDrag(nc);
        var dp = g.drag.path; S.cur = dp[dp.length - 1];
      } else S.cur = nc;
      draw();
      return;
    }
    if (k === ' ' || k === 'Enter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t) && t !== S.cv) return;
      e.preventDefault(); S.kbd = true; S.snd.ensure();
      if (g.drag) finishDrag();
      else if (!g.won) startDrag(S.cur);
      else padAction('next');
      draw();
      return;
    }
    if (t && t.tagName === 'BUTTON' && t !== S.cv && (k === 'Enter')) return;
    var lk = k.toLowerCase();
    if (lk === 'u' || lk === 'z' || k === 'Backspace') { e.preventDefault(); doUndo(); }
    else if (lk === 'r') { e.preventDefault(); doReset(); }
    else if (lk === 'h') { e.preventDefault(); doHint(); }
    else if (lk === 'l' || lk === 'm') { e.preventDefault(); openMenu(); }
    else if (lk === 'n' && g.won) { e.preventDefault(); padAction('next'); }
    else if (k === '?') { e.preventDefault(); showCard('help'); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.winT);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (S && S.g && S.g.drag) finishDrag();
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
    var body = '<div class="fl"><div class="fl-hud"><div class="fl-hl"></div><div class="fl-hr"></div></div>' +
      '<div class="fl-bar"></div>' +
      '<div class="fl-stage"><canvas class="fl-cv" tabindex="0" role="img"></canvas><div class="fl-ovl" style="display:none"></div></div>' +
      '<div class="fl-pad"></div><div class="fl-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '〰️ Flow Lines', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'fl-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.fl-stage'), cv: p.querySelector('.fl-cv'), ovl: p.querySelector('.fl-ovl'),
      pad: p.querySelector('.fl-pad'), hud: p.querySelector('.fl-hud'), hudL: p.querySelector('.fl-hl'), hudR: p.querySelector('.fl-hr'),
      bar: p.querySelector('.fl-bar'), live: p.querySelector('.fl-live'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      fx: [], pulses: [], raf: 0, last: 0, col: null, atl: null, k: 1, B: 300, cell: 30, pad0: 4,
      g: null, id: null, spec: null, cur: 0, kbd: false, ovlOn: false, cardKind: null, tab: 'packs', packN: 5, tAcc: 0, lastAct: 0, ptr: null
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    loadPuzzle(S.save.cur, S.save.prog);
    setPad(); syncHud(); syncHead();

    S.onVis = function () { if (document.hidden && S && S.g && S.g.drag) finishDrag(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S && S.g && S.g.drag) finishDrag(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      if (S.g.drag) finishDrag();
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
      S.lastAct = 0;
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); draw(); kick();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); draw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); draw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound (the header drags the panel — these are controls)
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
        if (S.g.drag) finishDrag();
        showCard(S.cardKind === 'help' ? (S.g.won ? 'win' : null) : 'help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Fast taps must never zoom, select, magnify or open a callout: CSS does most of it; the board
    // cancels its touches outright and the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && !b.disabled) { noTouch(e); b.click(); }
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the board: drag paths
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0 || S.ovlOn) return;
      e.preventDefault();
      S.snd.ensure();
      if (!S.coarse) { try { S.cv.focus({ preventScroll: true }); } catch (er) {} }
      S.kbd = false;
      if (S.g.drag) finishDrag();
      var at = cellAt(e);
      S.cur = at.cell;
      if (startDrag(at.cell)) {
        S.ptr = e.pointerId; S.finger = { x: at.x, y: at.y };
        try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
        draw();
      } else draw();
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || S.ptr !== e.pointerId || !S.g.drag) return;
      var at = cellAt(e);
      S.finger = { x: at.x, y: at.y };
      moveDrag(at.cell);
      if (S.coarse) draw();
    });
    function up(e) {
      if (!S || S.ptr !== e.pointerId) return;
      S.ptr = null;
      finishDrag();
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, up); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && !b.disabled) padAction(b.getAttribute('data-act'));
    });
    p.addEventListener('keydown', onKey);
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var a = b.getAttribute('data-act'), tab = b.getAttribute('data-tab'), pk = b.getAttribute('data-pack'), lv = b.getAttribute('data-lvl');
      if (tab) { S.tab = tab; S.resetArm = false; showCard('menu'); S.snd.tone(700, 0.03, 'sine', 0.025); refocus('[data-tab="' + tab + '"]', e); }
      else if (pk) { S.packN = +pk; showCard('menu'); S.snd.tone(760, 0.03, 'sine', 0.025); refocus('[data-pack="' + pk + '"]', e); }
      else if (lv) goLevel(lv, false);
      else if (a === 'close') showCard(null);
      else if (a === 'menu') openMenu();
      else if (a === 'next') padAction('next');
      else if (a === 'replay') goLevel(S.id, true);
      else if (a === 'reset-all') { S.resetArm = true; showCard('menu'); }
      else if (a === 'reset-no') { S.resetArm = false; showCard('menu'); }
      else if (a === 'reset-yes') {
        S.save = newSave(); persist(); S.resetArm = false; S.tab = 'packs'; S.packN = 5;
        Cade.showToast && Cade.showToast('Progress reset', 'info', 1800);
        loadPuzzle('p5-1', null); setPad(); syncHud(); showCard('menu');
      }
    });
    function refocus(sel, e) {
      if (e.detail !== 0) return;
      var nb = S.ovl.querySelector(sel);
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
    }

    if (ld.fresh) showCard('help');
    else if (!S.coarse) { try { S.cv.focus({ preventScroll: true }); } catch (e) {} }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); draw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { buildAtlas(); draw(); } }, function () {});
      }
    } catch (e) {}
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

  Cade.registerWidget({
    name: NAME,
    description: 'Join matching dots with paths that fill the grid without crossing — generated levels, daily',
    icon: '〰️',
    tags: 'game,puzzle,logic,flow,lines,connect,daily,pipes,paths,dots,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
