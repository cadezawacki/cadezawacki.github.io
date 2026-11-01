/* Headless checks for the Pinball engine (physics, flippers, rules, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/pinball/pinball.test.js */
'use strict';
var assert = require('assert');

var E = require('./pinball.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./pinball.js')];
require('./pinball.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var T = E.TABLE;
// A ball is somewhere it can legally be: inside the cabinet, not inside a bumper, a sling, a flipper.
function inSling(x, y) {
  for (var s = 0; s < T.slings.length; s++) {
    var p = T.slings[s], sgn = 0, inside = true;
    for (var i = 0; i < 3; i++) {
      var a = p[i], b = p[(i + 1) % 3], cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (Math.abs(cr) < 1e-9) continue;
      var sg = cr > 0 ? 1 : -1;
      if (!sgn) sgn = sg; else if (sg !== sgn) inside = false;
    }
    if (inside) return true;
  }
  return false;
}
function legal(g, b) {
  if (b.st !== 'play') return true;
  if (b.x < 8 + E.R - 1.5 || b.x > 292 - E.R + 1.5) return 'outside the side walls';
  if (b.y < 0) return 'above the arch';
  var ex = (b.x - 150) / 142, ey = (b.y - 140) / 128;
  if (b.y < 140 && ex * ex + ey * ey > 1.0) return 'through the arch';
  for (var i = 0; i < T.bumpers.length; i++) {
    var c = T.bumpers[i], d = Math.hypot(b.x - c.x, b.y - c.y);
    if (d < c.r + E.R - 1.5) return 'inside a bumper';
  }
  if (inSling(b.x, b.y)) return 'inside a slingshot';
  // the plunger lane wall: a ball is on one side of it (between its ends)
  if (b.y > 180 && b.y < 540 && Math.abs(b.x - E.LANE_X) < E.R - 1.5) return 'in the lane wall';
  return true;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Pinball' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'pinball.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('a ball starts on the plunger and a held plunger charges, release launches it', function () {
  var g = E.newGame({ seed: 3 });
  assert.strictEqual(g.balls.length, 1);
  var b = g.balls[0];
  assert.ok(E.waitingInLane(g) && E.laneBall(g) === b);
  for (var i = 0; i < 120; i++) E.stepGame(g, { p: true });
  assert.ok(g.charge > 0.5 && g.charge <= 1, 'charged ' + g.charge);
  assert.ok(Math.abs(b.y - (E.FLOOR_Y - E.R)) < 0.5, 'the ball sits on the plunger while it charges');
  E.stepGame(g, { p: false });
  assert.ok(b.vy < -900, 'launched up the lane: ' + b.vy);
  assert.ok(g.saveT > 0, 'the launch starts the ball save');
});

test('a full plunge clears the lane through the one-way gate; a weak one falls back', function () {
  var g = E.newGame({ seed: 4 }), b = g.balls[0], i;
  for (i = 0; i < 240; i++) E.stepGame(g, { p: true });
  E.stepGame(g, {});
  for (i = 0; i < 240 * 3; i++) E.stepGame(g, {});
  assert.ok(g.balls.length && g.balls[0].x < E.LANE_X, 'out on the playfield');
  // and it never comes back into the lane over the gate
  var back = false;
  for (i = 0; i < 240 * 8 && g.balls.length; i++) { E.stepGame(g, E.autopilot(g)); if (g.balls[0] && g.balls[0].x > E.LANE_X && g.balls[0].y < 400) back = true; }
  assert.ok(!back, 'the gate lets nothing back in');
  var w = E.newGame({ seed: 4 });
  for (i = 0; i < 12; i++) E.stepGame(w, { p: true });
  E.stepGame(w, {});
  for (i = 0; i < 240 * 3; i++) E.stepGame(w, {});
  assert.ok(E.waitingInLane(w), 'a feeble plunge rolls back onto the plunger');
  void b;
});

test('no tunnelling: fast balls fired everywhere stay inside the table and out of solids', function () {
  var r = E.rng(99), bad = [], shots = 0;
  for (var k = 0; k < 220; k++) {
    var g = E.newGame({ seed: k + 1 });
    g.balls.length = 0;
    var x = 30 + r() * 220, y = 40 + r() * 420;
    // pick a free starting spot
    var b = E.newBall(g, x, y, 'play');
    if (legal(g, b) !== true || (x > 30 && x < 76 && y > 220 && y < 330) || (x > 200 && x < 230 && y > 220 && y < 330)) continue;
    var a = r() * Math.PI * 2;
    b.vx = Math.cos(a) * E.MAXV; b.vy = Math.sin(a) * E.MAXV;
    shots++;
    for (var i = 0; i < 240 * 2 && g.balls.length; i++) {
      E.stepGame(g, { l: (i >> 5) % 2 === 0, r: (i >> 4) % 3 === 0 });
      for (var j = 0; j < g.balls.length; j++) {
        var ok = legal(g, g.balls[j]);
        if (ok !== true) { bad.push(ok + ' @' + g.balls[j].x.toFixed(1) + ',' + g.balls[j].y.toFixed(1) + ' shot ' + k); break; }
      }
      if (bad.length) break;
      g.events.length = 0;
    }
  }
  assert.ok(shots > 100, 'enough shots: ' + shots);
  assert.deepStrictEqual(bad, []);
});

test('substeps keep each move small even at top speed', function () {
  var g = E.newGame({ seed: 5 });
  g.balls.length = 0;
  var b = E.newBall(g, 139, 300, 'play');
  b.vx = 0; b.vy = E.MAXV;
  var y0 = b.y;
  E.stepGame(g, {});
  assert.ok(b.y - y0 < E.MAXV * E.STEP + 1, 'moves at most one step of travel');
  // a ball at MAXV hitting the bottom of the drop bank bounces back: it never passes through a raised target
  g = E.newGame({ seed: 5 }); g.balls.length = 0;
  b = E.newBall(g, 139, 330, 'play'); b.vx = 0; b.vy = -E.MAXV;
  for (var i = 0; i < 60; i++) E.stepGame(g, {});
  assert.ok(b.y > 268 || g.balls.indexOf(b) < 0 || !g.drops[1], 'the centre target stopped it (or dropped)');
  assert.ok(!g.drops[1], 'and it went down');
});

test('a flipper swing throws a resting ball up the table, faster near the tip', function () {
  function flipFrom(t) {
    var g = E.newGame({ seed: 6 }), F = T.flippers[0];
    g.balls.length = 0;
    var ca = Math.cos(F.rest), sa = Math.sin(F.rest), d = F.len * t;
    var rad = F.rb + (F.rt - F.rb) * t;
    var b = E.newBall(g, F.x + ca * d + sa * (rad + E.R + 0.2), F.y + sa * d - ca * (rad + E.R + 0.2), 'play');
    var best = 0;
    for (var i = 0; i < 40; i++) { E.stepGame(g, { l: true }); if (b.vy < 0) best = Math.max(best, Math.hypot(b.vx, b.vy)); }
    return { vy: best, b: b };
  }
  var near = flipFrom(0.35), tip = flipFrom(0.85);
  assert.ok(near.vy > 300, 'a hit near the base still goes up: ' + near.vy);
  assert.ok(tip.vy > near.vy, 'the tip throws harder (' + tip.vy.toFixed(0) + ' > ' + near.vy.toFixed(0) + ')');
  assert.ok(tip.vy > 700, 'a tip shot reaches the upper table: ' + tip.vy);
});

test('a raised flipper cradles a ball; flippers stay within their stops', function () {
  var g = E.newGame({ seed: 7 }), F = T.flippers[0], i;
  g.balls.length = 0;
  var b = E.newBall(g, F.x + 30, F.y - 30, 'play');
  for (i = 0; i < 240 * 3; i++) {
    E.stepGame(g, { l: true });
    for (var k = 0; k < 3; k++) {
      var f = T.flippers[k], a = g.fl[k].a, lo = Math.min(f.rest, f.up), hi = Math.max(f.rest, f.up);
      assert.ok(a >= lo - 1e-9 && a <= hi + 1e-9, 'flipper ' + k + ' angle ' + a);
    }
  }
  assert.ok(g.balls.length === 1 && Math.hypot(b.vx, b.vy) < 20, 'the ball settles in the crook of the flipper');
  assert.ok(b.x > F.x - 10 && b.x < F.x + 25 && b.y < F.y, 'near the base, on top: ' + b.x.toFixed(1) + ',' + b.y.toFixed(1));
});

test('determinism: the same seed and inputs replay identically', function () {
  function run() { var g = E.simulate(1234, E.autopilot, 90); return JSON.stringify([g.players[0].score, g.players[0].ball, g.t.toFixed(4), g.balls.map(function (b) { return [b.x, b.y]; })]); }
  assert.strictEqual(run(), run());
  var a = E.simulate(1, E.autopilot, 60), b = E.simulate(2, E.autopilot, 60);
  assert.ok(a.players[0].score >= 0 && b.players[0].score >= 0);
});

test('autopilot games finish, score, and the ball never gets stuck', function () {
  var finished = 0, tot = 0, kinds = {};
  for (var s = 1; s <= 6; s++) {
    var g = E.newGame({ seed: s * 101, players: 1 + (s % 2) }), n = Math.ceil(900 / E.STEP), r = E.rng(s);
    for (var i = 0; i < n && g.phase !== 'over'; i++) {
      if (g.phase === 'next') E.ready(g);
      // a sloppy player: the robot, but it dozes off now and then (so balls do drain)
      var inp = E.autopilot(g);
      if ((g.steps >> 10) % 3 === 2) { inp.l = false; inp.r = false; }
      if (r() < 0.0002) E.nudge(g);
      E.stepGame(g, inp);
      for (var k = 0; k < g.events.length; k++) kinds[g.events[k].k] = (kinds[g.events[k].k] || 0) + 1;
      g.events.length = 0;
    }
    if (g.phase === 'over') finished++;
    tot += g.players[0].score;
  }
  assert.ok(finished >= 5, 'games end: ' + finished);
  assert.ok(tot > 0, 'scores');
  ['bumper', 'sling', 'ramp', 'drain', 'endball', 'launch', 'flip'].forEach(function (k) { assert.ok(kinds[k] > 0, 'saw ' + k); });
  assert.ok((kinds.search || 0) < 6, 'stuck-ball searches are rare: ' + (kinds.search || 0));
});

test('top lanes raise the bonus multiplier; the flippers rotate them', function () {
  var g = E.newGame({ seed: 8 });
  E.hitLane(g, 0); E.hitLane(g, 1);
  assert.deepStrictEqual(g.lanes, [true, true, false]);
  E.stepGame(g, { r: true });
  assert.deepStrictEqual(g.lanes, [false, true, true], 'right flipper shifts lit lanes right');
  E.stepGame(g, { r: false }); E.stepGame(g, { l: true });
  assert.deepStrictEqual(g.lanes, [true, true, false]);
  E.hitLane(g, 2);
  assert.strictEqual(g.mult, 2);
  assert.deepStrictEqual(g.lanes, [false, false, false]);
  for (var i = 0; i < 10; i++) { E.hitLane(g, 0); E.hitLane(g, 1); E.hitLane(g, 2); }
  assert.strictEqual(g.mult, 5, 'capped at 5x');
});

test('skill shot: the blinking lane right after the plunge', function () {
  var g = E.newGame({ seed: 9 });
  E.launch(g, g.balls[0], 0.5);
  var s0 = E.player(g).score;
  E.hitLane(g, g.skillLane);
  assert.ok(E.player(g).score - s0 >= 25000);
  var h = E.newGame({ seed: 9 });
  E.launch(h, h.balls[0], 0.5);
  E.hitLane(h, (h.skillLane + 1) % 3);
  assert.ok(E.player(h).score < 25000, 'the wrong lane is no skill shot');
});

test('drop targets: the bank lights the scoop; a hit from behind does not drop one', function () {
  var g = E.newGame({ seed: 10 }), p = E.player(g);
  p.missionLit = false;
  E.hitDrop(g, 0); E.hitDrop(g, 1);
  assert.ok(!p.missionLit);
  E.hitDrop(g, 2);
  assert.ok(p.missionLit && g.dropDownT > 0);
  // from behind
  var h = E.newGame({ seed: 10 }), d = T.drops[1];
  h.balls.length = 0;
  var b = E.newBall(h, d.cx, d.cy - 30, 'play'); b.vy = 400;
  for (var i = 0; i < 60; i++) E.stepGame(h, {});
  assert.ok(h.drops[1], 'still up');
});

test('missions start at the scoop, count their shots, pay out, and time out', function () {
  var g = E.newGame({ seed: 11 }), p = E.player(g);
  var b = g.balls[0]; b.st = 'play';
  assert.ok(p.missionLit, 'the first mission is lit from the start');
  E.startMission(g);
  assert.strictEqual(g.mission.id, E.MISSIONS[0].id);
  assert.ok(!p.missionLit);
  var s0 = p.score;
  for (var i = 0; i < E.MISSIONS[0].goal; i++) E.hitRamp(g, i % 2);
  assert.ok(!g.mission && p.done === 1 && p.score - s0 >= E.MISSIONS[0].award);
  p.missionLit = true;
  E.startMission(g);
  assert.strictEqual(g.mission.id, E.MISSIONS[1].id);
  g.mission.t = 0.001;
  E.stepGame(g, {});
  assert.ok(!g.mission && p.missionLit, 'timed out and relit');
  // the third mission → an extra ball
  p.done = 2; p.extra = 0; E.startMission(g);
  g.mission.id = 'ramps'; g.mission.n = g.mission.goal - 1;
  E.hitRamp(g, 0);
  assert.ok(!g.mission && p.done === 3 && p.extra === 1, 'extra ball after three missions');
});

test('ramps light locks; locks light multiball; multiball adds balls and jackpots', function () {
  var g = E.newGame({ seed: 12 }), p = E.player(g);
  for (var i = 0; i < p.lockNeed; i++) E.hitRamp(g, 0);
  assert.ok(g.mbLit);
  E.startMultiball(g);
  assert.ok(g.mb && g.queue === 2 && g.saveT > 0);
  var s0 = p.score;
  E.hitRamp(g, 1);
  assert.ok(p.score - s0 >= 50000 && g.jackpot === 1);
  assert.strictEqual(p.lockNeed, 4, 'the next multiball takes one more lock');
  // the queue feeds the plunger lane one ball at a time and auto-launches
  for (i = 0; i < 240 * 4; i++) { E.stepGame(g, E.autopilot(g)); g.events.length = 0; }
  assert.ok(E.ballsLive(g) >= 2, 'more than one ball live: ' + E.ballsLive(g));
});

test('ball save returns a drained ball once; a drain after it ends the ball and counts the bonus', function () {
  var g = E.newGame({ seed: 13 }), b = g.balls[0];
  E.launch(g, b, 0.5);
  g.bonus = 10000; g.mult = 3;
  b.x = 139; b.y = E.DRAIN_Y + 20; b.vx = 0; b.vy = 0; b.st = 'play';
  E.stepGame(g, {});
  assert.ok(g.events.some(function (e) { return e.k === 'saved'; }), 'saved');
  assert.strictEqual(E.ballsLive(g), 1);
  for (var i = 0; i < 240; i++) E.stepGame(g, {});
  var nb = g.balls[0];
  nb.x = 139; nb.y = E.DRAIN_Y + 20; nb.vx = 0; nb.vy = 0; nb.st = 'play';
  var s0 = E.player(g).score;
  E.stepGame(g, {});
  assert.strictEqual(g.phase, 'bonus');
  assert.ok(g.bonusCalc.total === 30000 && E.player(g).score - s0 === 30000);
  for (i = 0; i < Math.ceil(E.BONUS_T / E.STEP) + 2; i++) E.stepGame(g, {});
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(E.player(g).ball, 2);
  assert.strictEqual(g.mult, 1, 'the multiplier resets each ball');
});

test('tilt: warnings, then a dead table and no bonus', function () {
  var g = E.newGame({ seed: 14 }), ev = [];
  E.launch(g, g.balls[0], 0.5);
  g.bonus = 50000;
  E.nudge(g); E.nudge(g);
  ev = g.events.map(function (e) { return e.k; });
  assert.ok(ev.indexOf('warn') >= 0 && !g.tilted);
  E.nudge(g);
  assert.ok(g.tilted);
  // flippers are dead
  E.stepGame(g, { l: true, r: true });
  assert.strictEqual(g.fl[0].a, T.flippers[0].rest);
  var s0 = E.player(g).score;
  E.hitRamp(g, 0);
  assert.strictEqual(E.player(g).score, s0, 'a tilted table scores nothing');
  g.saveT = 0; g.balls[0].x = 139; g.balls[0].y = E.DRAIN_Y + 20; g.balls[0].vy = 0; g.balls[0].st = 'play';
  E.stepGame(g, {});
  assert.ok(g.phase === 'bonus' && g.bonusCalc.total === 0 && g.bonusCalc.tilted);
  // spaced-out nudges are fine
  var h = E.newGame({ seed: 14 });
  for (var k = 0; k < 6; k++) { E.nudge(h); for (var i = 0; i < 240 * 2.5; i++) E.stepGame(h, { p: true }); }
  assert.ok(!h.tilted, 'one nudge every few seconds never tilts');
});

test('kickback saves the left outlane once; standups relight it', function () {
  var g = E.newGame({ seed: 15 }), p = E.player(g);
  g.balls.length = 0;
  var b = E.newBall(g, 18, 470, 'play'); b.vy = 300;
  for (var i = 0; i < 60; i++) E.stepGame(g, {});
  assert.ok(!p.kick && b.vy < -500 && g.balls.length === 1, 'kicked back up');
  E.hitStand(g, 0); E.hitStand(g, 1);
  assert.ok(p.kick, 'relit');
});

test('players take turns; extra balls shoot again; the game ends after the last ball', function () {
  var g = E.newGame({ seed: 16, players: 2, balls: 3 });
  function endBall() { g.balls.length = 0; g.queue = 0; E.endBall(g); return E.nextBall(g); }
  assert.strictEqual(g.cur, 0);
  assert.strictEqual(endBall(), 'next');
  assert.strictEqual(g.cur, 1);
  E.ready(g);
  assert.strictEqual(g.phase, 'play');
  E.player(g).extra = 1;
  assert.strictEqual(endBall(), 'play', 'shoot again: same player, no hand-off');
  assert.strictEqual(g.cur, 1);
  var guard = 0;
  while (g.phase !== 'over' && guard++ < 20) { if (endBall() === 'next') E.ready(g); }
  assert.strictEqual(g.phase, 'over');
  assert.ok(g.players.every(function (p) { return p.ball === 4; }));
});

test('ramp rides follow their path and drop the ball into an inlane', function () {
  var g = E.newGame({ seed: 17 });
  g.balls.length = 0;
  var r = T.ramps[0], b = E.newBall(g, (r.x0 + r.x1) / 2, r.y1 - 4, 'play');
  b.vy = -900;
  var rode = false;
  for (var i = 0; i < 240 * 3; i++) { E.stepGame(g, {}); if (b.st === 'ramp') rode = true; if (rode && b.st === 'play') break; }
  assert.ok(rode, 'captured at the top');
  assert.ok(b.st === 'play' && b.x > 230 && b.x < 252 && b.y > 370, 'released into the right inlane: ' + b.x.toFixed(1) + ',' + b.y.toFixed(1));
  // a weak shot rolls back out
  var h = E.newGame({ seed: 17 }); h.balls.length = 0;
  var w = E.newBall(h, (r.x0 + r.x1) / 2, r.y1 - 4, 'play'); w.vy = -350;
  for (i = 0; i < 240 * 2; i++) E.stepGame(h, {});
  assert.ok(w.st === 'play' && w.y > r.y1 - 10, 'rolled back down');
});

test('spinner: a fast ball through it spins and scores', function () {
  var g = E.newGame({ seed: 18 }), p = E.player(g);
  g.balls.length = 0;
  var b = E.newBall(g, 22, 320, 'play'); b.vy = -1100;
  for (var i = 0; i < 240 * 2; i++) E.stepGame(g, {});
  assert.ok(p.stats.spins >= 4, 'spins: ' + p.stats.spins);
});

test('save: high scores sorted and capped, records, options, normalisation', function () {
  var s = E.newSave(), g = E.newGame({ seed: 19, players: 2 });
  g.players[0].score = 5000; g.players[1].score = 9000; g.players[1].stats.ramps = 7;
  var rk = E.settle(s, g, '2026-10-31');
  assert.deepStrictEqual(rk, [1, 0]);
  assert.ok(s.rec.score === 9000 && s.rec.ramps === 7 && s.games === 1);
  for (var i = 0; i < 12; i++) { var h = E.newGame({ seed: i }); h.players[0].score = 100 * (i + 1); E.settle(s, h, ''); }
  assert.strictEqual(s.top.length, 10);
  assert.ok(s.top[0].s === 9000 && s.top[9].s >= s.top[9].s);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ games: -3, opt: { players: 9, balls: 4 }, rec: { score: 'x' }, top: [null, { s: -5 }, { s: 777, d: 12, b: 5, p: 7, n: 0 }, 'z'] });
  assert.ok(bad.games === 0 && bad.opt.players === 4 && bad.opt.balls === 3 && bad.top.length === 1 && bad.top[0].d === '' && bad.top[0].p === 4 && bad.rec.score === 777);
  assert.strictEqual(E.normSave(null).top.length, 0);
  assert.strictEqual(E.normSave('junk').opt.players, 1);
});

