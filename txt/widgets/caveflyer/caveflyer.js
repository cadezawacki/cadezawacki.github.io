/* Cave Flyer — a one-button cave run, for Cade.txt.
 * Hold (anywhere on the play field, the big pad button, Space / ↑ / W, a
 * gamepad's A) to fire the thruster and rise; let go and the craft falls.
 * The craft has momentum: thrust and gravity change its climb rate, never
 * the speed itself in one frame. Thread a procedurally generated cave that
 * narrows and wiggles harder the deeper you go, past hanging stalactite
 * blocks, rising stalagmites and (later) floating slabs. Grab coins ($),
 * fuel cans (F — the tank drains, faster while you thrust) and the odd
 * shield (O). Skim the rock without touching it for NEAR MISS bonuses that
 * chain into a combo. Every 250 m is a new zone with its own rock colour.
 * Coins buy craft glyphs, colours and trails in the Hangar.
 * Three modes (Calm / Normal / Wild) with their own records.
 * Drawn entirely in monospace glyphs (cached in a glyph atlas) on a canvas.
 * Physics runs on a fixed 120 Hz step with an accumulator and the cave walls
 * are analytic (cosine-interpolated nodes plus a little rock texture), so a
 * flight is identical at 60 or 120 Hz; rendering interpolates. The loop runs
 * only while a run is on screen; it pauses on blur, tab hide and minimize.
 * Progress persists in Cade.store (cade-caveflyer-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: logical pixels (1 m = 10 units). x → right, y → up.
  var STEP = 1 / 120;
  var G = 560;                 // gravity (units/s²)
  var THRUST = 1250;           // thruster acceleration while held
  var DRAG = 1.5;              // linear vertical drag (1/s): soft terminal climb / fall speeds
  var VY_MAX = 380;
  var R = 5;                   // craft hit radius
  var NEAR = 11;               // clearance (beyond the hit radius) that counts as a near miss
  var FUEL_MAX = 100, FUEL_CAN = 40, DRAIN = 1.3, DRAIN_HOLD = 2.0, SPUTTER = 0.3;
  var ZONE_W = 2500;           // 250 m per zone
  var START_CLEAR = 650;       // no obstacles before this x
  var DEATH_T = 1.0;           // seconds of wreckage before the run is done
  var SHIELD_INV = 1.2;
  var R_COIN = 8, R_ITEM = 10;

  var MODES = {
    calm: { id: 'calm', name: 'Calm', v0: 88, v1: 150, g0: 210, g1: 104, ramp: 16000, pass0: 84, pass1: 58, blk0: 0.16, blk1: 0.5, fuel: 0.8, coin: 1, info: 'roomy cave, gentle speed' },
    normal: { id: 'normal', name: 'Normal', v0: 100, v1: 178, g0: 190, g1: 90, ramp: 12000, pass0: 78, pass1: 52, blk0: 0.2, blk1: 0.62, fuel: 1, coin: 1, info: 'the real thing' },
    wild: { id: 'wild', name: 'Wild', v0: 118, v1: 215, g0: 172, g1: 80, ramp: 9000, pass0: 72, pass1: 48, blk0: 0.26, blk1: 0.72, fuel: 1.15, coin: 1.5, info: 'fast and tight, x1.5 coins' }
  };
  var MODE_IDS = ['calm', 'normal', 'wild'];

  var ZONES = ['The Mouth', 'Drip Hall', 'The Narrows', 'Glowworm Run', 'Crystal Throat', 'The Gullet', 'Echo Deep', 'Lantern Vault', 'The Wringer', 'Abyss Gate'];

  // The hangar. price: coins; or need: an achievement (best key ≥ n) instead.
  var BODIES = [
    { id: 'dart', name: 'Dart', s: '>', price: 0 },
    { id: 'jet', name: 'Jet', s: '=>', price: 60 },
    { id: 'saucer', name: 'Saucer', s: '<o>', price: 150 },
    { id: 'rocket', name: 'Rocket', s: '}=>', price: 260 },
    { id: 'bee', name: 'Bee', s: '8>', price: 400 },
    { id: 'pod', name: 'Pod', s: '[]>', price: 600 },
    { id: 'wing', name: 'Wing', s: '>-', price: 850 },
    { id: 'comet', name: 'Comet', s: '@', price: 1200 },
    { id: 'ghost', name: 'Ghost', s: '%>', need: 'combo', n: 6, how: 'a x6 near-miss combo' },
    { id: 'ace', name: 'Ace', s: '<A>', need: 'dist', n: 1500, how: 'fly 1,500 m' }
  ];
  var COLORS = [
    { id: 'ink', name: 'Ink', price: 0 },
    { id: 'accent', name: 'Accent', price: 0 },
    { id: 'gold', name: 'Gold', price: 50 },
    { id: 'coral', name: 'Coral', price: 100 },
    { id: 'sky', name: 'Sky', price: 160 },
    { id: 'ember', name: 'Ember', price: 250 },
    { id: 'leaf', name: 'Leaf', price: 350 },
    { id: 'violet', name: 'Violet', price: 500 },
    { id: 'rainbow', name: 'Rainbow', price: 1500 }
  ];
  var TRAILS = [
    { id: 'none', name: 'None', s: '', price: 0 },
    { id: 'dots', name: 'Dots', s: '.', price: 0 },
    { id: 'dash', name: 'Dashes', s: '-', price: 40 },
    { id: 'smoke', name: 'Smoke', s: '~', price: 120 },
    { id: 'stars', name: 'Stars', s: '*+', price: 220 },
    { id: 'binary', name: 'Binary', s: '01', price: 400 },
    { id: 'exhaust', name: 'Exhaust', s: '=-', price: 600 },
    { id: 'sparkle', name: 'Sparkle', s: "*'.+", price: 800, multi: true }
  ];
  var HANGAR = { body: BODIES, color: COLORS, trail: TRAILS };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Small seeded PRNG (mulberry32) and an integer hash, so a run is reproducible.
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

  // ---- the cave: nodes (x, centre, gap) with cosine interpolation between ----
  // Both the centre line and the gap are C¹ smooth (zero slope at each node);
  // a small two-sine "rock texture" eats into the walls on top of that. The
  // walls the renderer draws are exactly the walls the craft collides with.
  function newCave(seed, mode) {
    var m = MODES[mode] || MODES.normal, r = rng(hash2(seed, 77));
    var c = {
      seed: seed >>> 0, m: m, xs: [-600, 380], cy: [0, 0], gp: [m.g0, m.g0], j: 0, r: r,
      ph: [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283],
      blocks: [], items: [], lastBlock: -1e9, nextFuel: 1100, nextShield: 2400, segN: 0, ccy: 0, cgp: 0
    };
    ensure(c, 1600);
    return c;
  }
  function rampAt(c, x) { return clamp(x / c.m.ramp, 0, 1); }
  function speedAt(m, x) { var k = clamp(x / m.ramp, 0, 1); return lerp(m.v0, m.v1, k * (2 - k)); }
  function ensure(c, x) { while (c.xs[c.xs.length - 1] < x) genSeg(c); }
  function genSeg(c) {
    var n = c.xs.length, lx = c.xs[n - 1], lcy = c.cy[n - 1], r = c.r, m = c.m, k = rampAt(c, lx);
    var w = (lerp(160, 80, k) + r() * lerp(60, 40, k)) * Math.max(1, m.v1 / 178);   // faster modes stretch the cave: the same wiggle in time
    var A = lerp(34, 135, k), maxS = lerp(0.32, 0.78, k);
    var d = (r() * 2 - 1) * A - lcy * 0.12;
    d = clamp(d, -maxS * w, maxS * w);
    var g = lerp(m.g0, m.g1, k) * (0.88 + 0.26 * r());
    c.xs.push(lx + w); c.cy.push(lcy + d); c.gp.push(g);
    c.segN++;
    dress(c, lx, lx + w);
  }
  function seg(c, x) {
    var xs = c.xs, j = c.j, n = xs.length - 2;
    if (j > n || x < xs[j] || (j + 8 <= n && x >= xs[j + 8])) {   // a jump: binary search
      var lo = 0, hi = n;
      while (lo < hi) { var mm = (lo + hi + 1) >> 1; if (xs[mm] <= x) lo = mm; else hi = mm - 1; }
      j = lo;
    }
    while (j < n && x >= xs[j + 1]) j++;
    c.j = j;
    return j;
  }
  // Centre and gap at x (left in c.ccy / c.cgp).
  function shape(c, x) {
    var xs = c.xs;
    if (x <= xs[0]) { c.ccy = c.cy[0]; c.cgp = c.gp[0]; return; }
    var j = seg(c, x), x0 = xs[j], x1 = xs[j + 1];
    if (x >= x1) { c.ccy = c.cy[j + 1]; c.cgp = c.gp[j + 1]; return; }
    var u = (1 - Math.cos(Math.PI * (x - x0) / (x1 - x0))) / 2;
    c.ccy = c.cy[j] + (c.cy[j + 1] - c.cy[j]) * u;
    c.cgp = c.gp[j] + (c.gp[j + 1] - c.gp[j]) * u;
  }
  function rough(c, x, s) {
    var p = c.ph;
    return 2.6 + 2.6 * Math.sin(x * 0.061 + p[s]) + 1.3 + 1.3 * Math.sin(x * 0.143 + p[s + 2]);
  }
  function ceilAt(c, x) { shape(c, x); return c.ccy + c.cgp / 2 - rough(c, x, 0); }
  function floorAt(c, x) { shape(c, x); return c.ccy - c.cgp / 2 + rough(c, x, 1); }
  function midAt(c, x) { return (ceilAt(c, x) + floorAt(c, x)) / 2; }
  function zoneAt(x) { return Math.max(0, Math.floor(x / ZONE_W)); }
  // The tightest wall extents over [x0, x1].
  function spanMin(c, x0, x1) {
    var lo = -1e9, hi = 1e9;
    for (var x = x0; x <= x1 + 0.01; x += 2) { var ce = ceilAt(c, x), fl = floorAt(c, x); if (ce < hi) hi = ce; if (fl > lo) lo = fl; }
    return { ceil: hi, floor: lo };
  }

  // Obstacles and pickups for the segment [lx, rx].
  function dress(c, lx, rx) {
    var r = c.r, m = c.m, k = rampAt(c, lx), w = rx - lx, placed = null;
    var gapMin = lerp(300, 150, k) * (m.id === 'wild' ? 0.9 : m.id === 'calm' ? 1.15 : 1);
    if (lx > START_CLEAR && r() < lerp(m.blk0, m.blk1, k)) {
      var bw = (r() < 0.5 ? 2 : 3) * 8, bx = lx + w * (0.25 + 0.5 * r());
      if (bx - c.lastBlock >= gapMin) {
        var sp = spanMin(c, bx - 2, bx + bw + 2), avail = sp.ceil - sp.floor, pass = lerp(m.pass0, m.pass1, k), b = null;
        var sp2p = Math.max(4 * R + 22, pass * 0.75), h = 12 * (r() < 0.6 ? 1 : 2);
        if (k > 0.25 && avail > 2 * sp2p + h && r() < 0.35) {          // a floating slab: a way past on both sides
          var y0 = sp.floor + sp2p + r() * (avail - 2 * sp2p - h);
          b = { x0: bx, x1: bx + bw, y0: y0, y1: y0 + h, t: 'slab' };
        } else if (avail - pass >= 12) {
          var L = Math.max(12, Math.floor((avail - pass) * (0.45 + 0.55 * r()) / 12) * 12);
          if (r() < 0.5) b = { x0: bx, x1: bx + bw, y0: sp.ceil - L, y1: sp.ceil + 400, t: 'top' };
          else b = { x0: bx, x1: bx + bw, y0: sp.floor - 400, y1: sp.floor + L, t: 'bot' };
        }
        if (b) { b.near = 1e9; c.blocks.push(b); c.lastBlock = bx + bw; placed = b; }
      }
    }
    var it = c.items;
    // pickups (never inside rock or a block)
    function safeY(x, y) {
      var ce = ceilAt(c, x) - 12, fl = floorAt(c, x) + 12;
      return clamp(y, fl, Math.max(fl, ce));
    }
    if (lx > 300) {
      if (placed && r() < 0.5) {
        // coins in the pass beside the block: risk for reward
        var bp = placed, sp2 = spanMin(c, bp.x0, bp.x1), py;
        if (bp.t === 'top') py = (sp2.floor + bp.y0) / 2;
        else if (bp.t === 'bot') py = (sp2.ceil + bp.y1) / 2;
        else py = r() < 0.5 ? (sp2.floor + bp.y0) / 2 : (sp2.ceil + bp.y1) / 2;
        for (var q = 0; q < 3; q++) { var qx = bp.x0 - 14 + q * (bp.x1 - bp.x0 + 28) / 2; it.push({ k: 'coin', x: qx, y: safeY(qx, py), hit: false }); }
      } else if (!placed && r() < 0.6) {
        var n = 5 + Math.floor(r() * 4), x0 = lx + w * 0.15, sp3 = 16 + r() * 4, amp = 6 + r() * 18, ph = r() * 6.28;
        shape(c, x0);
        var off = (r() * 2 - 1) * Math.max(0, c.cgp / 2 - 30) * 0.6;
        for (var i = 0; i < n; i++) {
          var cx = x0 + i * sp3;
          if (cx > rx - 4) break;
          it.push({ k: 'coin', x: cx, y: safeY(cx, midAt(c, cx) + off + amp * Math.sin(ph + i * 0.7)), hit: false });
        }
      }
    }
    if (!placed && lx >= c.nextFuel) {
      var fx = lx + w * 0.6;
      it.push({ k: 'fuel', x: fx, y: safeY(fx, midAt(c, fx) + (r() * 2 - 1) * 14), hit: false });
      c.nextFuel = fx + lerp(950, 1250, k) * (0.85 + 0.3 * r());
    }
    if (!placed && lx >= c.nextShield && r() < 0.35) {
      var sx = lx + w * 0.4;
      it.push({ k: 'shield', x: sx, y: safeY(sx, midAt(c, sx)), hit: false });
      c.nextShield = sx + 3000 + r() * 2500;
    }
  }

  // ---- a run ----
  function newRun(seed, mode) {
    var c = newCave(seed, mode);
    var f = {
      seed: seed >>> 0, mode: c.m.id, c: c, phase: 'ready', x: 0, y: 0, vy: 0, vx: c.m.v0, px: 0, py: 0,
      t: 0, acc: 0, steps: 0, hold: false, thrust: false,
      fuel: FUEL_MAX, lowWarned: false, shield: 0, inv: 0,
      score: 0, bonus: 0, dist: 0, coins: 0, near: 0, combo: 0, comboT: 0, bestCombo: 0, graze: 0, minCl: 1e9, cl: 1e9,
      zone: 0, fuelGot: 0, shields: 0, cause: '', hitB: null, deathT: 0, bi: 0, ii: 0,
      cam: 0, pcam: 0, events: [], hits: [], lastGain: 0, plk: 0, plh: false
    };
    f.cam = f.pcam = camTarget(f);
    return f;
  }
  function camTarget(f) { return 0.5 * f.y + 0.5 * midAt(f.c, f.x + 130); }

  // Does the craft's circle at (x, y) touch rock or a block? Also the clearance.
  var SAMP = [-1, -0.6, 0, 0.6, 1];
  function probe(f, x, y) {
    var c = f.c, cl = 1e9, i, hit = false;
    for (i = 0; i < SAMP.length; i++) {
      var sx = x + SAMP[i] * R, dy = R * Math.sqrt(1 - SAMP[i] * SAMP[i]);
      var a = ceilAt(c, sx) - (y + dy), b = (y - dy) - floorAt(c, sx);
      if (a < cl) cl = a;
      if (b < cl) cl = b;
    }
    f.hitB = null;
    if (cl <= 0) { hit = true; f.cause = 'rock'; }
    var B = c.blocks;
    while (f.bi < B.length && B[f.bi].x1 < x - 80) f.bi++;
    for (i = f.bi; i < B.length; i++) {
      var bk = B[i];
      if (bk.x0 > x + 80) break;
      var dx = x < bk.x0 ? bk.x0 - x : x > bk.x1 ? x - bk.x1 : 0, dyy = y < bk.y0 ? bk.y0 - y : y > bk.y1 ? y - bk.y1 : 0;
      var d = Math.sqrt(dx * dx + dyy * dyy) - R;
      if (d < bk.near) bk.near = d;
      if (d < cl) cl = d;
      if (d <= 0 && !hit) { hit = true; f.cause = 'block'; f.hitB = bk; }
    }
    f.cl = cl;
    return hit;
  }

  // One fixed physics step. hold: thruster on this step.
  function stepRun(f, hold) {
    var dt = STEP, ev = f.events, c = f.c;
    hold = !!hold; f.hold = hold;
    f.px = f.x; f.py = f.y; f.pcam = f.cam;
    f.steps++;
    if (f.phase === 'done') return;
    if (f.phase === 'ready') {
      if (!hold) return;
      f.phase = 'run'; ev.push('start');
    }
    if (f.phase === 'dead') {
      f.t += dt; f.deathT += dt;
      f.vy -= G * 0.6 * dt; f.y += f.vy * dt * 0.25;
      if (f.deathT >= DEATH_T) { f.phase = 'done'; ev.push('done'); }
      return;
    }
    f.t += dt;
    var m = c.m;
    // fuel: drains always, faster under thrust; an empty tank only sputters
    var had = f.fuel > 0;
    f.fuel -= (DRAIN + (hold ? DRAIN_HOLD : 0)) * m.fuel * dt;
    if (f.fuel <= 0) { f.fuel = 0; if (had) ev.push('empty'); }
    if (f.fuel < 25 && !f.lowWarned) { f.lowWarned = true; ev.push('fuellow'); }
    if (f.fuel > 40) f.lowWarned = false;
    f.thrust = hold;
    var th = hold ? THRUST * (f.fuel > 0 ? 1 : SPUTTER) : 0;
    f.vy += (th - G - DRAG * f.vy) * dt;
    f.vy = clamp(f.vy, -VY_MAX, VY_MAX);
    f.vx = speedAt(m, f.x);
    f.x += f.vx * dt; f.y += f.vy * dt;
    ensure(c, f.x + 900);
    if (f.inv > 0) f.inv = Math.max(0, f.inv - dt);
    if (probe(f, f.x, f.y)) {
      if (f.inv > 0) {
        bounce(f);
      } else if (f.shield > 0) {
        f.shield = 0; f.inv = SHIELD_INV; ev.push('shieldhit');
        bounce(f);
      } else {
        f.phase = 'dead'; f.deathT = 0; f.vy = Math.min(f.vy, 60); ev.push('crash');
        f.score = Math.floor(f.dist) + f.bonus;
        return;
      }
    }
    // near misses: skim within NEAR of rock or a block, then pull away
    if (f.cl < NEAR) {
      f.graze += dt;
      if (f.cl < f.minCl) f.minCl = f.cl;
    } else if (f.graze > 0) {
      if (f.graze >= 0.04 && f.inv <= 0) {
        f.combo = f.comboT > 0 ? Math.min(f.combo + 1, 9) : 1;
        f.comboT = 3;
        if (f.combo > f.bestCombo) f.bestCombo = f.combo;
        var gain = Math.round((15 + 40 * Math.min(f.graze, 1.5) + (NEAR - Math.max(0, f.minCl)) * 3) * f.combo);
        f.bonus += gain; f.lastGain = gain; f.near++;
        ev.push('near');
      }
      f.graze = 0; f.minCl = 1e9;
    }
    if (f.comboT > 0) { f.comboT -= dt; if (f.comboT <= 0) { f.comboT = 0; if (f.graze <= 0) f.combo = 0; } }
    touchItems(f);
    var z = zoneAt(f.x);
    if (z > f.zone) { f.zone = z; f.bonus += 100 * z; ev.push('zone'); }
    f.dist = f.x / 10;
    f.score = Math.floor(f.dist) + f.bonus;
    var kc = 1 - Math.exp(-3.2 * dt);
    f.cam += (camTarget(f) - f.cam) * kc;
  }
  // After a shielded hit: push back into the open, towards the cave's middle.
  // A block knocks the craft away from itself (down off a stalactite, up off
  // a stalagmite, off the nearer face of a slab), not towards the middle,
  // which can lie inside the block.
  function bounce(f) {
    var b = f.hitB, up;
    if (!b) up = f.y < midAt(f.c, f.x);
    else if (b.t === 'top') up = false;
    else if (b.t === 'bot') up = true;
    else up = f.y > (b.y0 + b.y1) / 2;
    f.vy = up ? 160 : -160;
    var ce = ceilAt(f.c, f.x) - R - 2, fl = floorAt(f.c, f.x) + R + 2;
    if (ce > fl) f.y = clamp(f.y, fl, ce);
  }

  function touchItems(f) {
    var items = f.c.items, i, it, dx, dy;
    while (f.ii < items.length && items[f.ii].x < f.x - 60) f.ii++;
    for (i = f.ii; i < items.length; i++) {
      it = items[i];
      if (it.x > f.x + 30) { if (it.x > f.x + 400) break; continue; }
      if (it.hit) continue;
      dx = it.x - f.x; dy = it.y - f.y;
      var rr = it.k === 'coin' ? R_COIN : R_ITEM;
      if (dx * dx + dy * dy < rr * rr) {
        it.hit = true; f.hits.push(it);
        if (it.k === 'coin') { f.coins++; f.bonus += 5; f.events.push('coin'); }
        else if (it.k === 'fuel') { f.fuel = Math.min(FUEL_MAX, f.fuel + FUEL_CAN); f.fuelGot++; f.bonus += 20; f.events.push('fuel'); }
        else { f.shield = 1; f.shields++; f.bonus += 20; f.events.push('shield'); }
      }
    }
  }

  // Advance real time dt with a fixed step; returns the render interpolation alpha.
  function advance(f, dt, hold) {
    f.acc = Math.min(f.acc + dt, 0.25);
    while (f.acc >= STEP && f.phase !== 'done') { stepRun(f, hold); f.acc -= STEP; }
    return f.phase === 'done' ? 1 : f.acc / STEP;
  }
  function summary(f) {
    return { mode: f.mode, score: f.score, dist: f.dist, coins: f.coins, near: f.near, combo: f.bestCombo,
      zone: f.zone + 1, fuel: f.fuelGot, shields: f.shields, time: f.t, cause: f.cause === 'quit' ? 'quit' : f.fuel <= 0 && f.cause ? 'fuel' : f.cause };
  }
  // Clearance from (x, y) to rock or any block (no side effects).
  function clearAt(c, x, y) {
    var cl = 1e9, i;
    for (i = 0; i < SAMP.length; i++) {
      var sx = x + SAMP[i] * R, dy = R * Math.sqrt(1 - SAMP[i] * SAMP[i]);
      var a = ceilAt(c, sx) - (y + dy), b = (y - dy) - floorAt(c, sx);
      if (a < cl) cl = a;
      if (b < cl) cl = b;
    }
    var B = c.blocks, lo = 0, hi = B.length;
    while (lo < hi) { var mm = (lo + hi) >> 1; if (B[mm].x0 < x - 60) lo = mm + 1; else hi = mm; }
    for (i = lo; i < B.length; i++) {
      var bk = B[i];
      if (bk.x0 > x + 40) break;
      var dx = x < bk.x0 ? bk.x0 - x : x > bk.x1 ? x - bk.x1 : 0, dyy = y < bk.y0 ? bk.y0 - y : y > bk.y1 ? y - bk.y1 : 0;
      var d = Math.sqrt(dx * dx + dyy * dyy) - R;
      if (d < cl) cl = d;
    }
    return cl;
  }
  // The autopilot (tests and the attract flight behind the menus): every few
  // steps it tries a handful of hold / let-go patterns over the next ~0.9 s and
  // picks the one that keeps furthest from the rock, steering for fuel and coins.
  var PLAN_N = 10, PLAN_T = 0.9, PLAN_EVERY = 5;
  function autopilot(f) {
    if (f.plk > 0) { f.plk--; return f.plh; }
    var c = f.c, m = c.m, H = Math.round(PLAN_T / STEP), best = -1e9, bh = false, p, i;
    var want = null, it = c.items;
    for (i = f.ii; i < it.length && it[i].x < f.x + 260; i++) {
      if (it[i].hit || it[i].x < f.x) continue;
      if (it[i].k === 'fuel' || it[i].k === 'shield' || (it[i].k === 'coin' && !want)) want = it[i];
      if (it[i].k !== 'coin') break;
    }
    for (p = 0; p < PLAN_N; p++) {
      var x = f.x, y = f.y, vy = f.vy, worst = 1e9, gotIt = 0, fuel = f.fuel;
      for (i = 0; i < H; i++) {
        var h = p < 5 ? i < p * H / 5 : i >= (p - 5) * H / 5;
        vy += ((h ? THRUST * (fuel > 0 ? 1 : SPUTTER) : 0) - G - DRAG * vy) * STEP;
        vy = clamp(vy, -VY_MAX, VY_MAX);
        x += speedAt(m, x) * STEP; y += vy * STEP;
        if (want && !gotIt && Math.abs(x - want.x) < 6 && Math.abs(y - want.y) < 8) gotIt = 1;
        if (i % 6 === 5) {
          var cl = clearAt(c, x, y);
          if (cl < worst) worst = cl;
          if (cl <= 0) { worst -= H - i; break; }
        }
      }
      var sc = Math.min(worst, 14) + gotIt * (want && want.k === 'coin' ? 4 : 12) + (worst > 14 ? -Math.abs(y - midAt(c, x)) * 0.02 : 0);
      var first = p < 5 ? p > 0 : p === 5;
      if (sc > best) { best = sc; bh = first; }
    }
    f.plh = bh; f.plk = PLAN_EVERY;
    return bh;
  }
  function simulate(seed, pilot, maxT, mode) {
    var f = newRun(seed, mode), n = Math.ceil((maxT || 120) / STEP);
    stepRun(f, true);
    for (var i = 0; i < n && f.phase !== 'done'; i++) { stepRun(f, pilot ? pilot(f) : false); f.events.length = 0; f.hits.length = 0; }
    return f;
  }

  // ---- the save: wallet, records, the hangar ----
  function newRec() { return { score: 0, dist: 0 }; }
  function newSave() {
    return { v: 1, wallet: 0, seed: 1, runs: 0, total: 0, mode: 'normal',
      rec: { calm: newRec(), normal: newRec(), wild: newRec() },
      best: { dist: 0, combo: 0, near: 0, coins: 0, zone: 0 },
      own: { body: ['dart'], color: ['ink', 'accent'], trail: ['none', 'dots'] },
      sel: { body: 'dart', color: 'accent', trail: 'dots' } };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.wallet = Math.max(0, Math.floor(+o.wallet || 0)); s.seed = (+o.seed >>> 0) || 1; s.runs = Math.max(0, +o.runs | 0); s.total = Math.max(0, +o.total || 0);
    if (MODES[o.mode]) s.mode = o.mode;
    if (o.rec && typeof o.rec === 'object') MODE_IDS.forEach(function (id) {
      var r = o.rec[id];
      if (r && typeof r === 'object') { s.rec[id].score = Math.max(0, +r.score || 0); s.rec[id].dist = Math.max(0, +r.dist || 0); }
    });
    if (o.best && typeof o.best === 'object') for (var k in s.best) s.best[k] = Math.max(0, +o.best[k] || 0);
    ['body', 'color', 'trail'].forEach(function (cat) {
      if (o.own && Array.isArray(o.own[cat])) o.own[cat].forEach(function (id) { if (itemOf(cat, id) && s.own[cat].indexOf(id) < 0) s.own[cat].push(id); });
      if (o.sel && owns(s, cat, o.sel[cat])) s.sel[cat] = o.sel[cat];
    });
    return s;
  }
  function itemOf(cat, id) {
    var L = HANGAR[cat];
    if (!L) return null;
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return null;
  }
  function owns(save, cat, id) { return !!itemOf(cat, id) && save.own[cat].indexOf(id) >= 0; }
  function canBuy(save, cat, id) {
    var it = itemOf(cat, id);
    return !!it && !it.need && !owns(save, cat, id) && save.wallet >= it.price;
  }
  function buy(save, cat, id) {
    if (!canBuy(save, cat, id)) return false;
    save.wallet -= itemOf(cat, id).price;
    save.own[cat].push(id); save.sel[cat] = id;
    return true;
  }
  function wear(save, cat, id) { if (!owns(save, cat, id)) return false; save.sel[cat] = id; return true; }
  function payout(res) { return Math.round(res.coins * (MODES[res.mode] || MODES.normal).coin); }
  // Fold a finished run into the save; returns the results card's data.
  function settle(save, res) {
    var mode = MODES[res.mode] ? res.mode : 'normal', rec = save.rec[mode], b = save.best, nb = {}, unlocked = [], pay = payout(res);
    save.runs++; save.wallet += pay; save.total += pay;
    if (res.score > rec.score) { nb.score = true; rec.score = res.score; }
    if (res.dist > rec.dist) { if (rec.dist > 0) nb.dist = true; rec.dist = res.dist; }
    var map = { dist: res.dist, combo: res.combo, near: res.near, coins: res.coins, zone: res.zone };
    for (var k in map) if (map[k] > b[k]) { if (b[k] > 0 && k !== 'dist') nb[k] = true; b[k] = map[k]; }
    ['body', 'color', 'trail'].forEach(function (cat) {
      HANGAR[cat].forEach(function (it) {
        if (it.need && b[it.need] >= it.n && save.own[cat].indexOf(it.id) < 0) { save.own[cat].push(it.id); unlocked.push(it); }
      });
    });
    return { best: nb, unlocked: unlocked, wallet: save.wallet, pay: pay };
  }
  function runSeed(save) { return hash2(save.seed, save.runs + 1) || 1; }

  var ENGINE = {
    STEP: STEP, G: G, THRUST: THRUST, DRAG: DRAG, VY_MAX: VY_MAX, R: R, NEAR: NEAR, FUEL_MAX: FUEL_MAX, FUEL_CAN: FUEL_CAN, ZONE_W: ZONE_W,
    START_CLEAR: START_CLEAR, DEATH_T: DEATH_T, MODES: MODES, MODE_IDS: MODE_IDS, ZONES: ZONES, BODIES: BODIES, COLORS: COLORS, TRAILS: TRAILS,
    rng: rng, hash2: hash2, clearAt: clearAt, newCave: newCave, ensure: ensure, ceilAt: ceilAt, floorAt: floorAt, midAt: midAt, zoneAt: zoneAt, speedAt: speedAt, spanMin: spanMin,
    newRun: newRun, stepRun: stepRun, probe: probe, advance: advance, summary: summary, autopilot: autopilot, simulate: simulate,
    newSave: newSave, normSave: normSave, itemOf: itemOf, owns: owns, canBuy: canBuy, buy: buy, wear: wear, settle: settle, payout: payout, runSeed: runSeed
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('caveflyer.css');
  var PANEL_ID = 'caveflyer-panel', NAME = 'Cave Flyer';
  var KEY = 'cade-caveflyer-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = 384, CW = 8, RH = 12, CRAFT_X = 0.26;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.caveflyer = { live: function () { return S; }, E: ENGINE };   // test-only peek

  // palette slots, filled from the theme (readTheme); the last 2 × NHUE are each zone's rock texture and edge
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_SPECK = 10, C_TEX = 11, NHUE = 6, C_EDGE = C_TEX + NHUE, NPAL = C_EDGE + NHUE;
  var RAINBOW = [C_GOLD, C_FLAME, C_RED, C_VIOLET, C_ICE, C_ACC, C_LEAF];
  var COLOR_SLOT = { ink: C_TEXT, accent: C_ACC, gold: C_GOLD, coral: C_RED, sky: C_ICE, ember: C_FLAME, leaf: C_LEAF, violet: C_VIOLET, rainbow: -1 };

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
  function fmtDist(m) { return fmtInt(Math.floor(m)) + ' m'; }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.h = null; }
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
  // The thruster: a low filtered buzz that swells while you hold.
  Snd.prototype.hum = function (level, pitch) {
    var ac = this.ac;
    if (!ac || ac.state === 'closed') return;
    if (!this.on) level = 0;
    try {
      if (!this.h) {
        if (!level) return;
        var o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
        o.type = 'sawtooth'; o.frequency.value = 70;
        fl.type = 'lowpass'; fl.frequency.value = 420;
        g.gain.value = 0.0001;
        o.connect(fl); fl.connect(g); g.connect(ac.destination); o.start();
        this.h = { o: o, g: g, lv: 0 };
      }
      var dp = pitch && Math.abs((this.h.lp || 0) - pitch) > 2;
      if (Math.abs(this.h.lv - level) < 0.001 && !dp) return;
      var t = ac.currentTime;
      this.h.g.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.05);
      if (dp) { this.h.o.frequency.setTargetAtTime(pitch, t, 0.08); this.h.lp = pitch; }
      this.h.lv = level;
    } catch (e) {}
  };
  Snd.prototype.close = function () {
    if (this.h) { try { this.h.o.stop(); } catch (e) {} this.h = null; }
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
    P[C_SPECK] = css(mix(bg, tx, dark ? 0.26 : 0.2));
    // the zones: each a hue — two rock shades, a texture colour, an edge colour
    var hues = [ac, parseCol(P[C_VIOLET]), parseCol(P[C_LEAF]), parseCol(P[C_FLAME]), parseCol(P[C_ICE]), parseCol(P[C_RED])];
    S.hue = hues.map(function (h, i) {
      P[C_TEX + i] = css(mix(bg, h, dark ? 0.46 : 0.42));
      P[C_EDGE + i] = css(mix(bg, h, dark ? 0.9 : 0.92));
      return { a: css(mix(bg, h, dark ? 0.24 : 0.2)), b: css(mix(bg, h, dark ? 0.17 : 0.13)), blk: css(mix(bg, h, dark ? 0.36 : 0.3)) };
    });
    S.col = { bg: css(bg), hud: css(bg, 0.82), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace' };
    fitFont();
  }

  // ---- glyph rendering ----
  // Everything is drawn as monospace glyphs on a CW × RH cell grid. Each
  // (colour, character) pair is rendered once into an atlas canvas at device
  // resolution and stamped with drawImage — far cheaper than fillText per glyph
  // on iOS. The font size is fitted to the font's real advance.
  var AT_COLS = 24, AT_ROWS = 20;
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
    a.sc = 2;   // cells big enough for glyphs drawn at up to 2x (the craft)
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
  // One glyph centred on (x, y) in logical units, snapped to the device pixel grid unless `nosnap`; `sc` scales it.
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
  // Numbers without building strings: digits go into a reused buffer.
  var NB = new Uint8Array(24);
  function writeNum(v, dec, comma) {
    var neg = v < 0, n = 0, i;
    if (neg) v = -v;
    var sc = dec === 1 ? 10 : 1, iv = Math.round(v * sc), ip = Math.floor(iv / sc), fp = iv - ip * sc;
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

  // ---- particles (world space) and score pop-ups; pools allocated once ----
  var NPART = 96, NPOP = 8, NTRAIL = 30;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.trail = new Float32Array(NTRAIL * 2); S.tn = 0; S.th = 0; S.tT = 0;
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
    S.tn = 0;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life, fwd) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v + (fwd || 0), Math.sin(a) * v, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci < 0 ? RAINBOW[i % RAINBOW.length] : ci, g);
    }
  }
  function popup(x, y, v, ci) {
    var p = S.pops[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.v = v; p.ci = ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { p = S.pops[i]; if (p.on && (p.t += dt) > 1.1) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.msg && (S.msg.t += dt) > S.msg.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null;
  }
  function say(text, ci, dur, queue) {
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.2 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }
  function pushTrail(x, y) {
    var T = S.trail;
    T[S.th * 2] = x; T[S.th * 2 + 1] = y;
    S.th = (S.th + 1) % NTRAIL;
    if (S.tn < NTRAIL) S.tn++;
  }

  // ---- the look the save is wearing ----
  function bodyStr() { var b = itemOf('body', S.save.sel.body) || BODIES[0]; return b.s; }
  function bodySlot(t) {
    var s = COLOR_SLOT[S.save.sel.color];
    if (s == null) s = C_ACC;
    if (s < 0) s = RAINBOW[((t * 8) | 0) % RAINBOW.length];
    return s;
  }

  // ---- the scene ----
  // Camera: the craft sits CRAFT_X from the left; vertically the engine's
  // smoothed camera (interpolated), nudged so the craft never leaves the view.
  function view(f, a) {
    var v = S.v, VH = S.VH;
    v.x = f.px + (f.x - f.px) * a; v.y = f.py + (f.y - f.py) * a;
    if (f.phase === 'ready') v.y += Math.sin(S.idleT * 3) * 3;
    v.cam = f.pcam + (f.cam - f.pcam) * a;
    v.left = v.x - CRAFT_X * VW;
    var sy = VH / 2 - (v.y - v.cam), top = 50, bot = VH - 18;
    if (sy < top) v.cam += top - sy; else if (sy > bot) v.cam -= sy - bot;
    return v;
  }
  function X(v, wx) { return wx - v.left; }
  function Y(v, wy) { return S.VH / 2 - (wy - v.cam); }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var f = S.f || S.hf, c = S.ctx, VH = S.VH, v = view(f, alpha), i, n;
    var t = S.idleT;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) {
      var sh = S.shake * 14;
      c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    drawSpecks(c, v, f);
    drawRock(c, v, f);
    drawBlocks(c, v, f);
    drawItems(c, v, f, t);

    // the trail, oldest first
    var tr = itemOf('trail', S.save.sel.trail) || TRAILS[0];
    if (tr.s && S.tn > 1 && S.f && f.phase === 'run') {
      var T = S.trail, slot = bodySlot(t);
      for (i = S.tn - 1; i >= 1; i--) {
        var q = (S.th - 1 - i + NTRAIL * 2) % NTRAIL, fr = 1 - i / S.tn;
        var tx = X(v, T[q * 2]), ty = Y(v, T[q * 2 + 1]);
        if (tx < -CW || tx > VW + CW) continue;
        c.globalAlpha = fr * 0.8;
        var tc = tr.multi ? RAINBOW[(q + ((t * 8) | 0)) % RAINBOW.length] : slot;
        glyph(c, tc, tr.s.charCodeAt((q + S.tseq) % tr.s.length), tx, ty, true, 0.6 + fr * 0.45);
      }
      c.globalAlpha = 1;
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var p = S.parts[i];
      if (!p.on) continue;
      var px = X(v, p.x), py = Y(v, p.y);
      if (px < -CW || px > VW + CW || py < -RH || py > VH + RH) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - p.t / p.life));
      glyph(c, p.ci, p.code, px, py);
    }
    c.globalAlpha = 1;
    for (i = 0; i < NPOP; i++) {
      var pp = S.pops[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.1 - pp.t));
      n = writeNum(pp.v, 0, true);
      var qx = X(v, pp.x), qy = Y(v, pp.y) - RH * 1.4 - pp.t * 24;
      glyph(c, pp.ci, 43, qx - (n + 1) * CW / 2, qy);
      drawNum(c, pp.ci, n, qx + CW / 2, qy, 'center');
    }
    c.globalAlpha = 1;
    drawCraft(c, f, v, t, dt);

    if (S.f && S.phase === 'run') {
      hud(c, f);
      if (f.phase === 'ready') {
        var blink = ((t * 2) | 0) % 2 === 0;
        banner(c, S.coarse ? 'HOLD TO FLY' : 'HOLD SPACE TO FLY', VH * 0.5 + 34, blink ? C_ACC : C_MUTED);
      }
      if (S.msg) banner(c, S.msg.text, RH * 5, S.msg.ci);
    }
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = S.dark ? 'rgba(255,255,255,' + (S.flash * 1.1).toFixed(3) + ')' : 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')';
      c.fillRect(-10, -10, VW + 20, VH + 20);
    }
  }

  // Far-off specks in the cave air (parallax), only between the walls.
  function drawSpecks(c, v, f) {
    var w = f.c, par = 0.4, ox = v.left * par, oy = v.cam * par, VH = S.VH;
    var i0 = Math.floor(ox / CW), j0 = Math.floor(-oy / RH), cols = Math.ceil(VW / CW) + 1, rows = Math.ceil(VH / RH) + 1;
    for (var i = 0; i < cols; i++) {
      var gx = i0 + i, sx = gx * CW - ox, wx = v.left + sx;
      var top = Y(v, ceilAt(w, wx)) + 6, bot = Y(v, floorAt(w, wx)) - 6;
      if (bot <= top) continue;
      for (var j = 0; j < rows; j++) {
        var gy = j0 + j, h = hash2(gx, gy) % 1000;
        if (h >= 30) continue;
        var sy = gy * RH + oy + VH / 2 - Math.floor(VH / 2 / RH) * RH;
        if (sy < top || sy > bot || sy < 38) continue;
        glyph(c, C_SPECK, h < 8 ? 58 : 46, sx, sy, false, h < 8 ? 0.8 : 1);
      }
    }
  }

  // The rock: contour bands that follow each wall (two shades of the zone's
  // hue), sparse texture glyphs inside, and an edge line chosen by the slope.
  var COLW = 4;
  function drawRock(c, v, f) {
    var w = f.c, VH = S.VH, n = Math.ceil(VW / COLW) + 3, TX = S.tx, TC = S.tc, TF = S.tf, TZ = S.tz, j, b;
    for (j = 0; j < n; j++) {
      var sx = (j - 1) * COLW, wx = v.left + sx;
      TX[j] = sx; TC[j] = Y(v, ceilAt(w, wx)); TF[j] = Y(v, floorAt(w, wx)); TZ[j] = zoneAt(wx);
    }
    var bh = 9, j0 = 0;
    while (j0 < n) {
      var j1 = j0, z = TZ[j0];
      while (j1 < n - 1 && TZ[j1 + 1] === z) j1++;
      var hue = S.hue[z % NHUE], xa = TX[j0], xb = j1 < n - 1 ? TX[j1 + 1] : TX[j1] + COLW;
      for (var side = 0; side < 2; side++) {
        var A = side ? TF : TC, sg = side ? 1 : -1, edge = side ? VH + 4 : -4, lim = 0;
        for (j = j0; j <= j1; j++) lim = Math.max(lim, side ? VH - A[j] : A[j]);
        var nb = Math.min(30, Math.ceil(lim / bh) + 1);
        for (b = 0; b < nb; b++) {
          var off = b * bh * sg;
          c.fillStyle = b % 2 ? hue.b : hue.a;
          c.beginPath();
          c.moveTo(xa, edge);
          for (j = j0; j <= j1; j++) c.lineTo(TX[j], A[j] + off);
          if (j1 < n - 1) c.lineTo(xb, A[j1 + 1] + off);
          c.lineTo(xb, edge);
          c.closePath();
          c.fill();
        }
      }
      j0 = j1 + 1;
    }
    // texture: world-anchored cells, only well inside the rock
    var k0 = Math.floor(v.left / CW), cols = Math.ceil(VW / CW) + 2, TEXC = ".:.'.,:";
    var r0 = Math.floor((v.cam - VH / 2) / RH) - 1, rows = Math.ceil(VH / RH) + 3;
    for (var k = 0; k < cols; k++) {
      var gxw = (k0 + k) * CW + CW / 2, gx = X(v, gxw), ce = ceilAt(w, gxw), fl = floorAt(w, gxw), slot = C_TEX + zoneAt(gxw) % NHUE;
      for (var r = 0; r < rows; r++) {
        var gyw = (r0 + r) * RH + RH / 2;
        if (gyw < ce + RH && gyw > fl - RH) continue;
        var h = hash2(k0 + k, r0 + r) % 100;
        if (h >= 15) continue;
        glyph(c, slot, TEXC.charCodeAt(h % TEXC.length), gx, Y(v, gyw));
      }
      // the edges
      var es = C_EDGE + zoneAt(gxw) % NHUE;
      var sc = (ceilAt(w, gxw + 1.5) - ceilAt(w, gxw - 1.5)) / 3, yc = Y(v, ce);
      var chc = sc > 1.6 || sc < -1.6 ? 124 : sc > 0.4 ? 47 : sc < -0.4 ? 92 : 45;
      if (yc > -RH && yc < VH + RH) glyph(c, es, chc, gx, chc === 45 ? yc - RH * 0.12 : yc - RH * 0.25);
      var sf = (floorAt(w, gxw + 1.5) - floorAt(w, gxw - 1.5)) / 3, yf = Y(v, fl);
      var chf = sf > 1.6 || sf < -1.6 ? 124 : sf > 0.4 ? 47 : sf < -0.4 ? 92 : 95;
      if (yf > -RH && yf < VH + RH) glyph(c, es, chf, gx, chf === 95 ? yf - RH * 0.42 : yf + RH * 0.2);
    }
  }

  // Blocks: a solid of '#' glyphs on a tinted slab; stalactites end in V, stalagmites in A.
  function drawBlocks(c, v, f) {
    var B = f.c.blocks, VH = S.VH, x0 = v.left - 40, x1 = v.left + VW + 10;
    for (var i = S.f ? f.bi : 0; i < B.length; i++) {
      var b = B[i];
      if (b.x0 > x1) break;
      if (b.x1 < x0) continue;
      var z = zoneAt(b.x0) % NHUE, es = C_EDGE + z, sxa = X(v, b.x0), sxb = X(v, b.x1);
      var ya = Math.max(-4, Y(v, b.y1)), yb = Math.min(VH + 4, Y(v, b.y0));
      if (yb <= ya) continue;
      c.fillStyle = S.hue[z].blk;
      c.fillRect(sxa, ya, sxb - sxa, yb - ya);
      var ncol = Math.round((b.x1 - b.x0) / CW), r, wy;
      for (var q = 0; q < ncol; q++) {
        var gx = sxa + q * CW + CW / 2;
        if (b.t === 'top') {
          for (r = 0, wy = b.y0 + RH / 2; wy < b.y1; r++, wy += RH) {
            var sy = Y(v, wy);
            if (sy < -RH) break;
            if (sy > VH + RH) continue;
            glyph(c, r === 0 ? C_RED : es, r === 0 ? 86 : 35, gx, sy);
          }
        } else if (b.t === 'bot') {
          for (r = 0, wy = b.y1 - RH / 2; wy > b.y0; r++, wy -= RH) {
            var sy2 = Y(v, wy);
            if (sy2 > VH + RH) break;
            if (sy2 < -RH) continue;
            glyph(c, r === 0 ? C_RED : es, r === 0 ? 65 : 35, gx, sy2);
          }
        } else {
          for (wy = b.y0 + RH / 2; wy < b.y1; wy += RH) glyph(c, es, q === 0 || q === ncol - 1 ? 61 : 35, gx, Y(v, wy));
        }
      }
    }
  }

  function drawItems(c, v, f, t) {
    var items = f.c.items, VH = S.VH, x0 = v.left - 10, x1 = v.left + VW + 10;
    for (var i = S.f ? f.ii : 0; i < items.length; i++) {
      var it = items[i];
      if (it.x > x1 + 40) break;
      if (it.hit || it.x < x0 || it.x > x1) continue;
      var sx = X(v, it.x), sy = Y(v, it.y);
      if (sy < -RH * 2 || sy > VH + RH * 2) continue;
      if (it.k === 'coin') glyph(c, C_GOLD, ((t * 5 + it.x * 0.1) | 0) % 5 === 0 ? 83 : 36, sx, sy);
      else {
        var ci = it.k === 'fuel' ? C_LEAF : C_ICE, bob = Math.sin(t * 3 + it.x) * 2.5, pul = ((t * 4) | 0) % 2;
        glyph(c, ci, it.k === 'fuel' ? 91 : 40, sx - CW * 1.05, sy + bob);
        glyph(c, ci, it.k === 'fuel' ? 70 : 79, sx, sy + bob, false, 1.15);
        glyph(c, ci, it.k === 'fuel' ? 93 : 41, sx + CW * 1.05, sy + bob);
        if (pul) { glyph(c, ci, 39, sx - CW * 1.6, sy + bob - RH * 0.7, false, 0.8); glyph(c, ci, 46, sx + CW * 1.6, sy + bob + RH * 0.6, false, 0.8); }
      }
    }
  }

  // The craft: its glyphs, tilted with the climb rate; a shield bubble; a
  // blink while invulnerable. Gone (in pieces) once crashed.
  function drawCraft(c, f, v, t, dt) {
    if (f.phase === 'dead' || f.phase === 'done') return;
    var x = X(v, v.x), y = Y(v, v.y), s = bodyStr();
    var want = f.phase === 'ready' ? -0.05 : clamp(-Math.atan2(f.vy, f.vx) * 0.75, -0.7, 0.7);
    S.tilt += (want - S.tilt) * Math.min(1, (dt || 0) * 12);
    if (S.f && S.tT <= 0 && f.phase === 'run') {
      S.tT = 1 / 40;
      pushTrail(v.x - Math.cos(S.tilt) * (s.length * CW * 0.45 + 2), v.y + Math.sin(S.tilt) * (s.length * CW * 0.45 + 2)); S.tseq++;
    }
    if (f.shield > 0 || f.inv > 0) {
      var on = f.shield > 0 || ((t * 12) | 0) % 2;
      if (on) {
        for (var q = 0; q < 10; q++) {
          var an = t * 2.5 + q * Math.PI / 5, rr = Math.max(13, s.length * CW * 0.5 + 6);
          c.globalAlpha = f.shield > 0 ? 0.75 : 0.4;
          glyph(c, C_ICE, q % 2 ? 46 : 39, x + Math.cos(an) * rr, y + Math.sin(an) * rr * 0.8, true);
        }
        c.globalAlpha = 1;
      }
    }
    if (f.inv > 0 && ((t * 16) | 0) % 2) c.globalAlpha = 0.45;
    var slot = bodySlot(t), sc = 1.25, cw = CW * sc * (s.length > 1 ? 0.82 : 1);
    c.save();
    c.translate(x, y); c.rotate(S.tilt);
    for (var i = 0; i < s.length; i++) glyph(c, slot, s.charCodeAt(i), (i - (s.length - 1) / 2) * cw, 0, true, sc);
    c.restore();
    c.globalAlpha = 1;
    S.craftX = x; S.craftY = y;
  }

  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - RH * 0.8, w, RH * 1.6);
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.5, y);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.5, y);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }

  function hud(c, f) {
    var yl = 6, yv = 17, y2 = 30, n, x, L = 0.72;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 37);
    drawStr(c, C_MUTED, 'DIST', 6, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'SCORE', 96, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'COINS', 190, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'FUEL', 256, yl, 'left', false, L);
    n = writeNum(Math.floor(f.dist), 0, true); x = drawNum(c, C_TEXT, n, 6, yv); glyph(c, C_MUTED, 109, x + 4, yv + 1, false, 0.85);
    n = writeNum(f.score, 0, true); drawNum(c, C_TEXT, n, 96, yv);
    n = writeNum(f.coins, 0); glyph(c, C_GOLD, 36, 194, yv); drawNum(c, C_TEXT, n, 202, yv);
    // the tank: a bar of cells; red and blinking when low
    var cells = 12, fr = clamp(f.fuel / FUEL_MAX, 0, 1), on = Math.ceil(fr * cells - 0.001), low = f.fuel < 25;
    x = 256;
    var blink = low && ((S.idleT * 4) | 0) % 2;
    for (var i = 0; i < cells; i++) glyph(c, i < on ? (low ? (blink ? C_RED : C_FLAME) : C_LEAF) : C_FAINT, i < on ? 35 : 45, x + i * CW * 0.8 + CW * 0.4, yv, false, 0.8);
    n = writeNum(Math.ceil(f.fuel), 0); NB[n++] = 37;
    drawNum(c, low ? C_RED : C_MUTED, n, VW - 6, yl, 'right', L);
    // second row: zone, shield, the near-miss combo
    x = drawStr(c, C_MUTED, 'ZONE ', 6, y2, 'left', false, L);
    n = writeNum(f.zone + 1, 0); x = drawNum(c, C_TEXT, n, x, y2, 'left', L) + CW * 0.7;
    x = drawStr(c, C_FAINT, ZONES[f.zone % ZONES.length].toUpperCase(), x, y2, 'left', false, L) + CW;
    if (f.shield > 0) drawStr(c, C_ICE, '(O) SHIELD', x, y2, 'left', false, L);
    if (f.combo > 0) {
      var ci = f.combo >= 5 ? RAINBOW[((S.idleT * 10) | 0) % 7] : C_ACC;
      n = writeNum(f.combo, 0);
      drawNum(c, ci, n, VW - 6, y2, 'right', L);
      drawStr(c, C_MUTED, 'NEAR x', VW - 6 - n * CW * L, y2, 'right', false, L);
      // the combo's fuse
      var fw = Math.round(clamp(f.comboT / 3, 0, 1) * 6);
      for (i = 0; i < 6; i++) glyph(c, i < fw ? ci : C_FAINT, 46, VW - 6 - (n + 6) * CW * L - (6 - i) * CW * 0.6, y2, false, 0.8);
    }
  }

  // ---- loop: runs only while a run is on screen ----
  function running() {
    return !!S && S.phase === 'run' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } if (S) S.snd.hum(0); }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad();
    if (!S.raf && !running()) return;              // the gamepad paused it
    S.idleT += dt;
    var f = S.f, s0 = f.steps, alpha = advance(f, dt, held());
    if (f.steps > s0) S.latch = false;     // a tap shorter than a step still got its step of thrust
    handleEvents(f);
    stepFx(dt);
    S.tT -= dt;
    if (f.phase === 'run') {
      var thr = f.thrust && f.fuel > 0;
      S.snd.hum(thr ? 0.03 : 0.0001, thr ? 92 + Math.min(40, Math.max(0, f.vy) * 0.1) : 60);
      S.exT -= dt;
      if (S.exT <= 0 && !S.rm) {
        S.exT = thr ? 0.022 : f.thrust ? 0.09 : 0.12;
        var bx = f.x - bodyStr().length * CW * 0.55 - 2;
        if (thr) spark(bx, f.y - 2, -20 - Math.random() * 30, -40 - Math.random() * 50, 0.35, Math.random() < 0.5 ? 42 : 46, Math.random() < 0.3 ? C_GOLD : C_FLAME, 0);
        else spark(bx, f.y, -10, 6 + Math.random() * 8, 0.6, f.thrust ? 44 : 46, C_FAINT, 0);
      }
    } else S.snd.hum(0);
    draw(alpha, dt);
    if (f.phase === 'done') {
      S.endT += dt;
      if (S.endT >= 0.25) { endRun(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(f) {
    var ev = f.events, snd = S.snd, i, it;
    for (i = 0; i < f.hits.length; i++) {
      it = f.hits[i];
      if (it.k === 'coin') burst(it.x, it.y, 4, 50, "*.'", C_GOLD, 0, 0.35, 30);
      else burst(it.x, it.y, 12, 90, "*'.+", it.k === 'fuel' ? C_LEAF : C_ICE, 0, 0.7);
    }
    f.hits.length = 0;
    for (i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'start': snd.tone(330, 0.12, 'triangle', 0.035, 660); break;
        case 'coin':
          if (S.coinT <= S.idleT) { snd.tone(1320 + (S.coinN % 5) * 90, 0.06, 'sine', 0.035); S.coinT = S.idleT + 0.03; }
          S.coinN++;
          break;
        case 'fuel':
          say('FUEL +' + FUEL_CAN, C_LEAF, 1);
          [523, 659, 784].forEach(function (fq, j) { snd.tone(fq, 0.09, 'triangle', 0.035, 0, j * 0.05); });
          Cade.haptic && Cade.haptic(8);
          break;
        case 'shield':
          say('SHIELD!', C_ICE, 1.1);
          [784, 988, 1175, 1568].forEach(function (fq, j) { snd.tone(fq, 0.09, 'triangle', 0.035, 0, j * 0.05); });
          Cade.haptic && Cade.haptic(10);
          break;
        case 'shieldhit':
          say('SHIELD BROKE', C_ICE, 1.1);
          S.shake = 0.2; S.flash = 0.06;
          burst(f.x, f.y, 14, 120, "o.'", C_ICE, 0, 0.6);
          snd.tone(300, 0.2, 'square', 0.04, 120);
          Cade.haptic && Cade.haptic(20);
          break;
        case 'near':
          popup(f.x, f.y + 4, f.lastGain, f.combo >= 5 ? C_FLAME : C_ACC);
          say(f.combo > 1 ? 'NEAR MISS x' + f.combo : 'NEAR MISS!', f.combo >= 5 ? C_FLAME : C_ACC, 0.9);
          snd.tone(700 + Math.min(9, f.combo) * 80, 0.1, 'triangle', 0.035, 0, 0);
          snd.tone(1050 + Math.min(9, f.combo) * 100, 0.12, 'triangle', 0.025, 0, 0.05);
          burst(f.x, f.y, 4, 60, "'.", C_ACC, 0, 0.4, 40);
          Cade.haptic && Cade.haptic(5);
          break;
        case 'zone':
          say('ZONE ' + (f.zone + 1) + ' . ' + ZONES[f.zone % ZONES.length].toUpperCase(), C_EDGE + f.zone % NHUE, 1.8);
          snd.tone(523, 0.12, 'triangle', 0.04); snd.tone(784, 0.18, 'triangle', 0.04, 0, 0.1); snd.tone(1047, 0.24, 'triangle', 0.035, 0, 0.2);
          popup(f.x, f.y + 8, 100 * f.zone, C_TEXT);
          S.flash = 0.06;
          break;
        case 'fuellow':
          say('FUEL LOW', C_RED, 1.4, true);
          snd.tone(440, 0.12, 'square', 0.03); snd.tone(440, 0.12, 'square', 0.03, 0, 0.18);
          break;
        case 'empty':
          say('OUT OF FUEL', C_RED, 2);
          snd.tone(220, 0.4, 'sawtooth', 0.03, 90);
          break;
        case 'crash':
          snd.hum(0);
          snd.tone(160, 0.45, 'sawtooth', 0.06, 40); snd.tone(90, 0.5, 'square', 0.04, 30, 0.05);
          S.shake = 0.4; S.flash = 0.12;
          burst(f.x, f.y, 26, 150, "#*+.%'", C_FLAME, 220, 1.0);
          burst(f.x, f.y, 10, 90, bodyStr() + '.', bodySlot(S.idleT), 260, 1.1);
          say(f.cause === 'block' ? 'SMASHED' : 'CRASHED', C_RED, 2);
          Cade.haptic && Cade.haptic(40);
          break;
      }
    }
    ev.length = 0;
  }

  // ---- cards ----
  function chip(cat, it) {
    var sv = S.save, own = owns(sv, cat, it.id), on = sv.sel[cat] === it.id, poor = !own && !it.need && sv.wallet < it.price;
    var face;
    if (cat === 'body') face = '<b class="cf-face">' + esc(it.s) + '</b>';
    else if (cat === 'color') face = '<b class="cf-face cf-c-' + it.id + '">' + esc(itemOf('body', sv.sel.body).s) + '</b>';
    else face = '<b class="cf-face">' + (it.s ? esc((it.s + it.s + it.s).slice(0, 3)) : '&middot;') + '</b>';
    var tag = own ? '' : it.need ? '<i>' + esc(it.how) + '</i>' : '<i>$' + fmtInt(it.price) + '</i>';
    var lbl = it.name + (own ? (on ? ' (flying)' : '') : it.need ? ' — locked: ' + it.how : ' — ' + it.price + ' coins');
    return '<button type="button" class="cf-chip' + (on ? ' on' : '') + (own ? '' : ' locked') + (poor ? ' poor' : '') + '" data-cat="' + cat + '" data-id="' + it.id + '"' +
      (!own && (it.need || poor) ? ' aria-disabled="true"' : '') + ' title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '">' + face +
      '<span>' + esc(it.name) + '</span>' + tag + '</button>';
  }
  function modeRow() {
    return '<div class="cf-modes" role="radiogroup" aria-label="Mode">' + MODE_IDS.map(function (id) {
      var m = MODES[id], r = S.save.rec[id], on = S.save.mode === id;
      return '<button type="button" role="radio" aria-checked="' + on + '" class="' + (on ? 'on' : '') + '" data-mode="' + id + '" title="' + esc(m.name + ': ' + m.info) + '">' +
        '<b>' + esc(m.name) + '</b><i>' + (r.dist ? fmtDist(r.dist) : '&mdash;') + '</i></button>';
    }).join('') + '</div>';
  }
  function homeHtml() {
    var sv = S.save, h = '', m = MODES[sv.mode], r = sv.rec[sv.mode];
    h += '<div class="cf-card cf-home">';
    h += '<div class="cf-top"><span class="cf-brand">CAVE FLYER</span><span class="cf-wallet" title="Coins to spend">$' + fmtInt(sv.wallet) + '</span></div>';
    h += modeRow();
    h += '<div class="cf-tabs" role="tablist">' +
      ['look', 'records'].map(function (tb) { return '<button type="button" role="tab" data-tab="' + tb + '" aria-selected="' + (S.tab === tb) + '" class="' + (S.tab === tb ? 'on' : '') + '">' + (tb === 'look' ? 'Hangar' : 'Records') + '</button>'; }).join('') + '</div>';
    if (S.tab === 'look') {
      [['body', 'Craft'], ['color', 'Colour'], ['trail', 'Trail']].forEach(function (cg) {
        h += '<div class="cf-sec"><div class="cf-h">' + cg[1] + '</div><div class="cf-chips">' + HANGAR[cg[0]].map(function (it) { return chip(cg[0], it); }).join('') + '</div></div>';
      });
    } else {
      var b = sv.best, rows = [];
      MODE_IDS.forEach(function (id) {
        var rr = sv.rec[id];
        rows.push([MODES[id].name + ' best', rr.score ? fmtInt(rr.score) + ' · ' + fmtDist(rr.dist) : '-']);
      });
      rows.push(['Deepest zone', b.zone ? String(b.zone) : '-'], ['Near misses (run)', String(b.near)], ['Best near combo', b.combo ? 'x' + b.combo : '-'],
        ['Most coins (run)', String(b.coins)], ['Flights', fmtInt(sv.runs)], ['Coins collected', fmtInt(sv.total)]);
      h += '<pre class="cf-tab">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 30 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      h += '<div class="cf-foot">' + (S.resetArm ?
        '<span class="cf-confirm">Erase records, coins and craft?</span><span><button type="button" class="cf-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="cf-lnk" data-act="reset-no">Keep</button></span>' :
        '<span></span><button type="button" class="cf-lnk" data-act="reset">Reset progress</button>') + '</div>';
    }
    h += '<div class="cf-note">' + esc(m.name) + ' &middot; ' + esc(m.info) + (r.score ? ' &middot; best ' + fmtInt(r.score) : '') + '</div>';
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>hold the screen</b> &nbsp;(or the big button) to fire the thruster</div><div><b>let go</b> &nbsp;to fall</div>' :
      '<div><b>hold Space</b> / &uarr; / W / the mouse &nbsp;thrust up</div><div><b>let go</b> &nbsp;fall</div><div><b>gamepad</b> &nbsp;hold A</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="cf-card cf-help">' +
      '<pre class="cf-art" aria-hidden="true">#####\\___/####VV######\n   .     =&gt;  .   $ $\n___/####\\____/AA\\____</pre>' +
      '<div class="cf-title">CAVE FLYER</div>' +
      '<p>Thread an endless cave that gets <b>narrower and twistier</b> the deeper you fly. One button.</p>' +
      '<div class="cf-keys">' + keys + '</div>' +
      '<p class="cf-tip">The craft has <b>momentum</b>: tap to float, hold to climb, let go early to level out. Touch rock or a block and it&rsquo;s over.</p>' +
      '<p class="cf-tip">Skim past rock without touching it for a <b>NEAR MISS</b> bonus &mdash; chain them inside 3 s for a combo multiplier.</p>' +
      '<div class="cf-keys cf-pws">' +
      '<div><b class="cf-c-gold">$</b> coin &nbsp;<span>spend them in the Hangar</span></div>' +
      '<div><b class="cf-c-leaf">[F]</b> fuel &nbsp;<span>the tank drains, faster while you thrust</span></div>' +
      '<div><b class="cf-c-sky">(O)</b> shield &nbsp;<span>survives one hit</span></div>' +
      '<div><b class="cf-c-coral">V A</b> blocks &nbsp;<span>stalactites, stalagmites, slabs</span></div></div>' +
      '<p class="cf-tip">Every 250 m is a new <b>zone</b>. Pick <b>Calm</b>, <b>Normal</b> or <b>Wild</b> on the home card.</p>' +
      (first ? '' : '<button type="button" class="cf-go" data-act="close-help">Back</button>') + '</div>';
  }
  function resultsHtml() {
    var cd = S.card, r = S.res, rows = [];
    function line(a, b2) { return esc(a) + new Array(Math.max(1, 28 - a.length - b2.length) + 1).join(' ') + '<b>' + esc(b2) + '</b>'; }
    rows.push(line('Distance', fmtDist(r.dist)));
    rows.push(line('Zone reached', r.zone + ' ' + ZONES[(r.zone - 1) % ZONES.length]));
    rows.push(line('Near misses', r.near + (r.combo > 1 ? ' (best x' + r.combo + ')' : '')));
    if (r.fuel) rows.push(line('Fuel cans', String(r.fuel)));
    rows.push(line('Time', Math.floor(r.time / 60) + ':' + ('0' + Math.floor(r.time % 60)).slice(-2)));
    rows.push('<i>' + new Array(29).join('-') + '</i>');
    rows.push('<span class="g">' + line('Coins' + (cd.pay !== r.coins ? ' (x' + MODES[r.mode].coin + ')' : ''), '+$' + cd.pay) + '</span>');
    var bests = Object.keys(cd.best).filter(function (k) { return k !== 'score'; }).map(function (k) { return { dist: 'distance', combo: 'combo', near: 'near misses', coins: 'coins', zone: 'zone' }[k]; });
    var title = r.cause === 'fuel' ? 'OUT OF FUEL' : r.cause === 'block' ? 'SMASHED' : r.cause === 'quit' ? 'FLIGHT OVER' : 'CRASHED';
    return '<div class="cf-card cf-res">' +
      '<div class="cf-title">' + title + '</div>' +
      '<div class="cf-big">' + fmtInt(r.score) + '</div>' +
      (cd.best.score ? '<div class="cf-new">** new ' + esc(MODES[r.mode].name.toLowerCase()) + ' best **</div>' : '<div class="cf-sub">' + esc(MODES[r.mode].name) + ' best ' + fmtInt(S.save.rec[r.mode].score) + '</div>') +
      '<pre class="cf-tab">' + rows.join('\n') + '</pre>' +
      (bests.length ? '<div class="cf-new">new best ' + bests.join(', ') + '</div>' : '') +
      cd.unlocked.map(function (it) { return '<div class="cf-new">unlocked: ' + esc(it.name) + (it.s ? ' (' + esc(it.s) + ')' : '') + '</div>'; }).join('') +
      '<div class="cf-note">Wallet $' + fmtInt(cd.wallet) + nextBuy() + '</div></div>';
  }
  function nextBuy() {
    var best = null;
    ['body', 'color', 'trail'].forEach(function (cat) {
      HANGAR[cat].forEach(function (it) { if (!it.need && !owns(S.save, cat, it.id) && (!best || it.price < best.price)) best = it; });
    });
    if (!best) return '';
    return S.save.wallet >= best.price ? ' · you can afford something in the Hangar' : ' · next unlock at $' + fmtInt(best.price);
  }
  function pauseHtml() {
    return '<div class="cf-card cf-pause"><div class="cf-title">PAUSED</div>' +
      '<div class="cf-sub">' + fmtInt(S.f.score) + ' · ' + fmtDist(S.f.dist) + ' · zone ' + (S.f.zone + 1) + '</div>' +
      '<div class="cf-btns"><button type="button" class="cf-go" data-act="resume">Resume</button><button type="button" class="cf-go alt" data-act="quit">End flight</button></div>' +
      '<div class="cf-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml(S.phase === 'help') : kind === 'results' ? resultsHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'home');
    S.stage.classList.toggle('home', kind === 'home');
  }
  // Back from the help card to whatever card it covered (home, results or pause).
  function closeHelp() {
    if (!S || S.phase === 'help') return;
    var k = S.helpFrom;
    S.helpFrom = null;
    if (S.phase === 'run') showCard(S.paused ? 'pause' : null);
    else showCard(k === 'results' && S.phase === 'results' ? 'results' : 'home');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'run') h = '<button type="button" class="cf-hold" data-k="hold" aria-label="Hold to thrust">Hold <span>to rise</span></button>';
    else {
      var lab = mode === 'go' ? 'Fly!' : mode === 'again' ? 'Again' : mode === 'resume' ? 'Resume' : mode === 'start' ? 'Let’s fly' : 'Back';
      h = '<button type="button" class="cf-act" data-act="' + mode + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>' +
        (mode === 'again' ? '<button type="button" class="cf-act alt" data-act="home">Hangar</button>' : '');
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'run') return;
    var b = S.pad.querySelector('[data-k]');
    if (b) b.classList.toggle('on', held());
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'run';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncLabel() {
    var r = S.save.rec[S.save.mode];
    S.cv.setAttribute('aria-label', 'Cave Flyer — ' + MODES[S.save.mode].name + ' best ' + fmtInt(r.score) + ', ' + fmtDist(r.dist) + '. Hold space, the up arrow or the play field to rise; let go to fall.');
  }

  // A backdrop for the menus: a few seconds of the autopilot flying this mode's cave.
  function demo() {
    var f = newRun(4242, S.save.mode);
    stepRun(f, true);
    for (var i = 0; i < 9 / STEP && f.phase === 'run'; i++) { stepRun(f, autopilot(f)); f.events.length = 0; f.hits.length = 0; }
    if (f.phase !== 'run') f = newRun(4242, S.save.mode);
    f.px = f.x; f.py = f.y; f.pcam = f.cam; f.phase = 'run'; f.vy = 0;
    return f;
  }
  function toHome() {
    S.phase = 'home'; S.f = null; S.paused = false; S.resetArm = false;
    S.hf = demo();
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard('home'); setPad('go'); syncHead(); syncLabel();
    draw(1, 0);
  }
  function startRun() {
    if (!S || (S.phase !== 'home' && S.phase !== 'results' && S.phase !== 'help')) return;
    S.snd.ensure();
    S.f = newRun(runSeed(S.save), S.save.mode);
    S.phase = 'run'; S.paused = false; S.endT = 0; S.coinN = 0; S.coinT = 0; S.tseq = 0; S.tilt = 0; S.exT = 0;
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard(null); setPad('run'); syncHead();
    kick();
  }
  function endRun() {
    stopLoop();
    S.res = summary(S.f);
    S.card = settle(S.save, S.res);
    persist();
    S.phase = 'results'; clearInput();
    showCard('results'); setPad('again'); syncHead(); syncLabel();
    if (S.liveEl) S.liveEl.textContent = 'Crashed: ' + fmtInt(S.res.score) + ' points, ' + fmtDist(S.res.dist) + ', ' + S.res.coins + ' coins.';
    if (S.card.best.score) [659, 784, 988, 1319].forEach(function (fq, j) { S.snd.tone(fq, 0.12, 'triangle', 0.035, 0, j * 0.08); });
    S.msg = null;
    draw(1, 0);
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'go' || act === 'again') startRun();
    else if (act === 'resume') resume();
    else if (act === 'home' || act === 'start' || act === 'back') toHome();
  }
  function pause() {
    if (!S || S.phase !== 'run' || S.paused) return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad('run'); syncHead();
    kick();
  }
  function quitRun() {
    if (!S || S.phase !== 'run') return;
    S.paused = false;
    var f = S.f;
    if (f.phase === 'ready') { toHome(); return; }
    if (f.phase !== 'dead') f.cause = 'quit';
    f.phase = 'done';
    endRun();
  }

  // ---- input: one action (hold), from keys, the pad, the play field and a gamepad ----
  var HOLD_KEYS = { Space: 1, ArrowUp: 1, KeyW: 1, Enter: 1, NumpadEnter: 1 };
  var KEY2CODE = { ' ': 'Space', arrowup: 'ArrowUp', w: 'KeyW', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function held() {
    if (!S) return false;
    for (var k in S.keys) if (S.keys[k]) return true;
    for (var id in S.ptrs) return true;
    return !!S.gp.hold || S.latch;
  }
  function clearInput() { S.keys = {}; S.ptrs = {}; S.gp.hold = false; S.latch = false; syncPad(); }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) { gp.hold = false; return; }
    var was = gp.hold;
    gp.hold = btnOn(p, 0) || btnOn(p, 7) || btnOn(p, 5) || btnOn(p, 12) || (p.axes[1] || 0) < -0.6;
    if (was !== gp.hold) syncPad();
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'run' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'run' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else padAction(); }
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
      if (S.phase === 'run' && !S.paused) pause();
      else if (S.cardKind === 'help' && S.phase !== 'help') closeHelp();
      else closePanel();
      return;
    }
    if (S.phase === 'run') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (HOLD_KEYS[code]) e.preventDefault();
        return;
      }
      if (HOLD_KEYS[code]) { e.preventDefault(); if (!S.keys[code]) { S.keys[code] = true; S.latch = true; syncPad(); } }
      return;
    }
    // between runs Space / Enter does the big button's job — unless a button in the panel has focus
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (S.keys[code]) { delete S.keys[code]; syncPad(); }
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
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.6 : 1.4), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 288) { s = Math.max(0.55, Math.min(s, ah / 288)); vh2 = 288; }
    vh2 = Math.min(vh2, phone ? 460 : solo ? 400 : 340);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--cf-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.VH = S.cv.height / S.k;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.phase === 'run' && !S.paused && S.raf) return; draw(1, 0); }

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
    var body = '<div class="cf"><div class="cf-stage"><canvas class="cf-cv"></canvas><div class="cf-ovl" style="display:none"></div></div>' +
      '<div class="cf-pad"></div><div class="cf-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🚁 Cave Flyer', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'cf-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.cf-stage'), cv: p.querySelector('.cf-cv'), ovl: p.querySelector('.cf-ovl'),
      pad: p.querySelector('.cf-pad'), liveEl: p.querySelector('.cf-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'home', f: null, hf: null, paused: false, raf: 0, last: 0, endT: 0, idleT: 0,
      keys: {}, ptrs: {}, gp: { hold: false, start: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, k: 1, VH: 288, v: {}, hue: [],
      tx: new Float32Array(200), tc: new Float32Array(200), tf: new Float32Array(200), tz: new Int32Array(200),
      shake: 0, flash: 0, tilt: 0, tseq: 0, coinN: 0, coinT: 0, exT: 0, craftX: 0, craftY: 0,
      msg: null, msgQ: [], tab: 'look', resetArm: false, padMode: '', cardKind: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hf = newRun(4242, S.save.mode);
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

    // header: help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        if (!S.snd.on) S.snd.hum(0);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'run') pause();
        if (S.cardKind === 'help') closeHelp();
        else if (S.phase !== 'help') { S.helpFrom = S.cardKind; showCard('help'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout. CSS does
    // most of it (touch-action / user-select / touch-callout); iOS still zooms on
    // a quick double tap or pinch in places, so the hold surfaces cancel their
    // touches outright and the panel swallows gesture / dblclick events.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', function (e) { if (el === S.cv || (e.target.closest && e.target.closest('[data-k]'))) noTouch(e); }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the play field and the pad's big button: hold (any number of fingers)
    function press(e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'run' || S.paused) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
      S.ptrs[e.pointerId] = 1; S.latch = true; syncPad();
    }
    function release(e) {
      if (!S) return;
      if (S.ptrs[e.pointerId]) { delete S.ptrs[e.pointerId]; syncPad(); }
    }
    S.cv.addEventListener('pointerdown', press);
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (b) press(e);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, release); S.pad.addEventListener(t, release); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    // cards: modes, tabs, the hangar, reset; pause buttons
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var cat = b.getAttribute('data-cat'), id = b.getAttribute('data-id'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act'), md = b.getAttribute('data-mode');
      var refocus = null;
      if (md) {
        if (MODES[md] && S.save.mode !== md) {
          S.save.mode = md; persist();
          S.snd.tone(660 + MODE_IDS.indexOf(md) * 110, 0.06, 'sine', 0.03);
          S.hf = demo(); showCard('home'); syncLabel(); draw(1, 0);
        }
        refocus = '[data-mode="' + md + '"]';
      } else if (cat) {
        var sv = S.save;
        if (owns(sv, cat, id)) { wear(sv, cat, id); persist(); S.snd.tone(988, 0.05, 'sine', 0.03); }
        else if (buy(sv, cat, id)) {
          persist();
          S.snd.tone(1047, 0.07, 'square', 0.03); S.snd.tone(1568, 0.12, 'square', 0.025, 0, 0.07);
          Cade.haptic && Cade.haptic(8);
        } else {
          var it = itemOf(cat, id);
          Cade.showToast && Cade.showToast(it.need ? 'Locked — ' + it.how : 'Needs $' + fmtInt(it.price) + ' (you have $' + fmtInt(sv.wallet) + ')', 'info', 1800);
          return;
        }
        showCard('home'); draw(1, 0);
        refocus = '[data-cat="' + cat + '"][data-id="' + id + '"]';
      } else if (tab) {
        S.tab = tab; showCard('home');
        refocus = '[data-tab="' + tab + '"]';
      }
      else if (act === 'reset') { S.resetArm = true; showCard('home'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('home'); }
      else if (act === 'reset-yes') {
        S.save = newSave(); S.save.seed = (Math.random() * 4294967295) >>> 0;
        persist(); S.tab = 'look';
        Cade.showToast && Cade.showToast('Progress reset', 'info', 1800);
        toHome();
      } else if (act === 'close-help') closeHelp();
      else if (act === 'resume') resume();
      else if (act === 'quit') quitRun();
      if (refocus && e.detail === 0) {
        var nb = S.ovl.querySelector(refocus);
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
      }
    });

    if (S.firstRun) {
      S.phase = 'help';
      S.save.seed = (Math.random() * 4294967295) >>> 0;
      persist();
      S.hf = demo();
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1, 0);
    } else toHome();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Hold to rise, let go to fall — thread a narrowing cave',
    icon: '🚁',
    tags: 'game,arcade,fun,one button,hold,cave,helicopter,endless,ascii',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
