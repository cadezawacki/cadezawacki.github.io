/* Headless checks for the Farkle engine (scoring, odds, turn flow, CPU, saves).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/farkle/farkle.test.js */
'use strict';
var assert = require('assert');

var E = require('./farkle.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; } } };
delete require.cache[require.resolve('./farkle.js')];
require('./farkle.js');
delete global.window;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var R = E.normRules(null);
function sc(v, r) { return E.scoreVals(v, r || R); }
function near(a, b, eps) { assert.ok(Math.abs(a - b) < (eps || 1e-9), a + ' !~ ' + b); }
// an rng state whose next die is a 2, 3, 4 or 6 (a one-die farkle)
function farkleSeed() {
  for (var x = 1; ; x++) { var v = 1 + Math.floor(E.rngStep(x).v * 6); if (v !== 1 && v !== 5) return x; }
}
function force(g, vals) {
  // replace the dice of the current roll (for scripted scenarios)
  g.t.dice = vals.slice(); g.t.sel = vals.map(function () { return false; });
}

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Farkle' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'farkle.css');
  assert.strictEqual(widget._engine.MAX_PLAYERS, 6);
});

test('singles, kinds and invalid selections', function () {
  assert.strictEqual(sc([1]), 100);
  assert.strictEqual(sc([5]), 50);
  assert.strictEqual(sc([1, 5]), 150);
  assert.strictEqual(sc([2]), 0);
  assert.strictEqual(sc([1, 2]), 0, 'a non-scoring die spoils the selection');
  assert.strictEqual(sc([2, 2, 2]), 200);
  assert.strictEqual(sc([6, 6, 6]), 600);
  assert.strictEqual(sc([1, 1, 1]), 1000);
  assert.strictEqual(sc([5, 5, 5]), 500);
  assert.strictEqual(sc([1, 1]), 200);
  assert.strictEqual(sc([2, 2, 2, 5]), 250);
  assert.strictEqual(sc([3, 3]), 0);
  assert.strictEqual(sc([]), 0);
});

test('four, five, six of a kind (doubling, adding, fixed)', function () {
  assert.strictEqual(sc([2, 2, 2, 2]), 400);
  assert.strictEqual(sc([2, 2, 2, 2, 2]), 800);
  assert.strictEqual(sc([2, 2, 2, 2, 2, 2]), 1600);
  assert.strictEqual(sc([1, 1, 1, 1]), 2000);
  assert.strictEqual(sc([1, 1, 1, 1, 1, 1]), 8000);
  var add = E.normRules({ multi: 'add' });
  assert.strictEqual(sc([4, 4, 4, 4], add), 800);
  assert.strictEqual(sc([4, 4, 4, 4, 4, 4], add), 1600);
  var fx = E.normRules({ multi: 'fixed' });
  assert.strictEqual(sc([3, 3, 3, 3], fx), 1000);
  assert.strictEqual(sc([3, 3, 3, 3, 3], fx), 2000);
  assert.strictEqual(sc([3, 3, 3, 3, 3, 3], fx), 3000);
  // fixed: four 5s is 1000, better than three 5s + a 5 (550)
  assert.strictEqual(sc([5, 5, 5, 5], fx), 1000);
  // 300-point three 1s
  assert.strictEqual(sc([1, 1, 1], E.normRules({ triple1: 300 })), 300);
});

