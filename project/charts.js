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
    return {
      text: isDark ? '#8a8782' : '#6b6863',
      grid: isDark ? '#383735' : '#e0ddd7',
      accent: '#0f9598',
      accentHover: '#12b3b7',
      surface: isDark ? '#1c1b1a' : '#ffffff',
      faint: isDark ? '#5a5854' : '#a8a59f',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CALENDAR HEATMAP (GitHub-style contribution graph)
  // ═══════════════════════════════════════════════════════════
  function renderHeatmap(container, days = 84) {
    const colors = getColors();
    const today = new Date();
    const entries = State.getEntries({ type: 'habit' });
    const habitLogs = State.getLogs({ type: 'habit_completion' });

    // Build completion counts per day
    const dayCounts = {};
    habitLogs.forEach(l => {
      dayCounts[l.date] = (dayCounts[l.date] || 0) + 1;
    });

    // Also count task completions
    State.getEntries().forEach(e => {
      if (e.completed && e.completedAt) {
        const d = e.completedAt.split('T')[0];
        dayCounts[d] = (dayCounts[d] || 0) + 1;
      }
    });

    const maxCount = Math.max(...Object.values(dayCounts), 1);
    const weeks = Math.ceil(days / 7);

    let html = '<div class="heatmap">';
    for (let w = weeks - 1; w >= 0; w--) {
      html += '<div class="heatmap-col">';
      for (let d = 6; d >= 0; d--) {
        const date = new Date(today);
        date.setDate(date.getDate() - (w * 7 + d));
        const dateStr = State.dateStr(date);
        const count = dayCounts[dateStr] || 0;
        const level = count === 0 ? '' : count <= maxCount * 0.25 ? 'l1' : count <= maxCount * 0.5 ? 'l2' : count <= maxCount * 0.75 ? 'l3' : 'l4';
        const isToday = dateStr === State.todayStr();
        html += `<div class="heatmap-cell ${level}" title="${dateStr}: ${count} completions" style="${isToday ? 'box-shadow:0 0 0 1px var(--text-faint);' : ''}"></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="heatmap-labels"><span>12 weeks ago</span><span>Today</span></div>';

    container.innerHTML = html;
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
      const isToday = dateStr === todayStr;
      const isPast = date < today && !isCompleted;
      const cls = isCompleted ? 'completed' : isPast ? 'missed' : '';
      const todayCls = isToday ? 'today' : '';
      html += `<div class="streak-day ${cls} ${todayCls}">${d}</div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════════
  // GOAL PROGRESS (doughnut/ring chart)
  // ═══════════════════════════════════════════════════════════
  function renderGoalProgress(canvasId, entry) {
    destroy(canvasId);
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
        afterDraw: (chart) => {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;
          const cx = (chartArea.left + chartArea.right) / 2;
          const cy = (chartArea.top + chartArea.bottom) / 2;
          ctx.save();
          ctx.fillStyle = colors.text;
          ctx.font = '600 18px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(pct * 100)}%`, cx, cy - 8);
          ctx.font = '500 10px "JetBrains Mono", monospace';
          ctx.fillStyle = colors.faint;
          ctx.fillText(`${current} / ${target} ${entry.unit || ''}`, cx, cy + 12);
          ctx.restore();
        },
      }],
    });
  }

  // ═══════════════════════════════════════════════════════════
  // HABIT STRENGTH (line chart — 30-day trend)
  // ═══════════════════════════════════════════════════════════
  function renderHabitStrength(canvasId, entryId) {
    destroy(canvasId);
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const data = [];

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
    gradient.addColorStop(0, 'rgba(15, 149, 152, 0.25)');
    gradient.addColorStop(1, 'rgba(15, 149, 152, 0.0)');

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: colors.accent,
          backgroundColor: gradient,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: colors.accent,
          pointHoverBorderColor: colors.surface,
          pointHoverBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DAY BREAKDOWN (bar chart — tasks completed per day)
  // ═══════════════════════════════════════════════════════════
  function renderDayBreakdown(canvasId, days = 7) {
    destroy(canvasId);
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const completedData = [];
    const createdData = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));

      const completed = State.getEntries().filter(e =>
        e.completed && e.completedAt && e.completedAt.startsWith(dateStr)
      ).length;
      const created = State.getEntries().filter(e =>
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
  // EMOTION TREND (line chart)
  // ═══════════════════════════════════════════════════════════
  function renderEmotionTrend(canvasId, days = 14) {
    destroy(canvasId);
    const colors = getColors();
    const today = new Date();
    const labels = [];
    const data = [];
    const emotionMap = { great: 5, good: 4, okay: 3, low: 2, bad: 1 };

    const logs = State.getLogs({ type: 'emotion' });

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = State.dateStr(d);
      labels.push(d.toLocaleDateString('en', { weekday: 'short' }));

      const dayLogs = logs.filter(l => l.date === dateStr);
      if (dayLogs.length > 0) {
        const avg = dayLogs.reduce((s, l) => s + (emotionMap[l.emotion] || 3), 0) / dayLogs.length;
        data.push(avg);
      } else {
        data.push(null);
      }
    }

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: colors.accent,
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: colors.accent,
          pointBorderColor: colors.surface,
          pointBorderWidth: 1.5,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
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
  // WEEKLY HABIT CONSISTENCY (radar chart)
  // ═══════════════════════════════════════════════════════════
  function renderHabitRadar(canvasId) {
    destroy(canvasId);
    const colors = getColors();
    const habits = State.getEntries({ type: 'habit' });

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
  function renderEffortDist(canvasId) {
    destroy(canvasId);
    const colors = getColors();
    const entries = State.getEntries({ completed: false });
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
    renderGoalProgress, renderHabitStrength,
    renderDayBreakdown, renderEmotionTrend,
    renderHabitRadar, renderEffortDist,
    destroy, destroyAll,
  };
})();
