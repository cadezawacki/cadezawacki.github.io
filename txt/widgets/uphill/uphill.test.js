/* Headless checks for the Uphill Rush engine (physics, terrain, tricks, scoring).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/uphill/uphill.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');

var E = require('./uphill.js');               // node: the file exports its pure engine
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function steps(w, secs, ctl) {
  var n = Math.round(secs / E.STEP);
  for (var i = 0; i < n; i++) { if (ctl) ctl(w, i); E.step(w); }
}
function drain(w) { var ev = w.events.slice(); w.events.length = 0; return ev; }
function finite(w) {
  var c = w.c, a = w.wh[0], b = w.wh[1];
  return [c.x, c.y, c.a, c.vx, c.vy, c.w, a.x, a.y, a.om, b.x, b.y, b.om].every(function (v) { return typeof v === 'number' && isFinite(v); });
}
function energy(w) {
  var c = w.c, e = 0.5 * (c.vx * c.vx + c.vy * c.vy) + 0.15 * c.w * c.w + E.G * c.y;
  w.wh.forEach(function (q) { e += 0.12 * (0.5 * (q.vx * q.vx + q.vy * q.vy) + E.G * q.y); });
  return e;
}
// Lift the whole bike by dy, set its attitude / spin, and let it fly.
function launch(w, x, dy, angle, spin) {
  E.placeBike(w, x);
  var c = w.c, ca = Math.cos(angle), sa = Math.sin(angle);
  [w.wh[0], w.wh[1]].forEach(function (q) {
    var rx = q.x - c.x, ry = q.y - c.y;
    q.x = c.x + ca * rx - sa * ry; q.y = c.y + sa * rx + ca * ry + dy;
    q.vx = -spin * (q.y - dy - c.y); q.vy = spin * (q.x - c.x);
    q.px = q.x; q.py = q.y;
  });
  c.y += dy; c.a = angle; c.w = spin; c.py = c.y; c.pa = c.a;
  w.state = 'ride'; w.air = false; w.airT = 0; w.airRot = 0;
}

test('module exports the engine; the widget registers under the manifest name', function () {
  assert.strictEqual(typeof E.newWorld, 'function');
  assert.strictEqual(typeof E.step, 'function');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'uphill'; })[0];
  assert.strictEqual(entry.id, 'uphill');
  assert.strictEqual(entry.type, 'widget');
  assert.strictEqual(entry.entry, 'widgets/uphill/uphill.js');
  assert.strictEqual(entry.css, 'widgets/uphill/uphill.css');
  // load the file again as the browser would, against a fake Cade
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'uphill.js'), 'utf8');
  var fakeWin = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (o) { reg = o; } } };
  new Function('window', 'module', src)(fakeWin, undefined);
  assert.ok(reg, 'registered');
  assert.strictEqual(reg.name, entry.name);
  assert.strictEqual(reg.description, entry.description);
  assert.strictEqual(reg.icon, entry.icon);
  assert.strictEqual(reg.tags, entry.tags);
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['uphill.css']);
});

test('terrain lookups: height, slope and segment search on a known polyline', function () {
  var w = E.newWorld({ src: 'f10 l20,5 f10' });     // the start straight runs to x = 10
  assert.ok(Math.abs(E.heightAt(w.ter, 0)) < 1e-9);
  assert.ok(Math.abs(E.heightAt(w.ter, 20)) < 1e-9);
  assert.ok(Math.abs(E.heightAt(w.ter, 40) - 5) < 1e-9);
  assert.ok(Math.abs(E.heightAt(w.ter, 45) - 5) < 1e-9);
  var m = E.heightAt(w.ter, 30);
  assert.ok(m > 2.2 && m < 2.8, 'midpoint of the slope ' + m);
  assert.ok(E.slopeAt(w.ter, 30, 0.5) > 0.2, 'climbing');
  for (var i = 1; i < w.ter.n; i++) assert.ok(w.ter.xs[i] > w.ter.xs[i - 1], 'xs strictly increasing');
  assert.ok(E.groundDist(w.ter, 0, 2, 0.2) > 1.9 && E.groundDist(w.ter, 0, -0.5, 0.2) < 0);
});

test('a bike at rest on flat ground settles, stays upright, and gains no energy', function () {
  var w = E.newWorld({ src: 'f100' });
  steps(w, 2);
  var x0 = w.c.x, y0 = w.c.y, e0 = energy(w), maxV = 0, maxDy = 0, eMax = -1e9;   // e: J per kg of frame
  steps(w, 6, function (w) {
    maxV = Math.max(maxV, Math.abs(w.c.vx), Math.abs(w.c.vy), Math.abs(w.c.w));
    maxDy = Math.max(maxDy, Math.abs(w.c.y - y0));
    eMax = Math.max(eMax, energy(w));
  });
  assert.ok(finite(w));
  assert.strictEqual(w.state, 'ready');
  assert.ok(Math.abs(w.c.a) < 0.02, 'upright ' + w.c.a);
  assert.ok(Math.abs(w.c.x - x0) < 1e-3, 'no creep ' + (w.c.x - x0));
  assert.ok(maxDy < 1e-3, 'no bounce ' + maxDy);
  assert.ok(maxV < 1e-3, 'no jitter ' + maxV);
  assert.ok(eMax <= e0 + 1e-4, 'no energy gain ' + (eMax - e0));
  assert.ok(energy(w) <= e0 + 1e-5, 'no energy drift ' + (energy(w) - e0));
  assert.ok(w.wh[0].touch && w.wh[1].touch, 'both wheels on the ground');
});

test('gas accelerates, brakes stop, holding brake from a stop reverses', function () {
  var w = E.newWorld({ src: 'f400' });
  steps(w, 3, function (w) { w.inGas = 1; });
  assert.strictEqual(w.state, 'ride');
  assert.ok(w.c.vx > 13 && w.c.vx < 20, 'speed after 3 s ' + w.c.vx);
  var v0 = w.c.vx;
  steps(w, 1, function (w) { w.inGas = 0; w.inBrake = 1; });
  assert.ok(w.c.vx < v0 - 5, 'braking ' + w.c.vx);
  steps(w, 4, function (w) { w.inGas = 0; w.inBrake = 1; });
  assert.ok(w.c.vx < -1.5, 'reversing ' + w.c.vx);
  assert.strictEqual(w.state, 'ride');
});

test('full gas on stage 1 with a simple lean controller reaches the finish', function () {
  var w = E.newWorld({ stage: 0 }), crashes = 0, maxT = 60 / E.STEP;
  for (var i = 0; i < maxT && w.state !== 'finish'; i++) {
    E.bot(w);
    E.step(w);
    if (drain(w).indexOf('crash') >= 0) crashes++;
  }
  assert.strictEqual(w.state, 'finish');
  assert.strictEqual(crashes, 0);
  assert.ok(w.c.x >= w.finishX);
  assert.ok(w.final > 10 && w.final < 40, 'time ' + w.final);
  assert.ok(E.stars(0, w.final) >= 2, 'bot earns stars');
  steps(w, 2);
  assert.ok(w.done, 'done after the run-out');
});

test('every stage is finishable by the bot; checkpoints are hit in order', function () {
  assert.ok(E.STAGES.length >= 12);
  E.STAGES.forEach(function (st, idx) {
    assert.ok(st.par[0] < st.par[1], st.name + ' par order');
    var w = E.newWorld({ stage: idx }), cps = 0;
    for (var i = 0; i < 120 / E.STEP && w.state !== 'finish'; i++) {
      E.bot(w); E.step(w);
      drain(w).forEach(function (e) { if (e === 'cp') cps++; });
    }
    assert.strictEqual(w.state, 'finish', st.name + ' finished');
    assert.strictEqual(cps, w.cps.length, st.name + ' checkpoints');
    assert.ok(w.final < st.par[1], st.name + ' bot inside 2-star time');
  });
});

test('a head-first landing is a crash; the stage respawns at the checkpoint', function () {
  var w = E.newWorld({ src: 'f30 c f60' });      // checkpoint at x = 40
  launch(w, 50, 3, Math.PI, 0);                  // upside down, 3 m up, past the checkpoint
  var ev = [];
  steps(w, 1.2, function (w) { ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('crash') >= 0, 'crashed');
  assert.strictEqual(w.why, 'head');
  assert.strictEqual(w.state, 'crash');
  assert.ok(finite(w));
  // ragdoll stays above ground
  for (var i = 0; i < E.RAG_N; i++) assert.ok(w.rag[i * 4 + 1] > E.heightAt(w.ter, w.rag[i * 4]) - 0.05);
  for (var j = 0; j < 2 / E.STEP && ev.indexOf('respawn') < 0; j++) { E.step(w); ev = ev.concat(drain(w)); }
  assert.ok(ev.indexOf('respawn') >= 0);
  assert.strictEqual(w.state, 'ride');
  assert.strictEqual(w.cps[0], 40);
  assert.ok(Math.abs(w.c.x - 40) < 1e-9 && Math.abs(w.c.vx) < 1e-9, 'back at the checkpoint, at rest');
});

test('an upright landing from a drop is not a crash', function () {
  var w = E.newWorld({ src: 'f100' });
  launch(w, 30, 4, 0, 0);
  var ev = [];
  steps(w, 2, function (w) { ev = ev.concat(drain(w)); });
  assert.strictEqual(ev.indexOf('crash'), -1);
  assert.strictEqual(w.state, 'ride');
  assert.ok(Math.abs(w.c.a) < 0.1);
});

// Spin rate that lands the bike after `turns` full rotations (bisection on the launch spin).
function flipDrop(dir) {
  var lo = 2, hi = 12, best = null;
  for (var k = 0; k < 30; k++) {
    var mid = (lo + hi) / 2, w = E.newWorld({ src: 'f200' });
    launch(w, 40, 9, 0, dir * mid);
    var rot = null;
    for (var i = 0; i < 4 / E.STEP; i++) {
      E.step(w);
      if (w.airT === 0 && w.c.y < 5) { rot = w.c.a; break; }
    }
    if (rot == null) break;
    best = mid;
    if (Math.abs(rot) < Math.PI * 2) lo = mid; else hi = mid;
    if (Math.abs(Math.abs(rot) - Math.PI * 2) < 0.05) break;
  }
  return best;
}
test('a 360° rotation in the air is a flip (back and front), with a time bonus', function () {
  [1, -1].forEach(function (dir) {
    var spin = flipDrop(dir), w = E.newWorld({ src: 'f200' }), ev = [];
    launch(w, 40, 9, 0, dir * spin);
    steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
    assert.strictEqual(ev.indexOf('crash'), -1, 'clean landing');
    assert.ok(ev.indexOf('flip') >= 0, 'flip event (' + dir + ')');
    assert.strictEqual(w.flips, 1);
    assert.strictEqual(w.lastFlipN, 1);
    assert.strictEqual(w.lastFlipDir, dir, 'direction');
    assert.ok(w.bonus >= 1, 'stage time bonus');
  });
});

test('a plain jump is not a flip; over-rotation into the ground is a crash, not a flip', function () {
  var w = E.newWorld({ src: 'f200' }), ev = [];
  launch(w, 40, 6, 0.3, 1.2);
  steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
  assert.strictEqual(ev.indexOf('flip'), -1);
  w = E.newWorld({ src: 'f200' }); ev = [];
  launch(w, 40, 6, 0, 4.5);                       // ~1¼ turns: lands on its back
  steps(w, 3, function (w) { ev = ev.concat(drain(w)); });
  assert.ok(ev.indexOf('crash') >= 0);
  assert.strictEqual(ev.indexOf('flip'), -1);
  assert.strictEqual(w.flips, 0);
});

test('falling into a gap is a crash', function () {
  var w = E.newWorld({ src: 'f30 g8,0 f30' }), ev = [];
  for (var i = 0; i < 20 / E.STEP; i++) {
    w.inGas = w.c.vx < 5 ? 1 : 0; w.inLean = 0;   // too slow to clear it
    E.step(w); ev = ev.concat(drain(w));
    if (w.state === 'crash') break;
  }
  assert.strictEqual(w.why, 'gap');
});

test('deterministic: same seed + same inputs → identical run; seeds differ', function () {
  function run(seed) {
    var w = E.newWorld({ endless: true, seed: seed });
    steps(w, 20, function (w, i) { E.bot(w); if ((i >> 7) % 5 === 0) w.inLean = -w.inLean; });
    return [w.c.x, w.c.y, w.c.a, w.c.vx, w.wh[0].om, w.coins, w.fuel, w.dist, w.ter.n].join(',');
  }
  assert.strictEqual(run(42), run(42));
  var a = E.newWorld({ endless: true, seed: 1 }), b = E.newWorld({ endless: true, seed: 2 });
  var same = true;
  for (var x = 20; x < 200; x += 5) if (Math.abs(E.heightAt(a.ter, x) - E.heightAt(b.ter, x)) > 1e-6) same = false;
  assert.ok(!same, 'different seeds → different terrain');
});

test('fixed step: 60 Hz and 120 Hz frames give the identical simulation', function () {
  function run(hz) {
    var w = E.newWorld({ stage: 1 });
    for (var f = 0; f < 6 * hz; f++) { E.bot(w); w.inLean = 0; E.advance(w, 1 / hz); }
    return w;
  }
  var a = run(60), b = run(120);
  assert.strictEqual(a.steps, b.steps);
  assert.strictEqual(a.c.x, b.c.x);
  assert.strictEqual(a.c.a, b.c.a);
  // a long stall doesn't fast-forward
  var w = E.newWorld({ src: 'f100' }), s0 = w.steps;
  E.advance(w, 5);
  assert.ok(w.steps - s0 <= 48);
});

test('endless: fuel runs out without cans; coins are collected', function () {
  var w = E.newWorld({ endless: true, seed: 7 }), ev = [];
  assert.ok(w.items.some(function (it) { return it.k === 0; }), 'coins placed');
  assert.ok(w.items.some(function (it) { return it.k === 1; }), 'a fuel can placed');
  steps(w, 30, function (w) { E.bot(w); ev = ev.concat(drain(w)); });
  assert.ok(w.coins > 0 && ev.indexOf('coin') >= 0, 'coins collected ' + w.coins);
  w.items.forEach(function (it) { it.on = 0; });
  w.gen.nextFuel = 1e9;
  w.fuel = 0.02;
  for (var i = 0; i < 40 / E.STEP && w.state !== 'over'; i++) { E.bot(w); E.step(w); ev = ev.concat(drain(w)); }
  assert.ok(ev.indexOf('nofuel') >= 0);
  assert.strictEqual(w.state, 'over');
  assert.strictEqual(w.why, 'fuel');
  assert.ok(w.dist > 100);
});

test('endless: terrain is compacted behind the bike (bounded memory)', function () {
  var w = E.newWorld({ endless: true, seed: 3 });
  for (var i = 0; i < 400 / E.STEP && w.c.x < 3000; i++) {
    E.bot(w); E.step(w); w.events.length = 0;
    if (w.state !== 'ride' && w.state !== 'ready') { E.placeBike(w, w.c.x + 3); w.state = 'ride'; }
    w.fuel = 1;
  }
  assert.ok(w.c.x > 1500, 'rode far ' + w.c.x);
  assert.ok(w.ter.n < w.ter.cap, 'terrain within capacity');
  assert.ok(w.ter.xs[0] > 500, 'old terrain dropped ' + w.ter.xs[0]);
  assert.ok(w.items.length < 600 && w.decos.length < 200);
});

test('ghost encoding round-trips within quantisation', function () {
  var n = 300, a = new Float32Array(n * 3);
  for (var i = 0; i < n; i++) { a[i * 3] = i * 1.37 - 3; a[i * 3 + 1] = Math.sin(i / 9) * 6; a[i * 3 + 2] = Math.cos(i / 13) * 7; }
  var s = E.encodeGhost(a, n), b = E.decodeGhost(s);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(s));
  assert.strictEqual(b.length, n * 3);
  for (i = 0; i < n * 3; i++) assert.ok(Math.abs(a[i] - b[i]) <= (i % 3 === 2 ? 0.006 : 0.026), 'value ' + i);
  assert.ok(s.length < n * 3 * 2, 'compact: ' + s.length + ' chars');
  assert.strictEqual(E.decodeGhost('!!'), null);
});

test('save data is normalised; stars, unlocks and upgrades', function () {
  var s = E.normSave(null);
  assert.deepStrictEqual(s.st, {});
  assert.strictEqual(s.coins, 0);
  s = E.normSave({ st: { 1: { t: 22.5, s: 3 }, 2: { t: -1, s: 2 }, 3: 'x', 99: { t: 5, s: 3 } }, coins: '12', up: { engine: 9, susp: -2, tyres: 2 }, eb: 803.7, ghost: false });
  assert.deepStrictEqual(Object.keys(s.st), ['1']);
  assert.strictEqual(s.coins, 12);
  assert.deepStrictEqual(s.up, { engine: 4, susp: 0, tyres: 2, tank: 0 });
  assert.strictEqual(s.eb, 803);
  assert.strictEqual(s.ghost, false);
  assert.ok(E.unlocked(s, 0) && E.unlocked(s, 1) && !E.unlocked(s, 2));
  assert.strictEqual(E.totalStars(s), 3);
  var p = E.STAGES[0].par;
  assert.strictEqual(E.stars(0, p[0] - 0.1), 3);
  assert.strictEqual(E.stars(0, p[1] - 0.1), 2);
  assert.strictEqual(E.stars(0, p[1] + 5), 1);
  assert.strictEqual(E.stars(0, 0), 0);
  var b0 = E.bikeParams({}), b4 = E.bikeParams({ engine: 4, susp: 4, tyres: 4, tank: 4 });
  assert.ok(b4.torque > b0.torque && b4.mu > b0.mu && b4.tank > b0.tank && b4.smin[0] < b0.smin[0]);
});

test('upgraded bike is still stable at rest and finishes stage 1', function () {
  var up = { engine: 4, susp: 4, tyres: 4, tank: 4 }, w = E.newWorld({ src: 'f60', up: up });
  steps(w, 3);
  var x0 = w.c.x;
  steps(w, 3);
  assert.ok(Math.abs(w.c.x - x0) < 1e-3 && Math.abs(w.c.a) < 0.02);
  w = E.newWorld({ stage: 0, up: up });
  for (var i = 0; i < 60 / E.STEP && w.state !== 'finish'; i++) { E.bot(w); E.step(w); w.events.length = 0; }
  assert.strictEqual(w.state, 'finish');
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
