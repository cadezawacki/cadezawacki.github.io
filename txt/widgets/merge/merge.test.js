/* Checks for the Sync Conflict merge core: three-way auto-merge, conflict
 * detection, identical changes, edges, CRLF, empty base, speed on big input,
 * and the per-chunk / per-line choices the merge screen applies.
 * Not loaded by the app. Run: node txt/widgets/merge/merge.test.js */
'use strict';
var assert = require('assert');
var M = require('./merge-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function L() { return Array.prototype.slice.call(arguments).join('\n'); }
function conflictsOf(r) { return r.chunks.filter(function (c) { return c.type === 'conflict'; }); }

var BASE = L('# Groceries', 'milk', 'eggs', 'bread', '', '# Todo', 'call mum', 'pay rent', 'fix bike', '', '# Notes', 'nothing yet');

test('line diff covers both sides and is minimal on a classic case', function () {
  var a = 'abcabba'.split(''), b = 'cbabac'.split('');
  var ops = M.diffSeq(a, b), edits = 0;
  ops.forEach(function (o) { if (o.t === '~') edits += (o.a1 - o.a0) + (o.b1 - o.b0); });
  assert.strictEqual(edits, 5);
  for (var t = 0; t < 2000; t++) {
    var r = function () { return Array.from({ length: Math.random() * 14 | 0 }, function () { return 'abcd'[Math.random() * 4 | 0]; }); };
    var x = r(), y = r(), A = [], B = [];
    M.diffSeq(x, y).forEach(function (o) {
      for (var i = o.a0; i < o.a1; i++) A.push(x[i]);
      for (var j = o.b0; j < o.b1; j++) B.push(y[j]);
      if (o.t === '=') for (var k = 0; k < o.a1 - o.a0; k++) assert.strictEqual(x[o.a0 + k], y[o.b0 + k]);
    });
    assert.deepStrictEqual(A, x); assert.deepStrictEqual(B, y);
  }
});

test('edits to different regions merge automatically', function () {
  var mine = BASE.replace('eggs', 'eggs (12)');
  var theirs = BASE.replace('fix bike', 'fix bike tyre').replace('nothing yet', 'nothing yet\nmeeting at 3');
  var r = M.merge3(BASE, mine, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.auto, 3);
  assert.strictEqual(r.merged, BASE.replace('eggs', 'eggs (12)').replace('fix bike', 'fix bike tyre').replace('nothing yet', 'nothing yet\nmeeting at 3'));
  var kinds = r.chunks.filter(function (c) { return c.type === 'auto'; }).map(function (c) { return c.kind; });
  assert.deepStrictEqual(kinds, ['mine', 'theirs', 'theirs']);
});

test('adjacent but separate lines still merge', function () {
  var mine = BASE.replace('milk', 'oat milk');
  var theirs = BASE.replace('eggs', 'free-range eggs');
  var r = M.merge3(BASE, mine, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.merged, BASE.replace('milk', 'oat milk').replace('eggs', 'free-range eggs'));
});

test('both sides changing the same line differently is a conflict', function () {
  var mine = BASE.replace('pay rent', 'pay rent today');
  var theirs = BASE.replace('pay rent', 'pay rent (done)').replace('milk', 'milk x2');
  var r = M.merge3(BASE, mine, theirs);
  assert.strictEqual(r.conflicts, 1);
  assert.strictEqual(r.merged, null);
  var c = conflictsOf(r)[0];
  assert.deepStrictEqual(c.base, ['pay rent']);
  assert.deepStrictEqual(c.mine, ['pay rent today']);
  assert.deepStrictEqual(c.theirs, ['pay rent (done)']);
  assert.strictEqual(c.m0, 7); assert.strictEqual(c.t0, 7);
  // the non-overlapping theirs edit is still applied when choosing mine
  var out = M.applyChoices(r, (function () { var o = {}; o[c.id] = { pick: 'mine' }; return o; })());
  assert.strictEqual(out, BASE.replace('pay rent', 'pay rent today').replace('milk', 'milk x2'));
  assert.deepStrictEqual(M.stats(r, {}), { total: 1, resolved: 0, remaining: 1 });
});

test('a conflict is trimmed to the lines that actually differ', function () {
  var mine = BASE.replace('call mum\npay rent\nfix bike', 'call mum!\npay rent\nfix bike now');
  var theirs = BASE.replace('call mum\npay rent\nfix bike', 'call mum!\npay rent\nfix bike later');
  var r = M.merge3(BASE, mine, theirs);
  assert.strictEqual(r.conflicts, 1);
  var c = conflictsOf(r)[0];
  assert.deepStrictEqual(c.mine, ['fix bike now']);
  assert.deepStrictEqual(c.theirs, ['fix bike later']);
});

test('identical changes on both sides are not conflicts', function () {
  var both = BASE.replace('bread', 'sourdough').replace('nothing yet', 'all done');
  var r = M.merge3(BASE, both, both.replace('# Groceries', '# Shopping'));
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.merged, both.replace('# Groceries', '# Shopping'));
  var r2 = M.merge3(BASE, both, both);
  assert.strictEqual(r2.conflicts, 0);
  assert.strictEqual(r2.merged, both);
  assert.ok(r2.chunks.some(function (c) { return c.kind === 'both'; }));
});

