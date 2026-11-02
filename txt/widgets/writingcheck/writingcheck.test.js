/* Headless checks for the Writing Check widget's analysis.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/writingcheck/writingcheck.test.js */
'use strict';
var assert = require('assert');
var P = require('./writingcheck.js');
var widget = null, css = [];
global.window = { Cade: { loadCSS: function (p) { css.push(p); }, registerWidget: function (w) { widget = w; }, escapeHtml: String } };
global.document = { addEventListener: function () {} };
delete require.cache[require.resolve('./writingcheck.js')];
require('./writingcheck.js');
delete global.window; delete global.document;

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= (tol == null ? 0.05 : tol), (msg || '') + ' expected ≈' + b + ', got ' + a); }
function flagsOf(text, kind) { var r = P.analyze(text); return r.flags.filter(function (f) { return f.kind === kind; }).map(function (f) { return text.slice(f.from, f.to); }); }

test('registers as a widget with its css', function () {
  assert.ok(widget && widget.name === 'Writing Check' && typeof widget.open === 'function');
  assert.strictEqual(css[0], 'writingcheck.css');
});

// ---------- syllables ----------
var SYL = {
  cat: 1, dog: 1, the: 1, a: 1, tree: 1, strength: 1, through: 1, thought: 1, table: 2, little: 2, people: 2, simple: 2, candle: 2,
  make: 1, makes: 1, making: 2, jumped: 1, wanted: 2, played: 1, playing: 2, player: 2, needed: 2, boxes: 2, watches: 2, times: 1,
  pages: 2, happy: 2, happier: 3, happiest: 3, beautiful: 3, elephant: 3, banana: 3, computer: 3, education: 4, university: 5,
  information: 4, communication: 5, international: 5, nation: 2, radio: 3, piano: 3, violin: 3, video: 3, theory: 3, usual: 3,
  quality: 4, quiet: 2, society: 4, various: 3, serious: 3, precious: 2, social: 2, special: 2, being: 2, flying: 2, water: 2,
  river: 2, apple: 2, orange: 2, yellow: 2, yesterday: 3, tomorrow: 3, animal: 3, important: 3, example: 3, understand: 3,
  wonderful: 3, carefully: 3, completely: 3, statement: 2, lonely: 2, quickly: 2, slowly: 2, decided: 3, hoped: 1, named: 1,
  loved: 1, lives: 1, forest: 2, generation: 4, celebrate: 3, demonstrate: 3, consequently: 4, sufficient: 3, numerous: 3,
  initiate: 4, terminate: 3, modify: 3, possess: 2, purchase: 2, rhythm: 2, poem: 2, readability: 5, sentence: 2, paragraph: 3,
  syllable: 3, every: 3, idea: 3, area: 3, create: 2, hour: 1, fire: 1, chocolate: 3, anything: 3, business: 2, science: 2,
  difficult: 3, easy: 2, reading: 2, writing: 2, grade: 1, level: 2, score: 1, english: 2, plain: 1, simply: 2, clearly: 2
};
test('syllables: ≥ 95% exact on a reference word list, never off by more than one', function () {
  var ok = 0, n = 0, bad = [];
  Object.keys(SYL).forEach(function (w) {
    n++;
    var g = P.syllables(w);
    if (g === SYL[w]) ok++; else bad.push(w + ' ' + g + '/' + SYL[w]);
    assert.ok(Math.abs(g - SYL[w]) <= 1, w + ': ' + g + ' vs ' + SYL[w]);
  });
  assert.ok(ok / n >= 0.95, 'accuracy ' + ok + '/' + n + ' — ' + bad.join(', '));
});
test('syllables: case, punctuation, possessives, numbers, empties', function () {
  assert.strictEqual(P.syllables('Beautiful'), 3);
  assert.strictEqual(P.syllables("people's"), 2);
  assert.strictEqual(P.syllables('“table,”'), 2);
  assert.strictEqual(P.syllables('7'), 1);
  assert.strictEqual(P.syllables(''), 0);
  assert.ok(P.syllables('xyz') >= 1);
});

