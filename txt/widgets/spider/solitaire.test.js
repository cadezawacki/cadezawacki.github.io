/* Unit tests for the Solitaire widget's pure engines: KlondikeCore (new) and
 * SpiderCore (must not change — golden fingerprints below were taken from the
 * Spider-only widget, so an in-progress Spider save keeps replaying the same).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/spider/solitaire.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// Load the widget with a minimal fake window.Cade; only registerWidget matters.
var widget = null;
vm.runInThisContext('(function (window) {' + fs.readFileSync(path.join(__dirname, 'spider.js'), 'utf8') + '\n})',
  { filename: 'spider.js' })({ Cade: { loadCSS: function () {}, registerWidget: function (w) { widget = w; } } });
assert.ok(widget, 'registerWidget was called');
var K = widget._klondike(), SP = widget._core();

var passed = 0;
function test(name, fn) {
  var t0 = Date.now();
  try { fn(); passed++; if (Date.now() - t0 > 3000) console.log('  slow: ' + name + ' ' + (Date.now() - t0) + 'ms'); }
  catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function rng(seed) {                      // deterministic test randomness (mulberry32)
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function fnv(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }

// ---- Klondike helpers ---------------------------------------------------------------
var SPADE = 0, HEART = 1, CLUB = 2, DIAMOND = 3;
function C(rank, suit) { return suit * 13 + rank - 1; }
function mk(o) {
  var piles = (o.piles || []).slice();
  while (piles.length < 7) piles.push([]);
  var down = (o.down || []).slice();
  while (down.length < 7) down.push(0);
  var waste = o.waste || [];
  return {
    draw: o.draw || 1, piles: piles, down: down, stock: o.stock || [], waste: waste,
    wfan: o.wfan != null ? o.wfan : waste.length ? 1 : 0, found: o.found || [[], [], [], []], score: o.score || 0, passes: 0
  };
}
// Every reachable state keeps these.
function checkKlondike(st, where) {
  var all = [];
  st.piles.forEach(function (p) { all = all.concat(p); });
  all = all.concat(st.stock, st.waste);
  st.found.forEach(function (f) { all = all.concat(f); });
  assert.strictEqual(all.length, 52, where + ': 52 cards');
  assert.strictEqual(new Set(all).size, 52, where + ': unique cards');
  all.forEach(function (id) { assert.ok(id >= 0 && id < 52 && id === (id | 0), where + ': card id ' + id); });
  st.found.forEach(function (f) {
    f.forEach(function (id, k) { assert.strictEqual(K.R(id), k + 1, where + ': foundation order'); assert.strictEqual(K.S(id), K.S(f[0]), where + ': foundation suit'); });
  });
  for (var p = 0; p < 7; p++) {
    var a = st.piles[p];
    if (!a.length) { assert.strictEqual(st.down[p], 0, where + ': empty column down'); continue; }
    assert.ok(st.down[p] >= 0 && st.down[p] < a.length, where + ': top card face-up in column ' + p);
    for (var i = st.down[p] + 1; i < a.length; i++) {
      assert.strictEqual(K.R(a[i - 1]), K.R(a[i]) + 1, where + ': column ' + p + ' descends');
      assert.notStrictEqual(K.red(a[i - 1]), K.red(a[i]), where + ': column ' + p + ' alternates');
    }
  }
  assert.ok(st.score >= 0, where + ': score >= 0');
  assert.ok(st.wfan >= 0 && st.wfan <= Math.min(st.draw, st.waste.length), where + ': waste fan');
  if (st.waste.length) assert.ok(st.wfan >= 1, where + ': fan shows the waste top');
}
var PLACES = ['0', '1', '2', '3', '4', '5', '6', 'w', 'a', 'b', 'c', 'd'];
var TARGETS = ['0', '1', '2', '3', '4', '5', '6', 'a', 'b', 'c', 'd'];
function legalMoves(st) {
  var out = [];
  PLACES.forEach(function (from) {
    var a = K.pileOf(st, from), maxN = K.isT(from) ? a.length - st.down[+from] : Math.min(1, a.length);
    for (var n = 1; n <= maxN; n++) TARGETS.forEach(function (to) { if (K.legal(st, from, n, to)) out.push(K.token(from, to, n)); });
  });
  if (st.stock.length) out.push('D');
  if (K.canRecycle(st)) out.push('R');
  return out;
}
// Four all-face-up columns K→A in alternating colours, nothing else: a solved-in-waiting table.
function finishable() {
  var cols = [[], [], [], []];
  for (var r = 13; r >= 1; r--) {
    cols[0].push(C(r, r % 2 ? SPADE : HEART));
    cols[1].push(C(r, r % 2 ? HEART : SPADE));
    cols[2].push(C(r, r % 2 ? CLUB : DIAMOND));
    cols[3].push(C(r, r % 2 ? DIAMOND : CLUB));
  }
  return mk({ piles: cols });
}

// ---- Klondike: deals ---------------------------------------------------------------
test('klondike: deals are deterministic per number; draw count does not change the layout', function () {
  assert.deepStrictEqual(K.deal(42, 1), K.deal(42, 1));
  assert.deepStrictEqual(K.deal(42, 3).piles, K.deal(42, 1).piles);
  assert.deepStrictEqual(K.deal(42, 3).stock, K.deal(42, 1).stock);
  assert.strictEqual(K.deal(42, 3).draw, 3);
  assert.strictEqual(K.deal(42, 7).draw, 1, 'bad draw count falls back to 1');
  assert.notDeepStrictEqual(K.deal(42, 1).piles, K.deal(43, 1).piles);
  // Deal numbers spread: 300 deals give (nearly) 300 different first columns + stock tops.
  var seen = new Set();
  for (var d = 1; d <= 300; d++) { var s = K.deal(d, 1); seen.add(s.piles.map(function (p) { return p[p.length - 1]; }).join('.') + '|' + s.stock.slice(-3).join('.')); }
  assert.ok(seen.size >= 299, 'distinct deals: ' + seen.size);
});
test('klondike: a deal has 52 unique cards, columns 1..7 with only the top face-up, 24 in the stock', function () {
  for (var d = 1; d <= 50; d++) {
    var st = K.deal(d * 7919, 1);
    checkKlondike(st, 'deal ' + d);
    assert.deepStrictEqual(st.piles.map(function (p) { return p.length; }), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepStrictEqual(st.down, [0, 1, 2, 3, 4, 5, 6]);
    assert.strictEqual(st.stock.length, 24);
    assert.strictEqual(st.waste.length, 0);
    assert.strictEqual(st.score, 0);
    assert.ok(st.found.every(function (f) { return !f.length; }));
  }
});

// ---- Klondike: rules ---------------------------------------------------------------
test('klondike: columns build down in alternating colours', function () {
  var st = mk({ piles: [[C(8, SPADE)], [C(7, HEART)], [C(7, CLUB)], [C(8, HEART)], [C(6, DIAMOND)], [C(9, DIAMOND)]] });
  assert.ok(K.legal(st, '1', 1, '0'), 'red 7 on black 8');
  assert.ok(!K.legal(st, '2', 1, '0'), 'black 7 on black 8');
  assert.ok(K.legal(st, '2', 1, '3'), 'black 7 on red 8');
  assert.ok(!K.legal(st, '1', 1, '3'), 'red 7 on red 8');
  assert.ok(!K.legal(st, '4', 1, '0'), '6 on 8');
  assert.ok(!K.legal(st, '0', 1, '1'), '8 on 7 (up)');
  assert.ok(!K.legal(st, '0', 1, '0'), 'onto itself');
  assert.ok(!K.legal(st, '0', 2, '5'), 'more cards than the column has');
  assert.ok(!K.legal(st, '0', 0, '5'), 'zero cards');
  assert.ok(K.legal(st, '0', 1, '5'), 'black 8 on red 9');
});
test('klondike: only a King (or a run headed by one) goes into an empty column', function () {
  var st = mk({ piles: [[], [C(13, SPADE), C(12, HEART), C(11, CLUB)], [C(12, DIAMOND)], [C(3, SPADE), C(13, HEART)]], down: [0, 0, 0, 1] });
  assert.ok(!K.legal(st, '2', 1, '0'), 'Queen into an empty column');
  assert.ok(K.legal(st, '1', 3, '0'), 'K-Q-J run into an empty column');
  assert.ok(!K.legal(st, '1', 2, '0'), 'Q-J run into an empty column');
  assert.ok(K.legal(st, '3', 1, '0'), 'King into an empty column');
  assert.ok(!K.legal(st, '3', 2, '0'), 'a face-down card cannot be picked up');
});
test('klondike: foundations build A→K by suit; one card at a time; no foundation→foundation', function () {
  var st = mk({ piles: [[C(1, SPADE)], [C(2, SPADE)], [C(2, HEART)], [C(3, SPADE)], [C(1, HEART), C(2, CLUB)]], found: [[], [], [], []] });
  assert.ok(!K.legal(st, '1', 1, 'a'), '2 onto an empty foundation');
  assert.ok(K.legal(st, '0', 1, 'c'), 'Ace onto any empty foundation');
  assert.strictEqual(K.foundFor(st, C(1, SPADE)), 0, 'an Ace takes the first empty foundation');
  assert.ok(K.apply(st, '0a1'));
  assert.strictEqual(st.score, 10);
  assert.ok(K.legal(st, '1', 1, 'a'), '2♠ on A♠');
  assert.ok(!K.legal(st, '2', 1, 'a'), '2♥ on A♠');
  assert.ok(!K.legal(st, '3', 1, 'a'), '3♠ on A♠');
  assert.strictEqual(K.foundFor(st, C(2, SPADE)), 0);
  assert.strictEqual(K.foundFor(st, C(2, HEART)), -1);
  assert.ok(!K.legal(st, '4', 2, 'b'), 'two cards at once');
  assert.ok(K.apply(st, '1a1'));
  st.piles[5] = [C(1, DIAMOND)];
  assert.ok(K.apply(st, '5b1'));
  assert.ok(!K.legal(st, 'a', 1, 'c'), 'foundation to foundation');
  assert.ok(!K.apply(st, 'ac1'), 'foundation to foundation (token)');
});
test('klondike: foundation → column is allowed (−15)', function () {
  var st = mk({ piles: [[C(4, CLUB)]], found: [[C(1, HEART), C(2, HEART), C(3, HEART)], [], [], []], score: 40 });
  assert.ok(K.legal(st, 'a', 1, '0'), '3♥ back onto 4♣');
  assert.ok(K.apply(st, 'a01'));
  assert.deepStrictEqual(st.piles[0], [C(4, CLUB), C(3, HEART)]);
  assert.strictEqual(st.found[0].length, 2);
  assert.strictEqual(st.score, 25);
});
test('klondike: an exposed face-down card turns over as part of the move (+5)', function () {
  // column 0: 3♣ (down), 7♥ 6♣ (up) — move the 7♥-6♣ run onto 8♠
  var st = mk({ piles: [[C(3, CLUB), C(7, HEART), C(6, CLUB)], [C(8, SPADE)], [C(2, DIAMOND)]], down: [1, 0, 0] });
  assert.ok(!K.legal(st, '0', 3, '1'), 'the face-down card cannot come along');
  assert.ok(K.apply(st, '012'));
  assert.deepStrictEqual(st.piles[1], [C(8, SPADE), C(7, HEART), C(6, CLUB)]);
  assert.strictEqual(st.down[0], 0, '3♣ turned over');
  assert.strictEqual(st.score, 5);
  // moving a column's last card leaves it empty: nothing to turn, no bonus
  assert.ok(K.apply(st, '201'));
  assert.strictEqual(st.down[2], 0);
  assert.strictEqual(st.piles[2].length, 0);
  assert.strictEqual(st.score, 5);
});
test('klondike: undo via replay restores face-down cards exactly', function () {
  for (var d = 1; d < 400; d++) {
    var st = K.deal(d, 1), mv = legalMoves(st).filter(function (t) { return t !== 'D' && K.isT(t[0]) && st.down[+t[0]] > 0; })[0];
    if (!mv) continue;
    var before = clone(st);
    assert.ok(K.apply(st, mv));
    assert.ok(st.down[+mv[0]] < before.down[+mv[0]], 'flipped');
    assert.deepStrictEqual(K.replay(d, 1, []).st, before, 'undo = replay without the last token');
    assert.deepStrictEqual(K.replay(d, 1, [mv]).st, st, 'redo = replay with it');
    return;
  }
  assert.fail('no deal with a revealing first move');
});
test('klondike: the waste offers only its top card; waste→column +5, waste→foundation +10', function () {
  var st = mk({ piles: [[C(9, SPADE)]], waste: [C(1, CLUB), C(8, HEART)], wfan: 2, draw: 3 });
  assert.ok(K.canMoveFrom(st, 'w', 1));
  assert.ok(!K.canMoveFrom(st, 'w', 0));
  assert.ok(!K.legal(st, 'w', 2, '0'));
  assert.ok(K.apply(st, 'w01'));
  assert.strictEqual(st.score, 5);
  assert.strictEqual(st.wfan, 1, 'fan shrinks but keeps showing the top');
  assert.ok(K.apply(st, 'wa1'));
  assert.strictEqual(st.score, 15);
  assert.strictEqual(st.wfan, 0);
  assert.ok(!K.apply(st, 'w01'), 'empty waste');
});
test('klondike: bad tokens are rejected', function () {
  var st = K.deal(9, 1), snap = clone(st);
  ['', 'x', 'D1', '7a1', '0e1', '00 ', '0a0', '0ae', 'w', 'sw1', 'a', 'Z'].forEach(function (t) { assert.ok(!K.apply(st, t), 'token ' + JSON.stringify(t)); });
  assert.deepStrictEqual(st, snap, 'state untouched');
  assert.ok(!K.apply(st, 'R'), 'recycle with cards still in the stock');
});

// ---- Klondike: stock ---------------------------------------------------------------
test('klondike: Draw 1 turns one card; recycle restores the stock order (−100)', function () {
  var st = K.deal(77, 1), stock0 = st.stock.slice();
  st.score = 250;
  assert.ok(K.apply(st, 'D'));
  assert.deepStrictEqual(st.waste, [stock0[23]]);
  assert.strictEqual(st.wfan, 1);
  for (var k = 1; k < 24; k++) assert.ok(K.apply(st, 'D'));
  assert.strictEqual(st.stock.length, 0);
  assert.strictEqual(st.waste.length, 24);
  assert.deepStrictEqual(st.waste, stock0.slice().reverse());
  assert.ok(!K.apply(st, 'D'), 'nothing to draw');
  assert.ok(K.canRecycle(st));
  assert.ok(K.apply(st, 'R'));
  assert.deepStrictEqual(st.stock, stock0, 'same order as before');
  assert.strictEqual(st.waste.length, 0);
  assert.strictEqual(st.wfan, 0);
  assert.strictEqual(st.score, 150);
  assert.strictEqual(st.passes, 1);
  st.score = 30;
  for (k = 0; k < 24; k++) K.apply(st, 'D');
  assert.ok(K.apply(st, 'R'));
  assert.strictEqual(st.score, 0, 'score never goes below 0');
  checkKlondike(st, 'after recycles');
});
test('klondike: Draw 3 turns three (the third becomes the top), fewer at the end; recycle −20', function () {
  var st = K.deal(77, 3), stock0 = st.stock.slice();
  st.score = 100;
  assert.ok(K.apply(st, 'D'));
  assert.deepStrictEqual(st.waste, [stock0[23], stock0[22], stock0[21]]);
  assert.strictEqual(st.wfan, 3);
  for (var k = 1; k < 8; k++) assert.ok(K.apply(st, 'D'));
  assert.strictEqual(st.stock.length, 0);
  assert.ok(K.apply(st, 'R'));
  assert.deepStrictEqual(st.stock, stock0);
  assert.strictEqual(st.score, 80);
  // 22 cards left → 7 full draws and a final draw of one
  var t = mk({ draw: 3, stock: stock0.slice(0, 22), piles: [stock0.slice(22)].concat(K.deal(77, 3).piles.slice(1)) });
  t.found = [[], [], [], []];
  for (k = 0; k < 7; k++) K.apply(t, 'D');
  assert.strictEqual(t.stock.length, 1);
  assert.ok(K.apply(t, 'D'));
  assert.strictEqual(t.wfan, 1);
  assert.strictEqual(t.waste.length, 22);
});

// ---- Klondike: undo / redo via replay -----------------------------------------------
test('klondike: replaying every prefix of a random game reproduces each state exactly', function () {
  var r = rng(1234);
  for (var g = 0; g < 40; g++) {
    var dealNo = 1 + ((r() * 999999) | 0), draw = g % 2 ? 3 : 1, st = K.deal(dealNo, draw), toks = [], snaps = [clone(st)];
    for (var step = 0; step < 150; step++) {
      var ms = legalMoves(st);
      if (!ms.length) break;
      var tok = ms[(r() * ms.length) | 0];
      assert.ok(K.apply(st, tok), 'legal move applies: ' + tok);
      toks.push(tok); snaps.push(clone(st));
    }
    for (var k = 0; k <= toks.length; k += 7) {
      var rep = K.replay(dealNo, draw, toks.slice(0, k));
      assert.strictEqual(rep.bad, -1);
      assert.deepStrictEqual(rep.st, snaps[k], 'deal ' + dealNo + ' after ' + k + ' moves');
    }
    var full = K.replay(dealNo, draw, toks);
    assert.deepStrictEqual(full.st, st);
    // A corrupt tail stops at the first bad token.
    var bad = K.replay(dealNo, draw, toks.slice(0, 5).concat(['zz9'], toks.slice(5)));
    assert.strictEqual(bad.bad, Math.min(5, toks.length));
  }
});

// ---- Klondike: auto-finish ---------------------------------------------------------
test('klondike: auto-finish sends everything home, lowest rank first, and wins', function () {
  var st = finishable();
  checkKlondike(st, 'finishable');
  assert.ok(K.canAutoFinish(st));
  assert.ok(/^[0-6]a1$/.test(K.nextHome(st)), 'an Ace goes first');
  var start = clone(st), toks = K.autoFinish(st);
  assert.strictEqual(toks.length, 52);
  assert.ok(K.won(st));
  assert.ok(!K.canAutoFinish(st), 'nothing left to finish');
  checkKlondike(st, 'finished');
  // replaying the tokens on the starting table: ranks go home in non-decreasing order
  var t = clone(start), lastR = 0;
  toks.forEach(function (tok) {
    var a = K.pileOf(t, tok[0]), r = K.R(a[a.length - 1]);
    assert.ok(r >= lastR, 'lowest rank first');
    lastR = r;
    assert.ok(K.apply(t, tok));
  });
  assert.ok(K.won(t));
  assert.strictEqual(t.score, 520, '52 cards × 10');
});
test('klondike: auto-finish is offered only with every card face-up and stock + waste empty', function () {
  var st = finishable();
  st.down[0] = 1;
  assert.ok(!K.canAutoFinish(st), 'a face-down card');
  st = finishable();
  st.stock.push(st.piles[3].pop());
  assert.ok(!K.canAutoFinish(st), 'a card in the stock');
  st = finishable();
  st.waste.push(st.piles[3].pop()); st.wfan = 1;
  assert.ok(!K.canAutoFinish(st), 'a card in the waste');
  assert.ok(!K.canAutoFinish(K.deal(3, 1)), 'a fresh deal');
});

// ---- Klondike: hints, best target, stuck --------------------------------------------
test('klondike: hints and tap targets are always legal; foundation first for a single card', function () {
  var r = rng(99);
  for (var g = 0; g < 60; g++) {
    var dealNo = 1 + ((r() * 999999) | 0), st = K.deal(dealNo, g % 2 ? 3 : 1);
    for (var step = 0; step < 120; step++) {
      K.hints(st).forEach(function (h) {
        if (h.draw) assert.ok(st.stock.length > 0);
        else if (h.recycle) assert.ok(K.canRecycle(st));
        else assert.ok(K.legal(st, h.from, h.n, h.to), 'hint ' + JSON.stringify(h));
      });
      PLACES.forEach(function (c) {
        var a = K.pileOf(st, c);
        for (var i = 0; i < a.length; i++) {
          var to = K.bestTarget(st, c, i);
          if (!to) continue;
          assert.ok(K.legal(st, c, a.length - i, to), 'bestTarget ' + c + i + '→' + to);
          if (a.length - i === 1 && !K.isF(c) && K.foundFor(st, a[i]) >= 0) assert.ok(K.isF(to), 'single card goes home first');
        }
      });
      var ms = legalMoves(st);
      if (!ms.length) break;
      K.apply(st, ms[(r() * ms.length) | 0]);
    }
  }
});
test('klondike: hint ranking — a foundation move beats a plain column move; no pointless shuffles', function () {
  var st = mk({ piles: [[C(1, SPADE)], [C(9, HEART)], [C(10, CLUB), C(9, DIAMOND)], [C(10, SPADE)]], stock: [C(5, HEART)] });
  var h = K.hints(st);
  assert.deepStrictEqual({ from: h[0].from, to: h[0].to }, { from: '0', to: 'a' });
  // 9♦ already sits on 10♣ and moving it frees nothing: never suggested
  assert.ok(!h.some(function (x) { return x.from === '2'; }), 'no shuffle of 9♦');
  assert.ok(h.some(function (x) { return x.from === '1' && x.to === '3'; }) === false, '9♥ alone in its column, no King waiting: emptying it is not suggested');
  assert.ok(h[h.length - 1].draw, 'drawing comes last');
});
test('klondike: stuck = nothing useful on the table and nothing in stock/waste fits anywhere', function () {
  // Two columns of lone low cards, stock with cards that fit nowhere.
  var st = mk({ piles: [[C(5, SPADE)], [C(5, CLUB)]], stock: [C(9, HEART), C(9, DIAMOND)], found: [[], [], [], []] });
  assert.ok(K.stuck(st));
  st.stock.push(C(4, HEART));         // 4♥ fits on 5♠
  assert.ok(!K.stuck(st));
  assert.ok(!K.stuck(finishable()));
});

// ---- Klondike: fuzz ---------------------------------------------------------------
test('klondike: random self-play never corrupts the table (200 games)', function () {
  var r = rng(20261013), moves = 0, recycles = 0;
  for (var g = 0; g < 200; g++) {
    var dealNo = 1 + ((r() * 999999) | 0), draw = r() < 0.5 ? 1 : 3, st = K.deal(dealNo, draw), toks = [];
    for (var step = 0; step < 250; step++) {
      var ms = legalMoves(st);
      if (!ms.length) break;
      // favour table moves over drawing so games get somewhere
      var table = ms.filter(function (t) { return t !== 'D' && t !== 'R'; });
      var tok = table.length && r() < 0.7 ? table[(r() * table.length) | 0] : ms[(r() * ms.length) | 0];
      var copy = clone(st);
      assert.ok(K.apply(copy, tok), 'enumerated move applies: ' + tok);
      K.apply(st, tok);
      if (tok === 'R') recycles++;
      toks.push(tok); moves++;
      checkKlondike(st, 'deal ' + dealNo + ' move ' + step + ' ' + tok);
    }
    assert.deepStrictEqual(K.replay(dealNo, draw, toks).st, st, 'replay of game ' + g);
  }
  assert.ok(moves > 20000 && recycles > 10, 'fuzz covered ' + moves + ' moves, ' + recycles + ' recycles');
});
test('klondike: following the hints wins some deals (Draw 1)', function () {
  var wins = 0;
  for (var d = 1; d <= 150; d++) {
    var st = K.deal(d, 1), seen = new Set();
    for (var step = 0; step < 1500 && !K.won(st); step++) {
      if (K.canAutoFinish(st)) { K.autoFinish(st); break; }
      var key = JSON.stringify([st.piles, st.down, st.stock, st.waste, st.found]);
      if (seen.has(key) && !st.stock.length && !st.waste.length) break;
      seen.add(key);
      var h = K.hints(st)[0];
      if (!h || K.stuck(st)) break;
      var tok = h.draw ? 'D' : h.recycle ? 'R' : K.token(h.from, h.to, h.n);
      if (h.recycle && st.passes > 30) break;
      assert.ok(K.apply(st, tok), 'hint applies');
    }
    checkKlondike(st, 'hint play ' + d);
    if (K.won(st)) wins++;
  }
  assert.ok(wins >= 5, 'greedy hint play won ' + wins + '/150');
});

// ---- Spider: unchanged ---------------------------------------------------------------
// Fingerprints of a deterministic hint-driven game per (deal, suits) and deal #1's layout,
// taken from the Spider-only widget before Klondike was added.
var SPIDER_GOLDEN = {
  '1/1': '9b832191', '1/2': '6440bd74', '1/4': '26bfe4e1', '2/1': '89245bb2', '2/2': 'c3bda6e7', '2/4': '3e562c63',
  '3/1': 'e4616705', '3/2': 'f3c09339', '3/4': '4583c2f1', '77/1': '4e36f579', '77/2': '62c3ed76', '77/4': 'cca3531f',
  '4242/1': 'acaa29d', '4242/2': 'c90f3aed', '4242/4': '3ffc3939', '999999/1': '9e22b4d6', '999999/2': '834cd901', '999999/4': 'ff0e6eee'
};
var SPIDER_DEAL1 = '59.2.9.56.50.40|95.1.82.36.70.34|22.87.61.90.85.13|39.73.51.12.18.10|65.86.46.35.52|71.100.57.37.24|16.69.4.45.26|49.14.20.103.8|6.48.32.54.42|21.91.23.53.89';
function spiderPlay(dealNo, suits) {
  var st = SP.deal(dealNo, suits), toks = [];
  for (var step = 0; step < 300 && !SP.won(st); step++) {
    var h = SP.hints(st, true);
    if (!h.length) break;
    var x = h[step % Math.min(3, h.length)], tok = x.deal ? 'D' : SP.token(x.p, x.n, x.q);
    if (!SP.apply(st, tok)) break;
    toks.push(tok);
  }
  return { fp: fnv(toks.join(',') + '|' + JSON.stringify(st)), toks: toks, st: st };
}
test('spider: deals, hints and moves match the Spider-only widget (golden fingerprints)', function () {
  assert.strictEqual(SP.deal(1, 4).piles.map(function (p) { return p.join('.'); }).join('|'), SPIDER_DEAL1);
  Object.keys(SPIDER_GOLDEN).forEach(function (k) {
    var parts = k.split('/');
    assert.strictEqual(spiderPlay(+parts[0], +parts[1]).fp, SPIDER_GOLDEN[k], 'spider ' + k);
  });
});
test('spider: basic rules — same-suit runs, any suit accepts rank+1, deal needs every column (classic)', function () {
  var st = SP.deal(11, 2);
  assert.strictEqual(st.stock.length, 50);
  assert.deepStrictEqual(st.piles.map(function (p) { return p.length; }), [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
  assert.ok(SP.canDeal(st, true));
  assert.ok(SP.apply(st, 'D'));
  assert.strictEqual(st.stock.length, 40);
  st.piles[0] = [];
  st.down[0] = 0;
  assert.ok(!SP.canDeal(st, true), 'classic: not with an empty column');
  assert.ok(SP.canDeal(st, false));
  assert.ok(!SP.apply(st, '00x'), 'bad token');
});
test('spider: replay reproduces every prefix; random play keeps 104 cards', function () {
  var r = rng(7);
  for (var g = 0; g < 40; g++) {
    var dealNo = 1 + ((r() * 999999) | 0), suits = [1, 2, 4][g % 3], st = SP.deal(dealNo, suits), toks = [], snaps = [clone(st)];
    for (var step = 0; step < 150; step++) {
      var ms = [];
      for (var p = 0; p < 10; p++) for (var n = 1; n <= st.piles[p].length; n++) for (var q = 0; q < 10; q++) if (SP.legal(st, p, n, q) && n <= 13) ms.push(SP.token(p, n, q));
      if (SP.canDeal(st, false)) ms.push('D');
      if (!ms.length) break;
      var tok = ms[(r() * ms.length) | 0];
      assert.ok(SP.apply(st, tok), tok);
      toks.push(tok); snaps.push(clone(st));
      var count = st.stock.length + st.found.length * 13;
      st.piles.forEach(function (pl) { count += pl.length; });
      assert.strictEqual(count, 104);
    }
    for (var k = 0; k <= toks.length; k += 11) assert.deepStrictEqual(SP.replay(dealNo, suits, toks.slice(0, k)).st, snaps[k]);
  }
});

// ---- widget registration -------------------------------------------------------------
test('widget registers as "Solitaire" (must equal the manifest name)', function () {
  assert.strictEqual(widget.name, 'Solitaire');
  assert.strictEqual(typeof widget.open, 'function');
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var entry = manifest.modules.filter(function (m) { return m.id === 'spider'; })[0];
  assert.ok(entry, 'manifest entry');
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.entry, 'widgets/spider/spider.js');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
