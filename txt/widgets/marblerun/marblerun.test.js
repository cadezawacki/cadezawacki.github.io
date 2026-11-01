/* Headless checks for the Marble Run engine (collisions, parts, levels, codes, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/marblerun/marblerun.test.js */
'use strict';
var assert = require('assert');

// The module exports its pure engine for node (no DOM, no Cade needed)…
var E = require('./marblerun.js');
var P = E.P;
// …and registers the same engine on the widget when a Cade core is present.
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./marblerun.js')];
require('./marblerun.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function run(pieces, maxT) { return E.simulate(pieces, maxT || 60); }
// Step a sim, collecting every event kind.
function runEv(pieces, maxT) {
  var sim = E.newSim(pieces), ev = {}, n = Math.ceil((maxT || 30) / E.STEP), maxSp = 0;
  for (var i = 0; i < n && !sim.done; i++) {
    E.stepSim(sim);
    sim.events.forEach(function (e) { ev[e.k] = (ev[e.k] || 0) + 1; });
    sim.events.length = 0;
    sim.marbles.forEach(function (m) { if (m.st === 'roll') maxSp = Math.max(maxSp, Math.hypot(m.vx, m.vy)); });
  }
  sim.ev = ev; sim.maxSp = maxSp;
  return sim;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Marble Run' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'marblerun.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
  assert.ok(widget.icon && widget.description && widget.tags);
});

test('closest point: segments clamp to their ends, arcs to their span', function () {
  var o = { g: 's', ax: 0, ay: 0, bx: 2, by: 0 };
  o.dx = 2; o.dy = 0; o.il2 = 1 / 4;
  var c = E.closest(o, 1, 1); assert.ok(c.x === 1 && c.y === 0);
  c = E.closest(o, -3, 1); assert.ok(c.x === 0 && c.y === 0);
  c = E.closest(o, 5, -1); assert.ok(c.x === 2 && c.y === 0);
  var a = { g: 'a', cx: 0, cy: 0, r: 1, a0: Math.PI / 2, a1: Math.PI };   // the lower-left quarter (y down)
  c = E.closest(a, -0.3, 0.3); assert.ok(Math.abs(Math.hypot(c.x, c.y) - 1) < 1e-9 && c.x < 0 && c.y > 0);
  c = E.closest(a, 1, -0.1); assert.ok(Math.abs(c.x) < 1e-9 && Math.abs(c.y - 1) < 1e-9);   // outside the span → nearest end
});

test('every part type has geometry inside its cell and its forms differ', function () {
  E.TYPES.forEach(function (t) {
    var seen = {};
    for (var f = 0; f < t.forms; f++) {
      var g = E.geo(t.id, f);
      g.forEach(function (o) {
        var pts = o.g === 's' ? [[o.ax, o.ay], [o.bx, o.by]] : o.g === 'd' ? [[o.cx - o.r, o.cy - o.r], [o.cx + o.r, o.cy + o.r]]
          : [[o.cx + Math.cos(o.a0) * o.r, o.cy + Math.sin(o.a0) * o.r], [o.cx + Math.cos(o.a1) * o.r, o.cy + Math.sin(o.a1) * o.r]];
        pts.forEach(function (p) { assert.ok(p[0] >= -1e-9 && p[0] <= 1 + 1e-9 && p[1] >= -1e-9 && p[1] <= 1 + 1e-9, t.id + ' f' + f + ' leaves its cell'); });
      });
      if (t.id !== 'emit' && t.id !== 'tele') { var k = JSON.stringify(g); assert.ok(!seen[k], t.id + ' forms repeat'); seen[k] = 1; }
    }
  });
});

