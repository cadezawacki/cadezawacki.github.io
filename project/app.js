/* ═══════════════════════════════════════════════════════════════
   APP — Main orchestration, routing, views, modals
   ═══════════════════════════════════════════════════════════════ */

const App = (() => {
  let currentTab = 'today';
  let editingEntryId = null;
  let entryTypeDraft = 'task';

  // ═══════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════
  let toastTimer = null;

  // `opts.undo` puts an Undo button in the toast and keeps it up longer —
  // the window in which a mis-tap is still obviously a mis-tap.
  function toast(msg, opts = {}) {
    const el = document.getElementById('toast');
    clearTimeout(toastTimer);
    if (opts.undo) {
      el.innerHTML = `<span class="toast-msg"></span>` +
        `<button type="button" class="toast-action" onclick="App.undo()">Undo</button>`;
      el.querySelector('.toast-msg').textContent = msg;
    } else {
      el.textContent = msg;
    }
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), opts.undo ? 6000 : 2500);
  }

  // ═══════════════════════════════════════════════════════════
  // UNDO
  // ═══════════════════════════════════════════════════════════
  // One checkpoint per thing a person did. Taken HERE rather than inside
  // State because a single action is often several mutations — archiving a
  // project walks a subtree; completing a recurring task spawns the next one
  // — and undo should step back over the action, not over its pieces.
  //
  // `run` performs the action and reports whether it changed anything, so an
  // action that no-ops leaves no checkpoint behind for undo to land on.
  function undoable(label, run, opts = {}) {
    State.checkpoint(label);
    const result = run();
    if (State.dropCheckpointIfUnchanged()) return result;
    if (opts.quiet !== true) toast(label, { undo: true });
    return result;
  }

  function undo() {
    const label = State.undo();
    if (!label) { toast('Nothing to undo'); return; }
    render();
    // The Cade.txt side of a reverted completion has to be reverted too, or
    // the document keeps the tick that this app has just taken back.
    resyncBridgedCompletions();
    toast('Undone — ' + label);
  }

  function redo() {
    const label = State.redo();
    if (!label) { toast('Nothing to redo'); return; }
    render();
    resyncBridgedCompletions();
    toast('Redone — ' + label);
  }

  // After an undo the entries hold the OLD completion states; anything whose
  // recorded document state no longer matches gets pushed back to the room.
  function resyncBridgedCompletions() {
    if (typeof Bridge === 'undefined') return;
    State.getEntries({ includeArchived: true })
      .filter(e => e.txtRoom && e.txtKey && e.txtDone !== undefined && !!e.txtDone !== !!e.completed)
      .slice(0, 50)
      .forEach(e => { Bridge.pushCompletion(e).catch(() => {}); });
  }

  function icon(name, size = 18) {
    return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
  }

  // Every view here builds HTML strings and assigns them to innerHTML, so
  // any free text — titles, project names, tags, notes — has to come through
  // this first. Quotes are escaped too: plenty of these land inside
  // attributes (title="…"), where &lt;/&gt; alone would not save us.
  //
  // This matters more than it used to. Task titles now arrive from Cade.txt
  // documents, which sync between devices — so an unescaped title is not
  // just a user typing at themselves, it is content crossing a trust
  // boundary into this origin, where the encryption keys live.
  const escHtml = window.escapeHtml;

  // Single-line-style textareas wrap + grow instead of scrolling sideways.
  // Modern browsers do it in CSS (field-sizing: content); this is the
  // fallback for the rest.
  let growNative = null;
  function autoGrow(el) {
    if (!el) return;
    if (growNative === null) {
      growNative = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('field-sizing', 'content');
    }
    if (growNative) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function refreshIcons() {
    if (window.lucide) lucide.createIcons();
  }

  function effortLabel(effort) {
    const map = { trivial: 'XS', small: 'S', medium: 'M', large: 'L', xl: 'XL' };
    return map[effort] || effort;
  }

  function priorityColor(priority) {
    const map = { urgent: 'red', high: 'orange', medium: 'yellow', low: 'gray' };
    return map[priority] || 'gray';
  }

  // Minimal line icons for moods (replaces emoji)
  const MOOD_ICONS = { great: 'laugh', good: 'smile', okay: 'meh', low: 'frown', bad: 'angry' };

  function estimateLabel(min) {
    if (!min) return '';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h${m}m` : `${h}h`;
  }

  function formatDueDate(dateStr) {
    if (!dateStr) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + 'T00:00');
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff < 0) return `${Math.abs(diff)}d overdue`;
    if (diff < 7) return d.toLocaleDateString('en', { weekday: 'short' });
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }

  function isToday(dateStr) {
    return dateStr === State.todayStr();
  }

  function isOverdue(dateStr) {
    if (!dateStr) return false;
    return dateStr < State.todayStr();
  }

  function daysUntil(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(dateStr + 'T00:00') - today) / 86400000);
  }

  // "Next best" score, 0–100: priority + due-date proximity + low-effort
  // bonus. Future-due tasks stay visible but rank below today's.
  function taskScore(t) {
    const priPts = { urgent: 40, high: 30, medium: 18, low: 8 }[t.priority] ?? 18;
    let duePts = 10; // unscheduled baseline
    if (t.dueDate) {
      const diff = daysUntil(t.dueDate);
      duePts = diff < 0 ? 40 : diff === 0 ? 35 : diff === 1 ? 25 : diff <= 3 ? 18 : diff <= 7 ? 10 : 5;
    }
    const effPts = { trivial: 20, small: 16, medium: 10, large: 5, xl: 2 }[t.effort] ?? 10;
    return Math.min(100, priPts + duePts + effPts);
  }

  // The same arithmetic taskScore does, said in words. Next Best Task used to
  // show a conclusion with no working, which is either trusted blindly or
  // ignored — and there was no way to tell it that it was wrong.
  function scoreReasons(t) {
    const out = [];
    const pri = { urgent: 40, high: 30, medium: 18, low: 8 }[t.priority] ?? 18;
    if (t.priority && t.priority !== 'medium') out.push({ text: t.priority + ' priority', pts: pri });
    if (t.dueDate) {
      const diff = daysUntil(t.dueDate);
      out.push({
        text: diff < 0 ? `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} overdue`
          : diff === 0 ? 'due today' : diff === 1 ? 'due tomorrow' : `due in ${diff} days`,
        pts: diff < 0 ? 40 : diff === 0 ? 35 : diff === 1 ? 25 : diff <= 3 ? 18 : diff <= 7 ? 10 : 5,
      });
    } else {
      out.push({ text: 'no due date', pts: 10 });
    }
    const eff = { trivial: 20, small: 16, medium: 10, large: 5, xl: 2 }[t.effort] ?? 10;
    if (t.effort && t.effort !== 'medium') out.push({ text: t.effort + ' effort', pts: eff });
    if (t.estimateMinutes) out.push({ text: 'about ' + estimateLabel(t.estimateMinutes), pts: 0 });
    return out.sort((a, b) => b.pts - a.pts);
  }

  function openWhyThis(id) {
    const t = State.getEntry(id);
    if (!t) return;
    const reasons = scoreReasons(t);
    // Who it beat, and by how much — the comparison is the actual answer.
    const rivals = State.getEntries({ type: 'task', completed: false })
      .filter(x => x.id !== id && !isBlocked(x) && inScope(x))
      .sort((a, b) => taskScore(b) - taskScore(a))
      .slice(0, 3);
    showModal('Why this one?', `
      <p class="text-sm" style="margin-bottom:var(--space-3);">
        <strong>${escHtml(t.title)}</strong> scores <strong>${taskScore(t)}</strong> out of 100.
      </p>
      <div class="why-list">
        ${reasons.map(r => `<div class="why-row">
          <span class="why-text">${escHtml(r.text)}</span>
          <span class="why-pts">${r.pts ? '+' + r.pts : '—'}</span>
        </div>`).join('')}
      </div>
      ${rivals.length ? `<div class="divider"></div>
        <label class="form-label">Runners-up</label>
        <div class="why-list">
          ${rivals.map(r => `<div class="why-row">
            <span class="why-text truncate">${escHtml(r.title)}</span>
            <span class="why-pts">${taskScore(r)}</span>
          </div>`).join('')}
        </div>` : ''}
      <p class="text-xs text-faint" style="margin-top:var(--space-3);line-height:1.6;">
        Priority, how close the deadline is, and how small the job is. Blocked
        tasks are never suggested. Change a priority or an estimate and this
        moves — it is arithmetic, not an opinion.
      </p>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`,
      `<button class="btn btn-primary" onclick="App.editEntry('${id}')">Edit this task</button>`,
    ]);
  }

  function timeToMin(t) {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  function minToTime(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function offsetDateStr(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return State.dateStr(d);
  }

  function friendlyDate(dateStr) {
    const today = State.todayStr();
    if (dateStr === today) return 'Today';
    if (dateStr === State.yesterdayStr()) return 'Yesterday';
    if (dateStr === offsetDateStr(1)) return 'Tomorrow';
    const d = new Date(dateStr + 'T00:00');
    return d.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function logTimeOf(l) {
    // wake/sleep carry an explicit HH:MM; everything else derives from createdAt
    if (l.time) return l.time;
    if (l.createdAt) {
      const d = new Date(l.createdAt);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return '';
  }

  // ═══════════════════════════════════════════════════════════
  // COLLAPSIBLE SECTIONS — chevron in the header, state persisted
  // ═══════════════════════════════════════════════════════════
  function isCollapsed(key) {
    return !!(State.getSettings().collapsedSections || {})[key];
  }

  function sectionToggle(key) {
    return `<button class="icon-btn collapse-btn ${isCollapsed(key) ? 'collapsed' : ''}" onclick="App.toggleSection('${key}')"
      aria-label="${isCollapsed(key) ? 'Expand' : 'Collapse'} section">${icon('chevron-down', 14)}</button>`;
  }

  function toggleSection(key) {
    const cs = { ...(State.getSettings().collapsedSections || {}) };
    cs[key] = !cs[key];
    State.updateSettings({ collapsedSections: cs });
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // CELEBRATIONS — confetti on completion, milestone streaks
  // ═══════════════════════════════════════════════════════════
  // Bursts spawn from wherever the user last touched, so the reward
  // lands where the eye already is.
  let lastPointer = { x: null, y: null };
  document.addEventListener('pointerdown', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  }, { capture: true, passive: true });

  function celebrate(count = 28) {
    // Animations are governed ONLY by the in-app Celebrations toggle —
    // OS-level prefers-reduced-motion is deliberately ignored throughout.
    if (State.getSettings().celebrations === false) return;
    const x = lastPointer.x ?? window.innerWidth / 2;
    const y = lastPointer.y ?? window.innerHeight / 3;
    let cv = document.getElementById('confettiCanvas');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'confettiCanvas';
      cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:400;';
      document.body.appendChild(cv);
    }
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    const ctx = cv.getContext('2d');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0f9598';
    const colors = [accent, '#e6a23c', '#e06d6d', '#6db4f0', '#6fcf97'];
    const parts = [];
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const v = 4 + Math.random() * 5;
      parts.push({
        x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
        w: 4 + Math.random() * 4, h: 3 + Math.random() * 3,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length], life: 1,
      });
    }
    const t0 = performance.now();
    (function tick(now) {
      const dt = Math.min((now - t0) / 900, 1);
      ctx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.vx *= 0.985;
        p.rot += p.vr; p.life = 1 - dt;
        ctx.save();
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (dt < 1) requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, cv.width, cv.height); cv.remove(); }
    })(t0);
  }

  const STREAK_MILESTONES = [7, 14, 30, 50, 100, 365];
  function checkStreakMilestone(habitId) {
    const h = State.getEntry(habitId);
    if (!h) return false;
    const s = State.calculateStreak(habitId).current;
    if (STREAK_MILESTONES.includes(s)) {
      celebrate(70);
      toast(`🔥 ${s}-day streak on “${h.title}”!`);
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // ACCENT THEMES — one variable family, applied everywhere
  // ═══════════════════════════════════════════════════════════
  const ACCENTS = {
    teal:   { accent: '#0f9598', hover: '#12b3b7' },
    indigo: { accent: '#5b67d8', hover: '#7c86e8' },
    plum:   { accent: '#9459c9', hover: '#a97ad6' },
    coral:  { accent: '#d95f57', hover: '#e37f78' },
    amber:  { accent: '#bd7f1b', hover: '#d29a3a' },
    forest: { accent: '#4a9155', hover: '#63a96e' },
    rose:   { accent: '#c9538a', hover: '#d677a2' },
  };

  function applyAccent(name) {
    const a = ACCENTS[name] || ACCENTS.teal;
    const root = document.documentElement;
    const hex = a.accent.replace('#', '');
    const rgb = `${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}`;
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--accent-hover', a.hover);
    root.style.setProperty('--accent-tint', `rgba(${rgb}, 0.09)`);
    root.style.setProperty('--accent-tint-strong', `rgba(${rgb}, 0.16)`);
    // dark theme reads better with the lighter variant as text color
    const isDark = root.getAttribute('data-theme') === 'dark';
    root.style.setProperty('--accent-text', isDark ? a.hover : a.accent);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', a.accent);
  }

  function setAccent(name) {
    State.updateSettings({ accent: name });
    applyAccent(name);
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // REMINDERS THAT FIRE — remindTime was decorative until now
  // ═══════════════════════════════════════════════════════════
  // Checked every 30s while the app is open: in-app toast always,
  // system notification when permission is granted. Fires once per day
  // per entry (lastNotified), so reopening the app doesn't re-nag.
  function checkReminders() {
    const today = State.todayStr();
    const now = nowTime();
    let fired = 0;
    State.getEntries().forEach(e => {
      if (e.completed || !e.remindTime) return;
      // dated entries fire on their day; undated reminders fire every day
      const dueToday = e.dueDate === today || (e.type === 'reminder' && !e.dueDate);
      if (!dueToday || e.remindTime > now || e.lastNotified === today) return;
      State.updateEntry(e.id, { lastNotified: today });
      fired++;
      toast(`⏰ ${e.title} — ${e.remindTime}`);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('Cade.project', { body: `${e.title} — ${e.remindTime}`, tag: e.id });
        } catch (err) { /* some platforms require SW-based notifications */ }
      }
    });
    return fired;
  }

  // Scheduled check-in prompts (Settings → Reminders). A prompt_seen log
  // is written the moment one fires — it syncs, so a check-in handled (or
  // seen) on one device never pops up again on another.
  function checkQuickLogPrompts() {
    const times = (State.getSettings().quickLogPromptTimes || '')
      .split(',').map(s => s.trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t));
    if (times.length === 0) return 0;
    const today = State.todayStr();
    const now = nowTime();
    for (const t of times) {
      if (now < t) continue;
      if (timeToMin(now) - timeToMin(t) > 45) continue; // slot expired
      if (State.getLogs({ type: 'prompt_seen', date: today }).some(l => l.time === t)) continue;
      // already logged a mood at/after the slot (any device) → satisfied
      if (State.getLogs({ date: today }).some(l => (l.type === 'emotion' || l.type === 'checkin') && logTimeOf(l) >= t)) continue;
      if (document.getElementById('modalOverlay').classList.contains('active')) return 0; // never clobber a form
      State.createLog({ type: 'prompt_seen', date: today, time: t, notes: '' });
      openQuickLog();
      toast('Scheduled check-in — how are you doing?');
      return 1;
    }
    return 0;
  }

  function notificationStatus() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission; // 'granted' | 'denied' | 'default'
  }

  async function enableNotifications() {
    if (typeof Notification === 'undefined') { toast('Notifications not supported here'); return; }
    const perm = await Notification.requestPermission();
    toast(perm === 'granted' ? 'Notifications on — reminders will pop up' : 'Notifications blocked — in-app toasts still work');
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // THEME
  // ═══════════════════════════════════════════════════════════
  function initTheme() {
    const saved = State.getSettings().theme;
    document.documentElement.setAttribute('data-theme', saved);
    applyAccent(State.getSettings().accent || 'teal');
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = saved === 'dark' ? icon('sun') : icon('moon');
    }
    setThemeMenuLabel(saved);
  }

  function setThemeMenuLabel(theme) {
    const label = document.getElementById('themeMenuLabel');
    if (label) label.textContent = theme === 'dark' ? 'Theme: Dark' : 'Theme: Light';
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    State.updateSettings({ theme: next });
    applyAccent(State.getSettings().accent || 'teal'); // accent-text is theme-dependent
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = next === 'dark' ? icon('sun') : icon('moon');
      toggleBtn.setAttribute('aria-label', 'Switch to ' + (next === 'dark' ? 'light' : 'dark') + ' mode');
    }
    setThemeMenuLabel(next);
    render();
    refreshIcons();
  }

  // ═══════════════════════════════════════════════════════════
  // NAVIGATION — menubar, scope pill, view tabs, sub-project tabs
  //
  // Three separate questions, three separate controls, mirroring Cade.txt:
  //   menus  → what do you want to DO
  //   pill   → which workspace are you IN
  //   tabs   → which view are you LOOKING AT  (+ which room, below)
  // Everything downstream reads the scope from here instead of each view
  // inventing its own filter row.
  // ═══════════════════════════════════════════════════════════
  const WS_ALL = '__all__';
  const WS_UNFILED = '__unfiled__';

  const VIEWS = [
    { id: 'today',    label: 'Today',    icon: 'layout-dashboard', primary: true },
    { id: 'projects', label: 'Projects', icon: 'folder-kanban',    primary: true },
    { id: 'habits',   label: 'Habits',   icon: 'repeat',           primary: true },
    { id: 'planner',  label: 'Planner',  icon: 'calendar-days',    primary: true },
    { id: 'insights', label: 'Insights', icon: 'bar-chart-3',      primary: true },
    { id: 'history',  label: 'History',  icon: 'history',          primary: true },
    { id: 'focus',    label: 'Focus',    icon: 'crosshair' },
    { id: 'scratch',  label: 'Scratch',  icon: 'lightbulb' },
    { id: 'health',   label: 'Health',   icon: 'apple' },
    { id: 'tools',    label: 'Tools',    icon: 'wrench' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  // Which workspace/room you are in is a property of this screen, not of the
  // dataset — it lives outside the synced blob so switching tabs on a phone
  // doesn't queue a push and fight with the desktop.
  const NAV_KEY = 'cade.project.nav.v1';
  let activeWorkspace = WS_ALL;
  let activeSubproject = null;

  function loadNav() {
    try {
      const saved = JSON.parse(localStorage.getItem(NAV_KEY) || '{}');
      if (saved.workspace) activeWorkspace = saved.workspace;
      if (saved.subproject) activeSubproject = saved.subproject;
      if (saved.tab && VIEWS.some(v => v.id === saved.tab)) currentTab = saved.tab;
    } catch (e) {}
    validateNav();
  }

  function saveNav() {
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify({
        workspace: activeWorkspace, subproject: activeSubproject, tab: currentTab,
      }));
    } catch (e) {}
  }

  // A workspace or room deleted elsewhere (or in Cade.txt) must not leave the
  // app pointing at nothing.
  function validateNav() {
    if (activeWorkspace !== WS_ALL && activeWorkspace !== WS_UNFILED && !State.getProject(activeWorkspace)) {
      activeWorkspace = WS_ALL;
      activeSubproject = null;
    }
    if (activeSubproject && !State.getProject(activeSubproject)) activeSubproject = null;
  }

  // ── Scope: the set of project ids the current view should show ─────────
  // null means "no project filter at all".
  function scopeProjectIds() {
    if (activeSubproject) return State.getProjectSubtreeIds(activeSubproject);
    if (activeWorkspace === WS_ALL) return null;
    if (activeWorkspace === WS_UNFILED) return [];
    return State.getProjectSubtreeIds(activeWorkspace);
  }

  function inScope(entry) {
    const ids = scopeProjectIds();
    if (ids === null) return true;
    const pids = State.entryProjectIds(entry);
    if (ids.length === 0) return pids.length === 0; // the Unfiled bucket
    return pids.some(pid => ids.includes(pid));
  }

  // Entries the current scope covers, with the usual archived filtering.
  function scopedEntries(filter = {}) {
    return State.getEntries(filter).filter(inScope);
  }

  // What the current scope is called — the deepest thing selected. Used in
  // page headings, where naming the room is the useful answer.
  function scopeLabel() {
    if (activeSubproject) return State.getProject(activeSubproject)?.name || 'Sub-project';
    return workspaceLabel();
  }

  // What the PILL says. It is a workspace switcher and its dropdown lists
  // workspaces, so naming a room in it (with the workspace's colour on the
  // dot beside it) reads as a mismatch. The room strip already shows which
  // room is selected.
  function workspaceLabel() {
    if (activeWorkspace === WS_ALL) return 'All Projects';
    if (activeWorkspace === WS_UNFILED) return 'Unfiled';
    return State.getProject(activeWorkspace)?.name || 'Workspace';
  }

  function setWorkspace(id) {
    activeWorkspace = id;
    activeSubproject = null;
    dropOutOfScopeSelections();
    saveNav();
    closeAllMenus();
    render();
  }

  function setSubproject(id) {
    activeSubproject = (activeSubproject === id) ? null : id;
    dropOutOfScopeSelections();
    saveNav();
    render();
  }

  // Selections made inside one scope are meaningless in another. A habit
  // opened in the previous workspace would otherwise keep the Habits page on
  // its detail view — showing a habit the newly scoped list does not contain.
  function dropOutOfScopeSelections() {
    if (selectedHabit) {
      const h = State.getEntry(selectedHabit);
      if (!h || !inScope(h)) selectedHabit = null;
    }
    if (selectedEntryId) {
      const e = State.getEntry(selectedEntryId);
      if (!e || !inScope(e)) selectedEntryId = null;
    }
  }

  // ── Sub-project visibility ─────────────────────────────────────────────
  // A room with nothing left to do is noise. It stays visible on the day its
  // last item was finished — long enough to undo a mis-tap — then drops out.
  // "Show all" in the strip brings the settled ones back.
  let showSettledSubs = false;

  function subprojectActivity(p) {
    const today = State.todayStr();
    const entries = State.getEntries({ projectId: p.id });
    const open = entries.filter(e => !e.completed && e.type !== 'habit').length;
    const doneToday = entries.filter(e => e.completed && (e.completedAt || '').startsWith(today)).length;
    // A sub-project made today counts as live even while still empty —
    // creating one and watching it vanish would be baffling.
    const fresh = entries.length === 0 && (p.createdAt || '').startsWith(today);
    return { open, doneToday, total: entries.length, live: open > 0 || doneToday > 0 || fresh };
  }

  // EVERY descendant, depth-first, not just direct children — projects can
  // still be nested arbitrarily deep from the project editor, and a
  // grandchild that only its parent could reach would be stranded: its tasks
  // roll up into the ancestor's totals with no way to open it.
  // `depth` is relative to the workspace, for indenting.
  function workspaceSubprojects(wsId) {
    if (wsId === WS_ALL || wsId === WS_UNFILED) return [];
    const all = State.getProjects();
    const out = [];
    const walk = (parentId, depth) => {
      all.filter(p => p.parentId === parentId).forEach(p => {
        out.push({ ...p, depth });
        walk(p.id, depth + 1);
      });
    };
    walk(wsId, 0);
    return out;
  }

  // ── Rendering the chrome ───────────────────────────────────────────────
  function renderNav() {
    validateNav();
    renderWorkspacePill();
    renderViewTabs();
    renderSubTabs();
  }

  function renderWorkspacePill() {
    const pill = document.getElementById('wsPill');
    if (!pill) return;
    const nameEl = pill.querySelector('.ws-pill-name');
    const dot = pill.querySelector('.ws-pill-dot');
    const proj = (activeWorkspace !== WS_ALL && activeWorkspace !== WS_UNFILED)
      ? State.getProject(activeWorkspace) : null;
    nameEl.textContent = workspaceLabel();
    dot.style.background = proj ? proj.color : 'var(--text-faint)';
    pill.title = proj ? `Workspace: ${proj.name} — click to switch` : 'Switch workspace';
  }

  function renderWorkspaceDropdown() {
    const dd = document.getElementById('wsDropdown');
    if (!dd) return;
    const tops = State.getProjects().filter(p => p.depth === 0);
    // Two different questions: is there an Unfiled page worth offering, and
    // how much is left to do there. Gating the entry on the OPEN count alone
    // meant finishing the last unfiled task removed the only way back in to
    // look at it — there is no Unfiled card in the grid either.
    const unfiled = State.getEntries().filter(e => State.entryProjectIds(e).length === 0);
    const unfiledCount = unfiled.filter(e => !e.completed).length;
    const openIn = (p) => State.getEntries({ projectId: p.id }).filter(e => !e.completed && e.type !== 'habit').length;

    let html = `<button class="ws-option ${activeWorkspace === WS_ALL ? 'active' : ''}" onclick="App.setWorkspace('${WS_ALL}')">
      <span class="ws-pill-dot" style="background:var(--text-faint)"></span>
      <span>All Projects</span>
      <span class="ws-count">${State.getEntries().filter(e => !e.completed && e.type !== 'habit').length}</span>
    </button>`;

    tops.forEach(p => {
      html += `<button class="ws-option ${activeWorkspace === p.id ? 'active' : ''}" onclick="App.setWorkspace('${p.id}')">
        <span class="ws-pill-dot" style="background:${p.color}"></span>
        <span class="truncate">${escHtml(p.name)}</span>
        ${p.txtWorkspaceId ? '<span class="ws-link-badge" title="Shared with Cade.txt">txt</span>' : ''}
        <span class="ws-count">${openIn(p)}</span>
      </button>`;
    });

    if (unfiled.length > 0 || activeWorkspace === WS_UNFILED) {
      html += `<button class="ws-option ${activeWorkspace === WS_UNFILED ? 'active' : ''}" onclick="App.setWorkspace('${WS_UNFILED}')">
        <span class="ws-pill-dot" style="background:var(--text-faint)"></span>
        <span>Unfiled</span><span class="ws-count">${unfiledCount}</span>
      </button>`;
    }

    html += `<div class="menu-separator"></div>
      <button class="ws-option" onclick="App.menuAction('openProjectModal')"><span>+ New workspace…</span></button>
      <button class="ws-option" onclick="App.menuAction('openManageProjects')"><span>Manage projects…</span></button>`;
    dd.innerHTML = html;
  }

  function renderViewTabs() {
    const strip = document.getElementById('viewTabs');
    const sel = document.getElementById('viewMobileSelect');
    const shown = VIEWS.filter(v => v.primary || v.id === currentTab);
    if (strip) {
      strip.innerHTML = shown.map(v => `
        <button class="view-tab ${currentTab === v.id ? 'active' : ''}" onclick="App.switchTab('${v.id}')">
          <i data-lucide="${v.icon}"></i><span>${v.label}</span>
        </button>`).join('');
    }
    if (sel) {
      sel.innerHTML = `<select onchange="App.switchTab(this.value)" aria-label="View">
        ${VIEWS.map(v => `<option value="${v.id}" ${currentTab === v.id ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>`;
    }
  }

  function renderSubTabs() {
    const bar = document.getElementById('subTabs');
    if (!bar) return;
    const subs = workspaceSubprojects(activeWorkspace);
    if (!subs.length) {
      bar.style.display = 'none';
      document.body.classList.remove('has-subtabs');
      return;
    }
    const withActivity = subs.map(p => ({ p, a: subprojectActivity(p) }));
    const live = withActivity.filter(x => x.a.live);
    const settled = withActivity.filter(x => !x.a.live);
    const visible = showSettledSubs ? withActivity : live;

    // Whatever you are actually looking at is always in the strip, even if it
    // just went quiet — otherwise selecting a room makes it disappear.
    if (activeSubproject && !visible.some(x => x.p.id === activeSubproject)) {
      const cur = withActivity.find(x => x.p.id === activeSubproject);
      if (cur) visible.unshift(cur);
    }

    let html = `<span class="sub-tabs-label">Rooms</span>
      <button class="sub-tab ${!activeSubproject ? 'active' : ''}" onclick="App.setSubproject(null)">All</button>`;
    visible.forEach(({ p, a }) => {
      // Indentation is meaningless in a horizontal strip, so a nested room
      // shows its parent's name instead of losing its place in the tree.
      const parent = p.depth ? State.getProject(p.parentId) : null;
      html += `<button class="sub-tab ${activeSubproject === p.id ? 'active' : ''} ${a.live ? '' : 'settled'}"
        onclick="App.setSubproject('${p.id}')"
        title="${escHtml(parent ? parent.name + ' / ' + p.name : p.name)}${p.txtRoom ? ' — Cade.txt room' : ''}${a.live ? '' : ' — nothing left to do'}">
        ${parent ? `<span class="sub-parent">${escHtml(parent.name)}/</span>` : ''}<span>${escHtml(p.name)}</span>
        <span class="sub-count">${a.open || a.doneToday}</span>
      </button>`;
    });
    if (settled.length && !showSettledSubs) {
      html += `<button class="sub-tab-add" onclick="App.toggleSettledSubs()" title="Show rooms with nothing left to do">+${settled.length} done</button>`;
    } else if (settled.length) {
      html += `<button class="sub-tab-add" onclick="App.toggleSettledSubs()" title="Hide rooms with nothing left to do">hide done</button>`;
    }
    html += `<button class="sub-tab-add" onclick="App.openNewSubproject()" title="New sub-project — also creates the room in Cade.txt">+</button>`;

    bar.innerHTML = html;
    bar.style.display = 'flex';
    document.body.classList.add('has-subtabs');
  }

  function toggleSettledSubs() {
    showSettledSubs = !showSettledSubs;
    renderSubTabs();
  }

  // ── Menus ──────────────────────────────────────────────────────────────
  function closeAllMenus() {
    document.querySelectorAll('.menu-dropdown.open').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.menu-trigger.open').forEach(el => el.classList.remove('open'));
    document.getElementById('wsDropdown')?.classList.remove('open');
    document.getElementById('menuSheet')?.classList.remove('open');
  }

  function toggleMenu(name, trigger) {
    const dd = document.getElementById('menu-' + name);
    if (!dd) return;
    const wasOpen = dd.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) { dd.classList.add('open'); trigger.classList.add('open'); }
  }

  function toggleWorkspaceMenu(e) {
    if (e) e.stopPropagation();
    const dd = document.getElementById('wsDropdown');
    const wasOpen = dd.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) { renderWorkspaceDropdown(); dd.classList.add('open'); }
  }

  // Phones fold the four menus into one sheet. It is built from the same
  // dropdown markup, so an item added to a menu shows up in both places.
  function toggleMenuSheet() {
    const sheet = document.getElementById('menuSheet');
    if (!sheet) return;
    const wasOpen = sheet.classList.contains('open');
    closeAllMenus();
    if (wasOpen) return;
    const groups = [['new', 'New'], ['view', 'View'], ['track', 'Track'], ['data', 'Data']];
    sheet.innerHTML = groups.map(([id, title]) => {
      const src = document.getElementById('menu-' + id);
      return src ? `<div class="menu-sheet-group"><div class="menu-sheet-title">${title}</div>${src.innerHTML}</div>` : '';
    }).join('');
    sheet.classList.add('open');
    refreshIcons();
  }

  // Every menu item routes through here so the menu always closes, even when
  // the action opens a modal that would otherwise leave it hanging open.
  function menuAction(fn, arg) {
    closeAllMenus();
    const api = App;
    if (typeof api[fn] === 'function') {
      arg === undefined ? api[fn]() : api[fn](arg);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ROUTING
  // ═══════════════════════════════════════════════════════════
  function switchTab(tab) {
    currentTab = tab;
    closeAllMenus();
    saveNav();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═══════════════════════════════════════════════════════════
  function render() {
    const main = document.getElementById('mainContent');
    Charts.destroyAll();
    closePopover();
    renderNav();

    switch (currentTab) {
      case 'today': main.innerHTML = renderToday(); break;
      case 'projects': main.innerHTML = renderProjects(); break;
      case 'habits': main.innerHTML = renderHabits(); break;
      case 'focus': main.innerHTML = renderFocus(); break;
      case 'planner': main.innerHTML = renderPlannerTab(); break;
      case 'scratch': main.innerHTML = renderScratch(); break;
      case 'tools': main.innerHTML = renderTools(); break;
      case 'health': main.innerHTML = renderHealth(); break;
      case 'insights': main.innerHTML = renderInsights(); break;
      case 'history': main.innerHTML = renderHistory(); break;
      case 'settings': main.innerHTML = renderSettings(); break;
      case 'taskpage': main.innerHTML = renderTaskPage(); break;
    }

    refreshIcons();
    requestAnimationFrame(() => renderChartsForTab());
  }

  function renderChartsForTab() {
    if (currentTab === 'insights') renderInsightCharts();
    if (currentTab === 'habits') renderHabitCharts();
    if (currentTab === 'health') renderHealthCharts();
    if (currentTab === 'history') renderHistoryCharts();
  }

  // ═══════════════════════════════════════════════════════════
  // TODAY VIEW
  // ═══════════════════════════════════════════════════════════
  // A finished task earns its place on the homepage for exactly one day —
  // long enough to see what you got done and to undo a mis-tap. After that
  // it belongs to history, not to today.
  function finishedToday(e) {
    return !!(e.completed && (e.completedAt || '').startsWith(State.todayStr()));
  }
  function hideStaleCompletions(list) {
    return list.filter(e => !e.completed || finishedToday(e));
  }

  function renderToday() {
    const today = State.todayStr();
    const allEntries = scopedEntries();
    const tasks = allEntries.filter(e => e.type === 'task');
    const habits = allEntries.filter(e => e.type === 'habit');

    // Today's tasks: due today, scheduled today, or unscheduled — plus
    // anything finished today, struck through at the bottom. Tasks completed
    // on an earlier day are gone from here entirely.
    const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    // Work finished before today is hidden here by default and revealed by
    // the toggle in the section header. Deliberately its OWN switch, not the
    // project page's: opting into a deep-dive on one project's history should
    // not quietly refill the homepage with months of finished work.
    const showDone = !!State.getSettings().showCompletedOnToday;
    const inToday = tasks.filter(t =>
      t.dueDate === today || t.scheduledDate === today || (!t.dueDate && !t.scheduledDate));
    const staleDone = inToday.filter(t => t.completed && !finishedToday(t));
    const todayTasks = (showDone ? inToday : hideStaleCompletions(inToday)).sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1; // done → bottom
      return (priOrder[a.priority] || 2) - (priOrder[b.priority] || 2);
    });

    // Overdue tasks (never completed ones)
    const overdueTasks = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today);

    const openToday = todayTasks.filter(t => !t.completed);

    // Future-due tasks stay visible on Today — just ranked below anything
    // due now. They also feed the next-best pool so "working on: Work"
    // never claims there's nothing to do when tasks are merely due later.
    const upcomingTasks = tasks
      .filter(t => !t.completed && t.dueDate && t.dueDate > today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || taskScore(b) - taskScore(a));

    // Scope now comes from the workspace pill in the menubar — one control
    // instead of a page-level "working on" select duplicating it.
    // blocked tasks can't be the next best thing to do — they're waiting
    const nextPool = [...openToday, ...upcomingTasks].filter(t => !isBlocked(t));
    const nextTask = [...nextPool].sort((a, b) => taskScore(b) - taskScore(a))[0];
    const scoped = activeWorkspace !== WS_ALL || activeSubproject;
    const doneToday = tasks.filter(finishedToday).length;

    const todayEmotion = State.getTodayEmotion();
    // Sessions are logged against entries, so they scope the same way the
    // counts beside them do. A session with no entry (a bare timer) has no
    // project to judge, so it only counts when nothing is scoped.
    const focusSeconds = State.getLogs({ type: 'time_session', date: today })
      .filter(l => {
        if (!scoped) return true;
        const e = l.entryId ? State.getEntry(l.entryId) : null;
        return e ? inScope(e) : false;
      })
      .reduce((s, l) => s + (l.value || 0), 0);

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
          <p class="page-subtitle">${[
            scoped ? escHtml(scopeLabel()) : '',
            `${openToday.length + overdueTasks.length} to do`,
            doneToday ? `${doneToday} done` : '',
            (() => { const pend = habits.filter(h => State.isHabitScheduledOn(h.id, today) && !State.habitStatusOn(h.id, today)).length;
                     return pend ? `${pend} habit${pend > 1 ? 's' : ''} pending` : ''; })(),
            focusSeconds > 0 ? `${Timers.formatTime(focusSeconds)} focused` : '',
          ].filter(Boolean).join(' · ')}</p>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          ${overdueTasks.length > 0 ? `<button class="btn btn-secondary review-btn" onclick="App.openDailyReview()" title="Triage everything overdue — one decision per item">${icon('list-todo', 16)}Review<span class="review-count">${overdueTasks.length}</span></button>` : ''}
          <button class="btn btn-primary" onclick="App.openNewEntry('task')">${icon('plus', 16)}Task</button>
        </div>
      </div>
    `;

    // The three stat tiles that used to sit here said the same thing as the
    // subtitle immediately above them, in a fifth of the first screen, with a
    // "Focus Time —" tile that is empty until a timer has run. The numbers
    // are in the subtitle; the tiles are gone.

    // The shortlist, deliberately outside the scope: pinning something and
    // then having it hidden by a workspace filter defeats the point of it.
    const pinned = State.getPinned();
    if (pinned.length) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Pinned</span>
          <span class="text-xs text-faint">${pinned.length} on your shortlist</span></div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${pinned.map(t => renderEntryCard(t, t.projectId ? State.getProject(t.projectId) : null)).join('')}
        </div></div>`;
    }

    // Next best task
    html += `
      <div class="section">
        <div class="section-header"><span class="section-title">Next Best Task</span>
          <span style="display:inline-flex;align-items:center;gap:var(--space-2);margin-left:auto;">
            ${scoped ? `<span class="text-xs text-faint">within ${escHtml(scopeLabel())}</span>` : ''}
            ${nextTask ? `<button class="btn btn-ghost btn-sm" onclick="App.openWhyThis('${nextTask.id}')" title="How this was chosen">Why this?</button>` : ''}
          </span>
        </div>
        ${nextTask
          ? renderEntryCard(nextTask, nextTask.projectId ? State.getProject(nextTask.projectId) : null, null, { highlight: true })
          : `<div class="card"><p class="text-xs text-faint">Nothing open${scoped ? ` in ${escHtml(scopeLabel())}` : ''} right now.</p></div>`}
      </div>
    `;

    // Habits today
    if (habits.length > 0) {
      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">Habits</span>
          <span style="display:inline-flex;align-items:center;gap:var(--space-1);">
            <button class="btn btn-ghost btn-sm" onclick="App.switchTab('habits')">${icon('chevron-right', 14)}All</button>
            ${sectionToggle('todayHabits')}
          </span>
        </div>`;
      if (!isCollapsed('todayHabits')) {
        html += `<div style="display:flex;flex-direction:column;gap:var(--space-2);">`;
        habits.forEach(h => {
          const proj = h.projectId ? State.getProject(h.projectId) : null;
          const s = State.calculateStreak(h.id);
          html += renderEntryCard(h, proj, s);
        });
        html += `</div>`;
      }
      html += `</div>`;
    }

    // Today's tasks
    html += quickAddHtml(null);
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Today's Tasks</span>
        <span style="display:inline-flex;align-items:center;gap:var(--space-1);margin-left:auto;">
          ${(staleDone.length || showDone) ? `<button class="btn btn-ghost btn-sm" onclick="App.toggleShowCompletedToday()"
            title="${showDone ? 'Hide work finished before today' : 'Show work finished before today'}">
            ${icon(showDone ? 'eye-off' : 'eye', 14)}${showDone ? 'Hide done' : `Show done${staleDone.length ? ` (${staleDone.length})` : ''}`}
          </button>` : ''}
          ${sectionToggle('todayTasks')}
        </span>
      </div>`;
    if (isCollapsed('todayTasks')) {
      html += `</div>`;
    } else {
    html += `<div style="display:flex;flex-direction:column;gap:var(--space-2);">
    `;
    if (todayTasks.length === 0 && overdueTasks.length === 0) {
      html += `<div class="empty-state"><i data-lucide="list-checks"></i><p class="empty-state-text">No tasks for today. Add one with +</p></div>`;
    } else {
      const shown = new Set();
      overdueTasks.forEach(t => {
        shown.add(t.id);
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        html += renderEntryCard(t, proj);
      });
      todayTasks.forEach(t => {
        if (shown.has(t.id)) return;
        if (nextTask && t.id === nextTask.id) return; // shown above
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        html += renderEntryCard(t, proj);
      });
    }
    html += `</div></div>`;
    }

    // Upcoming (due in the future) — visible, just lower priority
    if (upcomingTasks.length > 0) {
      const MAXUP = 8;
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Upcoming</span>
          <span style="display:inline-flex;align-items:center;gap:var(--space-1);">
            <span class="text-xs text-faint">due later — ranked below today's work</span>
            ${sectionToggle('todayUpcoming')}
          </span>
        </div>
        ${isCollapsed('todayUpcoming') ? '' : `<div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${upcomingTasks.slice(0, MAXUP).map(t => {
            if (nextTask && t.id === nextTask.id) return '';
            return renderEntryCard(t, t.projectId ? State.getProject(t.projectId) : null);
          }).join('')}
          ${upcomingTasks.length > MAXUP ? `<p class="text-xs text-faint">+${upcomingTasks.length - MAXUP} more further out</p>` : ''}
        </div>`}
      </div>`;
    }

    // Day planner
    // The planner grid is sixteen hours of empty rows until something is in
    // it — half the page, below the tasks, on most days. It keeps its own tab;
    // Today shows it only once the day actually has blocks.
    if (State.getPlannerBlocks({ date: today }).length) {
      html += renderPlannerSection();
    } else {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Day Planner</span></div>
        <button class="btn btn-ghost btn-sm" onclick="App.switchTab('planner')">
          ${icon('calendar-plus', 14)}Nothing scheduled — open the planner
        </button>
      </div>`;
    }

    // Day mood widget (food/calorie tracking lives on the Health tab)
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Day Mood</span></div>
        <div class="emotion-selector">
          ${renderEmotionButton('bad', 'Bad', todayEmotion?.emotion)}
          ${renderEmotionButton('low', 'Low', todayEmotion?.emotion)}
          ${renderEmotionButton('okay', 'Okay', todayEmotion?.emotion)}
          ${renderEmotionButton('good', 'Good', todayEmotion?.emotion)}
          ${renderEmotionButton('great', 'Great', todayEmotion?.emotion)}
        </div>
        <p class="text-xs text-faint" style="text-align:center;margin-top:var(--space-2);">One mood per day — tap to change. Use Quick Log for timestamped check-ins.</p>
      </div>
    </div>`;

    return html;
  }

  function renderEmotionButton(emotion, label, current) {
    return `<button class="emotion-btn ${current === emotion ? 'selected' : ''}" onclick="App.logEmotion('${emotion}')">
      ${icon(MOOD_ICONS[emotion], 22)}
      <span class="emotion-label">${label}</span>
    </button>`;
  }

  // ═══════════════════════════════════════════════════════════
  // DAY PLANNER v2
  // ═══════════════════════════════════════════════════════════
  const HOUR_START = 6;
  const HOUR_END = 22;      // exclusive of last row's end
  const HOUR_PX = 44;       // must match --hour-h in styles.css

  let plannerOffset = 0;    // days from today (negative = history)
  let plannerView = 'day';  // 'day' | '3day'

  function renderPlannerSection() {
    const baseDate = offsetDateStr(plannerOffset);
    const days = plannerView === '3day'
      ? [baseDate, offsetDateStr(plannerOffset + 1), offsetDateStr(plannerOffset + 2)]
      : [baseDate];

    let label = friendlyDate(baseDate);
    if (plannerView === '3day') label += ` — ${friendlyDate(days[2])}`;

    let html = `<div class="section">
      <div class="section-header"><span class="section-title">Day Planner</span>
        <span class="text-xs text-faint">tap a slot to add</span>
      </div>
      <div class="card">
        <div class="planner-header">
          <div class="planner-nav">
            <button class="icon-btn" onclick="App.plannerNav(-${plannerView === '3day' ? 3 : 1})" aria-label="Previous">${icon('chevron-left', 16)}</button>
            <span class="planner-date-label">${label}</span>
            <button class="icon-btn" onclick="App.plannerNav(${plannerView === '3day' ? 3 : 1})" aria-label="Next">${icon('chevron-right', 16)}</button>
            ${plannerOffset !== 0 ? `<button class="btn btn-ghost btn-sm" onclick="App.plannerToday()">Today</button>` : ''}
          </div>
          <div class="planner-view-toggle">
            <button class="planner-view-btn ${plannerView === 'day' ? 'active' : ''}" onclick="App.setPlannerView('day')">Day</button>
            <button class="planner-view-btn ${plannerView === '3day' ? 'active' : ''}" onclick="App.setPlannerView('3day')">3 Days</button>
          </div>
        </div>
        <div class="planner-multi ${plannerView === '3day' ? 'days-3' : ''}">
          ${days.map(d => `
            <div>
              ${plannerView === '3day' ? `<div class="planner-col-label ${d === State.todayStr() ? 'is-today' : ''}">${friendlyDate(d)}</div>` : ''}
              ${renderPlannerGrid(d)}
            </div>
          `).join('')}
        </div>
      </div>
    </div>`;
    return html;
  }

  // Visible hour window expands to fit any block outside the 6–22 default —
  // late-night tracked sessions were silently clipped out before.
  function gridHours(blocks) {
    let start = HOUR_START, end = HOUR_END;
    blocks.forEach(b => {
      const s = Math.floor(timeToMin(b.start) / 60);
      const e = Math.ceil(timeToMin(b.end) / 60);
      if (s < start) start = s;
      if (e > end) end = e;
    });
    return { hs: Math.max(0, start), he: Math.min(24, Math.max(end, start + 1)) };
  }

  function renderPlannerGrid(dateStr) {
    const today = State.todayStr();
    const blocks = State.getPlannerBlocks({ date: dateStr });
    const { hs, he } = gridHours(blocks);
    const totalH = (he - hs) * HOUR_PX;

    let html = `<div class="planner-grid" data-hs="${hs}" data-date="${dateStr}" style="height:${totalH}px">`;
    for (let hour = hs; hour < he; hour++) {
      html += `<div class="planner-hour" onclick="App.plannerTap(event,'${dateStr}',${hour})"
        ondragover="App.plannerDragOver(event)" ondragleave="App.plannerDragLeave(event)"
        ondrop="App.plannerDrop(event,'${dateStr}',${hour})">
        <div class="planner-hour-label">${String(hour).padStart(2, '0')}:00</div>
      </div>`;
    }

    // Positioned blocks (lane layout for overlaps)
    html += `<div style="position:absolute;inset:0;pointer-events:none;">`;
    layoutBlocks(blocks, hs, he).forEach(({ b, top, height, leftPct, widthPct }) => {
      const entry = b.entryId ? State.getEntry(b.entryId) : null;
      const proj = b.projectId ? State.getProject(b.projectId) : null;
      const color = b.color || proj?.color || 'var(--accent)';
      const isPast = dateStr < today;
      const overdue = entry && !entry.completed && isPast;
      const done = entry && entry.completed;
      const dur = timeToMin(b.end) - timeToMin(b.start);
      html += `<div class="planner-block ${b.kind === 'tracked' ? 'tracked' : ''} ${overdue ? 'overdue' : ''} ${done ? 'done' : ''}"
        data-block-id="${b.id}"
        style="top:${top}px;height:${Math.max(height, 16)}px;left:calc(var(--gutter) + 4px + ${leftPct}% - ${leftPct / 100} * (var(--gutter) + 8px));right:auto;width:calc(${widthPct}% - ${widthPct / 100} * (var(--gutter) + 8px) - 2px);border-left-color:${color};background:color-mix(in srgb, ${color} 12%, var(--surface));pointer-events:auto;"
        onpointerdown="App.blockPointerDown(event,'${b.id}')"
        title="${b.title} · ${b.start}–${b.end} — tap to edit, drag to move, pull the bottom edge to resize">
        <div class="pb-title">${overdue ? '⚠ ' : ''}${escHtml(b.title)}</div>
        ${height >= 30 ? `<div class="pb-time">${b.start}–${b.end} · ${estimateLabel(dur)}</div>` : ''}
        <div class="pb-resize" aria-hidden="true"></div>
      </div>`;
    });
    html += `</div>`;

    // Now line
    if (dateStr === today) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= hs * 60 && nowMin <= he * 60) {
        const top = (nowMin - hs * 60) / 60 * HOUR_PX;
        html += `<div class="planner-now" style="top:${top}px"></div>`;
      }
    }

    html += `</div>`;
    return html;
  }

  // ── Drag to move / resize planner blocks (15-min snapping) ──
  let blockDrag = null;

  function blockPointerDown(e, id) {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const block = State.getPlannerBlock(id);
    if (!block) return;
    const el = e.currentTarget;
    const grid = el.closest('.planner-grid');
    // All visible day columns — in the 3-day view a horizontal drag can
    // move the block to a different date.
    const columns = [...document.querySelectorAll('.planner-grid')].map(g => ({
      date: g.dataset.date,
      rect: g.getBoundingClientRect(),
    }));
    blockDrag = {
      id,
      el,
      mode: e.target.classList.contains('pb-resize') ? 'resize' : 'move',
      startY: e.clientY,
      startX: e.clientX,
      s: timeToMin(block.start),
      en: timeToMin(block.end),
      hs: parseInt(grid?.dataset.hs || HOUR_START, 10),
      date: block.date,
      newS: timeToMin(block.start),
      newE: timeToMin(block.end),
      newDate: block.date,
      columns,
      moved: false,
    };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.addEventListener('pointermove', blockPointerMove);
    el.addEventListener('pointerup', blockPointerUp);
    el.addEventListener('pointercancel', blockPointerUp);
  }

  function blockPointerMove(e) {
    if (!blockDrag) return;
    const dy = e.clientY - blockDrag.startY;
    const dx = e.clientX - blockDrag.startX;
    if (Math.abs(dy) > 4 || Math.abs(dx) > 8) blockDrag.moved = true;
    if (!blockDrag.moved) return;
    const deltaMin = Math.round(dy / HOUR_PX * 60 / 15) * 15;
    const dur = blockDrag.en - blockDrag.s;
    if (blockDrag.mode === 'move') {
      blockDrag.newS = Math.min(Math.max(blockDrag.s + deltaMin, 0), 24 * 60 - dur);
      blockDrag.newE = blockDrag.newS + dur;
      blockDrag.el.style.top = `${(blockDrag.newS - blockDrag.hs * 60) / 60 * HOUR_PX}px`;
      // Horizontal: which day column is the pointer over? (3-day view)
      if (blockDrag.columns.length > 1) {
        const col = blockDrag.columns.find(c => e.clientX >= c.rect.left && e.clientX <= c.rect.right);
        if (col && col.date !== blockDrag.newDate) {
          blockDrag.newDate = col.date;
        }
        // Preview: shift the block toward the hovered column
        const home = blockDrag.columns.find(c => c.date === blockDrag.date);
        const target = blockDrag.columns.find(c => c.date === blockDrag.newDate);
        if (home && target) {
          blockDrag.el.style.transform = `translateX(${target.rect.left - home.rect.left}px)`;
        }
      }
    } else {
      blockDrag.newE = Math.min(Math.max(blockDrag.en + deltaMin, blockDrag.s + 15), 24 * 60);
      blockDrag.el.style.height = `${Math.max((blockDrag.newE - blockDrag.s) / 60 * HOUR_PX - 2, 16)}px`;
    }
    const timeEl = blockDrag.el.querySelector('.pb-time');
    if (timeEl) timeEl.textContent = `${minToTime(blockDrag.newS)}–${minToTime(blockDrag.newE)} · ${estimateLabel(blockDrag.newE - blockDrag.newS)}`;
  }

  function blockPointerUp(e) {
    if (!blockDrag) return;
    const d = blockDrag;
    blockDrag = null;
    d.el.removeEventListener('pointermove', blockPointerMove);
    d.el.removeEventListener('pointerup', blockPointerUp);
    d.el.removeEventListener('pointercancel', blockPointerUp);
    if (d.moved) {
      State.updatePlannerBlock(d.id, {
        date: d.newDate,
        start: minToTime(d.mode === 'move' ? d.newS : d.s),
        end: minToTime(d.newE),
      });
      render();
    } else {
      // No movement — treat as a tap: open the edit modal (works for
      // tracked blocks too, so times can be adjusted or deleted)
      editPlannerBlock(d.id);
    }
  }

  // Assign overlapping blocks to side-by-side lanes.
  function layoutBlocks(blocks, hs = HOUR_START, he = HOUR_END) {
    const evs = blocks.map(b => ({
      b,
      s: Math.max(timeToMin(b.start), hs * 60),
      e: Math.min(Math.max(timeToMin(b.end), timeToMin(b.start) + 15), he * 60),
    })).filter(ev => ev.e > hs * 60 && ev.s < he * 60)
      .sort((a, b) => a.s - b.s || a.e - b.e);

    // Cluster events that transitively overlap
    const clusters = [];
    let cur = [], curEnd = -1;
    evs.forEach(ev => {
      if (cur.length && ev.s >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
      cur.push(ev);
      curEnd = Math.max(curEnd, ev.e);
    });
    if (cur.length) clusters.push(cur);

    const out = [];
    clusters.forEach(cluster => {
      const laneEnds = [];
      cluster.forEach(ev => {
        let lane = laneEnds.findIndex(end => end <= ev.s);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = ev.e;
        ev.lane = lane;
      });
      const lanes = laneEnds.length;
      cluster.forEach(ev => {
        out.push({
          b: ev.b,
          top: (ev.s - hs * 60) / 60 * HOUR_PX,
          height: (ev.e - ev.s) / 60 * HOUR_PX - 2,
          leftPct: ev.lane / lanes * 100,
          widthPct: 100 / lanes,
        });
      });
    });
    return out;
  }

  function plannerNav(delta) { plannerOffset += delta; render(); }
  function plannerToday() { plannerOffset = 0; render(); }
  function setPlannerView(v) { plannerView = v; render(); }

  // ── Tap-a-slot popover ──────────────────────────────────────
  let popoverEl = null;

  function closePopover() {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; }
    document.removeEventListener('click', onDocClickClosePopover, true);
  }

  function onDocClickClosePopover(e) {
    if (popoverEl && !popoverEl.contains(e.target)) closePopover();
  }

  function plannerTap(e, dateStr, hour) {
    e.stopPropagation();
    closePopover();
    const start = `${String(hour).padStart(2, '0')}:00`;
    popoverEl = document.createElement('div');
    popoverEl.className = 'planner-popover';
    popoverEl.innerHTML = `
      <div class="pp-time">${friendlyDate(dateStr)} · ${start}</div>
      <button onclick="App.popoverAgenda('${dateStr}','${start}')">${icon('calendar-plus', 15)}New agenda item</button>
      <button onclick="App.popoverTask('${dateStr}')">${icon('list-plus', 15)}New task (due ${friendlyDate(dateStr)})</button>
      <button onclick="App.popoverTimer()">${icon('timer', 15)}Start time tracking</button>
    `;
    document.body.appendChild(popoverEl);
    // Position near tap, clamped to viewport
    const pw = 210, ph = 150;
    const x = Math.min(e.clientX, window.innerWidth - pw - 8);
    const y = Math.min(e.clientY, window.innerHeight - ph - 8);
    popoverEl.style.left = `${Math.max(8, x)}px`;
    popoverEl.style.top = `${Math.max(8, y)}px`;
    refreshIcons();
    setTimeout(() => document.addEventListener('click', onDocClickClosePopover, true), 0);
  }

  function popoverAgenda(dateStr, start) { closePopover(); openAgendaModal({ date: dateStr, start }); }
  function popoverTask(dateStr) { closePopover(); openNewEntry('task'); setTimeout(() => { const el = document.getElementById('entryDueDate'); if (el) el.value = dateStr; }, 50); }
  function popoverTimer() { closePopover(); Timers.openPanel(); }

  // ── Agenda item modal ───────────────────────────────────────
  let editingBlockId = null;

  function openAgendaModal({ date, start = '09:00', block = null } = {}) {
    editingBlockId = block?.id || null;
    const projects = State.getProjects();
    const endDefault = block?.end || minToTime(Math.min(timeToMin(start) + 60, 23 * 60 + 59));
    const body = `
      <div class="form-group">
        <label class="form-label">Title</label>
        <input type="text" class="form-input" id="agendaTitle" value="${block?.title || ''}" placeholder="What's happening?" autocomplete="off">
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Date</label>
          <input type="date" class="form-input" id="agendaDate" value="${block?.date || date || State.todayStr()}">
        </div>
        <div class="form-group">
          <label class="form-label">Project (color)</label>
          <select class="form-select" id="agendaProject">
            <option value="">None</option>
            ${projects.map(p => `<option value="${p.id}" ${block?.projectId === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Start</label>
          <input type="time" class="form-input" id="agendaStart" value="${block?.start || start}">
        </div>
        <div class="form-group">
          <label class="form-label">End</label>
          <input type="time" class="form-input" id="agendaEnd" value="${endDefault}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Link to entry (optional)</label>
        <select class="form-select" id="agendaEntry">
          <option value="">None</option>
          ${State.getEntries({ type: 'task' }).filter(t => !t.completed || t.id === block?.entryId).map(t =>
            `<option value="${t.id}" ${block?.entryId === t.id ? 'selected' : ''}>${escHtml(t.title)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input type="text" class="form-input" id="agendaNotes" value="${block?.notes || ''}" placeholder="Optional note">
      </div>
    `;
    const footer = [
      editingBlockId ? `<button class="btn btn-danger" onclick="App.deleteAgendaBlock()">Delete</button><div style="flex:1"></div>` : '',
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveAgendaBlock()">${editingBlockId ? 'Save' : 'Add to planner'}</button>`,
    ];
    showModal(editingBlockId ? 'Edit Agenda Item' : 'New Agenda Item', body, footer);
    setTimeout(() => document.getElementById('agendaTitle')?.focus(), 100);
  }

  function saveAgendaBlock() {
    const title = document.getElementById('agendaTitle')?.value?.trim();
    const date = document.getElementById('agendaDate')?.value;
    const start = document.getElementById('agendaStart')?.value;
    const end = document.getElementById('agendaEnd')?.value;
    const projectId = document.getElementById('agendaProject')?.value || null;
    const entryId = document.getElementById('agendaEntry')?.value || null;
    const notes = document.getElementById('agendaNotes')?.value || '';
    if (!title) { toast('Title is required'); return; }
    if (!date || !start || !end || timeToMin(end) <= timeToMin(start)) { toast('End must be after start'); return; }
    const proj = projectId ? State.getProject(projectId) : null;
    const payload = { title, date, start, end, projectId, entryId, notes, color: proj?.color || null };
    if (editingBlockId) {
      State.updatePlannerBlock(editingBlockId, payload);
    } else {
      State.createPlannerBlock({ ...payload, kind: 'agenda' });
    }
    editingBlockId = null;
    closeModal();
    render();
  }

  function deleteAgendaBlock() {
    if (editingBlockId) State.deletePlannerBlock(editingBlockId);
    editingBlockId = null;
    closeModal();
    render();
  }

  function editPlannerBlock(id) {
    const block = State.getPlannerBlock(id);
    if (!block) return;
    openAgendaModal({ block });
  }

  // ═══════════════════════════════════════════════════════════
  // PLANNER TAB — dedicated page: planner + schedule insights
  // ═══════════════════════════════════════════════════════════
  function renderPlannerTab() {
    const viewDate = offsetDateStr(plannerOffset);
    const dayBlocks = State.getPlannerBlocks({ date: viewDate });
    const sumMin = (list) => list.reduce((s, b) => s + Math.max(0, timeToMin(b.end) - timeToMin(b.start)), 0);
    const agendaMin = sumMin(dayBlocks.filter(b => b.kind === 'agenda'));
    const trackedMin = sumMin(dayBlocks.filter(b => b.kind === 'tracked'));

    // Last 7 days tracked total
    const weekFrom = offsetDateStr(-6);
    const weekTracked = sumMin(State.getPlannerBlocks({ dateFrom: weekFrom, dateTo: State.todayStr(), kind: 'tracked' }));

    // Planned vs tracked ratio for the viewed day
    const coverage = agendaMin > 0 ? Math.round(trackedMin / agendaMin * 100) : null;

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Planner</h1>
          <p class="page-subtitle">Schedule, tracked time, agenda</p>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          ${plannerOffset === 0 ? `<button class="btn btn-secondary" onclick="App.openAutoPlan()" title="Fill today's free slots with your top tasks, sized by their estimates">${icon('wand-2', 14)}Auto-plan</button>` : ''}
          <button class="btn btn-primary" onclick="App.openAgendaModal({ date: '${viewDate}' })">${icon('plus', 14)}Agenda Item</button>
        </div>
      </div>
    `;

    html += `<div class="grid-3 section">
      <div class="card stat-card">
        <span class="stat-label">Scheduled ${friendlyDate(viewDate)}</span>
        <span class="stat-value">${agendaMin > 0 ? estimateLabel(agendaMin) : '—'}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Tracked ${friendlyDate(viewDate)}</span>
        <span class="stat-value">${trackedMin > 0 ? estimateLabel(trackedMin) : '—'}${coverage != null ? ` <span style="font-size:var(--text-xs);color:var(--text-muted)">(${coverage}% of plan)</span>` : ''}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Tracked — Last 7 Days</span>
        <span class="stat-value">${weekTracked > 0 ? estimateLabel(weekTracked) : '—'}</span>
      </div>
    </div>`;

    html += renderPlannerSection();

    // Upcoming agenda (next 7 days)
    const upcoming = State.getPlannerBlocks({ dateFrom: offsetDateStr(1), dateTo: offsetDateStr(7), kind: 'agenda' });
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Upcoming — Next 7 Days</span></div>
      <div class="card">`;
    if (upcoming.length === 0) {
      html += `<p class="text-xs text-faint">Nothing scheduled ahead. Tap a planner slot or use the Agenda Item button.</p>`;
    } else {
      upcoming.forEach(b => {
        const proj = b.projectId ? State.getProject(b.projectId) : null;
        html += `<div class="done-row" style="cursor:pointer;" onclick="App.editPlannerBlock('${b.id}')">
          <span class="done-time" style="width:76px;">${friendlyDate(b.date)}</span>
          <span class="font-mono text-xs text-muted" style="flex-shrink:0;">${b.start}–${b.end}</span>
          <span class="proj-dot" style="background:${b.color || proj?.color || 'var(--text-faint)'}"></span>
          <span class="truncate" style="flex:1;">${b.title}</span>
        </div>`;
      });
    }
    html += `</div></div>`;

    return html;
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRY CARD RENDERER
  // Card click SELECTS (teal outline + sticky actions); only the
  // checkbox toggles completion. Play arms the tracker; a live
  // tick badge shows while the task is being tracked.
  // ═══════════════════════════════════════════════════════════
  let selectedEntryId = null;

  // ═══════════════════════════════════════════════════════════
  // MULTI-SELECT
  // ═══════════════════════════════════════════════════════════
  // Re-filing a dozen tasks was a dozen round trips through the edit modal.
  // Shift-click extends from the last one clicked; Ctrl/Cmd-click adds a
  // single card; a plain click still just highlights one.
  const bulkSelection = new Set();
  let lastClickedEntryId = null;

  function visibleEntryIds() {
    return [...document.querySelectorAll('.entry-card')].map(el => el.dataset.id);
  }

  function selectEntryCard(id, ev) {
    const e = ev || (typeof window !== 'undefined' ? window.event : null);
    const additive = !!(e && (e.metaKey || e.ctrlKey));
    const ranged = !!(e && e.shiftKey);

    if (ranged && lastClickedEntryId) {
      const ids = visibleEntryIds();
      const a = ids.indexOf(lastClickedEntryId), b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => bulkSelection.add(x));
      }
    } else if (additive) {
      if (bulkSelection.has(id)) bulkSelection.delete(id); else bulkSelection.add(id);
      lastClickedEntryId = id;
    } else {
      bulkSelection.clear();
      selectedEntryId = selectedEntryId === id ? null : id;
      lastClickedEntryId = id;
    }
    if (bulkSelection.size) selectedEntryId = null;
    paintSelection();
  }

  function paintSelection() {
    document.querySelectorAll('.entry-card').forEach(el => {
      const id = el.dataset.id;
      el.classList.toggle('selected', id === selectedEntryId);
      el.classList.toggle('bulk-selected', bulkSelection.has(id));
    });
    renderBulkBar();
  }

  function clearBulkSelection() {
    bulkSelection.clear();
    lastClickedEntryId = null;
    paintSelection();
  }

  function selectedEntries() {
    return [...bulkSelection].map(id => State.getEntry(id)).filter(Boolean);
  }

  function renderBulkBar() {
    let bar = document.getElementById('bulkBar');
    const n = bulkSelection.size;
    if (!n) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulkBar';
      bar.className = 'bulk-bar';
      document.body.appendChild(bar);
    }
    const projects = State.getProjects();
    const anyOpen = selectedEntries().some(e => !e.completed);
    bar.innerHTML = `
      <span class="bulk-count">${n} selected</span>
      <select class="form-select bulk-select" onchange="App.bulkSetProject(this.value);this.selectedIndex=0;" aria-label="Move to project">
        <option value="">Move to…</option>
        <option value="__none__">— no project —</option>
        ${projects.map(p => `<option value="${p.id}">${'– '.repeat(p.depth || 0)}${escHtml(p.name)}</option>`).join('')}
      </select>
      <select class="form-select bulk-select" onchange="App.bulkSetDue(this.value);this.selectedIndex=0;" aria-label="Set due date">
        <option value="">Due…</option>
        <option value="today">Today</option>
        <option value="tomorrow">Tomorrow</option>
        <option value="week">In a week</option>
        <option value="none">Clear</option>
      </select>
      <select class="form-select bulk-select" onchange="App.bulkSetPriority(this.value);this.selectedIndex=0;" aria-label="Set priority">
        <option value="">Priority…</option>
        <option value="urgent">Urgent</option><option value="high">High</option>
        <option value="medium">Medium</option><option value="low">Low</option>
      </select>
      <button class="btn btn-ghost btn-sm" onclick="App.bulkComplete()">${icon('check', 13)}${anyOpen ? 'Complete' : 'Reopen'}</button>
      <button class="btn btn-ghost btn-sm" onclick="App.bulkArchive()">${icon('archive', 13)}Archive</button>
      <button class="btn btn-ghost btn-sm" onclick="App.bulkDelete()">${icon('trash-2', 13)}Delete</button>
      <button class="icon-btn" onclick="App.clearBulkSelection()" aria-label="Clear selection" title="Clear selection">${icon('x', 15)}</button>`;
    refreshIcons();
  }

  function bulkApply(label, fn) {
    const items = selectedEntries();
    if (!items.length) return;
    undoable(`${label} ${items.length} task${items.length === 1 ? '' : 's'}`, () => items.forEach(fn));
    clearBulkSelection();
    render();
  }

  function bulkSetProject(value) {
    if (!value) return;
    const pid = value === '__none__' ? null : value;
    const name = pid ? (State.getProject(pid) || {}).name : 'no project';
    bulkApply(`Moved to ${name} —`, (e) => State.updateEntry(e.id, { projectId: pid, projectIds: pid ? [pid] : [] }));
  }

  function bulkSetDue(value) {
    if (!value) return;
    const map = {
      today: State.todayStr(),
      tomorrow: State.dateStr(new Date(Date.now() + 86400000)),
      week: State.dateStr(new Date(Date.now() + 7 * 86400000)),
      none: null,
    };
    bulkApply('Re-dated', (e) => State.updateEntry(e.id, { dueDate: map[value] }));
  }

  function bulkSetPriority(value) {
    if (!value) return;
    bulkApply('Re-prioritised', (e) => State.updateEntry(e.id, { priority: value }));
  }

  // A mixed selection completes everything; an all-complete one reopens.
  function bulkComplete() {
    const anyOpen = selectedEntries().some(e => !e.completed);
    bulkApply(anyOpen ? 'Completed' : 'Reopened', (e) => {
      if (anyOpen ? !e.completed : e.completed) State.toggleComplete(e.id);
    });
  }

  function bulkArchive() { bulkApply('Archived', (e) => State.archiveEntry(e.id)); }

  function bulkDelete() {
    const items = selectedEntries();
    if (!items.length) return;
    bulkApply('Deleted', (e) => State.deleteEntry(e.id));
  }

  // A project id plus every ancestor up the nesting chain
  function withAncestors(id) {
    const out = [id];
    let p = State.getProject(id);
    let guard = 0;
    while (p?.parentId && guard++ < 10) {
      if (!out.includes(p.parentId)) out.push(p.parentId);
      p = State.getProject(p.parentId);
    }
    return out;
  }

  // Open first (by priority, then due date), finished at the bottom
  const PRI_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
  // A hand-arranged list stays as arranged; an untouched one keeps the smart
  // order. Deciding per-list rather than globally means dragging one task in
  // one project does not switch every other list to manual mode.
  function sortEntriesSmart(list) {
    const arranged = list.some(e => Number.isFinite(e.order));
    return [...list].sort((a, b) => {
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
      if (arranged) {
        // Anything never dragged sorts after everything that was.
        const oa = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const ob = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
      }
      const pa = PRI_ORDER[a.priority] ?? 2, pb = PRI_ORDER[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      const da = a.dueDate || '9999', db = b.dueDate || '9999';
      if (da !== db) return da.localeCompare(db);
      return (a.title || '').localeCompare(b.title || '');
    });
  }

  // First open, non-archived task this entry is waiting on (null = ready)
  function blockingEntry(entry) {
    for (const bid of entry.blockedBy || []) {
      const b = State.getEntry(bid);
      if (b && !b.completed && !b.archived) return b;
    }
    return null;
  }
  function isBlocked(entry) { return !!blockingEntry(entry); }

  // Cade.txt routes "#room=<name>". The bare "#<name>" this used to emit was
  // not routed at all, so the link landed on whatever document was last open.
  function txtRoomUrl(room) {
    return '../txt.html#room=' + encodeURIComponent(room);
  }

  function renderEntryCard(entry, project, streakInfo, opts = {}) {
    const proj = project || (entry.projectId ? State.getProject(entry.projectId) : null);
    const isOverdueFlag = entry.dueDate && isOverdue(entry.dueDate) && !entry.completed;
    const isDone = entry.type === 'habit' ? State.isHabitDoneToday(entry.id) : entry.completed;
    const isSelected = selectedEntryId === entry.id;
    const tracking = typeof Timers !== 'undefined' ? Timers.getTracking(entry.id) : null;
    const canTrack = entry.type === 'task' && !entry.completed;

    let metaHtml = '';
    // Multi-project entries show a dot per membership (up to 3). Kept apart
    // from the pills: on a card whose only other meta was a dot, the dot was
    // taking a whole second row to say what a swatch beside the title says.
    let dotsHtml = '';
    const pids = State.entryProjectIds(entry);
    pids.slice(0, 3).forEach(pid => {
      const pr = State.getProject(pid);
      if (pr) dotsHtml += `<span class="proj-dot" style="background:${pr.color}" title="${escHtml(pr.name)}"></span>`;
    });
    if (pids.length > 3) dotsHtml += `<span class="text-xs text-faint">+${pids.length - 3}</span>`;
    // Only what is NOT the default. Every task is medium priority and medium
    // effort unless someone says otherwise, so badging those put the same two
    // chips on every row — which is the same as having no chips, except it
    // also buried the rows that were genuinely urgent.
    if (entry.priority && entry.priority !== 'medium' && entry.priority !== 'low') {
      metaHtml += `<span class="pill pill-${priorityColor(entry.priority)}">${entry.priority}</span>`;
    }
    if (entry.effort && entry.effort !== 'medium') {
      metaHtml += `<span class="pill">${effortLabel(entry.effort)}</span>`;
    }
    if (entry.estimateMinutes) {
      metaHtml += `<span class="pill">~${estimateLabel(entry.estimateMinutes)}</span>`;
    }
    if (entry.dueDate) {
      const cls = isOverdueFlag ? 'pill-red' : 'pill-accent';
      metaHtml += `<span class="pill ${cls}">${formatDueDate(entry.dueDate)}${entry.remindTime ? ` · ${entry.remindTime}` : ''}</span>`;
    } else if (entry.remindTime) {
      metaHtml += `<span class="pill pill-accent">${entry.remindTime}</span>`;
    }
    if (entry.recurrence && entry.type !== 'habit') {
      metaHtml += `<span class="pill pill-repeat" title="Repeats ${entry.recurrence.type} — completing spawns the next occurrence">${icon('repeat-2', 10)}${entry.recurrence.type}</span>`;
    }
    const blocker = blockingEntry(entry);
    if (blocker) {
      metaHtml += `<span class="pill pill-blocked" title="Blocked until “${escHtml(blocker.title)}” is done">${icon('lock', 10)}${escHtml(blocker.title)}</span>`;
    }
    if (entry.tags && entry.tags.length > 0) {
      entry.tags.forEach(tag => {
        const tagObj = State.getAllTags().find(t => t.name === tag);
        const colorCls = tagObj ? `pill-${tagObj.color}` : 'pill-gray';
        metaHtml += `<span class="pill ${colorCls}">#${escHtml(tag)}</span>`;
      });
    }
    if (entry.type === 'habit' && streakInfo && streakInfo.current > 0) {
      metaHtml += `<span class="streak-display"><i data-lucide="flame"></i>${streakInfo.current}</span>`;
    }
    if (entry.type === 'habit') {
      if (!State.isHabitScheduledOn(entry.id, State.todayStr())) {
        metaHtml += `<span class="pill">off today</span>`;
      } else if (State.habitStatusOn(entry.id, State.todayStr()) === 'skipped') {
        metaHtml += `<span class="pill pill-yellow">skipped</span>`;
      }
    }
    if (entry.type === 'goal' && entry.targetValue) {
      const pct = Math.round((entry.currentValue || 0) / entry.targetValue * 100);
      metaHtml += `<span class="pill pill-accent">${pct}%</span>`;
    }
    // Nothing on a card said it mirrors a line in another app, which made
    // "ticking this changed something over there" a surprise.
    if (entry.txtRoom) {
      metaHtml += `<a class="pill pill-room" href="${txtRoomUrl(entry.txtRoom)}" onclick="event.stopPropagation()"
        title="Mirrors a checkbox in the Cade.txt room “${escHtml(entry.txtRoom)}” — open it">${icon('file-text', 10)}${escHtml(entry.txtRoom)}</a>`;
    }

    return `
      <div class="entry-card ${isDone ? 'completed' : ''} ${isSelected ? 'selected' : ''} ${opts.highlight ? 'highlight' : ''}" data-id="${entry.id}"
        ${opts.reorder
          ? `data-reorder-id="${entry.id}" draggable="true"
             ondragstart="App.reorderStart(event,'${entry.id}','task')" ondragend="App.reorderEnd(event)"
             ondragover="App.reorderOver(event,'task')" ondragleave="App.reorderLeave(event)"
             ondrop="App.reorderDrop(event,'${entry.id}','task')"`
          : (canTrack ? `draggable="true" ondragstart="App.taskDragStart(event,'${entry.id}')" ondragend="App.taskDragEnd(event)"` : '')}
        onclick="App.selectEntryCard('${entry.id}', event)" ${entry.type === 'task' ? `ondblclick="App.openTaskPage('${entry.id}')" title="Double-click to open task page — or drag onto the planner to schedule it"` : ''}>
        <div class="check-toggle ${isDone ? 'checked' : ''}" onclick="event.stopPropagation();App.toggleEntry('${entry.id}')" title="Mark ${isDone ? 'not done' : 'done'}">
          <i data-lucide="check"></i>
        </div>
        <div class="entry-body">
          <div class="entry-title">${dotsHtml}${escHtml(entry.title)}</div>
          ${metaHtml ? `<div class="entry-meta">${metaHtml}</div>` : ''}
          ${entry.type === 'goal' && entry.targetValue ? `
            <div class="progress-bar mt-2">
              <div class="progress-fill" style="width:${Math.min((entry.currentValue || 0) / entry.targetValue * 100, 100)}%"></div>
            </div>` : ''}
        </div>
        ${tracking ? `<span class="track-tick ${tracking.state === 'paused' ? 'paused' : ''}" data-tick-entry="${entry.id}"
          onclick="event.stopPropagation();Timers.openPanel()" title="Open timer">${Timers.formatTime(tracking.elapsed)}</span>` : ''}
        <div class="entry-actions">
          <button class="icon-btn${entry.pinned ? ' is-pinned' : ''}" onclick="event.stopPropagation();App.togglePin('${entry.id}')"
            aria-label="${entry.pinned ? 'Unpin' : 'Pin to shortlist'}" title="${entry.pinned ? 'Unpin' : 'Pin to shortlist'}">${icon(entry.pinned ? 'star' : 'star', 15)}</button>
          ${entry.type === 'task' ? `<button class="icon-btn" onclick="event.stopPropagation();App.openTaskPage('${entry.id}')" aria-label="Open task page" title="Open task page">${icon('panel-right-open', 15)}</button>` : ''}
          ${canTrack && !tracking ? `<button class="icon-btn" onclick="event.stopPropagation();Timers.armTracking('${entry.id}')" aria-label="Start timer" title="Track time">${icon('play', 15)}</button>` : ''}
          <button class="icon-btn" onclick="event.stopPropagation();App.editEntry('${entry.id}')" aria-label="Edit">${icon('pencil', 15)}</button>
          <button class="icon-btn" onclick="event.stopPropagation();App.archiveEntry('${entry.id}')" aria-label="Archive">${icon('archive', 15)}</button>
          <button class="icon-btn" onclick="event.stopPropagation();App.deleteEntry('${entry.id}')" aria-label="Delete">${icon('trash-2', 15)}</button>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════
  // TASK PAGE — double-click a task to open. Sticky timer, task
  // stats, and a running journal: type, Ctrl+Enter, newest first.
  // Posts snapshot the live tracked time, carry #tags, and can be
  // turned into tasks.
  // ═══════════════════════════════════════════════════════════
  let taskPageId = null;
  let taskPageReturnTab = 'today';

  function openTaskPage(id) {
    const entry = State.getEntry(id);
    if (!entry) return;
    taskPageId = id;
    if (currentTab !== 'taskpage') taskPageReturnTab = currentTab;
    closeModal();
    switchTab('taskpage');
  }

  function backFromTaskPage() {
    taskPageId = null;
    switchTab(taskPageReturnTab || 'today');
  }

  function parsePostTags(text) {
    return [...new Set([...text.matchAll(/#([a-z0-9_-]+)/gi)].map(m => m[1].toLowerCase()))];
  }

  function highlightPostTags(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/#([a-z0-9_-]+)/gi, (m, name) => {
        // known tags carry their registry color inline
        const tag = State.getAllTags().find(t => t.name === name.toLowerCase());
        return `<span class="post-tag ${tag ? `tag-${tag.color}` : ''}">${m}</span>`;
      })
      .replace(/\n/g, '<br>');
  }

  function renderTaskPage() {
    const entry = State.getEntry(taskPageId);
    if (!entry) { taskPageId = null; return renderToday(); }

    const tracking = typeof Timers !== 'undefined' ? Timers.getTracking(entry.id) : null;
    const posts = State.getLogs({ type: 'post', entryId: entry.id })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const sessions = State.getLogs({ type: 'time_session', entryId: entry.id });
    const trackedSecs = sessions.reduce((s, l) => s + (l.value || 0), 0);
    const actualMin = State.actualMinutesFor(entry);
    const score = entry.type === 'task' && !entry.completed ? taskScore(entry) : null;

    let metaHtml = '';
    State.entryProjectIds(entry).forEach(pid => {
      const pr = State.getProject(pid);
      if (pr) metaHtml += `<span class="pill" style="border-color:${pr.color};color:${pr.color};background:transparent;">${pr.name}</span>`;
    });
    if (entry.priority) metaHtml += `<span class="pill pill-${priorityColor(entry.priority)}">${entry.priority}</span>`;
    if (entry.dueDate) metaHtml += `<span class="pill ${isOverdue(entry.dueDate) && !entry.completed ? 'pill-red' : 'pill-accent'}">${formatDueDate(entry.dueDate)}</span>`;
    (entry.tags || []).forEach(t => { metaHtml += `<span class="pill pill-gray">#${t}</span>`; });

    let html = `
      <div class="page-header">
        <div style="display:flex;align-items:flex-start;gap:var(--space-3);">
          <button class="btn btn-secondary btn-sm" onclick="App.backFromTaskPage()" style="margin-top:2px;">${icon('arrow-left', 14)}Back</button>
          <div>
            <h1 class="page-title" style="${entry.completed ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${escHtml(entry.title)}</h1>
            <div class="entry-meta" style="margin-top:var(--space-2);">${metaHtml}</div>
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary" onclick="App.editEntry('${entry.id}')">${icon('pencil', 14)}Edit</button>
          <button class="btn ${entry.completed ? 'btn-secondary' : 'btn-primary'}" onclick="App.toggleEntry('${entry.id}')">${icon('check', 14)}${entry.completed ? 'Reopen' : 'Complete'}</button>
        </div>
      </div>
      ${entry.description ? `<p class="text-sm text-muted" style="margin-bottom:var(--space-4);max-width:70ch;">${escHtml(entry.description)}</p>` : ''}
    `;

    // Sticky timer strip
    html += `<div class="taskpage-timer card">
      <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;">
        ${icon('timer', 18)}
        ${tracking
          ? `<span class="track-tick ${tracking.state === 'paused' ? 'paused' : ''}" data-tick-entry="${entry.id}" style="font-size:var(--text-lg);padding:4px 12px;">${Timers.formatTime(tracking.elapsed)}</span>
             ${tracking.state === 'running'
               ? `<button class="btn btn-secondary btn-sm" onclick="Timers.pauseSession('${entry.id}');App.render()">${icon('pause', 13)}Pause</button>`
               : `<button class="btn btn-secondary btn-sm" onclick="Timers.resumeSession('${entry.id}');App.render()">${icon('play', 13)}Resume</button>`}
             <button class="btn btn-danger btn-sm" onclick="Timers.stopSession('${entry.id}')">${icon('square', 13)}Stop & Log</button>`
          : `<button class="btn btn-primary btn-sm" onclick="Timers.startSession('${entry.id}');App.render()">${icon('play', 13)}Start tracking</button>`}
        <div style="flex:1"></div>
        <span class="stat-label">Tracked total: ${trackedSecs >= 60 ? estimateLabel(Math.round(trackedSecs / 60)) : '—'}</span>
      </div>
    </div>`;

    // Stats row
    html += `<div class="grid-3 section" style="margin-top:var(--space-4);">
      <div class="card stat-card"><span class="stat-label">Estimate vs Actual</span>
        <span class="stat-value">${entry.estimateMinutes ? estimateLabel(entry.estimateMinutes) : '—'} / ${actualMin ? estimateLabel(actualMin) : '—'}</span>
        ${entry.estimateMinutes && actualMin ? `<span class="text-xs ${actualMin > entry.estimateMinutes ? 'text-muted' : ''}" style="color:${actualMin > entry.estimateMinutes ? 'var(--error)' : 'var(--success)'};">${Math.round(actualMin / entry.estimateMinutes * 100)}% of estimate</span>` : ''}
      </div>
      <div class="card stat-card"><span class="stat-label">Sessions / Posts</span><span class="stat-value">${sessions.length} / ${posts.length}</span></div>
      <div class="card stat-card"><span class="stat-label">${score != null ? 'Next-Best Score' : 'Status'}</span><span class="stat-value">${score != null ? score : (entry.completed ? 'Done' : 'Open')}</span></div>
    </div>`;

    // Journal (+ sub-task tally — local to this task, no global stats)
    const todos = posts.filter(p => p.kind === 'todo');
    const todosDone = todos.filter(p => p.done).length;
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Journal</span>
        <span style="display:inline-flex;align-items:center;gap:var(--space-2);">
          ${todos.length ? `<span class="pill pill-accent" id="subtaskCount">${todosDone}/${todos.length} sub-tasks</span>` : ''}
          <span class="text-xs text-faint">Ctrl+Enter to post · #tags inline</span>
        </span>
      </div>
      <div class="card">
        <textarea class="form-textarea" id="postInput" placeholder="${postMode === 'todo' ? 'Sub-task for this task… checkable in the stream below' : 'Stream of consciousness… #idea #bug tags become pills'}"
          onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();App.addPost('${entry.id}');}"></textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:var(--space-2);">
          <div class="post-mode-toggle" style="display:inline-flex;gap:var(--space-1);">
            <button class="filter-chip ${postMode === 'note' ? 'active' : ''}" data-mode="note" onclick="App.setPostMode('note')">${icon('pen-line', 11)}Post</button>
            <button class="filter-chip ${postMode === 'todo' ? 'active' : ''}" data-mode="todo" onclick="App.setPostMode('todo')">${icon('check-square', 11)}Sub-task</button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="App.addPost('${entry.id}')">${icon(postMode === 'todo' ? 'plus' : 'pen-line', 13)}${postMode === 'todo' ? 'Add sub-task' : 'Post'}</button>
        </div>
      </div>
      <div id="postStream" style="margin-top:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2);">
        ${posts.length === 0 ? '<p class="text-xs text-faint" style="text-align:center;">No posts yet — think out loud while you work.</p>' : posts.map(renderPost).join('')}
      </div>
    </div>`;

    return html;
  }

  function renderPost(post) {
    const d = new Date(post.createdAt);
    const stamp = `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const isTodo = post.kind === 'todo';
    return `<div class="post-card ${isTodo ? 'post-todo' : ''} ${isTodo && post.done ? 'done' : ''}">
      <div class="post-meta">
        ${isTodo ? `<span class="check-toggle post-check ${post.done ? 'checked' : ''}" onclick="App.togglePostTodo('${post.id}')" title="${post.done ? 'Not done' : 'Done'}"><i data-lucide="check"></i></span>` : ''}
        <span class="font-mono text-xs text-faint">${stamp}</span>
        ${post.trackedElapsed != null ? `<span class="pill pill-accent" title="Timer when posted">${icon('timer', 10)} ${Timers.formatTime(post.trackedElapsed)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="icon-btn" onclick="App.postToTask('${post.id}')" aria-label="Make into a task" title="Make this a task">${icon('list-plus', 14)}</button>
        <button class="icon-btn" onclick="App.deletePost('${post.id}')" aria-label="Delete post">${icon('trash-2', 14)}</button>
      </div>
      <div class="post-body">${highlightPostTags(post.notes || '')}</div>
    </div>`;
  }

  function addPost(entryId) {
    const input = document.getElementById('postInput');
    const text = input?.value?.trim();
    if (!text) return;
    const tracking = typeof Timers !== 'undefined' ? Timers.getTracking(entryId) : null;
    State.createLog({
      type: 'post',
      entryId,
      date: State.todayStr(),
      notes: text,
      kind: postMode, // 'note' | 'todo' (checkable sub-task)
      done: false,
      tags: parsePostTags(text),
      trackedElapsed: tracking ? Math.round(tracking.elapsed) : null,
    });
    input.value = '';
    // Refresh only the stream — keep the input focused for the next thought
    const stream = document.getElementById('postStream');
    if (stream) {
      const posts = State.getLogs({ type: 'post', entryId })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      stream.innerHTML = posts.map(renderPost).join('');
      refreshIcons();
    }
    input.focus();
  }

  function deletePost(id) {
    State.deleteLog(id);
    render();
  }

  let postMode = 'note'; // journal composer: plain post or checkable sub-task

  function setPostMode(m) {
    const typed = document.getElementById('postInput')?.value || '';
    postMode = m;
    render(); // placeholder + button label change with the mode
    const input = document.getElementById('postInput');
    if (input) { input.value = typed; input.focus(); }
  }

  function togglePostTodo(id) {
    const log = State.getLogs().find(l => l.id === id);
    if (!log) return;
    State.updateLog(id, { done: !log.done });
    render(); // stream + counter refresh (task page keeps scroll well enough)
  }

  // Turn a journal post into a task — the new-task modal opens prefilled
  function postToTask(postId) {
    const post = State.getLogs().find(l => l.id === postId);
    if (!post) return;
    const parent = post.entryId ? State.getEntry(post.entryId) : null;
    editingEntryId = null;
    entryTypeDraft = 'task';
    currentTags = [...(post.tags || [])];
    currentTags.forEach(n => State.getOrCreateTag(n));
    currentEffort = 'medium';
    currentWeekdays = [];
    currentProjects = parent ? [...State.entryProjectIds(parent)] : [];
    const title = (post.notes || '').replace(/#[a-z0-9_-]+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    showModal('New Task from Post', renderEntryForm('task', { title, description: post.notes }), [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveEntry()">Create</button>`,
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  // PROJECTS VIEW
  //
  // The workspace pill and the room strip decide WHAT you are looking at,
  // so this view no longer carries its own project chip wall. It shows one
  // of three things: the grid of workspaces, one workspace's page, or one
  // sub-project's page.
  //
  // Completed work is handled by recency, not by a single on/off switch:
  // anything finished today stays in place, everything older is opt-in and
  // sortable — because "what did I finish and when" is a different question
  // from "what is left".
  // ═══════════════════════════════════════════════════════════
  let tagFilter = null;

  const COMPLETED_SORTS = [
    { id: 'completedAt', label: 'Completed date' },
    { id: 'name',        label: 'Name' },
    { id: 'createdAt',   label: 'Created date' },
    { id: 'updatedAt',   label: 'Last modified' },
  ];

  function sortCompleted(list, key) {
    const by = {
      name:        (a, b) => (a.title || '').localeCompare(b.title || ''),
      createdAt:   (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
      updatedAt:   (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
      completedAt: (a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''),
    };
    return [...list].sort(by[key] || by.completedAt);
  }

  function setCompletedSort(key) {
    State.updateSettings({ completedSort: key });
    render();
  }

  function toggleShowCompletedToday() {
    State.updateSettings({ showCompletedOnToday: !State.getSettings().showCompletedOnToday });
    render();
  }

  function toggleShowCompleted() {
    State.updateSettings({ showCompletedOnProject: !State.getSettings().showCompletedOnProject });
    render();
  }

  function renderProjects() {
    // The pill decides the page. A sub-project beats a workspace; "All
    // Projects" with nothing selected shows the grid.
    const focusId = activeSubproject
      || (activeWorkspace !== WS_ALL && activeWorkspace !== WS_UNFILED ? activeWorkspace : null);
    if (focusId) return renderProjectPage(State.getProject(focusId));
    if (activeWorkspace === WS_UNFILED) return renderProjectPage(null);
    return renderProjectGrid();
  }

  // ── The grid: one card per workspace ──────────────────────────────────
  function renderProjectGrid() {
    const tops = State.getProjects().filter(p => p.depth === 0);
    const allOpen = State.getEntries().filter(e => !e.completed && e.type !== 'habit').length;

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="page-subtitle">${tops.length} workspace${tops.length === 1 ? '' : 's'} · ${allOpen} open</p>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary" onclick="App.openNewSubproject()">${icon('file-plus', 14)}Sub-project</button>
          <button class="btn btn-primary" onclick="App.openProjectModal()">${icon('folder-plus', 14)}Workspace</button>
        </div>
      </div>`;

    if (tops.length === 0) {
      return html + `<div class="empty-state">
        <i data-lucide="folder-kanban"></i>
        <p class="empty-state-text">No projects yet.</p>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);line-height:1.7;">
          Create one here, or open <a href="../txt.html" style="color:var(--accent-text)">Cade.txt</a> —
          its workspaces arrive as projects and any room with a <code>[ ]</code> list arrives as a sub-project.
        </p>
      </div>`;
    }

    html += `<div class="grid-3 section">`;
    tops.forEach(p => {
      const entries = State.getEntries({ projectId: p.id });
      const open = entries.filter(e => !e.completed && e.type !== 'habit').length;
      const doneToday = entries.filter(finishedToday).length;
      const done = entries.filter(e => e.completed).length;
      const subs = workspaceSubprojects(p.id).map(sp => ({ sp, a: subprojectActivity(sp) }));
      const liveSubs = subs.filter(x => x.a.live);
      const settledSubs = subs.length - liveSubs.length;

      html += `
        <div class="card card-interactive project-card" onclick="App.setWorkspace('${p.id}')" style="cursor:pointer;">
          <div class="project-header">
            <div class="project-icon" style="background:${p.color}20;color:${p.color}">
              <i data-lucide="${p.icon}"></i>
            </div>
            <div style="flex:1;min-width:0;">
              <div class="project-name">${escHtml(p.name)}${p.txtWorkspaceId ? ' <span class="ws-link-badge" title="Shared with Cade.txt">txt</span>' : ''}</div>
              <div class="project-stats">
                <span class="project-stat">${open} open</span>
                ${doneToday ? `<span class="project-stat">${doneToday} done today</span>` : ''}
              </div>
            </div>
            <button class="icon-btn" onclick="event.stopPropagation();App.openProjectModal('${p.id}')" aria-label="Edit project">${icon('pencil', 14)}</button>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${entries.length > 0 ? done / entries.length * 100 : 0}%;background:${p.color};"></div>
          </div>
          ${liveSubs.length ? `<div class="subproj-list">${liveSubs.map(({ sp, a }) => `
            <div class="subproj-row" style="padding-left:${(sp.depth || 0) * 14}px"
              onclick="event.stopPropagation();App.openSubproject('${p.id}','${sp.id}')">
              <span class="proj-dot" style="background:${sp.color}"></span>
              <span class="truncate" style="flex:1;">${escHtml(sp.name)}</span>
              <span class="project-stat">${a.open ? a.open + ' open' : a.doneToday + ' done today'}</span>
            </div>`).join('')}</div>` : ''}
          ${settledSubs ? `<p class="text-xs text-faint" style="margin-top:var(--space-2);">${settledSubs} sub-project${settledSubs === 1 ? '' : 's'} with nothing left to do</p>` : ''}
        </div>`;
    });
    html += `</div>`;
    return html;
  }

  // ── One project's page ────────────────────────────────────────────────
  // `proj` null means the Unfiled bucket.
  // Where you are, and the way back up. Three levels down a sub-project page
  // named the project but gave no clue what it sat inside or how to leave.
  function breadcrumbHtml(proj) {
    if (!proj) return '';
    const chain = [];
    let cur = proj.parentId ? State.getProject(proj.parentId) : null;
    let guard = 0;
    while (cur && guard++ < 20) {
      chain.unshift(cur);
      cur = cur.parentId ? State.getProject(cur.parentId) : null;
    }
    if (!chain.length) return '';
    return `<nav class="crumbs" aria-label="Breadcrumb">
      <button class="crumb" onclick="App.setWorkspace('${WS_ALL}')">All projects</button>
      ${chain.map(p => `<span class="crumb-sep">›</span>
        <button class="crumb" onclick="App.revealProject('${p.id}');App.switchTab('projects')">${escHtml(p.name)}</button>`).join('')}
      <span class="crumb-sep">›</span><span class="crumb crumb-here">${escHtml(proj.name)}</span>
    </nav>`;
  }

  function renderProjectPage(proj) {
    const settings = State.getSettings();
    const showDone = !!settings.showCompletedOnProject;
    const sortKey = settings.completedSort || 'completedAt';

    const all = proj
      ? State.getEntries({ projectId: proj.id })
      : State.getEntries().filter(e => State.entryProjectIds(e).length === 0);
    const entries = all.filter(e => !tagFilter || (e.tags || []).includes(tagFilter));

    const open = entries.filter(e => !e.completed || e.type === 'habit');
    const doneToday = entries.filter(finishedToday);
    const doneEarlier = entries.filter(e => e.completed && e.type !== 'habit' && !finishedToday(e));

    // Derived from the UNFILTERED set, plus the active tag: computing this
    // from `entries` (already narrowed by that very tag) made the selector
    // vanish the moment the filter matched nothing, stranding the page on an
    // empty view with no way back to "Any tag".
    const usedTags = [...new Set([
      ...all.flatMap(e => e.tags || []),
      ...(tagFilter ? [tagFilter] : []),
    ])];
    const subs = proj ? workspaceSubprojects(proj.id).map(sp => ({ sp, a: subprojectActivity(sp) })) : [];
    const liveSubs = subs.filter(x => x.a.live);
    const settledSubs = subs.filter(x => !x.a.live);

    let html = `
      ${breadcrumbHtml(proj)}
      <div class="page-header">
        <div>
          <h1 class="page-title">${proj ? `${icon(proj.icon, 16)} ${escHtml(proj.name)}` : 'Unfiled'}</h1>
          <p class="page-subtitle">
            ${open.filter(e => e.type !== 'habit').length} open${doneToday.length ? ` · ${doneToday.length} done today` : ''}${doneEarlier.length ? ` · ${doneEarlier.length} finished earlier` : ''}
            ${proj?.txtRoom ? ` · <a href="${txtRoomUrl(proj.txtRoom)}" style="color:var(--accent-text)">open in Cade.txt</a>` : ''}
          </p>
        </div>
        <div style="display:flex;gap:var(--space-2);align-items:center;">
          <button class="btn btn-primary" onclick="App.openNewEntry('task')">${icon('plus', 14)}Task</button>
          ${proj ? `<button class="icon-btn" onclick="App.openProjectModal('${proj.id}')" aria-label="Edit project" title="Edit project">${icon('pencil', 15)}</button>` : ''}
        </div>
      </div>`;

    // Toolbar: tag filter, plus the completed-work controls together in one
    // place instead of a lone eye icon in a section header.
    html += `<div class="proj-toolbar">
      ${usedTags.length ? `<select class="form-select proj-toolbar-select" onchange="App.setTagFilter(this.value || null)" aria-label="Filter by tag">
        <option value="">Any tag</option>
        ${usedTags.map(t => `<option value="${escHtml(t)}" ${tagFilter === t ? 'selected' : ''}>#${escHtml(t)}</option>`).join('')}
      </select>` : ''}
      <div class="proj-toolbar-spacer"></div>
      ${doneEarlier.length ? `
        <button class="btn btn-ghost btn-sm" onclick="App.toggleShowCompleted()" title="${showDone ? 'Hide work finished before today' : 'Show work finished before today'}">
          ${icon(showDone ? 'eye-off' : 'eye', 14)}${showDone ? 'Hide' : 'Show'} finished (${doneEarlier.length})
        </button>
        ${showDone ? `<select class="form-select proj-toolbar-select" onchange="App.setCompletedSort(this.value)" aria-label="Sort finished work">
          ${COMPLETED_SORTS.map(s => `<option value="${s.id}" ${sortKey === s.id ? 'selected' : ''}>Sort: ${s.label}</option>`).join('')}
        </select>` : ''}
      ` : ''}
    </div>`;

    // Anything typed here lands in THIS project, so the @project token is
    // only needed when you want it somewhere else.
    html += quickAddHtml(proj.id);

    // Sub-projects — a room with nothing left to do is hidden until asked for.
    if (subs.length) {
      const shown = showSettledSubs ? subs : liveSubs;
      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">Sub-projects</span>
          <span style="display:inline-flex;align-items:center;gap:var(--space-2);">
            ${settledSubs.length ? `<button class="btn btn-ghost btn-sm" onclick="App.toggleSettledSubs()">
              ${showSettledSubs ? 'Hide' : 'Show'} ${settledSubs.length} settled</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="App.openNewSubproject()">${icon('plus', 13)}New</button>
          </span>
        </div>
        ${shown.length === 0
          ? `<p class="text-xs text-faint">Every sub-project here is finished.</p>`
          : `<div class="subproj-grid">${shown.map(({ sp, a }) => `
              <button class="subproj-tile ${a.live ? '' : 'settled'}"
                style="margin-left:${(sp.depth || 0) * 14}px" onclick="App.setSubproject('${sp.id}')">
                <span class="proj-dot" style="background:${sp.color}"></span>
                <span class="truncate">${escHtml(sp.name)}</span>
                <span class="project-stat">${a.open ? a.open + ' open' : (a.doneToday ? a.doneToday + ' done today' : 'clear')}</span>
              </button>`).join('')}</div>`}
      </div>`;
    }

    // Open work, grouped by type.
    const types = ['goal', 'task', 'habit', 'reminder', 'checkin'];
    const typeIcons = { goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock', checkin: 'brain' };
    const typeLabels = { goal: 'Goals', task: 'Tasks', habit: 'Habits', reminder: 'Reminders', checkin: 'Check-ins' };
    let anyOpen = false;
    types.forEach(type => {
      const list = sortEntriesSmart(open.filter(e => e.type === type));
      if (!list.length) return;
      anyOpen = true;
      html += `<div class="section">
        <div class="section-header"><span class="section-title">${icon(typeIcons[type])} ${typeLabels[type]} (${list.length})</span>
          ${list.length > 1 ? '<span class="text-xs text-faint">drag to reorder</span>' : ''}</div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);" data-reorder-list="task">
          ${list.map(e => renderEntryCard(e, proj, null, { reorder: true })).join('')}
        </div>
      </div>`;
    });

    if (!anyOpen && !doneToday.length) {
      html += `<div class="empty-state"><i data-lucide="check-check"></i>
        <p class="empty-state-text">Nothing open here${tagFilter ? ` tagged #${escHtml(tagFilter)}` : ''}.</p></div>`;
    }

    // Finished today — always visible, so the day's work reads back.
    if (doneToday.length) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">${icon('check')} Done today (${doneToday.length})</span>${sectionToggle('projDoneToday')}</div>
        ${isCollapsed('projDoneToday') ? '' : `<div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${sortCompleted(doneToday, 'completedAt').map(e => renderEntryCard(e, proj)).join('')}
        </div>`}
      </div>`;
    }

    // Everything finished before today — opt-in, sorted the chosen way.
    if (showDone && doneEarlier.length) {
      const sorted = sortCompleted(doneEarlier, sortKey);
      const label = COMPLETED_SORTS.find(s => s.id === sortKey)?.label || 'Completed date';
      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">${icon('archive')} Finished earlier (${sorted.length})</span>
          <span class="text-xs text-faint">by ${label.toLowerCase()}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${sorted.map(e => renderEntryCard(e, proj)).join('')}
        </div>
      </div>`;
    }

    // Task chains stay — they answer "why can't I start this yet".
    const chained = entries.filter(e => e.type === 'task' && !e.completed && e.blockedBy?.length > 0);
    if (chained.length > 0) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Waiting on</span></div>
        <div class="task-chain">
          ${chained.map(t => (t.blockedBy || []).map(bid => {
            const blocker = State.getEntry(bid);
            return blocker ? `<div class="chain-link">
              <span class="proj-dot" style="background:${proj?.color || '#888'}"></span>
              <span class="text-sm">${escHtml(blocker.title)}</span>
              <i data-lucide="chevron-right" class="chain-arrow" style="width:14px;height:14px;"></i>
              <span class="text-sm">${escHtml(t.title)}</span>
            </div>` : '';
          }).join('')).join('')}
        </div>
      </div>`;
    }

    return html;
  }

  // Jump straight to a sub-project from the grid: adopt its workspace so the
  // room strip comes with it.
  function openSubproject(wsId, subId) {
    activeWorkspace = wsId;
    activeSubproject = subId;
    saveNav();
    render();
  }

  // The project the app is currently pointed at: a project id, the string
  // 'none' for the Unfiled bucket, or null for everything. Replaces the old
  // page-local `projectFilter` — the pill and the room strip own this now,
  // and export/new-entry/delete all read the same answer.
  // The top-level project a given one lives under — the pill only ever shows
  // a workspace, and a project nested more than one level deep has another
  // sub-project as its parent, not its workspace.
  function rootWorkspaceOf(id) {
    let cur = State.getProject(id);
    let guard = 0;
    while (cur && cur.parentId && guard++ < 100) {
      const parent = State.getProject(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur ? cur.id : null;
  }

  // Navigate to a project wherever it sits in the tree: its workspace becomes
  // the scope, and the project itself the selected room.
  function revealProject(id) {
    const proj = State.getProject(id);
    if (!proj) return;
    if (!proj.parentId) { activeWorkspace = id; activeSubproject = null; }
    else { activeWorkspace = rootWorkspaceOf(id) || WS_ALL; activeSubproject = id; }
    saveNav();
  }

  // A project that just got archived or deleted must not leave the pill or
  // the room strip pointing at it.
  function dropNavIfGone(id) {
    if (activeSubproject === id) activeSubproject = null;
    if (activeWorkspace === id) { activeWorkspace = WS_ALL; activeSubproject = null; }
    saveNav();
  }

  function focusedProjectId() {
    if (activeSubproject) return activeSubproject;
    if (activeWorkspace === WS_UNFILED) return 'none';
    if (activeWorkspace !== WS_ALL) return activeWorkspace;
    return null;
  }

  function setTagFilter(name) {
    tagFilter = tagFilter === name ? null : name;
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // LLM EXPORT — the currently filtered entries as clean JSON on
  // the clipboard: filter for #bugs, copy, paste into a chat.
  // ═══════════════════════════════════════════════════════════
  function currentProjectViewEntries() {
    // Mirrors exactly what the Projects view shows under the current scope
    const focus = focusedProjectId();
    let entries;
    if (focus === 'none') {
      entries = State.getEntries().filter(e => State.entryProjectIds(e).length === 0);
    } else if (focus) {
      entries = State.getEntries({ projectId: focus });
    } else {
      entries = State.getEntries();
    }
    entries = entries.filter(e => !tagFilter || (e.tags || []).includes(tagFilter));
    // Work finished before today is opt-in on screen, so it is opt-in here
    // too — the export copies what you can actually see.
    if (!State.getSettings().showCompletedOnProject) {
      entries = entries.filter(e => e.type === 'habit' || !e.completed || finishedToday(e));
    }
    return entries;
  }

  function buildLLMExport(entries) {
    const projName = (id) => State.getProject(id)?.name;
    const items = entries.map(e => {
      // Sparse objects: omit empty fields — fewer tokens, less noise
      const o = { title: e.title, type: e.type, status: e.archived ? 'archived' : e.completed ? 'completed' : 'open' };
      const projs = State.entryProjectIds(e).map(projName).filter(Boolean);
      if (projs.length) o.projects = projs;
      if (e.tags?.length) o.tags = e.tags;
      if (e.description) o.description = e.description;
      if (e.type === 'task') {
        if (e.priority) o.priority = e.priority;
        if (e.effort) o.effort = e.effort;
      }
      if (e.dueDate) o.due_date = e.dueDate;
      if (e.remindTime) o.remind_time = e.remindTime;
      if (e.estimateMinutes) o.estimate_minutes = e.estimateMinutes;
      const actual = State.actualMinutesFor(e);
      if (actual) o.actual_minutes = actual;
      if (e.type === 'goal' && e.targetValue) {
        o.progress = `${e.currentValue || 0}/${e.targetValue}${e.unit ? ' ' + e.unit : ''}`;
      }
      if (e.type === 'habit') {
        const s = State.calculateStreak(e.id);
        if (s.current) o.streak_days = s.current;
        const dow = e.recurrence?.daysOfWeek;
        if (dow?.length) o.scheduled_days = dow.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]);
      }
      if (e.createdAt) o.created = e.createdAt.slice(0, 10);
      if (e.completedAt) o.completed_on = e.completedAt.slice(0, 10);
      // Journal posts carry the working context an LLM actually needs
      const posts = State.getLogs({ type: 'post', entryId: e.id })
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
        .slice(-10);
      if (posts.length) {
        o.journal = posts.map(p => ({ at: (p.createdAt || '').slice(0, 16).replace('T', ' '), text: p.notes }));
      }
      return o;
    });

    const filterDesc = {};
    const focus = focusedProjectId();
    if (focus && focus !== 'none') {
      const proj = State.getProject(focus);
      filterDesc.project = proj ? `${proj.name}${State.getProjectSubtreeIds(proj.id).length > 1 ? ' (incl. sub-projects)' : ''}` : focus;
    } else if (focus === 'none') {
      filterDesc.project = 'unassigned only';
    }
    if (tagFilter) filterDesc.tag = `#${tagFilter}`;
    if (!State.getSettings().showCompletedOnProject) filterDesc.finished = 'open items and today\u2019s completions only';

    return {
      source: 'Cade.project task tracker export',
      exported_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      filters: Object.keys(filterDesc).length ? filterDesc : 'none — everything',
      entry_count: items.length,
      entries: items,
    };
  }

  async function exportForLLM() {
    const entries = currentProjectViewEntries();
    if (entries.length === 0) { toast('Nothing matches the current filters'); return; }
    const json = JSON.stringify(buildLLMExport(entries), null, 2);
    let copied = false;
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch (e) {
      // Clipboard API can be denied — fall back to execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch (e2) { copied = false; }
    }
    if (copied) {
      const focusName = focusedProjectId();
      const scope = [tagFilter ? `#${tagFilter}` : null, focusName && focusName !== 'none' ? State.getProject(focusName)?.name : null]
        .filter(Boolean).join(' in ') || 'all entries';
      toast(`Copied ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} as JSON — ${scope}`);
    } else {
      // Last resort: show the JSON for manual copy
      showModal('LLM Export', `
        <p class="text-xs text-muted" style="margin-bottom:var(--space-2);">Clipboard access was blocked — select all and copy manually:</p>
        <textarea class="form-textarea" style="min-height:300px;font-family:var(--font-mono);font-size:var(--text-xs);" onclick="this.select()">${json.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
      `, [`<button class="btn btn-secondary" onclick="App.closeModal()">Done</button>`]);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // HABITS VIEW
  // ═══════════════════════════════════════════════════════════
  let selectedHabit = null;

  function renderHabits() {
    const habits = scopedEntries({ type: 'habit' });
    const scoped = activeWorkspace !== WS_ALL || activeSubproject;
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Habits</h1>
          <p class="page-subtitle">${scoped ? escHtml(scopeLabel()) + ' · ' : ''}${habits.length} tracked · ${habits.filter(h => State.isHabitDoneToday(h.id)).length} done today</p>
        </div>
        <button class="btn btn-primary" onclick="App.openNewEntry('habit')">${icon('plus', 14)}New Habit</button>
      </div>
    `;

    if (habits.length === 0) {
      return html + `<div class="empty-state"><i data-lucide="repeat"></i><p class="empty-state-text">No habits yet. Create your first one.</p></div>`;
    }

    // Habit grid overview — cells cycle: empty → done → skipped → empty.
    // Skipped = accepted miss (bridges the streak). Off-days are dimmed.
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Completion Grid — Last 14 Days</span>
        <span class="text-xs text-faint">tap to cycle: done → skipped → empty</span>
      </div>
      <div class="card">
    `;

    habits.forEach(h => {
      const today = new Date();
      const proj = h.projectId ? State.getProject(h.projectId) : null;
      const dow = h.recurrence?.daysOfWeek;

      html += `<div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-3);">
        <div style="width:120px;flex-shrink:0;cursor:pointer;" onclick="App.selectHabit('${h.id}')">
          <div class="text-sm" style="font-weight:500;color:${selectedHabit === h.id ? 'var(--accent-text)' : 'inherit'};">${escHtml(h.title)}</div>
          ${proj ? `<div class="text-xs" style="color:${proj.color}">${escHtml(proj.name)}</div>` : ''}
          ${dow?.length ? `<div class="text-xs text-faint">${dow.map(d => 'SMTWTFS'[d]).join('·')}</div>` : ''}
        </div>
        <div class="habit-grid">`;

      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = State.dateStr(d);
        const status = State.habitStatusOn(h.id, dateStr);
        const offday = !State.isHabitScheduledOn(h.id, dateStr);
        const isTodayCell = i === 0;
        const cellColor = status === 'done' && proj?.color ? `style="background:${proj.color};border-color:${proj.color};"` : '';
        const hint = status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : offday ? 'not scheduled' : 'missed';
        html += `<div class="habit-cell ${status === 'done' ? 'completed' : ''} ${status === 'skipped' ? 'skipped' : ''} ${offday ? 'offday' : ''} ${isTodayCell ? 'today' : ''}" ${cellColor}
          title="${dateStr} — ${hint} · tap to cycle" onclick="App.cycleHabitCell('${h.id}','${dateStr}')"></div>`;
      }

      const s = State.calculateStreak(h.id);
      html += `</div>
        <span class="streak-display" style="width:50px;text-align:right;"><i data-lucide="flame"></i>${s.current}</span>
      </div>`;
    });

    html += `</div></div>`;

    if (!selectedHabit) {
      // Aggregate view — all habits stacked per day, color-coded by project
      html += `
        <div class="section">
          <div class="section-header"><span class="section-title">All Habits — Daily Completions (30 days)</span></div>
          <div class="card">
            <div class="chart-container" style="height:240px;"><canvas id="habitsAggChart"></canvas></div>
          </div>
        </div>
        <div class="section">
          <div class="card" style="text-align:center;">
            <p class="text-xs text-muted">Tap a habit's name for its detail charts — streak trend and monthly calendar.</p>
          </div>
        </div>
      `;
    }

    // Selected habit detail
    if (selectedHabit) {
      const habit = State.getEntry(selectedHabit);
      if (habit && habit.type === 'habit') {
        const s = State.calculateStreak(habit.id);
        html += `
          <div class="section">
            <div class="section-header">
              <button class="btn btn-secondary btn-sm" onclick="App.selectHabit(null)">${icon('arrow-left', 14)}All Habits</button>
              <span class="section-title">${habit.title} — Detail</span>
            </div>
            <div class="grid-2">
              <div class="card stat-card">
                <span class="stat-label">Current Streak</span>
                <span class="stat-value">${s.current} days</span>
              </div>
              <div class="card stat-card">
                <span class="stat-label">Best Streak</span>
                <span class="stat-value">${s.best} days</span>
              </div>
              <div class="card stat-card">
                <span class="stat-label">30-Day Retention</span>
                <span class="stat-value">${s.retention30}%</span>
              </div>
              <div class="card stat-card">
                <span class="stat-label">Total Completions</span>
                <span class="stat-value">${State.getHabitCompletions(habit.id).length}</span>
              </div>
            </div>
            <div class="card mt-3">
              <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Habit Strength (30 days)</span></div>
              <div class="chart-container"><canvas id="habitStrengthChart"></canvas></div>
            </div>
            <div class="card mt-3">
              <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Monthly Calendar</span></div>
              <div id="streakCalendarContainer"></div>
            </div>
          </div>
        `;
      }
    }

    return html;
  }

  function renderHabitCharts() {
    if (selectedHabit) {
      const habit = State.getEntry(selectedHabit);
      if (habit) {
        const canvas = document.getElementById('habitStrengthChart');
        if (canvas) Charts.renderHabitStrength('habitStrengthChart', selectedHabit);
        const calContainer = document.getElementById('streakCalendarContainer');
        if (calContainer) Charts.renderStreakCalendar(calContainer, selectedHabit);
      }
    } else {
      const agg = document.getElementById('habitsAggChart');
      // Same scope the page's habit list uses — see renderHabits().
      if (agg) Charts.renderHabitsAggregate('habitsAggChart', 30,
        scopedEntries({ type: 'habit' }).map(h => h.id));
    }
  }

  function selectHabit(id) {
    selectedHabit = id;
    render();
  }

  function toggleHabitCell(habitId, dateStr) {
    State.toggleHabitOnDate(habitId, dateStr);
    render();
  }

  function cycleHabitCell(habitId, dateStr) {
    State.cycleHabitOnDate(habitId, dateStr);
    if (State.habitStatusOn(habitId, dateStr) === 'done') checkStreakMilestone(habitId);
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // INSIGHTS VIEW
  // ═══════════════════════════════════════════════════════════
  let insightsProject = null; // null = all projects
  let insightsEntry = null;   // null = all tasks
  let pixelsMode = 'activity'; // Year in Pixels: 'activity' | 'mood'

  function setPixelsMode(mode) {
    pixelsMode = mode;
    render();
  }

  function insightsFilterObj() {
    return { projectId: insightsProject, entryId: insightsEntry };
  }

  // ── Weekly digest: this week vs last, at a glance ───────────
  function fmtMin(min) {
    min = Math.round(min);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function weekStats(dates, inFilter) {
    const dateSet = new Set(dates);
    const done = State.getEntries({ includeArchived: true }).filter(e =>
      e.type !== 'habit' && e.completed && e.completedAt && dateSet.has(e.completedAt.split('T')[0]) && inFilter(e)).length;
    const habitDone = State.getLogs({ type: 'habit_completion' })
      .filter(l => dateSet.has(l.date) && (!l.entryId || !State.getEntry(l.entryId) || inFilter(State.getEntry(l.entryId)))).length;

    let minutes = 0;
    const byProject = {};
    State.getLogs({ type: 'time_session' }).forEach(l => {
      if (!dateSet.has(l.date)) return;
      const en = l.entryId ? State.getEntry(l.entryId) : null;
      if (en && !inFilter(en)) return;
      const m = (l.value || 0) / 60;
      minutes += m;
      const pid = en?.projectId || null;
      if (pid) byProject[pid] = (byProject[pid] || 0) + m;
    });

    let scheduled = 0, completedHabits = 0;
    State.getEntries({ type: 'habit' }).filter(inFilter).forEach(h => {
      dates.forEach(d => {
        if (!State.isHabitScheduledOn(h.id, d)) return;
        const st = State.habitStatusOn(h.id, d);
        if (st === 'skipped') return; // skips don't count against consistency
        scheduled++;
        if (st === 'done') completedHabits++;
      });
    });
    const habitRate = scheduled > 0 ? Math.round(completedHabits / scheduled * 100) : null;

    const emotionMap = { great: 5, good: 4, okay: 3, low: 2, bad: 1 };
    const moods = [];
    State.getLogs().forEach(l => {
      if ((l.type === 'emotion' || l.type === 'checkin') && l.emotion && dateSet.has(l.date)) {
        moods.push(emotionMap[l.emotion] || 3);
      }
    });
    const avgMood = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null;

    return { done, habitDone, minutes, byProject, habitRate, avgMood };
  }

  function renderWeekDigest(inFilter) {
    const last7 = [...Array(7)].map((_, i) => offsetDateStr(-i));
    const prev7 = [...Array(7)].map((_, i) => offsetDateStr(-7 - i));
    const cur = weekStats(last7, inFilter);
    const prev = weekStats(prev7, inFilter);
    if (cur.done + cur.habitDone === 0 && cur.minutes === 0 && cur.avgMood === null) return '';

    const delta = (a, b, fmt = (v) => Math.abs(Math.round(v)), unit = '') => {
      if (b === null || a === null) return '';
      const d = a - b;
      if (Math.abs(d) < 0.005) return `<span class="digest-delta flat">— even</span>`;
      const up = d > 0;
      return `<span class="digest-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt(d)}${unit}</span>`;
    };
    const moodNames = ['', 'Bad', 'Low', 'Okay', 'Good', 'Great'];

    // best day of the week (completions + focus time)
    let best = null;
    last7.forEach(d => {
      const s = weekStats([d], inFilter);
      const score = s.done + s.habitDone + s.minutes / 30;
      if (score > 0 && (!best || score > best.score)) best = { date: d, score, s };
    });

    // top projects by focused time
    const top = Object.entries(cur.byProject)
      .map(([pid, min]) => ({ p: State.getProject(pid), min }))
      .filter(x => x.p).sort((a, b) => b.min - a.min).slice(0, 3);
    const maxMin = top[0]?.min || 1;

    return `<div class="section">
      <div class="card digest-card" id="weekDigest">
        <div class="section-header" style="margin-bottom:var(--space-3);">
          <span class="section-title">Your Week</span>
          <span class="text-xs text-faint">last 7 days vs the 7 before</span>
        </div>
        <div class="digest-tiles">
          <div class="digest-tile">
            <span class="stat-value">${cur.done + cur.habitDone}</span>
            <span class="stat-label">things done</span>
            ${delta(cur.done + cur.habitDone, prev.done + prev.habitDone)}
          </div>
          <div class="digest-tile">
            <span class="stat-value">${fmtMin(cur.minutes)}</span>
            <span class="stat-label">focused</span>
            ${delta(cur.minutes, prev.minutes, (v) => fmtMin(Math.abs(v)))}
          </div>
          <div class="digest-tile">
            <span class="stat-value">${cur.habitRate === null ? '—' : cur.habitRate + '%'}</span>
            <span class="stat-label">habit consistency</span>
            ${cur.habitRate !== null && prev.habitRate !== null ? delta(cur.habitRate, prev.habitRate, (v) => Math.abs(Math.round(v)), 'pts') : ''}
          </div>
          <div class="digest-tile">
            <span class="stat-value">${cur.avgMood === null ? '—' : moodNames[Math.round(cur.avgMood)]}</span>
            <span class="stat-label">avg mood${cur.avgMood !== null ? ` (${cur.avgMood.toFixed(1)})` : ''}</span>
            ${cur.avgMood !== null && prev.avgMood !== null ? delta(cur.avgMood, prev.avgMood, (v) => Math.abs(v).toFixed(1)) : ''}
          </div>
        </div>
        ${top.length ? `<div class="digest-projects">
          ${top.map(x => `<div class="digest-proj-row">
            <span class="proj-dot" style="background:${x.p.color}"></span>
            <span class="digest-proj-name truncate">${escHtml(x.p.name)}</span>
            <div class="digest-bar-track"><div class="digest-bar" style="width:${Math.round(x.min / maxMin * 100)}%;background:${x.p.color};"></div></div>
            <span class="text-xs font-mono text-muted">${fmtMin(x.min)}</span>
          </div>`).join('')}
        </div>` : ''}
        ${best ? `<p class="text-xs text-faint" style="margin-top:var(--space-3);margin-bottom:0;">
          Best day: <strong>${friendlyDate(best.date)}</strong> — ${best.s.done + best.s.habitDone} completion${best.s.done + best.s.habitDone === 1 ? '' : 's'}${best.s.minutes >= 1 ? ` · ${fmtMin(best.s.minutes)} focused` : ''}.
        </p>` : ''}
      </div>
    </div>`;
  }

  function renderInsights() {
    const projects = State.getProjects();
    const subtree = insightsProject ? State.getProjectSubtreeIds(insightsProject) : null;
    const inFilter = e => {
      if (subtree && !State.entryProjectIds(e).some(pid => subtree.includes(pid))) return false;
      if (insightsEntry && e.id !== insightsEntry) return false;
      return true;
    };
    const entries = State.getEntries().filter(inFilter);
    const habits = entries.filter(e => e.type === 'habit');
    const goals = entries.filter(e => e.type === 'goal');
    const tasks = entries.filter(e => e.type === 'task');

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Insights</h1>
          <p class="page-subtitle">Analytics${insightsProject ? ' · ' + (State.getProject(insightsProject)?.name || '') : ' across all your entries'}</p>
        </div>
      </div>
    `;

    // Filter bar: project chips + item select (every entry type of the
    // project — a project may hold only habits/reminders, not tasks)
    const filterableEntries = State.getEntries()
      .filter(e => !subtree || State.entryProjectIds(e).some(pid => subtree.includes(pid)));
    html += `<div class="filter-chips" style="align-items:center;">
      <button class="filter-chip ${!insightsProject ? 'active' : ''}" onclick="App.setInsightsProject(null)">All Projects</button>
      ${projects.map(p => `
        <button class="filter-chip ${insightsProject === p.id ? 'active' : ''}" onclick="App.setInsightsProject('${p.id}')">
          <span class="proj-dot" style="background:${p.color}"></span>${escHtml(p.name)}
        </button>`).join('')}
      <select class="form-select" style="width:auto;max-width:220px;padding:var(--space-1) var(--space-2);font-size:var(--text-xs);" onchange="App.setInsightsEntry(this.value || null)">
        <option value="">All items</option>
        ${filterableEntries.map(t => `<option value="${t.id}" ${insightsEntry === t.id ? 'selected' : ''}>[${t.type}] ${escHtml(t.title)}</option>`).join('')}
      </select>
    </div>`;

    // ── "Your Week" digest — last 7 days vs the 7 before ──────
    html += renderWeekDigest(inFilter);

    // KPI row
    const totalStreak = habits.reduce((sum, h) => sum + State.calculateStreak(h.id).current, 0);
    const avgRetention = habits.length > 0 ? Math.round(habits.reduce((sum, h) => sum + State.calculateStreak(h.id).retention30, 0) / habits.length) : 0;
    const completionRate = tasks.length > 0 ? Math.round(tasks.filter(t => t.completed).length / tasks.length * 100) : 0;

    html += `<div class="grid-3 section">
      <div class="card stat-card"><span class="stat-label">Total Active Streaks</span><span class="stat-value">${totalStreak} days</span></div>
      <div class="card stat-card"><span class="stat-label">Avg Habit Retention</span><span class="stat-value">${avgRetention}%</span></div>
      <div class="card stat-card"><span class="stat-label">Task Completion Rate</span><span class="stat-value">${completionRate}%</span></div>
    </div>`;

    // Estimate vs actual accuracy (completed tasks with both numbers)
    const estimated = State.getEntries({ type: 'task', includeArchived: true })
      .filter(inFilter)
      .filter(t => t.completed && t.estimateMinutes > 0 && State.actualMinutesFor(t) > 0);
    if (estimated.length > 0) {
      const ratios = estimated.map(t => State.actualMinutesFor(t) / t.estimateMinutes);
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const verdict = avgRatio > 1.1 ? `you underestimate by ~${Math.round((avgRatio - 1) * 100)}%`
        : avgRatio < 0.9 ? `you overestimate by ~${Math.round((1 - avgRatio) * 100)}%`
        : 'your estimates are on the money';
      html += `<div class="section">
        <div class="card">
          <div class="section-header" style="margin-bottom:var(--space-2);"><span class="section-title">Estimation Accuracy</span>
            <span class="stat-label">${estimated.length} completed task${estimated.length === 1 ? '' : 's'} with estimate + actual</span>
          </div>
          <span class="stat-value">${avgRatio.toFixed(2)}×</span>
          <p class="text-xs text-muted" style="margin-top:var(--space-1);">Actual ÷ estimate on average — ${verdict}. Add an actual time when editing completed tasks to sharpen this.</p>
        </div>
      </div>`;
    }

    // Year in Pixels — every day of the last year, activity or mood
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Year in Pixels</span>
        <span style="display:inline-flex;align-items:center;gap:var(--space-2);">
          <span class="text-xs text-faint">click a day to revisit it</span>
          <button class="filter-chip ${pixelsMode === 'activity' ? 'active' : ''}" onclick="App.setPixelsMode('activity')">Activity</button>
          <button class="filter-chip ${pixelsMode === 'mood' ? 'active' : ''}" onclick="App.setPixelsMode('mood')">Mood</button>
        </span>
      </div>
      <div class="card"><div id="heatmapContainer"></div></div>
    </div>`;

    // Day breakdown (mood & energy chart moved to Health)
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Tasks — Last 7 Days</span></div>
        <div class="chart-container"><canvas id="dayBreakdownChart"></canvas></div>
      </div>
    </div>`;

    // Habit ↔ mood correlation
    const correlations = habitMoodCorrelations();
    if (correlations.length > 0) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Habits ↔ Mood</span>
          <span class="text-xs text-faint">avg mood on days done vs not (last 60 days)</span>
        </div>
        <div class="card">
          ${correlations.map(c => `
            <div class="done-row">
              <span class="proj-dot" style="background:${c.color}"></span>
              <span class="truncate" style="flex:1;">${c.title}</span>
              <span class="font-mono text-xs" style="color:${c.delta >= 0 ? 'var(--success)' : 'var(--error)'};">
                ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)} mood
              </span>
              <span class="text-xs text-faint" style="flex-shrink:0;">${c.doneDays}d done / ${c.notDays}d not</span>
            </div>`).join('')}
          <p class="text-xs text-faint" style="margin-top:var(--space-2);">Mood scale: Bad=1 … Great=5, averaged per day from your day mood + check-ins. Correlation ≠ causation, but patterns are worth noticing.</p>
        </div>
      </div>`;
    }

    // Habit radar + Effort distribution
    html += `<div class="grid-2 section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Habit Consistency (30-day)</span></div>
        <div class="chart-container"><canvas id="habitRadarChart"></canvas></div>
      </div>
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Effort Distribution</span></div>
        <div class="chart-container"><canvas id="effortDistChart"></canvas></div>
      </div>
    </div>`;

    // Goal progress cards
    if (goals.length > 0) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Goal Progress</span></div>
        <div class="grid-2">
      `;
      goals.forEach(g => {
        const pct = g.targetValue ? Math.round((g.currentValue || 0) / g.targetValue * 100) : 0;
        html += `
          <div class="card">
            <div style="display:flex;align-items:center;gap:var(--space-3);">
              <div style="width:80px;height:80px;position:relative;flex-shrink:0;">
                <canvas id="goalChart_${g.id}"></canvas>
              </div>
              <div style="flex:1;min-width:0;">
                <div class="text-sm" style="font-weight:600;margin-bottom:var(--space-1)">${g.title}</div>
                <div class="text-xs text-muted">${g.currentValue || 0} / ${g.targetValue} ${g.unit || ''}</div>
                <div class="progress-bar mt-2"><div class="progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
              </div>
            </div>
          </div>
        `;
      });
      html += `</div></div>`;
    }

    return html;
  }

  function setInsightsProject(id) {
    insightsProject = id;
    insightsEntry = null; // task filter is scoped to the project
    render();
  }

  function setInsightsEntry(id) {
    insightsEntry = id;
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // FOCUS TAB — "what should I work on next?"
  // Four-quadrant board: color-coded, draggable, full-item hitbox
  // ═══════════════════════════════════════════════════════════
  let focusDue = null; // null | 'overdue' | 'today' | 'week' | 'later' | 'none'

  const FOCUS_DUE_CHIPS = [
    [null, 'Any due'], ['overdue', 'Overdue'], ['today', 'Due today'],
    ['week', 'This week'], ['later', 'Later'], ['none', 'No date'],
  ];

  function focusDueMatch(t) {
    if (!focusDue) return true;
    const today = State.todayStr();
    if (focusDue === 'none') return !t.dueDate;
    if (!t.dueDate) return false;
    if (focusDue === 'overdue') return t.dueDate < today;
    if (focusDue === 'today') return t.dueDate === today;
    if (focusDue === 'week') return t.dueDate >= today && t.dueDate <= offsetDateStr(7);
    if (focusDue === 'later') return t.dueDate > offsetDateStr(7);
    return true;
  }

  const QUADRANTS = [
    { q: 1, label: 'Do First · High Pri / Low Effort', hiPri: true, hiEff: false },
    { q: 2, label: 'Schedule · High Pri / High Effort', hiPri: true, hiEff: true },
    { q: 3, label: 'Quick Wins · Low Pri / Low Effort', hiPri: false, hiEff: false },
    { q: 4, label: 'Later · Low Pri / High Effort', hiPri: false, hiEff: true },
  ];

  function renderFocus() {
    // Project scope comes from the menubar pill, like everywhere else — the
    // page-level chip wall that used to sit here said the same thing twice.
    const scoped = activeWorkspace !== WS_ALL || activeSubproject;
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Focus</h1>
          <p class="page-subtitle">Effort vs priority${scoped ? ` · ${escHtml(scopeLabel())}` : ''} — figure out what to work on next</p>
        </div>
      </div>
      <div class="filter-chips">
        <span class="stat-label" style="align-self:center;">${icon('calendar-days', 11)}</span>
        ${FOCUS_DUE_CHIPS.map(([val, label]) => `
          <button class="filter-chip ${focusDue === val ? 'active' : ''}" onclick="App.setFocusDue(${val === null ? 'null' : `'${val}'`})">${label}</button>
        `).join('')}
      </div>
      <div class="section">
        <div class="section-header"><span class="section-title">Four Quadrant</span>
          <span class="text-xs text-faint">drag between boxes to reprioritize · click to complete</span>
        </div>
        <div class="card">
          <div class="quadrant quadrant-xl" id="quadrantView">${renderQuadrant()}</div>
        </div>
      </div>
    `;
    return html;
  }

  function setFocusDue(v) {
    focusDue = v;
    render();
  }

  function renderQuadrant() {
    const tasks = scopedEntries({ type: 'task', completed: false }).filter(focusDueMatch);
    const effOrder = { trivial: 0, small: 1, medium: 2, large: 3, xl: 4 };
    const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    // Project dots only earn their place when more than one project is in view
    const multiProject = activeWorkspace === WS_ALL && !activeSubproject;

    function itemsFor(qd) {
      return tasks.filter(t => {
        const hiPri = (priOrder[t.priority] ?? 2) <= 1;
        const hiEff = (effOrder[t.effort] ?? 2) > 1;
        return hiPri === qd.hiPri && hiEff === qd.hiEff;
      });
    }

    function renderItems(items) {
      if (items.length === 0) return '<div class="planner-empty">No tasks</div>';
      const MAX = 8;
      // Highest next-best score first within each quadrant
      const ranked = [...items].sort((a, b) => taskScore(b) - taskScore(a));
      let out = ranked.slice(0, MAX).map(t => {
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        const score = taskScore(t);
        return `<div class="q-item ${t.completed ? 'completed' : ''} ${t.priority === 'urgent' ? 'urgent' : ''}" draggable="true" data-id="${t.id}"
          ondragstart="App.qDragStart(event,'${t.id}')" ondragend="App.qDragEnd(event)"
          onclick="App.qItemClick(event,'${t.id}')" ondblclick="App.openTaskPage('${t.id}')" title="${escHtml(t.title)} · score ${score}">
          <span class="q-handle">⠿</span>
          ${multiProject && proj ? `<span class="proj-dot" style="background:${proj.color}"></span>` : ''}
          <span class="q-title">${escHtml(t.title)}</span>
          ${t.estimateMinutes ? `<span class="q-est">${estimateLabel(t.estimateMinutes)}</span>` : ''}
          <span class="q-score" title="Next-best score">${score}</span>
          <span class="q-actions">
            <button class="icon-btn" onclick="event.stopPropagation();App.editEntry('${t.id}')" aria-label="Edit">${icon('pencil', 12)}</button>
          </span>
        </div>`;
      }).join('');
      if (items.length > MAX) out += `<div class="text-xs text-faint" style="padding:2px var(--space-2);">+${items.length - MAX} more</div>`;
      return out;
    }

    return QUADRANTS.map(qd => `
      <div class="quadrant-box q${qd.q}" ondragover="App.qDragOver(event)" ondragleave="App.qDragLeave(event)" ondrop="App.qDrop(event,${qd.q})">
        <div class="quadrant-label">${qd.label}</div>
        ${renderItems(itemsFor(qd))}
      </div>
    `).join('');
  }

  let draggingTaskId = null;
  let didDrag = false;

  // ═══════════════════════════════════════════════════════════
  // DRAG TO REORDER
  // ═══════════════════════════════════════════════════════════
  // One mechanism for both lists. The row being dragged is remembered by id;
  // dropping on another row splices it into that position and rewrites the
  // whole run's order fields, because nudging one number leaves ties that
  // then sort unpredictably.
  let reorderDrag = null;   // { id, list: 'project' | 'task' }

  function reorderStart(e, id, list) {
    reorderDrag = { id, list };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (err) {}
    e.currentTarget.classList.add('reordering');
    e.stopPropagation();
  }

  function reorderEnd(e) {
    reorderDrag = null;
    e.currentTarget.classList.remove('reordering');
    document.querySelectorAll('.reorder-over').forEach(x => x.classList.remove('reorder-over'));
  }

  function reorderOver(e, list) {
    if (!reorderDrag || reorderDrag.list !== list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('reorder-over');
  }

  function reorderLeave(e) { e.currentTarget.classList.remove('reorder-over'); }

  function reorderDrop(e, targetId, list) {
    if (!reorderDrag || reorderDrag.list !== list) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('reorder-over');
    const movedId = reorderDrag.id;
    reorderDrag = null;
    if (!movedId || movedId === targetId) return;

    const container = e.currentTarget.closest('[data-reorder-list]');
    if (!container) return;
    const ids = [...container.querySelectorAll('[data-reorder-id]')].map(x => x.dataset.reorderId);
    const from = ids.indexOf(movedId), to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);

    undoable('Reordered', () => {
      if (list === 'project') State.reorderProjects(ids); else State.reorderEntries(ids);
    }, { quiet: true });
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // TASK → PLANNER
  // ═══════════════════════════════════════════════════════════
  // The planner grid and the task list were the same day drawn twice, with
  // no way to get from one to the other. Dropping a task on an hour schedules
  // it there, for as long as its estimate says.
  const TASK_DRAG_TYPE = 'application/x-cade-task';
  let draggingPlannerTask = null;

  function taskDragStart(e, id) {
    draggingPlannerTask = id;
    e.dataTransfer.effectAllowed = 'copy';
    try {
      e.dataTransfer.setData(TASK_DRAG_TYPE, id);
      e.dataTransfer.setData('text/plain', id);   // Safari wants a known type
    } catch (err) {}
    e.currentTarget.classList.add('dragging');
  }

  function taskDragEnd(e) {
    draggingPlannerTask = null;
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.planner-hour.drop-target').forEach(x => x.classList.remove('drop-target'));
  }

  function plannerDragOver(e) {
    if (!draggingPlannerTask) return;   // not our drag — leave the browser to it
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    e.currentTarget.classList.add('drop-target');
  }

  function plannerDragLeave(e) {
    e.currentTarget.classList.remove('drop-target');
  }

  function plannerDrop(e, dateStr, hour) {
    e.preventDefault();
    e.currentTarget.classList.remove('drop-target');
    const id = draggingPlannerTask ||
      (e.dataTransfer && (e.dataTransfer.getData(TASK_DRAG_TYPE) || e.dataTransfer.getData('text/plain')));
    draggingPlannerTask = null;
    const task = id && State.getEntry(id);
    if (!task) return;

    // Drop position within the hour, rounded to the nearest quarter, so the
    // block lands where the pointer was rather than always on the hour.
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = rect.height ? Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 0.99) : 0;
    const startMin = hour * 60 + Math.round(frac * 4) * 15;
    const dur = Math.min(Math.max(task.estimateMinutes || 30, 15), 240);
    const proj = task.projectId ? State.getProject(task.projectId) : null;

    undoable(`Scheduled “${task.title}”`, () => {
      State.createPlannerBlock({
        date: dateStr,
        start: minToTime(startMin),
        end: minToTime(Math.min(startMin + dur, 24 * 60 - 1)),
        title: task.title,
        entryId: task.id,
        projectId: task.projectId || null,
        color: proj?.color || null,
        kind: 'agenda',
      });
      // A task you have given a time to is a task you mean to do that day.
      State.updateEntry(task.id, { scheduledDate: dateStr });
    }, { quiet: true });
    toast(`Scheduled at ${minToTime(startMin)}`, { undo: true });
    render();
  }

  function qDragStart(e, id) {
    draggingTaskId = id;
    didDrag = false;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (err) {}
    e.target.classList.add('dragging');
  }

  function qDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.quadrant-box.drag-over').forEach(b => b.classList.remove('drag-over'));
  }

  function qDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }

  function qDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function qDrop(e, q) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const id = draggingTaskId || e.dataTransfer.getData('text/plain');
    draggingTaskId = null;
    didDrag = true;
    const entry = State.getEntry(id);
    if (!entry) return;
    const qd = QUADRANTS.find(x => x.q === q);
    const updates = {};
    // Dropping into a quadrant rewrites the task's priority/effort meta —
    // only nudge values that don't already satisfy the quadrant.
    const hiPriNow = ['urgent', 'high'].includes(entry.priority);
    const hiEffNow = ['medium', 'large', 'xl'].includes(entry.effort);
    if (qd.hiPri && !hiPriNow) updates.priority = 'high';
    if (!qd.hiPri && hiPriNow) updates.priority = 'medium';
    if (qd.hiEff && !hiEffNow) updates.effort = 'large';
    if (!qd.hiEff && hiEffNow) updates.effort = 'small';
    if (Object.keys(updates).length > 0) State.updateEntry(id, updates);
    render();
  }

  function qItemClick(e, id) {
    // A completed drag also fires click — suppress the accidental toggle.
    if (didDrag) { didDrag = false; return; }
    toggleEntry(id);
  }

  // Per-habit mood delta: average day-mood on completed vs non-completed
  // days over the last 60 days (only days that have mood data at all).
  function habitMoodCorrelations() {
    const emotionMap = { great: 5, good: 4, okay: 3, low: 2, bad: 1 };
    const moodByDate = {};
    State.getLogs().forEach(l => {
      if ((l.type === 'emotion' || l.type === 'checkin') && l.emotion) {
        (moodByDate[l.date] = moodByDate[l.date] || []).push(emotionMap[l.emotion] || 3);
      }
    });
    const cutoff = offsetDateStr(-60);
    const moodDates = Object.keys(moodByDate).filter(d => d >= cutoff);
    if (moodDates.length < 6) return [];
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const out = [];
    State.getEntries({ type: 'habit' }).forEach(h => {
      const done = new Set(State.getHabitCompletions(h.id));
      const doneMoods = [], notMoods = [];
      moodDates.forEach(d => {
        (done.has(d) ? doneMoods : notMoods).push(avg(moodByDate[d]));
      });
      if (doneMoods.length < 3 || notMoods.length < 3) return; // too little signal
      const proj = h.projectId ? State.getProject(h.projectId) : null;
      out.push({
        title: h.title,
        color: proj?.color || 'var(--accent)',
        delta: avg(doneMoods) - avg(notMoods),
        doneDays: doneMoods.length,
        notDays: notMoods.length,
      });
    });
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
  }

  function renderInsightCharts() {
    const f = insightsFilterObj();
    const heatmap = document.getElementById('heatmapContainer');
    if (heatmap) Charts.renderHeatmap(heatmap, 364, f, pixelsMode);

    const dayChart = document.getElementById('dayBreakdownChart');
    if (dayChart) Charts.renderDayBreakdown('dayBreakdownChart', 7, f);


    const radarChart = document.getElementById('habitRadarChart');
    if (radarChart) Charts.renderHabitRadar('habitRadarChart', f);

    const effortChart = document.getElementById('effortDistChart');
    if (effortChart) Charts.renderEffortDist('effortDistChart', f);

    // Goal charts
    State.getEntries({ type: 'goal' })
      .filter(g => !insightsProject || g.projectId === insightsProject)
      .forEach(g => {
        const canvas = document.getElementById(`goalChart_${g.id}`);
        if (canvas) Charts.renderGoalProgress(`goalChart_${g.id}`, g);
      });
  }

  // ═══════════════════════════════════════════════════════════
  // HEALTH TAB — food logging, calories, macros
  // ═══════════════════════════════════════════════════════════
  function renderHealth() {
    const today = State.todayStr();
    const goal = State.getSettings().calorieGoal || 2000;
    const foodLogs = State.getLogs({ type: 'calorie', date: today })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const totalCal = foodLogs.reduce((s, l) => s + (l.value || 0), 0);
    const totalP = foodLogs.reduce((s, l) => s + (l.protein || 0), 0);
    const totalC = foodLogs.reduce((s, l) => s + (l.carbs || 0), 0);
    const totalF = foodLogs.reduce((s, l) => s + (l.fat || 0), 0);

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Health</h1>
          <p class="page-subtitle">Food log · calories · macros</p>
        </div>
        <button class="btn btn-secondary" onclick="App.openQuickLog()">${icon('zap', 16)}Quick Log</button>
      </div>
    `;

    // Calories today
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Calories Today</span></div>
        <div class="calorie-display">
          <span class="calorie-number">${totalCal}</span>
          <span class="calorie-goal">/ ${goal} cal</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(totalCal / goal * 100, 100)}%;${totalCal > goal ? 'background:var(--error);' : ''}"></div>
        </div>
      </div>
    </div>`;

    // Macro stat cards
    html += `<div class="grid-3 section">
      <div class="card stat-card"><span class="stat-label">Protein</span><span class="stat-value">${totalP}g</span></div>
      <div class="card stat-card"><span class="stat-label">Carbs</span><span class="stat-value">${totalC}g</span></div>
      <div class="card stat-card"><span class="stat-label">Fat</span><span class="stat-value">${totalF}g</span></div>
    </div>`;

    // Wake / Sleep logging + trend chart (lives here, not Insights —
    // sleep isn't task analytics)
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Wake / Sleep</span></div>
      <div class="card">
        <div class="wake-sleep-row">
          <input type="time" class="form-input" id="wakeSleepTimeHealth">
          <button class="btn btn-secondary" onclick="App.logWake('wakeSleepTimeHealth')">${icon('sunrise', 15)}Wake</button>
          <button class="btn btn-secondary" onclick="App.logSleep('wakeSleepTimeHealth')">${icon('moon', 15)}Sleep</button>
        </div>
        <div id="wakeSleepCurrent" style="margin-top:var(--space-2);">${renderWakeSleepCurrent()}</div>
        <p class="text-xs text-faint" style="margin-top:var(--space-1);">Enter a time first — nothing defaults to "now". One of each per day; logging again updates it.</p>
        <div class="divider"></div>
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Wake / Sleep — 14 Days</span></div>
        <div class="chart-container"><canvas id="sleepChart"></canvas></div>
      </div>
    </div>`;

    // Mood & Energy trend — body data, so it lives with Health now
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Mood & Energy — 14 Days</span></div>
        <div class="chart-container"><canvas id="emotionTrendChart"></canvas></div>
      </div>
    </div>`;

    // Log food form — ALL shortcuts show here (water counts as health too)
    const shortcuts = State.getSettings().quickShortcuts || [];
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Log Food</span></div>
      <div class="card">
        ${shortcuts.length > 0 ? `<div class="shortcut-chips" style="margin-bottom:var(--space-3);">
          ${shortcuts.map(s => `
            <button class="shortcut-chip" id="sc-${s.id}" onclick="App.useShortcutHealth('${s.id}')">
              <span>${s.emoji}</span><span>${escHtml(s.label)}</span><span class="sc-cal">${s.calories} cal</span>
            </button>`).join('')}
        </div>` : ''}
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Calories <span class="text-faint">(optional)</span></label>
            <input type="number" class="form-input" id="foodCal" placeholder="e.g. 450" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Meal</label>
            <select class="form-select" id="foodMeal">
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snack" selected>Snack</option>
            </select>
          </div>
        </div>
        <div class="grid-3" style="grid-template-columns:1fr 1fr 1fr;">
          <div class="form-group">
            <label class="form-label">Protein (g)</label>
            <input type="number" class="form-input" id="foodProtein" placeholder="0" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Carbs (g)</label>
            <input type="number" class="form-input" id="foodCarbs" placeholder="0" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Fat (g)</label>
            <input type="number" class="form-input" id="foodFat" placeholder="0" min="0">
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <input type="text" class="form-input" id="foodNote" placeholder="What did you eat? (optional)" style="flex:1;">
          <button class="btn btn-primary" onclick="App.logFood()">${icon('plus', 14)}Add</button>
        </div>
      </div>
    </div>`;

    // Charts
    html += `<div class="grid-2 section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Calories — Last 7 Days</span></div>
        <div class="chart-container"><canvas id="calorieWeekChart"></canvas></div>
      </div>
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Macro Split — Today</span></div>
        ${totalP + totalC + totalF > 0
          ? `<div class="chart-container"><canvas id="macroChart"></canvas></div>`
          : `<div class="empty-state" style="padding:var(--space-6) var(--space-4);"><i data-lucide="pie-chart"></i><p class="empty-state-text">Log protein / carbs / fat with a meal to see the split.</p></div>`}
      </div>
    </div>`;

    // Today's food list
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Today's Food</span>
        <span class="stat-label">${foodLogs.length} entries</span>
      </div>
      <div class="card">`;
    if (foodLogs.length === 0) {
      html += `<p class="text-xs text-faint">Nothing logged yet today.</p>`;
    } else {
      foodLogs.forEach(l => {
        const macros = [l.protein ? `${l.protein}P` : '', l.carbs ? `${l.carbs}C` : '', l.fat ? `${l.fat}F` : ''].filter(Boolean).join(' · ');
        html += `<div class="food-row">
          <span class="done-time">${logTimeOf(l)}</span>
          <span class="pill">${l.meal || 'snack'}</span>
          <span class="truncate" style="flex:1;">${l.emoji ? l.emoji + ' ' : ''}${escHtml(l.notes || 'Food')}</span>
          ${macros ? `<span class="food-macros">${macros}</span>` : ''}
          <span class="font-mono text-xs" style="color:var(--accent-text);flex-shrink:0;">${l.value ? `${l.value} cal` : '—'}</span>
          <button class="icon-btn" onclick="App.deleteFoodLog('${l.id}')" aria-label="Delete">${icon('trash-2', 14)}</button>
        </div>`;
      });
    }
    html += `</div></div>`;

    return html;
  }

  function renderHealthCharts() {
    const week = document.getElementById('calorieWeekChart');
    if (week) Charts.renderCalorieWeek('calorieWeekChart', 7);
    const sleep = document.getElementById('sleepChart');
    if (sleep) Charts.renderSleepChart('sleepChart', 14);
    const emotionChart = document.getElementById('emotionTrendChart');
    if (emotionChart) Charts.renderMoodEnergy('emotionTrendChart', 14);
    const macro = document.getElementById('macroChart');
    if (macro) {
      const today = State.todayStr();
      const logs = State.getLogs({ type: 'calorie', date: today });
      Charts.renderMacroSplit('macroChart', {
        protein: logs.reduce((s, l) => s + (l.protein || 0), 0),
        carbs: logs.reduce((s, l) => s + (l.carbs || 0), 0),
        fat: logs.reduce((s, l) => s + (l.fat || 0), 0),
      });
    }
  }

  function logFood() {
    const cal = parseInt(document.getElementById('foodCal')?.value) || null;
    const meal = document.getElementById('foodMeal')?.value || 'snack';
    const notes = document.getElementById('foodNote')?.value?.trim() || '';
    // Calories are optional — logging just the item name is fine
    if (!cal && !notes) { toast('Add a name or calories'); return; }
    const macros = {
      protein: parseInt(document.getElementById('foodProtein')?.value) || null,
      carbs: parseInt(document.getElementById('foodCarbs')?.value) || null,
      fat: parseInt(document.getElementById('foodFat')?.value) || null,
    };
    State.logCalories(cal, notes, meal, macros);
    render();
  }

  function useShortcutHealth(id) {
    State.logQuickShortcut(id);
    render();
  }

  function deleteFoodLog(id) {
    State.deleteLog(id);
    render();
  }


  // ═══════════════════════════════════════════════════════════
  // HISTORY VIEW — completions, day evolution, archive
  // ═══════════════════════════════════════════════════════════
  let historyOffset = 0;

  function renderHistory() {
    const dateStr = offsetDateStr(historyOffset);
    const isTodayView = historyOffset === 0;

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">History</h1>
          <p class="page-subtitle">What got done and how the day evolved</p>
        </div>
        <div class="planner-nav">
          <button class="icon-btn" onclick="App.historyNav(-1)" aria-label="Previous day">${icon('chevron-left', 16)}</button>
          <span class="planner-date-label">${friendlyDate(dateStr)}</span>
          <button class="icon-btn" onclick="App.historyNav(1)" aria-label="Next day" ${isTodayView ? 'style="opacity:0.3;pointer-events:none;"' : ''}>${icon('chevron-right', 16)}</button>
          ${!isTodayView ? `<button class="btn btn-ghost btn-sm" onclick="App.historyToday()">Today</button>` : ''}
        </div>
      </div>
    `;

    // Day evolution timeline
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Day Evolution</span>
        <span class="text-xs text-faint">bars = time blocks · dashed lines = quick logs</span>
      </div>
      <div class="card"><div id="dayTimelineContainer"></div></div>
    </div>`;

    // Completions
    const completedTasks = State.getEntries({ includeArchived: true })
      .filter(e => e.type !== 'habit' && e.completed && e.completedAt?.startsWith(dateStr))
      .map(e => ({ time: logTimeOf({ createdAt: e.completedAt }), kind: 'task', title: e.title, entry: e }));
    const habitDone = State.getLogs({ type: 'habit_completion', date: dateStr })
      .map(l => {
        const h = State.getEntry(l.entryId);
        return h ? { time: logTimeOf(l), kind: 'habit', title: h.title, entry: h } : null;
      }).filter(Boolean);
    const timeSessions = State.getLogs({ type: 'time_session', date: dateStr })
      .map(l => {
        const en = l.entryId ? State.getEntry(l.entryId) : null;
        // entryTitle snapshot keeps history meaningful after deletion
        const title = en?.title || l.entryTitle || 'deleted task';
        return { time: logTimeOf(l), kind: 'time', title: `${Timers.formatTime(l.value || 0)} on ${title}`, entry: en, logId: l.id };
      });
    const doneRows = [...completedTasks, ...habitDone, ...timeSessions].sort((a, b) => a.time.localeCompare(b.time));

    html += `<div class="section">
      <div class="section-header"><span class="section-title">Completed ${friendlyDate(dateStr)}</span>
        <span class="stat-label">${completedTasks.length + habitDone.length} completions</span>
      </div>
      <div class="card">`;
    if (doneRows.length === 0) {
      html += `<div class="empty-state"><i data-lucide="check-circle-2"></i><p class="empty-state-text">Nothing completed this day yet.</p></div>`;
    } else {
      const kindIcons = { task: 'check', habit: 'repeat', time: 'timer' };
      doneRows.forEach(r => {
        const proj = r.entry?.projectId ? State.getProject(r.entry.projectId) : null;
        html += `<div class="done-row">
          <span class="done-time">${r.time}</span>
          ${icon(kindIcons[r.kind], 14)}
          <span class="proj-dot" style="background:${proj?.color || 'var(--text-faint)'}"></span>
          <span class="truncate" style="flex:1">${escHtml(r.title)}</span>
          ${r.kind === 'task' ? `<button class="icon-btn" onclick="App.toggleEntry('${r.entry.id}')" aria-label="Un-complete" title="Mark as not done">${icon('undo-2', 14)}</button>` : ''}
          ${r.kind === 'time' ? `<button class="icon-btn" onclick="App.deleteHistoryLog('${r.logId}')" aria-label="Delete" title="Delete this time log">${icon('trash-2', 14)}</button>` : ''}
        </div>`;
      });
    }
    html += `</div></div>`;

    // Quick logs of the day
    const dayLogs = State.getLogs({ date: dateStr })
      .filter(l => ['calorie', 'quick', 'checkin', 'emotion', 'wake', 'sleep'].includes(l.type))
      .sort((a, b) => logTimeOf(a).localeCompare(logTimeOf(b)));
    if (dayLogs.length > 0) {
      html += `<div class="section">
        <div class="section-header"><span class="section-title">Logs</span>
          <span class="text-xs text-faint">mood entries are editable</span>
        </div>
        <div class="card loglist">`;
      dayLogs.forEach(l => {
        const editable = l.type === 'emotion' || l.type === 'checkin';
        html += `<div class="log-row">
          <span class="lr-time">${logTimeOf(l)}</span>
          <span class="lr-desc">${describeLog(l)}</span>
          <span class="lr-actions">
            ${editable ? `<button class="icon-btn" onclick="App.editMoodLog('${l.id}')" aria-label="Edit">${icon('pencil', 13)}</button>` : ''}
            <button class="icon-btn" onclick="App.deleteHistoryLog('${l.id}')" aria-label="Delete">${icon('trash-2', 13)}</button>
          </span>
        </div>`;
      });
      html += `</div></div>`;
    }

    // Archive
    const archived = State.getEntries({ archived: true });
    html += `<div class="section" id="archiveSection">
      <div class="section-header"><span class="section-title">Archive</span>
        <span class="stat-label">${archived.length} items</span>
      </div>
      <div class="card">`;
    if (archived.length === 0) {
      html += `<p class="text-xs text-faint">Archived items live here, hidden from every other view. Archive from a task's actions.</p>`;
    } else {
      archived.forEach(e => {
        const proj = e.projectId ? State.getProject(e.projectId) : null;
        html += `<div class="done-row">
          <span class="proj-dot" style="background:${proj?.color || 'var(--text-faint)'}"></span>
          <span class="truncate" style="flex:1;${e.completed ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${escHtml(e.title)}</span>
          <span class="pill">${e.type}</span>
          <button class="icon-btn" onclick="App.unarchiveEntry('${e.id}')" aria-label="Restore" title="Restore">${icon('archive-restore', 15)}</button>
          <button class="icon-btn" onclick="App.deleteEntry('${e.id}')" aria-label="Delete forever" title="Delete forever">${icon('trash-2', 15)}</button>
        </div>`;
      });
    }
    html += `</div></div>`;

    return html;
  }

  function describeLog(l) {
    const moodIc = (e) => icon(MOOD_ICONS[e] || 'smile', 13);
    switch (l.type) {
      case 'calorie': {
        const macros = [l.protein ? `${l.protein}P` : '', l.carbs ? `${l.carbs}C` : '', l.fat ? `${l.fat}F` : ''].filter(Boolean).join('/');
        return `${escHtml(l.emoji || '🍽')} ${escHtml(l.notes || 'Food')}${l.value ? ` · ${l.value} cal` : ''} (${escHtml(l.meal || 'snack')})${macros ? ` · ${macros}` : ''}`;
      }
      case 'quick': return `${escHtml(l.emoji || '⭐')} ${escHtml(l.notes || 'Quick log')}`;
      case 'checkin':
        return `Check-in ${l.emotion ? moodIc(l.emotion) : ''}${l.energy ? ` energy ${l.energy}/5` : ''}${l.notes ? ` · ${escHtml(l.notes)}` : ''}`;
      case 'emotion': return `${moodIc(l.emotion)} Day mood: ${escHtml(l.emotion)}`;
      case 'wake': return `${icon('sunrise', 13)} Woke up`;
      case 'sleep': return `${icon('moon', 13)} Bedtime`;
      default: return escHtml(l.type);
    }
  }

  function historyNav(delta) {
    historyOffset = Math.min(0, historyOffset + delta);
    render();
  }

  function historyToday() { historyOffset = 0; render(); }

  // Jump straight to a specific past day (Year in Pixels cells land here)
  function openHistoryDay(dateStr) {
    const today = new Date(State.todayStr() + 'T00:00');
    const target = new Date(dateStr + 'T00:00');
    historyOffset = Math.min(0, Math.round((target - today) / 86400000));
    switchTab('history');
  }

  function viewArchive() {
    switchTab('history');
    setTimeout(() => document.getElementById('archiveSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }

  function deleteHistoryLog(id) {
    State.deleteLog(id);
    render();
  }

  // Edit a historic mood (day mood or check-in): emotion, energy, note
  let editingLogId = null;
  let editLogEmotion = null;
  let editLogEnergy = null;

  function editMoodLog(id) {
    const log = State.getLogs().find(l => l.id === id);
    if (!log) return;
    editingLogId = id;
    editLogEmotion = log.emotion || null;
    editLogEnergy = log.energy || null;
    const isCheckin = log.type === 'checkin';
    showModal(isCheckin ? 'Edit Check-in' : 'Edit Day Mood', `
      <div class="form-group">
        <label class="form-label">Mood — ${log.date}</label>
        <div class="emotion-selector" id="editEmotionSel">
          ${['bad', 'low', 'okay', 'good', 'great'].map(e => `
            <button class="emotion-btn ${editLogEmotion === e ? 'selected' : ''}" id="ee-${e}" onclick="App.setEditLogEmotion('${e}')">
              ${icon(MOOD_ICONS[e], 22)}
              <span class="emotion-label">${e}</span>
            </button>`).join('')}
        </div>
      </div>
      ${isCheckin ? `
        <div class="form-group">
          <label class="form-label">Energy</label>
          <div class="energy-selector" id="editEnergySel">
            ${[1, 2, 3, 4, 5].map(n => `<button class="energy-btn ${editLogEnergy != null && n <= editLogEnergy ? 'selected' : ''}" id="een-${n}" onclick="App.setEditLogEnergy(${n})" aria-label="Energy ${n}">⚡</button>`).join('')}
          </div>
        </div>` : ''}
      <div class="form-group">
        <label class="form-label">Note</label>
        <input type="text" class="form-input" id="editLogNote" value="${log.notes || ''}" placeholder="Optional note">
      </div>
    `, [
      `<button class="btn btn-danger" onclick="App.deleteHistoryLog('${id}');App.closeModal()">Delete</button>`,
      `<div style="flex:1"></div>`,
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveMoodLog()">Save</button>`,
    ]);
  }

  function setEditLogEmotion(e) {
    editLogEmotion = e;
    document.querySelectorAll('#editEmotionSel .emotion-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById(`ee-${e}`)?.classList.add('selected');
  }

  function setEditLogEnergy(n) {
    editLogEnergy = editLogEnergy === n ? null : n;
    document.querySelectorAll('#editEnergySel .energy-btn').forEach((b, i) => {
      b.classList.toggle('selected', editLogEnergy != null && i < editLogEnergy);
    });
  }

  function saveMoodLog() {
    if (!editingLogId) return;
    State.updateLog(editingLogId, {
      emotion: editLogEmotion,
      energy: editLogEnergy,
      notes: document.getElementById('editLogNote')?.value || '',
    });
    editingLogId = null;
    closeModal();
    render();
  }

  function renderHistoryCharts() {
    const container = document.getElementById('dayTimelineContainer');
    if (container) Charts.renderDayTimeline(container, offsetDateStr(historyOffset));
  }

  // ═══════════════════════════════════════════════════════════
  // SETTINGS VIEW
  // ═══════════════════════════════════════════════════════════
  // Settings was one long scroll of seven unrelated sections with the
  // destructive ones at the bottom, reachable by accident on the way past.
  // A filter narrows it to what you came for, and each section collapses.
  let settingsFilter = '';

  function setSettingsFilter(v) {
    settingsFilter = String(v || '').trim().toLowerCase();
    applySettingsFilter();
  }

  function applySettingsFilter() {
    const q = settingsFilter;
    let shown = 0;
    document.querySelectorAll('#mainContent .section[data-settings-section]').forEach(sec => {
      const hit = !q || sec.textContent.toLowerCase().includes(q);
      sec.style.display = hit ? '' : 'none';
      if (hit) shown++;
      // A search should show you the answer, not a folded section to open.
      if (q && hit) { const d = sec.querySelector('details'); if (d) d.open = true; }
    });
    const empty = document.getElementById('settingsEmpty');
    if (empty) empty.style.display = shown ? 'none' : '';
  }

  function renderSettings() {
    const settings = State.getSettings();
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Sync, preferences, data</p>
        </div>
      </div>
      <div class="settings-search">
        ${icon('search', 15)}
        <input type="search" class="settings-search-input" id="settingsFilter" placeholder="Find a setting…"
          value="${escHtml(settingsFilter)}" autocomplete="off" oninput="App.setSettingsFilter(this.value)">
      </div>
      <p class="text-xs text-faint" id="settingsEmpty" style="display:none;">Nothing matches that.</p>
    `;
    // The filter has to be re-applied after every render, or typing then
    // toggling a setting silently un-filters the page under you.
    setTimeout(applySettingsFilter, 0);

    // Appearance
    const curAccent = settings.accent || 'teal';
    html += `<div class="section" data-settings-section="appearance">
      <div class="section-header"><span class="section-title">Appearance</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Accent Color</div><div class="setting-desc">Recolors buttons, charts, heatmap — the whole app</div></div>
          <div class="accent-swatches">
            ${Object.entries(ACCENTS).map(([name, a]) => `
              <button class="color-swatch ${curAccent === name ? 'selected' : ''}" style="background:${a.accent};"
                title="${name}" aria-label="Accent: ${name}" onclick="App.setAccent('${name}')"></button>`).join('')}
          </div>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Theme</div><div class="setting-desc">Currently ${settings.theme} — also toggleable from the header</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.toggleTheme()">${icon('sun-moon', 14)}Switch to ${settings.theme === 'dark' ? 'light' : 'dark'}</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Celebrations</div><div class="setting-desc">Confetti on completions and streak milestones</div></div>
          <div class="toggle-switch ${settings.celebrations !== false ? 'on' : ''}" role="switch" aria-checked="${settings.celebrations !== false}"
            onclick="App.updateAppSetting('celebrations', ${settings.celebrations === false})" aria-label="Toggle celebrations"></div>
        </div>
      </div>
    </div>`;

    // Notifications
    const notifState = notificationStatus();
    const notifDesc = {
      granted: 'On — reminders pop up as system notifications',
      denied: 'Blocked in the browser — in-app toasts still fire',
      default: 'Reminders fire as in-app toasts; enable for system notifications',
      unsupported: 'Not supported in this browser — in-app toasts still fire',
    }[notifState];
    html += `<div class="section" data-settings-section="reminders">
      <div class="section-header"><span class="section-title">Reminders</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Notifications</div><div class="setting-desc">${notifDesc}</div></div>
          ${notifState === 'default' ? `<button class="btn btn-secondary btn-sm" onclick="App.enableNotifications()">${icon('bell', 14)}Enable</button>`
            : `<span class="pill ${notifState === 'granted' ? 'pill-green' : 'pill-gray'}">${notifState}</span>`}
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Scheduled Check-ins</div><div class="setting-desc">Prompt the Quick Log at set times, e.g. 09:00, 20:00. Handled once across all devices.</div></div>
          <input type="text" class="form-input" style="width:160px;" placeholder="09:00, 20:00"
            value="${settings.quickLogPromptTimes || ''}" onchange="App.updateAppSetting('quickLogPromptTimes', this.value)">
        </div>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);">Anything with a reminder time fires on its due day while the app is open — tasks and reminders alike. Undated reminders fire daily.</p>
      </div>
    </div>`;

    // Sync section
    html += `<div class="section" data-settings-section="firebase sync">
      <div class="section-header"><span class="section-title">Firebase Sync</span></div>
      <div class="card">
        <div class="setting-row">
          <div>
            <div class="setting-label">Connection Status</div>
            <div class="setting-desc">${settings.sync.connected ? 'Connected' : 'Not connected'}</div>
          </div>
          <span class="pill ${settings.sync.connected ? 'pill-green' : 'pill-gray'}">${settings.sync.connected ? 'Online' : 'Offline'}</span>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Database URL</div>
            <div class="setting-desc">${settings.sync.databaseUrl ? '••••configured' : 'Not set'}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.openSyncConfig()">${icon('cloud', 14)}Configure</button>
        </div>
      </div>
    </div>`;

    // Timer settings
    html += `<div class="section" data-settings-section="timer defaults">
      <div class="section-header"><span class="section-title">Timer Defaults</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Focus Duration</div><div class="setting-desc">Pomodoro work minutes</div></div>
          <input type="number" class="form-input" style="width:80px;" value="${settings.timer.pomodoroWork}" onchange="App.updateTimerSetting('pomodoroWork', this.value)">
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Short Break</div><div class="setting-desc">Break minutes</div></div>
          <input type="number" class="form-input" style="width:80px;" value="${settings.timer.pomodoroBreak}" onchange="App.updateTimerSetting('pomodoroBreak', this.value)">
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Long Break</div><div class="setting-desc">Long break minutes</div></div>
          <input type="number" class="form-input" style="width:80px;" value="${settings.timer.pomodoroLongBreak}" onchange="App.updateTimerSetting('pomodoroLongBreak', this.value)">
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Auto-start</div><div class="setting-desc">Auto-start next phase</div></div>
          <div class="toggle-switch ${settings.timer.autoStart ? 'on' : ''}" onclick="App.updateTimerSetting('autoStart', !${settings.timer.autoStart})"></div>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Nav Bar Timers</div><div class="setting-desc">Max live timers shown in the header (rest collapse to …)</div></div>
          <input type="number" class="form-input" style="width:80px;" min="1" max="6" value="${settings.maxNavTimers || 2}" onchange="App.updateMaxNavTimers(this.value)">
        </div>
      </div>
    </div>`;

    // Health + quick log
    html += `<div class="section" data-settings-section="health & quick log">
      <div class="section-header"><span class="section-title">Health & Quick Log</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Daily Calorie Goal</div><div class="setting-desc">Target calories per day</div></div>
          <input type="number" class="form-input" style="width:80px;" value="${settings.calorieGoal}" onchange="App.updateCalorieGoal(this.value)">
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Quick Log Shortcuts</div><div class="setting-desc">${(settings.quickShortcuts || []).length} configured — coffee, water, saved meals…</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.openManageShortcuts()">${icon('zap', 14)}Manage</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Tags</div><div class="setting-desc">${State.getAllTags().length} tags — rename, recolor, scope to a project, delete</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.openManageTags()">${icon('tag', 14)}Manage</button>
        </div>
      </div>
    </div>`;

    // Hotkeys (single keys, active when not typing in a field)
    const hotkeyRows = [
      ['timer', 'Toggle timer window'],
      ['newTask', 'New task'],
      ['quickLog', 'Open Quick Log'],
      ['search', 'Search'],
      ['stopTimers', 'Stop all timers'],
    ];
    html += `<div class="section" data-settings-section="hotkeys">
      <div class="section-header"><span class="section-title">Hotkeys</span>
        <span class="text-xs text-faint">single keys · never fire while typing</span>
      </div>
      <div class="card">
        ${hotkeyRows.map(([key, label]) => `
          <div class="setting-row">
            <div><div class="setting-label">${label}</div></div>
            <input type="text" class="form-input hotkey-input" maxlength="1" value="${settings.hotkeys?.[key] || ''}"
              onchange="App.setHotkey('${key}', this.value)" placeholder="—" aria-label="Hotkey for ${label}">
          </div>`).join('')}
        <p class="text-xs text-faint" style="margin-top:var(--space-2);">Cmd/Ctrl+N (new task) and Cmd/Ctrl+K (command palette) also work everywhere.</p>
      </div>
    </div>`;

    // Data management
    html += `<div class="section" data-settings-section="data">
      <div class="section-header"><span class="section-title">Data</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Refresh App</div><div class="setting-desc">Clear cached files + service worker and reload to pick up the latest version. Your data is untouched.</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.hardRefresh()">${icon('refresh-cw', 14)}Hard Refresh</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Export Data</div><div class="setting-desc">Download all data as JSON</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.exportData()">${icon('download', 14)}Export</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Import Data</div><div class="setting-desc">Restore from JSON backup</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.importData()">${icon('upload', 14)}Import</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Archive</div><div class="setting-desc">${State.getEntries({ archived: true }).length} archived items — view, restore, or delete</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.viewArchive()">${icon('archive', 14)}View</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Trash</div><div class="setting-desc">${State.getTrash().length} deleted item${State.getTrash().length === 1 ? '' : 's'} — restorable for ${State.TRASH_DAYS} days</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.openTrash()">${icon('trash-2', 14)}Open</button>
        </div>
      </div>
    </div>`;

    // Destructive actions, behind a disclosure of their own. Reset used to sit
    // at the bottom of the same card as Export, one row below a button people
    // press regularly, reachable by accident on the way past.
    html += `<div class="section" data-settings-section="danger reset erase delete everything">
      <details class="danger-zone">
        <summary>${icon('alert-triangle', 14)}Things you cannot undo</summary>
        <div class="card" style="margin-top:var(--space-2);">
          <div class="setting-row">
            <div><div class="setting-label" style="color:var(--error)">Reset all data</div>
              <div class="setting-desc">Deletes every project, task, log and planner block on this device.
                Export a backup first — this one is not in the trash and not undoable.</div></div>
            <button class="btn btn-danger btn-sm" onclick="App.confirmReset()">${icon('trash-2', 14)}Reset</button>
          </div>
        </div>
      </details>
    </div>`;

    // About
    html += `<div class="section">
      <div class="card" style="text-align:center;">
        <div class="menubar-logo" style="justify-content:center;margin-bottom:var(--space-2);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span>Cade.project</span>
        </div>
        <p class="text-xs text-muted">Local-first habit, goal & task tracker</p>
        <p class="text-xs text-faint mt-2">Encrypted Firebase sync · Offline-capable</p>
      </div>
    </div>`;

    return html;
  }

  // ═══════════════════════════════════════════════════════════
  // CREATE/EDIT ENTRY MODAL
  // ═══════════════════════════════════════════════════════════
  function openNewEntry(type = 'task') {
    editingEntryId = null;
    entryTypeDraft = type;
    currentTags = [];
    currentEffort = 'medium';
    currentWeekdays = [];
    // Creating from inside a project folder → that project is the default
    const focus = focusedProjectId();
    const contextProject = (focus && focus !== 'none') ? focus : null;
    currentProjects = contextProject ? withAncestors(contextProject) : [];
    showModal('New Entry', renderEntryForm(type, contextProject ? { projectId: contextProject } : {}), [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveEntry()">Create</button>`,
    ]);
  }

  function editEntry(id) {
    const entry = State.getEntry(id);
    if (!entry) return;
    editingEntryId = id;
    entryTypeDraft = entry.type;
    currentTags = [...(entry.tags || [])];
    currentEffort = entry.effort || 'medium';
    currentWeekdays = [...(entry.recurrence?.daysOfWeek || [])];
    currentProjects = [...State.entryProjectIds(entry)];
    showModal('Edit Entry', renderEntryForm(entry.type, entry), [
      `<button class="btn btn-danger" onclick="App.deleteEntry('${id}')">Delete</button>`,
      `<div style="flex:1"></div>`,
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveEntry()">Save</button>`,
    ]);
  }

  // Each entry type gets its own form — a reminder needs a time, a habit
  // needs recurrence, and none of them need task-style effort/estimate.
  function renderEntryForm(type, entry = {}) {
    const projects = State.getProjects();
    const tags = State.getAllTags(); // full list, for pill colors
    // Suggestions respect tag scoping: global + the primary project's tags
    const suggestTags = State.getAllTags(currentProjects[0] || null);

    // 'checkin' retired from the picker — day check-ins live in Quick Log;
    // legacy checkin entries still render everywhere else.
    const typeIcons = { goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock' };
    const types = ['goal', 'task', 'habit', 'reminder'];
    const placeholders = {
      task: 'What needs to be done?', goal: 'What are you aiming for?',
      habit: 'What do you want to repeat?', reminder: 'What should I remind you of?',
    };

    // Color-coded multi-select project chips (an entry can live in several).
    // Past 8 projects the list scrolls and gains a type-to-filter box.
    const manyProjects = projects.length > 8;
    const projectChips = `
      <div class="form-group">
        <label class="form-label">Projects ${currentProjects.length > 1 ? `<span class="text-faint">(${currentProjects.length} selected)</span>` : ''}</label>
        ${manyProjects ? `<input type="text" class="form-input" placeholder="Filter projects…" style="margin-bottom:var(--space-2);" oninput="App.filterChips(this,'entryProjectChips')">` : ''}
        <div class="project-chips ${manyProjects ? 'chip-scroll' : ''}" id="entryProjectChips">
          ${projects.length === 0 ? '<span class="text-xs text-faint">No projects yet.</span>' : projects.map(p => `
            <button class="filter-chip project-choice ${currentProjects.includes(p.id) ? 'active' : ''}" id="pc-${p.id}"
              data-filter-text="${p.name.toLowerCase()}"
              style="--chip-color:${p.color};${p.depth ? `margin-left:${p.depth * 10}px;` : ''}"
              onclick="App.toggleFormProject('${p.id}')">
              <span class="proj-dot" style="background:${p.color}"></span>${escHtml(p.name)}
            </button>`).join('')}
        </div>
      </div>`;

    let typeFields = '';
    if (type === 'task') {
      typeFields = `
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Due Date</label>
            <input type="date" class="form-input" id="entryDueDate" value="${entry.dueDate || ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Estimate (minutes)</label>
            <input type="number" class="form-input" id="entryEstimate" value="${entry.estimateMinutes || ''}" placeholder="e.g. 45" min="0" step="5">
          </div>
        </div>
        ${entry.completed ? `
        <div class="form-group">
          <label class="form-label">Actual time (minutes)</label>
          <input type="number" class="form-input" id="entryActual" value="${entry.actualMinutes ?? ''}" placeholder="${State.actualMinutesFor(entry) ? `tracked: ${State.actualMinutesFor(entry)}` : 'override tracked time'}" min="0" step="5">
          <p class="text-xs text-faint" style="margin-top:var(--space-1);">Leave blank to use tracked time. Feeds the estimate-accuracy stats.</p>
        </div>` : ''}
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Effort</label>
            <div class="effort-selector">
              ${['trivial', 'small', 'medium', 'large', 'xl'].map(e => `
                <button class="effort-btn ${(entry.effort || 'medium') === e ? 'selected' : ''}" onclick="App.selectEffort('${e}')" id="effort-${e}">${effortLabel(e)}</button>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" id="entryPriority">
              ${['low', 'medium', 'high', 'urgent'].map(p => `
                <option value="${p}" ${(entry.priority || 'medium') === p ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>
              `).join('')}
            </select>
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Repeat</label>
            <select class="form-select" id="entryRepeat">
              ${[['none', 'Never'], ['daily', 'Daily'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, l]) => `
                <option value="${v}" ${(entry.recurrence?.type || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Reminder Time</label>
            <input type="time" class="form-input" id="entryRemindTime" value="${entry.remindTime || ''}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Blocked By <span class="text-faint">(waits for another task)</span></label>
          <select class="form-select" id="entryBlockedBy">
            <option value="">Nothing — ready to work on</option>
            ${State.getEntries({ type: 'task', completed: false })
              .filter(t => t.id !== entry.id && !(t.blockedBy || []).includes(entry.id))
              .map(t => `<option value="${t.id}" ${(entry.blockedBy || [])[0] === t.id ? 'selected' : ''}>${escHtml(t.title)}</option>`).join('')}
          </select>
        </div>`;
    } else if (type === 'goal') {
      typeFields = `
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Target Value</label>
            <input type="number" class="form-input" id="entryTarget" value="${entry.targetValue || ''}" placeholder="e.g. 12">
          </div>
          <div class="form-group">
            <label class="form-label">Current Value</label>
            <input type="number" class="form-input" id="entryCurrent" value="${entry.currentValue || ''}" placeholder="e.g. 5">
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Unit</label>
            <input type="text" class="form-input" id="entryUnit" value="${entry.unit || ''}" placeholder="books, km, hours...">
          </div>
          <div class="form-group">
            <label class="form-label">Target Date</label>
            <input type="date" class="form-input" id="entryDueDate" value="${entry.dueDate || ''}">
          </div>
        </div>`;
    } else if (type === 'habit') {
      typeFields = `
        <div class="form-group">
          <label class="form-label">Recurrence</label>
          <select class="form-select" id="entryRecurrence" onchange="App.onRecurrenceChange(this.value)">
            <option value="daily" ${entry.recurrence?.type === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${entry.recurrence?.type === 'weekly' ? 'selected' : ''}>Specific days of the week</option>
            <option value="monthly" ${entry.recurrence?.type === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="none" ${!entry.recurrence ? 'selected' : ''}>None</option>
          </select>
        </div>
        <div class="form-group" id="weekdayRow" style="display:${entry.recurrence?.type === 'weekly' ? 'block' : 'none'};">
          <label class="form-label">On these days</label>
          <div class="weekday-selector">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `
              <button class="weekday-btn ${currentWeekdays.includes(i) ? 'selected' : ''}" id="wd-${i}" onclick="App.toggleWeekday(${i})">${d}</button>
            `).join('')}
          </div>
          <p class="text-xs text-faint" style="margin-top:var(--space-2);">Other days don't count against the streak — they show dimmed in the grid.</p>
        </div>`;
    } else if (type === 'reminder') {
      typeFields = `
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Date</label>
            <input type="date" class="form-input" id="entryDueDate" value="${entry.dueDate || ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Time</label>
            <input type="time" class="form-input" id="entryRemindTime" value="${entry.remindTime || ''}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Repeats</label>
          <select class="form-select" id="entryRecurrence">
            <option value="none" ${!entry.recurrence ? 'selected' : ''}>Never</option>
            <option value="daily" ${entry.recurrence?.type === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${entry.recurrence?.type === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="monthly" ${entry.recurrence?.type === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select>
        </div>`;
    }
    // checkin: just title/description/projects/tags — nothing extra

    return `
      <div class="form-group">
        <label class="form-label">Entry Type</label>
        <div class="type-selector">
          ${types.map(t => `
            <div class="type-card ${t === type ? 'selected' : ''}" onclick="App.changeEntryType('${t}')">
              <i data-lucide="${typeIcons[t]}"></i>
              <span>${t}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Title</label>
        <textarea class="form-input input-grow" id="entryTitle" rows="1" placeholder="${placeholders[type]}" autocomplete="off"
          oninput="App.autoGrow(this)"
          onkeydown="if(event.key==='Enter'){event.preventDefault();App.saveEntry();}">${escHtml(entry.title || '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-textarea" id="entryDescription" placeholder="Add details...">${escHtml(entry.description || '')}</textarea>
      </div>

      ${projectChips}

      ${typeFields}

      <div class="form-group">
        <label class="form-label">Tags</label>
        <div id="entryTagsBlock">${renderTagsSection()}</div>
      </div>
    `;
  }

  // Rendered separately so adding/removing a tag refreshes ONLY this block —
  // re-rendering the whole form wiped everything the user had typed.
  function renderTagsSection() {
    const tags = State.getAllTags();
    const suggestTags = State.getAllTags(currentProjects[0] || null)
      .filter(t => !currentTags.includes(t.name));
    const many = suggestTags.length > 10;
    return `
      <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-2);">
        ${currentTags.map((t, i) => {
          const tagObj = tags.find(tg => tg.name === t);
          const colorCls = tagObj ? `pill-${tagObj.color}` : 'pill-gray';
          // Position, not the tag text, goes into the handler. A name
          // interpolated into onclick="…('NAME')" is a JS string literal a
          // quote can break out of — HTML-escaping alone does not close that.
          return `<span class="pill ${colorCls}">#${escHtml(t)}<button onclick="App.removeTagAt(${i})" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;">×</button></span>`;
        }).join('')}
      </div>
      <input type="text" class="form-input" id="entryTagInput" placeholder="Type a tag and press Enter" onkeydown="if(event.key==='Enter'){event.preventDefault();App.addTag(this.value);this.value='';}">
      ${suggestTags.length > 0 ? `<div class="${many ? 'chip-scroll' : ''}" style="display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:var(--space-2);">
        ${suggestTags.map(t => `<button class="pill pill-${t.color}" style="cursor:pointer;" onclick="App.addTagById('${t.id}')">#${escHtml(t.name)}</button>`).join('')}
      </div>` : ''}
    `;
  }

  let currentTags = [];
  let currentEffort = 'medium';
  let currentWeekdays = [];
  let currentProjects = [];

  function toggleFormProject(id) {
    if (currentProjects.includes(id)) {
      currentProjects = currentProjects.filter(p => p !== id);
    } else {
      currentProjects = [...currentProjects, id];
      // a sub-project implies its ancestors — pull the chain in with it
      withAncestors(id).forEach(pid => {
        if (!currentProjects.includes(pid)) currentProjects.push(pid);
      });
    }
    // ancestors may have just toggled on — sync every chip, not one
    document.querySelectorAll('.project-choice').forEach(el => {
      el.classList.toggle('active', currentProjects.includes(el.id.replace('pc-', '')));
    });
  }

  // Generic type-to-filter for chip lists that outgrow the space
  function filterChips(inputEl, containerId) {
    const q = (inputEl.value || '').trim().toLowerCase();
    document.querySelectorAll(`#${containerId} [data-filter-text]`).forEach(el => {
      el.style.display = !q || el.dataset.filterText.includes(q) ? '' : 'none';
    });
  }

  function onRecurrenceChange(value) {
    const row = document.getElementById('weekdayRow');
    if (row) row.style.display = value === 'weekly' ? 'block' : 'none';
  }

  function toggleWeekday(i) {
    currentWeekdays = currentWeekdays.includes(i)
      ? currentWeekdays.filter(d => d !== i)
      : [...currentWeekdays, i].sort();
    document.getElementById(`wd-${i}`)?.classList.toggle('selected', currentWeekdays.includes(i));
  }

  function changeEntryType(type) {
    saveFormData();
    // Carry typed values across the type switch — don't wipe the user's work
    const draft = {
      title: document.getElementById('entryTitle')?.value ?? '',
      description: document.getElementById('entryDescription')?.value ?? '',
      dueDate: document.getElementById('entryDueDate')?.value || null,
    };
    entryTypeDraft = type;
    const body = document.getElementById('modalBody');
    const entry = { ...(editingEntryId ? State.getEntry(editingEntryId) : {}), ...draft };
    entry.tags = [...currentTags];
    entry.effort = currentEffort;
    body.innerHTML = renderEntryForm(type, entry);
    refreshIcons();
    autoGrow(document.getElementById('entryTitle'));
  }

  function saveFormData() {
    const titleEl = document.getElementById('entryTitle');
    if (titleEl) {
      const effortSelected = document.querySelector('.effort-btn.selected');
      if (effortSelected) currentEffort = effortSelected.id.replace('effort-', '');
    }
  }

  function selectEffort(effort) {
    currentEffort = effort;
    document.querySelectorAll('.effort-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById(`effort-${effort}`)?.classList.add('selected');
  }

  function addTag(tagName) {
    if (!tagName.trim()) return;
    const tag = State.getOrCreateTag(tagName.trim());
    if (!currentTags.includes(tag.name)) currentTags.push(tag.name);
    refreshTagDisplay();
  }

  function removeTag(tagName) {
    currentTags = currentTags.filter(t => t !== tagName);
    refreshTagDisplay();
  }

  // Index- and id-based entry points, so no tag text ever has to survive a
  // trip through an inline event-handler attribute.
  function removeTagAt(i) {
    currentTags = currentTags.filter((_, idx) => idx !== i);
    refreshTagDisplay();
  }

  function addTagById(id) {
    const tag = State.getAllTags().find(t => t.id === id);
    if (tag) addTag(tag.name);
  }

  // Touch ONLY the tags block — everything else the user typed stays put
  function refreshTagDisplay() {
    const block = document.getElementById('entryTagsBlock');
    if (block) { block.innerHTML = renderTagsSection(); refreshIcons(); }
  }

  function saveEntry() {
    // titles are one logical line — pasted newlines collapse to spaces
    const title = document.getElementById('entryTitle')?.value?.replace(/\s*\n+\s*/g, ' ').trim();
    if (!title) { toast('Title is required'); return; }

    const data = {
      type: entryTypeDraft,
      title,
      description: document.getElementById('entryDescription')?.value || '',
      projectIds: [...currentProjects],
      projectId: currentProjects[0] || null, // primary — legacy readers
      tags: [...currentTags],
    };

    if (entryTypeDraft === 'task') {
      data.dueDate = document.getElementById('entryDueDate')?.value || null;
      data.effort = currentEffort;
      data.priority = document.getElementById('entryPriority')?.value || 'medium';
      data.estimateMinutes = parseInt(document.getElementById('entryEstimate')?.value) || null;
      data.remindTime = document.getElementById('entryRemindTime')?.value || null;
      const rep = document.getElementById('entryRepeat')?.value;
      data.recurrence = rep && rep !== 'none' ? { type: rep, interval: 1 } : null;
      const blocker = document.getElementById('entryBlockedBy')?.value;
      data.blockedBy = blocker ? [blocker] : [];
      // Only present when editing a completed task — don't clobber otherwise
      const actEl = document.getElementById('entryActual');
      if (actEl) data.actualMinutes = parseInt(actEl.value) || null;
    }

    if (entryTypeDraft === 'goal') {
      data.targetValue = parseFloat(document.getElementById('entryTarget')?.value) || null;
      data.currentValue = parseFloat(document.getElementById('entryCurrent')?.value) || 0;
      data.unit = document.getElementById('entryUnit')?.value || null;
      data.dueDate = document.getElementById('entryDueDate')?.value || null;
    }

    if (entryTypeDraft === 'habit') {
      const recType = document.getElementById('entryRecurrence')?.value;
      data.recurrence = recType && recType !== 'none' ? { type: recType, interval: 1 } : null;
      if (data.recurrence && recType === 'weekly') {
        // Empty selection means "any day" — same as daily for scheduling
        data.recurrence.daysOfWeek = currentWeekdays.length > 0 ? [...currentWeekdays] : null;
      }
    }

    if (entryTypeDraft === 'reminder') {
      data.dueDate = document.getElementById('entryDueDate')?.value || null;
      data.remindTime = document.getElementById('entryRemindTime')?.value || null;
      const recType = document.getElementById('entryRecurrence')?.value;
      data.recurrence = recType && recType !== 'none' ? { type: recType, interval: 1 } : null;
    }

    // Tasks that mirror a Cade.txt checkbox keep the document in step: a
    // rename rewrites the line, a new task in a linked room is appended to
    // its list. Both are fire-and-forget — the local write already landed.
    const bridged = typeof Bridge !== 'undefined';
    if (editingEntryId) {
      const before = State.getEntry(editingEntryId);
      const renamed = before && before.txtRoom && data.title && data.title !== before.title;
      const notesChanged = before && before.txtRoom &&
        (data.description || '').trim() !== (before.description || '').trim();
      const oldKey = before?.txtKey;
      State.updateEntry(editingEntryId, data);
      toast('Entry updated');
      const updated = State.getEntry(editingEntryId);
      if (bridged && renamed) Bridge.pushRename(updated, oldKey).catch(() => {});
      // Notes on a bridged task are the indented lines under its checkbox,
      // so editing them here rewrites them over there. A rename re-keys the
      // link first, hence the sequencing.
      if (bridged && notesChanged) {
        const push = () => Bridge.pushNotes(State.getEntry(editingEntryId)).catch(() => {});
        if (renamed) setTimeout(push, 400); else push();
      }
      // Moving an existing task INTO a linked sub-project has to add the
      // checkbox there. Nothing else would: scans match on a link this task
      // does not have yet, so without this it stays invisible in Cade.txt.
      else if (bridged && updated && updated.type === 'task' && !updated.txtRoom) {
        Bridge.pushNewTask(updated).catch(() => {});
      }
    } else {
      const created = State.createEntry(data);
      toast('Entry created');
      if (bridged && created.type === 'task') Bridge.pushNewTask(created).catch(() => {});
    }

    currentTags = [];
    currentEffort = 'medium';
    currentProjects = [];
    closeModal();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // PROJECT MODAL — create AND manage (rename, color, icon,
  // parent/nesting, archive, delete)
  // ═══════════════════════════════════════════════════════════
  let selectedColor = null;
  let selectedIcon = null;
  let editingProjectId = null;

  function projectLabel(p) {
    return `${'– '.repeat(p.depth || 0)}${escHtml(p.name)}`;
  }

  // A modal opened FROM another one records how to get back. Editing three
  // projects used to mean opening Manage Projects three times, because every
  // save, archive, delete and Cancel dropped you out to the page instead of
  // to the list you started from.
  // Named rather than a function reference: this travels through an onclick
  // attribute, where only strings survive.
  const MODAL_RETURNS = { manage: () => openManageProjects() };
  let modalReturn = null;

  function dismissModal() {
    const back = modalReturn;
    modalReturn = null;
    closeModal();
    const reopen = MODAL_RETURNS[back];
    if (reopen) reopen();
  }

  function openProjectModal(id = null, opts = {}) {
    modalReturn = opts.backTo || null;
    editingProjectId = id;
    const proj = id ? State.getProject(id) : null;
    // Reset selection state on EVERY open — stale values from a previous
    // visit made the highlighted swatch and the saved color disagree.
    selectedColor = proj?.color || State.PROJECT_COLORS[0];
    selectedIcon = proj?.icon || State.PROJECT_ICONS[0];
    const parentOptions = State.getProjects().filter(p =>
      p.id !== id && !State.wouldCycleProject(id, p.id));

    showModal(id ? 'Edit Project' : 'New Project', `
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" class="form-input" id="projectName" value="${proj?.name || ''}" placeholder="e.g. Work, Home, Health" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div class="color-grid" id="projectColorGrid">
          ${State.PROJECT_COLORS.map(c => `<div class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="App.selectColor(this)"></div>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Icon</label>
        <div class="icon-grid" id="projectIconGrid">
          ${State.PROJECT_ICONS.map(ic => `<div class="icon-option ${ic === selectedIcon ? 'selected' : ''}" data-icon="${ic}" onclick="App.selectIcon(this)"><i data-lucide="${ic}"></i></div>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Nest under (parent project)</label>
        <select class="form-select" id="projectParent">
          <option value="">None — top level</option>
          ${parentOptions.map(p => `<option value="${p.id}" ${proj?.parentId === p.id ? 'selected' : ''}>${projectLabel(p)}</option>`).join('')}
        </select>
      </div>
    `, [
      id ? `<button class="btn btn-danger" onclick="App.deleteProjectAction('${id}')">Delete</button>
            <button class="btn btn-secondary" onclick="App.archiveProjectAction('${id}')">${icon('archive', 14)}Archive</button>
            <div style="flex:1"></div>` : '',
      `<button class="btn btn-secondary" onclick="App.dismissModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveProject()">${id ? 'Save' : 'Create'}</button>`,
    ]);
  }

  // Back-compat entry point
  function openNewProject() { openProjectModal(null); }

  function selectColor(el) {
    document.querySelectorAll('#projectColorGrid .color-swatch').forEach(s => s.classList.remove('selected'));
    el.classList.add('selected');
    selectedColor = el.dataset.color;
  }

  function selectIcon(el) {
    document.querySelectorAll('#projectIconGrid .icon-option').forEach(s => s.classList.remove('selected'));
    el.classList.add('selected');
    selectedIcon = el.dataset.icon;
  }

  function saveProject() {
    const name = document.getElementById('projectName')?.value?.trim();
    if (!name) { toast('Name is required'); return; }
    // Duplicate names cause endless confusion in filters and selects
    const dupe = State.getProjects({ includeArchived: true })
      .some(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== editingProjectId);
    if (dupe) { toast('A project with this name already exists'); return; }
    const parentId = document.getElementById('projectParent')?.value || null;
    const payload = { name, color: selectedColor, icon: selectedIcon, parentId };
    const linkOn = typeof Bridge !== 'undefined' && Bridge.available();

    if (editingProjectId) {
      const before = State.getProject(editingProjectId);
      State.updateProject(editingProjectId, payload);
      toast('Project updated');
      // Workspaces are shared, so a rename here is a rename over there.
      if (linkOn && before?.txtWorkspaceId && before.name !== name) {
        Bridge.renameWorkspace(before.txtWorkspaceId, name).catch(() => {});
      }
    } else {
      const created = State.createProject(payload);
      toast('Project created');
      // A new top-level project is a new Cade.txt workspace — the link runs
      // both ways, so its rooms can be filed from either app.
      if (linkOn && !parentId) {
        Bridge.ensureWorkspace(name, 'teal')
          .then(wsId => { if (wsId) { State.updateProject(created.id, { txtWorkspaceId: wsId }); render(); } })
          .catch(() => {});
      }
    }
    editingProjectId = null;
    render();
    dismissModal();
  }

  // Archiving takes the sub-projects and their tasks with it, and quietens
  // the linked Cade.txt rooms, so the whole thing goes away in both apps
  // rather than leaving the children behind as loose top-level projects.
  // What a subtree contains, counted before the archive so the summary
  // describes what was actually taken.
  function subtreeFacts(id) {
    const ids = new Set(State.getProjectSubtreeIds(id));
    const projects = State.getProjects({ includeArchived: true }).filter(p => ids.has(p.id));
    return {
      ids,
      rooms: projects.filter(p => p.txtRoom).map(p => p.txtRoom),
      subprojects: projects.length - 1,
      openTasks: State.getEntries({ includeArchived: true }).filter(e =>
        !e.archived && State.entryProjectIds(e).some(pid => ids.has(pid))).length,
    };
  }

  function archiveProjectAction(id) {
    const { rooms, subprojects: subtree, openTasks: tasks } = subtreeFacts(id);
    const proj = State.getProject(id);
    State.checkpoint(`Archived “${proj ? proj.name : 'project'}”`);
    State.archiveProject(id);
    if (rooms.length && typeof Bridge !== 'undefined') Bridge.archiveRooms(rooms, true).catch(() => {});
    dropNavIfGone(id);
    toast(`Archived${subtree ? `, with ${subtree} sub-project${subtree > 1 ? 's' : ''}` : ''}${tasks ? ` and ${tasks} task${tasks > 1 ? 's' : ''}` : ''}`, { undo: true });
    render();
    dismissModal();
  }

  function unarchiveProjectAction(id) {
    const { rooms } = subtreeFacts(id);
    State.unarchiveProject(id);
    if (rooms.length && typeof Bridge !== 'undefined') Bridge.archiveRooms(rooms, false).catch(() => {});
    render();
    openManageProjects();
  }

  function deleteProjectAction(id) {
    const proj = State.getProject(id) ||
      State.getProjects({ includeArchived: true }).find(p => p.id === id);
    const count = State.getEntries({ includeArchived: true }).filter(e => e.projectId === id).length;
    undoable(`Deleted “${proj ? proj.name : 'project'}”${count ? ` — ${count} entr${count === 1 ? 'y' : 'ies'} unassigned` : ''}`,
      () => { State.deleteProject(id); dropNavIfGone(id); });
    render();
    dismissModal();
  }

  // Settings-side list: archived projects live here for restore
  function openManageProjects() {
    modalReturn = null;                 // this list IS the destination
    const active = State.getProjects();
    const archived = State.getProjects({ includeArchived: true }).filter(p => p.archived);
    showModal('Manage Projects', `
      <div style="display:flex;flex-direction:column;gap:var(--space-2);" data-reorder-list="project">
        ${active.length === 0 ? '<p class="text-xs text-faint">No projects yet.</p>' : active.map(p => `
          <div class="chain-link" data-reorder-id="${p.id}" draggable="true"
            ondragstart="App.reorderStart(event,'${p.id}','project')" ondragend="App.reorderEnd(event)"
            ondragover="App.reorderOver(event,'project')" ondragleave="App.reorderLeave(event)"
            ondrop="App.reorderDrop(event,'${p.id}','project')"
            style="justify-content:space-between;cursor:pointer;${p.depth ? `margin-left:${p.depth * 18}px;` : ''}" onclick="App.openProjectModal('${p.id}', { backTo: 'manage' })">
            <span style="display:inline-flex;align-items:center;gap:var(--space-2);">
              ${p.depth ? `<span class="text-faint" style="font-family:var(--font-mono);">└</span>` : ''}
              <span class="proj-dot" style="background:${p.color}"></span>${escHtml(p.name)}
            </span>
            <span class="text-xs text-faint">edit ›</span>
          </div>`).join('')}
      </div>
      ${archived.length > 0 ? `
        <div class="divider"></div>
        <label class="form-label">Archived</label>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${archived.map(p => `
            <div class="chain-link" style="justify-content:space-between;opacity:0.7;">
              <span style="display:inline-flex;align-items:center;gap:var(--space-2);">
                <span class="proj-dot" style="background:${p.color}"></span>${escHtml(p.name)}
              </span>
              <span>
                <button class="icon-btn" onclick="App.unarchiveProjectAction('${p.id}')" aria-label="Restore" title="Restore">${icon('archive-restore', 15)}</button>
                <button class="icon-btn" onclick="App.deleteProjectAction('${p.id}')" aria-label="Delete" title="Delete">${icon('trash-2', 15)}</button>
              </span>
            </div>`).join('')}
        </div>` : ''}
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Done</button>`,
      `<button class="btn btn-primary" onclick="App.openProjectModal(null, { backTo: 'manage' })">${icon('plus', 14)}New Project</button>`,
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  // SYNC CONFIG MODAL
  // ═══════════════════════════════════════════════════════════
  function openSyncConfig() {
    // The sync dot is where a deferred conflict lives — it is showing the
    // conflict colour, so tapping it has to bring the question back rather
    // than open settings over the top of it.
    if (pendingConflict) {
      const [l, s] = pendingConflict;
      setPendingConflict(null);
      showConflictModal(l, s);
      return;
    }
    const settings = State.getSettings();
    const configured = !!(settings.sync.databaseUrl && settings.sync.passphrase);
    const live = typeof Sync !== 'undefined' && Sync.isConnected();
    const status = !configured ? { cls: 'offline', text: 'Not set up yet' }
      : settings.sync.paused ? { cls: 'offline', text: 'Paused after a local reset' }
      : live ? { cls: 'online', text: 'Connected' }
      : { cls: 'offline', text: 'Not connected right now' };

    showModal('Firebase Sync', `
      ${configured ? `<div class="sync-state">
        <span class="sync-dot ${status.cls}" style="cursor:default"></span>
        <span class="sync-state-text">${escHtml(status.text)}</span>
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Database URL</label>
        <input type="text" class="form-input" id="syncUrl" value="${escHtml(settings.sync.databaseUrl || '')}" placeholder="https://your-project.firebaseio.com">
      </div>
      <div class="form-group">
        <label class="form-label">Passphrase (Encryption Key)</label>
        <input type="password" class="form-input" id="syncPass" value="${escHtml(settings.sync.passphrase || '')}" placeholder="Your secret passphrase">
      </div>
      <div class="form-group">
        <p class="text-xs text-muted" style="line-height:1.6;">
          Your passphrase is used to derive an AES-256-GCM key locally via PBKDF2.
          Data is encrypted before it ever touches the network. The passphrase is never sent to the server.
          Multiple devices sharing the same passphrase will automatically sync.
        </p>
      </div>
      ${configured ? `
        <div class="divider"></div>
        <label class="form-label">Connection</label>
        <div class="sync-action-grid">
          <button class="btn btn-secondary" onclick="App.reconnectSync()"
            title="Drop the connection and re-reconcile against the server">${icon('refresh-cw', 14)}Reconnect</button>
          <button class="btn btn-secondary" onclick="App.hardRefresh()"
            title="Re-download the app and clear its caches, then reload">${icon('download-cloud', 14)}Force Reload</button>
        </div>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);line-height:1.6;">
          Reconnect re-reads the server and reconciles. Force Reload clears this
          app's cached files and fetches them again — use it when a fix has
          shipped but the old version is still running.
        </p>
        ${syncActivityHtml()}` : ''}
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      settings.sync.connected ? `<button class="btn btn-danger" onclick="App.disconnectSync()">Disconnect</button>` : '',
      `<button class="btn btn-primary" onclick="App.connectSync()">${configured ? 'Save & Connect' : 'Connect'}</button>`,
    ]);
  }

  // What this tab has seen sync do. Not stored and not synced — it is a record
  // of this session, which is what you want when something has just gone
  // wrong and the console has already scrolled past it.
  const SYNC_EVENT_META = {
    online:   { icon: 'plug', label: 'Connected' },
    offline:  { icon: 'plug-zap', label: 'Disconnected' },
    push:     { icon: 'upload', label: 'Pushed' },
    adopt:    { icon: 'download', label: 'Received' },
    conflict: { icon: 'git-merge', label: 'Conflict' },
    resolve:  { icon: 'check', label: 'Resolved' },
    error:    { icon: 'alert-triangle', label: 'Failed' },
  };

  function syncActivityHtml() {
    if (typeof Sync === 'undefined' || !Sync.getActivity) return '';
    const events = Sync.getActivity();
    if (!events.length) {
      return `<details class="sync-log"><summary class="text-xs text-faint">Activity</summary>
        <p class="text-xs text-faint" style="margin:var(--space-2) 0 0;">Nothing has synced in this session yet.</p></details>`;
    }
    const when = (t) => {
      const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (secs < 60) return secs + 's ago';
      if (secs < 3600) return Math.round(secs / 60) + 'm ago';
      return Math.round(secs / 3600) + 'h ago';
    };
    return `<details class="sync-log">
      <summary class="text-xs text-faint">Activity — ${events.length} event${events.length === 1 ? '' : 's'} this session</summary>
      <div class="sync-log-list">
        ${events.slice(0, 25).map(e => {
          const meta = SYNC_EVENT_META[e.kind] || { icon: 'dot', label: e.kind };
          return `<div class="sync-log-row ${e.kind === 'error' || e.kind === 'conflict' ? 'bad' : ''}">
            ${icon(meta.icon, 12)}
            <span class="slr-label">${escHtml(meta.label)}</span>
            <span class="slr-detail truncate">${escHtml(e.detail || '')}</span>
            <span class="slr-when">${escHtml(when(e.at))}</span>
          </div>`;
        }).join('')}
      </div>
    </details>`;
  }

  // Mirrors Cade.txt's Connection actions: drop and re-establish, so a stalled
  // session re-reconciles without the user having to reload the whole app.
  async function reconnectSync() {
    const settings = State.getSettings();
    if (!settings.sync.databaseUrl || !settings.sync.passphrase) { toast('Nothing to reconnect to'); return; }
    toast('Reconnecting…');
    Sync.disconnect();
    const res = await Sync.connect(settings.sync.databaseUrl, settings.sync.passphrase);
    Sync.updateStatus();
    if (res && res.success) {
      // The bridge's shared-config pull is once per session; a deliberate
      // reconnect is exactly when it should happen again.
      if (typeof Bridge !== 'undefined' && Bridge.resetConfigPull) Bridge.resetConfigPull();
      if (typeof Bridge !== 'undefined') Bridge.requestScan(200);
      toast('Reconnected');
      closeModal();
      render();
    } else {
      toast('Could not reconnect: ' + ((res && res.error) || 'unknown error'));
    }
  }

  async function connectSync() {
    const url = document.getElementById('syncUrl')?.value?.trim();
    const pass = document.getElementById('syncPass')?.value?.trim();
    if (!url || !pass) { toast('URL and passphrase required'); return; }
    toast('Connecting...');
    const result = await Sync.connect(url, pass);
    if (result.success) {
      toast('Connected to Firebase');
      Sync.updateStatus();
      closeModal();
      render();
    } else {
      toast('Connection failed: ' + (result.error || 'Unknown error'));
    }
  }

  function disconnectSync() {
    Sync.disconnect();
    const settings = State.getSettings();
    State.updateSettings({ sync: { ...settings.sync, connected: false } });
    toast('Disconnected');
    closeModal();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // QUICK ADD
  // ═══════════════════════════════════════════════════════════
  // One line in, one task out. The parser behind this has existed since the
  // command palette was built, and was reachable only by pressing Ctrl+K and
  // knowing it was there — so in practice every task went through a modal
  // with eight fields. This puts the same parser where tasks actually get
  // added, with a live preview of what it understood.
  function quickAddHtml(projectId) {
    return `<form class="qadd" onsubmit="event.preventDefault();App.quickAddSubmit();" ${projectId ? `data-project="${projectId}"` : ''}>
      ${icon('plus', 15)}
      <input type="text" id="quickAdd" class="qadd-input" autocomplete="off" spellcheck="false"
        placeholder="Add a task — try: call the fitter tue 3pm !high ~30m #home"
        oninput="App.quickAddPreview()" onkeydown="App.quickAddKey(event)">
      <span class="qadd-chips" id="quickAddChips"></span>
    </form>`;
  }

  function quickAddScope() {
    const el = document.querySelector('.qadd');
    const scoped = el && el.dataset.project;
    if (scoped) return scoped;
    const focus = focusedProjectId();
    return focus && focus !== 'none' ? focus : null;
  }

  function quickAddPreview() {
    const input = document.getElementById('quickAdd');
    const box = document.getElementById('quickAddChips');
    if (!input || !box || typeof Palette === 'undefined') return;
    const raw = input.value.trim();
    if (!raw) { box.innerHTML = ''; return; }
    const p = Palette.parse(raw);
    // The title is shown back only when the parser has eaten something —
    // otherwise the chip row would just echo what is already in the box.
    const chips = Palette.chipsFor(p);
    box.innerHTML = chips.map(c =>
      `<span class="qadd-chip">${escHtml(c.label)}</span>`).join('');
  }

  function quickAddKey(e) {
    if (e.key === 'Escape') { e.target.value = ''; quickAddPreview(); e.target.blur(); }
  }

  function quickAddSubmit() {
    const input = document.getElementById('quickAdd');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    if (typeof Palette === 'undefined') { toast('Quick add is unavailable'); return; }
    const defaultProjectId = quickAddScope();
    let created = null;
    undoable('Added a task', () => { created = Palette.createFromText(raw, { defaultProjectId }); }, { quiet: true });
    if (!created) { toast('Nothing to add — that parsed to an empty title'); return; }
    // A task added to a bridged project belongs in its room's list too.
    if (typeof Bridge !== 'undefined') Bridge.pushNewTask(created.entry).catch(() => {});
    input.value = '';
    render();
    // Re-focus so five tasks are five lines, not five round trips.
    setTimeout(() => {
      const again = document.getElementById('quickAdd');
      if (again) { again.focus(); quickAddPreview(); }
    }, 0);
    toast(created.summary ? `Added — ${created.summary}` : 'Added', { undo: true });
  }

  // ═══════════════════════════════════════════════════════════
  // WEEKLY REVIEW
  // ═══════════════════════════════════════════════════════════
  // The week digest exists as a strip of numbers on Insights. This is the
  // moment: what moved, what stalled, where the hours went, and what you
  // kept carrying — the four questions a weekly review is actually for.
  function weeklyFacts() {
    const days = [...Array(7)].map((_, i) => offsetDateStr(-i));
    const inWeek = (iso) => days.includes(String(iso || '').slice(0, 10));
    const entries = State.getEntries({ includeArchived: true });

    const finished = entries.filter(e => e.completed && inWeek(e.completedAt));
    const created = entries.filter(e => inWeek(e.createdAt));

    // Where the hours went, by project.
    const byProject = new Map();
    days.forEach(d => State.getLogs({ type: 'time_session', date: d }).forEach(l => {
      const e = l.entryId ? State.getEntry(l.entryId) : null;
      const pid = e ? (State.entryProjectIds(e)[0] || null) : null;
      byProject.set(pid, (byProject.get(pid) || 0) + (l.value || 0));
    }));
    const hours = [...byProject.entries()]
      .map(([pid, secs]) => ({ name: pid ? (State.getProject(pid) || {}).name || 'Deleted project' : 'No project', secs }))
      .sort((a, b) => b.secs - a.secs);
    const totalSecs = hours.reduce((s, h) => s + h.secs, 0);

    // Projects that finished something, and projects that did not but have
    // open work — "stalled" only means anything with work outstanding.
    const movedIds = new Set();
    finished.forEach(e => State.entryProjectIds(e).forEach(id => movedIds.add(id)));
    const stalled = State.getProjects().filter(p =>
      !movedIds.has(p.id) &&
      State.getEntries({ type: 'task', completed: false }).some(t => State.entryProjectIds(t).includes(p.id)));

    const carried = State.getEntries({ type: 'task', completed: false })
      .map(t => ({ t, days: carriedDays(t) }))
      .filter(x => x.days >= 3)
      .sort((a, b) => b.days - a.days);

    const moods = days.map(d => State.getLogs({ type: 'emotion', date: d }))
      .flat().map(l => Number(l.value)).filter(Number.isFinite);
    const avgMood = moods.length ? moods.reduce((a, c) => a + c, 0) / moods.length : null;

    const habits = State.getEntries({ type: 'habit' });
    const habitRate = habits.length
      ? Math.round(days.reduce((sum, d) => sum + habits.filter(h =>
          State.isHabitScheduledOn(h.id, d) && State.habitStatusOn(h.id, d) === 'done').length, 0) /
          Math.max(1, days.reduce((sum, d) => sum + habits.filter(h => State.isHabitScheduledOn(h.id, d)).length, 0)) * 100)
      : null;

    return { days, finished, created, hours, totalSecs, movedIds, stalled, carried, avgMood, habitRate };
  }

  function openWeeklyReview() {
    const f = weeklyFacts();
    const moved = State.getProjects().filter(p => f.movedIds.has(p.id));
    const pct = (secs) => (f.totalSecs ? Math.round(secs / f.totalSecs * 100) : 0);

    showModal('This week', `
      <p class="text-sm text-muted" style="line-height:1.7;margin-bottom:var(--space-3);">
        ${f.finished.length
          ? `${f.finished.length} finished, ${f.created.length} added${f.totalSecs ? `, ${Timers.formatTime(f.totalSecs)} tracked` : ''}.`
          : 'Nothing was marked finished this week.'}
        ${f.habitRate !== null ? ` Habits ran at ${f.habitRate}%.` : ''}
        ${f.avgMood !== null ? ` Mood averaged ${f.avgMood.toFixed(1)} out of 5.` : ''}
      </p>

      ${moved.length ? `<div class="section">
        <div class="section-header"><span class="section-title">What moved</span>
          <span class="stat-label">${moved.length}</span></div>
        <div class="shutdown-list">${moved.map(p => {
          const n = f.finished.filter(e => State.entryProjectIds(e).includes(p.id)).length;
          return `<div class="shutdown-row"><span class="proj-dot" style="background:${p.color}"></span>
            <span class="truncate" style="flex:1">${escHtml(p.name)}</span>
            <span class="text-xs text-faint">${n} done</span></div>`;
        }).join('')}</div>
      </div>` : ''}

      ${f.stalled.length ? `<div class="section">
        <div class="section-header"><span class="section-title">What stalled</span>
          <span class="stat-label">${f.stalled.length}</span></div>
        <p class="text-xs text-faint" style="margin-bottom:var(--space-2);">Open work, nothing finished in seven days.</p>
        <div class="shutdown-list">${f.stalled.slice(0, 8).map(p =>
          `<div class="shutdown-row"><span class="proj-dot" style="background:${p.color}"></span>
            <span class="truncate" style="flex:1">${escHtml(p.name)}</span>
            <button class="btn btn-ghost btn-sm" onclick="App.closeModal();App.revealProject('${p.id}');App.switchTab('projects')">Open</button>
          </div>`).join('')}</div>
      </div>` : ''}

      ${f.hours.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Where the hours went</span>
          <span class="stat-label">${Timers.formatTime(f.totalSecs)}</span></div>
        <div class="week-bars">${f.hours.slice(0, 6).map(h => `
          <div class="week-bar-row">
            <span class="week-bar-label truncate">${escHtml(h.name)}</span>
            <span class="week-bar"><span class="week-bar-fill" style="width:${pct(h.secs)}%"></span></span>
            <span class="week-bar-val">${Timers.formatTime(h.secs)}</span>
          </div>`).join('')}</div>
      </div>` : ''}

      ${f.carried.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Kept carrying</span>
          <span class="stat-label">${f.carried.length}</span></div>
        <div class="shutdown-list">${f.carried.slice(0, 8).map(({ t, days }) =>
          `<div class="shutdown-row">
            <span class="truncate" style="flex:1">${escHtml(t.title)}</span>
            <span class="pill pill-orange">${days} days</span>
          </div>`).join('')}</div>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);line-height:1.6;">
          Three days or more on the list. Usually a sign the task is really several,
          or that it was never going to happen.
        </p>
      </div>` : ''}
    `, [`<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`]);
  }

  // ═══════════════════════════════════════════════════════════
  // RECORDS
  // ═══════════════════════════════════════════════════════════
  // Cheap to compute from data already kept, and the only part of a personal
  // system that ever feels like a reward.
  function computeRecords() {
    const entries = State.getEntries({ includeArchived: true });
    const done = entries.filter(e => e.completed && e.completedAt);
    const byDay = new Map();
    done.forEach(e => {
      const d = String(e.completedAt).slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + 1);
    });
    const bestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    const byWeek = new Map();
    byDay.forEach((n, d) => {
      const monday = new Date(d + 'T00:00');
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const k = State.dateStr(monday);
      byWeek.set(k, (byWeek.get(k) || 0) + n);
    });
    const bestWeek = [...byWeek.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    // The longest run of consecutive days with at least one completion.
    const dayList = [...byDay.keys()].sort();
    let bestStreak = 0, run = 0, prev = null;
    dayList.forEach(d => {
      run = (prev && (Date.parse(d) - Date.parse(prev)) === 86400000) ? run + 1 : 1;
      prev = d;
      if (run > bestStreak) bestStreak = run;
    });

    const habitBest = State.getEntries({ type: 'habit' })
      .map(h => ({ title: h.title, streak: (State.calculateStreak(h.id) || {}).best || 0 }))
      .sort((a, b) => b.streak - a.streak)[0] || null;

    const totalSecs = State.getLogs({ type: 'time_session' }).reduce((s, l) => s + (l.value || 0), 0);
    const firstDone = done.map(e => e.completedAt).sort()[0] || null;

    return {
      total: done.length, bestDay, bestWeek, bestStreak, habitBest, totalSecs, firstDone,
      activeDays: byDay.size,
    };
  }

  const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000, 2500];

  function openRecords() {
    const r = computeRecords();
    const next = MILESTONES.find(m => m > r.total);
    const fmtDay = (d) => new Date(d + 'T00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const row = (label, value, note) => `<div class="rec-row">
      <span class="rec-label">${escHtml(label)}</span>
      <span class="rec-value">${value}</span>
      ${note ? `<span class="rec-note">${escHtml(note)}</span>` : ''}
    </div>`;

    showModal('Records', r.total === 0 ? `
      <p class="text-sm text-muted" style="line-height:1.7;">
        Nothing finished yet, so there is nothing to beat. Come back once you have.
      </p>` : `
      <div class="rec-list">
        ${row('Finished, all time', r.total, r.firstDone ? 'since ' + fmtDay(String(r.firstDone).slice(0, 10)) : '')}
        ${r.bestDay ? row('Best day', r.bestDay[1] + ' tasks', fmtDay(r.bestDay[0])) : ''}
        ${r.bestWeek ? row('Best week', r.bestWeek[1] + ' tasks', 'week of ' + fmtDay(r.bestWeek[0])) : ''}
        ${row('Longest run', r.bestStreak + ' day' + (r.bestStreak === 1 ? '' : 's'), 'finishing something every day')}
        ${row('Days with something done', r.activeDays, '')}
        ${r.habitBest && r.habitBest.streak ? row('Longest habit streak', r.habitBest.streak + ' days', r.habitBest.title) : ''}
        ${r.totalSecs ? row('Time tracked', Timers.formatTime(r.totalSecs), 'all time') : ''}
      </div>
      ${next ? `<div class="rec-next">
        <div class="rec-next-head">
          <span>Next milestone</span><span class="rec-next-count">${r.total} / ${next}</span>
        </div>
        <span class="progress-bar"><span class="progress-fill" style="width:${Math.round(r.total / next * 100)}%"></span></span>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);">
          ${next - r.total} more to reach ${next}.
        </p>
      </div>` : ''}
    `, [`<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`]);
  }

  // ═══════════════════════════════════════════════════════════
  // SHUTDOWN REVIEW
  // ═══════════════════════════════════════════════════════════
  // Daily Review triages what is overdue — a morning tool. This is its
  // evening counterpart: what got done, what slipped and by how often, where
  // the hours went, and what is first tomorrow. Ending the day deliberately
  // is the part a task list usually leaves out.
  function shutdownFacts() {
    const today = State.todayStr();
    const tomorrow = State.dateStr(new Date(Date.now() + 86400000));
    const entries = State.getEntries({ includeArchived: true });

    const done = entries.filter(e => e.completed && (e.completedAt || '').startsWith(today));
    const openToday = State.getEntries({ type: 'task', completed: false }).filter(t =>
      t.dueDate === today || t.scheduledDate === today || (!t.dueDate && !t.scheduledDate));
    const slipped = openToday.filter(t => t.dueDate === today || t.scheduledDate === today);
    const focusSeconds = State.getLogs({ type: 'time_session', date: today })
      .reduce((sum, l) => sum + (l.value || 0), 0);
    const habits = State.getEntries({ type: 'habit' })
      .filter(h => State.isHabitScheduledOn(h.id, today));
    const habitsDone = habits.filter(h => State.isHabitDoneToday(h.id));
    const tomorrowTasks = State.getEntries({ type: 'task', completed: false })
      .filter(t => t.dueDate === tomorrow || t.scheduledDate === tomorrow)
      .sort((a, b) => taskScore(b) - taskScore(a));

    return { today, tomorrow, done, slipped, focusSeconds, habits, habitsDone, tomorrowTasks };
  }

  // How many days running a task has been on the list without being done.
  // A task dodged four times is telling you something — break it up or drop
  // it — and nothing in the app was keeping count.
  function carriedDays(t) {
    const from = t.scheduledDate || t.dueDate || (t.createdAt || '').slice(0, 10);
    if (!from || t.completed) return 0;
    const start = Date.parse(from + 'T00:00');
    if (!Number.isFinite(start)) return 0;
    return Math.max(0, Math.floor((Date.now() - start) / 86400000));
  }

  function openShutdown() {
    const f = shutdownFacts();
    const carried = f.slipped
      .map(t => ({ t, days: carriedDays(t) }))
      .filter(x => x.days >= 1)
      .sort((a, b) => b.days - a.days);

    showModal('Shutdown', `
      <p class="text-sm text-muted" style="line-height:1.7;margin-bottom:var(--space-3);">
        ${f.done.length
          ? `You finished ${f.done.length} thing${f.done.length === 1 ? '' : 's'} today${f.focusSeconds ? ` and tracked ${Timers.formatTime(f.focusSeconds)}` : ''}.`
          : 'Nothing was marked done today — which is sometimes just how a day goes.'}
      </p>

      ${f.done.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Done today</span>
          <span class="stat-label">${f.done.length}</span></div>
        <div class="shutdown-list">${f.done.slice(0, 12).map(e =>
          `<div class="shutdown-row">${icon('check', 13)}<span class="truncate">${escHtml(e.title)}</span></div>`).join('')}
          ${f.done.length > 12 ? `<div class="text-xs text-faint">and ${f.done.length - 12} more</div>` : ''}</div>
      </div>` : ''}

      ${f.habits.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Habits</span>
          <span class="stat-label">${f.habitsDone.length} / ${f.habits.length}</span></div>
        ${f.habitsDone.length < f.habits.length ? `<p class="text-xs" style="color:var(--hl-orange);">
          Still open: ${f.habits.filter(h => !State.isHabitDoneToday(h.id)).map(h => escHtml(h.title)).join(', ')}</p>` : ''}
      </div>` : ''}

      ${f.slipped.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Didn’t happen</span>
          <span class="stat-label">${f.slipped.length}</span></div>
        <div class="shutdown-list">${f.slipped.slice(0, 10).map(t => {
          const days = carriedDays(t);
          return `<div class="shutdown-row">
            ${icon('circle', 13)}<span class="truncate" style="flex:1">${escHtml(t.title)}</span>
            ${days >= 2 ? `<span class="pill pill-orange" title="On the list this long without being finished">carried ${days}×</span>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="App.snoozeEntry('${t.id}','tomorrow')">Tomorrow</button>
          </div>`;
        }).join('')}</div>
        ${carried.length ? `<p class="text-xs text-faint" style="margin-top:var(--space-2);line-height:1.6;">
          ${carried.length === 1 ? 'One task has' : `${carried.length} tasks have`} been carried more than a day.
          Something carried repeatedly usually wants breaking up, or dropping.
        </p>` : ''}
      </div>` : ''}

      <div class="section">
        <div class="section-header"><span class="section-title">First thing tomorrow</span></div>
        ${f.tomorrowTasks.length
          ? `<div class="shutdown-list">${f.tomorrowTasks.slice(0, 5).map(t =>
              `<div class="shutdown-row">${icon('arrow-right', 13)}<span class="truncate">${escHtml(t.title)}</span></div>`).join('')}</div>`
          : `<p class="text-xs text-faint">Nothing is dated tomorrow yet. Snooze something above, or leave it open.</p>`}
      </div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`,
      f.slipped.length ? `<button class="btn btn-primary" onclick="App.shutdownPushAll()">${icon('calendar-arrow-down', 14)}Move ${f.slipped.length} to tomorrow</button>` : '',
    ]);
  }

  function shutdownPushAll() {
    const f = shutdownFacts();
    if (!f.slipped.length) return;
    undoable(`Moved ${f.slipped.length} task${f.slipped.length === 1 ? '' : 's'} to tomorrow`, () => {
      f.slipped.forEach(t => State.updateEntry(t.id, {
        scheduledDate: f.tomorrow,
        dueDate: t.dueDate ? f.tomorrow : t.dueDate,
      }));
    });
    closeModal();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // TRASH
  // ═══════════════════════════════════════════════════════════
  const TRASH_KIND_LABEL = {
    entry: 'Task', project: 'Project', scratch: 'Scratch idea',
    planner: 'Planner block', log: 'Log', tag: 'Tag',
  };

  function trashItemName(rec) {
    const p = rec.payload || {};
    return p.title || p.name || p.text || p.type || TRASH_KIND_LABEL[rec.kind] || 'Item';
  }

  function daysLeft(rec) {
    const t = Date.parse(rec.deletedAt || '');
    if (!Number.isFinite(t)) return State.TRASH_DAYS;
    return Math.max(0, State.TRASH_DAYS - Math.floor((Date.now() - t) / 86400000));
  }

  function openTrash() {
    const items = State.getTrash();
    showModal('Trash', `
      <p class="text-sm text-muted" style="line-height:1.7;margin-bottom:var(--space-3);">
        Deleted items wait here for ${State.TRASH_DAYS} days, then go for good.
        ${items.length ? '' : 'Nothing in here right now.'}
      </p>
      ${items.length ? `<div class="trash-list">${items.map(rec => `
        <div class="trash-row">
          <span class="trash-kind">${escHtml(TRASH_KIND_LABEL[rec.kind] || rec.kind)}</span>
          <span class="trash-name truncate">${escHtml(trashItemName(rec))}</span>
          <span class="trash-age">${daysLeft(rec)}d left</span>
          <span class="trash-acts">
            <button class="icon-btn" onclick="App.restoreFromTrash('${rec.id}')" title="Restore" aria-label="Restore">${icon('undo-2', 15)}</button>
            <button class="icon-btn" onclick="App.purgeFromTrash('${rec.id}')" title="Delete for good" aria-label="Delete for good">${icon('trash-2', 15)}</button>
          </span>
        </div>`).join('')}</div>` : ''}
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`,
      items.length ? `<button class="btn btn-danger" onclick="App.emptyTrash()">Empty Trash</button>` : '',
    ]);
  }

  function restoreFromTrash(id) {
    const rec = State.restoreFromTrash(id);
    toast(rec ? `Restored “${trashItemName(rec)}”` : 'Could not restore that');
    render();
    openTrash();
  }

  function purgeFromTrash(id) {
    const rec = State.getTrash().find(r => r.id === id);
    // Past this point there is genuinely no way back, so this one does ask.
    if (!confirm(`Delete “${rec ? trashItemName(rec) : 'this item'}” permanently?`)) return;
    State.purgeFromTrash(id);
    render();
    openTrash();
  }

  function emptyTrash() {
    const n = State.getTrash().length;
    if (!n || !confirm(`Permanently delete ${n} item${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    State.emptyTrash();
    toast(`Emptied the trash — ${n} item${n === 1 ? '' : 's'} gone`);
    render();
    closeModal();
  }

  // ═══════════════════════════════════════════════════════════
  // CADE.TXT LINK
  // ═══════════════════════════════════════════════════════════
  function openBridgePanel() {
    if (typeof Bridge === 'undefined' || !Bridge.available()) {
      showModal('Cade.txt Link', `
        <p class="text-sm text-muted" style="line-height:1.7;">
          Nothing to link yet. Open <a href="../txt.html" style="color:var(--accent-text)">Cade.txt</a>
          in this browser and create a room, then come back — the two apps share
          storage on this origin, so no setup is needed.
        </p>`, [`<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`]);
      return;
    }

    const rooms = Bridge.getRooms();
    const membership = Bridge.getRoomWorkspace();
    const workspaces = Bridge.getWorkspaces();
    const linked = State.getProjects({ includeArchived: true });

    const rows = rooms.map(name => {
      const todos = Bridge.parseTodos(Bridge.roomText(name));
      const proj = linked.find(p => p.txtRoom === name);
      const wsNames = (membership[name] || [])
        .map(id => workspaces.find(w => w.id === id)?.name).filter(Boolean);
      const done = todos.filter(t => t.done).length;
      return { name, todos: todos.length, done, proj, wsNames };
    });
    const waiting = Bridge.roomsNeedingText();
    const waitingSet = new Set(waiting);
    const withLists = rows.filter(r => r.todos > 0);
    const without = rows.filter(r => r.todos === 0 && !waitingSet.has(r.name));
    const { url } = Bridge.creds();

    showModal('Cade.txt Link', `
      <p class="text-sm text-muted" style="line-height:1.7;margin-bottom:var(--space-4);">
        Workspaces appear here as projects and rooms as sub-projects. A room joins
        in as soon as it contains a line starting with <code>[ ]</code> or
        <code>[x]</code> — ticking a box in either app updates the other.
      </p>

      <div class="section">
        <div class="section-header"><span class="section-title">Linked rooms</span>
          <span class="stat-label">${withLists.length}</span></div>
        ${withLists.length === 0
          ? '<p class="text-xs text-faint">No room holds a todo list yet. Add a <code>[ ]</code> line to one in Cade.txt.</p>'
          : `<div style="display:flex;flex-direction:column;gap:var(--space-1);">${withLists.map(r => `
              <div class="subproj-row" style="cursor:default">
                <span class="proj-dot" style="background:${r.proj?.color || 'var(--text-faint)'}"></span>
                <span class="truncate" style="flex:1">${escHtml(r.name)}</span>
                ${r.wsNames.length ? `<span class="pill">${escHtml(r.wsNames.join(', '))}</span>` : ''}
                <span class="project-stat">${r.todos - r.done} open · ${r.done} done</span>
              </div>`).join('')}</div>`}
      </div>

      ${waiting.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Not fetched yet</span>
          <span class="stat-label">${waiting.length}</span></div>
        <p class="text-xs text-faint" style="line-height:1.6;">
          ${waiting.map(n => escHtml(n)).join(' · ')}<br>
          Cade.txt only stores a room's text on a device once you open it there.
          ${url ? `These are pulled from Firebase on the next scan — press Rescan to do it now.
                   A room that has never been synced from any device has nothing to pull, so it
                   stays listed here until Cade.txt uploads it.`
                : `With no Firebase database configured there is nowhere to pull them from —
                   open them in Cade.txt on this device instead.`}
        </p>
      </div>` : ''}

      ${without.length ? `<div class="section">
        <div class="section-header"><span class="section-title">Rooms without a list</span>
          <span class="stat-label">${without.length}</span></div>
        <p class="text-xs text-faint">${without.map(r => escHtml(r.name)).join(' · ')}</p>
      </div>` : ''}

      <p class="text-xs text-faint" style="margin-top:var(--space-4);line-height:1.6;">
        ${url ? 'Room edits made here are encrypted with Cade.txt&rsquo;s key and pushed to its database, so other devices see them.'
              : 'Cade.txt has no Firebase database configured, so changes stay on this device until it does.'}
      </p>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`,
      url ? `<button class="btn btn-secondary" onclick="App.seedRooms()" title="Upload rooms this device holds that the database has never seen">${icon('upload-cloud', 14)}Upload missing</button>` : '',
      `<button class="btn btn-primary" onclick="App.rescanBridge()">Rescan now</button>`,
    ]);
  }

  // Rooms this device holds text for that the server has never seen. Without
  // this they are invisible in every other browser, however often you rescan
  // there — there is simply nothing to fetch.
  let seeding = false;
  async function seedRooms() {
    if (typeof Bridge === 'undefined' || seeding) return;
    seeding = true;
    closeModal();
    toast('Checking which rooms the database is missing…');
    let res = { seeded: 0 };
    try {
      for (let pass = 0; pass < 20; pass++) {
        const r = await Bridge.seedMissingRooms({ force: pass === 0 });
        res = { seeded: (res.seeded || 0) + r.seeded, reason: r.reason };
        if (!r.checked) break;
      }
    } catch (e) { console.warn('Seeding failed', e); }
    seeding = false;
    if (res.reason === 'no-credentials') { toast('No database configured — nothing to upload to'); return; }
    toast(res.seeded
      ? `Uploaded ${res.seeded} room${res.seeded === 1 ? '' : 's'} — other browsers can see them now`
      : 'The database already had every room this device holds');
    render();
  }

  // What a finished rescan should say. Rooms that could not be pulled are
  // named as such rather than passed over: reporting "already up to date"
  // while dozens of rooms are still missing is what made the old version look
  // like it was working when it was in fact spinning.
  const RESCAN_MAX_PASSES = 40;           // 40 × 25 rooms, then stop regardless

  function rescanMessage(pulled, last, changed) {
    if (last.reason === 'no-credentials') return 'Cade.txt has no Firebase set up — nothing to fetch';
    if (last.reason === 'no-database') return 'Firebase is unavailable right now';
    const parts = [];
    if (pulled) parts.push(`Pulled ${pulled} room${pulled > 1 ? 's' : ''}`);
    if (last.storageFull) parts.push('storage is full');
    const stuck = last.pending || 0;
    if (stuck) {
      if (last.unreachable) parts.push(`${stuck} unreachable`);
      else if (last.unreadable) parts.push(`${stuck} locked or unreadable`);
      else parts.push(`${stuck} not on the server yet`);
    }
    if (parts.length) return parts.join(' · ');
    return changed ? 'Cade.txt rooms re-read' : 'Already up to date';
  }

  // Explicit Rescan. Pulls in bursts until a pass stops making progress —
  // NOT until nothing is left outstanding. A room whose document was never
  // written to Firebase can never be pulled, so looping while any room is
  // still missing runs forever, re-fetching the same rooms several times a
  // second. `fetched` is the only condition that can go false.
  let rescanning = false;

  async function rescanBridge() {
    if (typeof Bridge === 'undefined' || rescanning) return;
    closeModal();
    rescanning = true;
    const waiting = Bridge.roomsNeedingText().length;
    if (waiting) toast(`Fetching ${waiting} room${waiting > 1 ? 's' : ''} from Firebase…`);

    let pulled = 0;
    let last = { fetched: 0, pending: waiting, missing: 0, unreadable: 0, unreachable: 0, reason: '' };
    try {
      for (let pass = 0; pass < RESCAN_MAX_PASSES; pass++) {
        // Explicit user action — bypass the retry cooldown.
        last = await Bridge.hydrateMissingRooms({ force: true });
        pulled += last.fetched;
        if (!last.fetched || !last.pending) break;   // no progress, or nothing left
      }
    } catch (e) {
      console.warn('Rescan failed', e);
    } finally {
      rescanning = false;
    }

    const stats = Bridge.scan();
    render();
    toast(rescanMessage(pulled, last, !!(stats && stats.changed)));
  }

  // Creating a sub-project here creates the matching room in Cade.txt. An
  // existing room keeps everything it already holds — the new sub-project
  // simply adopts it.
  function openNewSubproject() {
    const tops = State.getProjects().filter(p => p.depth === 0);
    const preselect = (activeWorkspace !== WS_ALL && activeWorkspace !== WS_UNFILED) ? activeWorkspace : '';
    const txtOn = typeof Bridge !== 'undefined' && Bridge.available();
    showModal('New Sub-project', `
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" class="form-input" id="subName" placeholder="e.g. Kitchen remodel" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Inside</label>
        <select class="form-select" id="subParent">
          <option value="">— top level —</option>
          ${tops.map(p => `<option value="${p.id}" ${preselect === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}
        </select>
      </div>
      ${txtOn ? `<label class="form-check" style="display:flex;align-items:center;gap:var(--space-2);">
        <input type="checkbox" id="subMakeRoom" checked>
        <span class="text-sm">Also create the room in Cade.txt</span>
      </label>
      <p class="text-xs text-faint" style="margin-top:var(--space-2);line-height:1.6;">
        If a room with this name already exists its contents are kept — the
        sub-project adopts it and new tasks are appended to the bottom of its list.
      </p>` : ''}
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveNewSubproject()">Create</button>`,
    ]);
    setTimeout(() => document.getElementById('subName')?.focus(), 60);
  }

  async function saveNewSubproject() {
    const name = document.getElementById('subName')?.value?.trim();
    if (!name) { toast('Name required'); return; }
    const parentId = document.getElementById('subParent')?.value || null;
    const makeRoom = document.getElementById('subMakeRoom')?.checked;

    const parent = parentId ? State.getProject(parentId) : null;

    // Naming an existing room adopts its sub-project rather than standing a
    // second, empty one next to it — the same "append, don't replace" rule
    // the room itself follows.
    const existing = State.getProjects({ includeArchived: true }).find(p =>
      p.txtRoom === name || (p.name === name && p.parentId === parentId));
    if (existing) {
      closeModal();
      const patch = { archived: false };
      if (parentId && existing.parentId !== parentId && !State.wouldCycleProject(existing.id, parentId)) {
        patch.parentId = parentId;
      }
      State.updateProject(existing.id, patch);
      openSubproject(existing.parentId || parentId || WS_ALL, existing.id);
      toast(`"${name}" already exists — opened it`);
      return;
    }

    const proj = State.createProject({ name, parentId, icon: 'file-text' });
    closeModal();

    if (makeRoom && typeof Bridge !== 'undefined') {
      // The room needs a workspace to live in; if the parent project isn't
      // linked to one yet, create that workspace too so the room isn't
      // orphaned in Cade.txt's "Unlabeled" bucket.
      let wsId = parent ? parent.txtWorkspaceId : null;
      if (parent && !wsId) {
        wsId = await Bridge.ensureWorkspace(parent.name, 'teal');
        State.updateProject(parent.id, { txtWorkspaceId: wsId });
      }
      const result = await Bridge.ensureRoom(name, wsId);
      State.updateProject(proj.id, { txtRoom: name, txtHasList: true });
      toast(result.appended ? `Adopted existing room "${name}"` : `Created room "${name}" in Cade.txt`);
    }

    if (parentId) { activeWorkspace = parentId; activeSubproject = proj.id; saveNav(); }
    render();
  }

  function openTimer() { Timers.openPanel(); }
  function stopAllTimers() { Timers.stopAll(); toast('All timers stopped'); }

  function addScratchFromMenu() {
    switchTab('scratch');
    setTimeout(() => document.getElementById('scratchInput')?.focus(), 120);
  }

  // ═══════════════════════════════════════════════════════════
  // QUICK LOG MODAL v2 — shortcuts, check-in, wake/sleep
  // ═══════════════════════════════════════════════════════════
  let quickEmotion = null;
  let quickEnergy = null;
  let quickLogTab = 'log'; // 'log' | 'sleep' | 'health' | 'task'

  function openQuickLog(tab) {
    quickEmotion = null;
    quickEnergy = null;
    if (tab) quickLogTab = tab;
    showModal('Quick Log', renderQuickLogBody(), [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Done</button>`,
    ]);
  }

  function setQuickLogTab(t) {
    quickLogTab = t;
    const body = document.getElementById('modalBody');
    if (body) { body.innerHTML = renderQuickLogBody(); refreshIcons(); }
  }

  function renderQuickLogBody() {
    const shortcuts = State.getSettings().quickShortcuts || [];
    const tabs = [
      { id: 'log', icon: 'smile', label: 'Log' },
      { id: 'sleep', icon: 'moon', label: 'Sleep' },
      { id: 'health', icon: 'apple', label: 'Health' },
      { id: 'task', icon: 'list-plus', label: 'Task' },
    ];

    let body = '';
    if (quickLogTab === 'log') {
      body = `
        <div class="form-group">
          <label class="form-label">How do you feel right now?</label>
          <div class="emotion-selector" id="quickEmotionSel">
            ${['bad', 'low', 'okay', 'good', 'great'].map(e => `
              <button class="emotion-btn ${quickEmotion === e ? 'selected' : ''}" id="qe-${e}" onclick="App.setQuickEmotion('${e}')">
                ${icon(MOOD_ICONS[e], 22)}
                <span class="emotion-label">${e}</span>
              </button>`).join('')}
          </div>
          <label class="form-label" style="margin-top:var(--space-3);">Energy</label>
          <div class="energy-selector" id="quickEnergySel">
            ${[1, 2, 3, 4, 5].map(n => `<button class="energy-btn ${quickEnergy != null && n <= quickEnergy ? 'selected' : ''}" id="qen-${n}" onclick="App.setQuickEnergy(${n})" aria-label="Energy ${n}">⚡</button>`).join('')}
          </div>
          <label class="form-label" style="margin-top:var(--space-3);">Journal</label>
          <textarea class="form-textarea" id="checkinNote" placeholder="What's on your mind? Free-form — saved with the check-in." style="min-height:80px;"></textarea>
          <button class="btn btn-primary w-full" style="margin-top:var(--space-2);" onclick="App.logCheckinFromModal()">${icon('pen-line', 14)}Log check-in</button>
          <p class="text-xs text-faint" style="margin-top:var(--space-2);">Check-ins are timestamped sub-logs. The single Day Mood lives on the Today page.</p>
        </div>`;
    } else if (quickLogTab === 'sleep') {
      body = `
        <div class="form-group">
          <label class="form-label">Wake / Sleep</label>
          <div class="wake-sleep-row">
            <input type="time" class="form-input" id="wakeSleepTime">
            <button class="btn btn-secondary" onclick="App.logWake('wakeSleepTime')">${icon('sunrise', 15)}Wake</button>
            <button class="btn btn-secondary" onclick="App.logSleep('wakeSleepTime')">${icon('moon', 15)}Sleep</button>
          </div>
          <div id="wakeSleepCurrent" style="margin-top:var(--space-2);">${renderWakeSleepCurrent()}</div>
          <p class="text-xs text-faint" style="margin-top:var(--space-1);">Nothing is logged until you enter a time and press a button. Trends live on the Health tab.</p>
        </div>`;
    } else if (quickLogTab === 'health') {
      body = `
        <div class="form-group">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
            <label class="form-label" style="margin-bottom:0;">Shortcuts</label>
            <button class="btn btn-ghost btn-sm" onclick="App.openManageShortcuts()">${icon('settings-2', 12)}Manage</button>
          </div>
          <div class="shortcut-chips" id="shortcutChips">
            ${shortcuts.map(s => `
              <button class="shortcut-chip" id="sc-${s.id}" onclick="App.useShortcut('${s.id}')">
                <span>${s.emoji}</span><span>${escHtml(s.label)}</span>
                ${s.calories ? `<span class="sc-cal">${s.calories} cal</span>` : ''}
              </button>`).join('')}
            ${shortcuts.length === 0 ? '<p class="text-xs text-faint">No shortcuts yet — add coffee, water, or saved meals via Manage.</p>' : ''}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Log Calories</label>
          <div style="display:flex;gap:var(--space-2);">
            <input type="number" class="form-input" id="calorieInput" placeholder="Calories" style="flex:1">
            <select class="form-select" id="mealSelect" style="width:auto;">
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snack" selected>Snack</option>
            </select>
            <button class="btn btn-primary" onclick="App.logCaloriesFromModal()">Add</button>
          </div>
          <p class="text-xs text-faint" style="margin-top:var(--space-2);">Macros and charts live on the Health tab.</p>
        </div>`;
    } else if (quickLogTab === 'task') {
      body = `
        <div class="form-group">
          <label class="form-label">Quick Add Task</label>
          <textarea class="form-input input-grow" id="quickTaskInput" rows="1" placeholder="Task title — Enter to add" autocomplete="off"
            oninput="App.autoGrow(this)"
            onkeydown="if(event.key==='Enter'){event.preventDefault();App.quickAddTask(this.value);this.value='';App.autoGrow(this);}"></textarea>
          <p class="text-xs text-faint" style="margin-top:var(--space-2);">Lands in Today unscheduled. Use + for the full form (projects, dates, effort).</p>
        </div>`;
    }

    return `
      <div class="form-group">
        <div class="type-selector" style="grid-template-columns:repeat(4,1fr);">
          ${tabs.map(t => `
            <div class="type-card ${quickLogTab === t.id ? 'selected' : ''}" onclick="App.setQuickLogTab('${t.id}')">
              <i data-lucide="${t.icon}"></i>
              <span>${t.label}</span>
            </div>`).join('')}
        </div>
      </div>
      ${body}
      <div class="divider"></div>
      <div class="form-group">
        <label class="form-label">Today so far</label>
        <div class="loglist" id="quickLogList">${renderQuickLogList()}</div>
      </div>
    `;
  }

  function renderQuickLogList() {
    const today = State.todayStr();
    const logs = State.getLogs({ date: today })
      .filter(l => ['calorie', 'quick', 'checkin', 'wake', 'sleep'].includes(l.type))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (logs.length === 0) return '<p class="text-xs text-faint">Nothing logged yet today.</p>';
    return logs.slice(0, 12).map(l =>
      `<div class="log-row">
        <span class="lr-time">${logTimeOf(l)}</span>
        <span class="lr-desc">${describeLog(l)}</span>
        <span class="lr-actions"><button class="icon-btn" onclick="App.deleteQuickLogRow('${l.id}')" aria-label="Remove">${icon('x', 12)}</button></span>
      </div>`
    ).join('');
  }

  function deleteQuickLogRow(id) {
    State.deleteLog(id);
    refreshQuickLogList();
    refreshWakeSleepCurrent();
  }

  function refreshQuickLogList() {
    const el = document.getElementById('quickLogList');
    if (el) { el.innerHTML = renderQuickLogList(); refreshIcons(); }
  }

  function useShortcut(id) {
    State.logQuickShortcut(id);
    const chip = document.getElementById(`sc-${id}`);
    if (chip) {
      chip.classList.add('just-logged');
      setTimeout(() => chip.classList.remove('just-logged'), 1200);
    }
    refreshQuickLogList();
  }

  function setQuickEmotion(e) {
    quickEmotion = quickEmotion === e ? null : e;
    document.querySelectorAll('#quickEmotionSel .emotion-btn').forEach(b => b.classList.remove('selected'));
    if (quickEmotion) document.getElementById(`qe-${e}`)?.classList.add('selected');
  }

  function setQuickEnergy(n) {
    quickEnergy = quickEnergy === n ? null : n;
    document.querySelectorAll('#quickEnergySel .energy-btn').forEach((b, i) => {
      b.classList.toggle('selected', quickEnergy != null && i < quickEnergy);
    });
  }

  function logCheckinFromModal() {
    const notes = document.getElementById('checkinNote')?.value?.trim() || '';
    if (!quickEmotion && !quickEnergy && !notes) return;
    State.logCheckin({ emotion: quickEmotion, energy: quickEnergy, notes });
    quickEmotion = null;
    quickEnergy = null;
    document.querySelectorAll('#quickEmotionSel .emotion-btn, #quickEnergySel .energy-btn').forEach(b => b.classList.remove('selected'));
    const noteEl = document.getElementById('checkinNote');
    if (noteEl) noteEl.value = '';
    refreshQuickLogList();
  }

  // Today's logged wake/sleep with inline remove — shared by Quick Log & Health
  function renderWakeSleepCurrent() {
    const today = State.todayStr();
    const wake = State.getLogs({ type: 'wake', date: today })[0];
    const sleep = State.getLogs({ type: 'sleep', date: today })[0];
    if (!wake && !sleep) return `<span class="text-xs text-faint">Not logged today.</span>`;
    let out = '';
    if (wake) out += `<span class="pill" style="margin-right:var(--space-2);">${icon('sunrise', 12)} ${wake.time}
      <button onclick="App.removeWakeSleep('wake')" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;line-height:1;" aria-label="Remove wake time">×</button></span>`;
    if (sleep) out += `<span class="pill">${icon('moon', 12)} ${sleep.time}
      <button onclick="App.removeWakeSleep('sleep')" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;line-height:1;" aria-label="Remove sleep time">×</button></span>`;
    return out;
  }

  function refreshWakeSleepCurrent() {
    const el = document.getElementById('wakeSleepCurrent');
    if (el) el.innerHTML = renderWakeSleepCurrent();
  }

  function logWake(inputId = 'wakeSleepTime') {
    const time = document.getElementById(inputId)?.value;
    if (!time) { toast('Enter a time first'); return; }
    State.logWakeSleep('wake', time);
    refreshWakeSleepCurrent();
    refreshQuickLogList();
    if (currentTab === 'health') render();
  }

  function logSleep(inputId = 'wakeSleepTime') {
    const time = document.getElementById(inputId)?.value;
    if (!time) { toast('Enter a time first'); return; }
    State.logWakeSleep('sleep', time);
    refreshWakeSleepCurrent();
    refreshQuickLogList();
    if (currentTab === 'health') render();
  }

  function removeWakeSleep(kind) {
    const log = State.getLogs({ type: kind, date: State.todayStr() })[0];
    if (log) State.deleteLog(log.id);
    refreshWakeSleepCurrent();
    refreshQuickLogList();
    if (currentTab === 'health' || currentTab === 'history') render();
  }

  function logCaloriesFromModal() {
    const cal = parseInt(document.getElementById('calorieInput')?.value);
    const meal = document.getElementById('mealSelect')?.value || 'snack';
    if (!cal || cal <= 0) { toast('Enter valid calories'); return; }
    State.logCalories(cal, '', meal);
    document.getElementById('calorieInput').value = '';
    refreshQuickLogList();
  }

  function openCalorieLog() {
    switchTab('health');
    setTimeout(() => document.getElementById('foodCal')?.focus(), 200);
  }

  function quickAddTask(title) {
    if (!title.trim()) return;
    // The quick input understands the same shorthand as the palette:
    // "Fix login tomorrow 3pm #bugs @Work !high ~30m"
    if (typeof Palette !== 'undefined') {
      const r = Palette.createFromText(title, { forceType: 'task' });
      if (r) { toast(`Task added${r.summary ? ' — ' + r.summary : ''}`); return; }
    }
    State.createEntry({ type: 'task', title: title.trim() });
    toast('Task added');
  }

  // Day mood (Today page) — one per day, updated in place. No toast.
  function logEmotion(emotion) {
    State.logEmotion(emotion);
    render();
  }

  // ── Manage shortcuts modal ─────────────────────────────────
  function openManageShortcuts() {
    const shortcuts = State.getSettings().quickShortcuts || [];
    showModal('Quick Log Shortcuts', `
      <div style="display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:var(--space-4);" id="shortcutManageList">
        ${shortcuts.length === 0 ? '<p class="text-xs text-faint">No shortcuts yet.</p>' : shortcuts.map(s => `
          <div class="chain-link" style="justify-content:space-between;">
            <span>${s.emoji} ${escHtml(s.label)}${s.calories ? ` <span class="text-xs text-faint">· ${s.calories} cal (${s.meal || 'snack'})</span>` : ''}</span>
            <button class="icon-btn" onclick="App.deleteShortcut('${s.id}')" aria-label="Remove">${icon('trash-2', 14)}</button>
          </div>`).join('')}
      </div>
      <div class="divider"></div>
      <label class="form-label">Add shortcut</label>
      <div class="grid-2">
        <div class="form-group">
          <input type="text" class="form-input" id="scEmoji" placeholder="Emoji (e.g. 🥗)" maxlength="4">
        </div>
        <div class="form-group">
          <input type="text" class="form-input" id="scLabel" placeholder="Label (e.g. Lunch salad)">
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <input type="number" class="form-input" id="scCalories" placeholder="Calories (optional)">
        </div>
        <div class="form-group">
          <select class="form-select" id="scMeal">
            <option value="snack">Snack</option>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary w-full" onclick="App.addShortcut()">${icon('plus', 14)}Add Shortcut</button>
    `, [
      `<button class="btn btn-secondary" onclick="App.openQuickLog()">Back to Quick Log</button>`,
    ]);
  }

  function addShortcut() {
    const label = document.getElementById('scLabel')?.value?.trim();
    if (!label) { toast('Label is required'); return; }
    const emoji = document.getElementById('scEmoji')?.value?.trim() || '⭐';
    const calories = parseInt(document.getElementById('scCalories')?.value) || null;
    const meal = document.getElementById('scMeal')?.value || 'snack';
    State.addQuickShortcut({ label, emoji, calories, meal });
    openManageShortcuts();
  }

  function deleteShortcut(id) {
    State.deleteQuickShortcut(id);
    openManageShortcuts();
  }

  // ═══════════════════════════════════════════════════════════
  // TAG MANAGER — rename, recolor, scope to project, delete
  // ═══════════════════════════════════════════════════════════
  function openManageTags() {
    const tags = State.getAllTags();
    const projects = State.getProjects();
    showModal('Manage Tags', `
      <p class="text-xs text-muted" style="margin-bottom:var(--space-3);">
        Click a swatch to cycle colors. Scope a tag to a project and it's only suggested there. Renames and deletes apply to every entry using the tag.
      </p>
      <div id="tagManageList">
        ${tags.length === 0 ? '<p class="text-xs text-faint">No tags yet — create them while editing an entry.</p>' : tags.map(t => `
          <div class="tag-row">
            <div class="tag-color-swatch" style="background:var(--hl-${t.color})" title="Cycle color" onclick="App.cycleTagColor('${t.id}')"></div>
            <input type="text" class="form-input" value="${t.name}" onchange="App.renameTag('${t.id}', this.value)" aria-label="Tag name">
            <select class="form-select" onchange="App.setTagProject('${t.id}', this.value || null)" aria-label="Tag scope">
              <option value="">Global</option>
              ${projects.map(p => `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}
            </select>
            <span class="tag-usage" title="Entries using this tag">×${State.tagUsageCount(t.id)}</span>
            <button class="icon-btn" onclick="App.deleteTagPrompt('${t.id}')" aria-label="Delete tag">${icon('trash-2', 14)}</button>
          </div>`).join('')}
      </div>
      <div class="divider"></div>
      <div style="display:flex;gap:var(--space-2);">
        <input type="text" class="form-input" id="newTagName" placeholder="New tag name" style="flex:1;"
          onkeydown="if(event.key==='Enter'){App.createTagFromManager();}">
        <button class="btn btn-primary" onclick="App.createTagFromManager()">${icon('plus', 14)}Add</button>
      </div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal();App.render()">Done</button>`,
    ]);
  }

  function cycleTagColor(id) {
    const tag = State.getAllTags().find(t => t.id === id);
    if (!tag) return;
    const colors = State.TAG_COLORS;
    const next = colors[(colors.indexOf(tag.color) + 1) % colors.length];
    State.updateTag(id, { color: next });
    openManageTags();
  }

  function renameTag(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) { openManageTags(); return; }
    State.updateTag(id, { name: trimmed });
  }

  function setTagProject(id, projectId) {
    State.updateTag(id, { projectId: projectId || null });
  }

  function deleteTagPrompt(id) {
    const used = State.tagUsageCount(id);
    const tag = State.getAllTags().find(t => t.id === id);
    if (!tag) return;
    if (!confirm(`Delete #${tag.name}?${used > 0 ? ` It will be removed from ${used} entr${used === 1 ? 'y' : 'ies'}.` : ''}`)) return;
    State.deleteTag(id);
    openManageTags();
  }

  function createTagFromManager() {
    const el = document.getElementById('newTagName');
    const name = el?.value?.trim();
    if (!name) return;
    State.getOrCreateTag(name);
    openManageTags();
  }

  // ═══════════════════════════════════════════════════════════
  // SEARCH — fuzzy find projects, tasks, habits, goals
  // ═══════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════
  // TOOLS — small utilities & decision makers
  // ═══════════════════════════════════════════════════════════
  const toolResults = {};
  let toolListText = '';

  const NAME_ADJ = ['brisk', 'quantum', 'mellow', 'crimson', 'turbo', 'lunar', 'feral', 'cosmic', 'rusty', 'neon',
    'silent', 'mighty', 'hollow', 'swift', 'amber', 'wild', 'patient', 'electric', 'foggy', 'golden',
    'iron', 'jolly', 'keen', 'nimble', 'velvet', 'zesty'];
  const NAME_NOUN = ['otter', 'falcon', 'badger', 'comet', 'harbor', 'thicket', 'ember', 'summit', 'walrus', 'prism',
    'canyon', 'beacon', 'mango', 'tundra', 'zephyr', 'anchor', 'bramble', 'cinder', 'dynamo', 'fjord',
    'gecko', 'lantern', 'meadow', 'nebula'];

  function renderTools() {
    const r = toolResults;
    return `
      <div class="page-header">
        <div>
          <h1 class="page-title">Tools</h1>
          <p class="page-subtitle">Tiny utilities and tie-breakers</p>
        </div>
      </div>
      <div class="grid-2 section" style="align-items:start;">
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('circle-dollar-sign', 14)} Coin Flip</span></div>
          <div class="tool-result ${r.coin ? 'live' : ''}" id="toolCoinOut">${r.coin || '—'}</div>
          <button class="btn btn-primary" onclick="App.toolCoin()">${icon('rotate-cw', 14)}Flip</button>
        </div>
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('dices', 14)} Dice</span></div>
          <div class="tool-result ${r.dice ? 'live' : ''}" id="toolDiceOut">${r.dice || '—'}</div>
          <div style="display:flex;gap:var(--space-2);justify-content:center;">
            ${[4, 6, 12, 20, 100].map(n => `<button class="btn btn-secondary btn-sm" onclick="App.toolDice(${n})">d${n}</button>`).join('')}
          </div>
        </div>
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('list-checks', 14)} Pick From List</span></div>
          <textarea class="form-textarea" id="toolListInput" rows="5" placeholder="One option per line…"
            oninput="App.toolListChanged(this.value)">${escHtml(toolListText)}</textarea>
          <div class="tool-result ${r.pick ? 'live' : ''}" id="toolPickOut">${r.pick ? escHtml(r.pick) : '—'}</div>
          <button class="btn btn-primary" onclick="App.toolPick()">${icon('shuffle', 14)}Pick one</button>
        </div>
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('github', 14)} Repo Name</span></div>
          <div class="tool-result ${r.name ? 'live' : ''}" id="toolNameOut">${r.name || '—'}</div>
          <div style="display:flex;gap:var(--space-2);justify-content:center;">
            <button class="btn btn-primary" onclick="App.toolName()">${icon('sparkles', 14)}Generate</button>
            <button class="btn btn-secondary" onclick="App.toolCopy('name')">${icon('copy', 14)}Copy</button>
          </div>
        </div>
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('hash', 14)} Random Number</span></div>
          <div class="grid-2">
            <input type="number" class="form-input" id="toolRandMin" value="${r.randMin ?? 1}" placeholder="min">
            <input type="number" class="form-input" id="toolRandMax" value="${r.randMax ?? 100}" placeholder="max">
          </div>
          <div class="tool-result ${r.rand != null ? 'live' : ''}" id="toolRandOut">${r.rand ?? '—'}</div>
          <button class="btn btn-primary" onclick="App.toolRandom()">${icon('shuffle', 14)}Roll</button>
        </div>
        <div class="card tool-card">
          <div class="section-header"><span class="section-title">${icon('fingerprint', 14)} UUID</span></div>
          <div class="tool-result mono-sm ${r.uuid ? 'live' : ''}" id="toolUuidOut">${r.uuid || '—'}</div>
          <div style="display:flex;gap:var(--space-2);justify-content:center;">
            <button class="btn btn-primary" onclick="App.toolUuid()">${icon('sparkles', 14)}Generate</button>
            <button class="btn btn-secondary" onclick="App.toolCopy('uuid')">${icon('copy', 14)}Copy</button>
          </div>
        </div>
      </div>`;
  }

  // Slot-machine settle: the result element rapid-cycles candidate values,
  // decelerating until the real answer lands with a little pop. A fresh
  // click supersedes any spin already in flight.
  let spinToken = 0;
  function spinResult(elId, sample, finalText, store) {
    // Settling patches the element IN PLACE — a full render() here made
    // the whole page rebuild (and visibly jump) just as the answer landed.
    const finish = () => {
      store();
      const node = document.getElementById(elId);
      if (!node) return;
      node.textContent = finalText;
      node.classList.remove('spinning', 'settled');
      node.classList.add('live');
      void node.offsetWidth; // restart the pop animation
      node.classList.add('settled');
    };
    const el = document.getElementById(elId);
    if (!el || State.getSettings().celebrations === false) { finish(); return; }
    const token = ++spinToken;
    el.classList.remove('settled');
    el.classList.add('spinning');
    const t0 = performance.now();
    const DURATION = 900;
    let lastFlip = -Infinity;
    const step = (now) => {
      if (token !== spinToken) return; // superseded by a newer spin
      const t = (now - t0) / DURATION;
      if (t >= 1 || !document.getElementById(elId)) { finish(); return; }
      // flips start ~50ms apart and stretch to ~300ms — the deceleration
      if (now - lastFlip >= 50 + 250 * t * t) {
        lastFlip = now;
        el.textContent = sample();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function toolCoin() {
    const final = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
    spinResult('toolCoinOut', () => (Math.random() < 0.5 ? 'HEADS' : 'TAILS'), final, () => { toolResults.coin = final; });
  }
  function toolDice(n) {
    const final = `d${n} → ${1 + Math.floor(Math.random() * n)}`;
    spinResult('toolDiceOut', () => `d${n} → ${1 + Math.floor(Math.random() * n)}`, final, () => { toolResults.dice = final; });
  }
  function toolListChanged(v) { toolListText = v; }
  function toolPick() {
    const lines = toolListText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast('Add some options first'); return; }
    const final = lines[Math.floor(Math.random() * lines.length)];
    const sample = lines.length < 2 ? null : () => lines[Math.floor(Math.random() * lines.length)];
    if (!sample) { spinResult('toolPickOut', () => final, final, () => { toolResults.pick = final; }); return; }
    spinResult('toolPickOut', sample, final, () => { toolResults.pick = final; });
  }
  const randomName = () => `${NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)]}-${NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)]}`;
  function toolName() {
    const final = randomName();
    spinResult('toolNameOut', randomName, final, () => { toolResults.name = final; });
  }
  function toolRandom() {
    const min = parseInt(document.getElementById('toolRandMin')?.value) || 0;
    const max = Math.max(parseInt(document.getElementById('toolRandMax')?.value) || 100, min);
    toolResults.randMin = min; toolResults.randMax = max;
    const roll = () => min + Math.floor(Math.random() * (max - min + 1));
    const final = roll();
    spinResult('toolRandOut', () => String(roll()), String(final), () => { toolResults.rand = final; });
  }
  const randomUuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));
  function toolUuid() {
    const final = randomUuid();
    spinResult('toolUuidOut', randomUuid, final, () => { toolResults.uuid = final; });
  }
  async function toolCopy(key) {
    const v = toolResults[key];
    if (!v) return;
    try { await navigator.clipboard.writeText(v); toast('Copied'); }
    catch (e) { toast('Copy failed'); }
  }

  // ═══════════════════════════════════════════════════════════
  // SCRATCHPAD — braindump now, promote to tasks later
  // ═══════════════════════════════════════════════════════════
  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function renderScratch() {
    const ideas = State.getScratch();
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Scratchpad</h1>
          <p class="page-subtitle">Ideas in, tasks out · Ctrl+L clears everything</p>
        </div>
        ${ideas.length ? `<button class="btn btn-secondary btn-sm" onclick="App.clearScratchAll()" title="Clear all ideas (Ctrl+L)">${icon('eraser', 14)}Clear all</button>` : ''}
      </div>
      <div class="section">
        <div class="card scratch-input-card">
          <textarea class="form-input input-grow" id="scratchInput" rows="1" autocomplete="off"
            placeholder="Braindump… Enter captures, Shift+Enter new line. #tags, dates and /project survive the trip to task."
            oninput="App.scratchInputChanged(this)"
            onkeydown="App.scratchKeydown(event)"></textarea>
          <div class="scratch-ac" id="scratchAc" style="display:none;"></div>
        </div>
      </div>`;

    if (ideas.length === 0) {
      html += `<div class="empty-state" style="margin-top:var(--space-6);">
        <i data-lucide="lightbulb"></i>
        <p class="empty-state-text">Empty pad. Type anything above — sorting it out is later-you's job.</p>
      </div>`;
      return html;
    }

    html += `<div class="section"><div class="card scratch-list">
      ${ideas.map(s => `
        <div class="scratch-row" data-id="${s.id}">
          <span class="scratch-bullet"></span>
          <div class="scratch-main">
            <div class="scratch-text">${highlightPostTags(s.text)}</div>
            <span class="text-xs text-faint">${timeAgo(s.createdAt)}</span>
          </div>
          <div class="scratch-actions">
            <button class="icon-btn" onclick="App.scratchToTask('${s.id}')" title="Make it a task — parses dates, #tags, @project, !priority" aria-label="Convert to task">${icon('zap', 15)}</button>
            <button class="icon-btn" onclick="App.copyScratchIdea('${s.id}')" title="Copy text" aria-label="Copy">${icon('copy', 15)}</button>
            <button class="icon-btn" onclick="App.deleteScratchIdea('${s.id}')" title="Delete" aria-label="Delete">${icon('trash-2', 15)}</button>
          </div>
        </div>`).join('')}
    </div></div>`;
    return html;
  }

  // /project autocomplete — typing "/wo" offers matching projects; the
  // chosen token routes the idea into that project when promoted to a task
  function scratchInputChanged(el) {
    autoGrow(el);
    const ac = document.getElementById('scratchAc');
    if (!ac) return;
    const m = /(^|\s)\/([\w-]*)$/.exec(el.value);
    if (!m) { ac.style.display = 'none'; ac.innerHTML = ''; return; }
    const q = m[2].toLowerCase();
    const matches = State.getProjects().filter(p => p.name.toLowerCase().includes(q)).slice(0, 6);
    if (matches.length === 0) { ac.style.display = 'none'; ac.innerHTML = ''; return; }
    ac.style.display = 'flex';
    ac.innerHTML = matches.map((p, i) => `
      <button class="scratch-ac-item ${i === 0 ? 'active' : ''}" onclick="App.scratchAcPick('${p.id}')">
        <span class="proj-dot" style="background:${p.color}"></span>${escHtml(p.name)}
      </button>`).join('');
  }

  function scratchAcPick(id) {
    const p = State.getProject(id);
    const el = document.getElementById('scratchInput');
    if (!p || !el) return;
    const token = p.name.includes(' ') ? `/"${p.name}" ` : `/${p.name} `;
    el.value = el.value.replace(/(^|\s)\/([\w-]*)$/, `$1${token}`);
    const ac = document.getElementById('scratchAc');
    if (ac) { ac.style.display = 'none'; ac.innerHTML = ''; }
    el.focus();
    autoGrow(el);
  }

  function scratchKeydown(e) {
    const ac = document.getElementById('scratchAc');
    const acOpen = ac && ac.style.display !== 'none';
    if (e.key === 'Tab' && acOpen) {
      e.preventDefault();
      ac.querySelector('.scratch-ac-item')?.click();
      return;
    }
    if (e.key === 'Escape' && acOpen) { ac.style.display = 'none'; return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (acOpen) { ac.querySelector('.scratch-ac-item')?.click(); return; }
      addScratchIdea();
    }
  }

  function addScratchIdea() {
    const el = document.getElementById('scratchInput');
    const text = el?.value?.trim();
    if (!text) return;
    State.addScratch(text);
    render();
    // keep the flow going — focus straight back into the input
    setTimeout(() => document.getElementById('scratchInput')?.focus(), 50);
  }

  function scratchToTask(id) {
    const idea = State.getScratch().find(s => s.id === id);
    if (!idea) return;
    if (typeof Palette !== 'undefined') {
      const r = Palette.createFromText(idea.text, { forceType: 'task' });
      if (r) {
        State.deleteScratch(id);
        toast(`Task created${r.summary ? ' — ' + r.summary : ''}`);
        render();
        return;
      }
    }
    State.createEntry({ type: 'task', title: idea.text });
    State.deleteScratch(id);
    toast('Task created');
    render();
  }

  async function copyScratchIdea(id) {
    const idea = State.getScratch().find(s => s.id === id);
    if (!idea) return;
    try {
      await navigator.clipboard.writeText(idea.text);
      toast('Copied');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = idea.text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e2) { toast('Copy failed'); }
      ta.remove();
    }
  }

  function deleteScratchIdea(id) {
    undoable('Deleted a scratch idea', () => State.deleteScratch(id));
    render();
  }

  function clearScratchAll() {
    let n = 0;
    undoable('Cleared the scratchpad', () => { n = State.clearScratch(); }, { quiet: !0 });
    if (!n) { toast('Scratchpad already empty'); return; }
    toast(`Cleared ${n} idea${n === 1 ? '' : 's'}`, { undo: true });
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // DAILY REVIEW — one-tap triage of everything that slipped
  // ═══════════════════════════════════════════════════════════
  // The Today button's badge counts overdue work IN SCOPE, so the modal it
  // opens has to work on that same set — otherwise a badge reading "3" for
  // one workspace opens a triage list spanning all of them.
  function reviewPool() {
    const today = State.todayStr();
    return scopedEntries()
      .filter(e => (e.type === 'task' || e.type === 'reminder') && !e.completed && e.dueDate && e.dueDate < today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  function openDailyReview() {
    const scopeNote = (activeWorkspace !== WS_ALL || activeSubproject)
      ? ` — ${scopeLabel()}` : '';
    showModal('Daily Review' + scopeNote, `
      <p class="text-xs text-muted" style="margin-bottom:var(--space-3);">
        Everything overdue, one decision each: reschedule it, park it, finish it, or let it go.
      </p>
      <div id="reviewList"></div>
    `, [`<button class="btn btn-secondary" onclick="App.closeModal()">Done reviewing</button>`]);
    renderReviewList();
  }

  function renderReviewList() {
    const el = document.getElementById('reviewList');
    if (!el) return;
    const pool = reviewPool();
    if (pool.length === 0) {
      el.innerHTML = `<div class="empty-state">
        <i data-lucide="party-popper"></i>
        <p class="empty-state-text">Nothing overdue. Clean slate.</p>
      </div>`;
      refreshIcons();
      return;
    }
    const acts = [
      ['today', 'calendar-check', 'Do today'],
      ['tomorrow', 'sunrise', 'Tomorrow'],
      ['nextweek', 'calendar-plus', 'Next week'],
      ['someday', 'circle-dashed', 'Someday (clear date)'],
      ['done', 'check', 'Mark done'],
      ['drop', 'trash-2', 'Drop it'],
    ];
    el.innerHTML = `
      <p class="text-xs text-faint" style="margin-bottom:var(--space-2);">${pool.length} overdue item${pool.length === 1 ? '' : 's'}</p>
      ${pool.map(e => {
        const proj = e.projectId ? State.getProject(e.projectId) : null;
        return `<div class="review-row" data-id="${e.id}">
          <span class="proj-dot" style="background:${proj?.color || 'var(--text-faint)'}"></span>
          <div class="review-main">
            <span class="review-title">${escHtml(e.title)}</span>
            <span class="text-xs" style="color:var(--error);">${formatDueDate(e.dueDate)}</span>
          </div>
          <div class="review-actions">
            ${acts.map(([a, ic, label]) => `
              <button class="icon-btn ${a === 'drop' ? 'review-drop' : ''}" onclick="App.reviewAction('${e.id}','${a}')" title="${label}" aria-label="${label}">${icon(ic, 14)}</button>`).join('')}
          </div>
        </div>`;
      }).join('')}`;
    refreshIcons();
  }

  function reviewAction(id, action) {
    const entry = State.getEntry(id);
    if (!entry) return;
    switch (action) {
      case 'today': State.updateEntry(id, { dueDate: State.todayStr() }); break;
      case 'tomorrow': State.updateEntry(id, { dueDate: offsetDateStr(1) }); break;
      case 'nextweek': State.updateEntry(id, { dueDate: offsetDateStr(7) }); break;
      case 'someday': State.updateEntry(id, { dueDate: null }); break;
      // Through toggleEntry, not State directly: that is where the Cade.txt
      // write-through lives, and a checkbox ticked here must reach the room
      // like any other completion.
      case 'done': toggleEntry(id); break;
      case 'drop': State.deleteEntry(id); break;
    }
    render();
    renderReviewList();
    if (reviewPool().length === 0 && action !== 'drop') celebrate(40);
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-PLAN — estimates + scores + free planner slots = a day plan
  // ═══════════════════════════════════════════════════════════
  let pendingPlan = [];

  function autoPlanDefaults() {
    const today = State.todayStr();
    const wake = State.getLogs({ type: 'wake', date: today })[0];
    const sleep = State.getLogs({ type: 'sleep', date: today })[0];
    return {
      startMin: Math.max(
        wake?.time ? timeToMin(wake.time) : 8 * 60,
        Math.ceil(timeToMin(nowTime()) / 15) * 15
      ),
      endMin: sleep?.time ? timeToMin(sleep.time) : 22 * 60,
    };
  }

  // The tasks auto-plan would consider, in the order it would consider them.
  function computeAutoPlanCandidates(opts = {}) {
    const today = State.todayStr();
    return State.getEntries({ type: 'task', completed: false, projectId: opts.projectId || undefined })
      .filter(t => !isBlocked(t) && (!t.dueDate || t.dueDate <= today || t.scheduledDate === today))
      .sort((a, b) => {
        const aDue = a.dueDate ? 0 : 1, bDue = b.dueDate ? 0 : 1;
        return aDue - bDue || taskScore(b) - taskScore(a);
      });
  }

  function computeAutoPlan(opts = {}) {
    const today = State.todayStr();
    const d = autoPlanDefaults();
    const winStart = opts.startMin ?? d.startMin;
    const winEnd = opts.endMin ?? d.endMin;
    if (winStart >= winEnd) return [];
    const gap = opts.breaks ? 10 : 0; // breathing room between blocks

    // free slots = window minus existing blocks (merged)
    const busy = State.getPlannerBlocks({ date: today })
      .map(b => [timeToMin(b.start), timeToMin(b.end)])
      .sort((a, b) => a[0] - b[0]);
    const free = [];
    let cursor = winStart;
    busy.forEach(([s, e]) => {
      if (e <= cursor) return;
      if (s > cursor) free.push([cursor, Math.min(s, winEnd)]);
      cursor = Math.max(cursor, e);
    });
    if (cursor < winEnd) free.push([cursor, winEnd]);

    // candidates: unblocked open tasks due (or overdue) today first,
    // then undated ones — best score first, optionally project-scoped
    const cands = computeAutoPlanCandidates(opts);

    const sizeOf = (t) => Math.min(Math.max(Math.ceil((t.estimateMinutes || 30) / 15) * 15, 15), 120);
    const place = (task, dur) => {
      const slot = free.find(([s, e]) => e - s >= dur);
      if (!slot) return false;
      plan.push({ task, start: slot[0], end: slot[0] + dur });
      slot[0] += dur + gap;
      return true;
    };

    const plan = [];
    if (opts.mode === 'interleave') {
      // rotate 30-minute chunks across tasks — progress on several fronts
      const queue = cands.slice(0, 6).map(t => ({ t, left: sizeOf(t) }));
      let guard = 0;
      while (queue.some(q => q.left > 0) && plan.length < 12 && guard++ < 40) {
        let placedAny = false;
        for (const q of queue) {
          if (q.left <= 0 || plan.length >= 12) continue;
          const chunk = Math.min(30, q.left);
          if (place(q.t, chunk)) { q.left -= chunk; placedAny = true; }
          else q.left = 0; // no slot fits — stop trying this task
        }
        if (!placedAny) break;
      }
    } else {
      // deep focus: one uninterrupted block per task, until done
      for (const t of cands) {
        if (plan.length >= 8) break;
        place(t, sizeOf(t));
      }
    }
    return plan;
  }

  function readAutoPlanOpts() {
    return {
      projectId: document.getElementById('apProject')?.value || null,
      startMin: timeToMin(document.getElementById('apStart')?.value || minToTime(autoPlanDefaults().startMin)),
      endMin: timeToMin(document.getElementById('apEnd')?.value || minToTime(autoPlanDefaults().endMin)),
      breaks: !!document.getElementById('apBreaks')?.checked,
      mode: document.getElementById('apMode')?.value || 'deep',
    };
  }

  function renderAutoPlanPreview() {
    const el = document.getElementById('autoplanPreview');
    if (!el) return;
    pendingPlan = computeAutoPlan(readAutoPlanOpts());
    if (pendingPlan.length === 0) {
      el.innerHTML = `<p class="text-xs text-faint" style="padding:var(--space-3) 0;">Nothing fits — widen the window, switch project, or add estimates to open tasks.</p>`;
      const btn = document.getElementById('apConfirm');
      if (btn) btn.disabled = true;
      return;
    }
    const total = pendingPlan.reduce((s, p) => s + (p.end - p.start), 0);
    // What the day had no room for. Silently dropping it made auto-plan look
    // like it had considered less than it had.
    const planned = new Set(pendingPlan.map(p => p.task.id));
    const left = computeAutoPlanCandidates(readAutoPlanOpts()).filter(t => !planned.has(t.id));
    el.innerHTML = `
      <div class="autoplan-list">
        ${pendingPlan.map(p => {
          const proj = p.task.projectId ? State.getProject(p.task.projectId) : null;
          return `<div class="autoplan-row">
            <span class="font-mono text-xs autoplan-time">${minToTime(p.start)}–${minToTime(p.end)}</span>
            <span class="proj-dot" style="background:${proj?.color || 'var(--accent)'}"></span>
            <span class="truncate" style="flex:1;">${escHtml(p.task.title)}</span>
            <span class="pill">${estimateLabel(p.end - p.start)}</span>
          </div>`;
        }).join('')}
      </div>
      <p class="text-xs text-faint" style="margin-top:var(--space-2);">${pendingPlan.length} block${pendingPlan.length === 1 ? '' : 's'} · ${estimateLabel(total)} planned</p>
      ${left.length ? `<p class="text-xs" style="color:var(--hl-orange);line-height:1.6;margin-top:var(--space-1);">
        ${left.length} didn’t fit: ${left.slice(0, 4).map(t => escHtml(t.title)).join(', ')}${left.length > 4 ? `, and ${left.length - 4} more` : ''}.
      </p>` : ''}`;
    const btn = document.getElementById('apConfirm');
    if (btn) btn.disabled = false;
  }

  function openAutoPlan() {
    const d = autoPlanDefaults();
    const projects = State.getProjects();
    showModal('Auto-plan today', `
      <p class="text-xs text-muted" style="margin-bottom:var(--space-3);">
        Top tasks slotted into free time by score and estimate. Blocks stay draggable in the planner.
      </p>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Project</label>
          <select class="form-select" id="apProject" onchange="App.renderAutoPlanPreview()">
            <option value="">All projects</option>
            ${projects.map(p => `<option value="${p.id}">${'– '.repeat(p.depth || 0)}${escHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Style</label>
          <select class="form-select" id="apMode" onchange="App.renderAutoPlanPreview()">
            <option value="deep">Deep focus — finish one task at a time</option>
            <option value="interleave">Mix it up — rotate 30m chunks</option>
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Start</label>
          <input type="time" class="form-input" id="apStart" value="${minToTime(d.startMin)}" onchange="App.renderAutoPlanPreview()">
        </div>
        <div class="form-group">
          <label class="form-label">End</label>
          <input type="time" class="form-input" id="apEnd" value="${minToTime(Math.max(d.endMin, d.startMin + 15))}" onchange="App.renderAutoPlanPreview()">
        </div>
      </div>
      <label class="form-label" style="display:flex;align-items:center;gap:var(--space-2);cursor:pointer;margin-bottom:var(--space-2);">
        <input type="checkbox" id="apBreaks" onchange="App.renderAutoPlanPreview()"> 10-minute breaks between blocks
      </label>
      <div id="autoplanPreview"></div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" id="apConfirm" onclick="App.confirmAutoPlan()">${icon('calendar-check', 14)}Add to planner</button>`,
    ]);
    renderAutoPlanPreview();
  }

  function confirmAutoPlan() {
    if (pendingPlan.length === 0) return;
    const today = State.todayStr();
    pendingPlan.forEach(p => {
      const proj = p.task.projectId ? State.getProject(p.task.projectId) : null;
      State.createPlannerBlock({
        date: today,
        start: minToTime(p.start),
        end: minToTime(p.end),
        title: p.task.title,
        entryId: p.task.id,
        projectId: p.task.projectId || null,
        color: proj?.color || null,
        kind: 'agenda',
      });
    });
    toast(`${pendingPlan.length} block${pendingPlan.length === 1 ? '' : 's'} added to today`);
    pendingPlan = [];
    closeModal();
    switchTab('planner');
  }

  // ═══════════════════════════════════════════════════════════
  // PASTE IMPORT — the reverse of "Copy for LLM"
  // Paste a plan (markdown list, plain lines, or exported JSON) and
  // every line goes through the natural-language parser.
  // ═══════════════════════════════════════════════════════════
  function parsePasteText(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    if (/^[\[{]/.test(trimmed)) {
      try {
        const j = JSON.parse(trimmed);
        const arr = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : null);
        if (arr) {
          return arr.map(x => (typeof x === 'string' ? { raw: x } : (x && x.title ? { obj: x } : null))).filter(Boolean);
        }
      } catch (err) { /* not JSON — fall through to line parsing */ }
    }
    // Line parsing. Three things the old version threw away and shouldn't:
    //   • a ticked "[x]" box means the task is already done
    //   • indentation, and markdown headings, name the group a run belongs to
    //   • "— due Friday" trailing clauses are dates, not part of the title
    const out = [];
    let heading = null;         // last "## Kitchen" seen
    const indentGroup = [];     // group name by indent depth
    let inFence = false;

    trimmed.split('\n').forEach(line => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      if (!line.trim()) return;

      const h = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) { heading = h[1].trim() || null; indentGroup.length = 0; return; }

      const bullet = line.match(/^(\s*)(?:[-*+]\s*(\[[ xX]\]\s*)?|\d+[.)]\s*)?(.*)$/);
      const indent = bullet ? bullet[1].replace(/\t/g, '  ').length : 0;
      const box = bullet ? bullet[2] : null;
      let body = (bullet ? bullet[3] : line).trim();
      if (!body) return;

      // Trailing "— due friday" / "- due 2026-01-02" clauses fold into the
      // text the quick-add parser reads, so it can pick the date out.
      body = body.replace(/\s*[—–-]{1,2}\s*(due\s+.+)$/i, ' $1');

      const depth = Math.floor(indent / 2);
      // A line with children names them: remember it at this depth.
      indentGroup.length = depth;
      const group = depth > 0 ? (indentGroup[depth - 1] || heading) : heading;
      indentGroup[depth] = body.replace(/\s+[!#@~*].*$/, '').trim();

      out.push({ raw: body, done: !!(box && /[xX]/.test(box)), group: group || null });
    });
    return out;
  }

  function pasteDefaultProject() {
    const focus = focusedProjectId();
    return focus && focus !== 'none' ? focus : null;
  }

  function openPasteImport() {
    const proj = pasteDefaultProject() ? State.getProject(pasteDefaultProject()) : null;
    showModal('Paste Tasks', `
      <p class="text-xs text-muted" style="margin-bottom:var(--space-2);">
        One item per line. Lines speak the quick-add shorthand
        (<span class="font-mono">tomorrow 3pm #tag @project !high ~30m *xl every week</span>),
        a ticked <span class="font-mono">[x]</span> box imports as already done, and the
        "Copy for LLM" JSON pastes straight back in.
        ${proj ? `New tasks land in <strong>${escHtml(proj.name)}</strong> unless a line says otherwise.` : ''}
      </p>
      <label class="form-check" style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2);">
        <input type="checkbox" id="pasteGroups" checked onchange="App.previewPasteImport()">
        <span class="text-xs">Turn headings and indented groups into sub-projects</span>
      </label>
      <textarea class="form-input" id="pasteInput" rows="9" spellcheck="false"
        placeholder="- [ ] Fix header overflow #bugs !high&#10;- Write release notes tomorrow ~30m&#10;- Call the vendor friday 10am"
        oninput="App.previewPasteImport()"></textarea>
      <div id="pastePreview" class="paste-preview"></div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" id="pasteImportBtn" onclick="App.runPasteImport()">${icon('clipboard-paste', 14)}Import</button>`,
    ]);
    setTimeout(() => document.getElementById('pasteInput')?.focus(), 100);
  }

  function previewPasteImport() {
    const el = document.getElementById('pastePreview');
    if (!el) return;
    const items = parsePasteText(document.getElementById('pasteInput')?.value);
    if (items.length === 0) { el.innerHTML = ''; return; }
    const rows = items.slice(0, 6).map(it => {
      if (it.obj) return `<div class="paste-row">${icon('braces', 12)}<span class="truncate">${it.obj.title}</span></div>`;
      const p = Palette.parse(it.raw);
      const bits = [];
      if (p.type !== 'task') bits.push(p.type);
      if (p.dueDate) bits.push(formatDueDate(p.dueDate));
      if (p.remindTime) bits.push(p.remindTime);
      if (p.priority) bits.push(p.priority);
      if (p.estimateMinutes) bits.push('~' + estimateLabel(p.estimateMinutes));
      if (p.effort) bits.push(p.effort);
      if (p.recurrence) bits.push('repeats');
      p.tags.forEach(t => bits.push('#' + t));
      if (p.projectName) bits.push('@' + p.projectName);
      if (it.done) bits.push('done');
      const groups = !!document.getElementById('pasteGroups')?.checked;
      if (groups && it.group) bits.push('in ' + it.group);
      return `<div class="paste-row">${icon(it.done ? 'check' : 'corner-down-right', 12)}<span class="truncate">${escHtml(p.title || '(untitled)')}</span>
        ${bits.length ? `<span class="text-xs text-faint paste-bits">${escHtml(bits.join(' · '))}</span>` : ''}</div>`;
    }).join('');
    el.innerHTML = `<p class="text-xs text-faint" style="margin:var(--space-2) 0 var(--space-1);">${items.length} item${items.length === 1 ? '' : 's'} detected${items.length > 6 ? ' — showing first 6' : ''}</p>${rows}`;
    refreshIcons();
  }

  function runPasteImport() {
    const items = parsePasteText(document.getElementById('pasteInput')?.value);
    if (items.length === 0) { toast('Nothing to import'); return; }
    State.checkpoint('Pasted ' + items.length + ' item' + (items.length === 1 ? '' : 's'));
    const defaultProjectId = pasteDefaultProject();
    const makeGroups = !!document.getElementById('pasteGroups')?.checked;
    // A heading or an indent parent becomes a sub-project, created once and
    // reused, so pasting a structured note keeps its structure.
    const groupIds = new Map();
    const groupProject = (name) => {
      if (!name || !makeGroups) return defaultProjectId;
      const key = name.toLowerCase();
      if (groupIds.has(key)) return groupIds.get(key);
      const existing = State.getProjects({ includeArchived: true })
        .find(p => p.name.toLowerCase() === key);
      const id = existing ? existing.id
        : State.createProject({ name, parentId: defaultProjectId || null }).id;
      groupIds.set(key, id);
      return id;
    };

    let n = 0;
    items.forEach(it => {
      if (it.raw) {
        const pid = groupProject(it.group);
        const made = Palette.createFromText(it.raw, { defaultProjectId: pid });
        if (made) {
          n++;
          // "[x] thing" is a record of something already finished.
          if (it.done) State.updateEntry(made.entry.id, { completed: true, completedAt: new Date().toISOString() });
        }
      } else if (it.obj) {
        const o = it.obj;
        (o.tags || []).forEach(t => State.getOrCreateTag(t));
        const pid = defaultProjectId;
        State.createEntry({
          type: ['task', 'habit', 'goal', 'reminder', 'note'].includes(o.type) ? o.type : 'task',
          title: String(o.title),
          description: o.description || '',
          tags: Array.isArray(o.tags) ? o.tags : [],
          priority: ['low', 'medium', 'high', 'urgent'].includes(o.priority) ? o.priority : 'medium',
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(o.due_date || '') ? o.due_date : null,
          remindTime: /^\d{2}:\d{2}$/.test(o.remind_time || '') ? o.remind_time : null,
          estimateMinutes: Number(o.estimate_minutes) > 0 ? Number(o.estimate_minutes) : null,
          projectId: pid,
          projectIds: pid ? [pid] : [],
        });
        n++;
      }
    });
    const groups = groupIds.size;
    toast(`Imported ${n} item${n === 1 ? '' : 's'}${groups ? ` into ${groups} sub-project${groups === 1 ? '' : 's'}` : ''}`, { undo: true });
    closeModal();
    render();
  }

  // Command palette is the primary search surface; the modal search
  // below stays as a fallback (and for anything still calling it).
  function openPalette() {
    if (typeof Palette !== 'undefined') Palette.open();
    else openSearch();
  }

  function openSearch() {
    showModal('Search', `
      <input type="search" class="form-input" id="searchInput" placeholder="Search, or filter: is:overdue project:kitchen tag:errand"
        autocomplete="off" oninput="App.runSearch(this.value)"
        onkeydown="if(event.key==='Enter'){document.querySelector('.search-result')?.click();}">
      <p class="text-xs text-faint search-hint" id="searchHint" style="display:none;"></p>
      <details class="search-ops">
        <summary class="text-xs text-faint">Operators</summary>
        <p class="text-xs text-faint" style="line-height:1.7;margin:var(--space-2) 0 0;">
          <span class="font-mono">is:</span> open · done · overdue · today · blocked · pinned · untagged · unfiled · bridged · archived<br>
          <span class="font-mono">due:</span> today · tomorrow · week · month · overdue · none · any<br>
          <span class="font-mono">project:</span>name &nbsp; <span class="font-mono">tag:</span>name &nbsp;
          <span class="font-mono">type:</span>task|habit|goal &nbsp; <span class="font-mono">p:</span>urgent|high|medium|low
        </p>
      </details>
      <div class="search-results" id="searchResults"></div>
    `, []);
    setTimeout(() => document.getElementById('searchInput')?.focus(), 100);
    runSearch('');
  }

  // Substring match scores highest; otherwise in-order subsequence match.
  function fuzzyScore(q, text) {
    const t = (text || '').toLowerCase();
    if (!q) return 0;
    const idx = t.indexOf(q);
    if (idx >= 0) return 200 - idx * 2 - Math.min(t.length - q.length, 40);
    let ti = 0, score = 0, streak = 0;
    for (const ch of q) {
      if (ch === ' ') continue;
      const found = t.indexOf(ch, ti);
      if (found === -1) return -1;
      streak = found === ti ? streak + 1 : 1;
      score += 4 + streak * 2 - Math.min(found - ti, 10) * 0.5;
      ti = found + 1;
    }
    return score;
  }

  function runSearch(qRaw) {
    const el = document.getElementById('searchResults');
    if (!el) return;
    // Operators first — "is:overdue project:kitchen" narrows the set, and
    // whatever is left over is the text the fuzzy matcher works on.
    const parsed = typeof Palette !== 'undefined' && Palette.parseQuery
      ? Palette.parseQuery(qRaw) : { text: qRaw || '', filters: { active: false } };
    const q = parsed.text.trim().toLowerCase();
    const filters = parsed.filters;
    const hint = document.getElementById('searchHint');
    if (hint) {
      const desc = Palette.describeFilters(filters);
      hint.textContent = desc ? 'Filtering: ' + desc : '';
      hint.style.display = desc ? '' : 'none';
    }

    // Inside a project? Its tasks get boosted to the top.
    const ctxFocus = focusedProjectId();
    const ctxProject = (ctxFocus && ctxFocus !== 'none') ? ctxFocus : null;
    const results = [];

    // Operators are about entries; a project row would ignore them, so with
    // filters on we list only what they actually filtered.
    if (!filters.active) {
      State.getProjects().forEach(p => {
        const s = q ? fuzzyScore(q, p.name) : 10;
        if (s >= 0) results.push({ kind: 'project', id: p.id, title: p.name, color: p.color, score: s + 10, context: 'project' });
      });
    }

    const wantArchived = filters.is && filters.is.includes('archived');
    State.getEntries({ includeArchived: wantArchived }).forEach(e => {
      if (!Palette.matchesFilters(e, filters)) return;
      const hay = e.title + ' ' + (e.tags || []).join(' ');
      let s = q ? fuzzyScore(q, hay) : ((filters.active || (e.type === 'task' && !e.completed)) ? 5 : -1);
      if (s < 0) return;
      if (ctxProject && e.projectId === ctxProject) s += 80; // favor current project
      if (e.completed) s -= 20;
      const proj = e.projectId ? State.getProject(e.projectId) : null;
      results.push({
        kind: 'entry', id: e.id, title: e.title, completed: e.completed,
        color: proj?.color, score: s, context: proj ? proj.name : e.type,
        type: e.type,
      });
    });

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 12);

    if (top.length === 0) {
      el.innerHTML = `<p class="text-xs text-faint" style="padding:var(--space-2);">No matches for “${escHtml(qRaw)}”.</p>`;
      return;
    }

    const typeIcons = { project: 'folder-kanban', goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock', checkin: 'brain' };
    el.innerHTML = top.map(r => `
      <button class="search-result" onclick="App.searchGo('${r.kind}','${r.id}')">
        ${icon(typeIcons[r.kind === 'project' ? 'project' : r.type] || 'list-checks', 14)}
        <span class="proj-dot" style="background:${r.color || 'var(--text-faint)'}"></span>
        <span class="sr-title ${r.completed ? 'completed' : ''}">${escHtml(r.title)}</span>
        <span class="sr-context">${escHtml(r.context)}</span>
      </button>
    `).join('');
    refreshIcons();
  }

  function searchGo(kind, id) {
    closeModal();
    if (kind === 'project') {
      // Land on the project's own page, taking its WORKSPACE with it — for a
      // deeply nested project the parent is another sub-project, which would
      // scope the app to the wrong subtree and hide its real siblings.
      revealProject(id);
      switchTab('projects');
    } else {
      editEntry(id);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONFLICT SCREEN
  // ═══════════════════════════════════════════════════════════
  // The old screen said "Entries: +3 only here · 2 differ (Buy milk, …)".
  // That announces a conflict without describing it: not which items, not
  // what changed inside them, and not what any of the three buttons would
  // cost. This one answers those three questions in that order.

  // Presentation only. Sync owns WHICH collections a merge touches; this
  // supplies a label and a way to name a member. Driving the loop from Sync's
  // list rather than a copy of it means a collection added there can never go
  // missing from this screen — it appears under a fallback label instead.
  const CONFLICT_GROUP_META = {
    entries:  { label: 'Tasks, goals & habits', nameOf: e => e.title },
    projects: { label: 'Projects',              nameOf: p => p.name },
    planner:  { label: 'Planner blocks',        nameOf: b => b.title || b.kind },
    scratch:  { label: 'Scratch ideas',         nameOf: s => s.text },
    tags:     { label: 'Tags',                  nameOf: t => t.name },
    logs:     { label: 'Logs',                  nameOf: l => l.type },
  };
  // The order someone would look for them in, most consequential first.
  const CONFLICT_GROUP_ORDER = ['entries', 'projects', 'planner', 'scratch', 'tags', 'logs'];

  function conflictGroups() {
    const merged = (typeof Sync !== 'undefined' && Sync.MERGED_COLLECTIONS) || CONFLICT_GROUP_ORDER;
    const keys = [
      ...CONFLICT_GROUP_ORDER.filter(k => merged.includes(k)),
      ...merged.filter(k => !CONFLICT_GROUP_ORDER.includes(k)),
    ];
    return keys.map(key => ({
      key,
      label: (CONFLICT_GROUP_META[key] || {}).label || key,
      nameOf: (CONFLICT_GROUP_META[key] || {}).nameOf || (x => x.name || x.title || x.id),
    }));
  }

  // Bookkeeping, not a change anyone made on purpose — listing it as a
  // difference buries the ones that mean something.
  const DIFF_SKIP = new Set(['updatedAt']);

  // Fields whose values are ids of other records, shown by name instead.
  const DIFF_ID_FIELDS = new Set([
    'projectId', 'parentId', 'entryId', 'projectIds', 'blockedBy', 'spawnedNextId',
  ]);

  const FIELD_LABELS = {
    completed: 'done', completedAt: 'finished', dueDate: 'due', createdAt: 'created',
    projectId: 'project', projectIds: 'projects', parentId: 'inside', entryId: 'task',
    archived: 'archived', archTs: 'archived on', blockedBy: 'blocked by',
    spawnedNextId: 'next occurrence', txtRoom: 'Cade.txt room', txtKey: 'Cade.txt line',
    txtDone: 'Cade.txt tick', txtWorkspaceId: 'Cade.txt workspace', txtHasList: 'has a todo list',
  };

  function fieldLabel(key) {
    return FIELD_LABELS[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  }

  function diffValue(key, v, names) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.length ? v.map(x => diffValue(key, x, names)).join(', ') : 'none';
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    if (DIFF_ID_FIELDS.has(key) && names.has(s)) return names.get(s);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 16).replace('T', ' ');
    return s.length > 70 ? s.slice(0, 70) + '…' : s;
  }

  // Absent, null and empty-string all mean "nothing here". Comparing them
  // literally listed a field as differing and then printed "—" against "—"
  // on both sides, which reads as a bug in the diff rather than as data. It
  // happens whenever the two sides were written by different app versions:
  // the newer one has migrated in fields the older one never stored.
  function sameValue(a, b) {
    const blank = (v) => v === null || v === undefined || v === '';
    if (blank(a) && blank(b)) return true;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // projectIds is derived from projectId whenever a task belongs to exactly
  // one project, so re-filing one otherwise reports the identical change
  // twice, once as "project" and once as "projects". Only the derived case
  // is suppressed — a genuine multi-project difference still shows.
  function mirrorsPrimaryProject(item) {
    const ids = item && item.projectIds;
    if (!Array.isArray(ids) || ids.length > 1) return false;
    return (ids[0] || null) === ((item && item.projectId) || null);
  }

  function fieldDiffs(a, b) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
    const derived = mirrorsPrimaryProject(a) && mirrorsPrimaryProject(b);
    return keys
      .filter(k => !DIFF_SKIP.has(k) && !(k === 'projectIds' && derived))
      .filter(k => !sameValue(a?.[k], b?.[k]))
      .map(k => ({ key: k, local: a?.[k], server: b?.[k] }));
  }

  // Everything the screen needs, computed once: per-item differences, which
  // side a merge would keep, and the totals each button is priced against.
  function conflictReport(local, server) {
    const l = local || {}, s = server || {};

    // Ids read as noise; a task called "Buy milk" does not. Both sides feed
    // the map — an item that exists on only one side still needs a name.
    const names = new Map();
    [s, l].forEach(side => {
      (side.projects || []).forEach(p => p && p.id && names.set(p.id, p.name || 'Untitled project'));
      (side.entries || []).forEach(e => e && e.id && names.set(e.id, e.title || 'Untitled'));
    });

    const winnerOf = (a, b) => (typeof Sync !== 'undefined' && Sync.mergeWinner)
      ? Sync.mergeWinner(a, b) : 'local';

    const groups = conflictGroups().map(g => {
      const nameOf = (x) => {
        const raw = g.nameOf(x);
        const text = raw == null ? '' : String(raw).trim();
        return text ? (text.length > 70 ? text.slice(0, 70) + '…' : text) : 'Untitled';
      };
      const index = (list) => new Map((Array.isArray(list) ? list : [])
        .filter(x => x && x.id).map(x => [x.id, x]));
      const lm = index(l[g.key]), sm = index(s[g.key]);
      const items = [];
      lm.forEach((mine, id) => {
        if (!sm.has(id)) { items.push({ id, side: 'local', name: nameOf(mine) }); return; }
        const theirs = sm.get(id);
        const fields = fieldDiffs(mine, theirs);
        if (!fields.length) return;   // same content, different key order
        items.push({ id, side: 'both', name: nameOf(mine), fields, wins: winnerOf(mine, theirs) });
      });
      sm.forEach((theirs, id) => {
        if (!lm.has(id)) items.push({ id, side: 'server', name: nameOf(theirs) });
      });
      const count = (side) => items.filter(i => i.side === side).length;
      return { label: g.label, items, localOnly: count('local'), serverOnly: count('server'), both: count('both') };
    }).filter(g => g.items.length);

    const sum = (k) => groups.reduce((n, g) => n + g[k], 0);
    return { groups, names, localOnly: sum('localOnly'), serverOnly: sum('serverOnly'), both: sum('both') };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // What each button costs, in items, from the data actually in front of the
  // user. This is the part that makes the decision possible.
  function conflictChoicesHtml(r) {
    const keepLocal = r.serverOnly || r.both
      ? [r.serverOnly ? `${plural(r.serverOnly, 'item', 'items')} that exist only on the server` : '',
         r.both ? `${plural(r.both, 'edit', 'edits')} made elsewhere` : '']
        .filter(Boolean).join(' and ')
      : '';
    const takeServer = r.localOnly || r.both
      ? [r.localOnly ? `${plural(r.localOnly, 'item', 'items')} that exist only here` : '',
         r.both ? `${plural(r.both, 'edit', 'edits')} made here` : '']
        .filter(Boolean).join(' and ')
      : '';
    const mergeNote = r.both
      ? `Nothing is discarded. ${plural(r.both, 'item', 'items')} edited on both sides resolve to the more recently edited copy — marked below.`
      : 'Nothing is discarded. Both sides keep everything they hold.';

    const choice = (res, name, note, loss, rec) => `
      <button type="button" class="cf-choice${rec ? ' cf-recommended' : ''}" onclick="App.resolveConflict('${res}')">
        <span class="cf-choice-name">${escHtml(name)}${rec ? '<span class="cf-rec">recommended</span>' : ''}</span>
        <span class="cf-choice-note${loss ? ' cf-loss' : ''}">${escHtml(note)}</span>
      </button>`;

    return `<div class="cf-choices">
      ${choice('merge', 'Merge both', mergeNote, false, true)}
      ${choice('local', 'Keep this device',
        keepLocal ? `Permanently discards ${keepLocal}.` : 'Overwrites the server with this device’s copy.',
        !!keepLocal, false)}
      ${choice('server', 'Take the server',
        takeServer ? `Permanently discards ${takeServer}.` : 'Replaces this device with the server’s copy.',
        !!takeServer, false)}
    </div>`;
  }

  const CF_MAX_ITEMS = 25;    // a divergence of hundreds is a scroll, not a read
  const CF_MAX_FIELDS = 6;

  function conflictItemHtml(item, names) {
    const badge = {
      local: '<span class="cf-badge here">only here</span>',
      server: '<span class="cf-badge server">only on server</span>',
      both: '<span class="cf-badge both">edited on both</span>',
    }[item.side];
    const shown = item.side === 'both' ? item.fields.slice(0, CF_MAX_FIELDS) : [];
    const spare = item.side === 'both' ? item.fields.length - shown.length : 0;
    return `<div class="cf-item">
      <div class="cf-item-head">
        ${badge}
        <span class="cf-item-name">${escHtml(item.name)}</span>
        ${item.side === 'both'
          ? `<span class="cf-wins">merge keeps ${item.wins === 'server' ? 'the server’s' : 'this device’s'}</span>`
          : ''}
      </div>
      ${shown.length ? `<div class="cf-fields">
        <div class="cf-field cf-field-head"><span></span><span>this device</span><span>server</span></div>
        ${shown.map(f => `<div class="cf-field">
          <span class="cf-fname">${escHtml(fieldLabel(f.key))}</span>
          <span class="cf-val${item.wins === 'local' ? ' cf-win' : ''}">${escHtml(diffValue(f.key, f.local, names))}</span>
          <span class="cf-val${item.wins === 'server' ? ' cf-win' : ''}">${escHtml(diffValue(f.key, f.server, names))}</span>
        </div>`).join('')}
        ${spare > 0 ? `<div class="cf-more">and ${plural(spare, 'other field', 'other fields')}</div>` : ''}
      </div>` : ''}
    </div>`;
  }

  function conflictDiffHtml(r) {
    if (!r.groups.length) {
      return `<div class="cf-empty">Both copies hold the same content — they differ only in
        ordering or in fields that carry no meaning. Any choice here is safe.</div>`;
    }
    return r.groups.map(g => {
      const shown = g.items.slice(0, CF_MAX_ITEMS);
      const spare = g.items.length - shown.length;
      const tally = [
        g.localOnly ? `${g.localOnly} only here` : '',
        g.serverOnly ? `${g.serverOnly} only on server` : '',
        g.both ? `${g.both} edited on both` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="cf-group">
        <div class="cf-group-head">
          <span class="cf-group-name">${escHtml(g.label)}</span>
          <span class="cf-group-tally">${escHtml(tally)}</span>
        </div>
        ${shown.map(i => conflictItemHtml(i, r.names)).join('')}
        ${spare > 0 ? `<div class="cf-more">and ${plural(spare, 'more', 'more')}</div>` : ''}
      </div>`;
    }).join('');
  }

  // A conflict must never clobber a form mid-edit — if any modal is open,
  // park the conflict and surface it right after that modal closes.
  let pendingConflict = null;
  // The two datasets the open dialog is describing. The buttons resolve
  // against THIS server payload; passing null instead is what broke Merge.
  let conflictSides = null;

  // Every write goes through here so the sync dot can never disagree with
  // whether a conflict is actually outstanding.
  function setPendingConflict(sides) {
    pendingConflict = sides;
    if (typeof Sync !== 'undefined' && Sync.setConflictWaiting) Sync.setConflictWaiting(!!sides);
  }

  function hasPendingConflict() { return !!pendingConflict; }

  function showConflictModal(localSide, serverSide) {
    if (document.getElementById('modalOverlay').classList.contains('active')) {
      setPendingConflict([localSide, serverSide]);
      toast('Sync conflict — you’ll be asked once you finish here');
      return;
    }
    setPendingConflict(null);
    conflictSides = { local: localSide, server: serverSide };
    const report = conflictReport(localSide, serverSide);
    showModal('Sync Conflict', `
      <p class="cf-intro">This device and the server both changed since they last agreed.
        Nothing has been written yet.</p>
      ${conflictChoicesHtml(report)}
      <div class="cf-diff-head">What differs</div>
      ${conflictDiffHtml(report)}
    `, [`<button class="btn btn-secondary" onclick="App.deferConflict()">Decide later</button>`],
    // Answering IS the reconcile finishing. Dismissing this with Escape used
    // to leave sync half-connected until the next reload.
    { sticky: true });
  }

  async function resolveConflict(resolution) {
    if (!conflictSides) { closeModal({ force: true }); return; }
    let res;
    try {
      res = await Sync.resolveConflict(resolution, conflictSides.server);
    } catch (e) {
      // The local half of every resolution has already been applied by the
      // time a push can fail, so stranding the dialog would hide a change
      // that did land. Close, redraw, and say the push is still owed.
      console.error('Conflict resolution failed', e);
      conflictSides = null;
      closeModal({ force: true });
      render();
      toast('Resolved on this device — the server copy will catch up when sync reconnects');
      return;
    }
    if (!res || res.ok === false) {
      // Leave the dialog up. Closing it on a failure is how the old version
      // reported success while having written nothing.
      toast('Could not resolve — reconnect to the database and try again');
      return;
    }
    conflictSides = null;
    closeModal({ force: true });
    render();
    if (typeof Sync !== 'undefined') Sync.updateStatus();
    // Only claim the server has it when it actually does.
    toast(res.pushed === false
      ? 'Applied here — the server copy will catch up when sync reconnects'
      : ({
          local: 'Kept this device — the server now matches it',
          server: 'Took the server’s copy',
          merge: 'Merged — nothing was discarded',
        }[resolution] || 'Conflict resolved'));
  }

  // Deferring is allowed, disappearing is not: the conflict stays on the sync
  // dot until it is answered.
  function deferConflict() {
    const sides = conflictSides;
    conflictSides = null;
    // Park it only AFTER closing. closeModal's tail exists to resurface a
    // conflict that arrived while a form was open, and it would consume this
    // one on the way out — re-opening the dialog a quarter-second after the
    // user asked for it to go away.
    closeModal({ force: true });
    if (sides) setPendingConflict([sides.local, sides.server]);
    toast('Sync is holding until you decide — tap the sync dot');
  }

  // ═══════════════════════════════════════════════════════════
  // MODAL SYSTEM
  // ═══════════════════════════════════════════════════════════
  // A sticky modal is one that must be answered before anything else. Only
  // the sync conflict uses it: leaving that question unanswered strands the
  // reconcile half-done, so Escape, an overlay click and a stray hotkey all
  // have to bounce off it rather than quietly dismiss it.
  let modalSticky = false;

  function showModal(title, bodyHtml, footerHtml = [], opts = {}) {
    if (modalSticky && !opts.sticky) return false;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml.join('');
    document.getElementById('modalOverlay').classList.add('active');
    modalSticky = !!opts.sticky;
    refreshIcons();
    setTimeout(() => {
      const t = document.getElementById('entryTitle');
      if (t) { t.focus(); autoGrow(t); } // pre-filled long titles size correctly
    }, 100);
    return true;
  }

  function closeModal(opts = {}) {
    if (modalSticky && !opts.force) return false;
    modalSticky = false;
    document.getElementById('modalOverlay').classList.remove('active');
    editingEntryId = null;
    editingBlockId = null;
    // Focus lingering on a hidden modal input silently disables single-key
    // hotkeys (the handler thinks you're still typing) — release it.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    // A sync conflict that arrived mid-form was parked — surface it now
    if (pendingConflict) {
      const [l, s] = pendingConflict;
      setPendingConflict(null);
      setTimeout(() => showConflictModal(l, s), 250);
    }
  }

  function closePanel() {
    // Floating window — just retract it (no overlay involved)
    document.getElementById('slidePanel').classList.remove('active');
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    // Timers keep running — surface the header indicator
    if (typeof Timers !== 'undefined') Timers.updateMini();
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRY ACTIONS
  // ═══════════════════════════════════════════════════════════
  function toggleEntry(id) {
    const before = State.getEntry(id);
    const wasDone = before?.type === 'habit' ? State.isHabitDoneToday(id) : !!before?.completed;
    // Ticking a bridged task edits a document in another app. That is exactly
    // the mis-tap that most needs a way back, so it gets a checkpoint — but
    // no Undo toast, because completions already have their own feedback and
    // the box itself is the affordance for un-ticking.
    State.checkpoint(`${wasDone ? 'Reopened' : 'Completed'} “${before ? before.title : 'task'}”`);
    State.toggleComplete(id);
    State.dropCheckpointIfUnchanged();
    if (before && !wasDone) {
      // completing (not un-completing) earns the burst
      if (before.type === 'habit') {
        if (!checkStreakMilestone(id)) celebrate();
      } else if (before.type === 'task' || before.type === 'goal') {
        celebrate();
      }
      // recurring: say when the next occurrence landed
      const after = State.getEntry(id);
      if (after?.recurrence && after.spawnedNextId) {
        const next = State.getEntry(after.spawnedNextId);
        if (next?.dueDate) toast(`Done — repeats ${after.recurrence.type}, next ${formatDueDate(next.dueDate)}`);
        // The spawned occurrence is a brand-new entry with no link of its
        // own. Scans find bridged tasks by their link, so without pushing it
        // the next occurrence would exist only here — the room would show the
        // series stopping at the one just ticked.
        if (next && next.txtRoom == null && typeof Bridge !== 'undefined') {
          Bridge.pushNewTask(next).catch(() => {});
        }
      }
      // dependency chain: announce what this completion freed up
      const freed = State.getEntries({ type: 'task', completed: false })
        .filter(t => (t.blockedBy || []).includes(id) && !isBlocked(t));
      if (freed.length > 0) {
        toast(`Unblocked: ${freed.map(t => t.title).join(', ')}`);
      }
    }
    // A task mirroring a Cade.txt checkbox ticks the box over there too —
    // immediately, so the two views never disagree while you look at them.
    const after = State.getEntry(id);
    if (after && after.txtRoom && typeof Bridge !== 'undefined') {
      Bridge.pushCompletion(after).catch(() => {});
    }
    render();
  }

  function archiveEntry(id) {
    const e = State.getEntry(id);
    undoable(`Archived “${e ? e.title : 'entry'}”`, () => State.archiveEntry(id));
    closeModal();
    render();
  }

  function unarchiveEntry(id) {
    State.unarchiveEntry(id);
    render();
  }

  function togglePin(id) {
    const e = State.getEntry(id);
    State.togglePinned(id);
    toast(e && e.pinned ? 'Unpinned' : 'Pinned to your shortlist');
    render();
  }

  // Snooze — "not today" as an action rather than an edit. Pushing the date
  // out by hand is four taps and leaves you looking at a date picker to say
  // something you already knew.
  const SNOOZE_OPTIONS = [
    { key: 'tomorrow', label: 'Tomorrow', days: 1 },
    { key: 'weekend', label: 'This weekend', weekend: true },
    { key: 'nextweek', label: 'Next week', days: 7 },
  ];

  function snoozeEntry(id, key) {
    const e = State.getEntry(id);
    if (!e) return;
    const opt = SNOOZE_OPTIONS.find(o => o.key === key) || SNOOZE_OPTIONS[0];
    let target;
    if (opt.weekend) {
      const dow = new Date().getDay();
      target = State.dateStr(new Date(Date.now() + (((6 - dow + 7) % 7) || 7) * 86400000));
    } else {
      target = State.dateStr(new Date(Date.now() + opt.days * 86400000));
    }
    undoable(`Snoozed “${e.title}” to ${opt.label.toLowerCase()}`,
      () => State.updateEntry(id, { scheduledDate: target, dueDate: e.dueDate ? target : e.dueDate }));
    closeModal();
    render();
  }

  function openSnooze(id) {
    const e = State.getEntry(id);
    if (!e) return;
    showModal('Snooze', `
      <p class="text-sm text-muted" style="margin-bottom:var(--space-3);">
        Move “${escHtml(e.title)}” out of today. ${e.dueDate ? 'Its due date moves with it.' : 'It has no due date, so only its place in Today changes.'}
      </p>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        ${SNOOZE_OPTIONS.map(o => `<button class="btn btn-secondary" onclick="App.snoozeEntry('${id}','${o.key}')">${escHtml(o.label)}</button>`).join('')}
      </div>
    `, [`<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`]);
  }

  // No confirm() any more: deleting moves the entry to the trash, where it
  // stays for a month, and the toast offers an immediate way back. A dialog
  // guarding a reversible action is just an extra click.
  function deleteEntry(id) {
    const e = State.getEntry(id);
    undoable(`Deleted “${e ? e.title : 'entry'}”`, () => State.deleteEntry(id));
    closeModal();
    render();
  }

  function startTimerForTask(id) {
    // Arms the tracker for the task — the user presses Start to begin
    Timers.armTracking(id);
  }

  // ═══════════════════════════════════════════════════════════
  // SETTINGS ACTIONS
  // ═══════════════════════════════════════════════════════════
  function updateTimerSetting(key, value) {
    const settings = State.getSettings();
    const val = key === 'autoStart' ? value : parseInt(value);
    State.updateSettings({ timer: { ...settings.timer, [key]: val } });
    render();
  }

  function updateCalorieGoal(value) {
    State.updateSettings({ calorieGoal: parseInt(value) || 2000 });
  }

  function setWorkingProject(id) {
    State.updateSettings({ workingProject: id || null });
    render();
  }

  function updateMaxNavTimers(value) {
    const v = Math.min(6, Math.max(1, parseInt(value) || 2));
    State.updateSettings({ maxNavTimers: v });
    if (typeof Timers !== 'undefined') Timers.updateMini();
  }

  // Generic boolean/scalar preference updater (Appearance toggles etc.)
  function updateAppSetting(key, value) {
    State.updateSettings({ [key]: value });
    render();
  }

  // Nuke cached app files + service workers, then reload — the escape
  // hatch when a deployed update hasn't reached this device yet.
  // localStorage (your data) is untouched.
  async function hardRefresh() {
    toast('Clearing caches — reloading…');
    try {
      if ('caches' in window) {
        // Cache Storage is shared origin-wide with the root site's service
        // worker — only ever touch THIS app's cache family.
        const keys = await caches.keys();
        await Promise.all(keys
          .filter(k => k.startsWith('cade-project-') || k.startsWith('cade-cdn-'))
          .map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs
          .filter(r => r.scope.includes('/project'))
          .map(r => r.unregister()));
      }
    } catch (err) { /* still reload — a plain reload is better than nothing */ }
    setTimeout(() => location.reload(), 300);
  }

  function setHotkey(action, value) {
    const v = (value || '').trim().toLowerCase().slice(0, 1);
    const hotkeys = { ...(State.getSettings().hotkeys || {}) };
    const clash = Object.entries(hotkeys).find(([a, k]) => a !== action && k === v && v);
    if (clash) { toast(`"${v}" is already bound — pick another key`); render(); return; }
    hotkeys[action] = v || null;
    State.updateSettings({ hotkeys });
  }

  function exportData() {
    const json = State.exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cade-project-backup-${State.todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Data exported');
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (State.importData(ev.target.result)) {
          toast('Data imported');
          render();
        } else {
          toast('Import failed');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  async function confirmReset() {
    if (!confirm('Delete ALL data? This cannot be undone.')) return;
    const settings = State.getSettings();
    let erasedRemote = false;
    // The synced copy is a separate encrypted blob on Firebase — if it isn't
    // erased too, reconnecting with the same passphrase restores everything.
    if (settings.sync.databaseUrl && settings.sync.passphrase) {
      if (confirm('Also erase the synced copy on Firebase? Recommended — otherwise reconnecting with the same passphrase will bring the old data back.')) {
        toast('Erasing cloud copy…');
        const result = await Sync.eraseRemote();
        if (!result.success) {
          if (!confirm(`Cloud erase failed (${result.error}). Reset local data anyway? The server copy will remain.`)) return;
        }
        // A FAILED erase leaves the server copy standing, which is exactly
        // the case that needs the reconnect paused.
        erasedRemote = result.success;
      } else {
        // At minimum stop the pending debounced push from re-uploading
        Sync.disconnect();
      }
    }
    // Keeping the server copy means the reload would auto-connect and pull it
    // straight back, so sync is paused until the user reconnects — otherwise
    // a local-only reset looks like it did nothing at all.
    const hadSync = !!(settings.sync.databaseUrl && settings.sync.passphrase);
    State.resetData({ pauseSync: hadSync && !erasedRemote });
    if (hadSync && !erasedRemote) {
      alert('Local data cleared. Sync is paused so it cannot pull the server copy back — reconnect from Data \u25b8 Firebase Sync when you are ready.');
    }
    location.reload();
  }

  // ═══════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════
  function init() {
    initTheme();
    loadNav();
    // Anything past its month goes now, so the blob does not grow forever.
    try { State.expireTrash(); } catch (e) {}

    // Menubar menus
    document.querySelectorAll('.menu-trigger[data-menu]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu(btn.dataset.menu, btn);
      });
    });
    document.getElementById('menuMore')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenuSheet();
    });
    // Anything outside a menu dismisses it — the sheet included. Capture
    // phase, because plenty of in-page handlers stopPropagation() (the
    // planner grid, entry cards); on the bubble phase those clicks never
    // reach here and the menu stays stuck open over the content.
    document.addEventListener('click', (e) => {
      if (e.target.closest('.menu-wrap, .ws-pill-wrap, .menu-sheet, #menuMore')) return;
      closeAllMenus();
    }, true);

    // FAB
    document.getElementById('fabBtn').addEventListener('click', () => openNewEntry('task'));

    // Theme toggle
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    // Search → command palette (falls back to the modal search)
    document.getElementById('searchBtn').addEventListener('click', openPalette);

    // Modal close
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeModal();
    });

    // Panel close (timers keep running; the nav element brings it back)
    document.getElementById('panelClose').addEventListener('click', closePanel);

    // A save that never reached disk is the difference between "my edit is
    // here" and "my edit exists until I reload" — say so rather than letting
    // the next reload look like data loss.
    window.addEventListener('state-save-failed', () => {
      toast('Storage full — changes are not being saved. Free space in Settings.');
    });
    if (!State.isHealthy()) {
      setTimeout(() => toast('Saved data could not be read. Connect sync to restore it — nothing will be overwritten.'), 800);
    }

    // Keyboard shortcuts — Cmd/Ctrl combos plus configurable single-key
    // hotkeys (Gmail-style: only fire when not typing in a field)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeAllMenus(); closeModal(); closePanel(); closePopover(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); openNewEntry('task'); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'l' && currentTab === 'scratch') { e.preventDefault(); clearScratchAll(); return; }
      const t = e.target;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const hk = State.getSettings().hotkeys || {};
      const k = e.key.toLowerCase();
      if (k === hk.timer) { e.preventDefault(); Timers.toggleWindow(); }
      else if (k === hk.newTask) { e.preventDefault(); openNewEntry('task'); }
      else if (k === hk.quickLog) { e.preventDefault(); openQuickLog(); }
      else if (k === hk.search) { e.preventDefault(); openPalette(); }
      else if (k === hk.stopTimers) { e.preventDefault(); Timers.stopAll(); toast('All timers stopped'); }
    });

    // Timer window dragging (desktop) — grab the header, park it anywhere
    const panel = document.getElementById('slidePanel');
    const panelHeader = panel?.querySelector('.slide-panel-header');
    let panelDrag = null;
    if (panelHeader) {
      panelHeader.addEventListener('pointerdown', (e) => {
        if (window.innerWidth < 768 || e.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        panelDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        try { panelHeader.setPointerCapture(e.pointerId); } catch (err) {}
      });
      panelHeader.addEventListener('pointermove', (e) => {
        if (!panelDrag) return;
        panel.style.left = `${Math.min(Math.max(e.clientX - panelDrag.dx, 8), window.innerWidth - 120)}px`;
        panel.style.top = `${Math.min(Math.max(e.clientY - panelDrag.dy, 8), window.innerHeight - 80)}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      });
      panelHeader.addEventListener('pointerup', () => { panelDrag = null; });
      panelHeader.addEventListener('pointercancel', () => { panelDrag = null; });
    }

    // Auto-connect sync
    Sync.autoConnect();
    Sync.updateStatus();

    // Cade.txt link — rooms in, completions both ways. Silent when txt has
    // never run on this device.
    //
    // With sync configured the first import waits for reconciliation: this
    // device's copy of the dataset isn't authoritative until then, and
    // importing a room into a stale copy that the server copy is then merged
    // on top of yields two of everything. The timeout is the backstop for a
    // device that is offline or whose database is unreachable — the import
    // has to happen eventually, and the bridge de-duplicates on every scan.
    if (typeof Bridge !== 'undefined') {
      const onScan = (stats) => {
        render();
        const bits = [];
        if (stats.rooms) bits.push(`${stats.rooms} room${stats.rooms > 1 ? 's' : ''}`);
        if (stats.tasks) bits.push(`${stats.tasks} task${stats.tasks > 1 ? 's' : ''}`);
        if (bits.length) toast(`Cade.txt: linked ${bits.join(', ')}`);
      };
      const waitForSync = Sync.isConfigured() && !Sync.isReconciled();
      Bridge.init(onScan, { defer: waitForSync });
      // Every reconcile triggers a scan, not just the first. If the timeout
      // below fired because the database was slow, the import ran against a
      // pre-reconcile dataset — the scan after the server copy lands is what
      // folds any duplicate links back together.
      window.addEventListener('sync-reconciled', () => Bridge.requestScan(0));
      if (waitForSync) setTimeout(() => Bridge.requestScan(0), 15000);
    }

    // Running timers survive page refreshes — resume before first paint
    if (typeof Timers !== 'undefined' && Timers.restore) Timers.restore();

    // Reminder engine + scheduled check-ins — while the app is open
    setInterval(() => { checkReminders(); checkQuickLogPrompts(); }, 30000);
    setTimeout(() => { checkReminders(); checkQuickLogPrompts(); }, 3000);

    // PWA shortcut deep links (manifest shortcuts / bookmarks)
    const action = new URLSearchParams(location.search).get('action');
    if (action) {
      history.replaceState(null, '', location.pathname); // don't re-fire on reload
      setTimeout(() => {
        if (action === 'new-task') openNewEntry('task');
        else if (action === 'quick-log') openQuickLog();
        else if (action === 'review') openDailyReview();
      }, 400);
    }

    // Initial render
    render();

    // Service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }
  }

  // Public API
  return {
    init, render, switchTab, toggleTheme,
    openNewEntry, editEntry, saveEntry, changeEntryType, selectEffort,
    addTag, removeTag, removeTagAt, addTagById,
    openNewProject, openProjectModal, openManageProjects, dismissModal, selectColor, selectIcon, saveProject,
    archiveProjectAction, unarchiveProjectAction, deleteProjectAction,
    openSyncConfig, connectSync, disconnectSync, reconnectSync,
    openQuickLog, setQuickLogTab, openCalorieLog, logCaloriesFromModal, quickAddTask, logEmotion,
    useShortcut, setQuickEmotion, setQuickEnergy, logCheckinFromModal, logWake, logSleep,
    removeWakeSleep, deleteQuickLogRow, toggleFormProject, setHotkey,
    openTaskPage, backFromTaskPage, addPost, deletePost, postToTask,
    setFocusDue, filterChips, updateMaxNavTimers,
    openManageShortcuts, addShortcut, deleteShortcut,
    openManageTags, cycleTagColor, renameTag, setTagProject, deleteTagPrompt, createTagFromManager,
    openSearch, runSearch, searchGo, openPalette, toast, undo, redo,
    quickAddSubmit, quickAddPreview, quickAddKey,
    setAccent, openHistoryDay, celebrate, updateAppSetting, autoGrow, setSettingsFilter,
    checkReminders, enableNotifications,
    openDailyReview, reviewAction, openShutdown, shutdownPushAll, openWeeklyReview, openRecords,
    openAutoPlan, confirmAutoPlan, openWhyThis,
    openPasteImport, previewPasteImport, runPasteImport,
    hardRefresh, setPixelsMode, renderAutoPlanPreview,
    addScratchIdea, scratchToTask, copyScratchIdea, deleteScratchIdea, clearScratchAll,
    scratchInputChanged, scratchAcPick, scratchKeydown,
    toggleSection, checkQuickLogPrompts,
    setPostMode, togglePostTodo,
    toolCoin, toolDice, toolPick, toolName, toolRandom, toolUuid, toolCopy, toolListChanged,
    logFood, deleteFoodLog, useShortcutHealth,
    toggleEntry, deleteEntry, archiveEntry, unarchiveEntry, togglePin, openSnooze, snoozeEntry, startTimerForTask,
    selectEntryCard, clearBulkSelection, bulkSetProject, bulkSetDue, bulkSetPriority,
    bulkComplete, bulkArchive, bulkDelete, setWorkingProject,
    // Navigation chrome
    menuAction, toggleWorkspaceMenu, setWorkspace, setSubproject, toggleSettledSubs,
    revealProject,
    // Cade.txt link
    openBridgePanel, rescanBridge, seedRooms, openNewSubproject, saveNewSubproject,
    openTimer, stopAllTimers, addScratchFromMenu,
    viewArchive, openTrash, restoreFromTrash, purgeFromTrash, emptyTrash, deleteHistoryLog, editMoodLog, setEditLogEmotion, setEditLogEnergy, saveMoodLog,
    setTagFilter, openSubproject, toggleShowCompleted, toggleShowCompletedToday, setCompletedSort,
    selectHabit, toggleHabitCell, cycleHabitCell, exportForLLM,
    onRecurrenceChange, toggleWeekday,
    setInsightsProject, setInsightsEntry,
    qDragStart, qDragEnd, qDragOver, qDragLeave, qDrop, qItemClick,
    taskDragStart, taskDragEnd, plannerDragOver, plannerDragLeave, plannerDrop,
    reorderStart, reorderEnd, reorderOver, reorderLeave, reorderDrop,
    plannerNav, plannerToday, setPlannerView, plannerTap, blockPointerDown,
    popoverAgenda, popoverTask, popoverTimer,
    openAgendaModal, saveAgendaBlock, deleteAgendaBlock, editPlannerBlock,
    historyNav, historyToday,
    updateTimerSetting, updateCalorieGoal,
    exportData, importData, confirmReset,
    showModal, closeModal, closePanel,
    showConflictModal, resolveConflict, deferConflict, hasPendingConflict,
    // The conflict screen's pure parts, checkable without a live database.
    _conflictReport: conflictReport,
    _parsePasteForTest: parsePasteText,
  };
})();

// Boot
document.addEventListener('DOMContentLoaded', App.init);
