/* Checks for the Clipboard feed: the pure model (records, truncation, previews,
 * URLs, ordering, retention), the Feed over a fake Firebase reference tree
 * (add / dedupe / prune / pin / delete / clear / blobs / two devices / sealed
 * round trip), the local store, the capture plugin (debounce, guards, refcounted
 * lifecycle, writeText wrap + restore, the "from another device" chip) and the
 * widget's registration metadata. Not loaded by the app.
 * Run: node txt/widgets/clipfeed/clipfeed.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs'), path = require('path');
var M = require('./clipfeed-model.js');
var CAPSRC = fs.readFileSync(path.join(__dirname, 'clipfeed-capture.js'), 'utf8');
var CAP = require('./clipfeed-capture.js');

// The manifest entries this module ships with (txt/manifest.json must match).
var EXPECTED = {
  widget: {
    id: 'clipfeed', type: 'widget', name: 'Clipboard',
    description: 'Synced clipboard feed — copy on one device, tap the card to copy it on another (text, links and images)',
    icon: '📋',
    tags: 'clipboard,copy,paste,sync,devices,share,transfer,history,feed,phone,laptop,image,screenshot,link,universal clipboard',
    entry: 'widgets/clipfeed/clipfeed.js', css: 'widgets/clipfeed/clipfeed.css',
    precache: ['widgets/clipfeed/clipfeed-model.js'],
  },
  plugin: {
    id: 'clipfeed-capture', type: 'plugin', name: 'Share copies to my Clipboard feed',
    description: 'Text you copy or cut in the app (and what its Copy buttons copy) goes to the Clipboard widget\'s feed — synced to your other devices when Sync is set up, end-to-end encrypted. Passwords and the Clipboard\'s own copies are skipped',
    entry: 'widgets/clipfeed/clipfeed-capture.js',
    precache: ['widgets/clipfeed/clipfeed-model.js'],
    settingKey: 'plugins.clipfeed-capture', section: 'Devices', default: true,
  },
};

var tests = [], passed = 0;
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function settle(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 8); i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
function withCaps(caps, fn) {
  var old = {};
  Object.keys(caps).forEach(function (k) { old[k] = M.C[k]; M.C[k] = caps[k]; });
  return Promise.resolve().then(fn).then(function (r) { Object.keys(old).forEach(function (k) { M.C[k] = old[k]; }); return r; },
    function (e) { Object.keys(old).forEach(function (k) { M.C[k] = old[k]; }); throw e; });
}

// ---- fake Firebase (compat) database: the subset the feed uses -------------------------------
function FakeDB() { this.tree = {}; this.L = []; this.t = 1760000000000; this.pid = M.makePushIds(); this.reads = 0; }
function segs(p) { return String(p || '').split('/').filter(Boolean); }
FakeDB.prototype.now = function () { return this.t; };
FakeDB.prototype.get = function (p) {
  var n = this.tree, s = segs(p);
  for (var i = 0; i < s.length; i++) { if (!n || typeof n !== 'object') return null; n = n[s[i]]; }
  return n == null ? null : n;
};
FakeDB.prototype.resolve = function (v) {
  var self = this;
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return self.t;
    var o = {};
    Object.keys(v).forEach(function (k) { var x = self.resolve(v[k]); if (x != null) o[k] = x; });
    return Object.keys(o).length ? o : null;
  }
  return v;
};
FakeDB.prototype.put = function (p, v) {
  var s = segs(p), n = this.tree;
  v = this.resolve(clone(v));
  if (!s.length) { this.tree = v || {}; return; }
  var stack = [];
  for (var i = 0; i < s.length - 1; i++) {
    if (!n[s[i]] || typeof n[s[i]] !== 'object') { if (v == null) return; n[s[i]] = {}; }
    stack.push([n, s[i]]);
    n = n[s[i]];
  }
  if (v == null) delete n[s[s.length - 1]]; else n[s[s.length - 1]] = v;
  for (var j = stack.length - 1; j >= 0; j--) { var par = stack[j][0], k = stack[j][1]; if (par[k] && !Object.keys(par[k]).length) delete par[k]; }
};
FakeDB.prototype.write = function (ops) {
  var self = this;
  ops.forEach(function (o) { self.put(o[0], o[1]); });
  this.L.slice().forEach(function (l) { if (l.primed) self.fire(l); });
};
FakeDB.prototype.fire = function (l) {
  var cur = l.ref.view(), last = l.last;
  if (l.type === 'value') { if (JSON.stringify(cur) !== JSON.stringify(last)) { l.last = cur; l.cb(snap(l.ref.key, cur)); } return; }
  var a = cur && typeof cur === 'object' ? cur : {}, b = last && typeof last === 'object' ? last : {};
  l.last = cur;
  Object.keys(b).forEach(function (k) { if (!(k in a) && l.type === 'child_removed') l.cb(snap(k, b[k])); });
  Object.keys(a).sort().forEach(function (k) {
    if (!(k in b)) { if (l.type === 'child_added') l.cb(snap(k, a[k])); }
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k]) && l.type === 'child_changed') l.cb(snap(k, a[k]));
  });
};
FakeDB.prototype.ref = function (p) { return new FRef(this, segs(p).join('/'), null); };
function snap(key, v) {
  v = clone(v);
  return { key: key, val: function () { return clone(v); }, exists: function () { return v != null; } };
}
function FRef(db, p, q) { this.db = db; this.path = p; this.q = q; var s = segs(p); this.key = s.length ? s[s.length - 1] : null; }
FRef.prototype.child = function (p) { return new FRef(this.db, segs(this.path + '/' + p).join('/'), null); };
FRef.prototype.push = function (v) { var r = this.child(this.db.pid(this.db.now())); if (v !== undefined) r.set(v); return r; };
FRef.prototype.set = function (v) { this.db.write([[this.path, v]]); return Promise.resolve(); };
FRef.prototype.update = function (o) {
  var self = this, ops = Object.keys(o).map(function (k) { return [self.path + '/' + k, o[k]]; });
  this.db.write(ops);
  return Promise.resolve();
};
FRef.prototype.remove = function () { return this.set(null); };
FRef.prototype.orderByKey = function () { return new FRef(this.db, this.path, { limit: 0 }); };
FRef.prototype.limitToLast = function (n) { return new FRef(this.db, this.path, { limit: n }); };
FRef.prototype.view = function () {
  var v = this.db.get(this.path);
  if (!this.q || !v || typeof v !== 'object') return clone(v);
  var ks = Object.keys(v).sort();
  if (this.q.limit) ks = ks.slice(-this.q.limit);
  if (!ks.length) return null;
  var o = {};
  ks.forEach(function (k) { o[k] = clone(v[k]); });
  return o;
};
FRef.prototype.once = function () { var self = this; this.db.reads++; return Promise.resolve().then(function () { return snap(self.key, self.view()); }); };
FRef.prototype.on = function (type, cb) {
  var self = this, l = { ref: this, type: type, cb: cb, last: null, primed: false };
  this.db.L.push(l);
  Promise.resolve().then(function () {   // initial data arrives a moment later, like the server's
    if (self.db.L.indexOf(l) < 0) return;
    l.primed = true;
    self.db.fire(l);
  });
  return cb;
};
FRef.prototype.off = function (type, cb) {
  var self = this;
  this.db.L = this.db.L.filter(function (l) { return !(l.ref.path === self.path && l.type === type && l.cb === cb); });
};

function seal(o) { return Promise.resolve('enc:' + Buffer.from(JSON.stringify(o)).toString('base64')); }
function unseal(s) {
  if (typeof s !== 'string' || s.indexOf('enc:') !== 0) return Promise.resolve(null);
  try { return Promise.resolve(JSON.parse(Buffer.from(s.slice(4), 'base64').toString('utf8'))); } catch (e) { return Promise.resolve(null); }
}
var BASE = 'rooms/__cade_cb_fp';
function cloudFeed(db, dev) {
  var store = new M.CloudStore({
    ref: function (sub) { return Promise.resolve(db.ref(BASE + (sub ? '/' + sub : ''))); },
    seal: seal, unseal: unseal, timestamp: function () { return { '.sv': 'timestamp' }; }, retryMs: 1,
  });
  return new M.Feed(store, { device: function () { return dev || { id: 'dev1', name: 'Mac · Chrome' }; }, now: function () { return db.now(); } });
}
function memKV() {
  var m = {};
  return {
    m: m,
    get: function (k) { return Promise.resolve(k in m ? clone(m[k]) : null); },
    set: function (k, v) { m[k] = clone(v); return Promise.resolve(true); },
    remove: function (k) { delete m[k]; return Promise.resolve(); },
  };
}
function fakeChannels() {   // BroadcastChannel stand-in: delivers to every OTHER channel object
  var all = [];
  return function () {
    var c = { onmessage: null, closed: false,
      postMessage: function (msg) { var d = clone(msg); all.forEach(function (o) { if (o !== c && !o.closed && o.onmessage) o.onmessage({ data: d }); }); },
      close: function () { c.closed = true; all.splice(all.indexOf(c), 1); } };
    all.push(c);
    return c;
  };
}
function texts(feed) { return feed.list().map(function (e) { return e.rec ? (e.rec.t || '[img]') : '?'; }); }
function decryptAll(feed) { return Promise.all(feed.list().map(function (e) { return feed.decrypt(e.key); })); }

// =====================================================================================
// pure helpers
// =====================================================================================
test('push ids: Firebase format, strictly increasing within a millisecond, time decodes back', function () {
  var gen = M.makePushIds(), t = 1760000000123, a = gen(t), b = gen(t), c = gen(t + 1);
  assert.strictEqual(a.length, 20);
  assert.ok(a < b && b < c, a + ' ' + b + ' ' + c);
  assert.strictEqual(M.keyTime(a), t);
  assert.strictEqual(M.keyTime(c), t + 1);
  assert.strictEqual(M.keyTime('short'), 0);
  assert.strictEqual(M.keyTime('!!!!!!!!xx'), 0);
});
test('text cap: long text truncated with a note, never splitting a surrogate pair', function () {
  var r = M.capText('abc', 10);
  assert.deepStrictEqual(r, { t: 'abc', cut: 0 });
  var s = 'x'.repeat(9) + '😀' + 'tail';
  var c = M.capText(s, 10);
  assert.strictEqual(c.cut, s.length);
  assert.ok(c.t.indexOf('x'.repeat(9) + '\n\n… [truncated — ') === 0, c.t);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c.t), 'no lone high surrogate');
  var big = M.capText('y'.repeat(M.C.TEXT_MAX + 5000));
  assert.ok(big.cut > 0 && big.t.length < M.C.TEXT_MAX + 80 && /104\.9 KB|105 KB/.test(big.t), big.t.slice(-60));
});
test('records: short text inline; long text → preview + blob; images validated; hash of the original', function () {
  var dev = { id: 'd1', name: 'iPhone' };
  var a = M.buildRecord({ text: 'hello' }, dev, 5);
  assert.strictEqual(a.kind, 't');
  assert.strictEqual(a.blob, null);
  assert.deepStrictEqual([a.rec.t, a.rec.by, a.rec.did, a.rec.at], ['hello', 'iPhone', 'd1', 5]);
  assert.strictEqual(a.rec.h, M.hash('hello'));
  assert.strictEqual(M.buildRecord({ text: '  \n\t ' }, dev, 5).error, 'empty');
  var long = 'line\n'.repeat(2000);
  var b = M.buildRecord({ text: long }, dev, 5);
  assert.strictEqual(b.rec.t.length, M.C.PREVIEW_MAX);
  assert.deepStrictEqual(b.rec.big, { n: long.length, lines: 2001 });
  assert.strictEqual(b.blob.t, long);
  var huge = 'z'.repeat(M.C.TEXT_MAX * 2);
  var h = M.buildRecord({ text: huge }, dev, 5);
  assert.strictEqual(h.rec.cut, huge.length);
  assert.strictEqual(h.rec.h, M.hash(huge), 'dedupe hash covers the whole original');
  assert.ok(h.blob.t.length < M.C.TEXT_MAX + 80);
  var img = M.buildRecord({ img: { w: 10, h: 20, thumb: 'data:image/jpeg;base64,AAAA' }, full: 'data:image/webp;base64,BBBB' }, dev, 5);
  assert.strictEqual(img.kind, 'i');
  assert.deepStrictEqual(img.rec.img, { w: 10, h: 20, thumb: 'data:image/jpeg;base64,AAAA' });
  assert.deepStrictEqual(img.blob, { d: 'data:image/webp;base64,BBBB' });
  assert.strictEqual(M.buildRecord({ img: { thumb: 'javascript:alert(1)' } }, dev, 5).error, 'bad image');
  assert.strictEqual(M.buildRecord({ img: { thumb: 'data:image/png;base64,AA' }, full: 'data:image/png;base64,' + 'A'.repeat(M.C.IMG_MAX) }, dev, 5).error, 'image too large');
});
test('cleanRec: keeps typed fields only; rejects junk and unsafe images', function () {
  assert.strictEqual(M.cleanRec(null), null);
  assert.strictEqual(M.cleanRec({ by: 'x' }), null);
  assert.strictEqual(M.cleanRec({ img: { thumb: 'data:text/html;base64,AA' } }), null);
  var r = M.cleanRec({ t: 'hi', by: 'B'.repeat(100), did: 7, at: 'x', extra: 1, big: { n: '9', lines: 2 } });
  assert.deepStrictEqual(r, { by: 'B'.repeat(60), did: '', at: 0, h: '', t: 'hi', big: { n: 9, lines: 2 } });
});
test('preview: first 6 lines, the rest counted; very long lines clipped', function () {
  var t = [1, 2, 3, 4, 5, 6, 7, 8, 9].join('\n');
  var p = M.preview(t);
  assert.strictEqual(p.head, '1\n2\n3\n4\n5\n6');
  assert.strictEqual(p.more, 3);
  assert.deepStrictEqual(M.preview('one'), { head: 'one', more: 0, clipped: false });
  var q = M.preview('a'.repeat(2000));
  assert.ok(q.clipped && q.head.length === 600 && q.more === 0);
  assert.strictEqual(M.preview('a\nb', 6, 600, 40).more, 38, 'total lines of a long text (only its preview at hand)');
  assert.strictEqual(M.preview('a\n\n\n').head, 'a', 'trailing blank lines trimmed');
});
test('URLs: domain, link-only detection, trailing punctuation, http(s) only', function () {
  assert.deepStrictEqual(M.findUrl('https://www.example.com/a?b=1'), { url: 'https://www.example.com/a?b=1', host: 'example.com', only: true });
  var u = M.findUrl('see (https://en.wikipedia.org/wiki/Foo_(bar)) and https://x.y.');
  assert.strictEqual(u.url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.strictEqual(u.only, false);
  assert.strictEqual(M.findUrl('go to http://a.io.').url, 'http://a.io');
  assert.strictEqual(M.findUrl('javascript:alert(1)'), null);
  assert.strictEqual(M.findUrl('no link here'), null);
  assert.strictEqual(M.findUrl('  https://a.io/x  ').only, true);
});
test('relative time', function () {
  var n = Date.UTC(2026, 9, 21, 12, 0, 0);
  assert.strictEqual(M.relTime(n - 10e3, n), 'just now');
  assert.strictEqual(M.relTime(n + 5e3, n), 'just now', 'a clock a little ahead is not "in the future"');
  assert.strictEqual(M.relTime(n - 2 * 60e3, n), '2 min ago');
  assert.strictEqual(M.relTime(n - 3 * 3600e3, n), '3 h ago');
  assert.strictEqual(M.relTime(n - 26 * 3600e3, n), 'yesterday');
  assert.strictEqual(M.relTime(n - 4 * 864e5, n), '4 days ago');
  assert.ok(/^[A-Z][a-z]{2} \d+$/.test(M.relTime(n - 20 * 864e5, n)));
  assert.ok(/, 2024$/.test(M.relTime(Date.UTC(2024, 1, 3), n)));
  assert.strictEqual(M.relTime(0, n), '');
});
test('order + retention plan: pinned first then newest; prune keeps CAP newest unpinned ≤ MAX_AGE, never pins', function () {
  var es = [{ key: 'a', at: 1, p: false }, { key: 'b', at: 3, p: false }, { key: 'c', at: 2, p: true }, { key: 'd', at: 3, p: false }];
  assert.deepStrictEqual(es.sort(M.cmp).map(function (e) { return e.key; }), ['c', 'd', 'b', 'a']);
  var now = 100 * 864e5, idx = {};
  for (var i = 0; i < 8; i++) idx['k' + i] = { at: now - i * 1000, p: 0 };
  idx.old = { at: now - 31 * 864e5, p: 0 };
  idx.oldpin = { at: now - 400 * 864e5, p: 1 };
  idx.pin2 = { at: now - 9000, p: 1 };
  assert.deepStrictEqual(M.planPrune(idx, now, 5, 30 * 864e5).sort(), ['k5', 'k6', 'k7', 'old']);
  assert.deepStrictEqual(M.planPrune(idx, now, 100, 30 * 864e5), ['old']);
  assert.strictEqual(M.pinCount(idx), 2);
  var gen = M.makePushIds(), k = gen(now - 40 * 864e5), idx2 = {};
  idx2[k] = {};   // no at: falls back to the push id's time
  assert.deepStrictEqual(M.planPrune(idx2, now), [k]);
});
test('matches: filter over text, device name, "image"', function () {
  assert.ok(M.matches({ t: 'Hello World', by: 'iPhone' }, 'world'));
  assert.ok(M.matches({ t: 'x', by: 'iPhone' }, 'iphone'));
  assert.ok(M.matches({ img: { thumb: 'd' }, by: 'Mac' }, 'imag'));
  assert.ok(!M.matches({ t: 'x', by: 'Mac' }, 'zzz'));
  assert.ok(!M.matches(null, 'x'));
  assert.ok(M.matches(null, ''));
});

// =====================================================================================
// Feed over the fake Firebase tree
// =====================================================================================
test('cloud feed: add → sealed item + idx (+ server time), live child_added, decrypt round trip, newest first', function () {
  var db = new FakeDB(), f = cloudFeed(db), events = [];
  var detach = f.attach(function (t) { events.push(t); });
  return settle().then(function () {
    assert.ok(f.loaded, 'ready after the first load');
    return f.add({ text: 'first' });
  }).then(function (r) {
    assert.ok(r.key);
    var item = db.get(BASE + '/items/' + r.key);
    assert.strictEqual(item.k, 't');
    assert.strictEqual(item.at, db.t, 'server timestamp resolved');
    assert.ok(/^enc:/.test(item.s) && item.s.indexOf('first') === -1, 'sealed, no plaintext on the server');
    assert.deepStrictEqual(db.get(BASE + '/idx/' + r.key), { at: db.t, p: 0 });
    assert.strictEqual(db.get(BASE + '/blobs/' + r.key), null);
    db.t += 1000;
    return f.add({ text: 'second' });
  }).then(function () {
    return decryptAll(f);
  }).then(function () {
    assert.deepStrictEqual(texts(f), ['second', 'first']);
    assert.ok(events.indexOf('add') >= 0 && events.indexOf('change') >= 0 && events.indexOf('ready') >= 0);
    var e = f.list()[0];
    assert.strictEqual(e.rec.by, 'Mac · Chrome');
    assert.strictEqual(e.rec.did, 'dev1');
    assert.strictEqual(e.st, 1);
    detach();
    assert.ok(!f.attached() && db.L.length === 0, 'listeners off after the last detach');
  });
});
test('cloud feed: exact repeat of the newest is a no-op (attached and detached); blanks skipped', function () {
  var db = new FakeDB(), f = cloudFeed(db), g = cloudFeed(db, { id: 'dev2', name: 'iPhone' });
  return f.add({ text: 'same' }).then(function () { db.t += 10; return f.add({ text: 'same' }); }).then(function (r) {
    assert.ok(r.dup, 'detached: via store.newest()');
    return g.add({ text: 'same' });
  }).then(function (r) {
    assert.ok(r.dup, 'another device copying the same thing again');
    return f.add({ text: '   ' });
  }).then(function (r) {
    assert.strictEqual(r.skipped, 'empty');
    var d = f.attach(function () {});
    return settle().then(function () { db.t += 10; return f.add({ text: 'same' }); }).then(function (r2) {
      assert.ok(r2.dup, 'attached: from the live map');
      db.t += 10;
      return f.add({ text: 'other' });
    }).then(function () { db.t += 10; return f.add({ text: 'same' }); }).then(function (r3) {
      assert.ok(!r3.dup, 'only the newest counts');
      assert.strictEqual(Object.keys(db.get(BASE + '/items')).length, 3);
      d();
    });
  });
});
test('cloud feed: the writer prunes the oldest unpinned beyond CAP (and their blobs); pinned survive; old ones age out', function () {
  return withCaps({ CAP: 3 }, function () {
    var db = new FakeDB(), f = cloudFeed(db), keys = [];
    var chain = Promise.resolve();
    ['a', 'b', 'c'].forEach(function (t) { chain = chain.then(function () { db.t += 1000; return f.add({ text: t + '\n'.repeat(M.C.INLINE_MAX) }); }).then(function (r) { keys.push(r.key); }); });
    return chain.then(function () {
      assert.ok(db.get(BASE + '/blobs/' + keys[0]), 'long text has a blob');
      return f.setPin(keys[0], true);
    }).then(function (r) {
      assert.ok(r.ok);
      assert.strictEqual(db.get(BASE + '/items/' + keys[0]).p, 1);
      assert.strictEqual(db.get(BASE + '/idx/' + keys[0]).p, 1);
      db.t += 1000; return f.add({ text: 'd' });
    }).then(function () { db.t += 1000; return f.add({ text: 'e' }); }).then(function () { return settle(); }).then(function () {
      // unpinned newest 3 = e, d, c; b went (with its blob); a is pinned
      var items = db.get(BASE + '/items'), idx = db.get(BASE + '/idx');
      assert.strictEqual(Object.keys(items).length, 4);
      assert.deepStrictEqual(Object.keys(items).sort(), Object.keys(idx).sort());
      assert.strictEqual(items[keys[1]], undefined);
      assert.strictEqual(db.get(BASE + '/blobs/' + keys[1]), null, 'its blob too');
      assert.ok(items[keys[0]] && items[keys[2]]);
      db.t += 31 * 864e5;   // a month later, an open widget prunes what aged out
      return f.prune();
    }).then(function (n) {
      assert.strictEqual(n, 3);
      assert.deepStrictEqual(Object.keys(db.get(BASE + '/items')), [keys[0]], 'only the pinned one is left');
      assert.ok(db.get(BASE + '/blobs/' + keys[0]), 'and its blob');
    });
  });
});
test('cloud feed: pin cap, unpin, delete one, clear (pinned stay) and clear everything', function () {
  return withCaps({ PIN_CAP: 2 }, function () {
    var db = new FakeDB(), f = cloudFeed(db), keys = [];
    var chain = Promise.resolve();
    [1, 2, 3, 4].forEach(function (n) { chain = chain.then(function () { db.t += 100; return f.add({ text: 'n' + n }); }).then(function (r) { keys.push(r.key); }); });
    var d = f.attach(function () {});
    return chain.then(function () { return f.setPin(keys[0], true); }).then(function () { return f.setPin(keys[1], true); })
      .then(function () { return f.setPin(keys[2], true); }).then(function (r) {
        assert.deepStrictEqual(r, { ok: false, reason: 'cap' });
        return f.setPin(keys[1], true);
      }).then(function (r) {
        assert.ok(r.ok, 're-pinning a pinned one is fine at the cap');
        return f.setPin('nope', true);
      }).then(function (r) {
        assert.deepStrictEqual(r, { ok: false, reason: 'gone' });
        return settle();
      }).then(function () { return decryptAll(f); }).then(function () {
        assert.deepStrictEqual(texts(f), ['n2', 'n1', 'n4', 'n3'], 'pinned first, each group newest first');
        return f.setPin(keys[1], false);
      }).then(function () {
        assert.strictEqual(db.get(BASE + '/items/' + keys[1]).p, undefined);
        assert.strictEqual(db.get(BASE + '/idx/' + keys[1]).p, 0);
        return f.remove(keys[3]);
      }).then(function () {
        assert.strictEqual(db.get(BASE + '/items/' + keys[3]), null);
        return settle();
      }).then(function () {
        assert.strictEqual(f.counts().n, 3);
        return f.clear(false);
      }).then(function (n) {
        assert.strictEqual(n, 2);
        return settle();
      }).then(function () {
        assert.deepStrictEqual(Object.keys(db.get(BASE + '/items')), [keys[0]]);
        assert.deepStrictEqual(f.counts(), { n: 1, pinned: 1 });
        return f.clear(true);
      }).then(function (n) {
        assert.strictEqual(n, 1);
        assert.strictEqual(db.get(BASE), null, 'nothing left at all');
        d();
      });
  });
});
test('cloud feed: long text and images — preview/thumbnail in the feed, the full thing fetched on demand', function () {
  var db = new FakeDB(), f = cloudFeed(db), long = 'L'.repeat(M.C.INLINE_MAX + 10), kText, kImg;
  var full = 'data:image/webp;base64,' + 'Q'.repeat(5000), thumb = 'data:image/jpeg;base64,' + 'T'.repeat(300);
  var d = f.attach(function () {});
  return settle().then(function () { return f.add({ text: long }); }).then(function (r) {
    kText = r.key;
    db.t += 5;
    return f.add({ img: { w: 1600, h: 900, thumb: thumb }, full: full });
  }).then(function (r) {
    kImg = r.key;
    assert.strictEqual(db.get(BASE + '/items/' + kImg).k, 'i');
    assert.ok(db.get(BASE + '/items/' + kImg).s.length < 2000, 'the feed item holds only the thumbnail');
    return decryptAll(f);
  }).then(function () {
    assert.strictEqual(f.get(kText).rec.t.length, M.C.PREVIEW_MAX);
    assert.strictEqual(f.fullTextNow(kText), null, 'not fetched yet');
    var reads = db.reads;
    return f.fullText(kText).then(function (t) {
      assert.strictEqual(t, long);
      assert.strictEqual(f.fullTextNow(kText), long, 'cached for a synchronous copy');
      return f.fullText(kText);
    }).then(function () { assert.strictEqual(db.reads, reads + 1, 'one read for the blob'); });
  }).then(function () {
    return f.fullImage(kImg);
  }).then(function (img) {
    assert.strictEqual(img, full);
    assert.deepStrictEqual(f.get(kImg).rec.img, { w: 1600, h: 900, thumb: thumb });
    db.ref(BASE + '/blobs/' + kImg).set('enc:' + Buffer.from(JSON.stringify({ d: 'javascript:x' })).toString('base64'));
    f.forget(kImg);
    return f.fullImage(kImg);
  }).then(function (img) {
    assert.strictEqual(img, null, 'a blob that is not an image is refused');
    d();
  });
});
test('cloud feed: two devices see each other live; ownership by device id; changes and deletes propagate', function () {
  var db = new FakeDB(), mac = cloudFeed(db), phone = cloudFeed(db, { id: 'ph', name: 'iPhone' }), seen = [];
  var d1 = mac.attach(function () {}), d2 = phone.attach(function (t, k) { if (t === 'add') seen.push(k); });
  var key;
  return settle().then(function () { return mac.add({ text: 'from the laptop' }); }).then(function (r) {
    key = r.key;
    assert.deepStrictEqual(seen, [key], 'arrived on the phone');
    return phone.decrypt(key);
  }).then(function (rec) {
    assert.strictEqual(rec.t, 'from the laptop');
    assert.strictEqual(rec.did, 'dev1');
    return mac.setPin(key, true);
  }).then(function () {
    assert.ok(phone.get(key).p, 'pin seen on the phone');
    assert.strictEqual(phone.get(key).st, 1, 'pin did not need a re-decrypt');
    return phone.remove(key);
  }).then(function () {
    assert.strictEqual(mac.get(key), null, 'delete seen on the laptop');
    d1(); d2();
  });
});
test('cloud feed: unreadable items (other key) are marked, not fatal; a husk without a record is cleared', function () {
  var db = new FakeDB(), f = cloudFeed(db);
  var d = f.attach(function () {});
  return settle().then(function () {
    db.ref(BASE + '/items/-AAAAAAAbad').set({ s: 'other-key:zzz', at: db.t, k: 't' });
    db.ref(BASE + '/items/-AAAAAAAhusk').set({ p: 1 });
    return settle();
  }).then(function () {
    return f.decrypt('-AAAAAAAbad');
  }).then(function (rec) {
    assert.strictEqual(rec, null);
    assert.strictEqual(f.get('-AAAAAAAbad').st, 2);
    assert.strictEqual(f.get('-AAAAAAAhusk'), null);
    assert.strictEqual(db.get(BASE + '/items/-AAAAAAAhusk'), null, 'deleted');
    d();
  });
});
test('cloud feed: the live window is the newest LIVE_N; re-attach reuses decrypted records', function () {
  return withCaps({ LIVE_N: 3, CAP: 50 }, function () {
    var db = new FakeDB(), f = cloudFeed(db), chain = Promise.resolve();
    [1, 2, 3, 4, 5].forEach(function (n) { chain = chain.then(function () { db.t += 10; return f.add({ text: 'w' + n }); }); });
    return chain.then(function () {
      var d = f.attach(function () {});
      return settle().then(function () { return decryptAll(f); }).then(function () {
        assert.deepStrictEqual(texts(f), ['w5', 'w4', 'w3']);
        d();
        var calls = 0, us = f.store.unseal;
        f.store.unseal = function (s) { calls++; return us.call(f.store, s); };
        var d2 = f.attach(function () {});
        return settle().then(function () {
          assert.ok(f.list().every(function (e) { return e.st === 1; }), 'already decrypted');
          assert.strictEqual(calls, 0);
          d2();
        });
      });
    });
  });
});
test('cloud store: waits for the database library (null ref) and then works; listen reports connecting', function () {
  var db = new FakeDB(), tries = 0, statuses = [];
  var store = new M.CloudStore({
    ref: function (sub) { tries++; return Promise.resolve(tries < 3 ? null : db.ref(BASE + (sub ? '/' + sub : ''))); },
    seal: seal, unseal: unseal, timestamp: function () { return db.t; }, retryMs: 1,
  });
  var f = new M.Feed(store, { device: { id: 'x', name: 'X' }, now: function () { return db.t; } });
  return f.add({ text: 'late' }).then(function (r) {
    assert.ok(r.key);
    assert.ok(db.get(BASE + '/items/' + r.key));
    tries = 0;
    var d = f.attach(function (t, k, info) { if (t === 'status') statuses.push(info); });
    return wait(30).then(function () { return settle(); }).then(function () {
      assert.strictEqual(statuses[0], 'connecting');
      assert.strictEqual(statuses[statuses.length - 1], 'live');
      assert.strictEqual(f.counts().n, 1);
      d();
    });
  }).then(function () {
    var dead = new M.Feed(new M.CloudStore({ ref: function () { return Promise.resolve(null); }, seal: seal, unseal: unseal, timestamp: Date.now, retryMs: 1, retries: 2 }), {});
    return dead.add({ text: 'x' }).then(function () { assert.fail('should reject'); }, function (e) { assert.ok(/not reachable/.test(e.message)); });
  });
});

// =====================================================================================
// LocalStore (no sync)
// =====================================================================================
test('local feed: add / list / pin / delete / prune over the key-value store; plain JSON locally', function () {
  return withCaps({ CAP: 2 }, function () {
    var kv = memKV(), t = 1760000000000;
    var store = new M.LocalStore(kv, { now: function () { return t; } });
    var f = new M.Feed(store, { device: { id: 'me', name: 'Mac' }, now: function () { return t; } });
    var d = f.attach(function () {}), keys = [];
    return settle().then(function () { return f.add({ text: 'one' }); }).then(function (r) {
      keys.push(r.key);
      assert.ok(kv.m['clipfeed:items'].items[r.key]);
      t += 10; return f.add({ text: 'L'.repeat(M.C.INLINE_MAX + 1) });
    }).then(function (r) {
      keys.push(r.key);
      assert.ok(kv.m['clipfeed:blob:' + r.key], 'blob in its own key');
      return f.setPin(keys[0], true);
    }).then(function () {
      t += 10; return f.add({ text: 'three' });
    }).then(function () { t += 10; return f.add({ text: 'four' }); }).then(function () {
      return settle();
    }).then(function () { return decryptAll(f); }).then(function () {
      assert.deepStrictEqual(texts(f).map(function (s) { return s.slice(0, 5); }), ['one', 'four', 'three'], 'cap 2 unpinned + the pinned one');
      assert.strictEqual(kv.m['clipfeed:blob:' + keys[1]], undefined, 'pruned blob removed');
      return f.add({ text: 'four' });
    }).then(function (r) {
      assert.ok(r.dup);
      return f.clear(true);
    }).then(function () {
      return settle();
    }).then(function () {
      assert.strictEqual(f.counts().n, 0);
      assert.deepStrictEqual(kv.m['clipfeed:items'].items, {});
      d();
    });
  });
});
test('local feed: another tab (BroadcastChannel) sees adds, pins and deletes; an add racing the first load lands once', function () {
  var kv = memKV(), ch = fakeChannels(), t = 1;
  var A = new M.Feed(new M.LocalStore(kv, { now: function () { return t; }, channel: ch }), { device: { id: 'me' }, now: function () { return t; } });
  var B = new M.Feed(new M.LocalStore(kv, { now: function () { return t; }, channel: ch }), { device: { id: 'me' }, now: function () { return t; } });
  var dB = B.attach(function () {}), key;
  var p = A.add({ text: 'racing' });   // A not attached; B is loading right now
  return p.then(function (r) { key = r.key; return settle(); }).then(function () {
    assert.strictEqual(B.counts().n, 1, 'once, not twice');
    return A.setPin(key, true);
  }).then(function () {
    assert.ok(B.get(key).p);
    return A.remove(key);
  }).then(function () {
    assert.strictEqual(B.counts().n, 0);
    dB();
  });
});

// =====================================================================================
// capture plugin
// =====================================================================================
function fakeTimers() {
  var q = [], id = 0, T = { now: 0 };
  T.setTimeout = function (f, ms) { q.push({ id: ++id, at: T.now + ms, f: f }); return id; };
  T.clearTimeout = function (i) { q = q.filter(function (x) { return x.id !== i; }); };
  T.advance = function (ms) {
    T.now += ms;
    var due = q.filter(function (x) { return x.at <= T.now; }).sort(function (a, b) { return a.at - b.at; });
    q = q.filter(function (x) { return x.at > T.now; });
    due.forEach(function (x) { x.f(); });
  };
  return T;
}
test('capture core: debounce keeps the last copy of a burst; blanks ignored; quick repeats ignored', function () {
  var T = fakeTimers(), out = [];
  var c = CAP.makeCapturer({ setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: function () { return T.now; }, sink: function (t) { out.push(t); } });
  assert.strictEqual(c.push('  \n '), false);
  assert.strictEqual(c.push(42), false);
  c.push('a'); T.advance(300); c.push('ab'); T.advance(300); c.push('abc');
  assert.deepStrictEqual(out, []);
  T.advance(599); assert.deepStrictEqual(out, []);
  T.advance(1); assert.deepStrictEqual(out, ['abc']);
  c.push('abc'); T.advance(600);
  assert.deepStrictEqual(out, ['abc'], 'same text again right away');
  T.advance(61000); c.push('abc'); T.advance(600);
  assert.deepStrictEqual(out, ['abc', 'abc'], 'a minute later the feed decides (it dedupes against its newest)');
  c.push('x'); c.cancel(); T.advance(1000);
  assert.strictEqual(out.length, 2, 'cancelled');
  c.push('y'); assert.ok(c.busy()); c.flush();
  assert.deepStrictEqual(out.slice(-1), ['y']);
});
test('capture core: which text a copy event copied', function () {
  var p = CAP.pickCopyText;
  assert.strictEqual(p({ data: 'from CodeMirror', sel: 'dom' }), 'from CodeMirror');
  assert.strictEqual(p({ editor: 'ed sel', sel: 'dom' }), 'ed sel');
  assert.strictEqual(p({ sel: 'dom' }), 'dom');
  assert.strictEqual(p({ field: { type: 'text', value: 'hello world', start: 6, end: 11 } }), 'world');
  assert.strictEqual(p({ field: { type: 'password', value: 'secret', start: 0, end: 6 }, data: 'secret' }), '');
  assert.strictEqual(p({ field: { type: 'email', value: 'x', start: null, end: null } }), '');
  assert.strictEqual(p({}), '');
});

// A minimal DOM for loading clipfeed-capture.js as the app would.
function fakeDom() {
  var listeners = [];
  function mkEl(tag) {
    var e = { tagName: String(tag).toUpperCase(), nodeType: 1, children: [], style: {}, attrs: {}, textContent: '', parentNode: null, ls: {},
      appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild: function (c) { e.children.splice(e.children.indexOf(c), 1); c.parentNode = null; },
      remove: function () { if (e.parentNode) e.parentNode.removeChild(e); },
      setAttribute: function (k, v) { e.attrs[k] = String(v); },
      addEventListener: function (t, f) { (e.ls[t] = e.ls[t] || []).push(f); },
      closest: function () { return null; },
      select: function () {}, setSelectionRange: function () {},
    };
    return e;
  }
  var doc = {
    visibilityState: 'visible', activeElement: null, body: mkEl('body'), head: mkEl('head'),
    addEventListener: function (t, f, c) { listeners.push({ t: t, f: f, c: !!c }); },
    removeEventListener: function (t, f, c) { listeners = listeners.filter(function (l) { return !(l.t === t && l.f === f && l.c === !!c); }); },
    getElementById: function () { return null; },
    createElement: mkEl,
    execCommand: function () { return true; },
    getSelection: function () { return ''; },
  };
  doc.ls = function () { return listeners.map(function (l) { return l.t; }).sort(); };
  doc.fire = function (t, ev) { listeners.filter(function (l) { return l.t === t; }).forEach(function (l) { l.f(ev); }); };
  doc.find = function (cls) {
    var out = [];
    (function walk(n) { (n.children || []).forEach(function (c) { if (c.className === cls) out.push(c); walk(c); }); })(doc.body);
    return out;
  };
  return doc;
}
function loadCapture(opts) {
  opts = opts || {};
  var doc = fakeDom(), reg = {}, adds = [], toasts = [];
  var proto = { writeText: function (t) { clip.native.push(t); return Promise.resolve(); } };
  var clip = Object.create(proto);
  clip.native = [];
  var Cade = {
    CM: { ViewPlugin: { define: function (create) { return { create: create }; } } },
    asset: function (p) { return './txt/widgets/clipfeed/' + p; },
    registerPlugin: function (s) { reg.plugin = s; },
    registerSetting: function (d) { reg.setting = d; d.apply(d.default); },
    cloud: opts.cloud || { configured: function () { return false; } },
    editor: null,
    showToast: function (m) { toasts.push(m); },
    runCommand: function (n) { reg.ran = n; },
  };
  var win = { Cade: Cade, __cadeClipfeed: { add: function (inp) { adds.push(inp.text); return Promise.resolve({}); } } };
  new Function('window', 'document', 'navigator', 'location', 'module', CAPSRC)(win, doc, { clipboard: clip }, { href: 'https://x.test/txt.html' }, undefined);
  return { doc: doc, reg: reg, adds: adds, clip: clip, proto: proto, win: win, toasts: toasts, Cade: Cade };
}
function target(o) {
  o = o || {};
  return { nodeType: 1, tagName: o.tag || 'DIV', type: o.type, value: o.value, selectionStart: o.s, selectionEnd: o.e,
    closest: function () { return o.skip ? {} : null; },
    ownerDocument: { getSelection: function () { return o.sel || ''; } } };
}
test('capture plugin: registers under its manifest id; the ViewPlugin lifecycle (refcounted) starts and fully stops capture', function () {
  var h = loadCapture();
  assert.strictEqual(h.reg.plugin.id, EXPECTED.plugin.id);
  assert.strictEqual(h.reg.setting.key, 'clipfeed.chip');
  assert.strictEqual(h.reg.setting.type, 'toggle');
  assert.strictEqual(h.reg.setting.section, EXPECTED.plugin.section);
  assert.deepStrictEqual(h.doc.ls(), [], 'nothing runs before the extension is active');
  assert.ok(!Object.prototype.hasOwnProperty.call(h.clip, 'writeText'));
  var a = h.reg.plugin.ext.create(), b = h.reg.plugin.ext.create();
  assert.deepStrictEqual(h.doc.ls(), ['copy', 'cut', 'pointerdown', 'visibilitychange']);
  assert.ok(Object.prototype.hasOwnProperty.call(h.clip, 'writeText'), 'writeText wrapped');
  a.destroy();
  return wait(5).then(function () {
    assert.strictEqual(h.doc.ls().length, 4, 'still one instance alive');
    b.destroy();
    var c = h.reg.plugin.ext.create(); c.destroy();   // a state rebuild: destroy + create back to back
    return wait(5);
  }).then(function () {
    assert.deepStrictEqual(h.doc.ls(), [], 'all listeners gone');
    assert.ok(!Object.prototype.hasOwnProperty.call(h.clip, 'writeText'), 'writeText restored');
    assert.strictEqual(h.clip.writeText, h.proto.writeText);
    assert.deepStrictEqual(h.win.__cadeClipCapture.state(), { running: false, refs: 0, wrapped: false, chip: false });
  });
});
test('capture plugin: copy/cut events and writeText go to the feed (debounced); passwords, own copies and skipped panels do not', function () {
  var h = loadCapture(), inst = h.reg.plugin.ext.create();
  h.doc.fire('copy', { target: target({ sel: 'selected words' }), clipboardData: { getData: function () { return ''; } } });
  return wait(650).then(function () {
    assert.deepStrictEqual(h.adds, ['selected words']);
    h.doc.fire('cut', { target: target(), clipboardData: { getData: function () { return 'cm line'; } } });
    return wait(650);
  }).then(function () {
    assert.deepStrictEqual(h.adds, ['selected words', 'cm line']);
    h.doc.fire('copy', { target: target({ tag: 'INPUT', type: 'password', value: 'hunter2', s: 0, e: 7 }), clipboardData: { getData: function () { return ''; } } });
    h.doc.fire('copy', { target: target({ skip: true, sel: 'inside the clipboard panel' }), clipboardData: { getData: function () { return ''; } } });
    h.win.__cadeClipfeedOwn = 1;
    h.doc.fire('copy', { target: target({ sel: 'our own execCommand' }), clipboardData: { getData: function () { return ''; } } });
    return h.clip.writeText('our own tap-to-copy');
  }).then(function () {
    h.win.__cadeClipfeedOwn = 0;
    return wait(650);
  }).then(function () {
    assert.deepStrictEqual(h.adds, ['selected words', 'cm line'], 'nothing new');
    assert.deepStrictEqual(h.clip.native, ['our own tap-to-copy'], 'the real writeText still ran');
    return h.clip.writeText('a Copy button');
  }).then(function () {
    h.doc.fire('copy', { target: target({ tag: 'TEXTAREA', type: 'textarea', value: 'abc def', s: 4, e: 7 }), clipboardData: { getData: function () { return ''; } } });
    return wait(650);
  }).then(function () {
    assert.deepStrictEqual(h.adds.slice(2), ['def'], 'a burst keeps its last copy');
    h.doc.fire('pointerdown', { target: target({ skip: true }) });
    return h.clip.writeText('generated password');
  }).then(function () { return wait(650); }).then(function () {
    assert.strictEqual(h.adds.length, 3, 'a Copy button in a skipped panel (Password Generator) is not shared');
    inst.destroy();
    return wait(5);
  }).then(function () {
    h.doc.fire('copy', { target: target({ sel: 'after off' }) });
    return wait(650);
  }).then(function () { assert.strictEqual(h.adds.length, 3, 'off is off'); });
});
test('capture plugin: someone wrapping writeText on top of us is left alone on stop, and we go inert', function () {
  var h = loadCapture(), inst = h.reg.plugin.ext.create();
  var ours = h.clip.writeText, theirs = function (t) { return ours.call(h.clip, t); };
  h.clip.writeText = theirs;
  inst.destroy();
  return wait(5).then(function () {
    assert.strictEqual(h.clip.writeText, theirs);
    return h.clip.writeText('still works');
  }).then(function () { return wait(650); }).then(function () {
    assert.deepStrictEqual(h.adds, [], 'inert');
    assert.deepStrictEqual(h.clip.native, ['still works']);
  });
});
test('capture plugin chip: a copy from ANOTHER device pops a chip (initial replay ignored, own copies ignored); tap copies; hidden → detached', function () {
  var db = new FakeDB();
  db.ref(BASE + '/items/' + M.makePushIds()(db.t - 5000)).set({ s: 'enc:' + Buffer.from(JSON.stringify({ t: 'old one', by: 'iPhone', did: 'ph', at: db.t })).toString('base64'), at: db.t, k: 't' });
  var cloud = {
    configured: function () { return true; },
    ref: function (kind, sub) { return Promise.resolve(db.ref('rooms/__cade_' + kind + '_fp/' + sub)); },
    unseal: unseal, serverNow: function () { return db.t; }, device: { id: 'mac', name: 'Mac' },
  };
  var h = loadCapture({ cloud: cloud }), inst = h.reg.plugin.ext.create();
  var phone = cloudFeed(db, { id: 'ph', name: 'iPhone' }), mac = cloudFeed(db, { id: 'mac', name: 'Mac' });
  return settle().then(function () {
    assert.ok(h.win.__cadeClipCapture.state().chip, 'listening');
    assert.strictEqual(h.doc.find('cbf-chip').length, 0, 'the existing newest item is not news');
    return mac.add({ text: 'mine' });
  }).then(function () { return settle(); }).then(function () {
    assert.strictEqual(h.doc.find('cbf-chip').length, 0, 'own device: no chip');
    db.t += 1000;
    return phone.add({ text: 'hello from the phone\nsecond line' });
  }).then(function () { return settle(); }).then(function () {
    var chips = h.doc.find('cbf-chip');
    assert.strictEqual(chips.length, 1);
    var main = chips[0].children[0];
    assert.strictEqual(main.children[0].textContent, '📋 from iPhone:');
    assert.strictEqual(main.children[1].textContent, 'hello from the phone second line');
    main.ls.click[0]();
    assert.strictEqual(h.doc.find('cbf-chip').length, 0, 'tapping hides it');
    return settle();
  }).then(function () {
    assert.deepStrictEqual(h.clip.native, ['hello from the phone\nsecond line'], 'copied');
    assert.deepStrictEqual(h.toasts, ['Copied']);
    return wait(650);
  }).then(function () {
    assert.deepStrictEqual(h.adds, [], 'the chip\'s own copy is not captured back');
    h.doc.visibilityState = 'hidden';
    h.doc.fire('visibilitychange', {});
    assert.ok(!h.win.__cadeClipCapture.state().chip, 'no listener while hidden');
    assert.strictEqual(db.L.length, 0);
    h.doc.visibilityState = 'visible';
    h.doc.fire('visibilitychange', {});
    return settle();
  }).then(function () {
    assert.ok(h.win.__cadeClipCapture.state().chip);
    h.reg.setting.apply(false);
    assert.ok(!h.win.__cadeClipCapture.state().chip, 'setting off');
    h.reg.setting.apply(true);
    return settle();
  }).then(function () {
    inst.destroy();
    return wait(5);
  }).then(function () {
    assert.strictEqual(db.L.length, 0, 'capture off → chip listener off');
    assert.deepStrictEqual(h.doc.ls(), []);
  });
});

// =====================================================================================
// widget registration + manifest
// =====================================================================================
test('widget: registers name/description/icon/tags identical to its manifest entry; CSS + model resolved at load', function () {
  var reg = null, css = [], assets = [];
  var src = fs.readFileSync(path.join(__dirname, 'clipfeed.js'), 'utf8');
  new Function('window', 'module', src)({ Cade: {
    loadCSS: function (p) { css.push(p); }, asset: function (p) { assets.push(p); return './txt/widgets/clipfeed/' + p; },
    registerWidget: function (o) { reg = o; }, escapeHtml: String,
  } }, undefined);
  assert.ok(reg, 'registered');
  ['name', 'description', 'icon', 'tags'].forEach(function (k) { assert.strictEqual(reg[k], EXPECTED.widget[k], k); });
  assert.strictEqual(typeof reg.open, 'function');
  assert.strictEqual(typeof reg.close, 'function');
  assert.deepStrictEqual(css, ['clipfeed.css']);
  assert.deepStrictEqual(assets, ['clipfeed-model.js']);
  [EXPECTED.widget.entry, EXPECTED.widget.css, EXPECTED.plugin.entry].concat(EXPECTED.widget.precache).forEach(function (f) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', f)), f);
  });
  // once the entries are in txt/manifest.json they must match exactly
  var man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')).modules;
  ['widget', 'plugin'].forEach(function (kind) {
    var m = man.filter(function (x) { return x.id === EXPECTED[kind].id; })[0];
    if (m) assert.deepStrictEqual(m, EXPECTED[kind], 'manifest entry ' + EXPECTED[kind].id);
  });
});
test('every module file parses as a script (ES5-style IIFEs, no modules syntax)', function () {
  ['clipfeed.js', 'clipfeed-model.js', 'clipfeed-capture.js'].forEach(function (f) {
    var s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    new Function(s);   // throws on a syntax error
    assert.ok(!/=>|\blet\s|\bconst\s|`\$\{|\bclass\s/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), f + ': ES5 style');
  });
});

(function run(i) {
  if (i >= tests.length) { console.log((process.exitCode ? 'FAILED, ' : '') + 'clipfeed: ' + passed + ' passed'); return; }
  var t = tests[i];
  Promise.resolve().then(t.fn).then(function () { passed++; }, function (e) { console.error('FAIL ' + t.name + '\n' + (e && e.stack || e)); process.exitCode = 1; })
    .then(function () { run(i + 1); });
})(0);
