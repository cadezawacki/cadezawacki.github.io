/* Tee Time Golf — arcade 3D golf for Cade.txt.
 * A perspective view from behind the ball over a procedurally generated
 * heightmap course (fairway, rough, deep rough, bunkers, water, trees, tee
 * boxes, OB, a sloped green with a flag), raster-drawn front to back per
 * screen column with baked lighting and distance fog, plus an overhead hole
 * map, a hole flyover and a camera that chases the ball.
 * Swing like a bar-top trackball: pull DOWN for the backswing, then push UP
 * fast — the speed of the up-stroke is the power (past 100% is an overswing:
 * longer, wilder), the sideways drift of the stroke is a hook or a slice.
 * Keyboard: a three-click meter on Space. After contact, swipe (or press the
 * arrows) to put a limited amount of "english" on the ball: curve it, top
 * it to run or back it up to bite.
 * Physics: fixed 120 Hz steps — drag, lift and curve from spin, wind that
 * grows with height, bounces and roll by surface and slope, lies that cost
 * distance, trees, water (penalty drop) and OB (stroke and distance).
 * Modes: Quick Round (9/18 holes, 1-4 players, any seat a CPU), Closest to
 * the Pin, Long Drive and a Pro Tour career against a named field with a live
 * leaderboard, prize money and a pro shop. Seeded 18-hole courses in five
 * themes (links, parkland, desert, alpine, island). Everything persists in
 * Cade.store (cade-teegolf-*). Offline, no assets; all courses are generated. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World: yards. x → right, y → down the hole (tee near y≈30), z ↑. Seconds.
  var DT = 1 / 120, G = 10.73, MPH = 0.48889;            // gravity yd/s², yd/s per mph
  var KD = 0.0040, KL = 0.0072, KS = 0.0011;              // drag, lift (per backspin), curve (per sidespin)
  var SPIN_DECAY = Math.exp(-DT / 12);
  var CUP_R = 0.105, ROLL_K = G * 5 / 7, PUTT_MAX = 30;
  var OB = 0, DEEP = 1, ROUGH = 2, FAIR = 3, GREEN = 4, FRINGE = 5, SAND = 6, WATER = 7, TEE = 8, WASTE = 9;
  // dist: launch-speed factor · spin: spin kept · e: bounce · grab: speed lost along the ground on a bounce ·
  // bite: how much backspin checks it · roll: rolling decel (yd/s²) · err: wildness of a shot from here
  var LIE = [
    { id: 'ob', name: 'Out of bounds', dist: 0.7, spin: 0.5, e: 0.25, grab: 0.5, bite: 0.1, roll: 6, err: 1.6 },
    { id: 'deep', name: 'Deep rough', dist: 0.7, spin: 0.35, e: 0.12, grab: 0.75, bite: 0.05, roll: 11, err: 1.7 },
    { id: 'rough', name: 'Rough', dist: 0.9, spin: 0.6, e: 0.2, grab: 0.6, bite: 0.2, roll: 6.5, err: 1.3 },
    { id: 'fair', name: 'Fairway', dist: 1, spin: 1, e: 0.3, grab: 0.45, bite: 0.5, roll: 3.2, err: 1 },
    { id: 'green', name: 'Green', dist: 1, spin: 1, e: 0.28, grab: 0.35, bite: 1, roll: 0.6, err: 1 },
    { id: 'fringe', name: 'Fringe', dist: 0.97, spin: 0.9, e: 0.28, grab: 0.42, bite: 0.7, roll: 2, err: 1 },
    { id: 'sand', name: 'Bunker', dist: 0.78, spin: 0.45, e: 0.04, grab: 0.88, bite: 0, roll: 16, err: 1.35 },
    { id: 'water', name: 'Water', dist: 0.5, spin: 0.2, e: 0, grab: 1, bite: 0, roll: 40, err: 2 },
    { id: 'tee', name: 'Tee box', dist: 1, spin: 1, e: 0.3, grab: 0.45, bite: 0.5, roll: 3.2, err: 1 },
    { id: 'waste', name: 'Waste area', dist: 0.86, spin: 0.55, e: 0.18, grab: 0.5, bite: 0.1, roll: 7, err: 1.25 }
  ];
  var CLUBS = [
    { id: '1W', name: 'Driver', carry: 228, launch: 11, spin: 0.4, wood: 1 },
    { id: '3W', name: '3 Wood', carry: 210, launch: 12.5, spin: 0.48, wood: 1 },
    { id: '5W', name: '5 Wood', carry: 196, launch: 14.5, spin: 0.56, wood: 1 },
    { id: '4i', name: '4 Iron', carry: 184, launch: 15.5, spin: 0.64 },
    { id: '5i', name: '5 Iron', carry: 174, launch: 17, spin: 0.7 },
    { id: '6i', name: '6 Iron', carry: 163, launch: 19, spin: 0.76 },
    { id: '7i', name: '7 Iron', carry: 152, launch: 21.5, spin: 0.82 },
    { id: '8i', name: '8 Iron', carry: 140, launch: 24.5, spin: 0.88 },
    { id: '9i', name: '9 Iron', carry: 128, launch: 28, spin: 0.94 },
    { id: 'PW', name: 'Pitching Wedge', carry: 114, launch: 31, spin: 1, wedge: 1 },
    { id: 'SW', name: 'Sand Wedge', carry: 86, launch: 37, spin: 1.1, wedge: 1, sand: 1 },
    { id: 'PT', name: 'Putter', carry: 0, launch: 0, spin: 0, putt: 1 }
  ];
  var PUTTER = CLUBS.length - 1;
  var DIFFS = [
    { name: 'Easy', wind: 0.45, tol: 1.7, stimp: 8.5, slope: 0.7, cpu: -0.12, gim: 1.0, tee: 2, fw: 1.2 },
    { name: 'Normal', wind: 0.8, tol: 1.0, stimp: 10, slope: 1, cpu: 0, gim: 0.5, tee: 1, fw: 1 },
    { name: 'Hard', wind: 1.1, tol: 0.72, stimp: 11.5, slope: 1.2, cpu: 0.08, gim: 0, tee: 0, fw: 0.9 },
    { name: 'Pro', wind: 1.35, tol: 0.52, stimp: 13, slope: 1.35, cpu: 0.15, gim: 0, tee: 0, fw: 0.82 }
  ];
  var THEMES = {
    links: { name: 'Links', amp: 2.6, dune: 2.4, valley: 0.04, fw: 19, rough: 9, deep: 40, trees: 14, tree: 'bush', dogP: 0.5, water: 0.25, ocean: 0.35, bunk: 1.7, pot: 1, elev: 4, island: 0 },
    parkland: { name: 'Parkland', amp: 2.4, dune: 0, valley: 0.07, fw: 16, rough: 8, deep: 26, trees: 150, tree: 'oak', alt: 'pine', dogP: 0.55, water: 0.45, ocean: 0, bunk: 1, elev: 6, island: 0.12 },
    desert: { name: 'Desert', amp: 3.2, dune: 0.8, valley: 0.12, fw: 15, rough: 4, deep: 30, trees: 70, tree: 'cactus', dogP: 0.45, water: 0.3, ocean: 0, bunk: 0.8, waste: 1, elev: 9, island: 0.1 },
    alpine: { name: 'Alpine', amp: 4.5, dune: 0, valley: 0.28, fw: 16, rough: 8, deep: 22, trees: 170, tree: 'pine', dogP: 0.6, water: 0.4, ocean: 0, bunk: 0.8, elev: 20, island: 0, creek: 1 },
    island: { name: 'Island', amp: 2, dune: 0.6, valley: 0.04, fw: 17, rough: 8, deep: 22, trees: 60, tree: 'palm', dogP: 0.5, water: 0.6, ocean: 0.75, bunk: 1.1, elev: 3, island: 0.55 }
  };
  var THEME_IDS = ['links', 'parkland', 'desert', 'alpine', 'island'];

  // ---- small math ----
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function gauss(r) { var u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function pick(r, a) { return a[Math.floor(r() * a.length) % a.length]; }
  function shuffle(r, a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  // value noise on a 256² lattice (wraps), smooth-step interpolated, about -1..1
  function makeNoise(seed) {
    var r = mulberry32(seed), N = 256, v = new Float32Array(N * N);
    for (var i = 0; i < v.length; i++) v[i] = r() * 2 - 1;
    return function (x, y) {
      var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      var u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      var x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
      var a = v[y0 * N + x0], b = v[y0 * N + x1], c = v[y1 * N + x0], d = v[y1 * N + x1];
      return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
    };
  }
  function fbm(n, x, y, oct) { var s = 0, a = 1, t = 0; for (var o = 0; o < oct; o++) { s += n(x, y) * a; t += a; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; a *= 0.5; } return s / t; }

  // ---- names (all invented) ----
  var PLACE = ['Saltcrest', 'Elmbrook', 'Red Mesa', 'Pinecrest', 'Coral Key', 'Heronmoor', 'Windy Hollow', 'Copper Ridge', 'Lakeshore', 'Foxglen', 'Sandpiper', 'Granite Peak', 'Bluewater', 'Thistledown', 'Juniper Flats', 'Cedar Bend', 'Driftwood', 'Larkspur', 'Silver Pines', 'Mirage Valley', 'Kestrel Point', 'Oakhaven', 'Stonegate', 'Palm Cove', 'Glacier Run', 'Marram Bay'];
  var CTYPE = { links: ['Links', 'Golf Links', 'Dunes'], parkland: ['Country Club', 'Park', 'Golf Club'], desert: ['Desert Club', 'Canyon Course', 'Sands'], alpine: ['Alpine Club', 'Mountain Course', 'Highlands'], island: ['Island Club', 'Ocean Course', 'Reef Links'] };
  var HN_ADJ = ['Long', 'Lonely', 'Crooked', 'Narrow', 'Hidden', 'Windy', 'Quiet', 'High', 'Low', 'Old', 'Twin', 'Broken', 'Golden', 'Silver', 'Shady', 'Rocky', 'Wild', 'Little', 'Last', 'Lucky'];
  var HN_NOUN = { links: ['Dunes', 'Gorse', 'Burn', 'Tide', 'Gull', 'Haar', 'Marram', 'Spit', 'Cairn', 'Lighthouse'], parkland: ['Oaks', 'Elms', 'Brook', 'Meadow', 'Orchard', 'Mill', 'Chapel', 'Willows', 'Pond', 'Gate'], desert: ['Mesa', 'Arroyo', 'Saguaro', 'Canyon', 'Dust Devil', 'Coyote', 'Butte', 'Mirage', 'Oasis', 'Sidewinder'], alpine: ['Pines', 'Glacier', 'Summit', 'Cascade', 'Ridge', 'Avalanche', 'Edelweiss', 'Larch', 'Chalet', 'Falls'], island: ['Reef', 'Lagoon', 'Palms', 'Cove', 'Coral', 'Pelican', 'Breakers', 'Shoal', 'Conch', 'Atoll'] };
  var HN_ALONE = ['The Gauntlet', 'Hell\'s Kitchen', 'Long Walk', 'Postage Stamp', 'Devil\'s Elbow', 'The Cape', 'Graveyard', 'Hogback', 'Punchbowl', 'Redan', 'Biarritz', 'Home'];
  var EV_KIND = ['Classic', 'Open', 'Invitational', 'Championship', 'Challenge', 'Cup', 'Masters Series', 'Pro-Am'];
  var FIRST = ['Arlo', 'Bram', 'Cass', 'Dario', 'Emeka', 'Finn', 'Gustav', 'Hiro', 'Idris', 'Jonah', 'Kai', 'Lars', 'Mateo', 'Niko', 'Omar', 'Pieter', 'Quinn', 'Rafe', 'Soren', 'Tobias', 'Ugo', 'Viktor', 'Wes', 'Yusuf', 'Zane', 'Anika', 'Bea', 'Celia', 'Dana', 'Elin', 'Freya', 'Greta', 'Hana', 'Ines', 'Juno', 'Kira', 'Lena', 'Mira', 'Noor', 'Opal'];
  var LAST = ['Ashcombe', 'Brightwater', 'Castellan', 'Delvecchio', 'Fennimore', 'Gallowglass', 'Haverly', 'Ironwood', 'Kestrell', 'Lindqvane', 'Marchbanks', 'Northcott', 'Okonjo', 'Pellerin', 'Quarrington', 'Rookwood', 'Saltonstall', 'Thornbury', 'Underhill', 'Varga-Lind', 'Wexmoor', 'Yarrowby', 'Zelenko', 'Abernathy-Cole', 'Blackthorn', 'Corrigan', 'Duskwood', 'Halloran', 'Mavrides', 'Tanabe-Ross'];

  // ---- course: 18 hole specs from a seed ----
  function holeName(r, theme) {
    var k = r();
    var nouns = HN_NOUN[theme] || HN_NOUN.parkland;
    if (k < 0.12) return pick(r, HN_ALONE);
    if (k < 0.55) return pick(r, HN_ADJ) + ' ' + pick(r, nouns);
    if (k < 0.8) return 'The ' + pick(r, nouns);
    return pick(r, nouns) + ' ' + pick(r, ['Corner', 'Run', 'Watch', 'Rest', 'Crossing', 'View', 'Turn', 'Reach']);
  }
  function newCourse(seed, theme, lvl) {
    seed = seed >>> 0;
    var r = mulberry32(seed ^ 0x9e3779b9);
    if (!THEMES[theme]) theme = THEME_IDS[Math.floor(r() * THEME_IDS.length)];
    else r();
    lvl = lvl || 0;
    var name = pick(r, PLACE) + ' ' + pick(r, CTYPE[theme]);
    var holes = [], par = 0;
    for (var nine = 0; nine < 2; nine++) {
      var ps;
      do { ps = shuffle(r, [3, 3, 4, 4, 4, 4, 4, 5, 5]); } while (ps[0] === 3 || (ps[3] === ps[4] && ps[4] === 3) || ps[8] === 3 && nine === 1);
      for (var i = 0; i < 9; i++) {
        var p = ps[i], len;
        if (p === 3) len = 125 + r() * 85;
        else if (p === 4) len = 330 + r() * 120;
        else len = 495 + r() * 85;
        len = Math.round(len * (1 + 0.03 * lvl));
        holes.push({ n: holes.length + 1, par: p, len: len, seed: (r() * 4294967296) >>> 0, name: holeName(r, theme) });
        par += p;
      }
    }
    return { seed: seed, theme: theme, lvl: lvl, name: name, holes: holes, par: par };
  }

  // ---- terrain samplers ----
  function hAt(H, x, y) {
    var W = H.W;
    if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
    if (y < 0) y = 0; else if (y > H.L - 1.001) y = H.L - 1.001;
    var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * W + xi, a = H.hgt;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + W] * (1 - fx) + a[i + W + 1] * fx) * fy;
  }
  function lieAt(H, x, y) {
    if (x < 0 || y < 0 || x >= H.W || y >= H.L) return H.ocean && (x - H.W / 2) * H.ocean > 0 && y >= 0 && y < H.L ? WATER : OB;
    return H.lie[(y | 0) * H.W + (x | 0)];
  }
  var GR = [0, 0];
  function gradAt(H, x, y, out) {
    out = out || GR;
    out[0] = (hAt(H, x + 0.5, y) - hAt(H, x - 0.5, y));
    out[1] = (hAt(H, x, y + 0.5) - hAt(H, x, y - 0.5));
    return out;
  }
  function ellQ(e, x, y) {
    var dx = x - e.x, dy = y - e.y, u = dx * e.c + dy * e.s, v = -dx * e.s + dy * e.c;
    return Math.sqrt(u * u / (e.rx * e.rx) + v * v / (e.ry * e.ry));
  }
  function mkEll(x, y, rx, ry, rot) { return { x: x, y: y, rx: rx, ry: ry, c: Math.cos(rot || 0), s: Math.sin(rot || 0), rot: rot || 0 }; }
  function blobQ(parts, x, y) { var q = 9; for (var i = 0; i < parts.length; i++) { var v = ellQ(parts[i], x, y); if (v < q) q = v; } return q; }
  function blobBox(parts, pad) {
    var b = [1e9, 1e9, -1e9, -1e9];
    parts.forEach(function (e) { var m = Math.max(e.rx, e.ry) * (pad || 1.6); b[0] = Math.min(b[0], e.x - m); b[1] = Math.min(b[1], e.y - m); b[2] = Math.max(b[2], e.x + m); b[3] = Math.max(b[3], e.y + m); });
    return b;
  }

  // ---- one hole: lies, heights, trees, wind ----
  var TREE_KINDS = {
    oak: { r: [3.5, 6], h: [9, 15], tr: 0.5 }, pine: { r: [2.2, 3.4], h: [11, 19], tr: 0.4 }, palm: { r: [2.6, 3.4], h: [8, 13], tr: 0.35 },
    cactus: { r: [0.6, 0.9], h: [3, 5.5], tr: 0.7 }, bush: { r: [1.6, 2.6], h: [1.8, 3], tr: 1.2 }
  };
  function buildHole(course, hi, diff, opts) {
    opts = opts || {};
    var sp = course.holes[hi], th = THEMES[course.theme], themeId = course.theme, r = mulberry32(sp.seed), D = DIFFS[diff == null ? 1 : diff];
    var par = opts.par || sp.par, len = opts.len || sp.len, W = 300, ty = 30;
    var dog = 0, dogAmt = 0, dogAt = 0.6;
    if (par > 3 && r() < th.dogP && !opts.straight) { dog = r() < 0.5 ? -1 : 1; dogAmt = 28 + r() * 42; dogAt = par === 5 ? (r() < 0.5 ? 0.42 : 0.66) : 0.5 + r() * 0.14; }
    var wig = (r() - 0.5) * (opts.straight ? 0 : 18), wigF = 1 + r() * 1.5, wph = r() * 6;
    function off(s) { return dog * dogAmt * smooth(dogAt - 0.2, dogAt + 0.12, s) + wig * Math.sin(s * Math.PI * wigF + wph) * (par > 3 ? 1 : 0.3); }
    // tees: back, middle, front — the middle one plays the card length
    var gy = ty + 12 + len;
    for (var it = 0; it < 3; it++) {
      var arc = 0, py = off(0), N = 48;
      for (var k = 1; k <= N; k++) { var s0 = k / N, x1 = off(s0), dy = (gy - ty) / N; arc += Math.sqrt(dy * dy + (x1 - py) * (x1 - py)); py = x1; }
      gy = ty + (gy - ty) * (len + 12) / arc;
    }
    gy = Math.round(gy);
    var L = gy + 60, xc = W / 2 - off(1) / 2, px = new Float32Array(L), ca = new Float32Array(L);
    for (var y = 0; y < L; y++) px[y] = xc + off(clamp((y - ty) / (gy - ty), 0, 1));
    for (y = 0; y < L; y++) { var d1 = (px[Math.min(L - 1, y + 1)] - px[Math.max(0, y - 1)]) / 2; ca[y] = 1 / Math.sqrt(1 + d1 * d1); }
    function pathAng(yy) { yy = clamp(yy | 0, 1, L - 2); return Math.atan2(px[yy + 1] - px[yy - 1], 2); }
    var noise = makeNoise(sp.seed ^ 0x51ed), noise2 = makeNoise(sp.seed ^ 0xa11ce);
    // fairway shape
    var fw = th.fw * D.fw * (opts.fwMul || 1) * (0.85 + r() * 0.3), fwPh = r() * 6, rw = th.rough * (0.8 + r() * 0.4);
    var obL = fw + rw + th.deep * (0.7 + r() * 0.7), obR = fw + rw + th.deep * (0.7 + r() * 0.7);
    var fy0 = par === 3 ? gy - 34 : ty + 75 + r() * 55, fy1 = gy - 6;
    var ocean = !opts.noWater && th.ocean && r() < th.ocean ? (r() < 0.5 ? -1 : 1) : 0;
    if (ocean < 0) obL = Math.min(obL, fw + rw + 14); else if (ocean > 0) obR = Math.min(obR, fw + rw + 14);
    // green
    var gx = px[gy], gang = pathAng(gy) + (r() - 0.5) * 0.7;
    var grn = mkEll(gx, gy, (par === 3 ? 10 : 9) + r() * 6, 11 + r() * 7, gang);
    grn.rf = Math.min(grn.rx, grn.ry);
    var pq = r() * Math.PI * 2, pd = Math.sqrt(r()) * 0.55;
    var pin = { x: gx + (Math.cos(pq) * grn.rx * pd) * grn.c - (Math.sin(pq) * grn.ry * pd) * grn.s, y: gy + (Math.cos(pq) * grn.rx * pd) * grn.s + (Math.sin(pq) * grn.ry * pd) * grn.c, z: 0 };
    // water
    var waters = [];
    var island = !opts.noWater && par === 3 && r() < th.island;
    if (!opts.noWater && !island && r() < th.water) {
      var kind = th.creek && r() < 0.6 ? 'creek' : par === 3 ? 'front' : pick(r, ['side', 'side', 'front', 'creek']);
      if (kind === 'side') {
        var sd = r() < 0.5 ? -1 : 1, wy = ty + 12 + (par === 5 ? 200 + r() * 160 : 170 + r() * 110);
        wy = Math.min(wy, gy - 40);
        var wl = 35 + r() * 55, wofs = fw + 4 + r() * 10 + 16;
        waters.push({ kind: 'lake', parts: [mkEll(px[wy | 0] + sd * wofs, wy, 18 + r() * 10, wl, pathAng(wy)), mkEll(px[(wy + wl * 0.5) | 0] + sd * (wofs + 4), wy + wl * 0.5, 14 + r() * 8, wl * 0.6, pathAng(wy) + 0.3)] });
      } else if (kind === 'front') {
        var fy = gy - grn.ry - 14 - r() * 10;
        waters.push({ kind: 'lake', parts: [mkEll(px[fy | 0] + (r() - 0.5) * 12, fy, 26 + r() * 12, 9 + r() * 5, pathAng(fy) + (r() - 0.5) * 0.5), mkEll(px[fy | 0] + (r() - 0.5) * 24, fy + 4, 16 + r() * 8, 8 + r() * 3, 0)] });
      } else {
        var cy0 = par === 3 ? gy - grn.ry - 22 : ty + 12 + (par === 5 ? 280 + r() * 90 : 200 + r() * 70);
        cy0 = Math.min(cy0, gy - grn.ry - 16);
        waters.push({ kind: 'creek', y: cy0, w: 5 + r() * 4, amp: 6 + r() * 10, f: 0.02 + r() * 0.03, ph: r() * 6 });
      }
    }
    // bunkers
    var bunkers = [], nb = Math.round((1 + r() * 2.2) * th.bunk), pot = !!th.pot;
    for (var bi = 0; bi < nb; bi++) {
      var ang = gang + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 1.6) + (r() < 0.35 ? Math.PI : 0), bx = gx + Math.sin(ang) * (grn.rx + 4), by = gy - Math.cos(ang) * (grn.ry + 4);
      var br = pot ? 2.6 + r() * 1.5 : 4 + r() * 3.5;
      bunkers.push({ parts: [mkEll(bx, by, br * 1.2, br, ang + Math.PI / 2), mkEll(bx + (r() - 0.5) * br, by + (r() - 0.5) * br, br * 0.8, br * 0.7, r() * 3)], dep: pot ? 1.1 : 0.6 });
    }
    if (par > 3) {
      var nf = Math.round((0.6 + r() * 1.6) * th.bunk);
      for (bi = 0; bi < nf; bi++) {
        var fby = ty + 12 + 205 + r() * 70 + (par === 5 && bi > 0 ? 150 : 0);
        if (fby > gy - 50) continue;
        var fs = r() < 0.5 ? -1 : 1, fbx = px[fby | 0] + fs * (fw * (pot ? 0.2 + r() * 0.8 : 0.9) + 2), fr = pot ? 2.5 + r() : 4 + r() * 4;
        bunkers.push({ parts: [mkEll(fbx, fby, fr, fr * 2.2, pathAng(fby)), mkEll(fbx + fs * 2, fby + fr * 1.2, fr * 0.8, fr * 1.4, pathAng(fby) + 0.3)], dep: pot ? 1.1 : 0.5 });
      }
    }
    // tee boxes
    var tees = [0, 14, 30].map(function (o) { var yy = ty + o; return { x: px[yy], y: yy + 4, ang: pathAng(yy + 4) }; });
    var active = tees[clamp(opts.tee == null ? D.tee : opts.tee, 0, 2)];
    // ---- lies ----
    var lie = new Uint8Array(W * L), wid = new Uint8Array(W * L), dlat = new Float32Array(W * L), fwAt = new Float32Array(L);
    for (y = 0; y < L; y++) fwAt[y] = (y >= fy0 && y <= fy1) ? (par === 3 ? 9 : fw * (1 + 0.16 * Math.sin(y * 0.021 + fwPh))) * smooth(fy0 - 4, fy0 + 18, y) : 0;
    for (y = 0; y < L; y++) {
      var pxy = px[y], cy = ca[y], fwh = fwAt[y], cor = fwh > 0 ? fwh : 11, row = y * W;
      var behind = y < ty - 10 ? ty - 10 - y : y > gy + 34 ? y - gy - 34 : 0;
      for (var x = 0; x < W; x++) {
        var d = (x + 0.5 - pxy) * cy, ad = d < 0 ? -d : d, lim = d < 0 ? obL : obR, v;
        dlat[row + x] = d;
        if (ad < fwh) v = FAIR;
        else if (ad < cor + rw) v = th.waste && ad > cor + 3 ? WASTE : ROUGH;
        else if (ad < lim) v = th.waste ? WASTE : DEEP;
        else v = OB;
        if (behind > 0) v = behind > 14 ? OB : (v === OB ? OB : th.waste ? WASTE : DEEP);
        if (th.waste && v === WASTE && ad > lim - 8 && behind === 0) v = DEEP;
        if (ocean && d * ocean > 0 && ad > cor + rw + 8) { v = WATER; wid[row + x] = 1; }
        lie[row + x] = v;
      }
    }
    var islandE = null;
    if (island) {
      islandE = mkEll(gx, gy, grn.rx + 3 + 18 + r() * 8, grn.ry + 3 + 16 + r() * 8, grn.rot);
      waters.push({ kind: 'island', parts: [islandE] });
    }
    waters.forEach(function (wb, wi) {
      var id = wi + 2;
      if (wb.kind === 'creek') {
        for (var yy = Math.max(0, (wb.y - wb.w - 20) | 0); yy < Math.min(L, wb.y + wb.w + 20); yy++) for (var xx = 0; xx < W; xx++) {
          var cyv = wb.y + Math.sin(xx * wb.f + wb.ph) * wb.amp * 0.4;
          if (Math.abs(yy - cyv) < wb.w * 0.5 && Math.abs(dlat[yy * W + xx]) < 140) { lie[yy * W + xx] = WATER; wid[yy * W + xx] = id; }
        }
        return;
      }
      var bb = blobBox(wb.parts, 1.05);
      for (var y2 = Math.max(0, bb[1] | 0); y2 < Math.min(L, bb[3]); y2++) for (var x2 = Math.max(0, bb[0] | 0); x2 < Math.min(W, bb[2]); x2++) {
        var q = blobQ(wb.parts, x2 + 0.5, y2 + 0.5);
        if (wb.kind === 'island') { if (q < 1 && y2 > ty + 40 && ellQ(grn, x2 + 0.5, y2 + 0.5) > 1 + 3.5 / grn.rf) { lie[y2 * W + x2] = WATER; wid[y2 * W + x2] = id; } }
        else if (q < 1) { lie[y2 * W + x2] = WATER; wid[y2 * W + x2] = id; }
      }
    });
    bunkers.forEach(function (bk) {
      var bb = blobBox(bk.parts, 1.05);
      for (var y2 = Math.max(0, bb[1] | 0); y2 < Math.min(L, bb[3]); y2++) for (var x2 = Math.max(0, bb[0] | 0); x2 < Math.min(W, bb[2]); x2++) {
        if (blobQ(bk.parts, x2 + 0.5, y2 + 0.5) < 1 && lie[y2 * W + x2] !== WATER) lie[y2 * W + x2] = SAND;
      }
    });
    var gb = blobBox([grn], 1.5);
    for (y = Math.max(0, gb[1] | 0); y < Math.min(L, gb[3]); y++) for (x = Math.max(0, gb[0] | 0); x < Math.min(W, gb[2]); x++) {
      var qg = ellQ(grn, x + 0.5, y + 0.5), k2 = y * W + x;
      if (qg < 1) lie[k2] = GREEN;
      else if (qg < 1 + 2.6 / grn.rf && lie[k2] !== SAND && lie[k2] !== WATER) lie[k2] = FRINGE;
      else if (par > 3 && !island && qg < 1.45 && y < gy && lie[k2] === ROUGH && Math.abs(dlat[k2]) < fw * 0.8) lie[k2] = FAIR;   // the apron
    }
    tees.forEach(function (t) {
      for (var yy = t.y - 6; yy < t.y + 6; yy++) for (var xx = Math.round(t.x - 5); xx < t.x + 5; xx++) if (yy >= 0 && xx >= 0 && xx < W) lie[yy * W + xx] = TEE;
    });
    // ---- heights ----
    var amp = th.amp, elev = (r() - 0.4) * th.elev, gs = (0.008 + r() * 0.02) * D.slope, gsa = r() * Math.PI * 2, gsx = Math.sin(gsa) * gs, gsy = Math.cos(gsa) * gs;
    var und = r() * 0.35, uph = r() * 6, valley = th.valley, dune = th.dune;
    var hgt = new Float32Array(W * L);
    function hRaw(xx, yy, dd) {
      var s = clamp((yy - ty) / (gy - ty), 0, 1), ad = Math.abs(dd), fwh = fwAt[clamp(yy | 0, 0, L - 1)] || 11;
      var hi = amp * fbm(noise, xx / 52, yy / 52, 3), lo = amp * 0.8 * noise2(xx / 150, yy / 150);
      var k = 0.25 + 0.75 * smooth(fwh, fwh + 34, ad), h = lo + (hi - lo) * k + elev * smooth(0.15, 1, s);
      if (dune) h += dune * Math.abs(noise2(xx / 22 + 40, yy / 22)) * smooth(fwh + 4, fwh + 26, ad);
      if (valley) h += Math.max(0, ad - fwh - 18) * valley;
      return h;
    }
    for (y = 0; y < L; y++) for (x = 0; x < W; x++) hgt[y * W + x] = hRaw(x, y, dlat[y * W + x]);
    var hc = hRaw(gx, gy, 0) + (themeId === 'links' ? 0.1 : 0.7);
    for (y = Math.max(0, gb[1] - 8 | 0); y < Math.min(L, gb[3] + 8); y++) for (x = Math.max(0, gb[0] - 8 | 0); x < Math.min(W, gb[2] + 8); x++) {
      var q3 = ellQ(grn, x, y), w3 = 1 - smooth(1.15, 1.85, q3);
      if (w3 <= 0) continue;
      var dx3 = x - gx, dy3 = y - gy, u3 = dx3 * grn.c + dy3 * grn.s, v3 = -dx3 * grn.s + dy3 * grn.c;
      var tgt = hc + gsx * dx3 + gsy * dy3 + und * Math.sin(u3 * 0.23 + uph) * Math.cos(v3 * 0.19 + uph * 0.5);
      hgt[y * W + x] = lerp(hgt[y * W + x], tgt, w3);
    }
    tees.forEach(function (t) {
      var th0 = hRaw(t.x, t.y, 0) + 0.45;
      for (var yy = Math.max(0, t.y - 11); yy < Math.min(L, t.y + 11); yy++) for (var xx = Math.max(0, Math.round(t.x - 10)); xx < Math.min(W, t.x + 10); xx++) {
        var ox = Math.max(0, Math.abs(xx - t.x) - 5), oy = Math.max(0, Math.abs(yy - t.y) - 6), w4 = 1 - smooth(0, 4.5, Math.sqrt(ox * ox + oy * oy));
        if (w4 > 0) hgt[yy * W + xx] = lerp(hgt[yy * W + xx], th0, w4);
      }
    });
    bunkers.forEach(function (bk) {
      var bb = blobBox(bk.parts, 1.2);
      for (var y2 = Math.max(0, bb[1] | 0); y2 < Math.min(L, bb[3]); y2++) for (var x2 = Math.max(0, bb[0] | 0); x2 < Math.min(W, bb[2]); x2++) {
        var q = blobQ(bk.parts, x2, y2);
        if (q < 1.05) hgt[y2 * W + x2] -= bk.dep * (1 - smooth(0.6, 1.05, q));
      }
    });
    // each body of water lies flat, a little under its lowest bank
    var wmin = {};
    for (var i = 0; i < W * L; i++) if (wid[i]) { var h0 = hgt[i]; if (wmin[wid[i]] == null || h0 < wmin[wid[i]]) wmin[wid[i]] = h0; }
    for (i = 0; i < W * L; i++) if (wid[i]) hgt[i] = wmin[wid[i]] - 0.45;
    var sea = ocean ? wmin[1] - 0.45 : 0;
    // ---- trees ----
    var trees = [], kinds = TREE_KINDS, nt = Math.round(th.trees * W * L / 150000), tries = nt * 5;
    for (var tI = 0; tI < tries && trees.length < nt; tI++) {
      var tx = r() * W, tyy = r() * L, kk = (ty_ok(tx, tyy));
      if (!kk) continue;
      var kname = th.alt && r() < 0.3 ? th.alt : th.tree, K = kinds[kname], tr = lerp(K.r[0], K.r[1], r()), thh = lerp(K.h[0], K.h[1], r());
      trees.push({ id: trees.length, x: tx, y: tyy, z: hAt({ W: W, L: L, hgt: hgt }, tx, tyy), r: tr, h: thh, tr: K.tr, k: kname });
    }
    function ty_ok(tx, tyy) {
      var k5 = (tyy | 0) * W + (tx | 0), lv = lie[k5];
      if (lv === WATER || lv === GREEN || lv === FRINGE || lv === TEE || lv === SAND || lv === FAIR) return false;
      var ad = Math.abs(dlat[k5]), fwh = fwAt[tyy | 0] || 11, edge = fwh + rw;
      if (tyy > gy - 30 && tyy < gy + 25 && Math.abs(tx - gx) < grn.rx + 12) return false;
      if (Math.abs(tyy - ty - 12) < 24 && ad < 20) return false;
      if (lv === OB) return r() < 0.35;
      if (th.tree === 'bush' || th.tree === 'cactus') return ad > fwh + 2;
      return ad > edge + 2 || (ad > edge - 3 && r() < 0.15);
    }
    // a tree guarding the inside of a dogleg
    if (dog && th.tree !== 'bush') {
      var cyy = Math.round(ty + 12 + (gy - ty) * (dogAt - 0.1)), cxx = px[cyy] + dog * (fwAt[cyy] + rw + 5);
      if (cxx > 2 && cxx < W - 2) { var K2 = kinds[th.tree]; trees.push({ id: trees.length, x: cxx, y: cyy, z: hAt({ W: W, L: L, hgt: hgt }, cxx, cyy), r: K2.r[1] * 1.1, h: K2.h[1] * 1.1, tr: K2.tr, k: th.tree }); }
    }
    var tgw = Math.ceil(W / 16), tgh = Math.ceil(L / 16), tg = new Array(tgw * tgh);
    trees.forEach(function (t) {
      for (var gy2 = Math.max(0, ((t.y - t.r) / 16) | 0); gy2 <= Math.min(tgh - 1, ((t.y + t.r) / 16) | 0); gy2++)
        for (var gx2 = Math.max(0, ((t.x - t.r) / 16) | 0); gx2 <= Math.min(tgw - 1, ((t.x + t.r) / 16) | 0); gx2++) (tg[gy2 * tgw + gx2] = tg[gy2 * tgw + gx2] || []).push(t);
    });
    // ---- wind ----
    var wa = r() * Math.PI * 2, wm = opts.wind != null ? opts.wind : Math.round((1 + r() * 13) * D.wind);
    var H = {
      W: W, L: L, hgt: hgt, lie: lie, px: px, gy: gy, ty: ty, par: par, n: sp.n, name: opts.name || sp.name, theme: themeId,
      tees: tees, tee: { x: active.x, y: active.y }, teeIdx: clamp(opts.tee == null ? D.tee : opts.tee, 0, 2), pin: pin, green: grn, bunkers: bunkers, waters: waters, trees: trees, tg: tg, tgw: tgw, tgh: tgh,
      ocean: ocean, sea: sea, fw: fw, gslope: { x: gsx, y: gsy }, dog: dog,
      wind: { mph: wm, ang: wa, x: Math.sin(wa) * wm * MPH, y: Math.cos(wa) * wm * MPH }
    };
    pin.z = hAt(H, pin.x, pin.y);
    H.len = Math.round(pathLen(H, active.y, pin.y) + Math.abs(pin.x - px[pin.y | 0]) * 0.3);
    var xmn = 1e9, xmx = -1e9;
    for (y = 0; y < L; y++) { xmn = Math.min(xmn, px[y]); xmx = Math.max(xmx, px[y]); }
    H.xmin = Math.max(0, xmn - 75); H.xmax = Math.min(W, xmx + 75);
    return H;
  }
  function pathLen(H, y0, y1) {
    var a = 0, px = H.px;
    for (var y = Math.max(0, y0 | 0); y < Math.min(H.L - 1, y1 | 0); y++) { var dx = px[y + 1] - px[y]; a += Math.sqrt(1 + dx * dx); }
    return a;
  }
  function distPin(H, x, y) { var dx = x - H.pin.x, dy = y - H.pin.y; return Math.sqrt(dx * dx + dy * dy); }
  function holeEnv(H, diff, mul) {
    var D = DIFFS[diff == null ? 1 : diff];
    return { wx: H.wind.x * (mul == null ? 1 : mul), wy: H.wind.y * (mul == null ? 1 : mul), gdec: 6 / D.stimp, px: H.pin.x, py: H.pin.y };
  }

  // ---- ball flight ----
  function newBall(x, y, z) { return { x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, sb: 0, ss: 0, st: 'rest', t: 0, bounces: 0, peak: z, land: null, dry: null, ev: [], lastTree: -1, lipped: false }; }
  function flyStep(b, wx, wy) {
    var rvx = b.vx - wx, rvy = b.vy - wy, rvz = b.vz;
    var sp = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz), hh = Math.sqrt(rvx * rvx + rvy * rvy) || 1e-6;
    var rx = rvy / hh, ry = -rvx / hh;
    var ax = -KD * sp * rvx, ay = -KD * sp * rvy, az = -G - KD * sp * rvz;
    var lift = KL * b.sb * sp;
    ax += lift * ry * rvz; ay += -lift * rx * rvz; az += lift * hh;
    var side = KS * b.ss * sp;
    ax += side * rvy; ay += -side * rvx;
    b.vx += ax * DT; b.vy += ay * DT; b.vz += az * DT;
    b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
    b.sb *= SPIN_DECAY; b.ss *= SPIN_DECAY;
  }
  // flat ground, no wind: how far a launch carries (club calibration)
  function simCarry(speed, laDeg, sb) {
    var la = laDeg * Math.PI / 180, b = newBall(0, 0, 0), apex = 0;
    b.vy = speed * Math.cos(la); b.vz = speed * Math.sin(la); b.sb = sb;
    for (var i = 0; i < 2400; i++) { flyStep(b, 0, 0); if (b.z > apex) apex = b.z; if (b.z <= 0 && b.vz < 0) break; }
    return { carry: b.y, apex: apex, t: i * DT, vy: b.vy, vz: b.vz };
  }
  var V0C = {};
  function clubV0(ci, carry) {
    var c = CLUBS[ci], key = ci + ':' + Math.round(carry * 10);
    if (V0C[key]) return V0C[key];
    var lo = 5, hi = 160;
    for (var k = 0; k < 32; k++) { var m = (lo + hi) / 2; if (simCarry(m, c.launch, c.spin).carry < carry) lo = m; else hi = m; }
    return (V0C[key] = (lo + hi) / 2);
  }
  // equipment: { drv, irn, wdg, bal, put } levels 0..3
  function carryOf(ci, eq) {
    var c = CLUBS[ci]; eq = eq || {};
    var m = 1 + 0.015 * (eq.bal || 0);
    if (c.wood) m += 0.035 * (eq.drv || 0); else m += 0.015 * (eq.irn || 0);
    return c.carry * m;
  }
  function lieDist(ci, lie) {
    var c = CLUBS[ci];
    if (lie === SAND) return c.sand ? 0.9 : c.wood ? 0.5 : 0.74;
    if (lie === DEEP) return c.wood ? 0.5 : c.wedge ? 0.8 : 0.66;
    if (lie === ROUGH) return c.wood ? 0.8 : 0.9;
    if (lie === WASTE) return c.wood ? 0.78 : 0.88;
    return LIE[lie].dist;
  }
  // swing → normalized hook/slice: rawAng is the up-stroke's lean (radians, + = right)
  function devFromStroke(rawAng, diff, eq) {
    var D = DIFFS[diff == null ? 1 : diff], tol = D.tol * (1 + 0.15 * ((eq && eq.irn) || 0));
    var dead = 0.04 * tol, a = Math.abs(rawAng);
    if (a <= dead) return 0;
    return clamp((rawAng < 0 ? -1 : 1) * (a - dead) / (0.32 * Math.sqrt(tol)), -1.6, 1.6);
  }
  function devFromMeter(off, diff, eq) {   // off: the 3rd click's distance from the line, -0.15..0.15
    var D = DIFFS[diff == null ? 1 : diff], tol = D.tol * (1 + 0.15 * ((eq && eq.irn) || 0));
    var dead = 0.011 * tol, a = Math.abs(off);
    if (a <= dead) return 0;
    return clamp((off < 0 ? -1 : 1) * (a - dead) / (0.07 * Math.sqrt(tol)), -1.6, 1.6);
  }
  // shot = { club, yaw, power (0..1.15), dev (-1.6..1.6, + = slice/push right) }
  function launch(H, from, shot, eq, env, rnd) {
    var c = CLUBS[shot.club], lie = from.lie, L = LIE[lie], b = newBall(from.x, from.y, hAt(H, from.x, from.y));
    rnd = rnd || Math.random; eq = eq || {};
    b.from = { x: from.x, y: from.y, lie: lie };
    b.dry = { x: from.x, y: from.y };
    if (c.putt) {
      var dist = Math.max(0.15, shot.power) * PUTT_MAX * (lie === FRINGE ? 1.1 : 1), spd = Math.sqrt(2 * env.gdec * dist);
      var pyaw = shot.yaw + shot.dev * 0.05 / (1 + 0.25 * (eq.put || 0));
      b.vx = Math.sin(pyaw) * spd; b.vy = Math.cos(pyaw) * spd; b.st = 'roll'; b.putt = true;
      return b;
    }
    var p = clamp(shot.power, 0.03, 1.15), pf = p <= 1 ? Math.pow(p, 0.56) : 1 + (p - 1) * 0.42;
    var dev = shot.dev;
    if (p > 1) dev += gauss(rnd) * (p - 1) * 3.2;                        // an overswing is wild
    if (L.err > 1) dev += gauss(rnd) * (L.err - 1) * 0.35;                 // a bad lie is too
    var speed = clubV0(shot.club, carryOf(shot.club, eq)) * pf * lieDist(shot.club, lie);
    var la = (c.launch + (lie === ROUGH || lie === DEEP ? 2 : 0) + (lie === SAND && c.sand ? 5 : 0)) * Math.PI / 180;
    var yaw = shot.yaw + dev * 0.055;
    b.sb = c.spin * L.spin * (c.wedge ? 1 + 0.15 * (eq.wdg || 0) : 1);
    b.ss = dev * 0.55 * (c.wood ? 1.2 : 1);
    var vh = speed * Math.cos(la);
    b.vx = Math.sin(yaw) * vh; b.vy = Math.cos(yaw) * vh; b.vz = speed * Math.sin(la);
    b.st = 'fly'; b.speed0 = speed;
    return b;
  }
  // english during the flight: side (-1..1 left/right), top (-1 back .. +1 top); budget is spent per call
  function applyEnglish(b, side, top) {
    if (b.st !== 'fly') return false;
    b.ss += side * 0.9;
    b.sb -= top * 0.45;
    if (b.sb < -0.35) b.sb = -0.35; if (b.sb > 1.6) b.sb = 1.6;
    return true;
  }
  function treeHit(H, b) {
    var cx = (b.x / 16) | 0, cy = (b.y / 16) | 0;
    if (cx < 0 || cy < 0 || cx >= H.tgw || cy >= H.tgh) return;
    var list = H.tg[cy * H.tgw + cx];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.id === b.lastTree) continue;
      var dx = b.x - t.x, dy = b.y - t.y, hz = b.z - t.z, d2 = dx * dx + dy * dy;
      if (hz < 0 || hz > t.h || d2 > t.r * t.r) continue;
      var hit;
      if (t.k === 'cactus') hit = d2 < t.tr * t.tr;
      else if (t.k === 'bush') hit = d2 / (t.r * t.r) + (hz * hz) / (t.h * t.h) < 1;
      else { var cz = t.h - t.r * 1.1; hit = hz > t.h - t.r * 2.2 ? d2 / (t.r * t.r) + (hz - cz) * (hz - cz) / (1.21 * t.r * t.r) < 1 : d2 < t.tr * t.tr; }
      if (!hit) continue;
      b.lastTree = t.id;
      var hsh = ((t.id * 2654435761) >>> 0) / 4294967296, rot = (hsh - 0.5) * 2.6 + (b.t * 7 % 1 - 0.5);
      var c = Math.cos(rot), s = Math.sin(rot), k = 0.2, vx = b.vx, vy = b.vy;
      b.vx = (vx * c - vy * s) * k; b.vy = (vx * s + vy * c) * k; b.vz = Math.min(b.vz * 0.2, 1.5);
      b.sb = 0; b.ss = 0;
      b.ev.push('tree');
      return;
    }
  }
  function holeIt(b, env) { b.st = 'holed'; b.x = env.px; b.y = env.py; b.vx = b.vy = b.vz = 0; b.ev.push('cup'); }
  function impact(H, b, env, gh) {
    var lie = lieAt(H, b.x, b.y);
    b.z = gh;
    if (!b.land) { b.land = { x: b.x, y: b.y, lie: lie }; b.ev.push('land'); }
    if (lie === WATER) { b.st = 'water'; b.ev.push('splash'); return; }
    var dpx = b.x - env.px, dpy = b.y - env.py;
    if (dpx * dpx + dpy * dpy < CUP_R * CUP_R * 1.3 && b.bounces < 3) { holeIt(b, env); return; }
    if (lie === SAND) b.ev.push('sand');
    var g = gradAt(H, b.x, b.y), nl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + 1), nx = -g[0] / nl, ny = -g[1] / nl, nz = 1 / nl;
    var vn = b.vx * nx + b.vy * ny + b.vz * nz;
    if (vn > 0) { b.z = gh + 0.01; return; }
    var tx = b.vx - vn * nx, ty = b.vy - vn * ny, tz = b.vz - vn * nz, th = Math.sqrt(tx * tx + ty * ty + tz * tz);
    var L = LIE[lie], keep = 1 - L.grab * (b.bounces ? 0.6 : 1);
    var bite = b.sb * L.bite * Math.min(-vn, 22) * 0.6;
    var nt = th * keep - bite;
    if (nt < -3) nt = -3;
    if (th > 1e-6) { var f = nt / th; tx *= f; ty *= f; tz *= f; }
    var e = L.e * (b.bounces ? 0.8 : 1);
    b.vx = tx - e * vn * nx; b.vy = ty - e * vn * ny; b.vz = tz - e * vn * nz;
    b.sb *= 0.35; b.ss *= 0.2; b.bounces++;
    b.ev.push('bounce');
    if (-vn * e < 1.1 || b.bounces > 8) { b.st = 'roll'; b.vz = 0; }
    b.z = gh + 0.005;
  }
  function rollStep(H, b, env) {
    var lie = lieAt(H, b.x, b.y);
    if (lie === WATER) { b.st = 'water'; b.ev.push('splash'); return; }
    var g = gradAt(H, b.x, b.y), dec = lie === GREEN ? env.gdec : LIE[lie].roll;
    var ax = -ROLL_K * g[0], ay = -ROLL_K * g[1], sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp < 0.06 && ax * ax + ay * ay < dec * dec * 1.3) { b.vx = b.vy = 0; b.st = 'rest'; return; }
    b.vx += ax * DT; b.vy += ay * DT;
    sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp > 0) { var dd = dec * DT; if (dd >= sp) { b.vx = 0; b.vy = 0; } else { b.vx -= b.vx / sp * dd; b.vy -= b.vy / sp * dd; } }
    var dx = b.x - env.px, dy = b.y - env.py, d2 = dx * dx + dy * dy;
    if (d2 < CUP_R * CUP_R) {
      var cap = 1.9 * Math.sqrt(1 - d2 / (CUP_R * CUP_R)) + 0.4;
      if (sp < cap) { holeIt(b, env); return; }
      if (!b.lipped) {
        b.lipped = true; b.ev.push('lip');
        var side = dx * b.vy - dy * b.vx > 0 ? 1 : -1, a = 0.5 * side, c = Math.cos(a), s = Math.sin(a), vx = b.vx, vy = b.vy;
        b.vx = (vx * c - vy * s) * 0.55; b.vy = (vx * s + vy * c) * 0.55;
      }
    } else if (d2 > CUP_R * CUP_R * 4) b.lipped = false;
    b.x += b.vx * DT; b.y += b.vy * DT; b.z = hAt(H, b.x, b.y);
    if (b.t > 60) { b.vx = b.vy = 0; b.st = 'rest'; }
  }
  function stepBall(H, b, env) {
    b.t += DT;
    if (b.st === 'fly') {
      var g0 = hAt(H, b.x, b.y), wf = clamp(0.35 + (b.z - g0) / 30, 0.35, 1.1);
      flyStep(b, env.wx * wf, env.wy * wf);
      if (b.z > b.peak) b.peak = b.z;
      var gh = hAt(H, b.x, b.y);
      if (H.trees.length && b.z - gh < 22) treeHit(H, b);
      var l = lieAt(H, b.x, b.y);
      if (l !== WATER && l !== OB) { if (!b.dry) b.dry = {}; b.dry.x = b.x; b.dry.y = b.y; }
      if (b.z <= gh) impact(H, b, env, gh);
      if (b.t > 30) b.st = 'rest';
    } else if (b.st === 'roll') {
      rollStep(H, b, env);
      if (b.st === 'roll' || b.st === 'rest') { var l2 = lieAt(H, b.x, b.y); if (l2 !== WATER && l2 !== OB) { b.dry.x = b.x; b.dry.y = b.y; } }
    }
  }
  function moving(b) { return b.st === 'fly' || b.st === 'roll'; }
  // where a ball that went in the water is dropped: back from the last dry point toward where it was hit
  function dropPoint(H, b) {
    var f = b.from, dx = f.x - b.dry.x, dy = f.y - b.dry.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    for (var k = 2; k < 60; k += 2) {
      var x = b.dry.x + dx / d * k, y = b.dry.y + dy / d * k, l = lieAt(H, x, y);
      if (k > d) break;
      if (l !== WATER && l !== OB && l !== GREEN) return { x: x, y: y, lie: l };
    }
    return { x: f.x, y: f.y, lie: f.lie };
  }
  // simulate to the end (CPU planning, previews); returns the ball
  function simShot(H, from, shot, eq, env, maxT) {
    var b = launch(H, from, shot, eq, env, function () { return 0.5; });
    var n = Math.round((maxT || 40) / DT);
    for (var i = 0; i < n && moving(b); i++) stepBall(H, b, env);
    if (moving(b)) b.st = 'rest';
    return b;
  }
  // the flight path up to the first landing (shot preview)
  function previewArc(H, from, ci, yaw, eq, env, out) {
    var b = launch(H, from, { club: ci, yaw: yaw, power: 1, dev: 0 }, eq, { wx: 0, wy: 0, gdec: env.gdec, px: env.px, py: env.py }, function () { return 0.5; });
    out = out || []; out.length = 0;
    if (b.putt) return { pts: out, land: null, carry: 0 };
    var e0 = { wx: 0, wy: 0, gdec: env.gdec, px: -999, py: -999 };
    for (var i = 0; i < 2400 && b.st === 'fly' && !b.land; i++) { stepBall(H, b, e0); if (i % 6 === 0) out.push(b.x, b.y, b.z); }
    out.push(b.x, b.y, b.z);
    return { pts: out, land: { x: b.x, y: b.y }, carry: Math.sqrt((b.x - from.x) * (b.x - from.x) + (b.y - from.y) * (b.y - from.y)) };
  }

  // ---- strokes-to-go estimate (CPU judgement) ----
  var EXP_T = [[0, 2.15], [10, 2.35], [25, 2.5], [50, 2.65], [100, 2.8], [150, 2.95], [200, 3.15], [250, 3.45], [300, 3.75], [400, 4.1], [500, 4.6], [650, 5.2]];
  function puttExp(d) { return d < 0.25 ? 1 : 1 + Math.min(1.35, 0.38 * Math.log(1 + d / 0.9)); }
  function expStrokes(H, x, y, lie) {
    var d = distPin(H, x, y);
    if (lie === GREEN) return puttExp(d);
    var e = EXP_T[EXP_T.length - 1][1];
    for (var i = 1; i < EXP_T.length; i++) if (d <= EXP_T[i][0]) { var a = EXP_T[i - 1], c = EXP_T[i]; e = a[1] + (c[1] - a[1]) * (d - a[0]) / (c[0] - a[0]); break; }
    if (lie === FRINGE) e = Math.min(e, puttExp(d) + 0.12);
    else if (lie === ROUGH) e += 0.16;
    else if (lie === DEEP) e += 0.45;
    else if (lie === SAND) e += d < 40 ? 0.3 : 0.4;
    else if (lie === WASTE) e += 0.2;
    else if (lie === OB) e += 2;
    return e;
  }
  // the cost of where a simulated ball ended up
  function outcomeCost(H, b) {
    if (b.st === 'holed') return 0;
    if (b.st === 'water') { var dp = dropPoint(H, b); return 1 + expStrokes(H, dp.x, dp.y, dp.lie); }
    var l = lieAt(H, b.x, b.y);
    if (l === OB) return 1 + expStrokes(H, b.from.x, b.from.y, b.from.lie);
    if (l === WATER) return 1.2 + expStrokes(H, b.x, b.y, ROUGH);
    return expStrokes(H, b.x, b.y, l);
  }
  // CPU planner: tries clubs × aims × powers with the real physics (wind known), a few per call
  function aimYaw(fx, fy, tx, ty) { return Math.atan2(tx - fx, ty - fy); }
  function newPlanner(H, from, eq, env, skill) {
    var cands = [], d = distPin(H, from.x, from.y), yp = aimYaw(from.x, from.y, H.pin.x, H.pin.y), i, j;
    var onGreen = from.lie === GREEN || (from.lie === FRINGE && d < 14);
    if (onGreen) {
      var base = Math.min(1, Math.max(0.03, d / PUTT_MAX));
      for (i = -10; i <= 10; i++) for (j = 0; j < 9; j++) cands.push({ club: PUTTER, yaw: yp + i * 0.0105 * Math.min(3, 6 / (d + 1) + 0.6), power: clamp(base * (0.8 + j * 0.09), 0.02, 1), dev: 0 });
    } else {
      for (var ci = 0; ci < PUTTER; ci++) {
        var carry = carryOf(ci, eq) * lieDist(ci, from.lie);
        if (ci === 0 && from.lie !== TEE && from.lie !== FAIR) continue;
        if (carry > d * 1.25 + 20 && ci < PUTTER - 2) continue;
        if (carry < d * 0.4 && ci > 2) continue;
        var tyaw = [yp];
        var ahead = Math.min(H.L - 2, from.y + carry * 1.05 * Math.cos(yp));
        if (ahead < H.pin.y - 5) tyaw.push(aimYaw(from.x, from.y, H.px[ahead | 0], ahead));
        var pows = [1];
        if (carry > d * 0.85 && (CLUBS[ci].wedge || ci === PUTTER - 3)) { var pr = d / carry; pows = [1]; [0.85, 0.95, 1.05, 1.15, 1.25].forEach(function (k) { var pp = pr * k; if (pp < 0.97 && pp > 0.08) pows.push(pp); }); }
        tyaw.forEach(function (ty) { for (var k = -3; k <= 3; k++) pows.forEach(function (pw) { cands.push({ club: ci, yaw: ty + k * 0.045, power: pw, dev: 0 }); }); });
      }
      if ((d < 16 && from.lie === FRINGE) || (d < 10 && from.lie === FAIR)) { var bp = Math.min(1, d / PUTT_MAX * 1.4); for (i = -2; i <= 2; i++) for (j = 0; j < 4; j++) cands.push({ club: PUTTER, yaw: yp + i * 0.02, power: bp * (0.8 + j * 0.15), dev: 0 }); }
    }
    return { H: H, from: from, eq: eq, env: env, skill: skill, cands: cands, i: 0, best: null, top: [], stage: 0, onGreen: onGreen };
  }
  function planStep(P, budget) {
    var H = P.H;
    while (budget-- > 0) {
      if (P.stage === 0) {
        if (P.i >= P.cands.length) { P.stage = 1; P.i = 0; P.top.sort(function (a, b) { return a.cost - b.cost; }); P.top = P.top.slice(0, P.onGreen ? 4 : 6); continue; }
        var c = P.cands[P.i++], b = simShot(H, P.from, c, P.eq, P.env);
        c.cost = outcomeCost(H, b) + (c.power > 1 ? 0.2 : 0);
        P.top.push(c);
      } else {
        if (P.i >= P.top.length) { P.top.sort(function (a, b) { return a.rc - b.rc; }); P.best = P.top[0] || P.cands[0]; return true; }
        var t = P.top[P.i++], sum = t.cost, n = 1, spread = P.onGreen ? [[0.012, 0], [-0.012, 0], [0, 0.06], [0, -0.06]] : [[0, 0.35], [0, -0.35], [0.03, 0], [-0.03, 0]];
        spread.forEach(function (sv) {
          var sh = { club: t.club, yaw: t.yaw + sv[0], power: clamp(t.power * (1 + (P.onGreen ? sv[1] : 0)), 0.02, 1.1), dev: P.onGreen ? 0 : sv[1] };
          sum += outcomeCost(H, simShot(H, P.from, sh, P.eq, P.env)); n++;
        });
        t.rc = sum / n;
      }
    }
    return false;
  }
  // the CPU's swing: its plan plus mistakes that shrink with skill (0..1)
  function cpuExecute(plan, skill, rnd, diff) {
    var s = clamp(skill, 0, 1), D = DIFFS[diff == null ? 1 : diff], wob = 1 / Math.sqrt(D.tol);
    var sh = { club: plan.club, yaw: plan.yaw, power: plan.power, dev: plan.dev || 0 };
    if (CLUBS[plan.club].putt) {
      sh.yaw += gauss(rnd) * (0.036 - 0.027 * s) * wob;
      sh.power = clamp(sh.power * (1 + gauss(rnd) * (0.17 - 0.11 * s)), 0.02, 1);
    } else {
      sh.dev += gauss(rnd) * (0.85 - 0.68 * s) * wob;
      sh.power = clamp(sh.power + gauss(rnd) * (0.09 - 0.07 * s), 0.1, 1.08);
      sh.yaw += gauss(rnd) * (0.03 - 0.022 * s);
    }
    return sh;
  }
  // default club for a lie and distance (auto select)
  function autoClub(H, from, eq) {
    var d = distPin(H, from.x, from.y);
    if (from.lie === GREEN) return PUTTER;
    if (from.lie === FRINGE && d < 12) return PUTTER;
    for (var ci = PUTTER - 1; ci >= 0; ci--) {
      if (ci === 0 && from.lie !== TEE) break;
      var c = carryOf(ci, eq) * lieDist(ci, from.lie);
      if (c >= d * 0.97 - (CLUBS[ci].wedge ? 4 : 0)) return ci;
    }
    if (from.lie === TEE) return H.par === 3 ? 1 : 0;
    return from.lie === FAIR ? 1 : from.lie === SAND ? 3 : 2;
  }
  // a sensible default aim: at the pin, or down the fairway when the pin is out of reach
  function autoAim(H, from, ci, eq) {
    var d = distPin(H, from.x, from.y), c = CLUBS[ci].putt ? 0 : carryOf(ci, eq) * lieDist(ci, from.lie);
    if (CLUBS[ci].putt || c >= d * 0.9) return aimYaw(from.x, from.y, H.pin.x, H.pin.y);
    var ty = clamp(from.y + c * 1.06, 0, H.L - 2);
    return aimYaw(from.x, from.y, H.px[ty | 0], ty);
  }
  function scoreName(n, par) {
    var d = n - par;
    if (n === 1) return 'Hole in one';
    if (d <= -3) return 'Albatross';
    if (d === -2) return 'Eagle';
    if (d === -1) return 'Birdie';
    if (d === 0) return 'Par';
    if (d === 1) return 'Bogey';
    if (d === 2) return 'Double bogey';
    if (d === 3) return 'Triple bogey';
    return '+' + d;
  }
  function capOf(par) { return par + 4; }

  // ---- a round: players take turns; the farthest from the hole plays ----
  // cfg: { mode, seed, theme, lvl, holes:[idx], players:[{name, cpu, skill}], diff, gim (yards or -1 auto), eq, tour, ch }
  function newRound(cfg) {
    return {
      v: 1, mode: cfg.mode || 'quick', seed: cfg.seed >>> 0, theme: cfg.theme, lvl: cfg.lvl || 0, holes: cfg.holes.slice(), hi: 0,
      diff: cfg.diff == null ? 1 : cfg.diff, gim: cfg.gim == null ? -1 : cfg.gim, eq: cfg.eq || {},
      players: cfg.players.map(function (p) { return { name: p.name, cpu: p.cpu || 0, skill: p.skill || 0, scores: [], putts: 0 }; }),
      hs: null, cur: 0, tour: cfg.tour || null, ch: cfg.ch || null, over: false
    };
  }
  function gimmeOf(g) { return g.gim >= 0 ? g.gim : DIFFS[g.diff].gim; }
  function startHole(g, H) {
    var prev = g.hi > 0 ? g.players.map(function (p) { return p.scores[g.hi - 1] || 99; }) : null;
    var order = g.players.map(function (p, i) { return i; });
    if (prev) order.sort(function (a, b) { return prev[a] - prev[b] || a - b; });
    g.hs = { order: order, b: g.players.map(function () { return { x: H.tee.x, y: H.tee.y, lie: TEE, strokes: 0, done: false, putts: 0, pen: 0 }; }) };
    g.cur = order[0];
    return g;
  }
  function nextPlayer(g, H) {
    var hs = g.hs, best = -1, bd = -1;
    for (var k = 0; k < hs.order.length; k++) { var i = hs.order[k]; if (!hs.b[i].done && hs.b[i].strokes === 0) { g.cur = i; return i; } }
    for (var i2 = 0; i2 < hs.b.length; i2++) {
      var s = hs.b[i2];
      if (s.done) continue;
      var d = distPin(H, s.x, s.y);
      if (d > bd) { bd = d; best = i2; }
    }
    if (best >= 0) g.cur = best;
    return best;
  }
  function holeDone(g) { return g.hs.b.every(function (s) { return s.done; }); }
  // apply a finished ball to the player who hit it → a result for the UI
  function resolveShot(g, H, b) {
    var s = g.hs.b[g.cur], res = { kind: 'rest', pen: 0, gimme: false, capped: false };
    s.strokes++;
    if (b.putt) { s.putts++; g.players[g.cur].putts++; }
    if (b.st === 'holed') { res.kind = 'holed'; s.done = true; s.x = H.pin.x; s.y = H.pin.y; s.lie = GREEN; }
    else if (b.st === 'water') { var dp = dropPoint(H, b); s.x = dp.x; s.y = dp.y; s.lie = dp.lie; s.strokes++; res.kind = 'water'; res.pen = 1; }
    else {
      var l = lieAt(H, b.x, b.y);
      if (l === WATER) { var dp2 = dropPoint(H, b); s.x = dp2.x; s.y = dp2.y; s.lie = dp2.lie; s.strokes++; res.kind = 'water'; res.pen = 1; }
      else if (l === OB) { s.x = b.from.x; s.y = b.from.y; s.lie = b.from.lie; s.strokes++; res.kind = 'ob'; res.pen = 1; }
      else { s.x = b.x; s.y = b.y; s.lie = l; }
    }
    res.lie = s.lie;
    res.dist = distPin(H, s.x, s.y);
    var gm = gimmeOf(g);
    if (!s.done && s.lie === GREEN && gm > 0 && res.dist <= gm) { s.strokes++; s.done = true; res.gimme = true; s.x = H.pin.x; s.y = H.pin.y; }
    if (!s.done && s.strokes >= capOf(H.par)) { s.done = true; res.capped = true; s.strokes = capOf(H.par); }
    if (s.done) g.players[g.cur].scores[g.hi] = s.strokes;
    res.strokes = s.strokes;
    return res;
  }
  function advanceHole(g) { g.hi++; g.hs = null; if (g.hi >= g.holes.length) g.over = true; return !g.over; }
  function totals(g) {
    return g.players.map(function (p) {
      var t = 0, par = 0, n = 0;
      p.scores.forEach(function (sc, i) { if (sc) { t += sc; par += g.parOf ? g.parOf(i) : 0; n++; } });
      return { strokes: t, n: n };
    });
  }
  function snapRound(g) { return JSON.parse(JSON.stringify(g, function (k, v) { return k === 'parOf' ? undefined : v; })); }
  function loadRound(o) {
    if (!o || o.v !== 1 || !o.holes || !o.players || !o.players.length) return null;
    if (o.hi >= o.holes.length) return null;
    return o;
  }

  // ---- the tour: a field of invented pros, simulated rounds, purses ----
  var TOURS = [
    { name: 'Rookie Series', purse: 25000, skill: [0.1, 0.48], holes: 9, lvl: 0, fee: 0 },
    { name: 'Challenger Tour', purse: 120000, skill: [0.28, 0.66], holes: 9, lvl: 1 },
    { name: 'Pro Tour', purse: 650000, skill: [0.45, 0.83], holes: 18, lvl: 2 },
    { name: 'Legends Tour', purse: 2500000, skill: [0.62, 0.97], holes: 18, lvl: 3 }
  ];
  var EVENTS = 5;
  var PURSE_PCT = [18, 10.8, 6.8, 4.8, 4, 3.6, 3.35, 3.1, 2.9, 2.7, 2.5, 2.3, 2.1, 1.9, 1.8, 1.7];
  function tourField(ti) {
    var r = mulberry32(0x70f + ti * 977), T = TOURS[ti], used = {}, out = [];
    while (out.length < 15) {
      var nm = pick(r, FIRST) + ' ' + pick(r, LAST);
      if (used[nm]) continue;
      used[nm] = 1;
      out.push({ name: nm, skill: lerp(T.skill[0], T.skill[1], Math.pow(r(), 0.8)) });
    }
    return out;
  }
  function eventInfo(ti, season, ev) {
    var seed = hashStr('tour' + ti + ':' + season + ':' + ev), r = mulberry32(seed);
    var theme = THEME_IDS[(ev + season * 2 + ti) % THEME_IDS.length];
    return { seed: seed, theme: theme, name: pick(r, PLACE) + ' ' + pick(r, EV_KIND), tour: ti, season: season, ev: ev };
  }
  // one pro's hole-by-hole scores for an event (deterministic)
  function proScores(seed, pi, skill, course, holes, diff) {
    var r = mulberry32((seed ^ Math.imul(pi + 1, 0x9e3779b1)) >>> 0), s = clamp(skill + DIFFS[diff == null ? 1 : diff].cpu, 0, 1.1), out = [];
    holes.forEach(function (hi) {
      var h = course.holes[hi], hard = (h.len - (h.par === 3 ? 165 : h.par === 4 ? 390 : 535)) / 260;
      var m = 0.42 - s * 0.72 + hard * 0.35 + (h.par === 5 ? -0.18 : 0) + (h.par === 3 ? 0.05 : 0);
      var x = m + gauss(r) * 0.6, d = Math.round(x);
      d = clamp(d, h.par === 5 ? -2 : -1, 3);
      if (h.par === 3 && d === -1 && r() < 0.012 + 0.02 * s) d = -2;   // an ace!
      out.push(h.par + d);
    });
    return out;
  }
  // leaderboard after n holes: [{name, me, toPar, thru, total}]
  function leaderboard(field, scores, mine, course, holes, n) {
    var rows = field.map(function (p, i) { return { name: p.name, me: false, sc: scores[i] }; });
    rows.push({ name: 'You', me: true, sc: mine });
    rows.forEach(function (row) {
      var t = 0, par = 0, k = 0;
      for (var i = 0; i < n; i++) { var v = row.sc[i]; if (v) { t += v; par += course.holes[holes[i]].par; k++; } }
      row.total = t; row.toPar = t - par; row.thru = k;
    });
    rows.sort(function (a, b) { return a.toPar - b.toPar || b.thru - a.thru || (a.me ? -1 : b.me ? 1 : 0); });
    var pos = 1;
    rows.forEach(function (row, i) { if (i > 0 && row.toPar !== rows[i - 1].toPar) pos = i + 1; row.pos = pos; row.tie = (i > 0 && rows[i - 1].toPar === row.toPar) || (i < rows.length - 1 && rows[i + 1].toPar === row.toPar); });
    return rows;
  }
  // prize per final row: ties split the places they share
  function payouts(rows, purse) {
    var out = rows.map(function () { return 0; }), i = 0;
    while (i < rows.length) {
      var j = i; while (j + 1 < rows.length && rows[j + 1].toPar === rows[i].toPar) j++;
      var sum = 0; for (var k = i; k <= j; k++) sum += (PURSE_PCT[k] || 1.5);
      for (k = i; k <= j; k++) out[k] = Math.round(purse * sum / 100 / (j - i + 1) / 10) * 10;
      i = j + 1;
    }
    return out;
  }
  var SHOP = [
    { id: 'drv', name: 'Driver & woods', what: '+3.5% wood distance', cost: [6000, 30000, 140000] },
    { id: 'irn', name: 'Irons', what: 'wider sweet spot, +1.5% iron distance', cost: [5000, 26000, 120000] },
    { id: 'wdg', name: 'Wedges', what: '+15% backspin bite', cost: [3500, 18000, 90000] },
    { id: 'bal', name: 'Tour ball', what: '+1.5% distance, +25% spin control', cost: [3000, 16000, 80000] },
    { id: 'put', name: 'Putter', what: 'truer roll, longer break read', cost: [4000, 20000, 100000] }
  ];
  function newCareer() { return { money: 0, tour: 0, unlocked: 0, season: 1, ev: 0, stand: {}, eq: { drv: 0, irn: 0, wdg: 0, bal: 0, put: 0 }, hist: [], wins: 0, top: 0 }; }
  function englishBudget(eq) { return 1 + 0.25 * ((eq && eq.bal) || 0); }

  var ENGINE = {
    DT: DT, G: G, MPH: MPH, CUP_R: CUP_R, PUTT_MAX: PUTT_MAX, PUTTER: PUTTER,
    OB: OB, DEEP: DEEP, ROUGH: ROUGH, FAIR: FAIR, GREEN: GREEN, FRINGE: FRINGE, SAND: SAND, WATER: WATER, TEE: TEE, WASTE: WASTE,
    LIE: LIE, CLUBS: CLUBS, DIFFS: DIFFS, THEMES: THEMES, THEME_IDS: THEME_IDS, TOURS: TOURS, EVENTS: EVENTS, SHOP: SHOP,
    clamp: clamp, lerp: lerp, smooth: smooth, mulberry32: mulberry32, hashStr: hashStr, gauss: gauss, makeNoise: makeNoise, fbm: fbm,
    newCourse: newCourse, buildHole: buildHole, hAt: hAt, lieAt: lieAt, gradAt: gradAt, ellQ: ellQ, distPin: distPin, holeEnv: holeEnv, pathLen: pathLen,
    newBall: newBall, flyStep: flyStep, simCarry: simCarry, clubV0: clubV0, carryOf: carryOf, lieDist: lieDist, devFromStroke: devFromStroke, devFromMeter: devFromMeter,
    launch: launch, applyEnglish: applyEnglish, stepBall: stepBall, moving: moving, dropPoint: dropPoint, simShot: simShot, previewArc: previewArc,
    expStrokes: expStrokes, outcomeCost: outcomeCost, newPlanner: newPlanner, planStep: planStep, cpuExecute: cpuExecute, autoClub: autoClub, autoAim: autoAim, aimYaw: aimYaw,
    scoreName: scoreName, capOf: capOf, newRound: newRound, startHole: startHole, nextPlayer: nextPlayer, holeDone: holeDone, resolveShot: resolveShot, advanceHole: advanceHole,
    totals: totals, snapRound: snapRound, loadRound: loadRound, gimmeOf: gimmeOf,
    tourField: tourField, eventInfo: eventInfo, proScores: proScores, leaderboard: leaderboard, payouts: payouts, newCareer: newCareer, englishBudget: englishBudget
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('teegolf.css');

  var PANEL_ID = 'teegolf-panel', NAME = 'Tee Time Golf';
  var KEY = 'cade-teegolf-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound', ROUND_KEY = KEY + 'round';
  var LEVELS = [null, { name: 'Rookie', skill: 0.22 }, { name: 'Club pro', skill: 0.55 }, { name: 'Tour pro', skill: 0.85 }];
  var CPU_NAMES = ['Birdie Bot', 'Iron Mike', 'Sandy', 'Chip', 'Fairway Fay', 'Divot Dan'];
  var DETAIL = [{ name: 'Low', k: 0.42 }, { name: 'Medium', k: 0.6 }, { name: 'High', k: 0.85 }];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.teegolf = { live: function () { return S; } };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { if (Cade.store.remove) Cade.store.remove(k); else Cade.store.set(k, ''); } catch (e) {} }
  function newSave() {
    return {
      v: 1, set: { diff: 1, gim: -1, det: -1, holes: 18, theme: 'random', seats: [0], lvl: 2, seed: (Math.random() * 4294967296) >>> 0 },
      rec: { r9: null, r18: null, aces: 0, eagles: 0, birdies: 0, rounds: 0, holes: 0, ld: 0, ctp: null, longPutt: 0 }, car: newCareer()
    };
  }
  function normSave(o) {
    var d = newSave();
    if (!o || typeof o !== 'object') return d;
    ['set', 'rec'].forEach(function (k) { if (o[k] && typeof o[k] === 'object') for (var q in d[k]) if (o[k][q] !== undefined) d[k][q] = o[k][q]; });
    if (o.car && typeof o.car === 'object') { for (var q in d.car) if (o.car[q] !== undefined) d.car[q] = o.car[q]; for (q in d.car.eq) d.car.eq[q] = (o.car.eq && o.car.eq[q]) | 0; }
    if (!Array.isArray(d.set.seats) || !d.set.seats.length) d.set.seats = [0];
    d.set.seats = d.set.seats.slice(0, 4).map(function (v) { return clamp(v | 0, 0, 1); });
    d.set.diff = clamp(d.set.diff | 0, 0, 3); d.set.lvl = clamp(d.set.lvl | 0, 1, 3);
    return d;
  }
  function loadSave() { var raw = sget(SAVE_KEY), o = null; if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } } return { save: normSave(o), fresh: !raw }; }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function sgn(n) { return n > 0 ? '+' + n : n === 0 ? 'E' : String(n); }
  function money(n) { n = Math.round(n); return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ydft(d) { return d < 10 ? Math.max(1, Math.round(d * 3)) + ' ft' : Math.round(d) + ' yd'; }

  // ---- sound: tiny WebAudio synth, created on a user gesture, closed with the panel ----
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
  Snd.prototype.noise = function (dur, vol, type, f0, f1, delay, q) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      if (!this.nb) {
        var n = ac.sampleRate * 1.5 | 0, buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        this.nb = buf;
      }
      var t = ac.currentTime + (delay || 0), src = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = this.nb; src.loop = true;
      fl.type = type || 'lowpass'; fl.Q.value = q || 0.8;
      fl.frequency.setValueAtTime(f0 || 1000, t);
      if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + Math.min(0.03, dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(fl); fl.connect(g); g.connect(ac.destination);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; this.nb = null; } };
  function sfx(name, k) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    k = k == null ? 1 : k;
    switch (name) {
      case 'swish': s.noise(0.28, 0.05, 'bandpass', 500, 2600, 0, 1.4); break;
      case 'hit': s.tone(1400, 0.05, 'triangle', 0.08 * k, 500); s.noise(0.06, 0.06 * k, 'highpass', 2500); break;
      case 'putt': s.tone(900, 0.05, 'sine', 0.05, 600); break;
      case 'bounce': s.noise(0.08, 0.035 * k, 'lowpass', 500); break;
      case 'sand': s.noise(0.3, 0.05, 'highpass', 1800, 900); break;
      case 'splash': s.noise(0.6, 0.08, 'lowpass', 1800, 200); s.tone(320, 0.25, 'sine', 0.03, 120, 0.02); break;
      case 'tree': s.tone(240, 0.08, 'square', 0.03, 160); s.noise(0.25, 0.04, 'bandpass', 2500, 1200, 0.02); break;
      case 'cup': s.tone(660, 0.07, 'triangle', 0.05); s.tone(520, 0.07, 'triangle', 0.05, null, 0.08); s.tone(240, 0.12, 'sine', 0.06, 120, 0.16); break;
      case 'lip': s.tone(500, 0.06, 'triangle', 0.04, 700); break;
      case 'tick': s.tone(1200, 0.025, 'square', 0.015); break;
      case 'click': s.tone(988, 0.04, 'sine', 0.025); break;
      case 'spin': s.tone(500, 0.12, 'sine', 0.025, 1100); break;
      case 'clap':
        for (var i = 0; i < 26 * k; i++) s.noise(0.05, 0.02 + Math.random() * 0.03, 'bandpass', 1500 + Math.random() * 1500, null, i * 0.045 + Math.random() * 0.04, 1.2);
        break;
      case 'ooh': s.tone(330, 0.7, 'sine', 0.025, 200); s.tone(415, 0.7, 'sine', 0.015, 250, 0.03); break;
      case 'aah': s.tone(262, 0.5, 'sine', 0.02, 392); s.tone(330, 0.5, 'sine', 0.014, 494, 0.02); break;
      case 'bird': var f = 2600 + Math.random() * 1400; s.tone(f, 0.06, 'sine', 0.012, f * 1.3); s.tone(f * 1.1, 0.07, 'sine', 0.01, f * 0.8, 0.09); break;
      case 'fan': [523, 659, 784, 1047].forEach(function (f2, j) { s.tone(f2, 0.16, 'triangle', 0.04, null, j * 0.09); }); break;
      case 'meter': s.tone(700, 0.03, 'square', 0.02); break;
    }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_CARD = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 4v16M15 4v16"/>');

  // ---- theme: canvas colors follow the app theme (dark → dusk) ----
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
    S.dark = dark;
    S.col = {
      bg: bg, tx: tx, ac: ac, font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      hud: css(bg, dark ? 0.78 : 0.82), hudTx: css(tx), hudMu: css(mix(bg, tx, 0.62)), acc: css(ac), red: dark ? '#f06a6a' : '#cf3f3f', gold: dark ? '#f2c544' : '#b07d06',
      line: css(mix(bg, tx, 0.25))
    };
    S.cmKey = '';
    S.R.dirty = true;
  }
  // natural terrain colors per course theme
  var PAL0 = { 0: [62, 94, 52], 1: [52, 104, 44], 2: [70, 132, 54], 3: [96, 166, 70], 4: [112, 190, 86], 5: [100, 176, 76], 6: [228, 210, 160], 7: [52, 118, 170], 8: [104, 176, 78], 9: [206, 180, 132] };
  var PAL_T = {
    links: { 0: [138, 134, 98], 1: [164, 160, 104], 2: [120, 146, 74], 3: [140, 174, 88], 4: [126, 184, 90], 5: [132, 176, 86], 6: [220, 200, 150], 7: [58, 106, 136] },
    parkland: {},
    desert: { 0: [178, 132, 96], 1: [176, 140, 98], 2: [104, 142, 66], 6: [238, 218, 170], 7: [54, 140, 168], 9: [214, 176, 124] },
    alpine: { 0: [56, 92, 60], 1: [56, 104, 52], 7: [66, 128, 160] },
    island: { 0: [84, 130, 66], 6: [244, 234, 200], 7: [34, 158, 184] }
  };
  var SKY = {
    links: [[124, 160, 196], [206, 218, 222]], parkland: [[96, 160, 226], [200, 224, 240]], desert: [[90, 150, 214], [236, 214, 186]],
    alpine: [[70, 130, 210], [196, 222, 244]], island: [[70, 170, 230], [212, 238, 246]]
  };
  var SKY_DUSK = [[18, 22, 48], [120, 84, 110]];
  function palOf(theme) { var p = {}, t = PAL_T[theme] || {}; for (var k = 0; k <= 9; k++) p[k] = (t[k] || PAL0[k]).slice(); return p; }
  function duskify(c) { return [c[0] * 0.5 + 8, c[1] * 0.52 + 6, c[2] * 0.6 + 22]; }

  // ---- the hole's color map: lie colors, mowing stripes, noise, baked sun ----
  function buildColorMap(H) {
    var W = H.W, L = H.L, n = W * L, cr = new Uint8Array(n), cg = new Uint8Array(n), cb = new Uint8Array(n);
    var pal = palOf(H.theme), dark = S.dark, nz = makeNoise(H.n * 131 + 7), hg = H.hgt, lie = H.lie, px = H.px;
    var lx = -0.45, ly = 0.35, lz = 0.82;
    for (var y = 0; y < L; y++) {
      var row = y * W, pxy = px[y];
      for (var x = 0; x < W; x++) {
        var i = row + x, l = lie[i], c = pal[l];
        var gx = (hg[i + (x < W - 1 ? 1 : 0)] - hg[i - (x > 0 ? 1 : 0)]) * 0.5, gy = (hg[i + (y < L - 1 ? W : 0)] - hg[i - (y > 0 ? W : 0)]) * 0.5;
        var nl = Math.sqrt(gx * gx + gy * gy + 1), sh = 0.72 + 0.55 * ((-gx * lx - gy * ly + lz) / nl - 0.82) * 2.2;
        var nv = nz(x * 0.31, y * 0.31) * 0.06 + nz(x * 0.09 + 50, y * 0.09) * 0.07, m = 1 + nv;
        if (l === FAIR || l === TEE) m *= (Math.floor((y + (x - pxy) * 0.08) / 9) & 1) ? 1.05 : 0.95;
        else if (l === GREEN) m *= (Math.floor(y / 3.2) & 1) ? 1.035 : 0.965;
        else if (l === DEEP) m *= 0.92 + nz(x * 0.7, y * 0.7) * 0.12;
        else if (l === WATER) { m = 1 + nz(x * 0.15, y * 0.4) * 0.05; sh = 1; }
        else if (l === SAND || l === WASTE) m *= 1 + nz(x * 1.3, y * 1.3) * 0.04;
        if (l === OB) m *= 0.9;
        var k = m * clamp(sh, 0.45, 1.25), r = c[0] * k, g = c[1] * k, b = c[2] * k;
        if (dark) { r = r * 0.5 + 8; g = g * 0.52 + 6; b = b * 0.6 + 22; }
        cr[i] = r > 255 ? 255 : r; cg[i] = g > 255 ? 255 : g; cb[i] = b > 255 ? 255 : b;
      }
    }
    // the shadows of trees on the ground
    H.trees.forEach(function (t) {
      var sx = t.x + 0.4 * t.h * 0.5, sy = t.y - 0.35 * t.h * 0.5, rr = t.r * 0.9;
      for (var yy = Math.max(0, sy - rr | 0); yy < Math.min(L, sy + rr + 1); yy++) for (var xx = Math.max(0, sx - rr | 0); xx < Math.min(W, sx + rr + 1); xx++) {
        var d = Math.sqrt((xx - sx) * (xx - sx) + (yy - sy) * (yy - sy)) / rr;
        if (d < 1) { var j = yy * W + xx, f = 0.72 + 0.28 * d; cr[j] *= f; cg[j] *= f; cb[j] *= f; }
      }
    });
    return { r: cr, g: cg, b: cb };
  }
  // the overhead map image (green at the top)
  function buildMiniMap(H) {
    var x0 = Math.floor(H.xmin), x1 = Math.ceil(H.xmax), w = Math.ceil((x1 - x0) / 2), h = Math.ceil(H.L / 2);
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var cx = cv.getContext('2d'), im = cx.createImageData(w, h), d = im.data, cm = S.cm;
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
      var wx = x0 + xx * 2, wy = H.L - 1 - yy * 2, i = (Math.min(H.L - 1, wy) * H.W + Math.min(H.W - 1, wx)), o = (yy * w + xx) * 4;
      d[o] = cm.r[i]; d[o + 1] = cm.g[i]; d[o + 2] = cm.b[i]; d[o + 3] = 255;
    }
    cx.putImageData(im, 0, 0);
    return { cv: cv, x0: x0, w: w, h: h };
  }

  // ---- the terrain raster: per screen column, front to back, with a y-buffer ----
  var NB = 46, PZ = new Float32Array(NB);
  for (var pzi = 0; pzi < NB; pzi++) PZ[pzi] = 1.2 * Math.pow(1.155, pzi);
  function setupRaster() {
    var R = S.R, k = DETAIL[detailIdx()].k;
    var RW = Math.max(120, Math.round(S.SW * k)), RH = Math.max(90, Math.round(S.SH * k));
    if (R.RW === RW && R.RH === RH && R.tcv) return;
    R.RW = RW; R.RH = RH;
    R.f = (RW / 2) / Math.tan(Math.min(0.62, Math.atan(RH / RW * 0.85) + 0.18));
    if (!R.tcv) R.tcv = document.createElement('canvas');
    R.tcv.width = RW; R.tcv.height = RH;
    R.tctx = R.tcv.getContext('2d');
    R.img = R.tctx.createImageData(RW, RH);
    R.buf = new Uint32Array(R.img.data.buffer);
    R.yb = new Int32Array(RW);
    R.prof = new Int16Array(NB * RW);
    R.dirty = true;
  }
  function detailIdx() { var d = S.save.set.det; if (d >= 0 && d <= 2) return d; return S.coarse ? 1 : 2; }
  function renderTerrain() {
    var H = S.H, R = S.R, cam = S.cam, cm = S.cm;
    if (!H || !cm) return;
    var RW = R.RW, RH = R.RH, buf = R.buf, yb = R.yb, prof = R.prof;
    var W = H.W, Lh = H.L, hg = H.hgt, cr = cm.r, cg = cm.g, cb = cm.b, lie = H.lie;
    var sn = Math.sin(cam.yaw), cs = Math.cos(cam.yaw), f = R.f, hz = R.hz, cz = cam.z, half = RW / 2;
    var fog = R.fogc, far = R.far, fog0 = far * 0.3, grid = R.grid, gpx = H.pin.x, gpy = H.pin.y;
    var bpal = R.bpal, bnz = R.bnz, rise = R.rise, sea = H.sea, ocean = H.ocean, wcol = R.wcol, dark = S.dark;
    buf.fill(0);
    for (var i = 0; i < RW; i++) yb[i] = RH;
    var z = 0.5, dz = 0.06, bi = 0, nb = PZ[0], left = RW;
    while (z < far && left > 0) {
      var k = z / f, lat0 = (0.5 - half) * k;
      var x = cam.x + sn * z + cs * lat0, y = cam.y + cs * z - sn * lat0, dx = cs * k, dy = -sn * k;
      var inv = f / z, ft = z < fog0 ? 0 : Math.min(0.92, (z - fog0) / (far - fog0) * 1.05), fo = (ft * 256) | 0, fi = 256 - fo;
      var fr = fog[0] * fo, fg = fog[1] * fo, fb = fog[2] * fo, near = z < 24;
      for (i = 0; i < RW; i++, x += dx, y += dy) {
        var ybi = yb[i];
        if (ybi <= 0) continue;
        var h, r, g, b;
        if (x >= 0 && y >= 0 && x < W - 1 && y < Lh - 1) {
          var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, idx = yi * W + xi, fx1 = 1 - fx, fy1 = 1 - fy;
          h = (hg[idx] * fx1 + hg[idx + 1] * fx) * fy1 + (hg[idx + W] * fx1 + hg[idx + W + 1] * fx) * fy;
          var sy = ((cz - h) * inv + hz) | 0;
          if (sy >= ybi) continue;
          if (near) {
            var w00 = fx1 * fy1, w10 = fx * fy1, w01 = fx1 * fy, w11 = fx * fy;
            r = cr[idx] * w00 + cr[idx + 1] * w10 + cr[idx + W] * w01 + cr[idx + W + 1] * w11;
            g = cg[idx] * w00 + cg[idx + 1] * w10 + cg[idx + W] * w01 + cg[idx + W + 1] * w11;
            b = cb[idx] * w00 + cb[idx + 1] * w10 + cb[idx + W] * w01 + cb[idx + W + 1] * w11;
            var gr = ((((x * 3.1) | 0) * 73856093) ^ (((y * 3.1) | 0) * 19349663)) & 15;
            var gm = 0.94 + gr * 0.008; r *= gm; g *= gm; b *= gm;
          } else {
            var j = idx + (fx > 0.5 ? 1 : 0) + (fy > 0.5 ? W : 0);
            r = cr[j]; g = cg[j]; b = cb[j];
          }
          if (grid && lie[idx] === GREEN) {
            var mx = x - gpx, my = y - gpy, ax = mx - Math.round(mx), ay = my - Math.round(my);
            if ((ax < 0 ? -ax : ax) < 0.045 * (1 + z * 0.06) || (ay < 0 ? -ay : ay) < 0.045 * (1 + z * 0.06)) { r = r * 0.62 + (dark ? 60 : 255) * 0.38; g = g * 0.62 + (dark ? 90 : 255) * 0.38; b = b * 0.62 + (dark ? 70 : 255) * 0.38; }
            var band = ((h * 12) | 0) & 1;
            if (band) { r *= 0.93; g *= 0.97; b *= 0.93; }
          }
        } else {
          var cxp = x < 0 ? 0 : x > W - 1 ? W - 1 : x, cyp = y < 0 ? 0 : y > Lh - 1 ? Lh - 1 : y;
          var ox = x - cxp, oy = y - cyp, od = Math.sqrt(ox * ox + oy * oy);
          if (ocean && (x - W / 2) * ocean > 0 && oy === 0) { h = sea; r = wcol[0]; g = wcol[1]; b = wcol[2]; }
          else {
            var nv = bnz(x * 0.025, y * 0.025);
            h = hg[(cyp | 0) * W + (cxp | 0)] + od * rise + nv * R.bamp * Math.min(1, od / 60);
            var bs = 0.86 + nv * 0.14;
            r = bpal[0] * bs; g = bpal[1] * bs; b = bpal[2] * bs;
          }
          sy = ((cz - h) * inv + hz) | 0;
          if (sy >= ybi) continue;
        }
        if (fo) { r = (r * fi + fr) >> 8; g = (g * fi + fg) >> 8; b = (b * fi + fb) >> 8; }
        var c = 0xff000000 | (b << 16) | (g << 8) | r, top = sy < 0 ? 0 : sy;
        for (var p = top * RW + i, e = ybi * RW + i; p < e; p += RW) buf[p] = c;
        yb[i] = top;
        if (top === 0) left--;
      }
      while (z >= nb && bi < NB) { prof.set(yb, bi * RW); bi++; nb = PZ[bi] || 1e9; }
      z += dz; dz *= 1.021;
    }
    while (bi < NB) { prof.set(yb, bi * RW); bi++; }
    R.tctx.putImageData(R.img, 0, 0);
  }
  // the y (raster px) above which an object at depth d, column col, is not hidden by nearer ground
  function occY(col, d) {
    var R = S.R, b = 0;
    if (col < 0 || col >= R.RW) return R.RH;
    while (b < NB - 1 && PZ[b + 1] < d - 0.5) b++;
    if (PZ[b] >= d) return R.RH;
    return R.prof[b * R.RW + col];
  }
  // world → canvas px; returns false behind the camera
  var PJ = { x: 0, y: 0, d: 0, s: 0, rx: 0, ry: 0 };
  function proj(x, y, z, out) {
    var cam = S.cam, R = S.R, sn = Math.sin(cam.yaw), cs = Math.cos(cam.yaw);
    var dx = x - cam.x, dy = y - cam.y, d = dx * sn + dy * cs;
    out = out || PJ;
    if (d < 0.25) return false;
    var lat = dx * cs - dy * sn, k = R.f / d;
    out.rx = R.RW / 2 + lat * k; out.ry = R.hz + (cam.z - z) * k;
    out.x = out.rx * S.sc; out.y = out.ry * S.sc; out.d = d; out.s = k * S.sc;
    return out;
  }

  // ---- sprites: trees drawn once per theme/darkness ----
  function treeSprite(kind) {
    var key = kind + (S.dark ? 'd' : 'l');
    if (S.spr[key]) return S.spr[key];
    var cv = document.createElement('canvas'), w = 64, h = 96, c = cv.getContext('2d');
    cv.width = w; cv.height = h;
    function col(rgb, k) { var v = S.dark ? duskify(rgb) : rgb; return css([v[0] * k, v[1] * k, v[2] * k]); }
    var trunk = [104, 74, 48];
    if (kind === 'oak') {
      c.fillStyle = col(trunk, 1); c.fillRect(28, 50, 8, 46);
      [[32, 34, 26, 0.75], [20, 44, 17, 0.8], [44, 44, 17, 0.7], [32, 22, 18, 0.95], [24, 30, 14, 1.05], [41, 30, 13, 0.88]].forEach(function (q) {
        c.fillStyle = col([58, 118, 50], q[3]); c.beginPath(); c.arc(q[0], q[1], q[2], 0, 7); c.fill();
      });
    } else if (kind === 'pine') {
      c.fillStyle = col(trunk, 0.9); c.fillRect(29, 70, 6, 26);
      for (var t = 0; t < 4; t++) {
        var yb2 = 78 - t * 18, hw = 30 - t * 6;
        c.fillStyle = col([36, 96, 58], 0.8 + t * 0.08); c.beginPath(); c.moveTo(32 - hw, yb2); c.lineTo(32, yb2 - 30); c.lineTo(32 + hw, yb2); c.closePath(); c.fill();
        c.fillStyle = col([36, 96, 58], 1.05 + t * 0.05); c.beginPath(); c.moveTo(32 - hw * 0.2, yb2 - 4); c.lineTo(32, yb2 - 30); c.lineTo(32 - hw, yb2); c.closePath(); c.fill();
      }
      if (S.H && S.H.theme === 'alpine') { c.fillStyle = S.dark ? 'rgba(200,210,235,0.5)' : 'rgba(255,255,255,0.75)'; c.beginPath(); c.moveTo(26, 14); c.lineTo(32, 2); c.lineTo(38, 14); c.closePath(); c.fill(); }
    } else if (kind === 'palm') {
      c.strokeStyle = col([140, 110, 70], 1); c.lineWidth = 5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(30, 96); c.quadraticCurveTo(26, 50, 34, 24); c.stroke();
      c.strokeStyle = col([50, 130, 60], 1); c.lineWidth = 4;
      [[-1, 0.2], [1, 0.1], [-0.6, 0.7], [0.7, 0.75], [-1, -0.5], [1, -0.45], [0, -1]].forEach(function (q) {
        c.beginPath(); c.moveTo(34, 24); c.quadraticCurveTo(34 + q[0] * 18, 24 - 14 + q[1] * 4, 34 + q[0] * 28, 24 + 10 + q[1] * 12); c.stroke();
      });
    } else if (kind === 'cactus') {
      c.fillStyle = col([70, 130, 72], 1); c.strokeStyle = col([70, 130, 72], 1); c.lineCap = 'round';
      c.lineWidth = 12; c.beginPath(); c.moveTo(32, 94); c.lineTo(32, 10); c.stroke();
      c.lineWidth = 8; c.beginPath(); c.moveTo(32, 56); c.lineTo(16, 56); c.lineTo(16, 30); c.moveTo(32, 46); c.lineTo(48, 46); c.lineTo(48, 24); c.stroke();
      c.strokeStyle = col([96, 160, 92], 1); c.lineWidth = 3; c.beginPath(); c.moveTo(29, 92); c.lineTo(29, 14); c.stroke();
    } else {
      [[32, 72, 26, 0.8], [20, 76, 16, 0.9], [44, 76, 16, 0.75], [32, 62, 18, 1.0]].forEach(function (q) {
        c.fillStyle = col(S.H && S.H.theme === 'links' ? [110, 120, 50] : [70, 110, 52], q[3]); c.beginPath(); c.arc(q[0], q[1], q[2], 0, 7); c.fill();
      });
      if (S.H && S.H.theme === 'links') { c.fillStyle = S.dark ? '#9a8a30' : '#e8c830'; for (var k2 = 0; k2 < 14; k2++) c.fillRect(10 + (k2 * 37) % 44, 52 + (k2 * 13) % 30, 3, 3); }
    }
    return (S.spr[key] = cv);
  }

  // ---- per hole view setup ----
  var RISE = { links: [0.05, 4], parkland: [0.16, 6], desert: [0.12, 9], alpine: [0.45, 22], island: [0.06, 3] };
  function prepareHoleView() {
    var H = S.H, R = S.R, key = H.theme + ':' + H.n + ':' + S.g.seed + ':' + (S.dark ? 1 : 0) + ':' + H.len + ':' + H.pin.x;
    if (S.cmKey !== key) {
      S.cmKey = key;
      S.cm = buildColorMap(H);
      S.mm = buildMiniMap(H);
      S.spr = {};
    }
    var pal = palOf(H.theme), sky = S.dark ? SKY_DUSK : SKY[H.theme];
    S.sky = sky;
    var hor = sky[1];
    R.fogc = S.dark ? [hor[0] * 0.55, hor[1] * 0.55, hor[2] * 0.62] : [hor[0] * 0.92, hor[1] * 0.92, hor[2] * 0.95];
    R.far = 780;
    var bp = H.theme === 'desert' ? [168, 120, 88] : H.theme === 'links' ? [128, 126, 90] : H.theme === 'island' ? [70, 118, 64] : [44, 82, 48];
    R.bpal = S.dark ? duskify(bp) : bp;
    var wc = pal[WATER]; R.wcol = S.dark ? duskify(wc) : wc;
    R.bnz = makeNoise(H.n * 7 + 3);
    R.rise = RISE[H.theme][0]; R.bamp = RISE[H.theme][1];
    S.mnz = makeNoise(S.g.seed + H.n);
    R.dirty = true;
  }

  // ---- camera ----
  function camAim(b, yaw, putt) {
    var H = S.H, back = putt ? 4.2 : 9, up = putt ? 1.6 : 4.2;
    var x = b.x - Math.sin(yaw) * back, y = b.y - Math.cos(yaw) * back, gz = Math.max(hAt(H, x, y), hAt(H, b.x, b.y));
    return { x: x, y: y, z: gz + up, yaw: yaw, hzf: putt ? 0.2 : 0.3 };
  }
  function camTarget(b, yaw) {
    // look back at the target area from behind the landing zone
    var H = S.H, tx = S.prev && S.prev.land ? S.prev.land.x : H.pin.x, ty = S.prev && S.prev.land ? S.prev.land.y : H.pin.y;
    var x = tx - Math.sin(yaw) * 45, y = ty - Math.cos(yaw) * 45;
    return { x: x, y: y, z: Math.max(hAt(H, x, y), hAt(H, tx, ty)) + 14, yaw: yaw, hzf: 0.22 };
  }
  function setCam(c, snap) {
    var cam = S.cam;
    if (snap) { cam.x = c.x; cam.y = c.y; cam.z = c.z; cam.yaw = c.yaw; cam.hzf = c.hzf; }
    S.camGoal = c;
  }
  function stepCam(dt) {
    var cam = S.cam, g = S.camGoal;
    if (!g) return;
    var k = 1 - Math.exp(-dt * (g.k || 4));
    cam.x += (g.x - cam.x) * k; cam.y += (g.y - cam.y) * k; cam.z += (g.z - cam.z) * k;
    var dyaw = g.yaw - cam.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    cam.yaw += dyaw * k; cam.hzf += (g.hzf - cam.hzf) * k;
    var gz = hAt(S.H, cam.x, cam.y) + 1.2;
    if (cam.z < gz) cam.z = gz;
  }
  function camMoved() {
    var c = S.cam, l = S.lastCam;
    var m = Math.abs(c.x - l.x) + Math.abs(c.y - l.y) + Math.abs(c.z - l.z) * 2 + Math.abs(c.yaw - l.yaw) * 200 + Math.abs(c.hzf - l.hzf) * 300;
    return m > 0.004;
  }

  // ---- drawing ----
  function ballPos(i) {
    var g = S.g;
    if (S.ball && i === g.cur && S.ball.st !== 'rest') return S.ball;
    var s = g.hs && g.hs.b[i];
    return s ? { x: s.x, y: s.y, z: hAt(S.H, s.x, s.y), st: s.done ? 'done' : 'rest' } : null;
  }
  function draw() {
    if (!S || !S.ctx) return;
    var c = S.ctx, W = S.SW, Hh = S.SH, R = S.R;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (!S.H) { drawIdle(c); return; }
    R.hz = R.RH * S.cam.hzf;
    S.sc = W / R.RW;
    if (R.dirty || camMoved()) {
      renderTerrain(); R.dirty = false;
      var l = S.lastCam, cm = S.cam; l.x = cm.x; l.y = cm.y; l.z = cm.z; l.yaw = cm.yaw; l.hzf = cm.hzf;
    }
    drawSky(c, W, Hh);
    c.imageSmoothingEnabled = true;
    c.drawImage(R.tcv, 0, 0, W, Hh);
    drawObjects(c);
    drawOverlays(c, W, Hh);
    drawHud(c, W, Hh);
  }
  function drawIdle(c) {
    var sky = S.dark ? SKY_DUSK : SKY.parkland, gr = c.createLinearGradient(0, 0, 0, S.SH);
    gr.addColorStop(0, css(sky[0])); gr.addColorStop(0.6, css(sky[1])); gr.addColorStop(0.61, css(S.dark ? duskify(PAL0[3]) : PAL0[3])); gr.addColorStop(1, css(S.dark ? duskify(PAL0[2]) : PAL0[2]));
    c.fillStyle = gr; c.fillRect(0, 0, S.SW, S.SH);
  }
  function drawSky(c, W, Hh) {
    var R = S.R, sky = S.sky, hy = R.hz * S.sc, cam = S.cam, f = R.f * S.sc, half = W / 2;
    var gr = c.createLinearGradient(0, Math.min(0, hy - Hh), 0, Math.max(4, hy));
    gr.addColorStop(0, css(sky[0])); gr.addColorStop(1, css(sky[1]));
    c.fillStyle = gr; c.fillRect(0, 0, W, Hh);
    // sun / moon
    var sa = 0.5, rel = sa - cam.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    if (Math.abs(rel) < 1.1) {
      var sx = half + Math.tan(rel) * f, sy = hy - Math.tan(0.32) * f;
      c.fillStyle = S.dark ? 'rgba(236,232,210,0.9)' : 'rgba(255,250,220,0.85)';
      c.beginPath(); c.arc(sx, sy, Math.max(6, f * 0.035), 0, 7); c.fill();
      if (!S.dark) { c.fillStyle = 'rgba(255,250,220,0.18)'; c.beginPath(); c.arc(sx, sy, Math.max(14, f * 0.09), 0, 7); c.fill(); }
    }
    // clouds (or stars) drifting by yaw
    var nz = S.mnz;
    c.fillStyle = S.dark ? 'rgba(220,220,255,0.6)' : 'rgba(255,255,255,0.55)';
    for (var i = 0; i < 9; i++) {
      var ca = i * 0.7 + S.animT * 0.004, cr = ca - cam.yaw;
      cr = ((cr % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      if (Math.abs(cr) > 1.1) continue;
      var cx = half + Math.tan(cr) * f, cy = hy - Math.tan(0.12 + (i % 3) * 0.07) * f;
      if (cy < -20) continue;
      if (S.dark) { c.fillRect(cx, cy, 1.5, 1.5); c.fillRect(cx + 37, cy + 19, 1.2, 1.2); continue; }
      var w = f * (0.1 + (i % 4) * 0.03);
      c.beginPath(); c.ellipse(cx, cy, w, w * 0.22, 0, 0, 7); c.ellipse(cx + w * 0.35, cy - w * 0.12, w * 0.45, w * 0.2, 0, 0, 7); c.fill();
    }
    // the backdrop on the horizon
    var th = S.H.theme, base = th === 'alpine' ? [150, 168, 196] : th === 'desert' ? [190, 130, 100] : th === 'parkland' ? [90, 126, 120] : [130, 150, 160];
    if (S.dark) base = duskify(base);
    var top = hy;
    c.beginPath(); c.moveTo(0, hy + 2);
    for (var x = 0; x <= W + 4; x += 4) {
      var a = cam.yaw + Math.atan((x - half) / f), e;
      var n = nz(a * 3.2 + 10, 0.5), n2 = nz(a * 9 + 3, 2.5);
      if (th === 'alpine') e = 0.035 + Math.max(0, n * 0.11 + n2 * 0.03);
      else if (th === 'desert') e = 0.006 + (n > 0.15 ? 0.04 + n2 * 0.004 : Math.max(0, n + 0.1) * 0.08);
      else if (th === 'parkland') e = 0.012 + Math.abs(n) * 0.025 + n2 * 0.004;
      else e = 0.003 + Math.max(0, n) * 0.012;
      var y = hy - Math.tan(e) * f;
      if (y < top) top = y;
      c.lineTo(x, y);
    }
    c.lineTo(W + 4, hy + 2); c.closePath();
    var mg = c.createLinearGradient(0, top, 0, hy);
    if (th === 'alpine') { mg.addColorStop(0, S.dark ? 'rgb(170,176,210)' : 'rgb(250,252,255)'); mg.addColorStop(0.35, css(mix(base, [255, 255, 255], 0.25))); mg.addColorStop(1, css(mix(base, R.fogc, 0.5))); }
    else { mg.addColorStop(0, css(base)); mg.addColorStop(1, css(mix(base, R.fogc, 0.6))); }
    c.fillStyle = mg; c.fill();
  }
  var OBJ = [];
  function drawObjects(c) {
    var H = S.H, R = S.R, i, o, n = 0, p = PJ;
    OBJ.length = 0;
    var maxD = S.flyover ? 650 : 520;
    for (i = 0; i < H.trees.length; i++) {
      var t = H.trees[i];
      if (!proj(t.x, t.y, t.z, p) || p.d > maxD || p.rx < -60 || p.rx > R.RW + 60) continue;
      OBJ.push({ k: 0, d: p.d, x: p.x, y: p.y, s: p.s, rx: p.rx, t: t });
    }
    if (proj(H.pin.x, H.pin.y, H.pin.z, p)) OBJ.push({ k: 1, d: p.d, x: p.x, y: p.y, s: p.s, rx: p.rx });
    var g = S.g;
    if (g && g.hs) for (i = 0; i < g.players.length; i++) {
      var b = ballPos(i);
      if (!b || b.st === 'done') continue;
      if (proj(b.x, b.y, b.z + 0.07, p)) OBJ.push({ k: 2, d: p.d, x: p.x, y: p.y, s: p.s, rx: p.rx, b: b, i: i, me: i === g.cur });
    }
    OBJ.sort(function (a, b2) { return b2.d - a.d; });
    var fog0 = R.far * 0.3;
    for (n = 0; n < OBJ.length; n++) {
      o = OBJ[n];
      var occ = occY(Math.round(o.rx), o.d) * S.sc;
      if (o.k === 0) {
        var tt = o.t, spr = treeSprite(tt.k), h = tt.h * o.s, w = tt.r * 2.3 * o.s, top = o.y - h, vis = Math.min(o.y, occ) - top;
        if (h < 1.2 || vis <= 0) continue;
        c.globalAlpha = o.d > fog0 ? Math.max(0.15, 1 - (o.d - fog0) / (R.far - fog0) * 1.1) : 1;
        c.drawImage(spr, 0, 0, 64, Math.max(1, 96 * vis / h), o.x - w / 2, top, w, vis);
        c.globalAlpha = 1;
      } else if (o.k === 1) drawFlag(c, o, occ);
      else drawBall(c, o, occ);
    }
  }
  function drawFlag(c, o, occ) {
    var s = o.s, ph = 2.6 * s, top = o.y - ph, wv = Math.sin(S.animT * 4) * 0.2;
    if (o.d < 60 || S.putting) {
      var cr = Math.max(1.6, CUP_R * 2 * s);
      if (o.y < occ + 1) { c.fillStyle = S.dark ? '#020406' : '#1a1a1a'; c.beginPath(); c.ellipse(o.x, o.y, cr * 1.4, cr * 0.5 * Math.max(0.35, Math.min(1, 8 / o.d + 0.25)), 0, 0, 7); c.fill(); }
    }
    if (top >= occ) return;
    c.save();
    c.beginPath(); c.rect(0, 0, S.SW, occ); c.clip();
    c.strokeStyle = S.dark ? '#ddd' : '#fafafa'; c.lineWidth = Math.max(1, 0.06 * s);
    c.beginPath(); c.moveTo(o.x, o.y); c.lineTo(o.x, top); c.stroke();
    var fw = Math.max(5, 1.0 * s), fh = Math.max(3.5, 0.65 * s);
    c.fillStyle = S.col.red;
    c.beginPath(); c.moveTo(o.x, top); c.quadraticCurveTo(o.x + fw * 0.5, top + fh * (0.5 + wv), o.x + fw, top + fh * 0.5 + wv * fh); c.lineTo(o.x, top + fh); c.closePath(); c.fill();
    c.restore();
    if (o.d > 90 && !S.flyover) {     // a marker so a far flag can be found
      c.fillStyle = S.col.red; c.beginPath(); c.moveTo(o.x - 4, top - 10); c.lineTo(o.x + 4, top - 10); c.lineTo(o.x, top - 4); c.closePath(); c.fill();
    }
  }
  var PCOL = ['#ffffff', '#ff6b6b', '#ffd34d', '#b79cf5'];
  function drawBall(c, o, occ) {
    var b = o.b, s = o.s, r = Math.max(o.me ? 2.4 : 2, Math.min(9, 0.09 * s * (o.me ? 1.4 : 1.1)));
    var gz = hAt(S.H, b.x, b.y);
    if (b.z - gz > 0.15 && proj(b.x, b.y, gz, PJ)) {
      var sr = Math.max(1.5, r * Math.max(0.4, 1 - (b.z - gz) / 50));
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.beginPath(); c.ellipse(PJ.x, PJ.y, sr * 1.3, sr * 0.5, 0, 0, 7); c.fill();
    }
    if (o.y - r > occ && b.st === 'rest') return;
    c.fillStyle = o.i === 0 || o.me ? '#ffffff' : PCOL[o.i % 4];
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 1;
    c.beginPath(); c.arc(o.x, o.y - r * 0.6, r, 0, 7); c.fill(); c.stroke();
    if (!o.me && S.g.players.length > 1) { c.strokeStyle = PCOL[o.i % 4]; c.lineWidth = 1.5; c.beginPath(); c.arc(o.x, o.y - r * 0.6, r + 3, 0, 7); c.stroke(); }
  }
  function polyline(c, pts, step) {
    var started = false, p = PJ;
    for (var i = 0; i < pts.length; i += 3 * (step || 1)) {
      if (!proj(pts[i], pts[i + 1], pts[i + 2], p)) { started = false; continue; }
      if (!started) { c.moveTo(p.x, p.y); started = true; } else c.lineTo(p.x, p.y);
    }
  }
  function groundRing(c, x, y, rad) {
    c.beginPath();
    var ok = false;
    for (var a = 0; a <= 24; a++) {
      var t = a / 24 * Math.PI * 2, wx = x + Math.cos(t) * rad, wy = y + Math.sin(t) * rad;
      if (!proj(wx, wy, hAt(S.H, wx, wy) + 0.05, PJ)) continue;
      if (!ok) { c.moveTo(PJ.x, PJ.y); ok = true; } else c.lineTo(PJ.x, PJ.y);
    }
    c.closePath();
  }
  function drawOverlays(c, W, Hh) {
    var g = S.g, H = S.H;
    // shot tracer
    if (S.trace.length > 5 && !S.flyover) {
      c.save();
      c.strokeStyle = S.col.acc; c.lineWidth = 2.2; c.globalAlpha = S.phase2 === 'flight' ? 0.95 : 0.6; c.lineJoin = 'round';
      c.beginPath(); polyline(c, S.trace); c.stroke();
      c.restore();
    }
    // particles
    for (var i = 0; i < S.parts.length; i++) {
      var q = S.parts[i];
      if (!proj(q.x, q.y, q.z, PJ)) continue;
      var sz = Math.max(1.2, q.sz * PJ.s);
      c.globalAlpha = Math.min(1, q.life / q.max * 1.5);
      c.fillStyle = q.col; c.fillRect(PJ.x - sz / 2, PJ.y - sz / 2, sz, sz);
    }
    c.globalAlpha = 1;
    if (!g || !g.hs || S.flyover) return;
    var me = g.hs.b[g.cur], aiming = S.phase2 === 'aim' || S.phase2 === 'cpu';
    if (aiming && me && !me.done) {
      var bx = me.x, by = me.y, yaw = S.aim.yaw, ci = S.aim.club;
      if (S.putting) drawPuttAids(c, bx, by, yaw);
      else if (S.prev && S.prev.pts.length) {
        var pv = S.prev;
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 2; c.setLineDash([3, 6]);
        c.beginPath(); polyline(c, pv.pts); c.stroke();
        c.setLineDash([]);
        if (pv.land) {
          c.strokeStyle = S.col.acc; c.lineWidth = 2;
          groundRing(c, pv.land.x, pv.land.y, Math.max(2.5, pv.carry * 0.03)); c.stroke();
          groundRing(c, pv.land.x, pv.land.y, 0.8); c.fillStyle = S.col.acc; c.fill();
          if (proj(pv.land.x, pv.land.y, hAt(H, pv.land.x, pv.land.y) + 2.5, PJ)) {
            label(c, Math.round(pv.carry) + 'y', PJ.x, PJ.y - 6, 'center');
          }
        }
        c.restore();
      }
    }
    // the swing gesture trail
    var sw = S.sw;
    if (sw && sw.pts.length > 1) {
      c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
      c.strokeStyle = sw.phase === 'up' ? S.col.acc : 'rgba(255,255,255,0.7)'; c.lineWidth = 4; c.globalAlpha = 0.8;
      c.beginPath();
      for (i = Math.max(0, sw.pts.length - 60); i < sw.pts.length; i++) { var pt = sw.pts[i]; if (i === Math.max(0, sw.pts.length - 60)) c.moveTo(pt.x, pt.y); else c.lineTo(pt.x, pt.y); }
      c.stroke(); c.restore();
      var tip = sw.pts[sw.pts.length - 1], txt;
      if (S.aim.club === PUTTER) txt = ydft(sw.back / puttFull() * PUTT_MAX * (me && me.lie === FRINGE ? 1.1 : 1));
      else txt = sw.phase === 'up' ? 'UP!' : 'pull back';
      label(c, txt, tip.x, tip.y - 22, 'center');
    }
  }
  // putting: slope arrows on the green, the aim line and a short read of the break
  function drawPuttAids(c, bx, by, yaw) {
    var H = S.H, pin = H.pin, gr = [0, 0], rad = Math.min(16, Math.max(6, distPin(H, bx, by) + 3)), cx = (bx + pin.x) / 2, cy = (by + pin.y) / 2;
    c.save();
    c.lineWidth = 1.5;
    for (var y = Math.floor(cy - rad); y <= cy + rad; y += 1.5) for (var x = Math.floor(cx - rad); x <= cx + rad; x += 1.5) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad || lieAt(H, x, y) !== GREEN) continue;
      gradAt(H, x, y, gr);
      var m = Math.sqrt(gr[0] * gr[0] + gr[1] * gr[1]);
      if (m < 0.002) continue;
      var L = Math.min(0.9, m * 22), ux = -gr[0] / m, uy = -gr[1] / m, z0 = hAt(H, x, y) + 0.03;
      if (!proj(x, y, z0, PJ)) continue;
      var ax = PJ.x, ay = PJ.y;
      if (!proj(x + ux * L, y + uy * L, z0, PJ)) continue;
      var t = Math.min(1, m / 0.04);
      c.strokeStyle = 'rgba(' + Math.round(255) + ',' + Math.round(255 - t * 150) + ',' + Math.round(255 - t * 200) + ',0.8)';
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(PJ.x, PJ.y);
      var hx = PJ.x - ax, hy = PJ.y - ay, hl = Math.sqrt(hx * hx + hy * hy) || 1;
      c.moveTo(PJ.x, PJ.y); c.lineTo(PJ.x - hx / hl * 4 + hy / hl * 2.5, PJ.y - hy / hl * 4 - hx / hl * 2.5);
      c.stroke();
    }
    // aim line + the read
    var eq = S.eq || {}, pw = S.sw && S.sw.back ? clamp(S.sw.back / puttFull(), 0.02, 1) : S.meter.st ? S.meter.v : Math.min(1, distPin(H, bx, by) / PUTT_MAX);
    var from = { x: bx, y: by, lie: S.g.hs.b[S.g.cur].lie }, env = S.env;
    var b = launch(H, from, { club: PUTTER, yaw: yaw, power: pw, dev: 0 }, eq, env, null), pts = [], frac = 0.3 + 0.18 * (eq.put || 0);
    var total = 0, maxLen = pw * PUTT_MAX * frac;
    for (var k = 0; k < 2400 && b.st === 'roll' && total < maxLen; k++) {
      var ox = b.x, oy = b.y; stepBall(H, b, env); total += Math.sqrt((b.x - ox) * (b.x - ox) + (b.y - oy) * (b.y - oy));
      if (k % 4 === 0) pts.push(b.x, b.y, b.z + 0.03);
    }
    c.strokeStyle = S.col.acc; c.lineWidth = 2.5; c.setLineDash([]);
    c.beginPath(); polyline(c, pts); c.stroke();
    var ex = bx + Math.sin(yaw) * pw * PUTT_MAX, ey = by + Math.cos(yaw) * pw * PUTT_MAX;
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1.5; c.setLineDash([2, 5]);
    c.beginPath(); var st = false;
    for (var q = 0; q <= 16; q++) { var wx = bx + (ex - bx) * q / 16, wy = by + (ey - by) * q / 16; if (!proj(wx, wy, hAt(H, wx, wy) + 0.03, PJ)) continue; if (!st) { c.moveTo(PJ.x, PJ.y); st = true; } else c.lineTo(PJ.x, PJ.y); }
    c.stroke(); c.setLineDash([]);
    c.restore();
  }
  function label(c, txt, x, y, align, big) {
    c.font = (big ? '700 15px ' : '700 11px ') + S.col.font;
    c.textAlign = align || 'left'; c.textBaseline = 'middle';
    var w = c.measureText(txt).width, pad = 4, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    c.fillStyle = S.col.hud; roundRect(c, x0 - pad, y - (big ? 11 : 8), w + pad * 2, big ? 22 : 16, 4); c.fill();
    c.fillStyle = S.col.hudTx; c.fillText(txt, x, y + 0.5);
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function panel(c, x, y, w, h) { c.fillStyle = S.col.hud; roundRect(c, x, y, w, h, 6); c.fill(); }
  // the canvas HUD: wind, map, club/lie, distance, meters and callouts
  function drawHud(c, W, Hh) {
    var g = S.g, H = S.H, font = S.col.font, sm = W < 420;
    if (!g || !g.hs) return;
    c.textBaseline = 'middle';
    // wind
    var wx = 8, wy = 8, ww = sm ? 64 : 76, wh = sm ? 50 : 56;
    panel(c, wx, wy, ww, wh);
    c.fillStyle = S.col.hudMu; c.font = '700 9px ' + font; c.textAlign = 'center';
    c.fillText('WIND', wx + ww / 2, wy + 9);
    var rel = H.wind.ang - S.cam.yaw, acx = wx + ww / 2, acy = wy + wh / 2 + 3, al = H.wind.mph ? 11 : 0;
    c.save(); c.translate(acx, acy); c.rotate(rel);
    c.strokeStyle = S.col.acc; c.fillStyle = S.col.acc; c.lineWidth = 2.5;
    if (al) { c.beginPath(); c.moveTo(0, al); c.lineTo(0, -al + 4); c.stroke(); c.beginPath(); c.moveTo(0, -al - 2); c.lineTo(-5, -al + 5); c.lineTo(5, -al + 5); c.closePath(); c.fill(); }
    c.restore();
    c.fillStyle = S.col.hudTx; c.font = '700 11px ' + font;
    c.fillText(H.wind.mph + ' mph', wx + ww / 2, wy + wh - 8);
    // minimap
    drawMini(c, W, Hh);
    if (S.flyover) {
      label(c, 'HOLE ' + (g.hi + 1) + ' · PAR ' + H.par + ' · ' + H.len + ' YDS', W / 2, Hh - 40, 'center', true);
      label(c, H.name, W / 2, Hh - 16, 'center');
      drawCallout(c, W, Hh);
      return;
    }
    var me = g.hs.b[g.cur];
    if (me && !me.done && (S.phase2 === 'aim' || S.phase2 === 'cpu' || S.phase2 === 'swing')) {
      var cl = CLUBS[S.aim.club], car = cl.putt ? '' : ' ' + Math.round(carryOf(S.aim.club, S.eq) * lieDist(S.aim.club, me.lie)) + 'y';
      var d = distPin(H, me.x, me.y), dz = H.pin.z - hAt(H, me.x, me.y);
      var bl = 8, bt = Hh - (sm ? 46 : 50);
      panel(c, bl, bt, sm ? 132 : 150, sm ? 38 : 42);
      c.textAlign = 'left'; c.fillStyle = S.col.hudTx; c.font = '700 ' + (sm ? 12 : 13) + 'px ' + font;
      c.fillText(cl.name + car + (S.aim.auto ? '' : ' ·'), bl + 7, bt + 12);
      c.fillStyle = S.col.hudMu; c.font = '600 ' + (sm ? 10 : 11) + 'px ' + font;
      c.fillText(LIE[me.lie].name + (lieDist(S.aim.club, me.lie) < 0.99 && !cl.putt ? ' −' + Math.round((1 - lieDist(S.aim.club, me.lie)) * 100) + '%' : ''), bl + 7, bt + (sm ? 27 : 30));
      var rw = sm ? 92 : 108, rl = W - 8 - rw;
      panel(c, rl, bt, rw, sm ? 38 : 42);
      c.textAlign = 'right'; c.fillStyle = S.col.hudTx; c.font = '700 ' + (sm ? 13 : 14) + 'px ' + font;
      c.fillText((S.putting ? ydft(d) : Math.round(d) + ' yd'), rl + rw - 7, bt + 12);
      c.fillStyle = S.col.hudMu; c.font = '600 ' + (sm ? 10 : 11) + 'px ' + font;
      c.fillText(Math.abs(dz) < 0.3 ? 'level' : (dz > 0 ? '▲ ' : '▼ ') + (S.putting ? Math.round(Math.abs(dz) * 36) + ' in' : Math.abs(dz).toFixed(0) + ' yd'), rl + rw - 7, bt + (sm ? 27 : 30));
    }
    if (S.phase2 === 'flight' && S.ball) {
      var b = S.ball, from = b.from, dd = Math.sqrt((b.x - from.x) * (b.x - from.x) + (b.y - from.y) * (b.y - from.y));
      label(c, (S.ball.putt ? ydft(dd) : Math.round(dd) + ' yd') + (b.st === 'fly' ? ' · ' + Math.round(b.z - hAt(H, b.x, b.y)) + 'y up' : ''), 8, Hh - 18, 'left');
      if (b.st === 'fly' && !b.putt && !isCpu()) drawEnglish(c, W, Hh);
    }
    drawMeter(c, W, Hh);
    drawCallout(c, W, Hh);
  }
  function drawEnglish(c, W, Hh) {
    var rem = S.eng.left / S.eng.max, x = W - 118, y = Hh - 30, w = 110;
    panel(c, x, y - 12, w, 26);
    c.fillStyle = S.col.hudMu; c.font = '700 9px ' + S.col.font; c.textAlign = 'left';
    c.fillText('SPIN', x + 6, y + 1);
    c.fillStyle = S.col.line; c.fillRect(x + 34, y - 3, w - 42, 7);
    c.fillStyle = S.col.acc; c.fillRect(x + 34, y - 3, (w - 42) * rem, 7);
  }
  function drawMini(c, W, Hh) {
    var mm = S.mm, H = S.H;
    if (!mm) return;
    var mh = Math.min(Hh * (S.bigMap ? 0.92 : 0.34), S.bigMap ? 9999 : 190), mw = mm.w / mm.h * mh;
    var maxW = W * (S.bigMap ? 0.9 : 0.24);
    if (mw > maxW) { mh *= maxW / mw; mw = maxW; }
    var x = S.bigMap ? (W - mw) / 2 : W - mw - 8, y = S.bigMap ? (Hh - mh) / 2 : 8, k = mw / (mm.w * 2);
    S.mmRect = { x: x, y: y, w: mw, h: mh, k: k };
    c.save();
    c.fillStyle = S.col.hud; roundRect(c, x - 3, y - 3, mw + 6, mh + 6, 6); c.fill();
    c.imageSmoothingEnabled = true;
    c.drawImage(mm.cv, x, y, mw, mh);
    function MX(wx) { return x + (wx - mm.x0) * k; }
    function MY(wy) { return y + (H.L - 1 - wy) * k; }
    var g = S.g;
    // aim line + landing
    if (g && g.hs) {
      var me = g.hs.b[g.cur];
      if (me && !me.done && (S.phase2 === 'aim' || S.phase2 === 'cpu')) {
        var reach = S.putting ? 8 : S.prev && S.prev.land ? S.prev.carry : 150;
        c.strokeStyle = '#fff'; c.lineWidth = 1.2; c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(MX(me.x), MY(me.y)); c.lineTo(MX(me.x + Math.sin(S.aim.yaw) * reach), MY(me.y + Math.cos(S.aim.yaw) * reach)); c.stroke();
        c.setLineDash([]);
      }
      if (S.trace.length > 5) { c.strokeStyle = S.col.acc; c.lineWidth = 1.5; c.beginPath(); for (var i = 0; i < S.trace.length; i += 9) { var tx = MX(S.trace[i]), ty = MY(S.trace[i + 1]); if (i === 0) c.moveTo(tx, ty); else c.lineTo(tx, ty); } c.stroke(); }
      for (i = g.players.length - 1; i >= 0; i--) {
        var bp = ballPos(i);
        if (!bp || bp.st === 'done') continue;
        c.fillStyle = PCOL[i % 4]; c.strokeStyle = '#000'; c.lineWidth = 1;
        c.beginPath(); c.arc(MX(bp.x), MY(bp.y), i === g.cur ? 3.2 : 2.4, 0, 7); c.fill(); c.stroke();
      }
    }
    c.fillStyle = S.col.red; c.fillRect(MX(H.pin.x) - 1, MY(H.pin.y) - 7, 2, 7); c.fillRect(MX(H.pin.x), MY(H.pin.y) - 7, 5, 3);
    if (S.bigMap) {
      c.fillStyle = S.col.hudTx; c.font = '700 12px ' + S.col.font; c.textAlign = 'center';
      label(c, 'tap the map to aim · M closes', W / 2, y + mh - 14, 'center');
    }
    c.restore();
  }
  function drawMeter(c, W, Hh) {
    var m = S.meter;
    if (!m.st && !(S.lastMeter && S.animT - S.lastMeter.t < 1.2)) return;
    var mr = S.mmRect, yTop = (mr ? mr.y + mr.h + 22 : 30), yBot = Hh - 66, bh = Math.min(220, Math.max(70, yBot - yTop));
    var mm = m.st ? m : S.lastMeter, bw = 16, x = W - bw - 16, y0 = Math.min(yBot, yTop + bh), putt = S.aim.club === PUTTER;
    var top = 1.15, bot = -0.15, Y = function (v) { return y0 - (v - bot) / (top - bot) * bh; };
    panel(c, x - 6, Y(top) - 8, bw + 12, bh + 16);
    c.fillStyle = S.col.line; c.fillRect(x, Y(top), bw, bh);
    var gr = c.createLinearGradient(0, Y(0), 0, Y(1));
    gr.addColorStop(0, '#3fae5a'); gr.addColorStop(0.75, '#e2c23a'); gr.addColorStop(1, '#e0603a');
    c.fillStyle = gr; c.fillRect(x, Y(1), bw, Y(0) - Y(1));
    c.fillStyle = S.col.red; c.fillRect(x, Y(top), bw, Y(1) - Y(top));
    var tol = DIFFS[S.g.diff].tol * 0.011;
    c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillRect(x - 3, Y(tol), bw + 6, Y(-tol) - Y(tol));
    c.fillStyle = '#fff'; c.fillRect(x - 4, Y(0) - 1, bw + 8, 2);
    if (mm.pow != null) { c.fillStyle = S.col.hudTx; c.fillRect(x - 6, Y(mm.pow) - 1.5, bw + 12, 3); }
    c.fillStyle = S.col.acc; c.fillRect(x - 6, Y(mm.v) - 2, bw + 12, 4);
    c.textAlign = 'right'; c.font = '700 11px ' + S.col.font;
    var pv = mm.pow != null ? mm.pow : mm.v;
    label(c, putt ? ydft(Math.max(0, pv) * PUTT_MAX) : Math.round(Math.max(0, pv) * 100) + '%', x - 10, Y(Math.max(0, pv)), 'right');
  }
  function drawCallout(c, W, Hh) {
    var m = S.msg;
    if (!m) return;
    var t = m.t / m.dur, a = t < 0.12 ? t / 0.12 : t > 0.8 ? (1 - t) / 0.2 : 1, sc = t < 0.12 ? 0.6 + 0.4 * (t / 0.12) : 1;
    c.save(); c.globalAlpha = Math.max(0, a);
    c.translate(W / 2, Hh * 0.3); c.scale(sc, sc);
    c.font = '800 ' + (W < 420 ? 22 : 28) + 'px ' + S.col.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    var tw = c.measureText(m.text).width;
    c.fillStyle = S.col.hud; roundRect(c, -tw / 2 - 14, -22, tw + 28, m.sub ? 60 : 44, 10); c.fill();
    c.fillStyle = m.col || S.col.acc; c.fillText(m.text, 0, 0);
    if (m.sub) { c.font = '600 12px ' + S.col.font; c.fillStyle = S.col.hudTx; c.fillText(m.sub, 0, 24); }
    c.restore();
  }

  // ---- fx: world-space particles and callouts ----
  function spawn(x, y, z, n, kind) {
    var cols = kind === 'sand' ? ['#e8d6a0', '#d9c48a', '#f2e6c0'] : kind === 'water' ? ['#ffffff', '#cfe8ff', '#9fd0f5'] : kind === 'leaf' ? ['#3f8a3a', '#5aa64a', '#2f6e2c'] :
      kind === 'conf' ? ['#ff6b6b', '#ffd34d', '#6bd3ff', '#9df27a', '#d49bff'] : ['#5aa64a', '#7a5a38', '#4a8a3a'];
    for (var i = 0; i < n && S.parts.length < 260; i++) {
      var a = Math.random() * Math.PI * 2, sp = kind === 'conf' ? 2 + Math.random() * 5 : 1 + Math.random() * (kind === 'water' ? 4 : 3);
      S.parts.push({ x: x, y: y, z: z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: (kind === 'conf' ? 6 : 3) + Math.random() * (kind === 'water' ? 7 : 4), life: 0.8 + Math.random() * (kind === 'conf' ? 1.6 : 0.7), max: 1.6, sz: kind === 'conf' ? 0.18 : kind === 'leaf' ? 0.22 : 0.12, col: cols[i % cols.length], g: kind === 'conf' ? 3 : kind === 'leaf' ? 2.5 : 10 });
    }
  }
  function stepFx(dt) {
    for (var i = S.parts.length - 1; i >= 0; i--) {
      var q = S.parts[i];
      q.life -= dt;
      if (q.life <= 0) { S.parts.splice(i, 1); continue; }
      q.vz -= q.g * dt; q.vx *= 0.985; q.vy *= 0.985;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      var gz = hAt(S.H, q.x, q.y);
      if (q.z < gz) { q.z = gz; q.vz = 0; q.vx *= 0.5; q.vy *= 0.5; }
    }
    var m = S.msg;
    if (m) { m.t += dt; if (m.t >= m.dur) S.msg = S.msgQ.length ? S.msgQ.shift() : null; }
  }
  function say(text, sub, col, dur, queue) {
    var m = { text: text, sub: sub || '', col: col, t: 0, dur: dur || 1.6 };
    if (queue && S.msg) S.msgQ.push(m); else { S.msg = m; S.msgQ.length = 0; }
    live(text + (sub ? '. ' + sub : ''));
  }
  function live(t) { if (S && S.liveEl) S.liveEl.textContent = t; }

  // ---- round flow ----
  function isCpu() { return !!(S.g && S.g.players[S.g.cur] && S.g.players[S.g.cur].cpu); }
  function humans() { var n = 0; S.g.players.forEach(function (p) { if (!p.cpu) n++; }); return n; }
  function courseOf(g) {
    if (!S.course || S.course.seed !== g.seed || S.course.theme !== g.theme || S.course.lvl !== g.lvl) S.course = newCourse(g.seed, g.theme, g.lvl);
    if (!THEMES[g.theme]) g.theme = S.course.theme;
    return S.course;
  }
  function parOf(g, i) {
    if (g.ch) return g.ch.kind === 'ctp' ? 3 : 5;
    return courseOf(g).holes[g.holes[i]].par;
  }
  function holeOpts(g) {
    if (!g.ch) return null;
    if (g.ch.kind === 'ctp') {
      var r = mulberry32(hashStr(g.seed + ':ctp:' + g.hi));
      return { par: 3, len: Math.round(95 + r() * 110), name: 'Shot ' + (g.hi + 1) + ' of ' + g.holes.length, tee: 1 };
    }
    return { par: 5, len: 600, straight: true, noWater: true, tee: 1, name: 'Ball ' + (g.hi + 1) + ' of ' + g.holes.length, fwMul: 1.6 };
  }
  function buildCurrent() {
    var g = S.g, course = courseOf(g), hi = g.holes[g.hi], o = holeOpts(g), key = g.seed + ':' + g.theme + ':' + g.lvl + ':' + hi + ':' + g.diff + ':' + (o ? JSON.stringify(o) : '');
    if (S.hKey !== key) { S.H = buildHole(course, hi, g.diff, o || undefined); S.hKey = key; }
    S.H.cseed = g.seed;
    return S.H;
  }
  function startRound(cfg) {
    S.g = newRound(cfg);
    if (!S.g.theme) S.g.theme = courseOf(S.g).theme;
    enterHole(false);
  }
  function resumeRound(o) {
    S.g = o;
    S.resume = null;
    enterHole(true);
  }
  function enterHole(resumed) {
    var g = S.g;
    buildCurrent();
    S.env = holeEnv(S.H, g.diff);
    prepareHoleView();
    if (!resumed || !g.hs) startHole(g, S.H);
    S.trace = []; S.parts = []; S.ball = null; S.msg = null; S.msgQ.length = 0; S.bigMap = false;
    S.phase = 'play'; S.paused = false;
    showCard(null);
    syncHud(); syncHead();
    if (resumed || g.ch) { beginTurn(true); if (g.ch && !resumed) say(S.H.name, g.ch.kind === 'ctp' ? S.H.len + ' yards to the pin' : 'Driver only — stay in the grid', null, 2); }
    else startFlyover();
    kick();
  }
  function startFlyover() {
    var H = S.H;
    S.flyover = { t: 0, dur: S.rm ? 1.2 : 3.4 };
    S.phase2 = 'flyover';
    setPad('skip');
    stepFlyover(0);
    S.cam.x = S.camGoal.x; S.cam.y = S.camGoal.y; S.cam.z = S.camGoal.z; S.cam.yaw = S.camGoal.yaw; S.cam.hzf = S.camGoal.hzf;
    sfx('aah');
    live('Hole ' + (S.g.hi + 1) + ', ' + H.name + ', par ' + H.par + ', ' + H.len + ' yards');
  }
  function stepFlyover(dt) {
    var F = S.flyover, H = S.H;
    F.t += dt;
    var s = clamp(F.t / F.dur, 0, 1), e = s * s * (3 - 2 * s);
    var y0 = H.tee.y - 12, y1 = Math.max(y0 + 10, H.pin.y - 75), y = lerp(y0, y1, e), yi = clamp(y | 0, 0, H.L - 41);
    var ahead = Math.min(H.L - 2, yi + 60), yaw = Math.atan2(lerp(H.px[ahead], H.pin.x, e) - H.px[yi], lerp(ahead, H.pin.y, e) - y);
    var c = { x: H.px[yi], y: y, z: hAt(H, H.px[yi], y) + lerp(55, 20, e), yaw: yaw, hzf: lerp(0.18, 0.27, e), k: 30 };
    S.camGoal = c;
    if (dt === 0) return;
    S.cam.x = c.x; S.cam.y = c.y; S.cam.z = c.z; S.cam.yaw = c.yaw; S.cam.hzf = c.hzf;
    if (F.t >= F.dur) endFlyover();
  }
  function endFlyover() { if (!S.flyover) return; S.flyover = null; beginTurn(true); }
  function beginTurn(snap) {
    var g = S.g, H = S.H;
    if (holeDone(g)) { finishHole(); return; }
    nextPlayer(g, H);
    var s = g.hs.b[g.cur], p = g.players[g.cur];
    S.eq = p.cpu ? {} : (g.eq || {});
    S.aim.club = g.ch && g.ch.kind === 'drive' ? 0 : autoClub(H, s, S.eq);
    S.aim.auto = true;
    S.aim.yaw = autoAim(H, s, S.aim.club, S.eq);
    S.view = 0;
    syncPutting();
    S.ball = null; S.meter.st = 0; S.sw = null; S.cpuShot = null; S.plan = null;
    S.phase2 = p.cpu ? 'cpu' : 'aim';
    var cg = camAim(s, S.aim.yaw, S.putting); cg.k = 3;
    setCam(cg, !!snap);
    if (p.cpu) { S.plan = newPlanner(H, s, S.eq, S.env, LEVELS[p.cpu] ? LEVELS[p.cpu].skill : 0.5); S.cpuT = 0; S.waitTxt = p.name + ' is lining up…'; setPad('wait'); }
    else setPad('aim');
    if (g.players.length > 1 && !p.cpu) say(p.name + (humans() > 1 ? ' — your shot' : ' to play'), Math.round(distPin(H, s.x, s.y)) + ' yd · ' + LIE[s.lie].name, PCSS(g.cur), 1.3);
    syncHud();
    saveRound();
  }
  function PCSS(i) { return i === 0 ? S.col.acc : PCOL[i % 4]; }
  function syncPutting() {
    S.putting = S.aim.club === PUTTER;
    S.R.grid = S.putting;
    S.R.dirty = true;
    updatePreview();
  }
  function updatePreview() {
    var g = S.g, s = g && g.hs && g.hs.b[g.cur];
    if (!s || S.putting) { S.prev = null; return; }
    S.prev = previewArc(S.H, s, S.aim.club, S.aim.yaw, S.eq, S.env, S.prevPts);
  }
  function aimChanged() {
    var g = S.g, s = g.hs.b[g.cur];
    updatePreview();
    var c = S.view ? camTarget(s, S.aim.yaw) : camAim(s, S.aim.yaw, S.putting);
    c.k = 14; setCam(c, false);
  }
  function setClub(ci) {
    if (S.g.ch && S.g.ch.kind === 'drive') return;
    S.aim.club = (ci + CLUBS.length) % CLUBS.length;
    S.aim.auto = false;
    var was = S.putting;
    syncPutting();
    if (was !== S.putting) { var s = S.g.hs.b[S.g.cur]; var c = camAim(s, S.aim.yaw, S.putting); c.k = 5; setCam(c, false); }
    else aimChanged();
    sfx('tick');
    syncPad();
  }
  function canSwing() { return S && S.phase === 'play' && !S.paused && S.phase2 === 'aim' && !S.bigMap && S.g && S.g.hs && !isCpu(); }
  // fire the human's shot
  function strike(power, dev) {
    var g = S.g;
    strikeShot({ club: S.aim.club, yaw: S.aim.yaw, power: power, dev: dev });
    if (CLUBS[S.aim.club].putt) return;
    if (power > 1.02) say('OVERSWING', Math.round(power * 100) + '% — hang on', S.col.red, 1.2);
    else if (Math.abs(dev) < 0.05 && power > 0.9) say('PURE!', Math.round(power * 100) + '% power', null, 1.1);
    else if (dev > 0.5) say(dev > 1 ? 'SLICE' : 'FADE', Math.round(power * 100) + '% power', S.col.gold, 1.1);
    else if (dev < -0.5) say(dev < -1 ? 'HOOK' : 'DRAW', Math.round(power * 100) + '% power', S.col.gold, 1.1);
    else say(Math.round(power * 100) + '%', '', null, 0.9);
    g = null;
  }
  function strikeShot(shot) {
    var g = S.g, s = g.hs.b[g.cur], H = S.H;
    S.ball = launch(H, s, shot, S.eq, S.env, Math.random);
    S.shot = shot;
    S.trace = [S.ball.x, S.ball.y, S.ball.z + 0.05]; S.traceN = 0; S.acc = 0;
    S.phase2 = 'flight'; S.flightYaw = shot.yaw; S.sw = null; S.meter.st = 0; S.bigMap = false;
    S.eng = { left: englishBudget(S.eq), max: englishBudget(S.eq) };
    var putt = !!S.ball.putt;
    S.R.grid = putt; S.R.dirty = true;
    sfx(putt ? 'putt' : 'hit', Math.min(1.2, shot.power + 0.2));
    if (!putt) {
      sfx('swish');
      var gz = hAt(H, s.x, s.y);
      if (s.lie === SAND) { spawn(s.x, s.y, gz, 26, 'sand'); sfx('sand'); }
      else if (s.lie !== TEE && s.lie !== GREEN) spawn(s.x, s.y, gz, 10, 'divot');
      if (Cade.haptic) try { Cade.haptic(12); } catch (e) {}
    }
    setPad(isCpu() ? 'wait' : putt ? 'wait' : 'flight');
    if (putt) S.waitTxt = 'rolling…';
  }
  function applyEng(side, top) {
    var b = S.ball;
    if (!b || b.st !== 'fly' || b.land || b.putt || isCpu() || S.eng.left <= 0.01) return;
    var mag = Math.abs(side) + Math.abs(top);
    if (mag < 0.05) return;
    if (mag > S.eng.left) { side *= S.eng.left / mag; top *= S.eng.left / mag; mag = S.eng.left; }
    applyEnglish(b, side, top);
    S.eng.left -= mag;
    sfx('spin');
    var t = Math.abs(side) > Math.abs(top) ? (side < 0 ? '↶ CURVE LEFT' : 'CURVE RIGHT ↷') : top > 0 ? '↑ TOPSPIN' : '↓ BACKSPIN';
    say(t, '', S.col.gold, 0.7);
  }
  function handleEvents(b) {
    if (!b.ev.length) return;
    var H = S.H;
    for (var i = 0; i < b.ev.length; i++) {
      var e = b.ev[i], gz = hAt(H, b.x, b.y);
      if (e === 'bounce' || e === 'land') { if (!b.putt) sfx('bounce', Math.min(1, Math.abs(b.vz) / 8 + 0.3)); if (e === 'land' && lieAt(H, b.x, b.y) !== SAND && lieAt(H, b.x, b.y) !== WATER) spawn(b.x, b.y, gz, 4, 'divot'); }
      else if (e === 'sand') { spawn(b.x, b.y, gz, 22, 'sand'); sfx('sand'); }
      else if (e === 'splash') { spawn(b.x, b.y, gz, 34, 'water'); sfx('splash'); S.shake = 0.2; }
      else if (e === 'tree') { spawn(b.x, b.y, b.z, 16, 'leaf'); sfx('tree'); say('TIMBER!', 'clipped a tree', S.col.gold, 1); }
      else if (e === 'cup') { sfx('cup'); }
      else if (e === 'lip') { sfx('lip'); say('LIP OUT', '', S.col.red, 1); sfx('ooh'); }
    }
    b.ev.length = 0;
  }
  function stepFlight(dt) {
    var b = S.ball, H = S.H, env = S.env;
    S.acc = Math.min(S.acc + dt, 0.25);
    while (S.acc >= DT && moving(b)) {
      stepBall(H, b, env);
      handleEvents(b);
      if (++S.traceN % 4 === 0 && S.trace.length < 3000) S.trace.push(b.x, b.y, b.z + 0.05);
      S.acc -= DT;
    }
    // chase camera
    var fy = S.flightYaw, gz = hAt(H, b.x, b.y), c;
    if (b.putt) c = { x: b.x - Math.sin(fy) * 4.5, y: b.y - Math.cos(fy) * 4.5, z: gz + 1.7, yaw: fy, hzf: 0.2, k: 3 };
    else if (b.st === 'fly') {
      var back = 12 + Math.min(14, b.t * 3);
      c = { x: b.x - Math.sin(fy) * back, y: b.y - Math.cos(fy) * back, z: Math.max(b.z * 0.75 + 4, gz + 5), yaw: fy, hzf: 0.32, k: 2.6 };
    } else c = { x: b.x - Math.sin(fy) * 11, y: b.y - Math.cos(fy) * 11, z: gz + 4.5, yaw: fy, hzf: 0.3, k: 2 };
    S.camGoal = c;
    if (!moving(b)) { S.trace.push(b.x, b.y, b.z + 0.05); ballStopped(); }
  }
  // the ball has come to rest: rules, callouts, records
  function ballStopped() {
    var g = S.g, b = S.ball, H = S.H, from = b.from, p = g.players[g.cur];
    var carry = b.land ? Math.sqrt((b.land.x - from.x) * (b.land.x - from.x) + (b.land.y - from.y) * (b.land.y - from.y)) : 0;
    var total = Math.sqrt((b.x - from.x) * (b.x - from.x) + (b.y - from.y) * (b.y - from.y));
    S.phase2 = 'settle'; S.settleT = 0; S.settleDur = p.cpu ? 1.5 : 1.35;
    if (g.ch) { challengeShot(b, total); return; }
    var fromLie = from.lie, res = resolveShot(g, H, b), par = H.par, rec = S.save.rec;
    if (res.kind === 'holed') {
      var nm = scoreName(res.strokes, par), d = res.strokes - par;
      say(nm.toUpperCase() + '!', b.putt ? ydft(total) + ' putt' : 'holed from ' + Math.round(total) + ' yd', d < 0 ? S.col.acc : d === 0 ? null : S.col.hudMu, 2.4);
      if (d < 0 || res.strokes === 1) { sfx('fan'); sfx('clap', 1.5); spawn(H.pin.x, H.pin.y, H.pin.z + 0.3, 70, 'conf'); }
      else sfx('clap', 0.6);
      S.settleDur = 2.4;
      if (!p.cpu) {
        if (res.strokes === 1) rec.aces++;
        else if (d <= -2) rec.eagles++;
        else if (d === -1) rec.birdies++;
        if (b.putt && total * 3 > (rec.longPutt || 0)) rec.longPutt = Math.round(total * 3);
        persist();
      }
    } else if (res.kind === 'water') { say('IN THE WATER', '+1 penalty · drop', S.col.red, 1.8); S.settleDur = 1.9; }
    else if (res.kind === 'ob') { say('OUT OF BOUNDS', '+1 · replay the shot', S.col.red, 1.8); S.settleDur = 1.9; sfx('ooh'); }
    else if (res.gimme) say('GIMME', 'picked up for ' + scoreName(res.strokes, par).toLowerCase(), null, 1.6);
    else if (res.capped) say('PICKED UP', res.strokes + ' strokes', S.col.hudMu, 1.6);
    else {
      var l = res.lie, d2 = res.dist;
      if (b.putt) { if (d2 < 1) say('SO CLOSE', ydft(d2) + ' left', null, 1.1); }
      else if (l === GREEN && d2 < 3) { say('NICE SHOT!', ydft(d2) + ' from the pin', null, 1.6); sfx('clap', 1); }
      else if (l === GREEN) { say('ON THE GREEN', ydft(d2) + ' away', null, 1.3); sfx('clap', 0.4); }
      else if (fromLie === TEE && par > 3 && total > 285) { say('BOOMER!', Math.round(total) + ' yd drive', null, 1.4); sfx('aah'); }
      else if (l === FAIR && fromLie === TEE) say('FAIRWAY', Math.round(total) + ' yd · ' + Math.round(d2) + ' to go', null, 1.2);
      else if (l === SAND) say('BUNKER', Math.round(d2) + ' yd to go', S.col.gold, 1.2);
      else if (l === DEEP) say('DEEP ROUGH', 'it\'ll come out slow', S.col.gold, 1.2);
      else if (l === ROUGH) say('ROUGH', Math.round(d2) + ' yd to go', null, 1.1);
      else if (l === FRINGE) say('FRINGE', ydft(d2) + ' to the pin', null, 1.1);
      else if (l === WASTE) say('WASTE AREA', Math.round(d2) + ' yd to go', S.col.gold, 1.1);
    }
    if (!p.cpu && !b.putt && fromLie === TEE && par > 3 && lieAt(H, b.x, b.y) !== OB && total > (rec.ld || 0) && res.kind === 'rest') { rec.ld = Math.round(total); persist(); }
    syncHud();
    saveRound();
    setPad('wait'); S.waitTxt = 'tap to continue';
  }
  function afterSettle() {
    var g = S.g;
    if (g.ch) { nextChallengeShot(); return; }
    if (holeDone(g)) finishHole(); else beginTurn(false);
  }
  // ---- challenges ----
  function challengeShot(b, total) {
    var g = S.g, H = S.H, ch = g.ch, l = lieAt(H, b.x, b.y), v;
    g.hs.b[0].done = true; g.hs.b[0].strokes = 1;
    if (ch.kind === 'ctp') {
      if (b.st === 'holed') { v = 0; say('HOLE IN ONE!', 'perfect', S.col.acc, 2.4); sfx('fan'); sfx('clap', 2); spawn(H.pin.x, H.pin.y, H.pin.z + 0.3, 70, 'conf'); }
      else if (b.st === 'water' || l === WATER || l === OB) { v = 40; say('MISSED', 'counts as 40 yd', S.col.red, 1.8); }
      else { v = distPin(H, b.x, b.y); say(ydft(v), v < 3 ? 'stiff!' : v < 8 ? 'nice' : 'from the pin', v < 3 ? S.col.acc : null, 1.6); if (v < 3) sfx('clap', 1); }
    } else {
      var inGrid = b.st !== 'water' && (l === FAIR || l === ROUGH || l === FRINGE);
      v = inGrid ? Math.max(0, Math.round(b.y - b.from.y)) : 0;
      say(inGrid ? v + ' YARDS' : 'OUT OF THE GRID', inGrid ? (l === FAIR ? 'in the fairway' : 'in the rough') : 'no distance', inGrid ? null : S.col.red, 1.8);
      if (v > 290) sfx('clap', 1);
    }
    ch.res.push(Math.round(v * 10) / 10);
    S.settleDur = 2;
    syncHud(); saveRound();
    setPad('wait'); S.waitTxt = 'tap to continue';
  }
  function nextChallengeShot() {
    var g = S.g;
    if (g.ch.res.length >= g.holes.length) { endRound(); return; }
    g.hi = g.ch.res.length; g.hs = null;
    enterHole(false);
  }
  // ---- hole and round end ----
  function finishHole() {
    var g = S.g;
    S.phase2 = 'holeend';
    syncHud();
    saveRound();
    S.phase = 'card';
    stopLoop();
    showCard('hole');
    setPad(g.hi + 1 >= g.holes.length ? 'results' : 'next');
    draw();
  }
  function goNextHole() {
    var g = S.g;
    if (!advanceHole(g)) { endRound(); return; }
    saveRound();
    enterHole(false);
  }
  function endRound() {
    var g = S.g, rec = S.save.rec;
    S.phase = 'card'; S.phase2 = 'done';
    stopLoop();
    sdel(ROUND_KEY); S.resume = null;
    S.result = null;
    if (g.ch) {
      var sum = 0, best = 0;
      g.ch.res.forEach(function (v) { sum += v; best = Math.max(best, v); });
      if (g.ch.kind === 'ctp') { S.result = { kind: 'ctp', total: Math.round(sum * 10) / 10, rec: rec.ctp == null || sum < rec.ctp }; if (S.result.rec) rec.ctp = Math.round(sum * 10) / 10; }
      else { S.result = { kind: 'drive', best: best, rec: best > (rec.ld || 0) }; if (S.result.rec) rec.ld = best; }
    } else {
      rec.rounds++;
      var n = g.holes.length, key = n >= 18 ? 'r18' : 'r9';
      g.players.forEach(function (p, i) {
        if (p.cpu) return;
        var t = 0, par = 0;
        p.scores.forEach(function (sc, k) { t += sc || 0; par += parOf(g, k); });
        if (!rec[key] || t - par < rec[key].toPar) rec[key] = { toPar: t - par, strokes: t, course: courseOf(g).name };
      });
      if (g.mode === 'tour') S.result = tourResult(g);
    }
    persist();
    showCard('results');
    setPad('again');
    syncHead();
    if (S.result && (S.result.rec || S.result.pos === 1)) { sfx('fan'); sfx('clap', 2); }
  }
  // ---- the tour ----
  function tourBoard(g, n) {
    var t = g.tour, course = courseOf(g);
    var field = t.field.map(function (nm) { return { name: nm }; });
    return leaderboard(field, t.pros, g.players[0].scores, course, g.holes, n == null ? g.hi + 1 : n);
  }
  function tourResult(g) {
    var car = S.save.car, t = g.tour, T = TOURS[t.ti], rows = tourBoard(g, g.holes.length), pay = payouts(rows, T.purse), mine = 0, pos = 0;
    rows.forEach(function (row, i) {
      if (row.me) { mine = pay[i]; pos = row.pos; }
      else car.stand[row.name] = (car.stand[row.name] || 0) + pay[i];
    });
    car.stand.You = (car.stand.You || 0) + mine;
    car.money += mine;
    if (pos === 1) car.wins++;
    if (pos <= 10) car.top++;
    car.hist.unshift({ t: t.ti, s: t.season, e: t.ev, name: t.name, pos: pos, tie: rows.some(function (r) { return r.me && r.tie; }), toPar: rows.filter(function (r) { return r.me; })[0].toPar, prize: mine });
    car.hist = car.hist.slice(0, 30);
    car.ev++;
    var res = { kind: 'tour', rows: rows, pay: pay, pos: pos, prize: mine, name: t.name, season: null };
    if (car.ev >= EVENTS) {
      var list = Object.keys(car.stand).map(function (k) { return { name: k, m: car.stand[k] }; }).sort(function (a, b) { return b.m - a.m; });
      var rank = 1 + list.findIndex(function (r) { return r.name === 'You'; });
      var promo = rank <= 3 && car.tour === car.unlocked && car.unlocked < TOURS.length - 1;
      if (promo) car.unlocked++;
      var bonus = rank === 1 ? Math.round(T.purse * 0.1) : 0;
      car.money += bonus;
      res.season = { rank: rank, list: list.slice(0, 8), promo: promo, bonus: bonus, tour: car.tour };
      car.season++; car.ev = 0; car.stand = {};
      if (promo) car.tour = car.unlocked;
    }
    return res;
  }
  function startTourEvent() {
    var car = S.save.car, ti = clamp(car.tour, 0, car.unlocked), T = TOURS[ti], info = eventInfo(ti, car.season, car.ev), su = S.save.set;
    var holes = []; for (var i = 0; i < T.holes; i++) holes.push(i);
    var field = tourField(ti), course = newCourse(info.seed, info.theme, T.lvl);
    var pros = field.map(function (p, k) { return proScores(info.seed, k, p.skill, course, holes, su.diff); });
    startRound({
      mode: 'tour', seed: info.seed, theme: info.theme, lvl: T.lvl, holes: holes, players: [{ name: 'You', cpu: 0 }], diff: su.diff, gim: su.gim, eq: car.eq,
      tour: { ti: ti, season: car.season, ev: car.ev, name: info.name, field: field.map(function (p) { return p.name; }), pros: pros }
    });
  }
  function startQuick() {
    var su = S.save.set, holes = [];
    for (var i = 0; i < su.holes; i++) holes.push(i);
    var hum = su.seats.filter(function (v) { return !v; }).length, hn = 0, cn = 0;
    var players = su.seats.map(function (v) {
      if (v) return { name: CPU_NAMES[(cn++) % CPU_NAMES.length], cpu: su.lvl };
      hn++;
      return { name: hum === 1 ? 'You' : 'P' + hn, cpu: 0 };
    });
    startRound({ mode: 'quick', seed: su.seed, theme: su.theme === 'random' ? null : su.theme, lvl: 0, holes: holes, players: players, diff: su.diff, gim: su.gim, eq: {} });
  }
  function startChallenge(kind) {
    var su = S.save.set, seed = (Math.random() * 4294967296) >>> 0;
    startRound({ mode: kind, seed: seed, theme: kind === 'drive' ? 'parkland' : null, lvl: 0, holes: [0, 1, 2, 3, 4], players: [{ name: 'You', cpu: 0 }], diff: su.diff, gim: 0, eq: {}, ch: { kind: kind, res: [] } });
  }
  function saveRound() {
    if (!S || !S.g || S.g.over || S.phase2 === 'done') return;
    try { sset(ROUND_KEY, JSON.stringify(snapRound(S.g))); } catch (e) {}
  }
  function loadSavedRound() {
    var raw = sget(ROUND_KEY);
    if (!raw) return null;
    try { var o = JSON.parse(raw); return loadRound(o); } catch (e) { return null; }
  }

  // ---- cpu ----
  function cpuThink(dt) {
    var g = S.g, p = g.players[g.cur];
    S.cpuT += dt;
    if (S.plan && !S.plan.best) { planStep(S.plan, 22); return; }
    if (!S.cpuShot) {
      var best = S.plan.best;
      S.cpuShot = cpuExecute(best, LEVELS[p.cpu].skill, Math.random, g.diff);
      S.cpuPlanYaw = best.yaw; S.aim.club = best.club; S.aim.auto = true;
      syncPutting();
      S.cpuAimT = 0;
      return;
    }
    S.cpuAimT += dt;
    var dy = S.cpuPlanYaw - S.aim.yaw;
    if (Math.abs(dy) > 0.002) { S.aim.yaw += dy * Math.min(1, dt * 5); aimChanged(); }
    if (S.cpuAimT > 0.9 && S.cpuT > 1.4) strikeShot(S.cpuShot);
  }

  // ---- HUD (DOM) ----
  function syncHud() {
    var g = S.g, h = '';
    if (!g || S.phase === 'menu') { S.hud.innerHTML = ''; S.hud.classList.add('off'); return; }
    S.hud.classList.remove('off');
    var H = S.H;
    if (g.ch) {
      var r = g.ch.res, sum = 0;
      r.forEach(function (v) { sum += v; });
      h += '<span class="tg-h1">' + (g.ch.kind === 'ctp' ? 'CLOSEST TO PIN' : 'LONG DRIVE') + ' <i>' + Math.min(r.length + 1, g.holes.length) + '/' + g.holes.length + '</i></span>';
      h += '<span class="tg-st">' + (g.ch.kind === 'ctp' ? 'total <b>' + ydft(sum) + '</b>' : 'best <b>' + Math.max.apply(null, [0].concat(r)) + ' yd</b>') + '</span>';
    } else {
      h += '<span class="tg-h1">H' + (g.hi + 1) + '<i>/' + g.holes.length + '</i></span><span class="tg-par">PAR ' + H.par + ' · ' + H.len + 'y</span>';
      h += '<span class="tg-pls">';
      g.players.forEach(function (p, i) {
        var t = 0, par = 0;
        p.scores.forEach(function (sc, k) { if (sc) { t += sc; par += parOf(g, k); } });
        var hs = g.hs && g.hs.b[i];
        h += '<span class="tg-pl p' + (i + 1) + (i === g.cur ? ' on' : '') + '">' + esc(p.name) + ' <b>' + sgn(t - par) + '</b>' + (hs && !hs.done && hs.strokes ? ' <i>(' + hs.strokes + ')</i>' : '') + '</span>';
      });
      h += '</span>';
      if (g.tour) {
        var rows = tourBoard(g, g.hs && g.hs.b[0].done ? g.hi + 1 : g.hi), me = rows.filter(function (row) { return row.me; })[0];
        h += '<span class="tg-st">' + (me.tie ? 'T' : '') + me.pos + '<i>/' + rows.length + '</i> · lead <b>' + sgn(rows[0].toPar) + '</b></span>';
      } else if (g.hs) h += '<span class="tg-st">stroke <b>' + (g.hs.b[g.cur].strokes + 1) + '</b></span>';
    }
    if (h !== S.hudHtml) { S.hudHtml = h; S.hud.innerHTML = h; }
  }

  // ---- cards ----
  var ART = '      __\n   o |  |>\n  /|\\|\n  / \\|   . o\n ~~~~|~~~~~~~';
  function tabsHtml() {
    return '<div class="tg-tabs" role="tablist">' + [['play', 'Play'], ['tour', 'Tour'], ['chal', 'Challenge'], ['rec', 'Records'], ['opt', 'Options']].map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }
  function chips(list, cur, attr) {
    return '<div class="tg-chips">' + list.map(function (q) {
      return '<button type="button" class="tg-chip' + (String(cur) === String(q[0]) ? ' on' : '') + '" data-' + attr + '="' + q[0] + '" aria-pressed="' + (String(cur) === String(q[0])) + '">' + q[1] + (q[2] ? '<i>' + q[2] + '</i>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function menuHtml() {
    var su = S.save.set, car = S.save.car, rec = S.save.rec, h = '<div class="tg-card tg-menu">';
    h += '<div class="tg-top"><span class="tg-brand">TEE TIME GOLF</span><span class="tg-meta">' + DIFFS[su.diff].name + ' · ' + money(car.money) + '</span></div>';
    h += tabsHtml();
    if (S.resume) {
      var o = S.resume;
      var what = o.ch ? (o.ch.kind === 'ctp' ? 'Closest to the pin' : 'Long drive') : o.tour ? o.tour.name : 'Quick round';
      h += '<button type="button" class="tg-resume" data-act="resume-round"><b>Resume ' + esc(what) + '</b><span>' + (o.ch ? 'shot ' + (o.ch.res.length + 1) + ' of ' + o.holes.length : 'hole ' + (o.hi + 1) + ' of ' + o.holes.length + ' · ' + o.players.length + ' player' + (o.players.length > 1 ? 's' : '')) + '</span></button>';
    }
    if (S.tab === 'play') {
      var course = newCourse(su.seed, su.theme === 'random' ? null : su.theme, 0);
      h += '<div class="tg-sec"><div class="tg-h">Course <i>' + esc(course.name) + ' · par ' + course.par + '</i></div>' +
        chips([['random', 'Random']].concat(THEME_IDS.map(function (t) { return [t, THEMES[t].name]; })), su.theme, 'theme') +
        '<div class="tg-row">' + chips([[9, '9 holes'], [18, '18 holes']], su.holes, 'holes') + '<button type="button" class="tg-lnk" data-act="reseed">New course ↻</button></div></div>';
      h += '<div class="tg-sec"><div class="tg-h">Players <i>tap a seat: you / CPU</i></div><div class="tg-chips">';
      var cn = 0;
      su.seats.forEach(function (v, i) {
        h += '<button type="button" class="tg-chip tg-seat p' + (i + 1) + (v ? ' cpu' : '') + '" data-seat="' + i + '"><b>●</b>' + (v ? esc(CPU_NAMES[(cn++) % CPU_NAMES.length]) : 'P' + (i + 1)) + '<i>' + (v ? LEVELS[su.lvl].name.toLowerCase() : 'human') + '</i></button>';
      });
      if (su.seats.length < 4) h += '<button type="button" class="tg-chip tg-add" data-act="seat-add" aria-label="Add a player">+</button>';
      if (su.seats.length > 1) h += '<button type="button" class="tg-chip tg-add" data-act="seat-del" aria-label="Remove a player">&minus;</button>';
      h += '</div></div>';
      if (su.seats.some(function (v) { return v; })) h += '<div class="tg-sec"><div class="tg-h">CPU golfers</div>' + chips([[1, 'Rookie'], [2, 'Club pro'], [3, 'Tour pro']], su.lvl, 'lvl') + '</div>';
    } else if (S.tab === 'tour') {
      var ti = clamp(car.tour, 0, car.unlocked), T = TOURS[ti], info = eventInfo(ti, car.season, car.ev);
      h += '<div class="tg-sec"><div class="tg-h">Tour <i>finish top 3 on the money list to move up</i></div>' + chips(TOURS.map(function (t, i) { return [i, t.name, i > car.unlocked ? 'locked' : t.holes + ' holes']; }), ti, 'tour') + '</div>';
      h += '<pre class="tg-tab">' + esc(T.name) + ' · season <b>' + car.season + '</b>\nnext: <b>' + esc(info.name) + '</b> (event ' + (car.ev + 1) + '/' + EVENTS + ')\n' + THEMES[info.theme].name + ' course · purse <b>' + money(T.purse) + '</b>\nbank <b>' + money(car.money) + '</b> · wins <b>' + car.wins + '</b> · top 10s <b>' + car.top + '</b></pre>';
      var st = Object.keys(car.stand).map(function (k) { return { n: k, m: car.stand[k] }; }).sort(function (a, b) { return b.m - a.m; });
      if (st.length) h += '<div class="tg-h">Season money list</div><pre class="tg-tab">' + st.slice(0, 6).map(function (r, i) { return (i + 1 + '. ' + (r.n === 'You' ? '<b>You</b>' : esc(r.n))).padEnd(r.n === 'You' ? 31 : 24) + ' ' + money(r.m); }).join('\n') + '</pre>';
      h += '<div class="tg-btns"><button type="button" class="tg-go alt" data-act="shop">Pro shop</button><button type="button" class="tg-go" data-act="tour-go">Play event</button></div>';
    } else if (S.tab === 'chal') {
      h += '<div class="tg-sec"><div class="tg-h">Closest to the pin</div><p>Five par-3 tee shots, 95–205 yards. Your score is the total distance from the pin — water or OB counts 40 yards.</p><p>Best: <b>' + (rec.ctp == null ? '—' : ydft(rec.ctp)) + '</b></p><button type="button" class="tg-go" data-act="ctp">Play closest to the pin</button></div>';
      h += '<div class="tg-sec"><div class="tg-h">Long drive</div><p>Five drives down a wide, straight grid. Only balls that stop in the fairway or rough count.</p><p>Longest: <b>' + (rec.ld ? rec.ld + ' yd' : '—') + '</b></p><button type="button" class="tg-go" data-act="drive">Play long drive</button></div>';
    } else if (S.tab === 'rec') {
      var rows = [['Best 18', rec.r18 ? sgn(rec.r18.toPar) + ' (' + rec.r18.strokes + ')' : '—'], ['Best 9', rec.r9 ? sgn(rec.r9.toPar) + ' (' + rec.r9.strokes + ')' : '—'], ['Rounds', String(rec.rounds)],
        ['Holes in one', String(rec.aces)], ['Eagles', String(rec.eagles)], ['Birdies', String(rec.birdies)], ['Longest drive', rec.ld ? rec.ld + ' yd' : '—'], ['Longest putt', rec.longPutt ? rec.longPutt + ' ft' : '—'],
        ['Closest to pin', rec.ctp == null ? '—' : ydft(rec.ctp)], ['Tour wins', String(car.wins)], ['Career money', money(car.money)]];
      h += '<pre class="tg-tab">' + rows.map(function (q) { return esc(q[0]) + new Array(Math.max(1, 26 - q[0].length - q[1].length) + 1).join(' ') + '<b>' + esc(q[1]) + '</b>'; }).join('\n') + '</pre>';
      if (car.hist.length) h += '<div class="tg-h">Recent events</div><pre class="tg-tab">' + car.hist.slice(0, 5).map(function (e) { return (e.tie ? 'T' : '') + e.pos + '. ' + esc(e.name) + ' ' + sgn(e.toPar) + ' ' + money(e.prize); }).join('\n') + '</pre>';
      h += '<div class="tg-foot">' + (S.resetArm ? '<span>Erase records and career?</span><span><button type="button" class="tg-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="tg-lnk" data-act="reset-no">Keep</button></span>' : '<span></span><button type="button" class="tg-lnk" data-act="reset">Reset everything</button>') + '</div>';
    } else {
      h += '<div class="tg-sec"><div class="tg-h">Difficulty <i>wind, swing tolerance, green speed, tees, CPU</i></div>' + chips(DIFFS.map(function (d, i) { return [i, d.name]; }), su.diff, 'diff') + '</div>';
      h += '<div class="tg-sec"><div class="tg-h">Gimmes</div>' + chips([[-1, 'Auto', DIFFS[su.diff].gim ? Math.round(DIFFS[su.diff].gim * 3) + ' ft' : 'off'], [0, 'Off'], [0.5, 'Short', '1.5 ft'], [1, 'Long', '3 ft']], su.gim, 'gim') + '</div>';
      h += '<div class="tg-sec"><div class="tg-h">Graphics detail</div>' + chips([[-1, 'Auto'], [0, 'Low'], [1, 'Medium'], [2, 'High']], su.det, 'det') + '</div>';
    }
    return h + '</div>';
  }
  function helpHtml(first) {
    var keys = S.coarse ?
      '<div><b>swing:</b> drag <b>down</b> on the course, then flick <b>up</b> fast — speed is power, a sideways lean hooks or slices</div><div><b>putt:</b> drag down for the distance, push up to stroke</div><div><b>&lt; &gt;</b> aim · <b>&minus; +</b> club · <b>SWING</b> three-tap meter</div><div><b>in flight</b> swipe ← → ↑ ↓ for curve / topspin / backspin</div><div>tap the <b>map</b> to aim at a spot</div>' :
      '<div><b>mouse:</b> drag <b>down</b>, then push <b>up</b> fast — speed is power, a lean hooks / slices</div><div><b>Space</b> three-click meter: start · power · accuracy</div><div><b>&larr; &rarr;</b> aim (Shift: fine) · <b>&uarr; &darr;</b> club · <b>V</b> view · <b>M</b> map</div><div><b>in flight</b> arrows / swipe add spin · <b>C</b> card · <b>P / Esc</b> pause</div>';
    return '<div class="tg-card tg-help"><pre class="tg-art" aria-hidden="true">' + esc(ART) + '</pre><div class="tg-title">TEE TIME GOLF</div>' +
      '<p>Get round in as few strokes as you can. The <b>wind</b> grows with height; <b>rough</b>, <b>deep rough</b> and <b>sand</b> cost distance; <b>water</b> is a one-stroke drop and <b>OB</b> is stroke and distance.</p>' +
      '<div class="tg-keys">' + keys + '</div>' +
      '<p class="tg-tip">The dotted arc shows a full, straight carry with no wind. Past 100% is an <b>overswing</b>: a little longer, a lot wilder. On the green, arrows point downhill — read the break.</p>' +
      (first ? '' : '<button type="button" class="tg-go" data-act="close-help">Back</button>') + '</div>';
  }
  function scoreCls(sc, par) { return !sc ? 'e' : sc === 1 ? 'ace' : sc < par ? 'under' : sc === par ? 'par' : 'over'; }
  function cardTable(g) {
    var nh = g.holes.length, blocks = nh > 9 ? [[0, 9], [9, nh]] : [[0, nh]], h = '';
    blocks.forEach(function (bl) {
      h += '<table class="tg-sc"><tr><th>Hole</th>';
      for (var i = bl[0]; i < bl[1]; i++) h += '<th class="' + (i === g.hi ? 'now' : '') + '">' + (i + 1) + '</th>';
      h += '<th>' + (bl[0] ? 'In' : nh > 9 ? 'Out' : 'Tot') + '</th></tr><tr class="par"><td>Par</td>';
      var ps = 0;
      for (i = bl[0]; i < bl[1]; i++) { var pp = parOf(g, i); ps += pp; h += '<td>' + pp + '</td>'; }
      h += '<td class="t">' + ps + '</td></tr>';
      g.players.forEach(function (p, pi) {
        var s = 0;
        h += '<tr class="p' + (pi + 1) + '"><td><b>' + esc(p.name) + '</b></td>';
        for (i = bl[0]; i < bl[1]; i++) { var sc = p.scores[i]; s += sc || 0; h += '<td class="' + scoreCls(sc, parOf(g, i)) + '">' + (sc || '·') + '</td>'; }
        h += '<td class="t">' + (s || '·') + '</td></tr>';
      });
      h += '</table>';
    });
    return '<div class="tg-scw">' + h + '</div>';
  }
  function boardHtml(rows, n, pay) {
    var out = '<pre class="tg-tab tg-board">', meShown = false;
    rows.forEach(function (r, i) {
      if (i >= n && !r.me) return;
      if (r.me) meShown = true;
      var nm = r.name.length > 18 ? r.name.slice(0, 17) + '.' : r.name;
      var line = ((r.tie ? 'T' : '') + r.pos).padStart(3) + ' ' + nm.padEnd(18) + ' ' + sgn(r.toPar).padStart(3) + (pay ? ' ' + money(pay[i]).padStart(9) : ' ' + ('thru ' + r.thru).padStart(7));
      out += (r.me ? '<b>' + esc(line) + '</b>' : esc(line)) + '\n';
    });
    return out + '</pre>';
  }
  function holeHtml() {
    var g = S.g, H = S.H, h = '<div class="tg-card">';
    h += '<div class="tg-title">HOLE ' + (g.hi + 1) + '</div><div class="tg-sub">' + esc(H.name) + ' · par ' + H.par + '</div>';
    if (g.players.length === 1) {
      var sc = g.players[0].scores[g.hi];
      h += '<div class="tg-big">' + esc(scoreName(sc, H.par).toUpperCase()) + ' <small>' + sc + '</small></div>';
    } else {
      h += '<div class="tg-tots">' + g.players.map(function (p, i) { var sc = p.scores[g.hi]; return '<span class="p' + (i + 1) + '"><b>' + esc(p.name) + '</b> ' + sc + ' <i>' + esc(scoreName(sc, H.par).toLowerCase()) + '</i></span>'; }).join('') + '</div>';
    }
    if (g.tour) h += '<div class="tg-h">Leaderboard · ' + esc(g.tour.name) + '</div>' + boardHtml(tourBoard(g), 5);
    h += cardTable(g);
    return h + '</div>';
  }
  function resultsHtml() {
    var g = S.g, R = S.result, h = '<div class="tg-card tg-res">';
    if (R && R.kind === 'ctp') {
      h += '<div class="tg-title">CLOSEST TO THE PIN</div><div class="tg-big">' + ydft(R.total) + '</div>' + (R.rec ? '<div class="tg-new">NEW BEST</div>' : '');
      h += '<pre class="tg-tab">' + g.ch.res.map(function (v, i) { return 'Shot ' + (i + 1) + '   <b>' + ydft(v) + '</b>'; }).join('\n') + '</pre>';
    } else if (R && R.kind === 'drive') {
      h += '<div class="tg-title">LONG DRIVE</div><div class="tg-big">' + R.best + ' <small>yd</small></div>' + (R.rec ? '<div class="tg-new">NEW RECORD</div>' : '');
      h += '<pre class="tg-tab">' + g.ch.res.map(function (v, i) { return 'Ball ' + (i + 1) + '   <b>' + (v ? v + ' yd' : 'out') + '</b>'; }).join('\n') + '</pre>';
    } else if (R && R.kind === 'tour') {
      h += '<div class="tg-title">' + esc(R.name.toUpperCase()) + '</div>';
      h += '<div class="tg-big">' + (R.pos === 1 ? 'CHAMPION!' : (R.rows.some(function (r) { return r.me && r.tie; }) ? 'T' : '') + R.pos + nth(R.pos)) + '</div><div class="tg-sub">prize <b>' + money(R.prize) + '</b> · bank ' + money(S.save.car.money) + '</div>';
      h += boardHtml(R.rows, 8, R.pay);
      if (R.season) {
        var s = R.season;
        h += '<div class="tg-h">Season over — you finished ' + s.rank + nth(s.rank) + ' on the money list</div>';
        if (s.promo) h += '<div class="tg-new">PROMOTED to the ' + esc(TOURS[S.save.car.unlocked].name) + '!</div>';
        if (s.bonus) h += '<div class="tg-new">Money-list title bonus ' + money(s.bonus) + '</div>';
      }
      h += cardTable(g);
    } else {
      var tot = g.players.map(function (p, i) { var t = 0, par = 0; p.scores.forEach(function (sc, k) { t += sc || 0; par += parOf(g, k); }); return { i: i, t: t, d: t - par }; });
      var best = tot.slice().sort(function (a, b) { return a.t - b.t; });
      h += '<div class="tg-title">ROUND OVER</div><div class="tg-sub">' + esc(courseOf(g).name) + '</div>';
      if (g.players.length > 1) h += '<div class="tg-big">' + esc(g.players[best[0].i].name) + ' <small>wins</small></div>';
      else h += '<div class="tg-big">' + best[0].t + ' <small>(' + sgn(best[0].d) + ')</small></div>';
      h += '<div class="tg-tots">' + tot.map(function (q) { return '<span class="p' + (q.i + 1) + '"><b>' + esc(g.players[q.i].name) + '</b> ' + q.t + ' <i>' + sgn(q.d) + '</i></span>'; }).join('') + '</div>';
      h += cardTable(g);
    }
    return h + '</div>';
  }
  function nth(n) { var t = n % 100; if (t >= 11 && t <= 13) return 'th'; return ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; }
  function shopHtml() {
    var car = S.save.car, h = '<div class="tg-card"><div class="tg-title">PRO SHOP</div><div class="tg-sub">bank <b>' + money(car.money) + '</b></div>';
    SHOP.forEach(function (it) {
      var lv = car.eq[it.id] | 0, cost = it.cost[lv];
      h += '<div class="tg-item"><div><b>' + esc(it.name) + '</b> <span class="tg-lv">' + '●●●'.slice(0, lv) + '○○○'.slice(0, 3 - lv) + '</span><br><span class="tg-what">' + esc(it.what) + ' per level</span></div>' +
        (lv >= 3 ? '<span class="tg-what">maxed</span>' : '<button type="button" class="tg-chip" data-buy="' + it.id + '"' + (car.money < cost ? ' disabled' : '') + '>' + money(cost) + '</button>') + '</div>';
    });
    return h + '<button type="button" class="tg-go" data-act="shop-close">Done</button></div>';
  }
  function pauseHtml() {
    var g = S.g;
    return '<div class="tg-card"><div class="tg-title">PAUSED</div><div class="tg-sub">' + (g && !g.ch ? esc(courseOf(g).name) + ' · hole ' + (g.hi + 1) : '') + '</div>' +
      (g && !g.ch ? cardTable(g) : '') +
      '<div class="tg-btns"><button type="button" class="tg-go alt" data-act="quit">' + (S.quitArm ? 'Sure? Quit' : 'Quit to menu') + '</button><button type="button" class="tg-go" data-act="resume">Resume</button></div>' +
      '<p class="tg-tip">Quitting keeps the round — resume it from the menu.</p></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'menu' ? menuHtml() : kind === 'help' ? helpHtml(S.firstRun) : kind === 'hole' ? holeHtml() : kind === 'results' ? resultsHtml() :
      kind === 'pause' ? pauseHtml() : kind === 'shop' ? shopHtml() : kind === 'view' ? '<div class="tg-card"><div class="tg-title">SCORECARD</div>' + cardTable(S.g) + (S.g.tour ? boardHtml(tourBoard(S.g), 6) : '') + '<button type="button" class="tg-go" data-act="close-card">Back</button></div>' : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.ovl.scrollTop = 0;
  }
  function setPad(mode) {
    var h = '', k = S.coarse ? '' : ' <small>space</small>';
    S.padMode = mode;
    if (mode === 'aim') {
      h = '<button type="button" class="tg-pb" data-hold="l" aria-label="Aim left">&lt;</button><button type="button" class="tg-pb" data-hold="r" aria-label="Aim right">&gt;</button>' +
        '<button type="button" class="tg-pb" data-act="club-" aria-label="Shorter club">&minus;</button><button type="button" class="tg-clubb" data-act="club-auto" aria-label="Club (tap for auto)"></button><button type="button" class="tg-pb" data-act="club+" aria-label="Longer club">+</button>' +
        '<button type="button" class="tg-act" data-act="swing">Swing' + k + '</button>';
    } else if (mode === 'flight') {
      h = '<span class="tg-spinl">spin</span><button type="button" class="tg-pb" data-act="e-l" aria-label="Curve left">↶</button><button type="button" class="tg-pb" data-act="e-t" aria-label="Topspin">↑</button><button type="button" class="tg-pb" data-act="e-b" aria-label="Backspin">↓</button><button type="button" class="tg-pb" data-act="e-r" aria-label="Curve right">↷</button>';
    } else if (mode === 'wait') h = '<div class="tg-wait">' + esc(S.waitTxt || '') + '</div>';
    else if (mode === 'menu') {
      if (S.tab === 'play') h = '<button type="button" class="tg-act" data-act="tee">Tee off' + k + '</button>';
      else if (S.tab === 'tour') h = '<button type="button" class="tg-act" data-act="tour-go">Play event' + k + '</button>';
      else h = '<div class="tg-wait">pick a mode above</div>';
    } else {
      var lab = { skip: 'Skip flyover', next: 'Next hole', results: 'See results', again: 'Done', resume: 'Resume', start: 'Let’s play' }[mode] || 'OK';
      h = '<button type="button" class="tg-act" data-act="' + mode + '">' + lab + k + '</button>';
      if (mode === 'next' || mode === 'results') h += '<button type="button" class="tg-act alt" data-act="view-card">Card</button>';
    }
    S.pad.innerHTML = h;
    syncPad();
  }
  function syncPad() {
    var b = S.pad.querySelector('.tg-clubb');
    if (b) b.innerHTML = '<b>' + CLUBS[S.aim.club].id + '</b><small>' + (S.aim.auto ? 'auto' : 'club') + '</small>';
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]'), cb = S.head.querySelector('[data-h="card"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.phase !== 'play' && !S.paused;
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    cb.disabled = !S.g || !!S.g.ch || S.phase === 'menu';
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.classList.toggle('on', S.snd.on);
  }
  function toMenu() {
    stopLoop();
    S.phase = 'menu'; S.paused = false; S.phase2 = 'idle'; S.quitArm = false;
    S.resume = loadSavedRound();
    S.g = null;
    // a still of the next course behind the menu
    try {
      var su = S.save.set;
      S.g = newRound({ mode: 'quick', seed: su.seed, theme: su.theme === 'random' ? null : su.theme, holes: [0], players: [{ name: 'You' }], diff: su.diff });
      S.g.theme = courseOf(S.g).theme;
      buildCurrent(); S.env = holeEnv(S.H, su.diff); prepareHoleView();
      S.g.hs = null; S.trace = []; S.parts = []; S.ball = null; S.msg = null;
      var t = S.H.tees[1]; setCam(camAim({ x: t.x, y: t.y }, autoAim(S.H, { x: t.x, y: t.y, lie: TEE }, 0, {}), false), true);
    } catch (e) { S.H = null; }
    S.g = S.g && S.g.hs ? S.g : S.g;
    syncHud(); syncHead();
    showCard(S.firstRun ? 'help' : 'menu');
    setPad(S.firstRun ? 'start' : 'menu');
    draw();
  }
  function pause() {
    if (!S || S.phase !== 'play' || S.paused) return;
    S.paused = true; S.quitArm = false;
    stopLoop(); clearHeld();
    S.sw = null; S.meter.st = 0;
    showCard('pause'); setPad('resume'); syncHead();
    draw();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    restorePad();
    syncHead();
    kick();
  }
  function restorePad() {
    if (S.phase2 === 'flyover') setPad('skip');
    else if (S.phase2 === 'aim') setPad('aim');
    else if (S.phase2 === 'flight' && S.ball && !S.ball.putt && !isCpu()) setPad('flight');
    else setPad('wait');
  }
  function quitRound() {
    saveRound();
    S.paused = false;
    toMenu();
  }

  // ---- loop: runs while a hole is in play ----
  function running() { return !!S && S.phase === 'play' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts; S.animT += dt;
    keyAim(dt);
    stepMeter(dt);
    var ph = S.phase2;
    if (ph === 'flyover') stepFlyover(dt);
    else if (ph === 'cpu') cpuThink(dt);
    else if (ph === 'flight') stepFlight(dt);
    else if (ph === 'settle') { S.settleT += dt; if (S.settleT >= S.settleDur) afterSettle(); }
    else if (ph === 'aim' && Math.random() < dt * 0.06) sfx('bird');
    if (!S || S.phase !== 'play') { if (S) draw(); return; }
    stepFx(dt);
    if (S.phase2 !== 'flyover') stepCam(dt);
    draw();
    if (S && S.phase === 'play' && !S.raf) S.raf = requestAnimationFrame(frame);
  }
  function redraw() { if (S && !S.raf) draw(); }

  // ---- three-click meter ----
  function meterPress() {
    if (!canSwing()) return;
    var m = S.meter, putt = S.aim.club === PUTTER;
    S.snd.ensure();
    if (!m.st) { m.st = 1; m.v = 0; m.dir = 1; m.pow = null; sfx('meter'); }
    else if (m.st === 1) { m.pow = Math.max(0.02, m.v); m.st = 2; sfx('meter'); }
    else meterFinish(m.v);
    putt = null;
  }
  function meterFinish(off) {
    var m = S.meter, putt = S.aim.club === PUTTER, dev = devFromMeter(off, S.g.diff, S.eq) * (putt ? 0.7 : 1);
    S.lastMeter = { v: off, pow: m.pow, t: S.animT };
    m.st = 0;
    strike(m.pow, dev);
  }
  function stepMeter(dt) {
    var m = S.meter;
    if (!m.st) return;
    if (!canSwing()) { m.st = 0; return; }
    var putt = S.aim.club === PUTTER;
    if (m.st === 1) {
      m.v += m.dir * dt * (putt ? 0.55 : 1.0);
      if (m.dir > 0 && m.v >= (putt ? 1 : 1.15)) { m.v = putt ? 1 : 1.15; m.dir = -1; }
      if (m.dir < 0 && m.v <= 0) { m.st = 0; m.v = 0; say('NO SWING', 'press three times: go, power, accuracy', S.col.hudMu, 1.4); }
    } else {
      m.v -= dt * (putt ? 0.9 : 1.25);
      if (m.v <= -0.15) meterFinish(-0.15);
    }
  }

  // ---- keys ----
  var KEY2CODE = { ' ': 'Space', 'enter': 'Enter', 'escape': 'Escape', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight', 'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'p': 'KeyP', 'c': 'KeyC', 'v': 'KeyV', 'm': 'KeyM', 'a': 'KeyA', 'd': 'KeyD', 'w': 'KeyW', 's': 'KeyS' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function clearHeld() { S.held = { l: 0, r: 0 }; S.keys = {}; }
  function keyAim(dt) {
    if (!canSwing() || S.meter.st) return;
    var k = S.keys, dir = (k.ArrowLeft || k.KeyA || S.held.l ? -1 : 0) + (k.ArrowRight || k.KeyD || S.held.r ? 1 : 0);
    if (!dir) { S.aimHeldT = 0; return; }
    S.aimHeldT += dt;
    var rate = (S.putting ? 0.14 : 0.32) * (k.ShiftLeft || k.ShiftRight ? 0.25 : 1) * Math.min(2.5, 0.5 + S.aimHeldT * 1.5);
    S.aim.yaw += dir * rate * dt;
    aimChanged();
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e);
    if (code === 'ShiftLeft' || code === 'ShiftRight') { S.keys[code] = true; return; }
    if (code === 'Escape') {
      e.preventDefault();
      if (S.bigMap) { S.bigMap = false; redraw(); }
      else if (S.phase === 'play' && !S.paused) pause();
      else if (S.cardKind === 'view' || S.cardKind === 'shop') closeSubCard();
      else if (S.cardKind === 'help' && !S.firstRun) showCard(S.paused ? 'pause' : 'menu');
      else if (S.paused) resume();
      else if (S.phase === 'menu') closePanel();
      return;
    }
    if (code === 'KeyP' && (S.phase === 'play' || S.paused)) { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
    if (code === 'KeyC' && S.g && S.phase !== 'menu' && !S.g.ch && !e.repeat) { e.preventDefault(); toggleCardView(); return; }
    if (S.phase === 'play' && !S.paused) {
      var ph = S.phase2;
      if (ph === 'flight') {
        var map = { ArrowLeft: [-0.3, 0], ArrowRight: [0.3, 0], ArrowUp: [0, 0.3], ArrowDown: [0, -0.3], KeyA: [-0.3, 0], KeyD: [0.3, 0], KeyW: [0, 0.3], KeyS: [0, -0.3] };
        if (map[code]) { e.preventDefault(); if (!e.repeat) applyEng(map[code][0], map[code][1]); return; }
      }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        if (e.repeat) return;
        if (ph === 'flyover') endFlyover();
        else if (ph === 'settle') S.settleT = Math.max(S.settleT, S.settleDur - 0.15);
        else if (ph === 'aim') { if (S.bigMap) S.bigMap = false; meterPress(); }
        return;
      }
      if (ph === 'aim') {
        if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD') { e.preventDefault(); S.keys[code] = true; return; }
        if ((code === 'ArrowUp' || code === 'KeyW') && !S.meter.st) { e.preventDefault(); setClub(S.aim.club - 1); return; }
        if ((code === 'ArrowDown' || code === 'KeyS') && !S.meter.st) { e.preventDefault(); setClub(S.aim.club + 1); return; }
        if (code === 'KeyV' && !e.repeat) { e.preventDefault(); toggleView(); return; }
        if (code === 'KeyM' && !e.repeat) { e.preventDefault(); S.bigMap = !S.bigMap; return; }
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) { if (S.paused && S.cardKind === 'pause') resume(); else padAction(); }
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }
  function toggleView() {
    if (!canSwing()) return;
    S.view = S.view ? 0 : 1;
    var s = S.g.hs.b[S.g.cur], c = S.view ? camTarget(s, S.aim.yaw) : camAim(s, S.aim.yaw, S.putting);
    c.k = 3; setCam(c, false);
  }
  function toggleCardView() {
    if (!S.g || S.g.ch) return;
    if (S.cardKind === 'view') { closeSubCard(); return; }
    if (S.phase === 'play' && !S.paused) pause();
    showCard('view');
  }
  function closeSubCard() {
    if (S.paused) showCard('pause');
    else if (S.phase2 === 'holeend') showCard('hole');
    else if (S.phase2 === 'done') showCard('results');
    else if (S.phase === 'menu') showCard('menu');
    else showCard(null);
  }
  function padAction(act) {
    if (!S) return;
    act = act || S.padMode;
    S.snd.ensure();
    if (act === 'swing') { meterPress(); return; }
    if (act === 'club-') { if (canSwing() && !S.meter.st) setClub(S.aim.club - 1); return; }
    if (act === 'club+') { if (canSwing() && !S.meter.st) setClub(S.aim.club + 1); return; }
    if (act === 'club-auto') {
      if (!canSwing() || S.meter.st) return;
      var s = S.g.hs.b[S.g.cur];
      if (S.g.ch && S.g.ch.kind === 'drive') return;
      setClub(autoClub(S.H, s, S.eq)); S.aim.auto = true; syncPad();
      return;
    }
    if (act === 'e-l') { applyEng(-0.3, 0); return; }
    if (act === 'e-r') { applyEng(0.3, 0); return; }
    if (act === 'e-t') { applyEng(0, 0.3); return; }
    if (act === 'e-b') { applyEng(0, -0.3); return; }
    if (act === 'skip') { endFlyover(); return; }
    if (act === 'next') { goNextHole(); return; }
    if (act === 'results') { advanceHole(S.g); endRound(); return; }
    if (act === 'again') { toMenu(); return; }
    if (act === 'resume') { resume(); return; }
    if (act === 'view-card') { toggleCardView(); return; }
    if (act === 'start') { S.firstRun = false; persist(); showCard('menu'); setPad('menu'); return; }
    if (act === 'menu' || act === 'tee') { if (S.phase === 'menu') { if (S.tab === 'tour') startTourEvent(); else if (S.tab === 'play') startQuick(); } return; }
    if (act === 'tour-go') { startTourEvent(); return; }
  }

  // ---- layout ----
  function chromeH() {
    var r = S.panel.getBoundingClientRect(), bd = S.panel.querySelector('.cade-panel-body');
    if (!r.height || !bd) return 0;
    return (r.height - bd.clientHeight) + bd.scrollHeight - (S.stage.offsetHeight || 0);
  }
  function availH(vw, vh, chrome) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !chrome) return vh - (vw <= 560 ? 230 : 240);
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
    var W = Math.floor(Math.min(vw - gut, solo ? 1000 : 720)), ch = chromeH(), ah = Math.floor(Math.max(170, availH(vw, vh, ch))), H;
    if (W < 520) H = Math.min(ah, Math.round(W * 1.3));
    else H = Math.min(ah, Math.round(W * 0.64));
    H = Math.max(H, Math.min(ah, 220));
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    S.SW = W; S.SH = H;
    S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
    S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
    S.panel.style.setProperty('--tg-w', W + 'px');
    S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
    S.k = S.cv.width / W;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.lay = { chrome: ch };
    setupRaster();
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) { layout(); redraw(); }
  }
  function swingFull() { return clamp(S.SH * 3, 1000, 1900); }
  function puttFull() { return clamp(S.SH * 0.5, 120, 300); }

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
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    if (s.g && s.phase !== 'menu' && s.phase2 !== 'done' && !s.g.over) { try { sset(ROUND_KEY, JSON.stringify(snapRound(s.g))); } catch (e) {} }
    s.snd.close();
    if (s.R.tcv) { s.R.tcv.width = 0; s.R.tcv.height = 0; }
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
    var body = '<div class="tg"><div class="tg-hud off"></div><div class="tg-stage"><canvas class="tg-cv"></canvas><div class="tg-ovl" style="display:none"></div></div>' +
      '<div class="tg-pad"></div><div class="tg-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🏌 Tee Time Golf', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'tg-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="card" title="Scorecard (C)" aria-label="Scorecard">' + IC_CARD + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, hud: p.querySelector('.tg-hud'), stage: p.querySelector('.tg-stage'), cv: p.querySelector('.tg-cv'), ovl: p.querySelector('.tg-ovl'),
      pad: p.querySelector('.tg-pad'), liveEl: p.querySelector('.tg-live'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) !== '0'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      phase: 'menu', phase2: 'idle', g: null, H: null, course: null, hKey: '', env: null, cm: null, mm: null, cmKey: '', spr: {},
      R: { RW: 0, RH: 0, hz: 0, dirty: true, grid: false }, cam: { x: 0, y: 0, z: 5, yaw: 0, hzf: 0.3 }, lastCam: { x: -1, y: -1, z: -1, yaw: 9, hzf: 0 }, camGoal: null,
      paused: false, raf: 0, last: 0, animT: 0, acc: 0, k: 1, SW: 480, SH: 300, sc: 1,
      keys: {}, held: { l: 0, r: 0 }, aimHeldT: 0, aim: { yaw: 0, club: 0, auto: true }, prev: null, prevPts: [], putting: false, eq: {}, view: 0,
      ball: null, trace: [], traceN: 0, parts: [], msg: null, msgQ: [], sw: null, eng: { left: 0, max: 1 }, meter: { st: 0, v: 0, dir: 1, pow: null }, lastMeter: null,
      plan: null, cpuShot: null, cpuT: 0, cpuAimT: 0, bigMap: false, mmRect: null, tab: 'play', cardKind: null, padMode: '', hudHtml: '', resetArm: false, quitArm: false, result: null
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { clearHeld(); } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); clearHeld(); stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); if (S.H) prepareHoleView(); }
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
    window.addEventListener('orientationchange', S.onResize);
    try {
      S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); });
      S.ro.observe(S.hud); S.ro.observe(S.pad);
    } catch (e) {}
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); if (S.H) prepareHoleView(); redraw();
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
        S.snd.ensure(); sfx('click');
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'card') toggleCardView();
      else if (h === 'help') {
        if (S.phase === 'play' && !S.paused) pause();
        if (S.cardKind === 'help') showCard(S.paused ? 'pause' : S.phase === 'menu' ? 'menu' : null);
        else if (S.phase === 'menu' || S.paused) showCard('help');
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

    // the course: swing gesture, spin swipes, map taps
    function stagePt(e) {
      var r = S.cv.getBoundingClientRect(), fx = r.width ? S.SW / r.width : 1, fy = r.height ? S.SH / r.height : 1;
      return { x: (e.clientX - r.left) * fx, y: (e.clientY - r.top) * fy, t: (e.timeStamp || performance.now()) / 1000 };
    }
    function inMap(q) { var m = S.mmRect; return m && q.x >= m.x - 4 && q.x <= m.x + m.w + 4 && q.y >= m.y - 4 && q.y <= m.y + m.h + 4; }
    S.cv.addEventListener('pointerdown', function (e) {
      if (!S || e.button > 0) return;
      e.preventDefault();
      S.snd.ensure();
      if (S.phase !== 'play' || S.paused) return;
      var q = stagePt(e), ph = S.phase2;
      if (ph === 'flyover') { endFlyover(); return; }
      if (ph === 'settle') { S.settleT = Math.max(S.settleT, S.settleDur - 0.15); return; }
      if (ph === 'flight') { if (S.ball && !S.ball.putt && !isCpu()) S.eswipe = { id: e.pointerId, x: q.x, y: q.y }; try { S.cv.setPointerCapture(e.pointerId); } catch (x) {} return; }
      if (!canSwing() && !(S.bigMap && ph === 'aim')) return;
      if (S.bigMap) {
        if (inMap(q)) {
          var m = S.mmRect, wx = S.mm.x0 + (q.x - m.x) / m.k, wy = S.H.L - 1 - (q.y - m.y) / m.k, s = S.g.hs.b[S.g.cur];
          S.aim.yaw = aimYaw(s.x, s.y, wx, wy); aimChanged(); sfx('tick');
        }
        S.bigMap = false; return;
      }
      if (inMap(q)) { S.bigMap = true; sfx('click'); return; }
      if (S.meter.st) { meterPress(); return; }
      try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
      S.sw = { id: e.pointerId, pts: [q], sx: q.x, sy: q.y, bx: q.x, by: q.y, bt: q.t, phase: 'back', back: 0, vmax: 0 };
    });
    S.cv.addEventListener('pointermove', function (e) {
      if (!S) return;
      var sw = S.sw;
      if (!sw || sw.id !== e.pointerId) return;
      if (!canSwing()) { S.sw = null; return; }
      var q = stagePt(e), putt = S.aim.club === PUTTER;
      sw.pts.push(q);
      if (sw.pts.length > 160) sw.pts.splice(0, 40);
      if (sw.phase === 'back') {
        if (q.y >= sw.by) { sw.by = q.y; sw.bx = q.x; sw.bt = q.t; }
        sw.back = sw.by - sw.sy;
        if (sw.back > 16 && q.y < sw.by - 6) { sw.phase = 'up'; sw.vmax = 0; }
      } else {
        if (q.y > sw.by + 8) { sw.phase = 'back'; sw.by = q.y; sw.bx = q.x; sw.bt = q.t; sw.back = sw.by - sw.sy; return; }
        // the up-stroke's speed over the last ~50 ms
        for (var i = sw.pts.length - 2; i >= 0; i--) {
          var o = sw.pts[i];
          if (q.t - o.t >= 0.045 || i === 0) { var v = (o.y - q.y) / Math.max(0.008, q.t - o.t); if (v > sw.vmax) sw.vmax = v; break; }
        }
        var up = sw.by - q.y;
        if (up >= sw.back * (putt ? 0.5 : 0.85) + 4) swingStrike(q);
      }
    });
    function swingStrike(q) {
      var sw = S.sw, putt = S.aim.club === PUTTER, up = sw.by - q.y, ang = Math.atan2(q.x - sw.bx, Math.max(1, up));
      var dev = devFromStroke(ang, S.g.diff, S.eq), pw;
      if (putt) { pw = clamp(sw.back / puttFull(), 0.01, 1); dev *= 0.7; }
      else {
        var avg = up / Math.max(0.016, q.t - sw.bt);
        pw = clamp(Math.max(sw.vmax, avg) / swingFull(), 0.05, 1.15);
      }
      S.sw = null;
      strike(pw, dev);
    }
    function endPtr(e, cancel) {
      if (!S) return;
      if (S.eswipe && S.eswipe.id === e.pointerId) {
        var q0 = stagePt(e), es = S.eswipe, dx = q0.x - es.x, dy = q0.y - es.y;
        S.eswipe = null;
        if (!cancel && Math.abs(dx) + Math.abs(dy) > 24) {
          if (Math.abs(dx) > Math.abs(dy)) applyEng(clamp(dx / 160, -1, 1) * 0.6, 0); else applyEng(0, clamp(-dy / 160, -1, 1) * 0.6);
        }
        return;
      }
      var sw = S.sw;
      if (!sw || sw.id !== e.pointerId) return;
      var q = stagePt(e);
      if (!cancel && sw.phase === 'up' && sw.by - q.y > sw.back * 0.35 && canSwing()) { sw.pts.push(q); swingStrike(q); return; }
      S.sw = null;
      if (!cancel && canSwing()) {
        if (sw.back > 16) say('PUSH UP!', 'pull down, then flick up to swing', S.col.hudMu, 1.3);
        else if (Math.abs(q.x - sw.sx) < 8 && Math.abs(q.y - sw.sy) < 8) say('SWING', S.aim.club === PUTTER ? 'drag down for distance, push up to putt' : 'drag down, then flick up fast', S.col.hudMu, 1.3);
      }
    }
    S.cv.addEventListener('pointerup', function (e) { endPtr(e, false); });
    S.cv.addEventListener('pointercancel', function (e) { endPtr(e, true); });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      var k = b.getAttribute('data-hold');
      S.held[k] = 1; b.classList.add('on');
      if (canSwing() && !S.meter.st) { S.aim.yaw += (k === 'l' ? -1 : 1) * (S.putting ? 0.004 : 0.008); aimChanged(); redraw(); }
    });
    function padUp(e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      S.held[b.getAttribute('data-hold')] = 0; b.classList.remove('on');
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, padUp); });
    S.pad.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (b && S) padAction(b.getAttribute('data-act'));
    });
    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var su = S.save.set, a = b.getAttribute('data-act'), d = b.dataset, re = true;
      if (d.tab) { S.tab = d.tab; S.resetArm = false; setPad('menu'); }
      else if (d.theme) su.theme = d.theme;
      else if (d.holes) su.holes = +d.holes;
      else if (d.seat != null) { var i = +d.seat; su.seats[i] = su.seats[i] ? 0 : 1; }
      else if (d.lvl) su.lvl = +d.lvl;
      else if (d.diff) su.diff = +d.diff;
      else if (d.gim) su.gim = +d.gim;
      else if (d.det) { su.det = +d.det; setupRaster(); }
      else if (d.tour) { var ti = +d.tour; if (ti <= S.save.car.unlocked) S.save.car.tour = ti; else Cade.showToast && Cade.showToast('Finish top 3 on the ' + TOURS[ti - 1].name + ' money list to unlock', 'info', 2200); }
      else if (d.buy) {
        var car = S.save.car, it = SHOP.filter(function (x) { return x.id === d.buy; })[0], lv = car.eq[d.buy] | 0;
        if (it && lv < 3 && car.money >= it.cost[lv]) { car.money -= it.cost[lv]; car.eq[d.buy] = lv + 1; sfx('fan'); persist(); }
        showCard('shop'); return;
      }
      else if (a === 'seat-add') { if (su.seats.length < 4) su.seats.push(1); }
      else if (a === 'seat-del') { if (su.seats.length > 1) su.seats.pop(); }
      else if (a === 'reseed') su.seed = (Math.random() * 4294967296) >>> 0;
      else if (a === 'resume-round') { if (S.resume) resumeRound(S.resume); return; }
      else if (a === 'tour-go') { startTourEvent(); return; }
      else if (a === 'ctp' || a === 'drive') { startChallenge(a); return; }
      else if (a === 'shop') { showCard('shop'); return; }
      else if (a === 'shop-close') { showCard('menu'); return; }
      else if (a === 'reset') S.resetArm = true;
      else if (a === 'reset-no') S.resetArm = false;
      else if (a === 'reset-yes') { var keep = S.save.set; S.save = newSave(); S.save.set = keep; S.resetArm = false; sdel(ROUND_KEY); S.resume = null; Cade.showToast && Cade.showToast('Records and career reset', 'info', 1600); }
      else if (a === 'close-help') { S.firstRun = false; showCard(S.paused ? 'pause' : S.phase === 'menu' ? 'menu' : null); return; }
      else if (a === 'resume') { resume(); return; }
      else if (a === 'quit') { if (S.quitArm) quitRound(); else { S.quitArm = true; showCard('pause'); } return; }
      else if (a === 'close-card') { closeSubCard(); return; }
      else re = false;
      if (!re) return;
      persist();
      sfx('click');
      if (S.phase === 'menu') {
        if (d.theme || a === 'reseed' || d.diff) { toMenu(); }
        else showCard('menu');
        var sel = e.detail === 0 && S.ovl.querySelector('[data-' + (d.tab ? 'tab="' + d.tab : d.theme ? 'theme="' + d.theme : d.holes ? 'holes="' + d.holes : d.diff ? 'diff="' + d.diff : 'act="' + a) + '"]');
        if (sel) { try { sel.focus({ preventScroll: true }); } catch (er) {} }
      }
    });

    S.resume = loadSavedRound();
    toMenu();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); if (S.phase === 'menu') toMenu(); else redraw(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Arcade 3D golf — swipe-swing power and spin, wind, procedural 18-hole courses and a pro tour career',
    icon: '🏌',
    tags: 'game,sport,golf,arcade,career,swing,course,2 player,cpu,fun',
    open: open,
    _engine: ENGINE
  });
})();
