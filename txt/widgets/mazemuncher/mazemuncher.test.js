/* Headless checks for the Maze Muncher engine (mazes, movement, chasers, scoring, records).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/mazemuncher/mazemuncher.test.js */
'use strict';
var assert = require('assert');

var E = require('./mazemuncher.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./mazemuncher.js')];
require('./mazemuncher.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var W = E.W, H = E.H;
function wx(x) { return ((x % W) + W) % W; }
function onPath(m, x, y) { return E.open(m, wx(Math.round(x)), Math.round(y)); }
function drain(g) { g.events.length = 0; g.pops.length = 0; g.ate.length = 0; }
// a game already in play on maze m with the chasers parked in the house
function quiet(mi) {
  var g = E.newGame({ seed: 7 });
  if (mi) { g.ps[0].level = [1, 3, 5, 7][mi]; g.ps[0].mi = mi; g.m = E.MAZES[mi]; g.ps[0].dots = new Uint8Array(g.m.dot); g.ps[0].left = g.m.ndots; }
  g.phase = 'play'; g.pt = 0;
  g.gh.forEach(function (h) { h.st = 'house'; h.x = E.HOME_X[h.i]; h.y = E.HOUSE_Y; });
  g.rel = { at: [1e9, 1e9, 1e9, 1e9], dots: [1e9, 1e9, 1e9, 1e9], idle: 1e9 };
  return g;
}
function autoRun(seed, secs, opts) {
  var o = opts || {}; o.seed = seed;
  var g = E.newGame(o), ev = {};
  for (var i = 0; i < secs * 120 && g.phase !== 'over'; i++) {
    if (g.phase === 'play') E.autoPilot(g);
    if (g.phase === 'handoff') E.handoffReady(g);
    E.step(g);
    g.events.forEach(function (e) { ev[e] = (ev[e] || 0) + 1; });
    drain(g);
  }
  g.ev = ev;
  return g;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Maze Muncher' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'mazemuncher.css');
  assert.strictEqual(widget._engine.STEP, E.STEP);
});

test('mazes: four, symmetric, connected, no dead ends, one-wide corridors', function () {
  assert.ok(E.MAZES.length >= 4);
  E.MAZES.forEach(function (m) {
    assert.strictEqual(m.rows.length, H, m.name);
    var seen = {}, q = [m.py * W + m.px], n = 0, paths = 0;
    m.rows.forEach(function (r) { assert.strictEqual(r.length, W); assert.strictEqual(r, r.split('').reverse().join(''), m.name + ' mirrored'); });
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (!E.open(m, x, y)) continue;
      paths++;
      var k = 0;
      E.DIRS.forEach(function (d) { if (E.open(m, x + d[0], y + d[1])) k++; });
      assert.ok(k >= 2, m.name + ' dead end at ' + x + ',' + y);
      if (x < W - 1) assert.ok(!(E.open(m, x + 1, y) && E.open(m, x, y + 1) && E.open(m, x + 1, y + 1)), m.name + ' 2x2 at ' + x + ',' + y);
    }
    while (q.length) {
      var c = q.pop();
      if (seen[c]) continue;
      seen[c] = 1; n++;
      E.DIRS.forEach(function (d) { var nx = wx(c % W + d[0]), ny = ((c / W) | 0) + d[1]; if (E.open(m, nx, ny)) q.push(ny * W + nx); });
    }
    assert.strictEqual(n, paths, m.name + ' all reachable');
    assert.ok(m.tunRows.length >= 1, m.name + ' has a tunnel');
    assert.strictEqual(m.npellets, 4);
    assert.ok(m.ndots > 250);
    assert.strictEqual(E.cellAt(m, 13, 12), 2, 'door');
    assert.strictEqual(E.cellAt(m, 13, 13), 3, 'house');
    assert.ok(E.open(m, E.GX, E.GY) && E.open(m, E.GX - 1, E.GY) && E.open(m, E.GX + 1, E.GY), 'outside the door');
    assert.ok(E.open(m, m.px - 1, m.py) && E.open(m, m.px + 1, m.py), 'start corridor');
    for (var i = 0; i < W * H; i++) if (m.cell[i] === 1) assert.ok(m.home[i] >= 0, 'home field covers paths');
  });
});