test('a marble falls freely under gravity', function () {
  var sim = E.newSim([P('emit', 4, 0, 0, 1)]);
  for (var i = 0; i < 40; i++) E.stepSim(sim);   // spawns at 0.15 s
  var m = sim.marbles[0], y0 = m.y, v0 = m.vy;
  for (i = 0; i < 48; i++) E.stepSim(sim);       // 0.2 s
  var dv = m.vy - v0, dy = m.y - y0;
  assert.ok(Math.abs(dv - E.G * 0.2) < 1e-6, 'dv ' + dv);
  assert.ok(Math.abs(dy - (v0 * 0.2 + 0.5 * E.G * 0.04)) < 0.02, 'dy ' + dy);
  assert.ok(Math.abs(m.x - 4.5) < 1e-9);
});

test('a marble comes to rest on a wall and never sinks into it', function () {
  var sim = E.newSim([P('emit', 4, 0, 0, 1), P('wall', 4, 6)]);
  for (var i = 0; i < 6 / E.STEP; i++) { E.stepSim(sim); sim.events.length = 0; }
  var m = sim.marbles[0];
  assert.ok(m.st === 'roll' && Math.abs(m.y - (6 - E.R)) < 0.01, 'rests on top: ' + m.y);
  assert.ok(Math.abs(m.vx) + Math.abs(m.vy) < 0.05);
  assert.ok(sim.done, 'a run ends once everything is at rest');
});

test('no tunnelling: the fastest marble cannot pass through a thin ramp', function () {
  // drop from far above the board so the marble is at top speed when it meets a single ramp
  var sim = E.newSim([P('ramp', 4, 12, 2)]);
  sim.marbles.push({ id: 1, x: 4.5, y: -20, px: 4.5, py: -20, vx: 0, vy: E.MAXV, st: 'roll', still: 0, tp: 0, split: 0, hue: 0 });
  for (var i = 0; i < 4 / E.STEP; i++) { E.stepSim(sim); sim.events.length = 0; }
  var m = sim.marbles.length ? sim.marbles[0] : null;
  // it must have been deflected by the ramp: it leaves the board to the right of where it fell
  assert.ok(!m || m.x > 5 || m.st === 'lost');
  var sim2 = E.newSim([P('wall', 4, 12)]);
  sim2.marbles.push({ id: 1, x: 4.5, y: -20, px: 4.5, py: -20, vx: 0, vy: E.MAXV, st: 'roll', still: 0, tp: 0, split: 0, hue: 0 });
  for (i = 0; i < 4 / E.STEP; i++) { E.stepSim(sim2); sim2.events.length = 0; }
  assert.ok(sim2.marbles[0].y < 12, 'stopped by the wall at y ' + sim2.marbles[0].y);
});

test('ramps send marbles downhill both ways and never gain energy', function () {
  var r = runEv([P('emit', 2, 0, 0, 1), P('ramp', 2, 3, 0)], 6);
  assert.ok(r.lost === 1);
  var l = E.newSim([P('emit', 7, 0, 0, 1), P('ramp', 7, 3, 1)]);
  for (var i = 0; i < 1.2 / E.STEP; i++) { E.stepSim(l); l.events.length = 0; }
  assert.ok(l.marbles[0].vx < -1, 'goes left');
  // energy: speed² ≤ 2·g·drop (+ the spawn nudge) everywhere along the way
  var s = E.newSim([P('emit', 2, 0, 0, 1), P('ramp', 2, 3, 0), P('ramp', 3, 4, 0), P('curve', 4, 6, 0)]);
  for (i = 0; i < 3 / E.STEP; i++) {
    E.stepSim(s); s.events.length = 0;
    var m = s.marbles[0];
    if (m && m.st === 'roll') assert.ok(m.vx * m.vx + m.vy * m.vy <= 2 * E.G * (m.y - 0.55) + 0.3, 'energy at ' + m.y);
  }
});

