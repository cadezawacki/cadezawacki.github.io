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
        }
        updateStatus();
      });

      const settings = State.getSettings();
      State.updateSettings({ sync: { ...settings.sync, databaseUrl, passphrase, connected: true } });
      return { success: true };
    } catch (e) {
      connecting = false;
      updateStatus();
      return { success: false, error: e.message };
    }
  }

  function disconnect() {
    clearTimeout(pushTimer);
    if (dataListener && db) {
      db.ref(dataPath()).off('value', dataListener);
      dataListener = null;
    }
    if (connectionListener && db) {
      db.ref('.info/connected').off('value', connectionListener);
      connectionListener = null;
    }
    connected = false;
    connecting = false;
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
    if (!connected || !db) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      await pushLocal();
    }, 2000);
  }

  async function pushLocal() {
    if (!connected || !db) return;
    try {
      const raw = State.getRawData();
      const encrypted = await encrypt(raw);

      // Multi-path update scoped to this fingerprint's subtree. The version
      // counter uses a server-side atomic increment; a root-level transaction
      // would require root read/write permission and reject slash-keys.
      await db.ref().update({
        [dataPath()]: encrypted,
        [versionPath()]: firebase.database.ServerValue.increment(1),
      });

      lastSyncedSnapshot = structuredClone(raw);
      lastSyncedVersion++;
      updateStatus();
    } catch (e) {
      console.error('Push error:', e);
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
        // Server empty — push local (fresh-device bootstrap)
        await pushLocal();
        // Set up live listener
        setupLiveListener();
        return;
      }

      const serverPayload = await decrypt(serverEncrypted);
      const localData = State.getRawData();

      // Classify situation
      if (serverVersion === lastSyncedVersion) {
        // Unchanged — no-op
      } else if (serverVersion > lastSyncedVersion && lastSyncedVersion > 0) {
        // Server newer — adopt server
        State.setRawData(serverPayload);
        lastSyncedSnapshot = structuredClone(serverPayload);
        lastSyncedVersion = serverVersion;
      } else if (lastSyncedVersion === 0) {
        // Cold start — adopt server
        State.setRawData(serverPayload);
        lastSyncedSnapshot = structuredClone(serverPayload);
        lastSyncedVersion = serverVersion;
      } else {
        // Potential divergence — check if local changed
        const localChanged = JSON.stringify(localData) !== JSON.stringify(lastSyncedSnapshot);
        const serverChanged = serverVersion !== lastSyncedVersion;

        if (localChanged && serverChanged) {
          // Genuine conflict — show resolution UI
          showConflictModal(localData, serverPayload);
          return;
        } else if (serverChanged) {
          State.setRawData(serverPayload);
          lastSyncedSnapshot = structuredClone(serverPayload);
          lastSyncedVersion = serverVersion;
        } else if (localChanged) {
          await pushLocal();
        }
      }

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

  function setupLiveListener() {
    if (!db || dataListener) return;
    dataListener = db.ref(dataPath()).on('value', async (snap) => {
      const encrypted = snap.val();
      if (!encrypted) return;
      try {
        const payload = await decrypt(encrypted);
        const local = State.getRawData();
        // Diff against last synced
        if (JSON.stringify(payload) !== JSON.stringify(local)) {
          State.setRawData(payload);
          lastSyncedSnapshot = structuredClone(payload);
        }
      } catch (e) {
        console.error('Listener decrypt error:', e);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CONFLICT RESOLUTION UI
  // ═══════════════════════════════════════════════════════════
  function showConflictModal(localData, serverData) {
    if (typeof App !== 'undefined') App.showConflictModal(localData, serverData);
  }

  async function resolveConflict(resolution, serverData) {
    if (resolution === 'local') {
      await pushLocal();
    } else if (resolution === 'server') {
      State.setRawData(serverData);
      lastSyncedSnapshot = structuredClone(serverData);
      State.emit();
    } else if (resolution === 'merge') {
      // Simple merge: prefer server entries, keep local-only
      const merged = { ...serverData };
      const localData = State.getRawData();
      const serverEntryIds = new Set((serverData.entries || []).map(e => e.id));
      const localOnly = (localData.entries || []).filter(e => !serverEntryIds.has(e.id));
      merged.entries = [...(serverData.entries || []), ...localOnly];
      State.setRawData(merged);
      lastSyncedSnapshot = structuredClone(merged);
      await pushLocal();
    }
    setupLiveListener();
  }

  // ═══════════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════════
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
    const state = connected ? 'online' : connecting ? 'syncing' : 'offline';
    el.className = 'sync-dot ' + state;
    el.title = 'Sync: ' + (connected ? 'connected' : connecting ? 'reconnecting…' : 'disconnected');
  }

  function isConnected() { return connected; }

  // ── Auto-connect on load if configured ────────────────────
  function autoConnect() {
    const settings = State.getSettings();
    if (settings.sync.databaseUrl && settings.sync.passphrase) {
      connect(settings.sync.databaseUrl, settings.sync.passphrase);
    }
  }

  return {
    connect, disconnect, schedulePush, pushLocal, resolveConflict,
    isConnected, updateStatus, autoConnect, eraseRemote,
    encrypt, decrypt, // exposed for testing
  };
})();
