/* Bridge Builder — span the gap with a truss, then send the traffic over, for Cade.txt.
 * Place joints and members on a snap grid between the anchors: road (the deck
 * the wheels ride on), wood, steel and cable, each with its own cost, weight,
 * stiffness, strength and longest length. Stay under the level's budget, press
 * Test and watch a cart, a car, a van, trucks or a bus roll across: every
 * member shows its stress in colour and breaks when it is overloaded. Cheaper
 * bridges earn more stars. 18 levels with wider gaps, piers, towers, uneven
 * banks and heavier traffic. Undo / redo, a mirror tool, a fine grid, designs
 * saved per level.
 * The simulation is extended position-based dynamics (XPBD): every joint is a
 * particle, every member a compliant distance constraint, solved in 12
 * substeps per 1/120 s step, so stiff trusses hold still and the forces come
 * straight from the constraint multipliers. The traffic rides on the road
 * members, adding its mass to their joints. Rendering interpolates between
 * steps; the loop runs only while a test is on screen and pauses on blur, tab
 * hide and minimize. Saves in Cade.store (cade-bridge-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  // World units: metres, kilograms, newtons, seconds. x → right, y → up; the
  // left bank's road sits at y = 0 and the gap runs from x = 0 to x = span.
  // Grid coordinates are integer HALF metres (hx, hy), so the fine grid (0.5 m)
  // and the coarse one (1 m) share one representation and compare exactly.
  var STEP = 1 / 120, SUB = 12, G = 9.8;
  var DAMP = 2.2;                 // velocity damping (1/s)
  var GRAV_RAMP = 0.6;            // seconds to ramp gravity in (no shock at the start)
  var SMOOTH = 0.25;              // force reading low-pass, per step
  var T_LIMIT = 45, STALL_T = 2.5;
  var JOINT_COST = 50, JOINT_MASS = 4;

  // Materials. cost per metre ($), mass per metre (kg), EA (N), strength in
  // tension / compression (N); compression strength falls off past `buck` metres.
  var MATS = [
    { id: 'road', name: 'Road', key: '1', cost: 200, mass: 60, EA: 1.0e7, T: 26000, C: 26000, buck: 2.5, max: 2.3, road: true },
    { id: 'wood', name: 'Wood', key: '2', cost: 110, mass: 14, EA: 4.0e6, T: 15000, C: 13000, buck: 2.2, max: 3.0 },
    { id: 'steel', name: 'Steel', key: '3', cost: 260, mass: 30, EA: 1.4e7, T: 44000, C: 40000, buck: 3.0, max: 4.5 },
    { id: 'cable', name: 'Cable', key: '4', cost: 90, mass: 5, EA: 6.0e6, T: 36000, C: 0, buck: 99, max: 14, cable: true }
  ];
  var MAT = {};
  for (var mi0 = 0; mi0 < MATS.length; mi0++) { MATS[mi0].i = mi0; MAT[MATS[mi0].id] = mi0; }

  // Traffic. axles: offsets from the rear axle (m); mass shared evenly between them.
  var VEHICLES = {
    cart: { name: 'cart', mass: 350, axles: [0, 1.2], speed: 3.0, len: 2.0 },
    car: { name: 'car', mass: 950, axles: [0, 1.8], speed: 3.4, len: 2.8 },
    van: { name: 'van', mass: 1600, axles: [0, 2.2], speed: 3.0, len: 3.2 },
    truck: { name: 'truck', mass: 3000, axles: [0, 2.4, 3.4], speed: 2.6, len: 4.4 },
    bus: { name: 'bus', mass: 4200, axles: [0, 3.8], speed: 2.4, len: 5.2 }
  };

  // Levels (metres). S: span of the gap; R: right bank height; yMin / yMax: the
  // buildable band (water lies below yMin); xPad: buildable overhang onto the
  // banks; a: extra anchors besides (0, 0) and (S, R); v: the traffic, each
  // with a gap `d` (m) behind the one before; p2 / p3: the cost for 2 / 3 stars.
  var LEVELS = [
    { id: 'l01', name: 'First Crossing', S: 4, yMin: -3, yMax: 3, a: [], v: [{ t: 'cart' }], budget: 2600, p2: 2000, p3: 1600,
      tip: 'A road alone sags and snaps. Hang a triangle above or below it.' },
    { id: 'l02', name: 'The Creek', S: 6, yMin: -3, yMax: 3, a: [[0, -2], [6, -2]], v: [{ t: 'cart' }], budget: 3200, p2: 2500, p3: 2000,
      tip: 'The cliff anchors under the deck can hold struts that push the road up.' },
    { id: 'l03', name: 'Commuter', S: 8, yMin: -3, yMax: 3, a: [[0, -2], [8, -2]], v: [{ t: 'car' }], budget: 7400, p2: 5800, p3: 4600,
      tip: 'Triangles do not change shape. Squares fold.' },
    { id: 'l04', name: 'Low Water', S: 8, yMin: -1, yMax: 4, a: [], v: [{ t: 'car' }], budget: 7400, p2: 5800, p3: 4600,
      tip: 'No room below the road: build the truss over it.' },
    { id: 'l05', name: 'The Pier', S: 12, yMin: -4, yMax: 3, a: [[6, -4]], v: [{ t: 'car' }], budget: 11400, p2: 8900, p3: 7100,
      tip: 'Rest the middle of the span on the pier.' },
    { id: 'l06', name: 'Delivery', S: 10, yMin: -3, yMax: 3, a: [[0, -2], [10, -2]], v: [{ t: 'van' }], budget: 9600, p2: 7500, p3: 6000,
      tip: 'A deeper truss means smaller forces in every member.' },
    { id: 'l07', name: 'Hanging On', S: 10, yMin: -1, yMax: 6, a: [[-1, 6], [11, 6]], v: [{ t: 'car' }], budget: 7800, p2: 6100, p3: 4900,
      tip: 'Cables only pull, but they are light, cheap and long. Hang the road from the towers.' },
    { id: 'l08', name: 'Uphill', S: 10, R: 2, yMin: -3, yMax: 4, a: [[0, -2], [10, 0]], v: [{ t: 'van' }], budget: 15200, p2: 11900, p3: 9500,
      tip: 'The far bank is higher: ramp the road up gently.' },
    { id: 'l09', name: 'Long Haul', S: 12, yMin: -1, yMax: 4, a: [], v: [{ t: 'van' }], budget: 19200, p2: 15000, p3: 12000,
      tip: 'Steel is dear but strong. Use it only where the stress glows red.' },
    { id: 'l10', name: 'Heavy Goods', S: 10, yMin: -3, yMax: 4, a: [[0, -2], [10, -2]], v: [{ t: 'truck' }], budget: 15400, p2: 12000, p3: 9600,
      tip: 'Trucks are three times a car. Watch the stress colours on a test run.' },
    { id: 'l11', name: 'Twin Piers', S: 16, yMin: -4, yMax: 3, a: [[5, -4], [11, -4]], v: [{ t: 'van' }], budget: 19700, p2: 15400, p3: 12300,
      tip: 'Three short spans are cheaper than one long one.' },
    { id: 'l12', name: 'Suspension', S: 16, yMin: -1, yMax: 7, a: [[-1, 7], [17, 7]], v: [{ t: 'car' }], budget: 14900, p2: 11600, p3: 9300,
      tip: 'Fan the cables out from the tower tops.' },
    { id: 'l13', name: 'Convoy', S: 12, yMin: -4, yMax: 3, a: [[0, -3], [12, -3]], v: [{ t: 'van' }, { t: 'van', d: 2 }], budget: 18100, p2: 14100, p3: 11300,
      tip: 'Two vans at once: the whole bridge is loaded together.' },
    { id: 'l14', name: 'Steep Banks', S: 12, R: 3, yMin: -3, yMax: 6, a: [[0, -2], [12, 1]], v: [{ t: 'truck' }], budget: 18700, p2: 14600, p3: 11700,
      tip: 'Climb no steeper than one in three or the truck stalls.' },
    { id: 'l15', name: 'Canyon', S: 16, yMin: -6, yMax: 3, a: [[0, -4], [16, -4]], v: [{ t: 'truck' }], budget: 31000, p2: 24300, p3: 19400,
      tip: 'An arch under the road turns the load into compression.' },
    { id: 'l16', name: 'Bus Route', S: 14, yMin: -4, yMax: 5, a: [[7, -4]], v: [{ t: 'bus' }], budget: 22200, p2: 17400, p3: 13900,
      tip: 'Long and heavy: a bus puts all its weight on two axles.' },
    { id: 'l17', name: 'Cable Stay', S: 18, yMin: -1, yMax: 8, a: [[-1, 8], [19, 8]], v: [{ t: 'truck' }], budget: 18200, p2: 14300, p3: 11400,
      tip: 'Steel stiffens the deck between the cables.' },
    { id: 'l18', name: 'Grand Finale', S: 18, yMin: -5, yMax: 6, a: [[0, -4], [18, -4], [9, -5]], v: [{ t: 'truck' }, { t: 'car', d: 3 }], budget: 32200, p2: 25100, p3: 20100,
      tip: 'Everything you have learned, all at once.' }
  ];
  for (var li0 = 0; li0 < LEVELS.length; li0++) prepLevel(LEVELS[li0], li0);
  function prepLevel(L, i) {
    L.i = i; L.R = L.R || 0; L.xPad = L.xPad == null ? 1 : L.xPad;
    L.anchors = [[0, 0], [L.S, L.R]].concat(L.a || []).map(function (p) { return { hx: Math.round(p[0] * 2), hy: Math.round(p[1] * 2) }; });
    L.waterY = L.yMin - 1;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- the design: joints (anchors first) and members ----
  function newDesign(L) {
    return { joints: L.anchors.map(function (a) { return { hx: a.hx, hy: a.hy, anchor: true }; }), members: [] };
  }
  function cloneDesign(d) {
    return { joints: d.joints.map(function (j) { return { hx: j.hx, hy: j.hy, anchor: !!j.anchor }; }), members: d.members.map(function (m) { return { a: m.a, b: m.b, m: m.m }; }) };
  }
  // The terrain: solid ground under each bank.
  function solid(L, x, y) { return (x < 0 && y < 0) || (x > L.S && y < L.R); }
  // May a new joint go at half-grid point (hx, hy)?
  function validPt(L, hx, hy) {
    var x = hx / 2, y = hy / 2;
    if (x < -L.xPad || x > L.S + L.xPad || y < L.yMin || y > L.yMax) return false;
    if (solid(L, x, y)) return false;
    // on a bank's surface only above the road level (nothing to stand on otherwise)
    return true;
  }
  function jointAt(d, hx, hy) {
    for (var i = 0; i < d.joints.length; i++) if (d.joints[i].hx === hx && d.joints[i].hy === hy) return i;
    return -1;
  }
  function memberBetween(d, a, b) {
    for (var i = 0; i < d.members.length; i++) {
      var m = d.members[i];
      if ((m.a === a && m.b === b) || (m.a === b && m.b === a)) return i;
    }
    return -1;
  }
  function hlen(ahx, ahy, bhx, bhy) { var dx = (bhx - ahx) / 2, dy = (bhy - ahy) / 2; return Math.sqrt(dx * dx + dy * dy); }
  function memLen(d, m) { var a = d.joints[m.a], b = d.joints[m.b]; return hlen(a.hx, a.hy, b.hx, b.hy); }
  // Can a member of material mi join these two points?  '' when it can, else why not.
  function canPlace(L, d, p, q, mi) {
    var M = MATS[mi];
    if (!M) return 'material';
    if (p.hx === q.hx && p.hy === q.hy) return 'same';
    if (jointAt(d, p.hx, p.hy) < 0 && !validPt(L, p.hx, p.hy)) return 'ground';
    if (jointAt(d, q.hx, q.hy) < 0 && !validPt(L, q.hx, q.hy)) return 'ground';
    if (hlen(p.hx, p.hy, q.hx, q.hy) > M.max + 1e-9) return 'long';
    // a member may not run through solid ground
    for (var k = 1; k < 8; k++) {
      var t = k / 8;
      if (solid(L, (p.hx + (q.hx - p.hx) * t) / 2, (p.hy + (q.hy - p.hy) * t) / 2)) return 'ground';
    }
    return '';
  }
  function ensureJoint(d, hx, hy) {
    var i = jointAt(d, hx, hy);
    if (i >= 0) return i;
    d.joints.push({ hx: hx, hy: hy, anchor: false });
    return d.joints.length - 1;
  }
  // Add (or re-material) a member between two half-grid points. Returns true on a change.
  function addMember(L, d, p, q, mi) {
    if (canPlace(L, d, p, q, mi)) return false;
    var a = ensureJoint(d, p.hx, p.hy), b = ensureJoint(d, q.hx, q.hy), e = memberBetween(d, a, b);
    if (e >= 0) {
      if (d.members[e].m === mi) return false;
      d.members[e].m = mi;
      return true;
    }
    d.members.push({ a: a, b: b, m: mi });
    return true;
  }
  // Drop non-anchor joints no member uses, renumbering the members.
  function prune(d) {
    var used = d.joints.map(function (j) { return !!j.anchor; }), map = [], out = [], i;
    d.members.forEach(function (m) { used[m.a] = used[m.b] = true; });
    for (i = 0; i < d.joints.length; i++) { if (d.joints[i].gone) used[i] = false; map.push(used[i] ? out.length : -1); if (used[i]) out.push(d.joints[i]); }
    d.joints = out;
    d.members.forEach(function (m) { m.a = map[m.a]; m.b = map[m.b]; });
  }
  function removeMember(d, i) {
    if (i < 0 || i >= d.members.length) return false;
    d.members.splice(i, 1);
    prune(d);
    return true;
  }
  function removeJoint(d, j) {
    if (j < 0 || j >= d.joints.length || d.joints[j].anchor) return false;
    d.members = d.members.filter(function (m) { return m.a !== j && m.b !== j; });
    d.joints[j].gone = true;
    prune(d);
    return true;
  }
  // The mirror image of a point about the middle of the gap.
  function mirrorPt(L, p) { return { hx: L.S * 2 - p.hx, hy: p.hy }; }
  function cost(d) {
    var c = 0;
    d.members.forEach(function (m) { c += MATS[m.m].cost * memLen(d, m); });
    d.joints.forEach(function (j) { if (!j.anchor) c += JOINT_COST; });
    return Math.round(c);
  }
  function starsFor(L, c, passed) {
    if (!passed || c > L.budget) return 0;
    return c <= L.p3 ? 3 : c <= L.p2 ? 2 : 1;
  }
  function counts(d) {
    var n = [0, 0, 0, 0];
    d.members.forEach(function (m) { n[m.m]++; });
    return n;
  }

  // ---- encoding (saves) ----
  // { j: [[hx, hy], …] free joints, m: [[a, b, mat], …] } with joint indices
  // counting the level's anchors first.
  function encode(L, d) {
    var na = L.anchors.length;
    return { j: d.joints.slice(na).map(function (j) { return [j.hx, j.hy]; }), m: d.members.map(function (m) { return [m.a, m.b, m.m]; }) };
  }
  // Rebuild a design from a save, dropping anything that is no longer legal.
  function decode(L, o) {
    var d = newDesign(L);
    if (!o || typeof o !== 'object') return d;
    var J = Array.isArray(o.j) ? o.j : [], Mm = Array.isArray(o.m) ? o.m : [], na = L.anchors.length;
    var pts = L.anchors.slice();
    J.forEach(function (p) { pts.push(Array.isArray(p) ? { hx: +p[0] | 0, hy: +p[1] | 0 } : null); });
    Mm.slice(0, 600).forEach(function (m) {
      if (!Array.isArray(m)) return;
      var a = pts[+m[0] | 0], b = pts[+m[1] | 0], mi = +m[2] | 0;
      if (!a || !b || (+m[0] | 0) < 0 || (+m[1] | 0) < 0 || mi < 0 || mi >= MATS.length) return;
      addMember(L, d, a, b, mi);
    });
    void na;
    prune(d);
    return d;
  }

  // ---- simulation ----
  function newSim(L, d) {
    var n = d.joints.length, i;
    var s = {
      L: L, d: d, n: n, t: 0, phase: 'run', reason: '', events: [], steps: 0, acc: 0,
      x: new Float64Array(n), y: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n),
      vx: new Float64Array(n), vy: new Float64Array(n), m: new Float64Array(n), em: new Float64Array(n),
      fix: new Uint8Array(n), qx: new Float64Array(n), qy: new Float64Array(n),
      mem: [], veh: [], maxRatio: 0, broken: 0, winT: 0
    };
    for (i = 0; i < n; i++) {
      var j = d.joints[i];
      s.x[i] = s.px[i] = j.hx / 2; s.y[i] = s.py[i] = j.hy / 2;
      s.fix[i] = j.anchor ? 1 : 0; s.m[i] = JOINT_MASS;
    }
    d.members.forEach(function (m, k) {
      var M = MATS[m.m], L0 = memLen(d, m);
      s.m[m.a] += M.mass * L0 / 2; s.m[m.b] += M.mass * L0 / 2;
      s.mem.push({ a: m.a, b: m.b, mi: m.m, L0: L0, alpha: L0 / M.EA, Tmax: M.T, Cmax: M.C * Math.min(1, M.buck / L0),
        broken: false, f: 0, acc: 0, r: 0, k: k, road: !!M.road, cable: !!M.cable });
    });
    var gapX = -3;
    (L.v || []).forEach(function (vd, k) {
      var V = VEHICLES[vd.t] || VEHICLES.car, ax = V.axles, back;
      back = gapX - (vd.d || 0) - ax[ax.length - 1];
      if (k === 0) back = -2.5 - ax[ax.length - 1];
      s.veh.push({ type: vd.t, V: V, x: back, px: back, sp: V.speed * 0.6, state: 'drive', stall: 0,
        ay: ax.map(function () { return 0; }), cm: ax.map(function () { return -1; }), ct: ax.map(function () { return 0; }),
        bx: 0, by: 0, ang: 0, pbx: 0, pby: 0, pang: 0, vx: 0, vy: 0, va: 0 });
      gapX = back - 1.2;
    });
    s.veh.forEach(function (v) { poseVehicle(s, v); v.pbx = v.bx; v.pby = v.by; v.pang = v.ang; });
    return s;
  }
  // The road under an axle at x: the ground, or the road member whose current
  // segment covers x nearest below the axle's last height. -1: ground, -2: none.
  function support(s, x, prevY, out) {
    var L = s.L, best = -2, bestY = 0, bestT = 0, bd = 1e9;
    if (x <= 0.0001 || x >= L.S - 0.0001) {
      var gy = x <= 0.0001 ? 0 : L.R;
      if (gy <= prevY + 0.4 && gy >= prevY - 1.2) { best = -1; bestY = gy; bd = Math.abs(gy - prevY); }
    }
    for (var k = 0; k < s.mem.length; k++) {
      var m = s.mem[k];
      if (!m.road || m.broken) continue;
      var xa = s.x[m.a], xb = s.x[m.b], dx = xb - xa;
      if (Math.abs(dx) < 1e-6) continue;
      var t = (x - xa) / dx;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      var y = s.y[m.a] + (s.y[m.b] - s.y[m.a]) * t;
      if (y > prevY + 0.4 || y < prevY - 1.2) continue;
      var dd = Math.abs(y - prevY);
      if (dd < bd) { bd = dd; best = k; bestY = y; bestT = clamp(t, 0, 1); }
    }
    out.k = best; out.y = bestY; out.t = bestT;
    return best;
  }
  var SUP = { k: -2, y: 0, t: 0 };
  function poseVehicle(s, v) {
    var ax = v.V.axles, n = ax.length, i;
    for (i = 0; i < n; i++) {
      support(s, v.x + ax[i], v.ay[i], SUP);
      if (SUP.k === -2) return false;
      v.ay[i] = SUP.y; v.cm[i] = SUP.k; v.ct[i] = SUP.t;
    }
    var rx = v.x, ry = v.ay[0], fx = v.x + ax[n - 1], fy = v.ay[n - 1];
    v.ang = Math.atan2(fy - ry, fx - rx);
    v.bx = (rx + fx) / 2; v.by = (ry + fy) / 2;
    return true;
  }
  function stepSim(s) {
    var L = s.L, n = s.n, h = STEP / SUB, i, k, sub, M = s.mem, nm = M.length;
    s.t += STEP; s.steps++;
    var g = G * Math.min(1, s.t / GRAV_RAMP);
    for (i = 0; i < n; i++) { s.px[i] = s.x[i]; s.py[i] = s.y[i]; s.em[i] = 0; }
    // traffic: drive, find the road, load its joints
    var allOver = s.veh.length > 0;
    s.veh.forEach(function (v, vi) {
      v.pbx = v.bx; v.pby = v.by; v.pang = v.ang;
      if (v.state === 'drive' || v.state === 'over') {
        v.sp = Math.min(v.V.speed, v.sp + 1.5 * STEP);
        // climbing: too steep and the wheels spin
        var slope = Math.tan(v.ang), sp = v.sp;
        if (slope > 0.34) sp *= clamp(1 - (slope - 0.34) / 0.16, 0, 1);
        if (sp < 0.05) { v.stall += STEP; } else v.stall = 0;
        // keep a gap behind the vehicle in front while it is still on the road
        var ahead = vi > 0 ? s.veh[vi - 1] : null, ax0 = v.V.axles;
        if (ahead && (ahead.state === 'drive' || ahead.state === 'over')) {
          var lim = ahead.x - ax0[ax0.length - 1] - 2.2;
          if (v.x + sp * STEP > lim) sp = Math.max(0, (lim - v.x) / STEP);
          if (sp < 0.05) v.stall = 0;
        }
        v.x += sp * STEP;
        if (!poseVehicle(s, v)) {
          v.state = 'fall';
          var ax = v.V.axles, frontOk = support(s, v.x + ax[ax.length - 1], v.ay[ax.length - 1], SUP) !== -2;
          v.vx = sp; v.vy = 0; v.va = frontOk ? 1.2 : -1.6;
          s.events.push({ k: 'fall', x: v.bx, y: v.by });
        } else {
          var mm = v.V.mass / v.V.axles.length;
          for (var q = 0; q < v.V.axles.length; q++) {
            var c = v.cm[q];
            if (c < 0) continue;
            s.em[M[c].a] += (1 - v.ct[q]) * mm; s.em[M[c].b] += v.ct[q] * mm;
          }
          if (v.x > L.S + 2.5 && v.state === 'drive') v.state = 'over';
        }
      } else if (v.state === 'fall') {
        v.vy -= G * STEP; v.bx += v.vx * STEP; v.by += v.vy * STEP; v.ang += v.va * STEP; v.vx *= 0.995;
        if (v.by < L.waterY) { v.state = 'sunk'; s.events.push({ k: 'splash', x: v.bx, y: L.waterY }); }
      }
      if (v.state !== 'over') allOver = false;
    });
    // XPBD substeps
    for (k = 0; k < nm; k++) M[k].acc = 0;
    var damp = Math.max(0, 1 - DAMP * h), wet = Math.max(0, 1 - 40 * h), wy = L.waterY;
    for (sub = 0; sub < SUB; sub++) {
      for (i = 0; i < n; i++) {
        if (s.fix[i]) continue;
        s.vy[i] -= g * h;
        s.qx[i] = s.x[i]; s.qy[i] = s.y[i];
        s.x[i] += s.vx[i] * h; s.y[i] += s.vy[i] * h;
      }
      for (k = 0; k < nm; k++) {
        var m = M[k];
        if (m.broken) continue;
        var a = m.a, b = m.b, dx = s.x[b] - s.x[a], dy = s.y[b] - s.y[a], len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-9) continue;
        var C = len - m.L0;
        if (m.cable && C <= 0) continue;
        var wa = s.fix[a] ? 0 : 1 / (s.m[a] + s.em[a]), wb = s.fix[b] ? 0 : 1 / (s.m[b] + s.em[b]);
        var at = m.alpha / (h * h), dl = -C / (wa + wb + at);
        var nx = dx / len, ny = dy / len;
        s.x[a] -= wa * dl * nx; s.y[a] -= wa * dl * ny;
        s.x[b] += wb * dl * nx; s.y[b] += wb * dl * ny;
        m.acc -= dl / (h * h);
      }
      for (i = 0; i < n; i++) {
        if (s.fix[i]) continue;
        s.vx[i] = (s.x[i] - s.qx[i]) / h * damp; s.vy[i] = (s.y[i] - s.qy[i]) / h * damp;
        if (s.y[i] < wy) { s.vx[i] *= wet; s.vy[i] = s.vy[i] * wet + 6 * h; }   // wreckage settles in the river
      }
    }
    // read the forces; the worst overload breaks (one per step: collapses cascade)
    var worst = -1, wr = 1;
    for (k = 0; k < nm; k++) {
      var mk = M[k];
      if (mk.broken) continue;
      mk.f += (mk.acc / SUB - mk.f) * SMOOTH;
      mk.r = mk.f >= 0 ? mk.f / mk.Tmax : (mk.Cmax > 0 ? -mk.f / mk.Cmax : 0);
      if (mk.r > s.maxRatio && s.t > 0.1) s.maxRatio = Math.min(mk.r, 1);
      if (mk.r > wr && s.t > 0.1) { wr = mk.r; worst = k; }
    }
    if (worst >= 0) {
      var w = M[worst];
      w.broken = true; w.r = 1; s.broken++;
      s.events.push({ k: 'break', i: worst, x: (s.x[w.a] + s.x[w.b]) / 2, y: (s.y[w.a] + s.y[w.b]) / 2, mi: w.mi, tension: w.f > 0 });
    }
    // the verdict
    if (s.phase === 'run') {
      var sunk = s.veh.some(function (v) { return v.state === 'sunk'; });
      var stuck = s.veh.some(function (v) { return v.state === 'drive' && v.stall > STALL_T; });
      if (sunk) { s.phase = 'fail'; s.reason = 'fell'; s.events.push({ k: 'fail' }); }
      else if (stuck) { s.phase = 'fail'; s.reason = 'steep'; s.events.push({ k: 'fail' }); }
      else if (allOver) { s.phase = 'win'; s.events.push({ k: 'win' }); }
      else if (s.t > T_LIMIT) { s.phase = 'fail'; s.reason = 'time'; s.events.push({ k: 'fail' }); }
    }
    return s;
  }
  // Advance by real time dt with a fixed-step accumulator; returns the render
  // interpolation factor (0..1) between the last two steps.
  function advance(s, dt, speed) {
    s.acc += Math.min(0.1, dt) * (speed || 1);
    var n = 0;
    while (s.acc >= STEP && n < 40) { stepSim(s); s.acc -= STEP; n++; }
    if (n >= 40) s.acc = 0;
    return clamp(s.acc / STEP, 0, 1);
  }
  // Headless run to the verdict (tests): { win, reason, t, maxRatio, broken }.
  function simulate(L, d, maxT) {
    var s = newSim(L, d), lim = (maxT || T_LIMIT + 1) / STEP;
    for (var i = 0; i < lim && s.phase === 'run'; i++) { stepSim(s); s.events.length = 0; }
    return { win: s.phase === 'win', reason: s.reason, t: s.t, maxRatio: s.maxRatio, broken: s.broken, sim: s };
  }

  // ---- saves ----
  function newSave() { return { v: 1, cur: 0, fine: false, lv: {} }; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    s.cur = clamp(+o.cur | 0, 0, LEVELS.length - 1);
    s.fine = !!o.fine;
    if (o.lv && typeof o.lv === 'object') {
      LEVELS.forEach(function (L) {
        var r = o.lv[L.id];
        if (!r || typeof r !== 'object') return;
        var e = { st: clamp(+r.st | 0, 0, 3), c: Math.max(0, +r.c || 0), done: !!r.done || (+r.st | 0) > 0, d: null };
        if (r.d) { var dd = decode(L, r.d); if (dd.members.length) e.d = encode(L, dd); }
        if (!e.done) { e.st = 0; e.c = 0; }
        s.lv[L.id] = e;
      });
    }
    return s;
  }
  function unlocked(save, i) {
    if (i <= 0) return true;
    var p = save.lv[LEVELS[i - 1].id];
    return !!(p && p.done);
  }
  function totalStars(save) {
    var t = 0;
    LEVELS.forEach(function (L) { var r = save.lv[L.id]; if (r) t += r.st; });
    return t;
  }
  // Fold a test result into the save. Returns { stars, best, first }.
  function record(save, L, c, passed) {
    var r = save.lv[L.id] || (save.lv[L.id] = { st: 0, c: 0, done: false, d: null });
    var st = starsFor(L, c, passed), out = { stars: st, best: false, first: false, overBudget: passed && c > L.budget };
    if (!passed) return out;
    if (!r.done && st > 0) out.first = true;
    if (st > 0) {
      if (!r.done || c < r.c) { out.best = r.done; r.c = c; }
      r.st = Math.max(r.st, st);
      r.done = true;
    }
    return out;
  }

  var ENGINE = {
    STEP: STEP, SUB: SUB, G: G, MATS: MATS, MAT: MAT, VEHICLES: VEHICLES, LEVELS: LEVELS, JOINT_COST: JOINT_COST,
    newDesign: newDesign, cloneDesign: cloneDesign, validPt: validPt, solid: solid, jointAt: jointAt, memberBetween: memberBetween,
    canPlace: canPlace, addMember: addMember, removeMember: removeMember, removeJoint: removeJoint, prune: prune, mirrorPt: mirrorPt,
    memLen: memLen, hlen: hlen, cost: cost, starsFor: starsFor, counts: counts, encode: encode, decode: decode,
    newSim: newSim, stepSim: stepSim, advance: advance, simulate: simulate, support: support,
    newSave: newSave, normSave: normSave, unlocked: unlocked, totalStars: totalStars, record: record
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('bridge.css');

  var PANEL_ID = 'bridge-panel', NAME = 'Bridge Builder';
  var KEY = 'cade-bridge-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var CW = 7, RH = 11;          // glyph cell (logical px)
  var UNDO_MAX = 120;
  var S = null;                 // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.bridge = { live: function () { return S; }, E: ENGINE, load: function (i, intro) { loadLevel(i, intro); }, test: function () { startTest(); } };   // test-only peek

  // palette slots, filled from the theme (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOOD = 4, C_WARN = 5, C_BAD = 6, C_WATER = 7, C_GROUND = 8,
    C_GRID = 9, C_GRID2 = 10, C_WOOD = 11, C_STEEL = 12, C_SKY = 13, C_CLOUD = 14, NPAL = 15;
  var TOOLS = ['road', 'wood', 'steel', 'cable', 'erase'];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) { clearTimeout(S.saveT); S.saveT = 0; sset(SAVE_KEY, JSON.stringify(S.save)); } }
  function persistSoon() { if (S && !S.saveT) S.saveT = setTimeout(function () { if (S) { S.saveT = 0; persist(); } }, 300); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function money(n) { return '$' + fmtInt(n); }
  function starStr(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

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
  var IC_LEVELS = svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>');
  var IC_UNDO = svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>');
  var IC_REDO = svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>');
  var IC_MIRROR = svg('<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M8 7 3 12l5 5zM16 7l5 5-5 5z"/>');
  var IC_GRID = svg('<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>');
  var IC_CLEAR = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>');
  var IC_TEST = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_EDIT = svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>');
  var IC_RETRY = svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>');
  var IC_FAST = svg('<path d="M4 6l8 6-8 6zM12 6l8 6-8 6z"/>', true);

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
    var P = S.pal, sky = dark ? [124, 199, 242] : [40, 120, 181];
    S.dark = dark;
    var rgb = {
      good: dark ? [126, 211, 122] : [47, 143, 58], warn: dark ? [242, 197, 68] : [214, 150, 10], bad: dark ? [240, 106, 106] : [207, 63, 63],
      road: dark ? [176, 170, 164] : [87, 83, 78], wood: dark ? [212, 154, 92] : [160, 100, 42], steel: dark ? [143, 176, 208] : [75, 106, 138],
      cable: dark ? [212, 212, 216] : [63, 63, 70], bg: bg, text: tx, acc: ac, sky: sky
    };
    S.rgb = rgb;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOOD] = css(rgb.good); P[C_WARN] = css(rgb.warn); P[C_BAD] = css(rgb.bad);
    P[C_WATER] = css(mix(bg, sky, dark ? 0.75 : 0.7)); P[C_GROUND] = css(mix(bg, tx, dark ? 0.22 : 0.18));
    P[C_GRID] = css(mix(bg, tx, dark ? 0.3 : 0.26)); P[C_GRID2] = css(mix(bg, tx, dark ? 0.17 : 0.14));
    P[C_WOOD] = css(rgb.wood); P[C_STEEL] = css(rgb.steel); P[C_SKY] = css(sky); P[C_CLOUD] = css(mix(bg, tx, dark ? 0.2 : 0.15));
    S.col = {
      bg: css(bg), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace',
      ground: css(mix(bg, tx, dark ? 0.09 : 0.07)), groundEdge: css(mix(bg, tx, dark ? 0.45 : 0.4)),
      water: css(mix(bg, sky, dark ? 0.16 : 0.12)), waterTop: css(mix(bg, sky, dark ? 0.5 : 0.45)),
      mat: [css(rgb.road), css(rgb.wood), css(rgb.steel), css(rgb.cable)],
      matHi: [css(mix(rgb.road, bg, 0.75)), css(mix(rgb.wood, bg, 0.5)), css(mix(rgb.steel, bg, 0.55)), css(rgb.cable)],
      joint: css(tx), jointFill: css(bg), anchor: css(mix(bg, tx, dark ? 0.55 : 0.6)), acc: css(ac), accSoft: css(ac, 0.22),
      bad: css(rgb.bad), badSoft: css(rgb.bad, 0.2), text: css(tx), muted: css(mu), faint: css(fa), hud: css(bg, 0.82),
      tower: css(mix(bg, tx, dark ? 0.32 : 0.3)), axis: css(ac, 0.45)
    };
    // stress colours: green → amber → red, in 24 buckets
    S.stress = [];
    for (var i = 0; i <= 24; i++) {
      var r = i / 24, c = r < 0.55 ? mix(rgb.good, rgb.warn, r / 0.55) : mix(rgb.warn, rgb.bad, (r - 0.55) / 0.45);
      S.stress.push(css(c));
    }
    fitFont();
  }
  function stressCol(r) { return S.stress[Math.round(clamp(r, 0, 1) * 24)]; }

  // ---- glyph rendering (an atlas of monospace glyphs, stamped with drawImage) ----
  var AT_COLS = 20, AT_ROWS = 16;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '600 ' + S.fpx.toFixed(3) + 'px ' + f;
    buildAtlas();
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 2;
    a.cwp = Math.ceil((CW + 6) * S.k * a.sc); a.chp = Math.ceil((RH + 8) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '600 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
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
  function glyph(c, ci, code, x, y, sc) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl;
    if (i < 0) {
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = sc ? a.cw * sc : a.cw, h = sc ? a.ch * sc : a.ch, dx = Math.round((x - w / 2) * S.k) / S.k, dy = Math.round((y - h / 2) * S.k) / S.k;
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }

  // ---- the view: world metres ↔ logical canvas px ----
  function viewBox(L) {
    var x0 = -L.xPad - 0.7, x1 = L.S + L.xPad + 0.7, w = x1 - x0, MINW = 11;
    if (w < MINW) { x0 -= (MINW - w) / 2; x1 += (MINW - w) / 2; }
    return { x0: x0, x1: x1, y0: L.waterY - 0.9, y1: L.yMax + 0.7 };
  }
  function SX(x) { return S.v.ox + x * S.v.s; }
  function SY(y) { return S.v.oy - y * S.v.s; }
  function WX(px) { return (px - S.v.ox) / S.v.s; }
  function WY(py) { return (S.v.oy - py) / S.v.s; }

  // ---- the static layer: sky, clouds, grid, banks, towers, piers, water ----
  var CLOUDS = [['  .--.', '.(    ).', '(______)'], ['   _.~~._', ' .(      ).', '(__________)']];
  function hashI(a, b) { var h = Math.imul(a ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(b + 0x632BE5AB, 0xC2B2AE35); h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); return (h ^ (h >>> 12)) >>> 0; }
  function buildBg() {
    if (!S.col || !S.L) return;
    var cv = S.bg || (S.bg = document.createElement('canvas'));
    cv.width = S.cv.width; cv.height = S.cv.height;
    var c = cv.getContext('2d'), L = S.L, W = S.cw, H = S.ch, sc = S.v.s, x, y, i;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, W, H);
    // clouds
    for (i = 0; i < 3; i++) {
      var sh = CLOUDS[(i + L.i) % 2], cx = W * (0.12 + 0.36 * i) + (hashI(L.i, i) % 40), cy = 14 + (hashI(i, L.i) % 3) * 12;
      for (var r = 0; r < sh.length; r++) drawStr(c, C_CLOUD, sh[r], cx, cy + r * RH, 'left');
    }
    // grid points
    var fine = S.save.fine, st = fine ? 1 : 2;
    var hx0 = Math.ceil(-L.xPad * 2), hx1 = Math.floor((L.S + L.xPad) * 2), hy0 = Math.ceil(L.yMin * 2), hy1 = Math.floor(L.yMax * 2);
    var gs = sc >= 26 ? 1 : 0.85;
    for (var hy = hy0; hy <= hy1; hy++) {
      for (var hx = hx0; hx <= hx1; hx++) {
        var whole = hx % 2 === 0 && hy % 2 === 0;
        if (!whole && (st === 2 || sc < 14)) continue;
        if (!validPt(L, hx, hy)) continue;
        glyph(c, whole ? C_GRID : C_GRID2, whole ? (hx % 4 === 0 && hy % 4 === 0 ? 43 : 46) : 46, SX(hx / 2), SY(hy / 2), whole ? gs : 0.8);
      }
    }
    // mid-span axis (for the mirror tool)
    c.strokeStyle = S.col.axis; c.lineWidth = 1; c.setLineDash([3, 5]);
    c.beginPath(); c.moveTo(SX(L.S / 2), SY(L.yMax + 0.4)); c.lineTo(SX(L.S / 2), SY(L.waterY)); c.stroke();
    c.setLineDash([]);
    // water body
    var wy = SY(L.waterY);
    c.fillStyle = S.col.water; c.fillRect(SX(0), wy, SX(L.S) - SX(0), H - wy);
    // banks: solid fill with a glyph texture, an edge, and the approach roads
    var banks = [[-50, 0, 0], [L.S, 50, L.R]];
    banks.forEach(function (bk, bi) {
      var xa = Math.max(SX(bk[0]), -2), xb = Math.min(SX(bk[1]), W + 2), top = SY(bk[2]);
      c.fillStyle = S.col.ground; c.fillRect(xa, top, xb - xa, H - top);
      c.save(); c.beginPath(); c.rect(xa, top, xb - xa, H - top); c.clip();
      var TEX = '%#*+=:.';
      for (y = top + RH; y < H + RH; y += RH) {
        for (x = xa + CW / 2; x < xb; x += CW) {
          var hh = hashI(Math.round(x * 3) + bi * 7919, Math.round(y * 5));
          if (hh % 7 < 2) glyph(c, C_GROUND, TEX.charCodeAt((hh >>> 4) % TEX.length), x, y);
        }
      }
      c.restore();
      c.strokeStyle = S.col.groundEdge; c.lineWidth = 1.5;
      c.beginPath();
      if (bi === 0) { c.moveTo(xa, top); c.lineTo(SX(0), top); c.lineTo(SX(0), H); }
      else { c.moveTo(xb, top); c.lineTo(SX(L.S), top); c.lineTo(SX(L.S), H); }
      c.stroke();
      // the approach road
      var rw = Math.max(4, sc * 0.26);
      c.strokeStyle = S.col.mat[0]; c.lineWidth = rw; c.lineCap = 'butt';
      c.beginPath();
      if (bi === 0) { c.moveTo(xa, top); c.lineTo(SX(0), top); } else { c.moveTo(SX(L.S), top); c.lineTo(xb, top); }
      c.stroke();
      c.strokeStyle = S.col.jointFill; c.lineWidth = Math.max(1, rw * 0.16); c.setLineDash([rw * 0.7, rw * 0.7]);
      c.stroke(); c.setLineDash([]);
    });
    // towers and piers under the extra anchors
    L.anchors.forEach(function (a, ai) {
      if (ai < 2) return;
      var ax = a.hx / 2, ay = a.hy / 2, X = SX(ax), base, topY = SY(ay), wpx = Math.max(10, sc * 0.5);
      if (ax <= 0 || ax >= L.S) {
        var gy = ax <= 0 ? 0 : L.R;
        if (ay <= gy) return;           // a cliff anchor: just the bolt
        base = SY(gy);
      } else base = SY(L.waterY) + 4;     // a pier from the river bed
      c.fillStyle = S.col.ground; c.fillRect(X - wpx / 2, topY, wpx, base - topY);
      c.strokeStyle = S.col.tower; c.lineWidth = 1.5; c.strokeRect(X - wpx / 2, topY, wpx, base - topY);
      for (y = topY + RH; y < base - 2; y += RH) glyph(c, C_GROUND, (Math.round(y / RH) % 2) ? 35 : 61, X, y);
    });
  }

  // ---- effects ----
  function makeFx() { S.fx = []; S.debris = []; }
  function spark(x, y, vx, vy, life, code, ci, g) { if (S.fx.length < 260) S.fx.push({ x: x, y: y, vx: vx, vy: vy, t: 0, life: life, code: code, ci: ci, g: g == null ? 1 : g }); }
  function burst(x, y, n, sp, codes, ci, life, up) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      spark(x, y, Math.cos(a) * v, Math.sin(a) * v + (up || 0), life * (0.6 + Math.random() * 0.6), codes.charCodeAt((Math.random() * codes.length) | 0), ci);
    }
  }
  function stepFx(dt) {
    var i, f;
    for (i = S.fx.length - 1; i >= 0; i--) {
      f = S.fx[i]; f.t += dt;
      if (f.t >= f.life) { S.fx.splice(i, 1); continue; }
      f.vy -= 9.8 * f.g * dt; f.x += f.vx * dt; f.y += f.vy * dt;
    }
    for (i = S.debris.length - 1; i >= 0; i--) {
      f = S.debris[i]; f.t += dt;
      if (f.y < S.L.waterY - 1 || f.t > 6) { S.debris.splice(i, 1); continue; }
      f.vy -= 9.8 * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.a += f.va * dt;
      if (f.y < S.L.waterY && !f.sp) { f.sp = 1; burst(f.x, S.L.waterY, 5, 2.4, '~o.', C_SKY, 0.7, 2.5); f.vx *= 0.3; f.vy *= 0.2; f.va *= 0.3; }
    }
  }

  // ---- drawing ----
  function lerp(a, b, t) { return a + (b - a) * t; }
  function jx(i, al) { var s = S.sim; return s ? lerp(s.px[i], s.x[i], al) : S.d.joints[i].hx / 2; }
  function jy(i, al) { var s = S.sim; return s ? lerp(s.py[i], s.y[i], al) : S.d.joints[i].hy / 2; }
  function memWidth(mi) {
    var s = S.v.s;
    return mi === 0 ? Math.max(4, s * 0.26) : mi === 1 ? Math.max(2.5, s * 0.13) : mi === 2 ? Math.max(3, s * 0.15) : Math.max(1.3, s * 0.05);
  }
  function strokeMember(c, mi, x1, y1, x2, y2, col, alpha) {
    var w = memWidth(mi);
    c.globalAlpha = alpha == null ? 1 : alpha;
    c.lineCap = 'round'; c.strokeStyle = col; c.lineWidth = w;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    if (mi === 0) {                     // a dashed centre line on the road
      c.strokeStyle = S.col.jointFill; c.lineWidth = Math.max(1, w * 0.16); c.setLineDash([w * 0.7, w * 0.7]);
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]);
    } else if (mi === 2) {              // steel: a hollow box section
      c.strokeStyle = S.col.jointFill; c.lineWidth = Math.max(1, w * 0.3); c.globalAlpha *= 0.55;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.globalAlpha = 1;
  }
  function draw(al) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, L = S.L, d = S.d, sim = S.sim, i, k;
    al = al == null ? 1 : al;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (S.bg && S.bg.width) c.drawImage(S.bg, 0, 0); else { c.fillStyle = S.col.bg; c.fillRect(0, 0, S.cv.width, S.cv.height); }
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    // waves
    var wy = SY(L.waterY), t = S.clock;
    var gx0 = SX(0), gx1 = SX(L.S);
    c.fillStyle = S.col.waterTop; c.fillRect(gx0, wy - 1, gx1 - gx0, 1.5);
    c.save(); c.beginPath(); c.rect(gx0 + 1, wy - RH, gx1 - gx0 - 2, S.ch); c.clip();
    for (var wx = gx0 - CW * 2 + ((t * 9) % (CW * 2)); wx < gx1 + CW; wx += CW * 2) glyph(c, C_WATER, 126, wx, wy + RH * 0.55);
    for (wx = gx0 - CW * 3 + ((t * 5) % (CW * 3)); wx < gx1 + CW; wx += CW * 3) glyph(c, C_WATER, 126, wx + CW, wy + RH * 1.6);
    c.restore();
    // members
    var mems = d.members, hot = S.mode === 'edit' ? S.hotMem : -1, mirr = S.mode === 'edit' ? S.hotMir : -1;
    for (var pass = 0; pass < 2; pass++) {       // road on top
      for (k = 0; k < mems.length; k++) {
        var m = mems[k], isRoad = m.m === 0;
        if ((pass === 0) === isRoad) continue;
        var col = S.col.mat[m.m], alpha = 1;
        if (sim) {
          var sm = sim.mem[k];
          if (sm.broken) continue;
          col = stressCol(sm.r);
          if (sm.cable && sm.f <= 1) alpha = 0.45;
        }
        if (k === hot || k === mirr) { col = S.tool === 4 ? S.col.bad : S.col.acc; }
        strokeMember(c, m.m, SX(jx(m.a, al)), SY(jy(m.a, al)), SX(jx(m.b, al)), SY(jy(m.b, al)), col, alpha);
      }
    }
    // debris
    for (i = 0; i < S.debris.length; i++) {
      var db = S.debris[i], dx = Math.cos(db.a) * db.h, dy = Math.sin(db.a) * db.h;
      strokeMember(c, db.mi, SX(db.x - dx), SY(db.y - dy), SX(db.x + dx), SY(db.y + dy), S.col.bad, Math.max(0, 1 - db.t / 6));
    }
    // joints
    var jr = Math.max(2.6, Math.min(5, S.v.s * 0.12));
    for (i = 0; i < d.joints.length; i++) {
      var J = d.joints[i], X = SX(jx(i, al)), Y = SY(jy(i, al));
      if (J.anchor) {
        var as = jr * 2.1;
        c.fillStyle = S.col.anchor; c.fillRect(X - as / 2, Y - as / 2, as, as);
        c.strokeStyle = S.col.text; c.lineWidth = 1; c.strokeRect(X - as / 2 + 0.5, Y - as / 2 + 0.5, as - 1, as - 1);
      } else {
        c.beginPath(); c.arc(X, Y, jr, 0, Math.PI * 2);
        c.fillStyle = S.col.jointFill; c.fill();
        c.lineWidth = 1.4; c.strokeStyle = (S.mode === 'edit' && (i === S.hotJ || i === S.hotJm)) ? (S.tool === 4 ? S.col.bad : S.col.acc) : S.col.joint; c.stroke();
      }
    }
    // traffic
    if (sim) sim.veh.forEach(function (v) { drawVehicle(c, v, al); });
    else if (S.mode === 'edit') drawParked(c);
    // edit overlays: pending start, preview line, snap ring
    if (S.mode === 'edit') drawEditOverlay(c);
    // effects
    for (i = 0; i < S.fx.length; i++) {
      var f = S.fx[i];
      c.globalAlpha = Math.max(0, 1 - f.t / f.life);
      glyph(c, f.ci, f.code, SX(f.x), SY(f.y));
    }
    c.globalAlpha = 1;
    hud(c);
    if (S.loupe) drawLoupe(c);
  }
  function drawParked(c) {
    // the first vehicle waits on the left bank
    var L = S.L, vd = L.v[0], V = VEHICLES[vd.t], wb = V.axles[V.axles.length - 1];
    var front = -L.xPad - 0.6, back = front - wb;
    if (back - 0.7 < WX(0)) return;      // no room on screen: it waits off to the left
    drawCar(c, vd.t, V, back + wb / 2, 0, 0, 0, 0.45);
  }
  function drawVehicle(c, v, al) {
    var bx = lerp(v.pbx, v.bx, al), by = lerp(v.pby, v.by, al), an = v.pang + (v.ang - v.pang) * al;
    drawCar(c, v.type, v.V, bx, by, an, v.x, 1);
  }
  // A vehicle in its own frame: x along the wheelbase from its middle, y up, metres.
  function drawCar(c, type, V, bx, by, an, dist, alpha) {
    var s = S.v.s, ax = V.axles, wb = ax[ax.length - 1], half = wb / 2, rgb = S.rgb, wr = type === 'truck' || type === 'bus' ? 0.36 : type === 'cart' ? 0.24 : 0.3;
    c.save();
    c.globalAlpha = alpha;
    c.translate(SX(bx), SY(by)); c.rotate(-an); c.scale(s, -s);
    c.translate(0, memWidth(0) / 2 / s);
    var body, cab = null, win = [];
    var lw = 1.2 / s;
    if (type === 'cart') { body = [-half - 0.35, wr * 0.9, wb + 0.7, 0.45]; c.fillStyle = css(rgb.wood); }
    else if (type === 'car') { body = [-half - 0.5, wr * 0.8, wb + 1.0, 0.45]; cab = [-half + 0.05, wr * 0.8 + 0.42, wb * 0.72, 0.42]; c.fillStyle = css(rgb.acc); }
    else if (type === 'van') { body = [-half - 0.5, wr * 0.8, wb + 1.0, 1.05]; win.push([half - 0.05, wr * 0.8 + 0.55, 0.45, 0.35]); c.fillStyle = css(rgb.sky); }
    else if (type === 'truck') { body = [-half - 0.6, wr * 0.9, wb - 0.35, 1.35]; cab = [half - 0.2, wr * 0.9, 1.0, 1.05]; c.fillStyle = css(rgb.steel); }
    else { body = [-half - 0.6, wr * 0.85, wb + 1.2, 1.35]; for (var q = 0; q < 4; q++) win.push([-half - 0.3 + q * (wb + 0.6) / 4, wr * 0.85 + 0.75, (wb + 0.6) / 4 - 0.18, 0.38]); c.fillStyle = css(rgb.warn); }
    c.strokeStyle = css(rgb.text); c.lineWidth = lw;
    rr(c, body[0], body[1], body[2], body[3], 0.12); c.fill(); c.stroke();
    if (cab) {
      c.fillStyle = type === 'truck' ? css(rgb.bad) : css(mix(rgb.acc, rgb.bg, 0.25));
      rr(c, cab[0], cab[1], cab[2], cab[3], 0.14); c.fill(); c.stroke();
      win.push(type === 'truck' ? [cab[0] + cab[2] * 0.45, cab[1] + cab[3] * 0.45, cab[2] * 0.42, cab[3] * 0.38] : [cab[0] + 0.12, cab[1] + 0.08, cab[2] - 0.24, cab[3] - 0.16]);
    }
    c.fillStyle = css(mix(rgb.bg, rgb.sky, 0.35));
    win.forEach(function (w) { rr(c, w[0], w[1], w[2], w[3], 0.05); c.fill(); });
    if (type === 'truck') {               // a crate stencil on the box
      c.strokeStyle = css(mix(rgb.steel, rgb.bg, 0.5)); c.lineWidth = lw;
      for (var k = 1; k < 4; k++) { var xx = body[0] + body[2] * k / 4; c.beginPath(); c.moveTo(xx, body[1] + 0.12); c.lineTo(xx, body[1] + body[3] - 0.12); c.stroke(); }
    }
    // wheels with turning spokes
    for (var i = 0; i < ax.length; i++) {
      var x = ax[i] - half, rot = -(dist || 0) / wr;
      c.beginPath(); c.arc(x, wr, wr, 0, Math.PI * 2); c.fillStyle = css(rgb.text); c.fill();
      c.beginPath(); c.arc(x, wr, wr * 0.45, 0, Math.PI * 2); c.fillStyle = css(rgb.bg); c.fill();
      c.strokeStyle = css(rgb.text); c.lineWidth = lw * 1.2;
      c.beginPath(); c.moveTo(x + Math.cos(rot) * wr * 0.45, wr + Math.sin(rot) * wr * 0.45); c.lineTo(x - Math.cos(rot) * wr * 0.45, wr - Math.sin(rot) * wr * 0.45); c.stroke();
    }
    c.restore();
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }
  function ring(c, p, col, r, dash) {
    c.strokeStyle = col; c.lineWidth = 1.6; if (dash) c.setLineDash([3, 3]);
    c.beginPath(); c.arc(SX(p.hx / 2), SY(p.hy / 2), r, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  }
  function drawEditOverlay(c) {
    var L = S.L, r = Math.max(7, S.v.s * 0.3), mi = S.tool;
    var from = S.drag && S.drag.start ? S.drag.start : S.pend, to = S.drag ? S.drag.cur : S.hover;
    if (mi < 4 && from && to && (to.hx !== from.hx || to.hy !== from.hy)) {
      var why = canPlace(L, S.d, from, to, mi);
      strokeMember(c, mi, SX(from.hx / 2), SY(from.hy / 2), SX(to.hx / 2), SY(to.hy / 2), why ? S.col.bad : S.col.mat[mi], 0.7);
      if (S.mirror) {
        var mf = mirrorPt(L, from), mt = mirrorPt(L, to);
        if (!(mf.hx === from.hx && mt.hx === to.hx)) strokeMember(c, mi, SX(mf.hx / 2), SY(mf.hy / 2), SX(mt.hx / 2), SY(mt.hy / 2), S.col.mat[mi], 0.3);
      }
      // length and price tag
      var len = hlen(from.hx, from.hy, to.hx, to.hy), tag = len.toFixed(1) + 'm ' + money(len * MATS[mi].cost);
      var tx = SX((from.hx + to.hx) / 4), ty = SY((from.hy + to.hy) / 4) - 12;
      c.fillStyle = S.col.hud; c.fillRect(tx - tag.length * CW / 2 - 3, ty - RH / 2 - 1, tag.length * CW + 6, RH + 2);
      drawStr(c, why ? C_BAD : C_TEXT, tag, tx, ty, 'center');
    }
    if (S.pend) ring(c, S.pend, S.col.acc, r);
    if (to && mi < 4) ring(c, to, S.col.acc, r * 0.75, true);
    if (S.mirror && S.pend) ring(c, mirrorPt(L, S.pend), S.col.axis, r * 0.8, true);
  }
  function hud(c) {
    var L = S.L, sim = S.sim, x = 8, y = 10;
    if (sim) {
      var mr = 0;
      for (var k = 0; k < sim.mem.length; k++) if (!sim.mem[k].broken && sim.mem[k].r > mr) mr = sim.mem[k].r;
      var pct = Math.round(Math.min(mr, 1) * 100), s1 = 'stress ' + (pct < 10 ? ' ' : '') + pct + '%';
      c.fillStyle = S.col.hud; c.fillRect(x - 4, y - RH / 2 - 2, 15 * CW + 64, RH + 4);
      drawStr(c, pct >= 85 ? C_BAD : pct >= 55 ? C_WARN : C_TEXT, s1, x, y, 'left');
      var bx = x + s1.length * CW + 6, bw = 60;
      for (var i = 0; i < bw; i += 3) { c.fillStyle = stressCol(i / bw); c.globalAlpha = i / bw <= mr ? 1 : 0.25; c.fillRect(bx + i, y - 3, 2, 6); }
      c.globalAlpha = 1;
      if (S.speed > 1) drawStr(c, C_ACC, 'x' + S.speed, S.cw - 8, y, 'right');
      if (sim.broken) drawStr(c, C_BAD, sim.broken + ' broken', S.cw - 8, y + RH + 2, 'right');
    } else if (S.mode === 'edit') {
      var n = counts(S.d), parts = [];
      MATS.forEach(function (M, i) { if (n[i]) parts.push(n[i] + ' ' + M.name.toLowerCase()); });
      var s2 = parts.length ? parts.join(' · ') : (S.coarse ? 'drag between points to build' : 'drag from an anchor to build');
      c.fillStyle = S.col.hud; c.fillRect(x - 4, y - RH / 2 - 2, s2.length * CW + 8, RH + 4);
      drawStr(c, C_FAINT, s2, x, y, 'left');
      if (S.mirror) { c.fillRect(S.cw - 12 - 6 * CW, y - RH / 2 - 2, 6 * CW + 8, RH + 4); drawStr(c, C_ACC, 'mirror', S.cw - 8, y, 'right'); }
    }
  }
  // Touch: a magnifier above the finger, so the snap point under it is visible.
  function drawLoupe(c) {
    var lp = S.loupe, R = 46, zoom = 2, cx = lp.x, cy = lp.y - 78;
    if (cy < R + 4) cy = lp.y + 78;
    cx = clamp(cx, R + 2, S.cw - R - 2);
    var sx = (lp.x - R / zoom) * S.k, sy = (lp.y - R / zoom) * S.k, sw = 2 * R / zoom * S.k;
    c.save();
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.closePath();
    c.fillStyle = S.col.bg; c.fill();
    c.clip();
    try { c.drawImage(S.cv, sx, sy, sw, sw, cx - R, cy - R, 2 * R, 2 * R); } catch (e) {}
    c.restore();
    c.strokeStyle = S.col.acc; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = S.col.acc; c.lineWidth = 1; c.beginPath(); c.moveTo(cx - 6, cy); c.lineTo(cx + 6, cy); c.moveTo(cx, cy - 6); c.lineTo(cx, cy + 6); c.stroke();
  }

  // ---- edit: snapping, placing, erasing, undo ----
  function snapHalf(v, st) { return Math.round(v * 2 / st) * st; }
  // The point a drag from `from` at world (wx, wy) lands on: an existing joint
  // under the pointer, else the nearest grid point; if that is out of reach or
  // in the ground, the reachable point nearest the pointer.
  function snapTarget(from, wx, wy, mi) {
    var L = S.L, d = S.d, st = S.save.fine ? 1 : 2, best = null, bd = 1e9, i, rad = Math.max(0.3, 9 / S.v.s);
    for (i = 0; i < d.joints.length; i++) {
      var J = d.joints[i], dd = Math.hypot(J.hx / 2 - wx, J.hy / 2 - wy);
      if (dd < rad && dd < bd) { bd = dd; best = { hx: J.hx, hy: J.hy }; }
    }
    if (!best) best = { hx: snapHalf(wx, st), hy: snapHalf(wy, st) };
    if (!from || mi >= 4) return validPt(L, best.hx, best.hy) || jointAt(d, best.hx, best.hy) >= 0 ? best : null;
    var ok = !canPlace(L, d, from, best, mi);
    if (ok || (best.hx === from.hx && best.hy === from.hy)) return best;
    // search the reachable points (grid and joints) for the one nearest the pointer
    var R = Math.floor(MATS[mi].max * 2), cand = null, cd = 1e9;
    function consider(p) {
      if (p.hx === from.hx && p.hy === from.hy) return;
      if (canPlace(L, d, from, p, mi)) return;
      var e = Math.hypot(p.hx / 2 - wx, p.hy / 2 - wy);
      if (e < cd) { cd = e; cand = p; }
    }
    for (var hx = from.hx - R - (from.hx - R) % st; hx <= from.hx + R; hx += st) {
      for (var hy = from.hy - R - (from.hy - R) % st; hy <= from.hy + R; hy += st) consider({ hx: hx, hy: hy });
    }
    for (i = 0; i < d.joints.length; i++) consider({ hx: d.joints[i].hx, hy: d.joints[i].hy });
    return cand;
  }
  function startPoint(wx, wy) {
    var L = S.L, d = S.d, st = S.save.fine ? 1 : 2, rad = Math.max(0.35, 12 / S.v.s), best = null, bd = 1e9;
    for (var i = 0; i < d.joints.length; i++) {
      var J = d.joints[i], dd = Math.hypot(J.hx / 2 - wx, J.hy / 2 - wy);
      if (dd < rad && dd < bd) { bd = dd; best = { hx: J.hx, hy: J.hy }; }
    }
    if (best) return best;
    var p = { hx: snapHalf(wx, st), hy: snapHalf(wy, st) };
    return validPt(L, p.hx, p.hy) ? p : null;
  }
  function snapshot() { return JSON.stringify(encode(S.L, S.d)); }
  function pushUndo() {
    S.undo.push(snapshot());
    if (S.undo.length > UNDO_MAX) S.undo.shift();
    S.redo.length = 0;
  }
  function restore(snap) { try { S.d = decode(S.L, JSON.parse(snap)); } catch (e) {} }
  function changed() {
    var id = S.L.id, r = S.save.lv[id] || (S.save.lv[id] = { st: 0, c: 0, done: false, d: null });
    r.d = S.d.members.length ? encode(S.L, S.d) : null;
    S.save.cur = S.L.i;
    persistSoon();
    S.hotMem = S.hotMir = S.hotJ = S.hotJm = -1;
    syncBar(); syncTools(); redraw();
  }
  function place(p, q) {
    var L = S.L, mi = S.tool, before = snapshot(), any = false;
    var why = canPlace(L, S.d, p, q, mi);
    if (why) {
      S.snd.tone(150, 0.08, 'square', 0.025);
      say(why === 'long' ? MATS[mi].name + ' reaches ' + MATS[mi].max + ' m at most' : why === 'ground' ? 'Not through the ground' : '');
      return false;
    }
    any = addMember(L, S.d, p, q, mi);
    if (S.mirror) {
      var mp = mirrorPt(L, p), mq = mirrorPt(L, q);
      if (!canPlace(L, S.d, mp, mq, mi) && addMember(L, S.d, mp, mq, mi)) any = true;
    }
    if (!any) return false;
    S.undo.push(before); if (S.undo.length > UNDO_MAX) S.undo.shift(); S.redo.length = 0;
    var len = hlen(p.hx, p.hy, q.hx, q.hy);
    S.snd.tone([520, 440, 330, 660][mi] * (1 + (2.5 - Math.min(len, 5)) * 0.06), 0.06, mi === 3 ? 'sine' : 'triangle', 0.04);
    Cade.haptic && Cade.haptic(5);
    changed();
    return true;
  }
  // What the erase tool would hit at (px, py): { m } member or { j } joint.
  function hitAt(px, py) {
    var d = S.d, i, best = null, bd = S.coarse ? 18 : 11;
    for (i = 0; i < d.joints.length; i++) {
      if (d.joints[i].anchor) continue;
      var dd = Math.hypot(SX(d.joints[i].hx / 2) - px, SY(d.joints[i].hy / 2) - py);
      if (dd < bd * 0.8) { bd = dd; best = { j: i }; }
    }
    if (best) return best;
    bd = S.coarse ? 16 : 9;
    for (i = 0; i < d.members.length; i++) {
      var m = d.members[i], ax = SX(d.joints[m.a].hx / 2), ay = SY(d.joints[m.a].hy / 2), bx = SX(d.joints[m.b].hx / 2), by = SY(d.joints[m.b].hy / 2);
      var vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy, t = l2 ? clamp(((px - ax) * vx + (py - ay) * vy) / l2, 0, 1) : 0;
      var e = Math.hypot(ax + vx * t - px, ay + vy * t - py);
      if (e < bd) { bd = e; best = { m: i }; }
    }
    return best;
  }
  function mirrorOf(hit) {
    var d = S.d, L = S.L;
    if (hit.j != null) { var J = d.joints[hit.j], mp = mirrorPt(L, J); var k = jointAt(d, mp.hx, mp.hy); return k >= 0 && k !== hit.j ? { j: k } : null; }
    var m = d.members[hit.m], a = mirrorPt(L, d.joints[m.a]), b = mirrorPt(L, d.joints[m.b]);
    var ia = jointAt(d, a.hx, a.hy), ib = jointAt(d, b.hx, b.hy);
    if (ia < 0 || ib < 0) return null;
    var e = memberBetween(d, ia, ib);
    return e >= 0 && e !== hit.m ? { m: e } : null;
  }
  function eraseHit(hit) {
    var d = S.d, keys = [];
    function key(h) {
      if (h.j != null) return { j: d.joints[h.j] };
      var m = d.members[h.m]; return { a: d.joints[m.a], b: d.joints[m.b] };
    }
    keys.push(key(hit));
    if (S.mirror) { var mh = mirrorOf(hit); if (mh) keys.push(key(mh)); }
    var any = false;
    keys.forEach(function (kk) {
      if (kk.j) { var ji = d.joints.indexOf(kk.j); if (ji >= 0 && removeJoint(d, ji)) any = true; }
      else {
        var ia = d.joints.indexOf(kk.a), ib = d.joints.indexOf(kk.b), e = ia >= 0 && ib >= 0 ? memberBetween(d, ia, ib) : -1;
        if (e >= 0 && removeMember(d, e)) any = true;
      }
    });
    return any;
  }
  function doUndo() {
    if (!S.undo.length || S.mode !== 'edit') return;
    S.redo.push(snapshot()); restore(S.undo.pop()); S.pend = null;
    S.snd.tone(392, 0.05, 'sine', 0.03); changed();
  }
  function doRedo() {
    if (!S.redo.length || S.mode !== 'edit') return;
    S.undo.push(snapshot()); restore(S.redo.pop()); S.pend = null;
    S.snd.tone(523, 0.05, 'sine', 0.03); changed();
  }
  function doClear() {
    if (!S.d.members.length || S.mode !== 'edit') return;
    pushUndo(); S.d = newDesign(S.L); S.pend = null;
    S.snd.tone(220, 0.12, 'triangle', 0.035, 110);
    Cade.showToast && Cade.showToast('Cleared — Undo brings it back', 'info', 1800);
    changed();
  }
  function setTool(i) {
    if (S.mode !== 'edit') return;
    S.tool = i; S.pend = null;
    S.snd.tone(660 + i * 60, 0.03, 'sine', 0.025);
    syncTools(); redraw();
  }
  function say(t) { if (S && S.liveEl && t) { S.liveEl.textContent = ''; S.liveEl.textContent = t; if (S.coarse || t.length) S.toast(t); } }

  // ---- testing ----
  function running() {
    return !!S && S.mode === 'test' && !S.paused && !S.resultShown && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
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
    S.clock += dt;
    var sim = S.sim, al = advance(sim, dt, S.speed);
    handleEvents(sim);
    stepFx(dt * S.speed);
    if (sim.phase !== 'run') {
      S.endT += dt;
      var wait = sim.phase === 'win' ? 1.0 : 1.8;
      if (S.endT >= wait) { draw(al); showResult(); return; }
    }
    // creaks when something is close to giving
    var mr = 0;
    for (var k = 0; k < sim.mem.length; k++) if (!sim.mem[k].broken && sim.mem[k].r > mr) mr = sim.mem[k].r;
    S.creakT -= dt;
    if (mr > 0.85 && S.creakT <= 0) { S.creakT = 0.35 + Math.random() * 0.3; S.snd.tone(70 + Math.random() * 30, 0.16, 'sawtooth', 0.018, 55); }
    draw(al);
    S.raf = requestAnimationFrame(frame);
  }
  function handleEvents(sim) {
    for (var i = 0; i < sim.events.length; i++) {
      var e = sim.events[i];
      if (e.k === 'break') {
        var m = sim.mem[e.i], ax = sim.x[m.a], ay = sim.y[m.a], bx = sim.x[m.b], by = sim.y[m.b], a = Math.atan2(by - ay, bx - ax), q = m.L0 / 4;
        var vx = (sim.vx[m.a] + sim.vx[m.b]) / 2, vy = (sim.vy[m.a] + sim.vy[m.b]) / 2;
        S.debris.push({ x: ax + (bx - ax) * 0.25, y: ay + (by - ay) * 0.25, h: q * 0.9, a: a, va: -2 - Math.random() * 3, vx: vx - 0.6, vy: vy + 1, t: 0, mi: m.mi });
        S.debris.push({ x: ax + (bx - ax) * 0.75, y: ay + (by - ay) * 0.75, h: q * 0.9, a: a, va: 2 + Math.random() * 3, vx: vx + 0.6, vy: vy + 1, t: 0, mi: m.mi });
        burst(e.x, e.y, 10, 4, '*+x.', C_BAD, 0.6, 1);
        S.snd.tone(m.mi === 3 ? 900 : 180, 0.18, 'square', 0.05, m.mi === 3 ? 300 : 60);
        S.snd.tone(90, 0.25, 'sawtooth', 0.03, 40, 0.02);
        Cade.haptic && Cade.haptic(18);
      } else if (e.k === 'fall') {
        S.snd.tone(330, 0.6, 'triangle', 0.04, 110);
      } else if (e.k === 'splash') {
        burst(e.x, e.y + 0.1, 22, 5, '~o.*', C_SKY, 0.9, 4);
        S.snd.tone(200, 0.4, 'sawtooth', 0.03, 50);
        Cade.haptic && Cade.haptic(30);
      } else if (e.k === 'win') {
        var L = S.L;
        for (var j = 0; j < 4; j++) burst(L.S + 1 + j * 0.4, L.R + 1.5, 8, 4.5, '*+o.', [C_ACC, C_GOOD, C_WARN, C_SKY][j], 1.2, 3);
        [523, 659, 784, 1047].forEach(function (fq, jj) { S.snd.tone(fq, 0.12, 'triangle', 0.04, 0, jj * 0.08); });
      } else if (e.k === 'fail') {
        if (sim.reason === 'steep') S.snd.tone(140, 0.4, 'square', 0.03, 90);
      }
    }
    sim.events.length = 0;
  }
  function startTest() {
    if (!S || S.mode === 'test') return;
    S.snd.ensure();
    S.pend = null; S.drag = null; S.loupe = null;
    S.mode = 'test'; S.paused = false; S.resultShown = false; S.endT = 0; S.creakT = 0;
    S.sim = newSim(S.L, cloneDesign(S.d)); S.testCost = cost(S.d);
    makeFx();
    showCard(null); syncTools(); syncHead(); syncBar();
    S.snd.tone(330, 0.12, 'triangle', 0.035, 660);
    kick();
  }
  function toEdit() {
    if (!S) return;
    stopLoop();
    S.mode = 'edit'; S.sim = null; S.paused = false; S.resultShown = false;
    makeFx();
    showCard(null); syncTools(); syncHead(); syncBar(); redraw();
  }
  function retry() { toEdit(); startTest(); }
  function pause() {
    if (!S || S.mode !== 'test' || S.paused || S.resultShown) return;
    S.paused = true; stopLoop(); showCard('pause'); syncHead();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false; showCard(null); syncHead(); kick();
  }
  function showResult() {
    var sim = S.sim, L = S.L, c = S.testCost, win = sim.phase === 'win';
    S.resultShown = true;
    stopLoop();
    var rec = record(S.save, L, c, win);
    if (win && S.save.lv[L.id]) S.save.lv[L.id].d = encode(L, S.d);
    persist();
    S.res = { win: win, reason: sim.reason, cost: c, stars: rec.stars, best: rec.best, first: rec.first, over: rec.overBudget, maxR: sim.maxRatio, broken: sim.broken };
    if (win && rec.stars) say('Crossed! ' + rec.stars + ' star' + (rec.stars > 1 ? 's' : '') + ' for ' + money(c));
    else if (win) say('Crossed, but over budget');
    else say(sim.reason === 'steep' ? 'The road is too steep' : 'The bridge failed');
    showCard('result'); syncTools(); syncHead(); syncBar();
  }

  // ---- cards ----
  function levelsHtml() {
    var sv = S.save, tot = totalStars(sv), h = '<div class="bb-card bb-levels"><div class="bb-title">BRIDGE BUILDER</div>' +
      '<div class="bb-sub">★ ' + tot + ' / ' + LEVELS.length * 3 + ' &nbsp;·&nbsp; ' + LEVELS.filter(function (L) { return sv.lv[L.id] && sv.lv[L.id].done; }).length + ' of ' + LEVELS.length + ' crossed</div><div class="bb-grid">';
    LEVELS.forEach(function (L, i) {
      var r = sv.lv[L.id], open = unlocked(sv, i), st = r ? r.st : 0;
      h += '<button type="button" class="bb-lv' + (i === S.li ? ' cur' : '') + (open ? '' : ' locked') + (r && r.done ? ' done' : '') + '" data-lv="' + i + '"' + (open ? '' : ' aria-disabled="true"') +
        ' aria-label="Level ' + (i + 1) + ', ' + esc(L.name) + (open ? ', ' + st + ' stars' : ', locked') + '">' +
        '<b>' + pad2(i + 1) + '</b><span class="bb-st">' + (open ? starStr(st) : '- - -') + '</span><i>' + esc(L.name) + '</i></button>';
    });
    h += '</div><div class="bb-btns"><button type="button" class="bb-go" data-act="play">' + (S.L && S.save.lv[S.L.id] && S.save.lv[S.L.id].d ? 'Continue ' : 'Play ') + pad2(S.li + 1) + '</button>' +
      '<button type="button" class="bb-go alt" data-act="help">How to play</button></div></div>';
    return h;
  }
  function vehiclesText(L) {
    var n = {};
    L.v.forEach(function (v) { n[v.t] = (n[v.t] || 0) + 1; });
    return Object.keys(n).map(function (t) { var V = VEHICLES[t]; return (n[t] > 1 ? n[t] + ' ' + V.name + 's' : 'a ' + V.name) + ' (' + fmtInt(V.mass) + ' kg)'; }).join(' + ');
  }
  function introHtml() {
    var L = S.L, r = S.save.lv[L.id];
    return '<div class="bb-card"><div class="bb-title">' + pad2(L.i + 1) + ' ' + esc(L.name.toUpperCase()) + '</div>' +
      '<pre class="bb-tab">' + row('gap', L.S + ' m' + (L.R ? ', far bank +' + L.R + ' m' : '')) + '\n' + row('traffic', vehiclesText(L).replace(/ \+ /g, ' +\n')) + '\n' +
      row('budget', money(L.budget)) + '\n' + row('★★ / ★★★', money(L.p2) + ' / ' + money(L.p3)) + (r && r.done ? '\n' + row('your best', money(r.c) + '  ' + starStr(r.st)) : '') + '</pre>' +
      '<p class="bb-tip">' + esc(L.tip) + '</p>' +
      '<div class="bb-btns"><button type="button" class="bb-go" data-act="build">Build</button><button type="button" class="bb-go alt" data-act="levels">Levels</button></div></div>';
  }
  // a label / value line of a monospace table; a value with line breaks hangs under its first line
  function row(a, b) {
    var ind = Math.max(1, 11 - a.length);
    return '<i>' + esc(a) + '</i>' + new Array(ind + 1).join(' ') + '<b>' + esc(b).split('\n').join('\n' + new Array(a.length + ind + 1).join(' ')) + '</b>';
  }
  function helpHtml() {
    var k = S.coarse;
    return '<div class="bb-card"><div class="bb-title">HOW TO PLAY</div>' +
      '<p>Get the traffic across the gap. ' + (k ? 'Drag' : 'Drag (or click, click)') + ' between grid points to lay a member; new joints appear at the ends. Members hinge at the joints, so build <b>triangles</b>: a square folds.</p>' +
      '<p>Only <b>road</b> carries wheels and it must run from bank to bank. <b>Wood</b> is cheap, <b>steel</b> strong, <b>cable</b> long and light but it only pulls. Anchors (the squares) hold fast.</p>' +
      '<p>Press <b>Test</b>: members glow <span class="bb-c-good">green</span> → <span class="bb-c-warn">amber</span> → <span class="bb-c-bad">red</span> with stress and snap past 100%. Stay under budget; the cheaper the bridge, the more stars.</p>' +
      '<div class="bb-keys">' + (k ? '<div><b>Tap</b> a point, then another: chained members</div><div><b>Erase</b> tool: tap a member or joint</div>' :
        '<div><b>1-4</b> road · wood · steel · cable &nbsp; <b>E</b> erase</div><div><b>Ctrl+Z / Ctrl+Y</b> undo / redo &nbsp; <b>M</b> mirror &nbsp; <b>G</b> fine grid</div>' +
        '<div><b>Space</b> test / edit &nbsp; <b>R</b> retry &nbsp; <b>F</b> speed &nbsp; <b>Esc</b> cancel</div>') +
      '<div><b>Mirror</b> copies every edit across the middle of the gap</div></div>' +
      '<div class="bb-tab">' + MATS.map(function (M) { return '<span class="bb-m bb-m-' + M.id + '"></span><b>' + M.name + '</b> <i>$' + M.cost + '/m · max ' + M.max + ' m · ' + (M.cable ? 'pull ' + M.T / 1000 + 'k' : (M.T / 1000) + 'k / ' + (M.C / 1000) + 'k') + '</i>'; }).join('<br>') + '</div>' +
      '<div class="bb-btns"><button type="button" class="bb-go" data-act="close-help">Got it</button></div></div>';
  }
  function resultHtml() {
    var r = S.res, L = S.L, next = L.i + 1 < LEVELS.length, h;
    if (r.win) {
      h = '<div class="bb-card bb-res"><div class="bb-title">' + (r.stars ? 'CROSSED' : 'OVER BUDGET') + '</div>' +
        '<div class="bb-big">' + starStr(r.stars) + '</div>' +
        '<pre class="bb-tab">' + row('cost', money(r.cost) + ' of ' + money(L.budget)) + '\n' + row('peak stress', Math.round(r.maxR * 100) + '%') +
        (r.broken ? '\n' + row('broken', r.broken + ' member' + (r.broken > 1 ? 's' : '')) : '') + '</pre>';
      if (!r.stars) h += '<p class="bb-tip">The traffic made it, but cut ' + money(r.cost - L.budget) + ' to earn a star.</p>';
      else if (r.stars < 3) h += '<p class="bb-tip">' + money(r.cost - (r.stars === 2 ? L.p3 : L.p2)) + ' cheaper for ' + starStr(r.stars + 1).replace(/☆/g, '') + '.</p>';
      if (r.best) h += '<div class="bb-new">new best</div>';
      if (r.first && next) h += '<div class="bb-new">level ' + (L.i + 2) + ' unlocked</div>';
      h += '<div class="bb-btns">' + (next && unlocked(S.save, L.i + 1) ? '<button type="button" class="bb-go" data-act="next">Next level</button>' : '') +
        '<button type="button" class="bb-go' + (next && unlocked(S.save, L.i + 1) ? ' alt' : '') + '" data-act="edit">Improve</button></div>';
      if (!next && r.stars) h += '<div class="bb-note">That was the last level — chase the stars!</div>';
    } else {
      var why = r.reason === 'steep' ? 'The road climbs too steeply: the wheels spin. Keep slopes under one in three.' :
        r.reason === 'time' ? 'The traffic never made it across.' :
          r.broken ? 'Members snapped and the traffic fell. Red members need more support: shorter spans, deeper triangles or steel.' :
            'The wheels found no road. Lay road from bank to bank, and brace it with triangles so it does not fold.';
      h = '<div class="bb-card bb-res"><div class="bb-title">' + (r.reason === 'steep' ? 'STALLED' : 'COLLAPSE') + '</div>' +
        '<pre class="bb-art">' + (r.reason === 'steep' ? '  __/\n_/  ~' : ' \\ /\n~~v~~') + '</pre>' +
        '<p class="bb-tip">' + why + '</p>' +
        '<div class="bb-btns"><button type="button" class="bb-go" data-act="edit">Fix it</button><button type="button" class="bb-go alt" data-act="retry">Watch again</button></div></div>';
    }
    return h + (r.win ? '</div>' : '');
  }
  function pauseHtml() {
    return '<div class="bb-card"><div class="bb-title">PAUSED</div>' +
      '<div class="bb-btns"><button type="button" class="bb-go" data-act="resume">Resume</button><button type="button" class="bb-go alt" data-act="edit">Back to edit</button></div>' +
      '<div class="bb-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'levels' ? levelsHtml() : kind === 'help' ? helpHtml() : kind === 'intro' ? introHtml() : kind === 'result' ? resultHtml() : kind === 'pause' ? pauseHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.root.classList.toggle('dim', !!kind);
    if (kind) { S.ovl.scrollTop = 0; S.pend = null; S.drag = null; }
  }

  // ---- bars ----
  function syncBar() {
    if (!S || !S.L) return;
    var L = S.L, c = S.mode === 'test' ? S.testCost : cost(S.d), over = c > L.budget, st = starsFor(L, c, true);
    S.bar.innerHTML = '<span class="bb-lvl"><b>' + pad2(L.i + 1) + '</b> ' + esc(L.name) + '</span>' +
      '<span class="bb-cost' + (over ? ' over' : '') + '" title="Cost / budget">' + money(c) + '<i> / ' + money(L.budget) + '</i></span>' +
      '<span class="bb-par" title="★★★ at ' + money(L.p3) + ', ★★ at ' + money(L.p2) + '">' + (over ? '<span class="bb-c-bad">over</span>' : starStr(st)) + '</span>';
    var pct = clamp(c / L.budget, 0, 1.2);
    S.bar.style.setProperty('--bb-fill', (Math.min(1, pct) * 100).toFixed(1) + '%');
  }
  function syncTools() {
    if (!S) return;
    var ed = S.mode === 'edit', h = '';
    if (ed) {
      h += '<div class="bb-row bb-mats" role="toolbar" aria-label="Materials">';
      TOOLS.forEach(function (t, i) {
        var M = MATS[i];
        h += '<button type="button" class="bb-tool' + (S.tool === i ? ' on' : '') + '" data-tool="' + i + '" aria-pressed="' + (S.tool === i) + '" title="' + (M ? M.name + ' — $' + M.cost + '/m, up to ' + M.max + ' m (' + M.key + ')' : 'Erase (E)') + '">' +
          '<span class="bb-m bb-m-' + t + '"></span><b>' + (M ? M.name : 'Erase') + '</b>' + (M ? '<i>$' + M.cost + '</i>' : '<i>&nbsp;</i>') + '</button>';
      });
      h += '</div><div class="bb-row bb-acts">' +
        '<button type="button" class="bb-ab" data-act="undo" title="Undo (Ctrl+Z)"' + (S.undo.length ? '' : ' disabled') + '>' + IC_UNDO + '<span>Undo</span></button>' +
        '<button type="button" class="bb-ab" data-act="redo" title="Redo (Ctrl+Y)"' + (S.redo.length ? '' : ' disabled') + '>' + IC_REDO + '<span>Redo</span></button>' +
        '<button type="button" class="bb-ab' + (S.mirror ? ' on' : '') + '" data-act="mirror" aria-pressed="' + S.mirror + '" title="Mirror edits across the middle (M)">' + IC_MIRROR + '<span>Mirror</span></button>' +
        '<button type="button" class="bb-ab' + (S.save.fine ? ' on' : '') + '" data-act="grid" aria-pressed="' + S.save.fine + '" title="Grid: 1 m or 0.5 m (G)">' + IC_GRID + '<span>' + (S.save.fine ? '½ m' : '1 m') + '</span></button>' +
        '<button type="button" class="bb-ab" data-act="clear" title="Clear the design"' + (S.d.members.length ? '' : ' disabled') + '>' + IC_CLEAR + '<span>Clear</span></button>' +
        '<button type="button" class="bb-test" data-act="test" title="Test (Space)">' + IC_TEST + '<span>Test</span></button></div>';
    } else {
      h += '<div class="bb-row bb-legend"><span>stress</span><span class="bb-grad"></span><span>0 → 100%</span><span class="bb-sep"></span><span class="bb-veh">' + esc(vehiclesText(S.L)) + '</span></div>' +
        '<div class="bb-row bb-acts">' +
        '<button type="button" class="bb-ab" data-act="speed" title="Speed (F)">' + IC_FAST + '<span>x' + S.speed + '</span></button>' +
        '<button type="button" class="bb-ab" data-act="retry" title="Run again (R)">' + IC_RETRY + '<span>Again</span></button>' +
        '<button type="button" class="bb-test alt" data-act="edit" title="Back to edit (Space)">' + IC_EDIT + '<span>Edit</span></button></div>';
    }
    S.tools.innerHTML = h;
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.mode !== 'test' || S.resultShown;
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }
  function redraw() {
    if (!S || S.drawQ) return;
    if (S.raf) return;      // the loop draws
    S.drawQ = requestAnimationFrame(function () { if (S) { S.drawQ = 0; draw(1); } });
  }

  // ---- levels ----
  function loadLevel(i, intro) {
    stopLoop();
    S.li = clamp(i, 0, LEVELS.length - 1); S.L = LEVELS[S.li];
    var r = S.save.lv[S.L.id];
    S.d = decode(S.L, r && r.d);
    S.undo = []; S.redo = []; S.pend = null; S.drag = null; S.hover = null; S.loupe = null;
    S.mode = 'edit'; S.sim = null; S.paused = false; S.resultShown = false;
    S.save.cur = S.li; persistSoon();
    makeFx();
    layout();
    syncBar(); syncTools(); syncHead();
    showCard(intro ? 'intro' : null);
    redraw();
  }

  // ---- input ----
  function evPt(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (S.cw / (r.width || 1)), y: (e.clientY - r.top) * (S.ch / (r.height || 1)) };
  }
  function onDown(e) {
    if (!S || S.cardKind) return;
    if (S.mode === 'test') {         // a tap on the field pauses (touch suppresses the click)
      if (e.button > 0) return;
      e.preventDefault(); pause();
      return;
    }
    if (S.mode !== 'edit') return;
    if (e.button > 0) { if (e.button === 2) { S.pend = null; redraw(); } return; }
    e.preventDefault();
    S.snd.ensure();
    var p = evPt(e), wx = WX(p.x), wy = WY(p.y), touch = e.pointerType !== 'mouse';
    try { S.cv.setPointerCapture(e.pointerId); } catch (x) {}
    if (S.drag && S.drag.id !== e.pointerId) return;
    if (S.tool === 4) {
      var hit = hitAt(p.x, p.y);
      S.drag = { id: e.pointerId, erase: true, before: snapshot(), any: false };
      if (hit && eraseHit(hit)) { S.drag.any = true; S.snd.tone(180, 0.06, 'square', 0.03, 120); changed(); }
      return;
    }
    var st = startPoint(wx, wy);
    S.drag = { id: e.pointerId, start: st, cur: st, sx: p.x, sy: p.y, moved: false, touch: touch };
    if (touch) S.loupe = { x: p.x, y: p.y };
    redraw();
  }
  function onMove(e) {
    if (!S || S.mode !== 'edit' || S.cardKind) return;
    var p = evPt(e), wx = WX(p.x), wy = WY(p.y);
    if (S.drag && S.drag.id === e.pointerId) {
      if (S.drag.erase) {
        var hit = hitAt(p.x, p.y);
        if (hit && eraseHit(hit)) { S.drag.any = true; S.snd.tone(180, 0.05, 'square', 0.03, 120); changed(); }
        return;
      }
      if (!S.drag.moved && Math.hypot(p.x - S.drag.sx, p.y - S.drag.sy) > (S.drag.touch ? 9 : 5)) S.drag.moved = true;
      var from = S.drag.start;
      if (S.drag.moved && from) S.drag.cur = snapTarget(from, wx, wy, S.tool) || S.drag.cur;
      else if (!from) S.drag.cur = snapTarget(null, wx, wy, S.tool);
      if (S.drag.touch) S.loupe = { x: p.x, y: p.y };
      redraw();
      return;
    }
    if (e.pointerType === 'mouse' && !S.drag) {
      // hover: the snap point (and the preview from a pending start); erase highlights
      if (S.tool === 4) {
        var h = hitAt(p.x, p.y), mh = h && S.mirror ? mirrorOf(h) : null;
        S.hotMem = h && h.m != null ? h.m : -1; S.hotJ = h && h.j != null ? h.j : -1;
        S.hotMir = mh && mh.m != null ? mh.m : -1; S.hotJm = mh && mh.j != null ? mh.j : -1;
        S.hover = null;
      } else S.hover = S.pend ? snapTarget(S.pend, wx, wy, S.tool) : startPoint(wx, wy);
      redraw();
    }
  }
  function onUp(e) {
    if (!S || !S.drag || S.drag.id !== e.pointerId) return;
    var dr = S.drag;
    S.drag = null; S.loupe = null;
    if (e.type === 'pointercancel') { redraw(); return; }
    if (dr.erase) {
      if (dr.any) { S.undo.push(dr.before); if (S.undo.length > UNDO_MAX) S.undo.shift(); S.redo.length = 0; syncTools(); }
      redraw();
      return;
    }
    var st = dr.start;
    if (dr.moved && st && dr.cur && (dr.cur.hx !== st.hx || dr.cur.hy !== st.hy)) {
      place(st, dr.cur);
      S.pend = null;
    } else if (st) {
      // a tap: start a chain, extend it, or drop it
      if (S.pend && S.pend.hx === st.hx && S.pend.hy === st.hy) S.pend = null;
      else if (S.pend) { var tgt = snapTarget(S.pend, st.hx / 2, st.hy / 2, S.tool); if (tgt && place(S.pend, tgt)) S.pend = tgt; else S.pend = st; }
      else { S.pend = st; S.snd.tone(880, 0.03, 'sine', 0.02); }
    } else S.pend = null;
    redraw();
  }
  function isTyping(e) {
    var t = e.target;
    if (!t || t === document.body) return false;
    if (S.panel.contains(t)) return false;
    return !!(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }
  function onKey(e) {
    if (!S || !S.panel.isConnected) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    if (isTyping(e)) return;
    var k = (e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey, handled = true;
    if (mod) {
      if (k === 'z' && !e.shiftKey) doUndo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo();
      else return;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.altKey) return;
    var card = S.cardKind;
    if (card === 'intro' && /^[1-5mgex]$/.test(k)) { showCard(null); card = null; }
    if (k === 'escape') {
      if (card === 'help') showCard(S.helpBack || null);
      else if (card === 'levels' || card === 'intro') showCard(null);
      else if (card === 'pause') resume();
      else if (card === 'result') toEdit();
      else if (S.mode === 'test') toEdit();
      else if (S.pend) { S.pend = null; redraw(); }
      else handled = false;
    } else if (k === ' ' || k === 'enter') {
      // a focused button in the panel (a level, a card button) activates itself
      if (e.target && e.target.tagName === 'BUTTON' && S.panel.contains(e.target)) return;
      if (card === 'pause') resume();
      else if (card === 'intro' || card === 'help') showCard(null);
      else if (card === 'result') { if (S.res && S.res.win && S.res.stars && S.li + 1 < LEVELS.length) loadLevel(S.li + 1, true); else toEdit(); }
      else if (card === 'levels') loadLevel(S.li, true);
      else if (S.mode === 'edit') startTest();
      else toEdit();
    } else if (card) {
      handled = false;
    } else if (S.mode === 'edit' && k >= '1' && k <= '4') setTool(+k - 1);
    else if (S.mode === 'edit' && (k === 'e' || k === 'x' || k === '5' || k === 'delete' || k === 'backspace')) setTool(4);
    else if (S.mode === 'edit' && k === 'm') { S.mirror = !S.mirror; syncTools(); redraw(); }
    else if (S.mode === 'edit' && k === 'g') toggleGrid();
    else if (k === 'p' && S.mode === 'test') { if (S.paused) resume(); else pause(); }
    else if (k === 'r' && S.mode === 'test') retry();
    else if (k === 'f' && S.mode === 'test') cycleSpeed();
    else if (k === 'l') { if (S.mode === 'test') toEdit(); showCard('levels'); }
    else if (k === '?' || k === 'h') { S.helpBack = null; showCard('help'); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  function toggleGrid() { S.save.fine = !S.save.fine; persistSoon(); buildBg(); syncTools(); redraw(); }
  function cycleSpeed() { S.speed = S.speed >= 4 ? 1 : S.speed * 2; syncTools(); if (!S.raf) draw(1); }

  // ---- layout ----
  function availH(vh) {
    // measured from the parts (the panel itself may be clipped to the window)
    var r = S.panel.getBoundingClientRect(), hd = S.panel.querySelector('.cade-panel-head');
    var chrome = (hd ? hd.offsetHeight : 40) + (S.bar.offsetHeight || 30) + (S.tools.offsetHeight || 96) + 16 + 24;
    var top = S.panel.classList.contains('cade-solo-panel') ? 0 : Math.min(Math.max(0, r.top || 0), 140);
    return vh - top - chrome - 12;
  }
  function layout() {
    if (!S || !S.L) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var cw = Math.floor(Math.min(phone ? vw - 34 : solo ? Math.min(1180, vw - 60) : 720, vw - 34));
    var vb = viewBox(S.L), ww = vb.x1 - vb.x0, wh = vb.y1 - vb.y0;
    var ah = Math.max(200, availH(vh)), ch = Math.round(cw * wh / ww);
    ch = clamp(ch, phone ? 210 : 260, Math.max(phone ? 210 : 260, ah));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--bb-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / cw; S.cw = cw; S.ch = ch;
    var s = Math.min(cw / ww, (ch - 4) / wh, solo ? 64 : 56);
    ch = Math.max(phone ? 210 : 240, Math.min(ch, Math.ceil(wh * s + 4)));
    S.cv.style.height = ch + 'px'; S.stage.style.height = ch + 'px'; S.cv.height = Math.round(ch * dpr);
    S.v = { s: s, ox: (cw - ww * s) / 2 - vb.x0 * s, oy: (ch - wh * s) / 2 + vb.y1 * s };
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) { fitFont(); buildBg(); }
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    if (s.saveT) { clearTimeout(s.saveT); sset(SAVE_KEY, JSON.stringify(s.save)); }
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.drawQ) cancelAnimationFrame(s.drawQ);
    clearTimeout(s.resizeT); clearTimeout(s.toastT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.bg);
    freeCanvas(s.cv);
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
    var body = '<div class="bb"><div class="bb-bar"></div><div class="bb-stage"><canvas class="bb-cv" aria-label="Bridge Builder play field"></canvas>' +
      '<div class="bb-toast" aria-hidden="true"></div></div>' +
      '<div class="bb-tools"></div><div class="bb-live" aria-live="polite"></div><div class="bb-ovl" style="display:none"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🌉 Bridge Builder', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'bb-hb';
    hb.innerHTML = '<button type="button" data-h="levels" title="Levels (L)" aria-label="Levels">' + IC_LEVELS + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.bb'), stage: p.querySelector('.bb-stage'), cv: p.querySelector('.bb-cv'), ovl: p.querySelector('.bb-ovl'),
      bar: p.querySelector('.bb-bar'), tools: p.querySelector('.bb-tools'), liveEl: p.querySelector('.bb-live'), toastEl: p.querySelector('.bb-toast'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'), coarse: !!(mm && mm('(pointer: coarse)').matches),
      mode: 'edit', li: 0, L: null, d: null, sim: null, undo: [], redo: [], tool: 0, mirror: false, pend: null, drag: null, hover: null, loupe: null,
      hotMem: -1, hotMir: -1, hotJ: -1, hotJm: -1, speed: 1, paused: false, resultShown: false, raf: 0, drawQ: 0, last: 0, endT: 0, clock: 0, creakT: 0,
      pal: new Array(NPAL), col: null, atl: null, bg: null, k: 1, v: { s: 20, ox: 0, oy: 0 }, cw: 600, ch: 300, cardKind: null, saveT: 0
    };
    S.toast = function (t) {
      var el = S.toastEl;
      el.textContent = t; el.classList.add('on');
      clearTimeout(S.toastT);
      S.toastT = setTimeout(function () { if (S) S.toastEl.classList.remove('on'); }, 1400);
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    S.li = S.save.cur; S.L = LEVELS[S.li];
    if (!unlocked(S.save, S.li)) { S.li = 0; S.L = LEVELS[0]; }
    S.d = decode(S.L, S.save.lv[S.L.id] && S.save.lv[S.L.id].d);
    layout();
    readTheme();
    buildBg();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pause(); if (S.drag) { S.drag = null; S.loupe = null; redraw(); } } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); stopLoop();
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
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); buildBg(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header buttons (the header drags the panel — these are controls)
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
        if (S.cardKind === 'help') showCard(S.helpBack || null);
        else { if (S.mode === 'test' && !S.resultShown) { pause(); } S.helpBack = S.cardKind; showCard('help'); }
      } else if (h === 'levels') {
        if (S.cardKind === 'levels') showCard(null);
        else { if (S.mode === 'test') toEdit(); showCard('levels'); }
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerup', onUp);
    S.cv.addEventListener('pointercancel', onUp);
    S.cv.addEventListener('pointerleave', function (e) { if (S && e.pointerType === 'mouse' && !S.drag) { S.hover = null; S.hotMem = S.hotMir = S.hotJ = S.hotJm = -1; redraw(); } });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    S.tools.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      S.snd.ensure();
      var t = b.getAttribute('data-tool'), act = b.getAttribute('data-act');
      if (t != null) setTool(+t);
      else if (act === 'undo') doUndo();
      else if (act === 'redo') doRedo();
      else if (act === 'mirror') { S.mirror = !S.mirror; S.snd.tone(740, 0.04, 'sine', 0.025); syncTools(); redraw(); }
      else if (act === 'grid') toggleGrid();
      else if (act === 'clear') doClear();
      else if (act === 'test') startTest();
      else if (act === 'edit') toEdit();
      else if (act === 'retry') retry();
      else if (act === 'speed') cycleSpeed();
      var nb = e.detail === 0 && (t != null ? S.tools.querySelector('[data-tool="' + t + '"]') : act ? S.tools.querySelector('[data-act="' + act + '"]') : null);
      if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
    });
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var act = b.getAttribute('data-act'), lv = b.getAttribute('data-lv');
      if (lv != null) {
        var i = +lv;
        if (!unlocked(S.save, i)) { Cade.showToast && Cade.showToast('Cross level ' + i + ' to unlock this one', 'info', 1800); S.snd.tone(150, 0.08, 'square', 0.025); return; }
        S.snd.tone(660, 0.05, 'triangle', 0.03);
        loadLevel(i, true);
      } else if (act === 'play') loadLevel(S.li, true);
      else if (act === 'help') { S.helpBack = 'levels'; showCard('help'); }
      else if (act === 'close-help') showCard(S.helpBack || null);
      else if (act === 'build') { showCard(null); redraw(); }
      else if (act === 'levels') showCard('levels');
      else if (act === 'resume') resume();
      else if (act === 'edit') toEdit();
      else if (act === 'retry') retry();
      else if (act === 'next') loadLevel(S.li + 1, true);
    });

    syncBar(); syncTools(); syncHead();
    if (ld.fresh) { S.helpBack = 'intro'; showCard('help'); persist(); }
    else showCard(S.d.members.length ? null : 'intro');
    // measure again once the panel is laid out, and refit the glyphs when the mono font loads
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); draw(1); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); buildBg(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Build a truss from limited parts so the cart makes it across',
    icon: '🌉',
    tags: 'game,puzzle,physics,bridge,build,engineering',
    open: open,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
