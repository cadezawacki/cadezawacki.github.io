/* Unit tests for the Eisenhower Matrix widget's pure model (parser + edit builders).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/eisenhower/eisenhower.test.js */
'use strict';
var assert = require('assert');
var M = require('./eisenhower.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
var Y = '\u00a5';
function apply(text, res) {
  assert.ok(res && res.changes && res.changes.length, 'expected changes');
  return M.applyChanges(text, res.changes);
}
function qs(text) { return M.parse(text).tasks.map(function (t) { return t.q; }); }
function task(text, i) { var P = M.parse(text); return { P: P, t: P.tasks[i || 0] }; }

var DOC = [
  '# Plan',
  '- [ ] Ship release ' + Y + 'urgent ' + Y + 'important',
  '- [ ] Write blog ' + Y + 'important',
  '* [x] Answer email ' + Y + 'urgent',
  '1. [ ] Clean desk ' + Y + 'someday',
  '- [ ] Untagged thing',
  '    - [ ] nested sub ' + Y + 'Urgent',
  '[ ] bare box #important',
  '- not a task ' + Y + 'urgent',
  '```',
  '- [ ] fenced ' + Y + 'urgent',
  '```',
  '- [ ] code `' + Y + 'urgent` and url https://x.y/#important',
  '- [ ] ' + Y + 'urgent-ly ' + Y + 'urgent/sub ' + Y + 'urgentx',
  '- [ ] trailing dash ' + Y + 'urgent-',
].join('\n');

test('parse: tasks, quadrants, nesting, fences, sentinels', function () {
  var P = M.parse(DOC);
  assert.deepStrictEqual(P.tasks.map(function (t) { return t.line; }), [1, 2, 3, 4, 5, 6, 7, 12, 13, 14]);
  assert.deepStrictEqual(P.tasks.map(function (t) { return t.q; }), [1, 2, 3, 4, 0, 3, 2, 0, 0, 3]);
  assert.strictEqual(P.tasks[2].done, true);
  assert.strictEqual(P.tasks[3].marker, '1.');
  assert.strictEqual(P.tasks[5].depth, 4);
  assert.strictEqual(P.tasks[6].marker, '');               // bare checkbox
  assert.strictEqual(P.heads.length, 1);
  assert.deepStrictEqual(P.fences, [[9, 11]]);
});

test('parse: someday loses to urgency/importance; struck text still counts', function () {
  assert.deepStrictEqual(qs('- [ ] a ' + Y + 'someday ' + Y + 'important'), [2]);
  var struck = M.strike('done thing ' + Y + 'urgent ' + Y + 'important');
  var P = M.parse('- [x] ' + struck);
  assert.strictEqual(P.tasks[0].q, 1);
  assert.strictEqual(P.tasks[0].struck, true);
  assert.ok(/\u0336/.test(struck));
});

test('parse: other sentinels recognised, emails/words are not tags', function () {
  assert.deepStrictEqual(qs('- [ ] a \u20acurgent\n- [ ] b \u00a7important\n- [ ] c @someday\n- [ ] mail bob@important.com\n- [ ] x' + Y + 'urgent'), [3, 2, 4, 0, 0]);
  assert.deepStrictEqual(qs('- [ ] (' + Y + 'urgent) ok'), [3]);
  assert.deepStrictEqual(qs('- [ ]\n- [ ] \n-  [ ] x'), [0, 0, 0]);
  assert.strictEqual(M.parse('- [ ]no space').tasks.length, 0);
});

test('retag: minimal rewrites', function () {
  assert.strictEqual(M.retag('Ship ' + Y + 'important', 1, Y), 'Ship ' + Y + 'important ' + Y + 'urgent');
  assert.strictEqual(M.retag('Ship ' + Y + 'urgent ' + Y + 'important', 2, Y), 'Ship ' + Y + 'important');
  assert.strictEqual(M.retag(Y + 'urgent Ship it', 0, Y), 'Ship it');
  assert.strictEqual(M.retag('Call ' + Y + 'urgent today', 4, Y), 'Call today ' + Y + 'someday');
  assert.strictEqual(M.retag(Y + 'urgent ' + Y + 'important tail', 0, Y), 'tail');
  assert.strictEqual(M.retag('a #Important b', 2, Y), 'a ' + Y + 'important b');       // normalised in place
  assert.strictEqual(M.retag('dup ' + Y + 'urgent x ' + Y + 'urgent', 3, Y), 'dup ' + Y + 'urgent x');
  assert.strictEqual(M.retag('', 1, Y), Y + 'urgent ' + Y + 'important');
  assert.strictEqual(M.retag('text  ', 3, '#'), 'text #urgent');
  assert.strictEqual(M.retag('x', 3, 'bogus'), 'x ' + Y + 'urgent');                   // invalid sentinel -> default
  assert.strictEqual(M.displayText('Ship ' + Y + 'urgent ' + Y + 'important ' + Y + 'work'), 'Ship ' + Y + 'work');
});

test('setQuadrant rewrites only that line; struck lines stay struck', function () {
  var r = task(DOC, 4);                                         // Untagged thing
  var out = apply(DOC, M.setQuadrant(r.P, r.t, 1, Y));
  assert.strictEqual(out.split('\n')[5], '- [ ] Untagged thing ' + Y + 'urgent ' + Y + 'important');
  assert.strictEqual(out.split('\n').length, DOC.split('\n').length);
  assert.strictEqual(M.parse(out).tasks[4].q, 1);
  r = task(DOC, 0);
  assert.strictEqual(M.setQuadrant(r.P, r.t, 1, Y), null);      // already there
  out = apply(DOC, M.setQuadrant(r.P, r.t, 0, Y));
  assert.strictEqual(out.split('\n')[1], '- [ ] Ship release');
  var t2 = '- [x] ' + M.strike('Old ' + Y + 'urgent');
  r = task(t2);
  out = apply(t2, M.setQuadrant(r.P, r.t, 4, Y));
  assert.strictEqual(out, '- [x] ' + M.strike('Old ' + Y + 'someday'));
  assert.strictEqual(M.parse(out).tasks[0].q, 4);
  // nested + bare keep their prefix
  r = task(DOC, 5);
  out = apply(DOC, M.setQuadrant(r.P, r.t, 2, '#'));
  assert.strictEqual(out.split('\n')[6], '    - [ ] nested sub #important');
  r = task('- [ ]', 0);
  assert.strictEqual(apply('- [ ]', M.setQuadrant(r.P, r.t, 3, Y)), '- [ ] ' + Y + 'urgent');
});

test('toggleDone mirrors the core toggle (strike / unstrike)', function () {
  var t = 'x\n- [ ] Buy milk ' + Y + 'urgent\ny';
  var r = task(t);
  var out = apply(t, M.toggleDone(r.P, r.t));
  assert.strictEqual(out.split('\n')[1], '- [x] ' + M.strike('Buy milk ' + Y + 'urgent'));
  r = task(out);
  assert.strictEqual(r.t.done, true);
  assert.strictEqual(r.t.q, 3);
  out = apply(out, M.toggleDone(r.P, r.t));
  assert.strictEqual(out, t);
  r = task('[X] bare');
  assert.strictEqual(apply('[X] bare', M.toggleDone(r.P, r.t)), '[ ] bare');
});

test('editTask keeps prefix, collapses newlines, re-strikes done text', function () {
  var t = '  * [ ] old ' + Y + 'important';
  var r = task(t);
  assert.strictEqual(M.editText(r.t), 'old ' + Y + 'important');
  assert.strictEqual(apply(t, M.editTask(r.P, r.t, 'new\ntext ' + Y + 'important ')), '  * [ ] new text ' + Y + 'important');
  assert.strictEqual(M.editTask(r.P, r.t, '   '), null);
  assert.strictEqual(M.editTask(r.P, r.t, 'old ' + Y + 'important'), null);   // unchanged
  var d = '- [x] ' + M.strike('done');
  r = task(d);
  assert.strictEqual(M.editText(r.t), 'done');
  assert.strictEqual(apply(d, M.editTask(r.P, r.t, 'done!')), '- [x] ' + M.strike('done!'));
});

test('addTasks: under an existing ## Tasks section, copying its style', function () {
  var t = ['# Notes', 'intro', '', '## Tasks', '* [ ] one', '  * [ ] child', '* [x] two', '', '## Later', 'x'].join('\n');
  var res = M.addTasks(M.parse(t), 2, ['- [ ] Read book', '', '  plan trip '], Y);
  var out = apply(t, res);
  assert.deepStrictEqual(out.split('\n').slice(4, 11), ['* [ ] one', '  * [ ] child', '* [x] two', '* [ ] Read book ' + Y + 'important', '* [ ] plan trip ' + Y + 'important', '', '## Later']);
  assert.strictEqual(res.firstLine, 7);
  assert.strictEqual(res.count, 2);
  var P = M.parse(out);
  assert.strictEqual(M.taskAt(P, 7).q, 2);
  assert.strictEqual(M.taskAt(P, 8).q, 2);
});

test('addTasks: numbered lists continue, empty section, paragraph gap, heading variants', function () {
  var t = '## To-do\n1. [ ] a\n2. [ ] b';
  var out = apply(t, M.addTasks(M.parse(t), 1, ['c'], Y));
  assert.strictEqual(out, '## To-do\n1. [ ] a\n2. [ ] b\n3. [ ] c ' + Y + 'urgent ' + Y + 'important');
  t = '### \u2705 Tasks\n## Next';
  var res = M.addTasks(M.parse(t), 0, ['solo'], Y);
  out = apply(t, res);
  assert.strictEqual(out, '### \u2705 Tasks\n- [ ] solo\n\n## Next');
  assert.strictEqual(res.firstLine, 1);
  t = '## Todo\nSome paragraph.\n';
  res = M.addTasks(M.parse(t), 4, ['bin it'], Y);
  out = apply(t, res);
  assert.strictEqual(out, '## Todo\nSome paragraph.\n\n- [ ] bin it ' + Y + 'someday\n');
  assert.strictEqual(res.firstLine, 3);
  assert.strictEqual(M.parse(out).tasks[0].line, 3);
  // a "## Tasks" inside a code fence is not a section
  t = '```\n## Tasks\n```\nend';
  out = apply(t, M.addTasks(M.parse(t), 3, ['z'], Y));
  assert.strictEqual(out, '```\n## Tasks\n```\nend\n\n## Tasks\n- [ ] z ' + Y + 'urgent');
});

test('addTasks: no section -> creates ## Tasks at the end', function () {
  var res = M.addTasks(M.parse(''), 1, ['first'], '#');
  assert.strictEqual(apply('', res), '## Tasks\n- [ ] first #urgent #important');
  assert.strictEqual(res.firstLine, 1);
  var t = 'hello\nworld\n\n';
  res = M.addTasks(M.parse(t), 0, ['a', 'b'], Y);
  var out = apply(t, res);
  assert.strictEqual(out, 'hello\nworld\n\n## Tasks\n- [ ] a\n- [ ] b\n\n');
  assert.strictEqual(res.firstLine, 4);
  assert.deepStrictEqual(M.parse(out).tasks.map(function (k) { return k.line; }), [4, 5]);
  t = 'hello';
  res = M.addTasks(M.parse(t), 2, ['a'], Y);
  out = apply(t, res);
  assert.strictEqual(out, 'hello\n\n## Tasks\n- [ ] a ' + Y + 'important');
  assert.strictEqual(M.parse(out).tasks[0].line, res.firstLine);
  assert.strictEqual(M.addTasks(M.parse(t), 2, ['  ', '- [ ] '], Y), null);
});

test('summary + insertBlock', function () {
  var P = M.parse(DOC);
  var s = M.summary(P, { date: '2026-10-13' });
  var lines = s.split('\n');
  assert.strictEqual(lines[0], '**Eisenhower Matrix** \u2014 2026-10-13');
  assert.ok(s.indexOf('**Do first** (urgent & important) \u00b7 1\n- Ship release') !== -1);
  assert.ok(s.indexOf('- ~~Answer email~~') !== -1);
  assert.ok(s.indexOf('**Unsorted**') !== -1);
  assert.strictEqual(M.parse(s).tasks.length, 0);                     // the summary never adds todos
  var h = M.summary(P, { hideDone: true });
  assert.ok(h.indexOf('Answer email') === -1);
  assert.ok(M.summary(M.parse('- [ ] x ' + Y + 'urgent')).indexOf('Unsorted') === -1);
  var t = 'a\nb\n\nc';
  assert.strictEqual(apply(t, M.insertBlock(M.parse(t), 0, ['X', 'Y'])), 'a\n\nX\nY\n\nb\n\nc');
  assert.strictEqual(apply(t, M.insertBlock(M.parse(t), 2, ['X'])), 'a\nb\n\nX\n\nc');
  assert.strictEqual(apply(t, M.insertBlock(M.parse(t), 3, ['X'])), 'a\nb\n\nc\n\nX');
  t = '```\ncode\n```';
  assert.strictEqual(apply(t, M.insertBlock(M.parse(t), 1, ['X'])), '```\ncode\n```\n\nX');
});

test('changes are minimal and well-formed', function () {
  var r = task(DOC, 1);
  var res = M.setQuadrant(r.P, r.t, 1, Y);
  assert.strictEqual(res.changes.length, 1);
  var c = res.changes[0];
  assert.ok(c.from >= r.P.starts[2] && c.to <= r.P.starts[3]);
  assert.strictEqual(c.from, c.to);                                  // pure insertion of " ¥urgent"
  assert.strictEqual(c.insert, ' ' + Y + 'urgent');
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
