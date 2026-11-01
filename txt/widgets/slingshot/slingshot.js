/* Siege Sling — a slingshot physics game for Cade.txt.
 * Drag back anywhere on the field to pull the sling, let go to fling a stone at
 * wobbly towers of wood, stone and ice; topple every glyph guard to clear the
 * level. Later levels hand you special shots: the Splitter (tap: three stones),
 * the Boulder (tap: slam down), the Bomb (tap or a fuse after the first knock)
 * and the Rocket (tap: a burst of speed). Stars by how few shots you needed.
 *
 * The physics is a compact impulse-based 2D rigid-body solver written for this
 * game: oriented boxes and circles, SAT + reference-face clipping for box
 * contacts (two points, feature ids), sequential impulses with accumulated
 * clamping, warm starting, Coulomb friction, Baumgarte position bias with slop,
 * speculative contacts for fast stones, island sleeping (towers rest asleep
 * until something touches them; the warm-start impulses are primed at load so
 * a woken stack doesn't sag), and damage from contact impulses. The approach
 * follows the published sequential-impulse method (E. Catto, GDC 2006 /
 * Box2D-Lite, zlib licence) — the code here is original.
 * Fixed 120 Hz step with an accumulator; rendering interpolates, so it is the
 * same at 60 or 120 Hz. Everything is drawn in monospace glyphs from a glyph
 * atlas plus pre-rendered glyph-textured block tiles, coloured by the theme.
 * Progress persists in Cade.store (cade-slingshot-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: metres, seconds. x → right, y → up; the ground's top is y = 0.
  var STEP = 1 / 120, ITER = 10, G = -10;
  var BETA = 0.2, SLOP = 0.004, MAXCORR = 2.5, MARGIN = 0.012;
  var SLEEP_V = 0.06, SLEEP_W = 0.08, SLEEP_T = 0.5;
  var VDMG = 1.1;                              // approach speed (m/s) below which a knock does no damage
  var VMAX = 17.5, PULL_R = 1.3;               // launch speed at full pull; pull radius (m)
  var SLING = { x: 0, y: 1.75 };               // the sling's pouch at rest
  var GUARD_PTS = 1000, SHOT_BONUS = 1000;
  var KILL_Y = -6;

  // Materials. rho: density (per m²), mu: friction, e: restitution, tough: hp per (0.4 + area).
  var MATS = {
    w: { id: 'w', name: 'Wood', rho: 1, mu: 0.6, e: 0.1, tough: 4.4, pts: 100 },
    s: { id: 's', name: 'Stone', rho: 2.4, mu: 0.75, e: 0.05, tough: 11, pts: 250 },
    i: { id: 'i', name: 'Ice', rho: 0.9, mu: 0.1, e: 0.12, tough: 1.7, pts: 80 },
    g: { id: 'g', name: 'Guard', rho: 0.8, mu: 0.7, e: 0.1, tough: 0, pts: GUARD_PTS },
    r: { id: 'r', name: 'Rock', rho: 0, mu: 0.8, e: 0.05, tough: 0, pts: 0 },
    p: { id: 'p', name: 'Shot', rho: 5, mu: 0.5, e: 0.25, tough: 0, pts: 0 }
  };
  var GUARD_HP = 0.95;
  // Shots. act: what a tap does in flight. unlock: the level it first appears in (1-based).
  // dm: damage multipliers against materials.
  var SHOTS = {
    S: { id: 'S', name: 'Stone', ch: 'o', r: 0.26, rho: 5, act: null, unlock: 1, info: 'a plain, honest stone', dm: { w: 1, s: 1, i: 1, g: 1 } },
    P: { id: 'P', name: 'Splitter', ch: '*', r: 0.25, rho: 5, act: 'split', unlock: 4, info: 'tap in flight: bursts into three', dm: { w: 1.3, s: 0.6, i: 2, g: 1 } },
    H: { id: 'H', name: 'Boulder', ch: '#', r: 0.4, rho: 7, act: 'slam', unlock: 8, info: 'heavy; tap in flight: slam straight down', dm: { w: 1.2, s: 2.4, i: 1, g: 1 } },
    B: { id: 'B', name: 'Bomb', ch: '!', r: 0.3, rho: 4, act: 'boom', unlock: 12, info: 'tap to blow it up (or it goes off after a knock)', dm: { w: 1, s: 1, i: 1, g: 1 } },
    R: { id: 'R', name: 'Rocket', ch: '>', r: 0.24, rho: 5, act: 'boost', unlock: 16, info: 'tap in flight: a burst of speed', dm: { w: 1.7, s: 0.9, i: 1.6, g: 1 } }
  };
  var SHOT_ORDER = ['S', 'P', 'H', 'B', 'R'];
  var MINI_R = 0.17, BOOM_R = 2.7, BOOM_J = 9, BOOM_DMG = 9, FUSE = 1.1;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- bodies ----
  // shape: 1 box (hw, hh), 2 circle (r). im / iI: inverse mass / inertia (0 = static).
  function mkBody(w, o) {
    var m = MATS[o.mat] || MATS.w, box = o.shape !== 2;
    var b = {
      id: w.nextId++, shape: box ? 1 : 2, hw: o.hw || 0, hh: o.hh || 0, r: o.r || 0,
      x: o.x, y: o.y, a: o.a || 0, vx: o.vx || 0, vy: o.vy || 0, w: o.w || 0,
      c: 1, s: 0, px: o.x, py: o.y, pa: o.a || 0,
      mat: m.id, kind: o.kind || 'block', mu: m.mu, e: m.e, im: 0, iI: 0, mass: 0,
      hp: 0, hp0: 0, sleep: false, st: 0, dead: false, touch: false,
      shot: o.shot || null, hitT: -1, spent: false, x0: 0, y0: 0, x1: 0, y1: 0, tag: o.tag || 0
    };
    b.c = Math.cos(b.a); b.s = Math.sin(b.a);
    var rho = o.rho != null ? o.rho : m.rho;
    if (!o.fixed && rho > 0) {
      var area = box ? 4 * b.hw * b.hh : Math.PI * b.r * b.r, mass = rho * area;
      var I = box ? mass * (b.hw * b.hw + b.hh * b.hh) / 3 : mass * b.r * b.r / 2;
      b.mass = mass; b.im = 1 / mass; b.iI = 1 / I;
      if (b.kind === 'guard') b.hp = GUARD_HP;
      else if (b.kind === 'block') b.hp = m.tough * (0.4 + area);
      b.hp0 = b.hp;
    }
    if (o.mu != null) b.mu = o.mu;
    if (o.e != null) b.e = o.e;
    w.bodies.push(b);
    return b;
  }

  function newWorld() {
    return { bodies: [], arbs: new Map(), nextId: 1, t: 0, steps: 0, events: [], tmp: [mkC(), mkC()], ground: null };
  }
  function mkC() { return { x: 0, y: 0, nx: 0, ny: 0, sep: 0, id: 0, Pn: 0, Pt: 0, mn: 0, mt: 0, bias: 0, rax: 0, ray: 0, rbx: 0, rby: 0, vn0: 0 }; }

  // ---- narrow phase. Each writes up to 2 contacts into out; the normal points from A to B. ----
  function setC(c, x, y, nx, ny, sep, id) { c.x = x; c.y = y; c.nx = nx; c.ny = ny; c.sep = sep; c.id = id; }

  function boxBox(A, B, out, mg) {
    var ca = A.c, sa = A.s, cb = B.c, sb = B.s;
    var dx = B.x - A.x, dy = B.y - A.y;
    var dA0 = dx * ca + dy * sa, dA1 = -dx * sa + dy * ca, dB0 = dx * cb + dy * sb, dB1 = -dx * sb + dy * cb;
    var C = Math.abs(ca * cb + sa * sb), Sn = Math.abs(sa * cb - ca * sb);
    var sAx = Math.abs(dA0) - A.hw - (C * B.hw + Sn * B.hh);
    if (sAx > mg) return 0;
    var sAy = Math.abs(dA1) - A.hh - (Sn * B.hw + C * B.hh);
    if (sAy > mg) return 0;
    var sBx = Math.abs(dB0) - B.hw - (C * A.hw + Sn * A.hh);
    if (sBx > mg) return 0;
    var sBy = Math.abs(dB1) - B.hh - (Sn * A.hw + C * A.hh);
    if (sBy > mg) return 0;
    // the axis of least penetration, preferring A's faces and x over y for coherence
    var axis = 0, best = sAx;
    if (sAy > best + 0.002 + 0.05 * Math.abs(best)) { axis = 1; best = sAy; }
    if (sBx > best + 0.002 + 0.05 * Math.abs(best)) { axis = 2; best = sBx; }
    if (sBy > best + 0.002 + 0.05 * Math.abs(best)) { axis = 3; best = sBy; }
    var R, I, nx, ny, en, tx, ty, et, rf, flip, sg;
    if (axis === 0) { R = A; I = B; sg = dA0 >= 0 ? 1 : -1; nx = ca * sg; ny = sa * sg; en = A.hw; tx = -sa; ty = ca; et = A.hh; rf = sg > 0 ? 0 : 2; flip = 0; }
    else if (axis === 1) { R = A; I = B; sg = dA1 >= 0 ? 1 : -1; nx = -sa * sg; ny = ca * sg; en = A.hh; tx = ca; ty = sa; et = A.hw; rf = sg > 0 ? 1 : 3; flip = 0; }
    else if (axis === 2) { R = B; I = A; sg = dB0 >= 0 ? -1 : 1; nx = cb * sg; ny = sb * sg; en = B.hw; tx = -sb; ty = cb; et = B.hh; rf = sg > 0 ? 0 : 2; flip = 128; }
    else { R = B; I = A; sg = dB1 >= 0 ? -1 : 1; nx = -sb * sg; ny = cb * sg; en = B.hh; tx = cb; ty = sb; et = B.hw; rf = sg > 0 ? 1 : 3; flip = 128; }
    // the incident face: I's face most anti-parallel to n
    var ic = I.c, is = I.s, ndx = nx * ic + ny * is, ndy = -nx * is + ny * ic, f;
    if (Math.abs(ndx) > Math.abs(ndy)) f = ndx > 0 ? 2 : 0; else f = ndy > 0 ? 3 : 1;
    var hw = I.hw, hh = I.hh, l1x, l1y, l2x, l2y;
    if (f === 0) { l1x = hw; l1y = -hh; l2x = hw; l2y = hh; }
    else if (f === 1) { l1x = hw; l1y = hh; l2x = -hw; l2y = hh; }
    else if (f === 2) { l1x = -hw; l1y = hh; l2x = -hw; l2y = -hh; }
    else { l1x = -hw; l1y = -hh; l2x = hw; l2y = -hh; }
    var v1x = I.x + ic * l1x - is * l1y, v1y = I.y + is * l1x + ic * l1y;
    var v2x = I.x + ic * l2x - is * l2y, v2y = I.y + is * l2x + ic * l2y;
    var k1 = 0, k2 = 1;
    // clip against the reference face's two side planes
    var rct = tx * R.x + ty * R.y, d1 = tx * v1x + ty * v1y - rct - et, d2 = tx * v2x + ty * v2y - rct - et, u;
    if (d1 > 0 && d2 > 0) return 0;
    if (d1 > 0) { u = d1 / (d1 - d2); v1x += (v2x - v1x) * u; v1y += (v2y - v1y) * u; k1 = 2; }
    else if (d2 > 0) { u = d2 / (d2 - d1); v2x += (v1x - v2x) * u; v2y += (v1y - v2y) * u; k2 = 2; }
    d1 = -(tx * v1x + ty * v1y) + rct - et; d2 = -(tx * v2x + ty * v2y) + rct - et;
    if (d1 > 0 && d2 > 0) return 0;
    if (d1 > 0) { u = d1 / (d1 - d2); v1x += (v2x - v1x) * u; v1y += (v2y - v1y) * u; k1 = 3; }
    else if (d2 > 0) { u = d2 / (d2 - d1); v2x += (v1x - v2x) * u; v2y += (v1y - v2y) * u; k2 = 3; }
    var front = nx * R.x + ny * R.y + en, n = 0, base = flip | (rf << 5) | (f << 2);
    var onx = flip ? -nx : nx, ony = flip ? -ny : ny;
    var s1 = nx * v1x + ny * v1y - front;
    if (s1 <= mg) { setC(out[n++], v1x - nx * s1 * 0.5, v1y - ny * s1 * 0.5, onx, ony, s1, base | k1); }
    var s2 = nx * v2x + ny * v2y - front;
    if (s2 <= mg) { setC(out[n++], v2x - nx * s2 * 0.5, v2y - ny * s2 * 0.5, onx, ony, s2, base | (k2 + 16 * (k2 === k1 ? 1 : 0))); }
    return n;
  }

  // Circle C against box X; the normal written points from A to B (aIsCircle says which is which).
  function circBox(Cb, X, out, mg, aIsCircle) {
    var c = X.c, s = X.s, dx = Cb.x - X.x, dy = Cb.y - X.y;
    var lx = dx * c + dy * s, ly = -dx * s + dy * c;
    var qx = clamp(lx, -X.hw, X.hw), qy = clamp(ly, -X.hh, X.hh), nlx, nly, sep;
    if (qx === lx && qy === ly) {                   // the centre is inside the box
      var px = X.hw - Math.abs(lx), py = X.hh - Math.abs(ly);
      if (px < py) { nlx = lx >= 0 ? 1 : -1; nly = 0; qx = nlx * X.hw; sep = -px - Cb.r; }
      else { nlx = 0; nly = ly >= 0 ? 1 : -1; qy = nly * X.hh; sep = -py - Cb.r; }
    } else {
      var ex = lx - qx, ey = ly - qy, d = Math.sqrt(ex * ex + ey * ey);
      sep = d - Cb.r;
      if (sep > mg) return 0;
      nlx = ex / d; nly = ey / d;
    }
    var nx = c * nlx - s * nly, ny = s * nlx + c * nly;           // box → circle, world
    var sx = X.x + c * qx - s * qy, sy = X.y + s * qx + c * qy;   // the box's surface point
    var mx = (sx + Cb.x - nx * Cb.r) * 0.5, my = (sy + Cb.y - ny * Cb.r) * 0.5;
    setC(out[0], mx, my, aIsCircle ? -nx : nx, aIsCircle ? -ny : ny, sep, 1);
    return 1;
  }
  function circCirc(A, B, out, mg) {
    var dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy), sep = d - A.r - B.r;
    if (sep > mg) return 0;
    var nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1;
    setC(out[0], A.x + nx * (A.r + sep * 0.5), A.y + ny * (A.r + sep * 0.5), nx, ny, sep, 2);
    return 1;
  }
  function collide(A, B, out, mg) {
    if (A.shape === 1 && B.shape === 1) return boxBox(A, B, out, mg);
    if (A.shape === 2 && B.shape === 2) return circCirc(A, B, out, mg);
    if (A.shape === 2) return circBox(A, B, out, mg, true);
    return circBox(B, A, out, mg, false);
  }

  function aabb(b) {
    var ex, ey;
    if (b.shape === 2) ex = ey = b.r;
    else { var c = Math.abs(b.c), s = Math.abs(b.s); ex = c * b.hw + s * b.hh; ey = s * b.hw + c * b.hh; }
    b.x0 = b.x - ex; b.x1 = b.x + ex; b.y0 = b.y - ey; b.y1 = b.y + ey;
  }
  function active(b) { return b.im > 0 && !b.sleep; }

  // Wake a sleeping body and everything resting on / against it (its island).
  function wake(w, b) {
    if (b.im === 0 || !b.sleep) return;
    b.sleep = false; b.st = 0;
    var stack = [b];
    while (stack.length) {
      var x = stack.pop();
      w.arbs.forEach(function (a) {
        var o = a.A === x ? a.B : a.B === x ? a.A : null;
        if (o && o.im > 0 && o.sleep) { o.sleep = false; o.st = 0; stack.push(o); }
      });
    }
  }
  function wakeAll(w) { for (var i = 0; i < w.bodies.length; i++) { var b = w.bodies[i]; if (b.im > 0) { b.sleep = false; b.st = 0; } } }

  // Build / refresh the contact for one pair; keeps accumulated impulses of matching features (warm start).
  function updatePair(w, A, B, mg) {
    var key = A.id * 65536 + B.id, arb = w.arbs.get(key), n = collide(A, B, w.tmp, mg), i, j;
    if (!n) { if (arb) w.arbs.delete(key); return null; }
    if (!arb) { arb = { A: A, B: B, cs: [], n: 0, mu: Math.sqrt(A.mu * B.mu), e: Math.max(A.e, B.e) }; w.arbs.set(key, arb); }
    var old = arb.cs, oldN = arb.n, nc = [], used = 0;
    for (i = 0; i < n; i++) {
      var t = w.tmp[i], c = mkC(), hit = -1, bd = 0.0064;
      c.x = t.x; c.y = t.y; c.nx = t.nx; c.ny = t.ny; c.sep = t.sep; c.id = t.id;
      // the same feature pair; failing that (a vertex just crossed a side plane) the nearest old point
      for (j = 0; j < oldN; j++) if (old[j].id === t.id && !(used & (1 << j))) { hit = j; break; }
      if (hit < 0) for (j = 0; j < oldN; j++) {
        if (used & (1 << j)) continue;
        var ddx = old[j].x - t.x, ddy = old[j].y - t.y, d2 = ddx * ddx + ddy * ddy;
        if (d2 < bd) { bd = d2; hit = j; }
      }
      if (hit >= 0) { used |= 1 << hit; c.Pn = old[hit].Pn; c.Pt = old[hit].Pt; }
      nc.push(c);
    }
    arb.cs = nc; arb.n = n;
    return arb;
  }

  function prestep(w, arb, inv, dt) {
    var A = arb.A, B = arb.B, cs = arb.cs;
    for (var k = 0; k < arb.n; k++) {
      var c = cs[k], nx = c.nx, ny = c.ny, tx = ny, ty = -nx;
      var rax = c.x - A.x, ray = c.y - A.y, rbx = c.x - B.x, rby = c.y - B.y;
      c.rax = rax; c.ray = ray; c.rbx = rbx; c.rby = rby;
      var rnA = rax * ny - ray * nx, rnB = rbx * ny - rby * nx;
      c.mn = 1 / (A.im + B.im + A.iI * rnA * rnA + B.iI * rnB * rnB);
      var rtA = rax * ty - ray * tx, rtB = rbx * ty - rby * tx;
      c.mt = 1 / (A.im + B.im + A.iI * rtA * rtA + B.iI * rtB * rtB);
      var dvx = B.vx - B.w * rby - A.vx + A.w * ray, dvy = B.vy + B.w * rbx - A.vy - A.w * rax;
      var vn = dvx * nx + dvy * ny;
      c.vn0 = vn;
      var bias;
      if (c.sep > 0) bias = -c.sep * inv;                               // speculative: may close the gap, no more
      else bias = Math.min(BETA * inv * Math.max(0, -c.sep - SLOP), MAXCORR);
      if (vn < -1 && c.sep < -vn * dt) bias = Math.max(bias, -arb.e * vn);   // a bounce
      c.bias = bias;
    }
    arb.blk = false;
    if (arb.n === 2) {
      var p = cs[0], q = cs[1];
      var r1A = p.rax * p.ny - p.ray * p.nx, r1B = p.rbx * p.ny - p.rby * p.nx, r2A = q.rax * q.ny - q.ray * q.nx, r2B = q.rbx * q.ny - q.rby * q.nx;
      var k11 = 1 / p.mn, k22 = 1 / q.mn, k12 = A.im + B.im + A.iI * r1A * r2A + B.iI * r1B * r2B, det = k11 * k22 - k12 * k12;
      if (k11 * k11 < 1000 * det) {               // well conditioned: solve the pair as a block
        arb.blk = true; arb.k11 = k11; arb.k12 = k12; arb.k22 = k22;
        arb.i11 = k22 / det; arb.i12 = -k12 / det; arb.i22 = k11 / det;
      }
    }
  }
  // Warm start: re-apply last step's impulses. A separate pass after every prestep,
  // so restitution and damage read the velocities from before any of it.
  function warm(arb) {
    for (var k = 0; k < arb.n; k++) {
      var c = arb.cs[k];
      if (c.Pn || c.Pt) applyP(arb.A, arb.B, c, c.Pn * c.nx + c.Pt * c.ny, c.Pn * c.ny - c.Pt * c.nx);
    }
  }
  function applyP(A, B, c, Px, Py) {
    A.vx -= A.im * Px; A.vy -= A.im * Py; A.w -= A.iI * (c.rax * Py - c.ray * Px);
    B.vx += B.im * Px; B.vy += B.im * Py; B.w += B.iI * (c.rbx * Py - c.rby * Px);
  }
  function relVn(A, B, c) {
    return (B.vx - B.w * c.rby - A.vx + A.w * c.ray) * c.nx + (B.vy + B.w * c.rbx - A.vy - A.w * c.rax) * c.ny;
  }
  // Friction first (bounded by the last normal impulses), then the normal impulses —
  // a two-point manifold as one 2x2 LCP (solved exactly by enumerating the four
  // cases), so the pair never "rocks" the way point-by-point Gauss–Seidel does.
  function solve(arb) {
    var A = arb.A, B = arb.B, cs = arb.cs, mu = arb.mu, k, c;
    for (k = 0; k < arb.n; k++) {
      c = cs[k];
      var tx = c.ny, ty = -c.nx;
      var vt = (B.vx - B.w * c.rby - A.vx + A.w * c.ray) * tx + (B.vy + B.w * c.rbx - A.vy - A.w * c.rax) * ty;
      var mx = mu * c.Pn, T0 = c.Pt;
      c.Pt = clamp(T0 - c.mt * vt, -mx, mx);
      var dT = c.Pt - T0;
      if (dT) applyP(A, B, c, dT * tx, dT * ty);
    }
    if (arb.n === 2 && arb.blk) {
      var c1 = cs[0], c2 = cs[1], nx = c1.nx, ny = c1.ny;
      var a1 = c1.Pn, a2 = c2.Pn;
      var b1 = relVn(A, B, c1) - c1.bias - (arb.k11 * a1 + arb.k12 * a2);
      var b2 = relVn(A, B, c2) - c2.bias - (arb.k12 * a1 + arb.k22 * a2);
      var x1, x2;
      for (;;) {
        x1 = -(arb.i11 * b1 + arb.i12 * b2); x2 = -(arb.i12 * b1 + arb.i22 * b2);
        if (x1 >= 0 && x2 >= 0) break;
        x1 = -c1.mn * b1; x2 = 0;
        if (x1 >= 0 && arb.k12 * x1 + b2 >= 0) break;
        x1 = 0; x2 = -c2.mn * b2;
        if (x2 >= 0 && arb.k12 * x2 + b1 >= 0) break;
        x1 = 0; x2 = 0;
        if (b1 >= 0 && b2 >= 0) break;
        x1 = a1; x2 = a2;                       // no case holds (degenerate): leave it
        break;
      }
      var d1 = x1 - a1, d2 = x2 - a2;
      c1.Pn = x1; c2.Pn = x2;
      if (d1) applyP(A, B, c1, d1 * nx, d1 * ny);
      if (d2) applyP(A, B, c2, d2 * nx, d2 * ny);
      return;
    }
    for (k = 0; k < arb.n; k++) {
      c = cs[k];
      var dP = c.mn * (-relVn(A, B, c) + c.bias), P0 = c.Pn;
      c.Pn = Math.max(P0 + dP, 0); dP = c.Pn - P0;
      if (dP) applyP(A, B, c, dP * c.nx, dP * c.ny);
    }
  }

  // Damage: the impulse of an impact (effective mass × approach speed over VDMG).
  function dmgMul(by, to) {
    if (by.kind === 'proj' && by.shot && SHOTS[by.shot]) return SHOTS[by.shot].dm[to.kind === 'guard' ? 'g' : to.mat] || 1;
    return 1;
  }
  function hurt(w, b, d) {
    if (b.dead || b.im === 0 || b.kind === 'proj' || !(d > 0)) return;
    b.hp -= d;
    if (b.hp <= 0) kill(w, b, b.kind === 'guard' ? 'guard' : 'break');
  }
  function kill(w, b, why) {
    if (b.dead) return;
    b.dead = true;
    var arbs = w.arbs, rm = [];
    arbs.forEach(function (a, key) {
      if (a.A === b || a.B === b) { rm.push(key); var o = a.A === b ? a.B : a.A; if (o.im > 0) { if (o.sleep) wake(w, o); else o.st = 0; } }
    });
    for (var i = 0; i < rm.length; i++) arbs.delete(rm[i]);
    if (why) w.events.push({ k: why, b: b, x: b.x, y: b.y });
  }

  // One fixed step of the world.
  function stepWorld(w) {
    var dt = STEP, inv = 1 / dt, bodies = w.bodies, n = bodies.length, i, j, A, B, b;
    w.t += dt; w.steps++;
    for (i = 0; i < n; i++) {
      b = bodies[i];
      b.px = b.x; b.py = b.y; b.pa = b.a; b.touch = false;
      b.c = Math.cos(b.a); b.s = Math.sin(b.a);
      aabb(b);
    }
    // broad + narrow phase. Pairs where neither body is awake keep their contacts:
    // sleeping bodies don't move, so those contacts stay valid.
    for (i = 0; i < n; i++) {
      A = bodies[i];
      if (A.dead) continue;
      var actA = active(A);
      for (j = i + 1; j < n; j++) {
        B = bodies[j];
        if (B.dead) continue;
        var actB = active(B);
        if (!actA && !actB) continue;
        var rvx = B.vx - A.vx, rvy = B.vy - A.vy, spec = Math.min(0.3, Math.sqrt(rvx * rvx + rvy * rvy) * dt * 1.2), mg = MARGIN + spec;
        if (A.x0 - B.x1 > mg || B.x0 - A.x1 > mg || A.y0 - B.y1 > mg || B.y0 - A.y1 > mg) {
          var key = A.id * 65536 + B.id;
          if (w.arbs.has(key)) w.arbs.delete(key);
          continue;
        }
        var arb = updatePair(w, A, B, mg);
        if (arb) {
          if (!actA && A.im > 0) { wake(w, A); actA = true; }
          if (!actB && B.im > 0) wake(w, B);
        }
      }
    }
    // gravity
    for (i = 0; i < n; i++) { b = bodies[i]; if (active(b) && !b.dead) b.vy += G * dt; }
    // contacts touching an awake body
    var list = [];
    w.arbs.forEach(function (a) { if (active(a.A) || active(a.B)) list.push(a); });
    for (i = 0; i < list.length; i++) prestep(w, list[i], inv, dt);
    for (i = 0; i < list.length; i++) warm(list[i]);
    for (var it = 0; it < ITER; it++) for (i = 0; i < list.length; i++) solve(list[i]);
    // damage + impact events
    for (i = 0; i < list.length; i++) {
      var ar = list[i], J = 0, hx = 0, hy = 0, cs = ar.cs;
      A = ar.A; B = ar.B;
      for (j = 0; j < ar.n; j++) {
        var c = cs[j], ap = -c.vn0;
        if (c.sep > ap * dt + 0.002) continue;      // a speculative contact that won't touch this step
        if (ap > 0.4) { A.touch = B.touch = true; }
        if (ap > VDMG) { J += c.mn * (ap - VDMG); hx = c.x; hy = c.y; }
        if (ap > 0.6) {
          if (A.kind === 'proj' && A.hitT < 0) A.hitT = w.t;
          if (B.kind === 'proj' && B.hitT < 0) B.hitT = w.t;
        }
      }
      if (ar.n) { A.touch = true; B.touch = true; }
      if (J > 0) {
        if (J > 0.25) w.events.push({ k: 'hit', x: hx, y: hy, J: J, a: A.mat, b: B.mat, proj: A.kind === 'proj' || B.kind === 'proj' });
        hurt(w, A, J * dmgMul(B, A));
        hurt(w, B, J * dmgMul(A, B));
      }
    }
    // integrate
    for (i = 0; i < n; i++) {
      b = bodies[i];
      if (!active(b) || b.dead) continue;
      if (b.shape === 2 && b.touch) { b.w *= 0.985; b.vx *= 0.997; }    // rolling resistance
      b.w *= 1 / (1 + dt * 0.05);
      b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.w * dt;
      if (b.vx * b.vx + b.vy * b.vy < SLEEP_V * SLEEP_V && b.w * b.w < SLEEP_W * SLEEP_W) b.st += dt; else b.st = 0;
      if (b.y < KILL_Y || b.x < -40 || b.x > 120) kill(w, b, b.kind === 'guard' ? 'guard' : b.kind === 'block' ? 'lost' : 'gone');
    }
    sleepIslands(w);
    // drop the dead
    var k2 = 0;
    for (i = 0; i < n; i++) if (!bodies[i].dead) bodies[k2++] = bodies[i];
    bodies.length = k2;
  }

  // Island sleeping: bodies joined by contacts sleep together once all are still.
  function sleepIslands(w) {
    var bodies = w.bodies, n = bodies.length, par = new Int32Array(n), idx = new Map(), i;
    for (i = 0; i < n; i++) { par[i] = i; idx.set(bodies[i].id, i); }
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    w.arbs.forEach(function (a) {
      if (a.A.im > 0 && a.B.im > 0 && !a.A.dead && !a.B.dead) {
        var p = find(idx.get(a.A.id)), q = find(idx.get(a.B.id));
        if (p !== q) par[p] = q;
      }
    });
    var minSt = new Float64Array(n);
    for (i = 0; i < n; i++) minSt[i] = 1e9;
    for (i = 0; i < n; i++) { var b = bodies[i]; if (b.im > 0 && !b.dead) { var r = find(i); if (b.sleep) continue; if (b.st < minSt[r]) minSt[r] = b.st; } }
    for (i = 0; i < n; i++) {
      var bb = bodies[i];
      if (bb.im > 0 && !bb.sleep && !bb.dead && minSt[find(i)] > SLEEP_T) { bb.sleep = true; bb.vx = bb.vy = bb.w = 0; }
    }
  }

  // Converge the resting contact impulses of a freshly built (exactly placed) scene
  // without moving anything, then put it to sleep: a stack woken later starts with the
  // right warm-start impulses and doesn't sag.
  function prime(w, steps) {
    var bodies = w.bodies, n = bodies.length, i, j, dt = STEP, inv = 1 / dt;
    for (i = 0; i < n; i++) { var b = bodies[i]; b.c = Math.cos(b.a); b.s = Math.sin(b.a); aabb(b); }
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var A = bodies[i], B = bodies[j];
      if (A.im === 0 && B.im === 0) continue;
      if (A.x0 - B.x1 > MARGIN || B.x0 - A.x1 > MARGIN || A.y0 - B.y1 > MARGIN || B.y0 - A.y1 > MARGIN) continue;
      updatePair(w, A, B, MARGIN);
    }
    var list = [];
    w.arbs.forEach(function (a) { list.push(a); });
    for (i = 0; i < n; i++) { b = bodies[i]; b.vx = b.vy = b.w = 0; }
    // real steps minus the position update: the velocities the solver leaves behind feed back
    for (var s = 0; s < (steps || 30); s++) {
      for (i = 0; i < n; i++) { b = bodies[i]; if (b.im > 0) b.vy += G * dt; }
      for (i = 0; i < list.length; i++) prestep(w, list[i], inv, dt);
      for (i = 0; i < list.length; i++) warm(list[i]);
      for (var it = 0; it < ITER; it++) for (i = 0; i < list.length; i++) solve(list[i]);
    }
    for (i = 0; i < n; i++) { b = bodies[i]; b.vx = b.vy = b.w = 0; if (b.im > 0) { b.sleep = true; b.st = 0; } }
  }

  // ---- levels ----
  // Built with a few helpers so every piece rests exactly on the one below.
  // x is a piece's centre, y the height of its base. Sizes in metres.
  var POST_W = 0.3, PLANK_H = 0.3, GS = 0.7;
  function Builder() { this.items = []; }
  Builder.prototype.box = function (m, x, y, w, h) { this.items.push({ t: 'box', m: m, x: x, y: y + h / 2, hw: w / 2, hh: h / 2 }); return y + h; };
  Builder.prototype.post = function (m, x, y, h) { return this.box(m, x, y, POST_W, h || 1.6); };
  Builder.prototype.plank = function (m, x, y, w) { return this.box(m, x, y, w || 2.4, PLANK_H); };
  Builder.prototype.blk = function (m, x, y, s) { return this.box(m, x, y, s || 0.6, s || 0.6); };
  Builder.prototype.guard = function (x, y) { this.items.push({ t: 'guard', m: 'g', x: x, y: y + GS / 2, hw: GS / 2, hh: GS / 2 }); return y + GS; };
  Builder.prototype.rock = function (x0, x1, h, y) { y = y || 0; this.items.push({ t: 'rock', m: 'r', x: (x0 + x1) / 2, y: y + h / 2, hw: (x1 - x0) / 2, hh: h / 2 }); return y + h; };
  // two posts and a plank across them; returns the top
  Builder.prototype.frame = function (m, x, y, w, h, pm) {
    w = w || 2.4; h = h || 1.6;
    this.post(m, x - w / 2 + POST_W / 2, y, h); this.post(m, x + w / 2 - POST_W / 2, y, h);
    return this.plank(pm || m, x, y + h, w);
  };
  // a column of n blocks of size s
  Builder.prototype.col = function (m, x, y, n, s) { s = s || 0.6; for (var i = 0; i < n; i++) y = this.blk(m, x, y, s); return y; };
  // a stepped pyramid of blocks, rows wide at the bottom
  Builder.prototype.pyr = function (m, x, y, rows, s) {
    s = s || 0.6;
    for (var r = 0; r < rows; r++) { var k = rows - r; for (var i = 0; i < k; i++) this.blk(m, x + (i - (k - 1) / 2) * s, y, s); y += s; }
    return y;
  };

  // shots: S stone, P splitter, H boulder, B bomb, R rocket. par: shots for three stars.
  var LEVELS = [
    { name: 'First Light', shots: 'SSS', par: 1, tip: 'Drag back anywhere, aim, let go.', build: function (b) {
      var t = b.frame('w', 12, 0); b.guard(12, t);
    } },
    { name: 'Two Huts', shots: 'SSS', par: 2, build: function (b) {
      var t = b.frame('w', 11, 0); b.guard(11, t); b.guard(11, 0);
      t = b.frame('w', 15, 0); b.guard(15, t);
    } },
    { name: 'Upstairs', shots: 'SSSS', par: 2, build: function (b) {
      var t = b.frame('w', 13, 0); b.guard(13, 0);
      t = b.frame('w', 13, t); b.guard(13, t - PLANK_H - 1.6 + 0);
      b.guard(13, t);
    } },
    { name: 'Glass House', shots: 'PPS', par: 1, tip: 'Splitter: tap mid-flight to burst into three.', build: function (b) {
      var t = b.frame('i', 11.5, 0); b.guard(11.5, 0); b.guard(11.5, t);
      t = b.frame('i', 14.5, 0); b.guard(14.5, 0); b.guard(14.5, t);
    } },
    { name: 'Rampart', shots: 'SSPS', par: 2, tip: 'Lob it over the wall.', build: function (b) {
      b.col('s', 10, 0, 4); b.col('s', 10.6, 0, 3);
      var t = b.frame('w', 14, 0); b.guard(14, 0); b.guard(14, t);
    } },
    { name: 'Hilltop', shots: 'SPSS', par: 2, build: function (b) {
      var h = b.rock(11, 17, 2);
      var t = b.frame('w', 12.6, h); b.guard(12.6, t);
      t = b.frame('w', 15.4, h); b.guard(15.4, h); b.guard(15.4, t);
    } },
    { name: 'Twin Spires', shots: 'SPSS', par: 2, build: function (b) {
      var t = b.post('w', 12, 0, 2.4); t = b.plank('w', 12, t, 1.2); b.guard(12, t);
      t = b.post('w', 15, 0, 3.2); t = b.plank('w', 15, t, 1.2); b.guard(15, t);
      b.guard(13.5, 0);
    } },
    { name: 'Stone Keep', shots: 'HHS', par: 1, tip: 'Boulder: heavy enough for stone. Tap to slam down.', build: function (b) {
      var t = b.frame('s', 13, 0, 2.4, 1.6); b.guard(13, 0);
      t = b.frame('s', 13, t, 2.4, 1.2); b.guard(13, t);
    } },
    { name: 'Ice Bridge', shots: 'PSHS', par: 2, build: function (b) {
      b.post('w', 10.75, 0, 1.6); b.post('w', 13, 0, 1.6); b.post('w', 15.05, 0, 1.6);
      var t = b.plank('i', 11.8, 1.6, 2.4); b.plank('i', 14.1, 1.6, 2.2);
      b.guard(11.6, t); b.guard(14.3, t); b.guard(11.9, 0); b.guard(14.0, 0);
    } },
    { name: 'Woodpile', shots: 'SSPH', par: 2, build: function (b) {
      var t = b.pyr('w', 13.5, 0, 4, 0.6); b.guard(13.5, t);
      b.guard(11.4, 0); b.guard(15.6, 0);
    } },
    { name: 'High Ledge', shots: 'SPHS', par: 2, build: function (b) {
      var h = b.rock(14, 18, 3.6);
      var t = b.frame('w', 15.3, h, 2.0, 1.2); b.guard(15.3, t); b.guard(15.3, h);
      t = b.frame('i', 11.5, 0); b.guard(11.5, t);
    } },
    { name: 'Powder Keg', shots: 'BBS', par: 1, tip: 'Bomb: tap to blow, or it goes off after a knock.', build: function (b) {
      var t = b.frame('s', 12.4, 0, 2.0, 1.4); b.guard(12.4, 0);
      t = b.frame('w', 12.4, t, 2.0, 1.2); b.guard(12.4, t);
      t = b.frame('s', 15.2, 0, 2.0, 1.4); b.guard(15.2, 0); b.guard(15.2, t);
    } },
    { name: 'The Long Hall', shots: 'PBSH', par: 2, build: function (b) {
      b.post('w', 10.5, 0, 1.6); b.post('w', 12.8, 0, 1.6); b.post('w', 15.1, 0, 1.6); b.post('w', 17.4, 0, 1.6);
      var t = b.plank('w', 11.65, 1.6, 2.6); b.plank('w', 16.25, 1.6, 2.6);
      t = b.plank('s', 13.95, t, 3.5);
      b.guard(11.65, 0); b.guard(13.95, 0); b.guard(16.25, 0); b.guard(13.95, t);
    } },
    { name: 'Frost Tower', shots: 'PPHS', par: 2, build: function (b) {
      var t = b.frame('i', 13.5, 0, 2.4, 1.4); b.guard(13.5, 0);
      t = b.frame('i', 13.5, t, 2.0, 1.2); b.guard(13.5, t - PLANK_H - 1.2);
      t = b.frame('i', 13.5, t, 1.6, 1.0); b.guard(13.5, t);
    } },
    { name: 'Gatehouse', shots: 'HBSP', par: 2, build: function (b) {
      b.col('s', 11, 0, 5); b.col('s', 15, 0, 5);
      b.plank('s', 13, 3, 4.6);
      b.guard(13, 0); b.guard(13, 3.3); b.guard(11, 3.3);
    } },
    { name: 'Rocket Range', shots: 'RRS', par: 1, tip: 'Rocket: tap in flight for a burst of speed.', build: function (b) {
      b.col('s', 9.5, 0, 6);
      var h = b.rock(16, 21, 1.5);
      var t = b.frame('w', 17.4, h); b.guard(17.4, h); b.guard(17.4, t);
      t = b.frame('w', 20, h, 1.6, 1.2);
    } },
    { name: 'Crow’s Nest', shots: 'RPHS', par: 2, build: function (b) {
      var t = b.post('w', 14, 0, 4); t = b.plank('w', 14, t, 1.8); b.guard(13.8, t);
      b.frame('w', 11.6, 0); b.guard(11.6, 0);
      b.frame('w', 16.4, 0); b.guard(16.4, 0);
    } },
    { name: 'Terraces', shots: 'SPBHS', par: 2, build: function (b) {
      var h1 = b.rock(11, 20, 1), h2 = b.rock(14, 20, 1.2, h1), h3 = b.rock(17, 20, 1.2, h2);
      b.frame('w', 12.5, h1, 2.0, 1.2); b.guard(12.5, h1);
      b.frame('i', 15.5, h2, 2.0, 1.2); b.guard(15.5, h2);
      var t = b.frame('s', 18.5, h3, 2.0, 1.2); b.guard(18.5, h3); b.guard(18.5, t);
    } },
    { name: 'Balancing Act', shots: 'RSPH', par: 2, build: function (b) {
      var t = b.blk('s', 13.5, 0, 0.6); t = b.plank('w', 13.5, t, 4.4);
      b.blk('w', 11.8, t); b.blk('w', 15.2, t);
      b.guard(12.6, t); b.guard(14.4, t); b.guard(10.4, 0);
    } },
    { name: 'Double Keep', shots: 'HBHPS', par: 2, build: function (b) {
      var t = b.frame('s', 12, 0, 2.2, 1.4); b.guard(12, 0); t = b.frame('w', 12, t, 2.2, 1.2); b.guard(12, t);
      t = b.frame('s', 16, 0, 2.2, 1.4); b.guard(16, 0); t = b.frame('i', 16, t, 2.2, 1.2); b.guard(16, t - PLANK_H - 1.2); b.guard(16, t);
    } },
    { name: 'Avalanche', shots: 'BPRS', par: 2, build: function (b) {
      var h = b.rock(15, 21, 3.2);
      b.col('i', 15.4, h, 3); b.col('i', 16, h, 2);
      b.guard(17, h); b.guard(18.4, h);
      b.frame('w', 12.2, 0); b.guard(12.2, 0);
    } },
    { name: 'Citadel', shots: 'HBRPS', par: 2, build: function (b) {
      b.col('s', 10.6, 0, 3);
      var t = b.frame('s', 13.5, 0, 2.6, 1.6); b.guard(13.5, 0);
      t = b.frame('w', 13.5, t, 2.6, 1.4); b.guard(13.5, t - PLANK_H - 1.4);
      t = b.frame('i', 13.5, t, 1.8, 1.0); b.guard(13.5, t);
      b.frame('w', 17, 0, 2.0, 1.2); b.guard(17, 0);
    } },
    { name: 'Skyline', shots: 'RRPBS', par: 2, build: function (b) {
      var t = b.post('s', 11, 0, 3); b.plank('w', 11, t, 1.2); b.guard(11, t + PLANK_H);
      t = b.post('s', 14, 0, 4.2); b.plank('w', 14, t, 1.2); b.guard(14, t + PLANK_H);
      t = b.post('s', 17, 0, 5.2); b.plank('w', 17, t, 1.2); b.guard(17, t + PLANK_H);
    } },
    { name: 'Last Bastion', shots: 'HBPRBS', par: 3, build: function (b) {
      b.col('s', 10, 0, 4);
      var h = b.rock(13, 20, 1.2);
      var t = b.frame('s', 14.4, h, 2.4, 1.4); b.guard(14.4, h);
      t = b.frame('w', 14.4, t, 2.4, 1.2); b.guard(14.4, t - PLANK_H - 1.2);
      b.guard(14.4, t);
      t = b.frame('i', 17.8, h, 2.4, 1.6); b.guard(17.8, h); t = b.frame('w', 17.8, t, 2.0, 1.0); b.guard(17.8, t);
    } }
  ];
  function buildLevel(li) {
    var L = LEVELS[li], b = new Builder();
    L.build(b);
    return b.items;
  }
  // The view a level wants: the sling and every piece in frame.
  function levelBounds(items) {
    var x1 = 17, y1 = 4, cx0 = 1e9;
    for (var i = 0; i < items.length; i++) { var it = items[i]; x1 = Math.max(x1, it.x + it.hw); y1 = Math.max(y1, it.y + it.hh); cx0 = Math.min(cx0, it.x - it.hw); }
    return { x0: -3, x1: x1 + 1.6, y1: y1, cx0: cx0 };
  }

  // ---- a game: one level being played ----
  function newGame(li) {
    li = clamp(li | 0, 0, LEVELS.length - 1);
    var L = LEVELS[li], w = newWorld(), items = buildLevel(li), guards = 0;
    w.ground = mkBody(w, { x: 30, y: -5, hw: 200, hh: 5, mat: 'r', kind: 'ground', fixed: true });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.t === 'rock') mkBody(w, { x: it.x, y: it.y, hw: it.hw, hh: it.hh, mat: 'r', kind: 'rock', fixed: true });
      else { mkBody(w, { x: it.x, y: it.y, hw: it.hw, hh: it.hh, mat: it.m, kind: it.t === 'guard' ? 'guard' : 'block' }); if (it.t === 'guard') guards++; }
    }
    prime(w, 40);
    return {
      li: li, L: L, w: w, bounds: levelBounds(items), queue: L.shots.split(''), used: 0, score: 0, phase: 'aim',
      t: 0, flyT: 0, calmT: 0, endT: 0, proj: [], act: null, actUsed: false, guards: guards, guards0: guards,
      events: [], trail: [], lastTrail: [], acc: 0, stars: 0, bonus: 0, kills: 0, broke: 0, shotType: null
    };
  }
  function curShot(g) { return g.queue.length ? g.queue[0] : null; }
  // Where the pouch sits for an aim (angle rad, power 0..1), and the launch velocity.
  function pouch(ang, pow, type) {
    var r = (SHOTS[type] || SHOTS.S).r, x = SLING.x - Math.cos(ang) * pow * PULL_R, y = SLING.y - Math.sin(ang) * pow * PULL_R;
    return { x: x, y: Math.max(y, r + 0.06) };
  }
  // The arc a shot will fly (same integrator as the world), sampled every `every` steps.
  function preview(ang, pow, type, steps, every) {
    var p = pouch(ang, pow, type), v = pow * VMAX, vx = Math.cos(ang) * v, vy = Math.sin(ang) * v, x = p.x, y = p.y, out = [];
    for (var i = 1; i <= steps; i++) {
      vy += G * STEP; x += vx * STEP; y += vy * STEP;
      if (y < 0) break;
      if (i % every === 0) out.push(x, y);
    }
    return out;
  }
  function launch(g, ang, pow) {
    if (g.phase !== 'aim' || !g.queue.length) return false;
    pow = clamp(pow, 0, 1); ang = clamp(ang, -1.2, 1.5);
    if (pow < 0.08) return false;
    var type = g.queue.shift(), S = SHOTS[type], p = pouch(ang, pow, type), v = pow * VMAX;
    var b = mkBody(g.w, { shape: 2, r: S.r, x: p.x, y: p.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, mat: 'p', rho: S.rho, kind: 'proj', shot: type });
    g.proj = [b]; g.shotType = type; g.act = S.act; g.actUsed = false;
    g.used++; g.phase = 'fly'; g.flyT = 0; g.calmT = 0;
    g.lastTrail = g.trail; g.trail = [];
    g.events.push({ k: 'launch', type: type, v: v });
    return true;
  }
  function liveProj(g) {
    for (var i = 0; i < g.proj.length; i++) if (!g.proj[i].dead) return g.proj[i];
    return null;
  }
  // The tap: a shot's special move, once per flight.
  function ability(g) {
    if (g.phase !== 'fly' || !g.act || g.actUsed) return false;
    var p = liveProj(g), w = g.w;
    if (!p) return false;
    var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (g.act === 'split') {
      if (p.hitT >= 0 || sp < 2) return false;
      var a0 = Math.atan2(p.vy, p.vx), kids = [];
      kill(w, p, null);
      for (var k = -1; k <= 1; k++) {
        var a = a0 + k * 0.2, s = sp * (k ? 0.96 : 1.04);
        kids.push(mkBody(w, { shape: 2, r: MINI_R, x: p.x + Math.cos(a) * 0.12 * k, y: p.y + Math.sin(a) * 0.12 * k, vx: Math.cos(a) * s, vy: Math.sin(a) * s, mat: 'p', rho: 5, kind: 'proj', shot: 'P' }));
      }
      g.proj = kids;
      g.events.push({ k: 'split', x: p.x, y: p.y });
    } else if (g.act === 'slam') {
      if (p.hitT >= 0) return false;
      p.vx *= 0.35; p.vy = Math.min(p.vy, -22); p.w = 0;
      g.events.push({ k: 'slam', x: p.x, y: p.y });
    } else if (g.act === 'boost') {
      if (p.hitT >= 0 || sp < 1) return false;
      var s2 = Math.max(sp * 1.8, 24);
      p.vx = p.vx / sp * s2; p.vy = p.vy / sp * s2;
      g.events.push({ k: 'boost', x: p.x, y: p.y });
    } else if (g.act === 'boom') {
      explode(g, p);
    } else return false;
    g.actUsed = true;
    return true;
  }
  // A blast: shoves and hurts everything near, more the closer it is.
  function explode(g, p) {
    var w = g.w, bodies = w.bodies, x = p.x, y = p.y;
    kill(w, p, null);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.dead || b.im === 0) continue;
      var dx = b.x - x, dy = b.y - y, d = Math.sqrt(dx * dx + dy * dy), rad = b.shape === 2 ? b.r : Math.min(b.hw, b.hh), dd = Math.max(0, d - rad);
      if (dd > BOOM_R) continue;
      var f = 1 - dd / BOOM_R, nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1;
      if (b.sleep) wake(w, b);
      var J = BOOM_J * f;
      b.vx += nx * J * b.im; b.vy += (ny + 0.35) * J * b.im; b.w += (nx > 0 ? -1 : 1) * J * 0.3 * b.iI * 0.2;
      if (b.kind !== 'proj') hurt(w, b, BOOM_DMG * f * f * (b.mat === 's' ? 0.75 : 1));
    }
    g.actUsed = true;
    g.events.push({ k: 'boom', x: x, y: y });
  }
  function countGuards(g) {
    var n = 0, B = g.w.bodies;
    for (var i = 0; i < B.length; i++) if (B[i].kind === 'guard' && !B[i].dead) n++;
    return n;
  }
  function settle(g) {
    var B = g.w.bodies, mx = 0;
    for (var i = 0; i < B.length; i++) {
      var b = B[i];
      if (b.im === 0 || b.sleep || b.dead) continue;
      var v = b.vx * b.vx + b.vy * b.vy + b.w * b.w * 0.2;
      if (v > mx) mx = v;
    }
    return Math.sqrt(mx);
  }
  function starsFor(L, used) { return used <= L.par ? 3 : used <= L.par + 1 ? 2 : 1; }

  // One fixed step of a game.
  function stepGame(g) {
    if (g.phase === 'won' || g.phase === 'over') return;
    var w = g.w, i;
    stepWorld(w);
    g.t += STEP;
    for (i = 0; i < w.events.length; i++) {
      var e = w.events[i];
      if (e.k === 'break') { g.score += MATS[e.b.mat].pts; g.broke++; e.pts = MATS[e.b.mat].pts; }
      else if (e.k === 'lost') { g.score += Math.round(MATS[e.b.mat].pts / 2); e.pts = Math.round(MATS[e.b.mat].pts / 2); }
      else if (e.k === 'guard') { g.score += GUARD_PTS; g.kills++; e.pts = GUARD_PTS; }
      g.events.push(e);
    }
    w.events.length = 0;
    g.guards = countGuards(g);
    var p = liveProj(g);
    if (g.phase === 'fly') {
      g.flyT += STEP;
      if (p && (w.steps % 3 === 0) && g.trail.length < 600 && p.hitT < 0) g.trail.push(p.x, p.y);
      // the bomb's fuse
      if (p && g.act === 'boom' && !g.actUsed && p.hitT >= 0 && w.t - p.hitT > FUSE) explode(g, p);
      if (p && g.act === 'boom' && !g.actUsed && p.sleep) explode(g, p);
      var moving = false;
      for (i = 0; i < g.proj.length; i++) {
        var q = g.proj[i];
        if (q.dead || q.sleep) continue;
        if (q.x > g.bounds.x1 + 14 || q.x < -14) { kill(w, q, 'gone'); continue; }
        if (q.vx * q.vx + q.vy * q.vy > 0.36) moving = true;
      }
      if (g.guards === 0) { g.phase = 'clear'; g.endT = 0; g.events.push({ k: 'clear' }); }
      else if (!moving || g.flyT > 9) {
        if (settle(g) < 0.3) g.calmT += STEP; else g.calmT = 0;
        if (g.calmT > 0.45 || g.flyT > 14) endTurn(g);
      }
    } else if (g.phase === 'aim') {
      if (g.guards === 0) { g.phase = 'clear'; g.endT = 0; g.events.push({ k: 'clear' }); }
    } else if (g.phase === 'clear') {
      g.endT += STEP;
      if (g.endT > 1.4) {
        g.bonus = g.queue.length * SHOT_BONUS; g.score += g.bonus;
        g.stars = starsFor(g.L, g.used);
        g.phase = 'won'; g.events.push({ k: 'won' });
      }
    } else if (g.phase === 'lost') {
      g.endT += STEP;
      if (g.endT > 0.6) { g.phase = 'over'; g.events.push({ k: 'over' }); }
    }
  }
  function endTurn(g) {
    // spent shots stay where they lie, except ones that fell short (clutter by the sling)
    for (var i = 0; i < g.proj.length; i++) {
      var q = g.proj[i];
      q.spent = true;
      if (!q.dead && q.x < g.bounds.cx0 - 1.5) kill(g.w, q, null);
    }
    g.act = null;
    if (g.guards === 0) { g.phase = 'clear'; g.endT = 0; g.events.push({ k: 'clear' }); }
    else if (!g.queue.length) { g.phase = 'lost'; g.endT = 0; g.events.push({ k: 'out' }); }
    else { g.phase = 'aim'; g.events.push({ k: 'ready' }); }
  }
  function advance(g, dt) {
    g.acc = Math.min(g.acc + dt, 0.25);
    while (g.acc >= STEP) { stepGame(g); g.acc -= STEP; if (g.phase === 'won' || g.phase === 'over') { g.acc = 0; break; } }
    return g.acc / STEP;
  }
  // Headless: play a list of shots [{a, p, tap (seconds after launch, optional)}]; for tests.
  function play(li, shots, maxSteps) {
    var g = newGame(li), k = 0, steps = 0, tapAt = -1;
    maxSteps = maxSteps || 120 * 120;
    while (steps++ < maxSteps && g.phase !== 'won' && g.phase !== 'over') {
      if (g.phase === 'aim') {
        if (k >= shots.length) break;
        var s = shots[k++];
        launch(g, s.a, s.p);
        tapAt = s.tap != null ? s.tap : -1;
      }
      if (g.phase === 'fly' && tapAt >= 0 && g.flyT >= tapAt) { ability(g); tapAt = -1; }
      stepGame(g);
      g.events.length = 0;
    }
    return g;
  }

  // ---- the save ----
  function newSave() { return { v: 1, lv: [], last: 0, shots: 0, kills: 0 }; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (Array.isArray(o.lv)) {
      for (var i = 0; i < LEVELS.length && i < o.lv.length; i++) {
        var r = o.lv[i];
        if (r && typeof r === 'object') s.lv[i] = { s: clamp(+r.s | 0, 0, 3), b: Math.max(0, Math.floor(+r.b || 0)) };
        else s.lv[i] = null;
        if (s.lv[i] && !s.lv[i].s) s.lv[i] = null;
      }
    }
    while (s.lv.length && !s.lv[s.lv.length - 1]) s.lv.length--;
    for (i = 0; i < s.lv.length; i++) if (!s.lv[i]) s.lv[i] = null;
    s.last = clamp(+o.last | 0, 0, LEVELS.length - 1);
    s.shots = Math.max(0, +o.shots | 0); s.kills = Math.max(0, +o.kills | 0);
    return s;
  }
  function cleared(save, li) { return !!(save.lv[li] && save.lv[li].s > 0); }
  // A level is open when it's the first, or the one before it is cleared.
  function unlocked(save, li) { return li === 0 || cleared(save, li - 1) || cleared(save, li); }
  function totalStars(save) { var n = 0; for (var i = 0; i < save.lv.length; i++) if (save.lv[i]) n += save.lv[i].s; return n; }
  function nextLevel(save) { for (var i = 0; i < LEVELS.length; i++) if (!cleared(save, i)) return i; return LEVELS.length - 1; }
  // Fold a finished level into the save; returns what's new.
  function record(save, g) {
    var li = g.li, old = save.lv[li], res = { newStars: false, newBest: false, first: !old };
    save.shots += g.used; save.kills += g.kills; save.last = li;
    if (g.phase !== 'won') return res;
    while (save.lv.length < li) save.lv.push(null);
    if (!old) { save.lv[li] = { s: g.stars, b: g.score }; res.newStars = true; res.newBest = true; }
    else {
      if (g.stars > old.s) { old.s = g.stars; res.newStars = true; }
      if (g.score > old.b) { old.b = g.score; res.newBest = true; }
    }
    return res;
  }

  var ENGINE = {
    STEP: STEP, G: G, VMAX: VMAX, PULL_R: PULL_R, SLING: SLING, MATS: MATS, SHOTS: SHOTS, SHOT_ORDER: SHOT_ORDER, LEVELS: LEVELS,
    GUARD_PTS: GUARD_PTS, SHOT_BONUS: SHOT_BONUS, BOOM_R: BOOM_R,
    newWorld: newWorld, mkBody: mkBody, collide: collide, stepWorld: stepWorld, prime: prime, wake: wake, wakeAll: wakeAll, kill: kill,
    buildLevel: buildLevel, levelBounds: levelBounds, newGame: newGame, curShot: curShot, pouch: pouch, preview: preview,
    launch: launch, ability: ability, explode: explode, stepGame: stepGame, advance: advance, play: play, liveProj: liveProj,
    countGuards: countGuards, starsFor: starsFor, settle: settle,
    newSave: newSave, normSave: normSave, cleared: cleared, unlocked: unlocked, totalStars: totalStars, nextLevel: nextLevel, record: record
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('slingshot.css');

  var PANEL_ID = 'slingshot-panel', NAME = 'Siege Sling';
  var KEY = 'cade-slingshot-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = 440, CW = 8, RH = 12, DRAG_PX = 78;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.slingshot = { live: function () { return S; }, start: function (li) { startLevel(li); }, fire: function (a, p) { S.aim = { a: a, p: p, on: true, kb: true }; fire(); }, tap: function () { mainPress(); } };   // test-only peek

  // palette slots, filled from the theme
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_WOOD = 10, C_STONE = 11, C_ROCK = 12, C_CLOUD = 13, C_RIDGE = 14, C_BAND = 15, C_SUN = 16, C_STAR = 17, NPAL = 18;
  var MAT_SLOT = { w: C_WOOD, s: C_STONE, i: C_ICE, g: C_RED, r: C_ROCK, p: C_MUTED };
  var SHOT_SLOT = { S: C_MUTED, P: C_ACC, H: C_STONE, B: C_RED, R: C_FLAME };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.nb = null; }
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
  // a short burst of filtered noise (crunches, the blast)
  Snd.prototype.noise = function (dur, vol, freq, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var len = Math.floor(ac.sampleRate * 0.6), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0), x = 0;
        for (var i = 0; i < len; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; d[i] = x / 0x3fffffff - 1; }
        this.nb = buf;
      }
      var t = ac.currentTime + (delay || 0), src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb; f.type = 'lowpass'; f.frequency.setValueAtTime(freq || 1200, t);
      g.gain.setValueAtTime(vol || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(ac.destination);
      src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
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
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_ICE] = dark ? '#7cc7f2' : '#2878b5'; P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a'; P[C_VIOLET] = dark ? '#b79cf5' : '#7351c4';
    P[C_WOOD] = dark ? '#d39b5c' : '#9a5b1e'; P[C_STONE] = css(mix(tx, bg, dark ? 0.25 : 0.3));
    P[C_ROCK] = css(mix(bg, tx, dark ? 0.42 : 0.4)); P[C_CLOUD] = css(mix(bg, tx, dark ? 0.2 : 0.16));
    P[C_RIDGE] = css(mix(bg, ac, dark ? 0.2 : 0.16)); P[C_BAND] = dark ? '#c9705a' : '#8c3b2a';
    P[C_SUN] = dark ? '#ffb347' : '#de8a12'; P[C_STAR] = css(mix(bg, tx, dark ? 0.42 : 0.3));
    S.rgb = { bg: bg, tx: tx, ac: ac };
    S.col = {
      bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      g1: css(mix(bg, parseCol(P[C_LEAF]), dark ? 0.2 : 0.17)), g2: css(mix(bg, parseCol(P[C_LEAF]), dark ? 0.13 : 0.1)),
      e1: css(mix(bg, parseCol(P[C_WOOD]), dark ? 0.2 : 0.16)), e2: css(mix(bg, parseCol(P[C_WOOD]), dark ? 0.13 : 0.1))
    };
    fitFont();
  }

  // ---- glyph rendering ----
  // Every glyph is rendered once per (colour, character) into an atlas canvas at
  // device resolution and stamped with drawImage (cheap on iOS).
  var AT_COLS = 24, AT_ROWS = 20;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    S.adv = adv;
    buildAtlas();
    buildClouds();
    S.tex = {};
    if (S.texN) S.texList.forEach(freeCanvas);
    S.texList = []; S.texN = 0;
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 2;
    a.cwp = Math.ceil((CW + 6) * S.k * a.sc); a.chp = Math.ceil((RH + 8) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) { var m = new Int16Array(128); for (var j = 0; j < 128; j++) m[j] = -1; S.gmap.push(m); }
  }
  function gIdx(ci, code) {
    if (code >= 128) return -1;
    var m = S.gmap[ci], i = m[code], a = S.atl;
    if (i >= 0) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    m[code] = i;
    return i;
  }
  function glyph(c, ci, code, x, y, nosnap, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = x - w / 2, dy = y - h / 2;
    if (!nosnap) { dx = Math.round(dx * S.k) / S.k; dy = Math.round(dy * S.k) / S.k; }
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, nosnap, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, nosnap, sc);
    return x0 + n * cw;
  }

  // Cloud tiles, pre-rendered per theme / size.
  var CLOUD_SHAPES = [
    ['    .--~~--.', ' .-(        )-.', '(______________)'],
    ['  .--.', '.(    )-.', '(________)'],
    ['   _.~~._', ' .(      ).', '(___________)']
  ];
  function buildClouds() {
    if (!S.k || !S.col) return;
    if (S.cloudT) S.cloudT.forEach(function (t) { freeCanvas(t.cv); });
    S.cloudT = CLOUD_SHAPES.map(function (sh) {
      var w = 0;
      sh.forEach(function (r) { w = Math.max(w, r.length); });
      var cv = document.createElement('canvas'), wl = w * CW + 4, hl = sh.length * RH + 6;
      cv.width = Math.ceil(wl * S.k); cv.height = Math.ceil(hl * S.k);
      var c = cv.getContext('2d');
      c.setTransform(S.k, 0, 0, S.k, 0, 0);
      c.font = S.fnt; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = S.pal[C_CLOUD];
      sh.forEach(function (r, i) { c.fillText(r, 2, 3 + i * RH + RH / 2); });
      return { cv: cv, w: wl, h: hl };
    });
  }
  // A small seeded PRNG for the scenery (stable between frames).
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A distant ASCII range: a seeded walk of / \ and _.
  function range(seed, maxH, n) {
    var r = rng(seed), out = [], L = 0, up = true;
    for (var i = 0; i < n; i++) {
      if (L === 0 && !up && r() < 0.45) { out.push([95, 0]); up = true; continue; }
      if (L >= maxH || (L > 0 && r() < (up ? 0.2 : 0.08))) up = false;
      else if (L === 0 || r() < (up ? 0.04 : 0.14)) up = true;
      if (up) { L++; out.push([47, L]); } else { out.push([92, L]); L--; }
    }
    while (L > 0) { out.push([92, L]); L--; }
    return out;
  }
  var FAR = range(31, 4, 120);
  var CLOUDS = (function () { var r = rng(7), a = []; for (var i = 0; i < 5; i++) a.push({ u: r() * 700, v: r(), s: Math.floor(r() * 3), sp: 3 + r() * 5 }); return a; })();
  var STARS = (function () { var r = rng(13), a = []; for (var i = 0; i < 34; i++) a.push({ x: r() * VW, y: r(), c: r() < 0.15 ? 43 : r() < 0.25 ? 42 : 46 }); return a; })();

  // ---- block textures: a tinted tile, an ink border and a glyph grain; cached per size ----
  var GRAIN = { w: '=', s: '#', i: '/', r: '%' };
  // Tiles are keyed by world size and rendered at the closest zoom, so the camera's
  // easing never rebuilds them; they scale down for the wide view.
  function tex(mat, hw, hh, crack, face) {
    var key = mat + '|' + Math.round(hw * 200) + '|' + Math.round(hh * 200) + '|' + crack + '|' + (face || '');
    var t = S.tex[key];
    if (t) return t;
    if (S.texN > 300) { S.texList.forEach(freeCanvas); S.tex = {}; S.texList = []; S.texN = 0; }
    var zt = (S.camNear || S.cam).z, wl = 2 * hw * zt, hl = 2 * hh * zt;
    var k = S.k, W = Math.max(2, Math.ceil(wl * k)), H = Math.max(2, Math.ceil(hl * k)), cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var c = cv.getContext('2d'), col = parseCol(S.pal[MAT_SLOT[mat]], [128, 128, 128]), bg = S.rgb.bg, lw = Math.max(1, Math.round(k));
    c.fillStyle = css(mix(bg, col, mat === 'r' ? (S.dark ? 0.24 : 0.2) : mat === 'i' ? (S.dark ? 0.2 : 0.15) : (S.dark ? 0.3 : 0.24)));
    c.fillRect(0, 0, W, H);
    // the grain: glyphs on a grid, sized to the tile
    var fs = clamp(Math.min(wl, hl) * 0.95, 5, 11) * k, gw = fs * S.adv, gh = fs * 1.05;
    c.font = '600 ' + fs.toFixed(2) + 'px ' + S.col.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = css(mix(bg, col, S.dark ? 0.62 : 0.58));
    if (mat === 'g') {
      // a guard: a helmet band, two eyes and a mouth
      c.fillStyle = css(col); c.fillRect(0, 0, W, Math.round(H * 0.24));
      c.fillStyle = S.pal[C_TEXT];
      var ex = W * 0.3, ey = H * 0.5, er = Math.max(1, W * 0.075);
      if (face === 'blink' || face === 'ko') {
        c.fillRect(ex - er * 1.4, ey - er * 0.4, er * 2.8, er * 0.8); c.fillRect(W - ex - er * 1.4, ey - er * 0.4, er * 2.8, er * 0.8);
      } else {
        c.beginPath(); c.arc(ex, ey, er, 0, 6.3); c.arc(W - ex, ey, er, 0, 6.3); c.fill();
      }
      c.fillRect(W * 0.36, H * 0.72, W * 0.28, Math.max(1, H * 0.06));
      c.font = '700 ' + (W * 0.3).toFixed(2) + 'px ' + S.col.font; c.fillStyle = S.pal[C_GOLD];
      c.fillText('^', W / 2, H * 0.16);
    } else if (mat === 'w') {
      var horiz = wl >= hl, ch = horiz ? '=' : '|';
      var nx = Math.max(1, Math.floor(W / gw)), ny = Math.max(1, Math.floor(H / gh));
      for (var yy = 0; yy < ny; yy++) for (var xx = 0; xx < nx; xx++) {
        if (((xx * 7 + yy * 3) % 5) === 0) continue;
        c.fillText(ch, (xx + 0.5) * W / nx, (yy + 0.55) * H / ny);
      }
    } else {
      var gx = Math.max(1, Math.floor(W / gw)), gy = Math.max(1, Math.floor(H / gh)), g0 = GRAIN[mat] || '#';
      for (var y2 = 0; y2 < gy; y2++) for (var x2 = 0; x2 < gx; x2++) {
        var on = mat === 's' ? ((x2 + y2) % 2 === 0) : mat === 'i' ? ((x2 * 3 + y2 * 5) % 4 === 0) : ((x2 * 5 + y2 * 3) % 3 !== 1);
        if (!on) continue;
        c.fillText(mat === 'r' && (x2 + y2) % 4 === 0 ? ':' : g0, (x2 + 0.5) * W / gx, (y2 + 0.55) * H / gy);
      }
      if (mat === 'i') { c.fillStyle = 'rgba(255,255,255,' + (S.dark ? 0.12 : 0.35) + ')'; c.fillRect(lw, lw, W - 2 * lw, Math.max(1, H * 0.18)); }
    }
    if (crack) {
      c.strokeStyle = S.pal[C_TEXT]; c.lineWidth = Math.max(1, k * 0.8); c.globalAlpha = 0.75;
      var r = rng(W * 31 + H * 7 + crack), n = crack * 2 + 1;
      c.beginPath();
      for (var q = 0; q < n; q++) {
        var x0 = r() * W, y0 = r() * H, ang = r() * 6.3, len = Math.min(W, H) * (0.5 + r() * 0.8) + 2 * k;
        c.moveTo(x0, y0); c.lineTo(x0 + Math.cos(ang) * len * 0.5, y0 + Math.sin(ang) * len * 0.5);
        c.lineTo(x0 + Math.cos(ang + 0.7) * len, y0 + Math.sin(ang + 0.7) * len);
      }
      c.stroke(); c.globalAlpha = 1;
    }
    c.strokeStyle = mat === 'r' ? css(mix(bg, col, 0.7)) : css(col); c.lineWidth = lw;
    c.strokeRect(lw / 2, lw / 2, W - lw, H - lw);
    t = { cv: cv };
    S.tex[key] = t; S.texList.push(cv); S.texN++;
    return t;
  }

  // ---- particles (world space) and score pop-ups; pools allocated once ----
  var NPART = 140, NPOP = 10;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, s: '', ci: C_GOLD });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
    S.shake = 0; S.flash = 0; S.msg = null; S.msgQ.length = 0;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life, up) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.3 + Math.random() * 0.7);
      spark(x, y, Math.cos(a) * v, (up ? Math.abs(Math.sin(a)) : Math.sin(a)) * v, life * (0.6 + Math.random() * 0.6), codes.charCodeAt(i % codes.length), ci, g);
    }
  }
  function popup(x, y, s, ci) {
    var p = S.pops[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.s = s; p.ci = ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y < 0.05 && p.g > 0) { p.y = 0.05; p.vy = -p.vy * 0.3; p.vx *= 0.6; }
    }
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1.2) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- the camera: the level's bounds fitted to the view ----
  // Two framings: the whole level (aiming), and closer in on the castle while a
  // shot is in flight; the view eases between them (render state only).
  function camFor(x0, x1, y1) {
    var VH = S.VH, bottom = -1.15, span = x1 - x0, z = VW / span, need = y1 + 2.4 - bottom;
    if (need * z > VH - 26) z = (VH - 26) / need;
    return { z: z, bottom: bottom, left: x0 - (VW / z - span) * 0.4 };
  }
  function fitCam() {
    var g = S.g, b = g ? g.bounds : { x0: -3, x1: 20, y1: 5, cx0: 10 };
    S.camWide = camFor(b.x0, b.x1, b.y1);
    S.camNear = camFor(Math.max(b.x0, b.cx0 - 2.2), b.x1, b.y1 + 0.6);
    if (S.camNear.z < S.camWide.z * 1.12) S.camNear = S.camWide;
    S.camU = 0;
    S.cam = { z: S.camWide.z, bottom: S.camWide.bottom, left: S.camWide.left };
    if (S.texList && S.texN && S.texZ !== S.camNear.z) { S.texList.forEach(freeCanvas); S.tex = {}; S.texList = []; S.texN = 0; }
    S.texZ = S.camNear.z;
  }
  function stepCam(dt) {
    var g = S.g, want = 0;
    if (g && (g.phase === 'fly' || g.phase === 'clear')) {
      var p = liveProj(g);
      want = !p || p.x > g.bounds.cx0 * 0.45 || g.flyT > 1.2 ? 1 : 0;
    }
    if (S.rm) S.camU = want; else S.camU += (want - S.camU) * (1 - Math.exp(-(want ? 2.6 : 4) * dt));
    var u = S.camU * S.camU * (3 - 2 * S.camU), A = S.camWide, B = S.camNear;
    // interpolate the scale geometrically and keep the left edge consistent with it
    S.cam.z = A.z * Math.pow(B.z / A.z, u);
    S.cam.left = A.left + (B.left - A.left) * u;
    S.cam.bottom = A.bottom;
  }
  function X(wx) { return (wx - S.cam.left) * S.cam.z; }
  function Y(wy) { return S.VH - (wy - S.cam.bottom) * S.cam.z; }

  // ---- drawing ----
  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, VH = S.VH, g = S.g, z = S.cam.z, i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    c.fillStyle = S.col.bg; c.fillRect(-12, -12, VW + 24, VH + 24);
    var gy = Y(0);
    // sky: stars (dark), sun / moon, clouds drifting, a far range
    if (S.dark) for (i = 0; i < STARS.length; i++) { var st = STARS[i], sy = 30 + st.y * (gy - 90); glyph(c, C_STAR, st.c, st.x, sy, false, st.c === 46 ? 1 : 0.75); }
    if (S.dark) { drawStr(c, C_STAR, '_.', VW * 0.86, 40, 'center'); drawStr(c, C_STAR, '( (', VW * 0.86 + 2, 40 + RH, 'center'); drawStr(c, C_STAR, "'-'", VW * 0.86, 40 + RH * 2, 'center'); }
    else {
      var fl = ((S.idleT * 1.5) | 0) % 2, sx0 = VW * 0.86, sy0 = 46;
      drawStr(c, C_SUN, fl ? '\\ | /' : '. | .', sx0, sy0 - RH, 'center');
      drawStr(c, C_SUN, '-( )-', sx0, sy0, 'center');
      drawStr(c, C_SUN, fl ? '/ | \\' : "' | '", sx0, sy0 + RH, 'center');
      glyph(c, C_SUN, 79, sx0, sy0);
    }
    for (i = 0; i < CLOUDS.length; i++) {
      var cl = CLOUDS[i], tl = S.cloudT[cl.s], cx = ((cl.u + S.idleT * cl.sp) % (VW + 260)) - 160, cy = 30 + cl.v * Math.max(10, gy * 0.32 - 30);
      c.drawImage(tl.cv, cx, cy, tl.w, tl.h);
    }
    for (i = 0; i < FAR.length && i * CW < VW + CW; i++) {
      var fg = FAR[i];
      glyph(c, C_RIDGE, fg[0], i * CW + CW / 2, gy - RH * 0.4 - fg[1] * RH * 0.75 + (fg[0] === 95 ? -RH * 0.45 : 0));
    }
    // ground: contour bands, a grass line
    var bh = Math.max(7, z * 0.32);
    for (var bi = 0; gy + bi * bh < VH + 2; bi++) {
      c.fillStyle = bi === 0 ? S.col.g1 : bi % 2 ? S.col.e1 : S.col.e2;
      c.fillRect(-12, gy + bi * bh, VW + 24, bh + 1);
    }
    var gx0 = Math.floor(-CW);
    for (var gx = gx0; gx < VW + CW; gx += CW) {
      var hsh = ((Math.floor((gx + S.cam.left * z) / CW) * 2654435761) >>> 0) % 7;
      glyph(c, C_LEAF, hsh < 2 ? 39 : hsh < 4 ? 44 : hsh < 5 ? 34 : 46, gx + CW / 2, gy - RH * 0.15);
    }
    if (!g) return;
    var bodies = g.w.bodies;
    // static rock first
    for (i = 0; i < bodies.length; i++) if (bodies[i].kind === 'rock') drawBody(c, bodies[i], 1);
    drawSling(c, alpha, true);
    // last shot's trail, the aim preview
    if (g.lastTrail.length && g.phase === 'aim') drawDots(c, g.lastTrail, C_FAINT, 0.55, 2);
    if (g.trail.length) drawDots(c, g.trail, C_FAINT, 0.8, 1);
    if (g.phase === 'aim' && S.aim.on) {
      var pv = preview(S.aim.a, S.aim.p, curShot(g), 100, 7);
      for (i = 0; i < pv.length; i += 2) {
        c.globalAlpha = Math.max(0.15, 1 - i / pv.length);
        glyph(c, C_ACC, i % 4 ? 46 : 111, X(pv[i]), Y(pv[i + 1]), true, i % 4 ? 1 : 0.55);
      }
      c.globalAlpha = 1;
    }
    for (i = 0; i < bodies.length; i++) { var b = bodies[i]; if (b.kind === 'block' || b.kind === 'guard') drawBody(c, b, alpha); }
    for (i = 0; i < bodies.length; i++) if (bodies[i].kind === 'proj') drawProj(c, bodies[i], alpha);
    drawSling(c, alpha, false);
    drawQueue(c);
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, X(p.x), Y(p.y), true);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.2 - pp.t));
      drawStr(c, pp.ci, pp.s, X(pp.x), Y(pp.y) - 10 - pp.t * 22, 'center');
    }
    c.globalAlpha = 1;
    // a stone above the view: a marker at the top edge
    var lp = liveProj(g);
    if (lp && Y(lp.y) < 4) { var mx = clamp(X(lp.x), 8, VW - 8); glyph(c, SHOT_SLOT[lp.shot] || C_MUTED, 94, mx, 30); drawStr(c, C_FAINT, Math.round(lp.y) + 'm', mx, 30 + RH, 'center', false, 0.8); }
    hud(c, g);
    if (S.msg && !S.cardKind) banner(c, S.msg.text, Math.min(VH * 0.3, 92), S.msg.ci);
    if (S.flash > 0 && !S.rm) { c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')'; c.fillRect(-12, -12, VW + 24, VH + 24); }
  }
  function drawDots(c, T, ci, a, every) {
    c.globalAlpha = a;
    for (var i = 0; i < T.length; i += 2 * every * 2) glyph(c, ci, 46, X(T[i]), Y(T[i + 1]), true);
    c.globalAlpha = 1;
  }
  function interp(b, alpha) {
    var x = b.px + (b.x - b.px) * alpha, y = b.py + (b.y - b.py) * alpha, a = b.pa + (b.a - b.pa) * alpha;
    return { x: x, y: y, a: a };
  }
  function drawBody(c, b, alpha) {
    var z = S.cam.z, q = interp(b, alpha), wl = 2 * b.hw * z, hl = 2 * b.hh * z;
    var crack = b.hp0 > 0 ? (b.hp < b.hp0 * 0.34 ? 2 : b.hp < b.hp0 * 0.7 ? 1 : 0) : 0, face = '';
    if (b.kind === 'guard') {
      crack = 0;
      var bl = ((S.idleT * 0.7 + b.id * 0.37) % 3.2);
      face = b.hp < b.hp0 * 0.6 ? 'ko' : bl < 0.14 ? 'blink' : '';
    }
    var t = tex(b.kind === 'guard' ? 'g' : b.mat, b.hw, b.hh, crack, face), sx = X(q.x), sy = Y(q.y);
    if (q.a === 0 && b.kind === 'rock') { c.drawImage(t.cv, sx - wl / 2, sy - hl / 2, wl, hl); return; }
    c.save(); c.translate(sx, sy); c.rotate(-q.a);
    c.drawImage(t.cv, -wl / 2, -hl / 2, wl, hl);
    c.restore();
  }
  function drawProj(c, b, alpha) {
    var z = S.cam.z, q = interp(b, alpha), sx = X(q.x), sy = Y(q.y), r = b.r * z, ci = SHOT_SLOT[b.shot] || C_MUTED;
    c.globalAlpha = b.spent ? 0.55 : 1;
    c.fillStyle = S.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    c.beginPath(); c.arc(sx, sy, r, 0, 6.2832); c.fill();
    c.strokeStyle = S.pal[ci]; c.lineWidth = Math.max(1.2, r * 0.22);
    c.beginPath(); c.arc(sx, sy, Math.max(1, r - c.lineWidth / 2), 0, 6.2832); c.stroke();
    var sh = SHOTS[b.shot] || SHOTS.S;
    c.save(); c.translate(sx, sy); c.rotate(-q.a);
    glyph(c, ci, sh.ch.charCodeAt(0), 0, 0, true, Math.max(0.5, r * 1.6 / RH));
    c.restore();
    c.globalAlpha = 1;
  }
  // The sling: a Y of two glyph-grained posts, the bands drawn back to the pouch.
  function slingPos() {
    var g = S.g, a = S.aim;
    if (g && g.phase === 'aim' && a.on && S.drag) return pouch(a.a, a.p, curShot(g));
    if (g && g.phase === 'aim' && a.on && a.kb) return pouch(a.a, a.p * 0.85, curShot(g));
    return { x: SLING.x, y: SLING.y };
  }
  function drawSling(c, alpha, back) {
    var g = S.g, z = S.cam.z, p = slingPos(), fx = back ? 0.2 : -0.2, fy = SLING.y + 0.12;
    var bandW = Math.max(1.5, z * 0.08);
    if (back) {
      // the trunk and the back prong
      c.strokeStyle = S.pal[C_WOOD]; c.lineCap = 'round';
      c.lineWidth = Math.max(3, z * 0.22);
      c.beginPath(); c.moveTo(X(0), Y(0)); c.lineTo(X(0), Y(SLING.y - 0.55)); c.lineTo(X(fx), Y(fy)); c.stroke();
      c.beginPath(); c.moveTo(X(0), Y(SLING.y - 0.55)); c.lineTo(X(-fx), Y(fy)); c.stroke();
      // grain glyphs on the trunk
      for (var yy = 0.3; yy < SLING.y - 0.6; yy += 0.42) glyph(c, C_BAND, 61, X(0), Y(yy), true, Math.max(0.5, z * 0.022));
    }
    var loaded = g && g.phase === 'aim' && g.queue.length;
    c.strokeStyle = S.pal[C_BAND]; c.lineWidth = bandW; c.lineCap = 'round';
    c.beginPath(); c.moveTo(X(fx), Y(fy)); c.lineTo(X(p.x), Y(p.y)); c.stroke();
    if (back && loaded) {
      var sh = SHOTS[curShot(g)], r = sh.r * z;
      c.fillStyle = S.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      c.beginPath(); c.arc(X(p.x), Y(p.y), r, 0, 6.2832); c.fill();
      c.strokeStyle = S.pal[SHOT_SLOT[sh.id]]; c.lineWidth = Math.max(1.2, r * 0.22);
      c.beginPath(); c.arc(X(p.x), Y(p.y), Math.max(1, r - c.lineWidth / 2), 0, 6.2832); c.stroke();
      glyph(c, SHOT_SLOT[sh.id], sh.ch.charCodeAt(0), X(p.x), Y(p.y), true, Math.max(0.5, r * 1.6 / RH));
    }
    if (!back) { glyph(c, C_WOOD, 111, X(-0.2), Y(fy + 0.05), true, Math.max(0.5, z * 0.03)); }
  }
  // The shots still to come, lined up behind the sling.
  function drawQueue(c) {
    var g = S.g, z = S.cam.z, x = -0.5;
    for (var i = (g.phase === 'aim' ? 1 : 0); i < g.queue.length; i++) {
      var sh = SHOTS[g.queue[i]], rw = sh.r * 0.72, r = rw * z, ci = SHOT_SLOT[sh.id];
      x -= rw;
      c.strokeStyle = S.pal[ci]; c.lineWidth = Math.max(1, r * 0.2);
      c.beginPath(); c.arc(X(x), Y(rw), r, 0, 6.2832); c.stroke();
      glyph(c, ci, sh.ch.charCodeAt(0), X(x), Y(rw), true, Math.max(0.45, r * 1.5 / RH));
      x -= rw + 0.1;
    }
  }
  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.globalAlpha = 0.88; c.fillRect(VW / 2 - w / 2, y - RH * 0.8, w, RH * 1.6); c.globalAlpha = 1;
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.5, y);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.5, y);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }
  function hud(c, g) {
    var y = RH * 0.95;
    drawStr(c, C_MUTED, 'LV ' + pad2(g.li + 1), 6, y, 'left');
    var x = 6 + 6 * CW;
    glyph(c, C_RED, 64, x + CW / 2, y);
    drawStr(c, C_TEXT, 'x' + g.guards, x + CW, y, 'left');
    var sc = fmtInt(g.score);
    drawStr(c, C_TEXT, sc, VW - 6, y, 'right');
    var best = S.save.lv[g.li];
    if (best && best.b) drawStr(c, C_FAINT, 'best ' + fmtInt(best.b), VW - 6, y + RH, 'right', false, 0.8);
    // par hint: stars still in reach
    var st = starsFor(g.L, g.used + (g.phase === 'aim' ? 1 : 0)), sx = 6;
    for (var i = 0; i < 3; i++) glyph(c, i < st ? C_GOLD : C_FAINT, i < st ? 42 : 46, sx + i * CW + CW / 2, y + RH);
    if (g.phase === 'fly' && g.act && !g.actUsed) {
      var lp = liveProj(g), ok = lp && (g.act === 'boom' || lp.hitT < 0);
      if (ok) {
        var lab = (S.coarse ? 'TAP' : 'SPACE') + ': ' + ACT_LABEL[g.act];
        var pulse = 0.6 + 0.4 * Math.abs(Math.sin(S.idleT * 6));
        c.globalAlpha = pulse; drawStr(c, SHOT_SLOT[g.shotType] || C_ACC, lab, VW / 2, y, 'center'); c.globalAlpha = 1;
      }
    }
    if (g.phase === 'aim' && S.aim.on) {
      var deg = Math.round(S.aim.a * 180 / Math.PI), pw = Math.round(S.aim.p * 100);
      drawStr(c, C_ACC, deg + '° ' + pw + '%', VW / 2, y, 'center');
    }
  }
  var ACT_LABEL = { split: 'SPLIT!', slam: 'SLAM!', boom: 'BOOM!', boost: 'BOOST!' };

  // ---- the loop: runs only while a level is being played (not paused, not minimized) ----
  function running() { return !!S && S.phase === 'play' && !S.paused && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad(dt);
    if (!running()) return;
    S.idleT += dt;
    keyAim(dt);
    var g = S.g, alpha = advance(g, dt);
    handleEvents(g);
    stepFx(dt);
    stepCam(dt);
    if (g.phase === 'fly') fxFlight(g);
    draw(alpha, dt);
    if (!S || !S.g) return;
    if (S.g.phase === 'won' || S.g.phase === 'over') { S.endT += dt; if (S.endT > 0.55) { finish(); return; } }
    syncPadLive();
    S.raf = requestAnimationFrame(frame);
  }
  // trailing sparks behind a flying shot
  function fxFlight(g) {
    if (S.rm) return;
    for (var i = 0; i < g.proj.length; i++) {
      var p = g.proj[i];
      if (p.dead || p.sleep) continue;
      var sp = p.vx * p.vx + p.vy * p.vy;
      if (p.shot === 'R' && g.actUsed && sp > 100 && Math.random() < 0.8) spark(p.x - p.vx * 0.02, p.y - p.vy * 0.02, -p.vx * 0.15 + (Math.random() - 0.5) * 2, -p.vy * 0.15 + (Math.random() - 0.5) * 2, 0.35, Math.random() < 0.5 ? 42 : 43, C_FLAME, 0);
      else if (p.shot === 'B' && p.hitT >= 0 && Math.random() < 0.6) spark(p.x, p.y + p.r, (Math.random() - 0.5) * 3, 2 + Math.random() * 2, 0.3, 42, Math.random() < 0.5 ? C_FLAME : C_GOLD, 0);
      else if (sp > 120 && Math.random() < 0.25) spark(p.x, p.y, 0, 0, 0.3, 46, C_FAINT, 0);
    }
  }

  // ---- events → sound, particles, banners ----
  function handleEvents(g) {
    var ev = g.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.k) {
        case 'launch':
          snd.tone(180, 0.22, 'sawtooth', 0.03, 520); snd.noise(0.12, 0.03, 2400);
          Cade.haptic && Cade.haptic(8);
          break;
        case 'hit':
          if (S.hitT <= S.idleT) {
            var hv = Math.min(1, e.J / 6), m = e.a === 'r' || e.a === 'p' ? e.b : e.a;
            if (m === 'i') snd.tone(1400 + Math.random() * 300, 0.06, 'triangle', 0.02 + hv * 0.03);
            else if (m === 's') { snd.tone(110, 0.12, 'sine', 0.04 + hv * 0.05, 70); snd.noise(0.08, 0.02 + hv * 0.03, 700); }
            else { snd.tone(210 + Math.random() * 60, 0.08, 'triangle', 0.03 + hv * 0.04, 150); snd.noise(0.05, 0.015 + hv * 0.02, 1400); }
            S.hitT = S.idleT + 0.045;
          }
          if (e.J > 1.2) burst(e.x, e.y, Math.min(8, 2 + (e.J | 0)), 2.5 + Math.min(4, e.J * 0.5), ".,'", C_FAINT, 9, 0.45, true);
          if (e.J > 5 && e.proj) { S.shake = Math.max(S.shake, Math.min(0.22, e.J * 0.02)); Cade.haptic && Cade.haptic(12); }
          break;
        case 'break':
        case 'lost':
          var bm = e.b.mat, bci = MAT_SLOT[bm];
          burst(e.x, e.y, bm === 'i' ? 14 : 11, bm === 'i' ? 6 : 4.5, bm === 'w' ? "=-,'" : bm === 's' ? "#.:'" : "/\\.*", bci, 9, 0.9);
          if (e.pts) popup(e.x, e.y, '+' + e.pts, C_GOLD);
          if (bm === 'i') { snd.tone(1800, 0.12, 'square', 0.02, 900); snd.noise(0.15, 0.03, 4000); }
          else if (bm === 's') snd.noise(0.28, 0.06, 500);
          else { snd.noise(0.18, 0.05, 1100); snd.tone(160, 0.12, 'triangle', 0.03, 90); }
          break;
        case 'guard':
          burst(e.x, e.y, 16, 6, "@*'.", C_RED, 6, 0.9);
          burst(e.x, e.y, 6, 3, '^', C_GOLD, 8, 1);
          popup(e.x, e.y + 0.3, '+' + fmtInt(GUARD_PTS), C_RED);
          [784, 587, 392].forEach(function (f, j) { snd.tone(f, 0.09, 'square', 0.03, 0, j * 0.06); });
          if (g.guards > 0) say(g.guards === 1 ? 'ONE LEFT' : g.guards + ' LEFT', C_RED, 0.8);
          Cade.haptic && Cade.haptic(16);
          break;
        case 'split':
          burst(e.x, e.y, 8, 4, "*'", C_ACC, 0, 0.4);
          [1046, 1318, 1568].forEach(function (f, j) { snd.tone(f, 0.06, 'triangle', 0.03, 0, j * 0.03); });
          break;
        case 'slam':
          burst(e.x, e.y, 8, 3, '|!', C_STONE, 0, 0.4);
          snd.tone(300, 0.25, 'sawtooth', 0.035, 60);
          break;
        case 'boost':
          burst(e.x, e.y, 10, 5, '*+', C_FLAME, 0, 0.45);
          snd.tone(300, 0.3, 'sawtooth', 0.03, 1400);
          break;
        case 'boom':
          burst(e.x, e.y, 30, 11, '*#@+%.', C_FLAME, 4, 0.9);
          burst(e.x, e.y, 14, 6, '.o', C_GOLD, 2, 0.7);
          S.shake = 0.35; S.flash = 0.1;
          snd.noise(0.6, 0.12, 380); snd.tone(90, 0.5, 'sine', 0.09, 30);
          Cade.haptic && Cade.haptic(30);
          break;
        case 'clear':
          say('CASTLE TAKEN!', C_GOLD, 2);
          [523, 659, 784, 1047].forEach(function (f, j) { snd.tone(f, 0.12, 'triangle', 0.035, 0, j * 0.08); });
          break;
        case 'ready':
          var nx = curShot(g);
          if (nx && nx !== g.shotType) say('NEXT: ' + SHOTS[nx].name.toUpperCase(), SHOT_SLOT[nx], 1.3);
          syncPad();
          break;
        case 'out':
          say('OUT OF SHOTS', C_MUTED, 1.4);
          snd.tone(330, 0.2, 'triangle', 0.03, 165);
          break;
      }
    }
    ev.length = 0;
  }

  // ---- cards ----
  function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '☆'; return s; }
  function shotChip(id, locked) {
    var sh = SHOTS[id];
    return '<div class="ss-shot' + (locked ? ' locked' : '') + '"><b class="ss-s-' + id + '">' + esc(sh.ch) + '</b><span><b>' + esc(sh.name) + '</b> ' +
      (locked ? '<i>from level ' + sh.unlock + '</i>' : esc(sh.info)) + '</span></div>';
  }
  function maxUnlocked() { var n = 0; for (var i = 0; i < LEVELS.length; i++) if (unlocked(S.save, i)) n = i + 1; return n; }
  function homeHtml() {
    var sv = S.save, tot = totalStars(sv), nx = nextLevel(sv), done = 0;
    for (var i = 0; i < LEVELS.length; i++) if (cleared(sv, i)) done++;
    var art = '     |>      |>\n    [##]____[##]\n    |  | @ @|  |\n ___|__|_____|__|___';
    return '<div class="ss-card ss-home">' +
      '<pre class="ss-art" aria-hidden="true">' + esc(art) + '</pre>' +
      '<div class="ss-title">SIEGE SLING</div>' +
      '<div class="ss-sub">Topple the towers. Bonk every guard.</div>' +
      '<div class="ss-stats"><span><b class="ss-gold">★ ' + tot + '</b>/' + (LEVELS.length * 3) + '</span><span><b>' + done + '</b>/' + LEVELS.length + ' castles</span>' +
      (sv.kills ? '<span><b>' + fmtInt(sv.kills) + '</b> guards</span>' : '') + '</div>' +
      '<div class="ss-btns"><button type="button" class="ss-go" data-act="play" data-lv="' + nx + '">' + (done ? 'Continue' : 'Play') + ' · L' + (nx + 1) + '</button>' +
      '<button type="button" class="ss-go alt" data-act="levels">Levels</button></div>' +
      '<div class="ss-note">' + (S.coarse ? 'Drag back on the field to aim, let go to fire' : 'Drag back to aim (or arrows + space)') + '</div></div>';
  }
  function levelsHtml() {
    var sv = S.save, h = '';
    for (var i = 0; i < LEVELS.length; i++) {
      var open = unlocked(sv, i), r = sv.lv[i], st = r ? r.s : 0, cur = S.g && S.g.li === i;
      h += '<button type="button" class="ss-lv' + (open ? '' : ' locked') + (st ? ' done' : '') + (cur ? ' cur' : '') + '" data-act="play" data-lv="' + i + '"' +
        (open ? '' : ' aria-disabled="true"') + ' title="' + esc((i + 1) + '. ' + LEVELS[i].name + (r && r.b ? ' — best ' + fmtInt(r.b) : '')) + '">' +
        '<b>' + pad2(i + 1) + '</b><span>' + (open ? starStr(st) : '· · ·') + '</span></button>';
    }
    return '<div class="ss-card ss-levels"><div class="ss-title">LEVELS</div>' +
      '<div class="ss-sub"><b class="ss-gold">★ ' + totalStars(sv) + '</b> of ' + (LEVELS.length * 3) + ' · three stars for par or better</div>' +
      '<div class="ss-grid">' + h + '</div>' +
      '<div class="ss-btns"><button type="button" class="ss-go alt" data-act="home">Back</button></div></div>';
  }
  function helpHtml() {
    var mu = maxUnlocked(), shots = SHOT_ORDER.map(function (id) { return shotChip(id, SHOTS[id].unlock > mu); }).join('');
    return '<div class="ss-card ss-help"><div class="ss-title">HOW TO PLAY</div>' +
      '<p>Knock out every <b class="ss-red">guard</b> to take the castle. Pull the sling back, let go, and let the stones (and gravity) do the rest. Guards fall to hard knocks and long falls; blocks crack, then break.</p>' +
      '<div class="ss-keys">' +
      '<div><b>Aim</b> drag back anywhere on the field — the dots show the first part of the flight</div>' +
      '<div><b>Fire</b> let go (drag back to the start to cancel)</div>' +
      '<div><b>Special</b> tap the field (or Space) while a special shot flies</div>' +
      (S.coarse ? '' : '<div><b>Keys</b> ←→ angle · ↑↓ power · Space fire · R retry · P pause</div><div><b>Pad</b> left stick aims, A fires / special, B retry, Start pause</div>') +
      '</div>' +
      '<div class="ss-h">Shots</div><div class="ss-shots">' + shots + '</div>' +
      '<div class="ss-h">Blocks</div><p><b class="ss-m-w">wood</b> fair · <b class="ss-m-s">stone</b> tough (bring a Boulder) · <b class="ss-m-i">ice</b> brittle and slippery · <b class="ss-m-r">rock</b> never moves</p>' +
      '<p>Stars: par shots or fewer for three. Every shot left over is worth ' + fmtInt(SHOT_BONUS) + '.</p>' +
      '<div class="ss-btns"><button type="button" class="ss-go" data-act="close-help">Got it</button></div></div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="ss-card ss-pause"><div class="ss-title">PAUSED</div>' +
      '<div class="ss-sub">Level ' + (g.li + 1) + ' · ' + esc(g.L.name) + ' · ' + fmtInt(g.score) + '</div>' +
      '<div class="ss-btns"><button type="button" class="ss-go" data-act="resume">Resume</button><button type="button" class="ss-go alt" data-act="retry">Retry</button><button type="button" class="ss-go alt" data-act="levels">Levels</button></div>' +
      '<div class="ss-note">' + (S.coarse ? 'Tap Resume to carry on' : 'P / Space to resume') + '</div></div>';
  }
  function resultHtml() {
    var g = S.g, r = S.res || {}, won = g.phase === 'won', best = S.save.lv[g.li], last = g.li >= LEVELS.length - 1;
    if (!won) {
      return '<div class="ss-card ss-res"><div class="ss-title">THE CASTLE HOLDS</div>' +
        '<div class="ss-sub">' + g.guards + ' guard' + (g.guards === 1 ? '' : 's') + ' still standing · level ' + (g.li + 1) + '</div>' +
        '<pre class="ss-art ss-dim" aria-hidden="true">  @   @\n [#]_[#]</pre>' +
        '<div class="ss-note">' + esc(failTip(g)) + '</div></div>';
    }
    var nb = r.newBest, ns = r.newStars;
    return '<div class="ss-card ss-res"><div class="ss-title">CASTLE TAKEN</div>' +
      '<div class="ss-stars" aria-label="' + g.stars + ' of 3 stars">' + '<span class="on">' + starStr(g.stars).slice(0, g.stars) + '</span>' + starStr(g.stars).slice(g.stars) + '</div>' +
      '<div class="ss-big">' + fmtInt(g.score) + '</div>' +
      (nb ? '<div class="ss-new">** new best **</div>' : '<div class="ss-sub">best ' + fmtInt(best ? best.b : g.score) + '</div>') +
      '<pre class="ss-tab">' + line('Shots used', g.used + ' (par ' + g.L.par + ')') + '\n' + line('Guards', String(g.kills)) + '\n' + line('Blocks broken', String(g.broke)) +
      (g.bonus ? '\n<span class="g">' + line('Shots left', '+' + fmtInt(g.bonus)) + '</span>' : '') + '</pre>' +
      (ns && g.stars < 3 ? '<div class="ss-note">par is ' + g.L.par + ' — try for three stars</div>' : '') +
      (last ? '<div class="ss-new">all ' + LEVELS.length + ' castles taken!</div>' : '') + '</div>';
  }
  function line(k, v) { var n = Math.max(1, 26 - k.length - v.length); return k + ' ' + new Array(n).join('.') + ' <b>' + esc(v) + '</b>'; }
  function failTip(g) {
    var tips = ['Hit the posts low: towers fall onto their own guards.', 'A guard on the ground needs a falling block or a direct knock.',
      'Lob high for guards behind walls.', 'Watch the dots: the last shot\u2019s path stays on the field while you aim.'];
    if (g.li >= 3) tips.push('Special shots hit hardest when you tap just before impact.');
    if (g.li >= 7) tips.push('Stone shrugs off stones \u2014 save the Boulder for it.');
    if (g.li >= 11) tips.push('A Bomb tapped inside a tower does the most damage.');
    return 'Tip: ' + tips[(g.li * 7 + g.used + g.guards) % tips.length];
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'levels' ? levelsHtml() : kind === 'help' ? helpHtml() : kind === 'pause' ? pauseHtml() : kind === 'result' ? resultHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    if (kind) { S.ovl.scrollTop = 0; }
  }

  // ---- the pad under the field ----
  function setPad(mode) {
    S.padMode = mode;
    var h;
    if (mode === 'play') {
      h = '<button type="button" class="ss-act alt" data-act="levels" aria-label="Levels">☰<small>levels</small></button>' +
        '<button type="button" class="ss-act alt" data-act="retry" aria-label="Retry level">↺<small>retry</small></button>' +
        '<button type="button" class="ss-main" data-k="main"></button>';
    } else if (mode === 'result') {
      var won = S.g && S.g.phase === 'won', last = S.g && S.g.li >= LEVELS.length - 1;
      h = '<button type="button" class="ss-act alt" data-act="levels">☰<small>levels</small></button>' +
        '<button type="button" class="ss-act alt" data-act="retry">↺<small>retry</small></button>' +
        (won && !last ? '<button type="button" class="ss-main go" data-act="next">Next level' + (S.coarse ? '' : ' <small>space</small>') + '</button>' :
          won ? '<button type="button" class="ss-main go" data-act="levels">All levels</button>' : '<button type="button" class="ss-main go" data-act="retry">Try again' + (S.coarse ? '' : ' <small>space</small>') + '</button>');
    } else if (mode === 'resume') h = '<button type="button" class="ss-main go" data-act="resume">Resume' + (S.coarse ? '' : ' <small>space</small>') + '</button>';
    else if (mode === 'menu') {
      var nx = nextLevel(S.save);
      h = '<button type="button" class="ss-main go" data-act="play" data-lv="' + nx + '">Play L' + (nx + 1) + (S.coarse ? '' : ' <small>space</small>') + '</button>';
    } else h = '<button type="button" class="ss-main go" data-act="home">Back</button>';
    S.pad.innerHTML = h;
    syncPad();
  }
  // The big button in play: what the next press would do.
  function syncPad() {
    if (!S || S.padMode !== 'play') return;
    var b = S.pad.querySelector('[data-k="main"]'), g = S.g;
    if (!b || !g) return;
    var lab, cls = '', dis = false;
    if (g.phase === 'aim') {
      var sh = SHOTS[curShot(g)];
      if (S.aim.on && S.aim.kb) { lab = 'Fire ' + sh.name; cls = 'go'; }
      else lab = '<span class="ss-s-' + sh.id + '">' + esc(sh.ch) + '</span> ' + esc(sh.name) + '<small>' + (S.coarse ? 'drag field to aim' : 'drag to aim') + '</small>';
    } else if (g.phase === 'fly' && g.act && !g.actUsed) {
      var lp = liveProj(g), ok = lp && (g.act === 'boom' || lp.hitT < 0);
      lab = ACT_LABEL[g.act]; cls = ok ? 'go hot' : ''; dis = !ok;
    } else { lab = g.phase === 'clear' ? 'Taken!' : '…'; dis = true; }
    var key = lab + cls + dis;
    if (b._k === key) return;
    b._k = key;
    b.innerHTML = lab; b.className = 'ss-main ' + cls; b.disabled = dis;
  }
  function syncPadLive() { if (S.padMode === 'play') syncPad(); }
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

  // ---- flow ----
  function toHome(kind) {
    stopLoop();
    S.phase = 'menu'; S.paused = false; S.drag = null; S.aim.on = false;
    if (!S.g) { S.g = newGame(nextLevel(S.save)); fitCam(); }
    clearFx();
    showCard(kind || 'home'); setPad(kind === 'levels' ? 'back' : 'menu'); syncHead();
    draw(1, 0);
  }
  function startLevel(li) {
    if (!S) return;
    li = clamp(li | 0, 0, LEVELS.length - 1);
    if (!unlocked(S.save, li)) { Cade.showToast && Cade.showToast('Clear level ' + li + ' first', 'info', 1500); return; }
    S.snd.ensure();
    stopLoop();
    S.g = newGame(li); fitCam();
    S.phase = 'play'; S.paused = false; S.endT = 0; S.res = null; S.drag = null;
    S.aim = { a: 0.55, p: 0.8, on: false, kb: false };
    S.save.last = li; persist();
    clearFx(); showCard(null); setPad('play'); syncHead();
    var L = S.g.L;
    say('LEVEL ' + (li + 1) + ': ' + L.name.toUpperCase(), C_TEXT, 1.6);
    if (L.tip) say(L.tip.toUpperCase().replace(/\.$/, ''), C_ACC, 2.6, true);
    else { var sh = SHOTS[S.g.queue[0]]; if (sh.unlock === li + 1) say('NEW: ' + sh.name.toUpperCase(), SHOT_SLOT[sh.id], 1.6, true); }
    if (S.liveEl) S.liveEl.textContent = 'Level ' + (li + 1) + ', ' + L.name + '. ' + S.g.guards + ' guards, ' + S.g.queue.length + ' shots.';
    kick();
    draw(0, 0);
  }
  function finish() {
    stopLoop();
    var g = S.g;
    S.res = record(S.save, g);
    persist();
    S.phase = 'result'; S.drag = null;
    showCard('result'); setPad('result'); syncHead();
    if (g.phase === 'won') {
      [659, 784, 988, 1319].forEach(function (f, j) { S.snd.tone(f, 0.13, 'triangle', 0.035, 0, 0.05 + j * 0.09); });
      if (S.liveEl) S.liveEl.textContent = 'Castle taken: ' + g.stars + ' stars, ' + fmtInt(g.score) + ' points.';
    } else {
      [392, 330, 262].forEach(function (f, j) { S.snd.tone(f, 0.18, 'triangle', 0.035, 0, j * 0.12); });
      if (S.liveEl) S.liveEl.textContent = 'Out of shots. ' + g.guards + ' guards left.';
    }
    draw(1, 0);
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.drag = null;
    stopLoop();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad('play'); syncHead();
    kick();
  }
  function act(a, lv) {
    if (!S) return;
    S.snd.ensure();
    if (a === 'play') startLevel(lv == null ? nextLevel(S.save) : +lv);
    else if (a === 'next') startLevel(S.g ? S.g.li + 1 : 0);
    else if (a === 'retry') startLevel(S.g ? S.g.li : 0);
    else if (a === 'levels') toHome('levels');
    else if (a === 'home') toHome('home');
    else if (a === 'resume') resume();
    else if (a === 'close-help') { if (S.paused) showCard('pause'); else toHome('home'); }
  }
  // the play pad's big button / Space: fire a keyboard aim, or the special
  function mainPress() {
    var g = S.g;
    if (!g || S.phase !== 'play' || S.paused) return;
    if (g.phase === 'aim') {
      if (!S.aim.on) { S.aim.on = true; S.aim.kb = true; syncPad(); return; }
      fire();
    } else if (g.phase === 'fly') { if (ability(g)) syncPad(); }
  }
  function fire() {
    var g = S.g;
    if (!g || g.phase !== 'aim') return;
    if (launch(g, S.aim.a, S.aim.p)) { S.aim.on = false; S.aim.kb = false; S.drag = null; syncPad(); }
  }

  // ---- input ----
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', p: 'KeyP', r: 'KeyR', enter: 'Enter', escape: 'Escape', l: 'KeyL' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  var AIM_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  function keyAim(dt) {
    var k = S.keys, g = S.g;
    if (!g || g.phase !== 'aim' || S.drag) return;
    var da = (k.ArrowLeft ? 1 : 0) - (k.ArrowRight ? 1 : 0), dp = (k.ArrowUp ? 1 : 0) - (k.ArrowDown ? 1 : 0);
    if (!da && !dp) { S.kHeld = 0; return; }
    S.kHeld += dt;
    var sp = S.kHeld > 0.5 ? 2.5 : 1;
    if (!S.aim.on) { S.aim.on = true; S.aim.kb = true; syncPad(); }
    S.aim.a = clamp(S.aim.a + da * dt * 0.55 * sp, -0.5, 1.45);
    S.aim.p = clamp(S.aim.p + dp * dt * 0.35 * sp, 0.15, 1);
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = keyCode(e);
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'play' && S.drag) { S.drag = null; S.aim.on = false; return; }
      if (S.phase === 'play' && !S.paused) pause();
      else if (S.phase === 'play' && S.cardKind === 'help') showCard('pause');
      else if (S.phase !== 'play' && (S.cardKind === 'levels' || S.cardKind === 'help')) toHome('home');
      else closePanel();
      return;
    }
    if (S.phase === 'play') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return; e.preventDefault(); if (!e.repeat) resume(); }
        return;
      }
      if (code === 'KeyR') { e.preventDefault(); if (!e.repeat) startLevel(S.g.li); return; }
      if (code === 'KeyL') { e.preventDefault(); if (!e.repeat) toHome('levels'); return; }
      if (AIM_KEYS[code]) { e.preventDefault(); S.keys[code] = true; return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t) && !t.hasAttribute('data-k')) return;
        e.preventDefault();
        if (!e.repeat) mainPress();
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (e.repeat) return;
      var b = S.pad.querySelector('.ss-main');
      if (b && !b.disabled) b.click();
    }
  }
  function onKeyUp(e) { if (S) { var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; } }
  function clearInput() { S.keys = {}; S.drag = null; S.kHeld = 0; }

  // Gamepad: the left stick pulls the sling (the shot flies the other way), A fires /
  // the special, B retries, Start pauses; in menus A presses the big button.
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad(dt) {
    var gp = S.gp, p = readPad();
    if (!p) return;
    var g = S.g, ax = p.axes[0] || 0, ay = p.axes[1] || 0, m = Math.sqrt(ax * ax + ay * ay);
    if (g && g.phase === 'aim' && !S.drag) {
      if (m > 0.25) {
        S.aim.on = true; S.aim.kb = true;
        S.aim.a = clamp(Math.atan2(ay, -ax), -0.5, 1.45); S.aim.p = clamp((m - 0.2) / 0.75, 0.15, 1);
      }
      var dp = (btnOn(p, 12) ? 1 : 0) - (btnOn(p, 13) ? 1 : 0), da = (btnOn(p, 14) ? 1 : 0) - (btnOn(p, 15) ? 1 : 0);
      if (dp || da) { S.aim.on = true; S.aim.kb = true; S.aim.a = clamp(S.aim.a + da * dt * 0.5, -0.5, 1.45); S.aim.p = clamp(S.aim.p + dp * dt * 0.3, 0.15, 1); }
    }
    var a = btnOn(p, 0), b = btnOn(p, 1), st = btnOn(p, 9);
    if (a && !gp.a) mainPress();
    if (b && !gp.b && g) startLevel(g.li);
    if (st && !gp.st) pause();
    gp.a = a; gp.b = b; gp.st = st;
  }
  function pollMenus() {
    if (!S || running()) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { var bt = S.pad.querySelector('.ss-main'); if (bt && !bt.disabled) bt.click(); }
    S.gp.menuA = a;
  }

  // Pointer: drag back anywhere to aim; in flight a tap fires the special.
  function logical(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * VW / (r.width || 1), y: (e.clientY - r.top) * S.VH / (r.height || 1) };
  }
  function onDown(e) {
    if (!S || e.button > 0) return;
    e.preventDefault();
    S.snd.ensure();
    if (S.phase !== 'play' || S.paused) return;
    var g = S.g;
    if (g.phase === 'fly') { if (ability(g)) syncPad(); return; }
    if (g.phase !== 'aim' || S.drag) return;
    try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
    var p = logical(e);
    S.drag = { id: e.pointerId, x0: p.x, y0: p.y };
    S.aim.on = false; S.aim.kb = false;
  }
  function onMove(e) {
    if (!S || !S.drag || e.pointerId !== S.drag.id) return;
    e.preventDefault();
    var p = logical(e), dx = p.x - S.drag.x0, dy = p.y - S.drag.y0, d = Math.sqrt(dx * dx + dy * dy);
    var pw = clamp(d / DRAG_PX, 0, 1);
    if (d < 4) { S.aim.on = false; return; }
    var a = Math.atan2(dy, -dx);
    if (dx > 0 && pw > 0.1) a = clamp(a, -0.5, 1.45);   // pulled forwards: point it anyway, but sensibly
    S.aim.a = clamp(a, -0.5, 1.45); S.aim.p = pw; S.aim.on = pw >= 0.1;
    if (S.aim.on && !S.drag.tick && pw > 0.5) { S.drag.tick = true; S.snd.tone(520, 0.03, 'triangle', 0.015); }
  }
  function onUp(e) {
    if (!S || !S.drag || e.pointerId !== S.drag.id) return;
    var ok = S.aim.on && S.aim.p >= 0.12 && e.type === 'pointerup';
    S.drag = null;
    if (ok) fire(); else { S.aim.on = false; }
  }

  // ---- layout ----
  // The height left for the play field. The chrome (header, pad, padding, gap) is
  // summed from its parts, not taken as "panel minus stage": the core caps the
  // panel's max-height, so a stage that is already too tall would hide the overflow
  // and never shrink back.
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head'), body = S.panel.querySelector('.cade-panel-body');
    var pad = 20;
    if (body) { var bs = getComputedStyle(body); pad = (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0); }
    var chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + 8 + pad + 4;
    var solo = S.panel.classList.contains('cade-solo-panel');
    var top = solo ? 0 : r.height ? Math.min(Math.max(0, r.top), 140) : 50;
    var lim = vh - top - (solo ? 26 : 10);
    var mh = parseFloat(getComputedStyle(S.panel).maxHeight);
    if (!solo && mh > 0) lim = Math.min(lim, mh);
    return lim - chrome;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.6 : 1.5), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s), minH = 236;
    if (vh2 < minH) { s = Math.max(0.55, Math.min(s, ah / minH)); vh2 = minH; }
    vh2 = Math.min(vh2, phone ? 340 : solo ? 280 : 270);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--ss-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    fitCam();
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (running() && S.raf) return; draw(1, 0); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPad);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    if (s.cloudT) s.cloudT.forEach(function (t) { freeCanvas(t.cv); });
    if (s.texList) s.texList.forEach(freeCanvas);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="ss"><div class="ss-stage"><canvas class="ss-cv"></canvas><div class="ss-ovl" style="display:none"></div></div>' +
      '<div class="ss-pad"></div><div class="ss-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🏰 Siege Sling', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ss-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.ss-stage'), cv: p.querySelector('.ss-cv'), ovl: p.querySelector('.ss-ovl'),
      pad: p.querySelector('.ss-pad'), liveEl: p.querySelector('.ss-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', g: null, paused: false, raf: 0, last: 0, endT: 0, idleT: 0, hitT: 0, res: null,
      keys: {}, kHeld: 0, gp: { a: false, b: false, st: false, menuA: false }, gpT: 0, drag: null,
      aim: { a: 0.55, p: 0.8, on: false, kb: false },
      pal: new Array(NPAL), col: null, atl: null, cloudT: null, tex: {}, texList: [], texN: 0, k: 1, VH: 280, cam: { z: 18, bottom: -1, left: -3 },
      shake: 0, flash: 0, msg: null, msgQ: [], padMode: '', cardKind: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.g = newGame(nextLevel(S.save));
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearInput(); } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); clearInput(); stopLoop();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); redraw();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    S.onPad = function () { if (S && !S.gpT) S.gpT = setInterval(pollMenus, 100); };
    window.addEventListener('gamepadconnected', S.onPad);
    if (readPad()) S.onPad();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound / pause
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
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'play' && !S.paused) pause();
        if (S.cardKind === 'help') act('close-help');
        else { showCard('help'); if (S.phase !== 'play') setPad('back'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout: CSS does most
    // of it; the play surfaces cancel their touches and the panel swallows gestures.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (b && e.cancelable) { e.preventDefault(); if (!b.disabled) b.click(); }
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, onUp); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      if (b.getAttribute('data-k') === 'main') { S.snd.ensure(); mainPress(); return; }
      act(b.getAttribute('data-act'), b.getAttribute('data-lv'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      if (b.classList.contains('locked')) { Cade.showToast && Cade.showToast('Clear level ' + (+b.getAttribute('data-lv')) + ' to open this one', 'info', 1500); return; }
      act(b.getAttribute('data-act'), b.getAttribute('data-lv'));
    });

    if (S.firstRun) { persist(); toHome('home'); showCard('help'); setPad('menu'); }
    else toHome('home');
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Fling stones at wobbly towers and topple the castle guards — physics puzzles',
    icon: '🏰',
    tags: 'game,arcade,fun,slingshot,physics,towers,launch,puzzle,siege,catapult,castle,levels,stars,ascii',
    open: open,
    _engine: ENGINE
  });
})();
