/* Unit tests for Merge Files' pure model (filter, natural order, plan + caps,
 * header templates, CSV merging, newlines, duplicates, the join, names, byte
 * sniffing / decoding). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/mergefiles/mergefiles.test.js */
'use strict';
var assert = require('assert');
var M = require('./mergefiles.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var eq = assert.strictEqual, deep = assert.deepStrictEqual;
var MB = 1048576;
var seq = 0;
function E(path, size, extra) {
  var e = { id: ++seq, path: path, name: M.baseName(path), size: size == null ? 10 : size, mtime: 0, seq: seq, type: '' };
  for (var k in extra || {}) e[k] = extra[k];
  return e;
}
function P(path, text, size) { return { name: M.baseName(path), path: path, size: size == null ? text.length : size, text: text }; }
function paths(list) { return list.map(function (e) { return e.path; }); }
function bytes(arr) { return new Uint8Array(arr); }
function utf8(s) { return new Uint8Array(Buffer.from(s, 'utf8')); }

// ---- names / extensions ---------------------------------------------------------
test('extOf / stemOf / baseName / dirName', function () {
  eq(M.extOf('a/b/c.CSV'), 'csv');
  eq(M.extOf('.gitignore'), '');
  eq(M.extOf('Makefile'), '');
  eq(M.extOf('x.tar.gz'), 'gz');
  eq(M.extOf('trailing.'), '');
  eq(M.extOf('dir.v2/readme'), '');
  eq(M.stemOf('a/report.final.md'), 'report.final');
  eq(M.stemOf('.env'), '.env');
  eq(M.baseName('a/b/c.txt'), 'c.txt');
  eq(M.dirName('a/b/c.txt'), 'a/b/');
  eq(M.dirName('c.txt'), '');
  eq(M.normPath('.\\a\\b.txt'), 'a/b.txt');
  eq(M.normPath('/x/y'), 'x/y');
});

test('fmtBytes / capLabel', function () {
  eq(M.fmtBytes(0), '0 B');
  eq(M.fmtBytes(1536), '1.5 KB');
  eq(M.fmtBytes(20480), '20 KB');
  eq(M.fmtBytes(5 * MB), '5.0 MB');
  eq(M.capLabel(5 * MB), '5 MB');
  eq(M.capLabel(20 * MB), '20 MB');
});

// ---- filter ----------------------------------------------------------------------------
test('parseFilter: separators, dots, globs, negation, (none), dedupe', function () {
  deep(M.parseFilter('csv, .TXT; *.md  !log|(none) csv'), { inc: ['csv', 'txt', 'md', ''], exc: ['log'] });
  deep(M.parseFilter(''), { inc: [], exc: [] });
  deep(M.parseFilter('  ,, ;; '), { inc: [], exc: [] });
  deep(M.parseFilter('tar.gz -bak'), { inc: ['tar.gz'], exc: ['bak'] });
  deep(M.parseFilter('* . */x csv.'), { inc: ['csv'], exc: [] });
  deep(M.parseFilter(null), { inc: [], exc: [] });
});

test('passesFilter: include, exclude, compound, no-extension', function () {
  var f = M.parseFilter('csv');
  eq(M.passesFilter('a/b.csv', f), true);
  eq(M.passesFilter('B.CSV', f), true);
  eq(M.passesFilter('b.txt', f), false);
  eq(M.passesFilter('.csv', f), false);           // a dotfile, not a .csv
  eq(M.passesFilter('a.txt', M.parseFilter('')), true);
  var ex = M.parseFilter('!log');
  eq(M.passesFilter('a.txt', ex), true);
  eq(M.passesFilter('a.log', ex), false);
  var none = M.parseFilter('(none)');
  eq(M.passesFilter('dir/Makefile', none), true);
  eq(M.passesFilter('a.txt', none), false);
  var tgz = M.parseFilter('tar.gz');
  eq(M.passesFilter('x.tar.gz', tgz), true);
  eq(M.passesFilter('x.gz', tgz), false);
  eq(M.passesFilter('a.csv', M.parseFilter('csv !csv')), false);  // exclusion wins
});

test('toggleFilterExt / formatFilter (chips)', function () {
  eq(M.toggleFilterExt('', 'csv'), 'csv');
  eq(M.toggleFilterExt('csv', 'csv'), '');
  eq(M.toggleFilterExt('csv, txt', 'md'), 'csv, txt, md');
  eq(M.toggleFilterExt('.CSV;*.txt', 'txt'), 'csv');
  eq(M.toggleFilterExt('!md', 'md'), 'md');
  eq(M.toggleFilterExt('!log', 'csv'), 'csv, !log');
  eq(M.toggleFilterExt('', ''), '(none)');
  eq(M.formatFilter(M.parseFilter('a b !c (none)')), 'a, b, (none), !c');
});

test('extCounts: most common first, skip predicate', function () {
  var list = [E('a.csv'), E('b.csv'), E('c.md'), E('d.png'), E('Makefile'), E('e.CSV')];
  deep(M.extCounts(list), [{ ext: 'csv', n: 3 }, { ext: '', n: 1 }, { ext: 'md', n: 1 }, { ext: 'png', n: 1 }]);
  deep(M.extCounts(list, function (e) { return M.isKnownBinary(e.name, e.type); }).map(function (c) { return c.ext; }), ['csv', '', 'md']);
});

// ---- natural order -------------------------------------------------------------------------
test('naturalCompare: numbers, case, leading zeros, separators', function () {
  var nc = M.naturalCompare;
  assert.ok(nc('file2', 'file10') < 0);
  assert.ok(nc('file10', 'file2') > 0);
  assert.ok(nc('file9.txt', 'file10.txt') < 0);
  assert.ok(nc('a.txt', 'a1.txt') < 0);
  assert.ok(nc('apple', 'Banana') < 0);
  assert.ok(nc('file1', 'file01') < 0);           // equal value: fewer zeros first
  assert.ok(nc('File', 'file') < 0);              // only case differs: raw order, deterministic
  eq(nc('same', 'same'), 0);
  assert.ok(nc('9', '12345678901234567890123') < 0); // beyond 2^53
  assert.ok(nc('v1.10.2', 'v1.9.9') > 0);
  assert.ok(nc('dir/x.txt', 'dir-2/x.txt') < 0);  // a folder's files stay together
  assert.ok(nc('dir/z.txt', 'dir 2/a.txt') < 0);
  assert.ok(nc('img', 'img0') < 0);
  var sorted = ['file10.txt', 'file2.txt', 'File3.txt', 'file1.txt', 'file1.TXT'].sort(nc);
  deep(sorted, ['file1.TXT', 'file1.txt', 'file2.txt', 'File3.txt', 'file10.txt']);
});

test('natKey orders exactly like naturalCompare (fuzz)', function () {
  var abc = ['a', 'B', 'z', '0', '1', '2', '9', '00', '10', '/', '.', '-', '_', ' ', 'é', 'Z', '~'];
  var r = 12345;
  function rnd(n) { r = (r * 1103515245 + 12345) & 0x7fffffff; return r % n; }
  function word() { var s = '', n = rnd(9); for (var i = 0; i < n; i++) s += abc[rnd(abc.length)]; return s; }
  var bad = [];
  for (var i = 0; i < 20000 && bad.length < 5; i++) {
    var a = word(), b = word(), ka = M.natKey(a), kb = M.natKey(b);
    var want = Math.sign(M.naturalCompare(a, b));
    var got = ka < kb ? -1 : ka > kb ? 1 : want;         // equal keys fall back to naturalCompare
    if (got !== want) bad.push([a, b, got, want]);
  }
  deep(bad, []);
  var list = ['x/file10', 'x/file2', 'x-2/a', 'x/File1', 'x/file01', 'x.txt', 'x1.txt'];
  deep(list.slice().sort(function (a, b) { var ka = M.natKey(a), kb = M.natKey(b); return ka < kb ? -1 : ka > kb ? 1 : M.naturalCompare(a, b); }), list.slice().sort(M.naturalCompare));
});

test('orderEntries: path, name, size, mtime, picked, custom; desc; ties', function () {
  seq = 0;
  var a = E('b/file10.csv', 30, { mtime: 300 }), b = E('a/file2.csv', 10, { mtime: 100 }), c = E('b/file2.csv', 20, { mtime: 200 }), d = E('a/file1.csv', 20, { mtime: 200 });
  var L = [a, b, c, d];
  deep(paths(M.orderEntries(L, 'path')), ['a/file1.csv', 'a/file2.csv', 'b/file2.csv', 'b/file10.csv']);
  deep(paths(M.orderEntries(L, 'path', true)), ['b/file10.csv', 'b/file2.csv', 'a/file2.csv', 'a/file1.csv']);
  deep(paths(M.orderEntries(L, 'name')), ['a/file1.csv', 'a/file2.csv', 'b/file2.csv', 'b/file10.csv']);
  deep(paths(M.orderEntries(L, 'size')), ['a/file2.csv', 'a/file1.csv', 'b/file2.csv', 'b/file10.csv']);   // 20-byte tie → path
  deep(paths(M.orderEntries(L, 'size', true)), ['b/file10.csv', 'a/file1.csv', 'b/file2.csv', 'a/file2.csv']); // tie stays ascending
  deep(paths(M.orderEntries(L, 'mtime')), ['a/file2.csv', 'a/file1.csv', 'b/file2.csv', 'b/file10.csv']);
  deep(paths(M.orderEntries(L, 'mtime', true)), ['b/file10.csv', 'a/file1.csv', 'b/file2.csv', 'a/file2.csv']);
  deep(paths(M.orderEntries(L, 'picked')), ['b/file10.csv', 'a/file2.csv', 'b/file2.csv', 'a/file1.csv']);
  deep(paths(M.orderEntries(L, 'picked', true)), ['a/file1.csv', 'b/file2.csv', 'a/file2.csv', 'b/file10.csv']);
  // by hand: listed ids first, the rest after in picked order; desc ignored
  deep(paths(M.orderEntries(L, 'custom', true, [c.id, a.id])), ['b/file2.csv', 'b/file10.csv', 'a/file2.csv', 'a/file1.csv']);
  deep(paths(L), ['b/file10.csv', 'a/file2.csv', 'b/file2.csv', 'a/file1.csv']); // input untouched
});

test('hasDotDir: folders only', function () {
  eq(M.hasDotDir('.git/config'), true);
  eq(M.hasDotDir('proj/.venv/lib/x.py'), true);
  eq(M.hasDotDir('proj/.eslintrc'), false);
  eq(M.hasDotDir('.eslintrc'), false);
  eq(M.hasDotDir('a/b/c.txt'), false);
});

// ---- binary recognition ------------------------------------------------------------------------
test('isKnownBinary: names, MIME types, text names win', function () {
  eq(M.isKnownBinary('a.png', ''), true);
  eq(M.isKnownBinary('a.PDF', ''), true);
  eq(M.isKnownBinary('a.zip', ''), true);
  eq(M.isKnownBinary('noext', 'image/jpeg'), true);
  eq(M.isKnownBinary('noext', 'application/octet-stream'), false);   // unknown → sniffed
  eq(M.isKnownBinary('data.csv', 'application/vnd.ms-excel'), false); // Windows + Excel
  eq(M.isKnownBinary('logo.svg', 'image/svg+xml'), false);
  eq(M.isKnownBinary('a.dat', ''), false);
  eq(M.isTextName('x.unknown', 'text/plain'), true);
  eq(M.isTextName('x.unknown', ''), false);
  eq(M.isTextName('x.md', ''), true);
});

test('sniffText / plainlyBinary / bomKind / decodeBytes', function () {
  eq(M.sniffText(utf8('hello\nworld'), 11), true);
  eq(M.sniffText(bytes([]), 0), true);
  eq(M.sniffText(bytes([0x68, 0x00, 0x69]), 3), false);                       // NUL
  eq(M.sniffText(bytes([1, 2, 3, 4, 5, 6, 7, 8, 65]), 9), false);             // control junk
  eq(M.sniffText(bytes([0xFF, 0xFE, 0x68, 0x00]), 4), true);                  // UTF-16LE
  eq(M.sniffText(bytes([0xFF, 0xFE, 0x00, 0x00, 0x68, 0, 0, 0]), 8), false); // UTF-32LE
  eq(M.sniffText(bytes([0x63, 0x61, 0x66, 0xE9]), 4), true);                  // cp1252 "café"
  eq(M.sniffText(bytes([0x61, 0x81, 0x62]), 3), false);                       // cp1252 dead slot
  var cut = utf8('ab€');                                                      // € = 3 bytes
  eq(M.sniffText(cut.subarray(0, 4), 5), true);                               // window cut mid-char
  eq(M.sniffText(cut.subarray(0, 4), 4), false);                              // the WHOLE file ends mid-char: not clean text
  eq(M.bomKind(bytes([0xEF, 0xBB, 0xBF, 0x41])), 'utf-8');
  eq(M.bomKind(bytes([0xFE, 0xFF])), 'utf-16be');
  eq(M.bomKind(bytes([0x41])), '');
  eq(M.plainlyBinary(utf8('a,b\n1,2\n')), false);
  eq(M.plainlyBinary(bytes([0x41, 0, 0x42])), true);
  eq(M.plainlyBinary(bytes([0xFF, 0xFE, 0x41, 0x00])), false);
  eq(M.decodeBytes(utf8('﻿héllo')), 'héllo');                            // UTF-8 BOM dropped
  eq(M.decodeBytes(bytes([0x63, 0x61, 0x66, 0xE9])), 'café');                 // Windows-1252
  eq(M.decodeBytes(bytes([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00])), 'hi');       // UTF-16LE
  eq(M.decodeBytes(bytes([0xFE, 0xFF, 0x00, 0x68, 0x00, 0x69])), 'hi');       // UTF-16BE
});

// ---- the plan ------------------------------------------------------------------------------------
test('planMerge: filter, dot-folders, binary, caps, errors, order', function () {
  seq = 0;
  var list = [
    E('d/b.csv', 100), E('d/a.csv', 100), E('d/notes.md', 50), E('d/pic.png', 9), E('d/.git/config', 5),
    E('d/sheet.csv', 100, { type: 'application/vnd.ms-excel' }), E('d/big.txt', 6 * MB), E('d/x.dat', 7),
  ];
  var all = M.planMerge(list, { skipDot: true, by: 'path' });
  deep(paths(all.files), ['d/a.csv', 'd/b.csv', 'd/notes.md', 'd/sheet.csv', 'd/x.dat']);
  eq(all.skipped.dot, 1);
  deep(paths(all.skipped.binary), ['d/pic.png']);
  deep(paths(all.skipped.large), ['d/big.txt']);
  eq(all.nSkipped, 2);
  eq(all.bytes, 357);
  var csv = M.planMerge(list, { filter: M.parseFilter('csv'), skipDot: true, by: 'path' });
  deep(paths(csv.files), ['d/a.csv', 'd/b.csv', 'd/sheet.csv']);
  eq(csv.skipped.filtered, 4);           // md, png, big.txt, dat — the filter runs before binary checks
  eq(csv.skipped.dot, 1);
  // dot-folders kept when the option is off
  eq(M.planMerge(list, { skipDot: false }).files.some(function (e) { return e.path === 'd/.git/config'; }), true);
  // learnt while reading: sniffed binary, unreadable
  var kinds = {}; kinds[list[7].id] = 'binary'; kinds[list[2].id] = 'error';
  var k = M.planMerge(list, { skipDot: true, kinds: kinds });
  deep(paths(k.skipped.binary), ['d/pic.png', 'd/x.dat']);
  deep(paths(k.skipped.error), ['d/notes.md']);
  eq(k.nSkipped, 4);
});

test('planMerge: total cap keeps a prefix of the ORDERED list', function () {
  seq = 0;
  var H45 = 4.5 * MB;
  var list = [E('f3.txt', H45), E('f1.txt', 4 * MB), E('f2.txt', 4 * MB), E('f4.txt', 1), E('f10.txt', 4 * MB), E('f5.txt', 4 * MB), E('f11.txt', 1)];
  var p = M.planMerge(list, { by: 'path' });
  // 4 + 4 + 4.5 + 1 B + 4 = 16.5 MB + 1 B; f10 would pass 20 MB → it AND the tiny f11 after it are out
  deep(paths(p.files), ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
  deep(paths(p.skipped.over), ['f10.txt', 'f11.txt']);
  eq(p.bytes, 16.5 * MB + 1);
  eq(p.nSkipped, 2);
  // descending: f11 first, f1 is the one that no longer fits
  var d = M.planMerge(list, { by: 'path', desc: true });
  deep(paths(d.files), ['f11.txt', 'f10.txt', 'f5.txt', 'f4.txt', 'f3.txt', 'f2.txt']);
  deep(paths(d.skipped.over), ['f1.txt']);
  // own caps; size ties fall back to the path
  var c = M.planMerge(list, { by: 'size', perFile: 4.2 * MB, total: 9 * MB });
  deep(paths(c.files), ['f4.txt', 'f11.txt', 'f1.txt', 'f2.txt']);
  deep(paths(c.skipped.large), ['f3.txt']);
  deep(paths(c.skipped.over), ['f5.txt', 'f10.txt']);
  // the default caps are the documented ones
  eq(M.CAPS.perFile, 5 * MB);
  eq(M.CAPS.total, 20 * MB);
  eq(M.planMerge([E('x.txt', 5 * MB)], {}).files.length, 1);
  eq(M.planMerge([E('x.txt', 5 * MB + 1)], {}).skipped.large.length, 1);
});

// ---- text helpers --------------------------------------------------------------------------------
test('normalizeNewlines / trimEndWs / countLines', function () {
  eq(M.normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
  eq(M.normalizeNewlines('plain'), 'plain');
  eq(M.trimEndWs('a  \n\t\r\n  '), 'a');
  eq(M.trimEndWs('  a'), '  a');
  eq(M.trimEndWs('\n\n'), '');
  eq(M.countLines(''), 0);
  eq(M.countLines('a'), 1);
  eq(M.countLines('a\n'), 1);
  eq(M.countLines('a\nb'), 2);
  eq(M.countLines('\n'), 1);
  eq(M.countLines('a\n\n'), 2);
});

test('renderHeader: tokens, unknown tokens, escapes, CRLF', function () {
  var info = { name: 'jan.csv', path: 'data/2024/jan.csv', ext: 'csv', stem: 'jan', index: 3, total: 12, size: 2048 };
  eq(M.renderHeader('--- {name} ---', info), '--- jan.csv ---');
  eq(M.renderHeader('## {stem} ({ext}) {index}/{total} · {size} · {path} {nope}', info), '## jan (csv) 3/12 · 2.0 KB · data/2024/jan.csv {nope}');
  eq(M.renderHeader('{name}\\n===', info), 'jan.csv\n===');
  eq(M.renderHeader('{name}\\n===', info, '\r\n'), 'jan.csv\r\n===');
  eq(M.renderHeader('', info), '');
  eq(M.renderHeader('{name}', { name: '$&{path}', path: 'x', index: 1, total: 1, size: 0 }), '$&{path}'); // values are literal
});

test('escapeFences matches the core (reversible)', function () {
  eq(M.escapeFences('a\n```js\nx\n```'), 'a\n\\```js\nx\n\\```');
  eq(M.escapeFences('\\```'), '\\\\```');
});

// ---- the join --------------------------------------------------------------------------------------
var A = P('a.txt', 'A1\nA2'), B = P('b.txt', 'B1\nB2\n');
function J(parts, o) { return M.mergeTexts(parts, o).text; }

test('join: nothing = raw concatenation', function () {
  eq(J([A, B], { sep: 'none' }), 'A1\nA2B1\nB2\n');
  eq(J([B, A], { sep: 'none' }), 'B1\nB2\nA1\nA2');
  eq(J([P('a.txt', 'x\n'), P('b.txt', 'y\n')], { sep: 'none', trimEnd: true }), 'xy');
});

test('join: new line starts each file on its own line (never doubles)', function () {
  eq(J([A, B], { sep: 'newline' }), 'A1\nA2\nB1\nB2\n');
  eq(J([B, A], { sep: 'newline' }), 'B1\nB2\nA1\nA2\n');
  eq(J([A, P('e.txt', ''), B], { sep: 'newline' }), 'A1\nA2\nB1\nB2\n');
  eq(J([P('a', 'x\n\n'), P('b', 'y')], { sep: 'newline' }), 'x\n\ny\n');        // own blank lines kept…
  eq(J([P('a', 'x\n\n'), P('b', 'y')], { sep: 'newline', trimEnd: true }), 'x\ny\n'); // …unless trimmed
  eq(J([], { sep: 'newline' }), '');
});

test('join: blank line ensures exactly one empty line between', function () {
  eq(J([A, B], { sep: 'blank' }), 'A1\nA2\n\nB1\nB2\n');
  eq(J([B, B], { sep: 'blank' }), 'B1\nB2\n\nB1\nB2\n');
  eq(J([P('a', 'x\n\n\n'), P('b', 'y')], { sep: 'blank' }), 'x\n\n\ny\n');
  eq(J([P('a', 'x\n\n\n'), P('b', 'y')], { sep: 'blank', trimEnd: true }), 'x\n\ny\n');
  eq(J([P('a', ''), P('b', 'y')], { sep: 'blank' }), 'y\n');
});

test('join: header line from a template, blank line before each later header', function () {
  var out = J([P('dir/a.txt', 'A\n'), P('b.md', 'B')], { sep: 'header', template: '--- {name} ---' });
  eq(out, '--- a.txt ---\nA\n\n--- b.md ---\nB\n');
  var t2 = J([P('dir/a.txt', 'A'), P('e.txt', ''), P('b.md', 'B')], { sep: 'header', template: '# {index}/{total} {path}' });
  eq(t2, '# 1/3 dir/a.txt\nA\n\n# 2/3 e.txt\n\n# 3/3 b.md\nB\n');
});

test('join: fenced blocks exactly like the core Import (formatImportedFile)', function () {
  function core(path, content) { return path + '\n```\n' + M.escapeFences(content) + '\n```\n\n'; }
  var parts = [P('src/a.js', 'x()\n'), P('b.md', 'see ```code```')];
  eq(J(parts, { sep: 'fence' }), core('src/a.js', 'x()\n') + core('b.md', 'see ```code```'));
  eq(J(parts, { sep: 'fence', trimEnd: true }), core('src/a.js', 'x()') + core('b.md', 'see ```code```'));
});

test('join: BOM stripped; CRLF → LF; kept CRLF follows the files', function () {
  eq(J([P('a', '﻿A\r\nB\r\n'), P('b', 'C\rD')], { sep: 'newline' }), 'A\nB\nC\nD\n');
  var r = M.mergeTexts([P('a', 'A\r\nB'), P('b', 'C\r\nD')], { sep: 'blank', normalizeEol: false });
  eq(r.text, 'A\r\nB\r\n\r\nC\r\nD\r\n');
  eq(r.stats.eol, '\r\n');
  eq(J([P('a', 'A\r\nB'), P('b', 'C\nD'), P('c', 'E')], { sep: 'newline', normalizeEol: false }), 'A\r\nB\nC\nD\nE\n'); // LF majority
});

test('join: duplicate lines dropped across files, blank lines kept', function () {
  var r = M.mergeTexts([P('a', 'x\ny\n\nx\n'), P('b', 'y\nz\n\n\nz')], { sep: 'blank', dedupe: true });
  eq(r.text, 'x\ny\n\nz\n\n');   // a: x y _ (x) _   b: (y) z _ _ (z)
  eq(r.stats.dupes, 3);
  eq(M.mergeTexts([P('a', 'x\r\ny'), P('b', 'x\ny')], { sep: 'newline', dedupe: true, normalizeEol: false }).text, 'x\r\ny\n');
  // headers / fences are never deduped
  eq(J([P('a.txt', 'same'), P('b.txt', 'same')], { sep: 'header', template: '--- x ---', dedupe: true }), '--- x ---\nsame\n\n--- x ---\n');
});

test('join: stats', function () {
  var r = M.mergeTexts([A, B], { sep: 'newline' });
  eq(r.stats.files, 2);
  eq(r.stats.lines, 4);
  eq(r.stats.chars, 'A1\nA2\nB1\nB2\n'.length);
  eq(r.stats.csv, false);
});

// ---- CSV ------------------------------------------------------------------------------------------
var H = 'date,amount,note\n';
test('csv: identical headers kept once, rows joined line by line', function () {
  var r = M.mergeTexts([P('jan.csv', H + '1,2,a\n'), P('feb.csv', H + '3,4,b'), P('mar.csv', '﻿' + H + '5,6,c\n\n')], { sep: 'header', template: 'IGNORED', csv: true });
  eq(r.text, H + '1,2,a\n3,4,b\n5,6,c\n');
  eq(r.stats.csv, true);
  eq(r.stats.csvKind, 'csv');
  eq(r.stats.csvHeadersDropped, 2);
  deep(r.stats.csvMismatch, []);
});

test('csv: quoting / spacing differences still match; CRLF rows', function () {
  var r = M.mergeTexts([P('a.csv', 'name,"city, st"\r\nann,"x, y"\r\n'), P('b.csv', '"name" , "city, st"\r\nbob,z\r\n')], { csv: true });
  eq(r.text, 'name,"city, st"\nann,"x, y"\nbob,z\n');
  eq(r.stats.csvHeadersDropped, 1);
});

test('csv: a different header is kept and reported; empty + header-only files', function () {
  var r = M.mergeTexts([
    P('a.csv', H + '1,2,a'), P('empty.csv', '  \n'), P('only.csv', H), P('other.csv', 'date,amount\n9,9\n'), P('b.csv', H + '3,4,b'),
  ], { csv: true });
  eq(r.text, H + '1,2,a\ndate,amount\n9,9\n3,4,b\n');
  deep(r.stats.csvMismatch, ['other.csv']);
  eq(r.stats.csvEmpty, 1);
  eq(r.stats.csvHeadersDropped, 2);
});

test('csv: TSV, mixed CSV/TSV, multi-line quoted header, CSV mode off', function () {
  eq(J([P('a.tsv', 'x\ty\n1\t2\n'), P('b.tsv', 'x\ty\n3\t4\n')], { csv: true }), 'x\ty\n1\t2\n3\t4\n');
  var mixed = M.mergeTexts([P('a.csv', 'x,y\n1,2'), P('b.tsv', 'x\ty\n3\t4')], { csv: true });
  eq(mixed.stats.csvKind, 'mixed');
  deep(mixed.stats.csvMismatch, ['b.tsv']);
  eq(J([P('a.csv', '"long\nhead",b\n1,2\n'), P('b.csv', '"long\nhead",b\n3,4\n')], { csv: true }), '"long\nhead",b\n1,2\n3,4\n');
  eq(J([P('a.csv', H + '1'), P('b.csv', H + '2')], { csv: false, sep: 'newline' }), H + '1\n' + H + '2\n');
  // not every file is CSV → normal join
  var r = M.mergeTexts([P('a.csv', H + '1'), P('n.txt', 'note')], { csv: true, sep: 'newline' });
  eq(r.stats.csv, false);
  eq(r.text, H + '1\nnote\n');
});

test('csv: duplicate rows dropped (quoted line breaks respected), header protected', function () {
  var r = M.mergeTexts([
    P('a.csv', 'k,v\n1,"two\nlines"\n2,x\n'), P('b.csv', 'k,v\n2,x\n1,"two\nlines"\n3,y\nk,v\n'),
  ], { csv: true, dedupe: true });
  eq(r.text, 'k,v\n1,"two\nlines"\n2,x\n3,y\n');
  eq(r.stats.dupes, 3);   // 2,x · the quoted row · a stray header row
});

test('csvKind / csvHeaderKey', function () {
  eq(M.csvKind([P('a.csv', ''), P('b.CSV', '')]), 'csv');
  eq(M.csvKind([P('a.tsv', '')]), 'tsv');
  eq(M.csvKind([P('a.csv', ''), P('b.txt', '')]), '');
  eq(M.csvKind([]), '');
  eq(M.csvHeaderKey(' a , "b ""q""" ,c\r', ','), ['a', 'b "q"', 'c'].join('\u0000'));
});

// ---- names --------------------------------------------------------------------------------------------
test('toRoomName / uniqueName', function () {
  eq(M.toRoomName('  My Data.csv  '), 'my data-csv');
  eq(M.toRoomName('__secret'), 'secret');
  eq(M.toRoomName('a/b#c$d[e]'), 'a-b-c-d-e');
  eq(M.toRoomName('x'.repeat(130)).length, 100);
  eq(M.toRoomName('...'), '');
  eq(M.toRoomName('Q3 — Reports'), 'q3 — reports');
  eq(M.uniqueName('x', ['x', 'x 2']), 'x 3');
  eq(M.uniqueName('y', ['x']), 'y');
});

test('safeFileName / suggestExt / mimeFor / clip', function () {
  eq(M.safeFileName('my:file?', 'txt'), 'my-file-.txt');
  eq(M.safeFileName('report.csv', 'csv'), 'report.csv');
  eq(M.safeFileName('', 'TXT', 'merged'), 'merged.txt');
  eq(M.safeFileName('notes', '.md'), 'notes.md');
  eq(M.safeFileName('..hidden', ''), 'hidden');
  var csvs = [P('a.csv', ''), P('b.csv', '')];
  eq(M.suggestExt(csvs, { csv: true }), 'csv');
  eq(M.suggestExt(csvs, { csv: false, sep: 'newline' }), 'csv');
  eq(M.suggestExt([P('a.tsv', '')], { csv: true }), 'tsv');
  eq(M.suggestExt([P('a.md', ''), P('b.md', '')], {}), 'md');
  eq(M.suggestExt([P('a.md', ''), P('b.txt', '')], {}), 'txt');
  eq(M.suggestExt([P('a.js', '')], { sep: 'fence' }), 'md');
  eq(M.suggestExt([P('Makefile', '')], {}), 'txt');
  eq(M.mimeFor('csv'), 'text/csv;charset=utf-8');
  eq(M.mimeFor('xyz'), 'text/plain;charset=utf-8');
  eq(M.clip('abc', 5), 'abc');
  eq(M.clip('ab😀c', 3), 'ab');      // never half an emoji
  eq(M.clip('abcdef', 3), 'abc');
});

console.log(passed + ' passed' + (failed ? ', ' + failed + ' failed' : ''));
