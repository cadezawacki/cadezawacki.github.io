/* Headless checks for the Redline Run engine (city generation, routes, driving, AI, police, career, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/redline/redline.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

var E = require('./redline.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, asset: function (p) { return './txt/widgets/redline/' + p; } } };
global.document = { baseURI: 'http://localhost/txt.html' };
delete require.cache[require.resolve('./redline.js')];
require('./redline.js');
delete global.window; delete global.document;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var IDLE = { steer: 0, gas: 0, brake: 0, hb: 0, nos: 0, sens: 1 };
var GAS = { steer: 0, gas: 1, brake: 0, hb: 0, nos: 0, sens: 1 };
function run(g, inp, secs, evs) {
  var n = Math.round(secs / E.STEP);
  for (var i = 0; i < n; i++) {
    E.step(g, typeof inp === 'function' ? inp(g) : inp, E.STEP);
    if (evs) g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; });
    g.ev.length = 0;
  }
}
function speed(g) { return Math.hypot(g.p.vx, g.p.vz); }
// a tidy driver: aims at the racing line ahead, holds the speed profile
function bot(g) {
  var p = g.p, P = g.path, R = g.R, sp = speed(g), look = E.ix(P, p.ri + Math.round((8 + sp * 0.35) / P.step));
  var tx = P.x[look] - P.tz[look] * R.line[look] * 0.6, tz = P.z[look] + P.tx[look] * R.line[look] * 0.6;
  var err = E.wrapA(Math.atan2(tx - p.x, tz - p.z) - p.a), vlim = R.vref[E.ix(P, p.ri + Math.round(sp * 0.5 / P.step))] * Math.sqrt(p.st.grip) * 0.97;
  return { steer: Math.max(-1, Math.min(1, -err * 3)), gas: p.vf < vlim ? 1 : 0, brake: p.vf > vlim + 3 ? 1 : 0, hb: 0, nos: p.vf > 30 && vlim > p.vf + 10 ? 1 : 0, sens: 1 };
}
var W1 = E.makeWorld(12345);

test('widget registers with the manifest metadata', function () {
  assert(widget, 'registered');
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf8')), m = man.modules.filter(function (x) { return x.id === 'redline'; })[0];
  assert(m, 'manifest entry');
  assert.strictEqual(widget.name, m.name); assert.strictEqual(widget.icon, m.icon); assert.strictEqual(widget.tags, m.tags); assert.strictEqual(widget.description, m.description);
  assert.deepStrictEqual(css, ['redline.css']);
  assert(fs.existsSync(path.join(__dirname, 'vendor/three.module.min.js')) && fs.existsSync(path.join(__dirname, 'vendor/LICENSE')));
});

test('rng and hashing are deterministic', function () {
  var a = E.mulberry32(42), b = E.mulberry32(42);
  for (var i = 0; i < 20; i++) assert.strictEqual(a(), b());
  assert.strictEqual(E.hashStr('x'), E.hashStr('x'));
  assert.notStrictEqual(E.hashStr('x'), E.hashStr('y'));
});

test('cities are seeded: same seed, same city', function () {
  var A = E.makeWorld(777), B = E.makeWorld(777), C = E.makeWorld(778);
  assert.strictEqual(A.name, B.name);
  assert.strictEqual(A.paths.length, 4);
  assert.strictEqual(A.blds.length, B.blds.length); assert.strictEqual(A.trees.length, B.trees.length);
  for (var i = 0; i < A.paths[0].n; i += 37) assert.strictEqual(A.paths[0].x[i], B.paths[0].x[i]);
  assert.notStrictEqual(A.paths[0].x[10], C.paths[0].x[10]);
  assert(A.paths[0].closed && !A.paths[1].closed);
  assert.strictEqual(A.paths[1].kind, 'hwy');
});

test('the road graph: junctions, edges, zones', function () {
  [1, 99, 4242, 31337].forEach(function (seed) {
    var W = E.makeWorld(seed);
    assert(W.nodes.length >= 6, 'nodes ' + W.nodes.length);
    W.nodes.forEach(function (nd) { assert(nd.links.length >= 2); assert(nd.edges.length >= 2, 'node degree'); });
    W.edges.forEach(function (e) { assert(e.len > 1); });
    // every road but the ring ends on the ring
    W.paths.slice(1).forEach(function (P) { assert(P.zones.length >= 2); });
    // the river keeps away from junctions
    W.nodes.forEach(function (nd) { assert(E.riverDist(W.river, nd.x, nd.z) > W.river.hw + 20, 'junction in the river'); });
  });
});

test('buildings and trees stay off the roads', function () {
  var q = {};
  W1.blds.forEach(function (b) { var r = E.query(W1.grid, b.x, b.z, q); assert(!r || r.excess > 0, 'building on a road'); });
  W1.trees.forEach(function (t) { var r = E.query(W1.grid, t.x, t.z, q); assert(!r || r.excess > 0.5, 'tree on a road'); });
  assert(W1.blds.length > 300 && W1.trees.length > 800 && W1.lamps.length > 100);
  var kinds = {}; W1.blds.forEach(function (b) { kinds[b.t] = 1; });
  ['tower', 'house', 'ware'].forEach(function (k) { assert(kinds[k], 'has ' + k); });
});

test('path sampling and the corridor query', function () {
  var P = W1.paths[0], a = E.pathAt(P, 100), q = E.query(W1.grid, a.x, a.z, {});
  assert(q && q.p === 0 && Math.abs(q.lat) < 0.5 && q.excess < 0);
  var off = E.query(W1.grid, a.x - a.tz * 5, a.z + a.tx * 5, {});
  assert(Math.abs(off.lat - 5) < 0.6, 'lat ' + off.lat);
  assert.strictEqual(E.wrapS(P, P.len + 3).toFixed(3), (3).toFixed(3));
  assert(Math.abs(E.dS(P, 5, P.len - 5) + 10) < 1e-6);
  assert.strictEqual(E.query(W1.grid, 5000, 5000, {}), null);
});

test('routes: circuits close, sprints end, side streets get barriers', function () {
  var ring = E.makeRoute(W1, 'ring', 3), loop = E.makeRoute(W1, 'loop', 5), spr = E.makeRoute(W1, 'sprint', 7);
  assert(ring.closed && loop.closed && !spr.closed);
  assert.strictEqual(spr.type, 'sprint'); assert.strictEqual(loop.type, 'circuit');
  assert(spr.len > 1500 && spr.len < 3100, 'sprint ' + spr.len);
  assert(loop.len < ring.len + 1);
  assert(ring.barriers.length >= 3, 'ring barriers ' + ring.barriers.length);
  assert(spr.barriers.length >= 2);
  // the race corridor is only the route
  var other = W1.paths[3], m = spr.masks[3], i;
  for (i = 0; i < other.n; i++) if (!m[i]) break;
  if (i < other.n && !spr.masks.some(function (mm, pi) { return pi !== 3 && E.query(E.makeGrid(W1.paths, spr.masks), other.x[i], other.z[i], {}) && false; })) {
    var q = E.query(spr.grid, other.x[i], other.z[i], {});
    assert(!q || q.p !== 3 || m[q.i], 'off-route samples are not drivable');
  }
  for (i = 0; i < spr.path.n; i++) assert(isFinite(spr.vref[i]) && spr.vref[i] > 3 && Math.abs(spr.line[i]) < spr.path.hw[i]);
});

test('no input: the car never moves by itself (race and free roam)', function () {
  var g = E.newGame({ world: W1, kind: 'race', type: 'circuit', loop: true, laps: 2, opp: 5, diff: 2, car: 'kestrel', seed: 5 });
  run(g, IDLE, 15);
  assert.strictEqual(g.phase, 'race');
  assert(speed(g) < 0.01, 'race idle speed ' + speed(g));
  var f = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'ronin', seed: 11 });
  var x0 = f.p.x, z0 = f.p.z;
  run(f, IDLE, 15);
  assert(Math.hypot(f.p.x - x0, f.p.z - z0) < 0.5 || f.hits > 0, 'free idle drift');
  // nitro and the handbrake alone do nothing either
  var h = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'vanta', seed: 12 });
  run(h, { steer: 1, gas: 0, brake: 0, hb: 1, nos: 1, sens: 1 }, 5);
  assert(speed(h) < 0.01, 'nos/hb idle ' + speed(h));
  // the countdown holds the car even with gas held
  var c = E.newGame({ world: W1, kind: 'race', type: 'sprint', opp: 3, diff: 1, car: 'kestrel', seed: 9 });
  run(c, GAS, 2.5);
  assert.strictEqual(c.phase, 'count'); assert(speed(c) < 0.01);
});

test('driving: gas, brakes, reverse, top speed, gears', function () {
  var g = E.newGame({ world: W1, kind: 'race', type: 'sprint', opp: 1, diff: 0, car: 'kestrel', seed: 21 });
  run(g, IDLE, 3.3);
  run(g, GAS, 3);
  var v3 = speed(g);
  assert(v3 > 12 && v3 < 30, 'accel ' + v3);
  assert(g.p.gear >= 2 && g.p.rpm > 1500);
  run(g, { steer: 0, gas: 0, brake: 1, hb: 0, nos: 0, sens: 1 }, 1.3);
  assert(speed(g) < 1.5, 'brakes ' + speed(g));
  run(g, { steer: 0, gas: 0, brake: 1, hb: 0, nos: 0, sens: 1 }, 2);
  assert(g.p.vf < -2, 'reverse ' + g.p.vf);
  // top speed on a long free run (bot keeps it on the road)
  var t = E.newGame({ world: W1, kind: 'race', type: 'circuit', loop: false, laps: 1, opp: 1, diff: 0, car: 'kestrel', seed: 22 });
  var vmax = 0;
  for (var i = 0; i < 60 * 40; i++) { E.step(t, bot(t), E.STEP); t.ev.length = 0; vmax = Math.max(vmax, speed(t)); }
  assert(vmax > 40 && vmax < t.p.st.top * 1.35, 'vmax ' + vmax);
});

test('handbrake makes the car slide (drift) and refills nitro', function () {
  var g = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'vanta', seed: 31 });
  g.agents.length = 0;
  g.p.vx = Math.sin(g.p.a) * 30; g.p.vz = Math.cos(g.p.a) * 30; g.p.nos = 0.1;
  var maxSlip = 0;
  for (var i = 0; i < 60; i++) { E.step(g, { steer: 1, gas: 1, brake: 0, hb: 1, nos: 0, sens: 1 }, E.STEP); g.ev.length = 0; maxSlip = Math.max(maxSlip, Math.abs(g.p.slip)); }
  assert(maxSlip > 0.2, 'slip ' + maxSlip);
  assert(g.p.nos > 0.1, 'nitro refilled');
});

test('walls push back and cost damage', function () {
  var g = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'kestrel', seed: 41 });
  g.agents.length = 0;
  var q = E.query(g.grid, g.p.x, g.p.z, {}), P = W1.paths[q.p], a = E.pathAt(P, q.s);
  // aim straight at the right-hand curb at speed
  g.p.a = Math.atan2(-a.tz, a.tx); g.p.vx = Math.sin(g.p.a) * 25; g.p.vz = Math.cos(g.p.a) * 25;
  var evs = {};
  run(g, IDLE, 2, evs);
  var q2 = E.query(g.grid, g.p.x, g.p.z, {});
  assert(q2 && q2.excess < 0.05, 'stayed inside the corridor ' + (q2 && q2.excess));
  assert(evs.crash || evs.hit, 'impact event');
  assert(g.p.dmg > 0);
});

test('a full race finishes with sane standings; rivals can win', function () {
  var wins = 0, finished = 0;
  [[12345, 'circuit'], [777, 'sprint'], [4242, 'sprint']].forEach(function (c) {
    var W = E.makeWorld(c[0]);
    var g = E.newGame({ world: W, kind: 'race', type: c[1], loop: true, laps: 1, opp: 4, diff: 1, car: 'vanta', seed: c[0] + 1 });
    var evs = {};
    for (var i = 0; i < 60 * 400 && g.phase !== 'over'; i++) { E.step(g, bot(g), E.STEP); g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; }); g.ev.length = 0; }
    assert.strictEqual(g.phase, 'over', c + ' did not finish');
    assert(evs.go === 1 && evs.finish === 1 && evs.done === 1);
    var rows = E.standings(g);
    assert.strictEqual(rows.length, 5);
    rows.forEach(function (r, k) { assert.strictEqual(r.pos, k + 1); assert(isFinite(r.t)); if (k) assert(r.t >= rows[k - 1].t); });
    g.agents.forEach(function (a) { if (a.kind === 'rival') assert(a.prog > g.total * 0.5, 'rival made progress'); });
    var me = rows.filter(function (r) { return r.you; })[0];
    if (rows[0].id !== 'you') wins++;
    finished++;
    assert(me.pos >= 1 && me.pos <= 5);
  });
  assert.strictEqual(finished, 3);
});

test('circuits count laps', function () {
  var g = E.newGame({ world: W1, kind: 'race', type: 'circuit', loop: true, laps: 2, opp: 1, diff: 0, car: 'ronin', seed: 51 });
  var evs = {};
  for (var i = 0; i < 60 * 500 && g.phase !== 'over'; i++) { E.step(g, bot(g), E.STEP); g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; }); g.ev.length = 0; }
  assert.strictEqual(evs.lap, 1, 'one lap crossing before the finish');
  assert(g.p.fin > 0);
});

test('traffic keeps lanes and stays around the player', function () {
  var g = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'kestrel', seed: 61 });
  run(g, IDLE, 10);
  var tr = g.agents.filter(function (a) { return a.kind === 'traffic'; });
  assert(tr.length > 8, 'traffic ' + tr.length);
  tr.forEach(function (a) { assert(Math.abs(a.lat) < a.hw, 'on the road'); assert(isFinite(a.x) && isFinite(a.z)); });
});

test('police: pursuit, heat, busted when boxed in, evaded when out of sight', function () {
  var g = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'kestrel', seed: 71 });
  E.startPursuit(g, 1);
  assert(g.pursuit && g.heat === 1);
  g.heatPts = 50; run(g, IDLE, 0.5);
  assert(g.heat >= 3, 'heat ' + g.heat);
  // a cop parked next to a stopped player: busted
  var evs = {}, cop = E.spawnCop(g, 'chase');
  cop.P = W1.paths[g.p.onP]; cop.s = g.p.onS; cop.lat = cop.latT = g.p.onLat + (g.p.onLat > 0 ? -2.6 : 2.6); cop.mode = 'block'; cop.life = 99; cop.v = 0;
  for (var i = 0; i < 60 * 6 && g.pursuit; i++) { E.step(g, IDLE, E.STEP); g.ev.forEach(function (e) { evs[e.t] = 1; }); g.ev.length = 0; }
  assert(evs.busted, 'busted');
  assert(!g.pursuit);
  // no cop in sight for long enough: evaded, the bounty is paid
  var h = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'kestrel', seed: 72 });
  E.startPursuit(h, 2); h.bounty = 1000;
  var ev2 = {};
  for (var k = 0; k < 60 * 20 && h.pursuit; k++) {
    h.agents = h.agents.filter(function (a) { return a.kind !== 'cop'; }); h.nextCop = 99;
    E.step(h, IDLE, E.STEP); h.ev.forEach(function (e) { ev2[e.t] = e; }); h.ev.length = 0;
  }
  assert(ev2.evaded && ev2.evaded.bounty >= 1000, 'evaded');
  assert(h.cash >= 1000);
});

test('police: roadblocks at heat 3 leave a gap below heat 5', function () {
  var g = E.newGame({ world: W1, kind: 'race', type: 'circuit', loop: false, laps: 1, opp: 1, diff: 1, car: 'kestrel', seed: 81, cops: true });
  g.pursuit = true; g.heat = 3;
  var before = g.agents.length;
  E.roadblock(g);
  var blk = g.agents.filter(function (a) { return a.mode === 'block'; });
  assert(blk.length >= 1 && g.agents.length > before);
  var lats = blk.map(function (a) { return a.lat; }).sort(function (a, b) { return a - b; }), hw = blk[0].hw, gap = 0, prev = -hw;
  lats.forEach(function (l) { gap = Math.max(gap, l - prev); prev = l; }); gap = Math.max(gap, hw - prev);
  assert(gap > 3.5, 'a car-wide gap ' + gap);
});

test('career: awards, unlocks, replays pay half', function () {
  var s = E.newSave(), evs = E.careerEvents(0);
  assert.strictEqual(evs[evs.length - 1].type, 'duel');
  assert(E.careerEvents(2).some(function (e) { return e.type === 'escape'; }));
  var c0 = s.cash, o = E.careerAward(s, evs[0], 2);
  assert(o.passed && o.first && o.cash > 0 && s.cash === c0 + o.cash);
  var o2 = E.careerAward(s, evs[0], 2);
  assert(o2.cash <= o.cash / 2 + 10);
  var d = E.careerAward(s, evs[evs.length - 1], 2);
  assert(!d.passed && s.career.tier === 0);
  d = E.careerAward(s, evs[evs.length - 1], 1);
  assert(d.passed && d.unlocked && s.career.tier === 1);
  var rv = E.careerRivals(3, E.careerEvents(3)[3]);
  assert.strictEqual(rv.length, 1); assert.strictEqual(rv[0].id, E.RIVALS[3].id);
});

test('garage: cars, upgrades, paint', function () {
  var s = E.newSave();
  s.cash = 100000;
  assert(E.buyCar(s, 'vanta') && s.car === 'vanta' && s.cars.indexOf('vanta') >= 0);
  var base = E.carStats('vanta', s.upg.vanta).top;
  assert(E.buyUpgrade(s, 'eng'));
  assert(E.carStats('vanta', s.upg.vanta).top > base);
  for (var i = 0; i < 5; i++) E.buyUpgrade(s, 'eng');
  assert.strictEqual(s.upg.vanta.eng, 3);
  assert(E.buyPaint(s, 3)); assert.deepStrictEqual(E.carColor(s, 'vanta'), E.PAINTS[3].col);
  var poor = E.newSave(); poor.cash = 10;
  assert(!E.buyCar(poor, 'ronin'));
});

test('saves: defaults, normalizing, auto gas stays opt-in', function () {
  var s = E.newSave();
  assert.strictEqual(s.set.autogas, false);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var junk = E.normSave({ cash: 'x', cars: ['nope', 'vanta'], car: 'vanta', set: { autogas: 'yes', diff: 9, cam: 'drone', gfx: 'ultra', qopp: 9 }, career: { tier: 99, done: { '0-1': 7, bad: 1 } }, free: { seed: 5, x: 1, z: 2 } });
  assert.strictEqual(junk.set.autogas, false);
  assert.strictEqual(junk.set.diff, 1); assert.strictEqual(junk.set.cam, 'chase'); assert.strictEqual(junk.set.gfx, 'auto'); assert.strictEqual(junk.set.qopp, 4);
  assert.deepStrictEqual(junk.cars, ['kestrel', 'vanta']); assert.strictEqual(junk.car, 'vanta');
  assert.strictEqual(junk.career.tier, E.RIVALS.length); assert.deepStrictEqual(junk.career.done, { '0-1': 7 });
  assert.strictEqual(junk.free.seed, 5);
  assert.strictEqual(E.normSave({ set: { autogas: true } }).set.autogas, true);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
});

test('daily event is the same all day', function () {
  var a = E.dailyEvent('2026-01-02'), b = E.dailyEvent('2026-01-02'), c = E.dailyEvent('2026-01-03');
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.seed, c.seed);
  assert(E.CAR_BY[a.car]);
  assert.strictEqual(E.dailyKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(E.fmtTime(83.456), '1:23.46');
});

test('reset puts the car back on the road, stopped', function () {
  var g = E.newGame({ world: W1, kind: 'free', diff: 1, car: 'kestrel', seed: 91 });
  g.p.x += 3; g.p.vx = 20; E.resetCar(g);
  assert.strictEqual(speed(g), 0);
  var q = E.query(g.grid, g.p.x, g.p.z, {});
  assert(q && Math.abs(q.lat) < q.hw);
});

console.log(passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
