/* Clipboard feed — the model, shared by the Clipboard widget (clipfeed.js) and
 * the capture plugin (clipfeed-capture.js, which loads this file only on the
 * first real copy). Everything above the "browser glue" line is pure: no DOM,
 * no Cade — node runs it in clipfeed.test.js against an in-memory fake of the
 * Firebase Reference API and a fake key/value store.
 *
 * DATA (cloud: under Cade.cloud.ref('cb') = rooms/__cade_cb_<keyFp>/)
 *   items/<pushKey> = { s: sealed rec, at: server time, k: 't'|'i', p?: 1 }
 *   idx/<pushKey>   = { at: server time, p: 0|1 }      tiny — read to prune
 *   blobs/<pushKey> = sealed { t: full text } | { d: image dataURL }
 *   rec (sealed)    = { t?: text, big?: { n, lines }, cut?: n, img?: { w, h, thumb },
 *                       h: content hash, by: device name, did: device id, at: client ms }
 * The pin flag is plain metadata (p) so pinning never re-encrypts and pruning
 * never decrypts. Text up to INLINE_MAX lives in the item; longer text keeps a
 * PREVIEW_MAX preview there and the whole of it in blobs/<key>; images keep a
 * ~160px thumbnail in the item and the full picture (≤ 1600px) in blobs/<key>.
 * So the live feed (items, newest LIVE_N by key) stays small, and a blob is
 * read only when its card is copied, shared or opened. Every add/pin/delete is
 * one multi-path update of items + idx (+ blobs): atomic, never half-written.
 *
 * RETENTION: pinned items stay (at most PIN_CAP of them); unpinned ones are
 * kept while they are both among the newest CAP and at most MAX_AGE old. The
 * writer prunes after each add (and the widget once per open) — reading only
 * idx, never the items themselves.
 *
 * LOCAL-ONLY (no sync set up): the same Feed runs on LocalStore — Cade.idbStore
 * (items in one key, each blob in its own), "sealed" as plain JSON, other tabs
 * told through a BroadcastChannel. Items made locally stay local when Sync is
 * set up later (the feed then shows the cloud). */