test('marbles collide with each other (and conserve momentum)', function () {
  var sim = E.newSim([]);
  sim.marbles.push({ id: 1, x: 3, y: 5, px: 3, py: 5, vx: 4, vy: 0, st: 'roll', still: 0, tp: 0, split: 0, hue: 0 });
  sim.marbles.push({ id: 2, x: 3.5, y: 5, px: 3.5, py: 5, vx: -4, vy: 0, st: 'roll', still: 0, tp: 0, split: 0, hue: 1 });
  var px0 = 0;
  for (var k = 0; k < 20; k++) E.stepSim(sim);
  var a = sim.marbles[0], b = sim.marbles[1];
  assert.ok(a.vx < 0 && b.vx > 0, 'they bounce apart');
  assert.ok(Math.abs(a.vx + b.vx - px0) < 1e-9, 'momentum');
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= 2 * E.R - 1e-9, 'no overlap');
  // a stack in a funnel: many marbles never overlap much
  var st = E.newSim([P('emit', 4, 0, 0, 10), P('wall', 4, 6), P('wall', 3, 5), P('wall', 5, 5)]);
  for (var i = 0; i < 10 / E.STEP; i++) { E.stepSim(st); st.events.length = 0; }
  var ms = st.marbles.filter(function (m) { return m.st === 'roll'; });
  for (i = 0; i < ms.length; i++) for (var j = i + 1; j < ms.length; j++) assert.ok(Math.hypot(ms[i].x - ms[j].x, ms[i].y - ms[j].y) > 2 * E.R * 0.9);
});

test('bumpers kick, trampolines spring, belts carry', function () {
  var b = runEv([P('emit', 4, 0, 0, 1), P('bump', 4, 5)], 2);
  assert.ok(b.ev.bump >= 1);
  var t = E.newSim([P('emit', 4, 0, 0, 1), P('tramp', 4, 8, 0)]), up = false, minY = 99;
  for (var i = 0; i < 2 / E.STEP; i++) {
    E.stepSim(t); t.events.forEach(function (e) { if (e.k === 'tramp') up = true; }); t.events.length = 0;
    if (up && t.marbles[0]) minY = Math.min(minY, t.marbles[0].y);
  }
  assert.ok(up && minY < 4, 'springs high: ' + minY);
  var c = E.newSim([P('emit', 1, 5, 0, 1), P('belt', 1, 6, 0)]);
  for (i = 0; i < 0.8 / E.STEP; i++) { E.stepSim(c); c.events.length = 0; }
  assert.ok(c.marbles[0].vx > 3, 'belt speed ' + c.marbles[0].vx);
  var cl = E.newSim([P('emit', 8, 5, 0, 1), P('belt', 8, 6, 1)]);
  for (i = 0; i < 0.8 / E.STEP; i++) { E.stepSim(cl); cl.events.length = 0; }
  assert.ok(cl.marbles[0].vx < -3);
});

test('flippers alternate; splitters alternate dead-centre drops', function () {
  var sim = E.newSim([P('emit', 4, 0, 0, 4), P('flip', 4, 3, 0)]), seen = {}, sides = [];
  for (var i = 0; i < 8 / E.STEP; i++) {
    E.stepSim(sim); sim.events.length = 0;
    sim.marbles.forEach(function (m) { if (!seen[m.id] && m.y > 7) { seen[m.id] = 1; sides.push(m.x < 4.5 ? 'L' : 'R'); } });
  }
  assert.strictEqual(sides.join(''), 'RLRL');
  var sp = E.newSim([P('emit', 4, 0, 0, 4), P('split', 4, 5)]), seen2 = {}, s2 = [];
  for (i = 0; i < 8 / E.STEP; i++) {
    E.stepSim(sp); sp.events.length = 0;
    sp.marbles.forEach(function (m) { if (!seen2[m.id] && m.y > 8) { seen2[m.id] = 1; s2.push(m.x < 4.5 ? 'L' : 'R'); } });
  }
  assert.ok(/^(LR|RL)+$/.test(s2.join('')), s2.join(''));
});

