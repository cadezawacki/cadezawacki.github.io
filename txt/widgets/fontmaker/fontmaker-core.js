/* Font Maker — the pure part (no DOM): glyph-set bookkeeping, stroke capture
 * maths, stroke → outline, metrics, the OpenType build (with opentype.js passed
 * in), a WOFF wrapper and the text layout used by the image maker.
 * Loaded by fontmaker.js in the page (window.__cadeFontmaker) and by the
 * Node tests (module.exports).
 *
 * Coordinates are font units, y up: unitsPerEm 1000, baseline 0, x-height
 * 480, cap height 700, descender -250. The drawing canvas shows the square
 * VIEW (-100…1100 × -300…900), so a stroke is stored exactly as drawn.
 *
 * A glyph is a list of variants (the user may draw 2–3 versions of a letter);
 * a variant is a list of strokes; a stroke is a flat int array
 * [x0, y0, p0, x1, y1, p1, …] (p = pen pressure 0…100). That is all that is
 * stored and synced — outlines are recomputed from it, so the stroke weight,
 * spacing and slant can change at any time.
 *
 * Stroke → outline: each stroke is smoothed and simplified when the pen lifts.
 * The outline is the union of round-capped, round-joined capsules around the
 * stroke's segments, the radius following the pressure. Rather than offsetting
 * polylines analytically (which self-intersects at tight turns and overlaps
 * where strokes cross), the union's signed distance is sampled on a fine grid
 * (≈5 units) and its zero line traced with marching squares (interpolated, so
 * no stair steps). That gives closed, simple, non-overlapping contours with the
 * right orientation (outer counter-clockwise, holes clockwise — what CFF
 * expects) for any scribble; they are simplified (Douglas–Peucker) and turned
 * into quadratic B-spline curves. */