(function () {
  'use strict';

  var DAY = 864e5;
  var C = {
    CAP: 100,                 // unpinned items kept
    PIN_CAP: 50,              // pinned items allowed
    MAX_AGE: 30 * DAY,        // unpinned items older than this go
    TEXT_MAX: 100 * 1024,     // characters stored per item (longer is truncated with a note)
    INLINE_MAX: 4096,         // longer text moves to blobs/, the item keeps a preview
    PREVIEW_MAX: 1200,        // characters of preview kept in the item for long text
    IMG_MAX: 900 * 1024,      // full image dataURL, after compression
    THUMB_MAX: 48 * 1024,     // thumbnail dataURL
    LIVE_N: 160,              // live window: CAP + PIN_CAP + slack for not-yet-pruned adds
    SHOW_LINES: 6,            // lines a card shows
  };

  // ---- push ids (Firebase format: 8 chars of ms time + 12 random) -------------------
  var PUSH = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  function makePushIds(rnd) {
    var lastT = -1, last = [];
    rnd = rnd || Math.random;
    return function (now) {
      var t = Math.floor(now), dup = t === lastT, i, head = '';
      lastT = t;
      for (i = 7; i >= 0; i--) { head = PUSH.charAt(t % 64) + head; t = Math.floor(t / 64); }
      if (!dup) { for (i = 0; i < 12; i++) last[i] = Math.floor(rnd() * 64); }
      else {   // same millisecond: increment so ids stay strictly increasing
        for (i = 11; i >= 0 && last[i] === 63; i--) last[i] = 0;
        if (i >= 0) last[i]++;
      }
      var tail = '';
      for (i = 0; i < 12; i++) tail += PUSH.charAt(last[i]);
      return head + tail;
    };
  }
  function keyTime(key) {
    if (typeof key !== 'string' || key.length < 8) return 0;
    var t = 0;
    for (var i = 0; i < 8; i++) { var c = PUSH.indexOf(key.charAt(i)); if (c < 0) return 0; t = t * 64 + c; }
    return t;
  }

  // ---- text helpers ------------------------------------------------------------------
  function safeCut(s, n) {
    if (s.length <= n) return s;
    var c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n);
  }
  function fmtSize(chars) {
    if (chars < 1024) return chars + ' B';
    if (chars < 1024 * 1024) return (chars / 1024).toFixed(chars < 10240 ? 1 : 0) + ' KB';
    return (chars / 1048576).toFixed(1) + ' MB';
  }
  function countLines(t) {
    var n = 1;
    for (var i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++;
    return n;
  }
  function isBlank(t) { return typeof t !== 'string' || !/\S/.test(t); }
  // Keep at most TEXT_MAX characters; a cut is said at the end.
  function capText(t, max) {
    max = max || C.TEXT_MAX;
    t = String(t);
    if (t.length <= max) return { t: t, cut: 0 };
    return { t: safeCut(t, max) + '\n\n… [truncated — ' + fmtSize(t.length) + ' in total]', cut: t.length };
  }
  // What a card shows: the first `lines` lines (and at most `chars` characters),
  // plus how many lines are left out.
  function preview(t, lines, chars, total) {
    lines = lines || C.SHOW_LINES; chars = chars || 600;
    t = String(t || '');
    var pos = -1;
    for (var i = 0; i < lines; i++) { pos = t.indexOf('\n', pos + 1); if (pos === -1) break; }
    var head = pos === -1 ? t : t.slice(0, pos);
    var clipped = head.length > chars;
    if (clipped) head = safeCut(head, chars);
    head = head.replace(/\s+$/, '');
    var all = total || countLines(t);
    var shown = countLines(head);
    return { head: head, more: Math.max(0, all - shown), clipped: clipped };
  }
  // cyrb53: fast 53-bit content hash (dedupe of "the same copy again"). Kept
  // inside the sealed record, so it reveals nothing to the server.
  function hash(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57, ch;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  var URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;
  // First http(s) URL in the text: { url, host, only } (only = the text IS the URL).
  function findUrl(t) {
    var m = URL_RE.exec(String(t || ''));
    if (!m) return null;
    var u = m[0].replace(/[.,;:!?'"’”]+$/, '');
    if (/\)$/.test(u) && u.split('(').length < u.split(')').length) u = u.slice(0, -1);
    var host;
    try { var p = new URL(u); if (!/^https?:$/.test(p.protocol)) return null; host = p.hostname.replace(/^www\./, ''); } catch (e) { return null; }
    if (!host) return null;
    return { url: u, host: host, only: String(t).trim() === u };
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function relTime(at, now) {
    if (!at) return '';
    var s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + ' days ago';
    var dt = new Date(at), y = new Date(now).getFullYear();
    return MON[dt.getMonth()] + ' ' + dt.getDate() + (dt.getFullYear() !== y ? ', ' + dt.getFullYear() : '');
  }
  function matches(rec, q) {
    if (!q) return true;
    if (!rec) return false;
    q = String(q).toLowerCase();
    return (typeof rec.t === 'string' && rec.t.toLowerCase().indexOf(q) !== -1) ||
      (typeof rec.by === 'string' && rec.by.toLowerCase().indexOf(q) !== -1) ||
      (!!rec.img && 'image'.indexOf(q) !== -1);
  }
  // A decrypted record from anywhere (another device, an old version): keep only
  // fields of the expected types; anything unusable → null.
  function cleanRec(r) {
    if (!r || typeof r !== 'object') return null;
    var o = { by: typeof r.by === 'string' ? r.by.slice(0, 60) : '', did: typeof r.did === 'string' ? r.did.slice(0, 32) : '',
      at: typeof r.at === 'number' ? r.at : 0, h: typeof r.h === 'string' ? r.h : '' };
    if (r.img && typeof r.img === 'object' && typeof r.img.thumb === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(r.img.thumb)) {
      o.img = { w: +r.img.w || 0, h: +r.img.h || 0, thumb: r.img.thumb };
    } else if (typeof r.t === 'string') {
      o.t = r.t;
      if (r.big && typeof r.big === 'object') o.big = { n: +r.big.n || r.t.length, lines: +r.big.lines || countLines(r.t) };
      if (typeof r.cut === 'number' && r.cut > 0) o.cut = r.cut;
    } else return null;
    return o;
  }
  function validImageData(d) { return typeof d === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(d); }

  // ---- ordering + retention ----------------------------------------------------------
  // Pinned first, then newest first (server time; push-key order breaks ties).
  function cmp(a, b) {
    if (!!a.p !== !!b.p) return a.p ? -1 : 1;
    if (a.at !== b.at) return b.at - a.at;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  }
  // idx: { key: { at, p } } → keys to delete. Pinned items are never pruned.
  function planPrune(idx, now, cap, maxAge) {
    cap = cap == null ? C.CAP : cap;
    maxAge = maxAge == null ? C.MAX_AGE : maxAge;
    var un = [], out = [];
    for (var k in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, k)) continue;
      var v = idx[k] || {};
      if (v.p) continue;
      un.push({ key: k, at: typeof v.at === 'number' ? v.at : keyTime(k) });
    }
    un.sort(function (a, b) { return b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0); });
    for (var i = 0; i < un.length; i++) if (i >= cap || now - un[i].at > maxAge) out.push(un[i].key);
    return out;
  }
  function pinCount(idx) {
    var n = 0;
    for (var k in idx) if (Object.prototype.hasOwnProperty.call(idx, k) && idx[k] && idx[k].p) n++;
    return n;
  }

  // ---- building a record ------------------------------------------------------------
  // input: { text } or { img: { w, h, thumb }, full: dataURL }. Returns
  // { rec, kind, blob } or { error } — the caller seals rec / blob.
  function buildRecord(input, device, now) {
    var rec = { by: (device && device.name) || '', did: (device && device.id) || '', at: now };
    if (input && input.img) {
      var im = input.img;
      if (!validImageData(im.thumb)) return { error: 'bad image' };
      if (im.thumb.length > C.THUMB_MAX) return { error: 'thumbnail too large' };
      if (input.full != null && (!validImageData(input.full) || input.full.length > C.IMG_MAX)) return { error: 'image too large' };
      rec.img = { w: Math.round(+im.w || 0), h: Math.round(+im.h || 0), thumb: im.thumb };
      rec.h = 'i' + hash(input.full || im.thumb);
      return { rec: rec, kind: 'i', blob: input.full ? { d: input.full } : null };
    }
    var text = input && input.text != null ? String(input.text) : '';
    if (isBlank(text)) return { error: 'empty' };
    rec.h = hash(text);
    var c = capText(text);
    if (c.cut) rec.cut = c.cut;
    var blob = null;
    if (c.t.length > C.INLINE_MAX) {
      rec.t = safeCut(c.t, C.PREVIEW_MAX);
      rec.big = { n: c.t.length, lines: countLines(c.t) };
      blob = { t: c.t };
    } else rec.t = c.t;
    return { rec: rec, kind: 't', blob: blob };
  }
  function sameContent(a, b) {
    if (!a || !b) return false;
    if (a.h && b.h) return a.h === b.h;
    if (a.img || b.img) return !!(a.img && b.img && a.img.thumb === b.img.thumb);
    return !a.big && !b.big && a.t === b.t;
  }

  function later(fn) { return Promise.resolve().then(fn); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // =====================================================================================
  // Feed — the store-agnostic model the widget renders and the capture plugin writes to
  // =====================================================================================
  // store: CloudStore / LocalStore (see below). opts: { device: () => {id,name}, now: () => ms }
  function Feed(store, opts) {
    opts = opts || {};
    this.store = store;
    this.device = typeof opts.device === 'function' ? opts.device : function () { return opts.device || { id: '', name: '' }; };
    this.now = opts.now || Date.now;
    this.map = {};        // key -> entry { key, at, k, p, s, rec, st (0 pending · 1 ok · 2 unreadable), v }
    this.cache = {};      // key -> { s, rec }: decrypted records survive a detach / re-attach
    this.dec = {};        // key -> pending decrypt promise
    this.full = [];       // tiny LRU of fetched blobs: [{ key, val }]
    this.subs = [];
    this.unlisten = null;
    this.loaded = false;
    this.error = null;
  }
  Feed.prototype.emit = function (type, key, info) {
    var s = this.subs.slice();
    for (var i = 0; i < s.length; i++) { try { s[i](type, key, info); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }
  };
  // Live view. Returns a detach function; the store listener runs while anyone is attached.
  Feed.prototype.attach = function (cb) {
    var self = this;
    this.subs.push(cb);
    if (!this.unlisten) {
      this.loaded = false; this.error = null;
      this.unlisten = this.store.listen({
        add: function (k, raw) { self.ingest(k, raw); },
        change: function (k, raw) { self.ingest(k, raw); },
        remove: function (k) { self.drop(k); },
        ready: function () { self.loaded = true; self.emit('ready'); },
        error: function (e) { self.error = e; self.emit('error', null, e); },
        status: function (s) { self.emit('status', null, s); },
      });
    }
    return function () {
      var i = self.subs.indexOf(cb);
      if (i >= 0) self.subs.splice(i, 1);
      if (!self.subs.length && self.unlisten) {
        var u = self.unlisten; self.unlisten = null;
        try { u(); } catch (e) {}
        self.map = {}; self.loaded = false;
      }
    };
  };
  Feed.prototype.attached = function () { return !!this.unlisten; };
  Feed.prototype.dispose = function () {
    this.subs = [];
    if (this.unlisten) { var u = this.unlisten; this.unlisten = null; try { u(); } catch (e) {} }
    this.map = {}; this.cache = {}; this.full = [];
  };
  Feed.prototype.ingest = function (key, raw) {
    if (!raw || typeof raw.s !== 'string' || !raw.s) {
      // A pin toggled onto an item another device deleted at that moment leaves
      // a husk without a record: hide it and clear it away.
      this.drop(key);
      if (raw && typeof raw === 'object') this.store.del([key]).catch(function () {});
      return;
    }
    var e = this.map[key], isNew = !e;
    if (!e) e = this.map[key] = { key: key, v: 0, s: null, rec: null, st: 0 };
    if (e.s !== raw.s) {
      var c = this.cache[key];
      if (c && c.s === raw.s) { e.rec = c.rec; e.st = c.rec ? 1 : 2; } else { e.rec = null; e.st = 0; }
      e.s = raw.s;
    }
    e.at = typeof raw.at === 'number' ? raw.at : (keyTime(key) || this.now());
    e.k = raw.k === 'i' ? 'i' : 't';
    e.p = !!raw.p;
    e.v++;
    this.emit(isNew ? 'add' : 'change', key);
  };
  Feed.prototype.drop = function (key) {
    if (!this.map[key]) return;
    delete this.map[key];
    this.emit('remove', key);
  };
  Feed.prototype.get = function (key) { return this.map[key] || null; };
  // Ordered entries (pinned first, newest first).
  Feed.prototype.list = function () {
    var out = [];
    for (var k in this.map) if (Object.prototype.hasOwnProperty.call(this.map, k)) out.push(this.map[k]);
    return out.sort(cmp);
  };
  Feed.prototype.counts = function () {
    var n = 0, p = 0;
    for (var k in this.map) if (Object.prototype.hasOwnProperty.call(this.map, k)) { n++; if (this.map[k].p) p++; }
    return { n: n, pinned: p };
  };
  // Decrypt one entry (once; cached by its sealed text). Emits 'change' when done.
  Feed.prototype.decrypt = function (key) {
    var self = this, e = this.map[key];
    if (!e) return Promise.resolve(this.cache[key] ? this.cache[key].rec : null);
    if (e.st) return Promise.resolve(e.rec);
    if (this.dec[key]) return this.dec[key];
    var s = e.s;
    var p = later(function () { return self.store.unseal(s); }).then(cleanRec, function () { return null; }).then(function (rec) {
      delete self.dec[key];
      self.cache[key] = { s: s, rec: rec };
      var cur = self.map[key];
      if (cur && cur.s === s && !cur.st) { cur.rec = rec; cur.st = rec ? 1 : 2; cur.v++; self.emit('change', key); }
      return rec;
    });
    this.dec[key] = p;
    return p;
  };
  // The newest item (any pin state) with its record, or null.
  Feed.prototype.newest = function () {
    var self = this;
    if (this.unlisten && this.loaded) {
      var best = null;
      for (var k in this.map) {
        if (!Object.prototype.hasOwnProperty.call(this.map, k)) continue;
        var e = this.map[k];
        if (!best || e.at > best.at || (e.at === best.at && e.key > best.key)) best = e;
      }
      if (!best) return Promise.resolve(null);
      return this.decrypt(best.key).then(function (rec) { return rec ? { key: best.key, rec: rec } : null; });
    }
    return this.store.newest().then(function (n) {
      if (!n || !n.raw || typeof n.raw.s !== 'string') return null;
      var c = self.cache[n.key];
      if (c && c.s === n.raw.s) return c.rec ? { key: n.key, rec: c.rec } : null;
      return Promise.resolve(self.store.unseal(n.raw.s)).then(function (r) {
        r = cleanRec(r);
        self.cache[n.key] = { s: n.raw.s, rec: r };
        return r ? { key: n.key, rec: r } : null;
      });
    }).catch(function () { return null; });
  };
  // Add text or an image. Resolves { key } | { dup: true, key } | { skipped } ; rejects on a store failure.
  Feed.prototype.add = function (input) {
    var self = this, st = this.store;
    var b = buildRecord(input, this.device(), this.now());
    if (b.error) return Promise.resolve({ skipped: b.error });
    return this.newest().then(function (top) {
      if (top && sameContent(top.rec, b.rec)) return { dup: true, key: top.key };
      return Promise.all([st.seal(b.rec), b.blob ? st.seal(b.blob) : null]).then(function (sealed) {
        var raw = { s: sealed[0], at: st.timestamp(), k: b.kind };
        if (input.pin) raw.p = 1;
        return st.add(raw, sealed[1]);
      }).then(function (key) {
        self.prune().catch(function () {});
        return { key: key };
      });
    });
  };
  // Drop what retention says should go. Resolves the number removed.
  Feed.prototype.prune = function () {
    var self = this;
    return this.store.index().then(function (idx) {
      var victims = planPrune(idx || {}, self.now());
      if (!victims.length) return 0;
      return self.store.del(victims).then(function () { return victims.length; });
    });
  };
  Feed.prototype.setPin = function (key, on) {
    var self = this;
    if (!on) return this.store.patch(key, { p: 0 }).then(function () { return { ok: true }; });
    return this.store.index().then(function (idx) {
      if (!idx[key]) return { ok: false, reason: 'gone' };
      if (!idx[key].p && pinCount(idx) >= C.PIN_CAP) return { ok: false, reason: 'cap' };
      return self.store.patch(key, { p: 1 }).then(function () { return { ok: true }; });
    });
  };
  Feed.prototype.remove = function (key) {
    this.forget(key);
    return this.store.del([key]);
  };
  // Remove every unpinned item — or, with includePinned, everything. Resolves the count.
  Feed.prototype.clear = function (includePinned) {
    var self = this;
    return this.store.index().then(function (idx) {
      var keys = [];
      for (var k in idx) if (Object.prototype.hasOwnProperty.call(idx, k) && (includePinned || !(idx[k] && idx[k].p))) keys.push(k);
      keys.forEach(function (k) { self.forget(k); });
      return keys.length ? self.store.del(keys).then(function () { return keys.length; }) : 0;
    });
  };
  Feed.prototype.forget = function (key) {
    delete this.cache[key];
    this.full = this.full.filter(function (f) { return f.key !== key; });
  };
  Feed.prototype.rec = function (key) {
    var e = this.map[key];
    if (e && e.st) return Promise.resolve(e.rec);
    if (e) return this.decrypt(key);
    return Promise.resolve(this.cache[key] ? this.cache[key].rec : null);
  };
  Feed.prototype.cachedBlob = function (key) {
    for (var i = 0; i < this.full.length; i++) if (this.full[i].key === key) return this.full[i].val;
    return null;
  };
  Feed.prototype._blob = function (key) {
    var self = this, hit = this.cachedBlob(key);
    if (hit) return Promise.resolve(hit);
    return this.store.blob(key).then(function (s) {
      if (typeof s !== 'string' || !s) return null;
      return Promise.resolve(self.store.unseal(s)).then(function (v) {
        if (!v || typeof v !== 'object') return null;
        self.full = self.full.filter(function (f) { return f.key !== key; });
        self.full.unshift({ key: key, val: v });
        if (self.full.length > 4) self.full.length = 4;
        return v;
      });
    });
  };
  // Whole text of an item (from its blob when it is long). Null if unavailable.
  Feed.prototype.fullText = function (key) {
    var self = this;
    return this.rec(key).then(function (rec) {
      if (!rec || typeof rec.t !== 'string') return null;
      if (!rec.big) return rec.t;
      return self._blob(key).then(function (b) { return b && typeof b.t === 'string' ? b.t : null; });
    });
  };
  // Synchronous whole text when it is already at hand (iOS needs the copy inside the tap).
  Feed.prototype.fullTextNow = function (key) {
    var e = this.map[key], rec = e && e.rec;
    if (!rec || typeof rec.t !== 'string') return null;
    if (!rec.big) return rec.t;
    var b = this.cachedBlob(key);
    return b && typeof b.t === 'string' ? b.t : null;
  };
  // Full-size image dataURL (null when it can't be had — use the thumbnail).
  Feed.prototype.fullImage = function (key) {
    return this._blob(key).then(function (b) { return b && validImageData(b.d) ? b.d : null; });
  };

  // =====================================================================================
  // CloudStore — Firebase (compat) references from Cade.cloud.ref('cb', sub)
  // =====================================================================================
  // o: { ref(sub) → Promise<Reference|null>, seal(obj), unseal(str), timestamp(), retries?, retryMs? }
  function CloudStore(o) {
    this.o = o;
    this.retries = o.retries == null ? 4 : o.retries;
    this.retryMs = o.retryMs == null ? 800 : o.retryMs;
  }
  CloudStore.prototype.kind = 'cloud';
  CloudStore.prototype.seal = function (obj) { return this.o.seal(obj); };
  CloudStore.prototype.unseal = function (s) { return this.o.unseal(s); };
  CloudStore.prototype.timestamp = function () { return this.o.timestamp(); };
  // A reference, retrying while the database library is still loading (cold start).
  CloudStore.prototype._ref = function (sub, tries) {
    var self = this;
    tries = tries || 0;
    return Promise.resolve(this.o.ref(sub)).then(function (r) {
      if (r) return r;
      if (tries >= self.retries) throw new Error('Sync is not reachable right now');
      return delay(self.retryMs * Math.pow(2, tries)).then(function () { return self._ref(sub, tries + 1); });
    });
  };
  CloudStore.prototype.listen = function (h) {
    var self = this, dead = false, q = null, fa, fc, fr, timer = 0, tries = 0;
    function attach() {
      timer = 0;
      Promise.resolve(self.o.ref('items')).then(function (items) {
        if (dead) return;
        if (!items) {   // library still loading / offline cold start: keep trying (cancelled by unlisten)
          if (h.status) h.status('connecting');
          timer = setTimeout(attach, Math.min(15000, self.retryMs * Math.pow(2, Math.min(tries++, 5))));
          return;
        }
        if (h.status) h.status('live');
        q = items.orderByKey().limitToLast(C.LIVE_N);
        var err = function (e) { if (!dead && h.error) h.error(e); };
        fa = q.on('child_added', function (snap) { if (!dead) h.add(snap.key, snap.val()); }, err);
        fc = q.on('child_changed', function (snap) { if (!dead) h.change(snap.key, snap.val()); }, err);
        fr = q.on('child_removed', function (snap) { if (!dead) h.remove(snap.key); }, err);
        // value fires after the initial child_added batch: the first load is complete
        Promise.resolve(q.once('value')).then(function () { if (!dead && h.ready) h.ready(); }, err);
      }, function (e) { if (!dead && h.error) h.error(e); });
    }
    attach();
    return function () {
      dead = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      if (q) {
        try { q.off('child_added', fa); } catch (e) {}
        try { q.off('child_changed', fc); } catch (e) {}
        try { q.off('child_removed', fr); } catch (e) {}
        q = null;
      }
    };
  };
  CloudStore.prototype.add = function (raw, blob) {
    var self = this;
    return Promise.all([this._ref(''), this._ref('items')]).then(function (r) {
      var root = r[0], key = r[1].push().key, up = {};
      up['items/' + key] = raw;
      up['idx/' + key] = { at: raw.at, p: raw.p ? 1 : 0 };
      if (blob) up['blobs/' + key] = blob;
      return root.update(up).then(function () { return key; });
    });
  };
  CloudStore.prototype.patch = function (key, f) {
    return this._ref('').then(function (root) {
      var up = {};
      up['items/' + key + '/p'] = f.p ? 1 : null;
      up['idx/' + key + '/p'] = f.p ? 1 : 0;
      return root.update(up);
    });
  };
  CloudStore.prototype.del = function (keys) {
    if (!keys || !keys.length) return Promise.resolve();
    return this._ref('').then(function (root) {
      var up = {};
      keys.forEach(function (k) { up['items/' + k] = null; up['idx/' + k] = null; up['blobs/' + k] = null; });
      return root.update(up);
    });
  };
  CloudStore.prototype.index = function () {
    return this._ref('idx').then(function (r) { return r.once('value'); }).then(function (s) { return (s && s.val()) || {}; });
  };
  CloudStore.prototype.newest = function () {
    return this._ref('items').then(function (r) { return r.orderByKey().limitToLast(1).once('value'); }).then(function (s) {
      var v = s && s.val(), best = null;
      if (v && typeof v === 'object') for (var k in v) if (!best || k > best) best = k;
      return best ? { key: best, raw: v[best] } : null;
    });
  };
  CloudStore.prototype.blob = function (key) {
    return this._ref('blobs/' + key).then(function (r) { return r.once('value'); }).then(function (s) { return s ? s.val() : null; });
  };

  // =====================================================================================
  // LocalStore — this device only (no sync set up)
  // =====================================================================================
  // kv: { get(k) → Promise, set(k, v) → Promise, remove(k) → Promise } (Cade.idbStore)
  // o:  { now(), channel() → BroadcastChannel-like | null, rnd() }
  var L_ITEMS = 'clipfeed:items', L_BLOB = 'clipfeed:blob:';
  function LocalStore(kv, o) {
    o = o || {};
    this.kv = kv;
    this.now = o.now || Date.now;
    this.channel = o.channel || null;
    this.id = Math.random().toString(36).slice(2, 10);
    this.pid = makePushIds(o.rnd);
    this.items = null;     // in-memory copy while listening
    this.hs = [];
    this.ch = null;
    this.q = Promise.resolve();   // writes run one at a time (read-modify-write)
  }
  LocalStore.prototype.kind = 'local';
  LocalStore.prototype.seal = function (obj) { return Promise.resolve(JSON.stringify(obj)); };
  LocalStore.prototype.unseal = function (s) { try { return Promise.resolve(JSON.parse(s)); } catch (e) { return Promise.resolve(null); } };
  LocalStore.prototype.timestamp = function () { return this.now(); };
  LocalStore.prototype._read = function () {
    return Promise.resolve(this.kv.get(L_ITEMS)).then(function (v) {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      return v && typeof v === 'object' && v.items && typeof v.items === 'object' ? v.items : {};
    }, function () { return {}; });
  };
  LocalStore.prototype._write = function (items) { return Promise.resolve(this.kv.set(L_ITEMS, { v: 1, items: items })); };
  LocalStore.prototype._emit = function (op, key, raw) {
    var hs = this.hs.slice();
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i];
      if (op === 'remove') h.remove(key); else if (op === 'add') h.add(key, raw); else h.change(key, raw);
    }
  };
  LocalStore.prototype._post = function (msg) {
    if (!this.channel) return;
    msg.src = this.id;
    try {
      if (this.ch) { this.ch.postMessage(msg); return; }
      var c = this.channel();
      if (c) { c.postMessage(msg); if (c.close) c.close(); }
    } catch (e) {}
  };
  // Apply a change to the in-memory copy (ours or another tab's) and tell listeners.
  LocalStore.prototype._apply = function (msg) {
    if (!this.items) return;
    var self = this;
    if (msg.op === 'put') {
      var had = Object.prototype.hasOwnProperty.call(this.items, msg.key);
      this.items[msg.key] = msg.raw;
      this._emit(had ? 'change' : 'add', msg.key, msg.raw);
    } else if (msg.op === 'del') {
      (msg.keys || []).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(self.items, k)) { delete self.items[k]; self._emit('remove', k); }
      });
    }
  };
  LocalStore.prototype.listen = function (h) {
    var self = this, dead = false;
    this.hs.push(h);
    if (this.channel && !this.ch) {
      try {
        this.ch = this.channel();
        if (this.ch) this.ch.onmessage = function (ev) { var m = ev && ev.data; if (m && m.src !== self.id) self._apply(m); };
      } catch (e) { this.ch = null; }
    }
    // through the write queue, so an add racing the first read lands exactly once
    var ready = this._op(function () {
      if (self.items) return self.items;
      return self._read().then(function (items) { if (!self.items) self.items = items; return self.items; });
    });
    ready.then(function (items) {
      if (dead) return;
      Object.keys(items).sort().forEach(function (k) { h.add(k, items[k]); });
      if (h.status) h.status('local');
      if (h.ready) h.ready();
    });
    return function () {
      dead = true;
      var i = self.hs.indexOf(h);
      if (i >= 0) self.hs.splice(i, 1);
      if (!self.hs.length) {
        self.items = null;
        if (self.ch) { try { self.ch.onmessage = null; if (self.ch.close) self.ch.close(); } catch (e) {} self.ch = null; }
      }
    };
  };
  LocalStore.prototype._op = function (fn) {
    var p = this.q.then(fn);
    this.q = p.catch(function () {});
    return p;
  };
  LocalStore.prototype.add = function (raw, blob) {
    var self = this;
    return this._op(function () {
      var key = self.pid(self.now());
      return (blob ? Promise.resolve(self.kv.set(L_BLOB + key, blob)) : Promise.resolve()).then(function () {
        return self._read();
      }).then(function (items) {
        items[key] = raw;
        return self._write(items);
      }).then(function () {
        var m = { op: 'put', key: key, raw: raw };
        self._apply(m); self._post(m);
        return key;
      });
    });
  };
  LocalStore.prototype.patch = function (key, f) {
    var self = this;
    return this._op(function () {
      return self._read().then(function (items) {
        var raw = items[key];
        if (!raw) return;
        raw = JSON.parse(JSON.stringify(raw));
        if (f.p) raw.p = 1; else delete raw.p;
        items[key] = raw;
        return self._write(items).then(function () {
          var m = { op: 'put', key: key, raw: raw };
          self._apply(m); self._post(m);
        });
      });
    });
  };
  LocalStore.prototype.del = function (keys) {
    var self = this;
    if (!keys || !keys.length) return Promise.resolve();
    return this._op(function () {
      return self._read().then(function (items) {
        keys.forEach(function (k) { delete items[k]; });
        return self._write(items);
      }).then(function () {
        return Promise.all(keys.map(function (k) { return Promise.resolve(self.kv.remove(L_BLOB + k)).catch(function () {}); }));
      }).then(function () {
        var m = { op: 'del', keys: keys };
        self._apply(m); self._post(m);
      });
    });
  };
  LocalStore.prototype.index = function () {
    var self = this;
    return this.q.then(function () { return self._read(); }).then(function (items) {
      var idx = {};
      for (var k in items) if (Object.prototype.hasOwnProperty.call(items, k)) idx[k] = { at: typeof items[k].at === 'number' ? items[k].at : keyTime(k), p: items[k].p ? 1 : 0 };
      return idx;
    });
  };
  LocalStore.prototype.newest = function () {
    var self = this;
    return this.q.then(function () { return self._read(); }).then(function (items) {
      var best = null;
      for (var k in items) if (!best || k > best) best = k;
      return best ? { key: best, raw: items[best] } : null;
    });
  };
  LocalStore.prototype.blob = function (key) { return Promise.resolve(this.kv.get(L_BLOB + key)).catch(function () { return null; }); };

  var M = {
    C: C, makePushIds: makePushIds, keyTime: keyTime, safeCut: safeCut, fmtSize: fmtSize, countLines: countLines,
    isBlank: isBlank, capText: capText, preview: preview, hash: hash, findUrl: findUrl, relTime: relTime,
    matches: matches, cleanRec: cleanRec, validImageData: validImageData, cmp: cmp, planPrune: planPrune,
    pinCount: pinCount, buildRecord: buildRecord, sameContent: sameContent,
    Feed: Feed, CloudStore: CloudStore, LocalStore: LocalStore,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // =====================================================================================
  // Browser glue: one Feed per mode, shared by the widget and the capture plugin
  // =====================================================================================
  if (window.__cadeClipfeed) return;   // loaded twice (widget + plugin race): keep the first
  var Cade = window.Cade;
  var cur = null;   // { mode, feed }
  function mode() { try { return Cade.cloud && Cade.cloud.configured() ? 'cloud' : 'local'; } catch (e) { return 'local'; } }
  function device() { try { return Cade.cloud.device; } catch (e) { return { id: '', name: 'This device' }; } }
  function makeFeed(m) {
    var store;
    if (m === 'cloud') {
      store = new CloudStore({
        ref: function (sub) { return Cade.cloud.ref('cb', sub); },
        seal: function (o) { return Cade.cloud.seal(o); },
        unseal: function (s) { return Cade.cloud.unseal(s); },
        timestamp: function () { return Cade.cloud.TIMESTAMP; },
      });
    } else {
      store = new LocalStore(Cade.idbStore, {
        now: Date.now,
        channel: typeof BroadcastChannel === 'function' ? function () { return new BroadcastChannel('cade-clipfeed'); } : null,
      });
    }
    return new Feed(store, {
      device: device,
      now: m === 'cloud' ? function () { return Cade.cloud.serverNow(); } : Date.now,
    });
  }
  // The feed for the current mode; a new one when Sync was set up / removed meanwhile.
  function feed() {
    var m = mode();
    if (!cur || cur.mode !== m) {
      if (cur) cur.feed.dispose();
      cur = { mode: m, feed: makeFeed(m) };
    }
    return cur.feed;
  }
  window.__cadeClipfeed = {
    M: M,
    mode: mode,
    feed: feed,
    add: function (input) { return feed().add(input); },
  };
})();
