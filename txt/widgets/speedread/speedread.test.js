/* Checks for the Speed Reader: tokenising (markdown skipping, offsets),
 * chunking for 1–5 words, the ORP table, pacing, position mapping, the
 * prefs schema and the widget registration. Not loaded by the app.
 * Run: node txt/widgets/speedread/speedread.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./speedread-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function ws(words) { return words.map(function (w) { return w.w; }).join(' '); }

// The manifest entry proposed for this widget (switch to reading txt/manifest.json once it's there).
var ENTRY = {
  id: 'speedread', type: 'widget', name: 'Speed Reader',
  description: 'Read the note or selection one word (or a few) at a time in one spot, focus letter highlighted — tap to play, hold to read, scrub, back a sentence',
  icon: '⚡',
  tags: 'speed reader,speed reading,rsvp,spritz,read,reading,fast,focus,words per minute,wpm,skim,study',
  entry: 'widgets/speedread/speedread.js', css: 'widgets/speedread/speedread.css', precache: ['widgets/speedread/speedread-core.js'],
  prefs: { title: 'Speed Reader', fields: [
    { key: 'chunk', type: 'number', label: 'Words shown at a time', default: 1, min: 1, max: 5, step: 1 },
    { key: 'wpm', type: 'slider', label: 'Speed', default: 350, min: 100, max: 1000, step: 25, unit: 'wpm' },
    { key: 'ctx', type: 'toggle', label: 'Show the text around it', default: true, hint: 'The words before and after the current one, faded' },
    { key: 'dim', type: 'slider', label: 'Opacity of the text around it', default: 25, min: 0, max: 100, step: 5, unit: '%', showIf: 'ctx', hint: '0 hides it' },
    { key: 'ctxPos', type: 'radio', label: 'Where it goes', default: 'inline', showIf: 'ctx',
      options: [{ value: 'inline', label: 'Same line' }, { value: 'lines', label: 'A line above and below' }] },
    { key: 'orp', type: 'toggle', label: 'Highlight the focus letter', default: true, hint: 'One letter of each word in the accent colour, always at the same spot' },
    { key: 'pause', type: 'slider', label: 'Pause at sentence ends', default: 2, min: 1, max: 4, step: 0.25, unit: '×',
      hint: 'Commas get half as much extra, paragraphs a little more; long words and numbers always get a bit longer' },
    { key: 'size', type: 'slider', label: 'Text size', default: 44, min: 24, max: 96, step: 4, unit: 'px' },
    { key: 'start', type: 'radio', label: 'Start from', default: 'caret',
      options: [{ value: 'caret', label: 'The caret' }, { value: 'top', label: 'The start of the note' }], hint: 'A selection is always read from its start' },
    { key: 'moveCaret', type: 'toggle', label: 'Move the caret to where I stopped', default: true, hint: 'When you close the reader' }
  ] }
};

var NOTE = [
  '# Reading *faster*',
  '',
  'Speed reading shows **one word** at a time, see [the guide](https://example.com/g "t") and `npm run`.',
  '```js',
  'const secret = "never read";',
  '```',
  '- [ ] task item — done',
  '> [!note] Callout title',
  'Visit https://example.com/x now ![file:a.pdf#abc|s12] ![img:x#y] ![alt](pic.png) end<br>here[^1].',
  '| a | b |',
  '|---|---|',
  '[[Page|alias text]] and ==red|marked== and %%big|large%% ||secret|| \\*not em\\*',
  '---',
  'Dr. Who met J. Smith!'
].join('\n');

test('tokenise: markdown syntax, code, URLs, tokens are skipped; headings / links read as text', function () {
  var w = C.tokenize(NOTE);
  assert.strictEqual(ws(w), 'Reading faster Speed reading shows one word at a time, see the guide and npm run. task item — done ' +
    'Callout title Visit now end here. a b alias text and marked and large secret *not em* Dr. Who met J. Smith!');
  assert.ok(!/secret = |never|https|abc|pic|alt|#/.test(ws(w)));
});
test('tokenise: offsets point at the words in the source (plus base)', function () {
  var w = C.tokenize(NOTE);
  w.forEach(function (x) {
    var raw = NOTE.slice(x.from, x.to);
    var core = x.w.replace(/[^\p{L}\p{N}]/gu, '');
    assert.ok(raw.replace(/[^\p{L}\p{N}]/gu, '').indexOf(core) >= 0 || raw.indexOf(core) >= 0, x.w + ' vs ' + raw);
    assert.ok(/[\p{L}\p{N}]/u.test(NOTE.charAt(x.from)) || /["'(*\\]/.test(NOTE.charAt(x.from)), 'starts at the word: ' + raw);
  });
  var b = C.tokenize('alpha beta', 100);
  assert.deepStrictEqual(b.map(function (x) { return [x.from, x.to]; }), [[100, 105], [106, 110]]);
});
test('tokenise: pause classes (clause, sentence, paragraph; abbreviations and initials are not stops)', function () {
  var w = C.tokenize('One, two; three. Mr. Smith and J. Doe left! Really?\nNext line');
  var e = {}; w.forEach(function (x) { e[x.w] = x.end; });
  assert.strictEqual(e['One,'], 1); assert.strictEqual(e['two;'], 1); assert.strictEqual(e['three.'], 2);
  assert.strictEqual(e['Mr.'], 0); assert.strictEqual(e['J.'], 0); assert.strictEqual(e['left!'], 2);
  assert.strictEqual(e['Really?'], 3, 'line end is a paragraph');
  assert.strictEqual(e['line'], 3);
  assert.ok(C.tokenize('Heading here').every(function (x, i, a) { return i < a.length - 1 ? x.end === 0 : x.end === 3; }));
  assert.ok(C.tokenize('# Title words')[1].head);
  assert.ok(C.tokenize('Year 2026 ok')[1].num);
});
test('tokenise: unclosed fence skips to the end; ~~~ fences; tables; empty input', function () {
  assert.strictEqual(ws(C.tokenize('a\n```\nb\nc')), 'a');
  assert.strictEqual(ws(C.tokenize('a\n~~~py\nx\n~~~\nb')), 'a b');
  assert.strictEqual(ws(C.tokenize('| x | y |\n|:-|-:|\n| 1 | 2 |')), 'x y 1 2');
  assert.deepStrictEqual(C.tokenize(''), []);
  assert.deepStrictEqual(C.tokenize('```\ncode only\n```'), []);
});

test('chunk: 1–5 words, never across sentence / clause ends, char budget', function () {
  var w = C.tokenize('the quick brown fox jumps over the lazy dog and runs away from here quickly');
  for (var n = 1; n <= 5; n++) {
    var ch = C.chunk(w, n);
    var covered = 0;
    ch.forEach(function (c, i) {
      assert.ok(c.b > c.a && c.b - c.a <= n, 'size ' + n);
      if (i) assert.strictEqual(c.a, ch[i - 1].b, 'contiguous');
      covered += c.b - c.a;
      var chars = w.slice(c.a, c.b).map(function (x) { return x.w; }).join(' ').length;
      assert.ok(c.b - c.a === 1 || chars <= C.maxCharsFor(n), 'char budget');
    });
    assert.strictEqual(covered, w.length);
  }
  assert.strictEqual(C.chunk(w, 1).length, w.length);
  assert.strictEqual(C.chunk(w, 2)[0].b - C.chunk(w, 2)[0].a, 2);
  var s = C.tokenize('One two. Three, four five six');
  assert.deepStrictEqual(C.chunk(s, 3).map(function (c) { return ws(s.slice(c.a, c.b)); }), ['One two.', 'Three,', 'four five six']);
  assert.deepStrictEqual(C.chunk(C.tokenize('incomprehensibilities characteristically'), 2).length, 2, 'two long words split');
  assert.strictEqual(C.chunk(w, 9).every(function (c) { return c.b - c.a <= 5; }), true, 'clamped to 5');
});

test('ORP index table (by core length, after leading punctuation)', function () {
  var table = { a: 0, an: 1, cat: 1, word: 1, words: 1, reader: 2, reading: 2, sentence: 2, sentences: 2,
    paragraphs: 3, information: 3, consideration: 3, understandings: 4, incomprehensibilities: 4 };
  for (var k in table) assert.strictEqual(C.orpIndex(k), table[k], k);
  assert.strictEqual(C.orpIndex('"Hello,'), 2, 'skips the quote');
  assert.strictEqual(C.orpIndex('(word)'), 2);
  assert.strictEqual(C.orpIndex('—'), 0);
});

test('timing: one word-time each, long words / numbers longer, punctuation pauses scale', function () {
  var unit = 60000 / 300;
  var w = C.tokenize('cat elephantine 1234 end, stop. para');
  var t = function (i, s) { return C.chunkMs(w, { a: i, b: i + 1 }, 300, s); };
  assert.strictEqual(Math.round(t(0, 2)), unit);
  assert.ok(Math.abs(t(1, 2) - unit * 1.4) < 1e-6, 'elephantine: 11 letters +40%');
  assert.ok(Math.abs(t(2, 2) - unit * 1.3) < 1e-6, 'number +30%');
  assert.ok(Math.abs(t(3, 2) - unit * 1.5) < 1e-6, 'comma: half the extra');
  assert.ok(Math.abs(t(4, 2) - unit * 2) < 1e-6, 'sentence ×2');
  assert.ok(Math.abs(t(5, 2) - unit * 2.8) < 1e-6, 'paragraph 1.4×');
  assert.ok(Math.abs(t(4, 1) - unit) < 1e-6, 'multiplier 1 = no pause');
  assert.ok(Math.abs(t(4, 4) - unit * 4) < 1e-6);
  var ch = C.chunk(w, 1), tl = C.timeline(w, ch, 300, 2);
  assert.strictEqual(tl.rest[ch.length], 0);
  assert.ok(Math.abs(tl.rest[0] - tl.dur.reduce(function (a, b) { return a + b; }, 0)) < 1e-6);
  assert.ok(C.chunkMs(w, { a: 0, b: 1 }, 1000, 1) >= 60, 'floor');
  assert.strictEqual(C.fmtTime(65000), '1:05'); assert.strictEqual(C.fmtTime(3661000), '1:01:01'); assert.strictEqual(C.fmtTime(-5), '0:00');
});

test('position mapping: offset -> word -> chunk; sentences; start index', function () {
  var text = 'One two three. Four five six. Seven eight.';
  var w = C.tokenize(text);
  assert.strictEqual(C.wordAt(w, 0), 0);
  assert.strictEqual(C.wordAt(w, 5), 1, 'inside "two"');
  assert.strictEqual(C.wordAt(w, 3), 1, 'between words: the next');
  assert.strictEqual(C.wordAt(w, 999), w.length - 1);
  assert.strictEqual(C.startIndex(w, 3), 0, 'caret right after "One"');
  assert.strictEqual(C.startIndex(w, 4), 1);
  assert.strictEqual(C.startIndex(w, text.length), 0, 'caret at the end: from the start');
  assert.strictEqual(C.startIndex(w, null), 0);
  var ch = C.chunk(w, 2);
  for (var i = 0; i < w.length; i++) { var c = ch[C.chunkOf(ch, i)]; assert.ok(c.a <= i && i < c.b); }
  var st = C.sentenceStarts(w);
  assert.deepStrictEqual(st, [0, 3, 6]);
  assert.strictEqual(C.sentenceTarget(st, 4, -1), 3, 'back: start of this sentence');
  assert.strictEqual(C.sentenceTarget(st, 3, -1), 0, 'back again: the one before');
  assert.strictEqual(C.sentenceTarget(st, 0, -1), 0);
  assert.strictEqual(C.sentenceTarget(st, 1, 1), 3);
  assert.strictEqual(C.sentenceTarget(st, 7, 1, w.length), w.length - 1);
  var sel = C.tokenize('two three', 4);
  assert.strictEqual(text.slice(sel[1].from, sel[1].to), 'three');
});

function load() {
  var reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'speedread.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { baseURL: function () { return './txt/widgets/speedread/'; }, loadCSS: function (p) { css.push(p); },
    registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  return { reg: reg, css: css };
}
test('registers under the manifest entry', function () {
  var x = load();
  assert.ok(x.reg, 'registered');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(x.reg[k], ENTRY[k], k); });
  assert.strictEqual(typeof x.reg.open, 'function');
  assert.deepStrictEqual(x.css, ['speedread.css']);
  ['speedread.js', 'speedread.css', 'speedread-core.js'].forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, f)), f); });
});
test('prefs schema in the module equals the manifest "prefs"', function () {
  assert.deepStrictEqual(load().reg._fields, ENTRY.prefs.fields);
});
test('prefs schema is valid for the core prefs store (defaults survive its coercion)', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'txt.html'), 'utf8');
  var a = html.indexOf('// <prefs-core>'), b = html.indexOf('// </prefs-core>');
  if (a < 0 || b < 0) return; // core not there yet
  var PC = new Function(html.slice(a, b) + '\nreturn PrefsCore;')();
  ENTRY.prefs.fields.forEach(function (f) {
    var n = PC.normField(f);
    assert.ok(n, 'usable: ' + f.key);
    assert.deepStrictEqual(n.default, f.default, 'default kept: ' + f.key);
    if (f.showIf) assert.ok(ENTRY.prefs.fields.some(function (g) { return g.key === f.showIf.replace(/^!/, '') && g.type === 'toggle'; }));
  });
  assert.strictEqual(PC.coerce(PC.normField(ENTRY.prefs.fields[0]), 7), 5, 'chunk clamps to 5');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'speedread: ' + passed + ' passed');
