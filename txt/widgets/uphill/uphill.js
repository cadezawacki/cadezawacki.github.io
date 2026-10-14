/* Uphill Rush — an ASCII dirt-bike game for Cade.txt.
 * Ride a glyph-drawn trail bike over hills, kickers, gaps, logs and rocks:
 * gas, brake and lean to keep the rider's head off the dirt. Twelve handcrafted
 * stages (timer, stars by time, ghost of your best run, checkpoints) and an
 * Endless mode on seeded procedural terrain with fuel cans and coins; flips
 * earn time bonuses / coins, coins buy bike upgrades.
 *
 * Physics: a rigid chassis on two sprung wheels (prismatic spring-damper
 * joints solved with sequential impulses), wheel–terrain contacts against the
 * terrain polyline with rolling friction, motor torque on the rear wheel (with
 * its reaction on the frame), brakes, and rider lean as a torque on the frame.
 * It runs on a fixed 240 Hz step with an accumulator, so a run plays the same
 * at 60 or 120 Hz; rendering interpolates between steps. Drawn entirely with
 * monospace glyphs on a canvas in the app's theme colours; no assets.
 *
 * Nothing runs until the panel opens; the animation loop only runs while a
 * ride is live and visible (paused on blur / hidden tab / minimize, never
 * auto-resumed); everything is torn down on close. The pure engine below is
 * exported for node (uphill.test.js). */