test('straight, three pairs, optional combos', function () {
  assert.strictEqual(sc([1, 2, 3, 4, 5, 6]), 1500);
  assert.strictEqual(sc([6, 5, 4, 3, 2, 1]), 1500);
  assert.strictEqual(sc([2, 2, 3, 3, 4, 4]), 1500);
  assert.strictEqual(sc([1, 1, 5, 5, 6, 6]), 1500);
  assert.strictEqual(sc([1, 2, 3, 4, 5, 6], E.normRules({ straight: 0 })), 0, 'no straight: the 2/3/4/6 do not score');
  assert.strictEqual(sc([2, 2, 3, 3, 4, 4], E.normRules({ threePairs: 0 })), 0);
  assert.strictEqual(sc([2, 2, 3, 3, 4, 4], E.normRules({ threePairs: 750 })), 750);
  // four + a pair: off by default -> four 2s with a pair of 3s cannot all score
  assert.strictEqual(sc([2, 2, 2, 2, 3, 3]), 0);
  assert.strictEqual(sc([2, 2, 2, 2, 3, 3], E.normRules({ fourPair: 1500 })), 1500);
  assert.strictEqual(sc([2, 2, 2, 3, 3, 3]), 500);
  assert.strictEqual(sc([2, 2, 2, 3, 3, 3], E.normRules({ twoTriples: 2500 })), 2500);
  // the best decomposition wins: four 1s + two 5s = 2100 > three pairs? (1,1 / 1,1 / 5,5 counts 4+2: not pairs)
  assert.strictEqual(sc([1, 1, 1, 1, 5, 5]), 2100);
  // three pairs of 1/5/x vs singles: 1,1,5,5,2,2 -> 1500
  assert.strictEqual(sc([1, 1, 5, 5, 2, 2]), 1500);
  // 1,1,1,1,1,1 doubling is 8000, more than three pairs
  assert.strictEqual(sc([1, 1, 1, 1, 1, 1]), 8000);
});

test('labels describe the take', function () {
  var d = E.decompose(E.counts([2, 2, 2, 1, 5]), R);
  assert.strictEqual(E.label(d.p), 'three 2s + 1 + 5');
  assert.strictEqual(E.label(E.decompose(E.counts([1, 2, 3, 4, 5, 6]), R).p), 'straight');
  assert.strictEqual(E.label(E.decompose(E.counts([1, 1]), R).p), '1 ×2');
  assert.strictEqual(E.bigCombo(E.decompose(E.counts([4, 4, 4, 4]), R).p), 'four 4s');
  assert.strictEqual(E.bigCombo(E.decompose(E.counts([4, 4, 4]), R).p), '');
});

test('anyScore agrees with options() for every roll of 1-6 dice', function () {
  var rules = [R, E.normRules({ straight: 0, threePairs: 0 }), E.normRules({ fourPair: 1500, twoTriples: 2500, multi: 'fixed' })];
  rules.forEach(function (rr) {
    for (var n = 1; n <= 6; n++) {
      var total = Math.pow(6, n);
      for (var x = 0; x < total; x++) {
        var v = [], y = x;
        for (var k = 0; k < n; k++) { v.push(1 + (y % 6)); y = Math.floor(y / 6); }
        var c = E.counts(v);
        assert.strictEqual(E.anyScore(c, rr), E.options(c, rr).length > 0, v.join(''));
      }
    }
  });
});

test('farkle odds per dice count are exact', function () {
  var tb = E.tables(R);
  near(tb.pF[1], 4 / 6);
  near(tb.pF[2], 16 / 36);
  near(tb.pF[3], 60 / 216);
  near(tb.pF[4], 204 / 1296);
  near(tb.pF[5], 600 / 7776);
  near(tb.pF[6], 1080 / 46656);     // with straight + three pairs scoring
  for (var n = 1; n <= 6; n++) assert.ok(tb.g[n] > 0 && tb.g[n] < 5000);
  assert.ok(tb.g[6] > tb.g[3] && tb.g[3] > tb.g[1]);
  near(tb.g[1], 75);                 // a 1 or a 5, equally likely
  // without the 6-dice specials a six-dice farkle is more likely
  assert.ok(E.tables(E.normRules({ straight: 0, threePairs: 0 })).pF[6] > tb.pF[6]);
});

