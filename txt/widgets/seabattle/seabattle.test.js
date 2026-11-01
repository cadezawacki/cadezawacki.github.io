/* Headless checks for the Sea Battle engine (placement, firing, turns, rules,
 * CPU legality / strength / fairness, saves). Not loaded by the app.
 * Run: node txt/widgets/seabattle/seabattle.test.js */
'use strict';
var assert = require('assert');

var E = require('./seabattle.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./seabattle.js')];
require('./seabattle.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function fleetCells(b) { return b.ships.reduce(function (a, s) { return a + s.len; }, 0); }
function occCount(b) { return b.occ.filter(function (o) { return o >= 0; }).length; }
function touches(b) {
  var n = b.n;
  for (var i = 0; i < n * n; i++) {
    if (b.occ[i] < 0) continue;
    var r = Math.floor(i / n), c = i % n;
    for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
      var r2 = r + dr, c2 = c + dc;
      if ((dr || dc) && r2 >= 0 && c2 >= 0 && r2 < n && c2 < n) {
        var o = b.occ[r2 * n + c2];
        if (o >= 0 && o !== b.occ[i]) return true;
      }
    }
  }
  return false;
}
function readyGame(opts, seed) {
  var g = E.newGame(opts, seed), r = E.rng(seed);
  assert.ok(E.randomFleet(g.b[0], r, g.o.apart));
  assert.ok(E.randomFleet(g.b[1], r, g.o.apart));
  assert.ok(E.startPlay(g));
  return g;
}
// shoot a whole board with one AI level; returns shots used
function hunt(level, seed, apart, n) {
  var b = E.newBoard(n || 10), r = E.rng(seed);
  E.randomFleet(b, r, apart);
  var shots = 0, ar = E.rng(seed ^ 0xABCDEF);
  while (E.afloat(b) > 0) {
    var p = E.aiPick(b, level, 1, ar, apart);
    assert.strictEqual(p.length, 1);
    assert.strictEqual(b.shot[p[0]], 0, level + ' fired at a known square');
    E.fireAt(b, p[0]);
    shots++;
    assert.ok(shots <= b.n * b.n);
  }
  return shots;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Sea Battle' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'seabattle.css');
  assert.strictEqual(typeof widget._engine.aiPick, 'function');
});

test('boards and fleets', function () {
  var b = E.newBoard(10);
  assert.strictEqual(b.n, 10);
  assert.strictEqual(b.shot.length, 100);
  assert.deepStrictEqual(b.ships.map(function (s) { return s.len; }), [5, 4, 3, 3, 2]);
  var b8 = E.newBoard(8);
  assert.deepStrictEqual(b8.ships.map(function (s) { return s.len; }), [4, 3, 3, 2]);
  assert.strictEqual(E.newBoard(7).n, 10, 'unknown sizes fall back to 10');
  assert.strictEqual(E.cellName(10, 0), 'A1');
  assert.strictEqual(E.cellName(10, 99), 'J10');
  assert.strictEqual(E.shipArt(5), '<=#=>');
  assert.strictEqual(E.shipArt(2), '<>');
});

test('cellsAt bounds', function () {
  assert.deepStrictEqual(E.cellsAt(10, 3, 0, 7, false), [7, 8, 9]);
  assert.strictEqual(E.cellsAt(10, 3, 0, 8, false), null);
  assert.deepStrictEqual(E.cellsAt(10, 2, 8, 0, true), [80, 90]);
  assert.strictEqual(E.cellsAt(10, 2, 9, 0, true), null);
  assert.strictEqual(E.cellsAt(10, 2, -1, 0, true), null);
});

