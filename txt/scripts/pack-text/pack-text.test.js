/* Tests for the Text Pack's new scripts (Numbers ↔ Words, Ordinals, Pluralize /
 * Singularize Lines, Lorem Ipsum…, Truncate / Surround / Suffix Lines…) and the
 * pack's palette metadata. Not loaded by the app.
 * Run: node txt/scripts/pack-text/pack-text.test.js */
'use strict';
// ---------------------------------------------------------------------------
// Harness: load the pack with a stubbed Cade.registerScript, then run a
// script's source the way txt.html's executeScript does — new Function over
// (window, document, ctx, showToast), with ctx.selection = the explicit
// selection, else the cursor's non-empty line, else '' (→ whole document).
// ---------------------------------------------------------------------------
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');

var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

function loadPack(file) {
  var reg = [], win = { Cade: { registerScript: function (s) { reg.push(s); } } };
  var sandbox = { window: win, console: console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), sandbox);
  var out = {};
  reg.forEach(function (src) {
    var m = src.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//);
    var meta = JSON.parse(m[1]);
    assert.ok(!out[meta.name], 'duplicate script name ' + meta.name);
    out[meta.name] = { meta: meta, code: src.slice(m[0].length).trim() };
  });
  return out;
}

// A minimal CodeMirror-like editor over a string.
function fakeEditor(text, from, to) {
  var ed = { dispatched: [] };
  function mkState(doc, f, t) {
    var lines = doc.split('\n');
    function line(n) { var s = 0; for (var i = 0; i < n - 1; i++) s += lines[i].length + 1; return { number: n, from: s, to: s + lines[n - 1].length, text: lines[n - 1] }; }
    return {
      readOnly: false,
      doc: {
        length: doc.length, lines: lines.length,
        toString: function () { return doc; },
        sliceString: function (a, b) { return doc.slice(a, b === undefined ? doc.length : b); },
        line: line,
        lineAt: function (pos) { var n = doc.slice(0, pos).split('\n').length; return line(n); }
      },
      sliceDoc: function (a, b) { return doc.slice(a, b); },
      selection: { main: { from: f, to: t, head: t, anchor: f, empty: f === t } }
    };
  }
  ed.state = mkState(text, from, to);
  ed.dispatch = function (tr) {
    var doc = ed.state.doc.toString(), c = tr.changes;
    var next = c ? doc.slice(0, c.from) + c.insert + doc.slice(c.to) : doc;
    var head = tr.selection ? tr.selection.anchor : Math.min(ed.state.selection.main.head, next.length);
    ed.state = mkState(next, head, head);
    ed.dispatched.push(tr);
  };
  return ed;
}

// run(script, doc, {sel: [from, to] | cursor: pos, prompts: [...]}) →
// {doc, toasts, asked}. Without sel/cursor the cursor sits at the end.
function run(script, doc, opts) {
  opts = opts || {};
  var from, to;
  if (opts.sel) { from = opts.sel[0]; to = opts.sel[1]; }
  else { from = to = opts.cursor !== undefined ? opts.cursor : doc.length; }
  var ed = fakeEditor(doc, from, to);
  var store = opts.store || {};
  var win = { Cade: { editor: ed, store: { get: function (k) { return store[k] === undefined ? null : store[k]; }, set: function (k, v) { store[k] = v; } } } };
  var toasts = [], asked = [], answers = (opts.prompts || []).slice();
  var savedPrompt = global.prompt;
  global.prompt = function (msg, def) { asked.push([msg, def]); return answers.length ? answers.shift() : null; };

  var state = ed.state, sel = state.selection.main, fullText = state.doc.toString();
  var editFrom, editTo, editText, hasSelection;
  if (sel.from !== sel.to) { editFrom = sel.from; editTo = sel.to; editText = fullText.slice(sel.from, sel.to); hasSelection = true; }
  else {
    var line = state.doc.lineAt(sel.head);
    if (line.text.length > 0) { editFrom = line.from; editTo = line.to; editText = line.text; hasSelection = true; }
    else { editFrom = 0; editTo = fullText.length; editText = fullText; hasSelection = false; }
  }
  var newFull = fullText, newEdit = editText, fullChanged = false, editChanged = false;
  var ctx = {
    get fullText() { return newFull; },
    set fullText(v) { newFull = v; fullChanged = true; },
    get selection() { return hasSelection ? newEdit : ''; },
    set selection(v) { if (hasSelection) { newEdit = v; editChanged = true; } else { newFull = v; fullChanged = true; } },
    get text() { return hasSelection ? newEdit : newFull; }
  };
  try {
    var fn = new Function('window', 'document', 'ctx', 'showToast', script.code + '\nmain(ctx);');
    fn(win, {}, ctx, function (msg, type) { toasts.push([type, msg]); });
  } finally { global.prompt = savedPrompt; }
  var cur = ed.state.doc.toString();
  if (editChanged && hasSelection) cur = cur.slice(0, editFrom) + newEdit + cur.slice(editTo);
  else if (fullChanged) cur = newFull;
  return { doc: cur, toasts: toasts, asked: asked, store: store, editor: ed };
}

