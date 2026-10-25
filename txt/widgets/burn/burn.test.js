/* Checks for self-destructing links: the link format, the AES-GCM round trip,
 * expiry, the one-time claim and viewer caps, the owner's time left, the
 * sealed options, the tidy-up tools (allow-list + sandboxed runner), the owner's status / sweep decisions, the
 * live merge of concurrent edits (including a simulated compare-and-swap
 * session between two writers), "watch live" links (modes, meta / head, slots,
 * older clients, the owner never taking anything from the share, the reader's
 * follower), and that the widget's metadata matches its manifest entry. Not loaded by the app. Run: node txt/widgets/burn/burn.test.js */
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
  description: 'Share a note by a link that self-destructs — after one open, or when a timer runs out — end-to-end encrypted, optionally live-editable; or ask for answers: polls, dates, RSVPs, lists; for people without Cade.txt',
  icon: '🔥',
  tags: 'share,link,self-destruct,burn,burn after reading,one-time,expiring,expire,secret,private,encrypted,live,collaborate,guest,send,poll,vote,survey,rsvp,date,schedule,doodle,checklist,shopping list,packing list,who brings what',
  entry: 'widgets/burn/burn.js', css: 'widgets/burn/burn.css',
  precache: ['widgets/burn/burn-core.js', 'widgets/merge/merge-core.js', 'widgets/burn/burn-respond-core.js', 'widgets/burn/burn-respond.js', 'widgets/burn/burn-respond.css']
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

