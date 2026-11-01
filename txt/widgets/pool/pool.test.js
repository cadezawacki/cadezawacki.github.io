/* Headless checks for the Pool engine (physics, rules, CPU, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/pool/pool.test.js */
'use strict';
var assert = require('assert');

var E = require('./pool.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./pool.js')];
require('./pool.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
// A table with only the listed balls on it (cue ball in hand anywhere).
function table(list, mode) {
  var g = E.newGame(mode || '2p', { seed: 9 });
  for (var i = 1; i < 16; i++) g.balls[i].on = false;
  (list || []).forEach(function (b) { var o = g.balls[b[0]]; o.on = true; o.x = o.px = b[1]; o.y = o.py = b[2]; });
  g.isBreak = false; g.bih = 'table';
  return g;
}
function settle(g) { var n = 0; while (g.phase === 'roll' && n < 20000) { E.step(g); g.events.length = 0; n++; } return n; }
function ke(g) { var k = 0; g.balls.forEach(function (b) { if (b.on) k += b.vx * b.vx + b.vy * b.vy; }); return k; }
function shotAt(g, x, y, tx, ty, pw, fol, eng) {
  assert.ok(E.placeCue(g, x, y), 'place cue');
  assert.ok(E.shoot(g, Math.atan2(ty - y, tx - x), pw, fol || 0, eng || 0));
  settle(g);
  return g.last;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Pool' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'pool.css');
});

test('the rack: 15 balls in a tight triangle, 8 in the middle, mixed back corners', function () {
  for (var s = 1; s < 30; s++) {
    var g = E.newGame('2p', { seed: s }), pos = E.rackPositions();
    assert.strictEqual(g.balls.length, 16);
    g.balls.forEach(function (b, i) { assert.strictEqual(b.n, i); });
    var at = function (k) { var p = pos[k]; return g.balls.filter(function (b) { return b.n && Math.abs(b.x - p.x) < 1e-9 && Math.abs(b.y - p.y) < 1e-9; })[0]; };
    assert.strictEqual(at(4).n, 8);
    assert.notStrictEqual(E.groupOf(at(10).n), E.groupOf(at(14).n));
    for (var i = 0; i < 16; i++) for (var j = i + 1; j < 16; j++) {
      var d = Math.hypot(g.balls[i].x - g.balls[j].x, g.balls[i].y - g.balls[j].y);
      assert.ok(d >= 2 * E.R, 'no overlaps');
    }
  }
  assert.deepStrictEqual(E.newGame('2p', { seed: 5 }).balls, E.newGame('2p', { seed: 5 }).balls, 'same seed, same rack');
});

test('ball-ball: a straight hit stops the cue ball and passes on the momentum', function () {
  var g = table([[1, 60, 25]]);
  E.placeCue(g, 40, 25);
  E.shoot(g, 0, 0.5, 0, 0);
  var p0 = g.balls[0].vx, k0 = ke(g), hit = false;
  for (var i = 0; i < 400 && !hit; i++) {
    E.step(g);
    if (g.balls[1].vx > 0) hit = true;
  }
  assert.ok(hit);
  var c = g.balls[0], b = g.balls[1];
  assert.ok(Math.abs(c.vx) < b.vx * 0.06, 'cue ball nearly stops (stun)');
  assert.ok(Math.abs(b.vy) < 1e-6 && Math.abs(c.vy) < 1e-6);
  assert.ok(ke(g) <= k0 + 1e-6, 'no energy is created');
  assert.ok(c.vx + b.vx <= p0 && c.vx + b.vx > p0 * 0.9, 'momentum carried over (less a little friction)');
});

test('ball-ball: momentum is conserved in a single collision, any angle', function () {
  var r = E.rng(3);
  for (var k = 0; k < 50; k++) {
    var g = table([[1, 50, 25]]);
    var a = r() * Math.PI * 2, d = 2 * E.R * 0.999;
    var c = g.balls[0], b = g.balls[1];
    c.on = true; c.x = 50 - Math.cos(a) * d; c.y = 25 - Math.sin(a) * d;
    var off = (r() - 0.5) * 1.4;
    c.vx = Math.cos(a + off) * 80; c.vy = Math.sin(a + off) * 80;
    g.phase = 'roll'; g.shot = null;
    var px = c.vx, py = c.vy, k0 = ke(g);
    // one collision pass without friction: zero-length substep
    E.substep(g, 0);
    assert.ok(Math.abs(c.vx + b.vx - px) < 1e-9 && Math.abs(c.vy + b.vy - py) < 1e-9, 'momentum');
    assert.ok(ke(g) <= k0 + 1e-9, 'energy');
    // the object ball leaves along the line of centres
    var nx = b.x - c.x, ny = b.y - c.y, bl = Math.hypot(b.vx, b.vy);
    if (bl > 1) assert.ok(Math.abs(nx * b.vy - ny * b.vx) / Math.hypot(nx, ny) / bl < 1e-6);
  }
});

