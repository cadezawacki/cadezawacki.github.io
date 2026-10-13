/* Storage Insights for Cade.txt — what the app keeps on THIS device, and safe
 * one-click cleanups.
 *
 * Everything is measured lazily when the panel opens, in small time slices
 * (the UI never blocks; the dashboard fills in as each step finishes):
 *   1. navigator.storage.estimate() / persisted()   — the browser's own view
 *   2. localStorage via Cade.store (chunk-aware sizeOf): room text caches,
 *      sync bases, versions, snapshots, settings, image fallback blobs
 *   3. snapshot stores (cade-snap:<room>) parsed for per-age cleanup plans
 *   4. IndexedDB via Cade.idbStore: images, files, drawings, module caches
 *   5. Cache Storage: the service worker's cade-v<N> buckets, Read Aloud's HD
 *      voice bucket and anything else on the origin
 *   6. indexedDB.databases() names (where supported)
 *
 * Cleanups never touch the server and never remove something that can't come
 * back without an explicit confirmation that names what will be lost. Where
 * the core already has a flow (Manage Storage, Attached Files, the snapshot
 * retention setting) the panel hands over to it instead of duplicating it.
 * Local copies of images/files are only offered for removal when they belong
 * to rooms whose text isn't kept here (offloaded / sync-only), are not queued
 * for upload, are not used by any document or snapshot stored here, AND the
 * server's listing confirms a copy — resolveImageRef()/resolveFileRef()
 * download them again on demand.
 *
 * The pure helpers (Logic) are unit-tested in node by storage.test.js.
 */