// ---- viewer caps ------------------------------------------------------------------------------------------
// A fake server running a transaction's update function the way Firebase does:
// the client's first guess may be stale (e.g. null — not cached); the server
// reruns it with the real value when the guess was wrong.
function fakeServer(init) {
  var srv = { val: init === undefined ? null : init };
  srv.transact = function (fn, guess) {
    var cur = guess, v;
    for (var i = 0; i < 10; i++) {
      v = fn(cur == null ? null : JSON.parse(JSON.stringify(cur)));
      if (v === undefined) return { committed: false, val: srv.val };
      if (JSON.stringify(cur) === JSON.stringify(srv.val)) { srv.val = v; return { committed: true, val: srv.val }; }
      cur = srv.val;
    }
    throw new Error('loop');
  };
  return srv;
}
test('capFrom / checkOptions: once, up to N, anyone', function () {
  assert.strictEqual(C.capFrom('one'), 1);
  assert.strictEqual(C.capFrom('any'), 0);
  assert.strictEqual(C.capFrom('some', '3'), 3);
  assert.strictEqual(C.capFrom('some', 1), 1);
  assert.throws(function () { C.capFrom('some', ''); }, /how many/);
  assert.throws(function () { C.capFrom('some', 2.5); }, /how many/);
  assert.throws(function () { C.capFrom('some', C.MAX_VIEWERS + 1); }, /At most/);
  assert(C.checkOptions({ expiresAt: 0, maxOpens: 3, text: 'x' }));
  assert(C.checkOptions({ expiresAt: 60000, maxOpens: 0, text: 'x' }));
  assert.throws(function () { C.checkOptions({ expiresAt: 0, maxOpens: 0, text: 'x' }); }, /never self-destructs/);
  assert.throws(function () { C.checkOptions({ expiresAt: 5, maxOpens: 99, text: 'x' }); }, /how many/);
});
test('claims: up to N browsers, one slot each; racers never exceed the cap', function () {
  var srv = fakeServer(null), cap = 2;
  var claim = function (me, guess) { var r = srv.transact(function (cur) { return C.claimsUpdate(cur, me, 1, cap); }, guess); return C.holdsSlot(r.val, me); };
  // three browsers race with stale (null) guesses: exactly two get in
  var got = ['a', 'b', 'c'].map(function (me) { return claim(me, null); });
  assert.deepStrictEqual(got, [true, true, false]);
  assert.strictEqual(C.count(srv.val), 2);
  // a reopen in a browser that holds a slot doesn't use another one
  assert.strictEqual(claim('a', null), true);
  assert.strictEqual(C.count(srv.val), 2);
  assert.strictEqual(C.claimsUpdate({ a: 1 }, 'a', 2, 2), undefined, 'already mine: abort, keep the slot');
  assert.strictEqual(C.claimsUpdate({ a: 1, b: 1 }, 'c', 2, 2), undefined, 'full: abort');
  assert.deepStrictEqual(C.claimsUpdate(null, 'z', 7, 1), { z: 7 });
  // many racers on a single slot: one winner
  var one = fakeServer(null), winners = 0;
  for (var i = 0; i < 20; i++) { var r = one.transact(function (cur) { return C.claimsUpdate(cur, 'p' + i, 1, 1); }, null); if (C.holdsSlot(r.val, 'p' + i)) winners++; }
  assert.strictEqual(winners, 1);
});
test('gate: capped links, same-browser reopen, v1 one-time links unchanged', function () {
  var now = 5000;
  var m2 = function (o) { return Object.assign({ v: 2, created: 0, expiresAt: 0, maxOpens: 3, oneTime: false, editable: false }, o); };
  assert.deepStrictEqual(C.gate({ meta: m2({}), claims: null }, now, 'me'), { ok: true, needClaim: true });
  assert.deepStrictEqual(C.gate({ meta: m2({}), claims: { x: 1, y: 1 } }, now, 'me'), { ok: true, needClaim: true });
  assert.deepStrictEqual(C.gate({ meta: m2({}), claims: { x: 1, y: 1, z: 1 } }, now, 'me'), { ok: false, why: 'opened' });
  assert.deepStrictEqual(C.gate({ meta: m2({ editable: true }), claims: { x: 1, y: 1, z: 1 } }, now, 'me'), { ok: false, why: 'claimed' });
  assert.deepStrictEqual(C.gate({ meta: m2({}), claims: { x: 1, me: 1, z: 1 } }, now, 'me'), { ok: true, needClaim: false }, 'same browser, no new slot');
  assert.deepStrictEqual(C.gate({ meta: m2({ maxOpens: 0, expiresAt: 9000 }), claims: null }, now, 'me'), { ok: true, needClaim: false }, 'anyone');
  assert.deepStrictEqual(C.gate({ meta: m2({ maxOpens: 0, expiresAt: 5000 }) }, now, 'me'), { ok: false, why: 'expired' });
  // v2 one-person link with oneTime kept for older code: still the claims path
  assert.strictEqual(C.isV1Claim(m2({ maxOpens: 1, oneTime: true })), false);
  assert.deepStrictEqual(C.gate({ meta: m2({ maxOpens: 1, oneTime: true }), claim: { by: 'old' }, claims: null }, now, 'me'), { ok: true, needClaim: true });
  // links made before caps existed (meta { v: 1, oneTime }) keep the single-claim path
  var v1 = { v: 1, created: 0, expiresAt: 0, oneTime: true, editable: false };
  assert.strictEqual(C.capOf(v1), 1); assert(C.isV1Claim(v1));
  assert.deepStrictEqual(C.gate({ meta: v1, claim: null, claims: { a: 1 } }, now, 'me'), { ok: true, needClaim: true }, 'v1 ignores claims');
  assert.deepStrictEqual(C.gate({ meta: v1, claim: { by: 'x' } }, now, 'me'), { ok: false, why: 'opened' });
  assert.strictEqual(C.capOf({ v: 1, oneTime: false }), 0);
  // read-only: deleted once the last slot's opener has read it
  assert.strictEqual(C.burnsAfterRead(m2({}), { a: 1, b: 1 }), false);
  assert.strictEqual(C.burnsAfterRead(m2({}), { a: 1, b: 1, c: 1 }), true);
  assert.strictEqual(C.burnsAfterRead(m2({ maxOpens: 1 }), { a: 1 }), true);
  assert.strictEqual(C.burnsAfterRead(m2({ editable: true, maxOpens: 1 }), { a: 1 }), false);
  assert.strictEqual(C.burnsAfterRead(m2({ maxOpens: 0 }), null), false);
  assert.strictEqual(C.burnsAfterRead(v1, null), true);
});
test('owner status and sweep for capped links; v1 entries unchanged', function () {
  var e = entry({ v: 2, maxOpens: 3, oneTime: false, expiresAt: 600000 });
  assert.strictEqual(C.normBlob({ shares: [e] }).shares[0].maxOpens, 3);
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: { a: 1 } }, 0).label, 'Opened by 1 of 3');
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: { a: 1, b: 2 }, presence: { a: {} } }, 0).label, 'Open now · 1 viewer · 2 of 3 opened');
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: null }, 0).label, 'Waiting to be opened');
  assert.strictEqual(C.statusOf(e, { meta: {}, tomb: { why: 'opened' } }, 0).label, 'Opened by 3 — deleted');
  assert.strictEqual(C.statusOf(entry({ v: 2, maxOpens: 0, oneTime: false }), { meta: {}, claims: { a: 1 } }, 0).state, 'waiting', 'anyone: no slots');
  // read-only, full, the last opener never deleted it: finish after a minute
  var ro = entry({ v: 2, maxOpens: 2, oneTime: false });
  assert.deepStrictEqual(C.sweepAction(ro, { meta: {}, claims: { a: 100 } }, 1e6), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(ro, { meta: {}, claims: { a: 100, b: 200 } }, 30000), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(ro, { meta: {}, claims: { a: 100, b: 200 } }, 70000), { act: 'tomb', why: 'opened' });
  assert.deepStrictEqual(C.sweepAction(entry({ v: 2, maxOpens: 2, editable: true }), { meta: {}, claims: { a: 1, b: 1 } }, 1e9), { act: 'keep' });
  // a v1 entry (synced from older code) keeps reading `claim`
  var old = C.normBlob({ shares: [entry({ oneTime: true })] }).shares[0];
  assert.strictEqual(old.v, undefined); assert.strictEqual(C.capOfEntry(old), 1);
  assert.strictEqual(C.statusOf(old, { meta: {}, claim: { by: 'x' }, claims: { a: 1, b: 1 } }, 0).label, 'Opened');
  assert.strictEqual(C.capLabel(1), 'Just one person'); assert.strictEqual(C.capLabel(4), 'Up to 4 people'); assert.strictEqual(C.capLabel(0), 'Anyone with the link');
});

