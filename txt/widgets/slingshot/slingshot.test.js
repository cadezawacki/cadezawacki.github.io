/* Headless checks for the Siege Sling engine: collision, the impulse solver
 * (stacking, sleeping, friction, bounce), damage, shots and their specials,
 * every level (stable at rest, beatable), scoring, stars and the save.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/slingshot/slingshot.test.js */
'use strict';
var assert = require('assert');

var E = require('./slingshot.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./slingshot.js')];
require('./slingshot.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function ground(w) { return E.mkBody(w, { x: 30, y: -5, hw: 200, hh: 5, mat: 'r', kind: 'ground', fixed: true }); }
function steps(w, n) { for (var i = 0; i < n; i++) { E.stepWorld(w); w.events.length = 0; } }
function tmp() { var o = []; for (var i = 0; i < 2; i++) o.push({}); return o; }
function snap(w) { return w.bodies.map(function (b) { return { id: b.id, x: b.x, y: b.y, a: b.a }; }); }
function drift(w, s0) {
  var d = 0, r = 0, gone = 0;
  s0.forEach(function (s) {
    var b = null;
    for (var i = 0; i < w.bodies.length; i++) if (w.bodies[i].id === s.id) b = w.bodies[i];
    if (!b) { gone++; return; }
    d = Math.max(d, Math.hypot(b.x - s.x, b.y - s.y)); r = Math.max(r, Math.abs(b.a - s.a));
  });
  return { d: d, r: r, gone: gone };
}
// One winning line for every level, found by a grid search over aims (a: radians, p: power, tap: seconds).
var SOLUTIONS = {"1":[{"a":0.25,"p":0.945,"tap":null}],"2":[{"a":0.2,"p":0.945,"tap":null},{"a":0.3,"p":0.945,"tap":null}],"3":[{"a":0.25,"p":1,"tap":null}],"4":[{"a":0.1,"p":1,"tap":0.35}],"5":[{"a":0.55,"p":0.725,"tap":null}],"6":[{"a":0.6,"p":0.78,"tap":null},{"a":0.35,"p":1,"tap":0.6}],"7":[{"a":0.35,"p":0.89,"tap":null}],"8":[{"a":0.25,"p":0.945,"tap":0.85}],"9":[{"a":0.35,"p":0.78,"tap":0.6}],"10":[{"a":0.2,"p":0.945,"tap":null}],"11":[{"a":0.9,"p":0.78,"tap":null}],"12":[{"a":0.3,"p":0.945,"tap":1.1}],"13":[{"a":0.15,"p":1,"tap":0.6},{"a":0.1,"p":0.945,"tap":1.1}],"14":[{"a":-0.1,"p":1,"tap":0.35}],"15":[{"a":0.55,"p":0.725,"tap":1.1}],"16":[{"a":1.1,"p":0.505,"tap":0.85}],"17":[{"a":0.25,"p":1,"tap":0.6},{"a":0.15,"p":1,"tap":0.35}],"18":[{"a":0.6,"p":0.945,"tap":null},{"a":0.4,"p":0.89,"tap":0.6}],"19":[{"a":0,"p":1,"tap":0.35}],"20":[{"a":0.25,"p":1,"tap":0.85}],"21":[{"a":0.15,"p":1,"tap":0.85},{"a":0.45,"p":1,"tap":0.85}],"22":[{"a":0.5,"p":0.835,"tap":1.1}],"23":[{"a":0.25,"p":0.945,"tap":0.35}],"24":[{"a":0.4,"p":0.945,"tap":1.1}]};

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Siege Sling' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'slingshot.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('collision: box on box, circle on box, circles, apart', function () {
  var w = E.newWorld(), out = tmp();
  var A = E.mkBody(w, { x: 0, y: 0.3, hw: 0.3, hh: 0.3, mat: 'w' }), B = E.mkBody(w, { x: 0.1, y: 0.89, hw: 0.3, hh: 0.3, mat: 'w' });
  var n = E.collide(A, B, out, 0.01);
  assert.strictEqual(n, 2);
  for (var i = 0; i < n; i++) { assert.ok(Math.abs(out[i].ny - 1) < 1e-9 && Math.abs(out[i].sep + 0.01) < 1e-9); }
  assert.ok(Math.abs(out[0].x - out[1].x) > 0.45, 'two points across the overlap');
  var C = E.mkBody(w, { shape: 2, r: 0.25, x: 0.05, y: 0.84, mat: 'p' });
  n = E.collide(C, A, out, 0.01);
  assert.ok(n === 1 && out[0].ny < -0.99 && Math.abs(out[0].sep + 0.01) < 1e-9, 'circle → box normal points from circle to box');
  var D = E.mkBody(w, { shape: 2, r: 0.25, x: 0.45, y: 0.84, mat: 'p' });
  n = E.collide(C, D, out, 0.01);
  assert.ok(n === 1 && Math.abs(out[0].nx - 1) < 1e-9 && Math.abs(out[0].sep + 0.1) < 1e-9);
  var F = E.mkBody(w, { x: 3, y: 0.3, hw: 0.3, hh: 0.3, mat: 'w', a: 0.7 });
  assert.strictEqual(E.collide(A, F, out, 0.01), 0);
  // a rotated box resting on a corner: one point, normal from A to B
  var R = E.mkBody(w, { x: 0, y: 0.6 + Math.SQRT2 * 0.3 - 0.005, hw: 0.3, hh: 0.3, mat: 'w', a: Math.PI / 4 });
  n = E.collide(A, R, out, 0.01);
  assert.ok(n >= 1 && out[0].ny > 0.99 && out[0].sep < 0);
});

test('a tall column and a pyramid stand still when awake', function () {
  var w = E.newWorld(); ground(w);
  for (var i = 0; i < 12; i++) E.mkBody(w, { x: 5, y: 0.3 + i * 0.6, hw: 0.3, hh: 0.3, mat: 's' });
  for (var r = 0; r < 6; r++) for (var k = 0; k < 6 - r; k++) E.mkBody(w, { x: 12 + (k - (5 - r) / 2) * 0.62, y: 0.3 + r * 0.6, hw: 0.3, hh: 0.3, mat: 'w' });
  var s0 = snap(w);
  E.wakeAll(w);
  for (var t = 0; t < 600; t++) { E.stepWorld(w); w.events.length = 0; if (t % 50 === 0) E.wakeAll(w); }
  var d = drift(w, s0);
  assert.ok(d.gone === 0, 'nothing broke');
  assert.ok(d.d < 0.02 && d.r < 0.01, 'drift ' + d.d + ' rot ' + d.r);
});

test('every level: no overlaps, primed asleep, stands still when woken', function () {
  for (var li = 0; li < E.LEVELS.length; li++) {
    var items = E.buildLevel(li), i, j;
    assert.ok(items.some(function (it) { return it.t === 'guard'; }), 'level ' + (li + 1) + ' has guards');
    for (i = 0; i < items.length; i++) for (j = i + 1; j < items.length; j++) {
      var a = items[i], b = items[j], ox = Math.min(a.x + a.hw, b.x + b.hw) - Math.max(a.x - a.hw, b.x - b.hw), oy = Math.min(a.y + a.hh, b.y + b.hh) - Math.max(a.y - a.hh, b.y - b.hh);
      assert.ok(!(ox > 1e-6 && oy > 1e-6), 'level ' + (li + 1) + ': pieces ' + i + ' and ' + j + ' overlap');
    }
    var g = E.newGame(li), w = g.w;
    assert.ok(w.bodies.every(function (b) { return b.im === 0 || b.sleep; }), 'level ' + (li + 1) + ' starts asleep');
    var s0 = snap(w);
    // asleep: nothing moves at all
    for (i = 0; i < 120; i++) E.stepGame(g);
    var d0 = drift(w, s0);
    assert.ok(d0.d === 0 && d0.gone === 0, 'level ' + (li + 1) + ' moved while asleep');
    // woken: still stands, and falls back asleep
    E.wakeAll(w);
    for (i = 0; i < 480; i++) { E.stepWorld(w); w.events.length = 0; }
    var d = drift(w, s0);
    assert.ok(d.gone === 0 && d.d < 0.02 && d.r < 0.01, 'level ' + (li + 1) + ' sagged: ' + JSON.stringify(d));
    assert.ok(w.bodies.every(function (b) { return b.im === 0 || b.sleep; }), 'level ' + (li + 1) + ' went back to sleep');
  }
});

test('flight matches the aim preview; launch speed and spawn', function () {
  var g = E.newGame(0), pv = E.preview(0.5, 0.8, 'S', 60, 1), p0 = E.pouch(0.5, 0.8, 'S');
  assert.ok(E.launch(g, 0.5, 0.8));
  var b = E.liveProj(g);
  assert.ok(Math.abs(b.x - p0.x) < 1e-12 && Math.abs(b.y - p0.y) < 1e-12);
  assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - 0.8 * E.VMAX) < 1e-9);
  for (var i = 0; i < 60; i++) E.stepGame(g);
  assert.ok(Math.hypot(b.x - pv[118], b.y - pv[119]) < 1e-6, 'free flight follows the dotted arc');
  assert.ok(!E.launch(g, 0.5, 0.8), 'one shot at a time');
  var g2 = E.newGame(0);
  assert.ok(!E.launch(g2, 0.5, 0.02), 'a tiny pull is a cancel');
});

