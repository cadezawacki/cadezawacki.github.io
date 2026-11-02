/* Unit tests for the Scratchpad's pure helpers (room names, diffs, Markdown
 * line styling, wrap toggling, sync decisions). Not loaded by the app.
 * Run: node txt/widgets/scratchpad/scratchpad.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./scratchpad.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function applyDiff(a, d) { return d ? a.slice(0, d.from) + d.insert + a.slice(d.to) : a; }

test('room names: trimmed, lower-case, internal / overlong rejected', function () {
  assert.strictEqual(C.normRoom('  Scratchpad '), 'scratchpad');
  assert.strictEqual(C.normRoom(''), '');
  assert.strictEqual(C.normRoom(null), '');
  assert.strictEqual(C.normRoom('__cade_blob_x'), '');
  assert.strictEqual(C.normRoom('x'.repeat(101)), '');
  assert.strictEqual(C.normRoom('x'.repeat(100)), 'x'.repeat(100));
  assert.strictEqual(C.DEFAULT_ROOM, 'scratchpad');
});

test('new scratch note names are dated and unique', function () {
  var d = new Date(2026, 10, 2, 9, 5);
  assert.strictEqual(C.newScratchName([], d), 'scratch-2026-11-02');
  assert.strictEqual(C.newScratchName(['scratch-2026-11-02'], d), 'scratch-2026-11-02-2');
  assert.strictEqual(C.newScratchName(['Scratch-2026-11-02', 'scratch-2026-11-02-2'], d), 'scratch-2026-11-02-3');
  assert.strictEqual(C.newScratchName(['notes'], new Date(2027, 0, 9)), 'scratch-2027-01-09');
  assert.strictEqual(C.normRoom(C.newScratchName([], d)), C.newScratchName([], d), 'a valid room name');
});

test('normText: CRLF / CR to LF', function () {
  assert.strictEqual(C.normText('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.strictEqual(C.normText(null), '');
});

test('diffRange is minimal and round-trips', function () {
  assert.strictEqual(C.diffRange('same', 'same'), null);
  assert.deepStrictEqual(C.diffRange('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' });
  assert.deepStrictEqual(C.diffRange('abc', ''), { from: 0, to: 3, insert: '' });
  assert.deepStrictEqual(C.diffRange('', 'xyz'), { from: 0, to: 0, insert: 'xyz' });
  assert.deepStrictEqual(C.diffRange('aaaa', 'aaa'), { from: 3, to: 4, insert: '' });
  var pairs = [['line1\nline2\nline3', 'line1\nLINE2\nline3'], ['x', 'y'], ['abcabc', 'abc'], ['', ''], ['tail', 'tail!'], ['!head', 'head']];
  pairs.forEach(function (p) { assert.strictEqual(applyDiff(p[0], C.diffRange(p[0], p[1])), p[1], JSON.stringify(p)); });
});

test('diffRange never splits a surrogate pair', function () {
  var a = 'x😀y', b = 'x😁y';     // 😀 → 😁 share the high surrogate
  var d = C.diffRange(a, b);
  assert.deepStrictEqual(d, { from: 1, to: 3, insert: '😁' });
  var a2 = '😀z', b2 = '😀';
  assert.strictEqual(applyDiff(a2, C.diffRange(a2, b2)), b2);
  var a3 = 'a😀', b3 = 'b😀';
  assert.deepStrictEqual(C.diffRange(a3, b3), { from: 0, to: 1, insert: 'b' });
  var a4 = '😀😀', b4 = '😀😁😀';
  var d4 = C.diffRange(a4, b4);
  assert.strictEqual(applyDiff(a4, d4), b4);
  [d4.from, d4.to].forEach(function (i) { var c = a4.charCodeAt(i); assert.ok(!(c >= 0xdc00 && c <= 0xdfff), 'cut lands on a pair boundary'); });
});

test('mdLine: headings, quote, rule, fences', function () {
  var h = C.mdLine('## Title', false);
  assert.strictEqual(h.line, 'cm-md-h2');
  assert.deepStrictEqual(h.marks[0], [0, 2, 'cm-md-hashes']);
  assert.strictEqual(C.mdLine('#### four', false).line, null, 'only h1-h3, like the editor');
  assert.strictEqual(C.mdLine('#nospace', false).line, null);
  assert.strictEqual(C.mdLine('> quoted', false).line, 'cm-md-quote');
  assert.strictEqual(C.mdLine('---', false).line, 'cm-md-hr');
  var open = C.mdLine('```js', false);
  assert.strictEqual(open.line, 'cm-md-fence'); assert.strictEqual(open.fence, true);
  var inside = C.mdLine('**not bold** `x`', true);
  assert.strictEqual(inside.line, 'cm-codeblock'); assert.strictEqual(inside.marks.length, 0); assert.strictEqual(inside.fence, true);
  var close = C.mdLine('```', true);
  assert.strictEqual(close.line, 'cm-md-fence'); assert.strictEqual(close.fence, false);
});

test('mdLine: inline code, bold, italic, strike (markers marked separately)', function () {
  var r = C.mdLine('a **b** *c* ~~d~~ `e*f*`', false);
  function has(s, e, cls) { return r.marks.some(function (m) { return m[0] === s && m[1] === e && m[2] === cls; }); }
  assert.ok(has(4, 5, 'cm-md-bold'), 'bold content');
  assert.ok(has(2, 4, 'cm-md-mark') && has(5, 7, 'cm-md-mark'), 'bold markers');
  assert.ok(has(9, 10, 'cm-md-italic'), 'italic content');
  assert.ok(has(14, 15, 'cm-md-strike'), 'strike content');
  assert.ok(has(18, 24, 'cm-md-code'), 'code span');
  assert.ok(!r.marks.some(function (m) { return m[2] === 'cm-md-italic' && m[0] > 18; }), 'no emphasis inside code');
  var snake = C.mdLine('my_var_name and _it_', false);
  var it = snake.marks.filter(function (m) { return m[2] === 'cm-md-italic'; });
  assert.strictEqual(it.length, 1, 'snake_case is not italic');
  assert.deepStrictEqual(it[0], [17, 19, 'cm-md-italic']);
  for (var i = 1; i < r.marks.length; i++) assert.ok(r.marks[i - 1][0] <= r.marks[i][0], 'sorted');
});

test('toggleWrap wraps, unwraps around and inside the selection', function () {
  function run(text, from, to, mark) {
    var r = C.toggleWrap(text, from, to, mark), out = text;
    r.changes.slice().sort(function (a, b) { return b.from - a.from; }).forEach(function (c) { out = out.slice(0, c.from) + c.insert + out.slice(c.to); });
    return { text: out, sel: out.slice(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head)), r: r };
  }
  var w = run('say hi now', 4, 6, '**');
  assert.strictEqual(w.text, 'say **hi** now'); assert.strictEqual(w.sel, 'hi');
  var u = run('say **hi** now', 6, 8, '**');
  assert.strictEqual(u.text, 'say hi now'); assert.strictEqual(u.sel, 'hi');
  var u2 = run('say **hi** now', 4, 10, '**');
  assert.strictEqual(u2.text, 'say hi now'); assert.strictEqual(u2.sel, 'hi');
  var e = run('ab', 1, 1, '*');
  assert.strictEqual(e.text, 'a**b'); assert.strictEqual(e.r.anchor, 2);
  var it = run('x **bold** y', 4, 8, '*');
  assert.strictEqual(it.text, 'x ***bold*** y', 'italic inside bold wraps rather than eating a bold star');
  var both = run('***bi***', 3, 5, '*');
  assert.strictEqual(both.text, '**bi**');
});

test('planIncoming', function () {
  var P = C.planIncoming;
  assert.strictEqual(P({ live: true, incoming: 'x', base: 'a', doc: 'a' }), 'none', 'the editor link owns it');
  assert.strictEqual(P({ incoming: null, base: 'a', doc: 'a' }), 'none');
  assert.strictEqual(P({ incoming: 'a', base: 'a', doc: 'ab' }), 'none', 'our own echo / nothing new');
  assert.strictEqual(P({ incoming: 'b', base: 'a', doc: 'a', saving: true }), 'defer');
  assert.strictEqual(P({ incoming: 'b', base: 'a', doc: 'b' }), 'base');
  assert.strictEqual(P({ incoming: 'b', base: 'a', doc: 'a' }), 'adopt');
  assert.strictEqual(P({ incoming: 'b', base: 'a', doc: 'a!' }), 'rebase', 'unsaved typing is kept');
});

test('planEnterLive', function () {
  assert.strictEqual(C.planEnterLive({ base: 'a', doc: 'x', main: 'x' }), 'same');
  assert.strictEqual(C.planEnterLive({ base: 'a', doc: 'a', main: 'b' }), 'adopt');
  assert.strictEqual(C.planEnterLive({ base: 'a', doc: 'a!', main: 'b' }), 'merge');
});

test('mainAction: echo guard and drift detection', function () {
  var A = C.mainAction;
  assert.strictEqual(A({ live: false, docChanged: true, startIsRef: true }), 'ignore');
  assert.strictEqual(A({ live: true, forwarding: true, docChanged: true, startIsRef: true }), 'track', 'our own forwarded change never echoes back');
  assert.strictEqual(A({ live: true, docChanged: true, startIsRef: true }), 'apply');
  assert.strictEqual(A({ live: true, docChanged: true, startIsRef: false }), 'resync');
  assert.strictEqual(A({ live: true, docChanged: false, docIsRef: true }), 'ignore');
  assert.strictEqual(A({ live: true, docChanged: false, docIsRef: false }), 'resync', 'state swapped behind our back');
});

test('roomOptions: archived hidden unless current; current always listed', function () {
  var arch = function (r) { return r === 'old'; };
  assert.deepStrictEqual(C.roomOptions(['a', 'old', 'b', 'a'], 'b', arch).map(function (o) { return o.value; }), ['a', 'b']);
  assert.deepStrictEqual(C.roomOptions(['a', 'old'], 'old', arch).map(function (o) { return o.value; }), ['a', 'old']);
  var gone = C.roomOptions(['a'], 'zed', arch);
  assert.strictEqual(gone[0].value, 'zed'); assert.ok(/not in the room list/.test(gone[0].label));
});

test('statusOf', function () {
  assert.strictEqual(C.statusOf({}).text, 'Saved');
  assert.strictEqual(C.statusOf({ dirty: true }).text, 'Edited');
  assert.strictEqual(C.statusOf({ saving: true, dirty: true }).text, 'Saving…');
  assert.strictEqual(C.statusOf({ live: true }).cls, 'live');
  assert.strictEqual(C.statusOf({ live: true, mainRO: true }).text, 'Read-only');
  assert.strictEqual(C.statusOf({ err: 'offline' }).cls, 'err');
  assert.strictEqual(C.statusOf({ unavailable: true, live: true }).text, 'Unavailable');
});

test('classifyKey keeps the app\'s main-editor shortcuts away from the scratchpad', function () {
  function k(key, o) { o = o || {}; return { key: key, ctrlKey: !!o.c, metaKey: !!o.m, shiftKey: !!o.s, altKey: !!o.a }; }
  var K = function (e, hk, sk, mac) { return C.classifyKey(e, hk || null, sk || null, !!mac); };
  assert.strictEqual(K(k('l', { c: 1 })), 'block', 'Ctrl+L would clear the main editor');
  assert.strictEqual(K(k('d', { c: 1 })), 'block', 'Ctrl+D toggles a todo there');
  assert.strictEqual(K(k('K', { c: 1, s: 1 })), 'block', 'rerun script');
  assert.strictEqual(K(k('s', { c: 1 })), 'save');
  assert.strictEqual(K(k('b', { c: 1 })), 'bold');
  assert.strictEqual(K(k('i', { c: 1 })), 'italic');
  assert.strictEqual(K(k('u', { c: 1 })), 'underline');
  assert.strictEqual(K(k('k', { c: 1 })), 'pass', 'the palette');
  assert.strictEqual(K(k('p', { c: 1 })), 'pass', 'quick switcher');
  assert.strictEqual(K(k('f', { c: 1 })), 'pass', 'find');
  assert.strictEqual(K(k('z', { c: 1 })), 'pass', 'undo is CodeMirror\'s');
  assert.strictEqual(K(k('a')), 'pass');
  assert.strictEqual(K(k('Escape')), 'pass');
  assert.strictEqual(K({ ctrlKey: true }), 'pass', 'no key (autofill)');
  // Mac: Cmd is the modifier, Ctrl alone is not
  assert.strictEqual(K(k('l', { m: 1 }), null, null, true), 'block');
  assert.strictEqual(K(k('l', { c: 1 }), null, null, true), 'pass');
  assert.strictEqual(K(k('b', { m: 1 }), null, null, true), 'bold');
  // rebinding and script hotkeys
  assert.strictEqual(K(k('l', { c: 1 }), { clearEditor: 'Ctrl+Shift+Backspace' }), 'pass');
  assert.strictEqual(K(k('Backspace', { c: 1, s: 1 }), { clearEditor: 'Ctrl+Shift+Backspace' }), 'block');
  assert.strictEqual(K(k('s', { c: 1 }), { openSync: '' }), 'pass', 'Ctrl+S unbound: CodeMirror\'s own Mod-s saves');
  assert.strictEqual(K(k('1', { c: 1, s: 1 }), null, { 'Ctrl+Shift+1': 'Sort lines' }), 'block');
  assert.strictEqual(K(k('p', { c: 1 }), null, { 'Ctrl+P': 'x' }), 'pass', 'Ctrl+P is never a script key');
  assert.ok(C.hotkeyMatch(k('g', { c: 1 }), 'ctrl+G', false));
  assert.ok(!C.hotkeyMatch(k('g', { c: 1, s: 1 }), 'Ctrl+G', false));
});

test('manifest entry matches the widget', function () {
  var widget = null;
  global.window = { Cade: { loadCSS: function () {}, registerWidget: function (w) { widget = w; }, CM: {} } };
  delete require.cache[require.resolve('./scratchpad.js')];
  require('./scratchpad.js');
  delete global.window;
  var e = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'scratchpad'; })[0];
  assert.ok(widget && e, 'registered and in the manifest');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(e[k], widget[k], k); });
  assert.strictEqual(e.entry, 'widgets/scratchpad/scratchpad.js'); assert.strictEqual(e.css, 'widgets/scratchpad/scratchpad.css');
});

console.log((process.exitCode ? 'FAILED' : 'ok') + ' — ' + passed + ' passed');