test('level tables: speed ramps, mazes rotate, fright shrinks', function () {
  var a = E.speeds(1), b = E.speeds(5), c = E.speeds(12), t = E.speeds(1, true);
  assert.ok(a.pac < b.pac && b.pac < c.pac && a.ghost < b.ghost && b.ghost < c.ghost);
  assert.ok(a.ghost < a.pac && a.ghostFr < a.ghost && a.tunnel < a.ghost && a.eyes > a.pac);
  assert.ok(t.pac > a.pac * 1.2);
  assert.ok(a.pac * E.STEP < 0.2 && t.eyes * E.STEP < 0.5, 'a step never skips a tile');
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8].map(E.mazeFor), [0, 0, 1, 1, 2, 2, 3, 3]);
  for (var L = 9; L < 40; L++) assert.ok(E.mazeFor(L) >= 1 && E.mazeFor(L) <= 3);
  assert.ok(E.frightTime(1) > E.frightTime(6) && E.frightTime(30) > 0);
});

test('muncher: runs a corridor at speed and stops dead-centre at a wall', function () {
  var g = quiet(0), p = g.pac, sp = g.sp.pac;
  p.x = 13; p.y = 23; p.dir = 1; p.want = -1;
  for (var i = 0; i < 12; i++) E.step(g);
  assert.ok(Math.abs((13 - p.x) - sp * 12 * E.STEP) < 1e-6, 'moves at its speed');
  for (i = 0; i < 240; i++) E.step(g);
  assert.ok(p.stop && p.x === 9 && p.y === 23, 'stopped at the wall: ' + p.x);   // row 23: corridor from 9 to 17
  assert.ok(onPath(g.m, p.x, p.y));
});

test('muncher: buffered turn, pre-turn cuts the corner, instant reverse', function () {
  var g = quiet(0), p = g.pac;
  // row 23 heading left from 13; the way up at x = 9 (column 9 is open above row 23)
  p.x = 11; p.y = 23; p.dir = 1; p.want = 0;     // pressed up early: buffered
  var steps = 0;
  while (p.dir !== 0 && steps < 200) { E.step(g); steps++; }
  assert.strictEqual(p.dir, 0, 'turned up');
  assert.ok(p.x > 9 && p.x - 9 <= E.PRE + 1e-9, 'turned before the centre (pre-turn): ' + p.x);
  // after the turn it slides onto the column while climbing (diagonal: a hair gained)
  for (var i = 0; i < 20; i++) E.step(g);
  assert.strictEqual(p.x, 9);
  assert.ok(p.y < 23 - 0.5);
  // reverse is immediate, anywhere
  var y0 = p.y;
  E.setWant(g, 2); E.step(g);
  assert.strictEqual(p.dir, 2);
  assert.ok(p.y > y0);
  // a turn into a wall is held, not taken
  var g2 = quiet(0), q = g2.pac;
  q.x = 13; q.y = 23; q.dir = 1; q.want = 2;     // down is a wall right under row 23 here (col 13 row 24 is #)
  E.step(g2);
  assert.strictEqual(q.dir, 1);
  assert.strictEqual(q.want, 2, 'the wish stays buffered');
});

test('muncher: tunnels wrap both ways', function () {
  var g = quiet(0), p = g.pac, y = g.m.tunRows[0];
  p.x = 2; p.y = y; p.dir = 1; p.want = -1;
  var wrapped = false, last = p.x;
  for (var i = 0; i < 120; i++) { E.step(g); if (p.x > last + 5) wrapped = true; last = p.x; }
  assert.ok(wrapped && p.x > W / 2 && p.y === y);
  p.dir = 3;
  wrapped = false; last = p.x;
  for (i = 0; i < 160; i++) { E.step(g); if (p.x < last - 5) wrapped = true; last = p.x; }
  assert.ok(wrapped && p.x < W / 2);
});

