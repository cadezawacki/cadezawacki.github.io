/* Checks for Word Echoes (echoes-core.js): tokenising, normalising and
 * stemming, the stopword list, the distance → severity formula and its
 * ordering, marks on planted repeats (and none in code / on stopwords), the
 * whole-note index, the caret-word lookup, the per-paragraph cache and speed,
 * plus the widget's registration metadata and its preferences schema.
 * Not loaded by the app. Run: node txt/widgets/echoes/echoes.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./echoes-core.js');
var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function marks(text, opts) { return C.analyze(text, opts).map(function (m) { m.text = text.slice(m.from, m.to); return m; }); }
function of(ms, w) { return ms.filter(function (m) { return m.text.toLowerCase() === w; }); }

// The manifest entry to add (the test switches to reading txt/manifest.json once it's there).
var MANIFEST = {
  id: 'echoes',
  type: 'widget',
  name: 'Word Echoes',
  description: 'Highlights only the words you repeat — the closer the repeat, the stronger the tint; tap a word to see every echo',
  icon: '🔁',
  tags: 'writing,prose,repetition,repeated words,echo,echoes,word choice,style,proofread,lint,highlight',
  entry: 'widgets/echoes/echoes.js',
  css: 'widgets/echoes/echoes.css',
  precache: ['widgets/echoes/echoes-core.js', 'widgets/ekg/ekg-core.js'],
  prefs: {
    title: 'Word Echoes',
    fields: [
      { key: 'taper', type: 'slider', label: 'Fade out after', default: 5, min: 2, max: 10, step: 1, unit: 'sentences', hint: 'How far apart two uses of a word can be and still be marked. Nearer repeats are always stronger.' },
      { key: 'stem', type: 'toggle', label: 'Match word forms', default: true, hint: 'run / runs / running and idea / ideas count as the same word' },
      { key: 'minLen', type: 'number', label: 'Shortest word to check', default: 3, min: 2, max: 8, step: 1, unit: 'letters' },
      { key: 'ignore', type: 'text', label: 'Also ignore these words', default: '', placeholder: 'e.g. said, Anna, river', hint: 'Comma-separated. Common words (the, a, than, with…) are always ignored.' },
      { key: 'style', type: 'radio', label: 'Highlight style', default: 'tint', options: [{ value: 'tint', label: 'Tint' }, { value: 'underline', label: 'Underline' }] }
    ]
  }
};
function entry() {
  try {
    var m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (x) { return x.id === 'echoes'; })[0];
    if (m) return m;
  } catch (e) {}
  return MANIFEST;
}
function loadWidget() {
  var reg = null, css = [], win = {};
  win.Cade = { loadCSS: function (p) { css.push(p); }, registerWidget: function (o) { reg = o; }, baseURL: function () { return './txt/widgets/echoes/'; }, escapeHtml: String };
  new Function('window', 'module', fs.readFileSync(path.join(__dirname, 'echoes.js'), 'utf8'))(win, undefined);
  return { reg: reg, css: css, prefs: win.__cadeEchoesPrefs };
}

// ---- metadata -------------------------------------------------------------------------
test('registers under the manifest entry', function () {
  var e = entry(), w = loadWidget();
  assert.strictEqual(e.entry, 'widgets/echoes/echoes.js');
  assert.strictEqual(e.css, 'widgets/echoes/echoes.css');
  assert.ok(w.reg, 'registered');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(w.reg[k], e[k], k); });
  assert.strictEqual(typeof w.reg.open, 'function');
  assert.deepStrictEqual(w.css, ['echoes.css']);
  (e.precache || []).forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f); });
});
test('preferences schema equals the manifest "prefs" and the core defaults', function () {
  var e = entry(), s = loadWidget().prefs;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), e.prefs);
  var types = ['text', 'textarea', 'number', 'slider', 'toggle', 'checkbox', 'radio', 'select', 'date', 'time', 'color', 'heading'];
  s.fields.forEach(function (f) {
    assert.ok(types.indexOf(f.type) >= 0, f.type);
    assert.ok(f.label, 'label');
    if (f.key) assert.deepStrictEqual(f.default, C.DEFAULTS[f.key], f.key + ' default matches the core');
    if (f.type === 'slider' || f.type === 'number') assert.ok(f.default >= f.min && f.default <= f.max);
    if (f.type === 'radio') assert.ok(f.options.some(function (o) { return o.value === f.default; }));
  });
  assert.deepStrictEqual(Object.keys(C.DEFAULTS).sort(), s.fields.map(function (f) { return f.key; }).sort());
});

// ---- tokenising / normalising ------------------------------------------------------------
test('tokenize gives every word with source offsets and sentence index', function () {
  var t = 'The river’s edge. Rivers run; 42 ducks don’t care.';
  var w = C.tokenize(t);
  w.forEach(function (x) { assert.strictEqual(t.slice(x.from, x.to), x.word); });
  assert.deepStrictEqual(w.map(function (x) { return x.word; }), ['The', 'river’s', 'edge', 'Rivers', 'run', '42', 'ducks', 'don’t', 'care']);
  assert.deepStrictEqual(w.map(function (x) { return x.sent; }), [0, 0, 0, 1, 1, 1, 1, 1, 1]);
  var k = {}; w.forEach(function (x) { k[x.word] = x.key; });
  assert.strictEqual(k['The'], '');
  assert.strictEqual(k['river’s'], 'river');          // possessive dropped
  assert.strictEqual(k['Rivers'], 'river');           // case + plural
  assert.strictEqual(k['42'], '');                    // numbers never
  assert.strictEqual(k['don’t'], '');                 // contractions never
  assert.strictEqual(k['ducks'], 'duck');
});
test('normalize: case, punctuation, possessives, digits, min length', function () {
  assert.strictEqual(C.normalize('river'), 'river');
  assert.strictEqual(C.normalize("james'"), 'jame');      // (stemmed) — the possessive goes
  assert.strictEqual(C.normalize("anna's", { stem: false }), 'anna');
  assert.strictEqual(C.normalize('b2b'), '');
  assert.strictEqual(C.normalize('1999'), '');
  assert.strictEqual(C.normalize('ox'), '');                // shorter than 3
  assert.strictEqual(C.normalize('ox', { minLen: 2 }), 'ox');
  assert.strictEqual(C.normalize('cat', { minLen: 4 }), '');
  assert.strictEqual(C.normalize('well-known'), 'well-known');
  assert.strictEqual(C.normalize('café'), 'café');
});
test('stemming joins word forms (and can be switched off)', function () {
  var groups = [['run', 'runs', 'running'], ['idea', 'ideas'], ['hope', 'hoped', 'hopes', 'hoping'], ['walk', 'walks', 'walked', 'walking'],
    ['study', 'studies', 'studied', 'studying'], ['box', 'boxes'], ['class', 'classes'], ['river', 'rivers'], ['agree', 'agreed'], ['story', 'stories'], ['morning', 'mornings']];
  groups.forEach(function (g) {
    var k = g.map(function (w) { return C.normalize(w); });
    k.forEach(function (x) { assert.strictEqual(x, k[0], g.join('/') + ' → ' + k.join('/')); });
  });
  // not over-eager
  ['care', 'car', 'hop', 'hope', 'string', 'thing', 'status', 'bus'].forEach(function (w, i, a) {
    if (i % 2) assert.notStrictEqual(C.normalize(a[i - 1]), C.normalize(w), a[i - 1] + ' vs ' + w);
  });
  assert.strictEqual(C.normalize('status'), 'status');
  assert.notStrictEqual(C.normalize('runs', { stem: false }), C.normalize('run', { stem: false }));
  var t = 'The idea was simple. The ideas were not.';
  assert.strictEqual(of(marks(t), 'ideas').length, 1);
  assert.strictEqual(of(marks(t, { stem: false }), 'ideas').length, 0);
});
test('stopword list: the common words, ~150–300 of them (inflections included)', function () {
  var n = Object.keys(C.STOPWORDS).length;
  assert.ok(n >= 150 && n <= 300, n);
  ('the a an than then and or but of to in on at for with is are was were be it its this that i you he she we they my your not no so as if ' +
   'do have has had from by into about there their them what which who when where very just also more most some any all each other such only own same').split(' ')
    .forEach(function (w) { assert.ok(C.isStopword(w), w); assert.strictEqual(C.normalize(w), '', w); });
  ['river', 'idea', 'lantern', 'house'].forEach(function (w) { assert.ok(!C.isStopword(w), w); });
  // inflected stopwords stay out too ("having" → have, "things" → thing)
  ['having', 'things', 'getting', 'doing'].forEach(function (w) { assert.strictEqual(C.normalize(w), '', w); });
});
test('stopwords and short words are never flagged, however close', function () {
  var t = 'The cat and the dog and the bird. It is what it is, and that is that. Than then than then. I am, you are, we were, they had had.';
  var ms = marks(t);
  var bad = ms.filter(function (m) { return C.isStopword(m.text) || m.text.length < 3; });
  assert.deepStrictEqual(bad.map(function (m) { return m.text; }), []);
});
test('extra ignore words (any case, all forms)', function () {
  var t = 'Anna said hello. Anna said goodbye. The rivers met the river.';
  var ms = marks(t, { ignore: ' anna, Said ,river' });
  assert.deepStrictEqual(ms.map(function (m) { return m.text; }), []);
  assert.ok(of(marks(t), 'anna').length === 2);
});

// ---- severity ---------------------------------------------------------------------------
test('same sentence is more severe than an equal word gap across sentences', function () {
  [1, 3, 8, 15, 30].forEach(function (g) {
    assert.ok(C.severity(g, 0) > C.severity(g, 1), 'gap ' + g);
    assert.ok(C.severity(g, 1) > C.severity(g, 2), 'gap ' + g);
  });
});
test('nearer is more severe than farther', function () {
  for (var g = 1; g < 60; g++) assert.ok(C.severity(g, 1) >= C.severity(g + 1, 1));
  assert.ok(C.severity(2, 0) > C.severity(20, 0));
  assert.ok(C.severity(10, 1) > C.severity(30, 2));
  assert.ok(C.severity(1, 0) > 0.95);
});
test('tapers to ~0 by 5 sentences (and to 0 past it / past the word cap)', function () {
  assert.ok(C.severity(60, 4) < 0.12, C.severity(60, 4));         // four ordinary sentences on
  assert.strictEqual(C.severity(75, 5), 0);                        // five ordinary sentences on
  assert.ok(C.severity(25, 5) < 0.2, C.severity(25, 5));           // five very short ones: barely there
  assert.strictEqual(C.severity(10, 6), 0);                        // past the taper
  assert.strictEqual(C.severity(121, 0), 0);                       // past the word cap
  assert.ok(C.severity(15, 3, { taper: 8 }) > C.severity(15, 3));  // a longer taper reaches further
  assert.strictEqual(C.severity(30, 3, { taper: 2 }), 0);
  assert.strictEqual(C.level(0.01), 0);
  assert.strictEqual(C.level(1), C.LEVELS);
  assert.ok(C.level(0.5) > C.level(0.2));
});

// ---- marks on planted repeats -----------------------------------------------------------------
var SAMPLE = '# Notes on the river\n\n' +
  'The river was wide and the river was slow. We walked along the bank for an hour and talked about nothing. Later the boats came. ' +
  'A heron stood still. The water shone. Far downstream, near the bridge, someone shouted about the river.\n\n' +
  'Ideas came easily that morning. One idea was to build a raft. The raft would be small and green.\n\n' +
  '```\nriver river river inside code\n```\n\n' +
  'Use `lantern` and `lantern` here, see https://example.com/lantern/lantern too. The candle burned; a #candle tag.';
test('planted repeats get the expected relative strengths', function () {
  var ms = marks(SAMPLE), r = of(ms, 'river');
  assert.strictEqual(r.length, 3, 'heading and code are not counted');
  assert.ok(r[0].same && r[1].same && r[0].level >= 5, JSON.stringify(r));
  assert.ok(r[2].level <= 2 && !r[2].same, 'the far river is faint');
  assert.ok(r[2].sev < r[1].sev);
  var raft = of(ms, 'raft'), idea = of(ms, 'ideas').concat(of(ms, 'idea'));
  assert.strictEqual(raft.length, 2); assert.strictEqual(idea.length, 2);
  assert.ok(!raft[0].same && raft[0].sentGap === 1 && raft[0].level < r[0].level);
  assert.strictEqual(raft[0].dir, 1); assert.strictEqual(raft[1].dir, -1);
  assert.strictEqual(raft[0].wordGap, 2);                     // raft · The · raft
  ms.forEach(function (m) { assert.ok(m.level >= 1 && m.level <= C.LEVELS); assert.ok(!C.isStopword(m.text), m.text); });
});
test('inline code, URLs and #tags are not words; the candle in prose is', function () {
  var ms = marks(SAMPLE);
  assert.strictEqual(of(ms, 'lantern').length, 0);
  assert.strictEqual(of(ms, 'candle').length, 0);    // the other "candle" is a #tag
  var t = 'The candle burned low. The candle went out.';
  assert.strictEqual(of(marks(t), 'candle').length, 2);
});
test('index: counts, positions, score order, caret word lookup', function () {
  var e = new C.Engine(), ix = e.index(SAMPLE);
  var river = ix.keys.get('river');
  assert.strictEqual(river.n, 3);
  river.pos.forEach(function (p, i) { assert.strictEqual(SAMPLE.slice(p, p + river.len[i]).toLowerCase(), 'river'); });
  var top = ix.top(5).map(function (x) { return x.word; });
  assert.strictEqual(top[0], 'river');
  assert.ok(top.indexOf('raft') > 0);
  assert.ok(ix.keys.get('heron').n === 1 && top.indexOf('heron') < 0);
  var p = SAMPLE.indexOf('raft');
  assert.strictEqual(e.wordAt(SAMPLE, null, p).key, 'raft');
  assert.strictEqual(e.wordAt(SAMPLE, null, p + 4).key, 'raft');                  // caret just after the word
  assert.strictEqual(e.wordAt(SAMPLE, null, p, p + 4).key, 'raft');              // exactly selected
  assert.strictEqual(e.wordAt(SAMPLE, null, p, p + 3), null);                    // a partial selection
  assert.strictEqual(e.wordAt(SAMPLE, null, SAMPLE.indexOf('was wide') + 1), null);  // a stopword
  assert.strictEqual(e.wordAt(SAMPLE, null, SAMPLE.indexOf('inside code')), null);    // in code
});
test('window() only reports words in the range, with context beyond it', function () {
  var e = new C.Engine(), t = 'The lantern swung. ' + 'Filler words go here. '.repeat(1) + 'The lantern fell.';
  var second = t.lastIndexOf('lantern'), w = e.window(t, null, second, second + 7);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].from, second);
  assert.strictEqual(w[0].dir, -1);
});
test('the cache: an edit re-reads only its paragraph; option changes reset keys', function () {
  var paras = []; for (var i = 0; i < 50; i++) paras.push('Paragraph ' + i + ' has a lantern and another lantern.');
  var t = paras.join('\n\n'), e = new C.Engine();
  e.index(t);
  assert.strictEqual(e.cache.size, 50);
  var t2 = t.replace('Paragraph 7 has', 'Paragraph 7 now has');
  e.index(t2);
  assert.strictEqual(e.cache.size, 51);
  assert.strictEqual(e.setOptions({ style: 'underline' }), false);   // display only
  assert.strictEqual(e.cache.size, 51);
  assert.strictEqual(e.setOptions({ stem: false }), true);
  assert.strictEqual(e.cache.size, 0);
  assert.strictEqual(e.setOptions({ stem: false, taper: 3 }), true);  // severity only: keys kept
});

// ---- speed --------------------------------------------------------------------------------------
test('a 100k-word note stays responsive', function () {
  var W = 'river mountain silver quiet morning idea ladder window garden kitchen story letter harbor engine signal pocket candle winter summer bridge forest meadow voice shadow'.split(' ');
  var F = 'the a of and to in was it that he she'.split(' ');
  var seed = 7; function r(n) { seed = (seed * 16807) % 2147483647; return seed % n; }
  var paras = [], words = 0;
  while (words < 100000) {
    var s = [], ns = 3 + r(4);
    for (var j = 0; j < ns; j++) { var n = 8 + r(16), a = []; for (var k = 0; k < n; k++) a.push(r(3) ? F[r(F.length)] : W[r(W.length)]); s.push(a.join(' ') + '.'); words += n; }
    paras.push(s.join(' '));
  }
  var text = paras.join('\n\n'), e = new C.Engine();
  var t0 = Date.now(), bl = e.blocks(text), mid = text.length >> 1;
  var w = e.window(text, bl, mid, mid + 4000);
  var t1 = Date.now();
  e.index(text, bl);
  var t2 = Date.now();
  var edited = text.slice(0, mid) + 'x' + text.slice(mid), bl2 = e.blocks(edited);
  e.window(edited, bl2, mid, mid + 4000); e.index(edited, bl2);
  var t3 = Date.now();
  assert.ok(w.length > 20);
  assert.ok(t1 - t0 < 200, 'scan + first window ' + (t1 - t0) + 'ms');
  assert.ok(t2 - t1 < 1500, 'cold whole-note index ' + (t2 - t1) + 'ms');
  assert.ok(t3 - t2 < 300, 'after an edit: rescan + window + index ' + (t3 - t2) + 'ms');
});

console.log('echoes: ' + passed + ' passed');
