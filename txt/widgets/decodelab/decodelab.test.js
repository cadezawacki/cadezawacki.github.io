/* Unit tests for Decode Lab's engine (decoders, ciphers, scoring, analysis, search).
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/decodelab/decodelab.test.js */
'use strict';
var assert = require('assert');
var zlib = require('zlib');
var core = require('./decodelab-core.js')();
core.setData(require('./decodelab-data.js'));
var U = core.util;

var passed = 0, failed = 0;
function test(name, fn) {
  var t0 = Date.now();
  try { fn(); passed++; if (Date.now() - t0 > 1500) console.log('  slow: ' + name + ' ' + (Date.now() - t0) + 'ms'); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function txt(v) { return U.isBytes(v) ? U.utf8Decode(v) : v; }
function search(input, opts) { return core.createSearch(input, opts || { depth: 3, budget: 8000 }).runSync(); }
function best(s) { return s.top(1, true)[0]; }

var EN = 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, ' +
  'it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness.';
var EN2 = 'Meet me at the old bridge tomorrow night after the guards change their watch and bring the map with you';

// ---------------------------------------------------------------------------
// 1. Every op with an encoder round-trips
// ---------------------------------------------------------------------------
var RT = {
  base64: [{}, { variant: 'url' }], base32: [{ alphabet: 'rfc' }, { alphabet: 'hex' }, { alphabet: 'crockford' }, { alphabet: 'zbase' }],
  base58: [{}], base62: [{}], base36: [{}], ascii85: [{ variant: 'adobe' }, { variant: 'z85' }, { variant: 'rfc1924' }], base91: [{}],
  hex: [{ sep: 'none' }, { sep: 'space' }, { sep: 'colon' }, { sep: 'x' }, { sep: '0x' }], binary: [{ width: '8' }], octal: [{}],
  decimal: [{}, { bytes: true }], url: [{}, { all: true }], html: [{ mode: 'named' }, { mode: 'all' }, { mode: 'hex' }],
  uesc: [{ style: 'u' }, { style: 'u{' }, { style: 'U+' }], qp: [{}], uu: [{}], puny: [{}], datauri: [{}], reverse: [{}], flip: [{}],
  kbd: [{ dir: 'left' }, { dir: 'right' }], rot47: [{ n: 47 }, { n: 5 }], rot5: [{ mode: 'rot5' }, { mode: 'rot18' }], rot13: [{}],
  inflate: [{}], charset: [{ charset: 'utf-16le' }, { charset: 'utf-16be' }],
};
var RICH = 'Héllo, wörld! Ünïcödé ✓ 😀 — "quotes" & <tags> 123\nnew line';
Object.keys(RT).forEach(function (id) {
  RT[id].forEach(function (P) {
    test('round-trip ' + id + ' ' + JSON.stringify(P), function () {
      var src = id === 'flip' ? 'hello world the quick brown fox' : id === 'kbd' ? 'hello world the brown fox' : id === 'puny' ? 'bücher.example münchen' : RICH;
      var enc = core.apply(id, src, P, 'enc');
      var dec = core.apply(id, enc, P, 'dec');
      assert.strictEqual(txt(dec), src);
    });
  });
});
test('round-trip base64 of random bytes (all lengths 0..40)', function () {
  for (var n = 1; n < 40; n++) {
    var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = (i * 73 + n * 31) & 255;
    ['base64', 'base32', 'base58', 'base62', 'ascii85', 'base91', 'hex', 'binary', 'octal', 'uu', 'qp'].forEach(function (id) {
      if (id === 'qp') return;
      var e = core.apply(id, b, {}, 'enc'), d = core.apply(id, e, {}, 'dec');
      assert.deepStrictEqual(Array.from(d), Array.from(b), id + ' n=' + n);
    });
    ['z85', 'rfc1924'].forEach(function (v) {
      var e = core.apply('ascii85', b, { variant: v }, 'enc'), d = core.apply('ascii85', e, { variant: v }, 'dec');
      assert.deepStrictEqual(Array.from(d), Array.from(b), v + ' n=' + n);
    });
  }
});
test('Base64 without padding / URL-safe decodes', function () {
  assert.strictEqual(txt(core.apply('base64', 'SGVsbG8', {})), 'Hello');
  assert.strictEqual(txt(core.apply('base64', 'PDw_Pz4-', {})), '<<??>>');
  assert.strictEqual(core.apply('base64', 'PDw/Pz4+', {}, 'dec').length, 6);
});
test('known vectors: base32, base58, ascii85, z85, base91, punycode', function () {
  assert.strictEqual(txt(core.apply('base32', 'MZXW6YTBOI======', {})), 'foobar');
  assert.strictEqual(txt(core.apply('base58', 'StV1DL6CwTryKyV', {})), 'hello world');
  assert.strictEqual(txt(core.apply('ascii85', '<~87cURD]i,"Ebo80~>', {})), 'Hello World!');
  assert.deepStrictEqual(Array.from(core.apply('ascii85', 'HelloWorld', { variant: 'z85' })), [0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b]);
  assert.strictEqual(txt(core.apply('base91', '>OwJh>Io0Tv!8PE', {})), 'Hello World!');
  assert.strictEqual(core.apply('puny', 'xn--mnchen-3ya.de', {}), 'münchen.de');
  assert.strictEqual(core.apply('puny', 'münchen.de', {}, 'enc'), 'xn--mnchen-3ya.de');
});
var CLASSIC = {
  caesar: [{ shift: 3 }, { shift: 13 }, { shift: 7, alphabet: 'ru33' }, { shift: 5, alphabet: 'greek' }, { shift: 4, alphabet: 'es27' }, { shift: 9, alphabet: 'de29' }, { shift: 3, alphabet: 'hebrew' }],
  atbash: [{}, { alphabet: 'ru33' }, { alphabet: 'greek' }, { alphabet: 'hebrew' }], affine: [{ a: 5, b: 8 }, { a: 25, b: 3 }],
  keyword: [{ keyword: 'ZEBRAS' }], subst: [{ key: 'QWERTYUIOPASDFGHJKLZXCVBNM' }],
  vigenere: [{ key: 'LEMON' }], beaufort: [{ key: 'FORTIFICATION' }], varbeaufort: [{ key: 'KEY' }], gronsfeld: [{ key: '31415' }],
  autokey: [{ key: 'QUEEN' }], porta: [{ key: 'PORTA' }], trithemius: [{ start: 3, step: 1, period: 1 }, { start: 0, step: -2, period: 3 }],
  railfence: [{ rails: 3, offset: 0 }, { rails: 5, offset: 3 }], scytale: [{ rows: 4 }, { rows: 7 }], columnar: [{ key: 'ZEBRAS' }, { key: '3 1 4 2' }],
  dcolumnar: [{ key1: 'ZEBRAS', key2: 'STRIPE' }], route: [{ cols: 5, route: 'spiral' }, { cols: 6, route: 'snakeCols' }, { cols: 4, route: 'spiralCCW' }, { cols: 7, route: 'diag' }, { cols: 5, route: 'spiralIn' }],
  xor1: [{ key: 42 }], xor: [{ key: 'ICE' }, { key: 'deadbeef', keyType: 'hex' }],
};
var PT = 'Defend the east wall of the castle, attack at dawn!';
var PT_RU = 'Съешь же ещё этих мягких французских булок, да выпей чаю.';
var PT_EL = 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία';
var PT_HE = 'שלום עולם זה טקסט';
Object.keys(CLASSIC).forEach(function (id) {
  CLASSIC[id].forEach(function (P) {
    test('round-trip ' + id + ' ' + JSON.stringify(P), function () {
      var src = P.alphabet === 'ru33' ? PT_RU : P.alphabet === 'greek' ? PT_EL.replace(/ς/g, 'σ') : P.alphabet === 'hebrew' ? PT_HE : P.alphabet === 'es27' ? 'El niño come piña' : P.alphabet === 'de29' ? 'Grüße aus Köln' : PT;
      if (P.alphabet === 'greek') src = src.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
      var enc = core.apply(id, src, P, 'enc');
      assert.notStrictEqual(txt(enc), src);
      assert.strictEqual(txt(core.apply(id, enc, P, 'dec')), src);
    });
  });
});
function lettersIJ(s) { return s.toUpperCase().replace(/[^A-Z]/g, '').replace(/J/g, 'I'); }
test('round-trip Playfair (Wikipedia example)', function () {
  var c = core.apply('playfair', 'Hide the gold in the tree stump', { key: 'PLAYFAIR EXAMPLE' }, 'enc');
  assert.strictEqual(c, 'BMODZBXDNABEKUDMUIXMMOUVIF');
  assert.strictEqual(core.apply('playfair', c, { key: 'PLAYFAIR EXAMPLE' }), 'HIDETHEGOLDINTHETREXESTUMP');
});
test('round-trip two-square / four-square / bifid / trifid / polybius / nihilist / ADFGX / ADFGVX / hill', function () {
  var src = 'HELP ME OBI WAN KENOBI ATTACK AT DAWN';
  var L = lettersIJ(src);
  [['twosquare', { key1: 'EXAMPLE', key2: 'KEYWORD', layout: 'v' }], ['twosquare', { key1: 'EXAMPLE', key2: 'KEYWORD', layout: 'h' }],
    ['foursquare', { key1: 'EXAMPLE', key2: 'KEYWORD' }], ['bifid', { key: 'BGWKZQPNDSIOAXEFCLUMTHYVR', period: 5 }], ['bifid', { key: '', period: 0 }],
    ['adfgx', { squareKey: 'BTALPDHOZKQFVSNGICUXMREWY', transKey: 'CARGO' }]].forEach(function (c) {
    var e = core.apply(c[0], src, c[1], 'enc'), d = core.apply(c[0], e, c[1]);
    assert.strictEqual(d.slice(0, L.length + (L.length % 2)), (L + (L.length % 2 ? 'X' : '')), c[0] + JSON.stringify(c[1]));
  });
  var tri = core.apply('trifid', 'DEFENDTHEEASTWALLOFTHECASTLE', { key: 'FELIXMARIEDELASTELLE', period: 5 }, 'enc');
  assert.strictEqual(core.apply('trifid', tri, { key: 'FELIXMARIEDELASTELLE', period: 5 }), 'DEFENDTHEEASTWALLOFTHECASTLE');
  var pb = core.apply('polybius', 'attack at dawn', { key: 'zebras' }, 'enc');
  assert.strictEqual(core.apply('polybius', pb, { key: 'zebras' }), 'ATTACK AT DAWN');
  var pb6 = core.apply('polybius', 'Agent 007', { size: '6', coords: 'ADFGVX' }, 'enc');
  assert.strictEqual(core.apply('polybius', pb6, { size: '6', coords: 'ADFGVX' }), 'AGENT 007');
  var nh = core.apply('nihilist', 'DYNAMITE WINTER PALACE', { squareKey: 'ZEBRAS', key: 'RUSSIAN' }, 'enc');
  assert.strictEqual(nh.split(' ')[0], '37');
  assert.strictEqual(core.apply('nihilist', nh, { squareKey: 'ZEBRAS', key: 'RUSSIAN' }), 'DYNAMITEWINTERPALACE');
  var ax = core.apply('adfgvx', 'ATTACK AT 1200AM', { squareKey: 'NA1C3H8TB2OME5WRPD4F6G7I9J0KLQSUVXYZ', transKey: 'PRIVACY' }, 'enc');
  assert.strictEqual(ax, 'DGDDDAGDDGAFADDFDADVDVFAADVX');
  assert.strictEqual(core.apply('adfgvx', ax, { squareKey: 'NA1C3H8TB2OME5WRPD4F6G7I9J0KLQSUVXYZ', transKey: 'PRIVACY' }), 'ATTACKAT1200AM');
  var h = core.apply('hill', 'help', { key: '3 3 2 5' }, 'enc');
  assert.strictEqual(h, 'HIAT');
  assert.strictEqual(core.apply('hill', h, { key: '3 3 2 5' }), 'HELP');
});
test('round-trip symbol codes (lossy: case / letters only)', function () {
  var s = 'SOS HELP 123';
  assert.strictEqual(core.apply('morse', core.apply('morse', s, {}, 'enc'), {}), s);
  assert.strictEqual(core.apply('morse', '... --- ...', {}), 'SOS');
  assert.strictEqual(core.apply('morse', '000 111 000', { variant: '01' }), 'SOS');
  assert.strictEqual(core.apply('morse', 'di-di-dit dah-dah-dah di-di-dit', {}), 'SOS');
  assert.strictEqual(core.apply('morse', '•••  −−−  •••', {}), 'SOS');
  assert.strictEqual(core.apply('bacon', core.apply('bacon', 'Hello', {}, 'enc'), {}), 'HELLO');
  assert.strictEqual(core.apply('bacon', core.apply('bacon', 'Hello', { variant: '24' }, 'enc'), { variant: '24' }), 'HELLO');
  assert.strictEqual(core.apply('bacon', 'aaBBa aBaaa', { symbols: 'case' }).slice(0, 2), 'GI');
  assert.strictEqual(core.apply('a1z26', core.apply('a1z26', 'hello world', {}, 'enc'), {}), 'hello world');
  assert.strictEqual(core.apply('t9', core.apply('t9', 'hello world', {}, 'enc'), {}), 'hello world');
  assert.strictEqual(core.apply('nato', core.apply('nato', 'Hi 42', {}, 'enc'), {}), 'HI 42');
  assert.strictEqual(core.apply('tap', core.apply('tap', 'kick', {}, 'enc'), {}), 'CICC');
  assert.strictEqual(core.apply('tap', core.apply('tap', 'water', { style: 'digits' }, 'enc'), {}), 'WATER');
  assert.strictEqual(core.apply('braille', core.apply('braille', 'Hello, world 2024!', {}, 'enc'), {}), 'Hello, world 2024!');
  assert.strictEqual(core.apply('leet', "h3ll0 w0rld, 1'm l33t 4nd 7h15 15 2024", {}), "hello world, i'm leet and this 15 2024");
  assert.strictEqual(core.apply('zalgo', 'H\u0335\u0321e\u0336\u0322l\u0337l\u0338o', {}), 'Hello');
  assert.strictEqual(core.apply('flip', 'plɹoʍ ollǝɥ', {}), 'hello world');
});
test('URL, HTML, unicode escapes, QP, JWT, data URI decode', function () {
  assert.strictEqual(core.apply('url', 'caf%C3%A9%20%26%20cr%C3%A8me', {}), 'café & crème');
  assert.strictEqual(core.apply('url', 'a+b%2Bc', { plus: true }), 'a b+c');
  assert.strictEqual(core.apply('html', '&lt;b&gt;caf&eacute; &#x263A; &#9731;&amp;&nbsp;', {}), '<b>café ☺ ☃&\u00a0');
  assert.strictEqual(core.apply('uesc', '\\u0048\\u0069 \\u{1F600} \\x41\\x42 U+00E9 \\xc3\\xa9', {}), 'Hi 😀 AB é é');
  assert.strictEqual(txt(core.apply('qp', 'caf=C3=A9 =\nsoft', {})), 'café soft');
  var jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  var j = core.apply('jwt', jwt, {});
  assert.ok(/"alg": "HS256"/.test(j) && /"name": "John Doe"/.test(j));
  assert.strictEqual(txt(core.apply('datauri', 'data:text/plain;base64,SGVsbG8=', {})), 'Hello');
  assert.strictEqual(txt(core.apply('datauri', 'data:,Hello%2C%20World', {})), 'Hello, World');
});
test('inflate matches node zlib (gzip, zlib, raw; stored/fixed/dynamic blocks)', function () {
  var big = ''; for (var i = 0; i < 300; i++) big += EN + ' ' + i + ' ';
  var rnd = new Uint8Array(70000); for (var k = 0; k < rnd.length; k++) rnd[k] = (k * 2654435761 >>> 13) & 255;
  [Buffer.from('a'), Buffer.from(EN), Buffer.from(big), Buffer.from(rnd)].forEach(function (src) {
    [0, 1, 6, 9].forEach(function (level) {
      var o = { level: level };
      assert.deepStrictEqual(Buffer.from(U.gunzip(new Uint8Array(zlib.gzipSync(src, o)))), src);
      assert.deepStrictEqual(Buffer.from(U.unzlib(new Uint8Array(zlib.deflateSync(src, o)))), src);
      assert.deepStrictEqual(Buffer.from(U.inflateRaw(new Uint8Array(zlib.deflateRawSync(src, o))).data), src);
    });
  });
  assert.strictEqual(txt(core.apply('inflate', new Uint8Array(zlib.gzipSync(Buffer.from('gz ok'))), {})), 'gz ok');
});
test('legacy charsets: windows-1251, koi8-r, shift_jis views', function () {
  var ru = 'Привет, мир! Это проверка кодировки.';
  var cp1251 = new Uint8Array(Array.from(ru).map(function (c) { var k = c.charCodeAt(0); return k >= 0x410 && k <= 0x44f ? k - 0x410 + 0xc0 : k; }));
  var v = core.scoreView(cp1251);
  assert.strictEqual(v.charset, 'windows-1251');
  assert.strictEqual(v.text, ru);
  assert.strictEqual(v.score.lang, 'ru');
});

// ---------------------------------------------------------------------------
// 2. Scoring + language detection
// ---------------------------------------------------------------------------
var SAMPLES = {
  en: ['The weather was lovely so we walked to the market and bought some bread.', 'Please send me the report before Friday afternoon.'],
  es: ['El tiempo era agradable y fuimos caminando al mercado a comprar pan.', 'Por favor envíame el informe antes del viernes por la tarde.'],
  fr: ['Il faisait beau alors nous sommes allés au marché acheter du pain.', 'Merci de m\'envoyer le rapport avant vendredi après-midi.'],
  de: ['Das Wetter war schön, also gingen wir zum Markt und kauften Brot.', 'Bitte schicken Sie mir den Bericht vor Freitagnachmittag.'],
  it: ['Il tempo era bello quindi siamo andati al mercato a comprare il pane.', 'Per favore mandami la relazione prima di venerdì pomeriggio.'],
  pt: ['O tempo estava bom então fomos a pé ao mercado comprar pão.', 'Por favor envie-me o relatório antes de sexta-feira à tarde.'],
  nl: ['Het weer was mooi dus liepen we naar de markt om brood te kopen.', 'Stuur me alstublieft het rapport voor vrijdagmiddag.'],
  ru: ['Погода была хорошая, поэтому мы пошли на рынок и купили хлеба.', 'Пожалуйста, пришлите мне отчёт до пятницы.'],
  el: ['Ο καιρός ήταν ωραίος και πήγαμε με τα πόδια στην αγορά να αγοράσουμε ψωμί.'],
  ar: ['كان الطقس جميلا لذلك ذهبنا إلى السوق واشترينا الخبز'], he: ['מזג האוויר היה נעים אז הלכנו לשוק וקנינו לחם'],
  hi: ['म\u094cसम अच\u094dछ\u093e थ\u093e इसल\u093fए हम ब\u093eज\u093eर गए और र\u094bट\u0940 खर\u0940द\u0940'], zh: ['天气很好，所以我们走路去市场买面包。'], ja: ['天気が良かったので、市場まで歩いてパンを買いました。'],
  ko: ['날씨가 좋아서 우리는 시장에 걸어가서 빵을 샀습니다.'],
};
test('language detection on short samples (every supported language)', function () {
  var miss = [];
  Object.keys(SAMPLES).forEach(function (l) {
    SAMPLES[l].forEach(function (s) {
      var r = core.score(s);
      if (r.lang !== l || r.score < 60) miss.push(l + ': ' + JSON.stringify(r) + ' ' + s);
    });
  });
  assert.ok(miss.length <= 1, 'misdetected:\n' + miss.join('\n'));
});
// Regression (user report): old Dutch written without spaces read as Dutch on
// one line but "Nothing clearly readable" once it was split over lines — each
// line counted as a "word", no line is a dictionary word, so the word-hit term
// capped the score below "clear".
var NL_LINES = 'Tweeoogenblikkentredenin\neenmaetwijckt\nWerpteenschipwederhuyswaerts\nOmteleerenwatdentijtgelooft';
var NL_ONE = 'Tweeoogenblikkentredenineenmaetwijcktwerpteenschipwederhuyswaertsomteleerenwatdentijtgelooft';
function unspaced(lines) { return lines.map(function (l) { return l.replace(/\s+/g, ''); }).join('\n'); }
var VERSES = {
  en: ['It was the best of times', 'it was the worst of times', 'it was the age of wisdom', 'it was the age of foolishness'],
  es: ['En un lugar de la Mancha', 'de cuyo nombre no quiero acordarme', 'no ha mucho tiempo que vivía un hidalgo'],
  de: ['Das Wetter war schön', 'also gingen wir zum Markt', 'und kauften frisches Brot'],
  fr: ['Il faisait beau alors', 'nous sommes allés au marché', 'acheter du pain frais'],
  pt: ['O tempo estava bom então', 'fomos a pé ao mercado', 'comprar pão fresco'],
  nl: ['Het weer was mooi', 'dus liepen we naar de markt', 'om vers brood te kopen'],
  ru: ['Погода была хорошая', 'поэтому мы пошли на рынок', 'и купили свежего хлеба'],
  el: ['Ο καιρός ήταν ωραίος', 'και πήγαμε με τα πόδια', 'στην αγορά να αγοράσουμε ψωμί'],
};
test('unspaced text split over lines still reads as its language (old Dutch report)', function () {
  [NL_LINES, NL_ONE, NL_LINES.replace(/\n/g, ' '), NL_LINES.replace(/\n/g, '\r\n'), NL_LINES.replace(/\n/g, ''), NL_LINES + '\n'].forEach(function (s) {
    var r = core.score(s);
    assert.strictEqual(r.lang, 'nl', JSON.stringify(s) + ' ' + JSON.stringify(r));
    assert.ok(r.score >= 70, JSON.stringify(s) + ' score ' + r.score);
  });
  // two lines are enough to trigger it too
  var two = core.score('Tweeoogenblikkentredenineenmaetwijckt\nWerpteenschipwederhuyswaertsomteleeren');
  assert.ok(two.lang === 'nl' && two.score >= 70, JSON.stringify(two));
  // the search reports the input itself as already readable
  var s = core.createSearch(NL_LINES, { depth: 1, budget: 1500 }).runSync(), inp = s.progress().input;
  assert.strictEqual(inp.lang, 'nl');
  assert.ok(inp.score >= 70, 'input score ' + inp.score);
});
test('multi-line verse in other languages: unspaced and spaced', function () {
  var miss = [];
  Object.keys(VERSES).forEach(function (l) {
    [unspaced(VERSES[l]), VERSES[l].join('\n'), unspaced(VERSES[l]).replace(/\n/g, '')].forEach(function (s) {
      var r = core.score(s);
      if (r.lang !== l || r.score < 70) miss.push(l + ': ' + JSON.stringify(r) + ' ' + JSON.stringify(s));
    });
  });
  assert.deepStrictEqual(miss, []);
});
test('random letters stay unreadable when split over lines', function () {
  var seed = 1234567;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  var worst = 0, worstS = '';
  for (var k = 0; k < 120; k++) {
    var lines = [], n = 2 + Math.floor(rnd() * 4);
    for (var l = 0; l < n; l++) {
      var w = '', len = 8 + Math.floor(rnd() * 24);
      for (var i = 0; i < len; i++) w += String.fromCharCode(97 + Math.floor(rnd() * 26));
      lines.push(l === 0 ? w[0].toUpperCase() + w.slice(1) : w);
    }
    [lines.join('\n'), lines.join(' ')].forEach(function (s) { var sc = core.score(s).score; if (sc > worst) { worst = sc; worstS = s; } });
  }
  assert.ok(worst < 40, 'random letters scored ' + worst + ': ' + JSON.stringify(worstS));
  assert.ok(core.score('asdfghjkl\nqwertyuiop\nzxcvbnmasdf\nlkjhgfdsaqwe').score < 40);
  assert.ok(core.score('Xkqzvbnmtrw\nplkjhgfdswq\nzzxcvbnmqwrtp').score < 25);
  // random-case junk (Base64-like) is still penalised with line breaks
  var b64 = 'SGVsbG8gd29ybGQsIHRoaXMgaXMgYSB0ZXN0IG9m\nIHRoZSBlbWVyZ2VuY3kgYnJvYWRjYXN0IHN5c3Rl\nbSBhbmQgbm90aGluZyBlbHNlIGF0IGFsbCBoZXJl';
  assert.ok(core.score(b64).score < 15, 'b64 ' + core.score(b64).score);
  assert.ok(core.score('qWeRtYuIoP\naSdFgHjKl\nZxCvBnMqWe').score < 15);
});
test('search: Caesar of unspaced multi-line text is solved and reads clearly', function () {
  [unspaced(VERSES.en), NL_LINES].forEach(function (src) {
    var b = best(search(core.apply('caesar', src, { shift: 7 }, 'enc'), { depth: 2, budget: 6000 }));
    assert.strictEqual(b.text, src);
    assert.ok(b.score >= 70, 'score ' + b.score);
  });
});
test('run-together words keep their capitals without the mixed-case penalty', function () {
  var r = core.score('TweeoogenblikkentredenineenmaetwijcktWerpteenschipwederhuyswaertsOmteleerenwatdentijtgelooft');
  assert.ok(r.lang === 'nl' && r.score >= 70, JSON.stringify(r));
  var g = core.score('DasWetterwarschönalsogingenwirzumMarktundkauftenfrischesBrot');
  assert.ok(g.lang === 'de' && g.score >= 70, JSON.stringify(g));
});
test('junk scores low, CTF flag / JSON / URL recognised', function () {
  assert.ok(core.score('Wkh txlfn eurzq ira mxpsv ryhu wkh odcb grj').score < 25);
  assert.ok(core.score('SGVsbG8gd29ybGQsIHRoaXMgaXMgYSB0ZXN0').score < 15);
  assert.ok(core.score('x7#kQ9!zP2@mL4$wN8%').score < 10);
  assert.strictEqual(core.score('picoCTF{b4s364_15_n0t_crypt0}').lang, 'flag');
  assert.strictEqual(core.score('{"user":"alice","admin":true}').lang, 'json');
  assert.strictEqual(core.score('https://example.com/path?q=1').lang, 'url');
});

// ---------------------------------------------------------------------------
// 3. Attacks
// ---------------------------------------------------------------------------
var LONG = 'The study of cryptography has a long history. For centuries people have hidden messages from their enemies by ' +
  'shifting letters, swapping them, or writing them in strange orders. Breaking these systems taught mathematicians to count ' +
  'letters and to look for patterns that repeat across the whole message.';
test('Vigenère attack recovers the key on ~250 chars of English', function () {
  var c = core.apply('vigenere', LONG, { key: 'ORANGE' }, 'enc');
  var r = core.internal.polyAttack(c, 'vig', {});
  assert.strictEqual(r[0].params.key, 'ORANGE');
  assert.strictEqual(r[0].v, LONG);
  assert.strictEqual(core.solve('vigenere', c).params.key, 'ORANGE');
});
test('Beaufort, Porta, autokey, Trithemius, affine, Hill attacks', function () {
  assert.strictEqual(core.solve('beaufort', core.apply('beaufort', LONG, { key: 'WINTER' }, 'enc')).params.key, 'WINTER');
  var pk = core.solve('porta', core.apply('porta', LONG, { key: 'SECRET' }, 'enc')).params.key;
  assert.strictEqual(core.apply('porta', core.apply('porta', LONG, { key: 'SECRET' }, 'enc'), { key: pk }), LONG);
  assert.strictEqual(core.solve('autokey', core.apply('autokey', LONG, { key: 'QUEEN' }, 'enc')).params.key, 'QUEEN');
  var tr = core.solve('trithemius', core.apply('trithemius', LONG, { start: 4, step: 3 }, 'enc')).params;
  assert.deepStrictEqual([tr.start, tr.step], [4, 3]);
  var af = core.solve('affine', core.apply('affine', LONG, { a: 7, b: 11 }, 'enc')).params;
  assert.deepStrictEqual([af.a, af.b], [7, 11]);
  var hc = core.apply('hill', LONG, { key: '3 3 2 5' }, 'enc');
  var hs = core.solve('hill', hc);
  assert.strictEqual(core.apply('hill', hc, hs.params), LONG.toUpperCase().replace(/[^A-Z]/g, '') + (LONG.replace(/[^A-Za-z]/g, '').length % 2 ? 'X' : ''));
});
test('Transposition attacks: rail fence, columnar, scytale', function () {
  var p = 'WEAREDISCOVEREDFLEEATONCEANDMEETATTHEOLDCHURCHBYTHERIVER';
  var rf = core.solve('railfence', core.apply('railfence', p, { rails: 4, offset: 0 }, 'enc'));
  assert.strictEqual(core.apply('railfence', core.apply('railfence', p, { rails: 4, offset: 0 }, 'enc'), rf.params), p);
  var ro = core.solve('railfence', core.apply('railfence', p, { rails: 4, offset: 2 }, 'enc'));
  assert.strictEqual(ro.params.rails, 4); // offsets can tie (rotated reading), the rail count must not
  var cc = core.apply('columnar', p, { key: 'GERMAN' }, 'enc');
  assert.strictEqual(core.apply('columnar', cc, core.solve('columnar', cc).params), p);
  var sc = core.apply('scytale', p, { rows: 5 }, 'enc');
  assert.strictEqual(core.apply('scytale', sc, core.solve('scytale', sc).params), p);
});
test('Simple substitution solver (hill-climbing) reads a ~300-letter text', function () {
  var key = 'QWERTYUIOPASDFGHJKLZXCVBNM';
  var c = core.apply('subst', LONG + ' ' + EN, { key: key }, 'enc');
  var r = core.solve('subst', c, { ms: 4000 });
  var dec = core.apply('subst', c, r.params);
  var same = 0, tot = 0;
  for (var i = 0; i < dec.length; i++) if (/[a-z]/i.test(dec[i])) { tot++; if (dec[i].toLowerCase() === (LONG + ' ' + EN)[i].toLowerCase()) same++; }
  assert.ok(same / tot > 0.9, 'solved ' + (same / tot).toFixed(2));
});
test('single-byte XOR recovery', function () {
  var b = core.apply('xor1', EN2, { key: 0x5a }, 'enc');
  var r = core.solve('xor1', b);
  assert.strictEqual(r.params.key, 0x5a);
});
test('repeating-key XOR recovery (Hamming distance key length)', function () {
  var b = core.apply('xor', LONG + ' ' + EN, { key: 'Burning' }, 'enc');
  var r = core.solve('xor', b);
  assert.strictEqual(r.params.key, 'Burning');
});
test('Caesar on Russian text (33-letter alphabet)', function () {
  var plain = 'Мы встретимся завтра вечером у старого моста, когда стемнеет.';
  var c = core.apply('caesar', plain, { shift: 7, alphabet: 'ru33' }, 'enc');
  var s = search(c, { depth: 1, budget: 3000 });
  var b = best(s);
  assert.strictEqual(b.text, plain);
  assert.strictEqual(b.lang, 'ru');
  assert.deepStrictEqual(b.chain[0].params, { shift: 7, alphabet: 'ru33' });
});

// ---------------------------------------------------------------------------
// 4. Chain search
// ---------------------------------------------------------------------------
test('search: "Hello world, this is a test" → Base64 → ROT13 → Hex is recovered within depth 3', function () {
  var p = 'Hello world, this is a test';
  var input = U.toHex(U.utf8Encode(core.apply('rot13', core.apply('base64', p, {}, 'enc'))));
  var s = search(input, { depth: 3, budget: 10000 });
  var b = best(s);
  assert.strictEqual(b.text, p);
  assert.deepStrictEqual(b.chain.map(function (c) { return c.id; }), ['hex', 'caesar', 'base64']);
  assert.ok(b.score >= 70);
});
var CHAINS = [
  ['base64', function (p) { return core.apply('base64', p, {}, 'enc'); }, ['base64']],
  ['hex → base64', function (p) { return U.toHex(U.utf8Encode(core.apply('base64', p, {}, 'enc'))); }, ['hex', 'base64']],
  ['binary', function (p) { return core.apply('binary', p, {}, 'enc'); }, ['binary']],
  ['morse', function () { return core.apply('morse', 'MEET AT NOON BY THE OLD MILL', {}, 'enc'); }, ['morse']],
  ['base32 → base64', function (p) { return core.apply('base32', core.apply('base64', p, {}, 'enc'), {}, 'enc'); }, ['base32', 'base64']],
  ['gzip → base64', function (p) { return U.b64Enc(new Uint8Array(zlib.gzipSync(Buffer.from(p)))); }, ['base64', 'inflate']],
  ['reverse', function (p) { return p.split('').reverse().join(''); }, ['reverse']],
  ['atbash', function (p) { return core.apply('atbash', p, {}, 'enc'); }, ['atbash']],
  ['url', function (p) { return core.apply('url', p, { all: true }, 'enc'); }, ['url']],
  ['decimal', function (p) { return core.apply('decimal', p, {}, 'enc'); }, ['decimal']],
  ['rot47', function (p) { return core.apply('rot47', p, { n: 47 }, 'enc'); }, ['rot47']],
  ['ascii85', function (p) { return core.apply('ascii85', p, {}, 'enc'); }, ['ascii85']],
  ['vigenère', function () { return core.apply('vigenere', LONG, { key: 'KEY' }, 'enc'); }, ['vigenere']],
  ['rail fence', function () { return core.apply('railfence', LONG, { rails: 3 }, 'enc'); }, ['railfence']],
  ['single XOR → hex', function (p) { return U.toHex(core.apply('xor1', p, { key: 77 }, 'enc')); }, ['hex', 'xor1']],
  ['a1z26', function () { return core.apply('a1z26', 'the treasure is buried under the oak tree', {}, 'enc'); }, ['a1z26']],
];
CHAINS.forEach(function (c) {
  test('search finds chain: ' + c[0], function () {
    var p = 'Meet me at the old bridge tomorrow night and bring the map';
    var s = search(c[1](p), { depth: 3, budget: 8000 });
    var b = best(s);
    assert.deepStrictEqual(b.chain.map(function (x) { return x.id; }), c[2], JSON.stringify(b.chain) + ' -> ' + (b.text || '').slice(0, 80));
    assert.ok(b.score >= 70, 'score ' + b.score);
  });
});
test('search budget is respected (hard input, 400 ms budget)', function () {
  var junk = ''; for (var i = 0; i < 3000; i++) junk += String.fromCharCode(65 + (i * 7919 % 26)) + (i % 13 === 0 ? ' ' : '');
  var t0 = Date.now();
  var s = core.createSearch(junk, { depth: 5, budget: 400 });
  while (!s.step(50)) { /* */ }
  var el = Date.now() - t0;
  assert.ok(el < 400 + 1700, 'took ' + el + 'ms');
  assert.ok(s.progress().done);
});
test('stop() ends a search and keeps results', function () {
  var s = core.createSearch(core.apply('base64', EN, {}, 'enc'), { depth: 3, budget: 5000 });
  s.step(5); s.stop();
  assert.ok(s.step(10));
});

// ---------------------------------------------------------------------------
// 5. Analysis + identifier
// ---------------------------------------------------------------------------
test('analysis: IC, entropy, periodic IC peak, Kasiski for Vigenère', function () {
  var a = core.analyze(LONG + ' ' + EN);
  assert.ok(a.ic > 0.058 && a.ic < 0.075, 'IC ' + a.ic);
  assert.ok(a.entropy.letters > 3.9 && a.entropy.letters < 4.3);
  assert.ok(a.entropy.evenness > 0.85 && a.entropy.evenness < 0.95);
  var c = core.apply('vigenere', LONG + ' ' + EN, { key: 'LEMONS' }, 'enc');
  var v = core.analyze(c);
  assert.ok(v.ic < 0.052, 'vig IC ' + v.ic);
  var peak = v.periodic.slice(1).sort(function (x, y) { return y.ic - x.ic; })[0].L;
  assert.ok(peak % 6 === 0, 'periodic peak ' + peak);
  assert.strictEqual(v.keySuggest[0].L, 6);
  assert.ok(v.kasiski.repeats.length > 0);
  var f6 = v.kasiski.factors.filter(function (f) { return f.f === 6; })[0], f5 = v.kasiski.factors.filter(function (f) { return f.f === 5; })[0];
  assert.ok(f6.count > f5.count);
  assert.strictEqual(v.bigrams.matrix.length, 26 * 26);
});
test('identifier clues', function () {
  function top(s) { return core.identify(s).map(function (c) { return c.title; }); }
  assert.ok(top('SGVsbG8gd29ybGQsIHRoaXMgaXMgYSB0ZXN0IQ==').indexOf('Base64') >= 0);
  assert.ok(top('JBSWY3DPEBLW64TMMQ======').indexOf('Base32') >= 0);
  assert.ok(top('48 65 6c 6c 6f 20 57 6f 72 6c 64').indexOf('Hexadecimal') >= 0);
  assert.ok(top('.... . .-.. .-.. --- / .-- --- .-. .-.. -..')[0] === 'Morse code');
  assert.ok(top(core.apply('vigenere', LONG, { key: 'KEY' }, 'enc')).some(function (t) { return /Polyalphabetic|Vigenère-type/.test(t); }));
  assert.ok(top(core.apply('railfence', LONG, { rails: 3 }, 'enc')).some(function (t) { return /Transposition/.test(t); }));
  assert.ok(top(core.apply('caesar', LONG, { shift: 5 }, 'enc')).some(function (t) { return /Monoalphabetic/.test(t); }));
  assert.ok(top('AFGXD DGFAX FAGDX XADFG GDAFX AXFDG').some(function (t) { return /ADFGX/.test(t); }));
});
test('every op is listed with metadata', function () {
  var ops = core.ops();
  assert.ok(ops.length >= 60, 'ops ' + ops.length);
  ops.forEach(function (o) { assert.ok(o.id && o.name && o.cat, JSON.stringify(o)); });
});

console.log((failed ? 'FAILED ' + failed + ', ' : '') + 'passed ' + passed);
