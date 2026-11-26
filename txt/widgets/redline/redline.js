/* Redline Run — an original third-person 3D street racer for Cade.txt.
 * Each city is generated from a seed: a ring avenue and three cross-town
 * roads (one a six-lane highway) are Catmull-Rom splines resampled every
 * 4 m; where they meet they form a graph of junctions and edges. A height
 * field gives gentle hills (and a hillside district), a river cuts across
 * town (the roads bridge it), and districts (downtown towers, suburbs with
 * hedges, an industrial strip, a riverside park, pine hills) decide what is
 * built along the sidewalks. Races run on routes found in the graph:
 * circuits (the ring, or a chord plus half the ring) and point-to-point
 * sprints; side streets are barriered off. Rivals drive a racing line with
 * a curvature speed profile and dodge traffic; traffic keeps its lanes;
 * police chase over the graph, ram, set roadblocks, and a heat level (1-5)
 * rises while they keep you in sight. Break line of sight to fill the evade
 * meter; stop next to a cruiser and the BUSTED meter fills.
 * The player's car is an arcade model: grip/slip, handbrake drifts,
 * nitro, damage, wall and car collisions. Modes: Quick Race, Career (a
 * ladder of rivals, cash for cars, upgrades and paint), Free Drive (roam,
 * race markers, pursuits) and a seeded Daily event.
 * The engine below is pure JS (node-tested); three.js (vendored, loaded on
 * first open) only renders. Storage: cade-redline-*. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM, no three — unit-checked in node) =================
  // Meters, seconds. +y is up; a heading a points along (sin a, cos a) in x/z and
  // the driver's right is (-cos a, sin a). Path lateral offsets are positive to the right.
  var STEP = 1 / 60, SAMP = 4, LANE = 3.6, SIDE = 3.4, TAU = Math.PI * 2, GRID = 32;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ h >>> 15, 0x85ebca6b); h = Math.imul(h ^ h >>> 13, 0xc2b2ae35);
    return (h ^ h >>> 16) >>> 0;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sgn(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }
  function wrapA(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function rr(r, a, b) { return a + (b - a) * r(); }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }

  var DISTRICTS = [
    { id: 'downtown', name: 'Downtown' }, { id: 'suburb', name: 'Old Suburbs' }, { id: 'industrial', name: 'Dockside Yards' },
    { id: 'park', name: 'Riverside Park' }, { id: 'hills', name: 'Pine Hills' }
  ];
  var CITY_A = ['Ash', 'Bay', 'Cal', 'Dun', 'Elm', 'Fair', 'Glen', 'Hart', 'Iver', 'Kings', 'Lake', 'Mar', 'Nor', 'Oak', 'Red', 'Stone', 'West', 'Cor'];
  var CITY_B = ['ford', 'haven', 'ridge', 'port', 'view', 'field', 'wood', 'crest', 'dale', 'mouth', 'ton', 'bridge'];
  function cityName(seed) { var r = mulberry32(seed ^ 0x51ed); return pick(r, CITY_A) + pick(r, CITY_B); }

  // ---- terrain ----
  function makeHeight(seed, hill) {
    var r = mulberry32((seed ^ 0x9e3779b9) >>> 0), p = [r() * TAU, r() * TAU, r() * TAU, r() * TAU];
    return function (x, z) {
      var y = 6.5 * Math.sin(x * 0.0052 + p[0]) * Math.cos(z * 0.0047 + p[1]) + 3.2 * Math.sin((x + z) * 0.0093 + p[2]) + 1.3 * Math.sin(x * 0.019 - z * 0.016 + p[3]);
      var dx = x - hill.x, dz = z - hill.z;
      return y + hill.a * Math.exp(-(dx * dx + dz * dz) / (hill.r * hill.r));
    };
  }

  // ---- splines and paths ----
  function catmull(pts, closed, per) {
    var out = [], n = pts.length, segs = closed ? n : n - 1;
    for (var i = 0; i < segs; i++) {
      var p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
      for (var k = 0; k < per; k++) {
        var t = k / per, t2 = t * t, t3 = t2 * t, o = [];
        for (var c = 0; c < 2; c++) o.push(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
        for (var e = 2; e < p1.length; e++) o.push(t < 0.5 ? p1[e] : p2[e]);
        out.push(o);
      }
    }
    if (!closed) out.push(pts[n - 1].slice());
    return out;
  }
  function ix(P, i) { var n = P.n; return P.closed ? ((i % n) + n) % n : (i < 0 ? 0 : i >= n ? n - 1 : i); }
  // pts: [[x, z, hw?, lanes?], ...] — resampled every ~SAMP meters
  function makePath(pts, closed, H, o) {
    var n0 = pts.length, cnt = closed ? n0 : n0 - 1, seg = [], L = 0, i;
    for (i = 0; i < cnt; i++) { var a = pts[i], b = pts[(i + 1) % n0], d = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(d); L += d; }
    var n = Math.max(2, Math.round(L / SAMP)), step = L / n, N = closed ? n : n + 1;
    var P = {
      id: o.id || 0, kind: o.kind || 'st', closed: !!closed, n: N, step: step, len: closed ? L : n * step,
      x: new Float32Array(N), z: new Float32Array(N), y: new Float32Array(N), tx: new Float32Array(N), tz: new Float32Array(N),
      k: new Float32Array(N), hw: new Float32Array(N), lanes: new Uint8Array(N), src: o.src ? new Int16Array(N) : null, zones: [], stops: []
    };
    var j = 0, acc = 0;
    for (var k = 0; k < N; k++) {
      var s = k * step;
      while (j < cnt - 1 && acc + seg[j] < s) { acc += seg[j]; j++; }
      var A = pts[j], B = pts[(j + 1) % n0], t = seg[j] ? clamp((s - acc) / seg[j], 0, 1) : 0, near = t < 0.5 ? A : B;
      P.x[k] = A[0] + (B[0] - A[0]) * t; P.z[k] = A[1] + (B[1] - A[1]) * t;
      P.hw[k] = near.length > 2 ? near[2] : o.hw;
      P.lanes[k] = near.length > 3 ? near[3] : o.lanes;
      if (P.src) P.src[k] = near.length > 4 ? near[4] : -1;
    }
    frames(P, H);
    return P;
  }
  function frames(P, H) {
    var n = P.n, ang = new Float32Array(n), i;
    for (i = 0; i < n; i++) {
      var a = ix(P, i - 2), b = ix(P, i + 2), dx = P.x[b] - P.x[a], dz = P.z[b] - P.z[a], l = Math.hypot(dx, dz) || 1;
      P.tx[i] = dx / l; P.tz[i] = dz / l; P.y[i] = H(P.x[i], P.z[i]); ang[i] = Math.atan2(P.tx[i], P.tz[i]);
    }
    for (i = 0; i < n; i++) {
      var i0 = ix(P, i - 3), i1 = ix(P, i + 3), span = P.closed ? 6 : (i1 - i0);
      P.k[i] = span > 0 ? wrapA(ang[i1] - ang[i0]) / (span * P.step) : 0;
    }
  }
  function wrapS(P, s) { if (!P.closed) return clamp(s, 0, P.len); s %= P.len; return s < 0 ? s + P.len : s; }
  function dS(P, a, b) { var d = b - a; if (P.closed) { d %= P.len; if (d > P.len / 2) d -= P.len; else if (d < -P.len / 2) d += P.len; } return d; }
  function pathAt(P, s, o) {
    o = o || {};
    var f = s / P.step, n = P.n;
    if (P.closed) { f %= n; if (f < 0) f += n; } else f = clamp(f, 0, n - 1);
    var i = Math.floor(f), t = f - i;
    if (!P.closed && i >= n - 1) { i = n - 2; t = 1; }
    var j = P.closed ? (i + 1) % n : i + 1;
    o.x = P.x[i] + (P.x[j] - P.x[i]) * t; o.z = P.z[i] + (P.z[j] - P.z[i]) * t; o.y = P.y[i] + (P.y[j] - P.y[i]) * t;
    var tx = P.tx[i] + (P.tx[j] - P.tx[i]) * t, tz = P.tz[i] + (P.tz[j] - P.tz[i]) * t, l = Math.hypot(tx, tz) || 1;
    o.tx = tx / l; o.tz = tz / l; o.hw = t < 0.5 ? P.hw[i] : P.hw[j]; o.k = P.k[i]; o.i = t < 0.5 ? i : j; o.lanes = P.lanes[o.i];
    return o;
  }

  // ---- spatial index over path samples ----
  function cellKey(cx, cz) { return (cx + 2048) * 4096 + (cz + 2048); }
  function makeGrid(paths, masks) {
    var cells = new Map();
    for (var p = 0; p < paths.length; p++) {
      var P = paths[p], m = masks ? masks[p] : null;
      if (masks && !m) continue;
      for (var i = 0; i < P.n; i++) {
        if (m && !m[i]) continue;
        var key = cellKey(Math.floor(P.x[i] / GRID), Math.floor(P.z[i] / GRID)), c = cells.get(key);
        if (!c) { c = []; cells.set(key, c); }
        c.push(p, i);
      }
    }
    return { cells: cells, paths: paths, bd: new Float64Array(paths.length), bi: new Int32Array(paths.length), touch: [] };
  }
  // nearest corridor: the path whose sidewalk edge is least exceeded. null when nothing is within ~32 m.
  function query(G, x, z, out) {
    var cx = Math.floor(x / GRID), cz = Math.floor(z / GRID), touch = G.touch, bd = G.bd, bi = G.bi, k, t;
    touch.length = 0;
    for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
      var c = G.cells.get(cellKey(cx + a, cz + b));
      if (!c) continue;
      for (k = 0; k < c.length; k += 2) {
        var p = c[k], i = c[k + 1], P = G.paths[p], dx = P.x[i] - x, dz = P.z[i] - z, d = dx * dx + dz * dz;
        if (touch.indexOf(p) < 0) { touch.push(p); bd[p] = Infinity; }
        if (d < bd[p]) { bd[p] = d; bi[p] = i; }
      }
    }
    if (!touch.length) return null;
    out = out || {};
    var best = Infinity;
    for (t = 0; t < touch.length; t++) {
      var pi = touch[t], Q = G.paths[pi], i0 = bi[pi];
      for (var side = -1; side <= 0; side++) {
        var ia = i0 + side, ib = ia + 1;
        if (!Q.closed && (ia < 0 || ib >= Q.n)) continue;
        ia = ix(Q, ia); ib = ix(Q, ib);
        var ax = Q.x[ia], az = Q.z[ia], sx = Q.x[ib] - ax, sz = Q.z[ib] - az, l2 = sx * sx + sz * sz || 1;
        var u = clamp(((x - ax) * sx + (z - az) * sz) / l2, 0, 1), px = ax + sx * u, pz = az + sz * u, ll = Math.sqrt(l2);
        var tx = sx / ll, tz = sz / ll, lat = (x - px) * -tz + (z - pz) * tx, hw = Q.hw[u < 0.5 ? ia : ib], ex = Math.abs(lat) - (hw + SIDE);
        var dd = Math.hypot(x - px, z - pz);
        if (ex < best - 1e-6) {
          best = ex;
          out.p = pi; out.s = (ia + u) * Q.step; out.lat = lat; out.hw = hw; out.excess = ex; out.tx = tx; out.tz = tz; out.d = dd;
          out.y = Q.y[ia] + (Q.y[ib] - Q.y[ia]) * u; out.i = u < 0.5 ? ia : ib;
        }
      }
    }
    return out;
  }

  // ---- the world ----
  function ringIdxAt(P, ang) {
    var best = 0, bd = 9;
    for (var i = 0; i < P.n; i++) { var d = Math.abs(wrapA(Math.atan2(P.z[i], P.x[i]) - ang)); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function segX(ax, az, bx, bz, cx, cz, dx, dz) {
    var rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return null;
    var t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
  }
  function makeRiver(r, tryN) {
    var a = r() * Math.PI, dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx, off = (r() - 0.5) * 520 + (tryN || 0) * 170, ph = r() * TAU;
    var R = { x: [], z: [], hw: 30, cells: new Map() };
    for (var t = -1900; t <= 1900; t += 20) {
      var w = off + 70 * Math.sin(t * 0.0035 + ph);
      R.x.push(dx * t + px * w); R.z.push(dz * t + pz * w);
    }
    for (var i = 0; i < R.x.length; i++) {
      var key = cellKey(Math.floor(R.x[i] / 64), Math.floor(R.z[i] / 64)), c = R.cells.get(key);
      if (!c) R.cells.set(key, c = []);
      c.push(i);
    }
    return R;
  }
  function riverDist(R, x, z) {
    var cx = Math.floor(x / 64), cz = Math.floor(z / 64), bd = Infinity, bi = -1;
    for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
      var c = R.cells.get(cellKey(cx + a, cz + b));
      if (c) for (var k = 0; k < c.length; k++) { var i = c[k], d = (R.x[i] - x) * (R.x[i] - x) + (R.z[i] - z) * (R.z[i] - z); if (d < bd) { bd = d; bi = i; } }
    }
    if (bi < 0) return 999;
    var best = Math.sqrt(bd);
    for (var s = -1; s <= 0; s++) {
      var i0 = bi + s, i1 = i0 + 1;
      if (i0 < 0 || i1 >= R.x.length) continue;
      var ax = R.x[i0], az = R.z[i0], sx = R.x[i1] - ax, sz = R.z[i1] - az, u = clamp(((x - ax) * sx + (z - az) * sz) / (sx * sx + sz * sz), 0, 1);
      best = Math.min(best, Math.hypot(x - ax - sx * u, z - az - sz * u));
    }
    return best;
  }
  function makeWorld(seed) {
    seed = (seed >>> 0) || 1;
    var r = mulberry32(seed), W = { seed: seed, name: cityName(seed) }, i, c;
    var hillA = r() * TAU;
    W.hill = { x: Math.cos(hillA) * 930, z: Math.sin(hillA) * 930, a: 30, r: 430 };
    W.H = makeHeight(seed, W.hill);
    W.sunA = hillA + Math.PI + (r() - 0.5) * 1.2;      // the sun sets away from the hills
    // ring avenue
    var K = 14, ctrl = [], R0 = 640;
    for (i = 0; i < K; i++) { var th = i / K * TAU + (r() - 0.5) * 0.2, rad = R0 * (0.8 + r() * 0.36); ctrl.push([Math.cos(th) * rad, Math.sin(th) * rad]); }
    var ring = makePath(catmull(ctrl, true, 16), true, W.H, { id: 0, kind: 'ave', hw: 2 * LANE + 0.4, lanes: 2 });
    var paths = [ring], ends = [], base = r() * TAU;
    // three cross-town roads: a highway, an avenue and a street
    for (c = 0; c < 3; c++) {
      var a0 = base + c * TAU / 3 + (r() - 0.5) * 0.3, a1 = a0 + Math.PI * (0.6 + r() * 0.22) * (c % 2 ? 1 : -1);
      for (var tries = 0; tries < 8; tries++) {
        var bad = false;
        for (var e = 0; e < ends.length; e++) { if (Math.abs(wrapA(ends[e] - a0)) < 0.42) { a0 += 0.45; bad = true; } if (Math.abs(wrapA(ends[e] - a1)) < 0.42) { a1 -= 0.45; bad = true; } }
        if (!bad) break;
      }
      ends.push(a0, a1);
      var i0 = ringIdxAt(ring, a0), i1 = ringIdxAt(ring, a1);
      var P0 = [ring.x[i0], ring.z[i0]], Pe = [ring.x[i1], ring.z[i1]];
      var l0 = Math.hypot(P0[0], P0[1]), l1 = Math.hypot(Pe[0], Pe[1]);
      var P1 = [P0[0] - P0[0] / l0 * 85, P0[1] - P0[1] / l0 * 85], P3 = [Pe[0] - Pe[0] / l1 * 85, Pe[1] - Pe[1] / l1 * 85];
      var mx = (P1[0] + P3[0]) / 2, mz = (P1[1] + P3[1]) / 2, ddx = P3[0] - P1[0], ddz = P3[1] - P1[1], dl = Math.hypot(ddx, ddz) || 1, jit = (r() - 0.5) * 240;
      var mid = [mx - ddz / dl * jit, mz + ddx / dl * jit];
      var kind = c === 0 ? 'hwy' : c === 1 ? 'ave' : 'st', hw = c === 0 ? 3 * LANE + 0.5 : c === 1 ? 2 * LANE + 0.4 : LANE + 0.4;
      var ch = makePath(catmull([P0, P1, mid, P3, Pe], false, 22), false, W.H, { id: c + 1, kind: kind, hw: hw, lanes: c === 0 ? 3 : c === 1 ? 2 : 1 });
      ch.ends = [i0, i1];
      paths.push(ch);
    }
    W.paths = paths;
    // junctions
    var nodes = [];
    function addNode(x, z, links) { nodes.push({ id: nodes.length, x: x, z: z, links: links, edges: [] }); return nodes.length - 1; }
    for (c = 1; c < paths.length; c++) {
      var C = paths[c];
      addNode(C.x[0], C.z[0], [{ p: 0, s: C.ends[0] * ring.step }, { p: c, s: 0 }]);
      addNode(C.x[C.n - 1], C.z[C.n - 1], [{ p: 0, s: C.ends[1] * ring.step }, { p: c, s: C.len }]);
    }
    for (var pa = 0; pa < paths.length; pa++) for (var pb = pa + 1; pb < paths.length; pb++) {
      var A = paths[pa], B = paths[pb], skipA = pa === 0 ? 0 : 12;
      for (i = 0; i < (A.closed ? A.n : A.n - 1); i++) {
        if (pa === 0 && (Math.abs(i - B.ends[0]) < 14 || Math.abs(i - B.ends[1]) < 14 || Math.abs(i - B.ends[0]) > A.n - 14 || Math.abs(i - B.ends[1]) > A.n - 14)) continue;
        if (pa > 0 && (i < skipA || i > A.n - 1 - skipA)) continue;
        var ia = i, ib = ix(A, i + 1);
        for (var j = 12; j < B.n - 13; j++) {
          var hit = segX(A.x[ia], A.z[ia], A.x[ib], A.z[ib], B.x[j], B.z[j], B.x[j + 1], B.z[j + 1]);
          if (!hit) continue;
          var sa = (i + hit[0]) * A.step, sb = (j + hit[1]) * B.step;
          if (nodes.some(function (nd) { return nd.links.some(function (l) { return l.p === pb && Math.abs(l.s - sb) < 40; }); })) continue;
          addNode(A.x[ia] + (A.x[ib] - A.x[ia]) * hit[0], A.z[ia] + (A.z[ib] - A.z[ia]) * hit[0], [{ p: pa, s: sa }, { p: pb, s: sb }]);
        }
      }
    }
    W.nodes = nodes;
    // per-path stops, junction zones (no curbs/markings) and edges
    var edges = [];
    nodes.forEach(function (nd) {
      nd.links.forEach(function (l, li) {
        var P = paths[l.p], other = nd.links[1 - li] || nd.links[0], Q = paths[other.p];
        var qa = pathAt(Q, other.s), pp = pathAt(P, l.s), sin = Math.abs(qa.tx * pp.tz - qa.tz * pp.tx);
        var minor = P.hw[0] < Q.hw[0] || (P.hw[0] === Q.hw[0] && l.p > other.p);
        P.stops.push({ s: l.s, node: nd.id });
        // which side of P the other road leaves on (a T-junction), or 0 when it crosses
        var side = 0, qEnd = !Q.closed && (other.s < 1 || other.s > Q.len - 1);
        if (qEnd) { var away = other.s < 1 ? 1 : -1; side = sgn((qa.tx * away) * -pp.tz + (qa.tz * away) * pp.tx) || 1; }
        P.zones.push({ s: l.s, r: (Q.hw[0] + SIDE + 1.5) / Math.max(0.55, sin), asph: minor ? (Q.hw[0] - 0.35) / Math.max(0.55, sin) : 0, node: nd.id, side: side });
      });
    });
    paths.forEach(function (P, pi) {
      P.stops.sort(function (a, b) { return a.s - b.s; });
      var st = P.stops, m = st.length;
      for (var k = 0; k < (P.closed ? m : m - 1); k++) {
        var a = st[k], b = st[(k + 1) % m], sb = b.s;
        if (P.closed && k === m - 1) sb += P.len;
        var ed = { id: edges.length, p: pi, sa: a.s, sb: sb, na: a.node, nb: b.node, len: sb - a.s };
        if (ed.len < 1) continue;
        edges.push(ed); nodes[a.node].edges.push(ed.id); nodes[b.node].edges.push(ed.id);
      }
    });
    W.edges = edges;
    W.grid = makeGrid(paths, null);
    // river (kept away from junctions)
    for (var rt = 0; rt < 6; rt++) {
      W.river = makeRiver(r, rt);
      if (!nodes.some(function (nd) { return riverDist(W.river, nd.x, nd.z) < W.river.hw + 34; })) break;
    }
    // districts: downtown in the middle, pine hills by the hill, the rest around
    var sites = [{ x: (r() - 0.5) * 220, z: (r() - 0.5) * 220, t: 0, w: 0 }, { x: W.hill.x * 0.95, z: W.hill.z * 0.95, t: 4, w: 0 }];
    var types = [1, 2, 1, 3, 2, 1, 0];
    for (i = 0; i < types.length; i++) { var sa2 = r() * TAU, sr = 380 + r() * 520; sites.push({ x: Math.cos(sa2) * sr, z: Math.sin(sa2) * sr, t: types[i], w: types[i] === 0 ? 90 : 0 }); }
    W.sites = sites;
    W.minX = -1250; W.maxX = 1250; W.minZ = -1250; W.maxZ = 1250;
    genProps(W, r);
    // free-roam race markers on junctions
    W.markers = [];
    var nids = nodes.map(function (n) { return n.id; });
    for (i = 0; i < nids.length && W.markers.length < 4; i++) {
      var nn = nodes[nids[(i * 5 + 3) % nids.length]];
      if (W.markers.some(function (m) { return m.node === nn.id; })) continue;
      W.markers.push({ node: nn.id, x: nn.x, z: nn.z, y: W.H(nn.x, nn.z), type: W.markers.length % 2 ? 'circuit' : 'sprint', seed: hashStr(seed + ':' + nn.id) });
    }
    return W;
  }
  function district(W, x, z) {
    var wx = x + 70 * Math.sin(z * 0.006), wz = z + 70 * Math.sin(x * 0.0055), best = 0, bd = Infinity;
    for (var i = 0; i < W.sites.length; i++) { var s = W.sites[i], d = Math.hypot(wx - s.x, wz - s.z) - s.w; if (d < bd) { bd = d; best = s.t; } }
    if (W.river && riverDist(W.river, x, z) < W.river.hw + 55 && best !== 0) best = 3;
    return best;
  }
  // side: +1 / -1 to ask about one side of the road only (a T-junction blocks one side)
  function inZone(P, s, pad, side) {
    for (var i = 0; i < P.zones.length; i++) { var z = P.zones[i], d = Math.abs(dS(P, z.s, s)); if (d < z.r + pad && (!side || !z.side || z.side === side)) return true; }
    return false;
  }

  // ---- what is built along the roads ----
  var BCOL = {
    tower: [[196, 190, 178], [150, 165, 182], [176, 168, 160], [120, 132, 150], [210, 204, 190], [160, 150, 140]],
    shop: [[200, 120, 90], [190, 170, 130], [150, 110, 90], [205, 190, 160], [120, 130, 120]],
    house: [[226, 214, 186], [196, 210, 214], [214, 190, 170], [180, 196, 168], [232, 226, 214], [200, 170, 150]],
    roof: [[120, 70, 60], [80, 84, 92], [110, 96, 80], [70, 70, 72]],
    ware: [[170, 172, 168], [150, 160, 170], [184, 170, 140], [140, 140, 134]],
    awn: [[200, 60, 50], [40, 110, 160], [60, 140, 90], [220, 170, 40], [120, 60, 140]]
  };
  function genProps(W, r) {
    var G = W.grid, q = {}, occ = new Set(), OC = 3;
    W.blds = []; W.trees = []; W.lamps = []; W.hedges = []; W.rocks = [];
    function okAt(x, z, pad) {
      var g = query(G, x, z, q);
      if (g && g.excess < pad) return false;
      if (riverDist(W.river, x, z) < W.river.hw + 4) return false;
      return Math.hypot(x, z) < 1600;
    }
    function rectPts(x, z, w, d, rot, f) {
      var c = Math.cos(rot), s = Math.sin(rot);       // width along (s, c) (the road), depth along (c, -s) (toward the road = +)
      for (var u = -w / 2; u <= w / 2 + 0.01; u += Math.min(OC, w / 2)) for (var v = -d / 2; v <= d / 2 + 0.01; v += Math.min(OC, d / 2)) if (f(x + s * u + c * v, z + c * u - s * v) === false) return false;
      return true;
    }
    function free(x, z, w, d, rot, pad) {
      return rectPts(x, z, w, d, rot, function (px, pz) { if (occ.has(cellKey(Math.floor(px / OC), Math.floor(pz / OC)))) return false; if (!okAt(px, pz, pad)) return false; });
    }
    function mark(x, z, w, d, rot) { rectPts(x, z, w + 2, d + 2, rot, function (px, pz) { occ.add(cellKey(Math.floor(px / OC), Math.floor(pz / OC))); }); }
    function minH(x, z, w, d, rot) { var m = Infinity; rectPts(x, z, w, d, rot, function (px, pz) { m = Math.min(m, W.H(px, pz)); }); return m; }
    var o = {};
    W.paths.forEach(function (P) {
      var hwy = P.kind === 'hwy';
      for (var side = -1; side <= 1; side += 2) {
        var s = rr(r, 2, 12);
        while (s < P.len - 4) {
          pathAt(P, s, o);
          if (inZone(P, s, 6, side)) { s += 6; continue; }
          var dt = district(W, o.x, o.z), nx = -o.tz * side, nz = o.tx * side, rot = Math.atan2(o.tx, o.tz) + (side > 0 ? 0 : Math.PI);
          var b = null, roll = r(), edge = o.hw + SIDE;
          if (hwy) {
            if (roll < 0.35) b = { t: dt === 2 ? 'ware' : 'shop', w: rr(r, 16, 30), d: rr(r, 14, 24), h: rr(r, 6, 12), set: rr(r, 14, 26), gap: rr(r, 10, 30) };
          } else if (dt === 0) {
            var cen = clamp(1 - Math.hypot(o.x - W.sites[0].x, o.z - W.sites[0].z) / 800, 0.15, 1);
            b = roll < 0.65 ? { t: 'tower', w: rr(r, 16, 28), d: rr(r, 16, 26), h: rr(r, 18, 34) + cen * rr(r, 10, 48), set: rr(r, 0.6, 2.5), gap: rr(r, 1, 4) }
              : { t: 'shop', w: rr(r, 10, 16), d: rr(r, 10, 14), h: rr(r, 7, 13), set: rr(r, 0.5, 1.5), gap: rr(r, 1, 3) };
          } else if (dt === 1) {
            b = roll < 0.72 ? { t: 'house', w: rr(r, 9, 13), d: rr(r, 9, 12), h: rr(r, 4.2, 6.5), set: rr(r, 6, 10), gap: rr(r, 6, 12) }
              : roll < 0.88 ? { t: 'garage', w: rr(r, 7, 10), d: rr(r, 7, 9), h: rr(r, 3.2, 4), set: rr(r, 4, 7), gap: rr(r, 4, 8) }
                : { t: 'shop', w: rr(r, 12, 18), d: rr(r, 10, 14), h: rr(r, 5, 8), set: rr(r, 1, 3), gap: rr(r, 4, 9) };
          } else if (dt === 2) {
            b = roll < 0.55 ? { t: 'ware', w: rr(r, 24, 44), d: rr(r, 20, 32), h: rr(r, 7, 12), set: rr(r, 3, 8), gap: rr(r, 5, 10) }
              : roll < 0.8 ? { t: 'garage', w: rr(r, 12, 20), d: rr(r, 10, 14), h: rr(r, 4.5, 6), set: rr(r, 2, 5), gap: rr(r, 4, 8) }
                : { t: 'tank', w: rr(r, 9, 15), d: 0, h: rr(r, 7, 13), set: rr(r, 5, 9), gap: rr(r, 6, 12) };
            if (b.t === 'tank') b.d = b.w;
          } else if (dt === 3) {
            if (roll < 0.14) b = { t: 'shop', w: rr(r, 8, 12), d: rr(r, 7, 10), h: rr(r, 4, 6), set: rr(r, 3, 6), gap: rr(r, 10, 24) };
          } else if (roll < 0.12) b = { t: 'house', w: rr(r, 7, 9), d: rr(r, 7, 9), h: rr(r, 3.5, 4.5), set: rr(r, 8, 16), gap: rr(r, 20, 40) };
          if (b) {
            var off = edge + b.set + b.d / 2, bx = o.x + nx * off, bz = o.z + nz * off;
            if (free(bx, bz, b.w, b.d, rot, 1.5)) {
              b.x = bx; b.z = bz; b.rot = rot; b.y = minH(bx, bz, b.w, b.d, rot) - 0.5; b.dist = dt;
              b.col = pick(r, b.t === 'tower' ? BCOL.tower : b.t === 'house' ? BCOL.house : b.t === 'ware' || b.t === 'tank' ? BCOL.ware : BCOL.shop);
              b.roof = pick(r, BCOL.roof); b.awn = pick(r, BCOL.awn); b.seed = (r() * 1e9) | 0;
              W.blds.push(b); mark(bx, bz, b.w, b.d, rot);
              // front yard: hedge + a tree for houses
              if (b.t === 'house' && b.set > 4) {
                var hoff = edge + 1.2, hx = o.x + nx * hoff, hz = o.z + nz * hoff;
                if (r() < 0.7 && okAt(hx, hz, 0.6)) W.hedges.push({ x: hx, z: hz, y: W.H(hx, hz), rot: rot, len: b.w * rr(r, 0.6, 0.95), h: rr(r, 0.9, 1.4) });
                var tx2 = o.x + nx * (edge + b.set * 0.55) + o.tx * (b.w / 2 + 1.5), tz2 = o.z + nz * (edge + b.set * 0.55) + o.tz * (b.w / 2 + 1.5);
                if (r() < 0.6 && okAt(tx2, tz2, 1)) W.trees.push({ t: 1, x: tx2, z: tz2, y: W.H(tx2, tz2), s: rr(r, 0.8, 1.2) });
              }
              // a second row behind, for depth
              if (!hwy && dt !== 3 && r() < 0.55) {
                var b2 = { t: b.t === 'tank' ? 'ware' : b.t, w: b.w * rr(r, 0.8, 1.2), d: b.t === 'tank' ? b.w : b.d * rr(r, 0.8, 1.1), h: b.h * rr(r, 0.9, 1.5), seed: (r() * 1e9) | 0 };
                var off2 = off + b.d / 2 + b2.d / 2 + rr(r, 3, 9), b2x = o.x + nx * off2, b2z = o.z + nz * off2;
                if (free(b2x, b2z, b2.w, b2.d, rot, 2)) {
                  b2.x = b2x; b2.z = b2z; b2.rot = rot; b2.y = minH(b2x, b2z, b2.w, b2.d, rot) - 0.5; b2.dist = dt; b2.col = pick(r, b.t === 'tower' ? BCOL.tower : b.t === 'house' ? BCOL.house : BCOL.ware);
                  b2.roof = pick(r, BCOL.roof); b2.awn = b.awn; W.blds.push(b2); mark(b2x, b2z, b2.w, b2.d, rot);
                }
              }
              s += b.w + b.gap; continue;
            }
          }
          // nothing built: a tree, a hedge or open ground
          var tt = (dt === 4 || hwy) ? 0 : dt === 3 ? (r() < 0.75 ? 1 : 0) : dt === 1 ? 1 : (r() < 0.5 ? 1 : 0);
          var toff = edge + rr(r, 1.5, hwy ? 12 : 6), tx3 = o.x + nx * toff, tz3 = o.z + nz * toff;
          if ((dt !== 0 || r() < 0.3) && okAt(tx3, tz3, 1)) { W.trees.push({ t: tt, x: tx3, z: tz3, y: W.H(tx3, tz3), s: rr(r, 0.75, 1.25) }); occ.add(cellKey(Math.floor(tx3 / OC), Math.floor(tz3 / OC))); }
          if (dt === 3 && r() < 0.35) { var hx2 = o.x + nx * (edge + 0.9), hz2 = o.z + nz * (edge + 0.9); if (okAt(hx2, hz2, 0.5)) W.hedges.push({ x: hx2, z: hz2, y: W.H(hx2, hz2), rot: rot, len: rr(r, 4, 9), h: rr(r, 0.8, 1.2) }); }
          s += rr(r, 5, 11);
        }
      }
      // street lamps on the sidewalk, staggered
      var sp = hwy ? 40 : 32, n = 0;
      for (var s2 = 10; s2 < P.len - 4; s2 += sp, n++) {
        if (inZone(P, s2, 3)) continue;
        pathAt(P, s2, o);
        var sd = n % 2 ? 1 : -1;
        if (district(W, o.x, o.z) === 0 && !hwy) sd = 0;      // downtown: both sides
        for (var sx = -1; sx <= 1; sx += 2) {
          if (sd && sx !== sd) continue;
          var lo = o.hw + SIDE - 0.15, lx = o.x - o.tz * sx * lo, lz = o.z + o.tx * sx * lo;
          W.lamps.push({ x: lx, z: lz, y: o.y + 0.15, rot: Math.atan2(o.tx, o.tz), side: sx, arm: Math.min(3.2, lo - o.hw + 1.6) });
        }
      }
    });
    // parks, forests and the hills between the roads
    for (var i = 0; i < 3400; i++) {
      var a = r() * TAU, rad = Math.sqrt(r()) * 1550, x = Math.cos(a) * rad, z = Math.sin(a) * rad, dt2 = rad > 1180 ? 4 : district(W, x, z);
      var dens = [0.05, 0.3, 0.12, 0.7, 0.95][dt2];
      if (r() > dens) continue;
      if (occ.has(cellKey(Math.floor(x / OC), Math.floor(z / OC))) || !okAt(x, z, 3)) continue;
      var pine = dt2 === 4 || dt2 === 2 ? r() < 0.92 : r() < 0.3;
      W.trees.push({ t: pine ? 0 : 1, x: x, z: z, y: W.H(x, z), s: rr(r, 0.8, 1.45) * (dt2 === 4 ? 1.15 : 1) });
      occ.add(cellKey(Math.floor(x / OC), Math.floor(z / OC)));
      if (dt2 === 4 && r() < 0.06) W.rocks.push({ x: x + rr(r, -4, 4), z: z + rr(r, -4, 4), y: W.H(x, z) - 0.4, s: rr(r, 1, 3.2), rot: r() * TAU });
    }
  }

  // ---- routes ----
  function edgeIdx(W, e, fromNode) {
    var P = W.paths[e.p], out = [], i0 = Math.round(e.sa / P.step), i1 = Math.round(e.sb / P.step);
    for (var i = i0; i <= i1; i++) out.push(ix(P, i));
    if (fromNode === e.nb && e.na !== e.nb) out.reverse();
    return out;
  }
  // seq: [{e: edgeId, from: nodeId}] -> route { path, masks, closed, nodes }
  function composeRoute(W, seq, closed, cut) {
    var pts = [], masks = W.paths.map(function (P) { return new Uint8Array(P.n); }), nodes = [];
    seq.forEach(function (it, k) {
      var e = W.edges[it.e], P = W.paths[e.p], list = edgeIdx(W, e, it.from);
      nodes.push(it.from);
      for (var j = k ? 1 : 0; j < list.length; j++) { var i = list[j]; pts.push([P.x[i], P.z[i], P.hw[i], P.lanes[i], e.p]); masks[e.p][i] = 1; }
    });
    if (closed && pts.length > 2) pts.pop();
    if (cut && cut < pts.length) pts.length = cut;
    var last = seq[seq.length - 1], le = W.edges[last.e];
    if (!cut) nodes.push(last.from === le.na ? le.nb : le.na);
    // round the corners a little (agents, racing line); the corridor itself stays on the raw roads
    for (var pass = 0; pass < 2; pass++) {
      var sm = pts.map(function (p) { return p.slice(); }), n = pts.length;
      for (var i = 0; i < n; i++) {
        var ax = 0, az = 0, c = 0;
        for (var d = -3; d <= 3; d++) { var jj = i + d; if (closed) jj = (jj + n) % n; else if (jj < 0 || jj >= n) continue; ax += pts[jj][0]; az += pts[jj][1]; c++; }
        sm[i][0] = ax / c; sm[i][1] = az / c;
      }
      pts = sm;
    }
    var path = makePath(pts, closed, W.H, { id: 99, kind: 'route', hw: 7, lanes: 2, src: 1 });
    return finishRoute(W, path, masks, closed, nodes);
  }
  function finishRoute(W, path, masks, closed, nodes) {
    var R = { path: path, masks: masks, closed: closed, nodes: nodes, len: path.len };
    // speed profile (for a car with 15 m/s² of grip, 14 m/s² brakes) and a racing line
    var n = path.n, vref = new Float32Array(n), line = new Float32Array(n), i, k;
    for (i = 0; i < n; i++) {
      var kk = 0, c = 0;
      for (k = -2; k <= 2; k++) { var j = ix(path, i + k); kk += Math.abs(path.k[j]); c++; }
      kk /= c;
      vref[i] = Math.min(95, Math.sqrt(15 / Math.max(kk, 1e-4)));
      var ka = 0;
      for (k = 0; k < 12; k++) ka += path.k[ix(path, i + k)];
      ka /= 12;
      line[i] = clamp(-ka * 300, -(path.hw[i] - 1.7), path.hw[i] - 1.7);
    }
    for (var rep = 0; rep < (closed ? 2 : 1); rep++) for (i = n - 1; i >= 0; i--) { var nx = closed ? (i + 1) % n : i + 1; if (nx < n) vref[i] = Math.min(vref[i], Math.sqrt(vref[nx] * vref[nx] + 2 * 14 * path.step)); }
    var l2 = new Float32Array(n);
    for (i = 0; i < n; i++) { var sum = 0, cc = 0; for (k = -6; k <= 6; k++) { var jj = ix(path, i + k); sum += line[jj]; cc++; } l2[i] = sum / cc; }
    R.vref = vref; R.line = l2;
    R.grid = makeGrid(W.paths, masks);
    R.barriers = routeBarriers(W, R);
    return R;
  }
  function routeBarriers(W, R) {
    var out = [], o = {};
    W.nodes.forEach(function (nd) {
      var onRoute = false, arms = [], maxHw = 0;
      nd.links.forEach(function (l) {
        var P = W.paths[l.p], i = Math.round(l.s / P.step), m = R.masks[l.p];
        maxHw = Math.max(maxHw, P.hw[0]);
        [-1, 1].forEach(function (dir) {
          if (!P.closed && ((dir < 0 && l.s < 1) || (dir > 0 && l.s > P.len - 1))) return;
          var probe = ix(P, i + dir * 3), cov = !!m[probe] && !!m[ix(P, i)];
          if (cov) onRoute = true;
          arms.push({ p: l.p, s: l.s, dir: dir, cov: cov, hw: P.hw[0] });
        });
      });
      if (!onRoute) return;
      arms.forEach(function (a) {
        if (a.cov) return;
        var P = W.paths[a.p], d = maxHw + SIDE + 0.6;
        pathAt(P, a.s + a.dir * d, o);
        out.push({ x: o.x, z: o.z, y: o.y, tx: o.tx, tz: o.tz, w: a.hw + SIDE });
      });
    });
    return out;
  }
  function routeRing(W, r) {
    var ring = W.paths[0], seq = [], es = W.edges.filter(function (e) { return e.p === 0; }), rev = r() < 0.5;
    es.sort(function (a, b) { return a.sa - b.sa; });
    if (rev) es.reverse();
    es.forEach(function (e) { seq.push({ e: e.id, from: rev ? e.nb : e.na }); });
    void ring;
    return composeRoute(W, seq, true);
  }
  // a cross-town road plus one half of the ring
  function routeLoop(W, r) {
    var ci = 1 + Math.floor(r() * (W.paths.length - 1)), C = W.paths[ci], seq = [];
    var ce = W.edges.filter(function (e) { return e.p === ci; }).sort(function (a, b) { return a.sa - b.sa; });
    var startN = ce[0].na, endN = ce[ce.length - 1].nb;
    ce.forEach(function (e) { seq.push({ e: e.id, from: e.na }); });
    // ring edges from endN back to startN, in the direction chosen
    var re = W.edges.filter(function (e) { return e.p === 0; }), fwd = r() < 0.5, cur = endN, guard = 0;
    var arcLen = function (f) { var c2 = endN, L = 0, gd = 0; while (c2 !== startN && gd++ < 40) { var e2 = null; for (var q = 0; q < re.length; q++) if (f ? re[q].na === c2 : re[q].nb === c2) { e2 = re[q]; break; } if (!e2) return Infinity; L += e2.len; c2 = f ? e2.nb : e2.na; } return L; };
    var lf = arcLen(true), lb = arcLen(false);
    if (r() < 0.8) fwd = lf <= lb;
    while (cur !== startN && guard++ < 40) {
      var e = null;
      for (var k = 0; k < re.length; k++) { if (fwd ? re[k].na === cur : re[k].nb === cur) { e = re[k]; break; } }
      if (!e) break;
      seq.push({ e: e.id, from: cur }); cur = fwd ? e.nb : e.na;
    }
    void C;
    if (cur !== startN) return routeRing(W, r);
    return composeRoute(W, seq, true);
  }
  function routeSprint(W, r, minL, maxL) {
    for (var at = 0; at < 80; at++) {
      var n0 = Math.floor(r() * W.nodes.length), seen = {}, seq = [], len = 0, cur = n0, prevE = -1;
      seen[cur] = 1;
      while (len < minL) {
        var opts = W.nodes[cur].edges.filter(function (eid) { var e = W.edges[eid], to = e.na === cur ? e.nb : e.na; return eid !== prevE && !seen[to]; });
        if (!opts.length) break;
        var eid = pick(r, opts), e = W.edges[eid];
        if (!seq.length && e.len < 160) break;
        seq.push({ e: eid, from: cur }); len += e.len; prevE = eid;
        cur = e.na === cur ? e.nb : e.na; seen[cur] = 1;
      }
      if (len < minL || seq.length < 2) continue;
      var over = len - maxL, cut = 0;
      if (over > 0) {
        var total = 0; seq.forEach(function (it) { total += W.edges[it.e].len; });
        cut = Math.round((total - over) / SAMP);
      }
      return composeRoute(W, seq, false, cut);
    }
    return null;
  }
  function makeRoute(W, type, seed) {
    var r = mulberry32(seed >>> 0), R = null;
    if (type === 'sprint') R = routeSprint(W, r, 1700, 2900);
    else if (type === 'loop') R = routeLoop(W, r);
    if (!R) R = routeRing(W, r);
    R.type = type === 'sprint' && R.closed === false ? 'sprint' : 'circuit';
    var P = R.path;
    if (R.closed) {
      // the straightest stretch for the grid
      var best = 0, bv = Infinity;
      for (var i = 0; i < P.n; i += 3) { var sum = 0; for (var k = -18; k <= 12; k++) sum += Math.abs(P.k[ix(P, i + k)]); if (sum < bv) { bv = sum; best = i; } }
      R.startS = best * P.step; R.finishS = R.startS;
    } else { R.startS = 64; R.finishS = P.len - 24; }
    return R;
  }

  // ---- cars ----
  var CARS = [
    { id: 'kestrel', name: 'Kestrel S', cls: 'hatch', price: 0, top: 60, acc: 7.6, grip: 1.0, turn: 1.0, mass: 1150, nos: 1.0, col: [214, 52, 44],
      body: { len: 4.0, wid: 1.78, h: 1.36, cab: 0.56, cabPos: -0.12, hood: 0.66, spoiler: 'lip' } },
    { id: 'vanta', name: 'Vanta R', cls: 'coupe', price: 9000, top: 65, acc: 8.4, grip: 1.04, turn: 1.04, mass: 1240, nos: 1.05, col: [36, 100, 196],
      body: { len: 4.35, wid: 1.86, h: 1.24, cab: 0.46, cabPos: -0.06, hood: 0.62, spoiler: 'wing' } },
    { id: 'marauder', name: 'Marauder 8', cls: 'muscle', price: 16000, top: 69, acc: 9.6, grip: 0.93, turn: 0.94, mass: 1560, nos: 1.1, col: [236, 180, 36],
      body: { len: 4.8, wid: 1.94, h: 1.3, cab: 0.42, cabPos: -0.14, hood: 0.7, spoiler: 'duck', scoop: 1 } },
    { id: 'halcyon', name: 'Halcyon GT', cls: 'gt', price: 26000, top: 72, acc: 9.3, grip: 1.08, turn: 1.02, mass: 1420, nos: 1.1, col: [40, 150, 110],
      body: { len: 4.6, wid: 1.95, h: 1.22, cab: 0.44, cabPos: -0.04, hood: 0.6, spoiler: 'lip' } },
    { id: 'ronin', name: 'Ronin RS', cls: 'super', price: 42000, top: 78, acc: 10.6, grip: 1.16, turn: 1.08, mass: 1330, nos: 1.18, col: [236, 236, 230],
      body: { len: 4.5, wid: 2.02, h: 1.1, cab: 0.4, cabPos: 0.08, hood: 0.5, spoiler: 'big' } }
  ];
  var CAR_BY = {}; CARS.forEach(function (c, i) { c.ix = i; CAR_BY[c.id] = c; });
  var TRAFFIC = [
    { id: 'sedan', body: { len: 4.5, wid: 1.8, h: 1.45, cab: 0.5, cabPos: -0.05, hood: 0.72 } },
    { id: 'van', body: { len: 4.9, wid: 1.95, h: 2.1, cab: 0.78, cabPos: -0.22, hood: 0.9, van: 1 } },
    { id: 'hatch', body: { len: 3.9, wid: 1.72, h: 1.5, cab: 0.6, cabPos: -0.15, hood: 0.72 } },
    { id: 'pickup', body: { len: 5.2, wid: 1.95, h: 1.8, cab: 0.32, cabPos: 0.12, hood: 0.95, bed: 1 } }
  ];
  var POLICE = { id: 'cruiser', body: { len: 4.8, wid: 1.88, h: 1.45, cab: 0.48, cabPos: -0.06, hood: 0.72, police: 1 } };
  var PAINTS = [
    { name: 'Stock', col: null, cost: 0 }, { name: 'Signal Red', col: [214, 40, 40], cost: 400 }, { name: 'Volt Yellow', col: [240, 210, 30], cost: 400 },
    { name: 'Deep Blue', col: [28, 70, 170], cost: 400 }, { name: 'Racing Green', col: [24, 110, 64], cost: 600 }, { name: 'Sunset Orange', col: [240, 110, 30], cost: 600 },
    { name: 'Midnight', col: [26, 28, 36], cost: 800 }, { name: 'Pearl', col: [236, 234, 226], cost: 800 }, { name: 'Lime Flash', col: [130, 220, 40], cost: 1000 },
    { name: 'Violet', col: [120, 60, 190], cost: 1000 }, { name: 'Chrome Teal', col: [30, 170, 180], cost: 1500 }
  ];
  var UPGS = [
    { id: 'eng', name: 'Engine', note: 'top speed + acceleration', cost: [1500, 4000, 9000] },
    { id: 'tire', name: 'Tires', note: 'grip and turn-in', cost: [1200, 3500, 8000] },
    { id: 'nos', name: 'Nitrous', note: 'bigger tank, harder boost', cost: [1000, 3000, 7000] },
    { id: 'armor', name: 'Armor', note: 'less damage in crashes', cost: [800, 2500, 6000] }
  ];
  function carStats(id, upg) {
    var c = CAR_BY[id] || CARS[0], u = upg || {};
    var e = clamp(u.eng | 0, 0, 3), t = clamp(u.tire | 0, 0, 3), n = clamp(u.nos | 0, 0, 3), a = clamp(u.armor | 0, 0, 3);
    return {
      id: c.id, top: c.top * (1 + 0.045 * e), acc: c.acc * (1 + 0.07 * e), grip: c.grip * (1 + 0.05 * t), turn: c.turn * (1 + 0.03 * t),
      mass: c.mass, nosCap: c.nos * (1 + 0.2 * n), nosK: 1 + 0.12 * n, armor: 1 - 0.18 * a, brake: 17
    };
  }

  var DIFFS = [
    { name: 'Easy', skill: 0.85, rubber: 1, traffic: 0.6, cops: 0.75, dmg: 0.6, grid: 0 },
    { name: 'Normal', skill: 0.93, rubber: 0.6, traffic: 0.9, cops: 1, dmg: 1, grid: 1 },
    { name: 'Hard', skill: 1.0, rubber: 0.35, traffic: 1.15, cops: 1.25, dmg: 1.3, grid: 2 }
  ];
  var RIVALS = [
    { id: 'moth', name: 'Moth', car: 'kestrel', col: [230, 120, 40], trait: 'twitchy, late on the brakes' },
    { id: 'pike', name: 'Pike', car: 'kestrel', col: [60, 180, 220], trait: 'blocks the inside line' },
    { id: 'sable', name: 'Sable', car: 'vanta', col: [40, 40, 50], trait: 'smooth, never crashes' },
    { id: 'juno', name: 'Juno', car: 'vanta', col: [220, 60, 140], trait: 'nitro-happy on straights' },
    { id: 'dagger', name: 'Dagger', car: 'marauder', col: [180, 30, 30], trait: 'rams anyone in reach' },
    { id: 'wren', name: 'Wren', car: 'halcyon', col: [120, 200, 80], trait: 'a corner specialist' },
    { id: 'atlas', name: 'Atlas', car: 'halcyon', col: [200, 170, 60], trait: 'heavy foot, wide lines' },
    { id: 'nova', name: 'Nova Reign', car: 'ronin', col: [150, 90, 230], trait: 'the one at the top' }
  ];
  var CREW = ['Ezra', 'Lux', 'Bram', 'Kit', 'Ozzy', 'Remy', 'Tess', 'Vic', 'Nell', 'Quill', 'Rook', 'Zane', 'Ivy', 'Cole', 'Mars'];
  var CREW_COL = [[90, 160, 230], [230, 90, 90], [240, 200, 60], [90, 200, 140], [200, 120, 230], [240, 150, 60], [160, 160, 170], [60, 200, 200]];
  // career: one tier per rival — circuit, sprint, (escape), then a duel with the rival
  function careerEvents(tier) {
    var out = [{ type: 'circuit', laps: 2, opp: 3, k: 'c' }, { type: 'sprint', opp: 4, k: 's' }];
    if (tier >= 1) out.push({ type: 'escape', heat: Math.min(5, 1 + Math.ceil(tier / 2)), k: 'e' });
    out.push({ type: 'duel', opp: 1, k: 'd' });
    out.forEach(function (e, i) { e.tier = tier; e.i = i; e.seed = hashStr('redline-career-' + tier + '-' + e.k); e.prize = Math.round((700 + tier * 520) * (e.type === 'duel' ? 2 : e.type === 'escape' ? 1.2 : 1) / 50) * 50; });
    return out;
  }
  function dailyKey(d) { d = d || new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dailyEvent(key) {
    var h = hashStr('redline-daily-' + key), r = mulberry32(h);
    return { key: key, seed: h, type: r() < 0.5 ? 'sprint' : 'circuit', laps: 2, opp: 5, car: pick(r, ['vanta', 'halcyon', 'marauder']), tod: pick(r, ['day', 'day', 'dusk', 'night']), rain: r() < 0.25 };
  }

  // ---- a game ----
  // o: { world, kind: 'race'|'free', type, laps, opp, diff, car, upg, seed, rivals: [{name,car,col,skill}], heat, escape, tod, rain, spawn }
  function newPlayer(st, x, z, a, y) {
    return { st: st, x: x, z: z, y: y || 0, a: a, vx: 0, vz: 0, w: 0, steer: 0, rpm: 900, gear: 1, nos: st.nosCap, nosOn: false, dmg: 0,
      drift: 0, driftT: 0, slip: 0, hb: false, brakeOn: false, off: false, vf: 0, acc: 0, wheel: 0, lastX: x, lastZ: z, lastA: a, q: {}, burn: 0, rev: false };
  }
  function newGame(o) {
    var W = o.world, D = DIFFS[clamp(o.diff | 0, 0, 2)], r = mulberry32((o.seed >>> 0) ^ 0x1234567);
    var g = { W: W, kind: o.kind || 'race', D: D, diff: clamp(o.diff | 0, 0, 2), t: 0, ev: [], phase: 'count', countT: 3.2, agents: [], r: r, seed: o.seed >>> 0,
      tod: o.tod || 'day', rain: !!o.rain, ap: {}, near: 0, score: 0, drift: 0, driftPts: 0, heat: 0, heatPts: 0, pursuit: false, evadeT: 0, bustT: 0, bounty: 0, cops: 0,
      roadT: 0, blocks: [], markerCool: -1, cash: 0, escape: !!o.escape, hits: 0, copHits: 0, prize: o.prize || 0, wrong: 0, result: null, lastLos: 0, maxHeat: 0, nextCop: 0 };
    var st = carStats(o.car, o.upg);
    if (g.kind === 'race') {
      var R = o.route || makeRoute(W, o.type === 'sprint' ? 'sprint' : (o.loop ? 'loop' : 'ring'), o.seed >>> 0);
      g.R = R; g.path = R.path; g.grid = R.grid; g.laps = R.type === 'sprint' ? 1 : clamp(o.laps | 0 || 2, 1, 5); g.type = R.type;
      g.total = R.type === 'sprint' ? R.finishS - R.startS : g.laps * R.len;
      var nOpp = clamp(o.opp | 0, 1, 5), slots = nOpp + 1, pslot = o.duel ? 1 : [0, Math.floor(slots / 2), slots - 1][D.grid];
      if (pslot >= slots) pslot = slots - 1;
      var grid = [], k;
      for (k = 0; k < slots; k++) {
        var row = Math.floor(k / 2), s = R.startS - 7 - row * 9, lat = (k % 2 ? 1 : -1) * Math.min(2.4, R.path.hw[0] * 0.33);
        grid.push({ s: s, lat: lat });
      }
      var gp = grid[pslot], pa = pathAt(g.path, gp.s), px = pa.x - pa.tz * gp.lat, pz = pa.z + pa.tx * gp.lat;
      g.p = newPlayer(st, px, pz, Math.atan2(pa.tx, pa.tz), pa.y);
      g.p.u = gp.s; g.p.ri = pa.i; g.p.lap = 0; g.p.prog = gp.s - R.startS; g.p.fin = 0;
      var rivals = o.rivals || [];
      var ri = 0;
      for (k = 0; k < slots; k++) {
        if (k === pslot) continue;
        var rv = rivals[ri] || { name: CREW[(ri * 3 + (o.seed % 7)) % CREW.length], car: CARS[Math.min(CARS.length - 1, ri % 3)].id, col: CREW_COL[ri % CREW_COL.length], skill: 1 };
        ri++;
        var rst = carStats(rv.car, rv.upg || { eng: rv.lvl || 0, tire: rv.lvl || 0 });
        var ag = newAgent(g, 'rival', g.path, grid[k].s, 1, grid[k].lat, 0);
        ag.st = rst; ag.name = rv.name; ag.col = rv.col; ag.car = rv.car; ag.skill = (rv.skill || 1) * D.skill * rr(r, 0.97, 1.03);
        ag.u = grid[k].s; ag.prog = grid[k].s - R.startS; ag.fin = 0; ag.rid = rv.id || ('crew' + ri); ag.wob = r() * TAU; ag.nosT = 0;
        g.agents.push(ag);
      }
      if (o.cops) { g.copsOn = true; }
      spawnTraffic(g, true);
    } else {
      g.paths = W.paths; g.grid = W.grid; g.type = 'free';
      var sp = o.spawn, P0;
      if (!sp || !isFinite(sp.x)) { P0 = pathAt(W.paths[0], (o.seed % 1000) / 1000 * W.paths[0].len); sp = { x: P0.x - P0.tz * 1.8, z: P0.z + P0.tx * 1.8, a: Math.atan2(P0.tx, P0.tz) }; }
      g.p = newPlayer(st, sp.x, sp.z, sp.a, W.H(sp.x, sp.z));
      if (sp.dmg) g.p.dmg = clamp(sp.dmg, 0, 0.9);
      g.copsOn = true;
      g.phase = o.escape ? 'count' : 'race'; g.countT = o.escape ? 2.2 : 0;
      settle(g);
      spawnTraffic(g, true);
      for (var pc = 0; pc < 2; pc++) spawnCop(g, 'patrol');
      if (o.escape) { g.startHeat = o.heat || 2; }
    }
    return g;
  }
  function newAgent(g, kind, P, s, dir, lat, v) {
    return { kind: kind, P: P, s: s, dir: dir, lat: lat, latT: lat, latV: 0, v: v, vT: v, x: 0, z: 0, y: 0, a: 0, yaw: 0, spin: 0, spinW: 0, model: 0, col: null, id: Math.random(), brake: 0, near: 0, laneK: 0, cruise: v, hitT: 0, mode: kind === 'cop' ? 'patrol' : '', los: false, sir: Math.random() * 6 };
  }
  // the player's position on the drivable corridor (and the route)
  function settle(g) {
    var p = g.p, q = query(g.grid, p.x, p.z, p.q);
    if (q) p.y = q.y;
    return q;
  }
  function laneLat(P, i, dir, k) { var L = Math.max(1, P.lanes[i]); k = Math.min(k, L - 1); return dir * (0.5 + k) * LANE * (P.hw[i] > L * LANE + 0.35 ? 1 : (P.hw[i] - 0.3) / (L * LANE)); }

  // ---- traffic ----
  var TMP = {}, TMP2 = {};
  function trafficWanted(g) { return Math.round((g.kind === 'race' ? 16 : 22) * g.D.traffic); }
  function spawnTraffic(g, initial) {
    var want = trafficWanted(g), have = 0, i;
    for (i = 0; i < g.agents.length; i++) if (g.agents[i].kind === 'traffic') have++;
    var guard = 0;
    while (have < want && guard++ < want * 6) {
      var P, s, dir = g.r() < 0.5 ? 1 : -1;
      if (g.kind === 'race') {
        P = g.path;
        var ahead = initial ? rr(g.r, 120, 1400) : rr(g.r, 380, 700) * (g.r() < 0.8 ? 1 : -1);
        s = g.p.u + ahead;
        if (!P.closed && (s < 0 || s > P.len)) continue;
        if (initial && ahead < 140) continue;
      } else {
        P = pick(g.r, g.W.paths); s = g.r() * P.len;
        var pp = pathAt(P, s, TMP), dd = Math.hypot(pp.x - g.p.x, pp.z - g.p.z);
        if (dd < (initial ? 90 : 280) || dd > 650) continue;
      }
      s = wrapS(P, s);
      var a0 = pathAt(P, s, TMP), lk = Math.floor(g.r() * Math.max(1, a0.lanes)), lat = laneLat(P, a0.i, dir, lk);
      var v = rr(g.r, 11, 17) * (P.kind === 'hwy' ? 1.45 : 1);
      var ag = newAgent(g, 'traffic', P, s, dir, lat, v);
      ag.laneK = lk; ag.cruise = v; ag.model = Math.floor(g.r() * TRAFFIC.length); ag.col = pick(g.r, TCOL);
      if (crowded(g, ag)) continue;
      place(ag);
      g.agents.push(ag); have++;
    }
  }
  var TCOL = [[200, 200, 196], [60, 64, 72], [150, 30, 30], [30, 60, 120], [220, 220, 220], [120, 120, 112], [180, 150, 90], [40, 90, 60], [230, 190, 40], [90, 40, 30]];
  function crowded(g, ag) {
    for (var i = 0; i < g.agents.length; i++) { var b = g.agents[i]; if (b.P === ag.P && Math.abs(dS(ag.P, b.s, ag.s)) < 16 && Math.abs(b.lat - ag.lat) < 2.5) return true; }
    return false;
  }
  function place(ag) {
    var a = pathAt(ag.P, ag.s, TMP2);
    ag.x = a.x - a.tz * ag.lat; ag.z = a.z + a.tx * ag.lat; ag.y = a.y;
    ag.a = Math.atan2(a.tx * ag.dir, a.tz * ag.dir) + ag.yaw;
    ag.tx = a.tx; ag.tz = a.tz; ag.hw = a.hw; ag.k = a.k; ag.i = a.i;
    var b = pathAt(ag.P, ag.s + ag.dir * 2, TMP2);
    ag.pitch = Math.atan2(b.y - ag.y, 2);
  }

  // ---- the step ----
  function step(g, inp, dt) {
    g.t += dt;
    if (g.phase === 'count') {
      var before = Math.ceil(g.countT);
      g.countT -= dt;
      if (Math.ceil(g.countT) !== before && g.countT > 0) g.ev.push({ t: 'beep', n: Math.ceil(g.countT) });
      if (g.countT <= 0) {
        g.phase = 'race'; g.ev.push({ t: 'go' });
        if (g.escape) startPursuit(g, g.startHeat || 2);
        else if (g.copsOn && g.kind === 'race') startPursuit(g, 1);
      }
      inp = { steer: inp.steer, gas: 0, brake: 0, hb: 0, nos: 0, sens: inp.sens, frozen: inp.gas };
    }
    if (g.phase === 'done' || g.phase === 'over') inp = { steer: 0, gas: 0, brake: 1, hb: 0, nos: 0, sens: 1 };
    stepPlayer(g, inp, dt);
    if (g.phase !== 'count') stepAgents(g, dt);
    collideCars(g, dt);
    if (g.kind === 'race') stepRace(g, dt); else stepFree(g, dt);
    if (g.copsOn && g.phase === 'race') stepPolice(g, dt);
    // keep traffic around the player
    if (((g.t * 60) | 0) % 30 === 0) recycle(g);
  }

  function stepPlayer(g, inp, dt) {
    var p = g.p, c = p.st, fx = Math.sin(p.a), fz = Math.cos(p.a), rx = -fz, rz = fx;
    var vf = p.vx * fx + p.vz * fz, vr = p.vx * rx + p.vz * rz, spd = Math.abs(vf);
    var target = clamp((inp.steer || 0) * (inp.sens || 1), -1, 1);
    p.steer += (target - p.steer) * Math.min(1, dt * (Math.abs(target) > Math.abs(p.steer) ? 7 : 10));
    var gas = inp.gas ? 1 : 0, brake = inp.brake ? 1 : 0, hb = inp.hb ? 1 : 0;
    var top = c.top * (1 - 0.2 * Math.min(1, p.dmg));
    p.nosOn = !!(inp.nos && gas && p.nos > 0.02 && vf > 3);
    if (p.nosOn) { if (!p.nosWas) g.ev.push({ t: 'nos' }); p.nos = Math.max(0, p.nos - dt * 0.3 / c.nosK); }
    p.nosWas = p.nosOn;
    var v0 = vf;
    // longitudinal
    if (gas && !brake) {
      if (vf < -0.5) vf = Math.min(0, vf + c.brake * dt);
      else if (hb && spd < 9) { p.burn = Math.min(1, p.burn + dt * 2); }   // burnout: spin the wheels, stay put
      else {
        var topN = p.nosOn ? top * (1.16 + 0.04 * c.nosK) : top, ratio = Math.max(0, vf) / topN;
        var acc = c.acc * Math.max(0, 1 - Math.pow(ratio, 1.7)) + (p.nosOn ? c.acc * 0.55 * c.nosK : 0);
        if (ratio > 1) acc = -(ratio - 1) * 20;
        if (p.shiftT > 0) acc *= 0.55;
        vf += acc * dt;
      }
    } else if (brake) {
      if (vf > 0.5) vf = Math.max(0, vf - c.brake * dt);
      else if (!gas) vf = Math.max(-11, vf - 5.5 * dt);      // reverse
      else vf = Math.max(0, vf - c.brake * dt);
    } else {
      var coast = 0.9 + 0.00028 * vf * vf;
      vf -= sgn(vf) * Math.min(Math.abs(vf), coast * dt);
    }
    if (!(gas && hb)) p.burn = Math.max(0, p.burn - dt * 2);
    if (hb) vf -= sgn(vf) * Math.min(Math.abs(vf), 3.2 * dt);
    if (p.off) vf -= sgn(vf) * Math.min(Math.abs(vf), (1.5 + Math.abs(vf) * 0.03) * dt);
    if (g.rain) vf -= sgn(vf) * Math.min(Math.abs(vf), 0.2 * dt);
    spd = Math.abs(vf);
    // drift state: started by the handbrake (or a big slide) and held by the throttle
    var slip = Math.atan2(vr, Math.max(2, spd));
    if (hb && spd > 9) p.driftT = 0.5;
    else if (Math.abs(slip) > 0.14 && spd > 12 && gas && p.driftT > 0) p.driftT = Math.max(p.driftT, 0.25);
    p.driftT = Math.max(0, p.driftT - dt);
    var rainK = g.rain ? 0.82 : 1;
    var grip = c.grip * rainK * (hb ? 1.0 : p.driftT > 0 ? 2.6 : 9);
    vr *= Math.exp(-grip * dt);
    // yaw
    var del = p.steer * lerp(0.58, 0.11, clamp(spd / 62, 0, 1)) * c.turn;
    var wT = -vf * Math.tan(del) / 2.6, latMax = 15.5 * c.grip * rainK * (hb ? 1.55 : p.driftT > 0 ? 1.3 : 1);
    if (Math.abs(wT) * Math.max(spd, 1) > latMax) wT = sgn(wT) * latMax / Math.max(spd, 1);
    if (hb && spd > 9) wT *= 1.3;
    p.w += (wT - p.w) * Math.min(1, dt * (hb ? 3.2 : 6.5));
    p.a = wrapA(p.a + p.w * dt);
    p.vx = fx * vf + rx * vr; p.vz = fz * vf + rz * vr;
    p.lastX = p.x; p.lastZ = p.z;
    p.x += p.vx * dt; p.z += p.vz * dt;
    p.vf = vf; p.slip = slip; p.hb = !!hb; p.brakeOn = !!brake && vf > 0.5; p.rev = vf < -0.5;
    p.acc = (vf - v0) / dt;
    // drifting: nitro back, points
    var drifting = Math.abs(slip) > 0.16 && spd > 13;
    if (drifting) { p.drift += dt; p.nos = Math.min(c.nosCap, p.nos + dt * 0.11); g.driftPts += dt * spd * 2; }
    else if (p.drift > 0) { if (p.drift > 0.8) g.ev.push({ t: 'drift', pts: Math.round(g.driftPts) }); g.score += Math.round(g.driftPts); g.driftPts = 0; p.drift = 0; }
    p.nos = Math.min(c.nosCap, p.nos + dt * 0.012);
    // gears / rpm
    var gears = [0.2, 0.36, 0.52, 0.68, 0.84, 1.02], gi = 0, sv = Math.max(0, vf) / top;
    while (gi < 5 && sv > gears[gi] * 0.97) gi++;
    var gear = vf < -0.5 ? 0 : gi + 1;
    if (gear !== p.gear && gear > 0 && p.gear > 0) { p.shiftT = 0.18; g.ev.push({ t: 'shift', up: gear > p.gear }); }
    p.shiftT = Math.max(0, (p.shiftT || 0) - dt);
    p.gear = gear;
    var lo = gi ? gears[gi - 1] * 0.6 : 0, rpmT = vf < -0.5 ? 1200 + Math.abs(vf) * 300 : 900 + 6600 * clamp((sv - lo) / (gears[gi] - lo), 0, 1.05);
    if (p.burn > 0) rpmT = 7200; else if (gas && spd < 1) rpmT = Math.max(rpmT, 3400);
    p.rpm += (rpmT - p.rpm) * Math.min(1, dt * 9);
    p.wheel += vf * dt / 0.34 + (p.burn > 0 ? dt * 40 : 0);
    // walls
    wallCollide(g, dt);
  }
  function wallCollide(g, dt) {
    var p = g.p, q = settle(g);
    if (!q) { p.x = p.lastX; p.z = p.lastZ; p.vx *= -0.3; p.vz *= -0.3; q = settle(g); if (!q) return; }
    p.off = Math.abs(q.lat) > q.hw + 0.2;
    p.onP = q.p; p.onS = q.s; p.onLat = q.lat;
    var lim = 1.15;              // half the car's width, and lamp posts at the sidewalk's edge
    var ex = q.excess + lim;
    if (ex > 0) {
      var sd = sgn(q.lat) || 1, nx = -(-q.tz) * sd, nz = -(q.tx) * sd;     // inward wall normal
      p.x += nx * ex; p.z += nz * ex;
      var vn = p.vx * nx + p.vz * nz;
      if (vn < 0) {
        var imp = -vn;
        p.vx -= 1.3 * vn * nx; p.vz -= 1.3 * vn * nz;
        var fr = Math.max(0.55, 1 - imp * 0.035);
        p.vx *= fr; p.vz *= fr;
        p.w *= 0.5;
        if (imp > 2.5) {
          var dm = imp * 0.003 * p.st.armor * g.D.dmg;
          p.dmg = Math.min(1, p.dmg + dm);
          g.ev.push({ t: imp > 11 ? 'crash' : 'hit', hard: imp > 11, v: imp, side: sd, x: p.x, z: p.z });
          if (g.pursuit) g.heatPts += imp > 11 ? 1 : 0;
        } else if (Math.hypot(p.vx, p.vz) > 8) g.ev.push({ t: 'scrape', side: sd });
      }
      // turn the nose along the wall a little
      var wa = Math.atan2(q.tx, q.tz), fa = Math.cos(p.a - wa) >= 0 ? wa : wa + Math.PI;
      p.a = wrapA(p.a + wrapA(fa - p.a) * Math.min(1, dt * 4));
    }
  }

  // ---- AI cars ----
  function aheadOf(g, ag, look) {
    // nearest car ahead of ag in its direction, within `look` meters, in a similar lateral spot
    var best = look, who = null, i;
    for (i = 0; i < g.agents.length; i++) {
      var b = g.agents[i];
      if (b === ag || b.P !== ag.P) continue;
      var d = dS(ag.P, ag.s, b.s) * ag.dir;
      if (d <= 0 || d > best) continue;
      if (Math.abs(b.lat - ag.lat) > 2.3) continue;
      best = d; who = b;
    }
    // the player
    var pd = playerOnPath(g, ag.P);
    if (pd) { var d2 = dS(ag.P, ag.s, pd.s) * ag.dir; if (d2 > 0 && d2 < best && Math.abs(pd.lat - ag.lat) < 2.4) { best = d2; who = g.p; } }
    return who ? { d: best, b: who } : null;
  }
  function playerOnPath(g, P) {
    var p = g.p;
    if (g.kind === 'race' && P === g.path) return { s: wrapS(P, p.u), lat: p.rlat || 0, v: p.vf * (p.dirR || 1) };
    if (g.kind === 'free' && p.onP != null && g.W.paths[p.onP] === P) return { s: p.onS, lat: p.onLat, v: (p.vx * P.tx[ix(P, Math.round(p.onS / P.step))] + p.vz * P.tz[ix(P, Math.round(p.onS / P.step))]) };
    return null;
  }
  function stepAgents(g, dt) {
    for (var i = 0; i < g.agents.length; i++) {
      var ag = g.agents[i];
      if (ag.kind === 'traffic') driveTraffic(g, ag, dt);
      else if (ag.kind === 'rival') driveRival(g, ag, dt);
      else if (ag.kind === 'cop') driveCop(g, ag, dt);
      if (ag.spin > 0) { ag.spin -= dt; ag.vT = 0; ag.yaw += ag.spinW * dt; ag.spinW *= Math.exp(-1.2 * dt); }
      else if (ag.mode !== 'block') ag.yaw *= Math.exp(-3 * dt);
      var acc = ag.kind === 'traffic' ? 3 : ag.st ? ag.st.acc * Math.max(0.15, 1 - Math.pow(Math.max(0, ag.v) / (ag.st.top * 1.1 + 1), 1.7)) : 9;
      var dv = ag.vT - ag.v;
      ag.v += dv > 0 ? Math.min(dv, acc * dt) : Math.max(dv, -(ag.spin > 0 ? 7 : 14) * dt);
      var ds = ag.dir * ag.v * dt;
      ag.s += ds;
      if (ag.u != null) ag.u += ds;
      if (!ag.P.closed && (ag.s < 0 || ag.s > ag.P.len)) {
        if (ag.kind === 'rival' || ag.mode === 'block') { ag.s = clamp(ag.s, 0, ag.P.len); ag.v = 0; }
        else { pathEnd(g, ag); if (ag.dead) continue; }
      }
      ag.s = wrapS(ag.P, ag.s);
      var lim = Math.max(0.5, pathAt(ag.P, ag.s, TMP).hw - 1.0);
      var dl = ag.latT - ag.lat, lr = (ag.kind === 'traffic' ? 1.6 : 3.4) * dt;
      ag.lat += clamp(dl, -lr, lr) + ag.latV * dt;
      ag.latV *= Math.exp(-3.5 * dt);
      ag.lat = clamp(ag.lat, -lim, lim);
      if (ag.kind !== 'traffic' && ag.spin <= 0 && ag.mode !== 'block') ag.yaw = clamp(ag.yaw + (clamp(dl, -lr, lr) / Math.max(dt, 1e-3)) / Math.max(4, ag.v) * 0.08, -0.25, 0.25) * 0.9;
      place(ag);
      ag.hitT = Math.max(0, ag.hitT - dt);
    }
    for (var k = g.agents.length - 1; k >= 0; k--) if (g.agents[k].dead) g.agents.splice(k, 1);
  }
  function pathEnd(g, ag) {
    // free roam: a cross-town road ends on the ring; join it
    var P = ag.P, atEnd = ag.s > P.len / 2, stop = atEnd ? P.stops[P.stops.length - 1] : P.stops[0];
    if (!stop || g.kind === 'race') { ag.dead = true; return; }
    var nd = g.W.nodes[stop.node], l = null;
    for (var i = 0; i < nd.links.length; i++) if (g.W.paths[nd.links[i].p] !== P) l = nd.links[i];
    if (!l) { ag.dead = true; return; }
    var Q = g.W.paths[l.p], dir = ag.kind === 'cop' && ag.toward ? ag.toward(Q, l.s) : (g.r() < 0.5 ? 1 : -1);
    ag.P = Q; ag.s = l.s + dir * 3; ag.dir = dir;
    var a0 = pathAt(Q, ag.s, TMP);
    ag.lat = ag.latT = laneLat(Q, a0.i, dir, ag.laneK);
    ag.v *= 0.6;
  }
  function driveTraffic(g, ag, dt) {
    var look = 14 + ag.v * 1.6, ah = aheadOf(g, ag, look), vT = ag.cruise;
    if (ah) { var bv = ah.b === g.p ? Math.max(0, Math.hypot(g.p.vx, g.p.vz)) : Math.max(0, ah.b.v * (ah.b.dir === ag.dir ? 1 : 0)); vT = Math.min(vT, ah.d < 9 ? 0 : bv + (ah.d - 9) * 0.5); }
    // bends
    var kk = Math.abs(pathAt(ag.P, ag.s + ag.dir * 20, TMP).k);
    vT = Math.min(vT, Math.sqrt(6 / Math.max(kk, 1e-4)));
    ag.vT = vT;
    var a0 = pathAt(ag.P, ag.s, TMP);
    ag.latT = laneLat(ag.P, a0.i, ag.dir, ag.laneK);
    ag.brake = vT < ag.v - 0.5 ? 1 : 0;
    // near misses with the player
    if (ag.near > 0) ag.near -= dt;
  }
  function driveRival(g, ag, dt) {
    var R = g.R, P = ag.P;
    if (g.phase !== 'race' && g.phase !== 'done' && g.phase !== 'over') { ag.vT = 0; return; }
    if (ag.fin) { ag.vT = Math.max(0, ag.v - 6 * dt); ag.latT = ag.lat; return; }
    var look = ag.s + ag.dir * (6 + ag.v * 0.45), ia = ix(P, Math.round(wrapS(P, look) / P.step));
    var gripK = Math.sqrt(ag.st.grip), sk = ag.skill;
    // rubber band: a little help or a little drag, relative to the player
    var gap = ag.prog - g.p.prog, rb = g.D.rubber;
    var band = gap > 90 ? 1 - Math.min(0.09, (gap - 90) / 2500) * rb : gap < -60 ? 1 + Math.min(0.08, (-gap - 60) / 2000) * rb : 1;
    var vT = Math.min(ag.st.top * sk * band, R.vref[ia] * gripK * (0.94 + 0.06 * sk) * band);
    // nitro on straights
    ag.nosOn = false;
    if (ag.nosT > 0) { ag.nosT -= dt; ag.nosOn = true; vT = Math.min(vT * 1.12, R.vref[ia] * gripK); }
    else if (g.r() < dt * 0.05 * (ag.rid === 'juno' ? 3 : 1) && R.vref[ia] > ag.st.top) ag.nosT = 2.2;
    var line = R.line[ag.i != null ? ag.i : ia] + Math.sin(g.t * 0.7 + ag.wob) * 0.6;
    // avoid cars ahead (traffic, rivals, the player)
    var want = line, slow = false, i;
    var cand = [line, line + 3.3, line - 3.3, line + 6, line - 6];
    var lim = Math.max(0.5, P.hw[ia] - 1.2);
    function blocked(lat) {
      for (var k = 0; k < g.agents.length; k++) {
        var b = g.agents[k];
        if (b === ag || b.P !== P) continue;
        var d = dS(P, ag.s, b.s), rel = ag.v - (b.dir === ag.dir ? b.v : -b.v);
        if (d <= -3 || d > 8 + Math.max(0, rel) * 1.7) continue;
        if (Math.abs(b.lat - lat) < 2.4) return true;
      }
      var pd = playerOnPath(g, P);
      if (pd) { var d2 = dS(P, ag.s, pd.s); if (d2 > -2 && d2 < 6 + Math.max(0, ag.v - pd.v) * 1.4 && Math.abs(pd.lat - lat) < 2.4) return true; }
      return false;
    }
    if (blocked(ag.lat) || blocked(line)) {
      want = null;
      for (i = 0; i < cand.length; i++) { var c = clamp(cand[i], -lim, lim); if (!blocked(c)) { want = c; break; } }
      if (want == null) { want = ag.lat; slow = true; }
    }
    if (ag.rid === 'dagger') { var pd2 = playerOnPath(g, P); if (pd2 && Math.abs(dS(P, ag.s, pd2.s)) < 7) want = pd2.lat; }
    ag.latT = clamp(want, -lim, lim);
    var ah = aheadOf(g, ag, 40);
    if (ah) { var bv = ah.b === g.p ? Math.max(0, g.p.vf * (g.p.dirR || 1)) : ah.b.v * (ah.b.dir === ag.dir ? 1 : 0); vT = Math.min(vT, bv + Math.max(0, ah.d - 7) * (slow ? 0.6 : 0.9)); }
    if (ag.hitT > 0) vT *= 0.85;
    ag.vT = Math.max(0, vT);
    ag.brake = vT < ag.v - 1 ? 1 : 0;
  }

  // ---- collisions between cars ----
  var CR = 1.05, COFF = 1.25;
  function collideCars(g, dt) {
    var p = g.p, ps = Math.sin(p.a), pc = Math.cos(p.a), i, a, b;
    for (i = 0; i < g.agents.length; i++) {
      var ag = g.agents[i], dx = ag.x - p.x, dz = ag.z - p.z;
      if (dx * dx + dz * dz > 36) {
        // near misses: passing a car fast and close
        if (ag.kind === 'traffic' && ag.near <= 0 && dx * dx + dz * dz < 64 && Math.hypot(p.vx, p.vz) > 22 && g.phase === 'race') {
          var side = Math.abs(dx * pc - dz * ps);
          if (side < 3.4 && Math.abs(dx * ps + dz * pc) < 2) { ag.near = 3; g.near++; p.nos = Math.min(p.st.nosCap, p.nos + 0.07); g.ev.push({ t: 'near' }); }
        }
        continue;
      }
      var as = Math.sin(ag.a), ac = Math.cos(ag.a), best = null;
      for (a = -1; a <= 1; a += 2) for (b = -1; b <= 1; b += 2) {
        var px = p.x + ps * COFF * a, pz = p.z + pc * COFF * a, qx = ag.x + as * COFF * b, qz = ag.z + ac * COFF * b;
        var ex = px - qx, ez = pz - qz, d = Math.hypot(ex, ez);
        if (d < 2 * CR && (!best || d < best.d)) best = { d: d, nx: ex / (d || 1), nz: ez / (d || 1) };
      }
      if (!best) continue;
      var pen = 2 * CR - best.d, nx = best.nx, nz = best.nz;
      var mp = p.st.mass, ma = ag.kind === 'cop' ? 1700 : ag.kind === 'traffic' ? (ag.model === 1 || ag.model === 3 ? 2100 : 1400) : (ag.st ? ag.st.mass : 1400);
      if (ag.mode === 'block') ma = 4000;
      var vax = ag.tx * ag.dir * ag.v + (-ag.tz) * ag.latV, vaz = ag.tz * ag.dir * ag.v + ag.tx * ag.latV;
      var vrel = (p.vx - vax) * nx + (p.vz - vaz) * nz;
      var wp = ma / (mp + ma);
      p.x += nx * pen * wp; p.z += nz * pen * wp;
      var push = pen * (1 - wp), nl = nx * -ag.tz + nz * ag.tx;          // along the agent's right
      ag.lat -= nl * push;
      if (vrel < 0) {
        var j = -(1.25) * vrel / (1 / mp + 1 / ma);
        p.vx += j / mp * nx; p.vz += j / mp * nz;
        var dvx = -j / ma * nx, dvz = -j / ma * nz;
        ag.v += (dvx * ag.tx + dvz * ag.tz) * ag.dir; ag.v = Math.max(0, ag.v);
        ag.latV += dvx * -ag.tz + dvz * ag.tx;
        var imp = -vrel;
        if (imp > 2) {
          p.dmg = Math.min(1, p.dmg + imp * 0.0028 * p.st.armor * g.D.dmg * (ag.kind === 'cop' ? 1.2 : 1));
          g.hits++;
          ag.hitT = 1;
          g.ev.push({ t: imp > 10 ? 'crash' : 'hit', hard: imp > 10, v: imp, side: sgn(nx * pc - nz * ps), car: ag.kind, x: (p.x + ag.x) / 2, z: (p.z + ag.z) / 2 });
          if (ag.kind === 'traffic' && imp > 8 && ag.spin <= 0) { ag.spin = 1.6; ag.spinW = (g.r() < 0.5 ? -1 : 1) * (2 + imp * 0.15); if (g.pursuit) g.heatPts += 2; else trafficCrash(g, ag); }
          if (ag.kind === 'cop') { g.copHits++; ag.spin = imp > 9 ? 1.2 : 0; ag.spinW = imp * 0.12; if (g.pursuit) { g.heatPts += imp > 9 ? 6 : 3; g.bounty += 250 * Math.max(1, g.heat); } else if (g.kind === 'free' && g.phase === 'race') startPursuit(g, 1); }
        }
      }
    }
    // agents against each other (on the same path)
    for (i = 0; i < g.agents.length; i++) for (var k = i + 1; k < g.agents.length; k++) {
      var A = g.agents[i], B = g.agents[k];
      if (A.P !== B.P) continue;
      var ds = dS(A.P, A.s, B.s);
      if (Math.abs(ds) > 4.6 || Math.abs(A.lat - B.lat) > 2.0) continue;
      var push2 = (2.0 - Math.abs(A.lat - B.lat)) * 0.5 * (A.lat < B.lat ? -1 : 1);
      if (A.mode !== 'block') A.lat += push2 * 0.5;
      if (B.mode !== 'block') B.lat -= push2 * 0.5;
      var rear = ds * A.dir > 0 ? A : B, front = rear === A ? B : A;
      if (rear.dir === front.dir && rear.v > front.v) { var mv = (rear.v + front.v) / 2; rear.v = Math.max(0, mv - 0.5); front.v = Math.max(front.v, mv); }
      else if (rear.dir !== front.dir && A.v + B.v > 6) {
        A.v *= 0.4; B.v *= 0.4;
        [A, B].forEach(function (X) { if (X.kind === 'traffic' && X.spin <= 0) { X.spin = 1.2; X.spinW = 2.5; } });
      }
    }
  }
  function trafficCrash(g, ag) {
    // a crash in sight of a patrol car starts a pursuit
    if (g.kind !== 'free') return;
    for (var i = 0; i < g.agents.length; i++) { var c = g.agents[i]; if (c.kind === 'cop' && Math.hypot(c.x - ag.x, c.z - ag.z) < 70) { startPursuit(g, 1); return; } }
  }

  // ---- race ----
  function trackRoute(g) {
    // progress along the (smoothed) route: search near the last sample only, so cutting through nothing counts
    var p = g.p, P = g.path, best = Infinity, bi = p.ri, i0 = p.ri;
    for (var k = -12; k <= 12; k++) {
      var i = ix(P, i0 + k), dx = P.x[i] - p.x, dz = P.z[i] - p.z, d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    var ia = ix(P, bi - 1), ib = ix(P, bi + 1), sx = P.x[ib] - P.x[ia], sz = P.z[ib] - P.z[ia], l2 = sx * sx + sz * sz || 1;
    var u = clamp(((p.x - P.x[ia]) * sx + (p.z - P.z[ia]) * sz) / l2, 0, 1);
    var s = (ia + u * (ib - ia + (P.closed && ib < ia ? P.n : 0))) * P.step;
    if (!P.closed) s = clamp(s, 0, P.len);
    var su = wrapS(P, p.u), ds = dS(P, su, wrapS(P, s));
    p.u += ds; p.ri = bi;
    var tl = Math.sqrt(l2), tx = sx / tl, tz = sz / tl;
    p.rlat = (p.x - P.x[bi]) * -tz + (p.z - P.z[bi]) * tx;
    p.dirR = sgn(p.vx * tx + p.vz * tz) || 1;
    p.wrongT = (p.vx * tx + p.vz * tz) < -4 ? (p.wrongT || 0) + 1 / 60 : 0;
  }
  function stepRace(g, dt) {
    var p = g.p, R = g.R;
    trackRoute(g);
    var all = [p].concat(g.agents.filter(function (a) { return a.kind === 'rival'; }));
    all.forEach(function (c) {
      c.prog = c.u - R.startS;
      if (!c.fin && c.prog >= g.total && g.phase === 'race') {
        c.fin = g.t; c.place = 1 + all.filter(function (o) { return o !== c && o.fin; }).length;
        if (c === p) { g.ev.push({ t: 'finish', place: c.place }); g.phase = 'done'; g.doneT = 0; }
      }
      // laps (circuits): count crossings of the start line
      if (R.closed) { var lap = Math.floor(c.prog / R.len); if (lap > (c.lap || 0) && lap < g.laps && !c.fin) { c.lap = lap; if (c === p) g.ev.push({ t: 'lap', n: lap + 1, final: lap + 1 === g.laps }); } }
    });
    if (p.wrongT > 1.2 && !g.wrong) { g.wrong = 1; g.ev.push({ t: 'wrong' }); } else if (!p.wrongT) g.wrong = 0;
    if (g.phase === 'done') { g.doneT += dt; if (g.doneT > 2.5) { g.phase = 'over'; g.result = standings(g); g.ev.push({ t: 'done' }); } }
  }
  function placeOf(g) {
    var p = g.p, n = 1;
    if (p.fin) return p.place;
    g.agents.forEach(function (a) { if (a.kind === 'rival' && (a.fin || a.prog > p.prog)) n++; });
    return n;
  }
  function racers(g) { return 1 + g.agents.filter(function (a) { return a.kind === 'rival'; }).length; }
  // final order: finished cars by time, the rest by projected time
  function standings(g) {
    var rows = [], R = g.R;
    function proj(c, top) { return c.fin || (g.t + Math.max(0, g.total - c.prog) / Math.max(top * 0.7, 20)); }
    rows.push({ id: 'you', you: 1, name: 'You', t: proj(g.p, g.p.st.top), fin: !!g.p.fin, col: null });
    g.agents.forEach(function (a) { if (a.kind === 'rival') rows.push({ id: a.rid, name: a.name, t: proj(a, a.st.top * a.skill), fin: !!a.fin, col: a.col }); });
    rows.sort(function (a, b) { return a.t - b.t; });
    rows.forEach(function (r, i) { r.pos = i + 1; });
    void R;
    return rows;
  }

  // ---- free roam ----
  function stepFree(g, dt) {
    var p = g.p;
    if (g.phase !== 'race') return;
    // patrol: speeding past a cruiser starts a pursuit
    if (!g.pursuit) {
      var spd = Math.hypot(p.vx, p.vz);
      for (var i = 0; i < g.agents.length; i++) {
        var c = g.agents[i];
        if (c.kind !== 'cop') continue;
        var d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < 45 && spd > 34) { startPursuit(g, 1); g.ev.push({ t: 'spotted' }); break; }
      }
      // race markers
      if (!g.escape) for (var m = 0; m < g.W.markers.length; m++) {
        var mk = g.W.markers[m], dm = Math.hypot(mk.x - p.x, mk.z - p.z);
        if (dm < 10 && g.markerCool !== m) { g.markerCool = m; g.ev.push({ t: 'marker', m: m }); }
        else if (g.markerCool === m && dm > 40) g.markerCool = -1;
      }
    }
  }
  function startPursuit(g, heat) {
    if (g.pursuit) return;
    g.pursuit = true; g.heat = Math.max(1, heat | 0); g.heatPts = [0, 0, 18, 45, 85, 135][g.heat]; g.evadeT = 0; g.bustT = 0; g.roadT = 18; g.nextCop = 0;
    g.maxHeat = Math.max(g.maxHeat, g.heat);
    g.agents.forEach(function (a) { if (a.kind === 'cop') { a.mode = 'chase'; } });
    g.ev.push({ t: 'pursuit', heat: g.heat });
  }
  function heatLevel(pts) { return pts >= 135 ? 5 : pts >= 85 ? 4 : pts >= 45 ? 3 : pts >= 18 ? 2 : 1; }
  function spawnCop(g, mode) {
    var P, s, dir, guard = 0, p = g.p;
    while (guard++ < 40) {
      if (g.kind === 'race') { P = g.path; s = wrapS(P, p.u - (mode === 'chase' ? rr(g.r, 160, 260) : rr(g.r, -600, 600))); dir = 1; }
      else {
        P = pick(g.r, g.W.paths); s = g.r() * P.len; dir = g.r() < 0.5 ? 1 : -1;
        var a = pathAt(P, s, TMP), d = Math.hypot(a.x - p.x, a.z - p.z);
        if (mode === 'chase' ? (d < 200 || d > 420) : (d < 150 || d > 600)) continue;
      }
      var a0 = pathAt(P, s, TMP), ag = newAgent(g, 'cop', P, s, dir, laneLat(P, a0.i, dir, 0), mode === 'chase' ? 24 : 14);
      ag.mode = mode; ag.cruise = 14;
      ag.st = { top: 58 + g.heat * 4, acc: 9 + g.heat, grip: 1, mass: 1700 };
      if (crowded(g, ag)) continue;
      place(ag); g.agents.push(ag);
      return ag;
    }
    return null;
  }
  function roadblock(g) {
    var p = g.p, P, s, dir;
    if (g.kind === 'race') { P = g.path; s = p.u + 260; dir = 1; }
    else {
      if (p.onP == null) return;
      P = g.W.paths[p.onP];
      var a0 = pathAt(P, p.onS, TMP);
      dir = sgn(p.vx * a0.tx + p.vz * a0.tz) || 1; s = p.onS + dir * 250;
      if (!P.closed && (s < 20 || s > P.len - 20)) return;
      if (inZone(P, s, 10)) s += dir * 40;
    }
    s = wrapS(P, s);
    var a = pathAt(P, s, TMP), hw = a.hw, n = Math.max(2, Math.round(hw * 2 / 4.6)), gap = Math.floor(g.r() * n);
    for (var k = 0; k < n; k++) {
      if (k === gap && g.heat < 5) continue;
      var lat = -hw + 2.2 + k * (2 * hw - 4.4) / Math.max(1, n - 1);
      var ag = newAgent(g, 'cop', P, s, dir, lat, 0);
      ag.mode = 'block'; ag.yaw = Math.PI / 2 * (k % 2 ? 1 : -1); ag.st = { top: 0, acc: 0, grip: 1, mass: 4000 }; ag.life = 40;
      place(ag); g.agents.push(ag);
    }
    g.ev.push({ t: 'roadblock' });
  }
  function driveCop(g, ag, dt) {
    var p = g.p;
    if (ag.mode === 'block') { ag.vT = 0; ag.v = 0; ag.life -= dt; var bd = Math.hypot(ag.x - p.x, ag.z - p.z); if (ag.life <= 0 && bd > 120) ag.dead = true; return; }
    if (ag.mode === 'patrol' || !g.pursuit) {
      ag.mode = 'patrol';
      var look = aheadOf(g, ag, 14 + ag.v * 1.5);
      ag.vT = look ? Math.max(0, (look.b === p ? 0 : look.b.v) + (look.d - 9) * 0.4) : ag.cruise;
      var a0 = pathAt(ag.P, ag.s, TMP); ag.latT = laneLat(ag.P, a0.i, ag.dir, 0);
      return;
    }
    var pd = playerOnPath(g, ag.P), d = Math.hypot(ag.x - p.x, ag.z - p.z), top = ag.st.top * g.D.cops * (0.94 + 0.02 * g.heat);
    var pspd = Math.hypot(p.vx, p.vz);
    if (pd) {
      var ds = dS(ag.P, ag.s, pd.s), want = sgn(ds) || ag.dir;
      if (want !== ag.dir) { ag.vT = 0; if (ag.v < 4) { ag.dir = want; ag.yaw += Math.PI; ag.yaw = wrapA(ag.yaw); } return; }
      var ad = Math.abs(ds);
      ag.vT = Math.min(top, ad > 50 ? top : pspd + (ad > 12 ? 10 : 4) + (g.heat >= 3 ? 3 : 0));
      var lim = Math.max(0.5, ag.hw - 1.2);
      ag.latT = ad < 60 ? clamp(pd.lat + (g.heat >= 4 && ad < 10 ? (ag.id < 0.5 ? 1.6 : -1.6) : 0), -lim, lim) : laneLat(ag.P, ag.i || 0, ag.dir, 0);
    } else {
      // another road: drive on, switch toward the player at junctions (see pathEnd/nodes)
      ag.vT = top * 0.9;
      var a1 = pathAt(ag.P, ag.s, TMP); ag.latT = laneLat(ag.P, a1.i, ag.dir, 0);
      junctionTurn(g, ag);
    }
  }
  // at a junction, a chasing cop takes the road that heads toward the player
  function junctionTurn(g, ag) {
    var P = ag.P, p = g.p;
    for (var i = 0; i < P.stops.length; i++) {
      var st = P.stops[i], d = dS(P, ag.s, st.s) * ag.dir;
      if (d < 0 || d > ag.v * (1 / 60) + 0.5) continue;
      var nd = g.W.nodes[st.node], best = null, bd = Infinity;
      nd.links.forEach(function (l) {
        var Q = g.W.paths[l.p];
        [-1, 1].forEach(function (dir) {
          if (!Q.closed && ((dir < 0 && l.s < 2) || (dir > 0 && l.s > Q.len - 2))) return;
          var a = pathAt(Q, l.s + dir * 90, TMP), dd = Math.hypot(a.x - p.x, a.z - p.z);
          if (dd < bd) { bd = dd; best = { Q: Q, s: l.s, dir: dir }; }
        });
      });
      if (best && (best.Q !== P || best.dir !== ag.dir)) {
        ag.P = best.Q; ag.s = best.s + best.dir * 2; ag.dir = best.dir; ag.v *= 0.55;
        var a2 = pathAt(ag.P, ag.s, TMP); ag.lat = ag.latT = laneLat(ag.P, a2.i, ag.dir, 0);
      }
      return;
    }
  }
  function stepPolice(g, dt) {
    var p = g.p, i, cops = 0, los = false, near = 0, spd = Math.hypot(p.vx, p.vz);
    if (!g.pursuit) return;
    for (i = 0; i < g.agents.length; i++) {
      var c = g.agents[i];
      if (c.kind !== 'cop') continue;
      if (c.mode !== 'block') cops++;
      var d = Math.hypot(c.x - p.x, c.z - p.z), pd = playerOnPath(g, c.P);
      c.los = d < 70 || (pd && Math.abs(dS(c.P, c.s, pd.s)) < 230 && d < 240);
      if (c.mode === 'block') c.los = c.los && d < 120;
      if (c.los) los = true;
      if (d < 9.5) near++;
    }
    g.cops = cops;
    // heat rises while they keep you in sight
    if (los) { g.heatPts += dt * (0.55 + 0.1 * g.heat); g.bounty += dt * 12 * g.heat; }
    var hl = heatLevel(g.heatPts);
    if (hl > g.heat) { g.heat = hl; g.maxHeat = Math.max(g.maxHeat, hl); g.ev.push({ t: 'heat', heat: hl }); }
    // reinforcements
    var want = Math.min(6, 1 + g.heat);
    g.nextCop -= dt;
    if (cops < want && g.nextCop <= 0) { spawnCop(g, 'chase'); g.nextCop = Math.max(2.5, 9 - g.heat); }
    // roadblocks at heat 3+
    g.roadT -= dt;
    if (g.heat >= 3 && g.roadT <= 0 && los) { roadblock(g); g.roadT = 38 - g.heat * 4; }
    // busted / evaded
    var busting = near > 0 && spd < 5.5;
    g.bustT = busting ? g.bustT + dt * (near > 1 ? 1.5 : 1) : Math.max(0, g.bustT - dt * 0.7);
    if (g.bustT >= 3 || (p.dmg >= 1 && near > 0)) { endPursuit(g, false); return; }
    var need = 5 + g.heat * 1.6;
    if (!los) g.evadeT += dt; else g.evadeT = Math.max(0, g.evadeT - dt * 3);
    g.lastLos = los ? 0 : g.lastLos + dt;
    g.evadeNeed = need;
    if (g.evadeT >= need) endPursuit(g, true);
  }
  function endPursuit(g, escaped) {
    var b = Math.round(g.bounty);
    g.pursuit = false; g.bustT = 0; g.evadeT = 0;
    g.agents = g.agents.filter(function (a) { return a.kind !== 'cop'; });
    if (escaped) { g.cash += b; g.ev.push({ t: 'evaded', bounty: b, heat: g.heat }); }
    else { g.ev.push({ t: 'busted', fine: Math.round(300 + g.heat * 250) }); }
    g.lastBounty = b; g.heat = 0; g.heatPts = 0; g.bounty = 0;
    if (g.escape) { g.phase = 'over'; g.result = { escaped: escaped, bounty: b }; g.ev.push({ t: 'done' }); return; }
    // fresh patrols, far away
    for (var k = 0; k < 2; k++) spawnCop(g, 'patrol');
  }
  function recycle(g) {
    var p = g.p;
    for (var i = g.agents.length - 1; i >= 0; i--) {
      var a = g.agents[i];
      if (a.kind === 'rival' || a.mode === 'block') continue;
      var far;
      if (g.kind === 'race') far = a.P === g.path ? Math.abs(dS(g.path, wrapS(g.path, p.u), a.s)) > 760 : true;
      else far = Math.hypot(a.x - p.x, a.z - p.z) > (a.kind === 'cop' && g.pursuit ? 900 : 700);
      if (far) g.agents.splice(i, 1);
    }
    spawnTraffic(g, false);
    if (g.kind === 'free' && !g.pursuit) { var pc = 0; g.agents.forEach(function (a) { if (a.kind === 'cop') pc++; }); if (pc < 2) spawnCop(g, 'patrol'); }
  }
  // R: back on the road, facing along it, stopped
  function resetCar(g) {
    var p = g.p, P, s, a, dir;
    if (g.kind === 'race') { P = g.path; s = wrapS(P, p.u); a = pathAt(P, s); dir = 1; }
    else {
      var q = query(g.grid, p.x, p.z, {});
      if (q) { P = g.W.paths[q.p]; s = q.s; } else { P = g.W.paths[0]; s = 0; }
      a = pathAt(P, s); dir = Math.cos(p.a - Math.atan2(a.tx, a.tz)) >= 0 ? 1 : -1;
    }
    var lat = clamp(g.kind === 'race' ? (p.rlat || 0) : (dir * 1.8), -(a.hw - 1.5), a.hw - 1.5);
    p.x = a.x - a.tz * lat; p.z = a.z + a.tx * lat; p.y = a.y;
    p.a = Math.atan2(a.tx * dir, a.tz * dir); p.vx = p.vz = 0; p.w = 0; p.steer = 0; p.driftT = 0;
    if (g.kind === 'race') { p.ri = a.i; }
    settle(g);
    g.ev.push({ t: 'reset' });
  }

  // ---- save / career ----
  function newSave() {
    return {
      v: 1, cash: 2000, cars: ['kestrel'], car: 'kestrel', upg: {}, paint: {},
      career: { tier: 0, done: {} }, best: { daily: { d: '', t: null }, quick: 0, bounty: 0, heat: 0 }, free: null,
      stats: { races: 0, wins: 0, busts: 0, escapes: 0 },
      set: { diff: 1, cam: 'chase', units: 'kmh', gfx: 'auto', time: 'auto', weather: 'auto', touch: 'buttons', autogas: false, shake: 1, sens: 1, qtype: 'circuit', qopp: 4, qlaps: 2, qcops: 0 }
    };
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    try {
      if (isFinite(o.cash)) s.cash = Math.max(0, Math.round(+o.cash));
      if (Array.isArray(o.cars)) { s.cars = o.cars.filter(function (id) { return CAR_BY[id]; }); if (s.cars.indexOf('kestrel') < 0) s.cars.unshift('kestrel'); }
      if (CAR_BY[o.car] && s.cars.indexOf(o.car) >= 0) s.car = o.car;
      if (o.upg && typeof o.upg === 'object') for (var id in o.upg) if (CAR_BY[id]) { var u = o.upg[id] || {}, v = {}; UPGS.forEach(function (U) { v[U.id] = clamp(Math.round(+u[U.id] || 0), 0, 3); }); s.upg[id] = v; }
      if (o.paint && typeof o.paint === 'object') for (var pid in o.paint) if (CAR_BY[pid]) { var pv = o.paint[pid]; if (pv && typeof pv === 'object') s.paint[pid] = { cur: clamp(pv.cur | 0, 0, PAINTS.length - 1), own: Array.isArray(pv.own) ? pv.own.filter(function (i) { return i >= 0 && i < PAINTS.length; }) : [0] }; }
      if (o.career && typeof o.career === 'object') { s.career.tier = clamp(o.career.tier | 0, 0, RIVALS.length); if (o.career.done && typeof o.career.done === 'object') for (var k in o.career.done) if (/^\d+-\d+$/.test(k)) s.career.done[k] = clamp(o.career.done[k] | 0, 0, 9); }
      if (o.best && typeof o.best === 'object') {
        if (o.best.daily && typeof o.best.daily === 'object') s.best.daily = { d: String(o.best.daily.d || ''), t: isFinite(o.best.daily.t) && o.best.daily.t !== null ? +o.best.daily.t : null };
        ['quick', 'bounty', 'heat'].forEach(function (k2) { if (isFinite(o.best[k2])) s.best[k2] = +o.best[k2]; });
      }
      if (o.free && typeof o.free === 'object' && isFinite(o.free.x) && isFinite(o.free.z) && isFinite(o.free.seed)) s.free = { seed: o.free.seed >>> 0, x: +o.free.x, z: +o.free.z, a: +o.free.a || 0, dmg: clamp(+o.free.dmg || 0, 0, 0.9) };
      if (o.stats && typeof o.stats === 'object') for (var st in s.stats) if (isFinite(o.stats[st])) s.stats[st] = +o.stats[st];
      if (o.set && typeof o.set === 'object') {
        var S = o.set, T = s.set;
        if (S.diff === 0 || S.diff === 1 || S.diff === 2) T.diff = S.diff;
        if (['chase', 'far', 'hood'].indexOf(S.cam) >= 0) T.cam = S.cam;
        if (S.units === 'kmh' || S.units === 'mph') T.units = S.units;
        if (['auto', 'low', 'med', 'high'].indexOf(S.gfx) >= 0) T.gfx = S.gfx;
        if (['auto', 'day', 'dusk', 'night'].indexOf(S.time) >= 0) T.time = S.time;
        if (['auto', 'clear', 'rain'].indexOf(S.weather) >= 0) T.weather = S.weather;
        if (S.touch === 'buttons' || S.touch === 'tilt') T.touch = S.touch;
        T.autogas = S.autogas === true;            // opt-in only: never accelerate without the player
        if (S.shake === 0 || S.shake === 1) T.shake = S.shake;
        if ([0.75, 1, 1.3].indexOf(+S.sens) >= 0) T.sens = +S.sens;
        if (S.qtype === 'circuit' || S.qtype === 'sprint') T.qtype = S.qtype;
        if ([3, 4, 5].indexOf(S.qopp) >= 0) T.qopp = S.qopp;
        if ([1, 2, 3].indexOf(S.qlaps) >= 0) T.qlaps = S.qlaps;
        if (S.qcops === 0 || S.qcops === 1) T.qcops = S.qcops;
      }
    } catch (e) { return newSave(); }
    return s;
  }
  function upgOf(save, id) { return save.upg[id] || (save.upg[id] = { eng: 0, tire: 0, nos: 0, armor: 0 }); }
  function upgCost(save, id, u) { var l = upgOf(save, id)[u], U = UPGS.filter(function (x) { return x.id === u; })[0]; return !U || l >= 3 ? Infinity : U.cost[l] * (1 + 0.25 * (CAR_BY[id] ? CAR_BY[id].ix : 0)); }
  function buyUpgrade(save, u) { var id = save.car, c = upgCost(save, id, u); if (!isFinite(c) || save.cash < c) return false; save.cash -= Math.round(c); upgOf(save, id)[u]++; return true; }
  function buyCar(save, id) {
    var c = CAR_BY[id]; if (!c) return false;
    if (save.cars.indexOf(id) >= 0) { save.car = id; return true; }
    if (save.cash < c.price) return false;
    save.cash -= c.price; save.cars.push(id); save.car = id; return true;
  }
  function paintOf(save, id) { return save.paint[id] || (save.paint[id] = { cur: 0, own: [0] }); }
  function buyPaint(save, i) {
    var pt = PAINTS[i], pr = paintOf(save, save.car); if (!pt) return false;
    if (pr.own.indexOf(i) >= 0) { pr.cur = i; return true; }
    if (save.cash < pt.cost) return false;
    save.cash -= pt.cost; pr.own.push(i); pr.cur = i; return true;
  }
  function carColor(save, id) { var pr = save.paint[id], pt = pr ? PAINTS[pr.cur] : null; return pt && pt.col ? pt.col : (CAR_BY[id] || CARS[0]).col; }
  var PRIZE = [1, 0.6, 0.35, 0.15, 0, 0];
  // returns { cash, passed, unlocked }
  function careerAward(save, ev, place, escaped) {
    var key = ev.tier + '-' + ev.i, out = { cash: 0, passed: false, unlocked: false, first: false };
    if (ev.type === 'escape') { out.passed = !!escaped; out.cash = escaped ? ev.prize : 0; }
    else if (ev.type === 'duel') { out.passed = place === 1; out.cash = place === 1 ? ev.prize : Math.round(ev.prize * 0.1); }
    else { out.passed = place <= 3; out.cash = Math.round(ev.prize * (PRIZE[place - 1] || 0) / 10) * 10; }
    var prev = save.career.done[key] || 0, score = out.passed ? (ev.type === 'escape' ? 1 : 10 - place) : 0;
    if (out.passed && !prev) out.first = true;
    if (!out.first) out.cash = Math.round(out.cash * 0.5 / 10) * 10;       // replays pay half
    if (score > prev) save.career.done[key] = score;
    save.cash += out.cash;
    if (ev.type === 'duel' && out.passed && save.career.tier === ev.tier) { save.career.tier = Math.min(RIVALS.length, ev.tier + 1); out.unlocked = true; }
    return out;
  }
  function careerRivals(tier, ev) {
    // tier rivals: the boss in the duel, crew around them otherwise
    var boss = RIVALS[Math.min(RIVALS.length - 1, tier)], r = mulberry32(ev.seed), out = [];
    if (ev.type === 'duel') return [{ id: boss.id, name: boss.name, car: boss.car, col: boss.col, skill: 1.03 + tier * 0.006, lvl: Math.min(3, Math.floor(tier / 2) + 1) }];
    for (var i = 0; i < ev.opp; i++) {
      var carI = clamp(Math.floor(tier / 2) + (r() < 0.4 ? 1 : 0) - (r() < 0.3 ? 1 : 0), 0, CARS.length - 1);
      out.push({ id: 'crew' + i, name: CREW[(i + tier * 3) % CREW.length], car: CARS[carI].id, col: CREW_COL[(i + tier) % CREW_COL.length], skill: 0.97 + tier * 0.006 + r() * 0.03, lvl: Math.min(3, Math.floor(tier / 3)) });
    }
    if (ev.i === 1 && tier > 0) out[0] = { id: boss.id, name: boss.name, car: boss.car, col: boss.col, skill: 1 + tier * 0.006, lvl: Math.min(3, Math.floor(tier / 2)) };
    return out;
  }
  function kmh(v) { return v * 3.6; }
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  var ENGINE = {
    STEP: STEP, SAMP: SAMP, LANE: LANE, SIDE: SIDE, GRID: GRID, DISTRICTS: DISTRICTS, CARS: CARS, CAR_BY: CAR_BY, TRAFFIC: TRAFFIC, POLICE: POLICE, PAINTS: PAINTS,
    UPGS: UPGS, DIFFS: DIFFS, RIVALS: RIVALS, CREW: CREW,
    mulberry32: mulberry32, hashStr: hashStr, clamp: clamp, lerp: lerp, wrapA: wrapA, cityName: cityName, makeHeight: makeHeight, catmull: catmull, makePath: makePath,
    pathAt: pathAt, wrapS: wrapS, dS: dS, ix: ix, makeGrid: makeGrid, query: query, makeWorld: makeWorld, district: district, riverDist: riverDist, inZone: inZone,
    makeRoute: makeRoute, carStats: carStats, newGame: newGame, step: step, placeOf: placeOf, racers: racers, standings: standings, startPursuit: startPursuit,
    endPursuit: endPursuit, heatLevel: heatLevel, resetCar: resetCar, spawnCop: spawnCop, roadblock: roadblock, laneLat: laneLat,
    newSave: newSave, normSave: normSave, upgOf: upgOf, upgCost: upgCost, buyUpgrade: buyUpgrade, buyCar: buyCar, paintOf: paintOf, buyPaint: buyPaint, carColor: carColor,
    careerEvents: careerEvents, careerAward: careerAward, careerRivals: careerRivals, dailyKey: dailyKey, dailyEvent: dailyEvent, kmh: kmh, fmtTime: fmtTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= browser only from here =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('redline.css');

  // ================= renderer (three.js; browser only) =================
  var QUALITY = {
    low: { dpr: 1, draw: 380, shadows: false, trees: 0.45, aa: false, rain: 450, clouds: 10, px: 0.9e6 },
    med: { dpr: 1.5, draw: 560, shadows: false, trees: 0.75, aa: true, rain: 800, clouds: 16, px: 1.6e6 },
    high: { dpr: 2, draw: 820, shadows: true, trees: 1, aa: true, rain: 1300, clouds: 22, px: 3.2e6 }
  };
  var TOD = {
    day: { top: [58, 108, 184], mid: [140, 184, 226], hor: [246, 210, 168], sun: [255, 214, 166], sunI: 3.3, sunEl: 0.36, hemiS: [176, 202, 236], hemiG: [126, 104, 76], hemiI: 1.0,
      fog: [232, 212, 184], exp: 1.0, win: 0, lamps: 0, cloud: [255, 246, 236], mtn: [150, 162, 186], water: [70, 118, 136], lights: 0.25 },
    dusk: { top: [44, 58, 112], mid: [176, 118, 132], hor: [255, 158, 96], sun: [255, 150, 84], sunI: 2.4, sunEl: 0.12, hemiS: [176, 150, 184], hemiG: [110, 80, 66], hemiI: 1.05,
      fog: [222, 150, 116], exp: 1.18, win: 0.55, lamps: 0.75, cloud: [255, 176, 150], mtn: [120, 104, 136], water: [80, 80, 110], lights: 0.7 },
    night: { top: [5, 8, 20], mid: [14, 20, 40], hor: [46, 44, 70], sun: [150, 170, 230], sunI: 0.6, sunEl: 0.7, hemiS: [84, 98, 140], hemiG: [40, 36, 40], hemiI: 0.75,
      fog: [30, 32, 52], exp: 1.4, win: 1.25, lamps: 1, cloud: [52, 56, 80], mtn: [36, 40, 60], water: [20, 30, 50], lights: 1 }
  };
  function lin(c) { return Math.pow(c / 255, 2.2); }
  function linA(c, k) { k = k == null ? 1 : k; return [lin(c[0]) * k, lin(c[1]) * k, lin(c[2]) * k]; }
  function mixC(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function smooth01(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  // a flat-shaded triangle soup with colors and uvs
  function Geo() { this.p = []; this.n = []; this.c = []; this.u = []; }
  Geo.prototype.tri = function (a, b, c, col, ua, ub, uc) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.c.push(col[0], col[1], col[2], col[0], col[1], col[2], col[0], col[1], col[2]);
    ua = ua || UV0; ub = ub || UV0; uc = uc || UV0;
    this.u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };
  var UV0 = [0.008, 0.008];
  // a quad whose front faces away from `ctr` (or along `out` when given as {o:[x,y,z]})
  Geo.prototype.quad = function (a, b, c, d, col, ctr, uv) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ox, oy, oz;
    if (ctr.o) { ox = ctr.o[0]; oy = ctr.o[1]; oz = ctr.o[2]; }
    else { ox = (a[0] + c[0]) / 2 - ctr[0]; oy = (a[1] + c[1]) / 2 - ctr[1]; oz = (a[2] + c[2]) / 2 - ctr[2]; }
    uv = uv || [UV0, UV0, UV0, UV0];
    if (nx * ox + ny * oy + nz * oz >= 0) { this.tri(a, b, c, col, uv[0], uv[1], uv[2]); this.tri(a, c, d, col, uv[0], uv[2], uv[3]); }
    else { this.tri(a, c, b, col, uv[0], uv[2], uv[1]); this.tri(a, d, c, col, uv[0], uv[3], uv[2]); }
  };
  // 8 corners: bottom b0..b3 and top t0..t3 in matching order around
  Geo.prototype.hexa = function (b, t, col, o) {
    o = o || {};
    var cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < 4; i++) { cx += b[i][0] + t[i][0]; cy += b[i][1] + t[i][1]; cz += b[i][2] + t[i][2]; }
    var C = [cx / 8, cy / 8, cz / 8], cs = o.cols || {};
    if (!o.noTop) this.quad(t[0], t[1], t[2], t[3], cs.top || col, C, o.uvTop);
    if (o.bottom) this.quad(b[0], b[1], b[2], b[3], cs.bot || col, C);
    for (i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      if (o.skip && o.skip[i]) continue;
      this.quad(b[i], b[j], t[j], t[i], (cs.side && cs.side[i]) || col, C, o.uvSide ? o.uvSide(i, b[i], b[j], t[j], t[i]) : null);
    }
  };
  // box centered (x, z) on the ground y, size w (along local z = heading), d (along local x), h; rot = heading
  function rotP(x, y, z, rot, lx, ly, lz) { var c = Math.cos(rot), s = Math.sin(rot); return [x + lx * c + lz * s, y + ly, z - lx * s + lz * c]; }
  Geo.prototype.box = function (x, y, z, rot, d, h, w, col, o) {
    var hx = d / 2, hz = w / 2, b = [], t = [], k = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    for (var i = 0; i < 4; i++) { b.push(rotP(x, y, z, rot, k[i][0], 0, k[i][1])); t.push(rotP(x, y + h, z, rot, k[i][0], 0, k[i][1])); }
    this.hexa(b, t, col, o);
  };
  Geo.prototype.cyl = function (x, y, z, r0, r1, h, n, col, o) {
    o = o || {};
    var C = [x, y + h / 2, z], ph = o.ph || 0;
    for (var i = 0; i < n; i++) {
      var a0 = ph + i / n * TAU, a1 = ph + (i + 1) / n * TAU;
      var b0 = [x + Math.cos(a0) * r0, y, z + Math.sin(a0) * r0], b1 = [x + Math.cos(a1) * r0, y, z + Math.sin(a1) * r0];
      var t0 = [x + Math.cos(a0) * r1, y + h, z + Math.sin(a0) * r1], t1 = [x + Math.cos(a1) * r1, y + h, z + Math.sin(a1) * r1];
      if (r1 > 0.001) this.quad(b0, b1, t1, t0, col, C); else this.tri(b0, b1, t0, col);
      if (r1 > 0.001 && !o.open) this.tri([x, y + h, z], t0, t1, o.capCol || col);
    }
    if (r1 <= 0.001) {
      // fix the cone's winding: rebuild facing out
      var m = this.p.length - n * 9;
      for (var k = 0; k < n; k++) {
        var base = m + k * 9, ax = this.p[base] - x, az = this.p[base + 2] - z, nx = this.n[base], nz = this.n[base + 2];
        if (nx * ax + nz * az < 0) this.flipLast(base);
      }
    }
  };
  Geo.prototype.flipLast = function (base) {
    var p = this.p, n = this.n, u = this.u, ub = base / 3 * 2;
    for (var c = 0; c < 3; c++) { var t = p[base + 3 + c]; p[base + 3 + c] = p[base + 6 + c]; p[base + 6 + c] = t; n[base + c] = -n[base + c]; n[base + 3 + c] = -n[base + 3 + c]; n[base + 6 + c] = -n[base + 6 + c]; }
    for (var d = 0; d < 2; d++) { var tu = u[ub + 2 + d]; u[ub + 2 + d] = u[ub + 4 + d]; u[ub + 4 + d] = tu; }
  };
  // a low-poly blob (trees, rocks)
  Geo.prototype.blob = function (x, y, z, rx, ry, rz, col, r, nLon, nLat) {
    nLon = nLon || 6; nLat = nLat || 4;
    var rows = [], C = [x, y, z], i, j;
    for (i = 0; i <= nLat; i++) {
      var v = i / nLat, phi = v * Math.PI, row = [];
      for (j = 0; j < nLon; j++) {
        var th = j / nLon * TAU + (i % 2) * Math.PI / nLon, k = (i === 0 || i === nLat) ? 1 : 0.86 + (r ? r() * 0.28 : 0.14);
        row.push([x + Math.sin(phi) * Math.cos(th) * rx * k, y - Math.cos(phi) * ry * k, z + Math.sin(phi) * Math.sin(th) * rz * k]);
      }
      rows.push(row);
    }
    for (i = 0; i < nLat; i++) for (j = 0; j < nLon; j++) {
      var a = rows[i][j], b = rows[i][(j + 1) % nLon], c = rows[i + 1][(j + 1) % nLon], d = rows[i + 1][j];
      var sh = 0.82 + 0.3 * (i / nLat);
      this.quad(a, b, c, d, [col[0] * sh, col[1] * sh, col[2] * sh], C);
    }
  };
  Geo.prototype.build = function (T) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('uv', new T.BufferAttribute(new Float32Array(this.u), 2));
    g.computeBoundingSphere();
    return g;
  };

  // ---- the car models (local: +z forward, y up), shared by the player and the AI ----
  function carGeo(body, paint, o) {
    o = o || {};
    var G = new Geo(), L = body.len, Wd = body.wid, Hh = body.h, fl = 0.22, belt = fl + (Hh - fl) * (body.van ? 0.42 : 0.52), roof = Hh;
    var P = paint, dark = linA([28, 28, 32]), glass = linA([38, 50, 64]), trim = linA([44, 44, 48]), chrome = linA([150, 150, 156]);
    var hx = Wd / 2, hz = L / 2, nose = (belt - fl) * 0.38, tail = (belt - fl) * 0.2;
    // lower body with a sloped nose and a softer tail
    G.hexa([[-hx, fl, -hz], [hx, fl, -hz], [hx, fl, hz], [-hx, fl, hz]],
      [[-hx + 0.05, belt - tail, -hz + 0.05], [hx - 0.05, belt - tail, -hz + 0.05], [hx - 0.06, belt - nose, hz - 0.12], [-hx + 0.06, belt - nose, hz - 0.12]], P, { bottom: true, cols: { bot: dark } });
    // bumpers / skirt
    G.box(0, fl - 0.06, hz - 0.06, 0, Wd - 0.04, 0.2, 0.16, trim);
    G.box(0, fl - 0.06, -hz + 0.06, 0, Wd - 0.04, 0.2, 0.16, trim);
    // cabin (glass) with a painted roof
    var cl = L * body.cab, cc = L * body.cabPos, ws = (roof - belt) * (body.van ? 0.35 : 1.15), rs = (roof - belt) * (body.cls === 'coupe' || body.cls === 'super' ? 1.3 : 0.6), tw = 0.13;
    if (body.van) rs = 0.08;
    var cz0 = cc - cl / 2, cz1 = cc + cl / 2, tz0 = cz0 + rs, tz1 = cz1 - ws;
    if (tz1 - tz0 < 0.3) { var m = (tz0 + tz1) / 2; tz0 = m - 0.15; tz1 = m + 0.15; }
    var cb = [[-hx + 0.08, belt, cz0], [hx - 0.08, belt, cz0], [hx - 0.08, belt, cz1], [-hx + 0.08, belt, cz1]];
    var ct = [[-hx + tw + 0.08, roof - 0.04, tz0], [hx - tw - 0.08, roof - 0.04, tz0], [hx - tw - 0.08, roof - 0.04, tz1], [-hx + tw + 0.08, roof - 0.04, tz1]];
    G.hexa(cb, ct, glass, { noTop: true });
    G.hexa(ct.map(function (q) { return [q[0] * 0.98, q[1], q[2] + (q[2] > cc ? -0.04 : 0.04)]; }), ct.map(function (q) { return [q[0] * 0.96, roof, q[2] + (q[2] > cc ? -0.08 : 0.08)]; }), P);
    // pillars between the glass (B pillar)
    G.box(hx - 0.09, belt, (cz0 + cz1) / 2 - 0.1, 0, 0.04, roof - belt - 0.06, 0.12, P);
    G.box(-hx + 0.09, belt, (cz0 + cz1) / 2 - 0.1, 0, 0.04, roof - belt - 0.06, 0.12, P);
    if (body.bed) {
      // pickup bed rails behind the cab
      G.box(hx - 0.06, belt - 0.02, (-hz + cz0) / 2, 0, 0.1, 0.34, cz0 + hz - 0.2, P);
      G.box(-hx + 0.06, belt - 0.02, (-hz + cz0) / 2, 0, 0.1, 0.34, cz0 + hz - 0.2, P);
      G.box(0, belt - 0.02, -hz + 0.12, 0, Wd - 0.1, 0.34, 0.1, P);
    }
    if (body.scoop) G.box(0, belt - nose * 0.4, hz * 0.45, 0, 0.6, 0.12, 0.9, dark);
    if (body.police) {
      // doors in white, the rest stays dark
      var wh = linA([236, 236, 236]);
      G.box(hx + 0.005, fl + 0.12, cc, 0, 0.02, belt - fl - 0.18, cl * 0.95, wh);
      G.box(-hx - 0.005, fl + 0.12, cc, 0, 0.02, belt - fl - 0.18, cl * 0.95, wh);
      G.box(0, roof - 0.02, tz0 + (tz1 - tz0) / 2, 0, Wd * 0.55, 0.04, (tz1 - tz0) * 0.8, wh);
    }
    // spoilers
    var sp = body.spoiler;
    if (sp === 'wing' || sp === 'big') {
      var sh = sp === 'big' ? 0.36 : 0.24, swd = sp === 'big' ? Wd * 0.98 : Wd * 0.86;
      G.box(hx * 0.55, belt - tail, -hz + 0.25, 0, 0.06, sh, 0.12, dark);
      G.box(-hx * 0.55, belt - tail, -hz + 0.25, 0, 0.06, sh, 0.12, dark);
      G.box(0, belt - tail + sh, -hz + 0.22, 0, swd, 0.05, sp === 'big' ? 0.42 : 0.3, sp === 'big' ? dark : P);
      if (sp === 'big') { G.box(swd / 2, belt - tail + sh - 0.1, -hz + 0.22, 0, 0.03, 0.2, 0.44, dark); G.box(-swd / 2, belt - tail + sh - 0.1, -hz + 0.22, 0, 0.03, 0.2, 0.44, dark); }
    } else if (sp === 'duck') G.hexa([[-hx + 0.1, belt - tail, -hz + 0.05], [hx - 0.1, belt - tail, -hz + 0.05], [hx - 0.1, belt - tail, -hz + 0.4], [-hx + 0.1, belt - tail, -hz + 0.4]],
      [[-hx + 0.1, belt - tail + 0.12, -hz + 0.02], [hx - 0.1, belt - tail + 0.12, -hz + 0.02], [hx - 0.1, belt - tail, -hz + 0.4], [-hx + 0.1, belt - tail, -hz + 0.4]], P);
    else if (sp === 'lip') G.box(0, belt - tail, -hz + 0.1, 0, Wd * 0.8, 0.07, 0.16, dark);
    // grille, mirrors, plates
    G.box(0, fl + 0.12, hz + 0.005, 0, Wd * 0.45, 0.16, 0.02, dark);
    G.box(hx + 0.06, belt + 0.02, cz1 - 0.15, 0, 0.12, 0.09, 0.14, P);
    G.box(-hx - 0.06, belt + 0.02, cz1 - 0.15, 0, 0.12, 0.09, 0.14, P);
    G.box(0, fl + 0.08, -hz - 0.01, 0, 0.42, 0.12, 0.02, linA([220, 220, 210]));
    if (o.lights !== false) {
      var tl = linA([200, 24, 24]), hl = linA([240, 240, 230]);
      G.box(hx - 0.28, belt - tail - 0.16, -hz + 0.035, 0, 0.36, 0.1, 0.04, tl);
      G.box(-hx + 0.28, belt - tail - 0.16, -hz + 0.035, 0, 0.36, 0.1, 0.04, tl);
      G.box(hx - 0.3, belt - nose - 0.1, hz - 0.1, 0, 0.34, 0.08, 0.06, hl);
      G.box(-hx + 0.3, belt - nose - 0.1, hz - 0.1, 0, 0.34, 0.08, 0.06, hl);
    }
    if (o.wheels) {
      var wz = hz - Math.min(0.85, L * 0.19), wr = 0.34, ww = 0.24, wx = hx - 0.13;
      [[wx, wz], [-wx, wz], [wx, -wz], [-wx, -wz]].forEach(function (w) { wheelInto(G, w[0], wr, w[1], wr, ww, dark, chrome); });
    }
    void chrome;
    return G;
  }
  function wheelInto(G, x, y, z, r, w, tire, rim) {
    var n = 8, sx = x > 0 ? 1 : -1, C = [x, y, z];
    for (var i = 0; i < n; i++) {
      var a0 = i / n * TAU, a1 = (i + 1) / n * TAU;
      var p0 = [0, Math.cos(a0) * r, Math.sin(a0) * r], p1 = [0, Math.cos(a1) * r, Math.sin(a1) * r];
      var o0 = [x + sx * w / 2, y + p0[1], z + p0[2]], o1 = [x + sx * w / 2, y + p1[1], z + p1[2]], i0 = [x - sx * w / 2, y + p0[1], z + p0[2]], i1 = [x - sx * w / 2, y + p1[1], z + p1[2]];
      G.quad(i0, i1, o1, o0, tire, C);
      var hub = [x + sx * (w / 2 + 0.005), y, z];
      G.quad(hub, [hub[0], y + p0[1] * 0.62, z + p0[2] * 0.62], [hub[0], y + p1[1] * 0.62, z + p1[2] * 0.62], [hub[0], y + p1[1] * 0.62, z + p1[2] * 0.62], rim, { o: [sx, 0, 0] });
      G.quad([o0[0], o0[1], o0[2]], [o1[0], o1[1], o1[2]], [hub[0], y + p1[1] * 0.62, z + p1[2] * 0.62], [hub[0], y + p0[1] * 0.62, z + p0[2] * 0.62], tire, { o: [sx, 0, 0] });
    }
  }

  // ---- small procedural textures ----
  function cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function texAsphalt() {
    var c = cv(256, 256), x = c.getContext('2d'), r = mulberry32(99), i;
    x.fillStyle = '#6d6c6a'; x.fillRect(0, 0, 256, 256);
    var im = x.getImageData(0, 0, 256, 256), d = im.data;
    for (i = 0; i < d.length; i += 4) { var v = (r() - 0.5) * 34 + (r() < 0.02 ? -30 : 0); d[i] += v; d[i + 1] += v; d[i + 2] += v + 1; }
    x.putImageData(im, 0, 0);
    x.globalAlpha = 0.12;
    for (i = 0; i < 26; i++) { x.fillStyle = r() < 0.5 ? '#3e3d3c' : '#8a8986'; x.beginPath(); x.ellipse(r() * 256, r() * 256, 8 + r() * 40, 4 + r() * 16, r() * 3, 0, TAU); x.fill(); }
    x.globalAlpha = 0.3; x.strokeStyle = '#3a3938'; x.lineWidth = 1;
    for (i = 0; i < 7; i++) { x.beginPath(); var px = r() * 256, py = r() * 256; x.moveTo(px, py); for (var k = 0; k < 5; k++) { px += (r() - 0.5) * 40; py += (r() - 0.5) * 40; x.lineTo(px, py); } x.stroke(); }
    return c;
  }
  // windows: 4 x 4 cells per tile; (0..8px) border stays plain wall for roofs
  function texWindows(lit) {
    var c = cv(256, 256), x = c.getContext('2d'), r = mulberry32(lit ? 7 : 5);
    x.fillStyle = lit ? '#000' : '#ece8e2'; x.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
      var X = i * 64, Y = j * 64;
      if (lit) {
        if (r() < 0.42) { var w = r(); x.fillStyle = w < 0.6 ? '#ffcf86' : w < 0.85 ? '#fff0c8' : '#9fd0ff'; x.globalAlpha = 0.6 + r() * 0.4; x.fillRect(X + 10, Y + 12, 44, 38); x.globalAlpha = 1; }
      } else {
        var gr = x.createLinearGradient(X, Y + 12, X + 44, Y + 50);
        gr.addColorStop(0, '#4a5a6c'); gr.addColorStop(1, '#25303c');
        x.fillStyle = '#6b7078'; x.fillRect(X + 8, Y + 10, 48, 42);
        x.fillStyle = gr; x.fillRect(X + 10, Y + 12, 44, 38);
        if (r() < 0.35) { x.fillStyle = 'rgba(220,214,200,0.55)'; x.fillRect(X + 10, Y + 12, 44, 8 + r() * 20); }
        x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(X + 12, Y + 14, 6, 34);
        x.fillStyle = '#6b7078'; x.fillRect(X + 31, Y + 12, 2, 38);
      }
    }
    return c;
  }
  function texGlow(inner, outer) {
    var c = cv(64, 64), x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, inner || 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(1, outer || 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return c;
  }
  function texCloud(seed) {
    var c = cv(256, 128), x = c.getContext('2d'), r = mulberry32(seed);
    for (var i = 0; i < 26; i++) {
      var cx = 40 + r() * 176, cy = 50 + r() * 40 - (Math.abs(cx - 128) / 128) * 10, rad = 16 + r() * 34, g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.35 + r() * 0.3) + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
    return c;
  }
  function texStripes() {
    var c = cv(64, 32), x = c.getContext('2d');
    for (var i = 0; i < 4; i++) { x.fillStyle = i % 2 ? '#f2f2ee' : '#d8262a'; x.fillRect(i * 16, 0, 16, 32); }
    return c;
  }
  function texChecker() {
    var c = cv(128, 32), x = c.getContext('2d');
    for (var i = 0; i < 16; i++) for (var j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; x.fillRect(i * 8, j * 8, 8, 8); }
    return c;
  }
  function texBeam() {
    var c = cv(32, 128), x = c.getContext('2d'), g = x.createLinearGradient(0, 128, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 128);
    return c;
  }
  function texHeadlight() {
    var c = cv(64, 128), x = c.getContext('2d'), g = x.createRadialGradient(32, 120, 4, 32, 90, 90);
    g.addColorStop(0, 'rgba(255,250,230,0.9)'); g.addColorStop(0.5, 'rgba(255,240,200,0.3)'); g.addColorStop(1, 'rgba(255,240,200,0)');
    x.fillStyle = g; x.beginPath(); x.moveTo(26, 128); x.lineTo(38, 128); x.lineTo(64, 0); x.lineTo(0, 0); x.closePath(); x.fill();
    return c;
  }

  function Rend(T, canvas, qname) {
    this.T = T; this.q = QUALITY[qname] || QUALITY.med; this.qname = qname;
    var r = new T.WebGLRenderer({ canvas: canvas, antialias: this.q.aa, powerPreference: 'high-performance', alpha: false, stencil: false, preserveDrawingBuffer: false });
    this.r = r;
    r.outputColorSpace = T.SRGBColorSpace;
    r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1;
    r.shadowMap.enabled = !!this.q.shadows; r.shadowMap.type = T.PCFShadowMap;
    this.scene = new T.Scene();
    this.cam = new T.PerspectiveCamera(60, 1.5, 0.25, 6800);
    this.cam.rotation.order = 'YXZ';
    this.scene.fog = new T.Fog(0xffffff, 60, this.q.draw);
    this.hemi = new T.HemisphereLight(0xffffff, 0x444444, 1); this.scene.add(this.hemi);
    this.sun = new T.DirectionalLight(0xffffff, 2.5); this.scene.add(this.sun); this.scene.add(this.sun.target);
    if (this.q.shadows) {
      this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
      var sc = this.sun.shadow.camera; sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 400;
      this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.04;
    }
    var maxAn = Math.min(8, r.capabilities.getMaxAnisotropy ? r.capabilities.getMaxAnisotropy() : 1);
    function tex(c, rep) { var t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; } t.anisotropy = maxAn; return t; }
    this.tx = { asphalt: tex(texAsphalt(), 1), win: tex(texWindows(false), 1), lit: tex(texWindows(true), 1), glow: tex(texGlow()), cloud: [tex(texCloud(3)), tex(texCloud(11)), tex(texCloud(29))], stripes: tex(texStripes(), 1), checker: tex(texChecker(), 1), beam: tex(texBeam()), head: tex(texHeadlight()) };
    var M = this.m = {};
    M.vc = new T.MeshLambertMaterial({ vertexColors: true });
    M.road = new T.MeshLambertMaterial({ vertexColors: true, map: this.tx.asphalt });
    M.bld = new T.MeshLambertMaterial({ vertexColors: true, map: this.tx.win, emissiveMap: this.tx.lit, emissive: new T.Color(0xffffff), emissiveIntensity: 0 });
    M.ground = new T.MeshLambertMaterial({ vertexColors: true });
    M.water = new T.MeshPhongMaterial({ color: 0x46768a, specular: 0x9aa8b0, shininess: 70 });
    M.car = new T.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: new T.Color(0x3a3a3a) });
    M.carAI = new T.MeshLambertMaterial({ vertexColors: true });
    M.sky = new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide, fog: false, depthWrite: false });
    M.mtn = new T.MeshLambertMaterial({ vertexColors: true, fog: false });
    M.cloud = this.tx.cloud.map(function (t) { return new T.MeshBasicMaterial({ map: t, transparent: true, fog: false, depthWrite: false, opacity: 0.9 }); });
    M.glowPts = new T.PointsMaterial({ size: 1.2, map: this.tx.glow, vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false });
    M.lampPts = new T.PointsMaterial({ size: 3.2, map: this.tx.glow, color: 0xffd9a0, transparent: true, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    M.pool = new T.MeshBasicMaterial({ map: this.tx.glow, color: 0xffc070, transparent: true, blending: T.AdditiveBlending, depthWrite: false, opacity: 0.5 });
    M.blob = new T.MeshBasicMaterial({ map: this.tx.glow, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    M.barrier = new T.MeshLambertMaterial({ map: this.tx.stripes });
    M.checker = new T.MeshLambertMaterial({ map: this.tx.checker, side: T.DoubleSide });
    M.beam = new T.MeshBasicMaterial({ map: this.tx.beam, color: 0xff7a2a, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, fog: false });
    M.head = new T.MeshBasicMaterial({ map: this.tx.head, transparent: true, blending: T.AdditiveBlending, depthWrite: false, opacity: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    M.tail = new T.MeshBasicMaterial({ color: 0x8a1010 });
    M.headLamp = new T.MeshBasicMaterial({ color: 0xd8d8cc });
    M.flame = new T.MeshBasicMaterial({ color: 0x66aaff, transparent: true, blending: T.AdditiveBlending, depthWrite: false, opacity: 0.85 });
    M.siren = new T.MeshBasicMaterial({ color: 0xffffff });
    M.smoke = new T.PointsMaterial({ size: 2.6, map: this.tx.glow, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    M.spark = new T.PointsMaterial({ size: 0.45, map: this.tx.glow, vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    M.rain = new T.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.35, depthWrite: false });
    this.dyn = new T.Group(); this.scene.add(this.dyn);       // per-game things
    this.static = new T.Group(); this.scene.add(this.static);  // the city
    this.far = new T.Group(); this.scene.add(this.far);        // sky, clouds, mountains: follow the camera
    this.tiles = [];
    this.W = null; this.g = null; this.todK = ''; this.camInit = false; this.shake = 0; this.t = 0; this.rainOn = false;
    this.fx = { smoke: [], spark: [] };
    this.d = new T.Object3D(); this.d.rotation.order = 'YXZ';
    this.col = new T.Color();
    this.buildFar();
    this.buildDyn();
  }
  Rend.prototype.C = function (c) { return new this.T.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, this.T.SRGBColorSpace); };
  Rend.prototype.setSize = function (W, H, dpr) {
    var k = Math.min(this.q.dpr, dpr || 1);
    if (W * H * k * k > this.q.px) k = Math.max(0.6, Math.sqrt(this.q.px / (W * H)));
    this.r.setPixelRatio(k); this.r.setSize(W, H, false);
    this.cam.aspect = W / Math.max(1, H); this.cam.updateProjectionMatrix();
    this.W0 = W; this.H0 = H;
  };
  Rend.prototype.add = function (grp, mesh) { grp.add(mesh); return mesh; };

  // ---- sky dome, clouds, mountains ----
  Rend.prototype.buildFar = function () {
    var T = this.T;
    var sg = new T.SphereGeometry(4200, 32, 16);
    sg.setAttribute('color', new T.BufferAttribute(new Float32Array(sg.attributes.position.count * 3), 3));
    this.sky = this.add(this.far, new T.Mesh(sg, this.m.sky)); this.sky.renderOrder = -10;
    this.sunSpr = new T.Sprite(new T.SpriteMaterial({ map: this.tx.glow, color: 0xfff2d0, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
    this.sunSpr.scale.set(900, 900, 1); this.far.add(this.sunSpr);
    // mountains
    var G = new Geo(), r = mulberry32(4242), snow = linA([236, 240, 246]);
    for (var i = 0; i < 70; i++) {
      var far = i >= 40, a = (far ? (i - 40) / 30 : i / 40) * TAU + r() * 0.12, d = far ? 3900 + r() * 300 : 3000 + r() * 600, x = Math.cos(a) * d, z = Math.sin(a) * d;
      var rad = (far ? 900 : 560) + r() * 600, h = (far ? 380 : 170) + r() * (far ? 520 : 360) * (0.55 + 0.45 * Math.abs(Math.sin(a * 1.7 + 1))), n = 9, pk = [x + (r() - 0.5) * rad * 0.5, h, z + (r() - 0.5) * rad * 0.5];
      var ring = [], col = linA([118 + r() * 20, 128 + r() * 20, 142 + r() * 20]);
      for (var k = 0; k < n; k++) { var b = k / n * TAU + r() * 0.3, rk = rad * (0.75 + r() * 0.45); ring.push([x + Math.cos(b) * rk, -40, z + Math.sin(b) * rk]); }
      for (k = 0; k < n; k++) {
        var p0 = ring[k], p1 = ring[(k + 1) % n], mid0 = [lerp(p0[0], pk[0], 0.62), lerp(p0[1], pk[1], 0.62), lerp(p0[2], pk[2], 0.62)], mid1 = [lerp(p1[0], pk[0], 0.62), lerp(p1[1], pk[1], 0.62), lerp(p1[2], pk[2], 0.62)];
        var shade = 0.75 + 0.35 * r();
        G.quad(p0, p1, mid1, mid0, [col[0] * shade, col[1] * shade, col[2] * shade], [x, h * 0.3, z]);
        G.tri(mid0, mid1, pk, h > 560 ? snow : [col[0] * 1.1, col[1] * 1.1, col[2] * 1.1]);
        var last = G.p.length - 9; if (G.n[last] * (mid0[0] - x) + G.n[last + 1] * (mid0[1] - h * 0.2) + G.n[last + 2] * (mid0[2] - z) < 0) G.flipLast(last);
      }
    }
    this.mtn = this.add(this.far, new T.Mesh(G.build(T), this.m.mtn));
    // clouds: quads facing the middle
    var cg = [new Geo(), new Geo(), new Geo()], rc = mulberry32(77);
    for (var c = 0; c < this.q.clouds; c++) {
      var ca = rc() * TAU, cd = 2300 + rc() * 1300, cy = 300 + rc() * 700, cw = 500 + rc() * 900, chh = cw * (0.28 + rc() * 0.12);
      var cx2 = Math.cos(ca) * cd, cz2 = Math.sin(ca) * cd, tx = -Math.sin(ca), tz = Math.cos(ca), wc = [1, 1, 1];
      cg[c % 3].quad([cx2 - tx * cw / 2, cy, cz2 - tz * cw / 2], [cx2 + tx * cw / 2, cy, cz2 + tz * cw / 2], [cx2 + tx * cw / 2, cy + chh, cz2 + tz * cw / 2], [cx2 - tx * cw / 2, cy + chh, cz2 - tz * cw / 2], wc,
        { o: [-Math.cos(ca), 0, -Math.sin(ca)] }, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    var self = this;
    this.clouds = cg.map(function (g2, i2) { var mesh = new T.Mesh(g2.build(T), self.m.cloud[i2]); mesh.renderOrder = -5; self.far.add(mesh); return mesh; });
  };
  Rend.prototype.setTod = function (tod, rain) {
    var key = tod + (rain ? 'r' : '');
    if (key === this.todK) return;
    this.todK = key;
    var T0 = TOD[tod] || TOD.day, Tt = {}, k;
    for (k in T0) Tt[k] = T0[k];
    if (rain) {
      var gray = tod === 'night' ? [30, 34, 44] : [120, 128, 138];
      ['top', 'mid', 'hor', 'fog', 'cloud'].forEach(function (n) { Tt[n] = mixC(Tt[n], gray, n === 'cloud' ? 0.75 : 0.6); });
      Tt.sunI *= tod === 'night' ? 0.8 : 0.35; Tt.hemiI *= tod === 'night' ? 1.1 : 0.95; Tt.win = Math.max(Tt.win, 0.3); Tt.lamps = Math.max(Tt.lamps, 0.4);
    }
    this.tod = Tt; this.todName = tod; this.rainOn = !!rain;
    var sunA = this.W ? this.W.sunA : 0.8, el = Tt.sunEl;
    this.sunDir = [Math.cos(sunA) * Math.cos(el), Math.sin(el), Math.sin(sunA) * Math.cos(el)];
    // sky colors
    var pos = this.sky.geometry.attributes.position, colA = this.sky.geometry.attributes.color, sd = this.sunDir, sunC = linA(Tt.sun);
    var top = linA(Tt.top), mid = linA(Tt.mid), hor = linA(Tt.hor), fog = linA(Tt.fog);
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i) / 4200, y = pos.getY(i) / 4200, z = pos.getZ(i) / 4200, c;
      if (y < 0) c = mixC(hor, fog, Math.min(1, -y * 4));
      else if (y < 0.22) c = mixC(hor, mid, smooth01(0, 0.22, y));
      else c = mixC(mid, top, smooth01(0.22, 0.85, y));
      var dd = Math.max(0, x * sd[0] + y * sd[1] + z * sd[2]), gl = Math.pow(dd, 10) * (rain ? 0.15 : 0.9) + Math.pow(dd, 3) * (rain ? 0.05 : 0.2);
      colA.setXYZ(i, c[0] + sunC[0] * gl, c[1] + sunC[1] * gl, c[2] + sunC[2] * gl);
    }
    colA.needsUpdate = true;
    this.scene.fog.color.copy(this.C(Tt.fog));
    this.scene.background = this.C(Tt.hor);
    this.hemi.color.copy(this.C(Tt.hemiS)); this.hemi.groundColor.copy(this.C(Tt.hemiG)); this.hemi.intensity = Tt.hemiI;
    this.sun.color.copy(this.C(Tt.sun)); this.sun.intensity = Tt.sunI;
    this.r.toneMappingExposure = Tt.exp;
    this.m.bld.emissiveIntensity = Tt.win;
    this.m.mtn.color.copy(this.C(mixC(Tt.mtn, Tt.hor, 0.4)).multiplyScalar(2.2));
    this.m.water.color.copy(this.C(Tt.water)); this.m.water.specular.copy(this.C(tod === 'night' ? [80, 90, 120] : Tt.sun)).multiplyScalar(0.6);
    var cc = this.C(Tt.cloud); this.m.cloud.forEach(function (m) { m.color.copy(cc); m.opacity = rain ? 0.95 : 0.85; });
    this.sunSpr.material.color.copy(this.C(Tt.sun)); this.sunSpr.material.opacity = tod === 'night' ? 0.35 : rain ? 0.15 : 0.9;
    this.sunSpr.scale.setScalar(tod === 'night' ? 260 : tod === 'dusk' ? 1100 : 800);
    this.sunSpr.position.set(sd[0] * 3600, sd[1] * 3600, sd[2] * 3600);
    this.m.road.color.setScalar(rain ? 0.62 : 1);
    var lamps = Tt.lamps;
    this.m.lampPts.opacity = lamps; this.m.pool.opacity = lamps * 0.6;
    if (this.lampPts) this.lampPts.visible = lamps > 0.05;
    if (this.pools) this.pools.visible = lamps > 0.05;
    this.m.glowPts.size = 0.6 + Tt.lights * 1.1;
    var near = this.q.draw * (rain ? 0.12 : 0.22), far = this.q.draw * (rain ? 0.7 : 1);
    this.scene.fog.near = near; this.scene.fog.far = far;
    this.drawD = far;
    this.m.head.opacity = tod === 'night' ? 0.75 : tod === 'dusk' || rain ? 0.35 : 0;
    if (this.rain) this.rain.visible = !!rain;
  };

  // ---- the city ----
  Rend.prototype.clearWorld = function () {
    var self = this;
    this.tiles.forEach(function (t) { self.static.remove(t); t.geometry.dispose(); });
    this.tiles = [];
    ['ground', 'water', 'lampPts', 'pools', 'outer'].forEach(function (k) { if (self[k]) { self.static.remove(self[k]); self[k].geometry.dispose(); self[k] = null; } });
  };
  Rend.prototype.setWorld = function (W) {
    if (this.W === W) return;
    this.clearWorld();
    this.W = W; this.todK = '';
    var T = this.T, self = this, TILE = 192, buckets = {};
    function B(x, z, cls) {
      var k = cls + ':' + Math.floor(x / TILE) + ':' + Math.floor(z / TILE);
      return buckets[k] || (buckets[k] = { g: new Geo(), cls: cls, cx: (Math.floor(x / TILE) + 0.5) * TILE, cz: (Math.floor(z / TILE) + 0.5) * TILE });
    }
    var H = W.H, R = W.river;
    function gy(x, z) { var d = riverDist(R, x, z); return H(x, z) - 0.45 - smooth01(R.hw + 12, R.hw - 6, d) * 4.6; }
    // ground: one grid over the city
    var N = 130, S = 2600 / N, gpos = new Float32Array((N + 1) * (N + 1) * 3), gcol = new Float32Array((N + 1) * (N + 1) * 3), idx = [];
    var DC = [[128, 124, 116], [104, 132, 74], [130, 124, 104], [92, 138, 70], [78, 110, 62]], rn = mulberry32(W.seed ^ 77), i, j;
    for (j = 0; j <= N; j++) for (i = 0; i <= N; i++) {
      var x = -1300 + i * S, z = -1300 + j * S, o = (j * (N + 1) + i) * 3, rad = Math.hypot(x, z), y = gy(x, z);
      var edge = smooth01(1150, 1300, Math.max(Math.abs(x), Math.abs(z)));
      y = lerp(y, -14, edge);
      gpos[o] = x; gpos[o + 1] = y; gpos[o + 2] = z;
      var dt = rad > 1180 ? 4 : district(W, x, z), c = DC[dt].slice(), nz = (rn() - 0.5) * 16 + 10 * Math.sin(x * 0.03) * Math.sin(z * 0.027);
      var rd = riverDist(R, x, z);
      if (rd < R.hw + 14) c = mixC(c, [150, 140, 110], smooth01(R.hw + 14, R.hw + 2, rd));
      if (rd < R.hw - 2) c = [70, 84, 80];
      var cl = linA([c[0] + nz, c[1] + nz, c[2] + nz * 0.6]);
      gcol[o] = cl[0]; gcol[o + 1] = cl[1]; gcol[o + 2] = cl[2];
    }
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) { var a = j * (N + 1) + i, b = a + 1, c2 = a + N + 1, d = c2 + 1; idx.push(a, c2, b, b, c2, d); }
    var gg = new T.BufferGeometry();
    gg.setAttribute('position', new T.BufferAttribute(gpos, 3)); gg.setAttribute('color', new T.BufferAttribute(gcol, 3)); gg.setIndex(idx); gg.computeVertexNormals();
    this.ground = new T.Mesh(gg, this.m.ground); this.ground.receiveShadow = true; this.static.add(this.ground);
    var og = new T.PlaneGeometry(16000, 16000, 1, 1); og.rotateX(-Math.PI / 2);
    this.outer = new T.Mesh(og, new T.MeshLambertMaterial({ color: this.C([84, 112, 64]) })); this.outer.position.y = -15; this.static.add(this.outer);
    // water
    var wg = new Geo(), wcol = [1, 1, 1];
    for (i = 0; i < R.x.length - 1; i++) {
      var ax = R.x[i], az = R.z[i], bx = R.x[i + 1], bz = R.z[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), nx = -dz / l * (R.hw + 8), nzz = dx / l * (R.hw + 8);
      var ya = H(ax, az) - 3.1, yb = H(bx, bz) - 3.1;
      wg.quad([ax - nx, ya, az - nzz], [ax + nx, ya, az + nzz], [bx + nx, yb, bz + nzz], [bx - nx, yb, bz - nzz], wcol, { o: [0, 1, 0] });
    }
    this.water = new T.Mesh(wg.build(T), this.m.water); this.static.add(this.water);
    // roads
    var cAsph = [1, 1, 1], cWhite = linA([226, 226, 220]), cYel = linA([228, 176, 40]), cCurb = linA([176, 172, 164]), cWalk = linA([196, 190, 178]), cWalk2 = linA([182, 176, 166]), cRail = linA([120, 124, 130]), cBar = linA([188, 184, 176]);
    W.paths.forEach(function (P) {
      var n = P.closed ? P.n : P.n - 1, hwy = P.kind === 'hwy', yb = 0.012 * P.id;
      for (var k = 0; k < n; k++) {
        var a = k, b = ix(P, k + 1), sm = (k + 0.5) * P.step;
        var ax = P.x[a], az = P.z[a], bx = P.x[b], bz = P.z[b], ay = P.y[a] + yb, by = P.y[b] + yb;
        var anx = -P.tz[a], anz = P.tx[a], bnx = -P.tz[b], bnz = P.tx[b], hw = P.hw[a];
        var mx = (ax + bx) / 2, mz = (az + bz) / 2;
        var skipAs = false;
        for (var zi = 0; zi < P.zones.length; zi++) { var zn = P.zones[zi]; if (zn.asph && Math.abs(dS(P, zn.s, sm)) < zn.asph) skipAs = true; }
        var bridge = riverDist(R, mx, mz) < R.hw + 6;
        function pt(x0, z0, nx0, nz0, lat, y0) { return [x0 + nx0 * lat, y0, z0 + nz0 * lat]; }
        var bk = B(mx, mz, 'road'), vk = B(mx, mz, 'vc');
        if (!skipAs) bk.g.quad(pt(ax, az, anx, anz, -hw, ay), pt(ax, az, anx, anz, hw, ay), pt(bx, bz, bnx, bnz, hw, by), pt(bx, bz, bnx, bnz, -hw, by), cAsph, { o: [0, 1, 0] },
          [[-hw / 7, k * P.step / 7], [hw / 7, k * P.step / 7], [hw / 7, (k + 1) * P.step / 7], [-hw / 7, (k + 1) * P.step / 7]]);
        var inZ = inZone(P, sm, 0.5);
        // lane paint
        if (!inZ) {
          var strip = function (lat, w, col, dy) {
            vk.g.quad(pt(ax, az, anx, anz, lat - w / 2, ay + dy), pt(ax, az, anx, anz, lat + w / 2, ay + dy), pt(bx, bz, bnx, bnz, lat + w / 2, by + dy), pt(bx, bz, bnx, bnz, lat - w / 2, by + dy), col, { o: [0, 1, 0] });
          };
          var L = P.lanes[a], lw = (hw - 0.3) / L;
          if (hwy) { strip(-0.45, 0.14, cYel, 0.035); strip(0.45, 0.14, cYel, 0.035); }
          else { strip(-0.14, 0.11, cYel, 0.035); strip(0.14, 0.11, cYel, 0.035); }
          strip(-(hw - 0.35), 0.15, cWhite, 0.035); strip(hw - 0.35, 0.15, cWhite, 0.035);
          if (k % 3 === 0) for (var ln = 1; ln < L; ln++) { strip(-ln * lw, 0.13, cWhite, 0.035); strip(ln * lw, 0.13, cWhite, 0.035); }
        }
        // curbs, sidewalks (or a highway shoulder and barrier), bridges
        for (var sd = -1; sd <= 1; sd += 2) {
          if (inZone(P, sm, 0.5, sd)) continue;
          var e0 = sd * hw, e1 = sd * (hw + 0.3), e2 = sd * (hw + SIDE), ctr = [mx, ay - 5, mz];
          var walk = (k >> 1) % 2 ? cWalk : cWalk2;
          if (hwy) {
            bk.g.quad(pt(ax, az, anx, anz, e0, ay), pt(ax, az, anx, anz, e2, ay), pt(bx, bz, bnx, bnz, e2, by), pt(bx, bz, bnx, bnz, e0, by), cAsph, { o: [0, 1, 0] },
              [[e0 / 7, k * P.step / 7], [e2 / 7, k * P.step / 7], [e2 / 7, (k + 1) * P.step / 7], [e0 / 7, (k + 1) * P.step / 7]]);
            var bi0 = sd * (hw + SIDE - 0.55), bi1 = sd * (hw + SIDE + 0.1);
            vk.g.hexa([pt(ax, az, anx, anz, bi0, ay), pt(ax, az, anx, anz, bi1, ay), pt(bx, bz, bnx, bnz, bi1, by), pt(bx, bz, bnx, bnz, bi0, by)],
              [pt(ax, az, anx, anz, bi0 + sd * 0.18, ay + 0.95), pt(ax, az, anx, anz, bi1 - sd * 0.12, ay + 0.95), pt(bx, bz, bnx, bnz, bi1 - sd * 0.12, by + 0.95), pt(bx, bz, bnx, bnz, bi0 + sd * 0.18, by + 0.95)], cBar, { skip: [true, true, true, false] });
            vk.g.quad(pt(ax, az, anx, anz, bi1, ay + 0.9), pt(bx, bz, bnx, bnz, bi1, by + 0.9), pt(bx, bz, bnx, bnz, bi1, by - (bridge ? 4 : 1.2)), pt(ax, az, anx, anz, bi1, ay - (bridge ? 4 : 1.2)), cBar, { o: [anx * sd, 0, anz * sd] });
          } else {
            vk.g.quad(pt(ax, az, anx, anz, e0, ay), pt(bx, bz, bnx, bnz, e0, by), pt(bx, bz, bnx, bnz, e0, by + 0.15), pt(ax, az, anx, anz, e0, ay + 0.15), cCurb, { o: [-anx * sd, 0, -anz * sd] });
            vk.g.quad(pt(ax, az, anx, anz, e0, ay + 0.15), pt(ax, az, anx, anz, e1, ay + 0.15), pt(bx, bz, bnx, bnz, e1, by + 0.15), pt(bx, bz, bnx, bnz, e0, by + 0.15), cCurb, { o: [0, 1, 0] });
            vk.g.quad(pt(ax, az, anx, anz, e1, ay + 0.15), pt(ax, az, anx, anz, e2, ay + 0.15), pt(bx, bz, bnx, bnz, e2, by + 0.15), pt(bx, bz, bnx, bnz, e1, by + 0.15), walk, { o: [0, 1, 0] });
            vk.g.quad(pt(ax, az, anx, anz, e2, ay + 0.15), pt(bx, bz, bnx, bnz, e2, by + 0.15), pt(bx, bz, bnx, bnz, e2, by - (bridge ? 4 : 1.1)), pt(ax, az, anx, anz, e2, ay - (bridge ? 4 : 1.1)), walk, { o: [anx * sd, 0, anz * sd] });
            if (bridge) {
              vk.g.box(ax + anx * (e2 - sd * 0.12), ay + 0.15, az + anz * (e2 - sd * 0.12), Math.atan2(P.tx[a], P.tz[a]), 0.1, 1.0, 0.12, cRail);
              vk.g.hexa([pt(ax, az, anx, anz, e2 - sd * 0.18, ay + 1.0), pt(ax, az, anx, anz, e2 - sd * 0.05, ay + 1.0), pt(bx, bz, bnx, bnz, e2 - sd * 0.05, by + 1.0), pt(bx, bz, bnx, bnz, e2 - sd * 0.18, by + 1.0)],
                [pt(ax, az, anx, anz, e2 - sd * 0.18, ay + 1.12), pt(ax, az, anx, anz, e2 - sd * 0.05, ay + 1.12), pt(bx, bz, bnx, bnz, e2 - sd * 0.05, by + 1.12), pt(bx, bz, bnx, bnz, e2 - sd * 0.18, by + 1.12)], cRail);
            }
          }
        }
        if (bridge) {
          // the deck's underside and piers
          vk.g.quad(pt(ax, az, anx, anz, -(hw + SIDE), ay - 1.1), pt(bx, bz, bnx, bnz, -(hw + SIDE), by - 1.1), pt(bx, bz, bnx, bnz, hw + SIDE, by - 1.1), pt(ax, az, anx, anz, hw + SIDE, ay - 1.1), cRail, { o: [0, -1, 0] });
          if (k % 6 === 0) { vk.g.box(ax + anx * (hw - 1), ay - 7, az + anz * (hw - 1), Math.atan2(P.tx[a], P.tz[a]), 1.2, 6, 1.6, cRail); vk.g.box(ax - anx * (hw - 1), ay - 7, az - anz * (hw - 1), Math.atan2(P.tx[a], P.tz[a]), 1.2, 6, 1.6, cRail); }
        }
      }
    });
    // buildings
    var cRoof = linA([118, 116, 112]), cDark = linA([60, 62, 66]);
    W.blds.forEach(function (b) {
      var bk = B(b.x, b.z, 'bld'), vk = B(b.x, b.z, 'vc'), col = linA(b.col), rot = b.rot, rb = mulberry32(b.seed || 1);
      function winUV(cw, chh, base) {
        return function (side, p0, p1, p2, p3) {
          var len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), u0 = (rb() * 4 | 0) * 0.25, h0 = (p0[1] - b.y - (base || 0)) / chh, h1 = (p3[1] - b.y - (base || 0)) / chh;
          return [[u0, h0 / 4], [u0 + len / cw / 4, h0 / 4], [u0 + len / cw / 4, h1 / 4], [u0, h1 / 4]];
        };
      }
      var top = { cols: { top: cRoof } };
      if (b.t === 'tower' || b.t === 'shop') {
        var base = b.t === 'tower' ? 4.4 : 0;
        if (b.t === 'tower') {
          // storefront ground floor
          bk.g.box(b.x, b.y, b.z, rot, b.d, base + 0.5, b.w, mixC(col, cDark, 0.5), { uvSide: winUV(4.2, 4.6, 0.5), noTop: true });
          bk.g.box(b.x, b.y + base, b.z, rot, b.d - 0.6, b.h - base, b.w - 0.6, col, { uvSide: winUV(3.2, 3.6, base), cols: { top: cRoof } });
          vk.g.box(b.x, b.y + b.h, b.z, rot, b.d * 0.45, 2.4, b.w * 0.4, cRoof);
          if (b.h > 40) { var ax2 = rotP(b.x, b.y, b.z, rot, b.d * 0.2, 0, -b.w * 0.25); vk.g.cyl(ax2[0], b.y + b.h + 2.4, ax2[2], 0.15, 0.08, 6, 4, cDark); }
          var aw = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.6, 0, 0);
          vk.g.box(aw[0], b.y + base + 0.4, aw[2], rot, 1.2, 0.18, b.w * 0.92, linA(b.awn));
        } else {
          bk.g.box(b.x, b.y, b.z, rot, b.d, b.h, b.w, col, { uvSide: winUV(3.4, 3.4, 0.6), cols: { top: cRoof } });
          var aw2 = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.75, 0, 0);
          vk.g.hexa([rotP(b.x, b.y + 3.4, b.z, rot, b.d / 2, 0, -b.w * 0.45), rotP(b.x, b.y + 3.4, b.z, rot, b.d / 2 + 1.5, -0.5, -b.w * 0.45), rotP(b.x, b.y + 3.4, b.z, rot, b.d / 2 + 1.5, -0.5, b.w * 0.45), rotP(b.x, b.y + 3.4, b.z, rot, b.d / 2, 0, b.w * 0.45)],
            [rotP(b.x, b.y + 3.6, b.z, rot, b.d / 2, 0, -b.w * 0.45), rotP(b.x, b.y + 3.6, b.z, rot, b.d / 2 + 1.5, -0.5, -b.w * 0.45), rotP(b.x, b.y + 3.6, b.z, rot, b.d / 2 + 1.5, -0.5, b.w * 0.45), rotP(b.x, b.y + 3.6, b.z, rot, b.d / 2, 0, b.w * 0.45)], linA(b.awn));
          vk.g.box(aw2[0], b.y + b.h - 0.4, aw2[2], rot, 0.3, 1.1, b.w * 0.6, linA(b.awn).map(function (v) { return v * 1.4; }));
        }
      } else if (b.t === 'house') {
        bk.g.box(b.x, b.y, b.z, rot, b.d, b.h, b.w, col, { uvSide: winUV(3.8, 3.2, 0.7), noTop: true });
        var rf = linA(b.roof), rh = b.h * 0.55, ov = 0.45;
        var c0 = rotP(b.x, b.y + b.h, b.z, rot, -b.d / 2 - ov, 0, -b.w / 2 - ov), c1 = rotP(b.x, b.y + b.h, b.z, rot, b.d / 2 + ov, 0, -b.w / 2 - ov), c2 = rotP(b.x, b.y + b.h, b.z, rot, b.d / 2 + ov, 0, b.w / 2 + ov), c3 = rotP(b.x, b.y + b.h, b.z, rot, -b.d / 2 - ov, 0, b.w / 2 + ov);
        var r0 = rotP(b.x, b.y + b.h + rh, b.z, rot, 0, 0, -b.w / 2 - ov), r1 = rotP(b.x, b.y + b.h + rh, b.z, rot, 0, 0, b.w / 2 + ov), rc = [b.x, b.y + b.h - 1, b.z];
        vk.g.quad(c1, c2, r1, r0, rf, rc); vk.g.quad(c3, c0, r0, r1, mixC(rf, [0, 0, 0], 0.2), rc);
        vk.g.tri(c0, c1, r0, col); vk.g.tri(c2, c3, r1, col);
        fixTri(vk.g, rc, 2);
        var dr = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.02, 0, b.w * 0.2);
        vk.g.box(dr[0], b.y, dr[2], rot, 0.1, 2.2, 1.1, linA([110, 70, 50]));
        var ch = rotP(b.x, b.y + b.h, b.z, rot, -b.d * 0.2, 0, b.w * 0.3);
        vk.g.box(ch[0], b.y + b.h, ch[2], rot, 0.7, rh + 0.8, 0.7, linA([150, 90, 70]));
      } else if (b.t === 'garage') {
        bk.g.box(b.x, b.y, b.z, rot, b.d, b.h, b.w, col, { uvSide: function () { return null; }, cols: { top: cRoof } });
        var nd = Math.max(1, Math.floor(b.w / 4.2));
        for (var q = 0; q < nd; q++) {
          var dp = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.03, 0, -b.w / 2 + (q + 0.5) * b.w / nd);
          vk.g.box(dp[0], b.y, dp[2], rot, 0.06, Math.min(3, b.h - 0.6), b.w / nd - 0.8, linA([150 + (q % 2) * 20, 150, 146]));
        }
        vk.g.box(rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.05, 0, 0)[0], b.y + b.h - 0.5, rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.05, 0, 0)[2], rot, 0.12, 0.5, b.w, linA(b.awn));
      } else if (b.t === 'ware') {
        bk.g.box(b.x, b.y, b.z, rot, b.d, b.h, b.w, col, { uvSide: function (side, p0, p1, p2, p3) { var len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]); return [[0.02, 0.01], [0.02 + len / 18, 0.01], [0.02 + len / 18, 0.01], [0.02, 0.01]]; }, cols: { top: cRoof } });
        for (var q2 = 0; q2 < 3; q2++) { var vp = rotP(b.x, b.y, b.z, rot, (q2 - 1) * b.d * 0.25, 0, (q2 - 1) * b.w * 0.2); vk.g.box(vp[0], b.y + b.h, vp[2], rot, 2, 1.2, 2, cDark); }
        var ld = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.04, 0, 0);
        vk.g.box(ld[0], b.y, ld[2], rot, 0.08, 4.2, Math.min(b.w * 0.5, 9), linA([96, 104, 112]));
        // a band of windows high up
        var hb = rotP(b.x, b.y, b.z, rot, b.d / 2 + 0.03, 0, 0);
        bk.g.box(hb[0], b.y + b.h - 2.2, hb[2], rot, 0.06, 1.3, b.w * 0.9, col, { uvSide: winUV(3, 1.3, b.h - 2.2), noTop: true });
      } else if (b.t === 'tank') {
        vk.g.cyl(b.x, b.y, b.z, b.w / 2, b.w / 2, b.h, 10, col);
        vk.g.cyl(b.x, b.y + b.h, b.z, b.w / 2, 0.6, b.w * 0.18, 10, mixC(col, [0, 0, 0], 0.15));
      }
    });
    // trees, hedges, rocks, lamps
    var tq = this.q.trees, cTrunk = linA([96, 72, 52]);
    W.trees.forEach(function (t, ti) {
      if ((ti * 0.6180339) % 1 > tq) return;
      var vk = B(t.x, t.z, 'vc'), s = t.s, rt = mulberry32((ti * 7919) ^ 0x55);
      if (t.t === 0) {
        var gc = linA([48 + rt() * 20, 84 + rt() * 26, 52 + rt() * 14]);
        vk.g.cyl(t.x, t.y - 0.3, t.z, 0.28 * s, 0.2 * s, 2.4 * s, 4, cTrunk, { open: true });
        vk.g.cyl(t.x, t.y + 1.6 * s, t.z, 2.6 * s, 0, 4.4 * s, 6, gc, { ph: rt() });
        vk.g.cyl(t.x, t.y + 3.6 * s, t.z, 2.0 * s, 0, 3.8 * s, 6, mixC(gc, [1, 1, 1], 0.04), { ph: rt() });
        vk.g.cyl(t.x, t.y + 5.6 * s, t.z, 1.3 * s, 0, 3.0 * s, 6, mixC(gc, [1, 1, 1], 0.08), { ph: rt() });
      } else {
        var lc = linA([92 + rt() * 40, 128 + rt() * 34, 52 + rt() * 20]);
        vk.g.cyl(t.x, t.y - 0.3, t.z, 0.3 * s, 0.22 * s, 3.4 * s, 5, cTrunk, { open: true });
        vk.g.blob(t.x, t.y + 4.4 * s, t.z, 2.7 * s, 2.3 * s, 2.7 * s, lc, rt);
        if (rt() < 0.6) vk.g.blob(t.x + 1.2 * s, t.y + 5.2 * s, t.z - 0.8 * s, 1.7 * s, 1.5 * s, 1.7 * s, mixC(lc, [1, 1, 0.6], 0.06), rt, 5, 3);
      }
    });
    W.hedges.forEach(function (h) { B(h.x, h.z, 'vc').g.box(h.x, h.y - 0.2, h.z, h.rot, 0.9, h.h + 0.2, h.len, linA([58, 96, 50]), { cols: { top: linA([70, 112, 58]) } }); });
    W.rocks.forEach(function (k, ki) { B(k.x, k.z, 'vc').g.blob(k.x, k.y, k.z, k.s, k.s * 0.6, k.s * 0.8, linA([128, 124, 118]), mulberry32(ki + 5), 5, 3); });
    var cPole = linA([70, 72, 78]), lampPos = [], poolG = new Geo();
    W.lamps.forEach(function (l) {
      var vk = B(l.x, l.z, 'vc'), rot = l.rot, hx = Math.cos(rot), hz = -Math.sin(rot);      // local +x (toward the right of the road's direction is -x)
      var ax = -l.side, ex = l.x + hx * ax * l.arm, ez = l.z + hz * ax * l.arm;
      vk.g.box(l.x, l.y, l.z, rot, 0.2, 7.4, 0.2, cPole);
      vk.g.hexa([[l.x - 0.06, l.y + 7.2, l.z - 0.06], [l.x + 0.06, l.y + 7.2, l.z + 0.06], [ex + 0.06, l.y + 7.3, ez + 0.06], [ex - 0.06, l.y + 7.3, ez - 0.06]],
        [[l.x - 0.06, l.y + 7.36, l.z - 0.06], [l.x + 0.06, l.y + 7.36, l.z + 0.06], [ex + 0.06, l.y + 7.46, ez + 0.06], [ex - 0.06, l.y + 7.46, ez - 0.06]], cPole);
      vk.g.box(ex, l.y + 7.08, ez, rot, 0.36, 0.3, 0.7, cPole, { cols: { side: [linA([250, 236, 200]), cPole, cPole, cPole] } });
      lampPos.push(ex, l.y + 6.95, ez);
      var pr = 5.5, py = l.y - 0.1 + 0.05;
      poolG.quad([ex - pr, py, ez - pr], [ex + pr, py, ez - pr], [ex + pr, py, ez + pr], [ex - pr, py, ez + pr], [1, 1, 1], { o: [0, 1, 0] }, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    });
    var lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(new Float32Array(lampPos), 3));
    this.lampPts = new T.Points(lg, this.m.lampPts); this.static.add(this.lampPts);
    this.pools = new T.Mesh(poolG.build(T), this.m.pool); this.pools.renderOrder = 2; this.static.add(this.pools);
    // merge into tile meshes
    var mats = { vc: this.m.vc, road: this.m.road, bld: this.m.bld };
    Object.keys(buckets).forEach(function (k) {
      var bk = buckets[k];
      if (!bk.g.p.length) return;
      var mesh = new T.Mesh(bk.g.build(T), mats[bk.cls]);
      mesh.userData.cx = bk.cx; mesh.userData.cz = bk.cz;
      mesh.receiveShadow = true; mesh.castShadow = self.q.shadows && bk.cls !== 'road';
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      self.static.add(mesh); self.tiles.push(mesh);
    });
    this.camInit = false;
  };
  // the gable ends of a roof: make the last n triangles face away from c
  function fixTri(g, c, n) {
    for (var k = 1; k <= n; k++) {
      var base = g.p.length - k * 9, cx = (g.p[base] + g.p[base + 3] + g.p[base + 6]) / 3 - c[0], cz = (g.p[base + 2] + g.p[base + 5] + g.p[base + 8]) / 3 - c[2];
      if (g.n[base] * cx + g.n[base + 2] * cz < 0) g.flipLast(base);
    }
  }

  // ---- per-game objects: cars, lights, effects ----
  Rend.prototype.buildDyn = function () {
    var T = this.T, self = this;
    // AI car pools: traffic models, the player's car models (rivals), police
    function inst(body, n, mat) {
      var G = carGeo(body, [1, 1, 1], { wheels: true, lights: true });
      var m = new T.InstancedMesh(G.build(T), mat || self.m.carAI, n);
      m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; m.castShadow = self.q.shadows;
      m.setColorAt(0, new T.Color(1, 1, 1));
      self.dyn.add(m); return m;
    }
    this.poolT = TRAFFIC.map(function (t) { return inst(t.body, 26); });
    this.poolC = CARS.map(function (c) { return inst(c.body, 6); });
    this.poolP = inst(POLICE.body, 14);
    var sg = new T.BoxGeometry(0.9, 0.14, 0.32);
    this.sirens = new T.InstancedMesh(sg, this.m.siren, 28); this.sirens.instanceMatrix.setUsage(T.DynamicDrawUsage); this.sirens.count = 0; this.sirens.frustumCulled = false;
    this.sirens.setColorAt(0, new T.Color(1, 0, 0)); this.dyn.add(this.sirens);
    var bg = new T.PlaneGeometry(1, 1); bg.rotateX(-Math.PI / 2);
    this.blobs = new T.InstancedMesh(bg, this.m.blob, 80); this.blobs.count = 0; this.blobs.frustumCulled = false; this.blobs.renderOrder = 1; this.dyn.add(this.blobs);
    // car light glows
    this.nLights = 340;
    var lgeo = new T.BufferGeometry();
    lgeo.setAttribute('position', new T.BufferAttribute(new Float32Array(this.nLights * 3), 3).setUsage(T.DynamicDrawUsage));
    lgeo.setAttribute('color', new T.BufferAttribute(new Float32Array(this.nLights * 3), 3).setUsage(T.DynamicDrawUsage));
    lgeo.setDrawRange(0, 0);
    this.lights = new T.Points(lgeo, this.m.glowPts); this.lights.frustumCulled = false; this.lights.renderOrder = 3; this.dyn.add(this.lights);
    // smoke and sparks
    function pts(n, mat) {
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      var p = new T.Points(g, mat); p.frustumCulled = false; p.renderOrder = 4; self.dyn.add(p); return p;
    }
    this.smokeP = pts(260, this.m.smoke); this.sparkP = pts(160, this.m.spark);
    // rain
    var rn = this.q.rain, rg = new T.BufferGeometry(), rp = new Float32Array(rn * 6), rr2 = mulberry32(31);
    for (var i = 0; i < rn; i++) { var x = (rr2() - 0.5) * 60, y = rr2() * 30, z = (rr2() - 0.5) * 60; rp.set([x, y, z, x + 0.05, y - 0.9, z], i * 6); }
    rg.setAttribute('position', new T.BufferAttribute(rp, 3).setUsage(T.DynamicDrawUsage));
    this.rain = new T.LineSegments(rg, this.m.rain); this.rain.frustumCulled = false; this.rain.visible = false; this.dyn.add(this.rain);
    // headlight pools for the player
    var hg = new T.PlaneGeometry(9, 26); hg.rotateX(-Math.PI / 2); hg.translate(0, 0, 15);
    this.headPool = new T.Mesh(hg, this.m.head); this.headPool.renderOrder = 2; this.dyn.add(this.headPool);
    // race furniture
    this.barrierG = new T.BoxGeometry(1.25, 1.0, 0.45);
    this.barriers = null; this.gantries = new T.Group(); this.dyn.add(this.gantries); this.markers = new T.Group(); this.dyn.add(this.markers);
  };
  Rend.prototype.makePlayerCar = function (id, col) {
    var T = this.T, c = CAR_BY[id] || CARS[0], b = c.body, key = id + ':' + col.join(',');
    if (this.pcKey === key) return;
    if (this.pc) { this.dyn.remove(this.pc.root); this.pc.root.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
    this.pcKey = key;
    var root = new T.Group(); root.rotation.order = 'YXZ';
    var bodyG = carGeo(b, linA(col), { lights: false });
    var body = new T.Mesh(bodyG.build(T), this.m.car); body.castShadow = this.q.shadows;
    root.add(body);
    var L = b.len, Wd = b.wid, fl = 0.22, belt = fl + (b.h - fl) * 0.52, tail = (belt - fl) * 0.2, nose = (belt - fl) * 0.38, hz = L / 2, hx = Wd / 2;
    var tg = new T.BoxGeometry(0.38, 0.11, 0.05), tl1 = new T.Mesh(tg, this.m.tail), tl2 = new T.Mesh(tg, this.m.tail);
    tl1.position.set(hx - 0.28, belt - tail - 0.11, -hz + 0.03); tl2.position.set(-hx + 0.28, belt - tail - 0.11, -hz + 0.03); root.add(tl1); root.add(tl2);
    var hg = new T.BoxGeometry(0.36, 0.09, 0.06), h1 = new T.Mesh(hg, this.m.headLamp), h2 = new T.Mesh(hg, this.m.headLamp);
    h1.position.set(hx - 0.3, belt - nose - 0.06, hz - 0.09); h2.position.set(-hx + 0.3, belt - nose - 0.06, hz - 0.09); root.add(h1); root.add(h2);
    // wheels: steer the front pair, spin all four
    var wr = 0.34, ww = 0.25, tire = new T.CylinderGeometry(wr, wr, ww, 14); tire.rotateZ(Math.PI / 2);
    var rimG = new T.CylinderGeometry(wr * 0.62, wr * 0.62, ww + 0.02, 10); rimG.rotateZ(Math.PI / 2);
    var tireM = this.pcTire || (this.pcTire = new T.MeshLambertMaterial({ color: 0x1a1a1c })), rimM = this.pcRim || (this.pcRim = new T.MeshPhongMaterial({ color: 0xb8bcc4, shininess: 80 }));
    var wz = hz - Math.min(0.85, L * 0.19), wx = hx - 0.13, wheels = [];
    [[wx, wz, 1], [-wx, wz, 1], [wx, -wz, 0], [-wx, -wz, 0]].forEach(function (w) {
      var piv = new T.Group(); piv.position.set(w[0], wr, w[1]);
      var spin = new T.Group(), t = new T.Mesh(tire, tireM), rm = new T.Mesh(rimG, rimM);
      var spoke = new T.Mesh(new T.BoxGeometry(ww + 0.03, wr * 1.1, 0.07), rimM);
      spin.add(t); spin.add(rm); spin.add(spoke); piv.add(spin); root.add(piv);
      t.castShadow = false;
      wheels.push({ piv: piv, spin: spin, front: w[2] });
    });
    // nitro flames
    var fg = new T.ConeGeometry(0.11, 0.9, 8); fg.rotateX(-Math.PI / 2); fg.translate(0, 0, -0.45);
    var f1 = new T.Mesh(fg, this.m.flame), f2 = new T.Mesh(fg, this.m.flame);
    f1.position.set(0.32, fl + 0.06, -hz - 0.05); f2.position.set(-0.32, fl + 0.06, -hz - 0.05); root.add(f1); root.add(f2);
    this.dyn.add(root);
    this.pc = { root: root, body: body, wheels: wheels, flames: [f1, f2], tails: [tl1, tl2], len: L, wid: Wd, belt: belt, tail: tail, hz: hz, hx: hx };
  };
  Rend.prototype.setGame = function (g, opts) {
    var T = this.T, self = this;
    this.setWorld(g.W);
    this.g = g; this.camInit = false; this.shake = 0;
    this.setTod(g.tod, g.rain);
    this.makePlayerCar(opts.car, opts.col);
    // barriers, gantries, markers
    if (this.barriers) { this.dyn.remove(this.barriers); this.barriers.dispose(); this.barriers = null; }
    while (this.gantries.children.length) { var c = this.gantries.children.pop(); c.traverse(function (o) { if (o.geometry && o.geometry !== self.barrierG) o.geometry.dispose(); }); }
    while (this.markers.children.length) { var m = this.markers.children.pop(); if (m.geometry) m.geometry.dispose(); }
    if (g.kind === 'race') {
      var list = [];
      g.R.barriers.forEach(function (b) {
        var n = Math.max(2, Math.round(b.w * 2 / 1.3)), nx = -b.tz, nz = b.tx, a = Math.atan2(b.tx, b.tz);
        for (var k = 0; k < n; k++) { var lat = -b.w + (k + 0.5) * (2 * b.w / n); list.push([b.x + nx * lat, b.y, b.z + nz * lat, a]); }
      });
      if (list.length) {
        var bm = new T.InstancedMesh(this.barrierG, this.m.barrier, list.length);
        list.forEach(function (it, i) { self.d.position.set(it[0], it[1] + 0.65, it[2]); self.d.rotation.set(0, it[3] + Math.PI / 2, 0); self.d.updateMatrix(); bm.setMatrixAt(i, self.d.matrix); });
        bm.castShadow = this.q.shadows; this.barriers = bm; this.dyn.add(bm);
      }
      var gant = function (s, label) {
        var a = pathAt(g.path, s), hw = a.hw + 1.2, grp = new T.Group(), pm = self.m.vc;
        var pg = new T.BoxGeometry(0.6, 6.4, 0.6), colG = new T.BufferAttribute(new Float32Array(pg.attributes.position.count * 3).fill(0.12), 3);
        pg.setAttribute('color', colG);
        var p1 = new T.Mesh(pg, pm), p2 = new T.Mesh(pg, pm);
        p1.position.set(-hw, 3.2, 0); p2.position.set(hw, 3.2, 0);
        var ban = new T.Mesh(new T.PlaneGeometry(hw * 2, 1.4), self.m.checker); ban.position.set(0, 5.8, 0);
        self.m.checker.map.repeat.set(1, 1);
        grp.add(p1); grp.add(p2); grp.add(ban);
        var line = new T.Mesh(new T.PlaneGeometry(a.hw * 2, 1.6), self.m.checker); line.rotation.x = -Math.PI / 2; line.position.set(0, 0.05, 0); grp.add(line);
        grp.position.set(a.x, a.y, a.z); grp.rotation.y = Math.atan2(a.tx, a.tz);
        self.gantries.add(grp);
        void label;
      };
      gant(g.R.startS, 'start');
      if (!g.R.closed) gant(g.R.finishS, 'finish');
    } else if (g.kind === 'free' && !g.escape) {
      g.W.markers.forEach(function (mk) {
        var cg = new T.CylinderGeometry(4.5, 4.5, 46, 20, 1, true); cg.translate(0, 23, 0);
        var mm = new T.Mesh(cg, self.m.beam); mm.position.set(mk.x, mk.y, mk.z); mm.renderOrder = 5; self.markers.add(mm);
      });
    }
    this.fx.smoke.length = 0; this.fx.spark.length = 0;
  };

  Rend.prototype.puff = function (kind, x, y, z, vx, vy, vz, life, c) {
    var list = this.fx[kind], max = kind === 'smoke' ? 260 : 160;
    if (list.length >= max) list.shift();
    list.push({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, t: 0, life: life, c: c });
  };
  Rend.prototype.sparks = function (x, y, z, n) {
    for (var i = 0; i < n; i++) this.puff('spark', x, y + 0.4, z, (Math.random() - 0.5) * 10, 1 + Math.random() * 4, (Math.random() - 0.5) * 10, 0.3 + Math.random() * 0.4, [1, 0.6 + Math.random() * 0.3, 0.2]);
  };
  Rend.prototype.kick = function (k) { this.shake = Math.max(this.shake, k); };

  // ---- one frame ----
  Rend.prototype.frame = function (g, dt, o) {
    var T = this.T, p = g.p, d = this.d, self = this, cam = this.cam, tod = this.tod;
    this.t += dt;
    var night = this.todName === 'night', lightsK = tod.lights;
    // the player's car
    var pc = this.pc, pr = pc.root, fx = Math.sin(p.a), fz = Math.cos(p.a), H = g.W.H;
    var pitchS = Math.atan2(H(p.x + fx * 1.4, p.z + fz * 1.4) - H(p.x - fx * 1.4, p.z - fz * 1.4), 2.8);
    this.sq = lerp(this.sq || 0, clamp(-p.acc * 0.004, -0.05, 0.05), Math.min(1, dt * 6));
    this.roll = lerp(this.roll || 0, clamp(p.w * p.vf * 0.006, -0.07, 0.07), Math.min(1, dt * 6));
    var bump = p.off ? Math.sin(this.t * 40) * 0.015 * Math.min(1, Math.abs(p.vf) / 15) : 0;
    pr.position.set(p.x, p.y + 0.02 + bump, p.z);
    pr.rotation.set(-pitchS + this.sq, p.a, this.roll);
    pc.wheels.forEach(function (w) { if (w.front) w.piv.rotation.y = p.steer * 0.45; w.spin.rotation.x = p.wheel; });
    var brk = p.brakeOn || p.hb;
    this.m.tail.color.setRGB(brk ? 1 : 0.35 + lightsK * 0.35, brk ? 0.08 : 0.02, brk ? 0.06 : 0.02);
    var nos = p.nosOn;
    pc.flames.forEach(function (f) { f.visible = nos; if (nos) f.scale.set(1, 1, 0.7 + Math.random() * 0.6); });
    // AI cars
    var cT = this.poolT.map(function () { return 0; }), cC = this.poolC.map(function () { return 0; }), cP = 0, cS = 0, nb = 0;
    var LP = this.lights.geometry.attributes.position.array, LC = this.lights.geometry.attributes.color.array, nl = 0, maxL = this.nLights;
    var col = this.col, camX = cam.position.x, camZ = cam.position.z, dd2 = Math.pow(this.drawD + 40, 2);
    function light(x, y, z, r, gg, b) { if (nl >= maxL) return; LP[nl * 3] = x; LP[nl * 3 + 1] = y; LP[nl * 3 + 2] = z; LC[nl * 3] = r; LC[nl * 3 + 1] = gg; LC[nl * 3 + 2] = b; nl++; }
    var sirenOn = g.pursuit, phase = (this.t * 6) % 2 < 1;
    for (var i = 0; i < g.agents.length; i++) {
      var a = g.agents[i], dx = a.x - camX, dz = a.z - camZ;
      if (dx * dx + dz * dz > dd2) continue;
      var mesh, idx, body;
      if (a.kind === 'traffic') { mesh = this.poolT[a.model]; idx = cT[a.model]++; body = TRAFFIC[a.model].body; if (idx >= 26) continue; }
      else if (a.kind === 'rival') { var ci = CAR_BY[a.car] ? CAR_BY[a.car].ix : 0; mesh = this.poolC[ci]; idx = cC[ci]++; body = CARS[ci].body; if (idx >= 6) continue; }
      else { mesh = this.poolP; idx = cP++; body = POLICE.body; if (idx >= 14) continue; }
      d.position.set(a.x, a.y, a.z); d.rotation.set(-(a.pitch || 0), a.a, 0); d.scale.set(1, 1, 1); d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);
      var cc = a.kind === 'cop' ? [255, 255, 255] : a.col || [200, 200, 200];
      col.setRGB(cc[0] / 255, cc[1] / 255, cc[2] / 255, T.SRGBColorSpace); mesh.setColorAt(idx, col);
      // blob shadow
      if (nb < 80) { d.position.set(a.x, a.y + 0.06, a.z); d.rotation.set(0, a.a, 0); d.scale.set(body.wid * 1.5, 1, body.len * 1.25); d.updateMatrix(); this.blobs.setMatrixAt(nb++, d.matrix); }
      // lights
      var sa = Math.sin(a.a), ca = Math.cos(a.a), hz = body.len / 2, wx = body.wid / 2 - 0.3;
      var rx = -ca, rz = sa;
      if (lightsK > 0.3) {
        light(a.x + sa * (hz + 0.1) + rx * wx, a.y + 0.62, a.z + ca * (hz + 0.1) + rz * wx, 0.9, 0.85, 0.7);
        light(a.x + sa * (hz + 0.1) - rx * wx, a.y + 0.62, a.z + ca * (hz + 0.1) - rz * wx, 0.9, 0.85, 0.7);
      }
      var tb = a.brake || a.spin > 0 ? 1 : 0.35 * lightsK + 0.1;
      if (tb > 0.15) {
        light(a.x - sa * (hz + 0.05) + rx * wx, a.y + 0.7, a.z - ca * (hz + 0.05) + rz * wx, tb, 0.02, 0.01);
        light(a.x - sa * (hz + 0.05) - rx * wx, a.y + 0.7, a.z - ca * (hz + 0.05) - rz * wx, tb, 0.02, 0.01);
      }
      if (a.kind === 'cop' && cS < 28) {
        d.position.set(a.x, a.y + body.h + 0.02, a.z); d.rotation.set(0, a.a, 0); d.scale.set(1, 1, 1); d.updateMatrix(); this.sirens.setMatrixAt(cS, d.matrix);
        var on = (sirenOn || a.mode === 'block') && ((phase ? 1 : 0) ^ (i % 2));
        col.setRGB(on ? 1 : 0.1, 0.05, on ? 0.1 : 1); if (!(sirenOn || a.mode === 'block')) col.setRGB(0.3, 0.3, 0.35);
        this.sirens.setColorAt(cS++, col);
        if (sirenOn || a.mode === 'block') { light(a.x + rx * 0.3, a.y + body.h + 0.15, a.z + rz * 0.3, on ? 2 : 0, 0, on ? 0 : 0); light(a.x - rx * 0.3, a.y + body.h + 0.15, a.z - rz * 0.3, 0, on ? 0 : 0.2, on ? 0 : 2); }
      }
    }
    // player lights and shadow
    var psa = Math.sin(p.a), pca = Math.cos(p.a), prx = -pca, prz = psa;
    var tbp = brk ? 1.4 : 0.3 * lightsK;
    if (tbp > 0.12) { [1, -1].forEach(function (sd) { light(p.x - psa * (pc.hz + 0.05) + prx * (pc.hx - 0.28) * sd, p.y + pc.belt - pc.tail - 0.1, p.z - pca * (pc.hz + 0.05) + prz * (pc.hx - 0.28) * sd, tbp, 0.04, 0.02); }); }
    if (lightsK > 0.3 && o.cam !== 'hood') [1, -1].forEach(function (sd) { light(p.x + psa * (pc.hz + 0.05) + prx * (pc.hx - 0.3) * sd, p.y + 0.6, p.z + pca * (pc.hz + 0.05) + prz * (pc.hx - 0.3) * sd, 1, 0.95, 0.8); });
    if (nb < 80) { d.position.set(p.x, p.y + 0.06, p.z); d.rotation.set(0, p.a, 0); d.scale.set(pc.wid * 1.5, 1, pc.len * 1.25); d.updateMatrix(); this.blobs.setMatrixAt(nb++, d.matrix); }
    this.poolT.forEach(function (m, k) { m.count = cT[k]; if (cT[k]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } });
    this.poolC.forEach(function (m, k) { m.count = cC[k]; if (cC[k]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } });
    this.poolP.count = cP; if (cP) { this.poolP.instanceMatrix.needsUpdate = true; if (this.poolP.instanceColor) this.poolP.instanceColor.needsUpdate = true; }
    this.sirens.count = cS; if (cS) { this.sirens.instanceMatrix.needsUpdate = true; this.sirens.instanceColor.needsUpdate = true; }
    this.blobs.count = nb; this.blobs.instanceMatrix.needsUpdate = true;
    this.lights.geometry.setDrawRange(0, nl); this.lights.geometry.attributes.position.needsUpdate = true; this.lights.geometry.attributes.color.needsUpdate = true;
    // headlight pool
    this.headPool.visible = this.m.head.opacity > 0.01;
    if (this.headPool.visible) { this.headPool.position.set(p.x, p.y + 0.07, p.z); this.headPool.rotation.set(0, p.a, 0); }
    // effects: drift smoke, burnout, sparks
    var spd = Math.hypot(p.vx, p.vz), gray = night ? 0.35 : 0.85;
    if (!o.paused) {
      if ((p.drift > 0 && spd > 10) || p.burn > 0.2 || (p.off && spd > 18 && Math.random() < 0.3)) {
        for (var w = -1; w <= 1; w += 2) if (Math.random() < 0.7) this.puff('smoke', p.x - psa * (pc.hz - 0.7) + prx * w * (pc.hx - 0.1), p.y + 0.3, p.z - pca * (pc.hz - 0.7) + prz * w * (pc.hx - 0.1), (Math.random() - 0.5) * 1.5 - p.vx * 0.1, 0.8 + Math.random(), (Math.random() - 0.5) * 1.5 - p.vz * 0.1, 1.2 + Math.random() * 0.6, p.off ? [0.6, 0.52, 0.4] : [gray, gray, gray]);
      }
      if (this.rainOn && spd > 15 && Math.random() < 0.6) this.puff('smoke', p.x - psa * pc.hz, p.y + 0.2, p.z - pca * pc.hz, -p.vx * 0.2, 0.5, -p.vz * 0.2, 0.5, [gray * 0.8, gray * 0.85, gray * 0.9]);
    }
    this.stepFx(dt, o.paused);
    // rain around the camera
    if (this.rain.visible && !o.paused) {
      var rp = this.rain.geometry.attributes.position.array, n = rp.length / 6, cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      for (var k = 0; k < n; k++) {
        var o6 = k * 6, y = rp[o6 + 1] - dt * 26;
        var x = rp[o6], z = rp[o6 + 2];
        if (y < cy - 8 || Math.abs(x - cx) > 32 || Math.abs(z - cz) > 32) { x = cx + (Math.random() - 0.5) * 60; z = cz + (Math.random() - 0.5) * 60; y = cy + 4 + Math.random() * 18; }
        rp[o6] = x; rp[o6 + 1] = y; rp[o6 + 2] = z; rp[o6 + 3] = x + 0.04 - p.vx * 0.02; rp[o6 + 4] = y - 1.0; rp[o6 + 5] = z - p.vz * 0.02;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    // camera
    this.camera(g, dt, o);
    // culling by distance
    var dc = this.drawD + 150, dc2 = dc * dc;
    for (var ti = 0; ti < this.tiles.length; ti++) { var tl = this.tiles[ti], tx = tl.userData.cx - cam.position.x, tz = tl.userData.cz - cam.position.z; tl.visible = tx * tx + tz * tz < dc2; }
    this.far.position.set(cam.position.x, 0, cam.position.z);
    if (this.q.shadows) { this.sun.target.position.set(p.x, p.y, p.z); this.sun.position.set(p.x + this.sunDir[0] * 150, p.y + this.sunDir[1] * 150 + 20, p.z + this.sunDir[2] * 150); }
    else { this.sun.position.set(this.sunDir[0] * 100, this.sunDir[1] * 100, this.sunDir[2] * 100); this.sun.target.position.set(0, 0, 0); }
    this.markers.children.forEach(function (m, mi) { m.visible = g.markerCool !== mi && !g.pursuit; m.material.opacity = 0.6 + 0.3 * Math.sin(self.t * 3); });
    this.r.render(this.scene, cam);
  };
  Rend.prototype.stepFx = function (dt, paused) {
    var self = this;
    ['smoke', 'spark'].forEach(function (kind) {
      var list = self.fx[kind], P = kind === 'smoke' ? self.smokeP : self.sparkP, pa = P.geometry.attributes.position.array, ca = P.geometry.attributes.color.array, n = 0;
      for (var i = list.length - 1; i >= 0; i--) {
        var f = list[i];
        if (!paused) {
          f.t += dt;
          if (f.t >= f.life) { list.splice(i, 1); continue; }
          f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
          if (kind === 'spark') f.vy -= 14 * dt; else { f.vx *= 0.96; f.vz *= 0.96; f.vy *= 0.97; }
        }
        var u = f.t / f.life, al = kind === 'smoke' ? 0.32 * (1 - u) * Math.min(1, u * 5) : 1 - u;
        pa[n * 3] = f.x; pa[n * 3 + 1] = f.y; pa[n * 3 + 2] = f.z;
        ca[n * 4] = f.c[0]; ca[n * 4 + 1] = f.c[1]; ca[n * 4 + 2] = f.c[2]; ca[n * 4 + 3] = al;
        n++;
      }
      P.geometry.setDrawRange(0, n);
      P.geometry.attributes.position.needsUpdate = true; P.geometry.attributes.color.needsUpdate = true;
    });
  };
  Rend.prototype.camera = function (g, dt, o) {
    var p = g.p, cam = this.cam, mode = o.cam || 'chase', H = g.W.H, spd = Math.hypot(p.vx, p.vz);
    if (o.orbit) {
      // a slow orbit; on a wide view the car sits left of the menu card
      var th = this.t * 0.12 + 2.2, R = 9, off = cam.aspect > 1.3 ? 3.2 : 0;
      cam.position.set(p.x + Math.sin(th) * R, p.y + 2.2, p.z + Math.cos(th) * R);
      cam.lookAt(p.x + Math.cos(th) * off, p.y + 0.9, p.z - Math.sin(th) * off);
      this.fovTo(52, 1); this.camInit = false;
      return;
    }
    var k = this.camInit ? 1 - Math.exp(-dt * 4.2) : 1;
    if (!this.camInit) { this.camYaw = p.a; }
    this.camYaw += wrapA(p.a - this.camYaw) * (mode === 'hood' ? Math.min(1, dt * 18) : k);
    var cy = this.camYaw, sx = Math.sin(cy), sz = Math.cos(cy);
    var dist = mode === 'far' ? 10.5 : 6.0, hgt = mode === 'far' ? 3.7 : 2.0;
    dist += Math.min(1.6, spd * 0.018);
    if (cam.aspect < 1 && mode === 'chase') { dist *= 0.86; hgt *= 0.95; }
    var tx, ty, tz;
    if (mode === 'hood') { var pc = this.pc, hf = pc ? pc.hz - 1.55 : 0.5; tx = p.x + Math.sin(p.a) * hf; tz = p.z + Math.cos(p.a) * hf; ty = p.y + (pc ? pc.belt + 0.5 : 1.2); }
    else { tx = p.x - sx * dist; tz = p.z - sz * dist; ty = Math.max(p.y + hgt, H(tx, tz) + 1.2); }
    if (!this.camInit) { cam.position.set(tx, ty, tz); this.camInit = true; }
    else if (mode === 'hood') cam.position.set(tx, ty, tz);
    else {
      var kp = 1 - Math.exp(-dt * 10), ky = 1 - Math.exp(-dt * 7);
      cam.position.x += (tx - cam.position.x) * kp; cam.position.z += (tz - cam.position.z) * kp; cam.position.y += (ty - cam.position.y) * ky;
    }
    var la = mode === 'hood' ? 30 : 8, lx = p.x + Math.sin(mode === 'hood' ? p.a : cy) * la, lz = p.z + Math.cos(mode === 'hood' ? p.a : cy) * la, ly = p.y + (mode === 'hood' ? 1.0 : mode === 'far' ? 1.2 : 1.45);
    if (this.shake > 0.001 && !o.paused) {
      var sh = this.shake * (o.shake ? 0.32 : 0.1);
      cam.position.x += (Math.random() - 0.5) * sh; cam.position.y += (Math.random() - 0.5) * sh; cam.position.z += (Math.random() - 0.5) * sh;
      this.shake *= Math.exp(-dt * 5);
    }
    cam.lookAt(lx, ly, lz);
    var asp = cam.aspect, base = asp < 1 ? 70 : asp < 1.4 ? 62 : 56;
    this.fovTo(base + Math.min(14, spd * 0.17) + (p.nosOn ? 7 : 0) + (mode === 'hood' ? 6 : 0), dt * 3);
  };
  Rend.prototype.fovTo = function (f, k) {
    var c = this.cam, nf = c.fov + (f - c.fov) * Math.min(1, k);
    if (Math.abs(nf - c.fov) > 0.01) { c.fov = nf; c.updateProjectionMatrix(); }
  };
  Rend.prototype.dispose = function () {
    var scene = this.scene, seen = new Set();
    scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) [].concat(o.material).forEach(function (m) { if (!seen.has(m)) { seen.add(m); m.dispose(); } });
      if (o.isInstancedMesh && o.dispose) o.dispose();
    });
    if (this.barrierG) this.barrierG.dispose();
    for (var k in this.m) { var m = this.m[k]; [].concat(m).forEach(function (x) { if (x && x.dispose) x.dispose(); }); }
    for (var t in this.tx) [].concat(this.tx[t]).forEach(function (x) { x.dispose(); });
    if (this.pcTire) this.pcTire.dispose(); if (this.pcRim) this.pcRim.dispose();
    try { this.r.renderLists.dispose(); } catch (e) {}
    this.r.dispose();
    try { this.r.forceContextLoss(); } catch (e) {}
    this.scene = null; this.W = null; this.g = null;
  };

  // ================= UI =================
  var PANEL_ID = 'redline-panel', NAME = 'Redline Run';
  var KEY = 'cade-redline-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  // three.js is vendored next to this file and imported on first open; resolve its URL now (the module context is only valid at load)
  var THREE_URL = (function () { var u = Cade.asset('vendor/three.module.min.js'); try { return new URL(u, document.baseURI).href; } catch (e) { return u; } })();
  var threeP = null;
  function loadThree() { if (!threeP) threeP = import(THREE_URL).then(function (m) { return m; }, function (e) { threeP = null; throw e; }); return threeP; }
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.redline = { live: function () { return S; }, E: ENGINE };   // test-only peek

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function webglOK() {
    try { var c = document.createElement('canvas'), x = c.getContext('webgl2') || c.getContext('webgl'); var ok = !!x; if (x && x.getExtension('WEBGL_lose_context')) x.getExtension('WEBGL_lose_context').loseContext(); return ok; } catch (e) { return false; }
  }
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    S.th = { acc: (cs.getPropertyValue('--accent') || '#e8590c').trim() || '#e8590c', font: (cs.getPropertyValue('--font-mono') || 'ui-monospace, monospace').trim() || 'ui-monospace, monospace' };
  }
  function gfxName() {
    var g = S.save.set.gfx;
    if (g !== 'auto') return g;
    var small = Math.min(screen.width || 800, screen.height || 800) < 600, cores = navigator.hardwareConcurrency || 4;
    if (S.coarse || small) return cores >= 8 && !small ? 'med' : 'low';
    return cores >= 8 ? 'high' : 'med';
  }

  // ---- sound ----
  function Snd(on) { this.on = !!on; this.ac = null; this.eng = null; this.noise = null; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
      try { var n = this.ac.sampleRate, b = this.ac.createBuffer(1, n, n), d = b.getChannelData(0); for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; this.noise = b; } catch (e) { this.noise = null; }
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
      o1.type = 'sawtooth'; o2.type = 'square'; f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 2; g.gain.value = 0.0001;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(ac.destination); o1.frequency.value = 50; o2.frequency.value = 25; o1.start(); o2.start();
      var sk = null, sg = null, sf = null, sir = null, sirG = null;
      if (this.noise) {
        sk = ac.createBufferSource(); sk.buffer = this.noise; sk.loop = true;
        sf = ac.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1800; sf.Q.value = 1.2;
        sg = ac.createGain(); sg.gain.value = 0.0001; sk.connect(sf); sf.connect(sg); sg.connect(ac.destination); sk.start();
      }
      sir = ac.createOscillator(); sir.type = 'triangle'; sir.frequency.value = 700; sirG = ac.createGain(); sirG.gain.value = 0.0001; sir.connect(sirG); sirG.connect(ac.destination); sir.start();
      this.eng = { o1: o1, o2: o2, f: f, g: g, sk: sk, sg: sg, sf: sf, sir: sir, sirG: sirG };
    } catch (e) { this.eng = null; }
  };
  Snd.prototype.engineSet = function (rpm, load, nos, skid, off, siren, sirenT) {
    var e = this.eng;
    if (!e || !this.ok()) return;
    try {
      var t = this.ac.currentTime, fq = 38 + rpm / 1000 * 22 + (nos ? 20 : 0);
      e.o1.frequency.setTargetAtTime(fq, t, 0.04); e.o2.frequency.setTargetAtTime(fq * 0.5, t, 0.04);
      e.f.frequency.setTargetAtTime(320 + rpm * 0.13 + load * 500, t, 0.08);
      e.g.gain.setTargetAtTime(0.016 + load * 0.016 + (nos ? 0.01 : 0), t, 0.08);
      if (e.sg) { e.sg.gain.setTargetAtTime(Math.min(0.08, skid * 0.06 + off * 0.04), t, 0.06); e.sf.frequency.setTargetAtTime(off > skid ? 500 : 1900, t, 0.1); }
      e.sirG.gain.setTargetAtTime(siren ? siren * 0.012 : 0.0001, t, 0.1);
      e.sir.frequency.setTargetAtTime(siren ? 650 + 300 * (0.5 + 0.5 * Math.sin(sirenT * 5)) : 700, t, 0.03);
    } catch (x) {}
  };
  Snd.prototype.engineOff = function () {
    var e = this.eng; this.eng = null;
    if (!e) return;
    try { e.o1.stop(); e.o2.stop(); if (e.sk) e.sk.stop(); e.sir.stop(); } catch (x) {}
    try { e.g.disconnect(); if (e.sg) e.sg.disconnect(); e.sirG.disconnect(); } catch (x) {}
  };
  Snd.prototype.close = function () { this.engineOff(); if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_CAM = svg('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>');
  var ART = '█▀█ █▀▀ █▀▄ █   █ █▄ █ █▀▀\n█▀▄ ██▄ █▄▀ █▄▄ █ █ ▀█ ██▄';
  var ART2 = '══ R U N ══';

  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function money(n) { return '$' + fmtN(n); }
  function ord(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  function units() { return S.save.set.units; }
  function spdTxt(v) { return Math.round(Math.abs(v) * (units() === 'mph' ? 2.23694 : 3.6)); }
  function distTxt(m) { return units() === 'mph' ? (m / 1609.34).toFixed(1) + ' mi' : (m / 1000).toFixed(1) + ' km'; }
  function autoGas() { return S.save.set.autogas === true; }        // opt-in only: the car never moves without the player
  function chip(attr, val, label, on, extra) { return '<button type="button" class="rl-chip' + (on ? ' on' : '') + '" ' + attr + '="' + val + '"' + (extra || '') + '>' + label + '</button>'; }
  function row(label, chips) { return '<div class="rl-sec"><div class="rl-h">' + label + '</div><div class="rl-chips">' + chips + '</div></div>'; }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // ---- cards ----
  function showCard(kind) {
    S.card = kind;
    if (!kind) { S.ovl.style.display = 'none'; S.ovl.innerHTML = ''; S.stage.classList.remove('dim'); syncHead(); return; }
    S.ovl.innerHTML = cardHtml(kind);
    S.ovl.style.display = ''; S.ovl.scrollTop = 0;
    S.stage.classList.toggle('dim', kind !== 'loading');
    syncHead();
  }
  function cardHtml(kind) {
    var sv = S.save, set = sv.set, h = '';
    if (kind === 'menu') {
      h += '<div class="rl-card"><pre class="rl-art">' + ART + '</pre><div class="rl-art2">' + ART2 + '</div>';
      h += '<div class="rl-tabs">' + ['race', 'garage', 'settings'].map(function (t) { return '<button type="button" data-tab="' + t + '" class="' + (S.tab === t ? 'on' : '') + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'; }).join('') + '</div>';
      if (S.tab === 'race') {
        var tier = sv.career.tier, rv = RIVALS[Math.min(RIVALS.length - 1, tier)];
        h += '<button type="button" class="rl-mode" data-act="career" data-primary="1"><b>CAREER</b><span>Climb the ladder: beat each crew\'s races, then the rival in a duel.</span><i>' + (tier >= RIVALS.length ? 'Ladder complete ★' : 'Next rival: ' + esc(rv.name) + ' (' + (tier + 1) + '/' + RIVALS.length + ')') + ' · ' + money(sv.cash) + '</i></button>';
        h += '<button type="button" class="rl-mode" data-act="quick"><b>QUICK RACE</b><span>A new city every time: circuit or sprint vs 3-5 rivals.</span><i>' + (set.qtype === 'sprint' ? 'Sprint' : 'Circuit · ' + set.qlaps + ' laps') + ' · ' + set.qopp + ' rivals' + (set.qcops ? ' · cops' : '') + '</i></button>';
        h += '<button type="button" class="rl-mode" data-act="free"><b>FREE DRIVE</b><span>Roam the city, find race markers, outrun the police.</span><i>' + (sv.free ? 'Continue in ' + esc(cityName(sv.free.seed)) : 'New city') + ' · best bounty ' + money(sv.best.bounty) + '</i></button>';
        var dk = dailyKey(), de = dailyEvent(dk), db = sv.best.daily.d === dk ? sv.best.daily.t : null;
        h += '<button type="button" class="rl-mode" data-act="daily"><b>DAILY · ' + dk + '</b><span>Everyone gets the same ' + (de.type === 'sprint' ? 'sprint' : 'circuit') + ' in ' + esc(cityName(de.seed)) + ', in a ' + esc(CAR_BY[de.car].name) + '.</span><i>' + (db != null ? 'Your best ' + fmtTime(db) : 'Not run yet today') + '</i></button>';
        h += row('Difficulty', DIFFS.map(function (d, i) { return chip('data-diff', i, d.name, set.diff === i); }).join(''));
        h += '<div class="rl-foot"><button type="button" class="rl-lnk" data-act="help">How to drive</button><span>' + sv.stats.races + ' races · ' + sv.stats.wins + ' wins · ' + sv.stats.escapes + ' escapes</span></div>';
      } else if (S.tab === 'garage') h += garageHtml();
      else h += settingsHtml();
      h += '</div>';
    } else if (kind === 'help') {
      h += '<div class="rl-card"><div class="rl-title">HOW TO DRIVE</div>' +
        '<div class="rl-keys"><div><b>↑</b>/<b>W</b> gas · <b>↓</b>/<b>S</b> brake, reverse · <b>← →</b>/<b>A D</b> steer</div>' +
        '<div><b>Space</b> handbrake (drift) · <b>Shift</b>/<b>N</b> nitro</div><div><b>C</b> camera · <b>M</b> map · <b>R</b> back on the road · <b>P</b>/<b>Esc</b> pause</div>' +
        '<div><b>Touch</b> ◀ ▶ steer · <b>GAS</b> <b>BRK</b> <b>DRIFT</b> <b>NOS</b> (multi-touch)</div><div><b>Gamepad</b> stick · RT gas · LT brake · X drift · RB nitro</div></div>' +
        '<p>The car only moves when you press <b>gas</b>. Tap the handbrake into a bend to <b>drift</b> — sliding refills nitro, so do <b>near misses</b> past traffic.</p>' +
        '<p>Side streets are barriered off in races. Walls and traffic cost <b>damage</b>, which costs top speed.</p>' +
        '<p><b>Police</b>: speed past a cruiser and the chase is on. Heat rises while they can see you (roadblocks from heat 3). Break line of sight to fill <b>EVADE</b>; slow down next to a cop and the <b>BUSTED</b> meter fills.</p>' +
        '<button type="button" class="rl-go" data-act="close-help" data-primary="1">' + (S.firstRun ? "LET'S DRIVE" : 'GOT IT') + '</button></div>';
    } else if (kind === 'quick') {
      h += '<div class="rl-card"><div class="rl-top"><span class="rl-brand">QUICK RACE</span><span class="rl-meta">' + esc(CAR_BY[sv.car].name) + '</span></div>';
      h += row('Race', chip('data-q', 'qtype:circuit', 'Circuit', set.qtype === 'circuit') + chip('data-q', 'qtype:sprint', 'Sprint', set.qtype === 'sprint'));
      h += row('Rivals', [3, 4, 5].map(function (n) { return chip('data-q', 'qopp:' + n, n, set.qopp === n); }).join(''));
      if (set.qtype === 'circuit') h += row('Laps', [1, 2, 3].map(function (n) { return chip('data-q', 'qlaps:' + n, n, set.qlaps === n); }).join(''));
      h += row('Police', chip('data-q', 'qcops:0', 'Off', !set.qcops) + chip('data-q', 'qcops:1', 'On', !!set.qcops));
      h += '<div class="rl-note">' + DIFFS[set.diff].name + ' · prize up to ' + money(quickPrize(1)) + '</div>';
      h += '<div class="rl-btns"><button type="button" class="rl-go alt" data-act="menu">Back</button><button type="button" class="rl-go" data-act="go-quick" data-primary="1">RACE</button></div></div>';
    } else if (kind === 'career') {
      var ct = S.ctier == null ? Math.min(sv.career.tier, RIVALS.length - 1) : S.ctier, R0 = RIVALS[ct], evs = careerEvents(ct), lock = ct > sv.career.tier;
      h += '<div class="rl-card"><div class="rl-top"><span class="rl-brand">CAREER</span><span class="rl-meta"><b>' + money(sv.cash) + '</b></span></div>';
      h += '<div class="rl-ladder">' + RIVALS.map(function (r, i) {
        var st = i < sv.career.tier ? '✓' : i === sv.career.tier ? '▶' : '·';
        return '<button type="button" class="rl-rung' + (i === ct ? ' on' : '') + (i > sv.career.tier ? ' lock' : '') + '" data-tier="' + i + '"' + (i > sv.career.tier ? ' disabled' : '') + '><b style="color:' + rgb(r.col) + '">■</b> ' + (i + 1) + '<i>' + st + '</i></button>';
      }).join('') + '</div>';
      h += '<div class="rl-boss"><div><b style="color:' + rgb(R0.col) + '">■ ' + esc(R0.name) + '</b> · ' + esc(CAR_BY[R0.car].name) + '</div><span>' + esc(R0.trait) + '</span></div>';
      h += '<div class="rl-evs">';
      evs.forEach(function (e, i) {
        var dn = sv.career.done[ct + '-' + i] || 0, label = e.type === 'circuit' ? 'Circuit · ' + e.laps + ' laps' : e.type === 'sprint' ? 'Sprint' : e.type === 'escape' ? 'Escape · heat ' + e.heat : 'Duel vs ' + R0.name;
        var stx = dn ? (e.type === 'escape' ? '✓ escaped' : '✓ ' + ord(10 - dn)) : 'prize ' + money(e.prize);
        h += '<button type="button" class="rl-ev' + (e.type === 'duel' ? ' duel' : '') + (dn ? ' done' : '') + '" data-ev="' + i + '"' + (lock ? ' disabled' : '') + (i === firstOpen(ct) ? ' data-primary="1"' : '') + '><b>' + esc(label) + '</b><span>' + esc(cityName(hashStr('redline-city-' + ct))) + ' · ' + (e.opp ? e.opp + (e.opp === 1 ? ' rival' : ' rivals') : 'police') + '</span><i>' + stx + '</i></button>';
      });
      h += '</div><div class="rl-note">Finish top 3 to clear a race (escape = lose the police). Win the duel to unlock the next rival. Replays pay half.</div>';
      h += '<div class="rl-btns"><button type="button" class="rl-go alt" data-act="menu">Back</button><button type="button" class="rl-go alt" data-act="garage">Garage</button></div></div>';
    } else if (kind === 'pause') {
      var gk = S.g;
      h += '<div class="rl-card"><div class="rl-title">PAUSED</div>';
      if (gk && gk.kind === 'race') h += '<div class="rl-sub">' + esc(gk.W.name) + ' · ' + (gk.type === 'sprint' ? 'Sprint ' + distTxt(gk.total) : 'Circuit ' + distTxt(gk.R.len) + ' × ' + gk.laps) + '</div>';
      else if (gk) h += '<div class="rl-sub">' + esc(gk.W.name) + ' · free drive' + (gk.pursuit ? ' · in pursuit!' : '') + '</div>';
      h += row('Camera <i>C</i>', chip('data-set', 'cam:chase', 'Chase', set.cam === 'chase') + chip('data-set', 'cam:far', 'Far', set.cam === 'far') + chip('data-set', 'cam:hood', 'Hood', set.cam === 'hood'));
      h += '<button type="button" class="rl-go" data-act="resume" data-primary="1">RESUME</button>';
      h += '<div class="rl-btns">' + (gk && gk.kind === 'race' ? '<button type="button" class="rl-go alt" data-act="restart">Restart</button>' : '<button type="button" class="rl-go alt" data-act="reset-car">Reset car</button>') + '<button type="button" class="rl-go alt" data-act="quit">Quit</button></div></div>';
    } else if (kind === 'result') {
      var R = S.res;
      h += '<div class="rl-card"><div class="rl-title">' + esc(R.title) + '</div>';
      if (R.big) h += '<div class="rl-big">' + R.big + '</div>';
      if (R.rows) {
        h += '<div class="rl-res">';
        var lead = R.rows[0].t;
        R.rows.forEach(function (r) { h += '<div class="' + (r.you ? 'you' : '') + '"><span>' + r.pos + '</span><b' + (r.col ? ' style="color:' + rgb(r.col) + '"' : '') + '>■</b> ' + esc(r.name) + '<i>' + (r.pos === 1 ? fmtTime(r.t) : '+' + (r.t - lead).toFixed(2) + (r.fin ? '' : '*')) + '</i></div>'; });
        h += '</div>';
      }
      (R.lines || []).forEach(function (l) { h += '<div class="' + (l.hot ? 'rl-new' : 'rl-note') + '">' + esc(l.t) + '</div>'; });
      h += '<div class="rl-btns">' + R.btns.map(function (b, i) { return '<button type="button" class="rl-go' + (i < R.btns.length - 1 ? ' alt' : '') + '" data-act="' + b[0] + '"' + (i === R.btns.length - 1 ? ' data-primary="1"' : '') + '>' + esc(b[1]) + '</button>'; }).join('') + '</div></div>';
    } else if (kind === 'marker') {
      var mk = S.g.W.markers[S.mk], pz = quickPrize(1);
      h += '<div class="rl-card"><div class="rl-title">' + (mk.type === 'sprint' ? 'SPRINT' : 'CIRCUIT') + '</div><div class="rl-sub">A street race starts here · 3 rivals · ' + DIFFS[set.diff].name + '</div><div class="rl-note">Win up to ' + money(pz) + '</div>';
      h += '<div class="rl-btns"><button type="button" class="rl-go alt" data-act="marker-no">Not now</button><button type="button" class="rl-go" data-act="marker-go" data-primary="1">RACE</button></div></div>';
    } else if (kind === 'loading') {
      h += '<div class="rl-card rl-load"><pre class="rl-art">' + ART + '</pre><div class="rl-sub">' + esc(S.loadMsg || 'Loading…') + '</div><div class="rl-spin"></div></div>';
    } else if (kind === 'nogl') {
      h += '<div class="rl-card"><div class="rl-title">NO 3D HERE</div><p>Redline Run draws a real 3D city, and this browser or device has <b>WebGL</b> turned off or unavailable' + (S.glErr ? ' (' + esc(S.glErr) + ')' : '') + '.</p>' +
        '<p>Try another browser, enable hardware acceleration, or take one of the 2D racers for a spin:</p>' +
        '<div class="rl-btns"><button type="button" class="rl-go alt" data-act="open-apex">Apex Rush</button><button type="button" class="rl-go alt" data-act="open-heat">Street Heat</button></div>' +
        '<button type="button" class="rl-go" data-act="close" data-primary="1">CLOSE</button></div>';
    }
    return h;
  }
  function firstOpen(tier) { var evs = careerEvents(tier); for (var i = 0; i < evs.length; i++) if (!S.save.career.done[tier + '-' + i]) return i; return evs.length - 1; }
  function pips(n, m) { var s = ''; for (var i = 0; i < m; i++) s += i < n ? '■' : '□'; return s; }
  function garageHtml() {
    var sv = S.save, h = '<div class="rl-top"><span class="rl-brand">GARAGE</span><span class="rl-meta"><b>' + money(sv.cash) + '</b></span></div><div class="rl-cars">';
    CARS.forEach(function (c) {
      var own = sv.cars.indexOf(c.id) >= 0, cur = sv.car === c.id, st = carStats(c.id, sv.upg[c.id]);
      h += '<button type="button" class="rl-car' + (cur ? ' on' : '') + '" data-car="' + c.id + '"' + (!own && sv.cash < c.price ? ' disabled' : '') + '><b><em style="background:' + rgb(carColor(sv, c.id)) + '"></em>' + esc(c.name) + '</b>' +
        '<span>top ' + spdTxt(st.top) + ' · grip ' + st.grip.toFixed(2) + '</span><i>' + (cur ? 'driving' : own ? 'owned — select' : money(c.price)) + '</i></button>';
    });
    h += '</div><div class="rl-upgs">';
    var u = upgOf(sv, sv.car);
    UPGS.forEach(function (U) {
      var c = upgCost(sv, sv.car, U.id), l = u[U.id];
      h += '<div class="rl-upg"><div><b>' + U.name + '</b> <span class="rl-pips">' + pips(l, 3) + '</span><i>' + U.note + '</i></div>' +
        (l >= 3 ? '<span class="rl-max">MAX</span>' : '<button type="button" class="rl-buy" data-buy="' + U.id + '"' + (sv.cash >= c ? '' : ' disabled') + '>' + money(c) + '</button>') + '</div>';
    });
    h += '</div><div class="rl-sec"><div class="rl-h">Paint · ' + esc(CAR_BY[sv.car].name) + '</div><div class="rl-chips">';
    var pr = paintOf(sv, sv.car);
    PAINTS.forEach(function (pt, i) {
      var own = pr.own.indexOf(i) >= 0, col = pt.col ? rgb(pt.col) : rgb(CAR_BY[sv.car].col);
      h += '<button type="button" class="rl-chip rl-paint' + (pr.cur === i ? ' on' : '') + '" data-paint="' + i + '"' + (!own && sv.cash < pt.cost ? ' disabled' : '') + '><b style="background:' + col + '"></b>' + esc(pt.name) + (own ? '' : ' <i>' + money(pt.cost) + '</i>') + '</button>';
    });
    h += '</div></div><div class="rl-note">Cash comes from races, escapes and Free Drive bounties. The Daily uses a set car.</div>';
    return h;
  }
  function settingsHtml() {
    var set = S.save.set, h = '', gn = gfxName();
    h += row('Graphics', chip('data-set', 'gfx:auto', 'Auto' + (set.gfx === 'auto' ? ' (' + ({ low: 'Low', med: 'Medium', high: 'High' })[gn] + ')' : ''), set.gfx === 'auto') + chip('data-set', 'gfx:low', 'Low', set.gfx === 'low') + chip('data-set', 'gfx:med', 'Medium', set.gfx === 'med') + chip('data-set', 'gfx:high', 'High', set.gfx === 'high'));
    h += row('Camera <i>C</i>', chip('data-set', 'cam:chase', 'Chase', set.cam === 'chase') + chip('data-set', 'cam:far', 'Far chase', set.cam === 'far') + chip('data-set', 'cam:hood', 'Hood', set.cam === 'hood'));
    h += row('Time of day', ['auto', 'day', 'dusk', 'night'].map(function (t) { return chip('data-set', 'time:' + t, { auto: 'Auto', day: 'Afternoon', dusk: 'Dusk', night: 'Night' }[t], set.time === t); }).join(''));
    h += row('Weather', ['auto', 'clear', 'rain'].map(function (t) { return chip('data-set', 'weather:' + t, { auto: 'Auto', clear: 'Clear', rain: 'Rain' }[t], set.weather === t); }).join(''));
    h += row('Units', chip('data-set', 'units:kmh', 'km/h', set.units === 'kmh') + chip('data-set', 'units:mph', 'mph', set.units === 'mph'));
    h += row('Steering', chip('data-set', 'sens:0.75', 'Gentle', +set.sens === 0.75) + chip('data-set', 'sens:1', 'Normal', +set.sens === 1) + chip('data-set', 'sens:1.3', 'Sharp', +set.sens === 1.3));
    h += row('Touch steering', chip('data-set', 'touch:buttons', 'Buttons', set.touch === 'buttons') + chip('data-set', 'touch:tilt', 'Tilt', set.touch === 'tilt'));
    if (set.touch === 'tilt') h += '<div class="rl-tilt"><button type="button" class="rl-go alt" data-act="tilt">' + (S.tiltOn ? 'Tilt is on ✓' : 'Enable tilt') + '</button><span>' + esc(S.tiltMsg || 'Hold the phone like a wheel.') + '</span></div>';
    h += row('Auto gas <i>touch only</i>', chip('data-set', 'autogas:off', 'Off', !autoGas()) + chip('data-set', 'autogas:on', 'On', autoGas()));
    h += row('Screen shake', chip('data-set', 'shake:1', 'On', !!set.shake) + chip('data-set', 'shake:0', 'Low', !set.shake));
    h += '<div class="rl-foot">' + (S.resetArm ? '<span class="rl-confirm">Erase cash, cars and career? <button type="button" class="rl-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="rl-lnk" data-act="reset-no">Keep</button></span>'
      : '<button type="button" class="rl-lnk" data-act="reset">Reset progress</button>') + '</div>';
    return h;
  }
  function quickPrize(place) { return Math.round([900, 550, 300, 120, 0, 0][place - 1] * (1 + S.save.set.diff * 0.4) / 10) * 10; }

  // ---- worlds, events ----
  var worldCache = { seed: -1, W: null };
  function getWorld(seed) {
    seed = seed >>> 0;
    if (worldCache.seed === seed && worldCache.W) return worldCache.W;
    worldCache.W = makeWorld(seed); worldCache.seed = seed;
    return worldCache.W;
  }
  function pickTod(seed) {
    var set = S.save.set, r = mulberry32((seed ^ 0xdead) >>> 0), tod, rain;
    if (set.time !== 'auto') tod = set.time;
    else { var x = r(); tod = x < 0.55 ? 'day' : x < 0.85 ? 'dusk' : 'night'; }
    if (set.weather !== 'auto') rain = set.weather === 'rain'; else rain = r() < 0.15;
    return { tod: tod, rain: rain };
  }
  function clockTod() { var h = new Date().getHours(); return h >= 7 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night'; }
  // ev: { kind: 'quick'|'career'|'daily'|'free'|'freeRace'|'attract', ... }
  function buildGame(ev) {
    var sv = S.save, set = sv.set, car = sv.car, upg = sv.upg[car], o, W, td;
    if (ev.kind === 'quick') {
      var seed = (Math.random() * 4294967295) >>> 0;
      W = getWorld(seed); td = pickTod(seed);
      o = { world: W, kind: 'race', type: set.qtype, loop: (seed % 4) !== 0 || set.qlaps > 1, laps: set.qlaps, opp: set.qopp, diff: set.diff, car: car, upg: upg, seed: seed ^ 0x77, cops: !!set.qcops, tod: td.tod, rain: td.rain };
      if (!o.loop) o.laps = 1;
      o.rivals = crew(seed, set.qopp, Math.min(3, Math.floor(CAR_BY[car].ix * 0.8)));
    } else if (ev.kind === 'career') {
      var ce = careerEvents(ev.tier)[ev.i];
      W = getWorld(hashStr('redline-city-' + ev.tier)); td = pickTod(ce.seed);
      if (ce.type === 'escape') o = { world: W, kind: 'free', escape: true, heat: ce.heat, diff: set.diff, car: car, upg: upg, seed: ce.seed, tod: td.tod, rain: td.rain };
      else o = { world: W, kind: 'race', type: ce.type === 'circuit' ? 'circuit' : 'sprint', loop: true, laps: ce.laps || 1, opp: ce.opp, duel: ce.type === 'duel', diff: set.diff, car: car, upg: upg, seed: ce.seed, tod: td.tod, rain: td.rain, rivals: careerRivals(ev.tier, ce) };
      ev.ce = ce;
    } else if (ev.kind === 'daily') {
      var de = dailyEvent(dailyKey());
      W = getWorld(de.seed); car = de.car; upg = {};
      o = { world: W, kind: 'race', type: de.type, loop: true, laps: de.laps, opp: de.opp, diff: 1, car: car, upg: upg, seed: de.seed ^ 0x99, tod: de.tod, rain: de.rain, rivals: crew(de.seed, de.opp, 1) };
      ev.key = de.key;
    } else if (ev.kind === 'freeRace') {
      var mk = ev.W.markers[ev.m];
      W = ev.W;
      o = { world: W, kind: 'race', type: mk.type, loop: true, laps: 2, opp: 3, diff: set.diff, car: car, upg: upg, seed: mk.seed, tod: ev.tod, rain: ev.rain, rivals: crew(mk.seed, 3, Math.min(3, CAR_BY[car].ix)) };
    } else {
      var fs = sv.free && isFinite(sv.free.seed) ? sv.free.seed : (Math.random() * 4294967295) >>> 0;
      W = getWorld(fs);
      var t2 = set.time === 'auto' ? clockTod() : set.time, rn = set.weather === 'rain';
      if (ev.kind === 'free' && !sv.free) sv.free = { seed: fs, x: NaN, z: NaN, a: 0, dmg: 0 };
      var sp = ev.spawn || (sv.free && sv.free.seed === fs && isFinite(sv.free.x) ? { x: sv.free.x, z: sv.free.z, a: sv.free.a, dmg: sv.free.dmg } : null);
      o = { world: W, kind: 'free', diff: set.diff, car: car, upg: upg, seed: fs, tod: ev.kind === 'attract' ? (set.time === 'auto' ? 'day' : set.time) : t2, rain: rn, spawn: sp };
    }
    var g = newGame(o);
    if (ev.kind === 'attract') { g.copsOn = false; g.attract = true; }
    return { g: g, car: car, col: ev.kind === 'daily' ? CAR_BY[car].col : carColor(sv, car) };
  }
  function crew(seed, n, lvl) {
    var r = mulberry32(seed ^ 0xc0ffee), out = [];
    for (var i = 0; i < n; i++) out.push({ id: 'crew' + i, name: CREW[(i + (seed % 11)) % CREW.length], car: CARS[clamp(Math.floor(r() * 3) + (lvl > 1 ? 1 : 0), 0, CARS.length - 1)].id, col: [[90, 160, 230], [230, 90, 90], [240, 200, 60], [90, 200, 140], [200, 120, 230]][i % 5], skill: 0.96 + r() * 0.06, lvl: lvl });
    return out;
  }
  function startEvent(ev) {
    if (!S.rend) return;
    S.ev = ev; S.mode = 'loading'; S.paused = false; stopLoop();
    S.snd.engineOff();
    var W0 = ev.kind === 'freeRace' ? ev.W : null, name = W0 ? W0.name : '';
    S.loadMsg = ev.kind === 'freeRace' ? 'Lining up on the grid…' : 'Building the city' + (name ? ' of ' + name : '') + '…';
    showCard('loading');
    clearTimeout(S.loadT);
    S.loadT = setTimeout(function () {
      if (!S || !S.rend) return;
      var b;
      try { b = buildGame(ev); } catch (e) { console.error(e); if (Cade.showToast) Cade.showToast('Could not build the race', 'error', 2000); toMenu(); return; }
      S.g = b.g; S.carId = b.car;
      try { S.rend.setGame(S.g, { car: b.car, col: b.col }); } catch (e2) { console.error(e2); glFail(String(e2 && e2.message || e2)); return; }
      S.mapKey = ''; S.msg = null; S.mapBig = false;
      if (ev.kind === 'attract') { S.mode = 'menu'; showCard(S.backCard || 'menu'); S.backCard = null; layout(); kick(); return; }
      beginPlay();
    }, 40);
  }
  function beginPlay() {
    S.mode = 'play'; S.paused = false; S.acc = 0; S.keys = {}; clearHeld(); S.saveT = 0;
    showCard(null); layout();
    S.snd.ensure(); S.snd.engineOn();
    if (S.g.kind === 'race') say(S.g.W.name.toUpperCase(), S.g.type === 'sprint' ? 'Sprint · ' + distTxt(S.g.total) : 'Circuit · ' + S.g.laps + (S.g.laps === 1 ? ' lap' : ' laps') + ' · ' + distTxt(S.g.R.len), null, 2.6);
    else if (S.g.escape) say('LOSE THE COPS', 'Break their line of sight', '#ff5a4a', 2.6);
    else say(S.g.W.name.toUpperCase(), 'Free drive · find a race marker', null, 2.6);
    kick();
  }
  function toMenu(card) {
    S.mode = 'menu'; S.paused = false; S.resetArm = false; S.mapBig = false;
    S.snd.engineOff();
    if (S.g && S.g.kind === 'free' && !S.g.attract && !S.g.escape) saveFree();
    if (S.rend && !(S.g && S.g.attract)) { S.backCard = card || 'menu'; startEvent({ kind: 'attract' }); return; }
    layout();
    showCard(card || 'menu');
    kick();
  }
  function saveFree() {
    var g = S.g, p = g.p;
    if (!g || g.kind !== 'free' || g.attract || g.escape) return;
    S.save.free = { seed: g.W.seed, x: p.x, z: p.z, a: p.a, dmg: p.dmg };
    persist();
  }
  function pause() {
    if (!S || S.mode !== 'play' || S.paused) return;
    S.paused = true; clearHeld(); S.keys = {};
    S.snd.engineOff();
    showCard('pause'); stopLoop(); renderOnce();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; showCard(null);
    S.snd.ensure(); S.snd.engineOn(); kick();
  }
  function quitPlay() {
    S.paused = false;
    var ev = S.ev;
    if (ev && ev.kind === 'freeRace') { backToFree(); return; }
    toMenu(ev && ev.kind === 'career' ? 'career' : 'menu');
  }
  function backToFree() {
    var ev = S.ev, g = S.g, sp = null;
    if (g && g.kind === 'race') { var p = g.p; sp = { x: p.x, z: p.z, a: p.a, dmg: 0 }; }
    startEvent({ kind: 'free', spawn: sp });
    void ev;
  }
  function finishRace() {
    var g = S.g, ev = S.ev, sv = S.save, p = g.p;
    S.mode = 'over'; S.snd.engineOff(); clearHeld();
    var R = { lines: [], btns: [] };
    if (g.kind === 'race') {
      var rows = g.result || standings(g), me = rows.filter(function (r) { return r.you; })[0], place = me.pos;
      R.rows = rows; R.title = place === 1 ? 'VICTORY' : place <= 3 ? 'PODIUM' : 'FINISHED';
      R.big = ord(place) + '<small> / ' + rows.length + '</small>';
      sv.stats.races++; if (place === 1) sv.stats.wins++;
      if (ev.kind === 'career') {
        var out = careerAward(sv, ev.ce, place, false);
        R.lines.push({ t: out.passed ? (ev.ce.type === 'duel' ? RIVALS[ev.tier].name + ' is beaten!' : 'Race cleared') : (ev.ce.type === 'duel' ? 'Win the duel to move up' : 'Top 3 clears the race'), hot: out.passed });
        if (out.cash) R.lines.push({ t: '+' + money(out.cash) + (out.first ? '' : ' (replay)'), hot: true });
        if (out.unlocked) R.lines.push({ t: sv.career.tier >= RIVALS.length ? 'You run this town. Ladder complete!' : 'UNLOCKED: ' + RIVALS[sv.career.tier].name, hot: true });
        R.btns = [['retry', 'Retry'], ['garage', 'Garage'], ['to-career', 'CONTINUE']];
      } else if (ev.kind === 'daily') {
        if (p.fin) {
          var t = p.fin, b = sv.best.daily;
          if (b.d !== ev.key || b.t == null || t < b.t) { sv.best.daily = { d: ev.key, t: t }; R.lines.push({ t: 'NEW DAILY BEST ' + fmtTime(t), hot: true }); }
          else R.lines.push({ t: 'Best today ' + fmtTime(b.t) });
        }
        R.btns = [['menu', 'Menu'], ['retry', 'AGAIN']];
      } else {
        var cash = quickPrize(place);
        if (cash) { sv.cash += cash; R.lines.push({ t: '+' + money(cash), hot: true }); }
        R.lines.push({ t: esc(g.W.name) + ' · ' + DIFFS[g.diff].name + (g.near ? ' · ' + g.near + ' near misses' : '') });
        R.btns = ev.kind === 'freeRace' ? [['free-back', 'BACK TO THE STREETS']] : [['menu', 'Menu'], ['retry', 'RACE AGAIN']];
      }
    } else if (g.escape) {
      var esc2 = g.result && g.result.escaped, o2 = careerAward(sv, ev.ce, 0, esc2);
      R.title = esc2 ? 'ESCAPED' : 'BUSTED';
      R.big = esc2 ? money(g.result.bounty) + '<small> bounty</small>' : '';
      if (esc2) { sv.stats.escapes++; R.lines.push({ t: 'Event cleared', hot: true }); if (o2.cash) R.lines.push({ t: '+' + money(o2.cash) + (o2.first ? '' : ' (replay)'), hot: true }); }
      else { sv.stats.busts++; R.lines.push({ t: 'Stay fast and out of sight. Roadblocks have a gap.' }); }
      R.btns = [['retry', 'Retry'], ['to-career', 'CONTINUE']];
    }
    S.res = R;
    persist();
    showCard('result');
    S.snd.tone(R.title === 'BUSTED' ? 220 : 784, 0.3, 'triangle', 0.05, R.title === 'BUSTED' ? 110 : null);
    layout(); kick();
  }

  // ---- engine events -> sound, shake, messages ----
  function say(txt, sub, col, t) { S.msg = { txt: txt, sub: sub || '', col: col || null, t: t || 1.5, t0: t || 1.5 }; }
  function handleEvents() {
    var g = S.g, ev = g.ev, snd = S.snd, rd = S.rend;
    if (g.attract) { ev.length = 0; return; }
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.t) {
        case 'beep': snd.tone(523, 0.16, 'square', 0.04); break;
        case 'go': snd.tone(1046, 0.45, 'square', 0.05); say('GO!', '', null, 0.9); break;
        case 'hit': case 'crash':
          rd.kick(e.hard ? 1.3 : 0.6); rd.sparks(e.x, S.g.p.y, e.z, e.hard ? 22 : 10);
          snd.hiss(e.hard ? 0.45 : 0.22, e.hard ? 0.28 : 0.13, e.hard ? 240 : 320, 0.7); snd.tone(e.hard ? 70 : 90, 0.25, 'square', 0.06, 45);
          if (Cade.haptic) Cade.haptic(e.hard ? 45 : 16);
          break;
        case 'scrape': if (Math.random() < 0.3) { snd.hiss(0.12, 0.06, 2600, 2); rd.sparks(g.p.x, g.p.y, g.p.z, 3); } break;
        case 'near': say('NEAR MISS', '+nitro', null, 0.8); snd.tone(1200, 0.08, 'triangle', 0.035, 1600); break;
        case 'drift': if (e.pts > 150) say('DRIFT ' + fmtN(e.pts), '', null, 1); break;
        case 'nos': snd.hiss(0.6, 0.12, 900, 0.4); snd.tone(220, 0.4, 'sawtooth', 0.03, 440); break;
        case 'lap': say(e.final ? 'FINAL LAP' : 'LAP ' + e.n + '/' + g.laps, '', null, 1.8); snd.tone(659, 0.12, 'triangle', 0.05); snd.tone(880, 0.2, 'triangle', 0.05, null, 0.12); break;
        case 'finish': say(ord(e.place) + ' PLACE', e.place === 1 ? 'Winner!' : e.place <= 3 ? 'On the podium' : 'Finished', null, 3); [523, 659, 784, 1046].forEach(function (f, j) { snd.tone(f, 0.2, 'triangle', 0.05, null, j * 0.11); }); break;
        case 'wrong': say('WRONG WAY', 'turn around (R resets)', '#ff5a4a', 1.5); break;
        case 'pursuit': say('PURSUIT', 'Heat ' + e.heat + ' — lose them!', '#ff5a4a', 2); snd.tone(880, 0.15, 'square', 0.04); snd.tone(660, 0.15, 'square', 0.04, null, 0.18); break;
        case 'spotted': break;
        case 'heat': say('HEAT ' + e.heat, e.heat >= 3 ? 'Roadblocks ahead' : 'More units', '#ff7a2a', 1.6); snd.tone(440, 0.2, 'sawtooth', 0.04, 660); break;
        case 'roadblock': say('ROADBLOCK', 'find the gap', '#ff5a4a', 1.4); break;
        case 'evaded':
          say('EVADED', e.bounty ? '+' + money(e.bounty) + ' bounty' : '', '#5ad19a', 2.5);
          if (!g.escape) { S.save.cash += e.bounty; S.save.stats.escapes++; S.save.best.bounty = Math.max(S.save.best.bounty, e.bounty); S.save.best.heat = Math.max(S.save.best.heat, e.heat); persist(); }
          [659, 880, 1175].forEach(function (f, j) { snd.tone(f, 0.18, 'triangle', 0.05, null, j * 0.1); });
          break;
        case 'busted':
          say('BUSTED', g.escape ? '' : 'Fine ' + money(Math.min(S.save.cash, e.fine)), '#ff4040', 2.5);
          if (!g.escape) { S.save.cash = Math.max(0, S.save.cash - e.fine); S.save.stats.busts++; persist(); }
          snd.tone(330, 0.3, 'square', 0.05, 160); rd.kick(0.8);
          break;
        case 'marker':
          if (S.mode === 'play' && !S.paused && g.kind === 'free') { S.mk = e.m; S.paused = true; clearHeld(); S.keys = {}; S.snd.engineOff(); showCard('marker'); stopLoop(); }
          break;
        case 'reset': S.rend.camInit = false; break;
        case 'done': S.doneT = 0.01; break;
      }
    }
    ev.length = 0;
  }

  // ---- input ----
  function clearHeld() {
    if (!S) return;
    S.hold = { l: 0, r: 0, g: 0, b: 0, n: 0, h: 0 };
    if (S.pad) Array.prototype.forEach.call(S.pad.querySelectorAll('.on'), function (b) { b.classList.remove('on'); });
  }
  function input() {
    var k = S.keys, h = S.hold, set = S.save.set, steer = 0, gp = S.gpIn || {};
    if (k.ArrowLeft || k.KeyA) steer -= 1;
    if (k.ArrowRight || k.KeyD) steer += 1;
    if (h.l) steer -= 1;
    if (h.r) steer += 1;
    if (set.touch === 'tilt' && S.tiltOn) steer += S.tiltV;
    if (gp.steer) steer += gp.steer;
    steer = clamp(steer, -1, 1);
    var brake = k.ArrowDown || k.KeyS || h.b || gp.brake ? 1 : 0, gas = k.ArrowUp || k.KeyW || h.g || gp.gas ? 1 : 0;
    if (!gas && !brake && autoGas() && S.touchUsed) gas = 1;
    return { steer: steer, gas: gas, brake: brake, hb: k.Space || h.h || gp.hb ? 1 : 0, nos: k.ShiftLeft || k.ShiftRight || k.KeyN || h.n || gp.nos ? 1 : 0, sens: +set.sens || 1 };
  }
  var IDLE = { steer: 0, gas: 0, brake: 0, hb: 0, nos: 0, sens: 1 };
  var KEY2CODE = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', enter: 'Enter', escape: 'Escape', p: 'KeyP', c: 'KeyC', m: 'KeyM', n: 'KeyN', r: 'KeyR', a: 'KeyA', d: 'KeyD', w: 'KeyW', s: 'KeyS', shift: 'ShiftLeft' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
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
      else if (S.paused && S.card === 'pause') resume();
      else if (S.card === 'marker') act('marker-no');
      else if (code === 'Escape') {
        if (S.card === 'help') closeHelp();
        else if (S.card === 'quick' || S.card === 'career') toMenu();
        else if (S.card === 'menu' && S.tab !== 'race') { S.tab = 'race'; showCard('menu'); }
        else if (S.card === 'menu' || S.card === 'nogl') closePanel();
      }
      return;
    }
    if (S.mode === 'play' && !S.paused) {
      if (code === 'KeyC') { e.preventDefault(); if (!e.repeat) cycleCam(); return; }
      if (code === 'KeyM') { e.preventDefault(); if (!e.repeat) S.mapBig = !S.mapBig; return; }
      if (code === 'KeyR') { e.preventDefault(); if (!e.repeat && S.g.phase !== 'count') resetCar(S.g); return; }
      if (DRIVE_KEYS[code]) { e.preventDefault(); S.keys[code] = true; S.touchUsed = false; }
      return;
    }
    if (!S.card || S.card === 'loading') return;
    // menus: arrows move between buttons, Enter / Space press
    if (/^Arrow/.test(code)) {
      var bs = Array.prototype.filter.call(S.ovl.querySelectorAll('button'), function (b) { return !b.disabled && b.offsetParent !== null; });
      if (!bs.length) return;
      e.preventDefault();
      var i = bs.indexOf(document.activeElement), dir = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;
      if (i < 0) { var pr = S.ovl.querySelector('[data-primary]'); i = pr ? bs.indexOf(pr) - dir : -1; }
      var nb = bs[(i + dir + bs.length) % bs.length];
      try { nb.focus({ preventScroll: false }); } catch (er) {}
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      e.preventDefault();
      if (e.repeat) return;
      var a = document.activeElement;
      if (a && a.tagName === 'BUTTON' && S.ovl.contains(a)) { a.click(); return; }
      var b = S.ovl.querySelector('[data-primary]');
      if (b) b.click();
    }
  }
  function onKeyUp(e) { if (!S) return; var code = keyCode(e); if (S.keys[code]) delete S.keys[code]; if (code === 'ShiftLeft' || code === 'ShiftRight') { delete S.keys.ShiftLeft; delete S.keys.ShiftRight; } }
  function cycleCam() {
    var order = ['chase', 'far', 'hood'], c = S.save.set.cam;
    S.save.set.cam = order[(order.indexOf(c) + 1) % order.length];
    persist(); syncHead();
    if (S.rend) S.rend.camInit = false;
    if (S.card === 'pause' || (S.card === 'menu' && S.tab === 'settings')) showCard(S.card);
    if (!S.raf) renderOnce();
  }
  function closeHelp() { S.firstRun = false; if (S.paused) showCard('pause'); else showCard('menu'); }
  function onTilt(e) {
    if (!S) return;
    var ang = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0), v;
    if (ang === 90) v = e.beta; else if (ang === -90 || ang === 270) v = -e.beta; else v = e.gamma;
    if (v == null) return;
    S.tiltOn = true;
    var d = Math.abs(v) < 2.5 ? 0 : v - (v > 0 ? 2.5 : -2.5);
    S.tiltV = clamp(d / 20, -1, 1);
  }
  function enableTilt() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { S.tiltMsg = 'No tilt sensor here.'; showCard(S.card); return; }
    function on() { if (!S.tiltL) { S.tiltL = onTilt; window.addEventListener('deviceorientation', S.tiltL); } S.tiltMsg = 'Tilt the phone to steer.'; setTimeout(function () { if (S && S.card === 'menu') showCard('menu'); }, 400); }
    if (typeof DOE.requestPermission === 'function') DOE.requestPermission().then(function (r) { if (!S) return; if (r === 'granted') on(); else { S.tiltMsg = 'Permission denied.'; showCard(S.card); } }, function () { if (S) { S.tiltMsg = 'Permission needed (tap again).'; showCard(S.card); } });
    else on();
  }
  // gamepad: stick / d-pad steer, RT or A gas, LT or B brake, X drift, RB nitro, Y camera, Back map, LB reset, Start pause
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
    S.gpIn = { steer: st, gas: btnV(p, 7) > 0.2 || btnV(p, 0) > 0.5, brake: btnV(p, 6) > 0.2 || btnV(p, 1) > 0.5, hb: btnV(p, 2) > 0.5, nos: btnV(p, 5) > 0.5 };
    var start = btnV(p, 9) > 0.5, y = btnV(p, 3) > 0.5, a = btnV(p, 0) > 0.5, bk = btnV(p, 8) > 0.5, lb = btnV(p, 4) > 0.5;
    if (start && !gp.st) { if (S.mode === 'play' && !S.paused) pause(); else if (S.paused && S.card === 'pause') resume(); }
    if (y && !gp.y) cycleCam();
    if (bk && !gp.bk && S.mode === 'play') S.mapBig = !S.mapBig;
    if (lb && !gp.lb && S.mode === 'play' && !S.paused && S.g) resetCar(S.g);
    if (a && !gp.a && S.mode !== 'play' && S.card) { var b = S.ovl.querySelector('[data-primary]'); if (b) b.click(); }
    gp.st = start; gp.y = y; gp.a = a; gp.bk = bk; gp.lb = lb;
  }

  // ---- loop ----
  function running() { return !!S && !!S.rend && !!S.g && S.mode !== 'loading' && S.mode !== 'nogl' && !(S.mode === 'play' && S.paused) && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel)); }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function renderOnce() { if (S && S.rend && S.g) { try { S.rend.frame(S.g, 0, rOpts(true)); } catch (e) {} drawHud(0); } }
  function rOpts(paused) { return { cam: S.save.set.cam, orbit: S.mode !== 'play', paused: !!paused, shake: !!S.save.set.shake }; }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / 60, g = S.g;
    // menus: a quiet 30 fps backdrop
    if (S.mode !== 'play' && S.last && ts - S.last < 30) { S.raf = requestAnimationFrame(frame); return; }
    S.last = ts;
    pollPad();
    if (!running()) return;
    var play = S.mode === 'play';
    var inp = play ? input() : IDLE;
    S.acc = Math.min((S.acc || 0) + dt, 0.2);
    while (S.acc >= STEP) { step(g, inp, STEP); S.acc -= STEP; }
    if (play) {
      handleEvents();
      var p = g.p, load = inp.gas && p.vf < p.st.top * 0.98 ? 1 : 0.25;
      S.snd.engineSet(p.rpm, load, p.nosOn, Math.abs(p.slip) > 0.16 && Math.abs(p.vf) > 12 ? 1 : p.burn, p.off && Math.abs(p.vf) > 8 ? 0.6 : 0, g.pursuit ? 1 : 0, g.t);
      if (g.kind === 'free' && !g.escape) { if (!g.pursuit) p.dmg = Math.max(0, p.dmg - dt * 0.004); S.saveT += dt; if (S.saveT > 6) { S.saveT = 0; saveFree(); } }
      if (S.msg) { S.msg.t -= dt; if (S.msg.t <= 0) S.msg = null; }
    } else g.ev.length = 0;
    try { S.rend.frame(g, dt, rOpts(false)); } catch (e) { console.error(e); glFail(String(e && e.message || e)); return; }
    drawHud(dt);
    if (S.doneT > 0) { S.doneT += dt; if (S.doneT > 0.4) { S.doneT = 0; finishRace(); return; } }
    S.raf = requestAnimationFrame(frame);
  }

  // ---- HUD (2D canvas over the 3D view) ----
  function rr2(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function mapCanvas(g) {
    var key = g.W.seed + ':' + (g.R ? g.R.len.toFixed(1) : 'free');
    if (S.mapKey === key && S.mapC) return S.mapC;
    var W = g.W, N = 512, sc = N / 2600, c = S.mapC || document.createElement('canvas'), x;
    c.width = N; c.height = N; x = c.getContext('2d');
    x.clearRect(0, 0, N, N);
    function mx(v) { return (v + 1300) * sc; }
    x.lineCap = 'round'; x.lineJoin = 'round';
    // river
    x.strokeStyle = 'rgba(80,150,200,0.55)'; x.lineWidth = W.river.hw * 2 * sc;
    x.beginPath(); W.river.x.forEach(function (v, i) { if (i) x.lineTo(mx(v), mx(W.river.z[i])); else x.moveTo(mx(v), mx(W.river.z[i])); }); x.stroke();
    W.paths.forEach(function (P) {
      x.strokeStyle = P.kind === 'hwy' ? 'rgba(235,225,200,0.85)' : 'rgba(215,215,215,0.7)'; x.lineWidth = Math.max(2.2, P.hw[0] * 2 * sc * 1.3);
      x.beginPath();
      for (var i = 0; i < P.n; i++) { if (i) x.lineTo(mx(P.x[i]), mx(P.z[i])); else x.moveTo(mx(P.x[i]), mx(P.z[i])); }
      if (P.closed) x.closePath();
      x.stroke();
    });
    if (g.R) {
      var P = g.R.path;
      x.strokeStyle = S.th.acc; x.lineWidth = 3.2; x.beginPath();
      for (var i = 0; i < P.n; i++) { if (i) x.lineTo(mx(P.x[i]), mx(P.z[i])); else x.moveTo(mx(P.x[i]), mx(P.z[i])); }
      if (P.closed) x.closePath();
      x.stroke();
      x.fillStyle = '#c33';
      g.R.barriers.forEach(function (b) { x.fillRect(mx(b.x) - 1.5, mx(b.z) - 1.5, 3, 3); });
    }
    S.mapC = c; S.mapKey = key; S.mapSc = sc;
    return c;
  }
  function drawHud(dt) {
    var c = S.hctx, W = S.W, H = S.H, g = S.g, k = S.hk;
    if (!c || !g) return;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.clearRect(0, 0, W, H);
    if (S.mode !== 'play') return;
    var p = g.p, F = S.th.font, small = Math.min(W, H) < 420, m = small ? 8 : 12;
    var R = clamp(Math.min(W, H) * (small ? 0.15 : 0.13), 44, 86);
    c.textBaseline = 'middle';
    // --- minimap, bottom-left
    var cx = m + R, cy = H - m - R;
    if (S.mapBig) drawBigMap(c, g, W, H);
    else {
      c.save();
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = 'rgba(12,16,22,0.62)'; c.fill();
      c.clip();
      var img = mapCanvas(g), sc = S.mapSc, zoom = R / 300, kk = zoom / sc, fxv = Math.sin(p.a), fzv = Math.cos(p.a), rx = -fzv, rz = fxv;
      var a = kk * rx, b = kk * -fxv, cc = kk * rz, d = kk * -fzv, mpx = (p.x + 1300) * sc, mpy = (p.z + 1300) * sc;
      c.setTransform(k * a, k * b, k * cc, k * d, k * (cx - (a * mpx + cc * mpy)), k * (cy - (b * mpx + d * mpy)));
      c.drawImage(img, 0, 0);
      c.setTransform(k, 0, 0, k, 0, 0);
      // cars
      var blink = (g.t * 4) % 2 < 1;
      function dot(x, z, col, r) {
        var dx = x - p.x, dz = z - p.z, sx = (dx * rx + dz * rz) * zoom, sy = -(dx * fxv + dz * fzv) * zoom, l = Math.hypot(sx, sy);
        if (l > R - 4) { sx *= (R - 4) / l; sy *= (R - 4) / l; }
        c.fillStyle = col; c.beginPath(); c.arc(cx + sx, cy + sy, r, 0, TAU); c.fill();
      }
      g.agents.forEach(function (ag) {
        if (ag.kind === 'rival') dot(ag.x, ag.z, rgb(ag.col || [200, 200, 200]), 3.2);
        else if (ag.kind === 'cop' && (g.pursuit || Math.hypot(ag.x - p.x, ag.z - p.z) < 300)) dot(ag.x, ag.z, g.pursuit ? (blink ? '#ff3b3b' : '#3b8bff') : '#8fb4ff', 3);
      });
      if (g.kind === 'free' && !g.pursuit && !g.escape) g.W.markers.forEach(function (mk) { dot(mk.x, mk.z, S.th.acc, 4.2); });
      if (g.R && !g.R.closed) { var fa = pathAt(g.path, g.R.finishS); dot(fa.x, fa.z, '#fff', 3.5); }
      c.restore();
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
      c.fillStyle = S.th.acc; c.beginPath(); c.moveTo(cx, cy - 7); c.lineTo(cx + 5, cy + 5); c.lineTo(cx, cy + 2.5); c.lineTo(cx - 5, cy + 5); c.closePath(); c.fill();
      c.restore();
      // heat flame + multiplier above the map
      if (g.copsOn || g.kind === 'free') {
        var fyy = cy - R - 16, hot = g.pursuit;
        flame(c, cx - 12, fyy, hot ? 1 : 0.4, g.t);
        c.font = '700 ' + (small ? 14 : 17) + 'px ' + F; c.textAlign = 'left';
        c.fillStyle = hot ? '#ffb347' : 'rgba(255,255,255,0.55)';
        shadowText(c, 'x' + (hot ? g.heat : 0), cx + 2, fyy + 2);
      }
    }
    // --- tachometer, bottom-right
    var tx = W - m - R, ty = H - m - R, rpm = p.rpm / 1000, a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    c.save();
    c.beginPath(); c.arc(tx, ty, R, 0, TAU); c.fillStyle = 'rgba(12,16,22,0.62)'; c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.3)'; c.lineWidth = 1.5; c.stroke();
    c.lineWidth = R * 0.07; c.strokeStyle = 'rgba(255,60,60,0.85)'; c.beginPath(); c.arc(tx, ty, R * 0.86, a0 + sweep * 7.5 / 9, a0 + sweep); c.stroke();
    c.textAlign = 'center'; c.font = '600 ' + Math.round(R * 0.15) + 'px ' + F;
    for (var i = 0; i <= 9; i++) {
      var an = a0 + sweep * i / 9, ca = Math.cos(an), sa = Math.sin(an);
      c.strokeStyle = i >= 8 ? '#ff6b6b' : '#fff'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(tx + ca * R * 0.9, ty + sa * R * 0.9); c.lineTo(tx + ca * R * 0.76, ty + sa * R * 0.76); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText(String(i), tx + ca * R * 0.62, ty + sa * R * 0.62);
      if (i < 9) { var ah = an + sweep / 18; c.lineWidth = 1; c.beginPath(); c.moveTo(tx + Math.cos(ah) * R * 0.9, ty + Math.sin(ah) * R * 0.9); c.lineTo(tx + Math.cos(ah) * R * 0.82, ty + Math.sin(ah) * R * 0.82); c.stroke(); }
    }
    var na = a0 + sweep * clamp(rpm / 9, 0, 1.02);
    c.strokeStyle = '#ff4a2a'; c.lineWidth = 3; c.beginPath(); c.moveTo(tx - Math.cos(na) * R * 0.12, ty - Math.sin(na) * R * 0.12); c.lineTo(tx + Math.cos(na) * R * 0.84, ty + Math.sin(na) * R * 0.84); c.stroke();
    c.fillStyle = '#ff4a2a'; c.beginPath(); c.arc(tx, ty, R * 0.06, 0, TAU); c.fill();
    // nitro arc in the gap at the bottom
    var nf = clamp(p.nos / p.st.nosCap, 0, 1);
    c.lineWidth = R * 0.08; c.strokeStyle = 'rgba(255,255,255,0.15)'; c.beginPath(); c.arc(tx, ty, R * 0.86, Math.PI * 0.7, Math.PI * 0.3, true); c.stroke();
    c.strokeStyle = p.nosOn ? '#9fe0ff' : '#3aa0ff'; c.beginPath(); c.arc(tx, ty, R * 0.86, Math.PI * 0.7, Math.PI * 0.7 - Math.PI * 0.4 * nf, true); c.stroke();
    // gear + digital speed
    c.fillStyle = S.th.acc; c.font = '800 ' + Math.round(R * 0.3) + 'px ' + F;
    c.fillText(p.vf < -0.5 ? 'R' : Math.abs(p.vf) < 0.3 && !p.burn ? 'N' : String(p.gear || 1), tx, ty - R * 0.3);
    c.fillStyle = '#fff'; c.font = '800 ' + Math.round(R * 0.34) + 'px ' + F;
    shadowText(c, String(spdTxt(Math.hypot(p.vx, p.vz))), tx, ty + R * 0.28);
    c.font = '600 ' + Math.round(R * 0.13) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.75)';
    c.fillText(units() === 'mph' ? 'MPH' : 'KM/H', tx, ty + R * 0.52);
    c.restore();
    // damage
    if (p.dmg > 0.05) {
      var dw = R * 1.3, dx0 = tx - dw / 2, dy0 = ty - R - 12;
      c.fillStyle = 'rgba(12,16,22,0.6)'; rr2(c, dx0, dy0, dw, 6, 3); c.fill();
      c.fillStyle = p.dmg > 0.7 ? '#ff4040' : p.dmg > 0.4 ? '#ffb020' : '#7ad36a'; rr2(c, dx0, dy0, dw * (1 - p.dmg), 6, 3); c.fill();
      c.font = '600 10px ' + F; c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText('CAR ' + Math.round((1 - p.dmg) * 100) + '%', tx, dy0 - 8);
    }
    // --- top-right: lap / position / timer / % complete (or the free-roam wallet)
    c.textAlign = 'right';
    var rx0 = W - m, ry = m + 4, big = small ? 20 : 26, med = small ? 12 : 14;
    if (g.kind === 'race') {
      var place = placeOf(g), n = racers(g), done = clamp(g.p.prog / g.total, 0, 1);
      if (g.R.closed) {
        c.font = '800 ' + big + 'px ' + F; c.fillStyle = '#fff';
        shadowText(c, Math.min(g.laps, Math.max(1, Math.floor(Math.max(0, g.p.prog) / g.R.len) + 1)) + '/' + g.laps, rx0, ry + big / 2);
        c.font = '600 ' + (med - 2) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.8)'; shadowText(c, 'LAP', rx0 - c.measureText('0/0').width * (big / (med - 2)) - 8, ry + big / 2 + 2);
        ry += big + 4;
      }
      c.font = '800 ' + big + 'px ' + F; c.fillStyle = place === 1 ? S.th.acc : '#fff';
      shadowText(c, place + '/' + n, rx0, ry + big / 2);
      c.font = '600 ' + (med - 2) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.8)'; shadowText(c, 'POS', rx0 - (big * 0.62) * String(place + '/' + n).length - 6, ry + big / 2 + 2);
      ry += big + 6;
      c.font = '700 ' + med + 'px ' + F; c.fillStyle = '#fff';
      shadowText(c, fmtTime(g.phase === 'count' ? 0 : Math.max(0, (g.p.fin || g.t) - 3.2)), rx0, ry + med / 2);
      ry += med + 6;
      var bw = small ? 86 : 110;
      c.fillStyle = 'rgba(12,16,22,0.6)'; rr2(c, rx0 - bw, ry, bw, 5, 2.5); c.fill();
      c.fillStyle = S.th.acc; rr2(c, rx0 - bw, ry, Math.max(5, bw * done), 5, 2.5); c.fill();
      c.font = '600 ' + (med - 3) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.85)'; shadowText(c, Math.round(done * 100) + '% COMPLETE', rx0, ry + 14);
    } else {
      c.font = '800 ' + (big - 4) + 'px ' + F; c.fillStyle = '#fff';
      shadowText(c, money(S.save.cash + (g.escape ? 0 : 0)), rx0, ry + big / 2);
      ry += big + 2;
      c.font = '600 ' + (med - 2) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.85)';
      var dn = DISTRICTS[district(g.W, p.x, p.z)].name;
      shadowText(c, g.pursuit ? 'BOUNTY ' + money(g.bounty) : dn.toUpperCase(), rx0, ry + 6);
    }
    // --- top-center: pursuit / evade bar
    if (g.pursuit) {
      var pw = Math.min(W * (small ? 0.44 : 0.36), 300), px0 = (W - pw) / 2, py0 = m + 6, ph = 9;
      c.fillStyle = 'rgba(12,16,22,0.65)'; rr2(c, px0 - 6, py0 - 4, pw + 12, ph + 26, 6); c.fill();
      var ev = clamp(g.evadeT / (g.evadeNeed || 8), 0, 1), bu = clamp(g.bustT / 3, 0, 1);
      c.fillStyle = 'rgba(255,255,255,0.12)'; rr2(c, px0, py0 + 14, pw, ph, 4); c.fill();
      if (bu > 0) { c.fillStyle = '#ff3b3b'; rr2(c, px0, py0 + 14, Math.max(8, pw / 2 * bu), ph, 4); c.fill(); }
      if (ev > 0) { c.fillStyle = '#3bb8ff'; rr2(c, px0 + pw - Math.max(8, pw / 2 * ev), py0 + 14, Math.max(8, pw / 2 * ev), ph, 4); c.fill(); }
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(px0 + pw / 2 - 0.5, py0 + 12, 1, ph + 4);
      c.font = '700 ' + (small ? 10 : 11) + 'px ' + F; c.textAlign = 'left'; c.fillStyle = bu > 0 ? '#ff6b6b' : 'rgba(255,255,255,0.8)';
      c.fillText(bu > 0 ? 'BUSTED' : 'PURSUIT', px0, py0 + 4);
      c.textAlign = 'right'; c.fillStyle = ev > 0 ? '#7fd4ff' : 'rgba(255,255,255,0.8)'; c.fillText(ev > 0 ? 'EVADE' : 'COPS ' + g.cops, px0 + pw, py0 + 4);
      c.textAlign = 'center'; c.fillStyle = '#ffb347'; c.fillText(pips(g.heat, 5).replace(/■/g, '▲').replace(/□/g, '△'), px0 + pw / 2, py0 + 4);
    }
    // --- center messages
    if (g.phase === 'count' && g.countT > 0) {
      var n2 = Math.ceil(g.countT), fr = g.countT - Math.floor(g.countT);
      if (n2 <= 3) { c.textAlign = 'center'; c.font = '900 ' + Math.round(Math.min(W, H) * 0.22 * (0.8 + fr * 0.3)) + 'px ' + F; c.fillStyle = S.th.acc; c.globalAlpha = 0.4 + fr * 0.6; shadowText(c, String(n2), W / 2, H * 0.38); c.globalAlpha = 1; }
    }
    if (S.msg) {
      var mt = S.msg, al = clamp(mt.t / 0.3, 0, 1) * clamp((mt.t0 - mt.t) / 0.15 + 0.3, 0, 1);
      c.globalAlpha = al; c.textAlign = 'center';
      c.font = '900 ' + (small ? 24 : 34) + 'px ' + F; c.fillStyle = mt.col || '#fff';
      shadowText(c, mt.txt, W / 2, H * (g.pursuit ? 0.3 : 0.26));
      if (mt.sub) { c.font = '600 ' + (small ? 12 : 14) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.9)'; shadowText(c, mt.sub, W / 2, H * (g.pursuit ? 0.3 : 0.26) + (small ? 22 : 30)); }
      c.globalAlpha = 1;
    }
    if (S.firstDrive && g.phase === 'race' && g.t < 9 && Math.abs(p.vf) < 0.5) {
      c.textAlign = 'center'; c.font = '600 ' + (small ? 11 : 13) + 'px ' + F; c.fillStyle = 'rgba(255,255,255,0.9)';
      shadowText(c, S.coarse ? 'Hold GAS to drive' : 'Hold ↑ / W to drive', W / 2, H * 0.4);
    }
  }
  function shadowText(c, t, x, y) { var f = c.fillStyle; c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillText(t, x + 1, y + 1.5); c.fillStyle = f; c.fillText(t, x, y); }
  function flame(c, x, y, k, t) {
    var s = 11, fl = 1 + Math.sin(t * 13) * 0.08 * k;
    c.save(); c.translate(x, y); c.scale(1, fl);
    var gr = c.createLinearGradient(0, s, 0, -s * 1.3);
    gr.addColorStop(0, k > 0.5 ? '#ff3b1f' : 'rgba(255,255,255,0.25)'); gr.addColorStop(0.6, k > 0.5 ? '#ff9a2a' : 'rgba(255,255,255,0.35)'); gr.addColorStop(1, k > 0.5 ? '#ffe27a' : 'rgba(255,255,255,0.45)');
    c.fillStyle = gr; c.beginPath();
    c.moveTo(0, s); c.bezierCurveTo(-s, s * 0.8, -s * 0.9, -s * 0.2, -s * 0.2, -s * 1.3); c.bezierCurveTo(-s * 0.1, -s * 0.5, s * 0.4, -s * 0.6, s * 0.35, -s * 1.0);
    c.bezierCurveTo(s * 1.0, -s * 0.3, s * 0.9, s * 0.8, 0, s); c.fill();
    c.restore();
  }
  function drawBigMap(c, g, W, H) {
    var img = mapCanvas(g), sz = Math.min(W, H) * 0.9, x0 = (W - sz) / 2, y0 = (H - sz) / 2, kk = sz / img.width, p = g.p, sc = S.mapSc;
    c.save();
    c.fillStyle = 'rgba(10,14,20,0.78)'; rr2(c, x0 - 6, y0 - 6, sz + 12, sz + 12, 10); c.fill();
    c.drawImage(img, x0, y0, sz, sz);
    function at(x, z) { return [x0 + (x + 1300) * sc * kk, y0 + (z + 1300) * sc * kk]; }
    g.agents.forEach(function (ag) { if (ag.kind === 'rival' || (ag.kind === 'cop' && g.pursuit)) { var q = at(ag.x, ag.z); c.fillStyle = ag.kind === 'cop' ? '#ff3b3b' : rgb(ag.col || [200, 200, 200]); c.beginPath(); c.arc(q[0], q[1], 3.5, 0, TAU); c.fill(); } });
    if (g.kind === 'free' && !g.escape) g.W.markers.forEach(function (mk) { var q = at(mk.x, mk.z); c.fillStyle = S.th.acc; c.beginPath(); c.arc(q[0], q[1], 5, 0, TAU); c.fill(); });
    var q = at(p.x, p.z);
    c.translate(q[0], q[1]); c.rotate(-p.a + Math.PI);
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(0, -8); c.lineTo(6, 6); c.lineTo(0, 3); c.lineTo(-6, 6); c.closePath(); c.fill();
    c.restore();
    c.font = '600 11px ' + S.th.font; c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText(g.W.name.toUpperCase() + ' · M closes', W / 2, y0 + sz - 10);
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
    S.panel.classList.toggle('rl-side', side);
    S.pad.classList.toggle('on', padOn);
    S.pad.classList.toggle('nosteer', S.save.set.touch === 'tilt');
    S.pad.classList.toggle('auto', autoGas());
    var gut = side ? (solo ? 24 : 40) : phone ? (solo ? 20 : 34) : 48, padW = side ? 2 * 132 : 0;
    var W = Math.floor(Math.min(vw - gut - padW, solo ? 1180 : 900)), ch = chromeH(), ah = Math.floor(Math.max(side ? 150 : 200, availH(vw, vh, ch))), H;
    if (side) { H = ah; W = Math.min(W, Math.round(H * 2.2)); }
    else if (W < 560) H = Math.min(ah, Math.round(W * 1.2));
    else H = Math.min(ah, Math.round(W * 0.5625));
    H = Math.max(H, Math.min(ah, 220));
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (W !== S.W || H !== S.H || dpr !== S.dpr) {
      S.W = W; S.H = H; S.dpr = dpr;
      S.stage.style.width = W + 'px'; S.stage.style.height = H + 'px';
      S.panel.style.setProperty('--rl-w', W + 'px');
      S.hk = dpr; S.hud.width = Math.round(W * dpr); S.hud.height = Math.round(H * dpr);
      if (S.rend) S.rend.setSize(W, H, dpr);
    }
    S.lay = { vw: vw, vh: vh, chrome: ch, side: side };
    if (!S.raf) renderOnce();
  }
  function relayoutIfMoved() {
    if (!S || !S.lay || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var ch = chromeH();
    if (ch && Math.abs(ch - S.lay.chrome) > 1) layout();
  }
  function syncHead() {
    if (!S) return;
    var hb = S.head, pb = hb.querySelector('[data-h="pause"]'), sb = hb.querySelector('[data-h="sound"]'), cb = hb.querySelector('[data-h="cam"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE; pb.disabled = S.mode !== 'play';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)'; pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF; sb.title = S.snd.on ? 'Sound on' : 'Sound off'; sb.setAttribute('aria-label', sb.title); sb.classList.toggle('on', S.snd.on);
    cb.innerHTML = IC_CAM; cb.title = 'Camera: ' + S.save.set.cam + ' (C)'; cb.setAttribute('aria-label', cb.title);
  }

  // ---- WebGL: create, fail, rebuild ----
  function initRend() {
    if (!S) return;
    if (!webglOK()) { glFail('WebGL unavailable'); return; }
    loadThree().then(function (T) {
      if (!S) return;
      S.T = T;
      try { S.rend = new Rend(T, S.gl, gfxName()); } catch (e) { glFail(String(e && e.message || e)); return; }
      S.gl.addEventListener('webglcontextlost', S.onLost = function (ev) { ev.preventDefault(); if (S && !S.closing) glFail('the 3D context was lost'); });
      S.rend.setSize(S.W || 360, S.H || 300, S.dpr || 1);
      var back = S.card && S.card !== 'loading' ? S.card : 'menu';
      if (S.firstRun && back === 'menu') back = 'help';
      S.backCard = back;
      startEvent({ kind: 'attract' });
    }, function (e) { glFail('could not load the 3D engine' + (e && e.message ? ': ' + e.message : '')); });
  }
  function glFail(msg) {
    if (!S) return;
    stopLoop();
    S.glErr = msg; S.mode = 'nogl';
    if (S.rend) { S.gl.removeEventListener('webglcontextlost', S.onLost); try { S.rend.dispose(); } catch (e) {} S.rend = null; }
    S.snd.engineOff();
    showCard('nogl'); layout();
  }
  function rebuildRend() {
    if (!S || !S.rend) return;
    stopLoop();
    S.closing = true;
    S.gl.removeEventListener('webglcontextlost', S.onLost);
    try { S.rend.dispose(); } catch (e) {}
    S.rend = null;
    var nc = document.createElement('canvas'); nc.className = S.gl.className;
    S.gl.parentNode.replaceChild(nc, S.gl); S.gl = nc; bindGl();
    S.closing = false;
    try { S.rend = new Rend(S.T, S.gl, gfxName()); } catch (e) { glFail(String(e && e.message || e)); return; }
    S.gl.addEventListener('webglcontextlost', S.onLost);
    S.rend.setSize(S.W, S.H, S.dpr);
    if (S.g) { try { S.rend.setGame(S.g, { car: S.carId || S.save.car, col: S.ev && S.ev.kind === 'daily' ? CAR_BY[S.carId].col : carColor(S.save, S.carId || S.save.car) }); } catch (e2) { glFail(String(e2)); return; } }
    kick(); renderOnce();
  }
  function bindGl() {
    S.gl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    ['touchstart', 'touchmove', 'touchend'].forEach(function (t) { S.gl.addEventListener(t, noTouch, { passive: false }); });
    S.gl.addEventListener('pointerdown', function (e) { if (!S) return; e.preventDefault(); S.snd.ensure(); });
  }
  function noTouch(e) { if (e.cancelable) e.preventDefault(); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    s.closing = true;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.loadT);
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
    try {
      if (s.g && s.g.kind === 'free' && !s.g.attract && !s.g.escape) s.save.free = { seed: s.g.W.seed, x: s.g.p.x, z: s.g.p.z, a: s.g.p.a, dmg: s.g.p.dmg };
      sset(SAVE_KEY, JSON.stringify(s.save));
    } catch (e) {}
    s.snd.close();
    if (s.rend) { try { s.rend.dispose(); } catch (e) {} s.rend = null; }
    s.g = null; worldCache.W = null; worldCache.seed = -1;
    if (s.mapC) { s.mapC.width = 0; s.mapC.height = 0; }
    s.hud.width = 0; s.hud.height = 0;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }
  function act(a, b) {
    var sv = S.save;
    switch (a) {
      case 'career': S.ctier = null; showCard('career'); break;
      case 'quick': showCard('quick'); break;
      case 'go-quick': startEvent({ kind: 'quick' }); break;
      case 'free': startEvent({ kind: 'free' }); break;
      case 'daily': startEvent({ kind: 'daily' }); break;
      case 'menu': S.tab = 'race'; if (S.mode === 'menu') showCard('menu'); else toMenu(); break;
      case 'garage': S.tab = 'garage'; if (S.mode === 'menu') showCard('menu'); else toMenu('menu'); break;
      case 'to-career': S.ctier = null; toMenu('career'); break;
      case 'help': showCard('help'); break;
      case 'close-help': closeHelp(); break;
      case 'resume': resume(); break;
      case 'restart': case 'retry': startEvent(S.ev.kind === 'freeRace' ? S.ev : S.ev.kind === 'career' ? { kind: 'career', tier: S.ev.tier, i: S.ev.i } : { kind: S.ev.kind }); break;
      case 'quit': quitPlay(); break;
      case 'reset-car': S.paused = false; showCard(null); resetCar(S.g); S.snd.ensure(); S.snd.engineOn(); kick(); break;
      case 'free-back': backToFree(); break;
      case 'marker-go': startEvent({ kind: 'freeRace', W: S.g.W, m: S.mk, tod: S.g.tod, rain: S.g.rain }); break;
      case 'marker-no': S.paused = false; showCard(null); S.snd.ensure(); S.snd.engineOn(); kick(); break;
      case 'tilt': enableTilt(); break;
      case 'reset': S.resetArm = true; showCard('menu'); break;
      case 'reset-no': S.resetArm = false; showCard('menu'); break;
      case 'reset-yes': { var keep = sv.set; S.save = newSave(); S.save.set = keep; S.resetArm = false; persist(); if (Cade.showToast) Cade.showToast('Progress reset', 'info', 1600); showCard('menu'); break; }
      case 'open-apex': closePanel(); try { Cade.runCommand('Apex Rush'); } catch (e) {} break;
      case 'open-heat': closePanel(); try { Cade.runCommand('Street Heat'); } catch (e) {} break;
      case 'close': closePanel(); break;
    }
    void b;
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="rl"><div class="rl-stage"><canvas class="rl-gl"></canvas><canvas class="rl-hud"></canvas><div class="rl-ovl" style="display:none"></div></div>' +
      '<div class="rl-pad"><div class="rl-pl"><button type="button" data-hold="l" aria-label="Steer left">◀</button><button type="button" data-hold="r" aria-label="Steer right">▶</button></div>' +
      '<div class="rl-pr"><button type="button" data-hold="n" class="nos" aria-label="Nitro">NOS</button><button type="button" data-hold="h" class="hb" aria-label="Handbrake drift">DRIFT</button>' +
      '<button type="button" data-hold="b" class="brk" aria-label="Brake">BRK</button><button type="button" data-hold="g" class="gas" aria-label="Gas">GAS</button></div></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\u{1F3C1} Redline Run', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'rl-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to drive" aria-label="How to drive">' + IC_HELP + '</button>' +
      '<button type="button" data-h="cam"></button><button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.rl-stage'), gl: p.querySelector('.rl-gl'), hud: p.querySelector('.rl-hud'), ovl: p.querySelector('.rl-ovl'), pad: p.querySelector('.rl-pad'),
      save: ld.save, firstRun: ld.fresh, firstDrive: ld.fresh, snd: new Snd(sget(SOUND_KEY) !== '0'),
      coarse: !!(mm && mm('(pointer: coarse)').matches), mode: 'loading', card: null, tab: 'race', g: null, rend: null, T: null, paused: false, raf: 0, last: 0, acc: 0,
      keys: {}, hold: { l: 0, r: 0, g: 0, b: 0, n: 0, h: 0 }, gp: {}, gpIn: null, tiltOn: false, tiltV: 0, tiltL: null, tiltMsg: '',
      W: 0, H: 0, dpr: 1, hk: 1, msg: null, doneT: 0, res: null, resetArm: false, touchUsed: false, mapBig: false, mapC: null, mapKey: '', ev: null, ctier: null, saveT: 0
    };
    S.hctx = S.hud.getContext('2d');
    p._onClose = teardown;
    readTheme();
    S.onKey = onKey; S.onKeyUp = onKeyUp;
    document.addEventListener('keydown', S.onKey, true);
    document.addEventListener('keyup', S.onKeyUp, true);
    S.onVis = function () { if (!S) return; if (document.hidden) { pause(); stopLoop(); S.snd.engineOff(); } else kick(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); clearHeld(); S.keys = {}; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pause(); clearHeld(); stopLoop(); S.snd.engineOff(); });
    p.addEventListener('cade-panel-restore', function () { if (!S || S.panel !== p) return; requestAnimationFrame(function () { if (!S || S.panel !== p) return; readTheme(); layout(); kick(); }); });
    S.onResize = function () { if (!S) return; clearTimeout(S.resizeT); S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) layout(); }, 120); };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    window.addEventListener('orientationchange', S.onResize);
    try { S.ro = new ResizeObserver(function () { if (S && S.panel === p) requestAnimationFrame(relayoutIfMoved); }); S.ro.observe(S.pad); } catch (e) {}
    S.onPadC = function () { if (S && !S.gpT) S.gpT = setInterval(function () { if (S && !S.raf) pollPad(); }, 100); };
    window.addEventListener('gamepadconnected', S.onPadC);
    if (readPad()) S.onPadC();
    try {
      S.themeObs = new MutationObserver(function () { if (!S) return; readTheme(); S.mapKey = ''; if (S.card) showCard(S.card); if (!S.raf) renderOnce(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on; sset(SOUND_KEY, S.snd.on ? '1' : '0');
        if (S.snd.on) { S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04); if (S.mode === 'play' && !S.paused) S.snd.engineOn(); } else S.snd.engineOff();
        syncHead();
      } else if (h === 'pause') { if (S.paused && S.card === 'pause') resume(); else pause(); }
      else if (h === 'cam') cycleCam();
      else if (h === 'help') {
        if (S.mode === 'play' && !S.paused) pause();
        if (S.card === 'help') closeHelp();
        else if (S.mode === 'menu' || S.paused) showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });
    bindGl();
    ['touchstart', 'touchmove', 'touchend'].forEach(function (t) { S.hud.addEventListener(t, noTouch, { passive: false }); S.pad.addEventListener(t, noTouch, { passive: false }); });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.hud.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.hud.addEventListener('pointerdown', function (e) { if (!S) return; e.preventDefault(); S.snd.ensure(); if (e.pointerType === 'touch') S.touchUsed = true; });
    // the pad: every button is held; several at once
    S.pad.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      e.preventDefault();
      S.snd.ensure(); S.touchUsed = true; S.firstDrive = false;
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      S.hold[b.getAttribute('data-hold')] = 1; b.classList.add('on');
    });
    function padUp(e) {
      var b = e.target.closest ? e.target.closest('[data-hold]') : null;
      if (!b || !S) return;
      S.hold[b.getAttribute('data-hold')] = 0; b.classList.remove('on');
    }
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { S.pad.addEventListener(t, padUp); });

    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var sv = S.save, a = b.getAttribute('data-act'), tab = b.getAttribute('data-tab'), df = b.getAttribute('data-diff'), st = b.getAttribute('data-set'), q = b.getAttribute('data-q'),
        buy = b.getAttribute('data-buy'), paint = b.getAttribute('data-paint'), car = b.getAttribute('data-car'), tier = b.getAttribute('data-tier'), evi = b.getAttribute('data-ev');
      S.snd.tone(988, 0.04, 'sine', 0.025);
      if (tab) { S.tab = tab; S.resetArm = false; showCard('menu'); refocus(e, '[data-tab="' + tab + '"]'); return; }
      if (df != null) { sv.set.diff = +df; persist(); showCard('menu'); refocus(e, '[data-diff="' + df + '"]'); return; }
      if (q) { var kq = q.split(':'); sv.set[kq[0]] = kq[0] === 'qtype' ? kq[1] : +kq[1]; persist(); showCard('quick'); refocus(e, '[data-q="' + q + '"]'); return; }
      if (st) {
        var kv = st.split(':'), key = kv[0], val = kv[1];
        if (key === 'sens') val = +val; else if (key === 'autogas') val = val === 'on'; else if (key === 'shake') val = +val;
        var old = sv.set[key];
        sv.set[key] = val; persist(); syncHead();
        if (key === 'units') S.mapKey = '';
        if (key === 'cam' && S.rend) S.rend.camInit = false;
        if (key === 'gfx' && gfxName() !== (S.rend && S.rend.qname)) rebuildRend();
        if ((key === 'time' || key === 'weather') && S.g && S.g.attract && old !== val) { S.backCard = 'menu'; startEvent({ kind: 'attract' }); }
        if (key === 'touch' && val === 'tilt' && !S.tiltOn && !window.DeviceOrientationEvent) S.tiltMsg = 'No tilt sensor here.';
        showCard(S.card === 'pause' ? 'pause' : 'menu'); refocus(e, '[data-set="' + st + '"]');
        if (!S.raf) renderOnce();
        return;
      }
      if (buy) { if (buyUpgrade(sv, buy)) { persist(); S.snd.tone(660, 0.08, 'triangle', 0.05); S.snd.tone(990, 0.12, 'triangle', 0.05, null, 0.08); } showCard('menu'); refocus(e, '[data-buy="' + buy + '"]'); return; }
      if (car) { if (buyCar(sv, car)) { persist(); S.snd.tone(784, 0.1, 'triangle', 0.05); refreshCar(); } showCard('menu'); refocus(e, '[data-car="' + car + '"]'); return; }
      if (paint != null) { if (buyPaint(sv, +paint)) { persist(); refreshCar(); } showCard('menu'); refocus(e, '[data-paint="' + paint + '"]'); return; }
      if (tier != null) { S.ctier = +tier; showCard('career'); refocus(e, '[data-tier="' + tier + '"]'); return; }
      if (evi != null) { var ct = S.ctier == null ? Math.min(sv.career.tier, RIVALS.length - 1) : S.ctier; startEvent({ kind: 'career', tier: ct, i: +evi }); return; }
      act(a, b);
    });
    function refocus(e, sel) {
      if (e.detail !== 0) return;
      var el = S.ovl.querySelector(sel);
      if (el) { try { el.focus({ preventScroll: true }); } catch (er) {} }
    }
    function refreshCar() {
      // the attract car follows the garage
      if (S.rend && S.g && S.g.attract) { S.carId = S.save.car; S.g.p.st = carStats(S.save.car, S.save.upg[S.save.car]); S.rend.makePlayerCar(S.save.car, carColor(S.save, S.save.car)); renderOnce(); }
    }

    S.loadMsg = 'Loading the 3D engine…';
    showCard('loading');
    syncHead();
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); layout(); initRend(); } });
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Third-person 3D street racer — chase cam through an open city, rival races, police heat and a tuner career',
    icon: '\u{1F3C1}',
    tags: 'game,arcade,racing,driving,car,3d,police,chase,career,open world,fun',
    open: open,
    _engine: ENGINE
  });
})();