// ---------- formulas ----------
test('formulas match their definitions on known counts', function () {
  near(P.fre(100, 5, 130), 76.555, 1e-9);
  near(P.fkgl(100, 5, 130), 0.39 * 20 + 11.8 * 1.3 - 15.59, 1e-9);
  near(P.fog(100, 5, 10), 0.4 * (20 + 10), 1e-9);
  near(P.cli(100, 5, 450), 0.0588 * 450 - 0.296 * 5 - 15.8, 1e-9);
  near(P.smog(30, 10), 1.043 * Math.sqrt(10) + 3.1291, 1e-9);
  near(P.ari(100, 5, 450), 4.71 * 4.5 + 0.5 * 20 - 21.43, 1e-9);
});
test('"The cat sat on the mat." matches textstat reference values', function () {
  var r = P.analyze('The cat sat on the mat.');
  assert.strictEqual(r.words, 6); assert.strictEqual(r.sentences, 1); assert.strictEqual(r.syllables, 6);
  near(r.metrics.fre, 116.145, 0.01);           // textstat.flesch_reading_ease → 116.15
  near(r.metrics.fk, -1.45, 0.01);              // textstat.flesch_kincaid_grade → -1.5
  near(r.metrics.fog, 2.4, 0.01);
  near(r.metrics.ari, 4.71 * 17 / 6 + 3 - 21.43, 0.01);
  near(r.metrics.cli, 0.0588 * (17 / 6 * 100) - 0.296 * (100 / 6) - 15.8, 0.01);
  assert.strictEqual(r.metrics.smog, null);      // fewer than 30 sentences
});
test('a hand-counted paragraph lands on the expected scores', function () {
  // 3 sentences, 22 words; syllables by hand = 13 + 10 + 17 = 40 (every = 3)
  var t = 'Reading is important for understanding the world. Everybody should read every day. Good information helps people make better choices about their lives.';
  var r = P.analyze(t);
  assert.strictEqual(r.sentences, 3);
  assert.strictEqual(r.words, 22);
  assert.strictEqual(r.syllables, 40);
  near(r.metrics.fre, P.fre(22, 3, 40), 1e-9, 'FRE');
  near(r.metrics.fre, 45.573, 0.01, 'FRE');   // 206.835 − 1.015·22/3 − 84.6·40/22
  near(r.metrics.fk, 8.725, 0.01, 'FK');
  assert.strictEqual(r.polysyllables, 5);   // important, understanding, everybody, every, information
});
test('SMOG appears at 30 sentences; grade, bands and verdict', function () {
  var t = ''; for (var i = 0; i < 30; i++) t += 'The committee approved the extraordinary proposal yesterday. ';
  var r = P.analyze(t);
  assert.strictEqual(r.sentences, 30);
  assert.ok(r.metrics.smog > 5);
  near(r.metrics.smog, P.smog(30, r.polysyllables), 1e-9);
  assert.strictEqual(P.freBand(65)[1], 'Plain English');
  assert.strictEqual(P.freBand(95)[1], 'Very easy');
  assert.strictEqual(P.freBand(-20)[1], 'Extremely difficult');
  assert.strictEqual(P.verdict({ fre: 65, grade: 8.2 }), 'Plain English · grade 8 · 13–15 yr olds');
  assert.ok(/college/.test(P.verdict({ fre: 40, grade: 14 })));
  assert.strictEqual(P.verdict(null), '');
});
test('reading and speaking time', function () {
  var t = new Array(239).join('word ') + 'end.';
  var r = P.analyze(t);
  near(r.readMin, 238 / 238, 0.01);
  near(r.speakMin, 238 / 150, 0.01);
  assert.strictEqual(P.fmtDuration(0.5), '30 sec');
  assert.strictEqual(P.fmtDuration(2), '2 min');
  assert.strictEqual(P.fmtDuration(125), '2 h 5 min');
  assert.strictEqual(P.fmtDuration(0), '—');
});

