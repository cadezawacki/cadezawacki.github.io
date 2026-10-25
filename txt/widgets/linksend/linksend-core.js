/* Send to device — shared core (the widget, the ?send= sheet and the receiver plugin).
 *
 * Pure rules, exported for node (node txt/widgets/linksend/linksend.test.js):
 * which URLs may travel and open (http / https only), when a link is too old
 * to open by itself (TTL → "Missed links"), the receiver's rate limit, picking
 * the target from ?to= or the one online receiver, the message / ack shapes,
 * the sender's status line and the iOS Shortcut / bookmarklet strings.
 *
 * In the app it also does the cloud side. Everything lives under
 * Cade.cloud.ref('linksend') = rooms/__cade_linksend_<keyFp>/ and every payload
 * is sealed with the sync key, so the server only ever sees routing ids and
 * timestamps:
 *   dev/<deviceId>        { s: sealed {n name, k kind, t ttl minutes, p pop-ups 'ok'|'blocked'|''},
 *                           at: last active, live: { <tab>: connected-at } }   a receiver (plugin on)
 *   to/<deviceId>/<id>    { s: sealed message, at, c?: claiming tab, ct? }     its inbox
 *   ack/<deviceId>/<id>   { s: sealed ack, at }                                answers to a sender
 * `live` entries are removed by the server when a tab's connection drops
 * (onDisconnect), so "online" needs no heartbeat while a tab sits in the
 * background; `at` is refreshed only while the page is visible. A receiver
 * deletes each message once handled; a sender deletes each ack once read.
 * Device-local: received / sent history (last 20 each) and the ids already
 * handled (a replayed message is ignored). */