// ---- the owner's "27 min left" for a 1-minute link ------------------------------------------------------
test('time left: a 1-minute link never shows more than 1 minute (the 27-min bug)', function () {
  // The owner's clock was Cade.cloud.serverNow() = device clock + the sync
  // connection's serverTimeOffset. create() stamped expiresAt BEFORE that
  // offset was hooked (offset 0 = raw device time); the list then subtracted
  // the offset-corrected time. With an offset 26 minutes off (a stale
  // handshake — iOS froze the tab mid-connect — or a device clock off by that
  // much) the list said "27 min left" while the reader saw ~1 minute.
  var MIN = 60000, device = 1.7e12, cloudOffset = 0;
  var serverNow = function () { return device + cloudOffset; };
  var created = serverNow();                         // offset not hooked yet
  var e = entry({ created: created, expiresAt: created + MIN });
  cloudOffset = -26 * MIN;                           // hooked now, and wrong
  device += 2000;
  var oldLeft = e.expiresAt - serverNow();           // what statusOf used to compute
  assert.strictEqual(C.fmtLeft(oldLeft), '27 min', 'reproduces the report');
  // Fix 1: time left can never exceed the link's whole duration.
  assert(C.statusOf(e, undefined, serverNow()).left <= MIN);
  assert.strictEqual(C.fmtLeft(C.statusOf(e, undefined, serverNow()).left), '1 min');
  // Fix 2: the owner measures its own offset from the server-stamped
  // meta.created and anchors expiresAt there, so the list counts down in step
  // with the reader.
  var trueServer = function (dev) { return dev - 5 * 1000; };   // device clock 5 s fast
  var l0 = 1.7e12, l1 = l0 + 300, stamped = trueServer(l0 + 120);
  var off = C.clockOffset(stamped, l0, l1);
  assert(Math.abs(off - (-5000)) <= 300, 'offset ' + off);
  var e2 = entry({ created: stamped, ttl: MIN, expiresAt: stamped + MIN });
  var ownerNow = function (dev) { return dev + off; };
  var readerNow = function (dev) { return trueServer(dev); };
  [0, 15000, 45000].forEach(function (dt) {
    var dev = l1 + dt, a = C.statusOf(e2, undefined, ownerNow(dev)).left, b = C.msLeft(e2, readerNow(dev));
    assert(Math.abs(a - b) <= 300, 'owner ' + a + ' vs reader ' + b + ' at +' + dt);
  });
  assert.strictEqual(C.statusOf(e2, undefined, ownerNow(l1 + MIN + 1000)).state, 'expired');
  assert.strictEqual(C.clockOffset(0, 1, 2), null);
  assert.strictEqual(C.clockOffset(5, 3, 2), null);
  assert.strictEqual(C.ttlOf(entry({ created: 100, expiresAt: 60100 })), 60000);
  assert.strictEqual(C.ttlOf(entry({ expiresAt: 0 })), 0);
  assert.strictEqual(C.leftOf(entry({ expiresAt: 0 }), 5), Infinity);
});

