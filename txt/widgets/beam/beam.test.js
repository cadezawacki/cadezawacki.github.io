/* Checks for Beam: CRC32, frames and chunk/offset math, the sender's cursor and
 * the receiver's overlap rule (resume after a fallback), manifest validation,
 * name sanitising, speed/ETA smoothing, inbox expiry, and the widget / plugin
 * registration. Not loaded by the app. Run: node txt/widgets/beam/beam.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path'), zlib = require('zlib');
var K = require('./beam-core.js');
var passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }
function bytes(s) { return new Uint8Array(Buffer.from(s, 'utf8')); }
function rnd(n, seed) { var a = new Uint8Array(n), x = seed || 1; for (var i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; }

// The manifest entries this module asks for (txt/manifest.json doesn't list them yet).
var MANIFEST = [
  {
    id: 'beam', type: 'widget', name: 'Beam',
    description: 'Send files straight to your other devices — direct over Wi-Fi, nothing stored in the cloud, no size limit — or as a QR stream with no network at all',
    icon: '📡',
    tags: 'beam,send,share,transfer,airdrop,nearby,files,file,photo,devices,phone,laptop,ipad,wifi,p2p,peer,qr,qr stream,inbox,multi-device',
    entry: 'widgets/beam/beam.js', css: 'widgets/beam/beam.css',
    precache: ['widgets/beam/beam-link.js', 'widgets/beam/beam-core.js', 'widgets/beam/beam-qr.js', 'widgets/beam/beam-qr-core.js', 'widgets/beam/beam-qr.css', 'widgets/qr/qr-core.js'],
    fileMenu: [{ label: '📡 Beam to another device', kind: 'beam' }, { label: '▦ Send as a QR stream', kind: 'beam-qr' }]
  },
  {
    id: 'beam-recv', type: 'plugin', name: 'Receive files from my other devices',
    description: 'While this screen is open, Beam on your other devices (same Sync) can send files straight to it — accepted automatically and kept in Beam’s Inbox for 7 days. Uses nothing while the page is hidden',
    entry: 'widgets/beam/beam-recv.js',
    precache: ['widgets/beam/beam-core.js', 'widgets/beam/beam-link.js', 'widgets/beam/beam.css'],
    settingKey: 'plugins.beam-recv', section: 'Devices', default: true
  }
];

test('CRC32 test vectors', function () {
  assert.strictEqual(K.crc32(bytes('')), 0);
  assert.strictEqual(K.crc32(bytes('123456789')), 0xCBF43926);
  assert.strictEqual(K.crc32(bytes('a')), 0xE8B7BE43);
  assert.strictEqual(K.crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414FA339);
  assert.strictEqual(K.crcHex(0xCBF43926), 'cbf43926');
  assert.strictEqual(K.crcHex(0x1), '00000001');
});
test('CRC32 is incremental and matches zlib on random data', function () {
  var d = rnd(70000, 7), whole = K.crc32(d);
  if (typeof zlib.crc32 === 'function') assert.strictEqual(whole, zlib.crc32(Buffer.from(d)));
  [0, 1, 3, 4096, 65535, 69999, 70000].forEach(function (cut) {
    assert.strictEqual(K.crc32(d.subarray(cut), K.crc32(d.subarray(0, cut))), whole, 'split at ' + cut);
  });
  var c = 0;
  for (var i = 0; i < d.length; i += 777) c = K.crc32(d.subarray(i, i + 777), c);
  assert.strictEqual(c, whole);
});
test('crcAdvance counts re-sent bytes once (resume after a fallback)', function () {
  var d = rnd(10000, 3), st = { pos: 0, crc: 0 };
  K.crcAdvance(st, 0, d.subarray(0, 6000));
  K.crcAdvance(st, 4000, d.subarray(4000, 8000));       // relay resumes from an earlier ack
  K.crcAdvance(st, 5000, d.subarray(5000, 6000));       // wholly old
  K.crcAdvance(st, 8000, d.subarray(8000));
  assert.strictEqual(st.pos, 10000);
  assert.strictEqual(st.crc, K.crc32(d));
  assert.strictEqual(K.crcAdvance({ pos: 10, crc: 0 }, 20, d.subarray(0, 5)), false, 'a gap is refused');
});
test('message size follows the peer’s sctp.maxMessageSize, capped at 64 KB', function () {
  assert.strictEqual(K.msgSize(undefined), 65536);
  assert.strictEqual(K.msgSize(null), 65536);
  assert.strictEqual(K.msgSize(262144), 65536);
  assert.strictEqual(K.msgSize(1073741823), 65536);
  assert.strictEqual(K.msgSize(16384), 16384);
  assert.strictEqual(K.msgSize(0), 65536, 'unknown → 64 KB');
  assert.ok(K.msgSize(100) > K.C.HDR, 'always room for data');
});
test('frames: header round trip, offsets beyond 4 GB, junk refused', function () {
  var d = rnd(300, 9);
  [[0, 0], [3, 65520], [7, 5 * 1024 * 1024 * 1024 + 17]].forEach(function (c) {
    var fr = K.encodeFrame(c[0], c[1], d), back = K.decodeFrame(fr.buffer);
    assert.strictEqual(fr.length, K.C.HDR + d.length);
    assert.strictEqual(back.f, c[0]); assert.strictEqual(back.o, c[1]);
    assert.deepStrictEqual(Array.from(back.data), Array.from(d));
  });
  assert.strictEqual(K.decodeFrame(new Uint8Array(10)), null);
  assert.strictEqual(K.decodeFrame(new Uint8Array(40)), null, 'no magic');
  var empty = K.decodeFrame(K.encodeFrame(1, 2, new Uint8Array(0)));
  assert.strictEqual(empty.data.length, 0);
});
test('offsets: global position ↔ (file, offset)', function () {
  var sizes = [10, 0, 5, 100];
  assert.strictEqual(K.offsetOf(sizes, 0, 0), 0);
  assert.strictEqual(K.offsetOf(sizes, 2, 3), 13);
  assert.strictEqual(K.offsetOf(sizes, 3, 0), 15);
  assert.strictEqual(K.offsetOf(sizes, 4, 0), 115);
  assert.deepStrictEqual(K.posOf(sizes, 13), { f: 2, o: 3 });
  assert.deepStrictEqual(K.posOf(sizes, 10), { f: 2, o: 0 }, 'an empty file is skipped');
  assert.deepStrictEqual(K.posOf(sizes, 115), { f: 4, o: 0 });
});
test('cursor: chunks, a fin after each file (empty ones too), then end; resumes mid-file', function () {
  var sizes = [5, 0, 130000], c = K.cursor(sizes), steps = [];
  for (var s = c.next(65536); s.k !== 'end'; s = c.next(65536)) steps.push(s.k === 'chunk' ? s.f + ':' + s.o + '+' + s.len : 'fin' + s.f);
  assert.deepStrictEqual(steps, ['0:0+5', 'fin0', 'fin1', '2:0+65536', '2:65536+64464', 'fin2']);
  assert.strictEqual(c.next(65536).k, 'end', 'end stays end');
  var r = K.cursor(sizes, 2, 100000);
  assert.deepStrictEqual(r.next(131072), { k: 'chunk', f: 2, o: 100000, len: 30000 });
  assert.deepStrictEqual(r.next(131072), { k: 'fin', f: 2 });
  assert.deepStrictEqual(K.cursor(sizes, 2, 130000).next(10), { k: 'fin', f: 2 }, 'resume at a file’s end → its fin');
  // every byte exactly once
  var big = [1000003, 1], total = 0, cc = K.cursor(big);
  for (var t = cc.next(65520); t.k !== 'end'; t = cc.next(65520)) if (t.k === 'chunk') total += t.len;
  assert.strictEqual(total, 1000004);
});
test('overlap: the receiver keeps new bytes only, refuses gaps', function () {
  assert.deepStrictEqual(K.overlap(0, 0, 100), { take: 0, gap: false });
  assert.deepStrictEqual(K.overlap(100, 100, 50), { take: 0, gap: false });
  assert.deepStrictEqual(K.overlap(120, 100, 50), { take: 20, gap: false });
  assert.deepStrictEqual(K.overlap(150, 100, 50), { take: -1, gap: false });
  assert.deepStrictEqual(K.overlap(150, 0, 64), { take: -1, gap: false });
  assert.deepStrictEqual(K.overlap(100, 101, 50), { take: -1, gap: true });
});
test('a transfer that falls back half-way reassembles byte-identical', function () {
  // simulate: direct sends 64 KB frames, receiver acks at 512 KB; channel drops
  // after 700 KB arrived; relay resumes from the ack with 128 KB chunks.
  var file = rnd(1500000, 11), sizes = [file.length], got = 0, parts = [], crc = 0, ackAt = 0;
  function recv(o, data) {
    var ov = K.overlap(got, o, data.length);
    assert.ok(!ov.gap);
    if (ov.take < 0) return;
    var b = data.subarray(ov.take); crc = K.crc32(b, crc); got += b.length; parts.push(b);
    if (got - ackAt >= K.C.ACK_EVERY) ackAt = got;
  }
  var c = K.cursor(sizes), s;
  while ((s = c.next(65536 - K.C.HDR)).k === 'chunk' && got < 700000) { var fr = K.decodeFrame(K.encodeFrame(0, s.o, file.subarray(s.o, s.o + s.len))); recv(fr.o, fr.data); }
  assert.ok(ackAt > 0 && ackAt < got, 'ack trails what arrived');
  var r = K.cursor(sizes, 0, ackAt);
  while ((s = r.next(K.C.RELAY_CHUNK)).k === 'chunk') recv(s.o, K.b64dec(K.b64enc(file.subarray(s.o, s.o + s.len))));
  assert.strictEqual(s.k, 'fin');
  assert.strictEqual(got, file.length);
  assert.strictEqual(crc, K.crc32(file));
  assert.ok(Buffer.concat(parts.map(function (p) { return Buffer.from(p); })).equals(Buffer.from(file)));
});
test('names: no folders, controls, bidi tricks or reserved names; length kept with the extension', function () {
  assert.strictEqual(K.safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(K.safeName('C:\\Users\\me\\photo.jpg'), 'photo.jpg');
  assert.strictEqual(K.safeName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.strictEqual(K.safeName('a<b>:c?|*".txt'), 'a_b__c____.txt');
  assert.strictEqual(K.safeName('tab\there\nnew'), 'tab_here_new');
  assert.strictEqual(K.safeName('CON.txt'), '_CON.txt');
  assert.strictEqual(K.safeName('lpt1'), '_lpt1');
  assert.strictEqual(K.safeName('.env'), '_.env');
  assert.strictEqual(K.safeName('name. . '), 'name');
  assert.strictEqual(K.safeName('  spaced   out  .md'), 'spaced out .md');
  assert.strictEqual(K.safeName(''), 'file');
  assert.strictEqual(K.safeName(null), 'file');
  assert.strictEqual(K.safeName('...'), 'file');
  assert.strictEqual(K.safeName('Ünïcødé 日本.txt'), 'Ünïcødé 日本.txt');
  var long = K.safeName(new Array(300).join('x') + '.jpeg');
  assert.strictEqual(long.length, 120); assert.ok(/\.jpeg$/.test(long));
  assert.deepStrictEqual(K.uniqueNames(['a.txt', 'A.TXT', 'a.txt', 'b', 'b']), ['a.txt', 'A (2).TXT', 'a (3).txt', 'b', 'b (2)']);
});
test('manifest: built sanitised, validated strictly', function () {
  var m = K.makeManifest('abc123def456', [{ name: 'x/y.png', size: 10, type: 'image/png' }, { name: 'y.png', size: 0, type: 'weird type!' }]);
  assert.deepStrictEqual(m, { v: 1, x: 'abc123def456', files: [{ n: 'y.png', s: 10, t: 'image/png' }, { n: 'y (2).png', s: 0, t: '' }], total: 10 });
  assert.deepStrictEqual(K.validManifest(JSON.parse(JSON.stringify(m))), m);
  function bad(mut, why) { var c = JSON.parse(JSON.stringify(m)); mut(c); assert.strictEqual(K.validManifest(c), null, why); }
  bad(function (c) { c.v = 2; }, 'version');
  bad(function (c) { c.x = 'AB!'; }, 'id');
  bad(function (c) { c.files = []; }, 'no files');
  bad(function (c) { c.files = 'x'; }, 'not a list');
  bad(function (c) { c.files[0].s = -1; }, 'negative size');
  bad(function (c) { c.files[0].s = 1.5; }, 'fractional size');
  bad(function (c) { c.files[0].s = '10'; }, 'string size');
  bad(function (c) { c.files[0] = null; }, 'null file');
  bad(function (c) { c.total = 11; }, 'total mismatch');
  bad(function (c) { c.files = new Array(K.C.MAX_FILES + 1).fill({ n: 'a', s: 1 }); delete c.total; }, 'too many files');
  assert.strictEqual(K.validManifest(null), null);
  var dirty = K.validManifest({ v: 1, x: 'abcdef', files: [{ n: '../a', s: 1, t: 'TEXT/Plain; charset=utf-8' }, { n: 'a', s: 2 }] });
  assert.deepStrictEqual(dirty.files.map(function (f) { return f.n + '|' + f.t; }), ['a|text/plain', 'a (2)|']);
  assert.strictEqual(dirty.total, 3);
  assert.ok(K.validManifest({ v: 1, x: 'abcdef', files: [{ n: 'huge.mov', s: 64 * 1024 * 1024 * 1024 }] }), 'no size cap');
});
test('meter: steady speed converges, ETA counts down smoothly', function () {
  var total = 20 * 1024 * 1024, m = K.meter(total), rate = 1024 * 1024, last = null, r;
  for (var t = 0; t <= 10000; t += 250) {
    r = m.update(Math.min(total, rate * t / 1000), t);
    if (last && last.eta != null && r.eta != null) assert.ok(r.eta <= last.eta + 0.01, 'ETA never climbs at a steady rate (' + t + ')');
    last = r;
  }
  assert.ok(Math.abs(r.bps - rate) / rate < 0.01, 'speed ≈ 1 MB/s');
  assert.ok(Math.abs(r.eta - 10) < 0.5, 'ETA ≈ 10 s, got ' + r.eta);
  assert.strictEqual(Math.round(r.pct), 50);
  // bursty arrivals (all of a second's data in one sample): the ETA moves gently
  var m2 = K.meter(total), d = 0, prev = null, maxJump = 0;
  for (var u = 0; u <= 8000; u += 250) {
    if (u % 1000 === 0) d += rate;
    var s = m2.update(d, u);
    if (prev != null && s.eta != null && u > 3000) maxJump = Math.max(maxJump, Math.abs(s.eta - prev));
    prev = s.eta;
  }
  assert.ok(maxJump < 6, 'ETA jumps stay small, max ' + maxJump);
  var m3 = K.meter(100);
  assert.strictEqual(m3.update(0, 0).eta, null, 'no ETA before there is a rate');
  assert.strictEqual(m3.update(100, 400).eta, 0);
  assert.strictEqual(m3.update(100, 400).pct, 100);
  assert.strictEqual(K.meter(0).update(0, 0).pct, 100, 'an empty beam is complete');
});
test('formatting: bytes, speed, ETA, percent, path', function () {
  assert.strictEqual(K.fmtBytes(512), '512 B');
  assert.strictEqual(K.fmtBytes(1536), '1.5 KB');
  assert.strictEqual(K.fmtBytes(2.1 * 1024 * 1024), '2.1 MB');
  assert.strictEqual(K.fmtBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  assert.strictEqual(K.fmtRate(2.1 * 1024 * 1024), '2.1 MB/s');
  assert.strictEqual(K.fmtRate(0), '');
  assert.strictEqual(K.fmtEta(null), '');
  assert.strictEqual(K.fmtEta(0.3), 'almost done');
  assert.strictEqual(K.fmtEta(12.2), '13 s left');
  assert.strictEqual(K.fmtEta(125), '3 min left');
  assert.strictEqual(K.fmtEta(3700), '1 h 2 min left');
  assert.strictEqual(K.fmtPct(45.6), '45%');
  assert.strictEqual(K.fmtPct(4.56), '4.6%');
  assert.strictEqual(K.fmtPct(100), '100%');
  assert.strictEqual(K.pathLabel('direct', 'lan'), 'direct · Wi-Fi');
  assert.strictEqual(K.pathLabel('direct', 'internet'), 'direct · internet');
  assert.strictEqual(K.pathLabel('relay'), 'via cloud · slower');
  assert.strictEqual(K.pathLabel('connecting'), 'connecting…');
  assert.strictEqual(K.pathNote('host', 'host'), 'lan');
  assert.strictEqual(K.pathNote('srflx', 'host'), 'internet');
  assert.strictEqual(K.pathNote('host', 'prflx'), 'internet');
});
test('base64 round trip (relay payloads)', function () {
  [0, 1, 2, 3, 4, 100, 65536, 131072].forEach(function (n) {
    var d = rnd(n, n + 1), s = K.b64enc(d);
    assert.strictEqual(s, Buffer.from(d).toString('base64'));
    assert.deepStrictEqual(Buffer.from(K.b64dec(s)), Buffer.from(d));
  });
});
test('inbox: kept 7 days, then within a size budget (newest always kept)', function () {
  var day = 86400000, now = 100 * day;
  assert.strictEqual(K.expired({ at: now - 7 * day + 1 }, now), false);
  assert.strictEqual(K.expired({ at: now - 7 * day - 1 }, now), true);
  assert.strictEqual(K.expired({}, now), true, 'no date');
  assert.strictEqual(K.expired(null, now), true);
  var list = [{ id: 'old', at: now - 8 * day, size: 1 }, { id: 'a', at: now - 1000, size: 60 }, { id: 'b', at: now - 2000, size: 50 }, { id: 'c', at: now - 3000, size: 10 }];
  assert.deepStrictEqual(K.prune(list, now, 1000), ['old']);
  assert.deepStrictEqual(K.prune(list, now, 100).sort(), ['b', 'c', 'old'].sort(), 'over budget: older ones go');
  assert.deepStrictEqual(K.prune([{ id: 'huge', at: now, size: 5000 }], now, 100), [], 'the newest stays even when it alone is over');
  assert.strictEqual(K.ago(5000), 'just now');
  assert.strictEqual(K.ago(3 * 3600000), '3 h ago');
  assert.strictEqual(K.ago(2 * day), '2 d ago');
});
test('open / thumbnail kinds: HTML and SVG open as text', function () {
  assert.strictEqual(K.openKind('image/png', 'a.png'), 'image');
  assert.strictEqual(K.openKind('', 'IMG_1.HEIC'), 'image');
  assert.strictEqual(K.openKind('application/octet-stream', 'x.jpg'), 'image');
  assert.strictEqual(K.openKind('application/pdf', 'x'), 'pdf');
  assert.strictEqual(K.openKind('', 'doc.pdf'), 'pdf');
  assert.strictEqual(K.openKind('text/html', 'page.html'), 'text');
  assert.strictEqual(K.openKind('image/svg+xml', 'logo.svg'), 'text');
  assert.strictEqual(K.openKind('application/json', 'a'), 'text');
  assert.strictEqual(K.openKind('', 'notes.md'), 'text');
  assert.strictEqual(K.openKind('application/zip', 'a.zip'), null);
  assert.strictEqual(K.openKind('video/mp4', 'a.mp4'), null);
  assert.strictEqual(K.openType('text', 'text/html', 'a.html'), 'text/plain;charset=utf-8');
  assert.strictEqual(K.openType('image', '', 'a.jpg'), 'image/jpeg');
  assert.ok(K.isImage('image/svg+xml', 'logo.svg'), 'svg gets a thumbnail (an <img> runs no script)');
  assert.ok(!K.isImage('application/zip', 'a.zip'));
});
test('ids: transfer ids pass the manifest check', function () {
  for (var i = 0; i < 50; i++) { var x = K.rid(12); assert.ok(/^[a-z0-9]{12}$/.test(x)); }
  assert.ok(K.validManifest({ v: 1, x: K.rid(12), files: [{ n: 'a', s: 0 }] }));
});
test('widget and receiver plugin register as the manifest says; fileMenu kinds are taken', function () {
  var man;
  try {
    var mods = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
    var w0 = mods.filter(function (m) { return m.id === 'beam'; })[0], p0 = mods.filter(function (m) { return m.id === 'beam-recv'; })[0];
    man = w0 && p0 ? [w0, p0] : MANIFEST;
  } catch (e) { man = MANIFEST; }
  var w = man[0], p = man[1];
  assert.strictEqual(p.type, 'plugin'); assert.strictEqual(p.settingKey, 'plugins.beam-recv'); assert.strictEqual(p.default, true); assert.strictEqual(p.section, 'Devices');
  var reg = null, plug = null, css = [];
  var fake = {
    Cade: {
      loadCSS: function (c) { css.push(c); }, asset: function (r) { return r; }, baseURL: function () { return './txt/widgets/beam/'; },
      registerWidget: function (o) { reg = o; }, registerPlugin: function (o) { plug = o; }, escapeHtml: String,
      CM: { ViewPlugin: { define: function (f) { return { __vp: f }; } } }, cloud: { device: { name: 'x' } }
    },
    document: { addEventListener: function () {}, removeEventListener: function () {} }
  };
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'beam.js'), 'utf8'))(fake, undefined, fake.document);
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], w[k], k); });
  assert.strictEqual(typeof reg.open, 'function');
  assert.deepStrictEqual(css, ['beam.css']);
  assert.strictEqual(w.entry, 'widgets/beam/beam.js'); assert.strictEqual(w.css, 'widgets/beam/beam.css');
  ['beam-link.js', 'beam-core.js', 'beam-qr.js', 'beam-qr-core.js', 'beam-qr.css'].forEach(function (f) { assert.ok(w.precache.indexOf('widgets/beam/' + f) >= 0, f); });
  assert.ok(w.precache.indexOf('widgets/qr/qr-core.js') >= 0);
  var src = fs.readFileSync(path.join(__dirname, 'beam.js'), 'utf8');
  w.fileMenu.forEach(function (it) { assert.ok(src.indexOf("take('" + it.kind + "')") >= 0, 'beam.js takes ' + it.kind); });
  new Function('window', 'module', 'document', fs.readFileSync(path.join(__dirname, 'beam-recv.js'), 'utf8'))(fake, undefined, fake.document);
  assert.strictEqual(plug.id, 'beam-recv');
  assert.ok(plug.ext && plug.ext.__vp, 'lifetime tied to an editor ViewPlugin');
  p.precache.forEach(function (f) { assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f + ' exists'); });
  // beam-link must not run without the core (and does nothing in node)
  new Function('window', fs.readFileSync(path.join(__dirname, 'beam-link.js'), 'utf8'))(undefined);
});
console.log((process.exitCode ? 'FAILED, ' : '') + 'beam: ' + passed + ' passed');