(function (root) {
  'use strict';

  var TTL_DEFAULT = 10;                // minutes
  var RATE_MAX = 5, RATE_WINDOW = 60000;
  var HISTORY_MAX = 20, MAX_URL = 8192, MAX_TITLE = 300;
  var STALE_DEVICE = 60 * 86400000;    // a receiver not seen for 60 days is not offered
  var INBOX_KEEP = 7 * 86400000;       // undelivered messages are swept after a week
  var CLAIM_MS = 60000;                // a tab's claim on a message it never finished
  var ANSWER_MS = 8000;                // an online receiver normally answers well within this
  var ACK_STATES = ['opened', 'blocked', 'limited', 'expired', 'refused'];
  var KINDS = ['phone', 'tablet', 'desktop'];

  // ---- URLs ---------------------------------------------------------------------------------
  // Leading / trailing whitespace, C0/C1 controls, zero-width and bidi marks.
  var EDGE_JUNK = /^[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]+|[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]+$/g;
  var URLC = typeof URL === 'function' ? URL : null;
  // A web link, normalised (URL#href) — or null. Only http: and https: are
  // ever accepted: javascript:, data:, file:, blob:, about:, chrome: … are
  // refused whatever their case or the whitespace / control characters around
  // or inside the scheme (the URL parser strips tabs and newlines exactly as a
  // browser would before deciding the scheme). `lenient` (typed input only)
  // lets "example.com/x" mean https://example.com/x.
  function cleanUrl(s, lenient) {
    if (typeof s !== 'string' || !URLC) return null;
    s = s.replace(EDGE_JUNK, '');
    if (!s || s.length > MAX_URL) return null;
    if (lenient && !/^[a-z][a-z0-9+.\-]*:/i.test(s) && /^[^\s\/:?#@]+\.[a-z]{2,}(?::\d+)?([\/?#]|$)/i.test(s)) s = 'https://' + s;
    var u;
    try { u = new URLC(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href.length > MAX_URL ? null : u.href;
  }
  function hostOf(url) {
    try { return new URLC(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  // "example.com/some/path…" for a one-line label.
  function shortUrl(url, n) {
    var s;
    try { var u = new URLC(url); s = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search; } catch (e) { s = String(url || ''); }
    n = n || 60;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  // The first web link in a piece of text (a selection, the clipboard, a line).
  function findUrl(text) {
    if (typeof text !== 'string') return null;
    var whole = cleanUrl(text, true);
    if (whole && !/\s/.test(text.replace(EDGE_JUNK, ''))) return whole;
    var m = text.match(/https?:\/\/[^\s<>"'`)\]]+/i);
    return m ? cleanUrl(m[0].replace(/[.,;:!?]+$/, '')) : null;
  }
  function oneLine(s, n) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return n && s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ---- time ----------------------------------------------------------------------------------
  function ttlMs(min) {
    var m = +min;
    if (!isFinite(m) || m <= 0) m = TTL_DEFAULT;
    return Math.min(Math.max(m, 1), 24 * 60) * 60000;
  }
  // A message's send time: the older of the sealed stamp (the sender's clock,
  // server-corrected — a copied old message can't be made fresh) and the
  // routing stamp (the server's). No usable stamp → 0 (treated as too old).
  function sentAt(msgAt, routeAt) {
    var a = typeof msgAt === 'number' && isFinite(msgAt) && msgAt > 0 ? msgAt : 0;
    var b = typeof routeAt === 'number' && isFinite(routeAt) && routeAt > 0 ? routeAt : 0;
    return a && b ? Math.min(a, b) : (a || b);
  }
  // 'fresh' (may open by itself) or 'expired' (goes to Missed links).
  function classify(at, now, ttl) {
    if (typeof at !== 'number' || !isFinite(at) || at <= 0) return 'expired';
    return now - at > ttl ? 'expired' : 'fresh';
  }
  function fmtAgo(ms) {
    if (!(ms >= 0)) return '';
    var s = Math.round(ms / 1000);
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  // ---- receiver rate limit: at most `max` links open by themselves per `win` ms ---------------
  function makeLimiter(max, win) {
    max = max || RATE_MAX; win = win || RATE_WINDOW;
    var times = [];
    function trim(now) { while (times.length && now - times[0] >= win) times.shift(); }
    return {
      take: function (now) { trim(now); if (times.length >= max) return false; times.push(now); return true; },
      left: function (now) { trim(now); return max - times.length; },
      reset: function () { times = []; }
    };
  }

  // What a receiver does with a message: 'refused' (not a web link), 'expired'
  // (too old: Missed links), 'limited' (over the rate: listed, not opened) or
  // 'open'. Expired ones don't use up the rate.
  function decide(msg, routeAt, now, ttl, limiter, localNow) {
    if (!msg || msg.bad || !msg.url) return 'refused';
    if (classify(sentAt(msg.at, routeAt), now, ttl) === 'expired') return 'expired';
    if (limiter && !limiter.take(localNow == null ? now : localNow)) return 'limited';
    return 'open';
  }

  // ---- messages & acks ------------------------------------------------------------------------
  function newId(now) {
    var s = '', a = '0123456789abcdefghijklmnopqrstuvwxyz', n = 8;
    var r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(n)) : null;
    for (var i = 0; i < n; i++) s += a.charAt(r ? r[i] % 36 : Math.floor(Math.random() * 36));
    return (now || Date.now()).toString(36) + s;
  }
  function okId(id) { return typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id); }
  function readDevice(d) {
    if (!d || typeof d !== 'object') return null;
    var id = typeof d.id === 'string' && /^[a-z0-9]{1,24}$/.test(d.id) ? d.id : '';
    return { id: id, name: oneLine(d.name, 40) || 'Another device', kind: KINDS.indexOf(d.kind) >= 0 ? d.kind : 'desktop' };
  }
  // o: { id?, url, title?, room?, from: {id, name, kind}, at } → the sealed payload, or null for a non-web link.
  function makeMessage(o) {
    o = o || {};
    var url = cleanUrl(o.url);
    if (!url) return null;
    var m = { v: 1, id: okId(o.id) ? o.id : newId(o.at), url: url, title: oneLine(o.title, MAX_TITLE), from: readDevice(o.from) || readDevice({}), at: +o.at || Date.now() };
    if (o.room) m.room = oneLine(o.room, 100);
    return m;
  }
  // An unsealed message → normalised, or null (wrong shape). A bad URL keeps
  // the message (so the sender can be told) but marks it: { …, url: null, bad: true }.
  function readMessage(o) {
    if (!o || typeof o !== 'object' || !okId(o.id) || typeof o.url !== 'string') return null;
    var url = cleanUrl(o.url);
    var m = { v: 1, id: o.id, url: url, title: oneLine(o.title, MAX_TITLE), from: readDevice(o.from) || readDevice({}), at: typeof o.at === 'number' ? o.at : 0 };
    if (!url) m.bad = true;
    if (typeof o.room === 'string' && o.room.trim()) m.room = oneLine(o.room, 100);
    return m;
  }
  function makeAck(id, st, by, at, how) {
    if (!okId(id) || ACK_STATES.indexOf(st) < 0) return null;
    var a = { v: 1, id: id, st: st, by: readDevice(by) || readDevice({}), at: +at || Date.now() };
    if (how === 'tap' || how === 'note' || how === 'auto') a.how = how;
    return a;
  }
  function readAck(o) {
    if (!o || typeof o !== 'object') return null;
    return makeAck(o.id, o.st, o.by, o.at, o.how);
  }

  // ---- devices --------------------------------------------------------------------------------
  // One dev/<id> entry (with its unsealed info) → a receiver, or null.
  function deviceFromEntry(id, e, info, selfId) {
    if (!e || typeof e !== 'object' || !info || typeof info !== 'object') return null;
    var live = 0;
    if (e.live && typeof e.live === 'object') for (var k in e.live) if (e.live[k]) live++;
    var at = typeof e.at === 'number' ? e.at : 0;
    return {
      id: id, name: oneLine(info.n, 40) || 'Device', kind: KINDS.indexOf(info.k) >= 0 ? info.k : 'desktop',
      ttl: +info.t > 0 ? +info.t : TTL_DEFAULT, pop: info.p === 'ok' || info.p === 'blocked' ? info.p : '',
      at: at, live: live > 0, self: !!selfId && id === selfId
    };
  }
  // Receivers to offer: not this device (unless asked), not stale; online first, then most recently seen.
  function sortDevices(list, now, selfId, includeSelf) {
    return (list || []).filter(function (d) {
      if (!d || (!includeSelf && (d.self || d.id === selfId))) return false;
      return d.live || !d.at || now - d.at < STALE_DEVICE;
    }).sort(function (a, b) { return (b.live - a.live) || (b.at - a.at) || (a.name < b.name ? -1 : 1); });
  }
  function normName(s) { return String(s || '').toLowerCase().replace(/[\s ·•\-_]+/g, ' ').trim(); }
  // Which device a send goes to without asking: ?to= (id, else name — case and
  // spacing ignored — else the one name it starts or appears in), else the
  // only online receiver. → { target, why: 'to'|'only'|null, matches, missing }
  function pickTarget(list, to, selfId) {
    list = (list || []).filter(function (d) { return d && d.id !== selfId; });
    var res = { target: null, why: null, matches: [], missing: false };
    var want = normName(to);
    if (want && want !== 'any' && want !== 'ask') {
      var hit = list.filter(function (d) { return d.id === String(to).trim(); });
      if (!hit.length) hit = list.filter(function (d) { return normName(d.name) === want; });
      if (!hit.length) hit = list.filter(function (d) { return normName(d.name).indexOf(want) === 0; });
      if (!hit.length) hit = list.filter(function (d) { return normName(d.name).indexOf(want) >= 0; });
      if (hit.length > 1) { var on = hit.filter(function (d) { return d.live; }); if (on.length === 1) hit = on; }
      res.matches = hit;
      if (hit.length === 1) { res.target = hit[0]; res.why = 'to'; return res; }
      if (!hit.length) res.missing = true;
      return res;
    }
    var online = list.filter(function (d) { return d.live; });
    if (online.length === 1) { res.target = online[0]; res.why = 'only'; }
    return res;
  }
  function kindIcon(k) { return k === 'phone' || k === 'tablet' ? '📱' : '💻'; }

  // ---- what the sender shows for one sent link ------------------------------------------------
  // entry: { st, how, t0 (local send time) }, dev: { name, live, ttl, pop } → { icon, text, sub, tone }
  function statusFor(entry, dev, now) {
    var n = (dev && dev.name) || 'the other device', ttl = (dev && dev.ttl) || TTL_DEFAULT;
    var within = 'within ' + ttl + ' min';
    var age = now - ((entry && entry.t0) || now);
    switch (entry && entry.st) {
      case 'sending': return { icon: '…', text: 'Sending to ' + n + '…', sub: '', tone: 'busy' };
      case 'failed': return { icon: '⚠', text: 'Couldn’t send to ' + n, sub: 'Check your connection and try again.', tone: 'bad' };
      case 'opened':
        return { icon: '✓', text: entry.how === 'note' ? 'Opened the note on ' + n + ' ✓' : 'Opened on ' + n + ' ✓',
          sub: entry.how === 'tap' ? 'Opened with a tap on that screen.' : '', tone: 'ok' };
      case 'blocked': return { icon: '⚠', text: n + ' blocked the pop-up', sub: 'It’s waiting there — tap Open on that screen.', tone: 'warn' };
      case 'limited': return { icon: '⏸', text: 'Waiting on ' + n, sub: 'It got several links at once — tap Open on that screen.', tone: 'warn' };
      case 'expired': return { icon: '📥', text: 'Saved to Missed links on ' + n, sub: 'It arrived too late to open by itself (after ' + ttl + ' min).', tone: 'warn' };
      case 'refused': return { icon: '⚠', text: n + ' refused it', sub: 'Only web links (http / https) open.', tone: 'bad' };
      case 'sent':
        if (age > ttl * 60000) return { icon: '📥', text: 'Not opened in time', sub: 'It’ll be in Missed links on ' + n + ' when txt opens there.', tone: 'warn' };
        if (dev && dev.live) {
          if (age < ANSWER_MS) return { icon: '…', text: 'Opening on ' + n + '…', sub: dev.pop === 'blocked' ? 'Pop-ups are blocked there, so it may wait for a tap.' : '', tone: 'busy' };
          return { icon: '⏳', text: n + ' hasn’t answered yet', sub: 'Its tab may be asleep — it’ll open when txt there wakes up (' + within + ').', tone: 'warn' };
        }
        return { icon: '🌙', text: n + ' is offline — it’ll open when txt is next open there (' + within + ')', sub: '', tone: 'warn' };
    }
    return { icon: '', text: '', sub: '', tone: '' };
  }

  // ---- setup strings --------------------------------------------------------------------------
  // The Text action of the iOS Shortcut ("Send to computer"): URL and TITLE are
  // replaced by the URL Encode actions' results in the Shortcut editor.
  function shortcutTemplate(base, to) {
    return base + '?send=URL&title=TITLE' + (to ? '&to=' + encodeURIComponent(to) : '');
  }
  // A desktop bookmarklet ("Send to phone") that opens txt?send=<this page> in a
  // new tab. Browsers percent-decode a javascript: URL once before running it,
  // so literal parts are escaped for that (% → %25) and for the '…' string.
  function bookmarklet(base, to) {
    var lit = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, '%27').replace(/%/g, '%25'); };
    var tail = to ? "+'&to=" + lit(encodeURIComponent(to)) + "'" : '';
    return "javascript:(function(){window.open('" + lit(base) + "?send='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)" + tail + ",'_blank');})()";
  }

  // ---- how to allow pop-ups, for the browser this is ---------------------------------------------
  function popupBrowser(ua, touchPoints) {
    ua = String(ua || '');
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Firefox\/|FxiOS/.test(ua)) return 'firefox';
    if (/Chrome\/|Chromium\/|CriOS/.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'safari';
    return 'chrome';
  }
  function htmlEsc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // → { id, name, steps: [html], others: [{ id, name, steps }] } — the detected browser first.
  function popupHelp(ua, host, touchPoints) {
    var h = '<b>' + htmlEsc(host || 'this site') + '</b>';
    var all = {
      chrome: { name: 'Chrome', steps: [
        'When a link is blocked, click the <b>pop-up blocked</b> icon (a small window with a red ✕) at the right end of the address bar.',
        'Choose <b>Always allow pop-ups and redirects from</b> ' + h + ', then <b>Done</b>.',
        'No icon yet? Press <b>Test</b> — a blocked test makes it appear. Or: Settings → Privacy and security → Site settings → Pop-ups and redirects → <b>Allowed to send pop-ups and use redirects</b> → Add → ' + h + '.'] },
      edge: { name: 'Edge', steps: [
        'When a link is blocked, click the <b>pop-up blocked</b> icon at the right end of the address bar.',
        'Choose <b>Always allow pop-ups and redirects from</b> ' + h + ', then <b>Done</b>.',
        'Or: Settings → Cookies and site permissions → Pop-ups and redirects → <b>Allow</b> → Add → ' + h + '.'] },
      firefox: { name: 'Firefox', steps: [
        'When a link is blocked, a bar appears under the address bar: “Firefox prevented this site from opening a pop-up window”.',
        'Click <b>Preferences</b> (Options on Windows) → <b>Allow pop-ups for</b> ' + h + '.',
        'Or: Settings → Privacy &amp; Security → Permissions → Block pop-up windows → <b>Exceptions…</b> → add ' + h + ' → Allow.'] },
      safari: { name: 'Safari on a Mac', steps: [
        'Safari menu → <b>Settings for This Website…</b> (or right-click the address bar).',
        '<b>Pop-up Windows</b> → <b>Allow</b>.',
        'Or: Safari → Settings → Websites → Pop-up Windows → ' + h + ' → Allow.'] },
      ios: { name: 'Safari on iPhone / iPad', steps: [
        'Settings → Apps → Safari (iOS 17 and earlier: Settings → Safari) → turn <b>Block Pop-ups</b> off.',
        'That is for every site — leaving it on is fine too: a link then waits on a card here, one tap opens it. iOS also pauses Safari tabs in the background, so links open when txt is on screen.'] }
    };
    var id = popupBrowser(ua, touchPoints), out = { id: id, name: all[id].name, steps: all[id].steps, others: [] };
    ['chrome', 'edge', 'firefox', 'safari', 'ios'].forEach(function (k) { if (k !== id) out.others.push({ id: k, name: all[k].name, steps: all[k].steps }); });
    return out;
  }

  // ---- history (device-local, newest first) ---------------------------------------------------
  function histAdd(list, e, max) {
    list = (list || []).filter(function (x) { return x && x.id !== e.id; });
    list.unshift(e);
    return list.slice(0, max || HISTORY_MAX);
  }
  function histUpdate(list, id, patch) {
    return (list || []).map(function (x) {
      if (!x || x.id !== id) return x;
      var y = {}, k;
      for (k in x) y[k] = x[k];
      for (k in patch) y[k] = patch[k];
      return y;
    });
  }
  // Received but not opened: what "Missed links" lists.
  function missedOf(list) { return (list || []).filter(function (x) { return x && (x.st === 'blocked' || x.st === 'limited' || x.st === 'expired'); }); }

  var api = {
    TTL_DEFAULT: TTL_DEFAULT, RATE_MAX: RATE_MAX, RATE_WINDOW: RATE_WINDOW, HISTORY_MAX: HISTORY_MAX, ACK_STATES: ACK_STATES,
    INBOX_KEEP: INBOX_KEEP, CLAIM_MS: CLAIM_MS, ANSWER_MS: ANSWER_MS, STALE_DEVICE: STALE_DEVICE,
    cleanUrl: cleanUrl, hostOf: hostOf, shortUrl: shortUrl, findUrl: findUrl, oneLine: oneLine,
    ttlMs: ttlMs, sentAt: sentAt, classify: classify, decide: decide, fmtAgo: fmtAgo, makeLimiter: makeLimiter,
    newId: newId, okId: okId, makeMessage: makeMessage, readMessage: readMessage, makeAck: makeAck, readAck: readAck,
    deviceFromEntry: deviceFromEntry, sortDevices: sortDevices, pickTarget: pickTarget, kindIcon: kindIcon, normName: normName,
    statusFor: statusFor, shortcutTemplate: shortcutTemplate, bookmarklet: bookmarklet, popupBrowser: popupBrowser, popupHelp: popupHelp,
    histAdd: histAdd, histUpdate: histUpdate, missedOf: missedOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || !window.Cade || window.__cadeLinkCore) return;

  // =============================================================================================
  // In the app: cloud + device-local state
  // =============================================================================================
  var Cade = window.Cade;
  var KIND = 'linksend';
  var K_RECV = 'cade-linksend-recv', K_SENT = 'cade-linksend-sent', K_SEEN = 'cade-linksend-seen', K_POP = 'cade-linksend-pop';

  function ref(sub) {
    try { return Promise.resolve(Cade.cloud.ref(KIND, sub)).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
  }
  function seal(o) { return Cade.cloud.seal(o); }
  function unseal(s) { return Promise.resolve(Cade.cloud.unseal(s)).catch(function () { return null; }); }
  function me() { return Cade.cloud.device; }
  function now() { return Cade.cloud.serverNow(); }
  function configured() { try { return !!Cade.cloud.configured(); } catch (e) { return false; } }
  function changed(what) { try { document.dispatchEvent(new CustomEvent('cade-linksend-change', { detail: { what: what } })); } catch (e) {} }

  function loadList(key) { try { var a = JSON.parse(Cade.store.get(key) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object'; }) : []; } catch (e) { return []; } }
  function saveList(key, a) { try { if (a.length) Cade.store.set(key, JSON.stringify(a)); else Cade.store.remove(key); } catch (e) {} }
  var hist = {
    recv: function () { return loadList(K_RECV); },
    sent: function () { return loadList(K_SENT); },
    addRecv: function (e) { saveList(K_RECV, histAdd(loadList(K_RECV), e)); changed('recv'); },
    addSent: function (e) { saveList(K_SENT, histAdd(loadList(K_SENT), e)); changed('sent'); },
    updRecv: function (id, p) { saveList(K_RECV, histUpdate(loadList(K_RECV), id, p)); changed('recv'); },
    updSent: function (id, p) { saveList(K_SENT, histUpdate(loadList(K_SENT), id, p)); changed('sent'); },
    clear: function (which) { saveList(which === 'sent' ? K_SENT : K_RECV, []); changed(which); }
  };
  function seenList() { try { var a = JSON.parse(Cade.store.get(K_SEEN) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function seen(id) { return seenList().indexOf(id) >= 0; }
  function markSeen(id) {
    var a = seenList();
    if (a.indexOf(id) >= 0) return;
    a.push(id);
    try { Cade.store.set(K_SEEN, JSON.stringify(a.slice(-200))); } catch (e) {}
  }
  function popState() { try { return Cade.store.get(K_POP) || ''; } catch (e) { return ''; } }
  function setPopState(v) { try { if (v) Cade.store.set(K_POP, v); else Cade.store.remove(K_POP); } catch (e) {} changed('pop'); }
  function ttlPref() {
    try { return +Cade.prefs('linksend-recv').get('ttl') || TTL_DEFAULT; } catch (e) { return TTL_DEFAULT; }
  }

  // A shared Firebase listener with any number of subscribers: started by the
  // first, stopped with the last. `last` is replayed to late subscribers.
  function hub(start, replay) {
    var subs = [], stop = null, last;
    function emit(v) { if (replay) last = v; subs.slice().forEach(function (f) { try { f(v); } catch (e) { console.error(e); } }); }
    return {
      on: function (fn) {
        subs.push(fn);
        if (subs.length === 1) { last = undefined; stop = start(emit); }
        else if (replay && last === null && stop) { stop(); last = undefined; stop = start(emit); }   // was "no Sync": look again
        else if (replay && last !== undefined) setTimeout(function () { if (subs.indexOf(fn) >= 0) fn(last); }, 0);
        return function () {
          var i = subs.indexOf(fn);
          if (i < 0) return;
          subs.splice(i, 1);
          if (!subs.length && stop) { var s = stop; stop = null; last = undefined; s(); }
        };
      },
      last: function () { return last; }
    };
  }
  // Attach `attach(ref)` to ref(sub) — retrying while the database library is
  // still coming up (cold start); onNone() when Sync isn't set up at all.
  function withRef(sub, attach, onNone) {
    var dead = false, t = 0, tries = 0, detach = null;
    (function go() {
      ref(sub).then(function (r) {
        if (dead) return;
        if (!r) {
          if (!configured()) { if (onNone) onNone(); return; }
          t = setTimeout(go, Math.min(30000, 1000 * Math.pow(2, tries++)));
          return;
        }
        detach = attach(r);
      });
    })();
    return function () { dead = true; clearTimeout(t); if (detach) { try { detach(); } catch (e) {} detach = null; } };
  }

  // ---- receivers on this account (sender side) -------------------------------------------------
  // cb(list | null): every dev/ entry this key can open, unsorted (see sortDevices); null without Sync.
  var devices = hub(function (emit) {
    var gen = 0;
    return withRef('dev', function (r) {
      var fn = r.on('value', function (snap) {
        var v = (snap && snap.val()) || {}, g = ++gen, out = [], self = me().id;
        Promise.all(Object.keys(v).map(function (id) {
          var e = v[id];
          if (!e || typeof e.s !== 'string') return null;
          return unseal(e.s).then(function (info) { var d = deviceFromEntry(id, e, info, self); if (d) out.push(d); });
        })).then(function () { if (g === gen) emit(out); });
      }, function () { emit([]); });
      return function () { gen++; try { r.off('value', fn); } catch (e) {} };
    }, function () { emit(null); });
  }, true);

  // ---- acks for this device (sender side) ------------------------------------------------------
  // Each ack updates the sent history, is handed to subscribers, then deleted.
  var acks = hub(function (emit) {
    return withRef('ack/' + me().id, function (r) {
      var on = function (snap) {
        var v = snap && snap.val(), key = snap && snap.key;
        if (!v || typeof v.s !== 'string') { try { snap.ref.remove(); } catch (e) {} return; }
        unseal(v.s).then(function (o) {
          var a = readAck(o);
          try { snap.ref.remove(); } catch (e) {}
          if (!a || a.id !== key) return;
          var patch = { st: a.st, by: a.by.name, ackAt: a.at };
          if (a.how) patch.how = a.how;
          hist.updSent(a.id, patch);
          emit(a);
        });
      };
      var f1 = r.on('child_added', on, function () {}), f2 = r.on('child_changed', on, function () {});
      return function () { try { r.off('child_added', f1); r.off('child_changed', f2); } catch (e) {} };
    });
  }, false);

  // ---- send -------------------------------------------------------------------------------------
  var swept = {};
  function send(dev, req) {
    var d = me();
    var msg = makeMessage({ url: req.url, title: req.title, room: req.room, from: { id: d.id, name: d.name, kind: d.kind }, at: now() });
    if (!msg) return Promise.reject(new Error('Only web links (http / https) can be sent'));
    if (!dev || !dev.id) return Promise.reject(new Error('Pick a device'));
    hist.addSent({ id: msg.id, url: msg.url, title: msg.title, room: msg.room, to: dev.id, toName: dev.name, at: Date.now(), st: 'sending', test: !!req.test });
    return ref('to/' + dev.id + '/' + msg.id).then(function (r) {
      if (!r) throw new Error(configured() ? 'Not connected yet — try again in a moment' : 'Sync is not set up');
      return seal(msg).then(function (s) { return r.set({ s: s, at: Cade.cloud.TIMESTAMP }); });
    }).then(function () {
      var cur = hist.sent().filter(function (x) { return x.id === msg.id; })[0];
      if (cur && cur.st === 'sending') hist.updSent(msg.id, { st: 'sent' });
      sweep(dev.id);
      return msg;
    }, function (e) {
      hist.updSent(msg.id, { st: 'failed' });
      throw e;
    });
  }
  // Messages to a device that never came back are deleted after a week.
  function sweep(devId) {
    if (swept[devId]) return;
    swept[devId] = 1;
    ref('to/' + devId).then(function (r) {
      if (!r) return;
      return r.once('value').then(function (snap) {
        var v = (snap && snap.val()) || {}, t = now();
        Object.keys(v).forEach(function (k) { var e = v[k]; if (!e || !(e.at > 0) || t - e.at > INBOX_KEEP) r.child(k).remove().catch(function () {}); });
      });
    }).catch(function () {});
  }
  function sendAck(toId, ack) {
    if (!ack || !toId) return Promise.resolve();
    return ref('ack/' + toId + '/' + ack.id).then(function (r) {
      if (!r) return;
      return seal(ack).then(function (s) { return r.set({ s: s, at: Cade.cloud.TIMESTAMP }); });
    }).catch(function () {});
  }

  // ---- receiver: presence + inbox -------------------------------------------------------------
  // Presence: the sealed info and `at` (refreshed by touch() while visible),
  // plus live/<tab>, which the server drops when this tab's connection does.
  function presence() {
    var devRef = null, liveRef = null, conRef = null, conFn = null, dead = false, infoKey = '';
    function info() { var d = me(); return { n: d.name, k: d.kind, t: ttlPref(), p: popState() }; }
    function writeInfo() {
      if (!devRef) return Promise.resolve();
      var i = info(), k = JSON.stringify(i);
      return seal(i).then(function (s) { infoKey = k; return devRef.update({ s: s, at: Cade.cloud.TIMESTAMP }); }).catch(function () {});
    }
    function goLive() {
      if (!liveRef || dead) return;
      try { liveRef.onDisconnect().remove(); } catch (e) {}
      liveRef.set(Cade.cloud.TIMESTAMP).catch(function () {});
    }
    return {
      start: function () {
        return ref('dev/' + me().id).then(function (r) {
          if (!r || dead) return false;
          devRef = r;
          liveRef = r.child('live/' + me().tab);
          return writeInfo().then(function () {
            if (dead) return false;
            goLive();
            // after a dropped connection the server has removed live/<tab>: put it back
            try {
              conRef = r.root.child('.info/connected');
              var first = true;
              conFn = conRef.on('value', function (s) { if (first) { first = false; return; } if (s && s.val() === true) goLive(); });
            } catch (e) { conRef = null; }
            return true;
          });
        });
      },
      // still here (visible): bump `at`; re-seal only when the info changed (name, TTL, pop-ups)
      touch: function () {
        if (!devRef || dead) return;
        if (JSON.stringify(info()) !== infoKey) writeInfo();
        else devRef.child('at').set(Cade.cloud.TIMESTAMP).catch(function () {});
      },
      // withdraw: the plugin was switched off — leave no entry (not offered any more) and drop the inbox
      stop: function (withdraw) {
        dead = true;
        if (conRef && conFn) { try { conRef.off('value', conFn); } catch (e) {} }
        var r = devRef, l = liveRef, id = me().id;
        devRef = liveRef = conRef = conFn = null;
        if (l) { try { l.onDisconnect().cancel(); } catch (e) {} }
        if (withdraw) {
          if (r) r.remove().catch(function () {});
          ref('to/' + id).then(function (t) { if (t) t.remove().catch(function () {}); });
        } else if (r) {
          if (l) l.remove().catch(function () {});
          r.child('at').set(Cade.cloud.TIMESTAMP).catch(function () {});
        }
      }
    };
  }
  // Inbox: onMessage({ msg | null, at (routing), key }) for each message this tab
  // wins. Several tabs of one browser share a device id (and the inbox): a
  // transaction claims each message for one tab; a hidden tab waits a moment so
  // a visible one wins (that is where the person is looking).
  function listenInbox(onMessage, isVisible) {
    var inst = me().inst, timers = [], mine = {};
    return withRef('to/' + me().id, function (r) {
      var stopped = false;
      var on = function (snap) {
        var v = snap && snap.val(), key = snap && snap.key;
        if (!v || !key || mine[key]) return;
        if (v.c && v.c !== inst && now() - (+v.ct || 0) < CLAIM_MS) return;   // another tab has it
        mine[key] = 1;
        var t = setTimeout(function () {
          var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1);
          if (!stopped) claim(snap.ref, key);
        }, isVisible() ? 0 : 700);
        timers.push(t);
      };
      function claim(mr, key) {
        var done = function (err, committed, s) {
          var v = s && s.val && s.val();
          if (stopped) return;
          if (err || !committed || !v || v.c !== inst) { delete mine[key]; return; }
          if (seen(key)) { mr.remove().catch(function () {}); return; }   // handled before (a replay)
          if (typeof v.s !== 'string') { mr.remove().catch(function () {}); return; }
          unseal(v.s).then(function (o) {
            if (stopped) return;
            markSeen(key);
            var msg = readMessage(o);
            if (msg && msg.id !== key) msg = null;
            onMessage({ msg: msg, at: typeof v.at === 'number' ? v.at : 0, key: key, done: function () { return mr.remove().catch(function () {}); } });
          });
        };
        try {
          var p = mr.transaction(function (cur) {
            if (cur === null) return null;
            if (cur.c && cur.c !== inst && now() - (+cur.ct || 0) < CLAIM_MS) return;
            cur.c = inst; cur.ct = now();
            return cur;
          }, done, false);
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      var f1 = r.on('child_added', on, function () {});
      return function () { stopped = true; timers.forEach(clearTimeout); timers = []; try { r.off('child_added', f1); } catch (e) {} };
    });
  }

  api.KIND = KIND;
  api.configured = configured;
  api.me = me;
  api.now = now;
  api.ttlPref = ttlPref;
  api.hist = hist;
  api.popState = popState;
  api.setPopState = setPopState;
  api.devices = devices;
  api.acks = acks;
  api.send = send;
  api.sendAck = sendAck;
  api.presence = presence;
  api.listenInbox = listenInbox;
  api.markSeen = markSeen;
  api.changed = changed;
  window.__cadeLinkCore = api;
})(typeof self !== 'undefined' ? self : this);
