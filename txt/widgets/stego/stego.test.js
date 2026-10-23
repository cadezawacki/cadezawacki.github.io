/* Checks for Steganography: header encode/decode, LSB embed/extract round
 * trips on synthetic pixel buffers (sequential, scattered, stealth, seeded
 * permutation determinism + bijection), encryption round trip and wrong
 * password, capacity maths, zero-width round trip, PNG chunk / appended-data
 * parsing, the LSB scorer finding a planted message, and that the widget
 * registers as the manifest entry says. Not loaded by the app.
 * Run: node txt/widgets/stego/stego.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var SC = require('./stego-core.js');
var passed = 0;
function test(name, fn) { try { var r = fn(); if (r && r.then) return r.then(function () { passed++; }, function (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

function rgba(w, h, fn) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var p = (y * w + x) * 4, c = fn ? fn(x, y) : [128, 128, 128, 255];
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c.length > 3 ? c[3] : 255;
  }
  return d;
}
function noise(w, h, seed) {
  var s = seed || 7;
  return rgba(w, h, function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; var r = s >>> 24, g = (s >>> 16) & 255, b = (s >>> 8) & 255; return [r, g, b, 255]; });
}

var tests = [];
function T(name, fn) { tests.push([name, fn]); }

// ---- header ----
T('header round trips, rejects bad magic', function () {
  var h = SC.encodeHeader(SC.F_ENC | SC.F_COMP, 1234, 0xDEADBEEF);
  var d = SC.decodeHeader(h);
  assert.strictEqual(d.version, SC.VERSION);
  assert.strictEqual(d.length, 1234);
  assert.strictEqual(d.crc, 0xDEADBEEF);
  assert.ok(d.encrypted && d.compressed && !d.scattered);
  var bad = h.slice(); bad[0] = 0; assert.strictEqual(SC.decodeHeader(bad), null);
  assert.strictEqual(SC.decodeHeader(new Uint8Array(3)), null);
});

// ---- capacity maths ----
T('capacity maths and minSizeFor', function () {
  assert.strictEqual(SC.slotCount(10, 10), 300);
  assert.strictEqual(SC.capacity(10, 10), Math.floor((300 - 112) / 8));
  assert.strictEqual(SC.capacity(4, 4), Math.floor((48 - 112) / 8) < 0 ? 0 : SC.capacity(4, 4));
  assert.ok(SC.capacity(4, 4) === 0, 'tiny image holds nothing');
  assert.strictEqual(SC.payloadSize(100, true), 100 + 16 + 12 + 16);
  var sz = SC.minSizeFor(500, 1);
  assert.ok(SC.capacity(sz.w, sz.h) >= 500, 'minSizeFor fits');
  assert.ok(SC.capacity(sz.w - 1, sz.h - 1) < 500 || (sz.w <= 1), 'minSizeFor is near-minimal');
});

// ---- permutation: bijection + determinism ----
T('keyed permutation is a bijection and deterministic', function () {
  var n = 1000, seed = [1, 2, 3, 4], p1 = SC.makePerm(n, seed), p2 = SC.makePerm(n, seed);
  var seen = new Uint8Array(n), ok = true;
  for (var i = 0; i < n; i++) {
    var v = p1.map(i);
    assert.ok(v >= 0 && v < n, 'in range ' + v);
    assert.strictEqual(v, p2.map(i), 'deterministic at ' + i);
    if (seen[v]) ok = false; seen[v] = 1;
  }
  assert.ok(ok, 'no collisions — bijection');
  var p3 = SC.makePerm(n, [9, 9, 9, 9]), diff = 0;
  for (i = 0; i < n; i++) if (p1.map(i) !== p3.map(i)) diff++;
  assert.ok(diff > n * 0.8, 'different seed → different order');
});

// ---- embed / extract: sequential (no password) ----
T('embed + extract round trip, sequential plain', function () {
  var w = 64, h = 64, px = noise(w, h, 3);
  var text = 'The quick brown fox jumps over 13 lazy dogs. ∑≈π';
  return SC.hide(px, w, h, text, null, { compress: false }).then(function (info) {
    assert.ok(!(info.flags & SC.F_ENC) && !(info.flags & SC.F_SCATTER));
    return SC.reveal(px, w, h, null);
  }).then(function (r) { assert.strictEqual(r.text, text); assert.ok(r.ok); });
});

// ---- compression path ----
T('compressible text uses the COMP flag and round trips', function () {
  var w = 96, h = 96, px = noise(w, h, 11);
  var text = new Array(80).join('repeat ');
  return SC.hide(px, w, h, text, null).then(function (info) {
    assert.ok(info.flags & SC.F_COMP, 'compressed');
    return SC.reveal(px, w, h, null);
  }).then(function (r) { assert.strictEqual(r.text, text); });
});

// ---- encrypted + scattered flags set ----
T('encrypted hide sets ENC + SCATTER flags, payload is scattered', function () {
  var w = 128, h = 128, px = noise(w, h, 5);
  return SC.hide(px, w, h, 'secret: meet at the pier at dawn', 'hunter2').then(function (info) {
    assert.ok((info.flags & SC.F_ENC) && (info.flags & SC.F_SCATTER));
  });
});

// ---- full encrypted round trip (default iters) + wrong password + prompt ----
T('encrypted round trip + wrong password + no-password prompt', function () {
  var w = 128, h = 128, px = noise(w, h, 17);
  var text = 'top secret payload 🕵️';
  return SC.hide(px, w, h, text, 'correct horse').then(function () {
    return SC.reveal(px, w, h, 'correct horse');
  }).then(function (r) {
    assert.strictEqual(r.text, text);
    return SC.reveal(px, w, h, 'wrong').then(function () { throw new Error('should have rejected'); }, function (e) { assert.strictEqual(e.code, 'wrong-password'); });
  }).then(function () {
    return SC.reveal(px, w, h, null).then(function () { throw new Error('should need password'); }, function (e) { assert.strictEqual(e.code, 'need-password'); });
  });
});

// ---- no message present ----
T('reveal on a clean image reports none', function () {
  var px = noise(32, 32, 99);
  return SC.reveal(px, 32, 32, null).then(function () { throw new Error('should be none'); }, function (e) { assert.strictEqual(e.code, 'none'); });
});

// ---- too big ----
T('embed refuses an over-capacity message', function () {
  var w = 16, h = 16, px = noise(w, h, 1);
  var big = new Uint8Array(SC.capacity(w, h) + 50);
  assert.throws(function () { SC.embed(px, w, h, big, 0, null); }, function (e) { return e.code === 'too-big'; });
});

// ---- encryption primitive round trip ----
T('seal/unseal round trip, wrong password fails tag', function () {
  var data = SC.utf8('message bytes');
  return SC.seal(data, 'pw', 1000).then(function (sealed) {
    assert.ok(sealed.length >= data.length + 16 + 12 + 16);
    return SC.unseal(sealed, 'pw', 1000).then(function (out) {
      assert.strictEqual(SC.fromUtf8(out), 'message bytes');
      return SC.unseal(sealed, 'nope', 1000).then(function () { throw new Error('tag should fail'); }, function (e) { assert.strictEqual(e.code, 'wrong-password'); });
    });
  });
});

// ---- zero-width round trip ----
T('zero-width encode/decode round trip and strip', function () {
  var carrier = 'This looks like an ordinary note.';
  var secret = 'hidden 🙈 msg';
  var combined = SC.zwEncode(carrier, secret);
  assert.ok(SC.zwHas(combined));
  assert.ok(!SC.zwHas(carrier));
  assert.strictEqual(SC.zwDecode(combined), secret);
  assert.strictEqual(SC.zwStrip(combined), carrier);
  assert.strictEqual(SC.zwDecode('nothing here'), null);
});

// ---- PNG encode then chunk parse + capacity preserved ----
T('PNG encode is lossless for LSBs and chunk parse finds IEND', function () {
  var w = 40, h = 30, px = noise(w, h, 23);
  var text = 'lossless check';
  return SC.hide(px, w, h, text, null, { compress: false }).then(function () {
    return SC.encodePNG(px, w, h);
  }).then(function (png) {
    assert.ok(SC.isPNG(png));
    var info = SC.parsePNGChunks(png);
    assert.ok(info.chunks.some(function (c) { return c.type === 'IHDR'; }));
    assert.ok(info.chunks.some(function (c) { return c.type === 'IDAT'; }));
    assert.strictEqual(info.iendEnd, png.length, 'IEND ends the file');
    // decode back and confirm the message survives
    return SC.inflate(png.subarray(infoIdat(png).ds, infoIdat(png).de)).then(function (raw) {
      var out = unfilter(raw, w, h);
      return SC.reveal(out, w, h, null).then(function (r) { assert.strictEqual(r.text, text); });
    });
  });
  function infoIdat(png) { var info = SC.parsePNGChunks(png); var c = info.chunks.filter(function (x) { return x.type === 'IDAT'; })[0]; return { ds: c.offset + 8, de: c.offset + 8 + c.length }; }
  function unfilter(raw, w, h) {
    var stride = w * 4, out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) out.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
    return out;
  }
});

// ---- appended data after IEND ----
T('appended data after PNG IEND is detected', function () {
  var w = 20, h = 20, px = noise(w, h, 2);
  return SC.encodePNG(px, w, h).then(function (png) {
    var secret = SC.utf8('FLAG{appended_data_here}');
    var combined = SC.concat(png, secret);
    var app = SC.appendedData(combined);
    assert.ok(app, 'found appended data');
    assert.strictEqual(app.kind, 'PNG');
    assert.strictEqual(app.length, secret.length);
    assert.strictEqual(SC.fromUtf8(app.bytes), 'FLAG{appended_data_here}');
    assert.strictEqual(SC.appendedData(png), null, 'none on a clean PNG');
  });
});

// ---- strings pass ----
T('strings pass finds printable runs', function () {
  var b = SC.concat(new Uint8Array([0, 1, 2]), SC.utf8('findme'), new Uint8Array([0, 0]), SC.utf8('and this too'));
  var runs = SC.strings(b, 4);
  var texts = runs.map(function (r) { return r.text; });
  assert.ok(texts.indexOf('findme') >= 0 && texts.indexOf('and this too') >= 0);
});

// ---- generic LSB scorer finds a planted message ----
T('LSB scorer / auto-try ranks a planted message first', function () {
  var w = 64, h = 64, px = noise(w, h, 31);
  // plant readable ASCII in the R channel LSB, row order, bit 0 — long enough
  // to fill the scanned window (short runs in a big image dilute the score)
  var line = 'this is clearly english text planted in the lsb plane of the red channel. ';
  var msg = SC.utf8(new Array(5).join(line));
  var bitIdx = 0;
  for (var i = 0; i < msg.length; i++) for (var bit = 7; bit >= 0; bit--) {
    var p = bitIdx * 4;   // R channel of consecutive pixels (channels [0] means one per pixel)
    px[p] = (px[p] & 0xFE) | ((msg[i] >>> bit) & 1);
    bitIdx++;
  }
  var combos = SC.lsbAutoTry(px, w, h, 256);
  var top = combos[0];
  assert.ok(top.channels.length === 1 && top.channels[0] === 0, 'top combo is R-only: ' + top.label);
  assert.strictEqual(top.bit, 0);
  assert.strictEqual(top.order, 'row');
  assert.ok(top.score > 0.7, 'high text score ' + top.score);
  assert.ok(top.sample.indexOf('this is clearly') >= 0, 'sample shows the message: ' + top.sample);
});

// ---- bit plane + histogram ----
T('bit plane and histogram basics', function () {
  var w = 4, h = 1, px = new Uint8ClampedArray([1, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]);
  var plane = SC.bitPlane(px, w, h, 0, 0);
  assert.strictEqual(plane[0], 255);  // pixel 0 R lsb = 1
  assert.strictEqual(plane[4], 0);
  var hist = SC.histogram(px, w, h, 0);
  assert.strictEqual(hist[0], 2);
  assert.strictEqual(hist[1], 1);
  assert.strictEqual(hist[255], 1);
  var px0 = SC.pixelAt(px, w, 2, 0); assert.strictEqual(px0.r, 255);
});

// ---- generated cover ----
T('makeCover is deterministic and full alpha', function () {
  var a = SC.makeCover(32, 32, 'linear', 42), b = SC.makeCover(32, 32, 'linear', 42);
  assert.deepStrictEqual(Array.from(a.subarray(0, 40)), Array.from(b.subarray(0, 40)));
  for (var i = 3; i < a.length; i += 4) assert.strictEqual(a[i], 255);
});

// ---- registration matches the proposed manifest entry ----
var WIDGET_ENTRY = {
  id: 'stego', type: 'widget', name: 'Steganography',
  description: 'Hide a secret message inside an image (invisible LSB, optional AES-GCM password) or inside ordinary text — and analyse any image to find data hidden in it',
  icon: '🕵',
  tags: 'steganography,stego,hide,secret,message,image,photo,lsb,least significant bit,encrypt,password,aes,zero-width,invisible,ctf,reveal,extract,decode,bit plane,exif,strings,watermark',
  entry: 'widgets/stego/stego.js', css: 'widgets/stego/stego.css', precache: ['widgets/stego/stego-core.js']
};
function manifestEntry(id) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules.filter(function (m) { return m.id === id; })[0] || null; } catch (e) { return null; }
}
T('widget registers with the manifest entry name/description/icon/tags', function () {
  var entries = [WIDGET_ENTRY], live = manifestEntry('stego');
  if (live) entries.push(live);
  var reg = null;
  var src = fs.readFileSync(path.join(__dirname, 'stego.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: { loadCSS: function () {}, baseURL: function () { return './txt/widgets/stego/'; }, registerWidget: function (o) { reg = o; }, escapeHtml: String } }, undefined);
  assert.ok(reg, 'registered');
  entries.forEach(function (entry) {
    ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], entry[k], k); });
    assert.strictEqual(entry.entry, 'widgets/stego/stego.js');
    assert.strictEqual(entry.css, 'widgets/stego/stego.css');
  });
});

// run (serially, since several are async)
(function next(i) {
  if (i >= tests.length) { console.log('stego: ' + passed + ' passed'); return; }
  var r = test(tests[i][0], tests[i][1]);
  if (r && r.then) r.then(function () { next(i + 1); }); else next(i + 1);
})(0);
