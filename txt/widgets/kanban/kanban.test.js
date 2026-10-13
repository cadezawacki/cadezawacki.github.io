/* Unit tests for the Kanban widget's pure model (parser + edit builders).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/kanban/kanban.test.js */
'use strict';
var assert = require('assert');
var M = require('./kanban.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function boardOf(text, cursor) {
  var P = M.parse(text), gi = M.pickBoard(P, null, null, cursor == null ? null : cursor, null);
  return { P: P, b: gi >= 0 ? M.board(P, P.groups[gi]) : null, gi: gi };
}
function names(b) { return b.columns.map(function (c) { return c.name; }); }
function cardTexts(P, col) { return col.cards.map(function (k) { return P.lines.slice(k.start, k.end).join('\n'); }); }
function apply(text, res) {
  assert.ok(res && res.changes, 'expected changes');
  // changes must be sorted and non-overlapping, like CM6 wants
  for (var i = 1; i < res.changes.length; i++) assert.ok(res.changes[i].from >= res.changes[i - 1].to, 'overlapping changes');
  return M.applyChanges(text, res.changes);
}

var DOC = [
  '# Project',
  'Intro text.',
  '',
  '## Todo',
  'Things we have not started.',
  '',
  '- [ ] Write docs',
  '  - intro',
  '  - api',
  '- [ ] Ship it @cade #release 2026-01-02',
  '',
  '## Doing',
  '* Build parser',
  '',
  '## Done',
  '1. Setup repo',
  '2. Pick a name',
  '',
  '```',
  '## Not a heading',
  '- not a card',
  '```',
  '',
  '# Appendix',
].join('\n');

test('parse: sibling headings form a board, fenced ## ignored', function () {
  var r = boardOf(DOC);
  assert.deepStrictEqual(names(r.b), ['Todo', 'Doing', 'Done']);
  assert.strictEqual(r.P.heads.filter(function (h) { return h.raw === 'Not a heading'; }).length, 0);
  var todo = r.b.columns[0];
  assert.strictEqual(todo.cards.length, 2);
  assert.deepStrictEqual(cardTexts(r.P, todo), ['- [ ] Write docs\n  - intro\n  - api', '- [ ] Ship it @cade #release 2026-01-02']);
  assert.strictEqual(todo.cards[0].check, ' ');
  assert.strictEqual(todo.notes.length, 1);                       // the description paragraph
  assert.strictEqual(r.b.columns[2].cards.length, 2);              // fence content is a note, not cards
  assert.ok(r.b.columns[2].notes.length >= 4);
  assert.ok(r.b.columns[2].done);
});

test('parse: different heading levels / pick by cursor', function () {
  var t = ['# A', '## S1', '### Todo', '- a', '### Done', '- b', '## S2', '### Todo', '### Done', '- c'].join('\n');
  var P = M.parse(t);
  // groups: [S1,S2] at level 2, [Todo,Done] under S1, [Todo,Done] under S2
  assert.strictEqual(P.groups.length, 3);
  var r = boardOf(t, 3);                                           // cursor on "- a"
  assert.strictEqual(r.b.level, 3);
  assert.deepStrictEqual(cardTexts(r.P, r.b.columns[0]), ['- a']);
  r = boardOf(t, 9);                                               // cursor on "- c"
  assert.deepStrictEqual(cardTexts(r.P, r.b.columns[1]), ['- c']);
  assert.notStrictEqual(P.groups[1].key, P.groups[2].key);         // same parent text level → distinct keys
  // no cursor: most list items wins (S1 board has 2)
  r = boardOf(t, null);
  assert.deepStrictEqual(names(r.b), ['Todo', 'Done']);
  assert.strictEqual(r.b.columns[0].cards.length, 1);
});

