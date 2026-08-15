/* ═══════════════════════════════════════════════════════════════
   CHARTS — Heatmaps, goal progress, habit strength, quadrant
   Uses Chart.js + custom SVG/Canvas renderers
   ═══════════════════════════════════════════════════════════════ */

const Charts = (() => {
  const chartInstances = {};

  function destroy(key) {
    if (chartInstances[key]) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
  }

  function destroyAll() {
    Object.values(chartInstances).forEach(c => c.destroy());
    Object.keys(chartInstances).forEach(k => delete chartInstances[k]);
  }

  function getColors() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    // accent follows the user's chosen theme (Settings → Appearance)
    const cs = getComputedStyle(document.documentElement);
    return {
      text: isDark ? '#8a8782' : '#6b6863',
      grid: isDark ? '#383735' : '#e0ddd7',
      accent: (cs.getPropertyValue('--accent') || '#0f9598').trim() || '#0f9598',
      accentHover: (cs.getPropertyValue('--accent-hover') || '#12b3b7').trim() || '#12b3b7',
      surface: isDark ? '#1c1b1a' : '#ffffff',
      faint: isDark ? '#5a5854' : '#a8a59f',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CALENDAR HEATMAP (GitHub-style contribution graph)
  // ═══════════════════════════════════════════════════════════
  // Optional filter: { projectId, entryId } scopes counts to a project/task.
  // Project filters roll up sub-projects and honor multi-project entries.
  function matchesFilter(entry, filter) {
    if (!filter) return true;
    if (filter.entryId && entry?.id !== filter.entryId) return false;
    if (filter.projectId) {
      if (!entry) return false;
      const subtree = State.getProjectSubtreeIds(filter.projectId);
      if (!State.entryProjectIds(entry).some(pid => subtree.includes(pid))) return false;
    }
    return true;
  }

  // "Year in Pixels": weekday-aligned columns (GitHub-style), month labels,
  // click → History. Two lenses: 'activity' (habits + tasks + tracked time
  // + quick logs, accent intensity) and 'mood' (daily average, red → green).
  function renderHeatmap(container, days = 364, filter = null, mode = 'activity') {
    const todayStr = State.todayStr();

    // Activity score per day, with a per-source breakdown for the tooltip
    const detail = {}; // date → {habits, tasks, minutes, logs}
    const bump = (date, key, amt = 1) => {
      (detail[date] = detail[date] || { habits: 0, tasks: 0, minutes: 0, logs: 0 })[key] += amt;
    };
    State.getLogs().forEach(l => {
      if (l.type === 'habit_completion') {
        const entry = l.entryId ? State.getEntry(l.entryId) : null;
        if (matchesFilter(entry, filter)) bump(l.date, 'habits');
      } else if (l.type === 'time_session') {
        const entry = l.entryId ? State.getEntry(l.entryId) : null;
        if (!filter || matchesFilter(entry, filter)) bump(l.date, 'minutes', (l.value || 0) / 60);
      } else if (!filter && (l.type === 'emotion' || l.type === 'checkin' || l.type === 'calorie' || l.type === 'post')) {
        if (l.date) bump(l.date, 'logs');
      }
    });
    State.getEntries({ includeArchived: true }).forEach(e => {
      if (e.type !== 'habit' && e.completed && e.completedAt && matchesFilter(e, filter)) {
        bump(e.completedAt.split('T')[0], 'tasks');
      }
    });
    const scoreOf = (d) => {
      const x = detail[d];
      return x ? x.habits + x.tasks * 1.5 + x.minutes / 30 + x.logs * 0.25 : 0;
    };
    const maxScore = Math.max(...Object.keys(detail).map(scoreOf), 1);

    // Mood per day (mode 'mood') — project filters don't apply to feelings
    const EMO = { great: 5, good: 4, okay: 3, low: 2, bad: 1 };
    const MOOD_NAMES = ['', 'Bad', 'Low', 'Okay', 'Good', 'Great'];
    const moodByDate = {};
    if (mode === 'mood') {
      State.getLogs().forEach(l => {
        if ((l.type === 'emotion' || l.type === 'checkin') && l.emotion && l.date) {
          (moodByDate[l.date] = moodByDate[l.date] || []).push(EMO[l.emotion] || 3);
        }
      });
    }

    // Column = calendar week starting Sunday, ending at today's week
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    start.setDate(start.getDate() - start.getDay()); // back to its Sunday
    start.setHours(0, 0, 0, 0);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let cols = '';
    let months = '';
    let lastMonth = -1;
    const cursor = new Date(start);
    while (State.dateStr(cursor) <= todayStr) {
      // month label above the column that contains the 1st
      const weekEnd = new Date(cursor); weekEnd.setDate(weekEnd.getDate() + 6);
      const m = cursor.getDate() <= 7 && cursor.getMonth() !== lastMonth ? cursor.getMonth()
        : (weekEnd.getMonth() !== cursor.getMonth() && weekEnd.getDate() <= 7 ? weekEnd.getMonth() : -1);
      if (m >= 0 && m !== lastMonth) { months += `<span class="heatmap-month">${monthNames[m]}</span>`; lastMonth = m; }
      else months += '<span class="heatmap-month"></span>';

      let colHtml = '';
      for (let d = 0; d < 7; d++) {
        const dateStr = State.dateStr(cursor);
        if (dateStr > todayStr) {
          colHtml += '<div class="heatmap-cell future"></div>';
        } else {
          let level = '', tip = '';
          if (mode === 'mood') {
            const moods = moodByDate[dateStr];
            if (moods?.length) {
              const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
              level = `m${Math.min(5, Math.max(1, Math.round(avg)))}`;
              tip = `${dateStr} — ${MOOD_NAMES[Math.round(avg)]} (${avg.toFixed(1)}) · ${moods.length} log${moods.length === 1 ? '' : 's'}`;
            } else {
              tip = `${dateStr} — no mood logged`;
            }
          } else {
            const x = detail[dateStr];
            const score = scoreOf(dateStr);
            level = score === 0 ? '' : score <= maxScore * 0.25 ? 'l1' : score <= maxScore * 0.5 ? 'l2' : score <= maxScore * 0.75 ? 'l3' : 'l4';
            const bits = [];
            if (x?.habits) bits.push(`${x.habits} habit${x.habits === 1 ? '' : 's'}`);
            if (x?.tasks) bits.push(`${x.tasks} task${x.tasks === 1 ? '' : 's'}`);
            if (x?.minutes >= 1) bits.push(`${Math.round(x.minutes)}m focused`);
            if (x?.logs) bits.push(`${x.logs} log${x.logs === 1 ? '' : 's'}`);
            tip = `${dateStr}${bits.length ? ' — ' + bits.join(' · ') : ' — nothing logged'}`;
          }
          const isToday = dateStr === todayStr;
          colHtml += `<div class="heatmap-cell ${level}" title="${tip}" onclick="App.openHistoryDay('${dateStr}')" style="${isToday ? 'box-shadow:0 0 0 1px var(--text-faint);' : ''}"></div>`;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      cols += `<div class="heatmap-col">${colHtml}</div>`;
    }

    container.innerHTML = `
      <div class="heatmap-scroll" id="heatmapScroll">
        <div class="heatmap-months">${months}</div>
        <div class="heatmap">${cols}</div>
      </div>
      <div class="heatmap-labels">
        <span>${Math.round(days / 30.4)} months ago</span>
        ${mode === 'mood'
          ? `<span class="heatmap-legend">bad <i class="hm-swatch m1"></i><i class="hm-swatch m2"></i><i class="hm-swatch m3"></i><i class="hm-swatch m4"></i><i class="hm-swatch m5"></i> great</span>`
          : `<span class="heatmap-legend">less <i class="hm-swatch"></i><i class="hm-swatch l1"></i><i class="hm-swatch l2"></i><i class="hm-swatch l3"></i><i class="hm-swatch l4"></i> more</span>`}
        <span>Today</span>
      </div>`;
    // land scrolled to the present, not eleven months ago
    const scroll = container.querySelector('#heatmapScroll');
    if (scroll) scroll.scrollLeft = scroll.scrollWidth;
  }

  // ═══════════════════════════════════════════════════════════
  // STREAK CALENDAR (monthly view)
  // ═══════════════════════════════════════════════════════════
  function renderStreakCalendar(container, entryId, monthOffset = 0) {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + monthOffset;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = firstDay.getDay();

    const completions = new Set(State.getHabitCompletions(entryId));
    const skips = new Set(State.getHabitSkips(entryId));
    const todayStr = State.todayStr();

    let html = '<div class="streak-calendar">';
    // Day labels
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
      html += `<div class="streak-day" style="border:none;font-weight:600;color:var(--text-faint)">${d}</div>`;
    });
    // Empty cells before first day
    for (let i = 0; i < startDayOfWeek; i++) {
      html += '<div style="aspect-ratio:1"></div>';
    }
    // Days
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const date = new Date(year, month, d);
      const dateStr = State.dateStr(date);
      const isCompleted = completions.has(dateStr);
      const isSkipped = skips.has(dateStr);
      const offday = !State.isHabitScheduledOn(entryId, dateStr);
      const isToday = dateStr === todayStr;
      const isPast = date < today && !isCompleted && !isSkipped && !offday;
      const cls = isCompleted ? 'completed' : isSkipped ? 'skipped' : offday ? 'offday' : isPast ? 'missed' : '';
      const todayCls = isToday ? 'today' : '';
      html += `<div class="streak-day ${cls} ${todayCls}" title="${dateStr}${isSkipped ? ' — skipped' : offday ? ' — not scheduled' : ''}">${d}</div>`;
    }
    html += '</div>';
    html += `<div class="timeline-legend" style="margin-top:var(--space-2);">
      <span class="tl-item"><span class="streak-day completed" style="width:12px;height:12px;aspect-ratio:auto;"></span>done</span>
      <span class="tl-item"><span class="streak-day skipped" style="width:12px;height:12px;aspect-ratio:auto;"></span>skipped</span>
      <span class="tl-item"><span class="streak-day missed" style="width:12px;height:12px;aspect-ratio:auto;"></span>missed</span>
      <span class="tl-item"><span class="streak-day offday" style="width:12px;height:12px;aspect-ratio:auto;"></span>off day</span>
    </div>`;
    container.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════════
  // GOAL PROGRESS (doughnut/ring chart)
  // ═══════════════════════════════════════════════════════════
  function renderGoalProgress(canvasId, entry) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const current = entry.currentValue || 0;
    const target = entry.targetValue || 1;
    const pct = Math.min(current / target, 1);
    const remaining = Math.max(target - current, 0);

    chartInstances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'doughnut',
      data: {
        labels: ['Completed', 'Remaining'],
        datasets: [{
          data: [pct, 1 - pct],
          backgroundColor: [colors.accent, colors.grid],
          borderWidth: 0,
          borderRadius: 4,
        }],
      },
      options: {
        cutout: '72%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${Math.round(ctx.parsed * 100)}%`
            }
          }
        },
      },
      plugins: [{
        id: 'centerText',
        // Percent only, scaled to the hole — the value/unit subtitle lives in
        // the card next to the ring, so drawing it here just bled into the arc.
        afterDraw: (chart) => {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;
          const cx = (chartArea.left + chartArea.right) / 2;
          const cy = (chartArea.top + chartArea.bottom) / 2;
          const holeDia = Math.min(chartArea.right - chartArea.left, chartArea.bottom - chartArea.top) * 0.72;
          const fontSize = Math.max(11, Math.min(18, Math.floor(holeDia * 0.34)));
          ctx.save();
          ctx.fillStyle = colors.text;
          ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(pct * 100)}%`, cx, cy);
          ctx.restore();
        },
      }],
    });
  }

  // ═══════════════════════════════════════════════════════════
  // HABIT STRENGTH (line chart — 30-day trend)
  // ═══════════════════════════════════════════════════════════
  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(15, 149, 152, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function renderHabitStrength(canvasId, entryId) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const data = [];

    // Line takes the habit's project color so charts match the rest of the UI
    const habit = State.getEntry(entryId);
    const proj = habit?.projectId ? State.getProject(habit.projectId) : null;
    const lineColor = proj?.color || colors.accent;

    const completions = new Set(State.getHabitCompletions(entryId));
    let runningStreak = 0;

    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
      if (completions.has(dateStr)) {
        runningStreak++;
      } else {
        runningStreak = 0;
      }
      data.push(runningStreak);
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // Create gradient
    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, hexToRgba(lineColor, 0.25));
    gradient.addColorStop(1, hexToRgba(lineColor, 0));

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Streak',
          data,
          borderColor: lineColor,
          backgroundColor: gradient,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: lineColor,
          pointHoverBorderColor: colors.surface,
          pointHoverBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: { label: (c) => `${c.parsed.y} day${c.parsed.y === 1 ? '' : 's'} streak` },
          },
        },
        scales: {
          x: {
            display: true,
            grid: { display: false },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 6, maxRotation: 0 },
          },
          y: {
            display: true,
            beginAtZero: true,
            title: { display: true, text: 'Consecutive days', color: colors.text, font: { family: 'JetBrains Mono', size: 9 } },
            grid: { color: colors.grid },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 9 }, precision: 0 },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // ALL-HABITS AGGREGATE — stacked completions per day (30 days),
  // one color-coded series per habit
  // ═══════════════════════════════════════════════════════════
  function renderHabitsAggregate(canvasId, days = 30) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return;
    const colors = getColors();
    const habits = State.getEntries({ type: 'habit' });
    if (habits.length === 0) return;
    const today = new Date();
    const fallback = ['#0f9598', '#e06d6d', '#6db4f0', '#6fcf97', '#f0d96a', '#a06df0', '#f0a06d'];

    const labels = [];
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(State.dateStr(d));
      labels.push(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
    }

    const datasets = habits.map((h, idx) => {
      const done = new Set(State.getHabitCompletions(h.id));
      const proj = h.projectId ? State.getProject(h.projectId) : null;
      return {
        label: h.title,
        data: dates.map(d => done.has(d) ? 1 : 0),
        backgroundColor: proj?.color || fallback[idx % fallback.length],
        stack: 'habits',
        borderRadius: 2,
        barPercentage: 0.9,
        categoryPercentage: 0.9,
      };
    });

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
          tooltip: { filter: (item) => item.parsed.y > 0 },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 6, maxRotation: 0 },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            title: { display: true, text: 'Habits completed', color: colors.text, font: { family: 'JetBrains Mono', size: 9 } },
            grid: { color: colors.grid },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 9 }, stepSize: 1 },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CALORIES — 7-day bars vs goal line
  // ═══════════════════════════════════════════════════════════
  function renderCalorieWeek(canvasId, days = 7) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return;
    const colors = getColors();
    const today = new Date();
    const goal = State.getSettings().calorieGoal || 2000;
    const labels = [];
    const data = [];
    const logs = State.getLogs({ type: 'calorie' });

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));
      data.push(logs.filter(l => l.date === dateStr).reduce((s, l) => s + (l.value || 0), 0));
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line',
            label: 'Goal',
            data: labels.map(() => goal),
            borderColor: colors.faint,
            borderWidth: 1.5,
            borderDash: [5, 4],
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'Calories',
            data,
            // over-goal days flag red, under-goal stay accent
            backgroundColor: data.map(v => v > goal ? '#e06d6d' : colors.accent),
            borderRadius: 3,
            barThickness: 18,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 } } },
          y: {
            beginAtZero: true,
            title: { display: true, text: 'kcal', color: colors.text, font: { family: 'JetBrains Mono', size: 9 } },
            grid: { color: colors.grid },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 9 } },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MACRO SPLIT — protein / carbs / fat grams for a day
  // ═══════════════════════════════════════════════════════════
  function renderMacroSplit(canvasId, macros) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return;
    const colors = getColors();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Protein', 'Carbs', 'Fat'],
        datasets: [{
          data: [macros.protein || 0, macros.carbs || 0, macros.fat || 0],
          backgroundColor: ['#6db4f0', '#f0d96a', '#f0a06d'],
          borderWidth: 0,
          borderRadius: 3,
        }],
      },
      options: {
        cutout: '62%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}g` } },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DAY BREAKDOWN (bar chart — tasks completed per day)
  // ═══════════════════════════════════════════════════════════
  function renderDayBreakdown(canvasId, days = 7, filter = null) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const completedData = [];
    const createdData = [];
    const pool = State.getEntries({ includeArchived: true }).filter(e => matchesFilter(e, filter));

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));

      const completed = pool.filter(e =>
        e.completed && e.completedAt && e.completedAt.startsWith(dateStr)
      ).length;
      const created = pool.filter(e =>
        e.createdAt && e.createdAt.startsWith(dateStr)
      ).length;

      completedData.push(completed);
      createdData.push(created);
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Created',
            data: createdData,
            backgroundColor: colors.grid,
            borderRadius: 3,
            barThickness: 12,
          },
          {
            label: 'Completed',
            data: completedData,
            backgroundColor: colors.accent,
            borderRadius: 3,
            barThickness: 12,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 } } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, stepSize: 1 }, beginAtZero: true },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MOOD & ENERGY TREND — day mood + check-ins (emotion) and
  // check-in energy averaged per day
  // ═══════════════════════════════════════════════════════════
  function renderMoodEnergy(canvasId, days = 14) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const moodData = [];
    const energyData = [];
    const emotionMap = { great: 5, good: 4, okay: 3, low: 2, bad: 1 };

    const moodLogs = State.getLogs().filter(l => l.type === 'emotion' || l.type === 'checkin');

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));

      const dayLogs = moodLogs.filter(l => l.date === dateStr);
      const emos = dayLogs.filter(l => l.emotion).map(l => emotionMap[l.emotion] || 3);
      moodData.push(emos.length ? emos.reduce((a, b) => a + b, 0) / emos.length : null);
      const energies = dayLogs.filter(l => l.energy != null).map(l => l.energy);
      energyData.push(energies.length ? energies.reduce((a, b) => a + b, 0) / energies.length : null);
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Mood',
            data: moodData,
            borderColor: colors.accent,
            borderWidth: 2,
            fill: false,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: colors.accent,
            pointBorderColor: colors.surface,
            pointBorderWidth: 1.5,
            spanGaps: true,
          },
          {
            label: 'Energy',
            data: energyData,
            borderColor: '#f0a06d',
            borderWidth: 2,
            borderDash: [4, 3],
            fill: false,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: '#f0a06d',
            pointBorderColor: colors.surface,
            pointBorderWidth: 1.5,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
          tooltip: {
            callbacks: {
              // "Mood: 4" told you nothing — spell out the day average and
              // the nearest named mood (avg of day mood + all check-ins)
              label: (c) => {
                const names = ['', 'Bad', 'Low', 'Okay', 'Good', 'Great'];
                const v = c.parsed.y;
                if (v == null) return '';
                if (c.dataset.label === 'Mood') return `Avg mood: ${v.toFixed(1)} ≈ ${names[Math.round(v)] || ''}`;
                return `Avg energy: ${v.toFixed(1)} / 5`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 } } },
          y: {
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              font: { family: 'JetBrains Mono', size: 10 },
              stepSize: 1,
              callback: (v) => ['', 'Bad', 'Low', 'Okay', 'Good', 'Great'][v] || '',
            },
            min: 0.5, max: 5.5,
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // WAKE / SLEEP TIMES (line chart, y = hour of day)
  // ═══════════════════════════════════════════════════════════
  function renderSleepChart(canvasId, days = 14) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const wakeData = [];
    const sleepData = [];

    const toHour = (t) => {
      if (!t) return null;
      const [h, m] = t.split(':').map(Number);
      return h + (m || 0) / 60;
    };

    const wakes = State.getLogs({ type: 'wake' });
    const sleeps = State.getLogs({ type: 'sleep' });

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));
      wakeData.push(toHour(wakes.find(l => l.date === dateStr)?.time));
      sleepData.push(toHour(sleeps.find(l => l.date === dateStr)?.time));
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const fmtHour = (v) => {
      const h = Math.floor(v);
      const ampm = h >= 12 ? 'p' : 'a';
      const hh = h % 12 === 0 ? 12 : h % 12;
      return `${hh}${ampm}`;
    };

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Wake',
            data: wakeData,
            borderColor: '#f0d96a',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: '#f0d96a',
            spanGaps: true,
          },
          {
            label: 'Sleep',
            data: sleepData,
            borderColor: '#a06df0',
            borderWidth: 2,
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: '#a06df0',
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
          tooltip: {
            callbacks: {
              label: (c) => {
                const v = c.parsed.y;
                if (v == null) return '';
                const h = Math.floor(v), m = Math.round((v - h) * 60);
                return `${c.dataset.label}: ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 } } },
          y: {
            grid: { color: colors.grid },
            ticks: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, stepSize: 4, callback: fmtHour },
            min: 0, max: 24,
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DAY EVOLUTION TIMELINE (DOM) — planner blocks as bars,
  // quick logs as dashed vertical markers, color coded
  // ═══════════════════════════════════════════════════════════
  function renderDayTimeline(container, dateStr) {
    const blocks = State.getPlannerBlocks({ date: dateStr });
    const logs = State.getLogs({ date: dateStr })
      .filter(l => ['calorie', 'quick', 'checkin', 'wake', 'sleep'].includes(l.type));

    const toMin = (t) => {
      if (!t) return null;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const logMin = (l) => {
      if (l.time) return toMin(l.time);
      if (l.createdAt) {
        const d = new Date(l.createdAt);
        return d.getHours() * 60 + d.getMinutes();
      }
      return null;
    };

    const DAY = 24 * 60;
    let html = '<div class="timeline-wrap">';
    html += '<div class="timeline-hours">';
    for (let h = 0; h < 24; h += 3) {
      html += `<span>${String(h).padStart(2, '0')}</span>`;
    }
    html += '</div>';

    const legendProjects = new Map();
    blocks.forEach(b => {
      const s = toMin(b.start), e = Math.max(toMin(b.end), toMin(b.start) + 5);
      const proj = b.projectId ? State.getProject(b.projectId) : null;
      const color = b.color || proj?.color || '#0f9598';
      if (proj) legendProjects.set(proj.id, proj);
      html += `<div class="timeline-block" style="left:${s / DAY * 100}%;width:${(e - s) / DAY * 100}%;background:${color};${b.kind === 'agenda' ? 'opacity:0.55;' : ''}"
        title="${window.escapeHtml(b.title)} · ${b.start}–${b.end}${b.kind === 'tracked' ? ' (tracked)' : ''}"></div>`;
    });

    const markerEmoji = { calorie: '🍽', quick: '⭐', checkin: '📝' };
    const markerIcon = { wake: 'sunrise', sleep: 'moon' };
    logs.forEach(l => {
      const m = logMin(l);
      if (m == null) return;
      const mark = markerIcon[l.type]
        ? `<i data-lucide="${markerIcon[l.type]}" style="width:12px;height:12px;color:var(--text-muted);"></i>`
        : (l.emoji || markerEmoji[l.type] || '·');
      const label = l.notes || l.type;
      html += `<div class="timeline-marker" style="left:${m / DAY * 100}%" title="${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} — ${label}">
        <span class="tm-emoji">${mark}</span>
      </div>`;
    });

    html += '</div>';

    // Legend
    html += '<div class="timeline-legend">';
    legendProjects.forEach(p => {
      html += `<span class="tl-item"><span class="proj-dot" style="background:${p.color}"></span>${window.escapeHtml(p.name)}</span>`;
    });
    html += `<span class="tl-item"><span style="display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--accent);"></span>tracked</span>`;
    html += `<span class="tl-item"><span style="display:inline-block;width:14px;height:8px;border-radius:2px;background:var(--accent);opacity:0.55;"></span>agenda</span>`;
    html += '</div>';

    if (blocks.length === 0 && logs.length === 0) {
      html += `<p class="text-xs text-faint" style="margin-top:var(--space-2);">No time blocks or logs recorded this day. Track time or use Quick Log and the day will paint itself here.</p>`;
    }

    container.innerHTML = html;
    // This renders AFTER the page-level icon pass — convert our own markers
    if (window.lucide) lucide.createIcons();
  }

  // ═══════════════════════════════════════════════════════════
  // WEEKLY HABIT CONSISTENCY (radar chart)
  // ═══════════════════════════════════════════════════════════
  function renderHabitRadar(canvasId, filter = null) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const habits = State.getEntries({ type: 'habit' }).filter(h => matchesFilter(h, filter));

    if (habits.length === 0) return;

    const labels = habits.map(h => h.title.length > 15 ? h.title.slice(0, 12) + '…' : h.title);
    const data = habits.map(h => {
      const s = State.calculateStreak(h.id);
      return s.retention30;
    });

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'radar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: 'rgba(15, 149, 152, 0.15)',
          borderColor: colors.accent,
          borderWidth: 2,
          pointBackgroundColor: colors.accent,
          pointBorderColor: colors.surface,
          pointBorderWidth: 1.5,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            grid: { color: colors.grid },
            angleLines: { color: colors.grid },
            pointLabels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 } },
            ticks: { display: false, stepSize: 25 },
            min: 0, max: 100,
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // EFFORT DISTRIBUTION (doughnut)
  // ═══════════════════════════════════════════════════════════
  function renderEffortDist(canvasId, filter = null) {
    destroy(canvasId);
    if (typeof Chart === 'undefined') return; // CDN not loaded (first offline visit)
    const colors = getColors();
    const entries = State.getEntries({ completed: false }).filter(e => matchesFilter(e, filter));
    const efforts = ['trivial', 'small', 'medium', 'large', 'xl'];
    const counts = efforts.map(e => entries.filter(en => en.effort === e).length);

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: efforts.map(e => e.charAt(0).toUpperCase() + e.slice(1)),
        datasets: [{
          data: counts,
          backgroundColor: [
            '#6fcf97', '#6db4f0', '#0f9598', '#f0a06d', '#e06d6d',
          ],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: colors.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10, boxHeight: 10 },
          },
        },
      },
    });
  }

  return {
    renderHeatmap, renderStreakCalendar,
    renderGoalProgress, renderHabitStrength, renderHabitsAggregate,
    renderDayBreakdown, renderMoodEnergy,
    renderEmotionTrend: renderMoodEnergy, // back-compat alias
    renderSleepChart, renderDayTimeline,
    renderCalorieWeek, renderMacroSplit,
    renderHabitRadar, renderEffortDist,
    destroy, destroyAll,
  };
})();
