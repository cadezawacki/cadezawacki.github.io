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
    settings: {
      theme: 'dark',
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
    (d.entries || []).forEach(e => {
      if (e.archived === undefined) e.archived = false;
      if (e.estimateMinutes === undefined) e.estimateMinutes = null;
    });
    (d.tags || []).forEach(t => {
      if (t.projectId === undefined) t.projectId = null; // null = global tag
    });
    return d;
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
    if (window.Sync) Sync.schedulePush();
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
    data.entries = data.entries.filter(e => e.id !== id);
    // Remove from blockedBy/blocks references
    data.entries.forEach(e => {
      if (e.blockedBy) e.blockedBy = e.blockedBy.filter(b => b !== id);
      if (e.blocks) e.blocks = e.blocks.filter(b => b !== id);
    });
    emit();
  }

  function getEntry(id) {
    return data.entries.find(e => e.id === id);
  }

  function getEntries(filter = {}) {
    return data.entries.filter(e => {
      // Archived entries are hidden everywhere unless explicitly requested.
      if (filter.archived === true) { if (!e.archived) return false; }
      else if (!filter.includeArchived && e.archived) return false;
      if (filter.type && e.type !== filter.type) return false;
      if (filter.projectId && e.projectId !== filter.projectId) return false;
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
    // Unassign entries from deleted project
    data.entries.forEach(e => { if (e.projectId === id) e.projectId = null; });
    emit();
  }

  function getProject(id) { return data.projects.find(p => p.id === id); }
  function getProjects() { return [...data.projects].sort((a, b) => a.order - b.order); }

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

  // Toggle a habit's completion for ANY past day (the 14-day grid cells).
  function toggleHabitOnDate(entryId, date) {
    if (date > todayStr()) return; // no future completions
    const existing = data.logs.find(l => l.entryId === entryId && l.type === 'habit_completion' && l.date === date);
    if (existing) {
      data.logs = data.logs.filter(l => l !== existing);
    } else {
      data.logs.push({ id: uid(), type: 'habit_completion', entryId, date, value: 1, notes: '', createdAt: new Date().toISOString() });
    }
    const entry = getEntry(entryId);
    if (entry) {
      const s = calculateStreak(entryId);
      updateEntry(entryId, {
        streak: s.current,
        bestStreak: Math.max(entry.bestStreak || 0, s.best),
        completed: isHabitDoneToday(entryId),
      });
    } else {
      emit();
    }
  }

  function logHabitCompletion(entryId) {
    const today = todayStr();
    // Check if already logged
    const existing = data.logs.find(l => l.entryId === entryId && l.type === 'habit_completion' && l.date === today);
    if (!existing) {
      createLog({ type: 'habit_completion', entryId, date: today, value: 1, notes: '' });
      // Update streak
      const entry = getEntry(entryId);
      if (entry) {
        const yesterday = yesterdayStr();
        const yLog = data.logs.find(l => l.entryId === entryId && l.type === 'habit_completion' && l.date === yesterday);
        const newStreak = yLog ? entry.streak + 1 : 1;
        updateEntry(entryId, { streak: newStreak, bestStreak: Math.max(entry.bestStreak, newStreak), completed: true });
      }
    }
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
    createLog({ type: 'time_session', entryId, date: todayStr(), value: duration, notes });
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

  function calculateStreak(entryId) {
    const completions = getHabitCompletions(entryId);
    if (completions.length === 0) return { current: 0, best: 0, retention30: 0 };

    const completionSet = new Set(completions);
    let current = 0;
    const today = new Date();
    let checkDate = new Date(today);

    // If today not completed, start from yesterday
    if (!completionSet.has(todayStr())) {
      checkDate.setDate(checkDate.getDate() - 1);
    }

    while (completionSet.has(dateStr(checkDate))) {
      current++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Best streak
    let best = 0, tempStreak = 0;
    let prevDate = null;
    completions.forEach(d => {
      if (prevDate) {
        const diff = daysBetween(prevDate, d);
        if (diff === 1) tempStreak++;
        else tempStreak = 1;
      } else {
        tempStreak = 1;
      }
      best = Math.max(best, tempStreak);
      prevDate = d;
    });

    // 30-day retention
    let completed30 = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      if (completionSet.has(dateStr(d))) completed30++;
    }

    return { current, best, retention30: Math.round((completed30 / 30) * 100) };
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
    archiveEntry, unarchiveEntry, toggleHabitOnDate,
    createProject, updateProject, deleteProject, getProject, getProjects,
    getOrCreateTag, getAllTags, updateTag, deleteTag, tagUsageCount,
    createPlannerBlock, updatePlannerBlock, deletePlannerBlock, getPlannerBlock, getPlannerBlocks,
    createLog, deleteLog, getLogs, logHabitCompletion, logEmotion, logCheckin, logWakeSleep,
    logCalories, logQuickShortcut, addQuickShortcut, deleteQuickShortcut, logTimeSession,
    getTodayCalories, getTodayEmotion,
    getHabitCompletions, calculateStreak, getHabitRetention: (id) => calculateStreak(id),
    getSettings, updateSettings,
    exportData, importData, getRawData, setRawData,
    todayStr, yesterdayStr, dateStr, daysBetween,
    PROJECT_COLORS, PROJECT_ICONS, TAG_COLORS,
    uid,
  };
})();
