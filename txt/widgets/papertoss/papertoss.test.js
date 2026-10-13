/* Headless checks for the Paper Toss engine (physics, scoring, drafts).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/papertoss/papertoss.test.js */
'use strict';
var assert = require('assert');

// Load the widget against a minimal fake Cade and grab its pure engine.
var widget = null;
global.window = { Cade: { loadCSS: function () {}, registerWidget: function (w) { widget = w; } } };
require('./papertoss.js');
assert.ok(widget && widget._engine, 'widget registered with an _engine');
var E = widget._engine;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function finite(b) {
  return [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.spin].every(function (v) { return typeof v === 'number' && isFinite(v); });
}

test('registration matches the manifest entry', function () {
  assert.strictEqual(widget.name, 'Paper Toss');
  assert.strictEqual(typeof widget.open, 'function');
  var fs = require('fs'), path = require('path');
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var entry = m.modules.filter(function (x) { return x.id === 'papertoss'; })[0];
  assert.ok(entry, 'manifest has a papertoss entry');
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.entry, 'widgets/papertoss/papertoss.js');
});

test('a perfect throw in zero wind goes in clean on every level', function () {
  for (var lv = 0; lv < E.LEVELS.length; lv++) {
    var r = E.simulate(lv, 0, 0, 0);
    assert.strictEqual(r.result, 'in', 'level ' + lv);
    assert.strictEqual(r.swish, true, 'level ' + lv + ' swish');
    assert.ok(r.events.indexOf('in') !== -1);
  }
});

test('power has a forgiving window that narrows with distance', function () {
  function window_(lv) {
    var n = 0;
    for (var p = -1; p <= 1.0001; p += 0.05) if (E.simulate(lv, 0, 0, p).result === 'in') n++;
    return n;
  }
  var w0 = window_(0), w2 = window_(2);
  assert.ok(w0 >= 9, 'desk power window ' + w0);
  assert.ok(w2 >= 5 && w2 < w0, 'hallway power window ' + w2);
});

test('a strong crosswind blows a straight throw wide; aiming into it scores', function () {
  for (var lv = 0; lv < E.LEVELS.length; lv++) {
    var W = E.LEVELS[lv].windMax;
    [W, -W].forEach(function (w) {
      var straight = E.simulate(lv, w, 0, 0);
      assert.strictEqual(straight.result, 'miss', 'lv ' + lv + ' wind ' + w + ' straight');
      assert.strictEqual(straight.kind === 'rim' || straight.kind === (w > 0 ? 'right' : 'left'), true,
        'drifts downwind (' + straight.kind + ')');
      var aim = E.aimFor(lv, w, 0);
      assert.ok(aim * w < 0, 'compensation points upwind');
      assert.ok(Math.abs(aim) < E.AIM_MAX, 'compensation is reachable');
      var into = E.simulate(lv, w, aim, 0);
      assert.strictEqual(into.result, 'in', 'lv ' + lv + ' wind ' + w + ' aimed into it');
      var withIt = E.simulate(lv, w, -aim, 0);
      assert.strictEqual(withIt.result, 'miss', 'lv ' + lv + ' wind ' + w + ' aimed with it');
    });
  }
});

test('misses are detected and classified; every throw ends', function () {
  var short = E.simulate(0, 0, 0, -3), long = E.simulate(0, 0, 0, 2);
  var left = E.simulate(1, 0, -1.1, 0), right = E.simulate(1, 0, 1.1, 0);
  assert.strictEqual(short.result, 'miss'); assert.strictEqual(short.kind, 'short');
  assert.strictEqual(long.result, 'miss'); assert.strictEqual(long.kind, 'long');
  assert.strictEqual(left.result, 'miss'); assert.strictEqual(left.kind, 'left');
  assert.strictEqual(right.result, 'miss'); assert.strictEqual(right.kind, 'right');
  [short, long, left, right].forEach(function (r) {
    assert.ok(r.t <= 6.01, 'ends within the timeout');
    assert.ok(r.by > 0 && isFinite(r.by));
    assert.ok(r.y >= E.BALL_R - 1e-6, 'rests on the floor, not under it');
  });
  // an out-of-range flick is clamped, not exploded
  var wild = E.simulate(2, 99, 50, 50);
  assert.strictEqual(wild.result, 'miss');
  assert.ok(isFinite(wild.x) && isFinite(wild.z));
  // the hallway's side walls keep a wide throw in the corridor
  assert.ok(Math.abs(E.simulate(2, 0, 1.1, 1).x) <= E.LEVELS[2].side + 1e-9);
});

test('rim hits rattle in or out without NaN, and always settle', function () {
  var ins = 0, outs = 0, rims = 0;
  for (var lv = 0; lv < E.LEVELS.length; lv++) {
    var L = E.LEVELS[lv];
    for (var p = -0.6; p <= 0.6001; p += 0.025) {
      for (var a = -0.2; a <= 0.2001; a += 0.02) {
        var b = E.newBall(L, 0, a, p), n = 0;
        while (b.state === 'fly' && n++ < 4000) {
          E.stepBall(b);
          if (!finite(b)) throw new Error('non-finite state at lv ' + lv + ' pow ' + p + ' aim ' + a);
        }
        assert.strictEqual(b.state, 'done', 'settled');
        var j = E.judge(b);
        if (b.rims) { rims++; if (j.result === 'in') ins++; else outs++; assert.strictEqual(j.swish, false); }
      }
    }
  }
  assert.ok(rims > 50, 'rim contacts happen (' + rims + ')');
  assert.ok(ins > 5 && outs > 5, 'rim-ins ' + ins + ' and rim-outs ' + outs);
});

