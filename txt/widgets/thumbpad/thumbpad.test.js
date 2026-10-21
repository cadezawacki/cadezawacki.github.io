/* Checks for the Thumb cursor pad: the step math (px -> steps, acceleration,
 * axis locking), hold-to-repeat timing, multi-tap counting, keyboard-open
 * detection and the plugin registration. Not loaded by the app.
 * Run: node txt/widgets/thumbpad/thumbpad.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var T = require('./thumbpad.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// The manifest entry this module needs (proposed; the manifest doesn't list it yet).
var MANIFEST = {
  id: 'thumbpad',
  type: 'plugin',
  name: 'Thumb cursor pad',
  description: 'On phones and tablets: a small trackpad above the keyboard — slide to move the cursor, double-tap to select a word, tap Select (or long-press the pad) to extend the selection. Turn off here if you don\'t want it',
  entry: 'widgets/thumbpad/thumbpad.js',
  css: 'widgets/thumbpad/thumbpad.css',
  settingKey: 'plugins.thumbpad',
  section: 'Editor',
  default: true,
};

// Feed a gesture as equal slices: total (dx, dy) over `events` events, `dt` ms apart.
function slide(tr, dx, dy, events, dt) {
  var out = { x: 0, y: 0, axes: [] };
  for (var i = 0; i < events; i++) {
    var r = tr.move(dx / events, dy / events, dt);
    if (r.n) { out[r.axis] += r.n; out.axes.push(r.axis); }
  }
  return out;
}

test('slow slides: one character per 8 px, one line per 18 px, both directions', function () {
  var tr = T.makeTracker();
  assert.strictEqual(slide(tr, 80, 0, 20, 30).x, 10);
  tr.reset();
  assert.strictEqual(slide(tr, -80, 0, 20, 30).x, -10);
  tr.reset();
  var r = slide(tr, 0, 54, 18, 30);
  assert.strictEqual(r.y, 3); assert.strictEqual(r.x, 0);
  tr.reset();
  assert.strictEqual(slide(tr, 0, -36, 12, 30).y, -2);
  tr.reset();
  assert.strictEqual(slide(tr, 7, 0, 7, 30).x, 0, 'under one step: nothing');
  assert.strictEqual(slide(tr, 1, 0, 1, 30).x, 1, 'the remainder carries over');
});
test('acceleration: fast swipes cover more, capped per event; the gain is monotonic', function () {
  var slow = T.makeTracker(), fast = T.makeTracker();
  var s = slide(slow, 80, 0, 10, 40).x;        // 0.2 px/ms
  var f = slide(fast, 80, 0, 4, 8).x;          // 2.5 px/ms
  assert.strictEqual(s, 10);
  assert.strictEqual(f, 80 * T.CFG.xGain / T.CFG.xStep);
  assert.strictEqual(T.gain(0.1, 4), 1);
  assert.strictEqual(T.gain(5, 4), 4);
  var prev = 0;
  for (var v = 0; v <= 2; v += 0.1) { var g = T.gain(v, 4); assert.ok(g >= prev, 'monotonic at ' + v); prev = g; }
  assert.ok(T.gain(0.9, 4) > 1 && T.gain(0.9, 4) < 4);
  var tr = T.makeTracker();
  assert.strictEqual(Math.abs(tr.move(4000, 0, 10).n), T.CFG.maxSteps, 'one event never jumps more than maxSteps');
  tr.reset();
  assert.strictEqual(tr.move(16, 0, 0).n, 2, 'no time delta: no acceleration');
  tr.reset();
  assert.strictEqual(tr.move(16, 0, 500).n, 2, 'a long pause: no acceleration');
});
test('diagonals: the dominant axis wins each step; the loser\'s travel is dropped', function () {
  var tr = T.makeTracker();
  var r = slide(tr, 80, 20, 20, 30);            // a sideways swipe with a thumb arc
  assert.strictEqual(r.y, 0, 'no line hop');
  assert.ok(r.x >= 9);
  tr.reset();
  r = slide(tr, 10, 72, 24, 30);                 // mostly vertical
  assert.strictEqual(r.x, 0);
  assert.strictEqual(r.y, 4);
});
test('axis locking: the moving axis keeps winning a near-tie, a clear turn switches', function () {
  // dx 4 / dy 10 per event is a near-tie (0.5 vs 0.56 steps): fresh, y wins…
  var fresh = T.makeTracker();
  var r = slide(fresh, 40, 100, 10, 30);
  assert.ok(r.y > 0 && r.x === 0, 'fresh near-tie goes vertical: ' + JSON.stringify(r));
  // …but after horizontal steps the same motion keeps moving x.
  var tr = T.makeTracker();
  slide(tr, 40, 0, 10, 30);
  assert.strictEqual(tr.axis(), 'x');
  r = slide(tr, 40, 100, 10, 30);
  assert.ok(r.x > 0 && r.y === 0, 'locked near-tie stays horizontal: ' + JSON.stringify(r));
  // A real turn (pure vertical) switches to lines.
  r = slide(tr, 0, 72, 24, 30);
  assert.ok(r.y >= 3, 'turned vertical: ' + JSON.stringify(r));
  assert.strictEqual(tr.axis(), 'y');
});
test('hold-to-repeat timing: press, then 350 ms, then every 90 ms', function () {
  assert.strictEqual(T.repeatDelay(0), 350);
  assert.strictEqual(T.repeatDelay(1), 90);
  assert.strictEqual(T.repeatDelay(7), 90);
  assert.strictEqual(T.repeatCount(0), 1);
  assert.strictEqual(T.repeatCount(349), 1);
  assert.strictEqual(T.repeatCount(350), 2);
  assert.strictEqual(T.repeatCount(439), 2);
  assert.strictEqual(T.repeatCount(440), 3);
  assert.strictEqual(T.repeatCount(1000), 9);
  // the delays the runtime chains add up to what repeatCount says
  var t = 0, n = 1;
  for (var i = 0; t + T.repeatDelay(i) <= 1000; i++) { t += T.repeatDelay(i); n++; }
  assert.strictEqual(n, T.repeatCount(1000));
});
test('taps: short and still; double / triple counted by gap and distance', function () {
  assert.ok(T.isTap(3, 0, 120));
  assert.ok(!T.isTap(12, 0, 120), 'moved');
  assert.ok(!T.isTap(3, 1, 120), 'stepped');
  assert.ok(!T.isTap(3, 0, 400), 'held');
  var a = T.nextTap(null, 0, 80, 100, 20);
  assert.strictEqual(a.n, 1);
  var b = T.nextTap(a, 200, 270, 104, 22);
  assert.strictEqual(b.n, 2);
  var c = T.nextTap(b, 400, 460, 98, 18);
  assert.strictEqual(c.n, 3);
  assert.strictEqual(T.nextTap(c, 560, 600, 98, 18).n, 1, 'a fourth tap starts over');
  assert.strictEqual(T.nextTap(a, 80 + 400, 520, 100, 20).n, 1, 'too slow');
  assert.strictEqual(T.nextTap(a, 200, 270, 180, 20).n, 1, 'too far apart');
});
test('keyboard-open detection from viewport sizes', function () {
  assert.strictEqual(T.keyboardOpen(844, 844, 1), false, 'no keyboard');
  assert.strictEqual(T.keyboardOpen(508, 844, 1), true, 'iPhone keyboard');
  assert.strictEqual(T.keyboardOpen(720, 844, 1), false, 'toolbar / accessory changes are not a keyboard');
  assert.strictEqual(T.keyboardOpen(170, 390, 1), true, 'landscape phone');
  assert.strictEqual(T.keyboardOpen(422, 844, 2), false, 'pinch zoom is not a keyboard');
  assert.strictEqual(T.keyboardOpen(254, 844, 2), true, 'zoomed with the keyboard up');
  assert.strictEqual(T.keyboardOpen(0, 844, 1), false);
  assert.strictEqual(T.keyboardOpen(500, 0, 1), false);
  assert.strictEqual(T.keyboardOpen(600, 844, 1, 0.6), false, 'custom ratio');
});
test('plugin registers as the manifest says, lifetime tied to a ViewPlugin, nothing runs at load', function () {
  var man = MANIFEST;
  try {   // once the manifest lists it, check that entry instead of the constant
    var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (x) { return x.id === 'thumbpad'; })[0];
    if (m) man = m;
  } catch (e) {}
  assert.strictEqual(man.type, 'plugin');
  assert.strictEqual(man.settingKey, 'plugins.thumbpad');
  assert.strictEqual(man.section, 'Editor');
  assert.strictEqual(man.default, true);
  assert.strictEqual(man.name, 'Thumb cursor pad');
  assert.ok(/trackpad above the keyboard/.test(man.description));
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', man.entry)), 'entry exists');
  assert.ok(fs.existsSync(path.join(__dirname, '..', '..', man.css)), 'css exists');
  var plug = null, touched = [];
  var trap = function (what) { return function () { touched.push(what); }; };
  var fake = {
    Cade: {
      baseURL: function () { return './txt/widgets/thumbpad/'; },
      loadCSS: trap('loadCSS'),
      registerPlugin: function (o) { plug = o; },
      CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } }, EditorView: { scrollMargins: { of: function (f) { return { __margins: f }; } } } },
    },
    matchMedia: trap('matchMedia'), addEventListener: trap('addEventListener'),
  };
  var doc = { addEventListener: trap('document.addEventListener'), createElement: trap('createElement') };
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'thumbpad.js'), 'utf8'))(fake, undefined, doc);
  assert.ok(plug, 'registered');
  assert.strictEqual(plug.id, man.id);
  var ext = [].concat(plug.ext);
  assert.ok(ext.some(function (e) { return e && e.__vp; }), 'lifetime tied to an editor ViewPlugin');
  assert.ok(ext.some(function (e) { return e && e.__margins; }), 'keeps the caret clear of the pad');
  assert.deepStrictEqual(touched, [], 'no listeners, media queries, DOM or CSS until the plugin starts');
  assert.ok(fake.__cadeThumbpad && typeof fake.__cadeThumbpad.force === 'function', 'debug hook');
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'thumbpad: ' + passed + ' passed');
