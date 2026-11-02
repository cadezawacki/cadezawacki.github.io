/* Tests for the Lines Pack: every registered script is pulled out of
 * pack-lines.js (by stubbing window.Cade.registerScript), compiled the way the
 * app's script engine does it (new Function(window, document, ctx, showToast))
 * and run on fake ctx objects that mirror the engine's selection / current
 * line / whole-note semantics. Not loaded by the app.
 * Run: node txt/scripts/pack-lines/pack-lines.test.js */
'use strict';
var assert = require('assert');
var path = require('path');

// ---------------------------------------------------------------- load the pack
var sources = [];
global.window = { Cade: { registerScript: function (src) { sources.push(src); } } };
require(path.join(__dirname, 'pack-lines.js'));
delete global.window;

// Parsed exactly like txt.html's registerScript().
var scripts = {}, order = [];
sources.forEach(function (source) {
  var m = source.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//);
  var meta = JSON.parse(m[1]);
  meta.code = source.slice(m[0].length).trim();
  scripts[meta.name] = meta;
  order.push(meta.name);
});

// Run a script. opts:
//   mode: 'doc' (cursor on an empty line → whole note, the default),
//         'sel' (an explicit selection: `text` is the selection, inside
//                opts.before / opts.after) or
//         'line' (no selection; `text` is the non-empty line the cursor is on,
//                 inside before / after — the engine passes it as the selection)
//   prompts: answers for prompt() in order (null = Cancel)
//   store: initial Cade.store contents
// Returns { doc, toasts, asked, store }.
function run(name, text, opts) {
  opts = opts || {};
  var script = scripts[name];
  assert.ok(script, 'no script named ' + name);
  var mode = opts.mode || 'doc', before = opts.before || '', after = opts.after || '';
  var full = mode === 'doc' ? text : before + text + after;
  var hasSelection = mode !== 'doc';
  var newFull = full, newEdit = text, fullChanged = false, editChanged = false;
  var ctx = {
    get fullText() { return newFull; },
    set fullText(v) { newFull = v; fullChanged = true; },
    get selection() { return hasSelection ? newEdit : ''; },
    set selection(v) { if (hasSelection) { newEdit = v; editChanged = true; } else { newFull = v; fullChanged = true; } },
    get text() { return hasSelection ? newEdit : newFull; }
  };
  var toasts = [], asked = [], answers = (opts.prompts || []).slice();
  var store = Object.assign({}, opts.store || {});
  var win = {
    Cade: {
      editor: { state: { selection: { main: { empty: mode !== 'sel' } } } },
      store: { get: function (k) { return k in store ? store[k] : null; }, set: function (k, v) { store[k] = v; } }
    }
  };
  global.prompt = function (msg, def) {
    asked.push({ msg: msg, def: def });
    assert.ok(answers.length, name + ': unexpected prompt ' + JSON.stringify(msg));
    return answers.shift();
  };
  var fn = new Function('window', 'document', 'ctx', 'showToast', script.code + '\nmain(ctx);');
  fn(win, {}, ctx, function (msg, type) { toasts.push({ msg: msg, type: type }); });
  delete global.prompt;
  var doc = full;
  if (editChanged && hasSelection) doc = before + newEdit + after;
  else if (fullChanged) doc = newFull;
  return { doc: doc, toasts: toasts, asked: asked, store: store };
}
function out(name, text, opts) { return run(name, text, opts).doc; }
var L = function () { return Array.prototype.slice.call(arguments).join('\n'); };

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

// =========================================================================== metadata
var NEW = ['Natural Sort', 'Natural Sort (Descending)', 'Sort by Nth Word…', 'Sort by Last Word',
  'Sort by Frequency', 'Count Duplicates', 'Every Nth Line…', 'Chunk into Groups…',
  'Group by First Letter', 'Group by Prefix…', 'List Intersection', 'List Union',
  'List Difference (A − B)', 'List Symmetric Difference', 'Zip Lines', 'Zip Into Columns…'];

