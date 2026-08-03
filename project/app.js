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
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  function icon(name, size = 18) {
    return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
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
  // THEME
  // ═══════════════════════════════════════════════════════════
  function initTheme() {
    const saved = State.getSettings().theme;
    document.documentElement.setAttribute('data-theme', saved);
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = saved === 'dark' ? icon('sun') : icon('moon');
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    State.updateSettings({ theme: next });
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = next === 'dark' ? icon('sun') : icon('moon');
      toggleBtn.setAttribute('aria-label', 'Switch to ' + (next === 'dark' ? 'light' : 'dark') + ' mode');
    }
    render();
    refreshIcons();
  }

  // ═══════════════════════════════════════════════════════════
  // ROUTING
  // ═══════════════════════════════════════════════════════════
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═══════════════════════════════════════════════════════════
  function render() {
    const main = document.getElementById('mainContent');
    Charts.destroyAll();
    closePopover();

    switch (currentTab) {
      case 'today': main.innerHTML = renderToday(); break;
      case 'projects': main.innerHTML = renderProjects(); break;
      case 'habits': main.innerHTML = renderHabits(); break;
      case 'focus': main.innerHTML = renderFocus(); break;
      case 'health': main.innerHTML = renderHealth(); break;
      case 'insights': main.innerHTML = renderInsights(); break;
      case 'history': main.innerHTML = renderHistory(); break;
      case 'settings': main.innerHTML = renderSettings(); break;
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
  function renderToday() {
    const today = State.todayStr();
    const allEntries = State.getEntries();
    const tasks = allEntries.filter(e => e.type === 'task');
    const habits = allEntries.filter(e => e.type === 'habit');

    // Today's tasks (due today, scheduled today, or unscheduled) — completed
    // ones stay visible (struck through) so a mis-tap is recoverable.
    const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    const todayTasks = tasks.filter(t =>
      t.dueDate === today || t.scheduledDate === today || (!t.dueDate && !t.scheduledDate)
    ).sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1; // done → bottom
      return (priOrder[a.priority] || 2) - (priOrder[b.priority] || 2);
    });

    // Overdue tasks (never completed ones)
    const overdueTasks = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today);

    const openToday = todayTasks.filter(t => !t.completed);

    // Next best task (highest priority + lowest effort, open only)
    const nextTask = [...openToday].sort((a, b) => {
      const effOrder = { trivial: 0, small: 1, medium: 2, large: 3, xl: 4 };
      const pa = (priOrder[a.priority] || 2) * 10 + (effOrder[a.effort] || 2);
      const pb = (priOrder[b.priority] || 2) * 10 + (effOrder[b.effort] || 2);
      return pa - pb;
    })[0];

    const todayEmotion = State.getTodayEmotion();
    const focusSeconds = State.getLogs({ type: 'time_session', date: today })
      .reduce((s, l) => s + (l.value || 0), 0);

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
          <p class="page-subtitle">${openToday.length + overdueTasks.length} tasks today · ${habits.filter(h => !State.isHabitDoneToday(h.id)).length} habits pending</p>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary" onclick="Timers.openPanel()">${icon('timer', 16)}Timer</button>
          <button class="btn btn-secondary" onclick="App.openQuickLog()">${icon('zap', 16)}Quick Log</button>
        </div>
      </div>
    `;

    // Stats row
    html += `<div class="grid-3 section">
      <div class="card stat-card">
        <span class="stat-label">Tasks Done Today</span>
        <span class="stat-value">${tasks.filter(e => e.completed && e.completedAt?.startsWith(today)).length} / ${todayTasks.length + overdueTasks.length}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Habits Today</span>
        <span class="stat-value">${habits.filter(h => State.isHabitDoneToday(h.id)).length} / ${habits.length}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Focus Time</span>
        <span class="stat-value">${focusSeconds > 0 ? Timers.formatTime(focusSeconds) : '—'}</span>
      </div>
    </div>`;

    // Next best task
    if (nextTask) {
      const proj = nextTask.projectId ? State.getProject(nextTask.projectId) : null;
      html += `
        <div class="section">
          <div class="section-header"><span class="section-title">Next Best Task</span></div>
          <div class="card card-interactive" style="display:flex;align-items:center;gap:var(--space-3);border-color:var(--accent);background:var(--accent-tint);cursor:pointer;" onclick="App.toggleEntry('${nextTask.id}')">
            <div class="check-toggle ${nextTask.completed ? 'checked' : ''}"><i data-lucide="check"></i></div>
            <div style="flex:1">
              <div class="entry-title" style="font-weight:600;">${nextTask.title}</div>
              <div class="entry-meta">
                ${proj ? `<span class="proj-dot" style="background:${proj.color}"></span><span class="text-xs text-muted">${proj.name}</span>` : ''}
                <span class="pill pill-${priorityColor(nextTask.priority)}">${nextTask.priority}</span>
                <span class="pill">${effortLabel(nextTask.effort)}</span>
                ${nextTask.estimateMinutes ? `<span class="pill">~${estimateLabel(nextTask.estimateMinutes)}</span>` : ''}
                ${nextTask.dueDate ? `<span class="pill pill-accent">${formatDueDate(nextTask.dueDate)}</span>` : ''}
              </div>
            </div>
            <button class="icon-btn" onclick="event.stopPropagation();App.startTimerForTask('${nextTask.id}')" aria-label="Start timer">${icon('play', 18)}</button>
          </div>
        </div>
      `;
    }

    // Habits today
    if (habits.length > 0) {
      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">Habits</span>
          <button class="btn btn-ghost btn-sm" onclick="App.switchTab('habits')">${icon('chevron-right', 14)}All</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);">
      `;
      habits.forEach(h => {
        const proj = h.projectId ? State.getProject(h.projectId) : null;
        const s = State.calculateStreak(h.id);
        html += renderEntryCard(h, proj, s);
      });
      html += `</div></div>`;
    }

    // Today's tasks
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Today's Tasks</span></div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
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

    // Day planner
    html += renderPlannerSection();

    // Day mood widget (food/calorie tracking lives on the Health tab)
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Day Mood</span></div>
        <div class="emotion-selector">
          ${renderEmotionButton('great', 'Great', todayEmotion?.emotion)}
          ${renderEmotionButton('good', 'Good', todayEmotion?.emotion)}
          ${renderEmotionButton('okay', 'Okay', todayEmotion?.emotion)}
          ${renderEmotionButton('low', 'Low', todayEmotion?.emotion)}
          ${renderEmotionButton('bad', 'Bad', todayEmotion?.emotion)}
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

  function renderPlannerGrid(dateStr) {
    const today = State.todayStr();
    const blocks = State.getPlannerBlocks({ date: dateStr });
    const totalH = (HOUR_END - HOUR_START) * HOUR_PX;

    let html = `<div class="planner-grid" style="height:${totalH}px">`;
    for (let hour = HOUR_START; hour < HOUR_END; hour++) {
      html += `<div class="planner-hour" onclick="App.plannerTap(event,'${dateStr}',${hour})">
        <div class="planner-hour-label">${String(hour).padStart(2, '0')}:00</div>
      </div>`;
    }

    // Positioned blocks (lane layout for overlaps)
    html += `<div style="position:absolute;inset:0;pointer-events:none;">`;
    layoutBlocks(blocks).forEach(({ b, top, height, leftPct, widthPct }) => {
      const entry = b.entryId ? State.getEntry(b.entryId) : null;
      const proj = b.projectId ? State.getProject(b.projectId) : null;
      const color = b.color || proj?.color || 'var(--accent)';
      const isPast = dateStr < today;
      const overdue = entry && !entry.completed && isPast;
      const done = entry && entry.completed;
      const dur = timeToMin(b.end) - timeToMin(b.start);
      html += `<div class="planner-block ${b.kind === 'tracked' ? 'tracked' : ''} ${overdue ? 'overdue' : ''} ${done ? 'done' : ''}"
        style="top:${top}px;height:${Math.max(height, 16)}px;left:calc(var(--gutter) + 4px + ${leftPct}% - ${leftPct / 100} * (var(--gutter) + 8px));right:auto;width:calc(${widthPct}% - ${widthPct / 100} * (var(--gutter) + 8px) - 2px);border-left-color:${color};background:color-mix(in srgb, ${color} 12%, var(--surface));pointer-events:auto;"
        onclick="event.stopPropagation();App.editPlannerBlock('${b.id}')"
        title="${b.title} · ${b.start}–${b.end}">
        <div class="pb-title">${overdue ? '⚠ ' : ''}${b.title}</div>
        ${height >= 30 ? `<div class="pb-time">${b.start}–${b.end} · ${estimateLabel(dur)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;

    // Now line
    if (dateStr === today) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= HOUR_START * 60 && nowMin <= HOUR_END * 60) {
        const top = (nowMin - HOUR_START * 60) / 60 * HOUR_PX;
        html += `<div class="planner-now" style="top:${top}px"></div>`;
      }
    }

    html += `</div>`;
    return html;
  }

  // Assign overlapping blocks to side-by-side lanes.
  function layoutBlocks(blocks) {
    const evs = blocks.map(b => ({
      b,
      s: Math.max(timeToMin(b.start), HOUR_START * 60),
      e: Math.min(Math.max(timeToMin(b.end), timeToMin(b.start) + 15), HOUR_END * 60),
    })).filter(ev => ev.e > HOUR_START * 60 && ev.s < HOUR_END * 60)
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
          top: (ev.s - HOUR_START * 60) / 60 * HOUR_PX,
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
            ${projects.map(p => `<option value="${p.id}" ${block?.projectId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
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
            `<option value="${t.id}" ${block?.entryId === t.id ? 'selected' : ''}>${t.title}</option>`).join('')}
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
  // ENTRY CARD RENDERER — whole card is the toggle hitbox
  // ═══════════════════════════════════════════════════════════
  function renderEntryCard(entry, project, streakInfo) {
    const proj = project || (entry.projectId ? State.getProject(entry.projectId) : null);
    const isOverdueFlag = entry.dueDate && isOverdue(entry.dueDate) && !entry.completed;
    const isDone = entry.type === 'habit' ? State.isHabitDoneToday(entry.id) : entry.completed;

    let metaHtml = '';
    if (proj) {
      metaHtml += `<span class="proj-dot" style="background:${proj.color}"></span>`;
    }
    if (entry.priority && entry.priority !== 'low') {
      metaHtml += `<span class="pill pill-${priorityColor(entry.priority)}">${entry.priority}</span>`;
    }
    if (entry.effort) {
      metaHtml += `<span class="pill">${effortLabel(entry.effort)}</span>`;
    }
    if (entry.estimateMinutes) {
      metaHtml += `<span class="pill">~${estimateLabel(entry.estimateMinutes)}</span>`;
    }
    if (entry.dueDate) {
      const cls = isOverdueFlag ? 'pill-red' : 'pill-accent';
      metaHtml += `<span class="pill ${cls}">${formatDueDate(entry.dueDate)}</span>`;
    }
    if (entry.tags && entry.tags.length > 0) {
      entry.tags.forEach(tag => {
        const tagObj = State.getAllTags().find(t => t.name === tag);
        const colorCls = tagObj ? `pill-${tagObj.color}` : 'pill-gray';
        metaHtml += `<span class="pill ${colorCls}">#${tag}</span>`;
      });
    }
    if (entry.type === 'habit' && streakInfo) {
      metaHtml += `<span class="streak-display"><i data-lucide="flame"></i>${streakInfo.current}</span>`;
    }
    if (entry.type === 'goal' && entry.targetValue) {
      const pct = Math.round((entry.currentValue || 0) / entry.targetValue * 100);
      metaHtml += `<span class="pill pill-accent">${pct}%</span>`;
    }

    return `
      <div class="entry-card ${isDone ? 'completed' : ''}" data-id="${entry.id}" onclick="App.toggleEntry('${entry.id}')">
        <div class="check-toggle ${isDone ? 'checked' : ''}">
          <i data-lucide="check"></i>
        </div>
        <div class="entry-body">
          <div class="entry-title">${entry.title}</div>
          ${metaHtml ? `<div class="entry-meta">${metaHtml}</div>` : ''}
          ${entry.type === 'goal' && entry.targetValue ? `
            <div class="progress-bar mt-2">
              <div class="progress-fill" style="width:${Math.min((entry.currentValue || 0) / entry.targetValue * 100, 100)}%"></div>
            </div>` : ''}
        </div>
        <div class="entry-actions">
          <button class="icon-btn" onclick="event.stopPropagation();App.editEntry('${entry.id}')" aria-label="Edit">${icon('pencil', 15)}</button>
          <button class="icon-btn" onclick="event.stopPropagation();App.archiveEntry('${entry.id}')" aria-label="Archive">${icon('archive', 15)}</button>
          <button class="icon-btn" onclick="event.stopPropagation();App.deleteEntry('${entry.id}')" aria-label="Delete">${icon('trash-2', 15)}</button>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════
  // PROJECTS VIEW
  // ═══════════════════════════════════════════════════════════
  let projectFilter = null;

  function renderProjects() {
    const projects = State.getProjects();
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="page-subtitle">${projects.length} projects · ${State.getEntries().length} total entries</p>
        </div>
        <button class="btn btn-primary" onclick="App.openNewProject()">${icon('plus', 14)}New Project</button>
      </div>
    `;

    // Filter chips
    html += `<div class="filter-chips">
      <button class="filter-chip ${!projectFilter ? 'active' : ''}" onclick="App.setProjectFilter(null)">All</button>
    `;
    projects.forEach(p => {
      html += `<button class="filter-chip ${projectFilter === p.id ? 'active' : ''}" onclick="App.setProjectFilter('${p.id}')">
        <span class="proj-dot" style="background:${p.color}"></span>${p.name}
      </button>`;
    });
    html += `<button class="filter-chip ${projectFilter === 'none' ? 'active' : ''}" onclick="App.setProjectFilter('none')">No Project</button>`;
    html += `</div>`;

    if (projectFilter) {
      // Project-specific task view
      const proj = projectFilter === 'none' ? null : State.getProject(projectFilter);
      const entries = State.getEntries().filter(e =>
        projectFilter === 'none' ? !e.projectId : e.projectId === projectFilter
      );

      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">${proj ? proj.name : 'Unassigned'}</span>
          <span class="stat-label">${entries.length} items</span>
        </div>`;

      // Group by type
      const types = ['goal', 'task', 'habit', 'reminder', 'checkin'];
      types.forEach(type => {
        const typeEntries = entries.filter(e => e.type === type);
        if (typeEntries.length === 0) return;
        const typeIcons = { goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock', checkin: 'brain' };
        html += `<div class="section">
          <div class="section-header"><span class="section-title">${icon(typeIcons[type])} ${type}s (${typeEntries.length})</span></div>
          <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        `;
        typeEntries.forEach(e => { html += renderEntryCard(e, proj); });
        html += `</div></div>`;
      });

      // Task chains
      const chainedTasks = entries.filter(e => e.type === 'task' && (e.blockedBy?.length > 0 || e.blocks?.length > 0));
      if (chainedTasks.length > 0) {
        html += `<div class="section">
          <div class="section-header"><span class="section-title">Task Chains</span></div>
          <div class="task-chain">
        `;
        chainedTasks.forEach(t => {
          if (t.blockedBy?.length > 0) {
            t.blockedBy.forEach(bid => {
              const blocked = State.getEntry(bid);
              if (blocked) {
                html += `<div class="chain-link">
                  <span class="proj-dot" style="background:${proj?.color || '#888'}"></span>
                  <span class="text-sm">${blocked.title}</span>
                  <i data-lucide="chevron-right" class="chain-arrow" style="width:14px;height:14px;"></i>
                  <span class="text-sm">${t.title}</span>
                </div>`;
              }
            });
          }
        });
        html += `</div></div>`;
      }

      html += `</div>`;
    } else {
      // Project cards grid
      html += `<div class="grid-3 section">`;
      projects.forEach(p => {
        const entries = State.getEntries({ projectId: p.id });
        const completed = entries.filter(e => e.completed).length;
        const pending = entries.length - completed;
        html += `
          <div class="card card-interactive project-card" onclick="App.setProjectFilter('${p.id}')" style="cursor:pointer;">
            <div class="project-header">
              <div class="project-icon" style="background:${p.color}20;color:${p.color}">
                <i data-lucide="${p.icon}"></i>
              </div>
              <div style="flex:1">
                <div class="project-name">${p.name}</div>
                <div class="project-stats">
                  <span class="project-stat">${pending} pending</span>
                  <span class="project-stat">${completed} done</span>
                </div>
              </div>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${entries.length > 0 ? completed / entries.length * 100 : 0}%"></div>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    return html;
  }

  function setProjectFilter(id) {
    projectFilter = id;
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // HABITS VIEW
  // ═══════════════════════════════════════════════════════════
  let selectedHabit = null;

  function renderHabits() {
    const habits = State.getEntries({ type: 'habit' });
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Habits</h1>
          <p class="page-subtitle">${habits.length} tracked · ${habits.filter(h => State.isHabitDoneToday(h.id)).length} done today</p>
        </div>
        <button class="btn btn-primary" onclick="App.openNewEntry('habit')">${icon('plus', 14)}New Habit</button>
      </div>
    `;

    if (habits.length === 0) {
      return html + `<div class="empty-state"><i data-lucide="repeat"></i><p class="empty-state-text">No habits yet. Create your first one.</p></div>`;
    }

    // Habit grid overview — cells are tappable to toggle past days
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Completion Grid — Last 14 Days</span>
        <span class="text-xs text-faint">tap a cell to toggle that day</span>
      </div>
      <div class="card">
    `;

    habits.forEach(h => {
      const completions = new Set(State.getHabitCompletions(h.id));
      const today = new Date();
      const proj = h.projectId ? State.getProject(h.projectId) : null;

      html += `<div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-3);">
        <div style="width:120px;flex-shrink:0;cursor:pointer;" onclick="App.selectHabit('${h.id}')">
          <div class="text-sm" style="font-weight:500;color:${selectedHabit === h.id ? 'var(--accent-text)' : 'inherit'};">${h.title}</div>
          ${proj ? `<div class="text-xs" style="color:${proj.color}">${proj.name}</div>` : ''}
        </div>
        <div class="habit-grid">`;

      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = State.dateStr(d);
        const isCompleted = completions.has(dateStr);
        const isTodayCell = i === 0;
        const cellColor = isCompleted && proj?.color ? `style="background:${proj.color};border-color:${proj.color};"` : '';
        html += `<div class="habit-cell ${isCompleted ? 'completed' : ''} ${isTodayCell ? 'today' : ''}" ${cellColor}
          title="${dateStr} — tap to toggle" onclick="App.toggleHabitCell('${h.id}','${dateStr}')"></div>`;
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
      if (agg) Charts.renderHabitsAggregate('habitsAggChart', 30);
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

  // ═══════════════════════════════════════════════════════════
  // INSIGHTS VIEW
  // ═══════════════════════════════════════════════════════════
  let insightsProject = null; // null = all projects
  let insightsEntry = null;   // null = all tasks

  function insightsFilterObj() {
    return { projectId: insightsProject, entryId: insightsEntry };
  }

  function renderInsights() {
    const projects = State.getProjects();
    const inFilter = e => {
      if (insightsProject && e.projectId !== insightsProject) return false;
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

    // Filter bar: project chips + task select
    const filterableTasks = State.getEntries({ type: 'task' }).filter(t => !insightsProject || t.projectId === insightsProject);
    html += `<div class="filter-chips" style="align-items:center;">
      <button class="filter-chip ${!insightsProject ? 'active' : ''}" onclick="App.setInsightsProject(null)">All Projects</button>
      ${projects.map(p => `
        <button class="filter-chip ${insightsProject === p.id ? 'active' : ''}" onclick="App.setInsightsProject('${p.id}')">
          <span class="proj-dot" style="background:${p.color}"></span>${p.name}
        </button>`).join('')}
      <select class="form-select" style="width:auto;max-width:220px;padding:var(--space-1) var(--space-2);font-size:var(--text-xs);" onchange="App.setInsightsEntry(this.value || null)">
        <option value="">All tasks</option>
        ${filterableTasks.map(t => `<option value="${t.id}" ${insightsEntry === t.id ? 'selected' : ''}>${t.title}</option>`).join('')}
      </select>
    </div>`;

    // KPI row
    const totalStreak = habits.reduce((sum, h) => sum + State.calculateStreak(h.id).current, 0);
    const avgRetention = habits.length > 0 ? Math.round(habits.reduce((sum, h) => sum + State.calculateStreak(h.id).retention30, 0) / habits.length) : 0;
    const completionRate = tasks.length > 0 ? Math.round(tasks.filter(t => t.completed).length / tasks.length * 100) : 0;

    html += `<div class="grid-3 section">
      <div class="card stat-card"><span class="stat-label">Total Active Streaks</span><span class="stat-value">${totalStreak} days</span></div>
      <div class="card stat-card"><span class="stat-label">Avg Habit Retention</span><span class="stat-value">${avgRetention}%</span></div>
      <div class="card stat-card"><span class="stat-label">Task Completion Rate</span><span class="stat-value">${completionRate}%</span></div>
    </div>`;

    // Calendar heatmap
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Activity Heatmap — 12 Weeks</span></div>
      <div class="card"><div id="heatmapContainer"></div></div>
    </div>`;

    // Day breakdown + Mood & Energy
    html += `<div class="grid-2 section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Tasks — Last 7 Days</span></div>
        <div class="chart-container"><canvas id="dayBreakdownChart"></canvas></div>
      </div>
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Mood & Energy — 14 Days</span></div>
        <div class="chart-container"><canvas id="emotionTrendChart"></canvas></div>
      </div>
    </div>`;

    // Sleep chart
    html += `<div class="section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Wake / Sleep — 14 Days</span></div>
        <div class="chart-container"><canvas id="sleepChart"></canvas></div>
      </div>
    </div>`;

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
  let focusProject = null;

  const QUADRANTS = [
    { q: 1, label: 'Do First · High Pri / Low Effort', hiPri: true, hiEff: false },
    { q: 2, label: 'Schedule · High Pri / High Effort', hiPri: true, hiEff: true },
    { q: 3, label: 'Quick Wins · Low Pri / Low Effort', hiPri: false, hiEff: false },
    { q: 4, label: 'Later · Low Pri / High Effort', hiPri: false, hiEff: true },
  ];

  function renderFocus() {
    const projects = State.getProjects();
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Focus</h1>
          <p class="page-subtitle">Effort vs priority — figure out what to work on next</p>
        </div>
      </div>
      <div class="filter-chips">
        <button class="filter-chip ${!focusProject ? 'active' : ''}" onclick="App.setFocusProject(null)">All Projects</button>
        ${projects.map(p => `
          <button class="filter-chip ${focusProject === p.id ? 'active' : ''}" onclick="App.setFocusProject('${p.id}')">
            <span class="proj-dot" style="background:${p.color}"></span>${p.name}
          </button>`).join('')}
      </div>
      <div class="section">
        <div class="section-header"><span class="section-title">Four Quadrant</span>
          <span class="text-xs text-faint">drag between boxes to reprioritize · click to complete</span>
        </div>
        <div class="card">
          <div class="quadrant" id="quadrantView">${renderQuadrant(focusProject)}</div>
        </div>
      </div>
    `;
    return html;
  }

  function setFocusProject(id) {
    focusProject = id;
    render();
  }

  function renderQuadrant(projectId) {
    const tasks = State.getEntries({ type: 'task', completed: false })
      .filter(t => !projectId || t.projectId === projectId);
    const effOrder = { trivial: 0, small: 1, medium: 2, large: 3, xl: 4 };
    const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    const multiProject = !projectId; // show project dots in all-projects view

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
      let out = items.slice(0, MAX).map(t => {
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        return `<div class="q-item ${t.completed ? 'completed' : ''}" draggable="true" data-id="${t.id}"
          ondragstart="App.qDragStart(event,'${t.id}')" ondragend="App.qDragEnd(event)"
          onclick="App.qItemClick(event,'${t.id}')" title="${t.title}">
          <span class="q-handle">⠿</span>
          ${multiProject && proj ? `<span class="proj-dot" style="background:${proj.color}"></span>` : ''}
          <span class="q-title">${t.title}</span>
          ${t.estimateMinutes ? `<span class="q-est">${estimateLabel(t.estimateMinutes)}</span>` : ''}
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

  function renderInsightCharts() {
    const f = insightsFilterObj();
    const heatmap = document.getElementById('heatmapContainer');
    if (heatmap) Charts.renderHeatmap(heatmap, 84, f);

    const dayChart = document.getElementById('dayBreakdownChart');
    if (dayChart) Charts.renderDayBreakdown('dayBreakdownChart', 7, f);

    const emotionChart = document.getElementById('emotionTrendChart');
    if (emotionChart) Charts.renderMoodEnergy('emotionTrendChart', 14);

    const sleepChart = document.getElementById('sleepChart');
    if (sleepChart) Charts.renderSleepChart('sleepChart', 14);

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

    // Log food form
    const shortcuts = (State.getSettings().quickShortcuts || []).filter(s => s.calories);
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Log Food</span></div>
      <div class="card">
        ${shortcuts.length > 0 ? `<div class="shortcut-chips" style="margin-bottom:var(--space-3);">
          ${shortcuts.map(s => `
            <button class="shortcut-chip" id="sc-${s.id}" onclick="App.useShortcutHealth('${s.id}')">
              <span>${s.emoji}</span><span>${s.label}</span><span class="sc-cal">${s.calories} cal</span>
            </button>`).join('')}
        </div>` : ''}
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Calories</label>
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
          <span class="truncate" style="flex:1;">${l.emoji ? l.emoji + ' ' : ''}${l.notes || 'Food'}</span>
          ${macros ? `<span class="food-macros">${macros}</span>` : ''}
          <span class="font-mono text-xs" style="color:var(--accent-text);flex-shrink:0;">${l.value} cal</span>
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
    const cal = parseInt(document.getElementById('foodCal')?.value);
    if (!cal || cal <= 0) { toast('Enter valid calories'); return; }
    const meal = document.getElementById('foodMeal')?.value || 'snack';
    const notes = document.getElementById('foodNote')?.value?.trim() || '';
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
        return { time: logTimeOf(l), kind: 'time', title: `${Timers.formatTime(l.value || 0)} on ${en?.title || 'Unknown'}`, entry: en };
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
          <span class="truncate" style="flex:1">${r.title}</span>
          ${r.kind === 'task' ? `<button class="icon-btn" onclick="App.toggleEntry('${r.entry.id}')" aria-label="Un-complete" title="Mark as not done">${icon('undo-2', 14)}</button>` : ''}
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
        <div class="section-header"><span class="section-title">Logs</span></div>
        <div class="card loglist">`;
      dayLogs.forEach(l => {
        html += `<div class="log-row"><span class="lr-time">${logTimeOf(l)}</span><span>${describeLog(l)}</span></div>`;
      });
      html += `</div></div>`;
    }

    // Archive
    const archived = State.getEntries({ archived: true });
    html += `<div class="section">
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
          <span class="truncate" style="flex:1;${e.completed ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${e.title}</span>
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
        return `${l.emoji || '🍽'} ${l.notes || 'Food'} · ${l.value} cal (${l.meal || 'snack'})${macros ? ` · ${macros}` : ''}`;
      }
      case 'quick': return `${l.emoji || '⭐'} ${l.notes || 'Quick log'}`;
      case 'checkin':
        return `Check-in ${l.emotion ? moodIc(l.emotion) : ''}${l.energy ? ` energy ${l.energy}/5` : ''}${l.notes ? ` · ${l.notes}` : ''}`;
      case 'emotion': return `${moodIc(l.emotion)} Day mood: ${l.emotion}`;
      case 'wake': return `☀️ Woke up`;
      case 'sleep': return `🌙 Bedtime`;
      default: return l.type;
    }
  }

  function historyNav(delta) {
    historyOffset = Math.min(0, historyOffset + delta);
    render();
  }

  function historyToday() { historyOffset = 0; render(); }

  function renderHistoryCharts() {
    const container = document.getElementById('dayTimelineContainer');
    if (container) Charts.renderDayTimeline(container, offsetDateStr(historyOffset));
  }

  // ═══════════════════════════════════════════════════════════
  // SETTINGS VIEW
  // ═══════════════════════════════════════════════════════════
  function renderSettings() {
    const settings = State.getSettings();
    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Sync, preferences, data</p>
        </div>
      </div>
    `;

    // Sync section
    html += `<div class="section">
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
    html += `<div class="section">
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
      </div>
    </div>`;

    // Health + quick log
    html += `<div class="section">
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

    // Data management
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Data</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Export Data</div><div class="setting-desc">Download all data as JSON</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.exportData()">${icon('download', 14)}Export</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Import Data</div><div class="setting-desc">Restore from JSON backup</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.importData()">${icon('upload', 14)}Import</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label" style="color:var(--error)">Reset All Data</div><div class="setting-desc">Delete everything and start fresh</div></div>
          <button class="btn btn-danger btn-sm" onclick="App.confirmReset()">${icon('trash-2', 14)}Reset</button>
        </div>
      </div>
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
    showModal('New Entry', renderEntryForm(type), [
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
    showModal('Edit Entry', renderEntryForm(entry.type, entry), [
      `<button class="btn btn-danger" onclick="App.deleteEntry('${id}')">Delete</button>`,
      `<div style="flex:1"></div>`,
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveEntry()">Save</button>`,
    ]);
  }

  function renderEntryForm(type, entry = {}) {
    const projects = State.getProjects();
    const tags = State.getAllTags(); // full list, for pill colors
    // Suggestions respect tag scoping: global tags + the entry's project's tags
    const suggestTags = State.getAllTags(entry.projectId || null);
    const isGoal = type === 'goal';
    const isHabit = type === 'habit';

    const typeIcons = { goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock', checkin: 'brain' };
    const types = ['goal', 'task', 'habit', 'reminder', 'checkin'];

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
        <input type="text" class="form-input" id="entryTitle" value="${entry.title || ''}" placeholder="What needs to be done?" autocomplete="off">
      </div>

      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-textarea" id="entryDescription" placeholder="Add details...">${entry.description || ''}</textarea>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Project</label>
          <select class="form-select" id="entryProject">
            <option value="">None</option>
            ${projects.map(p => `<option value="${p.id}" ${entry.projectId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Due Date</label>
          <input type="date" class="form-input" id="entryDueDate" value="${entry.dueDate || ''}">
        </div>
      </div>

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

      <div class="form-group">
        <label class="form-label">Estimate (minutes)</label>
        <input type="number" class="form-input" id="entryEstimate" value="${entry.estimateMinutes || ''}" placeholder="e.g. 45" min="0" step="5">
      </div>

      ${isGoal ? `
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
        <div class="form-group">
          <label class="form-label">Unit</label>
          <input type="text" class="form-input" id="entryUnit" value="${entry.unit || ''}" placeholder="books, km, hours...">
        </div>
      ` : ''}

      ${isHabit ? `
        <div class="form-group">
          <label class="form-label">Recurrence</label>
          <select class="form-select" id="entryRecurrence">
            <option value="daily" ${entry.recurrence?.type === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${entry.recurrence?.type === 'weekly' ? 'selected' : ''}>Weekly</option>
            <option value="monthly" ${entry.recurrence?.type === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="none" ${!entry.recurrence ? 'selected' : ''}>None</option>
          </select>
        </div>
      ` : ''}

      <div class="form-group">
        <label class="form-label">Tags</label>
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-2);">
          ${(entry.tags || []).map(t => {
            const tagObj = tags.find(tg => tg.name === t);
            const colorCls = tagObj ? `pill-${tagObj.color}` : 'pill-gray';
            return `<span class="pill ${colorCls}">#${t}<button onclick="App.removeTag('${t}')" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;">×</button></span>`;
          }).join('')}
        </div>
        <input type="text" class="form-input" id="entryTagInput" placeholder="Type a tag and press Enter" onkeydown="if(event.key==='Enter'){event.preventDefault();App.addTag(this.value);this.value='';}">
        ${suggestTags.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:var(--space-2);">
          ${suggestTags.map(t => `<button class="pill pill-${t.color}" style="cursor:pointer;" onclick="App.addTag('${t.name}')">#${t.name}</button>`).join('')}
        </div>` : ''}
      </div>
    `;
  }

  let currentTags = [];
  let currentEffort = 'medium';

  function changeEntryType(type) {
    saveFormData();
    entryTypeDraft = type;
    const body = document.getElementById('modalBody');
    const entry = editingEntryId ? { ...State.getEntry(editingEntryId) } : {};
    entry.tags = [...currentTags];
    entry.effort = currentEffort;
    body.innerHTML = renderEntryForm(type, entry);
    refreshIcons();
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

  function refreshTagDisplay() {
    const entry = editingEntryId ? { ...State.getEntry(editingEntryId) } : {};
    entry.tags = [...currentTags];
    entry.effort = currentEffort;
    const body = document.getElementById('modalBody');
    body.innerHTML = renderEntryForm(entryTypeDraft, entry);
    refreshIcons();
  }

  function saveEntry() {
    const title = document.getElementById('entryTitle')?.value?.trim();
    if (!title) { toast('Title is required'); return; }

    const data = {
      type: entryTypeDraft,
      title,
      description: document.getElementById('entryDescription')?.value || '',
      projectId: document.getElementById('entryProject')?.value || null,
      dueDate: document.getElementById('entryDueDate')?.value || null,
      effort: currentEffort,
      priority: document.getElementById('entryPriority')?.value || 'medium',
      estimateMinutes: parseInt(document.getElementById('entryEstimate')?.value) || null,
      tags: [...currentTags],
    };

    if (entryTypeDraft === 'goal') {
      data.targetValue = parseFloat(document.getElementById('entryTarget')?.value) || null;
      data.currentValue = parseFloat(document.getElementById('entryCurrent')?.value) || 0;
      data.unit = document.getElementById('entryUnit')?.value || null;
    }

    if (entryTypeDraft === 'habit') {
      const recType = document.getElementById('entryRecurrence')?.value;
      data.recurrence = recType && recType !== 'none' ? { type: recType, interval: 1 } : null;
    }

    if (editingEntryId) {
      State.updateEntry(editingEntryId, data);
      toast('Entry updated');
    } else {
      State.createEntry(data);
      toast('Entry created');
    }

    currentTags = [];
    currentEffort = 'medium';
    closeModal();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // NEW PROJECT MODAL
  // ═══════════════════════════════════════════════════════════
  function openNewProject() {
    showModal('New Project', `
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" class="form-input" id="projectName" placeholder="e.g. Work, Home, Health" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div class="color-grid" id="projectColorGrid">
          ${State.PROJECT_COLORS.map((c, i) => `<div class="color-swatch ${i === 0 ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="App.selectColor(this)"></div>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Icon</label>
        <div class="icon-grid" id="projectIconGrid">
          ${State.PROJECT_ICONS.map((ic, i) => `<div class="icon-option ${i === 0 ? 'selected' : ''}" data-icon="${ic}" onclick="App.selectIcon(this)"><i data-lucide="${ic}"></i></div>`).join('')}
        </div>
      </div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      `<button class="btn btn-primary" onclick="App.saveProject()">Create</button>`,
    ]);
  }

  let selectedColor = null;
  let selectedIcon = null;

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
    const color = selectedColor || State.PROJECT_COLORS[0];
    const icon = selectedIcon || State.PROJECT_ICONS[0];
    State.createProject({ name, color, icon });
    toast('Project created');
    closeModal();
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // SYNC CONFIG MODAL
  // ═══════════════════════════════════════════════════════════
  function openSyncConfig() {
    const settings = State.getSettings();
    showModal('Firebase Sync', `
      <div class="form-group">
        <label class="form-label">Database URL</label>
        <input type="text" class="form-input" id="syncUrl" value="${settings.sync.databaseUrl || ''}" placeholder="https://your-project.firebaseio.com">
      </div>
      <div class="form-group">
        <label class="form-label">Passphrase (Encryption Key)</label>
        <input type="password" class="form-input" id="syncPass" value="${settings.sync.passphrase || ''}" placeholder="Your secret passphrase">
      </div>
      <div class="form-group">
        <p class="text-xs text-muted" style="line-height:1.6;">
          Your passphrase is used to derive an AES-256-GCM key locally via PBKDF2.
          Data is encrypted before it ever touches the network. The passphrase is never sent to the server.
          Multiple devices sharing the same passphrase will automatically sync.
        </p>
      </div>
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`,
      settings.sync.connected ? `<button class="btn btn-danger" onclick="App.disconnectSync()">Disconnect</button>` : '',
      `<button class="btn btn-primary" onclick="App.connectSync()">Connect</button>`,
    ]);
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
  // QUICK LOG MODAL v2 — shortcuts, check-in, wake/sleep
  // ═══════════════════════════════════════════════════════════
  let quickEmotion = null;
  let quickEnergy = null;

  function openQuickLog() {
    quickEmotion = null;
    quickEnergy = null;
    showModal('Quick Log', renderQuickLogBody(), [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Done</button>`,
    ]);
  }

  function renderQuickLogBody() {
    const shortcuts = State.getSettings().quickShortcuts || [];
    return `
      <div class="form-group">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
          <label class="form-label" style="margin-bottom:0;">Shortcuts</label>
          <button class="btn btn-ghost btn-sm" onclick="App.openManageShortcuts()">${icon('settings-2', 12)}Manage</button>
        </div>
        <div class="shortcut-chips" id="shortcutChips">
          ${shortcuts.map(s => `
            <button class="shortcut-chip" id="sc-${s.id}" onclick="App.useShortcut('${s.id}')">
              <span>${s.emoji}</span><span>${s.label}</span>
              ${s.calories ? `<span class="sc-cal">${s.calories} cal</span>` : ''}
            </button>`).join('')}
          ${shortcuts.length === 0 ? '<p class="text-xs text-faint">No shortcuts yet — add coffee, water, or saved meals via Manage.</p>' : ''}
        </div>
      </div>
      <div class="divider"></div>
      <div class="form-group">
        <label class="form-label">Check-in — how do you feel right now?</label>
        <div class="emotion-selector" id="quickEmotionSel">
          ${['great', 'good', 'okay', 'low', 'bad'].map(e => `
            <button class="emotion-btn" id="qe-${e}" onclick="App.setQuickEmotion('${e}')">
              ${icon(MOOD_ICONS[e], 22)}
              <span class="emotion-label">${e}</span>
            </button>`).join('')}
        </div>
        <label class="form-label" style="margin-top:var(--space-3);">Energy</label>
        <div class="energy-selector" id="quickEnergySel">
          ${[1, 2, 3, 4, 5].map(n => `<button class="energy-btn" id="qen-${n}" onclick="App.setQuickEnergy(${n})" aria-label="Energy ${n}">⚡</button>`).join('')}
        </div>
        <div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);">
          <input type="text" class="form-input" id="checkinNote" placeholder="Optional note…" style="flex:1;">
          <button class="btn btn-primary" onclick="App.logCheckinFromModal()">Log</button>
        </div>
        <p class="text-xs text-faint" style="margin-top:var(--space-2);">Check-ins are timestamped sub-logs. The single Day Mood lives on the Today page.</p>
      </div>
      <div class="divider"></div>
      <div class="form-group">
        <label class="form-label">Wake / Sleep</label>
        <div class="wake-sleep-row">
          <input type="time" class="form-input" id="wakeSleepTime" value="${nowTime()}">
          <button class="btn btn-secondary" onclick="App.logWake()">☀️ Wake</button>
          <button class="btn btn-secondary" onclick="App.logSleep()">🌙 Sleep</button>
        </div>
      </div>
      <div class="divider"></div>
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
      </div>
      <div class="divider"></div>
      <div class="form-group">
        <label class="form-label">Quick Add Task</label>
        <input type="text" class="form-input" id="quickTaskInput" placeholder="Task title..." onkeydown="if(event.key==='Enter'){App.quickAddTask(this.value);this.value='';}">
      </div>
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
      `<div class="log-row"><span class="lr-time">${logTimeOf(l)}</span><span>${describeLog(l)}</span></div>`
    ).join('');
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

  function logWake() {
    const time = document.getElementById('wakeSleepTime')?.value || nowTime();
    State.logWakeSleep('wake', time);
    refreshQuickLogList();
  }

  function logSleep() {
    const time = document.getElementById('wakeSleepTime')?.value || nowTime();
    State.logWakeSleep('sleep', time);
    refreshQuickLogList();
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
            <span>${s.emoji} ${s.label}${s.calories ? ` <span class="text-xs text-faint">· ${s.calories} cal (${s.meal || 'snack'})</span>` : ''}</span>
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
              ${projects.map(p => `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
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
  function openSearch() {
    showModal('Search', `
      <input type="search" class="form-input" id="searchInput" placeholder="Search projects, tasks, habits…"
        autocomplete="off" oninput="App.runSearch(this.value)"
        onkeydown="if(event.key==='Enter'){document.querySelector('.search-result')?.click();}">
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
    const q = (qRaw || '').trim().toLowerCase();
    const el = document.getElementById('searchResults');
    if (!el) return;

    // Inside a project? Its tasks get boosted to the top.
    const ctxProject = (currentTab === 'projects' && projectFilter && projectFilter !== 'none') ? projectFilter : null;
    const results = [];

    State.getProjects().forEach(p => {
      const s = q ? fuzzyScore(q, p.name) : 10;
      if (s >= 0) results.push({ kind: 'project', id: p.id, title: p.name, color: p.color, score: s + 10, context: 'project' });
    });

    State.getEntries().forEach(e => {
      const hay = e.title + ' ' + (e.tags || []).join(' ');
      let s = q ? fuzzyScore(q, hay) : (e.type === 'task' && !e.completed ? 5 : -1);
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
      el.innerHTML = `<p class="text-xs text-faint" style="padding:var(--space-2);">No matches for "${qRaw}".</p>`;
      return;
    }

    const typeIcons = { project: 'folder-kanban', goal: 'target', task: 'list-checks', habit: 'repeat', reminder: 'clock', checkin: 'brain' };
    el.innerHTML = top.map(r => `
      <button class="search-result" onclick="App.searchGo('${r.kind}','${r.id}')">
        ${icon(typeIcons[r.kind === 'project' ? 'project' : r.type] || 'list-checks', 14)}
        <span class="proj-dot" style="background:${r.color || 'var(--text-faint)'}"></span>
        <span class="sr-title ${r.completed ? 'completed' : ''}">${r.title}</span>
        <span class="sr-context">${r.context}</span>
      </button>
    `).join('');
    refreshIcons();
  }

  function searchGo(kind, id) {
    closeModal();
    if (kind === 'project') {
      projectFilter = id;
      switchTab('projects');
    } else {
      editEntry(id);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONFLICT MODAL
  // ═══════════════════════════════════════════════════════════
  function showConflictModal(localData, serverData) {
    showModal('Sync Conflict', `
      <p class="text-sm text-muted" style="margin-bottom:var(--space-3);">
        Your local data and the server have diverged. Choose how to resolve:
      </p>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        <div class="card card-interactive" onclick="App.resolveConflict('local')">
          <div style="font-weight:600;margin-bottom:var(--space-1);">Keep Local</div>
          <div class="text-xs text-muted">Use your device's data and overwrite server</div>
        </div>
        <div class="card card-interactive" onclick="App.resolveConflict('server')">
          <div style="font-weight:600;margin-bottom:var(--space-1);">Take Server</div>
          <div class="text-xs text-muted">Replace local data with server version</div>
        </div>
        <div class="card card-interactive" onclick="App.resolveConflict('merge')">
          <div style="font-weight:600;margin-bottom:var(--space-1);">Merge Both</div>
          <div class="text-xs text-muted">Keep server entries, add local-only entries</div>
        </div>
      </div>
    `, []);
  }

  async function resolveConflict(resolution) {
    await Sync.resolveConflict(resolution, null);
    closeModal();
    render();
    toast('Conflict resolved');
  }

  // ═══════════════════════════════════════════════════════════
  // MODAL SYSTEM
  // ═══════════════════════════════════════════════════════════
  function showModal(title, bodyHtml, footerHtml = []) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml.join('');
    document.getElementById('modalOverlay').classList.add('active');
    refreshIcons();
    setTimeout(() => document.getElementById('entryTitle')?.focus(), 100);
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    editingEntryId = null;
    editingBlockId = null;
  }

  function closePanel() {
    document.getElementById('panelOverlay').classList.remove('active');
    // Slide panel carries its own .active transform (see Timers.openPanel)
    document.getElementById('slidePanel').classList.remove('active');
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRY ACTIONS
  // ═══════════════════════════════════════════════════════════
  function toggleEntry(id) {
    State.toggleComplete(id);
    render();
  }

  function archiveEntry(id) {
    State.archiveEntry(id);
    toast('Archived — find it under History');
    closeModal();
    render();
  }

  function unarchiveEntry(id) {
    State.unarchiveEntry(id);
    render();
  }

  function deleteEntry(id) {
    if (!confirm('Delete this entry permanently? Archive keeps it recoverable.')) return;
    State.deleteEntry(id);
    toast('Entry deleted');
    closeModal();
    render();
  }

  function startTimerForTask(id) {
    Timers.openPanel();
    setTimeout(() => Timers.startTracking(id), 300);
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
    // The synced copy is a separate encrypted blob on Firebase — if it isn't
    // erased too, reconnecting with the same passphrase restores everything.
    if (settings.sync.databaseUrl && settings.sync.passphrase) {
      if (confirm('Also erase the synced copy on Firebase? Recommended — otherwise reconnecting with the same passphrase will bring the old data back.')) {
        toast('Erasing cloud copy…');
        const result = await Sync.eraseRemote();
        if (!result.success) {
          if (!confirm(`Cloud erase failed (${result.error}). Reset local data anyway? The server copy will remain.`)) return;
        }
      } else {
        // At minimum stop the pending debounced push from re-uploading
        Sync.disconnect();
      }
    }
    try { (globalThis['loc'+'alSt'+'orage']).removeItem('cade.project.v1'); } catch(e) {}
    location.reload();
  }

  // ═══════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════
  function init() {
    initTheme();

    // Tab navigation
    document.querySelectorAll('.tab-item').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.tab));
    });

    // FAB
    document.getElementById('fabBtn').addEventListener('click', () => openNewEntry('task'));

    // Theme toggle
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    // Search
    document.getElementById('searchBtn').addEventListener('click', openSearch);

    // Modal close
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeModal();
    });

    // Panel close
    document.getElementById('panelClose').addEventListener('click', closePanel);
    document.getElementById('panelOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'panelOverlay') closePanel();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closePanel(); closePopover(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); openNewEntry('task'); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
    });

    // Auto-connect sync
    Sync.autoConnect();
    Sync.updateStatus();

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
    addTag, removeTag,
    openNewProject, selectColor, selectIcon, saveProject,
    openSyncConfig, connectSync, disconnectSync,
    openQuickLog, openCalorieLog, logCaloriesFromModal, quickAddTask, logEmotion,
    useShortcut, setQuickEmotion, setQuickEnergy, logCheckinFromModal, logWake, logSleep,
    openManageShortcuts, addShortcut, deleteShortcut,
    openManageTags, cycleTagColor, renameTag, setTagProject, deleteTagPrompt, createTagFromManager,
    openSearch, runSearch, searchGo,
    logFood, deleteFoodLog, useShortcutHealth,
    toggleEntry, deleteEntry, archiveEntry, unarchiveEntry, startTimerForTask,
    setProjectFilter, selectHabit, toggleHabitCell,
    setInsightsProject, setInsightsEntry, setFocusProject,
    qDragStart, qDragEnd, qDragOver, qDragLeave, qDrop, qItemClick,
    plannerNav, plannerToday, setPlannerView, plannerTap,
    popoverAgenda, popoverTask, popoverTimer,
    openAgendaModal, saveAgendaBlock, deleteAgendaBlock, editPlannerBlock,
    historyNav, historyToday,
    updateTimerSetting, updateCalorieGoal,
    exportData, importData, confirmReset,
    showModal, closeModal, closePanel,
    showConflictModal, resolveConflict,
  };
})();

// Boot
document.addEventListener('DOMContentLoaded', App.init);
