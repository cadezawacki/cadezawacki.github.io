/* Etch Pad — a twin-knob line-drawing toy for Cade.txt.
 * A chunky frame around a silvery screen; a stylus point draws one continuous
 * dark line while two knobs are turned: bottom-left moves it left / right,
 * bottom-right up / down. Turn the knobs by dragging round them (both at once
 * with two thumbs for diagonals), with the mouse wheel over a knob, or with the
 * keys (arrows / WASD, Shift for fine work). There is no lifting the pen.
 * Shake to erase: the Shake button, a shake of the phone (DeviceMotion) or a
 * fast jiggle of the grab handle on top of the frame. Each shake only clears
 * part of the powder — a few shakes empty the screen and leave a faint ghost.
 * Extras: undo the last stroke, a replay of the drawing being re-drawn (knobs
 * turning), a gallery of saved sketches (stored as compact polylines, not
 * images) with PNG export and "Insert into note", and two games: Trace (copy a
 * faint generated shape against the clock — scored on coverage and accuracy,
 * stars, streaks, endless levels) and Maze (steer the stylus through a
 * generated maze without touching the walls; endless, growing mazes).
 * Settings, records, the gallery and the drawing on the screen persist in
 * Cade.store (cade-etch-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: the drawing's own box, its long side LONG units; x → right, y → down.
  var LONG = 400;
  var SENS = [0, 50, 75, 110, 160, 230];          // stylus units per full knob turn, by sensitivity 1-5
  var THICK = [0, 1.2, 1.9, 2.7, 3.7];             // line width (units), by thickness 1-4
  var GHOST = 0.12;                                // how dark an erased line's ghost stays (× its ghost weight)
  var SIMPLIFY = 0.3;                              // polyline simplification tolerance (units)
  var SUB = 8;                                     // a shake splits segments longer than this so erasing is patchy

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y, s) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // smooth value noise in [0, 1], ~cell units per feature
  function noise(x, y, seed, cell) {
    var fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    var a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
  }
  // the drawing box for a screen of sw × sh: long side LONG, aspect clamped
  function dimsFor(sw, sh) {
    var r = clamp(sw / Math.max(1, sh), 0.6, 2);
    return r >= 1 ? { w: LONG, h: Math.round(LONG / r) } : { w: Math.round(LONG * r), h: LONG };
  }

  // ---- the drawing: one continuous polyline; per-vertex strength s (of the segment ENDING there) and ghost weight g ----
  function newDrawing(w, h, x, y) {
    x = clamp(x === undefined ? w / 2 : x, 0, w); y = clamp(y === undefined ? h / 2 : y, 0, h);
    return { w: w, h: h, p: [x, y], s: [1], g: [1], marks: [], fl: false, raw: [], ghosts: [] };
  }
  function nVert(d) { return d.s.length; }
  function tip(d) { var n = d.p.length; return { x: d.p[n - 2], y: d.p[n - 1] }; }
  function distSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    var qx = ax + dx * t - px, qy = ay + dy * t - py;
    return Math.sqrt(qx * qx + qy * qy);
  }
  // Move the stylus to (x, y) (clamped to the screen), extending the line. Runs of
  // nearly-straight motion collapse into one segment (all the raw points since the
  // last kept vertex stay within SIMPLIFY of it), so knob lines store compactly.
  function moveTo(d, x, y) {
    x = clamp(x, 0, d.w); y = clamp(y, 0, d.h);
    var n = nVert(d), bx = d.p[2 * n - 2], by = d.p[2 * n - 1];
    if (Math.abs(x - bx) < 1e-6 && Math.abs(y - by) < 1e-6) return false;
    var lastMark = d.marks.length ? d.marks[d.marks.length - 1] : -1;
    if (d.fl && n >= 2 && d.s[n - 1] === 1 && n - 2 >= lastMark && d.raw.length < 240) {
      var ax = d.p[2 * n - 4], ay = d.p[2 * n - 3], ok = true;
      // same general direction (no doubling back over the kept vertex)
      if ((bx - ax) * (x - bx) + (by - ay) * (y - by) <= 0) ok = false;
      for (var i = 0; ok && i < d.raw.length; i += 2) if (distSeg(d.raw[i], d.raw[i + 1], ax, ay, x, y) > SIMPLIFY) ok = false;
      if (ok) { d.p[2 * n - 2] = x; d.p[2 * n - 1] = y; d.raw.push(x, y); return true; }
    }
    d.p.push(x, y); d.s.push(1); d.g.push(1);
    d.raw = [x, y]; d.fl = true;
    return true;
  }
  // a new stroke starts here (undo goes back to it)
  function markStroke(d) {
    var n = nVert(d) - 1;
    if (!d.marks.length || d.marks[d.marks.length - 1] !== n) d.marks.push(n);
    if (d.marks.length > 200) d.marks.shift();
    d.fl = false; d.raw = [];
  }
  function undo(d) {
    while (d.marks.length) {
      var m = d.marks.pop();
      if (m < nVert(d) - 1) {
        d.p.length = 2 * (m + 1); d.s.length = m + 1; d.g.length = m + 1;
        d.fl = false; d.raw = [];
        return true;
      }
    }
    return false;
  }
  function inkLen(d) {
    var L = 0;
    for (var i = 1; i < nVert(d); i++) if (d.s[i] > 0.02) L += Math.hypot(d.p[2 * i] - d.p[2 * i - 2], d.p[2 * i + 1] - d.p[2 * i - 1]);
    return L;
  }
  function maxStrength(d) { var m = 0; for (var i = 1; i < nVert(d); i++) if (d.s[i] > m) m = d.s[i]; return m; }
  function isBlank(d) { return nVert(d) < 2 && !d.ghosts.length; }
  function subdivide(d) {
    var p = [d.p[0], d.p[1]], s = [d.s[0]], g = [d.g[0]];
    for (var i = 1; i < nVert(d); i++) {
      var ax = d.p[2 * i - 2], ay = d.p[2 * i - 1], bx = d.p[2 * i], by = d.p[2 * i + 1], L = Math.hypot(bx - ax, by - ay), k = Math.ceil(L / SUB);
      for (var j = 1; j < k; j++) { p.push(ax + (bx - ax) * j / k, ay + (by - ay) * j / k); s.push(d.s[i]); g.push(d.g[i]); }
      p.push(bx, by); s.push(d.s[i]); g.push(d.g[i]);
    }
    d.p = p; d.s = s; d.g = g;
  }
  // One shake: every segment loses a patchy share of its powder (power ~0.5 for a
  // full shake). Ghost weights fade slower. When nothing visible is left the line
  // moves to the ghost layer and a fresh line starts at the stylus.
  function shake(d, seed, power) {
    power = clamp(power === undefined ? 0.5 : power, 0, 1);
    subdivide(d);
    var i, n = nVert(d), gk = 1 - power * 0.34, cell = 40 + (seed % 5) * 9;
    for (i = 1; i < n; i++) {
      var mx = (d.p[2 * i - 2] + d.p[2 * i]) / 2, my = (d.p[2 * i - 1] + d.p[2 * i + 1]) / 2;
      var nz = clamp((noise(mx, my, seed, cell) - 0.5) * 2.2 + 0.5, 0, 1), f = clamp(power * (0.25 + 1.6 * nz), 0, 0.97);
      d.s[i] *= 1 - f;
      if (d.s[i] < 0.06) d.s[i] = 0;
      d.g[i] *= gk;
    }
    d.ghosts = d.ghosts.filter(function (gh) {
      var m = 0;
      for (var k = 0; k < gh.g.length; k++) { gh.g[k] *= gk; if (gh.g[k] > m) m = gh.g[k]; }
      return m > 0.12;
    });
    d.marks = []; d.fl = false; d.raw = [];
    var cleared = false;
    if (n > 1 && maxStrength(d) < 0.04) {
      var gm = 0;
      for (i = 1; i < n; i++) if (d.g[i] > gm) gm = d.g[i];
      if (gm > 0.12) { d.ghosts.push({ p: d.p, g: d.g }); if (d.ghosts.length > 3) d.ghosts.shift(); }
      var t = tip(d);
      d.p = [t.x, t.y]; d.s = [1]; d.g = [1];
      cleared = true;
    }
    return { cleared: cleared, left: maxStrength(d) };
  }
  // the visible alpha of segment i (0..1)
  function segAlpha(d, i) { return Math.max(d.s[i], GHOST * d.g[i]); }
  // runs of consecutive segments at least minS strong, as flat polylines
  function visibleRuns(d, minS) {
    var out = [], cur = null;
    for (var i = 1; i < nVert(d); i++) {
      if (d.s[i] >= minS) {
        if (!cur) { cur = [d.p[2 * i - 2], d.p[2 * i - 1]]; out.push(cur); }
        cur.push(d.p[2 * i], d.p[2 * i + 1]);
      } else cur = null;
    }
    return out;
  }

  // ---- compact storage: "v1|w|h|deltas|strengths" (half-unit ints, base36 deltas) ----
  function encode(d) {
    var q = [], px = 0, py = 0, sq = '', full = true;
    for (var i = 0; i < nVert(d); i++) {
      var x = Math.round(d.p[2 * i] * 2), y = Math.round(d.p[2 * i + 1] * 2);
      q.push((x - px).toString(36), (y - py).toString(36));
      px = x; py = y;
      var sv = clamp(Math.round(d.s[i] * 9), 0, 9);
      if (i > 0 && sv < 9) full = false;
      sq += sv;
    }
    return 'v1|' + d.w + '|' + d.h + '|' + q.join(',') + '|' + (full ? '' : sq);
  }
  function decode(str) {
    if (typeof str !== 'string') return null;
    var parts = str.split('|');
    if (parts[0] !== 'v1' || parts.length < 4) return null;
    var w = +parts[1], h = +parts[2];
    if (!(w > 10 && w <= 2000 && h > 10 && h <= 2000)) return null;
    var toks = parts[3] ? parts[3].split(',') : [];
    if (toks.length < 2 || toks.length % 2) return null;
    var d = newDrawing(w, h, 0, 0), x = 0, y = 0, sq = parts[4] || '';
    d.p = []; d.s = []; d.g = [];
    for (var i = 0; i < toks.length; i += 2) {
      var dx = parseInt(toks[i], 36), dy = parseInt(toks[i + 1], 36);
      if (!isFinite(dx) || !isFinite(dy)) return null;
      x += dx; y += dy;
      d.p.push(clamp(x / 2, 0, w), clamp(y / 2, 0, h));
      var sv = sq.length > i / 2 ? +sq.charAt(i / 2) : 9;
      d.s.push(i === 0 ? 1 : (isFinite(sv) ? sv : 9) / 9); d.g.push(1);
    }
    return d;
  }
  // map a drawing into a new box (keeps its shape: uniform scale, centered)
  function refit(d, w, h) {
    var k = Math.min(w / d.w, h / d.h), ox = (w - d.w * k) / 2, oy = (h - d.h * k) / 2;
    for (var i = 0; i < d.p.length; i += 2) { d.p[i] = clamp(d.p[i] * k + ox, 0, w); d.p[i + 1] = clamp(d.p[i + 1] * k + oy, 0, h); }
    d.w = w; d.h = h; d.ghosts = []; d.marks = []; d.fl = false; d.raw = [];
    return d;
  }

  // ---- geometry helpers ----
  function polyLen(pts) { var L = 0; for (var i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); return L; }
  // points every `step` units along a flat polyline (both ends included)
  function resample(pts, step) {
    var out = [];
    if (pts.length < 2) return out;
    out.push(pts[0], pts[1]);
    if (pts.length < 4) return out;
    var carry = 0;
    for (var i = 2; i < pts.length; i += 2) {
      var ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1], L = Math.hypot(bx - ax, by - ay), t = step - carry;
      while (t <= L) { out.push(ax + (bx - ax) * t / L, ay + (by - ay) * t / L); t += step; }
      carry = L - (t - step);
    }
    var n = pts.length;
    if (Math.hypot(out[out.length - 2] - pts[n - 2], out[out.length - 1] - pts[n - 1]) > 0.01) out.push(pts[n - 2], pts[n - 1]);
    return out;
  }
  function Grid(cell) { this.c = cell; this.m = {}; }
  Grid.prototype.add = function (x, y) { var k = Math.floor(x / this.c) + ',' + Math.floor(y / this.c); (this.m[k] || (this.m[k] = [])).push(x, y); };
  Grid.prototype.near = function (x, y, r) {
    var cx = Math.floor(x / this.c), cy = Math.floor(y / this.c), r2 = r * r, reach = Math.ceil(r / this.c);
    for (var i = -reach; i <= reach; i++) for (var j = -reach; j <= reach; j++) {
      var a = this.m[(cx + i) + ',' + (cy + j)];
      if (a) for (var k = 0; k < a.length; k += 2) { var dx = a[k] - x, dy = a[k + 1] - y; if (dx * dx + dy * dy <= r2) return true; }
    }
    return false;
  };

  // ---- Trace: generated target shapes ----
  // Shapes are built in a [-1, 1] box (y down) then fitted to the screen.
  function shapePts(kind, rnd, cx) {
    var p = [], i, n, a, r, t;
    function add(x, y) { p.push(x, y); }
    if (kind === 'rect') {
      var rw = 0.6 + rnd() * 0.4, rh = 0.5 + rnd() * 0.5;
      add(-rw, -rh); add(rw, -rh); add(rw, rh); add(-rw, rh); add(-rw, -rh);
    } else if (kind === 'stairs') {
      n = 3 + Math.floor(rnd() * 2) + Math.min(3, cx);
      var sx = 2 / n, sy = 2 / n;
      add(-1, 1);
      for (i = 0; i < n; i++) { add(-1 + sx * i, 1 - sy * (i + 1)); add(-1 + sx * (i + 1), 1 - sy * (i + 1)); }
      if (cx >= 2) { add(1, 1); add(-1, 1); }
    } else if (kind === 'poly') {
      n = 3 + Math.floor(rnd() * (cx >= 2 ? 5 : 3)); a = rnd() * Math.PI * 2;
      for (i = 0; i <= n; i++) add(Math.cos(a + i * 2 * Math.PI / n), Math.sin(a + i * 2 * Math.PI / n));
    } else if (kind === 'star') {
      n = 5 + Math.floor(rnd() * Math.min(4, cx + 1)); var inner = 0.38 + rnd() * 0.15; a = -Math.PI / 2;
      for (i = 0; i <= 2 * n; i++) { r = i % 2 ? inner : 1; add(r * Math.cos(a + i * Math.PI / n), r * Math.sin(a + i * Math.PI / n)); }
    } else if (kind === 'battle') {
      n = 3 + Math.floor(rnd() * 2) + Math.min(3, cx); var bw = 2 / (2 * n);
      add(-1, 0.4);
      for (i = 0; i < 2 * n; i++) { var up = i % 2 === 0; add(-1 + bw * i, up ? -0.4 : 0.4); add(-1 + bw * (i + 1), up ? -0.4 : 0.4); if (i < 2 * n - 1) add(-1 + bw * (i + 1), up ? 0.4 : -0.4); }
      add(1, 0.4);
    } else if (kind === 'zigzag') {
      n = 4 + Math.floor(rnd() * 3) + Math.min(4, cx);
      for (i = 0; i <= n; i++) add(-1 + 2 * i / n, i % 2 ? -0.6 : 0.6);
    } else if (kind === 'wave') {
      var per = 1.5 + rnd() * 1.5 + cx * 0.4, amp = 0.55 + rnd() * 0.3;
      for (i = 0; i <= 120; i++) { t = i / 120; add(-1 + 2 * t, amp * Math.sin(t * per * Math.PI * 2)); }
    } else if (kind === 'heart') {
      for (i = 0; i <= 140; i++) {
        t = i / 140 * Math.PI * 2;
        add(16 * Math.pow(Math.sin(t), 3) / 17, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17);
      }
    } else if (kind === 'spiral') {
      var turns = 2 + rnd() * 0.8 + Math.min(2.5, cx * 0.4), sq = cx >= 3 && rnd() < 0.5;
      if (sq) {    // a square spiral: straight runs that grow
        var x = 0, y = 0, len = 0.12, dir = 0, DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
        add(0, 0);
        for (i = 0; i < Math.round(turns * 4); i++) { x += DX[dir] * len; y += DY[dir] * len; add(x, y); dir = (dir + 1) % 4; if (i % 2) len += 0.12; }
      } else {
        n = Math.round(turns * 60);
        for (i = 0; i <= n; i++) { t = i / n; a = t * turns * Math.PI * 2; add(t * Math.cos(a), t * Math.sin(a)); }
      }
    } else if (kind === 'rose') {
      var kk = [2, 3, 4, 5][Math.floor(rnd() * 4)], m = kk % 2 ? 1 : 2;
      n = 240;
      for (i = 0; i <= n; i++) { t = i / n * Math.PI * m; r = Math.cos(kk * t); add(r * Math.cos(t), r * Math.sin(t)); }
    } else if (kind === 'blob') {
      var amps = [], ph = [];
      for (i = 0; i < 5; i++) { amps.push((rnd() * 0.22) / (1 + i * 0.4)); ph.push(rnd() * 6.283); }
      for (i = 0; i <= 160; i++) {
        t = i / 160 * Math.PI * 2; r = 0.7;
        for (var j = 0; j < 5; j++) r += amps[j] * Math.sin((j + 2) * t + ph[j]);
        add(r * Math.cos(t), r * Math.sin(t));
      }
    } else if (kind === 'walk') {    // a generative wander of straight and diagonal runs
      var gx = 0, gy = 0, steps = 7 + Math.min(10, cx * 2), D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]], dI = Math.floor(rnd() * 8);
      add(gx, gy);
      for (i = 0; i < steps; i++) {
        dI = (dI + [1, 2, 6, 7, 2, 6][Math.floor(rnd() * 6)]) % 8;
        var L = 1 + Math.floor(rnd() * 3);
        var nx = clamp(gx + D8[dI][0] * L, -4, 4), ny = clamp(gy + D8[dI][1] * L, -4, 4);
        if (nx === gx && ny === gy) continue;
        gx = nx; gy = ny; add(gx / 4, gy / 4);
      }
    } else if (kind === 'lissa') {
      var fa = 1 + Math.floor(rnd() * 2), fb = fa + 1, dl = Math.PI / 2;
      for (i = 0; i <= 200; i++) { t = i / 200 * Math.PI * 2; add(Math.sin(fa * t + dl), Math.sin(fb * t)); }
    } else {    // 'tri'
      add(0, -1); add(0.95, 0.8); add(-0.95, 0.8); add(0, -1);
    }
    return p;
  }
  var TRACE_TABLE = ['rect', 'stairs', 'tri', 'battle', 'poly', 'zigzag', 'star', 'wave', 'heart', 'spiral', 'blob', 'walk', 'rose', 'lissa'];
  var TRACE_NAMES = { rect: 'Rectangle', stairs: 'Staircase', tri: 'Triangle', battle: 'Battlements', poly: 'Polygon', zigzag: 'Zigzag', star: 'Star',
    wave: 'Wave', heart: 'Heart', spiral: 'Spiral', blob: 'Blob', walk: 'Wander', rose: 'Rose', lissa: 'Figure Eight' };
  var DIFF = { easy: { tol: 1.3, time: 1.35 }, normal: { tol: 1, time: 1 }, hard: { tol: 0.78, time: 0.8 } };
  // Level n (1-based) of Trace: the first 14 walk through every shape, then any
  // shape, more complex, a tighter tolerance and less time.
  function genTarget(level, w, h, diff) {
    level = Math.max(1, level | 0);
    var df = DIFF[diff] || DIFF.normal, rnd = mulberry32(level * 7919 + 17), kind;
    if (level <= TRACE_TABLE.length) kind = TRACE_TABLE[level - 1];
    else kind = TRACE_TABLE[2 + Math.floor(rnd() * (TRACE_TABLE.length - 2))];
    var cx = Math.min(6, Math.floor((level - 1) / 5)), raw = shapePts(kind, rnd, cx);
    // fit into the screen: margin, keep aspect for round shapes, stretch a little for others
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, i;
    for (i = 0; i < raw.length; i += 2) { minx = Math.min(minx, raw[i]); maxx = Math.max(maxx, raw[i]); miny = Math.min(miny, raw[i + 1]); maxy = Math.max(maxy, raw[i + 1]); }
    var m = Math.min(w, h) * 0.12, bw = w - 2 * m, bh = h - 2 * m, sw = maxx - minx || 1, sh = maxy - miny || 1;
    var round = /^(poly|star|heart|spiral|rose|blob|tri)$/.test(kind), kx = bw / sw, ky = bh / sh;
    if (round) { kx = ky = Math.min(kx, ky); }
    else { var kmin = Math.min(kx, ky); kx = Math.min(kx, kmin * 1.6); ky = Math.min(ky, kmin * 1.6); }
    var size = clamp(1 - (level > 20 ? 0.15 : 0) - rnd() * 0.08, 0.7, 1);
    kx *= size; ky *= size;
    var ox = w / 2 - (minx + sw / 2) * kx, oy = h / 2 - (miny + sh / 2) * ky, pts = [];
    for (i = 0; i < raw.length; i += 2) pts.push(Math.round((raw[i] * kx + ox) * 2) / 2, Math.round((raw[i + 1] * ky + oy) * 2) / 2);
    var L = polyLen(pts), corners = 0;
    for (i = 2; i < pts.length - 2; i += 2) {
      var a1 = Math.atan2(pts[i + 1] - pts[i - 1], pts[i] - pts[i - 2]), a2 = Math.atan2(pts[i + 3] - pts[i + 1], pts[i + 2] - pts[i]), da = Math.abs(a2 - a1);
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (da > 0.5) corners++;
    }
    var speed = 52 + Math.min(40, level * 2);
    var time = Math.round((L / speed + 6 + corners * 0.45) * df.time * (level > 14 ? Math.max(0.75, 1 - (level - 14) * 0.012) : 1));
    var tol = Math.max(3.2, 8.5 - level * 0.28) * df.tol;
    return { kind: kind, name: TRACE_NAMES[kind] || kind, level: level, pts: pts, len: L, time: time, tol: Math.round(tol * 10) / 10 };
  }
  // runs: array of flat polylines drawn by the player
  function scoreTrace(target, runs, tol) {
    var T = resample(target, 2), D = [], i;
    runs.forEach(function (r) { var q = resample(r, 2); for (var k = 0; k < q.length; k++) D.push(q[k]); });
    if (D.length < 4 || !T.length) return { cov: 0, acc: 0, score: 0, stars: 0 };
    var gd = new Grid(Math.max(2, tol)), gt = new Grid(Math.max(2, tol * 1.6));
    for (i = 0; i < D.length; i += 2) gd.add(D[i], D[i + 1]);
    for (i = 0; i < T.length; i += 2) gt.add(T[i], T[i + 1]);
    var hit = 0, good = 0;
    for (i = 0; i < T.length; i += 2) if (gd.near(T[i], T[i + 1], tol)) hit++;
    for (i = 0; i < D.length; i += 2) if (gt.near(D[i], D[i + 1], tol * 1.6)) good++;
    var cov = hit / (T.length / 2), acc = good / (D.length / 2);
    var score = Math.round(100 * (0.7 * cov + 0.3 * acc) * (0.4 + 0.6 * Math.min(1, cov * 1.15)));
    return { cov: cov, acc: acc, score: score, stars: starsFor(score) };
  }
  function starsFor(score) { return score >= 92 ? 3 : score >= 78 ? 2 : score >= 60 ? 1 : 0; }

  // ---- Maze ----
  function mazeSize(level, w, h) {
    var m = 14, cols = Math.min(4 + level, 40), rows, cell;
    for (;;) {
      rows = Math.max(3, Math.round(cols * (h - 2 * m) / (w - 2 * m)));
      cell = Math.min((w - 2 * m) / cols, (h - 2 * m) / rows);
      if (cell >= 15 || cols <= 4) break;
      cols--;
    }
    return { cols: cols, rows: rows, cell: cell };
  }
  // A perfect maze (iterative backtracker) seeded by seed; entrance on the left
  // edge, exit on the right. Walls are axis-aligned segments in drawing units.
  function genMaze(level, w, h, seed, diff) {
    var df = DIFF[diff] || DIFF.normal, sz = mazeSize(level, w, h), cols = sz.cols, rows = sz.rows, cell = sz.cell;
    var rnd = mulberry32(seed), N = cols * rows, seen = new Uint8Array(N), E = new Uint8Array(N), S = new Uint8Array(N);   // E[i]/S[i]: wall east / south of cell i
    var i;
    for (i = 0; i < N; i++) { E[i] = 1; S[i] = 1; }
    var stack = [Math.floor(rnd() * N)];
    seen[stack[0]] = 1;
    while (stack.length) {
      var c = stack[stack.length - 1], cx = c % cols, cy = (c / cols) | 0, opts = [];
      if (cx > 0 && !seen[c - 1]) opts.push(c - 1);
      if (cx < cols - 1 && !seen[c + 1]) opts.push(c + 1);
      if (cy > 0 && !seen[c - cols]) opts.push(c - cols);
      if (cy < rows - 1 && !seen[c + cols]) opts.push(c + cols);
      if (!opts.length) { stack.pop(); continue; }
      var nb = opts[Math.floor(rnd() * opts.length)];
      if (nb === c + 1) E[c] = 0; else if (nb === c - 1) E[nb] = 0; else if (nb === c + cols) S[c] = 0; else S[nb] = 0;
      seen[nb] = 1; stack.push(nb);
    }
    // a few extra openings on big mazes (loops make it less of a dead-end slog)
    var extra = Math.floor(N / 40);
    for (i = 0; i < extra; i++) { var r = Math.floor(rnd() * N); if (r % cols < cols - 1) E[r] = 0; }
    var ox = (w - cols * cell) / 2, oy = (h - rows * cell) / 2, inRow = Math.floor(rnd() * rows), outRow = Math.floor(rnd() * rows), walls = [];
    function wall(x1, y1, x2, y2) { walls.push([ox + x1 * cell, oy + y1 * cell, ox + x2 * cell, oy + y2 * cell]); }
    // outer frame with the two openings
    wall(0, 0, cols, 0); wall(0, rows, cols, rows);
    if (inRow > 0) wall(0, 0, 0, inRow);
    if (inRow < rows - 1) wall(0, inRow + 1, 0, rows);
    if (outRow > 0) wall(cols, 0, cols, outRow);
    if (outRow < rows - 1) wall(cols, outRow + 1, cols, rows);
    // inner walls, merged into long runs
    var y, x, run;
    for (y = 0; y < rows - 1; y++) {
      run = -1;
      for (x = 0; x <= cols; x++) {
        var on = x < cols && S[y * cols + x];
        if (on && run < 0) run = x;
        if (!on && run >= 0) { wall(run, y + 1, x, y + 1); run = -1; }
      }
    }
    for (x = 0; x < cols - 1; x++) {
      run = -1;
      for (y = 0; y <= rows; y++) {
        var on2 = y < rows && E[y * cols + x];
        if (on2 && run < 0) run = y;
        if (!on2 && run >= 0) { wall(x + 1, run, x + 1, y); run = -1; }
      }
    }
    var time = Math.round((cols * rows * 0.55 + 10) * df.time);
    return {
      level: level, cols: cols, rows: rows, cell: cell, ox: ox, oy: oy, walls: walls, inRow: inRow, outRow: outRow, time: time,
      start: { x: ox + cell * 0.5, y: oy + (inRow + 0.5) * cell },
      exit: { x: ox + cols * cell, y: oy + (outRow + 0.5) * cell }
    };
  }
  function mazeHit(mz, x, y, r) {
    for (var i = 0; i < mz.walls.length; i++) {
      var w = mz.walls[i];
      if (x < Math.min(w[0], w[2]) - r || x > Math.max(w[0], w[2]) + r || y < Math.min(w[1], w[3]) - r || y > Math.max(w[1], w[3]) + r) continue;
      if (distSeg(x, y, w[0], w[1], w[2], w[3]) < r) return true;
    }
    return false;
  }
  function mazeWon(mz, x, y) {
    return x >= mz.ox + (mz.cols - 0.25) * mz.cell && y >= mz.oy + mz.outRow * mz.cell && y <= mz.oy + (mz.outRow + 1) * mz.cell;
  }
  function mazeScore(level, timeLeft) { return 50 + level * 25 + Math.max(0, Math.round(timeLeft)) * 4; }

  // ---- saves ----
  function normSettings(o) {
    o = o && typeof o === 'object' ? o : {};
    var FR = ['red', 'blue', 'green', 'yellow', 'pink', 'black', 'teal', 'white'];
    return {
      sens: clamp(o.sens | 0 || 3, 1, 5), thick: clamp(o.thick | 0 || 2, 1, 4), frame: FR.indexOf(o.frame) >= 0 ? o.frame : 'red',
      sound: o.sound !== false, haptic: o.haptic !== false, diff: DIFF[o.diff] ? o.diff : 'normal', motion: !!o.motion
    };
  }
  function normCareer(o) {
    o = o && typeof o === 'object' ? o : {};
    var t = o.trace && typeof o.trace === 'object' ? o.trace : {}, m = o.maze && typeof o.maze === 'object' ? o.maze : {};
    var best = {}, stars = {};
    if (t.best && typeof t.best === 'object') for (var k in t.best) if (+k >= 1 && isFinite(+t.best[k])) best[+k] = clamp(+t.best[k], 0, 100);
    if (t.stars && typeof t.stars === 'object') for (var k2 in t.stars) if (+k2 >= 1) stars[+k2] = clamp(t.stars[k2] | 0, 0, 3);
    return {
      trace: { level: Math.max(1, t.level | 0 || 1), unlocked: Math.max(1, t.unlocked | 0 || 1, t.level | 0), best: best, stars: stars, streak: Math.max(0, t.streak | 0), bestStreak: Math.max(0, t.bestStreak | 0) },
      maze: { best: Math.max(0, m.best | 0), bestLevel: Math.max(0, m.bestLevel | 0), runs: Math.max(0, m.runs | 0) }
    };
  }
  function totalStars(car) { var n = 0; for (var k in car.trace.stars) n += car.trace.stars[k]; return n; }
  // record a Trace result → { pass, newBest, unlockedNext }
  function recordTrace(car, level, res) {
    var t = car.trace, pass = res.stars > 0, prev = t.best[level] || 0;
    if (res.score > prev) t.best[level] = res.score;
    if (res.stars > (t.stars[level] || 0)) t.stars[level] = res.stars;
    if (pass) { t.streak++; t.bestStreak = Math.max(t.bestStreak, t.streak); } else t.streak = 0;
    var unl = false;
    if (pass && level + 1 > t.unlocked) { t.unlocked = level + 1; unl = true; }
    t.level = pass ? level + 1 : level;
    return { pass: pass, newBest: res.score > prev, unlockedNext: unl };
  }

  var ENGINE = {
    LONG: LONG, SENS: SENS, THICK: THICK, GHOST: GHOST, DIFF: DIFF, TRACE_TABLE: TRACE_TABLE,
    clamp: clamp, mulberry32: mulberry32, noise: noise, dimsFor: dimsFor,
    newDrawing: newDrawing, nVert: nVert, tip: tip, moveTo: moveTo, markStroke: markStroke, undo: undo, shake: shake,
    inkLen: inkLen, maxStrength: maxStrength, isBlank: isBlank, segAlpha: segAlpha, visibleRuns: visibleRuns,
    encode: encode, decode: decode, refit: refit, polyLen: polyLen, resample: resample, distSeg: distSeg,
    shapePts: shapePts, genTarget: genTarget, scoreTrace: scoreTrace, starsFor: starsFor,
    mazeSize: mazeSize, genMaze: genMaze, mazeHit: mazeHit, mazeWon: mazeWon, mazeScore: mazeScore,
    normSettings: normSettings, normCareer: normCareer, totalStars: totalStars, recordTrace: recordTrace
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('etch.css');

  var PANEL_ID = 'etch-panel', NAME = 'Etch Pad';
  var KEY = 'cade-etch-', K_SET = KEY + 'settings', K_CAR = KEY + 'career', K_CUR = KEY + 'cur', K_GAL = KEY + 'gallery', K_DRAW = KEY + 'd-', K_RUN = KEY + 'mazerun', K_SEEN = KEY + 'seen';
  var GAL_MAX = 60, TAU = Math.PI * 2;
  // frame tints [light theme, dark theme, label]; 'text' / 'acc' / 'muted' follow the theme
  var FRAMES = {
    red: ['#cf3f3f', '#f06a6a', 'Red'], blue: ['#2878b5', '#7cc7f2', 'Blue'], green: ['#2f8f3a', '#7ed37a', 'Green'], yellow: ['#b07d06', '#f2c544', 'Amber'],
    pink: ['#c2457f', '#f08cbc', 'Pink'], black: ['text', 'text', 'Ink'], teal: ['acc', 'acc', 'Accent'], white: ['muted', 'muted', 'Gray']
  };
  var DUST = ['·', '.', ':', '∙', '˙', ','];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.etch = { live: function () { return S; }, E: ENGINE, png: function () { return S && renderPNG(S.d, 1).toDataURL(); }, kick: function () { kick(); } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function sjson(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function fmtT(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function starStr(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }
  function minimized() { return !!(S && Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function buzz(ms) { if (S && S.set.haptic && Cade.haptic) { try { Cade.haptic(ms); } catch (e) {} } }

  // ---- sound: tiny WebAudio voices, created on a user gesture, closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.nb = null; this.lastTick = 0; }
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
  // a rattle of aluminum powder: band-passed noise in a few bursts
  Snd.prototype.rattle = function (vol, dur) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var len = Math.floor(ac.sampleRate * 0.6), b = ac.createBuffer(1, len, ac.sampleRate), ch = b.getChannelData(0);
        for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (0.55 + 0.45 * Math.sin(i / len * Math.PI * 7) * Math.sin(i / len * Math.PI * 7));
        this.nb = b;
      }
      var src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime;
      src.buffer = this.nb; f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 0.9;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
  };
  Snd.prototype.tick = function () {
    var t = now();
    if (t - this.lastTick < 28) return;
    this.lastTick = t;
    this.tone(2300 + Math.random() * 400, 0.012, 'square', 0.006);
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');
  var IC_MENU = svg('<path d="M4 6h16M4 12h16M4 18h16"/>');
  var IC_SAVE = svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8V3M8 21v-7h8v7"/>');
  var IC_GAL = svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
  var IC_REPLAY = svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');

  var ART = '╔═╗╔╦╗╔═╗╦ ╦  ╔═╗╔═╗╔╦╗\n║╣  ║ ║  ╠═╣  ╠═╝╠═╣ ║║\n╚═╝ ╩ ╚═╝╩ ╩  ╩  ╩ ╩═╩╝';

  // ---- persistence ----
  function persistSet() { sset(K_SET, JSON.stringify(S.set)); }
  function persistCar() { sset(K_CAR, JSON.stringify(S.car)); }
  function loadGal() { var g = sjson(K_GAL); return Array.isArray(g) ? g.filter(function (x) { return x && typeof x.id === 'string'; }) : []; }
  function saveGal() { sset(K_GAL, JSON.stringify(S.gal)); }
  function saveCurNow() {
    if (!S) return;
    clearTimeout(S.curT); S.curT = 0;
    if (S.mode !== 'sketch' || S.phase === 'replay') return;
    sset(K_CUR, ENGINE.encode(S.d));
  }
  function saveCurSoon() { if (S && !S.curT) S.curT = setTimeout(saveCurNow, 900); }
  function loadCur() {
    var d = ENGINE.decode(sget(K_CUR) || '');
    return d || ENGINE.newDrawing(S.dims.w, S.dims.h);
  }

  // ---- canvases + theme ----
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
  function freeCanvas(c) { if (c) { c.width = 1; c.height = 1; } }
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
    S.col = {
      dark: dark, font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      bg: css(bg), scr: css(mix(bg, tx, dark ? 0.045 : 0.03)), text: css(tx), muted: css(mu), faint: css(fa), acc: css(ac),
      wall: css(mix(bg, tx, dark ? 0.6 : 0.55)), red: dark ? '#f06a6a' : '#cf3f3f', off: css(mix(bg, tx, dark ? 0.09 : 0.07))
    };
    S.col.frame = frameCol(S.set.frame);
  }
  function frameCol(key) {
    var f = FRAMES[key] || FRAMES.red, c = S.col.dark ? f[1] : f[0];
    return c === 'text' ? S.col.text : c === 'acc' ? S.col.acc : c === 'muted' ? S.col.muted : c;
  }

  // ---- the dot matrix: the line is drawn as braille-style dots (2 × 4 per character cell) ----
  // A view maps drawing units onto the dot grid of a screen box (x0, y0, w, h in CSS px).
  function mkView(d, x0, y0, w, h, pitch, thick) {
    var k = Math.min(w / d.w, h / d.h), bw = d.w * k, bh = d.h * k;
    var nx = Math.max(2, Math.round(bw / pitch)), ny = Math.max(4, Math.round(bh / pitch));
    return { k: k, ox: x0 + (w - bw) / 2, oy: y0 + (h - bh) / 2, bw: bw, bh: bh, px: bw / nx, py: bh / ny, nx: nx, ny: ny,
      rr: [0, 0, 0.5, 0.95, 1.45][thick] || 0, a: new Float32Array(nx * ny) };
  }
  function rasterSeg(v, x0, y0, x1, y1, al, out) {
    var fx0 = x0 * v.k / v.px, fy0 = y0 * v.k / v.py, fx1 = x1 * v.k / v.px, fy1 = y1 * v.k / v.py;
    var n = Math.max(1, Math.ceil(Math.max(Math.abs(fx1 - fx0), Math.abs(fy1 - fy0)) * 2)), R = v.rr, Ri = Math.ceil(R), R2 = (R + 0.3) * (R + 0.3);
    for (var s = 0; s <= n; s++) {
      var fx = fx0 + (fx1 - fx0) * s / n, fy = fy0 + (fy1 - fy0) * s / n;
      var ci = Math.min(v.nx - 1, Math.max(0, Math.floor(fx))), cj = Math.min(v.ny - 1, Math.max(0, Math.floor(fy)));
      for (var dj = -Ri; dj <= Ri; dj++) for (var di = -Ri; di <= Ri; di++) {
        var i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= v.nx || j >= v.ny) continue;
        if (Ri && (i + 0.5 - fx) * (i + 0.5 - fx) + (j + 0.5 - fy) * (j + 0.5 - fy) > R2) continue;
        var idx = j * v.nx + i;
        if (v.a[idx] < al) { v.a[idx] = al; if (out) out.push(idx); }
      }
    }
  }
  function rasterDrawing(v, d) {
    v.a.fill(0);
    var i, a;
    d.ghosts.forEach(function (gh) {
      for (var j = 1; j < gh.g.length; j++) { var ga = ENGINE.GHOST * gh.g[j]; if (ga > 0.02) rasterSeg(v, gh.p[2 * j - 2], gh.p[2 * j - 1], gh.p[2 * j], gh.p[2 * j + 1], ga); }
    });
    for (i = 1; i < d.s.length; i++) { a = ENGINE.segAlpha(d, i); if (a > 0.02) rasterSeg(v, d.p[2 * i - 2], d.p[2 * i - 1], d.p[2 * i], d.p[2 * i + 1], a); }
  }
  // dots, bucketed by strength: weak dots are fainter and shrink to specks
  function drawDots(c, v, list, color) {
    var b = {}, all = !list, n = all ? v.a.length : list.length, t, q;
    for (t = 0; t < n; t++) {
      var idx = all ? t : list[t], a = v.a[idx];
      if (a <= 0.02) continue;
      q = Math.max(1, Math.min(10, Math.round(a * 10)));
      (b[q] || (b[q] = [])).push(idx);
    }
    var base = Math.min(v.px, v.py);
    c.fillStyle = color;
    for (q in b) {
      var al = q / 10, r = base * (0.2 + 0.24 * Math.min(1, al * 1.5)), L = b[q];
      c.globalAlpha = al >= 1 ? 1 : 0.1 + al * 0.85;
      c.beginPath();
      for (t = 0; t < L.length; t++) {
        var x = v.ox + (L[t] % v.nx + 0.5) * v.px, y = v.oy + (((L[t] / v.nx) | 0) + 0.5) * v.py;
        c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU);
      }
      c.fill();
    }
    c.globalAlpha = 1;
  }
  // the empty character grid: one faint speck per braille cell
  function drawGrid(c, v, color) {
    c.fillStyle = color;
    c.beginPath();
    var r = Math.max(0.5, Math.min(v.px, v.py) * 0.2);
    for (var j = 2; j < v.ny; j += 4) for (var i = 1; i < v.nx; i += 2) {
      var x = v.ox + i * v.px, y = v.oy + j * v.py;
      c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU);
    }
    c.fill();
  }
  function glyphFont(c, px, font, w) { c.font = (w || 700) + ' ' + px.toFixed(1) + 'px ' + font; c.textAlign = 'center'; c.textBaseline = 'middle'; }
  // an ASCII box frame of double-line glyphs around (x, y, w, h), F px per glyph, a spaced title cut into the top
  function drawFrame(c, x, y, w, h, F, color, title, font, fill) {
    glyphFont(c, F, font);
    c.fillStyle = color;
    var hw = c.measureText('═').width || F * 0.6, x0 = x + F / 2, x1 = x + w - F / 2, y0 = y + F / 2, y1 = y + h - F / 2, i, n;
    n = Math.max(0, Math.ceil((x1 - x0) / (hw * 0.92)) - 1);
    for (i = 1; i <= n; i++) { var xx = x0 + (x1 - x0) * i / (n + 1); c.fillText('═', xx, y0); c.fillText('═', xx, y1); }
    n = Math.max(0, Math.ceil((y1 - y0) / (F * 0.8)) - 1);
    for (i = 1; i <= n; i++) { var yy = y0 + (y1 - y0) * i / (n + 1); c.fillText('║', x0, yy); c.fillText('║', x1, yy); }
    c.fillText('╔', x0, y0); c.fillText('╗', x1, y0); c.fillText('╚', x0, y1); c.fillText('╝', x1, y1);
    if (title) {
      glyphFont(c, F * 0.86, font);
      var tw = c.measureText(title).width + F * 1.2;
      if (fill) { c.fillStyle = fill; c.fillRect(x + w / 2 - tw / 2, y, tw, F); } else c.clearRect(x + w / 2 - tw / 2, y, tw, F);
      c.fillStyle = color;
      c.fillText(title, x + w / 2, y0 + 0.5);
    }
  }
  var TITLE = '≡ E T C H · P A D ≡';
  // the Trace target: a faint dotted glyph path inside its tolerance band
  function drawTarget(c, v, tr, col) {
    var tp = tr.t.pts, X = function (u) { return v.ox + u * v.k; }, Y = function (u) { return v.oy + u * v.k; }, i;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = col.acc; c.globalAlpha = 0.09; c.lineWidth = tr.t.tol * 2 * v.k;
    c.beginPath(); c.moveTo(X(tp[0]), Y(tp[1]));
    for (i = 2; i < tp.length; i += 2) c.lineTo(X(tp[i]), Y(tp[i + 1]));
    c.stroke();
    c.globalAlpha = 0.8;
    var pitch = Math.max(v.px, v.py), pts = ENGINE.resample(tp, pitch * 2.4 / v.k);
    glyphFont(c, Math.max(9, pitch * 3.4), col.font);
    c.fillStyle = col.acc;
    for (i = 0; i < pts.length; i += 2) c.fillText('·', X(pts[i]), Y(pts[i + 1]));
    glyphFont(c, Math.max(12, pitch * 4.6), col.font);
    c.fillText('◎', X(tp[tp.length - 2]), Y(tp[tp.length - 1]));
    c.globalAlpha = 1;
  }
  // maze walls in double box-drawing glyphs, joined by connectivity at the grid corners
  var BOX = { 1: '║', 4: '║', 5: '║', 2: '═', 8: '═', 10: '═', 6: '╔', 12: '╗', 3: '╚', 9: '╝', 7: '╠', 13: '╣', 14: '╦', 11: '╩', 15: '╬' };
  function drawMaze(c, v, mz, col) {
    var C = mz.cols + 1, bits = new Uint8Array(C * (mz.rows + 1)), cp = mz.cell * v.k;
    var fw = ENGINE.clamp(cp * 0.62, 8, 18), runsH = [], runsV = [];
    function ci(x) { return Math.round((x - mz.ox) / mz.cell); }
    function cj(y) { return Math.round((y - mz.oy) / mz.cell); }
    mz.walls.forEach(function (w) {
      var a = ci(w[0]), b = cj(w[1]), e = ci(w[2]), f = cj(w[3]), k;
      if (b === f) { for (k = a; k < e; k++) { bits[b * C + k] |= 2; bits[b * C + k + 1] |= 8; runsH.push([k, b]); } }
      else { for (k = b; k < f; k++) { bits[k * C + a] |= 4; bits[(k + 1) * C + a] |= 1; runsV.push([a, k]); } }
    });
    var X = function (i) { return v.ox + (mz.ox + i * mz.cell) * v.k; }, Y = function (j) { return v.oy + (mz.oy + j * mz.cell) * v.k; };
    glyphFont(c, fw, col.font);
    c.fillStyle = col.wall;
    var hw = c.measureText('═').width || fw * 0.6;
    runsH.forEach(function (r) {
      var x0 = X(r[0]), x1 = X(r[0] + 1), y = Y(r[1]), n = Math.max(0, Math.ceil((x1 - x0) / (hw * 0.9)) - 1);
      for (var i = 1; i <= n; i++) c.fillText('═', x0 + (x1 - x0) * i / (n + 1), y);
    });
    runsV.forEach(function (r) {
      var y0 = Y(r[1]), y1 = Y(r[1] + 1), x = X(r[0]), n = Math.max(0, Math.ceil((y1 - y0) / (fw * 0.78)) - 1);
      for (var i = 1; i <= n; i++) c.fillText('║', x, y0 + (y1 - y0) * i / (n + 1));
    });
    for (var j = 0; j <= mz.rows; j++) for (var i = 0; i < C; i++) { var b = bits[j * C + i]; if (b) c.fillText(BOX[b], X(i), Y(j)); }
    c.fillStyle = col.acc;
    glyphFont(c, Math.max(12, Math.min(22, cp * 0.7)), col.font);
    c.fillText('►', v.ox + (mz.exit.x * v.k) + Math.max(6, fw * 0.6), v.oy + mz.exit.y * v.k);
  }

  // ---- layout ----
  function chromeH() {
    var r = S.panel.getBoundingClientRect(), bd = S.panel.querySelector('.cade-panel-body');
    if (!r.height || !bd) return 0;
    return (r.height - bd.clientHeight) + bd.scrollHeight - (S.stage.offsetHeight || 0);
  }
  function availH(vw, vh, chrome) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !chrome) return vh - (vw <= 560 ? 200 : 220);
    var room = vh - Math.min(Math.max(0, r.top), 140), mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    if (mh > 0) room = Math.min(room, mh);
    return room - chrome - 6;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var side = vh < 520 && vw > vh * 1.2 && vw >= 480;
    S.panel.classList.toggle('et-side', side);
    var gut = side ? (solo ? 24 : 40) : phone ? (solo ? 20 : 34) : 48;
    var W = Math.floor(Math.min(vw - gut, solo ? 1000 : 660)), ch = chromeH(), ah = Math.floor(availH(vw, vh, ch));
    var F = side ? 13 : phone ? 14 : 16, CAP = 18, K, ow, oh;
    if (!side) {
      K = ENGINE.clamp(Math.round(W * 0.25), 80, 104);
      ow = W; oh = Math.max(180, ah - (K + CAP + 8));
      if (ow / oh > 1.5) ow = Math.round(oh * 1.5);
      else if (ow / oh < 0.78) oh = Math.round(ow / 0.78);
      W = ow;
    } else {
      K = ENGINE.clamp(Math.round(ah * 0.42), 80, 104);
      oh = Math.max(150, ah);
      ow = W - 2 * K - 20;
      if (ow / oh > 1.9) ow = Math.round(oh * 1.9);
      if (ow / oh < 1) oh = ow;
      W = ow + 2 * K + 20;
    }
    ow = Math.max(150, Math.floor(ow)); oh = Math.max(130, Math.floor(oh));
    var sw = ow - 2 * F, sh = oh - 2 * F, pitch = ENGINE.clamp(Math.round(Math.min(sw, sh) / 105 * 2) / 2, 2.5, 4.5);
    S.toy.style.setProperty('--et-k', K + 'px');
    S.toy.style.setProperty('--et-f', F + 'px');
    S.root.style.setProperty('--et-w', W + 'px');
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), key = [ow, oh, F, pitch, dpr].join(), changed = key !== S.layKey;
    S.layKey = key;
    S.ow = ow; S.oh = oh; S.sw = sw; S.sh = sh; S.F = F; S.pitch = pitch; S.dpr = dpr; S.K = K;
    S.cv.style.width = ow + 'px'; S.cv.style.height = oh + 'px';
    S.lay = { chrome: ch, side: side };
    S.dims = ENGINE.dimsFor(sw, sh);
    if (!S.d) { S.d = loadCur(); changed = true; }
    // a blank screen takes the shape of the new screen
    if (S.mode === 'sketch' && S.phase === 'free' && S.d && ENGINE.isBlank(S.d) && (S.d.w !== S.dims.w || S.d.h !== S.dims.h)) {
      var t = ENGINE.tip(S.d);
      S.d = ENGINE.newDrawing(S.dims.w, S.dims.h, t.x / S.d.w * S.dims.w, t.y / S.d.h * S.dims.h);
      changed = true;
    }
    if (changed || !S.paper) {
      S.cv.width = Math.round(ow * dpr); S.cv.height = Math.round(oh * dpr);
      if (!S.paper) { S.paper = mkCanvas(S.cv.width, S.cv.height); S.prev = mkCanvas(S.cv.width, S.cv.height); S.bg = mkCanvas(S.cv.width, S.cv.height); }
      else { S.paper.width = S.prev.width = S.bg.width = S.cv.width; S.paper.height = S.prev.height = S.bg.height = S.cv.height; }
      fitDrawing();
      buildBg(); rebuildPaper();
    }
    draw();
  }
  function fitDrawing() { S.v = mkView(S.d, S.F, S.F, S.sw, S.sh, S.pitch, S.set.thick); }
  function relayoutIfMoved() {
    if (!S || !S.lay || minimized()) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) layout();
  }

  // the static layer: screen, character grid, frame, and the Trace target or the maze
  function buildBg() {
    if (!S || !S.bg || !S.v) return;
    var c = S.bg.getContext('2d'), v = S.v, col = S.col;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.clearRect(0, 0, S.ow, S.oh);
    c.fillStyle = col.off; c.fillRect(S.F, S.F, S.sw, S.sh);           // outside the drawing's box (another screen shape)
    c.fillStyle = col.scr; c.fillRect(v.ox, v.oy, v.bw, v.bh);
    c.globalAlpha = col.dark ? 0.2 : 0.16; drawGrid(c, v, col.text); c.globalAlpha = 1;
    drawFrame(c, 0, 0, S.ow, S.oh, S.F, col.frame, TITLE, col.font);
    c.save(); c.beginPath(); c.rect(S.F, S.F, S.sw, S.sh); c.clip();
    if (S.mode === 'trace' && S.tr) drawTarget(c, v, S.tr, col);
    else if (S.mode === 'maze' && S.mz) drawMaze(c, v, S.mz, col);
    c.restore();
  }
  function lineW() { return ENGINE.THICK[S.set.thick]; }
  function rebuildPaper() {
    if (!S || !S.paper || !S.v) return;
    var c = S.paper.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S.paper.width, S.paper.height);
    if (S.phase === 'replay') { S.v.a.fill(0); return; }
    rasterDrawing(S.v, S.d);
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    drawDots(c, S.v, null, S.col.text);
  }
  // a new piece of line: mark its dots and draw only those that got darker
  function paperSeg(x0, y0, x1, y1, alpha) {
    var v = S.v, list = [];
    rasterSeg(v, x0, y0, x1, y1, alpha === undefined ? 1 : alpha, list);
    if (!list.length) return;
    var c = S.paper.getContext('2d');
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    for (var i = 0; i < list.length; i++) {
      var x = v.ox + (list[i] % v.nx) * v.px, y = v.oy + ((list[i] / v.nx) | 0) * v.py;
      c.clearRect(x, y, v.px, v.py);
    }
    drawDots(c, v, list, S.col.text);
  }
  // a shake knocks loose powder off: dust glyphs fall from dots that faded
  function dust(old) {
    var v = S.v, cand = [], i;
    for (i = 0; i < old.length; i++) if (old[i] - v.a[i] > 0.25) cand.push(i);
    var n = Math.min(110, cand.length);
    for (i = 0; i < n; i++) {
      var idx = cand[Math.floor(Math.random() * cand.length)];
      S.fx.push({ x: v.ox + (idx % v.nx + 0.5) * v.px, y: v.oy + (((idx / v.nx) | 0) + 0.5) * v.py, vx: (Math.random() - 0.5) * 60, vy: -Math.random() * 50,
        t: 0.45 + Math.random() * 0.45, life: 0.9, ch: DUST[Math.floor(Math.random() * DUST.length)] });
    }
    if (S.fx.length > 220) S.fx.splice(0, S.fx.length - 220);
  }
  function stepFx(dt) {
    for (var i = S.fx.length - 1; i >= 0; i--) {
      var p = S.fx[i];
      p.t -= dt; p.vy += 220 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t <= 0 || p.y > S.F + S.sh) S.fx.splice(i, 1);
    }
  }

  // ---- render ----
  var PTR = ['|', '/', '─', '\\'];
  function knobShow(kn, el) {
    if (kn.shown === kn.a) return;
    kn.shown = kn.a;
    el.style.setProperty('--a', (kn.a * 180 / Math.PI).toFixed(1) + 'deg');
    var q = ((Math.round(kn.a / (Math.PI / 4)) % 4) + 4) % 4;
    if (kn.ptr !== q) { kn.ptr = q; el.querySelector('.et-kp').textContent = PTR[q]; }
  }
  function draw() {
    if (!S || !S.ctx || !S.v) return;
    var c = S.ctx, v = S.v, col = S.col;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, S.cv.width, S.cv.height);
    c.drawImage(S.bg, 0, 0);
    c.drawImage(S.paper, 0, 0);
    if (S.fade > 0) { c.globalAlpha = Math.min(1, S.fade / 0.4); c.drawImage(S.prev, 0, 0); c.globalAlpha = 1; }
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    var pitch = Math.max(v.px, v.py);
    if (S.fx.length) {
      glyphFont(c, Math.max(10, pitch * 3.6), col.font);
      c.fillStyle = col.text;
      for (var i = 0; i < S.fx.length; i++) { var p = S.fx[i]; c.globalAlpha = Math.max(0, Math.min(1, p.t / 0.5)) * 0.85; c.fillText(p.ch, p.x, p.y); }
      c.globalAlpha = 1;
    }
    // the stylus: a blinking block cursor over the exact point
    var t = S.phase === 'replay' && S.rp ? S.rp.pt : ENGINE.tip(S.d), x = v.ox + t.x * v.k, y = v.oy + t.y * v.k;
    var solid = S.phase === 'replay' || now() - S.lastMove < 700 || S.grabK.h || S.grabK.v;
    var fs = ENGINE.clamp(pitch * 4.4, 12, 20);
    glyphFont(c, fs, col.font);
    c.fillStyle = col.acc;
    c.globalAlpha = solid ? 0.55 : S.blink ? 0.6 : 0.12;
    c.fillText('█', x, y + fs * 0.04);
    c.globalAlpha = 1;
    c.fillStyle = col.text;
    c.beginPath(); c.arc(x, y, Math.max(1.2, Math.min(v.px, v.py) * 0.5), 0, TAU); c.fill();
    if (S.mode === 'maze' && S.mzHit > 0) {
      glyphFont(c, fs * (1 + (1 - S.mzHit) * 1.2), col.font);
      c.fillStyle = col.red; c.globalAlpha = Math.min(1, S.mzHit * 2);
      c.fillText('✕', x, y);
      c.globalAlpha = 1;
    }
    if (S.flash > 0) { c.fillStyle = col.red; c.globalAlpha = S.flash * 0.18; c.fillRect(S.F, S.F, S.sw, S.sh); c.globalAlpha = 1; }
    knobShow(S.kh, S.khEl); knobShow(S.kv, S.kvEl);
  }

  // ---- loop: runs while something moves; idle otherwise ----
  var STEP = 1 / 120;
  function busy() {
    if (!S || document.hidden || minimized()) return false;
    if (S.pend.x || S.pend.y || S.fade > 0 || S.flash > 0 || S.mzHit > 0 || S.fx.length || S.phase === 'replay') return true;
    if (canDraw() && keyDirs().any) return true;
    if (S.phase === 'play' && !S.paused && !S.card) return true;
    return false;
  }
  function kick() { if (S && !S.raf && busy()) { S.last = 0; S.acc = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60;
    S.last = ts;
    S.acc = Math.min(S.acc + dt, 0.2);
    while (S.acc >= STEP) { update(STEP); S.acc -= STEP; if (!S) return; }
    stepFx(dt);
    S.fade = Math.max(0, S.fade - dt); S.flash = Math.max(0, S.flash - dt * 2.2); S.mzHit = Math.max(0, S.mzHit - dt * 1.6);
    S.hudT -= dt;
    if (S.hudT <= 0) { S.hudT = 0.2; syncHud(); }
    draw();
    if (busy()) S.raf = requestAnimationFrame(frame);
    else { syncHud(); }
  }
  function canDraw() {
    if (!S || S.card || S.paused) return false;
    return S.mode === 'sketch' ? S.phase === 'free' : S.phase === 'play';
  }
  function keyDirs() {
    var k = S.keys;
    var h = (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0), v = (k.ArrowUp || k.KeyW ? 1 : 0) - (k.ArrowDown || k.KeyS ? 1 : 0);
    return { h: h, v: v, any: !!(h || v), fine: !!(k.ShiftLeft || k.ShiftRight) };
  }
  function update(dt) {
    if (S.phase === 'replay') { stepReplay(dt); return; }
    if (canDraw()) {
      var kd = keyDirs();
      S.kbT = kd.any ? S.kbT + dt : 0;
      if (kd.any) {
        var rate = (kd.fine ? 0.22 : 1.25) * Math.min(1, 0.35 + S.kbT * 1.3) * TAU * dt;   // radians this step
        if (kd.h) turnKnob('h', kd.h * rate, false);
        if (kd.v) turnKnob('v', kd.v * rate, false);
      }
      if (S.pend.x || S.pend.y) { var mx = S.pend.x, my = S.pend.y; S.pend.x = S.pend.y = 0; moveBy(mx, my); if (!S) return; }
    } else { S.pend.x = S.pend.y = 0; }
    if (S.phase === 'play' && !S.paused && !S.card) {
      if (S.mode === 'trace') {
        var tr = S.tr, before = Math.ceil(tr.left);
        tr.left -= dt;
        if (Math.ceil(tr.left) !== before && tr.left <= 5 && tr.left > 0) S.snd.tone(990, 0.05, 'sine', 0.03);
        tr.scoreT -= dt;
        if (tr.scoreT <= 0) { tr.scoreT = 0.3; tr.live = ENGINE.scoreTrace(tr.t.pts, ENGINE.visibleRuns(S.d, 0.5), tr.t.tol); if (tr.live.cov >= 0.985 && tr.live.acc > 0.6) { finishTrace(); return; } }
        if (tr.left <= 0) { finishTrace(); return; }
      } else if (S.mode === 'maze') {
        var b2 = Math.ceil(S.run.left);
        S.run.left -= dt;
        if (Math.ceil(S.run.left) !== b2 && S.run.left <= 5 && S.run.left > 0) S.snd.tone(990, 0.05, 'sine', 0.03);
        if (S.run.left <= 0) { mazeTimeout(); return; }
      }
    }
  }
  // turning a knob by dA radians (clockwise > 0): the left knob moves the stylus right, the right knob up
  function turnKnob(which, dA, fine) {
    var kn = which === 'h' ? S.kh : S.kv;
    kn.a += dA;
    var units = dA / TAU * ENGINE.SENS[S.set.sens] * (fine ? 0.25 : 1);
    if (which === 'h') S.pend.x += units; else S.pend.y -= units;
    kn.tk += Math.abs(dA);
    if (kn.tk >= Math.PI / 12) { kn.tk %= Math.PI / 12; S.snd.tick(); if (S.coarse) buzz(3); }
  }
  function moveBy(dx, dy) {
    var d = S.d, t = now();
    if (t - S.lastMove > 380) ENGINE.markStroke(d);
    S.lastMove = t;
    var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 1.5)), sx = dx / n, sy = dy / n;
    for (var i = 0; i < n; i++) {
      var p = ENGINE.tip(d), nx = p.x + sx, ny = p.y + sy;
      if (S.mode === 'maze') {
        var r = lineW() / 2 + 0.7;
        if (ENGINE.mazeHit(S.mz, nx, ny, r)) { mazeBump(); return; }
        if (S.mzContact && !ENGINE.mazeHit(S.mz, nx, ny, r + 1.5)) S.mzContact = false;
      }
      if (ENGINE.moveTo(d, nx, ny)) {
        var q = ENGINE.tip(d);
        paperSeg(p.x, p.y, q.x, q.y, 1);
      }
      if (S.mode === 'maze' && ENGINE.mazeWon(S.mz, ENGINE.tip(d).x, ENGINE.tip(d).y)) { mazeClear(); return; }
    }
    if (S.mode === 'sketch') saveCurSoon();
  }

  // ---- shaking ----
  function animShake(big) {
    var t = S.toy;
    t.classList.remove('et-shaking', 'et-shaking-s');
    void t.offsetWidth;
    t.classList.add(big ? 'et-shaking' : 'et-shaking-s');
    clearTimeout(S.shkT);
    S.shkT = setTimeout(function () { if (S) S.toy.classList.remove('et-shaking', 'et-shaking-s'); }, 520);
  }
  function canShake() { return !S.card && !S.paused && (S.mode === 'sketch' ? S.phase === 'free' || S.phase === 'replay' : S.phase === 'play'); }
  function doShake(power, src) {
    if (!S || !canShake()) return;
    S.snd.ensure();
    if (S.phase === 'replay') endReplay();
    if (src !== 'grab') animShake(power >= 0.4);
    var pc = S.prev.getContext('2d');
    pc.setTransform(1, 0, 0, 1, 0, 0); pc.clearRect(0, 0, S.prev.width, S.prev.height); pc.drawImage(S.paper, 0, 0);
    var old = S.v.a.slice(), res = ENGINE.shake(S.d, (S.seed = (S.seed + 7919) >>> 0), power), refit = false;
    if (res.cleared && S.mode === 'sketch' && (S.d.w !== S.dims.w || S.d.h !== S.dims.h)) {
      var t = ENGINE.tip(S.d);
      S.d = ENGINE.newDrawing(S.dims.w, S.dims.h, t.x / S.d.w * S.dims.w, t.y / S.d.h * S.dims.h);
      fitDrawing(); buildBg(); refit = true;
    }
    rebuildPaper();
    if (!refit) dust(old);
    S.fade = 0.4;
    S.snd.rattle(src === 'grab' ? 0.05 : 0.09, src === 'grab' ? 0.22 : 0.42);
    buzz(src === 'grab' ? 12 : 30);
    if (S.mode === 'trace' && S.tr) S.tr.scoreT = 0;
    if (S.mode === 'sketch') saveCurSoon();
    if (res.cleared) live('Screen clear');
    S.shakes++;
    kick(); syncHud();
  }
  function doUndo() {
    if (!S || !canDraw() || S.mode === 'maze') return;
    if (ENGINE.undo(S.d)) { rebuildPaper(); S.snd.tone(520, 0.05, 'triangle', 0.03, 380); if (S.mode === 'sketch') saveCurSoon(); if (S.tr) S.tr.scoreT = 0; draw(); syncHud(); }
    else S.snd.tone(200, 0.06, 'sine', 0.02);
  }

  // phone shake (DeviceMotion; iOS asks permission on a tap)
  function motionNeedsAsk() { return typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'; }
  function motionSupported() { return typeof window.DeviceMotionEvent !== 'undefined'; }
  function attachMotion() {
    if (!S || S.onMotion) return;
    S.onMotion = function (e) {
      if (!S || minimized() || document.hidden) return;
      var a = e.acceleration, m;
      if (a && a.x !== null && a.x !== undefined) m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      else {
        var g = e.accelerationIncludingGravity;
        if (!g || g.x === null) return;
        m = Math.abs(Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z) - 9.81);
      }
      var t = now();
      if (m > 13 && t - S.motionT > 260) { S.motionT = t; doShake(0.42, 'motion'); }
    };
    window.addEventListener('devicemotion', S.onMotion);
  }
  function detachMotion() { if (S && S.onMotion) { window.removeEventListener('devicemotion', S.onMotion); S.onMotion = null; } }
  function enableMotion(fromTap) {
    if (!motionSupported()) { Cade.showToast && Cade.showToast('No motion sensor here', 'info', 1800); return; }
    if (motionNeedsAsk()) {
      if (!fromTap) return;
      try {
        DeviceMotionEvent.requestPermission().then(function (st) {
          if (!S) return;
          if (st === 'granted') { S.motionOk = true; attachMotion(); }
          else { S.set.motion = false; persistSet(); Cade.showToast && Cade.showToast('Motion access was not allowed', 'info', 2200); if (S.card === 'settings') showCard('settings'); }
        }, function () {});
      } catch (e) {}
    } else attachMotion();
  }

  // ---- replay: the drawing re-drawn, knobs turning ----
  function startReplay() {
    if (!S || S.mode !== 'sketch') return;
    var d = S.d, n = ENGINE.nVert(d);
    if (ENGINE.inkLen(d) < 4) { Cade.showToast && Cade.showToast('Nothing to replay yet', 'info', 1600); return; }
    closeCard();
    var cum = [0];
    for (var i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(d.p[2 * i] - d.p[2 * i - 2], d.p[2 * i + 1] - d.p[2 * i - 1]));
    var L = cum[n - 1];
    S.rp = { cum: cum, L: L, dur: ENGINE.clamp(L / 260, 1.6, 12), t: 0, i: 1, pt: { x: d.p[0], y: d.p[1] }, kh0: S.kh.a, kv0: S.kv.a, x0: d.p[0], y0: d.p[1] };
    S.phase = 'replay';
    var c = S.paper.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, S.paper.width, S.paper.height);
    setMid(); syncHud(); kick();
  }
  function stepReplay(dt) {
    var rp = S.rp, d = S.d;
    rp.t += dt;
    var target = Math.min(rp.L, rp.t / rp.dur * rp.L), n = ENGINE.nVert(d);
    while (rp.i < n) {
      var i = rp.i, ax = d.p[2 * i - 2], ay = d.p[2 * i - 1], bx = d.p[2 * i], by = d.p[2 * i + 1], a = ENGINE.segAlpha(d, i);
      if (rp.cum[i] <= target) {
        if (a > 0.01) paperSeg(rp.pt.x, rp.pt.y, bx, by, a);
        rp.pt = { x: bx, y: by }; rp.i++;
      } else {
        var f = (target - rp.cum[i - 1]) / Math.max(1e-6, rp.cum[i] - rp.cum[i - 1]), px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
        if (a > 0.01 && Math.hypot(px - rp.pt.x, py - rp.pt.y) > 0.05) paperSeg(rp.pt.x, rp.pt.y, px, py, a);
        rp.pt = { x: px, y: py };
        break;
      }
    }
    var upt = ENGINE.SENS[S.set.sens];
    S.kh.a = rp.kh0 + (rp.pt.x - rp.x0) / upt * TAU;
    S.kv.a = rp.kv0 - (rp.pt.y - rp.y0) / upt * TAU;
    if (rp.i >= n || rp.t >= rp.dur + 0.05) endReplay();
  }
  function endReplay() {
    if (!S || S.phase !== 'replay') return;
    S.phase = 'free'; S.rp = null;
    rebuildPaper(); setMid(); syncHud(); draw();
  }

  // ---- gallery / export ----
  // the ASCII version, as a picture: framed dot-matrix screen, dials drawn as glyphs underneath
  function renderPNG(d, scale) {
    scale = scale || 2;
    var col = S.col, F = 16 * scale, sw = d.w * 1.4 * scale, sh = d.h * 1.4 * scale, ow = sw + 2 * F, oh = sh + 2 * F, foot = 3.4 * F;
    var c = mkCanvas(ow + 2 * F, oh + foot + 2 * F), x = c.getContext('2d'), X0 = F, Y0 = F;
    x.fillStyle = col.bg; x.fillRect(0, 0, c.width, c.height);
    var v = mkView(d, X0 + F, Y0 + F, sw, sh, 3 * scale, S.set.thick);
    x.fillStyle = col.scr; x.fillRect(v.ox, v.oy, v.bw, v.bh);
    x.globalAlpha = col.dark ? 0.2 : 0.16; drawGrid(x, v, col.text); x.globalAlpha = 1;
    drawFrame(x, X0, Y0, ow, oh, F, col.frame, TITLE, col.font, col.bg);
    rasterDrawing(v, d);
    drawDots(x, v, null, col.text);
    // the two dials
    var ky = Y0 + oh + foot / 2, kr = foot * 0.36;
    [[X0 + F * 2.4, '─', '◄ ►'], [X0 + ow - F * 2.4, '│', '▲ ▼']].forEach(function (k) {
      x.fillStyle = col.muted;
      glyphFont(x, F * 0.8, col.font, 500);
      for (var i = 0; i < 12; i++) { var a = i / 12 * TAU; x.fillText(i % 3 ? '·' : '+', k[0] + Math.sin(a) * kr, ky - Math.cos(a) * kr); }
      x.fillStyle = col.frame; glyphFont(x, F * 1.3, col.font); x.fillText(k[1], k[0], ky);
    });
    x.fillStyle = col.faint; glyphFont(x, F * 0.7, col.font, 500);
    x.fillText('cade.txt', X0 + ow / 2, ky);
    return c;
  }
  function toBlob(c) {
    return new Promise(function (res) { try { c.toBlob(function (b) { res(b || null); }, 'image/png'); } catch (e) { res(null); } });
  }
  function stamp() { var t = new Date(); function z(n) { return ('0' + n).slice(-2); } return t.getFullYear() + z(t.getMonth() + 1) + z(t.getDate()) + '-' + z(t.getHours()) + z(t.getMinutes()); }
  function exportPNG(d) {
    if (ENGINE.inkLen(d) < 1) { Cade.showToast && Cade.showToast('Nothing drawn yet', 'info', 1600); return; }
    toBlob(renderPNG(d, 2)).then(function (b) {
      if (!b) { Cade.showToast && Cade.showToast('Could not render the PNG', 'error', 2200); return; }
      var a = document.createElement('a'), u = URL.createObjectURL(b);
      a.href = u; a.download = 'etch-pad-' + stamp() + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
      Cade.showToast && Cade.showToast('PNG saved', 'success', 1500);
    });
  }
  function insertNote(d) {
    if (typeof window.insertImageFile !== 'function') { Cade.showToast && Cade.showToast('Images can’t be inserted here', 'error', 2200); return; }
    if (ENGINE.inkLen(d) < 1) { Cade.showToast && Cade.showToast('Nothing drawn yet', 'info', 1600); return; }
    toBlob(renderPNG(d, 1.5)).then(function (b) {
      if (!b) { Cade.showToast && Cade.showToast('Could not render the image', 'error', 2200); return; }
      var f;
      try { f = new File([b], 'etch-pad-' + stamp() + '.png', { type: 'image/png' }); } catch (e) { b.name = 'etch-pad.png'; f = b; }
      try { Promise.resolve(window.insertImageFile(f)).catch(function () {}); } catch (e) {}
    });
  }
  function saveToGallery() {
    var d = S.d;
    if (ENGINE.inkLen(d) < 5) { Cade.showToast && Cade.showToast('Draw something first', 'info', 1600); return false; }
    var enc = ENGINE.encode(d);
    if (S.gal.length && S.gal[0].sig === enc.length + ':' + enc.slice(-24)) { Cade.showToast && Cade.showToast('Already saved', 'info', 1400); return false; }
    if (S.gal.length >= GAL_MAX) { Cade.showToast && Cade.showToast('Gallery full — delete a few first', 'error', 2400); return false; }
    var cnt = (+sget(KEY + 'count') || 0) + 1;
    sset(KEY + 'count', cnt);
    var id = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    sset(K_DRAW + id, enc);
    S.gal.unshift({ id: id, name: 'Sketch ' + cnt, t: Date.now(), sig: enc.length + ':' + enc.slice(-24) });
    saveGal();
    S.snd.tone(880, 0.06, 'sine', 0.04); S.snd.tone(1320, 0.08, 'sine', 0.035, 0, 0.07);
    Cade.showToast && Cade.showToast('Saved to the gallery', 'success', 1500);
    return true;
  }
  function galDrawing(id) { return ENGINE.decode(sget(K_DRAW + id) || ''); }
  function drawThumb(cv, d) {
    var dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 88, H = cv.clientHeight || 64;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var x = cv.getContext('2d');
    x.fillStyle = S.col.scr; x.fillRect(0, 0, cv.width, cv.height);
    if (!d) return;
    var v = mkView(d, 2 * dpr, 2 * dpr, cv.width - 4 * dpr, cv.height - 4 * dpr, 1.5 * dpr, 2);
    rasterDrawing(v, d);
    drawDots(x, v, null, S.col.text);
  }

  // ---- modes ----
  function toSketch() {
    stopLoop();
    S.mode = 'sketch'; S.phase = 'free'; S.paused = false; S.tr = null; S.mz = null; S.run = null;
    S.d = loadCur();
    fitDrawing(); buildBg(); rebuildPaper();
    closeCard(); setMid(); syncHud(); syncHead(); draw();
  }
  function leaveSketch() { if (S.mode === 'sketch') { if (S.phase === 'replay') endReplay(); saveCurNow(); } }
  function newPaper(x, y) {
    S.d = ENGINE.newDrawing(S.dims.w, S.dims.h, x, y);
    fitDrawing();
  }
  // Trace
  function startTrace(level) {
    leaveSketch(); stopLoop();
    level = ENGINE.clamp(level | 0, 1, S.car.trace.unlocked);
    S.mode = 'trace'; S.phase = 'ready'; S.paused = false; S.mz = null; S.run = null;
    var t = ENGINE.genTarget(level, S.dims.w, S.dims.h, S.set.diff);
    newPaper(t.pts[0], t.pts[1]);
    S.tr = { t: t, level: level, left: t.time, scoreT: 0, live: { cov: 0, acc: 0, score: 0, stars: 0 }, res: null };
    S.car.trace.level = level; persistCar();
    buildBg(); rebuildPaper(); setMid(); syncHud(); syncHead(); draw();
    showCard('trace-ready');
  }
  function goPlay() {
    closeCard();
    S.phase = 'play'; S.paused = false; S.lastMove = 0;
    S.snd.ensure(); S.snd.tone(660, 0.07, 'sine', 0.04); S.snd.tone(990, 0.09, 'sine', 0.04, 0, 0.08);
    setMid(); syncHead(); syncHud(); kick();
  }
  function finishTrace() {
    if (!S || S.mode !== 'trace' || S.phase !== 'play') return;
    var tr = S.tr;
    S.phase = 'done'; S.paused = false;
    tr.res = ENGINE.scoreTrace(tr.t.pts, ENGINE.visibleRuns(S.d, 0.5), tr.t.tol);
    tr.rec = ENGINE.recordTrace(S.car, tr.level, tr.res);
    persistCar();
    if (tr.rec.pass) {
      for (var i = 0; i < tr.res.stars; i++) S.snd.tone(990 + i * 330, 0.12, 'sine', 0.045, 0, i * 0.12);
      buzz(20);
    } else { S.snd.tone(330, 0.2, 'triangle', 0.04, 200); buzz(40); }
    setMid(); syncHead(); syncHud(); draw();
    showCard('trace-done');
  }
  // Maze
  function startRun(cont) {
    leaveSketch(); stopLoop();
    var saved = cont ? sjson(K_RUN) : null;
    S.run = saved && saved.level >= 1 && saved.lives >= 1 ? { level: saved.level | 0, lives: saved.lives | 0, score: saved.score | 0, seed: saved.seed >>> 0, left: 0 } :
      { level: 1, lives: 3, score: 0, seed: (Math.random() * 4294967295) >>> 0, left: 0 };
    S.mode = 'maze'; S.tr = null;
    startMaze('');
  }
  function startMaze(note) {
    var run = S.run;
    S.mz = ENGINE.genMaze(run.level, S.dims.w, S.dims.h, (run.seed + run.level * 1013) >>> 0, S.set.diff);
    newPaper(S.mz.start.x, S.mz.start.y);
    run.left = S.mz.time; S.mzContact = false; S.mzHit = 0;
    S.phase = 'ready'; S.paused = false;
    sset(K_RUN, JSON.stringify({ level: run.level, lives: run.lives, score: run.score, seed: run.seed }));
    buildBg(); rebuildPaper(); setMid(); syncHud(); syncHead(); draw();
    S.mzNote = note || '';
    showCard('maze-ready');
  }
  function mazeBump() {
    if (S.mzContact) return;
    S.mzContact = true;
    S.run.lives--;
    S.flash = 1; S.mzHit = 1;
    animShake(false);
    S.snd.tone(150, 0.22, 'sawtooth', 0.05, 70); buzz(45);
    live('Wall! ' + S.run.lives + ' left');
    syncHud();
    if (S.run.lives <= 0) mazeOver();
  }
  function mazeTimeout() {
    S.run.lives--;
    S.snd.tone(300, 0.25, 'triangle', 0.04, 150); buzz(40);
    if (S.run.lives <= 0) { mazeOver(); return; }
    startMaze('Out of time — one heart lost. Same maze, fresh clock.');
  }
  function mazeClear() {
    var run = S.run, gain = ENGINE.mazeScore(run.level, run.left);
    run.score += gain; S.mzGain = gain;
    run.level++;
    var bonus = run.level % 5 === 1 && run.lives < 5;
    if (bonus) run.lives++;
    S.mzBonus = bonus;
    var m = S.car.maze;
    if (run.score > m.best) m.best = run.score;
    if (run.level - 1 > m.bestLevel) m.bestLevel = run.level - 1;
    persistCar();
    sset(K_RUN, JSON.stringify({ level: run.level, lives: run.lives, score: run.score, seed: run.seed }));
    S.phase = 'done';
    [660, 880, 1320].forEach(function (f, i) { S.snd.tone(f, 0.1, 'sine', 0.045, 0, i * 0.08); });
    buzz(20);
    setMid(); syncHud(); syncHead(); draw();
    showCard('maze-clear');
  }
  function mazeOver() {
    var run = S.run, m = S.car.maze;
    S.phase = 'done';
    m.runs++;
    S.mzNewBest = run.score > 0 && run.score >= m.best;
    if (run.score > m.best) m.best = run.score;
    persistCar();
    sdel(K_RUN);
    S.snd.tone(260, 0.35, 'triangle', 0.05, 110);
    setMid(); syncHud(); syncHead(); draw();
    showCard('maze-over');
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.keys = {};
    showCard('pause'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; closeCard(); syncHead(); kick();
  }

  // ---- HUD, mid buttons, header ----
  function syncHud() {
    if (!S) return;
    var h = '';
    if (S.mode === 'sketch') {
      var ink = Math.round(ENGINE.inkLen(S.d));
      h = '<b class="et-m">SKETCH</b><span>ink <b>' + (ink >= 10000 ? (ink / 1000).toFixed(1) + 'k' : ink) + '</b></span>' + (S.phase === 'replay' ? '<span class="et-hl">replaying…</span>' : '');
    } else if (S.mode === 'trace' && S.tr) {
      var tr = S.tr, lv = tr.live || {};
      h = '<b class="et-m">TRACE <i>L' + tr.level + '</i></b><span>' + esc(tr.t.name) + '</span><span class="' + (tr.left <= 5 && S.phase === 'play' ? 'et-hl' : '') + '">⏱ <b>' + fmtT(tr.left) + '</b></span>' +
        '<span>' + Math.round((lv.cov || 0) * 100) + '%</span><span class="et-stars">' + starStr(lv.stars || 0) + '</span>' + (S.car.trace.streak ? '<span>×' + S.car.trace.streak + '</span>' : '');
    } else if (S.mode === 'maze' && S.run) {
      var hearts = '';
      for (var i = 0; i < Math.max(3, S.run.lives); i++) hearts += i < S.run.lives ? '♥' : '♡';
      h = '<b class="et-m">MAZE <i>' + S.run.level + '</i></b><span class="et-hearts">' + hearts + '</span><span class="' + (S.run.left <= 5 && S.phase === 'play' ? 'et-hl' : '') + '">⏱ <b>' + fmtT(S.run.left) + '</b></span><span><b>' + S.run.score + '</b> pts</span>';
    }
    if (h !== S.hudHtml) { S.hudHtml = h; S.hud.innerHTML = h; }
    var sk = S.mode === 'sketch';
    S.acts.querySelectorAll('[data-sk]').forEach(function (b) { b.style.display = sk ? '' : 'none'; });
  }
  function setMid() {
    var h = '', k = S.coarse ? '' : '<small>space</small>';
    if (S.mode === 'sketch' && S.phase === 'replay') h = '<button type="button" class="et-btn et-shk" data-act="stop-replay">Stop replay</button>';
    else {
      h = '<button type="button" class="et-btn et-shk" data-act="shake" aria-label="Shake to erase">Shake ' + k + '</button><div class="et-row">';
      if (S.mode !== 'maze') h += '<button type="button" class="et-btn et-sm" data-act="undo" title="Undo last stroke (Z)" aria-label="Undo last stroke">' + IC_UNDO + '</button>';
      if (S.mode === 'trace' && S.phase === 'play') h += '<button type="button" class="et-btn et-sm et-done" data-act="done" title="Score it (Enter)">Done</button>';
      if (S.mode !== 'sketch') h += '<button type="button" class="et-btn et-sm" data-act="pause" title="Pause (P)" aria-label="Pause">' + IC_PAUSE + '</button>';
      h += '</div>';
    }
    if (h !== S.midHtml) { S.midHtml = h; S.mid.innerHTML = h; }
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function applyFrame() {
    if (!S.col) return;
    S.col.frame = frameCol(S.set.frame);
    S.toy.style.setProperty('--et-frame', S.col.frame);
    if (S.v) { buildBg(); draw(); }
  }
  function live(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- cards ----
  function keysHtml() {
    return S.coarse ?
      '<div><b>circle a knob</b> &nbsp;with your thumb to turn it — both at once for diagonals</div><div><b>left knob</b> &nbsp;moves the point ← →, <b>right knob</b> &nbsp;↑ ↓</div><div><b>Shake</b> &nbsp;erases a bit each time, or shake the phone / jiggle the handle on top</div>' :
      '<div><b>← → / A D</b> &nbsp;left knob &nbsp; <b>↑ ↓ / W S</b> &nbsp;right knob &nbsp; <b>Shift</b> &nbsp;fine</div><div><b>drag round a knob</b> or <b>scroll</b> over it to turn it</div><div><b>Space</b> &nbsp;shake &nbsp; <b>Z</b> &nbsp;undo &nbsp; <b>R</b> &nbsp;replay &nbsp; <b>G</b> &nbsp;gallery &nbsp; <b>M</b> &nbsp;modes</div><div><b>Enter</b> &nbsp;done (Trace) &nbsp; <b>P / Esc</b> &nbsp;pause</div>';
  }
  function helpHtml() {
    return '<div class="et-card"><pre class="et-art" aria-hidden="true">' + esc(ART) + '</pre>' +
      '<p>Two knobs, one point, one line that never lifts. Turn the <b>left knob</b> to move it sideways and the <b>right knob</b> to move it up and down — turn both together for slants and curves.</p>' +
      '<div class="et-keys">' + keysHtml() + '</div>' +
      '<p><b>Shake</b> to erase: each shake clears only part of the powder, and a faint ghost lingers like the real thing. <b>Trace</b> a faint shape against the clock, or steer through a <b>Maze</b> without touching the walls.</p>' +
      '<button type="button" class="et-go" data-act="close-help" data-primary="1">' + (S.firstRun ? 'Let’s draw' : 'Back') + '</button></div>';
  }
  function menuHtml() {
    var t = S.car.trace, m = S.car.maze, run = sjson(K_RUN), lv = ENGINE.clamp(S.pickLv || t.level, 1, t.unlocked);
    S.pickLv = lv;
    var tg = ENGINE.genTarget(lv, S.dims.w, S.dims.h, S.set.diff);
    return '<div class="et-card"><pre class="et-art" aria-hidden="true">' + esc(ART) + '</pre>' +
      '<button type="button" class="et-mode" data-act="m-sketch"' + (S.mode === 'sketch' ? ' data-primary="1"' : '') + '><b>✎ Sketch</b><span>Free drawing — your screen is kept</span></button>' +
      '<div class="et-mode et-mode2"><button type="button" class="et-mode-in" data-act="m-trace"><b>◇ Trace</b><span>Level ' + lv + ' · ' + esc(tg.name) + ' · best ' + (t.best[lv] ? t.best[lv] + ' ' + starStr(t.stars[lv] || 0) : '—') + '</span></button>' +
      '<span class="et-step"><button type="button" class="et-sq" data-act="lv-prev" aria-label="Previous level"' + (lv <= 1 ? ' disabled' : '') + '>&lt;</button><button type="button" class="et-sq" data-act="lv-next" aria-label="Next level"' + (lv >= t.unlocked ? ' disabled' : '') + '>&gt;</button></span></div>' +
      (run ? '<button type="button" class="et-mode" data-act="m-maze-cont"><b>▦ Maze — continue</b><span>Maze ' + run.level + ' · ' + '♥'.repeat(Math.max(0, Math.min(5, run.lives))) + ' · ' + run.score + ' pts</span></button>' : '') +
      '<button type="button" class="et-mode" data-act="m-maze"><b>▦ Maze' + (run ? ' — new run' : '') + '</b><span>Endless mazes, 3 hearts · best ' + (m.best ? m.best + ' pts (maze ' + m.bestLevel + ')' : '—') + '</span></button>' +
      '<div class="et-meta">★ ' + ENGINE.totalStars(S.car) + ' stars · best streak ' + t.bestStreak + ' · unlocked L' + t.unlocked + '</div>' +
      '<div class="et-btns"><button type="button" class="et-go alt" data-act="gallery">Gallery</button><button type="button" class="et-go alt" data-act="settings">Settings</button><button type="button" class="et-go alt" data-act="help">Help</button></div>' +
      '<button type="button" class="et-go" data-act="close"' + (S.mode !== 'sketch' ? ' data-primary="1"' : '') + '>Back</button></div>';
  }
  function chips(name, opts, cur) {
    return '<div class="et-chips">' + opts.map(function (o) {
      return '<button type="button" class="et-chip' + (String(o[0]) === String(cur) ? ' on' : '') + '" data-set="' + name + '" data-v="' + o[0] + '"' + (o[2] ? ' style="--sw:' + o[2] + '"' : '') + '>' + (o[2] ? '<i class="et-sw"></i>' : '') + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function settingsHtml() {
    var st = S.set, fr = [];
    for (var k in FRAMES) fr.push([k, FRAMES[k][2], frameCol(k)]);
    var mo = '';
    if (motionSupported()) {
      mo = '<div class="et-sec"><div class="et-h">Shake the phone to erase</div>' +
        chips('motion', [[0, 'Off'], [1, motionNeedsAsk() && !S.motionOk ? 'Enable (asks)' : 'On']], st.motion ? 1 : 0) + '</div>';
    }
    return '<div class="et-card"><div class="et-title">SETTINGS</div>' +
      '<div class="et-sec"><div class="et-h">Knob sensitivity <i>units per turn</i></div>' + chips('sens', [[1, 'Slow'], [2, '2'], [3, 'Normal'], [4, '4'], [5, 'Fast']], st.sens) + '</div>' +
      '<div class="et-sec"><div class="et-h">Line</div>' + chips('thick', [[1, 'Fine'], [2, 'Normal'], [3, 'Bold'], [4, 'Heavy']], st.thick) + '</div>' +
      '<div class="et-sec"><div class="et-h">Frame color</div>' + chips('frame', fr, st.frame) + '</div>' +
      '<div class="et-sec"><div class="et-h">Game difficulty <i>Trace tolerance &amp; time, Maze time</i></div>' + chips('diff', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], st.diff) + '</div>' +
      '<div class="et-sec"><div class="et-h">Sound &amp; feel</div>' + chips('sound', [[1, 'Sound on'], [0, 'Muted']], st.sound ? 1 : 0) + chips('haptic', [[1, 'Vibration on'], [0, 'Off']], st.haptic ? 1 : 0) + '</div>' +
      mo +
      '<div class="et-foot">' + (S.resetArm ? '<span>Reset Trace &amp; Maze records?</span><button type="button" class="et-lnk danger" data-act="reset-yes">Reset</button><button type="button" class="et-lnk" data-act="reset-no">Keep</button>' :
        '<button type="button" class="et-lnk" data-act="reset">Reset records…</button>') + '</div>' +
      '<button type="button" class="et-go" data-act="close" data-primary="1">Done</button></div>';
  }
  function galleryHtml() {
    var canIns = typeof window.insertImageFile === 'function', h = '<div class="et-card et-galc"><div class="et-title">GALLERY</div>';
    if (S.mode === 'sketch') {
      h += '<div class="et-sub">The screen now</div><div class="et-btns">' +
        '<button type="button" class="et-go" data-act="g-save">Save</button><button type="button" class="et-go alt" data-act="g-png">PNG</button>' +
        (canIns ? '<button type="button" class="et-go alt" data-act="g-note">Insert into note</button>' : '') + '</div>';
    }
    h += '<div class="et-sub">Saved · ' + S.gal.length + '/' + GAL_MAX + (S.mode === 'sketch' ? ' <span>— Load replaces the screen</span>' : '') + '</div>';
    if (!S.gal.length) h += '<p class="et-note">Nothing saved yet. Drawings are stored as compact lines, so they stay small.</p>';
    else {
      h += '<div class="et-gal">';
      S.gal.forEach(function (g) {
        var dt = new Date(g.t), when = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        h += '<div class="et-tile"><canvas class="et-th" data-th="' + esc(g.id) + '"></canvas><div class="et-tn"><b>' + esc(g.name) + '</b><span>' + esc(when) + '</span></div><div class="et-tb">' +
          (S.mode === 'sketch' ? '<button type="button" data-g="load" data-id="' + esc(g.id) + '">Load</button><button type="button" data-g="play" data-id="' + esc(g.id) + '" title="Load and replay">▶</button>' : '') +
          '<button type="button" data-g="png" data-id="' + esc(g.id) + '">PNG</button>' +
          (canIns ? '<button type="button" data-g="note" data-id="' + esc(g.id) + '" title="Insert into note">Note</button>' : '') +
          '<button type="button" data-g="del" data-id="' + esc(g.id) + '" class="' + (S.delArm === g.id ? 'danger' : '') + '">' + (S.delArm === g.id ? 'Sure?' : 'Del') + '</button></div></div>';
      });
      h += '</div>';
    }
    return h + '<button type="button" class="et-go" data-act="close" data-primary="1">Back</button></div>';
  }
  function traceReadyHtml() {
    var tr = S.tr, t = tr.t, b = S.car.trace.best[tr.level];
    return '<div class="et-card"><div class="et-title">TRACE · LEVEL ' + tr.level + '</div>' +
      '<div class="et-big">' + esc(t.name) + '</div>' +
      '<div class="et-sub">⏱ ' + fmtT(t.time) + ' &nbsp;·&nbsp; tolerance ' + t.tol + ' &nbsp;·&nbsp; best ' + (b ? b + ' ' + starStr(S.car.trace.stars[tr.level] || 0) : '—') + '</div>' +
      '<p>Follow the faint dashed shape from where the point sits now. Cover all of it and stay on it: <b>60</b> passes ★, <b>78</b> ★★, <b>92</b> ★★★. Press <b>Done</b> when you’re finished.</p>' +
      '<div class="et-btns"><button type="button" class="et-go" data-act="go" data-primary="1">Let’s trace</button><button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function traceDoneHtml() {
    var tr = S.tr, r = tr.res, rec = tr.rec, t = S.car.trace;
    return '<div class="et-card"><div class="et-title">' + (rec.pass ? 'NICE LINE' : 'NOT QUITE') + '</div>' +
      '<div class="et-big">' + r.score + ' <small>/ 100</small></div><div class="et-big et-stars">' + starStr(r.stars) + '</div>' +
      '<pre class="et-tab">coverage  ' + ('   ' + Math.round(r.cov * 100)).slice(-3) + '%\naccuracy  ' + ('   ' + Math.round(r.acc * 100)).slice(-3) + '%\nbest L' + tr.level + '   ' + ('   ' + (t.best[tr.level] || 0)).slice(-3) + '\nstreak    ' + ('   ' + t.streak).slice(-3) + '</pre>' +
      (rec.newBest && r.score ? '<div class="et-new">New best for this level!</div>' : '') +
      (rec.unlockedNext ? '<div class="et-new">Level ' + (tr.level + 1) + ' unlocked</div>' : '') +
      (rec.pass ? '' : '<p class="et-note">Score 60 (one star) to pass. Cover the whole shape — staying on it counts too.</p>') +
      '<div class="et-btns">' + (rec.pass ? '<button type="button" class="et-go" data-act="next" data-primary="1">Next level</button><button type="button" class="et-go alt" data-act="retry">Retry</button>' :
        '<button type="button" class="et-go" data-act="retry" data-primary="1">Try again</button>') +
      '<button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function mazeReadyHtml() {
    var run = S.run, mz = S.mz;
    return '<div class="et-card"><div class="et-title">MAZE ' + run.level + '</div>' +
      '<div class="et-sub">' + mz.cols + '×' + mz.rows + ' &nbsp;·&nbsp; ⏱ ' + fmtT(mz.time) + ' &nbsp;·&nbsp; <span class="et-hearts">' + '♥'.repeat(run.lives) + '</span> &nbsp;·&nbsp; ' + run.score + ' pts</div>' +
      (S.mzNote ? '<p class="et-warn">' + esc(S.mzNote) + '</p>' : '') +
      '<p>Steer the point out through the gap on the right (<b>▶</b>). Touching a wall costs a heart; so does the clock running out. Every 5 mazes earn a heart back.</p>' +
      '<div class="et-btns"><button type="button" class="et-go" data-act="go" data-primary="1">Go</button><button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function mazeClearHtml() {
    var run = S.run;
    return '<div class="et-card"><div class="et-title">MAZE ' + (run.level - 1) + ' CLEAR</div>' +
      '<div class="et-big">+' + S.mzGain + ' <small>pts</small></div>' +
      '<div class="et-sub">total ' + run.score + ' &nbsp;·&nbsp; <span class="et-hearts">' + '♥'.repeat(run.lives) + '</span>' + (S.mzBonus ? ' &nbsp;·&nbsp; +1 heart!' : '') + '</div>' +
      '<div class="et-btns"><button type="button" class="et-go" data-act="next" data-primary="1">Next maze</button><button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function mazeOverHtml() {
    var run = S.run, m = S.car.maze;
    return '<div class="et-card"><div class="et-title">GAME OVER</div>' +
      '<div class="et-big">' + run.score + ' <small>pts</small></div>' +
      '<div class="et-sub">reached maze ' + run.level + ' &nbsp;·&nbsp; best ' + m.best + ' pts (maze ' + m.bestLevel + ')</div>' +
      (S.mzNewBest ? '<div class="et-new">New best run!</div>' : '') +
      '<div class="et-btns"><button type="button" class="et-go" data-act="new-run" data-primary="1">New run</button><button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function pauseHtml() {
    var what = S.mode === 'trace' ? 'Trace · level ' + S.tr.level + ' · ' + fmtT(S.tr.left) + ' left' : 'Maze ' + S.run.level + ' · ' + fmtT(S.run.left) + ' left';
    return '<div class="et-card"><div class="et-title">PAUSED</div><div class="et-sub">' + esc(what) + '</div>' +
      '<div class="et-btns"><button type="button" class="et-go" data-act="resume" data-primary="1">Resume</button><button type="button" class="et-go alt" data-act="restart">Restart</button><button type="button" class="et-go alt" data-act="menu">Modes</button></div></div>';
  }
  function showCard(kind) {
    S.card = kind || null;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml() : kind === 'settings' ? settingsHtml() : kind === 'gallery' ? galleryHtml() :
      kind === 'trace-ready' ? traceReadyHtml() : kind === 'trace-done' ? traceDoneHtml() : kind === 'maze-ready' ? mazeReadyHtml() :
      kind === 'maze-clear' ? mazeClearHtml() : kind === 'maze-over' ? mazeOverHtml() : kind === 'pause' ? pauseHtml() : '';
    var keep = S.ovl.scrollTop, same = S.cardShown === kind;
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.ovl.scrollTop = same ? keep : 0;
    S.cardShown = kind;
    S.keys = {};
    if (kind === 'gallery') {
      S.ovl.querySelectorAll('canvas[data-th]').forEach(function (cv) { drawThumb(cv, galDrawing(cv.getAttribute('data-th'))); });
    }
  }
  function closeCard() { if (S && S.card) { S.card = null; S.cardShown = null; S.ovl.innerHTML = ''; S.ovl.style.display = 'none'; S.stage.classList.remove('dim'); } }
  // where a card's Back / Esc goes
  function cardBack() {
    var c = S.card;
    if (c === 'pause') { resume(); return; }
    if (c === 'help') { if (S.firstRun) { S.firstRun = false; sset(K_SEEN, '1'); } if (S.mode === 'sketch' || S.backTo !== 'menu') { closeCard(); afterCard(); } else showCard('menu'); return; }
    if (c === 'settings' || c === 'gallery') { if (S.backTo === 'menu') showCard('menu'); else { closeCard(); afterCard(); } return; }
    if (c === 'menu') { if (S.mode === 'sketch') { closeCard(); afterCard(); } else if (S.paused) showCard('pause'); else if (S.phase === 'ready') showCard(S.mode === 'trace' ? 'trace-ready' : 'maze-ready'); else if (S.phase === 'done') showCard(S.mode === 'trace' ? 'trace-done' : (S.run && S.run.lives > 0 ? 'maze-clear' : 'maze-over')); else closeCard(); return; }
    if (c === 'trace-ready' || c === 'maze-ready' || c === 'trace-done' || c === 'maze-clear' || c === 'maze-over') { S.backTo = ''; showCard('menu'); return; }
    closeCard();
  }
  // a game paused under a card picks up again (the pause card shows instead)
  function afterCard() { if (S.mode !== 'sketch' && S.phase === 'play' && S.paused) showCard('pause'); kick(); }
  function openCard(kind, from) {
    if (S.phase === 'replay') endReplay();
    if (S.phase === 'play' && !S.paused) { S.paused = true; syncHead(); }
    S.backTo = from || '';
    S.resetArm = false; S.delArm = null;
    showCard(kind);
  }

  function onCardClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || b.disabled) return;
    S.snd.ensure();
    var a = b.getAttribute('data-act'), set = b.getAttribute('data-set'), g = b.getAttribute('data-g');
    if (set) { changeSetting(set, b.getAttribute('data-v')); return; }
    if (g) { galleryAct(g, b.getAttribute('data-id')); return; }
    S.snd.tone(988, 0.035, 'sine', 0.02);
    switch (a) {
      case 'close-help': case 'close': cardBack(); break;
      case 'help': openCard('help', 'menu'); break;
      case 'settings': openCard('settings', S.card === 'menu' ? 'menu' : ''); break;
      case 'gallery': openCard('gallery', S.card === 'menu' ? 'menu' : ''); break;
      case 'menu': S.paused = false; S.backTo = ''; showCard('menu'); syncHead(); break;
      case 'm-sketch': if (S.mode === 'sketch') { closeCard(); kick(); } else toSketch(); break;
      case 'm-trace': startTrace(S.pickLv || S.car.trace.level); break;
      case 'm-maze': startRun(false); break;
      case 'm-maze-cont': startRun(true); break;
      case 'lv-prev': S.pickLv = Math.max(1, (S.pickLv || 1) - 1); showCard('menu'); break;
      case 'lv-next': S.pickLv = Math.min(S.car.trace.unlocked, (S.pickLv || 1) + 1); showCard('menu'); break;
      case 'go': goPlay(); break;
      case 'resume': resume(); break;
      case 'restart': S.paused = false; if (S.mode === 'trace') startTrace(S.tr.level); else startMaze(''); break;
      case 'next': if (S.mode === 'trace') startTrace(S.tr.level + 1); else startMaze(''); break;
      case 'retry': startTrace(S.tr.level); break;
      case 'new-run': startRun(false); break;
      case 'g-save': if (saveToGallery()) showCard('gallery'); break;
      case 'g-png': exportPNG(S.d); break;
      case 'g-note': insertNote(S.d); break;
      case 'reset': S.resetArm = true; showCard('settings'); break;
      case 'reset-no': S.resetArm = false; showCard('settings'); break;
      case 'reset-yes': S.car = ENGINE.normCareer(null); persistCar(); sdel(K_RUN); S.pickLv = 1; S.resetArm = false; showCard('settings'); Cade.showToast && Cade.showToast('Records reset', 'info', 1500); break;
    }
  }
  function galleryAct(g, id) {
    var d = galDrawing(id);
    if (g === 'del') {
      if (S.delArm !== id) { S.delArm = id; showCard('gallery'); return; }
      S.delArm = null;
      sdel(K_DRAW + id);
      S.gal = S.gal.filter(function (x) { return x.id !== id; });
      saveGal(); showCard('gallery');
      return;
    }
    if (!d) { Cade.showToast && Cade.showToast('That drawing could not be read', 'error', 2000); return; }
    if (g === 'png') exportPNG(d);
    else if (g === 'note') insertNote(d);
    else if (g === 'load' || g === 'play') {
      S.d = d; fitDrawing(); buildBg(); rebuildPaper(); saveCurNow();
      closeCard(); syncHud(); draw();
      if (g === 'play') startReplay();
    }
  }
  function changeSetting(k, v) {
    var st = S.set;
    if (k === 'sens') st.sens = +v;
    else if (k === 'thick') { st.thick = +v; fitDrawing(); rebuildPaper(); draw(); }
    else if (k === 'frame') { st.frame = v; applyFrame(); }
    else if (k === 'diff') st.diff = v;
    else if (k === 'sound') { st.sound = v === '1'; S.snd.on = st.sound; if (st.sound) { S.snd.ensure(); } syncHead(); }
    else if (k === 'haptic') { st.haptic = v === '1'; if (st.haptic) buzz(15); }
    else if (k === 'motion') { st.motion = v === '1'; if (st.motion) enableMotion(true); else detachMotion(); }
    S.set = ENGINE.normSettings(st);
    persistSet();
    S.snd.tone(988, 0.035, 'sine', 0.02);
    showCard('settings');
  }

  // ---- keys ----
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', z: 'KeyZ', r: 'KeyR', g: 'KeyG', m: 'KeyM', shift: 'ShiftLeft', backspace: 'Backspace' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  var KNOB_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyA: 1, KeyD: 1, KeyW: 1, KeyS: 1 };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (minimized()) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t && t.isContentEditable && !(Cade.editor && Cade.editor.contentDOM && Cade.editor.contentDOM.contains(t))) return;
    var code = keyCode(e);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { S.keys[code] = true; return; }
    S.snd.ensure();
    if (S.card) {
      if (code === 'Escape') { e.preventDefault(); cardBack(); return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
        e.preventDefault();
        if (!e.repeat) { var pb = S.ovl.querySelector('[data-primary]'); if (pb) pb.click(); }
        return;
      }
      if (KNOB_KEYS[code] || code === 'KeyP') e.preventDefault();
      if (code === 'KeyP' && S.card === 'pause' && !e.repeat) resume();
      return;
    }
    if (S.phase === 'replay') { e.preventDefault(); if (!e.repeat) endReplay(); return; }
    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      if (e.repeat) return;
      if (S.phase === 'play') pause();
      else if (code === 'Escape' && S.mode !== 'sketch') openCard('menu');
      return;
    }
    if (KNOB_KEYS[code]) {
      e.preventDefault();
      if (canDraw()) { S.keys[code] = true; kick(); }
      return;
    }
    if (e.repeat) { if (code === 'Space' || code === 'Enter') e.preventDefault(); return; }
    if (code === 'Space') { e.preventDefault(); doShake(0.5, 'key'); return; }
    if (code === 'KeyZ' || code === 'Backspace') { e.preventDefault(); doUndo(); return; }
    if ((code === 'Enter' || code === 'NumpadEnter') && S.mode === 'trace' && S.phase === 'play') { e.preventDefault(); finishTrace(); return; }
    if (code === 'KeyR' && S.mode === 'sketch') { e.preventDefault(); startReplay(); return; }
    if (code === 'KeyG' && S.mode === 'sketch') { e.preventDefault(); openCard('gallery'); return; }
    if (code === 'KeyM') { e.preventDefault(); openCard('menu'); return; }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }

  // ---- knobs: drag round them (each knob its own pointer, so two thumbs work), wheel over them ----
  function bindKnob(el, which) {
    function center() { var r = el.querySelector('.et-dial').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 }; }
    el.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      S.snd.ensure(); maybeAskMotion();
      if (S.phase === 'replay') { endReplay(); return; }
      if (!canDraw()) return;
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      var c = center();
      S.grabK[which] = { id: e.pointerId, c: c, a: Math.atan2(e.clientY - c.y, e.clientX - c.x) };
      el.classList.add('on');
    });
    el.addEventListener('pointermove', function (e) {
      var g = S && S.grabK[which];
      if (!g || g.id !== e.pointerId) return;
      e.preventDefault();
      var dx = e.clientX - g.c.x, dy = e.clientY - g.c.y, a = Math.atan2(dy, dx);
      if (dx * dx + dy * dy < Math.pow(g.c.r * 0.16, 2)) { g.a = a; return; }    // too near the middle to read an angle
      var da = a - g.a;
      if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
      g.a = a;
      if (!canDraw()) return;
      turnKnob(which, da, e.shiftKey);
      kick();
    });
    function up(e) {
      var g = S && S.grabK[which];
      if (!g || g.id !== e.pointerId) return;
      S.grabK[which] = null; el.classList.remove('on');
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('wheel', function (e) {
      if (!S) return;
      e.preventDefault();
      if (!canDraw()) return;
      S.snd.ensure();
      var dy = e.deltaY || e.deltaX || 0;
      if (e.deltaMode === 1) dy *= 33; else if (e.deltaMode === 2) dy *= 300;
      turnKnob(which, ENGINE.clamp(dy, -400, 400) / 100 * (Math.PI / 12), e.shiftKey);
      kick();
    }, { passive: false });
  }
  // the grab handle: drag the whole pad about; fast back-and-forth jolts shake it
  function bindGrip(el) {
    el.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      S.snd.ensure(); maybeAskMotion();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      S.grip = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, lt: now(), dx: 0, dy: 0, tx: 0, ty: 0 };
      S.toy.classList.add('et-held');
    });
    el.addEventListener('pointermove', function (e) {
      var g = S && S.grip;
      if (!g || g.id !== e.pointerId) return;
      e.preventDefault();
      var t = now(), mx = e.clientX - g.lx, my = e.clientY - g.ly, dtm = Math.max(1, t - g.lt);
      function rub(v) { var s = v < 0 ? -1 : 1; v = Math.abs(v); return s * (v < 24 ? v : 24 + (v - 24) * 0.35); }
      var ox = ENGINE.clamp(rub(e.clientX - g.x0), -60, 60), oy = ENGINE.clamp(rub(e.clientY - g.y0), -40, 40);
      S.toy.style.transform = 'translate(' + ox.toFixed(1) + 'px,' + oy.toFixed(1) + 'px) rotate(' + (ox * 0.05).toFixed(2) + 'deg)';
      // reversal detection on whichever axis moves most
      var axisX = Math.abs(mx) >= Math.abs(my), m = axisX ? mx : my, dir = m > 0 ? 1 : m < 0 ? -1 : 0, sp = Math.abs(m) / dtm;
      var key = axisX ? 'dx' : 'dy', tk = axisX ? 'tx' : 'ty';
      if (dir && g[key] && dir !== g[key]) {
        if (Math.abs(g[tk]) > 16 && sp > 0.25) doShake(0.24, 'grab');
        g[tk] = 0;
      }
      if (dir) { g[key] = dir; g[tk] += m; }
      g.lx = e.clientX; g.ly = e.clientY; g.lt = t;
    });
    function up(e) {
      var g = S && S.grip;
      if (!g || g.id !== e.pointerId) return;
      S.grip = null;
      S.toy.classList.remove('et-held');
      S.toy.style.transform = '';
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  function maybeAskMotion() {
    if (S && S.set.motion && !S.onMotion && !S.motionAsked) { S.motionAsked = true; enableMotion(true); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    try { saveCurNow(); } catch (e) {}
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.shkT); clearTimeout(s.curT); clearInterval(s.blinkI);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (s.onMotion) window.removeEventListener('devicemotion', s.onMotion);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    freeCanvas(s.paper); freeCanvas(s.prev); freeCanvas(s.bg); freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
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
    var ring = '';
    for (var ri = 0; ri < 12; ri++) ring += '<i style="--i:' + ri + '">' + (ri % 3 ? '·' : '+') + '</i>';
    var knob = function (cls, lab, cap) {
      return '<div class="et-knob ' + cls + '" role="slider" aria-label="' + lab + '" tabindex="-1"><div class="et-dial"><div class="et-ring">' + ring +
        '</div><div class="et-krot"><i>◆</i></div><b class="et-kp">|</b></div><div class="et-kcap">' + cap + '</div></div>';
    };
    var body = '<div class="et"><div class="et-bar"><div class="et-hud"></div><div class="et-acts">' +
      '<button type="button" data-a="menu" title="Modes (M)" aria-label="Modes">' + IC_MENU + '<span>Modes</span></button>' +
      '<button type="button" data-a="save" data-sk="1" title="Save to gallery" aria-label="Save to gallery">' + IC_SAVE + '</button>' +
      '<button type="button" data-a="gallery" data-sk="1" title="Gallery (G)" aria-label="Gallery">' + IC_GAL + '</button>' +
      '<button type="button" data-a="replay" data-sk="1" title="Replay (R)" aria-label="Replay">' + IC_REPLAY + '</button></div></div>' +
      '<div class="et-stage"><div class="et-toy">' +
      '<div class="et-scrw"><canvas class="et-cv"></canvas><div class="et-grip" title="Grab the frame and jiggle it to shake"></div></div>' +
      knob('et-kh', 'Left knob: left and right', '&#9668; &#9658;') + '<div class="et-mid"></div>' + knob('et-kv', 'Right knob: up and down', '&#9650; &#9660;') +
      '</div><div class="et-ovl" style="display:none"></div></div><div class="et-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '✏ Etch Pad', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'et-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="settings" title="Settings" aria-label="Settings">' + IC_GEAR + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, set = ENGINE.normSettings(sjson(K_SET));
    S = {
      panel: p, head: hb, root: p.querySelector('.et'), hud: p.querySelector('.et-hud'), acts: p.querySelector('.et-acts'), stage: p.querySelector('.et-stage'),
      toy: p.querySelector('.et-toy'), cv: p.querySelector('.et-cv'), ovl: p.querySelector('.et-ovl'), mid: p.querySelector('.et-mid'), liveEl: p.querySelector('.et-live'),
      khEl: p.querySelector('.et-kh'), kvEl: p.querySelector('.et-kv'), grip: null, grabK: { h: null, v: null },
      set: set, car: ENGINE.normCareer(sjson(K_CAR)), gal: loadGal(), snd: new Snd(set.sound), firstRun: !sget(K_SEEN),
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: 'sketch', phase: 'free', paused: false, card: null, cardShown: null, backTo: '',
      d: null, dims: { w: 400, h: 300 }, sw: 0, sh: 0, dpr: 1, k: 1, ox: 0, oy: 0,
      kh: { a: 0, tk: 0, shown: null, ptr: 0 }, kv: { a: 0, tk: 0, shown: null, ptr: 0 }, fx: [], blink: true, blinkI: 0, keys: {}, kbT: 0, pend: { x: 0, y: 0 }, lastMove: 0,
      raf: 0, last: 0, acc: 0, fade: 0, flash: 0, mzHit: 0, hudT: 0, hudHtml: '', midHtml: '', seed: (Math.random() * 1e9) >>> 0, shakes: 0,
      tr: null, mz: null, run: null, rp: null, motionT: 0, onMotion: null, motionOk: false, motionAsked: false, pickLv: 0
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    readTheme();
    applyFrame();
    layout();               // sizes the screen (and S.dims), then loads the drawing
    setMid(); syncHud(); syncHead(); draw();
    if (S.set.motion && !motionNeedsAsk()) enableMotion(false);
    S.blinkI = setInterval(function () { if (!S) return; S.blink = !S.blink; if (!S.raf && !minimized() && !document.hidden) draw(); }, 530);

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); S.keys = {}; } else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { S.keys = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); S.keys = {}; stopLoop(); saveCurNow(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (!S || S.panel !== p) return; if (S.themeDirty) { S.themeDirty = false; readTheme(); applyFrame(); rebuildPaper(); } layout(); });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !minimized()) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(p.querySelector('.et-bar'));
    } catch (e) {}
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (minimized()) { S.themeDirty = true; return; }
        readTheme(); applyFrame(); rebuildPaper(); draw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header buttons
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = S.set.sound = !S.snd.on;
        persistSet();
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
        if (S.card === 'settings') showCard('settings');
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') { if (S.card === 'help') cardBack(); else openCard('help'); }
      else if (h === 'settings') { if (S.card === 'settings') cardBack(); else openCard('settings'); }
      try { b.blur(); } catch (er) {}
    });
    S.acts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure();
      var a = b.getAttribute('data-a');
      if (a === 'menu') { if (S.card === 'menu') cardBack(); else openCard('menu'); }
      else if (a === 'save') { if (S.phase === 'replay') endReplay(); saveToGallery(); }
      else if (a === 'gallery') { if (S.card === 'gallery') cardBack(); else openCard('gallery'); }
      else if (a === 'replay') { if (S.phase === 'replay') endReplay(); else startReplay(); }
      try { b.blur(); } catch (er) {}
    });
    S.mid.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      S.snd.ensure(); maybeAskMotion();
      var a = b.getAttribute('data-act');
      if (a === 'shake') doShake(0.5, 'button');
      else if (a === 'undo') doUndo();
      else if (a === 'done') finishTrace();
      else if (a === 'pause') pause();
      else if (a === 'stop-replay') endReplay();
      try { b.blur(); } catch (er) {}
    });
    S.ovl.addEventListener('click', onCardClick);
    bindKnob(S.khEl, 'h');
    bindKnob(S.kvEl, 'v');
    bindGrip(p.querySelector('.et-grip'));
    // a tap on the screen during a replay skips to the end
    S.cv.addEventListener('pointerdown', function (e) { e.preventDefault(); if (S && S.phase === 'replay') endReplay(); });

    // Fast taps must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.khEl, S.kvEl, p.querySelector('.et-grip')].forEach(function (el) {
      el.addEventListener('touchstart', noTouch, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', noTouch, { passive: false });
      el.addEventListener('contextmenu', noTouch);
    });
    S.mid.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      noTouch(e);
      if (!b.disabled) b.click();     // a quick tap still clicks (no double-tap zoom), and repeated Shake taps all count
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    if (S.firstRun) openCard('help');
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Twin-knob line drawing toy — turn the dials, shake to erase, save your sketches',
    icon: '✏',
    tags: 'toy,drawing,sketch,etch,knobs,relax,doodle,fun',
    open: open,
    _engine: ENGINE
  });
})();
