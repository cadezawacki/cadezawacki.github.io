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

  // Can we PROVE this device's copy of the room matches what the server last
  // confirmed? Only then is it safe to rebase onto the server's document.
  //
  // A missing synced base is not proof of cleanliness — it is the signature
  // of a room typed into offline that has never completed a sync, which is
  // precisely the copy that must not be thrown away. Absence of evidence is
  // treated as divergence.
  function roomCacheIsClean(name) {
    const cached = raw(CACHE_PREFIX + name);
    if (cached == null) return true;   // nothing local to lose
    const synced = raw(SYNCED_PREFIX + name);
    if (synced == null) return false;  // unproven — assume local work
    return cached === synced;
  }

  // Cade.txt prefixes documents written by a password-locked client.
  const LOCK_SENTINEL = '\x00CADE_LOCK\x00';
  function stripLockSentinel(text) {
    return text.startsWith(LOCK_SENTINEL) ? text.slice(LOCK_SENTINEL.length) : text;
  }

  // Cade.txt splits very large room payloads into { _chunks, parts }.
  const FB_CHUNK_SIZE = 8000000;
  function packRoomText(encoded) {
    if (encoded.length <= FB_CHUNK_SIZE) return encoded;
    const n = Math.ceil(encoded.length / FB_CHUNK_SIZE);
    const parts = {};
    for (let i = 0; i < n; i++) parts[i] = encoded.slice(i * FB_CHUNK_SIZE, (i + 1) * FB_CHUNK_SIZE);
    return { _chunks: n, parts };
  }

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
      // Strike marks are Cade.txt's rendering of a ticked box, not part of
      // what the task is called — a title carrying them would show up here as
      // s̶t̶r̶u̶c̶k̶ ̶t̶e̶x̶t̶ and would stop matching its own line the moment it was
      // un-ticked over there.
      const title = unstrike(line.slice(m[0].length)).trim();
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
  // Cade.txt's own toggle draws its strike-through by interleaving U+0336
  // combining strokes into the line text, and strips them again when the box
  // is un-ticked. Those are decoration, not content: keeping them in the key
  // meant ticking a task in txt gave it a new identity, so the bridge saw the
  // old line disappear and a struck-through one arrive, and forked the task
  // in two. Stripped from keys AND titles, so neither carries them.
  const STRIKE_MARKS = /[\u0335\u0336]/g;
  function unstrike(text) {
    return String(text == null ? '' : text).replace(STRIKE_MARKS, '');
  }

  function normalizeKey(title) {
    return unstrike(title).trim().replace(/\s+/g, ' ').toLowerCase();
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
  // Cade.txt's own credentials when it has been set up in this browser.
  //
  // When it has NOT, fall back to the ones the user gave Cade.project. The
  // two apps share one database and, in every real setup, one passphrase —
  // and without a fallback a browser that only ever ran Cade.project could
  // not reach the shared room config at all, which is precisely the second
  // browser where the link looked broken. This only ever READS Cade.txt's
  // keys; it never writes them, so txt's own configuration is untouched.
  function creds() {
    const url = raw(FB_URL_KEY) || '';
    const key = raw(SYNC_KEY) || '';
    if (url && key) return { url, key, from: 'txt' };
    try {
      const s = (State.getSettings() || {}).sync || {};
      // `paused` means a local reset deliberately cut this device off.
      if (s.databaseUrl && s.passphrase && !s.paused) {
        return { url: s.databaseUrl, key: s.passphrase, from: 'project' };
      }
    } catch (e) { /* State not ready — fall through */ }
    return { url, key, from: 'none' };
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
      const packed = snap.val();
      const encoded = unpackRoomText(packed);
      // No node at all — nothing to rebase onto, and nothing to overwrite.
      if (encoded == null) return { ok: false, text: '', packed: packed == null ? null : undefined };
      const plain = await decryptText(encoded, key);
      // A document we cannot read is one we must not replace: it belongs to
      // a key we do not hold (a room locked elsewhere) or it is damaged.
      if (plain == null) return { ok: false, text: '', packed, undecryptable: true };
      return { ok: true, text: stripLockSentinel(plain), packed };
    } catch (e) {
      return { ok: false, text: '', unreachable: true };
    }
  }

  // Is the server still holding exactly what we based our edit on? Compares
  // through the chunked representation so a re-chunked but identical payload
  // does not read as someone else's write.
  function samePacked(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    const ua = unpackRoomText(a);
    const ub = unpackRoomText(b);
    return ua != null && ua === ub;
  }

  // A room can be locked on ANOTHER device, leaving no local password hash
  // here. Its document is encrypted with a key derived from a password we do
  // not hold, so writing base-key ciphertext over it would leave Cade.txt
  // unable to decrypt its own room.
  async function remoteRoomLocked(name, database) {
    try {
      const snap = await database.ref(`rooms/${name}/locked`).once('value');
      return snap.val() === true;
    } catch (e) {
      return false; // unreachable — the write below will fail on its own
    }
  }

  // `mutate(text) -> string | null`. Returning null means the operation no
  // longer applies to this document (the line is gone) — nothing is written.
  //
  // The server write is a compare-and-set, not a plain set. Fetching first
  // narrows the window but does not close it: two devices ticking different
  // boxes can read the same document and then each write a whole new one,
  // and the loser's change vanishes. The write commits only while the server
  // still holds what we based on; otherwise we re-read and re-apply, which a
  // line-scoped operation can do without losing meaning.
  const EDIT_ATTEMPTS = 3;

  async function applyRoomEdit(name, mutate) {
    const { key } = creds();
    const database = db();

    // Locked rooms use a key derived from a room password. Locally flagged
    // is the easy case — the edit stays on this device and Cade.txt pushes
    // it. Locked on another device leaves no local flag, so ask the server.
    const lockedHere = roomIsLocked(name);
    if (!lockedHere && database && await remoteRoomLocked(name, database)) {
      return { ok: false, reason: 'locked-remotely' };
    }

    // Everything is decided against the ORIGINAL local state; retries must
    // not read back the cache we are about to write, or the second attempt
    // would see its own edit as unsynced local work and defer.
    const local = roomText(name);
    const cacheClean = roomCacheIsClean(name);
    const canReachServer = !lockedHere && !!(database && key);

    let next = null;
    let baseUsed = null;
    let rebased = false;
    // 'contended' doubles as "keep going". The body always runs at least once
    // — the local edit has to be computed even with no server to talk to.
    let outcome = 'contended';

    for (let attempt = 0; attempt < EDIT_ATTEMPTS && outcome === 'contended'; attempt++) {
      // Each attempt starts from a clean verdict — carrying the previous
      // round's outcome forward would make the retry bail out before it
      // could commit, which defeats the whole point of retrying.
      let base = local;
      let stop = null;
      rebased = false;
      let expectedPacked;
      baseUsed = base;

      if (canReachServer) {
        const remote = await readRemoteRoom(name, key, database);
        if (remote.unreachable) stop = 'unreachable';
        else if (remote.undecryptable) stop = 'unreadable-remote';
        else {
          expectedPacked = remote.packed;
          if (remote.ok && remote.text !== local) {
            if (cacheClean) { base = remote.text; baseUsed = base; rebased = true; }
            // Both sides moved. Resolving that is a text merge, and Cade.txt
            // already owns one — it reconciles properly the next time it
            // opens this room. The edit still lands locally; what we refuse
            // to do is publish a whole document over a genuinely newer one.
            else stop = 'deferred';
          }
        }
      }

      next = mutate(base);
      // The operation didn't apply to the document we based on. If we
      // rebased, the two versions have diverged past what a line-scoped edit
      // can bridge — leave it alone; the next scan re-derives the truth.
      if (next == null) return { ok: false, reason: rebased ? 'diverged' : 'not-applicable' };

      if (lockedHere) { outcome = 'locked'; break; }
      if (!canReachServer) { outcome = 'offline'; break; }
      if (stop) { outcome = stop; break; }

      const cipher = packRoomText(await encryptText(next, key));
      try {
        const res = await database.ref(`rooms/${name}/text`).transaction(cur =>
          samePacked(cur, expectedPacked) ? cipher : undefined); // undefined = abort
        // Not committed means someone wrote between our read and our write;
        // the loop condition sends us round again, onto their version.
        outcome = (res && res.committed) ? 'committed' : 'contended';
      } catch (e) {
        console.warn('Bridge: room push failed', e);
        outcome = e.message || 'push-failed';
        break;
      }
    }

    // The cache is what scans read, so a write that does not land means the
    // next scan reverses this edit. Report failure rather than let the caller
    // stamp a link against a document that never changed.
    if (!writeRaw(CACHE_PREFIX + name, next)) {
      return { ok: false, reason: 'local-write-failed' };
    }
    stampRoomModified(name);
    try {
      if (channel) channel.postMessage({ t: 'doc', room: name, text: next, ts: Date.now(), tab: TAB_ID });
    } catch (e) {}

    if (outcome === 'committed') {
      // Confirmed on the server, so this text IS the synced base now. Without
      // recording it the room looks permanently unsynced, and every later
      // edit takes the defer path and is never published again.
      writeRaw(SYNCED_PREFIX + name, next);
      database.ref(`rooms/${name}/v`).transaction(c => (c || 0) + 1).catch(() => {});
      return { ok: true, remote: true, rebased, before: baseUsed, after: next };
    }
    return { ok: true, remote: false, reason: outcome || 'offline', before: baseUsed, after: next };
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

  // `out.key` reports the key of the line the operation settled on, read back
  // from the document as written. Predicting it beforehand is wrong: the
  // document these run against may be the server's, whose occurrence counts
  // need not match ours.
  function opRename(oldKey, title, out) {
    return (text) => {
      const todo = parseTodos(text).find(t => t.key === oldKey);
      if (!todo) return null;
      const lines = text.split('\n');
      const m = lines[todo.line].match(TODO_LINE_RE);
      if (!m) return null;
      lines[todo.line] = m[0] + title;
      const next = lines.join('\n');
      const at = parseTodos(next).find(t => t.line === todo.line);
      if (out) out.key = at ? at.key : normalizeKey(title);
      return next;
    };
  }

  // Append a checkbox for a task — unless the room already holds a line with
  // this text that no other task has claimed, in which case the task simply
  // adopts it. A second task deliberately given an existing title DOES get
  // its own line; refusing to write one and then linking to the first line
  // left the new task pointing at a checkbox that was never added, and the
  // next scan archived it as vanished.
  function opAppendForTask(title, claimedKeys, out, done) {
    const base = normalizeKey(title);
    const mine = (t) => t.key === base || t.key.indexOf(base + DUP_SEP) === 0;
    return (text) => {
      const free = parseTodos(text).find(t => mine(t) && !claimedKeys.has(t.key));
      if (free) { if (out) out.key = free.key; return null; } // adopt, nothing to write
      let next = appendTodo(text, title);
      const added = parseTodos(next).filter(mine);
      const line = added.length ? added[added.length - 1] : null;
      if (out) out.key = line ? line.key : base;
      // A task that is ALREADY done has to arrive ticked. Writing "[ ]" and
      // recording the link as done makes the next scan read the document as
      // having reopened it, and the completion is silently undone.
      if (done && line) {
        const ticked = setTodoState(next, line.line, true);
        if (ticked != null) next = ticked;
      }
      return next;
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
  // `publish` false makes this a pure PULL: read the shared config, merge it
  // into what this device holds, and stop. That is what a browser where
  // Cade.txt has never run needs — it has no rooms of its own to contribute
  // and must not overwrite the server with its emptiness, but it still has to
  // learn the room list before anything else in the bridge can work.
  async function syncWorkspaceBlob({ publish = true } = {}) {
    const { key } = creds();
    const database = db();
    if (!key || !database) return { ok: false, contributed: false };
    try {
      const fp = await keyFingerprint(key);
      const ref = database.ref(wsBlobPath(fp));
      let remote = null;
      let remoteTs = 0;
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

      // What the server already knows, captured before the merge folds the
      // two sides together and the distinction is lost.
      const knownRooms = new Set(
        (remote && Array.isArray(remote.rooms)) ? remote.rooms.filter(r => typeof r === 'string') : []);
      const knownWorkspaces = new Set(
        (remote && Array.isArray(remote.workspaces)) ? remote.workspaces.filter(w => w && w.id).map(w => w.id) : []);

      if (remote && typeof remote === 'object') {
        remoteTs = Number(remote.ts) || 0;
        (Array.isArray(remote.rooms) ? remote.rooms : []).forEach(r => {
          if (typeof r === 'string' && r && !rooms.includes(r)) rooms.push(r);
        });
        Object.entries(remote.tomb || {}).forEach(([r, ts]) => {
          if (typeof ts === 'number' && ts > (tomb[r] || 0)) tomb[r] = ts;
        });
        // Room metadata, resolved the way Cade.txt resolves it: the entry as
        // a whole goes to the fresher stamp, but `pinned` and `archived` are
        // each decided by their OWN change stamp. Typing in a room bumps
        // `modified`, so without that split a stale local entry could win on
        // recency alone and write its old pin or archive flag back over a
        // newer one made elsewhere.
        const stampOf = x => Math.max((x && x.modified) || 0, (x && x.created) || 0);
        const pinTsOf = x => (x && (x.pinTs || x.flagsTs)) || 0;
        const archTsOf = x => (x && (x.archTs || x.flagsTs)) || 0;
        Object.entries(remote.roomMeta || {}).forEach(([r, m]) => {
          if (!m || typeof m !== 'object') return;
          const mine = meta[r];
          if (!mine) { meta[r] = m; return; }
          const winner = stampOf(m) > stampOf(mine) ? m : mine;
          const merged = { ...winner };
          const pinFrom = pinTsOf(m) > pinTsOf(mine) ? m : mine;
          const archFrom = archTsOf(m) > archTsOf(mine) ? m : mine;
          merged.pinned = !!pinFrom.pinned;
          merged.archived = !!archFrom.archived;
          if (pinTsOf(pinFrom)) merged.pinTs = pinTsOf(pinFrom);
          if (archTsOf(archFrom)) merged.archTs = archTsOf(archFrom);
          // Creation is monotonic: the earliest known stamp is the real one,
          // except that re-creating a room deliberately bumps it past its
          // tombstone — so take the LATER, matching txt's resurrection rule.
          merged.created = Math.max(m.created || 0, mine.created || 0) || undefined;
          merged.modified = Math.max(m.modified || 0, mine.modified || 0) || undefined;
          meta[r] = merged;
        });
        // Workspace definitions: unknown ones are adopted; for ids we both
        // know, the fresher blob wins. Only adding the missing ones meant a
        // rename made elsewhere was ignored here and then republished with
        // this device's stale name, silently reverting it.
        const localTs = parseInt(raw(WS_TS_KEY) || '0', 10);
        const remoteNewer = (remote.ts || 0) > localTs;
        (Array.isArray(remote.workspaces) ? remote.workspaces : []).forEach(w => {
          if (!w || !w.id) return;
          const idx = workspaces.findIndex(x => x.id === w.id);
          if (idx === -1) workspaces.push(w);
          else if (remoteNewer) workspaces[idx] = w;
        });

        // Membership is many-to-many, so the two sides UNION. Skipping a
        // room because we happened to have some entry for it dropped every
        // workspace assigned on another device — and then published that
        // truncated map as the new truth.
        Object.entries(remote.roomWorkspace || {}).forEach(([r, ids]) => {
          const arr = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids ? [ids] : []);
          if (!arr.length) return;
          membership[r] = [...new Set([...(membership[r] || []), ...arr])];
        });
      }

      // Does this device know rooms or workspaces the shared config does not?
      // If so a pull alone leaves them stranded here, invisible to every
      // other browser — which is what "it only works in one window" was.
      const contributed = rooms.some(r => !knownRooms.has(r)) ||
        workspaces.some(w => w && w.id && !knownWorkspaces.has(w.id));

      const blob = { ts: Date.now(), workspaces, roomWorkspace: membership, rooms, roomMeta: meta, tomb };
      if (publish) {
        const encrypted = await encryptText(JSON.stringify(blob), key);
        if (encrypted.length > WS_BLOB_MAX) {
          console.warn('Bridge: workspace blob too large — not published');
          return { ok: false, contributed };
        }
        await ref.set(encrypted);
      }
      // Keep the merged view locally either way, so the next scan sees
      // everything the shared config knows about.
      writeRaw(ROOMS_KEY, JSON.stringify(rooms));
      writeRaw(ROOM_META_KEY, JSON.stringify(meta));
      writeRaw(ROOM_WS_KEY, JSON.stringify(membership));
      writeRaw(WS_KEY, JSON.stringify(workspaces));
      writeRaw(ROOM_TOMB_KEY, JSON.stringify(tomb));
      // A pull must not claim this device's view is newer than the blob it
      // just read, or the next publish would push these values back over a
      // fresher name from elsewhere.
      writeRaw(WS_TS_KEY, String(publish ? blob.ts : Math.max(remoteTs, parseInt(raw(WS_TS_KEY) || '0', 10))));
      return { ok: true, contributed };
    } catch (e) {
      console.warn('Bridge: workspace blob ' + (publish ? 'publish' : 'pull') + ' failed', e);
      return { ok: false, contributed: false };
    }
  }

  const publishWorkspaceBlob = () => syncWorkspaceBlob({ publish: true });
  const pullWorkspaceBlob = () => syncWorkspaceBlob({ publish: false });

  // Archive (or restore) rooms in the shared config, the way Cade.txt marks
  // them: a flag plus its own change stamp, so the flag is resolved on its
  // own recency rather than losing to an unrelated edit elsewhere. Called
  // when a project is archived here, so its rooms go quiet in txt too.
  async function archiveRooms(names, archived = true) {
    const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
    if (!list.length) return false;
    const meta = getRoomMeta();
    const now = Date.now();
    let touched = false;
    list.forEach(name => {
      const m = meta[name] || (meta[name] = {});
      if (!!m.archived === !!archived) return;
      m.archived = !!archived;
      m.archTs = now;
      touched = true;
    });
    if (!touched) return false;
    writeRaw(ROOM_META_KEY, JSON.stringify(meta));
    notifyRooms();
    const res = await publishWorkspaceBlob();
    return !!(res && res.ok);
  }

  // ═══════════════════════════════════════════════════════════
  // HYDRATION — fetch rooms this device has never opened
  //
  // Cade.txt only caches a room's text once you visit it, so a device that
  // has ten rooms but has only ever opened two holds text for two. The scan
  // reads local text, so without this the other eight would never be seen to
  // contain a todo list and would silently never appear here — the link
  // would look broken for exactly the rooms you set up on another device.
  //
  // A fetched document IS the server's confirmed copy, so it is recorded as
  // both the cache and the synced base — which keeps roomCacheIsClean() true
  // and leaves the room publishable rather than permanently deferring.
  // ═══════════════════════════════════════════════════════════
  const HYDRATE_PER_PASS = 25;            // a burst cap; later passes take the rest
  const HYDRATE_RETRY_MS = 60 * 1000;     // don't re-ask for the same room constantly
  const HYDRATE_MAX_BACKOFF = 6;          // 60s doubled six times ≈ an hour
  const hydrateState = new Map();         // room -> { at, misses }

  // Rooms this device holds no text for. Reported without the retry cooldown,
  // because this is also what the Cade.txt Link panel shows the user.
  function roomsNeedingText() {
    const meta = getRoomMeta();
    const tomb = getTombstones();
    return getRooms().filter(name =>
      roomIsLive(name, meta, tomb) &&
      !roomIsLocked(name) &&               // encrypted with a key we lack
      raw(CACHE_PREFIX + name) == null &&
      raw(SYNCED_PREFIX + name) == null);
  }

  // A room that keeps coming back empty waits longer each time rather than
  // being re-asked every minute for the life of the tab.
  function hydrateCooldown(misses) {
    return HYDRATE_RETRY_MS * Math.pow(2, Math.min(misses, HYDRATE_MAX_BACKOFF));
  }

  // A room with no document on the server yet is not a permanent no: another
  // device may create it a minute from now. So the guard is a cooldown, not a
  // blacklist — and an explicit Rescan skips it entirely.
  //
  // `fetched` is a caller's ONLY licence to come back for another pass.
  // `pending` counts rooms still without text, which is what the Cade.txt Link
  // panel shows — but it is NOT a loop condition: a room with no document on
  // the server keeps it above zero for good, so chaining on it never ends.
  async function hydrateMissingRooms({ force = false } = {}) {
    const { url, key } = creds();
    const outstanding = () => roomsNeedingText().length;
    const nothing = (reason) => ({
      fetched: 0, pending: outstanding(), tried: 0,
      missing: 0, unreadable: 0, unreachable: 0, storageFull: false, reason,
    });
    if (!url || !key) return nothing('no-credentials');
    const database = db();
    if (!database) return nothing('no-database');

    const now = Date.now();
    const todo = roomsNeedingText()
      .filter(name => {
        if (force) return true;
        const st = hydrateState.get(name);
        return !st || now - st.at > hydrateCooldown(st.misses);
      })
      .slice(0, HYDRATE_PER_PASS);

    let fetched = 0, missing = 0, unreadable = 0, unreachable = 0, storageFull = false;
    for (const name of todo) {
      const misses = (hydrateState.get(name) || {}).misses || 0;
      const remote = await readRemoteRoom(name, key, database);
      if (!remote.ok) {                    // no document, unreachable, or not ours
        if (remote.unreachable) unreachable++;
        else if (remote.undecryptable) unreadable++;
        else missing++;
        hydrateState.set(name, { at: Date.now(), misses: misses + 1 });
        continue;
      }
      if (!writeRaw(CACHE_PREFIX + name, remote.text)) { storageFull = true; break; }
      // Straight from the server, so it IS the confirmed base — recording it
      // keeps the room publishable instead of looking permanently unsynced.
      writeRaw(SYNCED_PREFIX + name, remote.text);
      hydrateState.delete(name);
      fetched++;
    }
    return {
      fetched, pending: outstanding(), tried: todo.length,
      missing, unreadable, unreachable, storageFull, reason: '',
    };
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
      // Children nested under the loser have to follow it, or deleteProject
      // re-roots them to the top level — out of the room they belong to.
      State.getProjects({ includeArchived: true }).forEach(c => {
        if (c.parentId === loser.id) State.updateProject(c.id, { parentId: winner.id });
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
      // Entries filed DIRECTLY on the losing workspace need moving too.
      // deleteProject only clears the legacy `projectId`, so a dead id left
      // in `projectIds` matches neither the survivor nor Unfiled and the
      // entry drops out of navigation entirely.
      remapProject(loser.id, winner.id);
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
      seenTask.set(k, mergeDuplicateTask(winner, loser));
      changed = true;
    });

    return changed;
  }

  // Move every membership from one project onto another.
  function remapProject(fromId, toId) {
    State.getEntries({ includeArchived: true }).forEach(e => {
      const ids = State.entryProjectIds(e);
      if (!ids.includes(fromId)) return;
      State.updateEntry(e.id, {
        projectId: e.projectId === fromId ? toId : e.projectId,
        projectIds: [...new Set(ids.map(id => (id === fromId ? toId : id)))],
      });
    });
  }

  // Fold a duplicate task into the one being kept. Both are the same checkbox
  // imported twice, but each may have accumulated work only this app knows
  // about — a description, a due date, tracked time. Deleting the loser
  // outright would throw that away and leave its time sessions pointing at an
  // id nothing references, which is the opposite of what de-duplication here
  // is for.
  function mergeDuplicateTask(winner, loser) {
    const patch = {};
    const takeIfEmpty = (field) => {
      const w = winner[field], l = loser[field];
      if ((w == null || w === '') && l != null && l !== '') patch[field] = l;
    };
    ['description', 'dueDate', 'scheduledDate', 'estimateMinutes', 'actualMinutes',
     'remindTime', 'recurrence', 'emotion', 'color', 'icon'].forEach(takeIfEmpty);

    if ((loser.tags || []).length) {
      patch.tags = [...new Set([...(winner.tags || []), ...loser.tags])];
    }
    if ((loser.blockedBy || []).length) {
      patch.blockedBy = [...new Set([...(winner.blockedBy || []), ...loser.blockedBy])];
    }
    const ids = [...new Set([...State.entryProjectIds(winner), ...State.entryProjectIds(loser)])];
    if (ids.length > State.entryProjectIds(winner).length) patch.projectIds = ids;
    // Priority and effort default to 'medium'; a non-default on the loser is
    // a deliberate choice worth keeping when the winner never made one.
    if (winner.priority === 'medium' && loser.priority && loser.priority !== 'medium') patch.priority = loser.priority;
    if (winner.effort === 'medium' && loser.effort && loser.effort !== 'medium') patch.effort = loser.effort;

    if (Object.keys(patch).length) State.updateEntry(winner.id, patch);

    // Logs reference entries by id — retarget them before the id disappears.
    State.getLogs().forEach(l => {
      if (l.entryId === loser.id) State.updateLog(l.id, { entryId: winner.id });
    });
    // And anything blocked BY the loser now waits on the survivor.
    State.getEntries({ includeArchived: true }).forEach(e => {
      if ((e.blockedBy || []).includes(loser.id)) {
        State.updateEntry(e.id, {
          blockedBy: [...new Set(e.blockedBy.map(id => (id === loser.id ? winner.id : id)))],
        });
      }
    });

    State.deleteEntry(loser.id);
    return State.getEntry(winner.id) || winner;
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
      // The room's sub-project must be among the task's memberships, but the
      // rest of them belong to this app — a task deliberately filed into two
      // projects, with another one primary, keeps that arrangement. Only a
      // task that has drifted out of the linked project entirely gets it
      // back, and only as an addition.
      const memberships = State.entryProjectIds(entry);
      if (!memberships.includes(projectId)) {
        patch.projectIds = [...memberships, projectId];
        if (!entry.projectId) patch.projectId = projectId;
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
          queueDocWrite(room, todo.key, entry.completed);
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
    // Any membership will do, not just the primary: a task filed into a
    // linked room as a secondary project still belongs in that room's list.
    const proj = State.entryProjectIds(entry)
      .map(id => State.getProject(id))
      .find(p => p && p.txtRoom);
    if (!proj) return false;
    const out = {};
    const res = await applyRoomEdit(proj.txtRoom,
      opAppendForTask(entry.title, claimedKeys(proj.txtRoom, entry.id), out, !!entry.completed));
    // 'not-applicable' means the task adopted a line already in the document,
    // which is just as good a reason to record the link as having written it.
    if (!res.ok && res.reason !== 'not-applicable') return false;
    if (!out.key) return false;
    State.updateEntry(entry.id, { txtRoom: proj.txtRoom, txtKey: out.key, txtDone: entry.completed });
    return true;
  }

  // Renaming a bridged task rewrites its line and re-keys the link.
  async function pushRename(entry, oldKey) {
    if (!entry || !entry.txtRoom || !oldKey) return false;
    const out = {};
    const res = await applyRoomEdit(entry.txtRoom, opRename(oldKey, entry.title, out));
    if (!res.ok || !out.key) return false;
    // Renaming a line ONTO a title another line already uses renumbers the
    // occurrence suffixes, so other tasks in this room can be left holding
    // keys that no longer point at their line. Realign every one of them
    // against the document as written, not just the one that was renamed.
    rekeyRoomTasks(entry.txtRoom, res.before, res.after, entry.id, out.key);
    return true;
  }

  // Lines keep their positions through a rename — only their text changes —
  // so the before/after documents line up index for index, which is what
  // makes the shifted keys recoverable.
  function rekeyRoomTasks(room, before, after, renamedId, renamedKey) {
    const setKey = (id, key) => State.updateEntry(id, { txtKey: key });
    const beforeTodos = parseTodos(before || '');
    const afterTodos = parseTodos(after || '');
    if (beforeTodos.length !== afterTodos.length) {
      if (renamedId && renamedKey) setKey(renamedId, renamedKey);
      return;
    }
    const owners = new Map();
    State.getEntries({ includeArchived: true }).forEach(e => {
      if (e.txtRoom === room && e.txtKey && !owners.has(e.txtKey)) owners.set(e.txtKey, e);
    });
    beforeTodos.forEach((was, i) => {
      const now = afterTodos[i];
      if (!now || now.key === was.key) return;
      const owner = owners.get(was.key);
      if (owner) setKey(owner.id, now.key);
    });
    // The renamed entry may not have been in the map (a fresh link), so make
    // sure it ends up on the key the document actually gave its line.
    if (renamedId && renamedKey) {
      const cur = State.getEntry(renamedId);
      if (cur && cur.txtKey !== renamedKey) setKey(renamedId, renamedKey);
    }
  }

  // Keys in this room already spoken for by some other task.
  function claimedKeys(room, exceptEntryId) {
    return new Set(State.getEntries({ includeArchived: true })
      .filter(e => e.txtRoom === room && e.txtKey && e.id !== exceptEntryId)
      .map(e => e.txtKey));
  }

  // ═══════════════════════════════════════════════════════════
  // LIVE UPDATES
  // ═══════════════════════════════════════════════════════════
  let onChange = null;
  let rescanTimer = null;
  let chainedPasses = 0;
  const HYDRATE_MAX_PASSES = 40;          // 40 × 25 = 1000 rooms, then stop chaining

  // Read the shared room/workspace config before the first scan of a session.
  // Without this the bridge only ever knew what Cade.txt had written into
  // THIS browser's storage, so a second browser — where txt has not run, or
  // has not caught up — saw no rooms at all and stayed dormant for good. The
  // room list is shared state; it has to come off the server, not off disk.
  let pulledConfigThisSession = false;

  async function refreshSharedConfig() {
    if (pulledConfigThisSession) return false;
    const { url, key } = creds();
    if (!url || !key) return false;
    pulledConfigThisSession = true;
    try {
      const pulled = await pullWorkspaceBlob();
      // Rooms this device holds that the shared config has never seen — from
      // a Cade.txt that has not synced here yet, or rooms this app created
      // offline. Publishing is additive and merge-safe, so contributing them
      // costs nothing and is the only way another browser learns they exist.
      if (pulled && pulled.contributed) await publishWorkspaceBlob();
      return !!(pulled && pulled.ok);
    } catch (e) {
      console.warn('Bridge: shared config sync failed', e);
      return false;
    }
  }

  function requestScan(delay = 300) {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(async () => {
      // The room list first, then the text of rooms this device has never
      // held, and only then the scan — each step feeds the next.
      const pulledConfig = await refreshSharedConfig();
      let hydrated = { fetched: 0, pending: 0 };
      try { hydrated = await hydrateMissingRooms(); } catch (e) { console.warn('Bridge: hydrate failed', e); }
      const result = scan();
      if (result && pulledConfig) result.changed = true;
      if (result && hydrated.fetched) { result.changed = true; result.hydrated = hydrated.fetched; }
      if (result && result.changed && onChange) onChange(result);
      // More rooms than one pass allows — come back for the rest, but only
      // while a pass is actually pulling rooms down. Chaining on `pending`
      // alone never terminates: rooms with no document on the server keep it
      // above zero for good. The pass ceiling covers the other stall, where a
      // write reports success and does not survive to the next read.
      if (hydrated.fetched > 0 && hydrated.pending > 0 && ++chainedPasses < HYDRATE_MAX_PASSES) requestScan(600);
      else chainedPasses = 0;
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

    // A browser where Cade.txt has never run has no local room list, so
    // available() is false — but it may still hold credentials that can reach
    // the shared config. Scanning on credentials alone is what lets a second
    // browser discover the rooms at all; without it the bridge sat dormant
    // there permanently, which read as "sync works in one window only".
    const { url, key } = creds();
    if (!opts.defer && (available() || (url && key))) requestScan(0);
    return available();
  }

  return {
    init, scan, requestScan, available,
    pullWorkspaceBlob, archiveRooms,
    hydrateMissingRooms, roomsNeedingText,
    parseTodos, hasTodoList, setTodoState, appendTodo, normalizeKey,
    roomText, roomCacheIsClean, applyRoomEdit,
    opSetDone, opRename, opAppendForTask, claimedKeys,
    ensureRoom, ensureWorkspace, renameWorkspace, publishWorkspaceBlob,
    pushCompletion, pushNewTask, pushRename,
    getRooms, getWorkspaces, getRoomWorkspace, getRoomMeta,
    creds,
    TODO_LINE_RE,
    // Firebase's chunked-string representation, exposed so the round trip
    // can be checked without standing up an 8 MB document.
    _packForTest: packRoomText, _unpackForTest: unpackRoomText,
  };
})();
