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
    { id: 'ice', name: 'Frostbite Hole', short: 'Ice', lvl: 9, W: 26, maxD: 9, stand: 'ice', cur: 0, wave: 0, clar: 7, salt: false, n: 14, winter: true, vis: 2.5,
      surf: [96, 140, 170], deep: [12, 30, 52], mud: [84, 84, 80], blurb: 'Winter only. Jig through the ice.' },
    { id: 'deep', name: 'Blue Shelf', short: 'Deep sea', lvl: 12, W: 52, maxD: 120, stand: 'boat', cur: 0, wave: 0.32, clar: 26, salt: true, n: 26, boat: true, vis: 4, reelMul: 1.7,
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
      else v = L.maxD * (0.78 + 0.22 * noise(u)) - 24 * Math.exp(-Math.pow((x - W * (0.45 + 0.2 * nz[3])) / 9, 2));
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
    { id: 'd', name: 'Deep Rig', note: 'Heavy sinker and a fat bait. Plummets to the bottom. Salt water only.', ideal: 0.15, heavy: true, salt: true, price: 900, lvl: 8, scent: 5, sink: 7 }
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
  sp('bluegill', 'Bluegill', 'pond lake ice', 0, 0.15, 1.6, 8.6, 0.15, 0.7, 'AD', 'so', { b: 1, f: 0.8, j: 0.5, s: 0.45 }, '*', 2.5, [1.0, 0.8, 0.8, 0, 1, 2, 0], ['sunfish', '#3d5e6e', '#e8a84a', '#2b4250', 'bars']);
  sp('pumpkinseed', 'Pumpkinseed', 'pond', 0, 0.1, 1, 8.4, 0.1, 0.6, 'ADU', 'so', { b: 1, f: 0.9, j: 0.3 }, 'PSF', 2.5, [0.95, 0.8, 0.8, 0, 1, 2, 0], ['sunfish', '#5f7f4a', '#f0913a', '#3aa6b9', 'dots']);
  sp('shiner', 'Golden Shiner', 'pond', 0, 0.05, 0.6, 11, 0.05, 0.5, 'ADU', 'sof', { f: 1, b: 0.8, s: 0.3 }, 'PSF', 3, [0.6, 0.6, 1.1, 0.1, 1, 1, 0], ['minnow', '#a9a15a', '#f3e6a1', '#c9b04a', 'lat']);
  sp('perch', 'Yellow Perch', 'pond lake ice', 0, 0.2, 2.2, 9.8, 0.3, 0.95, 'AD', 'so', { b: 0.9, j: 0.9, s: 0.7 }, '*', 3, [0.85, 0.8, 0.8, 0, 1, 2, 0], ['perch', '#7f8c3a', '#f4e9b0', '#e8722c', 'bars']);
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
  // Where a species likes to live along the cross-section: weed beds, rocks and
  // pilings, deep water or the shallows. Fish get a home spot drawn by this.
  var HAB_WEED = ' bluegill pumpkinseed shiner crappie lmbass pike muskie perch bowfin thunderjaw frostmaw gar whitebass ';
  var HAB_ROCK = ' smallmouth rockbass seabass sheepshead grouper snapper brown sauger drum burbot reddrum ';
  function habitat(W, s, x) {
    var lay = W.lay, b = depthAt(lay, x), need = W.L.id === 'deep' ? 2 : Math.max(0.6, Math.min(1.4, s.d1 * lay.maxD * 0.25));
    if (b < need) return 0.03;
    var w = 1, f = b / lay.maxD, i;
    if (W.L.id !== 'deep') {
      if (s.d0 >= 0.5) w *= 0.25 + 1.5 * f;                 // bottom dwellers: the deeper, the better
      else if (s.d1 <= 0.6) w *= 1.2 - 0.6 * Math.abs(f - 0.4);   // shallow and mid-water fish: the shelf
    }
    if (W.L.stand === 'bank' || W.L.stand === 'pier') w *= clamp((x - W.st.minX) / 5, 0.25, 1);   // wary of the bank right under the angler
    if (W.st.hole) w *= 1 + 1.5 * Math.exp(-Math.abs(x - W.st.hole) / 7);   // the hole was drilled over a good spot
    var tag = ' ' + s.id + ' ';
    if (HAB_WEED.indexOf(tag) >= 0) for (i = 0; i < lay.plants.length; i++) if (Math.abs(lay.plants[i].x - x) < 2.5) { w *= 1.8; break; }
    if (HAB_ROCK.indexOf(tag) >= 0) {
      for (i = 0; i < lay.rocks.length; i++) if (Math.abs(lay.rocks[i].x - x) < 2.2) { w *= 3; break; }
      for (i = 0; i < lay.posts.length; i++) if (Math.abs(lay.posts[i] - x) < 2.5) { w *= 3; break; }
    }
    return w;
  }
  function pickHome(W, s) {
    var r = W.r, lo = W.st.minX + 1.5, hi = W.lay.W - 0.6, xs = [], ws = [];
    for (var i = 0; i < 6; i++) { var x = lo + r() * (hi - lo); xs.push(x); ws.push(habitat(W, s, x)); }
    return xs[pickW(r(), ws)];
  }
  function cruise(f) { return (0.22 + 0.55 * Math.sqrt(Math.min(3.5, f.lm))) * f.sp.spd; }
  function spawnFish(W, edge) {
    var r = W.r, s = pickSpecies(r, W.L.id, W.cond, W.legend);
    if (!s) return;
    if (s.rar === 4) W.legend = true;
    var lo = W.st.minX + 1.2, home = pickHome(W, s), x = edge && r() < 0.4 ? W.lay.W - 0.6 : clamp(home + (r() - 0.5) * 4, lo, W.lay.W - 0.5);
    var b = bandY(W, s, x), y = lerp(b[0], b[1], r());
    var lead = newFish(W, s, x, y);
    lead.home = home;
    if (s.rar === 4) { var big = rollSize(r, s, 1.2); lead.w = big.w; lead.len = big.len; lead.lm = big.len * 0.0254; }
    W.fish.push(lead);
    if (s.sch) {
      var k = 2 + Math.floor(r() * 3);
      for (var i = 0; i < k; i++) {
        var mx = clamp(x + (r() - 0.5) * 2, lo, W.lay.W - 0.4), mb = bandY(W, s, mx);
        var m = newFish(W, s, mx, clamp(y + (r() - 0.5) * 0.8, mb[0], mb[1]));
        m.lead = lead; m.home = home; W.fish.push(m);
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
    if (lu.salt && !W.L.salt) { ev(W, 'nosalt'); return false; }
    var needs = !!(lu.bob || lu.scent);
    if (needs && !W.hookBait) {                            // bait goes on the hook as the line goes out
      if (W.bait <= 0) { ev(W, 'nobait'); return false; }
      W.bait--; W.hookBait = true;
    }
    W.lure = { def: lu, x: st.tip.x, y: st.tip.y, vx: 0, vy: 0, baited: needs, bx: 0, by: 0, bobY: 0, spd: 0, moving: 0, landT: W.t, sx: st.tip.x, sy: st.tip.y };
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
    var lu = W.lure, d = lu.def, st = W.st, g = W.gear, c = W.cond;
    if (lu.quickT > 0) { lu.quickT -= dt; if (lu.quickT <= 0) lu.quick = true; }
    var reel = !!inp.reel || !!lu.quick, fast = lu.quick ? 4 : 1;      // an empty line comes back fast
    var bot = lureBottom(W, lu.x), ax = st.anc.x, ay = W.st.hole ? -1 : st.anc.y;
    var dx = ax - lu.x, dy = ay - lu.y, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
    var rs = lu.quick ? Math.max(g.reel.speed * fast, 6) : g.reel.speed, tvx = 0, tvy = 0, cur = W.L.cur * (1 - 0.5 * clamp(lu.y / W.lay.maxD, 0, 1));
    var top = st.iceT ? (Math.abs(lu.x - st.hole) < 0.35 ? 0.05 : st.iceT + 0.05) : d.surface ? 0.02 : 0.05;
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
        var k = rs * (d.surface ? 0.55 : d.heavy ? 0.8 : 1) * (W.L.reelMul && lu.y > 12 ? W.L.reelMul * 1.5 : 1);
        tvx = ux * k; tvy = uy * k;
        if (d.dive && !lu.quick) { var dv = Math.min(d.dive, bot - 0.2); if (!st.hole) tvy = clamp((dv - lu.y) * 1.6, -0.8, 1.1) + uy * k * 0.25; }
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
    if (inp.twitch && !lu.quick) twitch(W, inp.twitch);
    if (lu.y > bot) { lu.y = bot; lu.vy = Math.min(0, lu.vy); lu.vx *= 0.9; }
    if (lu.y < top) { lu.y = top; lu.vy = Math.max(0, lu.vy); }
    lu.x = clamp(lu.x, st.hole ? st.hole - 1.5 : st.minX - 0.5, W.lay.W - 0.3);
    if (st.hole) lu.x += (st.hole - lu.x) * Math.min(1, dt * 0.6);
    lu.spd = Math.hypot(lu.vx, lu.vy);
    lu.moving = reel ? 1 : 0;
    // Reeled all the way in?
    lu.maxY = Math.max(lu.maxY || 0, lu.y);
    var near = st.hole ? lu.y < 0.45 && (lu.maxY > 0.9 || W.t - lu.landT > 1.5) : (lu.x <= st.minX + 0.15 || (Math.abs(lu.x - st.anc.x) < 1.4 && lu.y < 0.5 && reel));
    if (near && reel && W.t - lu.landT > 0.6) { W.phase = 'ready'; W.hookBait = !!lu.baited && W.hookBait; W.lure = null; releaseBiter(W, false); ev(W, 'in'); }
  }
  // One tap: wind the line straight back in, fast (nothing bites a lure on its way home).
  function reelIn(W) {
    if (W.phase !== 'fishing' || !W.lure || W.lure.quick) return false;
    if (W.biter) releaseBiter(W, false);
    W.lure.quick = true;
    return true;
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
    if ((!lu.baited && d.bob) || lu.quick) return 0;
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
    if (d.scent && lu.baited) v = Math.max(v, d.scent * Math.sqrt(W.L.vis || 1));
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
              // roam around a home spot; now and then move house (schools drift about the water)
              if (f.home == null || r() < 0.12) f.home = pickHome(W, s);
              f.tx = clamp(f.home + (r() - 0.5) * 12, W.st.minX + 1.5, W.lay.W - 0.4);
              if (habitat(W, s, f.tx) < 0.05) f.tx = f.home;
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
              if (r() < ap * 1.4 * dt) { f.st = 'follow'; f.t = 0; }
              else if (r() < 0.25 * dt) f.cd = 2 + r() * 3;
            } else if (dd < vision(W, f) * 2.2 && !L && r() < appeal(W, f) * 0.9 * dt) {
              f.tx = lu.x + (r() - 0.5) * 1.5; f.ty = lu.y + (r() - 0.5) * 0.8; f.tT = 4;       // drawn over to have a look
            }
          }
          break;
        }
        case 'follow': {
          if (!lu || (!lu.baited && (lu.def.bob || lu.def.scent))) { f.st = 'wander'; f.cd = 3; f.tT = 0; break; }
          var side = f.x < lu.x ? -1 : 1, mx = lu.x + side * f.lm * 0.45, my = lu.y + 0.02;
          steerTo(f, mx, my, cr * 2, dt, 3);
          var dist = Math.hypot(lu.x - f.x, lu.y - f.y), close = dist < 0.3 + f.lm * 0.55;
          if (dist > 2 && f.t > 2 && f.t < 30) f.t -= dt * 0.75;   // the swim over counts for less than dawdling at the lure
          // fish don't trail a lure far from their patch, or into the shallows at the angler's feet
          if (f.t > 9 || (lu.moving && lu.spd > 1.9 * s.spd) || (!W.st.hole && lu.x < W.st.minX + 2.5) || (f.home != null && Math.abs(lu.x - f.home) > 8 * (W.L.vis || 1))) { f.st = 'wander'; f.cd = 3 + r() * 4; f.tT = 0; break; }
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
          if (!lu || (!lu.baited && (lu.def.bob || lu.def.scent))) { W.biter = null; f.st = 'wander'; f.cd = 3; break; }
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
            if (lu.def.bob || lu.def.scent) { lu.baited = false; W.hookBait = false; lu.quickT = 0.8; }
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
      if (s.sch && f.st === 'wander' && f.lead) {
        for (j = 0; j < fish.length; j++) {
          var o = fish[j];
          if (o === f || o.sp !== s) continue;
          var ex = f.x - o.x, ey = f.y - o.y, e2 = ex * ex + ey * ey;
          if (e2 < 0.16 && e2 > 1e-6) { var kk = dt * 0.08 / Math.max(0.05, e2); f.vx += ex * kk; f.vy += ey * kk * 0.5; }
        }
      }
      f.x += f.vx * dt; f.y += f.vy * dt;
      var bot = depthAt(W.lay, f.x) - 0.12, top = W.st.iceT ? W.st.iceT + 0.1 : (s.d0 < 0.05 ? 0.06 : 0.15);
      if (f.y > bot) { f.y = bot; f.vy = Math.min(0, f.vy); if (f.st === 'wander') f.ty = Math.min(f.ty, bot - 0.2); }
      if (f.y < top) { f.y = top; f.vy = Math.max(0, f.vy); }
      var xmin = W.st.hole ? 0.8 : W.st.minX + 0.6;              // under the ice they swim beneath your boots too
      if (f.x < xmin) { f.x = xmin; f.vx = Math.abs(f.vx); }
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
    var pullEff = pull * (1 - 0.32 * cn) * (W.L.cur && hd > 0 ? 1 + W.L.cur * 0.5 : 1);   // downstream runs pull harder
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
    W.fight = null; W.biter = null; W.hookBait = false;
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
      if (W.lure) { W.lure.x = clamp(f.x, W.st.minX, W.lay.W - 0.3); W.lure.y = Math.max(0.1, f.y); W.lure.vx = 0; W.lure.vy = 0; W.lure.baited = false; W.lure.landT = W.t; W.lure.bx = W.lure.x; W.lure.quickT = 1; }
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
      rod: 0, reel: 0, line: 0, owned: { rod: [0], reel: [0], line: [0] }, lures: { b: 1, s: 1 }, lure: 'b', bait: 20,
      up: { creel: 0, cooler: 0, finder: 0, boat: 0 }, creel: [], journal: {}, contracts: [], cday: 0, tday: 0,
      stats: { caught: 0, released: 0, sold: 0, earned: 0, snaps: 0, lost: 0, tWins: 0, tPlayed: 0, cDone: 0, days: 0, best: null },
      diff: 'normal', amb: 1, floatD: 1.5, drag: 0.65, daily: {}, seen: 0, tut: 0, today: { n: 0, rel: 0, earn: 0 }
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
    s.lure = s.lures[o.lure] ? o.lure : 'b';
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
    s.seen = o.seen | 0; s.tut = o.tut ? 1 : 0;
    if (o.today) s.today = { n: o.today.n | 0, rel: o.today.rel | 0, earn: +o.today.earn || 0 };
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
    strike: strike, reelIn: reelIn, pickHome: pickHome, habitat: habitat, startFight: startFight, stepFight: stepFight, endFight: endFight, stepWorld: stepWorld, fmax: fmax, cruise: cruise,
    newSave: newSave, normSave: normSave, creelCap: creelCap, locOpen: locOpen, logCatch: logCatch, sellCreel: sellCreel,
    genContracts: genContracts, contractEvent: contractEvent, newTourney: newTourney, stepTourney: stepTourney, standings: standings, bagW: bagW, addBag: addBag,
    dailySpec: dailySpec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('fishing.css');

  var PANEL_ID = 'fishing-panel', NAME = 'Reel Deep';
  var KEY = 'cade-fishing-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.fishing = { live: function () { return S; }, E: ENGINE };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function haptic(ms) { try { if (Cade.haptic) Cade.haptic(ms); } catch (e) {} }
  function fmtW(w) { return w >= 100 ? Math.round(w) + ' lb' : w >= 10 ? w.toFixed(1) + ' lb' : w.toFixed(2) + ' lb'; }
  function fmtLen(l) { return l.toFixed(1) + '"'; }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() {
    if (!S) return;
    var sv = S.save;
    if (S.W && S.mode !== 'daily' && S.phase !== 'dock' && !S.W.preview) { sv.min = Math.min(DAY_END - 1, S.W.min); sv.bait = S.W.bait; }
    sset(SAVE_KEY, JSON.stringify(sv));
  }

  // ---- sound: tiny WebAudio blips plus a quiet ambient bed (water, rain, birds) ----
  function Snd(on) { this.on = !!on; this.ac = null; this.nb = null; this.amb = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.live = function () { return this.on && this.ac && this.ac.state !== 'closed'; };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    if (!this.live()) return;
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
  Snd.prototype.noiseBuf = function () {
    if (this.nb || !this.ac) return this.nb;
    var n = this.ac.sampleRate * 2, b = this.ac.createBuffer(1, n, this.ac.sampleRate), d = b.getChannelData(0), last = 0;
    for (var i = 0; i < n; i++) { var w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.5 + last * 3; }
    this.nb = b;
    return b;
  };
  Snd.prototype.noise = function (dur, freq, type, vol, delay, q) {
    if (!this.live()) return;
    var ac = this.ac;
    try {
      var t = ac.currentTime + (delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = this.noiseBuf(); f.type = type || 'lowpass'; f.frequency.value = freq; f.Q.value = q || 0.8;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(ac.destination);
      s.start(t, Math.random()); s.stop(t + dur + 0.05);
    } catch (e) {}
  };
  // a looping filtered noise bed whose level is steered every frame
  Snd.prototype.bed = function (type, freq, q) {
    var ac = this.ac, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = this.noiseBuf(); s.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7; g.gain.value = 0;
    s.connect(f); f.connect(g); g.connect(ac.destination); s.start();
    return { s: s, f: f, g: g };
  };
  Snd.prototype.ambient = function (water, rain, dt) {
    if (!this.live()) return;
    try {
      if (!this.amb) this.amb = { water: this.bed('lowpass', 380, 0.6), rain: this.bed('highpass', 1700, 0.5) };
      var t = this.ac.currentTime;
      this.amb.water.g.gain.setTargetAtTime(water, t, 0.6);
      this.amb.rain.g.gain.setTargetAtTime(rain, t, 0.8);
    } catch (e) {}
  };
  Snd.prototype.hush = function () {
    if (!this.amb || !this.ac) return;
    try { var t = this.ac.currentTime; this.amb.water.g.gain.setTargetAtTime(0, t, 0.2); this.amb.rain.g.gain.setTargetAtTime(0, t, 0.2); } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.amb = null; this.nb = null; } };
  Snd.prototype.splash = function (big) { this.noise(big ? 0.5 : 0.22, big ? 900 : 1500, 'bandpass', big ? 0.09 : 0.05, 0, 0.6); this.tone(big ? 180 : 320, 0.12, 'sine', 0.03, big ? 90 : 140); };
  Snd.prototype.chirp = function (sea) {
    if (sea) { this.tone(1300, 0.18, 'sine', 0.012, 900); this.tone(1250, 0.22, 'sine', 0.01, 820, 0.25); return; }
    var f = 2400 + Math.random() * 1600, n = 2 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++) this.tone(f * (1 + i * 0.04), 0.06, 'sine', 0.012, f * 1.25, i * 0.09);
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
  var IC_BOOK = svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>');

  // ---- colour ----
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
  function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function css(c, a) {
    var r = Math.round(clamp(c[0], 0, 255)), g = Math.round(clamp(c[1], 0, 255)), b = Math.round(clamp(c[2], 0, 255));
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + (+a).toFixed(3) + ')';
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.th = {
      bg: bg, text: tx, acc: ac, dark: dark, surf: parseCol(v('--surface'), bg),
      muted: parseCol(v('--text-muted'), mix(bg, tx, 0.6)), faint: parseCol(v('--text-faint'), mix(bg, tx, 0.4)),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      red: dark ? [240, 106, 106] : [207, 63, 63], gold: dark ? [242, 197, 68] : [196, 140, 16], green: dark ? [126, 211, 122] : [47, 143, 58]
    };
  }
  // scene colours are natural, softened toward the page in dark mode
  function sc(c) { return S.th.dark ? mix(mul(c, 0.82), S.th.bg, 0.12) : c; }

  // ---- procedural fish ----
  var SHAPES = {
    sunfish: { h: 0.56, tail: 'tr', dor: 'long', blunt: 1 }, crappie: { h: 0.48, tail: 'fork', dor: 'long' },
    bass: { h: 0.32, tail: 'tr', dor: 'double', mouth: 1 }, perch: { h: 0.29, tail: 'fork', dor: 'double' },
    walleye: { h: 0.24, tail: 'fork', dor: 'double', glow: 1 }, trout: { h: 0.26, tail: 'tr', dor: 'single', adi: 1 },
    whitefish: { h: 0.27, tail: 'fork', dor: 'single', adi: 1 }, minnow: { h: 0.24, tail: 'fork', dor: 'single' },
    pike: { h: 0.17, tail: 'fork', dor: 'rear', sn: 0.16 }, gar: { h: 0.11, tail: 'round', dor: 'rear', sn: 0.3 },
    bowfin: { h: 0.23, tail: 'round', dor: 'longlow' }, cat: { h: 0.22, tail: 'fork', dor: 'single', whisk: 1, adi: 1 },
    carp: { h: 0.34, tail: 'fork', dor: 'long', barb: 1 }, drum: { h: 0.4, tail: 'tr', dor: 'double', hump: 1 },
    sturgeon: { h: 0.16, tail: 'shark', dor: 'rear', sn: 0.12, scutes: 1, barb: 1 }, eel: { h: 0.14, tail: 'eel', dor: 'eel', barb: 1 },
    mackerel: { h: 0.2, tail: 'fork', dor: 'double', finlets: 1 }, grouper: { h: 0.36, tail: 'round', dor: 'spiny', mouth: 1 },
    snapper: { h: 0.4, tail: 'fork', dor: 'spiny' }, flat: { h: 0.44, tail: 'round', dor: 'fringe' },
    tuna: { h: 0.3, tail: 'lunate', dor: 'double', finlets: 1 }, mahi: { h: 0.34, tail: 'fork', dor: 'mahi', blunt: 1 },
    tarpon: { h: 0.28, tail: 'fork', dor: 'single', mouth: 1 }, marlin: { h: 0.21, tail: 'lunate', dor: 'sail', bill: 0.2 },
    sword: { h: 0.22, tail: 'lunate', dor: 'tall', bill: 0.3 }, angler: { h: 0.62, tail: 'round', dor: 'lantern', mouth: 2, blunt: 1 }
  };
  var FISH_CACHE = {};
  function fishArt(s) {
    var A = FISH_CACHE[s.id];
    if (A) return A;
    var D = SHAPES[s.shape] || SHAPES.bass, H = D.h * 0.5, x0 = -0.31, x1 = 0.5 - (D.bill || 0), N = 16, p = D.blunt ? 0.8 : 1.25, sn = D.sn || 0;
    var top = [], bot = [], i, u, x, pr;
    for (i = 0; i <= N; i++) {
      u = i / N; x = x0 + (x1 - x0) * u;
      pr = 0.16 + 0.84 * Math.pow(Math.sin(Math.PI * Math.pow(u, p)), 0.72);
      if (sn && u > 1 - sn * 2.2) pr = Math.min(pr, lerp(pr, 0.22, (u - (1 - sn * 2.2)) / (sn * 2.2)));
      var hump = D.hump ? 1 + 0.25 * Math.sin(Math.PI * u) : 1;
      top.push([x, -H * pr * hump]); bot.push([x, H * pr * 0.92]);
    }
    var body = new Path2D();
    body.moveTo(top[0][0], top[0][1]);
    for (i = 1; i < top.length - 1; i++) body.quadraticCurveTo(top[i][0], top[i][1], (top[i][0] + top[i + 1][0]) / 2, (top[i][1] + top[i + 1][1]) / 2);
    var nx = top[N][0], ny = (top[N][1] + bot[N][1]) / 2;
    body.quadraticCurveTo(nx + 0.02, top[N][1], nx + 0.012, ny);
    body.quadraticCurveTo(nx + 0.02, bot[N][1], bot[N - 1][0], bot[N - 1][1]);
    for (i = N - 1; i > 0; i--) body.quadraticCurveTo(bot[i][0], bot[i][1], (bot[i][0] + bot[i - 1][0]) / 2, (bot[i][1] + bot[i - 1][1]) / 2);
    body.lineTo(bot[0][0], bot[0][1]); body.closePath();
    var th = Math.max(H * 1.15, 0.08), ph = H * 0.17, tail = new Path2D();
    switch (D.tail) {
      case 'fork': tail.moveTo(0.02, -ph); tail.lineTo(-0.17, -th); tail.quadraticCurveTo(-0.1, 0, -0.17, th); tail.lineTo(0.02, ph); break;
      case 'tr': tail.moveTo(0.02, -ph); tail.lineTo(-0.15, -th * 0.9); tail.quadraticCurveTo(-0.13, 0, -0.15, th * 0.9); tail.lineTo(0.02, ph); break;
      case 'round': tail.moveTo(0.02, -ph); tail.quadraticCurveTo(-0.2, -th * 1.1, -0.18, 0); tail.quadraticCurveTo(-0.2, th * 1.1, 0.02, ph); break;
      case 'lunate': tail.moveTo(0.02, -ph * 0.6); tail.quadraticCurveTo(-0.07, -th * 0.5, -0.15, -th * 1.35); tail.quadraticCurveTo(-0.09, 0, -0.15, th * 1.35); tail.quadraticCurveTo(-0.07, th * 0.5, 0.02, ph * 0.6); break;
      case 'shark': tail.moveTo(0.02, -ph); tail.lineTo(-0.2, -th * 1.3); tail.lineTo(-0.1, 0); tail.lineTo(-0.12, th * 0.55); tail.lineTo(0.02, ph); break;
      default: tail.moveTo(0.02, -ph * 2); tail.quadraticCurveTo(-0.14, 0, 0.02, ph * 2);
    }
    tail.closePath();
    // fins
    var fin = new Path2D(), bx = function (uu) { return x0 + (x1 - x0) * uu; }, ty = function (uu) { var k = Math.round(uu * N); return top[clamp(k, 0, N)][1]; }, by = function (uu) { var k = Math.round(uu * N); return bot[clamp(k, 0, N)][1]; };
    function dfin(a, b, hgt, spiky) {
      fin.moveTo(bx(a), ty(a) + 0.005);
      if (spiky) { var n = 10; for (var k = 0; k <= n; k++) { var uu = a + (b - a) * k / n; fin.lineTo(bx(uu), ty(uu) - hgt * (k % 2 ? 0.62 : 0.8 + 0.2 * k / n)); } }
      else fin.quadraticCurveTo(bx(a + (b - a) * 0.3), ty(a) - hgt * 1.2, bx(b), ty(b) - hgt * 0.25);
      fin.lineTo(bx(b), ty(b) + 0.005); fin.closePath();
    }
    function afin(a, b, hgt) { fin.moveTo(bx(a), by(a) - 0.005); fin.quadraticCurveTo(bx(a + (b - a) * 0.4), by(a) + hgt * 1.1, bx(b), by(b) + hgt * 0.15); fin.lineTo(bx(b), by(b) - 0.005); fin.closePath(); }
    var fh = H * 0.55 + 0.012;
    switch (D.dor) {
      case 'long': dfin(0.22, 0.62, fh, false); break;
      case 'double': dfin(0.42, 0.62, fh * 1.05, true); dfin(0.22, 0.4, fh * 0.85, false); break;
      case 'single': dfin(0.4, 0.58, fh * 1.1, false); break;
      case 'rear': dfin(0.12, 0.26, fh * 1.1, false); break;
      case 'longlow': dfin(0.15, 0.68, fh * 0.6, false); break;
      case 'spiny': dfin(0.28, 0.68, fh * 0.9, true); break;
      case 'fringe': dfin(0.05, 0.85, fh * 0.35, false); afin(0.05, 0.75, fh * 0.35); break;
      case 'sail': fin.moveTo(bx(0.2), ty(0.2)); fin.quadraticCurveTo(bx(0.55), ty(0.6) - fh * 5, bx(0.82), ty(0.82) - fh * 1.2); fin.lineTo(bx(0.82), ty(0.82)); fin.closePath(); break;
      case 'tall': dfin(0.66, 0.78, fh * 2.6, false); break;
      case 'mahi': dfin(0.05, 0.92, fh * 0.8, false); break;
      case 'eel': dfin(0.0, 0.62, fh * 0.35, false); afin(0.0, 0.5, fh * 0.35); break;
      case 'lantern': dfin(0.25, 0.5, fh * 0.5, false); break;
    }
    if (D.dor !== 'fringe' && D.dor !== 'eel') afin(0.14, 0.32, fh * 0.65);
    if (D.adi) { fin.moveTo(bx(0.16), ty(0.16)); fin.quadraticCurveTo(bx(0.12), ty(0.13) - fh * 0.5, bx(0.08), ty(0.1)); fin.closePath(); }
    if (D.finlets) for (i = 0; i < 4; i++) { var fu = 0.02 + i * 0.05; fin.moveTo(bx(fu), ty(fu)); fin.lineTo(bx(fu) - 0.01, ty(fu) - fh * 0.3); fin.lineTo(bx(fu) + 0.02, ty(fu)); fin.moveTo(bx(fu), by(fu)); fin.lineTo(bx(fu) - 0.01, by(fu) + fh * 0.3); fin.lineTo(bx(fu) + 0.02, by(fu)); }
    var pec = new Path2D(), px = bx(0.74), py = H * 0.25;
    pec.moveTo(px, py); pec.quadraticCurveTo(px - 0.06, py + fh * 0.6, px - 0.09, py + fh * 0.2); pec.quadraticCurveTo(px - 0.04, py, px, py); pec.closePath();
    // the pattern, seeded per species, in body units
    var r = mulberry32(hash('pat', s.id)), pat = [];
    var pt = s.pat;
    if (pt === 'bars' || pt === 'tiger') for (i = 0; i < 6; i++) pat.push({ k: 'bar', x: bx(0.12 + i * 0.13), w: 0.025 + r() * 0.01, sl: pt === 'tiger' ? 0.05 : 0 });
    else if (pt === 'stripes') for (i = 0; i < 4; i++) pat.push({ k: 'hl', y: -H * 0.6 + i * H * 0.36, w: H * 0.08 });
    else if (pt === 'lat' || pt === 'rainbow') pat.push({ k: 'hl', y: -H * 0.02, w: H * 0.22, c: pt === 'rainbow' ? 2 : 0 });
    if (pt === 'spots' || pt === 'dots' || pt === 'rainbow' || pt === 'speck' || pt === 'beans' || pt === 'worm' || pt === 'ocel' || pt === 'mottled' || pt === 'moss') {
      var nn = { spots: 22, dots: 16, rainbow: 26, speck: 60, beans: 20, worm: 14, ocel: 5, mottled: 9, moss: 14 }[pt];
      for (i = 0; i < nn; i++) {
        var uu = 0.05 + r() * 0.85, yy = (r() * 2 - 1) * H * 0.75;
        pat.push({ k: pt, x: bx(uu), y: pt === 'rainbow' || pt === 'worm' ? -Math.abs(yy) : yy, r: pt === 'speck' ? 0.004 + r() * 0.004 : pt === 'mottled' || pt === 'moss' ? H * (0.25 + r() * 0.3) : pt === 'ocel' ? H * 0.16 : pt === 'beans' ? 0.012 : 0.008 + r() * 0.006 });
      }
    }
    if (pt === 'wavy') for (i = 0; i < 9; i++) pat.push({ k: 'wavy', x: bx(0.15 + i * 0.085), y: -H * 0.4 });
    if (pt === 'scales' || pt === 'moss') for (i = 0; i < 26; i++) pat.push({ k: 'scale', x: bx(0.12 + (i % 9) * 0.095), y: -H * 0.55 + Math.floor(i / 9) * H * 0.45 });
    if (pt === 'eyespot') pat.push({ k: 'eye', x: bx(0.08), y: -H * 0.1, r: H * 0.22 });
    if (pt === 'finlets' || D.finlets) pat.push({ k: 'hl', y: H * 0.05, w: H * 0.12, c: 1 });
    A = FISH_CACHE[s.id] = { D: D, H: H, x0: x0, x1: x1, body: body, tail: tail, fin: fin, pec: pec, pat: pat, eye: [bx(0.9) - (sn ? 0.05 : 0), -H * (D.h > 0.45 ? 0.32 : 0.28)], gill: bx(0.78) };
    return A;
  }
  // Draw a fish centred at (x, y), L px long, facing dir. o: { a, shade: [rgb, a], sil: rgb, tilt, wig, glow }
  function drawFish(c, s, x, y, L, dir, o) {
    var A = fishArt(s), D = A.D, H = A.H;
    o = o || {};
    var c1 = parseCol(s.c1), c2 = parseCol(s.c2), c3 = parseCol(s.c3), sil = o.sil;
    c.save();
    c.translate(x, y);
    c.rotate((o.tilt || 0) * dir);
    c.scale(L * dir, L);
    if (o.a != null) c.globalAlpha = o.a;
    // tail
    c.save();
    c.translate(A.x0, 0);
    c.rotate(Math.sin(o.wig || 0) * 0.32);
    c.fillStyle = sil ? css(sil) : css(mix(c1, c3, 0.35));
    c.fill(A.tail);
    c.restore();
    c.fillStyle = sil ? css(sil) : css(mix(c1, c3, 0.45), 0.92);
    c.fill(A.fin);
    // body
    if (sil) { c.fillStyle = css(sil); c.fill(A.body); }
    else {
      var g = c.createLinearGradient(0, -H, 0, H);
      g.addColorStop(0, css(mul(c1, 0.85))); g.addColorStop(0.45, css(c1)); g.addColorStop(0.62, css(mix(c1, c2, 0.6))); g.addColorStop(1, css(c2));
      c.fillStyle = g; c.fill(A.body);
      c.save(); c.clip(A.body);
      drawPattern(c, A, s, c1, c2, c3);
      c.restore();
      // gill and eye
      c.strokeStyle = css(mul(c1, 0.55), 0.6); c.lineWidth = 0.008;
      c.beginPath(); c.moveTo(A.gill, -H * 0.55); c.quadraticCurveTo(A.gill + 0.03, 0, A.gill, H * 0.55); c.stroke();
      var er = Math.max(0.018, H * 0.13) * (D.glow ? 1.25 : 1);
      c.fillStyle = D.glow ? '#e9f2d6' : '#f4f1e6'; c.beginPath(); c.arc(A.eye[0], A.eye[1], er, 0, 6.283); c.fill();
      c.fillStyle = '#111'; c.beginPath(); c.arc(A.eye[0] + er * 0.25, A.eye[1], er * 0.55, 0, 6.283); c.fill();
      if (D.mouth) { c.strokeStyle = css(mul(c1, 0.4), 0.8); c.lineWidth = 0.007; c.beginPath(); c.moveTo(A.x1 + 0.01, H * 0.08); c.lineTo(A.x1 - (D.mouth === 2 ? 0.14 : 0.07), H * 0.16); c.stroke(); }
    }
    c.fillStyle = sil ? css(sil) : css(mix(c3, c2, 0.4), 0.85);
    c.fill(A.pec);
    // extras
    c.lineCap = 'round';
    if (D.bill) { c.strokeStyle = sil ? css(sil) : css(mul(c1, 0.7)); c.lineWidth = 0.014; c.beginPath(); c.moveTo(A.x1 - 0.01, -H * 0.05); c.lineTo(0.5, -H * 0.1); c.stroke(); }
    if (D.whisk || D.barb) {
      c.strokeStyle = sil ? css(sil) : css(mul(c1, 0.6)); c.lineWidth = 0.006;
      var wl = D.whisk ? 0.11 : 0.04;
      for (var k = -1; k <= 1; k += 2) { c.beginPath(); c.moveTo(A.x1 - 0.01, H * 0.1); c.quadraticCurveTo(A.x1 + wl * 0.6, H * (0.2 + k * 0.15), A.x1 + wl * 0.2, H * (0.5 + k * 0.3)); c.stroke(); }
    }
    if (D.scutes && !sil) { c.fillStyle = css(mix(c2, c3, 0.3)); for (var q = 0; q < 9; q++) { var sx2 = A.x0 + 0.05 + q * 0.07; c.beginPath(); c.moveTo(sx2 - 0.012, -H * 0.72); c.lineTo(sx2, -H * 0.95); c.lineTo(sx2 + 0.012, -H * 0.72); c.fill(); } }
    if (D.dor === 'lantern') {
      var lx = A.x1 - 0.02, ly = -H * 1.35, gl = o.glow == null ? 1 : o.glow;
      c.strokeStyle = sil ? css(sil) : css(mul(c1, 1.3)); c.lineWidth = 0.008; c.beginPath(); c.moveTo(A.x1 - 0.12, -H * 0.8); c.quadraticCurveTo(A.x1 - 0.06, -H * 1.5, lx, ly); c.stroke();
      if (!sil && gl > 0.05) {
        c.fillStyle = css(c3, 0.25 * gl); c.beginPath(); c.arc(lx, ly, 0.07, 0, 6.283); c.fill();
        c.fillStyle = css(c3, gl); c.beginPath(); c.arc(lx, ly, 0.022, 0, 6.283); c.fill();
      }
    }
    if (o.shade && o.shade[1] > 0.02) {
      c.fillStyle = css(o.shade[0], o.shade[1]);
      c.fill(A.body); c.save(); c.translate(A.x0, 0); c.rotate(Math.sin(o.wig || 0) * 0.32); c.fill(A.tail); c.restore(); c.fill(A.fin);
    }
    c.restore();
  }
  function drawPattern(c, A, s, c1, c2, c3) {
    var H = A.H, dk = css(mul(c3, 0.9), 0.5);
    for (var i = 0; i < A.pat.length; i++) {
      var p = A.pat[i];
      switch (p.k) {
        case 'bar': c.fillStyle = css(mul(c1, 0.55), 0.45); c.beginPath(); c.moveTo(p.x - p.w, -H); c.lineTo(p.x + p.w + p.sl, -H); c.lineTo(p.x + p.w - p.sl, H * 0.4); c.lineTo(p.x - p.w - p.sl, H * 0.4); c.fill(); break;
        case 'hl': c.fillStyle = p.c === 2 ? 'rgba(232,96,128,0.55)' : p.c === 1 ? css(c3, 0.7) : css(mul(c1, 0.5), 0.5); c.fillRect(-0.5, p.y - p.w / 2, 1, p.w); break;
        case 'spots': case 'dots': case 'rainbow': case 'speck': c.fillStyle = p.k === 'dots' ? css(c3, 0.85) : css(mul(c1, 0.35), 0.75); c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); break;
        case 'beans': c.fillStyle = css(mix(c2, c3, 0.5), 0.8); c.beginPath(); c.ellipse(p.x, p.y, p.r * 1.6, p.r, 0, 0, 6.283); c.fill(); break;
        case 'worm': c.strokeStyle = css(c3, 0.6); c.lineWidth = 0.006; c.beginPath(); c.moveTo(p.x - 0.02, p.y); c.quadraticCurveTo(p.x, p.y - 0.02, p.x + 0.02, p.y); c.stroke(); c.fillStyle = '#d8402e'; c.beginPath(); c.arc(p.x, -p.y * 0.4, 0.006, 0, 6.283); c.fill(); break;
        case 'ocel': c.fillStyle = dk; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); c.fillStyle = css(c2, 0.6); c.beginPath(); c.arc(p.x, p.y, p.r * 0.45, 0, 6.283); c.fill(); break;
        case 'mottled': c.fillStyle = css(mul(c1, 0.6), 0.28); c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); break;
        case 'moss': c.fillStyle = 'rgba(90,130,50,0.35)'; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); break;
        case 'wavy': c.strokeStyle = css(c3, 0.7); c.lineWidth = 0.012; c.beginPath(); c.moveTo(p.x, -H); c.quadraticCurveTo(p.x + 0.03, p.y, p.x, 0); c.stroke(); break;
        case 'scale': c.strokeStyle = css(mul(c1, 0.6), 0.25); c.lineWidth = 0.005; c.beginPath(); c.arc(p.x, p.y, 0.04, -1.2, 1.2); c.stroke(); break;
        case 'eye': c.fillStyle = '#111'; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.283); c.fill(); break;
      }
    }
  }

  // ================= the scene =================
  var SKY = [   // minute, top, bottom
    [0, [8, 12, 30], [22, 30, 58]], [290, [8, 12, 30], [22, 30, 58]], [345, [58, 66, 118], [236, 150, 112]], [420, [104, 156, 214], [236, 206, 172]],
    [540, [76, 146, 222], [176, 214, 240]], [1020, [76, 146, 222], [176, 214, 240]], [1110, [72, 82, 150], [250, 146, 96]], [1200, [36, 38, 86], [138, 82, 112]],
    [1270, [8, 12, 30], [22, 30, 58]], [1440, [8, 12, 30], [22, 30, 58]]
  ];
  function skyAt(min) {
    min = ((min % 1440) + 1440) % 1440;
    for (var i = 0; i < SKY.length - 1; i++) {
      var a = SKY[i], b = SKY[i + 1];
      if (min >= a[0] && min <= b[0]) { var t = (min - a[0]) / (b[0] - a[0] || 1); return [mix(a[1], b[1], t), mix(a[2], b[2], t)]; }
    }
    return [SKY[0][1], SKY[0][2]];
  }
  function dayLight(min) {   // 0 at night .. 1 at midday
    min = ((min % 1440) + 1440) % 1440;
    if (min < 300 || min > 1290) return 0.12;
    if (min < 450) return lerp(0.12, 1, (min - 300) / 150);
    if (min > 1110) return lerp(1, 0.12, (min - 1110) / 180);
    return 1;
  }
  var WX_TINT = [null, [[150, 156, 164], 0.55], [[112, 120, 132], 0.68], [[58, 62, 74], 0.8], [[198, 204, 210], 0.6]];
  function weatherMix(c, wx, k) { var t = WX_TINT[wx]; return t ? mix(c, t[0], t[1] * (k == null ? 1 : k)) : c; }
  function waveH(W) { var c = W.cond; return W.L.wave * (0.7 + c.wind * 1.1 + (c.wx === 3 ? 1.2 : 0)); }
  function surfY(W, x, t) { var h = waveH(W); return h ? h * (Math.sin(x * 1.1 - t * 1.6) * 0.6 + Math.sin(x * 0.47 + t * 0.9) * 0.4) : 0; }

  function view() {
    var W = S.W, SW = S.SW, SH = S.SH, L = W.L;
    var sx = clamp(SW / 16, 20, 42), feet = { bank: 0.6, pier: 3.75, boat: 1, ice: 0.15 }[L.stand] || 0.6;
    var skyH = Math.round(clamp(Math.max(SH * 0.3, (feet + 2.5) * sx), 0, SH * 0.52));
    var Dv = Math.min(W.lay.maxD * 1.08 + 0.5, 16), sy = clamp((SH - skyH) / Dv, sx * 0.9, sx * 2.7);
    var viewW = SW / sx, visD = (SH - skyH) / sy;
    // what to look at
    var fx = W.st.home + 2, fy = 0;
    if (S.phase === 'catch' && S.catchAt) { fx = S.catchAt.x; fy = 0; }
    else if (W.phase === 'fight' && W.fight) { fx = W.fight.f.x; fy = W.fight.f.y; }
    else if (W.lure && (W.phase === 'fishing' || W.phase === 'flight')) { fx = W.lure.def.bob ? W.lure.bx : W.lure.x; fy = Math.max(0, W.lure.y); }
    else if (S.charge && S.charge.on) fx = castAim(W, S.charge.pow) - viewW * 0.15;
    var lo = W.st.home - 3.5, hi = W.lay.W + (W.phase === 'fight' ? 40 : 0) - viewW + 0.5;
    var tx = clamp(fx - viewW * 0.42, lo, Math.max(lo, hi));
    var ty = 0;
    if (fy > visD * 0.62) ty = fy - visD * 0.55;
    ty = clamp(ty, 0, Math.max(0, W.lay.maxD + 1 - visD));
    var cam = S.cam;
    if (!cam.ok) { cam.x = tx; cam.y = ty; cam.ok = true; }
    var k = Math.min(1, S.dt * 2.6);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * Math.min(1, S.dt * 2);
    return { sx: sx, sy: sy, cx: cam.x, cy: cam.y, Ys: skyH - cam.y * sy, viewW: viewW, visD: visD, skyH: skyH };
  }
  function X(V, x) { return (x - V.cx) * V.sx; }
  function Y(V, y) { return y >= 0 ? V.Ys + y * V.sy : V.Ys + y * V.sx; }

  function draw() {
    if (!S || !S.W) return;
    var c = S.ctx, W = S.W, V = S.V = view(), SW = S.SW, SH = S.SH, t = S.t, cond = W.cond, L = W.L;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    var dl = dayLight(W.min), wx = cond.wx, winter = cond.season === 3;
    // sky
    var sk = skyAt(W.min), top = weatherMix(sk[0], wx, 0.9), bot = weatherMix(sk[1], wx, 0.9);
    if (S.flash > 0) { top = mix(top, [230, 236, 255], S.flash * 0.7); bot = mix(bot, [230, 236, 255], S.flash * 0.7); }
    if (V.Ys > 0) {
      var g = c.createLinearGradient(0, 0, 0, V.Ys);
      g.addColorStop(0, css(sc(top))); g.addColorStop(1, css(sc(bot)));
      c.fillStyle = g; c.fillRect(0, 0, SW, V.Ys + 2);
      drawSkyBits(c, V, W, dl);
      drawHorizon(c, V, W, dl, winter);
    }
    // water
    var wtop = Math.max(0, V.Ys), clar = L.clar * 1.3, nl = 0.25 + 0.75 * dl;
    function wcol(d) { var k = 1 - Math.exp(-Math.max(0, d) / clar); return sc(mul(weatherMix(mix(L.surf, L.deep, k), wx, 0.35), nl * (1 - 0.25 * k))); }
    var d0 = Math.max(0, V.cy - 0.3), d1 = V.cy + (SH - V.Ys) / V.sy;
    var wg = c.createLinearGradient(0, wtop, 0, SH);
    for (var i = 0; i <= 4; i++) { var dd = lerp(Math.max(d0, (wtop - V.Ys) / V.sy), d1, i / 4); wg.addColorStop(i / 4, css(wcol(dd))); }
    c.fillStyle = wg;
    // the surface follows the waves
    c.beginPath();
    c.moveTo(0, SH);
    var step = 8;
    for (var px = 0; px <= SW + step; px += step) { var wxp = V.cx + px / V.sx; c.lineTo(px, Y(V, surfY(W, wxp, t))); }
    c.lineTo(SW, SH); c.closePath(); c.fill();
    S.wcol = wcol;
    // light shafts on bright days
    if (dl > 0.6 && (wx === 0 || wx === 1) && V.Ys > -40) {
      c.save(); c.globalCompositeOperation = 'lighter';
      var ra = (wx === 0 ? 0.07 : 0.035) * (S.th.dark ? 0.6 : 1);
      for (i = 0; i < 5; i++) {
        var bx = ((i * 0.23 + 0.07) * SW + t * 6 * (i % 2 ? 1 : -0.7)) % (SW + 120) - 60, bw = 18 + (i * 13) % 30;
        var rg = c.createLinearGradient(0, V.Ys, 0, V.Ys + 7 * V.sy);
        rg.addColorStop(0, 'rgba(255,250,220,' + ra + ')'); rg.addColorStop(1, 'rgba(255,250,220,0)');
        c.fillStyle = rg; c.beginPath(); c.moveTo(bx, V.Ys); c.lineTo(bx + bw, V.Ys); c.lineTo(bx + bw + 60, V.Ys + 7 * V.sy); c.lineTo(bx + 60 - bw * 0.5, V.Ys + 7 * V.sy); c.fill();
      }
      c.restore();
    }
    drawBottom(c, V, W, wcol, nl, winter);
    drawMotes(c, V, W, nl);
    // fish
    var fi, fish = W.fish;
    for (i = 0; i < fish.length; i++) {
      fi = fish[i];
      var fxp = X(V, fi.x), Lp = clamp(fi.lm * V.sx * 2, 10, 190);
      if (fxp < -Lp || fxp > SW + Lp) continue;
      var fyp = Y(V, fi.y);
      if (fyp < -Lp || fyp > SH + Lp) continue;
      drawOneFish(c, V, W, fi, fxp, fyp, Lp, false);
    }
    if (W.fight) { var F = W.fight, ff = F.f; drawOneFish(c, V, W, ff, X(V, ff.x), Y(V, ff.y), clamp(ff.lm * V.sx * 2, 12, 210), true); }
    if (S.save.up.finder && S.mode !== 'daily') drawSonar(c, V, W);
    // surface sheen, pads, ice
    c.strokeStyle = css(sc(mix(weatherMix(sk[1], wx), [255, 255, 255], 0.35)), 0.55 * (0.4 + 0.6 * dl));
    c.lineWidth = 1.5;
    c.beginPath();
    for (px = 0; px <= SW + step; px += step) { var wxq = V.cx + px / V.sx, yq = Y(V, surfY(W, wxq, t)); if (px === 0) c.moveTo(px, yq); else c.lineTo(px, yq); }
    c.stroke();
    if (W.lay.pads.length) drawPads(c, V, W, t, dl);
    drawRipples(c, V, W);
    if (W.st.hole) drawIce(c, V, W, dl);
    drawStand(c, V, W, dl, winter);
    drawLine(c, V, W, dl);
    drawParts(c, V, W);
    drawWeather(c, V, W, dl, winter);
    // night / fog veils
    if (wx === 4) {
      var fg = c.createLinearGradient(0, 0, 0, SH);
      fg.addColorStop(0, css(sc([206, 210, 214]), 0.0)); fg.addColorStop(Math.max(0.05, Math.min(0.95, (V.Ys - 20) / SH)), css(sc([206, 210, 214]), 0.42)); fg.addColorStop(1, css(sc([150, 160, 168]), 0.25));
      c.fillStyle = fg; c.fillRect(0, 0, SW, SH);
    }
    if (S.flash > 0) { c.fillStyle = 'rgba(235,240,255,' + (S.flash * 0.35).toFixed(3) + ')'; c.fillRect(0, 0, SW, SH); }
    drawHud(c, V, W);
  }

  function drawSkyBits(c, V, W, dl) {
    var SW = S.SW, t = S.t, wx = W.cond.wx, min = ((W.min % 1440) + 1440) % 1440;
    // stars
    if (dl < 0.5 && (wx === 0 || wx === 4)) {
      var a = (0.5 - dl) * 1.6 * (wx === 4 ? 0.3 : 1);
      c.fillStyle = 'rgba(255,255,240,' + a.toFixed(3) + ')';
      for (var i = 0; i < S.stars.length; i++) { var st = S.stars[i], sy = st[1] * V.Ys * 0.85; if (sy < V.Ys - 6) c.fillRect(st[0] * SW, sy, st[2], st[2]); }
    }
    // the sun or the moon on an arc across the sky
    var sunUp = min > 330 && min < 1230, f = sunUp ? (min - 330) / 900 : ((min + (min < 330 ? 1440 : 0)) - 1230) / 540;
    var cx = SW * (0.1 + 0.8 * f), cy = V.Ys * (0.92 - 0.75 * Math.sin(Math.PI * clamp(f, 0, 1)));
    var hid = wx === 2 || wx === 3 ? 0.15 : wx === 1 ? 0.35 : wx === 4 ? 0.5 : 1;
    if (cy < V.Ys) {
      if (sunUp) {
        var low = 1 - Math.sin(Math.PI * clamp(f, 0, 1)), col = mix([255, 244, 200], [255, 160, 90], low);
        var rg = c.createRadialGradient(cx, cy, 0, cx, cy, 46);
        rg.addColorStop(0, css(col, 0.55 * hid)); rg.addColorStop(1, css(col, 0));
        c.fillStyle = rg; c.beginPath(); c.arc(cx, cy, 46, 0, 6.283); c.fill();
        c.fillStyle = css(col, 0.95 * hid); c.beginPath(); c.arc(cx, cy, 11, 0, 6.283); c.fill();
      } else {
        c.fillStyle = 'rgba(236,238,226,' + (0.9 * hid).toFixed(3) + ')'; c.beginPath(); c.arc(cx, cy, 9, 0, 6.283); c.fill();
        c.fillStyle = css(sc(skyAt(W.min)[0]), 0.9 * hid); c.beginPath(); c.arc(cx + 4, cy - 2, 8, 0, 6.283); c.fill();
      }
    }
    // clouds drift with the wind
    var nC = [2, 6, 8, 9, 3][wx], cc = mix([250, 250, 252], [70, 74, 84], [0, 0.25, 0.45, 0.7, 0.1][wx]);
    cc = mul(cc, 0.35 + 0.65 * dl);
    for (i = 0; i < nC && i < S.clouds.length; i++) {
      var cl = S.clouds[i], x = ((cl.x * (SW + 240) + t * (4 + W.cond.wind * 14) * W.cond.wdir * cl.s) % (SW + 240) + SW + 240) % (SW + 240) - 120, y = cl.y * V.Ys * 0.7;
      c.fillStyle = css(sc(cc), 0.75);
      for (var k = 0; k < 4; k++) { c.beginPath(); c.ellipse(x + k * 16 * cl.s, y + (k % 2) * 4, 22 * cl.s, 11 * cl.s, 0, 0, 6.283); c.fill(); }
    }
    // a few birds on fine days
    if (dl > 0.6 && wx < 2 && V.Ys > 40) {
      c.strokeStyle = css(sc([40, 44, 50]), 0.6); c.lineWidth = 1.2;
      for (i = 0; i < 3; i++) {
        var bxp = ((t * (12 + i * 3) + i * 140) % (SW + 200)) - 100, byp = V.Ys * (0.22 + i * 0.08) + Math.sin(t * 2 + i) * 4, w2 = 5 + Math.sin(t * 9 + i) * 2;
        c.beginPath(); c.moveTo(bxp - 6, byp - w2 * 0.5); c.quadraticCurveTo(bxp - 3, byp - 2, bxp, byp); c.quadraticCurveTo(bxp + 3, byp - 2, bxp + 6, byp - w2 * 0.5); c.stroke();
      }
    }
  }
  function drawHorizon(c, V, W, dl, winter) {
    var SW = S.SW, L = W.L, base = V.Ys + 1, k = 0.35 + 0.65 * dl, sea = L.salt;
    var far = sc(mul(weatherMix(sea ? [70, 100, 120] : winter ? [190, 200, 214] : [70, 100, 78], W.cond.wx, 0.7), k));
    c.fillStyle = css(far, W.cond.wx === 4 ? 0.35 : 0.85);
    c.beginPath(); c.moveTo(0, base);
    var off = V.cx * V.sx * 0.15, r = S.hills;
    for (var px = 0; px <= SW + 10; px += 10) {
      var u = (px + off) * 0.01, h = sea ? (Math.max(0, Math.sin(u * 0.7 + r[0]) - 0.6) * 22) : (10 + 9 * Math.sin(u * 0.9 + r[1]) + 6 * Math.sin(u * 2.3 + r[2]) + (L.id === 'pond' || L.id === 'river' ? 5 * Math.abs(Math.sin(u * 7)) : 0));
      c.lineTo(px, base - h);
    }
    c.lineTo(SW, base); c.closePath(); c.fill();
  }
  function drawBottom(c, V, W, wcol, nl, winter) {
    var SW = S.SW, SH = S.SH, lay = W.lay, L = W.L, t = S.t;
    var x0 = V.cx - 1, x1 = V.cx + V.viewW + 1, step = Math.max(0.25, 6 / V.sx), x;
    var mud = sc(mul(L.mud, nl));
    c.beginPath(); c.moveTo(X(V, x0), SH + 2);
    for (x = x0; x <= x1 + step; x += step) c.lineTo(X(V, x), Y(V, depthAt(lay, x)));
    c.lineTo(X(V, x1 + step), SH + 2); c.closePath();
    var dm = depthAt(lay, V.cx + V.viewW / 2), bg = c.createLinearGradient(0, Y(V, Math.max(0, dm - 2)), 0, SH);
    bg.addColorStop(0, css(mix(mud, wcol(dm), 0.35))); bg.addColorStop(1, css(mul(mud, 0.55)));
    c.fillStyle = bg; c.fill();
    c.strokeStyle = css(mix(mud, [255, 255, 255], 0.18), 0.5); c.lineWidth = 1.5;
    c.beginPath();
    for (x = x0; x <= x1 + step; x += step) { var by0 = Y(V, depthAt(lay, x)); if (x === x0) c.moveTo(X(V, x), by0); else c.lineTo(X(V, x), by0); }
    c.stroke();
    // rocks
    for (var i = 0; i < lay.rocks.length; i++) {
      var rk = lay.rocks[i];
      if (rk.x < x0 - 3 || rk.x > x1 + 3) continue;
      var ry = Y(V, depthAt(lay, rk.x)), rw = rk.r * V.sx, rh = rk.r * Math.min(V.sy, V.sx * 1.3) * 0.7;
      c.fillStyle = css(mix(sc(mul([120, 118, 112], nl * (0.7 + rk.s * 0.4))), wcol(depthAt(lay, rk.x)), 0.35));
      c.beginPath(); c.ellipse(X(V, rk.x), ry, rw, rh, 0, Math.PI, 0); c.fill();
    }
    // weeds and kelp sway
    for (i = 0; i < lay.plants.length; i++) {
      var p = lay.plants[i];
      if (p.x < x0 - 2 || p.x > x1 + 2) continue;
      var by = depthAt(lay, p.x), pxs = X(V, p.x), pys = Y(V, by), ph = p.h * V.sy, sw = Math.sin(t * 0.9 + p.ph) * (8 + p.h * 3) + (W.L.cur ? 10 : 0);
      var pc = p.k === 2 ? [96, 110, 40] : p.k === 3 ? [130, 80, 60] : p.k === 1 ? [70, 120, 60] : [60, 110, 70];
      if (winter && !L.salt) pc = mix(pc, [110, 100, 80], 0.5);
      c.strokeStyle = css(mix(sc(mul(pc, nl)), wcol(by - p.h / 2), 0.3), 0.9);
      c.lineWidth = Math.max(1.5, p.w * (p.k >= 2 ? 3.5 : 2.2)); c.lineCap = 'round';
      for (var b = 0; b < (p.k === 0 ? 3 : 2); b++) {
        var o = (b - 1) * 4;
        c.beginPath(); c.moveTo(pxs + o, pys); c.quadraticCurveTo(pxs + o + sw * 0.4, pys - ph * 0.55, pxs + o + sw * (0.8 + b * 0.15), pys - ph * (0.85 + b * 0.1)); c.stroke();
      }
    }
  }
  function drawMotes(c, V, W, nl) {
    c.fillStyle = 'rgba(255,255,240,' + (0.16 * nl).toFixed(3) + ')';
    for (var i = 0; i < S.motes.length; i++) {
      var m = S.motes[i], x = ((m[0] * S.SW + S.t * m[2] * 6 - V.cx * V.sx * 0.6) % S.SW + S.SW) % S.SW, y = V.Ys + ((m[1] * (S.SH + 40) + S.t * m[2] * 2) % (S.SH + 40));
      if (y > V.Ys + 4) c.fillRect(x, y, 1.5, 1.5);
    }
  }
  function drawOneFish(c, V, W, f, x, y, Lp, hooked) {
    var l = light(W, f.y), wc = S.wcol(f.y), sp = f.sp;
    var shadeA = clamp(0.85 - l * 1.05, 0, 0.82);
    if (W.cond.wx === 4) shadeA = Math.min(0.9, shadeA + 0.15);
    var tilt = clamp(Math.atan2(f.vy, Math.abs(f.vx) + 0.2) * 0.6, -0.6, 0.6);
    var glow = sp.beh === 'phantom' ? (W.fight && W.fight.f === f && W.fight.dark ? 0.1 : 1) : 1;
    if (hooked && W.fight && W.fight.air) tilt = clamp(Math.atan2(f.vy, Math.abs(f.vx) + 0.1), -1.2, 1.2);
    // thrashing when hooked
    var wig = f.wig;
    if (shadeA < 0.8 || hooked || sp.beh === 'phantom') drawFish(c, sp, x, y, Lp, f.dir, { tilt: tilt, wig: wig, shade: [wc, hooked ? shadeA * 0.6 : shadeA], glow: glow });
    if (sp.beh === 'phantom' && glow > 0.5) { c.fillStyle = 'rgba(127,240,216,0.12)'; c.beginPath(); c.arc(x + f.dir * Lp * 0.5, y - Lp * 0.25, Lp * 0.25, 0, 6.283); c.fill(); }
  }
  function drawSonar(c, V, W) {
    c.strokeStyle = css(S.th.green, 0.75); c.lineWidth = 1.5;
    for (var i = 0; i < W.fish.length; i++) {
      var f = W.fish[i];
      if (light(W, f.y) > 0.35) continue;
      var x = X(V, f.x), y = Y(V, f.y), r = 3 + Math.min(10, f.lm * 6);
      if (x < -10 || x > S.SW + 10 || y < 0 || y > S.SH + 10) continue;
      c.beginPath(); c.arc(x, y + r * 0.5, r, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
    }
  }
  function drawPads(c, V, W, t, dl) {
    for (var i = 0; i < W.lay.pads.length; i++) {
      var p = W.lay.pads[i], x = X(V, p.x), w = p.w * V.sx;
      if (x < -w || x > S.SW + w) continue;
      var y = Y(V, surfY(W, p.x, t)) - 1;
      c.fillStyle = css(sc(mul([66, 124, 60], 0.4 + 0.6 * dl)));
      c.beginPath(); c.ellipse(x, y, w, Math.max(2, w * 0.18), 0, 0.25, 6.0); c.lineTo(x, y); c.fill();
      if (p.f) { c.fillStyle = css(sc(mul([245, 214, 226], 0.5 + 0.5 * dl))); c.beginPath(); c.arc(x + w * 0.3, y - 3, 3.2, 0, 6.283); c.fill(); }
    }
  }
  function drawIce(c, V, W, dl) {
    var st = W.st, top = Y(V, -0.15), bot = Y(V, st.iceT), hl = X(V, st.hole - 0.35), hr = X(V, st.hole + 0.35);
    var ic = sc(mul([214, 232, 242], 0.35 + 0.65 * dl)), ic2 = sc(mul([150, 190, 214], 0.35 + 0.65 * dl));
    var g = c.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, css(ic)); g.addColorStop(1, css(ic2, 0.9));
    c.fillStyle = g;
    c.fillRect(-2, top, Math.max(0, hl + 2), bot - top);
    c.fillRect(hr, top, S.SW - hr + 2, bot - top);
    c.strokeStyle = css(mul(ic2, 0.8), 0.6); c.lineWidth = 1;
    for (var i = 0; i < 7; i++) { var x = X(V, st.hole + 1.6 + i * 2.9 + (i * 7 % 3) * 0.4), k = (i * 5) % 4 - 1.5; c.beginPath(); c.moveTo(x, top + 2); c.lineTo(x + k * 3, top + (bot - top) * 0.45); c.lineTo(x + k * 1.5 + 5, bot - 1); c.moveTo(x + k * 3, top + (bot - top) * 0.45); c.lineTo(x + k * 3 + 8, top + (bot - top) * 0.6); c.stroke(); }
  }
  function drawStand(c, V, W, dl, winter) {
    var st = W.st, L = W.L, k = 0.3 + 0.7 * dl, t = S.t, feetY, footX = st.home;
    if (L.stand === 'bank') {
      var grass = winter ? [226, 232, 238] : L.id === 'river' ? [96, 128, 70] : [88, 130, 64];
      var earth = sc(mul([110, 86, 58], k));
      c.fillStyle = css(earth);
      c.beginPath(); c.moveTo(X(V, -12), Y(V, -0.55)); c.lineTo(X(V, -0.4), Y(V, -0.55)); c.quadraticCurveTo(X(V, 0.3), Y(V, -0.45), X(V, 0.9), Y(V, 0.15));
      c.lineTo(X(V, 0.9), Y(V, 0.2)); c.lineTo(X(V, -12), Y(V, 1.5)); c.closePath(); c.fill();
      c.fillStyle = css(sc(mul(grass, k)));
      c.fillRect(X(V, -12), Y(V, -0.62), X(V, -0.35) - X(V, -12), Math.max(3, 0.12 * V.sx));
      if (!winter) { c.strokeStyle = css(sc(mul(grass, k * 0.85))); c.lineWidth = 1.2; for (var i = 0; i < 9; i++) { var gx = X(V, -6 + i * 0.7); c.beginPath(); c.moveTo(gx, Y(V, -0.6)); c.lineTo(gx + Math.sin(t + i) * 2, Y(V, -0.95 - (i % 3) * 0.12)); c.stroke(); } }
      feetY = -0.6;
    } else if (L.stand === 'pier') {
      var wood = sc(mul([120, 92, 64], k)), dark = sc(mul([78, 60, 44], k));
      c.fillStyle = css(dark);
      W.lay.posts.forEach(function (px) { c.fillRect(X(V, px) - 0.14 * V.sx, Y(V, -3.6), 0.28 * V.sx, Y(V, depthAt(W.lay, Math.max(0.5, px)) + 0.3) - Y(V, -3.6)); });
      c.fillStyle = css(wood); c.fillRect(X(V, -14), Y(V, -3.75), X(V, 3.2) - X(V, -14), Math.max(4, 0.3 * V.sx));
      c.strokeStyle = css(dark); c.lineWidth = 2;
      c.beginPath(); c.moveTo(X(V, -14), Y(V, -4.75)); c.lineTo(X(V, 3), Y(V, -4.75)); c.stroke();
      for (var p = -13; p <= 3; p += 2) { c.beginPath(); c.moveTo(X(V, p), Y(V, -3.75)); c.lineTo(X(V, p), Y(V, -4.75)); c.stroke(); }
      feetY = -3.75;
    } else if (L.stand === 'boat') {
      var bob = surfY(W, 0, t) * 0.8, hull = sc(mul([236, 236, 230], k)), trim = sc(mul(S.th.acc, k));
      c.fillStyle = css(hull);
      c.beginPath(); c.moveTo(X(V, -4.2), Y(V, -1 + bob)); c.lineTo(X(V, 2.3), Y(V, -1 + bob)); c.quadraticCurveTo(X(V, 2.1), Y(V, 0.3 + bob), X(V, 1.2), Y(V, 0.55 + bob));
      c.lineTo(X(V, -3.6), Y(V, 0.55 + bob)); c.closePath(); c.fill();
      c.fillStyle = css(trim); c.fillRect(X(V, -4.2), Y(V, -1 + bob), X(V, 2.3) - X(V, -4.2), Math.max(2, 0.12 * V.sx));
      c.fillStyle = css(sc(mul([90, 96, 104], k))); c.fillRect(X(V, -3.6), Y(V, -2.3 + bob), 1.5 * V.sx, 1.3 * V.sx);
      feetY = -1 + bob;
    } else {
      // ice: a little shanty and snow
      c.fillStyle = css(sc(mul([150, 70, 60], k))); c.fillRect(X(V, -2.6), Y(V, -2.2), 2 * V.sx, 2.05 * V.sx);
      c.fillStyle = css(sc(mul([90, 60, 50], k))); c.beginPath(); c.moveTo(X(V, -2.85), Y(V, -2.2)); c.lineTo(X(V, -1.6), Y(V, -2.9)); c.lineTo(X(V, -0.35), Y(V, -2.2)); c.fill();
      c.fillStyle = css(sc(mul([250, 250, 255], k))); c.fillRect(X(V, -14), Y(V, -0.25), X(V, st.hole - 0.35) - X(V, -14), Math.max(2, 0.1 * V.sx));
      feetY = -0.15;
    }
    drawAngler(c, V, W, footX, feetY, k);
  }
  function rodTip(W) {
    var st = W.st, x = st.tip.x, y = st.tip.y, F = W.fight;
    x += S.steer * 0.9;
    if (S.charge && S.charge.on) { var p = S.charge.pow; x -= 2.6 * p; y -= 0.5 * p; }
    if (S.rodKick > 0) { x += S.rodKick * 0.8; y += S.rodKick * 0.6; }
    if (F) { var T = clamp(F.T, 0, 1.1); x += (F.f.x > x ? 1 : -1) * T * 0.4; y += T * 1.2; }
    else if (W.phase === 'fishing' && S.inpReel) y += 0.2;
    if (S.cue > 0) y += S.cue * 0.35;
    return { x: x, y: y };
  }
  function drawAngler(c, V, W, fx, fy, k) {
    var s = V.sx, x = X(V, fx), y = Y(V, fy), th = S.th;
    var skin = sc(mul([222, 180, 140], k)), coat = sc(mul(th.acc, 0.85 * k + 0.1)), pants = sc(mul([60, 66, 82], k)), hat = sc(mul([196, 170, 104], k));
    var hipY = y - 0.85 * s, shY = y - 1.45 * s, hx = X(V, fx + 0.45), hy = Y(V, fy - 1.15);
    c.lineCap = 'round';
    c.strokeStyle = css(pants); c.lineWidth = Math.max(3, 0.2 * s);
    c.beginPath(); c.moveTo(x - 0.12 * s, y); c.lineTo(x - 0.05 * s, hipY); c.moveTo(x + 0.18 * s, y); c.lineTo(x + 0.06 * s, hipY); c.stroke();
    c.strokeStyle = css(coat); c.lineWidth = Math.max(5, 0.36 * s);
    c.beginPath(); c.moveTo(x, hipY); c.lineTo(x + 0.04 * s, shY); c.stroke();
    // the rod
    var tip = rodTip(W), tx = X(V, tip.x), ty = Y(V, tip.y), F = W.fight, bend = F ? clamp(F.T, 0, 1.1) : (W.phase === 'fishing' && S.inpReel ? 0.15 : 0.04);
    var bx = hx - 0.25 * s, by = hy + 0.35 * s;
    var mx = bx + (tx - bx) * 0.55, my = by + (ty - by) * 0.55 - (1 - bend) * 0.25 * s + bend * 0.1 * s;
    var cx2 = mx + (tx > bx ? -1 : 1) * 0, cy2 = my - bend * 0.9 * s;
    c.strokeStyle = css(sc(mul([60, 46, 34], k))); c.lineWidth = Math.max(2, 0.07 * s);
    c.beginPath(); c.moveTo(bx, by); c.quadraticCurveTo(cx2, cy2, tx, ty); c.stroke();
    S.tipPx = [tx, ty];
    // arm to the handle
    c.strokeStyle = css(coat); c.lineWidth = Math.max(3, 0.15 * s);
    c.beginPath(); c.moveTo(x + 0.04 * s, shY + 0.1 * s); c.lineTo(hx, hy); c.stroke();
    // reel
    c.fillStyle = css(sc(mul([180, 180, 186], k))); c.beginPath(); c.arc(hx - 0.05 * s, hy + 0.12 * s, Math.max(2, 0.08 * s), 0, 6.283); c.fill();
    // head and hat
    c.fillStyle = css(skin); c.beginPath(); c.arc(x + 0.06 * s, shY - 0.2 * s, Math.max(3, 0.17 * s), 0, 6.283); c.fill();
    c.fillStyle = css(hat);
    c.fillRect(x - 0.2 * s, shY - 0.34 * s, 0.52 * s, Math.max(1.5, 0.06 * s));
    c.beginPath(); c.ellipse(x + 0.06 * s, shY - 0.36 * s, 0.16 * s, 0.12 * s, 0, Math.PI, 0); c.fill();
  }
  function drawLine(c, V, W, dl) {
    var tp = S.tipPx;
    if (!tp) return;
    var lu = W.lure, F = W.fight, end = null, T = 0, x, y;
    if (W.phase === 'flight' && lu) end = [X(V, lu.x), Y(V, lu.y)];
    else if (F) { end = [X(V, F.f.x + F.f.dir * F.f.lm * 0.45), Y(V, F.f.y)]; T = F.T; }
    else if (lu && W.phase === 'fishing') end = lu.def.bob ? [X(V, lu.bx), Y(V, surfY(W, lu.bx, S.t)) + S.bobDip * 6] : [X(V, lu.x), Y(V, lu.y)];
    var lc = F ? mix(S.th.dark ? [220, 220, 220] : [250, 250, 250], S.th.red, clamp((T - 0.55) / 0.4, 0, 1)) : [240, 240, 236];
    if (end) {
      var dx = end[0] - tp[0], dy = end[1] - tp[1], len = Math.hypot(dx, dy), sag = F ? (1 - clamp(T * 1.4, 0, 1)) * len * 0.22 : (S.inpReel ? 0.04 : 0.16) * len;
      if (W.phase === 'flight') sag = len * 0.08;
      c.strokeStyle = css(lc, 0.75); c.lineWidth = F ? 1 + T : 1;
      c.beginPath(); c.moveTo(tp[0], tp[1]); c.quadraticCurveTo(tp[0] + dx * 0.5, tp[1] + dy * 0.5 + sag, end[0], end[1]); c.stroke();
    }
    // bobber rig: float on top, a short leader down to the bait
    if (lu && (W.phase === 'fishing') && lu.def.bob) {
      var bx = X(V, lu.bx), by = Y(V, surfY(W, lu.bx, S.t)) + S.bobDip * 7;
      c.strokeStyle = css(lc, 0.45); c.lineWidth = 1;
      c.beginPath(); c.moveTo(bx, by); c.lineTo(X(V, lu.x), Y(V, lu.y)); c.stroke();
      drawBait(c, X(V, lu.x), Y(V, lu.y), lu);
      c.fillStyle = '#f4f2ea'; c.beginPath(); c.arc(bx, by, 4.5, 0, Math.PI); c.fill();
      c.fillStyle = '#d8362f'; c.beginPath(); c.arc(bx, by, 4.5, Math.PI, 0); c.fill();
      c.strokeStyle = '#222'; c.lineWidth = 1; c.beginPath(); c.moveTo(bx, by - 4.5); c.lineTo(bx, by - 9); c.stroke();
    } else if (lu && (W.phase === 'fishing' || W.phase === 'flight')) drawLure(c, X(V, lu.x), Y(V, lu.y), lu);
    // depth tag by the lure
    if (lu && W.phase === 'fishing') {
      x = X(V, lu.x); y = Y(V, lu.y);
      c.font = '700 10px ' + S.th.font; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillStyle = css([255, 255, 255], 0.7);
      c.fillText(lu.y.toFixed(1) + ' m', x + 9, y + 1);
    }
  }
  function drawBait(c, x, y, lu) {
    if (!lu.baited) { c.strokeStyle = '#aaa'; c.lineWidth = 1.2; c.beginPath(); c.arc(x, y + 2, 3, 0, Math.PI); c.stroke(); return; }
    c.strokeStyle = '#c86a6a'; c.lineWidth = 2.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x - 4, y); c.quadraticCurveTo(x, y + 4 + Math.sin(S.t * 6) * 2, x + 4, y); c.stroke();
  }
  function drawLure(c, x, y, lu) {
    var d = lu.def;
    c.lineWidth = 1;
    if (d.id === 's') { var fl = Math.abs(Math.sin(S.t * 14)) ; c.fillStyle = css([250, 230, 140], 0.5 + 0.5 * fl); c.beginPath(); c.ellipse(x, y, 2 + 3 * fl, 4, 0, 0, 6.283); c.fill(); c.fillStyle = '#d8362f'; c.fillRect(x + 3, y - 1.5, 5, 3); }
    else if (d.id === 'c') { c.fillStyle = '#e09a2e'; c.beginPath(); c.ellipse(x, y, 7, 3.5, 0, 0, 6.283); c.fill(); c.fillStyle = '#2e5a2e'; c.fillRect(x - 6, y - 3, 5, 2); c.strokeStyle = '#ddd'; c.beginPath(); c.moveTo(x - 7, y); c.lineTo(x - 11, y + 2); c.stroke(); }
    else if (d.id === 'j') { c.fillStyle = '#3a3a48'; c.beginPath(); c.arc(x, y, 3.2, 0, 6.283); c.fill(); c.strokeStyle = '#9a6ac8'; c.lineWidth = 1.5; for (var i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(x + 2, y); c.lineTo(x + 9, y + i * 2 + Math.sin(S.t * 8 + i) * 1.5); c.stroke(); } }
    else if (d.id === 'f') { c.fillStyle = '#efe3c0'; c.beginPath(); c.ellipse(x, y - 2, 5, 2, 0.3, 0, 6.283); c.fill(); c.strokeStyle = '#7a5a3a'; c.beginPath(); c.moveTo(x - 3, y); c.lineTo(x + 4, y); c.stroke(); }
    else if (d.id === 'd') { c.fillStyle = '#6a6a72'; c.beginPath(); c.arc(x, y - 4, 4, 0, 6.283); c.fill(); if (lu.baited) { c.fillStyle = '#b8c4cc'; c.beginPath(); c.ellipse(x + 3, y + 4, 6, 2.5, 0, 0, 6.283); c.fill(); } }
    else drawBait(c, x, y, lu);
  }
  function drawRipples(c, V, W) {
    var R = S.fx.rip;
    for (var i = 0; i < R.length; i++) {
      var r = R[i], a = 1 - r.t / r.T;
      c.strokeStyle = 'rgba(255,255,255,' + (0.5 * a).toFixed(3) + ')'; c.lineWidth = 1.2;
      c.beginPath(); c.ellipse(X(V, r.x), Y(V, 0), (0.2 + r.t * 1.4 * r.s) * V.sx, (0.05 + r.t * 0.25) * V.sx * 0.5, 0, 0, 6.283); c.stroke();
    }
  }
  function drawParts(c, V, W) {
    var P = S.fx.parts;
    for (var i = 0; i < P.length; i++) {
      var p = P[i], a = 1 - p.t / p.T;
      c.fillStyle = p.c ? css(p.c, a) : 'rgba(235,245,255,' + (0.85 * a).toFixed(3) + ')';
      var x = X(V, p.x), y = Y(V, p.y);
      c.beginPath(); c.arc(x, y, p.r * (p.bub ? 1 : a + 0.3), 0, 6.283); p.bub ? (c.strokeStyle = 'rgba(235,245,255,' + (0.6 * a).toFixed(3) + ')', c.lineWidth = 1, c.stroke()) : c.fill();
    }
  }
  function drawWeather(c, V, W, dl, winter) {
    var wx = W.cond.wx, SW = S.SW, SH = S.SH, t = S.t;
    if (wx !== 2 && wx !== 3) return;
    var n = wx === 3 ? 110 : 60, snow = winter && wx === 2, wind = W.cond.wdir * (0.2 + W.cond.wind);
    c.strokeStyle = 'rgba(210,222,240,' + (S.th.dark ? 0.35 : 0.5) + ')'; c.fillStyle = 'rgba(250,250,255,0.8)'; c.lineWidth = 1;
    if (!snow) c.beginPath();
    for (var i = 0; i < n; i++) {
      var d = S.drops[i % S.drops.length], sp = snow ? 30 + d[2] * 20 : 380 + d[2] * 220;
      var y = (d[1] * (SH + 40) + t * sp) % (SH + 40) - 20, x = ((d[0] * (SW + 60) + t * wind * (snow ? 30 : 90) + (snow ? Math.sin(t + i) * 10 : 0)) % (SW + 60) + SW + 60) % (SW + 60) - 30;
      if (y > V.Ys + 2 && !snow) continue;
      if (snow) { c.fillRect(x, y, 2, 2); continue; }
      c.moveTo(x, y); c.lineTo(x + wind * 4, y + 9);
    }
    if (!snow) c.stroke();
  }

  // ---- the canvas HUD: meters, cues and messages ----
  function pill(c, x, y, w, h, fill) { c.fillStyle = fill; c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, Math.min(h / 2, 10)); else c.rect(x, y, w, h); c.fill(); }
  function runDir(F) { return F.dark || F.air ? 0 : Math.abs(F.f.vx) > 0.15 ? (F.f.vx > 0 ? 1 : -1) : 0; }
  function hint(W) {
    var th = S.th, lu = W.lure, F = W.fight, tch = S.coarse;
    if (W.phase === 'ready') return S.charge && S.charge.on ? null : { t: W.st.hole ? (tch ? 'Tap DROP to send the jig down' : 'Space or DROP: send the jig down') : tch ? 'HOLD CAST, let go at the top — or drag back on the water' : 'HOLD Space (or CAST), let go at the top of the meter' };
    if (W.phase === 'fishing' && lu) {
      if (W.biter && W.biter.st === 'strike') return { t: 'BITE!  Tap HOOK now', col: th.gold, big: true };
      if (lu.quick) return { t: 'Reeling in…' };
      if (W.biter && W.biter.st === 'nibble') return { t: 'Nibble… wait for the bite — don\'t hook yet' };
      if (!lu.baited && (lu.def.bob || lu.def.scent)) return { t: 'Bait gone — tap REEL IN and cast again', col: th.gold };
      if (lu.def.bob) return { t: 'Wait for the float to plunge, then tap HOOK' };
      var tk = tch ? '' : ' (T)';
      return { t: lu.def.hop ? 'TWITCH' + tk + ' to hop the jig · HOLD REEL to bring it in' : 'HOLD REEL to retrieve · TWITCH' + tk + ' to tempt' };
    }
    if (F) {
      var dir = runDir(F), cn = -S.steer * dir;
      if (F.air) return { t: 'JUMP!  LET GO of reel', col: th.gold, big: true };
      if (F.T > 0.85) return { t: S.inpReel ? 'LET GO — line about to snap!' : 'Letting it run… wait for green', col: th.red, big: S.inpReel };
      if (F.slackT > 0.5) return { t: 'Slack line!  HOLD to reel', col: th.gold, big: true };
      if (dir && F.mode === 'run' && cn < 0.3) return { t: 'Steer ' + (dir > 0 ? '\u25C0' : '\u25B6') + ' against the run', col: th.acc };
      if (F.sta <= 0) return { t: 'It\'s tired — HOLD to reel it in', col: th.green };
      return { t: S.inpReel ? 'Reeling — keep it out of the red' : 'HOLD to reel · let go in the red' };
    }
    return null;
  }
  // live pad state: pressed reel, a glowing HOOK on a bite, the steer to press
  function syncLive() {
    var W = S.W, F = W.fight, rb = S.pad.querySelector('[data-hold="reel"]'), hb = S.pad.querySelector('[data-act="hook"]');
    if (rb) rb.classList.toggle('on', !!S.inpReel);
    if (hb) hb.classList.toggle('hot', !!(W.phase === 'fishing' && W.biter && W.biter.st === 'strike'));
    if (F && rb) {
      var lab = F.air ? 'Let go — jump!' : F.T > 0.85 ? (S.inpReel ? 'LET GO!' : 'Letting it run') : S.inpReel ? 'Reeling…' : 'Hold to reel';
      var el = rb.querySelector('.fs-rl');
      if (el && el.textContent !== lab) el.textContent = lab;
      rb.classList.toggle('danger', F.T > 0.85 && S.inpReel);
      var dir = runDir(F), l = S.pad.querySelector('[data-hold="l"]'), r = S.pad.querySelector('[data-hold="r"]');
      if (l) l.classList.toggle('hint', dir > 0);
      if (r) r.classList.toggle('hint', dir < 0);
    }
  }
  function drawHud(c, V, W) {
    var SW = S.SW, SH = S.SH, th = S.th, F = W.fight, f = th.font;
    var panelBg = css(th.dark ? [16, 18, 22] : [255, 255, 255], 0.78), tx = css(th.text), mu = css(th.muted);
    c.textBaseline = 'middle';
    // cast power meter
    if (S.charge && S.charge.on && W.phase === 'ready') {
      var mh = Math.min(170, SH * 0.45), mx = 12, my = SH * 0.5 - mh / 2, p = S.charge.pow;
      pill(c, mx - 4, my - 22, 24, mh + 30, panelBg);
      c.fillStyle = css(th.faint, 0.4); c.fillRect(mx, my, 16, mh);
      c.fillStyle = css(th.gold, 0.45); c.fillRect(mx, my, 16, mh * 0.07);
      c.fillStyle = p >= 0.93 && p <= 1 ? css(th.gold) : css(th.acc);
      c.fillRect(mx, my + mh * (1 - Math.min(1, p)), 16, mh * Math.min(1, p));
      if (p > 1) { c.fillStyle = css(th.red); c.fillRect(mx, my - 6, 16, 4); }
      c.font = '700 9px ' + f; c.fillStyle = tx; c.textAlign = 'center'; c.fillText('CAST', mx + 8, my - 12);
      // where it should land (before wind)
      var ax = X(V, castAim(W, Math.min(1, p))), ay = Y(V, 0) - 10;
      c.fillStyle = css(th.gold, 0.9); c.beginPath(); c.moveTo(ax - 5, ay - 7); c.lineTo(ax + 5, ay - 7); c.lineTo(ax, ay); c.fill();
    }
    // the fight panel
    if (F) {
      var bw = 16, bh = Math.min(200, SH * 0.5), bx = SW - bw - 12, by = SH * 0.5 - bh / 2 + 10, T = clamp(F.T, 0, 1);
      pill(c, bx - 40, by - 28, bw + 46, bh + 40, panelBg);
      var zones = [[0, 0.6, th.green], [0.6, 0.85, th.gold], [0.85, 1, th.red]];
      zones.forEach(function (z) { c.fillStyle = css(z[2], 0.28); c.fillRect(bx, by + bh * (1 - z[1]), bw, bh * (z[1] - z[0])); });
      var tc = T > 0.85 ? th.red : T > 0.6 ? th.gold : th.green;
      c.fillStyle = css(tc); c.fillRect(bx + 3, by + bh * (1 - T), bw - 6, bh * T);
      var dragT = Math.min(W.gear.reel.drag, W.gear.line.lb * W.dragSet) / W.gear.line.lb;
      c.fillStyle = tx; c.fillRect(bx - 3, by + bh * (1 - dragT) - 1, bw + 6, 2);
      c.font = '700 9px ' + f; c.textAlign = 'center'; c.fillStyle = tx; c.fillText('TENSION', bx - 12, by - 16);
      c.font = '600 8px ' + f; c.fillStyle = mu; c.fillText('drag', bx + bw / 2, by + bh * (1 - dragT) - 8);
      c.font = '700 8px ' + f; c.textAlign = 'right';
      c.fillStyle = css(th.red); c.fillText('SNAP', bx - 9, by + bh * 0.075);
      c.fillStyle = css(th.gold); c.fillText('risky', bx - 9, by + bh * 0.275);
      c.fillStyle = css(th.green); c.fillText('safe', bx - 9, by + bh * 0.7);
      // fish energy, line out
      var ew = Math.min(180, SW * 0.42), ex = SW / 2 - ew / 2, ey = 10, en = clamp(F.sta / F.sta0, 0, 1);
      pill(c, ex - 8, ey - 4, ew + 16, 34, panelBg);
      c.fillStyle = css(th.faint, 0.35); c.fillRect(ex, ey + 15, ew, 6);
      c.fillStyle = css(th.acc); c.fillRect(ex, ey + 15, ew * en, 6);
      var w = F.f.w, nm = w < 2 ? 'Small fish' : w < 10 ? 'Good fish' : w < 40 ? 'Big fish!' : w < 200 ? 'Huge fish!!' : 'MONSTER!!!';
      if (F.f.sp.rar === 4) nm = 'Something ancient...';
      c.font = '700 10px ' + f; c.textAlign = 'left'; c.fillStyle = tx; c.fillText(nm, ex, ey + 6);
      c.textAlign = 'right'; c.fillStyle = mu; c.fillText(F.d.toFixed(0) + '/' + W.gear.reel.spool + ' m', ex + ew, ey + 6);
      // which way it runs
      if (!F.dark && !F.air) {
        var fx = X(V, F.f.x), fy = Y(V, F.f.y), dir = Math.abs(F.f.vx) > 0.15 ? (F.f.vx > 0 ? 1 : -1) : 0;
        if (dir) {
          var good = -S.steer * dir > 0.3, ccol = good ? th.green : th.gold, off = clamp(F.f.lm * V.sx, 14, 90) + 10;
          c.fillStyle = css(ccol, 0.9); c.strokeStyle = css(ccol, 0.9); c.lineWidth = 3; c.lineCap = 'round';
          for (var k = 0; k < 2; k++) { var cx = fx + dir * (off + k * 9); c.beginPath(); c.moveTo(cx - dir * 4, fy - 6); c.lineTo(cx + dir * 2, fy); c.lineTo(cx - dir * 4, fy + 6); c.stroke(); }
        }
      }
      // rod steer gauge
      var gy = by + bh + 22, gx = SW - 70;
      if (gy < SH - 6) {
        c.fillStyle = css(th.faint, 0.5); c.fillRect(gx, gy, 56, 3);
        c.fillStyle = css(th.acc); c.beginPath(); c.arc(gx + 28 + S.steer * 26, gy + 1.5, 5, 0, 6.283); c.fill();
        c.font = '600 8px ' + f; c.fillStyle = mu; c.textAlign = 'center'; c.fillText('ROD', gx + 28, gy - 8);
      }
    }
    // tournament / derby board
    if (S.mode === 'tour' && S.tour) {
      var rows = standings(S.tour), left = Math.max(0, S.tour.end - W.min), lw = 132, lh = 16 + Math.min(4, rows.length) * 13;
      pill(c, 8, 8, lw, lh + 4, panelBg);
      c.font = '700 9px ' + f; c.textAlign = 'left'; c.fillStyle = css(th.acc); c.fillText('TOURNEY ' + clockStr(left).slice(1), 16, 18);
      var me = 0; rows.forEach(function (r, i) { if (r.you) me = i; });
      var show = rows.slice(0, 3); if (me >= 3) show.push(rows[me]);
      show.forEach(function (r, i) {
        var ri = rows.indexOf(r);
        c.fillStyle = r.you ? css(th.acc) : tx; c.textAlign = 'left'; c.font = (r.you ? '700 ' : '500 ') + '9px ' + f;
        c.fillText((ri + 1) + '. ' + (r.you ? 'You' : r.name.split(' ')[0]), 16, 32 + i * 13);
        c.textAlign = 'right'; c.fillText(r.w.toFixed(1), lw, 32 + i * 13);
      });
    } else if (S.mode === 'daily' && S.daily) {
      var lft = Math.max(0, S.daily.end - W.min);
      pill(c, 8, 8, 132, 34, panelBg);
      c.font = '700 9px ' + f; c.textAlign = 'left'; c.fillStyle = css(th.acc); c.fillText('DAILY DERBY ' + clockStr(lft).slice(1), 16, 18);
      c.fillStyle = tx; c.font = '500 9px ' + f; c.fillText('bag ' + bagW(S.daily.bag).toFixed(2) + ' lb (best ' + S.daily.lim + ')', 16, 32);
    }
    // the live prompt: what to do right now
    var hn = S.phase === 'water' && !S.paused ? hint(W) : null;
    if (hn) {
      var hs = hn.big ? 15 : 12, hy = SH - 22;
      c.font = '700 ' + hs + 'px ' + f; c.textAlign = 'center';
      var hw = Math.min(SW - 16, c.measureText(hn.t).width + 28);
      pill(c, SW / 2 - hw / 2, hy - hs / 2 - 7, hw, hs + 14, hn.col ? css(hn.col, 0.92) : panelBg);
      c.fillStyle = hn.col === th.gold ? '#1a1200' : hn.col ? (S.th.dark ? '#111' : '#fff') : tx;
      c.fillText(hn.t, SW / 2, hy + 1, SW - 24);
    }
    // messages
    var m = S.msg;
    if (m && m.t < m.T) {
      var a = Math.min(1, (m.T - m.t) * 3, m.t * 8), yy = F ? 70 : SH * 0.2;
      c.globalAlpha = a;
      c.font = '700 ' + (m.big ? 18 : 14) + 'px ' + f; c.textAlign = 'center';
      var tw = c.measureText(m.txt).width;
      pill(c, SW / 2 - tw / 2 - 14, yy - 15, tw + 28, 30, panelBg);
      c.fillStyle = m.col ? css(m.col) : tx; c.fillText(m.txt, SW / 2, yy + 1);
      if (m.sub) { c.font = '500 10px ' + f; c.fillStyle = mu; c.fillText(m.sub, SW / 2, yy + 26); }
      c.globalAlpha = 1;
    }
  }

  // ================= effects =================
  function msg(txt, o) { o = o || {}; S.msg = { txt: txt, sub: o.sub || '', t: 0, T: o.T || 1.8, col: o.col || null, big: !!o.big }; live(txt + (o.sub ? '. ' + o.sub : '')); }
  function splashFx(x, big) {
    var n = big ? 18 : 9;
    for (var i = 0; i < n; i++) S.fx.parts.push({ x: x + (Math.random() - 0.5) * 0.4, y: -0.05, vx: (Math.random() - 0.5) * (big ? 3 : 1.6), vy: -(1 + Math.random() * (big ? 4 : 2.2)), t: 0, T: 0.6 + Math.random() * 0.5, r: 1.5 + Math.random() * 2, g: 1 });
    S.fx.rip.push({ x: x, t: 0, T: 1.6, s: big ? 1.6 : 1 });
  }
  function bubbles(x, y, n) { for (var i = 0; i < n; i++) S.fx.parts.push({ x: x + (Math.random() - 0.5) * 0.3, y: y, vx: (Math.random() - 0.5) * 0.2, vy: -(0.4 + Math.random() * 0.5), t: 0, T: 1 + Math.random(), r: 1.5 + Math.random() * 1.5, bub: 1 }); }
  function confetti() {
    var W = S.W, x = W.st.anc.x + 1;
    var cols = [S.th.acc, S.th.gold, S.th.red, S.th.green];
    for (var i = 0; i < 40; i++) S.fx.parts.push({ x: x + (Math.random() - 0.5) * 2, y: -2.5, vx: (Math.random() - 0.5) * 5, vy: -(2 + Math.random() * 4), t: 0, T: 1.4 + Math.random() * 0.6, r: 2 + Math.random() * 1.5, g: 1, c: cols[i % 4] });
  }
  function stepFx(dt) {
    var P = S.fx.parts, R = S.fx.rip, i;
    for (i = P.length - 1; i >= 0; i--) {
      var p = P[i];
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.g) p.vy += 9.8 * dt;
      if (p.bub && p.y < 0.05) p.t = p.T;
      if (p.t >= p.T || (p.g && !p.c && p.y > 0.1 && p.vy > 0)) P.splice(i, 1);
    }
    if (P.length > 220) P.splice(0, P.length - 220);
    for (i = R.length - 1; i >= 0; i--) { R[i].t += dt; if (R[i].t >= R[i].T) R.splice(i, 1); }
    if (S.msg) S.msg.t += dt;
    S.cue = Math.max(0, S.cue - dt * 3);
    S.bobDip = Math.max(0, S.bobDip - dt * (S.W && S.W.biter && S.W.biter.st === 'strike' ? 0.3 : 2.5));
    S.flash = Math.max(0, S.flash - dt * 2.5);
    S.rodKick = Math.max(0, S.rodKick - dt * 3);
  }

  // ================= flow =================
  function curLvl() { return levelOf(S.save.xp); }
  function careerGear(lure) { var s = S.save; return gearStats(s.rod, s.reel, s.line, lure || s.lure, { finder: s.up.finder }); }
  function layoutSeed(loc) { return hash(S.save.seed, loc, Math.floor((S.save.day - 1) / 7)); }
  function ensureContracts() { var s = S.save; if (s.cday !== s.day) { s.contracts = genContracts(s); s.cday = s.day; } }
  function validLure(id, W) { var l = LURE[id]; return !!l && (!l.salt || (W ? W.L.salt : true)); }
  function previewWorld() {
    var s = S.save, loc = locOpen(s, s.loc).ok ? s.loc : 'pond';
    S.W = newWorld({ seed: s.seed, loc: loc, day: s.day, min: s.min, gear: careerGear(), diff: s.diff, layoutSeed: layoutSeed(loc), salt: 'pv' + (S.t | 0) });
    S.W.timeScale = 0; S.W.preview = true; S.cam.ok = false;
  }
  function toDock(tab) {
    S.phase = 'dock'; S.paused = false; S.mode = 'career'; S.tour = null; S.daily = null; S.msg = null;
    S.save.atWater = false;
    clearHeld(); S.charge = null;
    ensureContracts();
    previewWorld();
    if (tab) S.tab = tab;
    showCard('dock'); setPad('dock'); syncHead(); syncHud();
    S.snd.hush();
    persist();
    kick();
  }
  function enterWater(o) {
    var s = S.save;
    S.W = newWorld(o);
    S.W.timeScale = 1;
    S.cam.ok = false; S.acc = 0; S.fx.parts.length = 0; S.fx.rip.length = 0; S.msg = null;
    S.phase = 'water'; S.paused = false; clearHeld(); S.charge = null; S.steer = 0;
    showCard(null); setPad('cast'); syncHead(); syncHud();
    S.snd.ensure();
    kick();
  }
  function goFishing(resume) {
    var s = S.save, ok = locOpen(s, s.loc);
    if (!ok.ok) { toast(ok.why); return; }
    if (!resume) {
      if (s.min + TRAVEL_MIN >= DAY_END - 30) { toast('Too late to head out — end the day first.'); return; }
      s.min += TRAVEL_MIN;
    }
    if (!validLure(s.lure, { L: LOC[s.loc] })) s.lure = 's';
    s.atWater = true; S.mode = 'career';
    enterWater({ seed: s.seed, loc: s.loc, day: s.day, min: s.min, gear: careerGear(), diff: s.diff, layoutSeed: layoutSeed(s.loc), floatD: s.floatD, dragSet: s.drag, bait: s.bait, salt: s.stats.caught });
    S.W.hookBait = false;
    msg(LOC[s.loc].name, { sub: SEASONS[seasonOf(s.day)] + ' · ' + WX_NAME[S.W.cond.wx] + ' · ' + clockStr(S.W.min), T: 2.4 });
    persist();
  }
  function tourLoc() {
    var s = S.save, r = mulberry32(hash(s.seed, 'tloc', s.day)), open = LOCS.filter(function (L) { return locOpen(s, L.id).ok; });
    return open[Math.floor(r() * open.length)].id;
  }
  function tourFee() { return 30 + curLvl() * 15; }
  function canTour() {
    var s = S.save;
    if (curLvl() < 3) return 'Reach level 3 to enter tournaments.';
    if (s.tday === s.day) return 'Today\'s tournament is done. A new one opens tomorrow.';
    if (s.min + TRAVEL_MIN + 150 > DAY_END) return 'Too late in the day for a tournament.';
    if (s.money < tourFee()) return 'Entry is ' + money(tourFee()) + '.';
    return '';
  }
  function startTour() {
    var s = S.save, why = canTour();
    if (why) { toast(why); return; }
    var loc = tourLoc();
    s.money -= tourFee(); s.tday = s.day; s.stats.tPlayed++;
    s.loc = loc; s.min += TRAVEL_MIN;
    if (!validLure(s.lure, { L: LOC[loc] })) s.lure = 's';
    s.atWater = true;
    enterWater({ seed: s.seed, loc: loc, day: s.day, min: s.min, gear: careerGear(), diff: s.diff, layoutSeed: layoutSeed(loc), floatD: s.floatD, dragSet: s.drag, bait: s.bait, salt: 'tour' });
    S.mode = 'tour';
    S.tour = newTourney(s.seed, s.day, loc, curLvl(), S.W.min);
    S.tour.last = S.W.min;
    msg('Tournament!', { sub: '2.5 hours · heaviest 5-fish bag wins', big: true, T: 2.6 });
    persist();
  }
  function endTour() {
    var T = S.tour, rows = standings(T), rank = 0, s = S.save;
    rows.forEach(function (r, i) { if (r.you) rank = i; });
    var prize = rank < 3 && T.bag.length ? T.prizes[rank] : 0;
    s.money += prize; s.stats.earned += prize;
    if (rank === 0 && T.bag.length) { s.stats.tWins++; s.rep += 15; s.xp += 120; }
    else if (rank < 3 && T.bag.length) { s.rep += 6; s.xp += 50; }
    S.tres = { rows: rows, rank: rank, prize: prize };
    S.mode = 'career'; S.tour = null;
    stopHolds();
    S.phase = 'over'; showCard('tres'); setPad('next'); syncHead();
    S.snd.tone(rank === 0 ? 784 : 523, 0.2, 'triangle', 0.05); if (rank === 0) [988, 1175, 1568].forEach(function (f, j) { S.snd.tone(f, 0.14, 'triangle', 0.04, 0, 0.12 * (j + 1)); });
    persist();
  }
  function startDaily() {
    var date = todayStr(), sp = dailySpec(date), s = S.save;
    var lure = sp.lures[s.lure] ? s.lure : 's';
    S.mode = 'daily';
    enterWater({ seed: sp.seed, loc: sp.loc, day: sp.season * SEASON_DAYS + 1, min: sp.min, gear: gearStats(sp.rod, sp.reel, sp.line, lure, {}), diff: s.diff, cond: sp.cond, layoutSeed: sp.seed, bait: 99, noLegend: true, floatD: s.floatD, dragSet: s.drag, salt: 'daily' });
    S.mode = 'daily';
    S.daily = { spec: sp, bag: [], end: sp.min + sp.dur, lim: sp.lim, lure: lure };
    msg('Daily Derby', { sub: LOC[sp.loc].name + ' · 90 minutes · best ' + sp.lim + ' fish', big: true, T: 2.6 });
  }
  function endDaily() {
    var D = S.daily, s = S.save, score = bagW(D.bag), prev = s.daily[D.spec.date] || 0;
    if (score > prev) s.daily[D.spec.date] = score;
    S.dres = { score: score, prev: prev, best: Math.max(prev, score), date: D.spec.date, n: D.bag.length };
    stopHolds();
    S.phase = 'over'; showCard('dres'); setPad('dock'); syncHead();
    persist();
  }
  function endDay(auto) {
    var s = S.save;
    s.min = Math.min(s.min, DAY_END);
    var sold = s.creel.length ? sellCreel(s) : 0;
    S.dayRes = { day: s.day, n: s.today.n, rel: s.today.rel, earn: s.today.earn + sold, sold: sold, done: s.contracts.filter(function (c) { return c.done; }).length, auto: !!auto };
    s.today.earn += sold;
    s.day++; s.min = DAY_START + 60; s.stats.days++; s.atWater = false;
    s.today = { n: 0, rel: 0, earn: 0 };
    ensureContracts();
    S.mode = 'career'; S.tour = null; S.msg = null;
    stopHolds();
    S.phase = 'over';
    previewWorld();
    showCard('dayend'); setPad('dock'); syncHead(); syncHud();
    persist();
  }
  function toast(t) { if (Cade.showToast) Cade.showToast(t, 'info', 2200); }

  // ---- the catch ----
  function onLanded(e) {
    var s = S.save, sp = SP[e.sp], W = S.W, info = { sp: sp, w: e.w, len: e.len, xp: 0, lv: false, done: [], val: priceOf(sp, e.w, 1, s.rep), rep: releaseRep(sp, e.w) };
    var lr = logCatch(s, e.sp, e.w, e.len, s.day);
    info.first = lr.first; info.record = lr.record;
    if (S.mode !== 'daily') {
      info.xp = catchXp(sp, e.w);
      var l0 = levelOf(s.xp);
      s.xp += info.xp;
      info.done = contractEvent(s, { kind: 'catch', sp: e.sp, w: e.w, loc: W.L.id, min: W.min });
      info.lv = levelOf(s.xp) > l0 ? levelOf(s.xp) : 0;
      if (S.mode === 'tour' && S.tour) { addBag(S.tour.bag, e.w, S.tour.lim); info.tour = true; }
      s.today.n++;
    } else { addBag(S.daily.bag, e.w, S.daily.lim); info.daily = true; }
    s.stats.caught = s.stats.caught;
    S.catchInfo = info; S.catchAt = { x: W.st.anc.x + 1 };
    stopHolds();
    S.phase = 'catch';
    splashFx(W.st.anc.x + 0.8, true);
    if (info.first || info.record || sp.rar >= 3) confetti();
    showCard('catch'); setPad('catch'); syncHud();
    var notes = [659, 784, 988, 1319];
    notes.forEach(function (f, j) { S.snd.tone(f, 0.13, 'triangle', 0.04, 0, j * 0.08); });
    haptic(50);
    persist();
  }
  function finishCatch() {
    S.catchInfo = null; S.catchAt = null;
    S.W.phase = 'ready';
    S.phase = 'water';
    showCard(null); setPad('cast'); syncHud();
    persist();
    kick();
  }
  function keepFish() {
    var s = S.save, ci = S.catchInfo;
    if (!ci) return;
    if (ci.daily) { finishCatch(); return; }
    if (s.creel.length >= creelCap(s)) { toast('Your creel is full — release it, or sell at the dock.'); return; }
    s.creel.push({ sp: ci.sp.id, w: ci.w, len: ci.len, at: absMin(s.day, S.W.min) });
    S.snd.tone(523, 0.08, 'sine', 0.04);
    finishCatch();
  }
  function releaseFish() {
    var s = S.save, ci = S.catchInfo;
    if (!ci) return;
    if (!ci.daily) {
      s.rep += ci.rep; s.stats.released++; s.today.rel++;
      if (s.journal[ci.sp.id]) s.journal[ci.sp.id].rel++;
      var d = contractEvent(s, { kind: 'release', min: S.W.min });
      if (d.length) toast('Contract done: ' + d[0].text + ' (+' + money(d[0].pay) + ')');
      msg('Released', { sub: '+' + ci.rep + ' reputation', T: 1.4 });
    }
    var W = S.W;
    bubbles(W.st.anc.x + 1, 0.4, 8);
    S.snd.tone(392, 0.12, 'sine', 0.035, 523);
    finishCatch();
  }

  // ---- events from the world ----
  function handleEvents() {
    var W = S.W, E = W.ev;
    for (var i = 0; i < E.length; i++) {
      var e = E[i];
      switch (e.type) {
        case 'cast': S.rodKick = 1; S.snd.noise(0.25, 2400, 'bandpass', 0.03, 0, 0.5); if (e.perfect) msg('Perfect cast!', { col: S.th.gold, T: 1.1 }); break;
        case 'splash': splashFx(e.x, e.big); S.snd.splash(e.big); setPad(W.phase === 'fight' ? 'fight' : 'fishing'); break;
        case 'drop': S.fx.rip.push({ x: e.x, t: 0, T: 1, s: 0.5 }); S.snd.tone(260, 0.1, 'sine', 0.03, 150); setPad('fishing'); break;
        case 'nibble': S.cue = 0.5 * e.k; S.bobDip = 0.35 + 0.3 * e.k; S.snd.tone(900, 0.03, 'square', 0.012 + 0.012 * W.gear.rod.sens); haptic(8); if (W.lure) S.fx.rip.push({ x: W.lure.def.bob ? W.lure.bx : W.lure.x, t: 0, T: 0.7, s: 0.3 }); live('Nibble'); break;
        case 'strike': S.cue = 1.2; S.bobDip = 1.5; msg('BITE! Tap HOOK', { big: true, col: S.th.gold, T: e.win + 0.2 }); S.snd.tone(140, 0.16, 'triangle', 0.08, 70); haptic(35); flashHook(); break;
        case 'hooked': msg(e.solid ? 'Fish on!' : 'Fish on — light hookset', { big: true, col: S.th.green, T: 1.4 }); S.snd.tone(330, 0.1, 'square', 0.04, 660); haptic(70); S.steer = 0; setPad('fight'); bubbles(e.x, e.y, 6); if (!S.save.tut) { S.save.tut = 1; persist(); W.ev.length = 0; tutorial(); return; } break;
        case 'early': msg('Too early — spooked it', { col: S.th.red }); S.snd.tone(200, 0.15, 'sine', 0.04, 120); haptic(15); break;
        case 'missed': msg(e.bait ? 'Too late — bait stolen' : 'Too late — it let go', { col: S.th.red }); S.snd.tone(240, 0.15, 'sine', 0.04, 160); break;
        case 'spooked': msg('Spooked it', { T: 1 }); break;
        case 'in': setPad('cast'); S.snd.tone(660, 0.05, 'sine', 0.02); break;
        case 'jump': splashFx(e.x, true); haptic(25); break;
        case 'surge': msg('It\'s not done yet!', { col: S.th.red, big: true }); haptic(40); break;
        case 'bolt': msg('It bolts!', { T: 1 }); break;
        case 'nobait': msg('Out of bait', { sub: 'Buy more at the shop, or switch lures (L)', col: S.th.red, T: 2.4 }); break;
        case 'nosalt': msg('Deep rigs need salt water', { T: 2 }); break;
        case 'lost': onLost(e); break;
        case 'landed': W.ev.length = 0; onLanded(e); return;
      }
    }
    E.length = 0;
  }
  function onLost(e) {
    var s = S.save, W = S.W;
    stopHolds(true);
    if (e.why === 'snap') { msg('SNAP! The line broke', { big: true, col: S.th.red }); S.snd.tone(1800, 0.06, 'square', 0.05, 300); s.stats.snaps++; haptic(90); S.shake = 0.5; }
    else if (e.why === 'spooled') { msg('Spooled! It took all your line', { big: true, col: S.th.red, sub: 'A bigger reel holds more line' }); s.stats.snaps++; haptic(90); }
    else { msg(e.how === 'jump' ? 'It shook free mid-jump' : 'It threw the hook', { col: S.th.red, sub: e.how === 'jump' ? 'Let off the reel when it leaps' : 'Keep the line tight' }); s.stats.lost++; haptic(40); }
    setPad(W.phase === 'fishing' ? 'fishing' : 'cast');
    persist();
  }
  function flashHook() {}

  // ================= input =================
  function clearHeld() { S.keys = {}; S.held = { l: 0, r: 0 }; S.reelSrc = {}; S.cvSteer = 0; S.drag = null; S.twitchQ = 0; S.hookQ = false; S.inpReel = false; }
  function stopHolds(keepCharge) { S.reelSrc = {}; S.inpReel = false; S.held = { l: 0, r: 0 }; S.cvSteer = 0; if (!keepCharge) S.charge = null; S.drag = null; var bs = S.pad.querySelectorAll('.on'); for (var i = 0; i < bs.length; i++) bs[i].classList.remove('on'); }
  function atWater() { return S && S.phase === 'water' && !S.paused && S.W; }
  function startCharge(drag) {
    if (!atWater() || S.W.phase !== 'ready') return;
    var lu = S.W.gear.lure;
    if ((lu.bob || lu.scent) && S.W.bait <= 0 && !S.W.hookBait) { msg('Out of bait', { sub: 'Buy more at the shop, or switch lures (L)', col: S.th.red, T: 2.4 }); return; }
    S.charge = { on: true, t: 0, pow: 0, drag: !!drag };
    if (S.W.st.hole) { S.charge = null; doCast(1, 1); }
  }
  function releaseCharge() {
    var ch = S.charge;
    if (!ch || !ch.on) return;
    S.charge = null;
    if (!atWater() || S.W.phase !== 'ready') return;
    var p = ch.pow, q;
    if (ch.drag) { if (p < 0.08) return; q = p >= 0.92 && p <= 1.06 ? 1 : p > 1.06 ? 0.35 : 0.4 + 0.5 * p; p = Math.min(1, p); }
    else q = p >= 0.93 ? 1 : 0.4 + 0.5 * p;
    doCast(Math.max(0.06, p), q);
  }
  function doCast(p, q) {
    var W = S.W;
    if (cast(W, p, q)) setPad(W.phase === 'fishing' ? 'fishing' : 'flight');
  }
  function reelDown(src) {
    if (!atWater()) return;
    var W = S.W;
    if (W.phase === 'fishing' && W.biter && W.biter.st === 'strike') { S.hookQ = true; S.reelSrc[src] = 'hook'; return; }
    if (W.phase === 'fishing' || W.phase === 'fight') S.reelSrc[src] = { t: S.t };
  }
  function reelUp(src) {
    var e = S.reelSrc[src];
    delete S.reelSrc[src];
    if (!atWater() || !e || e === 'hook') return;
  }
  function doTwitch() {
    var W = S.W;
    if (!atWater() || W.phase !== 'fishing' || !W.lure || W.lure.def.bob || W.lure.quick) return;
    S.twitchQ++;
    S.snd.tone(1400, 0.02, 'square', 0.012);
  }
  function doReelIn() {
    var W = S.W;
    if (!atWater() || W.phase !== 'fishing') return;
    if (reelIn(W)) { msg('Reeling in…', { T: 0.9 }); S.snd.tone(520, 0.08, 'sine', 0.03, 880); }
  }
  function anyReel() { for (var k in S.reelSrc) if (S.reelSrc[k] !== 'hook') return true; return false; }
  function cycleLure(dirn) {
    var W = S.W, ids = LURES.filter(function (l) { return S.mode === 'daily' ? S.daily.spec.lures[l.id] : S.save.lures[l.id]; }).filter(function (l) { return !W || validLure(l.id, W); }).map(function (l) { return l.id; });
    if (!ids.length) return;
    var cur = W ? W.gear.lure.id : S.save.lure, i = (ids.indexOf(cur) + (dirn || 1) + ids.length) % ids.length, id = ids[i];
    if (S.mode === 'daily') S.daily.lure = id; else S.save.lure = id;
    if (W && W.phase === 'ready') {
      W.gear = S.mode === 'daily' ? gearStats(S.daily.spec.rod, S.daily.spec.reel, S.daily.spec.line, id, {}) : careerGear(id);
      W.hookBait = false;
      setPad('cast');
      msg(LURE[id].name, { sub: LURE[id].note, T: 2.2 });
    }
    S.snd.tone(880, 0.04, 'sine', 0.025);
    persist();
  }
  function adjFloat(d) {
    var W = S.W;
    if (!W || W.phase !== 'ready' || !W.gear.lure.bob) return;
    W.floatD = clamp(Math.round((W.floatD + d) * 4) / 4, 0.5, Math.min(8, Math.max(1, W.lay.maxD)));
    if (S.mode !== 'daily') S.save.floatD = W.floatD;
    var el = S.pad.querySelector('.fs-depth b'); if (el) el.textContent = W.floatD.toFixed(2) + ' m';
    S.snd.tone(700 + W.floatD * 60, 0.03, 'sine', 0.02);
  }
  function adjDrag(d) {
    var W = S.W;
    if (!W) return;
    W.dragSet = clamp(Math.round((W.dragSet + d) * 100) / 100, 0.4, 0.9);
    if (S.mode !== 'daily') S.save.drag = W.dragSet;
    var el = S.pad.querySelector('[data-act="drag"] b'); if (el) el.textContent = Math.round(W.dragSet * 100) + '%';
    S.snd.tone(500 + W.dragSet * 500, 0.03, 'square', 0.015);
  }
  function buildInput() {
    var k = S.keys, tgt = (S.held.r || k.ArrowRight || k.KeyD ? 1 : 0) - (S.held.l || k.ArrowLeft || k.KeyA ? 1 : 0) + S.cvSteer;
    tgt = clamp(tgt, -1, 1);
    S.steer += clamp(tgt - S.steer, -S.dt * 5, S.dt * 5);
    S.inpReel = anyReel();
    return { reel: S.inpReel, steer: S.steer, twitch: 0, hook: false };
  }

  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', j: 'KeyJ', l: 'KeyL', t: 'KeyT', backspace: 'Backspace', h: 'KeyH', r: 'KeyR', k: 'KeyK', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e), W = S.W;
    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      if (e.repeat) return;
      if (S.phase === 'water' && !S.paused) pause();
      else if (S.cardKind === 'tut' && S.tutFrom) { S.tutFrom = null; showCard('help'); }
      else if (S.paused && (S.cardKind === 'journal' || S.cardKind === 'help')) showCard('pause');
      else if (S.paused) resume();
      else if (S.phase === 'dock' && S.cardKind === 'help') { S.firstRun = false; showCard('dock'); }
      else if (S.phase === 'dock' && code === 'Escape') closePanel();
      return;
    }
    if (code === 'KeyJ' && !e.repeat) {
      e.preventDefault();
      if (S.phase === 'water' && !S.paused) { pause(); showCard('journal'); }
      else if (S.paused) showCard(S.cardKind === 'journal' ? 'pause' : 'journal');
      else if (S.phase === 'dock') { S.tab = S.tab === 'journal' ? 'fish' : 'journal'; showCard('dock'); }
      return;
    }
    if (atWater()) {
      var ph = W.phase;
      if (code === 'Space') {
        e.preventDefault();
        if (e.repeat) return;
        S.snd.ensure();
        if (ph === 'ready') startCharge(false);
        else reelDown('key');
        return;
      }
      if (code === 'Enter' || code === 'NumpadEnter' || code === 'KeyH') { e.preventDefault(); if (!e.repeat && ph === 'fishing') S.hookQ = true; return; }
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD') { e.preventDefault(); S.keys[code] = true; return; }
      if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'KeyW' || code === 'KeyS') {
        e.preventDefault();
        var up = code === 'ArrowUp' || code === 'KeyW';
        if (ph === 'ready') adjFloat(up ? 0.25 : -0.25); else if (ph === 'fight') adjDrag(up ? 0.05 : -0.05);
        return;
      }
      if (code === 'KeyL' && !e.repeat) { e.preventDefault(); if (ph === 'ready') cycleLure(1); return; }
      if (code === 'KeyT' && !e.repeat) { e.preventDefault(); doTwitch(); return; }
      if ((code === 'KeyR' || code === 'Backspace') && !e.repeat) { e.preventDefault(); doReelIn(); return; }
      return;
    }
    if (S.phase === 'catch') {
      if ((code === 'Space' || code === 'Enter' || code === 'KeyK') && !e.repeat) { e.preventDefault(); if (t && t.tagName === 'BUTTON' && S.panel.contains(t) && code !== 'KeyK') return; keepFish(); return; }
      if (code === 'KeyR' && !e.repeat) { e.preventDefault(); releaseFish(); return; }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) padAction(S.padMode === 'dock' ? 'go' : S.padMode === 'next' ? 'next' : S.padMode === 'resume' ? 'resume' : S.padMode === 'start' ? 'start' : 'go');
    }
  }
  function onKeyUp(e) {
    if (!S) return;
    var code = keyCode(e);
    if (S.keys[code]) delete S.keys[code];
    if (code === 'Space') {
      if (S.charge && S.charge.on && !S.charge.drag) releaseCharge();
      reelUp('key');
    }
  }

  // ================= pause / cards =================
  function tutorial() {
    S.paused = true; S.tutFrom = null;
    stopHolds(); clearHeld();
    showCard('tut'); setPad('tutgo'); syncHead();
    S.snd.hush();
    draw();
  }
  function tutHtml() {
    var tch = S.coarse;
    return '<div class="fs-card fs-tut"><div class="fs-title">FISH ON!</div><p class="fs-sub">How a fight works — one rule: <b>hold</b> or <b>let go</b>.</p>' +
      '<ol class="fs-steps">' +
      '<li><b>Hook</b> &nbsp;when <b class="k-gold">BITE!</b> shows (the float plunges, the rod jerks), tap <b>HOOK</b> once' + (tch ? '' : ' (Enter or Space)') + '. Too early on a nibble spooks it; too late and it lets go.</li>' +
      '<li><b>Hold to reel</b> &nbsp;hold <b>REEL</b>' + (tch ? ' or the water' : ' or Space') + ': you win line, tension rises.</li>' +
      '<li><b>Let go to let it run</b> &nbsp;in the <b class="k-red">red</b> the line snaps — let go and tension falls. A slack line for too long and it throws the hook.</li>' +
      '<li><b>Steer</b> &nbsp;arrows by the fish show its run. Press the <b>opposite</b> way (' + (tch ? '&#9664; &#9654; or drag on the water' : '&larr; &rarr; or &#9664; &#9654;') + ') — pulling against it tires it fast.</li>' +
      '<li><b>Jumps</b> &nbsp;let go while it is in the air.</li></ol>' +
      '<pre class="fs-meter" aria-hidden="true">TENSION [<span class="k-green">  safe  </span>|<span class="k-gold">risky</span>|<span class="k-red">SNAP</span>]</pre>' +
      '<p class="fs-tip">Drain its energy bar, then reel it to your feet. Bigger fish need stronger line, a better drag and a bigger spool.</p>' +
      (S.tutFrom ? '<button type="button" class="fs-go" data-act="tut-back">Back</button>' : '') + '</div>';
  }
  function pause() {
    if (!S || S.phase !== 'water' || S.paused) return;
    S.paused = true;
    stopHolds(); clearHeld();
    showCard('pause'); setPad('resume'); syncHead();
    S.snd.hush();
    draw();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    setPad(S.W.phase === 'fight' ? 'fight' : S.W.phase === 'fishing' || S.W.phase === 'flight' ? 'fishing' : 'cast');
    syncHead();
    kick();
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = '';
    if (kind === 'help') h = helpHtml(S.firstRun);
    else if (kind === 'tut') h = tutHtml();
    else if (kind === 'dock') h = dockHtml();
    else if (kind === 'pause') h = pauseHtml();
    else if (kind === 'catch') h = catchHtml();
    else if (kind === 'journal') h = '<div class="fs-card fs-wide">' + journalHtml() + '<button type="button" class="fs-go" data-act="back-pause">Back</button></div>';
    else if (kind === 'dayend') h = dayendHtml();
    else if (kind === 'tres') h = tresHtml();
    else if (kind === 'dres') h = dresHtml();
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind && kind !== 'catch');
    S.ovl.classList.toggle('fs-low', kind === 'catch');
    S.ovl.scrollTop = S.ovlScroll && kind === 'dock' ? S.ovlScroll : 0;
    S.ovlScroll = 0;
    renderThumbs();
  }
  function rerenderCard() { var st = S.ovl.scrollTop; showCard(S.cardKind); S.ovl.scrollTop = st; }
  function renderThumbs() {
    var cvs = S.ovl.querySelectorAll('canvas[data-th]');
    for (var i = 0; i < cvs.length; i++) {
      var cv = cvs[i], sp = SP[cv.getAttribute('data-th')], got = cv.hasAttribute('data-got'), big = cv.hasAttribute('data-big');
      var w = cv.clientWidth || (big ? 220 : 64), h = cv.clientHeight || (big ? 90 : 30), k = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      var c = cv.getContext('2d');
      c.setTransform(k, 0, 0, k, 0, 0);
      var D = SHAPES[sp.shape] || SHAPES.bass, L = Math.min(w * 0.86, h / Math.max(0.3, D.h * 1.25 + (D.dor === 'sail' ? 0.4 : 0.1)));
      drawFish(c, sp, w / 2 + (D.bill ? -L * 0.05 : 0), h / 2 + (D.dor === 'sail' || D.dor === 'lantern' ? L * 0.08 : 0), L, 1, got ? { wig: 0.3 } : { sil: S.th.dark ? [70, 74, 82] : [176, 180, 186], wig: 0.3 });
    }
  }
  function setPad(mode) {
    S.padMode = mode;
    var h = '', W = S.W, k = S.coarse ? '' : ' <small>space</small>';
    if (mode === 'cast') {
      var lu = W.gear.lure;
      h = '<button type="button" class="fs-pb fs-lure" data-act="lure" aria-label="Change lure (L)"><small>lure</small>' + esc(lu.name) + (lu.bob || lu.scent ? '<i>' + (S.mode === 'daily' ? '' : W.bait + ' bait') + '</i>' : '') + '</button>';
      h += '<button type="button" class="fs-act" data-hold="cast">' + (W.st.hole ? 'Drop' : 'Cast') + (S.coarse ? '<small>hold</small>' : ' <small>hold space</small>') + '</button>';
      if (lu.bob) h += '<div class="fs-depth"><button type="button" class="fs-sq" data-act="fd-">&minus;</button><span><small>float</small><b>' + W.floatD.toFixed(2) + ' m</b></span><button type="button" class="fs-sq" data-act="fd+">+</button></div>';
    } else if (mode === 'fishing' || mode === 'flight') {
      var lu2 = W.gear.lure;
      h = (lu2.bob ? '' : '<button type="button" class="fs-pb fs-tw" data-act="twitch" aria-label="Twitch the lure (T)"><small>twitch</small><b>~</b></button>') +
        '<button type="button" class="fs-act fs-hook" data-act="hook">Hook<small>' + (S.coarse ? 'tap on a bite' : 'enter / space on a bite') + '</small></button>' +
        '<button type="button" class="fs-act fs-reel" data-hold="reel">Reel<small>' + (S.coarse ? 'hold' : 'hold space') + '</small></button>' +
        '<button type="button" class="fs-pb fs-in" data-act="reelin" aria-label="Reel all the way in (R)"><small>reel</small><b>in</b></button>';
    } else if (mode === 'fight') {
      h = '<button type="button" class="fs-pb fs-steer" data-hold="l" aria-label="Rod left">&#9664;</button>' +
        '<button type="button" class="fs-act fs-reel fs-freel" data-hold="reel"><span class="fs-rl">Hold to reel</span><small>' + (S.coarse ? 'let go to let it run' : 'hold space · let go to let it run') + '</small></button>' +
        '<button type="button" class="fs-pb fs-steer" data-hold="r" aria-label="Rod right">&#9654;</button>' +
        '<button type="button" class="fs-pb fs-drag" data-act="drag" aria-label="Drag setting"><small>drag</small><b>' + Math.round(W.dragSet * 100) + '%</b></button>';
    } else if (mode === 'catch') {
      var ci = S.catchInfo;
      if (ci && ci.daily) h = '<button type="button" class="fs-act" data-act="keep">Weigh in' + k + '</button>';
      else h = '<button type="button" class="fs-act" data-act="keep">Keep' + (ci ? ' <small>' + money(ci.val) + '</small>' : '') + '</button><button type="button" class="fs-act alt" data-act="release">Release' + (ci ? ' <small>+' + ci.rep + ' rep</small>' : '') + '</button>';
    } else if (mode === 'dock') {
      var s = S.save, L = LOC[s.loc];
      h = S.phase === 'over' ? '<button type="button" class="fs-act" data-act="go">To the dock' + k + '</button>' : '<button type="button" class="fs-act" data-act="go">' + (s.atWater ? 'Back to the water' : 'Go fishing') + ' <small>' + esc(L.name) + '</small></button>';
    } else if (mode === 'resume') h = '<button type="button" class="fs-act" data-act="resume">Resume' + k + '</button>';
    else if (mode === 'next') h = '<button type="button" class="fs-act" data-act="next">Continue' + k + '</button>';
    else if (mode === 'tutgo') h = '<button type="button" class="fs-act" data-act="resume">Got it — fight!' + k + '</button>';
    else if (mode === 'start') h = '<button type="button" class="fs-act" data-act="start">Let\'s fish' + k + '</button>';
    S.pad.innerHTML = h;
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'water';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function syncHud() {
    if (!S) return;
    var s = S.save, W = S.W, h;
    if ((S.phase === 'water' || S.phase === 'catch') && W) {
      var c = W.cond, wind = c.wind > 0.15 ? ' <i>wind ' + (c.wdir > 0 ? '&rarr;' : '&larr;') + Math.round(c.wind * 20) + '</i>' : '';
      h = '<span class="fs-clock"><b>' + clockStr(W.min) + '</b> <i>' + BAND_NAME[bandOf(W.min)] + '</i></span><span>' + (c.wx === 2 && c.season === 3 ? 'Snow' : c.wx === 0 && bandOf(W.min) === NIGHT ? 'Clear' : WX_NAME[c.wx]) + wind + '</span>';
      if (S.mode === 'daily') h += '<span class="fs-hloc"><b>' + esc(W.L.name) + '</b></span><span>derby</span>';
      else h += '<span class="fs-hloc"><b>' + esc(W.L.short) + '</b></span><span><b>' + money(s.money) + '</b></span><span>Lv ' + curLvl() + '</span><span>creel ' + s.creel.length + '/' + creelCap(s) + '</span>';
    } else {
      h = '<span><b>Day ' + s.day + '</b> <i>' + SEASONS[seasonOf(s.day)] + '</i></span><span class="fs-clock"><b>' + clockStr(s.min) + '</b></span><span><b>' + money(s.money) + '</b></span><span>Lv ' + curLvl() + '</span><span>rep ' + s.rep + '</span>';
    }
    if (h !== S.hudHtml) { S.hud.innerHTML = h; S.hudHtml = h; }
  }
  function live(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ================= cards =================
  var ART = '     o      ,\n    /|\\_.-\'  \\\n    / \\       \\\n ~~~~~~~~~~~~~~J~~~\n   ><(((\'>     ;\n          <\')))><';
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>CAST</b> &nbsp;hold, let go at the top of the meter — or drag back on the water and let go</div>' +
      '<div><b>HOOK</b> &nbsp;one tap when <b>BITE!</b> shows (not on a nibble)</div>' +
      '<div><b>REEL</b> &nbsp;<b>hold</b> to reel, <b>let go</b> to let the fish run</div>' +
      '<div><b>&#9664; &#9654;</b> or drag &nbsp;steer the rod against the fish\'s run</div>' +
      '<div><b>TWITCH</b> &nbsp;hop a lure to tempt fish &nbsp; <b>REEL IN</b> &nbsp;wind an empty line home fast</div>' :
      '<div><b>Space</b> &nbsp;hold to charge the cast, let go at the top of the meter</div>' +
      '<div><b>Enter / H / Space</b> &nbsp;set the hook — one tap when <b>BITE!</b> shows</div>' +
      '<div><b>Space</b> &nbsp;<b>hold</b> to reel, <b>let go</b> to let the fish run</div>' +
      '<div><b>&larr; &rarr;</b> &nbsp;steer the rod against the run &nbsp; <b>&uarr; &darr;</b> &nbsp;float depth / drag</div>' +
      '<div><b>T</b> &nbsp;twitch the lure &nbsp; <b>R</b> &nbsp;reel an empty line in fast</div>' +
      '<div><b>L</b> &nbsp;change lure &nbsp; <b>J</b> &nbsp;journal &nbsp; <b>P / Esc</b> &nbsp;pause</div>' +
      '<div><b>K / R</b> &nbsp;keep or release a catch</div>';
    return '<div class="fs-card fs-help">' +
      '<pre class="fs-art" aria-hidden="true">' + esc(ART) + '</pre>' +
      '<div class="fs-title">REEL DEEP</div>' +
      '<p>Cast, tempt, hook and land fish across six waters. Each species has its own <b>place, depth, hour, weather, season and lure</b>.</p>' +
      '<div class="fs-keys">' + keys + '</div>' +
      '<div class="fs-keys fs-legend">' +
      '<div><b class="k-gold">nibble</b> &nbsp;<span>the float bobs, the rod tip ticks — wait…</span></div>' +
      '<div><b class="k-red">STRIKE</b> &nbsp;<span>the float goes under — hook it now!</span></div>' +
      '<div><b class="k-green">tension</b> &nbsp;<span>reel in the green; ease off in the red or the line snaps</span></div>' +
      '<div><b class="k-gold">slack</b> &nbsp;<span>too long with a loose line and it throws the hook</span></div>' +
      '<div><b class="k-acc">jumps</b> &nbsp;<span>let off the reel while it is in the air</span></div></div>' +
      '<button type="button" class="fs-go alt" data-act="tut">How a fight works</button>' +
      '<p class="fs-tip">Sell or release your catch, take angler-club contracts, enter tournaments, buy better gear and fill the journal. Legends only show in their exact conditions.</p>' +
      '<button type="button" class="fs-go" data-act="close-help">' + (first ? 'LET\'S PLAY' : 'Back') + '</button></div>';
  }
  function tabsHtml() {
    var tabs = [['fish', 'Fish'], ['club', 'Club'], ['shop', 'Shop'], ['journal', 'Journal'], ['angler', 'Angler']];
    return '<div class="fs-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }
  function dockHtml() {
    var s = S.save, h = '<div class="fs-card fs-wide fs-dock">';
    h += '<div class="fs-top"><span class="fs-brand">REEL DEEP</span><span class="fs-meta">Day ' + s.day + ' · ' + SEASONS[seasonOf(s.day)] + ' · ' + clockStr(s.min) + '</span></div>';
    h += tabsHtml();
    if (S.tab === 'fish') h += fishTab();
    else if (S.tab === 'club') h += clubTab();
    else if (S.tab === 'shop') h += shopTab();
    else if (S.tab === 'journal') h += journalHtml();
    else h += anglerTab();
    return h + '</div>';
  }
  function forecast() {
    var s = S.save, seg = Math.floor(s.min / 240), out = [], last = -1;
    for (var k = seg; k <= 5; k++) { var w = weatherAt(s.seed, s.day, k * 240 + 10).w; if (w !== last) { out.push((seasonOf(s.day) === 3 && w === 2 ? 'Snow' : WX_NAME[w]) + (k === seg ? '' : ' ' + clockStr(k * 240).slice(0, 2) + 'h')); last = w; } }
    return out.join(' &rarr; ');
  }
  function fishTab() {
    var s = S.save, h = '', lvl = curLvl();
    if (s.atWater) h += '<button type="button" class="fs-resume" data-act="go"><b>Back to the water</b><span>' + esc(LOC[s.loc].name) + ' · ' + clockStr(s.min) + '</span></button>';
    h += '<div class="fs-sec"><div class="fs-h">Where <i>forecast: ' + forecast() + '</i></div><div class="fs-locs">';
    LOCS.forEach(function (L) {
      var o = locOpen(s, L.id), on = s.loc === L.id;
      h += '<button type="button" class="fs-loc' + (on ? ' on' : '') + (o.ok ? '' : ' locked') + '" data-loc="' + L.id + '" aria-pressed="' + on + '"' + (o.ok ? '' : ' aria-disabled="true"') + '>' +
        '<b>' + esc(L.name) + '</b><span>' + esc(L.blurb) + '</span>' + (o.ok ? '' : '<i>' + esc(o.why) + '</i>') + '</button>';
    });
    h += '</div></div>';
    var lu = LURE[s.lure];
    h += '<div class="fs-sec"><div class="fs-h">Lure <i>' + (lu.bob || lu.scent ? s.bait + ' bait left' : 'L to switch on the water') + '</i></div><div class="fs-chips">';
    LURES.forEach(function (l) { if (s.lures[l.id]) h += '<button type="button" class="fs-chip' + (s.lure === l.id ? ' on' : '') + '" data-lure="' + l.id + '">' + esc(l.name) + '</button>'; });
    h += '</div><p class="fs-note">' + esc(lu.note) + '</p></div>';
    h += creelHtml();
    h += '<div class="fs-foot"><span>' + esc(RODS[s.rod].name) + ' · ' + esc(REELS[s.reel].name) + ' · ' + esc(LINES[s.line].name) + '</span>';
    if (S.endArm) h += '<span class="fs-confirm">End day ' + s.day + '? Kept fish sell at market. <button type="button" class="fs-lnk danger" data-act="endday-yes">End day</button> <button type="button" class="fs-lnk" data-act="endday-no">Cancel</button></span>';
    else h += '<button type="button" class="fs-lnk" data-act="endday">End the day (sleep)</button>';
    return h + '</div>';
  }
  function creelHtml() {
    var s = S.save, now = absMin(s.day, s.min), total = 0, rows = '';
    s.creel.forEach(function (c) {
      var sp = SP[c.sp], fr = freshness(c.at, now, s.up.cooler), v = priceOf(sp, c.w, fr, s.rep);
      total += v;
      rows += '<div class="fs-row"><span>' + esc(sp.name) + '</span><i>' + fmtW(c.w) + '</i><i class="' + (fr < 0.75 ? 'k-red' : '') + '">' + Math.round(fr * 100) + '% fresh</i><b>' + money(v) + '</b></div>';
    });
    var h = '<div class="fs-sec"><div class="fs-h">Creel <i>' + s.creel.length + '/' + creelCap(s) + (s.up.cooler ? ' · cooler' : ' · fish lose freshness by the hour') + '</i></div>';
    if (!rows) return h + '<p class="fs-note">Empty. Keep fish to sell them here at the market.</p></div>';
    return h + '<div class="fs-list">' + rows + '</div><button type="button" class="fs-go" data-act="sell">Sell all · ' + money(total) + '</button></div>';
  }
  function clubTab() {
    var s = S.save, h = '';
    ensureContracts();
    h += '<div class="fs-sec"><div class="fs-h">Angler-club contracts <i>new ones every morning</i></div><div class="fs-list">';
    if (!s.contracts.length) h += '<p class="fs-note">No contracts today.</p>';
    s.contracts.forEach(function (c) {
      var goal = c.kind === 'size' ? 1 : c.kind === 'bag' ? c.w : c.n, late = !c.done && s.min > c.by;
      var prog = c.kind === 'size' ? '' : ' <i>' + (c.kind === 'bag' ? c.prog.toFixed(1) + '/' + goal + ' lb' : c.prog + '/' + goal) + '</i>';
      h += '<div class="fs-row fs-ct' + (c.done ? ' done' : late ? ' late' : '') + '"><span>' + (c.done ? '[x] ' : late ? '[-] ' : '[ ] ') + esc(c.text) + prog + '</span><b>' + money(c.pay) + '</b><i>+' + c.xp + ' xp</i></div>';
    });
    h += '</div></div>';
    // tournament
    var why = canTour(), tl = curLvl() >= 3 ? LOC[tourLoc()] : null, fee = tourFee();
    h += '<div class="fs-sec"><div class="fs-h">Tournament <i>vs 5 club anglers</i></div>';
    if (tl) h += '<p class="fs-note">Today at <b>' + esc(tl.name) + '</b> · 2.5 hours · heaviest <b>5-fish bag</b> wins · entry ' + money(fee) + ' · prizes ' + money(fee * 5) + ' / ' + money(Math.round(fee * 2.4)) + ' / ' + money(Math.round(fee * 1.2)) + '</p>';
    if (why) h += '<p class="fs-note k-faint">' + esc(why) + '</p>';
    else h += '<button type="button" class="fs-go" data-act="tour">Enter · ' + money(fee) + '</button>';
    h += '</div>';
    // daily
    var ds = dailySpec(todayStr()), best = s.daily[ds.date];
    h += '<div class="fs-sec"><div class="fs-h">Daily derby <i>' + ds.date + ' · same water for everyone</i></div>' +
      '<p class="fs-note"><b>' + esc(LOC[ds.loc].name) + '</b> · ' + BAND_NAME[ds.cond.band] + ' · ' + (ds.season === 3 && ds.cond.wx === 2 ? 'Snow' : WX_NAME[ds.cond.wx]) + ' · ' + SEASONS[ds.season] + ' · club gear · 90 min · best ' + ds.lim + ' fish. ' + (best ? 'Your best today: <b>' + best.toFixed(2) + ' lb</b>' : 'Not fished yet today.') + '</p>' +
      '<button type="button" class="fs-go alt" data-act="daily">Fish the derby</button></div>';
    return h;
  }
  function gearRow(kind, i, item, stat) {
    var s = S.save, owned = s.owned[kind].indexOf(i) >= 0, eq = s[kind] === i, lock = curLvl() < item.lvl;
    var btn = eq ? '<span class="fs-eq">equipped</span>' : owned ? '<button type="button" class="fs-buy" data-equip="' + kind + ':' + i + '">Equip</button>' :
      lock ? '<span class="fs-eq">Lv ' + item.lvl + '</span>' : '<button type="button" class="fs-buy' + (s.money < item.price ? ' poor' : '') + '" data-buy="' + kind + ':' + i + '">' + money(item.price) + '</button>';
    return '<div class="fs-row fs-gear' + (eq ? ' eq' : '') + '"><span><b>' + esc(item.name) + '</b><i>' + stat + '</i></span>' + btn + '</div>';
  }
  function shopTab() {
    var s = S.save, h = '<div class="fs-shop-money">' + money(s.money) + ' to spend · level ' + curLvl() + '</div>';
    h += '<div class="fs-sec"><div class="fs-h">Rods <i>power lifts fish, sensitivity widens the strike window</i></div><div class="fs-list">';
    RODS.forEach(function (r, i) { h += gearRow('rod', i, r, 'power ' + Math.round(r.pow * 10) + ' · sens ' + Math.round(r.sens * 10) + ' · cast ' + r.cast + ' m'); });
    h += '</div></div><div class="fs-sec"><div class="fs-h">Reels <i>drag holds fish, the spool holds line</i></div><div class="fs-list">';
    REELS.forEach(function (r, i) { h += gearRow('reel', i, r, r.speed.toFixed(2) + ' m/s · drag ' + r.drag + ' lb · smooth ' + Math.round(r.smooth * 10) + ' · ' + r.spool + ' m'); });
    h += '</div></div><div class="fs-sec"><div class="fs-h">Line <i>tension is pull / line strength</i></div><div class="fs-list">';
    LINES.forEach(function (l, i) { h += gearRow('line', i, l, l.lb + ' lb test'); });
    h += '</div></div><div class="fs-sec"><div class="fs-h">Lures and bait</div><div class="fs-list">';
    LURES.forEach(function (l) {
      var own = !!s.lures[l.id], lock = curLvl() < (l.lvl || 1);
      var btn = own ? '<span class="fs-eq">owned</span>' : lock ? '<span class="fs-eq">Lv ' + l.lvl + '</span>' : '<button type="button" class="fs-buy' + (s.money < l.price ? ' poor' : '') + '" data-lurebuy="' + l.id + '">' + money(l.price) + '</button>';
      h += '<div class="fs-row fs-gear"><span><b>' + esc(l.name) + '</b><i>' + esc(l.note) + '</i></span>' + btn + '</div>';
    });
    h += '<div class="fs-row fs-gear"><span><b>Bait pack</b><i>' + BAIT_PACK.n + ' worms / cut bait · you have ' + s.bait + '</i></span><button type="button" class="fs-buy' + (s.money < BAIT_PACK.price ? ' poor' : '') + '" data-act="bait">' + money(BAIT_PACK.price) + '</button></div>';
    h += '</div></div><div class="fs-sec"><div class="fs-h">Boat &amp; kit</div><div class="fs-list">';
    UPGRADES.forEach(function (u) {
      var lv = s.up[u.id] | 0, max = lv >= u.max, lock = curLvl() < u.lvl, price = max ? 0 : u.price[lv];
      var btn = max ? '<span class="fs-eq">owned</span>' : lock ? '<span class="fs-eq">Lv ' + u.lvl + '</span>' : '<button type="button" class="fs-buy' + (s.money < price ? ' poor' : '') + '" data-up="' + u.id + '">' + money(price) + '</button>';
      h += '<div class="fs-row fs-gear"><span><b>' + esc(u.name) + (u.max > 1 ? ' ' + lv + '/' + u.max : '') + '</b><i>' + esc(u.note) + '</i></span>' + btn + '</div>';
    });
    return h + '</div></div>';
  }
  function timesTxt(sp) { var o = []; [[1, 'dawn'], [2, 'day'], [4, 'dusk'], [8, 'night']].forEach(function (b) { if (sp.times & b[0]) o.push(b[1]); }); return o.join('/'); }
  function journalHtml() {
    var s = S.save, got = 0, list = SPECIES.filter(function (sp) { return S.jLoc === 'all' || sp.locs.indexOf(S.jLoc) >= 0; });
    SPECIES.forEach(function (sp) { if (s.journal[sp.id]) got++; });
    var h = '<div class="fs-sec"><div class="fs-h">Fish journal <i>' + got + ' of ' + SPECIES.length + ' species</i></div><div class="fs-chips">';
    [['all', 'All']].concat(LOCS.map(function (L) { return [L.id, L.short]; })).forEach(function (o) { h += '<button type="button" class="fs-chip' + (S.jLoc === o[0] ? ' on' : '') + '" data-jloc="' + o[0] + '">' + o[1] + '</button>'; });
    h += '</div>' + jDetail() + '<div class="fs-jgrid">';
    list.forEach(function (sp) {
      var j = s.journal[sp.id];
      h += '<button type="button" class="fs-je' + (j ? ' got' : '') + (sp.rar === 4 ? ' leg' : '') + (S.jSel === sp.id ? ' on' : '') + '" data-sp="' + sp.id + '"><canvas data-th="' + sp.id + '"' + (j ? ' data-got' : '') + '></canvas>' +
        '<b>' + (j ? esc(sp.name) : '???') + '</b><i>' + (j ? fmtW(j.best) : RAR_NAME[sp.rar]) + '</i></button>';
    });
    return h + '</div></div>';
  }
  function jDetail() {
    var s = S.save, h = '', sel = S.jSel && SP[S.jSel];
    if (sel) {
      var j2 = s.journal[sel.id], where = sel.locs.map(function (l) { return LOC[l].name; }).join(', ');
      h += '<div class="fs-jd"><canvas data-th="' + sel.id + '" data-big' + (j2 ? ' data-got' : '') + '></canvas><div>' +
        '<b>' + (j2 ? esc(sel.name) : 'Unknown ' + RAR_NAME[sel.rar].toLowerCase() + ' fish') + '</b> <span class="fs-rar r' + sel.rar + '">' + RAR_NAME[sel.rar] + '</span>' +
        (j2 ? '<p>Caught ' + j2.n + ' · released ' + (j2.rel | 0) + ' · record <b>' + fmtW(j2.best) + '</b> (' + fmtLen(j2.len) + ') · ' + money(priceOf(sel, j2.best, 1, 0)) + '</p>' : '') +
        '<p>' + (sel.hint ? esc(sel.hint) : esc(where) + ' · ' + timesTxt(sel) + ' · ' + Math.round(sel.wmin * 10) / 10 + '–' + sel.wmax + ' lb' + (j2 ? ' · likes ' + Object.keys(sel.lures).sort(function (a, b) { return sel.lures[b] - sel.lures[a]; }).slice(0, 2).map(function (k) { return LURE[k].name; }).join(', ') : '')) + '</p>' +
        (sel.lore && j2 ? '<p class="fs-lore">' + esc(sel.lore) + '</p>' : '') + '</div></div>';
    }
    return h;
  }
  function anglerTab() {
    var s = S.save, lvl = curLvl(), a = cumXp(lvl), b = cumXp(lvl + 1), st = s.stats, pct = Math.round(100 * (s.xp - a) / Math.max(1, b - a));
    var h = '<div class="fs-sec"><div class="fs-h">Angler <i>level ' + lvl + '</i></div><div class="fs-xp"><span style="width:' + pct + '%"></span></div>' +
      '<p class="fs-note">' + (s.xp - a) + ' / ' + (b - a) + ' xp to level ' + (lvl + 1) + ' · ' + money(s.money) + ' · reputation ' + s.rep + ' (sale bonus +' + Math.round(Math.min(25, s.rep / 4)) + '%)</p></div>';
    var nx = LOCS.filter(function (L) { return L.lvl > lvl; })[0];
    if (nx) h += '<p class="fs-note">Next water: <b>' + esc(nx.name) + '</b> at level ' + nx.lvl + (nx.boat ? ' (and a boat)' : '') + '.</p>';
    h += '<div class="fs-stats">' + [['Fish landed', st.caught], ['Released', st.released], ['Sold', st.sold], ['Earned', money(st.earned)], ['Lines snapped', st.snaps], ['Thrown hooks', st.lost],
      ['Contracts', st.cDone], ['Tournaments', st.tWins + ' won / ' + st.tPlayed], ['Days', st.days], ['Biggest', st.best ? fmtW(st.best.w) + ' ' + SP[st.best.sp].name : '—']].map(function (r) { return '<div><i>' + r[0] + '</i><b>' + esc(String(r[1])) + '</b></div>'; }).join('') + '</div>';
    h += '<div class="fs-sec"><div class="fs-h">Difficulty</div><div class="fs-chips">' + ['relax', 'normal', 'hard'].map(function (d) {
      return '<button type="button" class="fs-chip' + (s.diff === d ? ' on' : '') + '" data-diff="' + d + '">' + DIFFS[d].name + '<i>' + (d === 'relax' ? 'no snaps, gentle fights' : d === 'hard' ? 'tight windows, strong fish' : 'the real thing') + '</i></button>';
    }).join('') + '</div></div>';
    h += '<div class="fs-sec"><div class="fs-h">Sound</div><div class="fs-chips"><button type="button" class="fs-chip' + (s.amb ? ' on' : '') + '" data-act="amb">Ambient water, rain &amp; birds: ' + (s.amb ? 'on' : 'off') + '</button></div></div>';
    h += '<div class="fs-foot"><button type="button" class="fs-lnk" data-act="help">How to play</button>' +
      (S.resetArm ? '<span class="fs-confirm">Erase the whole career? <button type="button" class="fs-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="fs-lnk" data-act="reset-no">Keep</button></span>' : '<button type="button" class="fs-lnk" data-act="reset">Reset career</button>') + '</div>';
    return h;
  }
  function pauseHtml() {
    var h = '<div class="fs-card"><div class="fs-title">PAUSED</div>';
    if (S.mode === 'tour' && S.tour) h += '<p class="fs-sub">Tournament — ' + clockStr(Math.max(0, S.tour.end - S.W.min)).slice(1) + ' left. The clock stops while paused.</p>';
    else if (S.mode === 'daily') h += '<p class="fs-sub">Daily derby — the clock stops while paused.</p>';
    else h += '<p class="fs-sub">' + esc(S.W.L.name) + ' · ' + clockStr(S.W.min) + '</p>';
    h += '<button type="button" class="fs-go" data-act="resume">Resume</button>' +
      '<div class="fs-btns"><button type="button" class="fs-go alt" data-act="journal">Journal</button><button type="button" class="fs-go alt" data-act="help">Help</button></div>';
    if (S.mode === 'career') h += '<button type="button" class="fs-go alt" data-act="leave">Back to the dock</button>';
    else h += S.quitArm ? '<button type="button" class="fs-go alt danger" data-act="quit">Really quit? (no refund)</button>' : '<button type="button" class="fs-go alt" data-act="quit">Quit the ' + (S.mode === 'tour' ? 'tournament' : 'derby') + '</button>';
    return h + '</div>';
  }
  function catchHtml() {
    var ci = S.catchInfo;
    if (!ci) return '';
    var sp = ci.sp, h = '<div class="fs-card fs-catch">';
    h += (ci.first ? '<div class="fs-new">NEW SPECIES!</div>' : ci.record ? '<div class="fs-new">NEW RECORD!</div>' : '');
    h += '<canvas class="fs-catchcv" data-th="' + sp.id + '" data-got data-big></canvas>';
    h += '<div class="fs-cname">' + esc(sp.name) + ' <span class="fs-rar r' + sp.rar + '">' + RAR_NAME[sp.rar] + '</span></div>';
    h += '<div class="fs-big">' + fmtW(ci.w) + ' <small>' + fmtLen(ci.len) + '</small></div>';
    if (sp.lore && ci.first) h += '<p class="fs-lore">' + esc(sp.lore) + '</p>';
    var bits = [];
    if (!ci.daily) bits.push('+' + ci.xp + ' xp');
    if (ci.lv) bits.push('<b>LEVEL ' + ci.lv + '!</b>');
    if (ci.tour) bits.push('weighed for the tournament');
    if (ci.daily) bits.push('bag ' + bagW(S.daily.bag).toFixed(2) + ' lb');
    h += '<p class="fs-note">' + bits.join(' · ') + '</p>';
    ci.done.forEach(function (c) { h += '<p class="fs-done">Contract done: ' + esc(c.text) + ' · +' + money(c.pay) + '</p>'; });
    if (!ci.daily && S.save.creel.length >= creelCap(S.save)) h += '<p class="fs-note k-red">Creel full — release it, or sell at the dock.</p>';
    return h + '</div>';
  }
  function dayendHtml() {
    var r = S.dayRes || {};
    return '<div class="fs-card"><pre class="fs-art" aria-hidden="true">   .  *    (  )   .\n *     .  ~~~~~~~~  *</pre><div class="fs-title">DAY ' + r.day + ' DONE</div>' +
      (r.auto ? '<p class="fs-sub">Midnight — you head home.</p>' : '') +
      '<div class="fs-stats"><div><i>Fish landed</i><b>' + (r.n | 0) + '</b></div><div><i>Released</i><b>' + (r.rel | 0) + '</b></div><div><i>Sold at market</i><b>' + money(r.sold | 0) + '</b></div><div><i>Contracts</i><b>' + (r.done | 0) + '</b></div></div>' +
      '<p class="fs-note">Day ' + S.save.day + ' · ' + SEASONS[seasonOf(S.save.day)] + ' · new contracts at the club.' + (seasonOf(S.save.day) === 3 && seasonOf(S.save.day - 1) !== 3 ? ' <b>Winter is here — the ice hole is open.</b>' : '') + '</p></div>';
  }
  function tresHtml() {
    var R = S.tres, h = '<div class="fs-card"><div class="fs-title">' + (R.rank === 0 ? 'YOU WON!' : 'WEIGH-IN') + '</div><div class="fs-list fs-board">';
    R.rows.forEach(function (r, i) { h += '<div class="fs-row' + (r.you ? ' you' : '') + '"><span>' + (i + 1) + '. ' + esc(r.name) + '</span><i>' + r.n + ' fish</i><b>' + r.w.toFixed(2) + ' lb</b></div>'; });
    h += '</div><p class="fs-note">' + (R.prize ? 'Prize: <b>' + money(R.prize) + '</b>' : 'No prize this time.') + '</p></div>';
    return h;
  }
  function dresHtml() {
    var R = S.dres;
    return '<div class="fs-card"><div class="fs-title">DERBY OVER</div><div class="fs-big">' + R.score.toFixed(2) + ' <small>lb · ' + R.n + ' fish</small></div>' +
      '<p class="fs-note">' + (R.score > R.prev && R.score > 0 ? '<b>New best for ' + R.date + '!</b>' : 'Best today: ' + R.best.toFixed(2) + ' lb.') + ' Same water, same weather for everyone today.</p></div>';
  }

  // ================= actions =================
  function padAction(act) {
    if (!S) return;
    S.snd.ensure();
    var s = S.save;
    if (act === 'go') { if (S.phase === 'over') { S.phase = 'dock'; toDock(); return; } if (S.phase === 'dock') goFishing(s.atWater); }
    else if (act === 'start') { S.firstRun = false; showCard('dock'); setPad('dock'); }
    else if (act === 'resume') resume();
    else if (act === 'next') { if (S.phase === 'over') { S.phase = 'water'; showCard(null); setPad(S.W && S.W.phase === 'fishing' ? 'fishing' : 'cast'); syncHead(); kick(); } }
    else if (act === 'hook') { if (atWater() && S.W.phase === 'fishing') S.hookQ = true; }
    else if (act === 'twitch') doTwitch();
    else if (act === 'reelin') doReelIn();
    else if (act === 'lure') cycleLure(1);
    else if (act === 'fd-') adjFloat(-0.25);
    else if (act === 'fd+') adjFloat(0.25);
    else if (act === 'drag') adjDrag(S.W.dragSet >= 0.9 ? -0.5 : 0.1);
    else if (act === 'keep') keepFish();
    else if (act === 'release') releaseFish();
    else if (act === 'dock') toDock();
  }
  function onOvlClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    S.snd.ensure();
    var s = S.save, a = b.getAttribute('data-act'), d;
    if ((d = b.getAttribute('data-tab'))) { S.tab = d; S.endArm = false; S.resetArm = false; showCard('dock'); focusSel('[data-tab="' + d + '"]', e); }
    else if ((d = b.getAttribute('data-loc'))) { if (!locOpen(s, d).ok) { toast(LOC[d].name + ': ' + locOpen(s, d).why); return; } if (s.atWater && s.loc !== d) s.atWater = false; s.loc = d; if (!validLure(s.lure, { L: LOC[d] })) s.lure = 's'; previewWorld(); rerenderCard(); setPad('dock'); persist(); }
    else if ((d = b.getAttribute('data-lure'))) { s.lure = d; rerenderCard(); persist(); }
    else if ((d = b.getAttribute('data-jloc'))) { S.jLoc = d; rerenderCard(); }
    else if ((d = b.getAttribute('data-sp'))) { S.jSel = S.jSel === d ? null : d; rerenderCard(); var jd = S.ovl.querySelector('.fs-jd'); if (jd) S.ovl.scrollTop = Math.max(0, jd.offsetTop - 40); }
    else if ((d = b.getAttribute('data-diff'))) { s.diff = d; rerenderCard(); persist(); }
    else if ((d = b.getAttribute('data-buy'))) buyGear(d.split(':')[0], +d.split(':')[1]);
    else if ((d = b.getAttribute('data-equip'))) { var p = d.split(':'); s[p[0]] = +p[1]; rerenderCard(); persist(); S.snd.tone(660, 0.05, 'sine', 0.03); }
    else if ((d = b.getAttribute('data-lurebuy'))) { var l = LURE[d]; if (s.money < l.price) { toast('Not enough money'); return; } s.money -= l.price; s.lures[d] = 1; s.lure = d; cash(); }
    else if ((d = b.getAttribute('data-up'))) { var u = UPGRADES.filter(function (x) { return x.id === d; })[0], lv = s.up[d] | 0, pr = u.price[lv]; if (s.money < pr) { toast('Not enough money'); return; } s.money -= pr; s.up[d] = lv + 1; cash(); if (d === 'boat') toast('The Blue Shelf is open — big game awaits.'); }
    else if (a === 'bait') { if (s.money < BAIT_PACK.price) { toast('Not enough money'); return; } s.money -= BAIT_PACK.price; s.bait += BAIT_PACK.n; cash(); }
    else if (a === 'sell') { var v = sellCreel(s); s.today.earn += v; S.snd.tone(988, 0.08, 'triangle', 0.04); S.snd.tone(1319, 0.1, 'triangle', 0.04, 0, 0.08); toast('Sold for ' + money(v)); rerenderCard(); syncHud(); persist(); }
    else if (a === 'endday') { S.endArm = true; rerenderCard(); }
    else if (a === 'endday-no') { S.endArm = false; rerenderCard(); }
    else if (a === 'endday-yes') { S.endArm = false; endDay(false); }
    else if (a === 'tour') startTour();
    else if (a === 'daily') startDaily();
    else if (a === 'go') goFishing(true);
    else if (a === 'amb') { s.amb = s.amb ? 0 : 1; if (!s.amb) S.snd.hush(); rerenderCard(); persist(); }
    else if (a === 'reset') { S.resetArm = true; rerenderCard(); }
    else if (a === 'reset-no') { S.resetArm = false; rerenderCard(); }
    else if (a === 'reset-yes') { S.resetArm = false; S.save = newSave(); S.save.seen = 1; persist(); toDock('fish'); toast('A fresh start at Willow Pond.'); }
    else if (a === 'help') { S.helpFrom = S.cardKind; showCard('help'); }
    else if (a === 'tut') { S.tutFrom = 'help'; showCard('tut'); }
    else if (a === 'tut-back') { S.tutFrom = null; showCard('help'); }
    else if (a === 'close-help') { S.firstRun = false; if (S.phase === 'water' && S.paused) showCard('pause'); else { showCard('dock'); setPad('dock'); } persist(); }
    else if (a === 'resume') resume();
    else if (a === 'journal') showCard('journal');
    else if (a === 'back-pause') showCard('pause');
    else if (a === 'leave') { s.min = Math.min(DAY_END - 1, S.W.min); toDock('fish'); }
    else if (a === 'quit') { if (!S.quitArm) { S.quitArm = true; showCard('pause'); return; } S.quitArm = false; if (S.mode === 'tour') { S.tour.end = S.W.min; S.paused = false; endTour(); } else { S.paused = false; endDaily(); } }
    S.snd.tone(988, 0.035, 'sine', 0.02);
  }
  function focusSel(sel, e) { if (e.detail !== 0) return; var el = S.ovl.querySelector(sel); if (el) { try { el.focus({ preventScroll: true }); } catch (er) {} } }
  function cash() { S.snd.tone(1175, 0.06, 'triangle', 0.035); S.snd.tone(1568, 0.08, 'triangle', 0.03, 0, 0.06); rerenderCard(); syncHud(); persist(); }
  function buyGear(kind, i) {
    var s = S.save, T = kind === 'rod' ? RODS : kind === 'reel' ? REELS : LINES, it = T[i];
    if (!it || s.owned[kind].indexOf(i) >= 0) return;
    if (curLvl() < it.lvl) { toast('Reach level ' + it.lvl); return; }
    if (s.money < it.price) { toast('Not enough money'); return; }
    s.money -= it.price; s.owned[kind].push(i); s[kind] = i;
    cash();
  }

  // ================= loop =================
  function running() { return !!S && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)) && !(S.paused && S.phase === 'water'); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) { if (S.paused) draw(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts; S.dt = dt; S.t += dt;
    var W = S.W;
    if (S.charge && S.charge.on && !S.charge.drag) { S.charge.t += dt; var ph = (S.charge.t % 2.2) / 1.1; S.charge.pow = ph <= 1 ? ph : 2 - ph; }
    if (S.phase === 'water' && W) {
      var inp = buildInput(), m0 = W.min;
      if (S.twitchQ) { inp.twitch = S.twitchQ; S.twitchQ = 0; }
      if (S.hookQ) { inp.hook = true; S.hookQ = false; }
      S.acc = Math.min(S.acc + dt, 0.25);
      while (S.acc >= STEP && S.phase === 'water') {
        stepWorld(W, STEP, inp);
        inp.twitch = 0; inp.hook = false;
        S.acc -= STEP;
        if (W.ev.length) handleEvents();
      }
      if (S.mode !== 'daily' && S.phase === 'water') S.save.min = Math.min(DAY_END - 1, W.min);
      if (S.mode === 'tour' && S.tour && S.phase === 'water') {
        stepTourney(S.tour, W.min - m0, W.cond);
        if (W.min >= S.tour.end && W.phase !== 'fight') endTour();
      } else if (S.mode === 'daily' && S.daily && S.phase === 'water') {
        if (W.min >= S.daily.end && W.phase !== 'fight') endDaily();
      } else if (S.mode === 'career' && W.min >= DAY_END && W.phase !== 'fight' && S.phase === 'water') endDay(true);
      S.saveT = (S.saveT || 0) + dt;
      if (S.saveT > 15) { S.saveT = 0; persist(); }
      syncLive();
      S.hudT = (S.hudT || 0) + dt;
      if (S.hudT > 0.5) { S.hudT = 0; syncHud(); }
    } else if (W && S.phase !== 'water') {
      // the scene stays alive behind the cards: fish swim, the clock stands still
      var keep = W.phase;
      if (keep === 'ready' || keep === 'landed') { var ts = W.timeScale; W.timeScale = 0; stepWorld(W, Math.min(dt, 0.05), {}); W.timeScale = ts; W.ev.length = 0; }
    }
    // weather life
    if (W) {
      if (W.cond.wx === 3) { S.boltT = (S.boltT == null ? 4 : S.boltT) - dt; if (S.boltT <= 0) { S.boltT = 5 + Math.random() * 10; S.flash = 1; S.snd.noise(1.6, 120, 'lowpass', 0.09, 0.4 + Math.random() * 0.8); } }
      if (S.phase === 'water' && S.save.amb && S.snd.on) {
        var rain = W.cond.wx === 3 ? 0.05 : W.cond.wx === 2 && W.cond.season !== 3 ? 0.03 : 0;
        S.snd.ambient(0.022 + waveH(W) * 0.04, rain, dt);
        S.birdT = (S.birdT == null ? 3 : S.birdT) - dt;
        if (S.birdT <= 0) { S.birdT = 4 + Math.random() * 9; if (dayLight(W.min) > 0.6 && W.cond.wx < 2 && W.L.id !== 'deep') S.snd.chirp(W.L.salt); }
        if (W.phase === 'fishing' && S.inpReel) { S.clickT = (S.clickT || 0) - dt; if (S.clickT <= 0) { S.clickT = 0.07; S.snd.tone(2600, 0.012, 'square', 0.006); } }
        if (W.fight && W.fight.slip > 0) { S.zzT = (S.zzT || 0) - dt; if (S.zzT <= 0) { S.zzT = 0.05; S.snd.tone(1100 + Math.random() * 300, 0.04, 'sawtooth', 0.012); } }
        else if (W.fight && S.inpReel) { S.clickT = (S.clickT || 0) - dt; if (S.clickT <= 0) { S.clickT = 0.09; S.snd.tone(1900, 0.012, 'square', 0.007); } }
      } else S.snd.hush();
    }
    stepFx(dt);
    draw();
    S.raf = requestAnimationFrame(frame);
  }

  // ================= layout =================
  function chromeH() {
    var r = S.panel.getBoundingClientRect(), bd = S.panel.querySelector('.cade-panel-body');
    if (!r.height || !bd) return 0;
    return (r.height - bd.clientHeight) + bd.scrollHeight - (S.stage.offsetHeight || 0);
  }
  function availH(vw, vh, chrome) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !chrome) return vh - (vw <= 560 ? 210 : 230);
    var room = vh - Math.min(Math.max(0, r.top), 140), mx = getComputedStyle(S.panel).maxHeight, mh = /px$/.test(mx) ? parseFloat(mx) : 0;
    if (mh > 0) room = Math.min(room, mh);
    return room - chrome - 6;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.width && vv.scale <= 1.01) vw = Math.min(vw, vv.width);
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var gut = phone ? (solo ? 20 : 34) : 48;
    var Wd = Math.floor(Math.min(vw - gut, solo ? 1000 : 720)), ch = chromeH(), ah = Math.floor(Math.max(220, availH(vw, vh, ch)));
    var H = Math.min(ah, Math.round(Wd * (phone ? 1.3 : 0.72)));
    H = Math.max(H, Math.min(ah, 260));
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    S.SW = Wd; S.SH = H;
    S.cv.style.width = Wd + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.width = Wd + 'px'; S.stage.style.height = H + 'px';
    S.panel.style.setProperty('--fs-w', Wd + 'px');
    S.cv.width = Math.round(Wd * dpr); S.cv.height = Math.round(H * dpr);
    S.k = S.cv.width / Wd;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.lay = { vw: vw, vh: vh, chrome: ch };
    S.cam.ok = false;
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) { layout(); draw(); }
  }

  // ================= open / close =================
  function teardown() {
    if (!S) return;
    var s = S;
    try { if ((s.phase === 'water' || s.phase === 'catch') && s.mode !== 'daily' && s.W && !s.W.preview) { s.save.min = Math.min(DAY_END - 1, s.W.min); s.save.bait = s.W.bait; } sset(SAVE_KEY, JSON.stringify(s.save)); } catch (e) {}
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('keyup', s.onKeyUp, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    window.removeEventListener('orientationchange', s.onResize);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    s.cv.width = 0; s.cv.height = 0;
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
    var body = '<div class="fs"><div class="fs-hud"></div><div class="fs-stage"><canvas class="fs-cv"></canvas><div class="fs-ovl" style="display:none"></div></div>' +
      '<div class="fs-pad"></div><div class="fs-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🎣 Reel Deep', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'fs-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="journal" title="Journal (J)" aria-label="Fish journal">' + IC_BOOK + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia, r = Math.random;
    S = {
      panel: p, head: hb, hud: p.querySelector('.fs-hud'), stage: p.querySelector('.fs-stage'), cv: p.querySelector('.fs-cv'), ovl: p.querySelector('.fs-ovl'),
      pad: p.querySelector('.fs-pad'), liveEl: p.querySelector('.fs-live'),
      save: ld.save, firstRun: ld.fresh || !ld.save.seen, snd: new Snd(sget(SOUND_KEY) !== '0'),
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'dock', mode: 'career', paused: false, raf: 0, last: 0, t: 0, dt: 0.016, acc: 0, W: null, tour: null, daily: null,
      keys: {}, held: { l: 0, r: 0 }, reelSrc: {}, cvSteer: 0, steer: 0, twitchQ: 0, hookQ: false, inpReel: false, charge: null, drag: null,
      cam: { x: 0, y: 0, ok: false }, fx: { parts: [], rip: [] }, msg: null, cue: 0, bobDip: 0, flash: 0, rodKick: 0,
      tab: 'fish', jLoc: 'all', jSel: null, cardKind: null, padMode: '', hudHtml: '',
      stars: [], clouds: [], motes: [], drops: [], hills: [r() * 6, r() * 6, r() * 6]
    };
    for (var i = 0; i < 60; i++) S.stars.push([r(), r(), r() < 0.2 ? 2 : 1]);
    for (i = 0; i < 10; i++) S.clouds.push({ x: r(), y: 0.1 + r() * 0.8, s: 0.6 + r() * 0.9 });
    for (i = 0; i < 40; i++) S.motes.push([r(), r(), 0.3 + r()]);
    for (i = 0; i < 120; i++) S.drops.push([r(), r(), r()]);
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    readTheme();
    layout();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); S.snd.hush(); } else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearHeld(); } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); clearHeld(); stopLoop(); S.snd.hush(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (!S || S.panel !== p) return; if (S.themeDirty) { S.themeDirty = false; readTheme(); } layout(); kick(); draw(); });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); draw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.hud); S.ro.observe(S.pad);
    } catch (e) {}
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); if (S.cardKind) rerenderCard(); draw();
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
        if (!S.snd.on) S.snd.hush();
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'journal') {
        if (S.phase === 'water' && !S.paused) { pause(); showCard('journal'); }
        else if (S.paused) showCard(S.cardKind === 'journal' ? 'pause' : 'journal');
        else if (S.phase === 'dock') { S.tab = 'journal'; showCard('dock'); }
      } else if (h === 'help') {
        if (S.phase === 'water' && !S.paused) pause();
        if (S.cardKind === 'help') { if (S.paused) showCard('pause'); else if (S.phase === 'dock') showCard('dock'); }
        else if (S.phase === 'dock' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    S.pad.addEventListener('touchstart', function (e) { if (e.target.closest && e.target.closest('[data-hold]')) noTouch(e); }, { passive: false });
    S.pad.addEventListener('touchend', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      noTouch(e);
      if (!b.hasAttribute('data-hold') && !b.disabled) b.click();
    }, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // the water: drag back and flick to cast; hold to reel, tap to twitch or hook; drag sideways to steer
    function stagePt(e) { var rc = S.cv.getBoundingClientRect(); return { x: e.clientX - rc.left, y: e.clientY - rc.top }; }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (!atWater() || S.drag) return;
      var q = stagePt(e), ph = S.W.phase;
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.drag = { id: e.pointerId, x0: q.x, y0: q.y, kind: ph === 'ready' ? 'cast' : 'reel' };
      if (ph === 'ready') startCharge(true);
      else reelDown('cv');
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      var q = stagePt(e), d = S.drag;
      if (d.kind === 'cast' && S.charge && S.charge.drag) {
        var len = Math.hypot(q.x - d.x0, q.y - d.y0), full = Math.max(110, Math.min(S.SW, S.SH) * 0.42);
        S.charge.pow = len / full;
      } else if (d.kind === 'reel') S.cvSteer = clamp((q.x - d.x0) / 50, -1, 1);
    });
    function endDrag(e, cancel) {
      if (!S || !S.drag || S.drag.id !== e.pointerId) return;
      var d = S.drag;
      S.drag = null;
      if (d.kind === 'cast') { if (cancel) S.charge = null; else releaseCharge(); }
      else { S.cvSteer = 0; reelUp('cv'); }
    }
    S.cv.addEventListener('pointerup', function (e) { endDrag(e, false); });
    S.cv.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // held pad buttons
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      var k = b.getAttribute('data-hold');
      b.classList.add('on');
      if (k === 'cast') startCharge(false);
      else if (k === 'reel') reelDown('pad');
      else S.held[k] = 1;
    });
    function padUp(e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S || !b.classList.contains('on')) return;
      b.classList.remove('on');
      var k = b.getAttribute('data-hold');
      if (k === 'cast') { if (e.type === 'pointercancel') S.charge = null; else releaseCharge(); }
      else if (k === 'reel') reelUp('pad');
      else S.held[k] = 0;
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, padUp); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    S.ovl.addEventListener('click', onOvlClick);

    ensureContracts();
    previewWorld();
    syncHead(); syncHud();
    if (S.firstRun) { S.save.seen = 1; persist(); showCard('help'); setPad('start'); }
    else { showCard('dock'); setPad('dock'); }
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); draw(); } });
    kick();
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Cast, lure and land fish across generated lakes, rivers and seas — tension-line fights, a fish journal, gear upgrades and an angler career',
    icon: '🎣',
    tags: 'game,sport,fishing,fish,relax,career,collection,fun',
    open: open,
    _engine: ENGINE
  });
})();