test('teleporters pair by colour and send marbles out the other one', function () {
  var sim = runEv([P('emit', 1, 0, 0, 2), P('tele', 1, 4, 1), P('tele', 8, 2, 1), P('cup', 8, 12)], 8);
  assert.ok(sim.ev.tele === 2 && sim.caught === 2);
  var one = runEv([P('emit', 1, 0, 0, 1), P('tele', 1, 4, 0), P('tele', 8, 2, 2)], 4);   // different colours: no pair
  assert.ok(!one.ev.tele);
  var s = E.newSim([P('tele', 1, 1, 0), P('tele', 5, 5, 0), P('tele', 2, 9, 0)]);
  assert.deepStrictEqual([E.partner(s, s.teles[0]).c, E.partner(s, s.teles[1]).c, E.partner(s, s.teles[2]).c], [5, 2, 1], 'a ring in reading order');
});

test('cups catch and count; the edges lose marbles; runs end', function () {
  var sim = run([P('emit', 3, 0, 0, 3), P('cup', 3, 12, 0, 2)]);
  assert.ok(sim.done && sim.caught === 3 && sim.won && sim.cups[0].cnt === 3);
  var lost = run([P('emit', 3, 0, 0, 2)]);
  assert.ok(lost.done && lost.lost === 2 && !lost.won && !lost.needs);
  var none = run([]);
  assert.ok(none.done && none.total === 0);
});

test('the same layout always plays out the same (and at any frame rate)', function () {
  var lv = E.LEVELS[E.LEVELS.length - 1], pcs = E.levelPieces(lv, lv.sol);
  var a = run(pcs), b = run(pcs);
  assert.strictEqual(a.t, b.t); assert.strictEqual(a.caught, b.caught);
  var x = E.newSim(pcs), y = E.newSim(pcs), i;
  for (i = 0; i < 240; i++) E.advance(x, 1 / 60);
  for (i = 0; i < 480; i++) E.advance(y, 1 / 120);
  assert.ok(Math.abs(x.steps - y.steps) <= 1);
  var al = E.advance(E.newSim(pcs), 0.013);
  assert.ok(al >= 0 && al < 1);
  var big = E.newSim(pcs); E.advance(big, 5);
  assert.ok(big.steps <= Math.ceil(0.1 / E.STEP) + 1, 'a long hitch is clamped');
});

test('at least 15 levels, each solvable by its solution, none solved empty', function () {
  assert.ok(E.LEVELS.length >= 15);
  var names = {};
  E.LEVELS.forEach(function (lv, i) {
    assert.ok(!names[lv.name], 'unique names'); names[lv.name] = 1;
    assert.ok(lv.hint && lv.par >= 1);
    assert.strictEqual(E.normPlaced(lv, lv.sol).length, lv.sol.length, lv.name + ': the solution fits the inventory');
    var s = run(E.levelPieces(lv, lv.sol));
    assert.ok(s.won, lv.name + ' solution wins (' + s.caught + '/' + s.total + ')');
    assert.ok(E.starsFor(lv, s, lv.sol.length) >= 2, lv.name + ' solution earns 2+ stars');
    var e = run(E.levelPieces(lv, []));
    assert.ok(!e.won, lv.name + ' is not solved by doing nothing');
    var cups = lv.fixed.filter(function (p) { return p.t === 'cup'; }), em = 0, need = 0;
    lv.fixed.forEach(function (p) { if (p.t === 'emit') em += p.n; if (p.t === 'cup') need += p.n; });
    assert.ok(cups.length && need <= em, lv.name + ' needs no more marbles than it has');
  });
});

test('placing obeys the inventory and the level\'s own cells', function () {
  var lv = E.LEVELS[0], placed = [];
  assert.ok(!E.canPlace(lv, placed, 'ramp', 1, 0), 'not on the emitter');
  assert.ok(!E.canPlace(lv, placed, 'bump', 3, 3), 'not a part the level offers');
  for (var i = 0; i < lv.inv.ramp; i++) { assert.ok(E.canPlace(lv, placed, 'ramp', i + 3, 5)); placed.push(P('ramp', i + 3, 5)); }
  assert.ok(!E.canPlace(lv, placed, 'ramp', 8, 8), 'none left');
  assert.ok(!E.canPlace(lv, placed, 'ramp', 3, 5) && !E.canPlace(lv, [], 'ramp', -1, 3) && !E.canPlace(lv, [], 'ramp', 3, 14));
  assert.strictEqual(E.invLeft(lv, placed).ramp, 0);
  assert.strictEqual(E.normPlaced(lv, placed.concat([P('ramp', 0, 9)])).length, lv.inv.ramp, 'extra parts are dropped');
});

