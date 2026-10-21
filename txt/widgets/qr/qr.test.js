/* Checks for the QR encoder in qr-core.js (shared by the QR Code widget and
 * Beam's QR stream): capacity table, version/size, format and version info
 * bits, mode choice, and — when jsQR is at hand (JSQR_PATH, else the copy
 * inlined in shadow.html) — decoding what it draws across versions and ECC
 * levels. Also that qr.js registers as the manifest says and takes its
 * encoder from qr-core.js.
 * Not loaded by the app. Run: node txt/widgets/qr/qr.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var Q = require('./qr-core.js');
var passed = 0, skipped = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

// The manifest entry, with the precache line this change needs.
var ENTRY = {
  id: 'qr', type: 'widget', name: 'QR Code',
  description: 'Make QR codes (text, URL, Wi-Fi, contact…) — insert, copy or save; scan with the camera or from an image',
  entry: 'widgets/qr/qr.js', css: 'widgets/qr/qr.css', precache: ['widgets/qr/qr-core.js']
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}

test('capacity table matches ISO/IEC 18004', function () {
  [[1, 'L', 'num', 41], [1, 'M', 'alnum', 20], [1, 'H', 'alnum', 10], [1, 'Q', 'byte', 11], [10, 'M', 'byte', 213],
   [22, 'M', 'alnum', 1134], [40, 'L', 'num', 7089], [40, 'L', 'alnum', 4296], [40, 'L', 'byte', 2953], [40, 'H', 'byte', 1273]]
    .forEach(function (c) { assert.strictEqual(Q.maxChars(c[0], c[1], c[2]), c[3], c.join(' ')); });
});
test('version, size and the smallest version that fits', function () {
  for (var v = 1; v <= 40; v++) {
    var n = Q.maxChars(v, 'M', 'alnum'), s = new Array(n + 1).join('A');
    var qr = Q.encode(s, 'M');
    assert.strictEqual(qr.version, v, 'full v' + v);
    assert.strictEqual(qr.size, 4 * v + 17);
    assert.strictEqual(qr.modules.length, qr.size); assert.strictEqual(qr.modules[0].length, qr.size);
    if (v < 40) assert.strictEqual(Q.encode(s + 'A', 'M').version, v + 1, 'one more spills over');
  }
  assert.strictEqual(Q.encode('HI', 'L', { minVersion: 7 }).version, 7);
  assert.throws(function () { Q.encode(new Array(2955).join('x'), 'L'); }, /too long/);
});
test('modes: numeric, alphanumeric, byte (UTF-8)', function () {
  assert.strictEqual(Q.encode('0123456789', 'M').mode, 'num');
  assert.strictEqual(Q.encode('HELLO WORLD $%*+-./:', 'M').mode, 'alnum');
  var b = Q.encode('héllo', 'M');
  assert.strictEqual(b.mode, 'byte'); assert.strictEqual(b.bytes, 6);
});
test('format and version information bits', function () {
  assert.strictEqual(Q.formatWord(1, 0), parseInt('101010000010010', 2), 'M, mask 0');
  assert.strictEqual(Q.formatWord(0, 0), parseInt('111011111000100', 2), 'L, mask 0');
  assert.strictEqual(Q.formatWord(3, 7), parseInt('000100000111011', 2), 'H, mask 7');
  assert.strictEqual(Q.versionWord(7), 0x07C94);
  assert.strictEqual(Q.versionWord(8), 0x085BC);
  assert.strictEqual(Q.versionWord(40), 0x28C69);
  // Read both copies of the format word back out of real symbols.
  [['HELLO', 'L'], ['https://example.com/x', 'M'], ['12345', 'Q'], ['ÜBER', 'H']].forEach(function (c) {
    for (var mask = 0; mask < 8; mask++) {
      var qr = Q.encode(c[0], c[1], { mask: mask }), m = qr.modules, n = qr.size, a = 0, b = 0, i;
      var bit = function (x, y) { return m[y][x] ? 1 : 0; };
      for (i = 0; i <= 5; i++) a |= bit(8, i) << i;
      a |= bit(8, 7) << 6; a |= bit(8, 8) << 7; a |= bit(7, 8) << 8;
      for (i = 9; i < 15; i++) a |= bit(14 - i, 8) << i;
      for (i = 0; i < 8; i++) b |= bit(n - 1 - i, 8) << i;
      for (i = 8; i < 15; i++) b |= bit(8, n - 15 + i) << i;
      var want = Q.formatWord(Q.ECL_INDEX[c[1]], mask);
      assert.strictEqual(a, want, c + ' mask ' + mask); assert.strictEqual(b, want);
      assert.strictEqual(qr.mask, mask);
      assert.ok(m[n - 8][8], 'dark module');
    }
  });
  var big = Q.encode(new Array(400).join('Z'), 'M'), vw = 0;
  for (var k = 0; k < 18; k++) vw |= (big.modules[Math.floor(k / 3)][big.size - 11 + k % 3] ? 1 : 0) << k;
  assert.strictEqual(vw, Q.versionWord(big.version));
});
test('finder patterns and timing lines', function () {
  var qr = Q.encode('FINDER', 'M'), m = qr.modules, n = qr.size;
  [[0, 0], [n - 7, 0], [0, n - 7]].forEach(function (o) {
    for (var y = 0; y < 7; y++) for (var x = 0; x < 7; x++) {
      var d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      assert.strictEqual(m[o[1] + y][o[0] + x], d !== 2, 'finder at ' + o);
    }
  });
  for (var i = 8; i < n - 8; i++) { assert.strictEqual(m[6][i], i % 2 === 0); assert.strictEqual(m[i][6], i % 2 === 0); }
});

function loadJsQR() {
  try {
    var code = null, p = process.env.JSQR_PATH;
    if (p && fs.existsSync(p)) code = fs.readFileSync(p, 'utf8');
    else {
      var html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shadow.html'), 'utf8');
      var i = html.indexOf('// jsQR v1.4.0'), s = i < 0 ? -1 : html.indexOf('!function(o,e){', i);
      if (s < 0) return null;
      code = html.slice(s, html.indexOf('</script>', s));
    }
    var m = { exports: {} };
    new Function('module', 'exports', code)(m, m.exports);
    return typeof m.exports === 'function' ? m.exports : m.exports.default;
  } catch (e) { return null; }
}
function rgba(qr, scale, margin) {
  var n = (qr.size + 2 * margin) * scale, px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) {
    if (!qr.modules[y][x]) continue;
    for (var dy = 0; dy < scale; dy++) for (var dx = 0; dx < scale; dx++) {
      var o = (((y + margin) * scale + dy) * n + (x + margin) * scale + dx) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return { data: px, n: n };
}
test('jsQR reads back what the encoder draws (every version at M; every ECC level at v1/7/22/40; all three modes)', function () {
  var jsQR = loadJsQR();
  if (!jsQR) { skipped.push('jsQR round trip (no jsQR)'); return; }
  var cases = [];
  for (var v = 1; v <= 40; v++) cases.push([v, 'M']);
  [1, 7, 22, 40].forEach(function (v) { ['L', 'Q', 'H'].forEach(function (e) { cases.push([v, e]); }); });
  cases.forEach(function (c, i) {
    var mode = ['alnum', 'byte', 'num'][i % 3], n = Q.maxChars(c[0], c[1], mode), s = '';
    var src = mode === 'num' ? '0123456789' : mode === 'alnum' ? 'BEAM 45 $%*+-./:QR' : 'grüße, ✓ héllo ';
    while (s.length < n) s += src;
    s = s.slice(0, n);
    if (mode === 'byte') while (Buffer.byteLength(s) > n) s = s.slice(0, -1);
    var qr = Q.encode(s, c[1], { minVersion: c[0] });
    assert.strictEqual(qr.version, c[0], 'version ' + c);
    var img = rgba(qr, 2, 4), r = jsQR(img.data, img.n, img.n, { inversionAttempts: 'dontInvert' });
    assert.ok(r, 'decoded v' + c[0] + ' ' + c[1] + ' ' + mode);
    assert.strictEqual(r.data, s, 'v' + c[0] + ' ' + c[1] + ' ' + mode);
    assert.strictEqual(r.version, c[0]);
  });
});
test('qr.js registers as the manifest says and takes the encoder from qr-core.js', function () {
  var live = manifestEntry('qr'), reg = null, css = [];
  var src = fs.readFileSync(path.join(__dirname, 'qr.js'), 'utf8');
  new Function('window', src)({ Cade: { loadCSS: function (p) { css.push(p); }, baseURL: function () { return './txt/widgets/qr/'; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } });
  assert.ok(reg && typeof reg.open === 'function');
  [ENTRY].concat(live ? [live] : []).forEach(function (e) {
    ['name', 'description'].forEach(function (k) { assert.strictEqual(reg[k], e[k], k); });
    assert.strictEqual(e.entry, 'widgets/qr/qr.js'); assert.strictEqual(e.css, 'widgets/qr/qr.css');
  });
  if (live) { assert.strictEqual(reg.icon, live.icon); assert.strictEqual(reg.tags, live.tags); }
  assert.deepStrictEqual(css, ['qr.css']);
  ENTRY.precache.forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f); });
  assert.ok(src.indexOf("BASE + 'qr-core.js'") >= 0, 'loads qr-core.js next to itself');
  assert.ok(!/function (encode|penalty|rsRemainder)\(/.test(src), 'no second copy of the encoder');
  assert.ok(src.indexOf('cdn.jsdelivr') < 0, 'the decoder URL lives in qr-core.js only');
  assert.throws(function () { reg._encode('X', 'M'); }, /not loaded/);
});
test('UMD: module.exports in node, window.__cadeQRCore in a browser', function () {
  var src = fs.readFileSync(path.join(__dirname, 'qr-core.js'), 'utf8'), win = {};
  new Function('self', 'module', src).call(win, win, undefined);
  assert.strictEqual(typeof win.__cadeQRCore.encode, 'function');
  assert.strictEqual(Q.JSQR_URL, 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
});

console.log((process.exitCode ? 'FAILED, ' : '') + 'qr: ' + passed + ' passed' + (skipped.length ? ' (skipped: ' + skipped.join('; ') + ')' : ''));