test('placement: overlap, bounds, rotate, apart', function () {
  var b = E.newBoard(10);
  assert.ok(E.place(b, 0, 0, 0, false, false));          // A1-E1
  assert.ok(!E.place(b, 1, 0, 4, true, false), 'overlap refused');
  assert.ok(E.place(b, 1, 1, 0, false, false), 'touching allowed by default');
  assert.ok(!E.canPlace(b, 2, 2, 0, false, true), 'apart refuses a neighbour');
  assert.ok(!E.canPlace(b, 2, 2, 4, false, true), 'apart refuses a diagonal neighbour');
  assert.ok(E.canPlace(b, 2, 3, 0, false, true));
  assert.ok(E.place(b, 0, 5, 5, true, false), 'moving a ship onto its own old cells');
  assert.strictEqual(occCount(b), 9);
  assert.ok(E.rotate(b, 0, false));
  assert.strictEqual(b.ships[0].v, false);
  assert.strictEqual(occCount(b), 9);
  // rotate near the edge slides the ship back in
  var b2 = E.newBoard(10);
  E.place(b2, 0, 9, 3, false, false);
  assert.ok(E.rotate(b2, 0, false));
  assert.ok(b2.ships[0].v && b2.ships[0].r === 5);
  assert.ok(E.placeNear(b2, 1, 9, 9, false, false));
  assert.strictEqual(b2.ships[1].c, 6);
  E.unplace(b2, 1);
  assert.strictEqual(b2.ships[1].r, -1);
  assert.strictEqual(occCount(b2), 5);
});

test('random fleets are valid (touching and apart, both sizes)', function () {
  for (var seed = 1; seed <= 150; seed++) {
    [10, 8].forEach(function (n) {
      [false, true].forEach(function (apart) {
        var b = E.newBoard(n);
        assert.ok(E.randomFleet(b, E.rng(seed * 31 + n), apart));
        assert.ok(E.allPlaced(b));
        assert.strictEqual(occCount(b), fleetCells(b));
        if (apart) assert.ok(!touches(b), 'apart fleet touches, seed ' + seed);
      });
    });
  }
});

test('fireAt: miss, hit, sunk, repeat', function () {
  var b = E.newBoard(10);
  E.place(b, 4, 0, 0, false, false);   // skiff A1-B1
  assert.strictEqual(E.fireAt(b, 50).res, 'miss');
  assert.strictEqual(E.fireAt(b, 50).res, 'repeat');
  assert.strictEqual(E.fireAt(b, 100).res, 'repeat');
  assert.strictEqual(E.fireAt(b, -1).res, 'repeat');
  assert.strictEqual(E.fireAt(b, 0).res, 'hit');
  var r = E.fireAt(b, 1);
  assert.strictEqual(r.res, 'sunk');
  assert.strictEqual(r.ship, 4);
  assert.deepStrictEqual(r.cells, [0, 1]);
  assert.strictEqual(b.shot[0], 3);
  assert.strictEqual(b.shot[1], 3);
});

test('classic turns alternate; illegal shots refused', function () {
  var g = readyGame({ mode: 'classic' }, 7);
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(E.fireTurn(g, 1, [0]), null, 'not your turn');
  assert.strictEqual(E.fireTurn(g, 0, [0, 1]), null, 'one shot only');
  assert.strictEqual(E.fireTurn(g, 0, [1.5]), null);
  assert.strictEqual(E.fireTurn(g, 0, ['3']), null);
  var miss = g.b[1].occ.indexOf(-1), r = E.fireTurn(g, 0, [miss]);
  assert.ok(r && r.results[0].res === 'miss' && !r.again);
  assert.strictEqual(g.turn, 1);
  assert.strictEqual(E.fireTurn(g, 1, [g.b[0].occ.indexOf(0)]).results[0].res, 'hit');
  assert.strictEqual(g.turn, 0, 'classic: a hit does not earn another shot');
  assert.strictEqual(E.fireTurn(g, 0, [miss]), null, 'repeat refused');
  assert.strictEqual(g.st[0].shots, 1);
  assert.strictEqual(g.st[1].hits, 1);
  assert.strictEqual(g.hist.length, 2);
});

test('hit again: a hit keeps the turn', function () {
  var g = readyGame({ mode: 'bonus' }, 9);
  var hit = g.b[1].occ.indexOf(2), r = E.fireTurn(g, 0, [hit]);
  assert.ok(r.again);
  assert.strictEqual(g.turn, 0);
  var miss = g.b[1].occ.indexOf(-1);
  r = E.fireTurn(g, 0, [miss]);
  assert.ok(!r.again);
  assert.strictEqual(g.turn, 1);
});

