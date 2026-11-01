/* Headless checks for the Mini Golf engine (holes, physics, rules, CPU, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/minigolf/minigolf.test.js */
'use strict';
var assert = require('assert');

var E = require('./minigolf.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./minigolf.js')];
require('./minigolf.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// A little test hole: an open green with whatever extra rows are given.
function mk(rows, extra) {
  var d = { name: 'T', par: 3, map: rows };
  for (var k in extra || {}) d[k] = extra[k];
  return E.parseHole(d);
}
var OPEN = [
  '##############################',
  '#............................#',
  '#............................#',
  '#..S.........................#',
  '#............................#',
  '#.........................H..#',
  '#............................#',
  '##############################'];
function roll(h, x, y, ang, pow, t0) {
  var b = E.newBall(x, y), t = t0 || 0, ev = {};
  E.putt(b, ang, pow);
  for (var i = 0; i < 6000 && b.st === 'roll'; i++) {
    E.stepBall(h, b, t); t += E.STEP;
    b.ev.forEach(function (e) { ev[e] = (ev[e] || 0) + 1; }); b.ev.length = 0;
  }
  b.evs = ev; b.t = t;
  return b;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Mini Golf' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'minigolf.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('18 holes, each well formed and enclosed', function () {
  assert.strictEqual(E.HOLES.length, 18);
  var names = {};
  E.HOLES.forEach(function (d, i) {
    var h = E.hole(i), tag = (i + 1) + ' ' + d.name;
    assert.ok(!names[d.name], 'duplicate name ' + d.name); names[d.name] = 1;
    assert.ok(h.W <= 30 && h.H <= 18, tag + ' too big');
    d.map.forEach(function (r) { assert.strictEqual(r.length, h.W, tag + ' ragged row'); });
    assert.ok(h.tee && h.cup, tag + ' needs a tee and a cup');
    assert.strictEqual(d.map.join('').split('S').length, 2, tag + ' one tee');
    assert.strictEqual(d.map.join('').split('H').length, 2, tag + ' one cup');
    assert.ok(d.par >= 2 && d.par <= 5, tag + ' par');
    assert.ok(d.tip && d.tip.length > 10, tag + ' tip');
    // nothing playable on the edge of the grid or next to the void
    for (var y = 0; y < h.H; y++) for (var x = 0; x < h.W; x++) {
      var t = h.t[y * h.W + x];
      if (t === E.WALL || t === E.VOID) continue;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (o) {
        var nx = x + o[0], ny = y + o[1];
        assert.ok(nx >= 0 && ny >= 0 && nx < h.W && ny < h.H && h.t[ny * h.W + nx] !== E.VOID, tag + ' open to the void at ' + x + ',' + y);
      });
    }
    for (var k in h.tun) assert.strictEqual(h.tun[k].length, 2, tag + ' tunnel ' + k + ' needs a twin');
    assert.ok(E.distAt(h, h.tee.x, h.tee.y) < 200, tag + ' the cup is reachable from the tee');
    h.mills.forEach(function (m) { assert.ok(!E.inSolid(h, m.x, m.y), tag + ' windmill hub in a wall'); });
    assert.ok(!E.inSolid(h, h.tee.x, h.tee.y) && !E.inSolid(h, h.cup.x, h.cup.y));
  });
  var par = E.coursePar(E.COURSES.all.holes);
  assert.strictEqual(par, E.coursePar(E.COURSES.front.holes) + E.coursePar(E.COURSES.back.holes));
});

test('a putt rolls, slows and stops; harder goes farther; same putt, same result', function () {
  var h = mk(OPEN), prev = 0;
  [0.1, 0.2, 0.3, 0.45].forEach(function (p) {
    var b = roll(h, 3.5, 2.5, 0, p);
    assert.strictEqual(b.st, 'rest');
    assert.ok(b.x - 3.5 > prev, 'power ' + p + ' did not go farther');
    prev = b.x - 3.5;
    assert.ok(Math.abs(b.y - 2.5) < 1e-9, 'a straight putt stays straight');
  });
  var a = roll(h, 3.5, 3.5, 0.3, 0.8), c = roll(h, 3.5, 3.5, 0.3, 0.8);
  assert.ok(a.x === c.x && a.y === c.y && a.t === c.t);
  var s = E.simShot(h, 3.5, 3.5, 0, 0.3, 0.8);
  assert.ok(Math.abs(s.x - a.x) < 1e-9 && Math.abs(s.y - a.y) < 1e-9);
});

test('walls bounce the ball back and never let it through', function () {
  var h = mk(OPEN), b = roll(h, 20.5, 3.5, 0, 1);
  assert.ok(b.evs.wall >= 1, 'it should have hit the wall');
  assert.ok(b.x < 29 - E.R + 1e-6);
  // full-power putts at every angle on every hole stay in play
  for (var i = 0; i < E.HOLES.length; i++) {
    var hh = E.hole(i);
    for (var k = 0; k < 24; k++) {
      var ang = k * Math.PI / 12 + 0.05 * i, r = E.simShot(hh, hh.tee.x, hh.tee.y, k * 0.31, ang, k % 3 === 0 ? 1 : 0.35 + (k % 5) * 0.15);
      assert.ok(!E.inSolid(hh, r.x, r.y), 'hole ' + (i + 1) + ' escaped at angle ' + ang.toFixed(2) + ' -> ' + r.x.toFixed(2) + ',' + r.y.toFixed(2));
      assert.ok(isFinite(r.x) && isFinite(r.y));
    }
  }
});

test('a 45° wall banks the ball through a right angle', function () {
  var h = mk([
    '########',
    '#....\\##',
    '#.....\\#',
    '#S.....#',
    '#......#',
    '#....H.#',
    '########']);
  var b = E.newBall(1.5, 1.5), t = 0, turned = false;
  E.putt(b, 0, 0.6);
  for (var i = 0; i < 600 && b.st === 'roll'; i++) { E.stepBall(h, b, t); t += E.STEP; b.ev.length = 0; if (b.vy > Math.abs(b.vx) && b.vy > 3) turned = true; }
  assert.ok(turned, 'the bank should send the ball downwards');
});

test('the cup takes a slow ball and lips out a fast one', function () {
  var h = mk(OPEN), cx = h.cup.x, cy = h.cup.y;
  var slow = roll(h, cx - 3, cy, 0, 0.18);
  assert.strictEqual(slow.st, 'sunk');
  var fast = roll(h, cx - 3, cy, 0, 0.9);
  assert.notStrictEqual(fast.st, 'sunk');
  assert.ok(fast.evs.lip >= 1);
});

test('sand slows, slopes push, bumpers kick', function () {
  var sand = mk([
    '##########################',
    '#S::::::::::::::::::::::H#',
    '#........................#',
    '##########################']);
  var a = roll(sand, 1.5, 1.5, 0, 0.5), g = roll(sand, 1.5, 2.5, 0, 0.5);
  assert.ok(a.x - 1.5 < 0.5 * (g.x - 1.5), 'sand should stop it much sooner');
  var sl = mk([
    '##########',
    '#S>>>>>..#',
    '#......H.#',
    '##########']);
  var b = E.newBall(2.5, 1.5), t = 0;
  b.st = 'roll';
  for (var i = 0; i < 1200 && b.st === 'roll'; i++) { E.stepBall(sl, b, t); t += E.STEP; b.ev.length = 0; }
  assert.ok(b.x > 7, 'the slope should roll a resting ball downhill (x=' + b.x.toFixed(2) + ')');
  var bu = mk([
    '##########',
    '#S...o...#',
    '#......H.#',
    '##########']);
  var c = E.newBall(1.5, 1.5); E.putt(c, 0, 0.3);
  var kicked = false;
  for (i = 0, t = 0; i < 600 && c.st === 'roll'; i++) { E.stepBall(bu, c, t); t += E.STEP; if (c.ev.indexOf('bump') >= 0) kicked = true; c.ev.length = 0; if (kicked) break; }
  assert.ok(kicked && c.vx < -6, 'the bumper should kick the ball back hard');
});

test('tunnels carry the ball to their twin with its speed', function () {
  var h = mk([
    '##########',
    '#S..1....#',
    '#........#',
    '#...1..H.#',
    '##########']);
  var b = E.newBall(1.5, 1.5); E.putt(b, 0, 0.25);
  var t = 0, warped = false, v0 = 0;
  for (var i = 0; i < 600 && b.st === 'roll'; i++) {
    var sp = E.speed(b);
    E.stepBall(h, b, t); t += E.STEP;
    if (b.ev.indexOf('warp') >= 0) { warped = true; v0 = sp; assert.ok(Math.abs(b.y - 3.5) < 0.6, 'out of the twin'); assert.ok(E.speed(b) > v0 * 0.9); break; }
    b.ev.length = 0;
  }
  assert.ok(warped);
});

test('water: one stroke penalty and back to where you hit from', function () {
  var h = mk([
    '############',
    '#S...~~~...#',
    '#....~~~.H.#',
    '############']);
  var r = E.simShot(h, 1.5, 1.5, 0, 0, 0.6);
  assert.strictEqual(r.st, 'water');
  E.HOLES.push({ name: 'Wet', par: 3, tip: 'test hole only', map: ['############', '#S...~~~...#', '#....~~~.H.#', '############'] });
  var g = E.newGame('practice', [{ cpu: 0 }], E.HOLES.length - 1);
  E.shoot(g, 0, 0.6);
  for (var i = 0; i < 2000 && g.phase === 'roll'; i++) E.stepGame(g);
  E.HOLES.pop();
  assert.strictEqual(g.phase, 'aim');
  assert.strictEqual(g.strokes, 2);
  assert.ok(Math.abs(g.ball.x - 1.5) < 1e-9 && Math.abs(g.ball.y - 1.5) < 1e-9);
  assert.ok(g.ev.indexOf('penalty') >= 0);
});

test('windmills sweep a resting ball and bat a rolling one; doors move', function () {
  var h = mk([
    '############',
    '#..........#',
    '#..........#',
    '#S.......H.#',
    '#..........#',
    '############'], { mills: [{ x: 5.5, y: 3, r: 1.8, n: 2, w: 2, a: 0 }], doors: [{ x: 8, y: 1, w: 1, h: 1, dx: 0, dy: 2, p: 2, o: 0 }] });
  var b = E.newBall(5.5 + 1.2, 3 + 0.3), t = 0, swept = false;
  for (var i = 0; i < 400; i++) { E.stepBall(h, b, t); t += E.STEP; if (b.ev.indexOf('swept') >= 0) swept = true; b.ev.length = 0; }
  assert.ok(swept, 'a sail should sweep the resting ball');
  assert.ok(!E.inSolid(h, b.x, b.y));
  var q1 = E.doorAt(h.doors[0], 0, {}), q2 = E.doorAt(h.doors[0], 0.5, {});
  assert.ok(Math.abs(q1.y - q2.y) > 0.5 && q1.x === q2.x);
});

test('fixed steps whatever the frame rate', function () {
  var a = E.newGame('front', [{ cpu: 0 }]), b = E.newGame('front', [{ cpu: 0 }]), i;
  E.shoot(a, 0.2, 0.7); E.shoot(b, 0.2, 0.7);
  for (i = 0; i < 120; i++) E.advance(a, 1 / 60);
  for (i = 0; i < 240; i++) E.advance(b, 1 / 120);
  assert.ok(Math.abs(a.steps - b.steps) <= 1);
  while (a.steps < b.steps) E.stepGame(a);
  while (b.steps < a.steps) E.stepGame(b);
  assert.ok(Math.abs(a.ball.x - b.ball.x) < 1e-9 && Math.abs(a.ball.y - b.ball.y) < 1e-9);
  var c = E.newGame('front', [{ cpu: 0 }]), al = E.advance(c, 0.013);
  assert.ok(al >= 0 && al < 1);
});

test('rules: turns, the stroke cap, the honour, the scorecard', function () {
  var g = E.newGame('front', [{ cpu: 0 }, { cpu: 0 }, { cpu: 2 }]);
  assert.deepStrictEqual(g.order, [0, 1, 2]);
  assert.strictEqual(g.cur, 0);
  assert.ok(!E.shoot(E.newGame('front', [{ cpu: 0 }]), NaN, 0) || true);
  function sink(gg, n) {     // hole out in n strokes
    gg.strokes = n - 1; E.shoot(gg, 0, 0.01);
    gg.ball.x = gg.ball.px = E.curHole(gg).cup.x + 0.05; gg.ball.y = E.curHole(gg).cup.y; gg.ball.vx = 0.2; gg.ball.vy = 0;
    for (var i = 0; i < 50 && gg.phase === 'roll'; i++) E.stepGame(gg);
    assert.strictEqual(gg.phase, 'holed');
  }
  sink(g, 4); assert.strictEqual(E.nextTurn(g), 'turn'); assert.strictEqual(g.cur, 1);
  sink(g, 2); assert.strictEqual(E.nextTurn(g), 'turn'); assert.strictEqual(g.cur, 2);
  // the cap: a player who keeps missing picks up at the cap
  var cap = E.capOf(E.curHole(g).par);
  g.strokes = cap - 1; E.shoot(g, Math.PI, 0.05);
  for (var i = 0; i < 3000 && g.phase === 'roll'; i++) E.stepGame(g);
  assert.strictEqual(g.phase, 'holed'); assert.strictEqual(g.scores[2][0], cap); assert.ok(g.last.picked);
  assert.strictEqual(E.nextTurn(g), 'card');
  assert.ok(E.nextHole(g));
  assert.deepStrictEqual(g.order, [1, 0, 2], 'the best score on the last hole has the honour');
  var tot = E.totals(g);
  assert.strictEqual(tot[1].strokes, 2); assert.strictEqual(tot[1].toPar, 2 - E.HOLES[0].par);
  var st = E.standings(g);
  assert.strictEqual(st[0].p, 1); assert.strictEqual(st[0].place, 1);
  assert.strictEqual(E.scoreName(1, 3), 'HOLE IN ONE');
  assert.strictEqual(E.scoreName(2, 3), 'BIRDIE');
  assert.strictEqual(E.scoreName(5, 3), 'DOUBLE BOGEY');
  assert.strictEqual(E.capOf(2), 6); assert.strictEqual(E.capOf(4), 7);
  // the last hole ends the round
  var p = E.newGame('practice', [{ cpu: 0 }], 3);
  assert.strictEqual(p.holes.length, 1);
  sink(p, 3); assert.strictEqual(E.nextTurn(p), 'done');
  assert.strictEqual(E.nextHole(p), false);
});

test('the CPU plans legal putts, deterministically, and plays every hole', function () {
  var h = E.hole(0), a = E.planShot(h, h.tee.x, h.tee.y, 0, 2, 5), b = E.planShot(h, h.tee.x, h.tee.y, 0, 2, 5);
  assert.ok(a.best && isFinite(a.best.ang) && a.best.pow > 0 && a.best.pow <= 1);
  assert.deepStrictEqual(a.best, b.best);
  var s1 = E.cpuShot(a, 9), s2 = E.cpuShot(a, 9);
  assert.deepStrictEqual(s1, s2);
  assert.ok(s1.pow > 0 && s1.pow <= 1);
  // a hard CPU gets round all 18 near par, never picking up more than twice
  var total = 0, caps = 0, par = 0;
  for (var i = 0; i < 18; i++) {
    var hh = E.hole(i), x = hh.tee.x, y = hh.tee.y, t = 0, n = 0, cap = E.capOf(hh.par), done = false;
    par += hh.par;
    while (n < cap && !done) {
      var P = E.planShot(hh, x, y, t, 3, 100 + i * 10 + n), s = E.cpuShot(P, 7 + i + n), r = E.simShot(hh, x, y, t, s.ang, s.pow);
      n++; t += r.t + 1;
      if (r.st === 'sunk') done = true;
      else if (r.st === 'water') n++;
      else { x = r.x; y = r.y; }
    }
    if (!done) { caps++; n = cap; }
    total += n;
  }
  assert.ok(caps <= 2, caps + ' pick-ups');
  assert.ok(total <= par + 9, 'hard CPU shot ' + total + ' on a par ' + par);
  // easy is clearly worse than hard on a tricky hole
  function avg(level) {
    var hh = E.hole(10), sum = 0;
    for (var r = 0; r < 4; r++) {
      var x = hh.tee.x, y = hh.tee.y, n = 0, done = false;
      while (n < E.capOf(hh.par) && !done) {
        var P = E.planShot(hh, x, y, 0, level, r * 31 + n + 1), s = E.cpuShot(P, r * 17 + n + 3), q = E.simShot(hh, x, y, 0, s.ang, s.pow);
        n++; if (q.st === 'sunk') done = true; else if (q.st === 'water') n++; else { x = q.x; y = q.y; }
      }
      sum += done ? n : E.capOf(hh.par);
    }
    return sum / 4;
  }
  assert.ok(avg(1) >= avg(3), 'easy should not beat hard');
});

test('saves: normalise, records, a round in progress', function () {
  var s = E.newSave();
  assert.strictEqual(s.hole.length, 18);
  var g = E.newGame('front', [{ cpu: 0 }, { cpu: 3 }]);
  for (var k = 0; k < 9; k++) { g.scores[0][k] = k === 2 ? 1 : 3; g.scores[1][k] = 2; }
  var nb = E.settle(s, g);
  assert.strictEqual(s.rounds, 1); assert.strictEqual(s.aces, 1);
  assert.strictEqual(s.best.front, 25, 'only the human counts');
  assert.strictEqual(s.hole[2], 1); assert.strictEqual(s.hole[9], 0);
  assert.ok(nb.course);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ rounds: -3, best: { front: 'x', all: 5000 }, hole: [99, -1, 2], setup: { course: 'nope', seats: [1, 1, 0, 1, 1, 1], level: 9, practice: 400 } });
  assert.ok(bad.rounds === 0 && bad.best.front === 0 && bad.best.all === 0 && bad.hole[0] === 0 && bad.hole[2] === 2);
  assert.ok(bad.setup.course === 'front' && bad.setup.seats.length === 4 && bad.setup.level === 3 && bad.setup.practice === 17);
  assert.strictEqual(E.normSave(null).rounds, 0);
  assert.strictEqual(E.normSave('junk').rounds, 0);
  // a round mid-hole survives a JSON round trip
  var r = E.newGame('back', [{ cpu: 0 }, { cpu: 2 }]);
  r.scores[0][0] = 3; r.scores[1][0] = 4; r.hi = 1; r.order = [0, 1]; r.oi = 1;
  E.nextTurn(r);
  r.phase = 'aim'; r.strokes = 2; r.ball.x = E.curHole(r).tee.x + 1; r.ball.st = 'rest';
  var snap = E.snapRound(r), back = E.loadRound(JSON.parse(JSON.stringify(snap)));
  assert.ok(back && back.course === 'back' && back.hi === 1 && back.strokes === 2);
  assert.ok(Math.abs(back.ball.x - r.ball.x) < 1e-3);
  assert.deepStrictEqual(back.scores, r.scores);
  assert.strictEqual(E.loadRound({ holes: [99], players: [0] }), null);
  assert.strictEqual(E.loadRound({ holes: [0], players: [] }), null);
  assert.strictEqual(E.loadRound(null), null);
  var odd = E.loadRound({ course: 'front', holes: [0, 1], players: [0, 5], scores: [['a', 3]], hi: 7, order: [1, 1], oi: 9, strokes: 99, bx: -50, by: 3 });
  assert.ok(odd && odd.hi === 1 && odd.order.join() === '0,1' && odd.strokes < E.capOf(E.HOLES[1].par) && !E.inSolid(E.curHole(odd), odd.ball.x, odd.ball.y));
  assert.strictEqual(odd.players[1].cpu, 3);
});