test('dots, pellets, scoring, level clear', function () {
  var g = quiet(0), P = g.ps[0], p = g.pac;
  p.x = 13; p.y = 23; p.dir = 1;
  var s0 = P.score, left = P.left;
  for (var i = 0; i < 30; i++) E.step(g);
  assert.ok(P.score > s0 && P.left < left && P.score - s0 === (left - P.left) * 10);
  assert.ok(g.ate.length === left - P.left);
  // pellet: 50 and every chaser outside turns pale and turns round
  var g2 = quiet(0);
  g2.gh[0].st = 'out'; g2.gh[0].x = 13; g2.gh[0].y = 11; g2.gh[0].dir = 1; g2.gh[0].tx = 12; g2.gh[0].ty = 11;
  var pi = g2.m.dot.indexOf(2), q = g2.pac;
  q.x = pi % W; q.y = (pi / W) | 0; q.dir = -1;
  var sc = g2.ps[0].score;
  E.step(g2);
  assert.strictEqual(g2.ps[0].score - sc, 50);
  assert.ok(g2.frT > 0 && g2.gh[0].fr && g2.gh[1].fr);
  // eat the last dot: level clears, then level 2 on the same maze, faster
  var g3 = quiet(0), P3 = g3.ps[0];
  P3.dots.fill(0); P3.dots[23 * W + 12] = 1; P3.left = 1;
  g3.pac.x = 13; g3.pac.y = 23; g3.pac.dir = 1;
  for (i = 0; i < 20 && g3.phase === 'play'; i++) E.step(g3);
  assert.strictEqual(g3.phase, 'clear');
  for (i = 0; i < 400 && g3.phase !== 'ready'; i++) E.step(g3);
  assert.ok(P3.level === 2 && g3.phase === 'ready' && P3.left === g3.m.ndots && g3.sp.pac > E.speeds(1).pac);
});

test('chasers: personalities aim where they should', function () {
  var g = quiet(0), p = g.pac;
  g.mode = 'chase';
  p.x = 10; p.y = 23; p.face = 3;
  assert.deepStrictEqual(E.ghostTarget(g, 0), [10, 23]);
  assert.deepStrictEqual(E.ghostTarget(g, 1), [14, 23]);
  g.gh[0].x = 6; g.gh[0].y = 20;
  assert.deepStrictEqual(E.ghostTarget(g, 2), [2 * 12 - 6, 2 * 23 - 20]);
  g.gh[3].x = 10; g.gh[3].y = 9;
  assert.deepStrictEqual(E.ghostTarget(g, 3), [10, 23], 'Moss chases from afar');
  g.gh[3].x = 10; g.gh[3].y = 20;
  assert.deepStrictEqual(E.ghostTarget(g, 3), E.CHASERS[3].corner, 'Moss backs off up close');
  g.mode = 'scatter';
  for (var i = 0; i < 4; i++) assert.deepStrictEqual(E.ghostTarget(g, i), E.CHASERS[i].corner);
  g.ps[0].left = 5;
  assert.ok(E.rushOf(g) === 2);
  assert.deepStrictEqual(E.ghostTarget(g, 0), [10, 23], 'Rook rushes even in scatter');
});

test('chasers: stay on the paths, never turn back on their own, leave the house', function () {
  var g = E.newGame({ seed: 3 }), back = 0, last = g.gh.map(function (h) { return h.dir; }), mode = g.mi, fr = 0;
  for (var i = 0; i < 120 * 40; i++) {
    E.step(g);
    if (g.phase !== 'play') { if (g.phase === 'dying' || g.phase === 'over') break; continue; }
    g.gh.forEach(function (h, j) {
      if (h.st === 'out') {
        assert.ok(onPath(g.m, h.x, h.y), 'chaser ' + j + ' in a wall at ' + h.x + ',' + h.y);
        assert.ok(Math.abs(h.x - Math.round(h.x)) < 1e-9 || Math.abs(h.y - Math.round(h.y)) < 1e-9, 'on a centre line');
        if (h.dir === E.OPP[last[j]] && g.mi === mode && g.frT === fr) back++;
      }
      last[j] = h.dir;
    });
    mode = g.mi; fr = g.frT;
    drain(g);
  }
  assert.strictEqual(back, 0, 'no spontaneous reversals');
  assert.ok(g.gh.every(function (h) { return h.st !== 'house'; }), 'everyone left the house');
});