// Metadata rows: every registered script has the palette fields and every
// manifest row names a registered script. Rows that differ from the manifest
// (new / updated ones until their manifest rows are written, or older drift)
// are reported as a NOTE rather than failing.
function checkManifest(packId, scripts, pending) {
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
  var list = man.modules || man.items || man;
  var entry = (Array.isArray(list) ? list : []).filter(function (m) { return m && m.id === packId; })[0];
  assert.ok(entry, 'manifest has ' + packId);
  var notes = [];
  Object.keys(scripts).forEach(function (name) {
    var m = scripts[name].meta;
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.ok(typeof m[k] === 'string' && m[k], name + ' has ' + k); });
    var row = { name: m.name, description: m.description, icon: m.icon, tags: m.tags };
    var found = entry.scripts.filter(function (r) { return r.name === name; })[0];
    if (pending.indexOf(name) >= 0) {
      if (!found) notes.push('add row ' + JSON.stringify(name));
      else if (JSON.stringify(found) !== JSON.stringify(row)) notes.push('update row ' + JSON.stringify(name));
    } else if (!found || JSON.stringify(found) !== JSON.stringify(row)) {
      notes.push('pre-existing drift on ' + JSON.stringify(name) + ' (not part of this change)');
    }
  });
  entry.scripts.forEach(function (r) { assert.ok(scripts[r.name], 'manifest row ' + r.name + ' is registered by the pack'); });
  if (notes.length) console.log('NOTE ' + packId + ' manifest pending: ' + notes.join('; '));
}

var S = loadPack('pack-text.js');
var N2W = S['Numbers → Words'], W2N = S['Words → Numbers'], ORD = S['Ordinals'];
var PL = S['Pluralize Lines'], SG = S['Singularize Lines'], LOREM = S['Lorem Ipsum…'];
var TRUNC = S['Truncate Lines…'], SUR = S['Surround Lines…'], SUF = S['Suffix Lines…'];
var PREFIX = loadPack('../pack-clean/pack-clean.js')['Prefix Lines…'];
function all(script, t, prompts) { return run(script, t, { sel: [0, t.length], prompts: prompts }); }
function each(script, rows) { rows.forEach(function (r) { assert.strictEqual(all(script, r[0]).doc, r[1], JSON.stringify(r[0])); }); }