(function () {
  'use strict';

  // =========================================================================
  // Pure helpers — no DOM, no Cade.
  // =========================================================================
  var Logic = (function () {
    // Mirrors of core formats (persistent data layouts, so they can't drift
    // without a migration): image/file tokens, room key prefixes, the
    // idbStore→localStorage fallback prefix.
    var IMG_RE = /!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+\/=]+)(?:\|w(\d{2,4}))?\]/g;
    var FILE_RE = /!\[file:([^\]\n#|]{1,120})#([a-f0-9]{16,64})(?:\|s(\d{1,12}))?\]/g;
    var ROOM_PARTS = [
      ['cade-room-cache:', 'docs', 'text'], ['cade-room-synced:', 'docs', 'base'], ['cade-room-ver:', 'docs', 'ver'],
      ['cade-snap:', 'snaps', 'snap'], ['cade-autocolor:', 'settings', 'other'], ['cade-room-refs:', 'settings', 'other'],
    ];
    var IDB_FB = '\u0000idbfb\u0000';
    var HD_BUCKET = 'cade-tts-hd-v1';
    // Sizes of the big pinned Read Aloud HD assets, used when a cached
    // response carries no Content-Length (the worker stores bare Responses) so
    // measuring never has to pull a 63 MB model into memory.
    var KNOWN = [
      [/\/piper-voices\/.+\.onnx$/, 63201294],
      [/\/onnxruntime-web@[^\/]+\/dist\/ort-wasm-simd-threaded\.wasm$/, 11210254],
      [/\/phonemizer@[^\/]+\/dist\/phonemizer\.js$/, 1322380],
      [/\/onnxruntime-web@[^\/]+\/dist\/ort\.wasm\.min\.mjs$/, 48259],
      [/\/onnxruntime-web@[^\/]+\/dist\/ort-wasm-simd-threaded\.mjs$/, 20856],
    ];

    function fmt(n) {
      n = +n || 0;
      if (n <= 0) return '0 KB';
      if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
      return (n / 1073741824).toFixed(n < 10737418240 ? 2 : 1) + ' GB';
    }

    function classifyKey(k) {
      for (var i = 0; i < ROOM_PARTS.length; i++) {
        var p = ROOM_PARTS[i];
        if (k.indexOf(p[0]) === 0) {
          var room = k.slice(p[0].length);
          if (room) return { cat: p[1], room: room, part: p[2] };
        }
      }
      if (k.indexOf(IDB_FB) === 0) return { cat: 'files', fb: k.slice(IDB_FB.length) };
      return { cat: 'settings' };
    }

    function bucketKind(name) {
      if (/^cade-v\d+$/.test(name)) return 'app';
      if (name === HD_BUCKET) return 'hd';
      return 'other';
    }
    // The page activates a new service worker as soon as it installs and the
    // activate handler deletes every other cade-v<N>, so normally only one
    // bucket exists. Leftovers below the newest are debris — but while an
    // update is installing/waiting the two newest are both live, so nothing
    // is offered then.
    function appBuckets(names, pending) {
      var app = names.filter(function (n) { return bucketKind(n) === 'app'; })
        .map(function (n) { return { name: n, v: parseInt(n.slice(6), 10) }; })
        .sort(function (a, b) { return b.v - a.v; });
      if (pending) return { keep: app.map(function (a) { return a.name; }), old: [] };
      return { keep: app.slice(0, 1).map(function (a) { return a.name; }), old: app.slice(1).map(function (a) { return a.name; }) };
    }
    function knownSize(url) {
      for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i][0].test(url)) return KNOWN[i][1];
      return 0;
    }
    function voiceId(url) {
      var m = /\/piper-voices\/.*\/([^\/?#]+)\.onnx(\.json)?$/.exec(url);
      return m ? { id: m[1], model: !m[2] } : null;
    }
    function voiceLabel(id) {
      var m = /^([a-z]{2}_[A-Z]{2})-(.+?)-(x_low|low|medium|high)$/.exec(id);
      if (!m) return id;
      var name = m[2].replace(/_/g, ' ');
      return name.charAt(0).toUpperCase() + name.slice(1) + ' (' + m[1].replace('_', '-') + ', ' + m[3] + ')';
    }
    function shortUrl(url) {
      var m = /^https?:\/\/([^\/?#]+)([^?#]*)/.exec(url);
      if (!m) return url;
      var parts = m[2].split('/').filter(Boolean), last = parts.length ? decodeURIComponentSafe(parts[parts.length - 1]) : '/';
      return { host: m[1], name: last, path: m[2] };
    }
    function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

    // Image/file hashes referenced by a text → adds to sets {i:{}, f:{}}.
    function hashesIn(text, into) {
      into = into || { i: {}, f: {} };
      if (!text) return into;
      var m;
      if (text.indexOf('![img:') !== -1) {
        IMG_RE.lastIndex = 0;
        while ((m = IMG_RE.exec(text)) !== null) if (m[2] === '#') into.i[m[3]] = true;
      }
      if (text.indexOf('![file:') !== -1) {
        FILE_RE.lastIndex = 0;
        while ((m = FILE_RE.exec(text)) !== null) into.f[m[2]] = true;
      }
      return into;
    }
    // A cade-room-refs:<room> index → sets.
    function refsIndex(json, into) {
      into = into || { i: {}, f: {} };
      var r = null;
      try { r = JSON.parse(json || 'null'); } catch (e) {}
      if (r && typeof r === 'object') {
        (Array.isArray(r.i) ? r.i : []).forEach(function (h) { into.i[String(h)] = true; });
        (Array.isArray(r.f) ? r.f : []).forEach(function (h) { into.f[String(h)] = true; });
      }
      return into;
    }

    // ---- snapshots (cade-snap:<room> = JSON [{t, c}], newest first) ----------
    // Per-snapshot serialized length, so the size after any prune is exact
    // without re-serializing: JSON of an array = "[" + items.join(",") + "]".
    function snapItems(arr) {
      return (Array.isArray(arr) ? arr : []).map(function (s) {
        return { t: (s && +s.t) || 0, jl: JSON.stringify(s === undefined ? null : s).length };
      });
    }
    // Same rule as the core's pruneSnapsByAge: the newest always stays.
    function keepSnap(t, i, cutoff) { return i === 0 || t >= cutoff; }
    function snapPlan(items, valueLen, cutoff) {
      var kept = 0, keptLen = 0, removed = 0;
      items.forEach(function (it, i) {
        if (keepSnap(it.t, i, cutoff)) { kept++; keptLen += it.jl; } else removed++;
      });
      if (!removed) return { removed: 0, freed: 0 };
      var after = 2 + keptLen + Math.max(0, kept - 1);
      return { removed: removed, freed: Math.max(0, valueLen - after) * 2 };   // localStorage = UTF-16
    }
    function pruneSnaps(arr, cutoff) {
      return (Array.isArray(arr) ? arr : []).filter(function (s, i) { return keepSnap((s && +s.t) || 0, i, cutoff); });
    }

    // Local image/file copies that may go: held in IndexedDB, referenced by a
    // room whose text isn't on this device, not referenced by anything that
    // IS here, not waiting to upload, and (when `server` is given) present on
    // the server. Unreferenced orphans are left to the core's GC.
    function imageCandidates(items, protect, serverOnly, pending, server) {
      var owners = {};
      Object.keys(serverOnly || {}).forEach(function (room) {
        var r = serverOnly[room];
        ['i', 'f'].forEach(function (k) {
          Object.keys(r[k] || {}).forEach(function (h) { (owners[k + h] = owners[k + h] || []).push(room); });
        });
      });
      var out = [];
      (items || []).forEach(function (it) {
        var k = it.kind === 'img' ? 'i' : it.kind === 'file' ? 'f' : null;
        if (!k || !it.hash) return;
        var rooms = owners[k + it.hash];
        if (!rooms) return;
        if (protect && protect[k] && protect[k][it.hash]) return;
        if (pending && pending[k] && pending[k][it.hash]) return;
        if (server && !(server[k] && server[k][it.hash])) return;
        out.push({ key: it.key, kind: it.kind, hash: it.hash, bytes: it.bytes, rooms: rooms, name: it.name || '' });
      });
      return out;
    }

    // A file payload's head: {"v":1,"name":"…","size":N,…} — read the name
    // without parsing a multi-MB JSON string.
    function fileMeta(head) {
      var out = { name: '', size: 0 };
      var m = /"name"\s*:\s*"((?:[^"\\]|\\.){0,240})"/.exec(head || '');
      if (m) { try { out.name = JSON.parse('"' + m[1] + '"'); } catch (e) { out.name = m[1]; } }
      var s = /"size"\s*:\s*(\d{1,15})/.exec(head || '');
      if (s) out.size = +s[1];
      return out;
    }
    function valueSize(v) {
      if (v == null) return 0;
      if (typeof v === 'string') return v.length;
      if (typeof v.size === 'number' && typeof v.slice === 'function') return v.size;   // Blob
      if (typeof v.byteLength === 'number') return v.byteLength;                       // ArrayBuffer / view
      try { return JSON.stringify(v).length; } catch (e) { return 0; }
    }
    // Big DATA files modules fetched from a CDN (word lists, datasets) that
    // the service worker keeps in its bucket: re-downloadable, so clearable.
    // Code (js/wasm/css/fonts) and the core's own precached assets are not.
    var DATA_HOSTS = /(^|\.)(jsdelivr\.net|unpkg\.com|huggingface\.co|githubusercontent\.com|cdnjs\.cloudflare\.com)$/;
    var CORE_ASSETS = /\/typo-js@|\/firebasejs\/|\/mp4box@|\/jszip\//;
    var CODE_EXT = /\.(m?js|cjs|wasm|css|woff2?|ttf|otf|map)$/i;
    var DATA_NAMES = [[/\/word-list@[^\/]+\/words\.txt$/, 'Anagram word list']];
    function moduleData(url, bytes) {
      if (!(bytes >= 262144)) return null;
      var m = /^https?:\/\/([^\/?#]+)(\/[^?#]*)?/.exec(url);
      if (!m || !DATA_HOSTS.test(m[1])) return null;
      var path = m[2] || '/';
      if (CORE_ASSETS.test(path) || CODE_EXT.test(path)) return null;
      for (var i = 0; i < DATA_NAMES.length; i++) if (DATA_NAMES[i][0].test(path)) return { label: DATA_NAMES[i][1] };
      var parts = path.split('/').filter(Boolean);
      return { label: parts.length ? decodeURIComponentSafe(parts[parts.length - 1]) : m[1] };
    }

    function relDays(ms, now) {
      if (!ms) return '';
      var d = Math.floor(((now || Date.now()) - ms) / 86400000);
      if (d <= 0) return 'today';
      if (d === 1) return 'yesterday';
      if (d < 60) return d + 'd ago';
      if (d < 730) return Math.round(d / 30) + 'mo ago';
      return Math.round(d / 365) + 'y ago';
    }

    return {
      IDB_FB: IDB_FB, HD_BUCKET: HD_BUCKET, fmt: fmt, classifyKey: classifyKey, bucketKind: bucketKind, appBuckets: appBuckets,
      knownSize: knownSize, voiceId: voiceId, voiceLabel: voiceLabel, shortUrl: shortUrl, hashesIn: hashesIn, refsIndex: refsIndex,
      snapItems: snapItems, snapPlan: snapPlan, pruneSnaps: pruneSnaps, imageCandidates: imageCandidates,
      fileMeta: fileMeta, valueSize: valueSize, relDays: relDays, moduleData: moduleData,
    };
  })();

  if (typeof window === 'undefined') {           // node: expose the helpers to storage.test.js
    if (typeof module === 'object' && module && module.exports) module.exports = Logic;
    return;
  }
  if (typeof window.Cade === 'undefined') return;

  // =========================================================================
  // Panel
  // =========================================================================
  var Cade = window.Cade;
  Cade.loadCSS('storage.css');

  var PANEL_ID = 'storage-insights-panel';
  var PREFS_KEY = 'cade-storage-insights-prefs';
  var LS_CAP = 5 * 1024 * 1024;                 // the ~5 MB localStorage bucket (same figure the core uses)
  var SNAP_DAYS = [7, 30, 90, 180, 365];
  var SLICE_MS = 12;
  var ABORT = { abort: true };
  var CATS = [
    { id: 'docs', label: 'Documents', note: 'room text kept for offline use' },
    { id: 'snaps', label: 'Snapshots', note: 'version history \u2014 this device only' },
    { id: 'files', label: 'Images & files', note: 'attachments and drawings' },
    { id: 'app', label: 'Offline app', note: 'app code, fonts, libraries' },
    { id: 'hd', label: 'HD voices', note: 'Read Aloud neural voices' },
    { id: 'cache', label: 'Other caches', note: 'module data, other apps on this site' },
    { id: 'settings', label: 'Settings & app data', note: 'preferences, workspaces, module state' },
  ];
  // Module data that is a pure cache (re-fetched on demand). Keyed by the
  // idbStore key prefix the module uses.
  var MODULE_CACHES = [
    { prefix: 'dict:', label: 'Dictionary lookups', note: 'words looked up in the Dictionary widget \u2014 fetched again when needed' },
  ];

  var prefs = { snapDays: 30, allRooms: false, details: false };
  var panelEl = null, lastYield = 0, renderTimer = 0, GEN = 0;   // GEN never resets, so a scan from a closed panel can't revive
  var S = fresh();

  function fresh() {
    return {
      gen: 0, busy: false, step: '', est: null, persisted: null, persistApi: false,
      ls: null, rooms: null, snaps: null, idb: null, caches: null, dbs: undefined,
      refs: null, server: null, serverErr: '', html: '', confirm: null, working: '',
    };
  }

  // ---- utils -------------------------------------------------------------------
  var fmt = Logic.fmt;
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(msg, type, ms) { try { Cade.showToast(msg, type || 'info', ms || 2200); } catch (e) {} }
  function now() { return Date.now(); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function alive(gen) { return !!panelEl && gen === S.gen; }
  // Yield to the browser every ~12 ms of work; abort when the panel closed or
  // a newer scan started.
  function slice(gen) {
    if (!alive(gen)) return Promise.reject(ABORT);
    if (now() - lastYield < SLICE_MS) return Promise.resolve();
    return tick().then(function () { lastYield = now(); if (!alive(gen)) throw ABORT; });
  }
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (SNAP_DAYS.indexOf(+p.snapDays) !== -1) prefs.snapDays = +p.snapDays;
      prefs.allRooms = !!p.allRooms;
      prefs.details = !!p.details;
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function rooms() { return Cade.roomsApi || null; }
  function setting(k) { try { return Cade.Settings ? Cade.Settings.get(k) : undefined; } catch (e) { return undefined; } }
  function syncConfigured() { return !!(Cade.store.get('cade-firebase-url') && Cade.store.get('cade-sync-key')); }
  function pendingSet() {
    var out = { i: {}, f: {} };
    [['cade-img-pending', 'i'], ['cade-file-pending', 'f']].forEach(function (p) {
      try { (JSON.parse(Cade.store.get(p[0]) || '[]') || []).forEach(function (h) { out[p[1]][String(h)] = true; }); } catch (e) {}
    });
    return out;
  }
  function soon() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = 0; render(); }, 220);
  }

  // =========================================================================
  // Measuring
  // =========================================================================
  function scan() {
    var gen = S.gen = ++GEN;
    lastYield = now();
    S.busy = true; S.est = null; S.ls = null; S.rooms = null; S.snaps = null; S.idb = null; S.caches = null;
    S.dbs = undefined; S.refs = null; S.server = null; S.serverErr = '';
    render();
    var steps = [
      ['Checking quota\u2026', scanEstimate], ['Measuring documents\u2026', scanLocal], ['Reading snapshots\u2026', scanSnaps],
      ['Measuring images & files\u2026', scanIdb], ['Measuring offline caches\u2026', scanCaches], ['', scanDbs],
    ];
    var i = 0;
    function next() {
      if (!alive(gen)) return Promise.resolve();
      if (i >= steps.length) { S.busy = false; S.step = ''; render(); return Promise.resolve(); }
      var st = steps[i++];
      S.step = st[0];
      soon();
      return Promise.resolve().then(function () { return st[1](gen); }).then(function () { soon(); return next(); }, function (e) {
        if (e === ABORT) return;
        try { console.warn('[storage] ' + st[0], e); } catch (x) {}
        soon();
        return next();
      });
    }
    return next();
  }

  function scanEstimate() {
    var ns = navigator.storage, jobs = [];
    S.persistApi = !!(ns && ns.persist);
    if (ns && ns.estimate) jobs.push(ns.estimate().then(function (e) { S.est = e || null; }, function () {}));
    if (ns && ns.persisted) jobs.push(ns.persisted().then(function (p) { S.persisted = !!p; }, function () {}));
    return Promise.all(jobs);
  }

  // localStorage: every logical key sized chunk-aware by the core store.
  function scanLocal(gen) {
    var st = Cade.store, keys = [];
    try { keys = st.keys(); } catch (e) {}
    var ls = { ok: st.ok !== false, total: 0, debris: 0, cats: { docs: 0, snaps: 0, files: 0, settings: 0 }, top: [], fbKeys: {}, snapKeys: [] };
    var byRoom = {}, k = 0;
    function room(name) {
      return byRoom[name] || (byRoom[name] = { name: name, text: 0, base: 0, ver: 0, snap: 0, other: 0, snapCount: 0, refsKey: false });
    }
    function loop() {
      return slice(gen).then(function () {
        var end = Math.min(keys.length, k + 120);
        for (; k < end; k++) {
          var key = keys[k], b = 0;
          try { b = st.sizeOf(key); } catch (e) {}
          var c = Logic.classifyKey(key);
          if (c.fb != null) ls.fbKeys[c.fb] = true;
          if (c.room && c.part === 'other' && key.indexOf('cade-room-refs:') === 0) room(c.room).refsKey = true;
          if (c.room && c.part === 'snap' && b) ls.snapKeys.push(key);
          if (!b) continue;                                   // memory-only: none of the quota
          ls.cats[c.cat] += b;
          if (c.room) room(c.room)[c.part] += b;
          else if (c.cat === 'settings') ls.top.push({ key: key, bytes: b });
        }
        if (k < keys.length) return loop();
      });
    }
    return loop().then(function () {
      try { ls.total = typeof st.rawBytes === 'function' ? st.rawBytes() : 0; } catch (e) {}
      if (!ls.total) ls.total = ls.cats.docs + ls.cats.snaps + ls.cats.files + ls.cats.settings;
      try { ls.debris = typeof st.sweepOrphanChunks === 'function' ? st.sweepOrphanChunks(true) : 0; } catch (e) {}
      ls.top.sort(function (a, b) { return b.bytes - a.bytes; });
      ls.top = ls.top.slice(0, 8);
      S.ls = ls;
      buildRooms(byRoom);
    });
  }

  function buildRooms(byRoom) {
    var api = rooms(), list = [], current = '', lastOpen = {};
    try { list = api ? api.list() : []; } catch (e) {}
    try { current = (api && api.activeRoom()) || ''; } catch (e) {}
    try { lastOpen = JSON.parse(Cade.store.get('cade-room-lastopen') || '{}') || {}; } catch (e) {}
    var all = !!setting('storage.syncOnlyAll'), names = {}, out = [];
    list.forEach(function (n) { names[n] = true; });
    Object.keys(byRoom).forEach(function (n) { names[n] = true; });
    if (current) names[current] = true;
    Object.keys(names).forEach(function (n) {
      var r = byRoom[n] || { name: n, text: 0, base: 0, ver: 0, snap: 0, other: 0, refsKey: false };
      var meta = {};
      try { meta = (api && api.meta(n)) || {}; } catch (e) {}
      r.inList = list.indexOf(n) !== -1 || n === '__local__';
      r.current = n === current;
      r.syncOnly = n !== '__local__' && (all || !!meta.nocache);
      r.archived = !!meta.archived;
      r.local = (r.text + r.base) > 0;
      r.offloaded = n !== '__local__' && !r.local && !r.current;
      try { r.modified = api ? api.modifiedAt(n) : 0; } catch (e) { r.modified = 0; }
      r.opened = +lastOpen[n] || 0;
      r.img = { n: 0, bytes: 0 };
      r.total = r.text + r.base + r.ver + r.snap;
      out.push(r);
    });
    S.rooms = out;
  }

  // Snapshot stores: per-snapshot timestamps + serialized lengths (for exact
  // per-age plans) and the image refs they hold (those must stay).
  function scanSnaps(gen) {
    var keys = (S.ls && S.ls.snapKeys) || [], k = 0, out = [];
    var protect = { i: {}, f: {} };
    function loop() {
      return slice(gen).then(function () {
        if (k >= keys.length) return;
        var key = keys[k++], v = null, arr = null;
        try { v = Cade.store.get(key); arr = JSON.parse(v || '[]'); } catch (e) {}
        if (v && Array.isArray(arr) && arr.length) {
          out.push({ key: key, room: key.slice('cade-snap:'.length), valueLen: v.length, items: Logic.snapItems(arr) });
          arr.forEach(function (s) { if (s && s.c) Logic.hashesIn(s.c, protect); });
          var r = roomByName(key.slice('cade-snap:'.length));
          if (r) r.snapCount = arr.length;
        }
        return loop();
      });
    }
    return loop().then(function () {
      S.snaps = { stores: out };
      return collectRefs(gen, protect);
    });
  }
  function roomByName(n) {
    if (!S.rooms) return null;
    for (var i = 0; i < S.rooms.length; i++) if (S.rooms[i].name === n) return S.rooms[i];
    return null;
  }

  // Which image/file hashes are in use by text kept on this device (live doc,
  // room caches, sync bases, snapshots — `protect`), and which belong only to
  // rooms whose text lives on the server (their cade-room-refs index).
  function collectRefs(gen, protect) {
    var st = Cade.store, rs = S.rooms || [], k = 0, serverOnly = {}, perRoom = {}, current = '';
    try { Logic.hashesIn(Cade.editor.state.doc.toString(), protect); } catch (e) {}
    try { current = (rooms() && rooms().activeRoom()) || ''; } catch (e) {}
    function loop() {
      return slice(gen).then(function () {
        if (k >= rs.length) return;
        var r = rs[k++], own = { i: {}, f: {} }, local = false;
        // Re-checked now, not taken from the scan: a room opened since then
        // has its text back on this device and must protect its images.
        try { local = (st.sizeOf('cade-room-cache:' + r.name) + st.sizeOf('cade-room-synced:' + r.name)) > 0; } catch (e) { local = r.local; }
        if (local) {
          try { Logic.hashesIn(st.get('cade-room-cache:' + r.name), own); } catch (e) {}
          try { Logic.hashesIn(st.get('cade-room-synced:' + r.name), own); } catch (e) {}
          if (r.refsKey) { try { Logic.refsIndex(st.get('cade-room-refs:' + r.name), own); } catch (e) {} }
          merge(protect, own);
        } else if (r.refsKey) {
          try { Logic.refsIndex(st.get('cade-room-refs:' + r.name), own); } catch (e) {}
          if (r.name === current) merge(protect, own);
          else serverOnly[r.name] = own;
        }
        perRoom[r.name] = own;
        return loop();
      });
    }
    return loop().then(function () { S.refs = { protect: protect, serverOnly: serverOnly, perRoom: perRoom }; });
  }
  function merge(into, from) {
    Object.keys(from.i).forEach(function (h) { into.i[h] = true; });
    Object.keys(from.f).forEach(function (h) { into.f[h] = true; });
  }

  // IndexedDB through the core's idbStore: every value read once (one at a
  // time, between time slices) just to learn its size.
  function scanIdb(gen) {
    var store = Cade.idbStore;
    var idb = { done: false, n: 0, scanned: 0, cats: { img: 0, file: 0, draw: 0, mod: 0, other: 0 }, items: [], mods: {} };
    S.idb = idb;
    if (!store || typeof store.keys !== 'function') { idb.done = true; idb.unsupported = true; return Promise.resolve(); }
    var fb = (S.ls && S.ls.fbKeys) || {};
    return store.keys().then(function (keys) {
      keys = (keys || []).filter(function (k) { return typeof k === 'string' && !fb[k]; });   // fallback keys were counted in localStorage
      idb.n = keys.length;
      var k = 0;
      function loop() {
        return slice(gen).then(function () {
          if (k >= keys.length) return;
          var key = keys[k++];
          return store.get(key).then(function (v) {
            if (!alive(gen)) throw ABORT;
            idb.scanned++;
            var bytes = Logic.valueSize(v), kind = 'other', hash = '', name = '', mod = null;
            if (key.indexOf('img:') === 0) { kind = 'img'; hash = key.slice(4); }
            else if (key.indexOf('file:') === 0) {
              kind = 'file'; hash = key.slice(5);
              if (typeof v === 'string') name = Logic.fileMeta(v.slice(0, 600)).name;
            } else if (key.indexOf('drawstrokes:') === 0) kind = 'draw';
            else {
              for (var m = 0; m < MODULE_CACHES.length; m++) if (key.indexOf(MODULE_CACHES[m].prefix) === 0) { mod = MODULE_CACHES[m]; break; }
              if (mod) kind = 'mod';
            }
            idb.cats[kind] += bytes;
            if (mod) {
              var e = idb.mods[mod.prefix] || (idb.mods[mod.prefix] = { def: mod, n: 0, bytes: 0, keys: [] });
              e.n++; e.bytes += bytes; e.keys.push(key);
            }
            idb.items.push({ key: key, kind: kind, hash: hash, bytes: bytes, name: name });
            if (idb.scanned % 25 === 0) soon();
          }, function () { idb.scanned++; }).then(loop);
        });
      }
      return loop();
    }).then(function () {
      idb.done = true;
      attributeImages();
    });
  }
  function attributeImages() {
    if (!S.idb || !S.refs || !S.rooms) return;
    var size = { i: {}, f: {} };
    S.idb.items.forEach(function (it) { if (it.kind === 'img') size.i[it.hash] = it.bytes; else if (it.kind === 'file') size.f[it.hash] = it.bytes; });
    S.rooms.forEach(function (r) {
      var own = S.refs.perRoom[r.name], n = 0, b = 0;
      if (!own) return;
      ['i', 'f'].forEach(function (k) {
        Object.keys(own[k]).forEach(function (h) { if (size[k][h] != null) { n++; b += size[k][h]; } });
      });
      r.img = { n: n, bytes: b };
    });
  }

  // Cache Storage: sizes from Content-Length, the known-size table, or (last
  // resort) the body blob. Opaque (no-cors) entries can't be measured by a page.
  function scanCaches(gen) {
    var C = { done: false, supported: !!window.caches, buckets: [], pending: false, data: [] };
    S.caches = C;
    if (!window.caches || !caches.keys) { C.done = true; return Promise.resolve(); }
    var regP = Promise.resolve(null);
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) regP = navigator.serviceWorker.getRegistration().catch(function () { return null; });
    } catch (e) {}
    return regP.then(function (reg) {
      C.pending = !!(reg && (reg.installing || reg.waiting));
      return caches.keys();
    }).then(function (names) {
      var split = Logic.appBuckets(names, C.pending), b = 0;
      function nextBucket() {
        if (b >= names.length) return;
        var name = names[b++], kind = Logic.bucketKind(name);
        var B = { name: name, kind: kind, current: split.keep.indexOf(name) !== -1, n: 0, bytes: 0, opaque: 0, items: [], voices: {} };
        C.buckets.push(B);
        return caches.open(name).then(function (cache) {
          return cache.keys().then(function (reqs) {
            B.n = reqs.length;
            var r = 0;
            function loop() {
              return slice(gen).then(function () {
                if (r >= reqs.length) return;
                var req = reqs[r++];
                return cache.match(req).then(function (res) { return measure(req.url, res); }).then(function (m) {
                  if (!alive(gen)) throw ABORT;
                  if (m.opaque) B.opaque++;
                  B.bytes += m.bytes;
                  B.items.push({ url: req.url, bytes: m.bytes, opaque: !!m.opaque, est: !!m.est });
                  var md = kind === 'app' && B.current && !m.opaque ? Logic.moduleData(req.url, m.bytes) : null;
                  if (md) C.data.push({ bucket: name, url: req.url, bytes: m.bytes, label: md.label });
                  if (kind === 'hd') {
                    var v = Logic.voiceId(req.url);
                    if (v) {
                      var e = B.voices[v.id] || (B.voices[v.id] = { id: v.id, bytes: 0, urls: [], model: false });
                      e.bytes += m.bytes; e.urls.push(req.url); if (v.model) e.model = true;
                    }
                  }
                  if (r % 20 === 0) soon();
                }, function (e) { if (e === ABORT) throw e; }).then(loop);
              });
            }
            return loop();
          });
        }).then(nextBucket, function (e) { if (e === ABORT) throw e; return nextBucket(); });
      }
      return nextBucket();
    }).then(function () { C.done = true; });
  }
  function measure(url, res) {
    if (!res) return { bytes: 0 };
    if (res.type === 'opaque' || res.type === 'opaqueredirect') return { bytes: 0, opaque: true };
    // Content-Length is the WIRE size: for compressed responses (and CORS ones,
    // which hide Content-Encoding) the stored body is bigger, so read the
    // body's size unless it's huge or one of the known pinned assets.
    var cl = parseInt(res.headers.get('content-length'), 10), enc = res.headers.get('content-encoding');
    if (cl > 0 && res.type === 'basic' && (!enc || enc === 'identity')) return { bytes: cl };
    var known = Logic.knownSize(url);
    if (known) return { bytes: known, est: true };
    if (cl > 20 * 1048576) return { bytes: cl, est: true };
    return res.blob().then(function (b) { return { bytes: b.size }; }, function () { return { bytes: cl > 0 ? cl : 0, est: cl > 0 }; });
  }

  function scanDbs() {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') { S.dbs = null; return Promise.resolve(); }
    return indexedDB.databases().then(function (list) {
      S.dbs = (list || []).map(function (d) { return d && d.name; }).filter(Boolean);
    }, function () { S.dbs = null; });
  }

  // =========================================================================
  // Derived numbers
  // =========================================================================
  function catSizes() {
    var c = { docs: null, snaps: null, files: null, app: null, hd: null, cache: null, settings: null };
    if (S.ls) { c.docs = S.ls.cats.docs; c.snaps = S.ls.cats.snaps; c.settings = S.ls.cats.settings; }
    if (S.ls && S.idb && S.idb.done) {
      c.files = S.ls.cats.files + S.idb.cats.img + S.idb.cats.file + S.idb.cats.draw;
    }
    if (S.caches && S.caches.done) {
      c.app = 0; c.hd = 0; c.cache = 0;
      S.caches.buckets.forEach(function (B) { c[B.kind === 'app' ? 'app' : B.kind === 'hd' ? 'hd' : 'cache'] += B.bytes; });
    }
    if (S.idb && S.idb.done && c.cache != null) c.cache += S.idb.cats.mod + S.idb.cats.other;
    else if (S.idb && S.idb.done && !(S.caches && S.caches.supported)) c.cache = S.idb.cats.mod + S.idb.cats.other;
    return c;
  }

  function snapPlanAll(days) {
    if (!S.snaps) return null;
    var cutoff = now() - days * 86400000, out = { removed: 0, freed: 0, rooms: [] };
    S.snaps.stores.forEach(function (s) {
      var p = Logic.snapPlan(s.items, s.valueLen, cutoff);
      if (!p.removed) return;
      out.removed += p.removed; out.freed += p.freed; out.rooms.push(s.room);
    });
    return out;
  }

  function imagePlan() {
    if (!S.idb || !S.idb.done || !S.refs) return null;
    return Logic.imageCandidates(S.idb.items, S.refs.protect, S.refs.serverOnly, pendingSet(), null);
  }

  function modPlan() {
    if (!S.idb || !S.idb.done || !S.caches || !S.caches.done) return null;
    var idb = Object.keys(S.idb.mods).map(function (k) { return S.idb.mods[k]; }), data = S.caches.data || [], b = 0;
    idb.forEach(function (m) { b += m.bytes; });
    data.forEach(function (d) { b += d.bytes; });
    return { idb: idb, data: data, bytes: b };
  }
  function hdBucket() {
    if (!S.caches) return null;
    for (var i = 0; i < S.caches.buckets.length; i++) if (S.caches.buckets[i].kind === 'hd') return S.caches.buckets[i];
    return null;
  }
  function oldAppBuckets() {
    if (!S.caches || !S.caches.done) return null;
    return S.caches.buckets.filter(function (B) { return B.kind === 'app' && !B.current; });
  }

  // =========================================================================
  // Rendering
  // =========================================================================
  function spin(label) { return '<span class="si-spin" aria-hidden="true"></span>' + (label ? '<span class="si-wait">' + esc(label) + '</span>' : ''); }
  function sizeOrSpin(n) { return n == null ? (S.busy ? spin('') : '\u2014') : esc(fmt(n)); }
  // Still measuring → spinner; measuring finished without an answer → say so.
  function pend() { return S.busy ? spin('measuring') : 'Couldn\u2019t be measured in this browser.'; }

  function overviewHtml(cs) {
    var h = '<section class="si-card si-over">';
    var measured = 0, known = true;
    CATS.forEach(function (c) { if (cs[c.id] == null) known = false; else measured += cs[c.id]; });
    h += '<div class="si-big"><span class="si-big-n">' + (known ? esc(fmt(measured)) : (measured ? '\u2265 ' + esc(fmt(measured)) : '\u2026')) + '</span>' +
      '<span class="si-big-l">stored on this device' + (S.busy ? ' \u00b7 ' + spin(S.step) : '') + '</span></div>';
    // Browser quota (IndexedDB + caches; localStorage is separate in most browsers)
    if (S.est && S.est.quota) {
      var u = S.est.usage || 0, q = S.est.quota, pct = Math.min(100, (u / q) * 100);
      h += '<div class="si-meter"><div class="si-meter-row"><span>Browser storage</span><span class="si-num">' + esc(fmt(u)) + ' of ' + esc(fmt(q)) +
        ' (' + (pct < 1 && u ? '<1' : Math.round(pct)) + '%)</span></div>' +
        '<div class="si-bar" role="img" aria-label="' + esc(Math.round(pct) + '% of the browser quota used') + '"><span class="si-fill' + (pct > 85 ? ' si-hot' : '') + '" style="width:' + Math.max(pct, u ? 0.6 : 0).toFixed(2) + '%"></span></div></div>';
    } else if (S.est === null && !S.busy) {
      h += '<div class="si-note">This browser doesn\u2019t report its storage quota.</div>';
    }
    if (S.ls) {
      var lp = Math.min(100, (S.ls.total / LS_CAP) * 100);
      h += '<div class="si-meter"><div class="si-meter-row"><span>Documents bucket <span class="si-faint">(localStorage)</span></span><span class="si-num">' +
        esc(fmt(S.ls.total)) + ' of ~5 MB (' + Math.round(lp) + '%)</span></div>' +
        '<div class="si-bar" role="img" aria-label="' + esc(Math.round(lp) + '% of the documents bucket used') + '"><span class="si-fill si-fill-ls' + (lp > 80 ? ' si-hot' : '') + '" style="width:' + lp.toFixed(2) + '%"></span></div>' +
        '<div class="si-note">Documents, snapshots and settings share this small, separate bucket \u2014 it\u2019s the one that fills up. ' +
        (S.ls.ok ? '' : '<b>localStorage is unavailable \u2014 changes are kept in memory only.</b>') + '</div></div>';
    }
    // Persistence
    if (S.persisted != null || S.persistApi) {
      h += '<div class="si-persist">' + (S.persisted
        ? '<span class="si-pill si-ok" title="The browser won\u2019t clear this app\u2019s data to make room for other sites">\u2714 Persistent storage</span>'
        : '<span class="si-pill" title="Under storage pressure the browser may clear this site\u2019s data (unsynced work could be lost)">Best-effort storage</span>' +
          (S.persistApi ? '<button type="button" class="si-btn si-sm" data-act="persist">Make persistent</button>' : '')) + '</div>';
    }
    return h + '</section>';
  }

  function breakdownHtml(cs) {
    var total = 0;
    CATS.forEach(function (c) { if (cs[c.id]) total += cs[c.id]; });
    var bar = '';
    if (total > 0) {
      CATS.forEach(function (c) {
        var v = cs[c.id];
        if (!v) return;
        var pct = (v / total) * 100;
        if (pct < 0.4) pct = 0.4;
        bar += '<span class="si-seg si-c-' + c.id + '" style="width:' + pct.toFixed(2) + '%" title="' + esc(c.label + ': ' + fmt(v)) + '"></span>';
      });
    }
    var h = '<section class="si-card"><h3 class="si-h">What\u2019s using space</h3>' +
      '<div class="si-stack" role="img" aria-label="Storage by category">' + bar + '</div><div class="si-legend">';
    CATS.forEach(function (c) {
      var v = cs[c.id], extra = '';
      if (c.id === 'app' && S.caches && S.caches.done) {
        var op = 0;
        S.caches.buckets.forEach(function (B) { if (B.kind === 'app') op += B.opaque; });
        if (op) extra = ' \u00b7 +' + op + ' item' + (op === 1 ? '' : 's') + ' the browser won\u2019t size';
      }
      if (c.id === 'files' && S.idb && S.idb.done && !S.idb.unsupported) {
        var ni = 0, nf = 0;
        S.idb.items.forEach(function (it) { if (it.kind === 'img') ni++; else if (it.kind === 'file') nf++; });
        extra = ' \u00b7 ' + ni + ' image' + (ni === 1 ? '' : 's') + ', ' + nf + ' file' + (nf === 1 ? '' : 's');
      }
      if (c.id === 'files' && S.idb && !S.idb.done && S.idb.n) extra = ' \u00b7 ' + S.idb.scanned + '/' + S.idb.n + ' read';
      h += '<div class="si-leg"><span class="si-dot si-c-' + c.id + '" aria-hidden="true"></span>' +
        '<span class="si-leg-l"><span class="si-leg-name">' + esc(c.label) + '</span><span class="si-leg-note">' + esc(c.note + extra) + '</span></span>' +
        '<span class="si-leg-v">' + sizeOrSpin(v) + '</span></div>';
    });
    h += '</div>';
    if (S.est && S.est.usage && !S.busy && cs.app != null) {
      var browserSide = (cs.files || 0) - ((S.ls && S.ls.cats.files) || 0) + (cs.app || 0) + (cs.hd || 0) + (cs.cache || 0);
      var gap = S.est.usage - browserSide;
      if (gap > 5 * 1048576) {
        h += '<div class="si-note">The browser reports ' + esc(fmt(gap)) + ' more than the items measured here \u2014 database overhead and ' +
          'cross-site library responses whose size the browser hides (Chrome counts each one as several MB).</div>';
      }
    }
    return h + '</section>';
  }

  // ---- clean-up actions ------------------------------------------------------
  function actRow(id, title, desc, btn, opts) {
    opts = opts || {};
    return '<div class="si-act' + (opts.muted ? ' si-act-muted' : '') + '" data-row="' + id + '"><div class="si-act-main">' +
      '<div class="si-act-title">' + title + '</div><div class="si-act-desc">' + desc + '</div></div>' +
      (btn ? '<div class="si-act-side">' + btn + '</div>' : '') + '</div>';
  }
  function runBtn(act, label, enabled, danger, extra) {
    return '<button type="button" class="si-btn' + (danger ? ' si-danger' : '') + '" data-act="' + act + '"' + (enabled ? '' : ' disabled') + (extra || '') + '>' + label + '</button>';
  }

  function actionsHtml() {
    var h = '<section class="si-card"><h3 class="si-h">Free up space</h3>', ro = S.working;
    // 0) stranded chunk fragments (pure debris)
    if (S.ls && S.ls.debris > 0) {
      h += actRow('debris', 'Stranded fragments', 'Pieces of half-written saves that nothing can read any more. Safe to remove.',
        runBtn('debris', 'Free ' + esc(fmt(S.ls.debris)), !ro, false));
    }
    // 1) old snapshots
    var plan = snapPlanAll(prefs.snapDays);
    var sel = '<select class="si-sel" data-pref="snapDays" aria-label="Snapshot age">' + SNAP_DAYS.map(function (d) {
      return '<option value="' + d + '"' + (d === prefs.snapDays ? ' selected' : '') + '>' + (d < 365 ? d + ' days' : '1 year') + '</option>';
    }).join('') + '</select>';
    var auto = String(setting('snapshots.maxAgeDays') || '0');
    var autoSel = '<select class="si-sel" data-setting="snapshots.maxAgeDays" aria-label="Auto-delete old snapshots">' +
      [['0', 'keep all'], ['1', 'after 1 day'], ['7', 'after 7 days'], ['30', 'after 30 days']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === auto ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
    var sdesc = 'Older than ' + sel + ' \u00b7 ' + (plan == null ? pend() : plan.removed
      ? plan.removed + ' snapshot' + (plan.removed === 1 ? '' : 's') + ' in ' + plan.rooms.length + ' room' + (plan.rooms.length === 1 ? '' : 's')
      : 'none that old') + '. The newest snapshot of every room is always kept.' +
      '<div class="si-sub">Auto-delete on this device: ' + autoSel + '</div>';
    h += actRow('snaps', 'Old snapshots', sdesc, runBtn('snaps', plan && plan.removed ? 'Free ' + esc(fmt(plan.freed)) : 'Nothing to free', !!(plan && plan.removed) && !ro, true));

    // 2) images & files of rooms not stored here
    var ip = imagePlan(), synced = syncConfigured();
    if (!synced) {
      h += actRow('imgs', 'Images of offloaded rooms', 'Needs sync: without a server copy, the image on this device is the only one \u2014 so nothing is offered.', '', { muted: true });
    } else {
      var ib = 0;
      (ip || []).forEach(function (c) { ib += c.bytes; });
      var idesc = ip == null ? pend()
        : ip.length ? ip.length + ' image' + (ip.length === 1 ? '' : 's') + '/file' + (ip.length === 1 ? '' : 's') + ' used only by rooms whose text isn\u2019t kept here (' +
          esc(uniqRooms(ip).slice(0, 3).join(', ')) + (uniqRooms(ip).length > 3 ? '\u2026' : '') + '). Each is checked against the server first; they download again when those rooms are opened online.'
        : 'Nothing to free \u2014 every local image is used by a document kept here, or still uploading.';
      if (S.serverErr) idesc += '<div class="si-sub si-warn">' + esc(S.serverErr) + '</div>';
      h += actRow('imgs', 'Images of offloaded rooms', idesc, runBtn('imgs', ip && ip.length ? 'Check &amp; free ~' + esc(fmt(ib)) : 'Nothing to free', !!(ip && ip.length) && !ro, true));
    }

    // 3) old offline-app versions
    var old = oldAppBuckets();
    if (S.caches && !S.caches.supported) {
      h += actRow('app', 'Old app versions', 'This browser has no Cache Storage.', '', { muted: true });
    } else {
      var ob = 0;
      (old || []).forEach(function (B) { ob += B.bytes; });
      var adesc = old == null ? pend()
        : S.caches.pending ? 'An app update is installing right now \u2014 try again in a moment.'
        : old.length ? old.length + ' outdated cache' + (old.length === 1 ? '' : 's') + ' (' + esc(old.map(function (B) { return B.name; }).join(', ')) + '). The current version stays, so offline use is unaffected.'
        : 'Only the current version is cached.';
      h += actRow('app', 'Old app versions', adesc, runBtn('app', old && old.length ? 'Free ' + esc(fmt(ob)) : 'Nothing to free', !!(old && old.length) && !ro, false));
    }

    // 4) HD voices
    var hd = hdBucket();
    if (S.caches && S.caches.done) {
      if (hd && hd.n) {
        var vs = Object.keys(hd.voices).map(function (k) { return hd.voices[k]; }).filter(function (v) { return v.model; });
        var vl = vs.map(function (v) {
          return '<div class="si-voice"><span class="si-voice-n">' + esc(Logic.voiceLabel(v.id)) + '</span><span class="si-num">' + esc(fmt(v.bytes)) + '</span>' +
            (vs.length > 1 ? runBtn('voice', 'Remove', !ro, true, ' data-voice="' + esc(v.id) + '"') : '') + '</div>';
        }).join('');
        h += actRow('hd', 'Read Aloud HD voices', (vs.length ? vs.length + ' voice' + (vs.length === 1 ? '' : 's') + ' downloaded for offline use. ' : '') +
          'Read Aloud keeps working with the standard voice; HD can be downloaded again (~66 MB, needs internet).' + (vl ? '<div class="si-voices">' + vl + '</div>' : ''),
          runBtn('hd', 'Free ' + esc(fmt(hd.bytes)), !ro, true));
      } else {
        h += actRow('hd', 'Read Aloud HD voices', 'No HD voice downloaded.', '', { muted: true });
      }
    }

    // 5) module data caches (IndexedDB lookups + big CDN data files)
    var md = modPlan();
    if (md) {
      var mlines = md.idb.map(function (m) { return esc(m.def.label) + ' \u2014 ' + m.n + ' item' + (m.n === 1 ? '' : 's') + ', ' + esc(fmt(m.bytes)); })
        .concat(md.data.map(function (d) { return esc(d.label) + ' \u2014 ' + esc(fmt(d.bytes)); }));
      h += actRow('mods', 'Module data caches', mlines.length
        ? mlines.join('<br>') + '<div class="si-sub">Downloaded or looked up on demand \u2014 fetched again the next time a feature needs it (needs internet then).</div>'
        : 'No cached module data.', mlines.length ? runBtn('mods', 'Free ' + esc(fmt(md.bytes)), !ro, false) : '', { muted: !mlines.length });
    }

    // 6) handovers to the core's own flows
    h += '<div class="si-core">' +
      '<button type="button" class="si-btn" data-act="manage" title="The core\u2019s per-room cleanup: clear offline copies of rooms (they reload from the server)">Manage Storage\u2026</button>' +
      '<button type="button" class="si-btn" data-act="files" title="Every file attachment: download, delete, purge unreferenced">Attached Files\u2026</button>' +
      '</div>';
    return h + '</section>';
  }
  function uniqRooms(cands) {
    var seen = {}, out = [];
    cands.forEach(function (c) { c.rooms.forEach(function (r) { if (!seen[r]) { seen[r] = 1; out.push(r); } }); });
    return out;
  }

  // ---- rooms ---------------------------------------------------------------------
  function roomsHtml() {
    var h = '<section class="si-card"><h3 class="si-h">Largest rooms</h3>';
    if (!S.rooms) return h + '<div class="si-note">' + pend() + '</div></section>';
    var list = S.rooms.slice().sort(function (a, b) { return (b.total + b.img.bytes) - (a.total + a.img.bytes) || (b.modified || 0) - (a.modified || 0); });
    if (!list.length) return h + '<div class="si-note">No rooms on this device.</div></section>';
    var shown = prefs.allRooms ? list : list.slice(0, 8), t = now();
    h += '<div class="si-rows">';
    shown.forEach(function (r) {
      var badges = '';
      if (r.current) badges += '<span class="si-tag si-tag-cur">open</span>';
      if (r.syncOnly) badges += '<span class="si-tag">sync-only</span>';
      else if (r.offloaded && r.inList) badges += '<span class="si-tag" title="Its text is on the server, not on this device \u2014 it downloads when opened">server only</span>';
      if (!r.inList) badges += '<span class="si-tag si-tag-warn" title="Not in the tab list \u2014 leftover data (Manage Storage can clear it)">orphaned</span>';
      if (r.archived) badges += '<span class="si-tag">archived</span>';
      var parts = [];
      if (r.text + r.base + r.ver) parts.push('text ' + fmt(r.text + r.base + r.ver));
      if (r.snap) parts.push((r.snapCount ? r.snapCount + ' snapshot' + (r.snapCount === 1 ? '' : 's') : 'snapshots') + ' ' + fmt(r.snap));
      if (r.img.n) parts.push(r.img.n + ' image' + (r.img.n === 1 ? '' : 's') + '/file' + (r.img.n === 1 ? '' : 's') + ' ' + fmt(r.img.bytes));
      if (r.modified) parts.push('edited ' + Logic.relDays(r.modified, t));
      if (r.opened) parts.push('opened here ' + Logic.relDays(r.opened, t));
      var label = r.name === '__local__' ? '(no room)' : r.name;
      h += '<div class="si-row"><div class="si-row-main"><div class="si-row-name"><span class="si-ell" title="' + esc(label) + '">' + esc(label) + '</span>' + badges + '</div>' +
        '<div class="si-row-meta">' + esc(parts.join(' \u00b7 ') || 'nothing stored here') + '</div></div>' +
        '<span class="si-row-v">' + esc(fmt(r.total + r.img.bytes)) + '</span>' +
        (r.inList && !r.current && r.name !== '__local__' && rooms() ? '<button type="button" class="si-icon" data-act="open-room" data-room="' + esc(r.name) + '" title="Open this room" aria-label="Open ' + esc(label) + '">\u2197</button>' : '') +
        '</div>';
    });
    h += '</div>';
    if (list.length > 8) h += '<button type="button" class="si-link" data-act="all-rooms">' + (prefs.allRooms ? 'Show top 8' : 'Show all ' + list.length + ' rooms') + '</button>';
    if (S.idb && !S.idb.done) h += '<div class="si-note">' + spin('adding image sizes') + '</div>';
    return h + '</section>';
  }

  // ---- largest stored items ---------------------------------------------------------
  function itemsHtml() {
    var h = '<section class="si-card"><h3 class="si-h">Largest stored items</h3>', items = [];
    var owner = {};
    if (S.refs) {
      Object.keys(S.refs.perRoom).forEach(function (room) {
        var own = S.refs.perRoom[room];
        Object.keys(own.i).forEach(function (x) { if (!owner['i' + x]) owner['i' + x] = room; });
        Object.keys(own.f).forEach(function (x) { if (!owner['f' + x]) owner['f' + x] = room; });
      });
    }
    if (S.idb) {
      S.idb.items.forEach(function (it) {
        if (!it.bytes) return;
        var label, where;
        if (it.kind === 'img') { label = 'Image ' + it.hash.slice(0, 8); where = owner['i' + it.hash] ? 'in ' + owner['i' + it.hash] : 'not used by a room on this device'; }
        else if (it.kind === 'file') { label = it.name || 'File ' + it.hash.slice(0, 8); where = owner['f' + it.hash] ? 'in ' + owner['f' + it.hash] : 'not used by a room on this device'; }
        else if (it.kind === 'draw') { label = 'Drawing strokes'; where = 'editable whiteboard data'; }
        else { label = it.key.length > 40 ? it.key.slice(0, 38) + '\u2026' : it.key; where = it.kind === 'mod' ? 'module cache' : 'app database'; }
        items.push({ label: label, where: where, bytes: it.bytes, src: 'IndexedDB' });
      });
    }
    if (S.caches) {
      S.caches.buckets.forEach(function (B) {
        B.items.forEach(function (it) {
          if (!it.bytes) return;
          var u = Logic.shortUrl(it.url);
          items.push({ label: typeof u === 'string' ? u : u.name, where: (typeof u === 'string' ? '' : u.host + ' \u00b7 ') + bucketLabel(B), bytes: it.bytes, src: 'cache', est: it.est, title: it.url });
        });
      });
    }
    if (S.ls) S.ls.top.forEach(function (o) { items.push({ label: o.key, where: 'setting / app data', bytes: o.bytes, src: 'localStorage' }); });
    items.sort(function (a, b) { return b.bytes - a.bytes; });
    items = items.slice(0, 10);
    if (!items.length) return h + '<div class="si-note">' + (S.busy ? spin('measuring') : 'Nothing large stored.') + '</div></section>';
    h += '<div class="si-rows">' + items.map(function (it) {
      return '<div class="si-row"><div class="si-row-main"><div class="si-row-name"><span class="si-ell" title="' + esc(it.title || it.label) + '">' + esc(it.label) + '</span></div>' +
        '<div class="si-row-meta">' + esc(it.where) + '</div></div><span class="si-row-v">' + (it.est ? '~' : '') + esc(fmt(it.bytes)) + '</span></div>';
    }).join('') + '</div>';
    if (S.busy) h += '<div class="si-note">' + spin('still measuring') + '</div>';
    return h + '</section>';
  }
  function bucketLabel(B) {
    if (B.kind === 'app') return B.current ? 'offline app' : 'old app version';
    if (B.kind === 'hd') return 'HD voices';
    return B.name;
  }

  function detailsHtml() {
    var open = prefs.details;
    var h = '<section class="si-card"><button type="button" class="si-h si-h-btn" data-act="details" aria-expanded="' + open + '">' + (open ? '\u25be' : '\u25b8') + ' Details</button>';
    if (!open) return h + '</section>';
    var rows = [];
    if (S.est && S.est.usageDetails) {
      Object.keys(S.est.usageDetails).forEach(function (k) { rows.push(['Browser: ' + k, fmt(S.est.usageDetails[k])]); });
    }
    if (S.caches && S.caches.done) {
      S.caches.buckets.forEach(function (B) {
        rows.push(['Cache \u201c' + B.name + '\u201d', B.n + ' item' + (B.n === 1 ? '' : 's') + ' \u00b7 ' + fmt(B.bytes) + (B.opaque ? ' + ' + B.opaque + ' unsized' : '')]);
      });
    }
    if (S.idb && S.idb.done) rows.push(['IndexedDB (app store)', S.idb.items.length + ' entr' + (S.idb.items.length === 1 ? 'y' : 'ies')]);
    if (S.dbs) rows.push(['IndexedDB databases', S.dbs.length ? S.dbs.join(', ') : 'none']);
    else if (S.dbs === null) rows.push(['IndexedDB databases', 'not listed by this browser']);
    if (S.ls) {
      rows.push(['localStorage', fmt(S.ls.total) + ' \u00b7 settings & app data ' + fmt(S.ls.cats.settings)]);
      S.ls.top.forEach(function (o) { if (o.bytes >= 4096) rows.push(['\u2003' + o.key, fmt(o.bytes)]); });
    }
    h += '<div class="si-kv">' + rows.map(function (r) { return '<div class="si-kv-r"><span class="si-ell" title="' + esc(r[0]) + '">' + esc(r[0]) + '</span><span class="si-num">' + esc(r[1]) + '</span></div>'; }).join('') + '</div>';
    return h + '</section>';
  }

  function render() {
    if (!panelEl) return;
    clearTimeout(renderTimer); renderTimer = 0;
    var cs = catSizes();
    var html = overviewHtml(cs) + actionsHtml() + breakdownHtml(cs) + roomsHtml() + itemsHtml() + detailsHtml();
    var main = panelEl.querySelector('.si-main');
    var btn = panelEl.querySelector('.si-rescan');
    if (btn) { btn.disabled = S.busy || !!S.working; btn.textContent = S.busy ? 'Measuring\u2026' : '\u21bb Rescan'; }
    if (html === S.html) return;
    var top = main.scrollTop, ae = document.activeElement, focusKey = null;
    if (ae && main.contains(ae)) focusKey = ae.getAttribute('data-act') || ae.getAttribute('data-pref') || ae.getAttribute('data-setting');
    main.innerHTML = html;
    S.html = html;
    main.scrollTop = top;
    if (focusKey) {
      var el = main.querySelector('[data-act="' + focusKey + '"], [data-pref="' + focusKey + '"], [data-setting="' + focusKey + '"]');
      if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) {} }
    }
  }

  // =========================================================================
  // Confirm sheet (inside the panel; names exactly what goes)
  // =========================================================================
  function askConfirm(o) {
    closeConfirm();
    var sheet = document.createElement('div');
    sheet.className = 'si-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', o.title);
    var list = '';
    if (o.items && o.items.length) {
      list = '<ul class="si-sheet-list">' + o.items.slice(0, 8).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
        (o.items.length > 8 ? '<li class="si-faint">\u2026and ' + (o.items.length - 8) + ' more</li>' : '') + '</ul>';
    }
    sheet.innerHTML = '<div class="si-sheet-box"><div class="si-sheet-title">' + esc(o.title) + '</div>' +
      '<div class="si-sheet-body">' + o.body + '</div>' + list +
      '<div class="si-sheet-btns"><button type="button" class="si-btn" data-sheet="cancel">Cancel</button>' +
      '<button type="button" class="si-btn ' + (o.safe ? 'si-primary' : 'si-danger-solid') + '" data-sheet="ok">' + esc(o.ok) + '</button></div></div>';
    panelEl.appendChild(sheet);
    S.confirm = { el: sheet, run: o.run };
    var c = sheet.querySelector('[data-sheet="cancel"]');
    try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); }
  }
  function closeConfirm() {
    if (S.confirm) { S.confirm.el.remove(); S.confirm = null; }
  }
  function onSheet(which) {
    var C = S.confirm;
    closeConfirm();
    if (which === 'ok' && C && C.run) C.run();
  }

  // Run a cleanup, then rescan.
  function work(label, fn) {
    if (S.working) return;
    S.working = label;
    S.html = ''; render();
    Promise.resolve().then(fn).then(function (msg) {
      S.working = '';
      if (msg) toast(msg, 'success', 3200);
      if (panelEl) scan();
    }, function (e) {
      S.working = '';
      toast((e && e.message) || 'That didn\u2019t work', 'error', 3200);
      if (panelEl) { S.html = ''; render(); }
    });
  }

  // =========================================================================
  // Actions
  // =========================================================================
  function actDebris() {
    var n = S.ls ? S.ls.debris : 0;
    askConfirm({
      title: 'Remove stranded fragments?', ok: 'Free ' + fmt(n), safe: true,
      body: 'These are leftover pieces of saves that were interrupted (usually when storage was full). No document, snapshot or setting reads them.',
      run: function () {
        work('debris', function () {
          var freed = Cade.store.sweepOrphanChunks();
          return 'Freed ' + fmt(freed);
        });
      },
    });
  }

  function actSnaps() {
    var days = prefs.snapDays, plan = snapPlanAll(days);
    if (!plan || !plan.removed) return;
    askConfirm({
      title: 'Delete ' + plan.removed + ' old snapshot' + (plan.removed === 1 ? '' : 's') + '?',
      ok: 'Delete & free ' + fmt(plan.freed),
      body: 'Snapshots older than <b>' + (days < 365 ? days + ' days' : '1 year') + '</b> will be permanently deleted from these rooms. ' +
        'Snapshots exist only on this device \u2014 <b>this can\u2019t be undone</b>. The newest snapshot of each room is kept, and your documents themselves are not touched.',
      items: plan.rooms.map(function (r) { return r === '__local__' ? '(no room)' : r; }),
      run: function () {
        work('snaps', function () {
          var cutoff = now() - days * 86400000, removed = 0, freed = 0;
          S.snaps.stores.forEach(function (s) {
            var v = Cade.store.get(s.key), arr = null;
            try { arr = JSON.parse(v || '[]'); } catch (e) { return; }
            if (!Array.isArray(arr)) return;
            var kept = Logic.pruneSnaps(arr, cutoff);
            if (kept.length === arr.length) return;
            var nv = JSON.stringify(kept);
            Cade.store.set(s.key, nv);
            removed += arr.length - kept.length;
            freed += (v.length - nv.length) * 2;
          });
          return 'Deleted ' + removed + ' snapshot' + (removed === 1 ? '' : 's') + ' \u2014 ' + fmt(freed) + ' freed';
        });
      },
    });
  }

  // Server check: the shallow REST listing of images/<fp> and files/<fp> —
  // the same request the core's Attached Files manager makes.
  function keyFingerprint(key) {
    if (Cade.storage && typeof Cade.storage.keyFingerprint === 'function') return Promise.resolve(Cade.storage.keyFingerprint());
    if (!window.crypto || !crypto.subtle || typeof TextEncoder === 'undefined') return Promise.resolve(null);
    // Same derivation as the core's _computeKeyFingerprint (the Firebase path component).
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('ws-fp:' + key)).then(function (buf) {
      return Array.prototype.slice.call(new Uint8Array(buf), 0, 8).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function serverListing() {
    var url = Cade.store.get('cade-firebase-url') || '', key = Cade.store.get('cade-sync-key') || '';
    if (!url || !key) return Promise.reject(new Error('Sync isn\u2019t set up on this device.'));
    if (navigator.onLine === false) return Promise.reject(new Error('You\u2019re offline \u2014 can\u2019t confirm the server copies, so nothing was removed.'));
    return keyFingerprint(key).then(function (fp) {
      if (!fp) throw new Error('This browser can\u2019t compute the sync fingerprint.');
      var base = url.replace(/\/+$/, '');
      function get(path) {
        return fetch(base + '/' + path + '/' + fp + '.json?shallow=true', { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('The server said ' + r.status + ' \u2014 nothing was removed.');
          return r.json();
        });
      }
      return Promise.all([get('images'), get('files')]).then(function (v) {
        var out = { i: {}, f: {} };
        if (v[0] && typeof v[0] === 'object') Object.keys(v[0]).forEach(function (h) { out.i[h] = true; });
        if (v[1] && typeof v[1] === 'object') Object.keys(v[1]).forEach(function (h) { out.f[h] = true; });
        return out;
      });
    });
  }

  function actImages() {
    if (!S.idb || !S.refs) return;
    S.serverErr = '';
    S.working = 'imgs'; S.html = ''; render();
    // Re-collect what's in use right now (the scan may be minutes old) before
    // asking the server, then confirm only what it actually holds.
    var gen = S.gen, protect = { i: {}, f: {} };
    Promise.resolve().then(function () {
      Cade.store.keys().forEach(function (k) {
        if (k.indexOf('cade-snap:') !== 0) return;
        try { (JSON.parse(Cade.store.get(k) || '[]') || []).forEach(function (x) { if (x && x.c) Logic.hashesIn(x.c, protect); }); } catch (e) {}
      });
      return collectRefs(gen, protect);
    }).then(function () {
      return serverListing();
    }).then(function (server) {
      S.working = '';
      if (!panelEl) return;
      var cands = Logic.imageCandidates(S.idb.items, S.refs.protect, S.refs.serverOnly, pendingSet(), server);
      var all = imagePlan() || [];
      var skipped = all.length - cands.length;
      S.html = ''; render();
      if (!cands.length) { toast('None of them could be confirmed on the server \u2014 nothing was removed.', 'info', 3600); return; }
      var bytes = 0;
      cands.forEach(function (c) { bytes += c.bytes; });
      var rs = uniqRooms(cands);
      askConfirm({
        title: 'Remove ' + cands.length + ' local cop' + (cands.length === 1 ? 'y' : 'ies') + '?',
        ok: 'Remove & free ~' + fmt(bytes),
        body: 'These images/files are used only by rooms whose text isn\u2019t kept on this device, and the server confirmed it holds every one of them. ' +
          'Only this device\u2019s copy goes: they download again when you open those rooms <b>online</b> \u2014 offline, they won\u2019t show until then.' +
          (skipped > 0 ? ' (' + skipped + ' more stay because the server doesn\u2019t list them.)' : ''),
        items: rs,
        run: function () {
          work('imgs', function () {
            var p = pendingSet(), freed = 0, n = 0;
            return cands.reduce(function (chain, c) {
              return chain.then(function () {
                if ((c.kind === 'img' && p.i[c.hash]) || (c.kind === 'file' && p.f[c.hash])) return;
                return Cade.idbStore.remove(c.key).then(function () { freed += c.bytes; n++; });
              });
            }, Promise.resolve()).then(function () {
              return 'Removed ' + n + ' local cop' + (n === 1 ? 'y' : 'ies') + ' \u2014 ~' + fmt(freed) + ' freed (still on the server)';
            });
          });
        },
      });
    }, function (e) {
      if (e === ABORT) { S.working = ''; return; }
      S.working = '';
      S.serverErr = (e && e.message) || 'Couldn\u2019t reach the server \u2014 nothing was removed.';
      S.html = ''; render();
    });
  }

  function actApp() {
    var old = oldAppBuckets();
    if (!old || !old.length) return;
    var b = 0;
    old.forEach(function (B) { b += B.bytes; });
    askConfirm({
      title: 'Delete ' + old.length + ' old app cache' + (old.length === 1 ? '' : 's') + '?',
      ok: 'Free ' + fmt(b), safe: true,
      body: 'Leftover copies of earlier app versions. The version you\u2019re running keeps its cache, so the app still works offline. None of your documents are in these.',
      items: old.map(function (B) { return B.name + ' \u2014 ' + fmt(B.bytes); }),
      run: function () {
        work('app', function () {
          return Promise.all(old.map(function (B) { return caches['delete'](B.name); })).then(function () { return 'Deleted ' + old.length + ' old app cache' + (old.length === 1 ? '' : 's'); });
        });
      },
    });
  }

  function actHd(voice) {
    var hd = hdBucket();
    if (!hd) return;
    var v = voice ? hd.voices[voice] : null;
    var bytes = v ? v.bytes : hd.bytes;
    askConfirm({
      title: v ? 'Remove the ' + Logic.voiceLabel(v.id) + ' HD voice?' : 'Remove all HD voice data?',
      ok: 'Remove & free ' + fmt(bytes),
      body: (v ? 'This voice\u2019s model' : 'Every downloaded HD voice and the speech engine') + ' will be removed from this device. ' +
        'Read Aloud keeps working with the standard voice; to use ' + (v ? 'this voice' : 'HD') + ' again, download it from Read Aloud (~66 MB, needs internet).',
      run: function () {
        work('hd', function () {
          if (!v) return caches['delete'](Logic.HD_BUCKET).then(function () { return 'HD voice data removed'; });
          return caches.open(Logic.HD_BUCKET).then(function (c) {
            return Promise.all(v.urls.map(function (u) { return c['delete'](u); })).then(function () { return c.keys(); });
          }).then(function (left) {
            // Nothing but the runtime left → drop the whole bucket.
            var models = (left || []).filter(function (r) { var x = Logic.voiceId(r.url); return x && x.model; });
            return models.length ? null : caches['delete'](Logic.HD_BUCKET);
          }).then(function () { return Logic.voiceLabel(v.id) + ' removed'; });
        });
      },
    });
  }

  function actMods() {
    var md = modPlan();
    if (!md || !(md.idb.length || md.data.length)) return;
    askConfirm({
      title: 'Clear module data caches?', ok: 'Free ' + fmt(md.bytes), safe: true,
      body: 'Cached lookups and downloaded data files only \u2014 no documents or settings. Each is fetched again the next time its feature needs it; ' +
        '<b>offline, that feature waits until you\u2019re back online</b>.',
      items: md.idb.map(function (m) { return m.def.label + ' \u2014 ' + m.n + ' item' + (m.n === 1 ? '' : 's'); })
        .concat(md.data.map(function (d) { return d.label + ' \u2014 ' + fmt(d.bytes); })),
      run: function () {
        work('mods', function () {
          var keys = [];
          md.idb.forEach(function (m) { keys = keys.concat(m.keys); });
          return Cade.idbStore.keys().then(function (all) {
            // Index keys under the same prefix (e.g. dict:__index) go too.
            (all || []).forEach(function (k) {
              if (typeof k !== 'string' || keys.indexOf(k) !== -1) return;
              for (var i = 0; i < md.idb.length; i++) if (k.indexOf(md.idb[i].def.prefix) === 0) { keys.push(k); return; }
            });
            return keys.reduce(function (ch, k) { return ch.then(function () { return Cade.idbStore.remove(k); }); }, Promise.resolve());
          }).then(function () {
            if (!md.data.length || !window.caches) return;
            return md.data.reduce(function (ch, d) {
              return ch.then(function () { return caches.open(d.bucket).then(function (c) { return c['delete'](d.url); }); });
            }, Promise.resolve());
          }).then(function () { return 'Module caches cleared \u2014 ' + fmt(md.bytes) + ' freed'; });
        });
      },
    });
  }

  function actPersist() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persist().then(function (ok) {
      S.persisted = !!ok;
      S.html = ''; render();
      toast(ok ? 'Storage is now persistent \u2014 the browser won\u2019t clear it to make room'
        : 'The browser declined for now (it decides by how much you use the app \u2014 installing it to the Home Screen helps)', ok ? 'success' : 'info', 4200);
    }, function () { toast('Couldn\u2019t request persistent storage', 'error'); });
  }

  // The core modals sit below floating panels, so hand over by closing first.
  function handOver(fn) { close(); setTimeout(fn, 30); }
  function actManage() {
    var f = (Cade.storage && Cade.storage.openManager) || window.__promptStorageCleanup;
    if (typeof f !== 'function') { toast('Manage Storage isn\u2019t available here', 'error'); return; }
    handOver(function () { try { f(true); } catch (e) {} });
  }
  function actFiles() {
    var f = (Cade.storage && Cade.storage.openFileManager) || window.openFileManager;
    if (typeof f !== 'function') { toast('Attached Files isn\u2019t available here', 'error'); return; }
    handOver(function () { try { f(); } catch (e) {} });
  }

  // =========================================================================
  // Events
  // =========================================================================
  function onClick(e) {
    var t = e.target, b;
    if (!t.closest) return;
    if ((b = t.closest('[data-sheet]'))) { onSheet(b.getAttribute('data-sheet')); return; }
    if (S.confirm && t.classList.contains('si-sheet')) { closeConfirm(); return; }
    if (t.closest('.si-rescan')) { if (!S.busy && !S.working) scan(); return; }
    b = t.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (S.working && act !== 'details' && act !== 'all-rooms') { toast('One moment \u2014 still working'); return; }
    if (act === 'debris') actDebris();
    else if (act === 'snaps') actSnaps();
    else if (act === 'imgs') actImages();
    else if (act === 'app') actApp();
    else if (act === 'hd') actHd(null);
    else if (act === 'voice') actHd(b.getAttribute('data-voice'));
    else if (act === 'mods') actMods();
    else if (act === 'persist') actPersist();
    else if (act === 'manage') actManage();
    else if (act === 'files') actFiles();
    else if (act === 'all-rooms') { prefs.allRooms = !prefs.allRooms; savePrefs(); render(); }
    else if (act === 'details') { prefs.details = !prefs.details; savePrefs(); render(); }
    else if (act === 'open-room') {
      var name = b.getAttribute('data-room'), api = rooms();
      if (api && name) { close(); try { api.switchRoom(name); } catch (x) {} }
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t.getAttribute('data-pref') === 'snapDays') { prefs.snapDays = +t.value || 30; savePrefs(); render(); }
    else if (t.getAttribute('data-setting')) {
      try { Cade.Settings.set(t.getAttribute('data-setting'), t.value); toast('Saved \u2014 applies the next time snapshots are taken or opened', 'success', 2400); } catch (x) {}
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (S.confirm) closeConfirm(); else close(true);
      return;
    }
    var tag = e.target && e.target.tagName;
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') e.stopPropagation();
  }

  // =========================================================================
  // Open / close
  // =========================================================================
  function cleanup() {
    clearTimeout(renderTimer); renderTimer = 0;
    S.gen++;                                    // aborts a running scan at its next slice
    panelEl = null;
    S = fresh();
  }
  function close(focusEditor) {
    var p = panelEl;
    if (p) { p.remove(); cleanup(); }
    if (focusEditor && Cade.editor) { try { Cade.editor.focus(); } catch (e) {} }
  }
  function open() {
    Cade.closeAllMenus();
    if (panelEl && panelEl.isConnected) { close(false); return; }
    loadPrefs();
    S = fresh();
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udcbe Storage Insights',
      '<div class="si-main" tabindex="-1"></div>' +
      '<div class="si-foot"><span class="si-foot-note">Measured on this device only \u2014 nothing here touches the server.</span>' +
      '<button type="button" class="si-btn si-sm si-rescan">\u21bb Rescan</button></div>');
    panelEl = p;
    p._onClose = cleanup;
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('keydown', onKey);
    scan();
  }

  Cade.registerWidget({
    name: 'Storage Insights',
    description: 'See what Cade.txt stores on this device \u2014 and free space safely',
    icon: '\ud83d\udcbe',
    tags: 'storage,space,quota,disk,cache,cleanup,clean,free space,snapshots,images,offline,persist,usage,manage storage',
    open: open,
    _logic: Logic,
  });
})();
