/* Self-destructing links — the DOM-free logic (burn.js is the UI and the
 * Firebase wiring). UMD: window.__cadeBurnCore in the page, module.exports in
 * node (burn.test.js).
 *
 * A share lives at rooms/__cade_burn_<id> in the OWNER's database (the
 * existing rules cover rooms/*). <id> is 128 random bits; the AES-GCM key is
 * 256 random bits. Both, plus the database URL, travel only in the link's
 * fragment (#burn=…), which browsers never send to a server. The node holds:
 *   meta     { v, created, expiresAt (ms, 0 = no timer), oneTime, editable }   plain, non-secret
 *   head     sealed { title, copy }                                          (AAD …/head)
 *   doc      { ver, ct: sealed { t }, by, base, at }                         (AAD …/<ver>)
 *   claim    { by, at }       one-time links: the first opener, set by a transaction
 *   presence { <viewer>: { at } }   open viewers (removed on disconnect)
 *   tomb     { why: 'opened' | 'expired' | 'revoked', at }   once it destructs;
 *            the ciphertext is gone then and only meta + tomb remain, so a
 *            later open can say why.
 * Everything here is client-enforced — there are no server functions — and
 * the UI copy says so.
 *
 * Live editing: every writer keeps `shared` = the last version it fully
 * incorporated. A push is a compare-and-swap transaction on doc (ver must
 * still be shared.ver); a newer version from someone else is three-way merged
 * (base = shared.text) into the local text with merge-core's merge3, and the
 * lines both sides changed are merged again word by word (mergeLive below),
 * so two people typing in the same paragraph keep both edits. */
(function (root) {
  'use strict';

  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var MAX_MS = 30 * DAY;                 // longest timer
  var MAX_TEXT = 900000;                 // chars a share may carry (Firebase node writes stay small)
  var KEEP_ENDED_MS = 7 * DAY;           // ended links keep their tombstone this long ("already opened")
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
  function checkOptions(o) {
    if (!o.expiresAt && !o.oneTime) throw new Error('Pick a time limit, or make it one-time — otherwise the link never self-destructs');
    if (typeof o.text !== 'string') throw new Error('Nothing to share');
    if (o.text.length > MAX_TEXT) throw new Error('This note is too long for a link (' + Math.round(MAX_TEXT / 1000) + ' k characters max)');
    return true;
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

  // ---- claim (one-time links) -----------------------------------------------------------------------
  // The transaction's update function: claim an unclaimed link; leave any
  // existing claim alone (undefined aborts — the result tells whether it's ours).
  function claimUpdate(cur, me, now) {
    if (cur == null) return { by: me, at: now };
    return undefined;
  }
  function claimIsMine(val, me) { return !!(val && val.by && val.by === me); }

  // What a recipient may do with a link, from the node's plain parts.
  // → { ok: true, needClaim } or { ok: false, why: 'opened'|'expired'|'revoked'|'gone'|'claimed' }
  function gate(node, now, me) {
    if (node.tomb) return { ok: false, why: node.tomb.why || 'gone' };
    if (!node.meta) return { ok: false, why: 'gone' };
    if (isExpired(node.meta, now)) return { ok: false, why: 'expired' };
    if (!node.meta.oneTime) return { ok: true, needClaim: false };
    if (node.claim) {
      if (node.meta.editable && claimIsMine(node.claim, me)) return { ok: true, needClaim: false };
      return { ok: false, why: node.meta.editable ? 'claimed' : 'opened' };
    }
    return { ok: true, needClaim: true };
  }

  // ---- owner side: status + sweep -------------------------------------------------------------------
  function count(o) { var n = 0; if (o && typeof o === 'object') for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++; return n; }
  // entry: the owner's record; node: { meta, claim, tomb, presence } (undefined = not read yet).
  // → { state: 'waiting'|'opened'|'live'|'viewing'|'expired'|'revoked'|'gone'|'claimed', ended, viewers, left, label }
  function statusOf(entry, node, now) {
    var left = entry.expiresAt ? Math.max(0, entry.expiresAt - now) : Infinity;
    var why = entry.ended && entry.ended.why;
    if (!why && node) {
      if (node.tomb) why = node.tomb.why || 'gone';
      else if (node.meta === null) why = 'gone';
    }
    if (!why && entry.expiresAt && now >= entry.expiresAt) why = 'expired';
    if (why) {
      var L = { opened: 'Opened — deleted', expired: 'Expired', revoked: 'Revoked', gone: 'Gone' };
      return { state: why, ended: true, viewers: 0, left: 0, label: L[why] || 'Ended' };
    }
    var viewers = node ? count(node.presence) : 0;
    if (viewers) return { state: entry.editable ? 'live' : 'viewing', ended: false, viewers: viewers, left: left,
      label: (entry.editable ? 'Live' : 'Open now') + ' · ' + viewers + ' viewer' + (viewers > 1 ? 's' : '') };
    if (node && node.claim) return { state: 'opened', ended: false, viewers: 0, left: left, label: entry.editable ? 'Opened — not open now' : 'Opened' };
    return { state: 'waiting', ended: false, viewers: 0, left: left, label: 'Waiting to be opened' };
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
    // A one-time read-only link whose viewer claimed it but never got to
    // delete the text (closed mid-way): finish the job after a grace minute.
    if (entry.oneTime && !entry.editable && node.claim && now - (node.claim.at || 0) > MIN) return { act: 'tomb', why: 'opened' };
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
      out.shares.push({
        id: e.id, key: e.key, db: e.db, room: String(e.room || ''), title: String(e.title || e.room || ''),
        created: +e.created || 0, expiresAt: +e.expiresAt || 0, oneTime: !!e.oneTime, editable: !!e.editable, copy: !!e.copy,
        ended: e.ended && e.ended.why ? { why: String(e.ended.why), at: +e.ended.at || 0 } : null
      });
    });
    return out;
  }
  function hasActive(d) { return normBlob(d).shares.some(function (e) { return !e.ended; }); }

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

  var api = {
    PRESETS: PRESETS, MAX_MS: MAX_MS, MAX_TEXT: MAX_TEXT, KEEP_ENDED_MS: KEEP_ENDED_MS,
    b64u: b64u, unb64u: unb64u, newId: newId, newKey: newKey, newViewer: newViewer,
    validId: validId, validKey: validKey, validDb: validDb, nodePath: nodePath,
    encodeLink: encodeLink, decodeLink: decodeLink, seal: seal, open: open,
    expiryFrom: expiryFrom, checkOptions: checkOptions, isExpired: isExpired, msLeft: msLeft, fmtLeft: fmtLeft, fmtClock: fmtClock,
    claimUpdate: claimUpdate, claimIsMine: claimIsMine, gate: gate,
    statusOf: statusOf, sweepAction: sweepAction, nextSweepIn: nextSweepIn, normBlob: normBlob, hasActive: hasActive,
    mergeLive: mergeLive, mergeWords: mergeWords, mapPos: mapPos
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__cadeBurnCore = api;
})(typeof window !== 'undefined' ? window : null);
