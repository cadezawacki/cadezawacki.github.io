/* Headless checks for the Mancala engine (rules, scoring, AI legality, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/mancala/mancala.test.js */
'use strict';
var assert = require('assert');

var E = require('./mancala.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, asset: function (p) { return './' + p; }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./mancala.js')];
require('./mancala.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function B(south, ss, north, ns) { return south.concat([ss], north, [ns]); }
function randomGame(rules, seeds, seed) {
  var g = E.newGame(rules, seeds), r = E.rng(seed);
  while (!g.result) { var m = E.legal(g); assert.ok(m.length, 'a live game has a move'); assert.ok(E.play(g, m[Math.floor(r() * m.length)])); }
  return g;
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Mancala' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'mancala.css');
  assert.strictEqual(widget._engine.WIN, E.WIN);
});

test('new board: 6 pits a side, empty stores, seeds 3-6', function () {
  var g = E.newGame('kalah', 4);
  assert.deepStrictEqual(g.b, [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0]);
  assert.strictEqual(E.newGame('kalah', 9).n, 6);
  assert.strictEqual(E.newGame('kalah', 1).n, 3);
  assert.strictEqual(E.newGame('nope', 'x').r, 'kalah');
  assert.strictEqual(E.newGame('kalah', 'x').n, 4);
  assert.deepStrictEqual(E.legal(g), [0, 1, 2, 3, 4, 5]);
});

test('kalah: sowing, extra turn in your own store', function () {
  var g = E.newGame('kalah', 4);
  var rec = E.play(g, 2);                       // 4 seeds from C: D E F store
  assert.deepStrictEqual(g.b, [4, 4, 0, 5, 5, 5, 1, 4, 4, 4, 4, 4, 4, 0]);
  assert.ok(rec.extra && g.side === 0, 'ends in the store: go again');
  assert.strictEqual(E.notation(rec), 'C+');
  assert.ok(!E.play(g, 2), 'an empty pit is not a move');
  assert.ok(!E.play(g, 8), 'not their pits');
  rec = E.play(g, 5);                           // 5 seeds from F: store, 7..10
  assert.ok(!rec.extra && g.side === 1);
  assert.deepStrictEqual(g.b, [4, 4, 0, 5, 5, 0, 2, 5, 5, 5, 5, 4, 4, 0]);
});

test('kalah: sowing skips the opponent store', function () {
  var b = B([0, 0, 1, 0, 0, 10], 0, [1, 1, 1, 1, 1, 1], 0);
  var info = E.step(b, 'kalah', 0, 5, null);
  assert.strictEqual(b[13], 0, 'north store untouched');
  assert.strictEqual(b[6], 1);
  // 10 seeds from F: store(1), 7..12 (6), skip 13, 0,1,2 (3)
  assert.deepStrictEqual(b.slice(0, 3), [1, 1, 2]);
  assert.strictEqual(info.cap, 0);
  assert.strictEqual(info.last, 2);
  // and north's sowing skips south's store
  var b2 = B([1, 1, 1, 1, 1, 1], 0, [1, 0, 0, 0, 0, 3], 0);
  E.step(b2, 'kalah', 1, 12, null);
  assert.strictEqual(b2[6], 0); assert.strictEqual(b2[13], 1); assert.strictEqual(b2[0], 2); assert.strictEqual(b2[1], 2);
});

test('kalah: capture from an empty pit of yours takes the opposite pit', function () {
  var b = B([1, 0, 3, 0, 0, 2], 5, [2, 2, 2, 2, 6, 2], 4);
  var ev = [], info = E.step(b, 'kalah', 0, 0, ev);  // 1 seed into empty B (1); opposite is 11 (6)
  assert.strictEqual(info.cap, 7);
  assert.strictEqual(b[1], 0); assert.strictEqual(b[11], 0); assert.strictEqual(b[6], 12);
  assert.ok(ev.some(function (e) { return e.t === 'cap' && e.n === 7; }));
  // no capture when the opposite pit is empty
  var b2 = B([1, 0, 3, 0, 0, 2], 5, [2, 2, 2, 2, 0, 2], 4);
  var i2 = E.step(b2, 'kalah', 0, 0, null);
  assert.strictEqual(i2.cap, 0); assert.strictEqual(b2[1], 1);
  // no capture landing in an empty pit on their side
  var b3 = B([1, 0, 0, 0, 0, 2], 0, [0, 3, 3, 3, 3, 3], 0);
  var i3 = E.step(b3, 'kalah', 0, 5, null);
  assert.strictEqual(i3.cap, 0); assert.strictEqual(b3[7], 1);
});

