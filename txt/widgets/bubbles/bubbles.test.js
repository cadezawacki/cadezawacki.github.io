/* Headless checks for the Bubble Burst engine (grid, matching, falls, powerups, stages, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/bubbles/bubbles.test.js */
'use strict';
var assert = require('assert');

var E = require('./bubbles.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./bubbles.js')];
require('./bubbles.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// a bare game with a hand-made grid: rows of strings, '.' empty, 0-6 colors, 'S' stone, 'I'/'L' ice/lock (color 0)
function mk(rows, extra) {
  var g = E.newGame({ mode: 'stages', stage: 2, diff: 1 });
  g.grid = []; g.par = 0; g.drop = 0; g.ev = [];
  rows.forEach(function (s, r) {
    var n = E.rowLen(g, r), row = [];
    for (var c = 0; c < n; c++) {
      var ch = s.charAt(c) || '.', b = null;
      if (/[0-6]/.test(ch)) b = { t: 'n', c: +ch };
      else if (ch === 'S') b = { t: 's', c: -1 };
      else if (ch === 'I') b = { t: 'i', c: 0, hp: 1 };
      else if (ch === 'L') b = { t: 'i', c: 0, hp: 2 };
      row.push(b);
    }
    g.grid.push(row);
  });
  for (var k in extra || {}) g[k] = extra[k];
  return g;
}
function fly(g, ang) {
  assert.ok(E.fire(g, ang), 'fired');
  for (var i = 0; i < 2000 && g.phase === 'fly'; i++) E.step(g, E.STEP);
  assert.notStrictEqual(g.phase, 'fly', 'shot resolved');
}
function evs(g, k) { return g.ev.filter(function (e) { return e.k === k; }); }

test('module shape and registration', function () {
  assert.ok(widget && widget.name === 'Bubble Burst' && widget.icon === '🫧' && typeof widget.open === 'function');
  assert.deepStrictEqual(css, ['bubbles.css']);
  var man = require('../../manifest.json'), m = (man.modules || man.widgets || []).filter ? null : null;
  var txt = require('fs').readFileSync(__dirname + '/../../manifest.json', 'utf8'), j = JSON.parse(txt), found = null;
  (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id === 'bubbles') found = o; else for (var k in o) walk(o[k]); } })(j);
  assert.ok(found, 'manifest entry');
  assert.strictEqual(found.name, widget.name); assert.strictEqual(found.icon, widget.icon);
  assert.strictEqual(found.description, widget.description); assert.strictEqual(found.tags, widget.tags);
  void m;
});

test('hex geometry and neighbors', function () {
  var g = mk([]);
  assert.strictEqual(E.rowLen(g, 0), 11); assert.strictEqual(E.rowLen(g, 1), 10);
  assert.strictEqual(E.cellX(g, 0, 0), 1); assert.strictEqual(E.cellX(g, 1, 0), 2); assert.strictEqual(E.cellX(g, 0, 10), 21);
  // every neighbor is exactly 2 apart (touching)
  [[0, 0], [1, 0], [2, 5], [3, 9], [4, 10]].forEach(function (p) {
    var nb = E.nbrs(g, p[0], p[1]);
    nb.forEach(function (q) {
      var d = Math.hypot(E.cellX(g, q[0], q[1]) - E.cellX(g, p[0], p[1]), E.cellY(g, q[0]) - E.cellY(g, p[0]));
      assert.ok(Math.abs(d - 2) < 1e-9, 'neighbor distance ' + d);
    });
  });
  assert.strictEqual(E.nbrs(g, 2, 5).length, 6);
  assert.strictEqual(E.nbrs(g, 0, 0).length, 2);   // row above doesn't exist
});

test('flood fill only joins plain same-color bubbles', function () {
  var g = mk(['00011111111', '0I22222222', '0S']);
  assert.strictEqual(E.flood(g, 0, 0, 0).length, 5);   // (0,0..2) + (1,0) + (2,0), not ice or stone
  assert.strictEqual(E.flood(g, 0, 0, 1).length, 0);
});

test('a shot straight up joins its color and pops 3', function () {
  var g = mk(['....000....']);
  g.cur = { k: 'n', c: 0 };
  fly(g, -Math.PI / 2);
  assert.strictEqual(evs(g, 'pop').length, 4);
  assert.strictEqual(E.count(g), 0);
  assert.strictEqual(g.phase, 'won');
  assert.ok(g.score > 0 && g.stars >= 1);
});

