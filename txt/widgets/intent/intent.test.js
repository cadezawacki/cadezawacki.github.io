/* Checks for the Ctrl+K palette's plain-language matching (intent-core.js):
 * a table of everyday phrasings against the REAL manifest catalogue, the
 * normaliser (stemming, synonyms, idioms), learning from picks, garbage input,
 * and that the palette's blend keeps today's top result for name queries
 * (the old scorer is lifted out of txt.html, so it's the live one).
 * Not loaded by the app. Run: node txt/widgets/intent/intent.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var I = require('./intent-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

var ROOT = path.join(__dirname, '..', '..', '..');
var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'txt', 'manifest.json'), 'utf8'));
// The palette's rows as bootModules registers them: widget stubs (tags get
// ",widget" like widgetPickerRows) and every script-pack script row.
var CATALOGUE = [];
manifest.modules.forEach(function (m) {
  if (m.type === 'widget') CATALOGUE.push({ name: m.name, description: m.description || '', tags: (m.tags ? m.tags + ',' : '') + 'widget', kind: 'widget' });
  if (m.type === 'script-pack') (m.scripts || []).forEach(function (s) { CATALOGUE.push({ name: s.name, description: s.description || '', tags: s.tags || '', kind: 'script' }); });
});
var INDEX = I.buildIndex(CATALOGUE);
function names(q, opts) { return I.rank(q, INDEX, opts).map(function (r) { return r.name; }); }

// [phrase, expected]  → expected is #1.
// [phrase, expected, alt] → expected is in the top 3 and #1 is expected or alt.
var PHRASES = [
  ['sort these by length', 'Sort Lines by Length'],
  ['sort lines alphabetically', 'Sort List'],
  ['alphabetise', 'Sort List'],
  ['put these in a to z order', 'Sort List'],
  ['remove duplicate lines', 'Unique Lines'],
  ['get rid of duplicates', 'Unique Lines'],
  ['dedupe this list', 'Unique Lines'],
  ['get rid of blank lines', 'Delete Blank Lines'],
  ['delete empty lines', 'Delete Blank Lines'],
  ['squeeze multiple blank lines into one', 'Collapse Blank Lines'],
  ['make it title case', 'Title Case'],
  ['capitalize every word', 'Title Case'],
  ['make everything lowercase', 'Lower Case'],
  ['all caps', 'Upper Case'],
  ['uppercase this', 'Upper Case'],
  ['shuffle the lines', 'Shuffle Lines'],
  ['randomize the order', 'Shuffle Lines'],
  ['reverse the lines', 'Reverse List'],
  ['flip the order of the list', 'Reverse List'],
  ['number the lines', 'Number Lines'],
  ['add bullet points', 'Bullet List'],
  ['turn these lines into a todo list', 'Convert Todo'],
  ['count the words', 'Count Words'],
  ['how many words is this', 'Count Words'],
  ['word count', 'Count Words'],
  ['turn this csv into a table', 'CSV → Markdown Table'],
  ['markdown table back to csv', 'Markdown Table → CSV'],
  ['convert json to csv', 'JSON to CSV'],
  ['pretty print this json', 'JSON Format'],
  ['minify the json', 'JSON Minify'],
  ['base64 encode this', 'Encode Base64'],
  ['decode base64', 'Decode Base64'],
  ['remove trailing spaces', 'Strip Trailing Whitespace'],
  ['convert tabs to spaces', 'Tabs → Spaces'],
  ['put everything on one line', 'Flatten'],
  ['one sentence per line', 'One Sentence Per Line'],
  ['pull out the email addresses', 'Extract Emails'],
  ['find all the links', 'Extract URLs'],
  ['add up these numbers', 'Sum'],
  ['open the calculator', 'Calculator'],
  ['start a 10 minute timer', 'Timer'],
  ['timer 5 minutes', 'Timer'],
  ['qr code for this link', 'QR Code'],
  ['random number', 'Random Picker'],
  ['flip a coin', 'Random Picker'],
  ['roll a dice', 'Random Picker'],
  ['what is the weather', 'Weather'],
  ['look up a word', 'Dictionary'],
  ['read this out loud', 'Read Aloud'],
  ['generate a password', 'Password Generator'],
  ['pick a colour', 'Color Picker'],
  ['play snake', 'Snake'],
  ['strip html tags', 'Strip HTML Tags'],
  ['table of contents', 'Outline'],
  ['remove code comments', 'Strip Code Comments'],
  ['sort by date', 'Sort Lines by Date'],
  ['sort by date newest first', 'Sort Lines by Date (newest first)'],
  ['remove accents', 'Transliterate to ASCII'],
  ['translate to english', 'Translate to English'],
  ['sort my shopping list', 'Sort Shopping List by Aisle'],
  ['scale the recipe to 6 servings', 'Scale Recipe…'],
  ['black out this text', 'Redact Selection'],
  ['draw a box around it', 'Box It…'],
  ['split the bill', 'Split the Bill'],
  ['tip calculator', 'Split the Bill'],
  ['convert hex to rgb', 'Hex ↔ RGB'],
  ['fix the numbered list', 'Renumber Lists'],
  ['sort by the second column', 'Sort by Column'],
  ['indent these lines', 'Indent / Dedent'],
  ['make it snake case', 'snake_case'],
  ['make a slug', 'kebab-case'],
  ['record a voice memo', 'Voice Note'],
  ['send a file to my phone', 'Beam'],
  ['breathing exercise', 'Breathing Exercise'],
  ['sketch something', 'Whiteboard'],
  ['run this code', 'Run Code Block'],
  ['split by comma', 'Split by Comma'],
  ['round to 2 decimal places', 'Round To'],
  ['wrap lines at 80 columns', 'Wrap at N Columns…'],
  ['join the lines together', 'Join Lines'],
  ['make a kanban board', 'Kanban Board'],
  ['spongebob mocking text', 'Alternating Case (aLtErNaTiNg)'],
  ['convert to morse code', 'Morse Code'],
  ['sha256 hash', 'Hash SHA-256'],
  ['straighten the smart quotes', 'Straighten Quotes', 'Clean Quotes'],
  ['remove markdown formatting', 'Clear Markdown', 'Markdown to Plain'],
  ['convert celsius to fahrenheit', 'Convert', 'Unit Converter'],
  ['insert the current date', 'Timestamp', 'Insert Timestamp As…'],
  ['trim whitespace', 'Trim / Clean', 'Strip Trailing Whitespace'],
  ['wrap each line in quotes', 'Quoter', 'Wrap Lines'],
  ['what time is it in other cities', 'World Clock', 'Insert Time In Zones…'],
];

test('catalogue is the real manifest (widgets + script-pack rows)', function () {
  assert.ok(CATALOGUE.length > 200, 'rows: ' + CATALOGUE.length);
  PHRASES.forEach(function (p) {
    assert.ok(CATALOGUE.some(function (c) { return c.name === p[1]; }), 'no such command: ' + p[1]);
  });
});

PHRASES.forEach(function (p) {
  test('"' + p[0] + '" → ' + p[1], function () {
    var top = names(p[0], { limit: 3 });
    if (p[2]) {
      assert.ok(top.indexOf(p[1]) >= 0, p[1] + ' not in top 3: ' + top.join(' | '));
      assert.ok(top[0] === p[1] || top[0] === p[2], 'top is ' + top[0]);
    } else assert.strictEqual(top[0], p[1], 'got ' + top.join(' | '));
  });
});
test('at least 40 phrasings resolve to #1 outright', function () {
  assert.ok(PHRASES.filter(function (p) { return !p[2]; }).length >= 40);
});
test('the right answer is also confident for clear phrasings', function () {
  ['sort these by length', 'remove duplicate lines', 'get rid of blank lines', 'make it title case',
    'turn this csv into a table', 'count the words', 'shuffle the lines', 'open the calculator', 'start a 10 minute timer'].forEach(function (q) {
    var r = I.rank(q, INDEX)[0];
    assert.ok(r.confident && r.confidence >= 0.5, q + ' → ' + r.name + ' ' + r.score);
  });
});

test('stemming folds plurals and verb forms', function () {
  assert.strictEqual(I.stem('lines'), I.stem('line'));
  assert.strictEqual(I.stem('sorting'), 'sort');
  assert.strictEqual(I.stem('sorted'), 'sort');
  assert.strictEqual(I.stem('boxes'), 'box');
  assert.strictEqual(I.stem('entries'), 'entry');
  assert.strictEqual(I.stem('shuffling'), I.stem('shuffle'));
  assert.strictEqual(I.stem('randomise'), I.stem('randomize'));
  assert.strictEqual(I.stem('class'), 'class', 'ss is not a plural');
});
test('synonyms meet in one concept', function () {
  function cs(q) { return I.analyze(q).toks.map(function (t) { return t.c; }).join(' '); }
  ['remove', 'delete', 'strip', 'drop', 'erase', 'get rid of'].forEach(function (w) { assert.strictEqual(cs(w), 'remove', w); });
  assert.strictEqual(cs('dupes'), cs('duplicates'));
  assert.strictEqual(cs('repeated'), 'duplicate');
  assert.strictEqual(cs('dedupe'), 'remove duplicate');
  assert.strictEqual(cs('order'), 'sort'); assert.strictEqual(cs('arrange'), 'sort');
  assert.strictEqual(cs('flip'), 'reverse'); assert.strictEqual(cs('invert'), 'reverse');
  assert.strictEqual(cs('caps'), 'upper'); assert.strictEqual(cs('uppercase'), 'upper case');
  assert.strictEqual(cs('randomise'), 'shuffle');
  assert.strictEqual(cs('how many'), 'count');
  assert.strictEqual(cs('colour'), 'color');
  assert.strictEqual(cs('a to z'), 'sort alpha');
  assert.strictEqual(cs('spaces'), 'whitespace');
  assert.strictEqual(cs('JSON → CSV'), 'json csv');
});
test('stop words and politeness are ignored', function () {
  assert.deepStrictEqual(names('please could you sort these lines by length for me', { limit: 1 }), ['Sort Lines by Length']);
  assert.strictEqual(I.analyze('the this it please').toks.length, 0);
});
test('argument hints pick the specific command, never invent one', function () {
  assert.strictEqual(names('sort by length')[0], 'Sort Lines by Length');
  assert.strictEqual(names('longest first')[0], 'Sort Lines by Length');
  assert.strictEqual(names('sort by date newest first')[0], 'Sort Lines by Date (newest first)');
  assert.strictEqual(names('sort descending')[0], 'Sort List', 'no date in the query → the plain sort');
  assert.strictEqual(names('play 2048')[0], '2048');
  assert.deepStrictEqual(I.analyze('timer 5 minutes').numbers, [5]);
  assert.ok(I.analyze('in 10 mins').toks.some(function (t) { return t.c === 'timer'; }), 'n minutes → countdown');
});
test('direction: csv into a table is not a table into csv', function () {
  assert.strictEqual(names('turn this csv into a table')[0], 'CSV → Markdown Table');
  assert.strictEqual(names('turn the table into csv')[0], 'Markdown Table → CSV');
  assert.strictEqual(names('convert spaces to tabs')[0], 'Spaces → Tabs');
  assert.strictEqual(names('convert tabs to spaces')[0], 'Tabs → Spaces');
});
test('a selection nudges scripts; "open / play" nudges widgets', function () {
  var a = I.rank('word count', INDEX).filter(function (r) { return r.name === 'Count Words'; })[0].score;
  var b = I.rank('word count', INDEX, { hasSelection: true }).filter(function (r) { return r.name === 'Count Words'; })[0].score;
  assert.ok(b > a);
  var w1 = I.rank('word stats', INDEX).filter(function (r) { return r.name === 'Text Stats'; })[0].score;
  var w2 = I.rank('open word stats', INDEX).filter(function (r) { return r.name === 'Text Stats'; })[0].score;
  assert.ok(w2 > w1);
});
test('empty / garbage input returns nothing confident', function () {
  assert.deepStrictEqual(I.rank('', INDEX), []);
  assert.deepStrictEqual(I.rank('   ', INDEX), []);
  assert.deepStrictEqual(I.rank('the it this', INDEX), []);
  assert.deepStrictEqual(I.rank('asdfgh qwerty zxcv', INDEX), []);
  assert.deepStrictEqual(I.rank('!!!???', INDEX), []);
  ['hello there', 'banana', 'xyz 123', 'lorem ipsum dolor'].forEach(function (q) {
    I.rank(q, INDEX).forEach(function (r) { assert.ok(!r.confident, q + ' → ' + r.name + ' marked confident'); });
  });
});
test('results carry the matched words for the hint', function () {
  var r = I.rank('get rid of blank lines', INDEX)[0];
  assert.strictEqual(r.name, 'Delete Blank Lines');
  assert.ok(r.matched.indexOf('blank') >= 0 && r.matched.indexOf('lines') >= 0, r.matched.join());
  assert.ok(r.terms.indexOf('remove') >= 0);
});

test('learning: a pick boosts that command for the same phrase next time', function () {
  var q = 'tidy my list';
  var before = names(q, { limit: 10 });
  var target = 'Columnize List…';
  assert.notStrictEqual(before[0], target);
  var mem = I.learn(null, q, target, 1);
  assert.strictEqual(names(q, { memory: mem })[0], target);
  // word order / filler words don't matter
  assert.strictEqual(names('please tidy the list', { memory: mem })[0], target);
  // an unrelated phrase is unaffected
  assert.strictEqual(names('remove duplicate lines', { memory: mem })[0], 'Unique Lines');
  // survives a JSON round trip (Cade.store)
  assert.strictEqual(names(q, { memory: JSON.parse(JSON.stringify(mem)) })[0], target);
});
test('learning is bounded to the 200 most recent phrases', function () {
  var mem = null;
  for (var i = 0; i < 260; i++) mem = I.learn(mem, 'phrase word' + i, 'Timer', i + 1);
  var keys = Object.keys(mem.p);
  assert.strictEqual(keys.length, I.MAX_PHRASES);
  assert.ok(!mem.p[I.memoryKey('phrase word0')], 'oldest dropped');
  assert.ok(mem.p[I.memoryKey('phrase word259')], 'newest kept');
  assert.strictEqual(I.learn(mem, 'the', 'Timer').p[''], undefined, 'empty phrases are not stored');
});

// ---- the palette blend vs today's scorer ----------------------------------
var html = fs.readFileSync(path.join(ROOT, 'txt.html'), 'utf8');
function lift(name) {
  var i = html.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' not found in txt.html');
  var j = html.indexOf('\n}\n', i);
  return html.slice(i, j + 3);
}
var scoreScript = new Function(lift('fuzzyMatch') + lift('scoreScript') + 'return scoreScript;')();
function oldRank(q, rows) {
  return rows.map(function (s) { return { s: s, score: scoreScript(q, s) }; })
    .filter(function (x) { return x.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .map(function (x) { return x.s; });
}
function newRank(q, rows, opts) {
  return I.blend(q, rows, scoreScript, Object.assign({ index: INDEX }, opts || {})).map(function (x) { return x.row; });
}
var NAME_QUERIES = ['sort', 'Sort List', 'upper', 'lower case', 'title', 'json', 'timer', 'calc', 'base64', 'unique',
  'snake', 'count', 'qr', 'csv', 'markdown', 'hash', 'trim', 'todo', 'shuffle', 'translate', 'tetris', 'wordle', 'pomodoro',
  'beautify', 'weather', 'flatten', 'kanban', 'regex', 'emoji', 'minify'];
test('typical name queries keep their current top result (and name-hit order)', function () {
  NAME_QUERIES.forEach(function (q) {
    var o = oldRank(q, CATALOGUE), n = newRank(q, CATALOGUE);
    assert.ok(o.length, 'old finds something for ' + q);
    assert.strictEqual(n[0].name, o[0].name, q + ': ' + o[0].name + ' → ' + n[0].name);
    var hits = o.filter(function (s) { return scoreScript(q, s) >= 800; }).map(function (s) { return s.name; });
    assert.deepStrictEqual(n.slice(0, hits.length).map(function (s) { return s.name; }), hits, q + ': name hits reordered');
  });
});
test('a learned pick never reorders name hits', function () {
  var mem = I.learn(null, 'sort', 'Sort Lines by Length', 1);
  assert.strictEqual(newRank('sort', CATALOGUE, { memory: mem })[0].name, oldRank('sort', CATALOGUE)[0].name);
});
test('without the index (core missing) the blend is exactly today\'s ranking', function () {
  ['sort these by length', 'get rid of blank lines', 'json', 'zz'].forEach(function (q) {
    var o = oldRank(q, CATALOGUE).map(function (s) { return s.name; });
    var n = I.blend(q, CATALOGUE, scoreScript, {}).map(function (x) { return x.row.name; });
    assert.deepStrictEqual(n, o, q);
  });
});
test('plain-language queries now put the right row first in the palette, with a hint', function () {
  [['sort these by length', 'Sort Lines by Length'], ['get rid of blank lines', 'Delete Blank Lines'],
    ['start a 10 minute timer', 'Timer'], ['remove duplicate lines', 'Unique Lines'], ['open the calculator', 'Calculator']].forEach(function (p) {
    var r = I.blend(p[0], CATALOGUE, scoreScript, { index: INDEX });
    assert.strictEqual(r[0].row.name, p[1], p[0] + ' → ' + r[0].row.name);
    assert.ok(r[0].hint.length > 0, 'hint');
  });
  // name hits show no hint
  assert.strictEqual(I.blend('sort', CATALOGUE, scoreScript, { index: INDEX })[0].hint, '');
});
test('index accepts the palette\'s own rows (kind from __widget)', function () {
  var idx = I.buildIndex([{ name: 'Timer', description: 'Pomodoro', tags: 'timer', __widget: {} }, { name: 'Sort List', description: '', tags: 'sort' }]);
  assert.strictEqual(idx.items[0].kind, 'widget');
  assert.strictEqual(idx.items[1].kind, 'script');
});
test('txt.html loads the core lazily and keeps the old path', function () {
  assert.ok(html.indexOf("'./txt/widgets/intent/intent-core.js'") > 0);
  assert.ok(/window\.openPicker = function\(\) \{[\s\S]{0,400}_intentLoad\(\);/.test(html), 'loaded when the palette opens');
  assert.ok(html.indexOf("addEventListener('input', _pickerFilter)") > 0);
});
test('ranking 255 rows stays cheap', function () {
  var t = Date.now();
  for (var i = 0; i < 50; i++) I.blend('sort these lines by length please', CATALOGUE, scoreScript, { index: INDEX });
  assert.ok((Date.now() - t) / 50 < 15, 'per keystroke ms: ' + (Date.now() - t) / 50);
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'intent: ' + passed + ' passed');