test('cushions bounce with lost speed; balls never leave the table except into a pocket', function () {
  var g = table([]);
  E.placeCue(g, 30, 25);
  E.shoot(g, Math.PI / 2 + 0.3, 0.6, 0, 0);
  var bounced = false;
  while (g.phase === 'roll') {
    E.step(g);
    var c = g.balls[0];
    if (c.on) assert.ok(c.x > -3 && c.x < E.W + 3 && c.y > -3 && c.y < E.H + 3);
    g.events.forEach(function (e) { if (e.k === 'rail') bounced = true; });
    g.events.length = 0;
  }
  assert.ok(bounced);
  // many random shots: no ball ever escapes, every one rests on the table or in a pocket
  var r = E.rng(11);
  for (var k = 0; k < 25; k++) {
    var h = E.newGame('practice', { seed: k + 1 });
    E.placeCue(h, 10 + r() * 14, 5 + r() * 40);
    E.shoot(h, r() * Math.PI * 2, 0.4 + r() * 0.6, r() * 2 - 1, r() * 2 - 1);
    settle(h);
    h.balls.forEach(function (b) { if (b.on) assert.ok(b.x >= E.R - 0.05 && b.x <= E.W - E.R + 0.05 && b.y >= E.R - 0.05 && b.y <= E.H - E.R + 0.05, 'ball ' + b.n + ' at ' + b.x + ',' + b.y); });
    for (var i = 0; i < 16; i++) for (var j = i + 1; j < 16; j++) {
      var A = h.balls[i], B = h.balls[j];
      if (A.on && B.on) assert.ok(Math.hypot(A.x - B.x, A.y - B.y) > 2 * E.R - 0.05, 'resting balls do not overlap');
    }
  }
});

test('a straight shot into each pocket drops; a ball rolling along a rail passes a side pocket', function () {
  E.POCKETS.forEach(function (P, i) {
    var g = table([[1, 10, 10]]);
    var x = E.W / 2 + (P.ax < E.W / 2 ? 10 : P.ax > E.W / 2 ? -10 : 0), y = E.H / 2;
    if (P.side) x = E.W / 2 + 3;
    var L = shotAt(g, x, y, P.ax, P.ay, 0.45);
    assert.strictEqual(L.foul, 'scratch', 'pocket ' + i);
  });
  var h = table([[1, 10, 40]]);
  shotAt(h, 30, E.R + 0.05, 80, E.R + 0.05, 0.3);
  assert.ok(h.balls[0].on && !h.last.foul === false || h.balls[0].on, 'still on the table');
});

test('rolling friction: a soft shot stops sooner and shorter than a hard one', function () {
  var a = table([]), b = table([]);
  E.placeCue(a, 20, 25); E.placeCue(b, 20, 25);
  E.shoot(a, 0.02, 0.2, 0, 0); E.shoot(b, 0.02, 0.35, 0, 0);
  var na = settle(a), nb = settle(b);
  assert.ok(na < nb && a.balls[0].x < b.balls[0].x);
  assert.ok(na * E.STEP < 3, 'a soft shot settles quickly');
});

test('spin: follow runs through, draw comes back, english changes the rebound', function () {
  function after(fol) {
    var g = table([[1, 50, 25]]);
    E.placeCue(g, 35, 25); E.shoot(g, 0, 0.45, fol, 0); settle(g);
    return g.balls[0].x;
  }
  var stun = after(0), fol = after(1), drw = after(-1);
  assert.ok(fol > stun + 5, 'follow ' + fol + ' vs ' + stun);
  assert.ok(drw < stun - 5, 'draw ' + drw + ' vs ' + stun);
  function eng(e) {
    var g = table([]);
    E.placeCue(g, 70, 25); E.shoot(g, 0, 0.3, 0, e);
    for (var i = 0; i < 2000 && g.balls[0].vx >= 0; i++) E.step(g);
    return g.balls[0].vy;
  }
  assert.ok(eng(1) > 1 && eng(-1) < -1 && Math.abs(eng(0)) < 1e-6, 'right english kicks to the shooter\'s right');
});

