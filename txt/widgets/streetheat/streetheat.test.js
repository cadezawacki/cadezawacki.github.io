/* Headless checks for the Street Heat engine (city, routes, driving, police, races, career, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/streetheat/streetheat.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

var E = require('./streetheat.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./streetheat.js')];
require('./streetheat.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function run(g, inp, secs, evs) {
  var n = Math.round(secs / E.STEP);
  for (var i = 0; i < n && !g.done && !g.busted; i++) {
    E.step(g, typeof inp === 'function' ? inp(g) : inp, E.STEP);
    if (evs) g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; });
    g.ev.length = 0;
  }
}
var IDLE = { steer: 0, gas: 0, brake: 0, hb: 0, nos: 0 };
// a racing driver for the player: the rivals' own route follower
function bot(g) {
  var P = g.player, k = P.ctl;
  if (!g.race || !g.race.R) return IDLE;
  if (!P.ai) P.ai = E.mkAI('race');
  E.raceAI(g, P, E.STEP);
  return { steer: k.steer, gas: k.gas, brake: k.brake, hb: k.hb, nos: k.nos };
}
function finite(c) { return isFinite(c.x) && isFinite(c.y) && isFinite(c.vx) && isFinite(c.vy) && isFinite(c.a) && isFinite(c.w); }

test('registers as a widget matching its manifest entry', function () {
  assert.ok(widget && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'streetheat.css');
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var m = (man.modules || man.widgets || []).filter(function (x) { return x.id === 'streetheat'; })[0];
  assert.ok(m, 'manifest entry');
  ['name', 'icon', 'tags', 'description'].forEach(function (k) { assert.strictEqual(widget[k], m[k], k); });
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('road lattice: ordered lines, consistent lookups, highways and a river', function () {
  for (var i = -40; i < 40; i++) {
    assert.ok(E.Xp(i + 1) - E.Xp(i) >= 55, 'column gap ' + i);
    assert.ok(E.Yp(i + 1) - E.Yp(i) >= 55, 'row gap ' + i);
    assert.strictEqual(E.colOf(E.Xp(i) + 0.5), i);
    assert.strictEqual(E.rowOf(E.Yp(i) + 0.5), i);
    assert.strictEqual(E.vline(i).t === 'hwy', E.mod(i, 10) === 3);
    assert.strictEqual(E.hline(i).t === 'hwy', E.mod(i, 9) === 4);
    var V = E.vline(i);
    if (V.t === 'blvd') assert.ok(V.A > 0, 'boulevards curve'); else assert.strictEqual(V.A, 0);
  }
  var rivers = 0, bridges = 0;
  for (var j = -30; j < 30; j++) if (E.isRiver(j)) {
    rivers++;
    for (var k = -20; k < 20; k++) { assert.strictEqual(E.hasV(k, j), E.bridge(k)); if (E.bridge(k)) bridges++; }
  }
  assert.ok(rivers >= 3 && bridges > 10);
  // every highway bridges the river
  for (var q = -40; q < 40; q++) if (E.vline(q).t === 'hwy') assert.ok(E.bridge(q));
});

test('blocks: deterministic, buildings inside the lots, roads clear of buildings', function () {
  var kinds = {};
  for (var bi = -12; bi < 12; bi++) for (var bj = -12; bj < 12; bj++) {
    var b = E.block(bi, bj);
    kinds[b.kind] = 1;
    b.blds.forEach(function (bd) {
      assert.ok(bd.x0 >= b.ix0 - 0.01 && bd.x1 <= b.ix1 + 0.01 && bd.y0 >= b.iy0 - 0.01 && bd.y1 <= b.iy1 + 0.01, 'building inside block ' + bi + ',' + bj);
      assert.ok(bd.h > 0);
    });
    b.props.forEach(function (p) { assert.ok(E.PSPEC[p.k], 'known prop ' + p.k); assert.ok(isFinite(p.x) && isFinite(p.y)); });
  }
  ['down', 'res', 'ind', 'park', 'water'].forEach(function (k) { assert.ok(kinds[k], 'district ' + k); });
  var a = JSON.stringify(E.block(3, 4).blds), b2;
  E.block(999, 999);
  b2 = JSON.stringify(E.block(3, 4).blds);
  assert.strictEqual(a, b2);
  // sample the centerlines: no building sits on a road
  for (var i = -8; i < 8; i++) for (var y = -600; y < 600; y += 7) {
    var j2 = E.rowOf(y);
    if (!E.hasV(i, j2)) continue;
    var x = E.vx(i, y), bl = E.blockAt(x, y);
    [bl, E.block(i - 1, j2), E.block(i, j2)].forEach(function (blk) { blk.blds.forEach(function (bd) { assert.ok(!(x > bd.x0 && x < bd.x1 && y > bd.y0 && y < bd.y1), 'building on line ' + i + ' at ' + y); }); });
  }
});

test('A* paths follow existing edges and never turn on an overpass', function () {
  var pairs = [[0, 0, 6, 5], [-4, 3, 5, -6], [2, 7, 2, 12], [-10, -3, 8, 9]];
  pairs.forEach(function (p) {
    var path = E.findPath(p[0], p[1], -1, p[2], p[3], 3000);
    assert.deepStrictEqual(path[0], [p[0], p[1]]);
    assert.deepStrictEqual(path[path.length - 1], [p[2], p[3]], 'reaches ' + p);
    for (var k = 1; k < path.length; k++) {
      var a = path[k - 1], b = path[k], dx = b[0] - a[0], dy = b[1] - a[1];
      assert.strictEqual(Math.abs(dx) + Math.abs(dy), 1, 'adjacent');
      if (dy) assert.ok(E.hasV(a[0], Math.min(a[1], b[1])), 'vertical edge exists');
      if (k + 1 < path.length && E.overpass(b[0], b[1])) {
        var c = path[k + 1];
        assert.strictEqual(c[0] - b[0] === 0, dx === 0, 'no turn on an overpass');
      }
    }
  });
});

test('routes: walks and loops are valid; dense points and corner speeds', function () {
  var r = E.mulberry32(7);
  for (var t = 0; t < 20; t++) {
    var w = E.routeWalk(r, t - 10, (t % 5) - 2, t % 4, 12);
    assert.ok(w && w.length === 13);
    var seen = {};
    w.forEach(function (n, k) {
      assert.ok(!seen[n], 'no revisits'); seen[n] = 1;
      if (k) { var a = w[k - 1]; assert.strictEqual(Math.abs(n[0] - a[0]) + Math.abs(n[1] - a[1]), 1); if (n[1] !== a[1]) assert.ok(E.hasV(n[0], Math.min(n[1], a[1]))); }
    });
    var R = E.denseRoute(w, false);
    assert.ok(R.L > 600 && R.N > 100);
    for (var q = 0; q < R.N; q++) assert.ok(R.vmax[q] > 5 && R.vmax[q] <= 99, 'vmax');
    var lp = E.routeLoop(r, t - 5, 0, 3, 2);
    assert.ok(lp && lp.length === 10, 'loop of 3x2 blocks');
    var RL = E.denseRoute(lp, true);
    assert.ok(Math.hypot(RL.xs[0] - RL.xs[RL.N - 1], RL.ys[0] - RL.ys[RL.N - 1]) < 12, 'loop closes');
  }
});

test('car physics: accelerates to its top speed, brakes, steers, handbrake slides', function () {
  var g = { rain: false, assist: 1, t: 0, ev: [] };
  var spec = E.CAR_BY.mantis, st = E.stats(spec), c = E.newCar(spec, st, 0, 0, 0, 'player');
  c.ctl.gas = 1;
  for (var i = 0; i < 60 * 20; i++) E.carPhys(g, c, E.STEP);
  assert.ok(c.vf > st.top * 0.93 && c.vf <= st.top * 1.01, 'top speed ' + c.vf + ' vs ' + st.top);
  assert.ok(Math.abs(c.y) < 0.01 && Math.abs(c.a) < 1e-6, 'straight');
  c.ctl.gas = 0; c.ctl.brake = 1;
  var n = 0;
  while (c.vf > 0.5 && n++ < 600) E.carPhys(g, c, E.STEP);
  assert.ok(n < 60 * 6, 'stops within 6 s from top speed');
  // steering turns, and at speed a handbrake makes the tail step out
  c = E.newCar(spec, st, 0, 0, 0, 'player'); c.vx = 25; c.ctl.gas = 0.5; c.ctl.steer = 1;
  for (i = 0; i < 30; i++) E.carPhys(g, c, E.STEP);
  assert.ok(c.a > 0.2, 'turned right (y down): ' + c.a);
  c.ctl.hb = 1;
  var maxSlip = 0;
  for (i = 0; i < 40; i++) { E.carPhys(g, c, E.STEP); maxSlip = Math.max(maxSlip, c.slip); }
  assert.ok(maxSlip > 3, 'sliding sideways ' + maxSlip);
  // nitro: faster than the top speed and drains the tank
  c = E.newCar(spec, st, 0, 0, 0, 'player'); c.vx = st.top; c.vf = st.top; c.ctl.gas = 1; c.ctl.nos = 1;
  for (i = 0; i < 120; i++) E.carPhys(g, c, E.STEP);
  assert.ok(c.vf > st.top * 1.02 && c.nosT < 0.8);
  // cars differ
  assert.ok(E.CAR_BY.phantom.top > E.CAR_BY.sparrow.top && E.CAR_BY.titan.m > E.CAR_BY.kestrel.m * 1.6);
  var up = E.stats(spec, { eng: 3, tire: 3, nos: 3, arm: 3 });
  assert.ok(up.acc > st.acc && up.top > st.top && up.grip > st.grip && up.dur > st.dur && up.cap > st.cap);
});

test('collisions: walls push cars out and hurt; heavier cars shove lighter ones', function () {
  var g = E.newGame({ mode: 'roam', diff: 1, car: { id: 'brute' }, traffic: 0, seed: 1 });
  g.noCops = true; g.patrols = 0; g.cars.length = 1;
  var P = g.player, bd = null;
  for (var k = 0; k < 50 && !bd; k++) { var b = E.block(k % 7, Math.floor(k / 7)); bd = b.blds.filter(function (q) { return q.h > 10 && q.x1 - q.x0 > 10 && q.y1 - q.y0 > 10; })[0]; }
  assert.ok(bd);
  P.x = bd.x0 - 12; P.y = (bd.y0 + bd.y1) / 2; P.a = 0; P.vx = 30; P.vy = 0; P.dmg = 0;
  var evs = {};
  run(g, { steer: 0, gas: 1, brake: 0, hb: 0, nos: 0 }, 2, evs);
  assert.ok(P.x < bd.x0 + 0.01, 'outside the building');
  assert.ok(P.dmg > 0.05, 'took damage ' + P.dmg);
  assert.ok(evs.hit > 0);
  // car vs car
  var spec = E.CAR_BY.titan, a = E.newCar(spec, E.stats(spec), 0, 0, 0, 'player'), lite = E.CAR_BY.sparrow, b2 = E.newCar(lite, E.stats(lite), 3.3, 0, Math.PI / 2, 'traffic');
  a.vx = 20;
  var g2 = { t: 0, ev: [], dmgK: 1 }, p0 = a.m * a.vx + b2.m * b2.vx;
  for (var i = 0; i < 10; i++) E.carCar(g2, a, b2);
  var p1 = a.m * a.vx + b2.m * b2.vx;
  assert.ok(Math.abs(p1 - p0) / p0 < 0.02, 'momentum kept');
  assert.ok(b2.vx > a.vx * 0.5 && a.vx < 20, 'shoved');
});

test('free roam: a minute of simulation stays finite; traffic and props live around the player', function () {
  var g = E.newGame({ mode: 'roam', diff: 1, car: { id: 'kestrel' }, traffic: 16, seed: 9 });
  var evs = {}, t = 0;
  run(g, function () { t++; return { steer: Math.sin(t / 70) * 0.6, gas: 1, brake: 0, hb: t % 400 < 30 ? 1 : 0, nos: t % 300 < 40 ? 1 : 0 }; }, 60, evs);
  g.cars.forEach(function (c) { assert.ok(finite(c), c.kind + ' finite'); });
  var tr = g.cars.filter(function (c) { return c.kind === 'traffic'; });
  assert.ok(tr.length > 6, 'traffic around ' + tr.length);
  tr.forEach(function (c) { assert.ok(Math.max(Math.abs(c.x - g.player.x), Math.abs(c.y - g.player.y)) < 260); });
  assert.ok(g.props.length > 50);
});

test('traffic keeps to lanes and stops at red lights', function () {
  var g = E.newGame({ mode: 'roam', diff: 1, car: { id: 'sparrow' }, traffic: 24, seed: 4 });
  g.noCops = true; g.patrols = 0; g.dbg = [];
  var ranRed = 0, checks = 0, inside = {};
  for (var s = 0; s < 60 * 60; s++) {
    E.step(g, IDLE, E.STEP); g.ev.length = 0;
    g.cars.forEach(function (c) {
      if (c.kind !== 'traffic') return;
      var ni = E.nodeAt(c.x, c.y, -0.5), was = inside[c.id];
      inside[c.id] = !!ni;
      if (!ni || was || was == null || c.hitT > 0 || c.dead || !E.signaled(ni[0], ni[1])) return;
      checks++;               // just entered a signaled box: was its light red for a while?
      var ax = Math.abs(c.vx) > Math.abs(c.vy) ? 0 : 1;
      if (E.light(ni[0], ni[1], g.t, ax) === 2 && E.light(ni[0], ni[1], g.t - 1.5, ax) === 2 && Math.hypot(c.vx, c.vy) > 3) ranRed++;
    });
  }
  assert.ok(checks > 20, 'cars crossed intersections ' + checks);
  assert.ok(ranRed / checks < 0.08, 'red light runs ' + ranRed + '/' + checks);
  var crashes = g.dbg.filter(function (d) { return d.k === 'traffic' && d.o === 'traffic' && d.sp > 5; }).length;
  assert.ok(crashes < 16, 'traffic pile-ups ' + crashes);
});

test('heat: levels, a pursuit when seen, busted when boxed in, evading out of sight', function () {
  assert.strictEqual(E.heatLvl(0), 0); assert.strictEqual(E.heatLvl(10), 1); assert.strictEqual(E.heatLvl(500), 5);
  // stopped right in front of a cop while wanted: pursuit, then busted
  var g = E.newGame({ mode: 'roam', diff: 1, car: { id: 'sparrow' }, traffic: 0, seed: 2 });
  g.patrols = 0;
  var P = g.player, spec = E.COPS[0], cop = E.newCar(spec, E.stats(spec), P.x + Math.cos(P.a) * 7, P.y + Math.sin(P.a) * 7, P.a + Math.PI, 'cop');
  cop.ai = E.mkAI('patrol'); E.snapLane(cop); g.cars.push(cop);
  g.heat.pts = 20;
  var evs = {};
  run(g, IDLE, 8, evs);
  assert.ok(evs.pursuit, 'pursuit started');
  assert.ok(g.busted && evs.busted, 'busted');
  // out of sight long enough: evaded
  var g2 = E.newGame({ mode: 'roam', diff: 1, car: { id: 'sparrow' }, traffic: 0, seed: 2 });
  g2.patrols = 0; g2.noCops = false;
  g2.heat.pts = 15; g2.heat.st = 'chase'; g2.heat.lastSeen = 0;
  var cs = 0, ev2 = {};
  for (var i = 0; i < 60 * 40 && !ev2.evaded; i++) {
    E.step(g2, IDLE, E.STEP);
    g2.cars = g2.cars.filter(function (c) { return c.kind !== 'cop'; });       // nobody is looking
    g2.ev.forEach(function (e) { ev2[e.t] = 1; }); g2.ev.length = 0; cs++;
  }
  assert.ok(ev2.cool && ev2.evaded, 'evaded');
  assert.strictEqual(g2.heat.st, 'none');
  // infractions raise heat faster while chased
  var g3 = E.newGame({ mode: 'roam', diff: 2, car: { id: 'sparrow' }, traffic: 0, seed: 2 });
  g3.heat.pts = 50; g3.heat.st = 'chase'; g3.heat.lastSeen = 1e9;
  run(g3, IDLE, 5);
  assert.ok(g3.heat.pts > 55 && g3.heat.bounty > 0);
});

test('police at high heat: more units, roadblocks with spikes, a helicopter', function () {
  var g = E.newGame({ mode: 'roam', diff: 1, car: { id: 'mantis' }, traffic: 0, seed: 11 });
  var P = g.player;
  P.ai = E.mkAI('lane'); E.snapLane(P);
  g.heat.pts = 360; g.heat.st = 'chase'; g.heat.lastSeen = 1e9; g.heat.rbT = 0;
  var evs = {};
  for (var i = 0; i < 60 * 12 && !g.busted; i++) {
    E.laneAI(g, P, E.STEP, 30, false);
    var k = P.ctl;
    E.step(g, { steer: k.steer, gas: k.gas, brake: k.brake, hb: 0, nos: 0 }, E.STEP);
    g.heat.lastSeen = g.t; P.dmg = 0; g.heat.bust = 0;
    g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; }); g.ev.length = 0;
  }
  assert.strictEqual(g.heat.lvl, 5);
  assert.ok(g.cars.filter(function (c) { return c.kind === 'cop'; }).length >= 4, 'units');
  assert.ok(evs.heli && g.heat.heli, 'helicopter');
  assert.ok(evs.roadblock, 'roadblock');
  assert.ok(g.heat.spikes.length >= 1, 'spike strip');
});

test('events: every type builds deterministically; career ladder and daily run', function () {
  ['sprint', 'circuit', 'drift', 'speedtrap', 'outrun', 'escape'].forEach(function (t) {
    for (var tier = 0; tier < 10; tier += 3) {
      var a = E.makeEvent(t, 500 + tier, tier), b = E.makeEvent(t, 500 + tier, tier);
      assert.deepStrictEqual(a, b, t + ' deterministic');
      if (t !== 'escape') assert.ok(a.nodes && a.nodes.length > 4, t + ' route');
      assert.ok(a.reward > 0);
      assert.strictEqual(a.rivals.length, t === 'outrun' ? 1 : t === 'drift' || t === 'escape' ? 0 : 3);
    }
  });
  assert.strictEqual(E.RIVALS.length, 10);
  var names = {};
  E.RIVALS.forEach(function (R, i) {
    assert.ok(!names[R.name]); names[R.name] = 1;
    assert.ok(E.CAR_BY[R.car]);
    var ev = E.careerEvents(i);
    assert.ok(ev.length >= 3 && ev[ev.length - 1].boss === i);
  });
  var d1 = E.dailyEvent('2026-11-26'), d2 = E.dailyEvent('2026-11-26'), d3 = E.dailyEvent('2026-11-27');
  assert.deepStrictEqual(d1, d2);
  assert.ok(d1.seed !== d3.seed);
  assert.strictEqual(E.dailyKey(new Date(2026, 0, 5)), '2026-01-05');
  var mk = 0;
  for (var i = -20; i < 20; i++) for (var j = -20; j < 20; j++) if (E.markerAt(i, j)) mk++;
  assert.ok(mk > 20 && mk < 200, 'race markers ' + mk);
});

test('races: countdown, rivals race the route, results are ranked', function () {
  var ev = E.makeEvent('sprint', 101, 2);
  var g = E.newGame({ mode: 'event', diff: 1, car: { id: 'kestrel' }, ev: ev, traffic: 0, seed: 3 });
  g.noCops = true; g.E.cops = false;
  assert.strictEqual(g.phase, 'count');
  var evs = {};
  run(g, IDLE, 3.2, evs);
  assert.strictEqual(evs.beep, 2); assert.strictEqual(evs.go, 1);
  assert.strictEqual(g.race.racers.length, 4);
  run(g, bot, 150, evs);
  assert.ok(g.done && g.result, 'finished');
  var fin = g.race.racers.filter(function (c) { return c.rc.fin >= 0; }).length;
  assert.ok(fin >= 3, 'racers finished: ' + fin);
  assert.ok(evs.cp >= g.race.cps.length - 1);
  var order = g.race.racers.slice().sort(E.rankCmp(g));
  assert.strictEqual(order.indexOf(g.player) + 1, E.placeOf(g, g.player));
  // a circuit counts laps
  var ec = E.makeEvent('circuit', 77, 1), gc = E.newGame({ mode: 'event', diff: 0, car: { id: 'mantis' }, ev: ec, traffic: 0, seed: 3 });
  gc.noCops = true; gc.E.cops = false;
  run(gc, bot, 240);
  assert.ok(gc.done && gc.player.rc.next === gc.race.cps.length && gc.player.rc.lap >= ec.laps - 1, 'laps ' + gc.player.rc.lap);
  // drift zone ends on the clock
  var ed = E.makeEvent('drift', 5, 0), gd = E.newGame({ mode: 'event', diff: 1, car: { id: 'sparrow' }, ev: ed, traffic: 0, seed: 3 });
  gd.noCops = true; gd.E.cops = false;
  run(gd, IDLE, ed.time + 5);
  assert.ok(gd.done && gd.result.type === 'drift' && !gd.result.win);
});

test('saves: sanitized, purchases, busts and impound, career progress', function () {
  var s = E.normSave({ cash: 'lots', cars: ['nope', 'brute'], car: 'brute', upg: { brute: { eng: 9, tire: -2 } }, set: { diff: 7, cam: 'north', units: 'mph' }, career: { beaten: 99 } });
  assert.strictEqual(s.cash, 1500);
  assert.deepStrictEqual(s.cars, ['sparrow', 'brute']);
  assert.strictEqual(s.upg.brute.eng, 3); assert.strictEqual(s.upg.brute.tire, 0);
  assert.strictEqual(s.set.diff, 1); assert.strictEqual(s.set.cam, 'north'); assert.strictEqual(s.set.units, 'mph');
  assert.strictEqual(s.career.beaten, 10);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  var sv = E.newSave();
  sv.cash = 100000;
  assert.ok(!E.buyCar(sv, 'kestrel'), 'locked until rival #10 is beaten');
  sv.career.beaten = 1;
  assert.ok(E.buyCar(sv, 'kestrel') && sv.car === 'kestrel' && sv.cash === 100000 - E.CAR_BY.kestrel.cost);
  var c0 = sv.cash;
  assert.ok(E.buyUpg(sv, 'eng') && sv.upg.kestrel.eng === 1 && sv.cash === c0 - E.upgCost('kestrel', 0));
  assert.ok(E.buyPaint(sv, 3) && sv.paint.kestrel === 3);
  assert.deepStrictEqual(E.carDesc(sv).col, E.PAINTS[3].col);
  // three busts impound the car when there is another one
  var b;
  for (var i = 0; i < 3; i++) b = E.applyBust(sv, 500);
  assert.ok(b.impound && sv.impound.kestrel && sv.car === 'sparrow');
  assert.ok(E.release(sv, 'kestrel') && !sv.impound.kestrel);
  // career: win the rival's events, then the one-on-one
  var cv = E.newSave(), nx = E.careerNext(cv);
  assert.ok(nx.events[nx.events.length - 1].locked);
  nx.events.slice(0, -1).forEach(function (e) { E.careerAward(cv, { key: e.key }, { win: true, place: 1, type: e.type }, E.makeEvent(e.type, e.seed, e.tier)); });
  nx = E.careerNext(cv);
  assert.ok(!nx.events[nx.events.length - 1].locked);
  var boss = nx.events[nx.events.length - 1], out = E.careerAward(cv, { key: boss.key, boss: boss.boss }, { win: true, place: 1, type: boss.type }, E.makeEvent(boss.type, boss.seed, boss.tier, { boss: boss.boss }));
  assert.ok(out.beat && cv.career.beaten === 1 && out.cash > 0);
  assert.ok(E.carUnlocked(cv, 'kestrel'));
  assert.strictEqual(E.evReward({ reward: 1000 }, { win: false, place: 2 }), 350);
  assert.ok(E.evBetter('drift', 10, 5) && E.evBetter('sprint', 5, 10) && E.evBetter('sprint', 5, null));
  assert.strictEqual(E.fmtTime(83.456), '1:23.46');
});

test('touch steering: the thumb stick is the default; old "buttons" defaults migrate once', function () {
  var f = E.newSave();
  assert.strictEqual(f.set.touch, 'stick');
  assert.strictEqual(f.set.stickMig, 1);
  assert.strictEqual(f.set.autogas, null, 'auto gas stays opt-in');
  var old = E.normSave({ set: { touch: 'buttons', assist: 2 } });
  assert.strictEqual(old.set.touch, 'stick', 'the old default moves to the stick');
  assert.strictEqual(old.set.stickMig, 1);
  assert.strictEqual(old.set.assist, 2);
  assert.strictEqual(E.normSave({ set: { touch: 'stick' } }).set.touch, 'stick');
  var mine = E.normSave(old); mine.set.touch = 'buttons';
  var back = E.normSave(JSON.parse(JSON.stringify(mine)));
  assert.strictEqual(back.set.touch, 'buttons', 'a deliberate choice of buttons sticks');
  assert.strictEqual(back.set.stickMig, 1);
  assert.strictEqual(E.normSave({ set: { touch: 'wheel', stickMig: 1 } }).set.touch, 'stick');
  assert.strictEqual(E.normSave({ cash: 5 }).set.touch, 'stick');
  assert.deepStrictEqual(E.TOUCHES, ['stick', 'buttons']);
});

test('thumb stick response: dead zone, full lock, odd, monotonic, finer near center', function () {
  assert.strictEqual(E.stickCurve(0), 0);
  assert.strictEqual(E.stickCurve(0.05), 0);
  assert.strictEqual(E.stickCurve(NaN), 0);
  assert.strictEqual(E.stickCurve(E.STICK_FULL), 1);
  assert.strictEqual(E.stickCurve(-3), -1);
  var prev = 0;
  for (var x = 0; x <= 1.0001; x += 0.02) {
    var v = E.stickCurve(x);
    assert.ok(v >= prev - 1e-12 && Math.abs(E.stickCurve(-x) + v) < 1e-12, 'monotonic and odd at ' + x);
    prev = v;
  }
  assert.ok(E.stickCurve(0.5) < (0.5 - E.STICK_DEAD) / (E.STICK_FULL - E.STICK_DEAD), 'softer than linear mid-travel');
});

test('analog steering turns proportionally; no gas, no motion', function () {
  var g = { rain: false, assist: 1, t: 0, ev: [] }, spec = E.CAR_BY.sparrow, st = E.stats(spec);
  function turn(steer) {
    var c = E.newCar(spec, st, 0, 0, 0, 'player'); c.vx = 18; c.ctl.gas = 0.5; c.ctl.steer = steer;
    for (var i = 0; i < 30; i++) E.carPhys(g, c, E.STEP);
    return c.a;
  }
  var full = turn(1), part = turn(E.stickCurve(0.6)), zero = turn(0);
  assert.ok(full > part && part > 0.02 && Math.abs(zero) < 1e-6, 'proportional: ' + [full, part, zero].join(' '));
  assert.ok(turn(-1) < 0);
  var c = E.newCar(spec, st, 0, 0, 0, 'player'); c.ctl.steer = 1;
  for (var i = 0; i < 60 * 5; i++) E.carPhys(g, c, E.STEP);
  assert.ok(Math.hypot(c.vx, c.vy) < 1e-9 && c.x === 0 && c.y === 0, 'stick alone does not move the car');
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