test('kalah: a full lap of 13 captures back home', function () {
  var b = B([13, 1, 1, 1, 1, 1], 0, [1, 1, 1, 1, 1, 1], 0);
  var info = E.step(b, 'kalah', 0, 0, null);
  assert.strictEqual(info.last, 0);
  assert.strictEqual(info.cap, 1 + 2);   // own pit 1 seed + opposite (1 + 1 sown)
});

test('kalah: when a row runs dry each side sweeps its own seeds', function () {
  var b = B([0, 0, 0, 0, 0, 1], 20, [3, 0, 2, 0, 0, 1], 21);
  var ev = [], info = E.step(b, 'kalah', 0, 5, ev);
  assert.ok(info.over && info.extra);
  assert.strictEqual(b[6], 21); assert.strictEqual(b[13], 27);
  assert.strictEqual(E.sideSum(b, 0) + E.sideSum(b, 1), 0);
  assert.ok(ev.some(function (e) { return e.t === 'sweep' && e.side === 1 && e.n === 6; }));
  assert.strictEqual(E.outcomeOf(b), 1);
});

test('oware: stores are skipped, 12+ seeds skip the origin pit', function () {
  var b = B([0, 0, 0, 0, 0, 12], 0, [2, 2, 2, 2, 2, 2], 0);
  var info = E.step(b, 'oware', 0, 5, null);
  assert.strictEqual(b[6], 0); assert.strictEqual(b[13], 0);
  assert.strictEqual(b[5], 0, 'the origin pit stays empty');
  // 12 seeds: 7..12 (6), 0..4 (5), skip 5, 7 (1)
  assert.strictEqual(b[7], 4); assert.strictEqual(info.last, 7); assert.strictEqual(info.cap, 0);
  // and the store-less sowing captures what it lands on
  var c = B([0, 0, 0, 0, 0, 12], 0, [1, 1, 1, 1, 1, 1], 0), ci = E.step(c, 'oware', 0, 5, null);
  assert.strictEqual(ci.cap, 3); assert.strictEqual(c[6], 3); assert.strictEqual(c[7], 0);
});

test('oware: captures 2s and 3s backwards, not across the row', function () {
  var b = B([0, 0, 0, 0, 0, 4], 0, [1, 2, 1, 2, 9, 9], 0);
  var info = E.step(b, 'oware', 0, 5, null);   // 4: 7(2) 8(3) 9(2) 10(3)
  assert.deepStrictEqual(info.capPits, [10, 9, 8, 7]);
  assert.strictEqual(info.cap, 10); assert.strictEqual(b[6], 10);
  // a break in the run stops the capture
  var b2 = B([0, 0, 0, 0, 0, 4], 0, [1, 4, 1, 2, 9, 9], 0);
  var i2 = E.step(b2, 'oware', 0, 5, null);
  assert.deepStrictEqual(i2.capPits, [10, 9]); assert.strictEqual(i2.cap, 5);
});

test('oware: a grand slam captures nothing', function () {
  var b = B([1, 0, 0, 0, 0, 2], 10, [1, 1, 0, 0, 0, 0], 9);
  var ev = [], info = E.step(b, 'oware', 0, 5, ev);   // 7→2, 8→2: would take all their seeds
  assert.strictEqual(info.cap, 0); assert.ok(info.slam);
  assert.strictEqual(b[7], 2); assert.strictEqual(b[8], 2);
  assert.ok(ev.some(function (e) { return e.t === 'slam'; }));
});