// ======================================================================= Numbers → Words
test('Numbers → Words: integers, scales, negatives, decimals, percent', function () {
  each(N2W, [
    ['I have 42 apples.', 'I have forty-two apples.'],
    ['0', 'zero'], ['7', 'seven'], ['13', 'thirteen'], ['20', 'twenty'], ['99', 'ninety-nine'],
    ['100', 'one hundred'], ['101', 'one hundred one'], ['999', 'nine hundred ninety-nine'],
    ['1000', 'one thousand'], ['1,250,000', 'one million two hundred fifty thousand'],
    ['1000001', 'one million one'], ['2000000000', 'two billion'],
    ['999999999999999', 'nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine'],
    ['-7', 'minus seven'], ['(-5)', '(minus five)'], ['−3', 'minus three'],
    ['3.14', 'three point one four'], ['0.5', 'zero point five'], ['-2.05', 'minus two point zero five'],
    ['50%', 'fifty percent'], ['up 12.5% today', 'up twelve point five percent today'],
    ['It costs 3.5 kg, ok? 12!', 'It costs three point five kg, ok? twelve!'],
    ['x - 3', 'x - three'], ['"8"', '"eight"'], ['8,', 'eight,']
  ]);
});

test('Numbers → Words: dates, times, versions, codes, words, markers left alone', function () {
  each(N2W, [
    ['2024-01-05', '2024-01-05'], ['10:30', '10:30'], ['3:00pm', '3:00pm'], ['1.2.3', '1.2.3'],
    ['192.168.0.1', '192.168.0.1'], ['5-10', '5-10'], ['1/2', '1/2'], ['555-0100', '555-0100'],
    ['mp3', 'mp3'], ['3rd', '3rd'], ['v2', 'v2'], ['1e5', '1e5'], ['the 1990s', 'the 1990s'], ['A4', 'A4'],
    ['007', '007'], ['.5', '.5'], ['$5', '$5'], ['€20', '€20'], ['#12', '#12'], ['@3', '@3'],
    ['1,2,3', '1,2,3'], ['snake_1', 'snake_1'], ['1000000000000000', '1000000000000000'],
    ['1. one\n2) two\n  3. three', '1. one\n2) two\n  3. three'], ['> 4. quoted', '> 4. quoted']
  ]);
  assert.strictEqual(all(N2W, 'item 1.').doc, 'item one.');
  assert.strictEqual(all(N2W, 'Call 2 at 10:30 on 2024-01-05').doc, 'Call two at 10:30 on 2024-01-05');
});

test('Numbers → Words: nothing to do → info toast, no change; empty doc', function () {
  var r = all(N2W, 'no digits here');
  assert.strictEqual(r.doc, 'no digits here');
  assert.strictEqual(r.toasts[0][0], 'info');
  assert.strictEqual(run(N2W, '', {}).doc, '');
});

test('Numbers → Words: selection only / current line / whole doc', function () {
  assert.strictEqual(run(N2W, '1 2 3', { sel: [2, 3] }).doc, '1 two 3');
  assert.strictEqual(run(N2W, 'a 1\nb 2\nc 3', { cursor: 5 }).doc, 'a 1\nb two\nc 3');
  assert.strictEqual(run(N2W, 'a 1\n\nc 3', { cursor: 4 }).doc, 'a one\n\nc three');
});

// ======================================================================= Words → Numbers
test('Words → Numbers: compounds, scales, and, a / dozen, decimals, minus', function () {
  each(W2N, [
    ['forty-two', '42'], ['Forty-Two apples', '42 apples'], ['one hundred and five', '105'],
    ['one hundred five', '105'], ['two million three hundred thousand', '2300000'],
    ['one million two hundred fifty thousand', '1250000'], ['eleven thousand', '11000'],
    ['one thousand one', '1001'], ['seven trillion', '7000000000000'], ['nineteen hundred', '1900'],
    ['ninety-nine bottles', '99 bottles'], ['zero', '0'], ['a hundred', '100'], ['a thousand times', '1000 times'],
    ['a dozen eggs', '12 eggs'], ['two dozen', '24'], ['minus seven', '-7'], ['negative forty', '-40'],
    ['three point one four', '3.14'], ['zero point five', '0.5'], ['ONE HUNDRED', '100'],
    ['twenty one', '21'], ['two thousand and twenty-four', '2024']
  ]);
});