test('bounce decays, friction holds on a gentle slope, ice slides', function () {
  var w = E.newWorld(); ground(w);
  var ball = E.mkBody(w, { shape: 2, r: 0.25, x: 0, y: 4, mat: 'p', kind: 'proj' }), peaks = [], up = false, top = 0;
  for (var i = 0; i < 1200; i++) {
    E.stepWorld(w); w.events.length = 0;
    if (ball.vy > 0) { up = true; top = Math.max(top, ball.y); } else if (up) { peaks.push(top); up = false; top = 0; }
  }
  assert.ok(peaks.length >= 1 && peaks[0] < 4 * 0.2, 'a stone barely bounces: ' + peaks);
  for (i = 1; i < peaks.length; i++) assert.ok(peaks[i] <= peaks[i - 1] + 1e-9);
  assert.ok(ball.sleep, 'and comes to rest');
  // a 20° ramp: wood (mu 0.6 vs rock 0.8) holds, ice (0.1) slides
  var ang = 20 * Math.PI / 180;
  [['w', true], ['i', false]].forEach(function (c) {
    var w2 = E.newWorld();
    E.mkBody(w2, { x: 0, y: 0, hw: 4, hh: 0.2, a: ang, mat: 'r', fixed: true });
    var nx = -Math.sin(ang), ny = Math.cos(ang), b = E.mkBody(w2, { x: nx * 0.5, y: ny * 0.5, hw: 0.3, hh: 0.3, a: ang, mat: c[0] });
    var x0 = b.x;
    for (var k = 0; k < 240; k++) { E.stepWorld(w2); w2.events.length = 0; }
    if (c[1]) assert.ok(Math.abs(b.x - x0) < 0.02, 'wood holds on the ramp');
    else assert.ok(b.x - x0 < -0.3, 'ice slides down the ramp');
  });
});

