/* ═══════════════════════════════════════════════════════════════
   IDE LINK — drains ide/<fp>/q into logs + planner blocks

   Mirrors bridge.js's contract: an external source of truth projected
   into this app's model, with this app owning the write. The IntelliJ
   plugin is append-only and never touches cade/<fp>, so it is not a
   participant in sync.js's merge protocol — which is the point.

   Deliberately a SEPARATE Firebase app instance on a SEPARATE subtree.
   sync.js subscribes to the whole of cade/<fp>, so a record written
   there would wake every open tab and re-decrypt the entire dataset on
   every heartbeat.
   ═══════════════════════════════════════════════════════════════ */

const IdeLink = (() => {
  // sync.js derives the path fingerprint from `passphrase + SALT`, where
  // SALT is a Uint8Array — so JS string coercion runs, and what is hashed
  // is the DECIMAL COMMA-JOINED form of the bytes, not the bytes and not
  // "CadeProj". The plugin hashes the same literal. Change one, change both,
  // or the two halves write and read different paths and nothing errors.
  const SALT_JS = '67,97,100,101,80,114,111,106';

  // A session shorter than this is noise — the same floor timers.js applies
  // before it will log a hand-run timer.
  const MIN_SECONDS = 60;

  // Records arrive in bursts (a backlog replays on attach). Report once for
  // the burst rather than once per record.
  const NOTIFY_IDLE_MS = 400;

  let db = null;
  let app = null;
  let fp = '';
  let chain = Promise.resolve();   // serializes consume() — see attach()
  let onChange = null;
  let notifyTimer = null;
  let batch = 0;                   // ingested since the last notification
  let attached = false;

  const stats = { ingested: 0, skipped: 0, failed: 0, lastAt: null, refused: false };

  // ── identity ────────────────────────────────────────────────

  async function fingerprint(passphrase) {
    const buf = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(passphrase + SALT_JS));
    return Array.from(new Uint8Array(buf.slice(0, 8)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Ids derived from the record rather than drawn from uid(). Two tabs can
  // both see the same child_added before either has written anything, and a
  // duplicate then survives the merge — mergeCollection() dedupes by id, so
  // the fix is for both tabs to compute the SAME id. State.createX() spreads
  // `...partial` after its own `id: uid()`, so passing one wins.
  function keyHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function hhmm(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ── project + task resolution ───────────────────────────────
  // One synthetic task per IDE project. That is what makes the feature free
  // on the analytics side: charts.js counts logs of type 'time_session' and
  // actualMinutesFor() sums them by entryId, so attributing to a real task
  // lights up estimate-vs-actual, the project rollups and every existing
  // chart without touching any of them.

  function findOrCreateProject(rec) {
    const path = rec.projectPath || rec.projectName || 'unknown';
    // includeArchived: a project the user archived is still THE project.
    // Skipping it here would silently create a second one on the next push.
    const existing = State.getProjects({ includeArchived: true })
      .find(p => p.ideProjectPath === path);
    if (existing) return existing;
    return State.createProject({
      id: 'ide-proj-' + keyHash(path),
      name: rec.projectName || 'IDE project',
      ideProjectPath: path,
    });
  }

  function findOrCreateTask(rec, project) {
    const path = rec.projectPath || rec.projectName || 'unknown';
    const existing = State.getEntries({ type: 'task', includeArchived: true })
      .find(e => e.ideProjectPath === path);
    if (existing) return existing;
    return State.createEntry({
      id: 'ide-task-' + keyHash(path),
      type: 'task',
      title: `Coding — ${rec.projectName || 'IDE project'}`,
      projectId: project.id,
      ideProjectPath: path,
      description: 'Time tracked automatically from the IDE.',
    });
  }

  // ── ingestion ───────────────────────────────────────────────

  function ingest(rec) {
    // Deleting the node is the primary dedupe; this is the backstop for the
    // cases where it isn't enough — two tabs racing the same child_added, or
    // a delete that failed after the log was written.
    if (State.getLogs({ type: 'time_session' }).some(l => l.sourceId === rec.id)) {
      stats.skipped++;
      return false;
    }

    const countBg = !!State.getSettings().ideCountBackground;
    const seconds = Math.round((rec.activeSeconds || 0) + (rec.readingSeconds || 0)
      + (countBg ? (rec.backgroundSeconds || 0) : 0));
    if (!(seconds >= MIN_SECONDS)) { stats.skipped++; return false; }

    const start = new Date(rec.startedAt);
    if (isNaN(start)) { stats.skipped++; return false; }
    let end = new Date(rec.endedAt);
    // A missing or nonsensical endedAt must not produce a backwards block.
    if (isNaN(end) || end <= start) end = new Date(start.getTime() + seconds * 1000);

    const project = findOrCreateProject(rec);
    const task = findOrCreateTask(rec, project);

    // Arbitrary fields ride along for free — createLog spreads ...partial and
    // `logs` is already in MERGED_COLLECTIONS, so files[] reaches every
    // device with no change to sync.js.
    State.createLog({
      id: 'ide-log-' + rec.id,
      type: 'time_session',
      entryId: task.id,
      entryTitle: task.title,
      date: State.dateStr(start),
      value: seconds,
      notes: ['IDE', rec.branch || 'no branch', rec.device || '']
        .filter(Boolean).join(' · '),
      sourceId: rec.id,
      source: 'ide',
      // Kept raw so a week of real data can settle the thresholds. Do not
      // drop these to save space before you have looked at the histogram.
      activeSeconds: rec.activeSeconds || 0,
      readingSeconds: rec.readingSeconds || 0,
      backgroundSeconds: rec.backgroundSeconds || 0,
      closedBy: rec.closedBy || null,
      files: rec.files || [],
      runs: rec.runs || null,
      branch: rec.branch || null,
      ide: rec.ide || null,
    });

    // The payoff: open the app in the evening and the day is already drawn.
    // A session that ran past midnight is clamped rather than split — the
    // planner is a day grid, and a block whose end precedes its start
    // renders as a negative-height smear.
    const sameDay = State.dateStr(end) === State.dateStr(start);
    State.createPlannerBlock({
      id: 'ide-blk-' + rec.id,
      date: State.dateStr(start),
      start: hhmm(start),
      end: sameDay ? hhmm(end) : '23:59',
      title: `Coding — ${rec.projectName || 'IDE project'}`,
      entryId: task.id,
      projectId: project.id,
      color: project.color || null,
      kind: 'tracked',
      sourceId: rec.id,
    });

    stats.ingested++;
    stats.lastAt = Date.now();
    return true;
  }

  // ── queue drain ─────────────────────────────────────────────

  async function consume(key, node) {
    if (!node || !node.enc) return;
    let rec;
    try {
      // Shares sync.js's derived key, so key agreement is guaranteed: if the
      // app can read its own dataset it can read these.
      rec = await Sync.decrypt(node.enc);
    } catch (e) {
      // A record we cannot read is a wrong-or-missing-key symptom, not a
      // corrupt record. Deleting it would destroy recoverable data, so it
      // stays queued until the key that wrote it is the key in use.
      console.warn('IdeLink: could not decrypt ' + key + ' — leaving it queued', e && e.message);
      stats.failed++;
      return;
    }
    if (!rec || !rec.id) return;

    let changed = false;
    try {
      changed = ingest(rec);
    } catch (e) {
      console.error('IdeLink: ingest failed for ' + key + ' — leaving it queued', e);
      stats.failed++;
      return;                                   // no delete: retry next load
    }
    await db.ref(`ide/${fp}/q/${key}`).remove().catch(() => {});
    if (changed) notify();
  }

  function notify() {
    if (!onChange) return;
    batch++;
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      const added = batch;
      batch = 0;
      try { onChange({ ...stats, added }); } catch (e) { console.error('IdeLink:', e); }
    }, NOTIFY_IDLE_MS);
  }

  // ── lifecycle ───────────────────────────────────────────────

  async function attach() {
    if (attached) return false;
    const s = State.getSettings().sync || {};
    // No sync means no channel: the plugin's records are encrypted with the
    // sync passphrase and addressed by its fingerprint.
    if (!s.databaseUrl || !s.passphrase) return false;
    if (typeof firebase === 'undefined') return false;
    attached = true;
    try {
      fp = await fingerprint(s.passphrase);
      app = firebase.initializeApp({ databaseURL: s.databaseUrl }, 'cade-ide-' + Date.now());
      db = firebase.database(app);
      // child_added is the right primitive for a queue: it replays the
      // backlog on attach and then streams. consume() is async, so events
      // are serialized through `chain` — two records must never interleave a
      // find-or-create and produce two of the same project.
      db.ref(`ide/${fp}/q`).on('child_added', (snap) => {
        chain = chain
          .then(() => consume(snap.key, snap.val()))
          .catch(e => console.error('IdeLink:', e));
      }, (err) => {
        // Same fault as sync.js's refusal latch, one path over: rules that
        // grant `cade` and deny everything else refuse `ide` too.
        stats.refused = true;
        console.error('IdeLink: the database refused to read ide/' + fp +
          ' — add the "ide" rule. See project/FIREBASE_RULES.md.', err && err.message);
      });
      return true;
    } catch (e) {
      attached = false;
      console.error('IdeLink: could not attach', e);
      return false;
    }
  }

  function init(changeHandler) {
    onChange = changeHandler || null;
    // Must not run before reconcile. Importing into a pre-reconcile dataset
    // that the server copy is then merged onto yields two of every project —
    // the exact bug bridge.js's `defer` exists to avoid. The queue is
    // append-only and nothing expires, so waiting costs nothing.
    if (Sync.isConfigured() && !Sync.isReconciled()) {
      window.addEventListener('sync-reconciled', () => { attach(); }, { once: true });
      setTimeout(() => { attach(); }, 15000);   // backstop: unreachable db
    } else {
      attach();
    }
  }

  function getStats() { return { ...stats }; }

  return {
    init, getStats,
    // test-only handles: drive ingestion without a Firebase or a plugin
    _test: { ingest, fingerprint, keyHash, consume, attach, MIN_SECONDS },
  };
})();
