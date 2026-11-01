/* Headless checks for the Bowling engine (scoring, pin physics, game flow, CPU, swipes, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/bowling/bowling.test.js */
'use strict';
var assert = require('assert');

var E = require('./bowling.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./bowling.js')];
require('./bowling.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function play(rolls) { return E.scoreGame(rolls); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Bowling' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'bowling.css');
  assert.strictEqual(widget._engine.HEAD_Z, E.HEAD_Z);
});

// ---- scoring ----
test('perfect game is 300, all gutters 0, all nines 90, all spares of 5 = 150', function () {
  var r = []; for (var i = 0; i < 12; i++) r.push(10);
  var s = play(r);
  assert.strictEqual(s.total, 300); assert.ok(s.done);
  assert.deepStrictEqual(s.frames[9].marks, ['X', 'X', 'X']);
  r = []; for (i = 0; i < 20; i++) r.push(0);
  s = play(r); assert.strictEqual(s.total, 0); assert.ok(s.done);
  assert.deepStrictEqual(s.frames[0].marks, ['-', '-']);
  r = []; for (i = 0; i < 10; i++) r.push(9, 0);
  assert.strictEqual(play(r).total, 90);
  r = []; for (i = 0; i < 21; i++) r.push(5);
  s = play(r); assert.strictEqual(s.total, 150); assert.ok(s.done);
  assert.deepStrictEqual(s.frames[3].marks, ['5', '/']);
  assert.deepStrictEqual(s.frames[9].marks, ['5', '/', '5']);
});

test('strike and spare bonuses, running totals and pending frames', function () {
  var s = play([10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1]);
  assert.strictEqual(s.total, 167);
  assert.deepStrictEqual(s.frames.map(function (f) { return f.total; }), [20, 39, 48, 66, 74, 84, 90, 120, 148, 167]);
  // a strike waits for two more balls
  s = play([10, 3]);
  assert.strictEqual(s.frames[0].total, null); assert.strictEqual(s.live, 13); assert.ok(!s.done);
  s = play([10, 3, 4]); assert.strictEqual(s.frames[0].total, 17); assert.strictEqual(s.total, 24);
  // a spare waits for one
  s = play([6, 4]); assert.strictEqual(s.frames[0].total, null);
  s = play([6, 4, 2]); assert.strictEqual(s.frames[0].total, 12);
});

test('10th frame: bonus balls only after a strike or spare; marks', function () {
  var base = []; for (var i = 0; i < 18; i++) base.push(0);
  var c = E.cursor(base.concat([3, 4]));
  assert.ok(c.done, 'open 10th ends the game');
  c = E.cursor(base.concat([3, 7]));
  assert.ok(!c.done && c.fresh && c.ball === 2, 'spare earns a fresh third ball');
  c = E.cursor(base.concat([10]));
  assert.ok(c.fresh && c.ball === 1);
  c = E.cursor(base.concat([10, 4]));
  assert.ok(!c.fresh && c.left === 6 && c.ball === 2);
  var s = play(base.concat([10, 4, 6]));
  assert.deepStrictEqual(s.frames[9].marks, ['X', '4', '/']); assert.strictEqual(s.total, 20);
  s = play(base.concat([10, 10, 7]));
  assert.deepStrictEqual(s.frames[9].marks, ['X', 'X', '7']); assert.strictEqual(s.total, 27);
  s = play(base.concat([0, 10, 10]));
  assert.deepStrictEqual(s.frames[9].marks, ['-', '/', 'X']); assert.strictEqual(s.total, 20);
});