(function (root) {
  'use strict';

  var EM = 1000;
  var METRICS = { unitsPerEm: EM, ascender: 900, descender: -300, capHeight: 700, xHeight: 480, descLine: -250 };
  var VIEW = { x0: -100, x1: 1100, y0: -300, y1: 900 };
  var DEFAULTS = { weight: 34, spacing: 50, slant: 0, space: 300 };
  var LIMITS = { weight: [12, 90], spacing: [0, 200], slant: [-20, 30], space: [120, 700] };
  var MAX_VARIANTS = 3;

  var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var LOWER = 'abcdefghijklmnopqrstuvwxyz';
  var DIGITS = '0123456789';
  var PUNCT = '.,!?\'"-:;()&@#$%/+=';
  var SETS = [
    { id: 'quick', label: 'A–Z a–z', chars: (UPPER + LOWER).split('') },
    { id: 'digits', label: '0–9', chars: DIGITS.split('') },
    { id: 'punct', label: 'Punctuation', chars: PUNCT.split('') }
  ];
  var ALL = SETS.reduce(function (a, s) { return a.concat(s.chars); }, []);
  var NAMES = {
    '.': 'period', ',': 'comma', '!': 'exclam', '?': 'question', '\'': 'quotesingle', '"': 'quotedbl', '-': 'hyphen',
    ':': 'colon', ';': 'semicolon', '(': 'parenleft', ')': 'parenright', '&': 'ampersand', '@': 'at', '#': 'numbersign',
    '$': 'dollar', '%': 'percent', '/': 'slash', '+': 'plus', '=': 'equal',
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine'
  };
  function glyphName(ch, vi) { return (NAMES[ch] || ch) + (vi ? '.alt' + vi : ''); }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  // ---------------------------------------------------------------- fonts
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function newFont(name) {
    var now = Date.now();
    return { v: 1, id: uid(), name: String(name || 'My Hand').slice(0, 60), created: now, updated: now, sync: false, settings: normSettings({}), glyphs: {} };
  }
  function normSettings(s) {
    s = s || {};
    var o = {};
    for (var k in DEFAULTS) o[k] = clamp(Math.round(num(s[k], DEFAULTS[k])), LIMITS[k][0], LIMITS[k][1]);
    return o;
  }
  function normStroke(s) {
    if (!Array.isArray(s) || s.length < 3) return null;
    var n = s.length - s.length % 3, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var v = Math.round(num(s[i], 0));
      out[i] = i % 3 === 2 ? clamp(v, 0, 100) : clamp(v, -2000, 3000);
    }
    return out;
  }
  // Defensive copy of a font from storage / another device (older code, junk).
  function normFont(f) {
    if (!f || typeof f !== 'object') return null;
    var o = { v: 1, id: String(f.id || uid()).slice(0, 40), name: String(f.name || 'My Hand').slice(0, 60), created: num(f.created, Date.now()), updated: num(f.updated, Date.now()), sync: !!f.sync, settings: normSettings(f.settings), glyphs: {} };
    var g = f.glyphs || {};
    ALL.forEach(function (ch) {
      if (!Array.isArray(g[ch])) return;
      var vs = g[ch].slice(0, MAX_VARIANTS).map(function (v) { return Array.isArray(v) ? v.map(normStroke).filter(Boolean) : []; });
      while (vs.length && !vs[vs.length - 1].length) vs.pop();
      if (vs.length) o.glyphs[ch] = vs;
    });
    return o;
  }
  function cloneFont(f, name) {
    var c = normFont(JSON.parse(JSON.stringify(f)));
    var now = Date.now();
    c.id = uid(); c.created = c.updated = now; c.sync = false;
    if (name != null) c.name = String(name).slice(0, 60);
    return c;
  }
  function variants(font, ch) { return (font.glyphs[ch] || []).filter(function (v) { return v && v.length; }); }
  function hasGlyph(font, ch) { return variants(font, ch).length > 0; }
  function progress(font, setId) {
    var chars = setId ? (SETS.filter(function (s) { return s.id === setId; })[0] || { chars: [] }).chars : ALL;
    var done = chars.filter(function (c) { return hasGlyph(font, c); }).length;
    return { done: done, total: chars.length };
  }
  // The next / previous character in `chars` (wrapping); `missing` skips drawn ones.
  function step(font, chars, ch, dir, missing) {
    var i = chars.indexOf(ch), n = chars.length;
    for (var k = 1; k <= n; k++) {
      var c = chars[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir * k + n * k) % n];
      if (!missing || !hasGlyph(font, c)) return c;
    }
    return null;
  }
  function strokesOf(font, ch, vi) {
    var g = font.glyphs[ch] || (font.glyphs[ch] = []);
    while (g.length <= vi) g.push([]);
    return g[vi];
  }
  function addStroke(font, ch, vi, stroke) {
    var s = normStroke(stroke);
    if (!s || ALL.indexOf(ch) < 0 || vi < 0 || vi >= MAX_VARIANTS) return false;
    strokesOf(font, ch, vi).push(s);
    font.updated = Date.now();
    return true;
  }
  function undoStroke(font, ch, vi) {
    var g = font.glyphs[ch];
    if (!g || !g[vi] || !g[vi].length) return null;
    var s = g[vi].pop();
    tidy(font, ch);
    font.updated = Date.now();
    return s;
  }
  function clearGlyph(font, ch, vi) {
    var g = font.glyphs[ch];
    if (!g || !g[vi]) return false;
    g[vi] = [];
    tidy(font, ch);
    font.updated = Date.now();
    return true;
  }
  // Removing a variant shifts the later ones down (so v2 never exists without v1).
  function removeVariant(font, ch, vi) {
    var g = font.glyphs[ch];
    if (!g || vi >= g.length) return false;
    g.splice(vi, 1);
    tidy(font, ch);
    font.updated = Date.now();
    return true;
  }
  function tidy(font, ch) {
    var g = font.glyphs[ch];
    if (!g) return;
    while (g.length && !g[g.length - 1].length) g.pop();
    if (!g.length) delete font.glyphs[ch];
  }
  function glyphCount(font) { return ALL.filter(function (c) { return hasGlyph(font, c); }).length; }

  // ---------------------------------------------------------------- capture
  // Canvas pixels (w × h showing VIEW) → font units.
  function toUnits(px, py, w, h) {
    return { x: VIEW.x0 + px / w * (VIEW.x1 - VIEW.x0), y: VIEW.y1 - py / h * (VIEW.y1 - VIEW.y0) };
  }
  function fromUnits(x, y, w, h) {
    return { x: (x - VIEW.x0) / (VIEW.x1 - VIEW.x0) * w, y: (VIEW.y1 - y) / (VIEW.y1 - VIEW.y0) * h };
  }
  // Pointer pressure → 0…1. Mice and fingers report 0 / 0.5 / junk: treat as 0.5.
  function normPressure(p, type) {
    if (type !== 'pen' || !(p > 0)) return 0.5;
    return clamp(p, 0.05, 1);
  }
  function radiusAt(weight, p) { return weight * (0.8 + 0.4 * clamp(p, 0, 1)); }

  // Points [{x, y, p}] → finished stroke (flat ints): drop jitter-close points,
  // two [1 2 1] smoothing passes (ends pinned), Douglas–Peucker at `tol` units.
  function finishStroke(pts, tol) {
    tol = tol == null ? 1.5 : tol;
    var a = [];
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i];
      if (!q || !isFinite(q.x) || !isFinite(q.y)) continue;
      var p = q.p == null ? 0.5 : q.p;
      if (a.length) { var l = a[a.length - 1]; if (Math.abs(l.x - q.x) < 0.5 && Math.abs(l.y - q.y) < 0.5) { l.p = Math.max(l.p, p); continue; } }
      a.push({ x: q.x, y: q.y, p: p });
    }
    if (!a.length) return null;
    for (var pass = 0; pass < 2 && a.length > 2; pass++) {
      var b = [a[0]];
      for (i = 1; i < a.length - 1; i++) {
        b.push({ x: (a[i - 1].x + 2 * a[i].x + a[i + 1].x) / 4, y: (a[i - 1].y + 2 * a[i].y + a[i + 1].y) / 4, p: (a[i - 1].p + 2 * a[i].p + a[i + 1].p) / 4 });
      }
      b.push(a[a.length - 1]);
      a = b;
    }
    var keep = a.length > 2 ? rdp(a, tol) : a;
    var out = [];
    keep.forEach(function (q) { out.push(Math.round(q.x), Math.round(q.y), Math.round(clamp(q.p, 0, 1) * 100)); });
    return out;
  }
  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    var t = l ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l, 0, 1) : 0;
    var x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
    return Math.sqrt(x * x + y * y);
  }
  // Open-polyline Douglas–Peucker (iterative); objects with x/y.
  function rdp(pts, tol) {
    var n = pts.length, keep = new Uint8Array(n), stack = [[0, n - 1]];
    keep[0] = keep[n - 1] = 1;
    while (stack.length) {
      var r = stack.pop(), a = r[0], b = r[1], best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) { var d = segDist(pts[i], pts[a], pts[b]); if (d > best) { best = d; bi = i; } }
      if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    var out = [];
    for (i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // ---------------------------------------------------------------- outline
  function strokePoints(s, weight) {
    var out = [];
    for (var i = 0; i + 2 < s.length; i += 3) out.push({ x: s[i], y: s[i + 1], r: radiusAt(weight, s[i + 2] / 100) });
    return out;
  }
  // Strokes → closed polygons ([[x, y], …], outer CCW, holes CW), unslanted.
  function strokeContours(strokes, weight, opts) {
    opts = opts || {};
    var segs = [], rMax = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (strokes || []).forEach(function (s) {
      var p = strokePoints(s, weight);
      if (!p.length) return;
      if (p.length === 1) p.push(p[0]);
      for (var i = 0; i < p.length; i++) {
        rMax = Math.max(rMax, p[i].r);
        minX = Math.min(minX, p[i].x); maxX = Math.max(maxX, p[i].x);
        minY = Math.min(minY, p[i].y); maxY = Math.max(maxY, p[i].y);
        if (i) segs.push([p[i - 1], p[i]]);
      }
    });
    if (!segs.length) return [];
    var cell = opts.cell || clamp(weight / 7, 3, 6);
    var pad = rMax + 2 * cell;
    var ox = minX - pad, oy = minY - pad;
    var nx = Math.ceil((maxX - minX + 2 * pad) / cell) + 1, ny = Math.ceil((maxY - minY + 2 * pad) / cell) + 1;
    var F = new Float32Array(nx * ny);
    for (var k = 0; k < F.length; k++) F[k] = -1e6;
    // Union field: max over segments of (radius − distance); > 0 is ink.
    segs.forEach(function (sg) {
      var a = sg[0], b = sg[1], rr = Math.max(a.r, b.r) + 2 * cell;
      var i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - rr - ox) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + rr - ox) / cell));
      var j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - rr - oy) / cell)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + rr - oy) / cell));
      var dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      for (var j = j0; j <= j1; j++) {
        var y = oy + j * cell;
        for (var i = i0; i <= i1; i++) {
          var x = ox + i * cell;
          var t = l ? clamp(((x - a.x) * dx + (y - a.y) * dy) / l, 0, 1) : 0;
          var ex = a.x + t * dx - x, ey = a.y + t * dy - y;
          var v = a.r + t * (b.r - a.r) - Math.sqrt(ex * ex + ey * ey);
          var idx = j * nx + i;
          if (v > F[idx]) F[idx] = v;
        }
      }
    });
    for (k = 0; k < F.length; k++) if (F[k] === 0) F[k] = -1e-4;   // no crossings exactly on a node
    var polys = marchingSquares(F, nx, ny, ox, oy, cell);
    var minArea = cell * cell * 3, tol = opts.tol == null ? Math.max(1, cell * 0.3) : opts.tol;
    var out = [];
    polys.forEach(function (p) {
      if (Math.abs(polyArea(p)) < minArea) return;
      var s = simplifyClosed(p, tol);
      if (s.length >= 3 && Math.abs(polyArea(s)) >= minArea) out.push(s);
    });
    return out;
  }

  // Interpolated marching squares on a node grid; inside (v > 0) kept on the
  // left of every contour, so outer contours run counter-clockwise (y up).
  function marchingSquares(F, nx, ny, ox, oy, cell) {
    var H = nx * ny;                              // edge ids: h(i,j) = j*nx+i, v(i,j) = H + j*nx+i
    var next = new Int32Array(2 * H).fill(-1);
    var px = new Float64Array(2 * H), py = new Float64Array(2 * H);
    function cross(id, i0, j0, i1, j1) {
      var a = F[j0 * nx + i0], b = F[j1 * nx + i1], t = a / (a - b);
      px[id] = ox + (i0 + (i1 - i0) * t) * cell;
      py[id] = oy + (j0 + (j1 - j0) * t) * cell;
    }
    var starts = [];
    for (var j = 0; j < ny - 1; j++) {
      for (var i = 0; i < nx - 1; i++) {
        var c = [F[j * nx + i], F[j * nx + i + 1], F[(j + 1) * nx + i + 1], F[(j + 1) * nx + i]];   // BL BR TR TL (CCW)
        var ins = [c[0] > 0, c[1] > 0, c[2] > 0, c[3] > 0];
        if (ins[0] === ins[1] && ins[1] === ins[2] && ins[2] === ins[3]) continue;
        var edges = [j * nx + i, H + j * nx + i + 1, (j + 1) * nx + i, H + j * nx + i];
        var nodes = [[i, j, i + 1, j], [i + 1, j, i + 1, j + 1], [i, j + 1, i + 1, j + 1], [i, j, i, j + 1]];
        var xs = [];
        for (var e = 0; e < 4; e++) {
          if (ins[e] !== ins[(e + 1) % 4]) {
            var nd = nodes[e];
            cross(edges[e], nd[0], nd[1], nd[2], nd[3]);
            xs.push({ id: edges[e], out: ins[e] });   // out: leaving the ink going CCW round the cell
          }
        }
        if (xs.length === 2) {
          var A = xs[0].out ? xs[0] : xs[1], B = xs[0].out ? xs[1] : xs[0];
          next[A.id] = B.id; starts.push(A.id);
        } else if (xs.length === 4) {
          var centreIn = (c[0] + c[1] + c[2] + c[3]) / 4 > 0;
          for (var q = 0; q < 4; q++) {
            if (!xs[q].out) continue;
            var to = centreIn ? xs[(q + 1) % 4] : xs[(q + 3) % 4];
            next[xs[q].id] = to.id; starts.push(xs[q].id);
          }
        }
      }
    }
    var seen = new Uint8Array(2 * H), polys = [];
    starts.forEach(function (s) {
      if (seen[s]) return;
      var poly = [], cur = s, guard = 0;
      while (cur >= 0 && !seen[cur] && guard++ < 2 * H) {
        seen[cur] = 1;
        poly.push([px[cur], py[cur]]);
        cur = next[cur];
      }
      if (cur === s && poly.length >= 3) polys.push(poly);
    });
    return polys;
  }

  function polyArea(p) {
    var a = 0;
    for (var i = 0, n = p.length; i < n; i++) { var q = p[i], r = p[(i + 1) % n]; a += q[0] * r[1] - r[0] * q[1]; }
    return a / 2;
  }
  // Closed Douglas–Peucker: split at the vertex farthest from vertex 0.
  function simplifyClosed(p, tol) {
    var n = p.length;
    if (n < 4) return p.slice();
    var far = 0, fd = -1;
    for (var i = 1; i < n; i++) { var dx = p[i][0] - p[0][0], dy = p[i][1] - p[0][1], d = dx * dx + dy * dy; if (d > fd) { fd = d; far = i; } }
    var objs = p.map(function (q) { return { x: q[0], y: q[1] }; });
    var a = rdp(objs.slice(0, far + 1), tol), b = rdp(objs.slice(far).concat([objs[0]]), tol);
    var out = a.concat(b.slice(1, -1)).map(function (q) { return [q.x, q.y]; });
    // drop near-duplicate neighbours
    return out.filter(function (q, k) { var r = out[(k + 1) % out.length]; return out.length < 4 || Math.abs(q[0] - r[0]) + Math.abs(q[1] - r[1]) > 0.05; });
  }
  // Closed polygon → quadratic B-spline path (vertices are off-curve points,
  // edge midpoints on-curve): smooth everywhere, within the polygon's hull.
  function contourToPath(poly) {
    var n = poly.length, cmds = [];
    function mid(k) { var a = poly[k % n], b = poly[(k + 1) % n]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    var m = mid(n - 1);
    cmds.push({ type: 'M', x: r2(m[0]), y: r2(m[1]) });
    for (var i = 0; i < n; i++) {
      var e = mid(i);
      cmds.push({ type: 'Q', x1: r2(poly[i][0]), y1: r2(poly[i][1]), x: r2(e[0]), y: r2(e[1]) });
    }
    cmds.push({ type: 'Z' });
    return cmds;
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  // One variant's finished shape: slanted contours, path commands moved so the
  // ink starts at the side bearing, and the advance width.
  function glyphShape(strokes, settings) {
    var st = normSettings(settings);
    var polys = strokeContours(strokes, st.weight);
    if (!polys.length) return null;
    var sh = Math.tan(st.slant * Math.PI / 180);
    var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    polys = polys.map(function (p) {
      return p.map(function (q) {
        var x = q[0] + q[1] * sh, y = q[1];
        if (x < xMin) xMin = x; if (x > xMax) xMax = x; if (y < yMin) yMin = y; if (y > yMax) yMax = y;
        return [x, y];
      });
    });
    var sb = st.spacing, dx = sb - xMin;
    var cmds = [];
    polys.forEach(function (p) {
      contourToPath(p.map(function (q) { return [q[0] + dx, q[1]]; })).forEach(function (c) { cmds.push(c); });
    });
    return {
      commands: cmds, contours: polys, dx: dx,
      xMin: xMin + dx, xMax: xMax + dx, yMin: yMin, yMax: yMax,
      advance: Math.max(1, Math.round(xMax - xMin + 2 * sb))
    };
  }
  function pathToSvg(cmds, dx, flip) {
    var s = '', f = flip === false ? 1 : -1;
    dx = dx || 0;
    cmds.forEach(function (c) {
      if (c.type === 'M') s += 'M' + r1(c.x + dx) + ' ' + r1(f * c.y);
      else if (c.type === 'Q') s += 'Q' + r1(c.x1 + dx) + ' ' + r1(f * c.y1) + ' ' + r1(c.x + dx) + ' ' + r1(f * c.y);
      else if (c.type === 'L') s += 'L' + r1(c.x + dx) + ' ' + r1(f * c.y);
      else if (c.type === 'Z') s += 'Z';
    });
    return s;
  }
  function r1(v) { return Math.round(v * 10) / 10; }

  // All glyphs to put in the font: [{ ch, vi, name, unicode, advance, commands }].
  function buildGlyphList(font, cache) {
    var st = normSettings(font.settings), out = [];
    ALL.forEach(function (ch) {
      variants(font, ch).forEach(function (strokes, vi) {
        var shape = cache ? cache(ch, vi, strokes, st) : glyphShape(strokes, st);
        if (!shape) return;
        out.push({ ch: ch, vi: vi, name: glyphName(ch, vi), unicode: vi ? null : ch.charCodeAt(0), advance: shape.advance, commands: shape.commands });
      });
    });
    return out;
  }
  function psName(name) {
    var s = String(name || '').normalize ? String(name || '').normalize('NFKD') : String(name || '');
    s = s.replace(/[^A-Za-z0-9]/g, '');
    return (s || 'MyHand').slice(0, 50) + '-Regular';
  }

  // Build an opentype.js Font. `ot` is the opentype.js namespace.
  function buildFont(ot, font, opts) {
    opts = opts || {};
    var st = normSettings(font.settings);
    var list = buildGlyphList(font, opts.cache);
    var family = String(font.name || '').trim() || 'My Hand';
    var notdef = new ot.Path();
    notdef.moveTo(80, 0); notdef.lineTo(80, 700); notdef.lineTo(420, 700); notdef.lineTo(420, 0); notdef.close();
    notdef.moveTo(130, 50); notdef.lineTo(370, 50); notdef.lineTo(370, 650); notdef.lineTo(130, 650); notdef.close();
    var glyphs = [new ot.Glyph({ name: '.notdef', advanceWidth: 500, path: notdef }), new ot.Glyph({ name: 'space', unicode: 32, advanceWidth: st.space, path: new ot.Path() })];
    // Base glyphs first, then the alternates, so each coverage list is sorted.
    var bases = list.filter(function (g) { return !g.vi; }), alts = list.filter(function (g) { return g.vi; });
    var index = {};
    bases.concat(alts).forEach(function (g) {
      var p = new ot.Path();
      g.commands.forEach(function (c) {
        if (c.type === 'M') p.moveTo(c.x, c.y);
        else if (c.type === 'Q') p.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
        else if (c.type === 'L') p.lineTo(c.x, c.y);
        else if (c.type === 'Z') p.close();
      });
      var o = { name: g.name, advanceWidth: g.advance, path: p };
      if (g.unicode != null) o.unicode = g.unicode;
      index[g.name] = glyphs.length;
      glyphs.push(new ot.Glyph(o));
    });
    var yMax = 0, yMin = 0;
    list.forEach(function (g) { g.commands.forEach(function (c) { if (c.y != null) { yMax = Math.max(yMax, c.y, c.y1 == null ? 0 : c.y1); yMin = Math.min(yMin, c.y, c.y1 == null ? 0 : c.y1); } }); });
    var f = new ot.Font({
      familyName: family, styleName: 'Regular', unitsPerEm: EM,
      ascender: Math.max(METRICS.ascender, Math.ceil(yMax)), descender: Math.min(METRICS.descender, Math.floor(yMin)),
      designer: opts.designer || 'Drawn by hand in Cade.txt Font Maker',
      description: 'Handwriting font made with Cade.txt Font Maker',
      version: '1.0', postScriptName: psName(family),
      glyphs: glyphs
    });
    var gsub = makeGsub(list, index);
    if (gsub) f.tables.gsub = gsub;
    return f;
  }

  // calt that cycles the drawn versions (default → .alt1 → .alt2 → default…,
  // decided by the glyph before), plus salt offering them as alternates.
  function makeGsub(list, index) {
    var by = {};
    list.forEach(function (g) { (by[g.ch] = by[g.ch] || [])[g.vi] = index[g.name]; });
    var has1 = [], has2 = [];
    ALL.forEach(function (ch) { var v = by[ch]; if (v && v[0] != null && v[1] != null) has1.push(ch); if (v && v[0] != null && v[1] != null && v[2] != null) has2.push(ch); });
    if (!has1.length) return null;
    var sortBy = function (arr, vi) { return arr.map(function (ch) { return { b: by[ch][0], s: by[ch][vi] }; }).sort(function (a, b) { return a.b - b.b; }); };
    var s1 = sortBy(has1, 1), s2 = sortBy(has2, 2);
    var lookups = [
      { lookupType: 1, lookupFlag: 0, subtables: [{ substFormat: 2, coverage: { format: 1, glyphs: s1.map(function (x) { return x.b; }) }, substitute: s1.map(function (x) { return x.s; }) }] }
    ];
    var alt1Ids = list.filter(function (g) { return g.vi === 1; }).map(function (g) { return index[g.name]; }).sort(function (a, b) { return a - b; });
    var plainIds = list.filter(function (g) { return !g.vi; }).map(function (g) { return index[g.name]; }).sort(function (a, b) { return a - b; });
    var caltSubs = [];
    var L2 = -1;
    if (s2.length) {
      lookups.push({ lookupType: 1, lookupFlag: 0, subtables: [{ substFormat: 2, coverage: { format: 1, glyphs: s2.map(function (x) { return x.b; }) }, substitute: s2.map(function (x) { return x.s; }) }] });
      L2 = 1;
      caltSubs.push({ substFormat: 3, backtrackCoverage: [{ format: 1, glyphs: alt1Ids }], inputCoverage: [{ format: 1, glyphs: s2.map(function (x) { return x.b; }) }], lookaheadCoverage: [], lookupRecords: [{ sequenceIndex: 0, lookupListIndex: L2 }] });
    }
    caltSubs.push({ substFormat: 3, backtrackCoverage: [{ format: 1, glyphs: plainIds }], inputCoverage: [{ format: 1, glyphs: s1.map(function (x) { return x.b; }) }], lookaheadCoverage: [], lookupRecords: [{ sequenceIndex: 0, lookupListIndex: 0 }] });
    var caltIdx = lookups.length;
    lookups.push({ lookupType: 6, lookupFlag: 0, subtables: caltSubs });
    var saltIdx = lookups.length;
    lookups.push({ lookupType: 3, lookupFlag: 0, subtables: [{ substFormat: 1, coverage: { format: 1, glyphs: s1.map(function (x) { return x.b; }) }, alternateSets: s1.map(function (x) { var v = by[glyphChar(x.b, by)]; return v.slice(1).filter(function (id) { return id != null; }); }) }] });
    var langSys = { reserved: 0, reqFeatureIndex: 0xffff, featureIndexes: [0, 1] };
    return {
      version: 1,
      scripts: [{ tag: 'DFLT', script: { defaultLangSys: langSys, langSysRecords: [] } }, { tag: 'latn', script: { defaultLangSys: langSys, langSysRecords: [] } }],
      features: [{ tag: 'calt', feature: { featureParams: 0, lookupListIndexes: [caltIdx] } }, { tag: 'salt', feature: { featureParams: 0, lookupListIndexes: [saltIdx] } }],
      lookups: lookups
    };
  }
  function glyphChar(id, by) { for (var ch in by) if (by[ch][0] === id) return ch; return null; }

  // ---------------------------------------------------------------- WOFF 1.0
  // sfnt bytes → WOFF bytes. `deflate(u8)` returns zlib-wrapped bytes (or a
  // Promise of them); omit it for an uncompressed WOFF. Returns a Promise.
  function makeWoff(sfnt, deflate) {
    var u8 = sfnt instanceof Uint8Array ? sfnt : new Uint8Array(sfnt);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var flavor = dv.getUint32(0), numTables = dv.getUint16(4), tables = [];
    for (var i = 0; i < numTables; i++) {
      var r = 12 + i * 16;
      tables.push({ tag: dv.getUint32(r), checksum: dv.getUint32(r + 4), offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) });
    }
    return Promise.all(tables.map(function (t) {
      var raw = u8.subarray(t.offset, t.offset + t.length);
      if (!deflate) return raw;
      return Promise.resolve(deflate(raw)).then(function (c) { c = c instanceof Uint8Array ? c : new Uint8Array(c); return c.length < raw.length ? c : raw; }, function () { return raw; });
    })).then(function (datas) {
      var off = 44 + 20 * numTables, total = off, sfntSize = 12 + 16 * numTables;
      tables.forEach(function (t, k) { t.data = datas[k]; t.woffOffset = total; total += (datas[k].length + 3) & ~3; sfntSize += (t.length + 3) & ~3; });
      var out = new Uint8Array(total), ov = new DataView(out.buffer);
      ov.setUint32(0, 0x774F4646); ov.setUint32(4, flavor); ov.setUint32(8, total); ov.setUint16(12, numTables); ov.setUint16(14, 0);
      ov.setUint32(16, sfntSize); ov.setUint16(20, 1); ov.setUint16(22, 0);
      // 24..43: metadata / private blocks: none
      tables.forEach(function (t, k) {
        var r = 44 + 20 * k;
        ov.setUint32(r, t.tag); ov.setUint32(r + 4, t.woffOffset); ov.setUint32(r + 8, t.data.length); ov.setUint32(r + 12, t.length); ov.setUint32(r + 16, t.checksum);
        out.set(t.data, t.woffOffset);
      });
      return out;
    });
  }

  // ---------------------------------------------------------------- layout
  // Seeded PRNG (mulberry32) so a picture re-renders identically.
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // Picks a drawn version per occurrence: never the same version of the same
  // letter twice running, otherwise random — reads as handwriting.
  function variantPicker(seed) {
    var R = rng(seed), last = {};
    return function (ch, n) {
      if (n <= 1) return 0;
      var v = Math.floor(R() * n);
      if (v === last[ch]) v = (v + 1 + Math.floor(R() * (n - 1))) % n;
      last[ch] = v;
      return v;
    };
  }
  // Lay text out in lines. info(ch) → { n: versions drawn (0 = missing),
  // adv(vi) → advance in units }, missing(ch) → advance in units for the
  // fallback. o: { size (px per em), width (px), lineHeight (× size), align,
  // jitter 0…1, seed }. Returns { lines: [{ y, items: [{ ch, vi, x, y, rot,
  // scale, missing }] }], height }.
  function layoutText(text, info, o) {
    var size = o.size, k = size / EM, width = o.width, lh = (o.lineHeight || 1.3) * size, jit = clamp(o.jitter || 0, 0, 1);
    var pick = variantPicker(o.seed || 7), R = rng((o.seed || 7) * 31 + 1);
    var out = [], paras = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    function adv(ch) {
      if (ch === ' ') return (o.space || DEFAULTS.space) * k;
      var g = info(ch);
      if (!g || !g.n) return (o.missing ? o.missing(ch) : 500) * k;
      return null;
    }
    paras.forEach(function (para) {
      var words = para.split(/( +)/).filter(function (w) { return w.length; });
      var line = [], lw = 0;
      function flush() {
        while (line.length && line[line.length - 1].ch === ' ') { lw -= line[line.length - 1].w; line.pop(); }
        out.push({ items: line, w: lw });
        line = []; lw = 0;
      }
      if (!words.length) { flush(); return; }
      words.forEach(function (w) {
        var items = [], ww = 0;
        for (var i = 0; i < w.length; i++) {
          var ch = w.charAt(i), g = ch === ' ' ? null : info(ch), vi = 0, a = adv(ch);
          if (a == null) { vi = pick(ch, g.n); a = g.adv(vi) * k; }
          items.push({ ch: ch, vi: vi, w: a, missing: ch !== ' ' && (!g || !g.n) });
          ww += a;
        }
        if (w.charAt(0) === ' ') { if (line.length) { items.forEach(function (it) { line.push(it); }); lw += ww; } return; }
        if (lw + ww > width && line.length) flush();
        if (ww > width) {   // a word longer than the line: break it anywhere
          items.forEach(function (it) { if (lw + it.w > width && line.length) flush(); line.push(it); lw += it.w; });
          return;
        }
        items.forEach(function (it) { line.push(it); }); lw += ww;
      });
      flush();
    });
    var lines = out.map(function (l, li) {
      var x0 = o.align === 'center' ? (width - l.w) / 2 : o.align === 'right' ? width - l.w : 0;
      var y = size * 0.9 + li * lh, x = x0, phase = R() * 6.283, freq = 0.6 + R() * 0.8;
      var items = l.items.map(function (it) {
        var wob = jit ? Math.sin(phase + x / size * freq) * size * 0.035 * jit + (R() - 0.5) * size * 0.03 * jit : 0;
        var r = { ch: it.ch, vi: it.vi, x: x + (jit ? (R() - 0.5) * size * 0.02 * jit : 0), y: y + wob, rot: jit ? (R() - 0.5) * 0.07 * jit : 0, scale: jit ? 1 + (R() - 0.5) * 0.06 * jit : 1, missing: it.missing, w: it.w };
        x += it.w;
        return r;
      });
      return { y: y, w: l.w, items: items };
    });
    return { lines: lines, height: lines.length ? (lines.length - 1) * lh + size * 1.2 : 0 };
  }

  var api = {
    EM: EM, METRICS: METRICS, VIEW: VIEW, DEFAULTS: DEFAULTS, LIMITS: LIMITS, MAX_VARIANTS: MAX_VARIANTS,
    SETS: SETS, ALL: ALL, glyphName: glyphName,
    newFont: newFont, normFont: normFont, normSettings: normSettings, cloneFont: cloneFont,
    variants: variants, hasGlyph: hasGlyph, progress: progress, step: step, glyphCount: glyphCount,
    addStroke: addStroke, undoStroke: undoStroke, clearGlyph: clearGlyph, removeVariant: removeVariant,
    toUnits: toUnits, fromUnits: fromUnits, normPressure: normPressure, radiusAt: radiusAt, finishStroke: finishStroke,
    strokeContours: strokeContours, polyArea: polyArea, contourToPath: contourToPath, glyphShape: glyphShape, pathToSvg: pathToSvg,
    buildGlyphList: buildGlyphList, buildFont: buildFont, psName: psName, makeWoff: makeWoff,
    rng: rng, variantPicker: variantPicker, layoutText: layoutText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__cadeFontmaker = api;
})(typeof window !== 'undefined' ? window : this);
