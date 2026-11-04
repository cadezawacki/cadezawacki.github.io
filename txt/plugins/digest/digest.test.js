/* Unit tests for the Digest & Todo core (digest-core.js).
 * Not loaded by the app (not in the manifest). Run: node txt/plugins/digest/digest.test.js */
'use strict';
var assert = require('assert');
var M = require('./digest-core.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var Y = '\u00a5';
function ents(text, mode) {
  return M.extract(text, { mode: mode || 'room' }).entries.map(function (e) {
    return e.group + '|' + e.depth + '|' + (e.done ? 'x' : ' ') + '|' + e.text;
  });
}
var META = { at: '2026-11-04 14:32', ws: 'Home', room: 'digest' };
function withMeta(list, m) { list.forEach(function (e) { if (!e.meta) e.meta = Object.assign({}, m || META); }); return list; }
function file(doc, input, opts, meta) {
  var ex = M.extract(input, { mode: 'room' });
  return M.insertEntries(doc, withMeta(ex.entries, meta), Object.assign({ groups: ex.groups }, opts || {}));
}
var LATER = { at: '2026-11-05 10:00', ws: 'Home', room: 'digest' };

// ---- the user's own examples ------------------------------------------------------------
test('example: "group:" over bullets', function () {
  assert.deepStrictEqual(ents('group:\n- entry 1\n- entry 2'), ['GROUP|0| |entry 1', 'GROUP|0| |entry 2']);
});
test('example: GROUP over bullets', function () {
  assert.deepStrictEqual(ents('GROUP\n- entry 1\n- entry 2'), ['GROUP|0| |entry 1', 'GROUP|0| |entry 2']);
});
test('example: GROUP over bare lines', function () {
  assert.deepStrictEqual(ents('GROUP\nentry 1\nentry 2'), ['GROUP|0| |entry 1', 'GROUP|0| |entry 2']);
});
test('example: a lone entry goes to UNCATEGORIZED', function () {
  assert.deepStrictEqual(ents('entry 1'), ['UNCATEGORIZED|0| |entry 1']);
});
test('example: @digest in another room', function () {
  var ex = M.extract('Notes\n\n@digest\ngroup:\n- entry 1\n- entry 2\n\nLater prose.', { mode: 'blocks' });
  assert.deepStrictEqual(ex.entries.map(function (e) { return e.group + '|' + e.text; }), ['GROUP|entry 1', 'GROUP|entry 2']);
  assert.strictEqual(ex.remainder, 'Notes\n\nLater prose.');
});
test('example: tags ¥tag and #tag', function () {
  assert.deepStrictEqual(ents('- entry 1 ' + Y + 'tag\n- entry 2 #tag'), ['UNCATEGORIZED|0| |entry 1 ' + Y + 'tag', 'UNCATEGORIZED|0| |entry 2 ' + Y + 'tag']);
});

// ---- header variants ----------------------------------------------------------------------
test('header variants (case-insensitive, trimmed)', function () {
  var forms = ['group', 'group:', 'group -', 'group —', '[group]', '[ group ]', '  [ Group ]  ', '# group', '## Group',
    '**group**', '== group ==', '-- group', '>> group', 'Group:', 'GROUP', '- group:', '1. group:', '\u3010group\u3011'];
  forms.forEach(function (h) {
    assert.deepStrictEqual(ents(h + '\n- milk'), ['GROUP|0| |milk'], 'form: ' + JSON.stringify(h));
  });
  assert.deepStrictEqual(ents('Group\n=====\nmilk'), ['GROUP|0| |milk']);           // setext underline
  assert.deepStrictEqual(ents('  my   big   group :\n- x'), ['MY BIG GROUP|0| |x']);
});
test('entry variants', function () {
  var forms = ['- x', '* x', '+ x', '\u2022 x', '\u00b7 x', '1. x', '2) x', '\u2013 x', '\u2192 x', '[ ] x', '- [ ] x', '* [ ] x', '\u2610 x', '[ ]x'];
  forms.forEach(function (f) { assert.deepStrictEqual(ents('g:\n' + f), ['G|0| |x'], 'form: ' + JSON.stringify(f)); });
  ['[x] x', '- [X] x', '\u2611 x', '\u2713 x', '\u2714 x', '\u2705 x'].forEach(function (f) {
    assert.deepStrictEqual(ents('g:\n' + f), ['G|0|x|x'], 'done form: ' + JSON.stringify(f));
  });
});
test('the key rule: a bare line followed by entries is a title', function () {
  assert.deepStrictEqual(ents('groceries\n- milk\n- eggs'), ['GROCERIES|0| |milk', 'GROCERIES|0| |eggs']);
  assert.deepStrictEqual(ents('groceries\n  milk\n  eggs'), ['GROCERIES|0| |milk', 'GROCERIES|0| |eggs']);   // indented under it
  assert.deepStrictEqual(ents('call mom\nbuy milk'), ['CALL MOM|0| |buy milk']);                            // opens a bare paragraph
  assert.deepStrictEqual(ents('call mom\n\nbuy milk'), ['UNCATEGORIZED|0| |call mom', 'UNCATEGORIZED|0| |buy milk']);
  assert.deepStrictEqual(ents('- a\n- b'), ['UNCATEGORIZED|0| |a', 'UNCATEGORIZED|0| |b']);
  assert.deepStrictEqual(ents('https://example.com/x\n- read it'), ['UNCATEGORIZED|0| |https://example.com/x', 'UNCATEGORIZED|0| |read it']);
});
test('a header covers its paragraph; one standing alone covers the next', function () {
  assert.deepStrictEqual(ents('[ WORK ]\n\nemail bob\ncall alice'), ['WORK|0| |email bob', 'WORK|0| |call alice']);
  assert.deepStrictEqual(ents('[ WORK ]\n\n- a\n\n- b'), ['WORK|0| |a', 'UNCATEGORIZED|0| |b']);
  assert.deepStrictEqual(ents('work:\n- a\n\n- b'), ['WORK|0| |a', 'UNCATEGORIZED|0| |b']);
  assert.deepStrictEqual(ents('groceries:\n- milk\n\ncall mom'), ['GROCERIES|0| |milk', 'UNCATEGORIZED|0| |call mom']);
  assert.deepStrictEqual(ents('groceries\n- milk\n\n- other'), ['GROCERIES|0| |milk', 'UNCATEGORIZED|0| |other']);
  assert.deepStrictEqual(ents('work:\n- a\nhome:\n- b\n\n- c'), ['WORK|0| |a', 'HOME|0| |b', 'UNCATEGORIZED|0| |c']);
  assert.deepStrictEqual(ents('[ WORK ]\nemail bob\ncall alice'), ['WORK|0| |email bob', 'WORK|0| |call alice']);
  assert.deepStrictEqual(ents('GROUP\nentry 1\n\ncall mom'), ['GROUP|0| |entry 1', 'UNCATEGORIZED|0| |call mom']);
});
test('ALL CAPS: a header when entries follow, else an entry', function () {
  assert.deepStrictEqual(ents('CALL IRS'), ['UNCATEGORIZED|0| |CALL IRS']);
  assert.deepStrictEqual(ents('- milk\nURGENT'), ['UNCATEGORIZED|0| |milk', 'UNCATEGORIZED|0| |URGENT']);
  assert.deepStrictEqual(ents('work:\n- a\nASAP'), ['WORK|0| |a', 'WORK|0| |ASAP']);
  assert.deepStrictEqual(ents('TODO\n\n- x'), ['TODO|0| |x']);
  assert.deepStrictEqual(ents('OK go'), ['UNCATEGORIZED|0| |OK go']);
});
test('nesting by indentation (relative, capped)', function () {
  assert.deepStrictEqual(ents('g:\n- a\n  - a1\n    - a11\n- b'), ['G|0| |a', 'G|1| |a1', 'G|2| |a11', 'G|0| |b']);
  assert.deepStrictEqual(ents('g:\n    - a\n    - b'), ['G|0| |a', 'G|0| |b']);
  assert.deepStrictEqual(ents('g:\n- a\n\t- a1'), ['G|0| |a', 'G|1| |a1']);
  assert.deepStrictEqual(ents('g:\n- 1\n - 2\n  - 3\n   - 4\n    - 5').map(function (s) { return s.split('|')[1]; }), ['0', '1', '2', '3', '3']);
});
test('noise lines are ignored', function () {
  assert.deepStrictEqual(ents('---\n- a\n***\n\n#\n- b\n\u2713'), ['UNCATEGORIZED|0| |a', 'UNCATEGORIZED|0| |b']);
  assert.deepStrictEqual(ents('   \n\n'), []);
  assert.deepStrictEqual(ents('[ ]\n- \n[x]'), []);
});
test('not headers: times, mid-line colons, bullets ending in a dash', function () {
  assert.deepStrictEqual(ents('meet at 10:30'), ['UNCATEGORIZED|0| |meet at 10:30']);
  assert.deepStrictEqual(ents('TODO: call mom'), ['UNCATEGORIZED|0| |TODO: call mom']);
  assert.deepStrictEqual(ents('- buy milk -'), ['UNCATEGORIZED|0| |buy milk -']);
  assert.deepStrictEqual(ents('**bold** words'), ['UNCATEGORIZED|0| |**bold** words']);
  assert.deepStrictEqual(ents('e-mail-'), ['UNCATEGORIZED|0| |e-mail-']);
});

// ---- tags --------------------------------------------------------------------------------
test('tags: grammar and normalisation', function () {
  assert.deepStrictEqual(M.tagNames('a ' + Y + 'Work b #home/garden c ' + Y + 'x-'), ['work', 'home/garden', 'x']);
  assert.deepStrictEqual(M.tagNames('fix #123 in C# — mail@x.com (#ok) https://x.y/#frag `#code`'), ['ok']);
  assert.strictEqual(M.normalizeTags('a #b ' + Y + 'c', Y), 'a ' + Y + 'b ' + Y + 'c');
  assert.strictEqual(M.normalizeTags('a #b ' + Y + 'c', '#'), 'a #b #c');
  assert.strictEqual(M.normalizeTags('a #b \u20acc', '\u20ac'), 'a \u20acb \u20acc');
  assert.strictEqual(M.normalizeTags('see https://x.y/#frag and `#x`', Y), 'see https://x.y/#frag and `#x`');
  assert.strictEqual(M.normalizeTags('a#b', Y), 'a#b');
});
test('tags in digested entries land with the sentinel', function () {
  var ex = M.extract('- pay #rent ' + Y + 'home', { mode: 'room', sentinel: '\u00a7' });
  assert.strictEqual(ex.entries[0].text, 'pay \u00a7rent \u00a7home');
});

// ---- @digest blocks ----------------------------------------------------------------------
test('blocks: where they end', function () {
  var L = [
    'intro',            // 0
    '@digest',          // 1
    '- a',              // 2
    '',                 // 3
    'home:',            // 4  marked header after a blank: still in
    '- b',              // 5
    '',                 // 6
    'Some prose.',      // 7  prose after a blank: out
    '@digest work:',    // 8  inline content
    '- c',              // 9
    '',                 // 10
    '',                 // 11 two blanks: out
    '- d',              // 12
    '@digest',          // 13
    '- e',              // 14
    '@end',             // 15
    '- f',              // 16
  ];
  var B = M.findBlocks(L);
  assert.deepStrictEqual(B.map(function (b) { return [b.start, b.last, b.end, b.inline]; }), [[1, 5, 5, ''], [8, 9, 9, 'work:'], [13, 14, 15, '']]);
  var ex = M.extract(L.join('\n'), { mode: 'blocks' });
  assert.deepStrictEqual(ex.entries.map(function (e) { return e.group + '|' + e.text; }), ['UNCATEGORIZED|a', 'HOME|b', 'WORK|c', 'UNCATEGORIZED|e']);
  assert.strictEqual(ex.remainder, 'intro\n\nSome prose.\n\n\n- d\n- f');
});
test('blocks: a # heading after a blank line is the document, not the digest', function () {
  var ex = M.extract('@digest\n- a\n\n## Notes\nSome notes', { mode: 'blocks' });
  assert.deepStrictEqual(ex.entries.map(function (e) { return e.text; }), ['a']);
  assert.strictEqual(ex.remainder, '## Notes\nSome notes');
  // ...but right under the directive it can name a group
  assert.deepStrictEqual(ents('@digest\n# Groceries\n- milk', 'blocks'), ['GROCERIES|0| |milk']);
});
test('blocks: inline content, fences, nav links, case', function () {
  assert.deepStrictEqual(ents('@digest call mom', 'blocks'), ['UNCATEGORIZED|0| |call mom']);
  assert.deepStrictEqual(ents('@Digest: groceries\n- milk', 'blocks'), ['GROCERIES|0| |milk']);
  assert.deepStrictEqual(ents('```\n@digest\n- a\n```', 'blocks'), []);
  assert.deepStrictEqual(ents('@digest:room is a link', 'blocks'), []);
  assert.deepStrictEqual(ents('see @digest later', 'blocks'), []);
  assert.deepStrictEqual(ents('@digest\n- a\n```\ncode\n```', 'blocks'), ['UNCATEGORIZED|0| |a']);
  assert.strictEqual(M.hasDirective('x\n  @digest\n- y'), true);
  assert.strictEqual(M.hasDirective('the @digestive system'), false);
});
test('blocks: an empty directive takes nothing', function () {
  var ex = M.extract('notes\n@digest\n', { mode: 'blocks' });
  assert.strictEqual(ex.entries.length, 0);
});
test('remainder: no stray blank lines', function () {
  assert.strictEqual(M.extract('notes\n\n@digest\n- a\n', { mode: 'blocks' }).remainder, 'notes\n');
  assert.strictEqual(M.extract('notes\n\n@digest\n- a', { mode: 'blocks' }).remainder, 'notes');
  assert.strictEqual(M.extract('@digest\n- a\n\nnotes', { mode: 'blocks' }).remainder, 'notes');
  assert.strictEqual(M.extract('a\n@digest\n- x\n\nb', { mode: 'blocks' }).remainder, 'a\n\nb');
  // a line straight under an entry is part of the block
  assert.strictEqual(M.extract('a\n@digest\n- x\nb', { mode: 'blocks' }).remainder, 'a');
  assert.strictEqual(M.extract('@digest\n- x', { mode: 'blocks' }).remainder, '');
});
test('digest room: everything goes, fenced code stays', function () {
  var ex = M.extract('- a\n@digest\n```\nkeep me\n```\n\n- b\n@end', { mode: 'room' });
  assert.deepStrictEqual(ex.entries.map(function (e) { return e.text; }), ['a', 'b']);
  assert.strictEqual(ex.remainder, '```\nkeep me\n```');
  assert.strictEqual(M.extract('- a\n\n- b\n', { mode: 'room' }).remainder, '');
  assert.deepStrictEqual(ents('@digest work:\n- a'), ['WORK|0| |a']);
});
test('marks: header and entry lines for the live preview', function () {
  var ex = M.extract('x\n\n@digest\nwork:\n- a\nb', { mode: 'blocks' });
  assert.deepStrictEqual(ex.marks.map(function (m) { return m.line + ':' + m.kind; }), ['3:head', '4:entry', '5:entry']);
  var ex2 = M.extract('groceries\n- milk', { mode: 'room' });
  assert.deepStrictEqual(ex2.marks.map(function (m) { return m.line + ':' + m.kind + (m.implicit ? '*' : ''); }), ['0:head*', '1:entry']);
});
test('struck-through input is read clean', function () {
  var struck = 'm\u0336i\u0336l\u0336k\u0336';
  assert.deepStrictEqual(ents('- [x] ' + struck), ['UNCATEGORIZED|0|x|milk']);
});

// ---- metadata ----------------------------------------------------------------------------
test('meta: format and parse round trip', function () {
  var m = { at: '2026-11-04 14:32', ws: 'Work', room: 'meeting notes', done: '2026-11-05 09:12', extra: [] };
  var s = M.fmtMeta(m);
  assert.strictEqual(s, ' (2026-11-04 14:32 \u00b7 Work \u203a meeting notes \u00b7 \u2713 2026-11-05 09:12)');
  var sm = M.splitMeta('email bob' + s);
  assert.strictEqual(sm.text, 'email bob');
  assert.deepStrictEqual(sm.meta, m);
  assert.deepStrictEqual(M.splitMeta('x (2026-11-04 14:32 \u00b7 digest)').meta, { at: '2026-11-04 14:32', ws: '', room: 'digest', done: '', extra: [] });
  assert.strictEqual(M.fmtMeta({ done: '2026-11-05 09:12' }), ' (\u2713 2026-11-05 09:12)');
  assert.strictEqual(M.fmtMeta({}), '');
});
test('meta: asides are not metadata', function () {
  ['pay rent (2026-11-04)', 'call (bring the receipt)', 'meet (2026-11-04 10:00) then lunch', 'x (2026-11-04 10:00 at the bank)'].forEach(function (t) {
    assert.strictEqual(M.splitMeta(t).meta, null, t);
    assert.strictEqual(M.splitMeta(t).text, t);
  });
  // the LAST group is the metadata, an earlier one stays text
  var sm = M.splitMeta('meet (2026-11-04 10:00 \u00b7 x) then (2026-11-04 14:32 \u00b7 digest)');
  assert.strictEqual(sm.text, 'meet (2026-11-04 10:00 \u00b7 x) then');
  assert.strictEqual(sm.meta.room, 'digest');
  // a room name with brackets
  assert.strictEqual(M.splitMeta('x (2026-11-04 14:32 \u00b7 notes (old))').meta.room, 'notes (old)');
});
test('meta: separators in names are made safe', function () {
  var s = M.fmtMeta({ at: '2026-11-04 14:32', ws: 'A \u00b7 B', room: 'r \u203a s\nt' });
  assert.strictEqual(s, ' (2026-11-04 14:32 \u00b7 A - B \u203a r > s t)');
  assert.deepStrictEqual(M.splitMeta('x' + s).meta.room, 'r > s t');
});
test('meta: pasted todo lines keep their own metadata', function () {
  var ex = M.extract('[ ] milk (2025-01-02 03:04 \u00b7 Old \u203a notes)', { mode: 'room' });
  assert.strictEqual(ex.entries[0].text, 'milk');
  assert.deepStrictEqual(ex.entries[0].meta, { at: '2025-01-02 03:04', ws: 'Old', room: 'notes', done: '', extra: [] });
});

// ---- the todo room -----------------------------------------------------------------------
test('filing: sections, order, UNCATEGORIZED last, blank lines', function () {
  var r1 = file('', 'call mom');
  assert.strictEqual(r1.text, '[ UNCATEGORIZED ]\n[ ] call mom (2026-11-04 14:32 \u00b7 Home \u203a digest)');
  var r2 = file(r1.text, 'work:\n- email bob\n- deck');
  assert.strictEqual(r2.text, [
    '[ WORK ]',
    '[ ] email bob (2026-11-04 14:32 \u00b7 Home \u203a digest)',
    '[ ] deck (2026-11-04 14:32 \u00b7 Home \u203a digest)',
    '',
    '[ UNCATEGORIZED ]',
    '[ ] call mom (2026-11-04 14:32 \u00b7 Home \u203a digest)',
  ].join('\n'));
  assert.deepStrictEqual(r2.created, ['WORK']);
  var r3 = file(r2.text, '- stray\n\nWork:\n- slides\nhome:\n- dishes\n\n- dried mango');
  var L = r3.text.split('\n');
  assert.deepStrictEqual(L.filter(function (l) { return /^\[ [A-Z]/.test(l); }), ['[ WORK ]', '[ HOME ]', '[ UNCATEGORIZED ]']);
  assert.ok(L.indexOf('[ ] slides (2026-11-04 14:32 \u00b7 Home \u203a digest)') === 3, 'appended at the end of WORK');
  assert.ok(/\[ \] dried mango/.test(L[L.length - 1]), 'past the blank line: uncategorized, at the end');
  assert.ok(/\[ \] stray/.test(L[L.length - 2]), 'uncategorized appended at the end');
  assert.ok(!/\n\n\n/.test(r3.text), 'no double blank lines');
});
test('filing: into an existing room with its own style', function () {
  var doc = '# My todo\n\n## Groceries\n- [ ] bread\n\nnotes at the bottom\n';
  var r = file(doc, 'groceries:\n- milk');
  assert.strictEqual(r.text, '# My todo\n\n## Groceries\n- [ ] bread\n- [ ] milk (2026-11-04 14:32 \u00b7 Home \u203a digest)\n\nnotes at the bottom\n');
  var r2 = file('[ A ]\n[ ] x\n\n\n', 'b:\n- y');
  assert.strictEqual(r2.text, '[ A ]\n[ ] x\n\n[ B ]\n[ ] y (2026-11-04 14:32 \u00b7 Home \u203a digest)\n\n\n');
  var r3 = file('[ UNCATEGORIZED ]\n[ ] u', 'g:\n- x');
  assert.strictEqual(r3.text, '[ G ]\n[ ] x (2026-11-04 14:32 \u00b7 Home \u203a digest)\n\n[ UNCATEGORIZED ]\n[ ] u');
  var r4 = file('[ A ]\n[ ] a\n[ UNCATEGORIZED ]\n[ ] u', 'g:\n- x');
  assert.strictEqual(r4.text, '[ A ]\n[ ] a\n\n[ G ]\n[ ] x (2026-11-04 14:32 \u00b7 Home \u203a digest)\n\n[ UNCATEGORIZED ]\n[ ] u');
});
test('filing: nested entries are indented by the core unit', function () {
  var r = file('', 'g:\n- a\n  - a1');
  assert.strictEqual(r.text.split('\n')[2], '    [ ] a1 (2026-11-04 14:32 \u00b7 Home \u203a digest)');
  var P = M.parseTodo(r.text);
  assert.deepStrictEqual(P.items.map(function (i) { return i.depth; }), [0, 1]);
});
test('filing: done entries keep their state and get a done stamp', function () {
  var r = file('', '[x] paid');
  assert.strictEqual(r.text.split('\n')[1], '[x] paid (2026-11-04 14:32 \u00b7 Home \u203a digest \u00b7 \u2713 2026-11-04 14:32)');
});
test('dedupe: open duplicates in the same group are skipped', function () {
  var a = file('', 'groceries:\n- Milk  ' + Y + 'errand\n- milk #errand\n- eggs');
  assert.strictEqual(a.added.length, 2);
  assert.strictEqual(a.skipped, 1);
  var b = file(a.text, 'groceries:\n- milk ' + Y + 'errand\n- bread', {});
  assert.strictEqual(b.added.length, 1);
  assert.strictEqual(b.skipped, 1);
  var c = file(a.text, 'other:\n- milk ' + Y + 'errand');            // another group: added
  assert.strictEqual(c.added.length, 1);
  var off = file(a.text, 'groceries:\n- eggs', { dedupe: false }, LATER);
  assert.strictEqual(off.added.length, 1);
  // a checked-off item doesn't block adding it again
  var P = M.parseTodo(a.text), eggs = P.items.filter(function (i) { return i.text === 'eggs'; })[0];
  var t = M.toggleAt(a.text, eggs.line, eggs.raw, { stamp: true, now: '2026-11-05 09:00' });
  assert.strictEqual(file(t, 'groceries:\n- eggs', {}, LATER).added.length, 1);
});
test('dedupe: a replayed capture is never filed twice', function () {
  var ex = M.extract('g:\n- a\n  - note\n- b\n  - note', { mode: 'room' });
  withMeta(ex.entries);
  var once = M.insertEntries('', ex.entries, {});
  assert.strictEqual(once.added.length, 4, 'two different parents may share a child text');
  var twice = M.insertEntries(once.text, ex.entries, {});
  assert.strictEqual(twice.added.length, 0);
  assert.strictEqual(twice.text, once.text);
});
test('filing: groups named with no entries still get a section', function () {
  var r = file('', '[ LATER ]\n\nwork:\n- x');
  assert.deepStrictEqual(r.created, ['WORK', 'LATER']);
  assert.ok(/\[ LATER \]/.test(r.text));
});

test('parseTodo: sections, items, notes, fences, meta, struck text', function () {
  var doc = [
    'preamble [ ] not a todo',
    '[ ] top-level',
    '[ WORK ]',
    '[ ] a ' + Y + 'x (2026-11-04 14:32 \u00b7 W \u203a r)',
    '    - [x] a1',
    'a note',
    '[x] d\u0336o\u0336n\u0336e\u0336',
    '## Home',
    '1. [ ] numbered',
    '```',
    '[ ] in code',
    '```',
    '[x]',
    '[ X ]',
  ].join('\n');
  var P = M.parseTodo(doc);
  assert.deepStrictEqual(P.sections.map(function (s) { return s.key + '@' + s.line + ':' + s.style; }), ['@-1:', 'WORK@2:bracket', 'HOME@7:md', 'X@13:bracket']);
  var todos = P.items.filter(function (i) { return i.kind === 'todo'; });
  assert.deepStrictEqual(todos.map(function (i) { return i.text + '|' + i.done + '|' + i.depth; }), ['top-level|false|0', 'a ' + Y + 'x|false|0', 'a1|true|1', 'done|true|0', 'numbered|false|0', '|true|0']);
  assert.deepStrictEqual(todos[1].meta, { at: '2026-11-04 14:32', ws: 'W', room: 'r', done: '', extra: [] });
  assert.deepStrictEqual(todos[1].tags, ['x']);
  assert.strictEqual(todos[3].struck, true);
  assert.strictEqual(todos[4].marker, '1. ');
  assert.deepStrictEqual(P.items.filter(function (i) { return i.kind === 'note'; }).map(function (i) { return i.text; }), ['preamble [ ] not a todo', 'a note', '```', '[ ] in code', '```']);
});

test('toggle: done stamp in, struck text out, the rest untouched', function () {
  var line = '  - [ ] a ' + Y + 'x (2026-11-04 14:32 \u00b7 W \u203a r)';
  var on = M.toggleLine(line, { stamp: true, now: '2026-11-05 09:12' });
  assert.strictEqual(on, '  - [x] a ' + Y + 'x (2026-11-04 14:32 \u00b7 W \u203a r \u00b7 \u2713 2026-11-05 09:12)');
  assert.strictEqual(M.toggleLine(on, { stamp: true }), line);
  assert.strictEqual(M.toggleLine('[ ] plain', { stamp: false }), '[x] plain');
  assert.strictEqual(M.toggleLine('[ ] plain', { stamp: true, now: '2026-11-05 09:12' }), '[x] plain (\u2713 2026-11-05 09:12)');
  assert.strictEqual(M.toggleLine('[x] d\u0336o\u0336n\u0336e\u0336', {}), '[ ] done');
  assert.strictEqual(M.toggleLine('not a todo', {}), null);
});
test('locate: moved lines are found, ambiguous ones are not', function () {
  var L = ['a', 'b', 'c', 'b'];
  assert.strictEqual(M.locate(L, 2, 'c'), 2);
  assert.strictEqual(M.locate(L, 0, 'c'), 2);
  assert.strictEqual(M.locate(L, 0, 'b'), -1);
  assert.strictEqual(M.locate(L, 1, 'b'), 1);
  assert.strictEqual(M.locate(L, 0, 'zzz'), -1);
});
test('edit text keeps the box, the marker and the metadata', function () {
  var doc = '[ G ]\n- [x] old (2026-11-04 14:32 \u00b7 r)';
  assert.strictEqual(M.setTextAt(doc, 1, '- [x] old (2026-11-04 14:32 \u00b7 r)', 'new #tag', { sentinel: Y }), '[ G ]\n- [x] new ' + Y + 'tag (2026-11-04 14:32 \u00b7 r)');
  assert.strictEqual(M.setTextAt(doc, 1, 'gone', 'x', {}), null);
});
test('make todo from a note', function () {
  assert.strictEqual(M.makeTodoAt('[ G ]\n  - milk', 1, '  - milk'), '[ G ]\n  [ ] milk');
  assert.strictEqual(M.makeTodoAt('\u2611 done', 0, '\u2611 done'), '[x] done');
  assert.strictEqual(M.makeTodoAt('[ ] already', 0, '[ ] already'), null);
});
test('delete takes sub-items along and tidies up', function () {
  var doc = '[ A ]\n[ ] a\n    [ ] a1\n[ ] b\n\n[ B ]\n[ ] only\n\n[ C ]\n[ ] c';
  var d = M.deleteAt(doc, 1, '[ ] a');
  assert.strictEqual(d.text, '[ A ]\n[ ] b\n\n[ B ]\n[ ] only\n\n[ C ]\n[ ] c');
  assert.strictEqual(d.count, 2);
  var e = M.deleteAt(doc, 6, '[ ] only');
  assert.strictEqual(e.text, '[ A ]\n[ ] a\n    [ ] a1\n[ ] b\n\n[ C ]\n[ ] c', 'an emptied [ GROUP ] goes');
  assert.strictEqual(M.deleteAt('## Mine\n[ ] x', 1, '[ ] x').text, '## Mine', 'a heading of your own stays');
});
test('move: to an existing group, a new one, with sub-items, adopting the style', function () {
  var doc = '[ A ]\n[ ] a\n    [ ] a1\n[ ] keep\n\n## B\n- [ ] b';
  var m = M.moveAt(doc, 1, '[ ] a', 'b');
  assert.strictEqual(m, '[ A ]\n[ ] keep\n\n## B\n- [ ] b\n- [ ] a\n    [ ] a1');
  var n = M.moveAt(doc, 3, '[ ] keep', 'New one');
  assert.strictEqual(n, '[ A ]\n[ ] a\n    [ ] a1\n\n## B\n- [ ] b\n\n[ NEW ONE ]\n[ ] keep');
  assert.strictEqual(M.moveAt(doc, 3, '[ ] keep', 'a'), doc, 'already in that group');
  var o = M.moveAt('[ A ]\n[ ] solo\n\n[ B ]\n[ ] b', 1, '[ ] solo', 'B');
  assert.strictEqual(o, '[ B ]\n[ ] b\n[ ] solo', 'the emptied section goes');
});
test('clear done: checked items go, open sub-items keep their parent', function () {
  var doc = '[ A ]\n[x] a\n    [ ] a1\n[x] b\n    [x] b1\n[ ] c\n\n[ B ]\n[x] gone\n\n[ C ]\n[ ] c2';
  var r = M.clearDone(doc);
  assert.strictEqual(r.removed, 3);
  assert.strictEqual(r.text, '[ A ]\n[x] a\n    [ ] a1\n[ ] c\n\n[ C ]\n[ ] c2');
  assert.deepStrictEqual(M.clearDone('[ ] x'), { text: '[ ] x', removed: 0 });
});
test('remove lines: an undone digest comes back out', function () {
  var r = file('[ A ]\n[ ] keep', 'a:\n- x\nnew:\n- y');
  var back = M.removeLines(r.text, r.added.map(function (a) { return a.line; }), r.created);
  assert.strictEqual(back, '[ A ]\n[ ] keep');
});
test('stats', function () {
  var doc = [
    '[ ] a (2026-11-05 08:00 \u00b7 r)',
    '[x] b (2026-11-01 08:00 \u00b7 r \u00b7 \u2713 2026-11-05 09:00)',
    '[ ] c (2026-10-01 08:00 \u00b7 r)',
    '[x] d',
  ].join('\n');
  var s = M.stats(M.parseTodo(doc).items, new Date(2026, 10, 5, 12, 0));
  assert.deepStrictEqual(s, { total: 4, done: 2, open: 2, addedToday: 1, doneToday: 1, oldest: '2026-10-01 08:00', pct: 50 });
});
test('when: labels and buckets', function () {
  var now = new Date(2026, 10, 5, 12, 0);
  function w(s) { var r = M.when(s, now); return r.label + '/' + r.bucket; }
  assert.strictEqual(w('2026-11-05 11:59'), '1m/today');
  assert.strictEqual(w('2026-11-05 12:00'), 'now/today');
  assert.strictEqual(w('2026-11-05 09:00'), '3h/today');
  assert.strictEqual(w('2026-11-04 23:00'), 'yesterday/yesterday');
  assert.strictEqual(w('2026-11-02 10:00'), 'Mon/week');
  assert.strictEqual(w('2026-10-20 10:00'), 'Oct 20/month');
  assert.strictEqual(w('2025-11-04 10:00'), '2025-11-04/older');
  assert.strictEqual(w('nope'), '/');
});
test('stamps sort as strings', function () {
  assert.strictEqual(M.normStamp('2026-11-04 9:05'), '2026-11-04 09:05');
  assert.strictEqual(M.normStamp('2026-11-04'), '');
  assert.strictEqual(M.stamp(new Date(2026, 0, 2, 3, 4)), '2026-01-02 03:04');
});
test('yy: only at the start of a word', function () {
  ['yy', 'a yy', '(yy', '[yy', 'x\tyy'].forEach(function (b) { assert.strictEqual(M.yyTrigger(b), true, b); });
  ['happyy', 'ayy', '"yy', 'x.yy', 'yyy', 'y', ''].forEach(function (b) { assert.strictEqual(M.yyTrigger(b), false, b); });
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
