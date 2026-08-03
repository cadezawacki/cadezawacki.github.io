/* ═══════════════════════════════════════════════════════════════
   TIMERS — Pomodoro, Stopwatch, Time Tracking
   Tracking sessions record segments; explicit Pause closes a
   segment (a break in the day planner). Pomodoro's automatic
   break phases do NOT split segments. On finish, each segment
   is inserted into the day planner as a color-coded block.
   ═══════════════════════════════════════════════════════════════ */

const Timers = (() => {
  let mode = 'pomodoro'; // pomodoro | stopwatch | countdown | track
  let timerState = 'idle'; // idle | running | paused | done
  let remaining = 0; // seconds
  let elapsed = 0; // seconds (for stopwatch)
  let intervalId = null;
  let pomodoroPhase = 'work'; // work | break | longBreak
  let pomodoroCount = 0;
  let trackedTaskId = null;

  // Active tracking session: { entryId, segments: [{start:Date, end?:Date}] }
  let session = null;

  const PHASE_LABELS = { work: 'Focus', break: 'Short Break', longBreak: 'Long Break' };

  function getSettings() {
    return State.getSettings().timer;
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function hhmm(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ── Session helpers ─────────────────────────────────────────
  function sessionOpenSegment() {
    return session && session.segments.length > 0 && !session.segments[session.segments.length - 1].end
      ? session.segments[session.segments.length - 1] : null;
  }

  function sessionPause() {
    const seg = sessionOpenSegment();
    if (seg) seg.end = new Date();
  }

  function sessionResume() {
    if (session && !sessionOpenSegment()) session.segments.push({ start: new Date() });
  }

  // Insert planner blocks for every segment >= 1 minute.
  function finalizeSession() {
    if (!session) return;
    sessionPause();
    const entry = State.getEntry(session.entryId);
    const proj = entry?.projectId ? State.getProject(entry.projectId) : null;
    session.segments.forEach(seg => {
      if (!seg.end || (seg.end - seg.start) < 60000) return;
      State.createPlannerBlock({
        date: State.dateStr(seg.start),
        start: hhmm(seg.start),
        end: hhmm(seg.end),
        title: entry?.title || 'Tracked time',
        entryId: session.entryId,
        projectId: entry?.projectId || null,
        color: proj?.color || null,
        kind: 'tracked',
      });
    });
    session = null;
  }

  function start() {
    if (timerState === 'running') return;
    if (mode === 'pomodoro' && timerState === 'idle') {
      const s = getSettings();
      remaining = (pomodoroPhase === 'work' ? s.pomodoroWork : pomodoroPhase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
    }
    if (mode === 'stopwatch' && timerState === 'idle') {
      elapsed = 0;
    }
    // Resuming an explicitly paused tracking session starts a new segment.
    if (trackedTaskId && timerState === 'paused') sessionResume();
    timerState = 'running';
    tick();
    intervalId = setInterval(tick, 1000);
    render();
  }

  function pause() {
    timerState = 'paused';
    clearInterval(intervalId);
    // An explicit pause is a break in the day planner (unlike pomodoro's
    // automatic break phases, which keep the segment open).
    if (trackedTaskId) sessionPause();
    render();
  }

  function reset() {
    timerState = 'idle';
    clearInterval(intervalId);
    if (trackedTaskId) {
      finalizeSession();
      trackedTaskId = null;
    }
    if (mode === 'pomodoro') {
      const s = getSettings();
      remaining = (pomodoroPhase === 'work' ? s.pomodoroWork : pomodoroPhase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
    } else if (mode === 'stopwatch') {
      elapsed = 0;
    } else if (mode === 'countdown') {
      remaining = 0;
    } else if (mode === 'track') {
      elapsed = 0;
    }
    render();
  }

  function tick() {
    if (timerState !== 'running') return;
    if (mode === 'pomodoro' || mode === 'countdown') {
      remaining--;
      if (remaining <= 0) {
        timerState = 'done';
        clearInterval(intervalId);
        onComplete();
      }
    } else if (mode === 'stopwatch') {
      elapsed++;
    } else if (mode === 'track') {
      elapsed++;
    }
    render();
  }

  function onComplete() {
    if (mode === 'pomodoro') {
      if (pomodoroPhase === 'work') {
        pomodoroCount++;
        // Log time if tracking a task (seconds — display expects seconds)
        if (trackedTaskId) {
          const s = getSettings();
          State.logTimeSession(trackedTaskId, s.pomodoroWork * 60, `Pomodoro #${pomodoroCount}`);
        }
        pomodoroPhase = pomodoroCount % 4 === 0 ? 'longBreak' : 'break';
        showToast(`${PHASE_LABELS[pomodoroPhase]} time!`);
      } else {
        pomodoroPhase = 'work';
        showToast('Back to focus!');
      }
      // NOTE: the tracking session's segment intentionally stays open across
      // pomodoro break phases — pomodoro breaks are not planner breaks.
      const s = getSettings();
      remaining = (pomodoroPhase === 'work' ? s.pomodoroWork : pomodoroPhase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
      timerState = 'idle';
      if (s.autoStart) start();
    } else if (mode === 'countdown') {
      showToast('Countdown complete!');
      timerState = 'idle';
    }
    render();
  }

  function setMode(m) {
    // Switching between pomodoro and track keeps a live session alive;
    // leaving both finalizes it.
    if (session && m !== 'pomodoro' && m !== 'track') {
      finalizeSession();
      trackedTaskId = null;
    }
    mode = m;
    timerState = 'idle';
    clearInterval(intervalId);
    if (m === 'pomodoro') {
      const s = getSettings();
      remaining = s.pomodoroWork * 60;
      pomodoroPhase = 'work';
    } else if (m === 'stopwatch' || m === 'track') {
      elapsed = 0;
    } else if (m === 'countdown') {
      remaining = 0;
    }
    render();
  }

  function setPomodoroPhase(phase) {
    if (mode !== 'pomodoro') return;
    pomodoroPhase = phase;
    timerState = 'idle';
    clearInterval(intervalId);
    const s = getSettings();
    remaining = (phase === 'work' ? s.pomodoroWork : phase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
    render();
  }

  function setCountdown(minutes) {
    if (mode !== 'countdown') return;
    remaining = minutes * 60;
    timerState = 'idle';
    clearInterval(intervalId);
    render();
  }

  function startTracking(taskId) {
    // Finalize any previous session first
    if (session) finalizeSession();
    trackedTaskId = taskId;
    mode = 'track';
    elapsed = 0;
    session = { entryId: taskId, segments: [{ start: new Date() }] };
    timerState = 'running';
    clearInterval(intervalId);
    tick();
    intervalId = setInterval(tick, 1000);
    render();
  }

  function stopTracking() {
    if (trackedTaskId) {
      // Total tracked = sum of segment durations (seconds)
      let total = elapsed;
      if (session) {
        sessionPause();
        total = Math.round(session.segments.reduce((s, seg) => s + ((seg.end || new Date()) - seg.start), 0) / 1000);
      }
      if (total >= 30) State.logTimeSession(trackedTaskId, total, 'Manual tracking');
      finalizeSession();
      trackedTaskId = null;
      showToast('Session logged to planner');
    }
    timerState = 'idle';
    elapsed = 0;
    clearInterval(intervalId);
    render();
    if (window.App) App.render();
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function getProgress() {
    if (mode === 'pomodoro') {
      const s = getSettings();
      const total = (pomodoroPhase === 'work' ? s.pomodoroWork : pomodoroPhase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
      return total > 0 ? ((total - remaining) / total) * 100 : 0;
    }
    if (mode === 'countdown' && remaining > 0) {
      // No total stored, return 0
      return 0;
    }
    return 0;
  }

  function render() {
    const body = document.getElementById('panelBody');
    if (!body) return;
    const s = getSettings();

    let displayTime = mode === 'stopwatch' || mode === 'track' ? elapsed : remaining;
    const isRunning = timerState === 'running';

    let html = `
      <div class="timer-mode">
        <button class="timer-mode-btn ${mode === 'pomodoro' ? 'active' : ''}" onclick="Timers.setMode('pomodoro')">Pomodoro</button>
        <button class="timer-mode-btn ${mode === 'stopwatch' ? 'active' : ''}" onclick="Timers.setMode('stopwatch')">Stopwatch</button>
        <button class="timer-mode-btn ${mode === 'countdown' ? 'active' : ''}" onclick="Timers.setMode('countdown')">Countdown</button>
        <button class="timer-mode-btn ${mode === 'track' ? 'active' : ''}" onclick="Timers.setMode('track')">Track</button>
      </div>
    `;

    if (mode === 'pomodoro') {
      html += `
        <div style="text-align:center;margin-bottom:var(--space-3);">
          <div class="pill pill-accent" style="margin-bottom:var(--space-3);">${PHASE_LABELS[pomodoroPhase]}</div>
        </div>
        <div class="timer-display">${formatTime(displayTime)}</div>
        <div class="progress-bar" style="margin-top:var(--space-4);">
          <div class="progress-fill" style="width:${getProgress()}%"></div>
        </div>
        <div style="text-align:center;margin-top:var(--space-2);">
          <span class="stat-label">Session ${pomodoroCount + 1} · ${pomodoroCount} completed today</span>
        </div>
        <div class="timer-controls">
          ${timerState === 'running' || timerState === 'paused'
            ? `<button class="btn btn-secondary" onclick="Timers.reset()"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i>Reset</button>
               ${isRunning
                 ? `<button class="btn btn-primary" onclick="Timers.pause()"><i data-lucide="pause" style="width:16px;height:16px"></i>Pause</button>`
                 : `<button class="btn btn-primary" onclick="Timers.start()"><i data-lucide="play" style="width:16px;height:16px"></i>Resume</button>`}`
            : `<button class="btn btn-primary" onclick="Timers.start()"><i data-lucide="play" style="width:16px;height:16px"></i>Start</button>`
          }
        </div>
        <div class="divider"></div>
        <div class="section-title" style="margin-bottom:var(--space-2);">Switch Phase</div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary btn-sm ${pomodoroPhase === 'work' ? 'active' : ''}" style="flex:1" onclick="Timers.setPomodoroPhase('work')">Focus</button>
          <button class="btn btn-secondary btn-sm ${pomodoroPhase === 'break' ? 'active' : ''}" style="flex:1" onclick="Timers.setPomodoroPhase('break')">Break</button>
          <button class="btn btn-secondary btn-sm ${pomodoroPhase === 'longBreak' ? 'active' : ''}" style="flex:1" onclick="Timers.setPomodoroPhase('longBreak')">Long</button>
        </div>
        ${trackedTaskId ? `<div style="text-align:center;margin-top:var(--space-3);">
          <span class="stat-label">Tracking: ${State.getEntry(trackedTaskId)?.title || 'Unknown'}</span>
        </div>` : ''}
      `;
    } else if (mode === 'stopwatch') {
      html += `
        <div class="timer-display">${formatTime(displayTime)}</div>
        <div class="timer-controls">
          <button class="btn btn-secondary" onclick="Timers.reset()"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i>Reset</button>
          ${isRunning
            ? `<button class="btn btn-primary" onclick="Timers.pause()"><i data-lucide="pause" style="width:16px;height:16px"></i>Pause</button>`
            : `<button class="btn btn-primary" onclick="Timers.start()"><i data-lucide="play" style="width:16px;height:16px"></i>${elapsed > 0 ? 'Resume' : 'Start'}</button>`
          }
        </div>
      `;
    } else if (mode === 'countdown') {
      const presets = [1, 5, 10, 15, 30];
      html += `
        <div class="timer-display">${formatTime(displayTime || 0)}</div>
        <div class="timer-controls">
          <button class="btn btn-secondary" onclick="Timers.reset()"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i>Reset</button>
          ${isRunning
            ? `<button class="btn btn-primary" onclick="Timers.pause()"><i data-lucide="pause" style="width:16px;height:16px"></i>Pause</button>`
            : `<button class="btn btn-primary" onclick="Timers.start()" ${remaining === 0 ? 'disabled style="opacity:0.5"' : ''}><i data-lucide="play" style="width:16px;height:16px"></i>Start</button>`
          }
        </div>
        <div class="divider"></div>
        <div class="section-title" style="margin-bottom:var(--space-2);">Set Duration</div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
          ${presets.map(m => `<button class="btn btn-secondary btn-sm" onclick="Timers.setCountdown(${m})">${m}m</button>`).join('')}
        </div>
      `;
    } else if (mode === 'track') {
      const tasks = State.getEntries({ type: 'task', completed: false });
      const paused = timerState === 'paused' && trackedTaskId;
      html += `
        <div class="timer-display">${formatTime(displayTime)}</div>
        ${trackedTaskId ? `<div style="text-align:center;margin-top:var(--space-2);">
          <span class="stat-label">${paused ? 'Paused — break in planner' : 'Tracking'}: ${State.getEntry(trackedTaskId)?.title || 'Unknown'}</span>
        </div>` : ''}
        <div class="timer-controls">
          ${trackedTaskId
            ? `${isRunning
                 ? `<button class="btn btn-secondary" onclick="Timers.pause()"><i data-lucide="pause" style="width:16px;height:16px"></i>Pause</button>`
                 : `<button class="btn btn-secondary" onclick="Timers.start()"><i data-lucide="play" style="width:16px;height:16px"></i>Resume</button>`}
               <button class="btn btn-danger" onclick="Timers.stopTracking()"><i data-lucide="square" style="width:16px;height:16px"></i>Stop & Log</button>`
            : `<p class="text-muted text-sm" style="text-align:center;width:100%;">Pick a task below to start tracking</p>`
          }
        </div>
        <div class="divider"></div>
        <div class="section-title" style="margin-bottom:var(--space-2);">Select Task to Track</div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);">
          ${tasks.length === 0 ? '<p class="text-muted text-sm">No open tasks</p>' :
            tasks.slice(0, 8).map(t => `
              <button class="chain-link" style="cursor:pointer;${trackedTaskId === t.id ? 'border-color:var(--accent);background:var(--accent-tint);' : ''}" onclick="Timers.startTracking('${t.id}')">
                <span class="proj-dot" style="background:${t.projectId ? State.getProject(t.projectId)?.color || '#888' : '#888'}"></span>
                <span class="text-sm truncate">${t.title}</span>
              </button>
            `).join('')
          }
        </div>
      `;
    }

    // Recent time logs
    const timeLogs = State.getLogs({ type: 'time_session' }).slice(-5).reverse();
    if (timeLogs.length > 0) {
      html += `<div class="divider"></div>`;
      html += `<div class="section-title" style="margin-bottom:var(--space-2);">Recent Sessions</div>`;
      html += timeLogs.map(l => {
        const entry = l.entryId ? State.getEntry(l.entryId) : null;
        return `<div class="chain-link" style="font-size:var(--text-xs);">
          <span class="font-mono" style="color:var(--accent-text);">${formatTime(l.value || 0)}</span>
          <span class="text-muted truncate">${entry?.title || 'Unknown'}</span>
        </div>`;
      }).join('');
    }

    body.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }

  function openPanel() {
    document.getElementById('panelTitle').textContent = 'Timer';
    document.getElementById('panelOverlay').classList.add('active');
    // The panel has its own .active transform — without this it stays
    // translated off-screen while the overlay blurs the page.
    document.getElementById('slidePanel').classList.add('active');
    render();
  }

  function isTracking() { return !!trackedTaskId; }

  return {
    start, pause, reset, setMode, setPomodoroPhase, setCountdown,
    startTracking, stopTracking, openPanel, render, isTracking,
    formatTime, getProgress,
  };
})();