// ---------- sentences ----------
test('sentence splitting: abbreviations, initials, decimals, ?! and quotes', function () {
  function split(t) { var m = P.stripMarkdown(t); return P.sentences(m.text, m.headings).map(function (s) { return m.text.slice(s.cs, s.ce); }); }
  assert.deepStrictEqual(split('Mr. Smith paid $3.50 today. Was it fair? Yes!'), ['Mr. Smith paid $3.50 today.', 'Was it fair?', 'Yes!']);
  assert.deepStrictEqual(split('We met J. K. Rowling. She said "hello." Then we left.'), ['We met J. K. Rowling.', 'She said "hello."', 'Then we left.']);
  assert.deepStrictEqual(split('Use tools, e.g. hammers and saws. Done.'), ['Use tools, e.g. hammers and saws.', 'Done.']);
  assert.deepStrictEqual(split('No period here\n\nNew paragraph'), ['No period here', 'New paragraph']);
  assert.deepStrictEqual(split('A line that wraps\nonto the next. Second.'), ['A line that wraps\nonto the next.', 'Second.']);
});
test('headings and table cells are left out of the scores', function () {
  var a = P.analyze('The cat sat on the mat.');
  var b = P.analyze('# A Very Long Heading With Extraordinary Vocabulary\n\nThe cat sat on the mat.\n\n| Alpha | Beta |\n|---|---|\n| one | two |');
  assert.strictEqual(b.sentences, 1);
  near(b.metrics.fre, a.metrics.fre, 1e-9);
  assert.ok(b.wordsAll > b.words);
});

// ---------- Markdown stripping + offset map ----------
var MD = '# My **Title** here\n\n' +
  'The report was written by the team. It is *very* clear that we must [utilize better tools](https://example.com/a_b) in order to win.\n\n' +
  '- [ ] First _item_ is good\n' +
  '1. Second item ![alt text](img.png)\n\n' +
  '```js\nvar x = was_written; // passive?\n```\n\n' +
  '> Quoted text with `inline code` and <b>bold</b> and https://foo.bar/baz?x=1 here.\n\n' +
  'Wiki [[Some Page|alias words]] and a footnote[^1] and a ref [link][r].\n\n' +
  '[r]: https://example.org\n';
test('stripMarkdown removes syntax, code and URLs', function () {
  var m = P.stripMarkdown(MD), t = m.text;
  assert.ok(/^My Title here\n\n/.test(t), JSON.stringify(t.slice(0, 30)));
  ['#', '**', 'https', 'example.com', '```', 'var x', 'inline code', '![', 'img.png', 'alt text', '<b>', 'foo.bar', '[[', '[^1]', '[r]', '- [ ]', '1.'].forEach(function (s) {
    assert.ok(t.indexOf(s) === -1, 'should strip ' + s + ' — ' + JSON.stringify(t));
  });
  ['utilize better tools in order to win.', 'First item is good', 'Second item', 'Quoted text with  and bold and  here.', 'alias words', 'a ref link.'].forEach(function (s) {
    assert.ok(t.indexOf(s) !== -1, 'should keep ' + s + ' — ' + JSON.stringify(t));
  });
  assert.strictEqual(m.headings.length, 1);
  assert.strictEqual(t.slice(m.headings[0][0], m.headings[0][1]), 'My Title here');
});
test('the offset map points every kept character at its source', function () {
  [MD, 'plain', '', '**a** _b_ ~~c~~ `d` [e](f) \\*g\\*', '| x | y |\n|--|--|\n| 1 | 2 |', 'snake_case_word and __bold__'].forEach(function (src) {
    var m = P.stripMarkdown(src);
    assert.strictEqual(m.map.length, m.text.length + 1);
    assert.strictEqual(m.map[m.text.length], src.length);
    for (var i = 0; i < m.text.length; i++) {
      if (m.text[i] === '\n') continue;
      assert.strictEqual(src[m.map[i]], m.text[i], 'char ' + i + ' of ' + JSON.stringify(src));
      if (i) assert.ok(m.map[i] > m.map[i - 1] || m.text[i - 1] === '\n', 'map increases');
    }
  });
  assert.strictEqual(P.stripMarkdown('snake_case_word and __bold__').text, 'snake_case_word and bold');
  assert.strictEqual(P.stripMarkdown('\\*not emphasis\\*').text, '*not emphasis*');
});
test('flags map back to the exact text in the original note', function () {
  var r = P.analyze(MD);
  var got = {};
  r.flags.forEach(function (f) { (got[f.kind] = got[f.kind] || []).push(MD.slice(f.from, f.to)); });
  assert.deepStrictEqual(got.passive, ['was written']);
  assert.ok(got.filler.indexOf('very') !== -1 && got.filler.indexOf('in order to') !== -1, JSON.stringify(got.filler));
  assert.deepStrictEqual(got.complex, ['utilize']);
  // nothing from the code block
  r.flags.forEach(function (f) { assert.ok(MD.slice(f.from, f.to).indexOf('was_written') === -1); });
});
test('a base offset (analysing a selection) shifts every flag', function () {
  var doc = 'Intro text here.\n\nThe ball was thrown by Sam, really.';
  var from = doc.indexOf('The ball');
  var r = P.analyze(doc.slice(from), { base: from });
  var p = r.flags.filter(function (f) { return f.kind === 'passive'; })[0];
  assert.strictEqual(doc.slice(p.from, p.to), 'was thrown');
  var f = r.flags.filter(function (x) { return x.kind === 'filler'; })[0];
  assert.strictEqual(doc.slice(f.from, f.to), 'really');
});
test('a multi-line sentence flag spans the original source', function () {
  var words = []; for (var i = 0; i < 34; i++) words.push('word' + (i % 5 ? '' : 's'));
  var src = '* ' + words.slice(0, 17).join(' ') + '\n  ' + words.slice(17).join(' ') + '.';
  var f = P.analyze(src).flags.filter(function (x) { return x.kind === 'long'; })[0];
  assert.ok(f, 'long sentence flagged');
  assert.strictEqual(src.slice(f.from, f.to), src.slice(2));
});

