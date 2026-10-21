/* Checks for Beam's QR stream: Base45 (RFC 9285 vectors), CRC32, the frame
 * format and its corruption checks, the fountain code end to end (loss,
 * reordering, duplicates, joining late, edge sizes), decoding overhead, and —
 * when jsQR is at hand (JSQR_PATH, else the copy inlined in shadow.html) —
 * real QR rendering through qr-core.js and back through jsQR.
 * Not loaded by the app. Run: node txt/widgets/beam/beam-qr.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./beam-qr-core.js');
var Q = require('../qr/qr-core.js');

var passed = 0, skipped = [], queue = [];
function test(name, fn) { queue.push([name, fn]); }
function run() {
  var i = 0;
  (function next() {
    if (i >= queue.length) {
      console.log((process.exitCode ? 'FAILED, ' : '') + 'beam-qr: ' + passed + ' passed' + (skipped.length ? ' (skipped: ' + skipped.join('; ') + ')' : ''));
      return;
    }
    var t = queue[i++];
    var done = function () { passed++; next(); };
    var fail = function (e) { console.error('FAIL ' + t[0] + '\n' + (e && e.stack || e)); process.exitCode = 1; next(); };
    try {
      var r = t[1]();
      if (r && typeof r.then === 'function') r.then(done, fail); else done();
    } catch (e) { fail(e); }
  })();
}

function str(b) { return Buffer.from(b).toString('latin1'); }
function bytes(s) { return new Uint8Array(Buffer.from(s, 'latin1')); }
function randomBytes(n, seed) {
  var r = C.prng(seed), out = new Uint8Array(n);
  for (var i = 0; i < n; i += 4) { var v = r(); for (var k = 0; k < 4 && i + k < n; k++) out[i + k] = (v >>> (8 * k)) & 255; }
  return out;
}
function textBytes(n, seed) {
  var words = ['beam', 'note', 'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'QR', 'stream', 'screen', 'camera', '\n'];
  var r = C.prng(seed), s = '';
  while (s.length < n) s += words[r() % words.length] + ' ';
  return new TextEncoder().encode(s.slice(0, n));
}
function eqBytes(a, b, msg) {
  assert.strictEqual(a.length, b.length, (msg || '') + ' length');
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail((msg || '') + ' differs at byte ' + i);
}
var CAP_M = C.capBytesFor('M', Q.maxChars);
var BMAX = (CAP_M - C.HEAD - C.MC_DEFAULT - C.TAIL) & ~3;

// ------------------------------------------------------------------ Base45
test('Base45: RFC 9285 examples', function () {
  assert.strictEqual(C.b45encode(bytes('AB')), 'BB8');
  assert.strictEqual(C.b45encode(bytes('Hello!!')), '%69 VD92EX0');
  assert.strictEqual(C.b45encode(bytes('base-45')), 'UJCLQE7W581');
  assert.strictEqual(str(C.b45decode('QED8WEX0')), 'ietf!');
  assert.strictEqual(str(C.b45decode('BB8')), 'AB');
  assert.strictEqual(C.b45encode(new Uint8Array(0)), '');
  assert.strictEqual(C.b45decode('').length, 0);
});
test('Base45: malformed input is rejected', function () {
  ['GGW', 'A', 'ABCD', '::', 'ab', 'BB8é', 'QED8WEX0\n'].forEach(function (s) {
    assert.throws(function () { C.b45decode(s); }, /base45/, JSON.stringify(s));
  });
  assert.strictEqual(C.b45encode(new Uint8Array([255, 255])), 'FGW');   // 65535 is the largest triple
  eqBytes(C.b45decode('FGW'), [255, 255]);
});
test('Base45: round trips of every length up to 600 and every byte value; size formula', function () {
  for (var n = 0; n <= 600; n += (n < 40 ? 1 : 37)) {
    var b = randomBytes(n, n + 1), s = C.b45encode(b);
    assert.strictEqual(s.length, C.b45len(n));
    assert.ok(/^[0-9A-Z $%*+\-./:]*$/.test(s), 'QR alphanumeric alphabet only');
    eqBytes(C.b45decode(s), b, 'n=' + n);
  }
  var all = new Uint8Array(256); for (var i = 0; i < 256; i++) all[i] = i;
  eqBytes(C.b45decode(C.b45encode(all)), all);
  for (var chars = 0; chars < 50; chars++) {
    var k = C.bytesForChars(chars);
    assert.ok(C.b45len(k) <= chars && C.b45len(k + 1) > chars, 'bytesForChars(' + chars + ')');
  }
  var big = randomBytes(100000, 9);
  eqBytes(C.b45decode(C.b45encode(big)), big, 'long input');
});

// ------------------------------------------------------------------- CRC32
test('CRC32 check values', function () {
  assert.strictEqual(C.crc32(bytes('')), 0);
  assert.strictEqual(C.crc32(bytes('a')), 0xE8B7BE43);
  assert.strictEqual(C.crc32(bytes('123456789')), 0xCBF43926);
  assert.strictEqual(C.crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414FA339);
  assert.strictEqual(C.crc32(bytes('xx123456789yy'), 2, 11), 0xCBF43926, 'sub-range');
  var z = new Uint8Array(32);
  assert.strictEqual(C.crc32(z), 0x190A55AD);
});

// -------------------------------------------------------------------- meta
test('meta record round trips; long names keep their extension', function () {
  var m = { name: 'Fotos – Sommer 🌞.jpeg', mime: 'image/jpeg', size: 123456789, crc: 0xDEADBEEF, compressed: true };
  var s = C.packMeta(m), u = C.unpackMeta(s);
  assert.deepStrictEqual(u, m);
  var long = new Array(300).join('é') + '.txt';
  var u2 = C.unpackMeta(C.packMeta({ name: long, mime: 'text/plain', size: 1, crc: 2 }));
  assert.ok(Buffer.byteLength(u2.name) <= 120 && /é\.txt$/.test(u2.name), u2.name);
  var u3 = C.unpackMeta(C.packMeta({ name: '', mime: '', size: 0, crc: 0 }));
  assert.strictEqual(u3.name, 'file'); assert.strictEqual(u3.mime, 'application/octet-stream');
  assert.ok(C.packMeta({ name: long, mime: long, size: 0, crc: 0 }).length <= 255, 'fits a u8 length');
  assert.throws(function () { C.unpackMeta(new Uint8Array([3, 0, 0, 0])); }, /meta/);
});

// -------------------------------------------------------------- plan/frame
test('block plan: one frame when it fits, else 4-aligned blocks that fill the frame', function () {
  var meta = 40;
  var one = C.plan(10, meta, CAP_M);
  assert.deepStrictEqual(one, { K: 1, B: 12, MC: meta });
  [0, 1, 500, BMAX - 1, BMAX, BMAX + 1, 50000, 500000, 25 * 1024 * 1024].forEach(function (L) {
    var p = C.plan(L, meta, CAP_M);
    assert.strictEqual(p.B % 4, 0);
    assert.ok(p.K * p.B >= L && (p.K - 1) * p.B < Math.max(1, L), 'K blocks hold L=' + L);
    assert.strictEqual(p.K, Math.max(1, Math.ceil(L / p.B)));
    assert.ok(C.HEAD + p.MC + p.B + C.TAIL <= CAP_M, 'frame fits the QR');
  });
  assert.strictEqual(C.plan(BMAX + 1, meta, CAP_M).K, 2);
  assert.throws(function () { C.plan(10, meta, 30); }, /capacity/);
});
test('frames: fields round trip, constant length, symbol x < K is block x', function () {
  var payload = randomBytes(5000, 3), meta = C.packMeta({ name: 'a.bin', mime: 'application/octet-stream', size: 5000, crc: C.crc32(payload) });
  var t = C.makeTransfer(payload, meta, { capBytes: CAP_M, tid: 0xA1B2C3D4 });
  var len = null;
  for (var x = 0; x < t.K + 20; x++) {
    var s = C.frameText(t, x), f = C.parseFrame(s);
    if (len == null) len = s.length; else assert.strictEqual(s.length, len, 'same QR size every frame');
    assert.ok(s.length <= Q.maxChars(22, 'M', 'alnum'));
    assert.strictEqual(f.tid, 0xA1B2C3D4); assert.strictEqual(f.L, 5000); assert.strictEqual(f.B, t.B);
    assert.strictEqual(f.K, t.K); assert.strictEqual(f.x, x); assert.strictEqual(f.MC, 8); assert.strictEqual(f.m, x % t.pieces);
    if (x < t.K) eqBytes(f.data, t.blocks.subarray(x * t.B, (x + 1) * t.B));
  }
  assert.strictEqual(C.parseFrame(C.frameBytes(t, 7)).x, 7, 'bytes in, too');
});
test('frames: any corrupted byte or character, truncation, foreign codes are rejected', function () {
  var t = C.makeTransfer(randomBytes(300, 4), C.packMeta({ name: 'n', mime: 'm', size: 300, crc: 1 }), { capBytes: CAP_M, tid: 5 });
  var f = C.frameBytes(t, 3);
  for (var i = 0; i < f.length; i++) {
    for (var bit = 0; bit < 8; bit += 3) {
      var g = f.slice(); g[i] ^= 1 << bit;
      assert.throws(function () { C.parseFrame(g); }, /crc|magic|length|header/, 'byte ' + i + ' bit ' + bit);
    }
  }
  var s = C.frameText(t, 3), alpha = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  for (i = 0; i < s.length; i += 5) {
    var c = alpha[(alpha.indexOf(s[i]) + 1 + (i % 44)) % 45];
    var bad = s.slice(0, i) + c + s.slice(i + 1);
    assert.throws(function () { C.parseFrame(bad); }, /crc|magic|length|header|base45/, 'char ' + i);
  }
  assert.throws(function () { C.parseFrame(s.slice(0, -3)); });
  assert.throws(function () { C.parseFrame(s.slice(0, -1)); });
  assert.throws(function () { C.parseFrame(s + 'A'); });
  assert.throws(function () { C.parseFrame('HTTPS://EXAMPLE.COM'); });
  assert.throws(function () { C.parseFrame('https://example.com'); }, /base45/);
  assert.throws(function () { C.parseFrame(''); }, /short/);
  // A well-formed frame claiming an absurd payload is refused before any allocation.
  var h = f.slice(); h[5] = 0xFF; h[6] = 0xFF;
  var e = h.length - 4, crc = C.crc32(h, 0, e);
  h[e] = crc >>> 24; h[e + 1] = (crc >>> 16) & 255; h[e + 2] = (crc >>> 8) & 255; h[e + 3] = crc & 255;
  assert.throws(function () { C.parseFrame(h); }, /header/);
});

// ------------------------------------------------------------ fountain/LT
test('LT: deterministic subsets (wire-format golden values) and a valid distribution', function () {
  assert.ok(Math.abs(C.detLn(1000) - Math.log(1000)) < 1e-12 && Math.abs(C.detLn(0.37) - Math.log(0.37)) < 1e-12);
  var r = C.prng(1);
  // Pinned: a change here breaks compatibility between app versions.
  assert.deepStrictEqual([r(), r(), r()], [2243319414, 3892457524, 3774914640]);
  assert.deepStrictEqual(C.ltIndices(1, 99), [0]);
  assert.deepStrictEqual(C.ltIndices(5, 5), [2, 3]);
  assert.deepStrictEqual(C.ltIndices(1000, 1000), [76, 190]);
  assert.deepStrictEqual(C.ltIndices(1000, 1001), [322, 707]);
  assert.deepStrictEqual(C.ltIndices(401, 1234), [381, 340, 187, 241]);
  [401, 2000, 30000].forEach(function (K) {
    var cdf = C.degreeCDF(K);
    assert.strictEqual(cdf.length, K); assert.strictEqual(cdf[K - 1], 1);
    for (var i = 1; i < K; i++) assert.ok(cdf[i] >= cdf[i - 1]);
    assert.ok(cdf[1] - cdf[0] > 0.4, 'degree 2 is the most likely');
    for (var x = K; x < K + 200; x++) {
      var idx = C.ltIndices(K, x), seen = {};
      assert.ok(idx.length >= 1 && idx.length <= K);
      idx.forEach(function (j) { assert.ok(j >= 0 && j < K && !seen[j]); seen[j] = 1; });
    }
  });
  for (var K = 2; K <= 400; K += 57) {
    var tot = 0;
    for (var x = 0; x < 200; x++) tot += C.ltIndices(K, K + x).length;
    assert.ok(Math.abs(tot / 200 - K / 2) < Math.max(2, K * 0.08), 'dense subsets average K/2 for K=' + K);
  }
});

// Push a transfer's frames through a receiver as Base45 text, losing `loss`
// of them, optionally shuffled in a window of 8 or duplicated.
function stream(t, o) {
  var rx = C.createReceiver(), rnd = C.prng(o.seed || 1), u = function () { return rnd() / 4294967296; };
  var x = o.start || 0, sent = 0, max = o.max || (t.K * 12 + 200), win = [], st = null;
  var feed = function (s) { if (!rx.done) st = rx.push(s); };
  while (!rx.done && sent < max) {
    var s = C.frameText(t, x++);
    sent++;
    if (u() < (o.loss || 0)) continue;
    if (o.order === 'shuffle') {
      win.push(s);
      if (win.length >= 8) feed(win.splice(Math.floor(u() * win.length), 1)[0]);
    } else if (o.order === 'dups') {
      feed(s);
      if (u() < 0.5) feed(s);
      if (win.length && u() < 0.3) feed(win[Math.floor(u() * win.length)]);
      win.push(s); if (win.length > 30) win.shift();
    } else feed(s);
  }
  while (win.length && !rx.done && o.order === 'shuffle') feed(win.shift());
  return { rx: rx, sent: sent, last: st };
}
var SIZES = [0, 1, BMAX - 1, BMAX, BMAX + 1, 50 * 1024, 500 * 1024];
var CASES = [];
[0, 0.3, 0.6].forEach(function (loss) {
  ['inorder', 'shuffle', 'dups', 'late'].forEach(function (order) { CASES.push({ loss: loss, order: order }); });
});
SIZES.forEach(function (n, si) {
  test('fountain round trip: ' + n + ' B (random) under 0/30/60% loss, reordered, duplicated, joining late', function () {
    var data = randomBytes(n, 100 + si);
    return C.prepare({ bytes: data, name: 'f' + n + '.bin', mime: 'application/octet-stream' }, { capBytes: CAP_M, tid: 1000 + si }).then(function (t) {
      assert.strictEqual(t.compressed, false, 'random bytes are sent raw');
      var chain = Promise.resolve();
      CASES.forEach(function (c, ci) {
        chain = chain.then(function () {
          var r = stream(t, { loss: c.loss, order: c.order === 'late' ? 'inorder' : c.order, start: c.order === 'late' ? t.K + 37 : 0, seed: 7 + ci * 31 + si });
          var tag = n + 'B ' + c.order + ' loss ' + c.loss;
          assert.ok(r.rx.done, tag + ': not done after ' + r.sent + ' frames (K=' + t.K + ', known ' + r.rx.peeler.known + ')');
          if (c.loss === 0 && c.order === 'inorder') assert.ok(r.sent <= Math.max(t.K, t.pieces), tag + ': systematic pass is enough');
          return r.rx.finish().then(function (res) {
            eqBytes(res.bytes, data, tag);
            assert.strictEqual(res.name, 'f' + n + '.bin'); assert.strictEqual(res.mime, 'application/octet-stream');
          });
        });
      });
      return chain;
    });
  });
});
test('fountain round trip: compressible text (deflate-raw) 200 KB at 30% loss, and density S / L', function () {
  var data = textBytes(200 * 1024, 5);
  var chain = Promise.resolve();
  ['S', 'M', 'L'].forEach(function (d, di) {
    chain = chain.then(function () {
      return C.prepare({ bytes: data, name: 'notes.txt', mime: 'text/plain' }, { capBytes: C.capBytesFor(d, Q.maxChars), tid: 77 + di });
    }).then(function (t) {
      assert.ok(t.compressed && t.L < data.length / 2, 'compressed: ' + t.L);
      var r = stream(t, { loss: 0.3, order: 'shuffle', seed: 3 + di });
      assert.ok(r.rx.done, d + ': done');
      return r.rx.finish();
    }).then(function (res) { eqBytes(res.bytes, data, d); assert.strictEqual(res.name, 'notes.txt'); });
  });
  return chain;
});
test('receiver: a corrupted payload is caught by the CRC32 of the original bytes', function () {
  var data = textBytes(3000, 8);
  return C.prepare({ bytes: data, name: 'x.txt', mime: 'text/plain' }, { capBytes: CAP_M, tid: 9, compress: false }).then(function (t) {
    t.blocks[5] ^= 1;   // the sender's own copy goes bad after the CRC was taken
    var r = stream(t, {});
    assert.ok(r.rx.done);
    return r.rx.finish().then(function () { assert.fail('accepted'); }, function (e) { assert.strictEqual(e.message, 'checksum'); });
  });
});
test('receiver: learns the name within a few frames when joining late; done waits for it', function () {
  var data = randomBytes(40000, 11);
  return C.prepare({ bytes: data, name: 'holiday-photo.jpg', mime: 'image/jpeg' }, { capBytes: CAP_M, tid: 4242 }).then(function (t) {
    var rx = C.createReceiver(), x = 1000, n = 0, st;
    while (!rx.meta) { st = rx.push(C.frameText(t, x++)); n++; }
    assert.ok(n <= t.pieces, 'meta after ' + n + ' frames (' + t.pieces + ' pieces)');
    assert.strictEqual(rx.meta.name, 'holiday-photo.jpg'); assert.strictEqual(rx.meta.size, 40000);
    assert.strictEqual(st.K, t.K);
    // Tiny transfer, one frame, meta included.
    return C.prepare({ bytes: bytes('hi'), name: 'n.txt', mime: 'text/plain' }, { capBytes: CAP_M, tid: 1 });
  }).then(function (t) {
    assert.strictEqual(t.K, 1); assert.strictEqual(t.pieces, 1);
    var rx = C.createReceiver(), st = rx.push(C.frameText(t, 0));
    assert.ok(st.done, 'one frame is the whole transfer');
    // With 1-byte pieces it must wait for all of them even though the block is known.
    var t2 = C.makeTransfer(bytes('hi'), C.packMeta({ name: 'n.txt', mime: 'text/plain', size: 2, crc: C.crc32(bytes('hi')) }), { capBytes: 50, tid: 2 });
    assert.ok(t2.pieces > 1);
    var rx2 = C.createReceiver(), k = 0;
    while (!rx2.done) { rx2.push(C.frameText(t2, k++)); assert.ok(k <= t2.pieces); }
    assert.strictEqual(k, t2.pieces);
    return rx.finish();
  }).then(function (res) { assert.strictEqual(Buffer.from(res.bytes).toString(), 'hi'); });
});
test('receiver: follows a new transfer only after two of its frames; ignores garbage', function () {
  var a = C.makeTransfer(randomBytes(9000, 1), C.packMeta({ name: 'a', mime: 'x', size: 9000, crc: 0 }), { capBytes: CAP_M, tid: 1 });
  var b = C.makeTransfer(randomBytes(3000, 2), C.packMeta({ name: 'b', mime: 'x', size: 3000, crc: 0 }), { capBytes: CAP_M, tid: 2 });
  var rx = C.createReceiver();
  rx.push(C.frameText(a, 0)); rx.push(C.frameText(a, 1));
  assert.strictEqual(rx.tid, 1);
  var st = rx.push(C.frameText(b, 0));
  assert.ok(st.other && rx.tid === 1 && rx.peeler.known === 2, 'one stray frame changes nothing');
  st = rx.push(C.frameText(b, 0));
  assert.ok(st.other && rx.tid === 1, 'the same stray frame again neither');
  st = rx.push(C.frameText(b, 1));
  assert.ok(st.switched && rx.tid === 2 && rx.K === b.K);
  st = rx.push('NOT A BEAM FRAME');
  assert.strictEqual(st.ok, false);
  assert.strictEqual(rx.bad, 1);
});

// ---------------------------------------------------------------- overhead
test('overhead: from LT symbols only (joined after the systematic pass), K ≤ 1.3·K on average', function () {
  [10, 68, 300, 400, 401, 691, 1500].forEach(function (K) {
    var trials = K > 1000 ? 6 : K > 300 ? 12 : 40, tot = 0, data = new Uint8Array(4);
    for (var t = 0; t < trials; t++) {
      var P = C.createPeeler(K, 4), x = K + 1 + t * 7919, n = 0;
      while (!P.complete) { P.add(C.ltIndices(K, x++), data); n++; }
      tot += n;
    }
    var avg = tot / trials;
    assert.ok(avg <= 1.3 * K, 'K=' + K + ' needed ' + (avg / K).toFixed(2) + '·K');
    if (K <= 400) assert.ok(avg <= K + 4, 'dense K=' + K + ' needed ' + avg.toFixed(1));
  });
});
test('overhead: with the systematic pass and 30% loss, ≤ 1.1× the ideal K/(1−p) up to 400 blocks', function () {
  [68, 400].forEach(function (K) {
    var rnd = C.prng(K), tot = 0, data = new Uint8Array(4);
    for (var t = 0; t < 10; t++) {
      var P = C.createPeeler(K, 4), x = 0, sent = 0;
      while (!P.complete) { sent++; if (rnd() / 4294967296 >= 0.3) P.add(x < K ? [x] : C.ltIndices(K, x), data); x++; }
      tot += sent;
    }
    assert.ok(tot / 10 <= 1.1 * K / 0.7, 'K=' + K + ': ' + (tot / 10).toFixed(0) + ' frames');
  });
});
test('peeler: decodes real data; symbols after completion are ignored', function () {
  var K = 450, B = 16, src = randomBytes(K * B, 21), P = C.createPeeler(K, B), x = K;
  var t = { K: K, B: B, blocks: src };
  while (!P.complete) {
    var idx = C.ltIndices(K, x), d = new Uint8Array(B);
    idx.forEach(function (j) { for (var i = 0; i < B; i++) d[i] ^= src[j * B + i]; });
    P.add(idx, d); x++;
  }
  eqBytes(P.buf, t.blocks);
  assert.strictEqual(P.add([0], new Uint8Array(B)), false);
});

// ------------------------------------------------------- real QR + jsQR
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
test('real QR frames: qr-core encodes each preset in ALPHANUMERIC mode and jsQR reads them back', function () {
  var jsQR = loadJsQR();
  if (!jsQR) { skipped.push('jsQR round trip (no jsQR)'); return; }
  var data = randomBytes(30000, 5), chain = Promise.resolve();
  Object.keys(C.DENSITY).forEach(function (d) {
    chain = chain.then(function () {
      return C.prepare({ bytes: data, name: 'r.bin', mime: 'application/octet-stream' }, { capBytes: C.capBytesFor(d, Q.maxChars), tid: 31 });
    }).then(function (t) {
      var D = C.DENSITY[d], rx = C.createReceiver();
      [0, 1, t.K + 5].forEach(function (x) {
        var s = C.frameText(t, x), qr = Q.encode(s, D.ecl);
        assert.strictEqual(qr.mode, 'alnum');
        assert.ok(qr.version <= D.ver && qr.version >= D.ver - 1, d + ': version ' + qr.version);
        var img = rgba(qr, 3, 4), res = jsQR(img.data, img.n, img.n, { inversionAttempts: 'dontInvert' });
        assert.ok(res, d + ': jsQR found the code');
        assert.strictEqual(res.data, s, d + ': text survives');
        assert.ok(rx.push(res.data).ok);
      });
    });
  });
  return chain;
});
test('UMD: module.exports in node, window.__cadeBeamQRCore in a browser', function () {
  var src = fs.readFileSync(path.join(__dirname, 'beam-qr-core.js'), 'utf8');
  var win = {};
  new Function('self', 'module', src).call(win, win, undefined);
  assert.strictEqual(typeof win.__cadeBeamQRCore.createReceiver, 'function');
  assert.strictEqual(typeof global.__cadeBeamQRCore, 'undefined');
});
test('beam-qr.js: exposes mount() and loads its parts next to itself', function () {
  var src = fs.readFileSync(path.join(__dirname, 'beam-qr.js'), 'utf8');
  var win = { Cade: {} }, doc = { currentScript: { src: 'https://x.test/txt/widgets/beam/beam-qr.js?v=2' } };
  new Function('window', 'document', 'navigator', src)(win, doc, {});
  assert.strictEqual(typeof win.__cadeBeamQR.mount, 'function');
  assert.strictEqual(typeof win.__cadeBeamQR._debugFeed, 'function');
  assert.strictEqual(win.__cadeBeamQR._base, 'https://x.test/txt/widgets/beam/');
  ['beam-qr-core.js', "'../qr/qr-core.js'", 'beam-qr.css'].forEach(function (f) { assert.ok(src.indexOf(f) >= 0, f); });
  assert.ok(src.indexOf('https://') < 0 || /https:\/\/(?!cdn\.jsdelivr\.net\/npm\/jsqr@1\.4\.0)/.test(src) === false, 'no other network URLs');
});

run();
