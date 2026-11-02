/* Headless checks for the Word Frequency widget's counting.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/wordfreq/wordfreq.test.js */
'use strict';
var assert = require('assert');
var P = require('./wordfreq.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, escapeHtml: String } };
global.document = { addEventListener: function () {} };
delete require.cache[require.resolve('./wordfreq.js')];
require('./wordfreq.js');
delete global.window; delete global.document;

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function pairs(res) { return res.entries.map(function (e) { return [e.label, e.count]; }); }
function words(text) { return P.tokenize(text).map(function (t) { return t.t; }); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Word Frequency' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'wordfreq.css');
});

// ---------- what gets skipped ----------
test('code, URLs, link targets, images and HTML are not counted', function () {
  var t = 'Alpha `beta code` gamma.\n\n```js\ndelta delta\n```\n\n[epsilon](https://zeta.example/eta) theta https://iota.com/kappa ' +
    '![lambda alt](mu.png) <span class="nu">xi</span> www.omicron.org pi.\n\n[ref]: https://rho.example\n';
  assert.deepStrictEqual(words(t), ['Alpha', 'gamma', 'epsilon', 'theta', 'xi', 'pi']);
});
test('an unclosed fence runs to the end; ~~~ fences work too', function () {
  assert.deepStrictEqual(words('one\n```\ntwo three'), ['one']);
  assert.deepStrictEqual(words('one\n~~~\ntwo\n~~~\nfour'), ['one', 'four']);
});
test('tables this widget inserted are skipped, other tables count', function () {
  var own = 'Intro words.\n\n| # | Word | Count | % |\n|--:|:--|--:|--:|\n| 1 | apple | 4 | 20% |\n\nAfter table.';
  assert.deepStrictEqual(words(own), ['Intro', 'words', 'After', 'table']);
  assert.deepStrictEqual(words('| Fruit | Qty |\n|---|---|\n| apple | 4 |'), ['Fruit', 'Qty', 'apple', '4']);
});
test('excluded ranges are sorted and merged', function () {
  var r = P.excludedRanges('a `x` https://b.c/`d` e');
  for (var i = 1; i < r.length; i++) assert.ok(r[i][0] > r[i - 1][1]);
});

// ---------- tokens ----------
test('tokens keep apostrophes and hyphens, drop possessive ’s, flag numbers', function () {
  var t = P.tokenize("Cade's well-known don't 42 café naïve it’s");
  assert.deepStrictEqual(t.map(function (x) { return x.t; }), ['Cade', 'well-known', "don't", '42', 'café', 'naïve', 'it']);
  assert.strictEqual(t[0].e - t[0].s, 4);
  assert.ok(t[3].num && !t[0].num);
});
test('token offsets point at the source text', function () {
  var src = '# Head\n\nSome **bold** text, [a link](http://x.y) and more.';
  P.tokenize(src).forEach(function (t) { assert.strictEqual(src.slice(t.s, t.e), t.t); });
});
test('phrase breaks: punctuation, paragraphs, list items, skipped code', function () {
  var b = P.tokenize('one two. three, four\nfive\n\nsix\n- seven `x` eight').map(function (t) { return (t.brk ? '|' : '') + t.t; });
  assert.deepStrictEqual(b, ['|one', 'two', '|three', '|four', 'five', '|six', '|seven', '|eight']);
});

