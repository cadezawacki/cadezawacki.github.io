/* Unit tests for the Chess Clock's DOM-free state machine (fake time throughout:
 * every call takes `now` in ms, as performance.now() would give it).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/chessclock/chessclock.test.js */
'use strict';
var assert = require('assert');
var C = require('./chessclock.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function cfg(mode, b0, i0, b1, i1) {
  var s = [{ base: b0, inc: i0 }];
  if (b1 != null) s.push({ base: b1, inc: i1 });
  return C.normCfg({ mode: mode, sides: s });
}
var MIN = 60000;

// ---- configs & labels ---------------------------------------------------------------
test('presets: every listed preset parses, round-trips and labels', function () {
  var n = 0;
  C.PRESET_GROUPS.forEach(function (g) {
    g.list.forEach(function (id) {
      var c = C.presetCfg(id), m = /^(\d+)\+(\d+)$/.exec(id);
      assert.ok(c, id);
      assert.strictEqual(c.mode, 'inc');
      assert.strictEqual(c.sides[0].base, +m[1] * MIN);
      assert.strictEqual(c.sides[1].inc, +m[2] * 1000);
      assert.strictEqual(C.presetOf(c), id);
      assert.strictEqual(C.shortLabel(c), id);
      n++;
    });
  });
  assert.strictEqual(n, 12);
  ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0', '30+20', '90+30'].forEach(function (id) { assert.ok(C.presetCfg(id), id); });
  assert.strictEqual(C.presetCfg('7+7'), null);
  assert.strictEqual(C.presetCfg(''), null);
});
test('normCfg: junk → the default; clamps; side 2 copies side 1', function () {
  [null, undefined, 5, 'x', [], {}, { sides: 'no' }].forEach(function (j) {
    var c = C.normCfg(j);
    assert.strictEqual(C.presetOf(c), C.DEFAULT_PRESET, JSON.stringify(j));
  });
  var c = C.normCfg({ mode: 'weird', sides: [{ base: -5, inc: 1e12 }, null] });
  assert.strictEqual(c.mode, 'inc');
  assert.strictEqual(c.sides[0].base, C.MIN_BASE);
  assert.strictEqual(c.sides[0].inc, C.MAX_INC);
  assert.deepStrictEqual(c.sides[1], c.sides[0]);
  c = C.normCfg({ mode: 'delay', sides: [{ base: '90000', inc: '5000' }, { base: 1e15, inc: NaN }] });
  assert.strictEqual(c.mode, 'delay');
  assert.strictEqual(c.sides[0].base, 90000);
  assert.strictEqual(c.sides[1].base, C.MAX_BASE);
  assert.strictEqual(c.sides[1].inc, 5000, 'NaN bonus falls back to side 1');
  assert.ok(C.handicap(c));
});
test('labels: delay / Bronstein / handicap / seconds', function () {
  assert.strictEqual(C.shortLabel(cfg('delay', 5 * MIN, 3000)), '5 d3');
  assert.strictEqual(C.shortLabel(cfg('bronstein', 5 * MIN, 3000)), '5 b3');
  assert.strictEqual(C.shortLabel(cfg('bronstein', 5 * MIN, 0)), '5+0');
  assert.strictEqual(C.shortLabel(cfg('inc', 90000, 0)), '1:30+0');
  assert.strictEqual(C.shortLabel(cfg('inc', 5 * MIN, 3000, 3 * MIN, 3000)), '5+3 / 3+3');
  assert.strictEqual(C.presetOf(cfg('delay', 5 * MIN, 3000)), '', 'a delay is not the 5+3 preset');
  assert.strictEqual(C.presetOf(cfg('delay', 5 * MIN, 0)), '5+0', 'no bonus: the mode does not matter');
});

// ---- formatting ------------------------------------------------------------------------------
test('fmt: m:ss rounded up, tenths under 20 s, hours', function () {
  assert.strictEqual(C.fmt(5 * MIN), '5:00');
  assert.strictEqual(C.fmt(5 * MIN - 1), '5:00', 'rounded up: a fresh second shows until it is used');
  assert.strictEqual(C.fmt(5 * MIN - 1000), '4:59');
  assert.strictEqual(C.fmt(20000), '0:20');
  assert.strictEqual(C.fmt(19950), '0:20');
  assert.strictEqual(C.fmt(19900), '0:19.9');
  assert.strictEqual(C.fmt(9050), '0:09.1');
  assert.strictEqual(C.fmt(100), '0:00.1');
  assert.strictEqual(C.fmt(1), '0:00.1');
  assert.strictEqual(C.fmt(0), '0:00.0');
  assert.strictEqual(C.fmt(-50), '0:00.0');
  assert.strictEqual(C.fmt(90 * MIN), '1:30:00');
  assert.strictEqual(C.fmt(3600000), '1:00:00');
  assert.strictEqual(C.fmt(3600000 - 1000), '59:59');
  assert.strictEqual(C.fmt(19900.000000001), '0:19.9', 'float noise does not bump a digit');
});

