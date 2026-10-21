/* Checks for Dangerous Mode: settings, word counting (against the app's own
 * footer counter), the incremental recount, how the session region follows
 * edits, the session state machine and timer, the fade curve, the banner
 * texts and the widget registration. Not loaded by the app.
 * Run: node txt/widgets/danger/danger.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var D = require('./danger-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// The manifest entry this module needs (txt/manifest.json doesn't list it yet).
var MANIFEST = {
  id: 'danger', type: 'widget', name: 'Dangerous Mode',
  description: 'Keep writing or lose it — set a word or time goal; stop typing for a few seconds and this session’s words start being removed from the end until you type again. Reach the goal to keep them',
  icon: '☠',
  tags: 'dangerous,danger,dangerous mode,writing,write,first draft,draft,sprint,word goal,word count,focus,flow,timer,deadline,hardcore,most dangerous writing app,productivity',
  entry: 'widgets/danger/danger.js', css: 'widgets/danger/danger.css'
};

// ---- a tiny change set with CodeMirror's mapping rules ----
// changes: [{ from, to, insert }] in old-document positions, sorted, not overlapping.
function change(doc, changes) {
  var out = '', at = 0, list = [], sections = [], posB = 0;
  changes.forEach(function (c) {
    if (c.from > at) { sections.push(c.from - at, -1); out += doc.slice(at, c.from); posB += c.from - at; }
    sections.push(c.to - c.from, c.insert.length);
    list.push({ fromA: c.from, toA: c.to, fromB: posB, toB: posB + c.insert.length });
    out += c.insert; posB += c.insert.length; at = c.to;
  });
  if (at < doc.length) sections.push(doc.length - at, -1);
  out += doc.slice(at);
  function mapPos(pos, assoc) {     // ChangeSet.mapPos, MapMode.Simple
    var posA = 0, pb = 0;
    for (var i = 0; i < sections.length;) {
      var len = sections[i++], ins = sections[i++], endA = posA + len;
      if (ins < 0) { if (endA > pos) return pb + (pos - posA); pb += len; }
      else {
        if (endA > pos || (endA === pos && assoc < 0 && !len)) return pos === posA || assoc < 0 ? pb : pb + ins;
        pb += ins;
      }
      posA = endA;
    }
    return pb;
  }
  return { doc: out, changes: list, mapPos: mapPos };
}
// one transaction through the area, the pieces and the word count
function step(doc, r, words, changes, kind) {
  var c = change(doc, changes);
  var m = D.mapRegion(r, c.changes, c.mapPos, kind);
  m.pieces = D.mapPieces(r.pieces || [], c.changes, c.mapPos, kind, m);
  var w = m.moved ? D.countWords(c.doc.slice(m.from, m.to)) : D.recount({
    words: words, oldR: r, newR: m, changes: c.changes,
    oldSlice: function (f, t) { return doc.slice(f, t); }, newSlice: function (f, t) { return c.doc.slice(f, t); },
    count: function (f, t) { return D.countWords(c.doc.slice(f, t)); }
  });
  return { doc: c.doc, r: m, words: w };
}
function area(s) { return s.doc.slice(s.r.from, s.r.to); }
function typed(s) { return s.r.pieces.map(function (p) { return s.doc.slice(p[0], p[1]); }).join('|'); }
function rnd(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ================= settings =================
test('validate: defaults, kinds, clamping, junk', function () {
  assert.deepStrictEqual(D.validate(), { kind: 'words', words: 250, minutes: 5, grace: 5, hardcore: false });
  assert.deepStrictEqual(D.validate({ kind: 'time', minutes: '10', grace: 8, hardcore: true }), { kind: 'time', words: 250, minutes: 10, grace: 8, hardcore: true });
  var v = D.validate({ kind: 'nope', words: 3, minutes: 9999, grace: 0.2, hardcore: 'yes' });
  assert.strictEqual(v.kind, 'words'); assert.strictEqual(v.words, 10); assert.strictEqual(v.minutes, 180); assert.strictEqual(v.grace, 1); assert.strictEqual(v.hardcore, false);
  assert.strictEqual(D.validate({ words: 'abc', grace: NaN }).words, 250);
  assert.strictEqual(D.validate({ words: '', grace: '' }).grace, 5);
  assert.strictEqual(D.validate({ words: 30.6, grace: 1.54 }).words, 31);
  assert.strictEqual(D.validate({ grace: 1.54 }).grace, 1.5);
  assert.strictEqual(D.validate(null).kind, 'words');
});
test('custom goals typed by hand', function () {
  assert.strictEqual(D.checkCustom('words', '300'), '');
  assert.strictEqual(D.checkCustom('words', '5'), 'At least 10 words');
  assert.strictEqual(D.checkCustom('words', '20000'), 'At most 10,000 words');
  assert.strictEqual(D.checkCustom('time', '0'), 'At least 1 minute');
  assert.strictEqual(D.checkCustom('time', 'x'), 'Enter a number of minutes');
  assert.strictEqual(D.checkCustom('time', '45'), '');
});
test('the plain-language summary', function () {
  assert.strictEqual(D.summary(D.validate({ words: 250, grace: 5 })), 'Stop typing for 5 s and the words you wrote this session start being removed from the end, faster and faster, until you type again. Reach 250 words to keep them.');
  assert.strictEqual(D.summary(D.validate({ kind: 'time', minutes: 1, grace: 3 })), 'Stop typing for 3 s and the words you wrote this session start being removed from the end, faster and faster, until you type again. Keep going for 1 minute to keep them.');
  assert.ok(/Ctrl\+Z/.test(D.modeNote(D.validate({}))));
  assert.ok(/can’t be undone/.test(D.modeNote(D.validate({ hardcore: true }))));
  assert.deepStrictEqual(D.goalOf(D.validate({ kind: 'time', minutes: 3 })), { kind: 'time', target: 180000 });
});

// ================= words =================
test('word count = the app footer’s countWords (taken from txt.html)', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'txt.html'), 'utf8');
  var m = /\nfunction countWords\(s\) \{[\s\S]*?\n\}/.exec(html);
  assert.ok(m, 'footer countWords not found in txt.html');
  var footer = new Function(m[0] + '\nreturn countWords;')();
  var r = rnd(7), alpha = 'ab c\n\t\r\f-—é😀  . ';
  for (var k = 0; k < 400; k++) {
    var s = '', n = Math.floor(r() * 60);
    for (var i = 0; i < n; i++) s += alpha.charAt(Math.floor(r() * alpha.length));
    assert.strictEqual(D.countWords(s), footer(s), JSON.stringify(s));
    // counted in pieces (a CodeMirror iterator) it's the same
    var st = { n: 0, inWord: false }, cut = Math.floor(r() * s.length);
    D.countWords(s.slice(0, cut), st); D.countWords(s.slice(cut), st);
    assert.strictEqual(st.n, footer(s));
  }
  assert.strictEqual(D.countWords('  hello   world\n- item'), 4);
});
test('recount: the local window agrees with a full count (fuzz)', function () {
  var r = rnd(42), alpha = 'abc  \nde\tf';
  function str(n) { var s = ''; for (var i = 0; i < n; i++) s += alpha.charAt(Math.floor(r() * alpha.length)); return s; }
  for (var k = 0; k < 3000; k++) {
    var doc = str(Math.floor(r() * 40)), a = Math.floor(r() * (doc.length + 1)), b = a + Math.floor(r() * (doc.length - a + 1));
    var reg = { from: a, to: b, pieces: [] }, words = D.countWords(doc.slice(a, b));
    var nCh = 1 + Math.floor(r() * 2), pts = [];
    for (var i = 0; i < nCh * 2; i++) pts.push(Math.floor(r() * (doc.length + 1)));
    pts.sort(function (x, y) { return x - y; });
    var chs = [];
    for (i = 0; i < pts.length; i += 2) {
      var f = pts[i], t = r() < 0.5 ? f : pts[i + 1];
      if (chs.length && f < chs[chs.length - 1].to) continue;
      chs.push({ from: f, to: t, insert: r() < 0.25 ? '' : str(1 + Math.floor(r() * 6)) });
    }
    chs = chs.filter(function (c) { return c.to > c.from || c.insert; });
    if (!chs.length) continue;
    var kind = ['typing', 'history', 'foreign'][Math.floor(r() * 3)];
    var res = step(doc, reg, words, chs, kind);
    assert.strictEqual(res.words, D.countWords(res.doc.slice(res.r.from, res.r.to)), JSON.stringify({ doc: doc, reg: reg, chs: chs, kind: kind }));
  }
});
test('recount: typing in a long region reads only around the change', function () {
  var body = new Array(2000).join('word ') + 'end', reads = 0;
  var doc = 'x\n' + body, reg = { from: 2, to: doc.length };
  var c = change(doc, [{ from: 500, to: 500, insert: 'more ' }]);
  var m = D.mapRegion(reg, c.changes, c.mapPos, 'typing');
  var w = D.recount({
    words: D.countWords(body), oldR: reg, newR: m, changes: c.changes,
    oldSlice: function (f, t) { reads += t - f; return doc.slice(f, t); }, newSlice: function (f, t) { reads += t - f; return c.doc.slice(f, t); },
    count: function () { throw new Error('full recount'); }
  });
  assert.strictEqual(w, D.countWords(body) + 1);
  assert.ok(reads < 600, 'read ' + reads + ' chars');
});

// ================= the region =================
test('classify: whose edit was it', function () {
  assert.strictEqual(D.classify('input.type', false, false), 'typing');
  assert.strictEqual(D.classify('input.paste', false, false), 'typing');
  assert.strictEqual(D.classify('delete.backward', false, false), 'typing');
  assert.strictEqual(D.classify('input', false, false), 'typing');
  assert.strictEqual(D.classify('undo', false, true), 'history');
  assert.strictEqual(D.classify('redo', false, false), 'history');
  assert.strictEqual(D.classify('move.drop', false, true), 'history', 'a drag inside the note: yours, but not typed');
  assert.strictEqual(D.classify(null, false, true), 'typing', 'list Enter / toolbar right after a key or tap');
  assert.strictEqual(D.classify(null, false, false), 'foreign', 'sync, other devices');
  assert.strictEqual(D.classify('input.type', true, true), 'foreign', 'a remote write is never yours');
  assert.strictEqual(D.classify('inputx', false, false), 'foreign');
  assert.strictEqual(D.classify(D.REMOVE_EVENT, false, true), 'remove', 'the session taking a word: never your typing');
  assert.ok(!/^(input\.type|delete)($|\.)/.test(D.REMOVE_EVENT), 'CodeMirror keeps each removal its own undo step');
});
test('a removal shrinks the area and pieces like any delete, and is no conflict', function () {
  var s = step('x\none two', { from: 2, to: 9, pieces: [[2, 9]] }, 2, [{ from: 6, to: 9, insert: '' }], 'remove');
  assert.strictEqual(area(s), 'one '); assert.strictEqual(typed(s), 'one '); assert.strictEqual(s.words, 1); assert.ok(!s.r.conflict);
});
test('removeRange: the last word goes first, with what follows it; the last one takes the rest', function () {
  function rr(doc, pieces) { var r = D.removeRange(pieces, function (f, t) { return doc.slice(f, t); }); return r && { text: r.ranges.map(function (p) { return doc.slice(p[0], p[1]); }), last: r.last }; }
  var doc = 'Before.\nThe quick fox \n';
  assert.deepStrictEqual(rr(doc, [[8, doc.length]]), { text: ['fox \n'], last: false });
  assert.deepStrictEqual(rr(doc, [[8, 18]]), { text: ['quick '], last: false });
  assert.deepStrictEqual(rr(doc, [[8, 12]]), { text: ['The '], last: true }, 'the only word left takes everything');
  assert.deepStrictEqual(rr('\n  word', [[0, 7]]), { text: ['\n  word'], last: true }, 'whitespace before the last word goes with it');
  assert.strictEqual(rr(doc, []), null);
  assert.deepStrictEqual(rr('a  \n ', [[1, 5]]), { text: ['  \n '], last: true }, 'only whitespace left: the final step');
  // pieces split by text an undo brought back (not yours): only pieces go
  var d2 = 'aa bb RESTORED cc dd';
  assert.deepStrictEqual(rr(d2, [[0, 6], [14, 20]]), { text: ['dd'], last: false });
  assert.deepStrictEqual(rr(d2, [[0, 6], [14, 17]]), { text: ['cc'], last: false });
  assert.deepStrictEqual(rr(d2, [[0, 6], [14, 15]]), { text: ['bb ', ' '], last: false }, 'a whitespace-only piece goes with the word before it');
  assert.deepStrictEqual(rr(d2, [[0, 3]]), { text: ['aa '], last: true });
  // removing again and again empties the pieces, word by word, never touching anything else
  var doc3 = 'KEEP ME.\nOne two three four.', pieces = [[9, doc3.length]], steps = 0, r;
  while ((r = D.removeRange(pieces, function (f, t) { return doc3.slice(f, t); }))) {
    steps++;
    var c = change(doc3, r.ranges.map(function (p) { return { from: p[0], to: p[1], insert: '' }; }));
    pieces = D.mapPieces(pieces, c.changes, c.mapPos, 'remove', { from: 0, to: c.doc.length });
    doc3 = c.doc;
    if (r.last) break;
  }
  assert.strictEqual(steps, 4); assert.strictEqual(doc3, 'KEEP ME.\n'); assert.deepStrictEqual(pieces, []);
});
test('the pace: 700 ms, then ×0.85 per word, never under 120 ms', function () {
  assert.strictEqual(D.removeGap(0), 700); assert.strictEqual(D.removeGap(1), 595); assert.strictEqual(D.removeGap(2), 506);
  assert.strictEqual(D.removeGap(40), 120);
  for (var i = 1; i < 30; i++) assert.ok(D.removeGap(i) <= D.removeGap(i - 1));
});
test('typing grows the area at either end; typing elsewhere does not count', function () {
  var doc = 'before\n', r = { from: 7, to: 7, pieces: [] }, s;
  s = step(doc, r, 0, [{ from: 7, to: 7, insert: 'Hello' }], 'typing');
  assert.deepStrictEqual([s.r.from, s.r.to, s.words, typed(s)], [7, 12, 1, 'Hello']);
  s = step(s.doc, s.r, s.words, [{ from: 12, to: 12, insert: ' world' }], 'typing');
  assert.deepStrictEqual([s.r.from, s.r.to, s.words, typed(s)], [7, 18, 2, 'Hello world']);
  s = step(s.doc, s.r, s.words, [{ from: 7, to: 7, insert: 'Oh ' }], 'typing');
  assert.strictEqual(area(s), 'Oh Hello world'); assert.strictEqual(typed(s), 'Oh Hello world');
  s = step(s.doc, s.r, s.words, [{ from: 0, to: 0, insert: 'top ' }], 'typing');   // outside
  assert.strictEqual(area(s), 'Oh Hello world'); assert.strictEqual(typed(s), 'Oh Hello world');
  assert.strictEqual(s.words, 3);
  s = step(s.doc, s.r, s.words, [{ from: s.r.to - 5, to: s.r.to, insert: '' }], 'typing'); // backspace a word
  assert.strictEqual(area(s), 'Oh Hello '); assert.strictEqual(s.words, 2);
  // typing over a selection that reaches outside: the typed text is yours, the rest is gone anyway
  s = step('ab\nmine', { from: 3, to: 7, pieces: [[3, 7]] }, 1, [{ from: 1, to: 4, insert: 'Z' }], 'typing');
  assert.strictEqual(area(s), 'Zine'); assert.strictEqual(typed(s), 'Zine');
});
test('nothing written yet: the session starts where typing happens', function () {
  var s = step('abc\n\nxyz', { from: 4, to: 4, pieces: [] }, 0, [{ from: 8, to: 8, insert: ' more' }], 'typing');
  assert.ok(s.r.moved);
  assert.strictEqual(area(s), ' more'); assert.strictEqual(typed(s), ' more');
  assert.strictEqual(s.words, 1);
  var d = step('abc\n\nxyz', { from: 4, to: 4, pieces: [] }, 0, [{ from: 8, to: 9, insert: '' }], 'typing');
  assert.deepStrictEqual([d.r.from, d.r.to, d.r.moved], [4, 4, false], 'a plain delete does not move it');
});
test('undo / redo: what they bring back counts, but is never a typed piece', function () {
  // Backspace "two" a key at a time, then one undo puts it back at the end
  var s = step('x\n', { from: 2, to: 2, pieces: [] }, 0, [{ from: 2, to: 2, insert: 'one two' }], 'typing'), d = s;
  for (var i = 0; i < 3; i++) d = step(d.doc, d.r, d.words, [{ from: d.r.to - 1, to: d.r.to, insert: '' }], 'typing');
  var u = step(d.doc, d.r, d.words, [{ from: d.r.to, to: d.r.to, insert: 'two' }], 'history');
  assert.strictEqual(area(u), 'one two'); assert.strictEqual(u.words, 2);
  assert.strictEqual(typed(u), 'one ', 'not wiped: an undo could as well bring back older text');
  // and typing on at the caret (after it) still belongs to the session
  var t = step(u.doc, u.r, u.words, [{ from: u.r.to, to: u.r.to, insert: ' three' }], 'typing');
  assert.strictEqual(area(t), 'one two three'); assert.strictEqual(t.words, 3);
  assert.strictEqual(typed(t), 'one | three');
  // you deleted "old\n" just above the session, then undid it
  var o = step('x\nsession', { from: 2, to: 9, pieces: [[2, 9]] }, 1, [{ from: 2, to: 2, insert: 'old\n' }], 'history');
  assert.strictEqual(typed(o), 'session');
  // an undo inside a piece is cut out of it
  var c = step('ab cd', { from: 0, to: 5, pieces: [[0, 5]] }, 2, [{ from: 3, to: 3, insert: 'xx ' }], 'history');
  assert.strictEqual(area(c), 'ab xx cd'); assert.strictEqual(c.words, 3); assert.strictEqual(typed(c), 'ab |cd');
});
test('an undo replacing at the edge never makes outside text a piece', function () {
  // Backspace into the line above, type straight away (one undo event in
  // CodeMirror), then undo: the newline comes back as a replacement.
  var s = step('above\nmine', { from: 6, to: 10, pieces: [[6, 10]] }, 1, [{ from: 5, to: 6, insert: '' }], 'typing');
  s = step(s.doc, s.r, s.words, [{ from: 5, to: 5, insert: 'X' }], 'typing');
  assert.strictEqual(typed(s), 'Xmine');
  var u = step(s.doc, s.r, s.words, [{ from: 5, to: 6, insert: '\n' }], 'history');
  assert.strictEqual(u.doc, 'above\nmine');
  assert.strictEqual(typed(u), 'mine');
});
test('changes from elsewhere: kept out, and editing the inside is a conflict', function () {
  var doc = 'pre|mine|post', r = { from: 4, to: 8, pieces: [[4, 8]] };
  var s = step(doc, r, 1, [{ from: 4, to: 4, insert: 'R' }], 'foreign');
  assert.strictEqual(area(s), 'mine'); assert.strictEqual(typed(s), 'mine'); assert.ok(!s.r.conflict);
  s = step(doc, r, 1, [{ from: 8, to: 8, insert: 'R' }], 'foreign');
  assert.strictEqual(area(s), 'mine'); assert.ok(!s.r.conflict);
  s = step(doc, r, 1, [{ from: 0, to: 3, insert: 'PRE' }], 'foreign');
  assert.strictEqual(area(s), 'mine'); assert.ok(!s.r.conflict);
  s = step(doc, r, 1, [{ from: 6, to: 6, insert: 'R' }], 'foreign');
  assert.ok(s.r.conflict, 'insert inside'); assert.strictEqual(typed(s), 'mi|ne', 'and it is never a piece');
  assert.ok(step(doc, r, 1, [{ from: 7, to: 9, insert: '' }], 'foreign').r.conflict, 'delete across the end');
  var all = step(doc, r, 1, [{ from: 0, to: doc.length, insert: 'all new' }], 'foreign');
  assert.ok(all.r.conflict, 'whole note replaced'); assert.strictEqual(typed(all), '');
  assert.ok(!step(doc, { from: 4, to: 4, pieces: [] }, 0, [{ from: 0, to: doc.length, insert: 'x' }], 'foreign').r.conflict, 'nothing written: nothing to protect');
});
test('only text typed this session is ever in a piece (fuzz with undo / redo / sync)', function () {
  // Every character is tagged with who wrote it: o = there before, T = typed
  // this session, f = from elsewhere. Undo / redo put back exactly what they
  // took, tags included (a LIFO history; one event per edit, or a Backspace
  // run / delete-then-type joined into one, as CodeMirror does).
  var r = rnd(99), runs = 800, steps = 50, checks = 0;
  function rep(ch, n) { return new Array(n + 1).join(ch); }
  for (var run = 0; run < runs; run++) {
    var doc = 'Some text here.\nMore.\n', own = rep('o', doc.length);
    var st = { doc: doc, r: { from: doc.length, to: doc.length, pieces: [] }, words: 0 }, done = [], undone = [];
    for (var k = 0; k < steps; k++) {
      var roll = r(), kind, ch, tags, join = false;
      if (roll < 0.16 && done.length) { kind = 'history'; var ev = done.pop(); ch = ev.inv; tags = ev.tags; ev.side = 'u'; }
      else if (roll < 0.22 && undone.length) { kind = 'history'; var ev2 = undone.pop(); ch = ev2.inv; tags = ev2.tags; ev2.side = 'd'; }
      else {
        kind = roll < 0.3 ? 'foreign' : 'typing';
        var near = [st.r.from, st.r.to, Math.floor(r() * (st.doc.length + 1))][Math.floor(r() * 3)];
        var f = Math.max(0, Math.min(st.doc.length, near + Math.floor(r() * 5) - 2));
        var t = r() < 0.55 ? f : Math.min(st.doc.length, f + 1 + Math.floor(r() * 4));
        var ins = r() < 0.3 ? '' : ['a', 'bc', ' ', '\n', 'de f'][Math.floor(r() * 5)];
        if (t === f && !ins) continue;
        ch = { from: f, to: t, insert: ins }; tags = rep(kind === 'typing' ? 'T' : 'f', ins.length);
        if (kind === 'foreign') { done = []; undone = []; } else { undone = []; join = r() < 0.4; }
      }
      if (ch.to > st.doc.length) { done = []; undone = []; continue; }
      var removed = { text: st.doc.slice(ch.from, ch.to), tags: own.slice(ch.from, ch.to) };
      var next = step(st.doc, st.r, st.words, [ch], kind);
      var nown = own.slice(0, ch.from) + tags + own.slice(ch.to);
      var inv = { inv: { from: ch.from, to: ch.from + ch.insert.length, insert: removed.text }, tags: removed.tags };
      if (kind === 'typing') {
        // join with the previous event when it ends where this one starts (the inverse of both, composed)
        var last = done[done.length - 1];
        if (join && last && last.inv.from === last.inv.to && last.inv.from === ch.from && ch.to === ch.from) {
          done[done.length - 1] = { inv: { from: ch.from, to: ch.from + ch.insert.length, insert: last.inv.insert }, tags: last.tags };
        } else if (join && last && last.inv.from === last.inv.to && ch.insert === '' && ch.to === last.inv.from) {
          done[done.length - 1] = { inv: { from: ch.from, to: ch.from, insert: removed.text + last.inv.insert }, tags: removed.tags + last.tags };
        } else done.push(inv);
      } else if (kind === 'history') (ev && ev.side === 'u' ? undone : done).push(inv);
      ev = null;
      if (next.r.conflict) break;           // the UI ends the session here, keeping everything
      st = next; own = nown;
      assert.strictEqual(own.length, st.doc.length);
      st.r.pieces.forEach(function (p) {
        assert.ok(/^T+$/.test(own.slice(p[0], p[1])), 'not typed this session, in a piece: ' + JSON.stringify({ doc: st.doc, own: own, pieces: st.r.pieces, last: ch, kind: kind }));
        assert.ok(p[0] >= st.r.from && p[1] <= st.r.to, 'piece outside the area');
      });
      assert.strictEqual(st.words, D.countWords(st.doc.slice(st.r.from, st.r.to)));
      checks++;
    }
  }
  assert.ok(checks > runs * 10, 'enough steps ran: ' + checks);
});

// ================= the session =================
var T0 = 1000000;
function S(set) { return D.create(set || { words: 30, grace: 1.5 }, T0); }
test('armed → typing → fading → removing word by word → wiped, on the clock', function () {
  var s = S();
  assert.strictEqual(s.phase, 'armed'); assert.strictEqual(D.nextAt(s, T0), null, 'no clock before the first word');
  s = D.reduce(s, { type: 'tick', now: T0 + 60000 });
  assert.strictEqual(s.phase, 'armed', 'waiting forever is fine');
  s = D.reduce(s, { type: 'input', now: T0 + 100, words: 3 });
  assert.strictEqual(s.phase, 'typing');
  assert.strictEqual(D.nextAt(s, T0 + 100), T0 + 100 + 600, 'wakes when the fade starts (40% of 1.5 s)');
  s = D.reduce(s, { type: 'tick', now: T0 + 700 });
  assert.strictEqual(s.phase, 'fading');
  assert.strictEqual(D.nextAt(s, T0 + 700), T0 + 1600, 'then when the grace runs out');
  s = D.reduce(s, { type: 'input', now: T0 + 1500, words: 3 });   // just in time
  s = D.reduce(s, { type: 'tick', now: T0 + 3000 });
  assert.strictEqual(s.phase, 'removing'); assert.strictEqual(s.removeAt, T0 + 3000 + 700, 'the first word goes 700 ms later (marked meanwhile)');
  assert.strictEqual(D.nextAt(s, T0 + 3000), T0 + 3700);
  assert.ok(/removing your words — type to stop it/.test(D.hintText(s)));
  s = D.reduce(s, { type: 'tick', now: T0 + 3500 });
  assert.strictEqual(s.phase, 'removing', 'ticks don\'t remove — the UI does and says so');
  s = D.reduce(s, { type: 'removed', now: T0 + 3700, words: 2, left: true });
  assert.deepStrictEqual([s.phase, s.words, s.removed, s.removeAt], ['removing', 2, 1, T0 + 3700 + 595]);
  s = D.reduce(s, { type: 'removed', now: T0 + 4295, words: 1, left: true });
  assert.strictEqual(s.removeAt, T0 + 4295 + 506, 'faster and faster');
  s = D.reduce(s, { type: 'removed', now: T0 + 4801, words: 0, left: false });
  assert.strictEqual(s.phase, 'wiped'); assert.strictEqual(s.reason, 'removed'); assert.strictEqual(s.removed, 3);
  assert.strictEqual(D.reduce(s, { type: 'input', now: T0 + 5000, words: 3 }), s, 'over is over');
});
test('typing while words go stops it and keeps the rest', function () {
  var s = D.reduce(S(), { type: 'input', now: T0, words: 5 });
  s = D.reduce(s, { type: 'tick', now: T0 + 1500 });
  s = D.reduce(s, { type: 'removed', now: T0 + 2200, words: 4, left: true });
  s = D.reduce(s, { type: 'input', now: T0 + 2400, words: 5 });
  assert.deepStrictEqual([s.phase, s.removeAt, s.bout, s.removed, s.words], ['typing', null, 0, 1, 5]);
  assert.strictEqual(D.nextAt(s, T0 + 2400), T0 + 2400 + 600, 'the clock starts over, crisp');
  // a timer report that arrives after the rescue changes nothing
  assert.strictEqual(D.reduce(s, { type: 'removed', now: T0 + 2500, words: 3, left: true }).words, 5);
  // an edit after the grace but before the first word went: nothing lost
  var t = D.reduce(D.reduce(S(), { type: 'input', now: T0, words: 2 }), { type: 'input', now: T0 + 1800, words: 3 });
  assert.strictEqual(t.phase, 'typing'); assert.strictEqual(t.removed, 0);
});
test('a late timer catches up on schedule (hardcore away)', function () {
  var s = D.reduce(S({ words: 100, grace: 1.5, hardcore: true }), { type: 'input', now: T0, words: 9 });
  s = D.reduce(s, { type: 'show', now: T0 + 10000 });
  assert.strictEqual(s.phase, 'removing'); assert.strictEqual(s.removeAt, T0 + 2200);
  var n = 0;
  while (s.phase === 'removing' && s.removeAt <= T0 + 10000) { s = D.reduce(s, { type: 'removed', now: T0 + 10000, words: 9 - ++n, left: n < 9 }); }
  assert.strictEqual(n, 9, 'everything due by now goes at once'); assert.strictEqual(s.phase, 'wiped');
});
test('word goal reached → kept', function () {
  var s = D.reduce(S(), { type: 'input', now: T0, words: 29 });
  assert.strictEqual(s.phase, 'typing');
  s = D.reduce(s, { type: 'input', now: T0 + 200, words: 30 });
  assert.strictEqual(s.phase, 'kept'); assert.strictEqual(s.reason, 'goal');
  assert.strictEqual(D.keptText(s), '✓ Kept — 30 words');
  // words arriving without typing (an undo) can reach it too
  var u = D.reduce(D.reduce(S(), { type: 'input', now: T0, words: 10 }), { type: 'words', now: T0 + 10, words: 31 });
  assert.strictEqual(u.phase, 'kept');
});
test('time goal: counts from the first word, countdown ticks, kept at the end', function () {
  var s = D.create({ kind: 'time', minutes: 1, grace: 5 }, T0);
  assert.strictEqual(D.progressText(s, T0), '1:00 left · 0 words');
  s = D.reduce(s, { type: 'input', now: T0 + 1000, words: 1 });
  assert.strictEqual(D.progressText(s, T0 + 1000), '1:00 left · 1 word');
  assert.strictEqual(D.nextAt(s, T0 + 1000, true), T0 + 2000, 'next countdown second');
  assert.strictEqual(D.nextAt(s, T0 + 1250, true), T0 + 2000);
  assert.strictEqual(D.nextAt(s, T0 + 1250, false), T0 + 1000 + 2000, 'hidden: only real deadlines');
  for (var t = 1000; t <= 57000; t += 4000) s = D.reduce(s, { type: 'input', now: T0 + t, words: t / 1000 });
  assert.strictEqual(D.progressText(s, T0 + 58000), '0:03 left · 57 words');
  s = D.reduce(s, { type: 'tick', now: T0 + 61000 });
  assert.strictEqual(s.phase, 'kept');
  assert.strictEqual(D.elapsedMs(s, T0 + 99999), 60000);
  assert.strictEqual(D.keptText(s), '✓ Kept — 1 minute · 57 words');
});
test('time goal vs. the grace: whichever comes first; reached while removing keeps the rest', function () {
  var s = D.reduce(D.create({ kind: 'time', minutes: 1, grace: 5 }, T0), { type: 'input', now: T0, words: 1 });
  for (var t = 4000; t <= 57000; t += 4000) s = D.reduce(s, { type: 'input', now: T0 + t, words: 2 });
  s = D.reduce(s, { type: 'input', now: T0 + 57000, words: 2 });   // goal at +60000, wipe at +62000
  assert.strictEqual(s.phase, 'typing');
  assert.strictEqual(D.reduce(s, { type: 'tick', now: T0 + 70000 }).phase, 'kept');
  var w = D.reduce(D.create({ kind: 'time', minutes: 1, grace: 5 }, T0), { type: 'input', now: T0, words: 1 });
  assert.strictEqual(D.reduce(w, { type: 'tick', now: T0 + 6000 }).phase, 'removing');
  for (t = 4000; t <= 52000; t += 4000) w = D.reduce(w, { type: 'input', now: T0 + t, words: 9 });
  w = D.reduce(w, { type: 'tick', now: T0 + 59000 });
  assert.strictEqual(w.phase, 'removing');
  w = D.reduce(w, { type: 'removed', now: T0 + 59300, words: 8, left: true });
  w = D.reduce(w, { type: 'tick', now: T0 + 60000 });
  assert.strictEqual(w.phase, 'kept'); assert.strictEqual(D.keptText(w), '✓ Kept — 1 minute · 8 words');
  assert.strictEqual(D.nextAt(D.reduce(w, { type: 'tick', now: T0 + 60000 }), T0 + 60000), null);
});
test('normal mode: hidden while words go pauses it; hardcore keeps going', function () {
  var s = D.reduce(S(), { type: 'input', now: T0, words: 4 });
  s = D.reduce(s, { type: 'tick', now: T0 + 1600 });
  s = D.reduce(s, { type: 'hide', now: T0 + 1700 });
  assert.deepStrictEqual([s.phase, s.paused, s.removeAt, D.nextAt(s, T0 + 1700)], ['armed', true, null, null]);
  var h = D.reduce(D.reduce(S({ words: 30, grace: 1.5, hardcore: true }), { type: 'input', now: T0, words: 4 }), { type: 'tick', now: T0 + 1600 });
  h = D.reduce(h, { type: 'hide', now: T0 + 1700 });
  assert.strictEqual(h.phase, 'removing'); assert.strictEqual(D.nextAt(h, T0 + 1700), T0 + 2200);
});
test('normal mode: hiding the page pauses until the next edit; time does not count meanwhile', function () {
  var s = D.reduce(D.create({ kind: 'time', minutes: 1, grace: 3 }, T0), { type: 'input', now: T0, words: 1 });
  s = D.reduce(s, { type: 'hide', now: T0 + 2000 });
  assert.strictEqual(s.phase, 'armed'); assert.ok(s.paused); assert.strictEqual(D.nextAt(s, T0 + 2000), null);
  s = D.reduce(s, { type: 'show', now: T0 + 600000 });
  assert.strictEqual(s.phase, 'armed', 'still waiting');
  assert.ok(/Paused while you were away/.test(D.hintText(s)));
  assert.strictEqual(D.elapsedMs(s, T0 + 600000), 2000);
  s = D.reduce(s, { type: 'input', now: T0 + 600000, words: 2 });
  assert.strictEqual(s.phase, 'typing'); assert.ok(!s.paused);
  assert.strictEqual(D.elapsedMs(s, T0 + 601000), 3000);
});
test('hardcore: no pause — coming back after the grace, it is removing', function () {
  var s = D.reduce(D.create({ words: 100, grace: 5, hardcore: true }, T0), { type: 'input', now: T0, words: 3 });
  s = D.reduce(s, { type: 'hide', now: T0 + 1000 });
  assert.strictEqual(s.phase, 'typing'); assert.ok(!s.paused);
  assert.strictEqual(D.nextAt(s, T0 + 1000), T0 + 2000, 'still timing while away');
  s = D.reduce(s, { type: 'show', now: T0 + 30000 });
  assert.strictEqual(s.phase, 'removing'); assert.strictEqual(s.removeAt, T0 + 5700, 'the words went on schedule');
});
test('Stop keeps it, also while words are going', function () {
  var s = D.reduce(S(), { type: 'input', now: T0, words: 5 });
  var st = D.reduce(s, { type: 'stop', now: T0 + 500 });
  assert.strictEqual(st.phase, 'stopped'); assert.strictEqual(st.reason, 'user');
  assert.strictEqual(D.reduce(s, { type: 'stop', now: T0 + 500, reason: 'room' }).reason, 'room');
  assert.strictEqual(D.reduce(s, { type: 'stop', now: T0 + 9000 }).phase, 'stopped');
  assert.strictEqual(D.reduce(S(), { type: 'stop', now: T0 }).phase, 'stopped', 'before the first word');
});
test('reduce never mutates the state it is given', function () {
  var s = D.reduce(S(), { type: 'input', now: T0, words: 1 }), snap = JSON.stringify(s);
  D.reduce(s, { type: 'input', now: T0 + 10, words: 2 }); D.reduce(s, { type: 'hide', now: T0 + 20 }); D.reduce(s, { type: 'tick', now: T0 + 99999 });
  assert.strictEqual(JSON.stringify(s), snap);
});
test('fade curve: crisp, then down to 0.15 at the grace', function () {
  assert.strictEqual(D.fadeLevel(0, 5), 1);
  assert.strictEqual(D.fadeLevel(2000, 5), 1);
  assert.ok(Math.abs(D.fadeLevel(3500, 5) - 0.575) < 1e-9);
  assert.strictEqual(D.fadeLevel(5000, 5), 0.15);
  assert.strictEqual(D.fadeLevel(99999, 5), 0.15);
  var prev = 2;
  for (var t = 0; t <= 5000; t += 100) { var f = D.fadeLevel(t, 5); assert.ok(f <= prev); prev = f; }
  assert.strictEqual(D.danger(2500, 5), 0.5); assert.strictEqual(D.danger(-1, 5), 0); assert.strictEqual(D.danger(1e9, 5), 1);
});
test('banner texts', function () {
  var s = D.create({ words: 250, grace: 5 }, T0);
  assert.strictEqual(D.hintText(s), 'Start typing — the clock starts with your first word');
  s = D.reduce(s, { type: 'input', now: T0, words: 142 });
  assert.strictEqual(D.progressText(s, T0), '142 / 250 words');
  assert.strictEqual(D.hintText(s), 'stop for 5 s and your words start going');
  assert.strictEqual(D.hintText(D.reduce(s, { type: 'tick', now: T0 + 2500 })), 'keep typing — it’s fading!');
  assert.strictEqual(D.goneText(s), 'Gone — every word removed. You paused for 5 s');
  assert.strictEqual(D.progressText(D.reduce(D.create({ words: 5000 }, T0), { type: 'input', now: T0, words: 1234 }), T0), '1,234 / 5,000 words');
  assert.strictEqual(D.fmtClock(61000), '1:01'); assert.strictEqual(D.fmtClock(0), '0:00'); assert.strictEqual(D.fmtClock(999), '0:01');
});

// ================= the module =================
test('nothing the user sees talks about eating', function () {
  var src = ['danger.js', 'danger-core.js', 'danger.css'].map(function (f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); }).join('\n');
  var strings = src.match(/'(?:[^'\\\n]|\\.)*'/g) || [];
  strings.forEach(function (q) { assert.ok(!/\beat(s|en|ing)?\b/i.test(q), 'user-facing text says eat: ' + q); });
  assert.ok(!/\beat(s|en|ing)?\b/i.test(MANIFEST.description));
});
test('the CSS has both copies of every restartable animation', function () {
  var css = fs.readFileSync(path.join(__dirname, 'danger.css'), 'utf8');
  ['dz-drain', 'dz-blink', 'dz-flash', 'dz-glow', 'dz-fade'].forEach(function (n) {
    assert.ok(css.indexOf('@keyframes ' + n + '-a') >= 0 && css.indexOf('@keyframes ' + n + '-b') >= 0, n);
  });
  assert.ok(/max-width: 600px/.test(css) && /font-size: 16px/.test(css), 'phone inputs are 16px');
});
test('widget registers as the manifest says', function () {
  var reg = null, css = [];
  var fake = {
    Cade: {
      baseURL: function () { return './txt/widgets/danger/'; }, loadCSS: function (c) { css.push(c); },
      registerWidget: function (o) { reg = o; }, registerPlugin: function () { throw new Error('no plugin before Start'); },
      escapeHtml: String
    },
    addEventListener: function () { throw new Error('no listeners before Start'); }
  };
  var doc = { addEventListener: function () { throw new Error('no listeners before Start'); } };
  new Function('window', 'document', 'setTimeout', 'setInterval', fs.readFileSync(path.join(__dirname, 'danger.js'), 'utf8'))(
    fake, doc, function () { throw new Error('no timers before Start'); }, function () { throw new Error('no timers'); });
  assert.ok(reg, 'registerWidget called');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], MANIFEST[k], k); });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['danger.css']);
  assert.strictEqual(MANIFEST.entry, 'widgets/danger/' + 'danger.js');
  assert.ok(fs.existsSync(path.join(__dirname, 'danger.css')) && fs.existsSync(path.join(__dirname, 'danger-core.js')));
  // when the manifest lists it, it must agree
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
  var m = man.filter(function (x) { return x.id === 'danger'; })[0];
  if (m) Object.keys(MANIFEST).forEach(function (k) { assert.strictEqual(m[k], MANIFEST[k], 'manifest ' + k); });
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'danger: ' + passed + ' passed');
