/* Headless checks for the Apex Rush engine (tracks, driving, traffic, rivals, career, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/povracer/povracer.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

var E = require('./povracer.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./povracer.js')];
require('./povracer.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function drain(g) { var o = {}; g.ev.forEach(function (e) { (o[e.t] = o[e.t] || []).push(e); }); g.ev.length = 0; return o; }
function run(g, inp, secs, evs) {
  var n = Math.round(secs / E.STEP);
  for (var i = 0; i < n && g.phase !== 'done'; i++) {
    E.step(g, typeof inp === 'function' ? inp(g) : inp, E.STEP);
    if (evs) g.ev.forEach(function (e) { evs[e.t] = (evs[e.t] || 0) + 1; });
    g.ev.length = 0;
  }
}
var GAS = { steer: 0, gas: 1, brake: 0, nos: 0, sens: 1 };
var IDLE = { steer: 0, gas: 0, brake: 0, nos: 0, sens: 1 };
// a tidy driver: holds the racing line, brakes for bends, dodges cars, uses nitro on straights
function bot(g) {
  var p = g.p, si = Math.floor(p.z / E.SEG), maxC = 0, tx = 0;
  for (var k = 0; k < 16; k++) maxC = Math.max(maxC, Math.abs(E.segAt(g.T, si + k).c));
  var cap = maxC > 0.4 ? Math.min(1, 1 / (maxC * E.CF * p.st.grip)) : 1, sp = p.v / p.st.top;
  for (var i = 0; i < g.cars.length; i++) { var c = g.cars[i], d = E.relZ(g, c); if (d > 0 && d < E.SEG * 12 && Math.abs(c.x - p.x) < 0.45) tx = c.x > 0 ? c.x - 0.6 : c.x + 0.6; }
  return { steer: Math.max(-1, Math.min(1, E.autoSteer(g) + (tx - p.x) * 2)), gas: sp < cap ? 1 : 0, brake: sp > cap + 0.08 ? 1 : 0, nos: sp > 0.5 && maxC < 1 ? 1 : 0, sens: 1 };
}
// a flat, straight endless game with no traffic
function flatGame() {
  var g = E.newEndless({ seed: 5, diff: 1 });
  g.cars.length = 0;
  g.D = { name: 'T', ai: 1, traffic: 0, bonus: 1, time0: 999 }; g.timeLeft = 999;
  g.phase = 'race'; g.countT = 0;
  g.T.segs.forEach(function (s) { s.c = 0; s.y1 = s.y2 = 0; s.spr = null; s.tun = 0; });
  g.T.rng = function () { return 0.1; };       // keep generating straight-ish road
  return g;
}

test('rng is deterministic', function () {
  var a = E.mulberry32(42), b = E.mulberry32(42);
  for (var i = 0; i < 20; i++) assert.strictEqual(a(), b());
  var r = E.mulberry32(7), v = r();
  assert(v >= 0 && v < 1);
});

test('loop tracks: seeded, closed, start line', function () {
  var o = { seed: 1234, loop: true, biome: 2, len: 1800, curveK: 0.8, hillK: 0.8, tunnels: 0.1 };
  var A = E.newTrack(o), B = E.newTrack(o);
  assert.strictEqual(A.n, B.n);
  assert(A.n > 1500 && A.n < 2300, 'length ' + A.n);
  for (var i = 0; i < A.n; i++) { assert.strictEqual(A.segs[i].c, B.segs[i].c); assert.strictEqual(A.segs[i].y1, B.segs[i].y1); }
  assert.strictEqual(A.segs[0].y1, 0);
  assert(Math.abs(A.segs[A.n - 1].y2) < 1e-6, 'height closes the loop');
  for (i = 1; i < A.n; i++) assert(Math.abs(A.segs[i].y1 - A.segs[i - 1].y2) < 1e-6, 'continuous heights at ' + i);
  assert(A.segs[0].fin && A.segs[2].fin);
  assert(A.segs[0].spr.some(function (s) { return s.k === 'gate'; }));
  assert.strictEqual(E.segAt(A, A.n + 5), A.segs[5]);
  assert.strictEqual(E.segAt(A, -1), A.segs[A.n - 1]);
  assert(A.segs.some(function (s) { return Math.abs(s.c) > 2; }), 'has real bends');
  assert(A.segs.some(function (s) { return s.y1 !== 0; }), 'has hills');
});

test('cup tracks and rivals are stable', function () {
  for (var c = 0; c < E.CUPS.length; c++) {
    for (var t = 0; t < E.CUPS[c].n; t++) {
      var a = E.cupTrack(c, t), b = E.cupTrack(c, t);
      assert.deepStrictEqual(a, b);
      assert(a.name && a.name.indexOf(' ') > 0);
    }
    var r = E.cupRivals(c);
    assert.strictEqual(r.length, E.CUPS[c].rivals);
    assert.deepStrictEqual(r.map(function (d) { return d.id; }), E.cupRivals(c).map(function (d) { return d.id; }));
    assert.strictEqual(new Set(r.map(function (d) { return d.id; })).size, r.length);
  }
});

test('endless track generates ahead, trims behind, changes biome per checkpoint', function () {
  var T = E.newTrack({ seed: 99, loop: false, biome: 0 });
  var s = E.segAt(T, E.CP_LEN * 3 + 10);
  assert(s && s.i === E.CP_LEN * 3 + 10);
  assert.strictEqual(E.segAt(T, E.CP_LEN).cp, 1);
  assert.strictEqual(E.segAt(T, E.CP_LEN + 1).cp, 0);
  assert.notStrictEqual(E.segAt(T, 10).b, E.segAt(T, E.CP_LEN + 10).b);
  assert.strictEqual(E.segAt(T, E.CP_LEN * 3 + 10).b, 3);
  assert.strictEqual(E.segAt(T, E.CP_LEN * 3 + 10).n, 1, 'the city is at night');
  // old road is dropped as the player moves on (step() trims)
  var g = E.newEndless({ seed: 3, diff: 1 });
  g.phase = 'race'; g.countT = 0;
  g.p.z = E.SEG * 3000;
  E.step(g, IDLE, E.STEP);
  assert(g.T.base > 0, 'old road dropped');
  assert(g.T.segs.length < 3000);
  assert.strictEqual(E.segAt(g.T, 3005).i, 3005);
});

test('countdown, then go', function () {
  var g = E.newEndless({ seed: 1, diff: 1 }), ev = {};
  run(g, GAS, 1.5, ev);
  assert.strictEqual(g.phase, 'count');
  assert.strictEqual(g.p.v, 0, 'held at the line');
  run(g, GAS, 2, ev);
  assert.strictEqual(g.phase, 'race');
  assert.strictEqual(ev.beep, 3);
  assert.strictEqual(ev.go, 1);
});

test('accelerates to top speed, coasts, brakes', function () {
  var g = flatGame(), st = g.p.st;
  run(g, GAS, 1);
  var v1 = g.p.v;
  assert(v1 > st.top * 0.15, 'quick off the line');
  run(g, GAS, 14);
  assert(g.p.v > st.top * 0.97 && g.p.v <= st.top * 1.0001, 'top speed ' + g.p.v / st.top);
  var vt = g.p.v;
  run(g, IDLE, 1);
  assert(g.p.v < vt && g.p.v > vt * 0.7, 'coasting');
  run(g, { steer: 0, gas: 0, brake: 1, nos: 0 }, 1.5);
  assert(g.p.v < vt * 0.1, 'brakes stop the car');
  assert(g.p.gear >= 1 && g.p.gear <= 6);
});

test('nitro: faster than top speed, drains, refills', function () {
  var g = flatGame(), st = g.p.st, ev = {};
  run(g, GAS, 14);
  run(g, { steer: 0, gas: 1, brake: 0, nos: 1 }, 1.5, ev);
  assert(g.p.v > st.top * 1.08, 'boosted ' + g.p.v / st.top);
  assert(g.p.nos < 0.7);
  assert.strictEqual(ev.nos, 1);
  run(g, { steer: 0, gas: 1, brake: 0, nos: 1 }, 10);
  assert(g.p.nos < 0.13, 'empty');
  var evN = {};
  run(g, { steer: 0, gas: 1, brake: 0, nos: 1 }, 1, evN);
  assert(!evN.nos, 'no sputtering on an empty tank');
  run(g, GAS, 3);
  assert(g.p.v <= st.top * 1.001, 'back to top speed when it runs out');
  assert(g.p.nos > 0.05, 'refilling');
});

test('curves pull the car outward; steering into the bend holds the line', function () {
  var g = flatGame();
  run(g, GAS, 14);
  g.T.segs.forEach(function (s) { s.c = 4; });
  var x0 = g.p.x;
  run(g, GAS, 0.5);
  assert(g.p.x < x0 - 0.2, 'pushed to the outside ' + g.p.x);
  var g2 = flatGame();
  run(g2, GAS, 14);
  g2.T.segs.forEach(function (s) { s.c = 2.5; });
  run(g2, { steer: 1, gas: 1, brake: 0, nos: 0 }, 1);
  assert(g2.p.x > -0.4, 'held ' + g2.p.x);
});

test('off the road: slow and shaky', function () {
  var g = flatGame();
  run(g, GAS, 14);
  g.p.x = 1.6;
  run(g, GAS, 3);
  assert(g.p.off);
  assert(g.p.v < g.p.st.top * 0.45, 'off-road speed ' + g.p.v / g.p.st.top);
});

test('crashing into a roadside prop spins the car and kills speed', function () {
  var g = flatGame(), ev = {};
  run(g, GAS, 14);
  var si = Math.floor(g.p.z / E.SEG);
  for (var k = 3; k < 40; k++) { var s = E.segAt(g.T, si + k); s.spr = [{ k: 'rock', o: 1.5, hw: E.SPR.rock.w * E.SPR.rock.hit / E.RW, f: 1, v: 0 }]; }
  g.p.x = 1.5;
  var v0 = g.p.v;
  run(g, GAS, 0.6, ev);
  assert(ev.crash >= 1, 'crash event');
  assert(g.p.v < v0 * 0.6);
});

test('rear-ending a car slows you; tucking in behind gives a slipstream', function () {
  var g = flatGame(), ev = {};
  run(g, GAS, 14);
  var c = E.newCar({ kind: 'sedan', z: g.p.z + E.SEG * 6, x: 0, top: E.V_BASE * 0.5 });
  c.v = c.top; g.cars.push(c);
  run(g, GAS, 2, ev);
  assert(ev.hit >= 1, 'hit event');
  assert(g.p.v < g.p.st.top * 0.8);
  // slipstream: a fast car just ahead
  var g2 = flatGame(), ev2 = {};
  run(g2, GAS, 14);
  var c2 = E.newCar({ kind: 'coupe', z: g2.p.z + E.SEG * 5, x: 0, top: g2.p.st.top * 1.2 });
  c2.v = g2.p.v + 200; g2.cars.push(c2);
  g2.stepTraffic = null;
  for (var i = 0; i < 90; i++) { c2.z = g2.p.z + E.SEG * 5; E.step(g2, GAS, E.STEP); g2.ev.forEach(function (e) { ev2[e.t] = 1; }); g2.ev.length = 0; }
  assert(g2.p.drafting, 'drafting');
  assert(ev2.draft);
});

test('endless: checkpoints add time, near misses score, time up ends the run', function () {
  var g = E.newEndless({ seed: 11, diff: 1 }), ev = {};
  run(g, bot, 200, ev);
  assert(ev.cp >= 1, 'reached a checkpoint');
  assert(ev.timeup === 1 && g.phase === 'done', 'ran out of time eventually');
  assert(g.score >= Math.floor(g.dist));
  assert(g.passes > 5, 'passed traffic ' + g.passes);
  var e2 = E.newEndless({ seed: 11, diff: 0 }), e3 = E.newEndless({ seed: 11, diff: 2 });
  assert(e2.timeLeft > g.D.time0 - 1 && e2.timeLeft > e3.timeLeft, 'easy gets more time');
});

test('traffic thickens with distance', function () {
  var g = E.newEndless({ seed: 21, diff: 1 });
  g.phase = 'race'; g.countT = 0; g.timeLeft = 1e9;
  var early = 0, late = 0;
  for (var i = 0; i < 60 * 20; i++) { E.step(g, bot, E.STEP); g.ev.length = 0; }
  early = g.cars.length;
  g.p.z = E.SEG * E.CP_LEN * 6.2; g.cars.length = 0;
  for (i = 0; i < 60 * 30; i++) { g.timeLeft = 1e9; E.step(g, bot, E.STEP); g.ev.length = 0; }
  late = g.cars.length;
  assert(late > early, early + ' -> ' + late);
});

test('career race: rivals race, the player finishes, standings are complete', function () {
  var g = E.newRace({ cup: 0, ti: 0, diff: 1, stats: E.carStats({ eng: 2, grip: 2, nos: 2, brk: 2 }) }), ev = {};
  assert.strictEqual(g.cars.length, E.CUPS[0].rivals);
  assert(g.p.z < 0, 'starts on the grid behind the line');
  run(g, bot, 400, ev);
  assert.strictEqual(g.phase, 'done');
  assert(ev.finish === 1 && ev.lap >= 1);
  assert(g.p.fin && g.p.finT > 20);
  var rows = E.standings(g);
  assert.strictEqual(rows.length, g.N);
  rows.forEach(function (r, i) { assert.strictEqual(r.pos, i + 1); if (i) assert(r.t >= rows[i - 1].t); });
  assert.strictEqual(rows.filter(function (r) { return r.you; }).length, 1);
  assert(g.cars.every(function (c) { return c.z > g.L; }), 'every rival completed at least a lap');
  // the rivals are spread out (not a single pack)
  var zs = g.cars.map(function (c) { return c.fin ? -c.finT : c.z; });
  assert(Math.max.apply(null, zs) !== Math.min.apply(null, zs));
});

test('career difficulty: stock car struggles in the last cup, upgrades help', function () {
  function finish(cup, lvl) {
    var g = E.newRace({ cup: cup, ti: 0, diff: 1, stats: E.carStats({ eng: lvl, grip: lvl, nos: lvl, brk: lvl }) });
    run(g, bot, 600);
    return E.standings(g).filter(function (r) { return r.you; })[0].pos;
  }
  assert.strictEqual(finish(0, 0), 1, 'a clean rookie race is winnable stock');
  assert(finish(5, 0) >= 5, 'masters cup outpaces a stock car');
  assert(finish(5, 5) <= 2, 'a maxed car can win the masters');
});

test('career: points, credits, cup completion, unlocks', function () {
  var sv = E.newSave();
  assert(!E.startCup(sv, 1), 'locked');
  assert(E.startCup(sv, 0));
  var ids = Object.keys(sv.cur.pts);
  assert.strictEqual(ids.length, E.CUPS[0].rivals + 1);
  function rows(place) {
    var others = ids.filter(function (i) { return i !== 'you'; }), out = [], k = 0;
    for (var p = 1; p <= ids.length; p++) {
      var id = p === place ? 'you' : others[k++];
      out.push({ id: id, you: id === 'you' ? 1 : 0, pos: p, pts: E.POINTS[p - 1], cr: E.CREDITS[p - 1] });
    }
    return out;
  }
  var r1 = E.awardRace(sv, rows(1));
  assert.strictEqual(r1.place, 1);
  assert.strictEqual(sv.car.credits, E.CREDITS[0]);
  assert.strictEqual(sv.cur.race, 1);
  E.awardRace(sv, rows(2));
  var r3 = E.awardRace(sv, rows(1));
  assert(r3.cupDone && r3.cupPlace === 1);
  assert(r3.unlocked && sv.unlocked === 2);
  assert(r3.prize === E.CUPS[0].prize);
  assert.strictEqual(sv.cur, null);
  assert.strictEqual(sv.cups[0].best, 1);
  assert.strictEqual(sv.stats.races, 3);
  assert.strictEqual(sv.stats.wins, 2);
  // a poor cup does not unlock
  E.startCup(sv, 1);
  ids = Object.keys(sv.cur.pts);
  for (var i = 0; i < E.CUPS[1].n; i++) var rl = E.awardRace(sv, rows(ids.length));
  assert(rl.cupDone && rl.cupPlace > 3 && !rl.unlocked && sv.unlocked === 2);
});

test('garage: upgrades and paint cost credits', function () {
  var sv = E.newSave();
  assert(!E.buyUpgrade(sv, 'eng'));
  sv.car.credits = 10000;
  assert(E.buyUpgrade(sv, 'eng'));
  assert.strictEqual(sv.car.upg.eng, 1);
  assert.strictEqual(sv.car.credits, 10000 - E.upgCost(0));
  assert(E.carStats(sv.car.upg).top > E.carStats({}).top);
  assert(E.carStats({ grip: 3 }).grip < 1);
  assert(E.buyPaint(sv, 4));
  assert.strictEqual(sv.car.paint, 4);
  assert(sv.car.owned.indexOf(4) >= 0);
  var cr = sv.car.credits;
  assert(E.buyPaint(sv, 1) && sv.car.credits === cr, 'owned paints are free to switch');
  for (var i = 0; i < 6; i++) { sv.car.credits = 1e6; E.buyUpgrade(sv, 'nos'); }
  assert.strictEqual(sv.car.upg.nos, 5, 'capped at 5');
  assert.strictEqual(E.upgCost(5), Infinity);
});

test('saves: normalize junk, keep good data', function () {
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('x'), E.newSave());
  var s = E.normSave({ set: { diff: 9, units: 'furlongs', cam: 'chase', sens: 3, steer: 'tilt', autogas: false }, car: { credits: -5, upg: { eng: 12, grip: 2 }, paint: 7, owned: [7, 99] },
    unlocked: 40, best: { endless: [{ score: 100, dist: 2000, cp: 2 }, 'bad', null] }, cur: { cup: 0, race: 1, diff: 1, pts: { you: 8, vex: 'x' } } });
  assert.strictEqual(s.set.diff, 2);
  assert.strictEqual(s.set.units, 'kmh');
  assert.strictEqual(s.set.cam, 'chase');
  assert.strictEqual(s.set.sens, 1);
  assert.strictEqual(s.set.steer, 'tilt');
  assert.strictEqual(s.set.autogas, false);
  assert.strictEqual(s.car.credits, 0);
  assert.strictEqual(s.car.upg.eng, 5);
  assert.strictEqual(s.car.paint, 7);
  assert(s.car.owned.indexOf(99) < 0 && s.car.owned.indexOf(0) >= 0);
  assert.strictEqual(s.unlocked, E.CUPS.length);
  assert.strictEqual(s.best.endless[0].score, 100);
  assert.strictEqual(s.best.endless[1], null);
  assert.strictEqual(s.cur.pts.you, 8);
  assert.strictEqual(s.cur.pts.vex, 0);
  var rt = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(rt, s, 'round trip');
});

test('endless records', function () {
  var sv = E.newSave(), g = { diff: 1, score: 500, dist: 3000.4, cpIdx: 2 };
  assert(E.endlessRecord(sv, g));
  assert.deepStrictEqual(sv.best.endless[1], { score: 500, dist: 3000, cp: 2 });
  assert(!E.endlessRecord(sv, { diff: 1, score: 400, dist: 1, cpIdx: 0 }));
  assert(E.endlessRecord(sv, { diff: 0, score: 1, dist: 1, cpIdx: 0 }));
});

test('helpers', function () {
  assert.strictEqual(E.fmtTime(83.456), '1:23.46');
  assert.strictEqual(E.fmtTime(5), '0:05.00');
  assert(Math.abs(E.kmh(E.V_BASE) - E.KMH_TOP) < 1e-9);
  var P = E.palette(3, 1), D = E.palette(3, 0);
  assert(P.night === 1 && D.night === 0);
  assert(P.road[0][0] < D.road[0][0], 'night is darker');
  for (var b = 0; b < E.BIOMES.length; b++) { var p = E.palette(b, 0); ['sky', 'grass', 'rumble', 'road', 'lane', 'far', 'fog'].forEach(function (k) { assert(p[k], b + ' ' + k); }); }
});

test('widget registers and matches the manifest', function () {
  assert(widget && typeof widget.open === 'function');
  assert.deepStrictEqual(css, ['povracer.css']);
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var m = (man.modules || man.items || []).filter ? (man.modules || man.items || []).filter(function (x) { return x.id === 'povracer'; })[0] : null;
  if (!m) { var all = JSON.stringify(man); assert(all.indexOf('"povracer"') >= 0); m = null; (function find(o) { if (!o || typeof o !== 'object') return; if (o.id === 'povracer') m = o; for (var k in o) if (!m) find(o[k]); })(man); }
  assert(m, 'manifest entry');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(widget[k], m[k], k); });
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