test('eating chasers: 200, 400, 800, 1600, then eyes go home and revive', function () {
  var g = quiet(0), p = g.pac, P = g.ps[0];
  p.x = 6; p.y = 9; p.dir = -1; p.want = -1;
  P.dots.fill(0); P.left = 99;
  E.fright(g);
  var want = E.GHOST_PTS.slice();
  for (var k = 0; k < 4; k++) {
    var h = g.gh[k];
    h.st = 'out'; h.fr = true; h.x = 6; h.y = 9; h.dir = 3; h.tx = 7; h.ty = 9;
    var s0 = P.score;
    g.phase = 'play';
    E.step(g);
    assert.strictEqual(g.phase, 'eat');
    assert.strictEqual(P.score - s0, want[k] + (k === 3 ? E.QUAD_BONUS : 0));
    assert.strictEqual(h.st, 'eyes');
    h.x = 40; h.y = 40; h.st = 'parked';
  }
  // eyes find the door from anywhere and come back out
  var g2 = quiet(1), e = g2.gh[2];
  e.st = 'eyes'; e.x = 1; e.y = 29; e.dir = 3; e.tx = 2; e.ty = 29;
  g2.pac.x = 25; g2.pac.y = 1; g2.pac.dir = -1;
  for (var i = 0; i < 120 * 12 && e.st !== 'out'; i++) { E.step(g2); g2.phase = 'play'; }
  assert.strictEqual(e.st, 'out');
});

test('touching a chaser costs a life; the round restarts', function () {
  var g = quiet(0), P = g.ps[0], h = g.gh[0];
  h.st = 'out'; h.x = 12.5; h.y = 23; h.dir = 3; h.tx = 13; h.ty = 23;
  g.pac.x = 13; g.pac.y = 23; g.pac.dir = 1;
  E.step(g);
  assert.strictEqual(g.phase, 'dying');
  var left = P.left;
  for (var i = 0; i < 400 && g.phase === 'dying'; i++) E.step(g);
  assert.ok(P.lives === E.LIVES - 1 && g.phase === 'ready' && P.left === left, 'dots kept');
  assert.ok(g.pac.x === g.m.px && g.gh[1].st === 'house');
  P.lives = 1;
  g.phase = 'dying'; g.pt = 0.001; E.step(g);
  assert.strictEqual(g.phase, 'over');
});

test('extra life at 10,000; treats bounce in at 70 dots and leave again', function () {
  var g = quiet(0), P = g.ps[0];
  P.score = E.EXTRA_AT - 10;
  g.pac.x = 13; g.pac.y = 23; g.pac.dir = 1;
  for (var i = 0; i < 12; i++) E.step(g);
  assert.ok(P.lives === E.LIVES + 1 && P.extra);
  var g2 = quiet(0);
  g2.ps[0].eaten = E.ITEM_AT[0] - 1;
  g2.pac.x = 13; g2.pac.y = 23; g2.pac.dir = 1;
  for (i = 0; i < 12 && !g2.item; i++) E.step(g2);
  assert.ok(g2.item, 'a treat bounced in');
  g2.pac.x = 13; g2.pac.y = 29; g2.pac.dir = -1; g2.pac.want = -1;
  var gone = false;
  for (i = 0; i < 120 * 32 && !gone; i++) {
    E.step(g2);
    if (g2.item) assert.ok(onPath(g2.m, g2.item.x, g2.item.y) || g2.item.x < 0 || g2.item.x > W - 1, 'treat on the paths');
    gone = !g2.item;
  }
  assert.ok(gone && g2.events.indexOf('itemOut') >= 0, 'it left through a tunnel');
});

test('fixed step: same play at 60 Hz and 120 Hz frames', function () {
  function run(dt) {
    var g = E.newGame({ seed: 11 }), want = [1, 0, 3, 2, 1, 0];
    for (var k = 0, nf = Math.round(12 / dt); k < nf; k++) {
      if (k % Math.round(0.8 / dt) === 0) E.setWant(g, want[(k / Math.round(0.8 / dt)) % want.length | 0]);
      E.advance(g, dt);
    }
    return [g.steps, g.pac.x.toFixed(6), g.pac.y.toFixed(6), g.ps[0].score, g.gh.map(function (h) { return h.x.toFixed(4) + ',' + h.y.toFixed(4); }).join(' ')].join('|');
  }
  assert.strictEqual(run(1 / 60), run(1 / 120));
});

test('autopilot: deterministic, plays well, finds its way through levels', function () {
  var a = autoRun(5, 90), b = autoRun(5, 90);
  assert.strictEqual(a.ps[0].score, b.ps[0].score);
  assert.strictEqual(a.steps, b.steps);
  var total = 0, cleared = 0;
  for (var s = 1; s <= 4; s++) { var g = autoRun(s, 400); total += g.ps[0].score; cleared += g.ev.clear || 0; }
  assert.ok(total / 4 > 5000, 'scores ' + total / 4);
  assert.ok(cleared >= 4, 'cleared ' + cleared);
});

