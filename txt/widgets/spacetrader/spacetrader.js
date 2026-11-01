/* Space Trader — buy low, sell high across a procedurally generated star map, for Cade.txt.
 * Twenty-six star systems, each with a tech level, a government and sometimes a
 * specialty, trade ten goods. Prices come from the tech gradient (raw goods are
 * dear on high-tech worlds, manufactured goods on low-tech ones), the local
 * government and specialty, news events (droughts, plagues, wars, gluts) and
 * supply and demand: every unit you buy pushes the price up and drains the
 * stock, every unit you sell pushes it down, and markets recover day by day.
 * Fuel limits how far one jump reaches. The shipyard sells six hulls, weapons,
 * shields, gadgets, drive upgrades and an escape pod. Jumps can be interrupted
 * by pirates, police inspections, traders and derelicts — a turn-based fight /
 * flee / surrender / bribe card. The mission board has courier runs, supply
 * contracts and pirate bounties; the bank lends against your net worth. Your
 * police record and your fame shape how the galaxy treats you.
 * Goal: buy a moon at a tech 6+ world (price set by the difficulty) — or retire
 * early for a smaller score. Modes: solo, a race against a CPU rival trader
 * (Easy / Normal / Hard) or two captains passing one device.
 * The whole game is one JSON save in Cade.store (cade-spacetrader-*); the map
 * is rebuilt from its seed. Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var VERSION = 1;
  var MAP_W = 96, MAP_H = 96, COLS = 48, ROWS = 24, NSYS = 26, LINK = 13;   // a map cell is 2 x 4 world units (a mono glyph is ~1:2)
  var SPREAD = 0.035, GLUT_DECAY = 0.72, MAX_MISSIONS = 3, POD_PRICE = 2000, SELL_BACK = 0.6;

  var GOODS = [
    { id: 'water', name: 'Water', base: 30, tp: 0, tu: 0, ipl: 5, vr: 6 },
    { id: 'hides', name: 'Hides', base: 220, tp: 0, tu: 0, ipl: 14, vr: 10 },
    { id: 'grain', name: 'Grain', base: 100, tp: 1, tu: 0, ipl: 9, vr: 8 },
    { id: 'ore', name: 'Ore', base: 320, tp: 2, tu: 2, ipl: 30, vr: 10 },
    { id: 'lux', name: 'Luxuries', base: 300, tp: 3, tu: 1, ipl: -18, vr: 12 },
    { id: 'meds', name: 'Medicine', base: 650, tp: 4, tu: 1, ipl: -45, vr: 12 },
    { id: 'mach', name: 'Machines', base: 900, tp: 4, tu: 3, ipl: -55, vr: 8 },
    { id: 'arms', name: 'Arms', base: 1200, tp: 3, tu: 1, ipl: -80, vr: 25, illegal: true },
    { id: 'stims', name: 'Stims', base: 3000, tp: 5, tu: 0, ipl: -170, vr: 30, illegal: true },
    { id: 'robots', name: 'Robots', base: 4400, tp: 6, tu: 4, ipl: -260, vr: 12 }
  ];
  var NG = GOODS.length, GI = {};
  for (var gi0 = 0; gi0 < NG; gi0++) GI[GOODS[gi0].id] = gi0;

  var TECH = ['Stone age', 'Agrarian', 'Steam', 'Industrial', 'Atomic', 'Orbital', 'Advanced', 'Singular'];
  // pir / pol / trd: 0..7 how often pirates, police and traders turn up; black: a market for contraband;
  // bribe: 0 = incorruptible .. 3 = cheap; want: goods this kind of world pays extra for.
  var GOVS = [
    { id: 'anarchy', name: 'Anarchy', pir: 7, pol: 0, trd: 1, black: true, bribe: 0, want: { grain: 1.2, arms: 1.35 } },
    { id: 'feudal', name: 'Feudal realm', pir: 5, pol: 1, trd: 2, black: true, bribe: 3, want: { arms: 1.25, lux: 1.2 } },
    { id: 'cartel', name: 'Cartel state', pir: 4, pol: 2, trd: 3, black: true, bribe: 3, want: { stims: 1.3, robots: 1.1 } },
    { id: 'military', name: 'Military junta', pir: 1, pol: 7, trd: 2, black: false, bribe: 0, want: { mach: 1.2, ore: 1.2, meds: 1.15 } },
    { id: 'theocracy', name: 'Theocracy', pir: 1, pol: 6, trd: 2, black: false, bribe: 1, want: { grain: 1.15, water: 1.2 } },
    { id: 'corporate', name: 'Corporate', pir: 2, pol: 4, trd: 6, black: false, bribe: 2, want: { lux: 1.25, robots: 1.1 } },
    { id: 'democracy', name: 'Democracy', pir: 2, pol: 4, trd: 5, black: false, bribe: 1, want: { meds: 1.2, lux: 1.1 } },
    { id: 'technocracy', name: 'Technocracy', pir: 2, pol: 4, trd: 4, black: false, bribe: 2, want: { ore: 1.2, mach: 1.15 } },
    { id: 'coop', name: 'Cooperative', pir: 1, pol: 3, trd: 4, black: false, bribe: 1, want: { grain: 1.15, meds: 1.1 } }
  ];
  var SPECS = [
    { id: 'none', name: '' },
    { id: 'ice', name: 'Ice moons', cheap: 'water' },
    { id: 'jungle', name: 'Wild jungles', cheap: 'hides' },
    { id: 'fertile', name: 'Fertile plains', cheap: 'grain' },
    { id: 'crust', name: 'Rich crust', cheap: 'ore' },
    { id: 'artisan', name: 'Artisan guilds', cheap: 'lux' },
    { id: 'biolab', name: 'Bio-labs', cheap: 'meds' },
    { id: 'forge', name: 'Great forges', cheap: 'mach' },
    { id: 'desert', name: 'Dust deserts', dear: 'water', dear2: 'grain' },
    { id: 'swamp', name: 'Fever swamps', dear: 'meds' },
    { id: 'barren', name: 'Barren rock', dear: 'grain', dear2: 'hides' },
    { id: 'warlike', name: 'Warlike clans', dear: 'arms' },
    { id: 'domes', name: 'Pleasure domes', dear: 'lux', dear2: 'stims' }
  ];
  var CHEAP = 0.68, DEAR = 1.45;
  // News events: price multipliers while they last.
  var EVENTS = [
    { id: 'drought', t: 'Drought grips %s', mods: { water: 2.2, grain: 1.5 } },
    { id: 'plague', t: 'Plague outbreak on %s', mods: { meds: 2.4 } },
    { id: 'war', t: '%s mobilises for war', mods: { arms: 1.9, mach: 1.5, ore: 1.4 } },
    { id: 'freeze', t: 'Deep freeze on %s', mods: { hides: 2.0, water: 1.3 } },
    { id: 'blight', t: 'Crop blight on %s', mods: { grain: 2.3 } },
    { id: 'boom', t: 'Building boom on %s', mods: { ore: 1.8, mach: 1.6, robots: 1.35 } },
    { id: 'festival', t: 'Grand festival on %s', mods: { lux: 1.9, stims: 1.5 } },
    { id: 'fire', t: 'Factory fire on %s', mods: { robots: 1.8, mach: 1.5 } },
    { id: 'glut', t: 'Ore glut at the mines of %s', mods: { ore: 0.55 } },
    { id: 'harvest', t: 'Record harvest on %s', mods: { grain: 0.55, water: 0.8 } },
    { id: 'recall', t: 'Robot recall hits %s', mods: { robots: 0.65 } }
  ];
  var EVI = {};
  for (var ei0 = 0; ei0 < EVENTS.length; ei0++) EVI[EVENTS[ei0].id] = ei0;

  // Hulls: cargo bays, hull points, jump range (parsecs), weapon / shield / gadget slots.
  var SHIPS = [
    { id: 'sparrow', name: 'Sparrow', cargo: 10, hull: 80, range: 14, w: 1, s: 0, g: 1, price: 2500, tl: 2, fuel: 6, rep: 4, art: [' _ ', '<=>', '   '] },
    { id: 'mule', name: 'Mule', cargo: 24, hull: 100, range: 13, w: 1, s: 1, g: 1, price: 11000, tl: 3, fuel: 8, rep: 5, art: [' ___ ', '[###>', '     '] },
    { id: 'lancer', name: 'Lancer', cargo: 14, hull: 150, range: 17, w: 2, s: 1, g: 1, price: 18000, tl: 4, fuel: 9, rep: 6, art: [' /\\ ', '<==>-', ' \\/ '] },
    { id: 'drifter', name: 'Drifter', cargo: 40, hull: 130, range: 15, w: 1, s: 2, g: 2, price: 34000, tl: 5, fuel: 11, rep: 7, art: [' ____ ', '[####]>', ' ~~~~ '] },
    { id: 'warden', name: 'Warden', cargo: 28, hull: 240, range: 16, w: 3, s: 2, g: 2, price: 62000, tl: 6, fuel: 13, rep: 9, art: [' /==\\ ', '<|##|>=', ' \\==/ '] },
    { id: 'colossus', name: 'Colossus', cargo: 70, hull: 280, range: 18, w: 2, s: 3, g: 3, price: 110000, tl: 7, fuel: 16, rep: 11, art: [' ______ ', '[######]>', ' \\____/ '] }
  ];
  var SI = {};
  for (var si0 = 0; si0 < SHIPS.length; si0++) SI[SHIPS[si0].id] = si0;
  var WEAPONS = [
    { id: 'pulse', name: 'Pulse laser', dmg: 14, price: 2200, tl: 3 },
    { id: 'beam', name: 'Beam laser', dmg: 24, price: 8500, tl: 5 },
    { id: 'lance', name: 'Ion lance', dmg: 36, price: 22000, tl: 7 }
  ];
  var SHIELDS = [
    { id: 'deflector', name: 'Deflector', pts: 60, price: 4500, tl: 4 },
    { id: 'aegis', name: 'Aegis field', pts: 140, price: 16000, tl: 6 }
  ];
  var GADGETS = [
    { id: 'pods', name: 'Cargo pods', info: '+6 cargo bays', price: 3000, tl: 3 },
    { id: 'cells', name: 'Fuel cells', info: '+5 parsecs range', price: 3500, tl: 4 },
    { id: 'target', name: 'Targeting array', info: '+15% to hit', price: 7000, tl: 5 },
    { id: 'cloak', name: 'Cloak', info: 'fewer ambushes, easier escapes', price: 18000, tl: 7 }
  ];
  var ENGINES = [
    { name: 'Stock drive', price: 0, tl: 0 },
    { name: 'Tuned drive', price: 3000, tl: 3 },
    { name: 'Ion drive', price: 9000, tl: 5 },
    { name: 'Fold drive', price: 20000, tl: 7 }
  ];
  var EQUIP = { w: WEAPONS, s: SHIELDS, g: GADGETS };
  var DIFFS = [
    { id: 'easy', name: 'Easy', cash: 2000, moon: 80000, pir: 0.7, rate: 0.005, mul: 0.6, noise: 0.5, idle: 0.3, cpuLoss: 1.2 },
    { id: 'normal', name: 'Normal', cash: 1000, moon: 150000, pir: 1, rate: 0.01, mul: 1, noise: 0.2, idle: 0.1, cpuLoss: 1 },
    { id: 'hard', name: 'Hard', cash: 600, moon: 250000, pir: 1.35, rate: 0.015, mul: 1.6, noise: 0, idle: 0, cpuLoss: 0.7 }
  ];
  var MODES = ['solo', 'cpu', 'duo'];
  var RIVALS = ['Vex Morrow', 'Ilsa Quint', 'Dorran Pike', 'Tamsin Rook', 'Okke Vale'];
  var PIRATE_NAMES = ['Red Saddle', 'Mad Ferrin', 'the Widow Kell', 'One-Eye Brask', 'Captain Sorrow', 'the Gilt Jackal', 'Hollow Jun', 'Nine-Fingers Ode'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
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
  function hash3(a, b, c) { return hash2(hash2(a, b), c); }
  // The game's own serialisable random stream (state in G.rs), so a game replays exactly.
  function rnd(G) {
    var a = (G.rs + 0x6D2B79F5) | 0;
    G.rs = a;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(G, n) { return Math.floor(rnd(G) * n); }

  // ---- the galaxy (rebuilt from the seed; only markets / events are saved) ----
  var SYL = ['ka', 've', 'lo', 'ri', 'zan', 'tor', 'mi', 'qua', 'sel', 'dra', 'no', 'fen', 'yu', 'bel', 'or', 'ix', 'ar', 'eth',
    'ul', 'pra', 'ste', 'cor', 'vin', 'ha', 'lys', 'mor', 'ta', 'zu', 'ne', 'os', 'gal', 'ky', 'ren', 'thu', 'ap', 'il'];
  function mkName(r, used) {
    for (var k = 0; k < 200; k++) {
      var n = 2 + (r() < 0.3 ? 1 : 0), s = '';
      for (var i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)];
      if (s.length < 3 || s.length > 7 || used[s]) continue;
      used[s] = 1;
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    return 'Nova' + Object.keys(used).length;
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function cellOf(x, y) { return { c: clamp(Math.floor(x / 2), 0, COLS - 1), r: clamp(Math.floor(y / 4), 0, ROWS - 1) }; }
  function connected(pts, link) {
    var seen = [0], mark = {}, k;
    mark[0] = 1;
    while (seen.length) {
      var i = seen.pop();
      for (k = 0; k < pts.length; k++) if (!mark[k] && dist(pts[i], pts[k]) <= link) { mark[k] = 1; seen.push(k); }
    }
    return Object.keys(mark).length === pts.length;
  }
  function genGalaxy(seed) {
    for (var attempt = 0; attempt < 200; attempt++) {
      var r = rng(hash2(seed, attempt)), pts = [], cells = {}, tries = 0, k;
      while (pts.length < NSYS && tries < 5000) {
        tries++;
        // grow from a placed system, one jump away, so the map is always connected
        var x, y;
        if (!pts.length) { x = MAP_W * (0.3 + 0.4 * r()); y = MAP_H * (0.3 + 0.4 * r()); }
        else {
          var base = pts[Math.floor(r() * pts.length)], ang = r() * Math.PI * 2, rad = 9.5 + r() * 3.3;
          x = base.x + Math.cos(ang) * rad; y = base.y + Math.sin(ang) * rad;
        }
        if (x < 3 || y < 3 || x > MAP_W - 3 || y > MAP_H - 3) continue;
        var ok = true, cl = cellOf(x, y);
        if (cl.c < 1 || cl.c > COLS - 2) continue;
        for (k = 0; k < pts.length && ok; k++) if (dist(pts[k], { x: x, y: y }) < 9) ok = false;
        // keep a glyph's row free of a close neighbour so labels have room
        for (k = 0; k < pts.length && ok; k++) { var c2 = cellOf(pts[k].x, pts[k].y); if (c2.r === cl.r && Math.abs(c2.c - cl.c) < 4) ok = false; }
        if (!ok) continue;
        pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
      }
      if (pts.length < NSYS || !connected(pts, LINK)) continue;
      // centre the cluster on the map, moving by whole cells (2 x 4) so distances and
      // the label spacing stay exactly as generated
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (k = 0; k < pts.length; k++) { x0 = Math.min(x0, pts[k].x); x1 = Math.max(x1, pts[k].x); y0 = Math.min(y0, pts[k].y); y1 = Math.max(y1, pts[k].y); }
      var sx = 2 * Math.round((MAP_W / 2 - (x0 + x1) / 2) / 2), sy = 4 * Math.round((MAP_H / 2 - (y0 + y1) / 2) / 4);
      while (sx && (x0 + sx < 2 || x1 + sx > MAP_W - 2 || cellOf(x0 + sx, 0).c < 1 || cellOf(x1 + sx, 0).c > COLS - 2)) sx -= sx > 0 ? 2 : -2;
      while (sy && (y0 + sy < 0 || y1 + sy >= MAP_H)) sy -= sy > 0 ? 4 : -4;
      for (k = 0; k < pts.length; k++) { pts[k].x = Math.round((pts[k].x + sx) * 10) / 10; pts[k].y = Math.round((pts[k].y + sy) * 10) / 10; }
      var used = {}, sys = [];
      for (k = 0; k < NSYS; k++) {
        var tl = Math.floor(r() * 8);
        var gov = Math.floor(r() * GOVS.length);
        if (tl >= 6 && GOVS[gov].id === 'anarchy') gov = 5 + Math.floor(r() * 4);
        var spec = r() < 0.5 ? 0 : 1 + Math.floor(r() * (SPECS.length - 1));
        sys.push({ i: k, name: mkName(r, used), x: pts[k].x, y: pts[k].y, tl: tl, gov: gov, spec: spec, size: Math.floor(r() * 5) });
      }
      // the goal needs a few advanced worlds; low-tech worlds make the raw-goods trade
      var hi = sys.filter(function (s) { return s.tl >= 6; }).length, lo = sys.filter(function (s) { return s.tl <= 1; }).length;
      for (k = 0; hi < 4 && k < NSYS; k++) if (sys[k].tl >= 3 && sys[k].tl < 6) { sys[k].tl = 6 + (k & 1); hi++; if (GOVS[sys[k].gov].id === 'anarchy') sys[k].gov = 7; }
      for (k = NSYS - 1; lo < 4 && k >= 0; k--) if (sys[k].tl >= 2 && sys[k].tl <= 4) { sys[k].tl = k & 1; lo++; }
      return sys;
    }
    throw new Error('galaxy');
  }
  function neighbours(sys, i, range) {
    var out = [];
    for (var k = 0; k < sys.length; k++) if (k !== i && dist(sys[i], sys[k]) <= range) out.push(k);
    return out;
  }
  function pickStart(sys) {
    var best = -1, bs = -1;
    for (var k = 0; k < sys.length; k++) {
      var s = sys[k], g = GOVS[s.gov];
      if (s.tl < 3 || s.tl > 5 || g.black) continue;
      var sc = neighbours(sys, k, SHIPS[0].range).length * 10 - Math.abs(s.x - MAP_W / 2) / 10 - Math.abs(s.y - MAP_H / 2) / 10;
      if (sc > bs) { bs = sc; best = k; }
    }
    if (best < 0) best = 0;
    return best;
  }

  // ---- markets ----
  function depth(s) { return 60 + 25 * s.size; }
  function hasMarket(G, si, gi) {
    var s = G.sys[si], g = GOODS[gi];
    if (s.tl < g.tu) return false;
    if (g.illegal && !GOVS[s.gov].black) return false;
    return true;
  }
  function produced(G, si, gi) { return hasMarket(G, si, gi) && G.sys[si].tl >= GOODS[gi].tp; }
  // The fair price before supply and demand (0 = no market).
  function fair(G, si, gi) {
    if (!hasMarket(G, si, gi)) return 0;
    var s = G.sys[si], g = GOODS[gi], gov = GOVS[s.gov], sp = SPECS[s.spec];
    var p = g.base + g.ipl * (s.tl - g.tp);
    if (s.tl < g.tp) p *= 1.15;                              // imported
    if (gov.want[g.id]) p *= gov.want[g.id];
    if (sp.cheap === g.id) p *= CHEAP;
    if (sp.dear === g.id || sp.dear2 === g.id) p *= DEAR;
    var ev = G.ev[si];
    if (ev && EVENTS[ev.e].mods[g.id]) p *= EVENTS[ev.e].mods[g.id];
    var h = hash3(G.seed, si * 16 + gi, Math.floor(G.day / 2)) / 4294967296;
    p *= 1 + (g.vr / 100) * (2 * h - 1);
    return Math.max(4, p);
  }
  function eqStock(s, g) { return 12 + 8 * s.size + 4 * Math.max(0, s.tl - g.tp); }
  // Prices now: { buy, sell, avail, mid } (null without a market).
  function quote(G, si, gi, glutAdj) {
    var f = fair(G, si, gi);
    if (!f) return null;
    var s = G.sys[si], g = GOODS[gi], gl = G.glut[si][gi] + (glutAdj || 0);
    var mid = f * Math.exp(-gl / depth(s));
    var avail = s.tl >= g.tp ? Math.max(0, Math.floor(eqStock(s, g) + gl)) : Math.max(0, Math.floor(gl));
    return { buy: Math.max(1, Math.round(mid * (1 + SPREAD))), sell: Math.max(1, Math.round(mid * (1 - SPREAD))), avail: avail, mid: mid };
  }
  // The average fair price across every market (a reference for "cheap / dear").
  function avgPrice(G, gi) {
    var t = 0, n = 0;
    for (var k = 0; k < G.sys.length; k++) { var f = fair(G, k, gi); if (f) { t += f; n++; } }
    return n ? t / n : GOODS[gi].base;
  }

  // ---- ships ----
  function newShip(type) {
    var T = SHIPS[type];
    return { t: type, hull: T.hull, fuel: T.range, sh: 0, w: [], s: [], g: [], eng: 0, pod: false };
  }
  function cargoCap(sh) { var n = SHIPS[sh.t].cargo; for (var k = 0; k < sh.g.length; k++) if (sh.g[k] === 'pods') n += 6; return n; }
  function rangeOf(sh) { var n = SHIPS[sh.t].range; for (var k = 0; k < sh.g.length; k++) if (sh.g[k] === 'cells') n += 5; return n; }
  function hullMax(sh) { return SHIPS[sh.t].hull; }
  function shieldMax(sh) { var n = 0; for (var k = 0; k < sh.s.length; k++) n += itemById('s', sh.s[k]).pts; return n; }
  function firepower(sh) { var n = 0; for (var k = 0; k < sh.w.length; k++) n += itemById('w', sh.w[k]).dmg; return n; }
  function hasG(sh, id) { return sh.g.indexOf(id) >= 0; }
  function itemById(cat, id) { var L = EQUIP[cat]; for (var k = 0; k < L.length; k++) if (L[k].id === id) return L[k]; return null; }
  function equipValue(sh) {
    var v = 0, k;
    for (k = 0; k < sh.w.length; k++) v += itemById('w', sh.w[k]).price;
    for (k = 0; k < sh.s.length; k++) v += itemById('s', sh.s[k]).price;
    for (k = 0; k < sh.g.length; k++) v += itemById('g', sh.g[k]).price;
    for (k = 1; k <= sh.eng; k++) v += ENGINES[k].price;
    return v;
  }
  // What the yard pays for your hull (equipment is moved over or sold separately).
  function tradeIn(sh) { var T = SHIPS[sh.t]; return Math.round(T.price * SELL_BACK * (0.5 + 0.5 * sh.hull / T.hull)); }
  function cargoCount(p) { var n = 0; for (var k = 0; k < NG; k++) n += p.cargo[k]; return n; }
  function freeSpace(p) { return Math.max(0, cargoCap(p.ship) - cargoCount(p)); }
  function contraband(p) { var n = 0; for (var k = 0; k < NG; k++) if (GOODS[k].illegal) n += p.cargo[k]; return n; }

  // ---- players ----
  function newPlayer(name, cpu, loc, cash) {
    var sh = newShip(0);
    sh.w.push('pulse');
    return {
      name: name, cpu: !!cpu, loc: loc, cr: cash, debt: 0, ship: sh,
      cargo: zeros(NG), paid: zeros(NG), missions: [], mdone: [],
      rec: 0, fame: 0, kills: 0, out: '', moon: false,
      st: { jumps: 0, trades: 0, profit: 0, best: 0 }, notes: []
    };
  }
  function zeros(n) { var a = []; for (var k = 0; k < n; k++) a.push(0); return a; }
  function recordName(r) { return r <= -30 ? 'Wanted' : r <= -10 ? 'Suspect' : r < 10 ? 'Clean' : r < 40 ? 'Lawful' : 'Trusted'; }
  function fameName(f) { return f < 2 ? 'Harmless' : f < 6 ? 'Known' : f < 14 ? 'Feared' : f < 30 ? 'Dangerous' : 'Legend'; }
  function worth(G, p) {
    var v = p.cr - p.debt + tradeIn(p.ship) + Math.round(equipValue(p.ship) * SELL_BACK) + (p.ship.pod ? POD_PRICE / 2 : 0);
    for (var k = 0; k < NG; k++) if (p.cargo[k]) v += p.cargo[k] * Math.round(avgPrice(G, k) * 0.9);
    return Math.round(v);
  }
  function maxLoan(G, p) { var w = worth(G, p) + p.debt; return Math.max(2000, Math.floor(w * 0.3 / 500) * 500); }

  // ---- a new game ----
  function newGame(o) {
    o = o || {};
    var seed = (o.seed >>> 0) || 1, diff = clamp(o.diff | 0, 0, 2), mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'solo';
    var sys = genGalaxy(seed), start = pickStart(sys), D = DIFFS[diff];
    var G = {
      v: VERSION, seed: seed, diff: diff, mode: mode, day: 1, turn: 0, rs: hash2(seed, 99) | 0,
      sys: sys, glut: [], ev: [], news: [], players: [], trip: null, over: null, start: start
    };
    for (var k = 0; k < sys.length; k++) { G.glut.push(zeros(NG)); G.ev.push(null); }
    var names = o.names || [];
    G.players.push(newPlayer(names[0] || 'Captain', false, start, D.cash));
    if (mode === 'cpu') G.players.push(newPlayer(names[1] || RIVALS[seed % RIVALS.length], true, start, D.cash));
    if (mode === 'duo') G.players.push(newPlayer(names[1] || 'Captain 2', false, start, D.cash));
    // a couple of stories to start with
    spawnEvent(G); spawnEvent(G);
    news(G, 'Markets open. The race for a moon of your own begins at ' + sys[start].name + '.', 'sys', start);
    return G;
  }
  function cur(G) { return G.players[G.turn]; }
  function news(G, t, k, si) { G.news.unshift({ d: G.day, t: t, k: k || '', s: si == null ? -1 : si }); if (G.news.length > 40) G.news.length = 40; }
  function spawnEvent(G) {
    var free = [];
    for (var k = 0; k < G.sys.length; k++) if (!G.ev[k]) free.push(k);
    if (!free.length) return;
    var si = free[ri(G, free.length)], e = ri(G, EVENTS.length), len = 6 + ri(G, 7);
    G.ev[si] = { e: e, until: G.day + len };
    news(G, EVENTS[e].t.replace('%s', G.sys[si].name), 'ev', si);
  }
  function activeEvents(G) {
    var n = 0;
    for (var k = 0; k < G.ev.length; k++) if (G.ev[k]) n++;
    return n;
  }
  // A day passes: markets recover, stories come and go, debts grow, deadlines lapse.
  function tickDay(G) {
    G.day++;
    var k, j;
    for (k = 0; k < G.glut.length; k++) for (j = 0; j < NG; j++) {
      var v = G.glut[k][j] * GLUT_DECAY;
      G.glut[k][j] = Math.abs(v) < 0.2 ? 0 : Math.round(v * 100) / 100;
    }
    for (k = 0; k < G.ev.length; k++) if (G.ev[k] && G.ev[k].until < G.day) {
      news(G, G.sys[k].name + ': ' + EVENTS[G.ev[k].e].id + ' is over, prices settle', 'end', k);
      G.ev[k] = null;
    }
    var n = activeEvents(G);
    if (rnd(G) < (n < 3 ? 0.6 : n < 6 ? 0.3 : 0.08)) spawnEvent(G);
    var rate = DIFFS[G.diff].rate;
    for (k = 0; k < G.players.length; k++) {
      var p = G.players[k];
      if (p.debt > 0) p.debt += Math.ceil(p.debt * rate);
      for (j = p.missions.length - 1; j >= 0; j--) {
        if (p.missions[j].due < G.day) {
          note(p, 'Mission failed: ' + missionTitle(G, p.missions[j]) + ' (deadline passed)');
          if (p.missions[j].k !== 'bounty') p.rec = Math.max(-100, p.rec - 1);
          p.missions.splice(j, 1);
        }
      }
    }
  }
  function note(p, t) { p.notes.push(t); if (p.notes.length > 20) p.notes.shift(); }

  // ---- trading ----
  function buy(G, pi, gi, n) {
    var p = G.players[pi], si = p.loc, done = 0, cost = 0;
    if (!produced(G, si, gi) && !(hasMarket(G, si, gi) && G.glut[si][gi] >= 1)) return { n: 0, cost: 0, why: 'none' };
    for (var k = 0; k < n; k++) {
      var q = quote(G, si, gi);
      if (!q || q.avail < 1) { if (!done) return { n: 0, cost: 0, why: 'stock' }; break; }
      if (p.cr < q.buy) { if (!done) return { n: 0, cost: 0, why: 'cash' }; break; }
      if (freeSpace(p) < 1) { if (!done) return { n: 0, cost: 0, why: 'space' }; break; }
      p.cr -= q.buy; cost += q.buy; p.cargo[gi]++; p.paid[gi] += q.buy; G.glut[si][gi] -= 1; done++;
    }
    if (done) p.st.trades++;
    return { n: done, cost: cost };
  }
  function sell(G, pi, gi, n) {
    var p = G.players[pi], si = p.loc, done = 0, got = 0, profit = 0;
    if (!hasMarket(G, si, gi)) return { n: 0, got: 0, why: 'market' };
    for (var k = 0; k < n && p.cargo[gi] > 0; k++) {
      var q = quote(G, si, gi), avg = p.paid[gi] / p.cargo[gi];
      p.cr += q.sell; got += q.sell; profit += q.sell - avg;
      p.paid[gi] -= avg; p.cargo[gi]--; G.glut[si][gi] += 1; done++;
    }
    if (!p.cargo[gi]) p.paid[gi] = 0;
    if (done) { p.st.trades++; p.st.profit += Math.round(profit); p.st.best = Math.max(p.st.best, Math.round(profit)); }
    return { n: done, got: got, profit: Math.round(profit) };
  }
  // How many units can be bought right now (cash, space, stock), for "buy max".
  function maxBuy(G, pi, gi) {
    var p = G.players[pi], si = p.loc, n = 0, cr = p.cr, room = freeSpace(p);
    if (!hasMarket(G, si, gi)) return 0;
    while (n < room) {
      var q = quote(G, si, gi, -n);
      if (!q || q.avail < 1 || cr < q.buy) break;
      cr -= q.buy; n++;
    }
    return n;
  }
  // The money a batch would bring (without doing it).
  function sellValue(G, si, gi, n) {
    var t = 0;
    for (var k = 0; k < n; k++) { var q = quote(G, si, gi, k); if (!q) return 0; t += q.sell; }
    return t;
  }

  // ---- shipyard ----
  function fuelPrice(G, p) { return Math.max(1, Math.round(SHIPS[p.ship.t].fuel * (1 + (7 - G.sys[p.loc].tl) * 0.05))); }
  function repairPrice(G, p) { return Math.max(1, Math.round(SHIPS[p.ship.t].rep * (1 + (7 - G.sys[p.loc].tl) * 0.06))); }
  function refuel(G, pi, n) {
    var p = G.players[pi], room = rangeOf(p.ship) - p.ship.fuel, pr = fuelPrice(G, p);
    n = Math.min(n == null ? room : n, room, Math.floor(p.cr / pr));
    if (n <= 0) return 0;
    p.ship.fuel += n; p.cr -= n * pr;
    return n;
  }
  function repair(G, pi, n) {
    var p = G.players[pi], room = hullMax(p.ship) - p.ship.hull, pr = repairPrice(G, p);
    n = Math.min(n == null ? room : n, room, Math.floor(p.cr / pr));
    if (n <= 0) return 0;
    p.ship.hull += n; p.cr -= n * pr;
    return n;
  }
  function slotsOf(sh, cat) { return SHIPS[sh.t][cat]; }
  // Can p buy this? '' = yes, else the reason.
  function canEquip(G, p, cat, id) {
    var it = itemById(cat, id), tl = G.sys[p.loc].tl;
    if (!it) return 'unknown';
    if (tl < it.tl) return 'needs tech ' + it.tl;
    if (p.ship[cat].length >= slotsOf(p.ship, cat)) return 'no free slot';
    if (p.cr < it.price) return 'not enough credits';
    return '';
  }
  function buyEquip(G, pi, cat, id) {
    var p = G.players[pi], why = canEquip(G, p, cat, id);
    if (why) return why;
    p.cr -= itemById(cat, id).price;
    p.ship[cat].push(id);
    if (cat === 's') p.ship.sh = shieldMax(p.ship);
    if (id === 'cells') p.ship.fuel = Math.min(p.ship.fuel, rangeOf(p.ship));
    return '';
  }
  function sellEquip(G, pi, cat, idx) {
    var p = G.players[pi], L = p.ship[cat];
    if (idx < 0 || idx >= L.length) return 0;
    var it = itemById(cat, L[idx]);
    if (cat === 'g' && it.id === 'pods' && freeSpace(p) < 6) return 0;
    L.splice(idx, 1);
    var v = Math.round(it.price * SELL_BACK);
    p.cr += v;
    if (cat === 's') p.ship.sh = Math.min(p.ship.sh, shieldMax(p.ship));
    p.ship.fuel = Math.min(p.ship.fuel, rangeOf(p.ship));
    return v;
  }
  function engineNext(G, p) {
    var k = p.ship.eng + 1;
    if (k >= ENGINES.length) return 'max';
    if (G.sys[p.loc].tl < ENGINES[k].tl) return 'needs tech ' + ENGINES[k].tl;
    if (p.cr < ENGINES[k].price) return 'not enough credits';
    return '';
  }
  function upgradeEngine(G, pi) {
    var p = G.players[pi], why = engineNext(G, p);
    if (why) return why;
    p.ship.eng++; p.cr -= ENGINES[p.ship.eng].price;
    return '';
  }
  function buyPod(G, pi) {
    var p = G.players[pi];
    if (p.ship.pod) return 'already fitted';
    if (p.cr < POD_PRICE) return 'not enough credits';
    p.cr -= POD_PRICE; p.ship.pod = true;
    return '';
  }
  // Net price of a new hull: its price minus the trade-in, plus equipment that won't fit (sold back).
  function shipDeal(G, p, type) {
    var T = SHIPS[type], sh = p.ship, lost = 0, cats = ['w', 's', 'g'];
    for (var c = 0; c < 3; c++) {
      var L = sh[cats[c]], fit = T[cats[c]];
      for (var k = fit; k < L.length; k++) lost += Math.round(itemById(cats[c], L[k]).price * SELL_BACK);
    }
    var cap = T.cargo, kept = Math.min(sh.g.length, T.g);
    for (k = 0; k < kept; k++) if (sh.g[k] === 'pods') cap += 6;
    var why = '';
    if (type === sh.t) why = 'your ship';
    else if (G.sys[p.loc].tl < T.tl) why = 'needs tech ' + T.tl;
    else if (cargoCount(p) > cap) why = 'cargo would not fit';
    var net = T.price - tradeIn(sh) - lost;
    if (!why && p.cr < net) why = 'not enough credits';
    return { net: net, lost: lost, why: why };
  }
  function buyShip(G, pi, type) {
    var p = G.players[pi], deal = shipDeal(G, p, type);
    if (deal.why) return deal.why;
    var old = p.ship, sh = newShip(type), T = SHIPS[type];
    sh.w = old.w.slice(0, T.w); sh.s = old.s.slice(0, T.s); sh.g = old.g.slice(0, T.g);
    sh.eng = old.eng; sh.pod = old.pod; sh.sh = shieldMax(sh);
    sh.fuel = Math.min(rangeOf(sh), old.fuel);
    p.cr -= deal.net; p.ship = sh;
    return '';
  }

  // ---- the bank ----
  function borrow(G, pi, n) {
    var p = G.players[pi], room = Math.max(0, maxLoan(G, p) - p.debt);
    n = Math.min(n == null ? room : n, room);
    if (n <= 0) return 0;
    p.debt += n; p.cr += n;
    return n;
  }
  function repay(G, pi, n) {
    var p = G.players[pi];
    n = Math.min(n == null ? p.debt : n, p.debt, p.cr);
    if (n <= 0) return 0;
    p.debt -= n; p.cr -= n;
    return n;
  }

  // ---- missions ----
  // The board at a system changes every 4 days; the same window shows the same offers.
  function board(G, si, pi) {
    var blk = Math.floor(G.day / 4), r = rng(hash3(G.seed, si * 101 + 7, blk)), out = [], s = G.sys[si], p = G.players[pi == null ? G.turn : pi];
    var far = [];
    for (var k = 0; k < G.sys.length; k++) { var d = dist(s, G.sys[k]); if (k !== si && d >= 9 && d <= 42) far.push(k); }
    if (!far.length) return out;
    for (var m = 0; m < 3; m++) {
      var kind = m === 0 ? 'courier' : m === 1 ? 'contract' : (r() < 0.65 ? 'bounty' : 'courier');
      var to = far[Math.floor(r() * far.length)], d2 = dist(s, G.sys[to]), id = si + '.' + blk + '.' + m, ms = null;
      if (kind === 'courier') {
        ms = { id: id, k: 'courier', to: to, from: si, pay: Math.round((150 + d2 * 32) * (1 + r() * 0.4) / 10) * 10, due: G.day + Math.ceil(d2 / 11) + 3 };
      } else if (kind === 'contract') {
        var goods = [];
        for (var g = 0; g < NG; g++) if (!GOODS[g].illegal && hasMarket(G, to, g) && G.sys[to].tl >= 1) goods.push(g);
        if (!goods.length) continue;
        var gg = goods[Math.floor(r() * goods.length)], n = Math.max(3, Math.round((4 + r() * 10) * (GOODS[gg].base > 2000 ? 0.4 : GOODS[gg].base > 600 ? 0.7 : 1)));
        var unit = fair(G, to, gg) || GOODS[gg].base;
        ms = { id: id, k: 'contract', to: to, from: si, g: gg, n: n, pay: Math.round(n * unit * (1.35 + r() * 0.25) / 10) * 10, due: G.day + Math.ceil(d2 / 10) + 5 };
      } else {
        var tier = clamp(Math.floor(r() * 3) + G.diff - 1 + Math.floor(G.day / 40), 0, 5);
        ms = { id: id, k: 'bounty', to: to, from: si, tier: tier, nm: PIRATE_NAMES[Math.floor(r() * PIRATE_NAMES.length)], pay: (1200 + tier * 1600) + Math.round(r() * 5) * 100, due: G.day + 12 };
      }
      if (ms && p && (p.mdone.indexOf(id) >= 0 || p.missions.some(function (x) { return x.id === id; }))) continue;
      if (ms) out.push(ms);
    }
    return out;
  }
  function missionTitle(G, m) {
    var to = G.sys[m.to] ? G.sys[m.to].name : '?';
    if (m.k === 'courier') return 'Courier parcel to ' + to;
    if (m.k === 'contract') return 'Deliver ' + m.n + ' ' + GOODS[m.g].name + ' to ' + to;
    return 'Bounty: ' + m.nm + ' near ' + to;
  }
  function accept(G, pi, mid) {
    var p = G.players[pi];
    if (p.missions.length >= MAX_MISSIONS) return 'mission log full (' + MAX_MISSIONS + ')';
    var L = board(G, p.loc, pi);
    for (var k = 0; k < L.length; k++) if (L[k].id === mid) { p.missions.push(L[k]); p.mdone.push(mid); if (p.mdone.length > 40) p.mdone.shift(); return ''; }
    return 'no longer offered';
  }
  function abandon(G, pi, idx) {
    var p = G.players[pi];
    if (idx < 0 || idx >= p.missions.length) return false;
    p.missions.splice(idx, 1);
    p.rec = Math.max(-100, p.rec - 1);
    return true;
  }
  // Deliveries at the system p has just reached.
  function deliver(G, pi) {
    var p = G.players[pi], out = [];
    for (var k = p.missions.length - 1; k >= 0; k--) {
      var m = p.missions[k];
      if (m.to !== p.loc || m.due < G.day) continue;
      if (m.k === 'courier') { p.cr += m.pay; out.push('Parcel delivered: +' + m.pay + ' cr'); p.rec = Math.min(100, p.rec + 1); p.missions.splice(k, 1); }
      else if (m.k === 'contract' && p.cargo[m.g] >= m.n) {
        var avg = p.paid[m.g] / p.cargo[m.g];
        p.cargo[m.g] -= m.n; p.paid[m.g] = Math.max(0, p.paid[m.g] - avg * m.n);
        p.cr += m.pay; out.push('Contract fulfilled: ' + m.n + ' ' + GOODS[m.g].name + ', +' + m.pay + ' cr');
        p.rec = Math.min(100, p.rec + 1); p.missions.splice(k, 1);
      }
    }
    return out;
  }

  // ---- travel & encounters ----
  function fuelNeed(G, a, b) { return Math.ceil(dist(G.sys[a], G.sys[b]) - 1e-9); }
  function canWarp(G, pi, to) {
    var p = G.players[pi];
    if (G.over || G.trip) return 'busy';
    if (typeof to !== 'number' || to !== (to | 0) || to < 0 || to >= G.sys.length) return 'no such system';
    if (to === p.loc) return 'here';
    var need = fuelNeed(G, p.loc, to);
    if (need > rangeOf(p.ship)) return 'out of range';
    if (need > p.ship.fuel) return 'not enough fuel';
    return '';
  }
  function rollEncounters(G, pi, to) {
    var p = G.players[pi], s = G.sys[to], gov = GOVS[s.gov], D = DIFFS[G.diff], q = [], police = false;
    var cloak = hasG(p.ship, 'cloak');
    for (var k = 0; k < 2; k++) {
      var pir = (0.03 + gov.pir * 0.027) * D.pir * (cloak ? 0.55 : 1) * (1 + Math.min(0.5, p.st.jumps / 200));
      var pol = police ? 0 : 0.02 + gov.pol * 0.022 + (p.rec <= -10 ? 0.1 : 0) + (contraband(p) ? 0.04 : 0);
      var trd = 0.03 + gov.trd * 0.012, der = 0.025, r = rnd(G);
      if (r < pir) q.push('pirate');
      else if (r < pir + pol) { q.push('police'); police = true; }
      else if (r < pir + pol + trd) q.push('trader');
      else if (r < pir + pol + trd + der) q.push('derelict');
    }
    for (k = 0; k < p.missions.length; k++) if (p.missions[k].k === 'bounty' && p.missions[k].to === to) { q.push('bounty:' + p.missions[k].id); break; }
    return q;
  }
  function warp(G, pi, to) {
    var why = canWarp(G, pi, to);
    if (why) return why;
    var p = G.players[pi];
    p.ship.fuel -= fuelNeed(G, p.loc, to);
    p.st.jumps++;
    G.trip = { pi: pi, from: p.loc, to: to, q: rollEncounters(G, pi, to), enc: null, pod: false };
    return '';
  }
  function playerTier(G, p) { return clamp(Math.floor(Math.log(Math.max(1500, worth(G, p)) / 1500) / Math.log(3.2)), 0, 5); }
  function mkEnemy(G, type, tier, kind) {
    var sh = newShip(type), T = SHIPS[type], k;
    sh.t = type; sh.hull = T.hull;
    var wt = clamp(Math.floor(tier / 2) + (rnd(G) < 0.3 ? 1 : 0), 0, 2);
    for (k = 0; k < T.w; k++) sh.w.push(WEAPONS[clamp(wt - (k > 0 && rnd(G) < 0.5 ? 1 : 0), 0, 2)].id);
    var nsh = kind === 'trader' ? Math.min(T.s, 1) : Math.min(T.s, Math.floor(tier / 2));
    for (k = 0; k < nsh; k++) sh.s.push(tier >= 4 ? 'aegis' : 'deflector');
    sh.sh = shieldMax(sh);
    sh.eng = clamp(Math.floor(tier / 2) + (kind === 'police' ? 1 : 0), 0, 3);
    if (tier >= 3 && rnd(G) < 0.5) sh.g.push('target');
    return sh;
  }
  // Start the next encounter of the trip; null when the way is clear.
  function nextEnc(G) {
    var T = G.trip;
    if (!T || T.enc) return T ? T.enc : null;
    while (T.q.length) {
      var kind = T.q.shift(), p = G.players[T.pi], pt = playerTier(G, p), e = null, tier, type;
      var gov = GOVS[G.sys[T.to].gov];
      if (kind === 'pirate') {
        tier = clamp(pt + ri(G, 3) - 1 + (G.diff === 2 ? 1 : 0) - (G.diff === 0 ? 1 : 0), 0, 5);
        type = clamp(tier + ri(G, 2) - 1, 0, 5);
        if (type === 1 || type === 3) type = type === 1 ? 2 : 4;        // pirates prefer fighting hulls
        e = { kind: 'pirate', name: 'Pirate ' + SHIPS[type].name, tier: tier, ship: mkEnemy(G, type, tier, 'pirate'), st: 'fight' };
      } else if (kind.indexOf('bounty:') === 0) {
        var mid = kind.slice(7), m = null;
        for (var k = 0; k < p.missions.length; k++) if (p.missions[k].id === mid) m = p.missions[k];
        if (!m) continue;
        tier = clamp(m.tier + 1, 0, 5); type = [2, 2, 4, 4, 4, 5][tier];
        e = { kind: 'bounty', name: m.nm, mid: mid, tier: tier, ship: mkEnemy(G, type, tier, 'pirate'), st: 'fight' };
        e.ship.hull = Math.round(e.ship.hull * 1.2);
      } else if (kind === 'police') {
        tier = clamp(Math.floor(gov.pol / 2) + ri(G, 2), 0, 5);
        type = [2, 2, 2, 4, 4, 4][tier];
        e = { kind: 'police', name: G.sys[T.to].name + ' patrol', tier: tier, ship: mkEnemy(G, type, tier, 'police'), st: p.rec <= -30 ? 'fight' : 'hail' };
      } else if (kind === 'trader') {
        type = [1, 1, 3, 3, 5][ri(G, 5)];
        e = { kind: 'trader', name: 'Trader ' + SHIPS[type].name, tier: 1, ship: mkEnemy(G, type, 1, 'trader'), st: 'hail', offer: traderOffer(G, p) };
        if (!e.offer) continue;
      } else if (kind === 'derelict') {
        e = { kind: 'derelict', name: 'Drifting wreck', tier: 0, ship: null, st: 'hail' };
      }
      if (!e) continue;
      e.log = []; e.res = e.res || '';
      e.hullMax = e.ship ? e.ship.hull : 0;
      // weak pirates may think better of it when they see your guns
      if (e.kind === 'pirate') {
        var ratio = (firepower(p.ship) + 1) * (hullMax(p.ship) + shieldMax(p.ship)) / ((firepower(e.ship) + 1) * (e.ship.hull + shieldMax(e.ship)));
        if (ratio * (1 + p.fame * 0.04) > 1.8 && rnd(G) < 0.55) { e.st = 'done'; e.res = 'scared'; e.log.push('The pirates see your guns and turn tail.'); }
      }
      T.enc = e;
      return e;
    }
    return null;
  }
  function traderOffer(G, p) {
    var opts = [], k;
    for (k = 0; k < NG; k++) if (p.cargo[k] > 0) opts.push({ g: k, sell: true });
    for (k = 0; k < 7; k++) opts.push({ g: ri(G, NG), sell: false });
    if (!opts.length) return null;
    var o = opts[ri(G, opts.length)], avg = avgPrice(G, o.g);
    if (o.sell) return { g: o.g, sell: true, n: p.cargo[o.g], price: Math.round(avg * (1.08 + rnd(G) * 0.12)) };
    return { g: o.g, sell: false, n: 4 + ri(G, 9), price: Math.round(avg * (0.78 + rnd(G) * 0.12)) };
  }
  function hitChance(att, def) {
    return clamp(0.64 + (hasG(att, 'target') ? 0.15 : 0) - def.eng * 0.06 - (hasG(def, 'cloak') ? 0.08 : 0), 0.2, 0.92);
  }
  function damage(sh, n) {
    var a = Math.min(sh.sh, n);
    sh.sh -= a; n -= a;
    sh.hull = Math.max(0, sh.hull - n);
    return { shield: a, hull: n };
  }
  function volley(G, att, def) {
    var tot = 0, hits = 0;
    for (var k = 0; k < att.w.length; k++) {
      if (rnd(G) < hitChance(att, def)) { var d = Math.round(itemById('w', att.w[k]).dmg * (0.6 + 0.4 * rnd(G))); tot += d; hits++; }
    }
    if (!att.w.length) return { dmg: 0, hits: 0, shots: 0 };
    var r = damage(def, tot);
    return { dmg: tot, hits: hits, shots: att.w.length, hull: r.hull, shield: r.shield };
  }
  function fleeChance(G, p, e) {
    return clamp(0.42 + p.ship.eng * 0.1 + (hasG(p.ship, 'cloak') ? 0.2 : 0) - (e.ship ? e.ship.eng * 0.07 : 0) + (SHIPS[p.ship.t].cargo > 30 ? -0.05 : 0), 0.1, 0.92);
  }
  function bribeCost(G, p, e) {
    var gov = GOVS[G.sys[G.trip ? G.trip.to : p.loc].gov];
    if (!gov.bribe) return 0;
    return Math.round((120 + worth(G, p) * 0.012 + contraband(p) * 60) * (4 - gov.bribe) / 2 / 10) * 10;
  }
  // The actions that make sense now: [{a, label}]
  function encActions(G) {
    var T = G.trip, e = T && T.enc, p = T && G.players[T.pi];
    if (!e) return [];
    if (e.st === 'done') return [{ a: 'go', label: 'Continue' }];
    if (e.kind === 'derelict') return [{ a: 'salvage', label: 'Salvage' }, { a: 'ignore', label: 'Fly past' }];
    if (e.kind === 'trader') {
      var o = e.offer, L = [];
      L.push({ a: 'trade', label: o.sell ? 'Sell them ' + GOODS[o.g].name : 'Buy ' + GOODS[o.g].name });
      L.push({ a: 'ignore', label: 'Ignore' });
      if (p.ship.w.length) L.push({ a: 'attack', label: 'Attack' });
      return L;
    }
    if (e.kind === 'police' && e.st === 'hail') {
      var b = bribeCost(G, p, e), L2 = [{ a: 'submit', label: 'Submit' }];
      L2.push({ a: 'bribe', label: b ? 'Bribe ' + b : 'Bribe' });
      L2.push({ a: 'flee', label: 'Flee' });
      if (p.ship.w.length) L2.push({ a: 'attack', label: 'Attack' });
      return L2;
    }
    var F = [];
    if (p.ship.w.length) F.push({ a: 'attack', label: 'Attack' });
    F.push({ a: 'flee', label: 'Flee' });
    F.push({ a: 'surrender', label: 'Surrender' });
    return F;
  }
  function lootCargo(G, p, n, legalOnly) {
    var got = [], room = freeSpace(p);
    n = Math.min(n, room);
    if (n <= 0) return got;
    var gi = ri(G, NG);
    if (legalOnly) while (GOODS[gi].illegal) gi = ri(G, NG);
    p.cargo[gi] += n;
    got.push(n + ' ' + GOODS[gi].name);
    return got;
  }
  // The enemy's half of a round (after the player's move). Returns true when the fight goes on.
  function enemyTurn(G, p, e, out) {
    var es = e.ship;
    if (e.kind !== 'police' && es.hull < e.hullMax * 0.35 && e.kind !== 'bounty' && rnd(G) < 0.45) {
      if (e.kind === 'pirate' && rnd(G) < 0.4 + p.fame * 0.02) {
        var pay = 100 + e.tier * 150 + ri(G, 200);
        p.cr += pay; e.st = 'done'; e.res = 'yield';
        out.push('The pirates surrender and pay ' + pay + ' cr to be let go.'); out.fx.push('coin');
      } else { e.st = 'done'; e.res = 'escaped'; out.push('The ' + (e.kind === 'trader' ? 'trader' : 'enemy') + ' breaks off and escapes.'); }
      return false;
    }
    if (!es.w.length) return true;
    var v = volley(G, es, p.ship);
    if (!v.hits) out.push('They fire — and miss.');
    else { out.push('They hit you for ' + v.dmg + (v.shield ? ' (' + v.shield + ' absorbed by shields)' : '') + '.'); out.fx.push('hurt'); }
    if (p.ship.hull <= 0) { destroyed(G, p, e, out); return false; }
    return true;
  }
  function destroyed(G, p, e, out) {
    var T = G.trip;
    e.st = 'done';
    if (p.ship.pod) {
      e.res = 'pod';
      out.push('Your ship breaks apart! The escape pod carries you to ' + G.sys[T.to].name + '.');
      var sh = newShip(0);
      sh.fuel = 0;
      p.ship = sh; p.cargo = zeros(NG); p.paid = zeros(NG);
      T.q = []; T.pod = true;
      out.fx.push('boom');
    } else {
      e.res = 'dead';
      p.out = 'dead';
      out.push('Your ship is destroyed with all hands.');
      out.fx.push('boom');
    }
  }
  function enemyKilled(G, p, e, out) {
    e.st = 'done'; e.res = 'won';
    p.kills++;
    out.fx.push('boom');
    if (e.kind === 'pirate' || e.kind === 'bounty') {
      var b = e.kind === 'bounty' ? 0 : 150 + e.tier * 300 + ri(G, 150);
      if (e.kind === 'bounty') {
        for (var k = 0; k < p.missions.length; k++) if (p.missions[k].id === e.mid) { b = p.missions[k].pay; p.missions.splice(k, 1); break; }
        p.fame += 2;
      }
      p.cr += b; p.fame += 1; p.rec = Math.min(100, p.rec + 3);
      out.push(e.name + ' destroyed! Bounty: ' + b + ' cr.');
      var got = lootCargo(G, p, 1 + ri(G, 4 + e.tier), false);
      if (got.length) out.push('You scoop up ' + got.join(', ') + ' from the wreckage.');
      out.fx.push('coin');
    } else if (e.kind === 'police') {
      p.rec = Math.max(-100, p.rec - 40);
      out.push('The patrol ship explodes. You are a wanted criminal now.');
    } else if (e.kind === 'trader') {
      p.rec = Math.max(-100, p.rec - 20);
      var n = e.offer && !e.offer.sell ? e.offer.n : 3 + ri(G, 5), room = freeSpace(p), gi = e.offer && !e.offer.sell ? e.offer.g : ri(G, NG);
      n = Math.min(n, room);
      if (n > 0) { p.cargo[gi] += n; out.push('Piracy! You plunder ' + n + ' ' + GOODS[gi].name + '.'); }
      else out.push('The trader is gone. Your hold had no room for plunder.');
    }
  }
  // Player action in the current encounter: returns { lines, fx }.
  function encAct(G, act) {
    var T = G.trip, e = T && T.enc, out = [];
    out.fx = [];
    if (!e) return { lines: out, fx: out.fx };
    var p = G.players[T.pi], v, ok = encActions(G).some(function (x) { return x.a === act; });
    if (!ok) return { lines: out, fx: out.fx };
    if (act === 'go') { T.enc = null; p.ship.sh = shieldMax(p.ship); return { lines: out, fx: out.fx }; }
    if (act === 'ignore') {
      e.st = 'done'; e.res = 'passed';
      out.push(e.kind === 'derelict' ? 'You leave the wreck to drift.' : 'You fly on.');
    } else if (act === 'salvage') {
      e.st = 'done';
      if (rnd(G) < 0.22) {
        var d = 8 + ri(G, 18); damage(p.ship, d); e.res = 'trap';
        out.push('Booby-trapped! A blast rocks your hull (-' + d + ').'); out.fx.push('hurt');
        if (p.ship.hull <= 0) { p.ship.hull = 1; out.push('Your hull holds — barely.'); }
      } else {
        e.res = 'salvaged';
        var got = lootCargo(G, p, 2 + ri(G, 5), rnd(G) < 0.8);
        if (got.length) { out.push('You salvage ' + got.join(', ') + '.'); out.fx.push('coin'); }
        else out.push('Your hold is full — nothing to take.');
      }
    } else if (act === 'trade') {
      var o = e.offer, n;
      if (o.sell) {
        n = o.n = Math.min(o.n, p.cargo[o.g]);
        if (n > 0) {
          var avg = p.paid[o.g] / p.cargo[o.g];
          p.cargo[o.g] -= n; p.paid[o.g] = Math.max(0, p.paid[o.g] - avg * n); p.cr += n * o.price;
          p.st.profit += Math.round((o.price - avg) * n);
          out.push('Sold ' + n + ' ' + GOODS[o.g].name + ' for ' + (n * o.price) + ' cr.'); out.fx.push('coin');
        }
      } else {
        n = Math.min(o.n, freeSpace(p), Math.floor(p.cr / o.price));
        if (n > 0) { p.cargo[o.g] += n; p.paid[o.g] += n * o.price; p.cr -= n * o.price; out.push('Bought ' + n + ' ' + GOODS[o.g].name + ' for ' + (n * o.price) + ' cr.'); out.fx.push('coin'); }
        else out.push(freeSpace(p) ? 'You can\u2019t afford a single unit.' : 'No room in your hold.');
      }
      e.st = 'done'; e.res = 'traded';
    } else if (act === 'submit') {
      var c = contraband(p);
      e.st = 'done'; e.res = 'inspected';
      if (c) {
        var val = 0;
        for (var g = 0; g < NG; g++) if (GOODS[g].illegal && p.cargo[g]) { val += p.cargo[g] * GOODS[g].base; p.cargo[g] = 0; p.paid[g] = 0; }
        var fine = Math.min(p.cr, Math.round((300 + val * 0.3) / 10) * 10);
        p.cr -= fine; p.rec = Math.max(-100, p.rec - 8);
        out.push('Contraband found! ' + c + ' units seized and a ' + fine + ' cr fine.'); out.fx.push('hurt');
      } else {
        p.rec = Math.min(p.rec + 1, Math.max(p.rec, 20));
        out.push('Clean. "Thank you for your cooperation, captain."');
      }
    } else if (act === 'bribe') {
      var cost = bribeCost(G, p, e);
      if (!cost) { p.rec = Math.max(-100, p.rec - 2); out.push('"Are you trying to bribe an officer?" Your offer is refused.'); }
      else if (p.cr < cost) out.push('You don\u2019t have ' + cost + ' cr.');
      else { p.cr -= cost; p.rec = Math.max(-100, p.rec - 1); e.st = 'done'; e.res = 'bribed'; out.push('The officer pockets ' + cost + ' cr and waves you through.'); out.fx.push('coin'); }
    } else if (act === 'surrender') {
      e.st = 'done'; e.res = 'surrender';
      if (e.kind === 'police') {
        var cb = contraband(p);
        for (var g2 = 0; g2 < NG; g2++) if (GOODS[g2].illegal) { p.cargo[g2] = 0; p.paid[g2] = 0; }
        var fine2 = Math.min(p.cr, Math.round((800 + p.cr * 0.1 + cb * 100) / 10) * 10);
        p.cr -= fine2; p.rec = Math.max(p.rec, -5);
        out.push('Arrested. You pay ' + fine2 + ' cr and your record is reset to Suspect.');
      } else {
        var units = cargoCount(p);
        if (units) { p.cargo = zeros(NG); p.paid = zeros(NG); out.push('The pirates strip your hold: ' + units + ' units taken.'); }
        else { var take = Math.round(p.cr * 0.15); p.cr -= take; out.push('Your hold is empty, so they take ' + take + ' cr instead.'); }
        out.fx.push('hurt');
      }
    } else if (act === 'flee') {
      if (rnd(G) < fleeChance(G, p, e)) {
        if (e.kind === 'police' && e.st === 'hail') p.rec = Math.max(-100, p.rec - 6);
        e.st = 'done'; e.res = 'fled';
        out.push('You punch the drive and get away.'); out.fx.push('warp');
      } else {
        out.push('You try to run but they keep up!');
        if (e.kind === 'police' && e.st === 'hail') { e.st = 'fight'; p.rec = Math.max(-100, p.rec - 6); out.push('"Halt! You are under arrest."'); }
        if (e.kind === 'trader') { e.st = 'done'; e.res = 'passed'; }
        else enemyTurn(G, p, e, out);
      }
    } else if (act === 'attack') {
      if (e.kind === 'police' && e.st === 'hail') { p.rec = Math.max(-100, p.rec - 15); e.st = 'fight'; }
      if (e.kind === 'trader' && e.st === 'hail') { p.rec = Math.max(-100, p.rec - 8); e.st = 'fight'; }
      v = volley(G, p.ship, e.ship);
      out.fx.push('zap');
      if (!v.hits) out.push('You fire — and miss.');
      else out.push('You hit for ' + v.dmg + (v.shield ? ' (' + v.shield + ' on shields)' : '') + '.');
      if (e.ship.hull <= 0) enemyKilled(G, p, e, out);
      else if (e.kind === 'trader' && rnd(G) < 0.35) { e.st = 'done'; e.res = 'escaped'; out.push('The trader dumps its throttle and escapes.'); }
      else enemyTurn(G, p, e, out);
    }
    e.log = e.log.concat(out).slice(-6);
    return { lines: out, fx: out.fx };
  }
  // The trip ends: you dock (or the pod lands). Returns report lines.
  function arrive(G) {
    var T = G.trip;
    if (!T || T.enc || T.q.length) return null;
    var p = G.players[T.pi], out = [];
    G.trip = null;
    if (p.out === 'dead') return out;
    p.loc = T.to;
    p.ship.sh = shieldMax(p.ship);
    if (T.pod) out.push('The pod lands safely. The yard lends you a bare Sparrow.');
    out = out.concat(deliver(G, T.pi));
    var ev = G.ev[T.to];
    if (ev) out.push('News here: ' + EVENTS[ev.e].t.replace('%s', G.sys[T.to].name) + '.');
    return out;
  }
  function alive(p) { return !p.out; }
  // Hand over to the next captain (CPU rivals move at once). A round of turns is a day.
  function endTurn(G) {
    var res = { cpu: [], day: false, next: G.turn };
    if (G.over) return res;
    checkOver(G);
    if (G.over) return res;
    for (var guard = 0; guard < G.players.length * 2 + 2; guard++) {
      var nx = (G.turn + 1) % G.players.length;
      if (nx <= G.turn) { tickDay(G); res.day = true; }
      G.turn = nx;
      var p = G.players[nx];
      if (!alive(p)) continue;
      if (p.cpu) {
        var cl = cpuTurn(G, nx);
        res.cpu = res.cpu.concat(cl);
        if (cl.length) news(G, cl.join(' \u00b7 '), 'rival', p.loc);
        checkOver(G);
        if (G.over) return res;
        continue;
      }
      break;
    }
    res.next = G.turn;
    return res;
  }
  // ---- the goal ----
  function moonPrice(G) { return DIFFS[G.diff].moon; }
  function canMoon(G, p) {
    if (G.sys[p.loc].tl < 6) return 'only sold at tech 6+ worlds';
    if (p.debt > 0) return 'pay off your loan first';
    if (p.cr < moonPrice(G)) return 'needs ' + moonPrice(G) + ' cr';
    return '';
  }
  function buyMoon(G, pi) {
    var p = G.players[pi], why = canMoon(G, p);
    if (why) return why;
    p.cr -= moonPrice(G); p.moon = true; p.out = 'moon';
    news(G, p.name + ' buys a moon at ' + G.sys[p.loc].name + '!', 'win', p.loc);
    checkOver(G);
    return '';
  }
  function retire(G, pi) {
    var p = G.players[pi];
    if (G.over || p.out) return 'already out';
    if (G.trip) return 'busy';
    p.out = 'retired';
    checkOver(G);
    return '';
  }
  function score(G, p) {
    var D = DIFFS[G.diff], w = Math.max(0, worth(G, p)), s = w / 100;
    if (p.moon) s += D.moon / 50 * (1 + 100 / (G.day + 20));
    else if (p.out === 'dead') s *= 0.25;
    return Math.round(s * D.mul);
  }
  function checkOver(G) {
    if (G.over) return;
    var L = G.players, k, humans = L.filter(function (p) { return !p.cpu; });
    for (k = 0; k < L.length; k++) if (L[k].moon) { G.over = { winner: k, why: 'moon', day: G.day }; return; }
    if (G.mode === 'solo') {
      if (L[0].out) G.over = { winner: L[0].out === 'retired' ? 0 : -1, why: L[0].out, day: G.day };
      return;
    }
    if (G.mode === 'cpu' && L[0].out) { G.over = { winner: 1, why: L[0].out === 'retired' ? 'conceded' : 'dead', day: G.day }; return; }
    if (G.mode === 'duo') {
      var live = [];
      for (k = 0; k < L.length; k++) if (alive(L[k])) live.push(k);
      if (live.length === 1 && humans.length > 1) G.over = { winner: live[0], why: 'last', day: G.day };
      else if (!live.length) G.over = { winner: -1, why: 'dead', day: G.day };
    }
  }

  // ---- the CPU rival: a greedy trader that uses the same markets ----
  // The best single-good run from system si to any neighbour (a look-ahead).
  function opportunity(G, si, cap, cr) {
    var best = 0, nb = neighbours(G.sys, si, 16);
    for (var gi = 0; gi < NG; gi++) {
      if (GOODS[gi].illegal || !produced(G, si, gi)) continue;
      var q = quote(G, si, gi);
      var n = Math.min(cap, q.avail, Math.floor(cr / q.buy));
      if (n < 1) continue;
      for (var k = 0; k < nb.length; k++) {
        var q2 = quote(G, nb[k], gi);
        if (q2) best = Math.max(best, (q2.sell - q.buy) * n * 0.7);
      }
    }
    return best;
  }
  function cpuTurn(G, pi) {
    var p = G.players[pi], out = [], k, gi, here = p.loc, D = DIFFS[G.diff];
    if (G.trip) return out;
    var gain = 0;
    for (gi = 0; gi < NG; gi++) if (p.cargo[gi] && hasMarket(G, here, gi)) { var r = sell(G, pi, gi, p.cargo[gi]); gain += r.profit; }
    if (gain) out.push(p.name + ' trades at ' + G.sys[here].name + ' (' + (gain >= 0 ? '+' : '') + gain + ' cr)');
    if (p.debt && (p.cr > p.debt * 2 + 3000 || p.cr >= moonPrice(G) + p.debt)) repay(G, pi);
    if (!p.debt && p.cr < 300 && !cargoCount(p)) borrow(G, pi, 1500);
    if (!canMoon(G, p)) { buyMoon(G, pi); out.push(p.name + ' buys a moon at ' + G.sys[here].name + '!'); return out; }
    // upgrade the hull when rich enough
    for (k = SHIPS.length - 1; k > p.ship.t; k--) {
      if (SHIPS[k].cargo <= cargoCap(p.ship)) continue;
      var deal = shipDeal(G, p, k);
      if (!deal.why && p.cr > deal.net * 1.5 + 2000) { buyShip(G, pi, k); out.push(p.name + ' buys a ' + SHIPS[k].name); break; }
    }
    refuel(G, pi);
    if (rnd(G) < D.idle) { out.push(p.name + ' stays docked at ' + G.sys[here].name); return out; }
    var range = Math.min(p.ship.fuel, rangeOf(p.ship)), dests = neighbours(G.sys, here, range), best = null;
    if (!dests.length) { refuel(G, pi); dests = neighbours(G.sys, here, Math.max(1, p.ship.fuel)); }
    var rich = p.cr >= moonPrice(G), cap = cargoCap(p.ship);
    for (k = 0; k < dests.length; k++) {
      var to = dests[k], plan = { to: to, g: -1, n: 0, v: 0 };
      if (rich) {
        var dd = 1e9;
        for (var t2 = 0; t2 < G.sys.length; t2++) if (G.sys[t2].tl >= 6) dd = Math.min(dd, dist(G.sys[to], G.sys[t2]));
        plan.v = 1e6 - dd * 1000;
      } else {
        for (gi = 0; gi < NG; gi++) {
          if (GOODS[gi].illegal || !produced(G, here, gi) || !hasMarket(G, to, gi)) continue;
          var n = maxBuy(G, pi, gi);
          if (n < 1) continue;
          var cost = 0;
          for (var u = 0; u < n; u++) cost += quote(G, here, gi, -u).buy;
          var v = sellValue(G, to, gi, n) - cost;
          if (v > plan.v) { plan.v = v; plan.g = gi; plan.n = n; }
        }
      }
      if (!rich) plan.v += 0.5 * opportunity(G, to, cap, p.cr) - (to === p.prev ? 200 : 0);
      plan.v *= 1 + D.noise * (rnd(G) * 2 - 1);
      if (!best || plan.v > best.v) best = plan;
    }
    if (!best) return out;
    if (best.g >= 0 && best.n > 0) buy(G, pi, best.g, best.n);
    if (warp(G, pi, best.to)) { G.trip = null; return out; }
    // the trip, abstracted: pirates may rob the rival, depending on where it flies
    var T = G.trip, lossP = 0;
    for (k = 0; k < T.q.length; k++) if (T.q[k] === 'pirate') lossP += 0.5 * D.cpuLoss;
    G.trip = null;
    if (lossP && rnd(G) < lossP) {
      var lost = 0;
      for (gi = 0; gi < NG; gi++) { var l = Math.ceil(p.cargo[gi] * 0.4); p.cargo[gi] -= l; p.paid[gi] *= p.cargo[gi] ? (p.cargo[gi] / (p.cargo[gi] + l)) : 0; lost += l; }
      p.ship.hull = Math.max(1, p.ship.hull - 10 - ri(G, 30));
      if (lost) out.push('Pirates rob ' + p.name + ' of ' + lost + ' units');
    }
    p.prev = p.loc; p.loc = best.to;
    repair(G, pi);
    if (best.g >= 0) out.push(p.name + ' hauls ' + best.n + ' ' + GOODS[best.g].name + ' to ' + G.sys[best.to].name);
    else out.push(p.name + ' jumps to ' + G.sys[best.to].name);
    return out;
  }

  // ---- saves ----
  function toSave(G) {
    var o = {};
    for (var k in G) if (k !== 'sys') o[k] = G[k];
    return o;
  }
  function num(v, d, lo, hi) { v = +v; if (!isFinite(v)) v = d; return clamp(v, lo, hi); }
  function normList(L, cat, max) {
    var out = [];
    if (!Array.isArray(L)) return out;
    for (var k = 0; k < L.length && out.length < max; k++) if (itemById(cat, L[k])) out.push(L[k]);
    return out;
  }
  function normShip(o) {
    if (!o || typeof o !== 'object') { var s0 = newShip(0); s0.w.push('pulse'); return s0; }
    var t = clamp(o.t | 0, 0, SHIPS.length - 1), T = SHIPS[t], sh = newShip(t);
    sh.w = normList(o.w, 'w', T.w); sh.s = normList(o.s, 's', T.s); sh.g = normList(o.g, 'g', T.g);
    sh.eng = clamp(o.eng | 0, 0, ENGINES.length - 1); sh.pod = !!o.pod;
    sh.hull = Math.round(num(o.hull, T.hull, 1, T.hull));
    sh.fuel = Math.round(num(o.fuel, rangeOf(sh), 0, rangeOf(sh)));
    sh.sh = Math.round(num(o.sh, shieldMax(sh), 0, shieldMax(sh)));
    return sh;
  }
  function normInts(L, n, lo, hi) {
    var out = zeros(n);
    if (Array.isArray(L)) for (var k = 0; k < n; k++) out[k] = num(L[k], 0, lo, hi);
    return out;
  }
  function normMission(m, nsys) {
    if (!m || typeof m !== 'object' || ['courier', 'contract', 'bounty'].indexOf(m.k) < 0) return null;
    var o = { id: String(m.id || ''), k: m.k, to: m.to | 0, from: m.from | 0, pay: Math.round(num(m.pay, 0, 0, 1e7)), due: m.due | 0 };
    if (o.to < 0 || o.to >= nsys) return null;
    if (m.k === 'contract') { o.g = clamp(m.g | 0, 0, NG - 1); o.n = clamp(m.n | 0, 1, 200); }
    if (m.k === 'bounty') { o.tier = clamp(m.tier | 0, 0, 5); o.nm = String(m.nm || 'a pirate').slice(0, 30); }
    return o;
  }
  function normPlayer(o, nsys, D) {
    var p = newPlayer('Captain', false, 0, D.cash);
    if (!o || typeof o !== 'object') return p;
    p.name = String(o.name || 'Captain').slice(0, 24) || 'Captain';
    p.cpu = !!o.cpu;
    p.loc = clamp(o.loc | 0, 0, nsys - 1);
    p.cr = Math.round(num(o.cr, D.cash, -1e9, 1e10));
    p.debt = Math.round(num(o.debt, 0, 0, 1e10));
    p.ship = normShip(o.ship);
    p.cargo = normInts(o.cargo, NG, 0, 1000).map(Math.round);
    p.paid = normInts(o.paid, NG, 0, 1e9);
    for (var k = 0; k < NG; k++) if (!p.cargo[k]) p.paid[k] = 0;
    p.missions = (Array.isArray(o.missions) ? o.missions : []).map(function (m) { return normMission(m, nsys); }).filter(Boolean).slice(0, MAX_MISSIONS);
    p.mdone = (Array.isArray(o.mdone) ? o.mdone : []).map(String).slice(-40);
    p.rec = Math.round(num(o.rec, 0, -100, 100));
    p.fame = Math.round(num(o.fame, 0, 0, 1e4));
    p.kills = Math.round(num(o.kills, 0, 0, 1e5));
    p.out = ['', 'dead', 'moon', 'retired'].indexOf(o.out) >= 0 ? o.out : '';
    p.moon = !!o.moon;
    var st = o.st || {};
    p.st = { jumps: Math.round(num(st.jumps, 0, 0, 1e6)), trades: Math.round(num(st.trades, 0, 0, 1e7)), profit: Math.round(num(st.profit, 0, -1e10, 1e10)), best: Math.round(num(st.best, 0, -1e10, 1e10)) };
    p.notes = (Array.isArray(o.notes) ? o.notes : []).map(String).slice(-20);
    return p;
  }
  // A loaded save, rebuilt and checked field by field (null if unusable).
  function normGame(o) {
    if (!o || typeof o !== 'object' || o.v !== VERSION) return null;
    var seed = o.seed >>> 0;
    if (!seed) return null;
    var G;
    try { G = newGame({ seed: seed, diff: o.diff, mode: o.mode }); } catch (e) { return null; }
    var n = G.sys.length, D = DIFFS[G.diff], k, j;
    G.day = Math.max(1, Math.round(num(o.day, 1, 1, 1e6)));
    G.rs = (o.rs | 0) || G.rs;
    G.start = clamp(o.start | 0, 0, n - 1);
    for (k = 0; k < n; k++) {
      var row = Array.isArray(o.glut) ? o.glut[k] : null;
      for (j = 0; j < NG; j++) G.glut[k][j] = row ? num(row[j], 0, -500, 500) : 0;
      var ev = Array.isArray(o.ev) ? o.ev[k] : null;
      G.ev[k] = ev && typeof ev === 'object' && EVENTS[ev.e | 0] ? { e: ev.e | 0, until: ev.until | 0 } : null;
    }
    G.news = (Array.isArray(o.news) ? o.news : []).filter(function (x) { return x && typeof x.t === 'string'; }).slice(0, 40)
      .map(function (x) { return { d: x.d | 0, t: x.t.slice(0, 200), k: String(x.k || ''), s: x.s == null ? -1 : x.s | 0 }; });
    var want = G.mode === 'solo' ? 1 : 2;
    if (!Array.isArray(o.players) || o.players.length !== want) return null;
    G.players = o.players.map(function (x) { return normPlayer(x, n, D); });
    if (G.mode === 'cpu') { G.players[0].cpu = false; G.players[1].cpu = true; } else G.players.forEach(function (p) { p.cpu = false; });
    G.turn = clamp(o.turn | 0, 0, G.players.length - 1);
    if (G.players[G.turn].cpu) G.turn = 0;
    G.trip = null;
    var t = o.trip;
    if (t && typeof t === 'object' && (t.pi | 0) === G.turn && (t.to | 0) >= 0 && (t.to | 0) < n) {
      G.trip = { pi: G.turn, from: clamp(t.from | 0, 0, n - 1), to: t.to | 0, q: (Array.isArray(t.q) ? t.q : []).filter(function (x) { return typeof x === 'string'; }).slice(0, 4), enc: null, pod: !!t.pod };
      var e = t.enc;
      if (e && typeof e === 'object' && ['pirate', 'bounty', 'police', 'trader', 'derelict'].indexOf(e.kind) >= 0) {
        var ne = { kind: e.kind, name: String(e.name || '').slice(0, 40), tier: clamp(e.tier | 0, 0, 5), st: ['fight', 'hail', 'done'].indexOf(e.st) >= 0 ? e.st : 'done',
          res: String(e.res || ''), log: (Array.isArray(e.log) ? e.log : []).map(String).slice(-6), ship: e.ship ? normShip(e.ship) : null, hullMax: 0 };
        if (ne.kind !== 'derelict' && !ne.ship) ne.st = 'done';
        if (ne.ship) ne.hullMax = Math.round(num(e.hullMax, ne.ship.hull, 1, 1000));
        if (e.mid) ne.mid = String(e.mid);
        if (e.kind === 'trader') {
          var of = e.offer;
          if (of && typeof of === 'object') ne.offer = { g: clamp(of.g | 0, 0, NG - 1), sell: !!of.sell, n: clamp(of.n | 0, 0, 1000), price: Math.round(num(of.price, 1, 1, 1e6)) };
          else ne.st = 'done';
        }
        G.trip.enc = ne;
      }
    }
    if (o.over && typeof o.over === 'object') G.over = { winner: o.over.winner | 0, why: String(o.over.why || ''), day: o.over.day | 0 };
    else G.over = null;
    return G;
  }
  function newRecords() { return { games: 0, wins: 0, best: [] }; }
  function normRecords(o) {
    var r = newRecords();
    if (!o || typeof o !== 'object') return r;
    r.games = Math.round(num(o.games, 0, 0, 1e6)); r.wins = Math.round(num(o.wins, 0, 0, 1e6));
    r.best = (Array.isArray(o.best) ? o.best : []).filter(function (b) { return b && isFinite(+b.score); }).map(function (b) {
      return { score: Math.round(+b.score), name: String(b.name || '').slice(0, 24), diff: clamp(b.diff | 0, 0, 2), mode: MODES.indexOf(b.mode) >= 0 ? b.mode : 'solo', day: b.day | 0, how: String(b.how || '').slice(0, 20) };
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    return r;
  }
  // Fold a finished game into the records; returns { rank } (-1 = not on the board).
  function record(R, G) {
    R.games++;
    var p = G.players[0], ov = G.over || {}, k;
    var hum = G.players.map(function (x, i) { return { p: x, i: i }; }).filter(function (x) { return !x.p.cpu; });
    if (G.mode === 'duo') { p = G.players[ov.winner >= 0 ? ov.winner : 0]; }
    var won = G.mode === 'duo' ? ov.winner >= 0 : ov.winner === 0 && (ov.why === 'moon' || G.mode === 'solo');
    if (G.mode !== 'duo' && ov.why === 'moon' && ov.winner === 0) R.wins++;
    else if (G.mode === 'duo' && ov.why === 'moon') R.wins++;
    var e = { score: score(G, p), name: p.name, diff: G.diff, mode: G.mode, day: G.day, how: p.moon ? 'moon' : p.out === 'retired' ? 'retired' : won ? 'won' : 'lost' };
    R.best.push(e);
    R.best.sort(function (a, b) { return b.score - a.score; });
    R.best = R.best.slice(0, 8);
    k = R.best.indexOf(e);
    return { rank: k, entry: e, hum: hum.length };
  }

  var ENGINE = {
    VERSION: VERSION, GOODS: GOODS, GOVS: GOVS, SPECS: SPECS, EVENTS: EVENTS, SHIPS: SHIPS, WEAPONS: WEAPONS, SHIELDS: SHIELDS, GADGETS: GADGETS,
    ENGINES: ENGINES, DIFFS: DIFFS, MODES: MODES, TECH: TECH, COLS: COLS, ROWS: ROWS, MAP_W: MAP_W, MAP_H: MAP_H, NSYS: NSYS, POD_PRICE: POD_PRICE, MAX_MISSIONS: MAX_MISSIONS,
    rng: rng, hash2: hash2, rnd: rnd, genGalaxy: genGalaxy, dist: dist, cellOf: cellOf, neighbours: neighbours, connected: connected,
    newGame: newGame, cur: cur, fair: fair, quote: quote, avgPrice: avgPrice, hasMarket: hasMarket, produced: produced,
    buy: buy, sell: sell, maxBuy: maxBuy, sellValue: sellValue, cargoCap: cargoCap, cargoCount: cargoCount, freeSpace: freeSpace, contraband: contraband,
    rangeOf: rangeOf, hullMax: hullMax, shieldMax: shieldMax, firepower: firepower, itemById: itemById, hasG: hasG, tradeIn: tradeIn,
    fuelPrice: fuelPrice, repairPrice: repairPrice, refuel: refuel, repair: repair, canEquip: canEquip, buyEquip: buyEquip, sellEquip: sellEquip,
    engineNext: engineNext, upgradeEngine: upgradeEngine, buyPod: buyPod, shipDeal: shipDeal, buyShip: buyShip,
    worth: worth, maxLoan: maxLoan, borrow: borrow, repay: repay, recordName: recordName, fameName: fameName,
    board: board, missionTitle: missionTitle, accept: accept, abandon: abandon, deliver: deliver,
    fuelNeed: fuelNeed, canWarp: canWarp, warp: warp, nextEnc: nextEnc, encActions: encActions, encAct: encAct, fleeChance: fleeChance, bribeCost: bribeCost,
    arrive: arrive, endTurn: endTurn, tickDay: tickDay, spawnEvent: spawnEvent, cpuTurn: cpuTurn,
    moonPrice: moonPrice, canMoon: canMoon, buyMoon: buyMoon, retire: retire, score: score, checkOver: checkOver,
    toSave: toSave, normGame: normGame, newRecords: newRecords, normRecords: normRecords, record: record
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('spacetrader.css');

  var PANEL_ID = 'spacetrader-panel', NAME = 'Space Trader';
  var KEY = 'cade-spacetrader-', SAVE_KEY = KEY + 'save', REC_KEY = KEY + 'records', SOUND_KEY = KEY + 'sound', SETUP_KEY = KEY + 'setup';
  var TABS = [['map', 'Map'], ['market', 'Market'], ['yard', 'Yard'], ['office', 'Office'], ['news', 'News']];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.spacetrader = { live: function () { return S; } };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function sjson(k) { var raw = sget(k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function loadGame() { return normGame(sjson(SAVE_KEY)); }
  function persist() {
    if (!S || !S.G) return;
    if (S.G.over) sdel(SAVE_KEY);
    else sset(SAVE_KEY, JSON.stringify(toSave(S.G)));
  }
  function saveRec() { if (S) sset(REC_KEY, JSON.stringify(S.R)); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s.length > n ? s.slice(0, n) : s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
  function bar(v, max, n) {
    var k = max > 0 ? Math.round(clamp(v / max, 0, 1) * n) : 0, s = '';
    for (var i = 0; i < n; i++) s += i < k ? '#' : '-';
    return s;
  }
  function toast(msg, type) { if (Cade.showToast) Cade.showToast(msg, type || 'info', 2000); }
  function haptic(ms) { try { if (Cade.haptic) Cade.haptic(ms); } catch (e) {} }

  // ---- sound: a tiny WebAudio voice, created on a user gesture, off by default ----
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
  function sfx(k) {
    if (!S) return;
    var s = S.snd;
    if (k === 'buy') { s.tone(520, 0.05, 'square', 0.025); s.tone(700, 0.06, 'square', 0.02, 0, 0.04); }
    else if (k === 'sell' || k === 'coin') { s.tone(988, 0.05, 'square', 0.025); s.tone(1319, 0.1, 'square', 0.022, 0, 0.05); }
    else if (k === 'warp') { s.tone(180, 0.55, 'sawtooth', 0.03, 1400); s.tone(90, 0.6, 'sine', 0.04, 600, 0.05); }
    else if (k === 'zap') s.tone(1600, 0.14, 'square', 0.03, 300);
    else if (k === 'hurt') { s.tone(140, 0.2, 'sawtooth', 0.05, 60); haptic(30); }
    else if (k === 'boom') { s.tone(220, 0.5, 'sawtooth', 0.05, 40); s.tone(90, 0.6, 'square', 0.03, 30, 0.05); haptic(60); }
    else if (k === 'alarm') { s.tone(660, 0.12, 'square', 0.03); s.tone(520, 0.14, 'square', 0.03, 0, 0.14); }
    else if (k === 'err') s.tone(150, 0.12, 'square', 0.03);
    else if (k === 'click') s.tone(880, 0.03, 'sine', 0.02);
    else if (k === 'dock') { s.tone(392, 0.08, 'sine', 0.04); s.tone(523, 0.12, 'sine', 0.04, 0, 0.08); }
    else if (k === 'win') { [523, 659, 784, 1047, 1319].forEach(function (f, i) { s.tone(f, 0.18, 'square', 0.03, 0, i * 0.11); }); }
    else if (k === 'lose') { [392, 330, 262, 196].forEach(function (f, i) { s.tone(f, 0.22, 'triangle', 0.04, 0, i * 0.16); }); }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MENU = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

  // ---- helpers over the live game ----
  function G() { return S.G; }
  function me() { return S.G.players[S.G.turn]; }
  function sysName(i) { return S.G.sys[i] ? S.G.sys[i].name : '?'; }
  function rivalIdx() { var g = S.G; if (g.mode === 'solo') return -1; return g.turn === 0 ? 1 : 0; }
  function govOf(i) { return GOVS[S.G.sys[i].gov]; }
  function sysLine(i) {
    var s = S.G.sys[i], sp = SPECS[s.spec];
    return 'Tech ' + s.tl + ' ' + TECH[s.tl] + ' \u00b7 ' + GOVS[s.gov].name + (sp.name ? ' \u00b7 ' + sp.name : '');
  }
  function evText(i) { var e = S.G.ev[i]; return e ? EVENTS[e.e].t.replace('%s', sysName(i)) : ''; }
  function evGoods(i) {
    var e = S.G.ev[i];
    if (!e) return '';
    var m = EVENTS[e.e].mods, out = [];
    for (var k in m) out.push(GOODS[GI[k]].name + (m[k] > 1 ? ' \u25b2' : ' \u25bc'));
    return out.join(', ');
  }
  function missionAt(i) { var p = me(); for (var k = 0; k < p.missions.length; k++) if (p.missions[k].to === i) return p.missions[k]; return null; }
  // cheap / dear marker vs the galactic average
  function trend(mid, gi) {
    var r = mid / avgPrice(S.G, gi);
    if (r < 0.82) return '<i class="st-lo">\u25bc\u25bc</i>';
    if (r < 0.94) return '<i class="st-lo">\u25bc </i>';
    if (r > 1.18) return '<i class="st-hi">\u25b2\u25b2</i>';
    if (r > 1.06) return '<i class="st-hi">\u25b2 </i>';
    return '<i>  </i>';
  }

  // ================= rendering =================
  function render() {
    if (!S || !S.G) return;
    if (S.tab === 'news') S.newsSeen = newsCount();
    renderBar();
    var tb = '';
    for (var k = 0; k < TABS.length; k++) {
      var t = TABS[k], badge = t[0] === 'news' && S.newsSeen < newsCount() ? '<b class="st-dot"></b>' : '';
      tb += '<button type="button" data-a="tab:' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-pressed="' + (S.tab === t[0]) + '">' +
        '<span class="st-k">' + (k + 1) + '</span>' + t[1] + badge + '</button>';
    }
    S.tabsEl.innerHTML = tb;
    var keep = S.lastTab === S.tab ? S.view.scrollTop : 0;
    var h = S.tab === 'map' ? viewMap() : S.tab === 'market' ? viewMarket() : S.tab === 'yard' ? viewYard() : S.tab === 'office' ? viewOffice() : viewNews();
    S.view.innerHTML = h;
    S.view.scrollTop = keep;
    S.lastTab = S.tab;
    if (S.tab === 'map') fitMap();
  }
  function newsCount() { var g = S.G; return g.news.length ? g.news[0].d * 100 + g.news.length : 0; }
  function renderBar() {
    var g = S.G, p = me(), sh = p.ship, r = rivalIdx(), cap = cargoCap(sh), used = cargoCount(p);
    var h = '';
    if (g.mode === 'duo') h += '<div class="st-who"><span>Captain</span><b>' + esc(p.name) + '</b></div>';
    h += stat('cr', 'Credits', fmt(p.cr), p.debt ? 'debt ' + fmt(p.debt) : '');
    h += stat('day', 'Day', g.day, '');
    h += stat('fuel', 'Fuel', sh.fuel + '/' + rangeOf(sh), '', sh.fuel < 4 ? 'warn' : '');
    h += stat('hull', 'Hull', sh.hull + '/' + hullMax(sh), shieldMax(sh) ? 'shield ' + shieldMax(sh) : '', sh.hull < hullMax(sh) * 0.4 ? 'warn' : '');
    h += stat('hold', 'Hold', used + '/' + cap, '', used >= cap ? 'full' : '');
    if (r >= 0) {
      var rp = g.players[r], pct = Math.min(100, Math.max(0, Math.round(worth(g, rp) / moonPrice(g) * 100)));
      h += stat('rival', g.mode === 'cpu' ? 'Rival' : esc(rp.name).slice(0, 8), rp.out ? (rp.moon ? 'moon' : 'out') : pct + '%', '', 'rv');
    }
    S.barEl.innerHTML = h;
    if (S.lastCr != null && S.lastCr !== p.cr && S.lastWho === g.turn) flashCr(p.cr - S.lastCr);
    S.lastCr = p.cr; S.lastWho = g.turn;
  }
  function stat(k, label, val, sub, cls) {
    return '<div class="st-stat ' + (cls || '') + '" data-s="' + k + '"><span>' + label + '</span><b>' + val + '</b>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>';
  }
  function flashCr(d) {
    var el = S.barEl.querySelector('[data-s="cr"]');
    if (!el) return;
    el.classList.remove('up', 'dn'); void el.offsetWidth;
    el.classList.add(d > 0 ? 'up' : 'dn');
    if (S.rm) return;
    var f = document.createElement('i');
    f.className = 'st-float ' + (d > 0 ? 'up' : 'dn');
    f.textContent = (d > 0 ? '+' : '') + fmt(d);
    el.appendChild(f);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 900);
  }

  // ---- the ASCII star map ----
  function mapGrid() {
    var g = S.G, p = me(), cs = COLS, rs = ROWS, ch = [], cl = [], own = [], r, c, k;
    for (r = 0; r < rs; r++) { ch.push([]); cl.push([]); own.push([]); for (c = 0; c < cs; c++) { ch[r].push(' '); cl[r].push(''); own[r].push(-1); } }
    var here = g.sys[p.loc], range = Math.min(rangeOf(p.ship), p.ship.fuel);
    function wd(c2, r2) { var x = c2 * 2 + 1, y = r2 * 4 + 2, dx = x - here.x, dy = y - here.y; return Math.sqrt(dx * dx + dy * dy); }
    // stars, and the reach of a full tank as a ring
    for (r = 0; r < rs; r++) for (c = 0; c < cs; c++) {
      var h = hash2(g.seed ^ (r * 131), c) % 1000;
      if (h < 38) { ch[r][c] = h < 8 ? '+' : '.'; cl[r][c] = 'f'; }
      var inR = wd(c, r) <= range;
      if (inR && (wd(c - 1, r) > range || wd(c + 1, r) > range || wd(c, r - 1) > range || wd(c, r + 1) > range)) { ch[r][c] = '\u00b7'; cl[r][c] = 'rg'; }
    }
    // the course to the selected system
    var sel = S.sel, sc = cellOf(here.x, here.y);
    if (sel != null && sel !== p.loc) {
      var tc = cellOf(g.sys[sel].x, g.sys[sel].y), dx = tc.c - sc.c, dy = tc.r - sc.r, n = Math.max(Math.abs(dx), Math.abs(dy) * 2);
      var ok = !canWarp(g, g.turn, sel);
      for (k = 1; k < n; k++) {
        var cc = Math.round(sc.c + dx * k / n), rr = Math.round(sc.r + dy * k / n);
        ch[rr][cc] = k % 2 ? '-' : '='; cl[rr][cc] = ok ? 'rt' : 'rtx';
      }
    }
    // systems, then their labels where they fit
    var cells = [];
    for (k = 0; k < g.sys.length; k++) {
      var s = g.sys[k], ce = cellOf(s.x, s.y), d = dist(here, s), reach = k === p.loc || fuelNeed(g, p.loc, k) <= range;
      cells.push(ce);
      ch[ce.r][ce.c] = k === p.loc ? '@' : '*';
      cl[ce.r][ce.c] = (k === p.loc ? 'cur' : reach ? 's' : 'so') + (k === sel ? ' sel' : '') + (missionAt(k) ? ' ms' : '');
      own[ce.r][ce.c] = k;
      void d;
    }
    var used = {};
    for (k = 0; k < cells.length; k++) used[cells[k].r + ',' + cells[k].c] = 1;
    function free(r2, c0, len) {
      if (r2 < 0 || r2 >= rs || c0 < 0 || c0 + len > cs) return false;
      for (var q = c0 - 1; q <= c0 + len; q++) if (used[r2 + ',' + q]) return false;
      return true;
    }
    var order = [];
    for (k = 0; k < g.sys.length; k++) order.push(k);
    order.sort(function (a, b) { return (b === p.loc || b === sel ? 1 : 0) - (a === p.loc || a === sel ? 1 : 0); });
    var rv = rivalIdx(), rloc = rv >= 0 && !g.players[rv].out ? g.players[rv].loc : -1;
    for (var o = 0; o < order.length; o++) {
      k = order[o];
      var nm = g.sys[k].name, ce2 = cells[k], tag = '';
      if (g.ev[k]) tag += '!';
      if (missionAt(k)) tag += '$';
      if (k === rloc) tag += ' ' + (g.mode === 'cpu' ? 'R' : String(rv + 1));
      var lab = nm + tag, spots = [[ce2.r, ce2.c + 2], [ce2.r, ce2.c - lab.length - 1], [ce2.r - 1, ce2.c - (lab.length >> 1)], [ce2.r + 1, ce2.c - (lab.length >> 1)]];
      for (var sIdx = 0; sIdx < spots.length; sIdx++) {
        var R0 = spots[sIdx][0], C0 = spots[sIdx][1];
        if (!free(R0, C0, lab.length)) continue;
        var reach2 = k === p.loc || fuelNeed(g, p.loc, k) <= range;
        for (var q = 0; q < lab.length; q++) {
          var chq = lab.charAt(q), isTag = q >= nm.length;
          ch[R0][C0 + q] = chq;
          cl[R0][C0 + q] = isTag ? (chq === '!' ? 'ev' : chq === '$' ? 'ms' : chq === ' ' ? '' : 'rv') : (k === sel ? 'lbs' : reach2 ? 'lbi' : 'lb');
          own[R0][C0 + q] = k;
          used[R0 + ',' + (C0 + q)] = 1;
        }
        break;
      }
    }
    return { ch: ch, cl: cl, own: own };
  }
  function viewMap() {
    var m = mapGrid(), h = '';
    S.own = m.own;
    for (var r = 0; r < ROWS; r++) {
      var run = '', rc = null;
      for (var c = 0; c < COLS; c++) {
        var k = m.cl[r][c];
        if (k !== rc) { if (run) h += rc ? '<span class="' + rc + '">' + esc(run) + '</span>' : esc(run); run = ''; rc = k; }
        run += m.ch[r][c];
      }
      if (run) h += rc ? '<span class="' + rc + '">' + esc(run) + '</span>' : esc(run);
      if (r < ROWS - 1) h += '\n';
    }
    return '<div class="st-mapwrap"><pre class="st-map" role="img" aria-label="Star map">' + h + '</pre></div>' +
      '<div class="st-legend"><span class="cur">@</span> you <span class="s">*</span> in reach <span class="so">*</span> too far <span class="rg">\u00b7</span> fuel ring <span class="ev">!</span> news <span class="ms">$</span> mission' +
      (rivalIdx() >= 0 ? ' <span class="rv">' + (S.G.mode === 'cpu' ? 'R' : rivalIdx() + 1) + '</span> ' + (S.G.mode === 'cpu' ? 'rival' : 'captain ' + (rivalIdx() + 1)) : '') + '</div>' +
      sysInfo(S.sel == null ? me().loc : S.sel);
  }
  function sysInfo(i) {
    var g = S.G, p = me(), s = g.sys[i], here = i === p.loc, h = '<div class="st-info">';
    var d = dist(g.sys[p.loc], s), need = fuelNeed(g, p.loc, i);
    h += '<div class="st-ih"><b>' + esc(s.name) + '</b>' + (here ? '<span class="st-tag">you are here</span>' : '<span>' + d.toFixed(1) + ' pc \u00b7 ' + need + ' fuel</span>') + '</div>';
    h += '<div class="st-sub">' + esc(sysLine(i)) + '</div>';
    if (g.ev[i]) h += '<div class="st-evl">! ' + esc(evText(i)) + ' <i>(' + esc(evGoods(i)) + ')</i></div>';
    var ms = missionAt(i);
    if (ms) h += '<div class="st-msl">$ ' + esc(missionTitle(g, ms)) + ' \u00b7 by day ' + ms.due + '</div>';
    var rv = rivalIdx();
    if (rv >= 0 && !g.players[rv].out && g.players[rv].loc === i) h += '<div class="st-sub">' + esc(g.players[rv].name) + ' is docked here.</div>';
    if (!here) {
      // what sells there, against what it costs here (or what you paid)
      var rows = [];
      for (var gi = 0; gi < GOODS.length; gi++) {
        var qt = quote(g, i, gi);
        if (!qt) continue;
        var qh = produced(g, p.loc, gi) ? quote(g, p.loc, gi) : null, base = null, why = '';
        if (p.cargo[gi]) { base = Math.round(p.paid[gi] / p.cargo[gi]); why = 'paid'; }
        else if (qh && qh.avail > 0) { base = qh.buy; why = 'here'; }
        rows.push({ gi: gi, sell: qt.sell, diff: base == null ? null : qt.sell - base, why: why });
      }
      rows.sort(function (a, b) { return (b.diff == null ? -1e9 : b.diff) - (a.diff == null ? -1e9 : a.diff); });
      h += '<div class="st-h">Sell prices there <i>vs buying here</i></div><div class="st-tab">';
      var shown = 0;
      for (var k = 0; k < rows.length && shown < 6; k++) {
        var rw = rows[k];
        if (rw.diff == null && shown >= 4) continue;
        h += '<div>' + esc(pad(GOODS[rw.gi].name, 9)) + lpad(fmt(rw.sell), 6) + '  ' +
          (rw.diff == null ? '<i>   \u2014</i>' : '<b class="' + (rw.diff > 0 ? 'st-up' : 'st-dn') + '">' + lpad((rw.diff > 0 ? '+' : '') + fmt(rw.diff), 6) + '</b>' + (rw.why === 'paid' ? '<i> held</i>' : '')) + '</div>';
        shown++;
      }
      if (!shown) h += '<i>no market for anything you could bring</i>';
      h += '</div>';
      var why = canWarp(g, g.turn, i);
      h += '<button type="button" class="st-go st-warp" data-a="warp"' + (why ? ' aria-disabled="true"' : '') + '>' +
        (why ? (why === 'out of range' ? 'Too far for your tank (' + rangeOf(p.ship) + ' pc)' : why === 'not enough fuel' ? 'Not enough fuel \u2014 refuel at the Yard' : why) : 'Warp to ' + esc(s.name) + ' \u25b8') + '</button>';
    } else {
      h += '<div class="st-note">Tap a star to plot a course (double-click it to warp). Prices and goods here: Market. Fuel, repairs and ships: Yard.</div>';
    }
    h += '<button type="button" class="st-go alt st-wait" data-a="wait">Wait a day at ' + esc(sysName(p.loc)) + ' <small>markets recover' + (S.coarse ? '' : ' \u00b7 W') + '</small></button>';
    return h + '</div>';
  }
  function fitMap() {
    var pre = S.view.querySelector('.st-map'), wrap = S.view.querySelector('.st-mapwrap');
    if (!pre || !wrap) return;
    var w = wrap.clientWidth - 2;
    if (!S.charR) {
      var probe = document.createElement('span');
      probe.className = 'st-probe';
      probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
      wrap.appendChild(probe);
      S.charR = probe.getBoundingClientRect().width / 20 / 20 || 0.6;
      wrap.removeChild(probe);
    }
    var fs = Math.max(6, Math.min(17, Math.floor(w / (COLS * S.charR) * 10) / 10));
    pre.style.fontSize = fs + 'px';
    S.cw = fs * S.charR; S.lh = Math.round(fs * 1.18 * 100) / 100;
    pre.style.lineHeight = S.lh + 'px';
  }
  function mapTap(e) {
    var pre = e.currentTarget, rc = pre.getBoundingClientRect();
    var col = Math.floor((e.clientX - rc.left) / (S.cw || 8)), row = Math.floor((e.clientY - rc.top) / (S.lh || 14));
    var hit = -1, direct = false;
    if (S.own && S.own[row] && S.own[row][col] != null && S.own[row][col] >= 0) { hit = S.own[row][col]; direct = true; }
    if (hit < 0) {
      var best = 1e9;
      for (var k = 0; k < S.G.sys.length; k++) {
        var ce = cellOf(S.G.sys[k].x, S.G.sys[k].y), dd = Math.pow(ce.c - col, 2) + Math.pow((ce.r - row) * 2, 2);
        if (dd < best) { best = dd; hit = k; }
      }
      if (best > 30) hit = -1;
    }
    if (hit < 0) return;
    if (hit === S.sel && hit !== me().loc && e.detail === 2) {
      if (direct && !canWarp(S.G, S.G.turn, hit)) doWarp();
      return;
    }
    S.sel = hit;
    sfx('click');
    render();
  }

  // ---- the market ----
  function viewMarket() {
    var g = S.G, p = me(), si = p.loc, h = '<div class="st-mkt">';
    h += '<div class="st-ih"><b>' + esc(sysName(si)) + ' market</b><span>' + esc(GOVS[g.sys[si].gov].name) + ' \u00b7 tech ' + g.sys[si].tl + '</span></div>';
    if (g.ev[si]) h += '<div class="st-evl">! ' + esc(evText(si)) + '</div>';
    h += '<div class="st-row st-rh"><span>Good</span><span>Buy</span><span>Sell</span><span>Stock</span><span>Hold</span></div>';
    for (var gi = 0; gi < GOODS.length; gi++) {
      var q = quote(g, si, gi), gd = GOODS[gi], on = S.mg === gi;
      var canB = q && produced(g, si, gi) || (q && q.avail > 0);
      h += '<button type="button" class="st-row' + (on ? ' on' : '') + (q ? '' : ' none') + '" data-a="mg:' + gi + '">' +
        '<span>' + esc(gd.name) + (gd.illegal ? '<i class="st-ill">\u2620</i>' : '') + '</span>' +
        '<span>' + (q && canB && q.avail > 0 ? fmt(q.buy) : '\u2014') + '</span>' +
        '<span>' + (q ? fmt(q.sell) + trend(q.mid, gi) : '<i>no market</i>') + '</span>' +
        '<span>' + (q && canB ? q.avail : '\u2014') + '</span>' +
        '<span class="' + (p.cargo[gi] ? 'st-have' : '') + '">' + (p.cargo[gi] || '\u00b7') + '</span></button>';
    }
    h += '</div>';
    // the action bar for the selected good
    var mg = S.mg, q2 = quote(g, si, mg), gd2 = GOODS[mg], mb = maxBuy(g, g.turn, mg), held = p.cargo[mg];
    h += '<div class="st-act"><div class="st-actl"><b>' + esc(gd2.name) + '</b> ';
    if (held) h += 'you hold ' + held + ' (paid ~' + fmt(p.paid[mg] / held) + ') ';
    var best = bestNearby(mg);
    if (best) h += '\u00b7 best in reach: ' + esc(sysName(best.si)) + ' ' + fmt(best.sell);
    if (gd2.illegal) h += ' \u00b7 <span class="st-hi">contraband \u2014 police seize it</span>';
    h += '</div><div class="st-btns">';
    h += abtn('sellall', 'Sell all', !(q2 && held), held && q2 ? fmt(sellValue(g, si, mg, held)) : '');
    h += abtn('sell1', 'Sell 1', !(q2 && held), q2 ? fmt(q2.sell) : '');
    h += abtn('buy1', 'Buy 1', mb < 1, q2 ? fmt(q2.buy) : '');
    h += abtn('buymax', 'Buy ' + (mb > 1 ? mb : 'max'), mb < 1, mb ? '' : (!q2 ? 'no market' : freeSpace(p) < 1 ? 'hold full' : (q2.avail < 1 ? 'no stock' : 'no cash')));
    h += '</div><div class="st-note">Keys: \u2191\u2193 pick \u00b7 B buy \u00b7 Shift+B max \u00b7 S sell \u00b7 Shift+S all</div></div>';
    return h;
  }
  function abtn(a, label, dis, sub) {
    return '<button type="button" class="st-b" data-a="' + a + '"' + (dis ? ' aria-disabled="true"' : '') + '>' + label + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
  }
  function bestNearby(gi) {
    var g = S.G, p = me(), best = null, nb = neighbours(g.sys, p.loc, rangeOf(p.ship));
    for (var k = 0; k < nb.length; k++) { var q = quote(g, nb[k], gi); if (q && (!best || q.sell > best.sell)) best = { si: nb[k], sell: q.sell }; }
    return best;
  }

  // ---- the yard ----
  function viewYard() {
    var g = S.G, p = me(), sh = p.ship, T = SHIPS[sh.t], tl = g.sys[p.loc].tl, h = '<div class="st-yard">', k;
    var fp = fuelPrice(g, p), rp = repairPrice(g, p), fneed = rangeOf(sh) - sh.fuel, hneed = hullMax(sh) - sh.hull;
    h += '<div class="st-ih"><b>' + esc(sysName(p.loc)) + ' yard</b><span>tech ' + tl + ' \u00b7 ' + esc(TECH[tl]) + '</span></div>';
    h += '<div class="st-sec"><div class="st-h">Service</div>';
    h += line('Fuel ' + sh.fuel + '/' + rangeOf(sh) + ' <i>' + fp + ' cr/pc</i>', btn('fuel', fneed ? 'Fill up ' + fmt(fneed * fp) : 'Full', !fneed || p.cr < fp) + btn('fuel1', '+1', !fneed || p.cr < fp));
    h += line('Hull ' + sh.hull + '/' + hullMax(sh) + ' <i>' + rp + ' cr/pt</i>', btn('repair', hneed ? 'Repair ' + fmt(hneed * rp) : 'Sound', !hneed || p.cr < rp));
    h += '</div>';
    // your ship
    h += '<div class="st-sec"><div class="st-h">Your ' + esc(T.name) + '</div>';
    h += '<pre class="st-art">' + esc(T.art.join('\n')) + '</pre>';
    h += '<div class="st-sub">' + cargoCap(sh) + ' bays \u00b7 hull ' + T.hull + ' \u00b7 range ' + rangeOf(sh) + ' pc \u00b7 ' + firepower(sh) + ' firepower \u00b7 ' + shieldMax(sh) + ' shields</div>';
    var inst = '';
    ['w', 's', 'g'].forEach(function (cat) {
      var L = sh[cat], max = T[cat];
      for (var i = 0; i < max; i++) {
        var id = L[i], it = id ? itemById(cat, id) : null;
        inst += line((cat === 'w' ? 'Weapon ' : cat === 's' ? 'Shield ' : 'Gadget ') + (i + 1) + ': ' + (it ? '<b>' + esc(it.name) + '</b>' : '<i>empty</i>'),
          it ? btn('sq:' + cat + ':' + i, 'Sell ' + fmt(Math.round(it.price * 0.6)), false) : '');
      }
    });
    inst += line('Drive: <b>' + esc(ENGINES[sh.eng].name) + '</b>', sh.eng < ENGINES.length - 1 ? btn('eng', 'Upgrade ' + fmt(ENGINES[sh.eng + 1].price), !!engineNext(g, p), engineNext(g, p)) : '<i>best drive</i>');
    inst += line('Escape pod: ' + (sh.pod ? '<b>fitted</b>' : '<i>none</i>'), sh.pod ? '' : btn('pod', 'Fit ' + fmt(POD_PRICE), p.cr < POD_PRICE));
    h += inst + '</div>';
    // equipment for sale
    h += '<div class="st-sec"><div class="st-h">Equipment</div>';
    [['w', WEAPONS, function (it) { return it.dmg + ' dmg'; }], ['s', SHIELDS, function (it) { return it.pts + ' pts'; }], ['g', GADGETS, function (it) { return it.info; }]].forEach(function (grp) {
      grp[1].forEach(function (it) {
        var why = canEquip(g, p, grp[0], it.id);
        if (tl < it.tl) return;
        h += line(esc(it.name) + ' <i>' + esc(grp[2](it)) + '</i>', btn('eq:' + grp[0] + ':' + it.id, fmt(it.price), !!why, why));
      });
    });
    var lockedEq = WEAPONS.concat(SHIELDS, GADGETS).filter(function (it) { return it.tl > tl; }).length;
    if (lockedEq) h += '<div class="st-note">' + lockedEq + ' more items at higher-tech yards.</div>';
    h += '</div>';
    // hulls
    h += '<div class="st-sec"><div class="st-h">Ships <i>trade-in ' + fmt(tradeIn(sh)) + '</i></div>';
    for (k = 0; k < SHIPS.length; k++) {
      var S2 = SHIPS[k];
      if (k === sh.t) continue;
      var deal = shipDeal(g, p, k);
      h += '<div class="st-ship"><pre class="st-art sm">' + esc(S2.art.join('\n')) + '</pre><div class="st-shipt"><b>' + esc(S2.name) + '</b> <i>' + fmt(S2.price) + '</i><br>' +
        S2.cargo + ' bays \u00b7 hull ' + S2.hull + ' \u00b7 ' + S2.range + ' pc \u00b7 slots ' + S2.w + 'w ' + S2.s + 's ' + S2.g + 'g' + '</div>' +
        btn('ship:' + k, deal.why === 'needs tech ' + S2.tl ? 'Tech ' + S2.tl : (deal.net >= 0 ? fmt(deal.net) : '+' + fmt(-deal.net)), !!deal.why, deal.why) + '</div>';
    }
    h += '</div></div>';
    return h;
  }
  function line(l, r) { return '<div class="st-line"><span>' + l + '</span><span class="st-r">' + r + '</span></div>'; }
  function btn(a, label, dis, why) {
    return '<button type="button" class="st-sb" data-a="' + a + '"' + (dis ? ' aria-disabled="true"' : '') + (why ? ' title="' + esc(why) + '" data-why="' + esc(why) + '"' : '') + '>' + label + '</button>';
  }

  // ---- the office: captain, goal, missions, bank ----
  function viewOffice() {
    var g = S.G, p = me(), w = worth(g, p), mp = moonPrice(g), h = '<div class="st-office">';
    h += '<div class="st-sec"><div class="st-h">' + (/^captain/i.test(p.name) ? '' : 'Captain ') + esc(p.name) + '</div>';
    h += '<div class="st-tab"><div>Net worth  <b>' + fmt(w) + ' cr</b></div><div>Record     <b>' + recordName(p.rec) + '</b> <i>(' + p.rec + ')</i></div>' +
      '<div>Reputation <b>' + fameName(p.fame) + '</b> <i>' + p.kills + ' kills</i></div><div>Trading    <b>' + fmt(p.st.profit) + '</b> <i>profit over ' + p.st.jumps + ' jumps</i></div></div>';
    h += '</div>';
    h += '<div class="st-sec"><div class="st-h">The goal</div>';
    h += '<div class="st-sub">Buy a moon of your own: <b>' + fmt(mp) + ' cr</b> cash, debt-free, at a tech 6+ world.</div>';
    h += '<pre class="st-prog">[' + bar(Math.max(0, p.cr - p.debt), mp, 24) + '] ' + Math.max(0, Math.min(100, Math.floor((p.cr - p.debt) / mp * 100))) + '%</pre>';
    var rv = rivalIdx();
    if (rv >= 0) { var rp = g.players[rv]; h += '<pre class="st-prog rv">[' + bar(worth(g, rp), mp, 24) + '] ' + esc(rp.name) + (rp.out ? ' (out)' : '') + '</pre>'; }
    var cm = canMoon(g, p);
    h += '<button type="button" class="st-go' + (cm ? ' alt' : '') + '" data-a="moon"' + (cm ? ' aria-disabled="true"' : '') + '>' + (cm ? 'Moon: ' + esc(cm) : '\u263e Buy the moon \u2014 ' + fmt(mp)) + '</button>';
    h += '</div>';
    // missions
    h += '<div class="st-sec"><div class="st-h">Missions <i>' + p.missions.length + '/' + MAX_MISSIONS + '</i></div>';
    if (!p.missions.length) h += '<div class="st-note">No active missions.</div>';
    p.missions.forEach(function (m, i) {
      h += line('<b>' + esc(missionTitle(g, m)) + '</b><br><i>' + fmt(m.pay) + ' cr \u00b7 by day ' + m.due + ' \u00b7 ' + dist(g.sys[p.loc], g.sys[m.to]).toFixed(0) + ' pc away</i>', btn('abn:' + i, 'Drop', false));
    });
    var B = board(g, p.loc, g.turn);
    h += '<div class="st-h sm">Board at ' + esc(sysName(p.loc)) + '</div>';
    if (!B.length) h += '<div class="st-note">Nothing posted. Check back in a few days.</div>';
    B.forEach(function (m) {
      var info = m.k === 'courier' ? 'a sealed parcel, no cargo space' : m.k === 'contract' ? 'bring the goods in your hold' : 'tier ' + (m.tier + 1) + ' pirate waits there';
      h += line('<b>' + esc(missionTitle(g, m)) + '</b><br><i>' + fmt(m.pay) + ' cr \u00b7 by day ' + m.due + ' \u00b7 ' + info + '</i>',
        btn('acc:' + m.id, 'Accept', p.missions.length >= MAX_MISSIONS, p.missions.length >= MAX_MISSIONS ? 'mission log full' : ''));
    });
    h += '</div>';
    // bank
    var lim = maxLoan(g, p), room = Math.max(0, lim - p.debt);
    h += '<div class="st-sec"><div class="st-h">Bank <i>' + (DIFFS[g.diff].rate * 100).toFixed(1) + '% a day</i></div>';
    h += line('Debt <b>' + fmt(p.debt) + '</b> <i>limit ' + fmt(lim) + '</i>', btn('borrow', 'Borrow ' + fmt(Math.min(1000, room)), room < 1) + btn('borrowmax', 'Max', room < 1));
    h += line('Repay', btn('repay', p.debt ? 'Repay ' + fmt(Math.min(1000, p.debt, p.cr)) : 'No debt', !p.debt || p.cr < 1) + btn('repayall', 'All', !p.debt || p.cr < 1));
    h += '</div>';
    h += '<div class="st-foot"><button type="button" class="st-lnk" data-a="retire">' + (g.mode === 'solo' ? 'Retire now (score ' + fmt(score(g, p)) + ')' : 'Concede the race') + '</button>' +
      '<button type="button" class="st-lnk" data-a="quit">Save &amp; quit to title</button></div>';
    return h + '</div>';
  }

  function viewNews() {
    var g = S.G, h = '<div class="st-news"><div class="st-ih"><b>Galactic news</b><span>day ' + g.day + '</span></div>';
    var act = [];
    for (var k = 0; k < g.ev.length; k++) if (g.ev[k]) act.push(k);
    if (act.length) {
      h += '<div class="st-h">Now</div>';
      act.forEach(function (k2) {
        h += '<button type="button" class="st-nw ev" data-a="go:' + k2 + '"><b>! ' + esc(evText(k2)) + '</b><i>' + esc(evGoods(k2)) + ' \u00b7 ' + Math.max(0, g.ev[k2].until - g.day + 1) + ' days left \u00b7 ' + dist(g.sys[me().loc], g.sys[k2]).toFixed(0) + ' pc</i></button>';
      });
    }
    h += '<div class="st-h">Wire</div>';
    g.news.forEach(function (n) {
      h += '<div class="st-nw ' + esc(n.k) + '"><span>D' + n.d + '</span> ' + esc(n.t) + '</div>';
    });
    return h + '</div>';
  }

  // ================= overlay cards =================
  function showCard(kind, html) {
    S.card = kind;
    S.ovl.innerHTML = '<div class="st-card st-c-' + kind + '">' + html + '</div>';
    S.ovl.style.display = '';
    S.root.classList.add('dim');
    S.ovl.scrollTop = 0;
    var first = S.ovl.querySelector('.st-go:not([aria-disabled])');
    if (first && !S.coarse) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }
  function hideCard() {
    S.card = null;
    S.ovl.style.display = 'none';
    S.ovl.innerHTML = '';
    S.root.classList.remove('dim');
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }
  var LOGO = [
    '   .     *      .     +     .',
    ' ___________________________ ',
    '|                           |',
    '|  S  P  A  C  E     _/\\_  |',
    '|  T  R  A  D  E  R  <==>   |',
    '|___________________________|',
    '      *     .      .    *    '
].join('\n');
  function cardTitle() {
    var sv = loadGame(), h = '<pre class="st-logo">' + esc(LOGO) + '</pre>';
    h += '<p class="st-sub">Buy low, sell high across the stars. Dodge pirates, charm the police, run contracts \u2014 and buy yourself a moon.</p>';
    if (sv && !sv.over) {
      var p = sv.players[0];
      h += '<button type="button" class="st-go" data-a="cont">Continue \u2014 day ' + sv.day + ' \u00b7 ' + esc(DIFFS[sv.diff].name) + (sv.mode === 'cpu' ? ' vs CPU' : sv.mode === 'duo' ? ' \u00b7 2 captains' : '') + '<small>' + esc(p.name) + ' \u00b7 ' + fmt(p.cr) + ' cr at ' + esc(sv.sys[p.loc].name) + '</small></button>';
    }
    h += '<div class="st-btns"><button type="button" class="st-go' + (sv ? ' alt' : '') + '" data-a="setup">New game</button><button type="button" class="st-go alt" data-a="records">Records</button></div>';
    h += '<button type="button" class="st-lnk" data-a="help">How to play</button>';
    showCard('title', h);
  }
  function cardSetup() {
    var su = S.setup, D = DIFFS[su.diff], h = '<div class="st-title">NEW GAME</div>';
    h += '<div class="st-h">Mode</div><div class="st-chips">' +
      chip('mode:solo', 'Solo', su.mode === 'solo') + chip('mode:cpu', 'vs CPU rival', su.mode === 'cpu') + chip('mode:duo', '2 captains', su.mode === 'duo') + '</div>';
    h += '<p class="st-sub">' + (su.mode === 'solo' ? 'Just you and the markets. Retire whenever you like.' :
      su.mode === 'cpu' ? 'A rival trader races you for a moon. Whoever buys one first wins.' : 'Two captains share one device and one galaxy, taking turns jump by jump. First to a moon wins.') + '</p>';
    h += '<div class="st-h">Difficulty</div><div class="st-chips">';
    for (var k = 0; k < DIFFS.length; k++) h += chip('diff:' + k, DIFFS[k].name, su.diff === k);
    h += '</div><p class="st-sub">Start with <b>' + fmt(D.cash) + ' cr</b>; the moon costs <b>' + fmt(D.moon) + ' cr</b>; loans cost ' + (D.rate * 100).toFixed(1) + '% a day; pirates ' + (D.pir < 1 ? 'are scarce' : D.pir > 1 ? 'swarm' : 'are about') + '.' +
      (su.mode === 'cpu' ? ' The rival is ' + (k = su.diff, k === 0 ? 'slow and careless' : k === 1 ? 'a sharp trader' : 'ruthlessly efficient') + '.' : '') + ' Score \u00d7' + D.mul + '.</p>';
    h += '<div class="st-h">Name' + (su.mode === 'duo' ? 's' : '') + '</div><div class="st-names">' +
      '<input type="text" class="st-in" data-n="0" maxlength="16" placeholder="' + (su.mode === 'duo' ? 'Captain 1' : 'Captain') + '" value="' + esc(su.names[0] || '') + '" autocomplete="off" spellcheck="false">' +
      (su.mode === 'duo' ? '<input type="text" class="st-in" data-n="1" maxlength="16" placeholder="Captain 2" value="' + esc(su.names[1] || '') + '" autocomplete="off" spellcheck="false">' : '') + '</div>';
    if (loadGame()) h += '<p class="st-note">Launching replaces your saved game.</p>';
    h += '<div class="st-btns"><button type="button" class="st-go alt" data-a="title">Back</button><button type="button" class="st-go" data-a="launch">Launch \u25b8</button></div>';
    showCard('setup', h);
  }
  function chip(a, label, on) { return '<button type="button" class="st-chip' + (on ? ' on' : '') + '" data-a="' + a + '" aria-pressed="' + !!on + '">' + label + '</button>'; }
  function cardHelp() {
    var h = '<div class="st-title">HOW TO PLAY</div>';
    h += '<p><b>Trade.</b> Each world sets prices by its tech level, government, specialty and the news. Raw goods (water, hides, grain, ore) are cheap on primitive worlds and dear on advanced ones; manufactured goods (medicine, machines, robots) the other way round. \u25bc marks a price below the galactic average, \u25b2 above.</p>';
    h += '<p><b>Supply &amp; demand.</b> Every unit you buy raises the price and drains the stock; every unit you sell lowers it. Markets recover over a few days, so spread big cargoes over several goods and worlds.</p>';
    h += '<p><b>Travel.</b> On the Map, tap a star to see what sells there, then Warp. A jump costs fuel (one unit per parsec) and a day. The dotted ring is how far your fuel reaches.</p>';
    h += '<p><b>Encounters.</b> Pirates attack (fight, flee or surrender your cargo). Police inspect (submit, bribe, flee or fight \u2014 contraband \u2620 is seized and fined). Traders offer deals. Fleeing or attacking the law hurts your record; a Wanted captain is shot on sight.</p>';
    h += '<p><b>Yard.</b> Refuel, repair, buy weapons, shields, gadgets, a faster drive, an escape pod (survive a lost fight) and bigger ships. Higher-tech yards sell better kit.</p>';
    h += '<p><b>Office.</b> Missions (courier runs, supply contracts, pirate bounties), the bank (loans against your worth, daily interest) and the goal.</p>';
    h += '<p><b>Win.</b> Buy a moon at a tech 6+ world, debt-free. Faster wins score more. In Solo you may retire any time for a smaller score; in a race you may concede. Stuck for fuel or cash? Wait a day (W) and borrow from the bank.</p>';
    h += '<div class="st-keys"><b>Keys</b><span>1\u20135 tabs \u00b7 arrows pick a star / good \u00b7 Enter warp \u00b7 W wait a day \u00b7 B / S buy / sell (Shift = max / all) \u00b7 in a fight: A attack, F flee, S surrender, B bribe</span></div>';
    h += '<button type="button" class="st-go" data-a="close">Got it</button>';
    showCard('help', h);
  }
  function cardRecords() {
    var R = S.R, h = '<div class="st-title">RECORDS</div><p class="st-sub">' + R.games + ' games \u00b7 ' + R.wins + ' moons bought</p>';
    if (!R.best.length) h += '<p class="st-note">No finished games yet.</p>';
    else {
      h += '<div class="st-tab">';
      R.best.forEach(function (b, i) {
        h += '<div' + (i === S.lastRank ? ' class="g"' : '') + '>' + lpad(i + 1, 2) + '. <b>' + lpad(fmt(b.score), 7) + '</b> ' + esc(pad(b.name, 10)) + ' <i>' + esc(DIFFS[b.diff].name.charAt(0)) + ' ' + (b.mode === 'cpu' ? 'vsCPU' : b.mode === 'duo' ? '2P   ' : 'solo ') + ' d' + b.day + ' ' + esc(b.how) + '</i></div>';
      });
      h += '</div>';
    }
    h += '<button type="button" class="st-go" data-a="' + (S.G && !S.G.over ? 'close' : 'title') + '">Back</button>';
    showCard('records', h);
  }

  // ---- the turn: warp → encounters → arrival → hand-over ----
  function doWarp() {
    var g = S.G, to = S.sel;
    if (to == null || S.card) return;
    var why = canWarp(g, g.turn, to);
    if (why) { sfx('err'); toast(why === 'out of range' ? 'Too far: your tank reaches ' + rangeOf(me().ship) + ' pc' : why === 'not enough fuel' ? 'Not enough fuel \u2014 refuel at the Yard' : why); return; }
    var from = me().loc;
    warp(g, g.turn, to);
    persist();
    sfx('warp');
    travelAnim(from, to, stepTrip);
  }
  function travelAnim(from, to, done) {
    var a = sysName(from), b = sysName(to), N = 22, i = 0;
    function frame() {
      if (!S) return;
      var s = '';
      for (var k = 0; k < N; k++) s += k < i ? '=' : k === i ? '>' : (hash2(k, i) % 4 ? ' ' : '.');
      var pre = S.ovl.querySelector('.st-trv');
      if (pre) pre.textContent = s;
    }
    var h = '<div class="st-title">HYPERSPACE</div><div class="st-route"><b>' + esc(a) + '</b><pre class="st-trv"></pre><b>' + esc(b) + '</b></div><p class="st-note">tap to skip</p>';
    showCard('travel', h);
    var fin = function () { if (!S || S.card !== 'travel') return; clearInterval(S.trvT); S.trvT = 0; done(); };
    S.trvDone = fin;
    if (S.rm) { frame(); S.trvT = setTimeout(fin, 250); return; }
    frame();
    S.trvT = setInterval(function () { i++; frame(); if (i > N) fin(); }, 34);
  }
  function stepTrip() {
    var g = S.G;
    if (!g.trip) { hideCard(); render(); return; }
    var e = nextEnc(g);
    persist();
    if (e) { if (e.kind === 'pirate' || e.kind === 'bounty' || (e.kind === 'police' && e.st === 'fight')) sfx('alarm'); cardEnc(); }
    else finishTrip();
  }
  function mirror(lines) {
    var map = { '<': '>', '>': '<', '/': '\\', '\\': '/', '[': ']', ']': '[', '(': ')', ')': '(', '{': '}', '}': '{' };
    return lines.map(function (l) { var o = ''; for (var k = l.length - 1; k >= 0; k--) { var c = l.charAt(k); o += map[c] || c; } return o; });
  }
  var BOOM = [[' \\|/ ', '--*--', ' /|\\ '], [' . * ', '* . *', ' * . '], ['  .  ', ' .   ', '   . ']];
  function encTitle(e) {
    if (e.kind === 'pirate') return 'PIRATES';
    if (e.kind === 'bounty') return 'BOUNTY';
    if (e.kind === 'police') return e.st === 'hail' ? 'POLICE' : 'POLICE ATTACK';
    if (e.kind === 'trader') return 'TRADER';
    return 'DERELICT';
  }
  function encIntro(e) {
    var p = me(), g = S.G;
    if (e.kind === 'pirate') return 'A ' + esc(e.ship ? SHIPS[e.ship.t].name : '') + ' drops out of hyperspace, guns hot. "Cargo or your life."';
    if (e.kind === 'bounty') return '<b>' + esc(e.name) + '</b> is waiting for you near ' + esc(sysName(g.trip.to)) + '. Destroy the ship to collect the bounty.';
    if (e.kind === 'police') return e.st === 'hail' ? 'The ' + esc(e.name) + ' orders you to stand by for inspection.' + (contraband(p) ? ' <b class="st-hi">You carry contraband.</b>' : '') : 'The ' + esc(e.name) + ' opens fire on a known criminal!';
    if (e.kind === 'trader') {
      var o = e.offer;
      return 'A ' + esc(SHIPS[e.ship.t].name) + ' hails you. ' + (o.sell ? '"I\u2019ll buy your ' + esc(GOODS[o.g].name) + ' at <b>' + fmt(o.price) + '</b> each (' + o.n + ' units)."' : '"' + o.n + ' ' + esc(GOODS[o.g].name) + ' for sale, <b>' + fmt(o.price) + '</b> each."') +
        ' <i>Galactic average ' + fmt(avgPrice(g, o.g)) + '.</i>';
    }
    return 'A wreck tumbles past, cargo pods still sealed. Salvage it?';
  }
  function cardEnc(fx) {
    var g = S.G, T = g.trip, e = T && T.enc, p = me();
    if (!e) { stepTrip(); return; }
    renderBar();
    var h = '<div class="st-title">' + encTitle(e) + '</div><p class="st-sub">' + encIntro(e) + '</p>';
    if (e.ship) {
      var mine = SHIPS[p.ship.t].art, theirs = mirror(SHIPS[e.ship.t].art);
      var boom = e.res === 'won' ? BOOM[0] : null, gone = e.res === 'fled' || e.res === 'escaped' || e.res === 'scared';
      h += '<div class="st-duel' + (fx && fx.indexOf('hurt') >= 0 ? ' hit' : '') + '">';
      h += '<div class="st-side"><span class="st-who2">' + esc(p.name) + '</span><pre class="st-art me">' + esc(mine.join('\n')) + '</pre>' + gauge('hull', p.ship.hull, hullMax(p.ship)) + gauge('shld', p.ship.sh, shieldMax(p.ship)) + '</div>';
      h += '<pre class="st-beam' + (fx && fx.indexOf('zap') >= 0 ? ' zap' : '') + '">' + (fx && fx.indexOf('zap') >= 0 ? '-=-=-=>' : '       ') + '\n' + (fx && fx.indexOf('hurt') >= 0 ? '<=-=-=-' : '       ') + '</pre>';
      h += '<div class="st-side"><span class="st-who2">' + esc(e.name) + '</span><pre class="st-art them' + (boom ? ' boom' : '') + (gone ? ' gone' : '') + '">' + esc((boom || theirs).join('\n')) + '</pre>' + gauge('hull', e.ship.hull, e.hullMax) + gauge('shld', e.ship.sh, shieldMax(e.ship)) + '</div>';
      h += '</div>';
    }
    if (e.log.length) h += '<div class="st-log">' + e.log.slice(-4).map(function (l, i, a) { return '<div' + (i === a.length - 1 ? ' class="new"' : '') + '>&gt; ' + esc(l) + '</div>'; }).join('') + '</div>';
    var acts = encActions(g), keys = { attack: 'a', flee: 'f', surrender: 's', bribe: 'b', submit: 'u', trade: 't', ignore: 'i', salvage: 'v', go: 'Enter' };
    h += '<div class="st-acts">';
    acts.forEach(function (a) {
      var sub = a.a === 'flee' && e.st !== 'done' ? Math.round(fleeChance(g, p, e) * 100) + '%' : a.a === 'attack' && e.ship ? firepower(p.ship) + ' dmg' : '';
      h += '<button type="button" class="st-go' + (a.a === 'go' || a.a === 'attack' || a.a === 'trade' || a.a === 'submit' || a.a === 'salvage' ? '' : ' alt') + '" data-a="enc:' + a.a + '" data-key="' + keys[a.a] + '">' + esc(a.label) + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
    });
    h += '</div>';
    showCard('enc', h);
    if (fx && fx.indexOf('boom') >= 0 && e.res === 'won' && !S.rm) {
      var art = S.ovl.querySelector('.st-art.them'), fi = 0;
      clearInterval(S.boomT);
      S.boomT = setInterval(function () { fi++; if (!art || fi >= BOOM.length) { clearInterval(S.boomT); return; } art.textContent = BOOM[fi].join('\n'); }, 160);
    }
  }
  function gauge(l, v, max) {
    if (!max && l === 'shld') return '<pre class="st-g"><i>shld  none</i></pre>';
    return '<pre class="st-g">' + l + ' [<b class="' + (v < max * 0.35 ? 'lo' : '') + '">' + bar(v, max, 10) + '</b>] ' + v + '</pre>';
  }
  function encAction(a) {
    var g = S.G, T = g.trip;
    if (!T || !T.enc) return;
    var p = g.players[T.pi];
    if (a === 'go') {
      encAct(g, 'go');
      if (p.out === 'dead') {
        arrive(g); checkOver(g);
        persist();
        if (g.over) { showOver(); return; }
        afterTurn();
        return;
      }
      persist();
      stepTrip();
      return;
    }
    var r = encAct(g, a);
    persist();
    r.fx.forEach(function (f) { sfx(f); });
    if (r.fx.indexOf('hurt') >= 0) { S.root.classList.remove('shake'); void S.root.offsetWidth; S.root.classList.add('shake'); }
    if (g.trip && g.trip.enc && g.trip.enc.res === 'dead') sfx('lose');
    cardEnc(r.fx);
  }
  function finishTrip() {
    var g = S.G, p = me(), to = g.trip.to, lines = arrive(g) || [];
    S.sel = p.loc;
    persist();
    renderBar();
    sfx('dock');
    var h = '<div class="st-title">ARRIVED</div><div class="st-ih big"><b>' + esc(sysName(to)) + '</b></div><p class="st-sub">' + esc(sysLine(to)) + '</p>';
    if (lines.length) h += '<div class="st-log">' + lines.map(function (l) { return '<div>&gt; ' + esc(l) + '</div>'; }).join('') + '</div>';
    else h += '<p class="st-note">An uneventful docking.</p>';
    var tip = arrivalTip(to);
    if (tip) h += '<p class="st-tip">' + tip + '</p>';
    h += '<button type="button" class="st-go" data-a="dock" data-key="Enter">Dock \u25b8</button>';
    showCard('arrive', h);
    if (lines.some(function (l) { return /\+\d/.test(l); })) sfx('coin');
  }
  // one useful hint: the best thing to sell here from your hold
  function arrivalTip(si) {
    var g = S.G, p = me(), best = null;
    for (var gi = 0; gi < GOODS.length; gi++) {
      if (!p.cargo[gi]) continue;
      var q = quote(g, si, gi);
      if (!q) continue;
      var d = q.sell - p.paid[gi] / p.cargo[gi];
      if (!best || d > best.d) best = { gi: gi, d: d, sell: q.sell };
    }
    if (!best) return '';
    return 'Your ' + esc(GOODS[best.gi].name) + ' sells here for <b>' + fmt(best.sell) + '</b> (' + (best.d >= 0 ? '+' : '') + fmt(best.d) + ' a unit).';
  }
  function afterTurn() {
    var g = S.G, prev = g.turn, r = endTurn(g);
    persist();
    if (g.over) { showOver(); return; }
    if (r.cpu.length && g.mode === 'cpu') {
      var last = r.cpu[r.cpu.length - 1];
      toast(last, 'info');
    }
    S.sel = me().loc;
    S.mg = firstGood();
    var notes = me().notes.splice(0);
    persist();
    if (g.mode === 'duo' && g.turn !== prev) { cardPass(notes); render(); return; }
    hideCard();
    render();
    notes.forEach(function (n) { toast(n, 'error'); });
  }
  function firstGood() {
    var g = S.G, p = me();
    for (var k = 0; k < GOODS.length; k++) if (p.cargo[k] && hasMarket(g, p.loc, k)) return k;
    for (k = 0; k < GOODS.length; k++) if (produced(g, p.loc, k)) return k;
    return 0;
  }
  function cardPass(notes) {
    var p = me(), h = '<div class="st-title">CAPTAIN ' + (S.G.turn + 1) + '</div>';
    h += '<pre class="st-art big">' + esc(SHIPS[p.ship.t].art.join('\n')) + '</pre>';
    h += '<p class="st-sub">Pass the device to <b>' + esc(p.name) + '</b> \u2014 tap when ready.</p>';
    h += '<p class="st-note">Day ' + S.G.day + ' \u00b7 docked at ' + esc(sysName(p.loc)) + '</p>';
    S.passNotes = notes || [];
    h += '<button type="button" class="st-go" data-a="ready" data-key="Enter">I\u2019m ' + esc(p.name) + ' \u2014 ready</button>';
    showCard('pass', h);
    S.root.classList.add('hide');
  }
  function showOver() {
    var g = S.G, ov = g.over, hum = g.mode === 'duo' ? (ov.winner >= 0 ? ov.winner : 0) : 0, p = g.players[hum];
    if (!g.recorded) { var res = record(S.R, g); g.recorded = true; S.lastRank = res.rank; saveRec(); }
    persist();
    var won = g.mode === 'duo' ? ov.winner >= 0 : ov.winner === 0, title, msg;
    if (ov.why === 'moon' && won) { title = g.mode === 'duo' ? esc(p.name).toUpperCase() + ' WINS' : 'A MOON OF YOUR OWN'; msg = esc(p.name) + ' buys a moon on day ' + ov.day + '. The galaxy will never forget (until next quarter).'; }
    else if (ov.why === 'moon') { title = 'THE RIVAL WINS'; msg = esc(g.players[ov.winner].name) + ' bought a moon on day ' + ov.day + '. Better luck next time.'; }
    else if (ov.why === 'retired') { title = 'RETIRED'; msg = 'You hang up your flight jacket on day ' + ov.day + ' with ' + fmt(worth(g, p)) + ' cr to your name.'; }
    else if (ov.why === 'conceded') { title = 'RACE CONCEDED'; msg = 'You hand the race to ' + esc(g.players[1].name) + ' on day ' + ov.day + ', with ' + fmt(worth(g, p)) + ' cr to your name.'; }
    else if (ov.why === 'last') {
      var lost = g.players[ov.winner === 0 ? 1 : 0];
      title = esc(p.name).toUpperCase() + ' WINS';
      msg = lost.out === 'retired' ? esc(lost.name) + ' conceded the race on day ' + ov.day + '.' : 'The other captain was lost in space. Last ship flying wins.';
    }
    else { title = 'LOST IN SPACE'; msg = 'Your ship was destroyed on day ' + ov.day + '. An escape pod would have saved you.'; }
    var h = '<div class="st-title">' + title + '</div>';
    if (ov.why === 'moon' && won) h += '<pre class="st-moon">' + esc(['   _..._   ', ' .\'  o  \'. ', ':  o    @ :', ':   .  o  :', ' \'. o  _.\' ', '   \'---\'   '].join('\n')) + '</pre>';
    h += '<p class="st-sub">' + msg + '</p>';
    h += '<div class="st-big">' + fmt(score(g, p)) + '</div><div class="st-note">score \u00b7 ' + esc(DIFFS[g.diff].name) + ' \u00d7' + DIFFS[g.diff].mul + '</div>';
    if (S.lastRank === 0) h += '<div class="st-new">NEW BEST SCORE</div>'; else if (S.lastRank > 0) h += '<div class="st-new">#' + (S.lastRank + 1) + ' on your records</div>';
    h += '<div class="st-tab">';
    g.players.forEach(function (x) { h += '<div>' + esc(pad(x.name, 12)) + ' worth <b>' + lpad(fmt(worth(g, x)), 9) + '</b> <i>' + x.st.jumps + ' jumps \u00b7 ' + x.kills + ' kills' + (x.moon ? ' \u00b7 moon' : '') + '</i></div>'; });
    h += '</div>';
    h += '<div class="st-btns"><button type="button" class="st-go alt" data-a="records">Records</button><button type="button" class="st-go" data-a="setup">New game</button></div>';
    showCard('over', h);
    if (won) sfx('win'); else sfx('lose');
  }
  function confirmCard(title, msg, yes) {
    S.onYes = yes;
    showCard('confirm', '<div class="st-title">' + title + '</div><p class="st-sub">' + msg + '</p><div class="st-btns"><button type="button" class="st-go alt" data-a="no">Cancel</button><button type="button" class="st-go" data-a="yes">Yes</button></div>');
  }
  function launch() {
    var su = S.setup;
    S.ovl.querySelectorAll('.st-in').forEach(function (inp) { su.names[+inp.getAttribute('data-n')] = inp.value.trim().slice(0, 16); });
    sset(SETUP_KEY, JSON.stringify(su));
    var names = [su.names[0] || (su.mode === 'duo' ? 'Captain 1' : 'Captain'), su.mode === 'duo' ? (su.names[1] || 'Captain 2') : ''];
    S.G = newGame({ seed: (Math.random() * 4294967295) >>> 0 || 7, mode: su.mode, diff: su.diff, names: names });
    S.tab = 'map'; S.sel = me().loc; S.mg = firstGood(); S.lastCr = null; S.lastRank = -1; S.newsSeen = 0;
    persist();
    sfx('dock');
    if (su.mode === 'duo') { render(); cardPass([]); return; }
    hideCard(); render();
    toast('Day 1 at ' + sysName(me().loc) + '. Check the Market, then plot a course on the Map.', 'info');
  }
  function resume(g) {
    S.G = g; S.tab = 'map'; S.sel = me().loc; S.mg = firstGood(); S.lastCr = null; S.newsSeen = newsCount();
    render();
    if (g.trip) { if (g.trip.enc) cardEnc(); else stepTrip(); return; }
    if (g.mode === 'duo') { cardPass([]); return; }
    hideCard();
  }
  function toTitle() { S.root.classList.remove('hide'); cardTitle(); }

  // ================= input =================
  function act(a, el) {
    var g = S.G, p = g ? me() : null, parts = a.split(':'), cmd = parts[0], why, n;
    if (el && el.getAttribute('aria-disabled') === 'true') {
      var w = el.getAttribute('data-why');
      if (w) toast(w);
      if (cmd === 'warp') { doWarp(); return; }
      sfx('err');
      return;
    }
    S.snd.ensure();
    switch (cmd) {
      case 'tab': S.tab = parts[1]; sfx('click'); render(); return;
      case 'mg': S.mg = +parts[1]; sfx('click'); render(); return;
      case 'go': S.tab = 'map'; S.sel = +parts[1]; render(); return;
      case 'buy1': case 'buymax':
        n = cmd === 'buy1' ? 1 : maxBuy(g, g.turn, S.mg);
        var rb = buy(g, g.turn, S.mg, n);
        if (rb.n) { sfx('buy'); persist(); render(); }
        else { sfx('err'); toast(rb.why === 'cash' ? 'Not enough credits' : rb.why === 'space' ? 'Your hold is full' : 'None for sale here'); }
        return;
      case 'sell1': case 'sellall':
        var rs = sell(g, g.turn, S.mg, cmd === 'sell1' ? 1 : p.cargo[S.mg]);
        if (rs.n) { sfx('sell'); persist(); render(); if (cmd === 'sellall' && rs.n > 1) toast('Sold ' + rs.n + ' ' + GOODS[S.mg].name + ' for ' + fmt(rs.got) + ' (' + (rs.profit >= 0 ? '+' : '') + fmt(rs.profit) + ')', rs.profit >= 0 ? 'success' : 'info'); }
        else sfx('err');
        return;
      case 'warp': doWarp(); return;
      case 'fuel': case 'fuel1': n = refuel(g, g.turn, cmd === 'fuel1' ? 1 : null); if (n) { sfx('buy'); persist(); render(); } else sfx('err'); return;
      case 'repair': n = repair(g, g.turn); if (n) { sfx('buy'); persist(); render(); } else sfx('err'); return;
      case 'eq': why = buyEquip(g, g.turn, parts[1], parts[2]); done(why, itemById(parts[1], parts[2]).name + ' fitted'); return;
      case 'sq': n = sellEquip(g, g.turn, parts[1], +parts[2]); if (n) { sfx('sell'); persist(); render(); } else { sfx('err'); toast('Empty your hold first'); } return;
      case 'eng': why = upgradeEngine(g, g.turn); done(why, ENGINES[p.ship.eng].name + ' installed'); return;
      case 'pod': why = buyPod(g, g.turn); done(why, 'Escape pod fitted'); return;
      case 'ship':
        var k = +parts[1], deal = shipDeal(g, p, k);
        if (deal.why) { sfx('err'); toast(deal.why); return; }
        confirmCard('NEW SHIP', 'Trade your ' + esc(SHIPS[p.ship.t].name) + ' for a <b>' + esc(SHIPS[k].name) + '</b>? ' + (deal.net >= 0 ? 'Cost after trade-in: <b>' + fmt(deal.net) + ' cr</b>.' : 'You get <b>' + fmt(-deal.net) + ' cr</b> back.') +
          (deal.lost ? ' Equipment that won\u2019t fit is sold for ' + fmt(deal.lost) + '.' : ''), function () { done(buyShip(g, g.turn, k), 'Welcome aboard your new ' + SHIPS[k].name + '!'); });
        return;
      case 'acc': why = accept(g, g.turn, parts.slice(1).join(':')); done(why, 'Mission accepted'); return;
      case 'abn': confirmCard('DROP MISSION', 'Abandon <b>' + esc(missionTitle(g, p.missions[+parts[1]])) + '</b>? Your record suffers a little.', function () { abandon(g, g.turn, +parts[1]); persist(); hideCard(); render(); }); return;
      case 'borrow': case 'borrowmax': n = borrow(g, g.turn, cmd === 'borrow' ? 1000 : null); if (n) { sfx('coin'); persist(); render(); } return;
      case 'repay': case 'repayall': n = repay(g, g.turn, cmd === 'repay' ? 1000 : null); if (n) { sfx('buy'); persist(); render(); } return;
      case 'moon':
        confirmCard('BUY THE MOON', 'Pay <b>' + fmt(moonPrice(g)) + ' cr</b> for a moon of your own and end the game?', function () { if (!buyMoon(g, g.turn)) { persist(); render(); showOver(); } else hideCard(); });
        return;
      case 'retire':
        if (g.mode === 'solo') confirmCard('RETIRE', 'End this game now and bank a score of <b>' + fmt(score(g, p)) + '</b>?', function () { retire(g, g.turn); persist(); showOver(); });
        else confirmCard('CONCEDE', 'Give up the race and hand the win to <b>' + esc(g.players[g.turn === 0 ? 1 : 0].name) + '</b>?', function () { if (!retire(g, g.turn)) { checkOver(g); persist(); showOver(); } else hideCard(); });
        return;
      case 'wait':
        if (g.trip || g.over) return;
        sfx('click');
        news(g, p.name + ' waits a day at ' + sysName(p.loc) + '.', 'sys', p.loc);
        afterTurn();
        return;
      case 'quit': persist(); toTitle(); return;
      case 'enc': encAction(parts[1]); return;
      case 'dock': afterTurn(); return;
      case 'ready':
        S.root.classList.remove('hide'); hideCard(); render(); sfx('dock');
        (S.passNotes || []).forEach(function (t) { toast(t, 'error'); });
        S.passNotes = [];
        return;
      case 'cont': var sv = loadGame(); if (sv) resume(sv); else cardTitle(); return;
      case 'setup': S.root.classList.remove('hide'); cardSetup(); return;
      case 'mode': S.setup.mode = parts[1]; saveNames(); cardSetup(); return;
      case 'diff': S.setup.diff = +parts[1]; saveNames(); cardSetup(); return;
      case 'launch': launch(); return;
      case 'title': toTitle(); return;
      case 'records': cardRecords(); return;
      case 'help': if (S.card === 'title') S.backTo = 'title'; cardHelp(); return;
      case 'close': if (S.backTo === 'title' || !S.G || S.G.over) { S.backTo = null; toTitle(); } else { hideCard(); } return;
      case 'yes': var y = S.onYes; S.onYes = null; if (y) y(); return;
      case 'no': S.onYes = null; hideCard(); return;
    }
  }
  function saveNames() { S.ovl.querySelectorAll('.st-in').forEach(function (inp) { S.setup.names[+inp.getAttribute('data-n')] = inp.value.trim().slice(0, 16); }); }
  function done(why, ok) {
    if (why) { sfx('err'); toast(why); return; }
    sfx('coin'); persist(); hideCard(); render();
    if (ok) toast(ok, 'success');
  }
  function onKey(e) {
    if (!S || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { if (e.key === 'Enter' && S.card === 'setup') { e.preventDefault(); launch(); } return; }
    var k = e.key;
    if (S.card) {
      if (S.card === 'travel') { if (S.trvDone) S.trvDone(); e.preventDefault(); return; }
      var b = null;
      if (k.length === 1) b = S.ovl.querySelector('[data-key="' + k.toLowerCase() + '"]');
      if (!b && k === 'Enter') b = S.ovl.querySelector('[data-key="Enter"]') || (document.activeElement && S.ovl.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' ? null : S.ovl.querySelector('.st-go:not(.alt)'));
      if (k === 'Escape' && (S.card === 'help' || S.card === 'records' || S.card === 'confirm')) { e.preventDefault(); act(S.card === 'confirm' ? 'no' : 'close'); return; }
      if (b) { e.preventDefault(); b.click(); }
      return;
    }
    if (!S.G) return;
    if (k >= '1' && k <= '5') { e.preventDefault(); act('tab:' + TABS[+k - 1][0]); return; }
    if ((k === 'w' || k === 'W') && !S.G.over) { e.preventDefault(); act('wait'); return; }
    if (S.tab === 'map') {
      if (k === 'Enter') { e.preventDefault(); doWarp(); return; }
      var dir = k === 'ArrowLeft' ? [-1, 0] : k === 'ArrowRight' ? [1, 0] : k === 'ArrowUp' ? [0, -1] : k === 'ArrowDown' ? [0, 1] : null;
      if (dir) { e.preventDefault(); stepSel(dir); }
    } else if (S.tab === 'market') {
      if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); S.mg = (S.mg + (k === 'ArrowUp' ? GOODS.length - 1 : 1)) % GOODS.length; render(); return; }
      if (k === 'b' || k === 'B') { e.preventDefault(); act(e.shiftKey ? 'buymax' : 'buy1'); }
      if (k === 's' || k === 'S') { e.preventDefault(); act(e.shiftKey ? 'sellall' : 'sell1'); }
    }
  }
  // arrow keys hop to the nearest star in that direction
  function stepSel(d) {
    var g = S.G, from = g.sys[S.sel == null ? me().loc : S.sel], best = -1, bs = 1e9;
    for (var k = 0; k < g.sys.length; k++) {
      var s = g.sys[k], dx = s.x - from.x, dy = s.y - from.y, along = dx * d[0] + dy * d[1];
      if (along <= 0.5) continue;
      var off = Math.abs(dx * d[1]) + Math.abs(dy * d[0]), sc = along + off * 2;
      if (sc < bs) { bs = sc; best = k; }
    }
    if (best >= 0) { S.sel = best; sfx('click'); render(); }
  }

  // ================= open / close =================
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    clearInterval(s.trvT); clearTimeout(s.trvT); clearInterval(s.boomT); clearTimeout(s.resizeT);
    window.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
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
    var body = '<div class="st" tabindex="-1"><div class="st-bar"></div><div class="st-tabs" role="tablist"></div><div class="st-view"></div>' +
      '<div class="st-ovl" style="display:none"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udef0\ufe0f Space Trader', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'st-hb';
    hb.innerHTML = '<button type="button" data-h="menu" title="Title menu" aria-label="Title menu">' + IC_MENU + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-popbtn') || p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var su = sjson(SETUP_KEY) || {};
    S = {
      panel: p, root: p.querySelector('.st'), barEl: p.querySelector('.st-bar'), tabsEl: p.querySelector('.st-tabs'), view: p.querySelector('.st-view'), ovl: p.querySelector('.st-ovl'),
      snd: new Snd(sget(SOUND_KEY) === '1'), R: normRecords(sjson(REC_KEY)), G: null, tab: 'map', sel: null, mg: 0, card: null,
      setup: { mode: MODES.indexOf(su.mode) >= 0 ? su.mode : 'solo', diff: clamp(su.diff | 0, 0, 2) || (su.diff === 0 ? 0 : 1), names: Array.isArray(su.names) ? su.names.slice(0, 2).map(function (x) { return String(x || '').slice(0, 16); }) : [] },
      rm: !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches), coarse: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
      lastRank: -1, newsSeen: 0
    };
    p._onClose = teardown;
    function syncHead() {
      var b = hb.querySelector('[data-h="sound"]');
      b.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
      b.classList.toggle('on', S.snd.on);
      b.title = S.snd.on ? 'Sound on' : 'Sound off';
      b.setAttribute('aria-label', b.title);
    }
    syncHead();
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') { S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0'); S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04); syncHead(); }
      else if (h === 'help') { if (S.card === 'help') act('close'); else if (!S.card || S.card === 'title') { S.backTo = S.card === 'title' ? 'title' : null; cardHelp(); } }
      else if (h === 'menu') { if (!S.card || S.card === 'help' || S.card === 'records') { persist(); toTitle(); } }
      try { b.blur(); } catch (er) {}
    });
    // every tap goes through one delegate
    S.root.addEventListener('click', function (e) {
      if (!S) return;
      if (S.card === 'travel') { if (S.trvDone) S.trvDone(); return; }
      var b = e.target.closest ? e.target.closest('[data-a]') : null;
      if (!b || !S.root.contains(b)) return;
      act(b.getAttribute('data-a'), b);
    });
    S.root.addEventListener('keydown', onKey);
    // Fast taps must never zoom, select, magnify or open a callout. CSS does most of
    // it; the map takes no browser gestures and the panel swallows gesture / dblclick.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.view.addEventListener('pointerdown', function (e) {
      var pre = e.target.closest ? e.target.closest('.st-map') : null;
      if (!pre || !S || S.card) return;
      e.preventDefault();
      mapTap({ currentTarget: pre, clientX: e.clientX, clientY: e.clientY, detail: (e.pointerType === 'mouse' && S.lastTapT && Date.now() - S.lastTapT < 350 && S.lastTapS === S.sel) ? 2 : 1 });
      S.lastTapT = Date.now(); S.lastTapS = S.sel;
    });
    S.view.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('.st-map')) noTouch(e); }, { passive: false });
    S.view.addEventListener('touchend', function (e) { if (e.target.closest && e.target.closest('.st-map')) noTouch(e); }, { passive: false });
    S.view.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.st-map')) e.preventDefault(); });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && S.tab === 'map' && S.G) fitMap(); }, 100);
    };
    window.addEventListener('resize', S.onResize);
    try {
      // colours are CSS variables; the map only needs a refit when fonts / theme change
      S.themeObs = new MutationObserver(function () { if (S && S.G && !(Cade.isMinimized && Cade.isMinimized(p))) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    p.addEventListener('cade-panel-restore', function () { if (S && S.G) requestAnimationFrame(function () { if (S && S.G && S.tab === 'map') fitMap(); }); });
    var sv = loadGame();
    if (sv && !sv.over) { S.G = sv; S.tab = 'map'; S.sel = me().loc; S.mg = firstGood(); S.newsSeen = newsCount(); render(); }
    cardTitle();
    if (!sv && !sget(REC_KEY)) { S.backTo = 'title'; cardHelp(); }
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
    requestAnimationFrame(function () { if (S && S.panel === p && S.G && S.tab === 'map') fitMap(); });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Buy low, sell high across an ASCII star map \u2014 pirates, police, missions, upgrades, a rival trader and a moon to buy',
    icon: '\ud83d\udef0\ufe0f',
    tags: 'game,sim,trading,space,economy,pirates,merchant,ascii,strategy,vs cpu,2 player',
    open: open,
    _engine: ENGINE
  });
})();