test('oware: you must feed an empty row; if you cannot, the game ends', function () {
  var b = B([1, 0, 0, 0, 3, 1], 10, [0, 0, 0, 0, 0, 0], 20);
  assert.deepStrictEqual(E.legalMoves(b, 0, 'oware'), [4, 5]);
  assert.deepStrictEqual(E.legalMoves(b, 0, 'kalah'), [0, 4, 5]);
  var b2 = B([1, 1, 0, 0, 0, 0], 22, [0, 0, 0, 0, 0, 1], 23);   // north plays its last seed and south cannot feed
  var info = E.step(b2, 'oware', 1, 12, null);
  assert.ok(info.over);
  assert.strictEqual(E.total(b2), b2[6] + b2[13]);
});

test('oware: more than half the seeds ends the game', function () {
  var b = B([0, 0, 0, 0, 0, 1], 23, [1, 4, 4, 4, 4, 4], 3);
  var info = E.step(b, 'oware', 0, 5, null);
  assert.ok(info.cap === 2 && info.over);
  assert.ok(b[6] * 2 > E.total(b));
});

test('seeds are conserved and every random game ends, both rule sets', function () {
  ['kalah', 'oware'].forEach(function (rules) {
    for (var n = 3; n <= 6; n++) {
      for (var s = 1; s <= 25; s++) {
        var g = randomGame(rules, n, s * 31 + n);
        assert.strictEqual(E.total(g.b), 12 * n);
        assert.strictEqual(g.b[6] + g.b[13], 12 * n, rules + ': everything ends up in a store');
        assert.ok(g.result.winner === E.outcomeOf(g.b));
      }
    }
  });
});

test('replay, undo and boardAt agree with play', function () {
  var g = randomGame('kalah', 4, 99), pits = g.moves.map(function (m) { return m.pit; });
  var h = E.replay('kalah', 4, pits);
  assert.deepStrictEqual(h.b, g.b);
  var mid = E.replay('kalah', 4, pits.slice(0, 7));
  assert.deepStrictEqual(E.boardAt(g, 7), mid.b);
  assert.ok(E.undo(g));
  assert.strictEqual(g.result, null);
  assert.strictEqual(g.moves.length, pits.length - 1);
  assert.deepStrictEqual(g.b, E.replay('kalah', 4, pits.slice(0, -1)).b);
  assert.strictEqual(E.replay('kalah', 4, [8]), null, 'an illegal history does not replay');
});

test('animation events rebuild the move exactly', function () {
  ['kalah', 'oware'].forEach(function (rules) {
    var g = E.newGame(rules, 5), r = E.rng(7);
    while (!g.result) {
      var before = g.b.slice(), m = E.legal(g), rec = E.play(g, m[Math.floor(r() * m.length)]), d = before;
      rec.ev.forEach(function (e) {
        if (e.t === 'pick') d[e.pit] = 0;
        else if (e.t === 'drop') d[e.pit]++;
        else if (e.t === 'cap' || e.t === 'sweep') e.pits.forEach(function (p) { d[e.store] += d[p]; d[p] = 0; });
      });
      assert.deepStrictEqual(d, g.b);
    }
  });
});

test('search: plays legal moves and is deterministic for a seed', function () {
  ['kalah', 'oware'].forEach(function (rules) {
    var g = E.newGame(rules, 4), r = E.rng(3);
    for (var i = 0; i < 12 && !g.result; i++) {
      var lv = 1 + (i % 4), o = E.levelSearchOpts(lv, 1234 + i);
      var a = E.search(g, o), b = E.search(g, o);
      assert.ok(E.legal(g).indexOf(a.pit) >= 0, 'legal');
      assert.strictEqual(a.pit, b.pit, 'deterministic');
      var m = E.legal(g); E.play(g, m[Math.floor(r() * m.length)]);
    }
  });
});

test('search: takes the extra turn and the big capture', function () {
  // only F lands in the store (1 seed)
  var g = E.newGame('kalah', 4);
  g.b = B([2, 2, 2, 2, 2, 1], 0, [4, 4, 4, 4, 4, 4], 0);
  assert.strictEqual(E.search(g, { depth: 1 }).pit, 5);
  // A (1 seed) lands in empty B opposite a pit of 9
  g.b = B([1, 0, 5, 5, 5, 3], 0, [1, 1, 1, 1, 9, 1], 0);   // nothing reaches the store exactly
  assert.strictEqual(E.search(g, { depth: 2 }).pit, 0);
});