test('two players take turns with their own boards', function () {
  var g = E.newGame({ seed: 9, players: 2 });
  assert.strictEqual(g.phase, 'handoff');
  assert.ok(E.handoffReady(g) && g.cur === 0 && g.phase === 'ready');
  for (var i = 0; i < 400; i++) E.step(g);
  var eaten1 = g.ps[0].eaten;
  g.phase = 'dying'; g.pt = 0.001; E.step(g);
  assert.ok(g.phase === 'handoff' && g.cur === 1, 'pass to player 2');
  E.handoffReady(g);
  assert.ok(g.ps[1].dots && g.ps[1].left === g.m.ndots && g.ps[0].eaten === eaten1);
  g.phase = 'dying'; g.pt = 0.001; E.step(g);
  assert.ok(g.cur === 0 && g.phase === 'handoff');
  E.handoffReady(g);
  assert.strictEqual(g.ps[0].left, g.m.ndots - eaten1, 'player 1 board kept');
  // player 2 out: player 1 plays on alone
  g.ps[1].lives = 0; g.ps[1].out = true;
  g.ps[0].lives = 2;
  g.phase = 'dying'; g.pt = 0.001; E.step(g);
  assert.ok(g.cur === 0 && g.phase === 'ready');
  var r = autoRun(2, 900, { players: 2 });
  assert.strictEqual(r.phase, 'over');
  assert.ok(r.ps[0].score > 0 && r.ps[1].score > 0);
});

test('intermission between mazes, skippable', function () {
  var g = quiet(0);
  g.ps[0].level = 2;
  E.nextLevel(g);
  assert.ok(g.ps[0].level === 3 && g.phase === 'inter' && g.m.idx === 1);
  assert.ok(E.skipInter(g) && g.phase === 'ready');
  var h = quiet(0); h.inter = false; h.ps[0].level = 2; E.nextLevel(h);
  assert.strictEqual(h.phase, 'ready');
});