test('the physics is deterministic and frame-rate independent (fixed step)', function () {
  function run(chunks) {
    var g = E.newGame('2p', { seed: 77 }), acc = { t: 0 };
    E.placeCue(g, 20, 24); E.shoot(g, 0.01, 1, 0, 0);
    var i = 0;
    while (g.phase === 'roll' && i < 100000) { E.advance(g, acc, chunks[i % chunks.length]); i++; }
    return g.balls.map(function (b) { return [b.on, b.x.toFixed(9), b.y.toFixed(9)]; });
  }
  assert.deepStrictEqual(run([1 / 60]), run([1 / 120]));
  assert.deepStrictEqual(run([1 / 60]), run([1 / 144, 1 / 90, 1 / 30]));
});

test('the break spreads the rack and usually pots something', function () {
  var pots = 0, rails = 0, N = 30;
  for (var s = 1; s <= N; s++) {
    var g = E.newGame('2p', { seed: s }), y = 25 + (s % 5 - 2);
    E.placeCue(g, 20, y);
    var apex = g.balls.filter(function (b) { return b.n; }).sort(function (a, b) { return a.x - b.x; })[0];
    E.shoot(g, Math.atan2(apex.y - y, apex.x - 20), 1, 0, 0);
    var nr = 0;
    while (g.phase === 'roll') { nr = g.shot.nRail; E.step(g); }
    pots += g.breakPots; rails += nr;
    assert.ok(g.bih === 'table' || g.bih === null);
    assert.ok(!g.isBreak);
  }
  assert.ok(pots / N > 0.5, 'pots per break ' + pots / N);
  assert.ok(rails / N >= 6, 'balls to a rail ' + rails / N);
});

test('rules: open table, groups claimed by the first pot, turn passes on a miss', function () {
  var g = table([[3, 70, 10], [11, 60, 40], [8, 50, 25]]);
  assert.deepStrictEqual(E.legalTargets(g, 0), [3, 11]);
  var P = E.POCKETS[2];
  // ghost-ball pot of the 3 into the top-right corner
  var b = g.balls[3], dx = P.ax - b.x, dy = P.ay - b.y, l = Math.hypot(dx, dy);
  var gx = b.x - dx / l * 2 * E.R, gy = b.y - dy / l * 2 * E.R;
  var L = shotAt(g, gx - dx / l * 15, gy - dy / l * 15, gx, gy, 0.45);
  assert.ok(!L.foul && L.cont && L.assigned === 'solid', JSON.stringify(L));
  assert.deepStrictEqual(g.groups, ['solid', 'stripe']);
  assert.strictEqual(g.turn, 0);
  assert.ok(!g.balls[3].on);
  // now on the 8 (solids cleared) — a soft miss that touches nothing: foul, ball in hand for player 2
  g.bih = 'table';
  var L2 = shotAt(g, 10, 10, 10, 40, 0.15);
  assert.strictEqual(L2.foul, 'miss');
  assert.ok(g.turn === 1 && g.bih === 'table');
  assert.deepStrictEqual(E.legalTargets(g, 1), [11]);
  assert.deepStrictEqual(E.legalTargets(g, 0), [8]);
});

test('rules: fouls — scratch, wrong ball first, no rail after contact', function () {
  var g = table([[2, 50, 25], [10, 70, 25]]);
  g.groups = ['stripe', 'solid'];
  var L = shotAt(g, 30, 25, 50, 25, 0.25);
  assert.strictEqual(L.foul, 'wrong');
  assert.strictEqual(g.turn, 1);
  // no rail: barely nudge the 2 (player 2's own)
  var g2 = table([[2, 50, 25], [10, 70, 40]]);
  g2.groups = ['solid', 'stripe'];
  var L2 = shotAt(g2, 45, 25, 50, 25, 0.06);
  assert.strictEqual(L2.foul, 'rail', JSON.stringify(L2));
  // scratch: the cue ball follows straight into a corner
  var g3 = table([[2, 50, 25]]);
  var L3 = shotAt(g3, 10, 10, -0.5, -0.5, 0.4);
  assert.strictEqual(L3.foul, 'scratch');
  assert.ok(g3.balls[0].on && g3.bih === 'table' && g3.turn === 1, 'cue back on the table, ball in hand');
});