// ---------- flags ----------
test('passive voice: positives', function () {
  [['The ball was thrown by John.', 'was thrown'], ['The cake is being eaten.', 'is being eaten'], ['Mistakes were made.', 'were made'],
   ['The house has been sold.', 'been sold'], ['The letter was quickly written.', 'was quickly written'], ['It is not allowed here.', 'is not allowed'],
   ['The results were analysed by experts.', 'were analysed'], ['The window was broken.', 'was broken'], ['They\'re paid weekly.', 'They\'re paid'],
   ['The proposal was rejected.', 'was rejected'], ['Errors are often hidden.', 'are often hidden']
  ].forEach(function (c) { assert.deepStrictEqual(flagsOf(c[0], 'passive'), [c[1]], c[0]); });
});
test('passive voice: negatives', function () {
  ['She was happy.', 'He is running fast.', 'The sky is blue.', 'I was tired.', 'He is interested in art.', 'She has written a book.',
   'It is red.', 'We are used to it.', 'He was gone.', 'They were in the garden.', 'This is indeed true.', 'It was a hundred miles.',
   'The plan is, frankly, finished.'
  ].forEach(function (t) { assert.deepStrictEqual(flagsOf(t, 'passive'), [], t); });
});
test('passive voice: "by" lets an adjective-like participle count', function () {
  var r = P.analyze('She was interested by the offer.');
  var p = r.flags.filter(function (f) { return f.kind === 'passive'; });
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].by, true);
  assert.strictEqual(P.analyze('The door was opened.').flags.filter(function (f) { return f.kind === 'passive'; })[0].by, false);
  assert.ok(P.isParticiple('written') && P.isParticiple('jumped') && !P.isParticiple('need') && !P.isParticiple('red'));
});
test('adverbs, with exceptions and no double flag for filler -ly words', function () {
  assert.deepStrictEqual(flagsOf('He ran quickly and spoke softly.', 'adverb'), ['quickly', 'softly']);
  assert.deepStrictEqual(flagsOf('Only my family came early. It was a lovely, friendly reply.', 'adverb'), []);
  assert.deepStrictEqual(flagsOf('It is really basically done.', 'adverb'), []);
  assert.deepStrictEqual(flagsOf('It is really basically done.', 'filler'), ['really', 'basically']);
  assert.deepStrictEqual(flagsOf('Approximately half came.', 'adverb'), []);   // listed as a complex word instead
  assert.deepStrictEqual(flagsOf('Approximately half came.', 'complex'), ['Approximately']);
});
test('filler, hedges, clichés, complex words and repeats', function () {
  assert.deepStrictEqual(flagsOf('In order to win we need a lot of luck, I think.', 'filler'), ['In order to', 'a lot', 'I think']);
  assert.deepStrictEqual(flagsOf('Due to the fact that it rained, we stayed.', 'filler'), ['Due to the fact that']);
  assert.deepStrictEqual(flagsOf('Justice and adjusted plans.', 'filler'), []);   // whole words only
  assert.deepStrictEqual(flagsOf('At the end of the day we must think outside the box.', 'cliche'), ['At the end of the day', 'think outside the box']);
  assert.deepStrictEqual(flagsOf('Pick the low-hanging fruit first.', 'cliche'), ['low-hanging fruit']);
  var r = P.analyze('We utilized the tool to commence work, prior to lunch.');
  var cx = r.flags.filter(function (f) { return f.kind === 'complex'; });
  assert.deepStrictEqual(cx.map(function (f) { return f.text; }), ['utilized', 'commence', 'prior to']);
  assert.deepStrictEqual(cx.map(function (f) { return f.hint; }), ['use', 'start', 'before']);
  assert.deepStrictEqual(flagsOf('Check the the list and and the end. The\nthe wrap.', 'repeat'), ['the the', 'and and', 'The\nthe']);
  assert.deepStrictEqual(flagsOf('The theme. Bye bye-bye. 4 4', 'repeat'), []);
  assert.deepStrictEqual(flagsOf('very\n\nvery', 'repeat'), []);   // not across paragraphs
});
test('long and hard sentences', function () {
  var long = 'This sentence just keeps on going and going with many words that never seem to stop because the writer has a lot to say about nothing in particular at all today.';
  var r = P.analyze(long);
  assert.strictEqual(r.flags.filter(function (f) { return f.kind === 'long'; }).length, 1);
  var hard21 = 'Comprehensive organizational transformation necessitates considerable institutional commitment and sophisticated communication methodologies and extraordinarily collaborative leadership capabilities across international departments everywhere today.';
  var h = P.analyze(hard21).flags.filter(function (f) { return f.kind === 'hard' || f.kind === 'long'; });
  assert.strictEqual(h.length, 1); assert.strictEqual(h[0].kind, 'hard'); assert.ok(h[0].grade >= 12);
  var easy21 = 'I went to the shop and I got some milk and some bread and then I went back home to my cat and dog now.';
  assert.deepStrictEqual(P.analyze(easy21).flags.filter(function (f) { return f.kind === 'hard' || f.kind === 'long'; }), []);
});
test('counts per kind and flags are sorted by position', function () {
  var r = P.analyze('He really ran quickly. The the end was written by me.');
  assert.strictEqual(r.counts.filler, 1); assert.strictEqual(r.counts.adverb, 1); assert.strictEqual(r.counts.repeat, 1); assert.strictEqual(r.counts.passive, 1);
  for (var i = 1; i < r.flags.length; i++) assert.ok(r.flags[i].from >= r.flags[i - 1].from);
  assert.deepStrictEqual(P.KINDS.map(function (k) { return k.id; }), ['long', 'hard', 'passive', 'adverb', 'filler', 'cliche', 'repeat', 'complex']);
});
test('context snippets stay inside the paragraph', function () {
  var m = P.stripMarkdown('First para here.\n\nIt is very clear indeed that the thing works well enough for us all.');
  var at = m.text.indexOf('very');
  var c = P.context(m.text, at, at + 4, 12);
  assert.strictEqual(c.match, 'very');
  assert.ok(c.before.indexOf('First') === -1);
  assert.ok(/…$/.test(c.after));
});
test('very large notes are capped and stay fast', function () {
  var para = 'The report was written by the team and it is very clear that we basically need to utilize better tools. ';
  var big = ''; while (big.length < P.MAX_CHARS + 5000) big += para;
  var t0 = Date.now(), r = P.analyze(big);
  assert.ok(r.truncated);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
  assert.ok(r.flags.filter(function (f) { return f.kind === 'filler'; }).length <= 400);
  assert.ok(r.counts.filler > 400);
});
test('empty and code-only notes give no metrics', function () {
  assert.strictEqual(P.analyze('').metrics, null);
  assert.strictEqual(P.analyze('```\nvar a = 1;\n```').metrics, null);
  assert.strictEqual(P.analyze(null).words, 0);
});

console.log(passed + ' passed');