// ---- the state machine -----------------------------------------------------------------------
test('first press starts the other clock, no bonus, no move; only the running side reacts', function () {
  var st = C.create(cfg('inc', 3 * MIN, 2000));
  assert.strictEqual(C.press(st, 1, 1000), 'start');                 // Black presses
  assert.strictEqual(st.turn, 0); assert.strictEqual(st.first, 0); assert.ok(st.running);
  assert.deepStrictEqual(st.moves, [0, 0]);
  assert.strictEqual(st.rem[1], 3 * MIN, 'no increment for the starting press');
  assert.strictEqual(C.press(st, 1, 1500), 'ignored', 'the waiting side cannot press');
  assert.strictEqual(C.left(st, 0, 1500), 3 * MIN - 500);
  assert.strictEqual(C.left(st, 1, 1500), 3 * MIN);
  assert.strictEqual(C.press(st, 0, 4000), 'press');
  assert.strictEqual(st.turn, 1);
  assert.deepStrictEqual(st.moves, [1, 0]);
  assert.strictEqual(C.press(st, 2, 4100), 'ignored');
});
test('Fischer increment: added after each move', function () {
  var st = C.create(cfg('inc', 3 * MIN, 2000));
  C.press(st, 1, 0);                                  // White to move
  C.press(st, 0, 5000);                               // White used 5 s, +2 s
  assert.strictEqual(st.rem[0], 3 * MIN - 5000 + 2000);
  C.press(st, 1, 6000);                               // Black used 1 s, +2 s → gains a second
  assert.strictEqual(st.rem[1], 3 * MIN + 1000);
  assert.strictEqual(C.left(st, 0, 6000), 3 * MIN - 3000);
  assert.strictEqual(C.left(st, 0, 7000), 3 * MIN - 4000, 'counts from the press timestamp');
});
test('Bronstein delay: back what was used, up to the delay', function () {
  var st = C.create(cfg('bronstein', MIN, 3000));
  C.press(st, 1, 0);
  assert.strictEqual(C.left(st, 0, 2000), MIN - 2000, 'the clock visibly runs during the delay');
  C.press(st, 0, 2000);                               // used 2 s ≤ 3 s → all back
  assert.strictEqual(st.rem[0], MIN);
  C.press(st, 1, 7000);                               // Black used 5 s → 3 s back
  assert.strictEqual(st.rem[1], MIN - 2000);
  // Bronstein never adds more than was used (unlike Fischer)
  C.press(st, 0, 7500);
  assert.strictEqual(st.rem[0], MIN);
});
test('simple (US) delay: the main time waits for the delay', function () {
  var st = C.create(cfg('delay', MIN, 3000));
  C.press(st, 1, 0);
  assert.strictEqual(C.left(st, 0, 2500), MIN, 'main time untouched during the delay');
  assert.strictEqual(C.delayLeft(st, 2500), 500);
  assert.strictEqual(C.left(st, 0, 4000), MIN - 1000);
  assert.strictEqual(C.delayLeft(st, 4000), 0);
  C.press(st, 0, 5000);                               // used 5 s → 2 s off
  assert.strictEqual(st.rem[0], MIN - 2000);
  assert.strictEqual(C.delayLeft(st, 5000), 3000, 'a fresh delay for the next turn');
  C.press(st, 1, 6000);
  assert.strictEqual(st.rem[1], MIN, 'within the delay: nothing off');
});
test('Bronstein vs simple delay near zero: Bronstein flags at the main time, delay after it + the delay', function () {
  var b = C.create(cfg('bronstein', 2000, 5000)), d = C.create(cfg('delay', 2000, 5000));
  C.press(b, 1, 0); C.press(d, 1, 0);
  assert.strictEqual(C.toFlag(b, 0), 2000);
  assert.strictEqual(C.toFlag(d, 0), 7000);
  assert.strictEqual(C.tick(b, 2000), true);
  assert.strictEqual(C.tick(d, 2000), false);
  assert.strictEqual(C.tick(d, 6999), false);
  assert.strictEqual(C.tick(d, 7000), true);
});
test('flag at exactly 0 (tick and press)', function () {
  var st = C.create(cfg('inc', 1000, 0));
  C.press(st, 1, 100);
  assert.strictEqual(C.tick(st, 1099), false);
  assert.strictEqual(C.rawLeft(st, 0, 1099), 1);
  assert.strictEqual(C.tick(st, 1100), true, 'exactly 0 is a flag');
  assert.strictEqual(st.flag, 0); assert.strictEqual(st.running, false);
  assert.strictEqual(C.left(st, 0, 999999), 0, 'frozen at zero');
  assert.strictEqual(C.fmt(C.left(st, 0, 5000)), '0:00.0');
  assert.strictEqual(C.press(st, 0, 1200), 'ignored', 'no presses after the flag');
  assert.strictEqual(C.press(st, 1, 1200), 'ignored');
  assert.ok(!C.inProgress(st));
  // A press arriving at exactly the flag moment is a flag, not a move (no increment rescue)
  var s2 = C.create(cfg('inc', 1000, 5000));
  C.press(s2, 1, 0);
  assert.strictEqual(C.press(s2, 0, 1000), 'flag');
  assert.strictEqual(s2.flag, 0); assert.strictEqual(s2.moves[0], 0);
  // …one ms earlier it is a move, and the increment counts
  var s3 = C.create(cfg('inc', 1000, 5000));
  C.press(s3, 1, 0);
  assert.strictEqual(C.press(s3, 0, 999), 'press');
  assert.strictEqual(s3.rem[0], 5001);
  // The flag is detected late (hidden tab): still exactly 0, still that side
  var s4 = C.create(cfg('inc', 3000, 0));
  C.press(s4, 0, 0);                                  // side 1 to move
  assert.strictEqual(C.press(s4, 1, 60000), 'flag');
  assert.strictEqual(s4.flag, 1); assert.strictEqual(s4.rem[1], 0); assert.strictEqual(s4.rem[0], 3000);
});
test('pause / resume neither loses nor gains time (every mode)', function () {
  C.MODES.forEach(function (mode) {
    var st = C.create(cfg(mode, MIN, 3000)), ref = C.create(cfg(mode, MIN, 3000));
    C.press(st, 1, 0); C.press(ref, 1, 0);
    assert.strictEqual(C.pause(st, 1700), 'paused');
    assert.ok(C.paused(st));
    var held = C.left(st, 0, 1700);
    assert.strictEqual(C.left(st, 0, 500000), held, mode + ': frozen while paused');
    assert.strictEqual(C.toFlag(st, 500000), Infinity);
    assert.strictEqual(C.press(st, 0, 500000), 'ignored', mode + ': no press while paused');
    assert.strictEqual(C.resume(st, 600000), 'resumed');
    // 1.7 s before the pause + 2.3 s after = 4 s used in this turn, as on an uninterrupted clock
    assert.strictEqual(C.left(st, 0, 602300), C.left(ref, 0, 4000), mode + ': same time left');
    assert.strictEqual(C.delayLeft(st, 602300), C.delayLeft(ref, 4000), mode + ': the delay is per turn, not per resume');
    C.press(st, 0, 602300); C.press(ref, 0, 4000);
    assert.strictEqual(st.rem[0], ref.rem[0], mode + ': same after the press');
    assert.strictEqual(C.pause(st, 602300), 'paused');
    assert.strictEqual(C.pause(st, 602400), 'ignored');
    assert.strictEqual(C.resume(st, 602500), 'resumed');
    assert.strictEqual(C.resume(st, 602600), 'ignored');
  });
  var pre = C.create(cfg('inc', MIN, 0));
  assert.strictEqual(C.pause(pre, 0), 'ignored');
  assert.strictEqual(C.resume(pre, 0), 'ignored', 'cannot resume a game that has not started');
});
test('pausing after the time ran out flags instead', function () {
  var st = C.create(cfg('inc', 2000, 0));
  C.press(st, 1, 0);
  assert.strictEqual(C.pause(st, 2500), 'flag');
  assert.strictEqual(st.flag, 0);
});
test('handicap: each side its own base and bonus', function () {
  var st = C.create(cfg('inc', 5 * MIN, 3000, 2 * MIN, 1000));
  assert.deepStrictEqual(st.rem, [5 * MIN, 2 * MIN]);
  C.press(st, 1, 0);
  C.press(st, 0, 10000);
  assert.strictEqual(st.rem[0], 5 * MIN - 10000 + 3000);
  C.press(st, 1, 20000);
  assert.strictEqual(st.rem[1], 2 * MIN - 10000 + 1000);
  assert.strictEqual(C.lowAt(st.cfg, 0), 30000);
  assert.strictEqual(C.lowAt(st.cfg, 1), 12000);
  assert.strictEqual(C.lowAt(C.normCfg({ sides: [{ base: 3600000 }] }), 0), 60000, 'capped at a minute');
  assert.strictEqual(C.lowAt(C.normCfg({ sides: [{ base: 30000 }] }), 0), 10000, 'at least 10 s');
});
test('swap: the players change places (times, moves, settings, turn) — not while running', function () {
  var st = C.create(cfg('inc', 5 * MIN, 3000, 2 * MIN, 0));
  C.press(st, 1, 0);
  C.press(st, 0, 4000);                                // side 0 moved once, side 1 to move
  assert.strictEqual(C.swap(st), false, 'running');
  C.pause(st, 5000);
  var leftBefore = [C.left(st, 0, 5000), C.left(st, 1, 5000)];
  assert.strictEqual(C.swap(st), true);
  assert.deepStrictEqual([C.left(st, 0, 9000), C.left(st, 1, 9000)], [leftBefore[1], leftBefore[0]]);
  assert.deepStrictEqual(st.moves, [0, 1]);
  assert.strictEqual(st.turn, 0); assert.strictEqual(st.first, 1);
  assert.strictEqual(st.cfg.sides[0].base, 2 * MIN);
  C.resume(st, 9000);
  assert.strictEqual(C.press(st, 0, 9500), 'press', 'the swapped side to move presses');
  var fresh = C.create(cfg('inc', 5 * MIN, 0, MIN, 0));
  C.swap(fresh);
  assert.deepStrictEqual(fresh.rem, [MIN, 5 * MIN], 'before the game: the handicap moves sides');
});
test('toFlag predicts the flag moment exactly', function () {
  C.MODES.forEach(function (mode) {
    var st = C.create(cfg(mode, 10000, 2000));
    C.press(st, 1, 50);
    C.press(st, 0, 3050);
    var t = 3050 + C.toFlag(st, 3050);
    assert.strictEqual(C.tick(st, t - 1), false, mode);
    assert.strictEqual(C.tick(st, t), true, mode);
    assert.strictEqual(st.flag, 1);
  });
});
test('a long game: thousands of presses keep exact totals (no drift)', function () {
  var st = C.create(cfg('inc', 3 * MIN, 2000)), now = 0, used = [0, 0], n = 0;
  C.press(st, 1, now);
  while (n < 4000) {
    var i = st.turn, d = 700 + (n * 37) % 1300;       // 0.7 – 2 s per move, < the 2 s bonus on average
    now += d; used[i] += d;
    assert.strictEqual(C.press(st, i, now), 'press');
    n++;
  }
  assert.deepStrictEqual(st.moves, [2000, 2000]);
  for (var i = 0; i < 2; i++) assert.strictEqual(st.rem[i], 3 * MIN - used[i] + 2000 * st.moves[i]);
});
test('snapshot / restore: comes back paused with the same time; junk is refused', function () {
  var st = C.create(cfg('delay', MIN, 3000, 2 * MIN, 3000));
  C.press(st, 1, 0); C.press(st, 0, 5000); C.press(st, 1, 9000); // side 0 to move again
  var snap = JSON.parse(JSON.stringify(C.snapshot(st, 13000, 1e12)));
  var r = C.restore(snap, 1e12 + 5000, 86400000);
  assert.ok(r);
  assert.ok(C.paused(r), 'restored paused');
  assert.strictEqual(C.left(r, 0, 777), C.left(st, 0, 13000));
  assert.strictEqual(C.left(r, 1, 777), C.left(st, 1, 13000));
  assert.strictEqual(C.delayLeft(r, 777), C.delayLeft(st, 13000));
  assert.deepStrictEqual(r.moves, st.moves);
  assert.strictEqual(r.first, 0);
  C.resume(r, 1000);
  assert.strictEqual(C.left(r, 0, 3000), C.left(st, 0, 15000), 'resumes as if never interrupted');
  assert.strictEqual(C.restore(snap, 1e12 + 86400001, 86400000), null, 'too old');
  [null, 7, 'x', {}, { v: 2 }, Object.assign({}, snap, { turn: -1 }), Object.assign({}, snap, { flag: 0 }),
    Object.assign({}, snap, { rem: [NaN, 5] }), Object.assign({}, snap, { rem: [0, 5000] }), Object.assign({}, snap, { at: 'soon' }),
    Object.assign({}, snap, { used: 1e9 })].forEach(function (j, k) {
    assert.strictEqual(C.restore(j, 1e12, 86400000), null, 'junk #' + k);
  });
  var odd = C.restore(Object.assign({}, snap, { moves: 'x', first: 9, used: -4, cfg: 'nope' }), 1e12, 86400000);
  assert.ok(odd, 'repairable fields are repaired');
  assert.deepStrictEqual(odd.moves, [0, 0]);
  assert.strictEqual(odd.first, odd.turn);
  assert.strictEqual(odd.used, 0);
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