test('salvo: one shot per ship afloat', function () {
  var g = readyGame({ mode: 'salvo' }, 11);
  assert.strictEqual(E.shotsAllowed(g, 0), 5);
  assert.strictEqual(E.fireTurn(g, 0, [0, 1, 2]), null, 'must fire the full salvo');
  assert.strictEqual(E.fireTurn(g, 0, [0, 0, 1, 2, 3]), null, 'no duplicates');
  assert.ok(E.fireTurn(g, 0, [0, 1, 2, 3, 4]));
  // sink player 0's skiff: player 0 then has 4 shots
  var cells = E.shipCells(g.b[0], 4), others = [];
  for (var i = 0; i < 100 && others.length < 3; i++) if (g.b[0].occ[i] === -1 && !g.b[0].shot[i]) others.push(i);
  var r = E.fireTurn(g, 1, cells.concat(others));
  assert.ok(r && r.results.some(function (x) { return x.res === 'sunk'; }));
  assert.strictEqual(E.shotsAllowed(g, 0), 4);
  assert.strictEqual(E.shotsAllowed(g, 1), 5);
});

test('a game ends when a fleet is sunk; winner and phase set', function () {
  var g = readyGame({}, 13), ship = [];
  for (var i = 0; i < 100; i++) if (g.b[1].occ[i] >= 0) ship.push(i);
  var miss0 = [];
  for (i = 0; i < 100; i++) if (g.b[0].occ[i] < 0) miss0.push(i);
  var r;
  for (var k = 0; k < ship.length; k++) {
    r = E.fireTurn(g, 0, [ship[k]]);
    assert.ok(r);
    if (r.over) break;
    assert.ok(E.fireTurn(g, 1, [miss0[k]]));
  }
  assert.ok(r.over);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, 0);
  assert.strictEqual(g.st[0].hits, 17);
  assert.strictEqual(g.st[0].bestStreak, 17);
  assert.strictEqual(E.fireTurn(g, 1, [miss0[50]]), null, 'no shots after the end');
});

test('CPU legality: every level, every rule set, full games', function () {
  ['easy', 'medium', 'hard'].forEach(function (lv) {
    ['classic', 'salvo', 'bonus'].forEach(function (mode) {
      [false, true].forEach(function (apart) {
        for (var seed = 1; seed <= 4; seed++) {
          var g = readyGame({ level: lv, mode: mode, apart: apart, n: seed % 2 ? 10 : 8 }, seed * 101), r = E.rng(seed), turns = 0;
          while (g.phase === 'play') {
            var res = E.cpuTurn(g, r);
            assert.ok(res, lv + ' ' + mode + ' made an illegal turn');
            assert.ok(++turns < 400);
          }
          assert.ok(g.winner === 0 || g.winner === 1);
        }
      });
    });
  });
});

test('CPU salvo picks distinct unknown squares', function () {
  var b = E.newBoard(10);
  E.randomFleet(b, E.rng(5), false);
  ['easy', 'medium', 'hard'].forEach(function (lv) {
    var p = E.aiPick(b, lv, 5, E.rng(3), false);
    assert.strictEqual(p.length, 5);
    assert.strictEqual(new Set(p).size, 5);
  });
  assert.strictEqual(E.aiPick(b, 'hard', 500, E.rng(3), false).length, 100, 'capped by open squares');
});

test('CPU strength: hard < medium < easy (average shots)', function () {
  var avg = {};
  ['easy', 'medium', 'hard'].forEach(function (lv) {
    var t = 0, N = 40;
    for (var s = 1; s <= N; s++) t += hunt(lv, s * 977, false);
    avg[lv] = t / N;
  });
  assert.ok(avg.hard < avg.medium && avg.medium < avg.easy, JSON.stringify(avg));
  assert.ok(avg.hard < 62, 'hard is sharp: ' + avg.hard);
  assert.ok(avg.easy > 66, 'easy is gentle: ' + avg.easy);
  console.log('  avg shots to sink a fleet: ' + JSON.stringify(avg));
});

test('CPU uses the apart rule to clear squares around wrecks', function () {
  var t1 = 0;
  for (var s = 1; s <= 25; s++) { t1 += hunt('hard', s * 13, true); }
  var b = E.newBoard(10);
  E.place(b, 4, 0, 0, false, true);
  E.fireAt(b, 0); E.fireAt(b, 1);
  var blk = E.blockedCells(E.view(b), true);
  assert.ok(blk[2] && blk[10] && blk[11] && blk[12], 'neighbours of a wreck are known empty');
  assert.ok(!blk[3]);
  for (var k = 0; k < 200; k++) {
    var p = E.aiPick(b, 'medium', 1, E.rng(k), true)[0];
    assert.ok(!blk[p], 'medium never fires next to a wreck when ships keep apart');
  }
  assert.ok(t1 / 25 < 62);
});

