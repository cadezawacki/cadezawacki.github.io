/* ═══════════════════════════════════════════════════════════════
   BRIDGE — Cade.txt ↔ Cade.project

   Both apps are served from the same origin, so they share one
   localStorage. txt.html owns the room/workspace model; this file
   projects it into the project app and writes changes back:

     txt workspace  ─→  project (top level)
     txt room       ─→  sub-project        (only rooms holding a todo list)
     "[ ] line"     ─→  task               (completion syncs both ways)

   A room counts as a todo list when it has at least one line matching
   txt's own TODO_LINE_RE. The @todo directive is NOT the trigger — a
   page can be full of checkboxes without ever declaring itself, and
   declaring itself doesn't mean it has any.

   The txt document is authoritative for what EXISTS. This app is
   authoritative for the metadata it adds on top (due dates, priority,
   tracked time). Completion is shared, with the document winning a
   genuine simultaneous-edit tie — it is the thing the user can see.

   Crypto and storage paths mirror txt.html exactly (PBKDF2 over
   'cade.txt-salt', AES-GCM, deflate-raw, the 0xCADE0100 magic) so a
   write from here is indistinguishable from another device's.
   ═══════════════════════════════════════════════════════════════ */

const Bridge = (() => {
  // Same definition txt.html uses to decide a line is a checkbox: optional
  // indent, optional bullet, then [ ] / [x] / [X] and a space.
  const TODO_LINE_RE = /^(\s*(?:[-•*]\s+)?)\[([ xX])\]\s/;

  const WS_KEY = 'cade-workspaces';
  const ROOMS_KEY = 'cade-rooms';
  const ROOM_WS_KEY = 'cade-room-workspace';
  const ROOM_META_KEY = 'cade-room-meta';
  const ROOM_TOMB_KEY = 'cade-room-tomb';
  const WS_TS_KEY = 'cade-workspaces-ts';
  const SYNC_KEY = 'cade-sync-key';
  const FB_URL_KEY = 'cade-firebase-url';
  const CACHE_PREFIX = 'cade-room-cache:';
  const SYNCED_PREFIX = 'cade-room-synced:';
  const PW_HASH_PREFIX = 'cade-room-pw-hash:';

  const WS_BLOB_MAX = 256 * 1024; // matches txt.html — refuse to publish bloat

  let channel = null;
  try { channel = new BroadcastChannel('cade-txt-tabs'); } catch (e) {}
  const TAB_ID = 'project-' + Math.random().toString(36).slice(2, 10);

  let fbApp = null;
  let fbDb = null;
  let scanning = false;
  let lastScanAt = 0;

  // ═══════════════════════════════════════════════════════════
  // RAW STORAGE ACCESS (txt's keys, read directly)
  // ═══════════════════════════════════════════════════════════
  function raw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeRaw(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function json(key, fallback) {
    try {
      const v = raw(key);
      if (!v) return fallback;
      const parsed = JSON.parse(v);
      return parsed == null ? fallback : parsed;
    } catch (e) { return fallback; }
  }

  // txt is "present" once it has written a room list here. Without that the
  // whole bridge stays dormant rather than inventing an empty room model.
  function available() {
    return raw(ROOMS_KEY) != null || raw(WS_KEY) != null;
  }

  function getRooms() {
    const list = json(ROOMS_KEY, []);
    return Array.isArray(list) ? list.filter(r => typeof r === 'string' && r) : [];
  }
  function getWorkspaces() {
    const list = json(WS_KEY, []);
    return Array.isArray(list) ? list.filter(w => w && w.id) : [];
  }
  function getRoomWorkspace() {
    const map = json(ROOM_WS_KEY, {});
    const out = {};
    if (!map || typeof map !== 'object') return out;
    // Tolerates the legacy single-string form, exactly like txt's normalizer.
    Object.keys(map).forEach(room => {
      const v = map[room];
      const ids = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
      const clean = [...new Set(ids.filter(Boolean))];
      if (clean.length) out[room] = clean;
    });
    return out;
  }
  function getRoomMeta() {
    const m = json(ROOM_META_KEY, {});
    return (m && typeof m === 'object') ? m : {};
  }
  function getTombstones() {
    const t = json(ROOM_TOMB_KEY, {});
    return (t && typeof t === 'object') ? t : {};
  }

  // A room is live when it is listed, not archived, and its deletion marker
  // (if any) predates its most recent creation — txt's own liveness rule.
  function roomIsLive(name, meta, tomb) {
    if (meta[name] && meta[name].archived) return false;
    const deletedAt = tomb[name];
    if (typeof deletedAt === 'number') {
      const created = (meta[name] && meta[name].created) || 0;
      if (deletedAt >= created) return false;
    }
    return true;
  }

  function roomIsLocked(name) {
    return raw(PW_HASH_PREFIX + name) != null;
  }

  // The local view of a room. An EXPLICITLY EMPTY cache is a real state —
  // the user cleared the room — so only a missing key falls through to the
  // last-synced copy. Coalescing the two resurrected text that had been
  // deliberately deleted.
  function roomText(name) {
    const cached = raw(CACHE_PREFIX + name);
    if (cached != null) return cached;
    const synced = raw(SYNCED_PREFIX + name);
    return synced != null ? synced : '';
  }

  // True when this device holds room edits Cade.txt has not pushed yet —
  // its cache has moved on from its last-synced base. Such a room must not
  // be rebased onto the server copy: that would discard local typing.
  function roomHasUnpushedEdits(name) {
    const cached = raw(CACHE_PREFIX + name);
    const synced = raw(SYNCED_PREFIX + name);
    if (cached == null || synced == null) return false;
    return cached !== synced;
  }

  // Cade.txt prefixes documents written by a password-locked client.
  const LOCK_SENTINEL = '\x00CADE_LOCK\x00';
  function stripLockSentinel(text) {
    return text.startsWith(LOCK_SENTINEL) ? text.slice(LOCK_SENTINEL.length) : text;
  }

  // Cade.txt splits very large room payloads into { _chunks, parts }.
  function unpackRoomText(val) {
    if (val == null) return null;
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val._chunks && val.parts) {
      let out = '';
      for (let i = 0; i < val._chunks; i++) {
        const part = val.parts[i];
        if (typeof part !== 'string') return null;
        out += part;
      }
      return out;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // TODO PARSING
  // ═══════════════════════════════════════════════════════════
  // Every checkbox line in a document, in order. Lines inside ``` fences are
  // skipped: "[ ]" in a code block is a list literal, not a task — the same
  // exclusion txt applies when it decorates.
  function parseTodos(text) {
    const lines = String(text || '').split('\n');
    const out = [];
    const seen = new Map(); // normalized title -> how many times so far
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = line.match(TODO_LINE_RE);
      if (!m) continue;
      const title = line.slice(m[0].length).trim();
      if (!title) continue; // an empty checkbox is a template, not a task
      const base = normalizeKey(title);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.push({
        line: i,
        done: m[2] !== ' ',
        title,
        prefix: m[1],
        // The first line with a given text keeps the bare key, so links
        // recorded before duplicate handling existed still resolve.
        key: n === 1 ? base : base + DUP_SEP + n,
        occurrence: n,
      });
    }
    return out;
  }

  // Identity of a todo line across scans. Text-based rather than positional:
  // reordering a list, or inserting above it, must not re-key everything.
  // Trailing tags and punctuation are kept — two tasks differing only by
  // "#urgent" are genuinely different lines.
  //
  // A room may legitimately hold the same text twice ("[ ] water plants"
  // in a weekly list). Text alone would collapse those into one task that
  // neither line could tick independently, so repeats carry an occurrence
  // suffix. The separator is a control character no document will contain.
  const DUP_SEP = '\u0000#';
  function normalizeKey(title) {
    return String(title).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function hasTodoList(text) {
    return parseTodos(text).length > 0;
  }

  // Rewrite one checkbox line's state in place, leaving every other byte —
  // indentation, bullet style, trailing notes — untouched.
  function setTodoState(text, lineIndex, done) {
    const lines = String(text || '').split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return null;
    const m = lines[lineIndex].match(TODO_LINE_RE);
    if (!m) return null;
    const mark = done ? 'x' : ' ';
    lines[lineIndex] = m[1] + '[' + mark + ']' + lines[lineIndex].slice(m[1].length + 3);
    return lines.join('\n');
  }

  // Append a new checkbox to a document. Placed directly after the last
  // existing checkbox so it joins the list instead of dangling at the end of
  // an unrelated page; on a page with no list yet, appended to the bottom.
  function appendTodo(text, title) {
    const body = String(text || '');
    const todos = parseTodos(body);
    const lines = body.split('\n');
    const entry = '[ ] ' + String(title).trim();
    if (todos.length) {
      const last = todos[todos.length - 1];
      const bullet = last.prefix.match(/^(\s*)([-•*]\s+)?/);
      const indent = (bullet && bullet[1]) || '';
      const marker = (bullet && bullet[2]) || '';
      lines.splice(last.line + 1, 0, indent + marker + entry);
      return lines.join('\n');
    }
    const sep = body && !body.endsWith('\n') ? '\n' : '';
    return body + sep + entry;
  }

  // ═══════════════════════════════════════════════════════════
  // CRYPTO — byte-for-byte compatible with txt.html
  // ═══════════════════════════════════════════════════════════
  const CRYPT_MAGIC = [0xCA, 0xDE, 0x01, 0x00];
  const keyCache = new Map();

  function deriveKey(password) {
    let p = keyCache.get(password);
    if (p) return p;
    p = (async () => {
      const enc = new TextEncoder();
      const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('cade.txt-salt'), iterations: 100000, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    })();
    p.catch(() => { if (keyCache.get(password) === p) keyCache.delete(password); });
    keyCache.set(password, p);
    return p;
  }

  async function deflate(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes); writer.close();
    const chunks = []; const reader = cs.readable.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    let len = 0; chunks.forEach(c => { len += c.length; });
    const out = new Uint8Array(len); let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return out;
  }

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    const chunks = []; const reader = ds.readable.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    let len = 0; chunks.forEach(c => { len += c.length; });
    const out = new Uint8Array(len); let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return new TextDecoder().decode(out);
  }

  async function encryptText(text, password) {
    const key = await deriveKey(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await deflate(new TextEncoder().encode(text));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const combined = new Uint8Array(CRYPT_MAGIC.length + iv.byteLength + ciphertext.byteLength);
    combined.set(CRYPT_MAGIC, 0);
    combined.set(iv, CRYPT_MAGIC.length);
    combined.set(new Uint8Array(ciphertext), CRYPT_MAGIC.length + iv.byteLength);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < combined.length; i += chunk) {
      binary += String.fromCharCode.apply(null, combined.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function decryptText(encoded, password) {
    try {
      const key = await deriveKey(password);
      const bin = atob(encoded);
      const combined = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) combined[i] = bin.charCodeAt(i);
      const hasMagic = combined.length >= 4 && CRYPT_MAGIC.every((b, i) => combined[i] === b);
      let iv, ciphertext, compressed;
      if (hasMagic) {
        iv = combined.slice(4, 16); ciphertext = combined.slice(16); compressed = true;
      } else if (combined[0] === 0x01) {
        iv = combined.slice(1, 13); ciphertext = combined.slice(13); compressed = true;
      } else {
        iv = combined.slice(0, 12); ciphertext = combined.slice(12); compressed = false;
      }
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return compressed ? await inflate(new Uint8Array(plain)) : new TextDecoder().decode(plain);
    } catch (e) { return null; }
  }

  async function keyFingerprint(key) {
    if (!key) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ws-fp:' + key));
    return Array.from(new Uint8Array(buf)).slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ═══════════════════════════════════════════════════════════
  // FIREBASE (txt's credentials — the bridge never asks for its own)
  // ═══════════════════════════════════════════════════════════
  function creds() {
    return { url: raw(FB_URL_KEY) || '', key: raw(SYNC_KEY) || '' };
  }

  function db() {
    const { url } = creds();
    if (!url || typeof firebase === 'undefined' || !firebase.initializeApp) return null;
    if (fbDb && fbApp && fbApp.options.databaseURL === url) return fbDb;
    try {
      if (fbApp) { try { fbApp.delete(); } catch (e) {} fbApp = null; fbDb = null; }
      fbApp = firebase.initializeApp({ databaseURL: url }, 'cade-bridge-' + Date.now());
      fbDb = firebase.database(fbApp);
      return fbDb;
    } catch (e) { return null; }
  }

  function wsBlobPath(fp) { return `rooms/__cade_ws_${fp}/blob`; }

  // ═══════════════════════════════════════════════════════════
  // WRITING BACK TO A ROOM
  // ═══════════════════════════════════════════════════════════
  // ── Room edits are OPERATIONS, not whole-document writes ──────────────
  //
  // This app's local copy of a room is only as fresh as the last time
  // Cade.txt had that room open here — which can be days ago, or never.
  // Encrypting that copy and setting it as the server's document would
  // delete whatever another device has added since. So every edit is
  // expressed as a small function over the text ("tick this line", "append
  // this one") and applied to the CURRENT server document, fetched first.
  //
  // The exception is a room this device has edited but not yet pushed:
  // rebasing onto the server there would throw away local typing, so the
  // local copy stays the base and Cade.txt's own reconciliation owns the
  // outcome — the same trade it already makes for its own writes.
  // `ok` means "this is a document we can rebase onto". No node on the
  // server is NOT an empty document — it is a room that has never been
  // pushed, and rebasing onto nothing would erase everything the local copy
  // holds. A room genuinely emptied elsewhere stores an encrypted empty
  // string, which decrypts to '' and is a legitimate base.
  async function readRemoteRoom(name, key, database) {
    try {
      const snap = await database.ref(`rooms/${name}/text`).once('value');
      const encoded = unpackRoomText(snap.val());
      if (encoded == null) return { ok: false, text: '' };
      const plain = await decryptText(encoded, key);
      if (plain == null) return { ok: false, text: '' }; // wrong key / corrupt
      return { ok: true, text: stripLockSentinel(plain) };
    } catch (e) {
      return { ok: false, text: '' };
    }
  }

  // `mutate(text) -> string | null`. Returning null means the operation no
  // longer applies to this document (the line is gone) — nothing is written.
  async function applyRoomEdit(name, mutate) {
    const local = roomText(name);
    const locked = roomIsLocked(name);
    const { key } = creds();
    const database = locked ? null : db();

    let base = local;
    let rebased = false;
    if (database && key && !roomHasUnpushedEdits(name)) {
      const remote = await readRemoteRoom(name, key, database);
      if (remote.ok && remote.text !== local) { base = remote.text; rebased = true; }
    }

    let next = mutate(base);
    // The operation didn't apply to the server's version. If it applies to
    // ours the two have genuinely diverged — leave the document alone rather
    // than guessing, and let the next scan re-derive the truth.
    if (next == null) {
      if (!rebased) return { ok: false, reason: 'not-applicable' };
      return { ok: false, reason: 'diverged' };
    }

    writeRaw(CACHE_PREFIX + name, next);
    stampRoomModified(name);
    try {
      if (channel) channel.postMessage({ t: 'doc', room: name, text: next, ts: Date.now(), tab: TAB_ID });
    } catch (e) {}

    if (locked) return { ok: true, remote: false, reason: 'locked' };
    if (!key || !database) return { ok: true, remote: false, reason: 'offline' };
    try {
      const encrypted = await encryptText(next, key);
      await database.ref(`rooms/${name}/text`).set(encrypted);
      database.ref(`rooms/${name}/v`).transaction(c => (c || 0) + 1).catch(() => {});
      return { ok: true, remote: true, rebased };
    } catch (e) {
      console.warn('Bridge: room push failed', e);
      return { ok: true, remote: false, reason: e.message };
    }
  }

  // ── The operations themselves ─────────────────────────────────────────
  // Each locates its line by KEY rather than by a line number captured
  // earlier, because the document it lands on may not be the one that was
  // read when the edit was decided.
  function opSetDone(key, done) {
    return (text) => {
      const todo = parseTodos(text).find(t => t.key === key);
      if (!todo) return null;
      if (todo.done === done) return text; // already agrees — no-op write
      return setTodoState(text, todo.line, done);
    };
  }

  function opSetManyDone(edits) {
    return (text) => {
      let out = text;
      let touched = false;
      edits.forEach(({ key, done }) => {
        const todo = parseTodos(out).find(t => t.key === key);
        if (!todo || todo.done === done) return;
        const next = setTodoState(out, todo.line, done);
        if (next != null) { out = next; touched = true; }
      });
      return touched ? out : null;
    };
  }

  function opRename(oldKey, title) {
    return (text) => {
      const todo = parseTodos(text).find(t => t.key === oldKey);
      if (!todo) return null;
      const lines = text.split('\n');
      const m = lines[todo.line].match(TODO_LINE_RE);
      if (!m) return null;
      lines[todo.line] = m[0] + title;
      return lines.join('\n');
    };
  }

  function opAppend(title) {
    return (text) => {
      const key = normalizeKey(title);
      if (parseTodos(text).some(t => t.key === key)) return null; // already there
      return appendTodo(text, title);
    };
  }

  function stampRoomModified(name) {
    const meta = getRoomMeta();
    meta[name] = meta[name] || {};
    meta[name].modified = Date.now();
    if (!meta[name].created) meta[name].created = Date.now();
    writeRaw(ROOM_META_KEY, JSON.stringify(meta));
  }

  // ═══════════════════════════════════════════════════════════
  // CREATING ROOMS / WORKSPACES FROM THIS APP
  // ═══════════════════════════════════════════════════════════
  // Creating a sub-project here makes the matching room in txt. An existing
  // room is APPENDED TO, never replaced: it keeps its text and simply gains
  // the workspace membership, so pointing a new sub-project at a room full
  // of notes cannot erase them.
  async function ensureRoom(name, workspaceId) {
    const rooms = getRooms();
    const meta = getRoomMeta();
    const tomb = getTombstones();
    const membership = getRoomWorkspace();
    const existed = rooms.includes(name);

    if (!existed) rooms.push(name);
    meta[name] = meta[name] || {};
    // Stamping creation now also resurrects the room if it carries an older
    // deletion marker — txt reads "dead while tombstone >= created".
    meta[name].created = Math.max(Date.now(), (tomb[name] || 0) + 1);
    if (!meta[name].modified) meta[name].modified = meta[name].created;

    if (workspaceId) {
      const ids = membership[name] || [];
      if (!ids.includes(workspaceId)) ids.push(workspaceId);
      membership[name] = ids;
    }

    writeRaw(ROOMS_KEY, JSON.stringify(rooms));
    writeRaw(ROOM_META_KEY, JSON.stringify(meta));
    writeRaw(ROOM_WS_KEY, JSON.stringify(membership));
    if (!existed && raw(CACHE_PREFIX + name) == null) writeRaw(CACHE_PREFIX + name, '');

    notifyRooms();
    await publishWorkspaceBlob();
    return { created: !existed, appended: existed };
  }

  // Creating a top-level project here makes the matching txt workspace.
  async function ensureWorkspace(name, color) {
    const list = getWorkspaces();
    const existing = list.find(w => (w.name || '').toLowerCase() === String(name).toLowerCase());
    if (existing) return existing.id;
    const id = 'ws_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    list.push({
      id, name: String(name),
      color: color || 'teal',
      order: list.length,
      parentId: null,
    });
    writeRaw(WS_KEY, JSON.stringify(list));
    notifyRooms();
    await publishWorkspaceBlob();
    return id;
  }

  async function renameWorkspace(wsId, name) {
    const list = getWorkspaces();
    const ws = list.find(w => w.id === wsId);
    if (!ws || ws.name === name) return false;
    ws.name = String(name);
    writeRaw(WS_KEY, JSON.stringify(list));
    notifyRooms();
    await publishWorkspaceBlob();
    return true;
  }

  function notifyRooms() {
    writeRaw(WS_TS_KEY, String(Date.now()));
    try { if (channel) channel.postMessage({ t: 'rooms', ts: Date.now(), tab: TAB_ID }); } catch (e) {}
  }

  // Publish the shared room/workspace config the way txt does. The remote
  // copy is pulled and merged first — additive for rooms, meta and
  // tombstones — so a write from here can never delete another device's
  // room just because this device hadn't heard about it yet.
  async function publishWorkspaceBlob() {
    const { key } = creds();
    const database = db();
    if (!key || !database) return false;
    try {
      const fp = await keyFingerprint(key);
      const ref = database.ref(wsBlobPath(fp));
      let remote = null;
      try {
        const snap = await ref.once('value');
        const val = snap.val();
        if (typeof val === 'string' && val.length <= WS_BLOB_MAX) {
          const plain = await decryptText(val, key);
          if (plain) remote = JSON.parse(plain);
        }
      } catch (e) { /* unreadable remote — publish local state as-is */ }

      const rooms = getRooms();
      const meta = getRoomMeta();
      const membership = getRoomWorkspace();
      const workspaces = getWorkspaces();
      const tomb = getTombstones();

      if (remote && typeof remote === 'object') {
        (Array.isArray(remote.rooms) ? remote.rooms : []).forEach(r => {
          if (typeof r === 'string' && r && !rooms.includes(r)) rooms.push(r);
        });
        Object.entries(remote.tomb || {}).forEach(([r, ts]) => {
          if (typeof ts === 'number' && ts > (tomb[r] || 0)) tomb[r] = ts;
        });
        Object.entries(remote.roomMeta || {}).forEach(([r, m]) => {
          if (!m || typeof m !== 'object') return;
          const mine = meta[r];
          const stamp = x => Math.max((x && x.modified) || 0, (x && x.created) || 0);
          if (!mine || stamp(m) > stamp(mine)) meta[r] = m;
        });
        (Array.isArray(remote.workspaces) ? remote.workspaces : []).forEach(w => {
          if (w && w.id && !workspaces.find(x => x.id === w.id)) workspaces.push(w);
        });
        Object.entries(remote.roomWorkspace || {}).forEach(([r, ids]) => {
          if (membership[r]) return;
          const arr = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids ? [ids] : []);
          if (arr.length) membership[r] = arr;
        });
      }

      const blob = { ts: Date.now(), workspaces, roomWorkspace: membership, rooms, roomMeta: meta, tomb };
      const encrypted = await encryptText(JSON.stringify(blob), key);
      if (encrypted.length > WS_BLOB_MAX) {
        console.warn('Bridge: workspace blob too large — not published');
        return false;
      }
      await ref.set(encrypted);
      // Keep the merged view locally too, so the next scan sees everything.
      writeRaw(ROOMS_KEY, JSON.stringify(rooms));
      writeRaw(ROOM_META_KEY, JSON.stringify(meta));
      writeRaw(ROOM_WS_KEY, JSON.stringify(membership));
      writeRaw(WS_KEY, JSON.stringify(workspaces));
      writeRaw(ROOM_TOMB_KEY, JSON.stringify(tomb));
      writeRaw(WS_TS_KEY, String(blob.ts));
      return true;
    } catch (e) {
      console.warn('Bridge: workspace blob publish failed', e);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SCAN — project txt's world into this app's data model
  // ═══════════════════════════════════════════════════════════
  // Runs on load, on focus, and whenever txt broadcasts a change. Everything
  // it touches is tagged (project.txtWorkspaceId / project.txtRoom /
  // entry.txtRoom), so hand-made projects and tasks are never disturbed.
  function scan(opts = {}) {
    if (scanning || !available()) return { changed: false };
    scanning = true;
    try {
      return runScan(opts);
    } catch (e) {
      console.error('Bridge scan failed:', e);
      return { changed: false, error: e.message };
    } finally {
      scanning = false;
      lastScanAt = Date.now();
    }
  }

  // Safety net for the one case that can genuinely double things up: this
  // device imports a room, then adopts (or field-merges) a server copy that
  // already contained the same import from another device. The merge unions
  // by id, and the two devices minted different ids for the same room. Fold
  // them back together — oldest wins, everything is moved onto it.
  function dedupeLinks() {
    let changed = false;

    const seenRoom = new Map();
    State.getProjects({ includeArchived: true }).forEach(p => {
      if (!p.txtRoom) return;
      const keep = seenRoom.get(p.txtRoom);
      if (!keep) { seenRoom.set(p.txtRoom, p); return; }
      const [winner, loser] = (keep.createdAt || '') <= (p.createdAt || '') ? [keep, p] : [p, keep];
      seenRoom.set(p.txtRoom, winner);
      State.getEntries({ includeArchived: true }).forEach(e => {
        if (State.entryProjectIds(e).includes(loser.id)) {
          const ids = State.entryProjectIds(e).map(id => (id === loser.id ? winner.id : id));
          State.updateEntry(e.id, {
            projectId: e.projectId === loser.id ? winner.id : e.projectId,
            projectIds: [...new Set(ids)],
          });
        }
      });
      State.deleteProject(loser.id);
      changed = true;
    });

    const seenWs = new Map();
    State.getProjects({ includeArchived: true }).forEach(p => {
      if (!p.txtWorkspaceId) return;
      const keep = seenWs.get(p.txtWorkspaceId);
      if (!keep) { seenWs.set(p.txtWorkspaceId, p); return; }
      const [winner, loser] = (keep.createdAt || '') <= (p.createdAt || '') ? [keep, p] : [p, keep];
      seenWs.set(p.txtWorkspaceId, winner);
      State.getProjects({ includeArchived: true }).forEach(c => {
        if (c.parentId === loser.id) State.updateProject(c.id, { parentId: winner.id });
      });
      State.deleteProject(loser.id);
      changed = true;
    });

    // Same for tasks: one checkbox, one task.
    const seenTask = new Map();
    State.getEntries({ includeArchived: true }).forEach(e => {
      if (!e.txtRoom || !e.txtKey) return;
      const k = e.txtRoom + '\u0000' + e.txtKey;
      const keep = seenTask.get(k);
      if (!keep) { seenTask.set(k, e); return; }
      const [winner, loser] = (keep.createdAt || '') <= (e.createdAt || '') ? [keep, e] : [e, keep];
      seenTask.set(k, winner);
      State.deleteEntry(loser.id);
      changed = true;
    });

    return changed;
  }

  function runScan(opts) {
    const deduped = dedupeLinks();
    const workspaces = getWorkspaces();
    const rooms = getRooms();
    const meta = getRoomMeta();
    const tomb = getTombstones();
    const membership = getRoomWorkspace();
    const today = State.todayStr();

    const stats = { workspaces: 0, rooms: 0, tasks: 0, completed: 0, reopened: 0, retired: 0, changed: deduped };

    // ---- Workspaces → top-level projects --------------------------------
    // getProjects() rebuilds and sorts the whole tree on every call, so the
    // lists are read once here and refreshed only when something is created.
    const wsProjectId = {};
    let allProjects = State.getProjects({ includeArchived: true });
    const reloadProjects = () => { allProjects = State.getProjects({ includeArchived: true }); };
    workspaces.forEach(ws => {
      let proj = allProjects.find(p => p.txtWorkspaceId === ws.id);
      if (!proj) {
        // A hand-made project with the same name adopts the link rather than
        // spawning a duplicate next to itself.
        proj = allProjects.find(p => !p.txtWorkspaceId && !p.parentId &&
          (p.name || '').toLowerCase() === (ws.name || '').toLowerCase());
        if (proj) {
          State.updateProject(proj.id, { txtWorkspaceId: ws.id });
          stats.changed = true;
        }
      }
      if (!proj) {
        proj = State.createProject({
          name: ws.name || 'Workspace',
          txtWorkspaceId: ws.id,
          icon: 'folder',
        });
        reloadProjects();
        stats.workspaces++;
        stats.changed = true;
      } else if (ws.name && proj.name !== ws.name) {
        State.updateProject(proj.id, { name: ws.name });
        stats.changed = true;
      }
      wsProjectId[ws.id] = proj.id;
    });

    // ---- Rooms with todo lists → sub-projects ---------------------------
    const liveRooms = rooms.filter(r => roomIsLive(r, meta, tomb));
    const seenRooms = new Set();

    liveRooms.forEach(name => {
      const text = roomText(name);
      const todos = parseTodos(text);
      const linked = allProjects.find(p => p.txtRoom === name);

      if (!todos.length) {
        // The room has no list (any more) — it was cleared, or its
        // checkboxes were rewritten as prose. The sub-project stays, since
        // it may hold this app's own tasks, but the lines it was mirroring
        // are gone and their projections have to go with them. Retiring runs
        // through the same path a single vanished line takes, so only
        // bridged tasks are touched; anything added here survives.
        if (linked) {
          const cleared = syncRoomTasks(name, linked.id, [], today);
          stats.retired += cleared.retired;
          if (cleared.changed) stats.changed = true;
          if (linked.txtHasList) {
            State.updateProject(linked.id, { txtHasList: false });
            stats.changed = true;
          }
        }
        return;
      }

      seenRooms.add(name);
      const wsIds = membership[name] || [];
      const parentId = wsIds.map(id => wsProjectId[id]).find(Boolean) || null;

      let sub = linked;
      if (!sub) {
        sub = State.createProject({
          name,
          parentId,
          txtRoom: name,
          txtHasList: true,
          icon: 'file-text',
        });
        reloadProjects();
        stats.rooms++;
        stats.changed = true;
      } else {
        const patch = {};
        if (!sub.txtHasList) patch.txtHasList = true;
        // Re-parent when the room moves between workspaces in txt, but never
        // orphan a sub-project whose room has simply been un-filed.
        if (parentId && sub.parentId !== parentId && !State.wouldCycleProject(sub.id, parentId)) {
          patch.parentId = parentId;
        }
        if (Object.keys(patch).length) { State.updateProject(sub.id, patch); stats.changed = true; }
      }

      const result = syncRoomTasks(name, sub.id, todos, today);
      stats.tasks += result.created;
      stats.completed += result.completed;
      stats.reopened += result.reopened;
      stats.retired += result.retired;
      if (result.changed) stats.changed = true;
    });

    // ---- Rooms that disappeared entirely --------------------------------
    // Their tasks are retired (archived, recoverable) rather than deleted:
    // a room can come back, and tracked time attached to those tasks is
    // this app's data, not txt's.
    allProjects.forEach(p => {
      if (!p.txtRoom || seenRooms.has(p.txtRoom)) return;
      if (rooms.includes(p.txtRoom) && roomIsLive(p.txtRoom, meta, tomb)) return;
      State.getEntries({ projectId: p.id }).forEach(e => {
        if (e.txtRoom === p.txtRoom && !e.archived) {
          State.archiveEntry(e.id);
          stats.retired++;
          stats.changed = true;
        }
      });
    });

    return stats;
  }

  // Reconcile one room's checkbox lines against the tasks projecting them.
  function syncRoomTasks(room, projectId, todos, today) {
    const out = { created: 0, completed: 0, reopened: 0, retired: 0, changed: false };
    const existing = State.getEntries({ includeArchived: true })
      .filter(e => e.txtRoom === room);
    const byKey = new Map();
    existing.forEach(e => { if (e.txtKey && !byKey.has(e.txtKey)) byKey.set(e.txtKey, e); });
    const matched = new Set();

    // A line that is ALREADY ticked the first time we see it was finished at
    // some unknown point in the past — stamping it "now" would put every
    // pre-existing checkbox in a room into today's completions and keep
    // long-finished rooms permanently on screen. The room's last-modified
    // stamp is the closest honest answer; with no stamp we record none,
    // which reads as "finished, earlier".
    const meta = getRoomMeta()[room] || {};
    const priorCompletion = meta.modified || meta.created || null;
    const priorIso = priorCompletion ? new Date(priorCompletion).toISOString() : null;

    todos.forEach(todo => {
      let entry = byKey.get(todo.key);
      if (!entry) {
        entry = State.createEntry({
          type: 'task',
          title: todo.title,
          projectId,
          projectIds: [projectId],
          txtRoom: room,
          txtKey: todo.key,
          txtDone: todo.done,
          completed: todo.done,
          completedAt: todo.done ? priorIso : null,
        });
        byKey.set(todo.key, entry);
        out.created++;
        out.changed = true;
      }
      matched.add(todo.key);

      const patch = {};
      if (entry.archived) patch.archived = false;         // the line came back
      if (entry.title !== todo.title) patch.title = todo.title;
      if (entry.projectId !== projectId) {
        patch.projectId = projectId;
        patch.projectIds = [projectId];
      }

      // Completion reconciliation. `txtDone` records what the document said
      // last time we looked, which is what makes it possible to tell WHICH
      // side moved instead of guessing.
      const lastSeen = entry.txtDone;
      const docMoved = lastSeen === undefined || todo.done !== lastSeen;
      const taskMoved = lastSeen !== undefined && entry.completed !== lastSeen;

      if (todo.done !== entry.completed) {
        if (docMoved) {
          // The document changed (and wins an genuine both-moved tie — it is
          // the surface the user was actually looking at).
          patch.completed = todo.done;
          patch.completedAt = todo.done ? new Date().toISOString() : null;
          if (todo.done) out.completed++; else out.reopened++;
        } else if (taskMoved) {
          // Only this app moved — write it through to the document.
          queueDocWrite(room, todo.line, entry.completed);
        }
      }
      if (entry.txtDone !== todo.done) patch.txtDone = todo.done;

      if (Object.keys(patch).length) {
        State.updateEntry(entry.id, patch);
        out.changed = true;
      }
    });

    // Lines that vanished from the document: archive their tasks so nothing
    // this app added on top (time logs, notes) is destroyed by an edit in
    // txt, while they stop cluttering every list.
    existing.forEach(e => {
      if (matched.has(e.txtKey) || e.archived) return;
      State.archiveEntry(e.id);
      out.retired++;
      out.changed = true;
    });

    return out;
  }

  // Doc writes discovered mid-scan are batched: one fetch-modify-write per
  // room instead of one per line.
  let pendingWrites = new Map();
  let writeTimer = null;
  function queueDocWrite(room, key, done) {
    const list = pendingWrites.get(room) || [];
    list.push({ key, done });
    pendingWrites.set(room, list);
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flushDocWrites, 200);
  }

  async function flushDocWrites() {
    writeTimer = null;
    const batch = pendingWrites;
    pendingWrites = new Map();
    for (const [room, edits] of batch) {
      await applyRoomEdit(room, opSetManyDone(edits));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PROJECT → txt (called from the app when the user acts here)
  // ═══════════════════════════════════════════════════════════
  // Toggling a bridged task rewrites its checkbox immediately, matched by
  // text rather than by the line number recorded at scan time — the document
  // may well have been edited since.
  // The link fields are stamped only once the document edit has actually
  // landed. Stamping first and failing leaves the task claiming a line that
  // says something else, and the next scan resolves that in the document's
  // favour — quietly undoing what the user just did.
  async function pushCompletion(entry) {
    if (!entry || !entry.txtRoom || !entry.txtKey) return false;
    const res = await applyRoomEdit(entry.txtRoom, opSetDone(entry.txtKey, entry.completed));
    if (!res.ok) return false;
    State.updateEntry(entry.id, { txtDone: entry.completed });
    return true;
  }

  // Adding a task to a bridged sub-project appends a checkbox to its room.
  async function pushNewTask(entry) {
    if (!entry || entry.type !== 'task') return false;
    const proj = entry.projectId ? State.getProject(entry.projectId) : null;
    if (!proj || !proj.txtRoom) return false;
    const key = keyForNewLine(proj.txtRoom, entry.title);
    const res = await applyRoomEdit(proj.txtRoom, opAppend(entry.title));
    // 'not-applicable' means the line was already in the document, which is
    // just as good a reason to record the link as having written it.
    if (!res.ok && res.reason !== 'not-applicable') return false;
    State.updateEntry(entry.id, { txtRoom: proj.txtRoom, txtKey: key, txtDone: entry.completed });
    return true;
  }

  // Renaming a bridged task rewrites its line and re-keys the link.
  async function pushRename(entry, oldKey) {
    if (!entry || !entry.txtRoom || !oldKey) return false;
    const key = keyForNewLine(entry.txtRoom, entry.title, oldKey);
    const res = await applyRoomEdit(entry.txtRoom, opRename(oldKey, entry.title));
    if (!res.ok) return false;
    State.updateEntry(entry.id, { txtKey: key });
    return true;
  }

  // The key a not-yet-written line will get once it lands in the document:
  // the plain normalized title unless the room already carries that text,
  // in which case it takes the next occurrence slot.
  function keyForNewLine(room, title, ignoreKey) {
    const base = normalizeKey(title);
    const taken = new Set(parseTodos(roomText(room)).map(t => t.key));
    if (ignoreKey) taken.delete(ignoreKey);
    if (!taken.has(base)) return base;
    for (let i = 2; i < 500; i++) {
      const candidate = base + DUP_SEP + i;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  // ═══════════════════════════════════════════════════════════
  // LIVE UPDATES
  // ═══════════════════════════════════════════════════════════
  let onChange = null;
  let rescanTimer = null;

  function requestScan(delay = 300) {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      const result = scan();
      if (result && result.changed && onChange) onChange(result);
    }, delay);
  }

  // `opts.defer` holds the first scan back until the caller says the local
  // dataset is the real one (see Sync's reconcile signal). Live listeners are
  // wired up either way — they debounce, so nothing is lost in the meantime.
  function init(changeHandler, opts = {}) {
    onChange = changeHandler || null;
    // Listeners go on unconditionally. Cade.txt may not have run on this
    // device YET — and the moment it does, in another tab, it writes the
    // very keys these listeners watch. Bailing out here meant the first room
    // a user ever created stayed invisible until they reloaded, which is
    // exactly the case where a live link matters most.

    // txt on this device, in another tab.
    if (channel) {
      channel.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.tab === TAB_ID) return;
        if (msg.t === 'doc') {
          // Adopt the peer's text into the shared cache first — the scan
          // reads from there, and the originating tab owns the server side.
          if (msg.room && msg.room !== '__local__' && typeof msg.text === 'string') {
            writeRaw(CACHE_PREFIX + msg.room, msg.text);
          }
          requestScan(400);
        } else if (msg.t === 'rooms') {
          requestScan(400);
        }
      };
    }

    // txt in another window of the same browser writes localStorage directly.
    window.addEventListener('storage', (e) => {
      if (!e.key) return;
      if (e.key.startsWith(CACHE_PREFIX) || e.key.startsWith(SYNCED_PREFIX) ||
          e.key === ROOMS_KEY || e.key === WS_KEY || e.key === ROOM_WS_KEY ||
          e.key === ROOM_META_KEY || e.key === ROOM_TOMB_KEY) {
        requestScan(500);
      }
    });

    // Coming back to the app after editing in txt.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastScanAt > 5000) requestScan(200);
    });

    if (!opts.defer && available()) requestScan(0);
    return available();
  }

  return {
    init, scan, requestScan, available,
    parseTodos, hasTodoList, setTodoState, appendTodo, normalizeKey,
    roomText, roomHasUnpushedEdits, applyRoomEdit,
    opSetDone, opRename, opAppend,
    ensureRoom, ensureWorkspace, renameWorkspace, publishWorkspaceBlob,
    pushCompletion, pushNewTask, pushRename,
    getRooms, getWorkspaces, getRoomWorkspace, getRoomMeta,
    creds,
    TODO_LINE_RE,
  };
})();
