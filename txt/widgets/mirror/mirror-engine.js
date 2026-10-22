/* Folder Mirror — engine (browser side; desktop Chrome / Edge only).
 *
 * Keeps the chosen rooms and a folder of .md / .txt files on this computer in
 * step, both ways, through the File System Access API. One instance per page
 * (window.__cadeMirrorEngine), shared by the widget (setup + status panel) and
 * the "mirror-run" plugin that keeps it going while the widget is closed.
 *
 * WHAT IT STORES (Cade.idbStore, this browser only): mirror:cfg (the folder
 * handle, scope, direction, paused), mirror:st (room → file path + the file's
 * last-seen size / modified time, conflicts, missing files, ignored files),
 * mirror:b:<room> (the BASE — the last text room and file agreed on),
 * mirror:cb:<room> (the base a conflict started from, for the merge screen),
 * mirror:log (the last 50 actions). The folder gets .txt-mirror.json (which
 * file is which room, so renames and odd names round-trip), conflict copies
 * "<name> (conflict YYYY-MM-DD HHMM).md" and a .trash folder.
 *
 * HOW A SYNC RUNS (tick): list the folder (one directory walk + a stat per
 * note file); a room whose text changed (Cade.roomsApi.onChange, debounced
 * 1 s) or whose file's size / modified time moved is compared three ways —
 * base, room, file — by mirror-core's decide(): write the file, write the room
 * (Cade.roomsApi.write with the text we saw as `base`, so edits made meanwhile
 * merge instead of being lost), merge both (merge-core), or keep both versions
 * (a conflict copy in the folder, flagged in the panel). New rooms get files;
 * new files are offered as rooms; a deleted file never deletes a room; a
 * deleted room's file goes to .trash (setting); a renamed room renames its file.
 *
 * WHEN IT RUNS: only after setup, only while start()ed (the plugin, or the
 * widget when there is no plugin), only with permission to the folder, only
 * while the page is visible (timers stop when hidden), and only in one tab at
 * a time (a Web Lock; other tabs wait). A FileSystemObserver (Chrome 129+)
 * reports changes at once, so the folder is only polled every 30 s as a
 * safety net; without one it is polled at the preference's interval, slowing
 * down while nothing changes. Remote edits to mirrored rooms that aren't open
 * arrive through Cade.roomsApi.watch while the page is visible. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeMirrorEngine) return;
  var Cade = window.Cade, C = window.__cadeMirrorCore;
  if (!C) return;
  var BASE = Cade.baseURL();
  var MERGE_CORE_URL = BASE + '../merge/merge-core.js', MERGE_UI_URL = BASE + '../merge/merge-ui.js';
  var ID = 'mirror', LOCK_NAME = 'cade-folder-mirror', REASON = 'folder-mirror';
  var K_CFG = 'mirror:cfg', K_ST = 'mirror:st', K_LOG = 'mirror:log', K_BASE = 'mirror:b:', K_CBASE = 'mirror:cb:';
  var ROOM_DEBOUNCE = 1000;   // a room's edits reach its file this long after they stop
  var GONE_GRACE = 4000;      // a room missing from the list this long counts as deleted
  var RETRY_MS = 5000;        // a room that had to wait (locked, offline, an error) is tried again after this
  var GONE_KEY = '\u0000gone';  // E.dirty entry that brings the next pass forward for a gone room

  function idb() { return Cade.idbStore; }
  function now() { return Date.now(); }
  function errMsg(e) { return (e && (e.message || e.name)) || String(e); }

  // ---- support -------------------------------------------------------------------
  // The API exists in desktop Chrome / Edge; phones (and emulated phones in
  // Chromium) are told mirroring runs on a computer.
  function supported() {
    if (typeof window.showDirectoryPicker !== 'function' || window.isSecureContext === false) return false;
    var ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
    if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return false;
    try { var d = Cade.cloud && Cade.cloud.device; if (d && d.kind && d.kind !== 'desktop') return false; } catch (e) {}
    return true;
  }

  // ---- prefs -------------------------------------------------------------------------
  var FIELD = {};
  C.PREF_FIELDS.forEach(function (f) { if (f.key) FIELD[f.key] = f; });
  var fallbackPrefs = null;
  function prefs() {
    if (Cade.prefs) return Cade.prefs(ID);
    if (!fallbackPrefs) {
      var d = {}, ls = [];
      C.PREF_FIELDS.forEach(function (f) { if (f.key) d[f.key] = f.default; });
      var all = function () { var o = {}; for (var k in d) o[k] = d[k]; return o; };
      fallbackPrefs = {
        get: function (k) { return d[k]; }, all: all,
        set: function (k, v) { d[k] = v; ls.slice().forEach(function (fn) { try { fn(k, v, all()); } catch (e) {} }); },
        on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; },
      };
    }
    return fallbackPrefs;
  }
  function coerce(f, v) {
    if (!f) return v;
    if (f.type === 'slider' || f.type === 'number') { v = +v; return isFinite(v) ? Math.max(f.min, Math.min(f.max, v)) : f.default; }
    if (f.type === 'toggle') return typeof v === 'boolean' ? v : !!f.default;
    if (f.type === 'radio' || f.type === 'select') { for (var i = 0; i < f.options.length; i++) if (f.options[i].value === v) return v; return f.default; }
    return v == null ? f.default : v;
  }
  function pv(k) { var v; try { v = prefs().get(k); } catch (e) {} return coerce(FIELD[k], v); }
  function pset(k, v) { try { prefs().set(k, coerce(FIELD[k], v)); } catch (e) {} }

  // ---- state -----------------------------------------------------------------------------
  var E = {
    cfg: null, st: null, log: [], loaded: null,
    state: 'off', note: '',
    started: false, owner: '', root: null,
    timer: 0, timerAt: 0, idle: 0, busy: false, again: false, full: false,
    dirty: new Map(),       // room -> when its text last changed (or a retry time)
    gone: new Map(),        // room -> when it was first seen missing from the room list
    deleted: new Set(),     // rooms the core said were removed (no grace needed)
    renames: new Map(),     // old name -> new name (the core said so)
    bases: new Map(),
    waits: {},              // room -> last 'waiting' reason logged (no repeats)
    newFiles: [],
    observer: null, offChange: null, offWatch: null, watchSig: '', offPrefs: null, lock: null,
    subs: [], lastTick: 0, lastChange: 0, stDirty: false, logDirty: false, merge: null,
  };

  function status() {
    var recs = (E.st && E.st.rooms) || {}, conflicts = [], missing = [];
    Object.keys(recs).sort().forEach(function (n) {
      var r = recs[n];
      if (r.conflict) conflicts.push({ room: n, path: r.conflict.path, at: r.conflict.at, keep: r.conflict.keep, first: !!r.conflict.first, file: r.path });
      if (r.missing) missing.push({ room: n, path: r.path });
    });
    return {
      supported: supported(), state: E.state, note: E.note, configured: !!E.cfg, started: E.started, owner: E.owner,
      folder: E.cfg ? E.cfg.folderName : '', direction: E.cfg ? E.cfg.direction : 'both', paused: !!(E.cfg && E.cfg.paused),
      scope: E.cfg ? E.cfg.scope : null,
      rooms: Object.keys(recs).length, conflicts: conflicts, missing: missing, newFiles: E.newFiles.slice(),
      log: E.log.slice(), lastTick: E.lastTick, lastChange: E.lastChange, observing: !!E.observer,
    };
  }
  var emitT = 0;
  function emit() {
    if (emitT) return;
    emitT = setTimeout(function () {
      emitT = 0;
      var s = status();
      E.subs.slice().forEach(function (fn) { try { fn(s); } catch (e) {} });
    }, 0);
  }
  function setState(s, note) {
    if (E.state === s && E.note === (note || '')) return;
    E.state = s; E.note = note || '';
    emit();
  }
  function log(kind, room, msg) {
    E.log = C.pushLog(E.log, { t: now(), k: kind, r: room || '', m: msg || '' }, 50);
    E.logDirty = true;
    emit();
  }

  // ---- persistence -------------------------------------------------------------------
  function freshSt() { return { rooms: {}, ignored: {}, indexSig: '' }; }
  function validCfg(c) {
    if (!c || typeof c !== 'object' || !c.handle || typeof c.handle.getDirectoryHandle !== 'function') return null;
    c.scope = c.scope && typeof c.scope === 'object' ? c.scope : { mode: 'all' };
    c.direction = c.direction === 'out' || c.direction === 'in' ? c.direction : 'both';
    c.exclude = Array.isArray(c.exclude) ? c.exclude : [];
    return c;
  }
  function validSt(s) {
    if (!s || typeof s !== 'object' || !s.rooms || typeof s.rooms !== 'object') return freshSt();
    if (!s.ignored || typeof s.ignored !== 'object') s.ignored = {};
    Object.keys(s.rooms).forEach(function (n) { var r = s.rooms[n]; if (!r || typeof r !== 'object' || !C.safePath(r.path)) delete s.rooms[n]; });
    return s;
  }
  function load() {
    if (!E.loaded) {
      var I = idb();
      E.loaded = Promise.all([I.get(K_CFG), I.get(K_ST), I.get(K_LOG)]).then(function (r) {
        E.cfg = validCfg(r[0]);
        E.st = validSt(r[1]);
        E.log = Array.isArray(r[2]) ? r[2].slice(-50) : [];
        E.root = E.cfg ? E.cfg.handle : null;
        if (!supported()) setState('unsupported');
        else if (!E.cfg) setState('setup');
        else if (!E.started) setState('off');
        return status();
      }, function (e) { E.loaded = null; throw e; });
    }
    return E.loaded;
  }
  function saveCfg() { return E.cfg ? idb().set(K_CFG, E.cfg) : idb().remove(K_CFG); }
  function flush() {
    var p = [];
    if (E.stDirty && E.st) { E.stDirty = false; p.push(idb().set(K_ST, E.st)); }
    if (E.logDirty) { E.logDirty = false; p.push(idb().set(K_LOG, E.log)); }
    return Promise.all(p).catch(function () {});
  }
  async function getBase(name) {
    if (E.bases.has(name)) return E.bases.get(name);
    var b = null;
    try { b = await idb().get(K_BASE + name); } catch (e) {}
    b = typeof b === 'string' ? b : null;
    E.bases.set(name, b);
    return b;
  }
  async function setBase(name, text) { E.bases.set(name, text); await idb().set(K_BASE + name, text); }
  async function dropRoom(name) {
    if (E.st && E.st.rooms[name]) { delete E.st.rooms[name]; E.stDirty = true; }
    E.bases.delete(name); E.dirty.delete(name);
    try { await idb().remove(K_BASE + name); await idb().remove(K_CBASE + name); } catch (e) {}
  }

  // ---- file system -------------------------------------------------------------------
  async function dirAt(root, segs, create) {
    var d = root;
    for (var i = 0; i < segs.length; i++) d = await d.getDirectoryHandle(segs[i], { create: !!create });
    return d;
  }
  async function fileAt(root, path, create) {
    var p = C.splitPath(path), d = await dirAt(root, p.dir, create);
    return d.getFileHandle(p.name, { create: !!create });
  }
  // Write text to a file (the handle we listed it under, else by path) → its new stat.
  async function writeFile(root, path, text, handle) {
    var fh = handle || await fileAt(root, path, true);
    var w = await fh.createWritable();
    try { await w.write(text); await w.close(); }
    catch (e) { try { await w.abort(); } catch (e2) {} throw e; }
    var f = await fh.getFile();
    return { mtime: f.lastModified, size: f.size };
  }
  async function removeFile(root, path) {
    var p = C.splitPath(path), d = await dirAt(root, p.dir, false);
    await d.removeEntry(p.name);
  }
  async function moveFile(root, from, to, handle) {
    var fh = handle || await fileAt(root, from, false), t = C.splitPath(to), d = await dirAt(root, t.dir, true);
    if (typeof fh.move === 'function') {
      try { await fh.move(d, t.name); return; } catch (e) { /* not on this file system: copy instead */ }
    }
    var text = await (await fh.getFile()).text();
    await writeFile(root, to, text);
    await removeFile(root, from);
  }
  // Keep a pass's listing true after it moved a file (later steps of the same
  // pass read it): the old path is gone, the new one is there.
  async function relist(ctx, from, to) {
    ctx.files.delete(from.toLowerCase());
    if (!to) return null;
    var fh = await fileAt(E.root, to, false), f = await fh.getFile();
    var entry = { path: to, name: C.splitPath(to).name, handle: fh, file: f, mtime: f.lastModified, size: f.size };
    ctx.files.set(to.toLowerCase(), entry);
    return entry;
  }
  // Every note-like file (.md .txt .markdown) in the folder and the folders
  // below it — never in dot-folders (.trash, .obsidian, .git):
  // Map lowerPath → { path, name, handle, file, mtime, size }.
  async function scan(root) {
    var out = new Map(), dirs = 0;
    async function walk(dir, segs, depth) {
      for await (var entry of dir.values()) {
        var name = C.nfc(entry.name);
        if (name.charAt(0) === '.') continue;
        if (entry.kind === 'directory') {
          if (depth < 6 && dirs++ < 400) await walk(entry, segs.concat([name]), depth + 1);
          continue;
        }
        if (!C.splitExt(name)) continue;
        var f;
        try { f = await entry.getFile(); } catch (e) { continue; }
        var path = C.joinPath(segs.concat([name]));
        out.set(path.toLowerCase(), { path: path, name: name, handle: entry, file: f, mtime: f.lastModified, size: f.size });
      }
    }
    await walk(root, [], 0);
    return out;
  }
  async function readText(f) {
    if (f.size > C.MAX_FILE_BYTES) { var e = new Error(f.path + ' is over 5 MB — skipped'); e.code = 'too-big'; throw e; }
    var raw;
    try { raw = await f.file.text(); }
    catch (err) {
      // Changed since it was listed: read it as it is now.
      var nf = await f.handle.getFile();
      raw = await nf.text();
      f.file = nf; f.mtime = nf.lastModified; f.size = nf.size;
    }
    return C.textFromFile(raw, { front: pv('front') });
  }
  async function readIndex(root) {
    try { return C.parseIndex(await (await (await root.getFileHandle(C.INDEX_NAME)).getFile()).text()); }
    catch (e) { return null; }
  }
  async function hasPermission(root, ask) {
    if (!root) return false;
    try {
      if (typeof root.queryPermission !== 'function') return true;
      var p = await root.queryPermission({ mode: 'readwrite' });
      if (p === 'granted') return true;
      if (ask && typeof root.requestPermission === 'function') p = await root.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    } catch (e) { return false; }
  }

  // ---- merge-core (three-way merges) and merge-ui (the conflict resolver) --------------------
  var scriptLoads = {};
  function loadScript(url, glob) {
    if (window[glob]) return Promise.resolve(window[glob]);
    if (!scriptLoads[url]) {
      scriptLoads[url] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = url; s.async = true;
        s.onload = function () { window[glob] ? res(window[glob]) : rej(new Error('missing ' + glob)); };
        s.onerror = function () { delete scriptLoads[url]; rej(new Error('Could not load ' + url)); };
        document.head.appendChild(s);
      });
    }
    return scriptLoads[url];
  }
  function loadMerge() {
    return loadScript(MERGE_CORE_URL, '__cadeMergeCore').then(function (m) { E.merge = m; return m; });
  }
  function merge3(base, room, file) {
    if (!E.merge) return null;
    try { var r = E.merge.merge3(base, room, file); return r.conflicts ? null : r.merged; } catch (e) { return null; }
  }

  // ---- rooms ---------------------------------------------------------------------------
  function api() { return Cade.roomsApi; }
  function byId(id) { try { return api().workspaceById(id); } catch (e) { return null; } }
  function roomInfo(name) {
    var A = api(), ids = [], chain = [];
    try { ids = A.workspaceIds(name) || []; } catch (e) {}
    ids.forEach(function (id) {
      var w = byId(id), g = 0;
      while (w && g++ < 20) { if (chain.indexOf(w.id) < 0) chain.push(w.id); w = w.parentId ? byId(w.parentId) : null; }
    });
    var archived = false;
    try { archived = !!A.isArchived(name); } catch (e) {}
    return { archived: archived, ws: ids, wsChain: chain };
  }
  function inScope(name, cfg, archived) {
    cfg = cfg || E.cfg;
    if (!cfg || (cfg.exclude || []).indexOf(name) >= 0) return false;
    return C.inScope(name, cfg.scope, archived == null ? pv('archived') : archived, roomInfo(name));
  }
  function wsPathFor(name) {
    var ids = [];
    try { ids = api().workspaceIds(name) || []; } catch (e) {}
    return ids.length ? C.wsFolder(ids[0], byId) : [];
  }
  function workspaceList() {
    try { return (api().workspaces() || []).map(function (w) { return byId(w.id) || w; }); } catch (e) { return []; }
  }
  async function writeRoom(name, text, seen, opts) {
    try {
      var r = await api().write(name, text, Object.assign({ base: seen, reason: REASON }, opts || {}));
      if (E.waits[name]) { delete E.waits[name]; }
      return r;
    } catch (e) {
      var code = e && e.code;
      if (code === 'conflict') { E.dirty.set(name, 0); return null; }   // the room moved on: compare again next time
      if (code === 'read-only' || code === 'locked' || code === 'busy' || code === 'offline') {
        if (E.waits[name] !== code) { E.waits[name] = code; log('wait', name, errMsg(e) + ' — will retry'); }
        retryLater(name);
        return null;
      }
      log('error', name, 'couldn’t update the room: ' + errMsg(e));
      return null;
    }
  }

  // ---- one sync pass -----------------------------------------------------------------------
  // Returns true when something changed (resets the polling back-off).
  async function runSync(full) {
    var root = E.root, cfg = E.cfg, recs = E.st.rooms, A = api();
    if (!(await hasPermission(root, false))) { setState('permission'); return false; }
    var direction = cfg.direction, sub = !!pv('sub'), front = pv('front');
    var files;
    try { files = await scan(root); }
    catch (e) {
      setState('error', e && e.name === 'NotFoundError' ? 'The folder can’t be found — it may have been moved, renamed or deleted.' : 'Can’t read the folder: ' + errMsg(e));
      return false;
    }
    if (E.state === 'error') setState('running');
    var did = false, t = now();
    var all = A.list(), allSet = {};
    all.forEach(function (n) { allSet[n] = 1; });
    var owned = {};
    Object.keys(recs).forEach(function (n) { owned[recs[n].path.toLowerCase()] = n; });
    var taken = function (low, room) { var o = owned[low]; return o ? o !== room : files.has(low); };
    var ctx = { files: files, owned: owned, taken: taken, sub: sub, front: front, direction: direction };

    // 1. Rooms that left the list: renamed (the core said so, or another new
    //    room holds exactly the text) or deleted. A room merely missing for a
    //    moment gets a few seconds' grace first; new rooms wait for it, since
    //    one of them may be its new name.
    E.gone.forEach(function (v, n) { if (allSet[n]) E.gone.delete(n); });
    E.dirty.delete(GONE_KEY);
    var waiting = false;
    var goneList = Object.keys(recs).filter(function (n) { return !allSet[n]; });
    for (var gi = 0; gi < goneList.length; gi++) {
      var g = goneList[gi];
      if (!E.gone.has(g)) E.gone.set(g, t);
      if (!E.deleted.has(g) && !E.renames.has(g) && t - E.gone.get(g) < GONE_GRACE) {
        waiting = true;
        E.dirty.set(GONE_KEY, E.gone.get(g) + GONE_GRACE - ROOM_DEBOUNCE);
        continue;
      }
      did = (await roomGone(g, all, ctx)) || did;
      E.gone.delete(g); E.deleted.delete(g); E.renames.delete(g);
    }

    // 2. Mirrored rooms that are no longer in scope: stop mirroring them (the file stays).
    var keys = Object.keys(recs);
    for (var oi = 0; oi < keys.length; oi++) {
      var on = keys[oi];
      if (allSet[on] && !inScope(on)) {
        log('info', on, 'no longer mirrored — ' + recs[on].path + ' stays in the folder');
        delete owned[recs[on].path.toLowerCase()];
        await dropRoom(on);
        did = true;
      }
    }

    // 3. Rooms in scope.
    var scope = all.filter(function (n) { return inScope(n); });
    for (var si = 0; si < scope.length; si++) {
      var name = scope[si], rec = recs[name];
      try {
        if (!rec) { if (!waiting) did = (await meetRoom(name, ctx)) || did; continue; }
        var f = files.get(rec.path.toLowerCase());
        // Layout follows the preferences (subfolders, a room's workspace).
        if (f && !rec.missing) {
          var want = C.planPath(name, { sub: sub }, { current: rec.path, wsPath: wsPathFor(name), taken: taken });
          if (want.toLowerCase() !== rec.path.toLowerCase()) {
            await moveFile(root, rec.path, want, f.handle);
            log('move', name, rec.path + ' → ' + want);
            delete owned[rec.path.toLowerCase()];
            owned[want.toLowerCase()] = name;
            f = await relist(ctx, rec.path, want);
            rec.path = want; rec.mtime = f.mtime; rec.size = f.size;
            E.stDirty = true; did = true;
          }
        }
        var dt = E.dirty.get(name);
        var roomDue = full || (dt != null && t - dt >= ROOM_DEBOUNCE);
        var fileDue = C.statChanged(rec, f ? { mtime: f.mtime, size: f.size } : null);
        if (!roomDue && !fileDue) continue;
        did = (await syncRoom(name, rec, f, ctx)) || did;
        if (E.waits[name] && !E.dirty.has(name)) delete E.waits[name];
      } catch (e) {
        if (e && e.code === 'too-big' && rec && f) { rec.mtime = f.mtime; rec.size = f.size; E.stDirty = true; }
        roomError(name, e);
      }
    }

    // 4. Files no room owns: a mirrored room's file renamed in the folder, or new notes.
    did = (await newFiles(ctx)) || did;

    // 5. The index, and following remote edits to the mirrored rooms.
    await writeIndexIfChanged(root);
    rewatch();
    return did;
  }

  function retryLater(name) { E.dirty.set(name, now() + RETRY_MS - ROOM_DEBOUNCE); }
  // An error for a room: logged once (not on every pass), tried again later.
  function roomError(name, e) {
    var m = errMsg(e);
    if (E.waits[name] !== m) { E.waits[name] = m; log('error', name, m); }
    retryLater(name);
  }
  async function syncRoom(name, rec, f, ctx) {
    var base = await getBase(name);
    var room = await api().read(name);
    if (room == null) { retryLater(name); return false; }   // not readable now (offline) — later
    if (!f && rec.missing) { E.dirty.delete(name); return false; }   // the panel is asking about it
    var fileText = f ? await readText(f) : null;
    var d = C.decide({ base: base, room: room, file: fileText, direction: ctx.direction, merge: merge3 });
    E.dirty.delete(name);
    return apply(name, rec, d, { base: base, room: room, file: fileText, f: f }, ctx);
  }

  function noteStat(rec, f) {
    if (!f) return;
    if (rec.mtime !== f.mtime || rec.size !== f.size || rec.missing) { rec.mtime = f.mtime; rec.size = f.size; rec.missing = false; E.stDirty = true; }
  }
  async function putFile(name, rec, text, f, ctx) {
    var out = C.fileTextFor(text, name, { front: ctx.front }, new Date());
    var stat = await writeFile(E.root, rec.path, out, f && f.handle);
    rec.mtime = stat.mtime; rec.size = stat.size; rec.missing = false; rec.skipNoted = false;
    E.stDirty = true;
  }

  async function apply(name, rec, d, x, ctx) {
    switch (d.action) {
      case 'none':
        noteStat(rec, x.f);
        if (d.skipped === 'file' && !rec.skipNoted) { rec.skipNoted = true; E.stDirty = true; log('info', name, rec.path + ' was edited — not copied into the room (txt → folder only)'); }
        return false;
      case 'agree':
        noteStat(rec, x.f);
        await setBase(name, d.text);
        return false;
      case 'write-file':
        await putFile(name, rec, d.text, x.f, ctx);
        await setBase(name, d.text);
        log(d.merged ? 'merged' : 'wrote', name, (x.f ? 'updated ' : 'created ') + rec.path);
        return true;
      case 'write-room':
      case 'merge': {
        var r = await writeRoom(name, d.text, x.room);
        if (!r) return false;
        if (d.action === 'merge' || r.text !== d.text) await putFile(name, rec, r.text, x.f, ctx);
        else noteStat(rec, x.f);
        await setBase(name, r.text);
        if (d.action === 'merge' || d.merged || r.merged) log('merged', name, 'edits in the room and in ' + rec.path + ' merged');
        else log('read', name, rec.path + ' → room');
        return true;
      }
      case 'conflict':
        return conflict(name, rec, d, x, ctx);
      case 'file-missing':
        if (!rec.missing) { rec.missing = true; E.stDirty = true; log('missing', name, rec.path + ' is gone from the folder'); return true; }
        return false;
    }
    return false;
  }

  // Both changed the same lines (or met for the first time with different
  // text): one version stays in the room and the main file, the other is
  // kept next to it as "<name> (conflict …).md" and flagged in the panel.
  async function conflict(name, rec, d, x, ctx) {
    var cpath = C.conflictPath(rec.path, new Date(), function (low) { return ctx.files.has(low) || !!ctx.owned[low]; });
    var keepText = d.text;
    if (d.keep === 'file') {
      var r = await writeRoom(name, d.text, x.room);
      if (!r) return false;
      keepText = r.text;
    }
    await writeFile(E.root, cpath, d.other);
    ctx.files.set(cpath.toLowerCase(), { path: cpath });
    if (d.keep === 'room' || keepText !== d.text) await putFile(name, rec, keepText, x.f, ctx);
    else noteStat(rec, x.f);
    await setBase(name, keepText);
    try { if (x.base != null) await idb().set(K_CBASE + name, x.base); else await idb().remove(K_CBASE + name); } catch (e) {}
    var first = x.base == null;
    rec.conflict = { path: cpath, at: now(), keep: d.keep, first: first };
    E.stDirty = true;
    log('conflict', name, (first ? 'the folder already had a different ' + rec.path + ' — ' : 'both sides changed the same lines — ') +
      (d.keep === 'room' ? 'the file’s' : 'the room’s') + ' text saved as ' + cpath);
    return true;
  }

  // A room in scope that has no file yet: its own file if one is there (same
  // name, any case, any folder), else a new one.
  function fileFor(name, ctx) {
    var hit = null;
    ctx.files.forEach(function (f, low) {
      if (hit || ctx.owned[low]) return;
      var pf = C.parseFileName(f.name);
      if (pf && pf.room === name) hit = f;
    });
    return hit;
  }
  async function meetRoom(name, ctx) {
    var f = fileFor(name, ctx);
    if (!f && ctx.direction === 'in') return false;      // folder → txt only: rooms don't make files
    var room = await api().read(name);
    if (room == null) return false;
    var path = f ? f.path : C.planPath(name, { ext: pv('ext'), sub: ctx.sub }, { wsPath: wsPathFor(name), taken: ctx.taken });
    var rec = { path: path, mtime: 0, size: 0 };
    var fileText = f ? await readText(f) : null;
    var d = C.decide({ base: null, room: room, file: fileText, direction: ctx.direction, merge: merge3 });
    if (d.action === 'none' && !f) return false;
    E.st.rooms[name] = rec; ctx.owned[path.toLowerCase()] = name; E.stDirty = true;
    E.dirty.delete(name);
    if (d.action === 'agree' || d.action === 'none') { noteStat(rec, f); await setBase(name, room); log('info', name, 'now mirrored as ' + path); return true; }
    return apply(name, rec, d, { base: null, room: room, file: fileText, f: f }, ctx);
  }

  async function roomGone(name, all, ctx) {
    var rec = E.st.rooms[name], base = await getBase(name);
    var f = ctx.files.get(rec.path.toLowerCase());
    // Renamed: the core told us, or a room we don't mirror yet holds exactly its text.
    var to = E.renames.get(name);
    if (!to && base != null) {
      for (var i = 0; i < all.length && !to; i++) {
        var n = all[i];
        if (E.st.rooms[n] || !inScope(n)) continue;
        var t = null;
        try { t = await api().read(n); } catch (e) {}
        if (t === base) to = n;
      }
    }
    if (to && E.st.rooms[to] == null && inScope(to)) {
      var sc = E.cfg.scope;
      if (sc && sc.mode === 'rooms' && sc.rooms.indexOf(name) >= 0) { sc.rooms = sc.rooms.map(function (r) { return r === name ? to : r; }); saveCfg(); }
      var ext = (C.splitExt(C.splitPath(rec.path).name) || { ext: '.md' }).ext;
      delete ctx.owned[rec.path.toLowerCase()];
      var path = rec.path;
      if (f && !rec.missing) {
        path = C.planPath(to, { ext: ext === '.txt' ? '.txt' : '.md', sub: ctx.sub }, { wsPath: wsPathFor(to), taken: ctx.taken });
        if (ext !== '.md' && ext !== '.txt') path = path.replace(/\.(md|txt)$/, ext);
        await moveFile(E.root, rec.path, path, f.handle);
      }
      ctx.owned[path.toLowerCase()] = to;
      var moved = { path: path, mtime: 0, size: 0, conflict: rec.conflict, missing: rec.missing };
      if (f && !rec.missing) { try { var nf = await relist(ctx, rec.path, path); moved.mtime = nf.mtime; moved.size = nf.size; } catch (e) {} }
      E.st.rooms[to] = moved;
      delete E.st.rooms[name];
      E.bases.delete(name);
      if (base != null) await setBase(to, base);
      try { await idb().remove(K_BASE + name); var cb = await idb().get(K_CBASE + name); if (cb != null) { await idb().set(K_CBASE + to, cb); await idb().remove(K_CBASE + name); } } catch (e) {}
      E.stDirty = true;
      E.dirty.set(to, 0);
      log('move', to, 'room renamed from “' + name + '” — ' + rec.path + ' → ' + path);
      return true;
    }
    // Deleted (or renamed to something we don't mirror).
    var msg = 'room ' + (to ? 'renamed to “' + to + '” (not mirrored)' : 'deleted');
    if (f && !rec.missing && !to && pv('onDelete') === 'trash') {
      var text = null;
      try { text = await readText(f); } catch (e) {}
      if (base == null || text === base) {
        var tp = C.trashPath(rec.path, new Date(), function (low) { return ctx.files.has(low); });
        await moveFile(E.root, rec.path, tp, f.handle);
        ctx.files.delete(rec.path.toLowerCase());
        log('trash', name, msg + ' — moved ' + rec.path + ' to ' + tp);
      } else log('info', name, msg + ' — ' + rec.path + ' had edits of its own, so it stays');
    } else log('info', name, msg + (f ? ' — ' + rec.path + ' stays in the folder' : ''));
    delete ctx.owned[rec.path.toLowerCase()];
    await dropRoom(name);
    var ex = E.cfg.scope;
    if (ex && ex.mode === 'rooms') { var k = ex.rooms.indexOf(name); if (k >= 0) { ex.rooms.splice(k, 1); saveCfg(); } }
    return true;
  }

  // Files nobody owns. One holding exactly the text of a mirrored room whose
  // file went missing is that file, renamed or moved; the rest are new notes —
  // offered in the panel, imported, or ignored (preference).
  async function newFiles(ctx) {
    var did = false, fresh = [];
    ctx.files.forEach(function (f, low) {
      if (ctx.owned[low] || E.st.ignored[low] || !f.handle) return;
      var pf = C.parseFileName(f.name);
      if (pf) fresh.push({ path: f.path, room: pf.room, dir: C.splitPath(f.path).dir, f: f });
    });
    var missing = Object.keys(E.st.rooms).filter(function (n) { return E.st.rooms[n].missing; });
    for (var i = 0; i < missing.length && fresh.length; i++) {
      var n = missing[i], base = await getBase(n);
      if (base == null) continue;
      for (var j = 0; j < fresh.length; j++) {
        var cand = fresh[j], t = null;
        try { t = await readText(cand.f); } catch (e) { continue; }
        if (t !== base) continue;
        var rec = E.st.rooms[n];
        log('move', n, rec.path + ' was renamed to ' + cand.path + ' — following it');
        delete ctx.owned[rec.path.toLowerCase()];
        rec.path = cand.path; rec.missing = false; rec.mtime = cand.f.mtime; rec.size = cand.f.size;
        ctx.owned[cand.path.toLowerCase()] = n;
        E.stDirty = true; did = true;
        fresh.splice(j, 1);
        break;
      }
    }
    var mode = pv('newFiles');
    if (ctx.direction === 'out' || mode === 'ignore') fresh = [];
    if (mode === 'auto' && fresh.length) { did = (await importFiles(fresh, ctx)) > 0 || did; fresh = []; }
    var sig = fresh.map(function (x) { return x.path; }).join('\n'), was = E.newFiles.map(function (x) { return x.path; }).join('\n');
    E.newFiles = fresh.map(function (x) { return { path: x.path, room: x.room }; });
    if (sig !== was) emit();
    return did;
  }

  // A unique room name for an imported file.
  function freeRoomName(room) {
    var list = api().list(), name = room, n = 2;
    while (list.indexOf(name) >= 0 && n < 1000) { name = C.fixRoom(room.slice(0, 95) + ' ' + n); n++; }
    return name;
  }
  async function importFiles(items, ctx) {
    var count = 0, cfg = E.cfg, wsList = workspaceList();
    for (var i = 0; i < items.length; i++) {
      var it = items[i], f = it.f || ctx.files.get(it.path.toLowerCase());
      if (!f || ctx.owned[it.path.toLowerCase()]) continue;
      try {
        var text = await readText(f);
        var name = freeRoomName(it.room);
        var ws = ctx.sub ? C.folderToWs(it.dir || C.splitPath(it.path).dir, wsList, byId) : null;
        if (!ws && cfg.scope && cfg.scope.mode === 'ws') ws = (cfg.scope.ws || []).filter(function (id) { return id !== '__unlabeled__' && byId(id); })[0] || null;
        if (cfg.scope && cfg.scope.mode === 'rooms' && cfg.scope.rooms.indexOf(name) < 0) { cfg.scope.rooms.push(name); saveCfg(); }
        var r = await api().write(name, text, { create: true, workspace: ws, reason: REASON });
        E.st.rooms[name] = { path: f.path, mtime: f.mtime, size: f.size };
        ctx.owned[f.path.toLowerCase()] = name;
        await setBase(name, r && r.text != null ? r.text : text);
        E.stDirty = true;
        log('import', name, f.path + ' → new room “' + name + '”');
        count++;
      } catch (e) { log('error', it.room, 'couldn’t import ' + it.path + ': ' + errMsg(e)); }
    }
    return count;
  }

  async function writeIndexIfChanged(root) {
    var idx = C.emptyIndex();
    Object.keys(E.st.rooms).forEach(function (n) { idx.rooms[n] = E.st.rooms[n].path; });
    var text = C.serializeIndex(idx), sig = C.hash(text);
    if (sig === E.st.indexSig) return;
    try { await writeFile(root, C.INDEX_NAME, text); E.st.indexSig = sig; E.stDirty = true; }
    catch (e) { log('error', '', 'couldn’t write ' + C.INDEX_NAME + ': ' + errMsg(e)); }
  }

  // Follow remote edits to the mirrored rooms (only while running and visible).
  function rewatch() {
    var want = E.started && E.state === 'running' && document.visibilityState !== 'hidden';
    var names = want ? Object.keys(E.st.rooms).sort() : [];
    var sig = names.join('\n');
    if (sig === E.watchSig) return;
    if (E.offWatch) { try { E.offWatch(); } catch (e) {} E.offWatch = null; }
    E.watchSig = sig;
    if (names.length && api().watch) { try { E.offWatch = api().watch(names); } catch (e) {} }
  }

  // ---- the loop -------------------------------------------------------------------------
  function canTick() { return E.started && E.state === 'running' && !!E.root && !!E.cfg && document.visibilityState !== 'hidden'; }
  function kick(ms) {
    if (!canTick()) return;
    ms = Math.max(0, ms || 0);
    var at = now() + ms;
    if (E.timer && E.timerAt <= at) return;
    clearTimeout(E.timer);
    E.timerAt = at;
    E.timer = setTimeout(tick, ms);
  }
  function schedule() {
    clearTimeout(E.timer); E.timer = 0;
    if (!canTick()) return;
    var d = C.nextDelay(pv('poll'), E.idle, !!E.observer);
    E.dirty.forEach(function (at) { d = Math.min(d, Math.max(60, at + ROOM_DEBOUNCE - now() + 20)); });
    kick(d);
  }
  function tick() {
    E.timer = 0;
    if (!canTick()) return;
    if (E.busy) { E.again = true; return; }
    E.busy = true;
    var full = E.full;
    E.full = false;
    var did = false;
    runSync(full).then(function (d) { did = d; }, function (e) { log('error', '', errMsg(e)); }).then(function () {
      E.busy = false;
      E.lastTick = now();
      if (did) { E.idle = 0; E.lastChange = now(); } else E.idle++;
      flush();
      emit();
      if (E.again) { E.again = false; clearTimeout(E.timer); E.timer = 0; kick(30); }
      else schedule();
    });
  }

  function onRoomChange(name, text, info) {
    if (!E.started || !E.st) return;
    info = info || {};
    if (info.kind === 'delete') { if (E.st.rooms[name]) { E.deleted.add(name); E.dirty.set('\u0000gone', 0); kick(200); } return; }
    if (info.kind === 'rename') {
      if (info.from && E.st.rooms[info.from]) { E.renames.set(info.from, name); E.dirty.set('\u0000gone', 0); kick(200); }
      else if (inScope(name)) { E.dirty.set(name, now()); schedule(); }
      return;
    }
    // Our own write coming back.
    if (info.source === 'api' && info.reason === REASON && E.bases.get(name) === text) return;
    if (E.st.rooms[name] || inScope(name)) {
      E.dirty.set(name, now());
      if (!E.busy) schedule();
    }
  }
  function onVis() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(E.timer); E.timer = 0;
      rewatch();
    } else if (canTick()) {
      E.idle = 0;
      rewatch();
      kick(150);
    }
  }
  function onFocus() { if (canTick()) { E.idle = 0; kick(100); } }
  function onPref(key) {
    if (!E.started) return;
    if (key === 'sub' || key === 'archived' || key === 'front' || key === 'newFiles') E.full = key !== 'newFiles';
    E.idle = 0;
    if (key === 'poll') schedule(); else kick(200);
  }
  function startObserver() {
    if (E.observer || E.observing || typeof window.FileSystemObserver !== 'function' || !E.root) return;
    E.observing = true;
    try {
      var ob = new window.FileSystemObserver(function () { if (canTick()) kick(250); else if (E.busy) E.again = true; });
      ob.observe(E.root, { recursive: true }).then(function () {
        if (!E.started) { try { ob.disconnect(); } catch (e) {} E.observing = false; return; }
        E.observer = ob; emit(); schedule();
      }, function () { try { ob.disconnect(); } catch (e) {} E.observing = false; });
    } catch (e) { E.observing = false; }
  }
  function stopObserver() {
    if (E.observer) { try { E.observer.disconnect(); } catch (e) {} }
    E.observer = null; E.observing = false;
  }

  // One tab mirrors at a time; the others wait their turn (Web Locks).
  function acquireLock() {
    if (!navigator.locks || typeof navigator.locks.request !== 'function') return Promise.resolve(true);
    return new Promise(function (resolve) {
      var ac = typeof AbortController === 'function' ? new AbortController() : null, granted = false;
      var L = E.lock = { release: null, abort: function () { if (!granted && ac) try { ac.abort(); } catch (e) {} } };
      var t = setTimeout(function () { if (!granted && E.started) setState('waiting', 'Folder Mirror is running in another tab of this browser.'); }, 300);
      navigator.locks.request(LOCK_NAME, ac ? { signal: ac.signal } : {}, function () {
        granted = true; clearTimeout(t);
        return new Promise(function (rel) { L.release = rel; resolve(true); });
      }).catch(function () { clearTimeout(t); resolve(false); });
    });
  }
  function releaseLock() {
    var L = E.lock;
    E.lock = null;
    if (!L) return;
    if (L.release) L.release(); else L.abort();
  }

  function begin() {
    setState(E.cfg.paused ? 'paused' : 'running');
    startObserver();
    E.full = true; E.idle = 0;
    kick(0);
  }
  // Start mirroring (the plugin, or the widget when there's no plugin).
  async function start(owner) {
    if (!supported()) { setState('unsupported'); return false; }
    await load();
    if (E.started) return true;
    if (!E.cfg) { setState('setup'); return false; }
    E.started = true; E.owner = owner || 'plugin';
    setState('starting');
    try { await loadMerge(); } catch (e) { /* merges then fall back to keeping both versions */ }
    var got = await acquireLock();
    if (!E.started) { releaseLock(); return false; }
    if (!got) { setState('error', 'Couldn’t take the mirror lock'); return false; }
    E.offChange = api().onChange(onRoomChange);
    E.offPrefs = prefs().on(onPref);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    if (!(await hasPermission(E.root, false))) { if (E.started) setState('permission'); return false; }
    if (!E.started) return false;
    begin();
    return true;
  }
  function stop(owner) {
    if (owner && E.owner && owner !== E.owner) return;
    E.started = false; E.owner = '';
    clearTimeout(E.timer); E.timer = 0;
    stopObserver();
    if (E.offChange) { try { E.offChange(); } catch (e) {} E.offChange = null; }
    if (E.offPrefs) { try { E.offPrefs(); } catch (e) {} E.offPrefs = null; }
    if (E.offWatch) { try { E.offWatch(); } catch (e) {} E.offWatch = null; }
    E.watchSig = '';
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('focus', onFocus);
    releaseLock();
    E.dirty.clear(); E.gone.clear(); E.deleted.clear(); E.renames.clear(); E.newFiles = [];
    flush();
    if (E.loaded) setState(!supported() ? 'unsupported' : E.cfg ? 'off' : 'setup');
  }
  // Must run inside a click: asks the browser for the folder again.
  async function reconnect() {
    if (!E.root) return false;
    var ok = await hasPermission(E.root, true);
    if (!ok) { log('info', '', 'Access to the folder wasn’t allowed'); return false; }
    log('info', '', 'Access to “' + (E.cfg && E.cfg.folderName) + '” allowed again');
    if (E.started && (E.state === 'permission' || E.state === 'error')) begin();
    return true;
  }
  function pause(on) {
    if (!E.cfg) return;
    E.cfg.paused = !!on;
    saveCfg();
    log('info', '', on ? 'Paused' : 'Resumed');
    if (!E.started) { emit(); return; }
    if (on) { clearTimeout(E.timer); E.timer = 0; setState('paused'); rewatch(); }
    else if (E.state === 'paused') begin();
  }
  function syncNow() {
    if (!canTick()) return false;
    E.full = true; E.idle = 0;
    if (E.busy) E.again = true; else { clearTimeout(E.timer); E.timer = 0; kick(0); }
    return true;
  }
  // Stop mirroring: forget the folder and every record (the files stay).
  async function forget() {
    stop();
    var names = Object.keys((E.st && E.st.rooms) || {});
    E.cfg = null; E.st = freshSt(); E.root = null; E.bases.clear();
    try {
      var keys = await idb().keys();
      for (var i = 0; i < keys.length; i++) if (typeof keys[i] === 'string' && keys[i].indexOf('mirror:') === 0 && keys[i] !== K_LOG) await idb().remove(keys[i]);
    } catch (e) { for (var j = 0; j < names.length; j++) { try { await idb().remove(K_BASE + names[j]); } catch (e2) {} } }
    log('info', '', 'Stopped mirroring — the files stay in the folder');
    await flush();
    setState(supported() ? 'setup' : 'unsupported');
  }

  // ---- panel actions -----------------------------------------------------------------
  async function withFiles(fn) {
    if (!E.root || !(await hasPermission(E.root, false))) throw new Error('No access to the folder right now');
    var files = await scan(E.root);
    var owned = {};
    Object.keys(E.st.rooms).forEach(function (n) { owned[E.st.rooms[n].path.toLowerCase()] = n; });
    var ctx = { files: files, owned: owned, sub: !!pv('sub'), front: pv('front'), direction: E.cfg.direction,
      taken: function (low, room) { var o = owned[low]; return o ? o !== room : files.has(low); } };
    var r = await fn(ctx);
    await writeIndexIfChanged(E.root);
    await flush();
    emit();
    return r;
  }
  function importNew(paths) {
    return withFiles(async function (ctx) {
      var list = E.newFiles.filter(function (x) { return !paths || paths.indexOf(x.path) >= 0; });
      var n = await importFiles(list, ctx);
      E.newFiles = E.newFiles.filter(function (x) { return !ctx.owned[x.path.toLowerCase()]; });
      return n;
    });
  }
  function ignoreNew(paths) {
    E.newFiles = E.newFiles.filter(function (x) {
      if (paths && paths.indexOf(x.path) < 0) return true;
      E.st.ignored[x.path.toLowerCase()] = 1;
      return false;
    });
    E.stDirty = true;
    return flush().then(emit);
  }
  function restore(name) {
    return withFiles(async function (ctx) {
      var rec = E.st.rooms[name];
      if (!rec) return false;
      var text = await api().read(name);
      if (text == null) throw new Error('Can’t read the room right now');
      var path = C.planPath(name, { ext: pv('ext'), sub: ctx.sub }, { current: rec.path, wsPath: wsPathFor(name), taken: ctx.taken });
      rec.path = path;
      await putFile(name, rec, text, null, ctx);
      await setBase(name, text);
      log('wrote', name, 'restored ' + path);
      return true;
    });
  }
  async function unmirror(name) {
    if (!E.cfg) return;
    if (E.cfg.exclude.indexOf(name) < 0) E.cfg.exclude.push(name);
    await saveCfg();
    log('info', name, 'stopped mirroring this room');
    await dropRoom(name);
    await flush();
    emit();
  }
  async function dismissConflict(name) {
    var rec = E.st.rooms[name];
    if (!rec || !rec.conflict) return;
    delete rec.conflict;
    E.stDirty = true;
    try { await idb().remove(K_CBASE + name); } catch (e) {}
    await flush();
    emit();
  }
  // Open the merge screen on a conflict: the room as it is now vs the
  // conflict copy, from the base they split at. The result goes to the room
  // (and so to the file, next pass); the copy then moves to .trash.
  async function resolveConflict(name) {
    var rec = E.st.rooms[name];
    if (!rec || !rec.conflict) return false;
    var core = await loadMerge(), ui = await loadScript(MERGE_UI_URL, '__cadeMergeUI');
    var mine = await api().read(name);
    if (mine == null) throw new Error('Can’t read the room right now');
    var copy;
    try { copy = C.normalizeText(await (await (await fileAt(E.root, rec.conflict.path, false)).getFile()).text()); }
    catch (e) { await dismissConflict(name); throw new Error('The conflict copy is gone from the folder'); }
    var base = null;
    try { base = await idb().get(K_CBASE + name); } catch (e) {}
    var res = typeof base === 'string' ? core.merge3(base, mine, copy) : core.merge2(mine, copy);
    var d = await ui.open({ room: name, res: res, core: core, labels: { mine: 'Cade.txt (the room)', theirs: 'Conflict copy in the folder', theirsTime: rec.conflict.path } });
    var text = null;
    if (d.action === 'apply') text = d.text;
    else if (d.action === 'server') text = copy;
    else if (d.action === 'append-down') text = mine + '\n\n' + copy;
    else if (d.action === 'append-up') text = copy + '\n\n' + mine;
    else if (d.action === 'new') { await dismissConflict(name); log('info', name, 'kept both — ' + rec.conflict.path + ' stays'); return true; }
    else if (d.action !== 'local') return false;          // closed
    if (text != null && text !== mine) {
      var r = await writeRoom(name, text, mine);
      if (!r) throw new Error('The room changed meanwhile — try again');
    }
    var cpath = rec.conflict.path;
    await withFiles(async function (ctx) {
      var tp = C.trashPath(cpath, new Date(), function (low) { return ctx.files.has(low); });
      try { await moveFile(E.root, cpath, tp); } catch (e) {}
    });
    await dismissConflict(name);
    log('merged', name, 'conflict resolved — ' + cpath + ' moved to .trash');
    E.dirty.set(name, 0);
    kick(100);
    return true;
  }

  // ---- setup -------------------------------------------------------------------------------
  // The picker itself: must be the first await of a click.
  function pickFolder() {
    return window.showDirectoryPicker({ id: 'cade-folder-mirror', mode: 'readwrite', startIn: 'documents' });
  }
  async function describeFolder(handle) {
    var ok = await hasPermission(handle, true);
    if (!ok) throw new Error('Folder Mirror needs permission to read and write that folder');
    var files = await scan(handle), notes = 0;
    files.forEach(function (f) { if (C.parseFileName(f.name)) notes++; });
    var idx = await readIndex(handle);
    return { name: handle.name, notes: notes, mirrored: !!(idx && Object.keys(idx.rooms).length) };
  }
  // What the first sync will do: draft = { handle, scope, direction } (and
  // the layout prefs already set). → { rows, imports, counts }
  async function preview(draft) {
    await loadMerge().catch(function () {});
    var root = draft.handle, sub = !!pv('sub'), direction = draft.direction || 'both';
    var cfg = { scope: draft.scope, exclude: [] };
    var files = await scan(root), idx = await readIndex(root);
    var owned = {}, rows = [], A = api();
    var taken = function (low, room) { var o = owned[low]; return o ? o !== room : files.has(low); };
    var names = A.list().filter(function (n) { return inScope(n, cfg); });
    // Keep the folder's earlier mapping where its files still exist.
    names.forEach(function (n) {
      var p = idx && idx.rooms[n];
      if (p && files.has(p.toLowerCase()) && !owned[p.toLowerCase()]) owned[p.toLowerCase()] = n;
    });
    var ctx = { files: files, owned: owned };
    for (var i = 0; i < names.length; i++) {
      var n = names[i], path = null, f = null;
      Object.keys(owned).forEach(function (low) { if (owned[low] === n) path = files.get(low).path; });
      if (!path) { f = fileFor(n, ctx); if (f) path = f.path; }
      if (!path) path = C.planPath(n, { ext: pv('ext'), sub: sub }, { wsPath: wsPathFor(n), taken: taken });
      owned[path.toLowerCase()] = n;
      f = files.get(path.toLowerCase()) || null;
      var text = await A.read(n);
      var row = { room: n, path: path, text: text, fileText: null, kind: 'create' };
      if (text == null) { row.kind = 'unreadable'; rows.push(row); continue; }
      if (f) {
        try { row.fileText = await readText(f); } catch (e) { row.kind = 'unreadable'; row.error = errMsg(e); rows.push(row); continue; }
        row.kind = row.fileText === text ? 'same' : 'conflict';
      } else if (direction === 'in') row.kind = 'skip';
      rows.push(row);
    }
    var imports = [];
    if (direction !== 'out') {
      files.forEach(function (f, low) {
        if (owned[low]) return;
        var pf = C.parseFileName(f.name);
        if (pf) imports.push({ path: f.path, room: pf.room, exists: A.list().indexOf(pf.room) >= 0 });
      });
    }
    var counts = { create: 0, same: 0, conflict: 0, skip: 0, unreadable: 0, imports: imports.length };
    rows.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    return { rows: rows, imports: imports, counts: counts };
  }
  // Run the first sync and start: choices = { conflicts: { room: 'both' | 'txt' | 'file' }, imports: { path: true } }
  async function setup(draft, plan, choices) {
    if (!supported()) throw new Error('Not supported here');
    if (!(await hasPermission(draft.handle, true))) throw new Error('No permission for that folder');
    choices = choices || {};
    var cc = choices.conflicts || {}, ci = choices.imports || {};
    stop();
    E.cfg = { v: 1, handle: draft.handle, folderName: draft.handle.name, scope: draft.scope || { mode: 'all' }, direction: draft.direction || 'both', paused: false, exclude: [], at: now() };
    E.root = draft.handle;
    E.st = freshSt();
    E.bases.clear();
    try { await loadMerge(); } catch (e) {}
    var root = E.root, sub = !!pv('sub');
    var files = await scan(root), owned = {};
    var ctx = { files: files, owned: owned, sub: sub, front: pv('front'), direction: E.cfg.direction,
      taken: function (low, room) { var o = owned[low]; return o ? o !== room : files.has(low); } };
    var made = 0, kept = 0, conf = 0, chose = 0, imported = 0;
    var stampD = new Date();
    for (var i = 0; i < plan.rows.length; i++) {
      var r = plan.rows[i];
      if (r.kind === 'skip' || r.kind === 'unreadable') continue;
      try {
        var rec = { path: r.path, mtime: 0, size: 0 }, f = files.get(r.path.toLowerCase()) || null;
        E.st.rooms[r.room] = rec; owned[r.path.toLowerCase()] = r.room;
        var room = await api().read(r.room);
        if (room == null) { delete E.st.rooms[r.room]; continue; }
        var fileText = f ? await readText(f) : null;
        if (fileText == null) { await putFile(r.room, rec, room, null, ctx); await setBase(r.room, room); made++; continue; }
        if (fileText === room) { noteStat(rec, f); await setBase(r.room, room); kept++; continue; }
        var how = cc[r.room] || 'both';
        if (how === 'txt') {
          var tp = C.trashPath(r.path, stampD, function (low) { return files.has(low); });
          await writeFile(root, tp, fileText);
          files.set(tp.toLowerCase(), { path: tp });
          await putFile(r.room, rec, room, f, ctx);
          await setBase(r.room, room);
          chose++;
          log('wrote', r.room, 'used the room’s text for ' + r.path + ' (the old file is in ' + tp + ')');
        } else if (how === 'file') {
          var keep = C.trashPath(C.joinPath(C.splitPath(r.path).dir.concat([(C.splitExt(C.splitPath(r.path).name) || { stem: r.room }).stem + ' (room before mirroring).md'])), stampD, function (low) { return files.has(low); });
          await writeFile(root, keep, room);
          files.set(keep.toLowerCase(), { path: keep });
          var w = await writeRoom(r.room, fileText, room);
          var final = w ? w.text : room;
          if (final !== fileText) await putFile(r.room, rec, final, f, ctx); else noteStat(rec, f);
          await setBase(r.room, final);
          chose++;
          log('read', r.room, r.path + ' → room (the room’s old text is in ' + keep + ')');
        } else {
          await conflict(r.room, rec, { action: 'conflict', keep: 'room', text: room, other: fileText }, { base: null, room: room, file: fileText, f: f }, ctx);
          conf++;
        }
      } catch (e) { log('error', r.room, errMsg(e)); }
    }
    var toImport = [];
    (plan.imports || []).forEach(function (it) {
      if (owned[it.path.toLowerCase()]) return;
      if (ci[it.path]) toImport.push({ path: it.path, room: it.room, dir: C.splitPath(it.path).dir });
      else E.st.ignored[it.path.toLowerCase()] = 1;
    });
    if (toImport.length) imported = await importFiles(toImport, ctx);
    await writeIndexIfChanged(root);
    E.stDirty = true;
    await saveCfg();
    var parts = [];
    if (made) parts.push(made + ' file' + (made === 1 ? '' : 's') + ' created');
    if (kept) parts.push(kept + ' already matched');
    if (chose) parts.push(chose + ' resolved the way you chose');
    if (conf) parts.push(conf + ' kept both versions');
    if (imported) parts.push(imported + ' imported');
    log('info', '', 'Mirroring “' + E.cfg.folderName + '”' + (parts.length ? ' — ' + parts.join(', ') : ''));
    await flush();
    setState('off');
    return status();
  }

  window.__cadeMirrorEngine = {
    supported: supported, load: load, status: status,
    subscribe: function (fn) { E.subs.push(fn); return function () { var i = E.subs.indexOf(fn); if (i >= 0) E.subs.splice(i, 1); }; },
    start: start, stop: stop, reconnect: reconnect, pause: pause, syncNow: syncNow, forget: forget,
    importNew: importNew, ignoreNew: ignoreNew, restore: restore, unmirror: unmirror,
    dismissConflict: dismissConflict, resolveConflict: resolveConflict,
    pickFolder: pickFolder, describeFolder: describeFolder, preview: preview, setup: setup,
    prefs: prefs, pv: pv, pset: pset,
    _E: E,
  };
})();
