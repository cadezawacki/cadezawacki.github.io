/* Headless checks for the Curling engine (ice physics, collisions, rules,
 * scoring, the CPU skip, saves). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/curling/curling.test.js */
'use strict';
var assert = require('assert');

var E = require('./curling.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./curling.js')];
require('./curling.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b + ' (±' + tol + ')'); }
function thrown(stones, team, shot, sweep) {
  var f = E.newShot(stones, team, shot, 50);
  E.runShot(f, sweep == null ? null : typeof sweep === 'function' ? sweep : function () { return sweep; });
  return f;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Curling' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'curling.css');
  assert.strictEqual(widget._engine.TEE, E.TEE);
});

test('sheet geometry and weight names', function () {
  assert.ok(E.HOG < E.TEE && E.TEE < E.BACK);
  near(E.BACK - E.TEE, E.R12, 1e-9, 'back line on the 12-foot');
  assert.strictEqual(E.weightName(E.speedFor(E.TEE)), 'Button');
  assert.strictEqual(E.weightName(E.speedFor(E.TEE - 3)), 'Guard');
  assert.strictEqual(E.weightName(E.speedFor(E.HOG - 1)), 'Hog');
  assert.strictEqual(E.weightName(4.2), 'Peel');
  near(E.angleFor(E.broomFor(0.03)), 0.03, 1e-12);
});

test('a draw weight stone comes to rest near the tee, curling with its turn', function () {
  var v = E.speedFor(E.TEE);
  assert.ok(v > 2.1 && v < 2.5, 'draw weight ' + v);
  var r = thrown([], 0, { th: 0, v: v, turn: 1 }), l = thrown([], 0, { th: 0, v: v, turn: -1 });
  assert.ok(r.d.x > 0.8 && r.d.x < 1.5, 'in-turn curls right ~1 m: ' + r.d.x);
  near(l.d.x, -r.d.x, 1e-9, 'mirror');
  near(r.d.y, E.TEE, 0.25, 'length');
  // most of the curl happens late, as the stone slows
  var f = E.newShot([], 0, { th: 0, v: v, turn: 1 }), half = null;
  while (!f.done) { E.stepShot(f, 0); if (half === null && f.d.y > E.TEE / 2) half = f.d.x; }
  assert.ok(half < r.d.x * 0.2, 'little curl in the first half: ' + half);
});

test('speed falls steadily and the stone never speeds up', function () {
  var f = E.newShot([], 0, { th: 0.01, v: 2.4, turn: -1 }), last = 2.4;
  while (!f.done) {
    E.stepShot(f, 0);
    var v = Math.hypot(f.d.vx, f.d.vy);
    assert.ok(v <= last + 1e-9);
    last = v;
  }
  assert.ok(f.t > 20 && f.t < 30, 'travel time ' + f.t);
});

test('sweeping carries the stone farther and straighter', function () {
  var v = E.speedFor(E.TEE - 1.5);
  var a = thrown([], 0, { th: 0, v: v, turn: 1 }), b = thrown([], 0, { th: 0, v: v, turn: 1 }, 1);
  assert.ok(b.d.y > a.d.y + 1, 'farther: ' + a.d.y + ' → ' + b.d.y);
  assert.ok(b.d.x < a.d.x * 0.7, 'straighter: ' + a.d.x + ' → ' + b.d.x);
  assert.ok(b.sweepT > 0);
  // sweeping only helps the throwing team's stones
  var c = thrown([], 0, { th: 0, v: v, turn: 1 }), f = E.newShot([], 1, { th: 0, v: v, turn: 1 });
  f.team = 0; f.d.team = 1;
  E.runShot(f, function () { return 1; });
  near(f.d.y, c.d.y, 1e-9, 'other team unaffected');
});

test('the fixed step makes the result frame-rate independent', function () {
  function go(hz) {
    var f = E.newShot([E.mkStone(1, 1, 0.2, E.TEE)], 0, { th: 0.004, v: 2.6, turn: 1 }, 2);
    var guard = 0, alpha;
    while (!f.done && guard++ < 100000) { alpha = E.advance(f, E.TIME_SCALE / hz, 0.3); assert.ok(alpha >= 0 && alpha <= 1); }
    return f.st.map(function (s) { return s.x.toFixed(9) + ',' + s.y.toFixed(9); }).join(';');
  }
  assert.strictEqual(go(60), go(120));
  assert.strictEqual(go(144), go(120));
});

