/* Checks for the Typing Test engine (word generation, note text, scoring, the
 * key judge, the speed graph). Not loaded by the app (not in the manifest).
 * Run: node txt/widgets/typing/typing.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var E = require('./typing.js');
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' ' + a + ' vs ' + b); }

test('registers under the manifest entry', function () {
  var entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === 'typing'; })[0];
  assert.ok(entry);
  assert.strictEqual(entry.entry, 'widgets/typing/typing.js');
  assert.strictEqual(entry.css, 'widgets/typing/typing.css');
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'typing.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  assert.ok(reg, 'registered');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], entry[k], k); });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['typing.css']);
});

test('words: plain words are lowercase common words; same seed, same words; no repeats in a row', function () {
  var a = E.genWords(200, {}, E.rng(7)), b = E.genWords(200, {}, E.rng(7));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 200);
  a.forEach(function (w, i) { assert.ok(/^[a-z]+$/.test(w) && E.COMMON.indexOf(w) >= 0, w); if (i) assert.notStrictEqual(w, a[i - 1]); });
});
test('words: punctuation capitalises after a stop and ends on a full stop; numbers appear', function () {
  var w = E.genWords(400, { punct: true }, E.rng(3));
  assert.ok(/^[A-Z"]/.test(w[0]));
  assert.ok(/\.$/.test(w[w.length - 1]));
  for (var i = 1; i < w.length; i++) if (/[.?!]$/.test(w[i - 1])) assert.ok(/^"?[A-Z0-9]/.test(w[i]), w[i - 1] + ' ' + w[i]);
  assert.ok(w.some(function (x) { return /,$/.test(x); }));
  var n = E.genWords(400, { nums: true }, E.rng(4)).filter(function (x) { return /^\d+$/.test(x); }).length;
  assert.ok(n > 20 && n < 100, 'numbers ' + n);
});
test('note text: markdown and app syntax stripped, starts on a sentence, too-short notes give nothing', function () {
  var w = E.noteWords('# Title\n\n- [ ] buy **milk** today\n> quoted line here\n```js\nlet secret = 1\n```\nSee [the docs](http://x.y) for “more” — really. ' + 'word '.repeat(10), 50, 0);
  var s = w.join(' ');
  assert.ok(!/[#*`>\[\]]/.test(s) && !/secret/.test(s) && !/http/.test(s), s);
  assert.ok(/^Title buy milk today quoted line here See the docs for "more" - really\./.test(s), s);
  assert.deepStrictEqual(E.noteWords('too short', 50, 0), []);
  var long = []; for (var i = 0; i < 200; i++) long.push(i % 10 === 9 ? 'end.' : 'w' + i);
  var mid = E.noteWords(long.join(' '), 30, 0.5);
  assert.strictEqual(mid.length, 30);
  assert.ok(/^w\d+0$/.test(mid[0]), 'starts after a full stop: ' + mid[0]);
});
test('score: all correct — wpm counts words plus spaces / 5 per minute', function () {
  var words = ['the', 'cat', 'sat'], typed = ['the', 'cat', 'sat'];
  // all three committed (space after the last): 3*(3+1) = 12 chars in 6 s
  var s = E.score(words, typed, 3, false, { ok: 12, bad: 0 }, 6000);
  near(s.wpm, 12 / 5 / 0.1);
  near(s.acc, 100);
  assert.deepStrictEqual(s.chars, { correct: 9, incorrect: 0, extra: 0, missed: 0 });
  // finishing on the last word without a space: no trailing space counted
  var t = E.score(words, typed, 2, true, { ok: 11, bad: 0 }, 6000);
  near(t.wpm, 11 / 5 / 0.1);
});
test('score: wrong, extra and missed characters; a wrong word earns no wpm', function () {
  var words = ['hello', 'world', 'again'], typed = ['helo', 'worldd', 'ag'];
  var s = E.score(words, typed, 2, true, { ok: 10, bad: 4 }, 60000);
  // hello vs helo: h e l ok, o≠l wrong, o missed → 3 correct, 1 incorrect, 1 missed
  // world vs worldd: 5 correct, 1 extra;  again vs ag (in progress, counted at the end): 2 correct
  assert.deepStrictEqual(s.chars, { correct: 10, incorrect: 1, extra: 1, missed: 1 });
  near(s.wpm, 2 / 5, 1e-9, 'only the correct prefix of the last word counts');
  near(s.raw, (5 + 7 + 2) / 5);
  near(s.acc, 10 / 14 * 100);
});
test('judge: new characters past the common prefix are presses, right or wrong where they land', function () {
  var k = { ok: 0, bad: 0 };
  E.judge('', 'h', 'hello', k); E.judge('h', 'hx', 'hello', k); E.judge('hx', 'h', 'hello', k); E.judge('h', 'hel', 'hello', k);
  assert.deepStrictEqual(k, { ok: 3, bad: 1 });
  E.judge('hel', 'hello', 'hello', k);           // autocomplete drops in the rest at once
  assert.deepStrictEqual(k, { ok: 5, bad: 1 });
  E.judge('helo', 'hello', 'hello', k);          // autocorrect fixes a word: the changed tail counts
  assert.deepStrictEqual(k, { ok: 7, bad: 1 });
  E.judge('', 'help', 'hello', k);               // a predicted wrong word: judged letter by letter
  assert.deepStrictEqual(k, { ok: 10, bad: 2 });
});
test('spark: block characters scaled to the peak, bucketed to a width', function () {
  assert.strictEqual(E.spark([0, 4, 8], 3), ' ▄█');
  assert.strictEqual(E.spark([1, 1, 1, 1, 8, 8], 3).length, 3);
  assert.strictEqual(E.spark([], 10), '');
  assert.strictEqual(E.spark([0.1, 10], 2).charAt(0), '▁', 'small but non-zero still shows');
});
test('config keys name the exact setup', function () {
  assert.strictEqual(E.configKey({ mode: 'time', time: 30 }), 'time 30');
  assert.strictEqual(E.configKey({ mode: 'words', count: 25, punct: true, nums: true }), 'words 25 +punct +num');
  assert.strictEqual(E.configKey({ mode: 'passage', punct: true }), 'passage');
  assert.strictEqual(E.configKey({ mode: 'note' }), 'note');
});
test('passages are plain ASCII prose', function () {
  E.PASSAGES.forEach(function (p) { assert.ok(/^[\x20-\x7E]+$/.test(p) && p.split(' ').length >= 15, p); });
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'typing: ' + passed + ' passed');