test('search: a stronger level beats a weaker one', function () {
  var wins = 0, games = 0;
  for (var s = 0; s < 8; s++) {
    var g = E.newGame('kalah', 4), strong = s % 2;   // alternate who moves first
    while (!g.result) {
      var lv = g.side === strong ? 4 : 1, res = E.search(g, E.levelSearchOpts(lv, 50 + s * 13 + g.moves.length));
      assert.ok(E.play(g, res.pit));
    }
    games++;
    if (g.result.winner === strong) wins++;
  }
  assert.ok(wins >= 7, 'Farmer beat Seedling ' + wins + '/' + games);
});

test('search: deep levels respect a time budget', function () {
  var g = E.newGame('kalah', 6), t0 = Date.now();
  var res = E.search(g, { depth: 40, time: 250, seed: 1 });
  assert.ok(Date.now() - t0 < 900, 'took ' + (Date.now() - t0) + ' ms');
  assert.ok(res.depth >= 4 && E.legal(g).indexOf(res.pit) >= 0, 'depth ' + res.depth);
});

test('worker protocol: handle() answers with a legal pit', function () {
  var r = E.handle({ id: 5, r: 'oware', n: 4, pits: [2, 9, 3], level: 3, seed: 9 });
  var g = E.replay('oware', 4, [2, 9, 3]);
  assert.strictEqual(r.id, 5);
  assert.ok(E.legal(g).indexOf(r.pit) >= 0);
  var h = E.handle({ id: 6, r: 'kalah', n: 4, pits: [], hint: true, timeCap: 120, seed: 1 });
  assert.ok(h.pit >= 0 && h.pit <= 5);
  assert.strictEqual(E.handle({ id: 7, r: 'kalah', n: 4, pits: [9] }).pit, -1);
});

test('stats: wins, streaks, margins, captures and pass-and-play', function () {
  var st = E.newStats(), g = E.newGame('kalah', 4);
  g.mode = 'cpu'; g.level = 3; g.human = 0;
  E.play(g, 2); E.play(g, 0);
  g.b = B([0, 0, 0, 0, 0, 0], 30, [0, 0, 0, 0, 0, 0], 18); g.result = { winner: 0, reason: 'end' };
  var info = E.recordResult(st, g);
  assert.ok(info.won && st.lv[3].w === 1 && st.lv[3].best === 12 && st.streak === 1 && st.games === 1);
  assert.strictEqual(st.chain, 1, 'one extra turn');
  E.recordResult(st, g);
  assert.ok(st.streak === 2 && st.bestStreak === 2);
  g.result = { winner: 1, reason: 'end' };
  E.recordResult(st, g);
  assert.ok(st.streak === 0 && st.lv[3].l === 1 && st.bestStreak === 2);
  var p = E.newGame('oware', 4); p.mode = 'pvp'; p.result = { winner: -1, reason: 'stall' };
  E.recordResult(st, p);
  assert.ok(st.pvp.n === 1 && st.pvp.d === 1 && st.rules.oware === 1 && st.rules.kalah === 3);
  assert.deepStrictEqual(E.normStats(JSON.parse(JSON.stringify(st))), st);
  var bad = E.normStats({ games: -4, lv: { 3: { w: 'x', l: 2 } }, streak: 9, bestStreak: 1, pvp: 5 });
  assert.ok(bad.games === 0 && bad.lv[3].w === 0 && bad.lv[3].l === 2 && bad.bestStreak === 9 && bad.pvp.n === 0);
  assert.strictEqual(E.normStats(null).games, 0);
});