test('combos pay more for each shot in a chain but stop growing at x8', function () {
  var g = E.newGame({ seed: 31 }), p = E.player(g), last = 0, gains = [];
  for (var i = 0; i < 14; i++) {
    var before = p.score;
    E.hitOrbit(g);
    gains.push(p.score - before);
    for (var k = 0; k < 24; k++) E.stepGame(g, {});   // 0.1 s apart: well inside the combo window
  }
  assert.ok(gains[1] > gains[0] && gains[2] > gains[1], 'the chain grows: ' + gains.slice(0, 3));
  assert.strictEqual(gains[13], gains[9], 'capped: ' + gains.slice(8));
  last = gains[13];
  assert.ok(last <= 3000 + 80000 + 1, 'a long chain stays bounded: ' + last);
});

test('a weak plunge that rolls back re-arms the skill shot and the ball save', function () {
  var g = E.newGame({ seed: 32 }), i;
  for (i = 0; i < 10; i++) E.stepGame(g, { p: true });
  E.stepGame(g, {});
  assert.ok(g.launched && g.saveT > 0);
  for (i = 0; i < 240 * 4; i++) E.stepGame(g, {});
  assert.ok(E.waitingInLane(g), 'back on the plunger');
  assert.ok(!g.launched && g.saveT === 0, 'nothing ticking while it waits');
  for (i = 0; i < 240; i++) E.stepGame(g, { p: true });
  E.stepGame(g, {});
  assert.ok(g.launched && Math.abs(g.saveT - E.BALL_SAVE) < 0.05 && g.skillT > 3.9, 'a fresh launch: save ' + g.saveT + ' skill ' + g.skillT);
});