(function () {
  'use strict';

  // =====================================================================
  // ENGINE — pure: no DOM, no Cade. Units: metres, seconds, radians.
  // x → right, y → up. Angles counter-clockwise (nose-up is positive).
  // =====================================================================
  var E = (function () {
    var STEP = 1 / 240, ITER = 8, G = 14, TAU = Math.PI * 2;

    // ---- bike ----
    var WR = 0.38;                                     // wheel radius
    var MC = 1, IC = 0.30, MW = 0.12, IW = MW * WR * WR * 0.75;
    var iMC = 1 / MC, iIC = 1 / IC, iMW = 1 / MW, iIW = 1 / IW;
    var MT = 1 / (iMW + WR * WR * iIW);                // rolling-contact effective mass (tangent)
    var IEFF = 1 / (iIW + iIC);                        // wheel ↔ frame relative spin (brakes, drag)
    // Suspension, in chassis-local coordinates (origin = centre of mass, x = forward).
    // Each wheel slides on an axis from its anchor (rear: shock, front: fork) and is
    // pushed out by a preloaded spring-damper; travel is limited by hard stops.
    var SUS_AX = [-0.70, 0.50], SUS_AY = [0.12, 0.50];
    var SUS_DX = [0, 0.3746], SUS_DY = [-1, -0.9272];
    var SUS_REST = [0.58, 1.02], SUS_STAT = [0.47, 0.90], SUS_MIN = [0.24, 0.66], SUS_MAX = [0.55, 0.99];
    // Frame collision points [x, y, radius]: belly (engine), tail, nose.
    var BODY = [0.05, -0.10, 0.13, -0.86, 0.36, 0.10, 0.66, 0.46, 0.10];
    var BODY_MU = 0.55;
    var HEAD_R = 0.16;
    var LEAN_G = 6.2, LEAN_A = 5.0, LEAN_WMAX = 8.5, AIR_DAMP = 0.2, BRAKE_T = [3.2, 4.4], ROLL_T = 0.02;
    var SLOP = 0.004, POS_BETA = 0.45, JBETA = 0.12;
    var CRASH_T = 1.35, FINISH_T = 1.4, FLIP_CONFIRM = 0.22;

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function wrapPi(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

    // Seeded PRNG (mulberry32); its state lives in a plain object so worlds clone.
    function rnd(g) {
      g.s = (g.s + 0x6D2B79F5) | 0;
      var t = Math.imul(g.s ^ (g.s >>> 15), 1 | g.s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // ---- upgrades → bike parameters (levels 0..4 each) ----
    var UPGRADES = [
      { key: 'engine', name: 'Engine', what: 'more torque, higher top speed' },
      { key: 'susp', name: 'Suspension', what: 'more travel, softer landings' },
      { key: 'tyres', name: 'Tyres', what: 'more grip on climbs and launches' },
      { key: 'tank', name: 'Fuel tank', what: 'endless: each can lasts longer' }
    ];
    var UP_MAX = 4, UP_COST = [40, 90, 180, 320];
    function upLevel(up, k) { var v = (up && up[k]) | 0; return v < 0 ? 0 : v > UP_MAX ? UP_MAX : v; }
    function bikeParams(up) {
      var e = upLevel(up, 'engine'), s = upLevel(up, 'susp'), t = upLevel(up, 'tyres'), f = upLevel(up, 'tank');
      return {
        torque: 3.7 * (1 + 0.09 * e), omax: 62 * (1 + 0.05 * e),
        k: [70 * (1 + 0.05 * s), 60 * (1 + 0.05 * s)], c: [4.6 * (1 + 0.1 * s), 4.0 * (1 + 0.1 * s)],
        smin: [SUS_MIN[0] - 0.025 * s, SUS_MIN[1] - 0.025 * s],
        mu: 1.15 + 0.07 * t, tank: 38 * (1 + 0.2 * f)
      };
    }

    // ---- rider pose (chassis-local), lean l ∈ [-1, 1] (+ = forward) ----
    // joints: 0 head, 1 shoulder, 2 hip, 3 hand, 4 knee, 5 foot
    var RAG_N = 6;
    // Key poses (x,y per joint): neutral attack position, leaning back, leaning forward.
    var POSE_N = [0.20, 1.32, 0.08, 1.06, -0.22, 0.62, 0.40, 0.84, 0.18, 0.42, -0.04, 0.06];
    var POSE_B = [-0.30, 1.22, -0.30, 0.95, -0.42, 0.56, 0.40, 0.84, 0.10, 0.40, -0.04, 0.06];
    var POSE_F = [0.52, 1.18, 0.34, 0.98, -0.02, 0.70, 0.40, 0.84, 0.24, 0.46, -0.04, 0.06];
    function riderPose(l, out) {
      var K = l < 0 ? POSE_B : POSE_F, t = l < 0 ? -l : l;
      if (t > 1) t = 1;
      for (var i = 0; i < 12; i++) out[i] = POSE_N[i] + (K[i] - POSE_N[i]) * t;
      return out;
    }
    var RAG_PAIRS = [0, 1, 1, 2, 1, 3, 2, 4, 4, 5, 0, 2, 3, 2];

    // =================== terrain ===================
    // A height-field polyline: xs strictly increasing, everything below is dirt.
    function newTerrain(cap) { return { n: 0, cap: cap, xs: new Float64Array(cap), ys: new Float64Array(cap), hint: 0 }; }
    // i with xs[i] <= x < xs[i+1], clamped to [0, n-2]. Walks from the last
    // answer (queries are local), bisects for far jumps.
    function segAt(T, x) {
      var xs = T.xs, n = T.n, i = T.hint;
      if (n < 2) return 0;
      if (i > n - 2) i = n - 2;
      if (i < 0) i = 0;
      if (x < xs[i] - 30 || (i < n - 1 && x > xs[i + 1] + 30)) {
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
        i = lo;
      } else {
        while (i < n - 2 && xs[i + 1] <= x) i++;
        while (i > 0 && xs[i] > x) i--;
      }
      T.hint = i;
      return i;
    }
    function heightAt(T, x) {
      var i = segAt(T, x), x0 = T.xs[i], x1 = T.xs[i + 1];
      var t = (x - x0) / (x1 - x0);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return T.ys[i] + (T.ys[i + 1] - T.ys[i]) * t;
    }
    function slopeAt(T, x, half) {
      var h = half || 0.6;
      return Math.atan2(heightAt(T, x + h) - heightAt(T, x - h), 2 * h);
    }
    // Signed clearance between a point and the ground (negative = under it).
    function groundDist(T, px, py, r) {
      var h = heightAt(T, px);
      if (py <= h) return py - h;
      var best = py - h, i0 = segAt(T, px - r - 0.6), i1 = segAt(T, px + r + 0.6), xs = T.xs, ys = T.ys;
      for (var j = i0; j <= i1 && j < T.n - 1; j++) {
        var x0 = xs[j], y0 = ys[j], ex = xs[j + 1] - x0, ey = ys[j + 1] - y0;
        var t = ((px - x0) * ex + (py - y0) * ey) / (ex * ex + ey * ey);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var dx = px - x0 - ex * t, dy = py - y0 - ey * t, d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      return best;
    }

    // ---- contacts (preallocated pool; no allocation in the step) ----
    var MAXC = 40;
    var CK = new Int8Array(MAXC), CNX = new Float64Array(MAXC), CNY = new Float64Array(MAXC), CPEN = new Float64Array(MAXC);
    var CRX = new Float64Array(MAXC), CRY = new Float64Array(MAXC), CJN = new Float64Array(MAXC), CJT = new Float64Array(MAXC);
    var CMN = new Float64Array(MAXC), CMT = new Float64Array(MAXC);
    var nC = 0;
    function addC(kind, nx, ny, pen, rx, ry) {
      if (nC >= MAXC) return;
      CK[nC] = kind; CNX[nC] = nx; CNY[nC] = ny; CPEN[nC] = pen; CRX[nC] = rx; CRY[nC] = ry;
      CJN[nC] = 0; CJT[nC] = 0;
      nC++;
    }
    // Circle (cx, cy, r) against the polyline: segment interiors, plus crest
    // vertices (valleys are covered by their two segments).
    function collide(T, cx, cy, r, kind, ox, oy) {
      var xs = T.xs, ys = T.ys, n = T.n, i0 = segAt(T, cx - r - 0.02), i1 = segAt(T, cx + r + 0.02), j;
      var h = heightAt(T, cx), under = cy < h;
      for (j = i0; j <= i1 && j < n - 1; j++) {
        var x0 = xs[j], y0 = ys[j], ex = xs[j + 1] - x0, ey = ys[j + 1] - y0, L2 = ex * ex + ey * ey;
        var t = ((cx - x0) * ex + (cy - y0) * ey) / L2;
        if (t <= 0 || t >= 1) continue;
        var L = Math.sqrt(L2), nx = -ey / L, ny = ex / L, sd = (cx - x0) * nx + (cy - y0) * ny;
        if (sd < r && sd > -3 * r) addC(kind, nx, ny, r - sd, ox, oy);
      }
      for (j = i0 + 1; j <= i1; j++) {
        if (j <= 0 || j >= n - 1) continue;
        var ax = xs[j] - xs[j - 1], ay = ys[j] - ys[j - 1], bx = xs[j + 1] - xs[j], by = ys[j + 1] - ys[j];
        if (ax * by - ay * bx > -1e-9) continue;                 // not a crest
        var dx = cx - xs[j], dy = cy - ys[j], d2 = dx * dx + dy * dy;
        if (d2 >= r * r || d2 < 1e-12) continue;
        if (dx * ax + dy * ay <= 0 || dx * bx + dy * by >= 0) continue;   // not in the vertex's outer wedge
        var d = Math.sqrt(d2);
        addC(kind, dx / d, dy / d, r - d, ox, oy);
      }
      // Tunnelled below the surface (shouldn't happen at 240 Hz): pop straight up.
      if (under && h - cy > r * 0.5) addC(kind, 0, 1, h - cy + r, ox, oy);
    }

    // =================== stage / terrain builder ===================
    // Stages are written in a tiny DSL: tokens like "h30,2" (letter + comma args);
    // the grammar is listed above STAGES.
    function bAdd(w, x, y) {
      var T = w.ter, n = T.n;
      if (n && x <= T.xs[n - 1] + 0.01) { T.ys[n - 1] = y; w.by = y; return; }
      if (n >= T.cap) return;
      T.xs[n] = x; T.ys[n] = y; T.n = n + 1;
      w.bx = x; w.by = y;
    }
    // Sampled shape from the cursor: f(t) ∈ [0,1] scaled by dy over L.
    function bCurve(w, L, dy, shape) {
      var x0 = w.bx, y0 = w.by, step = shape === 4 ? 0.07 : 0.32, n = Math.max(1, Math.ceil(L / step)), f = 0;
      if (shape === 0) n = 1;
      for (var j = 1; j <= n; j++) {
        var t = j / n;
        switch (shape) {
          case 0: f = t; break;                                       // straight
          case 1: f = (1 - Math.cos(Math.PI * t)) / 2; break;         // eased S-slope
          case 2: f = (1 - Math.cos(TAU * t)) / 2; break;             // hill (back to y0)
          case 3: f = t * t; break;                                   // concave: kicker, steepest at the lip
          case 4: f = Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1))); break;   // half disc (log)
          case 5: f = 1 - (1 - t) * (1 - t); break;                   // convex: eases out
        }
        bAdd(w, x0 + L * t, y0 + dy * f);
      }
      w.by = y0 + dy * f;
    }
    // Straight slope with rounded ends (gradient matched at the joins).
    function bLine(w, L, dy) {
      var e = Math.min(3, L / 4), m = dy / (L - e);
      bCurve(w, e, m * e / 2, 3);
      bCurve(w, L - 2 * e, m * (L - 2 * e), 0);
      bCurve(w, e, m * e / 2, 5);
    }
    function bDeco(w, k, x, y, a, b) { w.decos.push({ k: k, x: x, y: y, a: a || 0, b: b || 0 }); }

    function feature(w, op, a) {
      var x0 = w.bx, y0 = w.by, i;
      switch (op) {
        case 'f': bCurve(w, a[0], 0, 0); break;
        case 's': bCurve(w, a[0], a[1], 1); break;
        case 'l': bLine(w, a[0], a[1]); break;
        case 'h': bCurve(w, a[0], a[1], 2); w.by = y0; break;
        case 'k': bCurve(w, a[0], a[1], 3); break;
        case 'e': bCurve(w, a[0], a[1], 5); break;
        case 'g': {                                                   // gap W wide; far rim at +dy
          var W = a[0], y1 = y0 + (a[1] || 0), fl = Math.min(y0, y1) - 16;
          bAdd(w, x0 + 0.12, fl); bAdd(w, x0 + W - 0.12, fl); bAdd(w, x0 + W, y1);
          w.gaps.push({ x0: x0, x1: x0 + W, y: Math.min(y0, y1) });
          bDeco(w, 'gap', x0, y0, x0 + W, y1);
          break;
        }
        case 'd': bAdd(w, x0 + 0.14, y0 + a[0]); break;              // sheer step (drop < 0, ledge > 0)
        case 'w': for (i = 0; i < a[0]; i++) bCurve(w, a[1], a[2], 2); w.by = y0; break;
        case 'o': {                                                   // log, radius R
          var R = a[0];
          bCurve(w, 2 * R, R * 0.92, 4); w.by = y0; bAdd(w, x0 + 2 * R + 0.05, y0);
          bDeco(w, 'log', x0 + R, y0 + R * 0.46, R);
          break;
        }
        case 'r': {                                                   // rock, W wide, H tall
          var Wr = a[0], H = a[1];
          bAdd(w, x0 + Wr * 0.18, y0 + H * 0.55); bAdd(w, x0 + Wr * 0.42, y0 + H); bAdd(w, x0 + Wr * 0.68, y0 + H * 0.82);
          bAdd(w, x0 + Wr, y0);
          bDeco(w, 'rock', x0, y0, Wr, H);
          break;
        }
        case 'u':                                                     // n stairs of rise H, tread L
          for (i = 0; i < a[0]; i++) { bAdd(w, w.bx + 0.3, w.by + a[1]); bCurve(w, a[2], 0, 0); }
          break;
        case 'c': w.cps.push(x0); bDeco(w, 'cp', x0, y0); break;
        case 'n': bDeco(w, 'sign', x0, y0, a[0] | 0); break;          // warning sign (0 !, 1 ↗ jump, 2 ↘ drop)
      }
    }
    function parseSrc(src) {
      var out = [], re = /([a-z])([-\d.,]*)/g, m;
      while ((m = re.exec(src))) out.push(m[1], m[2] ? m[2].split(',').map(Number) : []);
      return out;
    }

    // Twelve stages, rising difficulty. Times are [3-star, 2-star] seconds
    // (finishing earns the first star). Grammar:
    //   f L flat · s L,dy eased slope · l L,dy straight slope · h L,H hill (H<0 dip)
    //   k L,H kicker (concave, ends at the lip) · e L,dy convex roll-off (landings)
    //   g W,dy gap (far rim dy higher) · d dy sheer drop/ledge · w n,L,H whoops
    //   o R log · r W,H rock · u n,H,L stairs · c checkpoint · n k sign
    var STAGES = [
      { name: 'First Gear', par: [24.5, 30],
        src: 'f14 h26,1.5 f8 h32,2.6 f10 s22,3 f12 k5,0.9 f8 s26,-3 f14 w3,3.2,0.35 f14 c h28,2.2 f8 l22,4 f12 h22,1.6 f10 k5,1 f10 s22,-4 f16 h30,2 f10 w3,3,0.35 f16' },
      { name: 'Rolling Hills', par: [29.5, 36],
        src: 'f12 h30,3 f6 h26,-2 f8 l24,6 f6 h20,2 f8 s20,-6 f12 c k6,1.6 f8 e10,-1.6 f10 h34,4 f6 h18,-1.5 f8 l22,5 f4 n2 f4 d-1.4 e10,-1 f10 c s24,-2.6 f10 h36,4.5 f8 k6,1.4 f6 e10,-1.4 f10 h24,-2 f16' },
      { name: 'Timber Trail', par: [30.5, 37],
        src: 'f16 o0.3 f8 o0.35 f10 h20,1.5 f6 r1.2,0.45 f8 o0.3 f4 o0.3 f12 w4,2.8,0.45 f10 c l20,4 f6 o0.4 f8 r1.4,0.55 f10 s20,-4 f10 o0.35 f5 r1,0.4 f5 o0.35 f12 c h26,2.5 f8 w5,2.8,0.5 f8 o0.4 f3 o0.4 f10 r1.6,0.6 f6 l16,3 f6 o0.45 f8 s18,-3 f16' },
      { name: 'Mind the Gap', par: [24, 29.5],
        src: 'f30 n1 f10 k5,1.2 g4,-1.2 e8,-0.4 f16 h24,2 f14 n1 f8 k6,1.5 g5,-1.1 e8,-0.6 f20 c s16,2 f8 n1 f8 k6,1.4 g6,-1.4 e10,-0.8 f18 h20,1.6 f12 k5,1.2 g5,-1 e8,-0.6 f16 c n1 f10 k6,1.5 g4,0 f10 k6,1.6 g7,-1.6 e10,-0.6 f20' },
      { name: 'Staircase', par: [24, 29.5],
        src: 'f12 u4,0.22,2.4 f10 n2 f6 d-1.4 e8,-0.8 f14 u5,0.26,2.2 f6 h18,1.2 f10 c n2 f6 d-2 e10,-1 f10 u3,-0.36,2.2 f10 u6,0.28,2 f8 s18,-2.2 f8 o0.35 f10 c u3,0.3,2.4 f6 n2 f6 d-2.4 e10,-1.2 f16 u5,-0.32,2 f8 u4,0.3,2.2 f6 h16,1.4 f16' },
      { name: 'Whoop-de-doo', par: [31.5, 39],
        src: 'f24 w5,3,0.5 f12 h20,2 f8 w6,2.6,0.55 f10 c k7,2 f6 e14,-2 f12 w8,2.8,0.6 f12 s16,2 f8 w5,3.2,0.7 f10 s16,-2 f10 c k6,1.8 f4 e12,-1.8 f12 w6,2.6,0.6 f10 h22,2.4 f8 w7,3,0.7 f20' },
      { name: 'Quarry', par: [31, 38],
        src: 'f20 r1.4,0.5 f6 l18,6 f4 r1.2,0.5 f6 n2 f4 d-2.2 e10,-1.4 f8 r1.6,0.6 f4 r1,0.4 f10 c l16,6.5 f6 h14,-1.5 f6 l14,4 f4 n2 f4 d-3 e12,-2 f10 r1.4,0.6 f6 o0.4 f8 c l20,7 f6 r1.2,0.5 f8 s20,-6 f10 r1.6,0.6 f10 l14,5 f4 r1.2,0.55 f4 n2 f4 d-3.2 e12,-2 f16' },
      { name: 'Big Air', par: [29.5, 36],
        src: 'f40 n1 f6 k8,2.6 g9,-2.6 e14,-2 f20 h22,2 f10 c n1 f20 k8,3 f1 e18,-3.6 f16 l18,4 f10 n1 f10 k9,3 g12,-3.6 e16,-2.4 f24 c h24,2 f10 n1 f16 k8,2.8 g10,-1 e14,-3 f12 k7,2.4 f1 e16,-2.4 f20' },
      { name: 'Canyon Run', par: [28.5, 35],
        src: 'f34 n1 f6 k6,1.6 g5,-1.2 e6,-0.4 f8 k5,1.4 g5,-1.2 e6,-0.4 f8 k5,1.4 g6,-1 e8,-0.6 f16 c h20,2 f10 n1 f10 k6,1.8 g6,0 f10 k5,1.2 g5,-1.6 e8,-0.6 f12 c n1 f16 k7,2.2 g8,-2.4 e10,-1 f6 k5,1.2 g5,-1.2 e8,-0.6 f16 c n1 f12 k6,1.6 g6,-0.6 e6,-0.4 f4 k6,1.6 g7,-1.2 e8,-0.8 f6 k5,1.2 g5,-1 e8,-0.6 f20' },
      { name: 'Sawtooth', par: [28.5, 35],
        src: 'f22 l9,3 d-3 f8 l9,3.2 d-3.2 f6 l8,3 d-3 f10 h16,2 f10 c l10,3.6 d-1.8 l8,2 d-2.4 f6 l9,3 f2 d-3.2 f12 s16,3 f6 c l8,2.8 d-2.6 f5 l8,2.8 d-2.8 f5 l10,3.4 d-3.4 f12 s16,-3 f10 c l7,2.6 d-2.6 f4 l7,2.6 d-2.6 f4 l7,2.8 d-2.8 f4 l9,3.4 d-3.4 f20' },
      { name: 'Cliffhanger', par: [33.5, 41],
        src: 'f24 l26,8 f6 n2 f6 d-3.4 e14,-3 f10 l22,7 f4 n1 f6 k5,1.4 g6,1 f8 c l18,5 f6 n2 f4 d-4 e16,-3.4 f10 o0.4 f8 l24,8 f6 n2 f6 d-3.6 e14,-4 f12 c l16,4 f4 k5,1.2 g5,0.6 f6 n2 f6 d-3 e14,-3.6 f12 c l28,10 f4 n2 f6 d-4.5 e18,-4 f10 l14,4 f4 n1 f4 k6,1.6 g7,0.4 f6 n2 f6 d-3.4 e14,-3 f20' },
      { name: 'Summit', par: [51.5, 63.5],
        src: 'f20 l24,6 f6 r1.4,0.6 f6 o0.4 f6 l18,5 f8 w5,2.8,0.6 f8 n1 f6 k6,1.6 g6,0 f8 c l20,6 f4 u4,0.34,2 f8 n2 f6 d-2.6 e12,-1.8 f8 l22,7 f6 c n1 f10 k7,2.2 g8,-1 e12,-1.6 f8 l16,5 f4 r1.4,0.6 f6 o0.45 f8 l20,7 f8 c w6,2.6,0.6 f8 n1 f8 k6,1.6 g7,0.4 f8 l14,4 f6 n2 f6 d-3 e12,-2.6 f8 u4,0.34,2 f12 c l18,6 f6 n1 f8 k8,2.6 g10,-2 e14,-2 f8 w5,2.8,0.6 f8 l26,9 f20' }
    ];

    function buildBase(w) {
      w.ter = newTerrain(w.mode === 'endless' ? 6000 : 12000);
      w.bx = -40; w.by = 0;
      bAdd(w, -40, 12); bAdd(w, -39.86, 0); bCurve(w, 49.86, 0, 0);  // back wall, start straight to x = 10
      bDeco(w, 'start', 3.2, 0);
    }
    function buildStage(w, src) {
      var ops = parseSrc(src);
      buildBase(w);
      for (var i = 0; i < ops.length; i += 2) feature(w, ops[i], ops[i + 1]);
      bCurve(w, 6, 0, 0);
      w.finishX = w.bx;
      bDeco(w, 'finish', w.bx, w.by);
      bCurve(w, 70, 0, 0);
      bAdd(w, w.bx + 0.14, w.by + 12);
      w.endX = w.bx;
    }

    // =================== world ===================
    function wheelObj() { return { x: 0, y: 0, vx: 0, vy: 0, th: 0, om: 0, px: 0, py: 0, pth: 0, touch: false, s: 0 }; }
    function newWorld(opt) {
      opt = opt || {};
      var w = {
        mode: opt.endless ? 'endless' : 'stage', stage: opt.stage | 0, seed: (opt.seed >>> 0) || 1,
        P: bikeParams(opt.up), ter: null, bx: 0, by: 0,
        decos: [], gaps: [], cps: [], items: [], finishX: 1e9, startX: 0, endX: 0,
        c: { x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0, px: 0, py: 0, pa: 0 },
        wh: [wheelObj(), wheelObj()],
        inGas: 0, inBrake: 0, inLean: 0,
        lean: 0, plean: 0,
        state: 'ready', stateT: 0, t: 0, bonus: 0, final: 0, steps: 0, acc: 0,
        flips: 0, perfects: 0, crashes: 0, why: '', bodyT: false,
        air: false, airT: 0, airRot: 0, landRel: 0, pendBoth: false, pendAir: 0,
        pendN: 0, pendRot: 0, pendT: -1, pendPerfect: false, lastFlipN: 0, lastFlipDir: 0, lastPerfect: false, upsideT: 0,
        cpi: 0, cpX: 0,
        rag: new Float64Array(RAG_N * 4), ragP: new Float64Array(RAG_N * 2), ragL: new Float64Array(RAG_PAIRS.length / 2),
        cam: { x: 0, y: 0, z: 1, px: 0, py: 0, pz: 1 }, viewW: 14, viewH: 10,
        fuel: 1, coins: 0, dist: 0, stallT: 0, emptyT: 0, itemI: 0, gen: null,
        rec: null, recN: 0,                                         // ghost recording buffer (set by the UI)
        events: [], done: false
      };
      if (w.mode === 'endless') {
        buildBase(w);
        w.gen = { s: w.seed | 0, nextFuel: 150, last: 0 };
        genEndless(w, 220);
      } else if (typeof opt.src === 'string') {
        buildStage(w, opt.src);                                    // custom track (tests)
      } else {
        w.stage = clamp(w.stage, 0, STAGES.length - 1);
        buildStage(w, STAGES[w.stage].src);
      }
      placeBike(w, 0);
      resetCam(w);
      return w;
    }
    // Snap the camera onto its resting target (after the UI sets the view size).
    function resetCam(w) {
      var cam = w.cam;
      cam.z = cam.pz = 1;
      cam.x = cam.px = w.c.x + w.viewW * 0.12;
      cam.y = cam.py = w.c.y + w.viewH * 0.08;
    }

    var POSE = new Float64Array(12);
    // Put the bike at rest on the ground at x (start, checkpoints).
    function placeBike(w, x) {
      var T = w.ter, c = w.c, a = slopeAt(T, x + 0.05, 0.8), ca = Math.cos(a), sa = Math.sin(a), y = -1e9, i;
      c.a = a; c.x = x; c.vx = c.vy = c.w = 0;
      for (i = 0; i < 2; i++) {
        var lx = SUS_AX[i] + SUS_DX[i] * SUS_STAT[i], ly = SUS_AY[i] + SUS_DY[i] * SUS_STAT[i];
        var ox = ca * lx - sa * ly, oy = sa * lx + ca * ly;
        y = Math.max(y, heightAt(T, x + ox) + WR / Math.max(0.5, Math.cos(slopeAt(T, x + ox, 0.3))) - oy);
      }
      c.y = y + 0.005;
      for (i = 0; i < 2; i++) {
        var wh = w.wh[i], lx2 = SUS_AX[i] + SUS_DX[i] * SUS_STAT[i], ly2 = SUS_AY[i] + SUS_DY[i] * SUS_STAT[i];
        wh.x = c.x + ca * lx2 - sa * ly2; wh.y = c.y + sa * lx2 + ca * ly2;
        wh.vx = wh.vy = wh.om = 0; wh.s = SUS_STAT[i]; wh.touch = true;
      }
      w.lean = w.plean = 0;
      w.air = false; w.airT = 0; w.airRot = 0; w.pendT = -1; w.pendN = 0; w.upsideT = 0;
      savePrev(w);
    }
    function savePrev(w) {
      var c = w.c, a = w.wh[0], b = w.wh[1], cam = w.cam;
      c.px = c.x; c.py = c.y; c.pa = c.a;
      a.px = a.x; a.py = a.y; a.pth = a.th;
      b.px = b.x; b.py = b.y; b.pth = b.th;
      cam.px = cam.x; cam.py = cam.y; cam.pz = cam.z;
      w.plean = w.lean;
      for (var i = 0; i < RAG_N; i++) { w.ragP[i * 2] = w.rag[i * 4]; w.ragP[i * 2 + 1] = w.rag[i * 4 + 1]; }
    }

    // Local point on the chassis → world (into _wx/_wy).
    var _wx = 0, _wy = 0;
    function toWorld(c, lx, ly) {
      var ca = Math.cos(c.a), sa = Math.sin(c.a);
      _wx = c.x + ca * lx - sa * ly; _wy = c.y + sa * lx + ca * ly;
    }

    // =================== the step ===================
    var JD = new Float64Array(16);    // per wheel: dx dy rx ry s perr jlo jhi
    var BLIM = new Float64Array(2), BACC = new Float64Array(2);
    function step(w) {
      var dt = STEP, P = w.P, c = w.c, rw = w.wh[0], fw = w.wh[1], T = w.ter, i, k, it;
      savePrev(w);
      w.steps++;
      w.stateT += dt;
      var st = w.state, gas = 0, brake = 0, lean = 0;
      if (st === 'ready' && (w.inGas || w.inBrake)) { st = w.state = 'ride'; w.stateT = 0; w.events.push('start'); }
      if (st === 'ride') {
        gas = w.inGas ? 1 : 0; brake = w.inBrake ? 1 : 0; lean = clamp(w.inLean, -1, 1);
        if (w.mode === 'endless' && w.fuel <= 0) gas = 0;
      } else if (st === 'ready') {
        lean = clamp(w.inLean, -1, 1);
      } else if (st === 'finish') brake = 1;
      if (st === 'ride' || st === 'crash') w.t += dt;        // a crash costs the time it takes to get back up
      if (st !== 'crash') w.lean += clamp(lean - w.lean, -dt * 7, dt * 7);

      var ca = Math.cos(c.a), sa = Math.sin(c.a);
      // ---- forces → velocities ----
      var sp = Math.sqrt(c.vx * c.vx + c.vy * c.vy), dk = (0.012 + 0.003 * sp) * dt;
      c.vx -= c.vx * dk; c.vy -= c.vy * dk;
      c.vy -= G * dt;
      for (i = 0; i < 2; i++) {
        var wh = w.wh[i], o = i * 8;
        wh.vy -= G * dt;
        var ax = c.x + ca * SUS_AX[i] - sa * SUS_AY[i], ay = c.y + sa * SUS_AX[i] + ca * SUS_AY[i];
        var dx = ca * SUS_DX[i] - sa * SUS_DY[i], dy = sa * SUS_DX[i] + ca * SUS_DY[i];
        var rx = wh.x - c.x, ry = wh.y - c.y;
        var s = (wh.x - ax) * dx + (wh.y - ay) * dy, perr = (wh.x - ax) * -dy + (wh.y - ay) * dx;
        var vcx = c.vx - c.w * ry, vcy = c.vy + c.w * rx;
        var sd = (wh.vx - vcx) * dx + (wh.vy - vcy) * dy;
        var F = (P.k[i] * (SUS_REST[i] - s) - P.c[i] * sd) * dt;
        wh.vx += F * dx * iMW; wh.vy += F * dy * iMW;
        c.vx -= F * dx * iMC; c.vy -= F * dy * iMC;
        c.w -= (rx * dy - ry * dx) * F * iIC;
        JD[o] = dx; JD[o + 1] = dy; JD[o + 2] = rx; JD[o + 3] = ry; JD[o + 4] = s; JD[o + 5] = perr; JD[o + 6] = 0; JD[o + 7] = 0;
        wh.s = s;
      }
      // ---- engine, brakes, rolling drag ----
      var fwd = c.vx * ca + c.vy * sa, rev = brake && !gas && fwd < 0.8;
      if (gas) {
        var f = c.w - rw.om;                                      // forward spin relative to the frame
        var fr = clamp(f / P.omax, 0, 1), tq = P.torque * (1 - fr * fr) * dt;
        rw.om -= tq * iIW; c.w += tq * iIC;
      } else if (rev) {
        var f2 = rw.om - c.w;
        var tq2 = P.torque * 0.45 * clamp(1 - f2 / 14, 0, 1) * dt;
        rw.om += tq2 * iIW; c.w -= tq2 * iIC;
      }
      // brakes + rolling drag: a clamped wheel↔frame spin constraint, solved with the rest
      for (i = 0; i < 2; i++) { BLIM[i] = ((brake && !rev ? BRAKE_T[i] : 0) + ROLL_T) * dt; BACC[i] = 0; }
      // ---- rider lean: a torque on the frame (fades as the spin builds) ----
      if (lean) {
        var wl = -lean * c.w;
        c.w -= lean * (rw.touch || fw.touch ? LEAN_G : LEAN_A) * clamp(1 - wl / LEAN_WMAX, 0, 1) * dt * iIC;
      }
      if (w.air) c.w -= c.w * AIR_DAMP * dt;

      // ---- contacts ----
      nC = 0;
      collide(T, rw.x, rw.y, WR, 0, 0, 0);
      collide(T, fw.x, fw.y, WR, 1, 0, 0);
      for (k = 0; k < 3; k++) {
        var bx = c.x + ca * BODY[k * 3] - sa * BODY[k * 3 + 1], by = c.y + sa * BODY[k * 3] + ca * BODY[k * 3 + 1];
        collide(T, bx, by, BODY[k * 3 + 2], 2 + k, bx - c.x, by - c.y);
      }
      rw.touch = fw.touch = false; w.bodyT = false;
      for (k = 0; k < nC; k++) {
        if (CK[k] === 0) rw.touch = true; else if (CK[k] === 1) fw.touch = true; else w.bodyT = true;
        if (CK[k] >= 2) {
          var rn = CRX[k] * CNY[k] - CRY[k] * CNX[k], rt = CRX[k] * -CNX[k] - CRY[k] * CNY[k];
          CMN[k] = 1 / (iMC + rn * rn * iIC); CMT[k] = 1 / (iMC + rt * rt * iIC);
        }
      }

      // ---- sequential impulses: joints, then contacts ----
      for (it = 0; it < ITER; it++) {
        for (i = 0; i < 2; i++) {
          solveJoint(w, i, P);
          var wb = w.wh[i], jb = -(wb.om - c.w) * IEFF, ob = BACC[i];
          BACC[i] = clamp(ob + jb, -BLIM[i], BLIM[i]); jb = BACC[i] - ob;
          wb.om += jb * iIW; c.w -= jb * iIC;
        }
        for (k = 0; k < nC; k++) solveContact(w, k, P);
      }

      // ---- integrate positions ----
      c.x += c.vx * dt; c.y += c.vy * dt; c.a += c.w * dt;
      for (i = 0; i < 2; i++) { var q = w.wh[i]; q.x += q.vx * dt; q.y += q.vy * dt; q.th += q.om * dt; }
      // Positional correction (no velocity change: no bounce from fixing overlap).
      // A wheel is pushed out along its own slider, so the fix never knocks it
      // off the fork axis (that error would come back as a sideways shove).
      for (k = 0; k < nC; k++) {
        var corr = (CPEN[k] - SLOP) * POS_BETA;
        if (corr <= 0) continue;
        if (CK[k] < 2) {
          var qw = w.wh[CK[k]], o2 = CK[k] * 8, nd = -(CNX[k] * JD[o2] + CNY[k] * JD[o2 + 1]);
          if (nd > 0.5) { qw.x -= JD[o2] * corr / nd; qw.y -= JD[o2 + 1] * corr / nd; }
          else { qw.x += CNX[k] * corr; qw.y += CNY[k] * corr; }
        }
        else {
          var rn2 = CRX[k] * CNY[k] - CRY[k] * CNX[k], lam = corr / (iMC + rn2 * rn2 * iIC);
          c.x += CNX[k] * lam * iMC; c.y += CNY[k] * lam * iMC; c.a += rn2 * lam * iIC;
        }
      }

      if (w.state === 'crash') ragStep(w, dt);
      post(w, dt);
      // ghost recording (stage runs): the frame every GHOST_DT of run time
      if (w.rec && (w.state === 'ride' || w.state === 'crash') && w.t >= w.recN * GHOST_DT && w.recN * 3 + 3 <= w.rec.length) {
        var ro = w.recN * 3;
        w.rec[ro] = c.x; w.rec[ro + 1] = c.y; w.rec[ro + 2] = c.a; w.recN++;
      }
      camStep(w, dt);
    }

    function solveJoint(w, i, P) {
      var c = w.c, wh = w.wh[i], o = i * 8, dx = JD[o], dy = JD[o + 1], rx = JD[o + 2], ry = JD[o + 3], s = JD[o + 4];
      var ex = -dy, ey = dx;
      // perpendicular: the wheel stays on its slider
      var vcx = c.vx - c.w * ry, vcy = c.vy + c.w * rx;
      var vrel = (wh.vx - vcx) * ex + (wh.vy - vcy) * ey;
      var rn = rx * ey - ry * ex, K = iMW + iMC + rn * rn * iIC;
      var lam = -(vrel + JBETA * JD[o + 5] / STEP) / K;
      applyJ(c, wh, lam, ex, ey, rn);
      // travel stops
      var smin = P.smin[i], smax = SUS_MAX[i];
      if (s < smin + 0.01 || s > smax - 0.01) {
        vcx = c.vx - c.w * ry; vcy = c.vy + c.w * rx;
        var vd = (wh.vx - vcx) * dx + (wh.vy - vcy) * dy, rd = rx * dy - ry * dx, Kd = iMW + iMC + rd * rd * iIC;
        if (s < smin + 0.01) {
          var bias = s < smin ? (smin - s) * 0.25 / STEP : 0;
          var l1 = -(vd - bias) / Kd, old = JD[o + 6];
          JD[o + 6] = Math.max(0, old + l1); l1 = JD[o + 6] - old;
          applyJ(c, wh, l1, dx, dy, rd);
        } else {
          var bias2 = s > smax ? (smax - s) * 0.25 / STEP : 0;
          var l2 = -(vd - bias2) / Kd, old2 = JD[o + 7];
          JD[o + 7] = Math.min(0, old2 + l2); l2 = JD[o + 7] - old2;
          applyJ(c, wh, l2, dx, dy, rd);
        }
      }
    }
    function applyJ(c, wh, lam, nx, ny, rn) {
      wh.vx += lam * nx * iMW; wh.vy += lam * ny * iMW;
      c.vx -= lam * nx * iMC; c.vy -= lam * ny * iMC;
      c.w -= rn * lam * iIC;
    }
    function solveContact(w, k, P) {
      var nx = CNX[k], ny = CNY[k], tx = ny, ty = -nx, kind = CK[k], jn, old, jt, lim;
      if (kind < 2) {
        var wh = w.wh[kind];
        jn = -(wh.vx * nx + wh.vy * ny) * MW;
        old = CJN[k]; CJN[k] = Math.max(0, old + jn); jn = CJN[k] - old;
        wh.vx += jn * nx * iMW; wh.vy += jn * ny * iMW;
        jt = -(wh.vx * tx + wh.vy * ty + wh.om * WR) * MT;
        lim = P.mu * CJN[k]; old = CJT[k]; CJT[k] = clamp(old + jt, -lim, lim); jt = CJT[k] - old;
        wh.vx += jt * tx * iMW; wh.vy += jt * ty * iMW; wh.om += jt * WR * iIW;
      } else {
        var c = w.c, rx = CRX[k], ry = CRY[k];
        var vx = c.vx - c.w * ry, vy = c.vy + c.w * rx;
        jn = -(vx * nx + vy * ny) * CMN[k];
        old = CJN[k]; CJN[k] = Math.max(0, old + jn); jn = CJN[k] - old;
        c.vx += jn * nx * iMC; c.vy += jn * ny * iMC; c.w += (rx * ny - ry * nx) * jn * iIC;
        vx = c.vx - c.w * ry; vy = c.vy + c.w * rx;
        jt = -(vx * tx + vy * ty) * CMT[k];
        lim = BODY_MU * CJN[k]; old = CJT[k]; CJT[k] = clamp(old + jt, -lim, lim); jt = CJT[k] - old;
        c.vx += jt * tx * iMC; c.vy += jt * ty * iMC; c.w += (rx * ty - ry * tx) * jt * iIC;
      }
    }

    // ---- after the physics: tricks, crashes, checkpoints, finish, pickups ----
    function post(w, dt) {
      var c = w.c, T = w.ter, ev = w.events, st = w.state, rw = w.wh[0], fw = w.wh[1];
      var touching = rw.touch || fw.touch || w.bodyT;
      if (st === 'ride' || st === 'ready') {
        // airtime + rotation; a landing confirms flips after a short grace (no crash)
        if (!touching) {
          w.airT += dt; w.airRot += w.c.w * dt;
          if (w.airT > 0.12) w.air = true;
        } else {
          if (w.air) {
            // full turns beyond the takeoff → landing attitude change (a backflip off a
            // 40° kicker onto the flat is only 320° of spin, but it is one flip)
            var n = Math.round(Math.abs(w.airRot - wrapPi(w.airRot)) / TAU);
            var rel = Math.abs(wrapPi(c.a - slopeAt(T, c.x, 0.8)));
            w.landRel = rel;
            w.pendN = n; w.pendRot = w.airRot; w.pendT = 0;
            w.pendPerfect = w.airT > 0.55 && rel < 0.2 && rw.touch && fw.touch;
            w.pendBoth = rw.touch && fw.touch; w.pendAir = w.airT;
          } else if (w.pendT >= 0 && w.pendT < 0.1 && !w.pendBoth && rw.touch && fw.touch) {
            // second wheel down soon after the first: still a clean two-wheel landing
            w.pendBoth = true;
            if (w.pendAir > 0.55 && w.landRel < 0.3) w.pendPerfect = true;
          }
          w.air = false; w.airT = 0; w.airRot = 0;
        }
        if (w.pendT >= 0) {
          w.pendT += dt;
          if (w.pendT >= FLIP_CONFIRM) {
            if (w.pendN > 0) {
              w.flips += w.pendN; w.lastFlipN = w.pendN; w.lastFlipDir = w.pendRot > 0 ? 1 : -1;
              if (w.mode === 'stage') w.bonus += w.pendN; else w.coins += 5 * w.pendN;
              ev.push('flip');
            }
            if (w.pendPerfect && w.state === 'ride') {
              w.perfects++;
              if (w.mode === 'stage') w.bonus += 0.25; else w.coins += 2;
              ev.push('perfect');
            }
            w.pendT = -1; w.pendN = 0; w.pendPerfect = false;
          }
        }
      }
      if (st === 'ride') {
        // the head
        riderPose(w.lean, POSE);
        toWorld(c, POSE[0], POSE[1]);
        if (groundDist(T, _wx, _wy, HEAD_R) < HEAD_R) crash(w, 'head');
        else {
          for (var g = 0; g < w.gaps.length; g++) {
            var gp = w.gaps[g];
            if (c.x > gp.x0 - 0.5 && c.x < gp.x1 + 0.5 && c.y < gp.y - 1.2) { crash(w, 'gap'); break; }
          }
        }
        // stuck on its back
        if (w.state === 'ride') {
          if (w.bodyT && !rw.touch && !fw.touch && Math.cos(c.a - slopeAt(T, c.x, 0.8)) < 0.1) w.upsideT += dt; else w.upsideT = 0;
          if (w.upsideT > 0.5) crash(w, 'flip');
        }
      }
      st = w.state;
      if (st === 'ride') {
        while (w.cpi < w.cps.length && c.x >= w.cps[w.cpi]) { w.cpX = w.cps[w.cpi]; w.cpi++; ev.push('cp'); }
        if (w.mode === 'stage' && c.x >= w.finishX) {
          w.state = 'finish'; w.stateT = 0; w.final = Math.max(0, w.t - w.bonus); ev.push('finish');
        }
        if (w.mode === 'endless') endlessTick(w, dt);
      } else if (st === 'crash') {
        if (w.stateT >= CRASH_T) {
          if (w.mode === 'stage') {
            placeBike(w, w.cpX);
            w.state = 'ride'; w.stateT = 0; ev.push('respawn');
          } else { w.state = 'over'; w.stateT = 0; ev.push('over'); }
        }
      } else if (st === 'finish') {
        if (!w.done && w.stateT >= FINISH_T) { w.done = true; ev.push('done'); }
      }
    }

    function crash(w, why) {
      var c = w.c, i;
      w.state = 'crash'; w.stateT = 0; w.crashes++; w.why = why;
      w.pendT = -1; w.pendN = 0; w.pendPerfect = false;
      w.events.push('crash');
      // rider → ragdoll: joints at their posed positions, moving with the frame, plus a little pop
      riderPose(w.lean, POSE);
      for (i = 0; i < RAG_N; i++) {
        toWorld(c, POSE[i * 2], POSE[i * 2 + 1]);
        var rx = _wx - c.x, ry = _wy - c.y;
        var vx = c.vx - c.w * ry, vy = c.vy + c.w * rx + 1.5;
        var o = i * 4;
        w.rag[o] = _wx; w.rag[o + 1] = _wy; w.rag[o + 2] = _wx - vx * STEP; w.rag[o + 3] = _wy - vy * STEP;
        w.ragP[i * 2] = _wx; w.ragP[i * 2 + 1] = _wy;
      }
      for (i = 0; i < RAG_PAIRS.length; i += 2) {
        var a = RAG_PAIRS[i] * 4, b = RAG_PAIRS[i + 1] * 4, ddx = w.rag[a] - w.rag[b], ddy = w.rag[a + 1] - w.rag[b + 1];
        w.ragL[i / 2] = Math.sqrt(ddx * ddx + ddy * ddy);
      }
    }
    // Verlet ragdoll with distance constraints and ground friction.
    function ragStep(w, dt) {
      var R = w.rag, T = w.ter, i, it;
      for (i = 0; i < RAG_N; i++) {
        var o = i * 4, x = R[o], y = R[o + 1], vx = (x - R[o + 2]) * 0.998, vy = (y - R[o + 3]) * 0.998;
        R[o + 2] = x; R[o + 3] = y;
        R[o] = x + vx; R[o + 1] = y + vy - G * dt * dt;
      }
      for (it = 0; it < 4; it++) {
        for (i = 0; i < RAG_PAIRS.length; i += 2) {
          var a = RAG_PAIRS[i] * 4, b = RAG_PAIRS[i + 1] * 4, dx = R[a] - R[b], dy = R[a + 1] - R[b + 1];
          var d = Math.sqrt(dx * dx + dy * dy) || 1e-6, k = (d - w.ragL[i / 2]) / d * 0.5;
          R[a] -= dx * k; R[a + 1] -= dy * k; R[b] += dx * k; R[b + 1] += dy * k;
        }
        for (i = 0; i < RAG_N; i++) {
          var p = i * 4, r = i === 0 ? HEAD_R : 0.08, h = heightAt(T, R[p]) + r;
          if (R[p + 1] < h) {
            R[p + 1] = h;
            R[p + 2] += (R[p] - R[p + 2]) * 0.35;              // friction: bleed sliding speed
            if (R[p + 3] < h) R[p + 3] = h - (R[p + 3] - h) * 0.0;
          }
        }
      }
    }

    // ---- camera (part of the fixed step so it is frame-rate independent) ----
    function camStep(w, dt) {
      var c = w.c, cam = w.cam, fx = c.x, fy = c.y, vx = c.vx, vy = c.vy;
      if (w.state === 'crash') { fx = (c.x + w.rag[0]) / 2; fy = (c.y + w.rag[1]) / 2; vx *= 0.3; vy = 0; }
      var sp = Math.sqrt(vx * vx + vy * vy);
      var tz = 1 + clamp((sp - 7) / 22, 0, 0.38) + (w.air && w.airT > 0.3 ? 0.1 : 0);
      cam.z += (tz - cam.z) * Math.min(1, dt * 1.2);
      var vw = w.viewW * cam.z, vh = w.viewH * cam.z;
      var tx = fx + clamp(vw * 0.12 + vx * 0.3, -vw * 0.1, vw * 0.24), ty = fy + vh * 0.08 + clamp(vy * 0.08, -1, 0.8);
      // follow with velocity feed-forward (no steady lag at speed), then ease onto the target
      cam.x += vx * dt + (tx - cam.x) * Math.min(1, dt * 2.6);
      cam.y += vy * 0.6 * dt + (ty - cam.y) * Math.min(1, dt * 2.4);
      // never lose the rider off an edge
      var mx = vw * 0.36, my = vh * 0.32;
      if (fx - cam.x > mx) cam.x = fx - mx; else if (cam.x - fx > mx) cam.x = fx + mx;
      if (fy - cam.y > my) cam.y = fy - my; else if (cam.y - fy > my) cam.y = fy + my;
    }

    // =================== endless ===================
    function endlessTick(w, dt) {
      var c = w.c, P = w.P;
      if (w.fuel > 0) {
        w.fuel -= dt * (0.25 + 0.75 * (w.inGas ? 1 : 0)) / P.tank;
        if (w.fuel <= 0) { w.fuel = 0; w.events.push('nofuel'); }
      } else {
        w.emptyT += dt;
        var sp = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
        w.stallT = sp < 0.5 ? w.stallT + dt : 0;
        if (w.stallT > 1.2 || w.emptyT > 12) { w.state = 'over'; w.why = 'fuel'; w.stateT = 0; w.events.push('over'); }
      }
      if (c.x - w.startX > w.dist) w.dist = c.x - w.startX;
      // pickups near the bike
      var items = w.items, rw = w.wh[0], fw = w.wh[1];
      while (w.itemI < items.length && items[w.itemI].x < c.x - 6) w.itemI++;
      for (var i = w.itemI; i < items.length; i++) {
        var it = items[i];
        if (it.x > c.x + 4) break;
        if (!it.on) continue;
        var r = it.k ? 1.0 : 0.85;
        if (near(it, c.x, c.y, r) || near(it, rw.x, rw.y, r * 0.8) || near(it, fw.x, fw.y, r * 0.8)) {
          it.on = 0;
          if (it.k) { w.fuel = 1; w.emptyT = 0; w.stallT = 0; w.events.push('fuel'); } else { w.coins++; w.events.push('coin'); }
        }
      }
      if (w.bx < c.x + 200) genEndless(w, c.x + 260);
      if (w.ter.n > w.ter.cap - 500 || c.x - w.ter.xs[0] > 600) compact(w);
    }
    function near(it, x, y, r) { var dx = it.x - x, dy = it.y - y; return dx * dx + dy * dy < r * r; }

    // Drop terrain, decorations and pickups far behind the bike (endless only).
    function compact(w) {
      var T = w.ter, cut = w.c.x - 90, i = segAt(T, cut), j, k;
      if (i < 50) return;
      T.xs.copyWithin(0, i, T.n); T.ys.copyWithin(0, i, T.n); T.n -= i; T.hint = 0;
      for (k = 0, j = 0; j < w.decos.length; j++) if (w.decos[j].x > cut - 20) w.decos[k++] = w.decos[j];
      w.decos.length = k;
      for (k = 0, j = 0; j < w.items.length; j++) if (w.items[j].x > cut) w.items[k++] = w.items[j];
      w.items.length = k; w.itemI = 0;
      for (k = 0, j = 0; j < w.gaps.length; j++) if (w.gaps[j].x1 > cut) w.gaps[k++] = w.gaps[j];
      w.gaps.length = k;
    }

    function coinRow(w, x0, x1, lift) {
      for (var x = x0; x <= x1 + 1e-6; x += 1.3) {
        var y = heightAt(w.ter, x);
        for (var g = 0; g < w.gaps.length; g++) {
          var gp = w.gaps[g];
          if (x > gp.x0 - 1 && x < gp.x1 + 1) { var t = (x - gp.x0) / (gp.x1 - gp.x0); y = gp.y + 1.6 + 2.2 * Math.sin(Math.PI * clamp(t, 0, 1)); }
        }
        w.items.push({ x: x, y: y + lift, k: 0, on: 1 });
      }
    }

    // Procedural terrain: one feature at a time from the seeded generator.
    // Features get bigger with distance; every jump is sized to be clearable.
    function genEndless(w, upto) {
      var g = w.gen;
      while (w.bx < upto) {
        var d = Math.max(0, w.bx - 40), diff = Math.min(1, d / 2400), r = rnd(g), x0, H, L;
        // a warning sign at the start of the run-up to a jump or a cliff
        var warn = (r >= 0.36 && r < 0.52) || r >= 0.9;
        if (warn) feature(w, 'n', [r >= 0.9 ? 2 : 1]);
        feature(w, 'f', [warn ? 8 + rnd(g) * 4 : 3 + rnd(g) * 6 * (1.2 - diff)]);
        x0 = w.bx;
        var drift = w.by > 22 ? -1 : w.by < -12 ? 1 : 0;
        var coins = rnd(g) < 0.55;
        if (r < 0.2) {                                   // hill / dip
          L = 14 + rnd(g) * 16; H = (0.8 + rnd(g) * 1.8) * (0.7 + diff * 0.8);
          feature(w, 'h', [L, (rnd(g) < 0.3 ? -0.7 : 1) * H]);
        } else if (r < 0.36) {                           // climb or descent
          L = 16 + rnd(g) * 16; H = (2 + rnd(g) * 4) * (0.7 + diff * 0.6);
          var dir = drift || (rnd(g) < 0.55 ? 1 : -1);
          feature(w, 'l', [L, dir * Math.min(H, L * (0.32 + 0.18 * diff))]);
        } else if (r < 0.52) {                           // kicker over a gap
          H = 1.1 + rnd(g) * (0.8 + diff);
          L = 5 + H * 1.3;
          feature(w, 'k', [L, H]);
          var W = Math.min(2.8 + diff * 4 + rnd(g) * 1.5, 3.5 + H * 2.2);
          feature(w, 'g', [W, -H * (0.6 + rnd(g) * 0.5)]);
          feature(w, 'e', [6, -0.6]);
          feature(w, 'f', [5]);
        } else if (r < 0.64) {                           // tabletop
          H = 1.4 + rnd(g) * (1 + diff);
          feature(w, 'k', [5 + H, H]); feature(w, 'f', [3 + rnd(g) * 6]); feature(w, 'e', [8 + H * 1.5, -H]);
        } else if (r < 0.74) {                           // whoops
          feature(w, 'w', [3 + Math.floor(rnd(g) * 4), 2.4 + rnd(g) * 0.8, 0.35 + rnd(g) * (0.2 + 0.35 * diff)]);
        } else if (r < 0.82) {                           // logs and rocks
          if (rnd(g) < 0.5) feature(w, 'o', [0.25 + rnd(g) * 0.17]); else feature(w, 'r', [0.9 + rnd(g) * 0.8, 0.3 + rnd(g) * 0.3]);
          feature(w, 'f', [3 + rnd(g) * 3]);
          if (rnd(g) < 0.5) { if (rnd(g) < 0.5) feature(w, 'o', [0.3]); else feature(w, 'r', [1.2, 0.45]); }
          coins = false;
        } else if (r < 0.9) {                            // stairs
          var up = drift ? drift > 0 : rnd(g) < 0.6, n = 3 + Math.floor(rnd(g) * 3);
          feature(w, 'u', [n, (up ? 1 : -1) * (0.22 + rnd(g) * (0.15 + 0.15 * diff)), 1.8 + rnd(g) * 0.8]);
          coins = false;
        } else {                                         // cliff drop onto a roll-off
          H = 1.6 + rnd(g) * (1 + diff * 1.5);
          feature(w, 'f', [2]); feature(w, 'd', [-H]); feature(w, 'e', [8, -1.2]);
        }
        if (coins && w.bx - x0 > 4) coinRow(w, x0 + 1, Math.min(w.bx - 1, x0 + 12), 1.0);
        if (w.bx >= g.nextFuel) {
          feature(w, 'f', [6]);
          w.items.push({ x: w.bx - 3, y: w.by + 0.65, k: 1, on: 1 });
          g.nextFuel = w.bx + 230 + 120 * diff + rnd(g) * 60;
        }
      }
    }

    // =================== fixed-step driver ===================
    function advance(w, dt) {
      w.acc += clamp(dt, 0, 0.1);              // after a stall, never fast-forward more than a beat
      var n = 0;
      while (w.acc >= STEP - 1e-9) {
        step(w);
        w.acc -= STEP;
        if (++n >= 48) { w.acc = 0; break; }
      }
      return clamp(w.acc / STEP, 0, 1);
    }

    // =================== scoring, persistence, ghosts ===================
    function stars(stageIdx, time) {
      var st = STAGES[stageIdx];
      if (!st || !(time > 0)) return 0;
      return time <= st.par[0] ? 3 : time <= st.par[1] ? 2 : 1;
    }
    function normSave(o) {
      var s = { v: 1, st: {}, coins: 0, up: {}, eb: 0, ghost: true };
      if (!o || typeof o !== 'object') return s;
      if (o.st && typeof o.st === 'object') {
        for (var i = 0; i < STAGES.length; i++) {
          var r = o.st[i + 1];
          if (r && typeof r === 'object' && +r.t > 0 && isFinite(+r.t)) s.st[i + 1] = { t: +r.t, s: clamp(r.s | 0, 1, 3) };
        }
      }
      s.coins = Math.max(0, Math.floor(+o.coins || 0));
      for (var k = 0; k < UPGRADES.length; k++) s.up[UPGRADES[k].key] = upLevel(o.up, UPGRADES[k].key);
      s.eb = Math.max(0, Math.floor(+o.eb || 0));
      s.ghost = o.ghost !== false;
      return s;
    }
    function unlocked(save, idx) { return idx === 0 || !!save.st[idx]; }   // stage idx (0-based) needs stage idx-1 done
    function totalStars(save) { var n = 0; for (var k in save.st) n += save.st[k].s; return n; }

    // Ghost: chassis x, y, angle every GHOST_DT, delta + zigzag + base-32 varints.
    var GHOST_DT = 0.1;
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    function encodeGhost(arr, n) {
      var out = '', prev = [0, 0, 0], scale = [20, 20, 100];
      for (var i = 0; i < n; i++) {
        for (var k = 0; k < 3; k++) {
          var q = Math.round(arr[i * 3 + k] * scale[k]), d = q - prev[k];
          prev[k] = q;
          var z = d >= 0 ? d * 2 : -d * 2 - 1;
          while (z >= 32) { out += B64.charAt(32 + (z % 32)); z = Math.floor(z / 32); }
          out += B64.charAt(z);
        }
      }
      return out;
    }
    function decodeGhost(str) {
      var vals = [], prev = [0, 0, 0], scale = [20, 20, 100], k = 0, z = 0, mul = 1;
      for (var i = 0; i < str.length; i++) {
        var v = B64.indexOf(str.charAt(i));
        if (v < 0) return null;
        if (v >= 32) { z += (v - 32) * mul; mul *= 32; continue; }
        z += v * mul;
        var d = z % 2 ? -(z + 1) / 2 : z / 2;
        prev[k] += d; vals.push(prev[k] / scale[k]);
        k = (k + 1) % 3; z = 0; mul = 1;
      }
      if (k !== 0) return null;
      return new Float32Array(vals);
    }

    // =================== a simple riding bot (tests, stage validation) ===================
    // Full gas; lean (on/off, like the keys) to keep the frame parallel to the
    // ground, and in the air to the slope at the predicted landing spot.
    function bot(w) {
      var c = w.c, T = w.ter, lean = 0, gas = 1, brake = 0;
      if (w.air || (!w.wh[0].touch && !w.wh[1].touch)) {
        var tl = 0.45, tgt = slopeAt(T, c.x + c.vx * tl, 1.0);
        var u = wrapPi(c.a - tgt) * 2.2 + c.w * 0.45;
        lean = u > 0.25 ? 1 : u < -0.25 ? -1 : 0;
      } else {
        var e2 = wrapPi(c.a - slopeAt(T, c.x, 1.0));
        if (e2 > 0.22) lean = 1; else if (e2 < -0.18) lean = -1;
        if (e2 > 0.6) gas = 0;
      }
      w.inGas = gas; w.inBrake = brake; w.inLean = lean;
    }

    return {
      STEP: STEP, G: G, WR: WR, HEAD_R: HEAD_R, CRASH_T: CRASH_T, STAGES: STAGES, UPGRADES: UPGRADES, UP_MAX: UP_MAX, UP_COST: UP_COST,
      RAG_N: RAG_N, RAG_PAIRS: RAG_PAIRS, BODY: BODY, SUS_AX: SUS_AX, SUS_AY: SUS_AY, GHOST_DT: GHOST_DT,
      newWorld: newWorld, step: step, advance: advance, placeBike: placeBike, riderPose: riderPose, resetCam: resetCam,
      SUS_DX: SUS_DX, SUS_DY: SUS_DY, SUS_STAT: SUS_STAT, CW_TERRAIN: 0.26,
      heightAt: heightAt, slopeAt: slopeAt, segAt: segAt, groundDist: groundDist, parseSrc: parseSrc,
      bikeParams: bikeParams, upLevel: upLevel, stars: stars, normSave: normSave, unlocked: unlocked, totalStars: totalStars,
      encodeGhost: encodeGhost, decodeGhost: decodeGhost, bot: bot, wrapPi: wrapPi, clamp: clamp, rnd: rnd
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // =====================================================================
  // UI — panel, input, rendering, menus (browser only)
  // =====================================================================
  var Cade = window.Cade;
  Cade.loadCSS('uphill.css');

  var PANEL_ID = 'uphill-panel';
  var SAVE_KEY = 'cade-uphill-save', GHOST_KEY = 'cade-uphill-ghost-', SOUND_KEY = 'cade-uphill-sound';
  var STAR_COINS = 15, TAU = Math.PI * 2, CW = E.CW_TERRAIN, ROW_M = 0.42, REC_CAP = 9000;
  var clamp = E.clamp;
  var S = null;                                   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.uphill = { live: function () { return S; }, draw: function (a) { draw(a); }, E: E };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function loadSave() { var o = null; try { o = JSON.parse(sget(SAVE_KEY) || 'null'); } catch (e) { o = null; } return E.normSave(o); }
  function writeSave() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtT(t) { return (Math.round(t * 100) / 100).toFixed(2) + 's'; }
  function starStr(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  // ---- tiny WebAudio voice: blips + an engine hum; off by default, created in a gesture ----
  function Snd(on) { this.on = !!on; this.ac = null; this.hum = null; }
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
  Snd.prototype.humStart = function () {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed' || this.hum) return;
    try {
      var o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
      o.type = 'sawtooth'; o.frequency.value = 48;
      f.type = 'lowpass'; f.frequency.value = 480; f.Q.value = 3;
      g.gain.value = 0.0001;
      o.connect(f); f.connect(g); g.connect(ac.destination);
      o.start();
      this.hum = { o: o, g: g };
    } catch (e) { this.hum = null; }
  };
  Snd.prototype.humSet = function (freq, vol) {
    var h = this.hum;
    if (!h) return;
    try { var t = this.ac.currentTime; h.o.frequency.setTargetAtTime(freq, t, 0.05); h.g.gain.setTargetAtTime(vol, t, 0.07); } catch (e) {}
  };
  Snd.prototype.humStop = function () {
    var h = this.hum;
    if (!h) return;
    this.hum = null;
    try { var t = this.ac.currentTime; h.g.gain.setTargetAtTime(0.0001, t, 0.03); h.o.stop(t + 0.2); } catch (e) {}
  };
  Snd.prototype.close = function () { this.hum = null; if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

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
  function rgb(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var sf = parseCol(v('--surface'), bg);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.dark = dark;
    S.col = {
      bg: rgb(bg), bgA: rgb(bg, 0.9), surface: rgb(sf), text: rgb(tx), muted: rgb(mu), faint: rgb(fa), accent: rgb(ac),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      star: rgb(mix(bg, tx, 0.38)), cloud: rgb(mix(bg, tx, dark ? 0.17 : 0.2)),
      far: rgb(mix(bg, ac, dark ? 0.26 : 0.2)), near: rgb(mix(bg, tx, dark ? 0.2 : 0.16)),
      ground: rgb(mix(tx, ac, dark ? 0.3 : 0.4)), dirt: rgb(mix(bg, tx, dark ? 0.26 : 0.24)), edge: rgb(mix(bg, tx, dark ? 0.44 : 0.42)),
      rock: rgb(mix(bg, tx, dark ? 0.6 : 0.55)), wood: rgb(mix(mix(bg, tx, 0.62), ac, 0.2)),
      frame: rgb(ac), frameLo: rgb(mix(ac, tx, 0.45)), wheel: rgb(tx), rider: rgb(tx),
      ghost: rgb(mix(bg, tx, dark ? 0.36 : 0.3)), coin: rgb(mix(ac, tx, dark ? 0.05 : 0.15)), pit: rgb(mix(bg, tx, 0.5)),
      shadeLo: rgb(mix(bg, tx, 0.07))
    };
    fitFont();
  }

  // ---- glyph metrics: each glyph's ink is centred on its anchor point ----
  var GLYPHS = '_-=/\\|oO0Q@#$%*+^~.:,\'`[]()<>xX!F★☆v';
  var OFF = {};
  function fitFont() {
    var c = S.ctx;
    c.font = '700 100px ' + S.col.font;
    S.adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    c.textBaseline = 'alphabetic';
    for (var i = 0; i < GLYPHS.length; i++) {
      var ch = GLYPHS.charAt(i), m = c.measureText(ch), a = m.actualBoundingBoxAscent, d = m.actualBoundingBoxDescent;
      OFF[ch] = typeof a === 'number' && typeof d === 'number' && (a || d) ? (a - d) / 200 : 0.32;
    }
    S.fonts = {};
    buildTiles();
  }
  function font(px, wt) {
    var q = Math.max(8, Math.round(px * 4)), w8 = wt || 600, key = w8 * 1000 + q, f = S.fonts[key];
    if (!f) f = S.fonts[key] = w8 + ' ' + (q / 4) + 'px ' + S.col.font;
    return f;
  }
  // one glyph, ink centred at (x, y) — needs textAlign 'center', textBaseline 'alphabetic'
  function g1(c, ch, x, y, px) { var yy = y + OFF[ch] * px; if (HALO) c.strokeText(ch, x, yy); c.fillText(ch, x, yy); }
  function textMode(c, px, wt, align) { c.font = font(px, wt); c.textAlign = align || 'center'; c.textBaseline = 'alphabetic'; }
  var HALO = false;            // while drawing the HUD: outline text in the background colour
  function label(c, s, x, y, px, wt, align) {
    c.font = font(px, wt); c.textAlign = align || 'center'; c.textBaseline = 'middle';
    if (HALO) c.strokeText(s, x, y);
    c.fillText(s, x, y);
  }

  // Dirt texture, pre-rendered once per size/theme into a small repeating tile
  // (world-anchored when filled, so it scrolls with the ground, never shimmers).
  var DIRT_ROWS = ['.     \'     ', '    .     : ', '  :     .   ', '       ,    ', ' .    \'    .', '    :       ', '\'      .   '];
  function buildTiles() {
    if (!S || !S.col || !S.k || !S.ppm) return;
    var k = S.k, ppm = S.ppm, cols = DIRT_ROWS[0].length, rows = DIRT_ROWS.length;
    var tw = cols * CW, th = rows * ROW_M;
    var cv = S.tileCv || (S.tileCv = document.createElement('canvas'));
    cv.width = Math.max(1, Math.round(tw * ppm * k)); cv.height = Math.max(1, Math.round(th * ppm * k));
    var c = cv.getContext('2d'), px = CW * ppm * k / S.adv;
    c.clearRect(0, 0, cv.width, cv.height);
    c.font = '600 ' + px.toFixed(2) + 'px ' + S.col.font;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = S.col.dirt;
    var sx = cv.width / cols, sy = cv.height / rows;
    for (var r = 0; r < rows; r++) for (var i = 0; i < cols; i++) {
      var ch = DIRT_ROWS[r].charAt(i);
      if (ch !== ' ') c.fillText(ch, (i + 0.5) * sx, (r + 0.5) * sy);
    }
    S.tileS = cv.width / tw;                      // tile device px per metre
    S.dirtPat = S.ctx.createPattern(cv, 'repeat');
  }

  // ---- background: cyclic ASCII ridges + clouds + stars (drawn glyph by glyph: no allocation) ----
  function ridge(seed, maxH, n) {
    var r = E.rnd, g = { s: seed }, hts = new Int8Array(n), chs = [], L = 0, up = true;
    for (var i = 0; i < n; i++) {
      if (L === 0 && !up && r(g) < 0.45) { chs.push('_'); hts[i] = 0; up = true; continue; }
      if (L >= maxH || (L > 0 && r(g) < (up ? 0.2 : 0.08))) up = false;
      else if (L === 0 || r(g) < (up ? 0.04 : 0.14)) up = true;
      if (up) { L++; chs.push('/'); hts[i] = L; } else { chs.push('\\'); hts[i] = L; L--; }
    }
    while (L > 0 && chs.length < n + 40) { chs.push('\\'); L--; }
    return { h: hts, c: chs.slice(0, n), n: n };
  }
  var FAR = ridge(11, 7, 320), NEAR = ridge(29, 4, 260);
  var CLOUD_BIG = ['   .-~~~-.', ' .(       ).', '(___________)'], CLOUD_SMALL = [' .--.', '(____)'];
  var CLOUDS = [[30, 0.12, 1], [210, 0.22, 0], [380, 0.08, 1], [560, 0.18, 0]], CLOUD_P = 700;
  var STARS = (function () { var g = { s: 7 }, a = []; for (var i = 0; i < 40; i++) a.push([E.rnd(g) * 900, E.rnd(g) * 0.5, E.rnd(g) < 0.2 ? '+' : E.rnd(g) < 0.5 ? '.' : '`']); return a; })();

  var V = { ppm: 30, ox: 0, oy: 0, x0: 0, x1: 0, y0: 0, y1: 0 };   // current world → screen view

  function drawSky(c, camx, camy) {
    var K = S.col, W = S.W, H = S.H, i, bcw = 8, px = bcw / S.adv, rowH = px * 0.92;
    var lift = clamp(camy * V.ppm * 0.05, -H * 0.18, H * 0.18);
    textMode(c, px, 600);
    if (S.dark) {
      c.fillStyle = K.star;
      for (i = 0; i < STARS.length; i++) {
        var sx = ((STARS[i][0] - camx * 1.5) % 900 + 900) % 900 - 100;
        if (sx > -8 && sx < W + 8) g1(c, STARS[i][2], sx, STARS[i][1] * H + lift * 0.3, px);
      }
    }
    c.fillStyle = K.cloud; c.textAlign = 'left'; c.textBaseline = 'middle';
    for (i = 0; i < CLOUDS.length; i++) {
      var cx = ((CLOUDS[i][0] - camx * 3) % CLOUD_P + CLOUD_P) % CLOUD_P - 120, cl = CLOUDS[i][2] ? CLOUD_BIG : CLOUD_SMALL;
      if (cx < W + 4) for (var r = 0; r < cl.length; r++) c.fillText(cl[r], cx, CLOUDS[i][1] * H + 14 + r * rowH + lift * 0.4);
    }
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    drawRidge(c, FAR, camx * 4, H * 0.5 + lift, K.far, bcw, px, rowH);
    drawRidge(c, NEAR, camx * 9, H * 0.6 + lift * 1.4, K.near, bcw, px, rowH);
  }
  function drawRidge(c, R, off, base, color, bcw, px, rowH) {
    var n = Math.ceil(S.W / bcw) + 2, i0 = Math.floor(off / bcw), sx = -(off - i0 * bcw), N = R.n;
    c.fillStyle = color;
    for (var j = 0; j < n; j++) {
      var k = ((i0 + j) % N + N) % N, ch = R.c[k];
      if (ch !== '_') g1(c, ch, sx + j * bcw + bcw / 2, base - R.h[k] * rowH, px);
    }
  }

  // ---- terrain ----
  var COLH = new Float64Array(1200);
  var EDGE = ['.', ':', '\'', '.', ',', ':', '`', '.'];
  function drawTerrain(c, w) {
    var T = w.ter, ppm = V.ppm, K = S.col, xs = T.xs, ys = T.ys, n = T.n, i;
    var xa = V.x0 - 1, xb = V.x1 + 1, i0 = E.segAt(T, xa), i1 = Math.min(n - 1, E.segAt(T, xb) + 1);
    // solid ground (hides the hills behind it) with the dirt pattern, clipped to the profile
    c.save();
    c.beginPath();
    c.moveTo(V.ox + xs[i0] * ppm, V.oy - ys[i0] * ppm);
    for (i = i0 + 1; i <= i1; i++) c.lineTo(V.ox + xs[i] * ppm, V.oy - ys[i] * ppm);
    c.lineTo(V.ox + xs[i1] * ppm, 1e5); c.lineTo(V.ox + xs[i0] * ppm, 1e5); c.closePath();
    c.fillStyle = K.bg; c.fill();
    if (S.dirtPat) {
      c.clip();
      var s = S.k * ppm / S.tileS, tx = V.ox * S.k, ty = V.oy * S.k;
      c.setTransform(s, 0, 0, s, tx, ty);
      c.fillStyle = S.dirtPat;
      c.fillRect(-tx / s, -ty / s, S.W * S.k / s, S.H * S.k / s);
      c.setTransform(S.k, 0, 0, S.k, 0, 0);
    }
    c.restore();
    // the surface: one glyph per world column, picked by slope, ink on the true line
    var fpx = CW * ppm / S.adv, rowPx = fpx * 0.9, j0 = Math.floor(xa / CW), j1 = Math.ceil(xb / CW), nc = Math.min(j1 - j0, COLH.length - 1), j;
    for (j = 0; j <= nc; j++) COLH[j] = E.heightAt(T, (j0 + j) * CW);
    textMode(c, fpx, 700);
    c.fillStyle = K.ground;
    for (j = 0; j < nc; j++) {
      var xl = (j0 + j) * CW, h0 = COLH[j], h1 = COLH[j + 1], d = (h1 - h0) / CW;
      if (d < 0.7 && d > -0.7) {
        g1(c, '_', V.ox + (xl + CW / 2) * ppm, V.oy - (h0 + h1) / 2 * ppm, fpx);
      } else {
        var ch = d > 2.4 || d < -2.4 ? '|' : d > 0 ? '/' : '\\', y0p = V.oy - h0 * ppm, y1p = V.oy - h1 * ppm;
        if ((y0p < -fpx && y1p < -fpx) || (y0p > S.H + fpx && y1p > S.H + fpx)) continue;
        var m = Math.max(1, Math.round(Math.abs(y1p - y0p) / rowPx)), xm = V.ox + (xl + CW / 2) * ppm;
        if (m > 60) m = 60;
        for (var q = 0; q < m; q++) {
          var t = (q + 0.5) / m;
          g1(c, ch, ch === '|' ? xm : V.ox + (xl + CW * t) * ppm, y0p + (y1p - y0p) * t, fpx);
        }
      }
    }
    // a textured band just under the surface
    c.fillStyle = K.edge;
    for (j = 0; j < nc; j++) {
      var dd = (COLH[j + 1] - COLH[j]) / CW;
      if (dd > 1.2 || dd < -1.2) continue;
      var e = EDGE[((j0 + j) % 8 + 8) % 8];
      g1(c, e, V.ox + ((j0 + j) * CW + CW / 2) * ppm, V.oy - (COLH[j] + COLH[j + 1]) / 2 * ppm + rowPx * 0.85, fpx);
    }
  }

  // ---- decorations: signs, flags, logs, rocks, pits ----
  function groundY(w, x) { return E.heightAt(w.ter, x); }
  function pole(c, x, y, hM, px) {
    var top = V.oy - (y + hM) * V.ppm, bot = V.oy - y * V.ppm, step = px * 0.85, sxp = V.ox + x * V.ppm;
    for (var yy = bot - step * 0.5; yy > top; yy -= step) g1(c, '|', sxp, yy, px);
    return top;
  }
  function drawDecos(c, w, front) {
    var D = w.decos, ppm = V.ppm, K = S.col, px = CW * ppm / S.adv, i;
    textMode(c, px, 700);
    for (i = 0; i < D.length; i++) {
      var d = D[i];
      if (d.x > V.x1 + 6) break;
      var xEnd = d.k === 'gap' ? d.a : d.k === 'rock' ? d.x + d.a : d.x + 3;
      if (xEnd < V.x0 - 3) continue;
      var sxp = V.ox + d.x * ppm, y, top;
      if (!front) {
        if (d.k === 'start' || d.k === 'finish' || d.k === 'cp' || d.k === 'sign') {
          y = groundY(w, d.x);
          c.fillStyle = d.k === 'cp' && w.cpX >= d.x - 1e-6 && w.cpi > 0 ? K.accent : d.k === 'sign' ? K.muted : K.frameLo;
          top = pole(c, d.x, y, d.k === 'sign' ? 1.3 : d.k === 'cp' ? 1.9 : 2.5, px);
          if (d.k === 'cp') {
            c.fillStyle = w.cpX >= d.x - 1e-6 && w.cpi > 0 ? K.accent : K.muted;
            g1(c, '\\', sxp + px * S.adv, top + px * 0.45, px);
            g1(c, '/', sxp + px * S.adv, top + px * 1.25, px);
          } else if (d.k === 'sign') {
            c.fillStyle = K.text;
            label(c, '/!\\', sxp, top - px * 0.25, px * 0.95, 800);
            if (d.a) { c.fillStyle = K.muted; label(c, d.a === 2 ? 'drop' : 'jump', sxp + px * S.adv * 2, top - px * 0.25, px * 0.75, 700, 'left'); }
            textMode(c, px, 700);
          } else if (d.k === 'start') {
            c.fillStyle = K.bgA; c.fillRect(sxp - px * 2.2, top - px * 1.3, px * 4.4, px * 1.2);
            c.fillStyle = K.text; label(c, 'START', sxp, top - px * 0.7, px * 0.8, 700);
            textMode(c, px, 700);
          } else {
            // chequered flag
            c.fillStyle = K.text;
            for (var r = 0; r < 3; r++) for (var q = 0; q < 4; q++) if ((r + q) % 2 === 0) g1(c, '#', sxp + (q + 0.8) * px * S.adv, top + r * px * 0.75 + px * 0.3, px);
            label(c, 'FINISH', sxp + px * 2.2 * S.adv, top - px * 0.6, px * 0.8, 700);
            textMode(c, px, 700);
          }
        } else if (d.k === 'gap') {
          var fl = Math.min(d.y, d.b) - 16, fy = V.oy - fl * ppm - px * 0.5;
          if (fy < S.H + px && fy > -px) {
            c.fillStyle = K.pit;
            for (var gx = d.x + 0.3; gx < d.a - 0.2; gx += CW) g1(c, '^', V.ox + gx * ppm, fy, px);
          }
        }
      } else if (d.k === 'log') {
        // a half-sunk log, end on: (@)
        var lp2 = Math.max(8, d.a * 1.3 * ppm), cy = V.oy - d.y * ppm;
        c.fillStyle = K.bg;
        c.fillRect(sxp - lp2 * S.adv * 1.4, cy - lp2 * 0.42, lp2 * S.adv * 2.8, lp2 * 0.84);
        c.fillStyle = K.wood;
        label(c, '(@)', sxp, cy, lp2, 800);
        textMode(c, px, 700);
      } else if (d.k === 'rock') {
        c.fillStyle = K.rock;
        for (var xx = d.x + CW * 0.6; xx < d.x + d.a - CW * 0.3; xx += CW) {
          var top2 = groundY(w, xx) - ROW_M * 0.45;
          for (var yy = top2; yy > d.y + 0.05; yy -= ROW_M * 0.75) g1(c, (Math.round(xx * 7 + yy * 3) & 1) ? '#' : '%', V.ox + xx * ppm, V.oy - yy * ppm, px * 0.85);
        }
      }
    }
  }

  // ---- pickups (endless) ----
  var COIN_SPIN = ['O', '0', 'o', '|', 'o', '0'];
  function drawItems(c, w) {
    var it = w.items, ppm = V.ppm, px = 0.5 * ppm / S.adv * 0.62, K = S.col, ph = S.time * 9;
    textMode(c, px, 800);
    for (var i = 0; i < it.length; i++) {
      var o = it[i];
      if (o.x > V.x1 + 1) break;
      if (!o.on || o.x < V.x0 - 1) continue;
      var sxp = V.ox + o.x * ppm, syp = V.oy - o.y * ppm + Math.sin(ph * 0.4 + o.x) * 2;
      if (o.k) {
        c.fillStyle = K.text;
        g1(c, '[', sxp - px * S.adv, syp, px); g1(c, ']', sxp + px * S.adv, syp, px);
        c.fillStyle = K.accent; g1(c, 'F', sxp, syp, px);
        c.fillStyle = K.muted; g1(c, '_', sxp + px * S.adv * 0.4, syp - px * 1.05, px);
      } else {
        c.fillStyle = K.coin;
        g1(c, COIN_SPIN[((Math.floor(ph + o.x * 1.7) % 6) + 6) % 6], sxp, syp, px);
      }
    }
  }

  // ---- the bike, the rider and the ghost ----
  var POSE = new Float64Array(12), BP = new Float64Array(32);
  var _ca = 1, _sa = 0, _bx = 0, _by = 0;
  // chassis-local point → screen (into BP[i*2], BP[i*2+1])
  function lp(i, lx, ly) {
    BP[i * 2] = V.ox + (_bx + _ca * lx - _sa * ly) * V.ppm;
    BP[i * 2 + 1] = V.oy - (_by + _sa * lx + _ca * ly) * V.ppm;
  }
  function dirGlyph(dx, dy, thick) {             // screen-space direction → glyph
    var ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
    if (ay < ax * 0.42) return thick ? '=' : '-';
    if (ay > ax * 2.4) return '|';
    return (dx > 0) === (dy < 0) ? '/' : '\\';
  }
  function chain(c, x0, y0, x1, y1, step, px, thick) {
    var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy), n = Math.max(1, Math.round(len / step));
    var ch = dirGlyph(dx, dy, thick), off = OFF[ch] * px;
    // glyphs sit in the middle of equal sub-segments: strokes meeting at a joint never overprint
    for (var j = 0; j < n; j++) c.fillText(ch, x0 + dx * (j + 0.5) / n, y0 + dy * (j + 0.5) / n + off);
  }
  function seg(c, a, b, step, px, thick) { chain(c, BP[a * 2], BP[a * 2 + 1], BP[b * 2], BP[b * 2 + 1], step, px, thick); }
  // A wheel: a ring of tread glyphs that turns with the wheel, and two spokes
  // drawn with the glyph that matches their angle ( - / | \ ), spinner-style.
  var TREAD = ['o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.'];
  function drawWheel(c, x, y, th, ppm, color, hubColor, simple) {
    var r = E.WR * ppm * 0.82, px = Math.max(7, 0.25 * ppm), n = simple ? 8 : 12, j;
    textMode(c, px, 700);
    c.fillStyle = color;
    for (j = 0; j < n; j++) {
      var a = th + j * TAU / n;
      g1(c, simple ? 'o' : TREAD[j], x + Math.cos(a) * r, y - Math.sin(a) * r, px);
    }
    if (simple) return;
    c.fillStyle = hubColor;
    var ca = Math.cos(th), sa = Math.sin(th), ch1 = dirGlyph(ca, -sa), ch2 = dirGlyph(-sa, -ca), h = r * 0.5;
    g1(c, ch1, x + ca * h, y - sa * h, px); g1(c, ch1, x - ca * h, y + sa * h, px);
    g1(c, ch2, x - sa * h, y - ca * h, px); g1(c, ch2, x + sa * h, y + ca * h, px);
    g1(c, '+', x, y, px);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Bike glyph layout (chassis-local metres): frame line, fork, swing-arm,
  // engine block; the rider is five glyph strokes and a helmet.
  function drawBike(c, w, al) {
    var C = w.c, K = S.col, ppm = V.ppm, crashed = w.state === 'crash' || w.state === 'over';
    var ang = lerp(C.pa, C.a, al);
    _ca = Math.cos(ang); _sa = Math.sin(ang); _bx = lerp(C.px, C.x, al); _by = lerp(C.py, C.y, al);
    var rw = w.wh[0], fw = w.wh[1];
    var rx = V.ox + lerp(rw.px, rw.x, al) * ppm, ry = V.oy - lerp(rw.py, rw.y, al) * ppm;
    var fx = V.ox + lerp(fw.px, fw.x, al) * ppm, fy = V.oy - lerp(fw.py, fw.y, al) * ppm;
    var px = Math.max(8, 0.31 * ppm), step = px * S.adv * 0.92;
    drawWheel(c, rx, ry, lerp(rw.pth, rw.th, al), ppm, K.wheel, K.muted, false);
    drawWheel(c, fx, fy, lerp(fw.pth, fw.th, al), ppm, K.wheel, K.muted, false);
    textMode(c, px, 700);
    lp(0, -0.06, -0.16);    // swing-arm pivot
    lp(1, -0.90, 0.47);     // tail
    lp(2, 0.06, 0.50);      // seat front
    lp(3, 0.47, 0.60);      // steering head
    lp(4, 0.36, 0.86);      // bars
    BP[14] = rx; BP[15] = ry; BP[16] = fx; BP[17] = fy;   // 7 rear axle, 8 front axle
    c.fillStyle = K.frameLo;
    seg(c, 0, 7, step, px, true);                         // swing-arm
    seg(c, 3, 8, step, px, false);                        // fork
    c.fillStyle = K.frame;
    seg(c, 1, 2, step, px, true);                         // seat
    seg(c, 2, 3, step, px, true);                         // tank
    seg(c, 3, 4, step * 0.8, px, false);                  // bars
    c.fillStyle = K.muted;                                // engine block [#]
    lp(5, -0.14, 0.04); g1(c, '[', BP[10], BP[11], px);
    lp(5, 0.04, 0.04); g1(c, '#', BP[10], BP[11], px);
    lp(5, 0.22, 0.04); g1(c, ']', BP[10], BP[11], px);
    // rider (posed on the bike, or the ragdoll after a crash)
    if (crashed) {
      var R = w.rag, Pp = w.ragP;
      for (var i = 0; i < E.RAG_N; i++) {
        BP[18 + i * 2] = V.ox + lerp(Pp[i * 2], R[i * 4], al) * ppm;
        BP[19 + i * 2] = V.oy - lerp(Pp[i * 2 + 1], R[i * 4 + 1], al) * ppm;
      }
    } else {
      E.riderPose(lerp(w.plean, w.lean, al), POSE);
      for (var j = 0; j < 6; j++) lp(9 + j, POSE[j * 2], POSE[j * 2 + 1]);
    }
    // joints: 9 head, 10 shoulder, 11 hip, 12 hand, 13 knee, 14 foot
    c.fillStyle = K.rider;
    seg(c, 11, 13, step, px, false);                      // thigh
    seg(c, 13, 14, step, px, false);                      // shin
    seg(c, 10, 11, step, px, false);                      // torso
    seg(c, 10, 12, step, px, false);                      // arm
    var hp = px * 1.45;
    textMode(c, hp, 800);
    c.fillStyle = K.frame;
    g1(c, crashed ? 'X' : 'O', BP[18], BP[19], hp);       // helmet
  }
  function drawGhost(c, w) {
    var gd = S.ghost;
    if (!gd || !S.save.ghost || w.mode !== 'stage' || w.state === 'ready') return;
    var f = w.t / E.GHOST_DT, i = Math.floor(f), n = gd.length / 3;
    if (i >= n - 1) return;
    var t = f - i, o = i * 3;
    var gx = lerp(gd[o], gd[o + 3], t), gy = lerp(gd[o + 1], gd[o + 4], t), ga = lerp(gd[o + 2], gd[o + 5], t);
    if (gx < V.x0 - 3 || gx > V.x1 + 3) return;
    var ppm = V.ppm, px = Math.max(8, 0.31 * ppm), step = px * S.adv * 0.92;
    _ca = Math.cos(ga); _sa = Math.sin(ga); _bx = gx; _by = gy;
    c.globalAlpha = 0.6;
    lp(7, E.SUS_AX[0] + E.SUS_DX[0] * E.SUS_STAT[0], E.SUS_AY[0] + E.SUS_DY[0] * E.SUS_STAT[0]);
    lp(8, E.SUS_AX[1] + E.SUS_DX[1] * E.SUS_STAT[1], E.SUS_AY[1] + E.SUS_DY[1] * E.SUS_STAT[1]);
    drawWheel(c, BP[14], BP[15], 0, ppm, S.col.ghost, S.col.ghost, true);
    drawWheel(c, BP[16], BP[17], 0, ppm, S.col.ghost, S.col.ghost, true);
    textMode(c, px, 700);
    c.fillStyle = S.col.ghost;
    E.riderPose(0, POSE);
    lp(0, -0.06, -0.16); lp(1, -0.90, 0.47); lp(2, 0.06, 0.50); lp(3, 0.47, 0.60);
    for (var j = 0; j < 6; j++) lp(9 + j, POSE[j * 2], POSE[j * 2 + 1]);
    seg(c, 1, 2, step, px, true); seg(c, 2, 3, step, px, true); seg(c, 0, 7, step, px, true); seg(c, 3, 8, step, px, false);
    seg(c, 10, 11, step, px, false); seg(c, 10, 12, step, px, false); seg(c, 11, 13, step, px, false);
    textMode(c, px * 1.45, 800);
    g1(c, 'O', BP[18], BP[19], px * 1.45);
    c.globalAlpha = 1;
  }
  // ---- dust kicked up by the rear wheel (render-side only) ----
  var DN = 28, DX = new Float32Array(DN), DY = new Float32Array(DN), DVX = new Float32Array(DN), DVY = new Float32Array(DN), DL = new Float32Array(DN), DUST = ['.', ',', '\'', '`', '.'];
  var dustI = 0, dustAcc = 0;
  function fxStep(w, dt) {
    for (var i = 0; i < DN; i++) if (DL[i] > 0) { DL[i] -= dt; DX[i] += DVX[i] * dt; DY[i] += DVY[i] * dt; DVY[i] -= 5 * dt; }
    var rw = w.wh[0];
    if (S.rm || w.state !== 'ride' || !w.inGas || !rw.touch) return;
    var sp = Math.abs(w.c.vx);
    dustAcc += dt * (10 + sp * 2.2);
    while (dustAcc > 1) {
      dustAcc -= 1;
      var k = dustI++ % DN, g = S.rng;
      DX[k] = rw.x - 0.2 + (E.rnd(g) - 0.5) * 0.3; DY[k] = rw.y - E.WR * 0.8;
      DVX[k] = -w.c.vx * 0.25 - 0.5 - E.rnd(g) * 1.2; DVY[k] = 0.6 + E.rnd(g) * 1.8 + sp * 0.04; DL[k] = 0.35 + E.rnd(g) * 0.35;
    }
  }
  function drawDust(c) {
    var ppm = V.ppm, px = CW * ppm / S.adv;
    textMode(c, px, 700);
    c.fillStyle = S.col.edge;
    for (var i = 0; i < DN; i++) {
      if (DL[i] <= 0) continue;
      c.globalAlpha = Math.min(1, DL[i] * 2.4);
      g1(c, DUST[i % 5], V.ox + DX[i] * ppm, V.oy - DY[i] * ppm, px);
    }
    c.globalAlpha = 1;
  }

  // ---- HUD (digits drawn one glyph at a time: no per-frame strings) ----
  var DIG = '0123456789';
  // draws |v| with `dec` decimals right-aligned at x; returns the left edge
  function num(c, v, dec, x, y, px) {
    var adv = px * S.adv, m = dec === 2 ? 100 : dec === 1 ? 10 : 1, n = Math.round(Math.abs(v) * m), d = 0;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    do {
      if (dec && d === dec) { x -= adv; if (HALO) c.strokeText('.', x + adv / 2, y); c.fillText('.', x + adv / 2, y); }
      x -= adv;
      if (HALO) c.strokeText(DIG.charAt(n % 10), x + adv / 2, y);
      c.fillText(DIG.charAt(n % 10), x + adv / 2, y);
      n = Math.floor(n / 10); d++;
    } while (n > 0 || d <= dec);
    return x;
  }
  // same, left-aligned at x
  function numL(c, v, dec, x, y, px) {
    var m = dec === 2 ? 100 : dec === 1 ? 10 : 1, n = Math.round(Math.abs(v) * m), d = 1;
    while (n >= 10) { n = Math.floor(n / 10); d++; }
    if (d < dec + 1) d = dec + 1;
    var right = x + (d + (dec ? 1 : 0)) * px * S.adv;
    num(c, v, dec, right, y, px);
    return right;
  }
  var POPS = [], POP_N = 4;
  function pop(s, kind) {
    if (!S) return;
    var p = POPS.length < POP_N ? {} : POPS.shift();
    p.s = s; p.t = 0; p.life = kind === 'big' ? 1.6 : 1.25; p.kind = kind || '';
    POPS.push(p);
  }
  function drawHud(c, w) {
    var K = S.col, W = S.W, H = S.H, px = clamp(H * 0.05, 11, 16), adv = px * S.adv, pad = 10, y = pad + px * 0.6, x;
    HALO = true; c.strokeStyle = K.bg; c.lineWidth = 3.5; c.lineJoin = 'round';
    c.font = font(px * 1.25, 800); c.fillStyle = K.text;
    if (w.mode === 'stage') {
      var tShow = Math.max(0, w.state === 'finish' ? w.final : w.t - w.bonus);
      numL(c, tShow, 2, pad, y, px * 1.25);
      c.font = font(px * 0.82, 600); c.fillStyle = K.muted;
      label(c, S.hudSub, pad, y + px * 1.2, px * 0.82, 600, 'left');
      // progress: [=====>------]
      var cells = Math.max(8, Math.min(24, Math.floor((W - 2 * pad) * 0.42 / (px * 0.8 * S.adv)))), cw = px * 0.8 * S.adv;
      var span = w.finishX, f = clamp(w.c.x / span, 0, 1), bx = W - pad - cells * cw, pos = Math.round(f * (cells - 1));
      textMode(c, px * 0.8, 700);
      c.fillStyle = K.muted;
      g1(c, '[', bx - cw * 0.5, y, px * 0.8); g1(c, ']', bx + cells * cw + cw * 0.5 - cw, y, px * 0.8);
      for (var k = 0; k < cells - 1; k++) {
        var cx = bx + k * cw + cw * 0.5, cpk = false;
        for (var q = 0; q < w.cps.length; q++) if (Math.round(w.cps[q] / span * (cells - 1)) === k) cpk = true;
        c.fillStyle = k < pos ? K.accent : cpk ? K.muted : K.faint;
        g1(c, k === pos ? '>' : cpk ? '+' : k < pos ? '=' : '-', cx, y, px * 0.8);
      }
      label(c, S.hudStage, W - pad, y + px * 1.2, px * 0.82, 600, 'right');
    } else {
      x = numL(c, Math.floor(w.dist), 0, pad, y, px * 1.25);
      label(c, 'm', x + adv * 0.3, y, px * 0.9, 700, 'left');
      c.fillStyle = K.muted;
      label(c, S.hudSub, pad, y + px * 1.2, px * 0.82, 600, 'left');
      // coins
      c.fillStyle = K.muted;
      label(c, 'coins', W - pad, y, px * 0.82, 600, 'right');
      c.fillStyle = K.coin; c.font = font(px * 1.25, 800);
      num(c, w.coins, 0, W - pad - px * 0.82 * S.adv * 6, y, px * 1.25);
      // fuel gauge
      var low = w.fuel < 0.22, blink = low && (Math.floor(S.time * 4) & 1);
      c.fillStyle = low ? K.accent : K.muted;
      label(c, 'FUEL', W - pad - 11 * px * 0.75 * S.adv, y + px * 1.25, px * 0.75, 700, 'right');
      textMode(c, px * 0.75, 700);
      for (k = 0; k < 10; k++) {
        c.fillStyle = k < Math.ceil(w.fuel * 10) ? (blink ? K.faint : low ? K.accent : K.text) : K.faint;
        g1(c, k < Math.ceil(w.fuel * 10) ? '#' : '-', W - pad - (10 - k) * px * 0.75 * S.adv + px * 0.37 * S.adv, y + px * 1.25, px * 0.75);
      }
    }
    HALO = false;
    // pop-ups: live ones stack from the top, under the HUD
    for (var i = 0, row = 0; i < POPS.length; i++) {
      var p = POPS[i], a = 1 - p.t / p.life;
      if (a <= 0) continue;
      var big = p.kind === 'big', sc = S.rm ? 1 : 1 + 0.35 * Math.max(0, 1 - p.t / 0.12);
      c.globalAlpha = Math.min(1, a * 2.2);
      c.fillStyle = p.kind === 'bad' ? K.text : K.accent;
      var py = Math.max(px * 3.6, H * 0.2) + row * px * 1.45 - (S.rm ? 0 : p.t * 8);
      row++;
      c.font = font(Math.min(px * (big ? 1.35 : 1), (W - 16) / (p.s.length * S.adv)) * sc, 800); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeStyle = K.bg; c.lineWidth = 4; c.lineJoin = 'round';
      c.strokeText(p.s, W / 2, py); c.fillText(p.s, W / 2, py);
    }
    c.globalAlpha = 1;
    if (w.state === 'ready' && !S.ovlKind) drawReady(c, w, px);
  }
  // The start card sits in the open dirt under the bike (never over the rider),
  // or under the HUD when the canvas is too short; text shrinks to fit.
  function drawReady(c, w, px) {
    var K = S.col, W = S.W, H = S.H, lines = S.readyLines, n = lines.length, len = 0, i;
    for (i = 0; i < n; i++) len = Math.max(len, lines[i].length * (i === 0 ? 1.08 : 1));
    var fp = Math.min(px * 0.95, (W - 40) / (len * S.adv));
    var gy = V.oy - E.heightAt(w.ter, w.c.x) * V.ppm, fit = (H - 6 - gy) / ((n + 0.4) * 1.45 + 0.8), by;
    if (fit >= 9) { fp = Math.min(fp, fit); by = gy + fp * 0.8; }
    var lh = fp * 1.45, bw = Math.min(W - 16, len * fp * S.adv + fp * 3), bh = lh * (n + 0.4), bx = (W - bw) / 2;
    if (fit < 9) by = Math.max(px * 3.2, gy - 2.4 * V.ppm - bh);
    c.fillStyle = K.bgA; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = K.accent; c.lineWidth = 1; c.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    for (i = 0; i < n; i++) {
      c.fillStyle = i === 0 ? K.text : i === n - 1 ? K.accent : K.muted;
      label(c, lines[i], W / 2, by + lh * (i + 0.7), i === 0 ? fp * 1.08 : fp, i === 0 || i === n - 1 ? 800 : 600);
    }
  }

  function draw(al) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, w = S.w || S.bgw, K = S.col, W = S.W, H = S.H;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = K.bg; c.fillRect(0, 0, W, H);
    if (!w) return;
    var cam = w.cam, a = al == null ? 1 : al;
    var cx = lerp(cam.px, cam.x, a), cy = lerp(cam.py, cam.y, a), z = lerp(cam.pz, cam.z, a), ppm = S.ppm / z;
    if (S.shake > 0 && !S.rm) { cx += (E.rnd(S.rng) - 0.5) * S.shake * 0.5; cy += (E.rnd(S.rng) - 0.5) * S.shake * 0.5; }
    V.ppm = ppm; V.ox = W / 2 - cx * ppm; V.oy = H / 2 + cy * ppm;
    V.x0 = cx - W / 2 / ppm; V.x1 = cx + W / 2 / ppm; V.y0 = cy - H / 2 / ppm; V.y1 = cy + H / 2 / ppm;
    drawSky(c, cx, cy);
    drawDecos(c, w, false);
    drawTerrain(c, w);
    drawDecos(c, w, true);
    if (w.mode === 'endless') drawItems(c, w);
    if (w === S.w) drawGhost(c, w);
    drawBike(c, w, a);
    if (w === S.w) { drawDust(c); drawHud(c, w); }
  }

  // ---- loop: runs only while a ride is live and visible ----
  function canRun() {
    return !!(S && S.w && !S.paused && !S.ovlKind && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)));
  }
  function anyInput() { var k = S.keys, p = S.pad; return !!(k.gas || k.brake || k.back || k.fwd || p.gas || p.brake || p.back || p.fwd); }
  function kick() { if (S && !S.raf && canRun()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function halt() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } if (S) S.snd.humStop(); }
  function applyInput() {
    var w = S.w, k = S.keys, p = S.pad;
    w.inGas = k.gas || p.gas ? 1 : 0;
    w.inBrake = k.brake || p.brake ? 1 : 0;
    w.inLean = (k.fwd || p.fwd ? 1 : 0) - (k.back || p.back ? 1 : 0);
  }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!canRun()) { S.snd.humStop(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    applyInput();
    var w = S.w, al = E.advance(w, dt);
    S.time += dt;
    S.shake = Math.max(0, S.shake - dt * 2);
    for (var i = 0; i < POPS.length; i++) POPS[i].t += dt;
    fxStep(w, dt);
    handleEvents();
    if (!S || S.w !== w) return;
    draw(al);
    engineSound(w);
    if (S.ovlKind) { S.snd.humStop(); return; }
    if (w.state === 'ready' && !anyInput()) { S.snd.humStop(); return; }   // idle at the start line: stop until a key
    S.raf = requestAnimationFrame(frame);
  }
  function engineSound(w) {
    var snd = S.snd;
    if (!snd.on || !snd.ac) return;
    if (w.state !== 'ride' && w.state !== 'finish') { snd.humStop(); return; }
    snd.humStart();
    var spin = Math.abs(w.wh[0].om - w.c.w);
    snd.humSet(42 + Math.min(150, spin * 2.1) + (w.inGas ? 18 : 0), w.inGas ? 0.05 : 0.025);
  }

  function handleEvents() {
    var w = S.w, ev = w.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'start': syncHead(); break;
        case 'crash':
          S.shake = 0.6;
          pop(w.why === 'gap' ? 'INTO THE GAP!' : 'CRASH!', 'bad');
          snd.tone(140, 0.3, 'square', 0.05, 50);
          Cade.haptic(30);
          break;
        case 'respawn': pop(w.cpX > 0 ? 'back to checkpoint' : 'back to the start'); break;
        case 'cp': pop('CHECKPOINT'); snd.tone(660, 0.08, 'triangle', 0.04); snd.tone(990, 0.1, 'triangle', 0.035, 0, 0.07); break;
        case 'flip': {
          var n = w.lastFlipN, nm = (n === 2 ? 'DOUBLE ' : n === 3 ? 'TRIPLE ' : n > 3 ? n + 'x ' : '') + (w.lastFlipDir > 0 ? 'BACKFLIP!' : 'FRONTFLIP!');
          pop(nm, 'big');
          pop(w.mode === 'stage' ? '-' + n + '.0s' : '+' + 5 * n + ' coins');
          [523, 659, 784, 1047].forEach(function (f, j) { snd.tone(f, 0.1, 'triangle', 0.04, 0, j * 0.06); });
          Cade.haptic(12);
          break;
        }
        case 'perfect': pop(w.mode === 'stage' ? 'PERFECT LANDING -0.25s' : 'PERFECT LANDING +2'); snd.tone(1175, 0.12, 'sine', 0.035); break;
        case 'finish': pop('FINISH!', 'big'); snd.tone(784, 0.12, 'triangle', 0.05); snd.tone(1175, 0.2, 'triangle', 0.045, 0, 0.1); break;
        case 'done': finishStage(); return;
        case 'over': endlessOver(); return;
        case 'coin': snd.tone(1320, 0.05, 'sine', 0.03); break;
        case 'fuel': pop('FUEL +100%'); snd.tone(523, 0.08, 'triangle', 0.04); snd.tone(784, 0.12, 'triangle', 0.04, 0, 0.06); break;
        case 'nofuel': pop('OUT OF FUEL', 'bad'); break;
      }
    }
    ev.length = 0;
  }

  // ---- runs ----
  function setView(w) { if (w && S && S.ppm) { w.viewW = S.W / S.ppm; w.viewH = S.H / S.ppm; } }
  function resetPops() { POPS.length = 0; for (var i = 0; i < DN; i++) DL[i] = 0; }
  function startStage(idx) {
    if (!S) return;
    halt();
    bankEndless();
    var w = E.newWorld({ stage: idx, up: S.save.up });
    w.rec = S.rec; w.recN = 0;
    setView(w); E.resetCam(w);
    S.w = w; S.paused = false; S.shake = 0; resetPops();
    var st = E.STAGES[idx], rec = S.save.st[idx + 1];
    S.hudStage = 'stage ' + (idx + 1) + '/' + E.STAGES.length;          // HUD strings: built once per run
    S.hudSub = rec ? 'best ' + fmtT(rec.t) : 'par ★★★ ' + fmtT(st.par[0]);
    S.ghost = null;
    var gs = sget(GHOST_KEY + (idx + 1));
    if (gs && rec) S.ghost = E.decodeGhost(gs);
    S.readyLines = ['STAGE ' + pad2(idx + 1) + ' · ' + st.name.toUpperCase(),
      '★★★ ' + fmtT(st.par[0]) + '   ★★ ' + fmtT(st.par[1]) + (rec ? '   best ' + fmtT(rec.t) : ''),
      S.touch ? 'hold GAS to ride' : 'hold → to ride'];
    showOverlay(null);
    draw(1);
    S.live.textContent = 'Stage ' + (idx + 1) + ', ' + st.name + '. ' + S.readyLines[2] + '.';
    kick();
  }
  function startEndless() {
    if (!S) return;
    halt();
    bankEndless();
    var seed = (Math.random() * 4294967296) >>> 0 || 1;
    var w = E.newWorld({ endless: true, seed: seed, up: S.save.up });
    setView(w); E.resetCam(w);
    S.w = w; S.paused = false; S.shake = 0; S.banked = false; resetPops();
    S.ghost = null;
    S.hudSub = 'best ' + S.save.eb + ' m';
    S.readyLines = ['ENDLESS · TRAIL #' + (seed % 100000), 'grab fuel cans [F] · coins buy upgrades', S.touch ? 'hold GAS to ride' : 'hold → to ride'];
    showOverlay(null);
    draw(1);
    kick();
  }
  function restart() {
    if (!S || !S.w) return;
    if (S.w.mode === 'endless') startEndless(); else startStage(S.w.stage);
  }
  // Endless coins go in the bank when the run ends (or the panel closes mid-run).
  function bankEndless() {
    if (!S || !S.w || S.w.mode !== 'endless' || S.banked) return;
    S.banked = true;
    if (S.w.coins > 0) { S.save.coins += S.w.coins; writeSave(); }
  }
  function finishStage() {
    var w = S.w, idx = w.stage, t = w.final, key = idx + 1, rec = S.save.st[key];
    var prevStars = rec ? rec.s : 0, stars = E.stars(idx, t), newBest = !rec || t < rec.t - 1e-6;
    var wasLast = !E.unlocked(S.save, idx + 1);
    if (newBest) {
      S.save.st[key] = { t: Math.round(t * 1000) / 1000, s: Math.max(stars, prevStars) };
      if (w.recN > 2) sset(GHOST_KEY + key, E.encodeGhost(w.rec, w.recN));
    } else if (stars > prevStars) rec.s = stars;
    var earned = Math.max(0, stars - prevStars) * STAR_COINS;
    S.save.coins += earned;
    writeSave();
    S.result = { idx: idx, t: t, stars: stars, newBest: newBest, prev: rec ? rec.t : null, earned: earned, flips: w.flips, crashes: w.crashes,
      unlocked: wasLast && idx + 1 < E.STAGES.length };
    showOverlay('result');
  }
  function endlessOver() {
    var w = S.w, d = Math.floor(w.dist), nb = d > S.save.eb;
    if (nb) S.save.eb = d;
    bankEndless();
    writeSave();
    S.result = { dist: d, newBest: nb, coins: w.coins, why: w.why, seed: w.seed, flips: w.flips };
    showOverlay('over');
  }

  // ---- pause (blur, hidden tab, minimize, P / Esc): never resumes by itself ----
  function pause() {
    if (!S) return;
    clearKeys();
    if (!S.w || S.paused || S.ovlKind) return;
    var st = S.w.state;
    if (st !== 'ride' && st !== 'crash' && st !== 'finish') { halt(); return; }
    S.paused = true;
    halt();
    showOverlay('pause');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showOverlay(null);
    kick();
  }
  function clearKeys() {
    if (!S) return;
    S.keys.gas = S.keys.brake = S.keys.back = S.keys.fwd = false;
    if (S.padCtl) S.padCtl.reset();
  }

  // ---- overlay screens (HTML over the canvas) ----
  var LOGO = ['    __o', '  _ \\<_', ' (@)/(@)'].join('\n');
  function btn(act, html, cls, extra) {
    return '<button type="button" class="uh-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' + (extra || '') + '>' + html + '</button>';
  }
  function controlsHtml() {
    if (S.touch) return '<div class="uh-help"><b>GAS</b> / <b>BRAKE</b> on the right, <b>LEAN</b> ◄ ► on the left — hold both. Lean back to wheelie and flip, forward to land. Keep your head off the dirt.</div>';
    return '<div class="uh-help"><kbd>→</kbd><kbd>↑</kbd> gas · <kbd>←</kbd><kbd>↓</kbd> brake / reverse · <kbd>A</kbd><kbd>Z</kbd> lean back · <kbd>D</kbd><kbd>X</kbd> lean forward · <kbd>R</kbd> restart · <kbd>P</kbd> pause<br>' +
      'Lean back to wheelie and flip, forward to land. Keep your head off the dirt.</div>';
  }
  function overlayHtml(kind) {
    var sv = S.save, i, h = '';
    if (kind === 'home') {
      var stars = E.totalStars(sv);
      return '<div class="uh-card uh-home"><pre class="uh-logo" aria-hidden="true">' + LOGO + '</pre>' +
        '<div class="uh-title">UPHILL RUSH</div>' +
        '<div class="uh-menu">' +
        btn('stages', '<span>▶ Stages</span><small>★ ' + stars + '/' + E.STAGES.length * 3 + '</small>', 'primary split') +
        btn('endless', '<span>∞ Endless</span><small>best ' + sv.eb + ' m</small>', 'split') +
        btn('garage', '<span>⚙ Garage</span><small>' + sv.coins + ' coins</small>', 'split') +
        '</div>' + controlsHtml() +
        '<div class="uh-toggles">' + btn('sound', 'sound: ' + (S.snd.on ? 'on' : 'off'), 'link' + (S.snd.on ? ' on' : ''), ' aria-pressed="' + S.snd.on + '"') +
        btn('ghost', 'ghost: ' + (sv.ghost ? 'on' : 'off'), 'link' + (sv.ghost ? ' on' : ''), ' aria-pressed="' + sv.ghost + '"') + '</div></div>';
    }
    if (kind === 'stages') {
      h = '<div class="uh-card uh-wide"><div class="uh-head">' + btn('home', '‹ back', 'link') + '<div class="uh-title sm">STAGES</div><span class="uh-sub">★ ' + E.totalStars(sv) + '/' + E.STAGES.length * 3 + '</span></div><div class="uh-grid">';
      for (i = 0; i < E.STAGES.length; i++) {
        var st = E.STAGES[i], r = sv.st[i + 1], open = E.unlocked(sv, i);
        h += '<button type="button" class="uh-tile' + (open ? '' : ' locked') + (r ? ' done' : '') + '" data-act="play" data-i="' + i + '"' + (open ? '' : ' disabled aria-disabled="true"') +
          ' title="' + esc(st.name) + (open ? '' : ' (finish stage ' + i + ' to unlock)') + '"><span class="uh-tn">' + pad2(i + 1) + '</span><span class="uh-tname">' + esc(st.name) + '</span>' +
          '<span class="uh-tstars">' + (open ? starStr(r ? r.s : 0) : 'locked') + '</span><span class="uh-tbest">' + (r ? fmtT(r.t) : open ? '—' : '') + '</span></button>';
      }
      return h + '</div></div>';
    }
    if (kind === 'garage') {
      h = '<div class="uh-card uh-wide"><div class="uh-head">' + btn('home', '‹ back', 'link') + '<div class="uh-title sm">GARAGE</div><span class="uh-sub">' + sv.coins + ' coins</span></div><div class="uh-ups">';
      for (i = 0; i < E.UPGRADES.length; i++) {
        var u = E.UPGRADES[i], lv = E.upLevel(sv.up, u.key), cost = lv < E.UP_MAX ? E.UP_COST[lv] : 0, bar = '';
        for (var j = 0; j < E.UP_MAX; j++) bar += j < lv ? '■' : '□';
        h += '<div class="uh-up"><div class="uh-up-t"><b>' + u.name + '</b> <span class="uh-lv" aria-label="level ' + lv + ' of ' + E.UP_MAX + '">' + bar + '</span><small>' + u.what + '</small></div>' +
          (lv >= E.UP_MAX ? '<span class="uh-max">MAX</span>' : btn('buy', cost + ' coins', sv.coins >= cost ? 'primary' : '', ' data-k="' + u.key + '"' + (sv.coins >= cost ? '' : ' disabled'))) + '</div>';
      }
      return h + '</div><div class="uh-note">Earn coins in Endless (pickups, flips, perfect landings) and ' + STAR_COINS + ' per new star in Stages.</div></div>';
    }
    if (kind === 'pause') {
      var w = S.w;
      return '<div class="uh-card"><div class="uh-title">PAUSED</div><div class="uh-sub">' +
        (w.mode === 'stage' ? 'stage ' + (w.stage + 1) + ' · ' + fmtT(Math.max(0, w.t - w.bonus)) : Math.floor(w.dist) + ' m · ' + w.coins + ' coins') + '</div>' +
        '<div class="uh-menu">' + btn('resume', 'Resume', 'primary') + btn('restart', 'Restart') + btn('menu', 'Menu') + '</div>' +
        '<div class="uh-note">' + (S.touch ? 'tap Resume when you are ready' : 'P / Enter to resume · R restart · Esc menu') + '</div></div>';
    }
    if (kind === 'result') {
      var R = S.result, stR = E.STAGES[R.idx], next = R.idx + 1 < E.STAGES.length;
      return '<div class="uh-card"><div class="uh-title">' + (R.newBest && R.prev != null ? 'NEW BEST!' : 'STAGE CLEAR') + '</div>' +
        '<div class="uh-sub">' + pad2(R.idx + 1) + ' · ' + esc(stR.name) + '</div>' +
        '<div class="uh-big">' + fmtT(R.t) + '</div><div class="uh-stars" aria-label="' + R.stars + ' of 3 stars">' + starStr(R.stars) + '</div>' +
        '<div class="uh-note">★★★ ' + fmtT(stR.par[0]) + ' · ★★ ' + fmtT(stR.par[1]) + (R.prev != null ? ' · best ' + fmtT(Math.min(R.prev, R.t)) : '') + '</div>' +
        '<div class="uh-note">' + R.flips + (R.flips === 1 ? ' flip' : ' flips') + ' · ' + R.crashes + (R.crashes === 1 ? ' crash' : ' crashes') +
        (R.earned ? ' · <b>+' + R.earned + ' coins</b>' : '') + (R.unlocked ? ' · stage ' + (R.idx + 2) + ' unlocked' : '') + '</div>' +
        '<div class="uh-menu row">' + (next ? btn('next', 'Next ▶', 'primary') : '') + btn('restart', 'Retry', next ? '' : 'primary') + btn('menu', 'Menu') + '</div></div>';
    }
    if (kind === 'over') {
      var O = S.result;
      return '<div class="uh-card"><div class="uh-title">' + (O.why === 'fuel' ? 'OUT OF FUEL' : 'CRASHED') + '</div>' +
        '<div class="uh-sub">trail #' + (O.seed % 100000) + '</div>' +
        '<div class="uh-big">' + O.dist + ' m</div>' + (O.newBest ? '<div class="uh-new">** new best **</div>' : '<div class="uh-note">best ' + S.save.eb + ' m</div>') +
        '<div class="uh-note">+' + O.coins + ' coins · ' + O.flips + (O.flips === 1 ? ' flip' : ' flips') + ' · ' + S.save.coins + ' in the bank</div>' +
        '<div class="uh-menu row">' + btn('again', 'Again ▶', 'primary') + btn('garage', 'Garage') + btn('menu', 'Menu') + '</div></div>';
    }
    return '';
  }
  function showOverlay(kind) {
    if (!S) return;
    S.ovlKind = kind;
    if (kind) { halt(); clearKeys(); }
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    syncHead();
    if (kind) {
      if (!S.w) { draw(1); }
      if (!S.touch) {
        var b = S.ovl.querySelector('.uh-btn.primary') || S.ovl.querySelector('button:not([disabled])');
        if (b) try { b.focus({ preventScroll: true }); } catch (e) {}
      }
      var t = S.ovl.querySelector('.uh-title');
      if (t) S.live.textContent = t.textContent;
    }
  }
  function toMenu() {
    if (!S) return;
    halt();
    bankEndless();
    S.paused = false;
    if (S.w) { S.bgw = S.w; S.w = null; }
    showOverlay('home');
  }
  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !S || b.disabled) return;
    S.snd.ensure();
    var act = b.getAttribute('data-act');
    switch (act) {
      case 'stages': showOverlay('stages'); break;
      case 'garage': showOverlay('garage'); break;
      case 'home': showOverlay('home'); break;
      case 'endless': case 'again': startEndless(); break;
      case 'play': startStage(+b.getAttribute('data-i') || 0); break;
      case 'next': if (S.result) startStage(Math.min(E.STAGES.length - 1, S.result.idx + 1)); break;
      case 'restart': restart(); break;
      case 'resume': resume(); break;
      case 'menu': toMenu(); break;
      case 'buy': {
        var k = b.getAttribute('data-k'), lv = E.upLevel(S.save.up, k), cost = E.UP_COST[lv];
        if (lv < E.UP_MAX && S.save.coins >= cost) {
          S.save.coins -= cost; S.save.up[k] = lv + 1; writeSave();
          S.snd.tone(880, 0.08, 'triangle', 0.04); S.snd.tone(1320, 0.12, 'triangle', 0.035, 0, 0.07);
          showOverlay('garage');
        }
        break;
      }
      case 'sound':
        S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        showOverlay(S.ovlKind);
        break;
      case 'ghost': S.save.ghost = !S.save.ghost; writeSave(); showOverlay(S.ovlKind); break;
    }
  }

  // ---- header buttons (before the core Minimize) ----
  function hsvg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_RESTART = hsvg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>');
  var IC_PAUSE = hsvg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = hsvg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_MENU = hsvg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  function syncHead() {
    if (!S || !S.hb) return;
    var w = S.w, live = !!w && !S.ovlKind && (w.state === 'ride' || w.state === 'crash' || w.state === 'finish');
    var pb = S.hb.querySelector('[data-h="pause"]'), rb = S.hb.querySelector('[data-h="restart"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !(S.paused || live);
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    rb.disabled = !w;
  }

  // ---- input: keyboard ----
  var KEYMAP = {
    ArrowRight: 'gas', ArrowUp: 'gas', KeyW: 'gas',
    ArrowLeft: 'brake', ArrowDown: 'brake', KeyS: 'brake',
    KeyA: 'back', KeyZ: 'back', KeyD: 'fwd', KeyX: 'fwd'
  };
  var KEY2CODE = { arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowdown: 'ArrowDown', w: 'KeyW', s: 'KeyS', a: 'KeyA', z: 'KeyZ', d: 'KeyD', x: 'KeyX', r: 'KeyR', p: 'KeyP', m: 'KeyM', escape: 'Escape', enter: 'Enter', ' ': 'Space' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;    // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var code = keyCode(e), act = KEYMAP[code];
    if (act) {
      e.preventDefault();
      if (!S.w || S.ovlKind) return;
      if (!S.keys[act]) { S.keys[act] = true; S.snd.ensure(); kick(); }
      return;
    }
    if (code === 'KeyR') { e.preventDefault(); if (!e.repeat && S.w) restart(); return; }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'KeyM') { e.preventDefault(); if (!e.repeat) { S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0'); S.snd.ensure(); if (!S.snd.on) S.snd.humStop(); if (S.ovlKind === 'home') showOverlay('home'); } return; }
    if (code === 'Escape') {
      e.preventDefault();
      if (S.paused) toMenu();
      else if (S.w && !S.ovlKind && S.w.state !== 'ready') pause();
      else if (S.ovlKind === 'stages' || S.ovlKind === 'garage') showOverlay('home');
      else if (S.ovlKind === 'home') closePanel();
      else toMenu();
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      var onBtn = t && t.tagName === 'BUTTON' && S.panel.contains(t);
      if (onBtn) return;                                        // the focused button clicks itself
      e.preventDefault();
      if (e.repeat) return;
      if (S.paused) { resume(); return; }
      if (S.ovlKind) { var b = S.ovl.querySelector('.uh-btn.primary'); if (b) b.click(); }
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var act = KEYMAP[keyCode(e)];
    if (act && S.keys[act]) { S.keys[act] = false; }
  }

  // ---- input: multi-touch pads. Each pointer is tracked by id and re-hit-tested
  // as it moves, so a thumb can rock between BRAKE and GAS without lifting, and
  // both thumbs work at once (gas + lean). ----
  function bindPads(root) {
    var owner = {}, btns = Array.prototype.slice.call(root.querySelectorAll('[data-k]')), rects = [];
    function measure() { rects = btns.map(function (b) { return { k: b.getAttribute('data-k'), r: b.getBoundingClientRect() }; }); }
    function keyAt(x, y) {
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i].r;
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 10 && y <= r.bottom + 10) return rects[i].k;
      }
      return null;
    }
    function sync() {
      var held = { gas: false, brake: false, back: false, fwd: false };
      for (var id in owner) if (owner[id]) held[owner[id]] = true;
      btns.forEach(function (b) { b.classList.toggle('on', !!held[b.getAttribute('data-k')]); });
      if (!S) return;
      S.pad.gas = held.gas; S.pad.brake = held.brake; S.pad.back = held.back; S.pad.fwd = held.fwd;
      if (anyInput()) kick();
    }
    function down(e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!S.w || S.ovlKind) return;
      measure();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
      owner[e.pointerId] = keyAt(e.clientX, e.clientY);
      sync();
    }
    function move(e) {
      if (!(e.pointerId in owner)) return;
      var k = keyAt(e.clientX, e.clientY);
      if (k !== owner[e.pointerId]) { owner[e.pointerId] = k; sync(); }
    }
    function up(e) { if (e.pointerId in owner) { delete owner[e.pointerId]; sync(); } if (S) S.snd.ensure(); }
    var pads = root.querySelectorAll('.uh-pad');
    for (var i = 0; i < pads.length; i++) {
      pads[i].addEventListener('pointerdown', down);
      pads[i].addEventListener('pointermove', move);
      pads[i].addEventListener('pointerup', up);
      pads[i].addEventListener('pointercancel', up);
      pads[i].addEventListener('lostpointercapture', up);
      pads[i].addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
    return { reset: function () { owner = {}; sync(); } };
  }

  // ---- layout ----
  function safeBottom() {
    var d = document.createElement('div'), v = 0;
    d.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)';
    document.body.appendChild(d);
    try { v = parseFloat(getComputedStyle(d).paddingBottom) || 0; } catch (e) {}
    d.remove();
    return v;
  }
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var narrow = vw < 600, float = S.touch && vw > vh && vh < 560;
    S.float = float;
    S.root.classList.toggle('uh-float', float);
    S.root.classList.toggle('uh-touch', S.touch);
    var pw = narrow ? vw - 16 : Math.min(float ? 960 : 820, vw - 32);
    S.panel.style.width = pw + 'px';
    var body = S.panel.querySelector('.cade-panel-body'), bs = body ? getComputedStyle(body) : null;
    var padX = bs ? (parseFloat(bs.paddingLeft) || 0) + (parseFloat(bs.paddingRight) || 0) : 16;
    var padY = bs ? (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0) : 16;
    var cw = Math.max(200, Math.floor(pw - 2 - padX));
    var r = S.panel.getBoundingClientRect(), top = r.height ? Math.max(0, Math.min(r.top, 160)) : (narrow ? 48 : 52);
    var head = S.head ? S.head.offsetHeight : 36;
    var extra = 0;
    if (S.touch && !float) extra += (S.padsEl.offsetHeight || 72) + 8;
    if (!S.touch) extra += (S.bar.offsetHeight || 22) + 8;
    var avail = vh - top - head - padY - extra - 8 - S.safeB;
    var ch = float ? avail : narrow ? Math.round(cw * 0.8) : Math.round(cw * 0.54);
    ch = Math.max(170, Math.min(ch, avail));
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stageEl.style.width = cw + 'px'; S.stageEl.style.height = ch + 'px';
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.W = cw; S.H = ch; S.k = S.cv.width / cw;
    S.ppm = clamp(narrow ? Math.min(cw / 9.2, ch / 7) : Math.min(cw / 13, ch / 7.5), 18, 72);
    setView(S.w); setView(S.bgw);
    if (S.col) buildTiles();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    bankEndless();
    var s = S;
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    clearTimeout(s.resizeT);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    s.w = s.bgw = null; s.rec = null; s.ghost = null; s.tileCv = null; s.dirtPat = null;
    POPS.length = 0;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!coarse()) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (Cade.isMinimized && Cade.isMinimized(existing)) { Cade.restorePanel(existing); return; }
      closePanel();
      return;
    }
    var touch = coarse();
    var body = '<div class="uh' + (touch ? ' uh-touch' : '') + '">' +
      '<div class="uh-stage"><canvas class="uh-cv" role="img" aria-label="Uphill Rush — dirt-bike game"></canvas></div>' +
      '<div class="uh-pads" aria-hidden="true">' +
        '<div class="uh-pad uh-pad-l"><div class="uh-pk" data-k="back"><span class="uh-ar">◄</span><small>LEAN</small></div><div class="uh-pk" data-k="fwd"><span class="uh-ar">►</span><small>LEAN</small></div></div>' +
        '<div class="uh-pad uh-pad-r"><div class="uh-pk" data-k="brake"><b>BRAKE</b></div><div class="uh-pk uh-gas" data-k="gas"><b>GAS</b></div></div>' +
      '</div>' +
      '<div class="uh-bar"><span><kbd>→</kbd> gas <kbd>←</kbd> brake <kbd>A</kbd><kbd>D</kbd> lean <kbd>R</kbd> restart <kbd>P</kbd> pause <kbd>M</kbd> sound</span></div>' +
      '<div class="uh-ovl" style="display:none"></div><div class="uh-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🏍️ Uphill Rush', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var hb = document.createElement('div');
    hb.className = 'uh-hbtns';
    hb.innerHTML = '<button type="button" class="uh-hb" data-h="restart" title="Restart (R)" aria-label="Restart (R)">' + IC_RESTART + '</button>' +
      '<button type="button" class="uh-hb" data-h="pause" title="Pause (P)" aria-label="Pause (P)">' + IC_PAUSE + '</button>' +
      '<button type="button" class="uh-hb" data-h="menu" title="Menu (Esc)" aria-label="Menu (Esc)">' + IC_MENU + '</button>';
    var head = p.querySelector('.cade-panel-head');
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var soundOn = sget(SOUND_KEY) === '1';
    S = {
      panel: p, root: p.querySelector('.uh'), stageEl: p.querySelector('.uh-stage'), cv: p.querySelector('.uh-cv'), ovl: p.querySelector('.uh-ovl'),
      padsEl: p.querySelector('.uh-pads'), bar: p.querySelector('.uh-bar'), live: p.querySelector('.uh-live'), head: head, hb: hb,
      touch: touch, rm: reduced(), safeB: touch ? safeBottom() : 0, snd: new Snd(soundOn), save: loadSave(),
      w: null, bgw: null, rec: new Float32Array(REC_CAP * 3), ghost: null, result: null,
      keys: { gas: false, brake: false, back: false, fwd: false }, pad: { gas: false, brake: false, back: false, fwd: false },
      raf: 0, last: 0, time: 0, paused: false, ovlKind: null, shake: 0, rng: { s: 12345 }, banked: true,
      hudStage: '', hudSub: '', readyLines: [], fonts: {}, k: 1, W: 300, H: 200, ppm: 30
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    S.bgw = E.newWorld({ stage: 0 });
    layout();
    readTheme();
    setView(S.bgw); E.resetCam(S.bgw);

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    // Minimized to the dock: pause like a tab switch and stop drawing; the pause
    // card waits for the player after restore (never auto-resumes).
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause();
      halt();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      layout(); draw(1);
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S) { layout(); draw(1); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); draw(1); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.padCtl = bindPads(S.padsEl);
    S.ovl.addEventListener('click', onOverlayClick);
    S.cv.addEventListener('pointerdown', function (e) { e.preventDefault(); if (S) S.snd.ensure(); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });     // the header drags; these are controls
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-h]') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var h = b.getAttribute('data-h');
      if (h === 'restart') restart();
      else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'menu') { if (S.ovlKind === 'home') { if (S.w) resume(); } else toMenu(); }
      try { b.blur(); } catch (er) {}
    });
    showOverlay('home');
    // The glyph grid is fitted to the mono font's advance: refit once it has loaded.
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); draw(1); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: 'Uphill Rush',
    description: 'ASCII dirt-bike stunts — 12 stages, endless mode, flips and upgrades',
    icon: '🏍️',
    tags: 'game,arcade,fun,train,bike,motorbike,motocross,dirt bike,hill climb,moto,racing,physics,stunts,flip,endless',
    open: open
  });
})();