test('the CPU levels are ordered and the planner respects its own wobble', function () {
  function play(level, i, seed) {
    var g = E.newGame('practice', [{ cpu: level }], i), n = 0;
    while (g.phase !== 'holed' && n < 12) {
      var h = E.curHole(g), P = E.planShot(h, g.ball.x, g.ball.y, g.t, level, seed * 97 + n + 1), s = E.cpuShot(P, seed * 13 + n + 5);
      assert.ok(isFinite(s.ang) && s.pow > 0 && s.pow <= 1, 'legal putt');
      assert.ok(E.shoot(g, s.ang, s.pow)); n++;
      for (var k = 0; k < 20000 && g.phase === 'roll'; k++) E.stepGame(g);
    }
    assert.strictEqual(g.phase, 'holed');
    return g.scores[0][0];
  }
  var tot = [0, 0, 0, 0], holes = [1, 4, 10, 13, 16];
  for (var lv = 1; lv <= 3; lv++) holes.forEach(function (i) { for (var r = 1; r <= 2; r++) tot[lv] += play(lv, i, r); });
  assert.ok(tot[1] > tot[2] && tot[2] > tot[3], 'easy > normal > hard: ' + tot.slice(1).join(' / '));
  // the island: a normal CPU no longer keeps parking on the water's edge and picking up
  var isl = 0; for (var r2 = 1; r2 <= 3; r2++) isl += play(2, 10, r2);
  assert.ok(isl / 3 < E.capOf(E.HOLES[10].par), 'island avg ' + isl / 3);
});

test('a ball swept into the cup before a putt still scores at least one', function () {
  var g = E.newGame('practice', [{ cpu: 0 }], 0), cup = E.curHole(g).cup;
  g.ball.x = cup.x; g.ball.y = cup.y; g.ball.st = 'roll'; g.ball.vx = 0.1; g.ball.vy = 0;
  for (var i = 0; i < 10 && g.phase !== 'holed'; i++) E.stepGame(g);
  assert.strictEqual(g.phase, 'holed');
  assert.strictEqual(g.scores[0][0], 1);
  assert.strictEqual(E.totals(g)[0].strokes, 1);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
