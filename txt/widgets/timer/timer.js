/* Timer widget — pomodoro · countdown · time-of-day · stopwatch.
   Extracted from txt.html into a lazily-loaded module (core slimming).
   Core keeps only: the footer chip element (#timer-chip), a thin
   window.openTimer shim that routes through the widget stub, and the
   resize handler's call to window.__timerAutoMin. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('timer.css');
  var store = Cade.store;
  var showToast = window.showToast;

// ---- Pomodoro / focus timer (#31) ----
// ---- Generic timer (#31, reworked): pomodoro · countdown · time-of-day · stopwatch ----
let _timerMinimized = false, _timerFlashing = false;
const _timer = {
  mode: 'pomodoro',      // 'pomodoro' | 'countdown' | 'clock' | 'stopwatch'
  running: false, timer: null,
  // pomodoro
  phase: 'work', remaining: 25 * 60, count: 0, work: 25, brk: 5,
  // countdown
  cdTotal: 5 * 60, cdRemaining: 5 * 60,
  // time-of-day target ('HH:MM')
  clockTarget: '',
  // stopwatch (millisecond precision via performance.now)
  swMs: 0, swStart: 0, laps: [],
};
// Live stopwatch elapsed in ms (counts from swStart while running).
function _swNow() {
  return (_timer.running && _timer.mode === 'stopwatch') ? (performance.now() - _timer.swStart) : _timer.swMs;
}
// mm:ss.cs (centiseconds), with hours when needed — for the stopwatch + laps.
function _timerFmtMs(ms) {
  ms = Math.max(0, ms);
  const totalCs = Math.floor(ms / 10);
  const cs = totalCs % 100, totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60, m = Math.floor(totalSec / 60) % 60, h = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return (h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s))) + '.' + pad(cs);
}
function _timerLoadCfg() {
  try {
    const s = JSON.parse(store.get('cade-timer-cfg') || '{}');
    _timer.work = +s.work || 25; _timer.brk = +s.brk || 5;
    _timer.cdTotal = +s.cdTotal || 5 * 60; _timer.clockTarget = s.clockTarget || '';
    if (s.mode) _timer.mode = s.mode;
  } catch {}
}
function _timerSaveCfg() {
  store.set('cade-timer-cfg', JSON.stringify({ work: _timer.work, brk: _timer.brk, cdTotal: _timer.cdTotal, clockTarget: _timer.clockTarget, mode: _timer.mode }));
}
function _timerFmt(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h > 0 ? (h + ':' + mm + ':' + sss) : (m + ':' + sss);
}
// Format an 'HH:MM' (24hr) target as 12hr with AM/PM for display (D6).
function _fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return hhmm || '';
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m[2] + ' ' + ap;
}
function _clockRemaining(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return 0;
  const now = new Date();
  const target = new Date(now); target.setHours(+m[1], +m[2], 0, 0);
  let diff = Math.floor((target - now) / 1000);
  if (diff < 0) diff += 24 * 3600; // roll to tomorrow if the time already passed
  return diff;
}
function _timerNotify(title, body, noToast) {
  try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch {}
  try { if (window.Notification && Notification.permission === 'granted') { new Notification(title, { body }); return; } } catch {}
  if (!noToast) showToast(body, 'success', 4000);
}
function _timerPrime() {
  const t = _timer;
  if (t.mode === 'pomodoro') { t.phase = 'work'; t.remaining = t.work * 60; }
  else if (t.mode === 'countdown') { t.cdRemaining = t.cdTotal; }
  else if (t.mode === 'stopwatch') { t.swMs = 0; t.swStart = 0; t.laps = []; }
}
function _timerStop() { _timer.running = false; clearInterval(_timer.timer); }
function _timerTick() {
  const t = _timer;
  if (t.mode === 'pomodoro') {
    if (t.remaining > 0) { t.remaining--; }
    else if (t.phase === 'work') { t.count++; t.phase = 'break'; t.remaining = t.brk * 60; _timerNotify('Break time', 'Take a ' + t.brk + ' minute break.'); }
    else { t.phase = 'work'; t.remaining = t.work * 60; _timerNotify('Focus time', 'Back to it — ' + t.work + ' minutes.'); }
  } else if (t.mode === 'countdown') {
    if (t.cdRemaining > 0) t.cdRemaining--;
    if (t.cdRemaining <= 0) { _timerStop(); _timerFire('Timer done', 'Countdown finished.', { title: 'COUNTDOWN DONE' }); }
  } else if (t.mode === 'clock') {
    if (_clockRemaining(t.clockTarget) <= 0) { _timerStop(); _timerFire('Time reached', _fmt12(t.clockTarget) + ' reached.'); }
  } /* stopwatch: display is computed live from swStart, nothing to increment */
  _timerRender();
  _timerChipUpdate();
}
function _timerPref(key, dflt) { try { const v = window.Settings && Settings.get('widgets.' + key); return v == null ? dflt : v; } catch { return dflt; } }
// Timer reached zero: notify, un-minimize so it's visible, and flash for attention.
// opts.title (D8) swaps the browser tab title (e.g. "COUNTDOWN DONE") until the
// firing timer is acknowledged. We suppress the success toast here — the flashing
// panel + tab title + notification are the signal (D8).
let _timerPrevTitle = null;
function _timerFire(title, body, opts) {
  _timerNotify(title, body, true);
  if (opts && opts.title) {
    if (_timerPrevTitle == null) _timerPrevTitle = document.title;
    try { document.title = opts.title; } catch {}
  }
  if (!document.getElementById('timer-panel')) { _timerMinimized = false; try { window.openTimer(); } catch {} }
  _timerStartFlash();
}
function _timerStartFlash() {
  const p = document.getElementById('timer-panel'); if (!p) return;
  p.classList.add('timer-flash');
  _timerFlashing = true;
  if (!_timerPref('timerFlashUntilAck', true)) {
    setTimeout(() => { if (_timerFlashing) _timerStopFlash(); }, 4000); // a few flashes then stop
  }
}
function _timerStopFlash() {
  const p = document.getElementById('timer-panel'); if (p) p.classList.remove('timer-flash');
  _timerFlashing = false;
  if (_timerPrevTitle != null) { try { document.title = _timerPrevTitle; } catch {} _timerPrevTitle = null; }
}
// Current display value for the active mode (used by panel + footer chip).
function _timerCurrentDisp() {
  const t = _timer;
  if (t.mode === 'pomodoro') return _timerFmt(t.remaining);
  if (t.mode === 'countdown') return _timerFmt(t.cdRemaining);
  if (t.mode === 'clock') return _timerFmt(_clockRemaining(t.clockTarget));
  return _timerFmtMs(_swNow());
}
// Footer chip — lets the timer keep running while the panel is closed (minimized).
function _timerChipUpdate() {
  const chip = document.getElementById('timer-chip'); if (!chip) return;
  const panelOpen = !!document.getElementById('timer-panel');
  // Show while minimized whether running OR paused (a paused timer can be
  // minimized too). Running timers also show even if not explicitly minimized.
  const show = !panelOpen && (_timerMinimized || _timer.running);
  chip.style.display = show ? '' : 'none';
  if (show) chip.textContent = (_timer.running ? '⏱ ' : '⏸ ') + _timerCurrentDisp();
}
const _TIMER_TABS = [['pomodoro', 'Pomodoro'], ['countdown', 'Countdown'], ['clock', 'Time of day'], ['stopwatch', 'Stopwatch']];
function _timerBodyHtml() {
  const t = _timer;
  let html = '<div class="timer-tabs">' + _TIMER_TABS.map(([m, lbl]) =>
    `<button class="timer-tab ${t.mode === m ? 'active' : ''}" onclick="timerSetMode('${m}')">${lbl}</button>`).join('') + '</div>';
  html += '<div class="timer-display"><span class="timer-time"></span><span class="timer-sub"></span></div>';
  if (t.mode === 'pomodoro') {
    html += `<div class="timer-cfg"><label>Focus<input type="number" min="1" max="180" value="${t.work}" onchange="timerCfg('work',this.value)"></label>` +
            `<label>Break<input type="number" min="1" max="60" value="${t.brk}" onchange="timerCfg('brk',this.value)"></label></div>`;
  } else if (t.mode === 'countdown') {
    // Sub-minute allowed (e.g. 0.5 = 30s). Trim trailing zeros for display.
    const mins = +(t.cdTotal / 60).toFixed(3);
    html += `<div class="timer-cfg"><label>Minutes<input type="number" min="0" max="600" step="any" value="${mins}" onchange="timerCfg('cd',this.value)"></label></div>`;
  } else if (t.mode === 'clock') {
    html += `<div class="timer-cfg"><label>Target<input type="time" value="${t.clockTarget || ''}" onchange="timerCfg('clock',this.value)"></label></div>`;
  }
  html += '<div class="timer-btns"><button class="btn btn-primary timer-start" onclick="timerToggleRun()">Start</button>';
  if (t.mode === 'stopwatch') html += '<button class="btn" onclick="timerLap()">Lap</button>';
  html += '<button class="btn" onclick="timerReset()">Reset</button></div>';
  html += '<div class="timer-btns"><button class="btn timer-min" onclick="timerMinimize()">Minimize ▾</button></div>';
  if (t.mode === 'stopwatch') html += '<div class="timer-laps"></div>';
  return html;
}
function _timerRebuild() {
  const p = document.getElementById('timer-panel'); if (!p) return;
  const body = p.querySelector('.cade-panel-body'); if (body) body.innerHTML = _timerBodyHtml();
  _timerRender();
}
function _timerRender() {
  const p = document.getElementById('timer-panel'); if (!p) return;
  const t = _timer;
  let disp = '', sub = '';
  if (t.mode === 'pomodoro') { disp = _timerFmt(t.remaining); sub = (t.phase === 'work' ? 'Focus' : 'Break') + ' · done ' + t.count; p.classList.toggle('break', t.phase !== 'work'); }
  else if (t.mode === 'countdown') { disp = _timerFmt(t.cdRemaining); sub = 'Countdown'; }
  else if (t.mode === 'clock') { const r = _clockRemaining(t.clockTarget); disp = _timerFmt(r); sub = t.clockTarget ? ('until ' + _fmt12(t.clockTarget)) : 'set a time'; }
  else { disp = _timerFmtMs(_swNow()); sub = 'Stopwatch'; }
  const te = p.querySelector('.timer-time'); if (te) te.textContent = disp;
  const se = p.querySelector('.timer-sub'); if (se) se.textContent = sub;
  const sb = p.querySelector('.timer-start'); if (sb) sb.textContent = t.running ? 'Pause' : 'Start';
  const le = p.querySelector('.timer-laps');
  if (le) {
    // Each lap shows its split (time since the previous lap) and the delta vs the
    // previous split: +slower / −faster (the first lap has no previous, so —).
    const rows = [];
    for (let i = 0; i < t.laps.length; i++) {
      const split = t.laps[i] - (i > 0 ? t.laps[i - 1] : 0);
      const prevSplit = i > 0 ? (t.laps[i - 1] - (i > 1 ? t.laps[i - 2] : 0)) : null;
      let delta = '—', cls = '';
      if (prevSplit != null) {
        const d = split - prevSplit;
        if (Math.abs(d) < 10) { delta = '±0.00'; }
        else { delta = (d > 0 ? '+' : '−') + _timerFmtMs(Math.abs(d)); cls = d > 0 ? 'slower' : 'faster'; }
      }
      rows.push(`<div class="timer-lap"><span>Lap ${i + 1}</span><span>${_timerFmtMs(split)}</span><span class="timer-lap-d ${cls}">${delta}</span></div>`);
    }
    le.innerHTML = rows.reverse().join('');
  }
  _timerChipUpdate();
}
window.timerMinimize = function() {
  _timerStopFlash();
  _timerMinimized = true;           // chip stays even when paused
  const p = document.getElementById('timer-panel');
  if (p) { p.remove(); }            // keeps _timer.timer running in the background
  store.set('cade-timer-open', '0');
  _timerChipUpdate();
};
window.timerSetMode = function(m) { if (_timer.mode === m) return; _timerStop(); _timer.mode = m; _timerPrime(); _timerSaveCfg(); _timerRebuild(); };
window.timerCfg = function(k, v) {
  const t = _timer;
  if (k === 'clock') { t.clockTarget = String(v || ''); _timerSaveCfg(); _timerRender(); return; }
  v = +v || 0;
  if (k === 'work') { t.work = Math.max(1, v); if (!t.running && t.phase === 'work') t.remaining = t.work * 60; }
  else if (k === 'brk') { t.brk = Math.max(1, v); }
  else if (k === 'cd') { t.cdTotal = Math.max(0, v * 60); if (!t.running) t.cdRemaining = t.cdTotal; }
  _timerSaveCfg(); _timerRender();
};
window.timerToggleRun = function() {
  _timerStopFlash(); // any control press acknowledges a firing timer
  const t = _timer; t.running = !t.running;
  if (t.running) {
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
    if (t.mode === 'stopwatch') t.swStart = performance.now() - t.swMs; // resume from accumulated ms
    clearInterval(t.timer);
    // Stopwatch needs sub-second updates for the ms display; others tick at 1s.
    t.timer = setInterval(_timerTick, t.mode === 'stopwatch' ? 41 : 1000);
  } else {
    if (t.mode === 'stopwatch') t.swMs = performance.now() - t.swStart; // freeze accumulated ms
    clearInterval(t.timer);
  }
  _timerRender();
};
window.timerReset = function() { _timerStopFlash(); _timerStop(); _timerPrime(); _timerRender(); };
window.timerLap = function() { if (_timer.mode !== 'stopwatch') return; _timer.laps.push(_swNow()); _timerRender(); };
window.openTimer = function() {
  Cade.closeAllMenus();
  const existing = document.getElementById('timer-panel');
  // Toggling from the menu while open = minimize (don't lose a running timer).
  if (existing) { window.timerMinimize(); return; }
  _timerLoadCfg();
  _timerMinimized = false;
  if (!_timer.running) _timerPrime();
  const p = Cade.mkPanel('timer-panel', 'Timer', _timerBodyHtml());
  // The X (close): if a timer is live and the "minimize on close" pref is on,
  // keep it running with the footer chip; otherwise stop + dismiss fully.
  p._onClose = () => {
    _timerStopFlash();
    if (_timer.running && _timerPref('timerMinimizeOnClose', true)) { _timerMinimized = true; }
    else { _timerStop(); _timerMinimized = false; }
    store.set('cade-timer-open', '0');
    _timerChipUpdate();
  };
  // Clicking anywhere in the panel acknowledges a firing timer.
  p.addEventListener('pointerdown', () => { if (_timerFlashing) _timerStopFlash(); });
  _timerRender();
  _timerChipUpdate();
  store.set('cade-timer-open', '1');
};
window.togglePomodoro = window.openTimer; // back-compat (restore hook / old callers)

// Resize auto-minimize hook (core calls this on real width changes so an
// off-screen panel keeps running as the footer chip instead of orphaning).
window.__timerAutoMin = function () {
  if (document.getElementById('timer-panel') && !_timerFlashing) { try { window.timerMinimize(); } catch (e) {} }
};

// Widget-scoped settings (appear in Settings once the module has loaded).
Cade.registerSetting({ key: 'widgets.timerFlashUntilAck', label: 'Timer flashes until acknowledged', type: 'toggle', default: true, section: 'Behavior', hint: 'When a timer fires, keep flashing the popup until you click it / press Stop / close it.' });
Cade.registerSetting({ key: 'widgets.timerMinimizeOnClose', label: 'Minimize running timer on close', type: 'toggle', default: true, section: 'Behavior', hint: 'Closing the timer while it is running keeps it going as a footer chip instead of stopping it.' });

Cade.registerWidget({
  name: 'Timer',
  description: 'Pomodoro · countdown · time-of-day · stopwatch',
  icon: '⏱',
  tags: 'timer,pomodoro,countdown,stopwatch,clock,focus',
  open: function () { window.openTimer(); },
});
})();