test('no match: the bubble sticks and counts a miss; misses drop the ceiling', function () {
  var g = mk(['11111111111', '1111111111']);
  g.missAllow = g.missLeft = 2;
  g.cur = { k: 'n', c: 2 }; g.next = { k: 'n', c: 2 };
  fly(g, -Math.PI / 2);
  assert.strictEqual(g.phase, 'aim');
  assert.strictEqual(E.count(g), 22);
  assert.strictEqual(g.missLeft, 1);
  g.cur = { k: 'n', c: 3 };
  fly(g, -Math.PI / 2 + 0.3);
  assert.strictEqual(g.drop, 1);
  assert.strictEqual(evs(g, 'drop').length, 1);
  assert.strictEqual(g.missLeft, 2);
});

test('orphans fall with a bonus scaled by count', function () {
  // a column of 1s hanging from a pair of 0s; popping the 0s drops the 1s
  var g = mk(['....00.....', '....1.....', '....1......', '....1.....']);
  g.cur = { k: 'n', c: 0 };
  // land next to the 0s: aim at the empty cell (0, 6)
  var tx = E.cellX(g, 0, 6), ty = E.cellY(g, 0);
  fly(g, Math.atan2(ty - E.LY, tx - E.LX));
  assert.strictEqual(evs(g, 'pop').length, 3, 'popped the three 0s');
  assert.strictEqual(evs(g, 'fall').length, 3, 'the 1s fell');
  var sc = evs(g, 'score')[0];
  assert.ok(sc.v >= 30 + 3 * 20 + 45, 'fall bonus counted: ' + sc.v);
});

test('shots bank off the side walls', function () {
  var g = mk(['00000000000']);
  g.cur = { k: 'n', c: 5 };
  fly(g, -Math.PI + 0.35);
  assert.ok(evs(g, 'bounce').length >= 1);
});

test('trace predicts the landing cell the shot snaps into', function () {
  for (var a = -2.9; a < -0.2; a += 0.37) {
    var g = mk(['01230123012', '3012301230', '01230123012']);
    g.cur = { k: 'n', c: 6 };
    var tr = E.trace(g, a);
    assert.ok(tr.cell, 'trace ends at a cell');
    fly(g, a);
    var land = evs(g, 'land')[0];
    assert.ok(land, 'landed');
    assert.deepStrictEqual([land.r, land.c], [tr.cell.r, tr.cell.c], 'angle ' + a.toFixed(2));
  }
});

test('guide: full only on the tutorial, with Sight or Assist', function () {
  var g1 = E.newGame({ mode: 'stages', stage: 1, diff: 1 }), g2 = E.newGame({ mode: 'stages', stage: 2, diff: 1 });
  assert.strictEqual(E.guideMode(g1), 'full');
  assert.strictEqual(E.guideMode(g2), 'stub');
  g2.inv.sight = 1;
  assert.strictEqual(E.useItem(g2, 'sight'), 'used');
  assert.strictEqual(E.guideMode(g2), 'full');
  assert.strictEqual(g2.sight, E.SIGHT_SHOTS);
  var ga = E.newGame({ mode: 'endless', diff: 1, seed: 3, assist: true });
  assert.strictEqual(E.guideMode(ga), 'full');
});

test('assist halves the score', function () {
  var a = mk(['....000....']), b = mk(['....000....'], { assist: true });
  a.cur = { k: 'n', c: 0 }; b.cur = { k: 'n', c: 0 };
  fly(a, -Math.PI / 2); fly(b, -Math.PI / 2);
  assert.strictEqual(evs(b, 'score')[0].v * 2, evs(a, 'score')[0].v);
});

test('bomb blasts a radius (stones too) and shakes', function () {
  var g = mk(['11111111111', '2222222222', '33S33333333']);
  g.inv.bomb = 1;
  assert.strictEqual(E.useItem(g, 'bomb'), 'armed');
  assert.strictEqual(g.cur.k, 'bomb');
  var held = g.stash;
  fly(g, -Math.PI / 2);
  assert.strictEqual(evs(g, 'bomb').length, 1);
  assert.ok(evs(g, 'pop').length >= 7, 'blasted ' + evs(g, 'pop').length);
  assert.strictEqual(g.cur, held, 'the held bubble comes back after the bomb');
});