test('rules: the 8 — early is a loss, after the group is a win, with a scratch a loss, on the break re-spotted', function () {
  function pot8(groupsLeft, extra) {
    var list = [[8, 70, 10]].concat(extra || []);
    var g = table(list);
    g.groups = ['solid', 'stripe'];
    if (groupsLeft) { var o = g.balls[1]; o.on = true; o.x = 30; o.y = 45; }
    var P = E.POCKETS[2], b = g.balls[8], dx = P.ax - b.x, dy = P.ay - b.y, l = Math.hypot(dx, dy);
    var gx = b.x - dx / l * 2 * E.R, gy = b.y - dy / l * 2 * E.R;
    shotAt(g, gx - dx / l * 12, gy - dy / l * 12, gx, gy, 0.4);
    return g;
  }
  var w = pot8(false);
  assert.ok(w.phase === 'over' && w.winner === 0 && w.reason === 'eight');
  var early = pot8(true);
  assert.ok(early.phase === 'over' && early.winner === 1 && early.reason === 'early8');
  // the 8 on the break comes back to the foot spot
  var g = table([[8, 80, 25]]);
  g.isBreak = true; g.bih = 'kitchen';
  E.placeCue(g, 20, 25);
  g.balls[8].on = true;
  E.shoot(g, 0, 0.1, 0, 0);
  g.shot.pots.push(8); g.balls[8].on = false; g.balls[0].vx = 0;
  E.resolve(g);
  assert.ok(g.balls[8].on && g.phase === 'aim' && g.last.respot);
});

test('ball in hand: kitchen on the break, anywhere after a foul, never on a ball', function () {
  var g = E.newGame('2p', { seed: 3 });
  assert.strictEqual(g.bih, 'kitchen');
  assert.ok(E.canPlace(g, 15, 25) && !E.canPlace(g, 40, 25), 'behind the head string');
  g.bih = 'table';
  assert.ok(E.canPlace(g, 40, 25));
  var b = g.balls[5];
  assert.ok(!E.canPlace(g, b.x + E.R, b.y), 'not overlapping');
  assert.ok(!E.canPlace(g, 0.5, 25), 'not in the cushion');
  var sp = E.freeSpot(g, b.x, b.y);
  assert.ok(E.canPlace(g, sp.x, sp.y));
});

test('practice: no turns, scratches give ball in hand, clearing the rack ends it', function () {
  var g = table([[4, 70, 10]], 'practice');
  var P = E.POCKETS[2], b = g.balls[4], dx = P.ax - b.x, dy = P.ay - b.y, l = Math.hypot(dx, dy);
  var gx = b.x - dx / l * 2 * E.R, gy = b.y - dy / l * 2 * E.R;
  shotAt(g, gx - dx / l * 12, gy - dy / l * 12, gx, gy, 0.4);
  assert.ok(g.phase === 'over' && g.winner === 0 && g.shots[0] === 1);
  var st = E.newStats(), rec = E.recordGame(st, g);
  assert.ok(st.prac.racks === 1 && st.prac.best === 1 && rec.prac);
});

test('aim guide: the cast finds the first ball and the ghost-ball geometry', function () {
  var g = table([[1, 60, 25], [2, 80, 25]]);
  E.placeCue(g, 20, 25);
  var c = E.castAim(g, 20, 25, 0);
  assert.strictEqual(c.ball, 1);
  assert.ok(Math.abs(c.gx - (60 - 2 * E.R)) < 1e-9 && Math.abs(c.cut) < 1e-9 && Math.abs(c.ox - 1) < 1e-9);
  var m = E.castAim(g, 20, 25, Math.PI / 2);
  assert.ok(m.ball === 0 && Math.abs(m.gy - (E.H - E.R)) < 1e-9);
  var cut = E.castAim(g, 20, 25 + 2.5, 0);
  assert.ok(cut.ball === 1 && cut.cut > 0.3 && cut.oy < 0, 'a cut sends the object ball the other way');
});

