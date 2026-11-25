/* Apex Rush — an original behind-the-wheel pseudo-3D racer for Cade.txt.
 * The road is a list of short segments (curve + start/end height) projected
 * back to front with painter's order, so crests hide what is behind them;
 * tunnels draw their walls and ceiling as rings between segment openings.
 * Roadside props, cars, the dashboard and parallax skylines are drawn with
 * canvas primitives once into small caches and stamped with drawImage.
 * Two modes:
 *   Endless Highway — time attack: checkpoints add time, traffic and curves
 *     ramp up, the biome (coast, desert, forest, city, snow) and the time of
 *     day change at every checkpoint. Distance + score records.
 *   Career — six cups of seeded (stable) tracks, multi-lap races against
 *     5-7 named rivals with their own personalities (light rubber band).
 *     Points + credits per finish; upgrades (engine, grip, nitro, brakes) and
 *     paint in the garage; podium a cup to unlock the next. Saved.
 * Driving: speed-dependent steering, centrifugal pull in curves, drifting
 * (refills nitro), off-road drag and wobble, crashes into props and cars
 * (spins, shake), slipstream behind cars, a nitro tank that recharges, auto
 * gears. Keys, touch pad / screen halves, tilt and gamepads.
 * Offline module, no assets. Storage: cade-povracer-*. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: the road's half width is RW; a segment is SEG long; seconds.
  var STEP = 1 / 60;
  var SEG = 200, RW = 2000, LANES = 3, RUMBLE = 3;
  var CAM_DEPTH = 1 / Math.tan(50 * Math.PI / 180);   // 100° field of view
  var CAM_H = 1000, CAM_H_POV = 540, TUN_H = 3000;
  var V_BASE = SEG * 62;          // the stock car's top speed (units/s)
  var KMH_TOP = 282;              // ... shown as this many km/h
  var CF = 0.3;                   // centrifugal pull in curves
  var CAR_W = 0.34;               // a car's width, in road half-widths
  var CP_LEN = 1500;              // endless: segments between checkpoints
  var LANE_X = [-0.66, 0, 0.66];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeIn(a, b, t) { return a + (b - a) * t * t; }
  function easeInOut(a, b, t) { return a + (b - a) * (0.5 - Math.cos(t * Math.PI) / 2); }
  function rr(r, a, b) { return a + (b - a) * r(); }
  function ri(r, a, b) { return Math.floor(a + (b - a + 1) * r()); }
  function pickW(r, list) {          // [[item, weight], ...]
    var tot = 0, i;
    for (i = 0; i < list.length; i++) tot += list[i][1];
    var x = r() * tot;
    for (i = 0; i < list.length; i++) { x -= list[i][1]; if (x <= 0) return list[i][0]; }
    return list[list.length - 1][0];
  }
  function sgn(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }

  // ---- biomes and palettes ----
  // spr: prop kinds and weights; dens: chance of a prop per segment; lamp: lamp post every n segments
  var BIOMES = [
    { id: 'coast', name: 'Coast', dens: 0.42, lamp: 0, spr: [['palm', 5], ['bush', 2], ['rock', 1.5], ['hut', 0.6], ['billboard', 0.3]] },
    { id: 'desert', name: 'Desert', dens: 0.3, lamp: 0, spr: [['cactus', 5], ['rock', 3], ['scrub', 2], ['billboard', 0.4], ['pole', 0.8]] },
    { id: 'forest', name: 'Forest', dens: 0.7, lamp: 0, spr: [['pine', 6], ['tree', 3], ['rock', 1], ['bush', 1.5], ['pole', 0.6]] },
    { id: 'city', name: 'City', dens: 0.55, lamp: 6, spr: [['bld', 7], ['billboard', 1.4], ['bush', 0.6]] },
    { id: 'snow', name: 'Snow', dens: 0.55, lamp: 0, spr: [['snowpine', 6], ['rock', 1.2], ['snowman', 0.25], ['pole', 0.7]] }
  ];
  // the world's colors (not the app theme: scenery). Each biome has a day and a night palette.
  var PAL_DAY = [
    { sky: [[74, 146, 224], [178, 220, 242]], grass: [[122, 186, 92], [112, 174, 84]], rumble: [[206, 52, 46], [244, 244, 240]], road: [[112, 114, 118], [106, 108, 112]],
      lane: [244, 244, 236], far: [[120, 160, 190], [82, 150, 110]], sea: [52, 128, 196], sun: [255, 246, 214], ground2: [230, 214, 160] },
    { sky: [[226, 126, 70], [250, 212, 150]], grass: [[220, 178, 112], [208, 164, 98]], rumble: [[196, 64, 40], [244, 232, 212]], road: [[118, 106, 98], [110, 99, 92]],
      lane: [252, 236, 200], far: [[196, 104, 70], [158, 76, 48]], sun: [255, 232, 170] },
    { sky: [[88, 146, 206], [204, 226, 234]], grass: [[72, 138, 62], [64, 126, 54]], rumble: [[196, 48, 44], [240, 240, 236]], road: [[104, 106, 110], [97, 99, 103]],
      lane: [240, 240, 230], far: [[104, 132, 162], [52, 98, 66]], sun: [255, 248, 220] },
    { sky: [[92, 96, 150], [216, 170, 150]], grass: [[118, 120, 124], [110, 112, 116]], rumble: [[226, 196, 46], [52, 52, 56]], road: [[84, 85, 90], [78, 79, 84]],
      lane: [246, 236, 180], far: [[112, 112, 148], [80, 82, 112]], sun: [255, 214, 170] },
    { sky: [[146, 172, 202], [228, 234, 242]], grass: [[236, 241, 246], [222, 230, 238]], rumble: [[204, 44, 56], [250, 250, 252]], road: [[128, 131, 138], [121, 124, 131]],
      lane: [250, 220, 90], far: [[176, 190, 212], [128, 148, 176]], sun: [255, 252, 240] }
  ];
  function dim(c, k, tint) { tint = tint || [0, 0, 0]; return [c[0] * k + tint[0], c[1] * k + tint[1], c[2] * k + tint[2]]; }
  function palette(b, night) {
    var d = PAL_DAY[b], P = {};
    if (!night) {
      for (var k in d) P[k] = d[k];
      P.night = 0; P.fog = d.sky[1];
      return P;
    }
    var tint = [4, 6, 18];
    P.night = 1;
    P.sky = b === 3 ? [[8, 6, 24], [58, 34, 82]] : [[6, 10, 28], dim(d.sky[0], 0.22, [14, 16, 40])];
    P.fog = P.sky[1];
    P.grass = [dim(d.grass[0], 0.26, tint), dim(d.grass[1], 0.26, tint)];
    P.rumble = [dim(d.rumble[0], 0.46, tint), dim(d.rumble[1], 0.46, tint)];
    P.road = [dim(d.road[0], 0.34, tint), dim(d.road[1], 0.34, tint)];
    P.lane = dim(d.lane, 0.7);
    P.far = [dim(d.far[0], 0.26, [6, 8, 24]), dim(d.far[1], 0.2, [4, 6, 18])];
    if (d.sea) P.sea = dim(d.sea, 0.25, tint);
    if (d.ground2) P.ground2 = dim(d.ground2, 0.3, tint);
    P.sun = [236, 236, 250];
    return P;
  }

  // ---- props: world size (units), collision half-width as a share of the width ----
  var SPR = {
    palm: { w: 1100, h: 2300, hit: 0.14 }, pine: { w: 1000, h: 2300, hit: 0.18 }, snowpine: { w: 1050, h: 2300, hit: 0.18 },
    tree: { w: 1400, h: 2000, hit: 0.16 }, cactus: { w: 650, h: 1300, hit: 0.28 }, rock: { w: 900, h: 620, hit: 0.42 },
    bush: { w: 900, h: 480, hit: 0 }, scrub: { w: 700, h: 420, hit: 0 }, chev: { w: 640, h: 900, hit: 0.2 },
    lamp: { w: 900, h: 2500, hit: 0.08 }, bld: { w: 3400, h: 5200, hit: 0.48 }, billboard: { w: 2400, h: 2400, hit: 0.42 },
    pole: { w: 500, h: 2600, hit: 0.1 }, hut: { w: 1700, h: 1300, hit: 0.45 }, snowman: { w: 520, h: 800, hit: 0.35 },
    gate: { w: 0, h: 0, hit: 0 }
  };
  function sprHalf(k) { var d = SPR[k]; return d ? d.w * d.hit / RW : 0; }   // road units

  // ---- tracks ----
  // A track is a list of segments { i, c (curve), y1, y2, b (biome), n (night), tun, spr, cp, fin }.
  // Loop tracks (career) wrap; the endless track is generated ahead on demand and trimmed behind.
  function newTrack(o) {
    var T = {
      loop: !!o.loop, segs: [], base: 0, n: 0, y: 0, o: o, rng: mulberry32((o.seed >>> 0) || 1),
      biome: o.biome || 0, night: o.night ? 1 : 0, tun: 0, chev: 0, chevDir: 0, secN: 0, name: o.name || ''
    };
    if (T.loop) {
      addRoad(T, 0, 50, 0, 0, 0);
      for (var f = 0; f < 3; f++) T.segs[f].fin = 1;
      addSpr(T.segs[0], 'gate', 0, 1);
      var target = o.len || 2000;
      while (T.segs.length < target - 140) genSection(T, 1);
      addRoad(T, 30, 40, 30, 0, -T.y / SEG);
      addRoad(T, 0, 40, 0, 0, 0);
      T.n = T.segs.length;
      T.segs[T.n - 1].y2 = 0;
    } else {
      addRoad(T, 0, 60, 0, 0, 0);
    }
    return T;
  }
  function legOf(i) { return Math.floor(i / CP_LEN); }
  function legBiome(T, leg) { return ((T.o.biome || 0) + leg) % BIOMES.length; }
  function legNight(T, leg) { var b = legBiome(T, leg); return b === 3 || leg % 3 === 2 ? 1 : 0; }
  function addSeg(T, curve, y) {
    var i = T.base + T.segs.length;
    var b = T.biome, nt = T.night, cp = 0;
    if (!T.loop) { var lg = legOf(i); b = legBiome(T, lg); nt = legNight(T, lg); cp = i > 0 && i % CP_LEN === 0 ? 1 : 0; }
    var s = { i: i, c: curve, y1: T.y, y2: y, b: b, n: nt, tun: T.tun, spr: null, cp: cp, fin: 0 };
    T.y = y;
    T.segs.push(s);
    decorate(T, s);
    return s;
  }
  function addRoad(T, enter, hold, leave, curve, dy) {
    var y0 = T.y, y1 = y0 + dy * SEG, tot = Math.max(1, enter + hold + leave), n;
    for (n = 0; n < enter; n++) addSeg(T, easeIn(0, curve, n / enter), easeInOut(y0, y1, n / tot));
    for (n = 0; n < hold; n++) addSeg(T, curve, easeInOut(y0, y1, (enter + n) / tot));
    for (n = 0; n < leave; n++) addSeg(T, easeInOut(curve, 0, n / leave), easeInOut(y0, y1, (enter + hold + n) / tot));
    if (tot && T.segs.length) T.segs[T.segs.length - 1].y2 = y1, T.y = y1;
  }
  // one stretch of road; lvl (0-1) scales how sharp and hilly it may be
  function genSection(T, lvl) {
    var r = T.rng, o = T.o, ck = o.curveK == null ? 1 : o.curveK, hk = o.hillK == null ? 1 : o.hillK;
    var cmax = 1.6 + 4.6 * lvl * ck, hmax = 8 + 34 * lvl * hk;
    function L(a, b) { return ri(r, a, b); }
    function hill() {
      if (r() < 0.4) return 0;
      var h = (r() * 2 - 1) * hmax, cur = T.y / SEG;
      return clamp(cur + h, -70, 70) - cur;
    }
    T.secN++;
    var tp = o.tunnels == null ? 0.06 : o.tunnels;
    if (T.secN > 2 && r() < tp && !T.noTun) {
      T.tun = 1;
      addRoad(T, L(8, 16), L(40, 90), L(8, 16), (r() * 2 - 1) * cmax * 0.45, 0);
      T.tun = 0;
      addRoad(T, 0, 8, 0, 0, 0);
      return;
    }
    var k = r(), dir = r() < 0.5 ? -1 : 1, c;
    if (k < 0.2) addRoad(T, L(15, 30), L(20, 60), L(15, 30), 0, hill());
    else if (k < 0.66) {
      c = rr(r, 1.4, cmax) * dir;
      chevrons(T, c);
      addRoad(T, L(15, 35), L(20, 70), L(15, 35), c, hill());
    } else if (k < 0.86) {
      c = rr(r, 1.4, cmax) * dir;
      chevrons(T, c);
      addRoad(T, L(12, 28), L(15, 40), L(12, 28), c, hill() * 0.5);
      c = -rr(r, 1.4, cmax) * dir;
      chevrons(T, c);
      addRoad(T, L(12, 28), L(15, 40), L(12, 28), c, hill() * 0.5);
    } else {
      var n = ri(r, 2, 4), h = Math.max(6, hmax * 0.45);
      for (var j = 0; j < n; j++) addRoad(T, L(10, 18), L(5, 15), L(10, 18), j === 1 ? dir * cmax * 0.3 : 0, (j % 2 ? -1 : 1) * h);
    }
  }
  function chevrons(T, c) { if (Math.abs(c) >= 3) { T.chev = 22; T.chevDir = sgn(c); } }
  function addSpr(s, k, o, f) { (s.spr || (s.spr = [])).push({ k: k, o: o, hw: sprHalf(k), f: f || 0, v: 0 }); }
  function decorate(T, s) {
    var r = T.rng, B = BIOMES[s.b];
    if (s.tun) return;
    if (T.chev > 0) {
      if (T.chev % 4 === 0) addSpr(s, 'chev', T.chevDir * 1.32, T.chevDir);
      T.chev--;
    }
    if (s.cp) { addSpr(s, 'gate', 0, 0); return; }
    if (T.loop && s.i < 12) return;
    if (B.lamp && s.i % B.lamp === 0) addSpr(s, 'lamp', (s.i / B.lamp) % 2 ? 1.22 : -1.22, (s.i / B.lamp) % 2 ? -1 : 1);
    if (r() < B.dens) {
      var k = pickW(r, B.spr), side = r() < 0.5 ? -1 : 1;
      var o = k === 'bld' ? rr(r, 1.9, 3.4) : k === 'billboard' || k === 'hut' ? rr(r, 1.75, 2.6) : k === 'rock' ? rr(r, 1.3, 2.4) : rr(r, 1.3, 3.2);
      if (s.spr && s.spr.length && Math.abs(s.spr[0].o - side * o) < 0.7) return;
      addSpr(s, k, side * o, side);
      s.spr[s.spr.length - 1].v = ri(r, 0, 3);
    }
  }
  function ensure(T, i) {
    if (T.loop) return;
    while (T.base + T.segs.length <= i + 2) genSection(T, clamp(legOf(T.base + T.segs.length) / 7, 0.05, 1));
  }
  function trim(T, i) {
    if (T.loop) return;
    if (i - T.base > 400) { T.segs.splice(0, 200); T.base += 200; }
  }
  function segAt(T, i) {
    if (T.loop) return T.segs[((i % T.n) + T.n) % T.n];
    ensure(T, i);
    return T.segs[Math.max(0, i - T.base)];
  }
  function trackLen(T) { return T.loop ? T.n * SEG : Infinity; }
  function heightAt(T, z) {
    var i = Math.floor(z / SEG), s = segAt(T, i), f = z / SEG - i;
    return lerp(s.y1, s.y2, f);
  }

  // ---- names, rivals, cups ----
  var TRACK_WORDS = [
    [['Saltwind', 'Gullrock', 'Tidewater', 'Coral', 'Seaspray', 'Driftwood'], ['Bay', 'Point', 'Strand', 'Causeway', 'Cove', 'Run']],
    [['Ember', 'Dustdevil', 'Red Mesa', 'Sunscorch', 'Mirage', 'Cinder'], ['Flats', 'Canyon', 'Basin', 'Gulch', 'Ridge', 'Wash']],
    [['Fernhollow', 'Pinecrest', 'Mossgate', 'Timber', 'Cedar', 'Wildwood'], ['Pass', 'Loop', 'Hollow', 'Trail', 'Glen', 'Bends']],
    [['Neon', 'Midnight', 'Chrome', 'Skyline', 'Harbor', 'Arclight'], ['Avenue', 'Circuit', 'Boulevard', 'Docks', 'Heights', 'Mile']],
    [['Frostpeak', 'Glacier', 'Whiteout', 'Icefall', 'Rime', 'Aurora'], ['Summit', 'Col', 'Switchbacks', 'Ridge', 'Traverse', 'Bowl']]
  ];
  var DRIVERS = [
    { id: 'vex', name: 'Vex Morrow', trait: 'aggressive', pace: 1.025, grip: 0.93, aggr: 0.9, cons: 0.7, react: 0.12, col: [214, 44, 70] },
    { id: 'juno', name: 'Juno Park', trait: 'steady', pace: 1.0, grip: 0.9, aggr: 0.25, cons: 0.97, react: 0.25, col: [40, 120, 220] },
    { id: 'rook', name: 'Rook Abara', trait: 'late braker', pace: 1.01, grip: 1.02, aggr: 0.55, cons: 0.78, react: 0.3, col: [236, 150, 30] },
    { id: 'lia', name: 'Lia Santos', trait: 'smooth', pace: 0.995, grip: 0.86, aggr: 0.3, cons: 0.92, react: 0.2, col: [36, 170, 120] },
    { id: 'odo', name: 'Odo Kett', trait: 'careful', pace: 0.975, grip: 0.82, aggr: 0.1, cons: 0.95, react: 0.35, col: [150, 150, 160] },
    { id: 'mika', name: 'Mika Rhee', trait: 'fast starter', pace: 0.99, grip: 0.92, aggr: 0.5, cons: 0.82, react: 0.02, col: [160, 80, 220] },
    { id: 'bram', name: 'Bram Holt', trait: 'blocker', pace: 0.985, grip: 0.92, aggr: 1.0, cons: 0.85, react: 0.28, col: [120, 84, 50] },
    { id: 'tess', name: 'Tess Vane', trait: 'erratic', pace: 1.03, grip: 0.95, aggr: 0.6, cons: 0.55, react: 0.2, col: [250, 210, 40] },
    { id: 'nia', name: 'Nia Volk', trait: 'clinical', pace: 1.015, grip: 0.88, aggr: 0.35, cons: 0.96, react: 0.15, col: [20, 190, 210] },
    { id: 'cole', name: 'Cole Ferris', trait: 'hothead', pace: 1.02, grip: 0.98, aggr: 0.8, cons: 0.6, react: 0.1, col: [240, 100, 150] }
  ];
  var CUPS = [
    { name: 'Rookie Cup', n: 3, laps: 2, pace: 0.86, curveK: 0.5, hillK: 0.5, tunnels: 0.03, rivals: 5, len: 1700, biomes: [0, 2, 1], nights: [0, 0, 0], prize: 1500 },
    { name: 'Coastal Cup', n: 3, laps: 3, pace: 0.93, curveK: 0.65, hillK: 0.7, tunnels: 0.06, rivals: 6, len: 1900, biomes: [0, 1, 0], nights: [0, 0, 1], prize: 2400 },
    { name: 'Timberline Cup', n: 4, laps: 3, pace: 0.99, curveK: 0.78, hillK: 0.9, tunnels: 0.08, rivals: 6, len: 2000, biomes: [2, 4, 2, 1], nights: [0, 0, 1, 0], prize: 3600 },
    { name: 'Midnight Cup', n: 4, laps: 3, pace: 1.05, curveK: 0.88, hillK: 0.8, tunnels: 0.12, rivals: 7, len: 2100, biomes: [3, 3, 0, 3], nights: [1, 1, 1, 1], prize: 5000 },
    { name: 'Summit Cup', n: 4, laps: 3, pace: 1.1, curveK: 1.0, hillK: 1.1, tunnels: 0.1, rivals: 7, len: 2200, biomes: [4, 2, 4, 1], nights: [0, 1, 0, 1], prize: 7000 },
    { name: 'Apex Masters', n: 5, laps: 3, pace: 1.16, curveK: 1.12, hillK: 1.1, tunnels: 0.12, rivals: 7, len: 2300, biomes: [3, 4, 1, 2, 0], nights: [1, 0, 1, 1, 0], prize: 10000 }
  ];
  var DIFFS = [
    { name: 'Easy', ai: 0.93, traffic: 0.7, bonus: 1.25, time0: 55 },
    { name: 'Normal', ai: 1.0, traffic: 1.0, bonus: 1.0, time0: 46 },
    { name: 'Hard', ai: 1.05, traffic: 1.35, bonus: 0.85, time0: 40 }
  ];
  var POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
  var CREDITS = [1500, 1100, 850, 650, 500, 400, 300, 250];
  var UPG_COST = [600, 1300, 2300, 3600, 5400];
  var UPGS = [
    { id: 'eng', name: 'Engine', note: 'top speed + acceleration' },
    { id: 'grip', name: 'Grip', note: 'less slide in curves' },
    { id: 'nos', name: 'Nitro', note: 'bigger tank, faster refill' },
    { id: 'brk', name: 'Brakes', note: 'stop shorter' }
  ];
  var PAINTS = [
    { name: 'Theme', col: null, cost: 0 }, { name: 'Signal Red', col: [214, 40, 40], cost: 0 }, { name: 'Glacier', col: [236, 240, 244], cost: 0 },
    { name: 'Ink', col: [34, 36, 44], cost: 400 }, { name: 'Lime', col: [130, 210, 40], cost: 600 }, { name: 'Tangerine', col: [250, 130, 30], cost: 600 },
    { name: 'Cobalt', col: [40, 80, 220], cost: 800 }, { name: 'Orchid', col: [200, 80, 200], cost: 1000 }, { name: 'Gold Leaf', col: [222, 176, 52], cost: 1500 },
    { name: 'Teal Pearl', col: [20, 180, 170], cost: 1500 }
  ];

  function trackName(seed, biome) {
    var r = mulberry32(seed ^ 0x51ed), w = TRACK_WORDS[biome];
    return w[0][Math.floor(r() * w[0].length)] + ' ' + w[1][Math.floor(r() * w[1].length)];
  }
  function cupSeed(ci, ti) { return 7919 * (ci + 1) + 104729 * (ti + 1) + 17; }
  function cupTrack(ci, ti) {
    var C = CUPS[ci], seed = cupSeed(ci, ti), b = C.biomes[ti % C.biomes.length], nt = C.nights[ti % C.nights.length];
    return { seed: seed, biome: b, night: nt, name: trackName(seed, b), laps: C.laps, len: C.len + ((seed >> 3) % 5) * 60, curveK: C.curveK, hillK: C.hillK, tunnels: C.tunnels };
  }
  function cupRivals(ci) {
    var r = mulberry32(cupSeed(ci, 99)), ids = DRIVERS.map(function (d) { return d; });
    for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    return ids.slice(0, CUPS[ci].rivals);
  }

  // ---- cars ----
  function carStats(u) {
    u = u || {};
    var e = u.eng || 0, g = u.grip || 0, n = u.nos || 0, b = u.brk || 0;
    return {
      top: V_BASE * (1 + 0.048 * e), acc: V_BASE * (0.25 + 0.02 * e), brk: V_BASE * (0.95 + 0.17 * b),
      grip: 1 - 0.075 * g, nosCap: 2.6 + 0.5 * n, nosRe: 0.04 + 0.014 * n
    };
  }
  function newPlayer(st, z, x) {
    return { z: z, x: x || 0, v: 0, st: st, steer: 0, nos: 1, nosOn: 0, draft: 0, drafting: 0, spin: 0, spinDir: 1, drift: 0, off: 0, hitT: 0, scrapeT: 0,
      lapSeen: 0, fin: 0, finT: 0, bestLap: 0, lapT0: 0, place: 0, gear: 1, rpm: 0, bump: 0 };
  }
  var KINDS = { coupe: { w: 1, len: 0.9 }, sedan: { w: 1.04, len: 0.95 }, van: { w: 1.08, len: 1 }, truck: { w: 1.24, len: 1.6 } };
  function newCar(o) {
    return { id: o.id || '', kind: o.kind || 'sedan', col: o.col || [200, 200, 200], name: o.name || '', z: o.z || 0, x: o.x || 0, tx: o.x || 0, v: o.v || 0,
      top: o.top || V_BASE * 0.5, acc: o.acc || V_BASE * 0.2, def: o.def || null, rival: !!o.rival, fin: 0, finT: 0, ahead: 1, mist: 0, wait: o.wait || 0, sp: 0, laneT: 0, hitT: 0, spin: 0 };
  }
  function carW(c) { return CAR_W * (KINDS[c.kind] ? KINDS[c.kind].w : 1); }

  // ---- games ----
  function newEndless(o) {
    var seed = (o.seed >>> 0) || 1, d = DIFFS[o.diff == null ? 1 : o.diff];
    var T = newTrack({ seed: seed, loop: false, biome: o.biome == null ? seed % BIOMES.length : o.biome, curveK: 1, hillK: 1, tunnels: 0.07 });
    var g = {
      mode: 'endless', T: T, diff: o.diff == null ? 1 : o.diff, D: d, rng: mulberry32(seed ^ 0x9e3779b9), t: 0, phase: 'count', countT: 3.2, lastBeep: 4,
      p: newPlayer(o.stats || carStats({ eng: 2, grip: 2, nos: 2, brk: 2 }), SEG * 8, 0), cars: [], ev: [],
      timeLeft: d.time0, dist: 0, score: 0, bonus: 0, cpIdx: 0, passes: 0, near: 0, combo: 0, comboT: 0, overT: 0, laps: 0, L: Infinity
    };
    for (var i = 0; i < 10; i++) spawnTraffic(g, true);
    return g;
  }
  function newRace(o) {
    var C = CUPS[o.cup], tk = o.track || cupTrack(o.cup, o.ti || 0), d = DIFFS[o.diff == null ? 1 : o.diff];
    var T = newTrack({ seed: tk.seed, loop: true, biome: tk.biome, night: tk.night, len: tk.len, curveK: tk.curveK, hillK: tk.hillK, tunnels: tk.tunnels, name: tk.name });
    var rivals = o.rivals || cupRivals(o.cup), N = rivals.length + 1, L = T.n * SEG;
    var g = {
      mode: 'career', T: T, diff: o.diff == null ? 1 : o.diff, D: d, rng: mulberry32(tk.seed ^ 0x2545f491), t: 0, phase: 'count', countT: 3.2, lastBeep: 4,
      cup: o.cup, ti: o.ti || 0, name: tk.name, laps: o.laps || tk.laps, L: L, cars: [], ev: [], p: null, N: N, timeLeft: 0, dist: 0, score: 0
    };
    var pSlot = Math.min(N - 1, Math.floor(N * 0.62)), slot = 0;
    for (var k = 0; k < N; k++) {
      var z = -SEG * (3 + k * 2.6), x = k % 2 ? 0.42 : -0.42;
      if (k === pSlot) { g.p = newPlayer(o.stats || carStats({}), z, x); continue; }
      var R = rivals[slot++], top = V_BASE * C.pace * d.ai * (1 + (R.pace - 1) * 2.6) * (0.97 + 0.06 * g.rng());
      g.cars.push(newCar({ id: R.id, name: R.name, kind: 'coupe', col: R.col, z: z, x: x, top: top, acc: V_BASE * (0.24 + 0.04 * R.cons) * C.pace,
        def: R, rival: true, wait: R.react + 0.1 * g.rng() }));
    }
    g.p.lapT0 = 0;
    return g;
  }
  function spawnTraffic(g, initial) {
    var p = g.p, r = g.rng, lane = Math.floor(r() * 3), k = r();
    var z = p.z + SEG * (initial ? rr(r, 14, 170) : rr(r, 150, 185));
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i];
      if (Math.abs(c.z - z) < SEG * 10 && Math.abs(c.x - LANE_X[lane]) < 0.4) return null;
    }
    var kind = k < 0.55 ? 'sedan' : k < 0.8 ? 'van' : 'truck';
    var cols = [[200, 60, 50], [60, 110, 200], [230, 230, 230], [60, 60, 66], [220, 180, 50], [70, 160, 90], [150, 90, 170], [210, 120, 60]];
    var c2 = newCar({ kind: kind, col: cols[Math.floor(r() * cols.length)], z: z, x: LANE_X[lane], top: V_BASE * (kind === 'truck' ? rr(r, 0.32, 0.42) : rr(r, 0.38, 0.58)) });
    c2.v = c2.top;
    g.cars.push(c2);
    return c2;
  }
  // a car's distance ahead of the player (loops: the shortest way, -L/3 .. 2L/3)
  function relZ(g, c) {
    var d = c.z - g.p.z;
    if (g.L !== Infinity) { d = ((d % g.L) + g.L) % g.L; if (d > g.L * 0.66) d -= g.L; }
    return d;
  }

  // ---- the step ----
  // inp: { steer -1..1, gas 0..1, brake 0/1, nos 0/1, sens }
  function step(g, inp, dt) {
    dt = dt || STEP;
    var p = g.p;
    if (g.phase === 'done') return;
    g.t += dt;
    if (g.phase === 'count') {
      g.countT -= dt;
      var c = Math.ceil(g.countT);
      if (c < g.lastBeep && c > 0) { g.lastBeep = c; g.ev.push({ t: 'beep', n: c }); }
      if (g.countT <= 0) { g.phase = 'race'; g.t = 0; g.ev.push({ t: 'go' }); }
      inp = { steer: inp.steer, gas: 0, brake: 1, nos: 0, sens: inp.sens };
      p.rev = inp.gas ? 1 : 0;
    }
    var live = g.phase === 'race' && !p.fin;
    if (!live && g.phase !== 'count') {
      // finished or out of time: the car rolls to a stop / cruises home
      inp = g.mode === 'career' ? { steer: clamp(-p.x * 1.4 + autoSteer(g), -1, 1), gas: p.v < p.st.top * 0.55 ? 1 : 0, brake: 0, nos: 0, sens: 1 }
        : { steer: 0, gas: 0, brake: p.v > 0 ? 0.35 : 0, nos: 0, sens: 1 };
    }
    stepPlayer(g, inp, dt);
    if (g.mode === 'endless') stepTraffic(g, dt); else stepRivals(g, dt);
    collideCars(g, dt);
    if (g.phase === 'count') return;
    if (g.mode === 'endless') stepEndless(g, dt); else stepCareer(g, dt);
    trim(g.T, Math.floor(p.z / SEG) - 40);
  }
  // the line an autopilot holds through a curve
  function autoSteer(g) { var s = segAt(g.T, Math.floor(g.p.z / SEG) + 2), sp = g.p.v / g.p.st.top; return clamp(sp * s.c * CF * g.p.st.grip * 1.05, -1, 1); }

  function stepPlayer(g, inp, dt) {
    var p = g.p, st = p.st, T = g.T, si = Math.floor(p.z / SEG), s = segAt(T, si), sp = p.v / st.top;
    var target = p.spin > 0 ? 0 : clamp(inp.steer || 0, -1, 1) * (inp.sens || 1);
    target = clamp(target, -1.35, 1.35);
    p.steer += (target - p.steer) * Math.min(1, dt * (Math.abs(target) > Math.abs(p.steer) ? 8 : 12));
    var dx = dt * 2.1 * Math.min(1, sp * 1.15 + (p.v > 1 ? 0.06 : 0));
    p.x += dx * p.steer;
    p.x -= dx * sp * s.c * CF * st.grip;
    // drift: steering hard into a fast curve slides the tail (and refills nitro)
    var drifting = sp > 0.6 && Math.abs(s.c) > 2 && Math.abs(p.steer) > 0.55 && sgn(p.steer) === sgn(s.c) && !p.off;
    p.drift = drifting ? Math.min(1, p.drift + dt * 3) : Math.max(0, p.drift - dt * 4);
    if (p.spin > 0) { p.spin -= dt; p.x += p.spinDir * dx * 0.5; }
    var top = st.top, acc = st.acc;
    // slipstream: tucked in behind a car
    var dr = draftTarget(g);
    if (dr && sp > 0.45 && p.spin <= 0) { p.draft = Math.min(1, p.draft + dt * 0.75); }
    else p.draft = Math.max(0, p.draft - dt * 1.6);
    var wasDr = p.drafting;
    p.drafting = p.draft > 0.55 ? 1 : 0;
    if (p.drafting) { top *= 1 + 0.085 * p.draft; acc *= 1.35; }
    if (p.drafting && !wasDr) g.ev.push({ t: 'draft' });
    // nitro
    var wasN = p.nosOn;
    if (inp.nos && p.nos > (wasN ? 0 : 0.12) && p.v > st.top * 0.12 && p.spin <= 0) {     // needs a little in the tank to light up
      p.nosOn = 1; p.nos = Math.max(0, p.nos - dt / st.nosCap); top *= 1.3; acc *= 2.1;
    } else { p.nosOn = 0; p.nos = Math.min(1, p.nos + dt * st.nosRe * (1 + p.drift * 3)); }
    if (p.nosOn && !wasN) g.ev.push({ t: 'nos' });
    // off the road
    var off = Math.abs(p.x) > 1.02;
    p.off = off ? 1 : 0;
    if (off) {
      top = Math.min(top, st.top * 0.42);
      if (p.v > st.top * 0.1) p.x += Math.sin(g.t * 37) * 0.006 * sp;
    }
    // tunnels have walls
    if (s.tun && Math.abs(p.x) > 1.0) {
      p.x = sgn(p.x) * 1.0;
      p.v *= Math.pow(0.55, dt);
      if (p.scrapeT <= 0 && p.v > st.top * 0.15) { g.ev.push({ t: 'scrape', side: sgn(p.x) }); p.scrapeT = 0.25; }
    }
    p.scrapeT -= dt;
    var gas = clamp(inp.gas || 0, 0, 1), brake = clamp(inp.brake || 0, 0, 1);
    if (gas > 0 && p.v < top) p.v += acc * gas * dt * (1 - 0.6 * (p.v / top) * (p.v / top));
    else if (!brake) p.v -= st.top * 0.17 * dt;
    if (brake) p.v -= st.brk * brake * dt;
    if (p.v > top) p.v = Math.max(top, p.v - Math.max(st.top * 0.25, (p.v - top) * 2) * dt);
    p.v -= (s.y2 - s.y1) / SEG * st.top * 0.1 * dt;          // hills: uphill drags, downhill pulls
    if (p.spin > 0) p.v -= st.top * 0.35 * dt;
    p.v = clamp(p.v, 0, st.top * 1.5);
    p.x = clamp(p.x, -2.6, 2.6);
    p.z += p.v * dt;
    p.hitT -= dt;
    // auto gearbox (for the tach and the engine note)
    var f = clamp(p.v / (st.top * 1.02), 0, 1.3), gr = Math.min(6, 1 + Math.floor(Math.pow(Math.min(f, 0.999), 0.85) * 6));
    var lo = Math.pow((gr - 1) / 6, 1 / 0.85), hi = Math.pow(gr / 6, 1 / 0.85);
    p.gear = gr;
    p.rpm = g.phase === 'count' ? (p.rev ? 0.7 : 0.15) : clamp(0.18 + 0.8 * (f - lo) / (hi - lo), 0.12, 1.05);
    // roadside props
    if (Math.abs(p.x) > 0.9 && p.hitT <= 0) {
      for (var q = 0; q < 2; q++) {
        var ss = segAt(T, si + q);
        if (!ss.spr) continue;
        for (var j = 0; j < ss.spr.length; j++) {
          var sp2 = ss.spr[j];
          if (sp2.hw <= 0) continue;
          if (Math.abs(p.x - sp2.o) < sp2.hw + CAR_W * 0.5) { crash(g, sp2); q = 2; break; }
        }
      }
    }
  }
  function crash(g, spr) {
    var p = g.p, sp = p.v / p.st.top, hard = sp > 0.33;
    p.v *= hard ? 0.18 : 0.5;
    var side = sgn(spr.o) || 1;
    p.x = spr.o - side * (spr.hw + CAR_W * 0.62);
    if (hard) { p.spin = 0.9; p.spinDir = -side; }
    p.hitT = 0.35;
    g.ev.push({ t: 'crash', hard: hard, k: spr.k });
    if (g.mode === 'endless') { g.combo = 0; }
  }
  function draftTarget(g) {
    var p = g.p, best = null, bd = SEG * 16;
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i], d = relZ(g, c);
      if (d > SEG * 0.8 && d < bd && Math.abs(c.x - p.x) < 0.3 && c.v > p.st.top * 0.3) { bd = d; best = c; }
    }
    return best;
  }

  function stepTraffic(g, dt) {
    var p = g.p, r = g.rng, leg = legOf(Math.floor(p.z / SEG));
    var want = Math.min(28, Math.round((6 + 2.4 * leg) * g.D.traffic));
    if (g.phase === 'race' && g.cars.length < want && r() < dt * 6) spawnTraffic(g, false);
    for (var i = g.cars.length - 1; i >= 0; i--) {
      var c = g.cars[i];
      if (c.z < p.z - SEG * 30 || c.z > p.z + SEG * 260) { g.cars.splice(i, 1); continue; }
      // follow the car ahead in the lane, wander between lanes now and then
      var tv = c.top;
      for (var j = 0; j < g.cars.length; j++) {
        var o = g.cars[j];
        if (o !== c && o.z > c.z && o.z - c.z < SEG * 6 && Math.abs(o.x - c.x) < 0.45) tv = Math.min(tv, o.v * 0.98);
      }
      c.laneT -= dt;
      if (c.laneT <= 0) {
        c.laneT = rr(r, 3, 9);
        if (r() < (c.kind === 'truck' ? 0.15 : 0.35) && Math.abs(c.z - p.z) > SEG * 6) {
          var li = LANE_X.indexOf(c.tx), ni = clamp(li + (r() < 0.5 ? -1 : 1), 0, 2);
          if (li >= 0 && laneFree(g, c, LANE_X[ni])) c.tx = LANE_X[ni];
        }
      }
      c.x += clamp(c.tx - c.x, -dt * 0.5, dt * 0.5);
      c.v += clamp(tv - c.v, -V_BASE * 0.5 * dt, V_BASE * 0.12 * dt);
      if (c.spin > 0) { c.spin -= dt; c.v *= Math.pow(0.4, dt); }
      c.z += c.v * dt;
      c.hitT -= dt;
    }
  }
  function laneFree(g, c, x) {
    for (var i = 0; i < g.cars.length; i++) {
      var o = g.cars[i];
      if (o !== c && Math.abs(o.x - x) < 0.45 && Math.abs(o.z - c.z) < SEG * 12) return false;
    }
    return true;
  }

  function stepRivals(g, dt) {
    var p = g.p, r = g.rng, T = g.T, L = g.L;
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i], D = c.def;
      if (g.phase === 'count') { c.v = 0; continue; }
      if (c.wait > 0) { c.wait -= dt; continue; }
      var si = Math.floor(c.z / SEG), maxC = 0;
      for (var k = 0; k < 14; k += 2) maxC = Math.max(maxC, Math.abs(segAt(T, si + k).c));
      // corner speed: what this driver's grip allows through the sharpest bend ahead
      var cap = maxC > 0.4 ? Math.min(1, 1 / (maxC * CF * D.grip)) : 1;
      cap = Math.min(1, cap * (1.04 + 0.04 * (1 - D.grip)));
      // light rubber band
      var gap = p.z - c.z, rub = clamp(gap / (SEG * 260), -1, 1) * (gap > 0 ? 0.05 : 0.035);
      if (p.fin) rub = 0;
      // mistakes: the less consistent, the more often they lift
      if (c.mist > 0) c.mist -= dt;
      else if (r() < dt * (1 - D.cons) * 0.22) c.mist = rr(r, 0.5, 1.4);
      // nitro on straights: everyone has a tank; the aggressive fire it sooner
      if (c.nos == null) c.nos = 1;
      if (c.nosOn > 0) { c.nosOn -= dt; c.nos = Math.max(0, c.nos - dt / 3); }
      else { c.nos = Math.min(1, c.nos + dt * 0.035); if (maxC < 0.8 && c.nos > 0.6 && c.v > c.top * 0.8 && r() < dt * (0.15 + 0.35 * D.aggr)) c.nosOn = rr(r, 1, 2.5); }
      if (maxC > 1.5) c.nosOn = 0;
      var target = c.top * (1 + rub) * cap * (c.mist > 0 ? 0.8 : 1) * (c.nosOn > 0 ? 1.22 : 1);
      if (c.fin) target = c.top * 0.55;
      if (c.spin > 0) { c.spin -= dt; target *= 0.3; }
      // traffic ahead: pass or wait
      var blockV = 99999, ahead = null;
      var others = g.cars.concat([{ z: p.z, x: p.x, v: p.v, me: 1 }]);
      for (var j = 0; j < others.length; j++) {
        var o = others[j];
        if (o === c) continue;
        var d = o.z - c.z;
        if (L !== Infinity) { d = ((d % L) + L) % L; if (d > L / 2) d -= L; }
        if (d > 0 && d < SEG * 7 && Math.abs(o.x - c.x) < CAR_W * 1.15) { if (o.v < blockV) { blockV = o.v; ahead = o; } }
      }
      c.laneT -= dt;
      if (ahead && c.laneT <= 0) {
        var left = clamp(ahead.x - 0.55, -0.85, 0.85), right = clamp(ahead.x + 0.55, -0.85, 0.85);
        c.tx = Math.abs(left - c.x) < Math.abs(right - c.x) ? (Math.abs(left - ahead.x) > 0.4 ? left : right) : (Math.abs(right - ahead.x) > 0.4 ? right : left);
        c.laneT = 0.8;
      } else if (!ahead && c.laneT <= -2) {
        // racing line: hug the inside of the next bend; blockers drift toward a player close behind
        var nc = segAt(T, si + 10).c, line = clamp(-sgn(nc) * Math.min(0.55, Math.abs(nc) * 0.12), -0.6, 0.6);
        var pg = c.z - p.z;
        if (L !== Infinity) { pg = ((pg % L) + L) % L; if (pg > L / 2) pg -= L; }
        if (D.aggr > 0.7 && pg > 0 && pg < SEG * 9) line = clamp(p.x, -0.7, 0.7);
        c.tx = line; c.laneT = -1;
      }
      if (ahead) target = Math.min(target, Math.max(blockV * 0.97, target * (ahead.me ? 0.92 : 0.85)));
      if (c.v < target) c.v += c.acc * dt * (1 - 0.5 * (c.v / c.top) * (c.v / c.top));
      else c.v = Math.max(target, c.v - V_BASE * 0.9 * dt);
      c.x += clamp(c.tx - c.x, -dt * 0.9, dt * 0.9);
      c.x = clamp(c.x, -0.9, 0.9);
      c.z += c.v * dt;
      c.hitT -= dt;
      if (!c.fin && c.z >= g.laps * L) { c.fin = 1; c.finT = g.t - (c.z - g.laps * L) / Math.max(1, c.v); }
    }
  }

  function collideCars(g, dt) {
    var p = g.p, st = p.st;
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i], d = relZ(g, c), len = SEG * (KINDS[c.kind] ? KINDS[c.kind].len : 1) * 0.85;
      var wsum = (CAR_W + carW(c)) * 0.5, dx = c.x - p.x;
      // overtakes / near misses
      if (g.mode === 'endless') {
        if (c.ahead && d < -len) {
          c.ahead = 0;
          if (g.phase === 'race') {
            g.passes++;
            if (Math.abs(dx) < wsum * 1.9 && p.v > st.top * 0.55) {
              g.near++; g.combo = Math.min(9, g.combo + 1); g.comboT = 3;
              var pts = 50 * g.combo; g.bonus += pts;
              g.ev.push({ t: 'near', pts: pts, combo: g.combo });
            } else { g.bonus += 10; }
          }
        } else if (!c.ahead && d > 0) c.ahead = 1;
      }
      if (Math.abs(d) > len || Math.abs(dx) >= wsum) continue;
      if (p.hitT > 0 && c.hitT > 0) continue;
      var rel = (p.v - c.v) / st.top, hard;
      if (d > 0) {
        // into the back of it
        if (p.v <= c.v && Math.abs(d) > len * 0.6) continue;
        hard = rel > 0.3;
        var vv = c.v;
        c.v = Math.min(c.top * 1.2, c.v + (p.v - c.v) * 0.35);
        p.v = Math.max(0, vv * 0.8 - (hard ? st.top * 0.1 : 0));
        p.z -= Math.max(0, len - d) * 0.6;
      } else {
        // it ran into us
        hard = -rel > 0.35;
        var pv = p.v;
        p.v = Math.min(st.top * 1.1, p.v + (c.v - p.v) * 0.45);
        c.v = pv * 0.9;
        c.z -= Math.max(0, len + d) * 0.6;
      }
      // push apart sideways
      var push = (wsum - Math.abs(dx)) * 0.6 + 0.04, sd = dx >= 0 ? -1 : 1;
      p.x += sd * push; c.x -= sd * push * 0.6; c.tx = clamp(c.x, -0.9, 0.9);
      if (hard) { p.spin = Math.max(p.spin, 0.6); p.spinDir = sd; c.spin = 0.5; }
      p.hitT = 0.3; c.hitT = 0.3;
      if (g.mode === 'endless') g.combo = 0;
      g.ev.push({ t: 'hit', hard: hard, side: sd });
    }
  }

  function stepEndless(g, dt) {
    var p = g.p;
    var kmh = p.v / V_BASE * KMH_TOP;
    if (g.phase === 'race') {
      g.timeLeft -= dt;
      g.dist += kmh / 3.6 * dt;
      if (g.comboT > 0) { g.comboT -= dt; if (g.comboT <= 0) g.combo = 0; }
      var next = CP_LEN * (g.cpIdx + 1);
      if (Math.floor(p.z / SEG) >= next) {
        g.cpIdx++;
        var bonus = Math.round(Math.max(13, 31 - 1.7 * (g.cpIdx - 1)) * g.D.bonus);
        g.timeLeft += bonus; g.bonus += 500;
        var lg = legOf(next);
        g.ev.push({ t: 'cp', bonus: bonus, n: g.cpIdx, biome: legBiome(g.T, lg), night: legNight(g.T, lg) });
      }
      if (g.timeLeft <= 0) { g.timeLeft = 0; g.phase = 'over'; g.overT = 0; g.ev.push({ t: 'timeup' }); }
    } else if (g.phase === 'over') {
      g.overT += dt;
      g.dist += kmh / 3.6 * dt;
      if ((p.v < 30 && g.overT > 1) || g.overT > 4) { g.phase = 'done'; g.ev.push({ t: 'done' }); }
    }
    g.score = Math.floor(g.dist) + g.bonus;
  }

  function stepCareer(g, dt) {
    var p = g.p, L = g.L;
    var lapNow = Math.floor(p.z / L);
    if (!p.fin && lapNow > p.lapSeen) {
      p.lapSeen = lapNow;
      if (lapNow >= 1) {
        var lt = g.t - p.lapT0; p.lapT0 = g.t;
        if (!p.bestLap || lt < p.bestLap) p.bestLap = lt;
        if (lapNow < g.laps) g.ev.push({ t: 'lap', n: lapNow + 1, final: lapNow + 1 === g.laps, lt: lt });
      }
    }
    if (!p.fin && p.z >= g.laps * L) {
      p.fin = 1; p.finT = g.t - (p.z - g.laps * L) / Math.max(1, p.v);
      p.place = placeOf(g);
      g.ev.push({ t: 'finish', place: p.place });
      g.overT = 0;
    }
    if (p.fin) {
      g.overT += dt;
      if (g.overT > 3.2) { g.phase = 'done'; g.ev.push({ t: 'done' }); }
    }
  }
  // where the player stands right now (1 = leading)
  function placeOf(g) {
    var p = g.p, n = 1;
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i];
      if (c.fin && (!p.fin || c.finT < p.finT)) n++;
      else if (!c.fin && !p.fin && c.z > p.z) n++;
    }
    return n;
  }
  // final order: finishers by time, then everyone else by a projected time
  function standings(g) {
    var rows = [], p = g.p, end = g.laps * g.L;
    function proj(z, v, top, t) { return t + Math.max(0, end - z) / Math.max(top * 0.82, v, 1); }
    rows.push({ id: 'you', name: 'You', you: 1, t: p.fin ? p.finT : proj(p.z, p.v, p.st.top, g.t), fin: p.fin });
    for (var i = 0; i < g.cars.length; i++) {
      var c = g.cars[i];
      rows.push({ id: c.id, name: c.name, col: c.col, trait: c.def ? c.def.trait : '', t: c.fin ? c.finT : proj(c.z, c.v, c.top, g.t), fin: c.fin });
    }
    rows.sort(function (a, b) { return a.t - b.t; });
    for (var k = 0; k < rows.length; k++) { rows[k].pos = k + 1; rows[k].pts = POINTS[k] || 0; rows[k].cr = CREDITS[k] || 0; }
    return rows;
  }

  // ---- save / career ----
  function newSave() {
    return {
      v: 1,
      set: { diff: 1, units: 'kmh', cam: 'pov', sens: 1, steer: 'buttons', autogas: null, shake: 1 },
      best: { endless: [null, null, null] },
      car: { credits: 0, upg: { eng: 0, grip: 0, nos: 0, brk: 0 }, paint: 0, owned: [0, 1, 2] },
      cups: CUPS.map(function () { return { best: 0, done: 0 }; }),
      unlocked: 1, cur: null, stats: { races: 0, wins: 0, podiums: 0 }
    };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    try {
      if (o.set) for (var k in s.set) if (o.set[k] !== undefined) s.set[k] = o.set[k];
      s.set.diff = clamp(s.set.diff | 0, 0, 2);
      if (s.set.units !== 'mph') s.set.units = 'kmh';
      if (s.set.cam !== 'chase') s.set.cam = 'pov';
      if ([0.7, 1, 1.35].indexOf(+s.set.sens) < 0) s.set.sens = 1;
      if (['buttons', 'screen', 'tilt'].indexOf(s.set.steer) < 0) s.set.steer = 'buttons';
      if (o.best && Array.isArray(o.best.endless)) for (var d = 0; d < 3; d++) { var b = o.best.endless[d]; s.best.endless[d] = b && isFinite(b.score) ? { score: +b.score, dist: +b.dist || 0, cp: +b.cp || 0 } : null; }
      if (o.car) {
        s.car.credits = Math.max(0, Math.floor(+o.car.credits || 0));
        for (var u in s.car.upg) s.car.upg[u] = clamp((o.car.upg && o.car.upg[u]) | 0, 0, 5);
        if (Array.isArray(o.car.owned)) s.car.owned = o.car.owned.filter(function (i) { return i >= 0 && i < PAINTS.length; });
        [0, 1, 2].forEach(function (i) { if (s.car.owned.indexOf(i) < 0) s.car.owned.push(i); });
        s.car.paint = s.car.owned.indexOf(o.car.paint | 0) >= 0 ? o.car.paint | 0 : 0;
      }
      if (Array.isArray(o.cups)) for (var c = 0; c < CUPS.length; c++) if (o.cups[c]) s.cups[c] = { best: clamp(o.cups[c].best | 0, 0, 8), done: o.cups[c].done | 0 };
      s.unlocked = clamp(o.unlocked | 0, 1, CUPS.length);
      if (o.cur && o.cur.cup >= 0 && o.cur.cup < CUPS.length && o.cur.race >= 0 && o.cur.race < CUPS[o.cur.cup].n && o.cur.pts) {
        s.cur = { cup: o.cur.cup | 0, race: o.cur.race | 0, diff: clamp(o.cur.diff | 0, 0, 2), pts: {}, log: Array.isArray(o.cur.log) ? o.cur.log.slice(0, 8) : [] };
        for (var id in o.cur.pts) s.cur.pts[id] = +o.cur.pts[id] || 0;
      }
      if (o.stats) for (var st in s.stats) s.stats[st] = +o.stats[st] || 0;
    } catch (e) { return newSave(); }
    return s;
  }
  function startCup(save, ci) {
    if (ci >= save.unlocked) return false;
    var pts = { you: 0 };
    cupRivals(ci).forEach(function (d) { pts[d.id] = 0; });
    save.cur = { cup: ci, race: 0, diff: save.set.diff, pts: pts, log: [] };
    return true;
  }
  // record a finished race: points, credits; returns { rows, credits, cupDone, cupRows, unlocked }
  function awardRace(save, rows) {
    var cur = save.cur, out = { rows: rows, credits: 0, cupDone: false, cupRows: null, place: 0, unlocked: false };
    if (!cur) return out;
    var mult = 1 + 0.35 * cur.cup;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      cur.pts[r.id] = (cur.pts[r.id] || 0) + r.pts;
      if (r.you) { out.place = r.pos; out.credits = Math.round(r.cr * mult / 10) * 10; }
    }
    save.car.credits += out.credits;
    save.stats.races++;
    if (out.place === 1) save.stats.wins++;
    if (out.place <= 3) save.stats.podiums++;
    cur.log.push(out.place);
    cur.race++;
    if (cur.race >= CUPS[cur.cup].n) {
      out.cupDone = true;
      out.cupRows = cupStandings(save);
      var mine = 0;
      out.cupRows.forEach(function (r) { if (r.you) mine = r.pos; });
      out.cupPlace = mine;
      var rec = save.cups[cur.cup];
      rec.done++;
      if (mine <= 3 && (!rec.best || mine < rec.best)) rec.best = mine;
      if (mine <= 3) {
        var prize = Math.round(CUPS[cur.cup].prize * (mine === 1 ? 1 : mine === 2 ? 0.6 : 0.35));
        save.car.credits += prize; out.prize = prize;
        if (save.unlocked < CUPS.length && cur.cup + 1 >= save.unlocked) { save.unlocked = cur.cup + 2; out.unlocked = true; }
      }
      save.cur = null;
    }
    return out;
  }
  function cupStandings(save) {
    var cur = save.cur;
    if (!cur) return [];
    var ds = {};
    DRIVERS.forEach(function (d) { ds[d.id] = d; });
    var rows = Object.keys(cur.pts).map(function (id) { return { id: id, you: id === 'you' ? 1 : 0, name: id === 'you' ? 'You' : ds[id] ? ds[id].name : id, pts: cur.pts[id], col: ds[id] ? ds[id].col : null }; });
    rows.sort(function (a, b) { return b.pts - a.pts || (a.you ? -1 : b.you ? 1 : 0); });
    rows.forEach(function (r, i) { r.pos = i + 1; });
    return rows;
  }
  function upgCost(lvl) { return lvl >= 5 ? Infinity : UPG_COST[lvl]; }
  function buyUpgrade(save, id) {
    var l = save.car.upg[id];
    if (l == null) return false;
    var c = upgCost(l);
    if (save.car.credits < c) return false;
    save.car.credits -= c; save.car.upg[id] = l + 1;
    return true;
  }
  function buyPaint(save, i) {
    if (i < 0 || i >= PAINTS.length) return false;
    if (save.car.owned.indexOf(i) >= 0) { save.car.paint = i; return true; }
    if (save.car.credits < PAINTS[i].cost) return false;
    save.car.credits -= PAINTS[i].cost; save.car.owned.push(i); save.car.paint = i;
    return true;
  }
  function endlessRecord(save, g) {
    var b = save.best.endless[g.diff], rec = { score: g.score, dist: Math.round(g.dist), cp: g.cpIdx };
    if (!b || g.score > b.score) { save.best.endless[g.diff] = rec; return true; }
    return false;
  }
  function kmh(v) { return v / V_BASE * KMH_TOP; }
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  var ENGINE = {
    STEP: STEP, SEG: SEG, RW: RW, LANES: LANES, RUMBLE: RUMBLE, CAM_DEPTH: CAM_DEPTH, CAM_H: CAM_H, CAM_H_POV: CAM_H_POV, TUN_H: TUN_H,
    V_BASE: V_BASE, KMH_TOP: KMH_TOP, CF: CF, CAR_W: CAR_W, CP_LEN: CP_LEN, LANE_X: LANE_X,
    BIOMES: BIOMES, SPR: SPR, CUPS: CUPS, DIFFS: DIFFS, DRIVERS: DRIVERS, POINTS: POINTS, CREDITS: CREDITS, UPGS: UPGS, PAINTS: PAINTS, KINDS: KINDS,
    mulberry32: mulberry32, clamp: clamp, lerp: lerp, palette: palette, newTrack: newTrack, segAt: segAt, trackLen: trackLen, heightAt: heightAt,
    legOf: legOf, legBiome: legBiome, legNight: legNight, trackName: trackName, cupTrack: cupTrack, cupRivals: cupRivals,
    carStats: carStats, newPlayer: newPlayer, newCar: newCar, carW: carW, newEndless: newEndless, newRace: newRace, relZ: relZ, step: step,
    autoSteer: autoSteer, placeOf: placeOf, standings: standings, newSave: newSave, normSave: normSave, startCup: startCup, awardRace: awardRace,
    cupStandings: cupStandings, upgCost: upgCost, buyUpgrade: buyUpgrade, buyPaint: buyPaint, endlessRecord: endlessRecord, kmh: kmh, fmtTime: fmtTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('povracer.css');

  var PANEL_ID = 'povracer-panel', NAME = 'Apex Rush';
  var KEY = 'cade-povracer-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.povracer = { live: function () { return S; }, E: ENGINE };   // test-only peek

  var FOGL = 16, NEAR = 30;
  var TUN_COL = { floor: [70, 70, 74], wall: [104, 100, 94], ceil: [52, 52, 56], light: [255, 226, 150], fog: [14, 14, 16], rock: [98, 90, 82] };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }

  // ---- color helpers ----
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
    var r = Math.max(0, Math.min(255, Math.round(c[0]))), g = Math.max(0, Math.min(255, Math.round(c[1]))), b = Math.max(0, Math.min(255, Math.round(c[2])));
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function shade(c, k) { return k < 1 ? [c[0] * k, c[1] * k, c[2] * k] : mix(c, [255, 255, 255], k - 1); }

  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var sf = parseCol(v('--surface'), bg);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.th = {
      dark: dark, bg: bg, text: tx, acc: ac, surface: sf, muted: parseCol(v('--text-muted'), mix(bg, tx, 0.6)),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, Menlo, Consolas, monospace',
      hudBg: rgb(sf, 0.82), hudTx: rgb(tx), hudMu: rgb(parseCol(v('--text-muted'), mix(bg, tx, 0.6))), hudAc: rgb(ac), hudBd: rgb(mix(bg, tx, 0.18))
    };
    S.dashC = null; S.carC = {}; S.mapC = null;
  }
  function paintCol() { var pt = PAINTS[S.save.car.paint] || PAINTS[0]; return pt.col || S.th.acc; }

  // ---- sound: tiny WebAudio voices, made on a user gesture, closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.eng = null; this.noise = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
      try {
        var n = this.ac.sampleRate, b = this.ac.createBuffer(1, n, n), d = b.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        this.noise = b;
      } catch (e) { this.noise = null; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.ok = function () { return this.on && this.ac && this.ac.state !== 'closed'; };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    if (!this.ok()) return;
    var ac = this.ac;
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
  Snd.prototype.hiss = function (dur, vol, freq, q, delay) {
    if (!this.ok() || !this.noise) return;
    var ac = this.ac;
    try {
      var t = ac.currentTime + (delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = freq || 800; f.Q.value = q || 0.8;
      g.gain.setValueAtTime(vol || 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(ac.destination);
      s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    } catch (e) {}
  };
  // the engine: a filtered saw + a sub square that follow the rpm; a noise bed for skids
  Snd.prototype.engineOn = function () {
    if (!this.ok() || this.eng) return;
    var ac = this.ac;
    try {
      var o1 = ac.createOscillator(), o2 = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
      o1.type = 'sawtooth'; o2.type = 'square'; f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 2;
      g.gain.value = 0.0001;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(ac.destination);
      o1.frequency.value = 60; o2.frequency.value = 30;
      o1.start(); o2.start();
      var sk = null, sg = null, sf = null;
      if (this.noise) {
        sk = ac.createBufferSource(); sk.buffer = this.noise; sk.loop = true;
        sf = ac.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1800; sf.Q.value = 1.2;
        sg = ac.createGain(); sg.gain.value = 0.0001;
        sk.connect(sf); sf.connect(sg); sg.connect(ac.destination); sk.start();
      }
      this.eng = { o1: o1, o2: o2, f: f, g: g, sk: sk, sg: sg, sf: sf };
    } catch (e) { this.eng = null; }
  };
  Snd.prototype.engineSet = function (rpm, load, nos, skid, off) {
    var e = this.eng;
    if (!e || !this.ok()) return;
    try {
      var t = this.ac.currentTime, fq = 46 + rpm * 150 + (nos ? 25 : 0);
      e.o1.frequency.setTargetAtTime(fq, t, 0.05);
      e.o2.frequency.setTargetAtTime(fq * 0.5, t, 0.05);
      e.f.frequency.setTargetAtTime(380 + rpm * 900 + load * 500, t, 0.08);
      e.g.gain.setTargetAtTime(0.018 + load * 0.016 + (nos ? 0.01 : 0), t, 0.08);
      if (e.sg) {
        e.sg.gain.setTargetAtTime(Math.min(0.09, skid * 0.06 + off * 0.05), t, 0.06);
        e.sf.frequency.setTargetAtTime(off > skid ? 500 : 1900, t, 0.1);
      }
    } catch (x) {}
  };
  Snd.prototype.engineOff = function () {
    var e = this.eng;
    this.eng = null;
    if (!e) return;
    try { e.o1.stop(); e.o2.stop(); if (e.sk) e.sk.stop(); } catch (x) {}
    try { e.g.disconnect(); if (e.sg) e.sg.disconnect(); } catch (x) {}
  };
  Snd.prototype.close = function () { this.engineOff(); if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  // ---- palettes prepared for drawing: fog tables per color ----
  function palKey(b, n) { return b * 2 + (n ? 1 : 0); }
  function fogTab(c, fog) { var t = []; for (var i = 0; i < FOGL; i++) t.push(rgb(mix(c, fog, Math.min(1, i / (FOGL - 1))))); return t; }
  function getPal(b, n) {
    var key = palKey(b, n), P = S.pals[key];
    if (P) return P;
    var R = palette(b, n), fog = R.fog;
    P = {
      key: key, b: b, night: n ? 1 : 0, raw: R,
      grass: [fogTab(R.grass[0], fog), fogTab(R.grass[1], fog)], rumble: [fogTab(R.rumble[0], fog), fogTab(R.rumble[1], fog)],
      road: [fogTab(R.road[0], fog), fogTab(R.road[1], fog)], lane: fogTab(R.lane, fog), rock: fogTab(mix(TUN_COL.rock, R.far[1], 0.3), fog),
      frame: fogTab([150, 146, 138], fog), cpA: fogTab([245, 245, 245], fog), cpB: fogTab([30, 30, 34], fog),
      tFloor: fogTab(TUN_COL.floor, TUN_COL.fog), tWall: fogTab(TUN_COL.wall, TUN_COL.fog), tWall2: fogTab(shade(TUN_COL.wall, 0.8), TUN_COL.fog),
      tCeil: fogTab(TUN_COL.ceil, TUN_COL.fog), tLight: fogTab(TUN_COL.light, [60, 54, 40]), tRoad: [fogTab([84, 84, 88], TUN_COL.fog), fogTab([78, 78, 82], TUN_COL.fog)],
      tLane: fogTab([236, 220, 120], TUN_COL.fog),
      sky: null, layers: null, stars: null
    };
    S.pals[key] = P;
    return P;
  }

  // ---- sky and parallax layers (cached per palette and size) ----
  function skyGrad(P) {
    var c = S.ctx, k = S.H + ':' + S.cy;
    if (P.sky && P.skyK === k) return P.sky;
    var g = c.createLinearGradient(0, 0, 0, S.cy + 4);
    g.addColorStop(0, rgb(P.raw.sky[0])); g.addColorStop(1, rgb(P.raw.sky[1]));
    P.sky = g; P.skyK = k;
    if (P.night && !P.stars) {
      var r = mulberry32(99 + P.key), st = [];
      for (var i = 0; i < 70; i++) st.push(r(), r() * r(), 0.6 + r() * 1.2);
      P.stars = st;
    }
    return g;
  }
  function makeLayer(P, which, w, h) {
    var cv = document.createElement('canvas'), dk = S.dk;
    cv.width = Math.ceil(w * dk); cv.height = Math.ceil(h * dk);
    var c = cv.getContext('2d'), R = P.raw, b = P.b, r = mulberry32(1000 + b * 7 + which * 31);
    c.scale(dk, dk);
    var col = rgb(which ? R.far[1] : R.far[0]), i, x;
    c.fillStyle = col;
    function ridge(n, lo, hi, jag) {
      c.beginPath(); c.moveTo(0, h);
      var pts = [];
      for (i = 0; i <= n; i++) pts.push(h - lo - (hi - lo) * (jag ? r() : 0.5 + 0.5 * Math.sin(i * 1.7 + r() * 2)));
      pts[n] = pts[0];
      for (i = 0; i <= n; i++) c.lineTo(w * i / n, pts[i]);
      c.lineTo(w, h); c.closePath(); c.fill();
      return pts;
    }
    if (b === 3) {                       // city skyline
      x = 0;
      var lit = P.night ? rgb([255, 214, 120], 0.85) : rgb(mix(R.far[which], [255, 255, 255], 0.25));
      while (x < w) {
        var bw = (which ? 18 : 12) + r() * (which ? 34 : 26), bh = h * (which ? 0.25 + r() * 0.45 : 0.35 + r() * 0.6);
        if (x + bw > w) bw = w - x;
        c.fillStyle = col; c.fillRect(x, h - bh, bw, bh);
        if (!which && r() < 0.25) c.fillRect(x + bw * 0.45, h - bh - 8, 2, 8);
        c.fillStyle = lit;
        for (var wy = h - bh + 4; wy < h - 3; wy += 5) for (var wx = x + 3; wx < x + bw - 3; wx += 5) if (r() < (P.night ? 0.32 : 0.12)) c.fillRect(wx, wy, 2, 2);
        x += bw + (r() < 0.3 ? 2 + r() * 6 : 0);
      }
      return cv;
    }
    if (b === 1 && !which) {             // desert: flat-topped mesas
      c.beginPath(); c.moveTo(0, h);
      x = 0;
      while (x < w) {
        var mw = 30 + r() * 70, mh = h * (0.25 + r() * 0.45), sl = 6 + r() * 10;
        c.lineTo(x, h - 4); c.lineTo(x + sl, h - mh); c.lineTo(Math.min(w, x + mw - sl), h - mh); c.lineTo(Math.min(w, x + mw), h - 4);
        x += mw + r() * 40;
      }
      c.lineTo(w, h); c.closePath(); c.fill();
      return cv;
    }
    if (which === 0) {
      var pk = ridge(b === 0 ? 10 : 18, h * 0.1, h * (b === 4 ? 0.95 : b === 2 ? 0.8 : 0.45), b !== 0);
      if (b === 4 || b === 2) {          // snow caps
        c.fillStyle = rgb(P.night ? [150, 160, 190] : [250, 252, 255], b === 2 ? 0.7 : 0.95);
        var n = pk.length - 1;
        for (i = 1; i < n; i++) {
          if (pk[i] < pk[i - 1] && pk[i] < pk[i + 1] && pk[i] < h * (b === 2 ? 0.4 : 0.6)) {
            var px = w * i / n, d = w / n;
            c.beginPath(); c.moveTo(px - d * 0.3, pk[i] + (pk[i - 1] - pk[i]) * 0.3); c.lineTo(px, pk[i]); c.lineTo(px + d * 0.3, pk[i] + (pk[i + 1] - pk[i]) * 0.3); c.closePath(); c.fill();
          }
        }
      }
      if (b === 0) {                     // a lighthouse on the headland
        c.fillStyle = rgb(P.night ? [200, 200, 210] : [246, 246, 240]);
        c.fillRect(w * 0.3, h * 0.66, 3, h * 0.3);
        c.fillStyle = rgb(P.night ? [255, 230, 150] : [200, 60, 50]); c.fillRect(w * 0.3 - 1, h * 0.63, 5, 4);
      }
      return cv;
    }
    // near layer: tree lines, dunes, palms
    if (b === 2 || b === 4) {
      c.beginPath(); c.moveTo(0, h);
      for (x = 0; x < w; x += 5 + r() * 6) { var th = h * (0.25 + r() * 0.35); c.lineTo(x, h - th * 0.3); c.lineTo(x + 3, h - th); c.lineTo(x + 6, h - th * 0.3); }
      c.lineTo(w, h); c.closePath(); c.fill();
    } else {
      ridge(8, h * 0.05, h * 0.3, false);
      if (b === 0) {
        c.strokeStyle = col; c.lineWidth = 1.5;
        for (i = 0; i < 9; i++) {
          x = r() * w; var ph = h * (0.35 + r() * 0.2);
          c.beginPath(); c.moveTo(x, h); c.quadraticCurveTo(x + 4, h - ph * 0.5, x + 2, h - ph); c.stroke();
          for (var f = 0; f < 5; f++) { var a = -Math.PI / 2 + (f - 2) * 0.6; c.beginPath(); c.moveTo(x + 2, h - ph); c.quadraticCurveTo(x + 2 + Math.cos(a) * 7, h - ph + Math.sin(a) * 4 - 2, x + 2 + Math.cos(a) * 11, h - ph + Math.sin(a) * 4 + 5); c.stroke(); }
        }
      }
    }
    return cv;
  }
  function getLayers(P) {
    var key = S.W + 'x' + S.H + ':' + S.dk;
    if (P.layers && P.layersK === key) return P.layers;
    if (P.layers) { P.layers.forEach(function (cv) { cv.width = 0; cv.height = 0; }); }
    var w = Math.round(S.W * 1.6);
    P.layers = [makeLayer(P, 0, w, Math.round(S.H * 0.3)), makeLayer(P, 1, w, Math.round(S.H * 0.16))];
    P.layersW = w; P.layersH = [Math.round(S.H * 0.3), Math.round(S.H * 0.16)]; P.layersK = key;
    return P.layers;
  }
  function drawSky(P, alpha) {
    var c = S.ctx, W = S.W, cy = S.cy;
    c.globalAlpha = alpha;
    c.fillStyle = skyGrad(P);
    c.fillRect(0, 0, W, cy + 3);
    if (P.stars) {
      c.fillStyle = 'rgba(255,255,255,0.8)';
      var st = P.stars, ox = (S.skyX * 0.02) % W;
      for (var i = 0; i < st.length; i += 3) { var x = (st[i] * W * 1.3 - ox + W * 2) % W; c.fillRect(x, st[i + 1] * cy * 0.9, st[i + 2], st[i + 2]); }
    }
    // sun / moon
    var R = P.raw, sx = ((W * 0.72 - S.skyX * 0.05) % (W * 1.6) + W * 1.6) % (W * 1.6) - W * 0.3, sy = cy * (P.night ? 0.28 : P.b === 1 ? 0.62 : 0.3), sr = Math.max(9, W * 0.035);
    c.fillStyle = rgb(R.sun, P.night ? 0.95 : 0.9);
    c.beginPath(); c.arc(sx, sy, sr, 0, 6.2832); c.fill();
    if (P.night) { c.fillStyle = rgb(R.sky[1] ? R.sky[0] : [0, 0, 0], 0.9); c.beginPath(); c.arc(sx + sr * 0.45, sy - sr * 0.2, sr * 0.85, 0, 6.2832); c.fill(); }
    else { c.fillStyle = rgb(R.sun, 0.18); c.beginPath(); c.arc(sx, sy, sr * 2, 0, 6.2832); c.fill(); }
    var L = getLayers(P), lw = P.layersW;
    for (var j = 0; j < 2; j++) {
      var lh = P.layersH[j], off = ((S.skyX * (j ? 0.5 : 0.22)) % lw + lw) % lw, y = cy - lh + 2 + (j ? 0 : -S.H * 0.03) + S.horizonY * (j ? 0.5 : 0.25);
      c.drawImage(L[j], -off, y, lw, lh);
      if (lw - off < W) c.drawImage(L[j], lw - off, y, lw, lh);
    }
    c.globalAlpha = 1;
  }

  // ---- props: drawn once per kind / variant / night into small canvases ----
  function spriteCv(k, v, f, night) {
    var key = k + v + (f < 0 ? 'l' : 'r') + (night ? 'n' : 'd') + S.dk;
    var cv = S.sprC[key];
    if (cv) return cv;
    var d = SPR[k], ppu = 0.06 * Math.min(2, S.dk), w = Math.max(4, Math.round(d.w * ppu)), h = Math.max(4, Math.round(d.h * ppu));
    cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    if (f < 0 && (k === 'lamp' || k === 'chev')) { c.translate(w, 0); c.scale(-1, 1); }
    drawProp(c, k, v, w, h, night);
    if (night && k !== 'lamp' && k !== 'bld' && k !== 'billboard' && k !== 'chev') {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-atop'; c.fillStyle = 'rgba(6,8,22,0.62)'; c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'source-over';
    }
    S.sprC[key] = cv;
    return cv;
  }
  function ell(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, 6.2832); c.fill(); }
  function drawProp(c, k, v, w, h, night) {
    var i, r = mulberry32(17 + v * 13 + k.length * 7);
    function shadow() { c.fillStyle = 'rgba(0,0,0,0.22)'; ell(c, w / 2, h - h * 0.015, w * 0.32, h * 0.02 + 1); }
    switch (k) {
      case 'palm': {
        shadow();
        c.strokeStyle = '#8a6a44'; c.lineWidth = w * 0.07; c.lineCap = 'round';
        c.beginPath(); c.moveTo(w * 0.5, h); c.quadraticCurveTo(w * 0.42, h * 0.5, w * 0.58, h * 0.18); c.stroke();
        c.strokeStyle = '#6e5234'; c.lineWidth = w * 0.02;
        for (i = 0; i < 8; i++) { var ty = h - i * h * 0.1 - h * 0.08; c.beginPath(); c.moveTo(w * 0.47, ty); c.lineTo(w * 0.53, ty - 2); c.stroke(); }
        var cols = ['#2f8a3c', '#3fa047', '#277a33'];
        for (i = 0; i < 7; i++) {
          var a = -Math.PI / 2 + (i - 3) * 0.55;
          c.strokeStyle = cols[i % 3]; c.lineWidth = w * 0.06;
          c.beginPath(); c.moveTo(w * 0.58, h * 0.18);
          c.quadraticCurveTo(w * 0.58 + Math.cos(a) * w * 0.3, h * 0.18 + Math.sin(a) * h * 0.08 - h * 0.04, w * 0.58 + Math.cos(a) * w * 0.46, h * 0.18 + Math.abs(Math.cos(a)) * h * 0.14);
          c.stroke();
        }
        c.fillStyle = '#6b4a2a'; ell(c, w * 0.57, h * 0.2, w * 0.05, w * 0.04);
        break;
      }
      case 'pine': case 'snowpine': {
        shadow();
        c.fillStyle = '#5b4026'; c.fillRect(w * 0.45, h * 0.8, w * 0.1, h * 0.2);
        var g1 = k === 'pine' ? ['#1f5a2c', '#2a6e35', '#348040'] : ['#245038', '#2c5e42', '#356c4c'];
        for (i = 0; i < 4; i++) {
          var top = h * (0.02 + i * 0.2), bot = h * (0.36 + i * 0.16), hw = w * (0.24 + i * 0.08);
          c.fillStyle = g1[i % 3];
          c.beginPath(); c.moveTo(w / 2, top); c.lineTo(w / 2 + hw, bot); c.lineTo(w / 2 - hw, bot); c.closePath(); c.fill();
          if (k === 'snowpine') {
            c.fillStyle = '#f4f8fc';
            c.beginPath(); c.moveTo(w / 2, top); c.lineTo(w / 2 + hw * 0.5, top + (bot - top) * 0.5); c.lineTo(w / 2 + hw * 0.1, top + (bot - top) * 0.42); c.lineTo(w / 2 - hw * 0.5, top + (bot - top) * 0.55); c.closePath(); c.fill();
            c.fillRect(w / 2 - hw * 0.9, bot - 2, hw * 1.8, 2);
          }
        }
        break;
      }
      case 'tree': {
        shadow();
        c.fillStyle = '#6a4a2c'; c.fillRect(w * 0.45, h * 0.55, w * 0.1, h * 0.45);
        var tc = ['#3d7d34', '#4b923f', '#336e2c', '#58a24a'];
        var blobs = [[0.5, 0.32, 0.34], [0.3, 0.45, 0.24], [0.7, 0.45, 0.24], [0.42, 0.2, 0.22], [0.6, 0.22, 0.2]];
        for (i = 0; i < blobs.length; i++) { c.fillStyle = tc[i % 4]; ell(c, w * blobs[i][0], h * blobs[i][1], w * blobs[i][2], w * blobs[i][2] * 0.9); }
        break;
      }
      case 'cactus': {
        shadow();
        c.fillStyle = '#3f8a4a';
        function rr2(x, y, ww, hh) { c.beginPath(); c.moveTo(x, y + ww / 2); c.arc(x + ww / 2, y + ww / 2, ww / 2, Math.PI, 0); c.lineTo(x + ww, y + hh); c.lineTo(x, y + hh); c.closePath(); c.fill(); }
        rr2(w * 0.4, h * 0.02, w * 0.2, h * 0.98);
        rr2(w * 0.12, h * 0.3, w * 0.14, h * 0.25); c.fillRect(w * 0.12, h * 0.5, w * 0.3, w * 0.12);
        rr2(w * 0.74, h * 0.18, w * 0.14, h * 0.3); c.fillRect(w * 0.58, h * 0.42, w * 0.3, w * 0.12);
        c.fillStyle = 'rgba(255,255,255,0.15)'; c.fillRect(w * 0.45, h * 0.06, w * 0.03, h * 0.9);
        break;
      }
      case 'rock': {
        shadow();
        c.fillStyle = v % 2 ? '#8c847a' : '#7b746c';
        c.beginPath(); c.moveTo(w * 0.05, h); c.lineTo(w * 0.15, h * 0.4); c.lineTo(w * 0.4, h * 0.08); c.lineTo(w * 0.7, h * 0.15); c.lineTo(w * 0.92, h * 0.5); c.lineTo(w * 0.97, h); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.18)'; c.beginPath(); c.moveTo(w * 0.15, h * 0.4); c.lineTo(w * 0.4, h * 0.08); c.lineTo(w * 0.45, h * 0.5); c.closePath(); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.15)'; c.beginPath(); c.moveTo(w * 0.7, h * 0.15); c.lineTo(w * 0.92, h * 0.5); c.lineTo(w * 0.97, h); c.lineTo(w * 0.6, h); c.closePath(); c.fill();
        break;
      }
      case 'bush': {
        var bc = ['#3a7a34', '#4a8c3e', '#2f6a2c'];
        for (i = 0; i < 6; i++) { c.fillStyle = bc[i % 3]; ell(c, w * (0.2 + 0.12 * i), h * (0.55 + 0.15 * (i % 2)), w * 0.18, h * 0.42); }
        break;
      }
      case 'scrub': {
        c.strokeStyle = '#8a6a3a'; c.lineWidth = Math.max(1, w * 0.025);
        for (i = 0; i < 14; i++) { var sa = -Math.PI * (0.1 + 0.8 * r()); c.beginPath(); c.moveTo(w / 2, h); c.lineTo(w / 2 + Math.cos(sa) * w * 0.48, h + Math.sin(sa) * h * 0.95); c.stroke(); }
        break;
      }
      case 'chev': {
        c.fillStyle = '#555'; c.fillRect(w * 0.46, h * 0.45, w * 0.08, h * 0.55);
        c.fillStyle = night ? '#d8d8d0' : '#f4f4ee'; c.fillRect(w * 0.04, h * 0.04, w * 0.92, h * 0.46);
        c.fillStyle = '#d22d2d';
        for (i = 0; i < 2; i++) {
          var cx = w * (0.32 + i * 0.32);
          c.beginPath(); c.moveTo(cx - w * 0.12, h * 0.1); c.lineTo(cx + w * 0.06, h * 0.27); c.lineTo(cx - w * 0.12, h * 0.44); c.lineTo(cx - w * 0.02, h * 0.44); c.lineTo(cx + w * 0.16, h * 0.27); c.lineTo(cx - w * 0.02, h * 0.1); c.closePath(); c.fill();
        }
        c.strokeStyle = '#333'; c.lineWidth = Math.max(1, w * 0.02); c.strokeRect(w * 0.04, h * 0.04, w * 0.92, h * 0.46);
        break;
      }
      case 'lamp': {
        // pole on the left of the canvas, the arm reaching right (toward the road when unflipped)
        c.fillStyle = '#5a5e66'; c.fillRect(w * 0.1, h * 0.06, w * 0.07, h * 0.94);
        c.fillRect(w * 0.1, h * 0.06, w * 0.62, w * 0.05);
        c.fillStyle = night ? '#fff2c0' : '#d8d8d0'; c.fillRect(w * 0.6, h * 0.06 + w * 0.04, w * 0.18, w * 0.06);
        if (night) {
          var gl = c.createRadialGradient(w * 0.69, h * 0.1, 1, w * 0.69, h * 0.1, w * 0.32);
          gl.addColorStop(0, 'rgba(255,230,160,0.9)'); gl.addColorStop(1, 'rgba(255,230,160,0)');
          c.fillStyle = gl; c.fillRect(w * 0.3, 0, w * 0.7, h * 0.3);
        }
        break;
      }
      case 'bld': {
        var bcol = [[150, 140, 130], [110, 120, 140], [170, 160, 140], [90, 100, 110]][v % 4];
        if (night) bcol = shade(bcol, 0.35);
        c.fillStyle = rgb(bcol); c.fillRect(w * 0.04, h * 0.08, w * 0.92, h * 0.92);
        c.fillStyle = rgb(shade(bcol, 0.75)); c.fillRect(w * 0.04, h * 0.05, w * 0.92, h * 0.04);
        if (v % 2) { c.fillRect(w * 0.6, h * 0.0, w * 0.04, h * 0.06); }
        var cols2 = 5, rows = 9, gw = w * 0.92 / cols2, gh = h * 0.86 / rows;
        for (var yy = 0; yy < rows; yy++) for (var xx = 0; xx < cols2; xx++) {
          var on = night ? r() < 0.45 : false;
          c.fillStyle = on ? (r() < 0.8 ? '#ffd27a' : '#bfe6ff') : night ? 'rgba(10,14,30,0.9)' : rgb(mix(bcol, [60, 80, 110], 0.6));
          c.fillRect(w * 0.04 + xx * gw + gw * 0.22, h * 0.12 + yy * gh + gh * 0.2, gw * 0.56, gh * 0.55);
        }
        c.fillStyle = night ? '#2a2a30' : '#3a3a40'; c.fillRect(w * 0.42, h * 0.9, w * 0.16, h * 0.1);
        break;
      }
      case 'billboard': {
        c.fillStyle = '#4a4a50'; c.fillRect(w * 0.2, h * 0.5, w * 0.05, h * 0.5); c.fillRect(w * 0.75, h * 0.5, w * 0.05, h * 0.5);
        var bb = [['#1f6fd1', '#ffd23f'], ['#d1345b', '#ffffff'], ['#14a37f', '#ffe9a8'], ['#7a3fd1', '#7ef0ff']][v % 4];
        c.fillStyle = bb[0]; c.fillRect(w * 0.04, h * 0.06, w * 0.92, h * 0.46);
        c.fillStyle = bb[1];
        c.beginPath(); c.arc(w * 0.26, h * 0.29, h * 0.14, 0, 6.2832); c.fill();
        c.fillRect(w * 0.46, h * 0.16, w * 0.42, h * 0.07); c.fillRect(w * 0.46, h * 0.28, w * 0.3, h * 0.05); c.fillRect(w * 0.46, h * 0.37, w * 0.36, h * 0.05);
        c.strokeStyle = '#2a2a2e'; c.lineWidth = Math.max(1, w * 0.012); c.strokeRect(w * 0.04, h * 0.06, w * 0.92, h * 0.46);
        if (night) { c.fillStyle = 'rgba(255,255,220,0.12)'; c.fillRect(w * 0.04, h * 0.06, w * 0.92, h * 0.46); }
        break;
      }
      case 'pole': {
        c.fillStyle = '#6e5636'; c.fillRect(w * 0.44, 0, w * 0.12, h);
        c.fillRect(w * 0.05, h * 0.06, w * 0.9, w * 0.08);
        c.fillStyle = '#d8d8d0'; c.fillRect(w * 0.1, h * 0.06 - w * 0.06, w * 0.06, w * 0.06); c.fillRect(w * 0.84, h * 0.06 - w * 0.06, w * 0.06, w * 0.06);
        break;
      }
      case 'hut': {
        shadow();
        c.fillStyle = '#d9b98a'; c.fillRect(w * 0.12, h * 0.42, w * 0.76, h * 0.58);
        c.fillStyle = '#6b4a2a'; c.fillRect(w * 0.42, h * 0.62, w * 0.16, h * 0.38);
        for (i = 0; i < 6; i++) { c.fillStyle = i % 2 ? '#f4f4ee' : '#e0503c'; c.beginPath(); c.moveTo(w * 0.5, h * 0.06); c.lineTo(w * (0.02 + i * 0.16), h * 0.46); c.lineTo(w * (0.18 + i * 0.16), h * 0.46); c.closePath(); c.fill(); }
        break;
      }
      case 'snowman': {
        shadow();
        c.fillStyle = '#f6f8fb'; ell(c, w / 2, h * 0.78, w * 0.4, h * 0.22); ell(c, w / 2, h * 0.47, w * 0.3, h * 0.16); ell(c, w / 2, h * 0.24, w * 0.22, h * 0.12);
        c.fillStyle = '#222'; c.fillRect(w * 0.32, h * 0.02, w * 0.36, h * 0.1); c.fillRect(w * 0.25, h * 0.11, w * 0.5, h * 0.025);
        c.fillStyle = '#f08a24'; c.beginPath(); c.moveTo(w * 0.5, h * 0.24); c.lineTo(w * 0.72, h * 0.26); c.lineTo(w * 0.5, h * 0.28); c.fill();
        c.fillStyle = '#c0303a'; c.fillRect(w * 0.26, h * 0.33, w * 0.48, h * 0.04);
        break;
      }
    }
  }

  // ---- cars (rear view), cached per kind / paint / night ----
  var CAR_H = { coupe: 300, sedan: 400, van: 560, truck: 980 };
  function carCv(kind, col, night, lean) {
    var key = kind + col.join(',') + (night ? 'n' : 'd') + (lean || 0) + S.dk;
    var cv = S.carC[key];
    if (cv) return cv;
    var ww = RW * ENGINE.CAR_W * (ENGINE.KINDS[kind] ? ENGINE.KINDS[kind].w : 1), ppu = 0.13 * Math.min(2, S.dk);
    var w = Math.round(ww * ppu), h = Math.round(CAR_H[kind] * ppu * 1.06);
    cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    drawCar(cv.getContext('2d'), kind, col, w, h, night, lean || 0);
    S.carC[key] = cv;
    return cv;
  }
  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function drawCar(c, kind, col, w, h, night, lean) {
    var body = rgb(night ? shade(col, 0.55) : col), dark = rgb(shade(col, night ? 0.32 : 0.62)), hi = rgb(shade(col, night ? 0.8 : 1.25));
    var L = lean * w * 0.04;
    c.fillStyle = 'rgba(0,0,0,0.35)'; ell(c, w / 2, h * 0.95, w * 0.5, h * 0.06);
    c.fillStyle = '#16161a';
    c.fillRect(w * 0.04, h * 0.72, w * 0.18, h * 0.25); c.fillRect(w * 0.78, h * 0.72, w * 0.18, h * 0.25);
    if (kind === 'truck') {
      c.fillStyle = rgb(night ? shade(mix(col, [230, 230, 230], 0.6), 0.5) : mix(col, [235, 235, 235], 0.6));
      c.fillRect(w * 0.02, h * 0.02, w * 0.96, h * 0.74);
      c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(w * 0.495, h * 0.04, w * 0.01, h * 0.7);
      c.fillRect(w * 0.06, h * 0.06, w * 0.04, h * 0.66); c.fillRect(w * 0.9, h * 0.06, w * 0.04, h * 0.66);
      c.fillStyle = body; c.fillRect(w * 0.02, h * 0.02, w * 0.96, h * 0.06);
      c.fillStyle = '#2a2a2e'; c.fillRect(w * 0.0, h * 0.76, w, h * 0.08);
      tail(w * 0.03, h * 0.78, w * 0.12, h * 0.04);
      return;
    }
    var tall = kind === 'van' ? 0.5 : kind === 'sedan' ? 0.36 : 0.3;
    // cabin
    c.fillStyle = dark;
    c.beginPath(); c.moveTo(w * 0.16 + L, h * (0.74 - tall - 0.18)); c.lineTo(w * 0.84 + L, h * (0.74 - tall - 0.18));
    c.lineTo(w * 0.92, h * 0.5); c.lineTo(w * 0.08, h * 0.5); c.closePath(); c.fill();
    if (kind === 'van') { c.fillStyle = body; c.fillRect(w * 0.06, h * 0.06, w * 0.88, h * 0.5); }
    // rear window
    var gy = kind === 'van' ? h * 0.12 : h * (0.74 - tall - 0.14);
    c.fillStyle = night ? '#0c0e16' : '#2b3444';
    c.beginPath(); c.moveTo(w * 0.22 + L, gy); c.lineTo(w * 0.78 + L, gy); c.lineTo(w * 0.86, h * 0.48); c.lineTo(w * 0.14, h * 0.48); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.beginPath(); c.moveTo(w * 0.3 + L, gy + 2); c.lineTo(w * 0.42 + L, gy + 2); c.lineTo(w * 0.32, h * 0.46); c.lineTo(w * 0.2, h * 0.46); c.closePath(); c.fill();
    // body
    c.fillStyle = body; rrect(c, w * 0.02, h * 0.46, w * 0.96, h * 0.32, h * 0.06); c.fill();
    c.fillStyle = hi; c.fillRect(w * 0.06, h * 0.48, w * 0.88, h * 0.03);
    c.fillStyle = dark; c.fillRect(w * 0.02, h * 0.7, w * 0.96, h * 0.08);
    if (kind === 'coupe') { c.fillStyle = dark; c.fillRect(w * 0.1, h * 0.43, w * 0.8, h * 0.04); c.fillStyle = body; c.fillRect(w * 0.1, h * 0.41, w * 0.8, h * 0.025); }
    tail(w * 0.05, h * 0.54, w * 0.2, h * 0.07);
    c.fillStyle = night ? '#9a9a80' : '#e8e8de'; c.fillRect(w * 0.4, h * 0.6, w * 0.2, h * 0.07);
    function tail(x, y, tw, th) {
      c.fillStyle = night ? '#ff4040' : '#c81e1e';
      c.fillRect(x, y, tw, th); c.fillRect(w - x - tw, y, tw, th);
      if (night) {
        c.fillStyle = 'rgba(255,60,50,0.35)';
        ell(c, x + tw / 2, y + th / 2, tw, th * 1.8); ell(c, w - x - tw / 2, y + th / 2, tw, th * 1.8);
      }
    }
  }

  // ---- the cockpit: hood + dashboard + gauges, cached; needles and wheel live ----
  function dashGeom() {
    var W = S.W, H = S.H, portrait = H > W * 0.9;
    var top = Math.round(H * (portrait ? 0.79 : 0.77)), dh = H - top;
    var gr = Math.max(22, Math.min(dh * 0.44, W * (portrait ? 0.115 : 0.085)));
    var fs = Math.max(13, Math.min(24, dh * 0.26)), wr = Math.min(W * (portrait ? 0.27 : 0.17), dh * 1.7);
    // the wheel sits low enough to leave the digital readout clear above its rim
    return { top: top, dh: dh, hood: Math.round(top - H * 0.07), gr: gr, gx1: Math.max(gr + 6, W * (portrait ? 0.14 : 0.2)), gx2: Math.min(W - gr - 6, W * (portrait ? 0.86 : 0.8)), gy: top + dh * 0.52,
      fs: fs, wr: wr, wy: Math.max(H + wr * 0.28, top + dh * 0.06 + fs * 1.7 + 8 + wr) };
  }
  function dashCv() {
    var key = S.W + 'x' + S.H + S.save.set.units + S.dk + paintCol().join(',') + (S.th.dark ? 1 : 0);
    if (S.dashC && S.dashK === key) return S.dashC;
    var G = dashGeom(), W = S.W, H = S.H, cv = S.dashC || document.createElement('canvas');
    cv.width = Math.ceil(W * S.dk); cv.height = Math.ceil((H - G.hood + 2) * S.dk);
    var c = cv.getContext('2d');
    c.setTransform(S.dk, 0, 0, S.dk, 0, -G.hood * S.dk);
    var pc = paintCol();
    // hood
    var hg = c.createLinearGradient(0, G.hood, 0, G.top);
    hg.addColorStop(0, rgb(shade(pc, 1.15))); hg.addColorStop(1, rgb(shade(pc, 0.55)));
    c.fillStyle = hg;
    c.beginPath(); c.moveTo(-2, G.top + 2); c.lineTo(-2, G.hood + (G.top - G.hood) * 0.7);
    c.quadraticCurveTo(W * 0.5, G.hood - (G.top - G.hood) * 0.5, W + 2, G.hood + (G.top - G.hood) * 0.7); c.lineTo(W + 2, G.top + 2); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.beginPath(); c.moveTo(W * 0.3, G.hood + (G.top - G.hood) * 0.32); c.quadraticCurveTo(W * 0.5, G.hood - (G.top - G.hood) * 0.1, W * 0.7, G.hood + (G.top - G.hood) * 0.32);
    c.quadraticCurveTo(W * 0.5, G.hood + (G.top - G.hood) * 0.12, W * 0.3, G.hood + (G.top - G.hood) * 0.32); c.fill();
    // dash
    var base = S.th.dark ? [24, 25, 29] : mix(S.th.bg, [40, 42, 48], 0.86);
    var dg = c.createLinearGradient(0, G.top, 0, H);
    dg.addColorStop(0, rgb(shade(base, 1.3))); dg.addColorStop(0.12, rgb(base)); dg.addColorStop(1, rgb(shade(base, 0.7)));
    c.fillStyle = dg;
    c.beginPath(); c.moveTo(0, G.top + 6); c.quadraticCurveTo(W / 2, G.top - 8, W, G.top + 6); c.lineTo(W, H); c.lineTo(0, H); c.closePath(); c.fill();
    c.strokeStyle = rgb(S.th.acc, 0.55); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, G.top + 6); c.quadraticCurveTo(W / 2, G.top - 8, W, G.top + 6); c.stroke();
    // gauges
    var mx = S.save.set.units === 'mph' ? 220 : 360, step = S.save.set.units === 'mph' ? 20 : 40;
    gauge(c, G.gx1, G.gy, G.gr, mx, step, S.save.set.units === 'mph' ? 'MPH' : 'KM/H');
    gauge(c, G.gx2, G.gy, G.gr, 9, 1, 'x1000', 7);
    S.dashC = cv; S.dashK = key;
    return cv;
  }
  function gauge(c, x, y, r, mx, step, label, red) {
    c.fillStyle = '#0d0e11'; c.beginPath(); c.arc(x, y, r + 3, 0, 6.2832); c.fill();
    c.strokeStyle = rgb(S.th.acc, 0.8); c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, r + 2, 0, 6.2832); c.stroke();
    var a0 = Math.PI * 0.75, span = Math.PI * 1.5;
    if (red) { c.strokeStyle = 'rgba(230,50,50,0.85)'; c.lineWidth = r * 0.12; c.beginPath(); c.arc(x, y, r * 0.86, a0 + span * red / mx, a0 + span); c.stroke(); }
    c.strokeStyle = '#e8e8e8'; c.fillStyle = '#d8d8d8';
    c.font = '700 ' + Math.max(7, Math.round(r * 0.2)) + 'px ' + S.th.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (var v = 0; v <= mx; v += step / 2) {
      var a = a0 + span * v / mx, major = Math.abs(v / step - Math.round(v / step)) < 0.01, r1 = r * (major ? 0.74 : 0.82);
      c.lineWidth = major ? 1.6 : 1;
      c.beginPath(); c.moveTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1); c.lineTo(x + Math.cos(a) * r * 0.94, y + Math.sin(a) * r * 0.94); c.stroke();
      if (major && r > 30 && (mx <= 10 || (v / step) % 2 === 0)) c.fillText(String(v), x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55);
    }
    c.fillStyle = '#8a8a90'; c.font = '600 ' + Math.max(6, Math.round(r * 0.15)) + 'px ' + S.th.font;
    c.fillText(label, x, y + r * 0.45);
  }

  // ---- projection + drawing ----
  var PX = new Float32Array(260), PY = new Float32Array(260), PW = new Float32Array(260), PS = new Float32Array(260), PV = new Uint8Array(260);
  var SG = new Array(260), BK = [];
  for (var bi = 0; bi < 260; bi++) BK.push([]);
  function fogIdx(n) { var d = n / S.drawN; return Math.min(FOGL - 1, Math.round((1 - Math.exp(-d * d * 4.2)) * (FOGL - 1))); }

  function render(g) {
    var c = S.ctx, W = S.W, H = S.H, p = g.p, T = g.T, set = S.save.set, pov = set.cam === 'pov';
    var dt = S.fdt || 0;
    c.setTransform(S.dk, 0, 0, S.dk, 0, 0);
    // camera
    var shx = 0, shy = 0, sh = S.shake * (set.shake ? 1 : 0.25);
    if (sh > 0.01) { shx = (Math.random() - 0.5) * sh * 14; shy = (Math.random() - 0.5) * sh * 10; }
    var off = p.off && p.v > 300 ? Math.sin(S.animT * 50) * 2.2 * Math.min(1, p.v / p.st.top) : 0;
    shy += off;
    var cy = S.cy = Math.round(H * (pov ? 0.47 : 0.44)), sc = S.sc = Math.max(W, H * 0.9) / 2;
    var camH = pov ? CAM_H_POV : CAM_H, zoff = pov ? 0 : CAM_DEPTH * camH * sc / Math.max(20, H * 0.885 - cy);
    var camZ = p.z - zoff, py = heightAt(T, p.z), camY = py + camH + (pov ? 0 : 0);
    var spinA = p.spin > 0 ? Math.sin(p.spin * 14) * p.spin * 0.6 : 0;
    var camX = p.x * RW + (pov ? spinA * RW * 0.3 : 0);
    var baseI = Math.floor(camZ / SEG), bp = camZ / SEG - baseI;
    var N = S.drawN, base0 = segAt(T, baseI);
    // the horizon dips and lifts with the road ahead (for the parallax layers)
    var aheadY = segAt(T, baseI + 40).y1;
    S.horizonY += (Math.max(-60, Math.min(60, (camY - aheadY) * CAM_DEPTH / (SEG * 40) * sc)) - S.horizonY) * Math.min(1, dt * 4);
    // sky + parallax (cross-fades when the biome changes)
    var P0 = getPal(base0.b, base0.n);
    if (S.skyP !== P0.key) { if (S.skyP != null) { S.skyFrom = S.skyP; S.skyT = 0; } S.skyP = P0.key; }
    S.skyX += (p.v / SEG) * base0.c * dt * 3.2;
    c.save();
    c.translate(shx, shy);
    var roll = pov ? -p.steer * 0.025 * Math.min(1, p.v / p.st.top) + spinA * 0.15 : spinA * 0.08;
    if (roll) { c.translate(W / 2, H * 0.6); c.rotate(roll); c.scale(1.06, 1.06); c.translate(-W / 2, -H * 0.6); }
    if (S.skyFrom != null && S.skyT < 1) {
      S.skyT += dt / 1.6;
      drawSky(S.pals[S.skyFrom] || P0, 1);
      drawSky(P0, Math.min(1, S.skyT));
    } else { S.skyFrom = null; drawSky(P0, 1); }
    // project the segment boundaries, near to far
    var x = 0, dx = -base0.c * bp;
    for (var n = 0; n <= N; n++) {
      var s = segAt(T, baseI + n);
      SG[n] = s;
      var z = (n - bp) * SEG;
      if (z < NEAR) { PV[n] = 0; }
      else {
        var k = CAM_DEPTH / z;
        PV[n] = 1; PS[n] = k;
        PX[n] = W / 2 + k * (x - camX) * sc;
        PY[n] = cy - k * (s.y1 - camY) * sc;
        PW[n] = k * RW * sc;
      }
      x += dx; dx += s.c;
      BK[n].length = 0;
    }
    // bucket the cars by segment
    var cars = g.cars;
    for (var ci = 0; ci < cars.length; ci++) {
      var car = cars[ci], dz = relZ(g, car) + zoff, fn = dz / SEG + bp, ni = Math.floor(fn);
      if (ni < 1 || ni >= N) continue;
      car._f = fn - ni;
      BK[ni].push(car);
    }
    // draw far to near (painter's order: crests and tunnel rings hide what is behind them)
    var lastTun = -1;
    for (n = N - 1; n >= 1; n--) {
      if (!PV[n] || !PV[n + 1]) continue;
      s = SG[n];
      var P = s.b === P0.b && s.n === P0.night ? P0 : getPal(s.b, s.n), f = fogIdx(n);
      var x1 = PX[n], y1 = PY[n], w1 = PW[n], x2 = PX[n + 1], y2 = PY[n + 1], w2 = PW[n + 1];
      var alt = Math.floor(s.i / RUMBLE) % 2;
      if (y2 < y1 || s.tun) {
        if (y1 > -50 && y2 < H + 50) {
          c.fillStyle = P.grass[alt][f];
          c.fillRect(0, Math.ceil(y2), W, Math.ceil(y1 - y2) + 1);
          if (s.tun) {
            if (lastTun < 0) { lastTun = n; tunnelFar(P, n + 1); }
            tunnelSeg(P, s, n, f, alt);
          } else {
            var r1 = w1 / 6, r2 = w2 / 6;
            quad(c, x1, y1, w1 + r1, x2, y2, w2 + r2, P.rumble[alt][f]);
            quad(c, x1, y1, w1, x2, y2, w2, P.road[alt][f]);
            if (s.fin || s.cp) checker(P, n, f);
            else if (!alt && w1 > 6) {
              var lw1 = w1 / 34, lw2 = w2 / 34, o1 = w1 / 3, o2 = w2 / 3;
              quad(c, x1 - o1, y1, lw1, x2 - o2, y2, lw2, P.lane[f]);
              quad(c, x1 + o1, y1, lw1, x2 + o2, y2, lw2, P.lane[f]);
            }
          }
          if (s.tun && !segAt(T, s.i - 1).tun) portal(P, n, f);
        }
      }
      // props at this segment's near edge
      if (s.spr && w1 > 0.4) drawProps(P, s, n, f);
      // cars on this segment
      var bk = BK[n];
      if (bk.length) {
        if (bk.length > 1) bk.sort(function (a, b) { return b._f - a._f; });
        for (var j = 0; j < bk.length; j++) drawCarAt(bk[j], n, f, P);
      }
    }
    // the player's car (chase cam), particles, speed lines
    S.carScr = null;
    if (!pov) drawPlayer(g, cy, sc, zoff, P0);
    drawFx(g, dt, P0);
    c.restore();
    if (pov) drawCockpit(g, shx, shy);
    if (S.flash > 0) { c.fillStyle = 'rgba(230,40,40,' + (S.flash * 0.35).toFixed(3) + ')'; c.fillRect(0, 0, W, H); S.flash -= dt * 2.2; }
    if (S.cpFlash > 0) { c.fillStyle = rgb(S.th.acc, S.cpFlash * 0.25); c.fillRect(0, 0, W, H); S.cpFlash -= dt * 1.6; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 2.4);
    drawHud(g);
  }
  function quad(c, x1, y1, w1, x2, y2, w2, col) {
    c.fillStyle = col;
    y2 -= 0.6;                     // overlap the farther segment: no anti-aliased seams
    c.beginPath(); c.moveTo(x1 - w1, y1); c.lineTo(x2 - w2, y2); c.lineTo(x2 + w2, y2); c.lineTo(x1 + w1, y1); c.closePath(); c.fill();
  }
  function poly4(c, ax, ay, bx, by, cx, cy, dx, dy, col) {
    c.fillStyle = col;
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(cx, cy); c.lineTo(dx, dy); c.closePath(); c.fill();
  }
  function checker(P, n, f) {
    var c = S.ctx, x1 = PX[n], y1 = PY[n], w1 = PW[n], x2 = PX[n + 1], y2 = PY[n + 1], w2 = PW[n + 1], m = 8, row = SG[n].i % 2;
    for (var i = 0; i < m; i++) {
      var a = -1 + 2 * i / m, b = -1 + 2 * (i + 1) / m;
      poly4(c, x1 + w1 * a, y1, x2 + w2 * a, y2, x2 + w2 * b, y2, x1 + w1 * b, y1, (i + row) % 2 ? P.cpA[f] : P.cpB[f]);
    }
  }
  function tunnelFar(P, n) {
    if (!PV[n]) return;
    var c = S.ctx, th = PS[n] * TUN_H * S.sc;
    c.fillStyle = P.tCeil[FOGL - 1];
    c.fillRect(PX[n] - PW[n] * 1.2, PY[n] - th, PW[n] * 2.4, th + 1);
  }
  function tunnelSeg(P, s, n, f, alt) {
    var c = S.ctx, sc = S.sc, x1 = PX[n], y1 = PY[n], w1 = PW[n], x2 = PX[n + 1], y2 = PY[n + 1], w2 = PW[n + 1];
    var t1 = PS[n] * TUN_H * sc, t2 = PS[n + 1] * TUN_H * sc, e1 = w1 * 1.2, e2 = w2 * 1.2;
    var c1 = y1 - t1, c2 = y2 - t2;
    quad(c, x1, y1, e1, x2, y2, e2, P.tFloor[f]);
    quad(c, x1, y1, w1, x2, y2, w2, P.tRoad[alt][f]);
    if (!alt && w1 > 6) {
      var lw1 = w1 / 34, lw2 = w2 / 34, o1 = w1 / 3, o2 = w2 / 3;
      quad(c, x1 - o1, y1, lw1, x2 - o2, y2, lw2, P.tLane[f]);
      quad(c, x1 + o1, y1, lw1, x2 + o2, y2, lw2, P.tLane[f]);
    }
    poly4(c, x1 - e1, y1, x1 - e1, c1, x2 - e2, c2, x2 - e2, y2, alt ? P.tWall[f] : P.tWall2[f]);
    poly4(c, x1 + e1, y1, x1 + e1, c1, x2 + e2, c2, x2 + e2, y2, alt ? P.tWall[f] : P.tWall2[f]);
    poly4(c, x1 - e1, c1, x1 + e1, c1, x2 + e2, c2, x2 - e2, c2, P.tCeil[f]);
    // a yellow band along the walls, lights down the middle of the ceiling
    var b1 = t1 * 0.08, b2 = t2 * 0.08;
    poly4(c, x1 - e1, y1 - b1 * 3, x2 - e2, y2 - b2 * 3, x2 - e2, y2 - b2 * 4, x1 - e1, y1 - b1 * 4, P.tLane[f]);
    poly4(c, x1 + e1, y1 - b1 * 3, x2 + e2, y2 - b2 * 3, x2 + e2, y2 - b2 * 4, x1 + e1, y1 - b1 * 4, P.tLane[f]);
    if (s.i % 4 === 0) {
      var lw = Math.max(1, w1 * 0.16), lh = Math.max(1, (c2 - c1) * 0.6);
      c.fillStyle = P.tLight[f]; c.fillRect(x1 - lw / 2, c1, lw, lh);
    }
  }
  function portal(P, n, f) {
    var c = S.ctx, x1 = PX[n], y1 = PY[n], w1 = PW[n], t1 = PS[n] * TUN_H * S.sc, e1 = w1 * 1.2, c1 = y1 - t1;
    c.fillStyle = P.rock[f];
    c.beginPath();
    c.moveTo(x1 - w1 * 7, y1); c.lineTo(x1 - w1 * 5.5, c1 - w1 * 0.4); c.lineTo(x1 - w1 * 3, c1 - w1 * 1.1); c.lineTo(x1 - w1 * 0.5, c1 - w1 * 1.4);
    c.lineTo(x1 + w1 * 2.5, c1 - w1 * 1.2); c.lineTo(x1 + w1 * 5.2, c1 - w1 * 0.6); c.lineTo(x1 + w1 * 7, y1); c.closePath();
    c.moveTo(x1 - e1, y1); c.lineTo(x1 + e1, y1); c.lineTo(x1 + e1, c1); c.lineTo(x1 - e1, c1); c.closePath();
    c.fill('evenodd');
    c.strokeStyle = P.frame[f]; c.lineWidth = Math.max(1, w1 * 0.12);
    c.beginPath(); c.moveTo(x1 - e1, y1); c.lineTo(x1 - e1, c1); c.lineTo(x1 + e1, c1); c.lineTo(x1 + e1, y1); c.stroke();
  }
  function drawProps(P, s, n, f) {
    var c = S.ctx, W = S.W, k = PS[n], sc = S.sc, x0 = PX[n], y0 = PY[n];
    var fa = f > 6 ? 1 - (f - 6) / (FOGL - 6) * 0.9 : 1;
    if (fa < 1) c.globalAlpha = fa;
    for (var i = 0; i < s.spr.length; i++) {
      var sp = s.spr[i];
      if (sp.k === 'gate') { drawGate(P, sp, n, f); continue; }
      var d = SPR[sp.k], dw = d.w * k * sc, dh = d.h * k * sc;
      if (dh < 1.2) continue;
      var sx = x0 + k * sp.o * RW * sc;
      if (sx + dw < 0 || sx - dw > W || y0 - dh > S.H) continue;
      var cv = spriteCv(sp.k, sp.v, sp.f, P.night);
      // a lamp's pole stands at the offset, its arm over the road
      var lx = sp.k === 'lamp' ? (sp.f < 0 ? sx - dw * 0.86 : sx - dw * 0.14) : sx - dw / 2;
      var mag = dw * S.dk > cv.width * 1.6;            // close up: crisp pixels rather than blur
      if (mag) c.imageSmoothingEnabled = false;
      c.drawImage(cv, lx, y0 - dh, dw, dh);
      if (mag) c.imageSmoothingEnabled = true;
    }
    c.globalAlpha = 1;
  }
  function drawGate(P, sp, n, f) {
    var c = S.ctx, k = PS[n], sc = S.sc, x0 = PX[n], y0 = PY[n], w = PW[n];
    var top = y0 - k * 2900 * sc, bot = y0 - k * 2250 * sc, pw = Math.max(1, w * 0.05);
    if (y0 - top < 2) return;
    var post = P.night ? '#8a8a92' : '#5a5e66';
    c.fillStyle = post;
    c.fillRect(x0 - w * 1.3 - pw / 2, top, pw, y0 - top); c.fillRect(x0 + w * 1.3 - pw / 2, top, pw, y0 - top);
    var start = sp.f === 1;
    c.fillStyle = start ? '#18181c' : rgb(S.th.acc);
    c.fillRect(x0 - w * 1.3, top, w * 2.6, bot - top);
    var bh = bot - top;
    if (start) {
      var sq = Math.max(1, bh / 4), cols = Math.ceil(w * 2.6 / sq);
      c.fillStyle = '#f2f2f2';
      for (var i = 0; i < cols; i++) for (var j = 0; j < 4; j++) if ((i + j) % 2) c.fillRect(x0 - w * 1.3 + i * sq, top + j * sq, Math.min(sq, x0 + w * 1.3 - (x0 - w * 1.3 + i * sq)), sq);
    }
    if (bh > 9) {
      c.fillStyle = start ? '#18181c' : '#ffffff';
      if (start) { c.fillRect(x0 - bh * 2.2, top + bh * 0.1, bh * 4.4, bh * 0.8); c.fillStyle = '#fff'; }
      c.font = '800 ' + Math.round(bh * 0.62) + 'px ' + S.th.font; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(start ? 'FINISH' : 'CHECKPOINT', x0, top + bh * 0.52);
    }
  }
  function drawCarAt(car, n, f, P) {
    var c = S.ctx, t = car._f, k = PS[n] + (PS[n + 1] - PS[n]) * t, sc = S.sc;
    var x = PX[n] + (PX[n + 1] - PX[n]) * t + k * car.x * RW * sc, y = PY[n] + (PY[n + 1] - PY[n]) * t;
    var kd = ENGINE.KINDS[car.kind] || ENGINE.KINDS.sedan, dw = RW * ENGINE.CAR_W * kd.w * k * sc, dh = dw * (CAR_H[car.kind] * 1.06) / (RW * ENGINE.CAR_W * kd.w);
    if (dw < 1.5 || x + dw < 0 || x - dw > S.W) return;
    var cv = carCv(car.kind, car.col, P.night);
    var fa = f > 7 ? 1 - (f - 7) / (FOGL - 7) * 0.9 : 1;
    if (fa < 1) c.globalAlpha = fa;
    var bob = car.v > 100 ? Math.sin(S.animT * 20 + car.z * 0.01) * dh * 0.008 : 0;
    if (car.spin > 0) { c.save(); c.translate(x, y); c.rotate(Math.sin(car.spin * 16) * 0.25); c.drawImage(cv, -dw / 2, -dh, dw, dh); c.restore(); }
    else c.drawImage(cv, x - dw / 2, y - dh + bob, dw, dh);
    if (car.rival && dw > 26 && car.name) {
      var fs = Math.max(9, Math.min(13, dw * 0.16));
      c.font = '700 ' + Math.round(fs) + 'px ' + S.th.font; c.textAlign = 'center'; c.textBaseline = 'bottom';
      var nm = car.name.split(' ')[0].toUpperCase(), tw = c.measureText(nm).width;
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(x - tw / 2 - 3, y - dh - fs - 6, tw + 6, fs + 4);
      c.fillStyle = rgb(mix(car.col, [255, 255, 255], 0.35)); c.fillText(nm, x, y - dh - 3);
    }
    if (car.nosOn > 0 && dw > 8) { c.fillStyle = 'rgba(120,200,255,0.75)'; ell(c, x - dw * 0.3, y - dh * 0.15, dw * 0.08, dh * 0.08); ell(c, x + dw * 0.3, y - dh * 0.15, dw * 0.08, dh * 0.08); }
    c.globalAlpha = 1;
  }
  function drawPlayer(g, cy, sc, zoff, P) {
    var c = S.ctx, p = g.p, k = CAM_DEPTH / zoff;
    var dw = RW * ENGINE.CAR_W * k * sc, dh = dw * CAR_H.coupe * 1.06 / (RW * ENGINE.CAR_W);
    var x = S.W / 2, y = cy + k * CAM_H * sc;
    var bounce = (p.off && p.v > 200 ? (Math.random() - 0.5) * 3 : 0) + Math.sin(S.animT * 30) * (p.v / p.st.top) * 0.8;
    var lean = p.steer > 0.3 ? 1 : p.steer < -0.3 ? -1 : 0;
    var cv = carCv('coupe', paintCol().map(Math.round), P.night, lean);
    S.carScr = { x: x, y: y, w: dw, h: dh };
    c.save();
    c.translate(x, y + bounce);
    var rot = p.spin > 0 ? Math.sin(p.spin * 16) * 0.4 : p.drift * sgn(p.steer) * 0.05;
    if (rot) c.rotate(rot);
    c.drawImage(cv, -dw / 2, -dh, dw, dh);
    if (p.nosOn) {
      var fl = 0.6 + Math.random() * 0.6;
      c.fillStyle = 'rgba(110,190,255,0.85)'; ell(c, -dw * 0.28, -dh * 0.12, dw * 0.06, dh * 0.12 * fl); ell(c, dw * 0.28, -dh * 0.12, dw * 0.06, dh * 0.12 * fl);
      c.fillStyle = 'rgba(255,255,255,0.9)'; ell(c, -dw * 0.28, -dh * 0.12, dw * 0.03, dh * 0.06 * fl); ell(c, dw * 0.28, -dh * 0.12, dw * 0.03, dh * 0.06 * fl);
    }
    if (p.brakeOn) { c.fillStyle = 'rgba(255,40,30,0.45)'; ell(c, -dw * 0.35, -dh * 0.4, dw * 0.14, dh * 0.08); ell(c, dw * 0.35, -dh * 0.4, dw * 0.14, dh * 0.08); }
    c.restore();
  }

  // ---- particles (screen space, pooled) + weather + speed lines ----
  function makeFx() {
    S.pt = [];
    for (var i = 0; i < 140; i++) S.pt.push({ on: 0, x: 0, y: 0, vx: 0, vy: 0, t: 0, max: 1, r: 2, col: '' });
    S.snow = [];
    for (var j = 0; j < 70; j++) S.snow.push({ x: Math.random(), y: Math.random(), s: 0.5 + Math.random() });
  }
  function puff(x, y, vx, vy, life, r, col, gr) {
    var pt = S.pt;
    for (var i = 0; i < pt.length; i++) if (!pt[i].on) { var q = pt[i]; q.on = 1; q.x = x; q.y = y; q.vx = vx; q.vy = vy; q.t = 0; q.max = life; q.r = r; q.col = col; q.gr = gr || 0.1; return; }
  }
  function drawFx(g, dt, P) {
    var c = S.ctx, p = g.p, W = S.W, H = S.H, pov = S.save.set.cam === 'pov', sp = p.v / p.st.top;
    // emitters: wheels in chase view, the bottom corners in the cockpit
    var ex1, ex2, ey;
    if (S.carScr) { ex1 = S.carScr.x - S.carScr.w * 0.38; ex2 = S.carScr.x + S.carScr.w * 0.38; ey = S.carScr.y - 2; }
    else { ex1 = W * 0.12; ex2 = W * 0.88; ey = S.cy + (H - S.cy) * 0.45; }
    if (!S.rm && dt > 0 && !S.paused) {
      if (p.drift > 0.3 && Math.random() < 0.8) { puff(ex1, ey, -20 - Math.random() * 30, -10 - Math.random() * 20, 0.7, 6 + Math.random() * 8, 'rgba(230,230,230,'); puff(ex2, ey, 20 + Math.random() * 30, -10 - Math.random() * 20, 0.7, 6 + Math.random() * 8, 'rgba(230,230,230,'); }
      if (p.off && p.v > 400 && Math.random() < 0.7) { var dc = P.raw.b === 4 ? 'rgba(250,250,255,' : P.raw.b === 1 ? 'rgba(200,160,100,' : 'rgba(140,120,90,'; puff(Math.random() < 0.5 ? ex1 : ex2, ey, (Math.random() - 0.5) * 80, -30 - Math.random() * 40, 0.6, 5 + Math.random() * 7, dc); }
      if (p.nosOn && S.carScr && Math.random() < 0.6) { puff(S.carScr.x + (Math.random() - 0.5) * S.carScr.w * 0.5, S.carScr.y - S.carScr.h * 0.1, (Math.random() - 0.5) * 30, 30 + Math.random() * 30, 0.3, 3 + Math.random() * 3, 'rgba(140,210,255,'); }
    }
    var pt = S.pt;
    for (var i = 0; i < pt.length; i++) {
      var q = pt[i];
      if (!q.on) continue;
      q.t += dt;
      if (q.t >= q.max) { q.on = 0; continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 160 * dt * q.gr;
      var a = 1 - q.t / q.max, rr2 = q.r * (1 + q.t / q.max * 1.5);
      c.fillStyle = q.col + (a * 0.55).toFixed(3) + ')';
      c.fillRect(q.x - rr2 / 2, q.y - rr2 / 2, rr2, rr2);
    }
    // snow
    if (P.raw.b === 4 && !S.rm) {
      c.fillStyle = 'rgba(255,255,255,0.85)';
      var drift = -p.steer * sp * 0.4 - (segAt(g.T, Math.floor(p.z / SEG)).c * sp * 0.05);
      for (var j = 0; j < S.snow.length; j++) {
        var f = S.snow[j];
        f.y += dt * (0.12 + sp * 0.5) * f.s; f.x += dt * (drift + (f.x - 0.5) * sp * 0.8) * f.s;
        if (f.y > 1 || f.x < 0 || f.x > 1) { f.y = Math.random() * 0.2; f.x = Math.random(); }
        var sz = 1 + f.s * 1.4 * (0.5 + f.y);
        c.fillRect(f.x * W, f.y * H, sz, sz);
      }
    }
    // speed lines (nitro, slipstream)
    if ((p.nosOn || p.drafting) && !S.rm) {
      c.strokeStyle = p.nosOn ? 'rgba(170,220,255,0.55)' : 'rgba(255,255,255,0.35)'; c.lineWidth = 1.5;
      c.beginPath();
      var cx = W / 2, cyy = S.cy;
      for (var l = 0; l < (p.nosOn ? 16 : 8); l++) {
        var ang = Math.random() * Math.PI * 2, r0 = W * (0.25 + Math.random() * 0.25), r1 = r0 + W * (0.12 + Math.random() * 0.2);
        c.moveTo(cx + Math.cos(ang) * r0, cyy + Math.sin(ang) * r0 * 0.7); c.lineTo(cx + Math.cos(ang) * r1, cyy + Math.sin(ang) * r1 * 0.7);
      }
      c.stroke();
    }
    // night: headlights on the road ahead
    if (P.night && !segAt(g.T, Math.floor(p.z / SEG)).tun) {
      if (!S.lightC || S.lightK !== W + 'x' + H + pov) {
        var lc = S.lightC || document.createElement('canvas'), lw = Math.ceil(W * 0.5), lh = Math.ceil((H - S.cy) * 0.6);
        lc.width = lw; lc.height = lh;
        var cc = lc.getContext('2d');
        cc.scale(lw / (2 * lh), 1);                     // an ellipse that fades out inside the canvas
        var gr = cc.createRadialGradient(lh, lh, 2, lh, lh, lh);
        gr.addColorStop(0, 'rgba(255,240,200,0.34)'); gr.addColorStop(0.6, 'rgba(255,240,200,0.12)'); gr.addColorStop(1, 'rgba(255,240,200,0)');
        cc.fillStyle = gr; cc.fillRect(0, 0, 2 * lh, lh);
        S.lightC = lc; S.lightK = W + 'x' + H + pov;
      }
      c.globalCompositeOperation = 'lighter';
      c.drawImage(S.lightC, W * 0.25, S.cy + (H - S.cy) * (pov ? 0.08 : 0.2), W * 0.5, (H - S.cy) * 0.6);
      c.globalCompositeOperation = 'source-over';
    }
  }

  function drawCockpit(g, shx, shy) {
    var c = S.ctx, p = g.p, W = S.W, H = S.H, G = dashGeom(), cv = dashCv();
    var bump = (p.off && p.v > 300 ? Math.sin(S.animT * 47) * 1.5 : 0) + shy * 0.5;
    c.drawImage(cv, 0, G.hood + bump, W, H - G.hood + 2);
    var set = S.save.set, kmh = ENGINE.kmh(p.v), spd = set.units === 'mph' ? kmh * 0.621371 : kmh, mx = set.units === 'mph' ? 220 : 360;
    needle(c, G.gx1, G.gy + bump, G.gr, Math.min(1.02, spd / mx));
    needle(c, G.gx2, G.gy + bump, G.gr, Math.min(1.02, p.rpm * 8 / 9));
    // digital readout + gear + nitro bar in the middle of the dash
    var fs = G.fs, cx = W / 2, ty = G.top + G.dh * 0.06 + bump;
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.font = '800 ' + Math.round(fs) + 'px ' + S.th.font; c.fillStyle = '#f2f2f2';
    c.fillText(String(Math.round(spd)), cx - fs * 0.5, ty);
    c.font = '700 ' + Math.round(fs * 0.42) + 'px ' + S.th.font; c.fillStyle = '#9a9aa0'; c.textAlign = 'left';
    c.fillText(set.units === 'mph' ? 'MPH' : 'KM/H', cx + fs * 0.55, ty + fs * 0.12);
    c.fillStyle = p.rpm > 0.9 ? '#ff6060' : rgb(S.th.acc); c.font = '800 ' + Math.round(fs * 0.55) + 'px ' + S.th.font;
    c.fillText(g.phase === 'count' ? 'N' : String(p.gear), cx + fs * 0.55, ty + fs * 0.6);
    var bw = Math.min(W * 0.24, 140), bx = cx - bw / 2, by = ty + fs * 1.25, bh = Math.max(4, fs * 0.22);
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(bx, by, bw, bh);
    c.fillStyle = p.nosOn ? '#9ad8ff' : p.nos > 0.99 ? '#4fb8ff' : '#2f7fc0'; c.fillRect(bx, by, bw * p.nos, bh);
    if (p.drafting) { c.fillStyle = '#ffffff'; c.font = '700 ' + Math.round(fs * 0.36) + 'px ' + S.th.font; c.textAlign = 'center'; c.fillText('SLIPSTREAM', cx, by + bh + 2); }
    // the wheel
    var wr = G.wr, wx = W / 2, wy = G.wy + bump, rot = p.steer * 1.5 + (p.spin > 0 ? Math.sin(p.spin * 20) * 0.6 : 0);
    c.save(); c.translate(wx, wy); c.rotate(rot);
    c.strokeStyle = '#141417'; c.lineWidth = Math.max(6, wr * 0.16);
    c.beginPath(); c.arc(0, 0, wr, 0, 6.2832); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = Math.max(1, wr * 0.03);
    c.beginPath(); c.arc(0, 0, wr + wr * 0.04, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
    c.strokeStyle = rgb(S.th.acc); c.lineWidth = Math.max(2, wr * 0.07);
    c.beginPath(); c.arc(0, 0, wr, -Math.PI / 2 - 0.08, -Math.PI / 2 + 0.08); c.stroke();
    c.fillStyle = '#1c1c20';
    c.fillRect(-wr, -wr * 0.07, wr * 2, wr * 0.14);
    c.fillRect(-wr * 0.07, 0, wr * 0.14, wr);
    c.beginPath(); c.arc(0, 0, wr * 0.26, 0, 6.2832); c.fill();
    c.fillStyle = rgb(S.th.acc); c.beginPath(); c.arc(0, 0, wr * 0.09, 0, 6.2832); c.fill();
    c.restore();
  }
  function needle(c, x, y, r, f) {
    var a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, f);
    c.strokeStyle = '#ff5a3a'; c.lineWidth = Math.max(1.5, r * 0.06); c.lineCap = 'round';
    c.beginPath(); c.moveTo(x - Math.cos(a) * r * 0.12, y - Math.sin(a) * r * 0.12); c.lineTo(x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82); c.stroke();
    c.fillStyle = '#2a2a2e'; c.beginPath(); c.arc(x, y, r * 0.1, 0, 6.2832); c.fill();
    c.lineCap = 'butt';
  }

  // ---- HUD (theme colors) ----
  function box(c, x, y, w, h) {
    c.fillStyle = S.th.hudBg; rrect(c, x, y, w, h, 6); c.fill();
    c.strokeStyle = S.th.hudBd; c.lineWidth = 1; c.stroke();
  }
  function drawHud(g) {
    var c = S.ctx, W = S.W, H = S.H, p = g.p, th = S.th, small = W < 420 || H < 300, fs = small ? 11 : 13, big = small ? 18 : 22, pad = small ? 6 : 8;
    if (S.demo) return;
    c.textBaseline = 'top';
    var hy = 8, bh = big + fs + 10;
    if (g.mode === 'career') {
      // position + lap
      var place = p.fin ? p.place : placeOf(g), lap = Math.min(g.laps, Math.max(1, Math.floor(p.z / g.L) + 1));
      box(c, pad, hy, small ? 86 : 104, bh);
      c.textAlign = 'left'; c.fillStyle = th.hudAc; c.font = '800 ' + big + 'px ' + th.font;
      c.fillText(place + (place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th'), pad + 8, hy + 5);
      c.fillStyle = th.hudMu; c.font = '700 ' + fs + 'px ' + th.font;
      c.fillText('/' + g.N + '  LAP ' + lap + '/' + g.laps, pad + 8, hy + big + 6);
      // time
      var tw = small ? 96 : 116;
      box(c, W - pad - tw, hy, tw, bh);
      c.textAlign = 'right'; c.fillStyle = th.hudTx; c.font = '800 ' + (big - 3) + 'px ' + th.font;
      c.fillText(fmtTime(g.phase === 'count' ? 0 : p.fin ? p.finT : g.t), W - pad - 8, hy + 6);
      c.fillStyle = th.hudMu; c.font = '700 ' + (fs - 1) + 'px ' + th.font;
      c.fillText(p.bestLap ? 'BEST ' + fmtTime(p.bestLap) : 'LAP ' + fmtTime(Math.max(0, g.t - p.lapT0)), W - pad - 8, hy + big + 6);
      // race progress: everyone on one bar
      var bx = pad + (small ? 94 : 116), bw2 = W - 2 * pad - (small ? 94 : 116) - tw - 8, byy = hy + bh / 2;
      if (bw2 > 40) {
        c.fillStyle = th.hudBg; c.fillRect(bx, byy - 3, bw2, 6);
        var end = g.laps * g.L;
        for (var i = 0; i < g.cars.length; i++) { var cr = g.cars[i]; c.fillStyle = rgb(cr.col); c.fillRect(bx + bw2 * Math.max(0, Math.min(1, cr.z / end)) - 2, byy - 4, 4, 8); }
        c.fillStyle = th.hudAc; c.fillRect(bx + bw2 * Math.max(0, Math.min(1, p.z / end)) - 3, byy - 7, 6, 14);
        for (var lp = 1; lp < g.laps; lp++) { c.fillStyle = th.hudMu; c.fillRect(bx + bw2 * lp / g.laps, byy - 6, 1, 12); }
      }
      drawMinimap(g, W - pad - (small ? 58 : 72), hy + bh + 6, small ? 58 : 72);
    } else {
      // time left (big, center), distance + score
      var tl = g.timeLeft, warn = tl < 10 && g.phase === 'race';
      var cw = small ? 100 : 120;
      box(c, W / 2 - cw / 2, hy, cw, bh);
      c.textAlign = 'center'; c.fillStyle = warn ? (Math.floor(S.animT * 4) % 2 ? '#e33' : th.hudTx) : th.hudTx; c.font = '800 ' + (big + 2) + 'px ' + th.font;
      c.fillText(tl.toFixed(1), W / 2, hy + 4);
      c.fillStyle = th.hudMu; c.font = '700 ' + (fs - 1) + 'px ' + th.font; c.fillText('TIME', W / 2, hy + big + 7);
      var lw = small ? 84 : 110;
      box(c, pad, hy, lw, bh);
      c.textAlign = 'left'; c.fillStyle = th.hudAc; c.font = '800 ' + (big - 3) + 'px ' + th.font;
      c.fillText((g.dist / 1000).toFixed(2), pad + 7, hy + 6);
      c.fillStyle = th.hudMu; c.font = '700 ' + (fs - 1) + 'px ' + th.font; c.fillText(S.save.set.units === 'mph' ? 'MI' : 'KM', pad + 7, hy + big + 6);
      if (S.save.set.units === 'mph') { c.fillStyle = th.hudAc; c.font = '800 ' + (big - 3) + 'px ' + th.font; c.fillStyle = th.hudBg; c.fillRect(pad + 2, hy + 3, lw - 4, big); c.fillStyle = th.hudAc; c.fillText((g.dist / 1609.34).toFixed(2), pad + 7, hy + 6); }
      box(c, W - pad - lw, hy, lw, bh);
      c.textAlign = 'right'; c.fillStyle = th.hudTx; c.font = '800 ' + (big - 3) + 'px ' + th.font;
      c.fillText(String(g.score), W - pad - 7, hy + 6);
      c.fillStyle = th.hudMu; c.font = '700 ' + (fs - 1) + 'px ' + th.font;
      c.fillText(g.combo > 1 ? 'COMBO x' + g.combo : 'SCORE', W - pad - 7, hy + big + 6);
      // progress to the next checkpoint
      var seg = Math.floor(p.z / SEG), cpf = (seg % CP_LEN) / CP_LEN, pw = W - 2 * pad, py = hy + bh + 6;
      c.fillStyle = th.hudBg; c.fillRect(pad, py, pw, 5);
      c.fillStyle = th.hudAc; c.fillRect(pad, py, pw * cpf, 5);
      c.fillStyle = th.hudTx; c.font = '700 ' + (fs - 2) + 'px ' + th.font; c.textAlign = 'right';
      c.fillText('CP ' + (g.cpIdx + 1) + ' · ' + BIOMES[segAt(g.T, seg).b].name.toUpperCase(), W - pad, py + 8);
    }
    // chase cam: speed + nitro at the bottom corners
    if (S.save.set.cam !== 'pov') {
      var set = S.save.set, kmh = ENGINE.kmh(p.v), spd = Math.round(set.units === 'mph' ? kmh * 0.621371 : kmh);
      var by2 = H - pad - bh;
      box(c, pad, by2, small ? 92 : 110, bh);
      c.textAlign = 'left'; c.fillStyle = th.hudTx; c.font = '800 ' + big + 'px ' + th.font; c.fillText(String(spd), pad + 8, by2 + 5);
      c.fillStyle = th.hudMu; c.font = '700 ' + fs + 'px ' + th.font;
      c.fillText((set.units === 'mph' ? 'MPH' : 'KM/H') + '  G' + (g.phase === 'count' ? 'N' : p.gear), pad + 8, by2 + big + 6);
      var nw = small ? 92 : 120;
      box(c, W - pad - nw, by2, nw, bh);
      c.fillStyle = th.hudMu; c.font = '700 ' + fs + 'px ' + th.font; c.textAlign = 'left';
      c.fillText(p.drafting ? 'SLIPSTREAM' : 'NITRO', W - pad - nw + 8, by2 + 5);
      c.fillStyle = 'rgba(128,128,128,0.25)'; c.fillRect(W - pad - nw + 8, by2 + bh - 14, nw - 16, 7);
      c.fillStyle = p.nosOn ? '#5ec4ff' : th.hudAc; c.fillRect(W - pad - nw + 8, by2 + bh - 14, (nw - 16) * p.nos, 7);
    }
    // countdown, messages
    if (g.phase === 'count') {
      var n = Math.ceil(g.countT);
      if (n <= 3) bigText(String(n), 1 - (n - g.countT), th.hudTx);
    } else if (g.t < 0.9 && g.phase === 'race') bigText('GO!', 1 - g.t / 0.9, th.hudAc);
    if (S.msg && S.msg.t > 0) {
      var m = S.msg, a = Math.min(1, m.t * 2.5), yy = H * (S.save.set.cam === 'pov' ? 0.3 : 0.34);
      c.globalAlpha = a;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '800 ' + (big + 2) + 'px ' + th.font;
      var mw = c.measureText(m.txt).width;
      c.font = '700 ' + fs + 'px ' + th.font;
      var sw = m.sub ? c.measureText(m.sub).width : 0;
      var bw3 = Math.max(mw, sw) + 24, bh3 = big + (m.sub ? fs + 18 : 14);
      box(c, W / 2 - bw3 / 2, yy - bh3 / 2, bw3, bh3);
      c.font = '800 ' + (big + 2) + 'px ' + th.font; c.fillStyle = m.col || th.hudAc;
      c.fillText(m.txt, W / 2, yy - (m.sub ? fs * 0.6 : 0));
      if (m.sub) { c.font = '700 ' + fs + 'px ' + th.font; c.fillStyle = th.hudMu; c.fillText(m.sub, W / 2, yy + big * 0.55); }
      c.globalAlpha = 1;
      m.t -= S.fdt || 0;
    }
  }
  function bigText(t, a, col) {
    var c = S.ctx, W = S.W, H = S.H, fs = Math.round(Math.min(W, H) * 0.2) * (1 + (1 - a) * 0.3);
    c.globalAlpha = Math.max(0, Math.min(1, a * 1.6));
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '900 ' + Math.round(fs) + 'px ' + S.th.font;
    c.lineWidth = Math.max(3, fs * 0.08); c.strokeStyle = S.th.dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
    c.strokeText(t, W / 2, H * 0.36); c.fillStyle = col; c.fillText(t, W / 2, H * 0.36);
    c.globalAlpha = 1;
  }
  // the loop's outline: integrate the curves to headings, then bend the drift out so it closes
  function minimapPts(T) {
    var n = T.n, pts = [], x = 0, y = 0, h = 0, i;
    for (i = 0; i < n; i++) { h += T.segs[i].c * 0.0016; pts.push(x, y); x += Math.sin(h); y -= Math.cos(h); }
    // spread the heading error over the lap
    var tot = h, turns = Math.round(tot / (Math.PI * 2)) || (tot >= 0 ? 1 : -1), err = tot - turns * Math.PI * 2;
    pts = []; x = 0; y = 0; h = 0;
    for (i = 0; i < n; i++) { h += T.segs[i].c * 0.0016 - err / n; pts.push(x, y); x += Math.sin(h); y -= Math.cos(h); }
    var ex = x, ey = y;
    for (i = 0; i < n; i++) { pts[i * 2] -= ex * i / n; pts[i * 2 + 1] -= ey * i / n; }
    return pts;
  }
  function drawMinimap(g, x, y, size) {
    var c = S.ctx, T = g.T;
    if (!S.mapC || S.mapT !== T) {
      var pts = minimapPts(T), minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, i;
      for (i = 0; i < pts.length; i += 2) { minx = Math.min(minx, pts[i]); maxx = Math.max(maxx, pts[i]); miny = Math.min(miny, pts[i + 1]); maxy = Math.max(maxy, pts[i + 1]); }
      var sc = (size - 12) / Math.max(1, maxx - minx, maxy - miny), ox = (size - (maxx - minx) * sc) / 2 - minx * sc, oy = (size - (maxy - miny) * sc) / 2 - miny * sc;
      S.mapP = { pts: pts, sc: sc, ox: ox, oy: oy };
      var cv = S.mapC || document.createElement('canvas');
      cv.width = Math.ceil(size * S.dk); cv.height = Math.ceil(size * S.dk);
      var m = cv.getContext('2d');
      m.setTransform(S.dk, 0, 0, S.dk, 0, 0);
      m.fillStyle = S.th.hudBg; rrect(m, 0, 0, size, size, 6); m.fill(); m.strokeStyle = S.th.hudBd; m.lineWidth = 1; m.stroke();
      m.strokeStyle = S.th.hudMu; m.lineWidth = 2.2; m.lineJoin = 'round';
      m.beginPath();
      for (i = 0; i < pts.length; i += 8) m[i ? 'lineTo' : 'moveTo'](pts[i] * sc + ox, pts[i + 1] * sc + oy);
      m.closePath(); m.stroke();
      m.fillStyle = S.th.hudTx; m.fillRect(pts[0] * sc + ox - 1, pts[1] * sc + oy - 3, 2, 6);
      S.mapC = cv; S.mapT = T; S.mapS = size;
    }
    c.drawImage(S.mapC, x, y, size, size);
    var M = S.mapP, n = T.n;
    function dot(z, col, r) {
      var i = ((Math.floor(z / SEG) % n) + n) % n;
      c.fillStyle = col; c.beginPath(); c.arc(x + M.pts[i * 2] * M.sc + M.ox, y + M.pts[i * 2 + 1] * M.sc + M.oy, r, 0, 6.2832); c.fill();
    }
    for (var j = 0; j < g.cars.length; j++) dot(g.cars[j].z, rgb(g.cars[j].col), 2.2);
    dot(g.p.z, S.th.hudAc, 3.4);
  }

  // ---- icons ----
  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_CAM = svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5.5M5 15l5-1.8M19 15l-5-1.8"/>');

  var ART = ' ▄▀█ █▀█ █▀▀ ▀▄▀   █▀█ █ █ █▀ █ █\n' +
            ' █▀█ █▀▀ ██▄ █ █   █▀▄ █▄█ ▄█ █▀█';
  var ROAD_ART = '══════╱  │  ╲══════';

  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ord(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  function units() { return S.save.set.units; }
  function lapLen(n) { var m = n * SEG * KMH_TOP / 3.6 / V_BASE; return units() === 'mph' ? (m / 1609.34).toFixed(2) + ' mi' : (m / 1000).toFixed(2) + ' km'; }
  function distTxt(m) { return units() === 'mph' ? (m / 1609.34).toFixed(2) + ' mi' : (m / 1000).toFixed(2) + ' km'; }
  function autoGas() { var a = S.save.set.autogas; return a == null ? S.coarse : !!a; }
  function chip(attr, val, label, on, extra) { return '<button type="button" class="pr-chip' + (on ? ' on' : '') + '" ' + attr + '="' + val + '"' + (extra || '') + '>' + label + '</button>'; }

  // ---- cards ----
  function showCard(kind) {
    S.card = kind;
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.stage.classList.remove('dim'); syncHead(); return; }
    var h = cardHtml(kind);
    S.ovl.innerHTML = h;
    S.ovl.style.display = '';
    S.ovl.scrollTop = 0;
    S.stage.classList.add('dim');
    syncHead();
  }
  function cardHtml(kind) {
    var sv = S.save, set = sv.set, h = '';
    if (kind === 'menu') {
      h += '<div class="pr-card"><pre class="pr-art">' + ART + '</pre><div class="pr-road">' + ROAD_ART + '</div>';
      h += '<div class="pr-tabs">' + ['race', 'garage', 'settings'].map(function (t) { return '<button type="button" data-tab="' + t + '" class="' + (S.tab === t ? 'on' : '') + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'; }).join('') + '</div>';
      if (S.tab === 'race') {
        var b = sv.best.endless[set.diff], cur = sv.cur;
        h += '<button type="button" class="pr-mode" data-act="endless" data-primary="1"><b>ENDLESS HIGHWAY</b><span>Beat the clock, hit checkpoints, weave through traffic.</span><i>' +
          (b ? 'Best ' + fmtN(b.score) + ' pts · ' + distTxt(b.dist) : 'No record yet') + ' · ' + DIFFS[set.diff].name + '</i></button>';
        h += '<button type="button" class="pr-mode" data-act="cups"><b>CAREER</b><span>Cups of multi-lap races vs named rivals. Earn credits, upgrade, unlock.</span><i>' +
          (cur ? CUPS[cur.cup].name + ' · race ' + (cur.race + 1) + '/' + CUPS[cur.cup].n : sv.unlocked + '/' + CUPS.length + ' cups open') + ' · ' + fmtN(sv.car.credits) + ' cr</i></button>';
        h += '<div class="pr-sec"><div class="pr-h">Difficulty</div><div class="pr-chips">' +
          DIFFS.map(function (d, i) { return chip('data-diff', i, d.name, set.diff === i); }).join('') + '</div></div>';
        h += '<div class="pr-foot"><button type="button" class="pr-lnk" data-act="help">How to play</button><span>' + sv.stats.races + ' races · ' + sv.stats.wins + ' wins</span></div>';
      } else if (S.tab === 'garage') h += garageHtml();
      else h += settingsHtml();
      h += '</div>';
    } else if (kind === 'help') {
      h += '<div class="pr-card"><div class="pr-title">HOW TO DRIVE</div>' +
        '<div class="pr-keys"><div><b>← →</b> / <b>A D</b> steer</div><div><b>↑</b> / <b>W</b> gas · <b>↓</b> / <b>S</b> / <b>Shift</b> brake</div>' +
        '<div><b>Space</b> nitro · <b>C</b> camera · <b>P</b> / <b>Esc</b> pause</div><div><b>Touch</b> ◀ ▶ to steer (or the screen halves / tilt), NOS · BRK · GAS</div></div>' +
        '<p>Curves pull you <b>outward</b> — the faster you go, the harder. Brake before sharp bends; the chevron signs warn you.</p>' +
        '<p>Leave the road and you slow down and shake; hit a tree, rock or car and you can <b>spin out</b>. Tunnels have walls.</p>' +
        '<p>Tuck in right behind a car for a <b>slipstream</b> boost. Nitro refills over time — faster while you <b>drift</b> through a bend.</p>' +
        '<p><b>Endless</b>: reach each checkpoint before the clock runs out; near misses build a combo. <b>Career</b>: finish high for points and credits, spend them in the garage, podium a cup to open the next.</p>' +
        '<button type="button" class="pr-go" data-act="close-help" data-primary="1">' + (S.firstRun ? "LET'S DRIVE" : 'GOT IT') + '</button></div>';
    } else if (kind === 'cups') {
      h += '<div class="pr-card"><div class="pr-top"><span class="pr-brand">CAREER</span><span class="pr-meta">' + fmtN(sv.car.credits) + ' cr</span></div>';
      if (sv.cur) {
        var C = CUPS[sv.cur.cup];
        h += '<button type="button" class="pr-mode hot" data-act="pre" data-primary="1"><b>CONTINUE · ' + esc(C.name.toUpperCase()) + '</b><span>Race ' + (sv.cur.race + 1) + ' of ' + C.n + ' · ' + esc(cupTrack(sv.cur.cup, sv.cur.race).name) +
          ' · ' + DIFFS[sv.cur.diff].name + '</span><i>You: ' + (sv.cur.pts.you || 0) + ' pts</i></button>';
      }
      h += '<div class="pr-cups">';
      CUPS.forEach(function (C, i) {
        var lock = i >= sv.unlocked, rec = sv.cups[i], tro = rec.best ? ['', '★ 1st', '☆ 2nd', '☆ 3rd'][rec.best] : '';
        h += '<button type="button" class="pr-cup' + (lock ? ' lock' : '') + (sv.cur && sv.cur.cup === i ? ' cur' : '') + '" data-cup="' + i + '"' + (lock ? ' disabled' : '') + '><b>' + (lock ? '\u{1F512} ' : '') + esc(C.name) + '</b>' +
          '<span>' + C.n + ' races · ' + C.laps + ' laps · ' + (C.rivals + 1) + ' cars</span><i>' + (lock ? 'podium the cup before' : tro || (rec.done ? 'entered' : 'new')) + '</i></button>';
      });
      h += '</div>';
      if (S.cupArm != null) h += '<div class="pr-confirm">Abandon ' + esc(CUPS[sv.cur.cup].name) + ' and start ' + esc(CUPS[S.cupArm].name) + '? <button type="button" class="pr-lnk danger" data-act="cup-yes">Yes</button> <button type="button" class="pr-lnk" data-act="cup-no">No</button></div>';
      h += '<div class="pr-btns"><button type="button" class="pr-go alt" data-act="menu">Back</button><button type="button" class="pr-go alt" data-act="garage">Garage</button></div></div>';
    } else if (kind === 'pre') {
      var cu = sv.cur, C2 = CUPS[cu.cup], tk = cupTrack(cu.cup, cu.race), g = S.g;
      h += '<div class="pr-card"><div class="pr-title">' + esc(C2.name.toUpperCase()) + '</div><div class="pr-sub">Race ' + (cu.race + 1) + ' of ' + C2.n + ' · ' + DIFFS[cu.diff].name + '</div>';
      h += '<div class="pr-big">' + esc(tk.name) + '</div><div class="pr-note">' + BIOMES[tk.biome].name + (tk.night ? ' by night' : '') + ' · ' + tk.laps + ' laps' + (g ? ' · ' + lapLen(g.T.n) + ' lap' : '') + '</div>';
      var st = cupStandings(sv);
      h += '<div class="pr-grid">';
      cupRivals(cu.cup).forEach(function (d) {
        var pts = cu.pts[d.id] || 0;
        h += '<div><b style="color:' + rgb(d.col) + '">■</b> ' + esc(d.name) + ' <i>' + esc(d.trait) + '</i><span>' + pts + '</span></div>';
      });
      h += '<div class="you"><b>■</b> You <i>' + (cu.race ? ord((st.filter(function (r) { return r.you; })[0] || { pos: 1 }).pos) + ' in cup' : 'cup points') + '</i><span>' + (cu.pts.you || 0) + '</span></div>';
      h += '</div>';
      h += '<div class="pr-btns"><button type="button" class="pr-go alt" data-act="cups">Back</button><button type="button" class="pr-go alt" data-act="garage">Garage</button><button type="button" class="pr-go" data-act="race" data-primary="1">START</button></div></div>';
    } else if (kind === 'pause') {
      h += '<div class="pr-card"><div class="pr-title">PAUSED</div>';
      h += '<div class="pr-sec"><div class="pr-h">Camera</div><div class="pr-chips">' + chip('data-cam', 'pov', 'Cockpit', set.cam === 'pov') + chip('data-cam', 'chase', 'Chase', set.cam === 'chase') + '</div></div>';
      h += '<button type="button" class="pr-go" data-act="resume" data-primary="1">RESUME</button>';
      h += '<div class="pr-btns"><button type="button" class="pr-go alt" data-act="restart">Restart</button><button type="button" class="pr-go alt" data-act="quit">Quit</button></div></div>';
    } else if (kind === 'over') {
      var ge = S.g, isNew = S.newBest, be = sv.best.endless[ge.diff];
      h += '<div class="pr-card"><div class="pr-title">TIME UP</div><div class="pr-big">' + fmtN(ge.score) + '<small> pts</small></div>';
      if (isNew) h += '<div class="pr-new">NEW BEST · ' + DIFFS[ge.diff].name.toUpperCase() + '</div>';
      h += '<pre class="pr-tab">Distance     <b>' + distTxt(ge.dist) + '</b>\nCheckpoints  <b>' + ge.cpIdx + '</b>\nCars passed  <b>' + ge.passes + '</b>\nNear misses  <b>' + ge.near + '</b>\nBest         <b>' + (be ? fmtN(be.score) : '-') + '</b></pre>';
      h += '<div class="pr-btns"><button type="button" class="pr-go alt" data-act="menu">Menu</button><button type="button" class="pr-go" data-act="endless" data-primary="1">DRIVE AGAIN</button></div></div>';
    } else if (kind === 'raceres') {
      var R = S.res, rows = R.rows, lead = rows[0].t;
      h += '<div class="pr-card"><div class="pr-title">' + (R.place === 1 ? 'VICTORY' : R.place <= 3 ? 'PODIUM' : 'RESULT') + '</div><div class="pr-big">' + ord(R.place) + '<small> / ' + rows.length + '</small></div>';
      h += '<div class="pr-res">';
      rows.forEach(function (r) {
        h += '<div class="' + (r.you ? 'you' : '') + '"><span>' + r.pos + '</span><b' + (r.col ? ' style="color:' + rgb(r.col) + '"' : '') + '>■</b> ' + esc(r.name) +
          '<i>' + (r.pos === 1 ? fmtTime(r.t) : '+' + (r.t - lead).toFixed(2) + (r.fin ? '' : '*')) + '</i><em>+' + r.pts + '</em></div>';
      });
      h += '</div><div class="pr-note">' + (S.g && S.g.p.bestLap ? 'Best lap ' + fmtTime(S.g.p.bestLap) + ' · ' : '') + '+' + fmtN(R.credits) + ' credits' + (R.prize ? '' : '') + '</div>';
      h += '<div class="pr-btns"><button type="button" class="pr-go" data-act="' + (R.cupDone ? 'cupres' : 'pre') + '" data-primary="1">' + (R.cupDone ? 'CUP RESULTS' : 'NEXT RACE') + '</button></div></div>';
    } else if (kind === 'cupres') {
      var R2 = S.res, cr = R2.cupRows || [], won = R2.cupPlace;
      h += '<div class="pr-card"><div class="pr-title">' + esc(CUPS[S.resCup].name.toUpperCase()) + '</div>';
      if (won <= 3) h += '<pre class="pr-art">' + ['', '   ___\n  (   )\n   ) (\n  /___\\', '  .---.\n  | 2 |\n  /___\\', '  .---.\n  | 3 |\n  /___\\'][won] + '</pre>';
      h += '<div class="pr-big">' + ord(won) + '<small> overall</small></div><div class="pr-res">';
      cr.forEach(function (r) { h += '<div class="' + (r.you ? 'you' : '') + '"><span>' + r.pos + '</span><b' + (r.col ? ' style="color:' + rgb(r.col) + '"' : '') + '>■</b> ' + esc(r.name) + '<i></i><em>' + r.pts + '</em></div>'; });
      h += '</div>';
      if (R2.prize) h += '<div class="pr-new">CUP PRIZE +' + fmtN(R2.prize) + ' cr</div>';
      if (R2.unlocked) h += '<div class="pr-new">UNLOCKED: ' + esc(CUPS[Math.min(CUPS.length - 1, S.resCup + 1)].name.toUpperCase()) + '</div>';
      if (won > 3) h += '<div class="pr-note">Finish the cup on the podium to unlock the next one. Upgrades help.</div>';
      h += '<div class="pr-btns"><button type="button" class="pr-go alt" data-act="garage">Garage</button><button type="button" class="pr-go" data-act="cups" data-primary="1">CONTINUE</button></div></div>';
    }
    return h;
  }
  function pips(n) { var s = ''; for (var i = 0; i < 5; i++) s += i < n ? '■' : '□'; return s; }
  function garageHtml() {
    var car = S.save.car, h = '<div class="pr-top"><span class="pr-brand">GARAGE</span><span class="pr-meta"><b>' + fmtN(car.credits) + '</b> credits</span></div><div class="pr-upgs">';
    UPGS.forEach(function (u) {
      var l = car.upg[u.id], c = upgCost(l), can = car.credits >= c;
      h += '<div class="pr-upg"><div><b>' + u.name + '</b> <span class="pr-pips">' + pips(l) + '</span><i>' + u.note + '</i></div>' +
        (l >= 5 ? '<span class="pr-max">MAX</span>' : '<button type="button" class="pr-buy" data-buy="' + u.id + '"' + (can ? '' : ' disabled') + '>' + fmtN(c) + '</button>') + '</div>';
    });
    h += '</div><div class="pr-sec"><div class="pr-h">Paint</div><div class="pr-chips">';
    PAINTS.forEach(function (pt, i) {
      var own = car.owned.indexOf(i) >= 0, col = pt.col ? rgb(pt.col) : 'var(--accent)';
      h += '<button type="button" class="pr-chip pr-paint' + (car.paint === i ? ' on' : '') + '" data-paint="' + i + '"' + (!own && car.credits < pt.cost ? ' disabled' : '') + '>' +
        '<b style="background:' + col + '"></b>' + esc(pt.name) + (own ? '' : ' <i>' + fmtN(pt.cost) + '</i>') + '</button>';
    });
    h += '</div></div><div class="pr-note">Credits come from Career races. Endless uses a fixed stock car so records stay fair.</div>';
    return h;
  }
  function settingsHtml() {
    var set = S.save.set, h = '';
    function row(label, chips) { return '<div class="pr-sec"><div class="pr-h">' + label + '</div><div class="pr-chips">' + chips + '</div></div>'; }
    h += row('Units', chip('data-set', 'units:kmh', 'km/h', set.units === 'kmh') + chip('data-set', 'units:mph', 'mph', set.units === 'mph'));
    h += row('Camera <i>C</i>', chip('data-set', 'cam:pov', 'Cockpit', set.cam === 'pov') + chip('data-set', 'cam:chase', 'Chase', set.cam === 'chase'));
    h += row('Steering', chip('data-set', 'sens:0.7', 'Gentle', +set.sens === 0.7) + chip('data-set', 'sens:1', 'Normal', +set.sens === 1) + chip('data-set', 'sens:1.35', 'Sharp', +set.sens === 1.35));
    h += row('Touch steering', chip('data-set', 'steer:buttons', 'Buttons', set.steer === 'buttons') + chip('data-set', 'steer:screen', 'Screen halves', set.steer === 'screen') + chip('data-set', 'steer:tilt', 'Tilt', set.steer === 'tilt'));
    if (set.steer === 'tilt') h += '<div class="pr-tilt"><button type="button" class="pr-go alt" data-act="tilt">' + (S.tiltOn ? 'Tilt is on ✓' : 'Enable tilt') + '</button><span>' + (S.tiltMsg || 'Hold the phone up like a wheel.') + '</span></div>';
    h += row('Auto gas <i>touch</i>', chip('data-set', 'autogas:on', 'On', autoGas()) + chip('data-set', 'autogas:off', 'Off', !autoGas()));
    h += row('Screen shake', chip('data-set', 'shake:1', 'On', !!set.shake) + chip('data-set', 'shake:0', 'Low', !set.shake));
    h += '<div class="pr-foot">' + (S.resetArm ? '<span class="pr-confirm">Erase career, credits and records? <button type="button" class="pr-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="pr-lnk" data-act="reset-no">Keep</button></span>'
      : '<button type="button" class="pr-lnk" data-act="reset">Reset progress</button>') + '</div>';
    return h;
  }

  // ---- flow ----
  function startDemo() {
    S.demo = true;
    S.g = newEndless({ seed: (Math.random() * 1e9) | 0, diff: 1, biome: (Math.random() * 5) | 0 });
    S.g.phase = 'race'; S.g.countT = 0; S.g.timeLeft = 999;
    S.g.p.v = S.g.p.st.top * 0.6;
    S.mapC = null;
  }
  function toMenu() {
    S.mode = 'menu'; S.paused = false; S.cupArm = null; S.resetArm = false;
    S.snd.engineOff();
    if (!S.demo || !S.g) startDemo();
    layout();
    showCard('menu');
    kick();
  }
  function startEndless() {
    S.demo = false;
    S.g = newEndless({ seed: (Math.random() * 1e9) | 0, diff: S.save.set.diff });
    beginPlay();
  }
  function preRace() {
    var cu = S.save.cur;
    if (!cu) { showCard('cups'); return; }
    S.demo = false; S.mode = 'pre'; stopLoop();
    S.snd.engineOff();
    S.g = newRace({ cup: cu.cup, ti: cu.race, diff: cu.diff, stats: carStats(S.save.car.upg) });
    S.mapC = null;
    layout();
    showCard('pre');
    S.fdt = 0; render(S.g);
  }
  function startRace() {
    var cu = S.save.cur;
    if (!cu) return;
    if (!S.g || S.g.mode !== 'career' || S.g.t > 0) S.g = newRace({ cup: cu.cup, ti: cu.race, diff: cu.diff, stats: carStats(S.save.car.upg) });
    S.mapC = null;
    beginPlay();
  }
  function beginPlay() {
    S.mode = 'play'; S.paused = false; S.acc = 0; S.msg = null; S.shake = 0; S.flash = 0; S.newBest = false;
    S.keys = {}; clearHeld();
    showCard(null);
    layout();
    S.snd.ensure(); S.snd.engineOn();
    kick();
  }
  function pause() {
    if (!S || S.mode !== 'play' || S.paused) return;
    S.paused = true; clearHeld();
    S.snd.engineOff();
    showCard('pause');
    stopLoop();
    S.fdt = 0; render(S.g);
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    S.snd.ensure(); S.snd.engineOn();
    kick();
  }
  function quitPlay() {
    S.paused = false;
    if (S.g && S.g.mode === 'career') { S.demo = false; preRace(); return; }
    S.g = null; S.demo = false;
    toMenu();
  }
  function restartPlay() {
    S.paused = false;
    if (S.g && S.g.mode === 'career') { S.g = null; startRace(); } else startEndless();
  }
  function finishGame() {
    var g = S.g;
    S.mode = 'over';
    S.snd.engineOff();
    clearHeld();
    if (g.mode === 'endless') {
      S.newBest = endlessRecord(S.save, g);
      persist();
      showCard('over');
      if (S.newBest) S.snd.tone(1046, 0.3, 'triangle', 0.05, null, 0.1);
    } else {
      var rows = standings(g), cup = S.save.cur ? S.save.cur.cup : 0;
      S.res = awardRace(S.save, rows); S.resCup = cup;
      persist();
      showCard('raceres');
    }
    stopLoop();
    layout();
    S.fdt = 0; render(g);
  }

  // ---- events from the engine: sound, shake, messages ----
  function say(txt, sub, col, t) { S.msg = { txt: txt, sub: sub || '', col: col || null, t: t || 1.5 }; }
  function handleEvents() {
    var g = S.g, ev = g.ev, snd = S.snd;
    if (S.demo) { ev.length = 0; return; }
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.t) {
        case 'beep': snd.tone(523, 0.16, 'square', 0.04); break;
        case 'go': snd.tone(1046, 0.45, 'square', 0.05); break;
        case 'hit':
          S.shake = Math.max(S.shake, e.hard ? 1 : 0.5); S.flash = e.hard ? 1 : 0.4;
          snd.hiss(0.25, e.hard ? 0.25 : 0.12, 300, 0.7); snd.tone(90, 0.2, 'square', 0.06, 50);
          if (Cade.haptic) Cade.haptic(e.hard ? 40 : 15);
          sparks(e.side);
          break;
        case 'crash':
          S.shake = e.hard ? 1.2 : 0.6; S.flash = e.hard ? 1 : 0.5;
          snd.hiss(0.45, 0.3, 220, 0.6); snd.tone(70, 0.35, 'sawtooth', 0.06, 40);
          if (e.hard) say('SPIN OUT', '', '#e44', 1.1);
          if (Cade.haptic) Cade.haptic(e.hard ? 60 : 20);
          break;
        case 'scrape': snd.hiss(0.15, 0.08, 2600, 2); sparks(e.side); S.shake = Math.max(S.shake, 0.25); break;
        case 'near': say('NEAR MISS', '+' + e.pts + (e.combo > 1 ? '  combo x' + e.combo : ''), null, 0.9); snd.tone(880 + e.combo * 60, 0.08, 'triangle', 0.04, 1400); break;
        case 'draft': snd.hiss(0.4, 0.05, 1200, 0.5); break;
        case 'nos': snd.hiss(0.6, 0.12, 900, 0.4); snd.tone(220, 0.4, 'sawtooth', 0.03, 440); break;
        case 'cp':
          say('CHECKPOINT', '+' + e.bonus + 's · ' + BIOMES[e.biome].name + (e.night ? ' by night' : ''), null, 2);
          S.cpFlash = 1;
          snd.tone(784, 0.1, 'triangle', 0.05); snd.tone(988, 0.1, 'triangle', 0.05, null, 0.09); snd.tone(1318, 0.22, 'triangle', 0.05, null, 0.18);
          break;
        case 'lap': say(e.final ? 'FINAL LAP' : 'LAP ' + e.n + '/' + g.laps, 'last lap ' + fmtTime(e.lt), null, 1.8); snd.tone(659, 0.12, 'triangle', 0.05); snd.tone(880, 0.2, 'triangle', 0.05, null, 0.12); break;
        case 'finish':
          say(ord(e.place) + ' PLACE', e.place === 1 ? 'Winner!' : e.place <= 3 ? 'On the podium' : 'Finished', e.place <= 3 ? null : S.th.hudTx, 3);
          [523, 659, 784, 1046].forEach(function (f, j) { snd.tone(f, 0.2, 'triangle', 0.05, null, j * 0.11); });
          break;
        case 'timeup': say('TIME UP', distTxt(g.dist), '#e44', 3); snd.tone(440, 0.25, 'square', 0.04, 220); snd.tone(330, 0.4, 'square', 0.04, 110, 0.25); break;
        case 'done': S.doneT = 0.01; break;
      }
    }
    ev.length = 0;
  }
  function sparks(side) {
    if (S.rm) return;
    var x = S.carScr ? S.carScr.x + (side || 1) * -S.carScr.w * 0.4 : S.W / 2 + (side || 1) * -S.W * 0.35, y = S.carScr ? S.carScr.y - S.carScr.h * 0.3 : S.H * 0.7;
    for (var i = 0; i < 10; i++) puff(x, y, (Math.random() - 0.5) * 220, -60 - Math.random() * 120, 0.4, 2 + Math.random() * 2, 'rgba(255,200,80,', 1.5);
  }

  // ---- input ----
  function clearHeld() {
    if (!S) return;
    S.hold = { l: 0, r: 0, g: 0, b: 0, n: 0 }; S.scr = {};
    if (S.pad) Array.prototype.forEach.call(S.pad.querySelectorAll('.on'), function (b) { b.classList.remove('on'); });
  }
  function input() {
    var k = S.keys, h = S.hold, set = S.save.set, steer = 0, gp = S.gpIn || {};
    if (k.ArrowLeft || k.KeyA) steer -= 1;
    if (k.ArrowRight || k.KeyD) steer += 1;
    if (h.l) steer -= 1;
    if (h.r) steer += 1;
    for (var id in S.scr) steer += S.scr[id];
    if (set.steer === 'tilt' && S.tiltOn) steer += S.tiltV;
    if (gp.steer) steer += gp.steer;
    steer = Math.max(-1, Math.min(1, steer));
    var brake = k.ArrowDown || k.KeyS || k.ShiftLeft || k.ShiftRight || h.b || gp.brake ? 1 : 0;
    var gas = k.ArrowUp || k.KeyW || h.g || gp.gas ? 1 : 0;
    if (!gas && !brake && autoGas()) gas = 1;
    return { steer: steer, gas: gas, brake: brake, nos: k.Space || h.n || gp.nos ? 1 : 0, sens: +set.sens || 1 };
  }
  function demoInput(g) {
    var p = g.p, si = Math.floor(p.z / SEG), maxC = 0, tx = 0;
    for (var k = 2; k < 18; k += 2) maxC = Math.max(maxC, Math.abs(segAt(g.T, si + k).c));
    var cap = maxC > 0.4 ? Math.min(1, 1 / (maxC * ENGINE.CF * p.st.grip)) * 0.97 : 1, sp = p.v / p.st.top;
    for (var i = 0; i < g.cars.length; i++) { var c = g.cars[i], d = relZ(g, c); if (d > 0 && d < SEG * 14 && Math.abs(c.x - p.x) < 0.45) tx = c.x > 0 ? c.x - 0.62 : c.x + 0.62; }
    return { steer: Math.max(-1, Math.min(1, ENGINE.autoSteer(g) + (tx - p.x) * 2.2)), gas: sp < cap ? 1 : 0, brake: sp > cap + 0.1 ? 1 : 0, nos: 0, sens: 1 };
  }
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', c: 'KeyC', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  var DRIVE_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyA: 1, KeyD: 1, KeyW: 1, KeyS: 1, Space: 1, ShiftLeft: 1, ShiftRight: 1 };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e);
    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      if (e.repeat) return;
      if (S.mode === 'play' && !S.paused) pause();
      else if (S.paused) resume();
      else if (code === 'Escape') {
        if (S.card === 'help') closeHelp();
        else if (S.card === 'cups' || S.card === 'pre') { if (S.card === 'pre') { S.g = null; toMenu(); showCard('cups'); } else toMenu(); }
        else if (S.card === 'menu' && S.tab !== 'race') { S.tab = 'race'; showCard('menu'); }
        else if (S.card === 'menu') closePanel();
      }
      return;
    }
    if (code === 'KeyC') { e.preventDefault(); if (!e.repeat) toggleCam(); return; }
    if (S.mode === 'play' && !S.paused) {
      if (DRIVE_KEYS[code]) { e.preventDefault(); S.keys[code] = true; S.touchUsed = false; }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (e.repeat) return;
      var b = S.ovl.querySelector('[data-primary]');
      if (b) b.click();
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }
  function toggleCam() {
    S.save.set.cam = S.save.set.cam === 'pov' ? 'chase' : 'pov';
    persist(); syncHead();
    if (S.card === 'pause' || (S.card === 'menu' && S.tab === 'settings')) showCard(S.card);
    if (!S.raf && S.g) { S.fdt = 0; render(S.g); }
  }
  function closeHelp() { S.firstRun = false; if (S.paused) showCard('pause'); else showCard('menu'); }

  // tilt steering: the phone held like a wheel
  function onTilt(e) {
    if (!S) return;
    var ang = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0), v;
    if (ang === 90) v = e.beta; else if (ang === -90 || ang === 270) v = -e.beta; else v = e.gamma;
    if (v == null) return;
    S.tiltOn = true;
    var d = Math.abs(v) < 2.5 ? 0 : v - (v > 0 ? 2.5 : -2.5);
    S.tiltV = Math.max(-1, Math.min(1, d / 20));
  }
  function enableTilt() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { S.tiltMsg = 'No tilt sensor here.'; showCard(S.card); return; }
    function on() { if (!S.tiltL) { S.tiltL = onTilt; window.addEventListener('deviceorientation', S.tiltL); } S.tiltMsg = 'Tilt the phone to steer.'; setTimeout(function () { if (S && S.card === 'menu') showCard('menu'); }, 400); }
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(function (r) { if (!S) return; if (r === 'granted') on(); else { S.tiltMsg = 'Permission denied.'; showCard(S.card); } }, function () { if (S) { S.tiltMsg = 'Permission needed (tap again).'; showCard(S.card); } });
    } else on();
  }

  // gamepad: stick / d-pad steer, RT or A gas, LT or B brake, X or RB nitro, Y camera, Start pause
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnV(p, i) { var b = p.buttons[i]; return b ? (b.pressed ? Math.max(0.6, b.value || 1) : b.value || 0) : 0; }
  function pollPad() {
    var p = readPad(), gp = S.gp;
    if (!p) { S.gpIn = null; return; }
    var ax = p.axes[0] || 0, st = Math.abs(ax) > 0.15 ? ax : 0;
    if (btnV(p, 14) > 0.5) st = -1; if (btnV(p, 15) > 0.5) st = 1;
    S.gpIn = { steer: st, gas: btnV(p, 7) > 0.2 || btnV(p, 0) > 0.5, brake: btnV(p, 6) > 0.2 || btnV(p, 1) > 0.5, nos: btnV(p, 2) > 0.5 || btnV(p, 5) > 0.5 };
    var start = btnV(p, 9) > 0.5, y = btnV(p, 3) > 0.5, a = btnV(p, 0) > 0.5;
    if (start && !gp.st) { if (S.mode === 'play' && !S.paused) pause(); else if (S.paused) resume(); }
    if (y && !gp.y) toggleCam();
    if (a && !gp.a && S.mode !== 'play') { var b = S.ovl.querySelector('[data-primary]'); if (b) b.click(); }
    gp.st = start; gp.y = y; gp.a = a;
  }

  // ---- loop ----
  function running() { return !!S && !!S.g && (S.mode === 'play' || (S.mode === 'menu' && S.demo)) && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60, g = S.g;
    S.last = ts; S.fdt = dt; S.animT += dt;
    pollPad();
    if (!running()) return;
    var inp = S.demo ? demoInput(g) : input();
    g.p.brakeOn = inp.brake > 0;
    S.acc = Math.min((S.acc || 0) + dt, 0.2);
    while (S.acc >= STEP) {
      step(g, inp, STEP);
      S.acc -= STEP;
      if (S.demo) { g.timeLeft = 999; if (g.p.spin > 0) g.p.spin = 0; }
    }
    handleEvents();
    if (!S.demo) {
      var p = g.p, load = inp.gas && p.v < p.st.top * 0.98 ? 1 : 0.25;
      S.snd.engineSet(p.rpm, load, p.nosOn, p.drift, p.off && p.v > 300 ? Math.min(1, p.v / p.st.top) : 0);
    }
    render(g);
    if (S.doneT > 0) { S.doneT += dt; if (S.doneT > 0.6) { S.doneT = 0; finishGame(); return; } }
    S.raf = requestAnimationFrame(frame);
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
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var padOn = S.coarse && S.mode === 'play';
    var side = padOn && vh < 520 && vw > vh * 1.25 && vw >= 480;
    S.panel.classList.toggle('pr-side', side);
    S.pad.classList.toggle('on', padOn);
    S.pad.classList.toggle('nosteer', S.save.set.steer !== 'buttons');
    S.pad.classList.toggle('auto', autoGas());
    var gut = side ? (solo ? 24 : 40) : phone ? (solo ? 20 : 34) : 48, padW = side ? 2 * 128 : 0;
    var W = Math.floor(Math.min(vw - gut - padW, solo ? 1100 : 760)), ch = chromeH(), ah = Math.floor(Math.max(side ? 140 : 180, availH(vw, vh, ch))), H;
    if (side) { H = ah; W = Math.min(W, Math.round(H * 2.1)); }
    else if (W < 560) H = Math.min(ah, Math.round(W * 1.22));
    else H = Math.min(ah, Math.round(W * 0.62));
    H = Math.max(H, Math.min(ah, 200));
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (W * H * dpr * dpr > 1500000) dpr = Math.max(1, Math.sqrt(1500000 / (W * H)));
    if (W !== S.W || H !== S.H || dpr !== S.dk) {
      S.W = W; S.H = H; S.dk = dpr;
      S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
      S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
      S.panel.style.setProperty('--pr-w', W + 'px');
      S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
      S.dashC = null; S.mapC = null; S.lightC = null;
      for (var k in S.pals) { S.pals[k].sky = null; }
    }
    S.drawN = S.coarse || W * H < 220000 ? 130 : 180;
    S.lay = { vw: vw, vh: vh, chrome: ch, side: side };
    if (!S.raf && S.g) { S.fdt = 0; render(S.g); }
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) layout();
  }
  function syncHead() {
    if (!S) return;
    var hb = S.head, pb = hb.querySelector('[data-h="pause"]'), sb = hb.querySelector('[data-h="sound"]'), cb = hb.querySelector('[data-h="cam"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.mode !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)'; pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off'; sb.setAttribute('aria-label', sb.title); sb.classList.toggle('on', S.snd.on);
    cb.innerHTML = IC_CAM; cb.title = 'Camera: ' + (S.save.set.cam === 'pov' ? 'cockpit' : 'chase') + ' (C)'; cb.setAttribute('aria-label', cb.title);
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (s.tiltL) window.removeEventListener('deviceorientation', s.tiltL);
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPadC);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    try { sset(SAVE_KEY, JSON.stringify(s.save)); } catch (e) {}
    s.snd.close();
    function free(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
    for (var k in s.sprC) free(s.sprC[k]);
    for (var j in s.carC) free(s.carC[j]);
    for (var q in s.pals) if (s.pals[q].layers) s.pals[q].layers.forEach(free);
    free(s.dashC); free(s.mapC); free(s.lightC); free(s.cv);
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
    var body = '<div class="pr"><div class="pr-stage"><canvas class="pr-cv"></canvas><div class="pr-ovl" style="display:none"></div></div>' +
      '<div class="pr-pad"><div class="pr-pl"><button type="button" data-hold="l" aria-label="Steer left">◀</button><button type="button" data-hold="r" aria-label="Steer right">▶</button></div>' +
      '<div class="pr-pr"><button type="button" data-hold="n" class="nos" aria-label="Nitro">NOS</button><button type="button" data-hold="b" class="brk" aria-label="Brake">BRK</button><button type="button" data-hold="g" class="gas" aria-label="Gas">GAS</button></div></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\u{1F3CE} Apex Rush', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'pr-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="cam"></button><button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.pr-stage'), cv: p.querySelector('.pr-cv'), ovl: p.querySelector('.pr-ovl'), pad: p.querySelector('.pr-pad'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) !== '0'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: 'menu', card: null, tab: 'race', g: null, demo: false, paused: false, raf: 0, last: 0, animT: 0, acc: 0, fdt: 0,
      keys: {}, hold: { l: 0, r: 0, g: 0, b: 0, n: 0 }, scr: {}, gp: {}, gpIn: null, tiltOn: false, tiltV: 0, tiltL: null, tiltMsg: '',
      W: 0, H: 0, dk: 1, cy: 0, sc: 1, drawN: 150, pals: {}, sprC: {}, carC: {}, dashC: null, mapC: null, lightC: null,
      skyX: 0, skyP: null, skyFrom: null, skyT: 1, horizonY: 0, shake: 0, flash: 0, cpFlash: 0, msg: null, doneT: 0, res: null, resCup: 0, cupArm: null, resetArm: false, touchUsed: false
    };
    makeFx();
    S.ctx = S.cv.getContext('2d', { alpha: false }) || S.cv.getContext('2d');
    p._onClose = teardown;
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); stopLoop(); S.snd.engineOff(); } else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearHeld(); S.keys = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); clearHeld(); stopLoop(); S.snd.engineOff();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); kick();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.pad);
    } catch (e) {}
    S.onPadC = function () { if (S && !S.gpT) S.gpT = setInterval(function () { if (S && !S.raf) pollPad(); }, 100); };
    window.addEventListener('gamepadconnected', S.onPadC);
    if (readPad()) S.onPadC();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); if (S.card) showCard(S.card);
        if (!S.raf && S.g) { S.fdt = 0; render(S.g); }
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
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        if (S.snd.on) { S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04); if (S.mode === 'play' && !S.paused) S.snd.engineOn(); }
        else S.snd.engineOff();
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'cam') toggleCam();
      else if (h === 'help') {
        if (S.mode === 'play' && !S.paused) pause();
        if (S.card === 'help') closeHelp();
        else if (S.mode === 'menu' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // no zoom / select / callouts anywhere on the play surface
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', noTouch, { passive: false });
    S.pad.addEventListener('touchmove', noTouch, { passive: false });
    S.pad.addEventListener('touchend', noTouch, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // screen halves: hold the left / right half of the road to steer
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.mode !== 'play' || S.paused) return;
      if (e.pointerType === 'touch') S.touchUsed = true;
      if (S.save.set.steer !== 'screen' && e.pointerType !== 'touch') return;
      if (S.save.set.steer === 'tilt') return;
      var r = S.cv.getBoundingClientRect();
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.scr[e.pointerId] = e.clientX < r.left + r.width / 2 ? -1 : 1;
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || S.scr[e.pointerId] == null) return;
      var r = S.cv.getBoundingClientRect();
      S.scr[e.pointerId] = e.clientX < r.left + r.width / 2 ? -1 : 1;
    });
    function scrUp(e) { if (S) delete S.scr[e.pointerId]; }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.cv.addEventListener(t, scrUp); });
    // the pad: every button is held
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure(); S.touchUsed = true;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.hold[b.getAttribute('data-hold')] = 1; b.classList.add('on');
    });
    function padUp(e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      S.hold[b.getAttribute('data-hold')] = 0; b.classList.remove('on');
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, padUp); });

    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var sv = S.save, a = b.getAttribute('data-act'), tab = b.getAttribute('data-tab'), df = b.getAttribute('data-diff'), st = b.getAttribute('data-set'),
        cup = b.getAttribute('data-cup'), buy = b.getAttribute('data-buy'), paint = b.getAttribute('data-paint'), cam = b.getAttribute('data-cam');
      S.snd.tone(988, 0.04, 'sine', 0.025);
      if (tab) { S.tab = tab; S.resetArm = false; showCard('menu'); refocus(e, '[data-tab="' + tab + '"]'); return; }
      if (df != null) { sv.set.diff = +df; persist(); showCard('menu'); refocus(e, '[data-diff="' + df + '"]'); return; }
      if (cam) { sv.set.cam = cam; persist(); syncHead(); showCard(S.card); S.fdt = 0; render(S.g); return; }
      if (st) {
        var kv = st.split(':'), key = kv[0], val = kv[1];
        if (key === 'sens') val = +val; else if (key === 'autogas') val = val === 'on'; else if (key === 'shake') val = +val;
        sv.set[key] = val; persist(); syncHead();
        if (key === 'units') S.dashC = null;
        showCard('menu'); refocus(e, '[data-set="' + st + '"]');
        if (key === 'steer' && val === 'tilt' && !S.tiltOn && !window.DeviceOrientationEvent) S.tiltMsg = 'No tilt sensor here.';
        return;
      }
      if (buy) { if (buyUpgrade(sv, buy)) { persist(); S.snd.tone(660, 0.08, 'triangle', 0.05); S.snd.tone(990, 0.12, 'triangle', 0.05, null, 0.08); } showCard('menu'); refocus(e, '[data-buy="' + buy + '"]'); return; }
      if (paint != null) { if (buyPaint(sv, +paint)) { persist(); S.dashC = null; S.carC = {}; } showCard('menu'); refocus(e, '[data-paint="' + paint + '"]'); return; }
      if (cup != null) {
        var ci = +cup;
        if (sv.cur && sv.cur.cup !== ci) { S.cupArm = ci; showCard('cups'); return; }
        if (!sv.cur) startCup(sv, ci);
        persist(); preRace(); return;
      }
      switch (a) {
        case 'endless': startEndless(); break;
        case 'cups': S.cupArm = null; if (S.mode !== 'menu' || !S.demo) { S.g = null; toMenu(); } showCard('cups'); break;
        case 'cup-yes': startCup(sv, S.cupArm); S.cupArm = null; persist(); preRace(); break;
        case 'cup-no': S.cupArm = null; showCard('cups'); break;
        case 'pre': preRace(); break;
        case 'race': startRace(); break;
        case 'garage': S.tab = 'garage'; if (S.mode !== 'menu' || !S.demo) { S.g = null; toMenu(); } else showCard('menu'); break;
        case 'menu': S.tab = 'race'; if (S.mode !== 'menu' || !S.demo) { S.g = null; toMenu(); } else showCard('menu'); break;
        case 'help': showCard('help'); break;
        case 'close-help': closeHelp(); break;
        case 'resume': resume(); break;
        case 'restart': restartPlay(); break;
        case 'quit': quitPlay(); break;
        case 'cupres': showCard('cupres'); break;
        case 'tilt': enableTilt(); break;
        case 'reset': S.resetArm = true; showCard('menu'); break;
        case 'reset-no': S.resetArm = false; showCard('menu'); break;
        case 'reset-yes': { var keep = sv.set; S.save = newSave(); S.save.set = keep; S.resetArm = false; persist(); if (Cade.showToast) Cade.showToast('Progress reset', 'info', 1600); showCard('menu'); break; }
      }
    });
    function refocus(e, sel) {
      if (e.detail !== 0) return;          // keyboard activation: keep focus on the same control
      var el = S.ovl.querySelector(sel);
      if (el) { try { el.focus({ preventScroll: true }); } catch (er) {} }
    }

    toMenu();
    if (S.firstRun) { persist(); showCard('help'); }
    syncHead();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Behind-the-wheel pseudo-3D racer — endless highway, checkpoints, traffic and a career of tracks',
    icon: '\u{1F3CE}',
    tags: 'game,arcade,racing,driving,car,endless,career,retro,fun',
    open: open,
    _engine: ENGINE
  });
})();