test('the draw solver puts stones where it is asked', function () {
  [[0, E.TEE], [0.6, E.TEE - 0.5], [-1.1, E.TEE + 0.4], [0.3, E.TEE - 3.5], [-0.9, E.TEE - 2.8]].forEach(function (t) {
    [1, -1].forEach(function (turn) {
      var s = E.solveDraw(t[0], t[1], turn), f = thrown([], 0, s);
      assert.ok(Math.hypot(f.d.x - t[0], f.d.y - t[1]) < 0.04, 'draw to ' + t + ' turn ' + turn + ' → ' + f.d.x + ',' + f.d.y);
    });
  });
});

test('a centre hit on a still stone: the shooter sticks, the target flies', function () {
  var tgt = E.mkStone(1, 1, 0.3, E.TEE + 0.2), s = E.solveHit(0.3, E.TEE + 0.2, 3.1, -1);
  var f = thrown([tgt], 0, s), t = f.st[0], d = f.d;
  assert.ok(f.hit, 'it hit');
  assert.ok(t.out, 'target removed');
  assert.ok(!d.out && Math.hypot(d.x - 0.3, d.y - (E.TEE + 0.2)) < 0.5, 'shooter stays near the spot: ' + d.x + ',' + d.y);
});

test('collisions conserve momentum and lose a little energy', function () {
  var a = E.mkStone(1, 0, 0, 10), b = E.mkStone(2, 1, 0.1, 10.28);
  a.vy = 2; var f = { st: [a, b], d: a, team: 0, done: false, steps: 0, t: 0, events: [], hits: [], outs: [], sweepT: 0 };
  var p0x = a.vx + b.vx, p0y = a.vy + b.vy, e0 = a.vy * a.vy;
  for (var i = 0; i < 6; i++) E.stepShot(f, 0);
  assert.ok(f.hits.length >= 1);
  near(a.vx + b.vx, p0x, 0.01, 'px'); near(a.vy + b.vy, p0y, 0.02, 'py (friction only)');
  var e1 = a.vx * a.vx + a.vy * a.vy + b.vx * b.vx + b.vy * b.vy;
  assert.ok(e1 < e0 && e1 > e0 * 0.85, 'energy ' + e0 + ' → ' + e1);
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= 2 * E.R - 1e-6, 'no overlap');
});

test('stones go out at the sides and through the back line', function () {
  var f = thrown([], 0, { th: 0.12, v: 2.6, turn: 1 });
  assert.ok(f.d.out && f.outs.length === 1, 'side');
  f = thrown([], 0, { th: 0, v: 3.4, turn: 1 });
  assert.ok(f.d.out && f.d.oy > E.BACK, 'back');
  var m = E.newMatch({ seed: 1 }), res = E.resolve(m, f);
  assert.strictEqual(res.stones.length, 0);
});

test('hog line: a stone short of the far hog line comes off unless it hit', function () {
  var m = E.newMatch({ seed: 2 }), f = thrown([], E.toThrow(m), { th: 0, v: E.speedFor(E.HOG - 0.5), turn: 1 });
  assert.ok(!f.d.out);
  var res = E.resolve(m, f);
  assert.strictEqual(res.why, 'hog'); assert.strictEqual(res.stones.length, 0);
  var g = E.newShot([], 0, { th: 0, v: E.speedFor(E.HOG + 1), turn: 1 }); E.runShot(g);
  assert.strictEqual(E.resolve(m, g).why, '');
});