test('records: settle, ranks, normalisation', function () {
  var s = E.newSave(), g = autoRun(3, 300);
  var card = E.settle(s, g, 1000);
  assert.ok(card.bestScore && card.ranks[0] === 0 && s.hi.length === 1 && s.stats.games === 1 && s.stats.dots > 0);
  assert.strictEqual(E.hiScore(s), g.ps[0].score);
  for (var i = 0; i < 10; i++) E.settle(s, { np: 1, turbo: false, ps: [{ n: 1, score: 100 * i, level: 1, best: 1, items: [] }], stats: g.stats }, i);
  assert.ok(s.hi.length === 8 && s.hi[0].s === g.ps[0].score);
  var n = E.normSave(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(n, s);
  var bad = E.normSave({ hi: [{ s: -4 }, { s: 'x' }, null, { s: 50, l: -2, p: 'zz' }], best: { score: 'NaN' }, stats: { games: -1, dots: 3.7 }, opt: { turbo: 1 } });
  assert.ok(bad.hi.length === 1 && bad.hi[0].l === 1 && bad.hi[0].p === '1P' && bad.best.score === 0 && bad.stats.games === 0 && bad.stats.dots === 3 && bad.opt.turbo === true && bad.opt.inter === true);
  assert.deepStrictEqual(E.normSave(null), E.newSave());
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
});

test('fuzz: random steering on every maze at high speed keeps everyone on the paths', function () {
  var R = E.rng(77);
  [1, 3, 5, 7, 14, 30].forEach(function (L) {
    [false, true].forEach(function (turbo) {
      var g = E.newGame({ seed: 100 + L, level: L, turbo: turbo }), eyesT = [0, 0, 0, 0];
      for (var i = 0; i < 120 * 50; i++) {
        if (i % 17 === 0) E.setWant(g, Math.floor(R() * 4));
        if (g.phase === 'over') { g = E.newGame({ seed: i, level: L, turbo: turbo }); continue; }
        E.step(g);
        drain(g);
        var p = g.pac;
        assert.ok(isFinite(p.x) && isFinite(p.y), 'finite');
        assert.ok(p.x >= -0.5 - 1e-9 && p.x < W - 0.5 + 1e-9, 'muncher x in range ' + p.x);
        assert.ok(onPath(g.m, p.x, p.y), 'muncher in a wall L' + L + ' at ' + p.x + ',' + p.y);
        // never half in a wall: off-centre only along an open axis
        var cx = Math.round(p.x), cy = Math.round(p.y);
        if (Math.abs(p.x - cx) > 1e-6) assert.ok(E.open(g.m, cx + (p.x > cx ? 1 : -1), cy), 'x overlap into wall');
        if (Math.abs(p.y - cy) > 1e-6) assert.ok(E.open(g.m, cx, cy + (p.y > cy ? 1 : -1)), 'y overlap into wall');
        g.gh.forEach(function (h, j) {
          assert.ok(isFinite(h.x) && isFinite(h.y));
          if (h.st === 'out' || h.st === 'eyes') assert.ok(onPath(g.m, h.x, h.y), 'chaser off path');
          eyesT[j] = h.st === 'eyes' ? eyesT[j] + 1 : 0;
          assert.ok(eyesT[j] < 120 * 8, 'eyes took too long to get home');
        });
        if (g.item) assert.ok(onPath(g.m, g.item.x, g.item.y) || g.item.x < 0 || g.item.x > W - 1, 'treat on path');
      }
    });
  });
});

test('a clean sweep of all four needs one pellet; a new pellet restarts the 200 chain', function () {
  var g = quiet(0);
  E.fright(g); g.combo = 2;
  E.fright(g);
  assert.strictEqual(g.combo, 0);
  // chasers in the house turn pale too but cannot be eaten there
  g.gh[1].st = 'house';
  var p = g.pac; p.x = E.HOME_X[1]; p.y = E.HOUSE_Y; p.dir = -1;
  var s0 = g.ps[0].score;
  E.step(g);
  assert.strictEqual(g.ps[0].score, s0);
});

test('fright pauses the scatter/chase clock', function () {
  var g = quiet(0);
  g.ps[0].dots.fill(0); g.ps[0].left = 99;
  for (var i = 0; i < 120; i++) E.step(g);
  var t = g.modeT;
  E.fright(g);
  for (i = 0; i < 120; i++) E.step(g);
  assert.ok(Math.abs(g.modeT - t) < 1e-9, 'mode clock held');
});

test('thumbstick: dead zone, dominant axis, diagonal hysteresis, clamp', function () {
  var r = 40, d = E.stickDir;
  assert.strictEqual(E.STICK_DZ, 0.25);
  assert.strictEqual(d(0, 0, r), -1);
  assert.strictEqual(d(9, 0, r), -1, 'inside 25% of the radius: no wish');
  assert.strictEqual(d(6, -6, r), -1, 'the dead zone is round');
  assert.strictEqual(d(0, -11, r), 0);
  assert.strictEqual(d(-11, 0, r), 1);
  assert.strictEqual(d(0, 11, r), 2);
  assert.strictEqual(d(11, 0, r), 3);
  assert.strictEqual(d(30, -12, r), 3, 'dominant axis wins');
  assert.strictEqual(d(-5, 30, r), 2);
  assert.strictEqual(d(-30, -29, r), 1);
  // near a diagonal the previous wish holds until the other axis clearly leads
  assert.strictEqual(d(20, 21, r, 0.25, 3), 3);
  assert.strictEqual(d(20, 21, r, 0.25, -1), 2);
  assert.strictEqual(d(20, 26, r, 0.25, 3), 2);
  assert.strictEqual(d(-20, 21, r, 0.25, 3), 2, 'a held right does not stick once the stick points left');
  assert.strictEqual(d(20, -21, r, 0.25, 2), 0, 'a held down does not stick once the stick points up');
  assert.strictEqual(d(9, 0, r, 0.1), 3, 'custom dead zone');
  assert.strictEqual(d(NaN, 'x', 0), -1);
  var c = E.stickClamp(30, 40, 25);
  assert.ok(Math.abs(c[0] - 15) < 1e-9 && Math.abs(c[1] - 20) < 1e-9);
  assert.deepStrictEqual(E.stickClamp(3, -4, 25), [3, -4]);
  // a stick wish feeds the same buffered turn wish as a key
  var g = quiet(0), want = d(0, -30, r);
  E.setWant(g, want);
  assert.strictEqual(g.pac.want, 0);
});

test('save: control options normalise', function () {
  var s = E.newSave();
  assert.ok(s.opt.ctl === 'stick' && s.opt.osc === false);
  var n = E.normSave({ opt: { ctl: 'arrows', osc: 1 } });
  assert.ok(n.opt.ctl === 'arrows' && n.opt.osc === true);
  assert.strictEqual(E.normSave({ opt: { ctl: 'wheel' } }).opt.ctl, 'stick');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