// ---------- counting ----------
var TEXT = 'The cat sat. The cat ran! A dog and the cat played; dogs are playing. Cats love the dog.';
test('word counts, totals and percentages', function () {
  var r = P.count(P.tokenize(TEXT), { n: 1 });
  assert.strictEqual(r.total, 19);
  var the = r.entries.filter(function (e) { return e.key === 'the'; })[0];
  assert.strictEqual(the.count, 4);
  assert.ok(Math.abs(the.pct - 4 / 19 * 100) < 1e-9);
  var sum = r.entries.reduce(function (a, e) { return a + e.count; }, 0);
  assert.strictEqual(sum, 19);
  assert.strictEqual(r.entries[0].label, 'the');      // sorted by count
});
test('stop words, minimum length', function () {
  var r = P.count(P.tokenize(TEXT), { n: 1, stop: true, minLen: 3 });
  assert.deepStrictEqual(pairs(r), [['cat', 3], ['dog', 2], ['cats', 1], ['dogs', 1], ['love', 1], ['played', 1], ['playing', 1], ['ran', 1], ['sat', 1]]);
  assert.ok(P.isStop('the') && P.isStop("don't") && !P.isStop('cat'));
  assert.ok(Object.keys(P.STOP).length > 150);
  var r4 = P.count(P.tokenize(TEXT), { n: 1, stop: true, minLen: 4 });
  assert.ok(r4.entries.every(function (e) { return e.label.length >= 4; }));
  assert.strictEqual(r4.total, 19);                    // the share is still of all words
});
test('case folding on and off', function () {
  var toks = P.tokenize('Apple apple APPLE Apple pie');
  assert.deepStrictEqual(pairs(P.count(toks, { n: 1, fold: true })), [['apple', 4], ['pie', 1]]);
  assert.deepStrictEqual(pairs(P.count(toks, { n: 1, fold: false })), [['Apple', 2], ['APPLE', 1], ['apple', 1], ['pie', 1]]);
});
test('stemming merges plurals, -ing and -ed and keeps the forms', function () {
  [['walk', 'walk'], ['walks', 'walk'], ['walked', 'walk'], ['walking', 'walk'], ['make', 'mak'], ['making', 'mak'], ['boxes', 'box'],
   ['watches', 'watch'], ['running', 'run'], ['stories', 'story'], ['tried', 'try'], ['trying', 'try'], ['glasses', 'glass'],
   ['planned', 'plan'], ['needed', 'need'], ['this', 'this'], ['bus', 'bus'], ['famous', 'famous'], ['table', 'table'], ['tables', 'table'],
   ['falling', 'fall'], ['need', 'need'], ['don\'t', 'don\'t']
  ].forEach(function (c) { assert.strictEqual(P.stem(c[0]), c[1], c[0]); });
  var r = P.count(P.tokenize(TEXT), { n: 1, stop: true, minLen: 3, stem: true });
  var cat = r.entries[0];
  assert.strictEqual(cat.key, 'cat'); assert.strictEqual(cat.count, 4); assert.deepStrictEqual(cat.forms, ['cat', 'cats']);
  var play = r.entries.filter(function (e) { return e.key === 'play'; })[0];
  assert.strictEqual(play.count, 2); assert.deepStrictEqual(play.forms.sort(), ['played', 'playing']);
  var dog = r.entries.filter(function (e) { return e.key === 'dog'; })[0];
  assert.strictEqual(dog.count, 3); assert.strictEqual(dog.label, 'dog');
});
test('occurrences are source ranges, in order', function () {
  var src = 'Cats? cats! The CAT.';
  var e = P.count(P.tokenize(src), { n: 1, stem: true }).entries.filter(function (x) { return x.key === 'cat'; })[0];
  assert.deepStrictEqual(e.occ.map(function (o) { return src.slice(o[0], o[1]); }), ['Cats', 'cats', 'CAT']);
});

