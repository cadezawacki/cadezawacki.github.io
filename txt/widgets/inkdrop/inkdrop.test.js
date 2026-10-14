/* Headless checks for the Ink Drop engine (physics, drawing rules, levels).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/inkdrop/inkdrop.test.js
 * Every level ships with a SOLUTION drawing below; the tests prove each level is
 * solvable within its ink, that 3 stars are reachable, that the solution is not
 * a knife-edge, and that dropping the ball with no lines fails. */
'use strict';

// Quadratic Bézier from a to c pulled toward b, as an n-segment polyline (a hand-drawn curve).
function bz(a, b, c, n) {
  var out = [];
  n = n || 8;
  for (var i = 0; i <= n; i++) {
    var t = i / n, u = 1 - t;
    out.push([Math.round((u * u * a[0] + 2 * u * t * b[0] + t * t * c[0]) * 100) / 100,
      Math.round((u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]) * 100) / 100]);
  }
  return out;
}

// A 3-star solution for every level (board units; one array of [x, y] points per stroke).
var SOLUTIONS = {
  // Chapter 1 · Sketchbook
  'c1-1': [[[6, 26], [60, 92]]],                                         // trace the dotted ramp
  'c1-2': [[[35, 61], [62, 64]]],                                        // bridge the gap
  'c1-3': [[[4, 22], [80, 52]], [[95, 70], [22, 118]]],                   // right, then back left
  'c1-4': [bz([3.5, 22], [45, 59.5], [42.5, 51.5])],                     // a lip launches it over the wall
  'c1-5': [bz([4, 14], [22.5, 39], [24.5, 36.5])],                      // jump the no-ink zone
  'c1-6': [[[94, 75.5], [90, 93]]],                                      // a backstop above the hole
  'c1-7': [bz([3.5, 19], [19, 124.5], [59, 65])],                        // swing down and up
  'c1-8': [[[95, 18], [80, 28]], [[5, 46], [20, 58]], [[95, 76], [80, 88]], [[5, 106], [20, 118]]],
  // Chapter 2 · Workshop
  'c2-1': [[[58.5, 22.5], [33.5, 52.5]]],                                // over the spiky shelf
  'c2-2': [[[91.5, 63], [95.5, 87]]],                                    // stop the bumper's arc
  'c2-3': [[[56, 34], [30.5, 95]]],                                      // steep chute: smash the glass
  'c2-4': [[[4.5, 83], [56.5, 112]]],                                    // catch what the belt throws
  'c2-5': [[[56, 20], [19.5, 41]], [[5.5, 95], [33.5, 122.5]]],           // around the bumpers
  'c2-6': [[[36.5, 15], [10.5, 24]], [[4, 47], [23.5, 54]]],              // land flat on the glass
  'c2-7': [[[5.5, 67.5], [41, 92]]],                                     // swap to the other belt
  'c2-8': [[[7.5, 16], [19, 24.5]], [[89, 88.5], [90, 106.5]]],       // launch, smash, ride, stop
  // Chapter 3 · Machine Room
  'c3-1': [[[88, 41.5], [33.5, 107]]],                                   // ramp from the exit portal
  'c3-2': [[[94, 61.5], [64.5, 118]]],                                   // catch the cannonball
  'c3-3': [[[9.5, 18.5], [24, 57.5]]],                                   // feed the funnel on time
  'c3-4': [bz([92.5, 99], [91, 128], [67, 131.5])],                        // roll into A sideways, fly out of B
  'c3-5': [bz([79, 44.5], [95, 83.5], [70, 105])],                       // hook the shot onto the glass
  'c3-6': [[[5, 16.5], [20.5, 54]], bz([70, 92], [86, 106.5], [60.5, 117.5])],
  'c3-7': [[[15.5, 19.5], [37, 49.5]]],                                  // land mid-belt so the cup is there
  'c3-8': [bz([73.5, 15], [105, 43], [66.5, 52]), [[58, 124], [33.5, 125.5]]]       // hook, smash, ride, warp, roll
};