test('CPU never cheats: picks depend only on the public record', function () {
  for (var seed = 1; seed <= 30; seed++) {
    var b = E.newBoard(10), r = E.rng(seed);
    E.randomFleet(b, r, false);
    for (var q = 0; q < 25; q++) E.fireAt(b, Math.floor(r() * 100));
    // a twin with the same record but the unhit ship squares moved off the map
    var twin = JSON.parse(JSON.stringify(b));
    for (var i = 0; i < 100; i++) if (!twin.shot[i]) twin.occ[i] = -1;
    twin.ships.forEach(function (s) { s.r = s.r >= 0 ? 0 : s.r; s.c = 0; });
    ['easy', 'medium', 'hard'].forEach(function (lv) {
      var a = E.aiPick(b, lv, 3, E.rng(seed * 7), false), c = E.aiPick(twin, lv, 3, E.rng(seed * 7), false);
      assert.deepStrictEqual(a, c, lv + ' peeked at hidden ships');
    });
  }
});

test('hard targets a hit: next shot is next to it', function () {
  var b = E.newBoard(10);
  E.place(b, 0, 4, 2, false, false);   // flagship C5-G5
  E.fireAt(b, 44);                      // hit E5
  var p = E.aiPick(b, 'hard', 1, E.rng(1), false)[0];
  assert.ok([34, 54, 43, 45].indexOf(p) >= 0, 'picked ' + p);
  var h = E.heatmap(b, false);
  assert.ok(h[43] > 0 && h[0] === 0);
});

test('determinism: same seeds, same game', function () {
  function play(seed) {
    var g = readyGame({ level: 'hard', mode: 'salvo' }, seed), r = E.rng(seed);
    while (g.phase === 'play') E.cpuTurn(g, r);
    return JSON.stringify(g.hist);
  }
  assert.strictEqual(play(42), play(42));
  assert.notStrictEqual(play(42), play(43));
});

test('saves: replay restores the game exactly; bad saves are refused', function () {
  var g = readyGame({ mode: 'bonus', level: 'easy', apart: true }, 77), r = E.rng(1);
  for (var t = 0; t < 30 && g.phase === 'play'; t++) E.cpuTurn(g, r);
  var raw = JSON.parse(JSON.stringify(E.saveGame(g))), g2 = E.restoreGame(raw);
  assert.ok(g2);
  assert.deepStrictEqual(g2.b, g.b);
  assert.deepStrictEqual(g2.st, g.st);
  assert.strictEqual(g2.turn, g.turn);
  assert.strictEqual(g2.phase, g.phase);
  assert.strictEqual(E.restoreGame(null), null);
  assert.strictEqual(E.restoreGame({}), null);
  assert.strictEqual(E.restoreGame('x'), null);
  var bad = JSON.parse(JSON.stringify(raw)); bad.fleets[0][0] = [9, 9, 0];
  assert.strictEqual(E.restoreGame(bad), null, 'a ship off the grid');
  bad = JSON.parse(JSON.stringify(raw)); bad.hist.push([1 - g.turn, [0]]);
  assert.strictEqual(E.restoreGame(bad), null, 'out-of-turn shot');
  bad = JSON.parse(JSON.stringify(raw)); bad.hist[0][1] = [999];
  assert.strictEqual(E.restoreGame(bad), null);
  bad = JSON.parse(JSON.stringify(raw)); bad.fleets[1].pop();
  assert.strictEqual(E.restoreGame(bad), null);
});

