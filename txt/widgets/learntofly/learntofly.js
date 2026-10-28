/* Learn to Fly — teach a penguin to fly, for Cade.txt.
 * The penguin slides down a launch ramp on a snowy cliff and glides off it.
 * Pitch with ↑/↓ (W/S, ←/→, a gamepad, the on-screen buttons — or point:
 * hold the mouse / a finger on the sky and the nose turns towards it). Taps
 * nudge, a held key turns faster. Diving gains speed, pulling up trades it for
 * height, pull too hard and the wing stalls. Space / Boost fires the rocket
 * (once bought); with no fuel left it flaps instead (three flaps a flight).
 * The sky has coins, speed rings, fish (fuel), balloons, birds, thermals that
 * lift and storm clouds that push down; loops and snow skips pay as stunts.
 * Every flight pays cash for distance, height, speed, airtime, coins and
 * stunts, plus the day's sponsor contract; cash buys a better ramp, sled,
 * glider, rocket, fuel tank and a lucky scarf. Milestones pay a bonus once;
 * smash through the ice wall at 10 km to win. A dozen secrets hide in the
 * world and the hangar (some award hats).
 * Drawn entirely in monospace glyphs (cached in a glyph atlas) on a canvas.
 * Physics runs on a fixed 120 Hz step with an accumulator, so flights are the
 * same at 60 or 120 Hz; rendering interpolates. The loop runs only while a
 * flight is on screen; it pauses on blur, tab hide and minimize. Progress
 * persists in Cade.store (cade-ltf-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: metres and seconds. x → right (distance from the ramp lip),
  // y → up. The plain is at y ≈ 0; the launch cliff is CLIFF metres tall.
  // Arcade gravity: TS scales time (TS² gravity, TS× speeds and rates), so a
  // long glide plays out briskly while every trajectory keeps its shape.
  var TS = 1.8, G = 9.81 * TS * TS, STEP = 1 / 120;
  var CLIFF = 50, LIP = 3, LIP_ANG = 0.35, TOP_ANG = -0.87;   // ramp lip / chute angles (rad)
  var WALL_X = 10000, CHUNK = 100, REF_H = 288, VIEW_W = 384; // REF_H × VIEW_W: logical px the zoom is defined for
  var ALPHA_S = 0.3;               // stall angle of attack (rad)
  var TRIM = 0.07;                 // hands-off, the nose settles this far above the flight path
  var PITCH_RATE = 2;              // rad/s while a pitch control is held
  var WEATHERVANE = 0.35 * TS;     // how fast a hands-off nose drifts back to the flight path (grows with speed)
  var PLATE = 0.012;               // flat-plate drag once the penguin is broadside to the air
  var ROCKET_TORQUE = 0.7;         // the rocket rides on the back, above the centre of mass: boosting tips the nose down (rad/s)
  var ATM_H = 800;                 // the air thins with height (exaggerated): high flight is fast flight
  var CRASH_V = 15 * TS, ROUGH_V = 7 * TS;   // touchdown speed into the snow: faceplant / rough landing
  var FLAPS = 3, FLAP_V = 3.4 * TS;          // no rocket (or no fuel): Boost flaps instead, a few times a flight
  var RAMP_IN = 0.25;                        // seconds a held pitch key takes to reach full rate (taps nudge)
  var RING_R = 3.2, THERMAL_LIFT = 2.6 * TS * TS, STORM_SINK = 3.2 * TS * TS;
  var YETI_X = 4200, IGLOO_X = 1337;         // landmarks on the snow (secrets)

  // Upgrades: tier 0 is what you start with; prices escalate.
  // glider: lift (1/m), drag = parasitic drag (1/m), idr = induced drag factor.
  var UPGRADES = [
    { id: 'ramp', name: 'Ramp', tiers: [
      { name: 'Snow bank', drop: 8 },
      { name: 'Plank ramp', drop: 13, price: 60 },
      { name: 'Ski jump', drop: 20, price: 260 },
      { name: 'Steel chute', drop: 30, price: 800 },
      { name: 'Mega ramp', drop: 42, price: 2200 },
      { name: 'Mountain run', drop: 58, price: 5500 }
    ] },
    { id: 'sled', name: 'Sled', tiers: [
      { name: 'Bare belly', mu: 0.11, push: 0, gmu: 0.5 },
      { name: 'Lunch tray', mu: 0.07, push: 3, gmu: 0.42, price: 40 },
      { name: 'Plastic sled', mu: 0.05, push: 5, gmu: 0.36, price: 220 },
      { name: 'Toboggan', mu: 0.035, push: 7, gmu: 0.3, price: 700 },
      { name: 'Bobsled', mu: 0.022, push: 10, gmu: 0.25, price: 1800 },
      { name: 'Rocket luge', mu: 0.012, push: 14, gmu: 0.2, price: 4200 }
    ] },
    { id: 'glider', name: 'Glider', tiers: [
      { name: 'Flippers', lift: 0.024, drag: 0.0033, idr: 0.0068 },
      { name: 'Cardboard wings', lift: 0.025, drag: 0.0019, idr: 0.0062, price: 80 },
      { name: 'Box kite', lift: 0.026, drag: 0.0011, idr: 0.0058, price: 340 },
      { name: 'Hang glider', lift: 0.027, drag: 0.00062, idr: 0.0053, price: 1000 },
      { name: 'Carbon wing', lift: 0.026, drag: 0.00034, idr: 0.0044, price: 2600 },
      { name: 'Albatross', lift: 0.022, drag: 0.00016, idr: 0.0036, price: 6500 }
    ] },
    { id: 'rocket', name: 'Rocket', tiers: [
      { name: 'No rocket', thrust: 0 },
      { name: 'Bottle rocket', thrust: 0.45, price: 150 },
      { name: 'Firework pack', thrust: 0.65, price: 600 },
      { name: 'Jet pack', thrust: 0.85, price: 1700 },
      { name: 'Turbojet', thrust: 1.1, price: 4000 },
      { name: 'Space engine', thrust: 1.35, price: 9000 }
    ] },
    { id: 'fuel', name: 'Fuel tank', needs: 'rocket', tiers: [
      { name: 'Soda can', fuel: 1.5 },
      { name: 'Thermos', fuel: 2.5, price: 120 },
      { name: 'Jerry can', fuel: 3.5, price: 450 },
      { name: 'Barrel', fuel: 5, price: 1300 },
      { name: 'Drop tank', fuel: 7, price: 3200 },
      { name: 'Fuel bladder', fuel: 9.5, price: 7000 }
    ] },
    { id: 'scarf', name: 'Lucky scarf', tiers: [
      { name: 'No scarf', mult: 1 },
      { name: 'Woolly scarf', mult: 1.2, price: 200 },
      { name: 'Striped scarf', mult: 1.4, price: 750 },
      { name: 'Silk scarf', mult: 1.65, price: 2200 },
      { name: 'Golden scarf', mult: 2, price: 5500 }
    ] }
  ];
  var UPG = {};
  for (var ui = 0; ui < UPGRADES.length; ui++) UPG[UPGRADES[ui].id] = UPGRADES[ui];

  // One-off milestones (each pays its bonus once). The last one wins the game.
  var GOALS = [
    { id: 'd100', kind: 'dist', at: 100, bonus: 50 },
    { id: 'd250', kind: 'dist', at: 250, bonus: 120 },
    { id: 'd500', kind: 'dist', at: 500, bonus: 250 },
    { id: 'd1k', kind: 'dist', at: 1000, bonus: 500 },
    { id: 'd2k5', kind: 'dist', at: 2500, bonus: 1200 },
    { id: 'd5k', kind: 'dist', at: 5000, bonus: 3000 },
    { id: 'd7k5', kind: 'dist', at: 7500, bonus: 5000 },
    { id: 'a50', kind: 'alt', at: 50, bonus: 60 },
    { id: 'a100', kind: 'alt', at: 100, bonus: 150 },
    { id: 'a250', kind: 'alt', at: 250, bonus: 400 },
    { id: 'a500', kind: 'alt', at: 500, bonus: 1000 },
    { id: 'a1k', kind: 'alt', at: 1000, bonus: 2500 },
    { id: 's25', kind: 'speed', at: 25, bonus: 50 },
    { id: 's50', kind: 'speed', at: 50, bonus: 250 },
    { id: 's100', kind: 'speed', at: 100, bonus: 800 },
    { id: 's150', kind: 'speed', at: 150, bonus: 2000 },
    { id: 't30', kind: 'time', at: 30, bonus: 100 },
    { id: 't60', kind: 'time', at: 60, bonus: 350 },
    { id: 't100', kind: 'time', at: 100, bonus: 1000 },
    { id: 'c10', kind: 'coins', at: 10, bonus: 150 },
    { id: 'c30', kind: 'coins', at: 30, bonus: 600 },
    { id: 'wall', kind: 'dist', at: WALL_X, bonus: 0, final: true }
  ];

  // Secrets: each pays once and some unlock a hat. hint is what the Secrets tab
  // shows before it is found.
  var EGGS = [
    { id: 'yeti', name: 'Yeti sighting', hint: 'Something big lives out past 4 km. Land near it.', bonus: 500 },
    { id: 'leet', name: '1337 igloo', hint: 'A very elite igloo. Slide up to it.', bonus: 337 },
    { id: 'ufo', name: 'Abducted', hint: 'Fly above 1.2 km and look for lights.', bonus: 600, hat: 'antenna' },
    { id: 'moon', name: 'Moonshot', hint: 'Reach for the moon (3 km up).', bonus: 1500 },
    { id: 'goldfish', name: 'Golden fish', hint: 'One fish in fifty is special.', bonus: 1000 },
    { id: 'bullseye', name: 'Bullseye', hint: 'Stop dead on a 500 m marker.', bonus: 400 },
    { id: 'wrongway', name: 'Wrong way!', hint: 'Penguins can fly backwards. Briefly.', bonus: 150 },
    { id: 'loops', name: 'Loop de loop de loop', hint: 'Three loops in one flight.', bonus: 450 },
    { id: 'skipper', name: 'Stone skipper', hint: 'Skip off the snow five times in one flight.', bonus: 350 },
    { id: 'faceplant', name: 'Gravity always wins', hint: 'Faceplant five days running.', bonus: 200 },
    { id: 'konami', name: 'Up up down down', hint: 'An old code works in the hangar.', bonus: 300, hat: 'party' },
    { id: 'noot', name: 'Noot noot', hint: 'Type what a penguin says, in the hangar.', bonus: 100 },
    { id: 'season', name: 'Seasonal visitor', hint: 'Only some times of year: hit the holiday guest.', bonus: 500 }
  ];
  var HATS = [
    { id: 'party', name: 'Party hat', ch: 94, how: 'secret: an old code' },
    { id: 'antenna', name: 'Antenna', ch: 89, how: 'secret: get abducted' },
    { id: 'tophat', name: 'Top hat', ch: 35, how: 'smash the ice wall' },
    { id: 'crown', name: 'Crown', ch: 87, how: 'find every other secret' }
  ];
  // The sponsor's contract for a day: one of these, sized to how far you've come.
  var MISSIONS = [
    { id: 'coins', at: function (b) { return Math.max(3, Math.min(15, Math.round(b / 120))); }, txt: 'Grab {n} coins', key: 'coins' },
    { id: 'rings', at: function (b) { return Math.max(1, Math.min(6, Math.round(b / 400))); }, txt: 'Fly through {n} ring{s}', key: 'rings', from: 150 },
    { id: 'loop', at: function () { return 1; }, txt: 'Fly a loop', key: 'loops', from: 120 },
    { id: 'skips', at: function () { return 2; }, txt: 'Skip off the snow {n} times', key: 'skips', from: 200 },
    { id: 'smooth', at: function (b) { return Math.max(60, Math.round(b * 0.8 / 10) * 10); }, txt: 'Land smoothly past {n} m', key: 'smoothDist' },
    { id: 'noboost', at: function (b) { return Math.max(60, Math.round(b * 0.6 / 10) * 10); }, txt: 'Fly {n} m without the rocket', key: 'noBoostDist', needs: 'rocket' },
    { id: 'alt', at: function (b) { return Math.max(30, Math.round(b * 0.12 / 5) * 5); }, txt: 'Climb {n} m high', key: 'maxAlt' },
    { id: 'balloons', at: function (b) { return b > 1500 ? 2 : 1; }, txt: 'Pop {n} balloon{s}', key: 'balloons', from: 300 }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrapA(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }

  // Small seeded PRNG (mulberry32) and an integer hash, so a flight is reproducible.
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

  // ---- terrain: the launch cliff, its face, then rolling snow out to the ice wall ----
  var FACE0 = 6, FACE1 = 22;
  function groundY(x) {
    if (x <= FACE0) return CLIFF;
    if (x < FACE1) { var c = (x - FACE0) / (FACE1 - FACE0); return CLIFF * (1 - c * c * (3 - 2 * c)); }
    var d = x - FACE1, amp = d < 300 ? d / 300 : 1;
    var h = amp * (3.2 * Math.sin(d / 47) + 2 * Math.sin(d / 113 + 1.7) + 0.9 * Math.sin(d / 21 + 0.4));
    var s1 = Math.sin(d / 420 - 1), s2 = Math.sin(d / 251 + 2);
    if (s1 > 0) { s1 *= s1 * s1; h += 16 * s1 * s1; }          // big humps: skids can jump them
    if (s2 > 0) { s2 *= s2; h += 9 * s2 * s2; }
    var w = x > WALL_X ? x - WALL_X : WALL_X - x;
    if (w < 400) { var u = w < 60 ? 0 : (w - 60) / 340; h *= u * u * (3 - 2 * u); }   // a flat ice field around the wall
    return h;
  }
  function groundSlope(x) { return (groundY(x + 0.25) - groundY(x - 0.25)) * 2; }

  // ---- the launch ramp: a straight chute at TOP_ANG, then a circular arc up to the lip ----
  function makeRamp(drop) {
    var R = 10 + 0.45 * drop, yl = CLIFF + LIP;
    var cx = -R * Math.sin(LIP_ANG), cy = yl + R * Math.cos(LIP_ANG);          // arc centre
    var qx = cx + R * Math.sin(TOP_ANG), qy = cy - R * Math.cos(TOP_ANG);       // arc start (bottom of the chute)
    var straight = Math.max(0, drop - R * (Math.cos(LIP_ANG) - Math.cos(TOP_ANG))) / Math.sin(-TOP_ANG);
    var arc = R * (LIP_ANG - TOP_ANG);
    return { drop: drop, R: R, cx: cx, cy: cy, qx: qx, qy: qy, straight: straight, len: straight + arc,
      x0: qx - straight * Math.cos(TOP_ANG), y0: qy - straight * Math.sin(TOP_ANG), yl: yl };
  }
  // Point on the ramp at arc length s from the top: fills out.x/y/a (slope angle)/k (curvature).
  function rampAt(rp, s, out) {
    if (s < rp.straight) {
      var back = rp.straight - s;
      out.x = rp.qx - back * Math.cos(TOP_ANG); out.y = rp.qy - back * Math.sin(TOP_ANG); out.a = TOP_ANG; out.k = 0;
    } else {
      var a = Math.min(LIP_ANG, TOP_ANG + (s - rp.straight) / rp.R);
      out.x = rp.cx + rp.R * Math.sin(a); out.y = rp.cy - rp.R * Math.cos(a); out.a = a; out.k = 1 / rp.R;
    }
    return out;
  }
  // Height of the ramp's surface at world x (NaN off the ramp) — for drawing.
  function rampYAt(rp, x) {
    if (x < rp.x0 || x > 0) return NaN;
    if (x <= rp.qx) return rp.y0 + (x - rp.x0) * Math.tan(TOP_ANG);
    var sn = clamp((x - rp.cx) / rp.R, -1, 1);
    return rp.cy - rp.R * Math.sqrt(1 - sn * sn);
  }

  // ---- gear: the stats of the upgrades a save owns ----
  function tierOf(up, id) {
    var u = UPG[id], lv = clamp((up && up[id]) | 0, 0, u.tiers.length - 1);
    return u.tiers[lv];
  }
  function gear(up) {
    var r = tierOf(up, 'ramp'), s = tierOf(up, 'sled'), g = tierOf(up, 'glider'), k = tierOf(up, 'rocket');
    var f = tierOf(up, 'fuel'), c = tierOf(up, 'scarf');
    return {
      drop: r.drop, mu: s.mu, push: s.push * TS, gmu: s.gmu, lift: g.lift, drag: g.drag, idr: g.idr,
      thrust: k.thrust * G, fuel: k.thrust > 0 ? f.fuel : 0, mult: c.mult
    };
  }
  // The glider's best glide ratio (L/D) — what the shop shows.
  function glideRatio(t) {
    var cl = Math.min(1, Math.sqrt(t.drag / t.idr));
    return t.lift * cl / (t.drag + t.idr * cl * cl);
  }

  function airDensity(y) { return y > 0 ? Math.exp(-y / ATM_H) : 1; }

  // Normalised lift curve: linear up to the stall angle, then it collapses to a
  // flat plate (sin 2α), so pulling too hard drops the penguin out of the sky.
  function liftCoef(a) {
    var aa = a < 0 ? -a : a, cl;
    if (aa <= ALPHA_S) cl = aa / ALPHA_S;
    else cl = 0.55 * Math.sin(2 * aa) / Math.sin(2 * ALPHA_S);
    return a < 0 ? -cl : cl;
  }

  // ---- sky items: coins, balloons and birds, generated per 100 m chunk ----
  // season: '' | 'halloween' | 'xmas' — the balloons and birds dress up.
  function chunkItems(seed, ci, out, season) {
    if (ci < 1) return;
    var x0 = ci * CHUNK;
    if (x0 >= WALL_X - CHUNK && x0 < WALL_X + CHUNK) return;
    var r = rng(hash2(seed, ci)), hmax = 26 + Math.min(700, x0 * 0.07), i, x, y;
    if (r() < 0.8) {
      var n = 3 + Math.floor(r() * 4), gap = 4 + Math.min(22, x0 * 0.004), arc = r() < 0.5;
      var h = 6 + Math.pow(r(), 1.5) * hmax, xs = x0 + 8 + r() * Math.max(1, CHUNK - 16 - n * gap);
      var val = 5 + Math.floor(x0 / 1000) * 3;
      for (i = 0; i < n; i++) {
        x = xs + i * gap;
        var bump = arc ? Math.sin(Math.PI * i / Math.max(1, n - 1)) * gap * 0.9 : 0;
        out.push({ kind: 'coin', x: x, y: groundY(x) + h + bump, v: val, ph: i * 0.7, hit: false, hitT: 0 });
      }
    }
    if (r() < 0.1 + Math.min(0.12, x0 / 40000)) {
      x = x0 + r() * CHUNK; y = groundY(x) + 10 + r() * hmax * 0.9;
      out.push({ kind: 'balloon', x: x, y: y, v: 20 + Math.floor(x0 / 1000) * 5, ph: r() * 6.28, hit: false, hitT: 0 });
    }
    if (x0 > 250 && r() < 0.14 + Math.min(0.12, x0 / 30000)) {
      x = x0 + r() * CHUNK; y = groundY(x) + 8 + r() * hmax;
      out.push({ kind: 'bird', x: x, y: y, v: 0, ph: r() * 6.28, hit: false, hitT: 0 });
    }
    // (drawn from a second stream, so the classic coins / balloons / birds above stay put)
    var r2 = rng(hash2(seed ^ 0x51ED, ci));
    if (x0 > 120 && r2() < 0.22) {                    // a speed ring, at the height you'd be gliding through
      x = x0 + 20 + r2() * 60; y = groundY(x) + 8 + Math.pow(r2(), 1.4) * hmax * 0.7;
      out.push({ kind: 'ring', x: x, y: y, v: 15 + Math.floor(x0 / 1000) * 4, ph: 0, hit: false, hitT: 0 });
    }
    if (r2() < 0.16) {                                // a fish: rocket fuel (or a flap back)
      x = x0 + r2() * CHUNK; y = groundY(x) + 5 + r2() * hmax * 0.6;
      out.push({ kind: x0 > 1500 && r2() < 0.02 ? 'gfish' : 'fish', x: x, y: y, v: 5, ph: r2() * 6.28, hit: false, hitT: 0 });
    }
    if (x0 > 300 && r2() < 0.17) {                    // a thermal: rising air off the snow (w wide, h tall)
      x = x0 + r2() * 70; out.push({ kind: 'thermal', x: x, y: 0, w: 16 + r2() * 18, h: 60 + r2() * (80 + x0 * 0.03), v: 0, ph: 0, hit: false, hitT: 0 });
    } else if (x0 > 900 && r2() < 0.12) {             // a storm cloud: sinking air and gloom
      x = x0 + r2() * 70; y = groundY(x) + 25 + r2() * hmax * 0.8;
      out.push({ kind: 'storm', x: x, y: y, w: 26 + r2() * 20, h: 18, v: 0, ph: r2() * 6, hit: false, hitT: 0 });
    }
    if (season && r2() < 0.35) {                      // the holiday guest
      x = x0 + r2() * CHUNK; y = groundY(x) + 12 + r2() * hmax * 0.8;
      out.push({ kind: season === 'xmas' ? 'sleigh' : 'pumpkin', x: x, y: y, v: 40, ph: r2() * 6.28, hit: false, hitT: 0 });
    }
  }
  // The season a date falls in (the holiday guests and decorations).
  function seasonOf(d) {
    var m = d.getMonth(), day = d.getDate();
    if ((m === 9 && day >= 24) || (m === 10 && day <= 1)) return 'halloween';
    if (m === 11 && day >= 12 && day <= 31) return 'xmas';
    return '';
  }
  // Is (x, y) inside an air-mass item (thermal column or storm cloud)?
  function inAir(it, x, y) {
    if (it.kind === 'thermal') return x >= it.x && x <= it.x + it.w && y < groundY(x) + it.h;
    return x >= it.x && x <= it.x + it.w && y > it.y - it.h / 2 && y < it.y + it.h / 2;
  }
  function itemY(it, t) {
    if (it.kind === 'fish' || it.kind === 'gfish') return it.y + Math.sin(t * 3 + it.ph) * 0.8;
    if (it.kind === 'pumpkin' || it.kind === 'sleigh' || it.kind === 'ufo') return it.y + Math.sin(t * 1.6 + it.ph) * 1.2;
    if (it.kind === 'bird') return it.y + Math.sin(t * 2.6 + it.ph) * 1.4;
    if (it.kind === 'balloon') return it.y + Math.sin(t * 1.3 + it.ph) * 1.0;
    return it.y;
  }

  // ---- a flight ----
  function newFlight(up, seed, opts) {
    var g = gear(up), rp = makeRamp(g.drop), p = rampAt(rp, 0, {});
    var f = {
      seed: seed >>> 0, g: g, rp: rp, phase: 'ramp', s: 0, rv: Math.max(0.6, g.push), pt: {},
      x: p.x, y: p.y, vx: 0, vy: 0, th: TOP_ANG, px: p.x, py: p.y, pth: TOP_ANG,
      fuel: g.fuel, boosting: false, landed: false, contactT: 9, landKind: '',
      t: 0, ft: 0, air: 0, restT: 0, maxAlt: 0, maxSpeed: 0, maxX: 0, coins: 0, coinCash: 0,
      balloons: 0, birds: 0, bounces: 0, stall: false, wall: false, wallUp: !(opts && opts.noWall), wallT: 0, acc: 0, steps: 0,
      zoom: 1, pzoom: 1, cg: CLIFF, pcg: CLIFF, items: [], nextChunk: 1, hitQ: [], events: [],
      season: (opts && opts.season) || '', flaps: FLAPS, boostPrev: false, holdT: 0,
      rings: 0, fish: 0, loops: 0, loopRot: 0, skips: 0, wrongT: 0, boostUsed: false, noBoostX: 0,
      ufo: null, eggs: [], lift: 0
    };
    f.zoom = f.pzoom = zoomTarget(f);
    return f;
  }
  function speedOf(f) { return f.phase === 'ramp' ? f.rv : Math.sqrt(f.vx * f.vx + f.vy * f.vy); }
  function altOf(f) { return f.y - groundY(f.x); }

  // Camera zoom (logical px per metre for a REF_H-tall view). Part of the engine
  // because what the penguin can touch (hit radius) is defined on screen.
  function zoomTarget(f) {
    var agl = Math.max(0, f.y - (f.phase === 'ramp' ? CLIFF : groundY(f.x)));
    var H = clamp(32 + agl * 1.9 + speedOf(f) * 0.6 / TS, 32, 2600);
    return REF_H / H;
  }
  function hitR(f) { return Math.max(1.6, 13 / f.zoom); }

  function finishFlight(f) {
    if (f.phase === 'done') return;
    f.phase = 'done'; f.boosting = false;
    // stopped dead on a 500 m marker
    var d = f.x - Math.round(f.x / 500) * 500;
    if (f.x > 400 && d > -1 && d < 1) egg(f, 'bullseye');
    f.events.push('done');
  }
  // A secret found in flight (paid once, at settle).
  function egg(f, id) { if (f.eggs.indexOf(id) < 0) { f.eggs.push(id); f.events.push('egg'); } }

  // One fixed physics step. `inp` = { up, down, boost } held this step.
  function stepFlight(f, inp) {
    if (f.phase === 'done') return;
    var g = f.g, dt = STEP, ev = f.events, up = !!(inp && inp.up), down = !!(inp && inp.down);
    var aim = inp && inp.aim != null && inp.aim === inp.aim ? +inp.aim : null;
    var press = !!(inp && inp.boost), edge = press && !f.boostPrev;
    f.boostPrev = press;
    var wantBoost = press && f.fuel > 0 && g.thrust > 0;
    f.holdT = up !== down ? f.holdT + dt : 0;
    f.px = f.x; f.py = f.y; f.pth = f.th; f.pzoom = f.zoom; f.pcg = f.cg;
    f.steps++; f.t += dt;
    if (wantBoost !== f.boosting) { f.boosting = wantBoost; ev.push(wantBoost ? 'boost' : 'boostoff'); }
    var thrust = 0;
    if (f.boosting) {
      thrust = g.thrust; f.fuel = Math.max(0, f.fuel - dt); f.boostUsed = true;
      if (f.fuel <= 0) { f.boosting = false; ev.push('boostoff'); ev.push('empty'); }
    }

    if (f.phase === 'ramp') {
      var rp = f.rp, p = rampAt(rp, f.s, f.pt);
      var acc = -G * Math.sin(p.a) - g.mu * (G * Math.cos(p.a) + f.rv * f.rv * p.k) - g.drag * 0.5 * f.rv * f.rv + thrust;
      f.rv = Math.max(0.6, f.rv + acc * dt);
      f.s += f.rv * dt;
      if (f.s >= rp.len) {
        f.phase = 'air'; f.x = 0; f.y = rp.yl;
        f.vx = f.rv * Math.cos(LIP_ANG); f.vy = f.rv * Math.sin(LIP_ANG); f.th = LIP_ANG;
        ev.push('launch');
      } else {
        p = rampAt(rp, f.s, f.pt);
        f.x = p.x; f.y = p.y; f.th = p.a; f.vx = f.rv * Math.cos(p.a); f.vy = f.rv * Math.sin(p.a);
      }
      if (f.rv > f.maxSpeed) f.maxSpeed = f.rv;
    } else {
      f.ft += dt;
      var V = speedOf(f), gam = V > 0.01 ? Math.atan2(f.vy, f.vx) : f.th;
      // pitch: the controls rotate the penguin; hands off, the nose drifts back to
      // a slightly nose-up glide along the flight path (and lies flat on the snow)
      if (thrust && f.contactT > 0.12) f.th = wrapA(f.th - ROCKET_TORQUE * dt);
      // flap: Boost with nothing to burn (and still in the air)
      if (edge && !wantBoost && f.flaps > 0 && f.contactT > 0.2) {
        f.flaps--; f.vy = Math.max(f.vy, 0) + FLAP_V; f.vx *= 0.97; ev.push('flap');
      }
      var pth0 = f.th;
      if (aim !== null) {                         // pointing: turn towards it, a little faster than the keys
        var err = wrapA(aim - f.th), mx = PITCH_RATE * 1.25 * dt;
        f.th = wrapA(f.th + (err > mx ? mx : err < -mx ? -mx : err));
      } else if (up !== down) f.th = wrapA(f.th + (up ? 1 : -1) * PITCH_RATE * (0.45 + 0.55 * Math.min(1, f.holdT / RAMP_IN)) * dt);
      else if (f.contactT < 0.12) f.th = wrapA(f.th + wrapA(Math.atan(groundSlope(f.x)) - f.th) * Math.min(1, 9 * TS * dt));
      else f.th = wrapA(f.th + wrapA(gam + TRIM - f.th) * Math.min(1, WEATHERVANE * (0.4 + V / (40 * TS)) * dt));
      var ax = 0, ay = -G;
      if (V > 0.01) {
        var a = wrapA(f.th - gam), cl = liftCoef(a), sn = Math.sin(a);
        var stalled = (a > ALPHA_S || a < -ALPHA_S) && V > 3 * TS && f.contactT > 0.3;
        if (stalled !== f.stall) { f.stall = stalled; if (stalled) ev.push('stall'); }
        var q = V * V * airDensity(f.y), L = g.lift * q * cl, D = q * (g.drag + g.idr * cl * cl + PLATE * sn * sn);
        var ux = f.vx / V, uy = f.vy / V;
        ax += -uy * L - ux * D; ay += ux * L - uy * D;
      }
      if (thrust) { ax += thrust * Math.cos(f.th); ay += thrust * Math.sin(f.th); }
      // thermals lift, storm clouds push down (and drag)
      f.lift = 0;
      for (var ii = 0; ii < f.items.length; ii++) {
        var am = f.items[ii];
        if ((am.kind !== 'thermal' && am.kind !== 'storm') || !inAir(am, f.x, f.y)) continue;
        if (am.kind === 'thermal') { var fade = 1 - clamp((f.y - groundY(f.x)) / am.h, 0, 1); ay += THERMAL_LIFT * (0.35 + 0.65 * fade); f.lift = 1; }
        else { ay -= STORM_SINK; ax -= f.vx * 0.25; f.lift = -1; }
      }
      f.vx += ax * dt; f.vy += ay * dt;
      // loops: a full turn of the nose in the air (either way)
      if (f.contactT > 0.3) {
        f.loopRot += wrapA(f.th - pth0);
        if (f.loopRot > 2 * Math.PI || f.loopRot < -2 * Math.PI) {
          f.loopRot -= (f.loopRot > 0 ? 2 : -2) * Math.PI; f.loops++; ev.push('loop');
          if (f.loops === 3) egg(f, 'loops');
        }
      }
      f.x += f.vx * dt; f.y += f.vy * dt;
      // the snow: land, bounce or skid; friction while in contact
      var gy = groundY(f.x);
      f.contactT += dt;
      if (f.y <= gy) {
        f.y = gy;
        var sl = groundSlope(f.x), nl = Math.sqrt(1 + sl * sl), nx = -sl / nl, ny = 1 / nl, tx = 1 / nl, ty = sl / nl;
        var vn = f.vx * nx + f.vy * ny, vt = f.vx * tx + f.vy * ty, bounce = 0;
        if (vn < 0) {
          var imp = -vn;
          if (!f.landed) {
            f.landed = true;
            if (imp > CRASH_V) { f.landKind = 'crash'; vt *= 0.4; ev.push('crash'); }
            else if (imp > ROUGH_V) { f.landKind = 'rough'; vt *= 0.85; ev.push('rough'); }
            else { f.landKind = 'smooth'; ev.push('smooth'); }
          } else if (imp > ROUGH_V && f.contactT > 0.25) { vt *= 0.85; f.bounces++; ev.push('bounce'); }
          if (imp > 4 * TS) bounce = imp * 0.3;
          // a skim: off the snow at a shallow angle and still fast — a stone skip
          if (bounce && f.contactT > 0.25 && vt > 14 * TS && imp < vt * 0.35) { f.skips++; bounce = Math.max(bounce, 3 * TS); ev.push('skip'); if (f.skips === 5) egg(f, 'skipper'); }
        }
        if (!bounce) {                          // sliding: snow friction (normal force ~ g cos slope)
          var dec = g.gmu * G * ny * dt;
          vt = Math.abs(vt) <= dec ? 0 : vt - (vt > 0 ? dec : -dec);
        }
        f.vx = vt * tx + bounce * nx; f.vy = vt * ty + bounce * ny;
        f.contactT = 0; f.loopRot = 0;
      } else f.air += dt;
      V = speedOf(f);
      if (f.contactT < 0.12 && V < 0.5 * TS) { f.restT += dt; if (f.restT > 0.3) finishFlight(f); }
      else if (f.contactT < 0.12 && V < 2.5 * TS) { f.restT += dt * 0.25; if (f.restT > 1.5) finishFlight(f); }
      else f.restT = 0;
      if (f.t > 600) finishFlight(f);
      if (V > f.maxSpeed) f.maxSpeed = V;
      var agl = f.y - gy;
      if (agl > f.maxAlt) f.maxAlt = agl;
      if (f.x > f.maxX) f.maxX = f.x;
      if (!f.boostUsed) f.noBoostX = f.maxX;
      // oddities: backwards flight, the landmarks, the moon, the lights in the sky
      if (f.vx < -2 * TS && f.contactT > 0.3) { f.wrongT += dt; if (f.wrongT > 0.6) egg(f, 'wrongway'); } else f.wrongT = 0;
      if (agl < 4 && Math.abs(f.x - YETI_X) < 14) egg(f, 'yeti');
      if (agl < 4 && Math.abs(f.x - IGLOO_X) < 10) egg(f, 'leet');
      if (agl > 3000) egg(f, 'moon');
      if (!f.ufo && agl > 1200) { f.ufo = { kind: 'ufo', x: f.x + 70 + Math.abs(f.vx) * 1.2, y: f.y + 8, v: 0, ph: 0, hit: false, hitT: 0 }; f.items.push(f.ufo); ev.push('ufo'); }
      // the ice wall: smash through it (it soaks up most of the speed) — that's the win
      if (f.wallUp && !f.wall && f.x >= WALL_X) { f.wall = true; f.wallT = f.t; f.vx *= 0.3; f.vy *= 0.3; ev.push('wall'); }
      if (f.wall && f.t - f.wallT > 2.2) finishFlight(f);
    }
    // camera: zoom (log-smoothed) and the ground level it frames — deterministic
    var zt = zoomTarget(f);
    f.zoom = Math.exp(Math.log(f.zoom) + (Math.log(zt) - Math.log(f.zoom)) * Math.min(1, 1.4 * TS * dt));
    f.cg += ((f.phase === 'ramp' ? CLIFF : groundY(f.x)) - f.cg) * Math.min(1, 2 * TS * dt);
    if (f.phase !== 'ramp') touchItems(f);
  }

  // Keep items generated ahead of the camera, drop the ones far behind, and
  // collect / bump into the ones within reach.
  function touchItems(f) {
    var ahead = f.x + 0.75 * VIEW_W / f.zoom + 60, items = f.items, i;
    if (f.nextChunk * CHUNK < ahead) {
      var behind = f.x - 0.45 * VIEW_W / f.zoom - 60, k = 0;
      for (i = 0; i < items.length; i++) if (items[i].x >= behind) items[k++] = items[i];
      items.length = k;
      while (f.nextChunk * CHUNK < ahead) chunkItems(f.seed, f.nextChunk++, items, f.season);
      if (f.ufo && items.indexOf(f.ufo) < 0 && !f.ufo.hit) items.push(f.ufo);
    }
    var R = hitR(f), ev = f.events;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.hit || it.kind === 'thermal' || it.kind === 'storm') continue;
      var Ri = it.kind === 'ring' ? Math.max(R, RING_R) : it.kind === 'ufo' ? Math.max(R, 6) : R;
      var dx = it.x - f.x;
      if (dx > Ri || dx < -Ri) continue;
      var dy = itemY(it, f.t) - f.y, rr = it.kind === 'coin' || it.kind === 'ring' || it.kind === 'ufo' ? Ri : R * 0.8;
      if (dx * dx + dy * dy > rr * rr) continue;
      it.hit = true; it.hitT = f.t; f.hitQ.push(it);
      if (it.kind === 'coin') { f.coins++; f.coinCash += it.v; ev.push('coin'); }
      else if (it.kind === 'ring') {
        f.rings++; f.coinCash += it.v;
        var V0 = speedOf(f) || 1; f.vx += f.vx / V0 * 6 * TS; f.vy += f.vy / V0 * 6 * TS; ev.push('ring');
      } else if (it.kind === 'fish' || it.kind === 'gfish') {
        f.fish++; f.coinCash += it.kind === 'gfish' ? 1000 : it.v;
        if (f.g.fuel > 0) f.fuel = Math.min(f.g.fuel, f.fuel + 0.6); else f.flaps = Math.min(FLAPS + 2, f.flaps + 1);
        ev.push('fish');
        if (it.kind === 'gfish') egg(f, 'goldfish');
      } else if (it.kind === 'ufo') {             // beamed up, set down further along
        f.x += 250; f.y += 60; f.vy = Math.max(f.vy, 0); ev.push('abduct'); egg(f, 'ufo');
      } else if (it.kind === 'pumpkin' || it.kind === 'sleigh') {
        f.balloons++; f.coinCash += it.v; f.vy = Math.max(f.vy, 0) + 9 * TS; ev.push('season'); egg(f, 'season');
      } else if (it.kind === 'balloon') {
        f.balloons++; f.coinCash += it.v;
        f.vy = Math.max(f.vy, 0) + 11 * TS; ev.push('balloon');
      } else {
        f.birds++;
        f.vx *= 0.72; f.vy = f.vy * 0.72 - 2 * TS; f.th = wrapA(f.th - 0.5); ev.push('bird');
      }
    }
  }

  // Fixed-timestep accumulator: consume real frame time in STEP slices.
  // `inp` is read for every step. Returns the render alpha.
  function advance(f, dt, inp) {
    f.acc += clamp(dt, 0, 0.1);
    var n = 0;
    while (f.acc >= STEP - 1e-7 && f.phase !== 'done') {
      stepFlight(f, inp);
      f.acc -= STEP;
      if (++n >= 30) { f.acc = 0; break; }
    }
    return f.phase === 'done' ? 1 : clamp(f.acc / STEP, 0, 1);
  }

  function summary(f) {
    return {
      dist: Math.max(0, Math.round(f.maxX * 10) / 10), maxAlt: Math.round(f.maxAlt * 10) / 10,
      maxSpeed: Math.round(f.maxSpeed * 10) / 10, time: Math.round(f.ft * 10) / 10,
      coins: f.coins, coinCash: f.coinCash, balloons: f.balloons, birds: f.birds,
      landing: f.landKind || 'smooth', wall: f.wall,
      rings: f.rings, fish: f.fish, loops: f.loops, skips: f.skips, flaps: FLAPS - f.flaps, boostUsed: f.boostUsed,
      noBoostDist: Math.round(f.noBoostX * 10) / 10, smoothDist: (f.landKind || 'smooth') === 'smooth' ? Math.round(f.maxX * 10) / 10 : 0,
      eggs: f.eggs.slice()
    };
  }

  // Run a whole flight headless. `pilot(f)` returns the input for each step (or null).
  function simulate(up, seed, pilot, opts) {
    var f = newFlight(up, seed, opts), none = { up: false, down: false, boost: false, aim: null };
    while (f.phase !== 'done' && f.steps < 100000) { stepFlight(f, pilot ? pilot(f) || none : none); f.events.length = 0; f.hitQ.length = 0; }
    return summary(f);
  }

  // ---- economy ----
  function newSave() {
    var up = {};
    for (var i = 0; i < UPGRADES.length; i++) up[UPGRADES[i].id] = 0;
    return { v: 1, cash: 0, day: 1, up: up, goals: {}, best: { dist: 0, alt: 0, speed: 0, time: 0 },
      won: false, wonDay: 0, bestWinDay: 0, ngp: 0, flights: 0, seed: 1, eggs: {}, hat: '', last: 0, plants: 0 };
  }
  // Clamp whatever came out of storage into a valid save (older / hand-edited data).
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    function num(v, d, lo, hi) { v = +v; return isFinite(v) ? clamp(v, lo, hi) : d; }
    s.cash = Math.floor(num(o.cash, 0, 0, 1e9));
    s.day = Math.floor(num(o.day, 1, 1, 1e6));
    s.flights = Math.floor(num(o.flights, 0, 0, 1e6));
    s.ngp = Math.floor(num(o.ngp, 0, 0, 99));
    s.seed = Math.floor(num(o.seed, 1, 0, 4294967295));
    s.won = !!o.won; s.wonDay = Math.floor(num(o.wonDay, 0, 0, 1e6)); s.bestWinDay = Math.floor(num(o.bestWinDay, 0, 0, 1e6));
    for (var i = 0; i < UPGRADES.length; i++) {
      var u = UPGRADES[i];
      s.up[u.id] = Math.floor(num(o.up && o.up[u.id], 0, 0, u.tiers.length - 1));
    }
    if (o.goals && typeof o.goals === 'object') for (var j = 0; j < GOALS.length; j++) if (o.goals[GOALS[j].id]) s.goals[GOALS[j].id] = 1;
    if (o.eggs && typeof o.eggs === 'object') for (var e = 0; e < EGGS.length; e++) if (o.eggs[EGGS[e].id]) s.eggs[EGGS[e].id] = 1;
    s.hat = typeof o.hat === 'string' && hatOwned(s, o.hat) ? o.hat : '';
    s.last = num(o.last, 0, 0, 1e7);
    s.plants = Math.floor(num(o.plants, 0, 0, 1e6));
    if (o.best && typeof o.best === 'object') {
      s.best.dist = num(o.best.dist, 0, 0, 1e7); s.best.alt = num(o.best.alt, 0, 0, 1e7);
      s.best.speed = num(o.best.speed, 0, 0, 1e5); s.best.time = num(o.best.time, 0, 0, 1e5);
    }
    return s;
  }
  function hatOwned(save, id) {
    if (id === 'tophat') return !!save.won || !!save.bestWinDay;
    if (id === 'crown') { for (var i = 0; i < EGGS.length; i++) if (EGGS[i].id !== 'season' && !save.eggs[EGGS[i].id]) return false; return true; }
    for (var j = 0; j < EGGS.length; j++) if (EGGS[j].hat === id) return !!save.eggs[EGGS[j].id];
    return false;
  }
  function eggOf(id) { for (var i = 0; i < EGGS.length; i++) if (EGGS[i].id === id) return EGGS[i]; return null; }
  // Mark a secret found; returns it the first time (its bonus is paid by the caller), else null.
  function findEgg(save, id) {
    var e = eggOf(id);
    if (!e || save.eggs[id]) return null;
    save.eggs[id] = 1;
    return e;
  }
  // The day's sponsor contract (deterministic per save + day).
  function missionFor(save) {
    var b = Math.max(40, save.best.dist), pool = MISSIONS.filter(function (m) {
      return b >= (m.from || 0) && (!m.needs || save.up[m.needs] > 0);
    });
    var m = pool[hash2(save.seed ^ 0xC0FFEE, save.day) % pool.length], n = m.at(b);
    var reward = Math.max(40, Math.round((30 + b * 0.25) / 10) * 10);
    return { id: m.id, key: m.key, n: n, reward: reward, text: m.txt.replace('{n}', n).replace('{s}', n === 1 ? '' : 's') };
  }
  function missionDone(m, res) { return (+res[m.key] || 0) >= m.n; }
  function priceOf(save, id) {
    var u = UPG[id], lv = save.up[id] | 0;
    return lv + 1 < u.tiers.length ? u.tiers[lv + 1].price : 0;
  }
  // '' when it can be bought, else why not: 'max' | 'locked' | 'cash'
  function canBuy(save, id) {
    var u = UPG[id], lv = save.up[id] | 0;
    if (lv + 1 >= u.tiers.length) return 'max';
    if (u.needs && !(save.up[u.needs] > 0)) return 'locked';
    if (save.cash < u.tiers[lv + 1].price) return 'cash';
    return '';
  }
  function buy(save, id) {
    if (canBuy(save, id)) return false;
    save.cash -= priceOf(save, id);
    save.up[id] = (save.up[id] | 0) + 1;
    return true;
  }
  function goalValue(res, kind) {
    return kind === 'dist' ? res.dist : kind === 'alt' ? res.maxAlt : kind === 'speed' ? res.maxSpeed : kind === 'time' ? res.time : res.coins;
  }
  // Pay a finished flight into the save. Returns the itemised card.
  function settle(save, res) {
    var lines = [
      { key: 'dist', label: 'Distance', amt: Math.round(res.dist * 0.5) },
      { key: 'alt', label: 'Max altitude', amt: Math.round(res.maxAlt * 0.8) },
      { key: 'speed', label: 'Top speed', amt: Math.round(res.maxSpeed * 0.8) },
      { key: 'time', label: 'Flight time', amt: Math.round(res.time) },
      { key: 'coins', label: 'Coins', amt: res.coinCash | 0 }
    ];
    var stunt = 60 * (res.loops | 0) + 40 * (res.skips | 0);
    if (stunt) lines.push({ key: 'stunts', label: 'Stunts', amt: stunt });
    var base = 0, i;
    for (i = 0; i < lines.length; i++) base += lines[i].amt;
    var mult = tierOf(save.up, 'scarf').mult * (1 + 0.25 * save.ngp);
    var bonus = Math.round(base * (mult - 1));
    var goals = [], gsum = 0;
    for (i = 0; i < GOALS.length; i++) {
      var gl = GOALS[i];
      if (save.goals[gl.id] || goalValue(res, gl.kind) < gl.at) continue;
      save.goals[gl.id] = 1; goals.push(gl); gsum += gl.bonus;
    }
    // the sponsor's contract and any secrets found on the way
    var mis = missionFor(save), misOk = missionDone(mis, res), eggs = [], esum = 0;
    if (res.landing === 'crash') { save.plants++; if (save.plants >= 5) (res.eggs = (res.eggs || []).concat('faceplant')); } else save.plants = 0;
    (res.eggs || []).forEach(function (id) { var e = findEgg(save, id); if (e) { eggs.push(e); esum += e.bonus; } });
    var total = base + bonus + gsum + (misOk ? mis.reward : 0) + esum, b = save.best, rec = {};
    if (res.dist > b.dist) { b.dist = res.dist; rec.dist = true; }
    if (res.maxAlt > b.alt) { b.alt = res.maxAlt; rec.alt = true; }
    if (res.maxSpeed > b.speed) { b.speed = res.maxSpeed; rec.speed = true; }
    if (res.time > b.time) { b.time = res.time; rec.time = true; }
    var won = !!res.wall && !save.won;
    if (won) { save.won = true; save.wonDay = save.day; if (!save.bestWinDay || save.day < save.bestWinDay) save.bestWinDay = save.day; }
    save.cash += total;
    save.last = res.dist;
    save.day++; save.flights++;
    return { day: save.day - 1, lines: lines, base: base, mult: mult, bonus: bonus, goals: goals, goalSum: gsum,
      mission: mis, missionOk: misOk, eggs: eggs, eggSum: esum, total: total, records: rec, won: won };
  }
  // New Game+: start over (upgrades, cash, goals) with a permanent +25% cash bonus.
  function newGamePlus(save) {
    var s = newSave();
    s.ngp = Math.min(99, save.ngp + 1); s.bestWinDay = save.bestWinDay; s.seed = (save.seed + 7919) >>> 0;
    s.eggs = save.eggs; s.hat = save.hat;                // secrets and hats are for keeps
    return s;
  }
  function flightSeed(save) { return hash2(save.seed, save.day) || 1; }

  var ENGINE = {
    TS: TS, STEP: STEP, G: G, CLIFF: CLIFF, LIP: LIP, LIP_ANG: LIP_ANG, WALL_X: WALL_X, CHUNK: CHUNK,
    REF_H: REF_H, VIEW_W: VIEW_W, ALPHA_S: ALPHA_S, ATM_H: ATM_H, airDensity: airDensity, FACE0: FACE0, FACE1: FACE1, UPGRADES: UPGRADES, UPG: UPG, GOALS: GOALS,
    rng: rng, hash2: hash2, groundY: groundY, groundSlope: groundSlope, makeRamp: makeRamp, rampAt: rampAt, rampYAt: rampYAt,
    gear: gear, tierOf: tierOf, glideRatio: glideRatio, liftCoef: liftCoef, chunkItems: chunkItems, itemY: itemY,
    newFlight: newFlight, stepFlight: stepFlight, advance: advance, summary: summary, simulate: simulate,
    speedOf: speedOf, altOf: altOf, hitR: hitR, zoomTarget: zoomTarget, wrapA: wrapA,
    newSave: newSave, normSave: normSave, priceOf: priceOf, canBuy: canBuy, buy: buy, settle: settle,
    newGamePlus: newGamePlus, flightSeed: flightSeed,
    FLAPS: FLAPS, EGGS: EGGS, HATS: HATS, MISSIONS: MISSIONS, YETI_X: YETI_X, IGLOO_X: IGLOO_X,
    seasonOf: seasonOf, inAir: inAir, findEgg: findEgg, eggOf: eggOf, hatOwned: hatOwned, missionFor: missionFor, missionDone: missionDone
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('learntofly.css');

  var PANEL_ID = 'learntofly-panel', NAME = 'Learn to Fly';
  var KEY = 'cade-ltf-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var VW = VIEW_W, CW = 8, RH = 12;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.learntofly = { live: function () { return S; } };   // test-only peek

  // palette slots, filled from the theme (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_SNOW = 4, C_SNOWTX = 5, C_FAR = 6, C_NEAR = 7,
    C_WOOD = 8, C_BEAK = 9, C_GOLD = 10, C_RED = 11, C_FLAME = 12, C_ICE = 13, C_CLOUD = 14, C_STAR = 15, NPAL = 16;

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
  function money(n) { return '$' + fmtInt(n); }
  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    var k = m / 1000;
    return (k >= 10 ? k.toFixed(1) : k.toFixed(2)).replace(/\.?0+$/, '') + ' km';
  }

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
    P[C_SNOW] = css(mix(bg, tx, dark ? 0.62 : 0.48)); P[C_SNOWTX] = css(mix(bg, tx, dark ? 0.3 : 0.22));
    P[C_FAR] = css(mix(bg, ac, dark ? 0.2 : 0.17)); P[C_NEAR] = css(mix(bg, ac, dark ? 0.34 : 0.3));
    P[C_WOOD] = dark ? '#c99561' : '#8a5a2b'; P[C_BEAK] = dark ? '#f5a442' : '#d9771c';
    P[C_GOLD] = dark ? '#f2c544' : '#b07d06'; P[C_RED] = dark ? '#f06a6a' : '#cf3f3f';
    P[C_FLAME] = dark ? '#ff8f3f' : '#e2611f';
    P[C_ICE] = css(mix(ac, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.4 : 0.12));
    P[C_CLOUD] = css(mix(bg, tx, dark ? 0.24 : 0.2)); P[C_STAR] = css(mix(bg, tx, dark ? 0.42 : 0.3));
    S.col = {
      bg: css(bg), fill: css(dark ? mix(bg, tx, 0.075) : mix(bg, ac, 0.07)), hud: css(bg, 0.8),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace'
    };
    fitFont();
  }

  // ---- glyph rendering ----
  // Everything is drawn as monospace glyphs on a CW × RH cell grid. Each
  // (colour, character) pair is rendered once into an atlas canvas at device
  // resolution and stamped with drawImage — far cheaper than fillText per glyph
  // on iOS. The font size is fitted to the font's real advance.
  var AT_COLS = 24, AT_ROWS = 16;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
    buildClouds();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.cwp = Math.ceil((CW + 6) * S.k); a.chp = Math.ceil((RH + 10) * S.k);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k; a.ch = a.chp / S.k; a.n = 0; a.max = AT_COLS * AT_ROWS;
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
  // One glyph centred on (x, y) in logical units, snapped to the device pixel grid unless `nosnap`;
  // `sc` scales it (HUD labels, snowflakes).
  function glyph(c, ci, code, x, y, nosnap, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {                       // non-ASCII or a full atlas: plain text (rare)
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
    var sc = dec === 2 ? 100 : dec === 1 ? 10 : 1, iv = Math.round(v * sc), ip = Math.floor(iv / sc), fp = iv - ip * sc;
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
  // Distance label for a ground marker: 300m, 1.5k, 10k.
  function writeDist(d) {
    if (d < 1000) { var n = writeNum(d, 0); NB[n++] = 109; return n; }
    var k = d / 1000, m = writeNum(k, k === Math.floor(k) ? 0 : 1);
    NB[m++] = 107;
    return m;
  }

  // Cloud tiles: pre-rendered once per theme / size.
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

  // ASCII mountain ranges (as in Flit): a seeded walk of / \ and _, cyclic.
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
  var FAR = range(11, 6, 320), NEAR = range(29, 3, 260);
  var CLOUD_P = 1700, CLOUDS = (function () {
    var r = rng(5), a = [];
    for (var i = 0; i < 48; i++) a.push({ u: r() * CLOUD_P, v: -40 + Math.pow(r(), 0.85) * 1900, s: Math.floor(r() * 3) });
    return a;
  })();
  var STARS = (function () {
    var r = rng(7), a = [];
    for (var i = 0; i < 34; i++) a.push({ x: r() * 640, y: r() * 520, c: r() < 0.12 ? 43 : r() < 0.2 ? 42 : 46 });
    return a;
  })();
  var TEX = [46, 32, 58, 32, 39, 32, 32, 46, 32, 42, 32, 32, 44, 32, 32, 46];   // . : ' * , under the snow line

  // ---- penguin sprite (local frame: +x is the nose) ----
  // Three rows: the wing (or a flapping flipper) over the back, the body with
  // its tail — or the rocket strapped on as a tail — and the sled underneath.
  // Columns are counted from the belly: the head (") sits at 3..5, the beak at 6.
  var BODY = '(__(")>';
  var SLEDS = ['', '-----', '\\____/', '(_____/', '\\=====/', '<======>'];
  var WINGS = ['', '[____]', '<|==|>', '/-----\\', '/=======\\', '_/~~~~~~~\\_'];
  var ROCKETS = ['=', '[)', '[]', '[#]', '[##]', '<##]'];

  function drawPenguin(c, f, x, y, th, t) {
    var up = S.save.up, k, ch, ci;
    var dizzy = f.landKind === 'crash' && f.contactT < 0.2;
    c.save();
    c.translate(x, y);
    c.rotate(-th);
    var sled = SLEDS[up.sled | 0], by = sled ? -RH * 1.02 : -RH * 0.55;
    function col(i) { return (i - 2.5) * CW; }
    if (sled) drawStr(c, C_WOOD, sled, col(2), -RH * 0.3, 'center', true);
    for (k = 0; k < BODY.length; k++) {
      ch = BODY.charCodeAt(k); ci = k === 6 ? C_BEAK : C_TEXT;
      if (k === 4 && dizzy) ch = 120;                                   // x_x after a faceplant
      if ((up.scarf | 0) > 0 && (k === 2 || (k === 1 && Math.sin(t * 14) > 0.2))) { ch = 126; ci = C_RED; }
      glyph(c, ci, ch, col(k), by, true);
    }
    var rk = ROCKETS[up.rocket | 0], rx = col(-rk.length);
    drawStr(c, (up.rocket | 0) ? C_MUTED : C_TEXT, rk, rx - CW / 2, by, 'left', true);
    if (f.boosting) {                                                    // flame flickers behind the nozzle
      var fl = (t * 30) | 0;
      glyph(c, C_FLAME, fl % 2 ? 42 : 126, rx - CW, by, true);
      glyph(c, C_FLAME, fl % 3 ? 61 : 45, rx - CW * 2, by, true);
      if (fl % 2) glyph(c, C_GOLD, 46, rx - CW * 2.9, by, true);
    }
    var wing = WINGS[up.glider | 0], flapping = S.flapT > 0;
    if (wing) drawStr(c, C_ACC, wing, col(2), by - RH * (flapping ? 1.25 + 0.25 * Math.sin(S.flapT * 40) : 1.02), 'center', true);
    else if (f.phase !== 'ramp') {                                      // no wings yet: flap those flippers
      var flap = ((S.inp.up || S.inp.down || S.inp.aim != null) && f.contactT > 0.2) || flapping ? Math.sin(t * 28) : 0;
      glyph(c, C_TEXT, flap > 0.3 ? 92 : flap < -0.3 ? 47 : 45, col(1.5), by - RH * 0.72, true);
    }
    var hat = S.save.hat;
    if (hat) {
      for (k = 0; k < HATS.length; k++) if (HATS[k].id === hat) glyph(c, hat === 'party' ? C_RED : hat === 'crown' ? C_GOLD : hat === 'antenna' ? C_ACC : C_TEXT, HATS[k].ch, col(4), by - RH * 0.82, true);
    }
    c.restore();
    if (dizzy || (f.phase === 'done' && f.landKind === 'crash')) {      // stars circle a faceplanted head
      for (k = 0; k < 2; k++) {
        var a = t * 5 + k * Math.PI;
        glyph(c, C_GOLD, 42, x + CW * 1.5 + Math.cos(a) * CW * 1.6, y - RH * 2.1 + Math.sin(a) * RH * 0.35, true);
      }
    }
  }

  // ---- particles (world space) and money pop-ups; pools allocated once ----
  var NPART = 72, NPOP = 10;
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0, g: 0 });
    S.pops = [];
    for (i = 0; i < NPOP; i++) S.pops.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_GOLD });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.pops[i].on = false;
  }
  function spark(x, y, vx, vy, life, code, ci, g) {
    var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
    p.on = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.code = code; p.ci = ci; p.g = g || 0;
  }
  function burst(x, y, n, sp, codes, ci, g, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.abs(Math.sin(a)) * v * 0.9, life * (0.6 + Math.random() * 0.5), codes.charCodeAt(i % codes.length), ci, g);
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
    var m = { text: text, ci: ci == null ? C_TEXT : ci, t: 0, dur: dur || 1.3 };
    if (queue && S.msg && S.msgQ.length < 3) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
  }

  // ---- the scene ----
  // Camera: the engine's zoom (px per metre); the penguin sits 30% from the left,
  // the ground stays in the lower part of the view until the penguin climbs high.
  function view(f, a) {
    var v = S.v, VH = S.VH;
    v.x = f.px + (f.x - f.px) * a; v.y = f.py + (f.y - f.py) * a;
    v.th = f.pth + wrapA(f.th - f.pth) * a;
    v.z = f.pzoom + (f.zoom - f.pzoom) * a;
    var cg = f.pcg + (f.cg - f.pcg) * a;
    v.left = v.x - 0.3 * VW / v.z;
    v.bottom = Math.max(cg - (0.15 * REF_H + 0.45 * Math.max(0, VH - REF_H)) / v.z, v.y - 0.5 * VH / v.z);
    v.cg = cg;
    return v;
  }
  function X(v, wx) { return (wx - v.left) * v.z; }
  function Y(v, wy) { return S.VH - (wy - v.bottom) * v.z; }

  function draw(alpha, dt) {
    if (!S || !S.ctx || !S.atl) return;
    var f = S.f || S.hf, c = S.ctx, VH = S.VH, v = view(f, alpha), z = v.z, i, n;
    var t = S.f ? f.t : 0;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) {
      var sh = S.shake * 9;
      c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    // climb high enough and the sky turns to space
    var alt = Math.max(0, v.y - groundY(v.x)), space = clamp((alt - 500) / 2500, 0, 0.88);
    if (space > 0) { c.fillStyle = 'rgba(8,10,26,' + space.toFixed(3) + ')'; c.fillRect(-10, -10, VW + 20, VH + 20); }
    // parallax offsets are render state: they follow the camera's on-screen motion
    var dl = 0;
    if (S.lastLeft !== null && dt > 0) {
      dl = (v.left - S.lastLeft) * z;
      if (dl > -400 && dl < 400) { S.cloudOff += dl * 0.45; S.farOff += dl * 0.12; S.nearOff += dl * 0.28; } else dl = 0;
    }
    S.lastLeft = v.left;
    var gl = Y(v, v.cg);                                   // the ground line near the penguin, on screen

    if (S.dark || space > 0.25) {
      if (!S.dark) c.globalAlpha = Math.min(1, (space - 0.25) * 2);
      for (i = 0; i < STARS.length; i++) {
        var st = STARS[i], sx = ((st.x - S.farOff * 0.3) % 640 + 640) % 640 - 100, sy = st.y - 40;
        if (sx > -4 && sx < VW + 4 && sy < gl - RH * 6) glyph(c, S.dark ? C_STAR : C_CLOUD, st.c, sx, sy, false, st.c === 46 ? 1 : 0.75);
      }
      c.globalAlpha = 1;
    }
    if (alt > 1500) drawMoon(c, alt);
    // clouds drift down past you as you climb
    var cy = 260 * Math.log(1 + Math.max(0, v.bottom) / 40) / Math.LN2;
    for (i = 0; i < CLOUDS.length; i++) {
      var cl = CLOUDS[i], tl = S.cloudT[cl.s], cx = ((cl.u - S.cloudOff) % CLOUD_P + CLOUD_P) % CLOUD_P - 160;
      var cyy = VH * 0.38 - cl.v + cy;
      if (cx < VW && cx + tl.w > 0 && cyy > -tl.h && cyy < Math.min(VH, gl - RH * 2)) c.drawImage(tl.cv, cx, cyy, tl.w, tl.h);
    }
    // mountain ranges on the horizon
    if (gl < VH + RH * 9) { ridge(c, FAR, S.farOff, gl + RH * 0.3, C_FAR, 0.75); ridge(c, NEAR, S.nearOff, gl + RH * 0.5, C_NEAR, 0.8); }

    drawTerrain(c, v);
    if (X(v, 0) > -CW && X(v, f.rp.x0) < VW + CW) drawRamp(c, v, f.rp);
    drawMarkers(c, v);
    drawLandmarks(c, v, t);
    drawWall(c, v, f);
    if (S.f) drawItems(c, v, f);

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
      var q = S.pops[i];
      if (!q.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.1 - q.t));
      n = writeNum(q.v, 0, true);
      var qx = X(v, q.x), qy = Y(v, q.y) - RH * 1.5 - q.t * 26;
      glyph(c, q.ci, 43, qx - (n + 1) * CW / 2, qy);
      glyph(c, q.ci, 36, qx - (n - 1) * CW / 2, qy);
      drawNum(c, q.ci, n, qx + CW / 2, qy, 'center');
    }
    c.globalAlpha = 1;

    S.penX = X(v, v.x); S.penY = Y(v, v.y);
    if (S.f && S.aimAt && S.phase === 'fly') {           // where the pointer is steering: a dotted line
      var ax = S.aimAt.x - S.penX, ay = S.aimAt.y - S.penY, al = Math.sqrt(ax * ax + ay * ay) || 1;
      c.globalAlpha = 0.5;
      for (i = 2; i < 6; i++) glyph(c, C_ACC, 46, S.penX + ax / al * i * CW * 1.4, S.penY + ay / al * i * CW * 1.4);
      c.globalAlpha = 1;
    }
    if (S.f && S.phase === 'fly' && speedOf(f) > 95 && !S.rm) {   // speed lines
      c.globalAlpha = clamp((speedOf(f) - 95) / 60, 0.15, 0.6);
      for (i = 0; i < 7; i++) {
        var lx = ((i * 97 - t * 900) % (VW + 60) + VW + 60) % (VW + 60) - 30, ly = 46 + ((i * 53) % (VH - 70));
        drawStr(c, C_FAINT, '----', lx, ly, 'left');
      }
      c.globalAlpha = 1;
    }
    drawPenguin(c, f, S.penX, S.penY, v.th, S.f ? t : 0);

    // falling snow (screen space, cheap)
    if (!S.rm && S.flakes) {
      var fl = S.flakes;
      for (i = 0; i < fl.length; i += 3) {
        if (dt > 0) {
          fl[i] -= dl * 0.6 + Math.sin(t * 1.3 + i) * 6 * dt;
          fl[i + 1] += (14 + fl[i + 2] * 10) * dt;
          if (fl[i + 1] > VH) { fl[i + 1] -= VH + 8; fl[i] = Math.random() * VW; }
          fl[i] = ((fl[i] % VW) + VW) % VW;
        }
        glyph(c, C_SNOWTX, fl[i + 2] > 0.85 ? 42 : fl[i + 2] > 0.6 ? 39 : 46, fl[i], fl[i + 1], false, 0.8);
      }
    }
    if (S.f && S.phase === 'fly') hud(c, f, v);
    if (S.msg && S.phase === 'fly') banner(c, S.msg.text, RH * 4.6, S.msg.ci);
    if (S.f && S.phase === 'fly' && f.stall && f.phase === 'air' && ((t * 3) | 0) % 2 === 0 && !S.msg) banner(c, 'STALL! nose down', RH * 4.6, C_RED);
    if (S.flash > 0 && !S.rm) {
      c.fillStyle = 'rgba(255,255,255,' + (S.flash * 1.6).toFixed(3) + ')';
      c.fillRect(-10, -10, VW + 20, VH + 20);
    }
  }

  function ridge(c, cols, off, base, ci, yk) {
    var i0 = Math.floor(off / CW), sx = -(off - i0 * CW), N = cols.length, n = VW / CW + 2;
    for (var j = 0; j < n; j++) {
      var g = cols[((i0 + j) % N + N) % N];
      glyph(c, ci, g[0], sx + j * CW + CW / 2, base - g[1] * RH * yk + (g[0] === 95 ? -RH * 0.45 : 0));
    }
  }

  // Snow: a filled polygon under the surface line, the line itself in glyphs
  // (_ / \ |) chosen by the on-screen slope, and a sprinkle of texture below.
  function drawTerrain(c, v) {
    var z = v.z, VH = S.VH, k0 = Math.floor(v.left * z / CW) - 1, n = Math.ceil(VW / CW) + 3, TXs = S.tx, TYs = S.ty, j;
    for (j = 0; j < n; j++) {
      var k = k0 + j, sx = k * CW + CW / 2 - v.left * z;
      TXs[j] = sx; TYs[j] = Y(v, groundY((k * CW + CW / 2) / z));
    }
    c.fillStyle = S.col.fill;
    c.beginPath();
    c.moveTo(TXs[0] - CW, VH + 20);
    for (j = 0; j < n; j++) c.lineTo(TXs[j], TYs[j]);
    c.lineTo(TXs[n - 1] + CW, VH + 20);
    c.closePath();
    c.fill();
    for (j = 0; j < n; j++) {
      var y = TYs[j], x = TXs[j];
      if (y > VH + RH || x < -CW || x > VW + CW) continue;
      var r = ((j < n - 1 ? TYs[j + 1] : y) - (j > 0 ? TYs[j - 1] : y)) / (2 * CW);
      var ch = r > 2.2 || r < -2.2 ? 124 : r < -0.8 ? 47 : r > 0.8 ? 92 : 95;
      if (y > -RH) glyph(c, C_SNOW, ch, x, ch === 95 ? y - RH * 0.42 : y - RH * 0.08);
      // sheer drops (the cliff face): fill the gap down to the next column
      if (j < n - 1) {
        var d = TYs[j + 1] - y;
        if (d > RH * 1.4) faceFill(c, y, TYs[j + 1], x + CW * 0.5);
        if (d < -RH * 1.4) faceFill(c, TYs[j + 1], y, x + CW * 0.5);
      }
      var h = hash2(k0 + j, 3);
      for (var row = 1; row <= 3; row++) {
        var ty = y + row * RH * 0.92;
        if (ty > VH + RH || ty < -RH) continue;
        var code = TEX[(h >>> (row * 4)) & 15];
        if (code !== 32) glyph(c, C_SNOWTX, code, x + ((h >>> (row + 16)) & 1 ? CW * 0.25 : 0), ty);
      }
    }
  }

  // A sheer face between two columns (the cliff): a column of | glyphs, on-screen rows only.
  function faceFill(c, ya, yb, x) {
    var yy = ya + RH * 0.6;
    if (yy < -RH) yy += Math.ceil((-RH - yy) / RH) * RH;
    for (; yy < yb - RH * 0.3 && yy < S.VH + RH; yy += RH) glyph(c, C_SNOW, 124, x, yy);
  }

  // The launch ramp: a wooden chute on a trestle, a flag at the top.
  function drawRamp(c, v, rp) {
    var z = v.z, k0 = Math.floor(v.left * z / CW) - 1, n = Math.ceil(VW / CW) + 3, top = Y(v, CLIFF);
    for (var j = 0; j < n; j++) {
      var k = k0 + j, sx = k * CW + CW / 2 - v.left * z, wx = (k * CW + CW / 2) / z;
      if (sx < -CW || sx > VW + CW) continue;
      var ry = rampYAt(rp, wx);
      if (ry !== ry) continue;                                // NaN: off the ramp
      var sl = (rampYAt(rp, wx + 0.4) - rampYAt(rp, wx - 0.4)) / 0.8;
      if (sl !== sl) sl = wx > -1 ? Math.tan(LIP_ANG) : -1;
      var sy = Y(v, ry), ch = sl < -0.45 ? 92 : sl > 0.3 ? 47 : 95;
      glyph(c, C_WOOD, ch, sx, ch === 95 ? sy - RH * 0.4 : sy - RH * 0.05);
      // trestle: posts on every other column, rungs every third row
      var yy0 = sy + RH * 0.85, row = yy0 < -RH ? Math.ceil((-RH - yy0) / RH) : 0;
      for (var yy = yy0 + row * RH; yy < top - RH * 0.2 && yy < S.VH + RH; yy += RH, row++) {
        if ((k & 1) === 0) glyph(c, C_WOOD, 124, sx, yy);
        else if (row % 4 === 1) glyph(c, C_WOOD, 45, sx, yy);
      }
    }
    var fx = X(v, rp.x0 - 1), fy = Y(v, rp.y0);
    glyph(c, C_MUTED, 124, fx, fy - RH * 0.6); glyph(c, C_MUTED, 124, fx, fy - RH * 1.6);
    glyph(c, C_RED, 62, fx + CW * 0.8, fy - RH * 2.05);
    glyph(c, C_RED, 124, fx, fy - RH * 2.4);
  }

  // The moon, once you're high enough to care (it grows as you climb).
  var MOON = ["   _.._", " .' .-'`", "/  /", "|  |", "\\  \\", " '._'-._", "    `''"];
  function drawMoon(c, alt) {
    var sc = clamp(0.8 + (alt - 1500) / 2500, 0.8, 1.6), x = VW * 0.72, y = 48 + 30 * (1 - clamp((alt - 1500) / 2000, 0, 1));
    for (var r = 0; r < MOON.length; r++) drawStr(c, C_GOLD, MOON[r], x, y + r * RH * 0.8 * sc, 'left', false, sc * 0.8);
  }
  // Landmarks on the snow: the 1337 igloo and the yeti (both hide secrets).
  var YETI = [' .--. ', '(o  o)', '/|__|\\', ' ^  ^ '], YETI_W = [' .--. ', '(o  o)/', '/|__| ', ' ^  ^ '];
  var IGLOO = ['  ____  ', ' /_|__\\ ', '/_|_|_|\\', '|_|__|_|'];
  function drawLandmarks(c, v, t) {
    var r;
    if (inView(v, IGLOO_X)) {
      var gx = X(v, IGLOO_X), gy = Y(v, groundY(IGLOO_X));
      for (r = 0; r < IGLOO.length; r++) drawStr(c, C_ICE, IGLOO[r], gx, gy - RH * (IGLOO.length - r - 0.4), 'center');
      drawStr(c, C_MUTED, '1337', gx, gy - RH * (IGLOO.length + 0.8), 'center', false, 0.8);
    }
    if (inView(v, YETI_X)) {
      var yx = X(v, YETI_X), yy = Y(v, groundY(YETI_X)), wave = ((t * 2) | 0) % 2 ? YETI_W : YETI;
      for (r = 0; r < YETI.length; r++) drawStr(c, C_TEXT, wave[r], yx, yy - RH * (YETI.length - r - 0.4), 'center');
    }
  }
  function inView(v, x) { var sx = X(v, x); return sx > -CW * 12 && sx < VW + CW * 12; }
  function drawMarkers(c, v) {
    var z = v.z, M = z > 0.9 ? 100 : z > 0.2 ? 500 : 1000, right = v.left + VW / z;
    // flags for your best flight and yesterday's
    var sv = S.save;
    flag(c, v, sv.best.dist, 'BEST', C_GOLD);
    if (sv.last > 5 && Math.abs(sv.last - sv.best.dist) > 4) flag(c, v, sv.last, 'LAST', C_MUTED);
    for (var d = Math.max(M, Math.ceil(v.left / M) * M); d <= right && d <= WALL_X; d += M) {
      var sx = X(v, d), sy = Y(v, groundY(d));
      if (sy < -RH * 3 || sy > S.VH + RH * 3) continue;
      glyph(c, C_MUTED, 124, sx, sy - RH * 0.55);
      glyph(c, C_MUTED, 124, sx, sy - RH * 1.5);
      var n = writeDist(d);
      drawNum(c, d % 1000 === 0 ? C_ACC : C_MUTED, n, sx + CW * 0.5, sy - RH * 2.4, 'center');
    }
  }

  function flag(c, v, d, label, ci) {
    if (!(d > 1)) return;
    var sx = X(v, d), sy = Y(v, groundY(d));
    if (sx < -CW * 4 || sx > VW + CW * 4 || sy < -RH * 3 || sy > S.VH + RH * 3) return;
    glyph(c, ci, 124, sx, sy - RH * 0.55); glyph(c, ci, 124, sx, sy - RH * 1.5);
    drawStr(c, ci, label, sx + CW * 0.5, sy - RH * 2.2, 'left', false, 0.8);
  }
  // The ice wall at 10 km: sky-high blocks of ice, rubble once it's smashed.
  function drawWall(c, v, f) {
    var sx = X(v, WALL_X);
    if (sx > VW + CW * 2 || sx < -CW * 6) return;
    var gy = Y(v, 0), r, x;
    if (f.wall || !f.wallUp) {
      for (r = 0; r < 2; r++) for (x = 0; x < 5; x++) glyph(c, C_ICE, (x + r) % 2 ? 35 : 42, sx + x * CW + CW * 0.5 + r * CW * 0.5, gy - RH * (0.5 + r));
      return;
    }
    var r0 = Math.max(0, Math.ceil((gy - RH * 1.5 - S.VH) / RH));
    for (r = r0, x = gy - RH * 0.5 - r0 * RH; x > -RH; x -= RH, r++) drawStr(c, C_ICE, r % 2 ? '[##]' : '#[]#', sx, x, 'left');
    drawStr(c, C_ICE, 'ICE WALL', sx - CW * 1, gy - RH * 0.5 - Math.min(gy - RH * 3, RH * 12), 'right');
  }

  function drawItems(c, v, f) {
    var items = f.items, t = f.t, VH = S.VH, lx = -1e9, ly = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.hit) continue;
      var sx = X(v, it.x);
      if (it.kind === 'thermal' || it.kind === 'storm') { drawAir(c, v, it, t); continue; }
      if (sx < -CW * 2 || sx > VW + CW * 2) continue;
      var sy = Y(v, itemY(it, t));
      if (sy < -RH * 2 || sy > VH + RH * 2) continue;
      if (it.kind === 'coin') {
        if (sx - lx < CW * 1.1 && Math.abs(sy - ly) < RH * 0.7) continue;
        lx = sx; ly = sy;
        glyph(c, C_GOLD, ((t * 6 + it.ph) | 0) % 6 === 0 ? 83 : 36, sx, sy);
      }
      else if (it.kind === 'balloon') {
        var bc = f.season === 'halloween' ? C_FLAME : C_RED;
        drawStr(c, bc, '/~\\', sx, sy - RH * 0.5, 'center');
        drawStr(c, bc, '\\_/', sx, sy + RH * 0.5, 'center');
        glyph(c, C_MUTED, 124, sx, sy + RH * 1.4);
      } else if (it.kind === 'ring') {
        var rr = Math.max(RH * 0.95, 3.2 * v.z), np = 12;
        for (var q = 0; q < np; q++) { var a2 = q / np * Math.PI * 2; glyph(c, C_ACC, 111, sx + Math.cos(a2) * rr * 0.45, sy + Math.sin(a2) * rr, false, 0.8); }
      } else if (it.kind === 'fish' || it.kind === 'gfish') {
        drawStr(c, it.kind === 'gfish' ? C_GOLD : C_ICE, '><>', sx, sy, 'center');
        if (it.kind === 'gfish' && ((t * 8) | 0) % 3 === 0) glyph(c, C_GOLD, 42, sx + CW * 2, sy - RH * 0.6, false, 0.7);
      } else if (it.kind === 'ufo') {
        drawStr(c, C_ACC, '_/O\\_', sx, sy - RH * 0.4, 'center');
        drawStr(c, C_MUTED, '(=====)', sx, sy + RH * 0.4, 'center');
        if (((t * 6) | 0) % 2) drawStr(c, C_GOLD, ': : :', sx, sy + RH * 1.3, 'center');
      } else if (it.kind === 'pumpkin') drawStr(c, C_FLAME, '(^v^)', sx, sy, 'center');
      else if (it.kind === 'sleigh') { drawStr(c, C_RED, '\\_=/', sx, sy, 'center'); drawStr(c, C_GOLD, '*', sx + CW * 3, sy - RH * 0.4, 'center'); }
      else if (f.season === 'halloween') drawStr(c, C_TEXT, Math.sin(t * 12 + it.ph) > 0 ? '^v^' : '-v-', sx, sy, 'center');   // bats
      else drawStr(c, C_MUTED, Math.sin(t * 9 + it.ph) > 0 ? '\\v/' : '-v-', sx, sy, 'center');
    }
  }

  // Air masses: a thermal's rising '^' in a column; a storm cloud with the odd flash.
  function drawAir(c, v, it, t) {
    var x0 = X(v, it.x), x1 = X(v, it.x + it.w);
    if (x1 < -CW || x0 > VW + CW) return;
    var k, cols = Math.max(2, Math.round((x1 - x0) / (CW * 2.5)));
    if (it.kind === 'thermal') {
      for (k = 0; k < cols; k++) {
        var wx = it.x + (k + 0.5) / cols * it.w, g = groundY(wx);
        for (var j = 0; j < 4; j++) {
          var hy = ((t * 9 + j * it.h / 4 + k * 7) % it.h), sy = Y(v, g + hy);
          if (sy < -RH || sy > S.VH) continue;
          c.globalAlpha = 0.55 * (1 - hy / it.h);
          glyph(c, C_NEAR, 94, X(v, wx), sy);
        }
      }
      c.globalAlpha = 1;
    } else {
      var cy = Y(v, it.y), rows = ['~~~~~~~~', '~~~~~~~~~~', '~~~~~~~~'];
      if (cy < -RH * 3 || cy > S.VH + RH * 3) return;
      var sc = clamp((x1 - x0) / (10 * CW), 0.6, 3);
      for (k = 0; k < 3; k++) drawStr(c, C_MUTED, rows[k], (x0 + x1) / 2, cy + (k - 1) * RH * 0.8 * sc, 'center', false, sc);
      if (((t * 5 + it.ph) | 0) % 7 === 0) { glyph(c, C_GOLD, 47, (x0 + x1) / 2, cy + RH * 1.4 * sc, false, sc); glyph(c, C_GOLD, 92, (x0 + x1) / 2 + CW * sc * 0.6, cy + RH * 2.2 * sc, false, sc); }
    }
  }

  // A framed message across the top of the play field.
  function banner(c, s, y, ci) {
    var w = (s.length + 4) * CW;
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - RH * 0.8, w, RH * 1.6);
    glyph(c, ci, 91, VW / 2 - w / 2 + CW * 0.5, y);
    glyph(c, ci, 93, VW / 2 + w / 2 - CW * 0.5, y);
    drawStr(c, ci, s, VW / 2, y, 'center');
  }

  function hud(c, f, v) {
    var yl = 6, yv = 17, y2 = 29, n, g = f.g, L = 0.72, x;
    c.fillStyle = S.col.hud; c.fillRect(0, 0, VW, 35);
    drawStr(c, C_MUTED, 'DIST', 6, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'ALT', 102, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'SPEED', 198, yl, 'left', false, L);
    drawStr(c, C_MUTED, 'TIME', 294, yl, 'left', false, L);
    n = writeNum(Math.max(0, v.x), 0, true); x = drawNum(c, C_TEXT, n, 6, yv); glyph(c, C_MUTED, 109, x + 4, yv + 1, false, 0.85);
    n = writeNum(Math.max(0, v.y - groundY(v.x)), 0, true); x = drawNum(c, C_TEXT, n, 102, yv); glyph(c, C_MUTED, 109, x + 4, yv + 1, false, 0.85);
    n = writeNum(speedOf(f), 0); x = drawNum(c, C_TEXT, n, 198, yv); drawStr(c, C_MUTED, 'm/s', x + 1.5, yv + 1, 'left', false, 0.85);
    n = writeNum(f.ft, 1); x = drawNum(c, C_TEXT, n, 294, yv); glyph(c, C_MUTED, 115, x + 4, yv + 1, false, 0.85);
    if (g.fuel > 0 && f.fuel > 0) {
      var cells = 9, fr = f.fuel / g.fuel, on = Math.ceil(fr * cells - 0.001), cw = CW * L;
      x = drawStr(c, C_MUTED, 'FUEL [', 6, y2, 'left', false, L);
      for (var i = 0; i < cells; i++) glyph(c, i < on ? (f.boosting ? C_FLAME : fr < 0.25 ? C_RED : C_ACC) : C_FAINT, i < on ? 35 : 45, x + i * cw + cw / 2, y2, false, L);
      glyph(c, C_MUTED, 93, x + cells * cw + cw / 2, y2, false, L);
    }
    else {
      x = drawStr(c, C_MUTED, 'FLAPS ', 6, y2, 'left', false, L);
      for (var fi = 0; fi < Math.max(FLAPS, f.flaps); fi++) glyph(c, fi < f.flaps ? C_ACC : C_FAINT, fi < f.flaps ? 94 : 45, x + fi * CW * L + CW * L / 2, y2, false, L);
    }
    // angle of attack: a little gauge; the ends are the stall
    if (f.phase === 'air' && speedOf(f) > 1) {
      var aoa = wrapA(f.th - Math.atan2(f.vy, f.vx)), cells = 9, pos = clamp(Math.round((aoa / ALPHA_S + 1) / 2 * (cells - 1)), -1, cells), gx = 176;
      drawStr(c, C_MUTED, 'AOA', gx - CW * L * 4, y2, 'left', false, L);
      for (var ci2 = 0; ci2 < cells; ci2++) glyph(c, ci2 === pos ? (f.stall ? C_RED : C_ACC) : ci2 === 0 || ci2 === cells - 1 ? C_RED : C_FAINT, ci2 === pos ? 35 : ci2 === 4 ? 124 : 45, gx + ci2 * CW * L, y2, false, L);
      if (pos < 0 || pos >= cells) glyph(c, C_RED, 33, gx + (pos < 0 ? -1 : cells) * CW * L, y2, false, L);
      if (f.lift) drawStr(c, f.lift > 0 ? C_ACC : C_RED, f.lift > 0 ? 'LIFT^' : 'SINKv', gx + (cells + 0.5) * CW * L, y2, 'left', false, L);
    }
    if (f.wallUp && !f.wall) {                      // how far to the ice wall
      n = writeNum(Math.max(0, WALL_X - Math.max(0, v.x)) / 1000, 1); NB[n++] = 32; NB[n++] = 107; NB[n++] = 109;
      x = VW - 6 - n * CW * L;
      drawNum(c, C_ICE, n, x, y2, 'left', L);
      drawStr(c, C_MUTED, 'ICE WALL ', x, y2, 'right', false, L);
    } else if (f.wall) drawStr(c, C_ICE, 'WALL DOWN!', VW - 6, y2, 'right', false, L);
  }

  // ---- loop: runs only while a flight is on screen ----
  function running() {
    return !!S && S.phase === 'fly' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad();
    if (!S.raf && !running()) return;              // the gamepad paused it
    mergeInput();
    if (S.flapT > 0) S.flapT -= dt;
    var f = S.f, alpha = advance(f, dt, S.inp);
    handleEvents(f);
    liveGoals(f);
    stepFx(dt);
    if (f.boosting && !S.rm) {                       // exhaust puffs
      S.puffT -= dt;
      if (S.puffT <= 0) {
        S.puffT = 0.05;
        var V = speedOf(f) || 1;
        spark(f.x - f.vx / V * 3, f.y - f.vy / V * 3 + 1, -f.vx * 0.15, -f.vy * 0.15 + 1, 0.6, Math.random() < 0.5 ? 111 : 46, C_FAINT, 0);
      }
    }
    draw(alpha, dt);
    syncFuel();
    if (f.phase === 'done') {
      S.endT += dt;
      if (S.endT >= 1.3) { endFlight(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(f) {
    var ev = f.events, snd = S.snd, i, it;
    for (i = 0; i < f.hitQ.length; i++) {
      it = f.hitQ[i];
      if (it.kind === 'coin') { popup(it.x, it.y, it.v, C_GOLD); burst(it.x, it.y, 3, 6, '*.', C_GOLD, 0, 0.4); }
      else if (it.kind === 'balloon') { popup(it.x, it.y, it.v, C_GOLD); burst(it.x, it.y, 8, 14, "*'.~", C_RED, 9, 0.7); }
      else burst(it.x, it.y, 7, 10, "~',v", C_MUTED, 6, 0.9);
    }
    f.hitQ.length = 0;
    for (i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'launch':
          snd.tone(300, 0.28, 'sawtooth', 0.025, 900);
          Cade.haptic && Cade.haptic(10);
          say(f.g.fuel > 0 ? (S.coarse ? 'FLY! BOOST + pull UP' : 'FLY! space + pull up') : (S.coarse ? 'FLY! tap BOOST to flap' : 'FLY! space to flap'), C_ACC, 1.3);
          if (f.season) say(f.season === 'halloween' ? 'HAPPY HALLOWEEN!' : 'HO HO HO!', C_FLAME, 1.4, true);
          if (S.mission) say('CONTRACT: ' + S.mission.text.toUpperCase(), C_GOLD, 1.8, true);
          break;
        case 'flap':
          S.flapT = 0.25; snd.tone(520, 0.08, 'triangle', 0.035, 760);
          burst(f.x - 1, f.y, 4, 6, "',`", C_TEXT, 4, 0.6);
          break;
        case 'ring': say('RING! SPEED UP', C_ACC, 0.9, true); snd.tone(880, 0.07, 'sine', 0.04, 1760); break;
        case 'fish': say(f.g.fuel > 0 ? '+ FUEL' : '+ FLAP', C_ICE, 0.8, true); snd.tone(700, 0.06, 'sine', 0.035, 1000); break;
        case 'loop': say(f.loops > 1 ? 'LOOP x' + f.loops + '!' : 'LOOP!', C_GOLD, 1.1, true); snd.tone(660, 0.09, 'triangle', 0.04); snd.tone(990, 0.12, 'triangle', 0.035, 0, 0.08); break;
        case 'skip': say(f.skips > 1 ? 'SKIP x' + f.skips + '!' : 'SKIP!', C_GOLD, 1, true); snd.tone(400, 0.06, 'square', 0.03, 800); burst(f.x, f.y + 0.3, 6, 10, ".'*", C_SNOW, 10, 0.5); break;
        case 'ufo': say('...LIGHTS IN THE SKY?', C_ACC, 1.6, true); break;
        case 'abduct': S.flash = 0.5; say('ABDUCTED!', C_ACC, 1.4); [200, 300, 450, 675].forEach(function (fq, j) { snd.tone(fq, 0.12, 'sine', 0.04, 0, j * 0.09); }); break;
        case 'season': say(f.season === 'halloween' ? 'SPOOKY BOOST!' : 'SANTA BOOST!', C_FLAME, 1, true); snd.tone(330, 0.15, 'triangle', 0.04, 660); break;
        case 'egg': {
          var eg = eggOf(f.eggs[f.eggs.length - 1]);
          if (eg && !S.save.eggs[eg.id]) { say('SECRET: ' + eg.name.toUpperCase() + '!', C_GOLD, 2, true); [784, 988, 1175, 1568].forEach(function (fq, j) { snd.tone(fq, 0.1, 'square', 0.03, 0, j * 0.07); }); }
          break;
        }
        case 'boost': snd.tone(110, 0.25, 'sawtooth', 0.03, 220); break;
        case 'empty': say('OUT OF FUEL', C_FLAME, 1.2, true); snd.tone(220, 0.15, 'square', 0.03, 110); break;
        case 'stall':
          if (f.t - S.stallT > 1.5) { S.stallT = f.t; snd.tone(660, 0.07, 'square', 0.025); snd.tone(520, 0.09, 'square', 0.025, 0, 0.09); }
          break;
        case 'coin': snd.tone(1320, 0.06, 'sine', 0.04); snd.tone(1760, 0.09, 'sine', 0.03, 0, 0.05); Cade.haptic && Cade.haptic(5); break;
        case 'balloon': snd.tone(900, 0.05, 'square', 0.035, 300); say('BALLOON BOOST!', C_RED, 1, true); break;
        case 'bird': snd.tone(1500, 0.12, 'triangle', 0.035, 600); say('BIRD STRIKE!', C_MUTED, 1.1, true); Cade.haptic && Cade.haptic(18); break;
        case 'smooth':
          say('SMOOTH LANDING', C_ACC, 1.3, true); snd.tone(520, 0.1, 'sine', 0.04); snd.tone(780, 0.14, 'sine', 0.035, 0, 0.08);
          burst(f.x, f.y + 0.5, 6, 8, ".'*", C_SNOW, 10, 0.6);
          break;
        case 'rough':
          say('BUMPY LANDING', C_MUTED, 1.2, true); snd.tone(160, 0.14, 'square', 0.035, 90);
          burst(f.x, f.y + 0.5, 9, 12, ".'*", C_SNOW, 12, 0.7);
          break;
        case 'crash':
          say('FACEPLANT!', C_RED, 1.4, true); snd.tone(120, 0.25, 'square', 0.045, 50);
          burst(f.x, f.y + 0.5, 14, 16, ".*'#", C_SNOW, 14, 0.9);
          S.shake = 0.35; Cade.haptic && Cade.haptic(30);
          break;
        case 'bounce': burst(f.x, f.y + 0.5, 5, 9, ".'", C_SNOW, 10, 0.5); snd.tone(200, 0.08, 'square', 0.03, 120); break;
        case 'wall':
          S.flash = 0.45; S.shake = 0.5;
          burst(WALL_X + 2, f.y + 2, 30, 30, "#*[]'.", C_ICE, 14, 1.4);
          say('THE ICE WALL IS DOWN!', C_ICE, 2.4);
          [523, 659, 784, 1047, 1319].forEach(function (fq, j) { snd.tone(fq, 0.16, 'triangle', 0.045, 0, j * 0.1); });
          Cade.haptic && Cade.haptic(40);
          break;
        case 'done': S.endT = 0; break;
      }
    }
    ev.length = 0;
  }
  // Milestones reached mid-flight get a banner right away (they pay out on landing).
  function liveGoals(f) {
    var L = S.live;
    for (var i = L.length - 1; i >= 0; i--) {
      var gl = L[i], val = gl.kind === 'dist' ? f.maxX : gl.kind === 'alt' ? f.maxAlt : gl.kind === 'speed' ? f.maxSpeed : gl.kind === 'time' ? f.ft : f.coins;
      if (val < gl.at) continue;
      L.splice(i, 1);
      say('GOAL: ' + goalName(gl).toUpperCase() + '  +$' + fmtInt(gl.bonus), C_GOLD, 1.6, true);
      S.snd.tone(784, 0.1, 'triangle', 0.04); S.snd.tone(1175, 0.16, 'triangle', 0.035, 0, 0.1);
    }
  }

  // ---- phases: help → hangar (shop) → fly → results → (victory) → hangar ----
  function goalName(g) {
    var d = g.at;
    switch (g.kind) {
      case 'dist': return g.final ? 'Smash the ice wall at 10 km' : 'Fly ' + fmtDist(d);
      case 'alt': return 'Climb to ' + fmtDist(d);
      case 'speed': return 'Hit ' + d + ' m/s';
      case 'time': return 'Stay up ' + d + ' s';
      default: return 'Grab ' + d + ' coins';
    }
  }
  function launchSpeed(up) {
    var f = newFlight(up, 1), n = 0;
    while (f.phase === 'ramp' && n++ < 4000) stepFlight(f, null);
    return speedOf(f);
  }
  function withUp(up, id, lv) {
    var o = {};
    for (var k in up) o[k] = up[k];
    o[id] = lv;
    return o;
  }
  var ICONS = { ramp: '\\_/', sled: '[_]', glider: '/^\\', rocket: '[=>', fuel: '[#]', scarf: '~~' };
  function statLine(id, up) {
    var lv = up[id] | 0, u = UPG[id], cur = u.tiers[lv], nx = u.tiers[lv + 1];
    function arrow(a, b, unit) { return '<b>' + a + '</b>' + (b != null ? ' &rarr; <b class="nx">' + b + '</b>' : '') + (unit ? ' ' + unit : ''); }
    switch (id) {
      case 'ramp':
      case 'sled':
        return 'launch ' + arrow(Math.round(launchSpeed(up)), nx ? Math.round(launchSpeed(withUp(up, id, lv + 1))) : null, 'm/s');
      case 'glider': return 'glide ' + arrow(glideRatio(cur).toFixed(1) + ':1', nx ? glideRatio(nx).toFixed(1) + ':1' : null);
      case 'rocket': return 'thrust ' + arrow(cur.thrust ? cur.thrust.toFixed(2) + ' g' : 'none', nx ? nx.thrust.toFixed(2) + ' g' : null);
      case 'fuel': return 'burn ' + arrow(cur.fuel + ' s', nx ? nx.fuel + ' s' : null);
      default: return 'cash ' + arrow('&times;' + cur.mult.toFixed(2), nx ? '&times;' + nx.mult.toFixed(2) : null);
    }
  }
  function shopHtml() {
    var sv = S.save, up = sv.up, h = '', i, done = 0, total = 0;
    for (i = 0; i < GOALS.length; i++) { total++; if (sv.goals[GOALS[i].id]) done++; }
    h += '<div class="ltf-card ltf-shop">';
    h += '<div class="ltf-top"><span class="ltf-day">DAY ' + sv.day + (sv.ngp ? ' <i>NG+' + (sv.ngp > 1 ? sv.ngp : '') + '</i>' : '') + '</span>' +
      '<span class="ltf-cash" title="Cash">' + money(sv.cash) + '</span></div>';
    var mis = missionFor(sv), found = 0;
    for (i = 0; i < EGGS.length; i++) if (sv.eggs[EGGS[i].id]) found++;
    h += '<div class="ltf-contract" title="Today\'s sponsor contract: do it on today\'s flight for the bonus"><span>CONTRACT</span> ' + esc(mis.text) + ' <b>+' + money(mis.reward) + '</b></div>';
    function tabBtn(id, label) { return '<button type="button" role="tab" data-tab="' + id + '" aria-selected="' + (S.tab === id) + '"' + (S.tab === id ? ' class="on"' : '') + '>' + label + '</button>'; }
    h += '<div class="ltf-tabs" role="tablist">' + tabBtn('up', 'Upgrades') + tabBtn('goals', 'Goals ' + done + '/' + total) + tabBtn('eggs', 'Secrets ' + found + '/' + EGGS.length) + '</div>';
    if (S.tab === 'up') {
      h += '<div class="ltf-list">';
      for (i = 0; i < UPGRADES.length; i++) {
        var u = UPGRADES[i], lv = up[u.id] | 0, max = u.tiers.length - 1, why = canBuy(sv, u.id), pr = priceOf(sv, u.id), pips = '';
        for (var p = 1; p <= max; p++) pips += p <= lv ? '<b>#</b>' : '-';
        var lab = why === 'max' ? 'MAX' : why === 'locked' ? 'locked' : money(pr);
        var tip = why === 'max' ? 'Fully upgraded' : why === 'locked' ? 'Needs a rocket first' : why === 'cash' ? 'Need ' + money(pr - sv.cash) + ' more' : 'Buy ' + u.tiers[lv + 1].name;
        h += '<div class="ltf-row' + (why === 'max' ? ' max' : '') + '">' +
          '<span class="ltf-ic" aria-hidden="true">' + esc(ICONS[u.id]) + '</span>' +
          '<div class="ltf-info"><div class="ltf-nm"><b>' + u.name + '</b> <span>' + esc(u.tiers[lv].name) + '</span></div>' +
          '<div class="ltf-st"><span class="ltf-pips" aria-label="level ' + lv + ' of ' + max + '">[' + pips + ']</span> ' + statLine(u.id, up) + '</div></div>' +
          '<button type="button" class="ltf-buy' + (why === 'cash' ? ' poor' : '') + '" data-buy="' + u.id + '"' + (why ? ' disabled' : '') +
          ' title="' + esc(tip) + '" aria-label="' + esc(u.name + ': ' + tip + (why ? '' : ' for ' + money(pr))) + '">' + lab + '</button></div>';
      }
      h += '</div>';
    } else if (S.tab === 'eggs') {
      h += '<div class="ltf-list ltf-goals">';
      for (i = 0; i < EGGS.length; i++) {
        var eg = EGGS[i], got = !!sv.eggs[eg.id];
        h += '<div class="ltf-g' + (got ? ' ok' : '') + '"><span class="ltf-ck">' + (got ? '[*]' : '[?]') + '</span><span>' + (got ? '<b class="nm">' + esc(eg.name) + '</b>' : '<i>' + esc(eg.hint) + '</i>') + '</span><b>' + (got ? '+' : '') + money(eg.bonus) + '</b></div>';
      }
      h += '</div><div class="ltf-hats"><span>Hat</span>' +
        '<button type="button" class="ltf-hat' + (!sv.hat ? ' on' : '') + '" data-hat="">none</button>';
      for (i = 0; i < HATS.length; i++) {
        var ht = HATS[i], own = hatOwned(sv, ht.id);
        h += '<button type="button" class="ltf-hat' + (sv.hat === ht.id ? ' on' : '') + '" data-hat="' + ht.id + '"' + (own ? '' : ' disabled') +
          ' title="' + esc(own ? ht.name : 'Locked — ' + ht.how) + '"><b>' + String.fromCharCode(ht.ch) + '</b> ' + (own ? esc(ht.name) : '???') + '</button>';
      }
      h += '</div>';
    } else {
      h += '<div class="ltf-list ltf-goals">';
      var fin = GOALS[GOALS.length - 1];
      h += '<div class="ltf-g fin' + (sv.goals[fin.id] ? ' ok' : '') + '"><span class="ltf-ck">' + (sv.goals[fin.id] ? '[*]' : '[ ]') + '</span><span>' + goalName(fin) + '</span><b>WIN</b></div>';
      for (i = 0; i < GOALS.length - 1; i++) {
        var gl = GOALS[i], ok = !!sv.goals[gl.id];
        h += '<div class="ltf-g' + (ok ? ' ok' : '') + '"><span class="ltf-ck">' + (ok ? '[x]' : '[ ]') + '</span><span>' + goalName(gl) + '</span><b>+' + money(gl.bonus) + '</b></div>';
      }
      h += '</div>';
    }
    var b = sv.best;
    h += '<div class="ltf-foot"><span class="ltf-best">best ' + fmtDist(b.dist) + (sv.bestWinDay ? ' · won day ' + sv.bestWinDay : '') + '</span>';
    if (S.resetArm) h += '<span class="ltf-confirm">Erase all progress? <button type="button" class="ltf-lnk" data-act="reset-no">No</button> <button type="button" class="ltf-lnk danger" data-act="reset-yes">Erase</button></span>';
    else h += (sv.won ? '<button type="button" class="ltf-lnk" data-act="ngp">New Game+</button>' : '') + '<button type="button" class="ltf-lnk" data-act="reset">Reset…</button>';
    h += '</div></div>';
    return h;
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>touch the sky</b> &nbsp;the nose turns towards your finger</div><div><b>&#9650; Up / &#9660; Down</b> &nbsp;pitch</div><div><b>Boost</b> &nbsp;rocket &mdash; or a flap when there&rsquo;s no fuel</div>' :
      '<div><b>&uarr; / &darr;</b> (W/S) &nbsp;nose up / down &mdash; tap to nudge, hold to turn</div><div><b>hold the mouse</b> &nbsp;the nose turns towards the pointer</div>' +
      '<div><b>Space</b> &nbsp;rocket boost &mdash; or a flap when there&rsquo;s no fuel</div><div><b>gamepad</b> &nbsp;stick points, A boosts</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="ltf-card ltf-help">' +
      '<pre class="ltf-art" aria-hidden="true">    /-----\\\n [#](__(")>\n    (_____/</pre>' +
      '<div class="ltf-title">LEARN TO FLY</div>' +
      '<p>Teach a penguin to fly! Slide down the ramp, glide as far as you can, earn cash, buy better gear.</p>' +
      '<div class="ltf-keys">' + keys + '</div>' +
      '<p class="ltf-tip">Dive to pick up speed, pull up to trade it for height &mdash; pull too hard and you <b>stall</b>. A rocket tips your nose down: <b>pull up while you boost</b>. Touch down flat to keep sliding.</p>' +
      '<p class="ltf-tip">Fly through <b>rings</b> for speed, grab <b>fish</b> for fuel, ride <b>thermals</b> (^^^) up and dodge <b>storm clouds</b>. Loops and skips off the snow pay as stunts; each day has a sponsor <b>contract</b>.</p>' +
      '<p class="ltf-tip">Goal: smash through the <b>ice wall at 10 km</b>. And there are secrets&hellip;</p>' +
      (first ? '' : '<button type="button" class="ltf-go" data-act="close-help">Back</button>') + '</div>';
  }
  function resultsHtml() {
    var cd = S.card, r = S.res, rows = [], i;
    var vals = { dist: fmtDist(r.dist), alt: fmtDist(r.maxAlt), speed: Math.round(r.maxSpeed) + ' m/s', time: r.time.toFixed(1) + ' s', coins: 'x' + (r.coins + (r.rings || 0)),
      stunts: (r.loops ? r.loops + 'L' : '') + (r.loops && r.skips ? ' ' : '') + (r.skips ? r.skips + 'S' : '') };
    function line(a, c2) {
      var pad = 30 - a.length - c2.length;
      return esc(a) + new Array(Math.max(1, pad) + 1).join(' ') + '<b>' + esc(c2) + '</b>';
    }
    function line2(a, val, amt) {
      var w = 30, s1 = a, s2 = val, s3 = amt, gap1 = 15 - s1.length, gap2 = w - 15 - s2.length - s3.length;
      return esc(s1) + new Array(Math.max(1, gap1) + 1).join(' ') + esc(s2) + new Array(Math.max(1, gap2) + 1).join(' ') + '<b>' + esc(s3) + '</b>';
    }
    for (i = 0; i < cd.lines.length; i++) rows.push(line2(cd.lines[i].label, vals[cd.lines[i].key], money(cd.lines[i].amt)));
    if (cd.bonus) rows.push(line((S.save.ngp ? 'Bonus x' : 'Scarf x') + cd.mult.toFixed(2), '+' + money(cd.bonus)));
    rows.push('<span class="' + (cd.missionOk ? 'g' : 'x') + '">' + line((cd.missionOk ? '[x] ' : '[ ] ') + cd.mission.text.slice(0, 20), cd.missionOk ? '+' + money(cd.mission.reward) : '-') + '</span>');
    for (i = 0; i < cd.eggs.length; i++) rows.push('<span class="g">' + line('* ' + cd.eggs[i].name.slice(0, 20), '+' + money(cd.eggs[i].bonus)) + '</span>');
    if (cd.goals.length) {
      rows.push('<i>' + new Array(31).join('-') + '</i>');
      var gl = cd.goals.filter(function (g) { return !g.final; }), shown = gl.length > 4 ? 3 : gl.length, rest = 0;
      for (i = 0; i < shown; i++) rows.push('<span class="g">' + line(goalName(gl[i]).slice(0, 22), '+' + money(gl[i].bonus)) + '</span>');
      for (; i < gl.length; i++) rest += gl[i].bonus;
      if (shown < gl.length) rows.push('<span class="g">' + line('+ ' + (gl.length - shown) + ' more goals', '+' + money(rest)) + '</span>');
    }
    rows.push('<i>' + new Array(31).join('=') + '</i>');
    rows.push(line('TOTAL', money(cd.total)));
    var land = r.wall ? 'Through the ice wall!' : r.landing === 'crash' ? 'Faceplant!' : r.landing === 'rough' ? 'Bumpy landing' : 'Smooth landing';
    var rec = [];
    if (cd.records.dist) rec.push('distance');
    if (cd.records.alt) rec.push('altitude');
    if (cd.records.speed) rec.push('speed');
    var near = null;
    for (i = 0; i < GOALS.length; i++) if (GOALS[i].kind === 'dist' && !S.save.goals[GOALS[i].id]) { near = GOALS[i]; break; }
    return '<div class="ltf-card ltf-res">' +
      '<div class="ltf-title">DAY ' + cd.day + '</div>' +
      '<div class="ltf-sub">' + land + '</div>' +
      '<pre class="ltf-tab">' + rows.join('\n') + '</pre>' +
      (rec.length ? '<div class="ltf-new">** new best ' + rec.join(', ') + ' **</div>' : '') +
      (cd.eggs.length ? '<div class="ltf-new">secret found!' + (cd.eggs.some(function (e) { return e.hat; }) ? ' a new hat is in the Secrets tab' : '') + '</div>' : '') +
      '<div class="ltf-note">Cash ' + money(S.save.cash) + (near ? ' · next: ' + goalName(near).toLowerCase() : '') + '</div></div>';
  }
  function victoryHtml() {
    var sv = S.save;
    return '<div class="ltf-card ltf-win">' +
      '<pre class="ltf-art" aria-hidden="true">#[]  *      _/~~~~~~~\\_\n[##]#  ~*<##](__(")>\n#[]#[  .  *  <======>  !</pre>' +
      '<div class="ltf-title">YOU LEARNED TO FLY!</div>' +
      '<p>The ice wall is down &mdash; on day <b>' + sv.wonDay + '</b>' + (sv.bestWinDay && sv.bestWinDay < sv.wonDay ? ' (record: day ' + sv.bestWinDay + ')' : '') + '.</p>' +
      '<p class="ltf-tip">Keep flying for records, or start a <b>New Game+</b>: fresh gear, every flight pays <b>+25%</b> more.</p>' +
      '<div class="ltf-btns"><button type="button" class="ltf-go alt" data-act="ngp">New Game+</button></div></div>';
  }
  function pauseHtml() {
    return '<div class="ltf-card ltf-pause"><div class="ltf-title">PAUSED</div>' +
      '<div class="ltf-sub">' + fmtDist(Math.max(0, S.f.maxX)) + ' so far</div>' +
      '<div class="ltf-note">' + (S.coarse ? 'Tap to resume' : 'Space / P / click to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'shop' ? shopHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'results' ? resultsHtml() :
      kind === 'victory' ? victoryHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'shop');
    S.stage.classList.toggle('shop', kind === 'shop');
  }
  function setPad(mode) {
    var h;
    S.padMode = mode;
    if (mode === 'fly') {
      var boost = S.f && S.f.g.fuel > 0;
      h = '<button type="button" class="ltf-pk" data-k="up" aria-label="Nose up">&#9650; <span>Up</span></button>' +
        (boost ? '<button type="button" class="ltf-pk boost" data-k="boost" aria-label="Rocket boost (a flap when the fuel is gone)"><span>Boost</span><i class="ltf-fuel"><i></i></i></button>' :
          '<button type="button" class="ltf-pk boost" data-k="boost" aria-label="Flap"><span>Flap</span></button>') +
        '<button type="button" class="ltf-pk" data-k="down" aria-label="Nose down"><span>Down</span> &#9660;</button>';
    } else {
      var lab = mode === 'launch' ? 'Launch!' : mode === 'continue' ? 'Continue' : mode === 'resume' ? 'Resume' : mode === 'start' ? 'Let\u2019s fly!' : 'Back to the hangar';
      h = '<button type="button" class="ltf-act" data-act="' + mode + '">' + lab + (S.coarse ? '' : ' <small>space</small>') + '</button>';
    }
    S.pad.innerHTML = h;
    S.fuelEl = S.pad.querySelector('.ltf-fuel i');
    S.fuelShown = -1;
    syncPad();
  }
  function syncPad() {
    if (!S || S.padMode !== 'fly') return;
    var bs = S.pad.querySelectorAll('[data-k]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', !!S.inp[bs[i].getAttribute('data-k')]);
  }
  function syncFuel() {
    if (!S.fuelEl || !S.f) return;
    var fr = S.f.g.fuel ? Math.round(S.f.fuel / S.f.g.fuel * 40) / 40 : 0;
    if (fr !== S.fuelShown) { S.fuelShown = fr; S.fuelEl.style.width = (fr * 100) + '%'; }
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    var can = S.phase === 'fly';
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = !can;
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncLabel() {
    var sv = S.save;
    S.cv.setAttribute('aria-label', 'Learn to Fly — day ' + sv.day + ', ' + money(sv.cash) + ', best ' + fmtDist(sv.best.dist) +
      '. Up / down arrows: nose up / down (or hold the pointer on the sky to steer); space: rocket boost, or a flap.');
  }

  function toHangar() {
    S.phase = 'hangar'; S.f = null; S.paused = false; S.resetArm = false;
    S.hf = newFlight(S.save.up, 1, { noWall: S.save.won });
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard('shop'); setPad('launch'); syncHead(); syncLabel();
    draw(1, 0);
  }
  function launch() {
    if (!S || S.phase !== 'hangar') return;
    S.snd.ensure();
    S.f = newFlight(S.save.up, flightSeed(S.save), { noWall: S.save.won, season: S.season });
    S.mission = missionFor(S.save);
    S.phase = 'fly'; S.paused = false; S.endT = 0; S.puffT = 0; S.stallT = -9; S.flapT = 0;
    S.live = GOALS.filter(function (g) { return !g.final && !S.save.goals[g.id]; });
    clearInput(); clearFx(); S.msg = null; S.msgQ.length = 0;
    showCard(null); setPad('fly'); syncHead();
    kick();
  }
  function endFlight() {
    stopLoop();
    S.res = summary(S.f);
    S.card = settle(S.save, S.res);
    persist();
    S.phase = 'results'; clearInput();
    showCard('results'); setPad('continue'); syncHead(); syncLabel();
    if (S.liveEl) S.liveEl.textContent = 'Day ' + S.card.day + ': ' + fmtDist(S.res.dist) + ', earned ' + money(S.card.total) + '.';
    if (S.card.goals.length) S.snd.tone(988, 0.1, 'triangle', 0.035, 0, 0.05);
    draw(1, 0);
  }
  function afterResults() {
    if (S.card && S.card.won) { S.phase = 'victory'; showCard('victory'); setPad('hangar'); syncHead(); return; }
    toHangar();
  }
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    act = act || S.padMode;
    if (act === 'launch') launch();
    else if (act === 'continue') afterResults();
    else if (act === 'resume') resume();
    else if (act === 'start' || act === 'hangar') toHangar();
  }
  function pause() {
    if (!S || S.phase !== 'fly' || S.paused) return;
    S.paused = true;
    stopLoop(); clearInput();
    showCard('pause'); setPad('resume'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null); setPad('fly'); syncHead();
    kick();
  }

  // ---- input: keys, the on-screen pad and the play field's halves ----
  var KEYMAP = { ArrowLeft: 'up', ArrowUp: 'up', KeyA: 'up', KeyW: 'up', ArrowRight: 'down', ArrowDown: 'down', KeyD: 'down', KeyS: 'down', Space: 'boost' };
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowup: 'ArrowUp', arrowright: 'ArrowRight', arrowdown: 'ArrowDown',
    a: 'KeyA', w: 'KeyW', d: 'KeyD', s: 'KeyS', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  // Everything that steers, merged: keys, the pad, the pointer (aim) and a gamepad.
  function mergeInput() {
    var i = S.inp, h = S.held, gp = S.gp;
    i.up = S.keys.up || gp.up; i.down = S.keys.down || gp.down; i.boost = S.keys.boost || gp.boost;
    for (var id in h) { if (h[id] === 'up') i.up = true; else if (h[id] === 'down') i.down = true; else if (h[id] === 'boost') i.boost = true; }
    // pointing: the nose turns towards where the pointer is, relative to the penguin on screen
    i.aim = S.aimAt && S.penX != null ? Math.atan2(-(S.aimAt.y - S.penY), S.aimAt.x - S.penX) : gp.aim;
  }
  function syncInput() { mergeInput(); syncPad(); }
  function clearInput() {
    S.keys.up = S.keys.down = S.keys.boost = false;
    S.held = {}; S.aimAt = null; S.aimId = null;
    S.inp.up = S.inp.down = S.inp.boost = false; S.inp.aim = null;
    syncPad();
  }
  // Gamepad: left stick points the nose (or d-pad up / down), A / a trigger boosts,
  // Start pauses; between flights A presses the big button.
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
    if (!p) { gp.up = gp.down = gp.boost = false; gp.aim = null; return; }
    var ax = p.axes[0] || 0, ay = p.axes[1] || 0, mag = Math.sqrt(ax * ax + ay * ay);
    gp.aim = mag > 0.55 ? Math.atan2(-ay, ax) : null;
    gp.up = btnOn(p, 12); gp.down = btnOn(p, 13);
    gp.boost = btnOn(p, 0) || btnOn(p, 7) || btnOn(p, 5);
    var st = btnOn(p, 9);
    if (st && !gp.start && S.phase === 'fly' && !S.paused) pause();
    gp.start = st;
  }
  function pollMenus() {
    if (!S || (S.phase === 'fly' && !S.paused)) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) { if (S.paused) resume(); else padAction(); }
    S.gp.menuA = a;
  }
  // Secret codes, typed in the hangar.
  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'];
  function secretKey(code, key) {
    var buf = S.codeBuf;
    buf.push(code); if (buf.length > 10) buf.shift();
    S.typed = (S.typed + (key && key.length === 1 ? key.toLowerCase() : '')).slice(-8);
    if (buf.length === 10 && buf.join() === KONAMI.join()) { S.codeBuf.length = 0; hangarEgg('konami'); return true; }
    if (/noot$/.test(S.typed)) { S.typed = ''; hangarEgg('noot'); return true; }
    return false;
  }
  function hangarEgg(id) {
    var e = findEgg(S.save, id), snd = S.snd;
    snd.ensure();
    if (id === 'noot') { snd.tone(392, 0.12, 'square', 0.05); snd.tone(392, 0.12, 'square', 0.05, 0, 0.18); }
    if (e) {
      S.save.cash += e.bonus;
      if (e.hat) S.save.hat = e.hat;
      persist();
      [523, 659, 784, 1047, 1319].forEach(function (fq, j) { snd.tone(fq, 0.1, 'triangle', 0.04, 0, j * 0.07); });
      Cade.showToast && Cade.showToast('Secret found: ' + e.name + ' — +' + money(e.bonus) + (e.hat ? ' and a hat' : ''), 'success', 3000);
    } else Cade.showToast && Cade.showToast(id === 'noot' ? 'NOOT NOOT!' : 'You already know that one ;)', 'info', 1800);
    if (S.phase === 'hangar') { showCard('shop'); draw(1, 0); }
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    var code = keyCode(e), k = KEYMAP[code];
    if (code === 'Escape') {
      e.preventDefault();
      if (S.phase === 'fly' && !S.paused) pause(); else closePanel();
      return;
    }
    if (S.phase === 'fly') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (S.paused) {
        if (code === 'Space' || code === 'Enter') { e.preventDefault(); if (!e.repeat) resume(); }
        else if (k) e.preventDefault();
        return;
      }
      if (k) { e.preventDefault(); if (!S.keys[k]) { S.keys[k] = true; syncInput(); } }
      return;
    }
    if (S.phase === 'hangar' && secretKey(code, e.key)) { e.preventDefault(); return; }
    // between flights Space / Enter does the big button's job — unless a button
    // in the panel has focus (it activates itself)
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction();
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var k = KEYMAP[keyCode(e)];
    if (k && S.keys[k]) { S.keys[k] = false; syncInput(); }
  }
  // a pointer on the play field, in the canvas' logical units
  function aimPoint(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * VW, y: (e.clientY - r.top) / r.height * S.VH };
  }

  // ---- layout ----
  // Height the play field may use: the visible viewport minus the panel's real top
  // offset and chrome (title bar, padding, pad, safe-area padding) — measured.
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 190 : 210);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    // a shared link: the panel is capped at the window, so add the chrome up instead
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 56) + 36;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');   // a shared link: the whole window
    var s = Math.min((vw - (phone ? 34 : 48)) / VW, phone ? 1.25 : solo ? 2.6 : 1.4), ah = availH(vw, vh);
    var vh2 = Math.floor(ah / s);
    if (vh2 < 288) { s = Math.max(0.55, Math.min(s, ah / 288)); vh2 = 288; }
    vh2 = Math.min(vh2, phone ? 540 : solo ? 420 : 340);
    var cw = Math.floor(VW * s), ch = Math.floor(vh2 * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--ltf-w', cw + 'px');
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
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    // hand the canvas memory back now (iOS keeps a canvas' backing store until GC)
    if (s.atl) freeCanvas(s.atl.cv);
    if (s.cloudT) s.cloudT.forEach(function (t) { freeCanvas(t.cv); });
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
    var body = '<div class="ltf"><div class="ltf-stage"><canvas class="ltf-cv"></canvas><div class="ltf-ovl" style="display:none"></div></div>' +
      '<div class="ltf-pad"></div><div class="ltf-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\uD83D\uDC27 Learn to Fly', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'ltf-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.ltf-stage'), cv: p.querySelector('.ltf-cv'), ovl: p.querySelector('.ltf-ovl'),
      pad: p.querySelector('.ltf-pad'), liveEl: p.querySelector('.ltf-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: false, coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'hangar', f: null, hf: null, paused: false, raf: 0, last: 0, endT: 0, puffT: 0,
      keys: { up: false, down: false, boost: false }, held: {}, inp: { up: false, down: false, boost: false, aim: null },
      gp: { up: false, down: false, boost: false, aim: null, start: false, menuA: false }, aimAt: null, aimId: null, penX: null, penY: null,
      codeBuf: [], typed: '', season: seasonOf(new Date()), mission: null, flapT: 0, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, cloudT: null, k: 1, VH: 288, v: {},
      tx: new Float32Array(64), ty: new Float32Array(64),
      cloudOff: 0, farOff: 0, nearOff: 0, lastLeft: null, shake: 0, flash: 0,
      msg: null, msgQ: [], live: [], tab: 'up', resetArm: false, padMode: '', cardKind: null
    };
    if (!S.rm) {
      S.flakes = new Float32Array(18 * 3);
      for (var i = 0; i < S.flakes.length; i += 3) { S.flakes[i] = Math.random() * VW; S.flakes[i + 1] = Math.random() * 480; S.flakes[i + 2] = Math.random(); }
    }
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hf = newFlight(S.save.up, 1);
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
    // Minimized to the dock: pause like a tab switch and stop drawing. Restoring
    // never resumes on its own — the pause card waits for the player.
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
    // a gamepad: poll its A / Start between flights (in flight the frame loop reads it)
    S.onPad = function () { if (S && !S.gpT) S.gpT = setInterval(pollMenus, 100); };
    window.addEventListener('gamepadconnected', S.onPad);
    if (readPad()) S.onPad();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }   // repaint on restore
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
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.phase === 'fly') pause();
        if (S.cardKind === 'help') { if (S.phase === 'hangar') showCard('shop'); }
        else if (S.phase === 'hangar') showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });
    // the play field: hold the left half to pull up, the right half to dive
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'fly' || S.paused) return;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.aimId = e.pointerId; S.aimAt = aimPoint(e); syncInput();
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || S.aimId !== e.pointerId) return;
      S.aimAt = aimPoint(e);
    });
    function release(e) {
      if (!S) return;
      if (S.aimId === e.pointerId) { S.aimId = null; S.aimAt = null; syncInput(); }
      if (S.held[e.pointerId] != null) { delete S.held[e.pointerId]; syncInput(); }
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, release); S.pad.addEventListener(t, release); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // the pad: held flight controls, or the one big action button
    S.pad.addEventListener('pointerdown', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!b) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'fly' || S.paused) return;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.held[e.pointerId] = b.getAttribute('data-k'); syncInput();
    });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) { padAction(b.getAttribute('data-act')); }
    });
    // cards: tabs, buy buttons, reset, New Game+; tap the pause card to resume
    S.ovl.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0 || S.cardKind !== 'pause') return;
      e.preventDefault();
      resume();
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var id = b.getAttribute('data-buy'), tab = b.getAttribute('data-tab'), act = b.getAttribute('data-act'), hatId = b.getAttribute('data-hat');
      if (hatId != null) {
        if (!hatId || hatOwned(S.save, hatId)) { S.save.hat = hatId; persist(); showCard('shop'); draw(1, 0); }
      } else if (id) {
        if (buy(S.save, id)) {
          persist();
          S.snd.tone(1047, 0.07, 'square', 0.03); S.snd.tone(1568, 0.12, 'square', 0.025, 0, 0.07);
          Cade.haptic && Cade.haptic(8);
          S.hf = newFlight(S.save.up, 1);
          showCard('shop'); syncLabel(); draw(1, 0);
          // keyboard users keep their place; a tap / click leaves focus free so Space launches
          var nb = e.detail === 0 && S.ovl.querySelector('[data-buy="' + id + '"]');
          if (nb && !nb.disabled) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
        }
      } else if (tab) {
        S.tab = tab; showCard('shop');
        var tb = e.detail === 0 && S.ovl.querySelector('[data-tab="' + tab + '"]');
        if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) {} }
      }
      else if (act === 'reset') { S.resetArm = true; showCard('shop'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('shop'); }
      else if (act === 'reset-yes') {
        S.save = newSave(); S.save.seed = (Math.random() * 4294967295) >>> 0;
        persist(); S.tab = 'up';
        Cade.showToast && Cade.showToast('Progress reset — back to day 1', 'info', 1800);
        toHangar();
      } else if (act === 'ngp') {
        S.save = newGamePlus(S.save); persist(); S.tab = 'up';
        Cade.showToast && Cade.showToast('New Game+ — every flight pays +' + (S.save.ngp * 25) + '%', 'success', 2200);
        toHangar();
      } else if (act === 'close-help') showCard('shop');
    });

    if (S.firstRun) {
      S.phase = 'help';
      S.save.seed = (Math.random() * 4294967295) >>> 0;
      showCard('help'); setPad('start'); syncHead(); syncLabel();
      draw(1, 0);
    } else toHangar();
    // the canvas size depends on the panel's real chrome: measure again once it's laid out,
    // and refit the glyph grid when the mono font has loaded
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Slide a penguin off a ramp and glide — rings, thermals, stunts, daily contracts, secrets — upgrade your gear, smash the 10 km ice wall',
    icon: '\uD83D\uDC27',
    tags: 'game,arcade,fun,penguin,fly,glide,glider,rocket,upgrade,shop,learn to fly,flash,distance,ascii,secrets,easter eggs',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