test('cursor tracks frames and leaves; validRolls drops impossible rolls', function () {
  var c = E.cursor([]); assert.ok(c.frame === 0 && c.ball === 0 && c.fresh && c.left === 10);
  c = E.cursor([7]); assert.ok(c.frame === 0 && c.ball === 1 && !c.fresh && c.left === 3);
  c = E.cursor([7, 2, 10]); assert.ok(c.frame === 2 && c.ball === 0 && c.fresh);
  assert.deepStrictEqual(E.validRolls([7, 5, 3]), [7]);
  assert.deepStrictEqual(E.validRolls([10, 10, -1]), [10, 10]);
  var r = []; for (var i = 0; i < 15; i++) r.push(10);
  assert.strictEqual(E.validRolls(r).length, 12);
});

test('splits: head pin down and a gap between standing pins', function () {
  assert.ok(E.isSplit([7, 10]));
  assert.ok(E.isSplit([4, 6, 7, 10]));
  assert.ok(E.isSplit([3, 10]), 'baby split');
  assert.ok(E.isSplit([2, 7]));
  assert.ok(!E.isSplit([4, 5]), 'neighbours are no split');
  assert.ok(!E.isSplit([1, 7]), 'head pin standing');
  assert.ok(!E.isSplit([10]));
  assert.ok(!E.isSplit([6, 10]));
  assert.strictEqual(E.leaveName([7, 10]), 'the 7-10');
});

// ---- physics ----
test('the rack: ten pins on their spots, 12 inches apart', function () {
  var r = E.newRack();
  assert.strictEqual(r.length, 10);
  var a = r[0], b = r[1], c = r[2];
  assert.ok(Math.abs(Math.hypot(a.x - b.x, a.z - b.z) - 12) < 0.01);
  assert.ok(Math.abs(Math.hypot(b.x - c.x, b.z - c.z) - 12) < 0.01);
  assert.strictEqual(a.z, E.HEAD_Z);
  var leave = E.newRack([{ id: 7, x: -18.5, z: 752 }, 10, { id: 99 }]);
  assert.deepStrictEqual(leave.map(function (p) { return p.id; }), [7, 10]);
  assert.strictEqual(leave[0].x, -18.5);
});

test('the ball skids in the oil, hooks on the dry back end; faster hooks less', function () {
  var straight = E.pathAt({ x: 10, ang: 0, pow: 0.5, spin: 0 }, E.HEAD_Z);
  assert.ok(Math.abs(straight.x - 10) < 0.01, 'no spin, no hook');
  var oil = E.pathAt({ x: 10, ang: 0, pow: 0.5, spin: 1 }, E.OIL_END - 60), end = E.pathAt({ x: 10, ang: 0, pow: 0.5, spin: 1 }, E.HEAD_Z);
  assert.ok(10 - oil.x < 4, 'little hook in the oil: ' + oil.x);
  assert.ok(oil.x - end.x > 10, 'big hook on the back end: ' + end.x);
  var fast = E.pathAt({ x: 10, ang: 0, pow: 1, spin: 1 }, E.HEAD_Z);
  assert.ok(fast.x > end.x, 'a faster ball hooks less');
  var lefty = E.pathAt({ x: -10, ang: 0, pow: 0.5, spin: -1 }, E.HEAD_Z);
  assert.ok(Math.abs(lefty.x + end.x) < 1e-6, 'mirror image for the other hand');
});

test('a ball off the lane drops into the gutter and hits nothing', function () {
  var r = E.simulate(E.newRack(), { x: 17, ang: 0.06, pow: 0.5, spin: 0 }, 3);
  assert.strictEqual(r.count, 0); assert.ok(r.gutter); assert.strictEqual(r.standing.length, 10);
});

test('a pocket hit with hook carries well; a light hit leaves pins', function () {
  var thr = E.aimFor(2.5, 12, 0.6, 0.6), strikes = 0, pins = 0, N = 30;
  for (var k = 0; k < N; k++) { var r = E.simulate(E.newRack(), thr, k + 1); pins += r.count; if (r.count === 10) strikes++; }
  assert.ok(strikes >= N * 0.45, 'pocket strikes ' + strikes + '/' + N);
  assert.ok(pins / N > 9.2);
  var thin = E.aimFor(9.5, 9.5, 0.6, 0), tp = 0, ts = 0;
  for (k = 0; k < N; k++) { var q = E.simulate(E.newRack(), thin, k + 1); tp += q.count; if (q.count === 10) ts++; }
  assert.ok(tp / N < 9 && ts < N * 0.3, 'thin hit ' + tp / N + ' / ' + ts);
});