test('turn flow: roll, set aside, roll on, bank', function () {
  var g = E.newGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 7 });
  assert.ok(E.canRoll(g) && !E.canBank(g));
  var ev = E.roll(g);
  assert.strictEqual(g.t.dice.length, 6);
  force(g, [1, 5, 2, 3, 4, 4]);
  assert.ok(!E.canRoll(g), 'must set aside a scoring die first');
  E.toggle(g, 2);
  assert.ok(!E.canRoll(g) && !E.canBank(g), 'a lone 2 does not score');
  E.toggle(g, 2); E.toggle(g, 0);
  assert.deepStrictEqual(E.selInfo(g), { n: 1, s: 100, ok: true, p: E.selInfo(g).p });
  E.roll(g);
  assert.strictEqual(g.t.pts, 100);
  assert.strictEqual(g.t.avail, 5);
  if (g.t.res === 'farkle') { assert.strictEqual(g.players[0].score, 0); return; }
  force(g, [5, 2, 3, 4, 6]);
  E.setSel(g, [0]);
  ev = E.bank(g);
  assert.ok(ev.some(function (x) { return x.e === 'bank' && x.n === 150; }));
  assert.strictEqual(g.players[0].score, 150);
  assert.strictEqual(g.t.res, 'bank');
  assert.ok(!E.canRoll(g) && !E.canBank(g));
  E.next(g);
  assert.strictEqual(g.cur, 1);
  assert.strictEqual(g.t.pts, 0);
});

test('hot dice: all six score -> roll six again', function () {
  var g = E.newGame({ seed: 3 });
  E.roll(g);
  force(g, [1, 2, 3, 4, 5, 6]);
  E.setSel(g, [0, 1, 2, 3, 4, 5]);
  var ev = E.roll(g);
  assert.ok(ev.some(function (x) { return x.e === 'hot'; }));
  assert.strictEqual(g.t.pts, 1500);
  assert.strictEqual(g.t.avail, 6);
  assert.strictEqual(g.t.dice.length, 6);
  assert.strictEqual(g.t.hot, 1);
});

test('farkle loses the turn; three in a row costs the penalty', function () {
  var g = E.newGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 1 });
  g.players[0].score = 3000; g.players[0].on = true;
  for (var k = 0; k < 3; k++) {
    g.cur = 0; g.t = { pts: 400, dice: [], sel: [], avail: 1, rolled: false, kept: [], hot: 0, rolls: 0, res: '', gain: 0 };
    g.rs = farkleSeed();
    var ev = E.roll(g);
    assert.strictEqual(g.t.res, 'farkle');
    assert.ok(ev.some(function (x) { return x.e === 'farkle' && x.lost === 400; }));
    if (k < 2) assert.strictEqual(g.players[0].score, 3000);
  }
  assert.strictEqual(g.players[0].score, 2000, 'three farkles in a row: -1000');
  assert.strictEqual(g.players[0].fk, 0);
  var g2 = E.newGame({ rules: { penalty: 0 }, seed: 1 });
  assert.strictEqual(g2.rules.penalty, 0);
});

test('entry minimum blocks the first small bank', function () {
  var g = E.newGame({ rules: { entry: 500 }, seed: 9 });
  E.roll(g);
  force(g, [1, 2, 3, 4, 6, 6]);
  E.setSel(g, [0]);
  assert.ok(!E.canBank(g), '100 < 500');
  assert.ok(E.canRoll(g));
  force(g, [1, 1, 1, 4, 6, 6]);
  E.setSel(g, [0, 1, 2]);
  assert.ok(E.canBank(g), '1000 >= 500');
  E.bank(g);
  assert.ok(g.players[0].on);
});