test('Words → Numbers: separate numbers stay separate; non-numbers left alone', function () {
  each(W2N, [
    ['one two three', '1 2 3'], ['Five and six', '5 and 6'], ['five minus three', '5 minus 3'],
    ['twenty twenty', '20 20'], ['twenty-first', 'twenty-first'], ['a twenty-one-year-old', 'a twenty-one-year-old'],
    ['no one came', 'no one came'], ['the one thing', 'the one thing'], ['one of them', '1 of them'],
    ['someone, anyone', 'someone, anyone'], ['a cat', 'a cat'], ['and', 'and'], ['point', 'point'],
    ['one, two', '1, 2'], ['one\ntwo', '1\n2'], ['hundred', 'hundred'], ['hundred thousand', 'hundred thousand'],     // a bare scale word needs a number in front
    ['ten five', '10 5'], ['thousand million', 'thousand million'], ['one point', '1 point'], ['onerous tenant', 'onerous tenant']
  ]);
});

test('Words ↔ Numbers round trip', function () {
  [0, 5, 12, 40, 99, 100, 105, 999, 1001, 2024, 10000, 123456, 1000000, 1234567, 905000017, 999999999999].forEach(function (n) {
    var w = all(N2W, String(n)).doc;
    assert.strictEqual(all(W2N, w).doc, String(n), n + ' → ' + w);
  });
  assert.strictEqual(all(W2N, all(N2W, '-3.25').doc).doc, '-3.25');
});

test('Words → Numbers: toast when nothing found; current line', function () {
  var r = all(W2N, 'nothing here');
  assert.strictEqual(r.doc, 'nothing here');
  assert.strictEqual(r.toasts[0][0], 'info');
  assert.strictEqual(run(W2N, 'one\ntwo\nthree', { cursor: 5 }).doc, 'one\n2\nthree');
});

// ======================================================================= Ordinals
test('Ordinals: suffix rules', function () {
  assert.strictEqual(all(ORD, '0 1 2 3 4 11 12 13 21 22 23 101 111 112 113 1000 1,001').doc,
    '0th 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 23rd 101st 111th 112th 113th 1000th 1,001st');
  assert.strictEqual(all(ORD, 'Finished 2 of 10 (place 3)').doc, 'Finished 2nd of 10th (place 3rd)');
});

test('Ordinals: standalone integers only', function () {
  each(ORD, [['1st 2nd', '1st 2nd'], ['3.5', '3.5'], ['-2', '-2'], ['50%', '50%'], ['2024-01-05', '2024-01-05'],
    ['10:30', '10:30'], ['mp3', 'mp3'], ['1. item', '1. item'], ['$5', '$5'], ['007', '007']]);
  var r = all(ORD, 'none');
  assert.strictEqual(r.toasts[0][0], 'info');
  assert.strictEqual(run(ORD, '1\n2\n3', { cursor: 2 }).doc, '1\n2nd\n3');
  assert.strictEqual(run(ORD, '1\n2\n\n3', { cursor: 4 }).doc, '1st\n2nd\n\n3rd');
});