test('a ball that drops dead-centre onto the rim plane is handled (degenerate normal)', function () {
  var L = E.LEVELS[0], b = E.newBall(L, 0, 0, 0);
  b.x = 0; b.z = L.D - E.BIN_R; b.y = E.BIN_H + 0.001; b.px = b.x; b.pz = b.z; b.py = b.y + 0.01;
  b.vx = 0; b.vy = -1; b.vz = 0;
  for (var i = 0; i < 3000 && b.state === 'fly'; i++) { E.stepBall(b); assert.ok(finite(b)); }
  assert.strictEqual(b.state, 'done');
});

test('fixed timestep: the same throw at 60 Hz and 120 Hz frames lands identically', function () {
  var L = E.LEVELS[1];
  function run(hz) {
    var b = E.newBall(L, 2.1, E.aimFor(1, 2.1, 0), 0.05), f = 0;
    while (b.state === 'fly' && f++ < 2000) E.advance(b, 1 / hz);
    return b;
  }
  var a = run(60), b = run(120);
  assert.strictEqual(a.steps, b.steps);
  assert.strictEqual(a.x, b.x); assert.strictEqual(a.z, b.z);
  assert.strictEqual(a.result, b.result);
});

test('determinism: a seed fixes the winds; simulations repeat exactly', function () {
  function play(seed) {
    var g = E.newGame(seed), log = [];
    for (var i = 0; i < 40; i++) {
      var r = E.simulate(g.level, g.wind, E.aimFor(g.level, g.wind, 0) * (i % 7 === 6 ? -1 : 1), (i % 5) * 0.03);
      var o = E.applyResult(g, r);
      log.push([g.wind, g.level, g.score, g.streak, r.result, r.x, r.z, o.pts]);
    }
    return log;
  }
  assert.deepStrictEqual(play(12345), play(12345));
  assert.notDeepStrictEqual(play(12345).map(function (x) { return x[0]; }), play(54321).map(function (x) { return x[0]; }));
  assert.deepStrictEqual(E.simulate(2, -3.3, 0.1, 0.2), E.simulate(2, -3.3, 0.1, 0.2));
});

test('runs: calm first throw, streak moves the bin back, a miss ends the run', function () {
  var g = E.newGame(7);
  assert.strictEqual(g.wind, 0, 'first throw of a run is calm');
  var IN = { result: 'in', swish: true }, RIM_IN = { result: 'in', swish: false }, MISS = { result: 'miss' };
  var o = E.applyResult(g, IN);
  assert.strictEqual(o.pts, 2); assert.strictEqual(g.score, 2); assert.strictEqual(g.streak, 1);
  E.applyResult(g, RIM_IN); assert.strictEqual(g.score, 3);
  o = E.applyResult(g, IN);
  assert.strictEqual(g.level, 1); assert.strictEqual(o.levelFrom, 0); assert.strictEqual(o.levelTo, 1);
  for (var i = 0; i < 5; i++) E.applyResult(g, RIM_IN);
  assert.strictEqual(g.streak, 8); assert.strictEqual(g.level, 2);
  o = E.applyResult(g, RIM_IN); assert.strictEqual(o.pts, 3);
  var before = g.score;
  o = E.applyResult(g, MISS);
  assert.strictEqual(o.runOver, true); assert.strictEqual(o.runScore, before);
  assert.strictEqual(g.score, 0); assert.strictEqual(g.streak, 0); assert.strictEqual(g.level, 0);
  assert.strictEqual(g.wind, 0, 'the next run starts calm');
  assert.strictEqual(g.made, 9); assert.strictEqual(g.thrown, 10);
  // winds stay within each level's range and are shown to one decimal
  var g2 = E.newGame(99);
  for (var k = 0; k < 300; k++) {
    E.applyResult(g2, k % 9 === 8 ? MISS : IN);
    var lim = E.LEVELS[g2.level].windMax;
    assert.ok(Math.abs(g2.wind) <= lim + 1e-9, 'wind ' + g2.wind + ' within ' + lim);
    assert.strictEqual(Math.round(g2.wind * 10) / 10, g2.wind);
  }
});

test('note lines are cleaned up for the sheet (read-only helper)', function () {
  var c = E.cleanLine;
  assert.strictEqual(c(''), null);
  assert.strictEqual(c('   '), null);
  assert.strictEqual(c('---'), null);
  assert.strictEqual(c('```js'), null);
  assert.strictEqual(c('https://example.com/a/very/long/path/to/something'), null);
  assert.strictEqual(c('x'.repeat(200)), null);
  assert.strictEqual(c('# Shopping list'), 'Shopping list');
  assert.strictEqual(c('- [ ] buy more paper'), 'buy more paper');
  assert.strictEqual(c('> quoted   words here'), 'quoted words here');
  var long = c('The quick sketch of chapter two where the detective finally admits she hates mysteries');
  assert.ok(long.length <= 40 && /…$/.test(long), long);
  E.DRAFTS.forEach(function (d) { assert.ok(d.length <= 36, 'draft fits the sheet: ' + d); });
  assert.ok(E.DRAFTS.length >= 40);
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