test('final round: everyone else gets one more turn, then the leader wins', function () {
  var g = E.newGame({ players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 5, rules: { target: 2500 } });
  g.cur = 1; g.players[1].score = 2400; g.players[1].on = true;
  E.roll(g);
  force(g, [1, 2, 3, 4, 6, 6]);
  E.setSel(g, [0]);
  var ev = E.bank(g);
  assert.ok(ev.some(function (x) { return x.e === 'final' && x.who === 1; }));
  assert.strictEqual(g.final, 1);
  E.next(g); assert.strictEqual(g.cur, 2); assert.strictEqual(g.phase, 'turn');
  g.t.res = 'farkle';
  E.next(g); assert.strictEqual(g.cur, 0); assert.strictEqual(g.phase, 'turn');
  g.t.res = 'farkle';
  ev = E.next(g);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, 1);
  assert.ok(ev.some(function (x) { return x.e === 'win'; }));
});

test('pig: a 1 wipes the turn, holding banks, reaching the target wins at once', function () {
  var g = E.newGame({ mode: 'pig', players: [{ name: 'A' }, { name: 'B' }], seed: 11, rules: { pigTarget: 50 } });
  assert.strictEqual(g.t.avail, 1);
  var rolls = 0;
  while (!g.t.res && rolls++ < 200) {
    E.roll(g);
    if (!g.t.res && g.t.pts >= 12) E.bank(g);
  }
  assert.ok(g.t.res === 'farkle' || g.t.res === 'bank');
  if (g.t.res === 'farkle') { assert.strictEqual(g.t.dice[0], 1); assert.strictEqual(g.players[0].score, 0); }
  else assert.ok(g.players[0].score >= 12);
  // force a win
  E.next(g); E.next(g);
  g.t = { pts: 0, dice: [], sel: [], avail: 1, rolled: false, kept: [], hot: 0, rolls: 0, res: '', gain: 0 };
  g.players[g.cur].score = 48;
  while (!g.t.res) { E.roll(g); if (!g.t.res) E.bank(g); }
  if (g.t.res === 'bank') { assert.strictEqual(g.phase, 'over'); assert.strictEqual(g.winner, g.cur); }
});

test('rolling is deterministic for a seed', function () {
  function play(seed) {
    var g = E.newGame({ seed: seed, players: [{ name: 'a', cpu: 'balanced' }, { name: 'b', cpu: 'reckless' }] });
    E.simulate(g);
    return g.players.map(function (p) { return p.score; }).join(',') + '/' + g.round;
  }
  assert.strictEqual(play(42), play(42));
  assert.notStrictEqual(play(42), play(43));
});

test('CPU plans are always legal and games finish', function () {
  ['farkle', 'pig'].forEach(function (mode) {
    for (var s = 1; s <= 40; s++) {
      var g = E.newGame({ mode: mode, seed: s * 7919, rules: { entry: s % 2 ? 500 : 0, target: 5000 },
        players: [{ name: 'c', cpu: 'cautious' }, { name: 'b', cpu: 'balanced' }, { name: 'r', cpu: 'reckless' }] });
      for (var step = 0; step < 100000 && g.phase !== 'over'; step++) {
        if (g.t.res) { E.next(g); continue; }
        var pl = E.cpuPlan(g);
        assert.ok(pl, 'a plan while live');
        if (mode === 'farkle' && g.t.rolled) {
          assert.ok(pl.keep.length > 0, 'keeps at least one die');
          E.setSel(g, pl.keep);
          var si = E.selInfo(g);
          assert.ok(si.ok && si.s === pl.s, 'keeps only scoring dice');
          if (pl.act === 'bank') assert.ok(E.canBank(g), 'only banks when allowed');
        }
        var ev = pl.act === 'bank' ? E.bank(g) : E.roll(g);
        assert.ok(ev.length > 0, 'the action did something');
      }
      assert.strictEqual(g.phase, 'over', mode + ' seed ' + s + ' finished');
      var T = E.target(g);
      assert.ok(g.players[g.winner].score >= (mode === 'pig' ? T : 0));
      if (mode === 'farkle') assert.ok(g.players.some(function (p) { return p.score >= T; }));
    }
  });
});