test('sleeping: a still scene sleeps, a touch wakes the island', function () {
  var w = E.newWorld(); ground(w);
  var a = E.mkBody(w, { x: 5, y: 0.3, hw: 0.3, hh: 0.3, mat: 'w' }), b = E.mkBody(w, { x: 5, y: 0.9, hw: 0.3, hh: 0.3, mat: 'w' });
  steps(w, 240);
  assert.ok(a.sleep && b.sleep);
  var s = E.mkBody(w, { shape: 2, r: 0.2, x: 3, y: 0.6, vx: 6, mat: 'p', kind: 'proj' });
  var woke = false;
  for (var i = 0; i < 60 && !woke; i++) { E.stepWorld(w); w.events.length = 0; woke = !a.sleep && !b.sleep; }
  assert.ok(woke, 'hitting the bottom block wakes the block on top too');
  assert.ok(s);
});

test('damage: impacts break, resting does not, falls hurt guards', function () {
  // a resting stack takes no damage over time
  var g = E.newGame(2);
  E.wakeAll(g.w);
  var hp = g.w.bodies.map(function (b) { return b.hp; });
  for (var i = 0; i < 600; i++) { E.stepGame(g); g.events.length = 0; }
  g.w.bodies.forEach(function (b, k) { assert.strictEqual(b.hp, hp[k]); });
  // a full-power stone snaps a wood post
  var w = E.newWorld(); ground(w);
  var post = E.mkBody(w, { x: 6, y: 0.8, hw: 0.15, hh: 0.8, mat: 'w' });
  E.mkBody(w, { shape: 2, r: 0.26, x: 4, y: 0.8, vx: E.VMAX, mat: 'p', rho: 5, kind: 'proj', shot: 'S' });
  var broke = false;
  for (i = 0; i < 120 && !broke; i++) { E.stepWorld(w); broke = w.events.some(function (e) { return e.k === 'break'; }); w.events.length = 0; }
  assert.ok(broke && post.dead, 'the post breaks');
  // a stone block shrugs off the same stone; a boulder breaks it
  w = E.newWorld(); ground(w);
  var blk = E.mkBody(w, { x: 6, y: 0.3, hw: 0.3, hh: 0.3, mat: 's' });
  E.mkBody(w, { shape: 2, r: 0.26, x: 4, y: 0.3, vx: E.VMAX, mat: 'p', rho: 5, kind: 'proj', shot: 'S' });
  steps(w, 120);
  assert.ok(!blk.dead && blk.hp < blk.hp0, 'stone chips but holds');
  w = E.newWorld(); ground(w);
  blk = E.mkBody(w, { x: 6, y: 0.3, hw: 0.3, hh: 0.3, mat: 's' });
  E.mkBody(w, { shape: 2, r: 0.4, x: 4, y: 0.42, vx: E.VMAX, mat: 'p', rho: 7, kind: 'proj', shot: 'H' });
  steps(w, 120);
  assert.ok(blk.dead, 'a boulder smashes stone');
  // guards: a drop from 3 m is fatal, a short hop is not
  [[3, true], [0.15, false]].forEach(function (c) {
    var w3 = E.newWorld(); ground(w3);
    var gd = E.mkBody(w3, { x: 0, y: 0.35 + c[0], hw: 0.35, hh: 0.35, mat: 'g', kind: 'guard' });
    steps(w3, 240);
    assert.strictEqual(gd.dead, c[1], 'guard drop ' + c[0]);
  });
});