if (require.main === module) runTests();
else module.exports = { SOLUTIONS: SOLUTIONS, bz: bz };

function runTests() {
  var assert = require('assert'), fs = require('fs'), path = require('path');
  var E = require('./inkdrop.js');
  var passed = 0;
  function test(name, fn) {
    try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
  }
  function lv(extra) {                         // a bare test board: no goal reachable
    var o = { id: 't', ball: [20, 20], ink: 999, par: 999, goal: { zone: [-50, -50, 1, 1] } };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function run(L, strokes, secs, each) {
    var s = E.newSim(L, strokes || []), n = Math.round((secs || 3) / E.STEP);
    for (var i = 0; i < n && s.state === 'run'; i++) { E.step(s); if (each) each(s); }
    return s;
  }
  var seed = 1234567;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

  // ---------------- registration ----------------
  test('registers "Ink Drop" exactly as MANIFEST_ENTRY.json says', function () {
    var widget = null, css = null;
    var saved = global.window;
    global.window = { Cade: { loadCSS: function (c) { css = c; }, registerWidget: function (w) { widget = w; } } };
    delete require.cache[require.resolve('./inkdrop.js')];
    require('./inkdrop.js');
    global.window = saved;
    if (saved === undefined) delete global.window;
    delete require.cache[require.resolve('./inkdrop.js')];
    assert.ok(widget, 'registered a widget');
    assert.strictEqual(css, 'inkdrop.css');
    var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'inkdrop'; })[0];
    assert.strictEqual(m.id, 'inkdrop');
    assert.strictEqual(m.type, 'widget');
    assert.strictEqual(m.name, widget.name);
    assert.strictEqual(m.name, 'Ink Drop');
    assert.strictEqual(m.description, widget.description);
    assert.strictEqual(m.icon, widget.icon);
    assert.strictEqual(m.tags, widget.tags);
    assert.strictEqual(m.entry, 'widgets/inkdrop/inkdrop.js');
    assert.strictEqual(m.css, 'widgets/inkdrop/inkdrop.css');
    assert.strictEqual(typeof widget.open, 'function');
  });

  // ---------------- level data ----------------
  test('24 levels, 8 per chapter, unique ids, sane budgets', function () {
    assert.strictEqual(E.LEVELS.length, 24);
    var ids = {};
    E.CHAPTERS.forEach(function (c) { assert.strictEqual(E.LEVELS.filter(function (L) { return L.ch === c.n; }).length, 8, 'chapter ' + c.n); });
    E.LEVELS.forEach(function (L) {
      assert.ok(!ids[L.id], 'unique id ' + L.id); ids[L.id] = 1;
      assert.ok(/^c[1-3]-[1-8]$/.test(L.id), L.id);
      assert.ok(L.name && L.name.length <= 16, L.id + ' name');
      assert.ok(L.ink > 0 && L.par > 0 && L.par < L.ink, L.id + ' par < ink');
      assert.ok(L.star && L.star.length === 2, L.id + ' has a star');
      assert.ok(L.goal && (L.goal.cup || L.goal.zone), L.id + ' has a goal');
      assert.ok(SOLUTIONS[L.id], L.id + ' has a solution');
    });
  });
  test('the ball and the star start in open space, on the board', function () {
    E.LEVELS.concat([E.SANDBOX]).forEach(function (L) {
      var s = E.newSim(L, []);
      assert.strictEqual(s.state, 'run');
      var b = L.ball;
      assert.ok(b[0] > E.BALL_R && b[0] < E.W - E.BALL_R && b[1] > E.BALL_R && b[1] < E.H, L.id + ' ball on board');
      // one step from rest must not be a collision response (nothing overlaps the spawn)
      var s2 = E.newSim(L, []); E.step(s2);
      assert.ok(s2.state === 'run', L.id + ' spawn is clear');
      assert.ok(Math.abs(s2.ball.vy - (L.ball[3] || 0) - E.G * E.STEP) < 1e-6, L.id + ' nothing touches the ball at spawn');
      if (L.star) assert.ok(!(L.walls || []).concat(L.spikes || [], L.glass || [], L.belts || []).some(function (r) {
        return L.star[0] > r[0] && L.star[0] < r[0] + r[2] && L.star[1] > r[1] && L.star[1] < r[1] + r[3];
      }), L.id + ' star not inside an obstacle');
    });
  });

  // ---------------- every level: solvable, 3 stars, empty fails ----------------
  E.LEVELS.forEach(function (L) {
    test(L.id + ' "' + L.name + '": the solution is legal and earns 3 stars', function () {
      var sol = SOLUTIONS[L.id], ink = E.inkOf(sol);
      assert.ok(E.validDrawing(L, sol), 'every stroke avoids obstacles / no-ink zones');
      assert.ok(ink <= L.ink, 'within the ink budget (' + ink.toFixed(1) + ' / ' + L.ink + ')');
      assert.ok(ink <= L.par, '3-star par is achievable (' + ink.toFixed(1) + ' <= ' + L.par + ')');
      var r = E.simulate(L, sol);
      assert.strictEqual(r.result, 'win', 'reaches the cup (got ' + r.result + ' ' + r.reason + ')');
      assert.strictEqual(r.got, 1, 'grabs the star');
      assert.strictEqual(E.rate(L, ink, r).stars, 3);
    });
    test(L.id + ': dropping with no lines fails', function () {
      var r = E.simulate(L, []);
      assert.notStrictEqual(r.result, 'win', 'empty board must not solve itself');
    });
  });
  // What the app does to a finger/mouse path: points every ~0.7 units, then simplify.
  function asDrawn(L, st) {
    var pts = [st[0]];
    for (var i = 1; i < st.length; i++) {
      var a = st[i - 1], c = st[i], n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 1.2));
      for (var j = 1; j <= n; j++) {
        var p = [a[0] + (c[0] - a[0]) * j / n, a[1] + (c[1] - a[1]) * j / n], l = pts[pts.length - 1];
        if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 0.7) pts.push(p);
      }
    }
    return E.simplify(L, pts, E.INK_EPS);
  }
  test('every solution also wins when drawn through the app (mouse points + simplification)', function () {
    E.LEVELS.forEach(function (L) {
      var st = SOLUTIONS[L.id].map(function (s) { return asDrawn(L, s); });
      assert.ok(E.validDrawing(L, st), L.id + ' drawn strokes legal');
      var r = E.simulate(L, st);
      assert.strictEqual(r.result, 'win', L.id + ' as drawn: ' + r.result + ' ' + r.reason);
    });
  });
  var tol = [];
  test('solutions are not knife-edges: most +-1 unit wobbly copies still reach the cup', function () {
    E.LEVELS.forEach(function (L) {
      var ok = 0, valid = 0;
      for (var k = 0; k < 24; k++) {
        var st = SOLUTIONS[L.id].map(function (s) { return asDrawn(L, s.map(function (p) { var a = rnd() * 6.283, d = rnd(); return [p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d]; })); });
        if (!E.validDrawing(L, st)) continue;
        valid++;
        if (E.simulate(L, st).result === 'win') ok++;
      }
      assert.ok(valid >= 12 && ok / valid >= 0.6, L.id + ' wobble tolerance ' + ok + '/' + valid);
      tol.push(L.id + ' ' + Math.round(ok / valid * 100) + '%');
    });
  });

  // ---------------- physics ----------------
  test('no tunnelling: very fast balls never pass through a thin line', function () {
    [300, 1000, 3000, 9000].forEach(function (v) {
      var maxY = -1e9;
      run(lv({ ball: [50, 20, 0, v] }), [[[10, 80], [90, 80]]], 1, function (s) { maxY = Math.max(maxY, s.ball.y); });
      assert.ok(maxY < 80 - E.INK_R, 'v=' + v + ' max y ' + maxY.toFixed(2));
    });
    var crossed = false;
    run(lv({ ball: [20, 20, 2500, 2500] }), [[[30, 90], [90, 30]]], 1, function (s) { if (s.ball.x + s.ball.y > 120) crossed = true; });
    assert.ok(!crossed, 'diagonal shot stays on its side');
    var thru = false;                          // and through the corner where two strokes meet
    run(lv({ ball: [50, 10, 0, 4000] }), [[[30, 70], [50, 80]], [[50, 80], [70, 70]]], 1, function (s) { if (s.ball.y > 80) thru = true; });
    assert.ok(!thru, 'no slipping through a joint');
  });
  test('a ball rolls down a 30 degree line at 5/7 g sin(theta) (solid sphere) less rolling resistance', function () {
    var ang = Math.PI / 6, st = [[5, 30], [5 + 120 * Math.cos(ang), 30 + 120 * Math.sin(ang)]];
    var v0 = null, t0 = 0, s = run(lv({ ball: [12, 30 - 3.2 + 7 * Math.tan(ang)] }), [st], 1.6, function (q) {
      if (q.steps === 160) { v0 = Math.hypot(q.ball.vx, q.ball.vy); t0 = q.t; }
    });
    var a = (Math.hypot(s.ball.vx, s.ball.vy) - v0) / (s.t - t0), want = 5 / 7 * E.G * Math.sin(ang) - 0.03 * E.G;
    assert.ok(Math.abs(a - want) / want < 0.02, 'a=' + a.toFixed(2) + ' want ' + want.toFixed(2));
    assert.ok(Math.abs(s.ball.w * E.BALL_R - Math.hypot(s.ball.vx, s.ball.vy)) < 1, 'rolling without slipping (w R = v)');
  });
  test('a ball on a gentle slope or flat line comes to rest (and that counts as stuck)', function () {
    var ang = Math.PI / 180, s = run(lv({ ball: [20, 30] }), [[[5, 40], [95, 40 + 90 * Math.tan(ang)]]], 6);
    assert.strictEqual(s.reason, 'stuck');
    assert.ok(Math.abs(s.ball.vx) < 1.5 && Math.abs(s.ball.vy) < 1.5);
    s = run(lv({ ball: [20, 20] }), [[[5, 60], [95, 60]]], 6);
    assert.strictEqual(s.reason, 'stuck');
    assert.ok(Math.abs(s.ball.y - (60 - E.INK_R - E.BALL_R)) < 0.05, 'resting on the line, y=' + s.ball.y.toFixed(3));
  });
  test('a drawn half-pipe keeps the speed: the ball climbs back near its start height', function () {
    var pts = [];
    for (var i = 0; i <= 16; i++) { var a = Math.PI * i / 16; pts.push([50 - 40 * Math.cos(a), 40 + 40 * Math.sin(a)]); }
    var minY = 1e9;
    run(lv({ ball: [12.5, 36] }), [pts], 3, function (s) { if (s.ball.x > 60) minY = Math.min(minY, s.ball.y); });
    assert.ok(minY < 42, 'regained height, peak y=' + minY.toFixed(1));
  });
  test('deterministic: same drawing, same outcome, at 60 Hz, 120 Hz or ragged frames', function () {
    var L = E.LEVELS[6], sol = SOLUTIONS[L.id];
    var a = E.simulate(L, sol), b = E.simulate(L, sol);
    assert.strictEqual(a.steps, b.steps);
    assert.ok(a.ball.x === b.ball.x && a.ball.y === b.ball.y && a.ball.w === b.ball.w, 'bit-identical replays');
    function byFrames(dts) {
      var s = E.newSim(L, sol), i = 0;
      while (s.state === 'run' && s.steps < 600) E.advance(s, dts[i++ % dts.length]);
      return s;
    }
    var f60 = byFrames([1 / 60]), f120 = byFrames([1 / 120]), rag = byFrames([0.007, 0.019, 0.011, 0.033, 0.004]);
    // compare at the same step count by replaying exactly that many fixed steps
    [f60, f120, rag].forEach(function (s) {
      var ref = E.newSim(L, sol);
      for (var k = 0; k < s.steps; k++) E.step(ref);
      assert.ok(ref.ball.x === s.ball.x && ref.ball.y === s.ball.y, 'frame rate does not change the physics');
    });
    assert.ok(Math.abs(f60.steps - f120.steps) <= 4);
  });
  test('advance() never runs away after a long stall', function () {
    var s = E.newSim(E.LEVELS[0], SOLUTIONS['c1-1']);
    E.advance(s, 5);
    assert.ok(s.steps <= 48, 'a 5 s hitch is capped (' + s.steps + ' steps)');
  });
  test('bumpers kick hard, spikes pop, glass shatters only on a hard hit', function () {
    var top = 1e9;
    var s = run(lv({ ball: [50, 20], bumpers: [[50, 60, 4]] }), [], 1, function (q) { top = Math.min(top, q.ball.vy); });
    assert.ok(-top >= 119, 'bumper kick ' + (-top).toFixed(1));
    s = run(lv({ ball: [50, 20], spikes: [[30, 80, 40, 5, 'u']] }), [], 2);
    assert.strictEqual(s.reason, 'spikes');
    s = run(lv({ ball: [50, 70], glass: [[40, 80, 20, 2.5]] }), [], 2);   // a short fall: rests on it
    assert.strictEqual(s.broken[0], undefined, 'gentle landing keeps the glass');
    s = run(lv({ ball: [50, 10], glass: [[40, 80, 20, 2.5]] }), [], 2);   // a long fall: smashes through
    assert.ok(s.broken[0] != null && s.ball.y > 82, 'hard hit breaks the glass');
  });
  test('portals keep speed and direction; belts carry; moving cups move', function () {
    var vIn = null, out = null;
    run(lv({ ball: [20, 10], portals: [[20, 50, 70, 30]] }), [], 1, function (s) {
      s.events.forEach(function (e) { if (e.k === 'portal' && !out) { out = { x: s.ball.x, y: s.ball.y, vx: s.ball.vx, vy: s.ball.vy }; } });
      if (!out) vIn = s.ball.vy;
      s.events.length = 0;
    });
    assert.ok(out && Math.abs(out.x - 70) < E.PORTAL_R && Math.abs(out.y - 30) < E.PORTAL_R, 'came out of B');
    assert.ok(Math.abs(out.vy - vIn) < E.G * E.STEP * 2 + 1e-6 && Math.abs(out.vx) < 1e-9, 'same velocity');
    var s = run(lv({ ball: [20, 60], belts: [[5, 70, 90, 5, 40]] }), [], 1.5);
    assert.ok(s.ball.vx > 30 && s.ball.vx < 41, 'belt drags the ball to its speed (' + s.ball.vx.toFixed(1) + ')');
    var g = { cup: [20, 140, 14, 10], move: [60, 0, 4] };
    assert.strictEqual(E.cupAt(g, 0).c[0], 20);
    assert.ok(Math.abs(E.cupAt(g, 2).c[0] - 80) < 1e-9 && Math.abs(E.cupAt(g, 4).c[0] - 20) < 1e-9, 'there and back in one period');
  });

  // ---------------- drawing rules ----------------
  test('ink may not go inside obstacles, no-ink zones, portals or onto the ball', function () {
    var L = lv({ walls: [[40, 40, 20, 10]], nodraw: [[0, 100, 30, 20]], portals: [[80, 80, 80, 120]], bumpers: [[70, 20, 4]] });
    assert.ok(E.blockedAt(L, 50, 45), 'wall');
    assert.ok(E.blockedAt(L, 10, 110), 'no-ink zone');
    assert.ok(E.blockedAt(L, 80, 81), 'portal');
    assert.ok(E.blockedAt(L, 70, 22), 'bumper');
    assert.ok(E.blockedAt(L, 20, 22), 'the ball');
    assert.ok(E.blockedAt(L, -1, 50) && E.blockedAt(L, 50, 151), 'off the board');
    assert.ok(!E.blockedAt(L, 50, 60), 'open space');
    var q = E.clipSeg(L, 50, 30, 50, 60);
    assert.ok(q && q[1] <= 40 && q[1] > 39, 'a line stops at the wall (' + (q && q[1]) + ')');
    assert.strictEqual(E.clipSeg(L, 50, 45, 50, 60), null, 'cannot start inside');
  });
  test('stroke simplification keeps ends, shortens ink, never shortcuts through a wall', function () {
    var L = lv({ walls: [[40, 40, 20, 20]] }), raw = [];
    for (var x = 10; x <= 90; x += 0.7) raw.push([x, 30 + Math.sin(x / 9) * 0.15]);   // a wobbly line
    var s = E.simplify(L, raw, 0.3);
    assert.ok(s.length < 6, 'collapsed to ' + s.length + ' points');
    assert.ok(Math.abs(s[0][0] - raw[0][0]) < 0.01 && Math.abs(s[0][1] - raw[0][1]) < 0.01, 'keeps the first point');
    assert.ok(Math.abs(s[s.length - 1][0] - raw[raw.length - 1][0]) < 0.01, 'keeps the last point');
    assert.ok(E.polyLength(s) <= E.polyLength(raw) + 1e-9);
    var bend = [[30, 35], [35, 37], [45, 37], [55, 37], [62, 37], [62, 45], [62, 55], [62, 63], [50, 63], [38, 63]];   // hugs a corner
    for (var i = 1; i < bend.length; i++) assert.ok(E.segClear(L, bend[i - 1][0], bend[i - 1][1], bend[i][0], bend[i][1]));
    var sb = E.simplify(L, bend, 50);           // a huge tolerance would cut the corner…
    assert.ok(E.validDrawing(L, [sb]), '…but the result still goes around the wall');
  });
  test('erase hit-test finds the nearest stroke within reach', function () {
    var st = [[[10, 10], [50, 10]], [[10, 30], [50, 30]]];
    assert.strictEqual(E.strokeAt(st, 30, 12, 3.5), 0);
    assert.strictEqual(E.strokeAt(st, 30, 28, 3.5), 1);
    assert.strictEqual(E.strokeAt(st, 30, 20, 3.5), -1);
  });
  test('a drawing over budget is not legal; star rating combines cup, par and star', function () {
    var L = E.LEVELS[0];
    assert.ok(!E.validDrawing(L, [[[5, 40], [95, 40]], [[5, 60], [95, 60]]]), '180 ink > 140');
    var win = { result: 'win', got: 1 }, nostar = { result: 'win', got: 0 }, lose = { result: 'lose', got: 1 };
    assert.strictEqual(E.rate(L, L.par, win).stars, 3);
    assert.strictEqual(E.rate(L, L.par + 1, win).stars, 2);
    assert.strictEqual(E.rate(L, L.par, nostar).stars, 2);
    assert.strictEqual(E.rate(L, L.par + 1, nostar).stars, 1);
    assert.strictEqual(E.rate(L, 1, lose).stars, 0);
  });
  test('the sandbox has unlimited ink and still plays', function () {
    assert.strictEqual(E.SANDBOX.ink, Infinity);
    assert.ok(E.validDrawing(E.SANDBOX, [[[5, 50], [95, 52]], [[30, 90], [95, 92]], [[30, 128], [60, 130]], [[30, 60], [60, 62]], [[30, 65], [60, 67]]]));
    var r = E.simulate(E.SANDBOX, []);
    assert.ok(r.result === 'lose' && r.t > 0.5);
  });
  test('simulating every solution is fast', function () {
    var t0 = Date.now();
    E.LEVELS.forEach(function (L) { E.simulate(L, SOLUTIONS[L.id]); });
    assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms');
  });

  if (process.env.VERBOSE) console.log('wobble tolerance: ' + tol.join(', '));
  console.log(passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
}
