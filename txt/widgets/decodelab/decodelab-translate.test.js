/* Tests for Decode Lab's translation module (decodelab-translate.js) and its
 * Bergamot worker. Not loaded by the app (not in the manifest).
 *
 *   node txt/widgets/decodelab/decodelab-translate.test.js
 *     pure tests: chunking, language guessing, registry, engine choice (fake Chrome API)
 *   DECODELAB_E2E=1 node txt/widgets/decodelab/decodelab-translate.test.js
 *     + end-to-end: the real worker file runs in a vm "worker", downloads the
 *       engine (5 MB) and the Spanish model (22 MB), verifies Mozilla's hashes,
 *       stores them in a fake Cache Storage and translates Spanish/German text.
 *     DECODELAB_MODELS=<dir> serves files named <sha256> from <dir> instead of the network. */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), vm = require('vm');
var T = require('./decodelab-translate.js');
var core = require('./decodelab-core.js')();
core.setData(require('./decodelab-data.js'));

var passed = 0, failed = 0, queue = [];
function test(name, fn) { queue.push([name, fn]); }

// ---- registry -------------------------------------------------------------------
test('registry covers the requested languages with verified file records', function () {
  var need = ['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'uk', 'pl', 'tr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ar'];
  need.forEach(function (c) { assert.ok(T.LANGS.some(function (L) { return L.code === c; }), 'missing ' + c); });
  assert.ok(T.LANGS.length >= 40);
  T.LANGS.forEach(function (L) {
    assert.ok(L.files.model && L.files.lex && (L.files.vocab || (L.files.srcvocab && L.files.trgvocab)), L.code);
    Object.keys(L.files).forEach(function (k) {
      var f = L.files[k];
      assert.ok(/^https:\/\/(bergamot\.s3\.amazonaws\.com|huggingface\.co)\//.test(f.u), f.u);
      assert.ok(/^[0-9a-f]{64}$/.test(f.h), L.code + ' ' + k + ' hash');
      assert.ok(f.s > 1000, L.code + ' ' + k + ' size');
    });
    assert.ok(L.size > 10e6 && L.size < 80e6, L.code + ' size ' + L.size);
  });
  assert.ok(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@browsermt\/bergamot-translator@0\.4\.9\//.test(T.ENGINE.wasm.u));
});

test('registry: every language also has an English -> X model, self-hosted', function () {
  T.LANGS.forEach(function (L) {
    assert.ok(L.to, 'no en>' + L.code);
    assert.strictEqual(L.to.key, 'en>' + L.code);
    assert.ok(L.to.files.model && L.to.files.lex && (L.to.files.vocab || (L.to.files.srcvocab && L.to.files.trgvocab)), L.code);
    Object.keys(L.to.files).forEach(function (k) {
      var f = L.to.files[k];
      assert.ok(/^https:\/\/cadezawacki\.github\.io\/txt-models-[bc]\/en-x\//.test(f.u), f.u);
      assert.ok(f.u.indexOf('/en-x/' + L.code + '/') > 0, f.u);
      assert.strictEqual(f.m, '');
      assert.ok(/^[0-9a-f]{64}$/.test(f.h) && f.s > 1000, L.code + ' ' + k);
    });
    assert.ok(L.to.size > 10e6 && L.to.size < 80e6, L.code + ' to-size ' + L.to.size);
  });
  assert.deepStrictEqual(T.LANGS.filter(function (L) { return L.to.pre; }).map(function (L) { return L.code; }).sort(), ['ko', 'ru']);
  // txt-models-b holds the 15 most asked-for; a GitHub Pages site stays under 1 GB
  var b = 0, c = 0;
  T.LANGS.forEach(function (L) { if (L.to.files.model.u.indexOf('/txt-models-b/') > 0) b += L.to.size; else c += L.to.size; });
  assert.ok(b < 600e6 && c < 950e6, b + ' ' + c);
});
test('route: into English, out of English, and through English', function () {
  var keys = function (r) { return r && r.map(function (m) { return m.key; }); };
  assert.deepStrictEqual(keys(T.route('es')), ['es>en']);
  assert.deepStrictEqual(keys(T.route('es', 'en')), ['es>en']);
  assert.deepStrictEqual(keys(T.route('en', 'ja')), ['en>ja']);
  assert.deepStrictEqual(keys(T.route('de', 'zh-Hant')), ['de>en', 'en>zh-Hant']);
  assert.strictEqual(T.route('en', 'en'), null);
  assert.strictEqual(T.route('es', 'es'), null);
  assert.strictEqual(T.route('la', 'en'), null);
  assert.strictEqual(T.route('en', 'la'), null);
  assert.strictEqual(T.pairName('es'), 'Spanish');
  assert.strictEqual(T.pairName('en', 'fr'), 'English → French');
});

// ---- chunking -----------------------------------------------------------------------
test('chunkText keeps line breaks and spacing, splits long paragraphs', function () {
  var text = '  Hola mundo.\n\nSegunda línea  \r\nTercera';
  var ch = T.chunkText(text, 600);
  assert.deepStrictEqual(ch.texts, ['Hola mundo.', 'Segunda línea', 'Tercera']);
  assert.strictEqual(T.reassemble(ch, ch.texts.map(function (t) { return '[' + t + ']'; })), '  [Hola mundo.]\n\n[Segunda línea]  \r\n[Tercera]');
  var long = ''; for (var i = 0; i < 40; i++) long += 'Esta es la frase número ' + i + ' del párrafo. ';
  var c2 = T.chunkText(long.trim(), 200);
  assert.ok(c2.texts.length > 5);
  c2.texts.forEach(function (t) { assert.ok(t.length <= 200, t.length); });
  assert.strictEqual(T.reassemble(c2, c2.texts).replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));
  var huge = new Array(300).join('palabra ');
  T.chunkText(huge, 100).texts.forEach(function (t) { assert.ok(t.length <= 100); });
  var cjk = new Array(60).join('今日はとても良い天気ですね。');
  var c3 = T.chunkText(cjk, 120);
  assert.ok(c3.texts.length > 3);
  assert.strictEqual(T.reassemble(c3, c3.texts), cjk);
  assert.deepStrictEqual(T.chunkText('   \n  ', 100).texts, []);
});

// ---- language guess ---------------------------------------------------------------------
test('guessLang identifies the main languages offline', function () {
  var S = {
    es: '¿Dónde está la biblioteca? Mañana vamos a la playa con mis amigos.',
    fr: "Où est la bibliothèque ? Demain nous irons à la plage avec mes amis.",
    de: 'Wo ist die Bibliothek? Morgen gehen wir mit meinen Freunden an den Strand.',
    it: 'Dove si trova la biblioteca? Domani andiamo al mare con i miei amici.',
    pt: 'Onde fica a biblioteca? Amanhã vamos à praia com os meus amigos.',
    nl: 'Waar is de bibliotheek? Morgen gaan we met mijn vrienden naar het strand.',
    ru: 'Где находится библиотека? Завтра мы пойдём на пляж с друзьями.',
    uk: 'Де знаходиться бібліотека? Завтра ми підемо на пляж із друзями.',
    pl: 'Gdzie jest biblioteka? Jutro idziemy na plażę z moimi przyjaciółmi.',
    tr: 'Kütüphane nerede? Yarın arkadaşlarımla sahile gideceğiz.',
    'zh-Hans': '图书馆在哪里？明天我们和朋友们一起去海边。',
    'zh-Hant': '圖書館在哪裡？明天我們和朋友們一起去海邊。',
    ja: '図書館はどこですか？明日は友達と海に行きます。',
    ko: '도서관이 어디에 있나요? 내일 친구들과 바다에 갑니다.',
    ar: 'أين المكتبة؟ غدا سنذهب إلى الشاطئ مع أصدقائي.',
    fa: 'کتابخانه کجاست؟ فردا با دوستانم به ساحل می\u200cرویم.',
    he: 'איפה הספרייה? מחר נלך לחוף עם החברים שלי.',
    el: 'Πού είναι η βιβλιοθήκη; Αύριο θα πάμε στην παραλία με τους φίλους μου.',
    hi: 'प\u0941स\u094dतक\u093eलय कह\u093e\u0901 ह\u0948? कल हम अपन\u0947 द\u094bस\u094dत\u094b\u0902 क\u0947 स\u093eथ सम\u0941द\u094dर तट पर ज\u093eए\u0902ग\u0947।',
    th: 'ห\u0e49องสม\u0e38ดอย\u0e39\u0e48ท\u0e35\u0e48ไหน พร\u0e38\u0e48งน\u0e35\u0e49เราจะไปทะเลก\u0e31บเพ\u0e37\u0e48อน',
    cs: 'Kde je knihovna? Zítra půjdeme s přáteli na pláž, řekl jsem.',
    hu: 'Hol van a könyvtár? Holnap a barátaimmal megyünk a strandra, ő is jön, ű.',
    vi: 'Thư viện ở đâu? Ngày mai chúng tôi sẽ đi biển với bạn bè.',
    ro: 'Unde este biblioteca? Mâine mergem la plajă cu prietenii mei, și așa.',
    sr: 'Где је библиотека? Сутра идемо на плажу са пријатељима, љубав, ђак.',
  };
  var miss = [];
  Object.keys(S).forEach(function (code) {
    var g = T.guessLang(S[code], core);
    if (g.code !== code) miss.push(code + ' → ' + g.code);
  });
  assert.ok(miss.length === 0, 'misdetected: ' + miss.join(', '));
  assert.strictEqual(T.guessLang('The library is down the street, past the bank.', core).code, 'en');
});

test('guessLang: unspaced text split over lines (old Dutch report)', function () {
  var nl = 'Tweeoogenblikkentredenin\neenmaetwijckt\nWerpteenschipwederhuyswaerts\nOmteleerenwatdentijtgelooft';
  [nl, nl.replace(/\n/g, '')].forEach(function (s) {
    var g = T.guessLang(s, core);
    assert.strictEqual(g.code, 'nl', JSON.stringify(g));
    assert.ok(g.conf >= 0.8, 'conf ' + g.conf);
  });
});

// ---- language names: ``` fence info strings, typed names -------------------------------------
var NAME_CASES = {
  es: ['Spanish', 'spanish', 'SPANISH', 'Español', 'espanol', 'es', 'ES', 'es-ES', 'es_MX', 'Spanish (Mexico)', '{.spanish}', 'castellano'],
  fr: ['French', 'Français', 'francais', 'fr', 'fr-CA'], de: ['German', 'Deutsch', 'de', 'de-AT'], nl: ['Dutch', 'Nederlands', 'nl', 'nl-BE'],
  'zh-Hans': ['zh', 'zh-Hans', 'zh-CN', 'zh-Hans-CN', 'Chinese', 'Mandarin', '中文', '简体中文', 'Chinese (Simplified)'],
  'zh-Hant': ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-Hant-TW', 'Chinese (Traditional)', 'Traditional Chinese', '繁體中文'],
  ja: ['Japanese', '日本語', 'ja', 'ja-JP'], ko: ['Korean', '한국어', 'ko'], ru: ['Russian', 'Русский', 'ru'], el: ['Greek', 'Ελληνικά', 'el-GR'],
  pl: ['Polish', 'Polski', 'pl-PL'], cs: ['Czech', 'Čeština', 'cs-CZ'], sv: ['Swedish', 'Svenska', 'sv-SE'], ml: ['Malayalam', 'ml-IN'],
  he: ['Hebrew', 'עברית', 'he', 'iw'], hi: ['Hindi', 'हिन्दी', 'हिंदी', 'hi'], vi: ['Vietnamese', 'Tiếng Việt', 'tieng viet', 'vi'],
  id: ['Indonesian', 'Bahasa Indonesia', 'id'], ms: ['Malay', 'Bahasa Melayu'], pt: ['Portuguese', 'Português', 'pt-BR', 'pt_PT'],
  uk: ['Ukrainian', 'Українська', 'uk'], fa: ['Persian', 'Farsi', 'فارسی'], th: ['Thai', 'ไทย'],
};
// programming languages and other fence infos: never a language (pl Perl, cs C#, el Emacs Lisp, ml OCaml, sv SystemVerilog)
var NOT_NAMES = ['', 'js', 'javascript', 'ts', 'typescript', 'py', 'python', 'sh', 'bash', 'pl', 'perl', 'cs', 'csharp', 'el', 'ml', 'ocaml', 'sv',
  'go', 'rs', 'rust', 'rb', 'json', 'html', 'css', 'sql', 'output', 'text', 'txt', 'diff', 'mermaid', 'md', 'es6', 'c', 'cpp', 'java', 'kotlin', 'swift', 'yaml', 'toml', 'ps', 'mk', 'r', 'lua', 'math'];
test('langFromName: names, native names and tags; never code-fence languages', function () {
  Object.keys(NAME_CASES).forEach(function (code) {
    NAME_CASES[code].forEach(function (n) { assert.strictEqual(T.langFromName(n), code, JSON.stringify(n)); });
  });
  NOT_NAMES.forEach(function (n) { assert.strictEqual(T.langFromName(n), '', JSON.stringify(n)); });
  // every registry language resolves from its English and native name
  T.LANGS.forEach(function (L) {
    assert.strictEqual(T.langFromName(L.name), L.code, L.name);
    assert.strictEqual(T.langFromName(L.native), L.code, L.native);
  });
  // English and languages with no on-device model are recognised as such
  assert.strictEqual(T.langFromName('English'), 'en');
  assert.strictEqual(T.langFromName('en-GB'), 'en');
  assert.strictEqual(T.langFromName('Latin'), 'la');
  assert.strictEqual(T.langName('la'), 'Latin');
  assert.strictEqual(T.langFromName('Norwegian'), 'nb');
});
test('translate-blocks plugin: its language table agrees with the translator', function () {
  var P = require('../../plugins/translate-blocks/translate-blocks.js');
  var codes = T.LANGS.map(function (L) { return L.code; }).sort();
  assert.deepStrictEqual(Object.keys(P.NAMES).sort(), codes);
  var all = [];
  Object.keys(P.NAMES).forEach(function (c) { P.NAMES[c].split('|').forEach(function (n) { all.push(n); }); });
  Object.keys(NAME_CASES).forEach(function (c) { all = all.concat(NAME_CASES[c]); });
  T.LANGS.forEach(function (L) { all.push(L.name, L.native, L.code + '-XX'); });
  all.forEach(function (n) {
    var want = T.langFromName(n);
    assert.ok(want && codes.indexOf(want) >= 0, 'translator: ' + n + ' -> ' + want);
    assert.strictEqual(P.langOfInfo(n), want, 'plugin vs translator: ' + JSON.stringify(n));
  });
  // bare codes: the same answer (ambiguous ones are '' in both)
  T.LANGS.forEach(function (L) { assert.strictEqual(P.langOfInfo(L.code), T.langFromName(L.code), L.code); });
  // no chip for English, other languages or code
  NOT_NAMES.concat(['English', 'english', 'en', 'en-US', 'Latin', 'Norwegian', 'Esperanto']).forEach(function (n) {
    assert.strictEqual(P.langOfInfo(n), '', JSON.stringify(n));
  });
});

test('pairFromInfo: ``` fences name a direction; the chips plugin agrees', function () {
  var P = require('../../plugins/translate-blocks/translate-blocks.js');
  var cases = {
    'Spanish': ['es', 'en'], 'español': ['es', 'en'], 'English to Spanish': ['en', 'es'], 'en>es': ['en', 'es'], 'en > sv': ['en', 'sv'],
    'Spanish → French': ['es', 'fr'], 'de -> ja': ['de', 'ja'], 'Deutsch => English': ['de', 'en'], 'to Spanish': ['', 'es'], '> ja': ['', 'ja'],
    'into Japanese': ['', 'ja'], 'en-US to es-MX': ['en', 'es'], 'Chinese (Traditional) to English': ['zh-Hant', 'en'], 'English -> русский': ['en', 'ru'],
    'English': null, 'sv': null, 'js': null, 'python': null, 'text to speech': null, 'c++ to python': null, 'to do': null, 'js > out': null,
    'English to English': null, 'Latin to English': null, 'English to Latin': null, '': null,
  };
  Object.keys(cases).forEach(function (info) {
    var want = cases[info], got = T.pairFromInfo(info);
    assert.deepStrictEqual(got, want && { from: want[0], to: want[1] }, JSON.stringify(info));
    assert.deepStrictEqual(P.pairOfInfo(info), got, 'plugin: ' + JSON.stringify(info));
  });
  T.LANGS.forEach(function (L) {
    [L.name + ' to English', 'English to ' + L.name, 'to ' + L.native, L.code + '>en', 'en>' + L.code].forEach(function (info) {
      assert.deepStrictEqual(P.pairOfInfo(info), T.pairFromInfo(info), info);
      assert.ok(T.pairFromInfo(info), info);
    });
  });
});

// ---- engine choice (fake Chrome API + fake Cache Storage) ----------------------------------
function FakeCaches() {
  var buckets = {};
  function bucket(name) {
    var st = buckets[name] = buckets[name] || {};
    return {
      match: function (u) { return Promise.resolve(st[u] ? new Response(st[u].slice(0)) : undefined); },
      put: function (u, r) { return r.arrayBuffer().then(function (b) { st[u] = b; }); },
      delete: function (u) { var had = !!st[u]; delete st[u]; return Promise.resolve(had); },
      keys: function () { return Promise.resolve(Object.keys(st).map(function (u) { return { url: u }; })); },
    };
  }
  this.open = function (n) { return Promise.resolve(bucket(n)); };
  this.delete = function (n) { var had = !!buckets[n]; delete buckets[n]; return Promise.resolve(had); };
  this._buckets = buckets;
}
test('engine choice: Chrome when it has the language, Bergamot otherwise', async function () {
  global.caches = new FakeCaches();
  global.self = {
    Translator: Object.assign(function () {}, {
      availability: function (o) { return Promise.resolve(o.sourceLanguage === 'es' ? 'available' : o.sourceLanguage === 'fr' ? 'downloadable' : 'unavailable'); },
      create: function (o) {
        if (o.monitor) { var ev = { addEventListener: function (n, f) { f({ loaded: 1 }); } }; o.monitor(ev); }
        return Promise.resolve({ translate: function (t) { return Promise.resolve('EN(' + t + ')'); }, destroy: function () {} });
      },
    }),
  };
  try {
    var m = T.create({ workerUrl: 'x', core: core });
    assert.strictEqual(m.hasChrome, true);
    var es = await m.status('es');
    assert.deepStrictEqual([es.engine, es.ready], ['chrome', true]);
    var fr = await m.status('fr');
    assert.deepStrictEqual([fr.engine, fr.ready, fr.needs], ['chrome', false, 'chrome-download']);
    var de = await m.status('de');
    assert.deepStrictEqual([de.engine, de.ready, de.needs], ['bergamot', false, 'download']);
    assert.ok(de.size > m.lang('de').size, 'first download includes the engine');
    var out = await m.translate('Hola.\n\nAdiós.', 'es');
    assert.strictEqual(out.text, 'EN(Hola.)\n\nEN(Adiós.)');
    assert.strictEqual(out.label, 'On-device · Chrome');
    var fr2 = await m.download('fr');
    assert.strictEqual(fr2.ready, true);
    var none = await m.status('xx');
    assert.strictEqual(none.engine, '');
    m.dispose();
  } finally { delete global.self; delete global.caches; }
});

test('two-way: Chrome per pair, Bergamot route sizes, pivot through English', async function () {
  global.caches = new FakeCaches();
  var posted = [];
  global.self = {
    Translator: Object.assign(function () {}, {
      availability: function (o) { return Promise.resolve(o.sourceLanguage === 'en' && o.targetLanguage === 'es' ? 'available' : 'unavailable'); },
      create: function (o) { return Promise.resolve({ translate: function (t) { return Promise.resolve(o.targetLanguage.toUpperCase() + '(' + t + ')'); }, destroy: function () {} }); },
    }),
  };
  // a stand-in worker: "downloads" into the fake cache, "translates" by tagging with the model key
  global.Worker = function () {
    var w = this;
    this.postMessage = function (m) {
      posted.push(m);
      setImmediate(function () {
        if (m.type === 'download') {
          caches.open(T.CACHE).then(function (c) { return Promise.all(m.files.map(function (f) { return c.put(f.u, new Response(new Uint8Array(4))); })); })
            .then(function () { w.onmessage({ data: { type: 'done', id: m.id } }); });
        } else if (m.type === 'translate') w.onmessage({ data: { type: 'done', id: m.id, texts: m.texts.map(function (t) { return m.lang + '[' + t + ']'; }) } });
        else w.onmessage({ data: { type: 'done', id: m.id } });
      });
    };
    this.terminate = function () {};
  };
  try {
    var m = T.create({ workerUrl: 'x', core: core });
    var a = await m.status('en', 'es');
    assert.deepStrictEqual([a.engine, a.ready], ['chrome', true]);
    assert.strictEqual((await m.translate('Hello.', 'en', null, 'es')).text, 'ES(Hello.)');
    var p = await m.status('es', 'fr');
    assert.deepStrictEqual([p.engine, p.needs, p.missing], ['bergamot', 'download', ['es>en', 'en>fr']]);
    assert.strictEqual(p.size, m.lang('es').size + m.lang('fr').to.size + m.engineSize);
    assert.ok(/via English/.test(p.label));
    // only the X->en half: the pivot then needs just the other model
    await m.download('es', null, 'en', ['es>en']);
    var p2 = await m.status('es', 'fr');
    assert.deepStrictEqual([p2.missing, p2.size], [['en>fr'], m.lang('fr').to.size]);
    var r = await m.download('es', null, 'fr');
    assert.strictEqual(r.ready, true);
    var have = await m.downloaded();
    assert.ok(have.es && have._to.fr && !have.fr && !have._to.es && have._engine);
    var steps = [];
    var out = await m.translate('Hola.\n\nAdiós.', 'es', function (f) { steps.push(f); }, 'fr');
    assert.strictEqual(out.text, 'en>fr[es>en[Hola.]]\n\nen>fr[es>en[Adiós.]]');
    assert.deepStrictEqual([out.from, out.to], ['es', 'fr']);
    assert.ok(steps.length && steps[steps.length - 1] === 1 && steps.every(function (f, i) { return !i || f >= steps[i - 1]; }), steps.join());
    var tr = posted.filter(function (x) { return x.type === 'translate'; });
    assert.deepStrictEqual(tr.map(function (x) { return x.lang + ':' + x.keep; }), ['es>en:2', 'en>fr:2']);
    assert.strictEqual((await m.translate('Hola.', 'es')).text, 'es>en[Hola.]');
    assert.strictEqual(posted.filter(function (x) { return x.type === 'translate'; }).pop().keep, 1);
    // removing one direction keeps the other
    await m.remove('fr', 'to');
    have = await m.downloaded();
    assert.ok(have.es && !have._to.fr);
    assert.strictEqual(await m.usage(), m.lang('es').size + m.engineSize);
    await m.remove('es', 'both');
    assert.strictEqual(await m.usage(), m.engineSize);
    var bad = await m.status('en', 'en');
    assert.ok(!bad.engine && /different/.test(bad.why));
    m.dispose();
  } finally { delete global.self; delete global.caches; delete global.Worker; }
});

// ---- end-to-end with the real worker file (opt-in: downloads ~27 MB) -------------------------
function FakeWorker(url, env) {
  var self = this, ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Date: Date, Promise: Promise,
    TextDecoder: TextDecoder, TextEncoder: TextEncoder, WebAssembly: WebAssembly, URL: URL, Blob: Blob, Response: Response,
    crypto: require('crypto').webcrypto, caches: env.caches, fetch: env.fetch, Uint8Array: Uint8Array, Int8Array: Int8Array, ArrayBuffer: ArrayBuffer,
    importScripts: function () { throw new Error('importScripts not used'); },
    location: new URL('https://cadezawacki.github.io/txt/widgets/decodelab/decodelab-translate-worker.js?v=1'),
  };
  ctx.self = ctx;
  ctx.postMessage = function (m) { setImmediate(function () { if (self.onmessage) self.onmessage({ data: m }); }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'decodelab-translate-worker.js'), 'utf8'), ctx, { filename: 'decodelab-translate-worker.js' });
  this.postMessage = function (m) { setImmediate(function () { ctx.onmessage({ data: JSON.parse(JSON.stringify(m)) }); }); };
  this.terminate = function () { ctx.onmessage = function () {}; };
}
if (process.env.DECODELAB_E2E) {
  test('end-to-end: download + verify + translate with the Bergamot worker', async function () {
    this.timeout = 600000;
    var dir = process.env.DECODELAB_MODELS, fetched = [];
    var env = {
      caches: new FakeCaches(),
      fetch: function (u, o) {
        var all = [T.ENGINE.glue, T.ENGINE.wasm];
        T.LANGS.forEach(function (L) { Object.keys(L.files).forEach(function (k) { all.push(L.files[k]); }); });
        var f = all.filter(function (x) { return x.u === u; })[0];
        if (dir && f && fs.existsSync(path.join(dir, f.h))) return Promise.resolve(new Response(fs.readFileSync(path.join(dir, f.h))));
        fetched.push(u);
        assert.strictEqual(o.cache, 'no-store');
        return fetch(u, o);
      },
    };
    global.caches = env.caches;
    global.Worker = function (url) { return new FakeWorker(url, env); };
    try {
      var m = T.create({ workerUrl: 'decodelab-translate-worker.js', core: core });
      assert.strictEqual(m.hasChrome, false);
      var st = await m.status('es');
      assert.deepStrictEqual([st.engine, st.needs], ['bergamot', 'download']);
      var prog = [];
      var ready = await m.download('es', function (f, stage) { prog.push(stage + ':' + f.toFixed(2)); });
      assert.strictEqual(ready.ready, true);
      assert.strictEqual(ready.label, 'On-device · Firefox Translations');
      assert.ok(prog.length > 0);
      var have = await m.downloaded();
      assert.ok(have.es && have._engine);
      var used = await m.usage();
      assert.strictEqual(used, m.lang('es').size + m.engineSize);
      var steps = [];
      var out = await m.translate('¿Dónde está la biblioteca?\n\nEl perro come pan.  Hace mucho calor hoy.', 'es', function (f, s) { steps.push(s); });
      console.log('    es→en:', JSON.stringify(out.text));
      assert.ok(/library/i.test(out.text) && /dog/i.test(out.text) && /\n\n/.test(out.text), out.text);
      assert.ok(core.score(out.text).lang === 'en');
      // a second language: the model is swapped, the engine reused
      if (process.env.DECODELAB_E2E_DE) {
        await m.download('de');
        var de = await m.translate('Wo ist der Bahnhof?', 'de');
        console.log('    de→en:', JSON.stringify(de.text));
        assert.ok(/station/i.test(de.text));
      }
      await m.remove('es');
      assert.ok(!(await m.downloaded()).es);
      await m.removeAll();
      assert.strictEqual(await m.usage(), 0);
      m.dispose();
    } finally { delete global.caches; delete global.Worker; }
  });
  test('worker refuses a file whose checksum does not match', async function () {
    var env = { caches: new FakeCaches(), fetch: function () { return Promise.resolve(new Response(new Uint8Array(100))); } };
    var w = new FakeWorker('x', env), got = await new Promise(function (resolve) {
      w.onmessage = function (e) { if (e.data.type !== 'progress') resolve(e.data); };
      w.postMessage({ type: 'download', id: 1, files: [{ u: 'https://example.invalid/model.bin', s: 100, h: 'ab'.repeat(32) }] });
    });
    assert.strictEqual(got.type, 'error');
    assert.ok(/Checksum mismatch/.test(got.message), got.message);
    assert.strictEqual((await (await env.caches.open('cade-translate-v1')).keys()).length, 0);
  });
}

(async function () {
  for (var i = 0; i < queue.length; i++) {
    var t0 = Date.now();
    try { await queue[i][1].call({}); passed++; if (Date.now() - t0 > 3000) console.log('  ' + queue[i][0] + ' (' + (Date.now() - t0) + ' ms)'); }
    catch (e) { failed++; console.error('FAIL ' + queue[i][0] + '\n' + (e.stack || e)); process.exitCode = 1; }
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + 'passed ' + passed);
})();