test('CPU risk profiles behave differently', function () {
  // from 350 points with 2 dice left: cautious banks, reckless rolls on
  function plan(risk, pts, dice) {
    var g = E.newGame({ seed: 1, players: [{ name: 'x', cpu: risk }, { name: 'y', cpu: 'balanced' }] });
    g.players[0].on = true; g.players[0].score = 2000;
    g.t = { pts: pts, dice: dice, sel: dice.map(function () { return false; }), avail: dice.length, rolled: true, kept: [], hot: 0, rolls: 2, res: '', gain: 0 };
    return E.cpuPlan(g);
  }
  assert.strictEqual(plan('cautious', 300, [5, 2, 3]).act, 'bank');
  assert.strictEqual(plan('reckless', 300, [5, 2, 3]).act, 'roll');
  // hot dice: everyone rolls on
  RISKS().forEach(function (r) { assert.strictEqual(plan(r, 300, [1, 2, 3, 4, 5, 6]).act, 'roll'); });
  // big turn, one die left: everyone banks
  RISKS().forEach(function (r) { assert.strictEqual(plan(r, 2500, [5, 2]).act, 'bank'); });
  // keeps one 1 rather than 1+5 when rolling on with plenty of dice (more dice back)
  var p = plan('balanced', 0, [1, 5, 2, 3, 4, 6]);
  assert.strictEqual(p.act, 'roll');
  // pig: holds at its threshold
  var g = E.newGame({ mode: 'pig', seed: 2, players: [{ name: 'x', cpu: 'balanced' }, { name: 'y', cpu: 'balanced' }] });
  g.t.rolled = true; g.t.dice = [4]; g.t.pts = 22;
  assert.strictEqual(E.cpuPlan(g).act, 'bank');
  g.t.pts = 8;
  assert.strictEqual(E.cpuPlan(g).act, 'roll');
  // in the final round a CPU behind the leader never banks short
  var f = E.newGame({ seed: 3, players: [{ name: 'x', cpu: 'cautious' }, { name: 'y', cpu: 'balanced' }] });
  f.players[1].score = 10400; f.final = 1; f.players[0].score = 9000; f.players[0].on = true;
  f.t = { pts: 1000, dice: [5, 2, 3], sel: [false, false, false], avail: 3, rolled: true, kept: [], hot: 0, rolls: 2, res: '', gain: 0 };
  assert.strictEqual(E.cpuPlan(f).act, 'roll');
  f.t.pts = 1400; f.t.dice = [5, 2, 3];
  assert.strictEqual(E.cpuPlan(f).act, 'bank', 'takes the win');
});
function RISKS() { return E.RISKS; }

test('reckless farkles more often than cautious over many games', function () {
  function rate(risk) {
    var fk = 0, turns = 0;
    for (var s = 1; s <= 30; s++) {
      var g = E.newGame({ seed: s * 31, players: [{ name: 'a', cpu: risk }, { name: 'b', cpu: risk }], rules: { target: 5000 } });
      E.simulate(g);
      g.players.forEach(function (p) { fk += p.st.farkles; turns += p.st.turns; });
    }
    return fk / turns;
  }
  assert.ok(rate('reckless') > rate('cautious'));
});