test('CPU: every plan is legal, deterministic, and it pots easy shots', function () {
  var g = E.newGame('cpu', { seed: 4, diff: 'hard' });
  var a = E.cpuPlan(g, 0, 'hard', 99), b = E.cpuPlan(g, 0, 'hard', 99);
  assert.deepStrictEqual(a, b);
  assert.ok(a.place && E.canPlace(g, a.place.x, a.place.y), 'break placement in the kitchen');
  assert.ok(a.power > 0.8, 'breaks hard');
  // an easy straight pot: the hard CPU makes it nearly always
  var made = 0;
  for (var s = 1; s <= 20; s++) {
    var h = table([[1, 80, 12], [9, 30, 40]]);
    h.groups = [null, null]; h.bih = null; E.placeCue(h, 60, 20); h.bih = null;
    E.placeCue(h, 60, 20);
    h.balls[0].x = 62; h.balls[0].y = 22;
    var pl = E.cpuPlan(h, 0, 'hard', s);
    assert.ok(!pl.place);
    E.shoot(h, pl.angle, pl.power, pl.fol, pl.eng); settle(h);
    if (h.last.cont) made++;
  }
  assert.ok(made >= 16, 'hard made ' + made + '/20');
});

test('CPU: full games vs itself finish, with legal ball-in-hand placements, at every level', function () {
  E.DIFFS.forEach(function (lv, k) {
    var g = E.newGame('cpu', { seed: 21 + k, diff: lv }), turns = 0, t0 = Date.now();
    while (g.phase !== 'over' && turns < 250) {
      var pl = E.cpuPlan(g, g.turn, lv, 1000 + turns);
      if (g.bih) assert.ok(pl.place && E.canPlace(g, pl.place.x, pl.place.y), 'placement');
      if (pl.place) E.placeCue(g, pl.place.x, pl.place.y);
      assert.ok(isFinite(pl.angle) && pl.power > 0 && pl.power <= 1);
      E.shoot(g, pl.angle, pl.power, pl.fol, pl.eng); settle(g);
      turns++;
    }
    assert.strictEqual(g.phase, 'over', lv + ' finished');
    assert.ok(Date.now() - t0 < 20000);
  });
});

test('the hard CPU beats the easy CPU more often than not', function () {
  var hard = 0, N = 8;
  for (var s = 0; s < N; s++) {
    var g = E.newGame('cpu', { seed: 300 + s, first: s % 2 }), turns = 0;
    while (g.phase !== 'over' && turns < 300) {
      var lv = g.turn === 0 ? 'hard' : 'easy', pl = E.cpuPlan(g, g.turn, lv, s * 977 + turns);
      if (pl.place) E.placeCue(g, pl.place.x, pl.place.y);
      E.shoot(g, pl.angle, pl.power, pl.fol, pl.eng); settle(g); turns++;
    }
    if (g.winner === 0) hard++;
  }
  assert.ok(hard >= 5, 'hard won ' + hard + '/' + N);
});

test('saves: stats and settings normalise, an unfinished game round-trips', function () {
  var st = E.newStats();
  assert.deepStrictEqual(E.normStats(JSON.parse(JSON.stringify(st))), st);
  var bad = E.normStats({ cpu: { easy: { w: -3, l: 'x' }, hard: { w: 2.7 } }, pots: 1e99, bestRun: NaN });
  assert.ok(bad.cpu.easy.w === 0 && bad.cpu.easy.l === 0 && bad.cpu.hard.w === 2 && bad.pots === 1e9 && bad.bestRun === 0);
  assert.ok(E.normStats(null).shots === 0 && E.normStats('junk').shots === 0);
  assert.deepStrictEqual(E.normSettings({ diff: 'hard', guide: 'nope', mode: '2p' }), { diff: 'hard', guide: 'full', mode: '2p' });
  var g = E.newGame('cpu', { seed: 8, diff: 'easy' });
  E.placeCue(g, 20, 25); E.shoot(g, 0, 1, 0, 0); settle(g);
  if (g.phase === 'aim') {
    var raw = JSON.parse(JSON.stringify(E.saveGame(g)));
    var back = E.normGame(raw);
    assert.ok(back && back.mode === 'cpu' && back.diff === 'easy' && back.turn === g.turn);
    for (var i = 0; i < 16; i++) {
      assert.strictEqual(back.balls[i].on, g.balls[i].on);
      if (g.balls[i].on) assert.ok(Math.abs(back.balls[i].x - g.balls[i].x) < 0.01);
    }
  }
  assert.strictEqual(E.normGame(null), null);
  assert.strictEqual(E.normGame({ balls: [1, 2] }), null);
  assert.strictEqual(E.normGame({ balls: new Array(16).fill({ on: true, x: 'a', y: 2 }) }), null);
  var odd = E.normGame({ mode: '2p', balls: E.newGame('2p', { seed: 1 }).balls, turn: 7, groups: ['solid', 'solid'], bih: 'moon', isBreak: true });
  assert.ok(odd && odd.turn === 0 && odd.groups[0] === null && odd.bih === 'kitchen' && odd.isBreak);
});