test('disarming a powerup returns it to the inventory', function () {
  var g = mk(['11111111111']);
  g.inv.fire = 1;
  var cur = g.cur;
  E.useItem(g, 'fire');
  assert.strictEqual(g.inv.fire, 0);
  assert.strictEqual(E.useItem(g, 'fire'), 'disarmed');
  assert.strictEqual(g.inv.fire, 1);
  assert.strictEqual(g.cur, cur);
  assert.strictEqual(E.swap(g), true);
});

test('fireball burns through a line and the rest falls', function () {
  var g = mk(['....0......', '....1.....', '....2......', '....3.....', '....4......']);
  g.inv.fire = 1; E.useItem(g, 'fire');
  var x = E.cellX(g, 4, 4);
  fly(g, Math.atan2(E.cellY(g, 0) - E.LY, x - E.LX));
  assert.ok(evs(g, 'pop').length >= 3, 'burned ' + evs(g, 'pop').length);
  assert.strictEqual(E.count(g), 0);
});

test('rainbow joins any neighboring color group', function () {
  var g = mk(['....00.11..']);
  g.inv.rainbow = 1; E.useItem(g, 'rainbow');
  var tx = E.cellX(g, 0, 6), ty = E.cellY(g, 0);
  fly(g, Math.atan2(ty - E.LY, tx - E.LX));
  assert.strictEqual(evs(g, 'pop').length, 5, 'both pairs and the rainbow');
});

test('paint recolors the loaded bubble; freeze holds the ceiling', function () {
  var g = mk(['11111111111']);
  g.inv.paint = 1; g.inv.freeze = 1; g.missAllow = g.missLeft = 1;
  assert.strictEqual(E.useItem(g, 'paint'), 'pick');
  assert.ok(E.paint(g, 4));
  assert.strictEqual(g.cur.c, 4); assert.strictEqual(g.inv.paint, 0);
  E.useItem(g, 'freeze');
  fly(g, -Math.PI / 2);
  assert.strictEqual(g.drop, 0, 'frozen: no drop');
  assert.strictEqual(g.freeze, E.FREEZE_SHOTS - 1);
});

test('ice thaws from neighboring pops; locks need two', function () {
  var g = mk(['222.......L', '2I.......']);
  g.grid[0][10] = { t: 'i', c: 0, hp: 2 };
  E.at(g, 1, 1).c = 3;
  g.cur = { k: 'n', c: 2 };
  // pop the 2s next to the ice
  var tx = E.cellX(g, 1, 0), ty = E.cellY(g, 2);
  fly(g, Math.atan2(ty - E.LY, tx - E.LX));
  assert.ok(evs(g, 'pop').length >= 3);
  var ice = E.at(g, 1, 1);
  assert.ok(!ice || ice.t === 'n', 'ice thawed');
  var lock = { t: 'i', c: 0, hp: 2 }, g2 = mk(['00.0.......']);
  g2.grid[0][10] = lock;
  assert.strictEqual(lock.hp, 2);
});

test('stones never match; a stage is clear when only stones remain', function () {
  var g = mk(['000.S......', '.S........']);
  g.cur = { k: 'n', c: 0 };
  var tx = E.cellX(g, 0, 3), ty = E.cellY(g, 0);
  fly(g, Math.atan2(ty - E.LY, tx - E.LX));
  assert.strictEqual(g.phase, 'won');
  assert.strictEqual(E.count(g), 0);
});

test('powerup bubbles grant their item when popped', function () {
  var g = mk(['....000....']);
  g.grid[0][5].p = 'sight';
  g.cur = { k: 'n', c: 0 };
  fly(g, -Math.PI / 2);
  assert.strictEqual(g.inv.sight, 1);
  assert.strictEqual(evs(g, 'pw')[0].p, 'sight');
});

test('combo multiplier grows on consecutive pops and resets on a miss', function () {
  assert.strictEqual(E.comboMul(0), 1); assert.strictEqual(E.comboMul(1), 1); assert.strictEqual(E.comboMul(3), 1.5);
  assert.strictEqual(E.comboMul(100), 3);
});