// ---------- n-grams ----------
test('2- and 3-word phrases (shown from two uses), not across breaks', function () {
  var toks = P.tokenize('Machine learning is fun. Machine learning is hard. I like machine learning, and machine. Learning is slow.');
  var bi = P.count(toks, { n: 2 });
  assert.deepStrictEqual(pairs(bi).slice(0, 2), [['learning is', 3], ['machine learning', 3]]);   // ties: A–Z
  assert.ok(bi.entries.every(function (e) { return e.count >= 2; }));
  assert.ok(!bi.entries.some(function (e) { return e.key === 'machine learning' && e.count > 3; }));   // "machine. Learning" isn't one
  var tri = P.count(toks, { n: 3 });
  assert.deepStrictEqual(pairs(tri), [['machine learning is', 2]]);
  assert.deepStrictEqual(pairs(P.count(toks, { n: 3, minCount: 1 })).length > 1, true);
});
test('stop-word filter drops phrases that start or end with a common word', function () {
  var toks = P.tokenize('the big dog and the big dog. of the big dog.');
  assert.deepStrictEqual(pairs(P.count(toks, { n: 2, stop: true })), [['big dog', 3]]);
  assert.deepStrictEqual(pairs(P.count(toks, { n: 2, stop: false })).slice(0, 2), [['big dog', 3], ['the big', 3]]);
});
test('phrase percentages are of all phrase windows; occurrences span the phrase', function () {
  var src = 'red apple red apple';
  var r = P.count(P.tokenize(src), { n: 2 });
  assert.strictEqual(r.windows, 3);
  var e = r.entries[0];
  assert.strictEqual(e.label, 'red apple'); assert.strictEqual(e.count, 2); assert.ok(Math.abs(e.pct - 200 / 3) < 1e-9);
  assert.strictEqual(P.count(P.tokenize('red apple, red apple, red'), { n: 2 }).windows, 2);
  assert.deepStrictEqual(e.occ.map(function (o) { return src.slice(o[0], o[1]); }), ['red apple', 'red apple']);
});
test('phrases with numbers are skipped; folding/stemming apply per word', function () {
  var toks = P.tokenize('Big Dogs ran. big dog ran. 3 dogs. 3 dogs.');
  assert.deepStrictEqual(pairs(P.count(toks, { n: 2, stem: true })), [['big dog', 2], ['dog ran', 2]]);
  assert.deepStrictEqual(pairs(P.count(toks, { n: 2, fold: false })), []);   // Big Dogs / big dog differ
});

// ---------- helpers ----------
test('search filter matches labels and forms', function () {
  var r = P.count(P.tokenize(TEXT), { n: 1, stop: true, stem: true });
  assert.deepStrictEqual(P.filterEntries(r.entries, 'PLAY').map(function (e) { return e.key; }), ['play']);
  assert.deepStrictEqual(P.filterEntries(r.entries, 'cats').map(function (e) { return e.key; }), ['cat']);
  assert.strictEqual(P.filterEntries(r.entries, '  ').length, r.entries.length);
});
test('Markdown table: header, alignment, escaping, limit', function () {
  var entries = [{ label: 'a|b', count: 3, pct: 37.5 }, { label: 'c', count: 1, pct: 0.05 }, { label: 'd', count: 1, pct: 1.25 }];
  assert.strictEqual(P.toMarkdownTable(entries, { n: 1, limit: 2 }),
    '| # | Word | Count | % |\n|--:|:--|--:|--:|\n| 1 | a\\|b | 3 | 38% |\n| 2 | c | 1 | <0.1% |');
  assert.ok(/^\| # \| Phrase \|/.test(P.toMarkdownTable(entries, { n: 2 })));
  assert.strictEqual(P.fmtPct(1.25), '1.3%'); assert.strictEqual(P.fmtPct(0), '0%');
});
test('cycling through occurrences wraps', function () {
  var occ = [[0, 3], [10, 13], [20, 23]];
  assert.strictEqual(P.nextOcc(occ, 5, null), 1);     // first after the cursor
  assert.strictEqual(P.nextOcc(occ, 25, null), 0);    // wraps
  assert.strictEqual(P.nextOcc(occ, 0, 1), 2);
  assert.strictEqual(P.nextOcc(occ, 0, 2), 0);
  assert.strictEqual(P.nextOcc([], 0, null), -1);
});
test('large text stays fast', function () {
  var para = 'The quick brown fox jumps over the lazy dog while the lazy cat watches quietly. ';
  var big = ''; while (big.length < 300000) big += para;
  var t0 = Date.now(), toks = P.tokenize(big);
  P.count(toks, { n: 1, stop: true, stem: true, minLen: 3 }); P.count(toks, { n: 3, stop: true });
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
  assert.strictEqual(P.tokenize(big, 1000).length < 200, true);
});

console.log(passed + ' passed');
