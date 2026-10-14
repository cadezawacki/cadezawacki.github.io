/* Unit tests for the Split the Bill widget's pure logic (parsing, cents
 * allocation, quick split, group balances, settle-up, normalization, markdown).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/splitbill/splitbill.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var L = require('./splitbill.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function sum(a) { return a.reduce(function (s, x) { return s + x; }, 0); }
function rng(seed) { // mulberry32 — deterministic test randomness
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function group(names, ex, pay) {
  return L.normalize({ groups: [{ id: 'g1', name: 'Trip', cur: 'USD', members: names.map(function (n) { return { id: n, name: n }; }), ex: ex || [], pay: pay || [] }] }).groups[0];
}
function eq(id, payer, amt, who) { var s = {}; who.forEach(function (w) { s[w] = 1; }); return { id: id, d: id, a: amt, p: payer, m: 'eq', s: s, t: 1 }; }
// Apply transfers to balances: the payer's balance rises, the receiver's falls.
function applyTransfers(rows, tr) {
  var b = {};
  rows.forEach(function (r) { b[r.id] = r.bal; });
  tr.forEach(function (t) { b[t.from] += t.amt; b[t.to] -= t.amt; });
  return b;
}

// ---------------------------------------------------------------- parsing
test('parseNum: grouping, decimals, suffixes, symbols, percent', function () {
  var cases = [
    ['1,200.50', 1200.5], ['1.200,50', 1200.5], ['250k', 250000], ['250K', 250000], ['1.5m', 1500000], ['2bn', 2e9], ['3mm', 3e6],
    ['$12', 12], ['12 €', 12], ['€ 1.234,56', 1234.56], ['USD 10', 10], ['12,5', 12.5], ['1,20', 1.2], ['1,200', 1200],
    ['1,234,567.89', 1234567.89], ['.5', 0.5], ['5.', 5], ['-3', -3], ['−3.5', -3.5], ['+7', 7], ['1 000 000', 1000000],
    ['1 000,5', 1000.5], ["1'234.50", 1234.5], ['0,500', 0.5], ['1.1k', 1100],
  ];
  cases.forEach(function (c) {
    var r = L.parseNum(c[0], false);
    assert.ok(r, 'parsed ' + c[0]);
    assert.strictEqual(r.v, c[1], c[0]);
  });
  var p = L.parseNum('6.5%');
  assert.deepStrictEqual(p, { v: 6.5, pct: true });
  assert.strictEqual(L.parseNum('$1.5k').v, 1500);
  ['', '   ', 'abc', '1.2.3', '1,2,3', '12a', '(5)', '%', '.', '1,23,4'].forEach(function (s) { assert.strictEqual(L.parseNum(s), null, JSON.stringify(s)); });
});
test('parseNum: a comma-decimal locale reads "1.200" as 1200 and "1,5" as 1.5', function () {
  assert.strictEqual(L.parseNum('1.200', true).v, 1200);
  assert.strictEqual(L.parseNum('1,5', true).v, 1.5);
  assert.strictEqual(L.parseNum('1,200', true).v, 1.2);
  assert.strictEqual(L.parseNum('1.200,75', true).v, 1200.75);
  assert.strictEqual(L.parseNum('1.5', true).v, 1.5);
  assert.strictEqual(L.parseNum('1.200', false).v, 1.2);
});
test('toMinor rounds half away from zero without binary noise', function () {
  assert.strictEqual(L.toMinor(1.005, 100), 101);
  assert.strictEqual(L.toMinor(1.015, 100), 102);
  assert.strictEqual(L.toMinor(2.675, 100), 268);
  assert.strictEqual(L.toMinor(0.1 + 0.2, 100), 30);
  assert.strictEqual(L.toMinor(-1.005, 100), -101);
  assert.strictEqual(L.toMinor(1234.5, 1), 1235);
  assert.ok(isNaN(L.toMinor(NaN, 100)));
  assert.strictEqual(L.rnd(88.75), 89);
  assert.strictEqual(L.rnd(-0.5), -1);
});

// ---------------------------------------------------------------- allocation
test('allocate: parts are integers that sum exactly to the total', function () {
  var R = rng(1);
  for (var t = 0; t < 2000; t++) {
    var n = 1 + Math.floor(R() * 12), total = Math.floor(R() * 1e7) - (t % 5 === 0 ? 5e6 : 0), w = [];
    for (var i = 0; i < n; i++) w.push(Math.floor(R() * 4) === 0 ? 0 : +(R() * 10).toFixed(t % 3));
    var a = L.allocate(total, w, Math.floor(R() * n));
    assert.strictEqual(a.length, n);
    assert.strictEqual(sum(a), total, 'sum ' + JSON.stringify([total, w]));
    a.forEach(function (x) { assert.strictEqual(x, Math.round(x)); });
    var W = sum(w);
    if (W > 0) a.forEach(function (x, j) { assert.ok(Math.abs(x - total * w[j] / W) < 1 + 1e-9, 'within one unit of exact'); });
  }
});
test('allocate: odd cents rotate from the offset', function () {
  assert.deepStrictEqual(L.allocate(1000, [1, 1, 1], 0), [334, 333, 333]);
  assert.deepStrictEqual(L.allocate(1000, [1, 1, 1], 1), [333, 334, 333]);
  assert.deepStrictEqual(L.allocate(1000, [1, 1, 1], 2), [333, 333, 334]);
  assert.deepStrictEqual(L.allocate(1001, [1, 1, 1], 2), [334, 333, 334]);
  assert.deepStrictEqual(L.allocate(100, [1, 2, 3], 0), [17, 33, 50]);
  assert.deepStrictEqual(L.allocate(-1000, [1, 1, 1], 0), [-334, -333, -333]);
  assert.deepStrictEqual(L.allocate(0, [1, 2], 0), [0, 0]);
  assert.deepStrictEqual(L.allocate(10, [0, 0], 0), [5, 5]);            // no weights → equal
  assert.deepStrictEqual(L.allocate(10, [0, 1, 0], 0), [0, 10, 0]);      // zero weights get nothing
  assert.deepStrictEqual(L.allocate(100, [33.33, 33.33, 33.34], 0), [33, 33, 34]);
  assert.deepStrictEqual(L.allocate(10, [1.5, 1], 0), [6, 4]);
  // huge totals take the float path and still add up
  var big = L.allocate(99999999999, [123456789, 987654321, 555], 1);
  assert.strictEqual(sum(big), 99999999999);
});

// ---------------------------------------------------------------- quick split
function quick(o) {
  return L.quickSplit(Object.assign({ bill: 0, tipPct: 0, tax: 0, taxMode: 'pct', tipOn: 'pre', people: 1, step: 0, extras: [] }, o));
}
test('quick: $100 + 18% tip / 4 = $29.50 each', function () {
  var r = quick({ bill: 10000, tipPct: 18, people: 4 });
  assert.strictEqual(r.tip, 1800);
  assert.strictEqual(r.total, 11800);
  assert.deepStrictEqual(r.rounded, [2950, 2950, 2950, 2950]);
  assert.strictEqual(r.surplus, 0);
});
test('quick: tax as a percent, tip on the pre-tax or the taxed amount', function () {
  var pre = quick({ bill: 10000, tipPct: 18, tax: 8.875, people: 4 });
  assert.strictEqual(pre.tax, 888);            // 887.5 → 888 (half up)
  assert.strictEqual(pre.tip, 1800);
  assert.strictEqual(pre.total, 12688);
  assert.deepStrictEqual(pre.rounded, [3172, 3172, 3172, 3172]);
  var post = quick({ bill: 10000, tipPct: 18, tax: 8.875, tipOn: 'post', people: 4 });
  assert.strictEqual(post.tipBase, 10888);
  assert.strictEqual(post.tip, 1960);          // 19.5984 → 19.60
  assert.strictEqual(post.total, 12848);
  assert.deepStrictEqual(post.rounded, [3212, 3212, 3212, 3212]);
});
test('quick: tax as an amount', function () {
  var r = quick({ bill: 8000, tipPct: 20, tax: 712, taxMode: 'amt', people: 2 });
  assert.strictEqual(r.tax, 712);
  assert.strictEqual(r.tip, 1600);
  assert.strictEqual(r.total, 10312);
  assert.deepStrictEqual(r.rounded, [5156, 5156]);
});
test('quick: odd cents — shares differ by at most a cent and add up exactly', function () {
  var r = quick({ bill: 10000, people: 3 });
  assert.deepStrictEqual(r.rounded, [3334, 3333, 3333]);
  var r2 = quick({ bill: 12345, tipPct: 18, tax: 8.875, people: 4 });
  assert.strictEqual(sum(r2.rounded), r2.total);
  assert.ok(Math.max.apply(null, r2.rounded) - Math.min.apply(null, r2.rounded) <= 1);
  var R = rng(9);
  for (var t = 0; t < 500; t++) {
    var o = { bill: Math.floor(R() * 500000), tipPct: [0, 10, 15, 18, 20, 25, 12.5][t % 7], tax: R() * 12, people: 1 + Math.floor(R() * 12), tipOn: t % 2 ? 'pre' : 'post' };
    var x = quick(o);
    assert.strictEqual(sum(x.shares), x.total);
    assert.ok(Math.max.apply(null, x.shares) - Math.min.apply(null, x.shares) <= 1, 'even split within a cent');
  }
});
test('quick: round each share up to 0.50 or 1.00 — the surplus is extra tip', function () {
  var half = quick({ bill: 10000, people: 3, step: 50 });
  assert.deepStrictEqual(half.rounded, [3350, 3350, 3350]);
  assert.strictEqual(half.collected, 10050);
  assert.strictEqual(half.surplus, 50);
  var whole = quick({ bill: 10000, tipPct: 18, tax: 8.875, people: 4, step: 100 });
  assert.deepStrictEqual(whole.rounded, [3200, 3200, 3200, 3200]);
  assert.strictEqual(whole.surplus, 12800 - 12688);
  assert.ok(Math.abs(whole.effTipPct - (1800 + 112) / 10000 * 100) < 1e-9);
  var exact = quick({ bill: 10000, people: 4, step: 100 });
  assert.strictEqual(exact.surplus, 0); // already whole
});
test('quick: uneven split — extras are theirs, tax and tip follow what each ordered', function () {
  var r = quick({ bill: 10000, tipPct: 20, people: 2, extras: [{ p: 1, amt: 3000 }] });
  assert.deepStrictEqual(r.base, [3500, 6500]);
  assert.strictEqual(r.total, 12000);
  assert.deepStrictEqual(r.rounded, [4200, 7800]);
  assert.ok(r.uneven);
  var r3 = quick({ bill: 9000, tipPct: 15, tax: 10, people: 3, extras: [{ p: 0, amt: 1500 }, { p: 0, amt: 500 }, { p: 2, amt: 1000 }] });
  assert.deepStrictEqual(r3.base, [4000, 2000, 3000]);
  assert.strictEqual(sum(r3.rounded), r3.total);
  assert.strictEqual(r3.tax, 900);
  assert.strictEqual(r3.tip, 1350);
  assert.deepStrictEqual(r3.rounded, [5000, 2500, 3750]); // total 11250 × 4/9, 2/9, 3/9
  var bad = quick({ bill: 1000, people: 2, extras: [{ p: 0, amt: 1500 }] });
  assert.ok(bad.err);
  var ignored = quick({ bill: 1000, people: 2, extras: [{ p: 5, amt: 100 }, { p: 0, amt: NaN }] });
  assert.ok(!ignored.uneven);
});
test('quick: invalid input', function () {
  assert.ok(quick({ bill: NaN }).err);
  assert.ok(quick({ bill: -5 }).err);
  assert.ok(quick({ bill: 1e12 }).err);
  var zero = quick({ bill: 0, people: 3 });
  assert.deepStrictEqual(zero.rounded, [0, 0, 0]);
  assert.strictEqual(quick({ bill: 100, people: 0 }).n, 1);
  assert.strictEqual(quick({ bill: 100, people: 500 }).n, L.MAX_PEOPLE);
});

// ---------------------------------------------------------------- expenses & balances
test('expenseShares: equal among the selected members, odd cents rotate by expense', function () {
  var ids = ['a', 'b', 'c'];
  var s = L.expenseShares({ id: 'x1', a: 1000, m: 'eq', s: { a: 1, b: 1, c: 1 } }, ids);
  assert.strictEqual(s.a + s.b + s.c, 1000);
  assert.deepStrictEqual([s.a, s.b, s.c].sort(), [333, 333, 334]);
  var two = L.expenseShares({ id: 'x2', a: 1001, m: 'eq', s: { a: 1, c: 1 } }, ids);
  assert.strictEqual(two.b, undefined);
  assert.strictEqual(two.a + two.c, 1001);
  // the extra penny does not always land on the same person
  var who = {};
  for (var i = 0; i < 60; i++) {
    var sh = L.expenseShares({ id: 'e' + i, a: 100, m: 'eq', s: { a: 1, b: 1, c: 1 } }, ids);
    for (var k in sh) if (sh[k] === 34) who[k] = (who[k] || 0) + 1;
  }
  assert.strictEqual(Object.keys(who).length, 3, 'rotation spreads the odd cent');
  // deterministic: same id → same split
  assert.deepStrictEqual(L.expenseShares({ id: 'same', a: 100, m: 'eq', s: { a: 1, b: 1, c: 1 } }, ids),
    L.expenseShares({ id: 'same', a: 100, m: 'eq', s: { a: 1, b: 1, c: 1 } }, ids));
});
test('expenseShares: exact, shares and percentages', function () {
  var ids = ['a', 'b', 'c'];
  assert.deepStrictEqual(L.expenseShares({ id: 'x', a: 5000, m: 'ex', s: { a: 1234, b: 3766 } }, ids), { a: 1234, b: 3766 });
  var mism = L.expenseShares({ id: 'x', a: 5000, m: 'ex', s: { a: 1000, b: 1000 } }, ids); // corrupt: falls back to proportions
  assert.strictEqual(mism.a + mism.b, 5000);
  assert.deepStrictEqual(L.expenseShares({ id: 'x', a: 9000, m: 'sh', s: { a: 2, b: 1 } }, ids), { a: 6000, b: 3000 });
  assert.deepStrictEqual(L.expenseShares({ id: 'x', a: 1000, m: 'sh', s: { a: 1.5, b: 1, c: 0.5 } }, ids), { a: 500, b: 333, c: 167 });
  var p = L.expenseShares({ id: 'x', a: 10000, m: 'pc', s: { a: 50, b: 30, c: 20 } }, ids);
  assert.deepStrictEqual(p, { a: 5000, b: 3000, c: 2000 });
  var p3 = L.expenseShares({ id: 'x', a: 100, m: 'pc', s: { a: 33.33, b: 33.33, c: 33.34 } }, ids);
  assert.strictEqual(p3.a + p3.b + p3.c, 100);
  assert.deepStrictEqual(L.expenseShares({ id: 'x', a: 300, m: 'eq', s: {} }, ids), { a: 100, b: 100, c: 100 });
});
test('balances: paid − share + settle-up payments; always sums to zero', function () {
  var g = group(['Ana', 'Ben', 'Cy'], [eq('e1', 'Ana', 9000, ['Ana', 'Ben', 'Cy'])]);
  var rows = L.balances(g);
  assert.deepStrictEqual(rows.map(function (r) { return r.bal; }), [6000, -3000, -3000]);
  assert.deepStrictEqual(rows.map(function (r) { return r.paid; }), [9000, 0, 0]);
  assert.deepStrictEqual(rows.map(function (r) { return r.share; }), [3000, 3000, 3000]);
  g.pay.push({ id: 'p1', f: 'Ben', to: 'Ana', a: 3000, t: 2 });
  rows = L.balances(g);
  assert.deepStrictEqual(rows.map(function (r) { return r.bal; }), [3000, 0, -3000]);
  var tr = L.settleUp(rows);
  assert.deepStrictEqual(tr, [{ from: 'Cy', to: 'Ana', amt: 3000 }]);
});
test('settle-up: known cases need the fewest transfers', function () {
  function rowsOf(b) { return b.map(function (v, i) { return { id: ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay'][i], bal: v }; }); }
  // everyone owes one person
  assert.deepStrictEqual(L.settleUp(rowsOf([6000, -3000, -3000])), [{ from: 'Ben', to: 'Ana', amt: 3000 }, { from: 'Cy', to: 'Ana', amt: 3000 }]);
  // a chain collapses: Ana owes Ben 10, Ben owes Cy 10 → Ana pays Cy directly
  assert.deepStrictEqual(L.settleUp(rowsOf([-1000, 0, 1000])), [{ from: 'Ana', to: 'Cy', amt: 1000 }]);
  // nothing to do
  assert.deepStrictEqual(L.settleUp(rowsOf([0, 0, 0])), []);
  // plain greedy (largest debtor → largest creditor) needs 4 here; the exact partition finds 3:
  // Ben −80 / Dee +80 settle alone; Ana −90 covers Cy +30 and Eve +60.
  var b = [-9000, -8000, 3000, 8000, 6000], rows = rowsOf(b);
  var plain = [];
  L.greedy(rows.map(function (r, i) { return { id: r.id, o: i, b: r.bal }; }), plain);
  assert.strictEqual(plain.length, 4);
  var tr = L.settleUp(rows);
  assert.strictEqual(tr.length, 3);
  assert.deepStrictEqual(tr, [{ from: 'Ana', to: 'Eve', amt: 6000 }, { from: 'Ana', to: 'Cy', amt: 3000 }, { from: 'Ben', to: 'Dee', amt: 8000 }]);
  // two independent pairs → 2
  assert.strictEqual(L.settleUp(rowsOf([-500, 500, -700, 700])).length, 2);
  // odd cents
  var c = L.settleUp(rowsOf([1, -1, 2, -2]));
  assert.strictEqual(c.length, 2);
  c.forEach(function (t) { assert.ok(t.amt > 0 && t.amt === Math.round(t.amt)); });
});
// Brute force the true minimum: n − (most disjoint zero-sum subsets).
function bruteMin(b) {
  var nz = b.filter(function (x) { return x; }), n = nz.length, best = 0;
  function rec(rest, groups) {
    if (!rest.length) { best = Math.max(best, groups); return; }
    var first = rest[0], others = rest.slice(1), m = others.length;
    for (var mask = 0; mask < (1 << m); mask++) {
      var s = first, inG = [], out = [];
      for (var i = 0; i < m; i++) { if (mask & (1 << i)) { s += others[i]; inG.push(i); } else out.push(others[i]); }
      if (s === 0) rec(out, groups + 1);
    }
  }
  rec(nz, 0);
  return n - best;
}
test('settle-up: random groups — transfers clear every balance, amounts are whole cents, count is minimal', function () {
  var R = rng(42);
  for (var t = 0; t < 400; t++) {
    var n = 2 + Math.floor(R() * 6), names = [], i;
    for (i = 0; i < n; i++) names.push('m' + i);
    var ex = [], cnt = 1 + Math.floor(R() * 12);
    for (i = 0; i < cnt; i++) {
      var mode = ['eq', 'ex', 'sh', 'pc'][Math.floor(R() * 4)], a = 1 + Math.floor(R() * 50000), s = {};
      var who = names.filter(function () { return R() < 0.7; });
      if (!who.length) who = [names[0]];
      if (mode === 'eq') who.forEach(function (w) { s[w] = 1; });
      else if (mode === 'ex') { var parts = L.allocate(a, who.map(function () { return 1 + Math.floor(R() * 5); }), 0); who.forEach(function (w, j) { s[w] = parts[j]; }); }
      else if (mode === 'sh') who.forEach(function (w) { s[w] = 1 + Math.floor(R() * 3); });
      else { var pcs = L.allocate(10000, who.map(function () { return 1 + Math.floor(R() * 5); }), 0); who.forEach(function (w, j) { s[w] = pcs[j] / 100; }); }
      ex.push({ id: 'e' + t + '_' + i, d: 'x', a: a, p: names[Math.floor(R() * n)], m: mode, s: s, t: i });
    }
    var g = group(names, ex);
    assert.strictEqual(g.ex.length, cnt, 'all expenses kept');
    var rows = L.balances(g);
    assert.strictEqual(sum(rows.map(function (r) { return r.bal; })), 0, 'balances sum to zero');
    assert.strictEqual(sum(rows.map(function (r) { return r.share; })), sum(ex.map(function (e) { return e.a; })), 'shares cover every expense');
    var tr = L.settleUp(rows);
    tr.forEach(function (x) { assert.ok(x.amt > 0 && x.amt === Math.round(x.amt) && x.from !== x.to); });
    var after = applyTransfers(rows, tr);
    for (var k in after) assert.strictEqual(after[k], 0, 'settled ' + k);
    var nz = rows.filter(function (r) { return r.bal; }).length;
    assert.ok(tr.length <= Math.max(0, nz - 1));
    assert.strictEqual(tr.length, bruteMin(rows.map(function (r) { return r.bal; })), 'minimal');
    // recording every transfer as a payment leaves everyone square
    tr.forEach(function (x, j) { g.pay.push({ id: 'p' + j, f: x.from, to: x.to, a: x.amt, t: 9 }); });
    assert.ok(L.balances(g).every(function (r) { return r.bal === 0; }));
  }
});
test('settle-up: more than 15 people falls back to greedy and still clears everything', function () {
  var R = rng(5), rows = [], s = 0;
  for (var i = 0; i < 24; i++) { var v = i === 23 ? -s : Math.floor(R() * 20001) - 10000; s += v; rows.push({ id: 'p' + i, bal: v }); }
  var tr = L.settleUp(rows), after = applyTransfers(rows, tr);
  for (var k in after) assert.strictEqual(after[k], 0);
  assert.ok(tr.length <= 23);
});

// ---------------------------------------------------------------- normalization
test('normalize: garbage in, a valid empty store out', function () {
  [null, undefined, 5, 'x', [], {}, { groups: 'no' }, { groups: [null, 4, 'g'] }].forEach(function (raw) {
    assert.deepStrictEqual(L.normalize(raw), { v: 1, groups: [] });
  });
});
test('normalize: drops what it cannot trust, keeps the rest', function () {
  var d = L.normalize({ groups: [{
    id: 'g1', name: '  Lisbon  ', cur: 'XXX1', members: [{ id: 'a', name: 'Ana' }, { id: 'a', name: 'Dup' }, { id: 'b', name: '' }, { id: 'bad id!', name: 'x' }, null],
    ex: [
      { id: 'e1', d: 'Dinner', a: 9000, p: 'a', m: 'eq', s: { a: 1, b: 1, zz: 1 } },
      { id: 'e2', a: 100, p: 'nobody', m: 'eq', s: {} },          // unknown payer → dropped
      { id: 'e3', a: -5, p: 'a' },                                // bad amount → dropped
      { id: 'e4', a: 12.5, p: 'a' },                              // not integer cents → dropped
      { id: 'e1', a: 300, p: 'b', m: 'weird', s: { a: 'x' } },    // dup id → new id; bad mode → eq; empty split → everyone
      { id: 'e6', a: 1000, p: 'b', m: 'ex', s: { a: 400.4, b: 599.6 } },
    ],
    pay: [{ id: 'p1', f: 'a', to: 'b', a: 500 }, { id: 'p2', f: 'a', to: 'a', a: 5 }, { id: 'p3', f: 'a', to: 'q', a: 5 }, { f: 'b', to: 'a', a: 0 }],
  }, { id: 'g1', name: 'Same id' }] });
  assert.strictEqual(d.groups.length, 2);
  var g = d.groups[0];
  assert.strictEqual(g.name, 'Lisbon');
  assert.strictEqual(g.cur, 'USD');
  assert.strictEqual(g.dg, 2);
  assert.deepStrictEqual(g.members, [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Member' }]);
  assert.strictEqual(g.ex.length, 3);
  assert.deepStrictEqual(g.ex[0].s, { a: 1, b: 1 });
  assert.notStrictEqual(g.ex[1].id, 'e1');
  assert.strictEqual(g.ex[1].m, 'eq');
  assert.deepStrictEqual(g.ex[1].s, { a: 1, b: 1 });
  assert.deepStrictEqual(g.ex[2].s, { a: 400, b: 600 });
  assert.strictEqual(g.pay.length, 1);
  assert.notStrictEqual(d.groups[1].id, 'g1');
  assert.strictEqual(sum(L.balances(g).map(function (r) { return r.bal; })), 0);
  // round-trips unchanged
  assert.deepStrictEqual(L.normalize(JSON.parse(JSON.stringify(d))), d);
});
test('normalize: JPY groups keep 0 digits; rescaleGroup converts amounts', function () {
  var g = L.normalize({ groups: [{ id: 'j', name: 'Tokyo', cur: 'JPY', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], ex: [{ id: 'e', a: 3001, p: 'a', m: 'eq', s: { a: 1, b: 1 } }] }] }).groups[0];
  assert.strictEqual(g.dg, 0);
  var sh = L.expenseShares(g.ex[0], ['a', 'b']);
  assert.strictEqual(sh.a + sh.b, 3001);
  L.rescaleGroup(g, 2);
  assert.strictEqual(g.ex[0].a, 300100);
  assert.strictEqual(g.dg, 2);
  var u = group(['a', 'b'], [{ id: 'e', a: 1234, p: 'a', m: 'ex', s: { a: 1000, b: 234 } }], [{ id: 'p', f: 'b', to: 'a', a: 99 }]);
  L.rescaleGroup(u, 0);
  assert.strictEqual(u.ex[0].a, 12);
  assert.deepStrictEqual(u.ex[0].s, { a: 10, b: 2 });
  assert.strictEqual(u.pay[0].a, 1);
});
test('isReferenced: members with expenses or payments cannot be removed', function () {
  var g = group(['a', 'b', 'c', 'd'], [eq('e', 'a', 100, ['a', 'b'])], [{ id: 'p', f: 'c', to: 'a', a: 5 }]);
  assert.ok(L.isReferenced(g, 'a'));
  assert.ok(L.isReferenced(g, 'b'));
  assert.ok(L.isReferenced(g, 'c'));
  assert.ok(!L.isReferenced(g, 'd'));
});

// ---------------------------------------------------------------- formatting & markdown
test('currency formatting, digits, symbols and the locale guess', function () {
  assert.strictEqual(L.money(123456, 'USD', 'en-US'), '$1,234.56');
  assert.strictEqual(L.money(-500, 'USD', 'en-US'), '−$5.00');
  assert.strictEqual(L.money(123456, 'EUR', 'de-DE').replace(/\s/g, ' '), '1.234,56 €');
  assert.strictEqual(L.money(1234, 'JPY', 'en-US'), '¥1,234');
  assert.strictEqual(L.curDigits('USD'), 2);
  assert.strictEqual(L.curDigits('JPY'), 0);
  assert.strictEqual(L.curDigits('KWD'), 3);
  assert.strictEqual(L.curSymbol('EUR', 'en-US'), '€');
  assert.strictEqual(L.guessCur('en-US'), 'USD');
  assert.strictEqual(L.guessCur('en-GB'), 'GBP');
  assert.strictEqual(L.guessCur('de-DE'), 'EUR');
  assert.strictEqual(L.guessCur('fr'), 'EUR');
  assert.strictEqual(L.guessCur('ja'), 'JPY');
  assert.strictEqual(L.guessCur('zz'), 'USD');
  assert.ok(L.validCur('EUR') && !L.validCur('eur') && !L.validCur('ABCD'));
  assert.ok(L.decimalComma('de-DE') && !L.decimalComma('en-US'));
});
test('markdown: quick split and group summaries', function () {
  var r = quick({ bill: 10000, tipPct: 18, tax: 8.875, people: 4 });
  var md = L.quickMarkdown(r, ['A', 'B', 'C', 'D'], 'USD', 'en-US');
  assert.ok(md.indexOf('| Bill | $100.00 |') >= 0, md);
  assert.ok(md.indexOf('| Tax (8.875%) | $8.88 |') >= 0, md);
  assert.ok(md.indexOf('| **Total** | **$126.88** |') >= 0, md);
  assert.ok(md.indexOf('| **Each (4)** | **$31.72** |') >= 0, md);
  var u = quick({ bill: 10000, tipPct: 20, people: 2, extras: [{ p: 1, amt: 3000 }] });
  var mdu = L.quickMarkdown(u, ['Ana', 'Ben|x'], 'USD', 'en-US');
  assert.ok(mdu.indexOf('| Ana | $35.00 | $42.00 |') >= 0, mdu);
  assert.ok(mdu.indexOf('| Ben\\|x | $65.00 | $78.00 |') >= 0, mdu);
  assert.ok(/Total \$118\.00/.test(L.quickText(quick({ bill: 10000, tipPct: 18, people: 4 }), 'USD', 'en-US')));
  var g = group(['Ana', 'Ben', 'Cy'], [eq('e1', 'Ana', 9000, ['Ana', 'Ben', 'Cy'])]);
  var rows = L.balances(g), gm = L.groupMarkdown(g, rows, L.settleUp(rows), 'en-US');
  assert.ok(gm.indexOf('### Trip — $90.00 spent') === 0, gm);
  assert.ok(gm.indexOf('| Ana | $90.00 | $30.00 | +$60.00 |') >= 0, gm);
  assert.ok(gm.indexOf('| Ben | $0.00 | $30.00 | -$30.00 |') >= 0, gm);
  assert.ok(gm.indexOf('| Ben | Ana | $30.00 |') >= 0, gm);
  var sq = group(['A', 'B']);
  assert.ok(L.groupMarkdown(sq, L.balances(sq), [], 'en-US').indexOf('everyone is square') >= 0);
});

test('safeLocale: odd system locales become usable BCP 47 tags', function () {
  assert.strictEqual(L.safeLocale('en-US@posix'), 'en-US');
  assert.strictEqual(L.safeLocale('de_DE.UTF-8'), 'de-DE');
  assert.strictEqual(L.safeLocale('fr-CA'), 'fr-CA');
  assert.strictEqual(L.safeLocale(''), 'en-US');
  assert.strictEqual(L.safeLocale('!!'), 'en-US');
  assert.doesNotThrow(function () { new Date(2026, 0, 1).toLocaleDateString(L.safeLocale('en-US@posix'), { month: 'short' }); });
});

// ---------------------------------------------------------------- widget registration
test('widget registers as "Split the Bill" (equal to the manifest entry name)', function () {
  var widget = null, css = null;
  var win = { Cade: { loadCSS: function (c) { css = c; }, registerWidget: function (w) { widget = w; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'splitbill.js'), 'utf8'), { window: win, Intl: Intl, Math: Math, Date: Date, JSON: JSON }, { filename: 'splitbill.js' });
  assert.ok(widget, 'registerWidget was called');
  assert.strictEqual(widget.name, 'Split the Bill');
  assert.strictEqual(css, 'splitbill.css');
  assert.strictEqual(typeof widget.open, 'function');
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'splitbill'; })[0];
  assert.strictEqual(entry.name, widget.name);
  assert.strictEqual(entry.description, widget.description);
  assert.strictEqual(entry.icon, widget.icon);
  assert.strictEqual(entry.tags, widget.tags);
  assert.strictEqual(entry.entry, 'widgets/splitbill/splitbill.js');
  assert.strictEqual(entry.css, 'widgets/splitbill/splitbill.css');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