test('free guard zone: an early guard knocked out is put back', function () {
  var m = E.newMatch({ seed: 4, fgz: true });
  m.thrown = 1;
  var team = E.toThrow(m), guard = { id: 7, team: 1 - team, x: 0, y: E.TEE - 3.5 };
  assert.ok(E.inFGZ(guard));
  m.stones = [guard];
  var shot = E.solveHit(0, E.TEE - 3.5, 3.3, 1), f = E.deliver(m, shot);
  E.runShot(f);
  assert.ok(f.st[0].out, 'the guard was knocked out');
  var res = E.resolve(m, f);
  assert.strictEqual(res.why, 'fgz');
  assert.deepStrictEqual(res.stones.map(function (s) { return [s.id, s.x, s.y]; }), [[7, 0, E.TEE - 3.5]]);
  // without the rule, or later in the end, the takeout stands
  m.fgz = false; assert.strictEqual(E.resolve(m, f).why, '');
  m.fgz = true; m.thrown = E.fgzRocks(m); assert.strictEqual(E.resolve(m, f).why, '');
});

test('scoring: closest team scores each stone inside the other side\'s best', function () {
  var T = E.TEE;
  assert.deepStrictEqual(E.scoreEnd([]).pts, 0);
  var s = [{ id: 1, team: 0, x: 0, y: T + 0.1 }, { id: 2, team: 0, x: 0.5, y: T }, { id: 3, team: 1, x: -0.7, y: T }, { id: 4, team: 0, x: 1.0, y: T }];
  var r = E.scoreEnd(s);
  assert.strictEqual(r.team, 0); assert.strictEqual(r.pts, 2); assert.deepStrictEqual(r.order, [1, 2]);
  // a stone biting the 12-foot counts, one clear of it doesn't
  r = E.scoreEnd([{ id: 1, team: 1, x: E.R12 + E.R - 0.01, y: T }, { id: 2, team: 0, x: 0, y: T - E.R12 - E.R - 0.05 }]);
  assert.strictEqual(r.team, 1); assert.strictEqual(r.pts, 1);
});

test('match flow: throw order, hammer, ends, extra end', function () {
  var m = E.newMatch({ seed: 9, ends: 4, spe: 4 });
  var first = 1 - m.hammer;
  assert.strictEqual(E.toThrow(m), first);
  assert.strictEqual(E.stonesLeft(m, first), 4); assert.strictEqual(E.stonesLeft(m, m.hammer), 4);
  m.thrown = 3; assert.strictEqual(E.stonesLeft(m, first), 2); assert.strictEqual(E.stonesLeft(m, m.hammer), 3);
  m.thrown = 0;
  var order = [];
  for (var i = 0; i < 8; i++) {
    var team = E.toThrow(m); order.push(team);
    var f = E.deliver(m, { th: 0, v: 1.0, turn: 1 }); E.runShot(f);
    var info = E.finishShot(m, f);
    assert.strictEqual(info.res.why, 'hog');
  }
  assert.deepStrictEqual(order, [first, 1 - first, first, 1 - first, first, 1 - first, first, 1 - first]);
  assert.strictEqual(m.end, 2); assert.strictEqual(m.log[0].pts, 0);
  assert.strictEqual(m.hammer, 1 - first, 'blank end: hammer kept');
  // the hammer team scores → the other side gets it
  var hm = m.hammer;
  for (i = 0; i < 8; i++) {
    var t2 = E.toThrow(m), sh = t2 === hm && i === 7 ? E.solveDraw(0, E.TEE, 1) : { th: 0, v: 1, turn: 1 };
    f = E.deliver(m, sh); E.runShot(f); info = E.finishShot(m, f);
  }
  assert.ok(info.endDone && info.end.team === hm && info.end.pts === 1);
  assert.strictEqual(m.score[hm], 1); assert.strictEqual(m.hammer, 1 - hm);
  // tied after the last end → an extra end; then decided
  m.end = 4; m.score = [2, 2]; m.thrown = 7; m.stones = [];
  f = E.deliver(m, { th: 0, v: 1, turn: 1 }); E.runShot(f); info = E.finishShot(m, f);
  assert.ok(!m.over && m.end === 5, 'extra end');
  m.thrown = 7; m.stones = [];
  var t3 = E.toThrow(m);
  f = E.deliver(m, E.solveDraw(0, E.TEE, -1)); E.runShot(f); info = E.finishShot(m, f);
  assert.ok(m.over && m.winner === t3 && info.over);
});

