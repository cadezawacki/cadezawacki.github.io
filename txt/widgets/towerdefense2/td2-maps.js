/* Tower Defense V2 (Glyph Defense) — the maps.
 * Each map is a compact spec: its size, the roads (axis-aligned waypoints that
 * enter from just outside the grid and leave just outside it), optional air
 * routes, terrain features and a seeded scatter. build() turns a spec into the
 * tile grid the engine and renderer use; ascii() previews one in a terminal.
 * Pure data + pure functions: loaded by td2.js on open, and by node tests.
 *
 * Tiles: GRASS '.' build · HIGH ':' build (+15% range for direct attackers) ·
 * SHORE ',' build (dry land next to water, derived) · WATER '~' water towers
 * only · ROAD '#' · RIDGE '^' blocks line of sight, no building · LAVA '%' no
 * building · VOID ' ' no building (a hole in the sky). */
(function (root) {
  'use strict';

  var T = { GRASS: 0, ROAD: 1, RIDGE: 2, WATER: 3, HIGH: 4, SHORE: 5, LAVA: 6, VOID: 7 };
  var KIND = { grass: 0, ridge: 2, water: 3, high: 4, lava: 6, void: 7 };
  var CH = ['.', '#', '^', '~', ':', ',', '%', ' '];

  // xorshift32: deterministic, the same in every engine.
  function rng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  // Smooth value noise in [0,1): a lattice every `sc` cells, bilinear between.
  function noiseField(seed, w, h, sc) {
    var r = rng(seed), gw = Math.ceil(w / sc) + 2, gh = Math.ceil(h / sc) + 2, lat = [], out = new Float32Array(w * h), i, x, y;
    for (i = 0; i < gw * gh; i++) lat.push(r());
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var fx = x / sc, fy = y / sc, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      var a = lat[y0 * gw + x0], b = lat[y0 * gw + x0 + 1], c = lat[(y0 + 1) * gw + x0], d = lat[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
    return out;
  }

  // Every in-grid cell an axis-aligned waypoint list walks through, in order.
  function pathCells(pts, w, h) {
    var out = [];
    for (var i = 1; i < pts.length; i++) {
      var x = pts[i - 1][0], y = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      var dx = x1 > x ? 1 : x1 < x ? -1 : 0, dy = y1 > y ? 1 : y1 < y ? -1 : 0;
      while (true) {
        if (x >= 0 && x < w && y >= 0 && y < h && (!out.length || out[out.length - 1] !== y * w + x)) out.push(y * w + x);
        if (x === x1 && y === y1) break;
        x += dx; y += dy;
      }
    }
    return out;
  }

  // Spec -> { w, h, grid (Uint8Array of T), roads: [[cell...] per path] }.
  // Order: grass, then the seeded scatter (clustered by noise), then the
  // features in order (each overrides), then the roads, then shores.
  function build(M) {
    var w = M.w, h = M.h, n = w * h, grid = new Uint8Array(n), i, x, y, k;
    var fill = M.fill || {}, kinds = ['ridge', 'water', 'high', 'lava', 'void'];
    for (k = 0; k < kinds.length; k++) {
      var dens = fill[kinds[k]] || 0;
      if (dens <= 0) continue;
      var nf = noiseField((M.seed | 0) * 7919 + k * 104729 + 17, w, h, kinds[k] === 'high' || kinds[k] === 'water' ? 4 : 3);
      // threshold so roughly `dens` of the cells pass, clustered
      var sorted = Array.prototype.slice.call(nf).sort(function (a, b) { return b - a; });
      var cut = sorted[Math.min(n - 1, Math.floor(n * dens))];
      for (i = 0; i < n; i++) if (nf[i] > cut && grid[i] === T.GRASS) grid[i] = KIND[kinds[k]];
    }
    var F = M.feat || [];
    for (k = 0; k < F.length; k++) {
      var f = F[k], t = KIND[f[0]], s = f[1];
      if (t == null) throw new Error(M.id + ': unknown feature kind ' + f[0]);
      if (s === 'r') {
        for (y = f[3]; y < f[3] + f[5]; y++) for (x = f[2]; x < f[2] + f[4]; x++) if (x >= 0 && y >= 0 && x < w && y < h) grid[y * w + x] = t;
      } else if (s === 'e') {
        var cx = f[2], cy = f[3], rx = f[4], ry = f[5];
        for (y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          var ex = (x + 0.5 - cx) / rx, ey = (y + 0.5 - cy) / ry;
          if (ex * ex + ey * ey <= 1) grid[y * w + x] = t;
        }
      } else throw new Error(M.id + ': unknown feature shape ' + s);
    }
    var roads = [];
    for (k = 0; k < M.paths.length; k++) {
      var cells = pathCells(M.paths[k], w, h);
      for (i = 0; i < cells.length; i++) grid[cells[i]] = T.ROAD;
      roads.push(cells);
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      if (grid[i] !== T.GRASS) continue;
      if ((x > 0 && grid[i - 1] === T.WATER) || (x < w - 1 && grid[i + 1] === T.WATER) ||
        (y > 0 && grid[i - w] === T.WATER) || (y < h - 1 && grid[i + w] === T.WATER)) grid[i] = T.SHORE;
    }
    return { w: w, h: h, grid: grid, roads: roads };
  }

  function ascii(M) {
    var B = build(M), s = '', x, y;
    for (y = 0; y < B.h; y++) {
      for (x = 0; x < B.w; x++) s += CH[B.grid[y * B.w + x]];
      s += '\n';
    }
    return s;
  }

  // Structural checks (the node test runs these on every map).
  function validate(M) {
    var errs = [], B;
    if (!M.id || !M.name || !(M.w >= 8) || !(M.h >= 8)) errs.push('id/name/size');
    try { B = build(M); } catch (e) { return [String(e.message || e)]; }
    var w = M.w, h = M.h, k, i;
    function outside(p) { return p[0] < 0 || p[1] < 0 || p[0] >= w || p[1] >= h; }
    function justOutside(p) { return (p[0] === -1 || p[0] === w || p[1] === -1 || p[1] === h) && p[0] >= -1 && p[0] <= w && p[1] >= -1 && p[1] <= h; }
    for (k = 0; k < M.paths.length; k++) {
      var P = M.paths[k];
      if (P.length < 2) { errs.push('path ' + k + ' too short'); continue; }
      for (i = 0; i < P.length; i++) if ((P[i][0] | 0) !== P[i][0] || (P[i][1] | 0) !== P[i][1]) errs.push('path ' + k + ' point ' + i + ' not integer');
      for (i = 1; i < P.length; i++) if (P[i][0] !== P[i - 1][0] && P[i][1] !== P[i - 1][1]) errs.push('path ' + k + ' segment ' + i + ' not axis-aligned');
      if (!justOutside(P[0])) errs.push('path ' + k + ' must start one step outside the grid');
      if (!justOutside(P[P.length - 1])) errs.push('path ' + k + ' must end one step outside the grid');
      for (i = 1; i < P.length - 1; i++) if (outside(P[i])) errs.push('path ' + k + ' leaves the grid at point ' + i);
      if (B.roads[k].length < 12) errs.push('path ' + k + ' under 12 road cells');
    }
    if (M.air) for (k = 0; k < M.air.length; k++) {
      var A = M.air[k];
      if (!A) continue;
      if (A.length < 2 || !outside(A[0]) || !outside(A[A.length - 1])) errs.push('air ' + k + ' must start and end outside the grid');
    }
    var build_ = 0, road = 0;
    for (i = 0; i < B.grid.length; i++) {
      var t = B.grid[i];
      if (t === T.GRASS || t === T.HIGH || t === T.SHORE) build_++;
      if (t === T.ROAD) road++;
    }
    if (build_ < (B.grid.length - road) * 0.35) errs.push('too little buildable land (' + build_ + ')');
    return errs;
  }

  var REGIONS = [
    { id: 'margins', name: 'The Margins', biome: 'meadow', blurb: 'Green meadows along the edge of a well-kept notebook.' },
    { id: 'dunes', name: 'Sandscript Dunes', biome: 'dunes', blurb: 'Wind-written sand, flat-topped mesas and rare oases.' },
    { id: 'tundra', name: 'Frostmark Tundra', biome: 'tundra', blurb: 'Snowfields, frozen lakes and ridges of blue ice.' },
    { id: 'marsh', name: 'Bogwrite Marsh', biome: 'marsh', blurb: 'Ink-dark water, whispering reeds, slow causeways.' },
    { id: 'cinder', name: 'Cinder Press', biome: 'cinder', blurb: 'A volcanic press where lava runs like spilled ink.' },
    { id: 'sky', name: 'Skyglyph Spires', biome: 'sky', blurb: 'Floating islands strung together by fragile bridges.' },
    { id: 'archive', name: 'The Redacted Archive', biome: 'archive', blurb: 'An endless library of shelves and blacked-out lines.' }
  ];

  var MAPS = [
    // ---- Region 0: The Margins (meadow) ----

    // 1. Tutorial: one gentle S, a pond in the bend, two rocks.
    { id: 'ruled-lines', name: 'Ruled Lines', region: 0, w: 12, h: 16, biome: 'meadow', seed: 3, ultra: false,
      blurb: 'A gentle first page. Follow the line.',
      paths: [ [[2,-1],[2,3],[9,3],[9,10],[2,10],[2,16]] ],
      feat: [ ['water','e',5.5,6.5,2.1,1.6], ['ridge','r',5,1,1,1], ['ridge','r',10,13,1,1], ['high','e',7.5,13.5,2.2,1.3] ],
      fill: { ridge: 0, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 2. Two gates in the top-left corner merge mid-page; the corner is folded.
    { id: 'dog-ear', name: 'Dog-Ear', region: 0, w: 12, h: 16, biome: 'meadow', seed: 11, ultra: false,
      blurb: 'Two lines of ink meet where the page was folded.',
      paths: [ [[2,-1],[2,3],[9,3],[9,6],[5,6],[5,9],[8,9],[8,13],[10,13],[10,16]],
               [[-1,5],[1,5],[1,14],[4,14],[4,9],[8,9],[8,13],[10,13],[10,16]] ],
      feat: [ ['high','r',9,0,3,1], ['high','r',10,1,2,1], ['high','r',11,2,1,1], ['water','e',10.6,9.6,1.3,2.2], ['ridge','r',3,7,1,1], ['ridge','r',6,15,1,1] ],
      fill: { ridge: 0.02, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 3. The road almost circles a big pond, then slips out to the east.
    { id: 'inkwell', name: 'Inkwell Pond', region: 0, w: 14, h: 18, biome: 'meadow', seed: 5, ultra: false,
      blurb: 'Round and round the inkwell, then off the page.',
      paths: [ [[11,-1],[11,2],[2,2],[2,15],[11,15],[11,6],[14,6]] ],
      feat: [ ['water','e',7,8.8,3.0,4.7], ['grass','e',7,8.6,1.1,1.5], ['high','e',13,13,1.5,3], ['ridge','r',0,8,1,2] ],
      fill: { ridge: 0.02, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 4. Long and narrow: teeth first, then tight switchbacks. Rocks between legs.
    { id: 'gutter', name: 'The Gutter', region: 0, w: 12, h: 20, biome: 'meadow', seed: 7, ultra: false,
      blurb: 'Where the binding pinches the page tight.',
      paths: [ [[10,20],[10,18],[8,18],[8,13],[5,13],[5,18],[2,18],[2,10],[10,10],[10,7],[1,7],[1,4],[10,4],[10,1],[1,1],[1,-1]] ],
      feat: [ ['ridge','r',4,2,3,1], ['ridge','r',5,6,3,1], ['ridge','r',3,8,3,1], ['ridge','r',3,14,1,3], ['ridge','r',7,15,1,2], ['high','r',10,12,2,4] ],
      fill: { ridge: 0, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 5. ULTRA: two long roads cross once, then both bridge the river.
    { id: 'long-margin', name: 'The Long Margin', region: 0, w: 26, h: 44, biome: 'meadow', seed: 2, ultra: true,
      blurb: 'Two roads, one river, and a very long margin.',
      paths: [ [[13,-1],[13,3],[22,3],[22,8],[16,8],[16,13],[22,13],[22,18],[13,18],[13,26],[4,26],[4,34],[10,34],[10,39],[3,39],[3,44]],
               [[-1,4],[10,4],[10,10],[3,10],[3,16],[10,16],[10,21],[18,21],[18,24],[23,24],[23,32],[16,32],[16,37],[22,37],[22,42],[26,42]] ],
      feat: [ ['water','e',3,29.5,4.5,1.3], ['water','e',11,30,4.5,1.5], ['water','e',18.5,29.2,4.5,1.4], ['water','e',24.5,28.6,3,1.3],
              ['water','e',6.5,7,2,1.2], ['water','e',19,15.5,1.6,1], ['grass','e',7,30,1,0.8],
              ['high','e',19,10.5,2,1.5], ['high','e',6.5,13,2.5,1.5], ['high','e',18,40,3.5,2], ['high','e',24.5,6,1.5,3], ['high','e',7,21,2.5,1.5] ],
      fill: { ridge: 0.03, water: 0, high: 0.03, lava: 0, void: 0 } },

    // ---- Region 1: Sandscript Dunes ----

    // 6. The road loops all the way round an oasis and crosses itself.
    { id: 'oasis-loop', name: 'Oasis Loop', region: 1, w: 14, h: 16, biome: 'dunes', seed: 9, ultra: false,
      blurb: 'One lap around the oasis, then back into the sand.',
      paths: [ [[4,16],[4,2],[11,2],[11,12],[-1,12]] ],
      feat: [ ['water','e',8,7.5,2.1,3.6], ['high','e',1.5,4,1.5,2.5], ['high','e',9.5,14.5,2.5,1] ],
      fill: { ridge: 0.07, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 7. Ridges everywhere; the road weaves through the dune sea.
    { id: 'dune-sea', name: 'Dune Sea', region: 1, w: 16, h: 18, biome: 'dunes', seed: 4, ultra: false,
      blurb: 'Every dune hides a line of sight. Choose well.',
      paths: [ [[16,2],[12,2],[12,5],[7,5],[7,2],[2,2],[2,9],[8,9],[8,12],[13,12],[13,16],[6,16],[6,18]] ],
      feat: [ ['ridge','r',9,3,2,1], ['ridge','r',4,5,2,1], ['ridge','r',14,6,1,3], ['ridge','e',10.5,8,2,0.5], ['ridge','e',4,12.5,2.2,0.5],
              ['ridge','e',2.5,15.5,1.5,0.5], ['ridge','r',10,14,2,1], ['ridge','r',15,13,1,3], ['ridge','r',0,4,1,3], ['ridge','r',4,0,3,1] ],
      fill: { ridge: 0.05, water: 0, high: 0.05, lava: 0, void: 0 } },

    // 8. Three long switchbacks over highland mesas.
    { id: 'caravan-road', name: 'Caravan Road', region: 1, w: 12, h: 22, biome: 'dunes', seed: 6, ultra: false,
      blurb: 'The caravans take the long way over the mesas.',
      paths: [ [[1,-1],[1,20],[4,20],[4,2],[7,2],[7,20],[10,20],[10,3],[12,3]] ],
      feat: [ ['high','e',3,6,3,3.5], ['high','e',8.5,13,3,3.5], ['high','e',2.5,16.5,2.2,2] ],
      fill: { ridge: 0.05, water: 0, high: 0, lava: 0, void: 0 } },

    // 9. Two plateaus; the routes cross in an X between them.
    { id: 'twin-mesa', name: 'Twin Mesa', region: 1, w: 16, h: 18, biome: 'dunes', seed: 8, ultra: false,
      blurb: 'Two mesas stand guard where the trails cross.',
      paths: [ [[2,-1],[2,4],[5,4],[5,9],[11,9],[11,14],[14,14],[14,18]],
               [[16,2],[13,2],[13,6],[8,6],[8,12],[3,12],[3,16],[-1,16]] ],
      feat: [ ['high','e',2.2,8.5,2.2,2.6], ['high','e',13.8,9.5,2.2,2.6], ['ridge','r',0,6,1,1], ['ridge','r',0,11,1,1], ['ridge','r',15,7,1,1], ['ridge','r',15,12,1,1],
              ['water','e',7,15.5,1.5,1] ],
      fill: { ridge: 0.04, water: 0, high: 0, lava: 0, void: 0 } },

    // 10. ULTRA: three caravans (two west, one north) join and leave east.
    { id: 'sandscript', name: 'The Sandscript', region: 1, w: 40, h: 28, biome: 'dunes', seed: 12, ultra: true,
      blurb: 'Three caravans, one road out, and miles of sand.',
      paths: [ [[-1,3],[10,3],[10,8],[4,8],[4,13],[14,13],[14,8],[19,8],[19,22],[25,22],[25,12],[32,12],[32,22],[37,22],[37,14],[40,14]],
               [[-1,24],[9,24],[9,20],[3,20],[3,16],[14,16],[14,8],[19,8],[19,22],[25,22],[25,12],[32,12],[32,22],[37,22],[37,14],[40,14]],
               [[36,-1],[36,7],[31,7],[31,2],[18,2],[18,5],[28,5],[28,9],[22,9],[22,15],[25,15],[25,12],[32,12],[32,22],[37,22],[37,14],[40,14]] ],
      feat: [ ['water','e',26,25.5,4,1.8], ['water','e',7,11,1.2,0.8], ['high','e',8,18,3,1.2], ['high','e',34,3,1.8,2.5], ['high','e',29,17.5,2,3], ['high','e',14,19.5,3,1.5],
              ['ridge','e',12,25,3,0.6], ['ridge','e',5,27,2.5,0.5], ['ridge','e',35,25.5,2.5,0.6], ['ridge','e',15,4.5,1.5,0.6], ['ridge','e',39,9,0.6,2.5] ],
      fill: { ridge: 0.05, water: 0, high: 0.03, lava: 0, void: 0 } },

    // ---- Region 2: Frostmark Tundra ----

    // 11. Open snow, one long stepped snake.
    { id: 'permafrost', name: 'Permafrost', region: 2, w: 14, h: 18, biome: 'tundra', seed: 13, ultra: false,
      blurb: 'Open snow and a long, patient road.',
      paths: [ [[-1,2],[9,2],[9,4],[12,4],[12,8],[3,8],[3,12],[7,12],[7,15],[11,15],[11,18]] ],
      feat: [ ['water','e',8.5,10.5,1.8,1.3], ['water','e',2,15.5,1.2,1.2] ],
      fill: { ridge: 0.07, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 12. A big bay on the east; the road hugs its shore.
    { id: 'icebreaker-bay', name: 'Icebreaker Bay', region: 2, w: 16, h: 18, biome: 'tundra', seed: 14, ultra: false,
      blurb: 'The road hugs the shore of a cold, deep bay.',
      paths: [ [[2,-1],[2,2],[9,2],[9,6],[5,6],[5,9],[9,9],[9,13],[4,13],[4,16],[12,16],[12,18]] ],
      feat: [ ['water','e',15.5,9.5,6,7.8], ['water','r',14,0,2,18], ['grass','e',13.5,9,1,1.3], ['grass','e',12.5,4.5,0.8,0.8], ['water','e',6.5,11.5,1.6,1.2] ],
      fill: { ridge: 0.04, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 13. Two roads squeeze through one toll lane, then part again.
    { id: 'tollgate', name: 'Tollgate', region: 2, w: 14, h: 16, biome: 'tundra', seed: 15, ultra: false,
      blurb: 'Everyone pays the toll. Make sure of it.',
      paths: [ [[-1,1],[5,1],[5,4],[2,4],[2,7],[7,7],[7,11],[2,11],[2,16]],
               [[14,1],[9,1],[9,4],[12,4],[12,7],[7,7],[7,11],[12,11],[12,14],[14,14]] ],
      feat: [ ['high','r',6,2,3,3], ['water','e',7,14,2.6,1.4], ['ridge','r',5,9,1,1], ['ridge','r',9,9,1,1] ],
      fill: { ridge: 0.02, water: 0, high: 0.02, lava: 0, void: 0 } },

    // 14. Maze of ice corridors.
    { id: 'whiteout', name: 'Whiteout', region: 2, w: 16, h: 20, biome: 'tundra', seed: 16, ultra: false,
      blurb: 'Ice walls everywhere. You can barely see the road.',
      paths: [ [[5,-1],[5,2],[1,2],[1,7],[5,7],[5,5],[9,5],[9,1],[14,1],[14,8],[10,8],[10,11],[14,11],[14,15],[9,15],[9,18],[3,18],[3,11],[-1,11]] ],
      feat: [ ['ridge','r',7,0,1,3], ['ridge','r',11,3,2,3], ['ridge','r',3,4,1,2], ['ridge','r',5,10,4,1], ['ridge','r',5,13,1,3], ['ridge','r',7,13,1,1],
              ['ridge','r',1,14,1,4], ['ridge','r',11,13,2,1], ['ridge','r',11,17,3,1] ],
      fill: { ridge: 0.02, water: 0, high: 0.02, lava: 0, void: 0 } },

    // 15. ULTRA: two long roads share a causeway over the great frozen lake.
    { id: 'long-winter', name: 'The Long Winter', region: 2, w: 30, h: 40, biome: 'tundra', seed: 51, ultra: true,
      blurb: 'A long road, a frozen lake, and no spring in sight.',
      paths: [ [[5,-1],[5,4],[10,4],[10,9],[3,9],[3,14],[11,14],[11,12],[15,12],[15,26],[6,26],[6,31],[12,31],[12,36],[8,36],[8,38],[-1,38]],
               [[30,8],[24,8],[24,3],[17,3],[17,10],[26,10],[26,16],[15,16],[15,29],[22,29],[22,33],[17,33],[17,37],[24,37],[24,40]] ],
      feat: [ ['water','e',15,21,8,2.4], ['water','e',25.5,22.5,2.5,3], ['water','e',4,21.5,2.5,3], ['water','e',20.5,6.5,2,1.5], ['water','e',7.5,6.5,1.5,1],
              ['water','e',26,33,2.5,2], ['water','e',3,33,2,2.5], ['water','e',27.5,3,1.5,2] ],
      fill: { ridge: 0.05, water: 0, high: 0.04, lava: 0, void: 0 } },

    // ---- Region 3: Bogwrite Marsh ----

    // 16. Three reed channels; the road wades across each one.
    { id: 'reedway', name: 'Reedway', region: 3, w: 14, h: 18, biome: 'marsh', seed: 18, ultra: false,
      blurb: 'Wade the channels. Mind the reeds.',
      paths: [ [[2,-1],[2,6],[11,6],[11,11],[4,11],[4,16],[14,16]] ],
      feat: [ ['water','e',9,2.2,4.5,1.2], ['water','e',4,3.4,3,1.0], ['water','e',4.5,8.6,4,1.0], ['water','e',10,9.6,3.5,1.1],
              ['water','e',9.5,13.4,4,1.0], ['water','e',3.5,14.2,3,1.0] ],
      fill: { ridge: 0.02, water: 0.02, high: 0.03, lava: 0, void: 0 } },

    // 17. Sunken islands joined by causeways.
    { id: 'sunken-script', name: 'Sunken Script', region: 3, w: 16, h: 16, biome: 'marsh', seed: 19, ultra: false,
      blurb: 'The old letters sank. Only the causeways remain.',
      paths: [ [[16,12],[12,12],[12,7],[8,7],[8,3],[3,3],[3,12],[7,12],[7,16]] ],
      feat: [ ['water','r',0,0,16,16], ['grass','e',3.5,3.5,3.5,3], ['grass','e',12,2.5,3.2,2.2], ['grass','e',10,7.5,3.2,2.4], ['grass','e',3,12,3.2,3],
              ['grass','e',13,12.5,3,2.8], ['grass','e',7.5,14.8,2.4,1.6] ],
      fill: { ridge: 0.02, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 18. A long, wandering road through mist, pools and mounds.
    { id: 'wisp-hollow', name: "Will-o'-Wisp Hollow", region: 3, w: 14, h: 20, biome: 'marsh', seed: 20, ultra: false,
      blurb: 'Lights drift over the pools. Do not follow them.',
      paths: [ [[3,20],[3,15],[9,15],[9,18],[12,18],[12,10],[5,10],[5,6],[10,6],[10,2],[2,2],[2,-1]] ],
      feat: [ ['water','e',7.5,12.5,2,1.2], ['water','e',2.5,8,1.2,1.8], ['water','e',12,5.5,1.2,1.8], ['high','e',8,8,1.6,1], ['high','e',6.5,17.3,1.8,1.2],
              ['ridge','r',7,4,1,1], ['ridge','r',11,16,1,1], ['ridge','r',1,15,1,1] ],
      fill: { ridge: 0.02, water: 0.03, high: 0.08, lava: 0, void: 0 } },

    // 19. Three roots tangle, cross, and become one.
    { id: 'mangrove-knot', name: 'Mangrove Knot', region: 3, w: 18, h: 18, biome: 'marsh', seed: 22, ultra: false,
      blurb: 'Three roads tie themselves in a knot of roots.',
      paths: [ [[3,-1],[3,14],[9,14],[9,16],[15,16],[15,18]],
               [[-1,4],[13,4],[13,10],[9,10],[9,16],[15,16],[15,18]],
               [[18,7],[6,7],[6,11],[9,11],[9,16],[15,16],[15,18]] ],
      feat: [ ['water','e',15.5,12.5,2,2] ],
      fill: { ridge: 0.02, water: 0.12, high: 0.03, lava: 0, void: 0 } },

    // 20. ULTRA: four gates, two exits, bog everywhere.
    { id: 'great-bog', name: 'The Great Bog', region: 3, w: 36, h: 36, biome: 'marsh', seed: 23, ultra: true,
      blurb: 'From every side they come, and the bog takes its toll.',
      paths: [ [[3,-1],[3,9],[7,9],[7,2],[11,2],[11,9],[15,9],[15,24],[2,24],[2,28],[14,28],[14,32],[3,32],[3,36]],
               [[-1,12],[4,12],[4,21],[8,21],[8,13],[12,13],[12,20],[15,20],[15,24],[2,24],[2,28],[14,28],[14,32],[3,32],[3,36]],
               [[32,36],[32,26],[28,26],[28,33],[24,33],[24,26],[20,26],[20,11],[33,11],[33,7],[21,7],[21,3],[32,3],[32,-1]],
               [[36,23],[31,23],[31,14],[27,14],[27,22],[23,22],[23,15],[20,15],[20,11],[33,11],[33,7],[21,7],[21,3],[32,3],[32,-1]] ],
      feat: [ ['water','e',17.5,4,1.2,4], ['water','e',18,13,1.4,5], ['water','e',17.5,23,1.4,5], ['water','e',18,32,1.2,4],   // the central channel
              ['water','e',9,5.5,0.8,2], ['water','e',26.5,30,0.8,2], ['water','e',6,17,0.8,2.5], ['water','e',29.5,18.5,0.8,2.5],
              ['water','e',8,30,4,1], ['water','e',28,5,4,1], ['water','e',1.5,17,1,3], ['water','e',34,18.5,1,3],
              ['water','e',27,1,4,0.8], ['water','e',9,34.5,4,0.8], ['grass','e',17.8,18,1,1.2] ],
      fill: { ridge: 0.02, water: 0.06, high: 0.04, lava: 0, void: 0 } },

    // ---- Region 4: Cinder Press ----

    // 21. Long straight conveyor runs between lava pools.
    { id: 'forge-row', name: 'Forge Row', region: 4, w: 14, h: 18, biome: 'cinder', seed: 24, ultra: false,
      blurb: 'Straight lines, hot pools, no shade.',
      paths: [ [[-1,2],[12,2],[12,7],[1,7],[1,12],[12,12],[12,16],[-1,16]] ],
      feat: [ ['lava','r',3,4,3,2], ['lava','r',8,4,3,2], ['lava','r',4,9,6,2], ['lava','r',3,14,3,1], ['lava','r',8,14,3,1],
              ['high','r',11,9,2,2], ['high','r',2,9,1,2], ['ridge','r',0,4,1,2], ['ridge','r',13,4,1,2], ['ridge','r',13,13,1,2], ['ridge','r',5,0,2,1], ['high','r',6,4,2,2] ],
      fill: { ridge: 0.01, water: 0, high: 0, lava: 0, void: 0 } },

    // 22. Two parallel lanes with a lava river between them.
    { id: 'lava-lanes', name: 'Lava Lanes', region: 4, w: 16, h: 20, biome: 'cinder', seed: 25, ultra: false,
      blurb: 'Two lanes, one river of fire between them.',
      paths: [ [[3,-1],[3,3],[5,3],[5,7],[2,7],[2,12],[5,12],[5,16],[3,16],[3,20]],
               [[12,-1],[12,3],[10,3],[10,7],[13,7],[13,12],[10,12],[10,16],[12,16],[12,20]] ],
      feat: [ ['lava','e',7.5,4,1.1,4.5], ['lava','e',8,10,1.1,3], ['lava','e',7.5,16,1.1,4.5] ],
      fill: { ridge: 0.03, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 23. Spiral into the furnace, then straight out.
    { id: 'smelter-spiral', name: 'Smelter Spiral', region: 4, w: 16, h: 16, biome: 'cinder', seed: 26, ultra: false,
      blurb: 'Down the spiral, into the heat, and out again.',
      paths: [ [[13,-1],[13,14],[1,14],[1,3],[10,3],[10,11],[4,11],[4,6],[7,6],[7,-1]] ],
      feat: [ ['lava','e',7.5,8.5,1.4,1.4], ['lava','e',1,0.5,1.2,2], ['lava','r',14,15,2,1] ],
      fill: { ridge: 0.05, water: 0, high: 0.05, lava: 0.04, void: 0 } },

    // 24. Open ashfield: highlands, ridges, one long road.
    { id: 'ashfall', name: 'Ashfall', region: 4, w: 16, h: 20, biome: 'cinder', seed: 27, ultra: false,
      blurb: 'Grey ash settles on everything. Even the road.',
      paths: [ [[16,3],[9,3],[9,1],[2,1],[2,8],[7,8],[7,6],[13,6],[13,12],[3,12],[3,17],[9,17],[9,15],[14,15],[14,20]] ],
      feat: [ ['high','e',4.5,4.5,1.6,1.4], ['high','e',10,9,2,1.4], ['lava','e',6,15,1.2,1], ['lava','e',12,18.5,1,1], ['high','e',11.5,16.5,1.5,1], ['high','e',1,10.5,1.2,1.5] ],
      fill: { ridge: 0.09, water: 0, high: 0.02, lava: 0.04, void: 0 } },

    // 25. ULTRA: three routes cross two lava rivers and each other.
    { id: 'cinder-press', name: 'The Cinder Press', region: 4, w: 44, h: 28, biome: 'cinder', seed: 28, ultra: true,
      blurb: 'Three roads, two rivers of fire, one great press.',
      paths: [ [[-1,1],[10,1],[10,4],[2,4],[2,7],[9,7],[9,10],[33,10],[33,2],[37,2],[37,11],[41,11],[41,2],[44,2]],
               [[-1,26],[10,26],[10,23],[2,23],[2,19],[9,19],[9,21],[33,21],[33,26],[37,26],[37,16],[41,16],[41,25],[44,25]],
               [[15,-1],[15,2],[28,2],[28,6],[15,6],[15,14],[28,14],[28,18],[15,18],[15,24],[28,24],[28,28]] ],
      feat: [ ['lava','e',12.5,4,1.2,4.5], ['lava','e',13,13,1.2,5], ['lava','e',12.5,23,1.2,5],
              ['lava','e',31,5,1.2,5], ['lava','e',31.5,14,1.2,4.5], ['lava','e',31,23,1.2,5],
              ['lava','r',19,16,6,1], ['high','r',18,4,8,1], ['high','r',18,26,8,1], ['ridge','r',21,8,2,1], ['ridge','r',21,12,2,1], ['ridge','r',21,20,2,1], ['ridge','r',21,22,2,1],
              ['high','e',35,6.5,1,3], ['high','e',39,6.5,1,3.5], ['high','e',35,21,1,3], ['high','e',39,20.5,1,3.5], ['high','e',5,14,3,1.5] ],
      fill: { ridge: 0.03, water: 0, high: 0.02, lava: 0, void: 0 } },

    // ---- Region 5: Skyglyph Spires ----

    // 26. Cloud holes; flyers ride a curling updraft.
    { id: 'updraft', name: 'Updraft', region: 5, w: 14, h: 18, biome: 'sky', seed: 29, ultra: false,
      blurb: 'The wind curls upward. So do the flyers.',
      paths: [ [[4,-1],[4,4],[10,4],[10,9],[3,9],[3,14],[9,14],[9,18]] ],
      air: [ [[4.5,-1],[1.5,3],[5,6.5],[11.5,7],[12,11],[6,12.5],[2,15],[9.5,19]] ],
      feat: [ ['void','e',12.5,1.5,1.6,2.2], ['void','e',0.8,6,1.3,2.4], ['void','e',12.8,13,1.4,3], ['void','e',1.2,17,2,1.6], ['void','e',6.5,11.5,1.2,0.8] ],
      fill: { ridge: 0, water: 0, high: 0.05, lava: 0, void: 0.04 } },

    // 27. Islands in the sky, linked by one-cell bridges.
    { id: 'cloud-bridges', name: 'Cloud Bridges', region: 5, w: 16, h: 20, biome: 'sky', seed: 30, ultra: false,
      blurb: 'Island to island, one narrow bridge at a time.',
      paths: [ [[4,-1],[4,4],[12,4],[12,12],[4,12],[4,17],[16,17]] ],
      feat: [ ['void','r',0,0,16,20], ['grass','e',4,3.5,3.6,3.2], ['grass','e',12,4.5,3.6,3.6], ['grass','e',4.5,11,3.8,3.2], ['grass','e',11.5,12,3.4,3.4],
              ['grass','e',7.5,17.5,4.2,2.4], ['grass','e',8,8,0.8,0.8], ['grass','e',14.5,17,1,1] ],
      fill: { ridge: 0, water: 0, high: 0.05, lava: 0, void: 0 } },

    // 28. A tall spire; the road climbs in zig-zags.
    { id: 'pinnacle', name: 'Pinnacle', region: 5, w: 14, h: 20, biome: 'sky', seed: 31, ultra: false,
      blurb: 'Up and up the spire, with nothing on either side.',
      paths: [ [[3,20],[3,17],[10,17],[10,14],[3,14],[3,11],[10,11],[10,8],[4,8],[4,5],[9,5],[9,2],[5,2],[5,-1]] ],
      feat: [ ['void','r',0,0,14,20], ['grass','e',7,15.5,5.8,6], ['grass','e',7,8.5,4.8,5], ['grass','e',7,2.5,3.4,3.5], ['void','e',1.5,12.5,0.8,1.2], ['void','e',12.5,9.5,0.8,1],
              ['high','e',7,1.5,2.5,2] ],
      fill: { ridge: 0, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 29. Two separate roads; the jetstream between them carries the flyers.
    { id: 'jetstream', name: 'Jetstream', region: 5, w: 18, h: 18, biome: 'sky', seed: 32, ultra: false,
      blurb: 'Two roads, one wind, and flyers riding it both ways.',
      paths: [ [[-1,2],[4,2],[4,6],[9,6],[9,2],[14,2],[14,6],[18,6]],
               [[18,15],[13,15],[13,11],[8,11],[8,15],[3,15],[3,11],[-1,11]] ],
      air: [ [[-1,2.5],[4,8.5],[9,9],[14,8.5],[19,6.5]], [[19,15.5],[14,9.5],[9,8.5],[4,9.5],[-1,11.5]] ],
      feat: [ ['void','e',9,8.5,9.5,1.2], ['void','e',17,0.5,2,1.2], ['void','e',0.5,17.2,2,1.2], ['void','e',11.5,4.5,0.8,0.8], ['void','e',5.5,13.5,0.8,0.8] ],
      fill: { ridge: 0, water: 0, high: 0.05, lava: 0, void: 0.04 } },

    // 30. ULTRA: tall sky map of islands and gaps.
    { id: 'spires', name: 'The Spires', region: 5, w: 28, h: 48, biome: 'sky', seed: 33, ultra: true,
      blurb: 'A forest of spires above an endless drop.',
      paths: [ [[3,-1],[3,3],[7,3],[7,8],[1,8],[1,16],[7,16],[7,21],[1,21],[1,26],[7,26],[7,31],[1,31],[1,36],[7,36],[7,41],[14,41],[14,48]],
               [[24,-1],[24,4],[12,4],[12,8],[26,8],[26,13],[21,13],[21,18],[26,18],[26,23],[21,23],[21,28],[26,28],[26,33],[22,33],[22,44],[28,44]],
               [[-1,12],[16,12],[16,15],[11,15],[11,18],[16,18],[16,21],[11,21],[11,24],[16,24],[16,27],[11,27],[11,30],[16,30],[16,33],[11,33],[11,36],[22,36],[22,44],[28,44]] ],
      air: [ [[3.5,-1],[8,10],[4,24],[10,36],[14.5,49]], [[24.5,-1],[14,8],[22,20],[17,32],[29,44.5]], [[-1,12.5],[9,20],[14,30],[21,38],[29,44.5]] ],
      feat: [ ['void','r',8,0,2,48], ['void','r',18,0,2,48], ['void','e',7.6,24,0.9,2], ['void','e',10.4,31,0.9,2.5], ['void','e',17.6,20,0.9,2.5], ['void','e',20.4,40,0.9,2.5],
              ['void','r',0,18,8,2], ['void','r',0,33,8,2], ['void','r',10,10,8,1], ['void','r',10,39,8,1], ['void','r',20,15,8,2], ['void','r',20,30,8,2],
              ['void','e',4,12,1,1], ['void','e',24,40,1.5,1.5], ['void','e',4,45,1.5,1.2], ['high','e',4,5.5,1.5,1.2], ['high','e',23,2,2,1.2], ['high','e',13.5,25.5,1.2,0.8] ],
      fill: { ridge: 0, water: 0, high: 0.03, lava: 0, void: 0.02 } },

    // ---- Region 6: The Redacted Archive ----

    // 31. Three aisles between tall shelves.
    { id: 'stacks', name: 'The Stacks', region: 6, w: 16, h: 18, biome: 'archive', seed: 34, ultra: false,
      blurb: 'Up one aisle, down the next. Shelves block the view.',
      paths: [ [[2,-1],[2,15],[7,15],[7,2],[12,2],[12,18]] ],
      feat: [ ['ridge','r',4,1,2,5], ['ridge','r',4,8,2,5], ['ridge','r',9,4,2,5], ['ridge','r',9,11,2,4], ['ridge','r',14,4,1,4], ['ridge','r',14,11,1,4] ],
      fill: { ridge: 0, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 32. A grid maze of index cards.
    { id: 'card-index', name: 'Card Index', region: 6, w: 16, h: 20, biome: 'archive', seed: 35, ultra: false,
      blurb: 'Filed, cross-filed, and filed again.',
      paths: [ [[13,20],[13,16],[4,16],[4,13],[10,13],[10,10],[13,10],[13,1],[10,1],[10,4],[7,4],[7,10],[1,10],[1,4],[4,4],[4,-1]] ],
      feat: [ ['ridge','r',1,1,1,1], ['ridge','r',7,1,1,1], ['ridge','r',4,7,1,1], ['ridge','r',10,7,1,1], ['ridge','r',1,13,1,1], ['ridge','r',1,16,1,1],
              ['ridge','r',1,19,1,1], ['ridge','r',4,19,1,1], ['ridge','r',7,19,1,1], ['ridge','r',10,19,1,1], ['ridge','r',13,13,1,1], ['ridge','r',15,4,1,1], ['ridge','r',15,10,1,1],
              ['ridge','r',2,2,2,1], ['ridge','r',11,5,2,1], ['ridge','r',5,17,2,1], ['ridge','r',14,7,2,1] ],
      fill: { ridge: 0, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 33. Two routes written over each other: they cross twice.
    { id: 'palimpsest', name: 'Palimpsest', region: 6, w: 18, h: 20, biome: 'archive', seed: 36, ultra: false,
      blurb: 'Two texts on one page, crossing and recrossing.',
      paths: [ [[2,-1],[2,5],[13,5],[13,11],[6,11],[6,16],[2,16],[2,20]],
               [[10,-1],[10,8],[16,8],[16,14],[10,14],[10,20]] ],
      feat: [ ['ridge','r',12,1,4,1], ['ridge','r',12,3,2,1], ['ridge','r',3,8,3,1], ['ridge','r',12,17,4,1], ['ridge','r',13,19,2,1],
              ['ridge','r',0,12,4,1], ['ridge','r',8,13,4,1], ['high','e',4,2,1.5,1.2] ],
      fill: { ridge: 0.02, water: 0, high: 0.04, lava: 0, void: 0 } },

    // 34. One long route full of corrections.
    { id: 'errata', name: 'Errata', region: 6, w: 18, h: 22, biome: 'archive', seed: 37, ultra: false,
      blurb: 'Every line corrected, then corrected again.',
      paths: [ [[3,-1],[3,5],[6,5],[6,2],[10,2],[10,5],[13,5],[13,1],[16,1],[16,9],[12,9],[12,12],[8,12],[8,9],[3,9],[3,17],[7,17],[7,20],[11,20],[11,16],[15,16],[15,19],[18,19]] ],
      feat: [ ['ridge','r',0,13,2,1], ['ridge','r',13,13,3,1], ['ridge','r',9,15,1,3], ['ridge','r',4,1,1,1], ['ridge','r',4,7,4,1], ['ridge','r',13,7,2,1],
              ['ridge','r',14,11,3,1], ['high','e',1,17.5,1.2,2], ['high','e',14.5,21,2,0.8] ],
      fill: { ridge: 0.02, water: 0, high: 0.03, lava: 0, void: 0 } },

    // 35. ULTRA finale: four gates, three exits, a grand central aisle.
    { id: 'redacted-archive', name: 'The Redacted Archive', region: 6, w: 48, h: 48, biome: 'archive', seed: 38, ultra: true,
      blurb: 'Everything they tried to erase is here. So are they.',
      paths: [ [[6,-1],[6,12],[10,12],[10,3],[14,3],[14,12],[18,12],[18,3],[21,3],[21,18],[24,18],[24,48]],
               [[41,-1],[41,2],[27,2],[27,6],[44,6],[44,10],[27,10],[27,14],[40,14],[40,18],[24,18],[24,48]],
               [[-1,21],[16,21],[16,25],[2,25],[2,29],[19,29],[19,40],[40,40],[40,48]],
               [[48,22],[44,22],[44,30],[40,30],[40,22],[36,22],[36,30],[32,30],[32,22],[28,22],[28,33],[8,33],[8,48]] ],
      feat: [ ['ridge','r',8,1,1,4], ['ridge','r',8,7,1,4], ['ridge','r',12,5,1,3], ['ridge','r',12,10,1,4], ['ridge','r',16,1,1,4], ['ridge','r',16,7,1,4],
              ['ridge','r',29,4,6,1], ['ridge','r',37,4,6,1], ['ridge','r',30,8,5,1], ['ridge','r',38,8,5,1], ['ridge','r',29,12,6,1], ['ridge','r',37,12,3,1], ['ridge','r',29,16,4,1], ['ridge','r',35,16,4,1],
              ['ridge','r',3,23,5,1], ['ridge','r',10,23,5,1], ['ridge','r',4,27,5,1], ['ridge','r',12,27,5,1],
              ['ridge','r',30,24,1,4], ['ridge','r',34,23,1,4], ['ridge','r',38,25,1,4], ['ridge','r',42,23,1,4],
              ['void','r',23,3,3,12], ['void','r',2,38,4,1], ['void','r',1,43,5,1], ['void','r',11,42,6,1], ['void','r',12,45,4,1], ['void','r',28,43,8,1], ['void','r',30,45,5,1],
              ['void','r',9,16,8,1], ['void','r',31,36,6,1], ['void','r',42,34,4,1],
              ['high','r',2,31,3,2], ['high','e',2.5,16,2.5,3], ['high','e',44.5,41,2.5,4], ['high','e',13,37,3,1.5], ['high','e',34,33,3,1],
              ['ridge','r',0,40,3,1], ['ridge','r',5,40,2,1], ['ridge','r',9,40,7,1], ['ridge','r',11,47,6,1], ['ridge','r',26,41,1,5], ['ridge','r',46,32,1,6],
              ['ridge','r',37,32,1,4], ['ridge','r',8,14,1,2], ['ridge','r',18,14,1,2], ['void','r',45,14,2,4], ['void','r',29,0,6,1], ['ridge','r',3,35,3,1] ],
      fill: { ridge: 0, water: 0, high: 0.02, lava: 0, void: 0 } }
  ];

  var api = { T: T, CH: CH, REGIONS: REGIONS, MAPS: MAPS, build: build, ascii: ascii, validate: validate, pathCells: pathCells, rng: rng, noiseField: noiseField };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__TD2Maps = api;
})(typeof window !== 'undefined' ? window : this);