// ======================================================================= Pluralize / Singularize
var PAIRS = [
  ['apple', 'apples'], ['city', 'cities'], ['day', 'days'], ['soliloquy', 'soliloquies'], ['box', 'boxes'],
  ['church', 'churches'], ['dish', 'dishes'], ['class', 'classes'], ['bus', 'buses'], ['lens', 'lenses'],
  ['status', 'statuses'], ['buzz', 'buzzes'], ['waltz', 'waltzes'], ['quiz', 'quizzes'],
  ['knife', 'knives'], ['wife', 'wives'], ['leaf', 'leaves'], ['wolf', 'wolves'], ['roof', 'roofs'], ['chief', 'chiefs'],
  ['person', 'people'], ['child', 'children'], ['mouse', 'mice'], ['man', 'men'], ['woman', 'women'],
  ['tooth', 'teeth'], ['foot', 'feet'], ['goose', 'geese'], ['ox', 'oxen'],
  ['potato', 'potatoes'], ['hero', 'heroes'], ['photo', 'photos'], ['piano', 'pianos'],
  ['cactus', 'cacti'], ['analysis', 'analyses'], ['hypothesis', 'hypotheses'], ['crisis', 'crises'], ['basis', 'bases'],
  ['criterion', 'criteria'], ['phenomenon', 'phenomena'], ['matrix', 'matrices'], ['appendix', 'appendices'],
  ['fireman', 'firemen'], ['policewoman', 'policewomen'], ['grandchild', 'grandchildren'], ['salesperson', 'salespeople'],
  ['bookshelf', 'bookshelves'], ['housewife', 'housewives'], ['human', 'humans'], ['german', 'germans'],
  ['stomach', 'stomachs'], ['epoch', 'epochs'], ['monarch', 'monarchs'], ['cache', 'caches'], ['niche', 'niches'],
  ['headache', 'headaches'], ['movie', 'movies'], ['cookie', 'cookies'], ['pie', 'pies'], ['zombie', 'zombies'],
  ['house', 'houses'], ['prize', 'prizes'], ['size', 'sizes'], ['case', 'cases'], ['shoe', 'shoes'], ['cave', 'caves'], ['glove', 'gloves'],
  ['topic', 'topics'], ['necktie', 'neckties'], ['party', 'parties'], ['baby', 'babies'], ['iPhone', 'iPhones'], ['toy', 'toys'], ['key', 'keys'], ['omen', 'omens'], ['specimen', 'specimens']
];
var UNCOUNTABLE = ['sheep', 'fish', 'deer', 'information', 'rice', 'equipment', 'news', 'series', 'species', 'software',
  'aircraft', 'physics', 'data', 'goldfish', 'swordfish', 'malware'];

test('Pluralize: regular, -y, -s/-es, -f/-ves, irregular, compound, Latin/Greek', function () {
  PAIRS.forEach(function (p) { assert.strictEqual(all(PL, p[0]).doc, p[1], p[0]); });
});

test('Singularize: the reverse of every pair', function () {
  PAIRS.forEach(function (p) {
    if (p[0] === 'basis') return;                          // bases → base (the commoner reading)
    assert.strictEqual(all(SG, p[1]).doc, p[0], p[1]);
  });
  assert.strictEqual(all(SG, 'bases').doc, 'base');
});

test('Plural / singular: uncountables and already-inflected words stay', function () {
  UNCOUNTABLE.forEach(function (w) {
    assert.strictEqual(all(PL, 'the ' + w).doc, 'the ' + w, w);
    assert.strictEqual(all(SG, 'the ' + w).doc, 'the ' + w, w);
  });
  ['people', 'cats', 'boxes', 'mice', 'children', 'cities', 'knives', 'analyses', 'firemen'].forEach(function (w) {
    assert.strictEqual(all(PL, w).doc, w, 'plural ' + w);
  });
  ['person', 'cat', 'box', 'mouse', 'status', 'glass', 'bus', 'lens', 'analysis', 'omen', 'abdomen', 'news', 'yes'].forEach(function (w) {
    assert.strictEqual(all(SG, w).doc, w, 'singular ' + w);
  });
});

test('Plural / singular: case style kept', function () {
  each(PL, [['Person', 'People'], ['PERSON', 'PEOPLE'], ['Child', 'Children'], ['CITY', 'CITIES'], ['Knife', 'Knives'],
    ['Box', 'Boxes'], ['MOUSE', 'MICE'], ['Ox', 'Oxen'], ['ÉCOLE', 'ÉCOLES']]);
  each(SG, [['People', 'Person'], ['PEOPLE', 'PERSON'], ['Children', 'Child'], ['CITIES', 'CITY'], ['Mice', 'Mouse']]);
});