// ---- sealed options -------------------------------------------------------------------------------------
test('sealed head: name, icon, countdown, tools round trip; nothing in the clear', function () {
  var k = C.newKey(), id = C.newId();
  var h = C.makeHead({ title: '  Trip\nplans  ', copy: true, icon: ' 🎉 ', timer: false, editable: true, scripts: ['title', 'sort', 'nope', 'sort', 'fetchAll'] });
  assert.deepStrictEqual(h, { title: 'Trip plans', copy: true, icon: '🎉', timer: false, scripts: ['sort', 'title'], live: false });
  return C.seal(k, id, 'head', h).then(function (ct) {
    ['Trip', '🎉', 'sort', 'title', 'timer'].forEach(function (s) { assert(ct.indexOf(s) < 0, s + ' in the clear'); });
    return C.open(k, id, 'head', ct);
  }).then(function (o) {
    assert.deepStrictEqual(C.readHead(o), h);
    // read-only links never carry tools; defaults
    assert.deepStrictEqual(C.makeHead({ title: '', scripts: ['sort'] }), { title: 'Shared note', copy: false, icon: '', timer: true, scripts: [], live: false });
    // v1 heads ({ title, copy }) read with the defaults: no icon, countdown on, no tools
    assert.deepStrictEqual(C.readHead({ title: 'plan', copy: false }), { title: 'plan', copy: false, icon: '', timer: true, scripts: [], live: false });
    assert.deepStrictEqual(C.readHead(null), { title: '', copy: false, icon: '', timer: true, scripts: [], live: false });
    assert.strictEqual(C.cleanIcon('👨‍👩‍👧 family'), '👨‍👩‍👧 ', 'a grapheme cluster counts as one');
    assert.strictEqual(C.cleanIcon('★'), '★');
    assert.strictEqual(C.cleanIcon('abc'), 'ab');
    assert.strictEqual(C.cleanIcon('\u0007'), '');
    assert.strictEqual(C.cleanName(new Array(200).join('x')).length, C.MAX_NAME);
  });
});