test('long multiball brawls with nudges keep every ball legal and finite', function () {
  for (var s = 1; s <= 4; s++) {
    var g = E.newGame({ seed: 500 + s }), rr = E.rng(s), i, k;
    for (i = 0; i < 240; i++) E.stepGame(g, { p: true });
    E.stepGame(g, {});
    E.startMultiball(g);
    for (i = 0; i < 240 * 90 && g.phase !== 'over'; i++) {
      if (g.phase === 'next') E.ready(g);
      if (g.phase === 'play' && g.balls.length < 2 && !g.mb && rr() < 0.002) E.startMultiball(g);
      var inp = E.autopilot(g);
      if (rr() < 0.3) { inp.l = rr() < 0.5; inp.r = rr() < 0.5; }   // a button masher
      if (rr() < 0.0004) E.nudge(g);
      E.stepGame(g, inp);
      g.events.length = 0;
      for (k = 0; k < g.balls.length; k++) {
        var b = g.balls[k];
        assert.ok(isFinite(b.x) && isFinite(b.y) && isFinite(b.vx) && isFinite(b.vy), 'finite');
        var ok = legal(g, b);
        assert.ok(ok === true, 'seed ' + s + ' step ' + i + ': ' + ok + ' at ' + b.x.toFixed(1) + ',' + b.y.toFixed(1));
      }
    }
  }
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