test('stars: solve, par, every marble', function () {
  var lv = E.LEVELS[0];
  assert.strictEqual(E.starsFor(lv, { won: false, caught: 3, total: 3 }, 1), 0);
  assert.strictEqual(E.starsFor(lv, { won: true, caught: 3, total: 3 }, 1), 3);
  assert.strictEqual(E.starsFor(lv, { won: true, caught: 3, total: 3 }, 2), 2);
  assert.strictEqual(E.starsFor(lv, { won: true, caught: 2, total: 3 }, 3), 1);
});

test('share codes round-trip and reject junk', function () {
  var pcs = [P('emit', 4, 0, 2), P('ramp', 0, 0, 3), P('curve', 9, 13, 1), P('tele', 5, 7, 2), P('cup', 4, 12), P('flip', 2, 2, 1)];
  var code = E.encode(pcs);
  assert.ok(/^MR1-[A-Za-z0-9_-]+$/.test(code) && code.length < 40);
  assert.deepStrictEqual(E.decode(code), pcs.map(function (p) { return { t: p.t, c: p.c, r: p.r, f: p.f }; }));
  assert.deepStrictEqual(E.decode('  ' + code + '\n'), E.decode(code), 'whitespace is ignored');
  assert.strictEqual(E.decode(code.slice(0, -1) + (code.slice(-1) === 'A' ? 'B' : 'A')), null, 'checksum');
  assert.strictEqual(E.decode('hello'), null);
  assert.strictEqual(E.decode('MR1-!!'), null);
  assert.deepStrictEqual(E.decode(E.encode([])), []);
  // the whole board fits
  var all = [];
  for (var r = 0; r < E.ROWS; r++) for (var c = 0; c < E.COLS; c++) all.push(P(E.TYPES[(r * 3 + c) % E.TYPES.length].id, c, r, 0));
  assert.strictEqual(E.decode(E.encode(all)).length, E.COLS * E.ROWS);
});

test('saves normalise defensively', function () {
  var s = E.newSave();
  assert.strictEqual(s.stars.length, E.LEVELS.length);
  assert.strictEqual(s.placed.length, E.LEVELS.length);
  assert.deepStrictEqual(E.normSave(JSON.parse(JSON.stringify(s))), s);
  var bad = E.normSave({
    stars: [5, -1, 'x', 2], cur: 99, runs: -3,
    placed: [[{ t: 'ramp', c: 3, r: 3, f: 9 }, { t: 'ramp', c: 3, r: 3 }, { t: 'nope', c: 1, r: 1 }, { t: 'ramp', c: 1, r: 0 }, null]],
    sandbox: [{ t: 'cup', c: 50, r: 1 }, { t: 'bump', c: 2, r: 2 }],
    slots: [{ name: 'x'.repeat(60), pieces: [{ t: 'wall', c: 0, r: 0 }] }, 'junk', null]
  });
  assert.deepStrictEqual(bad.stars.slice(0, 4), [3, 0, 0, 2]);
  assert.strictEqual(bad.cur, E.LEVELS.length - 1);
  assert.strictEqual(bad.runs, 0);
  assert.deepStrictEqual(bad.placed[0], [{ t: 'ramp', c: 3, r: 3, f: 1 }], 'one ramp: no duplicates, no fixed cells, forms wrapped');
  assert.deepStrictEqual(bad.sandbox, [{ t: 'bump', c: 2, r: 2, f: 0 }]);
  assert.ok(bad.slots[0].name.length <= 24 && bad.slots[0].pieces.length === 1 && bad.slots[1] === null && bad.slots.length === E.SLOTS);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('garbage'), E.newSave());
});

