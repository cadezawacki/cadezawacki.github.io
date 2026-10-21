/* Checks for Bold-start reading: bold split lengths per strength, what is
 * skipped, the prefs schema and the plugin registration (default off).
 * Not loaded by the app. Run: node txt/widgets/boldread/boldread.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var L = require('./boldread.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
// "[Bo]ld [te]xt" rendering of a line.
function show(t, s) {
  var o = '', i = 0;
  L.lineBold(t, s || 'medium').forEach(function (r) { o += t.slice(i, r[0]) + '[' + t.slice(r[0], r[1]) + ']'; i = r[1]; });
  return o + t.slice(i);
}

// The manifest entry proposed for this plugin (switch to reading txt/manifest.json once it's there).
var ENTRY = {
  id: 'boldread', type: 'plugin', name: 'Bold-start reading',
  description: 'Bolds the first letters of each word so your eye can skim faster — purely visual, the text is unchanged. Skips code, links, headings and the line you are editing; strength in Widget preferences',
  entry: 'widgets/boldread/boldread.js', css: 'widgets/boldread/boldread.css',
  settingKey: 'plugins.boldread', section: 'Editor', default: false,
  prefs: { title: 'Bold-start reading', fields: [
    { key: 'strength', type: 'radio', label: 'Fixation strength', default: 'medium',
      hint: 'How much of the start of each word is bold: light about a third, medium about half, strong about two thirds',
      options: [{ value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }] },
    { key: 'skipCaret', type: 'toggle', label: 'Leave the line I’m editing plain', default: true,
      hint: 'While you type, the caret’s line shows no bold, so the text you are changing stays still' }
  ] }
};

test('bold length per strength and word length', function () {
  var want = { // len: [light, medium, strong]
    1: [1, 1, 1], 2: [1, 1, 1], 3: [1, 1, 2], 4: [1, 2, 2], 5: [2, 2, 3], 6: [2, 3, 4],
    8: [2, 4, 5], 10: [3, 5, 6], 12: [4, 5, 7], 20: [6, 9, 12]
  };
  for (var n in want) {
    assert.deepStrictEqual(['light', 'medium', 'strong'].map(function (s) { return L.boldLen(+n, s); }), want[n], 'len ' + n);
  }
  assert.strictEqual(L.boldLen(0, 'medium'), 0);
  assert.strictEqual(L.boldLen(6, 'bogus'), L.boldLen(6, 'medium'), 'unknown strength = medium');
  for (var len = 2; len < 40; len++) ['light', 'medium', 'strong'].forEach(function (s) {
    var k = L.boldLen(len, s);
    assert.ok(k >= 1 && k < len, 'never the whole word: ' + len + ' ' + s);
  });
  for (len = 2; len < 40; len++) assert.ok(L.boldLen(len, 'light') <= L.boldLen(len, 'medium') && L.boldLen(len, 'medium') <= L.boldLen(len, 'strong'));
});
test('words: letters only, apostrophes inside, quotes trimmed, accents and marks', function () {
  assert.strictEqual(show('The quick brown fox, don\'t you think?'), '[T]he [qu]ick [br]own [f]ox, [do]n\'t [y]ou [th]ink?');
  assert.strictEqual(show('\'quoted\' l’eau', 'strong'), '\'[quot]ed\' [l’e]au');
  assert.strictEqual(show('café naïve', 'light'), '[c]afé [na]ïve');
  assert.strictEqual(show('été word'), '[é]té [wo]rd', 'combining mark stays with its letter');
  assert.strictEqual(show('a I'), '[a] [I]');
});
test('skips: inline code, URLs, link targets, file / image tokens, HTML, sentinels, footnotes, identifiers, CJK', function () {
  assert.strictEqual(show('see `code here` and ``more `x` code`` ok'), '[s]ee `code here` [a]nd ``more `x` code`` [o]k');
  assert.strictEqual(show('go https://example.com/some/path now www.x.org mailto:a@b.co'), '[g]o https://example.com/some/path [n]ow www.x.org mailto:a@b.co');
  assert.strictEqual(show('[link text](https://y.z/page) and [rel](./notes/file)'), '[[li]nk [te]xt](https://y.z/page) [a]nd [[r]el](./notes/file)');
  assert.strictEqual(show('![file:report.pdf#abc|s12] after ![img:pic#x] ![alt text](pic.png) end'), '![file:report.pdf#abc|s12] [af]ter ![img:pic#x] ![alt text](pic.png) [e]nd');
  assert.strictEqual(show('mail me@example.com <span class="x">inner</span>'), '[ma]il me@example.com <span class="x">[in]ner</span>');
  assert.strictEqual(show('%%center%%Title ==red|marked== %%big|large%%'), '%%center%%[Ti]tle ==red|[mar]ked== %%big|[la]rge%%');
  assert.strictEqual(show('note[^12] snake_case v2 3rd 日本語 word'), '[no]te[^12] snake_case v2 3rd 日本語 [wo]rd');
});
test('skipped lines: headings, table separators, markers, huge lines', function () {
  assert.deepStrictEqual(L.lineBold('# Heading words', 'medium'), []);
  assert.deepStrictEqual(L.lineBold('###### Deep heading', 'medium'), []);
  assert.notDeepStrictEqual(L.lineBold('#hashtag words', 'medium'), [], 'a hashtag is not a heading');
  assert.deepStrictEqual(L.lineBold('|---|:--:|', 'medium'), []);
  assert.deepStrictEqual(L.lineBold('[table]', 'medium'), []);
  assert.deepStrictEqual(L.lineBold('word '.repeat(700), 'medium'), []);
  assert.deepStrictEqual(L.lineBold('', 'medium'), []);
  assert.strictEqual(show('| cell one | two |'), '| [ce]ll [o]ne | [t]wo |', 'table rows are read');
});
test('ranges are sorted, inside the line and non-overlapping', function () {
  var t = 'Mixed **bold** text, `code`, [a link](http://x.y) and more words to check here.';
  var r = L.lineBold(t, 'strong');
  for (var i = 0; i < r.length; i++) {
    assert.ok(r[i][0] >= 0 && r[i][1] <= t.length && r[i][1] > r[i][0]);
    if (i) assert.ok(r[i][0] >= r[i - 1][1]);
  }
});

test('prefs schema equals the manifest "prefs"; plugin metadata (off by default)', function () {
  assert.deepStrictEqual(L.FIELDS, ENTRY.prefs.fields);
  assert.strictEqual(L.META.id, ENTRY.id);
  assert.strictEqual(L.META.settingKey, ENTRY.settingKey);
  assert.strictEqual(ENTRY.default, false);
  assert.strictEqual(ENTRY.type, 'plugin');
  ENTRY.prefs.fields.forEach(function (f) { if (f.type === 'radio') assert.ok(f.options.some(function (o) { return o.value === f.default; })); });
  Object.keys(L.STRENGTH).forEach(function (k) { assert.ok(ENTRY.prefs.fields[0].options.some(function (o) { return o.value === k; }), k); });
});
test('prefs schema is valid for the core prefs store', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'txt.html'), 'utf8');
  var a = html.indexOf('// <prefs-core>'), b = html.indexOf('// </prefs-core>');
  if (a < 0 || b < 0) return;
  var PC = new Function(html.slice(a, b) + '\nreturn PrefsCore;')();
  ENTRY.prefs.fields.forEach(function (f) { var n = PC.normField(f); assert.ok(n, f.key); assert.deepStrictEqual(n.default, f.default, f.key); });
});
test('registers one editor plugin under its id (a ViewPlugin, so turning it off removes it)', function () {
  var plug = null, css = [];
  var fake = { Cade: {
    loadCSS: function (c) { css.push(c); }, registerPlugin: function (o) { plug = o; },
    CM: { ViewPlugin: { fromClass: function (c, spec) { return { __vp: c, spec: spec }; } }, Decoration: { mark: function (o) { return o; }, none: [] },
      StateEffect: { define: function () { return {}; } } }
  } };
  new Function('window', 'module', fs.readFileSync(path.join(__dirname, 'boldread.js'), 'utf8'))(fake, undefined);
  assert.ok(plug, 'registered');
  assert.strictEqual(plug.id, ENTRY.id);
  assert.ok(plug.ext && plug.ext.__vp && typeof plug.ext.__vp.prototype.destroy === 'function', 'ViewPlugin with destroy');
  assert.deepStrictEqual(css, ['boldread.css']);
  ['boldread.js', 'boldread.css'].forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, f)), f); });
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'boldread: ' + passed + ' passed');