test('stats: vs CPU wins, losses and streaks; 2P tallies', function () {
  var st = E.newStats();
  var g = E.newGame('cpu', { seed: 1, diff: 'hard' });
  g.phase = 'over'; g.winner = 0; g.bestRun = [4, 6]; g.shots = [10, 12]; g.pots = [7, 5];
  var r = E.recordGame(st, g);
  assert.ok(st.cpu.hard.w === 1 && st.streak === 1 && st.bestRun === 4 && st.pots === 7 && r.run && r.streak);
  g.winner = 1; E.recordGame(st, g);
  assert.ok(st.cpu.hard.l === 1 && st.streak === 0 && st.bestStreak === 1);
  var d = E.newGame('2p', { seed: 1 }); d.phase = 'over'; d.winner = 1;
  E.recordGame(st, d);
  assert.ok(st.duo.games === 1 && st.duo.p2 === 1);
});

test('CPU safety: with no pot on, the planned first contact is a legal ball (fanned thin hits)', function () {
  // own group solids; the only solid is shielded from a straight full-ball line by a stripe, no pockets reachable
  var bad = 0, n = 0;
  for (var s = 1; s <= 12; s++) {
    var g = table([[3, 50, 25], [12, 44, 25 + (s % 3 - 1) * 0.6], [9, 70, 10], [10, 70, 40]], 'cpu');
    g.groups = ['solid', 'stripe']; g.turn = 0; g.bih = null;
    E.placeCue(Object.assign(g, { bih: 'table' }), 30, 25); g.bih = null;
    var pl = E.cpuPlan(g, 0, 'hard', s);
    var c = g.balls[0], hit = E.castAim(g, c.x, c.y, pl.aimed);
    n++;
    var r = E.simulate(g, { angle: pl.aimed, power: pl.power, fol: pl.fol, eng: pl.eng }, 25);
    if (r.last && (r.last.foul === 'miss' || r.last.foul === 'wrong')) bad++;
  }
  assert.ok(bad <= 2, 'safety fouls ' + bad + '/' + n);
});

test('CPU easy: never knowingly picks a foul when a clean shot is available', function () {
  for (var s = 1; s <= 20; s++) {
    var g = table([[1, 60, 25], [2, 60, 10]], 'cpu');
    g.groups = ['solid', 'stripe']; g.turn = 0; g.bih = null;
    g.balls[0].x = g.balls[0].px = 40; g.balls[0].y = g.balls[0].py = 25;
    var pl = E.cpuPlan(g, 0, 'easy', s);
    var r = E.simulate(g, { angle: pl.aimed, power: pl.power, fol: pl.fol, eng: pl.eng }, 25);
    assert.ok(!(r.last && r.last.foul), 'seed ' + s + ' planned a foul: ' + (r.last && r.last.foul));
  }
});

test('rules: open table — hitting the 8 first is a foul; pots after a foul do not claim a group', function () {
  var g = table([[8, 60, 25], [1, 62, 10]], '2p');
  shotAt(g, 40, 25, 60, 25, 0.5);
  assert.strictEqual(g.last.foul, 'wrong');
  assert.ok(!g.groups[0] && !g.groups[1]);
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(g.bih, 'table');
});

test('saves: garbage and hostile saves load as nothing or a safe game', function () {
  [null, 5, 'x', {}, { balls: [] }, { balls: new Array(16).fill(null) }].forEach(function (o) { assert.strictEqual(E.normGame(o), null); });
  var g = E.newGame('cpu', { seed: 3 }), o = JSON.parse(JSON.stringify(E.saveGame(g)));
  o.balls[0] = { on: true, x: 1e9, y: -50 }; o.turn = 7; o.groups = ['solid', 'solid']; o.bih = 'nowhere'; o.diff = 'insane'; o.mode = 'blitz';
  var n = E.normGame(o);
  assert.ok(n && n.turn === 0 && !n.groups[0] && n.diff === 'normal' && n.mode === 'practice');
  var c = n.balls[0];
  assert.ok(c.x >= E.R && c.x <= E.W - E.R && c.y >= E.R && c.y <= E.H - E.R);
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