test('specials: split, slam, boost, bomb (tap and fuse), once per flight', function () {
  var g = E.newGame(3);
  E.launch(g, 0.4, 0.9);
  for (var i = 0; i < 30; i++) E.stepGame(g);
  assert.ok(E.ability(g));
  assert.strictEqual(g.proj.filter(function (p) { return !p.dead; }).length, 3, 'three stones');
  assert.ok(!E.ability(g), 'only once');
  g = E.newGame(7);
  E.launch(g, 0.6, 0.9);
  for (i = 0; i < 40; i++) E.stepGame(g);
  assert.ok(E.ability(g) && E.liveProj(g).vy <= -22, 'slam');
  g = E.newGame(15);
  E.launch(g, 0.6, 0.6);
  for (i = 0; i < 30; i++) E.stepGame(g);
  var p = E.liveProj(g), v0 = Math.hypot(p.vx, p.vy);
  assert.ok(E.ability(g) && Math.hypot(p.vx, p.vy) >= Math.max(v0 * 1.79, 23.99), 'boost');
  // bomb: tapped, it shoves and hurts what's near
  g = E.newGame(11);
  E.launch(g, 0.25, 1);
  var boomed = false;
  for (i = 0; i < 600 && !boomed; i++) {
    var q = E.liveProj(g);
    if (q && q.x > 10.5 && !g.actUsed) E.ability(g);
    E.stepGame(g);
    boomed = g.events.some(function (e) { return e.k === 'boom'; });
  }
  assert.ok(boomed);
  var hurt = g.w.bodies.filter(function (b) { return b.hp0 && b.hp < b.hp0; }).length + g.broke + g.kills;
  assert.ok(hurt > 0, 'the blast did damage');
  // bomb left alone: the fuse fires after its first knock
  g = E.newGame(11);
  E.launch(g, 0.3, 0.945);
  boomed = false;
  for (i = 0; i < 1200 && !boomed; i++) { E.stepGame(g); boomed = g.events.some(function (e) { return e.k === 'boom'; }); g.events.length = 0; }
  assert.ok(boomed, 'the fuse goes off');
});

test('every level can be beaten (stored lines), with sensible stars', function () {
  for (var li = 0; li < E.LEVELS.length; li++) {
    var L = E.LEVELS[li], sol = SOLUTIONS[li + 1];
    assert.ok(L.par >= 1 && L.par < L.shots.length, 'level ' + (li + 1) + ' leaves room over par');
    for (var k = 0; k < L.shots.length; k++) assert.ok(E.SHOTS[L.shots[k]].unlock <= li + 1, 'level ' + (li + 1) + ' uses a shot before it unlocks');
    var g = E.play(li, sol);
    assert.strictEqual(g.phase, 'won', 'level ' + (li + 1) + ' (' + L.name + ') replay: ' + g.phase + ', guards left ' + g.guards);
    assert.strictEqual(g.stars, E.starsFor(L, g.used));
    assert.strictEqual(g.bonus, g.queue.length * E.SHOT_BONUS);
  }
});

test('determinism: the same shots give the same castle', function () {
  var a = E.play(20, SOLUTIONS[21]), b = E.play(20, SOLUTIONS[21]);
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.w.steps, b.w.steps);
  assert.deepStrictEqual(snap(a.w), snap(b.w));
});