test('parse: @kanban / @type: kanban use every ## heading', function () {
  var t = ['@kanban', '# Big', '## A', '- 1', '# Other', '## B', '- 2', '### deep', '- 3'].join('\n');
  var r = boardOf(t, 8);
  assert.ok(r.b.marked);
  assert.deepStrictEqual(names(r.b), ['A', 'B']);
  assert.strictEqual(r.b.columns[1].cards.length, 1);              // "- 3" belongs to the ### sub-section
  assert.ok(M.isDirective('@type: kanban'));
  assert.ok(M.isDirective('@todo, @kanban'));
  assert.ok(!M.isDirective('@kanbanize'));
  assert.ok(!M.isDirective('email me @kanban'));
  assert.ok(M.parse('@type: Kanban\n## X\n').marked);
});

test('parse: nested items, blank-line continuation, bare checkbox, numbered, lone marker', function () {
  var t = ['## L', '- a', '', '    deep para of a', '- b', '  1. sub', '     more', 'note line', '  - after note (new card)', '[ ] bare', '7) seven', '-', '## R'].join('\n');
  var r = boardOf(t + '\n- x');
  var L = r.b.columns[0];
  assert.deepStrictEqual(cardTexts(r.P, L), ['- a\n\n    deep para of a', '- b\n  1. sub\n     more', '  - after note (new card)', '[ ] bare', '7) seven', '-']);
  assert.strictEqual(L.cards[3].marker, '');
  assert.strictEqual(L.cards[3].check, ' ');
  assert.strictEqual(L.cards[4].marker, '7)');
  assert.deepStrictEqual(L.notes.map(function (i) { return r.P.lines[i]; }), ['note line']);
});

test('move card with sub-items between columns', function () {
  var r = boardOf(DOC);
  var res = M.moveCard(r.P, r.b, 0, 0, 1, 1);                      // Write docs → after "Build parser"
  assert.strictEqual(res.changes.length, 2);
  var out = apply(DOC, res);
  var r2 = boardOf(out);
  assert.deepStrictEqual(cardTexts(r2.P, r2.b.columns[0]), ['- [ ] Ship it @cade #release 2026-01-02']);
  // destination uses "*" bullets → the moved card adopts them; sub-items travel along
  assert.deepStrictEqual(cardTexts(r2.P, r2.b.columns[1]), ['* Build parser', '* [ ] Write docs\n  - intro\n  - api']);
  assert.ok(out.indexOf('Things we have not started.') !== -1);
  assert.deepStrictEqual(res.focus, { col: 1, ci: 1 });
});

test('move into a numbered column renumbers; leaving renumbers the source', function () {
  var r = boardOf(DOC);
  var out = apply(DOC, M.moveCard(r.P, r.b, 1, 0, 2, 0));         // "Build parser" → top of Done
  var r2 = boardOf(out);
  assert.deepStrictEqual(cardTexts(r2.P, r2.b.columns[2]), ['1. Build parser', '2. Setup repo', '3. Pick a name']);
  var out2 = apply(out, M.moveCard(r2.P, r2.b, 2, 1, 0, 2));       // "Setup repo" → end of Todo
  var r3 = boardOf(out2);
  assert.deepStrictEqual(cardTexts(r3.P, r3.b.columns[2]), ['1. Build parser', '2. Pick a name']);
  assert.deepStrictEqual(cardTexts(r3.P, r3.b.columns[0]).slice(-1), ['- Setup repo']);
});

test('moving the last card out of a column keeps the heading + a blank line', function () {
  var r = boardOf(DOC);
  var out = apply(DOC, M.moveCard(r.P, r.b, 1, 0, 0, 0));
  assert.ok(out.indexOf('## Doing\n\n## Done') !== -1, out);
  var r2 = boardOf(out);
  assert.strictEqual(r2.b.columns[1].cards.length, 0);
  assert.deepStrictEqual(cardTexts(r2.P, r2.b.columns[0])[0], '- Build parser');
  // and back into the now-empty column
  var out2 = apply(out, M.moveCard(r2.P, r2.b, 0, 0, 1, 0));
  assert.strictEqual(out2, DOC.replace('* Build parser', '- Build parser'));
});