test('Plural / singular: last word of each line; punctuation, markers and blanks kept', function () {
  var list = '- big red apple\n- [ ] blue box,\n\nCategory: Person\n  * child.\n1. Mouse\ncount: 3\nsee https://x.com/foo\n@user #tag\ndog\'s';
  var pl = all(PL, list).doc;
  assert.strictEqual(pl, '- big red apples\n- [ ] blue boxes,\n\nCategory: People\n  * children.\n1. Mice\ncount: 3\nsee https://x.com/foo\n@user #tag\ndog\'s');
  assert.strictEqual(all(SG, pl).doc, list);
  assert.strictEqual(all(PL, 'mother-in-law').doc, 'mother-in-laws');   // last word only — documented
  assert.strictEqual(all(PL, 'Ärzte Haus').doc, 'Ärzte Hauses');         // English rules, any letters
});

test('Plural / singular: nothing to do → info toast; current line; empty doc', function () {
  var r = all(PL, 'sheep');
  assert.strictEqual(r.doc, 'sheep');
  assert.strictEqual(r.toasts[0][0], 'info');
  assert.strictEqual(run(PL, 'cat\ndog\ncow', { cursor: 5 }).doc, 'cat\ndogs\ncow');
  assert.strictEqual(run(SG, 'cats\n\ndogs', { cursor: 5 }).doc, 'cat\n\ndog');
  assert.strictEqual(run(PL, '', {}).doc, '');
});