test('metadata: 33 scripts, unique names, all new rows present with icon / tags / description', function () {
  assert.strictEqual(sources.length, 33);
  assert.strictEqual(new Set(order).size, 33);
  NEW.forEach(function (n) {
    var s = scripts[n];
    assert.ok(s, 'missing ' + n);
    assert.ok(/^<svg viewBox='0 0 24 24'[^"]*<\/svg>$/.test(s.icon), n + ' icon');
    assert.ok(s.description.length > 20 && s.tags.split(',').length >= 5, n + ' description / tags');
    assert.strictEqual(s.author, 'Cade');
    assert.ok(/^function main\(ctx\)/.test(s.code), n + ' code starts with main');
    // "…" rows ask, the others don't
    assert.strictEqual(/…$/.test(n), /\bprompt\(/.test(s.code.split('\n\n')[0]) || /\bask(Int)?\(/.test(s.code.split('\n\n')[0]), n + ' prompt/… consistency');
  });
});

test('metadata: every script compiles', function () {
  order.forEach(function (n) { new Function('window', 'document', 'ctx', 'showToast', scripts[n].code + '\nmain(ctx);'); });
});

// =========================================================================== Natural Sort
test('Natural Sort: numbers in text, versions, case-insensitive', function () {
  assert.strictEqual(out('Natural Sort', L('file10', 'file2', 'File1', 'file1')), L('File1', 'file1', 'file2', 'file10'));
  assert.strictEqual(out('Natural Sort', L('v1.10', 'v1.9', 'v1.2', 'v10.0', 'v2.0')), L('v1.2', 'v1.9', 'v1.10', 'v2.0', 'v10.0'));
  assert.strictEqual(out('Natural Sort', L('banana', 'Apple', 'cherry', 'apple')), L('Apple', 'apple', 'banana', 'cherry'));
  assert.strictEqual(out('Natural Sort', L('img 12.png', 'img 1.png', 'img 007.png', 'img 7.png')), L('img 1.png', 'img 007.png', 'img 7.png', 'img 12.png'));
  assert.strictEqual(out('Natural Sort', L('x99999999999999999999', 'x100000000000000000000', 'x5')), L('x5', 'x99999999999999999999', 'x100000000000000000000'));
});

test('Natural Sort: stable, blank lines last, trailing newline, CRLF, unicode', function () {
  assert.strictEqual(out('Natural Sort', L('b', 'B', 'a', 'b ', ' b')), L('a', 'b', 'B', 'b ', ' b'));
  assert.strictEqual(out('Natural Sort', L('b', '', 'a', '') + '\n'), L('a', 'b', '', '') + '\n');
  assert.strictEqual(out('Natural Sort', 'b\r\na10\r\na9\r\n'), 'a9\r\na10\r\nb\r\n');
  assert.strictEqual(out('Natural Sort', L('Zoë', 'éclair', 'Eagle', 'zebra', '日本')), L('Eagle', 'éclair', 'zebra', 'Zoë', '日本'));
  assert.strictEqual(out('Natural Sort', ''), '');
  assert.strictEqual(out('Natural Sort', '\n'), '\n');
  assert.strictEqual(out('Natural Sort', 'only'), 'only');
});

test('Natural Sort: comma list on one line, current line, selection', function () {
  assert.strictEqual(out('Natural Sort', 'item10, item2, Item1'), 'Item1, item2, item10');
  assert.strictEqual(out('Natural Sort', 'c10,c9,,c1\n'), 'c1, c9, c10\n');
  // cursor on a comma line → just that line
  assert.strictEqual(out('Natural Sort', 'b2, b10, b1', { mode: 'line', before: 'z\na\n', after: '\nq' }), 'z\na\nb1, b2, b10\nq');
  // cursor on a plain line → the whole note
  assert.strictEqual(out('Natural Sort', 'a3', { mode: 'line', before: 'a20\n', after: '\na1' }), L('a1', 'a3', 'a20'));
  // explicit selection → only it
  assert.strictEqual(out('Natural Sort', 'x3\nx1', { mode: 'sel', before: 'z\n', after: '\na' }), 'z\nx1\nx3\na');
});

test('Natural Sort (Descending): reverse order, ties keep order, blanks last', function () {
  assert.strictEqual(out('Natural Sort (Descending)', L('file2', 'file10', 'File10', 'file1', '')), L('file10', 'File10', 'file2', 'file1', ''));
  assert.strictEqual(out('Natural Sort (Descending)', 'v1.9, v1.10, v1.2'), 'v1.10, v1.9, v1.2');
  assert.strictEqual(out('Natural Sort (Descending)', 'a\r\nc\r\nb\r\n'), 'c\r\nb\r\na\r\n');
});

// =========================================================================== Sort by word
test('Sort by Nth Word…: positive, negative, missing word, punctuation, remembered answer', function () {
  var text = L('3 pear red', '10 apple green', '2 fig', '1 kiwi brown');
  var r = run('Sort by Nth Word…', text, { prompts: ['2'] });
  assert.strictEqual(r.doc, L('10 apple green', '2 fig', '1 kiwi brown', '3 pear red'));
  assert.strictEqual(r.asked[0].def, '2');
  assert.strictEqual(r.store['cade-lines-nth-word'], '2');
  assert.strictEqual(out('Sort by Nth Word…', text, { prompts: ['3'] }), L('1 kiwi brown', '10 apple green', '3 pear red', '2 fig'));
  assert.strictEqual(out('Sort by Nth Word…', text, { prompts: ['-1'] }), L('1 kiwi brown', '2 fig', '10 apple green', '3 pear red'));
  assert.strictEqual(out('Sort by Nth Word…', text, { prompts: ['1'] }), L('1 kiwi brown', '2 fig', '3 pear red', '10 apple green'));
  assert.strictEqual(out('Sort by Nth Word…', L('a "zed",', 'b (alpha)', '', 'c'), { prompts: [' 2 '] }), L('b (alpha)', 'a "zed",', 'c', ''));
  // remembered answer becomes the default
  assert.strictEqual(run('Sort by Nth Word…', 'a', { prompts: ['1'], store: { 'cade-lines-nth-word': '-2' } }).asked[0].def, '-2');
});

test('Sort by Nth Word…: cancel and bad input leave text alone', function () {
  var r = run('Sort by Nth Word…', 'b\na', { prompts: [null] });
  assert.strictEqual(r.doc, 'b\na');
  ['0', 'x', '1.5', ''].forEach(function (bad) {
    var r2 = run('Sort by Nth Word…', 'b\na', { prompts: [bad] });
    assert.strictEqual(r2.doc, 'b\na', bad);
    assert.strictEqual(r2.toasts[0].type, 'error', bad);
  });
});

test('Sort by Last Word: surnames, natural, ties stable, CRLF + trailing newline', function () {
  assert.strictEqual(out('Sort by Last Word', L('Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Charles Babbage')),
    L('Charles Babbage', 'Grace Hopper', 'Ada Lovelace', 'Alan Turing'));
  assert.strictEqual(out('Sort by Last Word', 'x track10\r\ny track2\r\nz Track2\r\n'), 'y track2\r\nz Track2\r\nx track10\r\n');
  assert.strictEqual(out('Sort by Last Word', L('Émile Zola.', 'Jane Austen,')), L('Jane Austen,', 'Émile Zola.'));
  assert.strictEqual(out('Sort by Last Word', 'single'), 'single');
  assert.strictEqual(out('Sort by Last Word', ''), '');
});

// =========================================================================== frequency
test('Sort by Frequency: most common first, grouped, ties by first appearance', function () {
  assert.strictEqual(out('Sort by Frequency', L('b', 'a', 'c', 'a', 'b', 'a', 'd')), L('a', 'a', 'a', 'b', 'b', 'c', 'd'));
  assert.strictEqual(out('Sort by Frequency', L('x', '', 'y', 'y', '') + '\n'), L('y', 'y', 'x', '', '') + '\n');
  assert.strictEqual(out('Sort by Frequency', 'A\r\na\r\na\r\n'), 'a\r\na\r\nA\r\n');          // case-sensitive
  assert.strictEqual(out('Sort by Frequency', L('  🍎', '🍐', '🍎')), L('  🍎', '🍎', '🍐'));      // trimmed key, lines kept
  assert.strictEqual(out('Sort by Frequency', ''), '');
});

test('Count Duplicates: uniq -c style, right-aligned counts, blanks dropped', function () {
  var text = L('a', 'b', 'a', 'c', 'b', 'a', '', 'd', 'a', 'a', 'a', 'a', 'a', 'a', 'a');
  assert.strictEqual(out('Count Duplicates', text), L('10 a', ' 2 b', ' 1 c', ' 1 d'));
  assert.strictEqual(out('Count Duplicates', 'x\r\n y \r\nx\r\n'), '2 x\r\n1 y\r\n');
  assert.strictEqual(out('Count Duplicates', 'solo'), '1 solo');
  assert.strictEqual(out('Count Duplicates', L('Straße', 'straße', 'Straße')), L('2 Straße', '1 straße'));
  var r = run('Count Duplicates', '\n\n');
  assert.strictEqual(r.doc, '\n\n');
  assert.strictEqual(r.toasts[0].type, 'info');
});

// =========================================================================== picking + chunking
test('Every Nth Line…: N, N+start, Nn+start, odd / even', function () {
  var t = L('1', '2', '3', '4', '5', '6', '7');
  var e = function (a) { return out('Every Nth Line…', t, { prompts: [a] }); };
  assert.strictEqual(e('2'), L('2', '4', '6'));
  assert.strictEqual(e('2+1'), L('1', '3', '5', '7'));
  assert.strictEqual(e('3n+2'), L('2', '5'));
  assert.strictEqual(e(' 3 + 3 '), L('3', '6'));
  assert.strictEqual(e('odd'), L('1', '3', '5', '7'));
  assert.strictEqual(e('EVEN'), L('2', '4', '6'));
  assert.strictEqual(e('1'), t);
  assert.strictEqual(e('7'), '7');
  assert.strictEqual(run('Every Nth Line…', 'a', { prompts: [null] }).asked[0].def, '2+1');
});

test('Every Nth Line…: blank lines count, CRLF, trailing newline, errors', function () {
  assert.strictEqual(out('Every Nth Line…', 'a\r\n\r\nb\r\n\r\n', { prompts: ['2+1'] }), 'a\r\nb\r\n');
  var r = run('Every Nth Line…', L('a', 'b'), { prompts: ['5'] });
  assert.strictEqual(r.doc, L('a', 'b'));
  assert.strictEqual(r.toasts[0].type, 'info');
  ['0', '2+0', 'abc', '-2', ''].forEach(function (bad) {
    var r2 = run('Every Nth Line…', L('a', 'b'), { prompts: [bad] });
    assert.strictEqual(r2.doc, L('a', 'b'), bad);
    assert.strictEqual(r2.toasts[0].type, 'error', bad);
  });
});

test('Chunk into Groups…: groups of N, re-chunk, edges', function () {
  var t = L('a', 'b', 'c', 'd', 'e', 'f', 'g');
  assert.strictEqual(out('Chunk into Groups…', t, { prompts: ['3'] }), L('a', 'b', 'c', '', 'd', 'e', 'f', '', 'g'));
  var once = out('Chunk into Groups…', t + '\n', { prompts: ['2'] });
  assert.strictEqual(once, L('a', 'b', '', 'c', 'd', '', 'e', 'f', '', 'g') + '\n');
  assert.strictEqual(out('Chunk into Groups…', once, { prompts: ['4'] }), L('a', 'b', 'c', 'd', '', 'e', 'f', 'g') + '\n');
  assert.strictEqual(out('Chunk into Groups…', 'a\r\nb\r\nc', { prompts: ['1'] }), 'a\r\n\r\nb\r\n\r\nc');
  assert.strictEqual(out('Chunk into Groups…', 'one', { prompts: ['5'] }), 'one');
  assert.strictEqual(out('Chunk into Groups…', '', { prompts: ['5'] }), '');
  ['0', '-1', 'x'].forEach(function (bad) {
    var r = run('Chunk into Groups…', t, { prompts: [bad] });
    assert.strictEqual(r.doc, t);
    assert.strictEqual(r.toasts[0].type, 'error');
  });
});

// =========================================================================== grouping
test('Group by First Letter: headings, natural order inside, # last, accents folded', function () {
  assert.strictEqual(out('Group by First Letter', L('banana', 'apple', '', 'Avocado', '42 things', 'éclair', 'Egg', 'blueberry', '- cherry', '#tag')),
    L('A', 'apple', 'Avocado', '', 'B', 'banana', 'blueberry', '', 'C', '- cherry', '', 'E', 'éclair', 'Egg', '', 'T', '#tag', '', '#', '42 things'));   // leading bullets / symbols skipped
  assert.strictEqual(out('Group by First Letter', 'b2\r\nb10\r\na\r\n'), 'A\r\na\r\n\r\nB\r\nb2\r\nb10\r\n');
  assert.strictEqual(out('Group by First Letter', L('Жук', 'арбуз', 'жёлудь')), L('А', 'арбуз', '', 'Ж', 'жёлудь', 'Жук'));
  assert.strictEqual(out('Group by First Letter', 'solo'), L('S', 'solo'));
  assert.strictEqual(out('Group by First Letter', ''), '');
});

test('Group by Prefix…: explicit separator, groups in first-appearance order', function () {
  var t = L('fruit: apple', 'veg: carrot', 'fruit: banana', 'veg: leek', 'nut: pecan');
  var r = run('Group by Prefix…', t, { prompts: [':'] });
  assert.strictEqual(r.doc, L('fruit', '  - apple', '  - banana', '', 'veg', '  - carrot', '  - leek', '', 'nut', '  - pecan'));
  assert.strictEqual(r.asked[0].def, '');
  assert.strictEqual(out('Group by Prefix…', L('a/x/1', 'b/y', 'a/z'), { prompts: ['/'] }), L('a', '  - x/1', '  - z', '', 'b', '  - y'));
  assert.strictEqual(out('Group by Prefix…', 'k\tv1\r\nk\tv2\r\n', { prompts: ['\\t'] }), 'k\r\n  - v1\r\n  - v2\r\n');
});

test('Group by Prefix…: auto-detect ":", " - ", first word; lines without the separator', function () {
  assert.strictEqual(out('Group by Prefix…', L('fruit: apple', 'veg: kale', 'fruit: fig'), { prompts: [''] }),
    L('fruit', '  - apple', '  - fig', '', 'veg', '  - kale'));
  assert.strictEqual(out('Group by Prefix…', L('Mon - gym', 'Tue - run', 'Mon - swim'), { prompts: ['auto'] }),
    L('Mon', '  - gym', '  - swim', '', 'Tue', '  - run'));
  assert.strictEqual(out('Group by Prefix…', L('git commit', 'npm test', 'git push', 'make'), { prompts: [''] }),
    L('git', '  - commit', '  - push', '', 'npm', '  - test', '', 'make'));
  assert.strictEqual(out('Group by Prefix…', L('a: 1', 'loose', 'a: 2'), { prompts: [':'] }), L('a', '  - 1', '  - 2', '', 'loose'));
  var r = run('Group by Prefix…', '\n', { prompts: [':'] });
  assert.strictEqual(r.doc, '\n');
  assert.strictEqual(run('Group by Prefix…', 'a: b', { prompts: [null] }).doc, 'a: b');
});

// =========================================================================== set operations
var A_B = L('apple', 'banana', 'apple', ' cherry ', 'date', '---', 'cherry', 'elder', 'banana', 'fig', 'fig');
test('List Intersection / Union / Difference / Symmetric Difference with ---', function () {
  assert.strictEqual(out('List Intersection', A_B), L('banana', 'cherry'));
  assert.strictEqual(out('List Union', A_B), L('apple', 'banana', 'cherry', 'date', 'elder', 'fig'));
  assert.strictEqual(out('List Difference (A − B)', A_B), L('apple', 'date'));
  assert.strictEqual(out('List Symmetric Difference', A_B), L('apple', 'date', 'elder', 'fig'));
});

test('set ops: blank-line separator, CRLF, trailing newline, case-sensitive, unicode', function () {
  var t = 'Apple\r\nkiwi\r\n☕ coffee\r\n\r\napple\r\n☕ coffee\r\n';
  assert.strictEqual(out('List Intersection', t), '☕ coffee\r\n');
  assert.strictEqual(out('List Union', t), 'Apple\r\nkiwi\r\n☕ coffee\r\napple\r\n');
  assert.strictEqual(out('List Difference (A − B)', t), 'Apple\r\nkiwi\r\n');
  assert.strictEqual(out('List Symmetric Difference', t), 'Apple\r\nkiwi\r\napple\r\n');
  // with ---, blank lines inside the lists are ignored
  assert.strictEqual(out('List Union', L('a', '', 'b', ' --- ', '', 'c', '')), L('a', 'b', 'c', ''));
  // a longer dash rule counts too
  assert.strictEqual(out('List Intersection', L('a', 'b', '-----', 'b')), 'b');
});

test('set ops: comma lists on single lines stay comma lists', function () {
  assert.strictEqual(out('List Intersection', 'a, b, c\n---\nc, b, z'), 'b, c');
  assert.strictEqual(out('List Union', 'a,b\n\nb,c\n'), 'a, b, c\n');
  // one comma line + a line list → one per line
  assert.strictEqual(out('List Difference (A − B)', 'a, b, c\n---\nb'), L('a', 'c'));
});

test('set ops: errors and empty results leave the text alone', function () {
  [['one list only', L('a', 'b')], ['three blocks', L('a', '', 'b', '', 'c')], ['two ---', L('a', '---', 'b', '---', 'c')],
    ['empty B', L('a', '---')], ['empty', ''], ['empty A', L('---', 'b')]].forEach(function (c) {
    var r = run('List Union', c[1]);
    assert.strictEqual(r.doc, c[1], c[0]);
    assert.strictEqual(r.toasts.length, 1, c[0]);
    assert.strictEqual(r.toasts[0].type, 'error', c[0]);
  });
  var r = run('List Intersection', L('a', '---', 'b'));
  assert.strictEqual(r.doc, L('a', '---', 'b'));
  assert.strictEqual(r.toasts[0].type, 'info');
});

test('set ops: cursor on a line uses the whole note; explicit selection only itself', function () {
  assert.strictEqual(out('List Intersection', 'b', { mode: 'line', before: 'a\n', after: '\n---\nb\nc' }), 'b');
  assert.strictEqual(out('List Union', 'x\n---\ny', { mode: 'sel', before: 'top\n', after: '\nend' }), 'top\nx\ny\nend');
});

// =========================================================================== zips
test('Zip Lines: interleave, uneven, separators, CRLF', function () {
  assert.strictEqual(out('Zip Lines', L('a1', 'a2', 'a3', '---', 'b1', 'b2')), L('a1', 'b1', 'a2', 'b2', 'a3'));
  assert.strictEqual(out('Zip Lines', L('a1', '', 'b1', 'b2', 'b3') + '\n'), L('a1', 'b1', 'b2', 'b3') + '\n');
  assert.strictEqual(out('Zip Lines', '  a1\r\n\r\nb1\r\n'), '  a1\r\nb1\r\n');   // indentation kept
  assert.strictEqual(out('Zip Lines', L('🙂', '---', 'ü')), L('🙂', 'ü'));
  var r = run('Zip Lines', 'a');
  assert.strictEqual(r.doc, 'a');
  assert.strictEqual(r.toasts[0].type, 'error');
});

test('Zip Into Columns…: default " | ", custom, tab, uneven sides', function () {
  var t = L('a1', 'a2', 'a3', '---', 'b1', 'b2');
  var r = run('Zip Into Columns…', t, { prompts: [' | '] });
  assert.strictEqual(r.doc, L('a1 | b1', 'a2 | b2', 'a3 |'));
  assert.strictEqual(r.asked[0].def, ' | ');
  assert.strictEqual(out('Zip Into Columns…', t, { prompts: [','] }), L('a1,b1', 'a2,b2', 'a3,'));
  assert.strictEqual(out('Zip Into Columns…', t, { prompts: ['\\t'] }), L('a1\tb1', 'a2\tb2', 'a3\t'));
  assert.strictEqual(out('Zip Into Columns…', L(' x ', '', 'p', 'q') + '\n', { prompts: [' = '] }), L('x = p', ' = q') + '\n');
  assert.strictEqual(out('Zip Into Columns…', 'a\r\n---\r\nb', { prompts: [': '] }), 'a: b');
  assert.strictEqual(run('Zip Into Columns…', t, { prompts: [null] }).doc, t);
});

// =========================================================================== existing rows (no regressions)
test('existing: Sort List, Reverse List, Unique Lines, Delete Blank Lines', function () {
  assert.strictEqual(out('Sort List', L('b10', 'B2', '', 'a')), L('a', 'B2', 'b10', ''));
  assert.strictEqual(out('Sort List', 'c, a, b'), 'a, b, c');
  assert.strictEqual(out('Reverse List', L('1', '2', '3')), L('3', '2', '1'));
  assert.strictEqual(out('Reverse List', 'a, b'), 'b, a');
  assert.strictEqual(out('Unique Lines', L('a', 'b', ' a', 'c', 'b')), L('a', 'b', 'c'));
  assert.strictEqual(out('Delete Blank Lines', L('a', '', '  ', 'b')), L('a', 'b'));
});

test('existing: Number Lines, Bullet List, Listify, Sort Lines by Length, Flatten', function () {
  assert.strictEqual(out('Number Lines', L('x', 'y')), L('1.  x', '2.  y'));
  assert.strictEqual(out('Bullet List', L('a', '', 'b')), L('- a', '', '- b'));
  assert.strictEqual(out('Bullet List', L('- a', '- b')), L('a', 'b'));
  assert.strictEqual(out('Listify', L('a', '"b"', '')), '"a", "b"');
  assert.strictEqual(out('Listify (One Per Row)', 'a, b'), L('"a",', '"b"'));
  assert.strictEqual(out('Sort Lines by Length', L('ccc', 'a', 'bb')), L('a', 'bb', 'ccc'));
  assert.strictEqual(out('Flatten', L(' a ', '', 'b')), 'a b');
  var s = out('Shuffle Lines', L('1', '2', '3', '4'));
  assert.deepStrictEqual(s.split('\n').sort(), ['1', '2', '3', '4']);
});

test('existing: prompting rows (Wrap Lines, Join Lines, Indent / Dedent), Remove Duplicates (CSV), Sort by Value', function () {
  assert.strictEqual(out('Wrap Lines', L('a', 'b'), { prompts: ['<', '>'] }), L('<a>', '<b>'));
  assert.strictEqual(out('Join Lines', L('a', '', 'b'), { prompts: [' + '] }), 'a + b');
  assert.strictEqual(out('Join Lines', 'a\nb', { prompts: [null] }), 'a\nb');
  assert.strictEqual(out('Indent / Dedent', L('a', 'b'), { prompts: ['in'] }), L('  a', '  b'));
  assert.strictEqual(out('Indent / Dedent', L('  a', 'b'), { prompts: ['out'] }), L('a', 'b'));
  assert.strictEqual(out('Remove Duplicates (CSV)', 'a, b, a'), 'a, b');
  assert.strictEqual(out('Sort by Value', L('{', '  "a": 3,', '  "b": 1,', '  "c": 2', '}')), L('{', '  "b": 1,', '  "c": 2,', '  "a": 3', '}'));
});

console.log(passed + ' passed');
