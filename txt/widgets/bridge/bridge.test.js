/* Headless checks for the Bridge Builder engine (editing, costs, physics, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/bridge/bridge.test.js */
'use strict';
var assert = require('assert');

var E = require('./bridge.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, asset: function (p) { return p; } } };
delete require.cache[require.resolve('./bridge.js')];
require('./bridge.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// Reference designs: plain trusses (Pratt / Warren above or below the road, fans
// from the extra anchors, cables from the towers), cheapest passing one first.
function makeGen(E) {
  function P(x, y) { return { hx: Math.round(x * 2), hy: Math.round(y * 2) }; }
  function deckY(L, x) { return L.R * x / L.S; }
  // kind: over | under | cable ; h: truss depth ; web/chord: material ids
  function truss(L, kind, h, chord, web, road, tie) {
    tie = tie == null ? 2 : tie;
    var d = E.newDesign(L), S = L.S, x, ok = true;
    road = road == null ? 0 : road;
    function add(a, b, m) { if (!E.addMember(L, d, a, b, m)) { ok = false; } }
    for (x = 0; x < S; x += 2) add(P(x, deckY(L, x)), P(x + 2, deckY(L, x + 2)), road);
    if (kind === 'fan') {
      if (L.anchors.length < 3) return null;
      L.anchors.slice(2).forEach(function (a) {
        for (var xx = 2; xx < S; xx += 2) { var q = P(xx, deckY(L, xx)); if (E.hlen(a.hx, a.hy, q.hx, q.hy) <= E.MATS[chord].max && !E.canPlace(L, d, a, q, chord)) add(a, q, chord); }
      });
      return ok ? d : null;
    }
    if (kind === 'cable') {
      var tw = L.anchors.filter(function (a) { return a.hy / 2 > 2; });
      if (!tw.length) return null;
      for (x = 2; x < S; x += 2) {
        var best = null, bd = 1e9;
        tw.forEach(function (t) { var dd = Math.abs(t.hx / 2 - x); if (dd < bd) { bd = dd; best = t; } });
        add(P(x, deckY(L, x)), best, 3);
        if (web != null && x + 2 < S) { /* stiffener */ }
      }
      if (h) { // a second cable to the other tower where in reach
        for (x = 2; x < S; x += 2) tw.forEach(function (t) {
          if (E.hlen(t.hx, t.hy, x * 2, Math.round(deckY(L, x) * 2)) <= 12 && E.memberBetween(d, E.jointAt(d, t.hx, t.hy), E.jointAt(d, x * 2, Math.round(deckY(L, x) * 2))) < 0) add(P(x, deckY(L, x)), t, 3);
        });
      }
      return ok ? d : null;
    }
    var sg = kind === 'over' || kind === 'wover' ? 1 : -1;
    if (kind === 'wover' || kind === 'wunder') {
      var W = function (x) { return P(x, deckY(L, x) + sg * h); };
      for (x = 1; x < S; x += 2) { add(P(x - 1, deckY(L, x - 1)), W(x), web); add(W(x), P(x + 1, deckY(L, x + 1)), web); if (x + 2 < S) add(W(x), W(x + 2), chord); }
      tieAnchors();
      return ok ? d : null;
    }
    function T(x) { return P(x, deckY(L, x) + sg * h); }
    for (x = 2; x < S - 2; x += 2) add(T(x), T(x + 2), chord);
    for (x = 2; x <= S - 2; x += 2) add(T(x), P(x, deckY(L, x)), web);
    add(P(0, 0), T(2), chord); add(T(S - 2), P(S, L.R), chord);
    for (x = 2; x <= S - 2; x += 2) {
      if (x < S / 2) add(T(x), P(x + 2, deckY(L, x + 2)), web);
      else if (x > S / 2) add(T(x), P(x - 2, deckY(L, x - 2)), web);
    }
    tieAnchors();
    return ok ? d : null;
    function tieAnchors() {
    L.anchors.slice(2).forEach(function (a) {
      var cands = [];
      d.joints.forEach(function (j, i) { if (!j.anchor) cands.push({ j: j, dd: E.hlen(a.hx, a.hy, j.hx, j.hy) }); });
      cands.sort(function (p, q) { return p.dd - q.dd; });
      var n = 0;
      cands.forEach(function (c) { if (n < 2 && E.addMember(L, d, a, c.j, tie)) n++; });
    });
    }
  }
  function best(L) {
    var opts = [], kinds = ['fan', 'over', 'under', 'wover', 'wunder', 'cable'], hs = [1, 1.5, 2, 2.5, 3];
    kinds.forEach(function (k) {
      if (k === 'fan') { [1, 2].forEach(function (m) { var d = truss(L, k, 0, m); if (d) opts.push({ k: k, h: 0, cw: [m], d: d }); }); return; }
      if (k === 'cable') { [0, 1].forEach(function (h) { var d = truss(L, k, h); if (d) opts.push({ k: k, h: h, d: d }); }); return; }
      hs.forEach(function (h) {
        [[1, 1], [2, 1], [2, 2], [1, 2]].forEach(function (cw) {
          [[0, 1], [0, 2]].forEach(function (r) { var d = truss(L, k, h, cw[0], cw[1], r[0], r[1]); if (d) opts.push({ k: k, h: h, cw: cw.concat(r), d: d }); });
        });
      });
    });
    opts.forEach(function (o) { o.c = E.cost(o.d); });
    opts.sort(function (a, b) { return a.c - b.c; });
    for (var i = 0; i < opts.length; i++) { var r = E.simulate(L, opts[i].d); if (r.win) { opts[i].r = r; return opts[i]; } }
    return null;
  }
  return { truss: truss, best: best, P: P };
}
var Gn = makeGen(E), P = Gn.P;
function roadOnly(L) {
  var d = E.newDesign(L);
  for (var x = 0; x < L.S; x += 2) assert.ok(E.addMember(L, d, P(x, L.R * x / L.S), P(x + 2, L.R * (x + 2) / L.S), E.MAT.road));
  return d;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Bridge Builder' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'bridge.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('levels: 15+, unique ids, sane budgets and anchors', function () {
  assert.ok(E.LEVELS.length >= 15);
  var ids = {};
  E.LEVELS.forEach(function (L, i) {
    assert.ok(!ids[L.id]); ids[L.id] = 1;
    assert.strictEqual(L.i, i);
    assert.ok(L.p3 < L.p2 && L.p2 < L.budget, L.id + ' star costs');
    assert.ok(L.anchors.length >= 2 && L.anchors[0].hx === 0 && L.anchors[1].hx === L.S * 2);
    assert.ok(L.v.length >= 1 && L.v.every(function (v) { return E.VEHICLES[v.t]; }));
    assert.ok(L.yMin < 0 && L.yMax > 0 && L.waterY < L.yMin);
  });
  // the spans and the traffic grow overall
  var first = E.LEVELS[0], last = E.LEVELS[E.LEVELS.length - 1];
  assert.ok(last.S > first.S * 3 && last.budget > first.budget * 5);
});

test('editing: snap points, ground, lengths, re-material, mirror, removal', function () {
  var L = E.LEVELS[0], d = E.newDesign(L);
  assert.strictEqual(d.joints.length, 2);
  assert.ok(E.validPt(L, 4, 0) && !E.validPt(L, -2, -2) && !E.validPt(L, 4, (L.yMax + 1) * 2));
  assert.strictEqual(E.canPlace(L, d, P(0, 0), P(4, 0), E.MAT.road), 'long');
  assert.strictEqual(E.canPlace(L, d, P(0, 0), P(0, 0), E.MAT.road), 'same');
  assert.strictEqual(E.canPlace(L, d, P(0, 0), P(-1, -1), E.MAT.wood), 'ground');
  assert.ok(E.addMember(L, d, P(0, 0), P(2, 0), E.MAT.road));
  assert.ok(!E.addMember(L, d, P(2, 0), P(0, 0), E.MAT.road), 'same member again');
  assert.ok(E.addMember(L, d, P(2, 0), P(0, 0), E.MAT.steel), 're-material');
  assert.strictEqual(d.members.length, 1); assert.strictEqual(d.members[0].m, E.MAT.steel);
  var m = E.mirrorPt(L, P(1, 1));
  assert.deepStrictEqual(m, P(3, 1));
  assert.ok(E.addMember(L, d, P(2, 0), P(4, 0), E.MAT.road) && E.addMember(L, d, P(2, 0), P(2, 1.5), E.MAT.wood));
  assert.strictEqual(d.joints.length, 4);
  var j = E.jointAt(d, 4, 3);
  assert.ok(j >= 2 && E.removeJoint(d, j) && d.joints.length === 3 && d.members.length === 2);
  assert.ok(!E.removeJoint(d, 0), 'anchors stay');
  assert.ok(E.removeMember(d, 0));
  assert.strictEqual(d.joints.length, 3, 'the middle joint is still used by the other road');
  assert.ok(E.removeMember(d, 0));
  assert.strictEqual(d.joints.length, 2, 'orphan joints are pruned');
  d.members.forEach(function (mm) { assert.ok(mm.a < d.joints.length && mm.b < d.joints.length); });
});

test('costs: per metre by material plus joints', function () {
  var L = E.LEVELS[0], d = E.newDesign(L);
  E.addMember(L, d, P(0, 0), P(2, 0), E.MAT.road);
  assert.strictEqual(E.cost(d), 2 * E.MATS[E.MAT.road].cost + E.JOINT_COST);
  E.addMember(L, d, P(2, 0), P(4, 0), E.MAT.road);
  E.addMember(L, d, P(0, 0), P(2, 2), E.MAT.wood);
  assert.strictEqual(E.cost(d), Math.round(4 * 200 + 2 * E.JOINT_COST + Math.sqrt(8) * E.MATS[E.MAT.wood].cost));
  assert.deepStrictEqual(E.counts(d), [2, 1, 0, 0]);
  assert.strictEqual(E.starsFor(L, L.p3, true), 3);
  assert.strictEqual(E.starsFor(L, L.p3 + 1, true), 2);
  assert.strictEqual(E.starsFor(L, L.budget, true), 1);
  assert.strictEqual(E.starsFor(L, L.budget + 1, true), 0);
  assert.strictEqual(E.starsFor(L, 10, false), 0);
});

test('a bare road snaps on every level; no road at all drops the cart', function () {
  E.LEVELS.forEach(function (L) {
    var r = E.simulate(L, roadOnly(L));
    assert.ok(!r.win && r.reason === 'fell' && r.broken > 0, L.id + ' road only: ' + r.reason);
  });
  var r0 = E.simulate(E.LEVELS[0], E.newDesign(E.LEVELS[0]));
  assert.ok(!r0.win && r0.reason === 'fell' && r0.broken === 0);
});

test('every level has a passing reference truss within its 3-star cost', function () {
  E.LEVELS.forEach(function (L) {
    var b = Gn.best(L);
    assert.ok(b, L.id + ': no reference design passes');
    assert.ok(b.c <= L.p3, L.id + ': reference $' + b.c + ' > 3-star $' + L.p3);
    assert.ok(b.r.maxRatio < 1 && b.r.broken === 0);
  });
});

test('a good bridge holds still', function () {
  var L = E.LEVELS[2], d = Gn.truss(L, 'over', 2, 1, 1), s = E.newSim(L, d), i;
  s.veh.forEach(function (v) { v.x = -80; });
  for (i = 0; i < 480; i++) E.stepSim(s);
  for (i = 0; i < s.n; i++) {
    assert.ok(Math.hypot(s.x[i] - d.joints[i].hx / 2, s.y[i] - d.joints[i].hy / 2) < 0.05, 'sag at joint ' + i);
    assert.ok(Math.hypot(s.vx[i], s.vy[i]) < 0.01, 'still moving at joint ' + i);
  }
});

test('a mechanism (no diagonals) folds; adding them makes it rigid', function () {
  var L = E.LEVELS[3], d = E.newDesign(L), x;
  for (x = 0; x < L.S; x += 2) E.addMember(L, d, P(x, 0), P(x + 2, 0), E.MAT.road);
  for (x = 0; x < L.S; x += 2) E.addMember(L, d, P(x, 2), P(x + 2, 2), E.MAT.steel);
  for (x = 0; x <= L.S; x += 2) E.addMember(L, d, P(x, 0), P(x, 2), E.MAT.steel);
  assert.ok(!E.simulate(L, d).win, 'a box frame folds');
  var r = E.simulate(L, Gn.truss(L, 'over', 2, 2, 2));
  assert.ok(r.win, 'the trussed one holds');
});

test('heavier traffic needs a stronger bridge', function () {
  var L = E.LEVELS[9], wood = Gn.truss(L, 'under', 1, 1, 1);
  assert.ok(!E.simulate(L, wood).win, 'an all-wood truss fails under the truck');
  var light = Object.assign({}, L, { v: [{ t: 'cart' }] });
  assert.ok(E.simulate(light, wood).win, 'the same truss carries a cart');
});

test('cables only pull', function () {
  var L = E.LEVELS[6], d = Gn.truss(L, 'cable', 0);
  var r = E.simulate(L, d);
  assert.ok(r.win);
  r.sim.mem.forEach(function (m) { if (m.cable) assert.ok(m.f > -1, 'cable in compression'); });
});

test('simulation is deterministic', function () {
  var L = E.LEVELS[10], d = Gn.best(L).d;
  var a = E.simulate(L, d).sim, b = E.simulate(L, E.cloneDesign(d)).sim;
  assert.strictEqual(a.t, b.t);
  for (var i = 0; i < a.n; i++) { assert.strictEqual(a.x[i], b.x[i]); assert.strictEqual(a.y[i], b.y[i]); }
});

test('advance() is frame-rate independent', function () {
  var L = E.LEVELS[4], d = Gn.best(L).d, s60 = E.newSim(L, d), s144 = E.newSim(L, d), i;
  for (i = 0; i < 120; i++) E.advance(s60, 1 / 60);
  for (i = 0; i < 288; i++) E.advance(s144, 1 / 144);
  assert.ok(Math.abs(s60.steps - s144.steps) <= 1);
  assert.ok(Math.abs(s60.veh[0].x - s144.veh[0].x) < 0.03);
  var a = E.advance(s60, 0.004);
  assert.ok(a >= 0 && a <= 1);
});

test('a steep road stalls the traffic', function () {
  var L = E.LEVELS[0], d = E.newDesign(L);
  E.addMember(L, d, P(0, 0), P(1, 2), E.MAT.road);
  E.addMember(L, d, P(1, 2), P(3, 3), E.MAT.road);
  E.addMember(L, d, P(0, 0), P(3, 3), E.MAT.steel);
  E.addMember(L, d, P(3, 3), P(4, 0), E.MAT.steel);
  E.addMember(L, d, P(1, 2), P(4, 0), E.MAT.steel);
  var r = E.simulate(L, d);
  assert.ok(!r.win && r.reason === 'steep', r.reason);
});

test('encode / decode round trip and save normalisation', function () {
  var L = E.LEVELS[11], d = Gn.best(L).d;
  var enc = JSON.parse(JSON.stringify(E.encode(L, d)));
  var back = E.decode(L, enc);
  assert.strictEqual(E.cost(back), E.cost(d));
  assert.strictEqual(back.members.length, d.members.length);
  var bad = E.decode(L, { j: [[1, 1], 'x', [999, 999]], m: [[0, 2, 0], [0, 3, 0], [0, 1, 9], [5, 6, 1], 'nope', [0, 99, 1]] });
  assert.ok(bad.members.length <= 1);
  assert.strictEqual(E.decode(L, null).members.length, 0);
  var s = E.newSave();
  var rec = E.record(s, E.LEVELS[0], 1500, true);
  assert.ok(rec.first && rec.stars === 3 && s.lv.l01.done && s.lv.l01.c === 1500);
  assert.ok(E.unlocked(s, 1) && !E.unlocked(s, 2));
  rec = E.record(s, E.LEVELS[0], 1800, true);
  assert.ok(rec.stars === 2 && s.lv.l01.st === 3 && s.lv.l01.c === 1500, 'keeps the best');
  rec = E.record(s, E.LEVELS[1], 99999, true);
  assert.ok(rec.overBudget && rec.stars === 0 && !E.unlocked(s, 2), 'over budget does not count');
  s.lv.l01.d = enc;
  assert.strictEqual(E.totalStars(s), 3);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(n.lv.l01.st, 3);
  var weird = E.normSave({ cur: 99, lv: { l01: { st: 7, c: -4, done: true, d: 'junk' }, zz: {} }, fine: 1 });
  assert.ok(weird.cur === E.LEVELS.length - 1 && weird.lv.l01.st === 3 && weird.lv.l01.c === 0 && weird.lv.l01.d === null && !weird.lv.zz && weird.fine === true);
  assert.deepStrictEqual(E.normSave('nope'), E.newSave());
});

test('a road that stops short, or a deck of cable, drops the traffic', function () {
  var L = E.LEVELS[0], d = E.newDesign(L);
  E.addMember(L, d, P(0, 0), P(2, 0), E.MAT.road);
  E.addMember(L, d, P(0, 0), P(1, -1.5), E.MAT.steel); E.addMember(L, d, P(1, -1.5), P(2, 0), E.MAT.steel);
  var r = E.simulate(L, d);
  assert.ok(!r.win && r.reason === 'fell', 'half a road: ' + r.reason);
  var c = E.newDesign(L);
  E.addMember(L, c, P(0, 0), P(4, 0), E.MAT.cable);
  r = E.simulate(L, c);
  assert.ok(!r.win && r.reason === 'fell', 'cable is no road: ' + r.reason);
});

test('fuzz: random designs stay finite and always reach a verdict', function () {
  var seed = 12345, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (var it = 0; it < 90; it++) {
    var L = E.LEVELS[it % E.LEVELS.length], d = E.newDesign(L), x, k;
    for (x = 0; x < L.S; x += 2) E.addMember(L, d, P(x, L.R * x / L.S), P(x + 2, L.R * (x + 2) / L.S), E.MAT.road);
    for (k = 0; k < 30; k++) {
      var j = d.joints[(rnd() * d.joints.length) | 0], q = { hx: j.hx + Math.round((rnd() - 0.5) * 10), hy: j.hy + Math.round((rnd() - 0.5) * 10) };
      E.addMember(L, d, j, q, (rnd() * 4) | 0);
    }
    d.members.forEach(function (m) { assert.ok(E.memLen(d, m) <= E.MATS[m.m].max + 1e-9, 'over-long member'); });
    var r = E.simulate(L, d);
    assert.ok(r.sim.phase !== 'run', L.id + ': no verdict');
    for (var i = 0; i < r.sim.n; i++) assert.ok(isFinite(r.sim.x[i]) && isFinite(r.sim.y[i]), L.id + ': NaN joint');
    var back = E.decode(L, JSON.parse(JSON.stringify(E.encode(L, d))));
    assert.strictEqual(E.cost(back), E.cost(d), 'round trip keeps the cost');
  }
});

test('convoys keep their distance on the bridge', function () {
  var L = E.LEVELS[12], d = Gn.best(L).d, s = E.newSim(L, d), minGap = 1e9;
  while (s.phase === 'run') {
    E.stepSim(s); s.events.length = 0;
    var a = s.veh[0], b = s.veh[1];
    if (b.state === 'drive') minGap = Math.min(minGap, a.x - (b.x + b.V.axles[b.V.axles.length - 1]));
  }
  assert.strictEqual(s.phase, 'win');
  assert.ok(minGap > 2, 'gap ' + minGap);
});

test('mirroring across an uneven gap never builds into the ground', function () {
  var L = E.LEVELS[7], d = E.newDesign(L);   // far bank 2 m higher
  var p = P(1, -1), q = P(2, -2), mp = E.mirrorPt(L, p), mq = E.mirrorPt(L, q);
  assert.deepStrictEqual(E.mirrorPt(L, mp), p, 'mirror twice is identity');
  assert.ok(!E.canPlace(L, d, p, q, E.MAT.wood));
  assert.strictEqual(E.canPlace(L, d, P(L.S - 0.5, 1), P(L.S + 1, 1), E.MAT.wood), 'ground');
  void mq;
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
