/* Self-destructing links — the DOM-free logic (burn.js is the UI and the
 * Firebase wiring). UMD: window.__cadeBurnCore in the page, module.exports in
 * node (burn.test.js).
 *
 * A share lives at rooms/__cade_burn_<id> in the OWNER's database (the
 * existing rules cover rooms/*). <id> is 128 random bits; the AES-GCM key is
 * 256 random bits. Both, plus the database URL, travel only in the link's
 * fragment (#burn=…), which browsers never send to a server. The node holds:
 *   meta     { v: 2 | 3, created (server time), expiresAt (ms, 0 = no timer),
 *              maxOpens (0 = anyone), oneTime (= maxOpens 1, for older code), editable,
 *              live (v3 only: "watch live" — editable stays false),
              respond (v4: a response link — also live, never editable) }
 *            plain, non-secret: only what enforcement needs
 *   head     sealed { title, copy, icon, timer, scripts, live }              (AAD …/head)
 *            everything that describes the content: the name the reader sees,
 *            the icon, whether they see the countdown, the tidy-up tools
 *   doc      { ver, ct: sealed { t }, by, base, at }                         (AAD …/<ver>)
 *   claims   { <viewer>: at }   capped links: one slot per browser, taken by a transaction
 *   claim    { by, at }         v1 one-time links (meta without maxOpens): the first opener
 *   presence { <viewer>: { at } }   open viewers (removed on disconnect)
 *   tomb     { why: 'opened' | 'expired' | 'revoked', at }   once it destructs;
 *            the ciphertext is gone then and only meta + tomb remain, so a
 *            later open can say why.
 * Everything here is client-enforced — there are no server functions — and
 * the UI copy says so.
 *
 * Three modes (modeOf): 'read' — a snapshot; 'edit' — two-way live editing;
 * 'live' — the reader watches the owner's changes but can't edit. 'live' and
 * 'edit' keep their text on the server while the link is alive and take
 * slots the same way. A v3 'live' meta keeps editable: false, so code from
 * before v3 shows such a link as a snapshot (and treats it as read-only).
 * 'respond' (v4) — a poll, date planner, RSVP or shared list; its logic and
 * extra nodes (resp, closed, reveal) are in burn-respond-core.js. Its doc
 * holds only a "reload to respond" text for older readers.
 *
 * Live editing: every writer keeps `shared` = the last version it fully
 * incorporated. A push is a compare-and-swap transaction on doc (ver must
 * still be shared.ver); a newer version from someone else is three-way merged
 * (base = shared.text) into the local text with merge-core's merge3, and the
 * lines both sides changed are merged again word by word (mergeLive below),
 * so two people typing in the same paragraph keep both edits.
 *
 * Watch live: the owner's devices run LiveDoc in push-only mode — they send
 * the room's text and NEVER take anything in (anyone holding the key can
 * write ciphertext to the node); the reader runs Follow, which only shows. */
