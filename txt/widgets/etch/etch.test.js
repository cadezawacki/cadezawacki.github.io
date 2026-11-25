/* Headless checks for the Etch Pad engine (drawing model, erasing, storage,
 * Trace targets and scoring, mazes, saves). Not loaded by the app (not in the
 * manifest). Run: node txt/widgets/etch/etch.test.js */
'use strict';
var assert = require('assert');

var E = require('./etch.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./etch.js')];
require('./etch.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function walk(d, dx, dy, steps) { var t = E.tip(d); for (var i = 1; i <= steps; i++) E.moveTo(d, t.x + dx * i, t.y + dy * i); }

test('module registers with the manifest name/icon', function () {
  assert.ok(widget, 'registerWidget called');
  assert.strictEqual(widget.name, 'Etch Pad');
  assert.strictEqual(widget.icon, '✏');
  assert.strictEqual(widget.description, 'Twin-knob line drawing toy — turn the dials, shake to erase, save your sketches');
  assert.strictEqual(widget.tags, 'toy,drawing,sketch,etch,knobs,relax,doodle,fun');
  assert.deepStrictEqual(css, ['etch.css']);
});

test('dimsFor keeps the long side and clamps the aspect', function () {
  assert.deepStrictEqual(E.dimsFor(800, 600), { w: 400, h: 300 });
  assert.deepStrictEqual(E.dimsFor(300, 400), { w: 300, h: 400 });
  var d = E.dimsFor(2000, 100);
  assert.strictEqual(d.w, 400); assert.strictEqual(d.h, 200);
});

test('straight knob lines collapse to one segment; turns keep vertices', function () {
  var d = E.newDrawing(400, 300, 100, 100);
  walk(d, 1, 0, 50);
  assert.strictEqual(E.nVert(d), 2);
  assert.deepStrictEqual(E.tip(d), { x: 150, y: 100 });
  walk(d, 0, 1, 30);
  assert.strictEqual(E.nVert(d), 3);
  walk(d, 1, 1, 20);
  assert.strictEqual(E.nVert(d), 4);
  assert.ok(Math.abs(E.inkLen(d) - (50 + 30 + Math.hypot(20, 20))) < 1e-6);
});

test('curves stay within the simplification tolerance', function () {
  var d = E.newDrawing(400, 300, 300, 150), pts = [];
  for (var i = 0; i <= 400; i++) { var a = i / 400 * Math.PI * 2, x = 200 + 100 * Math.cos(a), y = 150 + 100 * Math.sin(a); E.moveTo(d, x, y); pts.push(x, y); }
  assert.ok(E.nVert(d) < 200, 'simplified: ' + E.nVert(d));
  // every raw point lies near the stored polyline
  for (var k = 0; k < pts.length; k += 2) {
    var best = Infinity;
    for (var j = 1; j < E.nVert(d); j++) best = Math.min(best, E.distSeg(pts[k], pts[k + 1], d.p[2 * j - 2], d.p[2 * j - 1], d.p[2 * j], d.p[2 * j + 1]));
    assert.ok(best <= 0.31, 'deviation ' + best);
  }
});

test('the stylus cannot leave the screen', function () {
  var d = E.newDrawing(400, 300, 10, 10);
  walk(d, -5, -5, 10);
  assert.deepStrictEqual(E.tip(d), { x: 0, y: 0 });
  E.moveTo(d, 999, 999);
  assert.deepStrictEqual(E.tip(d), { x: 400, y: 300 });
  assert.strictEqual(E.moveTo(d, 1000, 1000), false, 'pinned against the corner: no move');
});

test('undo removes the last stroke only', function () {
  var d = E.newDrawing(400, 300, 50, 50);
  E.markStroke(d); walk(d, 1, 0, 40);
  E.markStroke(d); walk(d, 0, 1, 40);
  assert.deepStrictEqual(E.tip(d), { x: 90, y: 90 });
  assert.ok(E.undo(d));
  assert.deepStrictEqual(E.tip(d), { x: 90, y: 50 });
  assert.ok(E.undo(d));
  assert.deepStrictEqual(E.tip(d), { x: 50, y: 50 });
  assert.strictEqual(E.undo(d), false);
  // a stroke right after a mark must not be merged into the previous segment
  E.markStroke(d); walk(d, 1, 0, 10); E.markStroke(d); walk(d, 1, 0, 10);
  assert.ok(E.undo(d));
  assert.deepStrictEqual(E.tip(d), { x: 60, y: 50 });
});

test('shaking erases progressively, patchily, and leaves a ghost', function () {
  var d = E.newDrawing(400, 300, 20, 20);
  for (var r = 0; r < 8; r++) { walk(d, 1, 0, 360); walk(d, 0, 1, 3); walk(d, -1, 0, 360); walk(d, 0, 1, 3); }
  var ink0 = E.inkLen(d), left = [], shakes = 0, res;
  do { res = E.shake(d, 1000 + shakes, 0.5); shakes++; left.push(res.left); } while (!res.cleared && shakes < 30);
  assert.ok(res.cleared, 'clears eventually');
  assert.ok(shakes >= 3 && shakes <= 10, 'a few shakes to clear, took ' + shakes);
  for (var i = 1; i < left.length; i++) assert.ok(left[i] <= left[i - 1] + 1e-9, 'monotonic');
  assert.ok(d.ghosts.length === 1, 'ghost kept');
  assert.strictEqual(E.nVert(d), 1, 'fresh line at the stylus');
  assert.ok(E.inkLen(d) === 0 && ink0 > 5000);
  // after one shake strengths vary (patchy)
  var d2 = E.newDrawing(400, 300, 0, 150); walk(d2, 1, 0, 400);
  E.shake(d2, 7, 0.5);
  var mn = 1, mx = 0;
  for (var j = 1; j < E.nVert(d2); j++) { mn = Math.min(mn, d2.s[j]); mx = Math.max(mx, d2.s[j]); }
  assert.ok(mx - mn > 0.1, 'patchy: ' + mn + '..' + mx);
  assert.ok(mx < 1, 'everything lost some powder');
  // ghosts fade away with more shaking
  for (var k = 0; k < 20; k++) E.shake(d, 50 + k, 0.5);
  assert.strictEqual(d.ghosts.length, 0);
});

test('encode / decode round-trips (incl. partial strengths)', function () {
  var d = E.newDrawing(400, 300, 33.5, 44);
  walk(d, 1.5, 0, 30); walk(d, 0, -1, 20); walk(d, -0.7, 1.3, 25);
  var s = E.encode(d), back = E.decode(s);
  assert.strictEqual(back.w, 400); assert.strictEqual(back.h, 300);
  assert.strictEqual(E.nVert(back), E.nVert(d));
  for (var i = 0; i < d.p.length; i++) assert.ok(Math.abs(back.p[i] - d.p[i]) <= 0.25 + 1e-9);
  assert.ok(s.length < 80, 'compact: ' + s);
  E.shake(d, 3, 0.4);
  var b2 = E.decode(E.encode(d));
  for (var j = 1; j < E.nVert(d); j++) assert.ok(Math.abs(b2.s[j] - d.s[j]) <= 0.06);
  assert.strictEqual(E.decode('junk'), null);
  assert.strictEqual(E.decode('v1|400|300|1,2,3|'), null);
  assert.strictEqual(E.decode('v1|5|300|1,2|'), null);
});

test('refit maps a drawing into a new box', function () {
  var d = E.newDrawing(400, 300, 0, 0); E.moveTo(d, 400, 300);
  E.refit(d, 300, 400);
  assert.strictEqual(d.w, 300);
  assert.deepStrictEqual([d.p[0], d.p[1], d.p[2], d.p[3]], [0, 87.5, 300, 312.5]);
});

test('resample spaces points evenly and keeps the ends', function () {
  var r = E.resample([0, 0, 10, 0, 10, 10], 2);
  assert.deepStrictEqual(r.slice(0, 4), [0, 0, 2, 0]);
  assert.deepStrictEqual(r.slice(-2), [10, 10]);
  assert.strictEqual(r.length / 2, 11);
});

test('every Trace level yields a valid target inside the screen', function () {
  for (var lv = 1; lv <= 60; lv++) {
    [[400, 300], [300, 400], [400, 220]].forEach(function (wh) {
      var t = E.genTarget(lv, wh[0], wh[1], 'normal');
      assert.ok(t.pts.length >= 6, 'points at ' + lv);
      for (var i = 0; i < t.pts.length; i += 2) {
        assert.ok(t.pts[i] >= 0 && t.pts[i] <= wh[0] && t.pts[i + 1] >= 0 && t.pts[i + 1] <= wh[1], 'inside: level ' + lv + ' ' + t.kind);
      }
      assert.ok(t.time >= 8 && t.time < 400, 'time ' + t.time);
      assert.ok(t.tol >= 3 && t.tol <= 9);
      assert.ok(t.len > 100, 'long enough ' + t.kind + ' ' + t.len);
    });
  }
  // deterministic per level; harder settings are tighter
  assert.deepStrictEqual(E.genTarget(17, 400, 300).pts, E.genTarget(17, 400, 300).pts);
  assert.ok(E.genTarget(5, 400, 300, 'hard').tol < E.genTarget(5, 400, 300, 'easy').tol);
  assert.ok(E.genTarget(30, 400, 300).tol < E.genTarget(2, 400, 300).tol);
  var kinds = {};
  for (lv = 1; lv <= 14; lv++) kinds[E.genTarget(lv, 400, 300).kind] = 1;
  assert.strictEqual(Object.keys(kinds).length, 14, 'the first 14 levels show every shape');
});

test('Trace scoring: exact copy scores high, a scribble scores low, partial in between', function () {
  var t = E.genTarget(5, 400, 300);
  var perfect = E.scoreTrace(t.pts, [t.pts], t.tol);
  assert.ok(perfect.cov > 0.99 && perfect.acc > 0.99 && perfect.score >= 98 && perfect.stars === 3, JSON.stringify(perfect));
  var off = t.pts.map(function (v, i) { return v + (i % 2 ? 2 : -2); });
  var near = E.scoreTrace(t.pts, [off], t.tol);
  assert.ok(near.score >= 90, 'a slightly shifted copy still scores well ' + near.score);
  var half = t.pts.slice(0, Math.floor(t.pts.length / 4) * 2 + 2);
  var hs = E.scoreTrace(t.pts, [half], t.tol);
  assert.ok(hs.cov < 0.8 && hs.stars < 3, JSON.stringify(hs));
  var scrib = E.scoreTrace(t.pts, [[0, 0, 400, 300, 0, 300, 400, 0]], t.tol);
  assert.ok(scrib.score < 40 && scrib.stars === 0, JSON.stringify(scrib));
  assert.strictEqual(E.scoreTrace(t.pts, [], t.tol).score, 0);
  assert.deepStrictEqual([E.starsFor(59), E.starsFor(60), E.starsFor(78), E.starsFor(92)], [0, 1, 2, 3]);
});

test('mazes are solvable, walls stay inside, and the stylus starts clear', function () {
  for (var lv = 1; lv <= 30; lv += 3) {
    [[400, 300], [300, 400]].forEach(function (wh) {
      var mz = E.genMaze(lv, wh[0], wh[1], 1234 + lv, 'normal');
      assert.ok(mz.cell >= 14.9, 'cell ' + mz.cell);
      mz.walls.forEach(function (w) { assert.ok(w[0] >= 0 && w[2] <= wh[0] && w[1] >= 0 && w[3] <= wh[1]); });
      var r = 2;
      assert.ok(!E.mazeHit(mz, mz.start.x, mz.start.y, r), 'start clear');
      // BFS over cell centers through gaps (sample the edge midpoint between neighbors)
      var C = mz.cols, R = mz.rows, seen = {}, q = [[0, mz.inRow]], found = false;
      seen[0 + ',' + mz.inRow] = 1;
      while (q.length) {
        var c = q.shift();
        if (c[0] === C - 1 && c[1] === mz.outRow) { found = true; break; }
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dv) {
          var nx = c[0] + dv[0], ny = c[1] + dv[1];
          if (nx < 0 || ny < 0 || nx >= C || ny >= R || seen[nx + ',' + ny]) return;
          var mx = mz.ox + (c[0] + 0.5 + dv[0] * 0.5) * mz.cell, my = mz.oy + (c[1] + 0.5 + dv[1] * 0.5) * mz.cell;
          if (E.mazeHit(mz, mx, my, r)) return;
          seen[nx + ',' + ny] = 1; q.push([nx, ny]);
        });
      }
      assert.ok(found, 'solvable at level ' + lv);
      assert.ok(E.mazeWon(mz, mz.exit.x - 1, mz.exit.y));
      assert.ok(!E.mazeWon(mz, mz.start.x, mz.start.y));
    });
  }
  assert.ok(E.genMaze(10, 400, 300, 5).cols > E.genMaze(1, 400, 300, 5).cols, 'grows with level');
  assert.ok(E.genMaze(3, 400, 300, 5, 'easy').time > E.genMaze(3, 400, 300, 5, 'hard').time);
  assert.ok(E.mazeScore(5, 10) > E.mazeScore(5, 0));
});

