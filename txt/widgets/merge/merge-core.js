/* Merge core — the DOM-free logic behind the Sync Conflict merge screen.
 *
 * When a device comes back online holding offline edits and the server moved
 * on too, txt.html hands three texts here: the BASE (the last text this device
 * knew to be in sync — `cade-room-synced:<room>`), MINE (the editor now) and
 * THEIRS (the server now). merge3() diffs base→mine and base→theirs by line
 * and walks the two hunk lists together, the way diff3 / git do:
 *   - a region only one side changed is applied automatically ("auto");
 *   - a region both sides changed the same way is taken once ("auto", both);
 *   - two different insertions at the same point keep both ("auto", union);
 *   - anything else — both sides changed the same lines differently — is a
 *     "conflict" chunk the user decides (trimmed to the lines that differ).
 * merge2() is the no-base fallback (legacy rooms): every difference is a
 * conflict.
 *
 * The result is a list of chunks. applyChoices() turns it plus the user's
 * per-chunk choices (mine / theirs / base / both in either order / per-line
 * selection / hand-edited text) back into a document. alignChunk() pairs a
 * chunk's two sides line by line for the per-line picker, and wordDiff()
 * marks the changed words inside a pair of lines.
 *
 * Line diff: patience (anchor on lines unique to both sides, recurse between
 * the anchors) with Myers O(ND) for regions without anchors; Myers gives up
 * past MAX_D edits and reports the region as one replaced block, so a huge
 * rewrite costs bounded time. CRLF: lines are compared and emitted without
 * their \r; the result uses CRLF when MINE (or, if mine is one line, THEIRS)
 * mostly does.
 *
 * UMD: window.__cadeMergeCore in the page (and in the merge worker via
 * importScripts), module.exports in node (merge.test.js). */