// ---- tidy-up tools ---------------------------------------------------------------------------------------
var packs = {};
function packCode(s) {
  if (!packs[s.pack]) packs[s.pack] = C.parsePack(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', s.pack, s.pack + '.js'), 'utf8'));
  return packs[s.pack][s.script];
}
function tidy(id, text, from, to) {
  var s = C.scriptById(id), r = C.runScript(packCode(s), text, from || 0, to || 0);
  return r.insert == null ? text : text.slice(0, r.from) + r.insert + text.slice(r.to);
}
test('tidy-up allow-list: every tool exists in its pack and is a pure text transform', function () {
  var ids = {};
  C.SCRIPTS.forEach(function (s) {
    assert(!ids[s.id], 'dup ' + s.id); ids[s.id] = 1;
    assert(/^[a-z]+$/.test(s.id) && s.label && s.hint && s.group, s.id);
    var code = packCode(s);
    assert(code, s.pack + ' has no "' + s.script + '"');
    assert(!/async\s+function\s+main/.test(code), s.id + ' is async');
    ['prompt', 'confirm', 'alert', 'fetch', 'XMLHttpRequest', 'document', 'window', 'navigator', 'localStorage', 'Cade', 'editor', 'Math.random', 'Date'].forEach(function (w) {
      assert(!new RegExp('\\b' + w.replace('.', '\\.') + '\\b').test(code), s.id + ' uses ' + w);
    });
  });
  assert.deepStrictEqual(C.packsFor(['sort', 'dedupe', 'title', 'zzz']), ['pack-lines', 'pack-case']);
});
test('tidy-up tools transform the whole text, or just the selection', function () {
  assert.strictEqual(tidy('sort', 'pear\napple\nitem 10\nitem 2'), 'apple\nitem 2\nitem 10\npear');
  assert.strictEqual(tidy('dedupe', 'a\nb\na\nc\nb'), 'a\nb\nc');
  assert.strictEqual(tidy('blank', 'a\n\n  \nb'), 'a\nb');
  assert.strictEqual(tidy('title', 'the lord of the rings'), 'The Lord of the Rings');
  assert.strictEqual(tidy('upper', 'shout'), 'SHOUT');
  assert.strictEqual(tidy('json', '{"a":1,"b":[1,2]}'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  assert.strictEqual(tidy('checklist', 'milk\n- eggs'), '[ ] milk\n[ ] eggs');
  assert.strictEqual(tidy('quotes', '“hi” — it’s…'), '"hi" - it\'s...');
  assert.strictEqual(tidy('csv', 'a,b\n1,2'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
  // only the selection changes
  var t = 'keep me\nzebra\napple\nkeep too', from = t.indexOf('zebra'), to = t.indexOf('\nkeep too');
  assert.strictEqual(tidy('sort', t, from, to), 'keep me\napple\nzebra\nkeep too');
  var r = C.runScript(packCode(C.scriptById('upper')), t, 0, 4);
  assert.deepStrictEqual([r.from, r.to, r.insert], [0, 4, 'KEEP']);
  // whole-text changes come back as the smallest edit
  r = C.runScript(packCode(C.scriptById('dedupe')), 'x\ny\ny', 0, 0);
  assert.strictEqual('x\ny\ny'.slice(0, r.from) + r.insert + 'x\ny\ny'.slice(r.to), 'x\ny');
  assert(r.to - r.from < 5);
  // nothing to change → insert null
  assert.strictEqual(C.runScript(packCode(C.scriptById('sort')), 'a\nb', 0, 0).insert, null);
  // invalid JSON throws (the view says so and changes nothing)
  assert.throws(function () { C.runScript(packCode(C.scriptById('json')), '{oops', 0, 0); }, /Invalid JSON/);
});
test('runScript sandbox: no page, network, storage or dialogs; async refused', function () {
  ['fetch("/x")', 'prompt("?")', 'document.title', 'window.location', 'localStorage.getItem("k")', 'Cade.editor', 'navigator.clipboard', 'globalThis.fetch("/x")', 'this.fetch("/x")'].forEach(function (expr) {
    assert.throws(function () { C.runScript('function main(ctx) { ctx.fullText = String(' + expr + '); }', 'x', 0, 0); }, TypeError, expr);
  });
  assert.throws(function () { C.runScript('async function main(ctx) { ctx.fullText = "y"; }', 'x', 0, 0); }, /can’t run here/);
  var r = C.runScript('function main(ctx) { showToast("Nothing found", "error"); }', 'x', 0, 0);
  assert.deepStrictEqual(r.messages, [{ text: 'Nothing found', kind: 'error' }]);
  assert.strictEqual(r.insert, null);
  // a pack loaded this way registers nothing anywhere else
  var seen = C.parsePack('(function(){ if (typeof window.Cade === "undefined") return; window.Cade.registerScript("/**\\n{\\"name\\":\\"X\\"}\\n**/\\nfunction main(ctx){}"); })();');
  assert.deepStrictEqual(Object.keys(seen), ['X']);
});

// ---- watch live ----------------------------------------------------------------------------------------------
function settle(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// A share's doc node: value listeners and transactions, like Firebase's (async).
function fakeDoc(init) {
  var val = init == null ? null : init, ls = [], d = { txns: 0, commits: 0 };
  var clone = function (v) { return v == null ? null : JSON.parse(JSON.stringify(v)); };
  var snap = function (v) { var c = clone(v); return { val: function () { return clone(c); } }; };
  var emit = function () { ls.slice().forEach(function (fn) { fn(snap(val)); }); };
  d.ref = {
    on: function (ev, fn) { ls.push(fn); setTimeout(function () { if (ls.indexOf(fn) >= 0) fn(snap(val)); }, 0); },
    off: function (ev, fn) { ls = ls.filter(function (f) { return f !== fn; }); },
    transaction: function (fn) {
      d.txns++;
      return new Promise(function (res) {
        setTimeout(function () {
          var nv = fn(clone(val));
          if (nv === undefined) return res({ committed: false, snapshot: snap(val) });
          val = clone(nv); d.commits++; emit();
          res({ committed: true, snapshot: snap(val) });
        }, 1);
      });
    }
  };
  d.set = function (v) { val = clone(v); emit(); };
  d.get = function () { return clone(val); };
  d.listeners = function () { return ls.length; };
  return d;
}
var liveMeta = function (o) { return Object.assign({ v: 3, created: 0, expiresAt: 0, maxOpens: 1, oneTime: true, editable: false, live: true }, o); };

test('modes: read / live / edit from a meta or an entry; editable wins', function () {
  assert.strictEqual(C.modeOf(null), 'read');
  assert.strictEqual(C.modeOf({ editable: false }), 'read');
  assert.strictEqual(C.modeOf({ live: true }), 'live');
  assert.strictEqual(C.modeOf({ editable: true, live: true }), 'edit');
  assert.strictEqual(C.staysLive({ live: true }), true);
  assert.strictEqual(C.staysLive({}), false);
  assert.deepStrictEqual([{}, { live: true }, { editable: true }].map(C.modeWord), ['read-only', 'watch live', 'editable']);
});
test('watch live: meta + sealed head round trip; the view needs both to say live', function () {
  var k = C.newKey(), id = C.newId();
  var h = C.makeHead({ title: 'Live plan', live: true, scripts: ['sort'], copy: true });
  assert.deepStrictEqual(h, { title: 'Live plan', copy: true, icon: '', timer: true, scripts: [], live: true }, 'no tidy-up tools for a live view');
  assert.strictEqual(C.makeHead({ editable: true, live: true }).live, false, 'edit is not live view');
  return C.seal(k, id, 'head', h).then(function (ct) {
    assert(ct.indexOf('live') < 0);
    return C.open(k, id, 'head', ct);
  }).then(function (o) {
    var head = C.readHead(o);
    assert.deepStrictEqual(head, h);
    assert.strictEqual(C.viewOf(liveMeta(), head), 'live');
    assert.strictEqual(C.viewOf(liveMeta(), C.readHead({ title: 'x' })), 'read', 'a head without live (tampered / mismatched): the snapshot');
    assert.strictEqual(C.viewOf(liveMeta({ live: false }), head), 'read');
    assert.strictEqual(C.viewOf(liveMeta({ editable: true }), head), 'edit');
    assert.strictEqual(C.viewOf({ v: 2, maxOpens: 1, editable: false }, C.readHead({ title: 'x' })), 'read');
    assert.strictEqual(C.readHead({ live: 'yes' }).live, false, 'only a real true');
    // the owner's synced list keeps the mode (and never both)
    var b = C.normBlob({ shares: [entry({ v: 2, maxOpens: 1, live: true }), entry({ v: 2, maxOpens: 1, live: true, editable: true }), entry({})] }).shares;
    assert.deepStrictEqual(b.map(C.modeOf), ['live', 'edit', 'read']);
    assert.strictEqual(b[0].live, true); assert.strictEqual(b[1].live, false);
  });
});
test('watch live: slots and lifetime exactly like editable (claims, reopen, never burned after reading)', function () {
  var now = 5000;
  // one person: the first browser holds it, comes back to it; a second is refused as "claimed"
  assert.deepStrictEqual(C.gate({ meta: liveMeta(), claims: null }, now, 'me'), { ok: true, needClaim: true });
  assert.deepStrictEqual(C.gate({ meta: liveMeta(), claims: { me: 1 } }, now, 'me'), { ok: true, needClaim: false });
  assert.deepStrictEqual(C.gate({ meta: liveMeta(), claims: { other: 1 } }, now, 'me'), { ok: false, why: 'claimed' });
  assert.deepStrictEqual(C.gate({ meta: liveMeta({ editable: true, live: false }), claims: { other: 1 } }, now, 'me'), { ok: false, why: 'claimed' }, 'same as editable');
  assert.deepStrictEqual(C.gate({ meta: liveMeta({ maxOpens: 3, oneTime: false }), claims: { a: 1, b: 1, c: 1 } }, now, 'me'), { ok: false, why: 'claimed' });
  assert.deepStrictEqual(C.gate({ meta: liveMeta({ expiresAt: 5000 }) }, now, 'me'), { ok: false, why: 'expired' });
  assert.deepStrictEqual(C.gate({ meta: liveMeta(), tomb: { why: 'revoked' } }, now, 'me'), { ok: false, why: 'revoked' });
  // the text stays on the server while the link is alive
  assert.strictEqual(C.burnsAfterRead(liveMeta(), { a: 1 }), false);
  assert.strictEqual(C.burnsAfterRead(liveMeta({ maxOpens: 2, oneTime: false }), { a: 1, b: 1 }), false);
  var srv = fakeServer(null);
  var claim = function (me) { var r = srv.transact(function (cur) { return C.claimsUpdate(cur, me, 1, 1); }, null); return C.holdsSlot(r.val, me); };
  assert.deepStrictEqual([claim('a'), claim('b'), claim('a')], [true, false, true]);
  // the owner's sweep keeps a full live link (only the timer, revoke or the server ending it end it)
  var e = entry({ v: 2, maxOpens: 1, live: true, expiresAt: 600000 });
  assert.deepStrictEqual(C.sweepAction(e, { meta: liveMeta(), claims: { a: 1 } }, 1e5), { act: 'keep' });
  assert.deepStrictEqual(C.sweepAction(e, { meta: liveMeta(), claims: { a: 1 } }, 600000), { act: 'tomb', why: 'expired' });
  assert.deepStrictEqual(C.sweepAction(e, { meta: liveMeta(), tomb: { why: 'revoked' } }, 10), { act: 'end', why: 'revoked' });
  // status: who's watching
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: { a: 1 }, presence: { a: {} } }, 0).label, 'Live · 1 watching');
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: { a: 1 }, presence: { a: {} } }, 0).state, 'live');
  assert.strictEqual(C.statusOf(entry({ v: 2, maxOpens: 3, live: true }), { meta: {}, claims: { a: 1, b: 1 }, presence: { a: {}, b: {} } }, 0).label, 'Live · 2 watching · 2 of 3 opened');
  assert.strictEqual(C.statusOf(e, { meta: {}, claims: { a: 1 } }, 0).label, 'Opened — not open now');
});
test('watch live: older clients (v2 code) see a snapshot and don\'t crash', function () {
  // The previous release's burn-core, from git history (skipped where the history isn't there).
  var src;
  try { src = require('child_process').execSync('git show 65d0c45:txt/widgets/burn/burn-core.js', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { console.log('  (skipped the v2-client check: no git history)'); return; }
  var mod = { exports: {} };
  new Function('module', 'window', src)(mod, undefined);
  var Old = mod.exports;
  assert(Old.gate && !Old.modeOf, 'loaded the v2 core');
  var k = C.newKey(), id = C.newId(), meta = liveMeta();
  // what a v3 owner writes for a live link: everything v2 code reads is there, editable stays false
  assert.strictEqual(meta.editable, false); assert.strictEqual(Old.capOf(meta), 1);
  assert.deepStrictEqual(Old.gate({ meta: meta, claims: null }, 1, 'me'), { ok: true, needClaim: true });
  return C.seal(k, id, 'head', C.makeHead({ title: 'Live plan', live: true })).then(function (ct) { return Old.open(k, id, 'head', ct); }).then(function (o) {
    var h = Old.readHead(o);
    assert.strictEqual(h.title, 'Live plan'); assert.deepStrictEqual(h.scripts, []);
    // v2 code shows it read-only (no textarea, no tools) — and new code reading a v2 link is unchanged
    assert.strictEqual(!!meta.editable, false);
    assert.strictEqual(C.viewOf({ v: 2, maxOpens: 1, oneTime: true, editable: false }, C.readHead(o)), 'read');
    assert.strictEqual(C.viewOf({ v: 2, maxOpens: 1, oneTime: true, editable: true }, C.readHead({})), 'edit');
  });
});
test('watch live: the owner NEVER takes a version from the share into the room (forged writes)', function () {
  var k = C.newKey(), id = C.newId(), room = 'Owner text v1', applied = 0, saved = null, gone = 0, d, live;
  var write = function (ver, t, by) { return C.seal(k, id, 'v' + ver, { t: t }).then(function (ct) { d.set({ ver: ver, ct: ct, by: by, base: ver - 1, at: 1 }); return ct; }); };
  var shown = function () { var v = d.get(); return C.open(k, id, 'v' + v.ver, v.ct).then(function (x) { return x.t; }); };
  return C.seal(k, id, 'v1', { t: room }).then(function (ct1) {
    d = fakeDoc({ ver: 1, ct: ct1, by: 'o:create', base: 0, at: 1 });
    live = C.LiveDoc({
      ref: d.ref, id: id, key: k, me: 'o:dev1', now: function () { return 5; }, merge: M, pushMs: 5, pushOnly: true,
      get: function () { return room; },
      apply: function () { applied++; room = 'TAKEN FROM THE SHARE'; return Promise.resolve(); },     // must never run
      loadBase: function () { return Promise.resolve({ ver: 1, text: 'Owner text v1' }); },
      saveBase: function (sh) { saved = sh; }, onGone: function () { gone++; }
    });
    assert.strictEqual(live.pushOnly, true);
    return settle(40);
  }).then(function () {
    assert.strictEqual(d.get().ver, 1, 'in step: nothing to push');
    // 1. someone with the key writes their own version: never applied; the room's text goes back on top
    return write(2, 'EVIL — merge me', 'g:intruder').then(function () { return settle(80); });
  }).then(function () {
    assert.strictEqual(applied, 0); assert.strictEqual(room, 'Owner text v1');
    assert.strictEqual(d.get().ver, 3); assert.strictEqual(d.get().by, 'o:dev1');
    return shown();
  }).then(function (t) {
    assert.strictEqual(t, 'Owner text v1', 'the owner\'s text is back');
    // 2. a forger posing as an owner device: still never applied; the owner's next edit lands on top
    return write(4, 'EVIL 2', 'o:spoofed').then(function () { return settle(60); });
  }).then(function () {
    assert.strictEqual(applied, 0); assert.strictEqual(room, 'Owner text v1'); assert.strictEqual(d.get().ver, 4);
    room = 'Owner text v2'; live.changed();
    return settle(60);
  }).then(function () {
    assert.strictEqual(d.get().ver, 5); assert.strictEqual(d.get().by, 'o:dev1');
    return shown();
  }).then(function (t) {
    assert.strictEqual(t, 'Owner text v2');
    // 3. garbage ciphertext: not applied, replaced
    d.set({ ver: 6, ct: '1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', by: 'o:x' });
    return settle(80);
  }).then(function () {
    assert.strictEqual(d.get().ver, 7); assert.strictEqual(applied, 0);
    // 4. an older version number (a replay of v2's ciphertext): the next push still goes above everything seen
    return C.seal(k, id, 'v2', { t: 'EVIL replay' }).then(function (ct) { d.set({ ver: 2, ct: ct, by: 'o:x' }); return settle(40); });
  }).then(function () {
    assert.strictEqual(applied, 0); assert.strictEqual(room, 'Owner text v2');
    room = 'Owner text v3'; live.changed();
    return settle(60);
  }).then(function () {
    assert.strictEqual(d.get().ver, 8, 'above the highest version seen (7)');
    // 5. a version number that isn't one: not applied, no endless retries
    var before = d.txns;
    d.set({ ver: { x: 1 }, ct: 42, by: 'g:x' });
    return settle(150).then(function () {
      assert(d.txns - before <= 3, 'bounded: ' + (d.txns - before));
      assert.strictEqual(d.get().ver, 9); assert.strictEqual(applied, 0); assert.strictEqual(room, 'Owner text v3');
      assert(saved && saved.text === 'Owner text v3', 'base = last agreed text');
      // revoke (doc gone) stops it
      d.set(null);
      return settle(20);
    });
  }).then(function () {
    assert.strictEqual(gone, 1); assert.strictEqual(d.listeners(), 0);
    assert.strictEqual(applied, 0);
  });
});
test('watch live: an owner device starts quiet when its copy is stale, pushes what it changed while closed', function () {
  var k = C.newKey(), id = C.newId();
  function run(base, local, server) {
    return C.seal(k, id, 'v5', { t: server }).then(function (ct) {
      var d = fakeDoc({ ver: 5, ct: ct, by: 'o:other', base: 4, at: 1 });
      var l = C.LiveDoc({ ref: d.ref, id: id, key: k, me: 'o:me', now: function () { return 1; }, merge: M, pushMs: 5, pushOnly: true,
        get: function () { return local; }, loadBase: function () { return Promise.resolve(base); }, saveBase: function () {}, onGone: function () {} });
      return settle(50).then(function () { l.stop(); return d.get(); });
    });
  }
  return Promise.all([
    run({ ver: 3, text: 'old' }, 'old', 'newer from my other device'),        // stale copy here: stay quiet
    run({ ver: 3, text: 'old' }, 'edited here', 'old'),                       // changed while closed: send it
    run(null, 'something', 'other')                                           // never in step: leave it
  ]).then(function (r) {
    assert.strictEqual(r[0].ver, 5); assert.strictEqual(r[1].ver, 6); assert.strictEqual(r[1].by, 'o:me'); assert.strictEqual(r[2].ver, 5);
  });
});
test('two-way editing still merges a remote version (the control for the rule above)', function () {
  var k = C.newKey(), id = C.newId(), local = 'one\ntwo', got = [];
  return C.seal(k, id, 'v1', { t: 'one\ntwo' }).then(function (ct1) {
    var d = fakeDoc({ ver: 1, ct: ct1, by: 'o:create' });
    var l = C.LiveDoc({ ref: d.ref, id: id, key: k, me: 'o:me', now: function () { return 1; }, merge: M, pushMs: 5,
      get: function () { return local; }, apply: function (m) { got.push(m); local = m; return Promise.resolve(); },
      loadBase: function () { return Promise.resolve({ ver: 1, text: 'one\ntwo' }); }, saveBase: function () {}, onGone: function () {} });
    return settle(20).then(function () { return C.seal(k, id, 'v2', { t: 'one\ntwo\nthree' }); })
      .then(function (ct) { d.set({ ver: 2, ct: ct, by: 'g:guest' }); return settle(40); })
      .then(function () { l.stop(); assert.deepStrictEqual(got, ['one\ntwo\nthree']); });
  });
});
test('watch live: the reader follows newer versions only, skips ones that don\'t open, ends when the doc goes', function () {
  var k = C.newKey(), id = C.newId(), shown = [], gone = 0, d, f;
  var put = function (ver, t) { return C.seal(k, id, 'v' + ver, { t: t }).then(function (ct) { d.set({ ver: ver, ct: ct, by: 'o:x' }); }); };
  return C.seal(k, id, 'v3', { t: 'three' }).then(function (ct) {
    d = fakeDoc({ ver: 3, ct: ct, by: 'o:x' });
    f = C.Follow({ ref: d.ref, id: id, key: k, ver: 3, show: function (t, v) { shown.push(v + ':' + t); }, onGone: function () { gone++; } });
    return settle(20);
  }).then(function () {
    assert.deepStrictEqual(shown, [], 'the version already shown');
    return put(4, 'four').then(function () { return settle(20); });
  }).then(function () {
    d.set({ ver: 5, ct: '1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', by: 'g:x' });
    return put(2, 'two (older)').then(function () { return settle(20); });
  }).then(function () {
    return put(6, 'six').then(function () { return settle(20); });
  }).then(function () {
    assert.deepStrictEqual(shown, ['4:four', '6:six']);
    assert.strictEqual(f.shown, 6);
    d.set(null);
    return settle(10);
  }).then(function () { assert.strictEqual(gone, 1); assert.strictEqual(d.listeners(), 0); });
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
