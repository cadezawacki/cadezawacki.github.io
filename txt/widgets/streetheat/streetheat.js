/* Street Heat — an original top-down street racer for Cade.txt.
 * The city is endless and procedural: a lattice of road lines (highways,
 * boulevards that curve, avenues, streets, alleys) at jittered spacing, so
 * blocks vary in size. Each block is generated from a hash of its indices:
 * downtown towers, houses with yards, an industrial zone, parks and a river
 * with bridges and a waterfront. Highways cross streets on overpasses (the
 * street passes under: two levels) or at signaled interchanges; some highway
 * stretches run through tunnels. Traffic follows lanes, stops at lights and
 * changes lanes; police patrol, chase over the street graph (A*), ram, box in,
 * set roadblocks and spike strips, and send a helicopter at heat 5.
 * Modes: Free Roam (pursuits, race markers, bounty records), Career (a ladder
 * of ten rivals; sprint, circuit, drift, speed trap, outrun and escape
 * events; cash buys cars, upgrades and paint) and a seeded Daily Run.
 * The ground of each 128 m chunk is drawn once into an offscreen canvas
 * (skid marks are stamped into it); buildings, trees, cars and lights are
 * drawn per frame with a little parallax. Offline, no assets.
 * Storage: cade-streetheat-*. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units are meters, time in seconds; +x east, +y south (screen-like).
  var STEP = 1 / 60;
  var GAP = 104, JIT = 44, LW = 3.4, SW = 3.2, CH = 128, RAMP = 26;      // RAMP: on/off ramp length at interchanges
  var TAU = Math.PI * 2;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hash3(a, b, c) {
    var h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x632be5ab, 0x165667b1) ^ Math.imul((c | 0) + 0x1b873593, 0x9E3779B1);
    h = Math.imul(h ^ h >>> 15, 0x85ebca6b); h = Math.imul(h ^ h >>> 13, 0xc2b2ae35);
    return (h ^ h >>> 16) >>> 0;
  }
  function h01(a, b, c) { return hash3(a, b, c) / 4294967296; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sgn(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }
  function angDiff(a, b) { var d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; }
  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return lerp(lerp(h01(xi, yi, s), h01(xi + 1, yi, s), fx), lerp(h01(xi, yi + 1, s), h01(xi + 1, yi + 1, s), fx), fy);
  }

  // ---- road lines: vertical lines are indexed i (x = position), horizontal lines j (y) ----
  // hw: half width of the asphalt; lim: speed limit (m/s); cost: path cost factor (lower = faster)
  var RT = {
    hwy: { lanes: 3, med: 1.1, sh: 1.4, lim: 34, cost: 0.62 },
    blvd: { lanes: 2, med: 1.9, sh: 0.5, lim: 22, cost: 0.85 },
    ave: { lanes: 2, med: 0.2, sh: 0.5, lim: 20, cost: 0.9 },
    st: { lanes: 1, med: 0.1, sh: 2.6, lim: 15, cost: 1 },
    alley: { lanes: 1, med: 0, sh: 0.2, lw: 2.5, lim: 9, cost: 1.5 }
  };
  var VL = new Map(), HL = new Map();
  function mkLine(t, p) {
    var d = RT[t], lw = d.lw || LW;
    return { t: t, p: p, lanes: d.lanes, lw: lw, med: d.med, hw: d.med + d.lanes * lw + d.sh, lim: d.lim, cost: d.cost, A: 0, k: 0, ph: 0 };
  }
  function vline(i) {
    var L = VL.get(i);
    if (L) return L;
    var r = h01(i, 0, 101), t = mod(i, 10) === 3 ? 'hwy' : r < 0.16 ? 'blvd' : r < 0.42 ? 'ave' : r < 0.9 ? 'st' : 'alley';
    if (t === 'alley' && (mod(i, 10) === 2 || mod(i, 10) === 4)) t = 'st';
    L = mkLine(t, i * GAP + (h01(i, 0, 102) - 0.5) * JIT);
    if (t === 'blvd') { L.A = 6 + 7 * h01(i, 0, 103); L.k = TAU / (260 + 180 * h01(i, 0, 104)); L.ph = h01(i, 0, 105) * TAU; }
    if (VL.size > 3000) VL.clear();
    VL.set(i, L);
    return L;
  }
  function hline(j) {
    var L = HL.get(j);
    if (L) return L;
    var r = h01(0, j, 111), t = mod(j, 9) === 4 ? 'hwy' : r < 0.12 ? 'blvd' : r < 0.36 ? 'ave' : r < 0.9 ? 'st' : 'alley';
    if (t === 'alley' && (isRiver(j) || isRiver(j - 1))) t = 'st';
    L = mkLine(t, j * GAP + (h01(0, j, 112) - 0.5) * JIT);
    if (HL.size > 3000) HL.clear();
    HL.set(j, L);
    return L;
  }
  function lineOf(ax, n) { return ax ? vline(n) : hline(n); }
  function Xp(i) { return vline(i).p; }
  function Yp(j) { return hline(j).p; }
  // the x of vertical line i at height y (boulevards curve)
  function vx(i, y) { var L = vline(i); return L.A ? L.p + L.A * Math.sin(y * L.k + L.ph) : L.p; }
  function vdx(i, y) { var L = vline(i); return L.A ? L.A * L.k * Math.cos(y * L.k + L.ph) : 0; }
  function colOf(x) { var i = Math.floor(x / GAP); while (Xp(i) > x) i--; while (Xp(i + 1) <= x) i++; return i; }
  function rowOf(y) { var j = Math.floor(y / GAP); while (Yp(j) > y) j--; while (Yp(j + 1) <= y) j++; return j; }

  // the river: one block row in fourteen is water; only some vertical lines bridge it
  function isRiver(bj) { return mod(bj, 14) === 9; }
  function bridge(i) { var L = vline(i); return L.A === 0 && L.t !== 'alley' && (L.t === 'hwy' || mod(i, 3) === 0); }
  function hasV(i, j) { return !isRiver(j) || bridge(i); }       // vertical edge (i,j)-(i,j+1)
  function district(bi, bj) {
    if (isRiver(bj)) return 'water';
    if (h01(bi, bj, 403) < 0.075) return 'park';
    var v = vnoise(bi / 6.5 + 0.5, bj / 6.5 + 0.5, 401);
    if (Math.abs(bi) <= 1 && Math.abs(bj) <= 1) v = Math.max(v, 0.66);        // a downtown around the start
    if (v > 0.6) return 'down';
    if (v < 0.34 || ((isRiver(bj - 1) || isRiver(bj + 1)) && vnoise(bi / 4, bj, 405) > 0.5)) return 'ind';
    return 'res';
  }

  // ---- nodes (intersections) ----
  function nodeX(i, j) { return vx(i, Yp(j)); }
  function overpass(i, j) {
    var V = vline(i), H = hline(j);
    if ((V.t === 'hwy') === (H.t === 'hwy')) return false;
    if (!hasV(i, j) || !hasV(i, j - 1)) return false;
    return h01(i, j, 201) >= 0.34;
  }
  function signaled(i, j) { return !overpass(i, j) && vline(i).t !== 'alley' && hline(j).t !== 'alley'; }
  // traffic light for travel along axis ax (0 = horizontal) at node (i,j): 0 green, 1 yellow, 2 red
  // (with two seconds of all-red between the phases so the box can clear)
  var CYC = 22;
  function light(i, j, t, ax) {
    var u = mod(t + h01(i, j, 301) * CYC, CYC);
    if (!ax) return u < 7 ? 0 : u < 9 ? 1 : 2;
    return u < 11 ? 2 : u < 18 ? 0 : u < 20 ? 1 : 2;
  }
  // the overpass box: inside it a car is on the highway deck (level 1) or under it (level 0)
  function ovpBox(i, j) {
    var V = vline(i), H = hline(j), x = nodeX(i, j), y = Yp(j);
    if (H.t === 'hwy') return { x: x, y: y, hx: V.hw + SW + 0.6, hy: H.hw + 1.6, ax: 0 };
    return { x: x, y: y, hx: V.hw + 1.6, hy: H.hw + SW + 0.6, ax: 1 };
  }
  function tunnel(bi, j) {        // the horizontal highway edge (bi..bi+1) on line j runs in a tunnel
    return hline(j).t === 'hwy' && district(bi, j - 1) === 'down' && district(bi, j) === 'down' && h01(bi, j, 211) < 0.7;
  }

  // a point on line (ax, n) at parameter s (x for horizontal lines, y for vertical), with its tangent
  function linePt(ax, n, s, o) {
    if (!ax) { o.x = s; o.y = Yp(n); o.tx = 1; o.ty = 0; return o; }
    var L = vline(n);
    o.y = s;
    if (L.A) {
      var c = L.A * L.k * Math.cos(s * L.k + L.ph), m = Math.sqrt(1 + c * c);
      o.x = L.p + L.A * Math.sin(s * L.k + L.ph); o.tx = c / m; o.ty = 1 / m;
    } else { o.x = L.p; o.tx = 0; o.ty = 1; }
    return o;
  }
  // a point offset to the right of travel (dir ±1) by off meters; o.hx/o.hy = heading
  function lanePt(ax, n, s, dir, off, o) {
    linePt(ax, n, s, o);
    o.hx = o.tx * dir; o.hy = o.ty * dir;
    o.x += -o.hy * off; o.y += o.hx * off;
    return o;
  }
  function laneOff(L, k) { return L.med + (k + 0.5) * L.lw; }
  function nodeS(ax, n, k) { return ax ? Yp(k) : nodeX(k, n); }       // the parameter of node k on line n
  function nodeIJ(ax, n, k) { return ax ? [n, k] : [k, n]; }
  // the index of the next node along line (ax, n) from s in direction dir
  function nextNode(ax, n, s, dir) {
    var k = ax ? rowOf(s) : colOf(s);
    if (dir > 0) { while (nodeS(ax, n, k) <= s) k++; while (nodeS(ax, n, k - 1) > s) k--; }
    else { k++; while (nodeS(ax, n, k) >= s) k--; while (nodeS(ax, n, k + 1) < s) k++; }
    return k;
  }
  // does the line continue from node k toward dir?
  function edgeOK(ax, n, k, dir) { return !ax || hasV(n, dir > 0 ? k : k - 1); }
  // the nearest road centerline to (x,y)
  function nearestRoad(x, y) {
    var j = rowOf(y), i = colOf(x), best = null, d, k;
    for (k = j; k <= j + 1; k++) { d = Math.abs(y - Yp(k)); if (!best || d < best.d) best = { ax: 0, n: k, d: d }; }
    for (k = i - 1; k <= i + 2; k++) {
      if (!hasV(k, j)) continue;
      d = Math.abs(x - vx(k, y)) / Math.sqrt(1 + Math.pow(vdx(k, y), 2));
      if (d < best.d) best = { ax: 1, n: k, d: d };
    }
    best.L = lineOf(best.ax, best.n);
    return best;
  }
  // is (x,y) inside some intersection box? returns [i,j] or null
  function nodeAt(x, y, pad) {
    var j = rowOf(y), i = colOf(x), a, b;
    pad = pad || 0;
    for (b = j; b <= j + 1; b++) for (a = i - 1; a <= i + 2; a++) {
      var V = vline(a), H = hline(b);
      if (Math.abs(x - nodeX(a, b)) < V.hw + pad && Math.abs(y - Yp(b)) < H.hw + pad) return [a, b];
    }
    return null;
  }

  // ---- blocks: buildings, trees, props, lamps, water, barriers ----
  var BLK = new Map();
  function bkey(bi, bj) { return bi * 131071 + bj; }
  var ROOFS = {
    down: [[128, 132, 138], [104, 108, 116], [150, 146, 140], [88, 94, 104], [120, 112, 104], [140, 150, 156]],
    res: [[168, 92, 70], [132, 84, 66], [96, 100, 110], [150, 120, 90], [118, 70, 64], [86, 92, 84]],
    ind: [[150, 156, 160], [128, 134, 130], [112, 118, 124], [160, 150, 128]],
    park: [[150, 140, 120]]
  };
  var PROPS = {
    cone: { r: 0.32, m: 5 }, barrier: { r: 0.75, m: 70 }, hydrant: { r: 0.32, m: 140 }, trash: { r: 0.42, m: 30 },
    news: { r: 0.7, m: 60 }, fence: { r: 0.9, m: 40 }, bench: { r: 0.65, m: 45 }, barrel: { r: 0.45, m: 45 },
    mailbox: { r: 0.3, m: 25 }, parked: { r: 0.9, m: 1300 }
  };
  function block(bi, bj) {
    var key = bkey(bi, bj), b = BLK.get(key);
    if (b) return b;
    if (BLK.size > 900) BLK.clear();
    b = genBlock(bi, bj);
    BLK.set(key, b);
    return b;
  }
  function genBlock(bi, bj) {
    var L = vline(bi), R = vline(bi + 1), T = hline(bj), B = hline(bj + 1);
    var r = mulberry32(hash3(bi, bj, 7)), kind = district(bi, bj);
    var b = {
      bi: bi, bj: bj, kind: kind, x0: L.p - L.A - L.hw - 1, x1: R.p + R.A + R.hw + 1, y0: T.p - T.hw - 1, y1: B.p + B.hw + 1,
      ix0: L.p + L.A + L.hw + SW, ix1: R.p - R.A - R.hw - SW, iy0: T.p + T.hw + SW, iy1: B.p - B.hw - SW,
      blds: [], trees: [], lots: [], water: [], segs: [], rails: [], props: [], lamps: [], pid: 0
    };
    if (kind === 'water') {
      var wx0 = bridge(bi) ? L.p + L.hw + 1.2 : L.p, wx1 = bridge(bi + 1) ? R.p - R.hw - 1.2 : R.p;
      b.water.push({ x0: wx0, y0: b.iy0, x1: wx1, y1: b.iy1 });
      b.rails.push([wx0, b.iy0, wx1, b.iy0], [wx0, b.iy1, wx1, b.iy1]);
      if (bridge(bi)) b.rails.push([wx0 - 0.6, b.iy0, wx0 - 0.6, b.iy1]);
      if (bridge(bi + 1)) b.rails.push([wx1 + 0.6, b.iy0, wx1 + 0.6, b.iy1]);
    } else if (b.ix1 - b.ix0 > 8 && b.iy1 - b.iy0 > 8) fillBlock(b, r);
    roadside(b, r, L, R, T, B);
    hwyBarriers(b);
    return b;
  }
  function addProp(b, k, x, y, a) { b.props.push({ id: b.bi * 7919 + b.bj * 104729 + (b.pid++) * 15485863, k: k, x: x, y: y, a: a || 0 }); }
  // split the block interior into lots and fill them by district
  function fillBlock(b, r) {
    var kind = b.kind, lots = [], tgt = kind === 'down' ? 34 : kind === 'res' ? 18 : kind === 'ind' ? 40 : 1e9;
    (function split(x0, y0, x1, y1, d) {
      var w = x1 - x0, h = y1 - y0;
      if ((w < tgt * 1.5 && h < tgt * 1.5) || d > 6) { lots.push([x0, y0, x1, y1]); return; }
      var t = 0.35 + r() * 0.3;
      if (w > h) { var xm = x0 + w * t; split(x0, y0, xm, y1, d + 1); split(xm, y0, x1, y1, d + 1); }
      else { var ym = y0 + h * t; split(x0, y0, x1, ym, d + 1); split(x0, ym, x1, y1, d + 1); }
    })(b.ix0, b.iy0, b.ix1, b.iy1, 0);
    var pal = ROOFS[kind] || ROOFS.down;
    lots.forEach(function (lt) {
      var x0 = lt[0], y0 = lt[1], x1 = lt[2], y1 = lt[3], w = x1 - x0, h = y1 - y0, u = r();
      if (kind === 'park') {
        b.lots.push({ t: 'park', x0: x0, y0: y0, x1: x1, y1: y1 });
        var n = Math.floor(w * h / 140);
        for (var q = 0; q < n; q++) {
          var tx = x0 + 3 + r() * (w - 6), ty = y0 + 3 + r() * (h - 6);
          if (Math.abs(tx - (x0 + x1) / 2) < 3 || Math.abs(ty - (y0 + y1) / 2) < 3) continue;   // the cross paths
          b.trees.push({ x: tx, y: ty, r: 2.2 + r() * 2, s: r() });
        }
        if (w > 40 && h > 40 && r() < 0.6) {
          var pw = w * 0.22, ph = h * 0.2, px = x0 + w * 0.62, py = y0 + h * 0.16;
          b.water.push({ x0: px, y0: py, x1: px + pw, y1: py + ph, pond: 1 });
        }
        addProp(b, 'bench', (x0 + x1) / 2 + 2.2, y0 + h * 0.3, Math.PI / 2);
        addProp(b, 'trash', (x0 + x1) / 2 - 2.2, y0 + h * 0.7);
        return;
      }
      if (kind === 'res') {
        if (u < 0.12) { b.lots.push({ t: 'grass', x0: x0, y0: y0, x1: x1, y1: y1 }); b.trees.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: 3 + r() * 2, s: r() }); return; }
        b.lots.push({ t: 'yard', x0: x0, y0: y0, x1: x1, y1: y1 });
        var m = 2.5 + r() * 1.5, bw = Math.max(6, w - m * 2 - r() * 3), bh = Math.max(6, h - m * 2 - r() * 3);
        var bx = x0 + (w - bw) / 2, by = y0 + (h - bh) / 2;
        b.blds.push({ x0: bx, y0: by, x1: bx + bw, y1: by + bh, h: 5 + r() * 4, c: pal[Math.floor(r() * pal.length)], roof: 'gable', ax: bw > bh ? 0 : 1, det: [] });
        if (r() < 0.7) { var cx = r() < 0.5 ? x0 + 1.6 : x1 - 1.6, cy = r() < 0.5 ? y0 + 1.6 : y1 - 1.6; b.trees.push({ x: cx, y: cy, r: 1.8 + r() * 1.4, s: r() }); }
        return;
      }
      if (kind === 'ind') {
        if (u < 0.3) {   // container yard behind a fence
          b.lots.push({ t: 'lot', x0: x0, y0: y0, x1: x1, y1: y1 });
          for (var cy2 = y0 + 3; cy2 + 2.6 < y1 - 2; cy2 += 3.4) for (var cx2 = x0 + 3; cx2 + 12 < x1 - 2; cx2 += 13) {
            if (r() < 0.75) b.blds.push({ x0: cx2, y0: cy2, x1: cx2 + 12, y1: cy2 + 2.5, h: 2.6 * (1 + Math.floor(r() * 2)), c: [[176, 66, 52], [52, 104, 156], [210, 150, 52], [70, 130, 90], [120, 120, 126]][Math.floor(r() * 5)], roof: 'cont', det: [] });
          }
          return;
        }
        b.lots.push({ t: 'lot', x0: x0, y0: y0, x1: x1, y1: y1 });
        var mm = 2 + r() * 3, bw2 = w - mm * 2, bh2 = h - mm * 2 - r() * 6;
        if (bw2 < 8 || bh2 < 8) return;
        var bd = { x0: x0 + mm, y0: y0 + mm, x1: x0 + mm + bw2, y1: y0 + mm + bh2, h: 8 + r() * 7, c: pal[Math.floor(r() * pal.length)], roof: 'ribs', ax: bw2 > bh2 ? 0 : 1, det: [] };
        roofDet(bd, r, 'vent');
        b.blds.push(bd);
        if (r() < 0.6) addProp(b, 'barrel', x0 + mm + 1, y1 - 1.6);
        return;
      }
      // downtown
      if (u < 0.13 && w > 18 && h > 18) {   // a parking lot with parked cars
        b.lots.push({ t: 'park-lot', x0: x0, y0: y0, x1: x1, y1: y1 });
        for (var py2 = y0 + 4; py2 < y1 - 3; py2 += 8) for (var px2 = x0 + 2.5; px2 < x1 - 2; px2 += 2.8) if (r() < 0.45) addProp(b, 'parked', px2, py2 + (r() < 0.5 ? 0 : 3.5), Math.PI / 2);
        return;
      }
      if (u < 0.2) { b.lots.push({ t: 'plaza', x0: x0, y0: y0, x1: x1, y1: y1 }); b.trees.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: 2.6, s: r() }); addProp(b, 'bench', (x0 + x1) / 2 + 4, (y0 + y1) / 2); return; }
      var mg = 0.6 + r() * 1.2, hh = 24 + Math.pow(r(), 1.6) * 100;
      var bd2 = { x0: x0 + mg, y0: y0 + mg, x1: x1 - mg, y1: y1 - mg, h: hh, c: pal[Math.floor(r() * pal.length)], roof: hh > 85 && r() < 0.5 ? 'pad' : 'flat', det: [] };
      roofDet(bd2, r, 'ac');
      b.blds.push(bd2);
    });
  }
  function roofDet(bd, r, k) {
    var w = bd.x1 - bd.x0, h = bd.y1 - bd.y0, n = 1 + Math.floor(r() * 4);
    for (var i = 0; i < n; i++) {
      var dw = 2 + r() * Math.min(7, w * 0.25), dh = 2 + r() * Math.min(7, h * 0.25);
      bd.det.push([bd.x0 + 1.5 + r() * Math.max(0, w - dw - 3), bd.y0 + 1.5 + r() * Math.max(0, h - dh - 3), dw, dh, k]);
    }
  }
  // sidewalk props, lamps, parked cars and street trees along the block's own edges
  function roadside(b, r, L, R, T, B) {
    var kind = b.kind;
    if (kind === 'water') { for (var wx = b.ix0 + 8; wx < b.ix1 - 8; wx += 26) b.lamps.push([wx, b.iy0 - 1, 0]); return; }
    var sx0 = L.p + L.A + L.hw + SW / 2, sx1 = R.p - R.A - R.hw - SW / 2, sy0 = T.p + T.hw + SW / 2, sy1 = B.p - B.hw - SW / 2;
    // hydrants at a corner or two
    if (T.t !== 'hwy' && L.t !== 'hwy' && !L.A && r() < 0.7) addProp(b, 'hydrant', sx0 + 0.6, sy0 + 0.6);
    if (B.t !== 'hwy' && R.t !== 'hwy' && !R.A && r() < 0.4) addProp(b, 'hydrant', sx1 - 0.6, sy1 - 0.6);
    var cand = [];
    if (T.t !== 'hwy') cand.push([sx0 + 6, sy0, sx1 - 6, sy0]);
    if (B.t !== 'hwy') cand.push([sx0 + 6, sy1, sx1 - 6, sy1]);
    if (!L.A && L.t !== 'hwy') cand.push([sx0, sy0 + 6, sx0, sy1 - 6]);
    if (!R.A && R.t !== 'hwy') cand.push([sx1, sy0 + 6, sx1, sy1 - 6]);
    var kinds = kind === 'down' ? ['news', 'trash', 'trash', 'bench', 'news'] : kind === 'res' ? ['mailbox', 'trash', 'trash'] : kind === 'ind' ? ['barrel', 'trash', 'barrel'] : ['bench', 'trash'];
    cand.forEach(function (c) {
      var len = Math.hypot(c[2] - c[0], c[3] - c[1]);
      if (len < 4) return;
      var n = Math.floor(len / 38 + r() * 1.5);
      for (var q = 0; q < n; q++) { var t = r(); addProp(b, kinds[Math.floor(r() * kinds.length)], lerp(c[0], c[2], t), lerp(c[1], c[3], t), c[0] === c[2] ? Math.PI / 2 : 0); }
      if (kind === 'ind' && r() < 0.5) {     // a run of fence panels
        var t0 = r() * 0.5, run = Math.min(len * 0.4, 18);
        for (var f = 0; f < run; f += 1.9) { var tt = t0 + f / len; addProp(b, 'fence', lerp(c[0], c[2], tt), lerp(c[1], c[3], tt), c[0] === c[2] ? Math.PI / 2 : 0); }
      }
      if (kind === 'res' || (kind === 'down' && r() < 0.5)) for (var tq = 10; tq < len - 4; tq += 14 + r() * 8) {
        var t2 = tq / len; b.trees.push({ x: lerp(c[0], c[2], t2) + (c[0] === c[2] ? 0 : 0), y: lerp(c[1], c[3], t2), r: 1.6 + r() * 1.2, s: r(), st: 1 });
      }
    });
    // street lamps along the top and left edges
    var x0 = nodeX(b.bi, b.bj) + L.hw + 2, x1 = nodeX(b.bi + 1, b.bj) - R.hw - 2;
    if (T.t === 'hwy') { for (var lx = x0 + 6; lx < x1; lx += 42) b.lamps.push([lx, T.p, 2]); }
    else for (var lx2 = x0 + 5; lx2 < x1; lx2 += 30) b.lamps.push([lx2, T.p + T.hw + 0.7, 0]);
    if (!L.A) {
      var y0 = T.p + T.hw + 2, y1 = B.p - B.hw - 2;
      if (L.t === 'hwy') { for (var ly = y0 + 6; ly < y1; ly += 42) b.lamps.push([L.p, ly, 2]); }
      else for (var ly2 = y0 + 14; ly2 < y1; ly2 += 30) b.lamps.push([L.p + L.hw + 0.7, ly2, 1]);
    } else for (var by2 = T.p + T.hw + 8; by2 < B.p - B.hw - 6; by2 += 13) b.trees.push({ x: vx(b.bi, by2), y: by2, r: 1.7 + r() * 0.8, s: r(), st: 1 });   // boulevard median trees
    // parked cars on streets: the south side of the top line and the east side of the left line
    if (T.t === 'st') for (var px = nodeX(b.bi, b.bj) + L.hw + 9; px < nodeX(b.bi + 1, b.bj) - R.hw - 9; px += 6.4) if (r() < 0.42) addProp(b, 'parked', px, T.p + 4.75, r() < 0.5 ? 0 : Math.PI);
    if (B.t === 'st') for (var px3 = nodeX(b.bi, b.bj + 1) + L.hw + 9; px3 < nodeX(b.bi + 1, b.bj + 1) - R.hw - 9; px3 += 6.4) if (r() < 0.42) addProp(b, 'parked', px3, B.p - 4.75, r() < 0.5 ? 0 : Math.PI);
    if (L.t === 'st' && hasV(b.bi, b.bj)) for (var py = T.p + T.hw + 9; py < B.p - B.hw - 9; py += 6.4) if (r() < 0.42) addProp(b, 'parked', L.p + 4.75, py, Math.PI / 2 * (r() < 0.5 ? 1 : 3));
    // a construction zone: cones down a lane of the top street and a barrier
    if (T.t !== 'hwy' && T.t !== 'alley' && r() < 0.07) {
      var cx = lerp(x0, x1, 0.3 + r() * 0.3), off = T.p + laneOff(T, T.lanes - 1);
      for (var q2 = 0; q2 < 5; q2++) addProp(b, 'cone', cx + q2 * 2.6, off - 1.4 + (q2 === 0 || q2 === 4 ? 0 : 0));
      addProp(b, 'barrier', cx + 5.2, off + 0.2, Math.PI / 2);
    }
  }
  // highway barriers: medians and outer walls with gaps at interchanges; level 1 over overpasses
  function hwyBarriers(b) {
    var T = hline(b.bj), L = vline(b.bi);
    function seg(ax, line, off, p, q, lv) {
      if (q - p < 0.5) return;
      if (!ax) b.segs.push({ x0: p, y0: line + off, x1: q, y1: line + off, lv: lv });
      else b.segs.push({ x0: line + off, y0: p, x1: line + off, y1: q, lv: lv });
    }
    // main run between the gaps; over an overpass the barrier carries on at level 1
    function run(ax, line, a, bb, sa, sb, offs, gapA, gapB, ovA, ovB) {
      offs.forEach(function (off) {
        seg(ax, line, off, sa + gapA, sb - gapB, 0);
        if (ovA) seg(ax, line, off, sa, sa + gapA, 1);
        if (ovB) seg(ax, line, off, sb - gapB, sb, 1);
      });
    }
    if (T.t === 'hwy') {
      var xa = nodeX(b.bi, b.bj), xb = nodeX(b.bi + 1, b.bj), oa = overpass(b.bi, b.bj), ob = overpass(b.bi + 1, b.bj);
      var ga = vline(b.bi).hw + (oa ? SW + 0.6 : RAMP), gb = vline(b.bi + 1).hw + (ob ? SW + 0.6 : RAMP);
      run(0, T.p, 0, 0, xa, xb, [-T.hw - 0.3, T.hw + 0.3], ga, gb, oa, ob);
      if (!oa) ga = vline(b.bi).hw + SW + 0.6; if (!ob) gb = vline(b.bi + 1).hw + SW + 0.6;
      var gm = vline(b.bi).hw + 9, gmb = vline(b.bi + 1).hw + 9;
      run(0, T.p, 0, 0, xa, xb, [0], oa ? ga : gm, ob ? gb : gmb, oa, ob);
    }
    if (L.t === 'hwy' && hasV(b.bi, b.bj)) {
      var ya = Yp(b.bj), yb = Yp(b.bj + 1), va = overpass(b.bi, b.bj), vb = overpass(b.bi, b.bj + 1);
      var gya = hline(b.bj).hw + (va ? SW + 0.6 : RAMP), gyb = hline(b.bj + 1).hw + (vb ? SW + 0.6 : RAMP);
      run(1, L.p, 0, 0, ya, yb, [-L.hw - 0.3, L.hw + 0.3], gya, gyb, va, vb);
      if (!va) gya = hline(b.bj).hw + SW + 0.6; if (!vb) gyb = hline(b.bj + 1).hw + SW + 0.6;
      run(1, L.p, 0, 0, ya, yb, [0], va ? gya : hline(b.bj).hw + 9, vb ? gyb : hline(b.bj + 1).hw + 9, va, vb);
    }
  }
  function blockAt(x, y) { return block(colOf(x), rowOf(y)); }
  // every block whose box touches the rectangle
  function blocksIn(x0, y0, x1, y1, out) {
    out = out || [];
    out.length = 0;
    var i0 = colOf(x0) - 1, i1 = colOf(x1) + 1, j0 = rowOf(y0) - 1, j1 = rowOf(y1) + 1;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var b = block(i, j);
      if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) out.push(b);
    }
    return out;
  }
  // does the segment cross any building? (line of sight)
  var _bl = [];
  function segHitsBox(x0, y0, x1, y1, bx) {
    var dx = x1 - x0, dy = y1 - y0, t0 = 0, t1 = 1;
    function clip(p, q) { if (Math.abs(p) < 1e-9) return q >= 0; var t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } return true; }
    return clip(-dx, x0 - bx.x0) && clip(dx, bx.x1 - x0) && clip(-dy, y0 - bx.y0) && clip(dy, bx.y1 - y0);
  }
  function los(x0, y0, x1, y1) {
    var bl = blocksIn(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), _bl);
    for (var k = 0; k < bl.length; k++) {
      var bs = bl[k].blds;
      for (var q = 0; q < bs.length; q++) if (bs[q].h > 4 && segHitsBox(x0, y0, x1, y1, bs[q])) return false;
    }
    return true;
  }

  // ---- graph search over intersections: A* with an axis per state (no turning on overpasses) ----
  var DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];          // E S W N
  function stepOK(i, j, d) { return d === 0 || d === 2 ? true : d === 1 ? hasV(i, j) : hasV(i, j - 1); }
  function edgeCost(i, j, d) {
    var L = d === 0 || d === 2 ? hline(j) : vline(i), i2 = i + DIRS[d][0], j2 = j + DIRS[d][1];
    return Math.hypot(nodeX(i2, j2) - nodeX(i, j), Yp(j2) - Yp(j)) * L.cost;
  }
  function Heap() { this.a = []; }
  Heap.prototype.push = function (n) {
    var a = this.a, i = a.length;
    a.push(n);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };
  // from node (si,sj) entered along axis sax (or -1) to node (ti,tj): a list of [i,j]
  function findPath(si, sj, sax, ti, tj, maxN) {
    maxN = maxN || 900;
    var tx = nodeX(ti, tj), ty = Yp(tj), open = new Heap(), seen = new Map(), best = null, n = 0;
    function hh(i, j) { return (Math.abs(nodeX(i, j) - tx) + Math.abs(Yp(j) - ty)) * 0.62; }
    var st = { i: si, j: sj, ax: sax, g: 0, f: hh(si, sj), p: null };
    open.push(st);
    seen.set(si * 65537 + sj * 3 + (sax + 1), 0);
    while (open.a.length && n < maxN) {
      var c = open.pop(); n++;
      var hc = c.f - c.g;
      if (!best || hc < best.f - best.g) best = c;
      if (c.i === ti && c.j === tj) { best = c; break; }
      var ovp = c.ax >= 0 && overpass(c.i, c.j);
      for (var d = 0; d < 4; d++) {
        var ax = d & 1;
        if (ovp && ax !== c.ax) continue;
        if (!stepOK(c.i, c.j, d)) continue;
        var i2 = c.i + DIRS[d][0], j2 = c.j + DIRS[d][1];
        if (c.p && c.p.i === i2 && c.p.j === j2) continue;
        var g2 = c.g + edgeCost(c.i, c.j, d), key = i2 * 65537 + j2 * 3 + (ax + 1);
        var old = seen.get(key);
        if (old != null && old <= g2) continue;
        seen.set(key, g2);
        open.push({ i: i2, j: j2, ax: ax, g: g2, f: g2 + hh(i2, j2), p: c });
      }
    }
    var out = [];
    for (var q = best; q; q = q.p) out.push([q.i, q.j]);
    return out.reverse();
  }
  function nearNode(x, y) {      // the closest intersection
    var i = colOf(x), j = rowOf(y), bi = i, bj = j, bd = 1e18;
    for (var b = j; b <= j + 1; b++) for (var a = i - 1; a <= i + 2; a++) {
      var d = Math.pow(nodeX(a, b) - x, 2) + Math.pow(Yp(b) - y, 2);
      if (d < bd) { bd = d; bi = a; bj = b; }
    }
    return [bi, bj];
  }

  // ---- routes: random walks and loops over the graph, densified for driving ----
  function routeWalk(r, si, sj, d0, edges) {
    for (var tries = 0; tries < 40; tries++) {
      var nodes = [[si, sj]], used = {}, i = si, j = sj, d = d0, ok = true;
      used[i + ',' + j] = 1;
      if (!stepOK(i, j, d)) { d = (d + 1) % 4; if (!stepOK(i, j, d)) d = (d + 2) % 4; }
      for (var e = 0; e < edges; e++) {
        var opts = [], tot = 0;
        for (var t = -1; t <= 1; t++) {
          var nd = mod(d + t, 4);
          if (e > 0 && t !== 0 && overpass(i, j)) continue;
          if (!stepOK(i, j, nd)) continue;
          var i2 = i + DIRS[nd][0], j2 = j + DIRS[nd][1];
          if (used[i2 + ',' + j2]) continue;
          var L = nd & 1 ? vline(i) : hline(j), w = t === 0 ? 0.52 : 0.24;
          if (L.t === 'alley') w *= 0.12;
          if (e === 0 && t !== 0) w = 0;
          if (w > 0) { opts.push([nd, w]); tot += w; }
        }
        if (!opts.length) { ok = false; break; }
        var x = r() * tot, pick = opts[opts.length - 1][0];
        for (var k = 0; k < opts.length; k++) { x -= opts[k][1]; if (x <= 0) { pick = opts[k][0]; break; } }
        d = pick; i += DIRS[d][0]; j += DIRS[d][1];
        used[i + ',' + j] = 1;
        nodes.push([i, j]);
      }
      if (ok) return nodes;
      r();
    }
    return null;
  }
  // a rectangle of w × h blocks (clockwise), shifted until every edge exists and no corner is an overpass
  function routeLoop(r, si, sj, w, h) {
    for (var tries = 0; tries < 60; tries++) {
      var i0 = si - Math.floor(r() * w), j0 = sj - Math.floor(r() * h), nodes = [], ok = true, i, j;
      if (tries > 20) { i0 += Math.floor((r() - 0.5) * 8); j0 += Math.floor((r() - 0.5) * 8); }
      for (i = i0; i < i0 + w; i++) nodes.push([i, j0]);
      for (j = j0; j < j0 + h; j++) nodes.push([i0 + w, j]);
      for (i = i0 + w; i > i0; i--) nodes.push([i, j0 + h]);
      for (j = j0 + h; j > j0; j--) nodes.push([i0, j]);
      for (j = j0; j < j0 + h && ok; j++) if (!hasV(i0, j) || !hasV(i0 + w, j)) ok = false;
      [[i0, j0], [i0 + w, j0], [i0 + w, j0 + h], [i0, j0 + h]].forEach(function (c) { if (overpass(c[0], c[1])) ok = false; });
      for (i = i0; i <= i0 + w && ok; i++) if (vline(i).t === 'alley' && (i === i0 || i === i0 + w)) ok = false;
      if (hline(j0).t === 'alley' || hline(j0 + h).t === 'alley') ok = false;
      if (ok) return nodes;
    }
    return null;
  }
  var RSTEP = 4;
  // dense points every ~4 m along the node list; vmax = the speed a racer can carry at each point
  function denseRoute(nodes, loop, lat) {
    var xs = [], ys = [], ni = [], k, n = nodes.length, segs = loop ? n : n - 1;
    for (k = 0; k < segs; k++) {
      var a = nodes[k], b = nodes[(k + 1) % n], ax = a[1] === b[1] ? 0 : 1;
      ni.push(xs.length);
      var s0 = ax ? Yp(a[1]) : nodeX(a[0], a[1]), s1 = ax ? Yp(b[1]) : nodeX(b[0], b[1]), line = ax ? a[0] : a[1];
      var m = Math.max(1, Math.round(Math.abs(s1 - s0) / RSTEP)), o = {}, LL = lineOf(ax, line), dir = s1 > s0 ? 1 : -1;
      var off = LL.lanes > 1 ? LL.med + LL.lw * LL.lanes * 0.5 : 0;     // the right-hand carriageway (narrow streets: the middle)
      for (var q = 0; q < m; q++) { lanePt(ax, line, lerp(s0, s1, q / m), dir, off, o); xs.push(o.x); ys.push(o.y); }
    }
    if (!loop) { var lst = nodes[n - 1]; ni.push(xs.length); xs.push(nodeX(lst[0], lst[1])); ys.push(Yp(lst[1])); }
    var N = xs.length, cum = new Float64Array(N), vmax = new Float64Array(N), L = 0;
    for (k = 1; k < N; k++) { L += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]); cum[k] = L; }
    if (loop) L += Math.hypot(xs[0] - xs[N - 1], ys[0] - ys[N - 1]);
    for (k = 0; k < N; k++) vmax[k] = 99;
    lat = lat || 13;
    for (k = 0; k < n; k++) {
      if (!loop && (k === 0 || k === n - 1)) continue;
      var p = nodes[(k - 1 + n) % n], c = nodes[k], nx = nodes[(k + 1) % n];
      var d1 = Math.atan2(Yp(c[1]) - Yp(p[1]), nodeX(c[0], c[1]) - nodeX(p[0], p[1])), d2 = Math.atan2(Yp(nx[1]) - Yp(c[1]), nodeX(nx[0], nx[1]) - nodeX(c[0], c[1]));
      var th = Math.abs(angDiff(d1, d2));
      if (th < 0.35) continue;
      var hwA = (p[1] === c[1] ? hline(c[1]) : vline(c[0])).hw, hwB = (c[1] === nx[1] ? hline(c[1]) : vline(c[0])).hw;
      var right = Math.sin(d2 - d1) > 0, R = right ? (hwA + hwB) * 0.62 + 3 : (hwA + hwB) * 1.0 + 5, vc = Math.sqrt(lat * R) * Math.sqrt(Math.PI / 2 / th);
      var at = ni[k] != null ? ni[k] : 0;
      for (var z = -2; z <= 2; z++) { var ix = loop ? mod(at + z, N) : clamp(at + z, 0, N - 1); vmax[ix] = Math.min(vmax[ix], vc); }
    }
    for (var pass = 0; pass < (loop ? 2 : 1); pass++) for (k = N - 2 + (loop ? 1 : 0); k >= 0; k--) {
      var nk = loop ? (k + 1) % N : k + 1, ds = loop && nk === 0 ? L - cum[k] : cum[nk] - cum[k];
      vmax[k] = Math.min(vmax[k], Math.sqrt(vmax[nk] * vmax[nk] + 2 * 9.5 * ds));
    }
    return { nodes: nodes, loop: !!loop, xs: xs, ys: ys, cum: cum, vmax: vmax, N: N, L: L, ni: ni };
  }
  function ridx(R, i) { return R.loop ? mod(i, R.N) : clamp(i, 0, R.N - 1); }
  // nearest dense index to (x,y), searching from a hint (or everywhere)
  function routeNear(R, x, y, hint, back, fwd) {
    var best = hint == null ? 0 : hint, bd = 1e18, a, b;
    if (hint == null) { a = 0; b = R.N - 1; } else { a = hint - (back || 6); b = hint + (fwd || 40); }
    for (var k = a; k <= b; k++) {
      var ix = ridx(R, k), d = Math.pow(R.xs[ix] - x, 2) + Math.pow(R.ys[ix] - y, 2);
      if (d < bd) { bd = d; best = ix; }
    }
    return best;
  }

  // ---- cars ----
  var CARS = [
    { id: 'sparrow', name: 'Sparrow', cls: 'Hatch', cost: 0, need: 0, acc: 9.6, top: 50, grip: 1.04, hand: 1.18, m: 1050, nos: 1, dur: 0.95, len: 3.9, wid: 1.76, shape: 'hatch', col: [214, 72, 56] },
    { id: 'kestrel', name: 'Kestrel R', cls: 'Tuner', cost: 7000, need: 1, acc: 11.4, top: 57, grip: 1.03, hand: 1.24, m: 1180, nos: 1.25, dur: 1, len: 4.3, wid: 1.8, shape: 'tuner', col: [52, 120, 200] },
    { id: 'brute', name: 'Brute SS', cls: 'Muscle', cost: 11000, need: 2, acc: 13.6, top: 61, grip: 0.9, hand: 0.88, m: 1650, nos: 1.1, dur: 1.35, len: 4.8, wid: 1.96, shape: 'muscle', col: [44, 44, 50] },
    { id: 'titan', name: 'Titan XR', cls: 'Heavy SUV', cost: 13000, need: 3, acc: 10.8, top: 56, grip: 0.93, hand: 0.84, m: 2300, nos: 1, dur: 1.9, len: 4.9, wid: 2.04, shape: 'suv', col: [96, 116, 84] },
    { id: 'mantis', name: 'Mantis GT', cls: 'Sports', cost: 19000, need: 4, acc: 13.4, top: 66, grip: 1.1, hand: 1.12, m: 1360, nos: 1.2, dur: 1.05, len: 4.5, wid: 1.88, shape: 'coupe', col: [232, 186, 40] },
    { id: 'vanta', name: 'Vanta V12', cls: 'Super', cost: 32000, need: 6, acc: 15.2, top: 73, grip: 1.13, hand: 1.03, m: 1480, nos: 1.3, dur: 1.1, len: 4.6, wid: 1.98, shape: 'super', col: [122, 44, 176] },
    { id: 'phantom', name: 'Phantom X', cls: 'Hyper', cost: 52000, need: 8, acc: 17.2, top: 81, grip: 1.18, hand: 1.1, m: 1320, nos: 1.45, dur: 1.05, len: 4.7, wid: 2.0, shape: 'hyper', col: [236, 236, 242] }
  ];
  var CAR_BY = {};
  CARS.forEach(function (c, i) { c.ix = i; CAR_BY[c.id] = c; });
  var TRAFFIC = [
    { shape: 'sedan', len: 4.6, wid: 1.82, m: 1450, w: 5 }, { shape: 'hatch', len: 3.9, wid: 1.74, m: 1100, w: 3 }, { shape: 'taxi', len: 4.7, wid: 1.84, m: 1500, w: 1.5 },
    { shape: 'van', len: 5.2, wid: 2.02, m: 2200, w: 2 }, { shape: 'truck', len: 7.4, wid: 2.4, m: 6500, w: 1 }, { shape: 'bus', len: 11, wid: 2.5, m: 11000, w: 0.5 }
  ];
  var TCOLS = [[196, 198, 202], [52, 54, 60], [150, 30, 36], [36, 70, 130], [222, 222, 216], [96, 104, 112], [128, 100, 70], [40, 96, 74], [180, 150, 100]];
  var COPS = [
    { shape: 'cruiser', len: 4.9, wid: 1.9, m: 1750, acc: 11.2, top: 54, grip: 1.02, hand: 1.02, nos: 0, dur: 1.15 },
    { shape: 'interceptor', len: 4.7, wid: 1.92, m: 1600, acc: 13.5, top: 64, grip: 1.08, hand: 1.08, nos: 0, dur: 1.05 },
    { shape: 'copsuv', len: 5.1, wid: 2.1, m: 2500, acc: 11.4, top: 57, grip: 0.98, hand: 0.92, nos: 0, dur: 1.7 }
  ];
  var UPGS = [
    { id: 'eng', name: 'Engine', tip: 'acceleration and top speed' }, { id: 'tire', name: 'Tires', tip: 'grip and handling' },
    { id: 'nos', name: 'Nitro', tip: 'bigger tank, stronger boost' }, { id: 'arm', name: 'Armor', tip: 'takes less damage, heavier' }
  ];
  var UPC = [900, 2200, 4600];
  var PAINTS = [
    { name: 'Stock', col: null, cost: 0 }, { name: 'Signal Red', col: [214, 52, 44], cost: 400 }, { name: 'Volt Lime', col: [150, 214, 40], cost: 400 },
    { name: 'Ice Blue', col: [90, 180, 236], cost: 400 }, { name: 'Sunburst', col: [246, 156, 30], cost: 500 }, { name: 'Midnight', col: [30, 34, 60], cost: 500 },
    { name: 'Pearl', col: [240, 238, 230], cost: 600 }, { name: 'Magenta', col: [214, 50, 150], cost: 600 }, { name: 'Gunmetal', col: [88, 94, 102], cost: 700 },
    { name: 'Gold Leaf', col: [212, 172, 72], cost: 1500 }
  ];
  function upgCost(carId, l) { var c = CAR_BY[carId]; return Math.round(UPC[l] * (1 + c.ix * 0.35) / 50) * 50; }
  // a model's stats with upgrade levels {eng,tire,nos,arm}
  function stats(spec, u) {
    u = u || {};
    var e = u.eng || 0, t = u.tire || 0, n = u.nos || 0, a = u.arm || 0;
    return {
      acc: spec.acc * (1 + 0.07 * e), top: spec.top * (1 + 0.045 * e), grip: spec.grip * (1 + 0.05 * t), hand: spec.hand * (1 + 0.04 * t),
      nos: (spec.nos || 0) * (1 + 0.15 * n), cap: 1 + 0.3 * n, dur: spec.dur * (1 + 0.22 * a), m: spec.m * (1 + 0.05 * a)
    };
  }
  var cid = 1;
  function newCar(spec, st, x, y, a, kind, col) {
    var nc = Math.max(3, Math.ceil(spec.len / spec.wid));
    var c = {
      id: cid++, kind: kind, spec: spec, shape: spec.shape, x: x, y: y, a: a, vx: 0, vy: 0, w: 0, vf: 0, vr: 0,
      m: st.m || spec.m, len: spec.len, wid: spec.wid, r: spec.wid / 2, nc: nc, px: new Float64Array(nc), py: new Float64Array(nc),
      st: st, ctl: { steer: 0, gas: 0, brake: 0, hb: 0, nos: 0 }, dmg: 0, nosT: 1, nosOn: false, slip: 0, skid: 0, lv: 0, ovp: -1,
      dead: false, hitT: 0, dmgT: 0, dmgS: 0, spiked: 0, col: col || spec.col || [200, 200, 200], ai: null, rc: null, acl: 0, lat: 0, brk: false, sees: false
    };
    c.I = c.m * (c.len * c.len + c.wid * c.wid) / 12;
    circles(c);
    return c;
  }
  function circles(c) {
    var ca = Math.cos(c.a), sa = Math.sin(c.a), span = c.len - c.wid;
    for (var k = 0; k < c.nc; k++) { var o = -span / 2 + span * k / (c.nc - 1); c.px[k] = c.x + ca * o; c.py[k] = c.y + sa * o; }
  }
  var NOCTL = { steer: 0, gas: 0, brake: 1, hb: 1, nos: 0 };
  // one physics step: engine, brakes, grip vs slip, steering with speed, handbrake drift
  function carPhys(g, c, dt) {
    var ca = Math.cos(c.a), sa = Math.sin(c.a), vf = c.vx * ca + c.vy * sa, vr = -c.vx * sa + c.vy * ca;
    var k = c.dead ? NOCTL : c.ctl, st = c.st, wet = g.rain ? 0.82 : 1, spk = c.spiked > 0;
    var nos = !!k.nos && c.nosT > 0 && k.gas > 0 && vf > 2 && st.nos > 0;
    c.nosOn = nos;
    if (nos) c.nosT = Math.max(0, c.nosT - dt * 0.24 / st.cap);
    var top = st.top * (1 - c.dmg * 0.18) * (spk ? 0.6 : 1) * (nos ? 1 + 0.15 * st.nos : 1), acc = 0;
    if (k.gas > 0) {
      if (vf < -1) acc = 14 * k.gas;
      else {
        var q = clamp(vf / top, 0, 1.3);
        acc = st.acc * k.gas * Math.max(0, 1 - q * q) * (q < 0.12 ? 0.7 + q * 2.5 : 1) + (nos ? 6.5 * st.nos : 0);
        if (vf > top) acc = -(vf - top) * 0.9;
      }
    }
    if (k.brake > 0) {
      if (vf > 1) acc -= 15 * k.brake * (g.rain ? 0.85 : 1);
      else if (vf > -top * 0.3) acc -= st.acc * 0.6 * k.brake;
    }
    acc -= vf * 0.011 + (Math.abs(vf) > 0.05 ? sgn(vf) * (k.gas || k.brake ? 0.15 : 1.1) : 0);
    if (k.hb) acc -= sgn(vf) * 2.2;
    var nvf = vf + acc * dt;
    if (!k.gas && !(k.brake && vf <= 1) && vf * nvf < 0) nvf = 0;
    // lateral grip: static up to a limit, then sliding (kinetic) grip until it hooks up again
    var grip = 15 * st.grip * wet * (spk ? 0.5 : 1) * (1 - c.dmg * 0.12) * (k.hb ? 0.38 : 1);
    var sliding = Math.abs(vr) > 2.4 + 0.02 * Math.abs(vf) || (k.hb && Math.abs(vf) > 6);
    var maxd = grip * dt * (sliding ? 0.66 : 1), nvr = vr - clamp(vr, -maxd, maxd);
    if (sliding) nvf -= sgn(nvf) * Math.min(Math.abs(nvf), Math.abs(nvr) * 0.3 * dt);
    // steering: bicycle model, less lock at speed; braking loads the nose (more turn-in)
    var spd = Math.abs(nvf), assist = c.kind === 'player' ? g.assist : 1;
    var maxSt = lerp(0.62, assist >= 2 ? 0.13 : assist ? 0.16 : 0.21, clamp(spd / 55, 0, 1)) * st.hand;
    var wd = nvf * Math.tan(k.steer * maxSt) / 2.7;
    wd *= 1 + (k.brake && vf > 3 ? 0.18 : 0) - (k.gas && !sliding ? 0.04 : 0);
    if (k.hb && spd > 5) wd *= 1.6;
    if (sliding) wd += k.steer * 0.55 * st.hand * Math.min(1, spd / 15);
    wd = clamp(wd, -3.4, 3.4);
    var resp = (sliding || k.hb ? 4.2 : 10) * st.hand;
    c.w += (wd - c.w) * Math.min(1, resp * dt);
    if (assist && sliding && !k.hb && Math.abs(k.steer) < 0.25 && spd > 4) {       // assist: settle a slide nobody is holding
      var beta = Math.atan2(nvr, Math.max(1, spd));
      c.w += beta * dt * (assist >= 2 ? 5 : 2.5);
      nvr *= 1 - dt * (assist >= 2 ? 1.6 : 0.7);
    }
    c.w = clamp(c.w, -6, 6);
    c.vx = ca * nvf - sa * nvr; c.vy = sa * nvf + ca * nvr;
    c.a += c.w * dt;
    if (c.a > Math.PI) c.a -= TAU; else if (c.a < -Math.PI) c.a += TAU;
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.acl += ((nvf - vf) / dt - c.acl) * Math.min(1, dt * 8);
    c.lat += (nvf * c.w - c.lat) * Math.min(1, dt * 8);
    c.vf = nvf; c.vr = nvr; c.slip = Math.abs(nvr);
    c.skid = (sliding && spd > 4) || (k.brake > 0 && vf > 12 && !nos) ? 1 : 0;
    c.brk = k.brake > 0 && vf > 0.5;
    if (c.spiked > 0) c.spiked -= dt;
    if (c.hitT > 0) c.hitT -= dt;
    circles(c);
  }

  // ---- collisions ----
  function impact(g, c, sp, other, x, y) {
    if (sp < 2.5) return;
    if (g.dbg) g.dbg.push({ k: c.kind, o: other ? other.kind || 'prop' : 'wall', sp: sp, x: x, y: y, v: c.vf, id: c.id });
    if (c.dmgT > g.t && sp < c.dmgS * 1.5) return;          // one knock per contact, not one per frame
    c.dmgT = g.t + 0.25; c.dmgS = sp;
    var k = Math.pow(sp - 2.5, 1.3) * 0.0034 / c.st.dur * (c.kind === 'player' ? g.dmgK || 1 : c.kind === 'rival' ? 0.6 : 1);
    if (other) k *= clamp(Math.sqrt(other.m / c.m), 0.4, 2.2);
    if (g.godT > 0 && c.kind === 'player') k *= 0.3;
    c.dmg = Math.min(1, c.dmg + k);
    if (sp > 6) c.hitT = Math.max(c.hitT, c.kind === 'player' ? 0 : 1 + sp * 0.06);
    if (c.dmg >= 1 && !c.dead) {
      c.dead = true;
      if (c.kind !== 'player') g.ev.push({ t: 'wreck', x: c.x, y: c.y, who: c.kind, id: c.id });
    }
    if (c.kind === 'player') g.ev.push({ t: 'hit', x: x, y: y, sp: sp, car: other ? other.kind : 'wall' });
  }
  function hitStatic(g, c, px, py, nx, ny, pen) {
    c.x += nx * pen; c.y += ny * pen;
    var rx = px - c.x, ry = py - c.y, vpx = c.vx - c.w * ry, vpy = c.vy + c.w * rx, vn = vpx * nx + vpy * ny;
    if (vn >= 0) return;
    var rn = rx * ny - ry * nx, inv = 1 / c.m + rn * rn / c.I, j = -1.25 * vn / inv;
    c.vx += nx * j / c.m; c.vy += ny * j / c.m; c.w += rn * j / c.I * 0.6;
    var tx = -ny, ty = nx, vt = vpx * tx + vpy * ty, rt = rx * ty - ry * tx, jt = clamp(-vt / (1 / c.m + rt * rt / c.I), -0.35 * j, 0.35 * j);
    c.vx += tx * jt / c.m; c.vy += ty * jt / c.m; c.w += rt * jt / c.I * 0.6;
    c.w = clamp(c.w, -6, 6);
    if (-vn > 2 && c.kind === 'player' && Math.abs(vt) > 6) g.ev.push({ t: 'scrape', x: px - nx * c.r, y: py - ny * c.r });
    impact(g, c, -vn, null, px - nx * c.r, py - ny * c.r);
  }
  function circBox(g, c, bx, r) {
    for (var k = 0; k < c.nc; k++) {
      var px = c.px[k], py = c.py[k];
      if (px < bx.x0 - r || px > bx.x1 + r || py < bx.y0 - r || py > bx.y1 + r) continue;
      var qx = clamp(px, bx.x0, bx.x1), qy = clamp(py, bx.y0, bx.y1), dx = px - qx, dy = py - qy, d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      var nx, ny, pen;
      if (d2 > 1e-8) { var d = Math.sqrt(d2); nx = dx / d; ny = dy / d; pen = r - d; }
      else {          // the center is inside: push out the short way
        var l = px - bx.x0, rr = bx.x1 - px, t = py - bx.y0, b = bx.y1 - py, m = Math.min(l, rr, t, b);
        nx = m === l ? -1 : m === rr ? 1 : 0; ny = m === t ? -1 : m === b ? 1 : 0;
        if (nx && ny) ny = 0;
        pen = m + r;
      }
      hitStatic(g, c, px, py, nx, ny, pen);
      circles(c);
    }
  }
  function circSeg(g, c, s, r) {
    var sx = s.x1 - s.x0, sy = s.y1 - s.y0, ll = sx * sx + sy * sy;
    for (var k = 0; k < c.nc; k++) {
      var px = c.px[k], py = c.py[k], t = clamp(((px - s.x0) * sx + (py - s.y0) * sy) / ll, 0, 1);
      var qx = s.x0 + sx * t, qy = s.y0 + sy * t, dx = px - qx, dy = py - qy, d2 = dx * dx + dy * dy;
      if (d2 >= r * r || d2 < 1e-10) continue;
      var d = Math.sqrt(d2);
      hitStatic(g, c, px, py, dx / d, dy / d, r - d);
      circles(c);
    }
  }
  function circCirc(g, c, x, y, rad) {
    for (var k = 0; k < c.nc; k++) {
      var dx = c.px[k] - x, dy = c.py[k] - y, d2 = dx * dx + dy * dy, R = c.r + rad;
      if (d2 >= R * R || d2 < 1e-10) continue;
      var d = Math.sqrt(d2);
      hitStatic(g, c, c.px[k], c.py[k], dx / d, dy / d, R - d);
      circles(c);
    }
  }
  var _bs = [];
  function staticCol(g, c) {
    var pad = c.len / 2 + 1, bl = blocksIn(c.x - pad, c.y - pad, c.x + pad, c.y + pad, _bs);
    for (var q = 0; q < bl.length; q++) {
      var b = bl[q], i;
      for (i = 0; i < b.blds.length; i++) { var bd = b.blds[i]; if (c.x + pad > bd.x0 && c.x - pad < bd.x1 && c.y + pad > bd.y0 && c.y - pad < bd.y1) circBox(g, c, bd, c.r); }
      for (i = 0; i < b.water.length; i++) { var w = b.water[i]; if (c.x + pad > w.x0 && c.x - pad < w.x1 && c.y + pad > w.y0 && c.y - pad < w.y1) circBox(g, c, w, c.r); }
      for (i = 0; i < b.trees.length; i++) { var t = b.trees[i]; if (Math.abs(t.x - c.x) < pad + 0.5 && Math.abs(t.y - c.y) < pad + 0.5) circCirc(g, c, t.x, t.y, 0.45); }
      for (i = 0; i < b.segs.length; i++) {
        var s = b.segs[i];
        if (s.lv === 1 && c.lv !== 1) continue;
        if (Math.max(s.x0, s.x1) + pad < c.x || Math.min(s.x0, s.x1) - pad > c.x || Math.max(s.y0, s.y1) + pad < c.y || Math.min(s.y0, s.y1) - pad > c.y) continue;
        circSeg(g, c, s, c.r + 0.25);
      }
    }
  }
  // which level a car is on: inside an overpass box it keeps the level it entered with
  function ovKey(a, b) { return (a + 40000) * 80000 + (b + 40000); }      // always >= 0
  function levelOf(c) {
    var j = rowOf(c.y), i = colOf(c.x), hit = -1;
    for (var b = j; b <= j + 1 && hit < 0; b++) for (var a = i; a <= i + 1; a++) {
      if (!overpass(a, b)) continue;
      var o = ovpBox(a, b);
      if (Math.abs(c.x - o.x) < o.hx && Math.abs(c.y - o.y) < o.hy) {
        hit = ovKey(a, b);
        if (c.ovp !== hit) {
          var al = o.ax ? Math.abs(Math.sin(c.a)) : Math.abs(Math.cos(c.a));
          if (Math.hypot(c.vx, c.vy) > 1) al = o.ax ? Math.abs(c.vy) / Math.hypot(c.vx, c.vy) : Math.abs(c.vx) / Math.hypot(c.vx, c.vy);
          c.lv = al > 0.6 ? 1 : 0;
        }
        break;
      }
    }
    c.ovp = hit;
    if (hit < 0) c.lv = 0;
  }
  function carCar(g, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, R = (a.len + b.len) / 2 + 0.2;
    if (dx * dx + dy * dy > R * R) return;
    if ((a.ovp >= 0 || b.ovp >= 0) && a.lv !== b.lv) return;
    var best = 0, bi = 0, bk = 0, rr = a.r + b.r;
    for (var i = 0; i < a.nc; i++) for (var k = 0; k < b.nc; k++) {
      var ex = b.px[k] - a.px[i], ey = b.py[k] - a.py[i], d2 = ex * ex + ey * ey;
      if (d2 < rr * rr) { var pen = rr - Math.sqrt(d2); if (pen > best) { best = pen; bi = i; bk = k; } }
    }
    if (best <= 0) return;
    var nx = b.px[bk] - a.px[bi], ny = b.py[bk] - a.py[bi], d = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= d; ny /= d;
    var ma = a.m * (a.ai && a.ai.st === 'block' ? 2 : 1), mb = b.m * (b.ai && b.ai.st === 'block' ? 2 : 1), tm = ma + mb;
    a.x -= nx * best * mb / tm; a.y -= ny * best * mb / tm; b.x += nx * best * ma / tm; b.y += ny * best * ma / tm;
    var px = a.px[bi] + nx * a.r, py = a.py[bi] + ny * a.r;
    var rax = px - a.x, ray = py - a.y, rbx = px - b.x, rby = py - b.y;
    var vax = a.vx - a.w * ray, vay = a.vy + a.w * rax, vbx = b.vx - b.w * rby, vby = b.vy + b.w * rbx;
    var vn = (vbx - vax) * nx + (vby - vay) * ny;
    circles(a); circles(b);
    if (vn >= 0) return;
    var ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx, inv = 1 / ma + 1 / mb + ran * ran / a.I + rbn * rbn / b.I, j = -1.2 * vn / inv;
    a.vx -= nx * j / ma; a.vy -= ny * j / ma; a.w -= ran * j / a.I;
    b.vx += nx * j / mb; b.vy += ny * j / mb; b.w += rbn * j / b.I;
    var tx = -ny, ty = nx, vt = (vbx - vax) * tx + (vby - vay) * ty, rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
    var jt = clamp(-vt / (1 / ma + 1 / mb + rat * rat / a.I + rbt * rbt / b.I), -0.3 * j, 0.3 * j);
    a.vx -= tx * jt / ma; a.vy -= ty * jt / ma; a.w -= rat * jt / a.I;
    b.vx += tx * jt / mb; b.vy += ty * jt / mb; b.w += rbt * jt / b.I;
    a.w = clamp(a.w, -6, 6); b.w = clamp(b.w, -6, 6);
    var sp = -vn;
    impact(g, a, sp, b, px, py); impact(g, b, sp, a, px, py);
    if (a.kind === 'player' || b.kind === 'player') {
      var o = a.kind === 'player' ? b : a;
      if (sp > 3) g.ev.push({ t: 'bump', who: o.kind, sp: sp, x: px, y: py, id: o.id });
      if (o.ai && o.ai.st === 'block' && sp > 3) o.ai.st = 'chase';
    }
  }

  // ---- props: knockable street furniture ----
  var PSPEC = {
    cone: { r: 0.32, m: 5, o: [0] }, barrier: { r: 0.5, m: 70, o: [-0.6, 0.6] }, hydrant: { r: 0.32, m: 160, o: [0] }, trash: { r: 0.42, m: 30, o: [0] },
    news: { r: 0.6, m: 60, o: [0] }, fence: { r: 0.48, m: 40, o: [-0.5, 0.5] }, bench: { r: 0.45, m: 45, o: [-0.5, 0.5] }, barrel: { r: 0.45, m: 45, o: [0] },
    mailbox: { r: 0.3, m: 25, o: [0] }, parked: { r: 0.88, m: 1300, o: [-1.35, 0, 1.35] }
  };
  function liveProp(p) { var s = PSPEC[p.k]; return { id: p.id, k: p.k, x: p.x, y: p.y, a: p.a, vx: 0, vy: 0, w: 0, r: s.r, m: s.m, o: s.o, hit: false, mv: false, col: TCOLS[mod(p.id, TCOLS.length)] }; }
  function propsUpdate(g) {
    var P = g.player, R = 150, keep = new Set(), bl = blocksIn(P.x - R, P.y - R, P.x + R, P.y + R, []), k;
    for (k = 0; k < bl.length; k++) {
      var b = bl[k], key = bkey(b.bi, b.bj);
      keep.add(key);
      if (g.actB.has(key)) continue;
      var list = [];
      for (var q = 0; q < b.props.length; q++) { var sp = b.props[q]; if (!g.gone.has(sp.id)) { var lp = liveProp(sp); lp.b = key; list.push(lp); g.props.push(lp); } }
      g.actB.set(key, list);
    }
    var drop = false;
    g.actB.forEach(function (v, key) { if (!keep.has(key)) { g.actB.delete(key); drop = true; } });
    if (drop) g.props = g.props.filter(function (p) { return g.actB.has(p.b); });
    if (g.gone.size > 4000) g.gone.clear();
  }
  function propCol(g, c, p) {
    var dx = p.x - c.x, dy = p.y - c.y, lim = c.len / 2 + 2.6;
    if (dx > lim || dx < -lim || dy > lim || dy < -lim) return;
    var ca = Math.cos(p.a), sa = Math.sin(p.a);
    for (var a = 0; a < p.o.length; a++) {
      var qx = p.x + ca * p.o[a], qy = p.y + sa * p.o[a];
      for (var k = 0; k < c.nc; k++) {
        var ex = qx - c.px[k], ey = qy - c.py[k], d2 = ex * ex + ey * ey, R = c.r + p.r;
        if (d2 >= R * R || d2 < 1e-10) continue;
        var d = Math.sqrt(d2), nx = ex / d, ny = ey / d, pen = R - d, tm = c.m + p.m;
        p.x += nx * pen * c.m / tm; p.y += ny * pen * c.m / tm; c.x -= nx * pen * p.m / tm; c.y -= ny * pen * p.m / tm;
        var vn = (p.vx - c.vx) * nx + (p.vy - c.vy) * ny;
        if (vn < 0) {
          var j = -(p.k === 'parked' ? 1.2 : 1.4) * vn / (1 / c.m + 1 / p.m);
          p.vx += nx * j / p.m; p.vy += ny * j / p.m; c.vx -= nx * j / c.m; c.vy -= ny * j / c.m;
          var tv = (c.vx * -ny + c.vy * nx);
          p.w += (tv * 0.4 + (g.rng() - 0.5) * 4) * (p.k === 'parked' ? 0.15 : 1);
          if (p.k === 'parked') { c.w += (ex * c.vy - ey * c.vx) * 0.002 * (j / c.m); impact(g, c, -vn, { m: p.m }, qx, qy); }
          p.mv = true;
          if (!p.hit && -vn > 1.5) {
            p.hit = true;
            if (p.k !== 'parked') g.gone.add(p.id);
            if (c.kind === 'player') g.ev.push({ t: 'prop', k: p.k, x: p.x, y: p.y, sp: -vn });
            else if (-vn > 4) g.ev.push({ t: 'propx', k: p.k, x: p.x, y: p.y, sp: -vn });
          }
        }
        circles(c);
      }
    }
  }
  function propsStep(g, dt) {
    for (var i = 0; i < g.props.length; i++) {
      var p = g.props[i];
      if (!p.mv) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.w * dt;
      var f = Math.exp(-dt * (p.k === 'parked' ? 2.6 : 1.4));
      p.vx *= f; p.vy *= f; p.w *= Math.exp(-dt * 2);
      if (Math.abs(p.vx) + Math.abs(p.vy) < 0.05 && Math.abs(p.w) < 0.05) p.mv = false;
      // bounce off buildings
      var b = blockAt(p.x, p.y);
      for (var q = 0; q < b.blds.length; q++) {
        var bx = b.blds[q];
        if (p.x > bx.x0 - p.r && p.x < bx.x1 + p.r && p.y > bx.y0 - p.r && p.y < bx.y1 + p.r) {
          var l = p.x - bx.x0 + p.r, rr = bx.x1 + p.r - p.x, t = p.y - bx.y0 + p.r, bb = bx.y1 + p.r - p.y, m = Math.min(l, rr, t, bb);
          if (m === l) { p.x -= l; p.vx = -Math.abs(p.vx) * 0.3; } else if (m === rr) { p.x += rr; p.vx = Math.abs(p.vx) * 0.3; }
          else if (m === t) { p.y -= t; p.vy = -Math.abs(p.vy) * 0.3; } else { p.y += bb; p.vy = Math.abs(p.vy) * 0.3; }
        }
      }
    }
  }

  // ---- difficulty ----
  var DIFFS = [
    { name: 'Easy', cop: 0.8, copSpd: 0.92, rival: 0.92, rb: 1.02, traffic: 0.7, bust: 4, evade: 0.75, cops: -1, dmg: 0.7 },
    { name: 'Normal', cop: 1, copSpd: 1, rival: 1, rb: 1.06, traffic: 1, bust: 3, evade: 1, cops: 0, dmg: 1 },
    { name: 'Hard', cop: 1.25, copSpd: 1.06, rival: 1.06, rb: 1.1, traffic: 1.25, bust: 2.3, evade: 1.3, cops: 1, dmg: 1.25 }
  ];
  var HEAT_AT = [0, 10, 45, 110, 210, 340];
  function heatLvl(p) { var l = 0; for (var i = 1; i < HEAT_AT.length; i++) if (p >= HEAT_AT[i]) l = i; return l; }

  // ---- AI driving helpers ----
  var _o = {}, _o2 = {};
  function drive(c, tx, ty, vt, hb) {
    var ai = c.ai, k = c.ctl, d = angDiff(c.a, Math.atan2(ty - c.y, tx - c.x));
    if (ai.rev > 0) { k.gas = 0; k.brake = 1; k.hb = 0; k.nos = 0; k.steer = -clamp(d * 2, -1, 1); return; }
    k.steer = clamp(d * 2.6 - c.w * 0.3, -1, 1);
    var err = vt - c.vf;
    if (Math.abs(d) > 1.9 && c.vf > 6) err = Math.min(err, -4);
    k.gas = err > 0.4 ? clamp(err / 4, 0.35, 1) : 0;
    k.brake = err < -0.6 ? clamp(-err / 5, 0.25, 1) : 0;
    k.hb = hb && Math.abs(d) > 0.75 && c.vf > 13 ? 1 : 0;
  }
  function stuck(c, dt) {
    var ai = c.ai;
    if (ai.rev > 0) { ai.rev -= dt; return; }
    if (c.ctl.gas > 0 && Math.abs(c.vf) < 1.3) ai.stk += dt; else ai.stk = Math.max(0, ai.stk - dt * 2);
    if (ai.stk > 1.4) { ai.stk = 0; ai.rev = 1 + Math.random() * 0.5; }
  }
  // the car ahead in this car's corridor: distance or Infinity
  function gapAhead(g, c, range, half) {
    var ca = Math.cos(c.a), sa = Math.sin(c.a), best = Infinity, cs = g.cars;
    for (var i = 0; i < cs.length; i++) {
      var o = cs[i];
      if (o === c) continue;
      var dx = o.x - c.x, dy = o.y - c.y;
      if (dx > range || dx < -range || dy > range || dy < -range) continue;
      var al = dx * ca + dy * sa, lt = -dx * sa + dy * ca;
      if (al > 0 && al < range && Math.abs(lt) < half + o.wid / 2 && (c.ovp < 0 || o.lv === c.lv)) best = Math.min(best, al - (c.len + o.len) / 2);
    }
    return best;
  }
  // lane following on the street graph (traffic and patrols)
  function setLane(c, ax, n, dir, lane) {
    var L = lineOf(ax, n), s = ax ? c.y : c.x;
    c.ai.ax = ax; c.ai.n = n; c.ai.dir = dir; c.ai.lane = Math.min(lane, L.lanes - 1);
    c.ai.k = nextNode(ax, n, s, dir); c.ai.nx = null;
    c.ai.off = laneOff(L, c.ai.lane);
  }
  function snapLane(c) {
    var R = nearestRoad(c.x, c.y), L = R.L, tx = R.ax ? 0 : 1, ty = R.ax ? 1 : 0;
    var dir = Math.cos(c.a) * tx + Math.sin(c.a) * ty >= 0 ? 1 : -1;
    if (!edgeOK(R.ax, R.n, nextNode(R.ax, R.n, R.ax ? c.y : c.x, dir), dir) && false) dir = -dir;
    setLane(c, R.ax, R.n, dir, 0);
  }
  function chooseNext(g, c) {
    var ai = c.ai, ij = nodeIJ(ai.ax, ai.n, ai.k), i = ij[0], j = ij[1], opts = [], tot = 0;
    var ovp = overpass(i, j), traffic = c.kind === 'traffic';
    function add(ax, n, dir, w) {
      var kk = ax ? j : i;
      if (!edgeOK(ax, n, kk, dir)) return;
      var L = lineOf(ax, n);
      if (L.t === 'alley' && traffic) return;
      if (L.t === 'alley') w *= 0.3;
      opts.push([ax, n, dir, w]); tot += w;
    }
    add(ai.ax, ai.n, ai.dir, 0.6);
    if (!ovp) {
      var oax = 1 - ai.ax, on = oax ? i : j;
      add(oax, on, 1, 0.2); add(oax, on, -1, 0.2);
    }
    if (!opts.length) add(ai.ax, ai.n, -ai.dir, 1);
    if (!opts.length) { ai.nx = { ax: ai.ax, n: ai.n, dir: -ai.dir }; return; }
    var x = g.rng() * tot, pick = opts[0];
    for (var q = 0; q < opts.length; q++) { x -= opts[q][3]; if (x <= 0) { pick = opts[q]; break; } }
    ai.nx = { ax: pick[0], n: pick[1], dir: pick[2], ij: [i, j] };
  }
  function laneAI(g, c, dt, lim, obey) {
    var ai = c.ai, L = lineOf(ai.ax, ai.n), s = ai.ax ? c.y : c.x;
    if (c.dead || c.hitT > 0) { c.ctl.gas = 0; c.ctl.brake = 1; c.ctl.nos = 0; c.ctl.hb = 0; if (c.hitT > 0 && c.hitT < dt * 1.5) snapLane(c); return; }
    var sN = nodeS(ai.ax, ai.n, ai.k), dN = (sN - s) * ai.dir, ij = nodeIJ(ai.ax, ai.n, ai.k), X = lineOf(1 - ai.ax, ai.ax ? ij[1] : ij[0]);
    if (dN < -X.hw - 4 && !ai.nx) { ai.k = nextNode(ai.ax, ai.n, s, ai.dir); return; }
    var v = Math.max(0, c.vf), look = 7 + v * 0.5;
    if (!ai.nx && dN < look + 14) chooseNext(g, c);
    if (ai.nx && dN < X.hw * 0.6) {        // in the intersection: take the next edge
      var nx = ai.nx;
      setLane(c, nx.ax, nx.n, nx.dir, ai.lane);
      if (nx.ax !== 1 - ai.ax || true) {
        var kk = nx.ax ? ij[1] : ij[0];
        ai.k = kk + nx.dir;
      }
      return;
    }
    if (ai.lc > 0) ai.lc -= dt;
    else if (L.lanes > 1 && dN > 45) { ai.lane = ai.lane ? 0 : Math.min(1, L.lanes - 1); if (L.lanes > 2 && g.rng() < 0.5) ai.lane = 2; ai.lc = 8 + g.rng() * 14; }
    ai.off += (laneOff(L, Math.min(ai.lane, L.lanes - 1)) - ai.off) * Math.min(1, dt * 1.2);
    var tx, ty, turning = false;
    if (ai.nx && dN < look) {
      var nx2 = ai.nx, NL = lineOf(nx2.ax, nx2.n), sn = nodeS(nx2.ax, nx2.n, nx2.ax ? ij[1] : ij[0]);
      lanePt(nx2.ax, nx2.n, sn + nx2.dir * Math.max(look - dN, X.hw * 0.5 + 3), nx2.dir, laneOff(NL, Math.min(ai.lane, NL.lanes - 1)), _o);
      tx = _o.x; ty = _o.y; turning = nx2.ax !== ai.ax;
    } else { lanePt(ai.ax, ai.n, s + ai.dir * look, ai.dir, ai.off, _o); tx = _o.x; ty = _o.y; }
    var vt = lim;
    if (ai.nx && (ai.nx.ax !== ai.ax || ai.nx.dir !== ai.dir) && dN < 30) vt = Math.min(vt, 7 + Math.max(0, dN) * 0.35);
    if (obey && signaled(ij[0], ij[1])) {
      var lt = light(ij[0], ij[1], g.t, ai.ax), stopD = dN - (X.hw + 2.5);
      if (lt && stopD > -0.5 && !(lt === 1 && stopD < v * 0.9)) vt = Math.min(vt, Math.sqrt(2 * 4.5 * Math.max(0, stopD - 0.8)));
    }
    // a left turn yields to oncoming cars
    if (ai.nx && ai.nx.ax !== ai.ax && dN < 14 && dN > -X.hw * 0.4) {
      var hx = ai.ax ? 0 : ai.dir, hy = ai.ax ? ai.dir : 0, nhx = ai.nx.ax ? 0 : ai.nx.dir, nhy = ai.nx.ax ? ai.nx.dir : 0;
      if (hx * nhy - hy * nhx < 0) {
        for (var q = 0; q < g.cars.length; q++) {
          var o = g.cars[q];
          if (o === c || Math.abs(o.x - c.x) > 60 || Math.abs(o.y - c.y) > 60) continue;
          var ov = ai.ax ? o.vy : o.vx, od = (ai.ax ? o.y : o.x) - sN, lat = ai.ax ? Math.abs(o.x - c.x) : Math.abs(o.y - c.y);
          if (lat < L.hw + 1 && ov * ai.dir < -2 && od * ai.dir > -X.hw && od * ai.dir < 50) { vt = Math.min(vt, Math.max(0, (dN + X.hw * 0.3) * 0.8)); break; }
        }
      }
    }
    var gap = gapAhead(g, c, 34, 1.3);
    if (gap < 34) vt = Math.min(vt, Math.max(0, (gap - 3) * 0.75));
    if (gap < 4 && c.vf < 1) { ai.blk = (ai.blk || 0) + dt; if (ai.blk > 4 && L.lanes > 1) { ai.lane = ai.lane ? 0 : 1; ai.blk = 0; } }
    else ai.blk = 0;
    drive(c, tx, ty, vt, false);
    if (vt < 0.5 && c.vf < 0.6) { c.ctl.brake = 1; c.ctl.gas = 0; }
    stuck(c, dt);
  }
  // follow a path of nodes (cops off sight, searching); returns false at the end
  function pathAI(g, c, dt, top) {
    var ai = c.ai, P = ai.path;
    if (!P || ai.pi >= P.length) return false;
    var nd = P[ai.pi], nx = nodeX(nd[0], nd[1]), ny = Yp(nd[1]), d = Math.hypot(nx - c.x, ny - c.y);
    var tx = nx, ty = ny, vt = top;
    if (ai.pi + 1 < P.length) {
      var n2 = P[ai.pi + 1], x2 = nodeX(n2[0], n2[1]), y2 = Yp(n2[1]), ex = x2 - nx, ey = y2 - ny, el = Math.hypot(ex, ey) || 1;
      var pv = ai.pi > 0 ? P[ai.pi - 1] : null, turn = pv ? Math.abs(angDiff(Math.atan2(ny - Yp(pv[1]), nx - nodeX(pv[0], pv[1])), Math.atan2(ey, ex))) : 0.8;
      if (turn > 0.4) vt = Math.min(top, Math.sqrt(12 * 20) + Math.max(0, d - 14) * 0.9);
      if (d < 16) { tx = nx + ex / el * 12; ty = ny + ey / el * 12; }
      if (d < 9 || (ex * (c.x - nx) + ey * (c.y - ny)) / el > 2) ai.pi++;
    } else if (d < 10) ai.pi++;
    drive(c, tx, ty, vt, true);
    stuck(c, dt);
    return true;
  }

  // ---- spawning ----
  function roadSpot(g, cx, cy, rmin, rmax, bias, kind) {
    for (var t = 0; t < 14; t++) {
      var ang = bias != null && g.rng() < 0.7 ? bias + (g.rng() - 0.5) * 1.6 : g.rng() * TAU, d = rmin + g.rng() * (rmax - rmin);
      var x = cx + Math.cos(ang) * d, y = cy + Math.sin(ang) * d, R = nearestRoad(x, y);
      if (R.L.t === 'alley' && kind !== 'cop') continue;
      var s = R.ax ? y : x;
      if (R.ax) x = vx(R.n, y); else y = Yp(R.n);
      if (nodeAt(x, y, 7)) continue;
      if (R.ax && !hasV(R.n, rowOf(y))) continue;
      var ok = true;
      for (var i = 0; i < g.cars.length; i++) { var o = g.cars[i]; if (Math.abs(o.x - x) < 14 && Math.abs(o.y - y) < 14) { ok = false; break; } }
      if (ok) return { ax: R.ax, n: R.n, s: s, L: R.L };
    }
    return null;
  }
  function placeOnLane(c, ax, n, s, dir, lane) {
    var L = lineOf(ax, n);
    lanePt(ax, n, s, dir, laneOff(L, Math.min(lane, L.lanes - 1)), _o2);
    c.x = _o2.x; c.y = _o2.y; c.a = Math.atan2(_o2.hy, _o2.hx);
    circles(c);
  }
  function mkAI(st) { return { st: st, ax: 0, n: 0, dir: 1, lane: 0, k: 0, nx: null, off: 0, lc: 5, rev: 0, stk: 0, path: null, pi: 0, pathT: 0, tick: 0, role: 0, side: 1, spd: 1 }; }
  function spawnTraffic(g, near) {
    var P = g.player, sp = Math.hypot(P.vx, P.vy), bias = sp > 8 ? Math.atan2(P.vy, P.vx) : null;
    var spot = roadSpot(g, P.x, P.y, near ? 40 : 95, near ? 150 : 170, bias, 'traffic');
    if (!spot) return null;
    var tot = 0, i;
    for (i = 0; i < TRAFFIC.length; i++) tot += TRAFFIC[i].w;
    var x = g.rng() * tot, T = TRAFFIC[0];
    for (i = 0; i < TRAFFIC.length; i++) { x -= TRAFFIC[i].w; if (x <= 0) { T = TRAFFIC[i]; break; } }
    if (spot.L.t === 'hwy' && T.shape === 'bus') T = TRAFFIC[0];
    var col = T.shape === 'taxi' ? [236, 190, 40] : T.shape === 'bus' ? [60, 120, 170] : TCOLS[Math.floor(g.rng() * TCOLS.length)];
    var spec = { shape: T.shape, len: T.len, wid: T.wid, m: T.m, acc: T.len > 6 ? 4.5 : 7, top: 40, grip: 1, hand: 0.9, nos: 0, dur: T.len > 6 ? 2.5 : 1.3, col: col };
    var c = newCar(spec, stats(spec), 0, 0, 0, 'traffic', col), dir = g.rng() < 0.5 ? 1 : -1;
    placeOnLane(c, spot.ax, spot.n, spot.s, dir, Math.floor(g.rng() * spot.L.lanes));
    c.ai = mkAI('lane'); c.ai.spd = 0.78 + g.rng() * 0.26;
    setLane(c, spot.ax, spot.n, dir, Math.floor(g.rng() * spot.L.lanes));
    var v = spot.L.lim * c.ai.spd * 0.8;
    c.vx = Math.cos(c.a) * v; c.vy = Math.sin(c.a) * v;
    g.cars.push(c);
    return c;
  }
  function copSpec(g, lvl) {
    var D = DIFFS[g.diff], ix = lvl >= 4 && g.rng() < 0.35 ? 2 : lvl >= 3 && g.rng() < 0.5 ? 1 : 0, B = COPS[ix];
    var sp = {}; for (var k in B) sp[k] = B[k];
    sp.top = B.top * D.copSpd * (1 + lvl * 0.025); sp.acc = B.acc * (1 + lvl * 0.03);
    sp.col = [24, 26, 32];
    return sp;
  }
  function spawnCop(g, st, rmin, rmax, bias) {
    var P = g.player, spot = roadSpot(g, P.x, P.y, rmin, rmax, bias, 'cop');
    if (!spot) return null;
    var spec = copSpec(g, g.heat.lvl), c = newCar(spec, stats(spec), 0, 0, 0, 'cop', spec.col);
    var toward = ((spot.ax ? P.y - spot.s : P.x - spot.s) >= 0) ? 1 : -1;
    placeOnLane(c, spot.ax, spot.n, spot.s, toward, 0);
    c.ai = mkAI(st); c.ai.role = g.copRole++ % 3; c.ai.side = g.rng() < 0.5 ? -1 : 1;
    setLane(c, spot.ax, spot.n, toward, 0);
    var v = st === 'patrol' ? 10 : 22;
    c.vx = Math.cos(c.a) * v; c.vy = Math.sin(c.a) * v;
    g.cars.push(c);
    return c;
  }

  // ---- police ----
  function newHeat(pts) {
    return { pts: pts || 0, lvl: heatLvl(pts || 0), st: 'none', lastSeen: -99, seen: false, visT: 0, evade: 0, bust: 0, chaseT: 0, bounty: 0, mult: 1,
      lk: { x: 0, y: 0 }, rbT: 12, spawnT: 0, rb: [], spikes: [], heli: null, copsDown: 0, infrT: {} };
  }
  function infr(g, pts, why, x, y) {
    var H = g.heat;
    if (g.noCops) return;
    var k = H.st !== 'none' || H.seen ? 1 : 0.5;
    H.pts += pts * k * (DIFFS[g.diff].cop * 0.3 + 0.7);
    if (H.st !== 'none') H.bounty += pts * 25 * H.lvl;
  }
  function copSees(g, c, P) {
    if (c.dead || c.hitT > 0.6) return false;
    var H = g.heat, dx = P.x - c.x, dy = P.y - c.y, d = Math.hypot(dx, dy);
    var range = (48 + H.lvl * 10) * (g.night ? 0.8 : 1) * (g.rain ? 0.85 : 1) * (H.st === 'chase' ? 1.6 : 1) * DIFFS[g.diff].cop;
    if (d > range) return false;
    if (P.ovp >= 0 && P.lv !== c.lv && d > 8) return false;
    if (P.tun && !c.tun && d > 20) return false;
    if (H.st === 'none' && d > 14) {     // a patrol only notices what is in front of it
      var f = (dx * Math.cos(c.a) + dy * Math.sin(c.a)) / d;
      if (f < 0.1) return false;
    }
    return d < 9 || los(c.x, c.y, P.x, P.y);
  }
  function policeStep(g, dt) {
    var H = g.heat, P = g.player, D = DIFFS[g.diff], cs = g.cars, i, c;
    var old = H.lvl;
    H.lvl = heatLvl(H.pts);
    if (H.lvl > old) g.ev.push({ t: 'heat', lvl: H.lvl });
    // vision, five times a second
    H.visT -= dt;
    if (H.visT <= 0) {
      H.visT = 0.2;
      var seen = false;
      for (i = 0; i < cs.length; i++) { c = cs[i]; if (c.kind === 'cop') { c.sees = copSees(g, c, P); if (c.sees) seen = true; } }
      if (H.heli && !P.tun && !(P.ovp >= 0 && P.lv === 0) && Math.hypot(H.heli.sx - P.x, H.heli.sy - P.y) < 15) seen = true;
      H.seen = seen;
      if (seen) { H.lastSeen = g.t; H.lk.x = P.x; H.lk.y = P.y; }
      // speeding past a cop
      if (seen && H.st === 'none') {
        var R = nearestRoad(P.x, P.y), sp = Math.hypot(P.vx, P.vy);
        if (sp > R.L.lim + 9 && !(H.infrT.speed > g.t)) { H.infrT.speed = g.t + 5; infr(g, 12, 'speed'); g.ev.push({ t: 'infr', why: 'Speeding' }); }
        H.lvl = heatLvl(H.pts);
      }
    }
    var sp2 = Math.hypot(P.vx, P.vy);
    if (H.st === 'none') {
      H.pts = Math.max(0, H.pts - dt * 0.6);
      if (H.seen && H.lvl >= 1 && !g.noCops) { H.st = 'chase'; H.chaseT = 0; H.bounty = 0; H.mult = 1; H.evade = 0; H.copsDown = 0; g.ev.push({ t: 'pursuit' }); }
    } else {
      H.chaseT += dt;
      H.pts += dt * (1.3 + H.lvl * 0.25) * D.cop;
      H.mult = Math.min(5, 1 + Math.floor(H.chaseT / 20) * 0.5);
      H.bounty += dt * 12 * H.lvl * (H.st === 'chase' ? 1 : 0.4);
      if (H.st === 'chase' && g.t - H.lastSeen > 2.6) { H.st = 'cool'; H.evade = 0; g.ev.push({ t: 'cool' }); }
      else if (H.st === 'cool') {
        if (H.seen) { H.st = 'chase'; H.evade *= 0.4; g.ev.push({ t: 'spotted' }); }
        else {
          H.evade += dt / ((7 + H.lvl * 3.2) * D.evade);
          if (H.evade >= 1) {
            var cash = Math.round(H.bounty * H.mult / 10);
            g.ev.push({ t: 'evaded', bounty: Math.round(H.bounty * H.mult), cash: cash, lvl: H.lvl, time: H.chaseT, cops: H.copsDown });
            g.won.bounty = Math.round(H.bounty * H.mult); g.won.cash += cash;
            H.st = 'none'; H.evade = 0; H.bust = 0; H.heli = null;
            for (i = 0; i < cs.length; i++) if (cs[i].kind === 'cop' && cs[i].ai.st !== 'block') { cs[i].ai.st = 'patrol'; snapLane(cs[i]); }
          }
        }
      }
      // busted: stopped with a cop on you
      var near = 0;
      for (i = 0; i < cs.length; i++) { c = cs[i]; if (c.kind === 'cop' && !c.dead && Math.abs(c.x - P.x) < 11 && Math.abs(c.y - P.y) < 11 && Math.hypot(c.x - P.x, c.y - P.y) < 10 && (c.ovp < 0 || c.lv === P.lv)) near++; }
      if (near && sp2 < 3.2) H.bust += dt * (near >= 2 ? 1.5 : 1);
      else H.bust = Math.max(0, H.bust - dt * (sp2 > 8 ? 1.2 : 0.5));
      if (H.bust >= D.bust || (P.dead && H.st !== 'none')) {
        var fine = Math.round(250 + H.lvl * 250 + H.bounty * 0.04);
        g.ev.push({ t: 'busted', fine: fine, bounty: Math.round(H.bounty * H.mult), lvl: H.lvl, wreck: P.dead });
        g.busted = true;
        return;
      }
    }
    // cop numbers: patrols around town, more during a pursuit
    var want = H.st === 'none' ? (g.noCops ? 0 : g.patrols) : Math.max(1, [0, 2, 3, 4, 5, 6][H.lvl] + D.cops), n = 0, far = H.st === 'none' ? 260 : 420;
    for (i = cs.length - 1; i >= 0; i--) {
      c = cs[i];
      if (c.kind !== 'cop') continue;
      var dd = Math.hypot(c.x - P.x, c.y - P.y);
      if (dd > far || (c.dead && dd > 120) || (c.ai.st === 'block' && dd > 180)) { cs.splice(i, 1); continue; }
      if (!c.dead && c.ai.st !== 'block') n++;
    }
    H.spawnT -= dt;
    if (n < want && H.spawnT <= 0) {
      H.spawnT = H.st === 'none' ? 4 : 1.6 / D.cop;
      var bias = sp2 > 8 ? Math.atan2(P.vy, P.vx) : null;
      spawnCop(g, H.st === 'none' ? 'patrol' : 'chase', H.st === 'none' ? 130 : 105, H.st === 'none' ? 230 : 175, bias);
    }
    if (H.st !== 'none') {
      roadblocks(g, dt);
      // helicopter at heat 5
      if (H.lvl >= 5 && !H.heli) { var ha = g.rng() * TAU; H.heli = { x: P.x + Math.cos(ha) * 220, y: P.y + Math.sin(ha) * 220, vx: 0, vy: 0, sx: P.x, sy: P.y, a: 0 }; g.ev.push({ t: 'heli' }); }
    }
    if (H.heli) {
      var hl = H.heli, tx = H.seen ? P.x + P.vx * 0.6 : H.lk.x + Math.cos(g.t * 0.5) * 40, ty = H.seen ? P.y + P.vy * 0.6 : H.lk.y + Math.sin(g.t * 0.5) * 40;
      var hx = tx - hl.x, hy = ty - hl.y, hd = Math.hypot(hx, hy) || 1, hs = Math.min(40 * D.copSpd, hd * 1.2);
      hl.vx += (hx / hd * hs - hl.vx) * Math.min(1, dt * 1.2); hl.vy += (hy / hd * hs - hl.vy) * Math.min(1, dt * 1.2);
      hl.x += hl.vx * dt; hl.y += hl.vy * dt; hl.a = Math.atan2(hl.vy, hl.vx);
      hl.sx += (hl.x + hl.vx * 0.2 - hl.sx) * Math.min(1, dt * 3); hl.sy += (hl.y + hl.vy * 0.2 - hl.sy) * Math.min(1, dt * 3);
      if (H.st === 'none' || H.lvl < 5) { hl.leave = (hl.leave || 0) + dt; if (hl.leave > 6) H.heli = null; }
    }
    // spike strips
    for (i = H.spikes.length - 1; i >= 0; i--) {
      var s = H.spikes[i], ca = Math.cos(s.a), sa = Math.sin(s.a), dx = P.x - s.x, dy = P.y - s.y, al = dx * ca + dy * sa, lt = -dx * sa + dy * ca;
      if (!s.used && Math.abs(al) < s.len / 2 + 0.6 && Math.abs(lt) < 1.6 + P.len * 0.3) { s.used = true; P.spiked = 14; P.dmg = Math.min(0.99, P.dmg + 0.08); g.ev.push({ t: 'spiked', x: P.x, y: P.y }); }
      if (Math.hypot(dx, dy) > 300) H.spikes.splice(i, 1);
    }
  }
  function roadblocks(g, dt) {
    var H = g.heat, P = g.player;
    for (var i = H.rb.length - 1; i >= 0; i--) { var rb = H.rb[i]; rb.t += dt; if (rb.t > 50 || Math.hypot(rb.x - P.x, rb.y - P.y) > 320) H.rb.splice(i, 1); }
    if (H.lvl < 3) return;
    H.rbT -= dt;
    if (H.rbT > 0 || H.rb.length) return;
    H.rbT = 2;          // try again soon unless one gets placed
    var sp = Math.hypot(P.vx, P.vy);
    if (sp < 12) return;
    var R = nearestRoad(P.x, P.y), ax = R.ax, n = R.n, L = R.L, dir = (ax ? P.vy : P.vx) >= 0 ? 1 : -1, s = ax ? P.y : P.x;
    var k = nextNode(ax, n, s, dir), sN, tries = 0;
    while (tries++ < 6) {
      sN = nodeS(ax, n, k);
      if ((sN - s) * dir > 110 + sp) break;
      if (!edgeOK(ax, n, k, dir)) return;
      k += dir;
    }
    if (!edgeOK(ax, n, k, dir)) return;
    var ij = nodeIJ(ax, n, k), X = lineOf(1 - ax, ax ? ij[1] : ij[0]), at = sN + dir * (X.hw + 14);
    if (Math.abs(nodeS(ax, n, k + dir) - sN) < X.hw + 30) return;
    if (ax && overpass(ij[0], ij[1])) return;
    var cnt = H.lvl >= 4 ? 3 : 2, w = L.hw * 2, gapSlot = Math.floor(g.rng() * (cnt + 1)), slots = cnt + 1, rb2 = { x: 0, y: 0, t: 0, cars: [] };
    for (var q = 0; q < slots; q++) {
      var off = -L.hw + w * (q + 0.5) / slots;
      lanePt(ax, n, at, dir, off, _o);
      if (q === gapSlot) {
        if (H.lvl >= 4) H.spikes.push({ x: _o.x, y: _o.y, a: Math.atan2(_o.hy, _o.hx) + Math.PI / 2, len: Math.min(5, w / slots), used: false });
        continue;
      }
      var spec = copSpec(g, H.lvl), c = newCar(spec, stats(spec), _o.x, _o.y, Math.atan2(_o.hy, _o.hx) + Math.PI / 2 + (g.rng() - 0.5) * 0.5, 'cop', spec.col);
      c.ai = mkAI('block'); c.ai.role = 2;
      c.ctl.brake = 1; c.ctl.hb = 1;
      g.cars.push(c); rb2.cars.push(c.id);
    }
    lanePt(ax, n, at, dir, 0, _o);
    rb2.x = _o.x; rb2.y = _o.y;
    H.rbT = 26 - H.lvl * 2.5;
    H.rb.push(rb2);
    g.ev.push({ t: 'roadblock', x: rb2.x, y: rb2.y, spikes: H.lvl >= 4 });
  }
  function copAI(g, c, dt) {
    var H = g.heat, P = g.player, ai = c.ai, k = c.ctl;
    if (c.dead) { k.gas = 0; k.brake = 1; k.hb = 1; return; }
    if (ai.st === 'block') { k.gas = 0; k.brake = 1; k.hb = 1; k.steer = 0; return; }
    if (H.st === 'none' || ai.st === 'patrol') {
      if (H.st !== 'none') { ai.st = 'chase'; }
      else { laneAI(g, c, dt, nearestRoad(c.x, c.y).L.lim * 1.1, true); return; }
    }
    var top = c.st.top * (1 + (Math.hypot(P.x - c.x, P.y - c.y) > 130 ? 0.1 : 0));
    if (c.hitT > 0.4) { k.gas = 0.3; k.brake = 0; stuck(c, dt); return; }
    var dx = P.x - c.x, dy = P.y - c.y, d = Math.hypot(dx, dy);
    if (H.st === 'chase' && (c.sees || d < 12)) {
      ai.path = null;
      var pf = { x: Math.cos(P.a), y: Math.sin(P.a) }, pr = { x: -pf.y, y: pf.x }, ps = Math.hypot(P.vx, P.vy);
      var lead = clamp(d / Math.max(12, c.vf + 4), 0, 1.4) * DIFFS[g.diff].cop, tx = P.x + P.vx * lead, ty = P.y + P.vy * lead;
      var behind = (c.x - P.x) * pf.x + (c.y - P.y) * pf.y, side = (c.x - P.x) * pr.x + (c.y - P.y) * pr.y >= 0 ? 1 : -1;
      var vt = top, hb = false;
      if (ai.role === 0 && d < 18 && behind < 0) {          // PIT: aim for a rear quarter
        tx = P.x - pf.x * 1.4 + pr.x * side * 1.2 + P.vx * 0.3; ty = P.y - pf.y * 1.4 + pr.y * side * 1.2 + P.vy * 0.3;
        vt = ps + 6;
      } else if (ai.role === 1 && d < 30) {                 // pull alongside, then lean in
        tx = P.x + pf.x * 3 + pr.x * side * (d < 8 ? 0.5 : 3) + P.vx * 0.4; ty = P.y + pf.y * 3 + pr.y * side * (d < 8 ? 0.5 : 3) + P.vy * 0.4;
        vt = ps + 5;
      } else if (ai.role === 2 && ps > 10) {                // cut off: get ahead and block
        if (behind > 8) { tx = P.x + pf.x * 10; ty = P.y + pf.y * 10; vt = Math.max(0, ps - 6); hb = true; }
        else { tx = P.x + P.vx * 1.6 + pf.x * 14; ty = P.y + P.vy * 1.6 + pf.y * 14; }
      }
      if (d < 6 && ps < 4) { vt = 0; }
      drive(c, tx, ty, Math.min(top, vt), hb || d > 20);
      if (d > 50 && c.st.nos) k.nos = 1;
      stuck(c, dt);
      return;
    }
    // out of sight: route to the last known position over the streets
    ai.pathT -= dt;
    var tx2 = H.lk.x, ty2 = H.lk.y;
    if (!ai.path || ai.pathT <= 0) {
      ai.pathT = 1.2 + g.rng() * 0.6;
      var a = nearNode(c.x, c.y), b = nearNode(tx2, ty2);
      if (H.st === 'cool' && Math.hypot(c.x - tx2, c.y - ty2) < 30) { b = [b[0] + Math.floor(g.rng() * 5) - 2, b[1] + Math.floor(g.rng() * 5) - 2]; ai.pathT = 6; }
      ai.path = findPath(a[0], a[1], -1, b[0], b[1], 500); ai.pi = 0;
      if (ai.path.length > 1) {
        var n0 = ai.path[0], n1 = ai.path[1], ex = nodeX(n1[0], n1[1]) - nodeX(n0[0], n0[1]), ey = Yp(n1[1]) - Yp(n0[1]);
        if ((c.x - nodeX(n0[0], n0[1])) * ex + (c.y - Yp(n0[1])) * ey > 0) ai.pi = 1;
      }
    }
    if (!pathAI(g, c, dt, top * (H.st === 'cool' ? 0.75 : 1))) drive(c, tx2, ty2, 12, false);
  }

  // ---- races ----
  function raceAI(g, c, dt) {
    var R = g.race.R, rc = c.rc, P = g.player, k = c.ctl;
    if (c.dead) { k.gas = 0; k.brake = 1; return; }
    if (rc.fin >= 0 || g.phase !== 'race') {
      k.gas = 0; k.nos = 0; k.steer = 0;
      k.brake = g.phase === 'count' || c.vf < 1 ? 0 : 0.6; k.hb = g.phase === 'count' || c.vf < 1 ? 1 : 0;
      return;
    }
    var v = Math.max(6, c.vf), look = clamp(6 + v * 0.4, 8, 22), ti = ridx(R, rc.pi + Math.round(look / RSTEP));
    var tx = R.xs[ti], ty = R.ys[ti];
    var rb = 1, D = DIFFS[g.diff];
    if (P.rc) {
      var gap = rc.dist - P.rc.dist;
      rb = gap > 0 ? lerp(1, 0.93, clamp(gap / 220, 0, 1)) : lerp(1, D.rb, clamp(-gap / 220, 0, 1));
    }
    var vt = R.vmax[ridx(R, rc.pi + 3)] * rc.pace * rb;
    vt = Math.min(vt, c.st.top * rb * 1.02);
    // go round slow cars
    var gp = gapAhead(g, c, 22, 1.2);
    if (gp < 22) {
      var ca = Math.cos(c.a), sa = Math.sin(c.a), sh = -3.2;
      tx += -sa * sh; ty += ca * sh;
      if (gp < 6) vt = Math.min(vt, Math.max(4, c.vf - 4));
    }
    drive(c, tx, ty, vt, true);
    k.nos = c.st.nos && c.nosT > 0.2 && R.vmax[ridx(R, rc.pi + 25)] > c.vf + 15 && c.vf > 18 && (rc.nosOK = rc.nosOK || g.rng() < 0.02) ? 1 : 0;
    if (!k.nos) rc.nosOK = false;
    stuck(c, dt);
  }
  function raceProgress(g, c, dt) {
    var R = g.race.R, rc = c.rc, old = rc.pi, cps = g.race.cps;
    rc.pi = routeNear(R, c.x, c.y, rc.pi, 8, 30);
    if (R.loop) { if (rc.pi < old - R.N / 2) rc.lap++; else if (rc.pi > old + R.N / 2) rc.lap--; }
    rc.dist = rc.lap * R.L + R.cum[rc.pi];
    if (rc.fin >= 0 || rc.next >= cps.length) return;
    var cp = cps[rc.next], rad = cp.r;
    if (Math.abs(c.x - cp.x) < rad && Math.abs(c.y - cp.y) < rad && rc.dist > cp.d - 40) {
      rc.next++;
      if (c === g.player) g.ev.push({ t: 'cp', n: rc.next, of: cps.length, lap: cp.lapEnd ? cp.lap : -1 });
      if (rc.next >= cps.length) { rc.fin = g.t; g.race.order.push(c); if (c === g.player) g.ev.push({ t: 'finish', place: g.race.order.length }); }
    }
    // speed traps
    var tr = g.race.traps;
    for (var i = 0; i < tr.length; i++) {
      if (rc.trapped[i]) continue;
      if (Math.abs(c.x - tr[i].x) < 13 && Math.abs(c.y - tr[i].y) < 13) {
        rc.trapped[i] = 1; var kmh = Math.hypot(c.vx, c.vy) * 3.6; rc.trap += kmh;
        if (c === g.player) g.ev.push({ t: 'trap', kmh: kmh, n: i + 1, of: tr.length });
      }
    }
  }
  function placeOf(g, c) {
    var list = g.race.racers.slice().sort(rankCmp(g));
    return list.indexOf(c) + 1;
  }
  function rankCmp(g) {
    return function (a, b) {
      var A = a.rc, B = b.rc;
      if (A.fin >= 0 || B.fin >= 0) { if (A.fin >= 0 && B.fin >= 0) return A.fin - B.fin; return A.fin >= 0 ? -1 : 1; }
      if (A.next !== B.next) return B.next - A.next;
      return B.dist - A.dist;
    };
  }
  function trapTotal(g, c) {
    var n = g.race.traps.length, got = 0;
    for (var i = 0; i < n; i++) if (c.rc.trapped[i]) got++;
    return got ? c.rc.trap + (n - got) * (c.rc.trap / got) * 0.97 : 0;
  }

  // ---- events ----
  var EV_NAMES = { sprint: 'Sprint', circuit: 'Circuit', drift: 'Drift Zone', speedtrap: 'Speed Trap', outrun: 'Outrun', escape: 'Pursuit Escape' };
  var EV_TIPS = {
    sprint: 'A to B through the city. Hit every checkpoint, finish first.',
    circuit: 'Laps of a closed loop. Finish first.',
    drift: 'Rack up drift points on the loop before the clock runs out.',
    speedtrap: 'Race the route; the highest total through the speed cameras wins.',
    outrun: 'One rival. Get 250 m ahead, or lead at the end.',
    escape: 'You start hot. Lose the police before time runs out.'
  };
  var EV_BASE = { sprint: 650, circuit: 750, drift: 600, speedtrap: 650, outrun: 850, escape: 950 };
  var NAMES = ['Nova', 'Blitz', 'Rizzo', 'Lark', 'Vex', 'Ash', 'Dune', 'Kai', 'Mira', 'Zed', 'Pike', 'Rumi', 'Sol', 'Tarn', 'Quill', 'Onyx', 'Juke', 'Wren'];
  var RIVALS = [
    { name: 'Dex Calder', tag: 'Rookie', car: 'sparrow', col: [240, 140, 40], bio: 'Fresh off the bus with a borrowed hatch and a big mouth.', ev: ['sprint', 'drift'], boss: 'sprint' },
    { name: 'Juno Vale', tag: 'Shutter', car: 'kestrel', col: [230, 80, 160], bio: 'Films every slide for her channel. Drifts for the camera, races for the views.', ev: ['drift', 'circuit'], boss: 'circuit' },
    { name: 'Mako Reyes', tag: 'Straightline', car: 'brute', col: [204, 44, 40], bio: 'Never met a corner he liked. Floors it and dares the walls.', ev: ['speedtrap', 'sprint'], boss: 'outrun' },
    { name: 'Tess Okafor', tag: 'Two-Step', car: 'kestrel', col: [60, 200, 170], bio: 'Footwork like a dancer. Never brakes the same way twice.', ev: ['circuit', 'escape', 'sprint'], boss: 'circuit' },
    { name: 'Bram Holloway', tag: 'Bulldozer', car: 'titan', col: [130, 160, 60], bio: 'Drives a tank, races like a tank. Trades paint on purpose.', ev: ['escape', 'speedtrap', 'outrun'], boss: 'sprint' },
    { name: 'Kiko Sato', tag: 'Silk', car: 'mantis', col: [250, 250, 250], bio: 'Smooth to the point of boring. Boring and fast.', ev: ['drift', 'circuit', 'sprint'], boss: 'circuit' },
    { name: 'Viktor Lane', tag: 'Clockwork', car: 'mantis', col: [70, 90, 210], bio: 'Times every light in the city. Knows which ones lie.', ev: ['speedtrap', 'escape', 'circuit', 'sprint'], boss: 'outrun' },
    { name: 'Imani Brooks', tag: 'Ghostline', car: 'vanta', col: [40, 220, 240], bio: 'Shows up in your mirror, then she is gone. Nobody has her plate.', ev: ['sprint', 'drift', 'outrun', 'escape'], boss: 'sprint' },
    { name: 'Rook Delacroix', tag: 'Checkmate', car: 'vanta', col: [200, 30, 60], bio: 'Plays the cops like pieces. Somehow they always box in his opponent.', ev: ['circuit', 'escape', 'speedtrap', 'sprint'], boss: 'circuit' },
    { name: 'Sera Quint', tag: 'Halo', car: 'phantom', col: [255, 214, 90], bio: 'Top of the list since anyone can remember. Has never been caught.', ev: ['sprint', 'outrun', 'circuit', 'escape'], boss: 'sprint' }
  ];
  function evRng(seed) { return mulberry32(hash3(seed | 0, 77, 99)); }
  function startNode(r) {
    for (var t = 0; t < 50; t++) {
      var i = Math.floor((r() - 0.5) * 50), j = Math.floor((r() - 0.5) * 50);
      if (isRiver(j) || isRiver(j - 1) || vline(i).t === 'alley' || hline(j).t === 'alley' || overpass(i, j)) continue;
      return [i, j];
    }
    return [0, 0];
  }
  // an event definition from a type, a seed and a tier (0-9); o: { node:[i,j], boss: rival index }
  function makeEvent(type, seed, tier, o) {
    o = o || {};
    var r = evRng(seed), E = { type: type, seed: seed, tier: tier, name: EV_NAMES[type], nodes: null, loop: false, laps: 0, rivals: [], time: 0, target: 0, heat: 0, boss: o.boss == null ? -1 : o.boss };
    var st = o.node || startNode(r), tries = 0;
    while (type !== 'escape' && !E.nodes && tries++ < 12) {
      var d0 = Math.floor(r() * 4);
      if (type === 'circuit' || type === 'drift') { E.nodes = routeLoop(r, st[0], st[1], 2 + Math.floor(r() * 2.4), 2 + Math.floor(r() * 1.6)); E.loop = true; }
      else E.nodes = routeWalk(r, st[0], st[1], d0, type === 'outrun' ? 24 : type === 'speedtrap' ? 13 + Math.floor(r() * 4) : 10 + Math.floor(tier * 0.5 + r() * 5));
      if (!E.nodes) st = startNode(r);
    }
    if (type === 'circuit') E.laps = tier >= 5 ? 3 : 2;
    if (type === 'drift') { E.time = 70; E.target = Math.round((6000 + tier * 1700) / 500) * 500; }
    if (type === 'escape') { E.heat = clamp(2 + Math.floor(tier / 3), 2, 5); E.time = 110 + E.heat * 25; E.start = st; }
    var nr = type === 'outrun' ? 1 : type === 'drift' || type === 'escape' ? 0 : 3;
    if (E.boss >= 0 && nr) nr = type === 'outrun' ? 1 : type === 'circuit' ? 2 : 1;
    var used = {};
    for (var q = 0; q < nr; q++) {
      var R = null;
      if (E.boss >= 0 && q === 0) { var B = RIVALS[E.boss]; R = { name: B.name, car: B.car, col: B.col, pace: 0.95 + tier * 0.014, upg: Math.min(3, 1 + Math.floor(tier / 3)), boss: true }; }
      else {
        var nm; do { nm = NAMES[Math.floor(r() * NAMES.length)]; } while (used[nm]); used[nm] = 1;
        var ci = clamp(Math.floor(tier * 0.62 + r() * 2 - 0.5), 0, CARS.length - 1);
        R = { name: nm, car: CARS[ci].id, col: TCOLS[Math.floor(r() * TCOLS.length)].map(function (v) { return Math.min(255, v + 30); }), pace: 0.87 + tier * 0.016 + r() * 0.04, upg: Math.min(3, Math.floor(tier / 3)) };
      }
      E.rivals.push(R);
    }
    E.cops = type === 'escape' || tier >= 3;
    E.reward = Math.round(EV_BASE[type] * (1 + tier * 0.38) * (E.boss >= 0 ? 2.5 : 1) / 10) * 10;
    return E;
  }
  // career: each rival needs their events won, then a one-on-one
  function careerEvents(ri) {
    var R = RIVALS[ri], out = [];
    R.ev.forEach(function (t, k) { out.push({ key: ri + ':' + k, type: t, seed: 7000 + ri * 31 + k * 7, tier: ri }); });
    out.push({ key: ri + ':boss', type: R.boss, seed: 9100 + ri * 37, tier: ri, boss: ri });
    return out;
  }
  function dailyKey(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dailyEvent(key) {
    var n = parseInt(key.replace(/-/g, ''), 10) || 1, types = ['sprint', 'circuit', 'drift', 'speedtrap', 'outrun', 'escape'];
    var E = makeEvent(types[hash3(n, 3, 5) % types.length], n, 6);
    E.daily = key;
    E.rain = hash3(n, 4, 4) % 3 === 0; E.night = hash3(n, 6, 6) % 2 === 0;
    return E;
  }
  // free-roam race markers sit on some intersections
  var MK_TYPES = ['sprint', 'circuit', 'drift', 'speedtrap', 'outrun'];
  function markerAt(i, j) {
    if (h01(i, j, 501) > 0.05 || isRiver(j) || isRiver(j - 1) || overpass(i, j) || vline(i).t === 'alley' || hline(j).t === 'alley' || (i === 0 && j === 0)) return null;
    return MK_TYPES[Math.floor(h01(i, j, 502) * MK_TYPES.length)];
  }

  // ---- games ----
  function inTunnel(x, y) {
    var j = rowOf(y + 30) , bj;
    for (bj = j - 1; bj <= j; bj++) {
      var H = hline(bj);
      if (H.t !== 'hwy' || Math.abs(y - H.p) > H.hw) continue;
      var bi = colOf(x);
      if (!tunnel(bi, bj)) continue;
      var x0 = nodeX(bi, bj) + vline(bi).hw + 16, x1 = nodeX(bi + 1, bj) - vline(bi + 1).hw - 16;
      if (x > x0 && x < x1) return true;
    }
    return false;
  }
  function tunnelSpan(bi, bj) { return [nodeX(bi, bj) + vline(bi).hw + 16, nodeX(bi + 1, bj) - vline(bi + 1).hw - 16]; }
  // o: { mode: 'roam'|'event', diff, car: {id, upg, col}, x, y, a, ev, rain, night, assist, traffic, heat, dmg, seed }
  function newGame(o) {
    var spec = CAR_BY[o.car && o.car.id] || CARS[0], st = stats(spec, o.car && o.car.upg);
    var g = {
      mode: o.mode || 'roam', diff: o.diff == null ? 1 : o.diff, t: 0, frame: 0, rng: mulberry32((o.seed >>> 0) || 1), cars: [], props: [], actB: new Map(), gone: new Set(), ev: [],
      heat: newHeat(o.heat || 0), race: null, phase: 'race', countT: 0, assist: o.assist == null ? 1 : o.assist, rain: !!o.rain, night: !!o.night,
      patrols: o.patrols == null ? 2 : o.patrols, noCops: false, trafficN: Math.round((o.traffic == null ? 16 : o.traffic) * DIFFS[o.diff == null ? 1 : o.diff].traffic),
      won: { cash: 0, bounty: 0 }, drift: { on: false, chain: 0, mult: 1, t: 0, gap: 0, total: 0, best: 0 }, stats: { props: 0, hits: 0, cops: 0, top: 0, dist: 0, maxHeat: 0 },
      copRole: 0, dmgK: DIFFS[o.diff == null ? 1 : o.diff].dmg, busted: false, done: false, result: null, godT: 0, mkCool: '', mkT: 0, E: o.ev || null
    };
    var P = newCar(spec, st, 0, 0, 0, 'player', (o.car && o.car.col) || spec.col);
    g.player = P; g.cars.push(P);
    P.dmg = o.dmg || 0;
    if (o.ev) setupEvent(g, o.ev, o);
    else if (o.x != null) { P.x = o.x; P.y = o.y; P.a = o.a || 0; circles(P); }
    else {       // the first avenue or boulevard near the middle of town
      var j0 = 0;
      for (var q = 0; q < 12; q++) { var t = hline(q).t; if ((t === 'ave' || t === 'blvd') && !isRiver(q) && !isRiver(q - 1)) { j0 = q; break; } }
      var L = hline(j0); placeOnLane(P, 0, j0, nodeX(0, j0) + vline(0).hw + 12, 1, L.lanes - 1);
    }
    propsUpdate(g);
    for (var i = 0; i < Math.round(g.trafficN * 0.7); i++) spawnTraffic(g, true);
    if (g.race) g.cars = g.cars.filter(function (c) { return c.kind !== 'traffic' || Math.hypot(c.x - P.x, c.y - P.y) > 75; });
    return g;
  }
  function setupEvent(g, E, o) {
    var P = g.player;
    if (E.rain != null) g.rain = E.rain;
    if (E.night != null) g.night = E.night;
    g.noCops = !E.cops;
    g.patrols = E.cops ? 2 : 0;
    if (E.type === 'escape') {
      var s = E.start, L = hline(s[1]);
      placeOnLane(P, 0, s[1], nodeX(s[0], s[1]) + vline(s[0]).hw + 10, 1, L.lanes - 1);
      g.heat = newHeat(HEAT_AT[E.heat] + 5);
      g.heat.st = 'chase'; g.heat.lastSeen = 0; g.heat.lk.x = P.x; g.heat.lk.y = P.y; g.heat.rbT = 30;
      for (var c2 = 0; c2 < 2; c2++) { var cp = spawnCop(g, 'chase', 45, 80, null); if (cp) cp.sees = true; }
      g.race = { R: null, cps: [], traps: [], racers: [P], order: [] };
      P.rc = { pi: 0, lap: 0, next: 0, fin: -1, trap: 0, trapped: [], dist: 0, pace: 1 };
      g.phase = 'count'; g.countT = 3;
      return;
    }
    var R = denseRoute(E.nodes, E.loop, 13), cps = [], traps = [], k, n = E.nodes.length;
    function cpAt(nk, lap, end) {
      var nd = E.nodes[nk % n], ix = R.ni[nk % n] != null ? R.ni[nk % n] : R.N - 1, hw = Math.max(vline(nd[0]).hw, hline(nd[1]).hw);
      cps.push({ x: nodeX(nd[0], nd[1]), y: Yp(nd[1]), d: (lap + (end ? 1 : 0)) * R.L + (end ? 0 : R.cum[ix]), r: hw + 7, lap: lap, lapEnd: !!end });
    }
    if (E.loop) {
      if (E.type === 'circuit') for (var lp = 0; lp < E.laps; lp++) {
        for (k = 1; k < n; k++) { var a = E.nodes[k - 1], b = E.nodes[k], c = E.nodes[(k + 1) % n]; if ((a[0] === b[0]) !== (b[0] === c[0])) cpAt(k, lp, false); }
        cpAt(0, lp, true);
      }
    } else {
      for (k = 3; k < n - 1; k += 3) cpAt(k, 0, false);
      cpAt(n - 1, 0, false);
      if (E.type === 'speedtrap') {
        var cand = [];
        for (k = 2; k < n - 1; k++) { var p0 = E.nodes[k - 1], p2 = E.nodes[k + 1]; if (p0[0] === p2[0] || p0[1] === p2[1]) cand.push(k); }
        var want = Math.min(5, cand.length);
        for (var q = 0; q < want; q++) { var nk = cand[Math.floor((q + 0.5) * cand.length / want)], nd = E.nodes[nk]; traps.push({ x: nodeX(nd[0], nd[1]), y: Yp(nd[1]) }); }
      }
    }
    g.race = { R: R, cps: cps, traps: traps, racers: [], order: [], E: E };
    // the grid: two columns on the first edge, the player at the back
    var n0 = E.nodes[0], n1 = E.nodes[1], ax = n0[1] === n1[1] ? 0 : 1, line = ax ? n0[0] : n0[1], dir = (ax ? Yp(n1[1]) - Yp(n0[1]) : nodeX(n1[0], n1[1]) - nodeX(n0[0], n0[1])) > 0 ? 1 : -1;
    var X = ax ? hline(n0[1]) : vline(n0[0]), L0 = lineOf(ax, line), s0 = nodeS(ax, line, ax ? n0[1] : n0[0]) + dir * (X.hw + 6);
    var cols = L0.lanes > 1 ? [laneOff(L0, 0), laneOff(L0, 1)] : [-1.8, 1.8], all = E.rivals.length + 1, rows = Math.ceil(all / 2);
    for (var ri = 0; ri < all; ri++) {
      var row = Math.floor(ri / 2), col = ri % 2, sAt = s0 + dir * ((rows - 1 - row) * 8.5 + 4), car;
      if (ri === all - 1) car = P;
      else {
        var RV = E.rivals[ri], spec = CAR_BY[RV.car], up = { eng: RV.upg, tire: RV.upg, nos: RV.upg, arm: 0 }, st = stats(spec, up);
        st.top *= DIFFS[g.diff].rival; st.acc *= DIFFS[g.diff].rival;
        car = newCar(spec, st, 0, 0, 0, 'rival', RV.col);
        car.name = RV.name; car.boss = !!RV.boss; car.ai = mkAI('race');
        g.cars.push(car);
      }
      lanePt(ax, line, sAt, dir, cols[col], _o);
      car.x = _o.x; car.y = _o.y; car.a = Math.atan2(_o.hy, _o.hx); car.vx = car.vy = 0; circles(car);
      car.rc = { pi: routeNear(R, car.x, car.y, null), lap: 0, next: 0, fin: -1, trap: 0, trapped: [], dist: 0, pace: ri === all - 1 ? 1 : E.rivals[ri].pace * DIFFS[g.diff].rival, launch: true };
      g.race.racers.push(car);
    }
    P.nosT = 1;
    g.phase = 'count'; g.countT = 3;
  }
  // after a bust or a wreck in free roam: pursuit over, the car parked at the nearest curb
  function resetPursuit(g, keepPos) {
    g.heat = newHeat(0);
    g.busted = false;
    g.cars = g.cars.filter(function (c) { return c.kind !== 'cop'; });
    var P = g.player;
    P.vx = P.vy = P.w = 0; P.spiked = 0; P.dead = false;
    if (!keepPos) resetCar(g);
    g.godT = 3;
  }
  // put the player back on the nearest lane, pointing along it
  function resetCar(g) {
    var P = g.player, R = nearestRoad(P.x, P.y), s = R.ax ? P.y : P.x, dir = (R.ax ? Math.sin(P.a) : Math.cos(P.a)) >= 0 ? 1 : -1;
    var ni = nodeAt(R.ax ? vx(R.n, s) : s, R.ax ? s : Yp(R.n), 3);
    if (ni) s += dir * 14;
    placeOnLane(P, R.ax, R.n, s, dir, R.L.lanes - 1);
    P.vx = P.vy = P.w = 0;
    g.godT = 2;
  }

  function step(g, inp, dt) {
    if (g.done) return;
    g.frame++;
    var P = g.player, cs = g.cars, H = g.heat, i, c, ev0 = g.ev.length;
    if (g.godT > 0) g.godT -= dt;
    if (g.phase === 'count') {
      var before = Math.ceil(g.countT);
      g.countT -= dt;
      if (Math.ceil(g.countT) < before && g.countT > 0) g.ev.push({ t: 'beep', n: Math.ceil(g.countT) });
      P.ctl.gas = 0; P.ctl.brake = 0; P.ctl.steer = 0; P.ctl.hb = 1; P.ctl.nos = 0;
      if (g.countT <= 0) { g.phase = 'race'; g.ev.push({ t: 'go' }); g.t0 = g.t; }
      g.t += dt * 0.0001;
    } else {
      g.t += dt;
      var k = P.ctl;
      k.steer = clamp(inp.steer || 0, -1, 1); k.gas = inp.gas || 0; k.brake = inp.brake || 0; k.hb = inp.hb ? 1 : 0; k.nos = inp.nos ? 1 : 0;
      if (P.dead) { k.gas = 0; k.nos = 0; }
    }
    // AI at 30 Hz, staggered
    for (i = 0; i < cs.length; i++) {
      c = cs[i];
      if (c === P || !c.ai || ((g.frame + c.id) & 1)) continue;
      if (g.phase === 'count' && c.kind === 'cop') { c.ctl.gas = 0; c.ctl.brake = 1; continue; }
      if (c.kind === 'traffic') {
        if (Math.abs(c.x - P.x) > 260 || Math.abs(c.y - P.y) > 260) continue;
        laneAI(g, c, dt * 2, lineOf(c.ai.ax, c.ai.n).lim * c.ai.spd, true);
      } else if (c.kind === 'cop') copAI(g, c, dt * 2);
      else if (c.kind === 'rival') raceAI(g, c, dt * 2);
    }
    for (i = 0; i < cs.length; i++) { c = cs[i]; carPhys(g, c, dt); levelOf(c); }
    P.tun = inTunnel(P.x, P.y);
    for (i = 0; i < cs.length; i++) {
      c = cs[i];
      if (c !== P && (Math.abs(c.x - P.x) > 300 || Math.abs(c.y - P.y) > 300) && c.kind === 'traffic') continue;
      if (Math.abs(c.vx) + Math.abs(c.vy) + Math.abs(c.w) < 0.02 && c.kind !== 'player' && c.ai && c.ai.st === 'block') continue;
      staticCol(g, c);
    }
    for (i = 0; i < cs.length; i++) for (var q = i + 1; q < cs.length; q++) carCar(g, cs[i], cs[q]);
    for (i = 0; i < cs.length; i++) {
      c = cs[i];
      if (Math.abs(c.x - P.x) > 110 || Math.abs(c.y - P.y) > 110) continue;
      for (var pq = 0; pq < g.props.length; pq++) propCol(g, c, g.props[pq]);
    }
    propsStep(g, dt);
    if (g.frame % 30 === 0) propsUpdate(g);
    // consequences of this step's contacts
    for (i = ev0; i < g.ev.length; i++) {
      var e = g.ev[i];
      if (e.t === 'bump') {
        g.stats.hits++;
        if (e.who === 'traffic' && e.sp > 4) infr(g, 4, 'hit');
        else if (e.who === 'cop' && e.sp > 4) {
          infr(g, 12, 'cop');
          if (H.st === 'none' && !g.noCops) { H.pts = Math.max(H.pts, HEAT_AT[1] + 2); H.lastSeen = g.t; H.seen = true; }
        }
      } else if (e.t === 'prop') { g.stats.props++; infr(g, e.k === 'parked' ? 2 : 0.9, 'prop'); if (H.st !== 'none') H.bounty += 20 * Math.max(1, H.lvl); }
      else if (e.t === 'wreck' && e.who === 'cop') { g.stats.cops++; H.copsDown++; infr(g, 25, 'wreck'); H.bounty += 400 * Math.max(1, H.lvl); }
      else if (e.t === 'hit' && e.sp > 4 && g.drift.on) { g.drift.chain = 0; g.drift.on = false; g.drift.mult = 1; g.drift.t = 0; g.ev.push({ t: 'driftlost' }); }
    }
    if ((g.mode === 'roam' || (g.E && g.E.cops)) && g.phase === 'race') policeStep(g, dt);
    if (g.heat !== H) H = g.heat;
    if (g.busted && g.mode === 'event') { finishEvent(g, false, 'Busted'); return; }
    if (g.busted) return;
    g.stats.maxHeat = Math.max(g.stats.maxHeat, H.lvl);
    // traffic: keep a ring of cars around the player
    if (g.frame % 6 === 0) {
      var nT = 0;
      for (i = cs.length - 1; i >= 0; i--) {
        c = cs[i];
        if (c.kind !== 'traffic') continue;
        var dd = Math.max(Math.abs(c.x - P.x), Math.abs(c.y - P.y));
        if (dd > 230 || (c.dead && dd > 110)) { cs.splice(i, 1); continue; }
        nT++;
      }
      if (nT < g.trafficN) spawnTraffic(g, false);
    }
    // drift scoring
    var D = g.drift, sp = Math.hypot(P.vx, P.vy), beta = Math.abs(Math.atan2(P.vr, Math.max(0.1, Math.abs(P.vf))));
    if (g.phase === 'race' && sp > 9 && beta > 0.21 && beta < 1.6 && P.vf > 4 && !P.dead) {
      if (!D.on) { D.on = true; D.t = 0; D.mult = 1; D.chain = 0; }
      D.gap = 0; D.t += dt;
      D.chain += sp * beta * dt * 9 * D.mult;
      if (D.t > 2 * D.mult && D.mult < 5) D.mult++;
      P.nosT = Math.min(1, P.nosT + dt * 0.07);
    } else if (D.on) {
      D.gap += dt;
      if (D.gap > 0.7) {
        D.on = false;
        var pts = Math.round(D.chain);
        if (pts >= 150) { D.total += pts; D.best = Math.max(D.best, pts); g.ev.push({ t: 'drift', pts: pts, mult: D.mult }); if (g.mode === 'roam') g.won.cash += Math.floor(pts / 300); }
        D.chain = 0; D.mult = 1;
      }
    }
    if (g.phase === 'race') P.nosT = Math.min(1, P.nosT + dt * 0.012);
    g.stats.top = Math.max(g.stats.top, sp);
    g.stats.dist += sp * dt;
    // free roam: race markers and wrecks
    if (g.mode === 'roam') {
      if (g.frame % 15 === 0) {
        var nn = nearNode(P.x, P.y), key = nn[0] + ',' + nn[1], mk = markerAt(nn[0], nn[1]), dm = Math.hypot(nodeX(nn[0], nn[1]) - P.x, Yp(nn[1]) - P.y);
        if (g.mkCool && g.mkCool !== key) g.mkCool = '';
        if (mk && dm < 9 && sp < 16 && H.st === 'none' && g.mkCool !== key) { g.mkCool = key; g.ev.push({ t: 'marker', i: nn[0], j: nn[1], type: mk }); }
      }
      if (P.dead && H.st === 'none' && !g.wrecked) { g.wrecked = true; g.ev.push({ t: 'totaled' }); }
      return;
    }
    // events
    if (!g.race || g.phase !== 'race') return;
    var E = g.race.E || g.E, T = g.t - (g.t0 || 0);
    for (i = 0; i < g.race.racers.length; i++) if (g.race.R) raceProgress(g, g.race.racers[i], dt);
    if (P.dead) { finishEvent(g, false, 'Totaled'); return; }
    if (E.type === 'escape') {
      for (i = ev0; i < g.ev.length; i++) if (g.ev[i].t === 'evaded') { finishEvent(g, true, 'Escaped'); return; }
      if (T > E.time) finishEvent(g, false, 'Out of time');
      return;
    }
    if (E.type === 'drift') {
      if (T > E.time) { var tot = D.total + (D.on ? D.chain : 0); D.total = Math.round(tot); finishEvent(g, tot >= E.target, tot >= E.target ? 'Target beaten' : 'Below target'); }
      return;
    }
    if (E.type === 'outrun') {
      var rv = g.race.racers[0], gp2 = P.rc.dist - rv.rc.dist;
      g.race.gap = gp2;
      if (gp2 > 250) { finishEvent(g, true, 'Outran ' + rv.name); return; }
      if (gp2 < -250 || rv.rc.fin >= 0) { finishEvent(g, false, rv.name + ' got away'); return; }
    }
    if (P.rc.fin >= 0) {
      var place = placeOf(g, P);
      if (E.type === 'speedtrap') {
        var mine = P.rc.trap, better = 0;
        for (i = 0; i < g.race.racers.length; i++) { var o = g.race.racers[i]; if (o !== P && trapTotal(g, o) > mine) better++; }
        place = better + 1;
      }
      finishEvent(g, place === 1, place === 1 ? 'Winner' : 'Finished ' + place + ordSuf(place), place);
      return;
    }
    if (T > (g.race.R.L * Math.max(1, E.laps || 1)) / 9 + 60) finishEvent(g, false, 'Too slow');
  }
  function ordSuf(n) { return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'; }
  function finishEvent(g, win, why, place) {
    if (g.done) return;
    var E = g.race && g.race.E || g.E, T = g.t - (g.t0 || 0);
    g.done = true;
    g.result = { win: !!win, why: why, place: place || (win ? 1 : 0), time: T, score: E.type === 'drift' ? g.drift.total : E.type === 'speedtrap' ? Math.round(g.player.rc ? g.player.rc.trap : 0) : 0, type: E.type };
    g.ev.push({ t: 'done', win: !!win });
  }
  // a record for the daily board: lower is better for times, higher for scores
  function evScore(res) {
    if (res.type === 'drift' || res.type === 'speedtrap') return res.score;
    return res.time;
  }
  function evBetter(type, a, b) { if (b == null) return true; return type === 'drift' || type === 'speedtrap' ? a > b : a < b; }
  function evReward(E, res) {
    if (res.win) return E.reward;
    if (res.place === 2) return Math.round(E.reward * 0.35 / 10) * 10;
    if (res.place === 3) return Math.round(E.reward * 0.15 / 10) * 10;
    return 0;
  }

  // ---- saves ----
  function newSave() {
    return {
      v: 1, cash: 1500, cars: ['sparrow'], car: 'sparrow', upg: {}, paint: {}, career: { beaten: 0, done: {} },
      best: { bounty: 0, heat: 0, chase: 0, drift: 0, cops: 0 }, daily: { d: '', best: null, type: '' }, roam: null, strikes: {}, impound: {},
      stats: { races: 0, wins: 0, busts: 0, escapes: 0, cops: 0 },
      set: { diff: 1, cam: 'rotate', units: 'kmh', assist: 1, touch: 'stick', stickMig: 1, autogas: null, shake: 1, time: 'auto', weather: 'auto' }
    };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (typeof o.cash === 'number' && isFinite(o.cash)) s.cash = Math.max(0, Math.round(o.cash));
    if (Array.isArray(o.cars)) { s.cars = o.cars.filter(function (id) { return CAR_BY[id]; }); if (s.cars.indexOf('sparrow') < 0) s.cars.unshift('sparrow'); }
    if (CAR_BY[o.car] && s.cars.indexOf(o.car) >= 0) s.car = o.car;
    ['upg', 'paint', 'strikes', 'impound'].forEach(function (k) { if (o[k] && typeof o[k] === 'object') for (var id in o[k]) if (CAR_BY[id]) s[k][id] = o[k][id]; });
    for (var id in s.upg) { var u = s.upg[id], v = {}; UPGS.forEach(function (U) { v[U.id] = clamp(Math.round(+u[U.id] || 0), 0, 3); }); s.upg[id] = v; }
    for (var pid in s.paint) s.paint[pid] = clamp(Math.round(+s.paint[pid] || 0), 0, PAINTS.length - 1);
    if (o.career && typeof o.career === 'object') { s.career.beaten = clamp(Math.round(+o.career.beaten || 0), 0, RIVALS.length); if (o.career.done && typeof o.career.done === 'object') s.career.done = o.career.done; }
    if (o.best && typeof o.best === 'object') for (var b in s.best) if (typeof o.best[b] === 'number') s.best[b] = o.best[b];
    if (o.daily && typeof o.daily === 'object') { s.daily.d = String(o.daily.d || ''); s.daily.best = typeof o.daily.best === 'number' ? o.daily.best : null; s.daily.type = String(o.daily.type || ''); }
    if (o.roam && typeof o.roam.x === 'number' && isFinite(o.roam.x) && isFinite(o.roam.y)) s.roam = { x: o.roam.x, y: o.roam.y, a: +o.roam.a || 0, dmg: clamp(+o.roam.dmg || 0, 0, 0.95) };
    if (o.stats && typeof o.stats === 'object') for (var k in s.stats) if (typeof o.stats[k] === 'number') s.stats[k] = o.stats[k];
    if (o.set && typeof o.set === 'object') {
      var S = o.set, T = s.set;
      if (S.diff === 0 || S.diff === 1 || S.diff === 2) T.diff = S.diff;
      if (S.cam === 'rotate' || S.cam === 'north') T.cam = S.cam;
      if (S.units === 'kmh' || S.units === 'mph') T.units = S.units;
      if (S.assist === 0 || S.assist === 1 || S.assist === 2) T.assist = S.assist;
      if (TOUCHES.indexOf(S.touch) >= 0) T.touch = S.touch;
      // the thumb stick became the default: a stored 'buttons' from before was just the old
      // default, so switch it once; after that (stickMig set) a deliberate 'buttons' sticks
      if (S.stickMig !== 1 && T.touch === 'buttons') T.touch = 'stick';
      if (S.autogas === true || S.autogas === false) T.autogas = S.autogas;
      if (S.shake === 0 || S.shake === 1) T.shake = S.shake;
      if (['auto', 'day', 'dusk', 'night'].indexOf(S.time) >= 0) T.time = S.time;
      if (['auto', 'clear', 'rain'].indexOf(S.weather) >= 0) T.weather = S.weather;
    }
    return s;
  }
  function carDesc(save, id) {
    id = id || save.car;
    var spec = CAR_BY[id] || CARS[0], pi = save.paint[spec.id] || 0;
    return { id: spec.id, upg: save.upg[spec.id] || { eng: 0, tire: 0, nos: 0, arm: 0 }, col: PAINTS[pi].col || spec.col };
  }
  function carUnlocked(save, id) { return save.career.beaten >= CAR_BY[id].need; }
  function buyCar(save, id) {
    var c = CAR_BY[id];
    if (!c || save.cars.indexOf(id) >= 0 || !carUnlocked(save, id) || save.cash < c.cost) return false;
    save.cash -= c.cost; save.cars.push(id); save.car = id;
    return true;
  }
  function buyUpg(save, uid) {
    var u = save.upg[save.car] || (save.upg[save.car] = { eng: 0, tire: 0, nos: 0, arm: 0 }), l = u[uid] || 0;
    if (l >= 3) return false;
    var cost = upgCost(save.car, l);
    if (save.cash < cost) return false;
    save.cash -= cost; u[uid] = l + 1;
    return true;
  }
  function buyPaint(save, pi) {
    if (pi < 0 || pi >= PAINTS.length) return false;
    var cur = save.paint[save.car] || 0;
    if (cur === pi) return false;
    if (save.cash < PAINTS[pi].cost) return false;
    save.cash -= PAINTS[pi].cost; save.paint[save.car] = pi;
    return true;
  }
  function releaseCost(id) { return 800 + Math.round(CAR_BY[id].cost * 0.08 / 50) * 50; }
  // a bust: the fine, a strike on the car, impound at three strikes (when you have another car)
  function applyBust(save, fine) {
    var paid = Math.min(save.cash, fine), id = save.car, out = { fine: paid, impound: false, strikes: 0 };
    save.cash -= paid;
    save.strikes[id] = (save.strikes[id] || 0) + 1;
    out.strikes = save.strikes[id];
    save.stats.busts++;
    if (save.strikes[id] >= 3) {
      var others = save.cars.filter(function (c) { return c !== id && !save.impound[c]; });
      save.strikes[id] = 0;
      if (others.length) { save.impound[id] = 1; save.car = others[0]; out.impound = true; out.now = others[0]; }
      else { var extra = Math.min(save.cash, fine); save.cash -= extra; out.fine += extra; }
    }
    return out;
  }
  function release(save, id) {
    if (!save.impound[id]) return false;
    var c = releaseCost(id);
    if (save.cash < c) return false;
    save.cash -= c; delete save.impound[id]; save.strikes[id] = 0;
    return true;
  }
  // career progress after an event
  function careerAward(save, info, res, E) {
    var cash = evReward(E, res), out = { cash: cash, beat: false, first: false };
    save.cash += cash;
    save.stats.races++;
    if (res.win) save.stats.wins++;
    if (res.win && info && info.key) {
      if (!save.career.done[info.key]) out.first = true;
      save.career.done[info.key] = 1;
      if (info.boss != null && info.boss === save.career.beaten) { save.career.beaten++; out.beat = true; }
    }
    return out;
  }
  function careerNext(save) {
    var ri = save.career.beaten;
    if (ri >= RIVALS.length) return null;
    var evs = careerEvents(ri), open = 0;
    evs.forEach(function (e) { e.won = !!save.career.done[e.key]; if (e.boss == null && e.won) open++; });
    var need = evs.length - 1;
    evs[evs.length - 1].locked = open < need;
    return { ri: ri, rival: RIVALS[ri], events: evs, won: open, need: need };
  }
  function kmh(v) { return v * 3.6; }
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  // ---- touch thumb stick: knob offset (-1..1 of the ring radius) -> steering ----
  // A small dead zone, full lock just inside the rim, and an x*|x|^0.5 curve so
  // small thumb moves make small corrections near the center.
  var STICK_DEAD = 0.1, STICK_FULL = 0.9;
  function stickCurve(n) {
    n = +n || 0;
    var a = Math.abs(n);
    if (!(a > STICK_DEAD)) return 0;
    a = Math.min(1, (a - STICK_DEAD) / (STICK_FULL - STICK_DEAD));
    return (n < 0 ? -1 : 1) * a * Math.sqrt(a);
  }
  var TOUCHES = ['stick', 'buttons'];

  var ENGINE = {
    STEP: STEP, STICK_DEAD: STICK_DEAD, STICK_FULL: STICK_FULL, TOUCHES: TOUCHES, stickCurve: stickCurve, GAP: GAP, LW: LW, SW: SW, CH: CH, RT: RT, CARS: CARS, CAR_BY: CAR_BY, TRAFFIC: TRAFFIC, COPS: COPS, UPGS: UPGS, PAINTS: PAINTS, DIFFS: DIFFS,
    HEAT_AT: HEAT_AT, RIVALS: RIVALS, EV_NAMES: EV_NAMES, EV_TIPS: EV_TIPS, PSPEC: PSPEC, MK_TYPES: MK_TYPES, RSTEP: RSTEP,
    mulberry32: mulberry32, hash3: hash3, h01: h01, mod: mod, clamp: clamp, lerp: lerp, angDiff: angDiff,
    vline: vline, hline: hline, lineOf: lineOf, Xp: Xp, Yp: Yp, vx: vx, colOf: colOf, rowOf: rowOf, isRiver: isRiver, bridge: bridge, hasV: hasV, district: district,
    nodeX: nodeX, overpass: overpass, signaled: signaled, light: light, ovpBox: ovpBox, tunnel: tunnel, tunnelSpan: tunnelSpan, inTunnel: inTunnel,
    linePt: linePt, lanePt: lanePt, laneOff: laneOff, nodeS: nodeS, nextNode: nextNode, edgeOK: edgeOK, nearestRoad: nearestRoad, nodeAt: nodeAt, nearNode: nearNode,
    block: block, blockAt: blockAt, blocksIn: blocksIn, los: los, findPath: findPath, routeWalk: routeWalk, routeLoop: routeLoop, denseRoute: denseRoute, routeNear: routeNear, ridx: ridx,
    stats: stats, newCar: newCar, carPhys: carPhys, staticCol: staticCol, carCar: carCar, heatLvl: heatLvl, newHeat: newHeat,
    makeEvent: makeEvent, careerEvents: careerEvents, careerNext: careerNext, careerAward: careerAward, dailyKey: dailyKey, dailyEvent: dailyEvent, markerAt: markerAt,
    newGame: newGame, step: step, raceAI: raceAI, mkAI: mkAI, laneAI: laneAI, snapLane: snapLane, resetPursuit: resetPursuit, resetCar: resetCar, placeOf: placeOf, rankCmp: rankCmp, trapTotal: trapTotal, evScore: evScore, evBetter: evBetter, evReward: evReward,
    newSave: newSave, normSave: normSave, carDesc: carDesc, carUnlocked: carUnlocked, buyCar: buyCar, buyUpg: buyUpg, buyPaint: buyPaint, upgCost: upgCost,
    applyBust: applyBust, release: release, releaseCost: releaseCost, kmh: kmh, fmtTime: fmtTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('streetheat.css');

  var PANEL_ID = 'streetheat-panel', NAME = 'Street Heat';
  var KEY = 'cade-streetheat-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.streetheat = { live: function () { return S; }, E: ENGINE };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }

  // ---- colors ----
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
    var sf = parseCol(v('--surface'), bg), dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    S.th = {
      dark: dark, bg: bg, text: tx, acc: ac, surface: sf, muted: parseCol(v('--text-muted'), mix(bg, tx, 0.6)),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, Menlo, Consolas, monospace',
      hudBg: rgb(sf, 0.84), hudTx: rgb(tx), hudMu: rgb(parseCol(v('--text-muted'), mix(bg, tx, 0.6))), hudAc: rgb(ac), hudBd: rgb(mix(bg, tx, 0.2)), hudBg2: rgb(mix(sf, tx, 0.1), 0.9)
    };
    // the city's own palette, a touch dimmer under the dark theme
    var k = dark ? 0.84 : 1;
    function P(c) { return rgb(shade(c, k)); }
    S.pal = {
      walk: P([186, 182, 174]), curb: P([156, 152, 146]), road: P([72, 74, 80]), hwy: P([80, 82, 88]), alley: P([98, 94, 88]), grass: P([106, 150, 82]), park: P([92, 142, 74]),
      yard: P([118, 158, 90]), lot: P([128, 128, 124]), plaza: P([204, 196, 180]), water: P([52, 108, 152]), water2: P([72, 128, 170]), white: P([238, 238, 232]), yellow: P([232, 190, 60]),
      median: P([98, 134, 74]), concrete: P([176, 174, 166]), path: P([206, 194, 160]), rail: P([210, 210, 204]), dock: P([150, 132, 104]), shadow: 'rgba(10,14,24,0.26)', k: k
    };
    S.chunks.forEach(function (ch) { ch.dirty = true; });
    S.spr = {};
  }

  // ---- sound ----
  function Snd(on) { this.on = !!on; this.ac = null; this.eng = null; this.noise = null; this.siren = null; }
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
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.hiss = function (dur, vol, freq, q, delay) {
    if (!this.ok() || !this.noise) return;
    var ac = this.ac;
    try {
      var t = ac.currentTime + (delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = freq || 800; f.Q.value = q || 0.8;
      g.gain.setValueAtTime(vol || 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(ac.destination); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    } catch (e) {}
  };
  Snd.prototype.engineOn = function () {
    if (!this.ok() || this.eng) return;
    var ac = this.ac;
    try {
      var o1 = ac.createOscillator(), o2 = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
      o1.type = 'sawtooth'; o2.type = 'square'; f.type = 'lowpass'; f.frequency.value = 500; f.Q.value = 2.5; g.gain.value = 0.0001;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(ac.destination);
      o1.frequency.value = 50; o2.frequency.value = 25; o1.start(); o2.start();
      var sk = null, sg = null, sf = null;
      if (this.noise) {
        sk = ac.createBufferSource(); sk.buffer = this.noise; sk.loop = true;
        sf = ac.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1700; sf.Q.value = 1.3;
        sg = ac.createGain(); sg.gain.value = 0.0001;
        sk.connect(sf); sf.connect(sg); sg.connect(ac.destination); sk.start();
      }
      // the siren: a two-tone square through a band filter, gain follows the nearest cop
      var so = ac.createOscillator(), sfl = ac.createBiquadFilter(), sgn2 = ac.createGain();
      so.type = 'square'; so.frequency.value = 700; sfl.type = 'bandpass'; sfl.frequency.value = 1100; sfl.Q.value = 1.4; sgn2.gain.value = 0.0001;
      so.connect(sfl); sfl.connect(sgn2); sgn2.connect(ac.destination); so.start();
      this.eng = { o1: o1, o2: o2, f: f, g: g, sk: sk, sg: sg, sf: sf, so: so, sgn: sgn2 };
    } catch (e) { this.eng = null; }
  };
  Snd.prototype.engineSet = function (rpm, load, nos, skid, siren, t) {
    var e = this.eng;
    if (!e || !this.ok()) return;
    try {
      var at = this.ac.currentTime, fq = 42 + rpm * 160 + (nos ? 30 : 0);
      e.o1.frequency.setTargetAtTime(fq, at, 0.04); e.o2.frequency.setTargetAtTime(fq * 0.5, at, 0.04);
      e.f.frequency.setTargetAtTime(340 + rpm * 1000 + load * 500, at, 0.08);
      e.g.gain.setTargetAtTime(0.016 + load * 0.016 + (nos ? 0.01 : 0), at, 0.08);
      if (e.sg) e.sg.gain.setTargetAtTime(Math.min(0.08, skid * 0.07), at, 0.05);
      e.so.frequency.setTargetAtTime((Math.floor(t * 1.6) % 2 ? 640 : 860), at, 0.02);
      e.sgn.gain.setTargetAtTime(siren * 0.03, at, 0.1);
    } catch (x) {}
  };
  Snd.prototype.engineOff = function () {
    var e = this.eng;
    this.eng = null;
    if (!e) return;
    try { e.o1.stop(); e.o2.stop(); e.so.stop(); if (e.sk) e.sk.stop(); } catch (x) {}
    try { e.g.disconnect(); e.sgn.disconnect(); if (e.sg) e.sg.disconnect(); } catch (x) {}
  };
  Snd.prototype.close = function () { this.engineOff(); if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  // ---- the ground: one offscreen canvas per 128 m chunk ----
  var _blk = [];
  function chunkRes() { return S.cres; }
  function getChunk(cx, cy, force) {
    var key = cx * 65536 + cy, ch = S.chunks.get(key);
    if (ch && !ch.dirty) { ch.used = S.frameN; return ch; }
    if (!force && S.genLeft <= 0) return ch || null;
    S.genLeft--;
    if (!ch) {
      if (S.chunks.size >= S.chunkMax) {         // recycle the least recently used canvas
        var oldK = null, oldU = 1e18;
        S.chunks.forEach(function (c, k) { if (c.used < oldU) { oldU = c.used; oldK = k; } });
        ch = S.chunks.get(oldK); S.chunks.delete(oldK);
      } else ch = { cv: document.createElement('canvas') };
      S.chunks.set(key, ch);
    }
    var R = chunkRes(), px = Math.round(CH * R);
    if (ch.cv.width !== px) { ch.cv.width = px; ch.cv.height = px; }
    ch.cx = cx; ch.cy = cy; ch.R = R; ch.used = S.frameN; ch.dirty = false;
    drawChunk(ch.cv.getContext('2d'), cx, cy, R);
    return ch;
  }
  function polyLine(c, ax, n, s0, s1, off, step) {
    var o = {}, m = Math.max(1, Math.ceil(Math.abs(s1 - s0) / (step || 4))), L = lineOf(ax, n);
    if (!ax || !L.A) {
      linePt(ax, n, s0, o); c.moveTo(o.x - o.ty * off, o.y + o.tx * off);
      linePt(ax, n, s1, o); c.lineTo(o.x - o.ty * off, o.y + o.tx * off);
      return;
    }
    for (var q = 0; q <= m; q++) { linePt(ax, n, lerp(s0, s1, q / m), o); c[q ? 'lineTo' : 'moveTo'](o.x - o.ty * off, o.y + o.tx * off); }
  }
  // the runs of a line that exist inside [lo,hi] (vertical lines stop at the river)
  function runs(ax, n, lo, hi) {
    if (!ax) return [[lo, hi]];
    var out = [], j = rowOf(lo), cur = null;
    for (; Yp(j) < hi; j++) {
      if (!hasV(n, j)) { cur = null; continue; }
      var a = Math.max(lo, Yp(j)), b = Math.min(hi, Yp(j + 1));
      if (cur && Math.abs(cur[1] - a) < 0.01) cur[1] = b; else { cur = [a, b]; out.push(cur); }
    }
    return out;
  }
  function drawChunk(c, cx, cy, R) {
    var P = S.pal, x0 = cx * CH, y0 = cy * CH, x1 = x0 + CH, y1 = y0 + CH, pad = 34, i, j, k, q;
    c.setTransform(R, 0, 0, R, -x0 * R, -y0 * R);
    c.fillStyle = P.walk; c.fillRect(x0, y0, CH, CH);
    var bl = blocksIn(x0 - 4, y0 - 4, x1 + 4, y1 + 4, _blk).slice();
    // lots, water, footprints
    for (k = 0; k < bl.length; k++) {
      var b = bl[k];
      if (b.kind === 'water') {
        b.water.forEach(function (w) {
          c.fillStyle = P.water; c.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
          c.strokeStyle = P.water2; c.lineWidth = 0.35; c.beginPath();
          for (var yy = w.y0 + 6; yy < w.y1 - 3; yy += 7) for (var xx = w.x0 + ((yy * 7) % 11); xx < w.x1 - 4; xx += 13) { c.moveTo(xx, yy); c.lineTo(xx + 3.5, yy); }
          c.stroke();
        });
        c.strokeStyle = P.rail; c.lineWidth = 0.4; c.beginPath();
        b.rails.forEach(function (r2) { c.moveTo(r2[0], r2[1]); c.lineTo(r2[2], r2[3]); });
        c.stroke();
        continue;
      }
      if (b.kind === 'ind' && (isRiver(b.bj - 1) || isRiver(b.bj + 1))) { c.fillStyle = P.dock; c.fillRect(b.ix0 - 1, b.iy0 - 1, b.ix1 - b.ix0 + 2, b.iy1 - b.iy0 + 2); }
      b.lots.forEach(function (lt) {
        var w = lt.x1 - lt.x0, h = lt.y1 - lt.y0;
        c.fillStyle = lt.t === 'park' ? P.park : lt.t === 'yard' ? P.yard : lt.t === 'grass' ? P.grass : lt.t === 'plaza' ? P.plaza : P.lot;
        c.fillRect(lt.x0, lt.y0, w, h);
        if (lt.t === 'park') {
          c.strokeStyle = P.path; c.lineWidth = 2.2; c.beginPath();
          c.moveTo(lt.x0, (lt.y0 + lt.y1) / 2); c.lineTo(lt.x1, (lt.y0 + lt.y1) / 2); c.moveTo((lt.x0 + lt.x1) / 2, lt.y0); c.lineTo((lt.x0 + lt.x1) / 2, lt.y1);
          c.stroke();
          c.beginPath(); c.arc((lt.x0 + lt.x1) / 2, (lt.y0 + lt.y1) / 2, Math.min(w, h) * 0.12, 0, TAU); c.stroke();
        } else if (lt.t === 'park-lot') {
          c.strokeStyle = P.white; c.lineWidth = 0.15; c.beginPath();
          for (var py = lt.y0 + 4; py < lt.y1 - 3; py += 8) for (var px = lt.x0 + 1.1; px < lt.x1 - 1; px += 2.8) { c.moveTo(px, py - 2.6); c.lineTo(px, py + 2.6 + 3.5); }
          c.stroke();
        } else if (lt.t === 'plaza') {
          c.strokeStyle = rgb([255, 255, 255], 0.18); c.lineWidth = 0.12; c.beginPath();
          for (var gx = lt.x0; gx < lt.x1; gx += 2.5) { c.moveTo(gx, lt.y0); c.lineTo(gx, lt.y1); }
          for (var gy = lt.y0; gy < lt.y1; gy += 2.5) { c.moveTo(lt.x0, gy); c.lineTo(lt.x1, gy); }
          c.stroke();
        }
      });
      b.water.forEach(function (w) { c.fillStyle = P.water; c.beginPath(); c.ellipse((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, (w.x1 - w.x0) / 2 + 1, (w.y1 - w.y0) / 2 + 1, 0, 0, TAU); c.fill(); });
    }
    // roads: sidewalks under everything, then asphalt, then the markings
    var vi0 = colOf(x0 - pad) - 1, vi1 = colOf(x1 + pad) + 1, hj0 = rowOf(y0 - pad) - 1, hj1 = rowOf(y1 + pad) + 1;
    var lines = [];
    for (i = vi0; i <= vi1; i++) { var V = vline(i); if (V.p - V.A - V.hw - SW < x1 + 2 && V.p + V.A + V.hw + SW > x0 - 2) lines.push([1, i, V]); }
    for (j = hj0; j <= hj1; j++) { var H = hline(j); if (H.p - H.hw - SW < y1 + 2 && H.p + H.hw + SW > y0 - 2) lines.push([0, j, H]); }
    c.lineCap = 'butt';
    var pass;
    for (pass = 0; pass < 3; pass++) for (q = 0; q < lines.length; q++) {
      var ln = lines[q], ax = ln[0], n = ln[1], L = ln[2], lo = ax ? y0 - pad : x0 - pad, hi = ax ? y1 + pad : x1 + pad;
      if (pass < 2 && L.t === 'hwy') continue;
      var rr = runs(ax, n, lo, hi);
      c.strokeStyle = pass === 0 ? P.walk : pass === 1 ? P.curb : L.t === 'hwy' ? P.hwy : L.t === 'alley' ? P.alley : P.road;
      c.lineWidth = pass === 0 ? (L.hw + SW) * 2 : pass === 1 ? L.hw * 2 + 0.7 : L.hw * 2;
      c.beginPath();
      rr.forEach(function (r2) { polyLine(c, ax, n, r2[0], r2[1], 0, 3); });
      c.stroke();
    }
    // ramps at highway interchanges
    c.fillStyle = P.hwy;
    for (i = vi0; i <= vi1; i++) for (j = hj0; j <= hj1; j++) {
      var Vv = vline(i), Hh = hline(j);
      if ((Vv.t === 'hwy') === (Hh.t === 'hwy') || overpass(i, j)) continue;
      var nx = nodeX(i, j), ny = Yp(j);
      for (var sx = -1; sx <= 1; sx += 2) for (var sy = -1; sy <= 1; sy += 2) {
        c.beginPath();
        if (Hh.t === 'hwy') { c.moveTo(nx + sx * Vv.hw, ny + sy * Hh.hw); c.lineTo(nx + sx * (Vv.hw + RAMP), ny + sy * Hh.hw); c.lineTo(nx + sx * Vv.hw, ny + sy * (Hh.hw + 2.9)); }
        else { c.moveTo(nx + sx * Vv.hw, ny + sy * Hh.hw); c.lineTo(nx + sx * Vv.hw, ny + sy * (Hh.hw + RAMP)); c.lineTo(nx + sx * (Vv.hw + 2.9), ny + sy * Hh.hw); }
        c.fill();
      }
    }
    // markings, trimmed off the intersections
    for (q = 0; q < lines.length; q++) markLine(c, lines[q][0], lines[q][1], lines[q][2], x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    for (i = vi0; i <= vi1; i++) for (j = hj0; j <= hj1; j++) crossings(c, i, j);
    // barriers, bridge rails
    for (k = 0; k < bl.length; k++) {
      var segs = bl[k].segs;
      if (!segs.length) continue;
      c.strokeStyle = P.concrete; c.lineWidth = 0.7; c.lineCap = 'round'; c.beginPath();
      segs.forEach(function (s) { c.moveTo(s.x0, s.y0); c.lineTo(s.x1, s.y1); });
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 0.2; c.stroke();
      c.lineCap = 'butt';
    }
    for (i = vi0; i <= vi1; i++) {
      if (!bridge(i)) continue;
      var Vb = vline(i);
      for (j = hj0; j <= hj1; j++) if (isRiver(j)) {
        var ya = Yp(j) + hline(j).hw + SW, yb = Yp(j + 1) - hline(j + 1).hw - SW;
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(Vb.p + Vb.hw + 0.4, ya, 1.6, yb - ya);
        c.strokeStyle = P.rail; c.lineWidth = 0.6; c.beginPath();
        c.moveTo(Vb.p - Vb.hw - 0.4, ya); c.lineTo(Vb.p - Vb.hw - 0.4, yb); c.moveTo(Vb.p + Vb.hw + 0.4, ya); c.lineTo(Vb.p + Vb.hw + 0.4, yb); c.stroke();
      }
    }
    // shadows of buildings and trees (the sun sits to the north-west)
    c.fillStyle = P.shadow;
    for (k = 0; k < bl.length; k++) {
      bl[k].blds.forEach(function (bd) {
        var sh = Math.min(bd.h * 0.32, 24), ox = sh, oy = sh * 0.75;
        c.beginPath(); c.moveTo(bd.x0, bd.y0); c.lineTo(bd.x1, bd.y0); c.lineTo(bd.x1 + ox, bd.y0 + oy); c.lineTo(bd.x1 + ox, bd.y1 + oy); c.lineTo(bd.x0 + ox, bd.y1 + oy); c.lineTo(bd.x0, bd.y1); c.closePath(); c.fill();
      });
      bl[k].trees.forEach(function (t) { c.beginPath(); c.arc(t.x + 2.2, t.y + 1.7, t.r, 0, TAU); c.fill(); });
    }
    // overpass shadows and manholes
    for (i = vi0; i <= vi1; i++) for (j = hj0; j <= hj1; j++) {
      if (!overpass(i, j)) continue;
      var ob = ovpBox(i, j);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(ob.x - ob.hx + 2.5, ob.y - ob.hy + 2, ob.hx * 2, ob.hy * 2);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  function markLine(c, ax, n, L, x0, y0, x1, y1) {
    var P = S.pal, lo = ax ? y0 : x0, hi = ax ? y1 : x1, rr = runs(ax, n, lo, hi), out = [];
    // cut the runs at each intersection box (except where this line passes over/under)
    rr.forEach(function (r2) {
      var k = ax ? rowOf(r2[0]) : colOf(r2[0]) - 1, s = r2[0];
      for (var guard = 0; guard < 40; guard++, k++) {
        var ns = nodeS(ax, n, k);
        if (ns > r2[1] + 30) break;
        var ij = nodeIJ(ax, n, k), X = lineOf(1 - ax, ax ? ij[1] : ij[0]), cut = X.hw + (signaled(ij[0], ij[1]) ? 5 : 1.5);
        if (overpass(ij[0], ij[1])) continue;
        if (ns - cut > s) out.push([s, Math.min(r2[1], ns - cut)]);
        s = Math.max(s, ns + cut);
      }
      if (s < r2[1]) out.push([s, r2[1]]);
    });
    if (!out.length) return;
    function lines(off, col, w, dash) {
      c.strokeStyle = col; c.lineWidth = w; c.setLineDash(dash || []); c.beginPath();
      out.forEach(function (r2) { if (r2[1] - r2[0] > 0.5) { polyLine(c, ax, n, r2[0], r2[1], off, 4); if (off) polyLine(c, ax, n, r2[0], r2[1], -off, 4); } });
      c.stroke();
    }
    var k;
    if (L.t === 'hwy') {
      lines(L.med - 0.2, P.yellow, 0.16);
      for (k = 1; k < L.lanes; k++) lines(L.med + k * L.lw, P.white, 0.14, [3, 7]);
      lines(L.med + L.lanes * L.lw + 0.1, P.white, 0.16);
    } else if (L.t === 'blvd') {
      c.strokeStyle = P.median; c.lineWidth = L.med * 2 - 0.7; c.setLineDash([]); c.beginPath();
      out.forEach(function (r2) { polyLine(c, ax, n, r2[0], r2[1], 0, 4); }); c.stroke();
      lines(L.med - 0.2, P.concrete, 0.3);
      lines(L.med + L.lw, P.white, 0.14, [3, 6]);
    } else if (L.t === 'ave') {
      lines(0.14, P.yellow, 0.12);
      lines(L.med + L.lw, P.white, 0.14, [3, 6]);
    } else if (L.t === 'st') {
      lines(0, P.yellow, 0.14, [2.5, 4]);
      lines(L.med + L.lw + 0.05, rgb([255, 255, 255], 0.4), 0.1, [0.6, 5.8]);
    }
    c.setLineDash([]);
  }
  function crossings(c, i, j) {
    var P = S.pal, V = vline(i), H = hline(j), x = nodeX(i, j), y = Yp(j), k, s;
    if (overpass(i, j)) return;
    c.fillStyle = (V.t === 'hwy' || H.t === 'hwy') ? P.hwy : P.road;
    c.fillRect(x - V.hw, y - H.hw, V.hw * 2, H.hw * 2);
    if (!signaled(i, j)) return;
    c.fillStyle = P.white;
    // zebra stripes across each approach, a stop line on the right-hand half
    for (s = -1; s <= 1; s += 2) {
      if (H.t !== 'hwy') {
        var bx = x + s * (V.hw + 0.8);
        for (k = -H.hw + 0.6; k < H.hw - 0.5; k += 1.1) c.fillRect(Math.min(bx, bx + s * 2.6), y + k, 2.6, 0.55);
        c.fillRect(x + s * (V.hw + 4.3) - 0.22, s > 0 ? y - H.hw + 0.3 : y + 0.2, 0.45, H.hw - 0.5);
      }
      if (V.t !== 'hwy' && hasV(i, s > 0 ? j : j - 1)) {
        var by = y + s * (H.hw + 0.8);
        for (k = -V.hw + 0.6; k < V.hw - 0.5; k += 1.1) c.fillRect(x + k, Math.min(by, by + s * 2.6), 0.55, 2.6);
        c.fillRect(s > 0 ? x + 0.2 : x - V.hw + 0.3, y + s * (H.hw + 4.3) - 0.22, V.hw - 0.5, 0.45);
      }
    }
  }
  // skid marks are stamped into the ground canvases, so they stay while the chunk does
  function stamp(x0, y0, x1, y1, w, col) {
    var cx0 = Math.floor(Math.min(x0, x1) / CH), cx1 = Math.floor(Math.max(x0, x1) / CH), cy0 = Math.floor(Math.min(y0, y1) / CH), cy1 = Math.floor(Math.max(y0, y1) / CH);
    for (var cx = cx0; cx <= cx1; cx++) for (var cy = cy0; cy <= cy1; cy++) {
      var ch = S.chunks.get(cx * 65536 + cy);
      if (!ch || ch.dirty) continue;
      var c = ch.cv.getContext('2d'), R = ch.R;
      c.setTransform(R, 0, 0, R, -cx * CH * R, -cy * CH * R);
      c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      c.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  // ---- car sprites (drawn once per shape + color + scale) ----
  var SHAPES = {
    hatch: { nose: 0.92, c0: 0.22, c1: 0.78, cw: 0.84 }, tuner: { nose: 0.88, c0: 0.3, c1: 0.7, cw: 0.8, wing: 1 }, muscle: { nose: 0.95, c0: 0.24, c1: 0.6, cw: 0.8, stripe: 1 },
    suv: { nose: 0.97, c0: 0.14, c1: 0.82, cw: 0.88, rack: 1 }, coupe: { nose: 0.84, c0: 0.3, c1: 0.62, cw: 0.78 }, super: { nose: 0.74, c0: 0.36, c1: 0.62, cw: 0.66, wing: 1, intake: 1 },
    hyper: { nose: 0.7, c0: 0.4, c1: 0.66, cw: 0.5, wing: 1, intake: 1 }, sedan: { nose: 0.94, c0: 0.26, c1: 0.72, cw: 0.84 }, taxi: { nose: 0.94, c0: 0.26, c1: 0.72, cw: 0.84, sign: 1 },
    van: { nose: 0.96, c0: 0.06, c1: 0.86, cw: 0.92, van: 1 }, truck: { nose: 0.97, c0: 0.72, c1: 0.95, cw: 0.92, box: 1 }, bus: { nose: 0.98, c0: 0.03, c1: 0.97, cw: 0.94, bus: 1 },
    cruiser: { nose: 0.93, c0: 0.25, c1: 0.7, cw: 0.84, cop: 1 }, interceptor: { nose: 0.86, c0: 0.3, c1: 0.66, cw: 0.8, cop: 1 }, copsuv: { nose: 0.97, c0: 0.14, c1: 0.82, cw: 0.88, cop: 1 }
  };
  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function bodyPath(c, L, W, nose) {
    var hl = L / 2, hw = W / 2, nw = hw * nose, r = Math.min(0.5, W * 0.22);
    c.beginPath();
    c.moveTo(-hl + r, -hw); c.lineTo(hl * 0.55, -hw); c.quadraticCurveTo(hl, -hw * 0.98, hl, -nw + r * 0.5); c.lineTo(hl, nw - r * 0.5);
    c.quadraticCurveTo(hl, hw * 0.98, hl * 0.55, hw); c.lineTo(-hl + r, hw); c.quadraticCurveTo(-hl, hw, -hl, hw - r); c.lineTo(-hl, -hw + r); c.quadraticCurveTo(-hl, -hw, -hl + r, -hw);
    c.closePath();
  }
  function carSprite(shape, col, L, W) {
    var K = S.sprK, key = shape + '|' + col.join(',') + '|' + K + '|' + L;
    var sp = S.spr[key];
    if (sp) return sp;
    var sh = SHAPES[shape] || SHAPES.sedan, cw = Math.ceil((L + 0.6) * K), chh = Math.ceil((W + 0.8) * K), cv = document.createElement('canvas');
    cv.width = cw; cv.height = chh;
    var c = cv.getContext('2d');
    c.setTransform(K, 0, 0, K, cw / 2, chh / 2);
    var body = rgb(col), dark = rgb(shade(col, 0.62)), lite = rgb(shade(col, 1.22)), glass = 'rgb(28,36,48)', hl = L / 2, hw = W / 2;
    // mirrors
    c.fillStyle = dark;
    var mx = -hl + sh.c1 * L - 0.25;
    if (!sh.bus && !sh.box) { c.fillRect(mx, -hw - 0.16, 0.22, 0.2); c.fillRect(mx, hw - 0.04, 0.22, 0.2); }
    bodyPath(c, L, W, sh.nose);
    c.fillStyle = body; c.fill();
    c.lineWidth = 0.09; c.strokeStyle = 'rgba(0,0,0,0.45)'; c.stroke();
    if (sh.box) {      // a box truck: cab in the body color, a pale box behind it
      c.fillStyle = 'rgb(222,222,216)'; rrect(c, -hl + 0.05, -hw + 0.05, L * 0.7, W - 0.1, 0.15); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 0.06; c.beginPath();
      for (var bx = -hl + 0.6; bx < -hl + L * 0.7; bx += 0.6) { c.moveTo(bx, -hw + 0.1); c.lineTo(bx, hw - 0.1); }
      c.stroke();
    }
    // a soft highlight down the spine
    var gr = c.createLinearGradient(0, -hw, 0, hw);
    gr.addColorStop(0, 'rgba(0,0,0,0.18)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.12)'); gr.addColorStop(0.65, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
    bodyPath(c, L, W, sh.nose); c.fillStyle = gr; c.fill();
    var x0 = -hl + sh.c0 * L, x1 = -hl + sh.c1 * L, cwid = W * sh.cw;
    if (sh.bus) {
      c.fillStyle = glass; c.fillRect(x1 - 0.5, -cwid / 2, 0.4, cwid);
      c.fillStyle = lite; rrect(c, x0 + 0.2, -cwid / 2 + 0.15, x1 - x0 - 0.9, cwid - 0.3, 0.2); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(-hl + 2, -0.5, 1.4, 1); c.fillRect(-hl + 5, -0.5, 1.4, 1);
    } else {
      c.fillStyle = glass; rrect(c, x0, -cwid / 2, x1 - x0, cwid, 0.35); c.fill();
      var roofIn = sh.van ? 0.08 : 0.3;
      c.fillStyle = sh.cop ? 'rgb(236,236,236)' : sh.van ? lite : rgb(shade(col, 1.08));
      rrect(c, x0 + roofIn, -cwid / 2 + 0.1, Math.max(0.3, x1 - x0 - roofIn - 0.55), cwid - 0.2, 0.25); c.fill();
    }
    if (sh.stripe) { c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(-hl + 0.1, -0.32, L - 0.2, 0.18); c.fillRect(-hl + 0.1, 0.14, L - 0.2, 0.18); }
    if (sh.rack) { c.strokeStyle = 'rgba(30,30,30,0.6)'; c.lineWidth = 0.07; c.beginPath(); c.moveTo(x0 + 0.5, -cwid / 2 + 0.25); c.lineTo(x1 - 0.8, -cwid / 2 + 0.25); c.moveTo(x0 + 0.5, cwid / 2 - 0.25); c.lineTo(x1 - 0.8, cwid / 2 - 0.25); c.stroke(); }
    if (sh.wing) { c.fillStyle = dark; c.fillRect(-hl + 0.05, -hw * 0.96, 0.32, W * 0.96); }
    if (sh.intake) { c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(-0.3, -hw + 0.05, 0.9, 0.16); c.fillRect(-0.3, hw - 0.21, 0.9, 0.16); }
    if (sh.sign) { c.fillStyle = 'rgb(250,230,120)'; c.fillRect(-0.1, -0.35, 0.4, 0.7); c.fillStyle = '#222'; c.fillRect(0, -0.35, 0.1, 0.7); }
    if (sh.cop) { c.fillStyle = 'rgb(236,236,236)'; c.fillRect(-hl + 0.1, -hw + 0.04, L * 0.3, 0.12); c.fillRect(-hl + 0.1, hw - 0.16, L * 0.3, 0.12); }
    // lights
    c.fillStyle = 'rgb(255,248,214)'; c.fillRect(hl - 0.18, -hw * sh.nose + 0.12, 0.14, 0.36); c.fillRect(hl - 0.18, hw * sh.nose - 0.48, 0.14, 0.36);
    c.fillStyle = 'rgb(150,20,24)'; c.fillRect(-hl + 0.02, -hw + 0.12, 0.12, 0.42); c.fillRect(-hl + 0.02, hw - 0.54, 0.12, 0.42);
    sp = { cv: cv, w: cw / K, h: chh / K };
    S.spr[key] = sp;
    return sp;
  }
  // glow blobs for the light pass
  function blob(col) {
    var key = 'blob' + col, b = S.spr[key];
    if (b) return b;
    var cv = document.createElement('canvas'), n = 64, c;
    cv.width = cv.height = n; c = cv.getContext('2d');
    var gr = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(' + col + ',1)'); gr.addColorStop(0.35, 'rgba(' + col + ',0.45)'); gr.addColorStop(1, 'rgba(' + col + ',0)');
    c.fillStyle = gr; c.fillRect(0, 0, n, n);
    S.spr[key] = cv;
    return cv;
  }
  function cone() {
    var b = S.spr.cone;
    if (b) return b;
    var cv = document.createElement('canvas'), w = 128, h = 64, c;
    cv.width = w; cv.height = h; c = cv.getContext('2d');
    var gr = c.createRadialGradient(0, h / 2, 2, 0, h / 2, w);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gr; c.beginPath(); c.moveTo(0, h / 2 - 4); c.lineTo(w, 0); c.lineTo(w, h); c.lineTo(0, h / 2 + 4); c.closePath(); c.fill();
    S.spr.cone = cv;
    return cv;
  }

  // ---- particles (pooled) ----
  function makeFx() {
    S.fx = [];
    for (var i = 0; i < S.fxMax; i++) S.fx.push({ on: false, k: 0, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, s: 1, a: 0, w: 0, c: '' });
    S.fxI = 0;
  }
  function fx(k, x, y, vx, vy, life, s, c) {
    if (S.rm && k !== 0) return;
    var p = S.fx[S.fxI];
    S.fxI = (S.fxI + 1) % S.fx.length;
    p.on = true; p.k = k; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.s = s; p.c = c || ''; p.a = Math.random() * TAU; p.w = (Math.random() - 0.5) * 12;
  }
  function burst(k, x, y, n, sp, life, s, c) {
    for (var i = 0; i < n; i++) { var a = Math.random() * TAU, v = sp * (0.3 + Math.random() * 0.7); fx(k, x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.6), s, c); }
  }
  function stepFx(dt) {
    for (var i = 0; i < S.fx.length; i++) {
      var p = S.fx[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.w * dt;
      var f = p.k === 0 ? 1.6 : p.k === 1 ? 3 : p.k === 4 ? 1.2 : 2.4;
      p.vx *= Math.exp(-dt * f); p.vy *= Math.exp(-dt * f);
    }
  }
  function drawFx(c, add) {
    for (var i = 0; i < S.fx.length; i++) {
      var p = S.fx[i];
      if (!p.on) continue;
      var u = p.t / p.life;
      if (add !== (p.k === 1 || p.k === 2)) continue;
      if (p.k === 0) { c.globalAlpha = (1 - u) * 0.45; c.fillStyle = p.c || 'rgb(120,120,124)'; c.beginPath(); c.arc(p.x, p.y, p.s * (0.6 + u * 1.8), 0, TAU); c.fill(); }
      else if (p.k === 1) { c.globalAlpha = 1 - u; c.strokeStyle = p.c || 'rgb(255,190,80)'; c.lineWidth = 0.14; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05); c.stroke(); }
      else if (p.k === 2) { c.globalAlpha = (1 - u) * 0.9; c.fillStyle = u < 0.3 ? 'rgb(170,220,255)' : 'rgb(80,140,255)'; c.beginPath(); c.arc(p.x, p.y, p.s * (1 - u * 0.6), 0, TAU); c.fill(); }
      else if (p.k === 3) { c.globalAlpha = 1 - u * u; c.fillStyle = p.c || '#888'; c.save(); c.translate(p.x, p.y); c.rotate(p.a); c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore(); }
      else if (p.k === 4) { c.globalAlpha = (1 - u) * 0.7; c.fillStyle = 'rgb(170,210,240)'; c.beginPath(); c.arc(p.x, p.y, p.s * (0.5 + u), 0, TAU); c.fill(); }
    }
    c.globalAlpha = 1;
  }

  // ---- the camera ----
  function camUpdate(dt, snap) {
    var g = S.g, P = g.player, cam = S.cam, sp = Math.hypot(P.vx, P.vy), set = S.save.set;
    var lk = Math.min(1, sp / 30) * 0.42, tx = P.x + clamp(P.vx * lk, -24, 24), ty = P.y + clamp(P.vy * lk, -24, 24);
    var zT = S.zBase * lerp(1, 0.55, clamp(sp / 62, 0, 1)) * (S.mapZoom || 1);
    var aT = set.cam === 'north' ? -Math.PI / 2 : (sp > 3 && P.vf < -1 ? cam.a : P.a);
    if (P.dead || (g.result && !g.result.win)) aT = cam.a;
    if (snap) { cam.x = tx; cam.y = ty; cam.z = zT; cam.a = aT; return; }
    var k = Math.min(1, dt * 4);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    cam.z += (zT - cam.z) * Math.min(1, dt * 1.4);
    cam.a += angDiff(cam.a, aT) * Math.min(1, dt * (set.cam === 'north' ? 6 : 2.6));
  }
  function camXform(c, scale) {
    var cam = S.cam, ay = S.save.set.cam === 'north' ? 0.5 : 0.6, sh = S.shakeV;
    c.setTransform(scale * S.dk, 0, 0, scale * S.dk, 0, 0);
    c.translate(S.W / 2 + sh.x, S.H * ay + sh.y);
    c.rotate(-cam.a - Math.PI / 2);
    c.scale(cam.z, cam.z);
    c.translate(-cam.x, -cam.y);
  }
  function viewBox() {
    var cam = S.cam, ay = S.save.set.cam === 'north' ? 0.5 : 0.6, r = Math.hypot(Math.max(S.W / 2, S.W / 2), Math.max(S.H * ay, S.H * (1 - ay))) / cam.z;
    return { x0: cam.x - r - 8, y0: cam.y - r - 8, x1: cam.x + r + 8, y1: cam.y + r + 8, r: r };
  }
  function toScreen(x, y) {
    var cam = S.cam, ay = S.save.set.cam === 'north' ? 0.5 : 0.6, a = -cam.a - Math.PI / 2, dx = (x - cam.x) * cam.z, dy = (y - cam.y) * cam.z;
    return { x: S.W / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: S.H * ay + dx * Math.sin(a) + dy * Math.cos(a) };
  }

  // ---- the world ----
  var _vb = [];
  function render() {
    var g = S.g, c = S.ctx, P = g.player, H = g.heat, vb = viewBox(), i, k;
    S.frameN++;
    S.genLeft = S.raf ? 2 : 99;
    c.setTransform(S.dk, 0, 0, S.dk, 0, 0);
    c.fillStyle = S.pal.walk; c.fillRect(0, 0, S.W, S.H);
    camXform(c, 1);
    // ground chunks (missing ones are made a couple per frame, nearest first)
    var cx0 = Math.floor(vb.x0 / CH), cx1 = Math.floor(vb.x1 / CH), cy0 = Math.floor(vb.y0 / CH), cy1 = Math.floor(vb.y1 / CH), list = [];
    for (var cx = cx0; cx <= cx1; cx++) for (var cy = cy0; cy <= cy1; cy++) list.push([cx, cy, Math.hypot((cx + 0.5) * CH - P.x, (cy + 0.5) * CH - P.y)]);
    list.sort(function (a, b) { return a[2] - b[2]; });
    c.imageSmoothingEnabled = true;
    for (k = 0; k < list.length; k++) {
      var ch = getChunk(list[k][0], list[k][1], k < 1);
      if (ch) c.drawImage(ch.cv, ch.cx * CH, ch.cy * CH, CH + 0.05, CH + 0.05);
    }
    // prefetch one chunk ahead of the car
    if (S.genLeft > 0 && S.raf) { var ax = P.x + P.vx * 2.2, ay = P.y + P.vy * 2.2; getChunk(Math.floor(ax / CH), Math.floor(ay / CH), false); }
    var bl = blocksIn(vb.x0, vb.y0, vb.x1, vb.y1, _vb);
    drawGroundFx(c, g, vb);
    drawProps(c, g, vb);
    // cars: shadows, then bodies (level 0), the overpass decks, then cars on the decks
    var cars = g.cars, lv1 = [];
    for (i = 0; i < cars.length; i++) {
      var o = cars[i];
      if (o.x < vb.x0 - 8 || o.x > vb.x1 + 8 || o.y < vb.y0 - 8 || o.y > vb.y1 + 8) continue;
      if (o.ovp >= 0 && o.lv === 1) { lv1.push(o); continue; }
      drawCar(c, o, g);
    }
    drawDecks(c, g, vb, P);
    for (i = 0; i < lv1.length; i++) drawCar(c, lv1[i], g);
    drawTunnels(c, g, vb);
    drawFx(c, false);
    drawCity(c, g, vb, bl);
    // lights and weather
    drawLights(c, g, vb, bl);
    drawHeli(c, g);
    c.setTransform(S.dk, 0, 0, S.dk, 0, 0);
    if (g.rain) drawRain(c);
    drawHud(c, g);
  }
  function drawGroundFx(c, g, vb) {
    var t = S.animT, H = g.heat, i;
    // race markers in free roam
    if (g.mode === 'roam' && H.st === 'none') {
      var i0 = colOf(vb.x0), i1 = colOf(vb.x1) + 1, j0 = rowOf(vb.y0), j1 = rowOf(vb.y1) + 1;
      for (var a = i0; a <= i1; a++) for (var b = j0; b <= j1; b++) {
        var mk = markerAt(a, b);
        if (!mk) continue;
        var x = nodeX(a, b), y = Yp(b), pr = 5 + Math.sin(t * 3) * 0.6;
        c.fillStyle = 'rgba(255,190,40,0.22)'; c.beginPath(); c.arc(x, y, pr + 2, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(255,190,40,0.95)'; c.lineWidth = 0.5; c.beginPath(); c.arc(x, y, pr, 0, TAU); c.stroke();
        groundText(c, x, y, MK_ICON[mk], 'rgba(255,214,120,1)', 3.6);
      }
    }
    // the next checkpoint and the turn arrows ahead
    if (g.race && g.race.R && g.player.rc && g.player.rc.fin < 0) {
      var cps = g.race.cps, rc = g.player.rc, cp = cps[rc.next];
      if (cp) {
        var last = rc.next === cps.length - 1, pr2 = cp.r * 0.55 + Math.sin(t * 4) * 0.5;
        c.strokeStyle = last ? 'rgba(255,255,255,0.95)' : rgb(S.th.acc, 0.95); c.lineWidth = 0.7; c.setLineDash(last ? [1.4, 1.4] : []);
        c.beginPath(); c.arc(cp.x, cp.y, pr2, 0, TAU); c.stroke(); c.setLineDash([]);
        c.fillStyle = rgb(S.th.acc, 0.16); c.beginPath(); c.arc(cp.x, cp.y, pr2, 0, TAU); c.fill();
      }
      var R = g.race.R, n = R.nodes.length;
      for (i = 1; i < (R.loop ? n + 1 : n - 1); i++) {
        var nd = R.nodes[i % n], pv = R.nodes[i - 1], nx2 = R.nodes[(i + 1) % n], x2 = nodeX(nd[0], nd[1]), y2 = Yp(nd[1]);
        if (x2 < vb.x0 || x2 > vb.x1 || y2 < vb.y0 || y2 > vb.y1) continue;
        var dIn = Math.atan2(Yp(nd[1]) - Yp(pv[1]), x2 - nodeX(pv[0], pv[1])), dOut = Math.atan2(Yp(nx2[1]) - y2, nodeX(nx2[0], nx2[1]) - x2);
        if (Math.abs(angDiff(dIn, dOut)) < 0.4) continue;
        for (var q = 0; q < 3; q++) chevron(c, x2 + Math.cos(dOut) * (4 + q * 3.2), y2 + Math.sin(dOut) * (4 + q * 3.2), dOut, rgb(S.th.acc, 0.55 + 0.4 * ((Math.floor(t * 6) - q) % 3 === 0 ? 1 : 0)));
      }
      var tr = g.race.traps;
      for (i = 0; i < tr.length; i++) {
        if (g.player.rc.trapped[i]) continue;
        c.strokeStyle = 'rgba(255,80,200,0.85)'; c.lineWidth = 0.5; c.beginPath(); c.arc(tr[i].x, tr[i].y, 9, 0, TAU); c.stroke();
        groundText(c, tr[i].x, tr[i].y, 'CAM', 'rgba(255,120,210,1)', 2.6);
      }
    }
    // spike strips
    var sp = H.spikes;
    for (i = 0; i < sp.length; i++) {
      var s = sp[i];
      c.save(); c.translate(s.x, s.y); c.rotate(s.a);
      c.fillStyle = '#2a2a2e'; c.fillRect(-s.len / 2, -0.22, s.len, 0.44);
      c.fillStyle = '#bfc3c8';
      for (var z = -s.len / 2 + 0.2; z < s.len / 2; z += 0.4) { c.beginPath(); c.moveTo(z, -0.22); c.lineTo(z + 0.18, -0.5); c.lineTo(z + 0.36, -0.22); c.fill(); }
      c.restore();
    }
  }
  var MK_ICON = { sprint: 'S', circuit: 'C', drift: 'D', speedtrap: 'T', outrun: 'O' };
  function groundText(c, x, y, t, col, size) {
    c.save(); c.translate(x, y); c.rotate(S.cam.a + Math.PI / 2);
    c.fillStyle = col; c.font = '700 ' + size + 'px ' + S.th.font; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(t, 0, 0.2); c.restore();
  }
  function chevron(c, x, y, a, col) {
    c.save(); c.translate(x, y); c.rotate(a);
    c.fillStyle = col; c.beginPath(); c.moveTo(1.4, 0); c.lineTo(-0.6, -1.6); c.lineTo(-1.3, -1.6); c.lineTo(0.6, 0); c.lineTo(-1.3, 1.6); c.lineTo(-0.6, 1.6); c.closePath(); c.fill();
    c.restore();
  }
  var PCOL = { cone: '#f07a1e', hydrant: '#d33a2c', trash: '#6c7177', news: '#2f6fb8', bench: '#8a6038', barrel: '#2c5c9c', mailbox: '#3159a8', fence: '#9aa0a6', barrier: '#e8e8e4' };
  function drawProps(c, g, vb) {
    var ps = g.props;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p.x < vb.x0 || p.x > vb.x1 || p.y < vb.y0 || p.y > vb.y1) continue;
      if (p.k === 'parked') {
        var sp = carSprite('sedan', p.col, 4.4, 1.8);
        c.save(); c.translate(p.x + 0.35, p.y + 0.28); c.rotate(p.a); c.fillStyle = 'rgba(0,0,0,0.28)'; rrect(c, -2.2, -0.9, 4.4, 1.8, 0.4); c.fill(); c.restore();
        c.save(); c.translate(p.x, p.y); c.rotate(p.a); c.drawImage(sp.cv, -sp.w / 2, -sp.h / 2, sp.w, sp.h); c.restore();
        continue;
      }
      c.save(); c.translate(p.x, p.y); c.rotate(p.a);
      c.fillStyle = PCOL[p.k] || '#888';
      switch (p.k) {
        case 'cone': c.beginPath(); c.arc(0, 0, 0.32, 0, TAU); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 0.14, 0, TAU); c.fill(); break;
        case 'barrier': c.fillRect(-1.1, -0.3, 2.2, 0.6); c.fillStyle = '#d63a2a'; for (var z = -1.1; z < 1.1; z += 0.55) c.fillRect(z, -0.3, 0.27, 0.6); break;
        case 'hydrant': c.beginPath(); c.arc(0, 0, 0.3, 0, TAU); c.fill(); c.fillStyle = '#7a1a14'; c.beginPath(); c.arc(0, 0, 0.12, 0, TAU); c.fill(); break;
        case 'trash': case 'barrel': case 'mailbox': c.beginPath(); c.arc(0, 0, PSPEC[p.k].r, 0, TAU); c.fill(); c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 0.08; c.stroke(); break;
        case 'news': c.fillRect(-0.6, -0.36, 1.2, 0.72); c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(-0.45, -0.2, 0.9, 0.12); break;
        case 'fence': c.fillRect(-0.95, -0.07, 1.9, 0.14); c.fillStyle = '#5c6066'; c.fillRect(-0.95, -0.12, 0.16, 0.24); c.fillRect(0.79, -0.12, 0.16, 0.24); break;
        case 'bench': c.fillRect(-0.9, -0.25, 1.8, 0.5); c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(-0.9, 0.1, 1.8, 0.1); break;
      }
      c.restore();
    }
  }
  function drawCar(c, o, g) {
    var sp = carSprite(o.shape, o.col, o.len, o.wid), ca = Math.cos(o.a), sa = Math.sin(o.a);
    var dx = clamp(-o.acl * 0.008, -0.12, 0.12), dy = clamp(o.lat * 0.006, -0.12, 0.12);
    c.save(); c.translate(o.x + 0.45, o.y + 0.35); c.rotate(o.a); c.fillStyle = 'rgba(0,0,0,0.3)'; rrect(c, -o.len / 2, -o.wid / 2, o.len, o.wid, 0.45); c.fill(); c.restore();
    c.save(); c.translate(o.x + ca * dx - sa * dy, o.y + sa * dx + ca * dy); c.rotate(o.a);
    c.drawImage(sp.cv, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
    if (o.dmg > 0.35) { c.fillStyle = 'rgba(30,26,24,' + Math.min(0.5, (o.dmg - 0.35) * 0.9) + ')'; c.beginPath(); c.ellipse(o.len * 0.3, 0.2, 0.7, 0.45, 0.4, 0, TAU); c.fill(); }
    if (o.dead) { c.fillStyle = 'rgba(20,18,16,0.5)'; rrect(c, -o.len / 2, -o.wid / 2, o.len, o.wid, 0.4); c.fill(); }
    if (o.kind === 'cop') {        // the light bar
      var on = !o.dead && (g.heat.st !== 'none' || (o.ai && o.ai.st === 'block')), ph = Math.floor(S.animT * 8 + o.id) % 2;
      var bx = o.shape === 'copsuv' ? -0.2 : -0.35;
      c.fillStyle = '#222'; c.fillRect(bx - 0.15, -o.wid * 0.38, 0.3, o.wid * 0.76);
      c.fillStyle = on ? (ph ? '#ff3030' : '#802020') : '#6a2020'; c.fillRect(bx - 0.12, -o.wid * 0.36, 0.24, o.wid * 0.34);
      c.fillStyle = on ? (ph ? '#203080' : '#3a70ff') : '#203060'; c.fillRect(bx - 0.12, o.wid * 0.02, 0.24, o.wid * 0.34);
    }
    c.restore();
    if (o.kind === 'rival' && o.name && S.cam.z > 3) {
      var tg = toScreen(o.x, o.y);
      S.tags.push([tg.x, tg.y, o.name, o.boss, rgb(o.col)]);
    }
  }
  function drawDecks(c, g, vb, P) {
    var i0 = colOf(vb.x0), i1 = colOf(vb.x1) + 1, j0 = rowOf(vb.y0), j1 = rowOf(vb.y1) + 1;
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
      if (!overpass(i, j)) continue;
      var o = ovpBox(i, j), L = o.ax ? vline(i) : hline(j), under = P.ovp === ovKey(i, j) && P.lv === 0;
      c.globalAlpha = under ? 0.45 : 1;
      var x0, y0, w, h;
      if (!o.ax) { x0 = o.x - o.hx; w = o.hx * 2; y0 = o.y - L.hw - 0.7; h = (L.hw + 0.7) * 2; }
      else { y0 = o.y - o.hy; h = o.hy * 2; x0 = o.x - L.hw - 0.7; w = (L.hw + 0.7) * 2; }
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x0 + 1.6, y0 + 1.2, w, h);
      c.fillStyle = S.pal.hwy; c.fillRect(x0, y0, w, h);
      c.fillStyle = S.pal.concrete;
      if (!o.ax) { c.fillRect(x0, y0, w, 0.7); c.fillRect(x0, y0 + h - 0.7, w, 0.7); c.fillRect(x0, o.y - 0.35, w, 0.7); }
      else { c.fillRect(x0, y0, 0.7, h); c.fillRect(x0 + w - 0.7, y0, 0.7, h); c.fillRect(o.x - 0.35, y0, 0.7, h); }
      c.strokeStyle = S.pal.white; c.lineWidth = 0.14; c.setLineDash([3, 7]); c.beginPath();
      for (var k = 1; k < L.lanes; k++) for (var s = -1; s <= 1; s += 2) {
        var off = s * (L.med + k * L.lw);
        if (!o.ax) { c.moveTo(x0, o.y + off); c.lineTo(x0 + w, o.y + off); } else { c.moveTo(o.x + off, y0); c.lineTo(o.x + off, y0 + h); }
      }
      c.stroke(); c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }
  function drawTunnels(c, g, vb) {
    var j0 = rowOf(vb.y0) - 1, j1 = rowOf(vb.y1) + 1, i0 = colOf(vb.x0) - 1, i1 = colOf(vb.x1) + 1;
    for (var j = j0; j <= j1; j++) {
      var H = hline(j);
      if (H.t !== 'hwy') continue;
      for (var i = i0; i <= i1; i++) {
        if (!tunnel(i, j)) continue;
        var sp = tunnelSpan(i, j), y0 = H.p - H.hw - 1.4, h = (H.hw + 1.4) * 2;
        c.fillStyle = 'rgba(6,8,12,0.66)'; c.fillRect(sp[0], y0, sp[1] - sp[0], h);
        c.fillStyle = S.pal.concrete; c.fillRect(sp[0] - 1.5, y0 - 1, 1.5, h + 2); c.fillRect(sp[1], y0 - 1, 1.5, h + 2);
        c.fillStyle = 'rgba(255,214,120,0.85)';
        for (var x = sp[0] + 6; x < sp[1] - 3; x += 12) { c.fillRect(x, y0 + 0.4, 1.2, 0.35); c.fillRect(x, y0 + h - 0.75, 1.2, 0.35); }
      }
    }
  }
  // buildings (walls and roofs lean away from the camera), trees, lamps and signals
  var _bd = [];
  function drawCity(c, g, vb, bl) {
    var cam = S.cam, PK = 0.0024 * Math.sqrt(cam.z / S.zBase), list = _bd, i, k;
    list.length = 0;
    for (k = 0; k < bl.length; k++) { var bs = bl[k].blds; for (i = 0; i < bs.length; i++) { var b = bs[i]; if (b.x1 > vb.x0 && b.x0 < vb.x1 && b.y1 > vb.y0 && b.y0 < vb.y1) list.push(b); } }
    list.sort(function (a, b) { return a.h - b.h; });
    var night = S.nightK;
    for (i = 0; i < list.length; i++) {
      var bd = list[i], mx = (bd.x0 + bd.x1) / 2, my = (bd.y0 + bd.y1) / 2, kk = Math.min(bd.h * PK, 0.55);
      var ox = (mx - cam.x) * kk, oy = (my - cam.y) * kk, col = bd.c, ol = Math.hypot(ox, oy), cap = Math.min(9, 1 + bd.h * 0.1);
      if (ol > cap) { ox *= cap / ol; oy *= cap / ol; }
      var wall = rgb(shade(col, 0.62)), wall2 = rgb(shade(col, 0.78));
      if (ox > 0.05) quad(c, bd.x0, bd.y0, bd.x0, bd.y1, ox, oy, wall);
      else if (ox < -0.05) quad(c, bd.x1, bd.y0, bd.x1, bd.y1, ox, oy, wall);
      if (oy > 0.05) quad(c, bd.x0, bd.y0, bd.x1, bd.y0, ox, oy, wall2);
      else if (oy < -0.05) quad(c, bd.x0, bd.y1, bd.x1, bd.y1, ox, oy, wall2);
      // floors on tall walls; lit windows at night
      if (bd.h > 18 && (Math.abs(ox) > 1.5 || Math.abs(oy) > 1.5)) {
        var fl = Math.min(14, Math.floor(bd.h / 7));
        c.strokeStyle = night > 0.3 ? 'rgba(255,214,140,' + (0.35 * night) + ')' : 'rgba(255,255,255,0.13)'; c.lineWidth = 0.22; c.beginPath();
        for (var f = 1; f < fl; f++) {
          var u = f / fl, fx2 = ox * u, fy2 = oy * u;
          if (Math.abs(ox) > 1.5) { var wx = ox > 0 ? bd.x0 : bd.x1; c.moveTo(wx + fx2, bd.y0 + fy2); c.lineTo(wx + fx2, bd.y1 + fy2); }
          if (Math.abs(oy) > 1.5) { var wy = oy > 0 ? bd.y0 : bd.y1; c.moveTo(bd.x0 + fx2, wy + fy2); c.lineTo(bd.x1 + fx2, wy + fy2); }
        }
        c.stroke();
      }
      var rx = bd.x0 + ox, ry = bd.y0 + oy, rw = bd.x1 - bd.x0, rh = bd.y1 - bd.y0;
      c.fillStyle = rgb(col); c.fillRect(rx, ry, rw, rh);
      if (bd.roof === 'gable') {
        c.fillStyle = rgb(shade(col, 0.82));
        if (bd.ax === 0) c.fillRect(rx, ry + rh / 2, rw, rh / 2); else c.fillRect(rx + rw / 2, ry, rw / 2, rh);
        c.strokeStyle = rgb(shade(col, 1.15)); c.lineWidth = 0.25; c.beginPath();
        if (bd.ax === 0) { c.moveTo(rx + 0.4, ry + rh / 2); c.lineTo(rx + rw - 0.4, ry + rh / 2); } else { c.moveTo(rx + rw / 2, ry + 0.4); c.lineTo(rx + rw / 2, ry + rh - 0.4); }
        c.stroke();
      } else if (bd.roof === 'ribs' || bd.roof === 'cont') {
        c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 0.18; c.beginPath();
        var step = bd.roof === 'cont' ? 0.6 : 1.6;
        if (bd.roof === 'cont' || bd.ax === 1) for (var xx = rx + step; xx < rx + rw; xx += step) { c.moveTo(xx, ry + 0.2); c.lineTo(xx, ry + rh - 0.2); }
        else for (var yy = ry + step; yy < ry + rh; yy += step) { c.moveTo(rx + 0.2, yy); c.lineTo(rx + rw - 0.2, yy); }
        c.stroke();
      } else {
        c.strokeStyle = rgb(shade(col, 1.18)); c.lineWidth = 0.5; c.strokeRect(rx + 0.4, ry + 0.4, rw - 0.8, rh - 0.8);
        if (bd.roof === 'pad' && rw > 14 && rh > 14) {
          c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 0.4; c.beginPath(); c.arc(rx + rw / 2, ry + rh / 2, 5, 0, TAU); c.stroke();
          groundText(c, rx + rw / 2, ry + rh / 2, 'H', 'rgba(255,255,255,0.75)', 5);
          if (night > 0.3 && Math.floor(S.animT * 1.5) % 2) { c.fillStyle = 'rgba(255,60,60,0.9)'; c.fillRect(rx + 0.6, ry + 0.6, 0.6, 0.6); c.fillRect(rx + rw - 1.2, ry + rh - 1.2, 0.6, 0.6); }
        }
      }
      for (var d = 0; d < bd.det.length; d++) {
        var q = bd.det[d], dx = ox * 0.08, dy = oy * 0.08;
        c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(q[0] + ox + dx + 0.3, q[1] + oy + dy + 0.3, q[2], q[3]);
        c.fillStyle = q[4] === 'vent' ? rgb(shade(col, 1.1)) : rgb(shade(col, 0.86)); c.fillRect(q[0] + ox + dx, q[1] + oy + dy, q[2], q[3]);
      }
    }
    // trees
    for (k = 0; k < bl.length; k++) {
      var ts = bl[k].trees;
      for (i = 0; i < ts.length; i++) {
        var t = ts[i];
        if (t.x < vb.x0 - 5 || t.x > vb.x1 + 5 || t.y < vb.y0 - 5 || t.y > vb.y1 + 5) continue;
        var kt = 7 * PK, tx = t.x + (t.x - cam.x) * kt, ty = t.y + (t.y - cam.y) * kt;
        c.fillStyle = t.s < 0.5 ? 'rgb(54,104,52)' : 'rgb(66,116,56)'; c.beginPath(); c.arc(tx, ty, t.r, 0, TAU); c.fill();
        c.fillStyle = 'rgba(160,210,110,0.3)'; c.beginPath(); c.arc(tx - t.r * 0.3, ty - t.r * 0.3, t.r * 0.55, 0, TAU); c.fill();
      }
      var ls = bl[k].lamps, kl = 6 * PK;
      c.fillStyle = 'rgb(70,74,80)';
      for (i = 0; i < ls.length; i++) {
        var lp = ls[i];
        if (lp[0] < vb.x0 || lp[0] > vb.x1 || lp[1] < vb.y0 || lp[1] > vb.y1) continue;
        var hx = lp[0] + (lp[0] - cam.x) * kl, hy = lp[1] + (lp[1] - cam.y) * kl;
        c.fillRect(hx - 0.3, hy - 0.3, 0.6, 0.6);
      }
    }
    // signal heads
    var i0 = colOf(vb.x0), i1 = colOf(vb.x1) + 1, j0 = rowOf(vb.y0), j1 = rowOf(vb.y1) + 1;
    for (var a = i0; a <= i1; a++) for (var b2 = j0; b2 <= j1; b2++) {
      if (!signaled(a, b2)) continue;
      var V = vline(a), Hh = hline(b2), nx = nodeX(a, b2), ny = Yp(b2);
      sig(c, nx + V.hw + 1, ny + Hh.hw + 1, light(a, b2, g.t, 0), 0);
      sig(c, nx - V.hw - 1, ny - Hh.hw - 1, light(a, b2, g.t, 0), 0);
      sig(c, nx + V.hw + 1, ny - Hh.hw - 1, light(a, b2, g.t, 1), 1);
      sig(c, nx - V.hw - 1, ny + Hh.hw + 1, light(a, b2, g.t, 1), 1);
    }
  }
  var SIGC = ['#3ee06a', '#ffc934', '#ff4136'];
  function sig(c, x, y, st, ax) {
    c.fillStyle = '#202226';
    if (ax) c.fillRect(x - 0.55, y - 0.3, 1.1, 0.6); else c.fillRect(x - 0.3, y - 0.55, 0.6, 1.1);
    c.fillStyle = SIGC[st]; c.beginPath(); c.arc(x, y, 0.24, 0, TAU); c.fill();
  }
  function quad(c, ax, ay, bx, by, ox, oy, col) {
    c.fillStyle = col; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(bx + ox, by + oy); c.lineTo(ax + ox, ay + oy); c.closePath(); c.fill();
  }
  // night: a darkness layer with holes cut by lights, then glows added on top
  function drawLights(c, g, vb, bl) {
    var nk = S.nightK, H = g.heat, i, k, cars = g.cars;
    if (nk > 0.02) {
      var lc = S.lcx, cv = S.lcv;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalCompositeOperation = 'source-over';
      lc.clearRect(0, 0, cv.width, cv.height);
      lc.fillStyle = S.dusk ? 'rgba(70,30,40,' + (0.42 * nk) + ')' : 'rgba(6,10,28,' + ((0.74 + (g.rain ? 0.06 : 0)) * nk) + ')';
      lc.fillRect(0, 0, cv.width, cv.height);
      lc.globalCompositeOperation = 'destination-out';
      camXform(lc, S.lcs / S.dk);
      var wb = blob('255,255,255'), cn = cone();
      for (k = 0; k < bl.length; k++) {
        var ls = bl[k].lamps;
        for (i = 0; i < ls.length; i++) { var lp = ls[i]; if (lp[0] < vb.x0 - 10 || lp[0] > vb.x1 + 10 || lp[1] < vb.y0 - 10 || lp[1] > vb.y1 + 10) continue; lc.globalAlpha = 0.75; lc.drawImage(wb, lp[0] - 13, lp[1] - 13, 26, 26); }
      }
      lc.globalAlpha = 1;
      for (i = 0; i < cars.length; i++) {
        var o = cars[i];
        if (o.dead || o.x < vb.x0 - 40 || o.x > vb.x1 + 40 || o.y < vb.y0 - 40 || o.y > vb.y1 + 40) continue;
        lc.save(); lc.translate(o.x, o.y); lc.rotate(o.a);
        lc.globalAlpha = o.kind === 'player' ? 1 : 0.8;
        lc.drawImage(cn, o.len * 0.45, -9, 26, 18);
        lc.restore();
        lc.drawImage(wb, o.x - 4, o.y - 4, 8, 8);
      }
      if (H.heli) { lc.globalAlpha = 1; lc.drawImage(wb, H.heli.sx - 16, H.heli.sy - 16, 32, 32); }
      for (i = 0; i < S.fx.length; i++) { var p = S.fx[i]; if (p.on && (p.k === 1 || p.k === 2)) lc.drawImage(wb, p.x - 2, p.y - 2, 4, 4); }
      lc.globalAlpha = 1;
      lc.globalCompositeOperation = 'source-over';
      c.setTransform(S.dk, 0, 0, S.dk, 0, 0);
      c.drawImage(cv, 0, 0, S.W, S.H);
      camXform(c, 1);
    }
    // additive glows: brake lights, light bars, nitro flames, sparks, the helicopter's beam
    c.globalCompositeOperation = 'lighter';
    var rb = blob('255,40,40'), bb = blob('60,110,255'), ab = blob('255,180,80');
    for (i = 0; i < cars.length; i++) {
      var q = cars[i];
      if (q.dead || q.x < vb.x0 - 10 || q.x > vb.x1 + 10 || q.y < vb.y0 - 10 || q.y > vb.y1 + 10) continue;
      var ca = Math.cos(q.a), sa = Math.sin(q.a);
      if (q.brk) { c.globalAlpha = 0.55; c.drawImage(rb, q.x - ca * q.len * 0.5 - 1.3, q.y - sa * q.len * 0.5 - 1.3, 2.6, 2.6); }
      if (q.kind === 'cop' && (H.st !== 'none' || (q.ai && q.ai.st === 'block'))) {
        var ph = Math.floor(S.animT * 8 + q.id) % 2, gx = q.x - ca * 0.35, gy = q.y - sa * 0.35, R = 5 + nk * 5;
        c.globalAlpha = 0.5 + nk * 0.4;
        c.drawImage(ph ? rb : bb, gx - R / 2 + (ph ? sa : -sa) * 0.6, gy - R / 2 - (ph ? ca : -ca) * 0.6, R, R);
      }
      if (q.nosOn) { c.globalAlpha = 0.7; c.drawImage(bb, q.x - ca * (q.len * 0.5 + 1) - 1.6, q.y - sa * (q.len * 0.5 + 1) - 1.6, 3.2, 3.2); }
    }
    if (nk > 0.3) {
      c.globalAlpha = 0.35 * nk;
      for (k = 0; k < bl.length; k++) { var ls2 = bl[k].lamps; for (i = 0; i < ls2.length; i++) { var l2 = ls2[i]; if (l2[0] < vb.x0 || l2[0] > vb.x1 || l2[1] < vb.y0 || l2[1] > vb.y1) continue; c.drawImage(ab, l2[0] - 2, l2[1] - 2, 4, 4); } }
    }
    c.globalAlpha = 1;
    drawFx(c, true);
    if (H.heli) { c.globalAlpha = 0.16 + nk * 0.14; c.drawImage(blob('255,255,240'), H.heli.sx - 15, H.heli.sy - 15, 30, 30); c.globalAlpha = 1; }
    c.globalCompositeOperation = 'source-over';
  }
  function drawHeli(c, g) {
    var h = g.heat.heli;
    if (!h) return;
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.save(); c.translate(h.x + 9, h.y + 7); c.rotate(h.a); c.beginPath(); c.ellipse(0, 0, 4.5, 1.6, 0, 0, TAU); c.fill(); c.restore();
    var k = 1.4;
    c.save(); c.translate(h.x, h.y); c.rotate(h.a); c.scale(k, k);
    c.fillStyle = '#20242c'; c.beginPath(); c.ellipse(0.6, 0, 2.4, 1.2, 0, 0, TAU); c.fill();
    c.fillRect(-4.6, -0.22, 3.6, 0.44); c.fillRect(-4.8, -0.9, 0.4, 1.8);
    c.fillStyle = '#e8e8e8'; c.fillRect(-0.6, -1.15, 2, 0.25); c.fillRect(-0.6, 0.9, 2, 0.25);
    c.fillStyle = '#5a6a80'; c.beginPath(); c.ellipse(1.9, 0, 0.8, 0.7, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(40,40,40,0.55)'; c.lineWidth = 0.25; c.beginPath();
    var ra = S.animT * 30;
    for (var b = 0; b < 2; b++) { var a = ra + b * Math.PI / 2; c.moveTo(Math.cos(a) * 4.2, Math.sin(a) * 4.2); c.lineTo(-Math.cos(a) * 4.2, -Math.sin(a) * 4.2); }
    c.stroke();
    c.fillStyle = Math.floor(S.animT * 4) % 2 ? '#ff3030' : '#30ff60'; c.fillRect(-4.7, -0.15, 0.3, 0.3);
    c.restore();
  }
  function drawRain(c) {
    var n = S.rainN, t = S.animT, W = S.W, H = S.H;
    c.strokeStyle = S.th.dark ? 'rgba(180,200,230,0.32)' : 'rgba(120,140,170,0.38)'; c.lineWidth = 1; c.beginPath();
    for (var i = 0; i < n; i++) {
      var sx = ((i * 97.3 + t * 60 * (1 + (i % 3) * 0.2)) % (W + 40)) - 20, sy = ((i * 53.7 + t * 520 * (1 + (i % 5) * 0.08)) % (H + 40)) - 20;
      c.moveTo(sx, sy); c.lineTo(sx - 4, sy + 13);
    }
    c.stroke();
    c.fillStyle = 'rgba(40,60,90,0.1)'; c.fillRect(0, 0, W, H);
  }

  // ---- HUD ----
  function units() { return S.save.set.units; }
  function spdTxt(v) { return Math.round(units() === 'mph' ? v * 2.23694 : v * 3.6); }
  function distTxt(m) { return units() === 'mph' ? (m < 1609 ? Math.round(m * 3.28084 / 10) * 10 + ' ft' : (m / 1609.34).toFixed(2) + ' mi') : (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'); }
  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ord(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  function hudBox(c, x, y, w, h) { c.fillStyle = S.th.hudBg; rrect(c, x, y, w, h, 6); c.fill(); c.strokeStyle = S.th.hudBd; c.lineWidth = 1; c.stroke(); }
  function txt(c, t, x, y, size, col, align, weight) {
    c.font = (weight || 700) + ' ' + size + 'px ' + S.th.font; c.textAlign = align || 'left'; c.textBaseline = 'middle'; c.fillStyle = col; c.fillText(t, x, y);
  }
  function bar(c, x, y, w, h, v, col, bg) {
    c.fillStyle = bg || rgb(S.th.text, 0.12); rrect(c, x, y, w, h, h / 2); c.fill();
    if (v > 0.001) { c.fillStyle = col; rrect(c, x, y, Math.max(h, w * clamp(v, 0, 1)), h, h / 2); c.fill(); }
  }
  function drawHud(c, g) {
    var W = S.W, H = S.H, P = g.player, Ht = g.heat, th = S.th, pad = 8, fs = clamp(Math.round(W / 34), 10, 13), t = S.animT;
    var mr = clamp(Math.round(Math.min(W, H) * 0.155), 42, 80);
    S.tags.forEach(function (tg) {
      if (tg[0] < 0 || tg[0] > W || tg[1] < 0 || tg[1] > H) return;
      c.font = '700 ' + (fs - 1) + 'px ' + th.font;
      var tw = c.measureText(tg[2]).width + 10;
      c.fillStyle = tg[3] ? 'rgba(200,40,60,0.85)' : 'rgba(20,22,28,0.7)'; rrect(c, tg[0] - tw / 2, tg[1] - 26, tw, fs + 5, 4); c.fill();
      txt(c, tg[2], tg[0], tg[1] - 26 + (fs + 5) / 2, fs - 1, '#fff', 'center');
    });
    S.tags.length = 0;
    if (S.demo) return;
    drawMinimap(c, g, pad + mr, pad + mr, mr, false);
    // top right: heat and money
    var cops = g.mode === 'roam' || (g.E && g.E.cops), bw = clamp(Math.round(W * 0.3), 104, 150), bx = W - pad - bw, by = pad;
    if (cops) {
      var chase = Ht.st !== 'none', blink = chase && Math.floor(t * 4) % 2;
      hudBox(c, bx, by, bw, fs * 3.3);
      txt(c, 'HEAT', bx + 8, by + fs * 0.85, fs - 2, th.hudMu);
      var sw = (bw - 16 - 4 * 3) / 5;
      for (var i = 0; i < 5; i++) {
        var on = Ht.lvl > i, col = on ? (chase ? (blink ? (i % 2 ? '#3a70ff' : '#ff3b3b') : (i % 2 ? '#ff3b3b' : '#3a70ff')) : '#e0a030') : rgb(th.text, 0.12);
        c.fillStyle = col; rrect(c, bx + 8 + i * (sw + 3), by + fs * 1.5, sw, fs * 0.62, 2); c.fill();
      }
      var into = Ht.lvl < 5 ? clamp((Ht.pts - HEAT_AT[Ht.lvl]) / (HEAT_AT[Ht.lvl + 1] - HEAT_AT[Ht.lvl]), 0, 1) : 1;
      bar(c, bx + 8, by + fs * 2.45, bw - 16, 3, into, chase ? '#ff6a4a' : '#e0a030');
      by += fs * 3.3 + 4;
      if (chase || Ht.bounty > 0) {
        hudBox(c, bx, by, bw, fs * 1.9);
        txt(c, 'BOUNTY', bx + 8, by + fs * 0.95, fs - 3, th.hudMu);
        txt(c, fmtN(Ht.bounty * Ht.mult) + (Ht.mult > 1 ? ' x' + Ht.mult : ''), bx + bw - 8, by + fs * 0.95, fs, th.hudAc, 'right');
        by += fs * 1.9 + 4;
      }
    }
    if (g.mode === 'roam') {
      hudBox(c, bx, by, bw, fs * 1.9);
      txt(c, '$', bx + 8, by + fs * 0.95, fs, th.hudMu);
      txt(c, fmtN(S.save.cash), bx + bw - 8, by + fs * 0.95, fs, th.hudTx, 'right');
      by += fs * 1.9 + 4;
    }
    // race panel
    if (g.race && g.mode === 'event') {
      var E = g.E, rows = [], T = g.phase === 'race' ? g.t - (g.t0 || 0) : 0;
      if (E.type === 'drift') { rows.push(['SCORE', fmtN(g.drift.total + (g.drift.on ? g.drift.chain : 0))]); rows.push(['TARGET', fmtN(E.target)]); rows.push(['TIME', fmtTime(Math.max(0, E.time - T)).slice(0, -1)]); }
      else if (E.type === 'escape') { rows.push(['TIME', fmtTime(Math.max(0, E.time - T)).slice(0, -1)]); }
      else {
        rows.push(['POS', placeOf(g, P) + '/' + g.race.racers.length]);
        if (E.loop) rows.push(['LAP', Math.min(E.laps, P.rc.lap + 1) + '/' + E.laps]);
        rows.push(['CP', P.rc.next + '/' + g.race.cps.length]);
        if (E.type === 'speedtrap') rows.push(['CAMS', fmtN(P.rc.trap)]);
        if (E.type === 'outrun' && g.race.gap != null) rows.push(['GAP', (g.race.gap >= 0 ? '+' : '') + Math.round(g.race.gap) + ' m']);
        rows.push(['TIME', fmtTime(T)]);
      }
      var rh = fs * 1.45, ph = rows.length * rh + 8;
      hudBox(c, bx, by, bw, ph);
      rows.forEach(function (r, k) { txt(c, r[0], bx + 8, by + 4 + rh * (k + 0.5), fs - 3, th.hudMu); txt(c, r[1], bx + bw - 8, by + 4 + rh * (k + 0.5), fs, th.hudTx, 'right'); });
      by += ph + 4;
    }
    // bottom: nitro + damage, the pursuit meter, speed
    var bh = fs * 3.4, yb = H - pad - bh, lw = clamp(Math.round(W * 0.26), 92, 140);
    hudBox(c, pad, yb, lw, bh);
    txt(c, 'NOS', pad + 8, yb + bh * 0.3, fs - 3, th.hudMu);
    bar(c, pad + 8 + fs * 2.2, yb + bh * 0.3 - 3, lw - 16 - fs * 2.2, 6, P.nosT, P.nosOn ? '#7cc7ff' : '#3a8ad8');
    txt(c, 'DMG', pad + 8, yb + bh * 0.7, fs - 3, th.hudMu);
    bar(c, pad + 8 + fs * 2.2, yb + bh * 0.7 - 3, lw - 16 - fs * 2.2, 6, P.dmg, P.dmg > 0.7 ? (Math.floor(t * 5) % 2 ? '#ff4136' : '#a02020') : P.dmg > 0.4 ? '#e8a030' : '#6cbf5a');
    var spw = clamp(Math.round(W * 0.24), 86, 130), sx = W - pad - spw;
    hudBox(c, sx, yb, spw, bh);
    var v = Math.hypot(P.vx, P.vy);
    txt(c, String(spdTxt(v)), sx + spw - 8 - fs * 2.6, yb + bh * 0.5, Math.round(fs * 2), P.nosOn ? '#7cc7ff' : th.hudTx, 'right', 800);
    txt(c, units() === 'mph' ? 'MPH' : 'KM/H', sx + spw - 8, yb + bh * 0.5 + 2, fs - 3, th.hudMu, 'right');
    if (P.spiked > 0) txt(c, 'TIRES!', sx + 8, yb + 9, fs - 3, '#ff6a4a');
    // pursuit meter
    var mw = W - lw - spw - pad * 4;
    if (cops && Ht.st !== 'none' && mw > 60) {
      var mx = pad * 2 + lw, ml, mv, mc;
      if (Ht.bust > 0.05) { ml = 'BUSTED'; mv = Ht.bust / DIFFS[g.diff].bust; mc = '#ff4136'; }
      else if (Ht.st === 'cool') { ml = 'EVADING'; mv = Ht.evade; mc = '#3ecf6a'; }
      else { ml = 'PURSUIT'; mv = -1; mc = Math.floor(t * 4) % 2 ? '#ff3b3b' : '#3a70ff'; }
      hudBox(c, mx, yb, mw, bh);
      txt(c, ml, mx + mw / 2, yb + bh * 0.32, fs, mc, 'center', 800);
      if (mv >= 0) bar(c, mx + 8, yb + bh * 0.68 - 3, mw - 16, 6, mv, mc);
      else { var nc = 0; g.cars.forEach(function (q) { if (q.kind === 'cop' && !q.dead) nc++; }); txt(c, nc + ' unit' + (nc === 1 ? '' : 's') + ' · ' + fmtTime(Ht.chaseT).slice(0, -3), mx + mw / 2, yb + bh * 0.7, fs - 3, th.hudMu, 'center'); }
    }
    // GPS arrow to the next checkpoint
    var tgt = null;
    if (g.race && g.race.R && P.rc && P.rc.fin < 0) tgt = g.race.cps[P.rc.next];
    if (tgt) {
      var ps = toScreen(P.x, P.y), ts = toScreen(tgt.x, tgt.y), dx = ts.x - ps.x, dy = ts.y - ps.y, dd = Math.hypot(dx, dy) || 1, R2 = 34;
      if (dd > R2 + 6) {
        var ax = ps.x + dx / dd * R2, ay = ps.y + dy / dd * R2, an = Math.atan2(dy, dx);
        c.save(); c.translate(ax, ay); c.rotate(an); c.fillStyle = th.hudAc; c.strokeStyle = th.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(9, 0); c.lineTo(-5, -7); c.lineTo(-2, 0); c.lineTo(-5, 7); c.closePath(); c.stroke(); c.fill(); c.restore();
        var dw = Math.hypot(tgt.x - P.x, tgt.y - P.y);
        txt(c, distTxt(dw), ax + dx / dd * 16, ay + dy / dd * 16, fs - 3, th.hudTx, 'center');
      }
    }
    // drift chain, messages, the countdown
    var D = g.drift;
    if (D.on && D.chain > 40) {
      var dfs = Math.round(fs * 1.3);
      txt(c, 'DRIFT ' + fmtN(D.chain) + (D.mult > 1 ? '  x' + D.mult : ''), W / 2, H * 0.62 + 40, dfs, th.hudAc, 'center', 800);
    }
    if (g.phase === 'count') bigText(c, String(Math.max(1, Math.ceil(g.countT))), 1 - (g.countT % 1), th.hudAc);
    else if (g.t - (g.t0 || 0) < 0.8 && g.race) bigText(c, 'GO!', 1, th.hudAc);
    var m = S.msg;
    if (m && m.t > 0) {
      var a = Math.min(1, m.t * 2.5), mfs = Math.round(clamp(W / 13, 18, 34));
      c.globalAlpha = a;
      c.font = '900 ' + mfs + 'px ' + th.font; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineWidth = 4; c.strokeStyle = th.dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.9)';
      var my = H * 0.3;
      c.strokeText(m.txt, W / 2, my); c.fillStyle = m.col || th.hudAc; c.fillText(m.txt, W / 2, my);
      if (m.sub) { c.font = '700 ' + Math.round(mfs * 0.46) + 'px ' + th.font; c.lineWidth = 3; c.strokeText(m.sub, W / 2, my + mfs * 0.8); c.fillStyle = th.hudTx; c.fillText(m.sub, W / 2, my + mfs * 0.8); }
      c.globalAlpha = 1;
      m.t -= S.fdt || 0;
    }
    if (S.flash > 0) { c.fillStyle = 'rgba(255,60,40,' + (S.flash * 0.25) + ')'; c.fillRect(0, 0, W, H); S.flash = Math.max(0, S.flash - (S.fdt || 0) * 3); }
    if (S.toast && S.toast.t > 0) {
      txt(c, S.toast.txt, W / 2, pad + fs * 0.9 + (S.W < 480 ? mr * 2 + 6 : 0), fs, S.toast.col || th.hudTx, 'center');
      S.toast.t -= S.fdt || 0;
    }
  }
  function bigText(c, t, a, col) {
    var W = S.W, H = S.H, fs = Math.round(Math.min(W, H) * 0.22) * (1 + (1 - a) * 0.3);
    c.globalAlpha = clamp(a * 1.6, 0, 1);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '900 ' + Math.round(fs) + 'px ' + S.th.font;
    c.lineWidth = Math.max(3, fs * 0.08); c.strokeStyle = S.th.dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
    c.strokeText(t, W / 2, H * 0.36); c.fillStyle = col; c.fillText(t, W / 2, H * 0.36);
    c.globalAlpha = 1;
  }
  // the minimap: nearby roads straight from the lattice, the route, cops with their view cones
  function drawMinimap(c, g, cx, cy, r, big) {
    var P = g.player, th = S.th, rot = !big && S.save.set.cam !== 'north', range = big ? S.bigR : 240, k = r / range, i, j;
    c.save();
    c.beginPath(); if (big) c.rect(cx - r, cy - r, r * 2, r * 2); else c.arc(cx, cy, r, 0, TAU);
    c.fillStyle = th.dark ? 'rgba(18,20,24,0.88)' : 'rgba(250,250,248,0.9)'; c.fill();
    c.strokeStyle = th.hudBd; c.lineWidth = 1; c.stroke();
    c.clip();
    c.translate(cx, cy);
    if (rot) c.rotate(-S.cam.a - Math.PI / 2);
    c.scale(k, k);
    var ox = big ? S.mapC.x : P.x, oy = big ? S.mapC.y : P.y;
    c.translate(-ox, -oy);
    var R = range * 1.45, x0 = ox - R, x1 = ox + R, y0 = oy - R, y1 = oy + R;
    // water
    c.fillStyle = th.dark ? 'rgba(60,110,160,0.55)' : 'rgba(110,160,210,0.6)';
    for (j = rowOf(y0); j <= rowOf(y1); j++) if (isRiver(j)) c.fillRect(x0, Yp(j), x1 - x0, Yp(j + 1) - Yp(j));
    var roadCol = th.dark ? 'rgba(200,200,205,0.55)' : 'rgba(90,92,100,0.55)', hwyCol = th.dark ? 'rgba(240,200,110,0.75)' : 'rgba(200,140,40,0.75)';
    c.lineCap = 'butt';
    for (j = rowOf(y0); j <= rowOf(y1) + 1; j++) {
      var Hh = hline(j);
      c.strokeStyle = Hh.t === 'hwy' ? hwyCol : roadCol; c.lineWidth = Math.max(Hh.hw * 2, (Hh.t === 'hwy' ? 3.2 : Hh.t === 'alley' ? 1 : 2) / k);
      c.beginPath(); c.moveTo(x0, Hh.p); c.lineTo(x1, Hh.p); c.stroke();
    }
    for (i = colOf(x0); i <= colOf(x1) + 1; i++) {
      var V = vline(i);
      c.strokeStyle = V.t === 'hwy' ? hwyCol : roadCol; c.lineWidth = Math.max(V.hw * 2, (V.t === 'hwy' ? 3.2 : V.t === 'alley' ? 1 : 2) / k);
      c.beginPath();
      runs(1, i, y0, y1).forEach(function (r2) { polyLine(c, 1, i, r2[0], r2[1], 0, 16); });
      c.stroke();
    }
    // markers
    if (g.mode === 'roam') {
      for (i = colOf(x0); i <= colOf(x1) + 1; i++) for (j = rowOf(y0); j <= rowOf(y1) + 1; j++) {
        if (!markerAt(i, j)) continue;
        c.fillStyle = '#ffb020'; c.beginPath(); c.arc(nodeX(i, j), Yp(j), 4.5 / k, 0, TAU); c.fill();
      }
    }
    // route
    if (g.race && g.race.R) {
      var Rt = g.race.R;
      c.strokeStyle = th.hudAc; c.lineWidth = 3.2 / k; c.lineJoin = 'round'; c.beginPath();
      for (i = 0; i < Rt.N; i += 3) c[i ? 'lineTo' : 'moveTo'](Rt.xs[i], Rt.ys[i]);
      if (Rt.loop) c.closePath(); else c.lineTo(Rt.xs[Rt.N - 1], Rt.ys[Rt.N - 1]);
      c.stroke();
      var cp = P.rc && g.race.cps[P.rc.next];
      if (cp) { c.fillStyle = '#fff'; c.strokeStyle = th.hudAc; c.lineWidth = 2 / k; c.beginPath(); c.arc(cp.x, cp.y, 5 / k, 0, TAU); c.fill(); c.stroke(); }
      g.race.racers.forEach(function (q) { if (q !== P) { c.fillStyle = rgb(q.col); c.beginPath(); c.arc(q.x, q.y, 3.4 / k, 0, TAU); c.fill(); c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1 / k; c.stroke(); } });
    }
    // roadblocks, cops and their view cones
    var H = g.heat, bl = Math.floor(S.animT * 5) % 2;
    H.rb.forEach(function (rb) { c.fillStyle = '#ff3b3b'; c.fillRect(rb.x - 6 / k, rb.y - 2 / k, 12 / k, 4 / k); });
    g.cars.forEach(function (q) {
      if (q.kind !== 'cop' || q.dead) return;
      var rng = (48 + H.lvl * 10) * (H.st === 'chase' ? 1.6 : 1) * 0.6;
      c.fillStyle = q.sees ? 'rgba(255,60,60,0.28)' : 'rgba(255,90,90,0.13)';
      c.beginPath(); c.moveTo(q.x, q.y); c.arc(q.x, q.y, rng, q.a - 0.5, q.a + 0.5); c.closePath(); c.fill();
      c.fillStyle = H.st !== 'none' ? (bl ? '#ff3b3b' : '#3a70ff') : '#4a6ae0';
      c.beginPath(); c.arc(q.x, q.y, 3.6 / k, 0, TAU); c.fill();
    });
    if (H.heli) { c.strokeStyle = '#ff3b3b'; c.lineWidth = 2 / k; c.beginPath(); c.arc(H.heli.sx, H.heli.sy, 14, 0, TAU); c.stroke(); }
    // the player
    c.translate(P.x, P.y); c.rotate(P.a);
    c.fillStyle = th.hudAc; c.strokeStyle = th.dark ? '#000' : '#fff'; c.lineWidth = 1.5 / k;
    c.beginPath(); c.moveTo(7 / k, 0); c.lineTo(-5 / k, -4.5 / k); c.lineTo(-3 / k, 0); c.lineTo(-5 / k, 4.5 / k); c.closePath(); c.fill(); c.stroke();
    c.restore();
    if (rot) {      // north tick
      var na = -S.cam.a - Math.PI / 2 - Math.PI / 2;
      txt(c, 'N', cx + Math.cos(na) * (r - 7), cy + Math.sin(na) * (r - 7), 9, th.hudMu, 'center');
    }
  }
  function drawBigMap(c, g) {
    var W = S.W, H = S.H, pad = 10, r = Math.min(W, H) / 2 - pad;
    c.setTransform(S.dk, 0, 0, S.dk, 0, 0);
    c.fillStyle = S.th.dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'; c.fillRect(0, 0, W, H);
    drawMinimap(c, g, W / 2, H / 2, r, true);
    txt(c, 'MAP · ' + distTxt(S.bigR * 2) + ' across · north up', W / 2, H / 2 - r + 12, 11, S.th.hudMu, 'center');
  }

  // ---- icons and art ----
  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_MAP = svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>');
  var IC_CAM = svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>');
  var ART = '█▀ ▀█▀ █▀█ █▀▀ █▀▀ ▀█▀   █ █ █▀▀ ▄▀█ ▀█▀\n' +
            '▄█  █  █▀▄ ██▄ ██▄  █    █▀█ ██▄ █▀█  █ ';
  var ROAD_ART = '▪▪ ═══ ▸ ═══ ▪▪';

  // ---- cards ----
  function chip(attr, val, label, on, extra) { return '<button type="button" class="sh-chip' + (on ? ' on' : '') + '" ' + attr + '="' + val + '"' + (extra || '') + '>' + label + '</button>'; }
  function autoGas() { return S.save.set.autogas === true; } // opt-in: never accelerate without input unless asked
  function showCard(kind) {
    S.card = kind;
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.stage.classList.remove('dim'); syncHead(); return; }
    S.ovl.innerHTML = cardHtml(kind);
    S.ovl.style.display = '';
    S.ovl.scrollTop = 0;
    S.stage.classList.toggle('dim', kind !== 'map');
    syncHead();
  }
  function evLine(E) {
    var bits = [];
    if (E.nodes) { var R = denseRoute(E.nodes, E.loop); bits.push(distTxt(R.L * (E.laps || 1))); }
    if (E.laps) bits.push(E.laps + ' laps');
    if (E.rivals.length) bits.push(E.rivals.length === 1 ? 'vs ' + E.rivals[0].name : E.rivals.length + ' rivals');
    if (E.type === 'drift') bits.push('target ' + fmtN(E.target));
    if (E.type === 'escape') bits.push('heat ' + E.heat + ' · ' + Math.round(E.time) + 's');
    if (E.cops && E.type !== 'escape') bits.push('police');
    return bits.join(' · ');
  }
  function dailyBest() { var d = S.save.daily; return d.d === S.today && d.best != null ? d.best : null; }
  function recTxt(type, v) { return v == null ? '—' : type === 'drift' ? fmtN(v) + ' pts' : type === 'speedtrap' ? fmtN(v) + ' km/h' : fmtTime(v); }
  function cardHtml(kind) {
    var sv = S.save, set = sv.set, h = '', E;
    if (kind === 'menu') {
      h += '<div class="sh-card"><pre class="sh-art">' + ART + '</pre><div class="sh-road">' + ROAD_ART + '</div>';
      h += '<div class="sh-tabs">' + [['play', 'Play'], ['career', 'Career'], ['garage', 'Garage'], ['settings', 'Settings']].map(function (t) { return '<button type="button" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>';
      if (S.tab === 'play') {
        var b = sv.best;
        h += '<button type="button" class="sh-mode" data-act="roam" data-primary="1"><b>FREE ROAM</b><span>Cruise the city, hit race markers, raise some heat and lose the police.</span><i>Best bounty ' + fmtN(b.bounty) + ' · top heat ' + b.heat + ' · $' + fmtN(sv.cash) + '</i></button>';
        var cn = careerNext(sv);
        h += '<button type="button" class="sh-mode" data-tab="career"><b>CAREER</b><span>Climb the Heat List: beat ten rivals, earn cash, build a garage.</span><i>' + (cn ? 'Rival #' + (10 - cn.ri) + ' ' + esc(cn.rival.name) + ' · ' + cn.won + '/' + cn.need + ' events' : 'You top the list') + '</i></button>';
        E = S.dailyE;
        h += '<button type="button" class="sh-mode" data-act="daily"><b>DAILY RUN · ' + EV_NAMES[E.type].toUpperCase() + '</b><span>' + EV_TIPS[E.type] + '</span><i>' + S.today + ' · best ' + recTxt(E.type, dailyBest()) + '</i></button>';
        h += '<div class="sh-sec"><div class="sh-h">Difficulty <i>cops, rivals, traffic</i></div><div class="sh-chips">' + DIFFS.map(function (d, i) { return chip('data-diff', i, d.name, set.diff === i); }).join('') + '</div></div>';
        h += '<div class="sh-foot"><button type="button" class="sh-lnk" data-act="help">How to play</button><span>' + sv.stats.wins + '/' + sv.stats.races + ' wins · ' + sv.stats.escapes + ' escapes · ' + sv.stats.busts + ' busts</span></div>';
      } else if (S.tab === 'career') h += careerHtml();
      else if (S.tab === 'garage') h += garageHtml();
      else h += settingsHtml();
      h += '</div>';
    } else if (kind === 'help') {
      h += '<div class="sh-card"><div class="sh-title">HOW TO DRIVE</div><div class="sh-keys">' +
        '<div><b>↑ ↓</b> / <b>W S</b> gas · brake / reverse</div><div><b>← →</b> / <b>A D</b> steer</div><div><b>Space</b> handbrake drift · <b>Shift</b> / <b>N</b> nitro</div>' +
        '<div><b>M</b> map · <b>C</b> camera · <b>R</b> back on the road · <b>P</b> / <b>Esc</b> pause</div><div><b>Touch</b> drag the thumb stick on the left to steer (◀ ▶ buttons in settings) · NOS · DRIFT · BRK · GAS on the right</div></div>' +
        '<p><b>Heat</b> rises when police see you speed, crash into traffic or smash things, and keeps climbing in a chase. Break their line of sight (round corners, under overpasses, through tunnels) to start <b>evading</b>; stay hidden until the meter fills.</p>' +
        '<p>Stopped with a cop on you, the <b>BUSTED</b> meter fills: you lose the bounty and pay a fine. Three strikes and a car is impounded. From heat 3: roadblocks; 4: spike strips; 5: a helicopter.</p>' +
        '<p><b>Drift</b> with the handbrake for points and nitro. Races follow the route on the map; hit every checkpoint.</p>' +
        '<button type="button" class="sh-go" data-act="close-help" data-primary="1">' + (S.firstRun ? "LET'S RIDE" : 'GOT IT') + '</button></div>';
    } else if (kind === 'pre') {
      E = S.ectx.E;
      var who = S.ectx.boss != null ? RIVALS[S.ectx.boss] : null;
      h += '<div class="sh-card"><div class="sh-top"><span class="sh-brand">' + (S.ectx.kind === 'daily' ? 'DAILY RUN' : S.ectx.kind === 'career' ? 'CAREER' : 'STREET RACE') + '</span><span class="sh-meta">$' + fmtN(sv.cash) + '</span></div>';
      h += '<div class="sh-title">' + esc(E.name.toUpperCase()) + '</div>';
      if (who) h += '<p class="sh-sub"><b>' + esc(who.name) + '</b> "' + esc(who.tag) + '" · ' + esc(CAR_BY[who.car].name) + '<br>' + esc(who.bio) + '</p>';
      h += '<p class="sh-sub">' + EV_TIPS[E.type] + '</p><div class="sh-note">' + evLine(E) + '</div>';
      h += '<div class="sh-big">$' + fmtN(E.reward) + '<small> to win</small></div>';
      if (S.ectx.kind === 'daily') h += '<div class="sh-note">Today\'s best: ' + recTxt(E.type, dailyBest()) + '</div>';
      h += '<div class="sh-note">Car: ' + esc(CAR_BY[sv.car].name) + (sv.impound[sv.car] ? ' (impounded!)' : '') + ' · ' + DIFFS[set.diff].name + '</div>';
      h += '<div class="sh-btns"><button type="button" class="sh-go alt" data-act="pre-back">Back</button><button type="button" class="sh-go" data-act="start-ev" data-primary="1">START</button></div></div>';
    } else if (kind === 'pause') {
      var g = S.g, roam = g && g.mode === 'roam', rep = repairCost();
      h += '<div class="sh-card"><div class="sh-title">PAUSED</div>';
      if (roam) h += '<div class="sh-note">$' + fmtN(sv.cash) + ' · heat ' + g.heat.lvl + (g.heat.st !== 'none' ? ' · in pursuit' : '') + '</div>';
      else if (g && g.E) h += '<div class="sh-note">' + esc(g.E.name) + ' · ' + evLine(g.E) + '</div>';
      h += '<button type="button" class="sh-go" data-act="resume" data-primary="1">RESUME</button>';
      h += '<div class="sh-btns"><button type="button" class="sh-go alt" data-act="map">Map (M)</button><button type="button" class="sh-go alt" data-act="reset-car"' + (g && g.heat.st !== 'none' ? ' disabled' : '') + '>Back on road (R)</button></div>';
      if (roam && rep > 0) h += '<button type="button" class="sh-go alt" data-act="repair"' + (g.heat.st !== 'none' || sv.cash < rep ? ' disabled' : '') + '>Repair the car · $' + fmtN(rep) + '</button>';
      h += '<div class="sh-btns">' + (roam ? '' : '<button type="button" class="sh-go alt" data-act="restart">Restart</button>') + '<button type="button" class="sh-go alt" data-act="quit">' + (roam ? 'Garage & menu' : 'Quit event') + '</button></div></div>';
    } else if (kind === 'map') {
      h += '<div class="sh-mapbar"><button type="button" class="sh-go alt" data-act="zoom-in">+</button><button type="button" class="sh-go alt" data-act="zoom-out">−</button><button type="button" class="sh-go" data-act="map-close" data-primary="1">Close (M)</button></div>';
    } else if (kind === 'result') {
      var r = S.res, res = r.res;
      E = S.ectx.E;
      h += '<div class="sh-card"><div class="sh-title">' + (res.win ? 'VICTORY' : 'DEFEAT') + '</div><div class="sh-sub">' + esc(E.name) + ' · ' + esc(res.why) + '</div>';
      if (E.type === 'drift') h += '<div class="sh-big">' + fmtN(res.score) + '<small> / ' + fmtN(E.target) + ' pts</small></div>';
      else if (E.type === 'speedtrap') h += '<div class="sh-big">' + fmtN(res.score) + '<small> km/h total</small></div>';
      else if (res.win || res.place) h += '<div class="sh-big">' + (res.place ? ord(res.place) : '') + '<small> ' + fmtTime(res.time) + '</small></div>';
      if (r.rows) h += '<div class="sh-res">' + r.rows + '</div>';
      h += '<div class="sh-big sm">' + (r.cash ? '+$' + fmtN(r.cash) : '$0') + '</div>';
      if (r.beat) h += '<p class="sh-new">' + esc(RIVALS[r.beat - 1].name) + ' is off the list! ' + (r.unlock ? esc(r.unlock) + ' can now be bought.' : '') + '</p>';
      if (r.newRec) h += '<p class="sh-new">New daily best!</p>';
      h += '<div class="sh-btns"><button type="button" class="sh-go alt" data-act="retry">Retry</button><button type="button" class="sh-go" data-act="after" data-primary="1">CONTINUE</button></div></div>';
    } else if (kind === 'busted') {
      var bz = S.bust;
      h += '<div class="sh-card"><pre class="sh-art bad">█▄▄ █ █ █▀ ▀█▀ █▀▀ █▀▄\n█▄█ █▄█ ▄█  █  ██▄ █▄▀</pre>';
      h += '<p class="sh-sub">Bounty lost: ' + fmtN(bz.bounty) + '. Fine paid: $' + fmtN(bz.fine) + '.</p>';
      h += '<p class="sh-sub">' + (bz.impound ? '<b>Third strike — your car was impounded.</b> Release it in the garage. You are now in the ' + esc(CAR_BY[bz.now].name) + '.' : 'Strike ' + bz.strikes + ' of 3 on this car.') + '</p>';
      h += '<button type="button" class="sh-go" data-act="cont" data-primary="1">CONTINUE</button></div>';
    } else if (kind === 'wrecked') {
      h += '<div class="sh-card"><div class="sh-title">TOTALED</div><p class="sh-sub">A tow truck hauls what is left to the curb. Tow and repair: $' + fmtN(S.towFee) + '.</p>';
      h += '<button type="button" class="sh-go" data-act="cont-wreck" data-primary="1">CONTINUE</button></div>';
    } else if (kind === 'marker') {
      E = S.ectx.E;
      h += '<div class="sh-card"><div class="sh-top"><span class="sh-brand">STREET RACE</span><span class="sh-meta">$' + fmtN(sv.cash) + '</span></div><div class="sh-title">' + esc(E.name.toUpperCase()) + '</div>';
      h += '<p class="sh-sub">' + EV_TIPS[E.type] + '</p><div class="sh-note">' + evLine(E) + '</div><div class="sh-big">$' + fmtN(E.reward) + '<small> to win</small></div>';
      h += '<div class="sh-btns"><button type="button" class="sh-go alt" data-act="mk-no">Drive on</button><button type="button" class="sh-go" data-act="start-ev" data-primary="1">RACE</button></div></div>';
    }
    return h;
  }
  function careerHtml() {
    var sv = S.save, cn = careerNext(sv), h = '<div class="sh-top"><span class="sh-brand">HEAT LIST</span><span class="sh-meta">$' + fmtN(sv.cash) + '</span></div><div class="sh-ladder">';
    for (var i = RIVALS.length - 1; i >= 0; i--) {
      var R = RIVALS[i], done = sv.career.beaten > i, cur = sv.career.beaten === i;
      h += '<div class="' + (cur ? 'cur' : done ? 'done' : '') + '"><span>#' + (10 - i) + '</span><b>' + esc(R.name) + '</b><i>' + (done ? '✓ beaten' : cur ? '◀ next' : esc(R.tag)) + '</i></div>';
    }
    h += '</div>';
    if (!cn) return h + '<p class="sh-new">You top the Heat List. The city is yours — keep racing in Free Roam.</p>';
    var R2 = cn.rival;
    h += '<div class="sh-rival"><b>#' + (10 - cn.ri) + ' ' + esc(R2.name) + ' "' + esc(R2.tag) + '"</b><span>' + esc(R2.bio) + '</span><i>Drives a ' + esc(CAR_BY[R2.car].name) + ' · win ' + cn.need + ' events to call them out</i></div>';
    cn.events.forEach(function (e, k) {
      var E = makeEvent(e.type, e.seed, e.tier, e.boss != null ? { boss: e.boss } : null), boss = e.boss != null;
      h += '<button type="button" class="sh-ev' + (e.won ? ' won' : '') + (boss ? ' boss' : '') + '" data-ev="' + k + '"' + (e.locked ? ' disabled' : '') + '><b>' + (boss ? '★ VS ' + esc(R2.name.split(' ')[0].toUpperCase()) + ' · ' : '') + esc(E.name) + '</b><span>' + evLine(E) + '</span><i>' + (e.won ? '✓ won · replay' : e.locked ? 'win the other events first' : '$' + fmtN(E.reward)) + '</i></button>';
    });
    return h;
  }
  function statRow(label, v, mx) { var n = Math.round(clamp(v / mx, 0, 1) * 10); return '<div class="sh-stat"><span>' + label + '</span><b>' + '█'.repeat(n) + '<i>' + '█'.repeat(10 - n) + '</i></b></div>'; }
  function repairCost() { var g = S.g; return g && g.mode === 'roam' ? Math.round(g.player.dmg * 900 / 10) * 10 : 0; }
  function garageHtml() {
    var sv = S.save, h = '<div class="sh-top"><span class="sh-brand">GARAGE</span><span class="sh-meta">$' + fmtN(sv.cash) + '</span></div><div class="sh-cars">';
    CARS.forEach(function (c) {
      var own = sv.cars.indexOf(c.id) >= 0, ok = carUnlocked(sv, c.id), imp = sv.impound[c.id];
      var sub = imp ? 'impounded · $' + fmtN(releaseCost(c.id)) : own ? (sv.car === c.id ? 'driving' : 'owned') : !ok ? '\u{1F512} beat rival #' + (11 - c.need) : S.buyArm === c.id ? 'tap again: $' + fmtN(c.cost) : '$' + fmtN(c.cost);
      h += '<button type="button" class="sh-carb' + (sv.car === c.id ? ' cur' : '') + (!own && !ok ? ' lock' : '') + '" data-car="' + c.id + '"' + (!own && !ok ? ' disabled' : '') + '><b>' + esc(c.name) + '</b><span>' + esc(c.cls) + '</span><i>' + sub + '</i></button>';
    });
    h += '</div>';
    var cur = CAR_BY[sv.car], st = stats(cur, sv.upg[cur.id]);
    h += '<div class="sh-stats">' + statRow('ACCEL', st.acc, 20) + statRow('TOP', st.top, 90) + statRow('GRIP', st.grip * st.hand, 1.6) + statRow('NITRO', st.nos * st.cap, 2.6) + statRow('MASS', st.m, 2600) + statRow('ARMOR', st.dur, 2.6) + '</div>';
    h += '<div class="sh-upgs">';
    var u = sv.upg[cur.id] || {};
    UPGS.forEach(function (U) {
      var l = u[U.id] || 0, cost = l < 3 ? upgCost(cur.id, l) : 0;
      h += '<div class="sh-upg"><div><b>' + U.name + '</b> <span class="sh-pips">' + '●'.repeat(l) + '○'.repeat(3 - l) + '</span><i>' + U.tip + '</i></div>' +
        (l < 3 ? '<button type="button" class="sh-buy" data-buy="' + U.id + '"' + (sv.cash < cost ? ' disabled' : '') + '>$' + fmtN(cost) + '</button>' : '<span class="sh-max">MAX</span>') + '</div>';
    });
    h += '</div><div class="sh-sec"><div class="sh-h">Paint</div><div class="sh-chips">';
    var pi = sv.paint[cur.id] || 0;
    PAINTS.forEach(function (pt, i) {
      var col = pt.col || cur.col;
      h += chip('data-paint', i, '<b style="background:' + rgb(col) + '"></b>' + esc(pt.name) + (i !== pi && pt.cost ? ' <i>$' + pt.cost + '</i>' : ''), i === pi, sv.cash < pt.cost && i !== pi ? ' disabled' : '');
    });
    h += '</div></div>';
    if (sv.roam && sv.roam.dmg > 0.01) { var rc = Math.round(sv.roam.dmg * 900 / 10) * 10; h += '<button type="button" class="sh-go alt" data-act="repair-g"' + (sv.cash < rc ? ' disabled' : '') + '>Repair the ' + esc(cur.name) + ' (' + Math.round(sv.roam.dmg * 100) + '% damage) · $' + fmtN(rc) + '</button>'; }
    return h;
  }
  function settingsHtml() {
    var set = S.save.set, h = '';
    function row(label, chips) { return '<div class="sh-sec"><div class="sh-h">' + label + '</div><div class="sh-chips">' + chips + '</div></div>'; }
    h += row('Camera <i>C</i>', chip('data-set', 'cam:rotate', 'Turns with the car', set.cam === 'rotate') + chip('data-set', 'cam:north', 'North up', set.cam === 'north'));
    h += row('Units', chip('data-set', 'units:kmh', 'km/h', set.units === 'kmh') + chip('data-set', 'units:mph', 'mph', set.units === 'mph'));
    h += row('Steering assist', chip('data-set', 'assist:0', 'Off', set.assist === 0) + chip('data-set', 'assist:1', 'Low', set.assist === 1) + chip('data-set', 'assist:2', 'High', set.assist === 2));
    h += row('Touch steering', chip('data-set', 'touch:stick', 'Joystick', set.touch === 'stick') + chip('data-set', 'touch:buttons', '◀ ▶ buttons', set.touch === 'buttons'));
    h += row('Auto gas <i>touch</i>', chip('data-set', 'autogas:on', 'On', autoGas()) + chip('data-set', 'autogas:off', 'Off', !autoGas()));
    h += row('Time of day', ['auto', 'day', 'dusk', 'night'].map(function (v) { return chip('data-set', 'time:' + v, v.charAt(0).toUpperCase() + v.slice(1), set.time === v); }).join(''));
    h += row('Weather', ['auto', 'clear', 'rain'].map(function (v) { return chip('data-set', 'weather:' + v, v.charAt(0).toUpperCase() + v.slice(1), set.weather === v); }).join(''));
    h += row('Screen shake', chip('data-set', 'shake:1', 'On', !!set.shake) + chip('data-set', 'shake:0', 'Low', !set.shake));
    h += '<div class="sh-foot">' + (S.resetArm ? '<span class="sh-confirm">Erase career, cars, cash and records? <button type="button" class="sh-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="sh-lnk" data-act="reset-no">Keep</button></span>'
      : '<button type="button" class="sh-lnk" data-act="reset">Reset progress</button>') + '</div>';
    return h;
  }

  // ---- flow ----
  function envOf(E) {
    var set = S.save.set, o = { rain: false, night: false, dusk: false };
    if (set.weather === 'rain') o.rain = true; else if (set.weather === 'auto') o.rain = E ? (E.rain != null ? E.rain : hash3(E.seed, 8, 8) % 4 === 0) : Math.random() < 0.22;
    if (set.time === 'night') o.night = true; else if (set.time === 'dusk') o.dusk = true;
    else if (set.time === 'auto' && E) o.night = E.night != null ? E.night : hash3(E.seed, 9, 9) % 3 === 0;
    return o;
  }
  function trafficCap() { return S.coarse ? 13 : 17; }
  function startDemo() {
    S.demo = true;
    var spawn = S.save.roam;
    S.g = newGame({ mode: 'roam', diff: 1, car: carDesc(S.save), traffic: 10, seed: (Math.random() * 1e9) | 0, x: spawn ? spawn.x : null, y: spawn ? spawn.y : null, a: spawn ? spawn.a : 0, patrols: 0 });
    S.g.noCops = true;
    var P = S.g.player;
    ENGINE.resetCar(S.g);
    P.ai = ENGINE.mkAI('lane'); ENGINE.snapLane(P); P.ai.spd = 1;
    S.env = { rain: false, night: false, dusk: false, auto: true };
    camUpdate(0, true);
  }
  function toMenu(tab) {
    S.mode = 'menu'; S.paused = false; S.resetArm = false; S.buyArm = null;
    if (tab) S.tab = tab;
    S.snd.engineOff();
    if (!S.demo || !S.g) startDemo();
    layout();
    showCard('menu');
    kick();
  }
  function startRoam() {
    var sv = S.save, sp = sv.roam;
    if (sv.impound[sv.car]) { S.tab = 'garage'; showCard('menu'); if (Cade.showToast) Cade.showToast('That car is impounded — release it or pick another', 'info', 2200); return; }
    S.demo = false;
    S.env = envOf(null); S.env.auto = sv.set.time === 'auto';
    S.g = newGame({ mode: 'roam', diff: sv.set.diff, car: carDesc(sv), traffic: trafficCap(), seed: (Math.random() * 1e9) | 0, x: sp ? sp.x : null, y: sp ? sp.y : null, a: sp ? sp.a : 0, dmg: sp ? sp.dmg : 0, rain: S.env.rain, night: S.env.night, assist: sv.set.assist });
    if (sp) ENGINE.resetCar(S.g);
    S.ectx = null;
    beginPlay();
  }
  function openEvent(ctx) {
    S.ectx = ctx;
    if (S.mode !== 'menu') { S.demo = false; }
    showCard('pre');
  }
  function startEvent() {
    var ctx = S.ectx, sv = S.save;
    if (!ctx) return;
    if (sv.impound[sv.car]) { S.tab = 'garage'; toMenu(); if (Cade.showToast) Cade.showToast('That car is impounded — release it or pick another', 'info', 2200); return; }
    var E = ctx.E;
    S.env = envOf(E); S.env.auto = false;
    E.rain = S.env.rain; E.night = S.env.night;
    if (ctx.kind === 'roam') S.roamBack = { x: S.g.player.x, y: S.g.player.y, a: S.g.player.a, heat: S.g.heat.pts };
    S.demo = false;
    S.g = newGame({ mode: 'event', diff: sv.set.diff, car: carDesc(sv), ev: E, traffic: Math.round(trafficCap() * 0.75), seed: (E.seed * 7 + 1) >>> 0, assist: sv.set.assist });
    beginPlay();
  }
  function beginPlay() {
    S.mode = 'play'; S.paused = false; S.acc = 0; S.msg = null; S.shake = 0; S.flash = 0; S.doneT = 0; S.res = null; S.mapOn = false;
    S.keys = {}; clearHeld(); S.cashSeen = 0; S.saveT = 0; S.founts = [];
    for (var i = 0; i < S.fx.length; i++) S.fx[i].on = false;
    showCard(null);
    layout();
    camUpdate(0, true);
    S.snd.ensure(); S.snd.engineOn();
    if (S.g.mode === 'roam') say('FREE ROAM', S.g.heat.lvl ? 'Heat ' + S.g.heat.lvl : 'Find a race marker  ·  M for the map', null, 2.2);
    else say(S.g.E.name.toUpperCase(), EV_TIPS[S.g.E.type], null, 2.4);
    kick();
  }
  function pause(card) {
    if (!S || S.mode !== 'play' || S.paused) return;
    S.paused = true; clearHeld(); S.keys = {};
    S.snd.engineOff();
    stopLoop();
    showCard(card || 'pause');
    S.fdt = 0; render();
    if (card === 'map') { S.mapC = { x: S.g.player.x, y: S.g.player.y }; drawBigMap(S.ctx, S.g); }
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showCard(null);
    S.snd.ensure(); S.snd.engineOn();
    kick();
  }
  function saveRoam() {
    var g = S.g;
    if (!g || g.mode !== 'roam' || S.demo) return;
    var P = g.player;
    S.save.roam = { x: Math.round(P.x * 10) / 10, y: Math.round(P.y * 10) / 10, a: Math.round(P.a * 100) / 100, dmg: Math.round(P.dmg * 100) / 100 };
    persist();
  }
  function quitPlay() {
    S.paused = false;
    if (S.g && S.g.mode === 'roam') { saveRoam(); S.g = null; toMenu('garage'); return; }
    var ctx = S.ectx;
    S.g = null;
    if (ctx && ctx.kind === 'roam') { resumeRoam(); return; }
    toMenu(ctx && ctx.kind === 'career' ? 'career' : 'play');
  }
  function resumeRoam() {
    var rb = S.roamBack || null, sv = S.save;
    S.demo = false;
    S.env = envOf(null); S.env.auto = sv.set.time === 'auto';
    S.g = newGame({ mode: 'roam', diff: sv.set.diff, car: carDesc(sv), traffic: trafficCap(), seed: (Math.random() * 1e9) | 0, x: rb ? rb.x : null, y: rb ? rb.y : null, a: rb ? rb.a : 0, heat: rb ? rb.heat * 0.5 : 0, rain: S.env.rain, assist: sv.set.assist, dmg: sv.roam ? sv.roam.dmg : 0 });
    if (rb) ENGINE.resetCar(S.g);
    S.g.mkCool = '';
    var nn = nearNode(S.g.player.x, S.g.player.y); S.g.mkCool = nn[0] + ',' + nn[1];
    S.ectx = null;
    beginPlay();
  }
  function finishGame() {
    var g = S.g, res = g.result, ctx = S.ectx, sv = S.save, E = ctx.E, out = { res: res, cash: 0 };
    S.mode = 'over';
    S.snd.engineOff();
    clearHeld();
    if (ctx.kind === 'career') {
      var a = careerAward(sv, { key: ctx.key, boss: ctx.boss }, res, E);
      out.cash = a.cash;
      if (a.beat) { out.beat = sv.career.beaten; var unl = CARS.filter(function (c) { return c.need === sv.career.beaten; })[0]; out.unlock = unl ? unl.name : ''; }
    } else {
      out.cash = evReward(E, res);
      sv.cash += out.cash; sv.stats.races++; if (res.win) sv.stats.wins++;
      if (ctx.kind === 'daily' && (res.win || E.type === 'drift' || E.type === 'speedtrap')) {
        var sc = evScore(res);
        if (sv.daily.d !== S.today) { sv.daily.d = S.today; sv.daily.best = null; sv.daily.type = E.type; }
        if ((res.win || res.type === 'drift' || res.type === 'speedtrap') && evBetter(E.type, sc, sv.daily.best)) { sv.daily.best = sc; out.newRec = true; }
      }
    }
    // a standings table for races
    if (g.race && g.race.R && E.rivals.length) {
      var rows = g.race.racers.slice().sort(rankCmp(g)), P = g.player;
      if (E.type === 'speedtrap') rows.sort(function (x, y) { return trapTotal(g, y) - trapTotal(g, x); });
      out.rows = rows.map(function (q, i) {
        var nm = q === P ? 'You' : q.name, tm = q.rc.fin >= 0 ? fmtTime(q.rc.fin - (g.t0 || 0)) : E.type === 'speedtrap' ? fmtN(trapTotal(g, q)) : q.dead ? 'wrecked' : 'racing';
        return '<div class="' + (q === P ? 'you' : '') + '"><span>' + (i + 1) + '</span><b>' + esc(nm) + '</b><i>' + tm + '</i></div>';
      }).join('');
    }
    persist();
    S.res = out;
    if (res.win) { [523, 659, 784, 1046].forEach(function (f, j) { S.snd.tone(f, 0.2, 'triangle', 0.05, null, j * 0.11); }); }
    else { S.snd.tone(330, 0.3, 'square', 0.04, 165); }
    showCard('result');
    stopLoop();
    S.fdt = 0; render();
  }
  function afterResult() {
    var ctx = S.ectx;
    if (ctx && ctx.kind === 'roam') { resumeRoam(); return; }
    S.g = null;
    toMenu(ctx && ctx.kind === 'career' ? 'career' : 'play');
  }

  // ---- what the engine reports: sound, shake, messages, money ----
  function say(txt, sub, col, t) { S.msg = { txt: txt, sub: sub || '', col: col || null, t: t || 1.5 }; }
  function toast(txt, col) { S.toast = { txt: txt, col: col, t: 2 }; }
  function shake(v) { S.shake = Math.max(S.shake, v * (S.save.set.shake ? 1 : 0.3)); }
  function handleEvents() {
    var g = S.g, ev = g.ev, snd = S.snd, sv = S.save, H = g.heat;
    if (S.demo) { ev.length = 0; return; }
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.t) {
        case 'beep': snd.tone(523, 0.16, 'square', 0.04); break;
        case 'go': snd.tone(1046, 0.45, 'square', 0.05); break;
        case 'hit':
          shake(Math.min(1.2, e.sp / 18)); if (e.sp > 9) S.flash = Math.min(1, e.sp / 25);
          snd.hiss(0.22, Math.min(0.3, e.sp * 0.012), 320, 0.7); snd.tone(80, 0.2, 'square', Math.min(0.08, e.sp * 0.004), 45);
          burst(1, e.x, e.y, Math.min(14, 3 + e.sp * 0.5), 6 + e.sp * 0.4, 0.4, 1);
          if (e.sp > 7) burst(3, e.x, e.y, 3, 5, 0.9, 0.35, '#777');
          if (Cade.haptic) Cade.haptic(e.sp > 12 ? 40 : 15);
          break;
        case 'scrape': if (Math.random() < 0.5) burst(1, e.x, e.y, 3, 5, 0.3, 1); snd.hiss(0.1, 0.05, 2600, 2); break;
        case 'prop':
          var pc = PCOL[e.k] || '#999';
          burst(3, e.x, e.y, e.k === 'news' ? 10 : 5, 4 + e.sp * 0.3, 1.1, e.k === 'news' ? 0.4 : 0.3, e.k === 'news' ? '#eee' : pc);
          if (e.k === 'hydrant') S.founts.push({ x: e.x, y: e.y, t: 5 });
          snd.tone(e.k === 'cone' ? 520 : 180, 0.08, 'square', 0.03, e.k === 'cone' ? 300 : 90); snd.hiss(0.12, 0.08, 1200, 1);
          if (g.mode === 'roam' && e.k !== 'parked') { g.won.cash += 2; }
          break;
        case 'propx': burst(3, e.x, e.y, 3, 4, 0.9, 0.3, PCOL[e.k] || '#999'); break;
        case 'wreck':
          burst(0, e.x, e.y, 8, 4, 1.8, 1.6, 'rgb(70,70,72)'); burst(1, e.x, e.y, 12, 12, 0.6, 1);
          snd.hiss(0.6, 0.2, 200, 0.6);
          if (e.who === 'cop') { say('COP TAKEN OUT', '+' + fmtN(400 * Math.max(1, H.lvl)) + ' bounty', '#ff6a4a', 1.6); snd.tone(880, 0.12, 'triangle', 0.05); snd.tone(1320, 0.2, 'triangle', 0.05, null, 0.1); }
          break;
        case 'heat': say('HEAT ' + e.lvl, ['', '', 'More units', 'Roadblocks', 'Spike strips', 'Air support'][e.lvl] || '', '#ff6a4a', 1.6); snd.tone(440, 0.15, 'sawtooth', 0.04, 660); break;
        case 'pursuit': say('PURSUIT!', 'Lose them: break line of sight', '#ff3b3b', 2); snd.tone(660, 0.2, 'square', 0.04, 880); break;
        case 'cool': toast('Out of sight — stay hidden', '#3ecf6a'); break;
        case 'spotted': toast('Spotted!', '#ff6a4a'); snd.tone(520, 0.12, 'square', 0.04); break;
        case 'evaded':
          say('EVADED', '+' + fmtN(e.bounty) + ' bounty · +$' + fmtN(e.cash), '#3ecf6a', 3);
          [659, 784, 988].forEach(function (f, j) { snd.tone(f, 0.18, 'triangle', 0.05, null, j * 0.1); });
          sv.best.bounty = Math.max(sv.best.bounty, e.bounty); sv.best.heat = Math.max(sv.best.heat, e.lvl); sv.best.chase = Math.max(sv.best.chase, Math.round(e.time)); sv.best.cops = Math.max(sv.best.cops, e.cops);
          sv.stats.escapes++; persist();
          break;
        case 'busted':
          if (g.mode === 'roam') {
            var bz = applyBust(sv, e.fine);
            bz.bounty = e.bounty;
            S.bust = bz; persist();
            snd.tone(392, 0.3, 'square', 0.05, 196); snd.tone(294, 0.5, 'square', 0.05, 147, 0.3);
            S.wantCard = 'busted';
          }
          break;
        case 'roadblock': say('ROADBLOCK', e.spikes ? 'Spike strips in the gap!' : 'Find the gap or turn off', '#ff6a4a', 1.6); break;
        case 'spiked': say('SPIKED!', 'Tires shredded — handling and speed down', '#ff6a4a', 1.8); shake(0.6); snd.hiss(0.6, 0.25, 3000, 1.5); break;
        case 'heli': toast('Helicopter inbound', '#ff6a4a'); break;
        case 'infr': toast(e.why + '!', '#e0a030'); break;
        case 'cp':
          if (e.lap >= 0 && e.n < e.of) say('LAP ' + (e.lap + 2), '', null, 1.2);
          else if (e.n < e.of) toast('Checkpoint ' + e.n + '/' + e.of);
          snd.tone(784, 0.1, 'triangle', 0.05); snd.tone(1175, 0.16, 'triangle', 0.05, null, 0.08);
          break;
        case 'finish': say(ord(e.place) + ' PLACE', e.place === 1 ? 'Winner!' : 'Finished', e.place === 1 ? null : S.th.hudTx, 3); break;
        case 'trap': say(spdTxt(e.kmh / 3.6) + (units() === 'mph' ? ' MPH' : ' KM/H'), 'Speed camera ' + e.n + '/' + e.of, '#ff78d2', 1.2); snd.tone(1400, 0.06, 'square', 0.04); break;
        case 'drift': toast('+' + fmtN(e.pts) + ' drift' + (e.mult > 1 ? ' x' + e.mult : ''), S.th.hudAc); snd.tone(988, 0.08, 'triangle', 0.04, 1480); sv.best.drift = Math.max(sv.best.drift, e.pts); break;
        case 'driftlost': toast('Drift lost', '#ff6a4a'); break;
        case 'marker':
          if (g.mode === 'roam') {
            var mk = makeEvent(e.type, hash3(e.i, e.j, 5150) % 100000, clamp(Math.round(Math.hypot(e.i, e.j) / 6), 1, 8), { node: [e.i, e.j] });
            S.ectx = { kind: 'roam', E: mk };
            S.wantCard = 'marker';
          }
          break;
        case 'totaled': S.towFee = Math.min(sv.cash, 300); sv.cash -= S.towFee; persist(); S.wantCard = 'wrecked'; break;
        case 'done': S.doneT = 0.01; break;
      }
    }
    ev.length = 0;
    // free-roam money lands in the wallet as it is earned
    if (g.mode === 'roam' && g.won.cash > S.cashSeen) { sv.cash += g.won.cash - S.cashSeen; S.cashSeen = g.won.cash; }
  }
  // tire smoke, skid marks, nitro flames, damage smoke
  function carFx(dt) {
    var g = S.g, vb = viewBox(), cs = g.cars, rm = S.rm;
    for (var i = 0; i < cs.length; i++) {
      var o = cs[i];
      if (o.x < vb.x0 || o.x > vb.x1 || o.y < vb.y0 || o.y > vb.y1) { o.sk = null; continue; }
      var ca = Math.cos(o.a), sa = Math.sin(o.a), rx = o.x - ca * o.len * 0.32, ry = o.y - sa * o.len * 0.32, w = o.wid * 0.4;
      var lx = rx - sa * w, ly = ry + ca * w, qx = rx + sa * w, qy = ry - ca * w;
      if (o.skid && !(o.ovp >= 0 && o.lv === 1)) {
        if (o.sk) { stamp(o.sk[0], o.sk[1], lx, ly, 0.26, 'rgba(18,18,20,0.32)'); stamp(o.sk[2], o.sk[3], qx, qy, 0.26, 'rgba(18,18,20,0.32)'); }
        o.sk = [lx, ly, qx, qy];
        if (!rm && Math.random() < (o.kind === 'player' ? 0.6 : 0.25) * (g.rain ? 0.4 : 1)) fx(0, Math.random() < 0.5 ? lx : qx, Math.random() < 0.5 ? ly : qy, -o.vx * 0.1 + (Math.random() - 0.5), -o.vy * 0.1 + (Math.random() - 0.5), 1.1, 0.55, S.th.dark ? 'rgb(150,150,156)' : 'rgb(200,200,204)');
      } else o.sk = null;
      if (o.nosOn && !rm) for (var k = 0; k < 2; k++) fx(2, o.x - ca * (o.len * 0.52) + (Math.random() - 0.5) * 0.5, o.y - sa * (o.len * 0.52) + (Math.random() - 0.5) * 0.5, -ca * 14 - o.vx * -0.6 + o.vx, -sa * 14 + o.vy * 0.4, 0.22, 0.38);
      if ((o.dmg > 0.6 || o.dead) && Math.random() < (o.dead ? 0.4 : (o.dmg - 0.5))) fx(0, o.x + ca * o.len * 0.3, o.y + sa * o.len * 0.3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 1.6, o.dead ? 1.1 : 0.6, 'rgb(60,60,62)');
      if (o.spiked > 0 && Math.hypot(o.vx, o.vy) > 6 && Math.random() < 0.5) fx(1, lx, ly, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.25, 1);
      if (g.rain && Math.hypot(o.vx, o.vy) > 14 && Math.random() < 0.3 && !rm) fx(4, qx, qy, -o.vx * 0.2, -o.vy * 0.2, 0.5, 0.35);
    }
    for (var f = S.founts.length - 1; f >= 0; f--) {
      var ft = S.founts[f];
      ft.t -= dt;
      if (ft.t <= 0) { S.founts.splice(f, 1); continue; }
      if (!rm) for (var q = 0; q < 2; q++) { var an = Math.random() * TAU; fx(4, ft.x, ft.y, Math.cos(an) * 4, Math.sin(an) * 4, 0.8, 0.4); }
    }
  }

  // ---- the floating thumb stick (same in Apex Rush, Street Heat and Redline Run) ----
  // Touch anywhere in the zone: the ring centers under the thumb and the knob follows
  // it, up to the ring's radius. The knob's sideways offset, shaped by
  // ENGINE.stickCurve, is analog steering in -1..1. One thumb owns it (by pointerId),
  // so the pedals keep working under the other; it springs back on release, cancel,
  // lost capture, blur and when the page hides (clearHeld).
  function mkStick(zone, onDown) {
    var base = zone.querySelector('.sh-sbase'), knob = zone.querySelector('.sh-sknob');
    var k = { id: null, v: 0, ox: 0, oy: 0, R: 38 };
    function paint(dx, dy) {
      knob.style.transform = dx || dy ? 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)' : '';
      base.style.setProperty('--kl', k.v < 0 ? Math.min(1, 0.25 - k.v).toFixed(2) : '0');
      base.style.setProperty('--kr', k.v > 0 ? Math.min(1, 0.25 + k.v).toFixed(2) : '0');
      zone.classList.toggle('sl', k.v < 0); zone.classList.toggle('sr', k.v > 0);
    }
    function move(e) {
      var dx = e.clientX - k.ox, dy = e.clientY - k.oy, d = Math.sqrt(dx * dx + dy * dy), m = d > k.R ? k.R / d : 1;
      k.v = ENGINE.stickCurve(Math.max(-1, Math.min(1, dx / k.R)));
      paint(dx * m, dy * m);
    }
    k.reset = function () {
      var id = k.id;
      k.id = null; k.v = 0;
      if (id !== null) { try { zone.releasePointerCapture(id); } catch (x) {} }
      zone.classList.remove('on'); base.style.left = ''; base.style.top = ''; paint(0, 0);
    };
    zone.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (k.id !== null || (onDown && onDown(e) === false)) return;
      var r = zone.getBoundingClientRect();
      k.R = Math.max(24, (base.offsetWidth || 76) / 2);
      k.id = e.pointerId; k.ox = e.clientX; k.oy = e.clientY;
      try { zone.setPointerCapture(e.pointerId); } catch (x) {}
      base.style.left = Math.round(e.clientX - r.left) + 'px'; base.style.top = Math.round(e.clientY - r.top) + 'px';
      zone.classList.add('on'); move(e);
    });
    zone.addEventListener('pointermove', function (e) { if (e.pointerId === k.id) { e.preventDefault(); move(e); } });
    function up(e) { if (e.pointerId === k.id) k.reset(); }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { zone.addEventListener(t, up); });
    return k;
  }

  // ---- input ----
  function clearHeld() {
    if (!S) return;
    S.hold = { l: 0, r: 0, g: 0, b: 0, d: 0, n: 0 };
    if (S.pad) Array.prototype.forEach.call(S.pad.querySelectorAll('[data-hold].on'), function (b) { b.classList.remove('on'); });
    if (S.stk) S.stk.reset();
  }
  function input(dt) {
    var k = S.keys, h = S.hold, gp = S.gpIn || {}, st = 0;
    if (k.ArrowLeft || k.KeyA || h.l) st -= 1;
    if (k.ArrowRight || k.KeyD || h.r) st += 1;
    var rate = st === 0 ? 10 : sgn(st) !== sgn(S.steerV) ? 14 : 6.5;
    S.steerV += clamp(st - S.steerV, -rate * dt, rate * dt);
    var steer = S.steerV;
    if (S.stk && S.stk.id !== null && S.save.set.touch === 'stick') steer = S.stk.v;   // analog thumb stick
    if (gp.steer) steer = gp.steer;
    var gas = !!(k.ArrowUp || k.KeyW || h.g || gp.gas), brake = !!(k.ArrowDown || k.KeyS || h.b || gp.brake);
    if (!gas && !brake && autoGas() && S.touchUsed) gas = true;
    return { steer: steer, gas: gas ? 1 : 0, brake: brake ? 1 : 0, hb: !!(k.Space || h.d || gp.hb), nos: !!(k.ShiftLeft || k.ShiftRight || k.KeyN || h.n || gp.nos) };
  }
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', shift: 'ShiftLeft' };
  function keyCode(e) {
    if (e.code) return e.code;
    var k = (e.key || '').toLowerCase();
    if (KEY2CODE[k]) return KEY2CODE[k];
    return /^[a-z]$/.test(k) ? 'Key' + k.toUpperCase() : '';
  }
  var DRIVE_KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, KeyA: 1, KeyD: 1, KeyW: 1, KeyS: 1, Space: 1, ShiftLeft: 1, ShiftRight: 1, KeyN: 1 };
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
      else if (S.paused && (S.card === 'pause' || S.card === 'map')) resume();
      else if (code === 'Escape') {
        if (S.card === 'help') closeHelp();
        else if (S.card === 'pre') { if (S.mode === 'menu') showCard('menu'); }
        else if (S.card === 'menu' && S.tab !== 'play') { S.tab = 'play'; showCard('menu'); }
        else if (S.card === 'menu') closePanel();
      }
      return;
    }
    if (code === 'KeyM') { e.preventDefault(); if (e.repeat) return; toggleMap(); return; }
    if (code === 'KeyC') { e.preventDefault(); if (!e.repeat) toggleCam(); return; }
    if (S.mode === 'play' && !S.paused) {
      if (code === 'KeyR') { e.preventDefault(); if (!e.repeat) resetCarCmd(); return; }
      if (DRIVE_KEYS[code]) { e.preventDefault(); S.keys[code] = true; S.touchUsed = false; }
      return;
    }
    if (S.card === 'map' && (code === 'Equal' || code === 'Minus')) { e.preventDefault(); zoomMap(code === 'Equal' ? 0.7 : 1.4); return; }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (e.repeat) return;
      var b = S.ovl.querySelector('[data-primary]');
      if (b && !b.disabled) b.click();
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; }
  function toggleCam() {
    S.save.set.cam = S.save.set.cam === 'rotate' ? 'north' : 'rotate';
    persist(); syncHead();
    toast('Camera: ' + (S.save.set.cam === 'rotate' ? 'turns with the car' : 'north up'));
    if (S.card === 'menu' && S.tab === 'settings') showCard('menu');
    if (!S.raf && S.g) { camUpdate(0, true); S.fdt = 0; render(); if (S.card === 'map') drawBigMap(S.ctx, S.g); }
  }
  function toggleMap() {
    if (!S.g || S.mode !== 'play') return;
    if (S.card === 'map') { resume(); return; }
    if (!S.paused) { S.bigR = 600; pause('map'); }
  }
  function zoomMap(k) { S.bigR = clamp(S.bigR * k, 200, 2400); S.fdt = 0; render(); drawBigMap(S.ctx, S.g); }
  function resetCarCmd() {
    var g = S.g;
    if (!g || g.heat.st !== 'none' || g.phase === 'count') { toast('Not during a pursuit'); return; }
    ENGINE.resetCar(g); camUpdate(0, true);
    toast('Back on the road');
  }
  function closeHelp() { S.firstRun = false; if (S.paused) showCard('pause'); else showCard('menu'); }

  // gamepad: stick steers, RT/A gas, LT/B brake, X handbrake, RB/LB nitro, Y camera, Back map, Start pause
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
    var ax = p.axes[0] || 0, st = Math.abs(ax) > 0.12 ? ax : 0;
    if (btnV(p, 14) > 0.5) st = -1; if (btnV(p, 15) > 0.5) st = 1;
    S.gpIn = { steer: st, gas: btnV(p, 7) > 0.2 || btnV(p, 0) > 0.5, brake: btnV(p, 6) > 0.2 || btnV(p, 1) > 0.5, hb: btnV(p, 2) > 0.5, nos: btnV(p, 5) > 0.5 || btnV(p, 4) > 0.5 };
    var start = btnV(p, 9) > 0.5, y = btnV(p, 3) > 0.5, a = btnV(p, 0) > 0.5, back = btnV(p, 8) > 0.5;
    if (start && !gp.st) { if (S.mode === 'play' && !S.paused) pause(); else if (S.paused) resume(); }
    if (y && !gp.y) toggleCam();
    if (back && !gp.bk) toggleMap();
    if (a && !gp.a && S.mode !== 'play') { var b = S.ovl.querySelector('[data-primary]'); if (b && !b.disabled) b.click(); }
    gp.st = start; gp.y = y; gp.a = a; gp.bk = back;
  }

  // ---- loop ----
  function running() { return !!S && !!S.g && (S.mode === 'play' || (S.mode === 'menu' && S.demo)) && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function envUpdate(dt) {
    var env = S.env || {}, g = S.g, nk;
    if (env.auto && g.mode === 'roam') {
      S.clock = (S.clock + dt) % 420;
      var u = S.clock / 420;       // day, dusk, night, dawn
      nk = u < 0.5 ? 0 : u < 0.58 ? (u - 0.5) / 0.08 : u < 0.9 ? 1 : 1 - (u - 0.9) / 0.1;
      S.dusk = u > 0.48 && u < 0.6 && nk < 0.6;
    } else { nk = env.night ? 1 : env.dusk ? 0.55 : 0; S.dusk = !!env.dusk; }
    S.nightK += (nk - S.nightK) * Math.min(1, dt * 2);
    g.night = S.nightK > 0.5;
  }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60, g = S.g;
    S.last = ts; S.fdt = dt; S.animT += dt;
    pollPad();
    if (!running()) return;
    var inp;
    if (S.demo) { ENGINE.laneAI(g, g.player, dt, 15, true); var k = g.player.ctl; inp = { steer: k.steer, gas: k.gas, brake: k.brake, hb: 0, nos: 0 }; }
    else inp = input(dt);
    S.acc = Math.min((S.acc || 0) + dt, 0.1);
    while (S.acc >= STEP) {
      step(g, inp, STEP);
      S.acc -= STEP;
      if (g.done || g.busted) break;
    }
    handleEvents();
    envUpdate(dt);
    camUpdate(dt);
    carFx(dt);
    stepFx(dt);
    if (!S.demo) {
      var P = g.player, sp = Math.hypot(P.vx, P.vy), gear = sp / Math.max(20, P.st.top) * 5, rpm = P.vf < -0.5 ? Math.min(1, -P.vf / 10) : clamp((gear % 1) * 0.75 + Math.min(1, gear / 5) * 0.25, 0, 1);
      var siren = 0;
      if (g.heat.st !== 'none') { var nd = 1e9; for (var i = 0; i < g.cars.length; i++) { var o = g.cars[i]; if (o.kind === 'cop' && !o.dead) nd = Math.min(nd, Math.hypot(o.x - P.x, o.y - P.y)); } siren = clamp(1 - nd / 140, 0.15, 1); }
      S.snd.engineSet(rpm, inp.gas ? 1 : 0.2, P.nosOn, P.skid ? Math.min(1, P.slip / 8 + 0.3) : 0, siren, S.animT);
      S.saveT += dt;
      if (S.saveT > 4 && g.mode === 'roam') { S.saveT = 0; saveRoam(); }
    }
    var shk = S.shake;
    S.shakeV.x = shk > 0.01 ? (Math.random() - 0.5) * shk * 10 : 0; S.shakeV.y = shk > 0.01 ? (Math.random() - 0.5) * shk * 10 : 0;
    S.shake = Math.max(0, shk - dt * 2.2);
    render();
    if (S.wantCard) { var wc = S.wantCard; S.wantCard = null; pause(wc); return; }
    if (S.doneT > 0) { S.doneT += dt; if (S.doneT > 1.4) { S.doneT = 0; finishGame(); return; } }
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
    S.panel.classList.toggle('sh-side', side);
    S.pad.classList.toggle('on', padOn);
    S.pad.classList.toggle('stick', S.save.set.touch === 'stick');
    S.pad.classList.toggle('auto', autoGas());
    var gut = side ? (solo ? 24 : 40) : phone ? (solo ? 20 : 34) : 48, padW = side ? 2 * 132 : 0;
    var W = Math.floor(Math.min(vw - gut - padW, solo ? 1100 : 780)), ch = chromeH(), ah = Math.floor(Math.max(side ? 150 : 200, availH(vw, vh, ch))), H;
    if (side) { H = ah; W = Math.min(W, Math.round(H * 2)); }
    else if (W < 560) H = Math.min(ah, Math.round(W * 1.3));
    else H = Math.min(ah, Math.round(W * 0.66));
    H = Math.max(H, Math.min(ah, 220));
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (W * H * dpr * dpr > 1600000) dpr = Math.max(1, Math.sqrt(1600000 / (W * H)));
    if (W !== S.W || H !== S.H || dpr !== S.dk) {
      S.W = W; S.H = H; S.dk = dpr;
      S.cv.style.width = W + 'px'; S.cv.style.height = H + 'px';
      S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
      S.panel.style.setProperty('--sh-w', W + 'px');
      S.cv.width = Math.round(W * dpr); S.cv.height = Math.round(H * dpr);
      S.lcs = 0.5;
      S.lcv.width = Math.ceil(W * S.lcs); S.lcv.height = Math.ceil(H * S.lcs);
      var zb = clamp(Math.min(W, H * 1.15) / 48, 5, 8.5), sk = clamp(Math.round(zb * dpr * 1.1), 6, 22), cr = clamp(Math.round(zb * dpr * 0.55), 3, 5);
      if (sk !== S.sprK) { S.sprK = sk; S.spr = {}; }
      if (cr !== S.cres) { S.cres = cr; S.chunks.forEach(function (c) { c.dirty = true; }); }
      S.zBase = zb;
      S.rainN = Math.round(W * H / 3000);
    }
    S.lay = { vw: vw, vh: vh, chrome: ch, side: side };
    if (!S.raf && S.g) { S.fdt = 0; render(); if (S.card === 'map') drawBigMap(S.ctx, S.g); }
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) layout();
  }
  function syncHead() {
    if (!S) return;
    var hb = S.head, pb = hb.querySelector('[data-h="pause"]'), sb = hb.querySelector('[data-h="sound"]'), cb = hb.querySelector('[data-h="cam"]'), mb = hb.querySelector('[data-h="map"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.mode !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)'; pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off'; sb.setAttribute('aria-label', sb.title); sb.classList.toggle('on', S.snd.on);
    cb.innerHTML = IC_CAM; cb.title = 'Camera: ' + (S.save.set.cam === 'rotate' ? 'turns with the car' : 'north up') + ' (C)'; cb.setAttribute('aria-label', cb.title);
    mb.innerHTML = IC_MAP; mb.title = 'Map (M)'; mb.setAttribute('aria-label', mb.title); mb.disabled = S.mode !== 'play'; mb.classList.toggle('on', S.card === 'map');
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    try { saveRoam(); } catch (e) {}
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
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPadC);
    if (s.ro) s.ro.disconnect();
    if (s.themeObs) s.themeObs.disconnect();
    try { sset(SAVE_KEY, JSON.stringify(s.save)); } catch (e) {}
    s.snd.close();
    function free(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
    s.chunks.forEach(function (c) { free(c.cv); });
    for (var k in s.spr) { var v = s.spr[k]; free(v && v.cv ? v.cv : v); }
    free(s.lcv); free(s.cv);
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
    var body = '<div class="sh"><div class="sh-stage"><canvas class="sh-cv"></canvas><div class="sh-ovl" style="display:none"></div></div>' +
      '<div class="sh-pad"><div class="sh-pl"><button type="button" data-hold="l" aria-label="Steer left">◀</button><button type="button" data-hold="r" aria-label="Steer right">▶</button>' +
      '<div class="sh-stick" aria-label="Steering stick: drag left or right"><span class="sh-sbase"><em>◀</em><em>▶</em><i class="sh-sknob"></i></span></div></div>' +
      '<div class="sh-pr"><button type="button" data-hold="n" class="nos" aria-label="Nitro">NOS</button><button type="button" data-hold="d" class="drf" aria-label="Handbrake drift">DRIFT</button><button type="button" data-hold="b" class="brk" aria-label="Brake">BRK</button><button type="button" data-hold="g" class="gas" aria-label="Gas">GAS</button></div></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\u{1F693} Street Heat', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'sh-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="map"></button><button type="button" data-h="cam"></button><button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia, coarse = !!(mm && mm('(pointer: coarse)').matches);
    S = {
      panel: p, head: hb, stage: p.querySelector('.sh-stage'), cv: p.querySelector('.sh-cv'), ovl: p.querySelector('.sh-ovl'), pad: p.querySelector('.sh-pad'),
      save: ld.save, firstRun: ld.fresh, snd: new Snd(sget(SOUND_KEY) !== '0'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: coarse,
      mode: 'menu', card: null, tab: 'play', g: null, demo: false, paused: false, raf: 0, last: 0, animT: 0, acc: 0, fdt: 0, frameN: 0, genLeft: 0,
      keys: {}, hold: {}, stk: null, steerV: 0, gp: {}, gpIn: null, touchUsed: false,
      W: 0, H: 0, dk: 1, zBase: 7, sprK: 10, cres: 4, chunks: new Map(), chunkMax: coarse ? 12 : 16, spr: {}, fxMax: coarse ? 170 : 260,
      cam: { x: 0, y: 0, a: 0, z: 7 }, shake: 0, shakeV: { x: 0, y: 0 }, flash: 0, msg: null, toast: null, tags: [], founts: [],
      nightK: 0, dusk: false, clock: 60 + Math.random() * 120, env: null, ectx: null, res: null, bust: null, doneT: 0, wantCard: null, bigR: 600, mapC: { x: 0, y: 0 },
      today: dailyKey(new Date()), resetArm: false, buyArm: null, cashSeen: 0, saveT: 0
    };
    S.dailyE = dailyEvent(S.today);
    S.lcv = document.createElement('canvas'); S.lcx = S.lcv.getContext('2d');
    makeFx(); clearHeld();
    S.ctx = S.cv.getContext('2d', { alpha: false }) || S.cv.getContext('2d');
    p._onClose = teardown;
    readTheme();

    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); clearHeld(); stopLoop(); S.snd.engineOff(); } else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearHeld(); S.keys = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); clearHeld(); stopLoop(); S.snd.engineOff(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () { if (!S || S.panel !== p) return; if (S.themeDirty) { S.themeDirty = false; readTheme(); } layout(); kick(); });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try { S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); }); S.ro.observe(S.pad); } catch (e) {}
    S.onPadC = function () { if (S && !S.gpT) S.gpT = setInterval(function () { if (S && !S.raf) pollPad(); }, 100); };
    window.addEventListener('gamepadconnected', S.onPadC);
    if (readPad()) S.onPadC();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); if (S.card && S.card !== 'map') showCard(S.card);
        if (!S.raf && S.g) { S.fdt = 0; render(); if (S.card === 'map') drawBigMap(S.ctx, S.g); }
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
      else if (h === 'map') toggleMap();
      else if (h === 'help') {
        if (S.mode === 'play' && !S.paused) pause();
        if (S.card === 'help') closeHelp();
        else if (S.mode === 'menu' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // no zoom / select / callouts on the play surface
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) { ['touchstart', 'touchmove', 'touchend'].forEach(function (t) { el.addEventListener(t, noTouch, { passive: false }); }); el.addEventListener('contextmenu', noTouch); });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.cv.addEventListener('pointerdown', function (e) { if (!S) return; e.preventDefault(); S.snd.ensure(); if (e.pointerType === 'touch') S.touchUsed = true; });
    // the thumb stick (left zone of the pad)
    S.stk = mkStick(S.pad.querySelector('.sh-stick'), function () {
      if (!S) return false;
      S.snd.ensure(); S.touchUsed = true;
    });
    // the pad: held buttons
    S.pad.addEventListener('pointerdown', function (e) {
      if (!S) return;
      e.preventDefault();
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b) return;
      S.snd.ensure(); S.touchUsed = true;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.hold[b.getAttribute('data-hold')] = 1; b.classList.add('on');
    });
    function padUp(e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b) return;
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
        evk = b.getAttribute('data-ev'), buy = b.getAttribute('data-buy'), paint = b.getAttribute('data-paint'), car = b.getAttribute('data-car');
      S.snd.tone(988, 0.04, 'sine', 0.025);
      if (tab) { S.tab = tab; S.resetArm = false; S.buyArm = null; showCard('menu'); refocus(e, '[data-tab="' + tab + '"]'); return; }
      if (df != null) { sv.set.diff = +df; persist(); showCard('menu'); refocus(e, '[data-diff="' + df + '"]'); return; }
      if (st) {
        var kv = st.split(':'), key = kv[0], val = kv[1];
        if (key === 'assist' || key === 'shake') val = +val; else if (key === 'autogas') val = val === 'on';
        sv.set[key] = val; persist(); syncHead();
        showCard('menu'); refocus(e, '[data-set="' + st + '"]');
        layout();
        return;
      }
      if (evk != null) {
        var cn = careerNext(sv), ce = cn && cn.events[+evk];
        if (!ce) return;
        openEvent({ kind: 'career', key: ce.key, boss: ce.boss, E: makeEvent(ce.type, ce.seed, ce.tier, ce.boss != null ? { boss: ce.boss } : null) });
        return;
      }
      if (buy) { if (buyUpg(sv, buy)) { persist(); S.snd.tone(660, 0.08, 'triangle', 0.05); S.snd.tone(990, 0.12, 'triangle', 0.05, null, 0.08); } showCard('menu'); refocus(e, '[data-buy="' + buy + '"]'); return; }
      if (paint != null) { if (buyPaint(sv, +paint)) { persist(); S.spr = {}; } showCard('menu'); refocus(e, '[data-paint="' + paint + '"]'); return; }
      if (car) {
        if (sv.impound[car]) { if (ENGINE.release(sv, car)) { persist(); S.snd.tone(660, 0.1, 'triangle', 0.05); } else toastC('Release costs $' + fmtN(releaseCost(car))); }
        else if (sv.cars.indexOf(car) >= 0) { sv.car = car; persist(); }
        else if (S.buyArm === car) { if (buyCar(sv, car)) { persist(); S.snd.tone(660, 0.08, 'triangle', 0.05); S.snd.tone(1320, 0.2, 'triangle', 0.05, null, 0.1); } else toastC('Not enough cash'); S.buyArm = null; }
        else S.buyArm = car;
        if (S.demo) { startDemo(); }
        showCard('menu'); refocus(e, '[data-car="' + car + '"]');
        return;
      }
      switch (a) {
        case 'roam': startRoam(); break;
        case 'daily': openEvent({ kind: 'daily', E: dailyEvent(S.today) }); break;
        case 'pre-back': showCard('menu'); break;
        case 'start-ev': S.paused = false; startEvent(); break;
        case 'mk-no': resume(); break;
        case 'help': showCard('help'); break;
        case 'close-help': closeHelp(); break;
        case 'resume': resume(); break;
        case 'map': S.bigR = 600; showCard('map'); S.mapC = { x: S.g.player.x, y: S.g.player.y }; drawBigMap(S.ctx, S.g); break;
        case 'map-close': resume(); break;
        case 'zoom-in': zoomMap(0.7); break;
        case 'zoom-out': zoomMap(1.4); break;
        case 'reset-car': resume(); resetCarCmd(); break;
        case 'repair': { var rc = repairCost(); if (sv.cash >= rc) { sv.cash -= rc; S.g.player.dmg = 0; saveRoam(); S.snd.tone(660, 0.1, 'triangle', 0.05); } showCard('pause'); break; }
        case 'repair-g': { var rc2 = Math.round(sv.roam.dmg * 900 / 10) * 10; if (sv.cash >= rc2) { sv.cash -= rc2; sv.roam.dmg = 0; persist(); } showCard('menu'); break; }
        case 'restart': S.paused = false; startEvent(); break;
        case 'quit': quitPlay(); break;
        case 'retry': startEvent(); break;
        case 'after': afterResult(); break;
        case 'cont': S.msg = null; ENGINE.resetPursuit(S.g); S.g.player.dmg = Math.min(S.g.player.dmg, 0.6); if (S.bust && S.bust.impound) { var cur = S.g.player; S.g = newGame({ mode: 'roam', diff: sv.set.diff, car: carDesc(sv), traffic: trafficCap(), seed: (Math.random() * 1e9) | 0, x: cur.x, y: cur.y, a: cur.a, rain: S.env.rain, assist: sv.set.assist }); ENGINE.resetCar(S.g); } camUpdate(0, true); saveRoam(); resume(); break;
        case 'cont-wreck': S.g.player.dmg = 0; S.g.wrecked = false; ENGINE.resetPursuit(S.g); camUpdate(0, true); saveRoam(); resume(); break;
        case 'reset': S.resetArm = true; showCard('menu'); break;
        case 'reset-no': S.resetArm = false; showCard('menu'); break;
        case 'reset-yes': { var keep = sv.set; S.save = newSave(); S.save.set = keep; S.resetArm = false; persist(); if (Cade.showToast) Cade.showToast('Progress reset', 'info', 1600); startDemo(); showCard('menu'); break; }
      }
    });
    function toastC(t) { if (Cade.showToast) Cade.showToast(t, 'info', 1600); }
    function refocus(e, sel) {
      if (e.detail !== 0) return;
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
    description: 'Top-down street racing — drift a generated city, outrun police pursuits, win races and build your garage',
    icon: '\u{1F693}',
    tags: 'game,arcade,racing,driving,car,top down,police,chase,drift,career,endless,fun',
    open: open,
    _engine: ENGINE
  });
})();