test('pin physics: momentum is bounded, pins never tunnel, everything comes to rest', function () {
  for (var k = 0; k < 12; k++) {
    var R = E.newRoll(E.newRack(), { x: (k % 5) * 3 - 6, ang: (k % 3 - 1) * 0.01, pow: (k % 4) / 3, spin: (k % 3 - 1) * 0.6 }, 100 + k);
    var maxV = 0;
    while (!R.done) {
      E.stepRoll(R);
      R.pins.forEach(function (p) {
        var v = Math.hypot(p.vx, p.vz); if (v > maxV) maxV = v;
        assert.ok(isFinite(p.x) && isFinite(p.z));
        if (!p.out) assert.ok(Math.abs(p.x) <= E.WALL + 0.5, 'pin through the kickback ' + p.x);
      });
      // standing pins never overlap
      var up = R.pins.filter(function (p) { return p.up && !p.out; });
      for (var i = 0; i < up.length; i++) for (var j = i + 1; j < up.length; j++) assert.ok(Math.hypot(up[i].x - up[j].x, up[i].z - up[j].z) > 2 * E.PIN_R - 0.6);
      R.events.length = 0; R.hits.length = 0;
    }
    assert.ok(maxV < 2 * E.V_MAX, 'pin speed ' + maxV);
    assert.ok(R.t < E.MAX_T + 0.01);
    R.pins.forEach(function (p) { assert.ok(p.up || p.out || p.u === 1); });
  }
});

test('a roll is deterministic for its seed; the step is fixed whatever the frame rate', function () {
  var thr = { x: 8, ang: -0.01, pow: 0.7, spin: 0.5 };
  var a = E.simulate(E.newRack(), thr, 42), b = E.simulate(E.newRack(), thr, 42);
  assert.deepStrictEqual(a, b);
  var R1 = E.newRoll(E.newRack(), thr, 9), R2 = E.newRoll(E.newRack(), thr, 9), i;
  for (i = 0; i < 300; i++) E.advanceRoll(R1, 1 / 60);
  for (i = 0; i < 600; i++) E.advanceRoll(R2, 1 / 120);
  assert.ok(Math.abs(R1.steps - R2.steps) <= 1);
  assert.ok(Math.abs(R1.ball.z - R2.ball.z) < 3);
  var R3 = E.newRoll(E.newRack(), thr, 9), al = E.advanceRoll(R3, 0.0061);
  assert.ok(al >= 0 && al < 1);
});

test('second ball: only the leave is in play', function () {
  var leave = E.newRack([{ id: 10, x: 18, z: E.spot(10).z }]);
  var r = E.simulate(leave, E.aimFor(18, -10, 0.85, 0), 5);
  assert.ok(r.count <= 1 && r.standing.length + r.count === 1);
});

// ---- games ----
test('a game: turns frame by frame, racks, the 10th, game over', function () {
  var g = E.newGame([{ kind: 'h', name: 'A' }, { kind: 'c', lvl: 2 }], 7);
  assert.strictEqual(E.turnOf(g), 0);
  var info = E.applyRoll(g, { standing: E.newRack([7, 10]).map(function (p) { return { id: p.id, x: p.x, z: p.z }; }) });
  assert.ok(info.split && info.count === 8 && !info.frameDone);
  assert.strictEqual(E.turnOf(g), 0, 'same bowler for the second ball');
  assert.deepStrictEqual(E.rackFor(g).map(function (p) { return p.id; }), [7, 10]);
  info = E.applyRoll(g, { standing: [] });
  assert.ok(info.spare && info.frameDone);
  assert.strictEqual(E.turnOf(g), 1);
  assert.strictEqual(E.rackFor(g).length, 10);
  info = E.applyRoll(g, { standing: [] });
  assert.ok(info.strike && info.frameDone);
  assert.strictEqual(E.turnOf(g), 0);
  // finish both with strikes
  var guard = 0;
  while (!g.over && guard++ < 100) E.applyRoll(g, { standing: [] });
  assert.ok(g.over && E.turnOf(g) === -1);
  assert.strictEqual(E.scoreGame(g.players[1].rolls).total, 300);
  assert.strictEqual(E.scoreGame(g.players[0].rolls).total, 20 + 8 * 30 + 30);
});