test('inserts and deletes at the ends', function () {
  var mine = 'NEW TOP\n' + BASE;                 // insert at start
  var theirs = BASE + '\nNEW BOTTOM';            // insert at end
  var r = M.merge3(BASE, mine, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.merged, 'NEW TOP\n' + BASE + '\nNEW BOTTOM');
  // delete first line here, delete last line there
  var lines = BASE.split('\n');
  var r2 = M.merge3(BASE, lines.slice(1).join('\n'), lines.slice(0, -1).join('\n'));
  assert.strictEqual(r2.conflicts, 0);
  assert.strictEqual(r2.merged, lines.slice(1, -1).join('\n'));
  // both append different lines at the end → union, theirs first, no prompt
  var r3 = M.merge3(BASE, BASE + '\nfrom phone', BASE + '\nfrom laptop');
  assert.strictEqual(r3.conflicts, 0);
  assert.strictEqual(r3.merged, BASE + '\nfrom laptop\nfrom phone');
  // delete vs edit of the same line → conflict
  var r4 = M.merge3(BASE, BASE.replace('eggs\n', ''), BASE.replace('eggs', 'eggs!'));
  assert.strictEqual(r4.conflicts, 1);
  var c = conflictsOf(r4)[0];
  assert.deepStrictEqual(c.mine, []); assert.deepStrictEqual(c.theirs, ['eggs!']);
});

test('CRLF documents merge and keep CRLF', function () {
  var crlf = function (s) { return s.replace(/\n/g, '\r\n'); };
  var b = crlf(BASE), m = crlf(BASE.replace('milk', 'MILK')), t = crlf(BASE.replace('fix bike', 'FIX BIKE'));
  var r = M.merge3(b, m, t);
  assert.strictEqual(r.conflicts, 0);
  assert.strictEqual(r.merged, crlf(BASE.replace('milk', 'MILK').replace('fix bike', 'FIX BIKE')));
  // A device that converted line endings doesn't turn every line into a conflict.
  var r2 = M.merge3(BASE, crlf(BASE), BASE.replace('eggs', 'eggs?'));
  assert.strictEqual(r2.conflicts, 0);
  assert.strictEqual(r2.merged, crlf(BASE.replace('eggs', 'eggs?')));
});

test('empty base (both started from nothing) and empty sides', function () {
  var r = M.merge3('', 'hello\nworld', 'hello\nthere');
  assert.strictEqual(r.conflicts, 1);
  assert.deepStrictEqual(conflictsOf(r)[0].mine, ['world']);
  assert.deepStrictEqual(conflictsOf(r)[0].theirs, ['there']);
  var r2 = M.merge3('', '', 'only theirs');
  assert.strictEqual(r2.conflicts, 0); assert.strictEqual(r2.merged, 'only theirs');
  var r3 = M.merge3('a\nb', '', 'a\nb');
  assert.strictEqual(r3.conflicts, 0); assert.strictEqual(r3.merged, '');
});

