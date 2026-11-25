/* Reel Deep — a side-view fishing game for Cade.txt.
 * Six generated waters (pond, river, lake, an ice hole, a sea pier and the deep
 * sea from a boat), each a seeded cross-section: a bottom profile, weeds, rocks,
 * light that fades with depth, a sky with time of day and weather (sun,
 * overcast, rain or snow, storm, fog) that sets which fish are about and how
 * hungry they are. Fish are drawn procedurally per species and swim with a
 * wander / school / follow AI that reads the lure.
 * Cast with a power meter (hold and let go, or drag back and flick); wind drifts
 * the cast. Lures sink, dive, hop or float; reel (hold) and twitch (taps). A fish
 * follows, nibbles, then strikes: set the hook inside the strike window. The
 * fight is a line-tension model: the fish's pull (power, stamina, runs, darts,
 * dives, jumps) against the drag, the line's strength and the spool; steer the
 * rod against its run, ease off in the red, keep the line tight.
 * Career: sell or release, angler-club contracts, tournaments against CPU
 * anglers, a daily seeded derby, gear (rods, reels, line, lures, bait, boat),
 * levels and a fish journal of 55 species with records. Saved in Cade.store
 * (cade-fishing-*). Offline, no assets; all names and art are original. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World: x → metres from the angler's stand out over the water, y → metres of
  // depth (0 = the surface, negative = the air above it); seconds; pounds.
  var STEP = 1 / 60;
  var MIN_PER_SEC = 1;              // in-game minutes per real second at the water
  var DAY_START = 300, DAY_END = 1440, SEASON_DAYS = 6, TRAVEL_MIN = 20;
  var SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
  var DAWN = 1, DAY = 2, DUSK = 4, NIGHT = 8;
  var BAND_NAME = { 1: 'Dawn', 2: 'Day', 4: 'Dusk', 8: 'Night' };
  var WX = ['sun', 'overcast', 'rain', 'storm', 'fog'];
  var WX_NAME = ['Sunny', 'Overcast', 'Rain', 'Storm', 'Fog'];
  var RAR_NAME = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  var RAR_W = [10, 4.2, 1.25, 0.42, 0];
  var RAR_PRICE = [1, 1.4, 2.2, 3.5, 4];
  var RAR_XP = [8, 18, 45, 110, 400];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash() {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < arguments.length; i++) {
      var s = String(arguments[i]);
      for (var j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619) >>> 0;
      h = Math.imul(h ^ 124, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) { return mulberry32(typeof seed === 'number' ? seed : hash(seed)); }
  function pickW(r, w) {
    var t = 0, i;
    for (i = 0; i < w.length; i++) t += w[i];
    var x = r * t;
    for (i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
    return w.length - 1;
  }

  // ---- time, seasons, weather ----
  function bandOf(min) { min = ((min % 1440) + 1440) % 1440; return min < 300 ? NIGHT : min < 480 ? DAWN : min < 1080 ? DAY : min < 1260 ? DUSK : NIGHT; }
  function seasonOf(day) { return Math.floor((Math.max(1, day) - 1) / SEASON_DAYS) % 4; }
  function clockStr(min) { min = Math.floor(((min % 1440) + 1440) % 1440); var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  var SEASON_WX = [[4, 3, 3, 1, 2], [6, 2, 1.6, 1.4, 0.6], [3, 3, 2.2, 1, 2.2], [3, 4, 2.4, 0.5, 2]];
  // The weather for a day changes every 4 hours along a seeded chain.
  function weatherAt(seed, day, min) {
    var s = seasonOf(day), r = mulberry32(hash(seed, 'wx', day)), seg = clamp(Math.floor(min / 240), 0, 5), w = pickW(r(), SEASON_WX[s]);
    for (var i = 1; i <= seg; i++) {
      var q = r(), q2 = r();
      if (q < 0.45) w = pickW(q2, SEASON_WX[s]);
      if (w === 4 && i >= 3 && q2 < 0.7) w = 1;              // fog burns off by midday
    }
    var wr = mulberry32(hash(seed, 'wind', day, seg)), base = [0.25, 0.4, 0.55, 0.95, 0.06][w];
    return { w: w, wind: clamp(base + (wr() - 0.5) * 0.3, 0, 1), wdir: wr() < 0.5 ? -1 : 1, seg: seg };
  }

  // ---- places ----
  // stand: bank | pier | boat | ice. clar: metres of depth for the light to fall to 1/e.
  var LOCS = [
    { id: 'pond', name: 'Willow Pond', short: 'Pond', lvl: 1, W: 30, maxD: 4.2, stand: 'bank', cur: 0, wave: 0.05, clar: 2.4, salt: false, n: 16,
      surf: [92, 132, 92], deep: [24, 50, 34], mud: [96, 78, 52], blurb: 'Lily pads, warm shallows, sunfish and old carp.' },
    { id: 'river', name: 'Cobble Run', short: 'River', lvl: 3, W: 34, maxD: 5.2, stand: 'bank', cur: 0.45, wave: 0.07, clar: 3.2, salt: false, n: 15,
      surf: [86, 138, 128], deep: [22, 52, 54], mud: [118, 104, 82], blurb: 'Current pushes your lure; trout in the riffles.' },
    { id: 'lake', name: 'Glass Lake', short: 'Lake', lvl: 5, W: 48, maxD: 15, stand: 'bank', cur: 0, wave: 0.1, clar: 5.5, salt: false, n: 18, vis: 1.15,
      surf: [70, 128, 150], deep: [10, 34, 58], mud: [92, 86, 70], blurb: 'A weedy shelf, then a cold drop-off.' },
    { id: 'pier', name: 'Saltwind Pier', short: 'Pier', lvl: 7, W: 46, maxD: 12, stand: 'pier', cur: 0, wave: 0.22, clar: 6.5, salt: true, n: 18, vis: 1.2,
      surf: [64, 140, 150], deep: [8, 42, 70], mud: [176, 158, 118], blurb: 'Swells, pilings and fast sea fish.' },
    { id: 'ice', name: 'Frostbite Hole', short: 'Ice', lvl: 9, W: 26, maxD: 9, stand: 'ice', cur: 0, wave: 0, clar: 7, salt: false, n: 12, winter: true,
      surf: [96, 140, 170], deep: [12, 30, 52], mud: [84, 84, 80], blurb: 'Winter only. Jig through the ice.' },
    { id: 'deep', name: 'Blue Shelf', short: 'Deep sea', lvl: 12, W: 52, maxD: 120, stand: 'boat', cur: 0, wave: 0.32, clar: 26, salt: true, n: 22, boat: true, vis: 3.2, reelMul: 1.7,
      surf: [40, 120, 170], deep: [2, 10, 34], mud: [70, 70, 76], blurb: 'Needs a boat. Monsters a hundred metres down.' }
  ];
  var LOC = {};
  LOCS.forEach(function (l, i) { l.i = i; LOC[l.id] = l; });

  // Rod tip, where the line reaches the water, where a fish is landed.
  function standOf(L) {
    if (L.stand === 'pier') return { tip: { x: 3.4, y: -5.4 }, anc: { x: 3.4, y: -5.4 }, home: 1.4, minX: 2.2, landD: 6.6, castFrom: 3.4 };
    if (L.stand === 'boat') return { tip: { x: 2.6, y: -2.7 }, anc: { x: 2.6, y: -2.7 }, home: 0, minX: 1.4, landD: 3.5, castFrom: 2.6 };
    if (L.stand === 'ice') return { tip: { x: 3.4, y: -1.5 }, anc: { x: 3.4, y: 0.2 }, home: 2.2, minX: 3.4, landD: 1.1, castFrom: 3.4, hole: 3.4, iceT: 0.55 };
    return { tip: { x: 1.7, y: -2.9 }, anc: { x: 1.7, y: -2.9 }, home: -1.1, minX: 0.9, landD: 3.4, castFrom: 1.7 };
  }

  // A seeded cross-section: bottom depth every half metre, weeds, rocks, pads.
  function genLayout(seed, L) {
    var r = mulberry32(hash(seed, 'lay', L.id)), W = L.W, n = W * 2 + 1, d = new Float32Array(n), i, x;
    var nz = [], NK = 12;
    for (i = 0; i <= NK; i++) nz.push(r() * 2 - 1);
    function noise(t) { var u = clamp(t, 0, 1) * NK, k = Math.min(NK - 1, Math.floor(u)), f = u - k; f = f * f * (3 - 2 * f); return lerp(nz[k], nz[k + 1], f); }
    var drop = 10 + r() * 6, ph = r() * 6;
    for (i = 0; i < n; i++) {
      x = i / 2;
      var u = x / W, v;
      if (L.id === 'pond') v = L.maxD * (0.18 + 0.82 * Math.pow(clamp(x / (W * 0.55), 0, 1), 0.8)) * (0.86 + 0.14 * noise(u)) - 0.15 * Math.sin(x * 0.7 + ph) * u;
      else if (L.id === 'river') v = L.maxD * (0.12 + 0.88 * Math.pow(Math.sin(Math.PI * clamp(u * 0.92 + 0.04, 0, 1)), 0.6)) * (0.85 + 0.15 * noise(u)) + 0.18 * Math.sin(x * 1.7 + ph);
      else if (L.id === 'lake') v = x < drop ? 1.2 + 1.8 * (x / drop) + 0.4 * noise(u) : 3 + (L.maxD - 3) * (1 - Math.exp(-(x - drop) / 4.5)) * (0.9 + 0.1 * noise(u));
      else if (L.id === 'pier') v = 2.2 + (L.maxD - 2.2) * Math.pow(clamp(u * 1.3, 0, 1), 0.7) * (0.9 + 0.1 * noise(u)) + 0.25 * Math.sin(x * 0.9 + ph);
      else if (L.id === 'ice') v = 2.2 + (L.maxD - 2.2) * clamp(u * 1.6, 0, 1) * (0.85 + 0.15 * noise(u));
      else v = L.maxD * (0.78 + 0.22 * noise(u)) - 26 * Math.exp(-Math.pow((x - W * (0.45 + 0.2 * nz[3])) / 5, 2));
      if (L.stand === 'bank') v *= clamp((x - 0.2) / 3.2, 0.03, 1);
      d[i] = clamp(v, 0.06, L.maxD);
    }
    var lay = { W: W, d: d, maxD: 0, plants: [], rocks: [], pads: [], posts: [], seed: seed };
    for (i = 0; i < n; i++) lay.maxD = Math.max(lay.maxD, d[i]);
    var np = { pond: 26, river: 10, lake: 22, pier: 12, ice: 8, deep: 14 }[L.id] || 10;
    for (i = 0; i < np; i++) {
      x = 1.5 + r() * (W - 2);
      var dep = depthAt(lay, x);
      if (L.id === 'lake' && dep > 7 && r() < 0.7) continue;
      lay.plants.push({ x: x, h: Math.min(dep * (0.25 + r() * 0.55), L.id === 'deep' ? 9 : 3.2), k: L.salt ? (r() < 0.5 ? 2 : 3) : (r() < 0.6 ? 0 : 1), ph: r() * 6.28, w: 0.6 + r() * 0.8 });
    }
    var nr = { pond: 4, river: 16, lake: 9, pier: 8, ice: 6, deep: 10 }[L.id] || 6;
    for (i = 0; i < nr; i++) { x = 1.2 + r() * (W - 1.5); lay.rocks.push({ x: x, r: (L.id === 'deep' ? 1.2 : 0.25) + r() * (L.id === 'deep' ? 2.5 : 0.55), s: r() }); }
    if (L.id === 'pond') for (i = 0; i < 9; i++) lay.pads.push({ x: 3 + r() * (W - 5), w: 0.35 + r() * 0.35, f: r() < 0.3 });
    if (L.stand === 'pier') for (x = -3; x <= 2.5; x += 2.75) lay.posts.push(x);
    return lay;
  }
  function depthAt(lay, x) {
    var u = clamp(x * 2, 0, lay.d.length - 1), k = Math.floor(u), f = u - k;
    return k >= lay.d.length - 1 ? lay.d[lay.d.length - 1] : lerp(lay.d[k], lay.d[k + 1], f);
  }

  // ---- lures ----
  // sink: m/s (negative floats up), dive: running depth while reeled, ideal: m/s retrieve
  var LURES = [
    { id: 'b', name: 'Live Bait', note: 'Worm under a float. Set the depth; wait for the bob. Uses bait.', sink: 0.55, ideal: 0, bob: true, price: 0, scent: 1.8 },
    { id: 's', name: 'Spinner', note: 'Flashes on a steady retrieve. Mid-depth chasers love it.', sink: 0.8, rise: 0.35, ideal: 1.0, flash: 1, price: 0 },
    { id: 'c', name: 'Crankbait', note: 'Floats at rest, dives ~2.5 m when reeled. Predators strike on the move.', sink: -0.18, dive: 2.6, ideal: 1.15, price: 120, lvl: 2 },
    { id: 'j', name: 'Jig', note: 'Sinks fast. Twitch it off the bottom; nibbling fish often hit a twitch.', sink: 1.7, ideal: 0.3, hop: 1.5, price: 160, lvl: 3 },
    { id: 'f', name: 'Dry Fly', note: 'Sits on the surface film. Skitter it with taps for trout and sunfish.', sink: 0, surface: true, ideal: 0.3, price: 260, lvl: 4 },
    { id: 'd', name: 'Deep Rig', note: 'Heavy sinker and a fat bait. Plummets to the bottom. Salt water only.', ideal: 0.15, heavy: true, salt: true, price: 900, lvl: 8, scent: 3.2, sink: 7 }
  ];
  var LURE = {};
  LURES.forEach(function (l, i) { l.i = i; LURE[l.id] = l; });

  // ---- gear ----
  var RODS = [
    { name: 'Willow Switch', price: 0, pow: 0.2, sens: 0.2, cast: 17, lvl: 1 },
    { name: 'Graphite Spinner', price: 180, pow: 0.36, sens: 0.45, cast: 23, lvl: 2 },
    { name: 'Composite MH', price: 650, pow: 0.55, sens: 0.55, cast: 27, lvl: 5 },
    { name: 'Carbon Pro', price: 1900, pow: 0.72, sens: 0.78, cast: 31, lvl: 9 },
    { name: 'Big Game Stick', price: 4600, pow: 0.95, sens: 0.5, cast: 25, lvl: 13 },
    { name: 'Heirloom Split-Cane', price: 9500, pow: 0.85, sens: 0.98, cast: 34, lvl: 18 }
  ];
  var REELS = [
    { name: 'Tin Spincast', price: 0, speed: 0.95, drag: 6, smooth: 0.3, spool: 80, lvl: 1 },
    { name: 'Spinning 2500', price: 220, speed: 1.2, drag: 12, smooth: 0.5, spool: 140, lvl: 2 },
    { name: 'Low-Pro Baitcaster', price: 750, speed: 1.45, drag: 22, smooth: 0.64, spool: 190, lvl: 5 },
    { name: 'Saltwater 6000', price: 2300, speed: 1.6, drag: 42, smooth: 0.76, spool: 320, lvl: 9 },
    { name: 'Lever Drag 30', price: 6200, speed: 1.9, drag: 80, smooth: 0.9, spool: 650, lvl: 13 }
  ];
  var LINES = [
    { name: '6 lb Mono', price: 0, lb: 6, lvl: 1 },
    { name: '10 lb Mono', price: 70, lb: 10, lvl: 2 },
    { name: '15 lb Fluoro', price: 260, lb: 15, lvl: 4 },
    { name: '30 lb Braid', price: 780, lb: 30, lvl: 7 },
    { name: '60 lb Braid', price: 2100, lb: 60, lvl: 11 },
    { name: '100 lb Big-Game', price: 5200, lb: 100, lvl: 14 }
  ];
  var UPGRADES = [
    { id: 'creel', name: 'Bigger Creel', note: '+4 fish you can keep at once', price: [250, 700, 1600], max: 3, lvl: 1 },
    { id: 'cooler', name: 'Cooler', note: 'Kept fish stay fresh four times longer', price: [420], max: 1, lvl: 3 },
    { id: 'finder', name: 'Fish Finder', note: 'Sonar blips show fish in dark water', price: [900], max: 1, lvl: 6 },
    { id: 'boat', name: 'Boat', note: 'Opens the Blue Shelf (deep sea)', price: [3200], max: 1, lvl: 12 }
  ];
  var BAIT_PACK = { n: 20, price: 12 };
  var DIFFS = {
    relax: { id: 'relax', name: 'Relax', pow: 0.65, sta: 0.7, win: 1.6, slack: 5, noSnap: true, jump: 0.4, bite: 1.25 },
    normal: { id: 'normal', name: 'Normal', pow: 1, sta: 1, win: 1, slack: 2.4, noSnap: false, jump: 1, bite: 1 },
    hard: { id: 'hard', name: 'Hard', pow: 1.2, sta: 1.25, win: 0.72, slack: 1.6, noSnap: false, jump: 1.35, bite: 0.85 }
  };

  // ---- species ----
  // fight: [power, stamina, speed, jumpiness, schools, max nibbles, chases moving lures]
  // look: [shape, back, belly, accent, pattern]
  var SPECIES = [];
  var SP = {};
  function sp(id, name, locs, rar, wmin, wmax, lk, d0, d1, times, wx, lures, seas, price, fight, look, extra) {
    var tm = 0, sm = 0;
    if (times.indexOf('A') >= 0) tm |= DAWN;
    if (times.indexOf('D') >= 0) tm |= DAY;
    if (times.indexOf('U') >= 0) tm |= DUSK;
    if (times.indexOf('N') >= 0) tm |= NIGHT;
    'PSFW'.split('').forEach(function (c, i) { if (seas === '*' || seas.indexOf(c) >= 0) sm |= 1 << i; });
    var o = {
      id: id, name: name, locs: locs.split(' '), rar: rar, wmin: wmin, wmax: wmax, lk: lk, d0: d0, d1: d1, times: tm,
      wx: wx.split('').map(function (c) { return 'sorTf'.indexOf(c); }).filter(function (v) { return v >= 0; }),
      lures: lures, seas: sm, price: price,
      pow: fight[0], sta: fight[1], spd: fight[2], jmp: fight[3], sch: fight[4], nib: fight[5], chase: fight[6],
      shape: look[0], c1: look[1], c2: look[2], c3: look[3], pat: look[4]
    };
    for (var k in extra || {}) o[k] = extra[k];
    o.i = SPECIES.length;
    SPECIES.push(o); SP[id] = o;
    return o;
  }
  // pond
  sp('bluegill', 'Bluegill', 'pond lake ice', 0, 0.15, 1.6, 8.6, 0.15, 0.7, 'AD', 'so', { b: 1, f: 0.8, j: 0.5, s: 0.2 }, '*', 2.5, [1.0, 0.8, 0.8, 0, 1, 2, 0], ['sunfish', '#3d5e6e', '#e8a84a', '#2b4250', 'bars']);
  sp('pumpkinseed', 'Pumpkinseed', 'pond', 0, 0.1, 1, 8.4, 0.1, 0.6, 'ADU', 'so', { b: 1, f: 0.9, j: 0.3 }, 'PSF', 2.5, [0.95, 0.8, 0.8, 0, 1, 2, 0], ['sunfish', '#5f7f4a', '#f0913a', '#3aa6b9', 'dots']);
  sp('shiner', 'Golden Shiner', 'pond', 0, 0.05, 0.6, 11, 0.05, 0.5, 'ADU', 'sof', { f: 1, b: 0.8, s: 0.3 }, 'PSF', 3, [0.6, 0.6, 1.1, 0.1, 1, 1, 0], ['minnow', '#a9a15a', '#f3e6a1', '#c9b04a', 'lat']);
  sp('perch', 'Yellow Perch', 'pond lake ice', 0, 0.2, 2.2, 9.8, 0.3, 0.95, 'AD', 'so', { b: 0.9, j: 0.9, s: 0.5 }, '*', 3, [0.85, 0.8, 0.8, 0, 1, 2, 0], ['perch', '#7f8c3a', '#f4e9b0', '#e8722c', 'bars']);
  sp('crappie', 'Black Crappie', 'pond lake', 0, 0.3, 3.5, 10, 0.3, 0.8, 'UNA', 'of', { j: 1, b: 0.8, f: 0.3 }, 'PFW', 3, [0.75, 0.8, 0.8, 0, 1, 2, 0], ['crappie', '#55605a', '#d9dccf', '#2e342f', 'speck']);
  sp('lmbass', 'Largemouth Bass', 'pond lake', 1, 0.8, 11, 11.7, 0.1, 0.8, 'AU', 'or', { s: 1, c: 1, j: 0.8, b: 0.5, f: 0.3 }, 'PSF', 4, [0.85, 1.0, 1.0, 0.7, 0, 1, 1], ['bass', '#4f6b34', '#eef0d0', '#2b3a1c', 'lat']);
  sp('catfish', 'Channel Catfish', 'pond river lake', 1, 1.5, 30, 12.5, 0.6, 1, 'UN', 'roT', { b: 1, j: 0.3, d: 0.4 }, 'PSF', 2.2, [0.75, 1.2, 0.8, 0, 0, 3, 0], ['cat', '#6b7480', '#e8e6df', '#3b4048', 'speck']);
  sp('carp', 'Common Carp', 'pond river', 1, 3, 45, 9.2, 0.55, 1, 'ADU', 'so', { b: 1, f: 0.2 }, 'PSF', 1.2, [0.85, 1.3, 0.7, 0.1, 0, 4, 0], ['carp', '#9a7a35', '#efd79a', '#6b4e1d', 'scales']);
  sp('bowfin', 'Bowfin', 'pond', 1, 2, 20, 11.5, 0.3, 0.9, 'UN', 'ro', { b: 0.9, s: 0.6, c: 0.6 }, 'SF', 2.5, [0.95, 1.2, 0.9, 0.2, 0, 1, 1], ['bowfin', '#5b6340', '#c9c79a', '#2c321e', 'mottled']);
  sp('gar', 'Longnose Gar', 'pond river', 1, 2, 40, 16, 0.02, 0.35, 'D', 's', { b: 0.6, s: 0.7 }, 'SF', 1.6, [0.75, 1.1, 1.1, 0.6, 0, 1, 1], ['gar', '#7b8358', '#e3e1c4', '#3d3f29', 'spots']);
  sp('bullhead', 'Brown Bullhead', 'pond', 0, 0.3, 3, 9, 0.65, 1, 'UN', 'rof', { b: 1 }, 'PSF', 1.5, [0.7, 0.9, 0.6, 0, 0, 3, 0], ['cat', '#6b5a3a', '#dcd0a4', '#3d3020', 'mottled']);
  // river
  sp('smallmouth', 'Smallmouth Bass', 'river lake', 1, 0.7, 8, 11.8, 0.3, 0.95, 'AD', 'so', { c: 1, j: 1, s: 0.8, b: 0.5 }, 'PSF', 4, [1.0, 1.1, 1.0, 0.9, 0, 1, 1], ['bass', '#7b6a3a', '#eee1b8', '#4d3f1d', 'bars']);
  sp('rainbow', 'Rainbow Trout', 'river lake', 0, 0.5, 14, 12.5, 0.1, 0.7, 'AU', 'orf', { f: 1, s: 0.9, b: 0.6, c: 0.4 }, 'PSF', 4.5, [0.8, 1.0, 1.1, 0.9, 0, 1, 1], ['trout', '#5c7a63', '#f1ece2', '#d9607a', 'rainbow']);
  sp('brown', 'Brown Trout', 'river', 1, 1, 25, 12, 0.2, 0.9, 'UN', 'or', { c: 1, f: 0.7, s: 0.6, b: 0.4 }, 'PF', 5, [0.85, 1.1, 1.0, 0.6, 0, 1, 1], ['trout', '#8a6a30', '#f1dfa8', '#b8432e', 'spots']);
  sp('brook', 'Brook Trout', 'river', 1, 0.3, 6, 12, 0.1, 0.6, 'AD', 'orf', { f: 1, s: 0.6, b: 0.6 }, 'PFW', 6, [0.75, 0.9, 1.0, 0.3, 0, 1, 1], ['trout', '#3f5a3f', '#f08a3c', '#e7d46b', 'worm']);
  sp('sauger', 'Sauger', 'river', 0, 0.5, 5, 11.5, 0.6, 1, 'UNA', 'of', { j: 1, b: 0.8, c: 0.5 }, 'FWP', 3, [0.7, 0.8, 0.8, 0, 1, 2, 0], ['walleye', '#7a6c4a', '#e7dcc0', '#3a3020', 'mottled']);
  sp('drum', 'Freshwater Drum', 'river', 0, 1, 30, 10, 0.6, 1, 'DU', 'so', { j: 0.9, b: 0.9 }, 'PSF', 1.2, [0.8, 1.0, 0.7, 0, 0, 2, 0], ['drum', '#9aa0a0', '#eeeeea', '#6a7070', 'plain']);
  sp('sturgeon', 'Lake Sturgeon', 'river', 2, 15, 180, 15, 0.8, 1, 'UN', 'ro', { b: 1, d: 0.3 }, 'PSF', 1.6, [0.75, 1.6, 0.6, 0.5, 0, 4, 0], ['sturgeon', '#5f6460', '#d8d6cc', '#3a3d3a', 'scutes']);
  sp('rockbass', 'Rock Bass', 'river', 0, 0.2, 2, 9, 0.5, 1, 'ADU', 'so', { j: 0.9, b: 1, c: 0.5, s: 0.5 }, 'PSF', 2.4, [0.9, 0.8, 0.8, 0, 1, 2, 1], ['sunfish', '#6a5a35', '#d9c99a', '#b02a22', 'speck']);
  sp('fallfish', 'Fallfish', 'river', 0, 0.1, 2.5, 11, 0.1, 0.6, 'AD', 'sof', { f: 1, s: 0.7, b: 0.7 }, 'PSF', 1.8, [0.65, 0.7, 1.0, 0.1, 1, 1, 1], ['minnow', '#7a8a90', '#eef0ee', '#c2c8cc', 'lat']);
  // lake
  sp('walleye', 'Walleye', 'lake river ice', 1, 1, 16, 12.6, 0.55, 1, 'UNA', 'orf', { j: 1, c: 0.9, b: 0.8, s: 0.4 }, '*', 4.5, [0.8, 1.0, 0.9, 0, 1, 2, 1], ['walleye', '#a08a3a', '#f0ead0', '#4a3d1a', 'mottled']);
  sp('pike', 'Northern Pike', 'lake ice', 1, 2, 38, 14, 0.1, 0.7, 'AD', 'so', { s: 1, c: 0.9, b: 0.6 }, '*', 3.6, [0.85, 1.0, 1.3, 0.5, 0, 0, 1], ['pike', '#4c6638', '#e4e7c6', '#d5dd9a', 'beans']);
  sp('muskie', 'Muskellunge', 'lake', 2, 8, 60, 14.5, 0.15, 0.7, 'UD', 'oT', { c: 1, s: 0.9 }, 'SF', 4.5, [0.95, 1.4, 1.3, 0.7, 0, 0, 1], ['pike', '#7d7a4a', '#ece8c8', '#4a4628', 'bars']);
  sp('laketrout', 'Lake Trout', 'lake ice', 2, 3, 55, 12.6, 0.7, 1, 'AD', 'of', { j: 1, d: 0.8, c: 0.6 }, 'PFW', 4, [0.85, 1.3, 1.0, 0.1, 0, 1, 1], ['trout', '#4f5a60', '#e6e7e2', '#d8dce0', 'speck']);
  sp('whitefish', 'Lake Whitefish', 'lake ice', 0, 1, 14, 11, 0.6, 1, 'AD', 'of', { j: 0.9, b: 0.8, f: 0.4 }, 'FWP', 3, [0.7, 0.9, 0.8, 0, 1, 2, 0], ['whitefish', '#8d9aa2', '#f2f2ee', '#b8c0c4', 'plain']);
  sp('whitebass', 'White Bass', 'lake', 0, 0.5, 4, 10.5, 0.1, 0.6, 'AU', 'so', { s: 1, c: 0.8, j: 0.6 }, 'PS', 3, [0.85, 0.9, 1.0, 0.2, 1, 1, 1], ['drum', '#7d8a96', '#f0f2f0', '#3f4750', 'stripes']);
  // ice
  sp('burbot', 'Burbot', 'ice', 1, 1, 18, 14, 0.8, 1, 'N', 'ofr', { j: 1, b: 0.9 }, 'W', 3.5, [0.7, 1.0, 0.7, 0, 0, 2, 0], ['eel', '#6b6236', '#d6cf9a', '#3a3418', 'mottled']);
  sp('cisco', 'Cisco', 'ice lake', 0, 0.3, 5, 11, 0.3, 0.7, 'AU', 'of', { j: 1, f: 0.5, b: 0.7 }, 'WF', 2.6, [0.65, 0.8, 0.9, 0, 1, 1, 0], ['minnow', '#6d8798', '#eef2f4', '#a9b6c0', 'plain']);
  sp('char', 'Arctic Char', 'ice', 2, 1, 25, 12, 0.4, 1, 'AD', 'osf', { j: 1, b: 0.6, s: 0.7 }, 'W', 7, [0.85, 1.1, 1.0, 0.3, 0, 1, 1], ['trout', '#3f5560', '#e8643a', '#f3c9a4', 'spots']);
  // pier
  sp('mackerel', 'Atlantic Mackerel', 'pier', 0, 0.4, 4, 12, 0.05, 0.5, 'AD', 'so', { s: 1, f: 0.7, j: 0.6 }, 'SFP', 2.4, [0.8, 0.8, 1.3, 0.1, 1, 0, 1], ['mackerel', '#2f6f7c', '#e8eef0', '#14303a', 'wavy']);
  sp('seabass', 'Black Sea Bass', 'pier', 0, 0.5, 8, 10.5, 0.6, 1, 'AD', 'so', { j: 1, b: 1, d: 0.6 }, '*', 4, [0.85, 0.9, 0.8, 0, 1, 2, 0], ['grouper', '#33383f', '#9aa1a8', '#5e7fb0', 'scales']);
  sp('flounder', 'Summer Flounder', 'pier', 0, 1, 22, 11, 0.92, 1, 'AD', 'so', { b: 1, j: 0.8, d: 0.5 }, 'SF', 4.5, [0.8, 1.0, 0.8, 0, 0, 2, 0], ['flat', '#9a8460', '#e8dfcb', '#5c4a2e', 'ocel']);
  sp('striper', 'Striped Bass', 'pier river', 1, 3, 70, 12.2, 0.2, 0.8, 'UNA', 'orT', { s: 0.9, c: 1, b: 0.8, j: 0.6 }, 'PF', 4, [0.95, 1.2, 1.1, 0.2, 1, 1, 1], ['bass', '#5c6a74', '#eef0ee', '#2c3236', 'stripes']);
  sp('reddrum', 'Red Drum', 'pier', 1, 3, 55, 11.5, 0.5, 1, 'UNA', 'or', { b: 1, j: 0.8, s: 0.4, d: 0.5 }, 'SF', 4.2, [0.95, 1.3, 1.0, 0.1, 0, 2, 1], ['drum', '#b3733a', '#f1dfc6', '#1d1611', 'eyespot']);
  sp('bluefish', 'Bluefish', 'pier', 1, 2, 25, 12, 0.05, 0.6, 'DA', 'sT', { s: 1, c: 0.9 }, 'SF', 2.4, [1.0, 1.1, 1.3, 0.6, 1, 0, 1], ['mackerel', '#3c6c8c', '#eef2f2', '#2a4c60', 'plain']);
  sp('sheepshead', 'Sheepshead', 'pier', 0, 1, 20, 9.5, 0.5, 1, 'D', 'so', { b: 1, j: 0.5 }, 'PW', 3.5, [0.9, 1.0, 0.7, 0, 0, 3, 0], ['drum', '#9aa0a0', '#eef0ea', '#232628', 'bars']);
  sp('seatrout', 'Spotted Seatrout', 'pier', 0, 0.5, 12, 12.5, 0.2, 0.7, 'AUN', 'of', { s: 0.8, j: 0.9, b: 0.8, f: 0.4 }, 'PSF', 3.2, [0.75, 0.9, 1.0, 0.4, 1, 1, 1], ['trout', '#6a7a80', '#eeeeea', '#20262a', 'spots']);
  sp('snook', 'Common Snook', 'pier', 2, 3, 45, 12.5, 0.2, 0.8, 'UN', 'or', { c: 1, s: 0.8, b: 0.8 }, 'SF', 6, [0.95, 1.2, 1.2, 0.6, 0, 1, 1], ['walleye', '#8a9278', '#f2f0e6', '#1a1c18', 'lat']);
  sp('tarpon', 'Tarpon', 'pier', 3, 30, 220, 14, 0.1, 0.6, 'AUN', 'sT', { b: 0.8, c: 0.8, s: 0.4 }, 'SF', 2, [1.0, 1.6, 1.3, 1.6, 0, 1, 1], ['tarpon', '#6f8a98', '#f0f3f4', '#b8c6cc', 'scales']);
  // deep sea
  sp('snapper', 'Red Snapper', 'deep', 0, 2, 38, 10.5, 0.7, 1, 'AD', 'so', { d: 1, j: 0.8 }, 'PSF', 5, [0.9, 1.0, 0.9, 0, 1, 2, 0], ['snapper', '#d2493e', '#f6c9bd', '#a8302a', 'plain']);
  sp('grouper', 'Gag Grouper', 'deep', 1, 5, 80, 11, 0.8, 1, 'ADU', 'of', { d: 1, j: 0.8 }, '*', 4.5, [1.0, 1.2, 0.8, 0, 0, 2, 0], ['grouper', '#6e6a5e', '#d7d0bf', '#3c3a32', 'mottled']);
  sp('mahi', 'Mahi-Mahi', 'deep', 1, 5, 65, 13, 0.0, 0.12, 'D', 's', { s: 1, c: 1 }, 'SF', 4.5, [0.95, 1.1, 1.4, 1.4, 1, 0, 1], ['mahi', '#2fa36e', '#f2d43a', '#1d6a8a', 'dots']);
  sp('amberjack', 'Greater Amberjack', 'deep', 1, 10, 150, 12, 0.3, 0.8, 'AD', 'so', { d: 1, j: 0.9, c: 0.5 }, 'PSF', 2.6, [1.05, 1.4, 1.2, 0.1, 1, 1, 1], ['tuna', '#6f6f58', '#ece6cf', '#b49a46', 'lat']);
  sp('tuna', 'Yellowfin Tuna', 'deep', 1, 20, 320, 13, 0.1, 0.5, 'AU', 'so', { d: 0.9, c: 0.9, s: 0.6 }, 'SF', 3.4, [1.1, 1.5, 1.5, 0.1, 1, 0, 1], ['tuna', '#1f3a6a', '#e6ebef', '#f2c218', 'finlets']);
  sp('wahoo', 'Wahoo', 'deep', 1, 10, 120, 16, 0.03, 0.35, 'AD', 'sT', { c: 1, s: 0.9 }, 'SF', 3, [0.95, 1.1, 1.7, 0.4, 0, 0, 1], ['mackerel', '#2f4f8a', '#e7ecf2', '#1a2c55', 'bars']);
  sp('halibut', 'Pacific Halibut', 'deep', 2, 10, 420, 10, 0.92, 1, 'AD', 'of', { d: 1, j: 0.8, b: 0.6 }, 'PSF', 3.6, [0.95, 1.5, 0.7, 0, 0, 3, 0], ['flat', '#5e5a46', '#f0ece2', '#3c3a2c', 'mottled']);
  sp('swordfish', 'Swordfish', 'deep', 2, 50, 900, 13, 0.6, 1, 'N', 'of', { d: 1 }, 'SF', 4, [1.1, 1.7, 1.5, 0.8, 0, 1, 1], ['sword', '#3e3f52', '#c8c6cc', '#22222e', 'plain']);
  sp('marlin', 'Blue Marlin', 'deep', 3, 100, 1300, 13.5, 0.03, 0.4, 'AD', 'sT', { c: 1, s: 0.7 }, 'SF', 3, [1.15, 1.8, 1.6, 1.8, 0, 0, 1], ['marlin', '#1b3a78', '#e6ecf4', '#4fa0e0', 'bars']);
  // legends: one of each a day at most, only in their exact conditions
  sp('mossback', 'Mossback the Elder', 'pond', 4, 40, 70, 9.6, 0.7, 1, 'N', 'f', { b: 1 }, 'PSF', 30, [1.0, 1.6, 0.9, 0, 0, 5, 0], ['carp', '#4f6a2e', '#c9c28a', '#2d3d18', 'moss'],
    { beh: 'feint', lore: 'An ancient carp furred in pondweed. They say it remembers every hook it ever spat, and plays dead before its last run.', hint: 'Willow Pond, a foggy night, live bait on the bottom.' });
  sp('silverghost', 'Silverghost Sturgeon', 'river', 4, 200, 320, 15.5, 0.85, 1, 'UN', 'T', { b: 1 }, 'PF', 25, [0.85, 2.0, 0.7, 0.6, 0, 4, 0], ['sturgeon', '#b9c2c8', '#f2f4f5', '#7b8890', 'scutes'],
    { beh: 'anchor', lore: 'A pale shape that sulks on the riverbed in storms. Pull from the side to lift it off the bottom.', hint: 'Cobble Run in a storm after dusk, bait on the bottom. Spring or fall.' });
  sp('thunderjaw', 'Thunderjaw', 'lake', 4, 60, 85, 14.8, 0.15, 0.6, 'U', 'T', { c: 1, s: 0.8 }, 'SF', 30, [1.05, 1.8, 1.4, 1.2, 0, 0, 1], ['pike', '#5e5b38', '#ece6c0', '#2f2c18', 'tiger'],
    { beh: 'leaper', lore: 'A tiger-barred muskie that strikes when the lightning does. It spends half the fight in the air.', hint: 'Glass Lake at dusk in a storm, a fast crankbait. Summer or fall.' });
  sp('frostmaw', 'Frostmaw', 'ice', 4, 40, 60, 14.6, 0.3, 0.9, 'N', 'rf', { j: 1, b: 0.6 }, 'W', 30, [1.0, 1.8, 1.3, 0, 0, 1, 1], ['pike', '#c9dde6', '#f6fafc', '#5d7d8c', 'beans'],
    { beh: 'circler', lore: 'A blue-white pike that circles under the ice and turns on a coin. Steer with every turn or the line saws on the shelf.', hint: 'The ice hole on a snowy or foggy winter night, jigging.' });
  sp('ironscale', 'Ironscale', 'pier', 4, 250, 380, 14.2, 0.1, 0.6, 'A', 'oT', { b: 1, c: 0.6 }, 'S', 12, [1.1, 2.0, 1.4, 2.0, 0, 1, 1], ['tarpon', '#7d8a90', '#e8ecee', '#4d585c', 'scales'],
    { beh: 'leaper', lore: 'Scales like hammered pewter. The old pier hands say it has thrown a hundred hooks — bow to it when it jumps.', hint: 'Saltwind Pier at a grey summer dawn.' });
  sp('lantern', 'The Lantern Queen', 'deep', 4, 80, 140, 7.5, 0.85, 1, 'N', 'of', { d: 1 }, 'FW', 40, [1.0, 1.9, 1.0, 0, 0, 2, 0], ['angler', '#2c2440', '#4a3e60', '#7ff0d8', 'speck'],
    { beh: 'phantom', lore: 'A deep-water angler that hunts by a light of her own. When she runs her glow goes dark, and you must read the line.', hint: 'The Blue Shelf at night, a deep rig on the bottom. Fall or winter.' });
  sp('sailking', 'Abyssal Sailking', 'deep', 4, 1400, 2000, 13.6, 0.03, 0.35, 'D', 's', { c: 1, s: 0.8 }, 'S', 8, [1.2, 2.2, 1.8, 1.6, 0, 0, 1], ['marlin', '#12245a', '#dde6f2', '#8a5ce0', 'bars'],
    { beh: 'sprinter', lore: 'A marlin with a violet sail, said to outrun the boat\'s wake. Bring every metre of line you own.', hint: 'The Blue Shelf on a sunny summer day, trolling fast lures.' });

  function speciesAt(locId) { return SPECIES.filter(function (s) { return s.locs.indexOf(locId) >= 0; }); }
  function condAt(seed, day, min, locId) {
    var w = weatherAt(seed, day, min);
    return { band: bandOf(min), wx: w.w, wind: w.wind, wdir: w.wdir, season: seasonOf(day), loc: locId };
  }
  // How lively a species is right now (0.1 .. ~1.9).
  function activity(s, c) {
    var a = (s.times & c.band) ? 1.15 : 0.38;
    a *= s.wx.indexOf(c.wx) >= 0 ? 1.4 : (c.wx === 3 ? 0.72 : 0.92);
    a *= (s.seas & (1 << c.season)) ? 1 : 0.3;
    if (c.band === NIGHT && !(s.times & NIGHT)) a *= 0.7;
    return a;
  }
  function legendReady(s, c) {
    return s.rar === 4 && !!(s.times & c.band) && s.wx.indexOf(c.wx) >= 0 && !!(s.seas & (1 << c.season));
  }
  function spawnWeight(s, c) {
    if (s.rar === 4) return legendReady(s, c) ? 0.32 : 0;
    var a = activity(s, c);
    return RAR_W[s.rar] * Math.pow(a, 1.3) * (s.sch ? 0.55 : 1);
  }
  function pickSpecies(r, locId, c, noLegend) {
    var pool = speciesAt(locId).filter(function (s) { return !(noLegend && s.rar === 4); });
    var w = pool.map(function (s) { return spawnWeight(s, c); });
    return pool[pickW(r(), w)];
  }
  // Most fish are small; a few are trophies. bias > 0 skews bigger.
  function rollSize(r, s, bias) {
    var u = r(), k = Math.max(0.9, 2.3 - (bias || 0));
    var t = Math.pow(u, k);
    if (r() < 0.03 + (bias || 0) * 0.03) t = 0.78 + 0.22 * r();
    var w = s.wmin + (s.wmax - s.wmin) * t;
    w = Math.round(w * (w < 10 ? 100 : 10)) / (w < 10 ? 100 : 10);
    var len = Math.round(s.lk * Math.cbrt(w) * 10) / 10;
    return { w: w, len: len };
  }
  function freshness(caughtAt, now, cooler) {
    var hrs = Math.max(0, now - caughtAt) / 60;
    return clamp(1 - hrs * (cooler ? 0.018 : 0.07), 0.35, 1);
  }
  function priceOf(s, w, fresh, rep) {
    return Math.max(1, Math.round(s.price * w * RAR_PRICE[s.rar] * (fresh == null ? 1 : fresh) * (1 + Math.min(0.25, (rep || 0) / 400))));
  }
  function releaseRep(s, w) { return Math.max(1, Math.round([1, 2, 5, 12, 40][s.rar] + Math.sqrt(w) * 0.6)); }
  function catchXp(s, w) { return Math.round(RAR_XP[s.rar] + Math.sqrt(Math.max(0, w)) * 4); }
  function cumXp(l) { return l <= 1 ? 0 : Math.round(60 * Math.pow(l - 1, 2.1)); }
  function levelOf(xp) { var l = 1; while (l < 40 && xp >= cumXp(l + 1)) l++; return l; }
  function absMin(day, min) { return day * 1440 + min; }

  // ---- the world: fish, the lure, the fight ----
  function gearStats(rod, reel, line, lureId, extra) {
    return { rod: RODS[clamp(rod | 0, 0, RODS.length - 1)], reel: REELS[clamp(reel | 0, 0, REELS.length - 1)], line: LINES[clamp(line | 0, 0, LINES.length - 1)],
      lure: LURE[lureId] || LURES[0], finder: !!(extra && extra.finder) };
  }
  function newWorld(o) {
    var L = LOC[o.loc] || LOCS[0], st = standOf(L);
    var W = {
      L: L, st: st, lay: genLayout(o.layoutSeed != null ? o.layoutSeed : hash(o.seed, L.id), L),
      seed: o.seed >>> 0, day: o.day || 1, min: o.min == null ? 360 : o.min, t: 0,
      r: mulberry32(hash(o.seed, 'world', o.day || 1, Math.floor(o.min || 0), L.id, o.salt || 0)),
      gear: o.gear || gearStats(0, 0, 0, 'b'), diff: DIFFS[o.diff] || DIFFS.normal,
      fish: [], ev: [], phase: 'ready', lure: null, fight: null, biter: null,
      floatD: o.floatD || 1.5, dragSet: o.dragSet || 0.65, bait: o.bait == null ? 99 : o.bait, legend: !!o.noLegend, fixedCond: o.cond || null,
      condT: 0, spawnT: 6, nid: 1, twitches: [], lastTwitch: -9, wobble: 0
    };
    W.cond = W.fixedCond || condAt(W.seed, W.day, W.min, L.id);
    var n = L.n;
    for (var i = 0; i < 60 && W.fish.length < n; i++) spawnFish(W, false);
    return W;
  }
  function bandY(W, s, x) {
    var b = depthAt(W.lay, x), top = W.st.iceT ? W.st.iceT + 0.15 : (s.d0 < 0.05 ? 0.12 : 0.3);
    var y0 = Math.max(top, s.d0 * b), y1 = Math.max(y0 + 0.1, Math.min(b - 0.18, s.d1 * b));
    if (W.L.id === 'deep') { y0 = Math.max(top, s.d0 < 0.5 ? s.d0 * 30 : s.d0 * b); y1 = Math.max(y0 + 0.3, s.d1 < 0.6 ? s.d1 * 40 : Math.min(b - 0.3, s.d1 * b)); }
    return [y0, y1];
  }
  function newFish(W, s, x, y) {
    var r = W.r, sz = rollSize(r, s, 0);
    return {
      id: W.nid++, sp: s, w: sz.w, len: sz.len, lm: sz.len * 0.0254, x: x, y: y, vx: 0, vy: 0, dir: r() < 0.5 ? -1 : 1, st: 'wander',
      tx: x, ty: y, tT: 0, lead: null, cd: 1 + r() * 3, t: 0, nib: 0, nibT: 0, win: 0, wig: r() * 6.28, gone: false, ox: (r() - 0.5) * 1.2, oy: (r() - 0.5) * 0.6
    };
  }
  function cruise(f) { return (0.22 + 0.55 * Math.sqrt(Math.min(3.5, f.lm))) * f.sp.spd; }
  function spawnFish(W, edge) {
    var r = W.r, s = pickSpecies(r, W.L.id, W.cond, W.legend);
    if (!s) return;
    if (s.rar === 4) W.legend = true;
    var lo = W.st.minX + 1.2, x = edge ? (r() < 0.75 ? W.lay.W - 0.6 : lo + r() * (W.lay.W - lo)) : lo + r() * (W.lay.W - lo - 0.5);
    var b = bandY(W, s, x), y = lerp(b[0], b[1], r());
    var lead = newFish(W, s, x, y);
    if (s.rar === 4) { var big = rollSize(r, s, 1.2); lead.w = big.w; lead.len = big.len; lead.lm = big.len * 0.0254; }
    W.fish.push(lead);
    if (s.sch) {
      var k = 2 + Math.floor(r() * 3);
      for (var i = 0; i < k; i++) {
        var m = newFish(W, s, clamp(x + (r() - 0.5) * 2, lo, W.lay.W - 0.4), clamp(y + (r() - 0.5) * 0.8, b[0], b[1]));
        m.lead = lead; W.fish.push(m);
      }
    }
  }
  function ev(W, type, o) { var e = o || {}; e.type = type; W.ev.push(e); return e; }

  // ---- casting ----
  function castRange(W) {
    var g = W.gear, lu = g.lure, m = g.rod.cast * (lu.heavy ? 0.72 : lu.surface ? 0.8 : lu.bob ? 0.9 : 1);
    if (W.L.stand === 'boat') m *= 0.8;
    return Math.min(m, W.lay.W - W.st.castFrom - 0.6);
  }
  // Where a cast of this power lands without wind or error.
  function castAim(W, power) { return W.st.castFrom + 2 + clamp(power, 0, 1) * (castRange(W) - 2); }
  function cast(W, power, quality) {
    if (W.phase !== 'ready') return false;
    var g = W.gear, lu = g.lure, r = W.r, st = W.st;
    if (lu.bob && W.bait <= 0) { ev(W, 'nobait'); return false; }
    if (lu.salt && !W.L.salt) { ev(W, 'nosalt'); return false; }
    W.lure = { def: lu, x: st.tip.x, y: st.tip.y, vx: 0, vy: 0, baited: !!lu.bob || !!lu.scent, bx: 0, by: 0, bobY: 0, spd: 0, moving: 0, landT: W.t, sx: st.tip.x, sy: st.tip.y };
    if (st.hole) {                                         // through the ice: drop it
      W.lure.x = st.hole; W.lure.y = 0.3; W.phase = 'fishing';
      if (lu.bob) { W.lure.bx = st.hole; }
      ev(W, 'drop', { x: st.hole });
      return true;
    }
    power = clamp(power, 0.05, 1); quality = clamp(quality == null ? 0.6 : quality, 0, 1);
    var perfect = quality >= 0.98, T = 0.55 + 0.75 * power, c = W.cond;
    var dist = castAim(W, power) - st.castFrom;
    if (perfect) dist *= 1.06;
    var spread = (1 - quality) * (1.2 + 2.2 * power) * (r() * 2 - 1);
    var drift = c.wdir * c.wind * T * (lu.surface ? 2.6 : lu.heavy ? 0.8 : 1.7);
    var X = clamp(st.castFrom + dist + spread + drift, st.minX + 1, W.lay.W - 0.5);
    W.fl = { t: 0, T: T, x0: st.tip.x, y0: st.tip.y, x1: X, h: 1.2 + power * 3.2, perfect: perfect, drift: drift };
    W.phase = 'flight';
    ev(W, 'cast', { power: power, perfect: perfect });
    return true;
  }
  function stepFlight(W, dt) {
    var f = W.fl, lu = W.lure;
    f.t += dt;
    var u = Math.min(1, f.t / f.T);
    lu.x = lerp(f.x0, f.x1, u);
    lu.y = lerp(f.y0, 0, u * u) - f.h * 4 * u * (1 - u);
    if (u >= 1) {
      lu.y = lu.def.surface ? 0.03 : 0.05; lu.vx = 0; lu.vy = lu.def.sink * 0.5; lu.landT = W.t;
      if (lu.def.bob) { lu.bx = lu.x; lu.y = 0.1; }
      W.phase = 'fishing'; W.fl = null;
      ev(W, 'splash', { x: lu.x, big: lu.def.heavy ? 1 : 0, perfect: f.perfect });
      // the splash spooks fish right under it and draws the curious
      for (var i = 0; i < W.fish.length; i++) {
        var fi = W.fish[i], d = Math.hypot(fi.x - lu.x, (fi.y - lu.y) * 1.3);
        if (fi.st !== 'wander') continue;
        if (d < 1.1 && !fi.sp.chase) flee(W, fi, lu.x, lu.y);
        else if (d < 5 && fi.sp.chase && W.r() < 0.5) fi.cd = Math.min(fi.cd, 0);
      }
    }
  }

  // ---- the lure in the water ----
  function lureBottom(W, x) { return depthAt(W.lay, x) - 0.1; }
  function stepLure(W, dt, inp) {
    var lu = W.lure, d = lu.def, st = W.st, g = W.gear, c = W.cond, reel = !!inp.reel;
    var bot = lureBottom(W, lu.x), ax = st.anc.x, ay = W.st.hole ? -1 : st.anc.y;
    var dx = ax - lu.x, dy = ay - lu.y, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
    var rs = g.reel.speed, tvx = 0, tvy = 0, cur = W.L.cur * (1 - 0.5 * clamp(lu.y / W.lay.maxD, 0, 1));
    var top = st.iceT ? (Math.abs(lu.x - st.hole) < 0.35 ? 0.05 : st.iceT + 0.05) : 0.05;
    if (d.bob) {
      // a float on top, the bait hanging under it at the set depth
      var want = Math.min(W.floatD, bot);
      if (reel) { lu.bx += (ax - lu.bx) * 0 + Math.sign(ax - lu.bx) * rs * 0.85 * dt; want *= 0.7; }
      else if (!st.hole) lu.bx += (cur + c.wdir * c.wind * 0.05) * dt;
      if (st.hole) lu.bx = st.hole;
      lu.bx = clamp(lu.bx, st.minX, W.lay.W - 0.3);
      var px = lu.x, py = lu.y;
      lu.x += (lu.bx - lu.x) * Math.min(1, dt * 3);
      lu.y += clamp(want - lu.y, -0.8 * dt, d.sink * dt);
      lu.vx = (lu.x - px) / dt; lu.vy = (lu.y - py) / dt;
    } else {
      if (reel) {
        var k = rs * (d.surface ? 0.55 : d.heavy ? 0.8 : 1) * (W.L.reelMul ? W.L.reelMul * 1.5 : 1);
        tvx = ux * k; tvy = uy * k;
        if (d.dive) { var dv = Math.min(d.dive, bot - 0.2); if (!st.hole) tvy = clamp((dv - lu.y) * 1.6, -0.8, 1.1) + uy * k * 0.25; }
        if (d.rise) tvy -= d.rise * 0.4;
        if (d.surface) tvy = 0;
      } else {
        tvx = cur; tvy = d.sink;
        if (d.surface) tvy = 0;
      }
      var a = Math.min(1, dt * (reel ? 5 : 2.5));
      lu.vx += (tvx - lu.vx) * a;
      lu.vy += (tvy - lu.vy) * a;
      lu.x += lu.vx * dt; lu.y += lu.vy * dt;
      if (d.surface) lu.y = 0.03;
    }
    if (inp.twitch) twitch(W, inp.twitch);
    if (lu.y > bot) { lu.y = bot; lu.vy = Math.min(0, lu.vy); lu.vx *= 0.9; }
    if (lu.y < top) { lu.y = top; lu.vy = Math.max(0, lu.vy); }
    lu.x = clamp(lu.x, st.hole ? st.hole - 1.5 : st.minX - 0.5, W.lay.W - 0.3);
    if (st.hole) lu.x += (st.hole - lu.x) * Math.min(1, dt * 0.6);
    lu.spd = Math.hypot(lu.vx, lu.vy);
    lu.moving = reel ? 1 : 0;
    // Reeled all the way in?
    lu.maxY = Math.max(lu.maxY || 0, lu.y);
    var near = st.hole ? lu.y < 0.45 && lu.maxY > 0.9 : (lu.x <= st.minX + 0.15 || (Math.abs(lu.x - st.anc.x) < 1.4 && lu.y < 0.5 && reel));
    if (near && reel && W.t - lu.landT > 0.6) { W.phase = 'ready'; W.lure = null; releaseBiter(W, false); ev(W, 'in'); }
  }
  function twitch(W, n) {
    var lu = W.lure, d = lu.def;
    if (!lu || W.phase !== 'fishing') return;
    W.lastTwitch = W.t;
    W.twitches.push(W.t);
    while (W.twitches.length && W.t - W.twitches[0] > 2.5) W.twitches.shift();
    if (d.bob) { lu.bobJig = 0.25; }
    else if (d.hop) { lu.vy -= d.hop; lu.vx += Math.sign(W.st.anc.x - lu.x) * 0.25; }
    else if (d.surface) { lu.vx += Math.sign(W.st.anc.x - lu.x) * 0.7; }
    else { lu.vx += Math.sign(W.st.anc.x - lu.x) * 0.75; lu.vy -= 0.25; }
    ev(W, 'twitch');
    var b = W.biter;
    if (b && b.st === 'nibble') {
      var love = (b.sp.lures[d.id] || 0);
      if (d.hop && love >= 0.8 && W.r() < 0.6) strike(W, b);
      else if (W.r() < (d.bob ? 0.25 : 0.5)) { ev(W, 'spooked', { x: b.x, y: b.y }); flee(W, b, lu.x, lu.y); }
    }
  }
  // How much a fish wants this lure moving like this.
  function appeal(W, f) {
    var lu = W.lure, d = lu.def, s = f.sp;
    if (!lu.baited && d.bob) return 0;
    var a = (s.lures[d.id] || 0.04) * activity(s, W.cond);
    if (d.ideal > 0) {
      var sp = lu.moving ? lu.spd : 0;
      a *= clamp(1 - Math.abs(sp - d.ideal) / (d.ideal + 0.7), 0.15, 1) * (s.chase || !lu.moving ? 1 : 0.7);
    } else a *= clamp(1 - lu.spd / 0.8, 0.2, 1);
    var since = W.t - W.lastTwitch;
    if (since < 1.2) a *= d.hop ? 1.6 : 1.25;
    if (W.twitches.length > 5) a *= 0.4;                  // thrashing it about
    if (W.t - lu.landT < 2 && !s.chase) a *= 0.6;
    return a * W.diff.bite;
  }
  function light(W, y) {
    var c = W.cond, l = Math.exp(-Math.max(0, y) / W.L.clar);
    l *= c.band === NIGHT ? 0.4 : c.band === DAY ? 1 : 0.72;
    l *= [1, 0.85, 0.8, 0.65, 0.75][c.wx];
    return l;
  }
  function vision(W, f) {
    var lu = W.lure, d = lu.def, l = light(W, (f.y + lu.y) / 2), v = 3.6 * (0.3 + 0.7 * l) * (0.8 + 0.2 * f.sp.spd) * (W.L.vis || 1);
    if (d.flash) v *= 1.15 + 0.4 * (1 - l);
    if (d.scent && lu.baited) v = Math.max(v, d.scent);
    return v;
  }
  function flee(W, f, fx, fy) {
    if (W.biter === f) W.biter = null;
    f.st = 'flee'; f.t = 0; f.cd = 7 + W.r() * 6;
    var dx = f.x - fx, dy = f.y - fy, dl = Math.hypot(dx, dy) || 1;
    f.tx = clamp(f.x + dx / dl * 6, 1, W.lay.W - 0.4); f.ty = f.y + dy / dl * 2;
  }
  function releaseBiter(W, spook) {
    var b = W.biter;
    if (!b) return;
    W.biter = null;
    if (spook && W.lure) flee(W, b, W.lure.x, W.lure.y); else { b.st = 'wander'; b.cd = 4; b.t = 0; }
  }
  function strike(W, f) {
    var g = W.gear;
    f.st = 'strike'; f.t = 0;
    f.win = 0.5 * W.diff.win * (1 + 0.55 * g.rod.sens) * (f.sp.rar === 4 ? 0.85 : 1);
    W.biter = f;
    ev(W, 'strike', { x: f.x, y: f.y, win: f.win });
  }
  function hook(W) {
    if (W.phase !== 'fishing') return 'none';
    var b = W.biter;
    if (b && b.st === 'strike') { startFight(W, b, b.t / b.win); return 'hooked'; }
    if (b && b.st === 'nibble') {
      ev(W, 'early', { x: b.x, y: b.y });
      flee(W, b, W.lure.x, W.lure.y);
      for (var i = 0; i < W.fish.length; i++) {
        var o = W.fish[i];
        if (o !== b && (o.st === 'wander' || o.st === 'follow') && Math.hypot(o.x - W.lure.x, o.y - W.lure.y) < 2.6) { if (W.r() < 0.6) flee(W, o, W.lure.x, W.lure.y); else o.cd = 6; }
      }
      return 'early';
    }
    // nothing on: a rip of the rod — a big twitch
    twitch(W, 1);
    if (W.lure && !W.lure.def.bob) { W.lure.vx += Math.sign(W.st.anc.x - W.lure.x) * 0.8; }
    ev(W, 'rip');
    return 'rip';
  }

  // ---- fish AI ----
  function steerTo(f, tx, ty, spd, dt, acc) {
    var dx = tx - f.x, dy = ty - f.y, dl = Math.hypot(dx, dy);
    var k = dl > 0.001 ? Math.min(spd, dl * 1.8) / dl : 0;
    var a = Math.min(1, dt * (acc || 2.2));
    f.vx += (dx * k - f.vx) * a;
    f.vy += (dy * k - f.vy) * a;
  }
  function stepFish(W, dt) {
    var r = W.r, lu = W.phase === 'fishing' ? W.lure : null, fish = W.fish, i, j;
    for (i = 0; i < fish.length; i++) {
      var f = fish[i], s = f.sp;
      if (f.st === 'hooked') continue;
      f.t += dt; f.cd -= dt; f.wig += dt * (3 + Math.hypot(f.vx, f.vy) * 6);
      var cr = cruise(f), bnd = bandY(W, s, f.x);
      switch (f.st) {
        case 'wander': {
          var L = f.lead && !f.lead.gone && f.lead.st === 'wander' ? f.lead : null;
          if (L) { steerTo(f, L.x + f.ox, L.y + f.oy, cr * 1.25, dt); }
          else {
            f.tT -= dt;
            if (f.tT <= 0 || Math.hypot(f.tx - f.x, f.ty - f.y) < 0.3) {
              f.tx = clamp(f.x + (r() - 0.5) * 10, W.st.minX + 1, W.lay.W - 0.4);
              var b2 = bandY(W, s, f.tx);
              f.ty = lerp(b2[0], b2[1], r()); f.tT = 3 + r() * 6;
              if (r() < 0.06 && f.x > W.lay.W - 4 && W.fish.length > 4) f.leave = true;
              if (f.leave) f.tx = W.lay.W + 2;
            }
            steerTo(f, f.tx, f.ty, cr * (0.5 + 0.3 * Math.sin(f.wig * 0.1)), dt);
          }
          if (lu && f.cd <= 0) {
            var dx = lu.x - f.x, dy = lu.y - f.y, dd = Math.hypot(dx, dy * 1.4);
            if (dd < vision(W, f)) {
              var ap = appeal(W, f);
              if (r() < ap * 0.9 * dt) { f.st = 'follow'; f.t = 0; }
              else if (r() < 0.25 * dt) f.cd = 2 + r() * 3;
            } else if (dd < vision(W, f) * 2.6 && !L && r() < appeal(W, f) * 0.5 * dt) {
              f.tx = lu.x + (r() - 0.5) * 1.5; f.ty = lu.y + (r() - 0.5) * 0.8; f.tT = 4;       // drawn over to have a look
            }
          }
          break;
        }
        case 'follow': {
          if (!lu) { f.st = 'wander'; f.cd = 3; break; }
          var side = f.x < lu.x ? -1 : 1, mx = lu.x + side * f.lm * 0.45, my = lu.y + 0.02;
          steerTo(f, mx, my, cr * 2, dt, 3);
          var dist = Math.hypot(lu.x - f.x, lu.y - f.y), close = dist < 0.3 + f.lm * 0.55;
          if (f.t > 9 || (lu.moving && lu.spd > 1.9 * s.spd)) { f.st = 'wander'; f.cd = 3 + r() * 4; break; }
          if (close) {
            if (lu.moving && lu.spd > 0.25) {
              if (s.chase && !W.biter && r() < 1.4 * appeal(W, f) * dt) strike(W, f);
            } else if (!W.biter) {
              if (s.nib === 0 || (s.chase && r() < 0.35)) strike(W, f);
              else { f.st = 'nibble'; f.t = 0; f.nib = 1 + Math.floor(r() * s.nib); f.nibT = 0.6 + r() * 0.9; W.biter = f; }
            } else if (f.t > 4) { f.st = 'wander'; f.cd = 4; }
          }
          break;
        }
        case 'nibble': {
          if (!lu) { W.biter = null; f.st = 'wander'; break; }
          var sd = f.x < lu.x ? -1 : 1;
          steerTo(f, lu.x + sd * f.lm * 0.42, lu.y, cr * 2, dt, 6);
          if (lu.spd > 0.6) { W.biter = null; f.st = s.chase ? 'follow' : 'wander'; f.t = 0; f.cd = 2; break; }
          f.nibT -= dt;
          if (f.nibT <= 0) {
            if (f.nib <= 0) strike(W, f);
            else { f.nib--; f.nibT = 0.5 + r() * 1.0; ev(W, 'nibble', { x: f.x, y: f.y, k: 0.4 + r() * 0.6 }); }
          }
          break;
        }
        case 'strike': {
          if (!lu) { W.biter = null; f.st = 'wander'; break; }
          var sd2 = f.x < lu.x ? -1 : 1;
          steerTo(f, lu.x + sd2 * f.lm * 0.4 + sd2 * 0.4, lu.y + 0.15, cr * 3, dt, 8);
          lu.x += (f.vx * 0.3) * dt; lu.y += 0.2 * dt;
          if (f.t > f.win) {
            ev(W, 'missed', { x: f.x, y: f.y, bait: !!(lu.def.bob || lu.def.scent) });
            if (lu.def.bob || lu.def.scent) lu.baited = false;
            flee(W, f, lu.x, lu.y);
          }
          break;
        }
        case 'flee': {
          steerTo(f, f.tx, f.ty, cr * 3.2, dt, 4);
          if (f.t > 2.2) { f.st = 'wander'; f.tT = 0; }
          break;
        }
      }
      // schoolmates keep a little room
      if (s.sch && f.st === 'wander') {
        for (j = 0; j < fish.length; j++) {
          var o = fish[j];
          if (o === f || o.sp !== s) continue;
          var ex = f.x - o.x, ey = f.y - o.y, e2 = ex * ex + ey * ey;
          if (e2 < 0.16 && e2 > 1e-6) { f.vx += ex / e2 * 0.02; f.vy += ey / e2 * 0.02; }
        }
      }
      f.x += f.vx * dt; f.y += f.vy * dt;
      var bot = depthAt(W.lay, f.x) - 0.12, top = W.st.iceT ? W.st.iceT + 0.1 : (s.d0 < 0.05 ? 0.06 : 0.15);
      if (f.y > bot) { f.y = bot; f.vy = Math.min(0, f.vy); if (f.st === 'wander') f.ty = Math.min(f.ty, bot - 0.2); }
      if (f.y < top) { f.y = top; f.vy = Math.max(0, f.vy); }
      if (f.x < W.st.minX + 0.6) { f.x = W.st.minX + 0.6; f.vx = Math.abs(f.vx); }
      if (Math.abs(f.vx) > 0.04) f.dir = f.vx > 0 ? 1 : -1;
      if (f.x > W.lay.W + 1) f.gone = true;
    }
    for (i = fish.length - 1; i >= 0; i--) if (fish[i].gone) { if (W.biter === fish[i]) W.biter = null; fish.splice(i, 1); }
  }

  // ---- the fight ----
  function fmax(W, f) { return f.sp.pow * 1.15 * Math.pow(f.w, 0.62) * W.diff.pow * (f.sp.rar === 4 ? 1.2 : 1); }
  function startFight(W, f, early) {
    var anc = W.st.anc, d = Math.hypot(f.x - anc.x, f.y - anc.y), s = f.sp;
    var sta0 = s.sta * (6 + 5 * Math.pow(f.w, 0.38)) * W.diff.sta;
    W.biter = null;
    f.st = 'hooked';
    W.fight = { f: f, d: d + 0.3, T: 0.3, spike: 0, sta0: sta0, sta: sta0, mode: 'run', mT: 0.6 + W.r() * 1.2, dir: f.x > anc.x ? 1 : -1, slackT: 0, air: false, airT: 0, shake: 0,
      solid: early < 0.6, slip: 0, feint: false, jumps: 0, t: 0, dark: false, load: 0, maxT: 0, chafe: 0 };
    W.phase = 'fight';
    ev(W, 'hooked', { solid: early < 0.6, x: f.x, y: f.y });
  }
  function pickMode(W, F) {
    var f = F.f, s = f.sp, r = W.r, beh = s.beh;
    var w = [1.2 * s.spd, 1.3, 0.9, 0.8, (f.y < 4 || W.L.id !== 'deep') && s.jmp && !W.st.iceT ? s.jmp * 0.7 : 0];   // run dart rest dive jump
    if (beh === 'leaper') w[4] *= 3;
    if (beh === 'sounder' || beh === 'anchor' || beh === 'phantom') w[3] *= 2.5;
    if (beh === 'sprinter') w[0] *= 2;
    if (beh === 'circler') w[1] *= 3;
    var m = ['run', 'dart', 'rest', 'dive', 'jump'][pickW(r(), w)];
    F.mode = m;
    F.mT = m === 'run' ? (beh === 'sprinter' ? 3 + r() * 3 : 1.2 + r() * 2) : m === 'dart' ? (beh === 'circler' ? 0.5 + r() * 0.6 : 0.9 + r() * 1.3) : m === 'rest' ? 1 + r() * 1.8 : m === 'dive' ? 1.2 + r() * 1.8 : 3;
    if (m === 'dart' || (m === 'run' && r() < 0.5)) F.dir = r() < 0.5 ? -1 : 1;
    if (m === 'run' && r() < 0.6) F.dir = 1;
    F.dark = beh === 'phantom' && (m === 'run' || m === 'dart') && r() < 0.7;
    if (m === 'jump') ev(W, 'jumpcue');
  }
  // inp: { reel, steer -1..1 }
  function stepFight(W, dt, inp) {
    var F = W.fight, f = F.f, s = f.sp, g = W.gear, D = W.diff, anc = W.st.anc, r = W.r;
    F.t += dt;
    var Fm = fmax(W, f), cr = cruise(f), burst = cr * 3.4;
    var tired = F.sta <= 0;
    if (!F.air) {
      F.mT -= dt;
      if (tired) F.mode = 'tired';
      else if (F.mT <= 0) pickMode(W, F);
    }
    if (s.beh === 'feint' && !F.feint && F.sta < F.sta0 * 0.22) { F.feint = true; F.sta += F.sta0 * 0.45; F.mode = 'run'; F.mT = 3; F.dir = 1; tired = false; ev(W, 'surge'); }
    // where the fish wants to go
    var bot = depthAt(W.lay, f.x) - 0.15, top = W.st.iceT ? W.st.iceT + 0.1 : 0.2, tvx = 0, tvy = 0, eff = 1;
    switch (F.mode) {
      case 'run': tvx = F.dir * burst * (s.beh === 'sprinter' ? 1.3 : 1); tvy = (r() - 0.4) * cr; eff = 1.7 + 0.3 * s.spd; if (s.beh === 'sprinter') eff = 2.3; break;
      case 'dart': tvx = F.dir * cr * 2.2; tvy = Math.sin(F.t * 3) * cr * 0.6; eff = 1.05; if (r() < dt * 1.5) F.spike += 0.12 * (1.15 - g.reel.smooth); break;
      case 'rest': tvx = F.dir * cr * 0.3; tvy = 0; eff = 0.35; break;
      case 'dive': tvx = F.dir * cr * 0.5; tvy = cr * 2.2; eff = s.beh === 'sounder' || s.beh === 'phantom' ? 1.7 : 1.3; break;
      case 'tired': tvx = (anc.x - f.x) * 0.1; tvy = -0.1; eff = 0.14; break;
      case 'jump': eff = 0.5; break;
    }
    // jumping: rise, leave the water, fall back
    if (F.mode === 'jump' && !F.air) {
      tvx = F.dir * cr * 1.5; tvy = -burst;
      if (f.y < 0.5 || W.st.iceT) {
        if (W.st.iceT) { F.mode = 'dart'; F.mT = 1; }
        else { F.air = true; F.airT = 0; f.vy = -(3.2 + r() * 2.4); f.vx = F.dir * (1 + r()); F.jumps++; ev(W, 'jump', { x: f.x }); }
      }
    }
    var reeling = !!inp.reel, steer = clamp(inp.steer || 0, -1, 1);
    if (F.air) {
      F.airT += dt;
      f.vy += 9.8 * dt; f.x += f.vx * dt; f.y += f.vy * dt;
      if (reeling && F.T > 0.18) F.shake += dt * 1.35 * D.jump * (s.rar >= 3 ? 1.2 : 1);
      if (f.y > 0.1 && f.vy > 0) { F.air = false; f.y = 0.3; F.mode = 'dart'; F.mT = 0.8; ev(W, 'splash', { x: f.x, big: 1 }); }
      if (F.shake > 0.5) { F.why = 'jump'; endFight(W, 'throw'); return; }
    } else {
      var a = Math.min(1, dt * 3.5);
      f.vx += (tvx - f.vx) * a; f.vy += (tvy - f.vy) * a;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.y = clamp(f.y, top, Math.max(top, bot));
      f.x = clamp(f.x, W.st.minX + 0.2, W.lay.W + 40);
      F.shake = Math.max(0, F.shake - dt * 0.2);
    }
    f.wig += dt * (6 + eff * 8);
    if (Math.abs(f.vx) > 0.05) f.dir = f.vx > 0 ? 1 : -1;
    // the line
    var dist = Math.hypot(f.x - anc.x, f.y - anc.y);
    var hd = Math.abs(f.vx) > 0.15 ? (f.vx > 0 ? 1 : -1) : F.dir;
    var cn = -steer * hd;                                   // > 0: rod held against its run
    var pull = Fm * eff * (0.3 + 0.7 * Math.max(0, F.sta / F.sta0));
    if (F.air) pull = 0;
    var pullEff = pull * (1 - 0.32 * cn);
    if (s.beh === 'circler' && cn < -0.2) { F.chafe += dt * 0.6; F.spike += dt * 0.5; }
    var lineLb = g.line.lb, dragLb = Math.max(0.5, Math.min(g.reel.drag, lineLb * W.dragSet)), rp = g.rod.pow;
    var rs = g.reel.speed * (0.6 + 0.5 * rp) * (W.L.reelMul || 1), load, eload, slack = false;
    if (dist < F.d - 0.12) {
      slack = true; load = 0; eload = 0;
      if (reeling) F.d = Math.max(dist, F.d - rs * 2.4 * dt);
    } else {
      load = pullEff + (reeling ? (0.4 - 0.22 * rp) * pullEff + 0.1 * lineLb * (1 - 0.4 * rp) : 0);
      if (load > dragLb) {
        var ex = (load - dragLb) / dragLb;
        var pay = Math.min(burst * 1.2, (0.4 + ex * 2.6) * cr * 1.6);
        F.d = Math.min(F.d + pay * dt, Math.max(F.d, dist)); F.slip = pay;
        eload = dragLb + (load - dragLb) * (reeling ? 0.55 : 0.12) * (1.25 - g.reel.smooth);
      } else {
        F.slip = 0; eload = load;
        if (reeling) {
          var gain = rs * (1 - 0.75 * load / dragLb);
          if (s.beh === 'anchor' && f.y > bot - 0.7 && cn < 0.3) gain *= 0.3;
          F.d -= gain * dt;
        }
      }
      if (dist > F.d) {                                      // the line holds it to its length
        var k = F.d / dist;
        f.x = anc.x + (f.x - anc.x) * k; f.y = anc.y + (f.y - anc.y) * k;
        if (f.y < top && !F.air) f.y = top;
      }
    }
    F.load = load;
    var minD = W.st.hole ? 0.4 : Math.abs(anc.y) + 0.3;
    if (F.d < minD) F.d = minD;
    var Tt = eload / lineLb + F.spike;
    F.spike = Math.max(0, F.spike - dt * 1.6);
    F.T += (Tt - F.T) * Math.min(1, dt * 9);
    if (D.noSnap && F.T > 0.96) { F.T = 0.96; F.d += cr * dt; }
    F.maxT = Math.max(F.maxT, F.T);
    if (F.T >= 1 || F.chafe >= 1) { endFight(W, 'snap'); return; }
    if (F.d > g.reel.spool) { endFight(W, 'spooled'); return; }
    if (F.T < 0.06 && !F.air) F.slackT += dt; else F.slackT = Math.max(0, F.slackT - dt * 2);
    if (F.slackT > D.slack * (F.solid ? 1 : 0.65) * (tired ? 1.6 : 1) * (1 + 1.5 / (1 + Fm))) { F.why = 'slack'; endFight(W, 'throw'); return; }
    // stamina: drained by pressure, more with the rod held against the run
    if (!slack && F.T > 0.08) F.sta -= dt * (0.3 + 0.95 * eload / Math.max(0.5, Fm)) * (1 + 0.6 * Math.max(0, cn)) * (cn < -0.3 ? 0.65 : 1) * (F.mode === 'run' ? 1.25 : 1) + (F.slip > 0 ? dt * 0.5 : 0);
    else if (!tired) F.sta = Math.min(F.sta0, F.sta + dt * F.sta0 * 0.035);
    // landed?
    if (dist <= W.st.landD + 0.2 && F.d <= W.st.landD + 0.4) {
      if (tired || (D.noSnap && F.sta < F.sta0 * 0.12)) { endFight(W, 'landed'); return; }
      if (F.mode !== 'run') { F.mode = 'run'; F.mT = 1.2; F.dir = 1; ev(W, 'bolt'); }
    }
  }
  function endFight(W, why) {
    var F = W.fight, f = F.f;
    W.fight = null; W.biter = null;
    var i = W.fish.indexOf(f);
    if (i >= 0) W.fish.splice(i, 1);
    if (why === 'landed') {
      W.phase = 'landed';
      ev(W, 'landed', { sp: f.sp.id, w: f.w, len: f.len, t: F.t, x: f.x });
      W.lure = null;
      return;
    }
    if (why === 'throw') {                                   // it swims off; the lure is still on the line
      W.phase = 'fishing';
      if (W.lure) { W.lure.x = clamp(f.x, W.st.minX, W.lay.W - 0.3); W.lure.y = Math.max(0.1, f.y); W.lure.vx = 0; W.lure.vy = 0; if (W.lure.def.bob || W.lure.def.scent) W.lure.baited = false; W.lure.landT = W.t; W.lure.bx = W.lure.x; }
      f.st = 'flee'; f.t = 0; f.cd = 15; f.tx = W.lay.W + 2; f.ty = f.y; f.leave = true;
      W.fish.push(f);
    } else { W.phase = 'ready'; W.lure = null; f.st = 'flee'; f.t = 0; f.cd = 30; f.leave = true; f.tx = W.lay.W + 2; W.fish.push(f); }
    ev(W, 'lost', { why: why, how: F.why || '', sp: f.sp.id, w: f.w, x: f.x });
  }

  // One fixed step. inp: { reel, twitch, hook, steer }
  function stepWorld(W, dt, inp) {
    inp = inp || {};
    W.t += dt;
    W.min += dt * MIN_PER_SEC * (W.timeScale == null ? 1 : W.timeScale);
    W.condT -= dt;
    if (W.condT <= 0) { W.condT = 1; if (!W.fixedCond) W.cond = condAt(W.seed, W.day, W.min, W.L.id); else W.cond.band = bandOf(W.min); }
    if (W.phase === 'flight') stepFlight(W, dt);
    else if (W.phase === 'fishing') {
      if (inp.hook) hook(W);
      if (W.phase === 'fishing') stepLure(W, dt, inp);
    } else if (W.phase === 'fight') stepFight(W, dt, inp);
    stepFish(W, dt);
    W.spawnT -= dt;
    if (W.spawnT <= 0) {
      W.spawnT = 4 + W.r() * 6;
      if (W.fish.length < W.L.n) spawnFish(W, true);
    }
  }

  // ---- career ----
  function newSave(seed) {
    return {
      v: 1, seed: (seed == null ? (Date.now() ^ (Math.random() * 1e9)) : seed) >>> 0, money: 40, xp: 0, rep: 0, day: 1, min: 360, loc: 'pond', atWater: false,
      rod: 0, reel: 0, line: 0, owned: { rod: [0], reel: [0], line: [0] }, lures: { b: 1, s: 1 }, lure: 's', bait: 20,
      up: { creel: 0, cooler: 0, finder: 0, boat: 0 }, creel: [], journal: {}, contracts: [], cday: 0, tday: 0,
      stats: { caught: 0, released: 0, sold: 0, earned: 0, snaps: 0, lost: 0, tWins: 0, tPlayed: 0, cDone: 0, days: 0, best: null },
      diff: 'normal', amb: 1, floatD: 1.5, drag: 0.65, daily: {}, seen: 0
    };
  }
  function normSave(o) {
    var s = newSave(o && o.seed);
    if (!o || typeof o !== 'object' || o.v !== 1) return s;
    function num(v, d, a, b) { v = +v; return isFinite(v) ? clamp(v, a, b) : d; }
    s.money = Math.round(num(o.money, 40, 0, 1e9)); s.xp = Math.round(num(o.xp, 0, 0, 1e9)); s.rep = Math.round(num(o.rep, 0, 0, 1e7));
    s.day = Math.round(num(o.day, 1, 1, 1e6)); s.min = num(o.min, 360, DAY_START, DAY_END - 1);
    s.loc = LOC[o.loc] ? o.loc : 'pond'; s.atWater = !!o.atWater;
    ['rod', 'reel', 'line'].forEach(function (k) {
      var T = k === 'rod' ? RODS : k === 'reel' ? REELS : LINES, own = o.owned && Array.isArray(o.owned[k]) ? o.owned[k].filter(function (i) { return T[i | 0] && (i | 0) === i; }) : [];
      if (own.indexOf(0) < 0) own.unshift(0);
      s.owned[k] = own;
      s[k] = own.indexOf(o[k] | 0) >= 0 ? o[k] | 0 : 0;
    });
    s.lures = { b: 1, s: 1 };
    if (o.lures) LURES.forEach(function (l) { if (o.lures[l.id]) s.lures[l.id] = 1; });
    s.lure = s.lures[o.lure] ? o.lure : 's';
    s.bait = Math.round(num(o.bait, 20, 0, 9999));
    UPGRADES.forEach(function (u) { s.up[u.id] = Math.round(num(o.up && o.up[u.id], 0, 0, u.max)); });
    s.creel = Array.isArray(o.creel) ? o.creel.filter(function (c) { return c && SP[c.sp] && isFinite(+c.w); }).slice(0, 20).map(function (c) { return { sp: c.sp, w: +c.w, len: +c.len || 0, at: +c.at || 0 }; }) : [];
    if (o.journal && typeof o.journal === 'object') for (var k in o.journal) if (SP[k]) { var j = o.journal[k]; s.journal[k] = { n: Math.max(1, j.n | 0), best: +j.best || 0, len: +j.len || 0, day: j.day | 0, rel: j.rel | 0 }; }
    s.contracts = Array.isArray(o.contracts) ? o.contracts.filter(function (c) { return c && c.kind; }).slice(0, 4) : [];
    s.cday = o.cday | 0; s.tday = o.tday | 0;
    if (o.stats) for (var st in s.stats) if (st !== 'best' && isFinite(+o.stats[st])) s.stats[st] = +o.stats[st];
    if (o.stats && o.stats.best && SP[o.stats.best.sp]) s.stats.best = { sp: o.stats.best.sp, w: +o.stats.best.w || 0 };
    s.diff = DIFFS[o.diff] ? o.diff : 'normal';
    s.amb = o.amb === 0 ? 0 : 1;
    s.floatD = num(o.floatD, 1.5, 0.5, 8); s.drag = num(o.drag, 0.65, 0.4, 0.9);
    if (o.daily && typeof o.daily === 'object') for (var dk in o.daily) if (/^\d{4}-\d\d-\d\d$/.test(dk) && isFinite(+o.daily[dk])) s.daily[dk] = +o.daily[dk];
    s.seen = o.seen | 0;
    return s;
  }
  function creelCap(save) { return 6 + 4 * (save.up.creel | 0); }
  function locOpen(save, id) {
    var L = LOC[id];
    if (!L) return { ok: false, why: '?' };
    var lvl = levelOf(save.xp);
    if (lvl < L.lvl) return { ok: false, why: 'Level ' + L.lvl };
    if (L.boat && !save.up.boat) return { ok: false, why: 'Needs a boat' };
    if (L.winter && seasonOf(save.day) !== 3) return { ok: false, why: 'Winter only' };
    return { ok: true };
  }
  // Records a landed fish; returns what was new.
  function logCatch(save, spId, w, len, day) {
    var j = save.journal[spId], out = { first: !j, record: false };
    if (!j) j = save.journal[spId] = { n: 0, best: 0, len: 0, day: day || save.day, rel: 0 };
    j.n++;
    if (w > j.best) { out.record = j.n > 1; j.best = w; j.len = len; }
    save.stats.caught++;
    if (!save.stats.best || w > save.stats.best.w) save.stats.best = { sp: spId, w: w };
    return out;
  }
  function sellCreel(save, idxs) {
    var now = absMin(save.day, save.min), total = 0, keep = [];
    save.creel.forEach(function (c, i) {
      if (idxs && idxs.indexOf(i) < 0) { keep.push(c); return; }
      total += priceOf(SP[c.sp], c.w, freshness(c.at, now, save.up.cooler), save.rep);
      save.stats.sold++;
    });
    save.creel = keep;
    save.money += total; save.stats.earned += total;
    return total;
  }

  // ---- angler-club contracts ----
  function genContracts(save) {
    var r = mulberry32(hash(save.seed, 'ct', save.day)), lvl = levelOf(save.xp), out = [];
    var locs = LOCS.filter(function (L) { return locOpen(save, L.id).ok; }).map(function (L) { return L.id; });
    var season = seasonOf(save.day), used = {};
    var pool = SPECIES.filter(function (s) {
      return s.rar < 4 && s.rar <= (lvl >= 8 ? 2 : lvl >= 3 ? 1 : 0) + 1 && s.locs.some(function (l) { return locs.indexOf(l) >= 0; }) && (s.seas & (1 << season));
    });
    for (var k = 0; k < 3 && pool.length; k++) {
      var kind = ['size', 'count', 'size', 'release', 'bag'][Math.floor(r() * 5)];
      if (k === 0) kind = 'size';
      var s = pool[Math.floor(r() * pool.length)], c = null, tries = 0;
      while (used[s.id] && tries++ < 6) s = pool[Math.floor(r() * pool.length)];
      used[s.id] = 1;
      var lid = s.locs.filter(function (l) { return locs.indexOf(l) >= 0; })[0];
      if (kind === 'size') {
        var w = Math.round((s.wmin + (s.wmax - s.wmin) * (0.12 + 0.2 * r())) * 10) / 10, by = r() < 0.5 ? 1080 : 1440;
        c = { kind: 'size', sp: s.id, w: w, by: by, text: 'Catch a ' + w + ' lb ' + s.name + (by === 1080 ? ' before dusk' : ' today'),
          pay: Math.round(40 + priceOf(s, w, 1, 0) * 2.2), xp: 30 + s.rar * 30, rep: 3 };
      } else if (kind === 'count') {
        var n = 3 + Math.floor(r() * 3);
        c = { kind: 'count', sp: s.id, n: n, by: 1440, text: 'Land ' + n + ' ' + s.name, pay: Math.round(30 + n * priceOf(s, (s.wmin + s.wmax) / 6, 1, 0) * 1.2), xp: 20 + n * 8, rep: 2 };
      } else if (kind === 'release') {
        var n2 = 2 + Math.floor(r() * 3);
        c = { kind: 'release', n: n2, by: 1440, text: 'Release ' + n2 + ' fish', pay: 25 * n2, xp: 15 * n2, rep: 6 + n2 * 3 };
      } else {
        var lb = Math.round((6 + lvl * 4) * (0.8 + r() * 0.5) * (LOC[lid].salt ? 3 : 1));
        c = { kind: 'bag', loc: lid, w: lb, by: 1440, text: 'Land ' + lb + ' lb in total at ' + LOC[lid].name, pay: Math.round(lb * 9 + 40), xp: 40 + lb, rep: 3 };
      }
      c.id = save.day + '-' + k; c.prog = 0; c.done = false;
      out.push(c);
    }
    return out;
  }
  // e: { kind: 'catch'|'release', sp, w, loc, min }; returns the contracts finished now
  function contractEvent(save, e) {
    var done = [];
    save.contracts.forEach(function (c) {
      if (c.done || e.min > c.by) return;
      if (e.kind === 'catch') {
        if (c.kind === 'size' && e.sp === c.sp && e.w >= c.w) c.prog = 1;
        else if (c.kind === 'count' && e.sp === c.sp) c.prog++;
        else if (c.kind === 'bag' && e.loc === c.loc) c.prog = Math.round((c.prog + e.w) * 100) / 100;
      } else if (e.kind === 'release' && c.kind === 'release') c.prog++;
      var goal = c.kind === 'size' ? 1 : c.kind === 'bag' ? c.w : c.n;
      if (c.prog >= goal) {
        c.done = true; done.push(c);
        save.money += c.pay; save.xp += c.xp; save.rep += c.rep; save.stats.cDone++; save.stats.earned += c.pay;
      }
    });
    return done;
  }

  // ---- tournaments vs CPU anglers ----
  var CPU_NAMES = ['Marge Kettle', 'Dutch Okafor', 'Ines Varga', 'Bo Thistle', 'Rusty Pell', 'Yuki Brandt', 'Hank Lowry', 'Priya Sol', 'Old Wen', 'Cass Morrow'];
  function bagW(bag) { var t = 0; for (var i = 0; i < bag.length; i++) t += bag[i]; return Math.round(t * 100) / 100; }
  function addBag(bag, w, lim) { bag.push(w); bag.sort(function (a, b) { return b - a; }); if (bag.length > lim) bag.length = lim; }
  function newTourney(seed, day, locId, lvl, start) {
    var r = mulberry32(hash(seed, 'tour', day)), names = CPU_NAMES.slice(), cpus = [];
    for (var i = 0; i < 5; i++) {
      var k = Math.floor(r() * names.length), nm = names.splice(k, 1)[0];
      cpus.push({ name: nm, skill: clamp(0.55 + lvl * 0.035 + (r() - 0.5) * 0.5, 0.4, 1.6), bag: [] });
    }
    var fee = 30 + lvl * 15;
    return { loc: locId, day: day, start: start, dur: 150, end: start + 150, lim: 5, fee: fee, prizes: [fee * 5, Math.round(fee * 2.4), Math.round(fee * 1.2)], cpus: cpus, bag: [], r: mulberry32(hash(seed, 'tsim', day)), acc: 0, done: false, log: [] };
  }
  // Advance the CPU anglers by game minutes.
  function stepTourney(T, mins, cond) {
    T.acc += mins;
    while (T.acc >= 1) {
      T.acc -= 1;
      for (var i = 0; i < T.cpus.length; i++) {
        var c = T.cpus[i];
        if (T.r() < 0.028 * c.skill) {
          var s = pickSpecies(T.r, T.loc, cond, true), sz = rollSize(T.r, s, c.skill * 0.6 - 0.3);
          addBag(c.bag, sz.w, T.lim);
          T.log.push({ name: c.name, sp: s.id, w: sz.w });
          if (T.log.length > 6) T.log.shift();
        }
      }
    }
  }
  function standings(T) {
    var rows = T.cpus.map(function (c) { return { name: c.name, w: bagW(c.bag), n: c.bag.length, you: false }; });
    rows.push({ name: 'You', w: bagW(T.bag), n: T.bag.length, you: true });
    rows.sort(function (a, b) { return (b.w - a.w) || (a.you ? -1 : b.you ? 1 : 0); });
    return rows;
  }

  // ---- the daily derby: one seeded setup for everyone on a date ----
  function dailySpec(dateStr) {
    var r = mulberry32(hash('reeldeep-daily', dateStr)), ids = ['pond', 'river', 'lake', 'pier', 'ice', 'deep'];
    var loc = ids[Math.floor(r() * ids.length)], L = LOC[loc];
    var season = L.winter ? 3 : Math.floor(r() * 3), band = [DAWN, DAY, DUSK, NIGHT][Math.floor(r() * 4)];
    var min = { 1: 330, 2: 720, 4: 1100, 8: 1290 }[band];
    var wx = pickW(r(), SEASON_WX[season]);
    var lures = { b: 1, s: 1, c: 1, j: 1, f: 1 };
    if (L.salt) lures.d = 1;
    return { date: dateStr, loc: loc, season: season, min: min, cond: { band: band, wx: wx, wind: [0.25, 0.4, 0.55, 0.9, 0.05][wx], wdir: r() < 0.5 ? -1 : 1, season: season, loc: loc },
      seed: hash('reeldeep-daily-world', dateStr), rod: L.salt ? 4 : 2, reel: L.salt ? 3 : 2, line: L.salt ? 4 : 2, lures: lures, dur: 90, lim: 3 };
  }

  var ENGINE = {
    STEP: STEP, MIN_PER_SEC: MIN_PER_SEC, DAY_START: DAY_START, DAY_END: DAY_END, SEASON_DAYS: SEASON_DAYS, TRAVEL_MIN: TRAVEL_MIN,
    SEASONS: SEASONS, BAND_NAME: BAND_NAME, WX: WX, WX_NAME: WX_NAME, RAR_NAME: RAR_NAME, DAWN: DAWN, DAY: DAY, DUSK: DUSK, NIGHT: NIGHT,
    LOCS: LOCS, LOC: LOC, LURES: LURES, LURE: LURE, RODS: RODS, REELS: REELS, LINES: LINES, UPGRADES: UPGRADES, BAIT_PACK: BAIT_PACK, DIFFS: DIFFS,
    SPECIES: SPECIES, SP: SP, CPU_NAMES: CPU_NAMES,
    mulberry32: mulberry32, hash: hash, rng: rng, clamp: clamp, bandOf: bandOf, seasonOf: seasonOf, clockStr: clockStr, weatherAt: weatherAt, condAt: condAt,
    standOf: standOf, genLayout: genLayout, depthAt: depthAt, speciesAt: speciesAt, activity: activity, legendReady: legendReady, spawnWeight: spawnWeight,
    pickSpecies: pickSpecies, rollSize: rollSize, freshness: freshness, priceOf: priceOf, releaseRep: releaseRep, catchXp: catchXp, cumXp: cumXp, levelOf: levelOf, absMin: absMin,
    gearStats: gearStats, newWorld: newWorld, spawnFish: spawnFish, castRange: castRange, castAim: castAim, cast: cast, hook: hook, twitch: twitch, appeal: appeal, light: light,
    strike: strike, startFight: startFight, stepFight: stepFight, endFight: endFight, stepWorld: stepWorld, fmax: fmax, cruise: cruise,
    newSave: newSave, normSave: normSave, creelCap: creelCap, locOpen: locOpen, logCatch: logCatch, sellCreel: sellCreel,
    genContracts: genContracts, contractEvent: contractEvent, newTourney: newTourney, stepTourney: stepTourney, standings: standings, bagW: bagW, addBag: addBag,
    dailySpec: dailySpec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
/*__UI__*/
})();