test('a full game with real physics and CPU bowlers ends with legal scores', function () {
  E.cpuForget();
  var g = E.newGame([{ kind: 'c', lvl: 3 }, { kind: 'c', lvl: 0 }], 11), n = 0;
  while (!g.over && n++ < 60) {
    var t = E.turnOf(g), pins = E.rackFor(g), seed = E.seedFor(g);
    var thr = E.cpuThrow(pins.map(function (p) { return { id: p.id, x: p.x, z: p.z }; }), g.players[t].lvl, 'r', seed);
    assert.ok(Math.abs(thr.x) <= E.X_MAX && Math.abs(thr.ang) <= E.ANG_MAX && thr.pow >= 0 && thr.pow <= 1 && Math.abs(thr.spin) <= 1, 'legal throw');
    var res = E.simulate(pins, thr, seed);
    var info = E.applyRoll(g, res);
    assert.ok(info.count >= 0 && info.count <= 10);
  }
  assert.ok(g.over);
  g.players.forEach(function (P) {
    var s = E.scoreGame(P.rolls);
    assert.ok(s.done && s.total >= 0 && s.total <= 300);
    assert.deepStrictEqual(E.validRolls(P.rolls), P.rolls);
  });
});

test('CPU levels: an Ace outbowls a Rookie', function () {
  E.cpuForget();
  function avg(lvl, games) {
    var tot = 0;
    for (var k = 0; k < games; k++) {
      var g = E.newGame([{ kind: 'c', lvl: lvl }], 500 + k);
      while (!g.over) { var pins = E.rackFor(g), seed = E.seedFor(g); E.applyRoll(g, E.simulate(pins, E.cpuThrow(pins, lvl, 'r', seed), seed)); }
      tot += E.scoreGame(g.players[0].rolls).total;
    }
    return tot / games;
  }
  var rookie = avg(0, 3), ace = avg(3, 3);
  assert.ok(ace > rookie + 40, 'ace ' + ace + ' vs rookie ' + rookie);
  assert.ok(rookie > 30, 'rookie still knocks pins: ' + rookie);
});

test('the CPU planner is deterministic and steps incrementally', function () {
  E.cpuForget();
  var a = E.cpuThrow(E.newRack(), 2, 'r', 77);
  E.cpuForget();
  var pl = E.cpuPlanner(E.newRack(), 2, 'r', 77), steps = 0;
  while (!E.cpuStep(pl, 1)) steps++;
  assert.ok(steps > 3);
  assert.deepStrictEqual(E.cpuExecute(pl), a);
});