test('two-way fallback asks about every difference', function () {
  var r = M.merge2('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.strictEqual(r.twoWay, true);
  assert.strictEqual(r.conflicts, 2);
  var cs = conflictsOf(r);
  var ch = {}; ch[cs[0].id] = { pick: 'theirs' }; ch[cs[1].id] = { pick: 'mine' };
  assert.strictEqual(M.applyChoices(r, ch), 'a\nB\nc\nd');
  ch[cs[1].id] = { pick: 'theirs' };
  assert.strictEqual(M.applyChoices(r, ch), 'a\nB\nc\nd\ne');
});

test('per-hunk choices: mine, theirs, both in either order, base, custom', function () {
  var mine = BASE.replace('pay rent', 'pay rent today');
  var theirs = BASE.replace('pay rent', 'pay rent (done)');
  var r = M.merge3(BASE, mine, theirs), id = conflictsOf(r)[0].id;
  var with_ = function (choice) { var o = {}; o[id] = choice; return M.applyChoices(r, o); };
  assert.strictEqual(with_({ pick: 'mine' }), mine);
  assert.strictEqual(with_({ pick: 'theirs' }), theirs);
  assert.strictEqual(with_({ pick: 'mine-first' }), BASE.replace('pay rent', 'pay rent today\npay rent (done)'));
  assert.strictEqual(with_({ pick: 'theirs-first' }), BASE.replace('pay rent', 'pay rent (done)\npay rent today'));
  assert.strictEqual(with_({ pick: 'base' }), BASE);
  assert.strictEqual(with_({ pick: 'custom', text: 'pay rent — done today\r\nand tip' }), BASE.replace('pay rent', 'pay rent — done today\nand tip'));
  assert.strictEqual(with_({ pick: 'custom', text: '' }), BASE.replace('pay rent\n', ''));
  // unresolved → git-style markers by default
  assert.ok(/<<<<<<< this device\npay rent today\n=======\npay rent \(done\)\n>>>>>>> server/.test(M.applyChoices(r, {})));
  assert.deepStrictEqual(M.stats(r, (function () { var o = {}; o[id] = { pick: 'mine' }; return o; })()), { total: 1, resolved: 1, remaining: 0 });
});

test('per-line selection picks individual lines in document order', function () {
  var base = L('intro', 'old', 'outro');
  var mine = L('intro', 'a1', 'b', 'c1', 'x', 'outro');
  var theirs = L('intro', 'a2', 'b', 'c2', 'outro');
  var r = M.merge3(base, mine, theirs);
  assert.strictEqual(r.conflicts, 1);
  var c = conflictsOf(r)[0];
  assert.deepStrictEqual(c.mine, ['a1', 'b', 'c1', 'x']);
  assert.deepStrictEqual(c.theirs, ['a2', 'b', 'c2']);
  var segs = M.alignChunk(c);
  assert.deepStrictEqual(segs.map(function (s) { return s.t; }), ['~', '=', '~']);
  // equivalent selections
  var sm = M.selectionFor(c, 'mine'), st = M.selectionFor(c, 'theirs');
  assert.deepStrictEqual(M.resolveChunk(c, { pick: 'lines', m: sm.m, t: sm.t }), c.mine);
  assert.deepStrictEqual(M.resolveChunk(c, { pick: 'lines', m: st.m, t: st.t }), c.theirs);
  // theirs' first line, the shared b, mine's c1, drop x, also theirs' c2
  var o = {}; o[c.id] = { pick: 'lines', m: [false, true, true, false], t: [true, true, true] };
  assert.strictEqual(M.applyChoices(r, o), L('intro', 'a2', 'b', 'c1', 'c2', 'outro'));
  o[c.id].order = 'theirs';
  assert.strictEqual(M.applyChoices(r, o), L('intro', 'a2', 'b', 'c2', 'c1', 'outro'));
  // nothing selected → the chunk disappears
  o[c.id] = { pick: 'lines', m: [false, false, false, false], t: [false, false, false] };
  assert.strictEqual(M.applyChoices(r, o), L('intro', 'outro'));
});

test('auto-merged chunks can be reverted to the other side', function () {
  var mine = BASE.replace('eggs', 'eggs (12)');
  var theirs = BASE.replace('fix bike', 'fix bike tyre');
  var r = M.merge3(BASE, mine, theirs);
  var autoTheirs = r.chunks.filter(function (c) { return c.kind === 'theirs'; })[0];
  var o = {}; o[autoTheirs.id] = { pick: 'mine' };     // "revert" the other device's edit
  assert.strictEqual(M.applyChoices(r, o), mine);
});

test('word diff marks only the changed words', function () {
  var w = M.wordDiff('pay the rent today', 'pay the rent tomorrow');
  assert.deepStrictEqual(w.a, [[13, 18]]);
  assert.deepStrictEqual(w.b, [[13, 21]]);
  var w2 = M.wordDiff('a b c', 'a x y c');
  assert.deepStrictEqual(w2.a, [[2, 3]]);
  assert.deepStrictEqual(w2.b, [[2, 5]]);
  assert.deepStrictEqual(M.wordDiff('same', 'same'), { a: [], b: [] });
  assert.ok(M.similarity('pay the rent today', 'pay the rent tomorrow') > 0.5);
  assert.ok(M.similarity('completely different', 'nothing alike here') < 0.3);
});

test('large inputs merge quickly', function () {
  var lines = [];
  for (var i = 0; i < 40000; i++) lines.push('line ' + i + ' ' + (i % 7 === 0 ? '' : 'lorem ipsum dolor sit amet'));
  var base = lines.join('\n');                         // ~1.2 MB
  var m = lines.slice(), t = lines.slice();
  for (var k = 0; k < 200; k++) { m[k * 150] = 'mine ' + k; t[k * 150 + 70] = 'theirs ' + k; }
  m.splice(20000, 0, 'inserted mine');
  t.splice(30000, 5);
  var t0 = Date.now();
  var r = M.merge3(base, m.join('\n'), t.join('\n'));
  var ms = Date.now() - t0;
  assert.strictEqual(r.conflicts, 0);
  assert.ok(ms < 1500, 'merge took ' + ms + 'ms');
  // a wholesale rewrite (no anchors) stays bounded too
  var rw = lines.map(function (s) { return s + '!'; });
  t0 = Date.now();
  var r2 = M.merge3(base, rw.join('\n'), base.replace('line 5 ', 'line five '));
  assert.ok(Date.now() - t0 < 3000, 'rewrite took ' + (Date.now() - t0) + 'ms');
  assert.strictEqual(r2.conflicts, 1);
  // repetitive lines (no unique anchors at all) fall back to Myers
  var rep = []; for (var j = 0; j < 20000; j++) rep.push(j % 2 ? '}' : '');
  var rm = rep.slice(); rm[100] = 'x'; var rt = rep.slice(); rt[15000] = 'y';
  t0 = Date.now();
  var r3 = M.merge3(rep.join('\n'), rm.join('\n'), rt.join('\n'));
  assert.ok(Date.now() - t0 < 2000, 'repetitive took ' + (Date.now() - t0) + 'ms');
  assert.strictEqual(r3.conflicts, 0);
  var exp = rep.slice(); exp[100] = 'x'; exp[15000] = 'y';
  assert.strictEqual(r3.merged, exp.join('\n'));
});

test('strip() keeps a result usable after a worker round trip', function () {
  var r = M.merge3(BASE, BASE.replace('milk', 'm'), BASE.replace('milk', 'n'));
  M.alignChunk(conflictsOf(r)[0]);
  var w = JSON.parse(JSON.stringify(M.strip(r)));
  assert.strictEqual(w.conflicts, 1);
  var o = {}; o[conflictsOf(w)[0].id] = { pick: 'theirs' };
  assert.strictEqual(M.applyChoices(w, o), BASE.replace('milk', 'n'));
});

console.log('merge: ' + passed + ' passed');
