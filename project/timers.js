/* ═══════════════════════════════════════════════════════════════
   TIMERS v3
   Two independent parts:
   • CLOCK — one pomodoro/stopwatch/countdown engine, optionally
     linked to a task. Switching view tabs never disturbs it.
   • SESSIONS — any number of simultaneous task-tracking sessions,
     wall-clock based, each with pause/resume (pauses become gaps
     in the day planner; pomodoro phases never split sessions).
   A floating mini widget shows live values while the panel is
   closed; task cards show a live tick for their own session.
   ═══════════════════════════════════════════════════════════════ */

const Timers = (() => {
  let viewMode = 'track'; // which tab of the panel is visible

  // ── Clock engine ────────────────────────────────────────────
  const clock = {
    mode: null,            // 'pomodoro' | 'stopwatch' | 'countdown' | null (idle)
    state: 'idle',         // 'idle' | 'running' | 'paused'
    remaining: 0,          // pomodoro/countdown seconds
    elapsed: 0,            // stopwatch seconds
    phase: 'work',
    count: 0,
    countdownTotal: 0,
    linkedTaskId: null,    // optional task the clock logs to
    startedAt: null,       // Date when current run began (for planner block)
  };

  // ── Tracking sessions ───────────────────────────────────────
  // { entryId, segments: [{start:Date, end?:Date}], state:'running'|'paused' }
  let sessions = [];
  let pendingTaskId = null; // armed from a card's play button; starts on demand

  let ticker = null;

  const PHASE_LABELS = { work: 'Focus', break: 'Short Break', longBreak: 'Long Break' };

  function getSettings() {
    return State.getSettings().timer;
  }

  // ── Persistence — timers survive refresh and ride the sync blob ──
  // Written on every state CHANGE (never per tick); elapsed time derives
  // from wall-clock timestamps, so a reload hours later stays honest.
  function persistTimers() {
    if (typeof State === 'undefined') return;
    State.updateSettings({
      timerState: {
        clock: {
          mode: clock.mode, state: clock.state, remaining: clock.remaining,
          elapsed: clock.elapsed, phase: clock.phase, count: clock.count,
          countdownTotal: clock.countdownTotal, linkedTaskId: clock.linkedTaskId,
          startedAt: clock.startedAt ? clock.startedAt.toISOString() : null,
          at: Date.now(), // for running clocks: how stale `remaining/elapsed` is
        },
        sessions: sessions.map(s => ({
          entryId: s.entryId, state: s.state,
          segments: s.segments.map(seg => ({
            start: seg.start.toISOString(),
            end: seg.end ? seg.end.toISOString() : null,
          })),
        })),
      },
    });
  }

  function restore() {
    const ts = State.getSettings().timerState;
    if (!ts) return;
    (ts.sessions || []).forEach(s => {
      if (!State.getEntry(s.entryId) || getSession(s.entryId)) return;
      sessions.push({
        entryId: s.entryId, state: s.state === 'paused' ? 'paused' : 'running',
        segments: (s.segments || []).map(seg => ({
          start: new Date(seg.start),
          end: seg.end ? new Date(seg.end) : undefined,
        })),
      });
    });
    const c = ts.clock;
    if (c && c.mode && c.state !== 'idle') {
      Object.assign(clock, {
        mode: c.mode, state: c.state, phase: c.phase || 'work', count: c.count || 0,
        countdownTotal: c.countdownTotal || 0, linkedTaskId: c.linkedTaskId || null,
        startedAt: c.startedAt ? new Date(c.startedAt) : null,
        remaining: c.remaining || 0, elapsed: c.elapsed || 0,
      });
      if (c.state === 'running' && c.at) {
        const gone = Math.floor((Date.now() - c.at) / 1000);
        if (clock.mode === 'stopwatch') clock.elapsed += gone;
        else clock.remaining = Math.max(0, clock.remaining - gone); // 0 → first tick completes it
      }
    }
    ensureTicker();
    updateMini();
    updateCardTickers();
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function hhmm(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function phaseSeconds(phase = clock.phase) {
    const s = getSettings();
    return (phase === 'work' ? s.pomodoroWork : phase === 'break' ? s.pomodoroBreak : s.pomodoroLongBreak) * 60;
  }

  // ── Ticker lifecycle ────────────────────────────────────────
  function anythingRunning() {
    return clock.state === 'running' || sessions.some(s => s.state === 'running');
  }

  function ensureTicker() {
    if (!ticker && anythingRunning()) ticker = setInterval(tick, 1000);
  }

  function maybeStopTicker() {
    if (ticker && !anythingRunning()) { clearInterval(ticker); ticker = null; }
    updateMini();
  }

  function tick() {
    if (clock.state === 'running') {
      if (clock.mode === 'stopwatch') {
        clock.elapsed++;
      } else if (clock.mode === 'pomodoro' || clock.mode === 'countdown') {
        clock.remaining--;
        if (clock.remaining <= 0) onClockComplete();
      }
    }
    updateDisplays();
  }

  // Per-second updates patch text in place — a full render() would tear down
  // the link-task <select> or a button mid-interaction every tick.
  function updateDisplays() {
    if (isPanelOpen()) {
      const disp = document.querySelector('#panelBody .timer-display');
      if (disp && viewMode !== 'track') {
        const v = viewMode === 'pomodoro' ? (clock.mode === 'pomodoro' ? clock.remaining : phaseSeconds('work'))
          : viewMode === 'stopwatch' ? (clock.mode === 'stopwatch' ? clock.elapsed : 0)
          : (clock.mode === 'countdown' ? clock.remaining : 0);
        disp.textContent = formatTime(v);
      }
      const fill = document.querySelector('#panelBody .progress-fill');
      if (fill) fill.style.width = getProgress() + '%';
    }
    updateMini();
    updateCardTickers();
  }

  function isPanelOpen() {
    const p = document.getElementById('slidePanel');
    return !!p && p.classList.contains('active');
  }

  // ── Session helpers ─────────────────────────────────────────
  function getSession(entryId) {
    return sessions.find(s => s.entryId === entryId) || null;
  }

  function sessionElapsed(s) {
    return s.segments.reduce((sum, seg) => sum + (((seg.end || new Date()) - seg.start) / 1000), 0);
  }

  // Card badges ask for this: null when not tracked.
  function getTracking(entryId) {
    const s = getSession(entryId);
    if (!s) return null;
    return { elapsed: sessionElapsed(s), state: s.state };
  }

  function trackedCount() { return sessions.length; }

  // Arm from a task card's play button: nothing runs until Start is pressed.
  function armTracking(entryId) {
    if (getSession(entryId)) { viewMode = 'track'; openPanel(); return; }
    pendingTaskId = entryId;
    viewMode = 'track';
    openPanel();
  }

  function startPending() {
    if (pendingTaskId) startSession(pendingTaskId);
    pendingTaskId = null;
  }

  function startSession(entryId) {
    const existing = getSession(entryId);
    if (existing) { resumeSession(entryId); return; }
    sessions.push({ entryId, segments: [{ start: new Date() }], state: 'running' });
    if (pendingTaskId === entryId) pendingTaskId = null;
    persistTimers();
    ensureTicker();
    render();
    if (typeof App !== 'undefined') App.render();
  }

  function pauseSession(entryId) {
    const s = getSession(entryId);
    if (!s || s.state !== 'running') return;
    const seg = s.segments[s.segments.length - 1];
    if (seg && !seg.end) seg.end = new Date();
    s.state = 'paused';
    persistTimers();
    maybeStopTicker();
    render();
    updateCardTickers();
  }

  function resumeSession(entryId) {
    const s = getSession(entryId);
    if (!s || s.state === 'running') return;
    s.segments.push({ start: new Date() });
    s.state = 'running';
    persistTimers();
    ensureTicker();
    render();
  }

  function stopSession(entryId) {
    const s = getSession(entryId);
    if (!s) return;
    const seg = s.segments[s.segments.length - 1];
    if (seg && !seg.end) seg.end = new Date();
    const total = Math.round(sessionElapsed(s));

    if (total >= 60) {
      State.logTimeSession(entryId, total, 'Tracked');
      insertPlannerBlocks(entryId, s.segments);
      showToast('Logged to planner');
    } else {
      showToast('Under a minute — not logged');
    }

    sessions = sessions.filter(x => x !== s);
    persistTimers();
    maybeStopTicker();
    render();
    if (typeof App !== 'undefined') App.render();
  }

  function insertPlannerBlocks(entryId, segments) {
    const entry = State.getEntry(entryId);
    const proj = entry?.projectId ? State.getProject(entry.projectId) : null;
    segments.forEach(seg => {
      if (!seg.end || (seg.end - seg.start) < 60000) return; // skip sub-minute segments
      State.createPlannerBlock({
        date: State.dateStr(seg.start),
        start: hhmm(seg.start),
        end: hhmm(seg.end),
        title: entry?.title || 'Tracked time',
        entryId,
        projectId: entry?.projectId || null,
        color: proj?.color || null,
        kind: 'tracked',
      });
    });
  }

  // ── Clock controls ──────────────────────────────────────────
  // Starting under a view adopts that mode; a clock already running in a
  // different mode is reset first (there is exactly one clock).
  function startClock() {
    const m = viewMode === 'track' ? 'stopwatch' : viewMode;
    if (clock.mode !== m || clock.state === 'idle') {
      clock.mode = m;
      clock.phase = clock.mode === 'pomodoro' ? clock.phase : 'work';
      if (m === 'pomodoro') clock.remaining = phaseSeconds();
      if (m === 'stopwatch') clock.elapsed = 0;
      if (m === 'countdown' && clock.remaining <= 0) { render(); return; } // needs a preset
      clock.startedAt = new Date();
    }
    clock.state = 'running';
    persistTimers();
    ensureTicker();
    render();
  }

  function pauseClock() {
    if (clock.state !== 'running') return;
    clock.state = 'paused';
    persistTimers();
    maybeStopTicker();
    render();
  }

  function resetClock() {
    // A linked stopwatch logs its time on reset (that's its "stop")
    if (clock.mode === 'stopwatch' && clock.linkedTaskId && clock.elapsed >= 60) {
      State.logTimeSession(clock.linkedTaskId, clock.elapsed, 'Stopwatch');
      clockPlannerBlock(clock.elapsed);
      showToast('Stopwatch logged');
    }
    clock.state = 'idle';
    clock.mode = null;
    clock.elapsed = 0;
    clock.remaining = 0;
    clock.startedAt = null;
    persistTimers();
    maybeStopTicker();
    render();
  }

  function clockPlannerBlock(durationSec) {
    if (!clock.linkedTaskId || !clock.startedAt) return;
    const entry = State.getEntry(clock.linkedTaskId);
    const proj = entry?.projectId ? State.getProject(entry.projectId) : null;
    const end = new Date();
    const start = new Date(end - durationSec * 1000);
    State.createPlannerBlock({
      date: State.dateStr(start),
      start: hhmm(start),
      end: hhmm(end),
      title: entry?.title || 'Focus',
      entryId: clock.linkedTaskId,
      projectId: entry?.projectId || null,
      color: proj?.color || null,
      kind: 'tracked',
    });
  }

  function onClockComplete() {
    if (clock.mode === 'pomodoro') {
      if (clock.phase === 'work') {
        clock.count++;
        if (clock.linkedTaskId) {
          State.logTimeSession(clock.linkedTaskId, phaseSeconds('work'), `Pomodoro #${clock.count}`);
          clockPlannerBlock(phaseSeconds('work'));
        }
        clock.phase = clock.count % 4 === 0 ? 'longBreak' : 'break';
        showToast(`${PHASE_LABELS[clock.phase]} time!`);
      } else {
        clock.phase = 'work';
        showToast('Back to focus!');
      }
      clock.remaining = phaseSeconds();
      clock.startedAt = new Date();
      if (getSettings().autoStart) {
        clock.state = 'running';
      } else {
        clock.state = 'paused';
        maybeStopTicker();
      }
    } else if (clock.mode === 'countdown') {
      if (clock.linkedTaskId && clock.countdownTotal >= 60) {
        State.logTimeSession(clock.linkedTaskId, clock.countdownTotal, 'Countdown');
        clockPlannerBlock(clock.countdownTotal);
      }
      showToast('Countdown complete!');
      clock.state = 'idle';
      clock.mode = null;
      maybeStopTicker();
    }
    persistTimers();
    render(); // phase/pill/labels changed — full panel refresh
    if (typeof App !== 'undefined') App.render();
  }

  function setViewMode(m) {
    viewMode = m; // view only — the clock and sessions keep running
    render();
  }

  function setPomodoroPhase(phase) {
    clock.phase = phase;
    if (clock.mode === 'pomodoro') {
      clock.remaining = phaseSeconds(phase);
      clock.state = 'paused';
    }
    persistTimers();
    render();
  }

  function setCountdown(minutes) {
    clock.mode = 'countdown';
    clock.countdownTotal = minutes * 60;
    clock.remaining = minutes * 60;
    clock.state = 'paused';
    clock.startedAt = new Date();
    persistTimers();
    render();
  }

  function linkTask(taskId) {
    clock.linkedTaskId = taskId || null;
    persistTimers();
    render();
  }

  // ── Card tickers & mini widget ──────────────────────────────
  function updateCardTickers() {
    document.querySelectorAll('[data-tick-entry]').forEach(el => {
      const t = getTracking(el.dataset.tickEntry);
      if (t) el.textContent = (t.state === 'paused' ? '⏸ ' : '') + formatTime(t.elapsed);
    });
  }

  // Header-nav timer element: ALWAYS present as a one-click way to open the
  // window. With live timers it shows up to settings.maxNavTimers session
  // chips (then "+N"). Structure only re-renders when the session list
  // changes; per-second values patch text nodes — no flicker, no pulsing.
  const TIMER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>';
  let navSig = null;

  function updateMini() {
    const el = document.getElementById('timerIndicator');
    if (!el) return;
    const max = Math.max(1, State.getSettings().maxNavTimers || 2);
    const shown = sessions.slice(0, max);
    const clockActive = clock.mode && clock.state !== 'idle';
    const anyActive = clockActive || sessions.length > 0;

    const sig = JSON.stringify([shown.map(s => s.entryId + s.state), sessions.length, clockActive, clock.mode, max]);
    if (sig !== navSig) {
      navSig = sig;
      let html = TIMER_SVG;
      if (clockActive) {
        html += `<span class="ti-item"><span data-tick-clock>0:00</span></span>`;
      }
      shown.forEach(s => {
        const entry = State.getEntry(s.entryId);
        const name = (entry?.title || '?').slice(0, 14);
        html += `<span class="ti-item ${s.state === 'paused' ? 'paused' : ''}" title="${entry?.title || ''}">
          <span class="ti-name">${name}</span> <span data-tick-entry="${s.entryId}">${formatTime(sessionElapsed(s))}</span>
        </span>`;
      });
      if (sessions.length > max) html += `<span class="ti-more">+${sessions.length - max}…</span>`;
      el.innerHTML = html;
    }
    const ck = el.querySelector('[data-tick-clock]');
    if (ck) ck.textContent = formatTime(clock.mode === 'stopwatch' ? clock.elapsed : clock.remaining);
    el.classList.toggle('live', anyActive);
    el.style.display = 'inline-flex';
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function getProgress() {
    if (clock.mode === 'pomodoro') {
      const total = phaseSeconds();
      return total > 0 ? ((total - clock.remaining) / total) * 100 : 0;
    }
    if (clock.mode === 'countdown' && clock.countdownTotal > 0) {
      return ((clock.countdownTotal - clock.remaining) / clock.countdownTotal) * 100;
    }
    return 0;
  }

  // ── Panel rendering ─────────────────────────────────────────
  function linkTaskSelect() {
    const tasks = State.getEntries({ type: 'task', completed: false });
    return `
      <div class="divider"></div>
      <div class="section-title" style="margin-bottom:var(--space-2);">Link to task (optional)</div>
      <select class="form-select" onchange="Timers.linkTask(this.value || null)">
        <option value="">No task — just a timer</option>
        ${tasks.map(t => `<option value="${t.id}" ${clock.linkedTaskId === t.id ? 'selected' : ''}>${window.escapeHtml(t.title)}</option>`).join('')}
      </select>
      ${clock.linkedTaskId ? `<p class="text-xs text-faint" style="margin-top:var(--space-2);">Completed focus time logs to this task and lands in the day planner.</p>` : ''}
    `;
  }

  function clockControls(canStart) {
    const running = clock.state === 'running' && clock.mode === (viewMode === 'track' ? 'stopwatch' : viewMode);
    return `
      <div class="timer-controls">
        <button class="btn btn-secondary" onclick="Timers.resetClock()"><i data-lucide="rotate-ccw" style="width:16px;height:16px"></i>Reset</button>
        ${running
          ? `<button class="btn btn-primary" onclick="Timers.pauseClock()"><i data-lucide="pause" style="width:16px;height:16px"></i>Pause</button>`
          : `<button class="btn btn-primary" onclick="Timers.startClock()" ${canStart === false ? 'disabled style="opacity:0.5"' : ''}><i data-lucide="play" style="width:16px;height:16px"></i>${clock.state === 'paused' && clock.mode === viewMode ? 'Resume' : 'Start'}</button>`
        }
      </div>
    `;
  }

  function render() {
    const body = document.getElementById('panelBody');
    if (!body || !isPanelOpen()) { updateMini(); return; }

    let html = `
      <div class="timer-mode">
        <button class="timer-mode-btn ${viewMode === 'track' ? 'active' : ''}" onclick="Timers.setViewMode('track')">Track${sessions.length ? ` (${sessions.length})` : ''}</button>
        <button class="timer-mode-btn ${viewMode === 'pomodoro' ? 'active' : ''}" onclick="Timers.setViewMode('pomodoro')">Pomodoro</button>
        <button class="timer-mode-btn ${viewMode === 'stopwatch' ? 'active' : ''}" onclick="Timers.setViewMode('stopwatch')">Stopwatch</button>
        <button class="timer-mode-btn ${viewMode === 'countdown' ? 'active' : ''}" onclick="Timers.setViewMode('countdown')">Countdown</button>
      </div>
    `;

    if (viewMode === 'pomodoro') {
      const showLive = clock.mode === 'pomodoro';
      const display = showLive ? clock.remaining : phaseSeconds('work');
      html += `
        <div style="text-align:center;margin-bottom:var(--space-3);">
          <div class="pill pill-accent" style="margin-bottom:var(--space-3);">${PHASE_LABELS[showLive ? clock.phase : 'work']}</div>
        </div>
        <div class="timer-display">${formatTime(display)}</div>
        <div class="progress-bar" style="margin-top:var(--space-4);">
          <div class="progress-fill" style="width:${showLive ? getProgress() : 0}%"></div>
        </div>
        <div style="text-align:center;margin-top:var(--space-2);">
          <span class="stat-label">Session ${clock.count + 1} · ${clock.count} completed today</span>
        </div>
        ${clockControls()}
        <div class="divider"></div>
        <div class="section-title" style="margin-bottom:var(--space-2);">Switch Phase</div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-secondary btn-sm" style="flex:1" onclick="Timers.setPomodoroPhase('work')">Focus</button>
          <button class="btn btn-secondary btn-sm" style="flex:1" onclick="Timers.setPomodoroPhase('break')">Break</button>
          <button class="btn btn-secondary btn-sm" style="flex:1" onclick="Timers.setPomodoroPhase('longBreak')">Long</button>
        </div>
        ${linkTaskSelect()}
      `;
    } else if (viewMode === 'stopwatch') {
      const showLive = clock.mode === 'stopwatch';
      html += `
        <div class="timer-display">${formatTime(showLive ? clock.elapsed : 0)}</div>
        ${clockControls()}
        ${linkTaskSelect()}
      `;
    } else if (viewMode === 'countdown') {
      const showLive = clock.mode === 'countdown';
      const presets = [1, 5, 10, 15, 30];
      html += `
        <div class="timer-display">${formatTime(showLive ? clock.remaining : 0)}</div>
        ${showLive && clock.countdownTotal > 0 ? `
        <div class="progress-bar" style="margin-top:var(--space-4);">
          <div class="progress-fill" style="width:${getProgress()}%"></div>
        </div>` : ''}
        ${clockControls(showLive && clock.remaining > 0)}
        <div class="divider"></div>
        <div class="section-title" style="margin-bottom:var(--space-2);">Set Duration</div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
          ${presets.map(m => `<button class="btn btn-secondary btn-sm" onclick="Timers.setCountdown(${m})">${m}m</button>`).join('')}
        </div>
        ${linkTaskSelect()}
      `;
    } else if (viewMode === 'track') {
      const pending = pendingTaskId ? State.getEntry(pendingTaskId) : null;

      // Armed task waiting for an explicit Start
      if (pending) {
        html += `
          <div class="card" style="border-color:var(--accent);background:var(--accent-tint);margin-bottom:var(--space-3);">
            <div class="text-sm" style="font-weight:600;margin-bottom:var(--space-2);">${window.escapeHtml(pending.title)}</div>
            <div class="timer-display" style="font-size:2rem;">0:00</div>
            <div class="timer-controls">
              <button class="btn btn-secondary" onclick="Timers.cancelPending()">Cancel</button>
              <button class="btn btn-primary" onclick="Timers.startPending()"><i data-lucide="play" style="width:16px;height:16px"></i>Start</button>
            </div>
          </div>
        `;
      }

      // Active sessions — multiple allowed
      if (sessions.length > 0) {
        html += `<div class="section-title" style="margin-bottom:var(--space-2);">Tracking now</div>`;
        sessions.forEach(s => {
          const entry = State.getEntry(s.entryId);
          const proj = entry?.projectId ? State.getProject(entry.projectId) : null;
          html += `
            <div class="session-row ${s.state === 'paused' ? 'paused' : ''}">
              <span class="proj-dot" style="background:${proj?.color || '#888'}"></span>
              <span class="text-sm truncate" style="flex:1">${entry?.title || 'Unknown'}</span>
              <span class="font-mono text-sm" style="color:var(--accent-text);" data-tick-entry="${s.entryId}">${formatTime(sessionElapsed(s))}</span>
              ${s.state === 'running'
                ? `<button class="icon-btn" onclick="Timers.pauseSession('${s.entryId}')" aria-label="Pause"><i data-lucide="pause" style="width:15px;height:15px"></i></button>`
                : `<button class="icon-btn" onclick="Timers.resumeSession('${s.entryId}')" aria-label="Resume"><i data-lucide="play" style="width:15px;height:15px"></i></button>`}
              <button class="icon-btn" onclick="Timers.stopSession('${s.entryId}')" aria-label="Stop and log"><i data-lucide="square" style="width:15px;height:15px"></i></button>
            </div>
          `;
        });
        html += `<p class="text-xs text-faint" style="margin:var(--space-2) 0;">Pause inserts a gap in the planner. Stop logs the session.</p>`;
      }

      if (!pending && sessions.length === 0) {
        html += `<p class="text-muted text-sm" style="text-align:center;margin:var(--space-4) 0;">Nothing tracking. Press ▶ on any task card,<br>or use Pomodoro / Stopwatch / Countdown.</p>`;
      }
    }

    body.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }

  function cancelPending() {
    pendingTaskId = null;
    render();
  }

  // Floating window — no overlay, the app stays fully usable behind it
  function openPanel() {
    document.getElementById('panelTitle').textContent = 'Timer';
    document.getElementById('slidePanel').classList.add('active');
    render();
    updateMini();
  }

  function toggleWindow() {
    if (isPanelOpen()) {
      if (typeof App !== 'undefined') App.closePanel();
    } else {
      openPanel();
    }
  }

  // Stop everything: log + finalize all sessions, reset the clock
  function stopAll() {
    [...sessions].forEach(s => stopSession(s.entryId));
    if (clock.mode) resetClock();
    updateMini();
  }

  // Back-compat: card play buttons arm instead of auto-starting
  function startTracking(taskId) { armTracking(taskId); }

  return {
    // clock
    startClock, pauseClock, resetClock, setViewMode, setPomodoroPhase, setCountdown, linkTask,
    // sessions
    armTracking, startPending, cancelPending, startSession, pauseSession, resumeSession, stopSession,
    getTracking, trackedCount, startTracking,
    // panel / misc
    openPanel, toggleWindow, stopAll, render, updateMini, formatTime, getProgress,
    restore,
  };
})();