(function (root) {
  'use strict';

  var MAX_D = 1200;            // Myers edit-distance budget per anchorless region
  var WORD_MAX = 4000;         // longer lines aren't word-diffed (marked whole)

  // ---- lines -------------------------------------------------------------------
  function splitLines(text) {
    var raw = String(text == null ? '' : text).split('\n');
    var crlf = 0;
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (s.length && s.charCodeAt(s.length - 1) === 13) { raw[i] = s.slice(0, -1); if (i < raw.length - 1) crlf++; }
    }
    return { lines: raw, crlf: crlf, breaks: raw.length - 1 };
  }
  function eolOf(primary, secondary) {
    var p = primary.breaks ? primary : secondary;
    return p && p.breaks && p.crlf * 2 > p.breaks ? '\r\n' : '\n';
  }

  // ---- diff ----------------------------------------------------------------------
  // ops: { t: '=' | '~', a0, a1, b0, b1 } covering both sequences in order.
  function pushOp(out, t, a0, a1, b0, b1) {
    if (t === '~' && a0 === a1 && b0 === b1) return;
    if (t === '=' && a0 === a1) return;
    var last = out[out.length - 1];
    if (last && last.t === t && last.a1 === a0 && last.b1 === b0) { last.a1 = a1; last.b1 = b1; return; }
    out.push({ t: t, a0: a0, a1: a1, b0: b0, b1: b1 });
  }

  function lis(seq) {
    var piles = [], idx = [], back = new Array(seq.length);
    for (var i = 0; i < seq.length; i++) {
      var v = seq[i], lo = 0, hi = piles.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (piles[mid] < v) lo = mid + 1; else hi = mid; }
      piles[lo] = v; idx[lo] = i; back[i] = lo > 0 ? idx[lo - 1] : -1;
    }
    var out = [], k = piles.length ? idx[piles.length - 1] : -1;
    while (k >= 0) { out.push(k); k = back[k]; }
    return out.reverse();
  }

  // Myers' greedy O(ND) diff over A[a0,a1) × B[b0,b1); false when the edit
  // distance exceeds maxD (caller reports the block as replaced).
  function myers(A, B, a0, a1, b0, b1, out, maxD) {
    var n = a1 - a0, m = b1 - b0, max = Math.min(n + m, maxD), off = max + 1;
    var v = new Int32Array(2 * max + 3), trace = [], d, k, x, y, found = -1;
    v[off + 1] = 0;
    for (d = 0; d <= max; d++) {
      for (k = -d; k <= d; k += 2) {
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        y = x - k;
        while (x < n && y < m && A[a0 + x] === B[b0 + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
      trace.push(v.slice(off - d - 1, off + d + 2));   // window [-d-1, d+1]
      if (found >= 0) break;
    }
    if (found < 0) return false;
    // Backtrack: trace[d - 1] holds V_{d-1} at index k + d.
    var rev = [];
    x = n; y = m;
    for (d = found; d > 0; d--) {
      var w = trace[d - 1];
      k = x - y;
      var down = k === -d || (k !== d && w[k - 1 + d] < w[k + 1 + d]);
      var pk = down ? k + 1 : k - 1, px = w[pk + d], py = px - pk;
      var sx = down ? px : px + 1;             // where the snake after the edit starts
      while (x > sx) { x--; y--; rev.push(['=', x, y]); }
      if (down) rev.push(['+', px, py]); else rev.push(['-', px, py]);
      x = px; y = py;
    }
    while (x > 0) { x--; y--; rev.push(['=', x, y]); }
    for (var i = rev.length - 1; i >= 0; i--) {
      var e = rev[i];
      if (e[0] === '=') pushOp(out, '=', a0 + e[1], a0 + e[1] + 1, b0 + e[2], b0 + e[2] + 1);
      else if (e[0] === '-') pushOp(out, '~', a0 + e[1], a0 + e[1] + 1, b0 + e[2], b0 + e[2]);
      else pushOp(out, '~', a0 + e[1], a0 + e[1], b0 + e[2], b0 + e[2] + 1);
    }
    return true;
  }

  function patience(A, B, a0, a1, b0, b1, out, depth, maxD) {
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) { pushOp(out, '=', a0, a0 + 1, b0, b0 + 1); a0++; b0++; }
    var e1 = a1, f1 = b1;
    while (e1 > a0 && f1 > b0 && A[e1 - 1] === B[f1 - 1]) { e1--; f1--; }
    if (a0 === e1 || b0 === f1) pushOp(out, '~', a0, e1, b0, f1);
    else {
      var cA = new Map(), cB = new Map(), i, j;
      for (i = a0; i < e1; i++) cA.set(A[i], (cA.get(A[i]) || 0) + 1);
      for (j = b0; j < f1; j++) cB.set(B[j], (cB.get(B[j]) || 0) + 1);
      var posB = new Map();
      for (j = b0; j < f1; j++) if (cB.get(B[j]) === 1 && cA.get(B[j]) === 1) posB.set(B[j], j);
      var pairs = [];
      for (i = a0; i < e1; i++) if (cA.get(A[i]) === 1 && posB.has(A[i])) pairs.push([i, posB.get(A[i])]);
      var run = lis(pairs.map(function (p) { return p[1]; })).map(function (k) { return pairs[k]; });
      if (!run.length || depth > 40) {
        if (!myers(A, B, a0, e1, b0, f1, out, maxD)) pushOp(out, '~', a0, e1, b0, f1);
      } else {
        var ai = a0, bi = b0;
        for (var r = 0; r < run.length; r++) {
          patience(A, B, ai, run[r][0], bi, run[r][1], out, depth + 1, maxD);
          pushOp(out, '=', run[r][0], run[r][0] + 1, run[r][1], run[r][1] + 1);
          ai = run[r][0] + 1; bi = run[r][1] + 1;
        }
        patience(A, B, ai, e1, bi, f1, out, depth + 1, maxD);
      }
    }
    if (e1 < a1) pushOp(out, '=', e1, a1, f1, b1);
  }

  function diffSeq(A, B, maxD) {
    var out = [];
    patience(A, B, 0, A.length, 0, B.length, out, 0, maxD || MAX_D);
    return out;
  }

  // ---- chunks ----------------------------------------------------------------------
  // same:     { type: 'same', lines }
  // auto:     { type: 'auto', kind: 'mine'|'theirs'|'both'|'union', base, mine, theirs }
  // conflict: { type: 'conflict', kind: 'conflict', base (null when two-way), mine, theirs }
  // Every non-same chunk also carries m0 / t0 / b0: its first line (0-based) in
  // mine, theirs and base, for line numbers.
  function sameLines(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function finish(chunks, eol, twoWay) {
    // Merge neighbouring same chunks; number the rest.
    var out = [], m = 0, t = 0, b = 0, conflicts = 0, auto = 0;
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (c.type === 'same') {
        if (!c.lines.length) continue;
        var last = out[out.length - 1];
        if (last && last.type === 'same') { last.lines = last.lines.concat(c.lines); }
        else out.push({ type: 'same', lines: c.lines.slice(), m0: m, t0: t, b0: b });
        m += c.lines.length; t += c.lines.length; b += c.baseLen != null ? c.baseLen : c.lines.length;
        continue;
      }
      c.m0 = m; c.t0 = t; c.b0 = b;
      m += c.mine.length; t += c.theirs.length; b += c.base ? c.base.length : 0;
      c.id = out.length;
      if (c.type === 'conflict') conflicts++; else auto++;
      out.push(c);
    }
    for (var k = 0; k < out.length; k++) out[k].id = k;
    var res = { chunks: out, eol: eol, conflicts: conflicts, auto: auto, twoWay: !!twoWay, merged: null };
    if (!conflicts) res.merged = applyChoices(res, {});
    return res;
  }

  // Split the common head/tail of a conflict's two sides out as same chunks, so
  // only the lines that actually differ are asked about.
  function pushConflict(chunks, base, mine, theirs) {
    var p = 0, n = Math.min(mine.length, theirs.length);
    while (p < n && mine[p] === theirs[p]) p++;
    var s = 0;
    while (s < n - p && mine[mine.length - 1 - s] === theirs[theirs.length - 1 - s]) s++;
    if (p) chunks.push({ type: 'same', lines: mine.slice(0, p), baseLen: 0 });
    chunks.push({ type: 'conflict', kind: 'conflict', base: base, mine: mine.slice(p, mine.length - s), theirs: theirs.slice(p, theirs.length - s) });
    if (s) chunks.push({ type: 'same', lines: mine.slice(mine.length - s), baseLen: 0 });
  }

  function merge3(baseText, mineText, theirsText, opts) {
    opts = opts || {};
    var Bs = splitLines(baseText), Ms = splitLines(mineText), Ts = splitLines(theirsText);
    var B = Bs.lines, eol = eolOf(Ms, Ts);
    function hunks(X, side) {
      var ops = diffSeq(B, X, opts.maxD), out = [];
      for (var i = 0; i < ops.length; i++) {
        var o = ops[i];
        if (o.t !== '=') out.push({ b0: o.a0, b1: o.a1, lines: X.slice(o.b0, o.b1), side: side });
      }
      return out;
    }
    var all = hunks(Ms.lines, 'M').concat(hunks(Ts.lines, 'T'));
    // By position; at one position an insertion sorts before a replaced range
    // (text inserted just above a changed line stays above it), theirs first.
    all.sort(function (p, q) { return p.b0 - q.b0 || p.b1 - q.b1 || (p.side === q.side ? 0 : p.side === 'T' ? -1 : 1); });
    var chunks = [], pos = 0;
    for (var k = 0; k < all.length;) {
      var group = [all[k]], g0 = all[k].b0, g1 = all[k].b1;
      for (k++; k < all.length; k++) {
        var h = all[k];
        var overlaps = (h.b0 < g1 && g0 < h.b1) || (h.b0 === h.b1 && g0 === g1 && h.b0 === g0) ||
          // an insertion strictly inside the group's range
          (h.b0 === h.b1 && h.b0 > g0 && h.b0 < g1);
        if (!overlaps) break;
        group.push(h);
        if (h.b1 > g1) g1 = h.b1;
      }
      if (g0 > pos) chunks.push({ type: 'same', lines: B.slice(pos, g0) });
      var render = function (side) {
        var res = [], i = g0;
        for (var q = 0; q < group.length; q++) {
          var hh = group[q];
          if (hh.side !== side) continue;
          for (; i < hh.b0; i++) res.push(B[i]);
          for (var z = 0; z < hh.lines.length; z++) res.push(hh.lines[z]);
          i = hh.b1;
        }
        for (; i < g1; i++) res.push(B[i]);
        return res;
      };
      var base = B.slice(g0, g1), mine = render('M'), theirs = render('T');
      var sides = {};
      for (var q2 = 0; q2 < group.length; q2++) sides[group[q2].side] = 1;
      if (!sides.T) chunks.push({ type: 'auto', kind: 'mine', base: base, mine: mine, theirs: theirs });
      else if (!sides.M) chunks.push({ type: 'auto', kind: 'theirs', base: base, mine: mine, theirs: theirs });
      else if (sameLines(mine, theirs)) chunks.push({ type: 'auto', kind: 'both', base: base, mine: mine, theirs: theirs });
      else if (g0 === g1) chunks.push({ type: 'auto', kind: 'union', base: base, mine: mine, theirs: theirs });
      else pushConflict(chunks, base, mine, theirs);
      pos = g1;
    }
    if (pos < B.length) chunks.push({ type: 'same', lines: B.slice(pos) });
    return finish(chunks, eol, false);
  }

  // No common ancestor: every difference between the two is the user's call.
  function merge2(mineText, theirsText, opts) {
    opts = opts || {};
    var Ms = splitLines(mineText), Ts = splitLines(theirsText), M = Ms.lines, T = Ts.lines;
    var ops = diffSeq(M, T, opts.maxD), chunks = [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o.t === '=') chunks.push({ type: 'same', lines: M.slice(o.a0, o.a1), baseLen: 0 });
      else chunks.push({ type: 'conflict', kind: 'conflict', base: null, mine: M.slice(o.a0, o.a1), theirs: T.slice(o.b0, o.b1) });
    }
    return finish(chunks, eolOf(Ms, Ts), true);
  }

  // ---- per-line alignment ------------------------------------------------------------
  // segments: { t: '=', mine: [i..], theirs: [j..] } (equal lines, paired) or
  // { t: '~', mine: [i..], theirs: [j..] } (lines only one side has).
  function alignChunk(c) {
    if (c._segs) return c._segs;
    var ops = diffSeq(c.mine, c.theirs), segs = [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], mi = [], ti = [], k;
      for (k = o.a0; k < o.a1; k++) mi.push(k);
      for (k = o.b0; k < o.b1; k++) ti.push(k);
      segs.push({ t: o.t, mine: mi, theirs: ti });
    }
    c._segs = segs;
    return segs;
  }

  // A per-line selection equivalent to a whole-chunk pick.
  function selectionFor(c, pick) {
    var m = [], t = [], i;
    for (i = 0; i < c.mine.length; i++) m.push(pick !== 'theirs');
    for (i = 0; i < c.theirs.length; i++) t.push(pick !== 'mine');
    if (pick === 'theirs') {
      // Lines both sides share are tied to the mine flag; keep them.
      alignChunk(c).forEach(function (s) { if (s.t === '=') s.mine.forEach(function (x) { m[x] = true; }); });
    }
    return { m: m, t: t };
  }

  function defaultChoice(c) {
    if (c.type === 'same') return null;
    if (c.kind === 'mine' || c.kind === 'both') return { pick: 'mine' };
    if (c.kind === 'theirs') return { pick: 'theirs' };
    if (c.kind === 'union') { var s = selectionFor(c, 'all'); return { pick: 'lines', m: s.m, t: s.t, order: 'theirs' }; }
    return null;    // conflicts start unresolved
  }

  // The lines one chunk contributes under `choice` (null → unresolved).
  function resolveChunk(c, choice) {
    if (c.type === 'same') return c.lines;
    if (!choice) return null;
    switch (choice.pick) {
      case 'mine': return c.mine;
      case 'theirs': return c.theirs;
      case 'base': return c.base || [];
      case 'mine-first': return c.mine.concat(c.theirs);
      case 'theirs-first': return c.theirs.concat(c.mine);
      case 'custom': {
        var txt = String(choice.text == null ? '' : choice.text).replace(/\r\n?/g, '\n');
        // An emptied box removes the chunk; otherwise its lines replace it.
        return txt === '' && choice.empty !== 'line' ? [] : txt.split('\n');
      }
      case 'lines': {
        var out = [], segs = alignChunk(c), m = choice.m || [], t = choice.t || [], theirsFirst = choice.order === 'theirs';
        for (var i = 0; i < segs.length; i++) {
          var s = segs[i], k;
          if (s.t === '=') { for (k = 0; k < s.mine.length; k++) if (m[s.mine[k]]) out.push(c.mine[s.mine[k]]); continue; }
          var first = theirsFirst ? 'theirs' : 'mine', second = theirsFirst ? 'mine' : 'theirs';
          var F = first === 'mine' ? m : t, S = first === 'mine' ? t : m;
          for (k = 0; k < s[first].length; k++) if (F[s[first][k]]) out.push(c[first][s[first][k]]);
          for (k = 0; k < s[second].length; k++) if (S[s[second][k]]) out.push(c[second][s[second][k]]);
        }
        return out;
      }
    }
    return null;
  }

  // choices: { [chunkId]: choice } — chunks without an entry use their default.
  // opts.unresolved: 'markers' (git-style <<<<<<< blocks, the default), 'mine'
  // or 'theirs'.
  function applyChoices(res, choices, opts) {
    opts = opts || {};
    var out = [];
    for (var i = 0; i < res.chunks.length; i++) {
      var c = res.chunks[i];
      var ch = choices && Object.prototype.hasOwnProperty.call(choices, c.id) ? choices[c.id] : defaultChoice(c);
      var lines = resolveChunk(c, ch);
      if (lines == null) {
        var u = opts.unresolved || 'markers';
        if (u === 'mine') lines = c.mine;
        else if (u === 'theirs') lines = c.theirs;
        else lines = ['<<<<<<< ' + (opts.mineLabel || 'this device')].concat(c.mine, ['======='], c.theirs, ['>>>>>>> ' + (opts.theirsLabel || 'server')]);
      }
      for (var k = 0; k < lines.length; k++) out.push(lines[k]);
    }
    return out.join(res.eol || '\n');
  }

  function stats(res, choices) {
    var total = 0, done = 0;
    for (var i = 0; i < res.chunks.length; i++) {
      var c = res.chunks[i];
      if (c.type !== 'conflict') continue;
      total++;
      if (choices && choices[c.id] && resolveChunk(c, choices[c.id]) != null) done++;
    }
    return { total: total, resolved: done, remaining: total - done };
  }

  // ---- word diff -------------------------------------------------------------------
  var WORD_RE;
  try { WORD_RE = new RegExp('\\s+|[\\p{L}\\p{N}_]+|[\\s\\S]', 'gu'); }
  catch (e) { WORD_RE = /\s+|[A-Za-z0-9_À-￿]+|[\s\S]/g; }
  function tokens(s) { return String(s).match(WORD_RE) || []; }

  // Changed character ranges [[from, to], …] in a and in b. Whitespace-only
  // tokens never start a range on their own, but runs join across them.
  function wordDiff(a, b) {
    a = String(a); b = String(b);
    if (a === b) return { a: [], b: [] };
    if (a.length > WORD_MAX || b.length > WORD_MAX) return { a: a.length ? [[0, a.length]] : [], b: b.length ? [[0, b.length]] : [] };
    var A = tokens(a), Bt = tokens(b);
    var ops = diffSeq(A, Bt, 600);
    function ranges(T, which) {
      var pos = [0];
      for (var i = 0; i < T.length; i++) pos.push(pos[i] + T[i].length);
      var out = [];
      for (var k = 0; k < ops.length; k++) {
        var o = ops[k];
        if (o.t !== '~') continue;
        var s = which === 'a' ? o.a0 : o.b0, e = which === 'a' ? o.a1 : o.b1;
        if (s === e) continue;
        var from = pos[s], to = pos[e];
        var last = out[out.length - 1];
        if (last && /^\s*$/.test((which === 'a' ? a : b).slice(last[1], from))) last[1] = to;
        else out.push([from, to]);
      }
      return out;
    }
    return { a: ranges(A, 'a'), b: ranges(Bt, 'b') };
  }

  // Similarity in [0, 1] of two lines (shared token share) — the merge screen
  // pairs a removed and an added line for word highlighting only when they
  // look like edits of each other.
  function similarity(a, b) {
    if (a === b) return 1;
    var A = tokens(a), B2 = tokens(b);
    if (!A.length || !B2.length) return 0;
    if (A.length * B2.length > 250000) return 0;
    var ops = diffSeq(A, B2, 400), same = 0;
    for (var i = 0; i < ops.length; i++) if (ops[i].t === '=') for (var k = ops[i].a0; k < ops[i].a1; k++) if (/\S/.test(A[k])) same++;
    var words = function (T) { var n = 0; for (var j = 0; j < T.length; j++) if (/\S/.test(T[j])) n++; return n; };
    var denom = Math.max(words(A), words(B2));
    return denom ? same / denom : 0;
  }

  // Wire format for the worker: chunks without the cached alignment.
  function strip(res) {
    return { chunks: res.chunks.map(function (c) { var o = {}; for (var k in c) if (k !== '_segs') o[k] = c[k]; return o; }),
      eol: res.eol, conflicts: res.conflicts, auto: res.auto, twoWay: res.twoWay, merged: res.merged };
  }

  var api = {
    splitLines: splitLines, diffLines: function (a, b, maxD) { return diffSeq(splitLines(a).lines, splitLines(b).lines, maxD); },
    diffSeq: diffSeq, merge3: merge3, merge2: merge2,
    alignChunk: alignChunk, selectionFor: selectionFor, defaultChoice: defaultChoice,
    resolveChunk: resolveChunk, applyChoices: applyChoices, stats: stats,
    wordDiff: wordDiff, similarity: similarity, strip: strip, MAX_D: MAX_D,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeMergeCore = api;
  // Inside the merge worker: answer { id, op, args } with { id, res } / { id, err }.
  if (root && typeof root.importScripts === 'function' && typeof root.postMessage === 'function' && typeof document === 'undefined') {
    root.onmessage = function (e) {
      var d = e.data || {};
      try {
        var r = d.op === 'merge2' ? merge2(d.args[0], d.args[1]) : merge3(d.args[0], d.args[1], d.args[2]);
        root.postMessage({ id: d.id, res: strip(r) });
      } catch (err) { root.postMessage({ id: d.id, err: String(err && err.message || err) }); }
    };
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));
