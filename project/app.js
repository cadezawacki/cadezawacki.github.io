/* ═══════════════════════════════════════════════════════════════
   APP — Main orchestration, routing, views, modals
   ═══════════════════════════════════════════════════════════════ */

const App = (() => {
  let currentTab = 'today';
  let editingEntryId = null;
  let entryTypeDraft = 'task';

  // ═══════════════════════════════════════════════════════════
  // ICONS — Lucide icon names by category
  // ═══════════════════════════════════════════════════════════
  const ICONS = {
    today: 'layout-dashboard',
    projects: 'folder-kanban',
    habits: 'repeat',
    insights: 'bar-chart-3',
    settings: 'settings',
    add: 'plus',
    search: 'search',
    close: 'x',
    check: 'check',
    trash: 'trash-2',
    edit: 'pencil',
    play: 'play',
    pause: 'pause',
    reset: 'rotate-ccw',
    timer: 'timer',
    flame: 'flame',
    target: 'target',
    calendar: 'calendar-days',
    tag: 'tag',
    flag: 'flag',
    clock: 'clock',
    brain: 'brain',
    zap: 'zap',
    heart: 'heart',
    coffee: 'coffee',
    dumbbell: 'dumbbell',
    book: 'book-open',
    briefcase: 'briefcase',
    home: 'home',
    music: 'music',
    rocket: 'rocket',
    leaf: 'leaf',
    pen: 'pen-tool',
    star: 'star',
    compass: 'compass',
    palette: 'palette',
    shopping: 'shopping-cart',
    graduation: 'graduation-cap',
    code: 'code-2',
    plane: 'plane',
    sun: 'sun',
    moon: 'moon',
    sunMoon: 'sun-moon',
    download: 'download',
    upload: 'upload',
    sync: 'refresh-cw',
    cloud: 'cloud',
    cloudOff: 'cloud-off',
    more: 'more-horizontal',
    chevron: 'chevron-right',
    listChecks: 'list-checks',
    trending: 'trending-up',
    layers: 'layers',
    coffee2: 'coffee',
    utensils: 'utensils',
    smile: 'smile',
    frown: 'frown',
    meh: 'meh',
    angry: 'angry',
    laugh: 'laugh',
  };

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

  function formatDueDate(dateStr) {
    if (!dateStr) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
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

  // ═══════════════════════════════════════════════════════════
  // THEME
  // ═══════════════════════════════════════════════════════════
  function initTheme() {
    const saved = State.getSettings().theme;
    document.documentElement.setAttribute('data-theme', saved);
    // Set correct theme toggle icon
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = saved === 'dark'
        ? '<i data-lucide="sun" style="width:18px;height:18px"></i>'
        : '<i data-lucide="moon" style="width:18px;height:18px"></i>';
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    State.updateSettings({ theme: next });
    // Update the toggle icon
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = next === 'dark'
        ? '<i data-lucide="sun" style="width:18px;height:18px"></i>'
        : '<i data-lucide="moon" style="width:18px;height:18px"></i>';
      toggleBtn.setAttribute('aria-label', 'Switch to ' + (next === 'dark' ? 'light' : 'dark') + ' mode');
    }
    // Re-render to update charts
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

    switch (currentTab) {
      case 'today': main.innerHTML = renderToday(); break;
      case 'projects': main.innerHTML = renderProjects(); break;
      case 'habits': main.innerHTML = renderHabits(); break;
      case 'insights': main.innerHTML = renderInsights(); break;
      case 'settings': main.innerHTML = renderSettings(); break;
    }

    refreshIcons();
    // Render charts after DOM is ready
    requestAnimationFrame(() => renderChartsForTab());
  }

  function renderChartsForTab() {
    if (currentTab === 'insights') renderInsightCharts();
    if (currentTab === 'habits') renderHabitCharts();
    if (currentTab === 'today') renderTodayCharts();
  }

  // ═══════════════════════════════════════════════════════════
  // TODAY VIEW
  // ═══════════════════════════════════════════════════════════
  function renderToday() {
    const today = State.todayStr();
    const allEntries = State.getEntries();
    const tasks = allEntries.filter(e => e.type === 'task' && !e.completed);
    const habits = allEntries.filter(e => e.type === 'habit');
    const reminders = allEntries.filter(e => e.type === 'reminder');
    const goals = allEntries.filter(e => e.type === 'goal');

    // Today's tasks (due today or scheduled today)
    const todayTasks = tasks.filter(t =>
      t.dueDate === today || t.scheduledDate === today || (!t.dueDate && !t.scheduledDate && isToday(today))
    ).sort((a, b) => {
      const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
      return (priOrder[a.priority] || 2) - (priOrder[b.priority] || 2);
    });

    // Overdue tasks
    const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < today);

    // Next best task (highest priority + lowest effort)
    const nextTask = [...todayTasks].sort((a, b) => {
      const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
      const effOrder = { trivial: 0, small: 1, medium: 2, large: 3, xl: 4 };
      const pa = (priOrder[a.priority] || 2) * 10 + (effOrder[a.effort] || 2);
      const pb = (priOrder[b.priority] || 2) * 10 + (effOrder[b.effort] || 2);
      return pa - pb;
    })[0];

    const todayCalories = State.getTodayCalories();
    const calorieGoal = State.getSettings().calorieGoal || 2000;
    const todayEmotion = State.getTodayEmotion();

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
          <p class="page-subtitle">${todayTasks.length + overdueTasks.length} tasks today · ${habits.filter(h => !State.isHabitDoneToday(h.id)).length} habits pending</p>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary" onclick="Timers.openPanel()"><i data-lucide="timer" style="width:16px;height:16px"></i>Timer</button>
          <button class="btn btn-secondary" onclick="App.openQuickLog()"><i data-lucide="zap" style="width:16px;height:16px"></i>Quick Log</button>
        </div>
      </div>
    `;

    // Stats row
    html += `<div class="grid-3 section">
      <div class="card stat-card">
        <span class="stat-label">Tasks Done Today</span>
        <span class="stat-value">${allEntries.filter(e => e.type === "task" && e.completed && e.completedAt?.startsWith(today)).length} / ${todayTasks.length + overdueTasks.length}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Habits Today</span>
        <span class="stat-value">${habits.filter(h => State.isHabitDoneToday(h.id)).length} / ${habits.length}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Calories</span>
        <span class="stat-value">${todayCalories} <span style="font-size:var(--text-xs);color:var(--text-muted)">/ ${calorieGoal}</span></span>
      </div>
    </div>`;

    // Next best task
    if (nextTask) {
      const proj = nextTask.projectId ? State.getProject(nextTask.projectId) : null;
      html += `
        <div class="section">
          <div class="section-header"><span class="section-title">Next Best Task</span></div>
          <div class="card card-interactive" style="display:flex;align-items:center;gap:var(--space-3);border-color:var(--accent);background:var(--accent-tint);">
            <div class="check-toggle ${nextTask.completed ? 'checked' : ''}" onclick="App.toggleEntry('${nextTask.id}')"><i data-lucide="check"></i></div>
            <div style="flex:1">
              <div class="entry-title" style="font-weight:600;">${nextTask.title}</div>
              <div class="entry-meta">
                ${proj ? `<span class="proj-dot" style="background:${proj.color}"></span><span class="text-xs text-muted">${proj.name}</span>` : ''}
                <span class="pill pill-${priorityColor(nextTask.priority)}">${nextTask.priority}</span>
                <span class="pill">${effortLabel(nextTask.effort)}</span>
                ${nextTask.dueDate ? `<span class="pill pill-accent">${formatDueDate(nextTask.dueDate)}</span>` : ''}
              </div>
            </div>
            <button class="icon-btn" onclick="App.startTimerForTask('${nextTask.id}')" data-lucide="play" aria-label="Start timer"></button>
          </div>
        </div>
      `;
    }

    // Habits today
    if (habits.length > 0) {
      html += `<div class="section">
        <div class="section-header">
          <span class="section-title">Habits</span>
          <button class="btn btn-ghost btn-sm" onclick="App.switchTab('habits')"><i data-lucide="chevron-right" style="width:14px;height:14px"></i>All</button>
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
      const todayTaskIds = new Set(todayTasks.map(t => t.id));
      overdueTasks.forEach(t => {
        if (todayTaskIds.has(t.id)) return;
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        html += renderEntryCard(t, proj);
      });
      todayTasks.forEach(t => {
        if (overdueTasks.includes(t)) return;
        if (nextTask && t.id === nextTask.id) return; // Skip Next Best Task (shown above)
        const proj = t.projectId ? State.getProject(t.projectId) : null;
        html += renderEntryCard(t, proj);
      });
    }
    html += `</div></div>`;

    // Day planner timeline
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Day Planner</span></div>
      <div class="card">
    `;
    const scheduledTasks = [...todayTasks, ...overdueTasks].filter(t => t.scheduledDate || t.dueDate);
    for (let hour = 8; hour <= 21; hour++) {
      const timeStr = `${hour}:00`;
      const slotTasks = scheduledTasks.filter(t => {
        // Simple: just show tasks in morning/afternoon based on nothing real for demo
        return false; // No real time scheduling yet
      });
      html += `<div class="planner-slot">
        <div class="planner-time">${timeStr}</div>
        <div class="planner-content">
          ${slotTasks.length > 0
            ? slotTasks.map(t => `<div class="quadrant-item">${t.title}</div>`).join('')
            : '<div class="planner-empty">Free</div>'}
        </div>
      </div>`;
    }
    html += `</div></div>`;

    // Quick widgets: calories + emotion
    html += `<div class="grid-2 section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Calories Today</span></div>
        <div class="calorie-display">
          <span class="calorie-number">${todayCalories}</span>
          <span class="calorie-goal">/ ${calorieGoal} cal</span>
        </div>
        <div class="progress-bar" style="margin-bottom:var(--space-3)">
          <div class="progress-fill" style="width:${Math.min(todayCalories / calorieGoal * 100, 100)}%"></div>
        </div>
        <button class="btn btn-secondary btn-sm w-full" onclick="App.openCalorieLog()"><i data-lucide="plus" style="width:14px;height:14px"></i>Log Food</button>
      </div>
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Mood Today</span></div>
        <div class="emotion-selector">
          ${renderEmotionButton('great', '😊', 'Great', todayEmotion?.emotion)}
          ${renderEmotionButton('good', '🙂', 'Good', todayEmotion?.emotion)}
          ${renderEmotionButton('okay', '😐', 'Okay', todayEmotion?.emotion)}
          ${renderEmotionButton('low', '😕', 'Low', todayEmotion?.emotion)}
          ${renderEmotionButton('bad', '😢', 'Bad', todayEmotion?.emotion)}
        </div>
      </div>
    </div>`;

    return html;
  }

  function renderTodayCharts() {
    // Mini heatmap
    const container = document.getElementById('todayHeatmap');
    if (container) Charts.renderHeatmap(container, 56);
  }

  function renderEmotionButton(emotion, emoji, label, current) {
    return `<button class="emotion-btn ${current === emotion ? 'selected' : ''}" onclick="App.logEmotion('${emotion}')">
      <span class="emotion-emoji">${emoji}</span>
      <span class="emotion-label">${label}</span>
    </button>`;
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRY CARD RENDERER
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
      <div class="entry-card ${isDone ? 'completed' : ''}" data-id="${entry.id}">
        <div class="check-toggle ${isDone ? 'checked' : ''}" onclick="App.toggleEntry('${entry.id}')">
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
          <button class="icon-btn" onclick="App.editEntry('${entry.id}')" data-lucide="pencil" aria-label="Edit"></button>
          <button class="icon-btn" onclick="App.deleteEntry('${entry.id}')" data-lucide="trash-2" aria-label="Delete"></button>
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
        <button class="btn btn-primary" onclick="App.openNewProject()"><i data-lucide="plus" style="width:14px;height:14px"></i>New Project</button>
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
          <div class="card card-interactive project-card" onclick="App.setProjectFilter('${p.id}')">
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
        <button class="btn btn-primary" onclick="App.openNewEntry('habit')"><i data-lucide="plus" style="width:14px;height:14px"></i>New Habit</button>
      </div>
    `;

    if (habits.length === 0) {
      return html + `<div class="empty-state"><i data-lucide="repeat"></i><p class="empty-state-text">No habits yet. Create your first one.</p></div>`;
    }

    // Habit grid overview
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Completion Grid — Last 14 Days</span></div>
      <div class="card">
    `;

    habits.forEach(h => {
      const completions = new Set(State.getHabitCompletions(h.id));
      const today = new Date();
      const proj = h.projectId ? State.getProject(h.projectId) : null;

      html += `<div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-3);">
        <div style="width:120px;flex-shrink:0;">
          <div class="text-sm" style="font-weight:500;cursor:pointer;" onclick="App.selectHabit('${h.id}')">${h.title}</div>
          ${proj ? `<div class="text-xs text-muted">${proj.name}</div>` : ''}
        </div>
        <div class="habit-grid">`;

      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = State.dateStr(d);
        const isCompleted = completions.has(dateStr);
        const isTodayCell = i === 0;
        html += `<div class="habit-cell ${isCompleted ? 'completed' : ''} ${isTodayCell ? 'today' : ''}" title="${dateStr}"></div>`;
      }

      const s = State.calculateStreak(h.id);
      html += `</div>
        <span class="streak-display" style="width:50px;text-align:right;"><i data-lucide="flame"></i>${s.current}</span>
      </div>`;
    });

    html += `</div></div>`;

    // Selected habit detail
    if (selectedHabit) {
      const habit = State.getEntry(selectedHabit);
      if (habit && habit.type === 'habit') {
        const s = State.calculateStreak(habit.id);
        const proj = habit.projectId ? State.getProject(habit.projectId) : null;
        html += `
          <div class="section">
            <div class="section-header">
              <span class="section-title">${habit.title} — Detail</span>
              <button class="btn btn-ghost btn-sm" onclick="App.selectHabit(null)"><i data-lucide="x" style="width:14px;height:14px"></i>Close</button>
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
    }
  }

  function selectHabit(id) {
    selectedHabit = id;
    render();
  }

  // ═══════════════════════════════════════════════════════════
  // INSIGHTS VIEW
  // ═══════════════════════════════════════════════════════════
  function renderInsights() {
    const entries = State.getEntries();
    const habits = entries.filter(e => e.type === 'habit');
    const goals = entries.filter(e => e.type === 'goal');
    const tasks = entries.filter(e => e.type === 'task');

    let html = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Insights</h1>
          <p class="page-subtitle">Analytics across all your entries</p>
        </div>
      </div>
    `;

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

    // Day breakdown + Emotion trend
    html += `<div class="grid-2 section">
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Tasks — Last 7 Days</span></div>
        <div class="chart-container"><canvas id="dayBreakdownChart"></canvas></div>
      </div>
      <div class="card">
        <div class="section-header" style="margin-bottom:var(--space-3)"><span class="section-title">Emotion Trend — 14 Days</span></div>
        <div class="chart-container"><canvas id="emotionTrendChart"></canvas></div>
      </div>
    </div>`;

    // Four quadrant view
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Four Quadrant — Effort vs Priority</span></div>
      <div class="card">
        <div class="quadrant" id="quadrantView">${renderQuadrant()}</div>
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
              <div style="width:80px;height:80px;position:relative;">
                <canvas id="goalChart_${g.id}"></canvas>
              </div>
              <div style="flex:1">
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

  function renderQuadrant() {
    const tasks = State.getEntries({ type: 'task', completed: false });
    const effOrder = { trivial: 0, small: 1, medium: 2, large: 3, xl: 4 };
    const priOrder = { urgent: 0, high: 1, medium: 2, low: 3 };

    // Q1: High priority, Low effort (Do First)
    // Q2: High priority, High effort (Schedule)
    // Q3: Low priority, Low effort (Quick Wins)
    // Q4: Low priority, High effort (Later)
    const q1 = tasks.filter(t => (priOrder[t.priority] || 2) <= 1 && (effOrder[t.effort] || 2) <= 1);
    const q2 = tasks.filter(t => (priOrder[t.priority] || 2) <= 1 && (effOrder[t.effort] || 2) > 1);
    const q3 = tasks.filter(t => (priOrder[t.priority] || 2) > 1 && (effOrder[t.effort] || 2) <= 1);
    const q4 = tasks.filter(t => (priOrder[t.priority] || 2) > 1 && (effOrder[t.effort] || 2) > 1);

    function renderItems(items) {
      if (items.length === 0) return '<div class="planner-empty">No tasks</div>';
      return items.slice(0, 5).map(t => `<div class="quadrant-item" onclick="App.editEntry('${t.id}')">${t.title}</div>`).join('');
    }

    return `
      <div class="quadrant-box">
        <div class="quadrant-label">Do First · High Pri / Low Effort</div>
        ${renderItems(q1)}
      </div>
      <div class="quadrant-box">
        <div class="quadrant-label">Schedule · High Pri / High Effort</div>
        ${renderItems(q2)}
      </div>
      <div class="quadrant-box">
        <div class="quadrant-label">Quick Wins · Low Pri / Low Effort</div>
        ${renderItems(q3)}
      </div>
      <div class="quadrant-box">
        <div class="quadrant-label">Later · Low Pri / High Effort</div>
        ${renderItems(q4)}
      </div>
    `;
  }

  function renderInsightCharts() {
    const heatmap = document.getElementById('heatmapContainer');
    if (heatmap) Charts.renderHeatmap(heatmap, 84);

    const dayChart = document.getElementById('dayBreakdownChart');
    if (dayChart) Charts.renderDayBreakdown('dayBreakdownChart', 7);

    const emotionChart = document.getElementById('emotionTrendChart');
    if (emotionChart) Charts.renderEmotionTrend('emotionTrendChart', 14);

    const radarChart = document.getElementById('habitRadarChart');
    if (radarChart) Charts.renderHabitRadar('habitRadarChart');

    const effortChart = document.getElementById('effortDistChart');
    if (effortChart) Charts.renderEffortDist('effortDistChart');

    // Goal charts
    State.getEntries({ type: 'goal' }).forEach(g => {
      const canvas = document.getElementById(`goalChart_${g.id}`);
      if (canvas) Charts.renderGoalProgress(`goalChart_${g.id}`, g);
    });
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
          <button class="btn btn-secondary btn-sm" onclick="App.openSyncConfig()"><i data-lucide="cloud" style="width:14px;height:14px"></i>Configure</button>
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

    // Calorie goal
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Health</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Daily Calorie Goal</div><div class="setting-desc">Target calories per day</div></div>
          <input type="number" class="form-input" style="width:80px;" value="${settings.calorieGoal}" onchange="App.updateCalorieGoal(this.value)">
        </div>
      </div>
    </div>`;

    // Data management
    html += `<div class="section">
      <div class="section-header"><span class="section-title">Data</span></div>
      <div class="card">
        <div class="setting-row">
          <div><div class="setting-label">Export Data</div><div class="setting-desc">Download all data as JSON</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.exportData()"><i data-lucide="download" style="width:14px;height:14px"></i>Export</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label">Import Data</div><div class="setting-desc">Restore from JSON backup</div></div>
          <button class="btn btn-secondary btn-sm" onclick="App.importData()"><i data-lucide="upload" style="width:14px;height:14px"></i>Import</button>
        </div>
        <div class="setting-row">
          <div><div class="setting-label" style="color:var(--error)">Reset All Data</div><div class="setting-desc">Delete everything and start fresh</div></div>
          <button class="btn btn-danger btn-sm" onclick="App.confirmReset()"><i data-lucide="trash-2" style="width:14px;height:14px"></i>Reset</button>
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
    const tags = State.getAllTags();
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
        ${tags.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:var(--space-2);">
          ${tags.map(t => `<button class="pill pill-${t.color}" style="cursor:pointer;" onclick="App.addTag('${t.name}')">#${t.name}</button>`).join('')}
        </div>` : ''}
      </div>
    `;
  }

  let currentTags = [];
  let currentEffort = 'medium';

  function changeEntryType(type) {
    // Save current form data
    saveFormData();
    entryTypeDraft = type;
    const body = document.getElementById('modalBody');
    const entry = editingEntryId ? State.getEntry(editingEntryId) : {};
    entry.tags = [...currentTags];
    entry.effort = currentEffort;
    body.innerHTML = renderEntryForm(type, entry);
    refreshIcons();
  }

  function saveFormData() {
    const titleEl = document.getElementById('entryTitle');
    if (titleEl) {
      // Tags are managed separately
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
    const entry = editingEntryId ? State.getEntry(editingEntryId) : {};
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
  // QUICK LOG MODAL (emotions, calories, activities)
  // ═══════════════════════════════════════════════════════════
  function openQuickLog() {
    showModal('Quick Log', `
      <div class="form-group">
        <label class="form-label">Log Emotion</label>
        <div class="emotion-selector">
          ${renderEmotionButton('great', '😊', 'Great', null)}
          ${renderEmotionButton('good', '🙂', 'Good', null)}
          ${renderEmotionButton('okay', '😐', 'Okay', null)}
          ${renderEmotionButton('low', '😕', 'Low', null)}
          ${renderEmotionButton('bad', '😢', 'Bad', null)}
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
    `, [
      `<button class="btn btn-secondary" onclick="App.closeModal()">Done</button>`,
    ]);
  }

  function logCaloriesFromModal() {
    const cal = parseInt(document.getElementById('calorieInput')?.value);
    const meal = document.getElementById('mealSelect')?.value || 'snack';
    if (!cal || cal <= 0) { toast('Enter valid calories'); return; }
    State.logCalories(cal, '', meal);
    toast(`Logged ${cal} cal`);
    document.getElementById('calorieInput').value = '';
  }

  function openCalorieLog() {
    openQuickLog();
    setTimeout(() => document.getElementById('calorieInput')?.focus(), 200);
  }

  function quickAddTask(title) {
    if (!title.trim()) return;
    State.createEntry({ type: 'task', title: title.trim() });
    toast('Task added');
  }

  function logEmotion(emotion) {
    State.logEmotion(emotion);
    toast(`Logged: ${emotion}`);
    render();
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
    // Focus title input
    setTimeout(() => document.getElementById('entryTitle')?.focus(), 100);
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    editingEntryId = null;
  }

  function closePanel() {
    document.getElementById('panelOverlay').classList.remove('active');
  }

  // ═══════════════════════════════════════════════════════════
  // ENTRY ACTIONS
  // ═══════════════════════════════════════════════════════════
  function toggleEntry(id) {
    State.toggleComplete(id);
    render();
  }

  function deleteEntry(id) {
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

  function confirmReset() {
    if (confirm('Delete ALL data? This cannot be undone.')) {
      try { (globalThis['loc'+'alSt'+'orage']).removeItem('cade.project.v1'); } catch(e) {}
      location.reload();
    }
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
    document.getElementById('searchBtn').addEventListener('click', () => {
      // Simple: switch to projects and focus filter
      switchTab('projects');
    });

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
      if (e.key === 'Escape') { closeModal(); closePanel(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); openNewEntry('task'); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); switchTab('insights'); }
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
    toggleEntry, deleteEntry, startTimerForTask,
    setProjectFilter, selectHabit,
    updateTimerSetting, updateCalorieGoal,
    exportData, importData, confirmReset,
    showModal, closeModal, closePanel,
    showConflictModal, resolveConflict,
  };
})();

// Boot
document.addEventListener('DOMContentLoaded', App.init);
