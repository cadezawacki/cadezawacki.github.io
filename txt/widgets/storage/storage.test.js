/* Unit tests for the Storage Insights widget's pure helpers.
 * Not loaded by the app (not in the manifest). Run: node txt/widgets/storage/storage.test.js */
'use strict';
var assert = require('assert');
var L = require('./storage.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

test('fmt', function () {
  assert.strictEqual(L.fmt(0), '0 KB');
  assert.strictEqual(L.fmt(10), '1 KB');
  assert.strictEqual(L.fmt(5000), '5 KB');
  assert.strictEqual(L.fmt(1048576 * 2.25), '2.3 MB');
  assert.strictEqual(L.fmt(63201294), '60 MB');
  assert.strictEqual(L.fmt(1073741824 * 1.5), '1.50 GB');
});

test('classifyKey', function () {
  assert.deepStrictEqual(L.classifyKey('cade-room-cache:notes'), { cat: 'docs', room: 'notes', part: 'text' });
  assert.deepStrictEqual(L.classifyKey('cade-room-synced:a:b'), { cat: 'docs', room: 'a:b', part: 'base' });
  assert.deepStrictEqual(L.classifyKey('cade-snap:__local__'), { cat: 'snaps', room: '__local__', part: 'snap' });
  assert.deepStrictEqual(L.classifyKey('cade-room-refs:x'), { cat: 'settings', room: 'x', part: 'other' });
  assert.deepStrictEqual(L.classifyKey('\u0000idbfb\u0000img:abc'), { cat: 'files', fb: 'img:abc' });
  assert.deepStrictEqual(L.classifyKey('cade-pref:editor.x'), { cat: 'settings' });
  assert.deepStrictEqual(L.classifyKey('cade-room-cache:'), { cat: 'settings' });
});

test('buckets', function () {
  assert.strictEqual(L.bucketKind('cade-v121'), 'app');
  assert.strictEqual(L.bucketKind('cade-tts-hd-v1'), 'hd');
  assert.strictEqual(L.bucketKind('cade-project-v3'), 'other');
  assert.strictEqual(L.bucketKind('cade-v'), 'other');
  var names = ['cade-v9', 'cade-tts-hd-v1', 'cade-v121', 'cade-v120', 'cade-cdn-x'];
  assert.deepStrictEqual(L.appBuckets(names, false), { keep: ['cade-v121'], old: ['cade-v120', 'cade-v9'] });
  assert.deepStrictEqual(L.appBuckets(names, true), { keep: ['cade-v121', 'cade-v120', 'cade-v9'], old: [] });
  assert.deepStrictEqual(L.appBuckets(['x'], false), { keep: [], old: [] });
});

test('known sizes + voices', function () {
  var HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/c10e/en/en_US/lessac/medium/';
  assert.strictEqual(L.knownSize(HF + 'en_US-lessac-medium.onnx'), 63201294);
  assert.strictEqual(L.knownSize(HF + 'en_US-lessac-medium.onnx.json'), 0);
  assert.strictEqual(L.knownSize('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm'), 11210254);
  assert.deepStrictEqual(L.voiceId(HF + 'en_US-lessac-medium.onnx'), { id: 'en_US-lessac-medium', model: true });
  assert.deepStrictEqual(L.voiceId(HF + 'en_US-lessac-medium.onnx.json'), { id: 'en_US-lessac-medium', model: false });
  assert.strictEqual(L.voiceId('https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js'), null);
  assert.strictEqual(L.voiceLabel('en_GB-northern_english_male-medium'), 'Northern english male (en-GB, medium)');
  assert.strictEqual(L.voiceLabel('weird'), 'weird');
  assert.deepStrictEqual(L.shortUrl('https://cdn.jsdelivr.net/npm/word-list@4.1.0/words.txt'), { host: 'cdn.jsdelivr.net', name: 'words.txt', path: '/npm/word-list@4.1.0/words.txt' });
});

test('hashesIn / refsIndex', function () {
  var t = 'a ![img:j#abc123] b ![img:j:AAAA] ![img:w#def|w300] ![file:report.pdf#0123456789abcdef|s99] ![file:x#zz]';
  var s = L.hashesIn(t);
  assert.deepStrictEqual(Object.keys(s.i).sort(), ['abc123', 'def']);
  assert.deepStrictEqual(Object.keys(s.f), ['0123456789abcdef']);
  var r = L.refsIndex('{"i":["h1"],"f":["f1","f2"]}', { i: { h0: true }, f: {} });
  assert.deepStrictEqual(Object.keys(r.i), ['h0', 'h1']);
  assert.deepStrictEqual(Object.keys(r.f), ['f1', 'f2']);
  assert.deepStrictEqual(L.refsIndex('garbage'), { i: {}, f: {} });
});

test('snapshot plans are exact and keep the newest', function () {
  var DAY = 86400000, now = 1e12;
  var arr = [{ t: now - 1 * DAY, c: 'newest' }, { t: now - 10 * DAY, c: 'ten "q"' }, { t: now - 40 * DAY, c: 'forty\n' }, { t: now - 100 * DAY, c: 'old' }];
  var v = JSON.stringify(arr), items = L.snapItems(arr);
  var p = L.snapPlan(items, v.length, now - 30 * DAY);
  var kept = L.pruneSnaps(arr, now - 30 * DAY);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(p.removed, 2);
  assert.strictEqual(p.freed, (v.length - JSON.stringify(kept).length) * 2);
  // everything older than the cutoff still keeps index 0
  var all = L.pruneSnaps(arr, now);
  assert.deepStrictEqual(all, [arr[0]]);
  var p2 = L.snapPlan(items, v.length, now);
  assert.strictEqual(p2.removed, 3);
  assert.strictEqual(p2.freed, (v.length - JSON.stringify(all).length) * 2);
  assert.deepStrictEqual(L.snapPlan(items, v.length, now - 1000 * DAY), { removed: 0, freed: 0 });
  assert.deepStrictEqual(L.snapPlan([], 2, now), { removed: 0, freed: 0 });
});

test('imageCandidates: only server-only rooms, never protected / pending / unconfirmed', function () {
  var items = [
    { key: 'img:a', kind: 'img', hash: 'a', bytes: 10 },   // only in offloaded room → candidate
    { key: 'img:b', kind: 'img', hash: 'b', bytes: 20 },   // also in a local doc → protected
    { key: 'img:c', kind: 'img', hash: 'c', bytes: 30 },   // pending upload
    { key: 'img:d', kind: 'img', hash: 'd', bytes: 40 },   // referenced by nobody → GC's business
    { key: 'file:e', kind: 'file', hash: 'e', bytes: 50, name: 'e.pdf' },
    { key: 'dict:x', kind: 'mod', hash: '', bytes: 5 },
  ];
  var protect = { i: { b: true }, f: {} };
  var serverOnly = { old: { i: { a: true, b: true, c: true }, f: { e: true } }, other: { i: { a: true }, f: {} } };
  var pending = { i: { c: true }, f: {} };
  var c = L.imageCandidates(items, protect, serverOnly, pending, null);
  assert.deepStrictEqual(c.map(function (x) { return x.key; }), ['img:a', 'file:e']);
  assert.deepStrictEqual(c[0].rooms, ['old', 'other']);
  var server = { i: { a: true }, f: {} };
  c = L.imageCandidates(items, protect, serverOnly, pending, server);
  assert.deepStrictEqual(c.map(function (x) { return x.key; }), ['img:a']);
  assert.deepStrictEqual(L.imageCandidates(items, protect, {}, pending, null), []);
});

test('fileMeta / valueSize / relDays', function () {
  assert.deepStrictEqual(L.fileMeta('{"v":1,"name":"a \\"b\\".pdf","size":1234,"mime":"x","data":"AAAA'), { name: 'a "b".pdf', size: 1234 });
  assert.deepStrictEqual(L.fileMeta('nope'), { name: '', size: 0 });
  assert.strictEqual(L.valueSize('abcd'), 4);
  assert.strictEqual(L.valueSize(new Uint8Array(7)), 7);
  assert.strictEqual(L.valueSize(new ArrayBuffer(9)), 9);
  assert.strictEqual(L.valueSize(['a', 'b']), 9);
  assert.strictEqual(L.valueSize(null), 0);
  var n = 1e12;
  assert.strictEqual(L.relDays(n - 1000, n), 'today');
  assert.strictEqual(L.relDays(n - 86400000 * 1.5, n), 'yesterday');
  assert.strictEqual(L.relDays(n - 86400000 * 12, n), '12d ago');
  assert.strictEqual(L.relDays(0, n), '');
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
