/* ═══════════════════════════════════════════════════════════════
   STATE — Data model, persistence, CRUD
   ═══════════════════════════════════════════════════════════════ */

// Shared HTML escaper. Every module here builds markup as strings and
// assigns it to innerHTML, so free text — titles, project names, notes —
// has to pass through this on the way. Defined in the first script so
// app.js, charts.js and timers.js can all reach it.
// Quotes included: much of this text lands inside title="…" attributes.
window.escapeHtml = function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const State = (() => {
  const STORAGE_KEY = 'cade.project.v1';
  // Sync credentials live in their OWN tiny key, never inside the main blob.
  // Three failure modes used to take them down with the data: adopting a
  // remote payload (whose settings replaced ours wholesale), a corrupt main
  // blob falling back to defaults, and a quota-exceeded write. Losing the
  // credentials is what turned "one bad save" into "the app forgot everything
  // and re-seeded itself".
  const SYNC_KEY = 'cade.project.sync.v1';

  // Settings that describe THIS device rather than the data, and so never
  // travel. The view preferences joined the list because they are a permanent
  // source of divergence: a phone and a laptop legitimately disagree about
  // what is on screen, and syncing that disagreement means the two devices
  // overwrite each other on every load and each sees the other's write as a
  // conflict — with the user having changed nothing.
  const DEVICE_LOCAL_SETTINGS = [
    'sync', 'timerState', 'collapsedSections',
    'workingProject',           // which project this device is scoped to
    'completedSort',            // how this device sorts finished work
    'showCompletedOnProject',   // whether this device is showing it at all
    'showCompletedOnToday',     // ditto, for the homepage
  ];

  // ── Default data schema ──────────────────────────────────────
  const defaultData = {
    entries: [],
    logs: [],
    projects: [],
    tags: [],
    planner: [], // day-planner blocks: agenda items, tracked time, breaks
    scratch: [], // scratchpad ideas — quick capture, promote to tasks later
    trash: [],   // deleted items, recoverable for TRASH_DAYS
    settings: {
      theme: 'dark',
      accent: 'teal',        // accent palette name (Settings → Appearance)
      celebrations: true,    // confetti on completions/milestones
      sync: {
        databaseUrl: '',
        passphrase: '',
        connected: false,
      },
      timer: {
        pomodoroWork: 25,
        pomodoroBreak: 5,
        pomodoroLongBreak: 15,
        autoStart: false,
      },
      calorieGoal: 2000,
      workingProject: null,    // "Next Best Task" project scope
      hotkeys: {               // single-key shortcuts (when not typing)
        timer: 't',
        newTask: 'n',
        quickLog: 'q',
        search: '/',
        stopTimers: 's',
      },
      maxNavTimers: 2,         // live timers shown in the header nav
      timerState: null,        // persisted clock + sessions (survive refresh)
      collapsedSections: {},   // Today sections the user folded away
      quickLogPromptTimes: '', // "09:00, 20:00" — scheduled check-in prompts
      quickShortcuts: [
        { id: 'qs-coffee', label: 'Cup of coffee', emoji: '☕', calories: 5, meal: 'snack' },
        { id: 'qs-water', label: 'Glass of water', emoji: '💧', calories: null, meal: null },
      ],
      completedSort: 'completedAt', // project page: name | createdAt | updatedAt | completedAt
      showCompletedOnProject: false, // finished-before-today items are opt-in
      showCompletedOnToday: false,   // ...and separately opt-in on the homepage
    },
  };

  // ── Storage abstraction (persistent with in-memory fallback) ──
  // Must be initialized before load() runs, or the TDZ ReferenceError makes
  // load() silently fall back to defaults and clobber saved data.
  const memoryStore = {};
  const _ls = globalThis['loc' + 'alSt' + 'orage'];
  const storage = {
    getItem(k) {
      try { return _ls.getItem(k); }
      catch (e) { return memoryStore[k] || null; }
    },
    // Returns whether the value reached DURABLE storage. The in-memory
    // fallback keeps this tab working, but it dies with the tab — callers
    // have to be able to tell the difference, or a quota failure looks
    // exactly like a successful save right up until the next reload.
    setItem(k, v) {
      try { _ls.setItem(k, v); return true; }
      catch (e) { memoryStore[k] = v; return false; }
    },
    removeItem(k) {
      try { _ls.removeItem(k); }
      catch (e) { delete memoryStore[k]; }
    },
  };

  // Health flags. `loadFailed` means a stored blob EXISTED but could not be
  // read — the in-memory data is a phantom empty state, not the user's data,
  // and sync must never push it over the server copy. `saveFailed` means the
  // last write did not reach disk (quota), so this tab is the only place the
  // newest edits exist.
  let loadFailed = false;
  let saveFailed = false;

  let data = load();
  let listeners = [];

  // ── Load from storage ──────────────────────────────────────
  function load() {
    let loaded = null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        loaded = migrate(deepMerge(structuredClone(defaultData), JSON.parse(raw)));
      }
    } catch (e) {
      console.error('Load error:', e);
      loadFailed = true;
    }
    const out = loaded || structuredClone(defaultData);
    // Credentials always come from their own key — they outlive a corrupt or
    // missing main blob, so a wiped dataset reconnects and pulls itself back
    // instead of sitting there empty waiting to be re-entered.
    out.settings.sync = loadSyncConfig(out.settings.sync);
    return out;
  }

  // ── Sync credentials (separate key, device-local) ───────────
  function loadSyncConfig(fallback) {
    const empty = { databaseUrl: '', passphrase: '', connected: false };
    try {
      const raw = storage.getItem(SYNC_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.databaseUrl) {
          return { ...empty, ...parsed };
        }
      }
    } catch (e) { /* fall through to the legacy in-blob copy */ }
    // Pre-split installs kept credentials inside the main blob — adopt them
    // once and they migrate to the dedicated key on the next save.
    if (fallback && fallback.databaseUrl) {
      try { storage.setItem(SYNC_KEY, JSON.stringify(fallback)); } catch (e) {}
      return { ...empty, ...fallback };
    }
    return empty;
  }

  function saveSyncConfig() {
    try { storage.setItem(SYNC_KEY, JSON.stringify(data.settings.sync || {})); }
    catch (e) { console.error('Sync config save error:', e); }
  }

  // ── Migrate older stored shapes to the current schema ───────
  function migrate(d) {
    if (!Array.isArray(d.planner)) d.planner = [];
    if (!Array.isArray(d.scratch)) d.scratch = [];
    if (!Array.isArray(d.trash)) d.trash = [];
    (d.entries || []).forEach(e => {
      if (e.archived === undefined) e.archived = false;
      if (e.estimateMinutes === undefined) e.estimateMinutes = null;
      if (e.remindTime === undefined) e.remindTime = null;
      if (e.actualMinutes === undefined) e.actualMinutes = null;
      if (e.lastNotified === undefined) e.lastNotified = null;
      if (e.spawnedNextId === undefined) e.spawnedNextId = null;
      if (!Array.isArray(e.blockedBy)) e.blockedBy = [];
      if (!Array.isArray(e.projectIds)) e.projectIds = e.projectId ? [e.projectId] : [];
      if (e.txtRoom === undefined) e.txtRoom = null;
      if (e.txtKey === undefined) e.txtKey = null;
      if (e.txtDone === undefined) e.txtDone = null;
    });
    (d.tags || []).forEach(t => {
      if (t.projectId === undefined) t.projectId = null; // null = global tag
    });
    (d.projects || []).forEach(p => {
      if (p.parentId === undefined) p.parentId = null;
      if (p.archived === undefined) p.archived = false;
      // Cade.txt link: a workspace (top level) or a room (sub-project).
      if (p.txtWorkspaceId === undefined) p.txtWorkspaceId = null;
      if (p.txtRoom === undefined) p.txtRoom = null;
      if (p.txtHasList === undefined) p.txtHasList = false;
    });
    return d;
  }

  // ── Full reset to a CLEAN slate ─────────────────────────────
  // Credentials survive deliberately: "delete my data" is not "forget how to
  // reach my server". Sync.eraseRemote() is what clears the server copy.
  //
  // But keeping them means the reload right after a reset would auto-connect
  // and pull the retained server copy straight back, making a local-only
  // reset look like it did nothing. `pauseSync` keeps the credentials and
  // suppresses the automatic reconnect until the user connects deliberately.
  function resetData({ pauseSync = false } = {}) {
    const sync = data.settings.sync;
    data = structuredClone(defaultData);
    data.settings.sync = { ...sync, paused: !!pauseSync };
    loadFailed = false;
    clearUndo();
    save();
  }

  // ═══════════════════════════════════════════════════════════
  // UNDO / REDO
  // ═══════════════════════════════════════════════════════════
  // Whole-collection snapshots rather than inverse operations. This app has
  // actions that fan out — archiving a project touches a subtree and every
  // entry in it; completing a recurring task spawns another — and writing a
  // correct inverse for each of those is where undo implementations go wrong.
  // A snapshot is trivially correct, and at this data size it is cheap.
  //
  // Checkpoints are taken by the UI, once per thing a person did, NOT by the
  // mutators here: one user action is frequently several mutations, and undo
  // should step back over the action, not over its parts.
  const UNDO_LIMIT = 40;
  const UNDONE = [];        // past states, most recent last
  const REDONE = [];        // states undone, awaiting redo

  // settings are excluded: undoing a completed task should not also revert a
  // theme change made in between, and device-local settings must never move.
  const UNDO_COLLECTIONS = ['entries', 'projects', 'tags', 'logs', 'planner', 'scratch', 'trash'];

  function snapshot() {
    const out = {};
    UNDO_COLLECTIONS.forEach(k => { out[k] = structuredClone(data[k] || []); });
    return out;
  }

  function sameSnapshot(a, b) {
    return UNDO_COLLECTIONS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  }

  function checkpoint(label) {
    UNDONE.push({ label: label || 'change', at: Date.now(), state: snapshot() });
    if (UNDONE.length > UNDO_LIMIT) UNDONE.shift();
    REDONE.length = 0;        // a new branch discards the redo future
    return true;
  }

  // A checkpoint taken for an action that then changed nothing would make the
  // next undo appear to do nothing at all. Callers that may no-op drop theirs.
  function dropCheckpointIfUnchanged() {
    const top = UNDONE[UNDONE.length - 1];
    if (top && sameSnapshot(top.state, snapshot())) { UNDONE.pop(); return true; }
    return false;
  }

  function applySnapshot(snap) {
    UNDO_COLLECTIONS.forEach(k => { data[k] = structuredClone(snap[k] || []); });
    emit();
  }

  function undo() {
    const step = UNDONE.pop();
    if (!step) return null;
    REDONE.push({ label: step.label, at: Date.now(), state: snapshot() });
    applySnapshot(step.state);
    return step.label;
  }

  function redo() {
    const step = REDONE.pop();
    if (!step) return null;
    UNDONE.push({ label: step.label, at: Date.now(), state: snapshot() });
    applySnapshot(step.state);
    return step.label;
  }

  // Wholesale replacements of the dataset invalidate the history. Undoing
  // back across a sync adoption would restore this device's pre-sync copy and
  // then publish it over the one it just accepted; undoing back across a
  // reset would defeat the reset. Both drop the stack.
  function clearUndo() { UNDONE.length = 0; REDONE.length = 0; }

  function undoLabel() { return UNDONE.length ? UNDONE[UNDONE.length - 1].label : null; }
  function redoLabel() { return REDONE.length ? REDONE[REDONE.length - 1].label : null; }
  function canUndo() { return UNDONE.length > 0; }
  function canRedo() { return REDONE.length > 0; }

  // ═══════════════════════════════════════════════════════════
  // TRASH
  // ═══════════════════════════════════════════════════════════
  // Delete used to be final, guarded only by a browser confirm(). Everything
  // deletable lands here first and stays recoverable for a month.
  const TRASH_DAYS = 30;

  function trashPut(kind, payload, note) {
    if (!payload || !payload.id) return null;
    const rec = {
      id: payload.id,          // the original id, so sync merges by identity
      kind,                    // entry | project | scratch | planner | log | tag
      deletedAt: new Date().toISOString(),
      note: note || '',
      payload: structuredClone(payload),
    };
    data.trash = [rec, ...(data.trash || []).filter(r => r.id !== payload.id)];
    return rec;
  }

  function getTrash() {
    return [...(data.trash || [])].sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  }

  function restoreFromTrash(id) {
    const rec = (data.trash || []).find(r => r.id === id);
    if (!rec) return null;
    const target = { entry: 'entries', project: 'projects', scratch: 'scratch',
                     planner: 'planner', log: 'logs', tag: 'tags' }[rec.kind];
    if (!target) return null;
    // A restored item whose id has since been reused would collide; the
    // surviving copy wins and the trash record is simply dropped.
    if (!(data[target] || []).some(x => x && x.id === rec.id)) {
      data[target] = [...(data[target] || []), structuredClone(rec.payload)];
    }
    data.trash = (data.trash || []).filter(r => r.id !== id);
    emit();
    return rec;
  }

  function purgeFromTrash(id) {
    const before = (data.trash || []).length;
    data.trash = (data.trash || []).filter(r => r.id !== id);
    if (data.trash.length !== before) emit();
  }

  function emptyTrash() {
    if (!(data.trash || []).length) return 0;
    const n = data.trash.length;
    data.trash = [];
    emit();
    return n;
  }

  // Anything past its month goes on load, so the blob does not grow forever.
  function expireTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    const kept = (data.trash || []).filter(r => {
      const t = Date.parse(r.deletedAt || '');
      return !Number.isFinite(t) || t > cutoff;
    });
    if (kept.length !== (data.trash || []).length) { data.trash = kept; save(); }
  }

  // ── Save to storage ────────────────────────────────────────
  function save() {
    // Credentials write first and separately: they are ~100 bytes and must
    // land even when the main blob is too big for the remaining quota.
    saveSyncConfig();
    // An unreadable stored blob is left exactly as it is. Overwriting it with
    // the empty placeholder would look clean on the next boot — and a clean
    // empty dataset is one that happily pushes itself over the server copy.
    // The blob is only replaced once we hold real data again (setRawData from
    // sync/import) or the user explicitly resets.
    if (loadFailed) return;
    let durable = false;
    try {
      durable = storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Save error:', e); // e.g. a value that won't serialize
    }
    if (durable) { saveFailed = false; return; }
    // Silent degradation to an in-memory store is how edits "randomly"
    // vanished on the next reload. Say so, once per failure streak.
    if (!saveFailed) {
      saveFailed = true;
      try { window.dispatchEvent(new CustomEvent('state-save-failed')); } catch (_) {}
    }
  }

  // Is the in-memory dataset trustworthy enough to publish? A phantom empty
  // state from an unreadable blob must never be pushed over the server.
  function isHealthy() { return !loadFailed; }
  function healthReport() { return { loadFailed, saveFailed }; }

  // ── Deep merge helper ──────────────────────────────────────
  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  // ── Publish changes ────────────────────────────────────────
  function emit() {
    save();
    listeners.forEach(fn => fn(data));
    if (typeof Sync !== 'undefined') Sync.schedulePush();
  }

  // ── Subscribe ───────────────────────────────────────────────
  function subscribe(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter(f => f !== fn); };
  }

  // ── ID generator ────────────────────────────────────────────
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRIES (goals, habits, tasks, reminders, checkins)
  // ═══════════════════════════════════════════════════════════
  const entryDefaults = {
    type: 'task',
    title: '',
    description: '',
    projectId: null,
    tags: [],
    effort: 'medium',
    priority: 'medium',
    dueDate: null,
    scheduledDate: null,
    recurrence: null,
    completed: false,
    completedAt: null,
    targetValue: null,
    currentValue: null,
    unit: null,
    streak: 0,
    bestStreak: 0,
    blockedBy: [],
    blocks: [],
    emotion: null,
    linkedEntries: [],
    color: null,
    icon: null,
    archived: false,
    estimateMinutes: null,
    projectIds: [],    // multi-project membership; projectId stays = primary
    remindTime: null,  // HH:MM for reminders
    actualMinutes: null, // manual override of tracked time (estimate-vs-actual)
    lastNotified: null,  // date a reminder notification last fired (once per day)
    spawnedNextId: null, // recurring: id of the next occurrence already spawned
    archivedByProject: null, // archived as part of a project's subtree, by id
    pinned: false,       // on the shortlist, visible whatever the scope
    // ── Cade.txt link (see bridge.js) ──
    txtRoom: null,  // room whose todo list this task mirrors
    txtKey: null,   // normalized line text — identity across edits
    txtDone: null,  // the document's completion state at the last scan
  };

  function createEntry(partial) {
    const entry = {
      ...structuredClone(entryDefaults),
      id: uid(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...partial,
    };
    data.entries.push(entry);
    emit();
    return entry;
  }

  // A merge decides which side of a conflict wins by comparing updatedAt, so
  // the stamp has to mean "someone changed this". The bridge re-asserts link
  // fields on every scan; if a write that changes nothing still moved the
  // clock, this device would look newer than every other one forever, and
  // sync would read as dirty on every scan and raise conflicts of its own.
  function touched(current, updates) {
    return Object.keys(updates || {}).some(k =>
      JSON.stringify(current[k]) !== JSON.stringify(updates[k]));
  }
  function stamp(current, updates) {
    const next = { ...current, ...updates };
    if (touched(current, updates)) next.updatedAt = new Date().toISOString();
    return next;
  }

  function updateEntry(id, updates) {
    const idx = data.entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    data.entries[idx] = stamp(data.entries[idx], updates);
    emit();
    return data.entries[idx];
  }

  function deleteEntry(id) {
    const entry = getEntry(id);
    if (entry) trashPut('entry', entry);
    data.entries = data.entries.filter(e => e.id !== id);
    // Remove from blockedBy/blocks references
    data.entries.forEach(e => {
      if (e.blockedBy) e.blockedBy = e.blockedBy.filter(b => b !== id);
      if (e.blocks) e.blocks = e.blocks.filter(b => b !== id);
    });
    // Habit completions/skips of a deleted habit would otherwise keep
    // painting the heatmap forever; time sessions stay but get a title
    // snapshot so history never reads "Unknown".
    data.logs = data.logs.filter(l => !(l.entryId === id && (l.type === 'habit_completion' || l.type === 'habit_skip')));
    data.logs.forEach(l => {
      if (l.entryId === id && l.type === 'time_session' && !l.entryTitle) {
        l.entryTitle = entry?.title || null;
      }
    });
    emit();
  }

  function getEntry(id) {
    return data.entries.find(e => e.id === id);
  }

  // All project ids an entry belongs to (multi-project aware)
  function entryProjectIds(e) {
    if (Array.isArray(e.projectIds) && e.projectIds.length > 0) return e.projectIds;
    return e.projectId ? [e.projectId] : [];
  }

  // A project id plus every descendant project id
  function getProjectSubtreeIds(id) {
    const out = [id];
    const walk = (pid) => {
      data.projects.forEach(p => {
        if (p.parentId === pid) { out.push(p.id); walk(p.id); }
      });
    };
    walk(id);
    return out;
  }

  function getEntries(filter = {}) {
    // Project filters roll up: a parent project contains everything in its
    // sub-projects, and multi-project entries match through any membership.
    const subtree = filter.projectId ? getProjectSubtreeIds(filter.projectId) : null;
    return data.entries.filter(e => {
      // Archived entries are hidden everywhere unless explicitly requested.
      if (filter.archived === true) { if (!e.archived) return false; }
      else if (!filter.includeArchived && e.archived) return false;
      if (filter.type && e.type !== filter.type) return false;
      if (subtree && !entryProjectIds(e).some(pid => subtree.includes(pid))) return false;
      if (filter.completed !== undefined && e.completed !== filter.completed) return false;
      if (filter.tag && !(e.tags || []).includes(filter.tag)) return false;
      return true;
    });
  }

  // The shortlist. Pinned entries show on Today regardless of the workspace
  // or sub-project the app is scoped to — they are the handful you decided
  // matter this week, and scoping them away defeats the point.
  function togglePinned(id) {
    const e = getEntry(id);
    if (!e) return null;
    return updateEntry(id, { pinned: !e.pinned });
  }
  function getPinned() {
    return data.entries.filter(e => e.pinned && !e.archived && !e.completed);
  }

  function archiveEntry(id) { return updateEntry(id, { archived: true }); }
  function unarchiveEntry(id) { return updateEntry(id, { archived: false }); }

  function isHabitDoneToday(entryId) {
    const today = todayStr();
    return data.logs.some(l => l.entryId === entryId && l.type === 'habit_completion' && l.date === today);
  }

  // Next due date for a recurring task/reminder. Advances from the current
  // due date but always lands strictly in the future — an overdue weekly
  // task completed a month late doesn't backfill four stale occurrences.
  function nextOccurrenceDate(fromDate, recurrence) {
    if (!recurrence?.type) return null;
    const today = todayStr();
    const d = new Date((fromDate || today) + 'T00:00');
    const step = () => {
      switch (recurrence.type) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekdays':
          do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
          break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': {
          const day = new Date((fromDate || today) + 'T00:00').getDate();
          d.setDate(1);
          d.setMonth(d.getMonth() + 1);
          const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          d.setDate(Math.min(day, last)); // Jan 31 → Feb 28, not Mar 3
          break;
        }
        default: return false;
      }
      return true;
    };
    if (!step()) return null;
    let guard = 0;
    while (dateStr(d) <= today && guard++ < 400) { if (!step()) return null; }
    return dateStr(d);
  }

  // Completing a recurring task/reminder spawns its next occurrence as a
  // fresh entry — history keeps the completed one, journals stay attached.
  function spawnNextOccurrence(entry) {
    if (!entry.recurrence || entry.type === 'habit') return null;
    // guard: toggling done/undone/done again must not duplicate
    if (entry.spawnedNextId && getEntry(entry.spawnedNextId)) return null;
    const nextDue = nextOccurrenceDate(entry.dueDate, entry.recurrence);
    if (!nextDue) return null;
    const clone = createEntry({
      type: entry.type,
      title: entry.title,
      description: entry.description,
      projectId: entry.projectId,
      projectIds: [...(entry.projectIds || [])],
      tags: [...(entry.tags || [])],
      effort: entry.effort,
      priority: entry.priority,
      estimateMinutes: entry.estimateMinutes,
      remindTime: entry.remindTime,
      recurrence: structuredClone(entry.recurrence),
      blockedBy: [...(entry.blockedBy || [])],
      dueDate: nextDue,
    });
    updateEntry(entry.id, { spawnedNextId: clone.id });
    return clone;
  }

  function toggleComplete(id) {
    const entry = getEntry(id);
    if (!entry) return;
    if (entry.type === 'habit') {
      // Habits use date-based completion
      if (isHabitDoneToday(id)) {
        // Remove today's completion
        const today = todayStr();
        data.logs = data.logs.filter(l => !(l.entryId === id && l.type === 'habit_completion' && l.date === today));
        // Recalculate streak
        const s = calculateStreak(id);
        updateEntry(id, { streak: s.current, bestStreak: s.best, completed: false, completedAt: null });
      } else {
        logHabitCompletion(id);
      }
    } else {
      const completed = !entry.completed;
      updateEntry(id, { completed, completedAt: completed ? new Date().toISOString() : null });
      if (completed) spawnNextOccurrence(getEntry(id));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════════════
  const PROJECT_COLORS = [
    '#0f9598', '#e06d6d', '#6db4f0', '#6fcf97', '#f0d96a',
    '#a06df0', '#f0a06d', '#f06db0', '#8a8782', '#d4b73e',
  ];

  const PROJECT_ICONS = [
    'briefcase', 'home', 'book-open', 'dumbbell', 'heart',
    'code-2', 'palette', 'music', 'plane', 'shopping-cart',
    'graduation-cap', 'coffee', 'leaf', 'rocket', 'pen-tool',
    'flame', 'target', 'zap', 'star', 'compass',
  ];

  function createProject(partial) {
    const project = {
      id: uid(),
      name: 'New Project',
      color: PROJECT_COLORS[data.projects.length % PROJECT_COLORS.length],
      icon: PROJECT_ICONS[data.projects.length % PROJECT_ICONS.length],
      order: data.projects.length,
      parentId: null,
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      txtWorkspaceId: null, // linked Cade.txt workspace (top-level projects)
      txtRoom: null,        // linked Cade.txt room (sub-projects)
      txtHasList: false,    // that room currently holds a [ ] todo list
      ...partial,
    };
    data.projects.push(project);
    emit();
    return project;
  }

  function updateProject(id, updates) {
    const idx = data.projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.projects[idx] = stamp(data.projects[idx], updates);
    emit();
    return data.projects[idx];
  }

  function deleteProject(id) {
    const project = data.projects.find(p => p.id === id);
    if (project) trashPut('project', project);
    data.projects = data.projects.filter(p => p.id !== id);
    // Unassign entries and re-root any child projects
    data.entries.forEach(e => { if (e.projectId === id) e.projectId = null; });
    data.projects.forEach(p => { if (p.parentId === id) p.parentId = null; });
    emit();
  }

  function getProject(id) { return data.projects.find(p => p.id === id); }

  // Hierarchical order: parents first, children directly beneath (depth on
  // each returned copy for indented display). Archived hidden by default.
  function getProjects(opts = {}) {
    const list = data.projects.filter(p => opts.includeArchived || !p.archived);
    const ids = new Set(list.map(p => p.id));
    const byParent = {};
    list.forEach(p => {
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : '';
      (byParent[key] = byParent[key] || []).push(p);
    });
    const out = [];
    const walk = (pid, depth) => {
      (byParent[pid] || []).sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(p => {
        out.push({ ...p, depth });
        walk(p.id, depth + 1);
      });
    };
    walk('', 0);
    return out;
  }

  // Archiving a project takes its whole subtree with it: every sub-project
  // and every entry filed into any of them. Archiving the parent alone was
  // worse than useless — getProjects() re-roots a child whose parent has been
  // filtered out, so the thing you just archived reappeared immediately as a
  // handful of loose top-level projects with all their tasks intact.
  //
  // What the cascade touches is tagged with the project that took it, so
  // restoring brings back exactly that and leaves anything you had archived
  // on its own purposes alone.
  function setProjectTreeArchived(id, archived) {
    const ids = getProjectSubtreeIds(id);
    const inTree = new Set(ids);
    const stampTs = archived ? Date.now() : 0;

    ids.forEach(pid => {
      if (pid === id) return;
      const p = data.projects.find(x => x.id === pid);
      if (!p) return;
      if (archived) {
        if (!p.archived) updateProject(pid, { archived: true, archivedByProject: id, archTs: stampTs });
      } else if (p.archivedByProject === id) {
        updateProject(pid, { archived: false, archivedByProject: null });
      }
    });

    data.entries.slice().forEach(e => {
      if (!entryProjectIds(e).some(pid => inTree.has(pid))) return;
      if (archived) {
        if (!e.archived) updateEntry(e.id, { archived: true, archivedByProject: id });
      } else if (e.archivedByProject === id) {
        updateEntry(e.id, { archived: false, archivedByProject: null });
      }
    });

    updateProject(id, archived
      ? { archived: true, archTs: stampTs }
      : { archived: false, archivedByProject: null });
    return ids;
  }

  function archiveProject(id) { return setProjectTreeArchived(id, true); }
  function unarchiveProject(id) { return setProjectTreeArchived(id, false); }

  // Would setting `parentId` on `id` create a cycle?
  function wouldCycleProject(id, parentId) {
    let cur = parentId;
    let guard = 0;
    while (cur && guard++ < 100) {
      if (cur === id) return true;
      cur = getProject(cur)?.parentId || null;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // DAY PLANNER BLOCKS
  // { id, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', title,
  //   entryId?, projectId?, color?, kind:'agenda'|'tracked', notes }
  // ═══════════════════════════════════════════════════════════
  function createPlannerBlock(partial) {
    const block = {
      id: uid(),
      date: todayStr(),
      start: '09:00',
      end: '10:00',
      title: '',
      entryId: null,
      projectId: null,
      color: null,
      kind: 'agenda',
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...partial,
    };
    data.planner.push(block);
    emit();
    return block;
  }

  function updatePlannerBlock(id, updates) {
    const idx = data.planner.findIndex(b => b.id === id);
    if (idx === -1) return null;
    data.planner[idx] = stamp(data.planner[idx], updates);
    emit();
    return data.planner[idx];
  }

  function deletePlannerBlock(id) {
    const block = data.planner.find(b => b.id === id);
    if (block) trashPut('planner', block);
    data.planner = data.planner.filter(b => b.id !== id);
    emit();
  }

  function getPlannerBlock(id) { return data.planner.find(b => b.id === id); }

  // ═══════════════════════════════════════════════════════════
  // SCRATCHPAD — frictionless idea capture
  // ═══════════════════════════════════════════════════════════
  function addScratch(text) {
    const now = new Date().toISOString();
    const idea = { id: uid(), text: String(text).trim(), createdAt: now, updatedAt: now };
    if (!idea.text) return null;
    data.scratch.push(idea);
    emit();
    return idea;
  }

  function getScratch() {
    return [...data.scratch].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function deleteScratch(id) {
    const idea = data.scratch.find(s => s.id === id);
    if (idea) trashPut('scratch', idea);
    data.scratch = data.scratch.filter(s => s.id !== id);
    emit();
  }

  function clearScratch() {
    const n = data.scratch.length;
    data.scratch = [];
    emit();
    return n;
  }

  function getPlannerBlocks(filter = {}) {
    return data.planner.filter(b => {
      if (filter.date && b.date !== filter.date) return false;
      if (filter.dateFrom && b.date < filter.dateFrom) return false;
      if (filter.dateTo && b.date > filter.dateTo) return false;
      if (filter.kind && b.kind !== filter.kind) return false;
      return true;
    }).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }

  // ═══════════════════════════════════════════════════════════
  // TAGS
  // ═══════════════════════════════════════════════════════════
  const TAG_COLORS = ['yellow', 'green', 'blue', 'red', 'pink', 'purple', 'orange', 'gray'];

  function getOrCreateTag(name) {
    let tag = data.tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      tag = {
        id: uid(),
        name,
        color: TAG_COLORS[data.tags.length % TAG_COLORS.length],
        projectId: null, // null = usable everywhere
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.tags.push(tag);
      emit();
    }
    return tag;
  }

  // No arg → every tag. With a projectId → global tags + that project's tags.
  function getAllTags(projectId) {
    if (projectId === undefined) return data.tags;
    return data.tags.filter(t => !t.projectId || t.projectId === projectId);
  }

  function updateTag(id, updates) {
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return null;
    // Renames must follow through to every entry that carries the tag,
    // since entries reference tags by name.
    if (updates.name && updates.name !== tag.name) {
      const oldName = tag.name;
      data.entries.forEach(e => {
        if (e.tags?.includes(oldName)) {
          e.tags = e.tags.map(n => n === oldName ? updates.name : n);
        }
      });
    }
    // Assigned in place — callers hold the reference this returns.
    const moved = touched(tag, updates);
    Object.assign(tag, updates);
    if (moved) tag.updatedAt = new Date().toISOString();
    emit();
    return tag;
  }

  function deleteTag(id) {
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return;
    trashPut('tag', tag);
    data.tags = data.tags.filter(t => t.id !== id);
    data.entries.forEach(e => {
      if (e.tags?.includes(tag.name)) {
        e.tags = e.tags.filter(n => n !== tag.name);
      }
    });
    emit();
  }

  function tagUsageCount(id) {
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return 0;
    return data.entries.filter(e => e.tags?.includes(tag.name)).length;
  }

  // ═══════════════════════════════════════════════════════════
  // LOGS (habit completions, emotions, calories, time sessions)
  // ═══════════════════════════════════════════════════════════
  function createLog(partial) {
    const log = {
      id: uid(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...partial,
    };
    data.logs.push(log);
    emit();
    return log;
  }

  function deleteLog(id) {
    const log = data.logs.find(l => l.id === id);
    if (log) trashPut('log', log);
    data.logs = data.logs.filter(l => l.id !== id);
    emit();
  }

  function updateLog(id, updates) {
    const idx = data.logs.findIndex(l => l.id === id);
    if (idx === -1) return null;
    data.logs[idx] = stamp(data.logs[idx], updates);
    emit();
    return data.logs[idx];
  }

  function getLogs(filter = {}) {
    return data.logs.filter(l => {
      if (filter.type && l.type !== filter.type) return false;
      if (filter.entryId && l.entryId !== filter.entryId) return false;
      if (filter.date && l.date !== filter.date) return false;
      if (filter.dateFrom && l.date < filter.dateFrom) return false;
      if (filter.dateTo && l.date > filter.dateTo) return false;
      return true;
    });
  }

  // Habit day status: 'done' | 'skipped' | null (miss/empty)
  function habitStatusOn(entryId, date) {
    if (data.logs.some(l => l.entryId === entryId && l.type === 'habit_completion' && l.date === date)) return 'done';
    if (data.logs.some(l => l.entryId === entryId && l.type === 'habit_skip' && l.date === date)) return 'skipped';
    return null;
  }

  // Is the habit scheduled on this date? (weekday-scheduled habits are only
  // "due" on their configured days; everything else is daily)
  function isHabitScheduledOn(entryId, date) {
    const entry = getEntry(entryId);
    const dow = entry?.recurrence?.daysOfWeek;
    if (!dow || dow.length === 0) return true;
    return dow.includes(new Date(date + 'T00:00').getDay());
  }

  function recalcHabit(entryId) {
    const entry = getEntry(entryId);
    if (!entry) { emit(); return; }
    const s = calculateStreak(entryId);
    updateEntry(entryId, {
      streak: s.current,
      bestStreak: Math.max(entry.bestStreak || 0, s.best),
      completed: isHabitDoneToday(entryId),
    });
  }

  // Cycle a habit day: empty → done → skipped → empty.
  // Skipped = accepted miss: doesn't add to the streak, doesn't break it.
  function cycleHabitOnDate(entryId, date) {
    if (date > todayStr()) return; // no future completions
    const status = habitStatusOn(entryId, date);
    data.logs = data.logs.filter(l => !(l.entryId === entryId && (l.type === 'habit_completion' || l.type === 'habit_skip') && l.date === date));
    if (status === null) {
      data.logs.push({ id: uid(), type: 'habit_completion', entryId, date, value: 1, notes: '', createdAt: new Date().toISOString() });
    } else if (status === 'done') {
      data.logs.push({ id: uid(), type: 'habit_skip', entryId, date, value: 0, notes: '', createdAt: new Date().toISOString() });
    } // 'skipped' → cleared to empty
    recalcHabit(entryId);
  }

  // Back-compat: plain toggle between done and empty (card checkbox)
  function toggleHabitOnDate(entryId, date) {
    if (date > todayStr()) return;
    const status = habitStatusOn(entryId, date);
    data.logs = data.logs.filter(l => !(l.entryId === entryId && (l.type === 'habit_completion' || l.type === 'habit_skip') && l.date === date));
    if (status !== 'done') {
      data.logs.push({ id: uid(), type: 'habit_completion', entryId, date, value: 1, notes: '', createdAt: new Date().toISOString() });
    }
    recalcHabit(entryId);
  }

  function logHabitCompletion(entryId) {
    const today = todayStr();
    if (habitStatusOn(entryId, today) === 'done') return;
    // Marking done supersedes a skip on the same day
    data.logs = data.logs.filter(l => !(l.entryId === entryId && l.type === 'habit_skip' && l.date === today));
    createLog({ type: 'habit_completion', entryId, date: today, value: 1, notes: '' });
    recalcHabit(entryId);
  }

  // Day mood: exactly ONE per day — repeat taps update it in place.
  function logEmotion(emotion, notes = '') {
    const today = todayStr();
    const existing = data.logs.find(l => l.type === 'emotion' && l.date === today);
    if (existing) {
      existing.emotion = emotion;
      if (notes) existing.notes = notes;
      existing.createdAt = new Date().toISOString();
      emit();
      return existing;
    }
    return createLog({ type: 'emotion', entryId: null, date: today, value: null, notes, emotion });
  }

  // Check-in: a timestamped sub-log with its own emotion + energy (1-5).
  function logCheckin({ emotion = null, energy = null, notes = '' } = {}) {
    return createLog({ type: 'checkin', entryId: null, date: todayStr(), emotion, energy, notes });
  }

  // Wake / sleep times — one of each per day, updated in place.
  function logWakeSleep(kind, time) {
    const today = todayStr();
    const existing = data.logs.find(l => l.type === kind && l.date === today);
    if (existing) {
      existing.time = time;
      existing.createdAt = new Date().toISOString();
      emit();
      return existing;
    }
    return createLog({ type: kind, entryId: null, date: today, time });
  }

  function logCalories(calories, notes = '', meal = 'snack', macros = {}) {
    createLog({
      type: 'calorie', entryId: null, date: todayStr(), value: calories, notes, meal,
      protein: macros.protein ?? null, carbs: macros.carbs ?? null, fat: macros.fat ?? null,
    });
  }

  // Fire a configured quick-log shortcut (coffee, water, saved meal…).
  function logQuickShortcut(shortcutId) {
    const sc = (data.settings.quickShortcuts || []).find(s => s.id === shortcutId);
    if (!sc) return null;
    if (sc.calories != null && sc.calories > 0) {
      return createLog({ type: 'calorie', entryId: null, date: todayStr(), value: sc.calories, notes: sc.label, meal: sc.meal || 'snack', emoji: sc.emoji });
    }
    return createLog({ type: 'quick', entryId: null, date: todayStr(), value: null, notes: sc.label, emoji: sc.emoji });
  }

  function addQuickShortcut({ label, emoji = '⭐', calories = null, meal = 'snack' }) {
    const sc = { id: uid(), label, emoji, calories, meal };
    data.settings.quickShortcuts = [...(data.settings.quickShortcuts || []), sc];
    emit();
    return sc;
  }

  function deleteQuickShortcut(id) {
    data.settings.quickShortcuts = (data.settings.quickShortcuts || []).filter(s => s.id !== id);
    emit();
  }

  function logTimeSession(entryId, duration, notes = '') {
    // Title snapshot survives entry deletion — history never shows "Unknown"
    const entry = getEntry(entryId);
    createLog({ type: 'time_session', entryId, entryTitle: entry?.title || null, date: todayStr(), value: duration, notes });
  }

  // Actual time spent on an entry, in minutes: manual override wins,
  // otherwise the sum of tracked sessions.
  function actualMinutesFor(entry) {
    if (entry.actualMinutes != null) return entry.actualMinutes;
    const secs = data.logs
      .filter(l => l.type === 'time_session' && l.entryId === entry.id)
      .reduce((s, l) => s + (l.value || 0), 0);
    return secs >= 60 ? Math.round(secs / 60) : null;
  }

  function getTodayCalories() {
    return data.logs
      .filter(l => l.type === 'calorie' && l.date === todayStr())
      .reduce((sum, l) => sum + (l.value || 0), 0);
  }

  function getTodayEmotion() {
    const emotions = data.logs.filter(l => l.type === 'emotion' && l.date === todayStr());
    return emotions.length > 0 ? emotions[emotions.length - 1] : null;
  }

  // ═══════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════
  function getSettings() { return data.settings; }

  function updateSettings(updates) {
    data.settings = deepMerge(data.settings, updates);
    emit();
    return data.settings;
  }

  // ═══════════════════════════════════════════════════════════
  // STREAK / RETENTION CALCULATIONS
  // ═══════════════════════════════════════════════════════════
  function getHabitCompletions(entryId) {
    return data.logs
      .filter(l => l.entryId === entryId && l.type === 'habit_completion')
      .map(l => l.date)
      .sort();
  }

  function getHabitSkips(entryId) {
    return data.logs
      .filter(l => l.entryId === entryId && l.type === 'habit_skip')
      .map(l => l.date)
      .sort();
  }

  // Streak semantics:
  //  done          → +1
  //  skipped       → bridges (no +1, no break)
  //  not scheduled → bridges (weekday-scheduled habits)
  //  scheduled+missed → breaks
  function calculateStreak(entryId) {
    const completions = getHabitCompletions(entryId);
    if (completions.length === 0) return { current: 0, best: 0, retention30: 0 };
    const done = new Set(completions);
    const skipped = new Set(getHabitSkips(entryId));
    const scheduled = (ds) => isHabitScheduledOn(entryId, ds);

    // Current: walk back from today (an unresolved today doesn't break yet)
    let current = 0;
    const walker = new Date();
    if (!done.has(todayStr())) walker.setDate(walker.getDate() - 1);
    for (let guard = 0; guard < 400; guard++) {
      const ds = dateStr(walker);
      if (done.has(ds)) current++;
      else if (skipped.has(ds) || !scheduled(ds)) { /* bridge */ }
      else break;
      walker.setDate(walker.getDate() - 1);
    }

    // Best: scan chronologically from the first completion to today
    let best = 0, temp = 0;
    const cur = new Date(completions[0] + 'T00:00');
    const end = new Date();
    for (let guard = 0; cur <= end && guard < 3700; guard++) {
      const ds = dateStr(cur);
      if (done.has(ds)) { temp++; best = Math.max(best, temp); }
      else if (skipped.has(ds) || !scheduled(ds)) { /* bridge */ }
      else temp = 0;
      cur.setDate(cur.getDate() + 1);
    }

    // 30-day retention over days that actually counted (scheduled, not skipped)
    let schedCount = 0, done30 = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = dateStr(d);
      if (!scheduled(ds) || skipped.has(ds)) continue;
      schedCount++;
      if (done.has(ds)) done30++;
    }

    return { current, best, retention30: schedCount > 0 ? Math.round((done30 / schedCount) * 100) : 0 };
  }

  // ═══════════════════════════════════════════════════════════
  // DATE HELPERS
  // ═══════════════════════════════════════════════════════════
  function todayStr() { return dateStr(new Date()); }
  function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return dateStr(d);
  }
  function dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function daysBetween(d1, d2) {
    const date1 = new Date(d1);
    const date2 = new Date(d2);
    return Math.round((date2 - date1) / (1000 * 60 * 60 * 24));
  }

  // ═══════════════════════════════════════════════════════════
  // IMPORT / EXPORT
  // ═══════════════════════════════════════════════════════════
  function exportData() {
    return JSON.stringify(data, null, 2);
  }

  function importData(jsonStr) {
    try {
      // setRawData, not a raw assignment: a backup file carries whatever
      // credentials the exporting device had, and importing must not
      // repoint (or disconnect) the device doing the import.
      setRawData(JSON.parse(jsonStr));
      return true;
    } catch (e) { return false; }
  }

  function getRawData() { return data; }

  // Adopt a dataset from sync/import. Device-local settings are carried over
  // from the running instance rather than taken from the payload — a remote
  // device's credentials (or its empty ones) replacing ours is what silently
  // disconnected this device and made its data look deleted.
  function setRawData(newData) {
    const localOnly = {};
    DEVICE_LOCAL_SETTINGS.forEach(k => { localOnly[k] = data.settings[k]; });
    data = migrate(deepMerge(structuredClone(defaultData), newData));
    DEVICE_LOCAL_SETTINGS.forEach(k => { data.settings[k] = localOnly[k]; });
    loadFailed = false; // we now hold a real dataset again
    clearUndo();
    emit();
  }

  // The payload that goes over the wire: same data, minus anything that
  // describes this device.
  function getSyncableData() {
    const clone = structuredClone(data);
    DEVICE_LOCAL_SETTINGS.forEach(k => { delete clone.settings[k]; });
    return clone;
  }

  // NOTE: this app deliberately ships NO sample data. A first run starts
  // empty. Demo goals/habits/tasks used to be seeded here, and every time a
  // device lost its local blob the seed refilled it — then the next connect
  // merged that fake content into the real synced dataset.

  return {
    subscribe, emit, save,
    createEntry, updateEntry, deleteEntry, getEntry, getEntries, toggleComplete, isHabitDoneToday,
    archiveEntry, unarchiveEntry, togglePinned, getPinned, toggleHabitOnDate, cycleHabitOnDate,
    habitStatusOn, isHabitScheduledOn, resetData,
    nextOccurrenceDate,
    entryProjectIds, getProjectSubtreeIds,
    // Undo / redo — checkpoints are taken by the UI, one per user action.
    checkpoint, dropCheckpointIfUnchanged, clearUndo, undo, redo, canUndo, canRedo, undoLabel, redoLabel,
    // Trash
    getTrash, restoreFromTrash, purgeFromTrash, emptyTrash, expireTrash, TRASH_DAYS,
    createProject, updateProject, deleteProject, getProject, getProjects,
    archiveProject, unarchiveProject, wouldCycleProject,
    getOrCreateTag, getAllTags, updateTag, deleteTag, tagUsageCount,
    createPlannerBlock, updatePlannerBlock, deletePlannerBlock, getPlannerBlock, getPlannerBlocks,
    addScratch, getScratch, deleteScratch, clearScratch,
    createLog, deleteLog, updateLog, getLogs, logHabitCompletion, logEmotion, logCheckin, logWakeSleep,
    logCalories, logQuickShortcut, addQuickShortcut, deleteQuickShortcut, logTimeSession,
    getTodayCalories, getTodayEmotion, actualMinutesFor,
    getHabitCompletions, getHabitSkips, calculateStreak, getHabitRetention: (id) => calculateStreak(id),
    getSettings, updateSettings,
    exportData, importData, getRawData, setRawData, getSyncableData,
    isHealthy, healthReport,
    todayStr, yesterdayStr, dateStr, daysBetween,
    PROJECT_COLORS, PROJECT_ICONS, TAG_COLORS,
    uid,
  };
})();