test('running out of shots loses; advance is fixed-step', function () {
  var g = E.play(1, [{ a: 1.4, p: 0.3 }, { a: 1.4, p: 0.3 }, { a: 1.4, p: 0.3 }]);
  assert.strictEqual(g.phase, 'over');
  assert.ok(g.guards > 0 && g.used === 3 && g.queue.length === 0);
  var x = E.newGame(0), y = E.newGame(0), i;
  E.launch(x, 0.4, 0.8); E.launch(y, 0.4, 0.8);
  for (i = 0; i < 60; i++) E.advance(x, 1 / 60);
  for (i = 0; i < 120; i++) E.advance(y, 1 / 120);
  assert.ok(Math.abs(x.w.steps - y.w.steps) <= 1);
  var al = E.advance(E.newGame(0), 0.013);
  assert.ok(al >= 0 && al < 1);
});

test('stars, records, unlocking and the save', function () {
  var L = { par: 2 };
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(function (u) { return E.starsFor(L, u); }), [3, 3, 2, 1, 1]);
  var s = E.newSave();
  assert.ok(E.unlocked(s, 0) && !E.unlocked(s, 1));
  var g = E.play(0, SOLUTIONS[1]), r = E.record(s, g);
  assert.ok(r.first && r.newStars && r.newBest && E.cleared(s, 0) && E.unlocked(s, 1) && !E.unlocked(s, 2));
  assert.strictEqual(E.totalStars(s), g.stars);
  assert.strictEqual(E.nextLevel(s), 1);
  var worse = { li: 0, phase: 'won', stars: 1, score: 10, used: 3, kills: 1 };
  r = E.record(s, worse);
  assert.ok(!r.newStars && !r.newBest && s.lv[0].s === g.stars && s.lv[0].b === g.score, 'records only go up');
  var lost = { li: 1, phase: 'over', stars: 0, score: 999, used: 3, kills: 0 };
  E.record(s, lost);
  assert.ok(!E.cleared(s, 1));
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ lv: [{ s: 9, b: -4 }, 'x', null, { s: 0, b: 5 }], last: 999, shots: -1, kills: 'a' });
  assert.ok(bad.lv[0].s === 3 && bad.lv[0].b === 0 && bad.lv.length === 1 && bad.last === E.LEVELS.length - 1 && bad.shots === 0 && bad.kills === 0);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('fuzz: any aim on any level ends its turns, no NaN, no runaway', function () {
  var seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (var li = 0; li < E.LEVELS.length; li++) {
    var shots = [];
    for (var k = 0; k < E.LEVELS[li].shots.length; k++) shots.push({ a: -1.3 + rnd() * 2.9, p: 0.1 + rnd() * 0.95, tap: rnd() < 0.6 ? rnd() * 2 : null });
    var g = E.play(li, shots, 120 * 25 * shots.length);
    assert.ok(g.phase === 'won' || g.phase === 'over', 'level ' + (li + 1) + ' stuck in ' + g.phase + ' after ' + g.w.steps + ' steps');
    g.w.bodies.forEach(function (b) {
      assert.ok(isFinite(b.x) && isFinite(b.y) && isFinite(b.a) && isFinite(b.vx) && isFinite(b.vy) && isFinite(b.w), 'level ' + (li + 1) + ' NaN body');
      if (b.im > 0) assert.ok(Math.hypot(b.vx, b.vy) < 80, 'level ' + (li + 1) + ' runaway speed');
    });
    assert.ok(g.score >= 0 && g.used <= E.LEVELS[li].shots.length);
  }
});

test('specials refuse when they should: stone has none, nothing before launch, split after a hit', function () {
  var g = E.newGame(0);
  assert.ok(!E.ability(g), 'no special while aiming');
  E.launch(g, 0.4, 0.9);
  for (var i = 0; i < 20; i++) E.stepGame(g);
  assert.ok(!E.ability(g), 'a plain stone has no special');
  g = E.newGame(3);
  E.launch(g, 0.0, 1);
  for (i = 0; i < 600 && E.liveProj(g) && E.liveProj(g).hitT < 0; i++) E.stepGame(g);
  assert.ok(E.liveProj(g) && E.liveProj(g).hitT >= 0, 'the splitter hit something');
  assert.ok(!E.ability(g), 'no split after impact');
  assert.ok(!E.launch(E.newGame(0), 0.5, 0.05), 'too weak a pull is a cancel');
});

test('unlocks go in order and a later clear never locks an earlier level', function () {
  var s = E.newSave();
  s.lv[5] = { s: 2, b: 10 };
  assert.ok(E.unlocked(s, 5) && E.unlocked(s, 6) && !E.unlocked(s, 3) && E.unlocked(s, 0));
  var n = E.normSave({ lv: [null, null, { s: 1, b: 3 }], last: 2 });
  assert.ok(n.lv.length === 3 && n.lv[0] === null && n.lv[2].s === 1 && E.totalStars(n) === 1);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