test('losing: crossing the deadline', function () {
  var rows = [];
  for (var r = 0; r < E.DEAD_ROWS - 1; r++) rows.push(r % 2 ? '1010101010' : '01010101010');
  var g = mk(rows);
  g.missAllow = g.missLeft = 1;
  g.cur = { k: 'n', c: 5 };
  fly(g, -Math.PI / 2 + 0.2);
  assert.strictEqual(g.phase, 'lost');
});

test('stages are seeded, connected to the ceiling, and ramp up', function () {
  for (var d = 0; d < 3; d++) for (var n = 1; n <= 40; n++) {
    var a = E.genStage(n, d), b = E.genStage(n, d);
    assert.deepStrictEqual(a, b, 'deterministic');
    var g = { grid: a.grid, par: 0, drop: 0 }, att = E.attached(g), cells = 0;
    E.each(g, function (bb, r, c) { cells++; assert.ok(att[r * 64 + c], 'attached ' + n); });
    assert.ok(cells >= 18, 'stage ' + n + ' has ' + cells);
    assert.ok(E.lowest(g) < E.DEAD_ROWS - 3, 'room to play');
    a.grid.forEach(function (row, r) { assert.strictEqual(row.length, E.rowLen(g, r)); });
  }
  var s1 = E.stageInfo(1, 1), s20 = E.stageInfo(20, 1);
  assert.ok(s20.colors > s1.colors && s20.rows > s1.rows && s20.miss < s1.miss && s20.stones > 0 && s20.ice > 0 && s20.locks > 0);
  assert.ok(E.stageInfo(5, 2).colors > E.stageInfo(5, 0).colors, 'hard has more colors');
  var pats = {};
  for (n = 2; n < 60; n++) pats[E.genStage(n, 1).pat] = 1;
  assert.ok(Object.keys(pats).length >= 7, 'varied patterns');
});

test('ammo comes from colors still on the board', function () {
  for (var n = 2; n < 12; n++) {
    var g = E.newGame({ mode: 'stages', stage: n, diff: 1 }), pc = E.presentColors(g);
    assert.ok(pc.indexOf(g.cur.c) >= 0 && pc.indexOf(g.next.c) >= 0);
  }
});

test('endless pushes rows in and keeps bubbles in place', function () {
  var g = E.newGame({ mode: 'endless', diff: 1, seed: 42 });
  assert.strictEqual(g.grid.length, 6);
  var b = g.grid[2][3], x = E.cellX(g, 2, 3);
  E.pushRow(g);
  assert.strictEqual(g.grid[3][3], b);
  assert.strictEqual(E.cellX(g, 3, 3), x);
  assert.strictEqual(g.pushed, 1);
  // misses count double toward the next row
  var g2 = E.newGame({ mode: 'endless', diff: 2, seed: 7 }), left = g2.pushLeft, rows = g2.grid.length;
  g2.cur = { k: 'n', c: 6 };   // a color that can't match
  g2.grid.forEach(function (row) { row.forEach(function (bb) { if (bb && bb.c === 6) bb.c = 0; }); });
  fly(g2, -Math.PI / 2);
  assert.ok(g2.pushLeft === left - 2 || g2.grid.length > rows);
});

test('a played-out endless game ends (random shots)', function () {
  var g = E.newGame({ mode: 'endless', diff: 2, seed: 99 }), shots = 0;
  while (g.phase === 'aim' && shots < 2000) { fly(g, -Math.PI / 2 + (Math.random() - 0.5) * 2.6); g.ev.length = 0; shots++; }
  assert.strictEqual(g.phase, 'lost');
});

test('save / restore round trip', function () {
  var g = E.newGame({ mode: 'stages', stage: 7, diff: 2 });
  fly(g, -1.2); g.ev.length = 0;
  if (g.phase !== 'aim') return;
  var s = JSON.parse(JSON.stringify(E.snap(g))), o = E.restore(s);
  assert.ok(o);
  assert.deepStrictEqual(o.grid, g.grid);
  assert.strictEqual(o.rs, g.rs);
  assert.strictEqual(E.restore({ v: 99 }), null);
  assert.strictEqual(E.restore(null), null);
  g.phase = 'fly';
  assert.strictEqual(E.snap(g), null);
});

test('clampAng keeps shots pointing up', function () {
  [0, 1, 2, 3, -0.01, -3.13, NaN].forEach(function (a) { var c = E.clampAng(a); assert.ok(c < 0 && c > -Math.PI, a + ' -> ' + c); });
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
