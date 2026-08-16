/* ═══════════════════════════════════════════════════════════════
   SYNC — Firebase RTDB + AES-GCM encryption + reconciliation
   Local-first: all writes land locally immediately, sync is async
   ═══════════════════════════════════════════════════════════════ */

const Sync = (() => {
  const MAGIC = 'CP1'; // format version header
  const PBKDF2_ITERATIONS = 100000;
  const SALT = new Uint8Array([0x43, 0x61, 0x64, 0x65, 0x50, 0x72, 0x6f, 0x6a]); // "CadeProj"

  let db = null;           // Firebase RTDB instance
  let connected = false;
  let connecting = false;  // true while establishing / reconciling
  let pushTimer = null;
  let lastSyncedSnapshot = null;
  let lastSyncedVersion = 0;
  let cryptoKey = null;
  let keyFingerprint = '';
  let connectionListener = null;
  let dataListener = null;
  let listenerChain = Promise.resolve(); // serializes async event handling

  // Nothing may be published until the first reconcile has actually compared
  // local against the server. Firebase flips `.info/connected` seconds before
  // onReconnect() finishes its fetch-and-classify, and any edit landing in
  // that window used to fire a debounced push of the *pre-reconcile* local
  // state — which, on a device whose storage had just been cleared, meant
  // uploading an empty dataset over everything.
  let reconciled = false;

  // Anything that must not act on the dataset until it is the REAL dataset
  // waits on this. The Cade.txt bridge is the main one: importing rooms into
  // a not-yet-reconciled local copy, then merging the server's copy on top,
  // would leave two projects and two tasks for every room.
  function markReconciled() {
    if (reconciled) return;
    reconciled = true;
    try { window.dispatchEvent(new CustomEvent('sync-reconciled')); } catch (e) {}
  }
  function isReconciled() { return reconciled; }
  function isConfigured() {
    const s = State.getSettings();
    if (!s.sync || s.sync.paused) return false;
    return !!(s.sync.databaseUrl && s.sync.passphrase);
  }

  // Identifies THIS session's writes so echoes are recognized by identity,
  // not by content — a stale echo of our own older write must never be
  // mistaken for another device's edit and adopted.
  const clientId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

  // The local dataset in the exact shape we publish. Every snapshot, dirty
  // check and conflict diff goes through here — comparing the raw dataset
  // against a snapshot of the syncable one would report permanent divergence
  // (the raw one carries device-local settings the server copy never has).
  function localData() {
    return State.getSyncableData ? State.getSyncableData() : State.getRawData();
  }

  // Key-order-independent serialization. deepMerge/migrate reorder object
  // keys, so JSON.stringify equality lies about "same content" — that lie
  // caused phantom dirty states and adopt/push ping-pong between devices.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  // Field-level merge for genuinely diverged datasets (cold start with
  // local work, or user-chosen merge). Entries/projects: newer updatedAt
  // wins on shared ids, one-sided items are kept. Logs/planner/scratch:
  // union by id. Settings: the device in hand wins.
  // Every collection that a merge touches. Named here so the conflict screen
  // can describe exactly the same set the merge acts on, rather than a
  // hand-kept second list that drifts.
  const MERGED_COLLECTIONS = ['entries', 'projects', 'tags', 'logs', 'planner', 'scratch'];

  // When an item exists on both sides, the copy edited more recently wins.
  //
  // This used to be two rules: newest-wins for entries and projects, and
  // first-wins for everything else — which meant an edit to a log, a planner
  // block or a tag made on this device was silently discarded in favour of
  // the server's copy. And since projects carried no updatedAt at all, even
  // their "newest wins" always fell through to the same server-wins default,
  // so a project renamed here reverted on every merge.
  function itemStamp(item) {
    return (item && (item.updatedAt || item.createdAt)) || '';
  }

  // Ties go to LOCAL. A tie almost always means neither side has a usable
  // stamp — records written before stamping existed — and between two equally
  // unknown copies the right one to keep is the one belonging to the person
  // answering the dialog.
  function pickNewer(localItem, serverItem) {
    return itemStamp(serverItem) > itemStamp(localItem) ? serverItem : localItem;
  }

  function mergeCollection(localList, serverList) {
    const out = new Map();
    const list = (x) => (Array.isArray(x) ? x : []);
    list(serverList).forEach(item => { if (item && item.id) out.set(item.id, item); });
    list(localList).forEach(item => {
      if (!item || !item.id) return;
      const rival = out.get(item.id);
      out.set(item.id, rival ? pickNewer(item, rival) : item);
    });
    return [...out.values()];
  }

  // Which side each shared item resolves to, without performing the merge —
  // the conflict screen shows this per item so the outcome is visible before
  // the button is pressed.
  function mergeWinner(localItem, serverItem) {
    return pickNewer(localItem, serverItem) === serverItem ? 'server' : 'local';
  }

  function mergeData(local, server) {
    const l = local || {};
    const s = server || {};
    const merged = {
      // Local first for anything not enumerated below, matching the settings
      // rule: unknown keys belong to the device being merged into.
      ...s, ...l,
      // Device settings stay this device's. A merge is about content.
      settings: l.settings || s.settings,
    };
    MERGED_COLLECTIONS.forEach(k => { merged[k] = mergeCollection(l[k], s[k]); });
    return merged;
  }

  // ═══════════════════════════════════════════════════════════
  // ENCRYPTION PIPELINE
  // serialize → compress → AES-GCM encrypt → base64 → write
  // ═══════════════════════════════════════════════════════════

  async function deriveKey(passphrase) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    // Fingerprint = short hash of key material for path segment
    const fpBuf = await crypto.subtle.digest('SHA-256', enc.encode(passphrase + SALT));
    keyFingerprint = Array.from(new Uint8Array(fpBuf.slice(0, 8)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return key;
  }

  async function encrypt(data) {
    if (!cryptoKey) throw new Error('No encryption key');
    const json = JSON.stringify(data);
    const encoded = new TextEncoder().encode(json);
    // Compress using CompressionStream if available
    let payload = encoded;
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(encoded);
      writer.close();
      const reader = cs.readable.getReader();
      const chunks = [];
      let done = false;
      while (!done) {
        const r = await reader.read();
        done = r.done;
        if (r.value) chunks.push(r.value);
      }
      payload = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      chunks.forEach(c => { payload.set(c, offset); offset += c.length; });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, cryptoKey, payload
    );
    // Self-describing format: magic + iv + ciphertext
    const magicBytes = new TextEncoder().encode(MAGIC);
    const combined = new Uint8Array(magicBytes.length + iv.length + ciphertext.byteLength);
    combined.set(magicBytes, 0);
    combined.set(iv, magicBytes.length);
    combined.set(new Uint8Array(ciphertext), magicBytes.length + iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async function decrypt(b64) {
    if (!cryptoKey) throw new Error('No encryption key');
    const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const magicLen = new TextEncoder().encode(MAGIC).length;
    // Check magic
    const magic = new TextDecoder().decode(combined.slice(0, magicLen));
    if (magic !== MAGIC) throw new Error('Invalid format');
    const iv = combined.slice(magicLen, magicLen + 12);
    const ciphertext = combined.slice(magicLen + 12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );
    let payload = new Uint8Array(decrypted);
    // Decompress if it was compressed
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(payload);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        let done = false;
        while (!done) {
          const r = await reader.read();
          done = r.done;
          if (r.value) chunks.push(r.value);
        }
        payload = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
        let offset = 0;
        chunks.forEach(c => { payload.set(c, offset); offset += c.length; });
      } catch (e) {
        // Not compressed, use as-is
      }
    }
    const json = new TextDecoder().decode(payload);
    return JSON.parse(json);
  }

  // ═══════════════════════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  async function connect(databaseUrl, passphrase) {
    if (!databaseUrl || !passphrase) return { success: false, error: 'URL and passphrase required' };
    try {
      connecting = true;
      updateStatus();

      // Derive key
      cryptoKey = await deriveKey(passphrase);

      // Initialize Firebase
      if (typeof firebase === 'undefined') { connecting = false; updateStatus(); return { success: false, error: 'Firebase SDK not loaded' }; }

      // Clean up previous connection
      disconnect();
      connecting = true;

      const app = firebase.initializeApp({ databaseURL: databaseUrl }, 'cade-' + Date.now());
      db = firebase.database(app);

      // Listen to connection state
      connectionListener = db.ref('.info/connected').on('value', (snap) => {
        const isLive = snap.val() === true;
        if (isLive && !connected) {
          connected = true;
          connecting = false;
          onReconnect();
        } else if (!isLive) {
          connected = false;
          // Losing the connection invalidates the reconcile: the server can
          // move while we are away, so the next onReconnect() has to compare
          // again before anything is published. Without this the flag stays
          // true across the drop, and an edit made while the reconnect fetch
          // is still in flight pushes straight over newer server data — the
          // race the flag exists to prevent.
          reconciled = false;
        }
        updateStatus();
      });

      const settings = State.getSettings();
      State.updateSettings({ sync: { ...settings.sync, databaseUrl, passphrase, connected: true, paused: false } });
      return { success: true };
    } catch (e) {
      connecting = false;
      updateStatus();
      return { success: false, error: e.message };
    }
  }

  function disconnect() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (dataListener && db) {
      db.ref(`cade/${keyFingerprint}`).off('value', dataListener);
      dataListener = null;
    }
    if (connectionListener && db) {
      db.ref('.info/connected').off('value', connectionListener);
      connectionListener = null;
    }
    connected = false;
    connecting = false;
    reconciled = false; // the next connect must re-compare before publishing
    db = null;
    updateStatus();
  }

  // Permanently delete this dataset's node (cade/<fingerprint>) from the
  // server. Used by Reset All Data so the encrypted blob doesn't linger and
  // resurrect on the next connect with the same passphrase.
  async function eraseRemote() {
    try {
      clearTimeout(pushTimer);
      const settings = State.getSettings();
      if (!settings.sync.databaseUrl || !settings.sync.passphrase) {
        return { success: false, error: 'Sync not configured' };
      }
      if (!keyFingerprint) await deriveKey(settings.sync.passphrase);
      let target = db;
      let tempApp = null;
      if (!target) {
        if (typeof firebase === 'undefined') return { success: false, error: 'Firebase SDK not loaded' };
        tempApp = firebase.initializeApp({ databaseURL: settings.sync.databaseUrl }, 'cade-erase-' + Date.now());
        target = firebase.database(tempApp);
      }
      await Promise.race([
        target.ref(`cade/${keyFingerprint}`).remove(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
      ]);
      disconnect();
      if (tempApp) tempApp.delete().catch(() => {});
      lastSyncedSnapshot = null;
      lastSyncedVersion = 0;
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function dataPath() {
    return `cade/${keyFingerprint}/data`;
  }

  function metaPath() {
    return `cade/${keyFingerprint}/meta`;
  }

  function versionPath() {
    return `cade/${keyFingerprint}/version`;
  }

  // ═══════════════════════════════════════════════════════════
  // SYNC FLOW
  // ═══════════════════════════════════════════════════════════

  // Debounced push — local edits pushed after short delay
  function schedulePush() {
    if (!connected || !db || !reconciled) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      await pushLocal();
    }, 2000);
  }

  let pushing = false;

  // Guards every write to the server. `bootstrap` is the one caller allowed
  // to run before reconciliation — it is the reconcile itself.
  function canPush(bootstrap) {
    if (!connected || !db) return false;
    if (!bootstrap && !reconciled) return false;
    // An unreadable local blob leaves State holding an empty placeholder.
    // Publishing that would delete the user's data on every other device.
    if (typeof State.isHealthy === 'function' && !State.isHealthy()) {
      console.warn('Sync: local dataset unreadable — refusing to push');
      return false;
    }
    return true;
  }

  async function pushLocal(bootstrap = false) {
    if (!canPush(bootstrap)) return;
    pushing = true;
    const prevSnapshot = lastSyncedSnapshot;
    try {
      const raw = localData();
      // Nothing changed since the last sync (e.g. we just adopted a foreign
      // write, which re-triggers schedulePush) — skip the redundant write.
      if (lastSyncedSnapshot && stableStringify(raw) === stableStringify(lastSyncedSnapshot)) {
        return;
      }
      const encrypted = await encrypt(raw);

      // Snapshot BEFORE the write: Firebase fires the local echo during
      // update(), and it must compare against what we're pushing now.
      lastSyncedSnapshot = structuredClone(raw);

      // Multi-path update scoped to this fingerprint's subtree. The version
      // counter uses a server-side atomic increment; a root-level transaction
      // would require root read/write permission and reject slash-keys.
      // meta identifies the writer so every client can ignore its own echoes.
      await db.ref().update({
        [dataPath()]: encrypted,
        [versionPath()]: firebase.database.ServerValue.increment(1),
        [metaPath()]: { clientId, at: firebase.database.ServerValue.TIMESTAMP },
      });

      lastSyncedVersion++;
      updateStatus();
    } catch (e) {
      lastSyncedSnapshot = prevSnapshot; // write failed — we are NOT synced
      console.error('Push error:', e);
    } finally {
      pushing = false;
    }
  }

  // Reconciliation on reconnect
  async function onReconnect() {
    if (!db) return;
    try {
      connecting = true;
      updateStatus();
      // One-time fetch with timeout
      const serverData = await Promise.race([
        db.ref(dataPath()).once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
      ]);
      const versionSnap = await Promise.race([
        db.ref(versionPath()).once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
      ]);

      const serverEncrypted = serverData.val();
      const serverVersion = versionSnap.val() || 0;

      if (!serverEncrypted) {
        // Server empty — bootstrap it from local. A local dataset we could
        // not read is NOT "no data": canPush() blocks that case, leaving the
        // server untouched rather than initialising it to nothing.
        markReconciled();
        await pushLocal(true);
        setupLiveListener();
        connecting = false;
        updateStatus();
        return;
      }

      const serverPayload = await decrypt(serverEncrypted);
      const local = localData();

      // Classify situation
      if (serverVersion === lastSyncedVersion) {
        // Unchanged — no-op
      } else if (serverVersion > lastSyncedVersion && lastSyncedVersion > 0) {
        // Server newer — adopt, UNLESS local also has unpushed edits
        // (offline work must never be silently clobbered on reconnect)
        const localDirty = stableStringify(local) !== stableStringify(lastSyncedSnapshot);
        if (localDirty) {
          showConflictModal(local, serverPayload);
          return;
        }
        State.setRawData(serverPayload);
        lastSyncedSnapshot = structuredClone(localData());
        lastSyncedVersion = serverVersion;
      } else if (lastSyncedVersion === 0) {
        // Cold start (every page load lands here). Blind adoption used to
        // VAPORIZE anything created between page load and connect finishing
        // (Firebase init + key derivation take seconds). Adopt only when
        // local is empty or identical; otherwise field-level merge and push.
        const localEmpty = !((local.entries || []).length || (local.logs || []).length ||
          (local.projects || []).length || (local.planner || []).length || (local.scratch || []).length);
        if (localEmpty || stableStringify(local) === stableStringify(serverPayload)) {
          State.setRawData(serverPayload);
          lastSyncedSnapshot = structuredClone(localData());
          lastSyncedVersion = serverVersion;
        } else {
          const merged = mergeData(local, serverPayload);
          State.setRawData(merged);
          lastSyncedSnapshot = null; // force the push below to actually write
          lastSyncedVersion = serverVersion;
          markReconciled();
          await pushLocal(true);
        }
      } else {
        // Potential divergence — check if local changed
        const localChanged = stableStringify(local) !== stableStringify(lastSyncedSnapshot);
        const serverChanged = serverVersion !== lastSyncedVersion;

        if (localChanged && serverChanged) {
          // Genuine conflict — show resolution UI
          showConflictModal(local, serverPayload);
          return;
        } else if (serverChanged) {
          State.setRawData(serverPayload);
          lastSyncedSnapshot = structuredClone(localData());
          lastSyncedVersion = serverVersion;
        } else if (localChanged) {
          markReconciled();
          await pushLocal(true);
        }
      }

      markReconciled();
      setupLiveListener();
      connecting = false;
      updateStatus();
    } catch (e) {
      console.error('Reconnect error:', e);
      connected = false;
      connecting = false;
      updateStatus();
    }
  }

  // Decide what an incoming server payload means. Pure — unit-testable.
  //  'echo'     server matches what we last pushed/adopted → bookkeeping only.
  //  'adopt'    foreign change, local is clean → take the server's version.
  //  'defer'    foreign change but local has unpushed edits AND a push is
  //             queued/in-flight → our push wins the race; never clobber
  //             work done between a push and its echo (the "check task A,
  //             task B unchecks itself" bug).
  //  'conflict' foreign change, local dirty, nothing queued → ask the user.
  function classifyIncoming(incomingJson, lastSyncedJson, localJson, pushPending) {
    if (incomingJson === lastSyncedJson) return 'echo';
    if (localJson === lastSyncedJson) return 'adopt';
    if (pushPending) return 'defer';
    return 'conflict';
  }

  async function handleIncoming(node) {
    if (!node || !node.data) return;
    const serverVersion = node.version || 0;

    // Our own write (fresh OR stale echo) — identity check, never content.
    // A late echo of an older push must never masquerade as foreign data.
    if (node.meta && node.meta.clientId === clientId) {
      lastSyncedVersion = Math.max(lastSyncedVersion, serverVersion);
      return;
    }

    const payload = await decrypt(node.data);
    const verdict = classifyIncoming(
      stableStringify(payload),
      stableStringify(lastSyncedSnapshot),
      stableStringify(localData()),
      !!pushTimer || pushing
    );
    if (verdict === 'echo') {
      lastSyncedVersion = Math.max(lastSyncedVersion, serverVersion);
      return;
    }
    // Stale foreign event — older than (or same as) what we've already
    // synced. Adopting it would time-travel local data backwards.
    if (serverVersion > 0 && serverVersion <= lastSyncedVersion) return;

    if (verdict === 'adopt') {
      State.setRawData(payload);
      // store the NORMALIZED form — what getRawData now returns — so the
      // followup schedulePush sees "nothing changed" and stays quiet
      lastSyncedSnapshot = structuredClone(localData());
      lastSyncedVersion = serverVersion || lastSyncedVersion;
    } else if (verdict === 'conflict') {
      showConflictModal(localData(), payload);
    }
    // 'defer': our queued push will overwrite shortly — do nothing
  }

  function setupLiveListener() {
    if (!db || dataListener) return;
    // Parent node = { data, version, meta } in one snapshot. Events are
    // processed strictly in arrival order — async decrypt must not let a
    // stale event finish after (and overwrite) a newer one.
    dataListener = db.ref(`cade/${keyFingerprint}`).on('value', (snap) => {
      const node = snap.val();
      listenerChain = listenerChain
        .then(() => handleIncoming(node))
        .catch(e => console.error('Listener error:', e));
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CONFLICT RESOLUTION UI
  // ═══════════════════════════════════════════════════════════
  function showConflictModal(localSide, serverSide) {
    if (typeof App !== 'undefined') App.showConflictModal(localSide, serverSide);
  }

  function isDataset(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  async function resolveConflict(resolution, serverData) {
    // Two of the three answers are meaningless without the payload they were
    // offered against, and the UI used to pass null for all three. That made
    // "Take Server" call setRawData(null) — which resets to defaults, i.e.
    // erases everything — and made "Merge Both" throw on null.entries before
    // it wrote anything, so the button appeared to do nothing at all.
    if ((resolution === 'server' || resolution === 'merge') && !isDataset(serverData)) {
      console.error('Sync: resolveConflict(' + resolution + ') without a server payload — refusing');
      return { ok: false, reason: 'no-server-data' };
    }
    // The conflict path bails out of onReconnect before it can mark the
    // reconcile done; answering the dialog IS the reconcile finishing.
    markReconciled();
    if (resolution === 'local') {
      lastSyncedSnapshot = null; // guarantee the push writes
      await pushLocal(true);
    } else if (resolution === 'server') {
      State.setRawData(serverData);
      lastSyncedSnapshot = structuredClone(localData());
      State.emit();
    } else if (resolution === 'merge') {
      const merged = mergeData(localData(), serverData);
      State.setRawData(merged);
      lastSyncedSnapshot = null; // force the merged result to push
      await pushLocal(true);
    } else {
      return { ok: false, reason: 'unknown-resolution' };
    }
    setupLiveListener();
    return { ok: true, resolution };
  }

  // ═══════════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════════
  // Whether a conflict is parked awaiting an answer. Pushed in by the UI
  // rather than read back out of it: App is a top-level `const`, so a
  // `typeof App` guard here would throw a ReferenceError instead of yielding
  // 'undefined' if this ever ran before app.js had evaluated — and `const`
  // never lands on `window`, so the usual window.App fallback reads as
  // permanently absent.
  let conflictWaiting = false;
  function setConflictWaiting(waiting) {
    conflictWaiting = !!waiting;
    updateStatus();
  }

  // Menubar dot: green = connected, yellow = reconnecting, red = disconnected.
  function updateStatus() {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    const settings = State.getSettings();
    if (!settings.sync.databaseUrl) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    // A deferred conflict outranks the connection state: sync is technically
    // up but is holding, and the dot is the only place that says so.
    const state = conflictWaiting ? 'conflict'
      : connected ? 'online' : connecting ? 'syncing' : 'offline';
    el.className = 'sync-dot ' + state;
    el.title = conflictWaiting
      ? 'Sync conflict waiting — click to decide what to keep'
      : settings.sync.paused
        ? 'Sync paused after a local reset — open Data ▸ Firebase Sync to reconnect'
        : 'Sync: ' + (connected ? 'connected' : connecting ? 'reconnecting…' : 'disconnected');
  }

  function isConnected() { return connected; }

  // ── Auto-connect on load if configured ────────────────────
  function autoConnect() {
    const settings = State.getSettings();
    // `paused` is set by a local-only reset: the credentials are kept, but
    // reconnecting has to be the user's decision — otherwise the reload
    // immediately restores everything they just deleted.
    if (settings.sync.paused) { updateStatus(); return; }
    if (settings.sync.databaseUrl && settings.sync.passphrase) {
      connect(settings.sync.databaseUrl, settings.sync.passphrase);
    }
  }

  return {
    connect, disconnect, schedulePush, pushLocal, resolveConflict,
    isConnected, updateStatus, setConflictWaiting, autoConnect, eraseRemote,
    isReconciled, isConfigured,
    encrypt, decrypt, classifyIncoming, stableStringify, mergeData, // exposed for testing
    // The conflict screen previews the merge it is about to run.
    MERGED_COLLECTIONS, mergeWinner,
    // test-only handles: simulate the live listener without a real Firebase
    _test: {
      handleIncoming,
      get clientId() { return clientId; },
      async setKey(pass) { cryptoKey = await deriveKey(pass); },
      setSnapshot(s, v = 0) { lastSyncedSnapshot = s ? structuredClone(s) : null; lastSyncedVersion = v; },
      getBookkeeping() { return { lastSyncedVersion, snapshotSet: !!lastSyncedSnapshot }; },
    },
  };
})();
