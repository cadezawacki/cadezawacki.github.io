/* Uphill Rush — an ASCII dirt-bike (and buggy, and monster-truck) game for Cade.txt.
 * Ride a glyph-drawn machine over hills, kickers, gaps, logs, mud, ice, tunnels,
 * springboards and falling rocks: gas, brake and lean to keep the rider's head
 * off the dirt, and hold SPACE in the air for style poses.
 *
 * Modes: a Career across six locations (races against bot riders, judged stunt
 * shows, hill climbs, time attacks and boss duels, with entry fees, prize pots,
 * side bets, teams and a story), Time Trials on 18 themed tracks (stars by time,
 * ghost of your best run or of the crew chief's line), and Endless on seeded
 * procedural terrain that drifts through every biome. Tricks (wheelies,
 * stoppies, big air, multi flips, style poses, perfect landings) chain into
 * combos. The garage has vehicles with real stat differences, tuning parts
 * that are all trade-offs, and paint / rider cosmetics.
 *
 * Physics: a rigid chassis on two sprung wheels (prismatic spring-damper
 * joints solved with sequential impulses), wheel–terrain contacts against the
 * terrain polyline with per-surface friction and drag, motor torque on the rear
 * wheel (with its reaction on the frame), brakes, and rider lean as a torque on
 * the frame. Every vehicle is the same model with different geometry and mass.
 * It runs on a fixed 240 Hz step with an accumulator, so a run plays the same
 * at 60 or 120 Hz; rendering interpolates between steps. Rival riders are full
 * simulations driven by the same bot. Drawn entirely with monospace glyphs on a
 * canvas in the app's theme colours; no assets.
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
    var SLOP = 0.004, POS_BETA = 0.45, JBETA = 0.12, ROLL_T = 0.02, AIR_DAMP = 0.2, BODY_MU = 0.55;
    var HEAD_R = 0.16, CRASH_T = 1.35, FINISH_T = 1.4, FLIP_CONFIRM = 0.22, COMBO_T = 1.2;

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function wrapPi(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
    // Seeded PRNG (mulberry32); its state lives in a plain object so worlds clone.
    function rnd(g) {
      g.s = (g.s + 0x6D2B79F5) | 0;
      var t = Math.imul(g.s ^ (g.s >>> 15), 1 | g.s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function find(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }

    // =================== surfaces ===================
    // mu scales tyre grip; drag is a rolling resistance (see envForces).
    var MATS = [
      { key: 'dirt', name: 'Dirt', mu: 1, drag: 0 },
      { key: 'sand', name: 'Sand', mu: 0.86, drag: 0.5 },
      { key: 'mud', name: 'Mud', mu: 0.6, drag: 0.36 },
      { key: 'snow', name: 'Snow', mu: 0.68, drag: 0.2 },
      { key: 'ice', name: 'Ice', mu: 0.22, drag: 0 },
      { key: 'rock', name: 'Rock', mu: 1.1, drag: 0 },
      { key: 'tarmac', name: 'Tarmac', mu: 1.28, drag: 0 },
      { key: 'wood', name: 'Planks', mu: 1, drag: 0 }
    ];
    var NMAT = MATS.length;

    // =================== vehicles ===================
    // Geometry in chassis-local metres (origin = centre of mass, x = forward).
    // Each wheel slides on an axis (d) from its anchor (a) and is pushed out by a
    // preloaded spring-damper (rest), with hard stops (smin..smax); stat is the
    // loaded length used to place the machine at rest. body: collision circles
    // [x, y, r]. crash: the circle that ends a run when it touches the ground
    // (bikes use the rider's head instead, which moves with the lean).
    var GEOM = {
      bike: { kind: 'bike', wr: [0.38, 0.38], ax: [-0.70, 0.50], ay: [0.12, 0.50], dx: [0, 0.3746], dy: [-1, -0.9272],
        rest: [0.58, 1.02], stat: [0.47, 0.90], smin: [0.24, 0.66], smax: [0.55, 0.99],
        body: [0.05, -0.10, 0.13, -0.86, 0.36, 0.10, 0.66, 0.46, 0.10], crash: null },
      car: { kind: 'car', wr: [0.44, 0.42], ax: [-0.95, 0.98], ay: [0.10, 0.10], dx: [0, 0], dy: [-1, -1],
        rest: [0.66, 0.66], stat: [0.55, 0.55], smin: [0.30, 0.30], smax: [0.60, 0.60],
        body: [0.0, -0.12, 0.16, -1.35, 0.18, 0.12, 1.42, 0.14, 0.12, -0.55, 0.92, 0.10, 0.42, 0.92, 0.10], crash: [-0.05, 0.98, 0.16] },
      truck: { kind: 'truck', wr: [0.68, 0.68], ax: [-1.12, 1.12], ay: [0.20, 0.20], dx: [0, 0], dy: [-1, -1],
        rest: [1.02, 1.02], stat: [0.86, 0.86], smin: [0.45, 0.45], smax: [0.95, 0.95],
        body: [0.0, -0.05, 0.22, -1.62, 0.42, 0.14, 1.62, 0.42, 0.14, -0.6, 1.25, 0.12, 0.5, 1.25, 0.12], crash: [0.0, 1.32, 0.18] }
    };
    // unlock: a career boss (by location key) that must be beaten before it can be bought.
    var VEHICLES = [
      { key: 'mule', name: 'Mule 125', geom: 'bike', price: 0, mc: 1, ic: 0.30, mw: 0.12, torque: 3.7, omax: 62, k: [70, 60], c: [4.6, 4.0], mu: 1.15, lean: [6.2, 5.0], leanW: 8.5, tank: 38,
        blurb: 'The starter. Forgiving and honest; a little slow everywhere.' },
      { key: 'wasp', name: 'Wasp 250', geom: 'bike', price: 260, mc: 0.86, ic: 0.25, mw: 0.11, torque: 3.55, omax: 60, k: [60, 52], c: [4.0, 3.5], mu: 1.1, lean: [6.6, 5.6], leanW: 10.5, tank: 30,
        blurb: 'Featherweight motocrosser: flips on a whim, but every bump and gust shoves it around.' },
      { key: 'goat', name: 'Goat Trials', geom: 'bike', price: 320, mc: 0.92, ic: 0.28, mw: 0.11, torque: 4.7, omax: 46, k: [66, 56], c: [5.2, 4.6], mu: 1.5, lean: [6.8, 5.2], leanW: 8.5, tank: 32,
        blurb: 'A trials bike. Climbs walls and grips ice — and runs out of puff at 60 km/h.' },
      { key: 'rhino', name: 'Rhino 450', geom: 'bike', price: 520, unlock: 'pine', mc: 1.2, ic: 0.37, mw: 0.13, torque: 4.8, omax: 64, k: [88, 76], c: [6.0, 5.4], mu: 1.2, lean: [6.4, 4.8], leanW: 7.5, tank: 55,
        blurb: 'Heavy enduro: big torque, plush and planted, slow to rotate.' },
      { key: 'buggy', name: 'Dune Buggy', geom: 'car', price: 640, unlock: 'dust', mc: 1.6, ic: 0.9, mw: 0.2, torque: 6.6, omax: 54, k: [100, 100], c: [6.4, 6.4], mu: 1.15, lean: [10.5, 8.4], leanW: 6.5, tank: 50,
        blurb: 'Roll cage, long wheelbase, very hard to crash. Rotates like a fridge; no style poses.' },
      { key: 'viper', name: 'Viper 600', geom: 'bike', price: 900, unlock: 'neon', mc: 1.08, ic: 0.33, mw: 0.12, torque: 4.4, omax: 80, k: [92, 82], c: [5.6, 5.0], mu: 1.0, lean: [5.8, 4.4], leanW: 8, tank: 40,
        blurb: 'A street bike in the dirt. Monstrous top speed, sketchy grip, stiff as a board.' },
      { key: 'bigfoot', name: 'Bigfoot', geom: 'truck', price: 1200, unlock: 'magma', mc: 2.4, ic: 1.6, mw: 0.35, torque: 13, omax: 30, k: [105, 105], c: [8, 8], mu: 1.2, lean: [16, 13], leanW: 5.5, tank: 60,
        blurb: 'Monster truck. Rolls over logs, rocks and small cars. Steers like a cathedral.' },
      { key: 'phantom', name: 'Phantom E', geom: 'bike', price: 2000, unlock: 'summit', mc: 0.95, ic: 0.29, mw: 0.11, torque: 4.6, omax: 68, k: [74, 64], c: [4.8, 4.2], mu: 1.2, lean: [7, 5.6], leanW: 10, tank: 24,
        blurb: 'The Baron\'s electric prototype. Instant torque, silent, a tiny battery.' }
    ];

    // =================== tuning: every option is a trade-off ===================
    // fx multiplies the vehicle (travel, nitro add; hop takes the max).
    // Material arrays follow MATS: dirt sand mud snow ice rock tarmac wood.
    var PARTS = [
      { slot: 'engine', name: 'Engine', opts: [
        { key: 'stock', name: 'Stock', cost: 0, d: 'Balanced power.' },
        { key: 'torque', name: 'Torque cam', cost: 120, d: 'Pulls hard up climbs and out of sand; tops out early.', fx: { torque: 1.18, omax: 0.92 } },
        { key: 'race', name: 'Race cam', cost: 160, d: 'Screams on the straights; gutless low down.', fx: { torque: 0.88, omax: 1.13 } },
        { key: 'bigbore', name: 'Big bore', cost: 300, d: 'More of everything; drinks fuel and adds weight.', fx: { torque: 1.14, omax: 1.05, burn: 1.45, mass: 1.08 } } ] },
      { slot: 'tyres', name: 'Tyres', opts: [
        { key: 'stock', name: 'All-terrain', cost: 0, d: 'Fine everywhere, great nowhere.' },
        { key: 'knobby', name: 'Knobbies', cost: 110, d: 'Bite in dirt, mud and sand; squirm on tarmac and ice.', fx: { matMu: [1.12, 1.12, 1.3, 1.1, 0.8, 0.95, 0.82, 1], matDrag: [1, 0.8, 0.75, 0.9, 1, 1, 1, 1], omax: 0.98 } },
        { key: 'slick', name: 'Slicks', cost: 140, d: 'Glued to tarmac and rock, faster everywhere hard — useless in mud and snow.', fx: { matMu: [0.86, 0.62, 0.42, 0.5, 0.6, 1.2, 1.32, 1.15], matDrag: [1, 1.5, 1.5, 1.4, 1, 1, 1, 1], omax: 1.05 } },
        { key: 'paddle', name: 'Paddles', cost: 120, d: 'Float over sand and mud; skate on rock, tarmac and ice.', fx: { matMu: [0.96, 1.3, 1.3, 1.05, 0.6, 0.72, 0.68, 0.9], matDrag: [1, 0.35, 0.45, 0.8, 1, 1, 1, 1] } },
        { key: 'studded', name: 'Studded', cost: 160, unlock: 'frost', d: 'Ice-proof spikes; clatter on rock and tarmac and cost top speed.', fx: { matMu: [1, 0.92, 0.95, 1.35, 3.4, 0.86, 0.82, 1], matDrag: [1, 1, 1, 0.75, 1, 1, 1, 1], omax: 0.96 } } ] },
      { slot: 'susp', name: 'Suspension', opts: [
        { key: 'stock', name: 'Stock', cost: 0, d: 'A bit of everything.' },
        { key: 'plush', name: 'Long travel', cost: 140, d: 'Soaks up drops and flat landings; wallows and pops less off lips.', fx: { k: 0.8, c: 1.12, travel: 0.08 } },
        { key: 'stiff', name: 'Race valving', cost: 140, d: 'Stable and sharp at speed; casing a landing hurts — and can throw you.', fx: { k: 1.35, c: 1.25, travel: -0.06 } } ] },
      { slot: 'frame', name: 'Chassis', opts: [
        { key: 'stock', name: 'Stock', cost: 0, d: 'Standard weight.' },
        { key: 'light', name: 'Featherweight', cost: 180, d: 'Flips and accelerates faster; skittish grip, wind pushes you around.', fx: { mass: 0.86, inertia: 0.82, mu: 0.93, wind: 1.6 } },
        { key: 'ballast', name: 'Ballast plates', cost: 90, d: 'Planted, more traction, shrugs off wind; slow to rotate.', fx: { mass: 1.14, inertia: 1.2, mu: 1.06, wind: 0.55 } } ] },
      { slot: 'tank', name: 'Fuel', opts: [
        { key: 'stock', name: 'Stock tank', cost: 0, d: 'Standard range.' },
        { key: 'long', name: 'Long-range', cost: 100, d: '+50% range; the weight sits high.', fx: { tank: 1.5, mass: 1.05, inertia: 1.06 } },
        { key: 'sprint', name: 'Sprint cell', cost: 100, d: 'Lighter and nimbler; empties fast.', fx: { tank: 0.6, mass: 0.95, inertia: 0.95 } } ] },
      { slot: 'gadget', name: 'Gadget', opts: [
        { key: 'none', name: 'None', cost: 0, d: 'Nothing to go wrong.' },
        { key: 'nitro', name: 'Nitro bottle', cost: 250, d: 'Tap ⇧/E for a burst of speed (3 per run). Judges dock 10% style.', fx: { nitro: 3, mass: 1.04, style: 0.9 } },
        { key: 'hop', name: 'Hydraulic hop', cost: 220, d: 'Tap ⇧/E to pop the machine into the air. The pump weighs a lot.', fx: { hop: 1, mass: 1.07 } } ] }
    ];
    var TEAMS = [
      { key: 'comet', name: 'Red Comet Factory', col: '#e5484d', perk: 'Factory engine: +7% power', cost: 'The team keeps 25% of your prize money', fx: { torque: 1.07 }, prize: 0.75, fees: 1, parts: 1 },
      { key: 'kings', name: 'Gravity Kings', col: '#8e4ec6', perk: 'Stunt crew: +25% style points', cost: 'Heavy stunt pegs: -4% top speed', fx: { style: 1.25, omax: 0.96 }, prize: 1, fees: 1, parts: 1 },
      { key: 'devils', name: 'Dust Devils', col: '#f76b15', perk: 'Privateers: +25% prize money', cost: 'No sponsor: entry fees and parts cost 30% more', prize: 1.25, fees: 1.3, parts: 1.3 },
      { key: 'volt', name: 'Volt Syndicate', col: '#3e63dd', perk: 'Eco tune: -25% fuel use, +1 nitro if fitted', cost: 'Low-rolling eco rubber: -5% grip', fx: { burn: 0.75, nitroAdd: 1, mu: 0.95 }, prize: 1, fees: 1, parts: 1 }
    ];
    function vehOf(k) { return find(VEHICLES, k) || VEHICLES[0]; }
    function teamOf(k) { return find(TEAMS, k); }
    function slotOf(s) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i].slot === s) return PARTS[i]; return null; }
    function partOpt(s, k) { var sl = slotOf(s); return sl ? find(sl.opts, k) || sl.opts[0] : null; }

    // vehicle + parts + team (+ extra fx for bots) → everything the step needs
    function bikeParams(cfg) {
      cfg = cfg || {};
      var V = vehOf(cfg.veh), g = GEOM[V.geom], i;
      var f = { torque: 1, omax: 1, mass: 1, inertia: 1, mu: 1, k: 1, c: 1, travel: 0, tank: 1, burn: 1, wind: 1, style: 1, nitro: 0, nitroAdd: 0, hop: 0 };
      var mm = [], md = [];
      for (i = 0; i < NMAT; i++) { mm[i] = 1; md[i] = 1; }
      function add(fx) {
        if (!fx) return;
        for (var key in fx) {
          var v = fx[key];
          if (key === 'matMu' || key === 'matDrag') { var arr = key === 'matMu' ? mm : md; for (var j = 0; j < NMAT; j++) arr[j] *= v[j]; }
          else if (key === 'travel' || key === 'nitro' || key === 'nitroAdd') f[key] += v;
          else if (key === 'hop') f.hop = Math.max(f.hop, v);
          else if (key in f) f[key] *= v;
        }
      }
      for (i = 0; i < PARTS.length; i++) { var o = partOpt(PARTS[i].slot, cfg.parts && cfg.parts[PARTS[i].slot]); if (o) add(o.fx); }
      var tm = cfg.team ? teamOf(cfg.team) : null;
      if (tm) add(tm.fx);
      if (cfg.fx) add(cfg.fx);
      var mc = V.mc * f.mass, ic = V.ic * f.mass * f.inertia, mw = V.mw;
      var P = { key: V.key, name: V.name, kind: g.kind, wr: g.wr, mc: mc, ic: ic, mw: mw, iMC: 1 / mc, iIC: 1 / ic, iMW: 1 / mw,
        iIW: [0, 0], MT: [0, 0], IEFF: [0, 0],
        ax: g.ax, ay: g.ay, dx: g.dx, dy: g.dy, rest: g.rest, stat: g.stat, smax: g.smax,
        smin: [Math.max(0.08, g.smin[0] - f.travel), Math.max(0.08, g.smin[1] - f.travel)],
        body: g.body, nBody: g.body.length / 3, crash: g.crash,
        torque: V.torque * f.torque, omax: V.omax * f.omax, k: [V.k[0] * f.k, V.k[1] * f.k], c: [V.c[0] * f.c, V.c[1] * f.c],
        mu: V.mu * f.mu, matMu: [], matDrag: [], leanG: V.lean[0], leanA: V.lean[1], leanW: V.leanW,
        tank: V.tank * f.tank, burn: f.burn, wind: f.wind, style: f.style, nitro: f.nitro > 0 ? f.nitro + f.nitroAdd : 0, hop: f.hop,
        travel: f.travel, kMul: f.k, poses: g.kind === 'bike' };
      for (i = 0; i < 2; i++) {
        var iw = mw * g.wr[i] * g.wr[i] * 0.75;
        P.iIW[i] = 1 / iw; P.MT[i] = 1 / (1 / mw + g.wr[i] * g.wr[i] / iw); P.IEFF[i] = 1 / (1 / iw + 1 / ic);
      }
      var bs = (mc + 2 * mw) / 1.24;
      P.brake = [3.2 * bs, 4.4 * bs];
      for (i = 0; i < NMAT; i++) { P.matMu[i] = MATS[i].mu * mm[i]; P.matDrag[i] = MATS[i].drag * md[i]; }
      // casing a landing: the stop impulse (per kg of frame) a bottom-out may take before it costs you
      P.caseLim = 3.4 * (1 + f.travel * 4) / Math.sqrt(f.k);
      P.caseCrash = f.k > 1.2 ? 1.9 : 99;
      return P;
    }
    // 0..1 bars for the garage (and the deltas a part would make).
    function vehStats(P) {
      var m = P.mc + 2 * P.mw, top = P.omax * P.wr[0];
      return {
        power: clamp((P.torque / P.wr[0] / m - 4) / 6, 0, 1),
        speed: clamp((top - 14) / 18, 0, 1),
        grip: clamp((P.mu - 0.8) / 0.8, 0, 1),
        susp: clamp((P.smax[0] - P.smin[0]) / P.wr[0] * 0.9 - 0.15 + (P.kind === 'truck' ? 0.1 : 0), 0, 1),
        air: clamp((P.leanA / P.ic - 8) / 18, 0, 1),
        weight: clamp((m - 1) / 2, 0, 1),
        range: clamp(P.tank / P.burn / 70, 0, 1)
      };
    }

    // ---- rider pose (chassis-local), lean l ∈ [-1, 1] (+ = forward), style pose p ∈ [0, 1] ----
    // joints: 0 head, 1 shoulder, 2 hip, 3 hand, 4 knee, 5 foot
    var RAG_N = 6;
    var POSE_N = [0.20, 1.32, 0.08, 1.06, -0.22, 0.62, 0.40, 0.84, 0.18, 0.42, -0.04, 0.06];
    var POSE_B = [-0.30, 1.22, -0.30, 0.95, -0.42, 0.56, 0.40, 0.84, 0.10, 0.40, -0.04, 0.06];
    var POSE_F = [0.52, 1.18, 0.34, 0.98, -0.02, 0.70, 0.40, 0.84, 0.24, 0.46, -0.04, 0.06];
    // style poses: no-hander (arms up), superman (body flung back), can-can (leg over the tank)
    var STYLE = [
      { key: 'nohand', name: 'NO-HANDER', pts: 110, pose: [0.10, 1.42, 0.02, 1.13, -0.24, 0.64, -0.20, 1.72, 0.18, 0.44, -0.04, 0.08] },
      { key: 'superman', name: 'SUPERMAN', pts: 160, pose: [0.42, 1.10, 0.22, 0.98, -0.48, 1.02, 0.40, 0.84, -0.95, 1.10, -1.38, 1.16] },
      { key: 'cancan', name: 'CAN-CAN', pts: 135, pose: [0.12, 1.36, 0.04, 1.08, -0.22, 0.64, 0.40, 0.84, 0.44, 1.02, 0.80, 0.80] }
    ];
    function riderPose(l, out, p, pk) {
      var K = l < 0 ? POSE_B : POSE_F, t = l < 0 ? -l : l, i;
      if (t > 1) t = 1;
      for (i = 0; i < 12; i++) out[i] = POSE_N[i] + (K[i] - POSE_N[i]) * t;
      if (p > 0) { var S = STYLE[pk | 0].pose; for (i = 0; i < 12; i++) out[i] += (S[i] - out[i]) * p; }
      return out;
    }
    var RAG_PAIRS = [0, 1, 1, 2, 1, 3, 2, 4, 4, 5, 0, 2, 3, 2];

    // =================== terrain ===================
    // A height-field polyline: xs strictly increasing, everything below is solid;
    // mat[i] is the surface of segment i (xs[i] → xs[i+1]).
    function newTerrain(cap) { return { n: 0, cap: cap, xs: new Float64Array(cap), ys: new Float64Array(cap), mat: new Uint8Array(cap), hint: 0 }; }
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
    function matAt(T, x) { return T.mat[segAt(T, x)]; }
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
    // Tunnel ceilings follow the ground (smoothed) at a fixed clearance.
    function roofAt(w, x) {
      var R = w.roofs;
      for (var i = 0; i < R.length; i++) {
        var r = R[i];
        if (x >= r.x0 && x <= r.x1) return (heightAt(w.ter, x - 1) + heightAt(w.ter, x) + heightAt(w.ter, x + 1)) / 3 + r.h;
      }
      return Infinity;
    }
    function waterAt(w, x) {
      var Wt = w.waters;
      for (var i = 0; i < Wt.length; i++) if (x >= Wt[i].x0 && x <= Wt[i].x1) return Wt[i].lvl;
      return -Infinity;
    }

    // ---- contacts (preallocated pool; no allocation in the step) ----
    var MAXC = 64;
    var CK = new Int8Array(MAXC), CNX = new Float64Array(MAXC), CNY = new Float64Array(MAXC), CPEN = new Float64Array(MAXC);
    var CRX = new Float64Array(MAXC), CRY = new Float64Array(MAXC), CJN = new Float64Array(MAXC), CJT = new Float64Array(MAXC);
    var CMN = new Float64Array(MAXC), CMT = new Float64Array(MAXC), CMAT = new Uint8Array(MAXC);
    var nC = 0;
    function addC(kind, nx, ny, pen, rx, ry, mat) {
      if (nC >= MAXC) return;
      CK[nC] = kind; CNX[nC] = nx; CNY[nC] = ny; CPEN[nC] = pen; CRX[nC] = rx; CRY[nC] = ry; CMAT[nC] = mat;
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
        if (sd < r && sd > -3 * r) addC(kind, nx, ny, r - sd, ox, oy, T.mat[j]);
      }
      for (j = i0 + 1; j <= i1; j++) {
        if (j <= 0 || j >= n - 1) continue;
        var ax = xs[j] - xs[j - 1], ay = ys[j] - ys[j - 1], bx = xs[j + 1] - xs[j], by = ys[j + 1] - ys[j];
        if (ax * by - ay * bx > -1e-9) continue;                 // not a crest
        var dx = cx - xs[j], dy = cy - ys[j], d2 = dx * dx + dy * dy;
        if (d2 >= r * r || d2 < 1e-12) continue;
        if (dx * ax + dy * ay <= 0 || dx * bx + dy * by >= 0) continue;   // not in the vertex's outer wedge
        var d = Math.sqrt(d2);
        addC(kind, dx / d, dy / d, r - d, ox, oy, T.mat[j]);
      }
      // Tunnelled below the surface (shouldn't happen at 240 Hz): pop straight up.
      if (under && h - cy > r * 0.5) addC(kind, 0, 1, h - cy + r, ox, oy, T.mat[segAt(T, cx)]);
    }
    // A circle against a tunnel ceiling (pushes down).
    function collideRoof(w, cx, cy, r, kind, ox, oy) {
      var ry = roofAt(w, cx);
      if (ry === Infinity) return;
      var sl = slopeAt(w.ter, cx, 1), cs = Math.cos(sl), d = (ry - cy) * cs;
      if (d < r && d > r - 0.6) addC(kind, Math.sin(sl), -cs, r - d, ox, oy, 5);
    }

    // =================== track builder ===================
    // Tracks are written in a tiny DSL: tokens like "h30,2" (letter + comma
    // args); the grammar is listed above TRACKS.
    function bAdd(w, x, y) {
      var T = w.ter, n = T.n;
      if (n && x <= T.xs[n - 1] + 0.01) { T.ys[n - 1] = y; w.by = y; return; }
      if (n >= T.cap) return;
      T.xs[n] = x; T.ys[n] = y; T.n = n + 1;
      if (n) T.mat[n - 1] = w.mat;
      T.mat[n] = w.mat;
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
        case 'n': bDeco(w, 'sign', x0, y0, a[0] | 0); break;
        case 'm': w.mat = clamp(a[0] | 0, 0, NMAT - 1); break;
        case 'b': bCurve(w, a[0], 0, 0); w.zones.push({ k: 'boost', x0: x0, x1: w.bx, f: 15 }); break;
        case 'j': bCurve(w, 2.4, 0, 0); w.zones.push({ k: 'spring', x0: x0 + 0.4, x1: x0 + 2.0, f: a[0] || 8 }); bDeco(w, 'spring', x0 + 1.2, y0); break;
        case 't': w.roofs.push({ x0: x0, x1: x0 + a[0], h: a[1] || 3 }); bDeco(w, 'tunnel', x0, y0, x0 + a[0], a[1] || 3); break;
        case 'p': {                                                   // water-filled dip W wide, D deep
          bCurve(w, a[0], -a[1], 2); w.by = y0;
          w.waters.push({ x0: x0, x1: x0 + a[0], lvl: y0 - 0.14 });
          break;
        }
        case 'x': {                                                   // n crates on a flat
          var nx = a[0] || 1;
          bCurve(w, nx * 0.95 + 2.5, 0, 0);
          for (i = 0; i < nx; i++) w.crates.push({ x: x0 + 1.5 + i * 0.95, y: y0, on: 1 });
          break;
        }
        case 'q':                                                     // a boulder waiting on a ledge above the trail
          bCurve(w, 4, 0, 0);
          w.rocks.push({ x: x0 + 2, y: y0 + 12, y0: y0 + 12, vy: 0, st: 0, trig: a[0] || 22 });
          break;
        case 'a': w.zones.push({ k: 'wind', x0: x0, x1: x0 + a[0], f: a[1] }); bDeco(w, 'wind', x0, y0, a[0], a[1]); break;
        case 'z': w.zones.push({ k: 'trick', x0: x0, x1: x0 + a[0], f: 2 }); bDeco(w, 'tzone', x0, y0, x0 + a[0]); break;
        case '$': w.pendCoins.push(x0, x0 + a[0]); break;
      }
    }
    function parseSrc(src) {
      var out = [], re = /([a-z$])([-\d.,]*)/g, m;
      while ((m = re.exec(src))) out.push(m[1], m[2] ? m[2].split(',').map(Number) : []);
      return out;
    }

    // ---- themes (render side reads them; the engine needs only the keys) ----
    var LOCS = [
      { key: 'dust', name: 'Dustbowl Flats', short: 'Dustbowl' },
      { key: 'pine', name: 'Pinewood Ridge', short: 'Pinewood' },
      { key: 'frost', name: 'Frostbite Pass', short: 'Frostbite' },
      { key: 'neon', name: 'Neon Docks', short: 'Neon Docks' },
      { key: 'magma', name: 'Magma Quarry', short: 'Magma' },
      { key: 'summit', name: 'The Summit', short: 'Summit' }
    ];

    // Eighteen tracks, three per location. Times are [3-star, 2-star] seconds
    // (finishing earns the first star). Grammar:
    //   f L flat · s L,dy eased slope · l L,dy straight slope · h L,H hill (H<0 dip)
    //   k L,H kicker (concave, ends at the lip) · e L,dy convex roll-off (landings)
    //   g W,dy gap (far rim dy higher) · d dy sheer drop/ledge · w n,L,H whoops
    //   o R log · r W,H rock · u n,H,L stairs · c checkpoint · n k sign
    //   m k surface (0 dirt 1 sand 2 mud 3 snow 4 ice 5 rock 6 tarmac 7 planks)
    //   b L boost strip · j V springboard · t L,H tunnel · p W,D water pool
    //   x n crates · q falling boulder · a L,F wind · z L trick zone · $ L coins
    // Signs: 0 ! · 1 jump · 2 drop · 3 tunnel · 4 ice · 5 rockfall · 6 water
    var TRACKS = [
      { key: 'dust1', loc: 'dust', name: 'Tumbleweed Trail', par: [25.5, 31],
        src: 'f14 h26,1.5 f8 m1 h32,2.6 f10 m0 s22,3 f12 k5,0.9 f8 s26,-3 f14 m1 w3,3.2,0.35 m0 f14 c $20 h28,2.2 f8 l22,4 f12 h22,1.6 f10 k5,1 f10 s22,-4 f16 m1 h30,2 f10 w3,3,0.35 m0 f16' },
      { key: 'dust2', loc: 'dust', name: 'Mesa Hop', par: [31.5, 38.5],
        src: 'f12 h30,3 f6 h26,-2 f8 l24,6 f6 h20,2 f8 s20,-6 f12 c k6,1.6 f8 e10,-1.6 f10 m1 h34,4 f6 m0 h18,-1.5 f8 n1 f4 j7 f2 g5,-0.6 e10,-0.6 f16 $16 l22,5 f4 n2 f4 d-1.4 e10,-1 f10 c s24,-2.6 f10 m1 h36,4.5 f8 m0 k6,1.4 f6 e10,-1.4 f10 h24,-2 f16' },
      { key: 'dust3', loc: 'dust', name: 'Dune Sea', par: [30, 36.5],
        src: 'f24 m1 w5,3,0.5 m0 f12 h20,2 f8 m1 w6,2.6,0.55 m0 f10 c k7,2 f6 e14,-2 f12 m1 w8,2.8,0.6 m0 f6 b8 s16,2 f8 m1 w5,3.2,0.7 m0 f10 s16,-2 f10 c z34 k6,1.8 f4 e12,-1.8 f12 m1 w6,2.6,0.6 m0 f6 b8 h22,2.4 f8 m1 w7,3,0.7 m0 f20' },
      { key: 'pine1', loc: 'pine', name: 'Timber Trail', par: [29.5, 36.5],
        src: 'f16 o0.3 f8 o0.35 f10 m2 h20,1.5 m0 f6 r1.2,0.45 f8 o0.3 f4 o0.3 f12 m2 w4,2.8,0.45 m0 f10 c l20,4 f6 o0.4 f8 r1.4,0.55 f10 s20,-4 f10 o0.35 f5 r1,0.4 f5 o0.35 f12 c $16 h26,2.5 f8 m2 w5,2.8,0.5 m0 f8 o0.4 f3 o0.4 f10 r1.6,0.6 f6 l16,3 f6 o0.45 f8 s18,-3 f16' },
      { key: 'pine2', loc: 'pine', name: 'Mudslide', par: [25.5, 31.5],
        src: 'f16 m2 l20,3 f4 m0 o0.35 f8 m2 s20,-3 m0 f6 n6 f4 p8,0.9 f10 h18,1.8 f6 c m2 w4,3,0.4 m0 f8 o0.4 f10 p10,1.1 f8 l18,4 f6 m2 h16,1.2 f4 m0 s16,-4 f10 c x3 f6 k6,1.6 e10,-1.6 f8 m2 p9,1 m0 f8 o0.35 f4 o0.35 f12 $16 h20,2 f16' },
      { key: 'pine3', loc: 'pine', name: 'Lumber Mill', par: [21, 26],
        src: 'f14 m7 u4,0.26,2.2 f6 x4 f4 n2 f4 d-1.0 e8,-0.6 m0 f10 c n3 f6 t36,3.1 m7 f8 x3 f6 u3,0.24,2.4 f10 m0 f10 s8,-0.7 f10 c z40 k7,2 f6 e14,-2 f10 k6,1.6 g5,-1 e8,-0.6 f8 m7 u5,0.28,2 f6 n2 f6 d-1.4 e10,-1 m0 f10 c o0.4 f8 x4 f16' },
      { key: 'frost1', loc: 'frost', name: 'Powder Run', par: [24.5, 30],
        src: 'm3 f14 h26,1.8 f8 w4,3,0.45 f10 n4 f4 m4 f12 m3 l20,4 f6 c k6,1.4 f4 e12,-1.4 f8 m4 s20,-3 m3 f10 h28,2.6 f8 a40,-5 k6,1.8 g6,-1 e10,-1 f14 c m4 f10 m3 w5,2.8,0.5 f10 $16 l18,3 f6 s18,-3 f16' },
      { key: 'frost2', loc: 'frost', name: 'Black Ice', par: [23, 28.5],
        src: 'm3 f16 l20,4 f6 m4 f6 m3 l18,4 f8 c h20,1.6 f6 m4 s16,-2.6 f4 m3 f10 n4 f6 m4 l14,2 m3 l10,2 f10 c n3 f6 t28,3.1 m4 f8 m3 h12,0.6 f6 m4 f8 m3 f12 s16,-3 f8 k6,1.6 g6,-1.2 e10,-1 f10 c m4 l16,3 m3 f10 $14 s20,-4 f16' },
      { key: 'frost3', loc: 'frost', name: 'Avalanche Gulch', par: [26, 32],
        src: 'm3 f20 a50,-6 h20,2 f6 k6,1.6 g6,-1 e10,-0.8 f10 c n5 f4 q f6 l18,4 f6 q f8 n1 f6 k7,2 g8,-1.6 e12,-1 f8 c a40,7 k7,2.2 g10,-2 e14,-1.8 f10 m4 f8 m3 h24,2.4 f8 c n5 f4 q f4 q f10 n2 f6 d-2.6 e12,-2 f20' },
      { key: 'neon1', loc: 'neon', name: 'Container Yard', par: [24, 29.5],
        src: 'm6 f12 u4,0.22,2.4 f10 n2 f6 d-1.4 e8,-0.8 f8 b8 f6 u5,0.26,2.2 f6 h18,1.2 f10 c n2 f6 d-2 e10,-1 f10 u3,-0.36,2.2 f10 x4 f6 u6,0.28,2 f8 s18,-2.2 f8 b10 f10 c u3,0.3,2.4 f6 n2 f6 d-2.4 e10,-1.2 f16 $16 u5,-0.32,2 f8 u4,0.3,2.2 f6 h16,1.4 f16' },
      { key: 'neon2', loc: 'neon', name: 'Night Shift', par: [26, 32],
        src: 'm6 f30 n1 f10 k5,1.2 g4,-1.2 e8,-0.4 f20 n3 f8 t42,3.2 f10 b8 f28 n1 f8 k6,1.5 g5,-1.1 e8,-0.6 f20 c s16,2 f8 n1 f8 k6,1.4 g6,-1.4 e10,-0.8 f18 b8 h20,1.6 f12 k5,1.2 g5,-1 e8,-0.6 f16 c n3 f4 t30,3.2 f34 n1 f10 k6,1.5 g4,0 f10 k6,1.6 g7,-1.6 e10,-0.6 f20' },
      { key: 'neon3', loc: 'neon', name: 'Harbour Leap', par: [19, 23.5],
        src: 'm6 f26 b10 f6 n1 f4 k6,1.6 g7,-1.2 e10,-0.8 f12 c n1 f4 j8 g6,0 f12 h20,2 f10 z50 n1 f6 k7,2 g9,-1.8 e12,-1 f8 j8 g7,0 f16 c b10 n1 f6 k8,2.4 g10,-2 e14,-1.6 f14 x3 f8 $12 j8 g8,0.4 f20' },
      { key: 'magma1', loc: 'magma', name: 'Quarry', par: [34, 41.5],
        src: 'm5 f20 r1.4,0.5 f6 l18,6 f4 r1.2,0.5 f6 n2 f4 d-2.2 e10,-1.4 f8 r1.6,0.6 f4 r1,0.4 f10 c n5 f4 q f6 l16,6.5 f6 h14,-1.5 f6 l14,4 f4 n2 f4 d-3 e12,-2 f10 r1.4,0.6 f6 m0 o0.4 m5 f8 c l20,7 f6 r1.2,0.5 f8 s20,-6 f4 n5 f4 q f4 q f10 r1.6,0.6 f10 l14,5 f4 r1.2,0.55 f4 n2 f4 d-3.2 e12,-2 f16' },
      { key: 'magma2', loc: 'magma', name: 'Sawtooth', par: [28, 34.5],
        src: 'm5 f22 l9,3 d-3 f8 l9,3.2 d-3.2 f6 l8,3 d-3 f10 h16,2 f10 c l10,3.6 d-1.8 l8,2 d-2.4 f6 l9,3 f2 d-3.2 f12 n5 f4 q f6 s16,3 f6 c l8,2.8 d-2.6 f5 l8,2.8 d-2.8 f5 l10,3.4 d-3.4 f12 s16,-3 f10 c z30 l7,2.6 d-2.6 f4 l7,2.6 d-2.6 f4 l7,2.8 d-2.8 f4 l9,3.4 d-3.4 f20' },
      { key: 'magma3', loc: 'magma', name: 'Cliffhanger', par: [32.5, 40],
        src: 'm5 f24 l26,8 f6 n2 f6 d-3.4 e14,-3 f10 l22,7 f4 n1 f6 k5,1.4 g6,1 f8 c l18,5 f6 n2 f4 d-4 e16,-3.4 f10 n5 f4 q f6 l24,8 f6 n2 f6 d-3.6 e14,-4 f12 c l16,4 f4 k5,1.2 g5,0.6 f6 n2 f6 d-3 e14,-3.6 f12 c l28,10 f4 n2 f6 d-4.5 e18,-4 f10 l14,4 f4 n1 f4 k6,1.6 g7,0.4 f6 n2 f6 d-3.4 e14,-3 f20' },
      { key: 'summit1', loc: 'summit', name: 'Canyon Run', par: [29, 35.5],
        src: 'f34 n1 f6 k6,1.6 g5,-1.2 e6,-0.4 f8 k5,1.4 g5,-1.2 e6,-0.4 f8 k5,1.4 g6,-1 e8,-0.6 f16 c h20,2 f10 a60,-5 n1 f10 k6,1.8 g6,0 f10 k5,1.2 g5,-1.6 e8,-0.6 f12 c n1 f16 k7,2.2 g8,-2.4 e10,-1 f6 k5,1.2 g5,-1.2 e8,-0.6 f16 c n1 f12 k6,1.6 g6,-0.6 e6,-0.4 f4 k6,1.6 g7,-1.2 e8,-0.8 f6 k5,1.2 g5,-1 e8,-0.6 f20' },
      { key: 'summit2', loc: 'summit', name: 'Big Air', par: [28.5, 35.5],
        src: 'f40 n1 f6 z36 k8,2.6 g9,-2.6 e14,-2 f20 h22,2 f10 c n1 f20 k8,3 f1 e18,-3.6 f16 l18,4 f10 n1 f10 z40 k9,3 g12,-3.6 e16,-2.4 f24 c h24,2 f10 n1 f16 b8 k8,2.8 g10,-1 e14,-3 f12 k7,2.4 f1 e16,-2.4 f20' },
      { key: 'summit3', loc: 'summit', name: 'The Summit', par: [56.5, 69.5],
        src: 'f20 l24,6 f6 r1.4,0.6 f6 o0.4 f6 m2 l18,5 m0 f8 m1 w5,2.8,0.6 m0 f8 n1 f6 k6,1.6 g6,0 f8 c l20,6 f4 m7 u4,0.34,2 m0 f8 n2 f6 d-2.6 e12,-1.8 f8 m5 l22,7 f6 c n1 f10 k7,2.2 g8,-1 e12,-1.6 f8 l16,5 f4 r1.4,0.6 f6 n5 f4 q f6 l20,7 f8 c m3 a28,-5 w6,2.6,0.6 f8 n1 f8 k6,1.6 g7,0.4 f8 m4 l14,4 m3 f6 n2 f6 d-3 e12,-2.6 f8 u4,0.34,2 f12 c l18,6 f6 n1 f8 z30 k8,2.6 g10,-2 e14,-2 f8 w5,2.8,0.6 f8 l26,9 f20' }
    ];
    function trackOf(k) { return find(TRACKS, k); }
    function trackIdx(k) { for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].key === k) return i; return -1; }

    function buildBase(w) {
      w.ter = newTerrain(w.mode === 'endless' ? 6000 : 12000);
      w.bx = -40; w.by = 0;
      bAdd(w, -40, 12); bAdd(w, -39.86, 0); bCurve(w, 49.86, 0, 0);  // back wall, start straight to x = 10
      bDeco(w, 'start', 3.2, 0);
    }
    function buildStage(w, src) {
      var ops = parseSrc(src), i;
      buildBase(w);
      for (i = 0; i < ops.length; i += 2) feature(w, ops[i], ops[i + 1]);
      w.mat = 0;
      bCurve(w, 6, 0, 0);
      w.finishX = w.bx;
      bDeco(w, 'finish', w.bx, w.by);
      bCurve(w, 70, 0, 0);
      bAdd(w, w.bx + 0.14, w.by + 12);
      w.endX = w.bx;
      for (i = 0; i < w.pendCoins.length; i += 2) coinRow(w, w.pendCoins[i] + 1, w.pendCoins[i + 1], 1.0);
      w.pendCoins.length = 0;
      w.zones.sort(function (p, q) { return p.x0 - q.x0; });
      w.items.sort(function (p, q) { return p.x - q.x; });
    }

    // =================== world ===================
    function wheelObj() { return { x: 0, y: 0, vx: 0, vy: 0, th: 0, om: 0, px: 0, py: 0, pth: 0, touch: false, s: 0, mat: 0 }; }
    // opt: track (key or index), src (custom DSL, tests), endless + seed (+ biome
    // to stay in one location), goal (endless: finish at this distance),
    // cfg {veh, parts, team, fx}, ai {skill} for a bot rider.
    function newWorld(opt) {
      opt = opt || {};
      var P = bikeParams(opt.cfg);
      var w = {
        mode: opt.endless ? 'endless' : 'stage', track: '', seed: (opt.seed >>> 0) || 1,
        biome: opt.biome != null ? opt.biome | 0 : -1, goal: +opt.goal || 0,
        P: P, ter: null, bx: 0, by: 0, mat: 0,
        decos: [], gaps: [], cps: [], items: [], zones: [], roofs: [], waters: [], rocks: [], crates: [], pendCoins: [],
        finishX: 1e9, startX: 0, endX: 0,
        c: { x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0, px: 0, py: 0, pa: 0 },
        wh: [wheelObj(), wheelObj()],
        inGas: 0, inBrake: 0, inLean: 0, inTrick: 0, inGadget: 0, gadPrev: false,
        lean: 0, plean: 0, pose: 0, ppose: 0, poseK: 0, poseHold: 0,
        state: 'ready', stateT: 0, t: 0, bonus: 0, final: 0, steps: 0, acc: 0,
        flips: 0, perfects: 0, crashes: 0, bottoms: 0, why: '', bodyT: false,
        air: false, airT: 0, airRot: 0, airH: 0, maxAir: 0, totalAir: 0, landRel: 0, pendBoth: false, pendAir: 0, pendH: 0,
        pendN: 0, pendRot: 0, pendT: -1, pendPerfect: false, lastFlipN: 0, lastFlipDir: 0, upsideT: 0,
        wheelieT: 0, stoppieT: 0, wheelieTot: 0, bestWheelie: 0,
        score: 0, combo: 0, comboN: 0, comboT: 0, bestCombo: 0, lastCombo: null, lostCombo: 0, tricks: [], repeat: {}, zoneTrick: false,
        caseJ: 0, caseCd: 0, springCd: 0, boostT: 0, nitro: P.nitro, nitroT: 0, hopCd: 0, splashT: 0, smashed: 0,
        cpi: 0, cpX: 0,
        rag: new Float64Array(RAG_N * 4), ragP: new Float64Array(RAG_N * 2), ragL: new Float64Array(RAG_PAIRS.length / 2),
        cam: { x: 0, y: 0, z: 1, px: 0, py: 0, pz: 1 }, camMode: 0, viewW: 14, viewH: 10,
        fuelOn: !!opt.endless, fuel: 1, coins: 0, dist: 0, stallT: 0, emptyT: 0, itemI: 0, gen: null,
        rec: null, recN: 0,
        ai: null,
        events: [], done: false
      };
      if (opt.ai) w.ai = { skill: clamp(+opt.ai.skill || 0, 0, 1.2), band: 1, prog: 0, stuckT: 0, failCp: -1, failN: 0, rng: { s: (w.seed * 7919) | 0 }, gasT: 0 };
      if (w.mode === 'endless') {
        buildBase(w);
        w.gen = { s: w.seed | 0, nextFuel: 150, last: 0, lastBiome: biomeAt(w, 0) };
        genEndless(w, 220);
      } else if (typeof opt.src === 'string') {
        buildStage(w, opt.src);                                    // custom track (tests)
      } else {
        var tr = typeof opt.track === 'number' ? TRACKS[clamp(opt.track | 0, 0, TRACKS.length - 1)] : trackOf(opt.track) || TRACKS[0];
        w.track = tr.key;
        buildStage(w, tr.src);
      }
      placeBike(w, opt.startX || 0);
      w.startX = 0;
      resetCam(w);
      return w;
    }
    function biomeAt(w, x) { return w.biome >= 0 ? w.biome : Math.floor(Math.max(0, x) / 700) % LOCS.length; }
    // Snap the camera onto its resting target (after the UI sets the view size).
    function resetCam(w) {
      var cam = w.cam;
      cam.z = cam.pz = 1;
      cam.x = cam.px = w.c.x + w.viewW * 0.12;
      cam.y = cam.py = w.c.y + w.viewH * 0.08;
    }

    var POSE = new Float64Array(12);
    // Put the machine at rest on the ground at x (start, checkpoints).
    function placeBike(w, x) {
      var T = w.ter, c = w.c, P = w.P, a = slopeAt(T, x + 0.05, 0.8), ca = Math.cos(a), sa = Math.sin(a), y = -1e9, i;
      c.a = a; c.x = x; c.vx = c.vy = c.w = 0;
      for (i = 0; i < 2; i++) {
        var lx = P.ax[i] + P.dx[i] * P.stat[i], ly = P.ay[i] + P.dy[i] * P.stat[i];
        var ox = ca * lx - sa * ly, oy = sa * lx + ca * ly;
        y = Math.max(y, heightAt(T, x + ox) + P.wr[i] / Math.max(0.5, Math.cos(slopeAt(T, x + ox, 0.3))) - oy);
      }
      c.y = y + 0.005;
      for (i = 0; i < 2; i++) {
        var wh = w.wh[i], lx2 = P.ax[i] + P.dx[i] * P.stat[i], ly2 = P.ay[i] + P.dy[i] * P.stat[i];
        wh.x = c.x + ca * lx2 - sa * ly2; wh.y = c.y + sa * lx2 + ca * ly2;
        wh.vx = wh.vy = wh.om = 0; wh.s = P.stat[i]; wh.touch = true;
      }
      w.lean = w.plean = 0; w.pose = w.ppose = 0; w.poseHold = 0;
      w.air = false; w.airT = 0; w.airRot = 0; w.airH = 0; w.pendT = -1; w.pendN = 0; w.upsideT = 0; w.wheelieT = 0; w.stoppieT = 0;
      w.nitroT = 0;
      savePrev(w);
    }
    function savePrev(w) {
      var c = w.c, a = w.wh[0], b = w.wh[1], cam = w.cam;
      c.px = c.x; c.py = c.y; c.pa = c.a;
      a.px = a.x; a.py = a.y; a.pth = a.th;
      b.px = b.x; b.py = b.y; b.pth = b.th;
      cam.px = cam.x; cam.py = cam.y; cam.pz = cam.z;
      w.plean = w.lean; w.ppose = w.pose;
      for (var i = 0; i < RAG_N; i++) { w.ragP[i * 2] = w.rag[i * 4]; w.ragP[i * 2 + 1] = w.rag[i * 4 + 1]; }
    }

    // Local point on the chassis → world (into _wx/_wy).
    var _wx = 0, _wy = 0;
    function toWorld(c, lx, ly) {
      var ca = Math.cos(c.a), sa = Math.sin(c.a);
      _wx = c.x + ca * lx - sa * ly; _wy = c.y + sa * lx + ca * ly;
    }
    // The point that ends a run on contact: the rider's head, or a cage roof.
    function headPoint(w) {
      var P = w.P;
      if (P.crash) { toWorld(w.c, P.crash[0], P.crash[1]); return P.crash[2]; }
      riderPose(w.lean, POSE, w.pose, w.poseK);
      toWorld(w.c, POSE[0], POSE[1]);
      return HEAD_R;
    }

    // =================== the step ===================
    var JD = new Float64Array(16);    // per wheel: dx dy rx ry s perr jlo jhi
    var BLIM = new Float64Array(2), BACC = new Float64Array(2);
    function step(w) {
      var dt = STEP, P = w.P, c = w.c, rw = w.wh[0], fw = w.wh[1], T = w.ter, i, k, it;
      var iMC = P.iMC, iIC = P.iIC, iMW = P.iMW;
      savePrev(w);
      w.steps++;
      w.stateT += dt;
      if (w.ai) bot(w);
      var st = w.state, gas = 0, brake = 0, lean = 0;
      if (st === 'ready' && (w.inGas || w.inBrake)) { st = w.state = 'ride'; w.stateT = 0; w.events.push('start'); }
      if (st === 'ride') {
        gas = w.inGas ? 1 : 0; brake = w.inBrake ? 1 : 0; lean = clamp(w.inLean, -1, 1);
        if (w.fuelOn && w.fuel <= 0) gas = 0;
        gadget(w, dt);
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
        var ax = c.x + ca * P.ax[i] - sa * P.ay[i], ay = c.y + sa * P.ax[i] + ca * P.ay[i];
        var dx = ca * P.dx[i] - sa * P.dy[i], dy = sa * P.dx[i] + ca * P.dy[i];
        var rx = wh.x - c.x, ry = wh.y - c.y;
        var s = (wh.x - ax) * dx + (wh.y - ay) * dy, perr = (wh.x - ax) * -dy + (wh.y - ay) * dx;
        var vcx = c.vx - c.w * ry, vcy = c.vy + c.w * rx;
        var sd = (wh.vx - vcx) * dx + (wh.vy - vcy) * dy;
        var F = (P.k[i] * (P.rest[i] - s) - P.c[i] * sd) * dt;
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
        rw.om -= tq * P.iIW[0]; c.w += tq * iIC;
      } else if (rev) {
        var f2 = rw.om - c.w;
        var tq2 = P.torque * 0.45 * clamp(1 - f2 / 14, 0, 1) * dt;
        rw.om += tq2 * P.iIW[0]; c.w -= tq2 * iIC;
      }
      // brakes + rolling drag: a clamped wheel↔frame spin constraint, solved with the rest
      for (i = 0; i < 2; i++) { BLIM[i] = ((brake && !rev ? P.brake[i] : 0) + ROLL_T) * dt; BACC[i] = 0; }
      // ---- rider lean: a torque on the frame (fades as the spin builds; weak with no hands) ----
      if (lean) {
        var wl = -lean * c.w;
        c.w -= lean * (rw.touch || fw.touch ? P.leanG : P.leanA) * (1 - 0.7 * w.pose) * clamp(1 - wl / P.leanW, 0, 1) * dt * iIC;
      }
      if (w.air) c.w -= c.w * AIR_DAMP * dt;
      envForces(w, dt, ca, sa);

      // ---- contacts ----
      nC = 0;
      collide(T, rw.x, rw.y, P.wr[0], 0, 0, 0);
      collide(T, fw.x, fw.y, P.wr[1], 1, 0, 0);
      var hasRoof = w.roofs.length > 0;
      if (hasRoof) { collideRoof(w, rw.x, rw.y, P.wr[0], 0, 0, 0); collideRoof(w, fw.x, fw.y, P.wr[1], 1, 0, 0); }
      for (k = 0; k < P.nBody; k++) {
        var bx = c.x + ca * P.body[k * 3] - sa * P.body[k * 3 + 1], by = c.y + sa * P.body[k * 3] + ca * P.body[k * 3 + 1];
        collide(T, bx, by, P.body[k * 3 + 2], 2 + k, bx - c.x, by - c.y);
        if (hasRoof) collideRoof(w, bx, by, P.body[k * 3 + 2], 2 + k, bx - c.x, by - c.y);
      }
      rw.touch = fw.touch = false; w.bodyT = false;
      for (k = 0; k < nC; k++) {
        if (CK[k] === 0) { rw.touch = true; rw.mat = CMAT[k]; } else if (CK[k] === 1) { fw.touch = true; fw.mat = CMAT[k]; } else w.bodyT = true;
        if (CK[k] >= 2) {
          var rn = CRX[k] * CNY[k] - CRY[k] * CNX[k], rt = CRX[k] * -CNX[k] - CRY[k] * CNY[k];
          CMN[k] = 1 / (iMC + rn * rn * iIC); CMT[k] = 1 / (iMC + rt * rt * iIC);
        }
      }

      // ---- sequential impulses: joints, then contacts ----
      for (it = 0; it < ITER; it++) {
        for (i = 0; i < 2; i++) {
          solveJoint(w, i, P);
          var wb = w.wh[i], jb = -(wb.om - c.w) * P.IEFF[i], ob = BACC[i];
          BACC[i] = clamp(ob + jb, -BLIM[i], BLIM[i]); jb = BACC[i] - ob;
          wb.om += jb * P.iIW[i]; c.w -= jb * iIC;
        }
        for (k = 0; k < nC; k++) solveContact(w, k, P);
      }
      // the hardest suspension bottom-out this step (per kg of frame): casing a landing
      w.caseJ = Math.max(JD[6], JD[14]) * iMC;

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
      // ghost recording: the frame every GHOST_DT of run time
      if (w.rec && (w.state === 'ride' || w.state === 'crash') && w.t >= w.recN * GHOST_DT && w.recN * GCH + GCH <= w.rec.length) {
        var ro = w.recN * GCH;
        w.rec[ro] = c.x; w.rec[ro + 1] = c.y; w.rec[ro + 2] = c.a; w.rec[ro + 3] = w.state === 'crash' ? 9 : w.lean; w.rec[ro + 4] = w.pose + w.poseK * 2;
        w.recN++;
      }
      camStep(w, dt);
    }

    function solveJoint(w, i, P) {
      var c = w.c, wh = w.wh[i], o = i * 8, dx = JD[o], dy = JD[o + 1], rx = JD[o + 2], ry = JD[o + 3], s = JD[o + 4];
      var ex = -dy, ey = dx;
      // perpendicular: the wheel stays on its slider
      var vcx = c.vx - c.w * ry, vcy = c.vy + c.w * rx;
      var vrel = (wh.vx - vcx) * ex + (wh.vy - vcy) * ey;
      var rn = rx * ey - ry * ex, K = P.iMW + P.iMC + rn * rn * P.iIC;
      var lam = -(vrel + JBETA * JD[o + 5] / STEP) / K;
      applyJ(c, wh, lam, ex, ey, rn, P);
      // travel stops
      var smin = P.smin[i], smax = P.smax[i];
      if (s < smin + 0.01 || s > smax - 0.01) {
        vcx = c.vx - c.w * ry; vcy = c.vy + c.w * rx;
        var vd = (wh.vx - vcx) * dx + (wh.vy - vcy) * dy, rd = rx * dy - ry * dx, Kd = P.iMW + P.iMC + rd * rd * P.iIC;
        if (s < smin + 0.01) {
          var bias = s < smin ? (smin - s) * 0.25 / STEP : 0;
          var l1 = -(vd - bias) / Kd, old = JD[o + 6];
          JD[o + 6] = Math.max(0, old + l1); l1 = JD[o + 6] - old;
          applyJ(c, wh, l1, dx, dy, rd, P);
        } else {
          var bias2 = s > smax ? (smax - s) * 0.25 / STEP : 0;
          var l2 = -(vd - bias2) / Kd, old2 = JD[o + 7];
          JD[o + 7] = Math.min(0, old2 + l2); l2 = JD[o + 7] - old2;
          applyJ(c, wh, l2, dx, dy, rd, P);
        }
      }
    }
    function applyJ(c, wh, lam, nx, ny, rn, P) {
      wh.vx += lam * nx * P.iMW; wh.vy += lam * ny * P.iMW;
      c.vx -= lam * nx * P.iMC; c.vy -= lam * ny * P.iMC;
      c.w -= rn * lam * P.iIC;
    }
    function solveContact(w, k, P) {
      var nx = CNX[k], ny = CNY[k], tx = ny, ty = -nx, kind = CK[k], jn, old, jt, lim;
      if (kind < 2) {
        var wh = w.wh[kind], R = P.wr[kind], mw = P.mw;
        jn = -(wh.vx * nx + wh.vy * ny) * mw;
        old = CJN[k]; CJN[k] = Math.max(0, old + jn); jn = CJN[k] - old;
        wh.vx += jn * nx * P.iMW; wh.vy += jn * ny * P.iMW;
        jt = -(wh.vx * tx + wh.vy * ty + wh.om * R) * P.MT[kind];
        lim = P.mu * P.matMu[CMAT[k]] * CJN[k]; old = CJT[k]; CJT[k] = clamp(old + jt, -lim, lim); jt = CJT[k] - old;
        wh.vx += jt * tx * P.iMW; wh.vy += jt * ty * P.iMW; wh.om += jt * R * P.iIW[kind];
      } else {
        var c = w.c, rx = CRX[k], ry = CRY[k];
        var vx = c.vx - c.w * ry, vy = c.vy + c.w * rx;
        jn = -(vx * nx + vy * ny) * CMN[k];
        old = CJN[k]; CJN[k] = Math.max(0, old + jn); jn = CJN[k] - old;
        c.vx += jn * nx * P.iMC; c.vy += jn * ny * P.iMC; c.w += (rx * ny - ry * nx) * jn * P.iIC;
        vx = c.vx - c.w * ry; vy = c.vy + c.w * rx;
        jt = -(vx * tx + vy * ty) * CMT[k];
        lim = BODY_MU * MATS[CMAT[k]].mu * CJN[k]; old = CJT[k]; CJT[k] = clamp(old + jt, -lim, lim); jt = CJT[k] - old;
        c.vx += jt * tx * P.iMC; c.vy += jt * ty * P.iMC; c.w += (rx * ty - ry * tx) * jt * P.iIC;
      }
    }

    // ---- the world pushing back: boost strips, springboards, wind, surfaces, water, nitro ----
    function inZ(z, x) { return x >= z.x0 && x <= z.x1; }
    function envForces(w, dt, ca, sa) {
      var c = w.c, P = w.P, Z = w.zones, rw = w.wh[0], fw = w.wh[1], i, v;
      w.zoneTrick = false;
      if (w.springCd > 0) w.springCd -= dt;
      if (w.boostT > 0) w.boostT -= dt;
      for (i = 0; i < Z.length; i++) {
        var z = Z[i];
        if (z.x0 > c.x + 4) break;
        if (z.x1 < c.x - 4) continue;
        if (z.k === 'boost') {
          if ((rw.touch && inZ(z, rw.x)) || (fw.touch && inZ(z, fw.x))) {
            v = c.vx * ca + c.vy * sa;
            if (v < 30) { c.vx += ca * z.f * dt; c.vy += sa * z.f * dt; }
            if (w.boostT <= 0) w.events.push('boost');
            w.boostT = 0.35;
          }
        } else if (z.k === 'spring') {
          if (w.springCd <= 0 && ((rw.touch && inZ(z, rw.x)) || (fw.touch && inZ(z, fw.x)))) {
            if (c.vy < z.f) c.vy = z.f;
            if (rw.vy < z.f) rw.vy = z.f;
            if (fw.vy < z.f) fw.vy = z.f;
            w.springCd = 0.6;
            w.events.push('spring');
          }
        } else if (z.k === 'wind') {
          if (inZ(z, c.x)) c.vx += z.f * P.wind * (w.air ? 1 : 0.3) * dt;
        } else if (z.k === 'trick') {
          if (inZ(z, c.x)) w.zoneTrick = true;
        }
      }
      // surfaces: rolling resistance from each wheel on the ground
      for (i = 0; i < 2; i++) {
        var q = w.wh[i];
        if (!q.touch) continue;
        var d = P.matDrag[q.mat];
        if (d > 0) {
          v = c.vx * ca + c.vy * sa;
          var a = d * (2.5 + 0.3 * Math.abs(v)) * dt * 0.5, av = Math.abs(v);
          if (a > av) a = av;
          if (v < 0) a = -a;
          c.vx -= ca * a; c.vy -= sa * a;
        }
      }
      // water: heavy drag below the surface, a little lift
      if (w.waters.length) {
        var lvl = waterAt(w, c.x);
        if (lvl > -Infinity) {
          for (i = 0; i < 3; i++) {
            var b = i === 0 ? c : w.wh[i - 1];
            if (b.y < lvl) {
              var dep = Math.min(1, lvl - b.y + 0.2), damp = Math.min(1, 1.6 * dep * dt);
              b.vx -= b.vx * damp; b.vy -= b.vy * damp * 0.6;
              if (i === 0) b.vy += 5 * dep * dt;
              if (w.splashT <= 0 && Math.abs(b.vx) > 2) { w.events.push('splash'); w.splashT = 0.4; }
            }
          }
        }
        if (w.splashT > 0) w.splashT -= dt;
      }
      if (w.nitroT > 0) {
        w.nitroT -= dt;
        v = c.vx * ca + c.vy * sa;
        if (v < 34) { c.vx += ca * 13 * dt; c.vy += sa * 13 * dt; }
      }
    }
    // ⇧ / E: nitro burst or hydraulic hop (edge-triggered)
    function gadget(w, dt) {
      var P = w.P, press = !!w.inGadget && !w.gadPrev;
      w.gadPrev = !!w.inGadget;
      if (w.hopCd > 0) w.hopCd -= dt;
      if (!press) return;
      if (P.nitro > 0) {
        if (w.nitro > 0 && w.nitroT <= 0) { w.nitro--; w.nitroT = 1.3; w.events.push('nitro'); }
      } else if (P.hop && w.hopCd <= 0 && (w.wh[0].touch || w.wh[1].touch)) {
        var c = w.c, nx = -Math.sin(c.a), ny = Math.cos(c.a), up = 5.4;
        c.vx += nx * up; c.vy += ny * up;
        for (var i = 0; i < 2; i++) { w.wh[i].vx += nx * up; w.wh[i].vy += ny * up; }
        w.hopCd = 0.8;
        w.events.push('hop');
      }
    }

    // =================== tricks & scoring ===================
    // Every trick goes into the current combo; the combo banks (× the number of
    // tricks in it, up to ×6) after COMBO_T on the ground without a new one, and
    // is lost on a crash. Repeating a trick in one run is worth less each time;
    // tricks inside a trick zone count double.
    function award(w, key, name, base) {
      var n = (w.repeat[key] = (w.repeat[key] || 0) + 1), vf = Math.max(0.3, Math.pow(0.75, n - 1));
      var zm = w.zoneTrick ? 2 : 1, pts = Math.max(5, Math.round(base * vf * zm * w.P.style / 5) * 5);
      w.combo += pts; w.comboN++; w.comboT = 0;
      if (w.tricks.length < 400) w.tricks.push({ k: key, n: name, p: pts, z: zm, r: n, t: w.t });
      w.events.push('trick');
      return pts;
    }
    function bankCombo(w) {
      if (!w.comboN) return;
      var mul = Math.min(w.comboN, 6), tot = w.combo * mul;
      w.score += tot;
      w.lastCombo = { n: w.comboN, mul: mul, pts: w.combo, tot: tot };
      if (tot > w.bestCombo) w.bestCombo = tot;
      w.events.push('combo');
      w.combo = 0; w.comboN = 0; w.comboT = 0;
    }
    function flipName(n, dir) {
      return (n === 2 ? 'DOUBLE ' : n === 3 ? 'TRIPLE ' : n === 4 ? 'QUAD ' : n > 4 ? n + 'x ' : '') + (dir > 0 ? 'BACKFLIP' : 'FRONTFLIP');
    }
    // a landing, FLIP_CONFIRM after touch-down without a crash: flips, air, perfect
    function landed(w) {
      var n = w.pendN;
      if (n > 0) {
        w.flips += n; w.lastFlipN = n; w.lastFlipDir = w.pendRot > 0 ? 1 : -1;
        if (w.mode === 'stage') w.bonus += n + (n - 1) * 0.5; else w.coins += 5 * n;
        award(w, (w.lastFlipDir > 0 ? 'bflip' : 'fflip') + n, flipName(n, w.lastFlipDir), 300 * n * (n + 1) / 2 * (w.lastFlipDir > 0 ? 1 : 1.25));
        w.events.push('flip');
      }
      if (w.pendAir >= 0.9) award(w, 'air', (w.pendH > 4.5 ? 'HUGE AIR ' : 'BIG AIR ') + w.pendAir.toFixed(1) + 's', 45 * w.pendAir * w.pendAir + 15 * w.pendH);
      if (w.pendPerfect && w.state === 'ride') {
        w.perfects++;
        if (w.mode === 'stage') w.bonus += 0.25; else w.coins += 2;
        award(w, 'perfect', 'PERFECT LANDING', 100);
        w.events.push('perfect');
      }
      w.pendT = -1; w.pendN = 0; w.pendPerfect = false;
    }
    function tricks(w, dt) {
      var c = w.c, T = w.ter, rw = w.wh[0], fw = w.wh[1];
      // style pose: chosen by the lean held when SPACE goes down (fwd superman, back can-can, none no-hander)
      var want = !!w.inTrick && w.air && w.P.poses;
      if (want && w.pose <= 0) { w.poseK = w.inLean > 0 ? 1 : w.inLean < 0 ? 2 : 0; w.poseHold = 0; }
      w.pose = clamp(w.pose + (want ? dt / 0.18 : -dt / 0.14), 0, 1);
      if (w.pose >= 0.95) w.poseHold += dt;
      if (!want && w.pose < 0.5 && w.poseHold > 0) {
        if (w.poseHold >= 0.25) { var S = STYLE[w.poseK]; award(w, S.key, S.name + ' ' + w.poseHold.toFixed(1) + 's', 40 + S.pts * w.poseHold); }
        w.poseHold = 0;
      }
      if (w.air) return;
      var rel = wrapPi(c.a - slopeAt(T, c.x, 0.8)), fv = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a), t;
      if (rw.touch && !fw.touch && !w.bodyT && rel > 0.12 && fv > 1.5) { w.wheelieT += dt; w.comboT = 0; }
      else if (w.wheelieT > 0) {
        t = w.wheelieT;
        if (t >= 0.6) { award(w, 'wheelie', 'WHEELIE ' + t.toFixed(1) + 's', 60 * t + 30 * t * t); w.wheelieTot += t; if (t > w.bestWheelie) w.bestWheelie = t; }
        w.wheelieT = 0;
      }
      if (fw.touch && !rw.touch && !w.bodyT && rel < -0.12 && fv > 1.5) { w.stoppieT += dt; w.comboT = 0; }
      else if (w.stoppieT > 0) {
        t = w.stoppieT;
        if (t >= 0.45) award(w, 'stoppie', 'STOPPIE ' + t.toFixed(1) + 's', 90 * t + 40 * t * t);
        w.stoppieT = 0;
      }
      if (w.comboN > 0 && (rw.touch || fw.touch) && w.pendT < 0 && w.wheelieT <= 0 && w.stoppieT <= 0) {
        w.comboT += dt;
        if (w.comboT > COMBO_T) bankCombo(w);
      }
    }

    // ---- after the physics: tricks, crashes, hazards, checkpoints, finish, pickups ----
    function post(w, dt) {
      var c = w.c, T = w.ter, ev = w.events, st = w.state, rw = w.wh[0], fw = w.wh[1], P = w.P, i;
      var touching = rw.touch || fw.touch || w.bodyT;
      if (st === 'ride' || st === 'ready') {
        // airtime + rotation; a landing confirms flips after a short grace (no crash)
        if (!touching) {
          w.airT += dt; w.airRot += c.w * dt;
          if (w.airT > 0.12) w.air = true;
          var hh = c.y - heightAt(T, c.x);
          if (hh > w.airH) w.airH = hh;
        } else {
          if (w.air) {
            // full turns beyond the takeoff → landing attitude change (a backflip off a
            // 40° kicker onto the flat is only 320° of spin, but it is one flip)
            var n = Math.round(Math.abs(w.airRot - wrapPi(w.airRot)) / TAU);
            var rel = Math.abs(wrapPi(c.a - slopeAt(T, c.x, 0.8)));
            w.landRel = rel;
            if (w.airT > w.maxAir) w.maxAir = w.airT;
            w.totalAir += w.airT;
            w.pendN = n; w.pendRot = w.airRot; w.pendT = 0; w.pendH = w.airH;
            w.pendPerfect = w.airT > 0.55 && rel < 0.2 && rw.touch && fw.touch;
            w.pendBoth = rw.touch && fw.touch; w.pendAir = w.airT;
          } else if (w.pendT >= 0 && w.pendT < 0.1 && !w.pendBoth && rw.touch && fw.touch) {
            // second wheel down soon after the first: still a clean two-wheel landing
            w.pendBoth = true;
            if (w.pendAir > 0.55 && w.landRel < 0.3) w.pendPerfect = true;
          }
          w.air = false; w.airT = 0; w.airRot = 0; w.airH = 0;
        }
        if (w.pendT >= 0) {
          w.pendT += dt;
          if (w.pendT >= FLIP_CONFIRM) landed(w);
        }
      }
      if (st === 'ride') {
        tricks(w, dt);
        // casing a landing: lose half the combo; on race valving a brutal one throws you
        if (w.caseCd > 0) w.caseCd -= dt;
        if (w.caseJ > P.caseLim && w.caseCd <= 0) {
          w.bottoms++; w.caseCd = 0.5; w.combo = Math.round(w.combo * 0.5);
          ev.push('cased');
          if (w.caseJ > P.caseLim * P.caseCrash) crash(w, 'cased');
        }
      }
      if (w.state === 'ride') {
        var hr = headPoint(w), hx = _wx, hy = _wy;
        if (w.waters.length && hy < waterAt(w, hx) - 0.05) crash(w, 'splash');
        else if (groundDist(T, hx, hy, hr) < hr) crash(w, 'head');
        else if (w.roofs.length && hy + hr > roofAt(w, hx)) crash(w, 'roof');
        else if (w.pose > 0.45 && (rw.touch || fw.touch)) crash(w, 'bail');
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
        if (w.state === 'ride') hazards(w, hx, hy, hr);
      }
      if (w.rocks.length) rocksStep(w, dt);
      st = w.state;
      if (st === 'ride') {
        while (w.cpi < w.cps.length && c.x >= w.cps[w.cpi]) { w.cpX = w.cps[w.cpi]; w.cpi++; ev.push('cp'); }
        pickups(w);
        if (w.mode === 'stage' && c.x >= w.finishX) {
          bankCombo(w);
          w.state = 'finish'; w.stateT = 0; w.final = Math.max(0, w.t - w.bonus); ev.push('finish');
        }
        if (w.mode === 'endless') endlessTick(w, dt);
      } else if (st === 'crash') {
        if (w.stateT >= CRASH_T) {
          if (w.mode === 'stage') {
            var rx = w.cpX;
            if (w.ai) rx = aiRespawnX(w);
            placeBike(w, rx);
            if (w.ai) { w.ai.prog = w.c.x; w.ai.stuckT = 0; }
            w.state = 'ride'; w.stateT = 0; ev.push('respawn');
          } else { w.state = 'over'; w.stateT = 0; ev.push('over'); }
        }
      } else if (st === 'finish') {
        if (!w.done && w.stateT >= FINISH_T) { w.done = true; ev.push('done'); }
      }
    }
    // A bot that keeps failing from one checkpoint is carried to the next one.
    function aiRespawnX(w) {
      var a = w.ai;
      if (a.failCp === w.cpi) a.failN++; else { a.failCp = w.cpi; a.failN = 1; }
      if (a.failN >= 3) {
        a.failN = 0;
        if (w.cpi < w.cps.length) { w.cpX = w.cps[w.cpi]; w.cpi++; }
        else return Math.max(w.cpX, w.finishX - 5);
      }
      return w.cpX;
    }
    function hazards(w, hx, hy, hr) {
      var c = w.c, P = w.P, i, rw = w.wh[0], fw = w.wh[1];
      // boulders
      for (i = 0; i < w.rocks.length; i++) {
        var r = w.rocks[i];
        if (r.st !== 1) continue;
        var dx = hx - r.x, dy = hy - r.y, rr = 0.45 + hr, dx2 = c.x - r.x, dy2 = c.y - r.y;
        if (dx * dx + dy * dy < rr * rr || dx2 * dx2 + dy2 * dy2 < 0.8 * 0.8) { crash(w, 'rock'); return; }
      }
      // crates: smash on contact (points, a little speed)
      for (i = 0; i < w.crates.length; i++) {
        var k = w.crates[i];
        if (!k.on || Math.abs(k.x - c.x) > 2.5) continue;
        var hit = false;
        for (var j = 0; j < 3 && !hit; j++) {
          var b = j === 0 ? c : w.wh[j - 1], rad = j === 0 ? 0.35 : P.wr[j - 1];
          if (Math.abs(b.x - k.x) < 0.3 + rad && b.y - rad < k.y + 0.62) hit = true;
        }
        if (hit) {
          k.on = 0; w.smashed++;
          c.vx *= 0.94; rw.vx *= 0.94; fw.vx *= 0.94;
          award(w, 'crate', 'CRATE SMASH', 40);
          w.events.push('crate');
        }
      }
    }
    function rocksStep(w, dt) {
      var c = w.c, T = w.ter;
      for (var i = 0; i < w.rocks.length; i++) {
        var r = w.rocks[i];
        if (r.st === 2) continue;
        if (r.st === 0) {
          if (w.state === 'ride' && c.x > r.x - r.trig && c.x < r.x) { r.st = 1; w.events.push('rockfall'); }
          continue;
        }
        r.vy -= G * dt; r.y += r.vy * dt;
        var gy = heightAt(T, r.x);
        if (r.y - 0.45 <= gy) { r.y = gy + 0.45; r.st = 2; w.events.push('rockland'); }
      }
    }
    function pickups(w) {
      var c = w.c, items = w.items, rw = w.wh[0], fw = w.wh[1];
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
    }

    function crash(w, why) {
      var c = w.c, i;
      w.state = 'crash'; w.stateT = 0; w.crashes++; w.why = why;
      w.pendT = -1; w.pendN = 0; w.pendPerfect = false; w.wheelieT = 0; w.stoppieT = 0; w.poseHold = 0;
      if (w.combo > 0) { w.lostCombo = w.combo * Math.min(6, w.comboN); w.events.push('bail'); }
      w.combo = 0; w.comboN = 0; w.comboT = 0;
      w.events.push('crash');
      // rider → ragdoll: joints at their posed positions, moving with the frame, plus a little pop
      riderPose(w.lean, POSE, w.pose, w.poseK);
      if (w.P.kind !== 'bike') for (i = 0; i < 12; i += 2) { POSE[i] = POSE[i] * 0.6 - 0.05; POSE[i + 1] = POSE[i + 1] * 0.55 + 0.25; }
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
          }
        }
      }
    }

    // ---- camera (part of the fixed step so it is frame-rate independent) ----
    // modes: 0 chase · 1 wide · 2 close · 3 director (pulls out for big air and speed)
    var CAM_Z = [1, 1.5, 0.78, 1], CAM_LEAD = [1, 1.5, 0.7, 1.25];
    function camStep(w, dt) {
      var c = w.c, cam = w.cam, fx = c.x, fy = c.y, vx = c.vx, vy = c.vy, m = w.camMode | 0;
      if (w.state === 'crash') { fx = (c.x + w.rag[0]) / 2; fy = (c.y + w.rag[1]) / 2; vx *= 0.3; vy = 0; }
      var sp = Math.sqrt(vx * vx + vy * vy), big = w.P.kind === 'truck' ? 1.25 : w.P.kind === 'car' ? 1.1 : 1;
      var tz = CAM_Z[m] * big * (1 + clamp((sp - 7) / 22, 0, 0.38) + (w.air && w.airT > 0.3 ? (m === 3 ? 0.25 + clamp(w.airH / 14, 0, 0.35) : 0.1) : 0) + (m === 3 ? clamp((sp - 12) / 24, 0, 0.25) : 0));
      cam.z += (tz - cam.z) * Math.min(1, dt * (m === 3 ? 1.6 : 1.2));
      var vw = w.viewW * cam.z, vh = w.viewH * cam.z, ld = CAM_LEAD[m];
      var tx = fx + clamp(vw * 0.12 * ld + vx * 0.3 * ld, -vw * 0.1, vw * 0.24 * ld), ty = fy + vh * 0.08 + clamp(vy * 0.08, -1, 0.8);
      // follow with velocity feed-forward (no steady lag at speed), then ease onto the target
      cam.x += vx * dt + (tx - cam.x) * Math.min(1, dt * 2.6);
      cam.y += vy * 0.6 * dt + (ty - cam.y) * Math.min(1, dt * 2.4);
      // never lose the rider off an edge
      var mx = vw * 0.36, my = vh * 0.32;
      if (fx - cam.x > mx) cam.x = fx - mx; else if (cam.x - fx > mx) cam.x = fx + mx;
      if (fy - cam.y > my) cam.y = fy - my; else if (cam.y - fy > my) cam.y = fy + my;
    }

    // =================== endless / hill climb ===================
    function endlessTick(w, dt) {
      var c = w.c, P = w.P;
      if (w.fuel > 0) {
        w.fuel -= dt * (0.25 + 0.75 * (w.inGas ? 1 : 0)) * P.burn / P.tank;
        if (w.fuel <= 0) { w.fuel = 0; w.events.push('nofuel'); }
      } else {
        w.emptyT += dt;
        var sp = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
        w.stallT = sp < 0.5 ? w.stallT + dt : 0;
        if (w.stallT > 1.2 || w.emptyT > 12) { bankCombo(w); w.state = 'over'; w.why = 'fuel'; w.stateT = 0; w.events.push('over'); }
      }
      if (c.x - w.startX > w.dist) w.dist = c.x - w.startX;
      if (w.goal && w.dist >= w.goal && w.state === 'ride') {
        bankCombo(w); w.state = 'finish'; w.stateT = 0; w.final = w.t; w.events.push('finish');
      }
      if (w.bx < c.x + 200) genEndless(w, c.x + 260);
      if (w.ter.n > w.ter.cap - 500 || c.x - w.ter.xs[0] > 600) compact(w);
    }
    function near(it, x, y, r) { var dx = it.x - x, dy = it.y - y; return dx * dx + dy * dy < r * r; }

    // Drop terrain, decorations, pickups and obstacles far behind the bike (endless only).
    function compact(w) {
      var T = w.ter, cut = w.c.x - 90, i = segAt(T, cut);
      if (i < 50) return;
      T.xs.copyWithin(0, i, T.n); T.ys.copyWithin(0, i, T.n); T.mat.copyWithin(0, i, T.n); T.n -= i; T.hint = 0;
      function keep(arr, f) { for (var k = 0, j = 0; j < arr.length; j++) if (f(arr[j])) arr[k++] = arr[j]; arr.length = k; }
      keep(w.decos, function (d) { return (d.k === 'gap' || d.k === 'tunnel' || d.k === 'tzone' ? d.a : d.x) > cut - 20; });
      keep(w.items, function (o) { return o.x > cut; }); w.itemI = 0;
      keep(w.gaps, function (o) { return o.x1 > cut; });
      keep(w.zones, function (o) { return o.x1 > cut; });
      keep(w.roofs, function (o) { return o.x1 > cut; });
      keep(w.waters, function (o) { return o.x1 > cut; });
      keep(w.rocks, function (o) { return o.x > cut; });
      keep(w.crates, function (o) { return o.x > cut; });
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
    // Each biome (700 m, or fixed for a hill climb) has its own surfaces and set pieces.
    var BIOME_MAT = [[1, 0, 1], [0, 2, 0], [3, 3, 4], [6, 6, 6], [5, 5, 0], [0, 5, 3]];
    function genEndless(w, upto) {
      var g = w.gen;
      while (w.bx < upto) {
        var d = Math.max(0, w.bx - 40), diff = Math.min(1, d / 2400), r = rnd(g), x0, H, L;
        var bio = biomeAt(w, w.bx), mats = BIOME_MAT[bio];
        if (bio !== g.lastBiome) { g.lastBiome = bio; w.mat = mats[0]; feature(w, 'f', [6]); bDeco(w, 'biome', w.bx - 3, w.by, bio); }
        w.mat = mats[Math.floor(rnd(g) * mats.length)];
        // a warning sign at the start of the run-up to a jump or a cliff
        var warn = (r >= 0.36 && r < 0.5) || r >= 0.9;
        if (warn) feature(w, 'n', [r >= 0.9 ? 2 : 1]);
        feature(w, 'f', [warn ? 8 + rnd(g) * 4 : 3 + rnd(g) * 6 * (1.2 - diff)]);
        x0 = w.bx;
        var drift = w.by > 22 ? -1 : w.by < -12 ? 1 : 0;
        var coins = rnd(g) < 0.55;
        if (r < 0.18) {                                  // hill / dip
          L = 14 + rnd(g) * 16; H = (0.8 + rnd(g) * 1.8) * (0.7 + diff * 0.8);
          feature(w, 'h', [L, (rnd(g) < 0.3 ? -0.7 : 1) * H]);
        } else if (r < 0.32) {                           // climb or descent
          L = 16 + rnd(g) * 16; H = (2 + rnd(g) * 4) * (0.7 + diff * 0.6);
          var dir = drift || (rnd(g) < 0.55 ? 1 : -1);
          if (w.mat === 4) w.mat = 3;                    // no long ice climbs
          feature(w, 'l', [L, dir * Math.min(H, L * (0.32 + 0.18 * diff))]);
        } else if (r < 0.5) {                            // kicker over a gap — or a springboard in sand / the docks
          if ((bio === 0 || bio === 3) && rnd(g) < 0.4) {
            var W0 = 4 + rnd(g) * 3 * (0.5 + diff);
            feature(w, 'j', [7 + diff]); feature(w, 'g', [W0, 0]); feature(w, 'f', [8]);
          } else {
            H = 1.1 + rnd(g) * (0.8 + diff);
            L = 5 + H * 1.3;
            feature(w, 'k', [L, H]);
            var W = Math.min(2.8 + diff * 4 + rnd(g) * 1.5, 3.5 + H * 2.2);
            feature(w, 'g', [W, -H * (0.6 + rnd(g) * 0.5)]);
            feature(w, 'e', [6, -0.6]);
            feature(w, 'f', [5]);
          }
        } else if (r < 0.6) {                            // tabletop
          H = 1.4 + rnd(g) * (1 + diff);
          feature(w, 'k', [5 + H, H]); feature(w, 'f', [3 + rnd(g) * 6]); feature(w, 'e', [8 + H * 1.5, -H]);
        } else if (r < 0.68) {                           // whoops
          feature(w, 'w', [3 + Math.floor(rnd(g) * 4), 2.4 + rnd(g) * 0.8, 0.35 + rnd(g) * (0.2 + 0.35 * diff)]);
        } else if (r < 0.78) {                           // the biome's set piece
          setPiece(w, bio, g, diff);
          coins = false;
        } else if (r < 0.84) {                           // logs and rocks
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
    function setPiece(w, bio, g, diff) {
      var r = rnd(g);
      switch (bio) {
        case 0: if (r < 0.5) feature(w, 'b', [8]); else { w.mat = 1; feature(w, 'w', [4, 3, 0.5 + diff * 0.2]); } break;
        case 1: if (r < 0.5) feature(w, 'p', [8 + rnd(g) * 3, 0.8 + rnd(g) * 0.3]); else feature(w, 'x', [2 + Math.floor(rnd(g) * 3)]); break;
        case 2: if (r < 0.4) { feature(w, 'n', [3]); feature(w, 'f', [4]); w.mat = 3; feature(w, 't', [24, 3.2]); feature(w, 'f', [10]); w.mat = 4; feature(w, 'f', [8]); w.mat = 3; feature(w, 'f', [8]); }
          else { feature(w, 'a', [40, rnd(g) < 0.5 ? -6 : 6]); w.mat = 4; feature(w, 'f', [10]); } break;
        case 3: if (r < 0.4) { feature(w, 'n', [3]); feature(w, 'f', [4]); feature(w, 't', [30, 3.2]); feature(w, 'f', [10]); feature(w, 'b', [8]); feature(w, 'f', [14]); }
          else if (r < 0.7) feature(w, 'x', [3 + Math.floor(rnd(g) * 3)]); else feature(w, 'b', [10]); break;
        case 4: feature(w, 'n', [5]); feature(w, 'f', [4]); feature(w, 'q', [20 + rnd(g) * 4]); if (rnd(g) < 0.5) feature(w, 'q', [22]); break;
        default: feature(w, 'z', [40]); feature(w, 'k', [7, 2 + diff]); feature(w, 'e', [12, -2 - diff]); break;
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

    // =================== a riding bot (rivals, tests, track validation) ===================
    // Gas with a speed cap set by skill; lean (on/off, like the keys) to keep the
    // frame parallel to the ground, and in the air to the slope at the predicted
    // landing spot. ai.band (set by the race) nudges the cap to keep races close.
    function bot(w) {
      var c = w.c, T = w.ter, lean = 0, gas = 1, brake = 0, a = w.ai;
      if (w.air || (!w.wh[0].touch && !w.wh[1].touch)) {
        var tl = 0.45, tgt = slopeAt(T, c.x + c.vx * tl, 1.0);
        var u = wrapPi(c.a - tgt) * 2.2 + c.w * 0.45;
        lean = u > 0.25 ? 1 : u < -0.25 ? -1 : 0;
      } else {
        var e2 = wrapPi(c.a - slopeAt(T, c.x, 1.0));
        if (e2 > 0.22) lean = 1; else if (e2 < -0.18) lean = -1;
        if (e2 > 0.6) gas = 0;
      }
      if (a) {
        var top = w.P.omax * w.P.wr[0], cap = top * (0.42 + 0.5 * a.skill) * a.band;
        if (c.vx > cap) gas = 0;
        // a boulder coming down ahead: don't arrive as it lands
        for (var i = 0; i < w.rocks.length; i++) {
          var r = w.rocks[i];
          if (r.st !== 1 || r.x < c.x - 1 || r.x > c.x + 30) continue;
          var tl = (-r.vy + Math.sqrt(r.vy * r.vy + 2 * G * Math.max(0, r.y - heightAt(T, r.x)))) / G, ta = (r.x - c.x) / Math.max(1, c.vx);
          if (ta > tl - 0.5 && ta < tl + 0.4) { gas = 0; if (ta < tl + 0.2) brake = 1; }
        }
        // stuck (wedged or crawling): count it as a fall back to the checkpoint
        if (w.state === 'ride') {
          if (c.x > a.prog + 0.5) { a.prog = c.x; a.stuckT = 0; } else a.stuckT += STEP;
          if (a.stuckT > 3.5) { a.stuckT = 0; crash(w, 'stuck'); }
        } else a.prog = c.x;
      }
      w.inGas = gas; w.inBrake = brake; w.inLean = lean;
    }
    // Fast-forward a rival to its finish (when the player is done first). Returns its time or NaN.
    function simToFinish(w, maxT) {
      var lim = w.t + (maxT || 90);
      while (w.state !== 'finish' && w.t < lim && w.state !== 'over') { step(w); w.events.length = 0; }
      return w.state === 'finish' ? w.final : NaN;
    }
    // Race order: finished first (by time), then by distance along the track.
    function standings(list) {
      return list.slice().sort(function (p, q) {
        var pf = p.w.state === 'finish', qf = q.w.state === 'finish';
        if (pf && qf) return p.w.final - q.w.final;
        if (pf !== qf) return pf ? -1 : 1;
        return q.w.c.x - p.w.c.x;
      });
    }

    // =================== judges ===================
    var JUDGES = [
      { key: 'barb', name: 'Barb "Big Air" Okafor', short: 'BARB', likes: 'airtime and height' },
      { key: 'prof', name: 'Professor Flip', short: 'PROF', likes: 'flips and variety' },
      { key: 'sato', name: 'Smooth Sato', short: 'SATO', likes: 'clean landings and wheelies' }
    ];
    var QUIPS = {
      barb: [['Did you even leave the ground?', 'My nan gets more air on a trampoline.'], ['Decent hang time. Higher!', 'Some real altitude in there.'], ['Now THAT is flying!', 'Air traffic control called. They\'re impressed.']],
      prof: [['One trick pony. Barely a pony.', 'I have seen this run before. Today.'], ['A respectable repertoire.', 'Good mix. More rotations, please.'], ['A symphony of rotation!', 'Textbook. I\'m adding it to the textbook.']],
      sato: [['Messy. Very messy.', 'Every landing was an argument.'], ['Tidy enough. Mind the casing.', 'Smooth in places.'], ['Like butter on a warm knife.', 'Not a wheel out of place.']]
    };
    // A run → summary numbers the judges look at.
    function runStats(w) {
      var uniq = {}, rep = 0, i, n = 0;
      for (i = 0; i < w.tricks.length; i++) { var k = w.tricks[i].k; if (k === 'perfect' || k === 'crate') continue; if (uniq[k]) rep++; else { uniq[k] = 1; n++; } }
      return { score: w.score, crashes: w.crashes, bottoms: w.bottoms, perfects: w.perfects, flips: w.flips, maxAir: w.maxAir, totalAir: w.totalAir,
        wheelie: w.wheelieTot, unique: n, repeats: rep, bestCombo: w.bestCombo, time: w.final || w.t };
    }
    // Three cards out of 10 each. tgt: the trick score this event considers "very good".
    function judge(s, tgt) {
      var base = 8.0 * (1 - Math.exp(-s.score / Math.max(1, tgt)));
      var raw = [
        base + Math.min(1.8, s.maxAir * 0.55 + s.totalAir * 0.05) - 0.6 * s.crashes,
        base + Math.min(1.8, s.unique * 0.25 + s.flips * 0.12) - 0.25 * s.repeats * (s.repeats > 3 ? 1 : 0.5) - 0.5 * s.crashes,
        base + Math.min(1.8, s.perfects * 0.3 + s.wheelie * 0.22) - 1.0 * s.crashes - 0.4 * s.bottoms
      ];
      var out = [], total = 0;
      for (var i = 0; i < 3; i++) {
        var v = Math.round(clamp(raw[i], 0, 10) * 10) / 10, q = QUIPS[JUDGES[i].key], tier = v < 4.5 ? 0 : v < 7.5 ? 1 : 2;
        out.push({ judge: JUDGES[i], score: v, quip: q[tier][(Math.round(v * 10) + i) % 2] });
        total += v;
      }
      return { cards: out, total: Math.round(total * 10) / 10 };
    }

    // =================== cosmetics ===================
    // Unlocked by coins (cost), a career boss (unlock: location key) or total stars (stars).
    var PAINTS = [
      { key: 'sig', name: 'Signature', col: '' }, { key: 'crimson', name: 'Crimson', col: '#e5484d', cost: 40 }, { key: 'tangerine', name: 'Tangerine', col: '#f76b15', cost: 40 },
      { key: 'mustard', name: 'Mustard', col: '#c99a0e', cost: 40 }, { key: 'moss', name: 'Moss', col: '#30a46c', cost: 40 }, { key: 'cobalt', name: 'Cobalt', col: '#3e63dd', cost: 40 },
      { key: 'grape', name: 'Grape', col: '#8e4ec6', cost: 40 }, { key: 'bubblegum', name: 'Bubblegum', col: '#d6409f', cost: 40 }, { key: 'graphite', name: 'Graphite', col: '#6f6e77' },
      { key: 'sand', name: 'Sandstorm', col: '#d4a55a', unlock: 'dust' }, { key: 'plaid', name: 'Lumberjack', col: '#b5482c', unlock: 'pine' }, { key: 'frost', name: 'Glacier', col: '#5cb8e6', unlock: 'frost' },
      { key: 'neon', name: 'Neon', col: '#14c9b8', unlock: 'neon' }, { key: 'lava', name: 'Lava', col: '#ff5a1f', unlock: 'magma' }, { key: 'gold', name: 'Champion gold', col: '#c9962e', unlock: 'summit' }
    ];
    var HELMETS = [
      { key: 'classic', name: 'Classic', g: 'O' }, { key: 'visor', name: 'Visor', g: '@', cost: 50 }, { key: 'chin', name: 'Chin-bar', g: 'Q', cost: 60 },
      { key: 'bubble', name: 'Bubble', g: '0', cost: 60 }, { key: 'skull', name: 'Skull', g: '8', stars: 30 }
    ];
    var ACCS = [
      { key: 'none', name: 'None' }, { key: 'scarf', name: 'Scarf', cost: 80 }, { key: 'mohawk', name: 'Mohawk', cost: 60 }, { key: 'flag', name: 'Pennant', cost: 100 },
      { key: 'cape', name: 'Cape', stars: 24 }, { key: 'antlers', name: 'Antlers', unlock: 'pine' }, { key: 'crown', name: 'Ice crown', unlock: 'frost' }, { key: 'wings', name: 'Wings', unlock: 'summit' }
    ];

    // =================== career ===================
    // The cast: rivals race real simulations of their machines; bosses own a location.
    var CAST = {
      mags: { name: 'Mags', role: 'your crew chief' },
      dex: { name: 'Dex Calloway', short: 'DEX', team: 'comet', col: '#e5484d', veh: 'wasp', look: { helmet: 'visor', acc: 'none' } },
      juno: { name: 'Juno Park', short: 'JUNO', team: 'kings', col: '#8e4ec6', veh: 'wasp', look: { helmet: 'bubble', acc: 'scarf' } },
      reyes: { name: '"Tumbleweed" Reyes', short: 'REYES', team: 'devils', col: '#f76b15', veh: 'mule', look: { helmet: 'classic', acc: 'flag' } },
      pip: { name: 'Pip Ferro', short: 'PIP', team: 'volt', col: '#3e63dd', veh: 'mule', look: { helmet: 'chin', acc: 'none' } },
      rosa: { name: 'Rosa Vance', short: 'ROSA', col: '#30a46c', veh: 'goat', look: { helmet: 'classic', acc: 'mohawk' } },
      lars: { name: 'Lars Brekke', short: 'LARS', col: '#0091ff', veh: 'rhino', look: { helmet: 'chin', acc: 'none' } },
      kai: { name: 'Kai Moana', short: 'KAI', col: '#d6409f', veh: 'wasp', look: { helmet: 'visor', acc: 'scarf' } },
      sal: { name: 'Sandstorm Sal', short: 'SAL', boss: 'dust', col: '#d4a55a', veh: 'buggy', look: { helmet: 'visor', acc: 'scarf' } },
      jack: { name: 'Timber Jack', short: 'JACK', boss: 'pine', col: '#b5482c', veh: 'rhino', look: { helmet: 'classic', acc: 'antlers' } },
      ingrid: { name: 'Ingrid Frost', short: 'INGRID', boss: 'frost', col: '#5cb8e6', veh: 'wasp', fx: { matMu: [1, 0.92, 0.95, 1.35, 3.4, 0.86, 0.82, 1] }, look: { helmet: 'bubble', acc: 'crown' } },
      nyx: { name: 'Nyx', short: 'NYX', boss: 'neon', col: '#14c9b8', veh: 'viper', look: { helmet: 'visor', acc: 'none' } },
      mo: { name: 'Big Mo', short: 'BIG MO', boss: 'magma', col: '#ff5a1f', veh: 'bigfoot', look: { helmet: 'chin', acc: 'none' } },
      baron: { name: 'The Baron', short: 'BARON', boss: 'summit', col: '#c9962e', veh: 'phantom', look: { helmet: 'skull', acc: 'cape' } }
    };
    // Events. race/boss: rivals [cast, skill] on a track. stunt: judged run vs fixed
    // rival totals (of 30); tgt = trick score worth ~8/10. climb: endless biome,
    // tiers = metres for 1st/2nd/3rd. time: tiers = seconds. Podium (top 3)
    // completes an event; bosses must be won. Prize pots pay in full the first
    // time, half on replays. bet: an optional side bet against a named rival.
    var EVENTS = [
      // ---- Dustbowl Flats ----
      { id: 'dust-1', loc: 'dust', type: 'race', name: 'County Fair Dash', track: 'dust1', fee: 0, prize: [150, 80, 40], rivals: [['pip', 0.25], ['reyes', 0.2], ['rosa', 0.3]], bet: ['reyes', 40],
        intro: [['mags', 'Welcome to the Dustbowl, kid. One lap, three locals, a biscuit tin of prize money.'], ['reyes', 'Heh. Another rookie. Mind the sand — it eats momentum for breakfast.'], ['mags', 'Hold gas, lean back on the climbs and forward over the crests. Podium and we eat tonight.']],
        win: [['mags', 'Not bad for a first outing. Prize money\'s in the tin.']], lose: [['reyes', 'Sand in your teeth yet? Come back when you\'re grown.']] },
      { id: 'dust-2', loc: 'dust', type: 'stunt', name: 'Mesa Showoff', track: 'dust2', fee: 20, prize: [200, 100, 50], tgt: 1400, scores: [['juno', 15.5], ['rosa', 12.5], ['pip', 9.5]], bet: ['juno', 60],
        intro: [['juno', 'Hey rookie! I\'m Juno. The judges here want air and flips, not lap times.'], ['juno', 'Hold SPACE in the air to pose — let go before you land, or you eat dirt. Lean while you press it to pick the pose.'], ['mags', 'Chain tricks without stopping and the combo multiplies. And the judges hate repeats — mix it up.']],
        win: [['juno', 'Okay, okay, you can fly. See you at the next one.']], lose: [['juno', 'Close-ish! Try the springboard, it\'s free air.']] },
      { id: 'dust-3', loc: 'dust', type: 'climb', name: 'Long Haul Climb', biome: 0, seed: 1201, tiers: [900, 550, 300], fee: 30, prize: [260, 130, 60],
        intro: [['mags', 'Hill climb. No track, no finish line — one tank of fuel and as far as it gets you. Grab the [F] cans.'], ['mags', 'Easy on the throttle on the flats; fuel burns faster with the gas pinned.']],
        win: [['mags', 'That\'s the kind of distance that gets noticed.']], lose: [['mags', 'Ran dry. Happens. A long-range tank would help — at a weight cost.']] },
      { id: 'dust-b', loc: 'dust', type: 'boss', name: 'Duel: Sandstorm Sal', track: 'dust3', fee: 50, prize: [700], rivals: [['sal', 0.45]], reward: 'Dune Buggy for sale · Sandstorm paint',
        intro: [['sal', 'So you\'re the noise on my dunes. I\'ve buried better riders under this sand.'], ['mags', 'Her buggy\'s planted and fast in the sand but slow to rotate. Out-jump her on the whoops.'], ['sal', 'Dune Sea. One lap. Try to keep my dust in sight.']],
        win: [['sal', '...Fine. You earned it. My old buggy\'s yours to buy, if four wheels don\'t scare you.'], ['mags', 'Pack the van. Pinewood Ridge is next.']], lose: [['sal', 'Back to the kiddie fair, sprout.']] },
      // ---- Pinewood Ridge ----
      { id: 'pine-1', loc: 'pine', type: 'race', name: 'Logjam Sprint', track: 'pine1', fee: 40, prize: [320, 160, 70], rivals: [['reyes', 0.35], ['rosa', 0.45], ['lars', 0.4]], bet: ['lars', 80],
        intro: [['mags', 'Pinewood Ridge. Logs, rocks, mud. Mud kills grip — knobbies love it, slicks hate it.'], ['lars', 'You\'re the desert kid? Forest is different. The forest bites.']],
        win: [['lars', 'Hm. The forest likes you. Odd.']], lose: [['lars', 'The forest bit.']] },
      { id: 'pine-2', loc: 'pine', type: 'race', name: 'Mudslide Derby', track: 'pine2', fee: 50, prize: [380, 190, 80], rivals: [['dex', 0.5], ['juno', 0.45], ['rosa', 0.5]], bet: ['dex', 100],
        intro: [['dex', 'Dex Calloway, Red Comet Factory. You\'ve probably seen me on posters.'], ['dex', 'The pools are deep. If your head goes under, you\'re done. Not that it\'ll matter.'], ['mags', 'Ignore him. Carry speed into the water and don\'t lean too far forward.']],
        win: [['dex', 'Lucky line through the mud. Won\'t happen twice.']], lose: [['dex', 'Like I said: posters.']] },
      { id: 'pine-3', loc: 'pine', type: 'stunt', name: 'Sawmill Session', track: 'pine3', fee: 40, prize: [360, 180, 80], tgt: 1900, scores: [['juno', 18.0], ['kai', 15.5], ['rosa', 12.5]],
        intro: [['juno', 'The old sawmill! Crates to smash, a trick zone where everything scores double.'], ['mags', 'Mind the ceiling in the mill shed. Wheelies are worth points — but not in there.']],
        win: [['juno', 'Those judges are actually smiling. That never happens.']], lose: [['juno', 'Smash more crates! They count as tricks.']] },
      { id: 'pine-b', loc: 'pine', type: 'stunt', boss: true, name: 'Stunt-off: Timber Jack', track: 'pine1', fee: 60, prize: [1000], tgt: 2200, scores: [['jack', 21.5]], reward: 'Rhino 450 for sale · Lumberjack paint · Antlers',
        intro: [['jack', 'Six seasons nobody\'s beaten my score on this trail. I carved half these logs myself.'], ['jack', 'Show the judges something new. They\'ve seen everything I do. Twice.'], ['mags', 'Variety, kid. Every trick you repeat is worth less.']],
        win: [['jack', 'Well I\'ll be. Take the Rhino for a spin — she\'s too much bike for most.'], ['mags', 'North to Frostbite Pass. Pack warm.']], lose: [['jack', 'Back to the sawdust, kid.']] },
      // ---- Frostbite Pass ----
      { id: 'frost-1', loc: 'frost', type: 'race', name: 'Powder Run', track: 'frost1', fee: 60, prize: [440, 220, 100], rivals: [['lars', 0.55], ['pip', 0.5], ['juno', 0.5]], bet: ['pip', 100],
        intro: [['mags', 'Snow saps speed, ice saps grip. Don\'t touch the brakes on the blue stuff.'], ['pip', 'Volt Syndicate\'s finest, at your service. My battery\'s warm, is yours?']],
        win: [['pip', 'Cold hands, fast lap. Respect.']], lose: [['pip', 'Efficiency wins again.']] },
      { id: 'frost-2', loc: 'frost', type: 'time', name: 'Black Ice Attack', track: 'frost2', fee: 50, tiers: [23.5, 27, 31], prize: [420, 210, 90],
        intro: [['mags', 'Time attack. You against the clock on sheet ice and a cave.'], ['mags', 'Flips and perfect landings take seconds off. The ice is where you lose them.']],
        win: [['mags', 'The clock doesn\'t lie, and today it likes you.']], lose: [['mags', 'Too slow. Grippier tyres, or a cleaner line.']] },
      { id: 'frost-3', loc: 'frost', type: 'climb', name: 'Whiteout Climb', biome: 2, seed: 777, tiers: [1100, 700, 400], fee: 60, prize: [480, 240, 100],
        intro: [['mags', 'Whiteout climb. Ice caves, crosswinds, one tank.'], ['mags', 'Wind shoves you in the air. Heavier machines care less.']],
        win: [['mags', 'Halfway up a glacier on one tank. Show-off.']], lose: [['mags', 'The mountain wins this one.']] },
      { id: 'frost-b', loc: 'frost', type: 'boss', name: 'Duel: Ingrid Frost', track: 'frost3', fee: 80, prize: [1300], rivals: [['ingrid', 0.45]], reward: 'Studded tyres · Glacier paint · Ice crown',
        intro: [['ingrid', 'I have not lost on home snow. Not once. Not in nine winters.'], ['ingrid', 'Avalanche Gulch. When the rocks start falling, don\'t look up.'], ['mags', 'Her studs stick to ice like glue. Beat her in the air and on the rock.']],
        win: [['ingrid', '...Impressive. Take a set of my studs. You will need them more than me now.'], ['mags', 'The docks. City racing. Night shift.']], lose: [['ingrid', 'Ten winters.']] },
      // ---- Neon Docks ----
      { id: 'neon-1', loc: 'neon', type: 'race', name: 'Container Yard GP', track: 'neon1', fee: 80, prize: [520, 260, 120], rivals: [['dex', 0.6], ['kai', 0.6], ['reyes', 0.55]], bet: ['dex', 150],
        intro: [['dex', 'Big city, farm kid. Tarmac and steel. Your little knobbies will squeal.'], ['mags', 'Boost strips are free speed. Slicks love this place — if you can live with them.']],
        win: [['dex', 'Whatever. The real race is Nyx.']], lose: [['dex', 'Tarmac\'s my house.']] },
      { id: 'neon-2', loc: 'neon', type: 'stunt', name: 'Harbour Lights Jam', track: 'neon3', fee: 70, prize: [540, 270, 120], tgt: 2400, scores: [['kai', 20.5], ['juno', 19.0], ['dex', 15.0]], bet: ['kai', 120],
        intro: [['kai', 'Kai Moana. I do the harbour leap every night. Springboards, big gaps, bigger crowd.'], ['juno', 'Kai\'s good. Like, really good. Go huge in the trick zone.']],
        win: [['kai', 'The harbour has a new favourite. Rude.']], lose: [['kai', 'The crowd came for me, friend.']] },
      { id: 'neon-3', loc: 'neon', type: 'time', name: 'Night Shift Attack', track: 'neon2', fee: 60, tiers: [26, 30, 35], prize: [500, 250, 110],
        intro: [['mags', 'Lights off, headlamp on. Tunnels and gaps in the dark.'], ['mags', 'Learn it here. Nyx races this exact track.']],
        win: [['mags', 'You see in the dark now? Good.']], lose: [['mags', 'Again. The tunnels are where the time is.']] },
      { id: 'neon-b', loc: 'neon', type: 'boss', name: 'Duel: Nyx', track: 'neon2', fee: 100, prize: [1600], rivals: [['nyx', 0.45]], reward: 'Viper 600 for sale · Neon paint',
        intro: [['nyx', '...'], ['nyx', 'Night Shift. One lap. Don\'t talk to me after.'], ['mags', 'Her Viper is a missile on the straights. Win it in the jumps and the tunnels.']],
        win: [['nyx', '...fine. Keys to the Viper are on the hook.'], ['mags', 'Magma Quarry. Bring a helmet. A bigger one.']], lose: [['nyx', '...']] },
      // ---- Magma Quarry ----
      { id: 'magma-1', loc: 'magma', type: 'race', name: 'Rockfall Rally', track: 'magma1', fee: 100, prize: [620, 310, 140], rivals: [['lars', 0.65], ['rosa', 0.65], ['dex', 0.65]], bet: ['lars', 150],
        intro: [['mags', 'When you get close, the boulders on the ledges come down. Go early or go late — not in between.'], ['lars', 'The forest bites. The quarry crushes.']],
        win: [['lars', 'You dodge like a deer.']], lose: [['lars', 'Crushed.']] },
      { id: 'magma-2', loc: 'magma', type: 'climb', name: 'Caldera Climb', biome: 4, seed: 4242, tiers: [1300, 800, 450], fee: 90, prize: [650, 320, 140],
        intro: [['mags', 'Up the side of the caldera. Rock gives great grip; the falling stuff doesn\'t.']],
        win: [['mags', 'Top of the caldera. The view\'s terrible, it\'s all smoke.']], lose: [['mags', 'Lava 1, you 0.']] },
      { id: 'magma-3', loc: 'magma', type: 'stunt', name: 'Sawtooth Showdown', track: 'magma2', fee: 90, prize: [640, 320, 140], tgt: 2600, scores: [['juno', 22.0], ['kai', 20.5], ['dex', 17.0]], bet: ['juno', 150],
        intro: [['juno', 'Sawtooth! Every tooth is a launch ramp. Flip off every one.'], ['mags', 'Drops onto flat ground will case your suspension. Land on the downslopes.']],
        win: [['juno', 'Okay, I officially have a rival. It\'s you.']], lose: [['juno', 'Ha! Gravity Kings forever.']] },
      { id: 'magma-b', loc: 'magma', type: 'boss', name: 'Duel: Big Mo', track: 'magma1', fee: 120, prize: [1900], rivals: [['mo', 0.65]], reward: 'Bigfoot for sale · Lava paint',
        intro: [['mo', 'HAHAHA! Little bike! I will drive OVER you!'], ['mo', 'Bigfoot does not jump. Bigfoot does not need to jump.'], ['mags', 'He can\'t rotate and he can\'t corner. But he never crashes. Be clean.']],
        win: [['mo', 'Little bike... is FAST bike. Take Bigfoot. Big Mo needs a bigger one.'], ['mags', 'That\'s it, kid. The Summit Cup.']], lose: [['mo', 'SQUISH!']] },
      // ---- The Summit ----
      { id: 'summit-1', loc: 'summit', type: 'race', name: 'Canyon Qualifier', track: 'summit1', fee: 150, prize: [800, 400, 200], rivals: [['dex', 0.75], ['juno', 0.7], ['ingrid', 0.7]], bet: ['dex', 200],
        intro: [['mags', 'The best of every circuit is here. Canyon Run qualifies you for the Cup.'], ['dex', 'Remember me? Red Comet bought me a new engine just for you.']],
        win: [['dex', 'Fine. FINE. See you on the mountain.']], lose: [['dex', 'Posters, rookie. Posters.']] },
      { id: 'summit-2', loc: 'summit', type: 'stunt', name: 'Big Air Invitational', track: 'summit2', fee: 140, prize: [820, 410, 200], tgt: 3000, scores: [['juno', 24.0], ['kai', 22.5], ['jack', 21.0]], bet: ['juno', 200],
        intro: [['juno', 'The Invitational! Two trick zones, the biggest gaps on the mountain.'], ['mags', 'Double flips in a trick zone. That\'s the whole plan.']],
        win: [['juno', 'Best run I\'ve ever lost to.']], lose: [['juno', 'Next time, rival.']] },
      { id: 'summit-3', loc: 'summit', type: 'time', name: 'Summit Time Attack', track: 'summit3', fee: 120, tiers: [57, 65, 76], prize: [780, 390, 180],
        intro: [['mags', 'The full mountain, against the clock. Learn every metre — the Cup is on this track.']],
        win: [['mags', 'You know the mountain now.']], lose: [['mags', 'Again. The Baron won\'t wait.']] },
      { id: 'summit-b', loc: 'summit', type: 'boss', name: 'The Summit Cup', track: 'summit3', fee: 200, prize: [3000, 800, 300], rivals: [['baron', 0.4], ['dex', 0.85], ['juno', 0.8]], reward: 'Champion: Phantom E for sale · Gold paint · Wings',
        intro: [['baron', 'Ah. The rookie from the dust. How charming.'], ['baron', 'My Phantom has no engine noise, so you will not even hear me pass.'], ['mags', 'Everything you\'ve learned, kid. Every line. Go.']],
        win: [['baron', 'Impossible. ...Take the prototype. I shall build another.'], ['juno', 'CHAMPION! I knew it! Okay, I hoped it.'], ['mags', 'From the Dustbowl to the top of the mountain. Proud of you, kid.']], lose: [['baron', 'As expected.']] }
    ];
    var LOC_INTRO = {
      dust: [['mags', 'Dustbowl Flats. Fairground circuit, sand everywhere, prize money in a biscuit tin.'], ['mags', 'Every legend started somewhere like this. Win a couple of podiums and Sandstorm Sal will come looking for you.']],
      pine: [['mags', 'Pinewood Ridge. Mud, logs, and a sawmill somebody turned into a stunt park.'], ['juno', 'Timber Jack runs the stunt scene here. Nobody\'s out-styled him in six seasons.']],
      frost: [['mags', 'Frostbite Pass. Ice doesn\'t care how good you are.'], ['mags', 'Ingrid Frost hasn\'t lost on home snow. Ever.']],
      neon: [['mags', 'The Neon Docks. Night racing on tarmac and shipping containers, springboards over the harbour.'], ['dex', 'Nyx runs these docks, farm kid. And she doesn\'t do second place.']],
      magma: [['mags', 'Magma Quarry. Rocks fall, lava glows, and Big Mo drives a monster truck straight through the lot.'], ['mags', 'Keep your eyes up. The boulders come down when you get close.']],
      summit: [['mags', 'The Summit Cup. Every champion from every circuit — and the Baron, on top of the mountain.'], ['baron', 'A rookie? How quaint. Do try to keep up.']]
    };
    function eventOf(id) { for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) return EVENTS[i]; return null; }
    function locEvents(loc) { return EVENTS.filter(function (e) { return e.loc === loc; }); }
    function isBoss(ev) { return ev.type === 'boss' || !!ev.boss; }
    function locIdx(k) { for (var i = 0; i < LOCS.length; i++) if (LOCS[i].key === k) return i; return -1; }
    function locOpen(save, li) { return li === 0 || !!save.career.boss[LOCS[li - 1].key]; }
    function podiums(save, loc) {
      var n = 0;
      locEvents(loc).forEach(function (e) { var r = save.career.ev[e.id]; if (!isBoss(e) && r && r.p >= 1 && r.p <= 3) n++; });
      return n;
    }
    function bossOpen(save, loc) { return podiums(save, loc) >= 2; }
    // Money for a finished event. first: no earlier podium (full pot, else half).
    function payout(ev, place, team, first, betOn, won) {
      var tm = teamOf(team) || { prize: 1, fees: 1 }, pot = ev.prize[place - 1] || 0;
      if (!first) pot = Math.round(pot * 0.5);
      pot = Math.round(pot * tm.prize);
      var bet = betOn && ev.bet ? (won ? ev.bet[1] : -ev.bet[1]) : 0;
      return { prize: pot, bet: bet, total: pot + bet };
    }
    function entryFee(ev, team) { var tm = teamOf(team); return Math.round(ev.fee * (tm ? tm.fees : 1)); }
    function partCost(opt, team) { var tm = teamOf(team); return Math.round(opt.cost * (tm ? tm.parts : 1)); }
    // place for a tiered event (climb: metres, more is better; time: seconds, less is better)
    function tierPlace(ev, v) {
      for (var i = 0; i < 3; i++) if (ev.type === 'climb' ? v >= ev.tiers[i] : (v > 0 && v <= ev.tiers[i])) return i + 1;
      return 4;
    }
    // Boss rewards: everything in the catalogue unlocked by beating loc's boss.
    function unlockedBy(loc) {
      var out = [];
      VEHICLES.forEach(function (v) { if (v.unlock === loc) out.push(v.name); });
      PARTS.forEach(function (s) { s.opts.forEach(function (o) { if (o.unlock === loc) out.push(o.name + ' ' + s.name.toLowerCase()); }); });
      PAINTS.forEach(function (p) { if (p.unlock === loc) out.push(p.name + ' paint'); });
      ACCS.forEach(function (a) { if (a.unlock === loc) out.push(a.name); });
      return out;
    }

    // =================== persistence ===================
    var UP_COST_V1 = [40, 90, 180, 320];
    function emptyCareer() { return { team: '', ev: {}, boss: {}, seen: {}, champ: false }; }
    function normSave(o) {
      var s = { v: 2, coins: 0, eb: 0, ghost: 'best', cam: 0, map: true, tt: {}, veh: 'mule', owned: { mule: 1 }, parts: {}, own: {}, look: { paint: 'sig', helmet: 'classic', jersey: 'graphite', acc: 'none' }, career: emptyCareer() };
      if (!o || typeof o !== 'object') return s;
      var i, k;
      s.coins = Math.max(0, Math.floor(+o.coins || 0));
      s.eb = Math.max(0, Math.floor(+o.eb || 0));
      if (o.v !== 2) {                                      // v1: refund the old linear upgrades as coins
        if (o.up && typeof o.up === 'object') for (k in o.up) { var lv = clamp(o.up[k] | 0, 0, 4); for (i = 0; i < lv; i++) s.coins += UP_COST_V1[i]; }
        s.ghost = o.ghost === false ? 'off' : 'best';
        return s;
      }
      s.ghost = o.ghost === 'rival' || o.ghost === 'off' ? o.ghost : 'best';
      s.cam = clamp(o.cam | 0, 0, 3);
      s.map = o.map !== false;
      if (o.tt && typeof o.tt === 'object') {
        for (i = 0; i < TRACKS.length; i++) {
          var r = o.tt[TRACKS[i].key];
          if (r && typeof r === 'object' && +r.t > 0 && isFinite(+r.t)) s.tt[TRACKS[i].key] = { t: +r.t, s: clamp(r.s | 0, 1, 3), sc: Math.max(0, Math.floor(+r.sc || 0)) };
        }
      }
      if (o.owned && typeof o.owned === 'object') VEHICLES.forEach(function (v) { if (o.owned[v.key]) s.owned[v.key] = 1; });
      s.veh = s.owned[o.veh] ? o.veh : 'mule';
      if (o.own && typeof o.own === 'object') for (k in o.own) if (o.own[k] && /^[a-z]+\.[a-z]+$/.test(k)) s.own[k] = 1;
      PARTS.forEach(function (sl) {
        var key = o.parts && o.parts[sl.slot];
        s.parts[sl.slot] = key && find(sl.opts, key) && (key === sl.opts[0].key || s.own[sl.slot + '.' + key]) ? key : sl.opts[0].key;
      });
      var L = o.look || {};
      function lk(list, kind, key, d) { return find(list, key) && (lookOwned(s, kind, find(list, key))) ? key : d; }
      s.look = { paint: lk(PAINTS, 'p', L.paint, 'sig'), helmet: lk(HELMETS, 'h', L.helmet, 'classic'), jersey: lk(PAINTS, 'p', L.jersey, 'graphite'), acc: lk(ACCS, 'a', L.acc, 'none') };
      var C = o.career || {};
      s.career.team = teamOf(C.team) ? C.team : '';
      if (C.ev && typeof C.ev === 'object') EVENTS.forEach(function (e) { var r = C.ev[e.id]; if (r && typeof r === 'object') s.career.ev[e.id] = { p: clamp(r.p | 0, 1, 9), b: +r.b || 0, n: Math.max(1, r.n | 0) }; });
      if (C.boss && typeof C.boss === 'object') LOCS.forEach(function (l) { if (C.boss[l.key]) s.career.boss[l.key] = 1; });
      if (C.seen && typeof C.seen === 'object') LOCS.forEach(function (l) { if (C.seen[l.key]) s.career.seen[l.key] = 1; });
      s.career.champ = !!C.champ;
      if (o.far && typeof o.far === 'object') { s.far = {}; TRACKS.forEach(function (t) { var f = o.far[t.key]; if (f && +f.d > 0 && isFinite(+f.d) && !s.tt[t.key]) s.far[t.key] = { d: +f.d, v: find(VEHICLES, f.v) ? f.v : 'mule' }; }); }
      if (o.ghostVeh && typeof o.ghostVeh === 'object') { s.ghostVeh = {}; TRACKS.forEach(function (t) { var v = o.ghostVeh[t.key]; if (find(VEHICLES, v)) s.ghostVeh[t.key] = v; }); }
      return s;
    }
    function totalStars(save) { var n = 0; for (var k in save.tt) n += save.tt[k].s; return n; }
    // A catalogue item is available when it is free, bought, or earned.
    function lookOwned(save, kind, it) {
      if (!it.cost && !it.unlock && !it.stars) return true;
      if (save.own[kind + '.' + it.key]) return true;
      if (it.unlock && save.career.boss[it.unlock]) return !it.cost;
      if (it.stars && totalStars(save) >= it.stars) return true;
      return false;
    }
    // Can this be bought (as opposed to earned)? Vehicles / parts with an unlock need the boss first.
    function buyable(save, it) { return !!it.cost && (!it.unlock || !!save.career.boss[it.unlock]); }
    function vehAvail(save, v) { return !v.unlock || !!save.career.boss[v.unlock]; }
    function partAvail(save, slot, o) { return !o.unlock || !!save.career.boss[o.unlock]; }
    function partOwned(save, slot, o) { return !o.cost || !!save.own[slot + '.' + o.key]; }
    function ttUnlocked(save, idx) { return idx % 3 === 0 || !!save.tt[TRACKS[idx - 1].key]; }   // first track of each location is open

    // Ghost: chassis x, y, angle, lean (9 = crashed), pose (+2·kind) every GHOST_DT;
    // delta + zigzag + base-32 varints, "5;" channel prefix.
    var GHOST_DT = 0.1, GCH = 5, GSCALE = [20, 20, 100, 50, 50];
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    function encodeGhost(arr, n) {
      var out = '', prev = [0, 0, 0, 0, 0];
      for (var i = 0; i < n; i++) {
        for (var k = 0; k < GCH; k++) {
          var q = Math.round(arr[i * GCH + k] * GSCALE[k]), d = q - prev[k];
          prev[k] = q;
          var z = d >= 0 ? d * 2 : -d * 2 - 1;
          while (z >= 32) { out += B64.charAt(32 + (z % 32)); z = Math.floor(z / 32); }
          out += B64.charAt(z);
        }
      }
      return out;
    }
    // Stored form, size-capped: if the plain encoding is over maxLen chars, keep
    // every k-th sample behind a "k." prefix; decodeGhost resamples back to GHOST_DT.
    var GHOST_MAX = 200000;
    function packGhost(arr, n, maxLen) {
      maxLen = maxLen || GHOST_MAX;
      var s = '5;' + encodeGhost(arr, n);
      for (var k = 2; s.length > maxLen && k <= 64; k *= 2) {
        var m = Math.ceil(n / k), d = new Float32Array(m * GCH);
        for (var i = 0; i < m; i++) for (var q = 0; q < GCH; q++) d[i * GCH + q] = arr[i * k * GCH + q];
        s = '5;' + k + '.' + encodeGhost(d, m);
      }
      return s.length > maxLen ? '' : s;
    }
    function decodeGhost(str) {
      if (typeof str !== 'string' || str.slice(0, 2) !== '5;') return null;
      str = str.slice(2);
      var pre = /^(\d{1,2})\./.exec(str), step = pre ? +pre[1] : 1;
      if (pre) { if (step < 1) return null; str = str.slice(pre[0].length); }
      var vals = [], prev = [0, 0, 0, 0, 0], k = 0, z = 0, mul = 1;
      for (var i = 0; i < str.length; i++) {
        var v = B64.indexOf(str.charAt(i));
        if (v < 0) return null;
        if (v >= 32) { z += (v - 32) * mul; mul *= 32; continue; }
        z += v * mul;
        var d = z % 2 ? -(z + 1) / 2 : z / 2;
        prev[k] += d; vals.push(prev[k] / GSCALE[k]);
        k = (k + 1) % GCH; z = 0; mul = 1;
      }
      if (k !== 0) return null;
      var m = vals.length / GCH;
      if (step === 1 || m < 2) return new Float32Array(vals);
      var out = new Float32Array(((m - 1) * step + 1) * GCH);
      for (var j = 0; j < out.length / GCH; j++) {
        var f = j / step, a = Math.min(m - 2, Math.floor(f)), t = f - a;
        for (var q = 0; q < GCH; q++) out[j * GCH + q] = vals[a * GCH + q] + (vals[a * GCH + GCH + q] - vals[a * GCH + q]) * (q === 4 ? (t < 0.5 ? 0 : 1) : t);
      }
      return out;
    }
    // The ghost at run time t, interpolated (into out[0..4]). False before the
    // start or after the recording ends.
    function ghostAt(gd, t, out) {
      if (!gd || !(t >= 0)) return false;
      var f = t / GHOST_DT, i = Math.floor(f), n = gd.length / GCH;
      if (i >= n - 1) return false;
      var u = f - i, o = i * GCH;
      for (var q = 0; q < 4; q++) out[q] = gd[o + q] + (gd[o + GCH + q] - gd[o + q]) * u;
      if (gd[o + 3] === 9 || gd[o + GCH + 3] === 9) out[3] = 9;
      out[4] = gd[o + 4];
      return true;
    }
    // Metres the rider at x leads the ghost at run time t (negative: behind).
    // Once the ghost's run is over it waits where it ended (the finish).
    var _gq = [0, 0, 0, 0, 0];
    function ghostLead(gd, t, x) {
      if (!gd || gd.length < GCH * 2) return NaN;
      var gx = ghostAt(gd, t, _gq) ? _gq[0] : t < 0 ? gd[0] : gd[gd.length - GCH];
      return x - gx;
    }
    // The crew chief's reference lap: a bot run of the track, recorded.
    function rivalGhost(trackKey, skill) {
      var w = newWorld({ track: trackKey, ai: { skill: skill == null ? 0.72 : skill } });
      var rec = new Float32Array(1500 * GCH);
      w.rec = rec; w.recN = 0;
      while (w.state !== 'finish' && w.t < 140) { step(w); w.events.length = 0; }
      return { data: rec.slice(0, w.recN * GCH), t: w.state === 'finish' ? w.final : NaN };
    }
    // A finished time-trial run → save (best time, stars, star coins, best score).
    var STAR_COINS = 15;
    function stars(tr, time) { return !(time > 0) ? 0 : time <= tr.par[0] ? 3 : time <= tr.par[1] ? 2 : 1; }
    function stageResult(save, key, t, score) {
      var tr = trackOf(key), rec = save.tt[key], prevStars = rec ? rec.s : 0, st = stars(tr, t);
      var newBest = !!(t > 0) && (!rec || t < rec.t - 1e-6);
      var newScore = !!(score > 0) && (!rec || score > rec.sc);
      if (newBest) save.tt[key] = { t: Math.round(t * 1000) / 1000, s: Math.max(st, prevStars), sc: Math.max(score | 0, rec ? rec.sc : 0) };
      else if (rec) { if (st > prevStars) rec.s = st; if (newScore) rec.sc = score | 0; }
      var earned = Math.max(0, st - prevStars) * STAR_COINS;
      save.coins += earned;
      return { newBest: newBest, newScore: newScore, prev: rec ? rec.t : null, prevStars: prevStars, stars: st, earned: earned };
    }

    return {
      STEP: STEP, G: G, HEAD_R: HEAD_R, CRASH_T: CRASH_T, GHOST_DT: GHOST_DT, GCH: GCH, GHOST_MAX: GHOST_MAX, STAR_COINS: STAR_COINS,
      MATS: MATS, GEOM: GEOM, VEHICLES: VEHICLES, PARTS: PARTS, TEAMS: TEAMS, TRACKS: TRACKS, LOCS: LOCS, STYLE: STYLE,
      PAINTS: PAINTS, HELMETS: HELMETS, ACCS: ACCS, CAST: CAST, EVENTS: EVENTS, LOC_INTRO: LOC_INTRO, JUDGES: JUDGES,
      RAG_N: RAG_N, RAG_PAIRS: RAG_PAIRS, CW_TERRAIN: 0.26,
      newWorld: newWorld, step: step, advance: advance, placeBike: placeBike, riderPose: riderPose, resetCam: resetCam, crash: crash,
      heightAt: heightAt, slopeAt: slopeAt, segAt: segAt, matAt: matAt, groundDist: groundDist, roofAt: roofAt, waterAt: waterAt, biomeAt: biomeAt, parseSrc: parseSrc,
      bikeParams: bikeParams, vehStats: vehStats, vehOf: vehOf, teamOf: teamOf, partOpt: partOpt, slotOf: slotOf, trackOf: trackOf, trackIdx: trackIdx, find: find,
      stars: stars, normSave: normSave, totalStars: totalStars, lookOwned: lookOwned, buyable: buyable, vehAvail: vehAvail, partAvail: partAvail, partOwned: partOwned, ttUnlocked: ttUnlocked,
      encodeGhost: encodeGhost, decodeGhost: decodeGhost, packGhost: packGhost, ghostAt: ghostAt, ghostLead: ghostLead, rivalGhost: rivalGhost, stageResult: stageResult,
      bot: bot, simToFinish: simToFinish, standings: standings, runStats: runStats, judge: judge, bankCombo: bankCombo, flipName: flipName,
      eventOf: eventOf, locEvents: locEvents, isBoss: isBoss, locIdx: locIdx, locOpen: locOpen, podiums: podiums, bossOpen: bossOpen, payout: payout, entryFee: entryFee, partCost: partCost, tierPlace: tierPlace, unlockedBy: unlockedBy, emptyCareer: emptyCareer,
      wrapPi: wrapPi, clamp: clamp, rnd: rnd
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
  var SAVE_KEY = 'cade-uphill-save', GHOST_KEY = 'cade-uphill-g5-', OLD_GHOST_KEY = 'cade-uphill-ghost-', SOUND_KEY = 'cade-uphill-sound';
  var TAU = Math.PI * 2, CW = E.CW_TERRAIN, ROW_M = 0.42, REC_CAP = 9000;
  var clamp = E.clamp;
  var S = null;                                   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.uphill = { live: function () { return S; }, draw: function (a) { draw(a); }, E: E };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); return true; } catch (e) { return false; } }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function loadSave() { var o = null; try { o = JSON.parse(sget(SAVE_KEY) || 'null'); } catch (e) { o = null; } return E.normSave(o); }
  function writeSave() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtT(t) { return (Math.round(t * 100) / 100).toFixed(2) + 's'; }
  function fmtN(n) { n = Math.round(n); return n >= 1000 ? Math.floor(n / 1000) + ',' + ('00' + (n % 1000)).slice(-3) : '' + n; }
  function starStr(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }
  function ord(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  function lerp(a, b, t) { return a + (b - a) * t; }

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
  Snd.prototype.chord = function (fs, step, type, vol) { var me = this; fs.forEach(function (f, j) { me.tone(f, 0.1, type || 'triangle', vol || 0.04, 0, j * (step || 0.06)); }); };
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
      this.hum = { o: o, g: g, f: f };
    } catch (e) { this.hum = null; }
  };
  Snd.prototype.humSet = function (freq, vol, cut) {
    var h = this.hum;
    if (!h) return;
    try { var t = this.ac.currentTime; h.o.frequency.setTargetAtTime(freq, t, 0.05); h.g.gain.setTargetAtTime(vol, t, 0.07); h.f.frequency.setTargetAtTime(cut || 480, t, 0.1); } catch (e) {}
  };
  Snd.prototype.humStop = function () {
    var h = this.hum;
    if (!h) return;
    this.hum = null;
    try { var t = this.ac.currentTime; h.g.gain.setTargetAtTime(0.0001, t, 0.03); h.o.stop(t + 0.2); } catch (e) {}
  };
  Snd.prototype.close = function () { this.hum = null; if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  // ---- theme colours (from the app's CSS variables, tinted per location) ----
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
  // Scenery per location: tint, far / near background layers, sky, weather, gap style.
  var LOC_THEME = {
    dust: { tint: '#d0893a', far: 'mesa', near: 'cactus', sky: 'sun', fx: 'dust', gap: 'pit' },
    pine: { tint: '#3f9b57', far: 'hills', near: 'pines', sky: 'clouds', fx: 'leaves', gap: 'pit' },
    frost: { tint: '#4ea3e0', far: 'peaks', near: 'snowpines', sky: 'clouds', fx: 'snow', gap: 'crevasse' },
    neon: { tint: '#c34bd6', far: 'city', near: 'docks', sky: 'moon', fx: 'rain', gap: 'water', night: true },
    magma: { tint: '#e2553d', far: 'volcano', near: 'spires', sky: 'smoke', fx: 'embers', gap: 'lava' },
    summit: { tint: '#8a7cf0', far: 'alps', near: 'cairns', sky: 'clouds', fx: 'wind', gap: 'pit' }
  };
  // Surface colours (mid-tones that read on both themes) and texture glyphs.
  var MAT_COL = ['', '#c9a254', '#8a6240', '', '#3fb0d9', '#8b8278', '', '#a8743f'];
  var MAT_EDGE = [
    ['.', ':', '\'', '.', ',', ':', '`', '.'], ['.', ' ', ':', '.', ' ', '.', ':', ' '], ['~', '.', '~', ',', '~', '.', ' ', '~'], ['*', '.', ' ', '*', '.', ' ', '*', ' '],
    ['-', ' ', '.', ' ', '-', ' ', ' ', '.'], ['#', ' ', '.', ' ', '%', ' ', '.', ' '], ['-', '-', ' ', ' ', '-', '-', ' ', ' '], ['|', ' ', ' ', ' ', '|', ' ', ' ', ' ']
  ];
  var MAT_FLAT = ['_', '_', '~', '_', '=', '_', '=', '='];
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var sf = parseCol(v('--surface'), bg);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.dark = dark;
    S.base = { bg: bg, tx: tx, ac: ac };
    S.col = {
      bg: rgb(bg), bgA: rgb(bg, 0.9), surface: rgb(sf), text: rgb(tx), muted: rgb(mu), faint: rgb(fa), accent: rgb(ac),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      star: rgb(mix(bg, tx, 0.38)), cloud: rgb(mix(bg, tx, dark ? 0.17 : 0.2)),
      wheel: rgb(tx), rider: rgb(tx), ghost: rgb(mix(bg, ac, dark ? 0.7 : 0.75)), coin: rgb(mix(ac, tx, dark ? 0.05 : 0.15)),
      shadeLo: rgb(mix(bg, tx, 0.07)), night: dark ? 'rgba(0,0,0,0.62)' : 'rgba(12,14,34,0.55)'
    };
    S.thc = {}; S.tiles = {};
    fitFont();
  }
  // Location palette (cached per theme switch).
  function th(key) {
    var t = S.thc[key];
    if (t) return t;
    var L = LOC_THEME[key] || LOC_THEME.dust, B = S.base, bg = B.bg, tx = B.tx, tint = parseCol(L.tint, [200, 140, 60]), dark = S.dark;
    var gt = mix(tx, tint, dark ? 0.32 : 0.42);
    t = S.thc[key] = {
      key: key, L: L, tint: rgb(tint),
      far: rgb(mix(bg, tint, dark ? 0.3 : 0.26)), near: rgb(mix(bg, mix(tx, tint, 0.5), dark ? 0.26 : 0.22)),
      ground: rgb(gt), dirt: rgb(mix(bg, mix(tx, tint, 0.25), dark ? 0.26 : 0.24)), edge: rgb(mix(bg, mix(tx, tint, 0.3), dark ? 0.46 : 0.42)),
      sun: rgb(mix(bg, tint, dark ? 0.75 : 0.85)), rock: rgb(mix(bg, tx, dark ? 0.6 : 0.55)), wood: rgb(mix(mix(bg, tx, 0.62), [168, 116, 63], 0.45)),
      pit: rgb(mix(bg, tx, 0.5)), water: rgb([63, 167, 214]), waterA: 'rgba(63,167,214,' + (dark ? 0.3 : 0.24) + ')', lava: rgb([255, 96, 40]), lavaA: 'rgba(255,90,30,0.35)',
      ice: rgb(dark ? [150, 210, 240] : [60, 140, 190]), lit: rgb(mix(tint, [255, 230, 120], 0.5)),
      mat: MAT_COL.map(function (c, i) {
        if (i === 0) return rgb(gt);
        if (i === 3) return rgb(dark ? [214, 228, 240] : [110, 150, 182]);
        if (i === 6) return rgb(mix(tx, bg, dark ? 0.3 : 0.25));
        return rgb(mix(parseCol(c, gt), tx, dark ? 0.0 : 0.12));
      })
    };
    return t;
  }

  // ---- glyph metrics: each glyph's ink is centred on its anchor point ----
  var GLYPHS = '_-=/\\|oO0Q@#$%*+^~.:,\'`[]()<>xX!F★☆vVWYZ8{}?';
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
    S.tiles = {};
  }
  function font(px, wt) {
    var q = Math.max(8, Math.round(px * 4)), w8 = wt || 600, key = w8 * 1000 + q, f = S.fonts[key];
    if (!f) f = S.fonts[key] = w8 + ' ' + (q / 4) + 'px ' + S.col.font;
    return f;
  }
  // one glyph, ink centred at (x, y) — needs textAlign 'center', textBaseline 'alphabetic'
  function g1(c, ch, x, y, px) { var yy = y + (OFF[ch] == null ? 0.32 : OFF[ch]) * px; if (HALO) c.strokeText(ch, x, yy); c.fillText(ch, x, yy); }
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
  function tileFor(key) {
    if (!S || !S.col || !S.k || !S.ppm) return null;
    var tk = key + '|' + S.ppm + '|' + S.k, T = S.tiles[tk];
    if (T) return T;
    var k = S.k, ppm = S.ppm, cols = DIRT_ROWS[0].length, rows = DIRT_ROWS.length;
    var tw = cols * CW, thh = rows * ROW_M;
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(tw * ppm * k)); cv.height = Math.max(1, Math.round(thh * ppm * k));
    var c = cv.getContext('2d'), px = CW * ppm * k / S.adv;
    c.font = '600 ' + px.toFixed(2) + 'px ' + S.col.font;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = th(key).dirt;
    var sx = cv.width / cols, sy = cv.height / rows;
    for (var r = 0; r < rows; r++) for (var i = 0; i < cols; i++) {
      var ch = DIRT_ROWS[r].charAt(i);
      if (ch !== ' ') c.fillText(ch, (i + 0.5) * sx, (r + 0.5) * sy);
    }
    T = S.tiles[tk] = { pat: S.ctx.createPattern(cv, 'repeat'), s: cv.width / tw };
    return T;
  }

  // ---- background: cyclic ASCII skylines per location ----
  // A layer is n columns, each with a height (rows) and a glyph; vertical jumps
  // between columns are filled with '|' (cliffs, buildings).
  function layer(kind, seed, n) {
    var r = E.rnd, g = { s: seed }, h = new Int8Array(n), ch = [], i = 0, L = 0, up = true, k;
    function put(hh, c) { if (i < n) { h[i] = hh; ch[i] = c; i++; } }
    if (kind === 'mesa') {
      while (i < n) {
        for (k = 2 + Math.floor(r(g) * 8); k > 0; k--) put(0, '_');
        var H = 3 + Math.floor(r(g) * 5), Wd = 4 + Math.floor(r(g) * 12);
        for (k = 0; k < Wd; k++) put(H, '_');
      }
    } else if (kind === 'city') {
      while (i < n) {
        var bh = 3 + Math.floor(r(g) * 9), bw = 3 + Math.floor(r(g) * 5);
        for (k = 0; k < bw; k++) put(bh, k === 0 || k === bw - 1 ? '|' : '_');
        if (r(g) < 0.3) put(1, '_');
      }
    } else if (kind === 'volcano') {
      while (i < n) {
        for (k = 6 + Math.floor(r(g) * 14); k > 0; k--) put(r(g) < 0.3 ? 1 : 0, '_');
        var vh = 9 + Math.floor(r(g) * 4);
        for (k = 1; k <= vh; k++) put(k, '/');
        put(vh, '\\'); put(vh - 1, '_'); put(vh, '/');
        for (k = vh; k >= 1; k--) put(k, '\\');
      }
    } else {
      var maxH = kind === 'alps' ? 12 : kind === 'peaks' ? 9 : 4, pu = kind === 'hills' ? 0.2 : 0.12;
      while (i < n) {
        if (L === 0 && !up && r(g) < 0.45) { put(0, '_'); up = true; continue; }
        if (L >= maxH || (L > 0 && r(g) < (up ? pu : 0.08))) { if (up && L > 2 && kind !== 'hills') { put(L, '^'); } up = false; }
        else if (L === 0 || r(g) < (up ? 0.04 : 0.14)) up = true;
        if (up) { L++; put(L, '/'); } else { put(L, '\\'); L--; if (L < 0) L = 0; }
      }
    }
    return { h: h, c: ch, n: n, kind: kind };
  }
  var SPRITES = {
    cactus: [['  _ ', ' | |_', '_| |/', '\\  |', ' | |'], [' _', '| |', '| |']],
    pines: [['  ^', ' /|\\', '//|\\\\', '  |'], ['  ^', ' /^\\', '/ | \\', '  |']],
    snowpines: [['  *', ' /*\\', '/*|*\\', '  |'], ['  ^', ' /*\\', '  |']],
    docks: [['[==][==]', '[==][==][==]'], [' _', ' |*', ' |', ' |'], ['____', '|/ |', '|  !', '|', '|']],
    spires: [['  /\\', ' /  \\', '/    \\'], [' /\\', '/  \\']],
    cairns: [['  o', ' oOo', 'oOOOo'], ['  |>', '  |', ' _|_']]
  };
  var FARS = {}, NEARS = {};
  function farOf(k) { return FARS[k] || (FARS[k] = layer(k, 11 + k.length * 7, 320)); }
  function nearOf(k) { return NEARS[k] || (NEARS[k] = layer(k === 'alps' || k === 'peaks' ? 'hills' : 'hills', 29, 260)); }
  var CLOUD_BIG = ['   .-~~~-.', ' .(       ).', '(___________)'], CLOUD_SMALL = [' .--.', '(____)'];
  var CLOUDS = [[30, 0.12, 1], [210, 0.22, 0], [380, 0.08, 1], [560, 0.18, 0]], CLOUD_P = 700;
  var STARS = (function () { var g = { s: 7 }, a = []; for (var i = 0; i < 40; i++) a.push([E.rnd(g) * 900, E.rnd(g) * 0.5, E.rnd(g) < 0.2 ? '+' : E.rnd(g) < 0.5 ? '.' : '`']); return a; })();
  var SUN = [' \\ | /', '-- O --', ' / | \\'], MOON = ['  .-.', ' (  (', '  `-\''], SMOKE = ['  (  )', ' (    )', '(  )  )'];

  var V = { ppm: 30, ox: 0, oy: 0, x0: 0, x1: 0, y0: 0, y1: 0 };   // current world → screen view

  function drawSky(c, camx, camy, T) {
    var K = S.col, W = S.W, H = S.H, i, bcw = 8, px = bcw / S.adv, rowH = px * 0.92, L = T.L;
    var lift = clamp(camy * V.ppm * 0.05, -H * 0.18, H * 0.18), night = L.night || S.dark;
    textMode(c, px, 600);
    if (night) {
      c.fillStyle = K.star;
      for (i = 0; i < STARS.length; i++) {
        var sx = ((STARS[i][0] - camx * 1.5) % 900 + 900) % 900 - 100;
        if (sx > -8 && sx < W + 8) g1(c, STARS[i][2], sx, STARS[i][1] * H + lift * 0.3, px);
      }
    }
    c.textAlign = 'left'; c.textBaseline = 'middle';
    var art = L.sky === 'sun' ? SUN : L.sky === 'moon' ? MOON : L.sky === 'smoke' ? SMOKE : null;
    if (art) {
      c.fillStyle = L.sky === 'smoke' ? K.cloud : T.sun;
      for (var r0 = 0; r0 < art.length; r0++) c.fillText(art[r0], W * 0.74 - camx * 0.4 % 40, H * 0.1 + r0 * rowH + lift * 0.2);
    }
    c.fillStyle = K.cloud;
    if (L.sky !== 'moon') for (i = 0; i < CLOUDS.length; i++) {
      var cx = ((CLOUDS[i][0] - camx * 3) % CLOUD_P + CLOUD_P) % CLOUD_P - 120, cl = CLOUDS[i][2] ? CLOUD_BIG : CLOUD_SMALL;
      if (cx < W + 4) for (var r = 0; r < cl.length; r++) c.fillText(cl[r], cx, CLOUDS[i][1] * H + 14 + r * rowH + lift * 0.4);
    }
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    drawLayer(c, farOf(L.far), camx * 4, H * 0.5 + lift, T.far, bcw, px, rowH, L.far === 'city' ? T.lit : null);
    if (L.far === 'volcano') {                     // the caldera glows
      c.fillStyle = T.lava;
      var fl = farOf('volcano'), off = camx * 4, i0 = Math.floor(off / bcw);
      for (var j = 0; j < Math.ceil(W / bcw) + 2; j++) {
        var kk = ((i0 + j) % fl.n + fl.n) % fl.n;
        if (fl.c[kk] === '_' && fl.h[kk] > 4 && (Math.floor(S.time * 3 + j) & 1)) g1(c, '^', -(off - i0 * bcw) + j * bcw + bcw / 2, H * 0.5 + lift - fl.h[kk] * rowH, px);
      }
    }
    drawLayer(c, nearOf(L.far), camx * 9, H * 0.6 + lift * 1.4, T.near, bcw, px, rowH, null);
    drawSprites(c, L.near, camx * 14, H * 0.66 + lift * 1.6, T.near, px * 0.95, rowH);
  }
  function drawLayer(c, R, off, base, color, bcw, px, rowH, lit) {
    var n = Math.ceil(S.W / bcw) + 2, i0 = Math.floor(off / bcw), sx = -(off - i0 * bcw), N = R.n, prev = -1;
    c.fillStyle = color;
    for (var j = 0; j < n; j++) {
      var k = ((i0 + j) % N + N) % N, ch = R.c[k], h = R.h[k], x = sx + j * bcw + bcw / 2;
      if (!(ch === '_' && h === 0)) g1(c, ch, x, base - h * rowH, px);
      if (prev >= 0 && Math.abs(h - prev) > 1 && R.kind !== 'hills' && R.kind !== 'alps' && R.kind !== 'peaks') {
        var lo = Math.min(h, prev), hi = Math.max(h, prev), xe = x - bcw / 2;
        for (var q = lo + 1; q < hi; q++) g1(c, '|', xe, base - q * rowH + rowH * 0.4, px);
      }
      if (lit && h > 2 && ch === '_') {             // lit windows
        for (var q2 = 1; q2 < h - 1; q2 += 2) if (((k * 7 + q2 * 13) % 5) < 2) { c.fillStyle = lit; g1(c, ':', x, base - q2 * rowH, px * 0.8); c.fillStyle = color; }
      }
      prev = h;
    }
  }
  function drawSprites(c, kind, off, base, color, px, rowH) {
    var set = SPRITES[kind];
    if (!set) return;
    var gap = 90, i0 = Math.floor(off / gap);
    c.fillStyle = color; c.font = font(px, 600); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    for (var j = -1; j < Math.ceil(S.W / gap) + 2; j++) {
      var idx = i0 + j, hsh = ((idx * 2654435761) >>> 0), sp = set[hsh % set.length];
      if ((hsh >>> 8) % 3 === 0) continue;
      var x = idx * gap - off + ((hsh >>> 4) % 40);
      for (var r = 0; r < sp.length; r++) c.fillText(sp[r], x, base - (sp.length - 1 - r) * rowH);
    }
    c.textAlign = 'center';
  }
  // weather: screen-space particles, deterministic in time (no state)
  function drawWeather(c, T, camx) {
    var fx = T.L.fx, W = S.W, H = S.H, t = S.time, i, px = 10;
    if (!fx || fx === 'dust' || fx === 'wind') return;
    textMode(c, px, 600);
    if (fx === 'snow') {
      c.fillStyle = S.dark ? 'rgba(230,240,250,0.8)' : 'rgba(110,150,182,0.8)';
      for (i = 0; i < 46; i++) { var sx = ((i * 97 + t * (14 + (i % 5) * 4) * 0.6 - camx * 6) % W + W) % W, sy = ((i * 53 + t * (26 + (i % 7) * 5)) % H); g1(c, i % 3 ? '.' : '*', sx + Math.sin(t + i) * 6, sy, px); }
    } else if (fx === 'rain') {
      c.fillStyle = S.dark ? 'rgba(160,190,230,0.45)' : 'rgba(80,110,160,0.4)';
      for (i = 0; i < 60; i++) { var rx = ((i * 71 - t * 90 - camx * 8) % W + W) % W, ry = ((i * 37 + t * 420) % (H + 20)) - 10; g1(c, '/', rx, ry, px); }
    } else if (fx === 'embers') {
      c.fillStyle = T.lava;
      for (i = 0; i < 26; i++) { c.globalAlpha = 0.4 + 0.4 * Math.sin(t * 3 + i); var ex = ((i * 113 + Math.sin(t * 0.7 + i) * 20 - camx * 7) % W + W) % W, ey = H - ((i * 41 + t * (30 + i % 4 * 9)) % H); g1(c, i % 2 ? '.' : '\'', ex, ey, px); }
      c.globalAlpha = 1;
    } else if (fx === 'leaves') {
      c.fillStyle = T.near;
      for (i = 0; i < 12; i++) { var lx = ((i * 151 + t * 18 - camx * 7) % W + W) % W, ly = ((i * 67 + t * 22) % H); g1(c, i % 2 ? ',' : '`', lx + Math.sin(t * 2 + i) * 10, ly, px); }
    }
  }

  // ---- terrain ----
  var COLH = new Float64Array(1200), COLM = new Uint8Array(1200);
  function drawTerrain(c, w, T) {
    var Tr = w.ter, ppm = V.ppm, K = S.col, xs = Tr.xs, ys = Tr.ys, n = Tr.n, i;
    var xa = V.x0 - 1, xb = V.x1 + 1, i0 = E.segAt(Tr, xa), i1 = Math.min(n - 1, E.segAt(Tr, xb) + 1);
    // solid ground (hides the hills behind it) with the dirt pattern, clipped to the profile
    c.save();
    c.beginPath();
    c.moveTo(V.ox + xs[i0] * ppm, V.oy - ys[i0] * ppm);
    for (i = i0 + 1; i <= i1; i++) c.lineTo(V.ox + xs[i] * ppm, V.oy - ys[i] * ppm);
    c.lineTo(V.ox + xs[i1] * ppm, 1e5); c.lineTo(V.ox + xs[i0] * ppm, 1e5); c.closePath();
    c.fillStyle = K.bg; c.fill();
    fillPattern(c, T);
    c.restore();
    // the surface: one glyph per world column, picked by slope and surface, ink on the true line
    var fpx = CW * ppm / S.adv, rowPx = fpx * 0.9, j0 = Math.floor(xa / CW), j1 = Math.ceil(xb / CW), nc = Math.min(j1 - j0, COLH.length - 1), j, m = -1;
    for (j = 0; j <= nc; j++) { var xx = (j0 + j) * CW; COLH[j] = E.heightAt(Tr, xx); COLM[j] = Tr.mat[E.segAt(Tr, xx + CW / 2)]; }
    textMode(c, fpx, 700);
    for (j = 0; j < nc; j++) {
      var xl = (j0 + j) * CW, h0 = COLH[j], h1 = COLH[j + 1], d = (h1 - h0) / CW, mt = COLM[j];
      if (mt !== m) { m = mt; c.fillStyle = T.mat[mt]; }
      if (d < 0.7 && d > -0.7) {
        g1(c, MAT_FLAT[mt], V.ox + (xl + CW / 2) * ppm, V.oy - (h0 + h1) / 2 * ppm, fpx);
      } else {
        var ch = d > 2.4 || d < -2.4 ? '|' : d > 0 ? '/' : '\\', y0p = V.oy - h0 * ppm, y1p = V.oy - h1 * ppm;
        if ((y0p < -fpx && y1p < -fpx) || (y0p > S.H + fpx && y1p > S.H + fpx)) continue;
        var mm = Math.max(1, Math.round(Math.abs(y1p - y0p) / rowPx)), xm = V.ox + (xl + CW / 2) * ppm;
        if (mm > 60) mm = 60;
        for (var q = 0; q < mm; q++) {
          var t = (q + 0.5) / mm;
          g1(c, ch, ch === '|' ? xm : V.ox + (xl + CW * t) * ppm, y0p + (y1p - y0p) * t, fpx);
        }
      }
    }
    // a textured band just under the surface, per material
    m = -1;
    for (j = 0; j < nc; j++) {
      var dd = (COLH[j + 1] - COLH[j]) / CW;
      if (dd > 1.2 || dd < -1.2) continue;
      var mt2 = COLM[j];
      if (mt2 !== m) { m = mt2; c.fillStyle = mt2 ? T.mat[mt2] : T.edge; c.globalAlpha = mt2 ? 0.7 : 1; }
      var e = MAT_EDGE[mt2][((j0 + j) % 8 + 8) % 8];
      if (e !== ' ') g1(c, e, V.ox + ((j0 + j) * CW + CW / 2) * ppm, V.oy - (COLH[j] + COLH[j + 1]) / 2 * ppm + rowPx * 0.85, fpx);
    }
    c.globalAlpha = 1;
  }
  function fillPattern(c, T) {
    var tl = tileFor(T.key);
    if (!tl) return;
    c.clip();
    var s = S.k * V.ppm / tl.s, tx = V.ox * S.k, ty = V.oy * S.k;
    c.setTransform(s, 0, 0, s, tx, ty);
    c.fillStyle = tl.pat;
    c.fillRect(-tx / s, -ty / s, S.W * S.k / s, S.H * S.k / s);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
  }
  // tunnel ceilings: solid rock from the roof line up, '=' edge, the odd stalactite
  function drawRoofs(c, w, T) {
    var R = w.roofs, ppm = V.ppm, fpx = CW * ppm / S.adv;
    for (var i = 0; i < R.length; i++) {
      var r = R[i];
      if (r.x1 < V.x0 - 1 || r.x0 > V.x1 + 1) continue;
      var xa = Math.max(r.x0, V.x0 - 1), xb = Math.min(r.x1, V.x1 + 1), x;
      c.save();
      c.beginPath();
      c.moveTo(V.ox + xa * ppm, -10);
      for (x = xa; x <= xb + 1e-6; x += CW) c.lineTo(V.ox + x * ppm, V.oy - E.roofAt(w, Math.min(x, r.x1)) * ppm);
      c.lineTo(V.ox + xb * ppm, -10); c.closePath();
      c.fillStyle = S.col.bg; c.fill();
      fillPattern(c, T);
      c.restore();
      textMode(c, fpx, 700);
      c.fillStyle = T.ground;
      for (x = Math.ceil(xa / CW) * CW; x <= xb; x += CW) {
        var y = V.oy - E.roofAt(w, x) * ppm;
        g1(c, '=', V.ox + x * ppm, y - fpx * 0.2, fpx);
        if (((Math.round(x / CW) * 7) % 11) === 0) g1(c, 'v', V.ox + x * ppm, y + fpx * 0.6, fpx);
      }
      if (r.x0 >= V.x0 - 1) { var ry = V.oy - E.roofAt(w, r.x0) * ppm; for (var yy = ry; yy > -fpx; yy -= fpx * 0.85) g1(c, '|', V.ox + r.x0 * ppm, yy, fpx); }
    }
  }
  function drawWaters(c, w, T) {
    var Wt = w.waters, ppm = V.ppm, fpx = CW * ppm / S.adv;
    for (var i = 0; i < Wt.length; i++) {
      var p = Wt[i];
      if (p.x1 < V.x0 || p.x0 > V.x1) continue;
      var ly = V.oy - p.lvl * ppm;
      c.fillStyle = T.waterA;
      for (var x = p.x0; x < p.x1; x += CW) {
        var gy = E.heightAt(w.ter, x + CW / 2);
        if (gy < p.lvl) c.fillRect(V.ox + x * ppm, ly, CW * ppm + 0.5, (p.lvl - gy) * ppm);
      }
      textMode(c, fpx, 700);
      c.fillStyle = T.water;
      for (x = p.x0; x < p.x1; x += CW) if (E.heightAt(w.ter, x + CW / 2) < p.lvl - 0.05) g1(c, (Math.floor(x / CW + S.time * 4) & 1) ? '~' : '-', V.ox + (x + CW / 2) * ppm, ly, fpx);
    }
  }

  // ---- decorations, set pieces and zones ----
  function pole(c, x, y, hM, px) {
    var top = V.oy - (y + hM) * V.ppm, bot = V.oy - y * V.ppm, step = px * 0.85, sxp = V.ox + x * V.ppm;
    for (var yy = bot - step * 0.5; yy > top; yy -= step) g1(c, '|', sxp, yy, px);
    return top;
  }
  var SIGN_TXT = ['', 'jump', 'drop', 'tunnel', 'ice', 'rocks', 'water'];
  function drawDecos(c, w, front, T) {
    var D = w.decos, ppm = V.ppm, K = S.col, px = CW * ppm / S.adv, i, gs = T.L.gap;
    textMode(c, px, 700);
    for (i = 0; i < D.length; i++) {
      var d = D[i];
      if (d.x > V.x1 + 6) break;
      var xEnd = d.k === 'gap' || d.k === 'tunnel' || d.k === 'tzone' ? d.a : d.k === 'rock' ? d.x + d.a : d.k === 'wind' ? d.x + d.a : d.x + 4;
      if (xEnd < V.x0 - 3) continue;
      var sxp = V.ox + d.x * ppm, y, top;
      if (!front) {
        if (d.k === 'start' || d.k === 'finish' || d.k === 'cp' || d.k === 'sign' || d.k === 'biome' || d.k === 'wind') {
          y = E.heightAt(w.ter, d.x);
          var lit = d.k === 'cp' && w.cpX >= d.x - 1e-6 && w.cpi > 0;
          c.fillStyle = lit ? K.accent : d.k === 'sign' || d.k === 'wind' ? K.muted : T.ground;
          top = pole(c, d.x, y, d.k === 'sign' ? 1.3 : d.k === 'cp' ? 1.9 : d.k === 'wind' ? 2.2 : 2.5, px);
          if (d.k === 'cp') {
            g1(c, '\\', sxp + px * S.adv, top + px * 0.45, px);
            g1(c, '/', sxp + px * S.adv, top + px * 1.25, px);
          } else if (d.k === 'sign') {
            c.fillStyle = K.text;
            label(c, '/!\\', sxp, top - px * 0.25, px * 0.95, 800);
            if (d.a) { c.fillStyle = K.muted; label(c, SIGN_TXT[d.a] || '', sxp + px * S.adv * 2, top - px * 0.25, px * 0.75, 700, 'left'); }
            textMode(c, px, 700);
          } else if (d.k === 'wind') {
            c.fillStyle = K.accent;
            var sk = d.b > 0 ? '>' : '<', sw = Math.sin(S.time * 8) * 0.15;
            for (var q0 = 1; q0 <= 3; q0++) g1(c, q0 === 3 ? sk : '=', sxp + (d.b > 0 ? 1 : -1) * q0 * px * S.adv * 0.9, top + px * (0.4 + sw * q0), px);
            c.fillStyle = K.muted; label(c, 'WIND', sxp, top - px * 0.6, px * 0.7, 700);
            textMode(c, px, 700);
          } else if (d.k === 'start' || d.k === 'biome') {
            var txt = d.k === 'start' ? 'START' : E.LOCS[d.a].name.toUpperCase(), bw = txt.length * px * 0.8 * S.adv + px;
            c.fillStyle = K.bgA; c.fillRect(sxp - bw / 2, top - px * 1.3, bw, px * 1.2);
            c.fillStyle = K.text; label(c, txt, sxp, top - px * 0.7, px * 0.8, 700);
            textMode(c, px, 700);
          } else {
            c.fillStyle = K.text;
            for (var r = 0; r < 3; r++) for (var q = 0; q < 4; q++) if ((r + q) % 2 === 0) g1(c, '#', sxp + (q + 0.8) * px * S.adv, top + r * px * 0.75 + px * 0.3, px);
            label(c, 'FINISH', sxp + px * 2.2 * S.adv, top - px * 0.6, px * 0.8, 700);
            textMode(c, px, 700);
          }
        } else if (d.k === 'gap') {
          var fl = Math.min(d.y, d.b) - 16, fy = V.oy - fl * ppm - px * 0.5, rim = V.oy - (Math.min(d.y, d.b) - 1.6) * ppm;
          if (gs === 'water' || gs === 'lava') {
            // a liquid surface a little below the rim, filled down to the floor
            c.fillStyle = gs === 'water' ? T.waterA : T.lavaA;
            c.fillRect(V.ox + d.x * ppm, rim, (d.a - d.x) * ppm, Math.max(0, fy - rim + px));
            c.fillStyle = gs === 'water' ? T.water : T.lava;
            for (var gx0 = d.x + 0.2; gx0 < d.a - 0.1; gx0 += CW) g1(c, (Math.floor(gx0 / CW + S.time * (gs === 'lava' ? 2 : 4)) & 1) ? '~' : (gs === 'lava' ? '^' : '-'), V.ox + gx0 * ppm, rim, px);
          } else if (fy < S.H + px && fy > -px) {
            c.fillStyle = gs === 'crevasse' ? T.ice : T.pit;
            for (var gx = d.x + 0.3; gx < d.a - 0.2; gx += CW) g1(c, gs === 'crevasse' ? 'V' : '^', V.ox + gx * ppm, fy, px);
          }
        } else if (d.k === 'tzone') {
          var tx0 = d.x, tx1 = d.a;
          [tx0, tx1].forEach(function (bx, bi) {
            if (bx < V.x0 - 3 || bx > V.x1 + 3) return;
            var by = E.heightAt(w.ter, bx);
            c.fillStyle = K.accent;
            var tp = pole(c, bx, by, 3, px);
            label(c, bi ? '★ END' : '★ TRICK ZONE x2', V.ox + bx * ppm, tp - px * 0.6, px * 0.8, 800);
            textMode(c, px, 700);
          });
          // the judges' booth, half way along
          var jx = (tx0 + tx1) / 2;
          if (jx > V.x0 - 3 && jx < V.x1 + 3) {
            var jy = V.oy - (E.heightAt(w.ter, jx) + 0.1) * ppm - px * 2.6;
            c.fillStyle = K.muted;
            label(c, 'o o o', V.ox + jx * ppm, jy, px * 0.9, 800);
            label(c, '[_____]', V.ox + jx * ppm, jy + px * 0.9, px * 0.9, 700);
            label(c, 'JUDGES', V.ox + jx * ppm, jy - px * 0.9, px * 0.6, 700);
            textMode(c, px, 700);
          }
        }
      } else if (d.k === 'log') {
        var lp2 = Math.max(8, d.a * 1.3 * ppm), cy = V.oy - d.y * ppm;
        c.fillStyle = K.bg;
        c.fillRect(sxp - lp2 * S.adv * 1.4, cy - lp2 * 0.42, lp2 * S.adv * 2.8, lp2 * 0.84);
        c.fillStyle = T.wood;
        label(c, '(@)', sxp, cy, lp2, 800);
        textMode(c, px, 700);
      } else if (d.k === 'rock') {
        c.fillStyle = T.rock;
        for (var xx = d.x + CW * 0.6; xx < d.x + d.a - CW * 0.3; xx += CW) {
          var top2 = E.heightAt(w.ter, xx) - ROW_M * 0.45;
          for (var yy = top2; yy > d.y + 0.05; yy -= ROW_M * 0.75) g1(c, (Math.round(xx * 7 + yy * 3) & 1) ? '#' : '%', V.ox + xx * ppm, V.oy - yy * ppm, px * 0.85);
        }
      } else if (d.k === 'spring') {
        var sy = V.oy - d.y * ppm, sq = w.springCd > 0.3 && Math.abs(w.c.x - d.x) < 4;
        c.fillStyle = K.accent;
        label(c, sq ? '/===\\' : '=====', sxp, sy - px * (sq ? 1.1 : 0.7), px, 800);
        c.fillStyle = K.muted;
        label(c, 'ZZZ', sxp, sy - px * 0.15, px * 0.7, 800);
        textMode(c, px, 700);
      }
    }
    if (front) drawZones(c, w, T);
  }
  function drawZones(c, w, T) {
    var Z = w.zones, ppm = V.ppm, px = CW * ppm / S.adv, K = S.col, i, x;
    textMode(c, px, 800);
    for (i = 0; i < Z.length; i++) {
      var z = Z[i];
      if (z.x0 > V.x1 + 2) break;
      if (z.x1 < V.x0 - 2) continue;
      if (z.k === 'boost') {
        for (x = z.x0 + 0.2; x < z.x1; x += 0.55) {
          var ph = (Math.floor(x / 0.55 - S.time * 10) % 4 + 4) % 4;
          c.fillStyle = ph === 0 ? K.text : K.accent; c.globalAlpha = ph === 0 ? 1 : 0.7;
          g1(c, '>', V.ox + x * ppm, V.oy - (E.heightAt(w.ter, x) + 0.12) * ppm, px);
        }
        c.globalAlpha = 1;
      } else if (z.k === 'wind') {
        c.fillStyle = K.muted; c.globalAlpha = 0.6;
        var span = z.x1 - z.x0, dir = z.f > 0 ? 1 : -1;
        for (var k = 0; k < 14; k++) {
          var fx = z.x0 + (((k * 7.3 + S.time * 9 * dir) % span) + span) % span, gy = E.heightAt(w.ter, fx) + 1 + (k * 1.7 % 5);
          if (fx < V.x0 || fx > V.x1) continue;
          g1(c, k % 3 ? '-' : '~', V.ox + fx * ppm, V.oy - gy * ppm, px);
          g1(c, '-', V.ox + (fx - dir * 0.35) * ppm, V.oy - gy * ppm, px);
        }
        c.globalAlpha = 1;
      }
    }
  }
  // crates, boulders, pickups
  var COIN_SPIN = ['O', '0', 'o', '|', 'o', '0'];
  function drawObjects(c, w, T) {
    var ppm = V.ppm, K = S.col, i, px = CW * ppm / S.adv;
    // crates
    for (i = 0; i < w.crates.length; i++) {
      var k = w.crates[i];
      if (!k.on || k.x < V.x0 - 1 || k.x > V.x1 + 1) continue;
      var cy = V.oy - (k.y + 0.3) * ppm, cs = 0.62 * ppm;
      c.fillStyle = K.bg; c.fillRect(V.ox + k.x * ppm - cs / 2, cy - cs / 2, cs, cs);
      c.fillStyle = T.wood;
      label(c, '[X]', V.ox + k.x * ppm, cy, cs * 0.75 / S.adv / 1.5 * 1.4, 800);
    }
    // boulders: perched on a ledge, falling (with a blinking shadow), gone
    for (i = 0; i < w.rocks.length; i++) {
      var r = w.rocks[i];
      if (r.st === 2 || r.x < V.x0 - 2 || r.x > V.x1 + 2) continue;
      var rx = V.ox + r.x * ppm, ry = V.oy - r.y * ppm;
      if (r.st === 0) { c.fillStyle = T.rock; label(c, '_/^\\_', rx, ry + 0.5 * ppm, px, 700); }
      else if (Math.floor(S.time * 8) & 1) { c.fillStyle = K.accent; label(c, 'v v', rx, V.oy - (E.heightAt(w.ter, r.x) + 0.2) * ppm, px, 800); }
      c.fillStyle = T.rock;
      label(c, '@', rx, ry, 0.95 * ppm / 0.9, 800);
    }
    textMode(c, px, 700);
    // coins and fuel cans
    var it = w.items, ph = S.time * 9, ipx = 0.5 * ppm / S.adv * 0.62;
    textMode(c, ipx, 800);
    for (i = 0; i < it.length; i++) {
      var o = it[i];
      if (o.x > V.x1 + 1) break;
      if (!o.on || o.x < V.x0 - 1) continue;
      var sxp = V.ox + o.x * ppm, syp = V.oy - o.y * ppm + Math.sin(ph * 0.4 + o.x) * 2;
      if (o.k) {
        c.fillStyle = K.text;
        g1(c, '[', sxp - ipx * S.adv, syp, ipx); g1(c, ']', sxp + ipx * S.adv, syp, ipx);
        c.fillStyle = K.accent; g1(c, 'F', sxp, syp, ipx);
      } else {
        c.fillStyle = K.coin;
        g1(c, COIN_SPIN[((Math.floor(ph + o.x * 1.7) % 6) + 6) % 6], sxp, syp, ipx);
      }
    }
  }

  // ---- machines and riders ----
  var POSE = new Float64Array(12), BP = new Float64Array(48);
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
  var TREAD = ['o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.', 'o', '.'];
  function drawWheel(c, x, y, th, R, ppm, color, hubColor, simple) {
    var r = R * ppm * 0.82, px = Math.max(7, 0.25 * ppm), n = simple ? 8 : R > 0.55 ? 16 : 12, j;
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
  function lookCols(look) {
    var K = S.col, p = E.find(E.PAINTS, look && look.paint) || E.PAINTS[0], j = E.find(E.PAINTS, look && look.jersey) || E.PAINTS[8];
    var paint = p.col ? p.col : K.accent, jersey = j.col ? j.col : K.text;
    return { frame: paint, frameLo: rgb(mix(parseCol(paint, S.base.ac), S.base.tx, 0.45)), jersey: jersey,
      helmet: (E.find(E.HELMETS, look && look.helmet) || E.HELMETS[0]).g, acc: (look && look.acc) || 'none' };
  }
  // Draw a machine + rider. o: { P, x, y, a, wheels [rx, ry, rth, fx, fy, fth] (screen), lean, pose, poseK,
  // rag (world rag + prev + alpha) or null, cols (lookCols), ghost (mono colour), alpha }
  function drawRig(c, o) {
    var P = o.P, ppm = V.ppm, K = S.col, cl = o.cols, mono = o.mono, fr = mono || cl.frame, frLo = mono || cl.frameLo, body = mono || cl.jersey, ink = mono || K.wheel;
    _ca = Math.cos(o.a); _sa = Math.sin(o.a); _bx = o.x; _by = o.y;
    var Wv = o.wheels, px = Math.max(8, 0.31 * ppm), step = px * S.adv * 0.92, i;
    if (o.alpha != null) c.globalAlpha = o.alpha;
    drawWheel(c, Wv[0], Wv[1], Wv[2], P.wr[0], ppm, ink, mono || K.muted, !!o.simple);
    drawWheel(c, Wv[3], Wv[4], Wv[5], P.wr[1], ppm, ink, mono || K.muted, !!o.simple);
    textMode(c, px, 700);
    BP[14] = Wv[0]; BP[15] = Wv[1]; BP[16] = Wv[3]; BP[17] = Wv[4];   // 7 rear axle, 8 front axle
    if (P.kind === 'bike') {
      lp(0, -0.06, -0.16); lp(1, -0.90, 0.47); lp(2, 0.06, 0.50); lp(3, 0.47, 0.60); lp(4, 0.36, 0.86);
      c.fillStyle = frLo;
      seg(c, 0, 7, step, px, true);                         // swing-arm
      seg(c, 3, 8, step, px, false);                        // fork
      c.fillStyle = fr;
      seg(c, 1, 2, step, px, true);                         // seat
      seg(c, 2, 3, step, px, true);                         // tank
      seg(c, 3, 4, step * 0.8, px, false);                  // bars
      c.fillStyle = mono || K.muted;                        // engine block [#] (a battery [=] on the Phantom)
      var eng = P.key === 'phantom' ? '=' : '#';
      lp(5, -0.14, 0.04); g1(c, '[', BP[10], BP[11], px);
      lp(5, 0.04, 0.04); g1(c, eng, BP[10], BP[11], px);
      lp(5, 0.22, 0.04); g1(c, ']', BP[10], BP[11], px);
    } else {
      // struts: anchor → axle
      lp(20, P.ax[0], P.ay[0] + (P.kind === 'truck' ? 0.22 : 0.1)); lp(21, P.ax[1], P.ay[1] + (P.kind === 'truck' ? 0.22 : 0.1));
      c.fillStyle = frLo;
      seg(c, 20, 7, step, px, false); seg(c, 21, 8, step, px, false);
    }
    if (P.kind === 'car') {
      lp(0, -1.35, 0.2); lp(1, 1.45, 0.16); lp(2, -0.72, 0.22); lp(3, -0.52, 0.95); lp(4, 0.42, 0.95); lp(5, 0.82, 0.26); lp(6, 1.45, 0.3);
      c.fillStyle = frLo;
      seg(c, 0, 1, step, px, true);                         // floor pan
      c.fillStyle = fr;
      seg(c, 2, 3, step, px, false); seg(c, 3, 4, step, px, true); seg(c, 4, 5, step, px, false); seg(c, 5, 6, step, px, true);   // cage, hood
      c.fillStyle = mono || K.muted;
      lp(19, -1.1, 0.42); g1(c, '#', BP[38], BP[39], px);
    } else if (P.kind === 'truck') {
      lp(0, -1.62, 0.42); lp(1, 1.62, 0.42); lp(2, -1.62, 0.95); lp(3, 0.25, 0.95); lp(4, 0.45, 1.42); lp(5, -0.6, 1.42); lp(6, 1.62, 0.95);
      c.fillStyle = frLo;
      seg(c, 0, 1, step, px, true);                         // frame rails
      c.fillStyle = fr;
      seg(c, 0, 2, step, px, false); seg(c, 2, 6, step, px, true); seg(c, 1, 6, step, px, false);   // body box
      seg(c, 5, 4, step, px, true); seg(c, 3, 4, step, px, false);                                 // cab
      c.fillStyle = mono || K.muted;
      lp(19, -1.0, 0.68); g1(c, '#', BP[38], BP[39], px); lp(19, 1.1, 0.68); g1(c, '#', BP[38], BP[39], px);
    }
    // rider (posed, or the ragdoll after a crash)
    var crashed = !!o.rag, head = 18;
    if (crashed) {
      var R = o.rag.R, Pp = o.rag.P, al = o.rag.al;
      for (i = 0; i < E.RAG_N; i++) {
        BP[18 + i * 2] = V.ox + lerp(Pp[i * 2], R[i * 4], al) * ppm;
        BP[19 + i * 2] = V.oy - lerp(Pp[i * 2 + 1], R[i * 4 + 1], al) * ppm;
      }
    } else if (P.kind === 'bike') {
      E.riderPose(o.lean, POSE, o.pose, o.poseK);
      for (var j = 0; j < 6; j++) lp(9 + j, POSE[j * 2], POSE[j * 2 + 1]);
    } else {
      var lx = 0.08 * o.lean, sx = P.kind === 'car' ? -0.05 : 0.0, sy = P.kind === 'car' ? 0.62 : 1.15;
      lp(9, sx + lx, sy + 0.18); lp(10, sx + lx * 0.5, sy - 0.05); lp(11, sx - 0.15, sy - 0.35); lp(12, sx + 0.35, sy - 0.12); lp(13, sx + 0.2, sy - 0.35); lp(14, sx + 0.4, sy - 0.5);
    }
    // joints: 9 head, 10 shoulder, 11 hip, 12 hand, 13 knee, 14 foot
    c.fillStyle = body;
    if (P.kind === 'bike' || crashed) {
      seg(c, 11, 13, step, px, false);                    // thigh
      seg(c, 13, 14, step, px, false);                    // shin
    }
    seg(c, 10, 11, step, px, false);                      // torso
    seg(c, 10, 12, step, px, false);                      // arm
    if (!crashed && !mono) drawAcc(c, cl.acc, o, px, fr);
    var hp = px * (P.kind === 'bike' || crashed ? 1.45 : 1.15);
    textMode(c, hp, 800);
    c.fillStyle = fr;
    g1(c, crashed ? 'X' : cl.helmet, BP[head], BP[head + 1], hp);
    if (o.alpha != null) c.globalAlpha = 1;
  }
  // accessories hang off the head / shoulders, in screen space behind the rider
  function drawAcc(c, acc, o, px, col) {
    if (acc === 'none') return;
    var hx = BP[18], hy = BP[19], sx = BP[20], sy = BP[21], t = S.time, sp = clamp(Math.abs(o.speed || 0) / 12, 0.2, 1), i;
    var bx = -_ca, by = _sa;                              // screen direction of chassis-backwards
    textMode(c, px, 800);
    if (acc === 'scarf') {
      c.fillStyle = col;
      for (i = 1; i <= 3; i++) g1(c, '~', sx + bx * px * 0.7 * i * sp + 0, sy - by * px * 0.7 * i * sp + Math.sin(t * 14 + i) * px * 0.25, px);
    } else if (acc === 'cape') {
      c.fillStyle = col;
      for (i = 1; i <= 3; i++) g1(c, i === 3 ? '>' : '}', sx + bx * px * 0.6 * i, sy - by * px * 0.6 * i + px * 0.3 * i * (1 - sp) + Math.sin(t * 10 + i) * px * 0.2, px * 1.2);
    } else if (acc === 'mohawk') {
      c.fillStyle = col; g1(c, '^', hx - _sa * px * 0.0, hy - px * 0.9, px);
    } else if (acc === 'flag') {
      lp(20, -0.85, 0.5); lp(21, -0.95, 1.6);
      c.fillStyle = S.col.muted; seg(c, 20, 21, px * S.adv * 0.92, px, false);
      c.fillStyle = col; g1(c, '>', BP[42] + px * 0.5, BP[43] + Math.sin(t * 9) * 2, px);
    } else if (acc === 'antlers') {
      c.fillStyle = S.col.muted; g1(c, 'Y', hx - px * 0.6, hy - px * 0.8, px); g1(c, 'Y', hx + px * 0.6, hy - px * 0.8, px);
    } else if (acc === 'crown') {
      c.fillStyle = col; g1(c, 'W', hx, hy - px * 1.05, px);
    } else if (acc === 'wings') {
      c.fillStyle = col; g1(c, '{', sx + bx * px * 0.6, sy - by * px * 0.6 - px * 0.3 + Math.sin(t * 12) * 2, px * 1.3); g1(c, '<', sx + bx * px * 1.3, sy - by * px * 1.3 - px * 0.5, px * 1.2);
    }
  }
  // a live world's rig, interpolated between physics steps
  var WV = new Float64Array(6);
  function drawWorldRig(c, w, al, cols, mono, alpha) {
    var C = w.c, rw = w.wh[0], fw = w.wh[1], ppm = V.ppm;
    WV[0] = V.ox + lerp(rw.px, rw.x, al) * ppm; WV[1] = V.oy - lerp(rw.py, rw.y, al) * ppm; WV[2] = lerp(rw.pth, rw.th, al);
    WV[3] = V.ox + lerp(fw.px, fw.x, al) * ppm; WV[4] = V.oy - lerp(fw.py, fw.y, al) * ppm; WV[5] = lerp(fw.pth, fw.th, al);
    var crashed = w.state === 'crash' || w.state === 'over';
    drawRig(c, { P: w.P, x: lerp(C.px, C.x, al), y: lerp(C.py, C.y, al), a: lerp(C.pa, C.a, al), wheels: WV, lean: lerp(w.plean, w.lean, al),
      pose: lerp(w.ppose, w.pose, al), poseK: w.poseK, rag: crashed ? { R: w.rag, P: w.ragP, al: al } : null, cols: cols, mono: mono, alpha: alpha, speed: C.vx });
  }
  // the ghost: chassis + lean/pose from the recording; wheels at their loaded length
  var GQ = new Float64Array(5), GHOST_COLS = { frame: '', frameLo: '', jersey: '', helmet: 'O', acc: 'none' };
  function drawGhostRig(c, P, g, tag) {
    var gx = g[0], gy = g[1], ga = g[2], crashed = g[3] === 9;
    if (gx < V.x0 - 3 || gx > V.x1 + 3) return false;
    var ca = Math.cos(ga), sa = Math.sin(ga);
    for (var i = 0; i < 2; i++) {
      var lx = P.ax[i] + P.dx[i] * P.stat[i], ly = P.ay[i] + P.dy[i] * P.stat[i];
      WV[i * 3] = V.ox + (gx + ca * lx - sa * ly) * V.ppm; WV[i * 3 + 1] = V.oy - (gy + sa * lx + ca * ly) * V.ppm; WV[i * 3 + 2] = -gx / P.wr[i];
    }
    var pk = Math.floor(g[4] / 2), pz = g[4] - pk * 2;
    drawRig(c, { P: P, x: gx, y: gy, a: ga, wheels: WV, lean: crashed ? 0 : g[3], pose: crashed ? 0 : pz, poseK: clamp(pk, 0, 2), rag: null, cols: GHOST_COLS, mono: S.col.ghost, alpha: crashed ? 0.25 : 0.55, simple: false });
    if (tag) {
      c.fillStyle = S.col.ghost; c.globalAlpha = 0.85;
      label(c, tag, V.ox + gx * V.ppm, V.oy - (gy + 2.2) * V.ppm, Math.max(9, 0.3 * V.ppm), 800);
      c.globalAlpha = 1;
    }
    return true;
  }

  // ---- particles (render-side only): dust from the rear wheel, splashes, rock shards, sparks ----
  var DN = 48, DX = new Float32Array(DN), DY = new Float32Array(DN), DVX = new Float32Array(DN), DVY = new Float32Array(DN), DL = new Float32Array(DN), DK = new Uint8Array(DN);
  var DUST = ['.', ',', '\'', '`', '.'], dustI = 0, dustAcc = 0;
  function spawn(k, x, y, vx, vy, life) { var i = dustI++ % DN; DX[i] = x; DY[i] = y; DVX[i] = vx; DVY[i] = vy; DL[i] = life; DK[i] = k; }
  function burst(k, x, y, n, sp) { var g = S.rng; for (var i = 0; i < n; i++) spawn(k, x, y, (E.rnd(g) - 0.5) * sp, E.rnd(g) * sp * 0.8 + 1, 0.5 + E.rnd(g) * 0.4); }
  function fxStep(w, dt) {
    for (var i = 0; i < DN; i++) if (DL[i] > 0) { DL[i] -= dt; DX[i] += DVX[i] * dt; DY[i] += DVY[i] * dt; DVY[i] -= (DK[i] === 3 ? -1 : 6) * dt; }
    var rw = w.wh[0];
    if (w.state !== 'ride' || !w.inGas || !rw.touch) return;
    var sp = Math.abs(w.c.vx);
    dustAcc += dt * (10 + sp * 2.2) * (rw.mat === 6 ? 0.3 : 1);
    while (dustAcc > 1) {
      dustAcc -= 1;
      var g = S.rng;
      spawn(rw.mat === 3 || rw.mat === 4 ? 2 : rw.mat === 2 ? 4 : 0, rw.x - 0.2 + (E.rnd(g) - 0.5) * 0.3, rw.y - w.P.wr[0] * 0.8, -w.c.vx * 0.25 - 0.5 - E.rnd(g) * 1.2, 0.6 + E.rnd(g) * 1.8 + sp * 0.04, 0.35 + E.rnd(g) * 0.35);
    }
  }
  var PCH = [DUST, ['~', '.', '\'', '~', ','], ['*', '.', '*', '\'', '.'], ['>', '-', '=', '-', '>'], ['~', ',', '.', '~', '.'], ['#', '%', '.', '#', ',']];
  function drawDust(c, T) {
    var ppm = V.ppm, px = CW * ppm / S.adv;
    textMode(c, px, 700);
    for (var i = 0; i < DN; i++) {
      if (DL[i] <= 0) continue;
      var k = DK[i];
      c.fillStyle = k === 1 ? T.water : k === 2 ? T.mat[3] : k === 3 ? S.col.accent : k === 4 ? T.mat[2] : k === 5 ? T.rock : T.edge;
      c.globalAlpha = Math.min(1, DL[i] * 2.4);
      g1(c, PCH[k][i % 5], V.ox + DX[i] * ppm, V.oy - DY[i] * ppm, px);
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
  // same, left-aligned at x; returns the right edge
  function numL(c, v, dec, x, y, px) {
    var m = dec === 2 ? 100 : dec === 1 ? 10 : 1, n = Math.round(Math.abs(v) * m), d = 1;
    while (n >= 10) { n = Math.floor(n / 10); d++; }
    if (d < dec + 1) d = dec + 1;
    var right = x + (d + (dec ? 1 : 0)) * px * S.adv;
    num(c, v, dec, right, y, px);
    return right;
  }
  var POPS = [], POP_N = 5;
  function pop(s, kind) {
    if (!S) return;
    var p = POPS.length < POP_N ? {} : POPS.shift();
    p.s = s; p.t = 0; p.life = kind === 'big' ? 1.6 : 1.25; p.kind = kind || '';
    POPS.push(p);
  }
  var PLACES = ['', '1ST', '2ND', '3RD', '4TH', '5TH'];
  function drawHud(c, w) {
    var K = S.col, W = S.W, H = S.H, px = clamp(H * 0.05, 11, 16), pad = 10, y = pad + px * 0.6, x, k, run = S.run, sm = px * 0.82;
    HALO = true; c.strokeStyle = K.bg; c.lineWidth = 3.5; c.lineJoin = 'round';
    c.font = font(px * 1.25, 800); c.fillStyle = K.text;
    if (w.mode === 'stage') {
      var tShow = run.kind === 'event' && run.ev.type !== 'time' ? w.t : Math.max(0, w.state === 'finish' ? w.final : w.t - w.bonus);
      numL(c, tShow, 2, pad, y, px * 1.25);
      c.fillStyle = K.muted;
      label(c, S.hudSub, pad, y + px * 1.2, sm, 600, 'left');
      // progress: [=====>------]
      var cells = Math.max(8, Math.min(24, Math.floor((W - 2 * pad) * 0.42 / (px * 0.8 * S.adv)))), cw = px * 0.8 * S.adv;
      var span = w.finishX, f = clamp(w.c.x / span, 0, 1), bx = W - pad - cells * cw, pos = Math.round(f * (cells - 1));
      textMode(c, px * 0.8, 700);
      c.fillStyle = K.muted;
      g1(c, '[', bx - cw * 0.5, y, px * 0.8); g1(c, ']', bx + cells * cw + cw * 0.5 - cw, y, px * 0.8);
      for (k = 0; k < cells - 1; k++) {
        var cx = bx + k * cw + cw * 0.5, cpk = false;
        for (var q = 0; q < w.cps.length; q++) if (Math.round(w.cps[q] / span * (cells - 1)) === k) cpk = true;
        c.fillStyle = k < pos ? K.accent : cpk ? K.muted : K.faint;
        g1(c, k === pos ? '>' : cpk ? '+' : k < pos ? '=' : '-', cx, y, px * 0.8);
      }
      label(c, S.hudStage, W - pad, y + px * 1.2, sm, 600, 'right');
      // third line: race position, or ghost lead
      var y3 = y + px * 2.3;
      if (S.rivals.length) {
        var place = racePlace();
        c.fillStyle = place === 1 ? K.accent : K.text;
        label(c, PLACES[place] || place + 'TH', pad, y3 + px * 0.2, px * 1.15, 800, 'left');
        c.fillStyle = K.muted;
        label(c, 'of ' + (S.rivals.length + 1), pad + px * 1.15 * S.adv * 4, y3 + px * 0.25, sm, 600, 'left');
      } else if (ghostOn(w)) {
        var lead = E.ghostLead(S.ghost.data, w.t, w.c.x), la = Math.abs(lead), gdec = la < 9.95 ? 1 : 0;
        if (lead === lead) {
          c.fillStyle = K.muted;
          label(c, S.ghost.tag.toLowerCase(), pad, y3, sm, 600, 'left');
          var ahead = Math.round(la * (gdec ? 10 : 1)) === 0 || lead > 0;
          c.fillStyle = ahead ? K.accent : K.text;
          x = pad + sm * S.adv * (S.ghost.tag.length + 1);
          label(c, ahead ? '+' : '-', x, y3, sm, 700, 'left');
          x = numL(c, la, gdec, x + sm * S.adv, y3, sm);
          label(c, 'm', x + sm * S.adv * 0.15, y3, sm, 700, 'left');
        }
      }
    } else {
      x = numL(c, Math.floor(w.dist), 0, pad, y, px * 1.25);
      label(c, 'm', x + px * S.adv * 0.3, y, px * 0.9, 700, 'left');
      c.fillStyle = K.muted;
      label(c, S.hudSub, pad, y + px * 1.2, sm, 600, 'left');
      c.fillStyle = K.muted;
      label(c, 'coins', W - pad, y, sm, 600, 'right');
      c.fillStyle = K.coin; c.font = font(px * 1.25, 800);
      num(c, w.coins, 0, W - pad - sm * S.adv * 6, y, px * 1.25);
      var low = w.fuel < 0.22, blink = low && (Math.floor(S.time * 4) & 1);
      c.fillStyle = low ? K.accent : K.muted;
      label(c, 'FUEL', W - pad - 11 * px * 0.75 * S.adv, y + px * 1.25, px * 0.75, 700, 'right');
      textMode(c, px * 0.75, 700);
      for (k = 0; k < 10; k++) {
        c.fillStyle = k < Math.ceil(w.fuel * 10) ? (blink ? K.faint : low ? K.accent : K.text) : K.faint;
        g1(c, k < Math.ceil(w.fuel * 10) ? '#' : '-', W - pad - (10 - k) * px * 0.75 * S.adv + px * 0.37 * S.adv, y + px * 1.25, px * 0.75);
      }
    }
    // style score (right, third line) and the live combo (centre)
    c.fillStyle = K.muted;
    label(c, 'style', W - pad - px * S.adv * 7.2, y + px * 2.4, sm, 600, 'right');
    c.fillStyle = K.text; c.font = font(px, 800);
    num(c, w.score, 0, W - pad, y + px * 2.4, px);
    var cy = Math.max(px * 4.6, H * 0.2);
    if (w.comboN > 0) {
      var cl = 'COMBO x' + Math.min(6, w.comboN) + '  ' + fmtN(w.combo);
      c.fillStyle = K.accent;
      label(c, cl, W / 2, cy, px * 0.95, 800);
      var bw = px * 6, fr = clamp(1 - w.comboT / 1.2, 0, 1);
      c.fillStyle = K.faint; c.fillRect(W / 2 - bw / 2, cy + px * 0.75, bw, 2);
      c.fillStyle = K.accent; c.fillRect(W / 2 - bw / 2, cy + px * 0.75, bw * fr, 2);
    }
    if (w.wheelieT > 0.35 || w.stoppieT > 0.3) {
      c.fillStyle = K.text;
      label(c, (w.wheelieT > 0 ? 'WHEELIE ' : 'STOPPIE ') + (w.wheelieT || w.stoppieT).toFixed(1) + 's', W / 2, cy + px * 1.7, px * 0.85, 800);
    }
    if (w.P.nitro > 0) {
      c.fillStyle = w.nitroT > 0 ? K.accent : K.muted;
      var nl = 'NITRO ';
      for (k = 0; k < w.P.nitro; k++) nl += k < w.nitro ? '■' : '□';
      label(c, nl, pad, H - pad - (S.save.map ? 22 : 0) - px * 0.5, sm, 700, 'left');
    }
    HALO = false;
    // pop-ups: live ones stack from the top, under the HUD
    for (var i = 0, row = 0; i < POPS.length; i++) {
      var p = POPS[i], a = 1 - p.t / p.life;
      if (a <= 0) continue;
      var big = p.kind === 'big', sc = 1 + 0.35 * Math.max(0, 1 - p.t / 0.12);
      c.globalAlpha = Math.min(1, a * 2.2);
      c.fillStyle = p.kind === 'bad' ? K.text : K.accent;
      var py = cy + px * (w.comboN > 0 || w.wheelieT > 0.35 ? 2.9 : 1.2) + row * px * 1.45 - p.t * 8;
      row++;
      c.font = font(Math.min(px * (big ? 1.35 : 1), (W - 16) / (p.s.length * S.adv)) * sc, 800); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeStyle = K.bg; c.lineWidth = 4; c.lineJoin = 'round';
      c.strokeText(p.s, W / 2, py); c.fillText(p.s, W / 2, py);
    }
    c.globalAlpha = 1;
    if (S.save.map) drawMinimap(c, w);
    if (w.state === 'ready' && !S.ovlKind) drawReady(c, w, px);
  }
  // A strip along the bottom: the track profile, checkpoints, the ghost and every rider.
  function drawMinimap(c, w) {
    var K = S.col, W = S.W, H = S.H, h = 16, y0 = H - 6 - h, x0 = 10, x1 = W - 10, Tr = w.ter, a, b, i;
    if (w.mode === 'stage') { a = 0; b = w.finishX; } else { a = w.c.x - 120; b = w.c.x + 180; }
    var lo = 1e9, hi = -1e9, n = 64;
    for (i = 0; i <= n; i++) { var hh = E.heightAt(Tr, a + (b - a) * i / n); if (hh < lo) lo = hh; if (hh > hi) hi = hh; }
    var sy = h / Math.max(4, hi - lo);
    function X(x) { return x0 + (x1 - x0) * clamp((x - a) / (b - a), 0, 1); }
    function Y(yv) { return y0 + h - (yv - lo) * sy; }
    c.globalAlpha = 0.85;
    c.strokeStyle = K.faint; c.lineWidth = 1;
    c.beginPath();
    for (i = 0; i <= n; i++) { var xx = a + (b - a) * i / n, yy = Y(E.heightAt(Tr, xx)); if (i) c.lineTo(X(xx), yy); else c.moveTo(X(xx), yy); }
    c.stroke();
    c.fillStyle = K.muted;
    for (i = 0; i < w.cps.length; i++) c.fillRect(X(w.cps[i]) - 0.5, y0, 1, h);
    if (ghostOn(w) && E.ghostAt(S.ghost.data, w.t, GQ)) { c.strokeStyle = K.ghost; c.strokeRect(X(GQ[0]) - 2.5, Y(GQ[1]) - 2.5, 5, 5); }
    for (i = 0; i < S.rivals.length; i++) { var rv = S.rivals[i].w; c.fillStyle = S.rivals[i].col; c.fillRect(X(rv.c.x) - 2.5, Y(rv.c.y) - 2.5, 5, 5); }
    c.fillStyle = K.accent; c.fillRect(X(w.c.x) - 3, Y(w.c.y) - 3, 6, 6);
    c.globalAlpha = 1;
  }
  // The start card sits in the open dirt under the bike (never over the rider),
  // or under the HUD when the canvas is too short; text shrinks to fit.
  function drawReady(c, w, px) {
    var K = S.col, W = S.W, H = S.H, lines = S.readyLines, n = lines.length, len = 0, i;
    for (i = 0; i < n; i++) len = Math.max(len, lines[i].length * (i === 0 ? 1.08 : 1));
    var fp = Math.min(px * 0.95, (W - 40) / (len * S.adv));
    var gy = V.oy - E.heightAt(w.ter, w.c.x) * V.ppm, fit = (H - 30 - gy) / ((n + 0.4) * 1.45 + 0.8), by;
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
  // rivals / ghost off the edge of the screen: an arrow and the gap
  function edgeTag(c, x, y, txt, col) {
    var K = S.col, px = 10, left = x < V.x0, sx = left ? 12 : S.W - 12, sy = clamp(V.oy - y * V.ppm, 60, S.H - 40);
    c.fillStyle = col;
    HALO = true; c.strokeStyle = K.bg; c.lineWidth = 3;
    label(c, left ? '◄ ' + txt : txt + ' ►', sx, sy, px, 800, left ? 'left' : 'right');
    HALO = false;
  }

  function themeKey(w) {
    if (!w) return 'dust';
    if (w.mode === 'stage') { var tr = E.trackOf(w.track); return tr ? tr.loc : 'dust'; }
    return E.LOCS[E.biomeAt(w, w.cam.x)].key;
  }
  function draw(al) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, w = S.w || S.bgw, K = S.col, W = S.W, H = S.H, i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = K.bg; c.fillRect(0, 0, W, H);
    if (!w) return;
    var T = th(themeKey(w)), live = w === S.w;
    var cam = w.cam, a = al == null ? 1 : al;
    var cx = lerp(cam.px, cam.x, a), cy = lerp(cam.py, cam.y, a), z = lerp(cam.pz, cam.z, a), ppm = S.ppm / z;
    if (S.shake > 0) { cx += (E.rnd(S.rng) - 0.5) * S.shake * 0.5; cy += (E.rnd(S.rng) - 0.5) * S.shake * 0.5; }
    V.ppm = ppm; V.ox = W / 2 - cx * ppm; V.oy = H / 2 + cy * ppm;
    V.x0 = cx - W / 2 / ppm; V.x1 = cx + W / 2 / ppm; V.y0 = cy - H / 2 / ppm; V.y1 = cy + H / 2 / ppm;
    drawSky(c, cx, cy, T);
    drawDecos(c, w, false, T);
    drawTerrain(c, w, T);
    drawWaters(c, w, T);
    drawRoofs(c, w, T);
    drawDecos(c, w, true, T);
    drawObjects(c, w, T);
    if (live) {
      if (ghostOn(w) && E.ghostAt(S.ghost.data, w.t, GQ)) {
        if (!drawGhostRig(c, S.ghostP, GQ, S.ghost.tag)) edgeTag(c, GQ[0], GQ[1], S.ghost.tag + ' ' + Math.abs(GQ[0] - w.c.x).toFixed(0) + 'm', K.ghost);
      } else if (ghostOn(w) && S.ghost.end) drawGhostEnd(c, S.ghost.end);
      for (i = 0; i < S.rivals.length; i++) {
        var rv = S.rivals[i], rw = rv.w;
        if (rw.c.x < V.x0 - 3 || rw.c.x > V.x1 + 3) { edgeTag(c, rw.c.x, rw.c.y, rv.short + ' ' + Math.abs(rw.c.x - w.c.x).toFixed(0) + 'm', rv.col); continue; }
        drawWorldRig(c, rw, a, rv.cols, null, 0.92);
        c.fillStyle = rv.col;
        label(c, rv.short, V.ox + lerp(rw.c.px, rw.c.x, a) * ppm, V.oy - (lerp(rw.c.py, rw.c.y, a) + 2.3) * ppm, Math.max(9, 0.3 * ppm), 800);
      }
    }
    drawWorldRig(c, w, a, live ? S.cols : S.cols, null, null);
    if (live) drawDust(c, T);
    if (T.L.night) drawNight(c, w, a);
    drawWeather(c, T, cx);
    if (live) drawHud(c, w);
  }
  // Where the farthest attempt gave up: a flag on the trail.
  function drawGhostEnd(c, e) {
    if (e[0] < V.x0 - 2 || e[0] > V.x1 + 2) return;
    var px = CW * V.ppm / S.adv, gy = E.heightAt(S.w.ter, e[0]);
    c.fillStyle = S.col.ghost;
    textMode(c, px, 700);
    var top = pole(c, e[0], gy, 2.2, px);
    g1(c, '>', V.ox + e[0] * V.ppm + px * S.adv, top + px * 0.5, px);
    label(c, 'FARTHEST', V.ox + e[0] * V.ppm, top - px * 0.6, px * 0.8, 800);
  }
  // Night: everything outside the headlight falls into the dark.
  function drawNight(c, w, al) {
    var C = w.c, x = V.ox + lerp(C.px, C.x, al) * V.ppm, y = V.oy - (lerp(C.py, C.y, al) + 0.5) * V.ppm, ang = lerp(C.pa, C.a, al);
    var hx = x + Math.cos(ang) * V.ppm * 4, hy = y - Math.sin(ang) * V.ppm * 4, r = Math.max(S.W, S.H) * 0.55;
    var g = S.ctx.createRadialGradient(hx, hy, V.ppm * 1.5, hx, hy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.45, 'rgba(0,0,0,0)'); g.addColorStop(1, S.col.night);
    c.fillStyle = g; c.fillRect(0, 0, S.W, S.H);
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
    w.inTrick = k.trick || p.trick ? 1 : 0;
    w.inGadget = k.gad || p.gad ? 1 : 0;
  }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!canRun()) { S.snd.humStop(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    applyInput();
    var w = S.w, al = E.advance(w, dt), i;
    w.camMode = S.save.cam;
    // rivals start with the player and run their own simulations; a light rubber band keeps races close
    if (w.state !== 'ready') {
      for (i = 0; i < S.rivals.length; i++) {
        var rv = S.rivals[i];
        if (!rv.boss) rv.w.ai.band = 1 + clamp(w.c.x - rv.w.c.x, -60, 60) / 1000;
        E.advance(rv.w, dt);
        rivalEvents(rv);
      }
    }
    S.time += dt;
    S.shake = Math.max(0, S.shake - dt * 2);
    for (i = 0; i < POPS.length; i++) POPS[i].t += dt;
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
    var spin = Math.abs(w.wh[0].om - w.c.w), el = w.P.key === 'phantom', big = w.P.kind !== 'bike';
    snd.humSet((el ? 140 : big ? 30 : 42) + Math.min(150, spin * (el ? 4 : 2.1)) + (w.inGas ? 18 : 0) + (w.nitroT > 0 ? 40 : 0), w.inGas ? 0.05 : 0.025, el ? 1800 : big ? 320 : 480);
  }
  function rivalEvents(rv) {
    var ev = rv.w.events;
    for (var i = 0; i < ev.length; i++) if (ev[i] === 'crash' && Math.abs(rv.w.c.x - S.w.c.x) < 40) pop(rv.short + ' crashed', 'bad');
    ev.length = 0;
  }
  function racePlace() {
    var w = S.w, p = 1;
    for (var i = 0; i < S.rivals.length; i++) {
      var r = S.rivals[i].w;
      if (r.state === 'finish' && (w.state !== 'finish' || r.t < w.t)) p++;
      else if (r.state !== 'finish' && w.state !== 'finish' && r.c.x > w.c.x) p++;
    }
    return p;
  }

  var CRASH_TXT = { head: 'CRASH!', gap: 'INTO THE GAP!', roof: 'HEAD MEETS CEILING!', splash: 'SPLASHDOWN!', bail: 'BAILED! (let go of SPACE)', rock: 'FLATTENED BY A BOULDER!', cased: 'CASED IT — THROWN OFF!', flip: 'STUCK ON YOUR BACK', stuck: 'STUCK' };
  var GAP_TXT = { water: 'INTO THE HARBOUR!', lava: 'INTO THE LAVA!', crevasse: 'INTO THE CREVASSE!', pit: 'INTO THE GAP!' };
  function handleEvents() {
    var w = S.w, ev = w.events, snd = S.snd, T = th(themeKey(w));
    for (var i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'start': syncHead(); break;
        case 'crash':
          S.shake = 0.6;
          pop(w.why === 'gap' ? GAP_TXT[T.L.gap] : CRASH_TXT[w.why] || 'CRASH!', 'bad');
          snd.tone(140, 0.3, 'square', 0.05, 50);
          if (w.why === 'splash' || (w.why === 'gap' && T.L.gap === 'water')) burst(1, w.c.x, w.c.y, 14, 5);
          Cade.haptic(30);
          break;
        case 'bail': pop('COMBO LOST  -' + fmtN(w.lostCombo), 'bad'); break;
        case 'respawn': pop(w.cpX > 0 ? 'back to checkpoint' : 'back to the start'); break;
        case 'cp': pop('CHECKPOINT'); snd.tone(660, 0.08, 'triangle', 0.04); snd.tone(990, 0.1, 'triangle', 0.035, 0, 0.07); break;
        case 'trick': {
          while (S.trickSeen < w.tricks.length) {
            var tk = w.tricks[S.trickSeen++];
            pop(tk.n + '  +' + fmtN(tk.p) + (tk.z > 1 ? ' x2' : ''), /flip|AIR/i.test(tk.n) ? 'big' : '');
          }
          snd.chord([523, 659, 784], 0.05);
          break;
        }
        case 'flip': Cade.haptic(12); snd.chord([523, 659, 784, 1047]); break;
        case 'combo': { var lc = w.lastCombo; if (lc && lc.n > 1) { pop('COMBO x' + lc.mul + ' = ' + fmtN(lc.tot), 'big'); snd.chord([784, 988, 1175, 1568], 0.05); } break; }
        case 'perfect': snd.tone(1175, 0.12, 'sine', 0.035); break;
        case 'cased': pop('CASED IT!', 'bad'); S.shake = 0.3; snd.tone(90, 0.15, 'square', 0.04, 60); break;
        case 'spring': snd.tone(300, 0.25, 'triangle', 0.05, 900); break;
        case 'boost': snd.tone(500, 0.2, 'sawtooth', 0.025, 1200); burst(3, w.wh[0].x, w.wh[0].y, 4, 3); break;
        case 'nitro': pop('NITRO!', 'big'); snd.tone(200, 0.6, 'sawtooth', 0.04, 1200); break;
        case 'hop': snd.tone(260, 0.12, 'square', 0.035, 520); break;
        case 'crate': burst(5, w.c.x + 0.5, w.c.y, 8, 4); snd.tone(180, 0.08, 'square', 0.04, 90); break;
        case 'rockfall': pop('ROCKFALL!', 'bad'); snd.tone(70, 0.5, 'sawtooth', 0.04, 40); break;
        case 'rockland': for (var r = 0; r < w.rocks.length; r++) if (w.rocks[r].st === 2 && !w.rocks[r].fx) { w.rocks[r].fx = 1; burst(5, w.rocks[r].x, w.rocks[r].y, 10, 6); } S.shake = Math.max(S.shake, 0.25); break;
        case 'splash': burst(1, w.c.x, w.c.y - 0.5, 8, 4); snd.tone(400, 0.15, 'sine', 0.025, 150); break;
        case 'finish': pop('FINISH!', 'big'); snd.tone(784, 0.12, 'triangle', 0.05); snd.tone(1175, 0.2, 'triangle', 0.045, 0, 0.1); break;
        case 'done': ev.length = 0; runDone(); return;
        case 'over': ev.length = 0; runOver(); return;
        case 'coin': snd.tone(1320, 0.05, 'sine', 0.03); break;
        case 'fuel': pop('FUEL +100%'); snd.chord([523, 784], 0.06); break;
        case 'nofuel': pop('OUT OF FUEL', 'bad'); break;
      }
    }
    ev.length = 0;
  }

  // ---- runs: a time trial, endless, or a career event ----
  function setView(w) { if (w && S && S.ppm) { w.viewW = S.W / S.ppm; w.viewH = S.H / S.ppm; } }
  function resetPops() { POPS.length = 0; for (var i = 0; i < DN; i++) DL[i] = 0; }
  function myCfg() { var sv = S.save; return { veh: sv.veh, parts: sv.parts, team: S.run && S.run.kind === 'event' ? sv.career.team : '' }; }
  function begin(w, run) {
    halt();
    bankEndless();
    saveAttempt();
    w.camMode = S.save.cam;
    setView(w); E.resetCam(w);
    S.w = w; S.run = run; S.paused = false; S.shake = 0; S.banked = run.kind !== 'endless'; S.trickSeen = 0; resetPops();
    S.cols = lookCols(S.save.look);
    S.root.classList.toggle('uh-gad', w.P.nitro > 0 || !!w.P.hop);
    S.root.classList.toggle('uh-notrick', !w.P.poses);
    showOverlay(null);
    draw(1);
    S.live.textContent = S.readyLines[0] + '. ' + S.readyLines[S.readyLines.length - 1] + '.';
    kick();
  }
  function goLine() { return S.touch ? 'hold GAS to go' : 'hold → to go'; }
  function startTT(key) {
    if (!S) return;
    var tr = E.trackOf(key), rec = S.save.tt[key], idx = E.trackIdx(key);
    saveAttempt();                                  // a restart: the run being dropped may be the new farthest
    var w = E.newWorld({ track: key, cfg: myCfg() });
    w.rec = S.rec; w.recN = 0;
    S.rivals = [];
    loadGhost(key);
    S.hudStage = E.LOCS[E.locIdx(tr.loc)].short.toLowerCase() + ' ' + (idx % 3 + 1) + '/3';
    S.hudSub = rec ? 'best ' + fmtT(rec.t) : 'par ★★★ ' + fmtT(tr.par[0]);
    S.readyLines = [tr.name.toUpperCase() + ' · ' + E.LOCS[E.locIdx(tr.loc)].name.toUpperCase(),
      '★★★ ' + fmtT(tr.par[0]) + '   ★★ ' + fmtT(tr.par[1]) + (rec ? '   best ' + fmtT(rec.t) : ''), goLine()];
    begin(w, { kind: 'tt', track: key });
  }
  // Ghost: your best run; on a track you haven't finished yet, your farthest
  // attempt; else the crew chief's reference line ('rival', also the fallback).
  function loadGhost(key) {
    S.ghost = null; S.ghostP = null;
    var mode = S.save.ghost;
    if (mode === 'off') return;
    var best = mode === 'best' && S.save.tt[key] ? E.decodeGhost(sget(GHOST_KEY + key)) : null;
    var far = mode === 'best' && !S.save.tt[key] && S.save.far && S.save.far[key] ? E.decodeGhost(sget(GHOST_KEY + 'far-' + key)) : null;
    if (best && best.length >= E.GCH * 2) { S.ghost = { data: best, tag: 'BEST' }; S.ghostP = E.bikeParams({ veh: S.save.ghostVeh && S.save.ghostVeh[key] || 'mule' }); }
    else if (far && far.length >= E.GCH * 2) {
      for (var i = 0, m = 0; i < far.length; i += E.GCH) if (far[i] > far[m]) m = i;
      S.ghost = { data: far, tag: 'FARTHEST', end: [far[m], far[m + 1]] };
      S.ghostP = E.bikeParams({ veh: S.save.far[key].v });
    } else {
      var rg = S.rivalGhosts[key] || (S.rivalGhosts[key] = E.rivalGhost(key));
      if (rg.data.length) { S.ghost = { data: rg.data, tag: 'MAGS' }; S.ghostP = E.bikeParams({ veh: 'mule' }); }
    }
  }
  function startEndless() {
    if (!S) return;
    var seed = (Math.random() * 4294967296) >>> 0 || 1;
    var w = E.newWorld({ endless: true, seed: seed, cfg: myCfg() });
    S.rivals = []; S.ghost = null;
    S.hudSub = 'best ' + S.save.eb + ' m';
    S.readyLines = ['ENDLESS · TRAIL #' + (seed % 100000), 'six biomes · grab fuel [F] · coins buy parts', goLine()];
    begin(w, { kind: 'endless' });
  }
  function startEvent(id, bet) {
    if (!S) return;
    var ev = E.eventOf(id), sv = S.save, fee = E.entryFee(ev, sv.career.team);
    if (sv.coins < fee) return;
    sv.coins -= fee; writeSave();
    var run = { kind: 'event', ev: ev, fee: fee, bet: !!bet }, w, i;
    S.rivals = []; S.ghost = null;
    if (ev.type === 'climb') {
      w = E.newWorld({ endless: true, seed: ev.seed, biome: ev.biome, goal: ev.tiers[0], cfg: myCfg() });
      S.hudSub = '🥇' + ev.tiers[0] + ' 🥈' + ev.tiers[1] + ' 🥉' + ev.tiers[2] + ' m';
    } else {
      w = E.newWorld({ track: ev.track, cfg: myCfg() });
      var tr = E.trackOf(ev.track);
      S.hudStage = tr.name.toLowerCase();
      if (ev.rivals) {
        for (i = 0; i < ev.rivals.length; i++) {
          var cs = E.CAST[ev.rivals[i][0]];
          var rw = E.newWorld({ track: ev.track, seed: 31 + i * 17, startX: 2.2 * (i + 1), cfg: { veh: cs.veh, fx: cs.fx }, ai: { skill: ev.rivals[i][1] } });
          S.rivals.push({ id: ev.rivals[i][0], w: rw, name: cs.name, short: cs.short, col: cs.col, boss: !!cs.boss, cols: lookCols({ paint: '', jersey: 'graphite', helmet: cs.look.helmet, acc: cs.look.acc }) });
          S.rivals[i].cols.frame = cs.col; S.rivals[i].cols.frameLo = rgb(mix(parseCol(cs.col, S.base.ac), S.base.tx, 0.45));
        }
        S.hudSub = ev.type === 'boss' ? 'beat ' + E.CAST[ev.rivals[0][0]].short.toLowerCase() : 'top 3 to place';
      } else if (ev.type === 'stunt') S.hudSub = 'judged · tricks score';
      else if (ev.type === 'time') S.hudSub = '🥇' + ev.tiers[0] + 's 🥈' + ev.tiers[1] + 's 🥉' + ev.tiers[2] + 's';
    }
    var what = ev.type === 'race' || ev.type === 'boss' ? 'race ' + (S.rivals.length + 1) + ' riders' : ev.type === 'stunt' ? 'impress the judges' : ev.type === 'climb' ? 'go as far as one tank takes you' : 'beat the clock';
    S.readyLines = [ev.name.toUpperCase(), what + (fee ? ' · entry ' + fee : ''), goLine()];
    begin(w, run);
  }
  function restart() {
    if (!S || !S.run) return;
    var r = S.run;
    if (r.kind === 'endless') startEndless();
    else if (r.kind === 'tt') startTT(r.track);
    else { S.save.coins += r.fee; startEvent(r.ev.id, r.bet); }      // a restart doesn't charge the fee twice
  }
  // Endless coins go in the bank when the run ends (or the panel closes mid-run).
  function bankEndless() {
    if (!S || !S.w || S.w.mode !== 'endless' || S.banked || !S.run || S.run.kind !== 'endless') return;
    S.banked = true;
    var earned = S.w.coins + Math.floor(S.w.score / 100);
    if (earned > 0) { S.save.coins += earned; writeSave(); }
  }
  function runDone() {
    var r = S.run;
    if (r.kind === 'tt') finishTT();
    else if (r.kind === 'event') finishEvent(false);
  }
  function runOver() {
    var r = S.run;
    if (r.kind === 'endless') endlessOver();
    else if (r.kind === 'event') finishEvent(true);
  }
  // An unfinished time-trial run that got farther than any before becomes the
  // track's 'farthest' ghost (until the track is finished once).
  function saveAttempt() {
    if (!S || !S.w || !S.run || S.run.kind !== 'tt' || S.w.attemptSaved) return;
    var w = S.w, key = w.track;
    w.attemptSaved = true;
    if (w.state === 'finish' || S.save.tt[key] || w.recN < 3) return;
    var d = 0;
    for (var i = 0; i < w.recN; i++) if (w.rec[i * E.GCH] > d) d = w.rec[i * E.GCH];
    var far = S.save.far || (S.save.far = {}), prev = far[key];
    if (d < 5 || (prev && d <= prev.d)) return;
    var gs = E.packGhost(w.rec, w.recN);
    if (gs && sset(GHOST_KEY + 'far-' + key, gs)) { far[key] = { d: Math.round(d * 10) / 10, v: S.save.veh }; writeSave(); }
  }
  function finishTT() {
    var w = S.w, key = w.track, t = w.final;
    var wasOpen = E.ttUnlocked(S.save, E.trackIdx(key) + 1 < E.TRACKS.length ? E.trackIdx(key) + 1 : 0);
    var r = E.stageResult(S.save, key, t, w.score);
    S.save.coins += w.coins;
    S.w.attemptSaved = true;
    if (S.save.far && S.save.far[key]) { delete S.save.far[key]; sdel(GHOST_KEY + 'far-' + key); }
    if (r.newBest) {                                // the new best's run becomes the ghost (never a stale one)
      var gs = w.recN > 2 ? E.packGhost(w.rec, w.recN) : '';
      if (gs && sset(GHOST_KEY + key, gs)) { S.save.ghostVeh = S.save.ghostVeh || {}; S.save.ghostVeh[key] = S.save.veh; } else sdel(GHOST_KEY + key);
    }
    writeSave();
    var idx = E.trackIdx(key);
    S.result = { key: key, t: t, stars: r.stars, newBest: r.newBest, newScore: r.newScore, prev: r.prev, earned: r.earned, flips: w.flips, crashes: w.crashes,
      score: w.score, combo: w.bestCombo, picked: w.coins, unlocked: !wasOpen && idx % 3 < 2 };
    showOverlay('result');
  }
  function endlessOver() {
    var w = S.w, d = Math.floor(w.dist), nb = d > S.save.eb;
    if (nb) S.save.eb = d;
    var earned = w.coins + Math.floor(w.score / 100);
    bankEndless();
    writeSave();
    S.result = { dist: d, newBest: nb, coins: earned, why: w.why, seed: w.seed, flips: w.flips, score: w.score };
    showOverlay('over');
  }
  // A finished (or failed) career event → place, money, unlocks, story.
  function finishEvent(failed) {
    var w = S.w, r = S.run, ev = r.ev, sv = S.save, C = sv.career, place = 4, rows = [], cards = null, value = 0, i;
    if (ev.type === 'race' || ev.type === 'boss') {
      var mine = failed ? NaN : w.t;
      rows.push({ name: 'You', col: S.col.accent, t: mine, me: true });
      for (i = 0; i < S.rivals.length; i++) {
        var rv = S.rivals[i], rt = rv.w.state === 'finish' ? rv.w.t : E.simToFinish(rv.w, 120);
        if (rv.w.state === 'finish') rt = rv.w.t;
        rows.push({ name: rv.name, col: rv.col, t: rt });
      }
      rows.sort(function (a, b) { return (isNaN(a.t) ? 1e9 : a.t) - (isNaN(b.t) ? 1e9 : b.t); });
      for (i = 0; i < rows.length; i++) if (rows[i].me) place = isNaN(rows[i].t) ? rows.length : i + 1;
      value = mine;
    } else if (ev.type === 'stunt') {
      var stats = E.runStats(w);
      cards = E.judge(stats, ev.tgt);
      if (failed) cards.total = 0;
      rows.push({ name: 'You', col: S.col.accent, s: cards.total, me: true });
      for (i = 0; i < ev.scores.length; i++) rows.push({ name: E.CAST[ev.scores[i][0]].name, col: E.CAST[ev.scores[i][0]].col, s: ev.scores[i][1] });
      rows.sort(function (a, b) { return b.s - a.s; });
      for (i = 0; i < rows.length; i++) if (rows[i].me) place = i + 1;
      value = cards.total;
    } else if (ev.type === 'climb') {
      value = Math.floor(w.dist); place = E.tierPlace(ev, value);
    } else {
      value = failed ? 0 : w.final; place = E.tierPlace(ev, value);
    }
    var boss = E.isBoss(ev), prev = C.ev[ev.id], first = !prev || prev.p > 3;
    var won = place === 1, betWon = false;
    if (ev.bet && r.bet) {
      var rivalPlace = 99;
      for (i = 0; i < rows.length; i++) if (rows[i].name === E.CAST[ev.bet[0]].name) rivalPlace = i + 1;
      betWon = place < rivalPlace;
    }
    var pay = place <= ev.prize.length ? E.payout(ev, place, C.team, first, r.bet, betWon) : E.payout(ev, 99, C.team, first, r.bet, betWon);
    sv.coins = Math.max(0, sv.coins + pay.total + w.coins);
    C.ev[ev.id] = { p: Math.min(prev ? prev.p : 9, place), b: value, n: (prev ? prev.n : 0) + 1 };
    var unlocks = [], champ = false;
    if (boss && won && !C.boss[ev.loc]) { C.boss[ev.loc] = 1; unlocks = E.unlockedBy(ev.loc); if (ev.loc === 'summit') { C.champ = true; champ = true; } }
    writeSave();
    S.result = { ev: ev, place: place, rows: rows, cards: cards, value: value, pay: pay, fee: r.fee, picked: w.coins, bet: r.bet, betWon: betWon, unlocks: unlocks, champ: champ, failed: failed,
      ok: boss ? won : place <= 3, stats: E.runStats(w) };
    showOverlay('eresult');
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
    for (var k in S.keys) S.keys[k] = false;
    if (S.padCtl) S.padCtl.reset();
  }

  // ---- overlay screens (HTML over the canvas) ----
  var LOGO = ['    __o', '  _ \\<_', ' (@)/(@)'].join('\n');
  var TYPE_ICON = { race: '🏁', stunt: '★', climb: '⛰', time: '⏱', boss: '☠' };
  var TYPE_NAME = { race: 'Race', stunt: 'Stunt show', climb: 'Hill climb', time: 'Time attack', boss: 'Boss duel' };
  var CAM_NAMES = ['chase', 'wide', 'close', 'director'];
  var STAT_NAMES = [['power', 'Power'], ['speed', 'Top speed'], ['grip', 'Grip'], ['susp', 'Suspension'], ['air', 'Air control'], ['weight', 'Weight'], ['range', 'Fuel range']];
  function btn(act, html, cls, extra) {
    return '<button type="button" class="uh-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' + (extra || '') + '>' + html + '</button>';
  }
  function head(back, title, right) {
    return '<div class="uh-head">' + btn(back, '‹ back', 'link') + '<div class="uh-title sm">' + title + '</div><span class="uh-sub">' + (right || '') + '</span></div>';
  }
  function coinsTxt() { return '🪙 ' + fmtN(S.save.coins); }
  function who(k) { var c = E.CAST[k]; return c ? c : { name: k }; }
  function dlg(lines) {
    if (!lines || !lines.length) return '';
    return '<div class="uh-dlg">' + lines.map(function (l) {
      var c = who(l[0]), col = c.col || (l[0] === 'mags' ? 'var(--accent)' : 'var(--text)');
      return '<div class="uh-line"><b style="color:' + col + '">' + esc(c.name) + '</b><span>' + esc(l[1]) + '</span></div>';
    }).join('') + '</div>';
  }
  function bar10(v) { var n = Math.round(clamp(v, 0, 1) * 10), s = ''; for (var i = 0; i < 10; i++) s += i < n ? '■' : '□'; return s; }
  function statsHtml(st, base) {
    return '<div class="uh-stats">' + STAT_NAMES.map(function (p) {
      var d = base ? st[p[0]] - base[p[0]] : 0, dd = Math.abs(d) < 0.02 ? '' : '<i class="' + (d > 0 ? 'up' : 'dn') + '">' + (d > 0 ? '▲' : '▼') + '</i>';
      return '<div class="uh-st"><span>' + p[1] + '</span><span class="uh-bar10">' + bar10(st[p[0]]) + '</span>' + dd + '</div>';
    }).join('') + '</div>';
  }
  // short "+power −speed" summary of a part option against stock
  function deltaTxt(slot, key) {
    var sv = S.save, base = {}, k;
    for (k in sv.parts) base[k] = sv.parts[k];
    base[slot] = E.slotOf(slot).opts[0].key;
    var a = E.vehStats(E.bikeParams({ veh: sv.veh, parts: base })), mod = {};
    for (k in base) mod[k] = base[k];
    mod[slot] = key;
    var b = E.vehStats(E.bikeParams({ veh: sv.veh, parts: mod })), out = [];
    STAT_NAMES.forEach(function (p) { var d = b[p[0]] - a[p[0]]; if (Math.abs(d) >= 0.02) out.push('<i class="' + (d > 0 ? 'up' : 'dn') + '">' + (d > 0 ? '+' : '−') + p[1].toLowerCase() + '</i>'); });
    return out.join(' ');
  }
  function controlsHtml() {
    if (S.touch) return '<div class="uh-help"><b>GAS</b> / <b>BRAKE</b> on the right, <b>LEAN</b> ◄ ► and <b>★</b> trick on the left. Lean back to wheelie and flip, forward to land. Hold ★ in the air to pose — let go before you land.</div>';
    return '<div class="uh-help"><kbd>→</kbd> gas · <kbd>←</kbd> brake · <kbd>A</kbd><kbd>D</kbd> lean · <kbd>Space</kbd> style pose (in the air) · <kbd>⇧</kbd>/<kbd>E</kbd> gadget · <kbd>C</kbd> camera · <kbd>V</kbd> map · <kbd>R</kbd> restart · <kbd>P</kbd> pause<br>' +
      'Lean back to wheelie and flip, forward to land. Keep your head off the dirt.</div>';
  }
  function toggles() {
    var sv = S.save;
    return '<div class="uh-toggles">' + btn('sound', 'sound: ' + (S.snd.on ? 'on' : 'off'), 'link' + (S.snd.on ? ' on' : ''), ' aria-pressed="' + S.snd.on + '"') +
      btn('ghost', 'ghost: ' + sv.ghost, 'link' + (sv.ghost !== 'off' ? ' on' : '')) +
      btn('cam', 'camera: ' + CAM_NAMES[sv.cam], 'link on') + btn('map', 'map: ' + (sv.map ? 'on' : 'off'), 'link' + (sv.map ? ' on' : '')) + '</div>';
  }
  function careerSub() {
    var C = S.save.career, n = 0;
    if (!C.team) return 'start your career';
    if (C.champ) return 'champion 🏆';
    E.LOCS.forEach(function (l, i) { if (E.locOpen(S.save, i)) n = i; });
    return E.LOCS[n].short;
  }
  function overlayHtml(kind) {
    var sv = S.save, i, h = '', C = sv.career;
    if (kind === 'home') {
      var stars = E.totalStars(sv);
      return '<div class="uh-card uh-home"><pre class="uh-logo" aria-hidden="true">' + LOGO + '</pre>' +
        '<div class="uh-title">UPHILL RUSH</div>' +
        '<div class="uh-menu">' +
        btn('career', '<span>▶ Career</span><small>' + careerSub() + '</small>', 'primary split') +
        btn('tt', '<span>⏱ Time Trials</span><small>★ ' + stars + '/' + E.TRACKS.length * 3 + '</small>', 'split') +
        btn('endless', '<span>∞ Endless</span><small>best ' + sv.eb + ' m</small>', 'split') +
        btn('garage', '<span>⚙ Garage</span><small>' + coinsTxt() + '</small>', 'split') +
        '</div><div class="uh-help">Lean back to wheelie and flip, forward to land; keep your head off the dirt.</div>' + btn('help', 'controls & scoring', 'link') + toggles() + '</div>';
    }
    if (kind === 'help') {
      return '<div class="uh-card uh-wide">' + head('home', 'HOW TO PLAY', '') + controlsHtml() + '<div class="uh-help uh-left">' +
        '<b>Tricks</b> chain into a <b>combo</b>: keep landing new tricks within ~1 s of each other and the combo multiplies (up to ×6). Crash and the combo is lost. Repeating a trick in one run is worth less each time; tricks inside a <b>★ trick zone</b> count double.<br>' +
        '<b>Wheelie</b>: rear wheel only, lean back on the gas. <b>Stoppie</b>: front wheel only. <b>Flips</b>: double and triple flips are worth far more than singles. <b>Big air</b>: long airtime. <b>Perfect landing</b>: both wheels, parallel to the slope.<br>' +
        '<b>Style poses</b>: hold Space (★) in the air — lean forward as you press for a <b>superman</b>, back for a <b>can-can</b>, neither for a <b>no-hander</b>. Air control is weak with no hands, and you must let go before the wheels touch.<br>' +
        '<b>Casing</b> a landing (bottoming the suspension) halves your combo; on race valving a brutal one throws you off.<br>' +
        '<b>Surfaces</b>: sand and mud drag, mud and snow slip, ice barely grips, tarmac and rock grip hard. Tyres change all of that.<br>' +
        '<b>Set pieces</b>: <b>&gt;&gt;&gt;</b> boost strips, springboards, wind, tunnels (mind your head), water (keep your head above it), falling boulders, crates to smash.<br>' +
        '<b>Time trials</b>: flips (1 s, 2.5 s for a double…) and perfect landings take time off. Races count raw time.</div></div>';
    }
    if (kind === 'tt') {
      h = '<div class="uh-card uh-wide">' + head('home', 'TIME TRIALS', '★ ' + E.totalStars(sv) + '/' + E.TRACKS.length * 3);
      E.LOCS.forEach(function (L, li) {
        h += '<div class="uh-group">' + esc(L.name) + '</div><div class="uh-grid">';
        for (var j = 0; j < 3; j++) {
          var idx = li * 3 + j, tr = E.TRACKS[idx], r = sv.tt[tr.key], open = E.ttUnlocked(sv, idx);
          h += '<button type="button" class="uh-tile' + (open ? '' : ' locked') + '" data-act="play" data-k="' + tr.key + '"' + (open ? '' : ' disabled aria-disabled="true"') +
            ' title="' + esc(tr.name) + (open ? '' : ' (finish the previous track to unlock)') + '"><span class="uh-tn">' + pad2(idx + 1) + '</span><span class="uh-tname">' + esc(tr.name) + '</span>' +
            '<span class="uh-tstars">' + (open ? starStr(r ? r.s : 0) : 'locked') + '</span><span class="uh-tbest">' + (r ? fmtT(r.t) + (r.sc ? ' · ' + fmtN(r.sc) : '') : open ? '—' : '') + '</span></button>';
        }
        h += '</div>';
      });
      return h + '<div class="uh-note">The ghost is your best run — until you finish a track it is your farthest attempt, or Mags\' reference line. ' + E.STAR_COINS + ' coins per new star.</div></div>';
    }
    if (kind === 'garage') return garageHtml();
    if (kind === 'team') {
      h = '<div class="uh-card uh-wide">' + head(C.team ? 'career' : 'home', 'PICK A TEAM', coinsTxt()) +
        dlg(C.team ? [['mags', 'Switching teams costs 150 coins in contract fees.']] : [['mags', 'Every rider needs a team, kid. Each one gives you something — and takes something. Choose.']]) + '<div class="uh-ups">';
      E.TEAMS.forEach(function (t) {
        var cur = C.team === t.key, can = !C.team || (sv.coins >= 150 && !cur);
        h += '<div class="uh-up"><div class="uh-up-t"><b style="color:' + t.col + '">' + esc(t.name) + '</b><small class="up">+ ' + esc(t.perk) + '</small><small class="dn">− ' + esc(t.cost) + '</small></div>' +
          (cur ? '<span class="uh-max">YOURS</span>' : btn('team', C.team ? 'Switch 150' : 'Join', 'primary', ' data-k="' + t.key + '"' + (can ? '' : ' disabled'))) + '</div>';
      });
      return h + '</div></div>';
    }
    if (kind === 'career') {
      var tm = E.teamOf(C.team);
      h = '<div class="uh-card uh-wide">' + head('home', 'CAREER', coinsTxt()) +
        '<div class="uh-note">' + (tm ? 'Riding for <b style="color:' + tm.col + '">' + esc(tm.name) + '</b> · ' + btn('teams', 'change team', 'link inline') : '') + '</div><div class="uh-locs">';
      E.LOCS.forEach(function (L, li) {
        var open = E.locOpen(sv, li), beat = !!C.boss[L.key], pod = E.podiums(sv, L.key), T = LOC_THEME[L.key];
        h += '<button type="button" class="uh-loc' + (open ? '' : ' locked') + (beat ? ' done' : '') + '" data-act="loc" data-k="' + L.key + '"' + (open ? '' : ' disabled') + ' style="--tint:' + T.tint + '">' +
          '<span class="uh-ln">' + (li + 1) + '</span><span class="uh-lname">' + esc(L.name) + '</span><span class="uh-lst">' +
          (!open ? '🔒 beat the previous boss' : beat ? '✓ boss beaten' : pod + '/3 podiums' + (pod >= 2 ? ' · boss open' : '')) + '</span></button>';
      });
      return h + '</div>' + (C.champ ? '<div class="uh-new">🏆 SUMMIT CUP CHAMPION 🏆</div>' : '') + '</div>';
    }
    if (kind === 'loc') {
      var L = E.LOCS[E.locIdx(S.locKey)], evs = E.locEvents(S.locKey), seen = C.seen[S.locKey];
      h = '<div class="uh-card uh-wide">' + head('career', esc(L.name.toUpperCase()), coinsTxt());
      if (!seen) { C.seen[S.locKey] = 1; writeSave(); h += dlg(E.LOC_INTRO[S.locKey]); }
      h += '<div class="uh-evs">';
      evs.forEach(function (ev) {
        var r = C.ev[ev.id], boss = E.isBoss(ev), locked = boss && !E.bossOpen(sv, ev.loc), medal = r ? (r.p === 1 ? '🥇' : r.p === 2 ? '🥈' : r.p === 3 ? '🥉' : '·') : '';
        var pot = Math.round(ev.prize[0] * (E.teamOf(C.team) ? E.teamOf(C.team).prize : 1));
        h += '<button type="button" class="uh-ev' + (boss ? ' boss' : '') + (locked ? ' locked' : '') + '" data-act="brief" data-k="' + ev.id + '"' + (locked ? ' disabled' : '') + '>' +
          '<span class="uh-eic">' + TYPE_ICON[boss ? 'boss' : ev.type] + '</span><span class="uh-et"><b>' + esc(ev.name) + '</b><small>' + TYPE_NAME[ev.type] + (ev.track ? ' · ' + esc(E.trackOf(ev.track).name) : '') +
          (locked ? ' · 🔒 podium in 2 events' : '') + '</small></span><span class="uh-epot">' + medal + ' <small>1st</small> ' + fmtN(pot) + '<small> · fee ' + E.entryFee(ev, C.team) + '</small></span></button>';
      });
      return h + '</div></div>';
    }
    if (kind === 'brief') {
      var ev = E.eventOf(S.evId), fee = E.entryFee(ev, C.team), tmb = E.teamOf(C.team), pf = tmb ? tmb.prize : 1, prev = C.ev[ev.id], first = !prev || prev.p > 3;
      var pots = ev.prize.map(function (p, j) { return '<span>' + ['🥇', '🥈', '🥉'][j] + ' ' + fmtN(Math.round(p * pf * (first ? 1 : 0.5))) + '</span>'; }).join('');
      var goal = E.isBoss(ev) ? 'Win to beat the boss' + (ev.reward ? ' — unlocks ' + esc(ev.reward) : '') : ev.type === 'climb' ? 'Distance: 🥇 ' + ev.tiers[0] + ' m · 🥈 ' + ev.tiers[1] + ' m · 🥉 ' + ev.tiers[2] + ' m'
        : ev.type === 'time' ? 'Time: 🥇 ' + ev.tiers[0] + ' s · 🥈 ' + ev.tiers[1] + ' s · 🥉 ' + ev.tiers[2] + ' s' : 'Finish on the podium to complete the event';
      var field = '';
      if (ev.rivals) field = '<div class="uh-field">' + ev.rivals.map(function (rv) { var cs = E.CAST[rv[0]]; return '<span style="color:' + cs.col + '">' + esc(cs.name) + ' <small>' + esc(E.vehOf(cs.veh).name) + '</small></span>'; }).join('') + '</div>';
      if (ev.scores) field = '<div class="uh-field">' + ev.scores.map(function (rv) { var cs = E.CAST[rv[0]]; return '<span style="color:' + cs.col + '">' + esc(cs.name) + ' <small>' + rv[1].toFixed(1) + ' pts</small></span>'; }).join('') + '</div>';
      var betHtml = '';
      if (ev.bet) {
        var bc = E.CAST[ev.bet[0]], canBet = sv.coins - fee >= ev.bet[1];
        betHtml = '<label class="uh-bet"><input type="checkbox" data-act="bet"' + (S.betOn && canBet ? ' checked' : '') + (canBet ? '' : ' disabled') + '> Side bet: ' + ev.bet[1] + ' coins you beat <b style="color:' + bc.col + '">' + esc(bc.name) + '</b> (win ' + ev.bet[1] + ', lose ' + ev.bet[1] + ')</label>';
      }
      var V0 = E.vehOf(sv.veh);
      return '<div class="uh-card uh-wide">' + head('loc', esc(ev.name.toUpperCase()), coinsTxt()) +
        '<div class="uh-badge">' + TYPE_ICON[E.isBoss(ev) ? 'boss' : ev.type] + ' ' + TYPE_NAME[ev.type] + (ev.track ? ' · ' + esc(E.trackOf(ev.track).name) : ' · ' + esc(E.LOCS[ev.biome].name)) + '</div>' +
        dlg(ev.intro) + field + '<div class="uh-goal">' + goal + '</div><div class="uh-pots">' + pots + (first ? '' : '<small>replay: half pots</small>') + '</div>' + betHtml +
        '<div class="uh-note">Your machine: <b>' + esc(V0.name) + '</b> ' + btn('garage', 'garage', 'link inline') + '</div>' +
        '<div class="uh-menu row">' + btn('go', fee ? 'Enter · ' + fee + ' coins' : 'Start ▶', 'primary', sv.coins >= fee ? '' : ' disabled') + btn('loc', 'Back') + '</div>' +
        (sv.coins >= fee ? '' : '<div class="uh-note">Not enough coins for the entry fee — earn some in Time Trials or Endless.</div>') + '</div>';
    }
    if (kind === 'pause') {
      var w = S.w, r = S.run;
      return '<div class="uh-card"><div class="uh-title">PAUSED</div><div class="uh-sub">' +
        (w.mode === 'stage' ? fmtT(Math.max(0, w.t - w.bonus)) + ' · style ' + fmtN(w.score) : Math.floor(w.dist) + ' m · ' + w.coins + ' coins') + '</div>' +
        '<div class="uh-menu">' + btn('resume', 'Resume', 'primary') + btn('restart', 'Restart') + btn(r.kind === 'event' ? 'quit' : 'menu', r.kind === 'event' ? 'Retire' : 'Menu') + '</div>' +
        toggles() + '<div class="uh-note">' + (S.touch ? 'tap Resume when you are ready' : 'P / Enter to resume · R restart · Esc menu') + '</div></div>';
    }
    if (kind === 'result') {
      var R = S.result, tr = E.trackOf(R.key), idx = E.trackIdx(R.key), next = idx % 3 < 2;
      return '<div class="uh-card"><div class="uh-title">' + (R.newBest && R.prev != null ? 'NEW BEST!' : 'TRACK CLEAR') + '</div>' +
        '<div class="uh-sub">' + esc(tr.name) + '</div>' +
        '<div class="uh-big">' + fmtT(R.t) + '</div><div class="uh-stars" aria-label="' + R.stars + ' of 3 stars">' + starStr(R.stars) + '</div>' +
        '<div class="uh-note">★★★ ' + fmtT(tr.par[0]) + ' · ★★ ' + fmtT(tr.par[1]) + (R.prev != null ? ' · best ' + fmtT(Math.min(R.prev, R.t)) : '') + '</div>' +
        '<div class="uh-note">style <b>' + fmtN(R.score) + '</b>' + (R.newScore ? ' (best!)' : '') + ' · best combo ' + fmtN(R.combo) + '</div>' +
        '<div class="uh-note">' + R.flips + (R.flips === 1 ? ' flip' : ' flips') + ' · ' + R.crashes + (R.crashes === 1 ? ' crash' : ' crashes') +
        (R.earned || R.picked ? ' · <b>+' + (R.earned + R.picked) + ' coins</b>' : '') + (R.unlocked ? ' · next track unlocked' : '') + '</div>' +
        '<div class="uh-menu row">' + (next ? btn('next', 'Next ▶', 'primary') : '') + btn('restart', 'Retry', next ? '' : 'primary') + btn('tt', 'Tracks') + '</div></div>';
    }
    if (kind === 'over') {
      var O = S.result;
      return '<div class="uh-card"><div class="uh-title">' + (O.why === 'fuel' ? 'OUT OF FUEL' : 'CRASHED') + '</div>' +
        '<div class="uh-sub">trail #' + (O.seed % 100000) + '</div>' +
        '<div class="uh-big">' + O.dist + ' m</div>' + (O.newBest ? '<div class="uh-new">** new best **</div>' : '<div class="uh-note">best ' + sv.eb + ' m</div>') +
        '<div class="uh-note">style ' + fmtN(O.score) + ' · ' + O.flips + (O.flips === 1 ? ' flip' : ' flips') + '</div>' +
        '<div class="uh-note"><b>+' + O.coins + ' coins</b> (pickups, flips, 1 per 100 style) · ' + fmtN(sv.coins) + ' in the bank</div>' +
        '<div class="uh-menu row">' + btn('again', 'Again ▶', 'primary') + btn('garage', 'Garage') + btn('menu', 'Menu') + '</div></div>';
    }
    if (kind === 'eresult') return eresultHtml();
    return '';
  }
  function eresultHtml() {
    var R = S.result, ev = R.ev, boss = E.isBoss(ev), i, h;
    var title = R.champ ? 'CHAMPION!' : boss ? (R.place === 1 ? 'BOSS BEATEN!' : 'DEFEATED') : R.place <= 3 ? ['', '1ST PLACE!', '2ND PLACE', '3RD PLACE'][R.place] : 'OFF THE PODIUM';
    h = '<div class="uh-card uh-wide"><div class="uh-title">' + title + '</div><div class="uh-sub">' + esc(ev.name) + '</div>';
    if (R.cards) {
      h += '<div class="uh-judges">' + R.cards.cards.map(function (cd, j) {
        return '<div class="uh-jcard" style="animation-delay:' + (j * 0.25) + 's"><small>' + esc(cd.judge.name) + '</small><b>' + cd.score.toFixed(1) + '</b><i>“' + esc(cd.quip) + '”</i></div>';
      }).join('') + '</div><div class="uh-note">style ' + fmtN(R.stats.score) + ' · ' + R.stats.unique + ' different tricks · best combo ' + fmtN(R.stats.bestCombo) + ' · ' + R.stats.crashes + ' crashes</div>';
    }
    if (R.rows.length) {
      h += '<table class="uh-tbl">';
      for (i = 0; i < R.rows.length; i++) {
        var rw = R.rows[i];
        h += '<tr' + (rw.me ? ' class="me"' : '') + '><td>' + (i + 1) + '</td><td style="color:' + rw.col + '">' + esc(rw.name) + '</td><td>' + (rw.s != null ? rw.s.toFixed(1) : isNaN(rw.t) ? 'DNF' : fmtT(rw.t)) + '</td></tr>';
      }
      h += '</table>';
    } else {
      h += '<div class="uh-big">' + (ev.type === 'climb' ? R.value + ' m' : R.value ? fmtT(R.value) : '—') + '</div><div class="uh-note">🥇 ' + ev.tiers[0] + ' · 🥈 ' + ev.tiers[1] + ' · 🥉 ' + ev.tiers[2] + (ev.type === 'climb' ? ' m' : ' s') + '</div>';
    }
    var P = R.pay, net = P.total + R.picked - R.fee;
    h += '<div class="uh-pay"><span>prize <b>' + fmtN(P.prize) + '</b></span>' + (R.bet ? '<span>side bet <b class="' + (R.betWon ? 'up' : 'dn') + '">' + (P.bet > 0 ? '+' : '') + P.bet + '</b></span>' : '') +
      (R.picked ? '<span>pickups <b>+' + R.picked + '</b></span>' : '') + '<span>entry <b>−' + R.fee + '</b></span><span>net <b class="' + (net >= 0 ? 'up' : 'dn') + '">' + (net >= 0 ? '+' : '') + net + '</b></span></div>';
    h += dlg(R.ok ? ev.win : ev.lose);
    if (R.unlocks.length) h += '<div class="uh-new">UNLOCKED: ' + esc(R.unlocks.join(' · ')) + '</div>';
    return h + '<div class="uh-menu row">' + btn('loc', 'Continue ▶', 'primary') + btn('retry', 'Re-enter') + btn('garage', 'Garage') + '</div></div>';
  }

  // ---- garage ----
  function garageHtml() {
    var sv = S.save, tab = S.gtab || 'veh', h, P = E.bikeParams({ veh: sv.veh, parts: sv.parts }), st = E.vehStats(P);
    h = '<div class="uh-card uh-wide">' + head(S.gback || 'home', 'GARAGE', coinsTxt()) +
      '<div class="uh-gtop"><canvas class="uh-prev" width="200" height="110" aria-hidden="true"></canvas>' + statsHtml(st, null) + '</div>' +
      '<div class="uh-tabs" role="tablist">' + [['veh', 'Machines'], ['tune', 'Tuning'], ['look', 'Rider & paint']].map(function (t) {
        return '<button type="button" role="tab" class="uh-tab' + (tab === t[0] ? ' on' : '') + '" aria-selected="' + (tab === t[0]) + '" data-act="gtab" data-k="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>';
    if (tab === 'veh') {
      h += '<div class="uh-ups">';
      E.VEHICLES.forEach(function (v) {
        var own = !!sv.owned[v.key], avail = E.vehAvail(sv, v), cur = sv.veh === v.key, vs = E.vehStats(E.bikeParams({ veh: v.key, parts: sv.parts }));
        var act = cur ? '<span class="uh-max">RIDING</span>' : own ? btn('veh', 'Ride', '', ' data-k="' + v.key + '"') :
          avail ? btn('buyveh', v.price + ' 🪙', sv.coins >= v.price ? 'primary' : '', ' data-k="' + v.key + '"' + (sv.coins >= v.price ? '' : ' disabled')) : '<span class="uh-lock">🔒 beat ' + esc(bossName(v.unlock)) + '</span>';
        h += '<div class="uh-up' + (cur ? ' cur' : '') + '"><div class="uh-up-t"><b>' + esc(v.name) + '</b><span class="uh-mini">' + STAT_NAMES.slice(0, 5).map(function (p) { return p[1].split(' ')[0].toLowerCase() + ' ' + Math.round(vs[p[0]] * 10); }).join(' · ') + '</span><small>' + esc(v.blurb) + '</small></div>' + act + '</div>';
      });
      h += '</div>';
    } else if (tab === 'tune') {
      h += '<div class="uh-note">Every part is a trade-off. Buy once, swap freely.' + (sv.career.team === 'devils' ? ' (Dust Devils: parts cost 30% more.)' : '') + '</div><div class="uh-ups">';
      E.PARTS.forEach(function (sl) {
        h += '<div class="uh-slot"><div class="uh-group">' + esc(sl.name) + '</div>';
        sl.opts.forEach(function (o) {
          var own = E.partOwned(sv, sl.slot, o), avail = E.partAvail(sv, sl.slot, o), cur = sv.parts[sl.slot] === o.key, cost = E.partCost(o, sv.career.team);
          var act = cur ? '<span class="uh-max">FITTED</span>' : own ? btn('fit', 'Fit', '', ' data-s="' + sl.slot + '" data-k="' + o.key + '"') :
            avail ? btn('buypart', cost + ' 🪙', sv.coins >= cost ? 'primary' : '', ' data-s="' + sl.slot + '" data-k="' + o.key + '"' + (sv.coins >= cost ? '' : ' disabled')) : '<span class="uh-lock">🔒 beat ' + esc(bossName(o.unlock)) + '</span>';
          h += '<div class="uh-up' + (cur ? ' cur' : '') + '"><div class="uh-up-t"><b>' + esc(o.name) + '</b><span class="uh-delta">' + (o.key === sl.opts[0].key ? '' : deltaTxt(sl.slot, o.key)) + '</span><small>' + esc(o.d) + '</small></div>' + act + '</div>';
        });
        h += '</div>';
      });
      h += '</div>';
    } else {
      h += lookRow('Paint', 'p', 'paint', E.PAINTS, function (p) { return '<span class="uh-sw" style="background:' + (p.col || 'var(--accent)') + '"></span>'; }) +
        lookRow('Jersey', 'p', 'jersey', E.PAINTS, function (p) { return '<span class="uh-sw" style="background:' + (p.col || 'var(--accent)') + '"></span>'; }) +
        lookRow('Helmet', 'h', 'helmet', E.HELMETS, function (p) { return '<b class="uh-hg">' + esc(p.g) + '</b>'; }) +
        lookRow('Extra', 'a', 'acc', E.ACCS, function () { return ''; });
    }
    return h + '</div>';
  }
  function bossName(loc) { for (var k in E.CAST) if (E.CAST[k].boss === loc) return E.CAST[k].name; return 'a boss'; }
  function lookRow(title, kind, field, list, swatch) {
    var sv = S.save, h = '<div class="uh-group">' + title + '</div><div class="uh-looks">';
    list.forEach(function (it) {
      var own = E.lookOwned(sv, kind, it), cur = sv.look[field] === it.key, buy = !own && E.buyable(sv, it);
      var tip = it.name + (own ? '' : buy ? ' — ' + it.cost + ' coins' : it.unlock ? ' — beat ' + bossName(it.unlock) : it.stars ? ' — ' + it.stars + ' time-trial stars' : '');
      h += '<button type="button" class="uh-look' + (cur ? ' on' : '') + (own ? '' : ' locked') + '" data-act="look" data-f="' + field + '" data-kind="' + kind + '" data-k="' + it.key + '" title="' + esc(tip) + '"' +
        (own || (buy && sv.coins >= it.cost) ? '' : ' disabled') + '>' + swatch(it) + '<span>' + esc(it.name) + '</span>' + (own ? '' : '<small>' + (buy ? it.cost + '🪙' : '🔒') + '</small>') + '</button>';
    });
    return h + '</div>';
  }
  // the garage preview: the selected machine and rider, standing on a strip of dirt
  function drawPreview() {
    var cv = S.ovl.querySelector('.uh-prev');
    if (!cv) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1), cw = 200, ch = 110;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    var c = cv.getContext('2d'), save = { ppm: V.ppm, ox: V.ox, oy: V.oy, x0: V.x0, x1: V.x1 };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var P = E.bikeParams({ veh: S.save.veh, parts: S.save.parts }), ppm = P.kind === 'truck' ? 22 : P.kind === 'car' ? 30 : 36;
    V.ppm = ppm; V.ox = cw / 2; V.oy = ch - 14; V.x0 = -4; V.x1 = 4;
    var y0 = 0, gy = P.wr[0] - (P.ay[0] + P.dy[0] * P.stat[0]);
    for (var i = 0; i < 2; i++) {
      var lx = P.ax[i] + P.dx[i] * P.stat[i], ly = P.ay[i] + P.dy[i] * P.stat[i];
      WV[i * 3] = V.ox + lx * ppm; WV[i * 3 + 1] = V.oy - (gy + ly) * ppm; WV[i * 3 + 2] = S.time;
    }
    textMode(c, 10, 700);
    c.fillStyle = th('dust').ground;
    for (var x = -6; x < 6; x += CW) g1(c, '_', V.ox + x * ppm, V.oy - y0 * ppm, CW * ppm / S.adv);
    drawRig(c, { P: P, x: 0, y: gy, a: 0, wheels: WV, lean: 0, pose: 0, poseK: 0, rag: null, cols: lookCols(S.save.look), speed: 6 });
    V.ppm = save.ppm; V.ox = save.ox; V.oy = save.oy; V.x0 = save.x0; V.x1 = save.x1;
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
      if (!S.w) draw(1);
      if (kind === 'garage') drawPreview();
      if (!S.touch) {
        var b = S.ovl.querySelector('.uh-btn.primary:not([disabled])') || S.ovl.querySelector('button:not([disabled])');
        if (b) try { b.focus({ preventScroll: true }); } catch (e) {}
      }
      var t = S.ovl.querySelector('.uh-title');
      if (t) S.live.textContent = t.textContent;
    }
  }
  function refresh() { var top = S.ovl.scrollTop; showOverlay(S.ovlKind); S.ovl.scrollTop = top; }
  function toMenu(kind) {
    if (!S) return;
    halt();
    bankEndless();
    S.paused = false;
    saveAttempt();
    if (S.w) { S.bgw = S.w; S.w = null; }
    S.rivals = [];
    showOverlay(kind || 'home');
  }
  function buyTone() { S.snd.tone(880, 0.08, 'triangle', 0.04); S.snd.tone(1320, 0.12, 'triangle', 0.035, 0, 0.07); }
  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !S || b.disabled) return;
    S.snd.ensure();
    var act = b.getAttribute('data-act'), k = b.getAttribute('data-k'), sv = S.save, C = sv.career;
    switch (act) {
      case 'home': showOverlay('home'); break;
      case 'help': showOverlay('help'); break;
      case 'tt': toMenu('tt'); break;
      case 'garage': S.gback = S.ovlKind === 'brief' ? 'brief' : S.ovlKind === 'eresult' ? 'loc' : 'home'; toMenu('garage'); break;
      case 'career': showOverlay(C.team ? 'career' : 'team'); break;
      case 'teams': showOverlay('team'); break;
      case 'team':
        if (C.team) { if (sv.coins < 150) break; sv.coins -= 150; }
        C.team = k; writeSave(); buyTone(); showOverlay('career'); break;
      case 'loc': if (k) S.locKey = k; toMenu('loc'); break;
      case 'brief': S.evId = k; S.betOn = false; showOverlay('brief'); break;
      case 'bet': S.betOn = !!b.checked; break;
      case 'go': startEvent(S.evId, S.betOn); break;
      case 'retry': if (S.result && S.result.ev) { S.evId = S.result.ev.id; showOverlay('brief'); } break;
      case 'quit': toMenu('loc'); break;
      case 'endless': case 'again': startEndless(); break;
      case 'play': startTT(k); break;
      case 'next': if (S.result) { var ni = E.trackIdx(S.result.key) + 1; if (ni < E.TRACKS.length) startTT(E.TRACKS[ni].key); } break;
      case 'restart': restart(); break;
      case 'resume': resume(); break;
      case 'menu': toMenu(); break;
      case 'gtab': S.gtab = k; refresh(); break;
      case 'veh': sv.veh = k; writeSave(); refresh(); break;
      case 'buyveh': { var v = E.vehOf(k); if (!sv.owned[k] && E.vehAvail(sv, v) && sv.coins >= v.price) { sv.coins -= v.price; sv.owned[k] = 1; sv.veh = k; writeSave(); buyTone(); refresh(); } break; }
      case 'fit': sv.parts[b.getAttribute('data-s')] = k; writeSave(); refresh(); break;
      case 'buypart': {
        var s2 = b.getAttribute('data-s'), o = E.partOpt(s2, k), cost = E.partCost(o, C.team);
        if (E.partAvail(sv, s2, o) && !E.partOwned(sv, s2, o) && sv.coins >= cost) { sv.coins -= cost; sv.own[s2 + '.' + k] = 1; sv.parts[s2] = k; writeSave(); buyTone(); refresh(); }
        break;
      }
      case 'look': {
        var kind = b.getAttribute('data-kind'), f = b.getAttribute('data-f'), list = kind === 'p' ? E.PAINTS : kind === 'h' ? E.HELMETS : E.ACCS, it = E.find(list, k);
        if (!E.lookOwned(sv, kind, it)) { if (!E.buyable(sv, it) || sv.coins < it.cost) break; sv.coins -= it.cost; sv.own[kind + '.' + k] = 1; buyTone(); }
        sv.look[f] = k; writeSave(); S.cols = lookCols(sv.look); refresh(); break;
      }
      case 'sound':
        S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        refresh();
        break;
      case 'ghost': cycleGhost(); break;
      case 'cam': cycleCam(); break;
      case 'map': sv.map = !sv.map; writeSave(); if (S.ovlKind) refresh(); break;
    }
  }
  function cycleGhost() {
    if (!S) return;
    var sv = S.save;
    sv.ghost = sv.ghost === 'best' ? 'rival' : sv.ghost === 'rival' ? 'off' : 'best'; writeSave();
    if (S.w && S.run && S.run.kind === 'tt') loadGhost(S.run.track);
    pop('ghost: ' + (sv.ghost === 'best' ? 'your best (or farthest try)' : sv.ghost === 'rival' ? 'Mags\' line' : 'off'));
    if (S.ovlKind) refresh(); else if (S.w && !S.raf) draw(1);
  }
  function cycleCam() {
    if (!S) return;
    S.save.cam = (S.save.cam + 1) % 4; writeSave();
    if (S.w) { S.w.camMode = S.save.cam; pop('camera: ' + CAM_NAMES[S.save.cam]); }
    if (S.ovlKind) refresh(); else if (S.w && !S.raf) draw(1);
  }
  function ghostOn(w) { return !!(S.ghost && S.save.ghost !== 'off' && w.mode === 'stage' && w.state !== 'ready' && S.run && S.run.kind === 'tt'); }

  // ---- header buttons (before the core Minimize) ----
  function hsvg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_RESTART = hsvg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>');
  var IC_PAUSE = hsvg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = hsvg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_MENU = hsvg('<path d="M4 7h16M4 12h16M4 17h16"/>');
  var IC_CAM = hsvg('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>');
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
    KeyA: 'back', KeyZ: 'back', KeyD: 'fwd', KeyX: 'fwd',
    Space: 'trick', ShiftLeft: 'gad', ShiftRight: 'gad', KeyE: 'gad'
  };
  var KEY2CODE = { arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowdown: 'ArrowDown', w: 'KeyW', s: 'KeyS', a: 'KeyA', z: 'KeyZ', d: 'KeyD', x: 'KeyX', e: 'KeyE', r: 'KeyR', p: 'KeyP', m: 'KeyM', g: 'KeyG', c: 'KeyC', v: 'KeyV', escape: 'Escape', enter: 'Enter', ' ': 'Space', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;    // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !S.panel.contains(t)) return;
    if (t && t.isContentEditable && !S.panel.contains(t)) return;
    var code = keyCode(e), act = KEYMAP[code];
    if (act && !(act === 'trick' && S.ovlKind)) {
      if (!S.w || S.ovlKind) { if (act !== 'gad') e.preventDefault(); return; }
      e.preventDefault();
      if (!S.keys[act]) { S.keys[act] = true; S.snd.ensure(); kick(); }
      return;
    }
    if (code === 'KeyR') { e.preventDefault(); if (!e.repeat && S.w) restart(); return; }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'KeyM') { e.preventDefault(); if (!e.repeat) { S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0'); S.snd.ensure(); if (!S.snd.on) S.snd.humStop(); if (S.ovlKind === 'home') refresh(); } return; }
    if (code === 'KeyG') { e.preventDefault(); if (!e.repeat) cycleGhost(); return; }
    if (code === 'KeyC') { e.preventDefault(); if (!e.repeat) cycleCam(); return; }
    if (code === 'KeyV') { e.preventDefault(); if (!e.repeat) { S.save.map = !S.save.map; writeSave(); if (S.ovlKind) refresh(); else if (S.w && !S.raf) draw(1); } return; }
    if (code === 'Escape') {
      e.preventDefault();
      var o = S.ovlKind;
      if (S.paused) toMenu(S.run && S.run.kind === 'event' ? 'loc' : 'home');
      else if (S.w && !o && S.w.state !== 'ready') pause();
      else if (o === 'tt' || o === 'help' || o === 'career' || (o === 'team' && !S.save.career.team)) showOverlay('home');
      else if (o === 'garage') showOverlay(S.gback || 'home');
      else if (o === 'loc' || o === 'team') showOverlay('career');
      else if (o === 'brief') showOverlay('loc');
      else if (o === 'home') closePanel();
      else if (S.w && !o && S.run && S.run.kind === 'event') toMenu('loc');
      else toMenu();
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      var onBtn = t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT') && S.panel.contains(t);
      if (onBtn) return;                                        // the focused button clicks itself
      e.preventDefault();
      if (e.repeat) return;
      if (S.paused) { resume(); return; }
      if (S.ovlKind) { var b = S.ovl.querySelector('.uh-btn.primary:not([disabled])'); if (b) b.click(); }
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
    function measure() { rects = btns.filter(function (b) { return b.offsetParent !== null; }).map(function (b) { return { k: b.getAttribute('data-k'), r: b.getBoundingClientRect() }; }); }
    function keyAt(x, y) {
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i].r;
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 10 && y <= r.bottom + 10) return rects[i].k;
      }
      return null;
    }
    function sync() {
      var held = { gas: false, brake: false, back: false, fwd: false, trick: false, gad: false };
      for (var id in owner) if (owner[id]) held[owner[id]] = true;
      btns.forEach(function (b) { b.classList.toggle('on', !!held[b.getAttribute('data-k')]); });
      if (!S) return;
      for (var k in held) S.pad[k] = held[k];
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
    var pw = narrow ? vw - 16 : Math.min(float ? 960 : 860, vw - 32);
    S.panel.style.width = pw + 'px';
    var body = S.panel.querySelector('.cade-panel-body'), bs = body ? getComputedStyle(body) : null;
    var padX = bs ? (parseFloat(bs.paddingLeft) || 0) + (parseFloat(bs.paddingRight) || 0) : 16;
    var padY = bs ? (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0) : 16;
    var cw = Math.max(200, Math.floor(pw - 2 - padX));
    var r = S.panel.getBoundingClientRect(), top = r.height ? Math.max(0, Math.min(r.top, 160)) : (narrow ? 48 : 52);
    var hd = S.head ? S.head.offsetHeight : 36;
    var extra = 0;
    if (S.touch && !float) extra += (S.padsEl.offsetHeight || 72) + 8;
    if (!S.touch) extra += (S.bar.offsetHeight || 22) + 8;
    var avail = vh - top - hd - padY - extra - 8 - S.safeB;
    var ch = float ? avail : narrow ? Math.round(cw * 0.95) : Math.round(cw * 0.56);
    ch = Math.max(240, Math.min(ch, avail));
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stageEl.style.width = cw + 'px'; S.stageEl.style.height = ch + 'px';
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.W = cw; S.H = ch; S.k = S.cv.width / cw;
    S.ppm = clamp(narrow ? Math.min(cw / 9.2, ch / 7) : Math.min(cw / 13, ch / 7.5), 18, 72);
    setView(S.w); setView(S.bgw);
    for (var i = 0; S.rivals && i < S.rivals.length; i++) setView(S.rivals[i].w);
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    bankEndless();
    saveAttempt();
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
    s.w = s.bgw = null; s.rivals = []; s.rec = null; s.ghost = null; s.tiles = null; s.rivalGhosts = null;
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
        '<div class="uh-pad uh-pad-l"><div class="uh-pk" data-k="back"><span class="uh-ar">◄</span><small>LEAN</small></div><div class="uh-pk" data-k="fwd"><span class="uh-ar">►</span><small>LEAN</small></div><div class="uh-pk uh-trick" data-k="trick"><span class="uh-ar">★</span><small>TRICK</small></div></div>' +
        '<div class="uh-pad uh-pad-r"><div class="uh-pk uh-gadk" data-k="gad"><span class="uh-ar">⚡</span><small>GADGET</small></div><div class="uh-pk" data-k="brake"><b>BRAKE</b></div><div class="uh-pk uh-gas" data-k="gas"><b>GAS</b></div></div>' +
      '</div>' +
      '<div class="uh-bar"><span><kbd>→</kbd> gas <kbd>←</kbd> brake <kbd>A</kbd><kbd>D</kbd> lean <kbd>Space</kbd> pose <kbd>⇧</kbd> gadget <kbd>C</kbd> cam <kbd>V</kbd> map <kbd>R</kbd> restart <kbd>P</kbd> pause <kbd>G</kbd> ghost</span></div>' +
      '<div class="uh-ovl" style="display:none"></div><div class="uh-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🏍️ Uphill Rush', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var hb = document.createElement('div');
    hb.className = 'uh-hbtns';
    hb.innerHTML = '<button type="button" class="uh-hb" data-h="cam" title="Camera (C)" aria-label="Camera (C)">' + IC_CAM + '</button>' +
      '<button type="button" class="uh-hb" data-h="restart" title="Restart (R)" aria-label="Restart (R)">' + IC_RESTART + '</button>' +
      '<button type="button" class="uh-hb" data-h="pause" title="Pause (P)" aria-label="Pause (P)">' + IC_PAUSE + '</button>' +
      '<button type="button" class="uh-hb" data-h="menu" title="Menu (Esc)" aria-label="Menu (Esc)">' + IC_MENU + '</button>';
    var hd = p.querySelector('.cade-panel-head');
    if (hd) hd.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var soundOn = sget(SOUND_KEY) === '1';
    S = {
      panel: p, root: p.querySelector('.uh'), stageEl: p.querySelector('.uh-stage'), cv: p.querySelector('.uh-cv'), ovl: p.querySelector('.uh-ovl'),
      padsEl: p.querySelector('.uh-pads'), bar: p.querySelector('.uh-bar'), live: p.querySelector('.uh-live'), head: hd, hb: hb,
      touch: touch, safeB: touch ? safeBottom() : 0, snd: new Snd(soundOn), save: loadSave(),
      w: null, bgw: null, rivals: [], run: null, rec: new Float32Array(REC_CAP * E.GCH), ghost: null, ghostP: null, rivalGhosts: {}, result: null,
      keys: { gas: false, brake: false, back: false, fwd: false, trick: false, gad: false }, pad: { gas: false, brake: false, back: false, fwd: false, trick: false, gad: false },
      raf: 0, last: 0, time: 0, paused: false, ovlKind: null, shake: 0, rng: { s: 12345 }, banked: true, trickSeen: 0,
      hudStage: '', hudSub: '', readyLines: [], fonts: {}, thc: {}, tiles: {}, k: 1, W: 300, H: 200, ppm: 30, gtab: 'veh', locKey: 'dust', evId: '', betOn: false
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    // old (v1) ghosts were for the old stage list; they can't be replayed on the new tracks
    for (var gi = 1; gi <= 12; gi++) if (sget(OLD_GHOST_KEY + gi) != null) sdel(OLD_GHOST_KEY + gi);
    if (S.save.v === 2) writeSave();
    S.bgw = E.newWorld({ track: 'dust1' });
    layout();
    readTheme();
    S.cols = lookCols(S.save.look);
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
      S.resizeT = setTimeout(function () { if (S) { layout(); draw(1); if (S.ovlKind === 'garage') drawPreview(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); S.cols = lookCols(S.save.look); draw(1); if (S.ovlKind === 'garage') drawPreview(); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.padCtl = bindPads(S.padsEl);
    S.ovl.addEventListener('click', onOverlayClick);
    S.ovl.addEventListener('change', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-act') === 'bet' && S) S.betOn = !!t.checked; });
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
      else if (h === 'cam') cycleCam();
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
    description: 'ASCII dirt-bike stunts — career with rivals, bosses and judges, 18 tracks, endless mode, tricks, combos and a garage of trade-offs',
    icon: '🏍️',
    tags: 'game,arcade,fun,train,bike,motorbike,motocross,dirt bike,hill climb,moto,racing,physics,stunts,flip,endless,career,story,buggy,monster truck',
    open: open
  });
})();