test('save normalisation survives junk and keeps a game in progress', function () {
  var s = E.normSave(null);
  assert.strictEqual(s.mode, 'farkle');
  assert.strictEqual(s.seats.length, 2);
  s = E.normSave({ mode: 'pig', rules: { target: 777, pigTarget: 200, entry: 500 }, seats: [{ name: '\u0001Zed', cpu: 'evil' }], stats: { pig: { games: -4, wins: 9, cpu: { reckless: [2, 5] } } }, speed: 'warp', game: { junk: 1 } });
  assert.strictEqual(s.mode, 'pig');
  assert.strictEqual(s.rules.target, 10000);
  assert.strictEqual(s.rules.pigTarget, 200);
  assert.strictEqual(s.rules.entry, 500);
  assert.strictEqual(s.seats.length, 2, 'one seat is not enough: defaults');
  assert.strictEqual(s.stats.pig.games, 0);
  assert.strictEqual(s.stats.pig.wins, 0);
  assert.deepStrictEqual(s.stats.pig.cpu.reckless, [2, 2]);
  assert.strictEqual(s.speed, 'normal');
  assert.strictEqual(s.game, null);
  // a real game round-trips through JSON
  var g = E.newGame({ seed: 99, players: [{ name: 'A' }, { name: 'B', cpu: 'reckless' }] });
  E.roll(g);
  while (g.t.res) { E.next(g); E.roll(g); }
  var o = E.options(E.counts(g.t.dice), g.rules)[0];
  E.setSel(g, E.idxFor(g.t.dice, o.k));
  var back = E.normSave(JSON.parse(JSON.stringify({ game: g }))).game;
  assert.ok(back);
  assert.deepStrictEqual(back.t.dice, g.t.dice);
  assert.deepStrictEqual(back.t.sel, g.t.sel);
  assert.strictEqual(back.rs, g.rs);
  assert.strictEqual(back.players[1].cpu, 'reckless');
  assert.ok(E.canRoll(back));
  // a corrupted roll is replaced by a fresh turn, not a stuck state
  var bad = JSON.parse(JSON.stringify(g));
  bad.t.dice = [9, 9, 'x'];
  var b2 = E.normGame(bad);
  assert.ok(b2 && !b2.t.rolled && b2.t.avail >= 1);
  // finished games are not resumed
  var done = JSON.parse(JSON.stringify(g)); done.phase = 'over';
  assert.strictEqual(E.normGame(done), null);
});

test('settle records human results only', function () {
  var save = E.newSave();
  var g = E.newGame({ seed: 5, players: [{ name: 'me' }, { name: 'bot', cpu: 'reckless' }], rules: { target: 2500 } });
  E.simulate(g);
  var out = E.settle(save, g);
  assert.strictEqual(save.stats.farkle.games, 1);
  assert.strictEqual(save.stats.farkle.cpu.reckless[0], 1);
  assert.strictEqual(save.stats.farkle.wins, g.winner === 0 ? 1 : 0);
  assert.strictEqual(out.win, g.winner === 0);
  assert.strictEqual(E.settle(save, g), null, 'only once');
  var cpuOnly = E.newGame({ seed: 6, players: [{ name: 'a', cpu: 'cautious' }, { name: 'b', cpu: 'balanced' }], rules: { target: 2500 } });
  E.simulate(cpuOnly);
  E.settle(save, cpuOnly);
  assert.strictEqual(save.stats.farkle.games, 1, 'CPU-only games are not recorded');
  var pp = E.newGame({ mode: 'pig', seed: 8, players: [{ name: 'a' }, { name: 'b' }] });
  E.simulate(pp);
  E.settle(save, pp);
  assert.strictEqual(save.stats.pig.pp, 1);
  assert.strictEqual(save.stats.pig.wins, 0, 'pass-and-play is not a win vs CPU');
});