test('the CPU picks legal shots and takes out an open shot stone', function () {
  var m = E.newMatch({ seed: 12, ends: 4, spe: 6 });
  m.thrown = 9;
  var team = E.toThrow(m);
  m.stones = [{ id: 1, team: 1 - team, x: 0.05, y: E.TEE }];
  var p = E.cpuPlan(m, 2, 77);
  assert.ok(p.shot.v >= E.V_MIN - 0.5 && p.shot.v <= E.V_MAX + 0.5 && Math.abs(p.shot.th) < 0.1, 'legal');
  assert.ok(p.plan.kind === 'hit' || p.plan.label === 'Freeze' || /Draw/.test(p.plan.label), p.plan.label);
  var f = E.deliver(m, p.shot); E.runShot(f, function (ff) { return E.cpuSweep(ff, p.plan, p.plan.tol); });
  var sc = E.scoreEnd(E.resolve(m, f).stones);
  assert.strictEqual(sc.team, team, 'the elite CPU lies shot afterwards (' + p.plan.label + ')');
});

test('the CPU guards early without the hammer and the plan is deterministic', function () {
  var m = E.newMatch({ seed: 21, spe: 8 });
  var a = E.cpuPlan(m, 1, 5), b = E.cpuPlan(m, 1, 5);
  assert.deepStrictEqual(a.shot, b.shot);
  var m2 = E.newMatch({ seed: 21, spe: 8 }), kinds = {};
  for (var s = 1; s < 8; s++) kinds[E.cpuPlan(m2, 2, s).plan.kind] = 1;
  assert.ok(kinds.guard, 'leads with a guard: ' + Object.keys(kinds));
});

test('a whole CPU vs CPU match plays out, fast enough', function () {
  var m = E.newMatch({ seed: 33, ends: 4, spe: 4 }), t0 = Date.now(), n = 0, maxMs = 0;
  while (!m.over && n < 200) {
    var t1 = Date.now(), p = E.cpuPlan(m, n % 3, 1000 + n);
    maxMs = Math.max(maxMs, Date.now() - t1);
    var f = E.deliver(m, p.shot); E.runShot(f, function (ff) { return E.cpuSweep(ff, p.plan, p.plan.tol); });
    E.finishShot(m, f); n++;
    m.stones.forEach(function (s) { assert.ok(!E.isOut(s)); });
  }
  assert.ok(m.over, 'finished'); assert.ok(n >= 32);
  assert.ok(maxMs < 1500, 'slowest plan ' + maxMs + ' ms');
  assert.ok(m.score[0] + m.score[1] > 0, 'someone scored');
});

test('saves and matches normalise defensively', function () {
  var s = E.normSave(null);
  assert.strictEqual(s.opts.ends, 6); assert.strictEqual(s.rec.wins.length, 3);
  s = E.normSave({ opts: { mode: '2p', level: 9, ends: 5, spe: 8, fgz: false, guide: 'x' }, rec: { games: '4', wins: [1, 'a', -3], bigEnd: -1 } });
  assert.strictEqual(s.opts.mode, '2p'); assert.strictEqual(s.opts.level, 2); assert.strictEqual(s.opts.ends, 6); assert.strictEqual(s.opts.spe, 8);
  assert.strictEqual(s.opts.fgz, false); assert.strictEqual(s.opts.guide, 'line');
  assert.deepStrictEqual(s.rec.wins, [1, 0, 0]); assert.strictEqual(s.rec.games, 4); assert.strictEqual(s.rec.bigEnd, 0);
  assert.strictEqual(E.normMatch(null), null); assert.strictEqual(E.normMatch({ v: 2 }), null);
  var m = E.newMatch({ seed: 3, ends: 8 }); m.stones = [{ id: 2, team: 0, x: 0, y: E.TEE }, { id: 3, team: 5, x: 0, y: 1 }, { id: 4, team: 1, x: 9, y: E.TEE }];
  m.thrown = 3; m.score = [2, 1];
  var n = E.normMatch(JSON.parse(JSON.stringify(m)));
  assert.strictEqual(n.ends, 8); assert.strictEqual(n.thrown, 3); assert.deepStrictEqual(n.score, [2, 1]); assert.strictEqual(n.stones.length, 1);
  var rec = E.newSave();
  m.over = true; m.winner = 0; m.level = 2;
  assert.ok(E.settle(rec, m).win); assert.strictEqual(rec.rec.wins[2], 1);
});