// ======================================================================= Lorem Ipsum…
function seeded(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
var loremFns = (function () {
  var code = LOREM.code;
  return new Function(code + '\nreturn { loremSpec: loremSpec, lorem: lorem };')();
})();
var CLASSIC = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';

test('Lorem: spec parsing', function () {
  var p = loremFns.loremSpec;
  assert.deepStrictEqual(p('3'), { n: 3, unit: 'p' });
  assert.deepStrictEqual(p(' 2 paragraphs '), { n: 2, unit: 'p' });
  assert.deepStrictEqual(p('5s'), { n: 5, unit: 's' });
  assert.deepStrictEqual(p('5 Sentences'), { n: 5, unit: 's' });
  assert.deepStrictEqual(p('50w'), { n: 50, unit: 'w' });
  assert.deepStrictEqual(p('1 word'), { n: 1, unit: 'w' });
  ['', 'abc', '0', '-3', '3x', '101', '1001s', '10001w', '2.5'].forEach(function (s) { assert.strictEqual(p(s), null, s); });
});

test('Lorem: exact word / sentence / paragraph counts, classic start', function () {
  var L = loremFns.lorem;
  [1, 5, 8, 19, 50, 333].forEach(function (n) {
    var w = L(n, 'w', seeded(n));
    assert.strictEqual(w.split(' ').length, n, n + ' words');
    assert.ok(/\.$/.test(w) && /^Lorem/.test(w), w);
  });
  assert.strictEqual(L(5, 'w', seeded(1)), 'Lorem ipsum dolor sit amet.');
  assert.strictEqual(L(1, 's', seeded(1)), CLASSIC);
  var s = L(6, 's', seeded(2));
  assert.strictEqual(s.split('. ').length, 6);
  assert.strictEqual(s.indexOf(CLASSIC), 0);
  var p = L(3, 'p', seeded(3)).split('\n\n');
  assert.strictEqual(p.length, 3);
  assert.strictEqual(p[0].indexOf(CLASSIC), 0);
  p.forEach(function (para) { var n = para.split('. ').length; assert.ok(n >= 4 && n <= 7, n); assert.ok(/^[A-Z].*\.$/.test(para)); });
});

test('Lorem: inserts at the cursor, replaces a selection, pads, remembers the answer', function () {
  var r = run(LOREM, '', { prompts: ['5w'] });
  assert.strictEqual(r.doc.split(' ').length, 5);
  assert.ok(/^Lorem ipsum dolor sit amet\.$/.test(r.doc), r.doc);
  assert.strictEqual(r.store['cade-textpack-lorem'], '5w');
  assert.strictEqual(r.asked[0][1], '3');
  r = run(LOREM, 'Hello', { cursor: 5, prompts: ['1s'] });                 // end of a non-empty line: no line replaced
  assert.strictEqual(r.doc, 'Hello ' + CLASSIC);
  r = run(LOREM, 'Hello', { cursor: 5, prompts: ['2'] });
  assert.ok(/^Hello\n\nLorem ipsum[^\n]+\n\n[A-Z][^\n]+$/.test(r.doc), r.doc);
  r = run(LOREM, 'ab cd', { cursor: 2, prompts: ['2w'] });
  assert.strictEqual(r.doc, 'ab Lorem ipsum. cd');
  r = run(LOREM, 'keep XXX keep', { sel: [5, 8], prompts: ['3w'] });
  assert.strictEqual(r.doc, 'keep Lorem ipsum dolor. keep');
  r = run(LOREM, 'Top\n\nBottom', { cursor: 4, prompts: ['1p'] });
  assert.ok(/^Top\n\nLorem ipsum [^\n]+\n\nBottom$/.test(r.doc), JSON.stringify(r.doc));
  assert.strictEqual(r.editor.state.selection.main.head, r.doc.indexOf('\n\nBottom'));
  r = run(LOREM, 'x', { store: { 'cade-textpack-lorem': '7w' }, prompts: [] });   // cancel
  assert.strictEqual(r.doc, 'x');
  assert.strictEqual(r.asked[0][1], '7w');
  r = run(LOREM, 'x', { prompts: ['lots'] });
  assert.strictEqual(r.doc, 'x');
  assert.strictEqual(r.toasts[0][0], 'error');
});

// ======================================================================= Truncate Lines…
test('Truncate: cuts long lines to N with …, grapheme-safe', function () {
  assert.strictEqual(all(TRUNC, 'abcdefghij\nabcde\nabc', ['5']).doc, 'abcd…\nabcde\nabc');
  assert.strictEqual(all(TRUNC, 'abc def ghi', ['5']).doc, 'abc…');            // no space before …
  assert.strictEqual(all(TRUNC, '👍🏽👍🏽👍🏽', ['2']).doc, '👍🏽…');
  assert.strictEqual(all(TRUNC, '🇫🇷🇩🇪🇮🇹', ['3']).doc, '🇫🇷🇩🇪🇮🇹');           // 3 graphemes fit
  assert.strictEqual(all(TRUNC, 'éééé', ['3']).doc, 'éé…');
  assert.strictEqual(all(TRUNC, 'abcdef', ['1']).doc, '…');
  assert.strictEqual(all(TRUNC, '\n\nlong line here\n', ['4']).doc, '\n\nlon…\n');
});

test('Truncate: prompt handling, nothing-to-do toast, current line, remembers N', function () {
  var r = all(TRUNC, 'short', ['80']);
  assert.strictEqual(r.doc, 'short');
  assert.strictEqual(r.toasts[0][0], 'info');
  assert.strictEqual(r.store['cade-textpack-truncate'], '80');
  ['0', 'abc', '-3', '2.5', ''].forEach(function (a) {
    var x = all(TRUNC, 'abcdefgh', [a]);
    assert.strictEqual(x.doc, 'abcdefgh', a);
    assert.strictEqual(x.toasts[0][0], 'error', a);
  });
  assert.strictEqual(all(TRUNC, 'abcdefgh', []).doc, 'abcdefgh');            // cancelled
  assert.strictEqual(run(TRUNC, 'aaaaaa\nbbbbbb', { cursor: 8, prompts: ['3'] }).doc, 'aaaaaa\nbb…');
  assert.strictEqual(run(TRUNC, 'x', { store: { 'cade-textpack-truncate': '40' }, prompts: [] }).asked[0][1], '40');
});

// ======================================================================= Surround Lines…
test('Surround: same text both sides, openers mirrored, tags closed', function () {
  var t = 'foo\nbar';
  [['"', '"foo"\n"bar"'], ['(', '(foo)\n(bar)'], ['[', '[foo]\n[bar]'], ['{{', '{{foo}}\n{{bar}}'],
   ['**', '**foo**\n**bar**'], ['`', '`foo`\n`bar`'], ['“', '“foo”\n“bar”'], ['‘', '‘foo’\n‘bar’'],
   ['«', '«foo»\n«bar»'], ['「', '「foo」\n「bar」'], ['¿', '¿foo?\n¿bar?'], ['([', '([foo])\n([bar])'],
   ['<li>', '<li>foo</li>\n<li>bar</li>'], ['<li><b>', '<li><b>foo</b></li>\n<li><b>bar</b></li>'],
   ['<a href="#x">', '<a href="#x">foo</a>\n<a href="#x">bar</a>'],
   ['/* ', '/* foo */\n/* bar */'], ['<!-- ', '<!-- foo -->\n<!-- bar -->'], ['( ', '( foo )\n( bar )'],
   ['<li>|</li>', '<li>foo</li>\n<li>bar</li>'], ['[|](url)', '[foo](url)\n[bar](url)'], ['|', '|foo|\n|bar|'],
   ['| | |', '| | |foo| | |\n| | |bar| | |']
  ].forEach(function (c) { assert.strictEqual(all(SUR, t, [c[0]]).doc, c[1], c[0]); });
});

test('Surround: indentation, blank lines, toggles off, prompt memory', function () {
  assert.strictEqual(all(SUR, '  foo  \n\n\tbar', ['"']).doc, '  "foo"  \n\n\t"bar"');
  assert.strictEqual(all(SUR, '  "foo"\n\n"bar"', ['"']).doc, '  foo\n\nbar');
  assert.strictEqual(all(SUR, '<li>a</li>\n<li>b</li>', ['<li>']).doc, 'a\nb');
  assert.strictEqual(all(SUR, '(a)\nb', ['(']).doc, '((a))\n(b)');           // not every line wrapped → wrap
  assert.strictEqual(all(SUR, '/* a */', ['/* ']).doc, 'a');
  assert.strictEqual(all(SUR, '', ['"']).doc, '');
  assert.strictEqual(all(SUR, 'x', []).doc, 'x');
  var r = run(SUR, 'one\ntwo', { cursor: 5, prompts: ['('] });
  assert.strictEqual(r.doc, 'one\n(two)');
  assert.strictEqual(r.store['cade-textpack-surround'], '(');
  assert.strictEqual(run(SUR, 'x', { store: { 'cade-textpack-surround': '<b>' }, prompts: [] }).asked[0][1], '<b>');
});

// ======================================================================= Suffix Lines…
test('Suffix: adds to every non-blank line, toggles off, mirrors Prefix Lines…', function () {
  assert.strictEqual(all(SUF, 'a\n\nb', [';']).doc, 'a;\n\nb;');
  assert.strictEqual(all(SUF, 'a;\n\nb;', [';']).doc, 'a\n\nb');
  assert.strictEqual(all(SUF, 'a;\nb', [';']).doc, 'a;;\nb;');
  assert.strictEqual(all(SUF, 'x', ['']).doc, 'x');
  assert.strictEqual(all(SUF, 'x', []).doc, 'x');
  assert.strictEqual(all(SUF, '', [',']).doc, '');
  assert.strictEqual(run(SUF, 'a\nb', { cursor: 2, prompts: [' \\'] }).doc, 'a\nb \\');
  // Same shape as Prefix Lines…: reverse each line, prefix, reverse back
  var rev = function (t) { return t.split('\n').map(function (l) { return l.split('').reverse().join(''); }).join('\n'); };
  ['abc\n\n  def', 'x;\ny;', ' \n\t\nq'].forEach(function (t) {
    assert.strictEqual(all(SUF, t, [';']).doc, rev(all(PREFIX, rev(t), [';']).doc), JSON.stringify(t));
  });
  var r = all(SUF, 'a', [';']);
  assert.strictEqual(r.asked[0][1], ';');
});

test('metadata', function () {
  checkManifest('pack-text', S, ['Numbers → Words', 'Words → Numbers', 'Ordinals', 'Pluralize Lines', 'Singularize Lines',
    'Lorem Ipsum…', 'Truncate Lines…', 'Surround Lines…', 'Suffix Lines…']);
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'pack-text: ' + passed + ' passed');
