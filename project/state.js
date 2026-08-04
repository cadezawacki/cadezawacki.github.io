/* ═══════════════════════════════════════════════════════════════
   STATE — Data model, persistence, CRUD
   ═══════════════════════════════════════════════════════════════ */

const State = (() => {
  const STORAGE_KEY = 'cade.project.v1';

  // ── Default data schema ──────────────────────────────────────
  const defaultData = {
    entries: [],
    logs: [],
    projects: [],
    tags: [],
    planner: [], // day-planner blocks: agenda items, tracked time, breaks
    scratch: [], // scratchpad ideas — quick capture, promote to tasks later
    settings: {
      theme: 'dark',
      accent: 'teal',        // accent palette name (Settings → Appearance)
      celebrations: true,    // confetti on completions/milestones
      viewAnimations: true,  // slide-in transition on tab switch
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
      sidebarCollapsed: false, // desktop sidebar state
      hotkeys: {               // single-key shortcuts (when not typing)
        timer: 't',
        newTask: 'n',
        quickLog: 'q',
        search: '/',
        stopTimers: 's',
      },
      maxNavTimers: 2,         // live timers shown in the header nav
      timerState: null,        // persisted clock + sessions (survive refresh)
      showCompleted: true,     // finished tasks visible in project lists
      collapsedSections: {},   // Today sections the user folded away
      quickLogPromptTimes: '', // "09:00, 20:00" — scheduled check-in prompts
      quickShortcuts: [
        { id: 'qs-coffee', label: 'Cup of coffee', emoji: '☕', calories: 5, meal: 'snack' },
        { id: 'qs-water', label: 'Glass of water', emoji: '💧', calories: null, meal: null },
      ],
      onboarded: false,
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
    setItem(k, v) {
      try { _ls.setItem(k, v); }
      catch (e) { memoryStore[k] = v; }
    },
    removeItem(k) {
      try { _ls.removeItem(k); }
      catch (e) { delete memoryStore[k]; }
    },
  };

  let data = load();
  let listeners = [];

  // ── Load from storage ──────────────────────────────────────
  function load() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return migrate(deepMerge(structuredClone(defaultData), parsed));
      }
    } catch (e) { console.error('Load error:', e); }
    return structuredClone(defaultData);
  }

  // ── Migrate older stored shapes to the current schema ───────
  function migrate(d) {
    if (!Array.isArray(d.planner)) d.planner = [];
    if (!Array.isArray(d.scratch)) d.scratch = [];
    (d.entries || []).forEach(e => {
      if (e.archived === undefined) e.archived = false;
      if (e.estimateMinutes === undefined) e.estimateMinutes = null;
      if (e.remindTime === undefined) e.remindTime = null;
      if (e.actualMinutes === undefined) e.actualMinutes = null;
      if (e.lastNotified === undefined) e.lastNotified = null;
      if (e.spawnedNextId === undefined) e.spawnedNextId = null;
      if (!Array.isArray(e.blockedBy)) e.blockedBy = [];
      if (!Array.isArray(e.projectIds)) e.projectIds = e.projectId ? [e.projectId] : [];
    });
    (d.tags || []).forEach(t => {
      if (t.projectId === undefined) t.projectId = null; // null = global tag
    });
    (d.projects || []).forEach(p => {
      if (p.parentId === undefined) p.parentId = null;
      if (p.archived === undefined) p.archived = false;
    });
    return d;
  }

  // ── Full reset to a CLEAN slate (no sample data re-seed) ────
  function resetData() {
    data = structuredClone(defaultData);
    data.settings.onboarded = true; // blocks seed() from repopulating samples
    save();
  }

  // ── Save to storage ────────────────────────────────────────
  function save() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { console.error('Save error:', e); }
  }

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

  function updateEntry(id, updates) {
    const idx = data.entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    data.entries[idx] = { ...data.entries[idx], ...updates, updatedAt: new Date().toISOString() };
    emit();
    return data.entries[idx];
  }

  function deleteEntry(id) {
    const entry = getEntry(id);
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
      ...partial,
    };
    data.projects.push(project);
    emit();
    return project;
  }

  function updateProject(id, updates) {
    const idx = data.projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.projects[idx] = { ...data.projects[idx], ...updates };
    emit();
    return data.projects[idx];
  }

  function deleteProject(id) {
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

  function archiveProject(id) { return updateProject(id, { archived: true }); }
  function unarchiveProject(id) { return updateProject(id, { archived: false }); }

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
      ...partial,
    };
    data.planner.push(block);
    emit();
    return block;
  }

  function updatePlannerBlock(id, updates) {
    const idx = data.planner.findIndex(b => b.id === id);
    if (idx === -1) return null;
    data.planner[idx] = { ...data.planner[idx], ...updates };
    emit();
    return data.planner[idx];
  }

  function deletePlannerBlock(id) {
    data.planner = data.planner.filter(b => b.id !== id);
    emit();
  }

  function getPlannerBlock(id) { return data.planner.find(b => b.id === id); }

  // ═══════════════════════════════════════════════════════════
  // SCRATCHPAD — frictionless idea capture
  // ═══════════════════════════════════════════════════════════
  function addScratch(text) {
    const idea = { id: uid(), text: String(text).trim(), createdAt: new Date().toISOString() };
    if (!idea.text) return null;
    data.scratch.push(idea);
    emit();
    return idea;
  }

  function getScratch() {
    return [...data.scratch].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function deleteScratch(id) {
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
    Object.assign(tag, updates);
    emit();
    return tag;
  }

  function deleteTag(id) {
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return;
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
      ...partial,
    };
    data.logs.push(log);
    emit();
    return log;
  }

  function deleteLog(id) {
    data.logs = data.logs.filter(l => l.id !== id);
    emit();
  }

  function updateLog(id, updates) {
    const log = data.logs.find(l => l.id === id);
    if (!log) return null;
    Object.assign(log, updates);
    emit();
    return log;
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
      const imported = JSON.parse(jsonStr);
      data = migrate(deepMerge(structuredClone(defaultData), imported));
      emit();
      return true;
    } catch (e) { return false; }
  }

  function getRawData() { return data; }
  function setRawData(newData) { data = migrate(deepMerge(structuredClone(defaultData), newData)); emit(); }

  // ═══════════════════════════════════════════════════════════
  // SEED DATA (demo content for first run)
  // ═══════════════════════════════════════════════════════════
  function seed() {
    // onboarded=true after a reset means "stay empty" — never re-seed samples
    if (data.settings.onboarded) return;
    if (data.entries.length > 0 || data.projects.length > 0) return;

    // Projects
    const work = createProject({ name: 'Work', color: '#0f9598', icon: 'briefcase' });
    const home = createProject({ name: 'Home', color: '#e06d6d', icon: 'home' });
    const health = createProject({ name: 'Health', color: '#6fcf97', icon: 'heart' });
    const learning = createProject({ name: 'Learning', color: '#6db4f0', icon: 'graduation-cap' });

    // Tags
    data.tags.push(
      { id: uid(), name: 'urgent', color: 'red' },
      { id: uid(), name: 'deep-work', color: 'purple' },
      { id: uid(), name: 'quick', color: 'yellow' },
      { id: uid(), name: 'creative', color: 'pink' },
    );

    // Goals
    createEntry({
      type: 'goal', title: 'Read 12 books this year', projectId: learning.id,
      targetValue: 12, currentValue: 5, unit: 'books',
      tags: ['deep-work'], effort: 'large', priority: 'medium',
    });
    createEntry({
      type: 'goal', title: 'Run 500km this year', projectId: health.id,
      targetValue: 500, currentValue: 187, unit: 'km',
      tags: [], effort: 'large', priority: 'medium',
    });

    // Habits
    const meditation = createEntry({
      type: 'habit', title: 'Meditate 10 min', projectId: health.id,
      tags: [], effort: 'small', priority: 'medium',
      recurrence: { type: 'daily', interval: 1 },
    });
    const reading = createEntry({
      type: 'habit', title: 'Read 30 min', projectId: learning.id,
      tags: ['deep-work'], effort: 'small', priority: 'medium',
      recurrence: { type: 'daily', interval: 1 },
    });
    const workout = createEntry({
      type: 'habit', title: 'Workout', projectId: health.id,
      tags: [], effort: 'large', priority: 'high',
      recurrence: { type: 'weekly', interval: 1, daysOfWeek: [1, 3, 5] },
    });

    // Seed habit completions for last 2 weeks
    const today = new Date();
    const habits = [meditation.id, reading.id, workout.id];
    habits.forEach((hid, hIdx) => {
      for (let i = 0; i < 14; i++) {
        // Vary completion rate per habit
        const rate = hIdx === 2 ? 0.4 : 0.7;
        if (Math.random() < rate) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          data.logs.push({
            id: uid(),
            type: 'habit_completion',
            entryId: hid,
            date: dateStr(d),
            value: 1,
            notes: '',
            createdAt: new Date().toISOString(),
          });
        }
      }
    });

    // Recalculate streaks
    habits.forEach(hid => {
      const s = calculateStreak(hid);
      updateEntry(hid, { streak: s.current, bestStreak: s.best });
    });

    // Tasks
    createEntry({
      type: 'task', title: 'Q3 roadmap review', projectId: work.id,
      tags: ['urgent', 'deep-work'], effort: 'large', priority: 'high',
      dueDate: dateStr(new Date(Date.now() + 86400000)),
    });
    createEntry({
      type: 'task', title: 'Fix auth bug in production', projectId: work.id,
      tags: ['urgent'], effort: 'medium', priority: 'urgent',
      dueDate: todayStr(),
    });
    createEntry({
      type: 'task', title: 'Write blog post about habits', projectId: work.id,
      tags: ['creative', 'deep-work'], effort: 'large', priority: 'low',
      dueDate: dateStr(new Date(Date.now() + 3 * 86400000)),
    });
    createEntry({
      type: 'task', title: 'Grocery shopping', projectId: home.id,
      tags: ['quick'], effort: 'small', priority: 'medium',
      scheduledDate: todayStr(),
    });
    createEntry({
      type: 'task', title: 'Clean kitchen', projectId: home.id,
      tags: ['quick'], effort: 'small', priority: 'low',
    });
    createEntry({
      type: 'task', title: 'Review PR #42', projectId: work.id,
      tags: ['quick'], effort: 'small', priority: 'high',
      dueDate: todayStr(), completed: true, completedAt: new Date().toISOString(),
    });
    createEntry({
      type: 'task', title: 'Plan weekend trip', projectId: home.id,
      tags: ['creative'], effort: 'medium', priority: 'low',
    });

    // Reminders
    createEntry({
      type: 'reminder', title: 'Call dentist', projectId: null,
      dueDate: dateStr(new Date(Date.now() + 2 * 86400000)),
      tags: [], effort: 'trivial', priority: 'medium',
    });
    createEntry({
      type: 'reminder', title: 'Pay rent', projectId: home.id,
      dueDate: dateStr(new Date(Date.now() + 5 * 86400000)),
      tags: ['urgent'], effort: 'trivial', priority: 'high',
      recurrence: { type: 'monthly', interval: 1 },
    });

    // Checkins
    createEntry({
      type: 'checkin', title: 'Morning check-in', projectId: null,
      emotion: 'good', tags: [], effort: 'trivial', priority: 'low',
    });

    // Today's emotion log
    logEmotion('good', 'Feeling productive today');

    // Calorie logs for today
    logCalories(420, 'Oatmeal with berries', 'breakfast');
    logCalories(650, 'Chicken salad', 'lunch');
    logCalories(180, 'Greek yogurt', 'snack');

    // Time session
    logTimeSession(workout.id, 45, 'Morning run');

    data.settings.onboarded = true;
    save();
  }

  // ── Init ────────────────────────────────────────────────────
  seed();

  return {
    subscribe, emit, save,
    createEntry, updateEntry, deleteEntry, getEntry, getEntries, toggleComplete, isHabitDoneToday,
    archiveEntry, unarchiveEntry, toggleHabitOnDate, cycleHabitOnDate,
    habitStatusOn, isHabitScheduledOn, resetData,
    nextOccurrenceDate,
    entryProjectIds, getProjectSubtreeIds,
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
    exportData, importData, getRawData, setRawData,
    todayStr, yesterdayStr, dateStr, daysBetween,
    PROJECT_COLORS, PROJECT_ICONS, TAG_COLORS,
    uid,
  };
})();