test('records: normalise and count', function () {
  var s = E.normSave({ opts: { n: 8, mode: 'nope', vs: '2p', level: 'hard', apart: 'yes' }, cpu: { hard: { w: '3', l: -2, shots: 10, hits: 99, best: NaN } }, pvp: { games: 2, w: [1, 'x'] }, streak: 4, bestStreak: 1 });
  assert.deepStrictEqual(s.opts, { n: 8, mode: 'classic', vs: '2p', level: 'hard', apart: false });
  assert.deepStrictEqual(s.cpu.hard, { w: 3, l: 0, shots: 10, hits: 10, best: 0 });
  assert.deepStrictEqual(s.cpu.easy, { w: 0, l: 0, shots: 0, hits: 0, best: 0 });
  assert.deepStrictEqual(s.pvp, { games: 2, w: [1, 0] });
  assert.strictEqual(s.bestStreak, 4);
  assert.deepStrictEqual(E.normSave('junk'), E.newSave());
  var sv = E.newSave(), g = readyGame({ level: 'hard' }, 3);
  g.phase = 'over'; g.winner = 0; g.st[0].shots = 40; g.st[0].hits = 17;
  E.recordGame(sv, g);
  assert.strictEqual(sv.cpu.hard.w, 1);
  assert.strictEqual(sv.cpu.hard.best, 40);
  g.st[0].shots = 35;
  assert.ok(E.recordGame(sv, g).best, 'a better win is a new record');
  assert.strictEqual(sv.cpu.hard.best, 35);
  assert.strictEqual(sv.streak, 2);
  g.winner = 1; E.recordGame(sv, g);
  assert.strictEqual(sv.streak, 0);
  assert.strictEqual(sv.bestStreak, 2);
  var g2 = readyGame({ vs: '2p' }, 4); g2.phase = 'over'; g2.winner = 1;
  E.recordGame(sv, g2);
  assert.deepStrictEqual(sv.pvp, { games: 1, w: [0, 1] });
});

test('no shots after the game ends or out of turn; salvo capped by open squares', function () {
  var g = readyGame({ mode: 'salvo' }, 21);
  assert.strictEqual(E.fireTurn(g, 1, [0, 1, 2, 3, 4]), null, 'player 2 cannot fire first');
  assert.strictEqual(E.fireTurn(g, 0, [0, 1, 2, 3, 4.5]), null, 'whole squares only');
  assert.strictEqual(E.fireTurn(g, 0, [0, 1, 2, 3, -1]), null);
  // leave only two unknown squares on player 2's board (not finishing the fleet)
  var tb = g.b[1], keep = [];
  for (var i = 99; i >= 0 && keep.length < 2; i--) if (tb.occ[i] >= 0) keep.push(i);
  for (i = 0; i < 100; i++) if (keep.indexOf(i) < 0) E.fireAt(tb, i);
  assert.strictEqual(E.shotsAllowed(g, 0), 2);
  var r = E.fireTurn(g, 0, keep);
  assert.ok(r && r.over && g.winner === 0);
  assert.strictEqual(E.fireTurn(g, 1, [0]), null, 'game over');
  assert.strictEqual(E.cpuTurn(g, E.rng(1)), null);
});

test('placeNear clamps to the grid; rotate slides off an edge', function () {
  var b = E.newBoard(10);
  assert.ok(E.placeNear(b, 0, 3, 9, false, false));
  assert.deepStrictEqual([b.ships[0].r, b.ships[0].c], [3, 5]);
  assert.ok(E.placeNear(b, 1, 9, 0, true, false));
  assert.deepStrictEqual([b.ships[1].r, b.ships[1].c, b.ships[1].v], [6, 0, true]);
  var b2 = E.newBoard(8);
  assert.ok(E.place(b2, 0, 7, 4, false, false));   // cruiser along the bottom row
  assert.ok(E.rotate(b2, 0, false));
  assert.ok(b2.ships[0].v && b2.ships[0].r + 4 <= 8, 'slid up to fit');
  assert.strictEqual(b2.occ.filter(function (o) { return o === 0; }).length, 4);
});

test('saves: salvo and 8x8 games survive a JSON round trip mid-game', function () {
  [{ mode: 'salvo', n: 8, level: 'hard' }, { mode: 'classic', vs: '2p', apart: true }].forEach(function (o, k) {
    var g = readyGame(o, 300 + k), r = E.rng(5 + k);
    for (var t = 0; t < 9 && g.phase === 'play'; t++) E.cpuTurn(g, r);
    var g2 = E.restoreGame(JSON.parse(JSON.stringify(E.saveGame(g))));
    assert.ok(g2);
    assert.deepStrictEqual(g2.o, g.o);
    assert.deepStrictEqual(g2.b, g.b);
    assert.strictEqual(E.shotsAllowed(g2, g2.turn), E.shotsAllowed(g, g.turn));
    // the restored game plays on to the end legally
    while (g2.phase === 'play') assert.ok(E.cpuTurn(g2, r));
    assert.ok(g2.winner === 0 || g2.winner === 1);
  });
});

console.log(passed + ' passed');
