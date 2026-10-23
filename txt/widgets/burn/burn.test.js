/* Checks for self-destructing links: the link format, the AES-GCM round trip,
 * expiry and the one-time claim, the owner's status / sweep decisions, the
 * live merge of concurrent edits (including a simulated compare-and-swap
 * session between two writers), and that the widget's metadata matches its
 * manifest entry. Not loaded by the app. Run: node txt/widgets/burn/burn.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var C = require('./burn-core.js');
var M = require('../merge/merge-core.js');
var passed = 0, pending = [];
function test(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(function () { passed++; }, function (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }));
    else passed++;
  } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

var MANIFEST_ENTRY = {
  id: 'burn', type: 'widget', name: 'Self-destructing links',
  description: 'Share a note by a link that self-destructs — after one open, or when a timer runs out — end-to-end encrypted, optionally live-editable; for people without Cade.txt',
  icon: '🔥',
  tags: 'share,link,self-destruct,burn,burn after reading,one-time,expiring,expire,secret,private,encrypted,live,collaborate,guest,send',
  entry: 'widgets/burn/burn.js', css: 'widgets/burn/burn.css',
  precache: ['widgets/burn/burn-core.js', 'widgets/merge/merge-core.js']
};

// ---- links ------------------------------------------------------------------------------------------
test('ids and keys are fresh random 128 / 256-bit values', function () {
  var ids = {}, i;
  for (i = 0; i < 200; i++) { var id = C.newId(); assert(C.validId(id), id); assert(!ids[id]); ids[id] = 1; }
  assert.strictEqual(C.unb64u(C.newId()).length, 16);
  assert.strictEqual(C.unb64u(C.newKey()).length, 32);
  assert(C.validKey(C.newKey()));
  assert.strictEqual(C.nodePath('abc'), 'rooms/__cade_burn_abc');
});
test('link encode / decode round trip; key only after the #', function () {
  var s = { db: 'https://my-db.firebaseio.com', id: C.newId(), key: C.newKey() };
  var link = C.encodeLink('https://cadezawacki.github.io/txt.html?room=x#old', s);
  assert(/^https:\/\/cadezawacki\.github\.io\/txt\.html\?room=x#burn=[A-Za-z0-9_-]+$/.test(link), link);
  var before = link.split('#')[0];
  assert(before.indexOf(s.key) < 0 && before.indexOf(s.id) < 0 && before.indexOf('my-db') < 0, 'nothing secret before the fragment');
  assert.deepStrictEqual(C.decodeLink(link), s);
  assert.deepStrictEqual(C.decodeLink('#burn=' + link.split('#burn=')[1]), s);
  assert.deepStrictEqual(C.decodeLink(link.split('#burn=')[1]), s);
});
test('damaged links decode to null', function () {
  var s = { db: 'https://my-db.firebaseio.com', id: C.newId(), key: C.newKey() };
  var p = C.encodeLink('https://x/txt.html', s).split('#burn=')[1];
  assert.strictEqual(C.decodeLink(p.slice(0, 20)), null);
  assert.strictEqual(C.decodeLink('abc'), null);
  assert.strictEqual(C.decodeLink(''), null);
  assert.strictEqual(C.decodeLink('#burn=***'), null);
  var bad = function (o) { return C.b64u(Buffer.from(JSON.stringify(o))); };
  assert.strictEqual(C.decodeLink(bad({ v: 1, d: 'javascript:alert(1)', i: s.id, k: s.key })), null);
  assert.strictEqual(C.decodeLink(bad({ v: 1, d: s.db, i: 'short', k: s.key })), null);
  assert.strictEqual(C.decodeLink(bad({ v: 2, d: s.db, i: s.id, k: s.key })), null);
  assert.throws(function () { C.encodeLink('x', { db: 'ftp://a', id: s.id, key: s.key }); });
});

// ---- crypto -------------------------------------------------------------------------------------------
test('AES-GCM seal / open round trip, bound to key, id and slot', function () {
  var k = C.newKey(), id = C.newId(), text = 'Secret plan ✓ — émoji 🎉\nline 2';
  return C.seal(k, id, 'v3', { t: text }).then(function (ct) {
    assert(/^1\.[A-Za-z0-9_-]+$/.test(ct));
    assert(ct.indexOf('Secret') < 0);
    return Promise.all([
      C.open(k, id, 'v3', ct).then(function (o) { assert.strictEqual(o.t, text); }),
      C.open(C.newKey(), id, 'v3', ct).then(function () { throw new Error('wrong key opened it'); }, function () {}),
      C.open(k, C.newId(), 'v3', ct).then(function () { throw new Error('other share opened it'); }, function () {}),
      C.open(k, id, 'v4', ct).then(function () { throw new Error('replayed as another version'); }, function () {}),
      C.open(k, id, 'v3', ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'AB' : 'AA')).then(function () { throw new Error('tampered opened'); }, function () {}),
      C.seal(k, id, 'v3', { t: text }).then(function (ct2) { assert.notStrictEqual(ct2, ct, 'fresh IV each time'); })
    ]);
  });
});

// ---- expiry --------------------------------------------------------------------------------------------
test('expiry presets, custom and limits', function () {
  var now = 1e12;
  assert.strictEqual(C.expiryFrom('10m', null, now), now + 600000);
  assert.strictEqual(C.expiryFrom('1h', null, now), now + 3600000);
  assert.strictEqual(C.expiryFrom('24h', null, now), now + 86400000);
  assert.strictEqual(C.expiryFrom('7d', null, now), now + 7 * 86400000);
  assert.strictEqual(C.expiryFrom('none', null, now), 0);
  assert.strictEqual(C.expiryFrom('custom', { n: '90', unit: 'min' }, now), now + 90 * 60000);
  assert.strictEqual(C.expiryFrom('custom', { n: 1.5, unit: 'h' }, now), now + 5400000);
  assert.throws(function () { C.expiryFrom('custom', { n: 0, unit: 'h' }, now); });
  assert.throws(function () { C.expiryFrom('custom', { n: 31, unit: 'd' }, now); }, /30 days/);
  assert.throws(function () { C.expiryFrom('custom', { n: 10, unit: 's' }, now); });
  assert.throws(function () { C.expiryFrom('bogus', null, now); });
  assert.throws(function () { C.checkOptions({ expiresAt: 0, oneTime: false, text: 'x' }); }, /never self-destructs/);
  assert(C.checkOptions({ expiresAt: 0, oneTime: true, text: 'x' }));
  assert.throws(function () { C.checkOptions({ expiresAt: 5, oneTime: false, text: new Array(C.MAX_TEXT + 2).join('x') }); }, /too long/);
});
test('isExpired / msLeft / fmtLeft / fmtClock', function () {
  var m = { expiresAt: 1000 };
  assert(!C.isExpired(m, 999)); assert(C.isExpired(m, 1000)); assert(!C.isExpired({ expiresAt: 0 }, 1e15));
  assert.strictEqual(C.msLeft(m, 400), 600); assert.strictEqual(C.msLeft(m, 4000), 0); assert.strictEqual(C.msLeft({}, 1), Infinity);
  assert.strictEqual(C.fmtLeft(45000), '45 s');
  assert.strictEqual(C.fmtLeft(9 * 60000), '9 min');
  assert.strictEqual(C.fmtLeft(65 * 60000), '1 h 5 min');
  assert.strictEqual(C.fmtLeft(60 * 60000), '1 h');
  assert.strictEqual(C.fmtLeft((2 * 24 + 3) * 3600000), '2 d 3 h');
  assert.strictEqual(C.fmtLeft(Infinity), '');
  assert.strictEqual(C.fmtClock(61000), '1:01');
  assert.strictEqual(C.fmtClock(3723000), '1:02:03');
  assert.strictEqual(C.fmtClock(0), '0:00');
});

// ---- claim ---------------------------------------------------------------------------------------------
test('claim: first opener wins; a transaction loser never reads', function () {
  // A fake server running the update function the way Firebase does: the
  // client's first guess may be null (not cached); the server reruns it with
  // the real value when the guess was wrong.
  var server = null;
  function transact(fn, cachedGuess) {
    var cur = cachedGuess, v;
    for (var i = 0; i < 5; i++) {
      v = fn(cur);
      if (v === undefined) return { committed: false, val: server };
      if (JSON.stringify(cur) === JSON.stringify(server)) { server = v; return { committed: true, val: server }; }
      cur = server;
    }
    throw new Error('loop');
  }
  var a = transact(function (cur) { return C.claimUpdate(cur, 'alice', 1); }, null);
  var b = transact(function (cur) { return C.claimUpdate(cur, 'bob', 2); }, null);   // stale null guess
  assert(a.committed && C.claimIsMine(a.val, 'alice'));
  assert(!C.claimIsMine(b.val, 'bob'));
  assert.strictEqual(server.by, 'alice');
});
test('gate: what an opener may do', function () {
  var now = 5000;
  var meta = function (o) { return Object.assign({ v: 1, created: 0, expiresAt: 0, oneTime: false, editable: false }, o); };
  assert.deepStrictEqual(C.gate({ meta: null, tomb: null, claim: null }, now, 'me'), { ok: false, why: 'gone' });
  assert.deepStrictEqual(C.gate({ meta: meta({}), tomb: { why: 'revoked' }, claim: null }, now, 'me'), { ok: false, why: 'revoked' });
  assert.deepStrictEqual(C.gate({ meta: meta({ expiresAt: 5000 }), tomb: null, claim: null }, now, 'me'), { ok: false, why: 'expired' });
  assert.deepStrictEqual(C.gate({ meta: meta({ expiresAt: 9000 }), tomb: null, claim: null }, now, 'me'), { ok: true, needClaim: false });
  assert.deepStrictEqual(C.gate({ meta: meta({ oneTime: true }), tomb: null, claim: null }, now, 'me'), { ok: true, needClaim: true });
  assert.deepStrictEqual(C.gate({ meta: meta({ oneTime: true }), tomb: null, claim: { by: 'x' } }, now, 'me'), { ok: false, why: 'opened' });
  assert.deepStrictEqual(C.gate({ meta: meta({ oneTime: true, editable: true }), tomb: null, claim: { by: 'x' } }, now, 'me'), { ok: false, why: 'claimed' });
  assert.deepStrictEqual(C.gate({ meta: meta({ oneTime: true, editable: true }), tomb: null, claim: { by: 'me' } }, now, 'me'), { ok: true, needClaim: false }, 'same browser comes back');
  assert.deepStrictEqual(C.gate({ meta: meta({ oneTime: true }), tomb: { why: 'opened' }, claim: null }, now, 'me'), { ok: false, why: 'opened' });
});

// ---- owner: status, sweep, blob ----------------------------------------------------------------------------
function entry(o) { return Object.assign({ id: C.newId(), key: C.newKey(), db: 'https://d.firebaseio.com', room: 'r', title: 'r', created: 0, expiresAt: 0, oneTime: true, editable: false, copy: false, ended: null }, o); }
test('statusOf', function () {
  var e = entry({ expiresAt: 600000 });
  assert.strictEqual(C.statusOf(e, undefined, 0).state, 'waiting');
  assert.strictEqual(C.statusOf(e, { meta: {}, claim: null, presence: null }, 0).label, 'Waiting to be opened');
  assert.strictEqual(C.statusOf(e, { meta: {}, claim: { by: 'x' } }, 0).state, 'opened');
  assert.strictEqual(C.statusOf(e, { meta: {}, tomb: { why: 'opened' } }, 0).label, 'Opened — deleted');
  assert.strictEqual(C.statusOf(e, { meta: {} }, 600000).state, 'expired');
  assert.strictEqual(C.statusOf(e, { meta: null }, 0).state, 'gone');
  var live = C.statusOf(entry({ editable: true }), { meta: {}, claim: { by: 'x' }, presence: { a: {}, b: {} } }, 0);
  assert.strictEqual(live.state, 'live'); assert.strictEqual(live.viewers, 2); assert.strictEqual(live.label, 'Live · 2 viewers');
  assert.strictEqual(C.statusOf(entry({ oneTime: false }), { meta: {}, presence: { a: {} } }, 0).label, 'Open now · 1 viewer');
  assert.strictEqual(C.statusOf(entry({ ended: { why: 'revoked', at: 1 } }), undefined, 0).label, 'Revoked');
  assert.strictEqual(C.statusOf(e, undefined, 60000).left, 540000);
});
test('sweepAction', function () {
  var e = entry({ expiresAt: 1000 });
  assert.deepStrictEqual(C.sweepAction(e, { meta: {}, tomb: null, claim: null }, 500), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(e, { meta: {}, tomb: null, claim: null }, 1000), { act: 'tomb', why: 'expired' });
  assert.deepStrictEqual(C.sweepAction(e, { meta: {}, tomb: { why: 'opened' } }, 1000), { act: 'end', why: 'opened' });
  assert.deepStrictEqual(C.sweepAction(e, { meta: null, tomb: null }, 10), { act: 'end', why: 'gone' });
  assert.deepStrictEqual(C.sweepAction(e, undefined, 5000), { act: 'keep' }, 'unread node');
  // claimed read-only, viewer never deleted it: finish after a minute
  var o = entry({ expiresAt: 0 });
  assert.deepStrictEqual(C.sweepAction(o, { meta: {}, claim: { by: 'x', at: 100 } }, 30000), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(o, { meta: {}, claim: { by: 'x', at: 100 } }, 70000), { act: 'tomb', why: 'opened' });
  // a live editable one stays claimed
  assert.deepStrictEqual(C.sweepAction(entry({ editable: true }), { meta: {}, claim: { by: 'x', at: 1 } }, 1e9), { act: 'keep' });
  var ended = entry({ ended: { why: 'expired', at: 0 } });
  assert.deepStrictEqual(C.sweepAction(ended, undefined, C.KEEP_ENDED_MS - 1), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(ended, undefined, C.KEEP_ENDED_MS), { act: 'purge' });
  assert.strictEqual(C.nextSweepIn([entry({ expiresAt: 5000 }), entry({ expiresAt: 3000 }), entry({ expiresAt: 0 })], 1000), 3500);
  assert.strictEqual(C.nextSweepIn([entry({ expiresAt: 0 })], 1000), -1);
});
test('normBlob drops junk and duplicates; hasActive', function () {
  var good = entry({});
  var d = C.normBlob({ shares: [good, good, { id: 'x' }, null, entry({ db: 'nope' })] });
  assert.strictEqual(d.shares.length, 1);
  assert.strictEqual(d.shares[0].id, good.id);
  assert(C.hasActive({ shares: [good] }));
  assert(!C.hasActive({ shares: [entry({ ended: { why: 'opened', at: 1 } })] }));
  assert(!C.hasActive(null));
});

// ---- merge ----------------------------------------------------------------------------------------------------
test('mergeLive: different lines, the same line, the same word, nothing lost', function () {
  var base = 'Secret plan\n\nMeet at the old oak at noon.\nBring the map.';
  assert.strictEqual(C.mergeLive(M, base, base + '\nmine', 'TOP ' + base), 'TOP ' + base + '\nmine');
  assert.strictEqual(C.mergeLive(M, base, base.replace('noon', '1pm'), base.replace('Meet', 'Let’s meet')), base.replace('noon', '1pm').replace('Meet', 'Let’s meet'));
  assert.strictEqual(C.mergeLive(M, 'hello world', 'hello brave world', 'hello world!'), 'hello brave world!');
  var w = C.mergeLive(M, 'abc', 'abcX', 'abcY');
  assert(w.indexOf('X') >= 0 && w.indexOf('Y') >= 0 && w.indexOf('abc') === 0 && w.length === 5, w);
  assert.strictEqual(C.mergeLive(M, 'a\r\nb', 'a!\r\nb', 'a\r\nb?'), 'a!\r\nb?', 'CRLF kept');
  assert.strictEqual(C.mergeLive(M, 'x', 'x', 'y'), 'y');
  assert.strictEqual(C.mergeLive(M, 'x', 'y', 'x'), 'y');
  assert.strictEqual(C.mergeLive(M, '', 'a', 'a'), 'a');
  assert.strictEqual(C.mergeLive(M, 'one two three', 'one three', 'one two three four'), 'one three four', 'delete + append');
  assert.strictEqual(C.mergeLive(M, 'p\\nq', 'p\\nq!', '>p\\nq'), '>p\\nq!', 'backslashes survive the token escaping');
});
test('mapPos keeps a caret through a remote change', function () {
  assert.strictEqual(C.mapPos('hello world', 'TOP hello world', 11), 15);
  assert.strictEqual(C.mapPos('hello world', 'hello world!!', 5), 5);
  assert.strictEqual(C.mapPos('abc', 'abc', 2), 2);
  assert.strictEqual(C.mapPos('abcdef', 'abXYZdef', 3), 5);
});
test('two writers with compare-and-swap pushes converge and keep every edit', function () {
  // Simulates LiveDoc: shared = last incorporated version; push = CAS on ver;
  // a lost race merges the newer version first and pushes again.
  var server = { ver: 1, text: 'line one\nline two\nline three' };
  function writer() { return { shared: { ver: 1, text: server.text }, local: server.text }; }
  var A = writer(), B = writer();
  function pull(w) {
    if (server.ver <= w.shared.ver) return;
    w.local = C.mergeLive(M, w.shared.text, w.local, server.text);
    w.shared = { ver: server.ver, text: server.text };
  }
  function push(w) {
    if (w.local === w.shared.text) return true;
    if (server.ver !== w.shared.ver) return false;
    server = { ver: w.shared.ver + 1, text: w.local };
    w.shared = { ver: server.ver, text: w.local };
    return true;
  }
  var edits = [
    [A, function (t) { return t.replace('line one', 'line ONE'); }], [B, function (t) { return t.replace('line three', 'line 3'); }],
    [A, function (t) { return t + '\nA added'; }], [B, function (t) { return t + '\nB added'; }],
    [A, function (t) { return t.replace('two', 'two (a)'); }], [B, function (t) { return t.replace('line two', 'b: line two'); }]
  ];
  edits.forEach(function (e) { e[0].local = e[1](e[0].local); });
  for (var round = 0; round < 6; round++) { [A, B].forEach(function (w) { if (!push(w)) pull(w); }); }
  [A, B].forEach(pull);
  assert.strictEqual(A.local, B.local);
  assert.strictEqual(A.local, server.text);
  ['line ONE', 'line 3', 'A added', 'B added', 'two (a)', 'b: line two'].forEach(function (s) { assert(server.text.indexOf(s) >= 0, s + ' in ' + JSON.stringify(server.text)); });
});

// ---- widget / manifest ------------------------------------------------------------------------------------------
test('widget metadata matches the manifest entry; files exist', function () {
  var src = fs.readFileSync(path.join(__dirname, 'burn.js'), 'utf8');
  var win = { Cade: {
    baseURL: function () { return './txt/widgets/burn/'; }, loadCSS: function () {}, escapeHtml: function (s) { return s; },
    registerWidget: function (w) { win.reg = w; }
  } };
  new Function('window', 'document', src)(win, {});
  var w = win.reg;
  assert(w, 'registered');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(w[k], MANIFEST_ENTRY[k], k); });
  assert.strictEqual(typeof w.open, 'function');
  assert.strictEqual(typeof win.__cadeBurn.openLink, 'function');
  assert.strictEqual(typeof win.__cadeBurn.ownerBoot, 'function');
  var root = path.join(__dirname, '..', '..');
  [MANIFEST_ENTRY.entry, MANIFEST_ENTRY.css].concat(MANIFEST_ENTRY.precache).forEach(function (f) { assert(fs.existsSync(path.join(root, f)), f); });
  var mf = path.join(root, 'manifest.json');
  if (fs.existsSync(mf)) {
    var m = JSON.parse(fs.readFileSync(mf, 'utf8')).modules.filter(function (x) { return x.id === 'burn'; })[0];
    if (m) ['name', 'description', 'icon', 'tags', 'entry', 'css'].forEach(function (k) { assert.strictEqual(m[k], MANIFEST_ENTRY[k], 'manifest ' + k); });
  }
});

Promise.all(pending).then(function () { console.log('burn: ' + passed + ' passed'); });