test('the CPU plan sliced over many frames matches the plan made at once', function () {
  var m = E.newMatch({ seed: 21, level: 2, spe: 8 }), r = E.rng(5), id = 1;
  m.thrown = 9;
  for (var i = 0; i < 9; i++) m.stones.push({ id: id++, team: i % 2, x: (r() - 0.5) * 2.6, y: E.TEE - 4 + r() * 5 });
  m.nextId = id;
  var whole = E.cpuPlan(m, 2, 77), J = E.cpuJob(m, 2, 77), res = null, slices = 0;
  while (!(res = E.cpuWork(J, 0))) slices++;
  assert.ok(slices > 10, 'work was actually sliced: ' + slices);
  assert.deepStrictEqual(res.shot, whole.shot); assert.strictEqual(res.plan.label, whole.plan.label);
  assert.ok(Math.abs(res.shot.th) < 0.12 && res.shot.v > 0.5 && res.shot.v < 5.6);
});

test('hog line: a stone that stops short after hitting a stone stays in play', function () {
  var m = E.newMatch({ seed: 1, fgz: false });
  // a stone sitting just past the hog line, hit softly so the shooter stops short of it
  m.stones = [{ id: 1, team: 1, x: 0, y: E.HOG + E.R + 0.02 }]; m.nextId = 2; m.thrown = 1;
  var f = E.deliver(m, E.solveDraw(0, E.HOG + 0.2, 1));
  E.runShot(f);
  assert.ok(f.hit, 'it touched the stone');
  assert.ok(f.d.y - E.R <= E.HOG, 'the shooter is short of the hog line: ' + f.d.y);
  var res = E.resolve(m, f);
  assert.strictEqual(res.why, '');
  assert.strictEqual(res.stones.length, 2);
});

test('free guard zone: own guards are fair game, and the rule ends after the early stones or when off', function () {
  function guardHit(thrown, fgz, ownGuard) {
    var m = E.newMatch({ seed: 2, fgz: fgz, spe: 6 });
    m.hammer = 1; m.thrown = thrown;
    var team = E.toThrow(m), gt = ownGuard ? team : 1 - team;
    m.stones = [{ id: 1, team: gt, x: 0, y: E.TEE - 3.5 }]; m.nextId = 2;
    var f = E.deliver(m, { th: 0, v: 3.6, turn: 1 });
    E.runShot(f);
    return E.resolve(m, f);
  }
  assert.strictEqual(guardHit(2, true, false).why, 'fgz');
  assert.strictEqual(guardHit(2, true, true).why, '', 'own guard can be removed');
  assert.strictEqual(guardHit(5, true, false).why, '', 'the sixth stone may remove it');
  assert.strictEqual(guardHit(2, false, false).why, '', 'rule off');
  var r = guardHit(2, true, false);
  assert.strictEqual(r.stones.length, 1); assert.strictEqual(r.stones[0].id, 1);
  near(r.stones[0].y, E.TEE - 3.5, 1e-9, 'guard put back');
});

test('a resumed match never reuses a stone id', function () {
  var m = E.newMatch({ seed: 4 });
  m.stones = [{ id: 7, team: 0, x: 0, y: E.TEE }]; m.nextId = 3; m.thrown = 1;
  var n = E.normMatch(JSON.parse(JSON.stringify(m)));
  assert.ok(n.nextId > 7, 'nextId ' + n.nextId);
});

test('a tied match goes to extra ends and only then can end level', function () {
  var m = E.newMatch({ seed: 9, ends: 4, spe: 4 });
  var blank = { st: [], d: E.mkStone(99, 0, 0, 0), snap: [], team: 0, hit: false };
  blank.d.out = true;
  var info, guard = 0;
  while (!m.over && guard++ < 200) {
    var f = E.deliver(m, { th: 0.3, v: 3, turn: 1 }); E.runShot(f);      // every stone goes wide: blank ends
    info = E.finishShot(m, f);
  }
  assert.ok(m.over); assert.strictEqual(m.winner, -1); assert.strictEqual(m.end, 8);
  assert.deepStrictEqual(m.score, [0, 0]);
  assert.strictEqual(m.log.length, 7);
});

console.log(passed + ' passed');