test('levels unlock as you go', function () {
  var s = E.newSave();
  assert.ok(E.unlocked(s, 0) && E.unlocked(s, 2) && !E.unlocked(s, 3));
  s.stars[0] = 1;
  assert.ok(E.unlocked(s, 3) && !E.unlocked(s, 4));
  s.stars[1] = 2; s.stars[2] = 3;
  assert.ok(E.unlocked(s, 5) && !E.unlocked(s, 6));
  assert.strictEqual(E.totalStars(s), 6);
});

test('endless bouncers and teleport loops still end the run', function () {
  var s = run([P('emit', 4, 0, 0, 1), P('tramp', 4, 8, 0)], 120);
  assert.ok(s.done && s.t < E.IDLE_T + 3, 'a marble bouncing forever on a flat trampoline ends after the idle limit (' + s.t.toFixed(1) + 's)');
  var t = run([P('emit', 4, 0, 0, 1), P('tele', 4, 3, 0), P('tele', 4, 10, 0)], 120);
  assert.ok(t.done && t.lost + t.caught === 1, 'a teleport hop downwards does not loop');
  var v = run([P('emit', 4, 0, 0, 1), P('ramp', 3, 5, 0), P('ramp', 4, 5, 1)], 120);
  assert.ok(v.done && v.t < 10, 'a marble at rest in a V ends the run');
  var w = run([P('emit', 4, 0, 0, 1), P('belt', 4, 3, 0), P('belt', 5, 3, 0), P('wall', 6, 3)], 120);
  assert.ok(w.done && w.t < 10 && Math.abs(w.marbles[0].y - (3.72 - E.R)) < 0.02, 'a belt pinning a marble on a wall comes to rest on the belt');
});

test('a hundred marbles stay finite, out of the walls and inside the frame budget', function () {
  var pcs = [];
  for (var c = 0; c < E.COLS; c++) pcs.push(P('emit', c, 0, 3));
  pcs.push(P('funnel', 4, 6), P('funnel', 3, 5), P('funnel', 5, 5), P('cup', 4, 13), P('ramp', 0, 4, 0), P('ramp', 9, 4, 1), P('ramp', 1, 8, 2), P('ramp', 8, 8, 3),
    P('bump', 2, 10), P('tramp', 7, 11, 0), P('belt', 4, 9, 0), P('wall', 5, 9), P('split', 4, 11), P('flip', 6, 7, 0), P('curve', 2, 12, 0));
  var sim = E.newSim(pcs), t0 = Date.now(), n = 0;
  while (!sim.done && n < 240 * 40) {
    E.stepSim(sim); sim.events.length = 0; n++;
    if (n % 60 === 0) sim.marbles.forEach(function (m) {
      assert.ok(isFinite(m.x) && isFinite(m.y) && isFinite(m.vx) && isFinite(m.vy), 'finite');
      if (m.st !== 'roll') return;
      var L = sim.cells[Math.floor(m.x) + Math.floor(m.y) * E.COLS] || [];
      L.forEach(function (o) { if (o.g === 's') { var cp = E.closest(o, m.x, m.y); assert.ok(Math.hypot(m.x - cp.x, m.y - cp.y) > E.R * 0.5, 'not sunk into a segment'); } });
    });
  }
  assert.ok(sim.done, 'the run ends');
  assert.strictEqual(sim.total, 100);
  assert.ok((Date.now() - t0) / n * 4 < 4, 'four steps (one 60 Hz frame) stay well under a frame');
});

test('every part and form survives a share code', function () {
  var pcs = [], i = 0;
  E.TYPES.forEach(function (t) { for (var f = 0; f < t.forms; f++, i++) pcs.push(P(t.id, i % E.COLS, (i / E.COLS) | 0, f)); });
  assert.deepStrictEqual(E.decode(E.encode(pcs)), pcs.map(function (p) { return { t: p.t, c: p.c, r: p.r, f: p.f }; }));
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