test('prefs and saved games normalise defensively', function () {
  var p = E.normPrefs({ mode: 'pvp', level: 99, first: 'zz', r: 'oware', n: 12, speed: 'warp' });
  assert.deepStrictEqual(p, { mode: 'pvp', level: 6, first: 'me', r: 'oware', n: 6, speed: 'normal', autoFlip: false, preview: true });
  assert.strictEqual(E.normPrefs(null).level, 3);
  var g = E.newGame('kalah', 5); g.mode = 'cpu'; g.level = 4; g.human = 1; g.id = 3; g.undos = 1; g.hints = 2;
  E.play(g, 1); E.play(g, 9);
  var back = E.normGame(JSON.parse(JSON.stringify(E.gameSave(g))));
  assert.deepStrictEqual(back.b, g.b);
  assert.ok(back.human === 1 && back.level === 4 && back.hints === 2 && back.n === 5 && back.side === g.side);
  assert.strictEqual(E.normGame({ r: 'kalah', n: 4, pits: [7] }), null);
  assert.strictEqual(E.normGame('junk'), null);
  assert.strictEqual(E.normGame({ pits: 'x' }), null);
  var res = E.gameSave(g); res.result = { winner: 0, reason: 'resign' };
  assert.deepStrictEqual(E.normGame(res).result, { winner: 0, reason: 'resign' });
});

test('oware: endless shuffling ends by the no-capture rule', function () {
  var g = E.newGame('oware', 4);
  g.quiet = E.QUIET_MAX - 1;
  g.b = B([1, 0, 0, 0, 0, 0], 23, [1, 0, 0, 0, 0, 0], 23);
  var rec = E.play(g, 0);
  assert.ok(rec && g.result && g.result.reason === 'stall');
  assert.strictEqual(g.b[6] + g.b[13], 48);
});

test('search at margin 0 never picks a move worse than the best (fail-low bounds are not ties)', function () {
  var bad = 0;
  ['kalah', 'oware'].forEach(function (R) {
    for (var s = 1; s <= 40; s++) {
      var g = E.newGame(R, 4), r = E.rng(s), k = Math.floor(r() * 20);
      for (var i = 0; i < k && !g.result; i++) { var m = E.legal(g); E.play(g, m[Math.floor(r() * m.length)]); }
      if (g.result) continue;
      for (var d = 2; d <= 4; d++) {
        var ex = E.search(g, { depth: d, margin: 1e-9, seed: 1 }), mx = Math.max.apply(null, ex.scores.map(function (x) { return x.s; }));
        for (var sd = 1; sd <= 3; sd++) {
          var p = E.search(g, { depth: d, margin: 0, seed: sd });
          var t = ex.scores.filter(function (x) { return x.pit === p.pit; })[0].s;
          if (t < mx - 1e-6) bad++;
        }
      }
    }
  });
  assert.strictEqual(bad, 0);
});

test('oware: when the mover cannot feed an empty row, the game ends and each side keeps its row', function () {
  var g = E.newGame('oware', 4);
  g.b = B([0, 0, 0, 0, 0, 0], 23, [1, 0, 0, 0, 0, 0], 24); g.side = 1;
  assert.deepStrictEqual(E.legal(g), [], 'North A=1 cannot reach South: no legal move');
  g = E.newGame('oware', 4);
  g.b = B([0, 0, 0, 0, 0, 1], 22, [0, 0, 1, 0, 0, 0], 24);
  var rec = E.play(g, 5);                        // South F -> North A (1, no capture); South row is now empty
  assert.ok(rec && rec.over && g.result, 'North cannot feed South: game over');
  assert.strictEqual(g.b[6] + g.b[13], 48);
  assert.strictEqual(g.b[13], 26, 'North sweeps its own row');
  assert.strictEqual(g.result.winner, 1);
  g = E.newGame('oware', 4);
  g.b = B([0, 0, 0, 0, 0, 1], 22, [1, 0, 0, 0, 0, 0], 24);
  rec = E.play(g, 5);                            // makes 2 in North A — every seed they have: grand slam, no capture
  assert.ok(rec.slam && rec.cap === 0 && g.b[6] === 22);
  assert.ok(g.result, 'and North (A=2) cannot reach South, so it ends');
});

console.log(passed + ' passed' + (process.exitCode ? ', some failed' : ''));