(function (root) {
  'use strict';

  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var MAX_MS = 30 * DAY;                 // longest timer
  var MAX_TEXT = 900000;                 // chars a share may carry (Firebase node writes stay small)
  var KEEP_ENDED_MS = 7 * DAY;           // ended links keep their tombstone this long ("already opened")
  var MAX_VIEWERS = 50;                  // "up to N people"
  var MAX_NAME = 80;
  var PRESETS = [
    { v: '10m', ms: 10 * MIN, label: '10 minutes' },
    { v: '1h', ms: HOUR, label: '1 hour' },
    { v: '24h', ms: DAY, label: '24 hours' },
    { v: '7d', ms: 7 * DAY, label: '7 days' },
    { v: 'custom', ms: 0, label: 'Custom…' },
    { v: 'none', ms: 0, label: 'No time limit' }
  ];
  var UNITS = { min: MIN, h: HOUR, d: DAY };

  // ---- base64url -------------------------------------------------------------------------------
  function b64u(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + 8192));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = String(s || '');
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function unutf8(b) { return new TextDecoder().decode(b); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }

  // ---- ids, keys, links -----------------------------------------------------------------------
  function newId() { return b64u(rand(16)); }        // 22 chars, 128 bits
  function newKey() { return b64u(rand(32)); }       // 43 chars, AES-256
  function newViewer() { return b64u(rand(9)); }
  function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id); }
  function validKey(k) { return typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k); }
  function validDb(u) {
    if (typeof u !== 'string' || u.length > 300) return false;
    try { var x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && !!x.hostname && !x.username && !x.password; } catch (e) { return false; }
  }
  function nodePath(id) { return 'rooms/__cade_burn_' + id; }

  // #burn=<payload>: base64url(JSON { v, d: database URL, i: id, k: key }).
  function encodeLink(base, share) {
    if (!validDb(share.db) || !validId(share.id) || !validKey(share.key)) throw new Error('bad share');
    var p = b64u(utf8(JSON.stringify({ v: 1, d: share.db, i: share.id, k: share.key })));
    return String(base).split('#')[0] + '#burn=' + p;
  }
  // Accepts a whole link, a hash or the bare payload → { db, id, key } or null.
  function decodeLink(s) {
    s = String(s == null ? '' : s).trim();
    var m = s.match(/[#&]burn=([A-Za-z0-9_-]+)/);
    var p = m ? m[1] : s;
    try {
      var o = JSON.parse(unutf8(unb64u(p)));
      if (!o || o.v !== 1 || !validDb(o.d) || !validId(o.i) || !validKey(o.k)) return null;
      return { db: o.d, id: o.i, key: o.k };
    } catch (e) { return null; }
  }

  // ---- AES-GCM ------------------------------------------------------------------------------------
  var keyCache = {};
  function importKey(k) {
    if (!validKey(k)) return Promise.reject(new Error('bad key'));
    if (!keyCache[k]) keyCache[k] = crypto.subtle.importKey('raw', unb64u(k), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return keyCache[k];
  }
  function aadFor(id, what) { return utf8('cade-burn/' + id + '/' + what); }
  // → "1.<base64url(iv | ciphertext+tag)>"
  function seal(k, id, what, obj) {
    var iv = rand(12);
    return importKey(k).then(function (ck) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aadFor(id, what) }, ck, utf8(JSON.stringify(obj)));
    }).then(function (ct) {
      var c = new Uint8Array(ct), out = new Uint8Array(12 + c.length);
      out.set(iv, 0); out.set(c, 12);
      return '1.' + b64u(out);
    });
  }
  // Rejects when the key, the id or the slot (`what`) don't match.
  function open(k, id, what, str) {
    return Promise.resolve().then(function () {
      if (typeof str !== 'string' || str.slice(0, 2) !== '1.') throw new Error('bad ciphertext');
      var b = unb64u(str.slice(2));
      if (b.length < 29) throw new Error('bad ciphertext');
      return importKey(k).then(function (ck) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: aadFor(id, what) }, ck, b.subarray(12));
      });
    }).then(function (pt) { return JSON.parse(unutf8(new Uint8Array(pt))); });
  }

  // ---- expiry ------------------------------------------------------------------------------------
  // choice: a PRESETS value; custom: { n, unit: 'min'|'h'|'d' } → expiresAt (ms, 0 = none) or throws.
  function expiryFrom(choice, custom, now) {
    if (choice === 'none') return 0;
    var ms = 0;
    if (choice === 'custom') {
      var n = Number(custom && custom.n), u = UNITS[custom && custom.unit];
      if (!u || !(n > 0) || !isFinite(n)) throw new Error('Enter how long the link should last');
      ms = Math.round(n * u);
    } else {
      for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].v === choice) ms = PRESETS[i].ms;
      if (!ms) throw new Error('Pick when the link expires');
    }
    if (ms < MIN) throw new Error('The shortest timer is 1 minute');
    if (ms > MAX_MS) throw new Error('The longest timer is 30 days');
    return now + ms;
  }
  // The options a link is created with; throws a user-facing message.
  // o: { expiresAt, maxOpens (0 = anyone with the link; v1 callers pass oneTime), text }
  function checkOptions(o) {
    var cap = o.maxOpens != null ? Number(o.maxOpens) : (o.oneTime ? 1 : 0);
    if (!(cap >= 0) || cap !== Math.floor(cap) || cap > MAX_VIEWERS) throw new Error('Pick how many people can open it (1 to ' + MAX_VIEWERS + ')');
    if (!o.expiresAt && !cap) throw new Error('Pick a time limit, or limit who can open it — otherwise the link never self-destructs');
    if (typeof o.text !== 'string') throw new Error('Nothing to share');
    if (o.text.length > MAX_TEXT) throw new Error('This note is too long for a link (' + Math.round(MAX_TEXT / 1000) + ' k characters max)');
    return true;
  }
  // "Who can open it": 'one' | 'some' (+ n) | 'any' → maxOpens, or throws.
  function capFrom(choice, n) {
    if (choice === 'any') return 0;
    if (choice === 'one') return 1;
    var k = Number(n);
    if (!(k >= 1) || k !== Math.floor(k)) throw new Error('Enter how many people can open it');
    if (k > MAX_VIEWERS) throw new Error('At most ' + MAX_VIEWERS + ' people — or pick “Anyone with the link”');
    return k;
  }
  function isExpired(meta, now) { return !!(meta && meta.expiresAt && now >= meta.expiresAt); }
  function msLeft(meta, now) { return meta && meta.expiresAt ? Math.max(0, meta.expiresAt - now) : Infinity; }
  // "4 min", "1 h 5 min", "2 d 3 h", "45 s"
  function fmtLeft(ms) {
    if (ms === Infinity) return '';
    if (ms <= 0) return '0 s';
    var s = Math.ceil(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.ceil(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return h + ' h' + (rm ? ' ' + rm + ' min' : '');
    var d = Math.floor(h / 24), rh = h % 24;
    return d + ' d' + (rh ? ' ' + rh + ' h' : '');
  }
  // A ticking clock "MM:SS" / "H:MM:SS" for the recipient's last hour, else fmtLeft.
  function fmtClock(ms) {
    if (ms === Infinity) return '';
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= DAY / 1000) return fmtLeft(ms);
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + p(m) : String(m)) + ':' + p(ss);
  }

  // ---- clocks ------------------------------------------------------------------------------------------
  // Every time here is server time. A device only knows its own clock, so the
  // owner measures the difference with one server-stamped write: the server
  // stamped `serverTs` somewhere between the device times l0 (before the write)
  // and l1 (once read back). → server − device (ms), or null.
  function clockOffset(serverTs, l0, l1) {
    if (!(serverTs > 0) || !(l0 > 0) || !(l1 >= l0)) return null;
    return Math.round(serverTs - (l0 + l1) / 2);
  }
  // A link's whole duration (0 = no timer).
  function ttlOf(e) {
    if (!e || !e.expiresAt) return 0;
    if (e.ttl > 0) return e.ttl;
    return e.created > 0 ? Math.max(0, e.expiresAt - e.created) : 0;
  }
  // Time left on a link as the owner's list shows it. Never more than the
  // link's whole duration: a device clock (or server-offset estimate) that's
  // off can't make a 1-minute link read "27 min left".
  function leftOf(e, now) {
    if (!e || !e.expiresAt) return Infinity;
    var left = Math.max(0, e.expiresAt - now), ttl = ttlOf(e);
    return ttl > 0 ? Math.min(left, ttl) : left;
  }

  // ---- who may open it ---------------------------------------------------------------------------------
  function count(o) { var n = 0; if (o && typeof o === 'object') for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++; return n; }
  // How many browsers may open it (0 = anyone with the link). v1 metas only had oneTime.
  function capOf(meta) {
    if (!meta) return 0;
    if (meta.maxOpens != null) { var n = Math.floor(Number(meta.maxOpens)); return n > 0 ? n : 0; }
    return meta.oneTime ? 1 : 0;
  }
  // What a link lets its reader do (a meta or an owner's entry): 'edit' (live
  // two-way), 'live' (watch the owner's changes, read only) or 'read' (a
  // snapshot). editable wins, so a link can't be both.
  // 'respond' (v4: a poll, date planner, list… — burn-respond-core.js) wins over
  // the rest: its meta also says live (so v3 readers keep its slots and show
  // the fallback text) but never editable.
  function modeOf(m) { return !m ? 'read' : m.respond ? 'respond' : m.editable ? 'edit' : m.live ? 'live' : 'read'; }
  // Live links (edit / live) keep their text on the server while the link is
  // alive, and a slot stays its browser's; a snapshot may burn after reading.
  function staysLive(m) { return modeOf(m) !== 'read'; }
  // The owner list's word for it.
  function modeWord(m) { var md = modeOf(m); return md === 'respond' ? 'responses' : md === 'edit' ? 'editable' : md === 'live' ? 'watch live' : 'read-only'; }
  // Owner devices keep an engine (LiveDoc) running only for these.
  function hasEngine(m) { var md = modeOf(m); return md === 'edit' || md === 'live'; }
  // A v1 one-time link: a single `claim` node rather than `claims`.
  function isV1Claim(meta) { return !!meta && meta.maxOpens == null && !!meta.oneTime; }

  // v1 one-time links — the transaction's update function: claim an unclaimed
  // link; leave any existing claim alone (undefined aborts — the result tells
  // whether it's ours).
  function claimUpdate(cur, me, now) {
    if (cur == null) return { by: me, at: now };
    return undefined;
  }
  function claimIsMine(val, me) { return !!(val && val.by && val.by === me); }

  // Capped links: `claims` is { <viewer>: at }, one slot per browser. Take a
  // slot when this browser has none and one is free; anything else aborts
  // (undefined) and the committed snapshot tells whether we hold one. Firebase
  // may first call this with a stale null; the server then reruns it.
  function claimsUpdate(cur, me, now, cap) {
    var c = cur && typeof cur === 'object' ? cur : {};
    if (c[me]) return undefined;
    if (count(c) >= cap) return undefined;
    var out = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    out[me] = now;
    return out;
  }
  function holdsSlot(claims, me) { return !!(me && claims && typeof claims === 'object' && claims[me]); }

  // What a recipient may do with a link, from the node's plain parts.
  // → { ok: true, needClaim } or { ok: false, why: 'opened'|'expired'|'revoked'|'gone'|'claimed' }
  function gate(node, now, me) {
    if (node.tomb) return { ok: false, why: node.tomb.why || 'gone' };
    if (!node.meta) return { ok: false, why: 'gone' };
    if (isExpired(node.meta, now)) return { ok: false, why: 'expired' };
    var cap = capOf(node.meta), ed = staysLive(node.meta);
    if (!cap) return { ok: true, needClaim: false };
    if (isV1Claim(node.meta)) {
      if (node.claim) {
        if (ed && claimIsMine(node.claim, me)) return { ok: true, needClaim: false };
        return { ok: false, why: ed ? 'claimed' : 'opened' };
      }
      return { ok: true, needClaim: true };
    }
    if (holdsSlot(node.claims, me)) return { ok: true, needClaim: false };     // this browser again
    if (count(node.claims) >= cap) return { ok: false, why: ed ? 'claimed' : 'opened' };
    return { ok: true, needClaim: true };
  }
  // A read-only capped link is deleted from the server once its last slot's
  // opener has read it (a v1 one-time link: by its only opener).
  function burnsAfterRead(meta, claims) {
    if (!meta || staysLive(meta)) return false;
    var cap = capOf(meta);
    if (!cap) return false;
    return isV1Claim(meta) || count(claims) >= cap;
  }

  // ---- owner side: status + sweep -------------------------------------------------------------------
  function capOfEntry(e) { return e.maxOpens != null ? (+e.maxOpens > 0 ? Math.floor(+e.maxOpens) : 0) : (e.oneTime ? 1 : 0); }
  function usedOf(e, node) {
    if (!node) return 0;
    if ((e.v || 1) < 2) return node.claim ? 1 : 0;
    return count(node.claims);
  }
  function lastClaimAt(e, node) {
    if ((e.v || 1) < 2) return (node.claim && node.claim.at) || 0;
    var t = 0, c = node.claims || {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k) && +c[k] > t) t = +c[k];
    return t;
  }
  // "Just one person" / "Up to 3 people" / "Anyone with the link"
  function capLabel(cap) { return cap === 1 ? 'Just one person' : cap > 1 ? 'Up to ' + cap + ' people' : 'Anyone with the link'; }
  // entry: the owner's record; node: { meta, claim, claims, tomb, presence } (undefined = not read yet).
  // → { state: 'waiting'|'opened'|'live'|'viewing'|'expired'|'revoked'|'gone', ended, viewers, used, cap, left, label }
  function statusOf(entry, node, now) {
    var left = leftOf(entry, now), cap = capOfEntry(entry);
    var why = entry.ended && entry.ended.why;
    if (!why && node) {
      if (node.tomb) why = node.tomb.why || 'gone';
      else if (node.meta === null) why = 'gone';
    }
    if (!why && entry.expiresAt && now >= entry.expiresAt) why = 'expired';
    if (why) {
      var L = { opened: cap > 1 ? 'Opened by ' + cap + ' — deleted' : 'Opened — deleted', expired: 'Expired', revoked: 'Revoked', gone: 'Gone' };
      return { state: why, ended: true, viewers: 0, used: 0, cap: cap, left: 0, label: L[why] || 'Ended' };
    }
    var viewers = node ? count(node.presence) : 0, used = cap ? usedOf(entry, node) : 0, md = modeOf(entry);
    var of = cap > 1 ? ' · ' + used + ' of ' + cap + ' opened' : '';
    var who = md === 'live' ? viewers + ' watching' : viewers + ' viewer' + (viewers > 1 ? 's' : '');
    if (viewers) return { state: md !== 'read' ? 'live' : 'viewing', ended: false, viewers: viewers, used: used, cap: cap, left: left,
      label: (md !== 'read' ? 'Live' : 'Open now') + ' · ' + who + of };
    if (used) return { state: 'opened', ended: false, viewers: 0, used: used, cap: cap, left: left,
      label: cap > 1 ? 'Opened by ' + used + ' of ' + cap : md !== 'read' ? 'Opened — not open now' : 'Opened' };
    return { state: 'waiting', ended: false, viewers: 0, used: 0, cap: cap, left: left, label: 'Waiting to be opened' };
  }

  // What the owner's sweep does with one share. → { act, why? }
  //   'tomb'  — destruct it now (delete the ciphertext, leave meta + tomb)
  //   'end'   — it already destructed; just record that
  //   'purge' — ended long enough ago: delete the node and forget the entry
  //   'keep'
  function sweepAction(entry, node, now) {
    if (entry.ended) return now - (entry.ended.at || 0) >= KEEP_ENDED_MS ? { act: 'purge' } : { act: 'keep' };
    if (!node) return { act: 'keep' };
    if (node.tomb) return { act: 'end', why: node.tomb.why || 'gone' };
    if (node.meta === null) return { act: 'end', why: 'gone' };
    if (entry.expiresAt && now >= entry.expiresAt) return { act: 'tomb', why: 'expired' };
    // A read-only capped link whose last slot was taken but whose opener never
    // got to delete the text (closed mid-way): finish the job after a grace minute.
    var cap = capOfEntry(entry);
    if (cap && !staysLive(entry) && usedOf(entry, node) >= cap && now - lastClaimAt(entry, node) > MIN) return { act: 'tomb', why: 'opened' };
    return { act: 'keep' };
  }
  // When the owner's device should next look (ms from now), or -1 for never.
  function nextSweepIn(entries, now) {
    var best = -1;
    (entries || []).forEach(function (e) {
      if (e.ended || !e.expiresAt) return;
      var d = Math.max(0, e.expiresAt - now) + 1500;
      if (best < 0 || d < best) best = d;
    });
    return best;
  }

  // Normalize the synced blob (another device may run older code).
  function normBlob(d) {
    var out = { v: 1, shares: [] }, seen = {};
    var list = d && Array.isArray(d.shares) ? d.shares : [];
    list.forEach(function (e) {
      if (!e || !validId(e.id) || !validKey(e.key) || !validDb(e.db) || seen[e.id]) return;
      seen[e.id] = 1;
      var x = {
        id: e.id, key: e.key, db: e.db, room: String(e.room || ''), title: String(e.title || e.room || ''),
        created: +e.created || 0, expiresAt: +e.expiresAt || 0, oneTime: !!e.oneTime, editable: !e.respond && !!e.editable, live: !e.editable && !e.respond && !!e.live, copy: !!e.copy,
        ended: e.ended && e.ended.why ? { why: String(e.ended.why), at: +e.ended.at || 0 } : null
      };
      if (e.v === 2) { x.v = 2; x.maxOpens = capOfEntry(e); }
      if (+e.ttl > 0) x.ttl = +e.ttl;
      if (e.respond) { x.respond = true; if (typeof e.rtype === 'string') x.rtype = e.rtype.slice(0, 20); }
      out.shares.push(x);
    });
    return out;
  }
  function hasActive(d) { return normBlob(d).shares.some(function (e) { return !e.ended; }); }

  // ---- the sealed head: what the reader is told about the note ------------------------------------------
  function cleanName(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, MAX_NAME); }
  // One emoji or a short symbol (at most two characters as people count them).
  function cleanIcon(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s) return '';
    var parts;
    try { parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), function (x) { return x.segment; }); }
    catch (e) { parts = Array.from(s); }
    return parts.slice(0, 2).join('').slice(0, 16);
  }
  // Script ids → the allow-listed ones, once each, in menu order.
  function cleanScripts(list) {
    var want = {};
    (Array.isArray(list) ? list : []).forEach(function (id) { want[String(id)] = 1; });
    return SCRIPTS.filter(function (s) { return want[s.id]; }).map(function (s) { return s.id; });
  }
  // What the owner seals. o: { title, copy, icon, timer, editable, live, scripts }
  // Tidy-up tools only for 'edit'; `live` repeats the plain meta's flag.
  function makeHead(o) {
    return { title: cleanName(o.title) || 'Shared note', copy: !!o.copy, icon: cleanIcon(o.icon), timer: o.timer !== false,
      scripts: o.editable ? cleanScripts(o.scripts) : [], live: modeOf(o) === 'live' };
  }
  // A head as read; v1 links sealed only { title, copy }, v2 no `live`.
  function readHead(h) {
    h = h && typeof h === 'object' ? h : {};
    var out = { title: cleanName(h.title), copy: !!h.copy, icon: cleanIcon(h.icon), timer: h.timer !== false, scripts: cleanScripts(h.scripts), live: h.live === true };
    if (h.respond && typeof h.respond === 'object') out.respond = true;     // (its content: burn-respond-core's readRespond)
    return out;
  }
  // How the reader's page shows a link. A "watch live" view needs both the
  // plain meta and the sealed head to say so; anything else falls back to the
  // snapshot (as code from before v3 does).
  function viewOf(meta, head) {
    var md = modeOf(meta);
    if (md === 'live' && !(head && head.live)) return 'read';
    if (md === 'respond' && !(head && head.respond)) return 'read';
    return md;
  }

  // ---- tidy-up tools for the reader -----------------------------------------------------------------------
  // The app's own text scripts (txt/scripts/<pack>/), but only an allow-list of
  // pure text transforms: no prompts, no network, no files, no app UI.
  // burn.test.js checks each one still exists in its pack and stays pure.
  var SCRIPTS = [
    { id: 'sort', pack: 'pack-lines', script: 'Sort List', group: 'Lines', label: 'Sort lines A → Z', hint: 'Puts the lines in alphabetical order (2 comes before 10).' },
    { id: 'dedupe', pack: 'pack-lines', script: 'Unique Lines', group: 'Lines', label: 'Remove duplicate lines', hint: 'Keeps the first copy of every line.' },
    { id: 'blank', pack: 'pack-lines', script: 'Delete Blank Lines', group: 'Lines', label: 'Remove empty lines', hint: 'Deletes lines that are blank.' },
    { id: 'reverse', pack: 'pack-lines', script: 'Reverse List', group: 'Lines', label: 'Reverse the order', hint: 'Last line first, first line last.' },
    { id: 'number', pack: 'pack-lines', script: 'Number Lines', group: 'Lines', label: 'Number the lines', hint: 'Adds 1. 2. 3. in front of each line.' },
    { id: 'bullets', pack: 'pack-lines', script: 'Bullet List', group: 'Lines', label: 'Bullet points on / off', hint: 'Adds “- ” in front of each line, or takes it away.' },
    { id: 'checklist', pack: 'pack-tools', script: 'Convert Todo', group: 'Lines', label: 'Turn into a checklist', hint: 'Puts [ ] boxes in front of the lines (again: back to bullets).' },
    { id: 'join', pack: 'pack-lines', script: 'Flatten', group: 'Lines', label: 'Join into one line', hint: 'Puts all the lines together, separated by spaces.' },
    { id: 'tidy', pack: 'pack-tools', script: 'Trim / Clean', group: 'Clean up', label: 'Tidy spaces and gaps', hint: 'Trims spaces at the ends of lines and squeezes runs of blank lines.' },
    { id: 'quotes', pack: 'pack-clean', script: 'Straighten Quotes', group: 'Clean up', label: 'Plain quotes and dashes', hint: 'Turns “curly” quotes, long dashes and … into plain keyboard ones.' },
    { id: 'renumber', pack: 'pack-clean', script: 'Renumber Lists', group: 'Clean up', label: 'Fix list numbering', hint: 'Makes numbered lists count 1, 2, 3 again.' },
    { id: 'upper', pack: 'pack-case', script: 'Upper Case', group: 'Capitals', label: 'ALL CAPITALS', hint: 'Every letter as a capital.' },
    { id: 'lower', pack: 'pack-case', script: 'Lower Case', group: 'Capitals', label: 'all small letters', hint: 'No capitals at all.' },
    { id: 'title', pack: 'pack-case', script: 'Title Case', group: 'Capitals', label: 'Title Case', hint: 'A Capital At The Start Of Each Word (not “a”, “the”, “of”…).' },
    { id: 'sentence', pack: 'pack-clean', script: 'Sentence case', group: 'Capitals', label: 'Sentence case', hint: 'Small letters, with a capital at the start of each sentence.' },
    { id: 'json', pack: 'pack-data', script: 'JSON Format', group: 'Formats', label: 'Format JSON neatly', hint: 'Indents JSON data so it’s easy to read.' },
    { id: 'table', pack: 'pack-data', script: 'Format Table', group: 'Formats', label: 'Line up a table', hint: 'Aligns the columns of a | pipe | table.' },
    { id: 'csv', pack: 'pack-clean', script: 'CSV → Markdown Table', group: 'Formats', label: 'Commas → table', hint: 'Turns comma-separated lines into a | pipe | table.' }
  ];
  function scriptById(id) { for (var i = 0; i < SCRIPTS.length; i++) if (SCRIPTS[i].id === id) return SCRIPTS[i]; return null; }
  function packsFor(ids) {
    var seen = {}, out = [];
    cleanScripts(ids).forEach(function (id) { var p = scriptById(id).pack; if (!seen[p]) { seen[p] = 1; out.push(p); } });
    return out;
  }
  // A pack file's source → { <script name>: code }. The file runs against a
  // stand-in `window` whose only Cade method is registerScript, so loading a
  // pack this way registers nothing in the app and touches nothing else.
  function splitScript(s) {
    s = String(s);
    var m = s.match(/\/\*\*\s*([\s\S]*?)\s*\*\*\//);
    if (!m) return null;
    try { var meta = JSON.parse(m[1]); return meta && meta.name ? { name: String(meta.name), code: s.slice(m.index + m[0].length).trim() } : null; } catch (e) { return null; }
  }
  function parsePack(src) {
    var out = {};
    var stub = { Cade: { registerScript: function (s) { var p = splitScript(s); if (p) out[p.name] = p.code; }, asset: function (x) { return x; }, baseURL: function () { return ''; }, loadCSS: function () {} } };
    new Function('window', String(src))(stub);
    return out;
  }
  // Inside a script these (and `this`) are undefined, so one that reaches for
  // the page, the network, storage or a dialog fails instead of acting. Not a
  // security boundary — the tools are the app's own allow-listed code — just a
  // guard against a tool that needs app UI.
  var SHADOW = ['window', 'document', 'self', 'globalThis', 'top', 'parent', 'frames', 'prompt', 'confirm', 'alert', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'Worker', 'importScripts', 'Cade', 'editor', 'firebase'];
  // The smallest replacement turning a into b. → { from, to, insert }
  function minimalEdit(a, b) {
    var n = Math.min(a.length, b.length), p = 0, s = 0;
    while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
  }
  // Runs a script's source on `text` the way the editor runs it: on the
  // selection [from, to) when there is one, else on the whole text.
  // → { from, to, insert, messages } — insert null when nothing changed;
  // throws on a script error (or an async script, which can't run here).
  function runScript(code, text, from, to) {
    text = String(text == null ? '' : text);
    from = Math.max(0, Math.min(text.length, from | 0)); to = Math.max(from, Math.min(text.length, to | 0));
    var hasSel = from < to, full = text, edit = hasSel ? text.slice(from, to) : '', fullCh = false, editCh = false, messages = [];
    var ctx = {
      get fullText() { return full; },
      set fullText(v) { full = String(v); fullCh = true; },
      get selection() { return hasSel ? edit : ''; },
      set selection(v) { if (hasSel) { edit = String(v); editCh = true; } else { full = String(v); fullCh = true; } },
      get text() { return hasSel ? edit : full; }
    };
    var toast = function (m, kind) { messages.push({ text: String(m), kind: kind || 'info' }); };
    var fn = new Function(['ctx', 'showToast'].concat(SHADOW).join(','), String(code) + '\n;return main.call(this, ctx);');
    var r = fn.call({}, ctx, toast);
    if (r && typeof r.then === 'function') throw new Error('This tool can’t run here');
    if (hasSel && editCh) return edit === text.slice(from, to) ? { from: from, to: to, insert: null, messages: messages } : { from: from, to: to, insert: edit, messages: messages };
    if (fullCh && full !== text) { var d = minimalEdit(text, full); d.messages = messages; return d; }
    return { from: from, to: to, insert: null, messages: messages };
  }

  // ---- merging concurrent edits -------------------------------------------------------------------------
  // Words / spaces / single other characters; newlines are tokens too.
  var TOK_RE;
  try { TOK_RE = new RegExp('\\r\\n|\\n|\\r|[^\\S\\r\\n]+|[\\p{L}\\p{N}_]+|[\\s\\S]', 'gu'); }
  catch (e) { TOK_RE = /\r\n|\n|\r|[^\S\r\n]+|[A-Za-z0-9_À-￿]+|[\s\S]/g; }
  function toks(s) { return String(s).match(TOK_RE) || []; }
  function chars(s) { return Array.from(String(s)); }
  // Tokens as "lines" for merge3 (escaped so none holds a line break).
  function tokText(list) { return list.map(function (t) { return t.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }).join('\n'); }
  function untok(lines) { return lines.map(function (t) { return t.replace(/\\(\\|r|n)/g, function (_, c) { return c === 'r' ? '\r' : c === 'n' ? '\n' : '\\'; }); }).join(''); }

  // Three-way merge over tokens (words, or characters); null on a conflict
  // unless `union`, which keeps both sides of it (theirs, then mine).
  function mergeTokens(core, split, base, mine, theirs, union) {
    var r = core.merge3(tokText(split(base)), tokText(split(mine)), tokText(split(theirs)));
    if (r.conflicts && !union) return null;
    var out = [];
    r.chunks.forEach(function (c) {
      var lines = c.type === 'same' ? c.lines : c.type === 'conflict' ? c.theirs.concat(c.mine) : core.resolveChunk(c, core.defaultChoice(c));
      for (var i = 0; i < lines.length; i++) out.push(lines[i]);   // (an empty text's lone "" line adds nothing)
    });
    return untok(out);
  }
  function mergeWords(core, base, mine, theirs) {
    var w = mergeTokens(core, toks, base, mine, theirs, false);
    return w != null ? w : mergeTokens(core, chars, base, mine, theirs, true);
  }
  // base → mine (this side's edits) and base → theirs (the other side's),
  // merged by line; where both changed the same lines, by word; where both
  // changed the same word, by character, keeping both where they overlap.
  // Never fails and never drops an edit.
  function mergeLive(core, base, mine, theirs) {
    if (mine === theirs || theirs === base) return mine;
    if (mine === base) return theirs;
    var r = core.merge3(base, mine, theirs);
    if (!r.conflicts) return r.merged;
    return mergeWords(core, base, mine, theirs);
  }

  // Where the caret goes when `prev` becomes `next` (the smallest change:
  // common head and tail kept).
  function mapPos(prev, next, pos) {
    var a = prev.length, b = next.length, p = 0, n = Math.min(a, b);
    while (p < n && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    var s = 0;
    while (s < n - p && prev.charCodeAt(a - 1 - s) === next.charCodeAt(b - 1 - s)) s++;
    if (pos <= p) return pos;
    if (pos >= a - s) return pos + (b - a);
    return b - s;
  }

  // ---- live documents ------------------------------------------------------------------------------------
  function isVer(n) { return typeof n === 'number' && n >= 1 && n <= 9007199254740991 && Math.floor(n) === n; }
  function textOf(x) { return String(x && x.t != null ? x.t : ''); }
  // Firebase's transaction; applyLocally = false: no optimistic local events —
  // a version counts only once the server took it.
  function txn(ref, fn) { return ref.transaction(fn, undefined, false); }
  // Whose version it claims to be. Not proof (it's a plain field) — only used
  // to decide whether the owner puts the room's text straight back.
  function ownerWrote(v) { return !!v && typeof v.by === 'string' && v.by.slice(0, 2) === 'o:'; }

  // LiveDoc: one writer of a live link.
  // o: { ref (the share's doc), id, key, me, now(), merge (merge-core), pushMs,
  //      get() → text | Promise | null, apply(merged, seen) → Promise,
  //      loadBase() → Promise<{ver,text}|null>, saveBase(shared), adoptFirst (bool),
  //      onGone(), onSync(state), pushOnly (bool) }
  //  - two-way ('edit'): someone else's newer version is merged into the local
  //    text (apply), then pushed back if it changed.
  //  - pushOnly (the owner of a "watch live" link): sends the local text, and
  //    NEVER changes it — `apply` is dropped here, so nothing that arrives
  //    (anyone with the key can write a version) can reach the room. What
  //    arrives only numbers the next push; a version that doesn't look like
  //    the owner's own (or doesn't open) is overwritten with the room's text.
  //    The saved base is the last text this device and the link agreed on, so
  //    a device that changed the room while the app was closed sends it at
  //    start, and a device with a stale copy of the room stays quiet.
  function LiveDoc(o) {
    var docRef = o.ref, pushOnly = !!o.pushOnly, PUSH_MS = o.pushMs || 350;
    var apply = pushOnly ? null : o.apply;          // the hard rule (see above)
    var shared = null, latest = null, stopped = false, timer = 0, retry = 0, fails = 0, chain = Promise.resolve(), baseLoaded = null;
    var top = 0, started = false;                   // pushOnly: the highest version seen; first version handled
    function enqueue(fn) {
      chain = chain.then(function () { if (!stopped) return fn(); }).catch(function (e) { if (typeof console !== 'undefined') console.warn('burn live:', e); });
      return chain;
    }
    function state(s) { if (o.onSync) try { o.onSync(s); } catch (e) {} }
    function base() {
      if (!baseLoaded) baseLoaded = Promise.resolve(o.loadBase ? o.loadBase() : null).catch(function () { return null; });
      return baseLoaded;
    }
    function onVal(s) { latest = s.val(); enqueue(pushOnly ? incomingPushOnly : incoming); }
    docRef.on('value', onVal);

    function incoming() {
      var v = latest;
      if (!v) { stop(); o.onGone(); return; }
      if (shared && (v.ct === shared.ct || v.ver <= shared.ver)) return;
      var theirsP = open(o.key, o.id, 'v' + v.ver, v.ct).then(textOf);
      return Promise.all([theirsP, base()]).then(function (r) {
        var theirs = r[0], b = shared || r[1];
        if (stopped) return;
        if (!b) {
          // First sight with nothing to merge against: adopt it (the guest
          // shows it; an owner device without a base leaves the room alone).
          shared = { ver: v.ver, text: theirs, ct: v.ct };
          if (o.saveBase) o.saveBase(shared);
          if (o.adoptFirst) return Promise.resolve(apply(theirs, null)).then(function () { state('synced'); });
          state('synced');
          return;
        }
        if (b.ver >= v.ver) { shared = { ver: b.ver, text: b.text, ct: b.ct }; return; }
        return Promise.resolve(o.get()).then(function (local) {
          if (local == null) throw new Error('no local text');
          var merged = mergeLive(o.merge, b.text, local, theirs);
          var applied = merged === local ? null : apply(merged, local);
          return Promise.resolve(applied).then(function () {
            shared = { ver: v.ver, text: theirs, ct: v.ct };
            if (o.saveBase) o.saveBase(shared);
            fails = 0;
            if (merged !== theirs) schedule(); else state('synced');
          });
        });
      }).catch(function (e) {
        // Couldn't apply it here right now (a busy / locked room…): try again soon from the newest version.
        if (stopped) return;
        state('retry');
        clearTimeout(retry);
        if (++fails <= 40) retry = setTimeout(function () { enqueue(incoming); }, Math.min(1500 * fails, 15000));
        throw e;
      });
    }

    // pushOnly: read what arrived, never take it in.
    function incomingPushOnly() {
      var v = latest;
      if (!v) { stop(); o.onGone(); return; }
      if (shared && v.ct === shared.ct && v.ver === shared.ver) return;
      if (isVer(v.ver) && v.ver > top) top = v.ver;
      var theirsP = isVer(v.ver) && typeof v.ct === 'string'
        ? open(o.key, o.id, 'v' + v.ver, v.ct).then(textOf, function () { return null; })
        : Promise.resolve(null);
      var localP = Promise.resolve().then(function () { return o.get(); }).catch(function () { return null; });
      return Promise.all([theirsP, base(), localP]).then(function (r) {
        if (stopped) return;
        var theirs = r[0], b = r[1], local = r[2], first = !started;
        started = true;
        shared = { ver: v.ver, text: theirs, ct: v.ct };
        if (local == null) return;                                  // the room can't be read here right now
        if (theirs === local) { if (o.saveBase) o.saveBase({ ver: v.ver, text: local, ct: v.ct }); state('synced'); return; }
        if (theirs == null || !ownerWrote(v)) { schedule(); return; } // not the owner's: put the room's text back
        if (first && b && b.text !== local) schedule();             // changed here since this device last pushed
      });
    }

    function push() {
      if (!shared) return;
      return Promise.resolve(o.get()).then(function (local) {
        if (stopped || local == null || local === shared.text) { state('synced'); return; }
        var baseVer = shared.ver, baseCt = shared.ct, me = o.me;
        // pushOnly: above every version seen, so readers (who skip older ones) take it.
        var ver = pushOnly ? Math.max(top, isVer(baseVer) ? baseVer : 0) + 1 : baseVer + 1;
        state('saving');
        return seal(o.key, o.id, 'v' + ver, { t: local }).then(function (ct) {
          if (stopped || shared.ver !== baseVer || (pushOnly && shared.ct !== baseCt)) return;      // someone else's version came in meanwhile
          return txn(docRef, function (cur) {
            if (cur === null) return null;                       // gone (or not cached yet: the server reruns us)
            if (pushOnly ? JSON.stringify([cur.ver, cur.ct]) !== JSON.stringify([baseVer, baseCt]) : cur.ver !== baseVer) return undefined;   // lost the race
            return { ver: ver, ct: ct, by: me, base: baseVer, at: o.now() };
          }).then(function (r) {
            var val = r && r.snapshot ? r.snapshot.val() : null;
            if (r && r.committed && !val) { stop(); o.onGone(); return; }
            if (r && r.committed && val && val.ct === ct) {
              if (pushOnly) top = Math.max(top, ver);
              if (!shared || (pushOnly ? shared.ct !== ct : shared.ver < ver)) { shared = { ver: ver, text: local, ct: ct }; if (o.saveBase) o.saveBase(shared); }
            }
            // Typed on while it was in flight, or lost the race (the value listener merges first): go again.
            return Promise.resolve(o.get()).then(function (now) { if (now != null && shared && now !== shared.text) schedule(); else state('synced'); });
          });
        });
      });
    }
    function schedule() {
      if (stopped || timer) return;
      state('pending');
      timer = setTimeout(function () { timer = 0; enqueue(push); }, PUSH_MS);
    }
    function flush() { clearTimeout(timer); timer = 0; return enqueue(push); }
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer); clearTimeout(retry);
      try { docRef.off('value', onVal); } catch (e) {}
    }
    return { changed: schedule, flush: flush, stop: stop, get shared() { return shared; }, pushOnly: pushOnly };
  }

  // Follow: the reader of a "watch live" link. Shows each newer version as it
  // arrives; never writes. A version that doesn't open with the link's key is
  // skipped; one older than what's shown never replaces it.
  // o: { ref (the share's doc), id, key, ver (the version shown), show(text, ver), onGone() }
  function Follow(o) {
    var docRef = o.ref, shown = isVer(o.ver) ? o.ver : 0, seen = shown, stopped = false;
    function onVal(s) {
      if (stopped) return;
      var v = s.val();
      if (!v) { stop(); o.onGone(); return; }
      if (!isVer(v.ver) || v.ver <= seen || typeof v.ct !== 'string') return;
      var ver = seen = v.ver;
      open(o.key, o.id, 'v' + ver, v.ct).then(function (x) {
        if (stopped || ver <= shown) return;
        shown = ver;
        o.show(textOf(x), ver);
      }, function () {});
    }
    function stop() {
      if (stopped) return;
      stopped = true;
      try { docRef.off('value', onVal); } catch (e) {}
    }
    docRef.on('value', onVal);
    return { stop: stop, get shown() { return shown; } };
  }

  var api = {
    PRESETS: PRESETS, MAX_MS: MAX_MS, MAX_TEXT: MAX_TEXT, KEEP_ENDED_MS: KEEP_ENDED_MS,
    b64u: b64u, unb64u: unb64u, newId: newId, newKey: newKey, newViewer: newViewer,
    validId: validId, validKey: validKey, validDb: validDb, nodePath: nodePath,
    encodeLink: encodeLink, decodeLink: decodeLink, seal: seal, open: open,
    expiryFrom: expiryFrom, checkOptions: checkOptions, isExpired: isExpired, msLeft: msLeft, fmtLeft: fmtLeft, fmtClock: fmtClock,
    capFrom: capFrom, clockOffset: clockOffset, ttlOf: ttlOf, leftOf: leftOf, MAX_VIEWERS: MAX_VIEWERS, MAX_NAME: MAX_NAME,
    capOf: capOf, isV1Claim: isV1Claim, claimUpdate: claimUpdate, claimIsMine: claimIsMine, claimsUpdate: claimsUpdate, holdsSlot: holdsSlot,
    gate: gate, burnsAfterRead: burnsAfterRead, capOfEntry: capOfEntry, capLabel: capLabel, count: count,
    statusOf: statusOf, sweepAction: sweepAction, nextSweepIn: nextSweepIn, normBlob: normBlob, hasActive: hasActive,
    cleanName: cleanName, cleanIcon: cleanIcon, cleanScripts: cleanScripts, makeHead: makeHead, readHead: readHead,
    SCRIPTS: SCRIPTS, scriptById: scriptById, packsFor: packsFor, parsePack: parsePack, runScript: runScript, minimalEdit: minimalEdit,
    mergeLive: mergeLive, mergeWords: mergeWords, mapPos: mapPos,
    modeOf: modeOf, staysLive: staysLive, modeWord: modeWord, hasEngine: hasEngine, viewOf: viewOf, LiveDoc: LiveDoc, Follow: Follow, isVer: isVer
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeBurnCore = api;
})(typeof window !== 'undefined' ? window : null);