test('maze collision detects wall contact', function () {
  var mz = E.genMaze(1, 400, 300, 9);
  var w = mz.walls[0];
  assert.ok(E.mazeHit(mz, (w[0] + w[2]) / 2, w[1] + 1, 2));
  assert.ok(!E.mazeHit(mz, (w[0] + w[2]) / 2, w[1] + 6, 2) || mz.cell < 8);
});

test('settings and career normalize junk and record Trace progress', function () {
  var s = E.normSettings({ sens: 99, thick: -3, frame: 'plaid', diff: 'nightmare', sound: false });
  assert.deepStrictEqual(s, { sens: 5, thick: 1, frame: 'red', sound: false, haptic: true, diff: 'normal', motion: false });
  assert.strictEqual(E.normSettings(null).sens, 3);
  var car = E.normCareer('nope');
  assert.strictEqual(car.trace.level, 1);
  var r = E.recordTrace(car, 1, { score: 81, stars: 2 });
  assert.ok(r.pass && r.newBest && r.unlockedNext);
  assert.strictEqual(car.trace.level, 2); assert.strictEqual(car.trace.unlocked, 2); assert.strictEqual(car.trace.streak, 1);
  r = E.recordTrace(car, 2, { score: 40, stars: 0 });
  assert.ok(!r.pass);
  assert.strictEqual(car.trace.level, 2); assert.strictEqual(car.trace.streak, 0); assert.strictEqual(car.trace.bestStreak, 1);
  E.recordTrace(car, 1, { score: 95, stars: 3 });
  assert.strictEqual(E.totalStars(car), 3);
  var back = E.normCareer(JSON.parse(JSON.stringify(car)));
  assert.deepStrictEqual(back, car);
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
