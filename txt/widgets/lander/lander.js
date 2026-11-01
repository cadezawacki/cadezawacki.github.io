/* Lunar Lander — thrust and rotate onto the pads, for Cade.txt.
 * A little ASCII lander drops over jagged moonscape. Rotate (← → / A D, the
 * pad's arrow buttons, a gamepad stick, or tilt the phone) and fire the main
 * engine (↑ / W / Space, the big THRUST button, a trigger) to set it down on
 * one of the flat pads: slow vertically, slow sideways and level. Narrow pads
 * pay more (x2 … x5); fuel is finite (canisters [F] float over the crags).
 * Every touchdown is graded PERFECT / GREAT / GOOD / HARD.
 * Modes: a 12-level campaign (gravity, wind, gusts and terrain get harsher),
 * Endless (three hulls, fuel carries over, sorties get harder) and Duel — the
 * same five sorties flown by two players taking turns on one device, or
 * against a CPU autopilot (Rookie / Pilot / Ace).
 * Drawn as monospace glyphs from a cached atlas on a canvas; the world wraps
 * horizontally. Physics runs on a fixed 120 Hz step with an accumulator and
 * the renderer interpolates (smooth at 60 and 120 Hz); the camera zooms in as
 * the ground comes up. The loop runs only while a flight is on screen; it
 * pauses on blur, tab hide and minimize. Progress persists in Cade.store
 * (cade-lander-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: metres and seconds. x → right (wraps every WORLD_W), y → up.
  // Angle a: 0 = upright, positive = nose tilted right (clockwise on screen);
  // the main engine pushes along (sin a, cos a).
  var STEP = 1 / 120;
  var THRUST = 5.4;                     // main engine, m/s² at full throttle
  var ROT = 2.3, ROT_TAU = 0.07;         // rotation rate (rad/s) and its ease-in time
  var BURN = 22, ROT_BURN = 1.0;         // fuel per second: main engine at full, attitude jets
  var WORLD_W = 1600, NPTS = 128, DX = WORLD_W / NPTS;
  var VY_SAFE = 3.2, VX_SAFE = 2.0, ANG_SAFE = 0.21;   // touchdown limits (m/s, m/s, rad ≈ 12°)
  var FOOT_X = 3, FOOT_Y = -3.4;                       // feet, relative to the lander's centre
  var WIND_A = 0.06;                                   // wind strength → m/s²
  var CAN_R = 7, CAN_FUEL = 240;
  var REF_H = 288, VIEW_W = 384, ZMIN = 0.55, ZMAX = 3.4;
  // The hull (convex, local coords, counter-clockwise) and the points checked against the ground.
  var HULL = [[-FOOT_X, FOOT_Y], [FOOT_X, FOOT_Y], [2.3, 2.4], [0, 3.8], [-2.3, 2.4]];
  var PROBES = [[-FOOT_X, FOOT_Y, 1], [FOOT_X, FOOT_Y, 1], [-2.6, -0.6, 0], [2.6, -0.6, 0], [-2.3, 2.4, 0], [2.3, 2.4, 0], [0, 3.8, 0], [0, -2.2, 0]];
  var GRADES = [
    { id: 'S', name: 'PERFECT', q: 0.35, mult: 3 },
    { id: 'A', name: 'GREAT', q: 0.6, mult: 2 },
    { id: 'B', name: 'GOOD', q: 0.85, mult: 1.5 },
    { id: 'C', name: 'HARD', q: 1.0001, mult: 1 }
  ];
  var GRADE_RANK = { S: 4, A: 3, B: 2, C: 1 };
  var PAD_SEGS = { 1: 4, 2: 3, 3: 2, 5: 1 };            // pad width in terrain segments by multiplier

  // The campaign. g: gravity; wind/gust: wind strength (± sign = direction);
  // rough: terrain persistence; range: height of the crags; pads: multipliers.
  var LEVELS = [
    { name: 'First Light', g: 1.2, wind: 0, gust: 0, rough: 0.42, range: 110, pads: [1, 2, 3], fuel: 1000, vx: 0, cans: 0, alt: 150, seed: 11 },
    { name: 'Drift', g: 1.35, wind: 0, gust: 0, rough: 0.48, range: 140, pads: [1, 2, 3], fuel: 950, vx: 7, cans: 1, alt: 160, seed: 23 },
    { name: 'Crags', g: 1.5, wind: 0, gust: 0, rough: 0.6, range: 190, pads: [2, 3, 5], fuel: 950, vx: 5, cans: 1, alt: 150, seed: 37 },
    { name: 'Crosswind', g: 1.6, wind: 4, gust: 0, rough: 0.52, range: 160, pads: [1, 2, 3], fuel: 900, vx: 0, cans: 1, alt: 150, seed: 41 },
    { name: 'Pinpoint', g: 1.6, wind: 0, gust: 1.5, rough: 0.56, range: 170, pads: [3, 5], fuel: 850, vx: 9, cans: 1, alt: 150, seed: 59 },
    { name: 'Heavy Moon', g: 2.1, wind: -2, gust: 0, rough: 0.55, range: 170, pads: [1, 2, 3], fuel: 950, vx: 4, cans: 2, alt: 140, seed: 61 },
    { name: 'Gusts', g: 1.8, wind: 2, gust: 5, rough: 0.58, range: 180, pads: [2, 3, 5], fuel: 900, vx: 6, cans: 2, alt: 150, seed: 73 },
    { name: 'Canyon', g: 1.9, wind: -3, gust: 2, rough: 0.72, range: 260, pads: [2, 3, 5], fuel: 950, vx: 0, cans: 2, alt: 150, seed: 89 },
    { name: 'Fumes', g: 1.9, wind: 3, gust: 2, rough: 0.6, range: 190, pads: [1, 3, 5], fuel: 520, vx: 8, cans: 3, alt: 140, seed: 97 },
    { name: 'Storm', g: 2.1, wind: -6, gust: 5, rough: 0.6, range: 200, pads: [2, 3, 5], fuel: 950, vx: -4, cans: 2, alt: 150, seed: 103 },
    { name: 'Needle', g: 2.4, wind: 2, gust: 3, rough: 0.68, range: 230, pads: [3, 5], fuel: 900, vx: 10, cans: 2, alt: 150, seed: 113 },
    { name: 'Titan', g: 2.8, wind: -5, gust: 6, rough: 0.76, range: 260, pads: [2, 5], fuel: 900, vx: 6, cans: 3, alt: 150, seed: 127 }
  ];
  var DUEL_N = 5, HULLS = 3;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrapX(x) { return ((x % WORLD_W) + WORLD_W) % WORLD_W; }
  function wrapD(d) { d = wrapX(d); return d > WORLD_W / 2 ? d - WORLD_W : d; }   // shortest signed distance
  function wrapA(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  // Small seeded PRNG (mulberry32) and an integer hash, so a sortie is reproducible.
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

  // ---- terrain: a periodic jagged ridge (midpoint displacement), with flat pads ----
  function genTerrain(seed, o) {
    var r = rng(hash2(seed, 101)), n = NPTS, h = new Float64Array(n), step, i, amp = 1;
    h[0] = r();
    for (step = n; step > 1; step >>= 1) {
      var half = step >> 1;
      for (i = 0; i < n; i += step) h[i + half] = (h[i] + h[(i + step) % n]) / 2 + (r() - 0.5) * amp;
      amp *= o.rough;
    }
    var lo = 1e9, hi = -1e9;
    for (i = 0; i < n; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
    var range = o.range || 160;
    for (i = 0; i < n; i++) h[i] = 12 + (h[i] - lo) / ((hi - lo) || 1) * range;
    // pads: one per slot of the world, at a random place in it, flattened to their mean height
    var pads = [], P = o.pads, slot = Math.floor(n / P.length), order = P.slice();
    for (i = order.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
    for (var k = 0; k < order.length; k++) {
      var m = order[k], w = PAD_SEGS[m] || 2, s0 = k * slot + 2, s1 = (k + 1) * slot - w - 3;
      var i0 = s0 + Math.floor(r() * Math.max(1, s1 - s0)), y = 0;
      for (i = i0; i <= i0 + w; i++) y += h[i];
      y /= (w + 1);
      // pads sit a little proud of their surroundings' lows, never at the very top
      y = Math.min(y, 12 + range * 0.8);
      for (i = i0; i <= i0 + w; i++) h[i] = y;
      pads.push({ i0: i0, i1: i0 + w, x0: i0 * DX, x1: (i0 + w) * DX, y: y, mult: m });
    }
    pads.sort(function (a, b) { return a.x0 - b.x0; });
    var top = -1e9;
    for (i = 0; i < n; i++) if (h[i] > top) top = h[i];
    return { seed: seed >>> 0, n: n, ys: h, pads: pads, top: top };
  }
  function groundY(T, x) {
    var xm = wrapX(x), i = Math.floor(xm / DX), u = (xm - i * DX) / DX, n = T.n;
    if (i >= n) { i = n - 1; u = 1; }
    return T.ys[i] * (1 - u) + T.ys[(i + 1) % n] * u;
  }
  function padAt(T, x) {
    var xm = wrapX(x), P = T.pads;
    for (var i = 0; i < P.length; i++) if (xm >= P[i].x0 - 1e-9 && xm <= P[i].x1 + 1e-9) return P[i];
    return null;
  }
  // Highest ground in [x0, x1] (x1 may be < x0): every vertex in between, plus the ends.
  function maxGround(T, x0, x1) {
    if (x1 < x0) { var t = x0; x0 = x1; x1 = t; }
    var m = Math.max(groundY(T, x0), groundY(T, x1)), i0 = Math.ceil(x0 / DX), i1 = Math.floor(x1 / DX), n = T.n;
    for (var i = i0; i <= i1; i++) { var y = T.ys[((i % n) + n) % n]; if (y > m) m = y; }
    return m;
  }

  // ---- sortie specs ----
  function levelSpec(li) {
    var L = LEVELS[clamp(li | 0, 0, LEVELS.length - 1)];
    return { kind: 'camp', level: li | 0, name: L.name, seed: hash2(L.seed, 7), g: L.g, wind: L.wind, gust: L.gust, rough: L.rough, range: L.range,
      pads: L.pads.slice(), fuel: L.fuel, fuelMax: L.fuel, vx: L.vx, cans: L.cans, alt: L.alt };
  }
  // Endless / duel sortie k (0-based) of a run seeded by `seed`: harder as k grows.
  function sortieSpec(k, seed, fuel) {
    var r = rng(hash2(seed, k + 1)), d = Math.min(k, 14), sgn = r() < 0.5 ? -1 : 1;
    var pads = d < 2 ? [1, 2, 3] : d < 5 ? [1, 3, 5] : d < 9 ? [2, 3, 5] : [3, 5];
    return { kind: 'sortie', level: k, name: 'Sortie ' + (k + 1), seed: hash2(seed, 1000 + k), g: Math.min(2.6, 1.3 + 0.1 * d + r() * 0.15),
      wind: d < 2 ? 0 : sgn * Math.min(6, 0.7 * (d - 1) + r() * 1.5), gust: d < 4 ? 0 : Math.min(5, (d - 3) * 0.7 + r()),
      rough: Math.min(0.78, 0.45 + 0.025 * d + r() * 0.05), range: Math.min(260, 120 + 10 * d + r() * 30),
      pads: pads, fuel: fuel == null ? 900 : fuel, fuelMax: 1200, vx: (r() - 0.5) * Math.min(16, 4 + d), cans: 1 + (d > 3 ? 1 : 0) + (r() < 0.4 ? 1 : 0), alt: 150 };
  }

  // ---- a flight ----
  function newFlight(spec) {
    var T = genTerrain(spec.seed, spec), r = rng(hash2(spec.seed, 202));
    // start over the crags, away from the nearest pad, drifting (spec.vx)
    var x = r() * WORLD_W;
    for (var tries = 0; tries < 20; tries++) {
      var near = false;
      for (var i = 0; i < T.pads.length; i++) if (Math.abs(wrapD((T.pads[i].x0 + T.pads[i].x1) / 2 - x)) < 140) near = true;
      if (!near) break;
      x = r() * WORLD_W;
    }
    var y = T.top + (spec.alt || 150);
    var cans = [];
    for (var c = 0; c < (spec.cans || 0); c++) {
      var cx = x + (c % 2 ? -1 : 1) * (120 + r() * 380) * (spec.vx < 0 ? -1 : 1), gy = maxGround(T, cx - 12, cx + 12);
      cans.push({ x: wrapX(cx), y: Math.min(T.top + 110, gy + 45 + r() * 70), got: false, ph: r() * 6.28 });
    }
    var f = {
      spec: spec, T: T, ceil: T.top + 330, phase: 'fly', t: 0, steps: 0, acc: 0,
      x: x, y: y, vx: spec.vx || 0, vy: 0, a: 0, w: 0, px: x, py: y, pa: 0,
      fuel: spec.fuel, fuelMax: spec.fuelMax || spec.fuel, thr: 0, rot: 0, burned: 0, lowWarn: false,
      cans: cans, wind: 0, wph: r() * 6.28, wph2: r() * 6.28,
      z: 1, pz: 1, cy: y, pcy: y, events: [], result: null, endT: 0, alt: 0, apPad: -1, apT: 0, apIn: { rot: 0, thrust: 0 }
    };
    f.wind = windAt(f);
    f.alt = altOf(f);
    camera(f, 1);
    f.pz = f.z; f.pcy = f.cy;
    return f;
  }
  function windAt(f) {
    var s = f.spec;
    if (!s.gust) return s.wind;
    return s.wind + s.gust * (0.6 * Math.sin(f.t * 0.31 + f.wph) + 0.4 * Math.sin(f.t * 0.83 + f.wph2));
  }
  // World position of a local point of the lander.
  function toWorld(f, lx, ly, out) {
    var ca = Math.cos(f.a), sa = Math.sin(f.a);
    out[0] = f.x + lx * ca + ly * sa; out[1] = f.y - lx * sa + ly * ca;
    return out;
  }
  // Height of the feet over the highest ground near the lander.
  function altOf(f) { return f.y + FOOT_Y - maxGround(f.T, f.x - 6, f.x + 6); }

  // Camera: zoom (px per metre for a REF_H-tall view) and centre height, eased
  // in the fixed step so the renderer can interpolate them; zooms in near the ground.
  function camera(f, k) {
    var T = f.T, alt = f.y + FOOT_Y - maxGround(T, f.x - 30, f.x + 30);
    var zt = clamp(REF_H / (1.9 * Math.max(0, alt) + 40), ZMIN, ZMAX);
    f.z += (zt - f.z) * k;
    var vh = REF_H / f.z, gy = groundY(T, f.x);
    var cyT = (f.y + gy) / 2 + 0.06 * vh;
    f.cy += (cyT - f.cy) * Math.min(1, k * 1.6);
    f.cy = clamp(f.cy, f.y - 0.3 * vh, f.y + 0.32 * vh);   // the lander never leaves the frame
  }

  function gradeOf(q) {
    for (var i = 0; i < GRADES.length; i++) if (q < GRADES[i].q) return GRADES[i];
    return null;
  }
  function landScore(mult, grade, fuel, centre) {
    return Math.round(100 * mult * grade.mult + fuel * 0.25 + 50 * centre);
  }

  var P0 = [0, 0], P1 = [0, 0], HW = [];
  for (var hi0 = 0; hi0 < HULL.length; hi0++) HW.push([0, 0]);
  function inHull(px, py) {                          // HW holds the hull in world coords (CCW)
    for (var i = 0; i < HW.length; i++) {
      var a = HW[i], b = HW[(i + 1) % HW.length];
      if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) return false;
    }
    return true;
  }
  // Touching the ground? → land or crash.
  function collide(f) {
    var T = f.T, i, hit = false, body = false, pt = P0;
    for (i = 0; i < PROBES.length; i++) {
      toWorld(f, PROBES[i][0], PROBES[i][1], pt);
      if (pt[1] <= groundY(T, pt[0])) { hit = true; if (!PROBES[i][2]) body = true; }
    }
    // a spike poking up between the probes
    var minX = 1e9, maxX = -1e9;
    for (i = 0; i < HULL.length; i++) { toWorld(f, HULL[i][0], HULL[i][1], HW[i]); if (HW[i][0] < minX) minX = HW[i][0]; if (HW[i][0] > maxX) maxX = HW[i][0]; }
    for (i = Math.ceil(minX / DX); i <= Math.floor(maxX / DX); i++) {
      var vx = i * DX, vy = T.ys[((i % T.n) + T.n) % T.n];
      if (inHull(vx, vy) && !padAt(T, vx)) { hit = true; body = true; }
    }
    if (!hit) return false;
    var fl = toWorld(f, -FOOT_X, FOOT_Y, P0), pl = padAt(T, fl[0]), fr = toWorld(f, FOOT_X, FOOT_Y, P1), pr = padAt(T, fr[0]);
    var onPad = !!pl && pl === pr && !body;
    var qy = Math.abs(f.vy) / VY_SAFE, qx = Math.abs(f.vx) / VX_SAFE, qa = Math.abs(f.a) / ANG_SAFE, q = Math.max(qy, qx, qa);
    var res = { landed: false, q: q, vx: f.vx, vy: f.vy, ang: f.a, fuel: Math.round(f.fuel), time: f.t, mult: 0, grade: null, score: 0, centre: 0, reason: '' };
    if (onPad && q < 1.0001) {
      var g = gradeOf(q), pc = (pl.x0 + pl.x1) / 2, hw = (pl.x1 - pl.x0) / 2;
      res.landed = true; res.grade = g.id; res.mult = pl.mult;
      res.centre = clamp(1 - Math.abs(wrapD(f.x - pc)) / Math.max(1, hw - FOOT_X), 0, 1);
      res.score = landScore(pl.mult, g, f.fuel, res.centre);
      f.phase = 'landed';
      f.y = pl.y - FOOT_Y + (f.a ? Math.abs(Math.sin(f.a)) * FOOT_X : 0);
      f.events.push('land');
    } else {
      res.reason = !onPad ? (body ? (pl || pr ? 'Clipped the pad edge' : 'Hit the rocks') : (pl || pr ? 'Missed the pad edge' : 'Landed on the rocks')) :
        q === qy ? 'Came down too fast' : q === qx ? 'Sliding sideways' : 'Not level';
      f.phase = 'crashed';
      f.events.push('crash');
    }
    f.vx0 = f.vx; f.vy0 = f.vy;
    f.vx = 0; f.vy = 0; f.w = 0; f.thr = 0;
    f.result = res;
    return true;
  }

  // One fixed physics step. inp: { rot: -1…1, thrust: 0…1 }.
  function stepFlight(f, inp) {
    var dt = STEP, ev = f.events;
    f.px = f.x; f.py = f.y; f.pa = f.a; f.pz = f.z; f.pcy = f.cy;
    f.steps++; f.t += dt;
    if (f.phase !== 'fly') {
      f.endT += dt;
      if (f.phase === 'landed') f.a += (0 - f.a) * Math.min(1, dt * 8);   // settle on the legs
      camera(f, 1 - Math.exp(-2 * dt));
      return;
    }
    var r = clamp(inp ? +inp.rot || 0 : 0, -1, 1), th = clamp(inp ? +inp.thrust || 0 : 0, 0, 1);   // junk / NaN input is no input
    if (f.fuel <= 0) { th = 0; r = 0; }
    f.rot = r;
    f.w += (r * ROT - f.w) * (1 - Math.exp(-dt / ROT_TAU));
    f.a = wrapA(f.a + f.w * dt);
    var burn = (th * BURN + Math.abs(r) * ROT_BURN) * dt;
    if (burn > 0 && f.fuel > 0) {
      f.burned += Math.min(burn, f.fuel);
      f.fuel = Math.max(0, f.fuel - burn);
      if (!f.lowWarn && f.fuel < f.fuelMax * 0.2) { f.lowWarn = true; ev.push('lowfuel'); }
      if (f.fuel <= 0) ev.push('empty');
    }
    f.thr = th;
    f.wind = windAt(f);
    var gy = groundY(f.T, f.x), alt = f.y - gy;
    var ax = Math.sin(f.a) * THRUST * th + f.wind * WIND_A * (0.45 + 0.55 * clamp(alt / 80, 0, 1));
    var ay = Math.cos(f.a) * THRUST * th - f.spec.g;
    if (f.y > f.ceil) ay -= (f.y - f.ceil) * 0.4;      // the top of the sky pushes back
    f.vx += ax * dt; f.vy += ay * dt;
    f.x += f.vx * dt; f.y += f.vy * dt;
    // fuel canisters
    for (var i = 0; i < f.cans.length; i++) {
      var c = f.cans[i];
      if (c.got) continue;
      var dx = wrapD(c.x - f.x), dy = c.y - f.y;
      if (dx * dx + dy * dy < CAN_R * CAN_R) {
        c.got = true; f.fuel = Math.min(f.fuelMax, f.fuel + CAN_FUEL); f.lowWarn = f.fuel < f.fuelMax * 0.2; ev.push('can'); f.lastCan = c;
      }
    }
    collide(f);
    f.alt = altOf(f);
    camera(f, 1 - Math.exp(-2.6 * dt));
  }

  // Advance real time dt with a fixed step; returns the render interpolation alpha.
  // inp is an input object or a function (f) → input (the autopilot).
  function advance(f, dt, inp) {
    f.acc = Math.min(f.acc + dt, 0.25);
    while (f.acc >= STEP) { stepFlight(f, typeof inp === 'function' ? inp(f) : inp); f.acc -= STEP; }
    return f.acc / STEP;
  }

  // ---- the autopilot (the CPU pilot, and the title screen's demo) ----
  var SKILLS = {
    easy: { id: 'easy', name: 'Rookie', pick: 'safe', touch: 2.0, vxMax: 12, gain: 0.9, noise: 0.35, tilt: 0.55, lag: 0.12, margin: 45, brake: 0.3 },
    normal: { id: 'normal', name: 'Pilot', pick: 'mid', touch: 1.2, vxMax: 18, gain: 1.2, noise: 0.15, tilt: 0.75, lag: 0.05, margin: 35, brake: 0.4 },
    hard: { id: 'hard', name: 'Ace', pick: 'best', touch: 0.55, vxMax: 24, gain: 1.5, noise: 0, tilt: 0.9, lag: 0, margin: 30, brake: 0.45 }
  };
  function apPick(f, sk) {
    var P = f.T.pads, best = -1, bs = -1e9;
    for (var i = 0; i < P.length; i++) {
      var d = Math.abs(wrapD((P[i].x0 + P[i].x1) / 2 - f.x)), m = P[i].mult;
      var s = sk.pick === 'best' ? m * 1000 - d : sk.pick === 'safe' ? -m * 1000 - d : m / (1 + d / 500);
      // not enough fuel for a long trip: the nearest pad
      if (f.fuel < (d / sk.vxMax + 25) * BURN * f.spec.g / THRUST * 1.3) s = -d;
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  }
  function autopilot(f, sk) {
    if (typeof sk === 'string') sk = SKILLS[sk] || SKILLS.normal;
    var out = f.apIn;
    if (f.phase !== 'fly') { out.rot = 0; out.thrust = 0; return out; }
    if (sk.lag && f.apT > 0) { f.apT -= STEP; return out; }   // a slower pilot re-thinks less often
    f.apT = sk.lag;
    if (f.apPad < 0) f.apPad = apPick(f, sk);
    var T = f.T, p = T.pads[f.apPad], g = f.spec.g, pc = (p.x0 + p.x1) / 2, dx = wrapD(pc - f.x), adx = Math.abs(dx);
    var half = (p.x1 - p.x0) / 2, feet = f.y + FOOT_Y, h = feet - p.y;
    var near = adx < Math.max(1.2, half - FOOT_X - 1.2), over = adx < half + 4;
    var amax = THRUST - g;                                   // spare vertical accel at full throttle
    // horizontal: a speed that can still be braked to zero over the pad
    var vxT = adx < 3 ? dx * 0.6 : (dx > 0 ? 1 : -1) * Math.min(sk.vxMax, Math.sqrt(2 * 1.1 * adx) * 0.85);
    // vertical: stay over the crags on the way, then down over the pad
    var clr = maxGround(T, f.x - 10 * (dx > 0 ? 1 : -1), f.x + dx) + sk.margin, below = maxGround(T, f.x - 8, f.x + 8);
    // braking curves: v² = 2·a·h + c² is a constant deceleration a down to c at the ground
    var hb = Math.max(0, feet - (over ? p.y : below)), ab = sk.brake * amax, c0 = over ? sk.touch : 1.5;
    var stopV = Math.sqrt(2 * ab * hb + c0 * c0), lin = sk.touch + 0.35 * Math.max(0, h);
    var vyT, ff = 0;
    if (over && !near) vyT = clamp((p.y + 6 - feet) * 0.8, -stopV, 4);          // hover down to just over the pad, centre first
    else if (over) { vyT = -Math.min(stopV, lin); ff = stopV < lin ? ab : 0.35 * lin; }
    else if (feet < clr) vyT = Math.min(7, (clr - feet) * 0.5 + 1);              // climb over what's ahead
    else vyT = -Math.min(stopV, Math.max(0, feet - Math.max(clr, p.y + adx * 0.25)) * 0.3);
    if (feet - below < 14 && !over) vyT = Math.max(vyT, 2);                      // too close to the rocks: up
    if (!ff && vyT < -2 && vyT <= -stopV + 0.01) ff = ab;                         // riding the braking curve: brake as it assumes
    var wa = f.wind * WIND_A * (0.45 + 0.55 * clamp((f.y - groundY(T, f.x)) / 80, 0, 1));
    var ax = (vxT - f.vx) * sk.gain - wa, ay = (vyT - f.vy) * sk.gain * 2.4 + g + ff;
    var tilt = h < 10 && over ? 0.1 : h < 25 && over ? 0.3 : sk.tilt;
    var aT = clamp(Math.atan2(ax, Math.max(0.35 * g, ay)), -tilt, tilt);
    if (sk.noise) aT += (Math.sin(f.t * 2.3 + f.spec.seed) * 0.5 + Math.sin(f.t * 5.1)) * sk.noise * 0.12 * (h > 30 ? 1 : 0.4);
    var err = wrapA(aT - f.a);
    out.rot = clamp(err * 7 - f.w * 0.35, -1, 1);
    // the vertical need first; then as much as the sideways need asks, within reason
    var ca = Math.cos(f.a), sa = Math.sin(f.a), thV = ca > 0.2 ? ay / (THRUST * ca) : 0, thH = 0;
    if (Math.abs(sa) > 0.05 && ax * sa > 0) thH = Math.abs(ax) / (THRUST * Math.abs(sa));
    var th = Math.max(thV, Math.min(thH, Math.max(0, thV) + 0.3));
    out.thrust = clamp(th, 0, 1);
    if (Math.abs(err) > 0.9) out.thrust = Math.min(out.thrust, 0.3);
    return out;
  }
  // Headless flight with a pilot (f) → input; for tests and the CPU's skipped turns.
  function simulate(spec, pilot, maxT) {
    var f = newFlight(spec), n = Math.ceil((maxT || 240) / STEP);
    for (var i = 0; i < n && f.phase === 'fly'; i++) { stepFlight(f, pilot ? pilot(f) : null); f.events.length = 0; }
    if (f.phase === 'fly') { f.phase = 'crashed'; f.result = { landed: false, q: 0, vx: f.vx, vy: f.vy, ang: f.a, fuel: Math.round(f.fuel), time: f.t, mult: 0, grade: null, score: 0, centre: 0, reason: 'Lost in space' }; }
    return f;
  }
  // Fuel after a landing in Endless: what was left plus a bonus by grade and pad.
  function fuelBonus(res) {
    if (!res || !res.landed) return 0;
    return ({ S: 320, A: 250, B: 180, C: 120 })[res.grade] + 30 * res.mult;
  }

  // ---- matches: Endless (hulls) and Duel (alternating turns) ----
  function newEndless(seed) { return { seed: seed >>> 0, k: 0, score: 0, hulls: HULLS, fuel: 900, landings: 0, perfects: 0, over: false, log: [] }; }
  function endlessSpec(E) { return sortieSpec(E.k, E.seed, E.fuel); }
  function endlessSettle(E, res) {
    E.log.push(res.landed ? res.grade : 'X');
    if (res.landed) { E.score += res.score; E.landings++; if (res.grade === 'S') E.perfects++; E.fuel = Math.min(1200, res.fuel + fuelBonus(res)); }
    else { E.hulls--; E.fuel = Math.max(0, res.fuel - 100); }
    E.k++;
    if (E.hulls <= 0 || E.fuel < 120) E.over = true;
    return E;
  }
  // Duel: players 0 and 1 fly the same DUEL_N sorties; player 1 may be the CPU.
  function newDuel(seed, cpu) { return { seed: seed >>> 0, cpu: cpu || '', k: 0, turn: 0, scores: [[], []], over: false }; }
  function duelSpec(D) { var s = sortieSpec(Math.min(9, 1 + D.k * 2), D.seed, null); s.kind = 'duel'; s.fuel = s.fuelMax = 1000; s.name = 'Round ' + (D.k + 1); return s; }
  function duelSettle(D, res) {
    D.scores[D.turn][D.k] = res.landed ? res.score : 0;
    if (D.turn === 0) D.turn = 1;
    else { D.turn = 0; D.k++; if (D.k >= DUEL_N) D.over = true; }
    return D;
  }
  function duelTotals(D) {
    return D.scores.map(function (s) { var t = 0; for (var i = 0; i < s.length; i++) t += s[i] || 0; return t; });
  }
  function duelWinner(D) { var t = duelTotals(D); return t[0] > t[1] ? 0 : t[1] > t[0] ? 1 : -1; }

  // ---- the save ----
  function newSave() {
    var best = [];
    for (var i = 0; i < LEVELS.length; i++) best.push({ s: 0, g: '' });
    return { v: 1, open: 1, best: best, endless: { score: 0, sorties: 0 },
      duel: { cpu: { easy: [0, 0, 0], normal: [0, 0, 0], hard: [0, 0, 0] }, pvp: [0, 0, 0] },
      stats: { flights: 0, landings: 0, crashes: 0, perfects: 0, fuel: 0 },
      opt: { cpu: 'normal', opp: 'cpu', tilt: false } };
  }
  function nn(v) { v = +v; return isFinite(v) && v > 0 ? v : 0; }
  function triple(a) { return [0, 1, 2].map(function (i) { return Math.floor(nn(a && a[i])); }); }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.open = clamp(Math.floor(+o.open) || 1, 1, LEVELS.length);
    if (Array.isArray(o.best)) for (var i = 0; i < LEVELS.length; i++) {
      var b = o.best[i];
      if (b && typeof b === 'object') { s.best[i].s = Math.floor(nn(b.s)); s.best[i].g = GRADE_RANK[b.g] ? b.g : ''; }
    }
    if (o.endless) { s.endless.score = Math.floor(nn(o.endless.score)); s.endless.sorties = Math.floor(nn(o.endless.sorties)); }
    if (o.duel) {
      if (o.duel.cpu) for (var k in s.duel.cpu) s.duel.cpu[k] = triple(o.duel.cpu[k]);
      s.duel.pvp = triple(o.duel.pvp);
    }
    if (o.stats) for (var st in s.stats) s.stats[st] = Math.floor(nn(o.stats[st]));
    if (o.opt) {
      if (SKILLS[o.opt.cpu]) s.opt.cpu = o.opt.cpu;
      if (o.opt.opp === 'cpu' || o.opt.opp === 'pvp') s.opt.opp = o.opt.opp;
      s.opt.tilt = o.opt.tilt === true;
    }
    return s;
  }
  // Every flight's outcome feeds the lifetime stats.
  function noteFlight(save, res) {
    var st = save.stats;
    st.flights++;
    if (res.landed) { st.landings++; if (res.grade === 'S') st.perfects++; } else st.crashes++;
    return save;
  }
  function settleLevel(save, li, res) {
    var out = { best: false, gradeUp: false, unlocked: false };
    if (!res.landed) return out;
    var b = save.best[li];
    if (res.score > b.s) { out.best = b.s > 0; b.s = res.score; }
    if (!b.g || GRADE_RANK[res.grade] > GRADE_RANK[b.g]) { out.gradeUp = !!b.g; b.g = res.grade; }
    if (li + 1 >= save.open && li + 1 < LEVELS.length) { save.open = li + 2; out.unlocked = true; }
    return out;
  }
  function settleEndless(save, E) {
    var out = { best: false };
    if (E.score > save.endless.score) { out.best = save.endless.score > 0 || E.score > 0; save.endless.score = E.score; }
    if (E.landings > save.endless.sorties) save.endless.sorties = E.landings;
    return out;
  }
  function settleDuel(save, D) {
    var w = duelWinner(D), row = D.cpu ? save.duel.cpu[D.cpu] : save.duel.pvp;
    row[w === 0 ? 0 : w === 1 ? 1 : 2]++;
    return w;
  }
  function campaignStars(save) {
    var n = 0;
    for (var i = 0; i < save.best.length; i++) n += GRADE_RANK[save.best[i].g] || 0;
    return n;
  }

  var ENGINE = {
    STEP: STEP, THRUST: THRUST, ROT: ROT, BURN: BURN, WORLD_W: WORLD_W, DX: DX, VY_SAFE: VY_SAFE, VX_SAFE: VX_SAFE, ANG_SAFE: ANG_SAFE,
    FOOT_X: FOOT_X, FOOT_Y: FOOT_Y, CAN_FUEL: CAN_FUEL, REF_H: REF_H, VIEW_W: VIEW_W, ZMIN: ZMIN, ZMAX: ZMAX, HULL: HULL,
    LEVELS: LEVELS, GRADES: GRADES, GRADE_RANK: GRADE_RANK, SKILLS: SKILLS, DUEL_N: DUEL_N, HULLS: HULLS,
    rng: rng, hash2: hash2, wrapX: wrapX, wrapD: wrapD, genTerrain: genTerrain, groundY: groundY, padAt: padAt, maxGround: maxGround,
    levelSpec: levelSpec, sortieSpec: sortieSpec, newFlight: newFlight, stepFlight: stepFlight, advance: advance, collide: collide,
    windAt: windAt, toWorld: toWorld, altOf: altOf, gradeOf: gradeOf, landScore: landScore, autopilot: autopilot, simulate: simulate, fuelBonus: fuelBonus,
    newEndless: newEndless, endlessSpec: endlessSpec, endlessSettle: endlessSettle,
    newDuel: newDuel, duelSpec: duelSpec, duelSettle: duelSettle, duelTotals: duelTotals, duelWinner: duelWinner,
    newSave: newSave, normSave: normSave, noteFlight: noteFlight, settleLevel: settleLevel, settleEndless: settleEndless, settleDuel: settleDuel, campaignStars: campaignStars
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('lander.css');

  var PANEL_ID = 'lander-panel', NAME = 'Lunar Lander';
  var KEY = 'cade-lander-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = VIEW_W, CW = 8, RH = 12;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.lander = { live: function () { return S; }, engine: ENGINE };   // test-only peek

  // palette slots, filled from the theme (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_STAR = 10, C_ROCK = 11, C_EARTH = 12, C_LAND = 13, NPAL = 14;
  var PILOT_COL = [C_ACC, C_VIOLET];

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
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function deg(a) { return Math.round(Math.abs(a) * 180 / Math.PI); }
  function windTxt(w, gust) {
    var a = Math.abs(w);
    if (a < 0.5 && !gust) return 'calm';
    return (a < 0.5 ? '' : (w > 0 ? '→ ' : '← ') + a.toFixed(0)) + (gust ? (a < 0.5 ? '' : ' ') + 'gusts ±' + gust.toFixed(0) : '');
  }
  function gradeName(id) { for (var i = 0; i < GRADES.length; i++) if (GRADES[i].id === id) return GRADES[i].name; return ''; }

  // ---- sound: a tiny WebAudio voice (plus a filtered-noise engine rumble), created on a user gesture ----
  function Snd(on) { this.on = !!on; this.ac = null; this.eng = null; }
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
  Snd.prototype.noiseBuf = function () {
    var ac = this.ac;
    if (!this.nb) {
      var n = ac.sampleRate, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.nb = b;
    }
    return this.nb;
  };
  Snd.prototype.boom = function (vol, dur) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime, s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = this.noiseBuf(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(900, t); fl.frequency.exponentialRampToValueAtTime(80, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(fl); fl.connect(g); g.connect(ac.destination);
      s.start(t); s.stop(t + dur + 0.05);
    } catch (e) {}
  };
  // The main engine: looping filtered noise whose level follows the throttle.
  Snd.prototype.engine = function (lv) {
    var ac = this.ac;
    if (!ac || ac.state === 'closed') return;
    if (!this.on) lv = 0;
    try {
      if (!this.eng) {
        if (lv <= 0) return;
        var s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
        s.buffer = this.noiseBuf(); s.loop = true; fl.type = 'lowpass'; fl.frequency.value = 380; g.gain.value = 0;
        s.connect(fl); fl.connect(g); g.connect(ac.destination); s.start();
        this.eng = { s: s, f: fl, g: g, lv: 0 };
      }
      if (Math.abs(lv - this.eng.lv) < 0.02) return;
      this.eng.lv = lv;
      this.eng.g.gain.setTargetAtTime(lv * 0.11, ac.currentTime, 0.03);
      this.eng.f.frequency.setTargetAtTime(260 + lv * 420, ac.currentTime, 0.05);
    } catch (e) {}
  };
  Snd.prototype.close = function () {
    if (this.eng) { try { this.eng.s.stop(); } catch (e) {} this.eng = null; }
    if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; }
  };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_HOME = svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>');

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
    P[C_STAR] = css(mix(bg, tx, dark ? 0.5 : 0.32));
    P[C_ROCK] = css(mix(bg, tx, dark ? 0.62 : 0.55));
    P[C_EARTH] = css(mix(bg, parseCol(P[C_ICE]), dark ? 0.55 : 0.5));
    P[C_LAND] = css(mix(bg, parseCol(P[C_LEAF]), dark ? 0.6 : 0.55));
    // the rock under the surface: strata in two shades
    S.rock = { a: css(mix(bg, tx, dark ? 0.15 : 0.12)), b: css(mix(bg, tx, dark ? 0.085 : 0.065)), deep: css(mix(bg, tx, dark ? 0.06 : 0.045)) };
    S.col = { bg: css(bg), hud: css(bg, 0.82), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace', padGlow: css(ac, dark ? 0.16 : 0.12) };
    fitFont();
  }

  // ---- glyph rendering (as Dusk Dash): a (colour, char) atlas stamped with drawImage ----
  var AT_COLS = 24, AT_ROWS = 18;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
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
  var NB = new Uint8Array(24);
  function writeNum(v, dec, comma) {
    var neg = v < 0, n = 0, i;
    if (neg) v = -v;
    var sc = dec === 1 ? 10 : 1, iv = Math.round(v * sc), ip = Math.floor(iv / sc), fp = iv - ip * sc;
    if (iv === 0) neg = false;
    for (i = 0; i < (dec || 0); i++) { NB[n++] = 48 + fp % 10; fp = Math.floor(fp / 10); }
    if (dec) NB[n++] = 46;
    var cnt = 0;
    do { if (comma && cnt && cnt % 3 === 0) NB[n++] = 44; NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); cnt++; } while (ip > 0 && n < 20);
    if (neg) NB[n++] = 45;
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, false, sc);
    return x0 + n * cw;
  }

  // The sky: stars (a slow parallax with the camera) and a distant planet.
  var STARS = (function () {
    var r = rng(5), a = [];
    for (var i = 0; i < 70; i++) a.push({ x: r() * 900, y: r() * 600, c: r() < 0.1 ? 43 : r() < 0.22 ? 42 : r() < 0.3 ? 39 : 46, tw: r() * 6.28 });
    return a;
  })();
  var PLANET = ['  .-~~-.', ' / ~  ~ \\', '|  ~ ~   |', ' \\  ~ ~ /', "  '-..-'"];

  // ---- particles (world space) and banners; pools allocated once ----
  var NPART = 180;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0, b: 0, rot: 0 });
    S.pi = 0;
  }
  function clearFx() { for (var i = 0; i < NPART; i++) S.parts[i].on = false; S.msg = null; S.msgQ.length = 0; S.shake = 0; S.flash = 0; }
  function spark(x, y, vx, vy, life, code, ci, g, bounce) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0; p.b = bounce || 0; p.rot = 0;
    return p;
  }
  function stepFx(dt) {
    var T = S.f ? S.f.T : null;
    for (var i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (T) {
        var gy = groundY(T, p.x);
        if (p.y < gy) {
          if (p.b) {                                   // debris bounces and skids
            p.y = gy; p.vy = Math.abs(p.vy) * p.b; p.vx *= 0.55;
            if (p.vy < 1.2) { p.vy = 0; p.g = 0; p.vx *= 0.8; }
          } else if (p.g >= 0 && p.code !== 46) {      // exhaust hitting the ground: a puff of dust sideways
            p.y = gy + 0.3; p.vy = 0.5; p.vx = (p.vx >= 0 ? 1 : -1) * (6 + Math.random() * 8); p.code = 46; p.ci = C_FAINT; p.g = -0.5;
          } else p.y = gy;
        }
      }
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }
  var EXH = [42, 46, 39, 96, 44, 42];
  function exhaust(f, dt) {
    if (S.rm || f.phase !== 'fly' || f.thr <= 0.02) return;
    S.exT -= dt * (10 + 40 * f.thr);
    var tmp = [0, 0];
    while (S.exT <= 0) {
      S.exT += 1;
      toWorld(f, (Math.random() - 0.5) * 1.6, -2.6, tmp);
      var sp = 10 + Math.random() * 10 * f.thr, j = (Math.random() - 0.5) * 0.5, an = f.a + j;
      spark(tmp[0], tmp[1], f.vx - Math.sin(an) * sp, f.vy - Math.cos(an) * sp, 0.35 + Math.random() * 0.35,
        EXH[(Math.random() * EXH.length) | 0], Math.random() < 0.3 ? C_GOLD : C_FLAME, 0);
    }
  }
  function jets(f) {
    if (S.rm || f.phase !== 'fly' || !f.rot || Math.random() > 0.35) return;
    var tmp = [0, 0], side = f.rot > 0 ? -1 : 1;
    toWorld(f, side * 2.4, 2.2, tmp);
    var ca = Math.cos(f.a), sa = Math.sin(f.a);
    spark(tmp[0], tmp[1], f.vx + side * ca * 6, f.vy - side * sa * 6, 0.25, 46, C_MUTED, 0);
  }
  var DEBRIS = '/\\[]=o_#\'-|';
  function crashFx(f) {
    var vx = f.vx0 || 0, vy = f.vy0 || 0, n = S.rm ? 10 : 26;
    for (var i = 0; i < n; i++) {
      var an = Math.random() * Math.PI, sp = 5 + Math.random() * 16;
      spark(f.x + (Math.random() - 0.5) * 4, f.y + Math.random() * 3, Math.cos(an) * sp + vx * 0.3, Math.sin(an) * sp * 1.2 + Math.abs(vy) * 0.2, 2.6 + Math.random() * 1.6,
        DEBRIS.charCodeAt(i % DEBRIS.length), i % 3 === 0 ? C_FLAME : S.pilotCol, f.spec.g * 3 + 4, 0.45);
    }
    for (i = 0; i < (S.rm ? 6 : 22); i++) {
      var a2 = Math.random() * Math.PI * 2, s2 = 4 + Math.random() * 14;
      spark(f.x, f.y, Math.cos(a2) * s2, Math.sin(a2) * s2, 0.5 + Math.random() * 0.6, i % 2 ? 42 : 35, i % 3 ? C_FLAME : C_GOLD, -1);
    }
  }
  function landFx(f) {
    for (var i = 0; i < (S.rm ? 4 : 14); i++) {
      var s = i % 2 ? 1 : -1;
      spark(f.x + s * (FOOT_X + Math.random()), f.y + FOOT_Y + 0.4, s * (4 + Math.random() * 9), 0.6 + Math.random(), 0.6 + Math.random() * 0.5, 46, C_FAINT, -0.3);
    }
  }

  // ---- the scene ----
  // Camera: the engine's zoom and centre, interpolated; a taller (portrait) view zooms in a little.
  function view(f, a) {
    var v = S.v, VH = S.VH;
    v.x = f.px + (f.x - f.px) * a; v.y = f.py + (f.y - f.py) * a;
    v.a = f.pa + wrapA(f.a - f.pa) * a;
    v.z = (f.pz + (f.z - f.pz) * a) * Math.pow(Math.max(0.6, VH / REF_H), 0.35);
    v.cy = f.pcy + (f.cy - f.pcy) * a;
    v.cx = v.x;
    v.left = v.cx - VW / 2 / v.z;
    return v;
  }
  function SX(v, wx) { return VW / 2 + wrapD(wx - v.cx) * v.z; }
  function SY(v, wy) { return S.VH / 2 - (wy - v.cy) * v.z; }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl || !S.f) return;
    var f = S.f, c = S.ctx, VH = S.VH, v = view(f, alpha), i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    c.fillStyle = S.col.bg; c.fillRect(-12, -12, VW + 24, VH + 24);
    // stars and the planet: far away, they barely move
    var px = v.cx * v.z * 0.04, py = v.cy * v.z * 0.04;
    for (i = 0; i < STARS.length; i++) {
      var st = STARS[i], sx = ((st.x - px) % 900 + 900) % 900 - 200, sy = ((st.y + py) % 600 + 600) % 600 - 60;
      if (sx < -4 || sx > VW + 4 || sy < 40 || sy > VH) continue;
      c.globalAlpha = st.c === 46 ? 0.9 : 0.6 + 0.4 * Math.sin(S.idleT * 1.7 + st.tw);
      glyph(c, C_STAR, st.c, sx, sy, false, st.c === 46 ? 1 : 0.8);
    }
    c.globalAlpha = 1;
    var plx = VW - 58 - px * 0.5 % 40, ply = 64 + Math.min(40, Math.max(-20, py * 0.3));
    for (i = 0; i < PLANET.length; i++) drawStr(c, C_EARTH, PLANET[i], plx, ply + i * RH * 0.6, 'left', false, 0.6);

    drawTerrain(c, v, f);
    drawCans(c, v, f);
    // particles
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      var qx = SX(v, p.x), qy = SY(v, p.y);
      if (qx < -CW || qx > VW + CW || qy < -RH || qy > VH + RH) continue;
      c.globalAlpha = Math.min(1, 2.2 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, qx, qy, true);
    }
    c.globalAlpha = 1;
    if (f.phase !== 'crashed') drawLander(c, v, f);
    if (S.mode) { drawPointers(c, v, f); hud(c, f, v); }
    if (S.msg) banner(c, S.msg.text, VH * 0.36, S.msg.ci);
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')';
      c.fillRect(-12, -12, VW + 24, VH + 24);
    }
  }

  // The ground: strata bands that follow the surface down, then a surface line
  // of glyphs (/ \ _ |, = on the pads) laid along each text column.
  function drawTerrain(c, v, f) {
    var T = f.T, VH = S.VH, z = v.z, left = v.left, right = left + VW / z, i0 = Math.floor(left / DX) - 1, i1 = Math.ceil(right / DX) + 1, n = T.n, i, b;
    var minY = 1e9, pts = S.pts, np = 0;
    for (i = i0; i <= i1; i++) {
      var sx = (i * DX - left) * z, sy = SY(v, T.ys[((i % n) + n) % n]);
      pts[np * 2] = sx; pts[np * 2 + 1] = sy; np++;
      if (sy < minY) minY = sy;
    }
    var bh = Math.max(7, 3.2 * z), nb = Math.min(36, Math.ceil((VH - minY) / bh) + 1);
    for (b = 0; b < nb; b++) {
      c.fillStyle = b === 0 ? S.rock.a : b % 2 ? S.rock.b : S.rock.a;
      if (b > 7) c.fillStyle = S.rock.deep;
      c.beginPath();
      c.moveTo(pts[0], VH + 12);
      for (i = 0; i < np; i++) c.lineTo(pts[i * 2], pts[i * 2 + 1] + b * bh);
      c.lineTo(pts[(np - 1) * 2], VH + 12);
      c.closePath(); c.fill();
    }
    // pads: a soft glow above, then their lights and multiplier
    var P = T.pads;
    for (i = 0; i < P.length; i++) {
      var p = P[i], xa = SX(v, p.x0), xb = xa + (p.x1 - p.x0) * z, yy = SY(v, p.y);
      if (xb < -40 || xa > VW + 40) continue;
      c.fillStyle = S.col.padGlow; c.fillRect(xa, yy - RH * 1.2, xb - xa, RH * 1.2);
    }
    // the surface line, column by column
    var k0 = Math.floor(left * z / CW), ncol = Math.ceil(VW / CW) + 2;
    for (var k = 0; k < ncol; k++) {
      var gx0 = (k0 + k) * CW - left * z, wx0 = left + gx0 / z, wx1 = left + (gx0 + CW) / z;
      var ya = SY(v, groundY(T, wx0)), yb = SY(v, groundY(T, wx1)), mid = (ya + yb) / 2;
      if (Math.max(ya, yb) < -RH || Math.min(ya, yb) > VH + RH) continue;
      var pd = padAt(T, (wx0 + wx1) / 2);
      if (pd && Math.abs(ya - yb) < 0.5) { glyph(c, C_ACC, 61, gx0 + CW / 2, mid - RH * 0.3); continue; }
      var sl = (yb - ya) / CW, ch = sl < -1.7 || sl > 1.7 ? 124 : sl < -0.4 ? 47 : sl > 0.4 ? 92 : 95;
      if (ch === 95) { glyph(c, C_ROCK, 95, gx0 + CW / 2, mid - RH * 0.42); continue; }
      var span = Math.abs(yb - ya), cnt = Math.max(1, Math.round(span / (RH * 0.85)));
      for (var q = 0; q < cnt; q++) {
        var u = (q + 0.5) / cnt, y = ya + (yb - ya) * u;
        if (y < -RH || y > VH + RH) continue;
        glyph(c, C_ROCK, ch, gx0 + CW / 2, y - RH * 0.1);
      }
    }
    for (i = 0; i < P.length; i++) {
      var pp = P[i], xc = SX(v, (pp.x0 + pp.x1) / 2), w2 = (pp.x1 - pp.x0) * z / 2, y2 = SY(v, pp.y);
      if (xc + w2 < -40 || xc - w2 > VW + 40) continue;
      var blink = ((S.idleT * 2 + i) | 0) % 2;
      glyph(c, blink ? C_GOLD : C_FAINT, 42, xc - w2, y2 - RH * 0.95, false, 0.8);
      glyph(c, blink ? C_FAINT : C_GOLD, 42, xc + w2, y2 - RH * 0.95, false, 0.8);
      var lab = 'x' + pp.mult;
      drawStr(c, pp.mult >= 5 ? C_RED : pp.mult >= 3 ? C_GOLD : C_ACC, lab, xc, y2 + RH * 0.75, 'center', false, z > 1.6 ? 1 : 0.85);
    }
  }
  function drawCans(c, v, f) {
    for (var i = 0; i < f.cans.length; i++) {
      var cn = f.cans[i];
      if (cn.got) continue;
      var x = SX(v, cn.x), y = SY(v, cn.y + Math.sin(S.idleT * 2 + cn.ph) * 0.8);
      if (x < -20 || x > VW + 20 || y < -20 || y > S.VH + 20) continue;
      var sc = Math.max(0.75, Math.min(1.1, v.z / 2.4));
      drawStr(c, C_GOLD, '[F]', x, y, 'center', true, sc);
      if (((S.idleT * 3) | 0) % 3 === 0) glyph(c, C_GOLD, 39, x + CW * 1.8 * sc, y - RH * 0.7 * sc, true, 0.7);
    }
  }

  // The lander: 3 × 3 glyphs in its own rotated frame, a flame under it.
  var LROWS = ['/o\\', '[=]', '/ \\'];
  function drawLander(c, v, f) {
    var x = SX(v, v.x), y = SY(v, v.y), sc = clamp(v.z * 7.2 / (3 * CW), 0.5, 1.2), ci = S.pilotCol;
    var cw = CW * sc, rh = RH * 0.78 * sc;
    c.save();
    c.translate(x, y);
    c.rotate(v.a);
    var oy = -0.25 * rh;                                // the rows sit a touch high: the legs reach the feet
    for (var r = 0; r < 3; r++) for (var q = 0; q < 3; q++) {
      var code = LROWS[r].charCodeAt(q);
      glyph(c, r === 1 && q === 1 && f.fuel < f.fuelMax * 0.2 && ((S.idleT * 4) | 0) % 2 ? C_RED : ci, code, (q - 1) * cw, oy + (r - 1) * rh, true, sc);
    }
    if (f.phase === 'fly' && f.thr > 0.02) {
      var fl = ((S.idleT * 24) | 0) % 3, len = f.thr;
      glyph(c, C_FLAME, fl === 0 ? 86 : fl === 1 ? 118 : 89, 0, oy + rh * 1.05, true, sc * (0.8 + 0.4 * len));
      if (len > 0.45) glyph(c, C_GOLD, fl ? 39 : 42, (fl - 1) * 1.5, oy + rh * 1.8, true, sc * 0.8);
      if (len > 0.8) glyph(c, C_FLAME, 46, 0, oy + rh * 2.4, true, sc * 0.8);
    }
    c.restore();
  }
  // Pads off screen: an arrow at the edge with the multiplier and distance.
  function drawPointers(c, v, f) {
    var P = f.T.pads, VH = S.VH, used = [];
    for (var i = 0; i < P.length; i++) {
      var p = P[i], d = wrapD((p.x0 + p.x1) / 2 - v.cx), sx = VW / 2 + d * v.z;
      if (sx > -6 && sx < VW + 6) continue;
      var y = clamp(SY(v, p.y), 56, VH - 18), right = d > 0;
      for (var u = 0; u < used.length; u++) if (used[u][0] === right && Math.abs(used[u][1] - y) < RH * 2.1) { y = used[u][1] + (used[u][1] > VH - 60 ? -RH * 2.2 : RH * 2.2); u = -1; }
      used.push([right, y]);
      var ci = p.mult >= 5 ? C_RED : p.mult >= 3 ? C_GOLD : C_ACC;
      var s = (right ? '' : '<') + 'x' + p.mult + (right ? '>' : '');
      drawStr(c, ci, s, right ? VW - 4 : 4, y, right ? 'right' : 'left', false, 0.85);
      var n = writeNum(Math.abs(d), 0); NB[n++] = 109;
      drawNum(c, C_FAINT, n, right ? VW - 4 : 4, y + RH * 0.9, right ? 'right' : 'left', 0.7);
    }
  }

  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - RH * 0.8, w, RH * 1.6);
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.5, y);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.5, y);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }

  // Green inside the limit, gold near it, red over it.
  function limCol(r) { return r <= 0.8 ? C_LEAF : r <= 1 ? C_GOLD : C_RED; }
  function hud(c, f, v) {
    var yl = 6, yv = 17, y2 = 31, n, x, L = 0.72, near = f.alt < 90 && f.phase === 'fly', H = S.hc;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 39);
    drawStr(c, C_MUTED, 'ALT', H[0], yl, 'left', false, L);
    drawStr(c, C_MUTED, 'H-SPD', H[1], yl, 'left', false, L);
    drawStr(c, C_MUTED, 'V-SPD', H[2], yl, 'left', false, L);
    drawStr(c, C_MUTED, 'TILT', H[3], yl, 'left', false, L);
    drawStr(c, C_MUTED, 'FUEL', H[4], yl, 'left', false, L);
    var res = f.result, vx = res ? res.vx : f.vx, vy = res ? res.vy : f.vy, an = res ? res.ang : f.a;
    n = writeNum(Math.max(0, f.phase === 'fly' ? f.alt : 0), 0); x = drawNum(c, near && f.alt < 25 ? C_GOLD : C_TEXT, n, 6, yv); glyph(c, C_MUTED, 109, x + 4, yv + 1, false, 0.8);
    var rx = Math.abs(vx) / VX_SAFE, ry = Math.abs(vy) / VY_SAFE, ra = Math.abs(an) / ANG_SAFE;
    if (Math.abs(vx) >= 0.05) glyph(c, C_MUTED, vx > 0 ? 62 : 60, H[1] + 2, yv, false, 0.85);
    n = writeNum(Math.abs(vx), 1); drawNum(c, near || res ? limCol(rx) : C_TEXT, n, H[1] + 10, yv);
    var down = vy < -0.05, warn = near && ry > 1.25 && f.alt < 45 && ((S.idleT * 6) | 0) % 2;
    if (Math.abs(vy) >= 0.05) glyph(c, C_MUTED, down ? 118 : 94, H[2] + 2, yv, false, 0.85);
    n = writeNum(Math.abs(vy), 1); drawNum(c, warn ? C_TEXT : near || res ? limCol(ry) : C_TEXT, n, H[2] + 10, yv);
    n = writeNum(deg(an), 0); x = drawNum(c, near || res ? limCol(ra) : C_TEXT, n, H[3], yv);
    glyph(c, C_MUTED, 111, x + 2, yv - 4, false, 0.55);
    // fuel: a bar and the number
    var fr = clamp(f.fuel / f.fuelMax, 0, 1), cells = H[5], on = Math.ceil(fr * cells - 0.001), low = fr < 0.2;
    for (var i = 0; i < cells; i++) glyph(c, i < on ? (low ? (((S.idleT * 4) | 0) % 2 ? C_RED : C_GOLD) : C_LEAF) : C_FAINT, i < on ? 35 : 45, H[4] + i * CW * 0.62 + 3, yv, false, 0.72);
    n = writeNum(f.fuel, 0); drawNum(c, low ? C_RED : C_TEXT, n, VW - 6, yl, 'right', L);
    // second row: where we are, then the wind and gravity
    x = 6;
    var info = S.hudInfo || '';
    x = drawStr(c, S.cpuTurn ? C_RED : S.mode === 'duel' ? S.pilotCol : C_TEXT, info, x, y2, 'left', false, L);
    if (S.mode === 'endless' && S.E) {
      x += CW * 0.8;
      for (i = 0; i < HULLS; i++) glyph(c, i < S.E.hulls ? C_ACC : C_FAINT, i < S.E.hulls ? 65 : 46, x + i * CW * 0.75, y2, false, 0.72);
    }
    var w = f.wind, aw = Math.abs(w);
    var gx = drawStr(c, C_MUTED, 'G', VW - 6 - CW * 4 * L, y2, 'right', false, L) + 2;
    n = writeNum(f.spec.g, 1); drawNum(c, C_TEXT, n, gx, y2, 'left', L);
    var wx = VW - 6 - CW * 5.5 * L - 4;
    if (aw < 0.3) drawStr(c, C_FAINT, 'CALM', wx, y2, 'right', false, L);
    else {
      var arrows = aw < 2 ? 1 : aw < 4.5 ? 2 : 3, s = '';
      for (i = 0; i < arrows; i++) s += w > 0 ? '>' : '<';
      n = writeNum(aw, 0); drawNum(c, C_TEXT, n, wx, y2, 'right', L); x = wx - n * CW * L;
      drawStr(c, f.spec.gust ? C_ICE : C_MUTED, s, x - 3, y2, 'right', false, L);
      drawStr(c, C_MUTED, 'WIND', x - 3 - (arrows + 0.6) * CW * L, y2, 'right', false, L);
    }
  }

  // ---- loop: runs only while a flight is on screen ----
  function running() {
    return !!S && S.phase === 'fly' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } if (S) S.snd.engine(0); }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad();
    if (!running()) return;                        // the gamepad paused it
    S.idleT += dt;
    var f = S.f, sim = dt * (S.cpuTurn ? S.cpuFast : 1), alpha;
    if (S.cpuTurn) alpha = advance(f, sim, S.apFn);
    else alpha = advance(f, sim, input());
    handleEvents(f);
    exhaust(f, sim); jets(f);
    stepFx(sim);
    S.snd.engine(f.phase === 'fly' ? f.thr : 0);
    warnTick(f, dt);
    syncPad();
    draw(alpha, dt);
    if (f.phase !== 'fly' && f.endT >= (f.phase === 'crashed' ? 1.9 : 1.4)) { finishFlight(); return; }
    S.raf = requestAnimationFrame(frame);
  }
  // A beeping altimeter when you're coming in too hot.
  function warnTick(f, dt) {
    if (f.phase !== 'fly' || S.cpuTurn) return;
    S.warnT -= dt;
    if (f.alt < 45 && -f.vy > VY_SAFE * 1.25 && S.warnT <= 0) { S.snd.tone(1320, 0.05, 'square', 0.02); S.warnT = 0.22; }
  }

  function handleEvents(f) {
    var ev = f.events, snd = S.snd;
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'land':
          var r = f.result, gn = gradeName(r.grade);
          say(gn + '!  ' + fmtInt(r.score), r.grade === 'S' ? C_GOLD : C_LEAF, 2.4);
          landFx(f);
          if (r.grade === 'S') { [659, 784, 988, 1319].forEach(function (fq, j) { snd.tone(fq, 0.12, 'triangle', 0.04, 0, j * 0.08); }); S.flash = 0.1; }
          else { snd.tone(523, 0.12, 'triangle', 0.04); snd.tone(784, 0.2, 'triangle', 0.04, 0, 0.1); }
          snd.tone(90, 0.12, 'sine', 0.06, 60);
          Cade.haptic && Cade.haptic(12);
          if (S.liveEl) S.liveEl.textContent = 'Landed: ' + gn + ', ' + r.score + ' points.';
          break;
        case 'crash':
          say(f.result.reason.toUpperCase(), C_RED, 2.4);
          crashFx(f);
          S.shake = 0.45; S.flash = 0.12;
          snd.boom(0.35, 0.9); snd.tone(160, 0.5, 'sawtooth', 0.04, 40);
          Cade.haptic && Cade.haptic(40);
          if (S.liveEl) S.liveEl.textContent = 'Crashed: ' + f.result.reason + '.';
          break;
        case 'can':
          say('+' + CAN_FUEL + ' FUEL', C_GOLD, 1.2);
          [784, 1047, 1319].forEach(function (fq, j) { snd.tone(fq, 0.08, 'triangle', 0.035, 0, j * 0.05); });
          if (f.lastCan) for (var k = 0; k < (S.rm ? 3 : 10); k++) spark(f.lastCan.x, f.lastCan.y, (Math.random() - 0.5) * 16, (Math.random() - 0.3) * 14, 0.6, k % 2 ? 42 : 39, C_GOLD, 6);
          Cade.haptic && Cade.haptic(8);
          break;
        case 'lowfuel': if (!S.cpuTurn) { say('FUEL LOW', C_GOLD, 1.4); snd.tone(440, 0.12, 'square', 0.03); snd.tone(440, 0.12, 'square', 0.03, 0, 0.2); } break;
        case 'empty': say('OUT OF FUEL', C_RED, 2); snd.tone(330, 0.4, 'square', 0.03, 165); break;
      }
    }
    ev.length = 0;
  }

  // ---- input: rotate + thrust from keys, the pad, the play field, a gamepad and (optionally) tilt ----
  var KEYS = { ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 't', KeyW: 't', Space: 't', ShiftLeft: 'f', ShiftRight: 'f', ArrowDown: 'f', KeyS: 'f' };
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', p: 'KeyP', enter: 'Enter', escape: 'Escape', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  var INP = { rot: 0, thrust: 0 };
  function heldK(k) {
    for (var c in S.keys) if (S.keys[c] && KEYS[c] === k) return true;
    for (var id in S.ptrs) if (S.ptrs[id] === k) return true;
    return false;
  }
  function input() {
    var rot = (heldK('r') ? 1 : 0) - (heldK('l') ? 1 : 0), fine = heldK('f');
    if (fine) rot *= 0.35;
    if (!rot && S.gp.rot) rot = S.gp.rot;
    if (!rot && S.tilt.on && S.tilt.has && S.f) rot = clamp((S.tilt.target - S.f.a) * 5, -1, 1);
    INP.rot = clamp(rot, -1, 1);
    INP.thrust = heldK('t') ? 1 : S.gp.thr;
    return INP;
  }
  function clearInput() { S.keys = {}; S.ptrs = {}; S.gp.rot = 0; S.gp.thr = 0; syncPad(); }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function btnV(p, i) { var b = p.buttons[i]; return b ? (b.value || (b.pressed ? 1 : 0)) : 0; }
  // Gamepad: left stick / d-pad rotate (analog), A or the right trigger thrust, Start pauses.
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) { gp.rot = 0; gp.thr = 0; return; }
    var ax = p.axes[0] || 0;
    gp.rot = Math.abs(ax) > 0.15 ? (ax - 0.15 * (ax > 0 ? 1 : -1)) / 0.85 : 0;
    if (btnOn(p, 14)) gp.rot = -1;
    if (btnOn(p, 15)) gp.rot = 1;
    if (btnOn(p, 6)) gp.rot *= 0.35;
    gp.thr = Math.max(btnOn(p, 0) || btnOn(p, 12) ? 1 : 0, btnV(p, 7), (p.axes[1] || 0) < -0.5 ? 1 : 0);
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'fly' && !S.paused) { pause(); gp.menuA = true; }   // the menu poll must not see this press as 'resume'
    gp.start = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'fly' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) primary();
    S.gp.menuA = a;
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
      if (S.phase === 'fly' && !S.paused) pause();
      else if (S.paused) resume();
      else if (S.cardKind && S.cardKind !== 'home' && S.back) S.back();
      else closePanel();
      return;
    }
    if (S.phase === 'fly' && !S.paused) {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) pause(); return; }
      if (KEYS[code]) { e.preventDefault(); if (!S.keys[code]) { S.keys[code] = true; syncPad(); } }
      return;
    }
    if (code === 'KeyP' && S.paused) { e.preventDefault(); if (!e.repeat) resume(); return; }
    // between flights Space / Enter does the primary action — unless a button in the panel has focus
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) { primary(); if (S.phase === 'fly' && KEYS[code]) S.keys[code] = true; }
    } else if (KEYS[code] && S.phase === 'fly') e.preventDefault();
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { delete S.keys.ShiftLeft; delete S.keys.ShiftRight; }
    if (S.keys[code]) { delete S.keys[code]; syncPad(); }
  }
  // Tilt: the phone's left-right lean sets the lander's attitude (opt-in).
  function onTilt(e) {
    if (!S) return;
    var ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0, g = e.gamma, b = e.beta;
    if (g == null) return;
    var lean = ang === 90 ? b : ang === -90 || ang === 270 ? -b : g;
    S.tilt.has = true;
    S.tilt.target = clamp(lean / 30, -1, 1) * 1.1;
  }
  function setTilt(on) {
    S.save.opt.tilt = !!on; persist();
    if (on) {
      var DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        try {
          DOE.requestPermission().then(function (st) {
            if (st !== 'granted') { S.save.opt.tilt = false; persist(); Cade.showToast && Cade.showToast('Tilt needs motion access', 'info', 2000); showCard(S.cardKind); }
          }, function () {});
        } catch (e) {}
      }
    }
    S.tilt.on = !!on;
  }

  // ---- flights, modes and cards ----
  function pilotCol() { return S.mode === 'duel' && S.D ? (S.D.turn === 1 ? (S.D.cpu ? C_RED : C_VIOLET) : C_ACC) : C_ACC; }
  function prepFlight(spec) {
    S.f = newFlight(spec);
    S.spec = spec;
    S.cpuTurn = false; S.cpuFast = 1;
    S.pilotCol = pilotCol();
    clearFx(); clearInput();
    S.exT = 0; S.warnT = 0;
    S.hudInfo = hudInfo();
    S.phase = 'card'; S.paused = false;
  }
  function hudInfo() {
    if (S.mode === 'camp') return 'LVL ' + pad2(S.level + 1) + ' ' + LEVELS[S.level].name.toUpperCase();
    if (S.mode === 'endless') return 'SORTIE ' + (S.E.k + 1) + '  ' + fmtInt(S.E.score);
    if (S.mode === 'duel') {
      var t = duelTotals(S.D);
      return 'RD ' + (S.D.k + 1) + '/' + DUEL_N + ' ' + who(S.D.turn, true) + '  ' + fmtInt(t[0]) + '-' + fmtInt(t[1]);
    }
    return '';
  }
  function who(turn, short) {
    if (turn === 0) return short ? 'P1' : 'Player 1';
    if (S.D && S.D.cpu) return short ? 'CPU' : 'CPU ' + SKILLS[S.D.cpu].name;
    return short ? 'P2' : 'Player 2';
  }
  function launch(cpu) {
    if (!S || !S.f) return;
    S.snd.ensure();
    S.phase = 'fly'; S.paused = false; S.cpuTurn = !!cpu;
    if (cpu) { var sk = SKILLS[S.D.cpu]; S.apFn = function (f) { return autopilot(f, sk); }; }
    clearInput();
    showCard(null); setPad(cpu ? 'cpu' : 'fly'); syncHead();
    if (!cpu && S.mode !== 'duel') say(S.spec.name.toUpperCase(), C_MUTED, 1.4);
    if (cpu) say(who(1).toUpperCase() + ' FLYING', C_RED, 1.6);
    else if (S.mode === 'duel') say(who(S.D.turn).toUpperCase() + ' - GO', S.pilotCol, 1.4);
    kick();
  }
  // CPU's turn, all at once.
  function skipCpu() {
    if (!S || !S.cpuTurn || !S.f) return;
    var f = S.f, n = 0;
    while (f.phase === 'fly' && n++ < 120 * 300) { stepFlight(f, S.apFn(f)); f.events.length = 0; }
    if (f.phase === 'fly') { f.phase = 'crashed'; f.result = { landed: false, q: 0, vx: 0, vy: 0, ang: 0, fuel: 0, time: f.t, mult: 0, grade: null, score: 0, centre: 0, reason: 'Lost in space' }; }
    finishFlight();
  }
  function finishFlight() {
    stopLoop();
    var f = S.f, res = f.result;
    S.phase = 'card'; S.paused = false; S.cpuTurn = false;
    S.res = res;
    if (!(S.mode === 'duel' && S.D.turn === 1 && S.D.cpu)) noteFlight(S.save, res);
    if (res.landed) S.save.stats.fuel += Math.round(f.burned);
    if (S.mode === 'camp') {
      S.card = settleLevel(S.save, S.level, res);
      persist();
      showCard('result');
    } else if (S.mode === 'endless') {
      S.card = { fuelB: fuelBonus(res), score: res.score };
      endlessSettle(S.E, res);
      if (S.E.over) { S.card.rec = settleEndless(S.save, S.E); persist(); showCard('over'); }
      else { persist(); showCard('result'); }
    } else if (S.mode === 'duel') {
      S.card = { turn: S.D.turn, k: S.D.k };
      duelSettle(S.D, res);
      if (S.D.over) { S.card.w = settleDuel(S.save, S.D); persist(); showCard('final'); }
      else { persist(); showCard('turn'); }
    }
    syncHead(); syncLabel();
    draw(1, 0);
    if (S.mode === 'camp' && res.landed && (S.card.best || S.card.gradeUp)) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.1, 'triangle', 0.03, 0.4 + j * 0.07); });
  }

  function startLevel(li) {
    S.mode = 'camp'; S.level = clamp(li, 0, S.save.open - 1);
    prepFlight(levelSpec(S.level));
    showCard('brief');
  }
  function startEndless() {
    S.mode = 'endless'; S.E = newEndless((Math.random() * 4294967295) >>> 0);
    prepFlight(endlessSpec(S.E));
    showCard('brief');
  }
  function nextSortie() { prepFlight(endlessSpec(S.E)); showCard('brief'); }
  function startDuel() {
    var o = S.save.opt;
    S.mode = 'duel'; S.D = newDuel((Math.random() * 4294967295) >>> 0, o.opp === 'cpu' ? o.cpu : '');
    prepFlight(duelSpec(S.D));
    showCard('handoff');
  }
  function nextTurn() { prepFlight(duelSpec(S.D)); showCard('handoff'); }

  function toHome() {
    stopLoop();
    // quitting an Endless run part-way still keeps its score for the records
    if (S.mode === 'endless' && S.E && !S.E.over && S.E.score > 0) { settleEndless(S.save, S.E); persist(); }
    S.firstRun = false;
    S.phase = 'home'; S.mode = null; S.paused = false; S.cpuTurn = false; S.resetArm = false;
    S.E = null; S.D = null;
    demoScene();
    showCard('home');
  }
  // The title screen's backdrop: the autopilot part-way down a level.
  function demoScene() {
    var spec = levelSpec(Math.min(S.save.open - 1, 2)), f = newFlight(spec), n = 0;
    S.mode = null; S.spec = spec; S.f = f; S.pilotCol = C_ACC; S.hudInfo = '';
    clearFx();
    while (f.phase === 'fly' && n++ < 120 * 120) {
      var inp = autopilot(f, 'hard');
      stepFlight(f, inp); f.events.length = 0;
      if (f.alt < 26 && Math.abs(wrapD((f.T.pads[f.apPad].x0 + f.T.pads[f.apPad].x1) / 2 - f.x)) < 30) break;
    }
    f.px = f.x; f.py = f.y; f.pa = f.a; f.pz = f.z; f.pcy = f.cy;
    f.thr = 0.7;
    for (var i = 0; i < 40; i++) { exhaust(f, 1 / 60); stepFx(1 / 60); }
  }

  function pause() {
    if (!S || S.phase !== 'fly' || S.paused) return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad(S.cpuTurn ? 'cpu' : 'fly'); syncHead();
    kick();
  }
  function abandon() {
    if (!S || S.phase !== 'fly') return;
    // giving up counts as a crash (in the campaign, just back to the brief)
    if (S.cpuTurn) { S.paused = false; skipCpu(); return; }   // aborting the CPU's flight just finishes it: no free crash for the CPU
    S.paused = false;
    if (S.mode === 'camp') { stopLoop(); prepFlight(levelSpec(S.level)); S.phase = 'card'; showCard('brief'); syncHead(); draw(1, 0); return; }
    var f = S.f;
    if (f.phase === 'fly') {
      f.phase = 'crashed'; f.vx0 = f.vx; f.vy0 = f.vy;
      f.result = { landed: false, q: 0, vx: f.vx, vy: f.vy, ang: f.a, fuel: Math.round(f.fuel), time: f.t, mult: 0, grade: null, score: 0, centre: 0, reason: 'Abandoned' };
    }
    finishFlight();
  }

  // ---- cards ----
  function line(a, b, w, cls) {
    w = w || 28;
    var s = esc(a) + new Array(Math.max(1, w - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>';
    return cls ? '<span class="' + cls + '">' + s + '</span>' : s;
  }
  function gradeBadge(g) { return g ? '<b class="ll-g ll-g' + g + '">' + g + '</b>' : '<b class="ll-g ll-g0">-</b>'; }
  function btn(act, label, alt, extra) { return '<button type="button" class="ll-go' + (alt ? ' alt' : '') + '" data-act="' + act + '"' + (extra || '') + '>' + label + '</button>'; }

  function homeHtml() {
    var sv = S.save, st = campaignStars(sv), nextL = Math.min(sv.open, LEVELS.length), o = sv.opt;
    var tiltOk = S.coarse && typeof window.DeviceOrientationEvent !== 'undefined';
    var h = '<div class="ll-card ll-home">';
    h += '<pre class="ll-art" aria-hidden="true">   .      *       .\n      /o\\     .\n  *   [=]  .     _____\n_/\\_  / \\ /\\__/\\_=====_/</pre>';
    h += '<div class="ll-title">LUNAR LANDER</div>';
    h += '<button type="button" class="ll-mode" data-act="levels"><b>Campaign</b><span>Level ' + nextL + ' &middot; ' + esc(LEVELS[nextL - 1].name) + '</span><i>' + st + '/' + LEVELS.length * 4 + ' &#9733;</i></button>';
    h += '<button type="button" class="ll-mode" data-act="endless"><b>Endless</b><span>' + HULLS + ' hulls, fuel carries over</span><i>' + (sv.endless.score ? 'best ' + fmtInt(sv.endless.score) : 'new') + '</i></button>';
    h += '<button type="button" class="ll-mode" data-act="duel-setup"><b>Duel</b><span>' + (o.opp === 'cpu' ? 'vs CPU ' + esc(SKILLS[o.cpu].name) : '2 players, one device') + '</span><i>' + DUEL_N + ' rounds</i></button>';
    h += '<div class="ll-foot"><button type="button" class="ll-lnk" data-act="records">Records</button>' +
      (tiltOk ? '<button type="button" class="ll-lnk' + (o.tilt ? ' on' : '') + '" data-act="tilt" aria-pressed="' + (o.tilt ? 'true' : 'false') + '">Tilt to steer: ' + (o.tilt ? 'on' : 'off') + '</button>' : '') +
      '<button type="button" class="ll-lnk" data-act="help">How to play</button></div>';
    return h + '</div>';
  }
  function levelsHtml() {
    var sv = S.save, h = '<div class="ll-card ll-levels"><div class="ll-title">CAMPAIGN</div><div class="ll-grid">';
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i], open = i < sv.open, b = sv.best[i];
      h += '<button type="button" class="ll-lv' + (open ? '' : ' locked') + (i === sv.open - 1 && !b.g ? ' next' : '') + '" data-lv="' + i + '"' + (open ? '' : ' aria-disabled="true"') +
        ' aria-label="Level ' + (i + 1) + ' ' + esc(L.name) + (open ? (b.g ? ', best grade ' + gradeName(b.g) : '') : ', locked') + '">' +
        '<span class="ll-lvn">' + pad2(i + 1) + '</span>' + (open ? gradeBadge(b.g) : '<b class="ll-g ll-g0">#</b>') +
        '<span class="ll-lvt">' + (open ? esc(L.name) : 'locked') + '</span></button>';
    }
    h += '</div><div class="ll-note">' + campaignStars(sv) + ' / ' + LEVELS.length * 4 + ' stars &middot; S=4 A=3 B=2 C=1</div>';
    return h + '<div class="ll-btns">' + btn('home', 'Back', true) + '</div></div>';
  }
  function duelHtml() {
    var o = S.save.opt, d = S.save.duel, h = '<div class="ll-card ll-duel"><div class="ll-title">DUEL</div>';
    h += '<p>The same ' + DUEL_N + ' rounds for both pilots, taking turns. Most points wins (a crash scores 0).</p>';
    h += '<div class="ll-h">Opponent</div><div class="ll-chips">';
    ['easy', 'normal', 'hard'].forEach(function (k) {
      var on = o.opp === 'cpu' && o.cpu === k, r = d.cpu[k];
      h += '<button type="button" class="ll-chip' + (on ? ' on' : '') + '" data-opp="cpu" data-cpu="' + k + '" aria-pressed="' + on + '">CPU ' + SKILLS[k].name + '<i>' + r[0] + '-' + r[1] + '</i></button>';
    });
    var pv = o.opp === 'pvp';
    h += '<button type="button" class="ll-chip' + (pv ? ' on' : '') + '" data-opp="pvp" aria-pressed="' + pv + '">2 Players<i>' + d.pvp[0] + '-' + d.pvp[1] + '</i></button></div>';
    h += '<div class="ll-note">' + (pv ? 'Pass the device between turns' : SKILLS[o.cpu].name + ': ' + ({ easy: 'safe pads, shaky hands', normal: 'steady, picks good pads', hard: 'goes for x5, lands like a feather' })[o.cpu]) + '</div>';
    return h + '<div class="ll-btns">' + btn('duel-go', 'Start duel') + btn('home', 'Back', true) + '</div></div>';
  }
  function recordsHtml() {
    var sv = S.save, st = sv.stats, rows = [];
    for (var i = 0; i < LEVELS.length; i++) {
      var b = sv.best[i];
      rows.push(i < sv.open ? line(pad2(i + 1) + ' ' + LEVELS[i].name, (b.g ? b.g + ' ' : '') + (b.s ? fmtInt(b.s) : '-')) : '<i>' + pad2(i + 1) + ' ' + new Array(25).join('.') + '</i>');
    }
    rows.push('<i>' + new Array(29).join('-') + '</i>');
    rows.push(line('Endless best', sv.endless.score ? fmtInt(sv.endless.score) : '-'));
    rows.push(line('Most landings (run)', String(sv.endless.sorties)));
    rows.push(line('Flights', fmtInt(st.flights)));
    rows.push(line('Landings / crashes', st.landings + ' / ' + st.crashes));
    rows.push(line('Perfect landings', fmtInt(st.perfects)));
    var h = '<div class="ll-card ll-rec"><div class="ll-title">RECORDS</div><pre class="ll-tab">' + rows.join('\n') + '</pre>';
    h += '<div class="ll-foot">' + (S.resetArm ?
      '<span class="ll-confirm">Erase all progress?</span><span><button type="button" class="ll-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="ll-lnk" data-act="reset-no">Keep</button></span>' :
      '<span></span><button type="button" class="ll-lnk" data-act="reset">Reset progress</button>') + '</div>';
    return h + '<div class="ll-btns">' + btn('home', 'Back', true) + '</div></div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>&#9664; / &#9654;</b> &nbsp;rotate &nbsp;&middot;&nbsp; <b>THRUST</b> &nbsp;main engine</div><div>or hold the play field: <b>left / right</b> edge rotate, <b>middle</b> thrust</div>' +
      (typeof window.DeviceOrientationEvent !== 'undefined' ? '<div><b>Tilt to steer</b> (title screen): lean the phone to set the angle</div>' : '') :
      '<div><b>&larr; &rarr;</b> / A D &nbsp;rotate &nbsp;(<b>Shift</b> or &darr; for fine)</div><div><b>&uarr;</b> / W / <b>Space</b> &nbsp;main engine</div><div><b>gamepad</b> &nbsp;stick rotates, A or RT thrusts</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="ll-card ll-help">' +
      '<pre class="ll-art" aria-hidden="true">     /o\\\n     [=]\n     /V\\\n__/\\_=====_/\\_</pre>' +
      '<div class="ll-title">HOW TO LAND</div>' +
      '<div class="ll-keys">' + keys + '</div>' +
      '<p>Set down on a flat pad (<b class="ll-acc">=====</b>) with both feet. At touchdown you need:</p>' +
      '<pre class="ll-tab">' + line('down speed under', VY_SAFE.toFixed(1) + ' m/s', 26) + '\n' + line('sideways under', VX_SAFE.toFixed(1) + ' m/s', 26) + '\n' + line('tilt under', deg(ANG_SAFE) + ' deg', 26) + '</pre>' +
      '<p class="ll-tip">The HUD turns <b class="ll-ok">green</b> inside the limits, <b class="ll-warn">gold</b> near them, <b class="ll-bad">red</b> over. Gentler = better grade: <b>PERFECT</b> x3, <b>GREAT</b> x2, <b>GOOD</b> x1.5, <b>HARD</b> x1.</p>' +
      '<p class="ll-tip">Narrow pads pay more (<b>x2 &hellip; x5</b>). Arrows at the edge point to pads off screen &mdash; the moon wraps around. Fuel is precious: grab <b class="ll-gold">[F]</b> canisters. Wind (<b>&gt;&gt;</b>) pushes you; gusts come and go.</p>' +
      '<div class="ll-btns">' + btn(S.firstRun ? 'first' : 'back', S.firstRun ? 'Start the campaign' : 'Back', false) + '</div></div>';
  }
  function specRows(sp) {
    var rows = [line('Gravity', sp.g.toFixed(1) + ' m/s2'), line('Wind', windTxt(sp.wind, sp.gust)), line('Fuel', fmtInt(sp.fuel) + (sp.cans ? '  +' + sp.cans + ' [F]' : '')),
      line('Pads', sp.pads.slice().sort(function (a, b) { return a - b; }).map(function (m) { return 'x' + m; }).join(' '))];
    return rows.join('\n');
  }
  function briefHtml() {
    var sp = S.spec, h = '<div class="ll-card ll-brief">';
    if (S.mode === 'camp') {
      var b = S.save.best[S.level];
      h += '<div class="ll-title">LEVEL ' + (S.level + 1) + '</div><div class="ll-big">' + esc(sp.name) + '</div>';
      h += '<pre class="ll-tab">' + specRows(sp) + (b.g ? '\n' + line('Your best', b.g + '  ' + fmtInt(b.s)) : '') + '</pre>';
      h += '<div class="ll-btns">' + btn('launch', 'Launch') + btn('levels', 'Levels', true) + '</div>';
    } else {
      var E2 = S.E;
      h += '<div class="ll-title">SORTIE ' + (E2.k + 1) + '</div>';
      h += '<div class="ll-sub">score ' + fmtInt(E2.score) + ' &middot; hulls ' + new Array(E2.hulls + 1).join('A ') + '</div>';
      h += '<pre class="ll-tab">' + specRows(sp) + '</pre>';
      h += '<div class="ll-btns">' + btn('launch', 'Launch') + btn('home', 'Quit', true) + '</div>';
    }
    return h + '<div class="ll-note">' + (S.coarse ? 'Tap Launch' : 'Space to launch') + '</div></div>';
  }
  function resRows(r) {
    var rows = [];
    if (r.landed) {
      rows.push(line('Pad', 'x' + r.mult));
      rows.push(line('Grade', gradeName(r.grade) + ' x' + GRADES.filter(function (g) { return g.id === r.grade; })[0].mult));
    }
    rows.push(line('Down speed', Math.abs(r.vy).toFixed(1) + ' m/s', 28, Math.abs(r.vy) > VY_SAFE ? 'bad' : ''));
    rows.push(line('Sideways', Math.abs(r.vx).toFixed(1) + ' m/s', 28, Math.abs(r.vx) > VX_SAFE ? 'bad' : ''));
    rows.push(line('Tilt', deg(r.ang) + ' deg', 28, Math.abs(r.ang) > ANG_SAFE ? 'bad' : ''));
    rows.push(line('Fuel left', fmtInt(r.fuel)));
    if (r.landed && r.centre > 0.05) rows.push(line('Bullseye bonus', '+' + Math.round(50 * r.centre)));
    return rows.join('\n');
  }
  function resultHtml() {
    var r = S.res, cd = S.card, h = '<div class="ll-card ll-res">';
    if (S.mode === 'camp') {
      h += '<div class="ll-title">' + (r.landed ? 'THE EAGLE HAS LANDED' : 'CRASHED') + '</div>';
      h += r.landed ? '<div class="ll-big g' + r.grade + '">' + gradeName(r.grade) + '</div><div class="ll-score">' + fmtInt(r.score) + '</div>' : '<div class="ll-big bad">' + esc(r.reason) + '</div>';
      h += '<pre class="ll-tab">' + resRows(r) + '</pre>';
      if (cd.best) h += '<div class="ll-new">** new best score **</div>';
      if (cd.gradeUp) h += '<div class="ll-new">better grade!</div>';
      if (cd.unlocked) h += '<div class="ll-new">level ' + (S.level + 2) + ' unlocked: ' + esc(LEVELS[S.level + 1].name) + '</div>';
      var hasNext = r.landed && S.level + 1 < LEVELS.length;
      h += '<div class="ll-btns">' + (hasNext ? btn('next', 'Next level') : '') + btn('retry', r.landed ? 'Again' : 'Retry', hasNext) + btn('levels', 'Levels', true) + '</div>';
      if (r.landed && S.level + 1 >= LEVELS.length) h += '<div class="ll-note">Campaign complete &mdash; chase an S on every level.</div>';
    } else {
      var E2 = S.E;
      h += '<div class="ll-title">SORTIE ' + E2.k + (r.landed ? ' LANDED' : ' LOST') + '</div>';
      h += r.landed ? '<div class="ll-big g' + r.grade + '">' + gradeName(r.grade) + ' +' + fmtInt(r.score) + '</div>' : '<div class="ll-big bad">' + esc(r.reason) + '</div>';
      h += '<pre class="ll-tab">' + resRows(r) + '\n<i>' + new Array(29).join('-') + '</i>\n' +
        (r.landed ? line('Refuel', '+' + cd.fuelB, 28, 'g') : line('Hull lost, fuel', '-100', 28, 'bad')) + '\n' + line('Total', fmtInt(E2.score)) + '\n' + line('Hulls', String(E2.hulls)) + '</pre>';
      h += '<div class="ll-btns">' + btn('sortie', 'Next sortie') + btn('home', 'Quit', true) + '</div>';
    }
    return h + '</div>';
  }
  function overHtml() {
    var E2 = S.E, h = '<div class="ll-card ll-over"><div class="ll-title">MISSION OVER</div>';
    h += '<div class="ll-big">' + fmtInt(E2.score) + '</div>';
    h += S.card.rec.best ? '<div class="ll-new">** new best **</div>' : '<div class="ll-sub">best ' + fmtInt(S.save.endless.score) + '</div>';
    h += '<pre class="ll-tab">' + line('Sorties flown', String(E2.k)) + '\n' + line('Landings', String(E2.landings)) + '\n' + line('Perfect', String(E2.perfects)) + '\n' +
      line('Log', E2.log.join(' ')) + '\n' + line('Ended by', E2.hulls <= 0 ? 'no hulls left' : 'out of fuel') + '</pre>';
    return h + '<div class="ll-btns">' + btn('endless', 'Fly again') + btn('home', 'Home', true) + '</div></div>';
  }
  function boardHtml() {
    var D = S.D, rows = [], t = duelTotals(D), w = 8;
    rows.push('<i>' + 'Round   ' + padL(who(0, true), w) + padL(who(1, true), w) + '</i>');
    for (var k = 0; k < DUEL_N; k++) {
      var a = D.scores[0][k], b = D.scores[1][k];
      rows.push((k === D.k && !D.over ? '<b>' : '') + '  ' + (k + 1) + '     ' + padL(a == null ? '.' : a ? fmtInt(a) : 'X', w) + padL(b == null ? '.' : b ? fmtInt(b) : 'X', w) + (k === D.k && !D.over ? '</b>' : ''));
    }
    rows.push('<i>' + new Array(25).join('-') + '</i>');
    rows.push('<b>Total   ' + padL(fmtInt(t[0]), w) + padL(fmtInt(t[1]), w) + '</b>');
    return '<pre class="ll-tab ll-board">' + rows.join('\n') + '</pre>';
  }
  function padL(s, w) { s = String(s); return new Array(Math.max(0, w - s.length) + 1).join(' ') + s; }
  function turnHtml() {
    var r = S.res, cd = S.card, h = '<div class="ll-card ll-turn">';
    h += '<div class="ll-title">' + esc(who(cd.turn).toUpperCase()) + '</div>';
    h += r.landed ? '<div class="ll-big g' + r.grade + '">' + gradeName(r.grade) + ' x' + r.mult + ' &middot; ' + fmtInt(r.score) + '</div>' : '<div class="ll-big bad">' + esc(r.reason) + '</div>';
    h += boardHtml();
    return h + nextTurnBit() + '</div>';
  }
  function nextTurnBit() {
    var D = S.D;
    if (D.turn === 1 && D.cpu) return '<div class="ll-sub">' + esc(who(1)) + ' flies round ' + (D.k + 1) + '</div><div class="ll-btns">' + btn('cpu-watch', 'Watch') + btn('cpu-skip', 'Skip', true) + '</div>';
    return '<div class="ll-sub">Round ' + (D.k + 1) + ' next: ' + esc(who(D.turn)) + '</div><div class="ll-btns">' + btn('turn-next', 'Continue') + btn('home', 'Quit', true) + '</div>';
  }
  // Before each human turn: who's up (a pass-the-device screen in 2-player mode) and the round.
  function handoffHtml() {
    var D = S.D, sp = S.spec, h = '<div class="ll-card ll-hand">';
    if (D.turn === 1 && D.cpu) return '<div class="ll-card"><div class="ll-title">ROUND ' + (D.k + 1) + '</div>' + boardHtml() + nextTurnBit() + '</div>';
    h += '<div class="ll-title">ROUND ' + (D.k + 1) + ' OF ' + DUEL_N + '</div>';
    if (!D.cpu) h += '<div class="ll-pass ' + (D.turn ? 'p2' : 'p1') + '">Pass to ' + who(D.turn) + '<span>tap when ready</span></div>';
    else h += '<div class="ll-big">Your turn</div>';
    h += '<pre class="ll-tab">' + specRows(sp) + '</pre>';
    if (D.k > 0 || D.turn > 0) h += boardHtml();
    return h + '<div class="ll-btns">' + btn('launch', who(D.turn) + ': launch') + btn('home', 'Quit', true) + '</div></div>';
  }
  function finalHtml() {
    var D = S.D, w = S.card.w, t = duelTotals(D), h = '<div class="ll-card ll-final"><div class="ll-title">DUEL OVER</div>';
    h += '<div class="ll-big">' + (w < 0 ? 'A draw!' : esc(who(w)) + ' wins') + '</div>';
    h += '<div class="ll-sub">' + fmtInt(t[0]) + ' &ndash; ' + fmtInt(t[1]) + '</div>' + boardHtml();
    if (D.cpu) { var r = S.save.duel.cpu[D.cpu]; h += '<div class="ll-note">vs ' + esc(SKILLS[D.cpu].name) + ': ' + r[0] + ' won, ' + r[1] + ' lost' + (r[2] ? ', ' + r[2] + ' drawn' : '') + '</div>'; }
    else { var p = S.save.duel.pvp; h += '<div class="ll-note">P1 ' + p[0] + ' &middot; P2 ' + p[1] + (p[2] ? ' &middot; draws ' + p[2] : '') + '</div>'; }
    return h + '<div class="ll-btns">' + btn('duel-go', 'Rematch') + btn('home', 'Home', true) + '</div></div>';
  }
  function pauseHtml() {
    var f = S.f;
    return '<div class="ll-card ll-pause"><div class="ll-title">PAUSED</div>' +
      '<div class="ll-sub">' + esc(S.hudInfo) + '</div>' +
      '<pre class="ll-tab">' + line('Altitude', Math.round(Math.max(0, f.alt)) + ' m') + '\n' + line('Fuel', fmtInt(f.fuel)) + '</pre>' +
      '<div class="ll-btns">' + btn('resume', 'Resume') + btn('abandon', S.mode === 'camp' ? 'Restart' : S.cpuTurn ? 'Skip' : 'Abort', true) + btn('home', 'Home', true) + '</div>' +
      '<div class="ll-note">' + (S.coarse ? 'Tap Resume to carry on' : 'P / Esc to resume') + '</div></div>';
  }
  // The pad's primary action for each card (Space / Enter / gamepad A do it too).
  var PRIMARY = {
    home: ['go-camp', ''], levels: ['go-camp', ''], 'duel-setup': ['duel-go', 'Start duel'], records: ['home', 'Back'], help: ['back', 'Back'],
    brief: ['launch', 'Launch'], result: ['_res', ''], over: ['endless', 'Fly again'], turn: ['_turn', ''], handoff: ['_hand', ''], final: ['duel-go', 'Rematch'], pause: ['resume', 'Resume']
  };
  function primaryOf(kind) {
    var p = PRIMARY[kind];
    if (!p) return null;
    if (kind === 'help' && S.firstRun) return ['first', 'Start'];
    if (p[0] === 'go-camp') return ['go-camp', 'Fly level ' + Math.min(S.save.open, LEVELS.length)];
    if (p[0] === '_res') {
      if (S.mode === 'camp') return S.res.landed && S.level + 1 < LEVELS.length ? ['next', 'Next level'] : ['retry', 'Retry'];
      return ['sortie', 'Next sortie'];
    }
    if (p[0] === '_turn' || p[0] === '_hand') {
      var D = S.D;
      if (D.turn === 1 && D.cpu) return ['cpu-watch', 'Watch CPU'];
      return p[0] === '_turn' ? ['turn-next', 'Continue'] : ['launch', 'Ready'];
    }
    return p;
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = '';
    switch (kind) {
      case 'home': h = homeHtml(); break;
      case 'levels': h = levelsHtml(); break;
      case 'duel-setup': h = duelHtml(); break;
      case 'records': h = recordsHtml(); break;
      case 'help': h = helpHtml(); break;
      case 'brief': h = briefHtml(); break;
      case 'result': h = resultHtml(); break;
      case 'over': h = overHtml(); break;
      case 'turn': h = turnHtml(); break;
      case 'handoff': h = handoffHtml(); break;
      case 'final': h = finalHtml(); break;
      case 'pause': h = pauseHtml(); break;
    }
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.ovl.scrollTop = 0;
    S.stage.classList.toggle('dim', !!kind && kind !== 'brief' && kind !== 'handoff');
    S.stage.classList.toggle('lite', kind === 'brief' || kind === 'handoff');
    S.stage.classList.toggle('pass', kind === 'handoff' && !!S.D && !S.D.cpu);
    // back from a sub-card (Esc)
    S.back = kind === 'levels' || kind === 'duel-setup' || kind === 'records' || (kind === 'help' && !S.firstRun) ? function () { act(kind === 'help' ? 'back' : 'home'); } :
      kind === 'brief' ? function () { act(S.mode === 'camp' ? 'levels' : 'home'); } : null;
    if (kind) { var p = primaryOf(kind); setPad('card', p); }
    S.prevCard = kind && kind !== 'help' ? kind : S.prevCard;
  }
  function primary() {
    if (!S) return;
    if (S.paused) { resume(); return; }
    if (S.phase === 'fly') return;
    var p = primaryOf(S.cardKind);
    if (p) act(p[0]);
  }
  function setPad(mode, p) {
    var h;
    S.padMode = mode;
    if (mode === 'fly') {
      h = '<button type="button" class="ll-hold rot" data-k="l" aria-label="Rotate left">&#9664;</button>' +
        '<button type="button" class="ll-hold thr" data-k="t" aria-label="Thrust">Thrust</button>' +
        '<button type="button" class="ll-hold rot" data-k="r" aria-label="Rotate right">&#9654;</button>';
    } else if (mode === 'cpu') {
      h = '<button type="button" class="ll-act alt" data-act="cpu-fast">' + (S.cpuFast > 1 ? 'Speed x' + S.cpuFast : 'Faster') + '</button>' +
        '<button type="button" class="ll-act" data-act="cpu-skip">Skip</button>';
    } else {
      h = p ? '<button type="button" class="ll-act" data-act="' + p[0] + '">' + esc(p[1]) + (S.coarse ? '' : ' <small>space</small>') + '</button>' : '';
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'fly') return;
    var bs = S.pad.querySelectorAll('[data-k]');
    for (var i = 0; i < bs.length; i++) {
      var k = bs[i].getAttribute('data-k');
      bs[i].classList.toggle('on', heldK(k) || (k === 't' && S.gp.thr > 0.3) || (k === 'l' && S.gp.rot < -0.3) || (k === 'r' && S.gp.rot > 0.3));
    }
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'fly';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncLabel() {
    S.cv.setAttribute('aria-label', 'Lunar Lander — campaign ' + campaignStars(S.save) + ' stars. Arrow keys rotate, up or space fires the engine; land slowly and level on a pad.');
  }

  // Every button's action.
  function act(a) {
    if (!S) return;
    S.snd.ensure();
    switch (a) {
      case 'go-camp': startLevel(S.save.open - 1); break;
      case 'levels':
        if (S.phase === 'fly') return;
        if (S.mode) { S.mode = null; demoScene(); }
        S.phase = 'home'; showCard('levels'); break;
      case 'endless': startEndless(); break;
      case 'duel-setup': showCard('duel-setup'); break;
      case 'duel-go': startDuel(); break;
      case 'records': S.resetArm = false; showCard('records'); break;
      case 'help': showCard('help'); break;
      case 'back': showCard(S.prevCard && S.prevCard !== 'help' ? S.prevCard : 'home'); break;
      case 'first': S.firstRun = false; startLevel(0); break;
      case 'home': toHome(); break;
      case 'launch':
        if (S.mode === 'duel' && S.D.turn === 1 && S.D.cpu) { launch(true); break; }
        launch(false); break;
      case 'next': startLevel(S.level + 1); break;
      case 'retry': startLevel(S.level); break;
      case 'sortie': nextSortie(); break;
      case 'turn-next': nextTurn(); break;
      case 'cpu-watch': prepFlight(duelSpec(S.D)); launch(true); break;
      case 'cpu-skip':
        if (S.phase !== 'fly') { prepFlight(duelSpec(S.D)); S.cpuTurn = true; var sk = SKILLS[S.D.cpu]; S.apFn = function (f) { return autopilot(f, sk); }; }
        skipCpu(); break;
      case 'cpu-fast': S.cpuFast = S.cpuFast >= 4 ? 1 : S.cpuFast * 2; setPad('cpu'); break;
      case 'resume': resume(); break;
      case 'abandon': abandon(); break;
      case 'tilt': setTilt(!S.save.opt.tilt); showCard('home'); break;
      case 'reset': S.resetArm = true; showCard('records'); break;
      case 'reset-no': S.resetArm = false; showCard('records'); break;
      case 'reset-yes':
        S.save = newSave(); persist(); S.resetArm = false;
        Cade.showToast && Cade.showToast('Progress reset', 'info', 1800);
        toHome(); break;
    }
    syncHead();
    if (S.phase !== 'fly') draw(1, 0);
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 190 : 210);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + 36;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    VW = phone ? 300 : VIEW_W;                     // a narrower view on phones: bigger glyphs
    S.hc = VW < 340 ? [6, 60, 118, 176, 222, 6] : [6, 72, 140, 206, 258, 10];
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.6 : 1.4), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 300) { s = Math.max(0.55, Math.min(s, ah / 300)); vh2 = 300; }
    vh2 = Math.min(vh2, phone ? 560 : solo ? 440 : 380);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--ll-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.phase === 'fly' && !S.paused && S.raf) return; draw(1, 0); }

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
    window.removeEventListener('deviceorientation', onTilt);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
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
    var body = '<div class="ll"><div class="ll-stage"><canvas class="ll-cv"></canvas><div class="ll-ovl" style="display:none"></div></div>' +
      '<div class="ll-pad"></div><div class="ll-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🚀 Lunar Lander', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'll-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="Title screen" aria-label="Title screen">' + IC_HOME + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.ll-stage'), cv: p.querySelector('.ll-cv'), ovl: p.querySelector('.ll-ovl'),
      pad: p.querySelector('.ll-pad'), liveEl: p.querySelector('.ll-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', mode: null, f: null, spec: null, paused: false, raf: 0, last: 0, idleT: 0,
      keys: {}, ptrs: {}, gp: { rot: 0, thr: 0, start: false, menuA: false }, gpT: 0, tilt: { on: false, has: false, target: 0 },
      pal: new Array(NPAL), hc: [6, 72, 140, 206, 258, 10], col: null, atl: null, k: 1, VH: 300, v: {}, pts: new Float32Array(1200),
      shake: 0, flash: 0, exT: 0, warnT: 0, msg: null, msgQ: [], cpuTurn: false, cpuFast: 1, apFn: null,
      E: null, D: null, level: 0, res: null, card: null, cardKind: null, prevCard: null, back: null, resetArm: false, padMode: '', hudInfo: '', pilotCol: C_ACC
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    S.tilt.on = S.save.opt.tilt && S.coarse;
    window.addEventListener('deviceorientation', onTilt);
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

    // header: home / help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        if (!S.snd.on) S.snd.engine(0);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'fly') pause();
        if (S.cardKind === 'help') act('back');
        else if (!S.paused) showCard('help');
        else { S.paused = true; S.cardKind = 'help'; S.ovl.innerHTML = helpHtml(); S.back = function () { showCard('pause'); }; setPad('card', ['resume', 'Resume']); }
      } else if (h === 'home') {
        if (S.phase === 'fly') { pause(); return; }
        toHome();
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout (see duskdash.css):
    // the hold surfaces cancel their touches outright and the panel swallows gesture / dblclick.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field: left edge rotates left, right edge rotates right, the middle thrusts
    function zoneOf(e) {
      var r = S.cv.getBoundingClientRect(), u = (e.clientX - r.left) / (r.width || 1);
      return u < 0.3 ? 'l' : u > 0.7 ? 'r' : 't';
    }
    function press(e, k) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'fly' || S.paused || S.cpuTurn) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = k; syncPad();
    }
    function release(e) {
      if (!S) return;
      if (S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); }
    }
    S.cv.addEventListener('pointerdown', function (e) { press(e, zoneOf(e)); });
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (b) press(e, b.getAttribute('data-k'));
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, release); S.pad.addEventListener(t, release); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) act(b.getAttribute('data-act'));
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) {
        // the pass-the-device screen: a tap anywhere on it is "ready"
        if (S.cardKind === 'handoff' && S.D && !S.D.cpu && e.target.closest && e.target.closest('.ll-pass')) act('launch');
        return;
      }
      S.snd.ensure();
      var lv = b.getAttribute('data-lv'), opp = b.getAttribute('data-opp'), a = b.getAttribute('data-act');
      if (lv != null) {
        var i = +lv;
        if (i < S.save.open) { S.snd.tone(988, 0.05, 'sine', 0.03); startLevel(i); draw(1, 0); }
        else Cade.showToast && Cade.showToast('Land on level ' + i + ' to unlock', 'info', 1600);
        return;
      }
      if (opp) {
        S.save.opt.opp = opp;
        if (opp === 'cpu') S.save.opt.cpu = b.getAttribute('data-cpu');
        persist(); S.snd.tone(988, 0.05, 'sine', 0.03);
        showCard('duel-setup');
        var nb = e.detail === 0 && S.ovl.querySelector('[data-opp="' + opp + '"]' + (opp === 'cpu' ? '[data-cpu="' + S.save.opt.cpu + '"]' : ''));
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      if (a) act(a);
    });

    if (S.firstRun) {
      demoScene();
      S.phase = 'home';
      showCard('help'); syncHead(); syncLabel();
    } else { toHome(); syncHead(); syncLabel(); }
    draw(1, 0);
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Thrust and rotate onto the landing pad — mind the fuel and your legs. Campaign, endless and duels vs CPU or a friend',
    icon: '🚀',
    tags: 'game,arcade,fun,lander,space,physics,thrust,moon,lunar,gravity,campaign,2 player,vs cpu,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