test('saved games normalise defensively', function () {
  assert.strictEqual(E.normGame(null), null);
  assert.strictEqual(E.normGame({ players: [] }), null);
  var g = E.normGame({ seed: 5, players: [{ kind: 'h', name: 'Ann', rolls: [10, 7, 2, 9, 9, 'x'], sp: [0, 1] }, { kind: 'c', lvl: 9, rolls: [3] }, {}, {}, { kind: 'h' }] });
  assert.strictEqual(g.players.length, 4);
  assert.deepStrictEqual(g.players[0].rolls, [10, 7, 2, 9]);
  assert.strictEqual(g.players[1].lvl, 3);
  assert.strictEqual(g.players[0].sp[1], 1);
  // whose turn and the rebuilt leave
  assert.strictEqual(E.turnOf(g), 1, 'the bowler mid-frame goes on');
  var g2 = E.normGame({ players: [{ kind: 'h', rolls: [8] }], rack: [{ id: 7, x: -18, z: 751 }, { id: 7, x: 0, z: 0 }, { id: 10, x: 18, z: 751.2 }] });
  assert.deepStrictEqual(g2.rack.map(function (p) { return p.id; }), [7, 10]);
  var g3 = E.normGame({ players: [{ kind: 'h', rolls: [8] }], rack: [{ id: 3, x: 6, z: 730 }] });
  assert.strictEqual(g3.rack.length, 2, 'a leave that does not match the count is rebuilt');
  var round = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.deepStrictEqual(round.players.map(function (P) { return P.rolls; }), g.players.map(function (P) { return P.rolls; }));
});

test('swipes: up the screen bowls; direction aims, speed is power, the bow hooks', function () {
  function stroke(dx, h, ms, bow) {
    var pts = [], n = 12;
    for (var i = 0; i <= n; i++) { var u = i / n; pts.push({ x: 200 + dx * u + Math.sin(u * Math.PI) * (bow || 0), y: 300 - h * u, t: u * ms }); }
    return pts;
  }
  assert.strictEqual(E.swipeThrow(stroke(0, 10, 100)), null, 'a tap is no throw');
  assert.strictEqual(E.swipeThrow(stroke(0, -120, 100)), null, 'a swipe down is no throw');
  var straight = E.swipeThrow(stroke(0, 160, 120));
  assert.ok(Math.abs(straight.ang) < 1e-9 && straight.spin === 0);
  var right = E.swipeThrow(stroke(60, 160, 120));
  assert.ok(right.ang > 0 && right.ang <= E.ANG_MAX);
  var slow = E.swipeThrow(stroke(0, 160, 900)), fast = E.swipeThrow(stroke(0, 160, 90));
  assert.ok(fast.pow > slow.pow && fast.pow <= 1 && slow.pow >= 0);
  var hookL = E.swipeThrow(stroke(0, 160, 150, 30)), hookR = E.swipeThrow(stroke(0, 160, 150, -30));
  assert.ok(hookL.spin > 0.3 && hookR.spin < -0.3, 'a stroke bowed right hooks left');
});

test('records: stats per game, high game, perfect, top list; normalisation', function () {
  var rec = E.newRecords();
  var g = E.newGame([{ kind: 'h', name: 'Ann' }, { kind: 'c', lvl: 1 }], 1);
  g.players[0].rolls = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
  g.players[1].rolls = [9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0];
  g.over = true;
  var card = E.settleGame(rec, g, '2026-10-31');
  assert.ok(card.perfect && card.best && card.humans === 1);
  assert.ok(rec.high === 300 && rec.perfect === 1 && rec.strikes === 12 && rec.streak === 12 && rec.turkeys === 4 && rec.wins === 1 && rec.clean === 1);
  assert.strictEqual(rec.games, 1, 'CPU games are not counted');
  var st = E.gameStats({ rolls: [7, 3, 8, 1, 0, 0, 10, 4, 6, 9, 0, 10, 10, 10, 2, 8, 9], sp: [] });
  assert.ok(st.spares === 3 && st.strikes === 4 && st.opens === 3 && st.gutters === 3 && st.streak === 3 && st.turkeys === 1 && !st.clean);
  var n = E.normRecords(JSON.parse(JSON.stringify(rec)));
  assert.deepStrictEqual(n, rec);
  var bad = E.normRecords({ high: 999, games: -3, strikes: 'x', top: [{ s: 500 }, { s: 120, d: 5, n: 'Bob' }, null] });
  assert.ok(bad.high === 300 && bad.games === 0 && bad.strikes === 0 && bad.top.length === 1 && bad.top[0].d === '5');
  assert.deepStrictEqual(E.normRecords('nope'), E.newRecords());
});