test('insert into an empty column (no body, body with only blanks, body with a note, EOF)', function () {
  var t = '## A\n- one\n- two\n## B\n## C\n\n## D\nJust a note.\n## E';
  var r = boardOf(t);
  var out = apply(t, M.moveCard(r.P, r.b, 0, 0, 1, 0));
  assert.ok(out.indexOf('## B\n- one\n\n## C') !== -1, out);
  r = boardOf(out);
  out = apply(out, M.moveCard(r.P, r.b, 0, 0, 2, 0));
  assert.ok(out.indexOf('## C\n- two\n\n## D') !== -1, out);
  r = boardOf(out);
  out = apply(out, M.moveCard(r.P, r.b, 1, 0, 3, 0));
  assert.ok(out.indexOf('## D\nJust a note.\n\n- one\n## E') !== -1, out);
  r = boardOf(out);
  out = apply(out, M.moveCard(r.P, r.b, 3, 0, 4, 0));
  assert.ok(/## E\n- one$/.test(out), out);
  assert.strictEqual(boardOf(out).b.columns[4].cards.length, 1);
});

test('reorder within a column (up / down / no-ops) and loose lists', function () {
  var t = '## A\n- 1\n- 2\n- 3\n## B\n- x';
  var r = boardOf(t);
  assert.strictEqual(M.moveCard(r.P, r.b, 0, 1, 0, 1), null);
  assert.strictEqual(M.moveCard(r.P, r.b, 0, 1, 0, 2), null);
  assert.strictEqual(apply(t, M.moveCard(r.P, r.b, 0, 0, 0, 3)), '## A\n- 2\n- 3\n- 1\n## B\n- x');
  assert.strictEqual(apply(t, M.moveCard(r.P, r.b, 0, 2, 0, 0)), '## A\n- 3\n- 1\n- 2\n## B\n- x');
  var res = M.moveCard(r.P, r.b, 0, 2, 0, 1);
  assert.strictEqual(res.changes.length, 1);
  assert.strictEqual(apply(t, res), '## A\n- 1\n- 3\n- 2\n## B\n- x');
  assert.deepStrictEqual(res.focus, { col: 0, ci: 1 });
  var loose = '## A\n- 1\n\n- 2\n\n- 3\n\n## B\n- x';
  r = boardOf(loose);
  assert.strictEqual(apply(loose, M.moveCard(r.P, r.b, 0, 0, 0, 3)), '## A\n- 2\n\n- 3\n\n- 1\n\n## B\n- x');
  assert.strictEqual(apply(loose, M.moveCard(r.P, r.b, 0, 1, 1, 0)), '## A\n- 1\n\n- 3\n\n## B\n- 2\n- x');
});

test('minimal changes: a cross-column move does not rewrite the columns in between', function () {
  var r = boardOf(DOC);
  var res = M.moveCard(r.P, r.b, 0, 1, 2, 2);
  res.changes.forEach(function (c) { assert.ok(c.to - c.from < 60 && c.insert.length < 60, JSON.stringify(c)); });
  assert.strictEqual(res.changes.length, 2);
});

test('done column auto-check (doneMarks) with core-style strike', function () {
  var t = '## Todo\n- [ ] Task\n- plain\n## Done\n- [x] old';
  var r = boardOf(t);
  var out = apply(t, M.moveCard(r.P, r.b, 0, 0, 1, 1, { doneMarks: true }));
  var r2 = boardOf(out);
  var line = r2.P.lines[r2.b.columns[1].cards[1].start];
  assert.strictEqual(line, '- [x] ' + M.strike('Task'));
  out = apply(out, M.moveCard(r2.P, r2.b, 1, 1, 0, 0, { doneMarks: true }));
  assert.strictEqual(out.split('\n')[1], '- [ ] Task');
  var r3 = boardOf(out);
  out = apply(out, M.moveCard(r3.P, r3.b, 0, 1, 1, 0, { doneMarks: true })); // "plain" has no checkbox → gains [x]
  assert.ok(out.indexOf('- [x] ' + M.strike('plain')) !== -1, out);
  // doneMarks off: checkbox untouched
  r = boardOf(t);
  assert.ok(apply(t, M.moveCard(r.P, r.b, 0, 0, 1, 0)).indexOf('- [ ] Task') !== -1);
});

test('toggle check / sub check', function () {
  var t = '## A\n- [ ] Do it\n  - [ ] sub\n- [x] D̶o̶n̶e̶\n## B';
  var r = boardOf(t);
  var out = apply(t, M.toggleCheck(r.P, r.b, 0, 0));
  assert.strictEqual(out.split('\n')[1], '- [x] ' + M.strike('Do it'));
  out = apply(t, M.toggleCheck(r.P, r.b, 0, 1));
  assert.strictEqual(out.split('\n')[3], '- [ ] Done');
  out = apply(t, M.toggleSubCheck(r.P, r.b, 0, 0, 1));
  assert.strictEqual(out.split('\n')[2], '  - [x] ' + M.strike('sub'));
  assert.strictEqual(M.toggleSubCheck(r.P, r.b, 0, 0, 5), null);
  assert.strictEqual(M.toggleCheck(boardOf('## A\n- x\n## B').P, boardOf('## A\n- x\n## B').b, 0, 0), null);
});

test('add cards: style from column, from board, numbered, loose, empty column', function () {
  var t = '## A\n- [ ] one\n## B\n## C\n1. x';
  var r = boardOf(t);
  var out = apply(t, M.addCards(r.P, r.b, 0, ['two', 'three']));
  assert.ok(out.indexOf('## A\n- [ ] one\n- [ ] two\n- [ ] three\n## B') === 0, out);
  out = apply(t, M.addCards(r.P, r.b, 1, ['new']));
  assert.ok(out.indexOf('## B\n- [ ] new\n\n## C') !== -1, out);
  out = apply(t, M.addCards(r.P, r.b, 2, ['y', 'z']));
  assert.ok(/## C\n1\. x\n2\. y\n3\. z$/.test(out), out);
  assert.strictEqual(M.addCards(r.P, r.b, 0, ['  ', '']), null);
  var e = '## A\n\n## B\n';
  r = boardOf(e);
  assert.strictEqual(apply(e, M.addCards(r.P, r.b, 0, ['first'])), '## A\n- first\n\n## B\n');
  assert.strictEqual(apply(e, M.addCards(r.P, r.b, 1, ['last'])), '## A\n\n## B\n- last\n');
  var dm = '## Todo\n- [ ] a\n## Done\n';
  r = boardOf(dm);
  assert.ok(apply(dm, M.addCards(r.P, r.b, 1, ['fin'], { doneMarks: true })).indexOf('- [x] ' + M.strike('fin')) !== -1);
});

test('edit card text incl. continuation lines; delete card', function () {
  var t = '## A\n- [ ] Write docs\n  - intro\n  - api\n- next\n## B';
  var r = boardOf(t);
  var card = r.b.columns[0].cards[0];
  assert.strictEqual(M.cardEditText(r.P, card), 'Write docs\n- intro\n- api');
  var out = apply(t, M.editCard(r.P, r.b, 0, 0, 'Write the docs\n- intro\n- api\n- faq\n\n'));
  assert.strictEqual(out, '## A\n- [ ] Write the docs\n  - intro\n  - api\n  - faq\n- next\n## B');
  out = apply(t, M.editCard(r.P, r.b, 0, 1, 'next one\nwith detail'));
  assert.strictEqual(out, '## A\n- [ ] Write docs\n  - intro\n  - api\n- next one\n  with detail\n## B');
  assert.strictEqual(M.editCard(r.P, r.b, 0, 0, 'Write docs\n- intro\n- api').changes.length, 0);
  out = apply(t, M.deleteCard(r.P, r.b, 0, 0));
  assert.strictEqual(out, '## A\n- next\n## B');
  r = boardOf(out);
  assert.strictEqual(apply(out, M.deleteCard(r.P, r.b, 0, 0)), '## A\n\n## B');
  var num = '## A\n1. a\n2. b\n3. c\n## B';
  r = boardOf(num);
  assert.strictEqual(apply(num, M.deleteCard(r.P, r.b, 0, 0)), '## A\n1. b\n2. c\n## B');
});

test('columns: rename, add, delete (guards), WIP limit parse', function () {
  var t = '# P\n## Todo\n- a\n## Doing (2)\n\n## Done\n\n# Next';
  var r = boardOf(t);
  assert.strictEqual(r.b.columns[1].name, 'Doing');
  assert.strictEqual(r.b.columns[1].wip, 2);
  assert.strictEqual(apply(t, M.renameColumn(r.P, r.b, 0, '  Backlog  ')), t.replace('## Todo', '## Backlog'));
  assert.strictEqual(M.renameColumn(r.P, r.b, 0, ' '), null);
  assert.strictEqual(apply(t, M.addColumn(r.P, r.b, 'Review')), '# P\n## Todo\n- a\n## Doing (2)\n\n## Done\n\n## Review\n\n# Next');
  assert.strictEqual(apply('## A\n## B', M.addColumn(boardOf('## A\n## B').P, boardOf('## A\n## B').b, 'C')), '## A\n## B\n\n## C');
  assert.ok(M.deleteColumn(r.P, r.b, 0).error);                    // has cards
  assert.strictEqual(apply(t, M.deleteColumn(r.P, r.b, 2)), '# P\n## Todo\n- a\n## Doing (2)\n\n# Next');
  var two = '## A\n## B\n';
  assert.ok(M.deleteColumn(boardOf(two).P, boardOf(two).b, 0).error); // a board keeps >= 2 columns
  var noted = '## A\n## B\nnote\n## C';
  var rn = boardOf(noted);
  assert.ok(M.deleteColumn(rn.P, rn.b, 1).confirm);
  assert.strictEqual(apply(noted, M.deleteColumn(rn.P, rn.b, 1, true)), '## A\n## C');
  var sub = '## A\n## B\n### x\n## C';
  assert.ok(M.deleteColumn(boardOf(sub).P, boardOf(sub).b, 1).error);
});

test('create board template: empty doc, blank line, after text, under a heading, in a fence', function () {
  var P = M.parse('');
  var res = M.createBoard(P, 0, null);
  var out = apply('', res);
  assert.strictEqual(out, '## Todo\n- \n\n## Doing\n\n## Done\n');
  assert.strictEqual(res.pickLine, 0);
  var r = boardOf(out);
  assert.deepStrictEqual(names(r.b), ['Todo', 'Doing', 'Done']);
  assert.strictEqual(r.b.columns[0].cards.length, 1);
  var t = 'Hello\nworld';
  res = M.createBoard(M.parse(t), 0, null);
  out = apply(t, res);
  assert.strictEqual(out, 'Hello\n\n## Todo\n- \n\n## Doing\n\n## Done\n\nworld');
  assert.strictEqual(out.split('\n')[res.pickLine], '## Todo');
  t = '# Title\n## Notes\nstuff';
  res = M.createBoard(M.parse(t), 2, null);
  out = apply(t, res);
  assert.ok(/stuff\n\n### Todo\n- \n\n### Doing\n\n### Done\n$/.test(out), out);
  var P2 = M.parse(out);
  assert.strictEqual(M.pickBoard(P2, null, null, null, res.pickLine) >= 0, true);
  t = 'a\n```\ncode\n```';
  out = apply(t, M.createBoard(M.parse(t), 2, null));
  assert.ok(/```\n\n## Todo/.test(out), out);
});

test('board identity: key survives edits elsewhere; names fallback', function () {
  var t = '# P\n## Todo\n- a\n## Done\n';
  var P = M.parse(t), key = P.groups[0].key;
  var P2 = M.parse('intro\n\n' + t + '\nmore');
  assert.strictEqual(P2.groups[M.pickBoard(P2, key, null, null, null)].key, key);
  var P3 = M.parse(t.replace('# P', '# Renamed') + '\n# Q\n## X\n## Y');
  var gi = M.pickBoard(P3, key, ['Todo', 'Done'], null, null);
  assert.deepStrictEqual(P3.groups[gi].heads.map(function (k) { return P3.heads[k].raw; }), ['Todo', 'Done']);
});

test('no board: single heading / deep headings only', function () {
  assert.strictEqual(boardOf('just text').b, null);
  assert.strictEqual(boardOf('## Only one\n- a').b, null);
  assert.strictEqual(boardOf('##### a\n##### b').b, null);
  assert.strictEqual(boardOf('#hashtag\n#another').b, null);
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