test('reloading a finished turn hands on to the next seat (no replayed turns)', function () {
  // banked, saved before the hand-on: reload must not give the same player another turn
  var g = E.newGame({ seed: 21, players: [{ name: 'A' }, { name: 'B', cpu: 'balanced' }] });
  E.roll(g); while (g.t.res) { E.next(g); g.cur = 0; g.t.res = ''; E.roll(g); }
  var o = E.options(E.counts(g.t.dice), g.rules)[0];
  E.setSel(g, E.idxFor(g.t.dice, o.k));
  E.bank(g);
  var sc0 = g.players[0].score;
  var back = E.normGame(JSON.parse(JSON.stringify(g)));
  assert.strictEqual(back.cur, 1);
  assert.strictEqual(back.players[0].score, sc0);
  assert.ok(!back.t.res && !back.t.rolled);
  // farkled, saved mid-reveal: no free re-roll either
  var f = E.newGame({ seed: 4, players: [{ name: 'A' }, { name: 'B' }] });
  f.t = { pts: 300, dice: [], sel: [], avail: 1, rolled: true, kept: [], hot: 0, rolls: 1, res: '', gain: 0 };
  f.t.avail = 2; f.t.dice = [5, 3]; f.t.sel = [true, false];   // keep the 5, roll one die
  f.rs = farkleSeed();
  E.roll(f);
  assert.strictEqual(f.t.res, 'farkle');
  var fb = E.normGame(JSON.parse(JSON.stringify(f)));
  assert.strictEqual(fb.cur, 1);
  assert.strictEqual(fb.players[0].fk, 1);
  assert.strictEqual(fb.players[0].score, 0);
  // the last turn of the final round: the game resolves on load
  var z = E.newGame({ seed: 5, players: [{ name: 'A' }, { name: 'B' }], rules: { target: 2500 } });
  z.final = 0; z.players[0].score = 2600; z.players[0].on = true; z.cur = 1; z.players[1].score = 1000;
  z.t.res = 'farkle';
  var zb = E.normGame(JSON.parse(JSON.stringify(z)));
  assert.strictEqual(zb.phase, 'over');
  assert.strictEqual(zb.winner, 0);
});

test('a tie in the final round goes to the player who set it', function () {
  var g = E.newGame({ seed: 5, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], rules: { target: 2500 } });
  g.players[0].score = 3000; g.players[2].score = 3000; g.final = 2; g.cur = 1; g.t.res = 'farkle';
  E.next(g);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, 2);
});

test('banking with all six dice scoring is not counted as hot dice', function () {
  var g = E.newGame({ seed: 3 });
  E.roll(g);
  force(g, [1, 1, 1, 5, 5, 1]);
  E.setSel(g, [0, 1, 2, 3, 4, 5]);
  var ev = E.bank(g);
  assert.ok(!ev.some(function (x) { return x.e === 'hot'; }));
  assert.strictEqual(g.players[0].st.hot, 0);
  assert.strictEqual(g.players[0].score, 2100);
});

test('scoring is the best decomposition for every 1-6 dice multiset', function () {
  // brute force: compare decompose() with an independent greedy-free search on the default rules
  function brute(c) {
    var key = c.join(','), tot = c.reduce(function (a, b) { return a + b; }, 0);
    if (!tot) return 0;
    var best = -1, f;
    if (tot === 6) {
      var sh = c.slice(1).filter(Boolean).sort().join('');
      if (sh === '111111') best = Math.max(best, 1500);
      if (sh === '222') best = Math.max(best, 1500);
    }
    for (f = 1; f <= 6; f++) {
      if (!c[f]) continue;
      if (f === 1 || f === 5) { c[f]--; var r = brute(c); c[f]++; if (r >= 0) best = Math.max(best, r + (f === 1 ? 100 : 50)); }
      for (var n = 3; n <= c[f]; n++) { c[f] -= n; var r2 = brute(c); c[f] += n; if (r2 >= 0) best = Math.max(best, r2 + (f === 1 ? 1000 : f * 100) * Math.pow(2, n - 3)); }
    }
    return best;
  }
  for (var x = 0; x < 46656; x++) {
    var v = [], y = x;
    for (var k = 0; k < 6; k++) { v.push(1 + (y % 6)); y = Math.floor(y / 6); }
    for (var len = 1; len <= 6; len++) {
      var sub = v.slice(0, len), b = brute(E.counts(sub));
      assert.strictEqual(sc(sub), b < 0 ? 0 : b, sub.join(''));
    }
  }
});

console.log(passed + ' passed');
if (process.exitCode) process.exit(process.exitCode);