// ---- reviewer additions ----
function fake(standIds) { return { standing: standIds.map(function (id) { var sp = E.spot(id); return { id: id, x: sp.x, z: sp.z }; }), gutter: false }; }
test('applyRoll: 10th frame strike then leave then spare; racks and calls', function () {
  var g = E.newGame([{ kind: 'h' }], 3);
  for (var i = 0; i < 9; i++) { E.applyRoll(g, fake([])); }      // nine strikes
  assert.strictEqual(E.cursor(g.players[0].rolls).frame, 9);
  var a = E.applyRoll(g, fake([]));                              // 10th: strike, fresh rack follows
  assert.ok(a.strike && !a.frameDone && g.rack === null && E.rackFor(g).length === 10);
  var b = E.applyRoll(g, fake([7, 10]));                         // 8 with the 7-10 left
  assert.ok(b.count === 8 && b.fresh && b.split && !b.frameDone && g.rack.length === 2);
  assert.deepStrictEqual(E.rackFor(g).map(function (p) { return p.id; }), [7, 10]);
  var c = E.applyRoll(g, fake([]));                              // converts: a spare
  assert.ok(c.spare && !c.strike && c.count === 2 && c.over && g.over);
  assert.strictEqual(E.scoreGame(g.players[0].rolls).total, 288);
  assert.deepStrictEqual(E.scoreGame(g.players[0].rolls).frames[9].marks, ['X', '8', '/']);
  assert.strictEqual(E.applyRoll(g, fake([])), null, 'no rolls after the game is over');
});
test('applyRoll never counts more pins than were standing; a 0 on a leave is a miss', function () {
  var g = E.newGame([{ kind: 'h' }], 4);
  E.applyRoll(g, fake([1, 2, 3]));
  var r = E.applyRoll(g, { standing: [], gutter: false });
  assert.strictEqual(r.count, 3);
  var r2 = E.applyRoll(g, fake([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assert.ok(r2.count === 0 && r2.miss && !r2.split);
  assert.deepStrictEqual(E.validRolls(g.players[0].rolls), g.players[0].rolls);
});
test('turn order: each bowler finishes a frame before the next; 10th frame bonus balls stay with the bowler', function () {
  var g = E.newGame([{ kind: 'h' }, { kind: 'h' }, { kind: 'c', lvl: 2 }], 5), order = [];
  while (!g.over) {
    var t = E.turnOf(g); order.push(t);
    E.applyRoll(g, E.cursor(g.players[t].rolls).frame === 9 ? fake([]) : fake(E.cursor(g.players[t].rolls).ball ? [] : [10]));
  }
  // every frame: P0's balls, then P1's, then P2's
  var seq = order.join('');
  assert.ok(/^(0+1+2+){10}$/.test(seq), seq);
  g.players.forEach(function (P) { assert.ok(E.cursor(P.rolls).done); assert.strictEqual(P.rolls.length, 21); });
});
test('settleGame: a tie gives no win; normGame rebuilds a missing leave', function () {
  var rec = E.newRecords(), g = E.newGame([{ kind: 'h' }, { kind: 'h' }], 1), r = [];
  for (var i = 0; i < 20; i++) r.push(4);
  g.players[0].rolls = r.slice(); g.players[1].rolls = r.slice(); g.over = true;
  E.settleGame(rec, g, 'x');
  assert.ok(rec.wins === 0 && rec.games === 2 && rec.high === 80 && rec.top.length === 2);
  var n = E.normGame({ seed: 9, players: [{ kind: 'h', rolls: [6] }], rack: [{ id: 99, x: 0, z: 0 }] });
  assert.ok(n && n.rack.length === 4 && !n.over);
  assert.strictEqual(E.normGame({ players: [] }), null);
  assert.strictEqual(E.normGame(null), null);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
