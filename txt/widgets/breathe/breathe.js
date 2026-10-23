/* Breathing Exercise — a calm, guided breathing pacer.
 *
 * Patterns: Box 4-4-4-4, 4-7-8, Coherent 5.5-5.5, Physiological sigh
 * (double inhale + long exhale) and Custom. Sessions run for 1/3/5/10 min,
 * a number of rounds, or until stopped; a timed session is rounded to whole
 * breaths so it never stops mid-breath.
 *
 * One rAF loop drives everything from a single clock (pause-aware): the orb's
 * scale (sine-eased), the phase label, the per-phase countdown and the
 * session ring. Reduced motion (OS setting or the "Calm" toggle) swaps the
 * scaling orb for a filling bar. Optional gentle WebAudio tones (context made
 * on the Start gesture, closed on panel close), optional haptics where
 * navigator.vibrate exists (not on iOS), and a Screen Wake Lock while running
 * (re-acquired when the page becomes visible again).
 *
 * Stats: a small session log in Cade.store ('cade-breathe-log', newest 150,
 * 60 days) → sessions & minutes this week + a 7-day bar strip. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('breathe.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'breathe-panel';
  var PREFS_KEY = 'cade-breathe-prefs';
  var LOG_KEY = 'cade-breathe-log';
  var MIN_LEVEL = 0.42; // orb scale when empty (1 = full)

  var PATTERNS = {
    box: { name: 'Box', sub: '4 \u00b7 4 \u00b7 4 \u00b7 4', desc: 'Equal in, hold, out, hold. Steadying and focusing.',
      phases: [['in', 4], ['hold', 4], ['out', 4], ['rest', 4]] },
    '478': { name: '4-7-8', sub: '4 \u00b7 7 \u00b7 8', desc: 'In 4, hold 7, a long out 8. Helps you wind down.',
      phases: [['in', 4], ['hold', 7], ['out', 8]] },
    coherent: { name: 'Coherent', sub: '5.5 \u00b7 5.5', desc: 'About 5.5 breaths a minute, no holds. Smooth and balancing.',
      phases: [['in', 5.5], ['out', 5.5]] },
    sigh: { name: 'Sigh', sub: '2 + 1 \u00b7 6', desc: 'Physiological sigh: inhale, top up with a second short inhale, then a long exhale. A quick reset.',
      phases: [['in', 2, 0, 0.72], ['in2', 1, 0.72, 1], ['out', 6]] },
    custom: { name: 'Custom', sub: '', desc: 'Your own timing (seconds; holds may be 0).', phases: null },
  };
  var LABEL = { in: 'Breathe in', in2: 'Inhale again', hold: 'Hold', out: 'Breathe out', rest: 'Hold' };
  var LENGTHS = [['1m', '1 min'], ['3m', '3 min'], ['5m', '5 min'], ['10m', '10 min'], ['r5', '5 breaths'], ['r10', '10 breaths'], ['inf', 'Until I stop']];

  // ---- prefs & log ---------------------------------------------------------------
  function readJSON(k, d) { try { var v = JSON.parse(Cade.store.get(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { Cade.store.set(k, JSON.stringify(v)); } catch (e) {} }
  function clampS(v, lo, d) { v = parseFloat(v); return isFinite(v) ? Math.max(lo, Math.min(30, Math.round(v * 2) / 2)) : d; }
  function loadPrefs() {
    var p = readJSON(PREFS_KEY, {}) || {};
    var c = p.custom || {};
    return {
      pattern: PATTERNS[p.pattern] ? p.pattern : 'box',
      custom: { in: clampS(c.in, 1, 4), h1: clampS(c.h1, 0, 2), out: clampS(c.out, 1, 6), h2: clampS(c.h2, 0, 0) },
      len: LENGTHS.some(function (l) { return l[0] === p.len; }) ? p.len : '3m',
      tones: !!p.tones, haptics: p.haptics !== false, calm: !!p.calm,
    };
  }
  function phasesOf(prefs) {
    if (prefs.pattern !== 'custom') return PATTERNS[prefs.pattern].phases;
    var c = prefs.custom, ph = [['in', c.in]];
    if (c.h1 > 0) ph.push(['hold', c.h1]);
    ph.push(['out', c.out]);
    if (c.h2 > 0) ph.push(['rest', c.h2]);
    return ph;
  }
  function cycleLen(ph) { var s = 0; ph.forEach(function (p) { s += p[1]; }); return s; }
  // Whole breaths for the chosen length (Infinity = until stopped).
  function cyclesFor(len, cyc) {
    if (len === 'inf') return Infinity;
    if (len.charAt(0) === 'r') return parseInt(len.slice(1), 10);
    return Math.max(1, Math.round(parseInt(len, 10) * 60 / cyc));
  }
  function patternSub(prefs) {
    if (prefs.pattern !== 'custom') return PATTERNS[prefs.pattern].sub;
    var c = prefs.custom;
    return [c.in, c.h1, c.out, c.h2].filter(function (v, i) { return v > 0 || i === 0 || i === 2; }).join(' \u00b7 ');
  }

  function log() { var a = readJSON(LOG_KEY, []); return Array.isArray(a) ? a : []; }
  function record(entry) {
    var cut = Date.now() - 60 * 86400000;
    var a = log().filter(function (e) { return e && e.t > cut; });
    a.push(entry);
    writeJSON(LOG_KEY, a.slice(-150));
  }
  function dayStart(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function weekStart(ms) { // Monday 00:00 local
    var d = new Date(dayStart(ms)), dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }
  function stats() {
    var a = log(), ws = weekStart(Date.now()), n = 0, sec = 0, days = [];
    var today = dayStart(Date.now());
    for (var i = 6; i >= 0; i--) {
      var d = new Date(today); d.setDate(d.getDate() - i);
      days.push({ t: d.getTime(), s: 0 });
    }
    a.forEach(function (e) {
      if (e.t >= ws) { n++; sec += e.s; }
      var ds = dayStart(e.t);
      for (var j = 0; j < days.length; j++) if (days[j].t === ds) days[j].s += e.s;
    });
    return { n: n, min: sec / 60, days: days };
  }

  // ---- audio / haptics / wake lock -----------------------------------------------------
  var AC = window.AudioContext || window.webkitAudioContext;
  var TONE = { in: 523.25, in2: 659.25, hold: 392, rest: 392, out: 329.63 };
  function chime(st, kind) {
    if (!st.prefs.tones || !st.ac) return;
    try {
      var ac = st.ac, t = ac.currentTime, f = TONE[kind] || 440;
      var g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'hold' || kind === 'rest' ? 0.05 : 0.09, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      g.connect(ac.destination);
      [1, 2.005].forEach(function (mul, i) {
        var o = ac.createOscillator(), og = ac.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(f * mul, t);
        og.gain.value = i ? 0.25 : 1;
        o.connect(og); og.connect(g);
        o.start(t); o.stop(t + 1.7);
      });
    } catch (e) {}
  }
  var canVibrate = typeof navigator.vibrate === 'function';
  function buzz(st, kind) {
    if (!st.prefs.haptics || !canVibrate) return;
    try { navigator.vibrate(kind === 'out' ? [25, 70, 25] : kind === 'hold' || kind === 'rest' ? 12 : 30); } catch (e) {}
  }
  function lockScreen(st) {
    if (!navigator.wakeLock || !navigator.wakeLock.request || st.lock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      if (!st.running || st.paused || st.dead) { l.release().catch(function () {}); return; }
      st.lock = l;
      l.addEventListener('release', function () { if (st.lock === l) st.lock = null; showLock(st); });
      showLock(st);
    }).catch(function () {});
  }
  function unlockScreen(st) {
    var l = st.lock; st.lock = null;
    if (l) l.release().catch(function () {});
    showLock(st);
  }
  function showLock(st) {
    var el = st.p && st.p.querySelector('.br-lock');
    if (el) el.hidden = !st.lock;
  }

  // ---- easing ----------------------------------------------------------------------------
  function ease(x) { return 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x))); }
  function fmtClock(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function reducedOS() { return false; }

  // ---- UI --------------------------------------------------------------------------------
  var S = null;
  function panel() { return document.getElementById(PANEL_ID); }
  var RING_R = 47, RING_C = 2 * Math.PI * RING_R;

  function controlsHTML(prefs) {
    var chips = Object.keys(PATTERNS).map(function (k) {
      var pt = PATTERNS[k];
      return '<button type="button" class="br-pat' + (prefs.pattern === k ? ' on' : '') + '" data-p="' + k + '" aria-pressed="' + (prefs.pattern === k) + '">' +
        '<span class="br-pat-n">' + pt.name + '</span><span class="br-pat-s">' + (k === 'custom' ? '\u270e' : pt.sub) + '</span></button>';
    }).join('');
    var c = prefs.custom;
    function num(key, label, min) {
      return '<label class="br-num"><span>' + label + '</span><input type="number" inputmode="decimal" min="' + min + '" max="30" step="0.5" data-k="' + key + '" value="' + c[key] + '"></label>';
    }
    return '<div class="br-pats" role="group" aria-label="Pattern">' + chips + '</div>' +
      '<div class="br-desc"></div>' +
      '<div class="br-custom"' + (prefs.pattern === 'custom' ? '' : ' hidden') + '>' + num('in', 'In', 1) + num('h1', 'Hold', 0) + num('out', 'Out', 1) + num('h2', 'Hold', 0) + '</div>' +
      '<div class="br-row"><label class="br-sel"><span>Length</span><select class="br-len">' +
        LENGTHS.map(function (l) { return '<option value="' + l[0] + '"' + (prefs.len === l[0] ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('') +
      '</select></label><span class="br-est"></span></div>' +
      '<div class="br-togs">' +
        '<button type="button" class="br-tog" data-t="tones" aria-pressed="' + prefs.tones + '">\u266a Tones</button>' +
        '<button type="button" class="br-tog" data-t="haptics" aria-pressed="' + (prefs.haptics && canVibrate) + '"' + (canVibrate ? '' : ' disabled title="This browser can\u2019t vibrate (iOS doesn\u2019t allow it for web pages)"') + '>\u2248 Haptics</button>' +
        '<button type="button" class="br-tog" data-t="calm" aria-pressed="' + (prefs.calm || reducedOS()) + '"' + (reducedOS() ? ' disabled title="Your system asks for reduced motion"' : ' title="A filling bar instead of a growing circle"') + '>\u25ad Calm view</button>' +
      '</div>';
  }

  function renderSetup() {
    var st = S; if (!st) return;
    var p = st.p, pr = st.prefs;
    p.querySelectorAll('.br-pat').forEach(function (b) {
      var on = b.getAttribute('data-p') === pr.pattern;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    p.querySelector('.br-desc').textContent = PATTERNS[pr.pattern].desc;
    p.querySelector('.br-custom').hidden = pr.pattern !== 'custom';
    var ph = phasesOf(pr), cyc = cycleLen(ph), n = cyclesFor(pr.len, cyc);
    p.querySelector('.br-est').textContent = n === Infinity
      ? cyc + ' s per breath'
      : n + ' breath' + (n === 1 ? '' : 's') + ' \u00b7 ' + fmtClock(n * cyc);
    p.querySelector('.br-tog[data-t="tones"]').setAttribute('aria-pressed', pr.tones ? 'true' : 'false');
    if (canVibrate) p.querySelector('.br-tog[data-t="haptics"]').setAttribute('aria-pressed', pr.haptics ? 'true' : 'false');
    if (!reducedOS()) p.querySelector('.br-tog[data-t="calm"]').setAttribute('aria-pressed', pr.calm ? 'true' : 'false');
    st.calm = pr.calm || reducedOS();
    p.classList.toggle('br-calm', st.calm);
    if (!st.calm) st.orb.style.opacity = '';
    if (!st.running) {
      setLabel(st, 'Ready', patternSub(pr) || ' ');
      setLevel(st, 0.55);
      setRing(st, 0);
      p.querySelector('.br-time').textContent = n === Infinity ? 'Open-ended' : fmtClock(n * cyc);
    }
    renderStats();
  }

  function renderStats() {
    var st = S; if (!st) return;
    var s = stats(), mx = 1;
    s.days.forEach(function (d) { mx = Math.max(mx, d.s); });
    var wk = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var bars = s.days.map(function (d, i) {
      var h = d.s ? Math.max(8, Math.round(d.s / mx * 100)) : 0;
      return '<span class="br-day' + (i === 6 ? ' today' : '') + '" title="' + Math.round(d.s / 60) + ' min"><span class="br-bar-v" style="height:' + h + '%"></span><span class="br-day-l">' + wk[new Date(d.t).getDay()] + '</span></span>';
    }).join('');
    st.p.querySelector('.br-stats').innerHTML =
      '<div class="br-st-txt"><b>' + s.n + '</b> session' + (s.n === 1 ? '' : 's') + ' \u00b7 <b>' + (s.min < 10 ? Math.round(s.min * 10) / 10 : Math.round(s.min)) + '</b> min this week</div>' +
      '<div class="br-days" aria-label="Minutes per day, last 7 days">' + bars + '</div>';
  }

  function setLabel(st, phase, count) {
    if (st.lastLabel !== phase) {
      st.lastLabel = phase;
      var el = st.p.querySelector('.br-phase');
      el.textContent = phase;
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    }
    if (st.lastCount !== count) { st.lastCount = count; st.p.querySelector('.br-count').textContent = count; }
  }
  // Only compositor-friendly properties change per frame (transform / opacity).
  function setLevel(st, lv) {
    if (st.calm) {
      st.barFill.style.transform = 'scaleX(' + lv.toFixed(4) + ')';
      st.orb.style.opacity = (0.4 + lv * 0.6).toFixed(3);
    } else {
      st.orb.style.transform = 'scale(' + (MIN_LEVEL + (1 - MIN_LEVEL) * lv).toFixed(4) + ')';
    }
  }
  function setRing(st, f) {
    st.ring.style.strokeDashoffset = (RING_C * (1 - Math.max(0, Math.min(1, f)))).toFixed(2);
  }

  // ---- engine ----------------------------------------------------------------------------
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function start() {
    var st = S; if (!st || st.running) return;
    var ph = phasesOf(st.prefs), cyc = cycleLen(ph);
    st.ph = ph; st.cyc = cyc; st.total = cyclesFor(st.prefs.len, cyc);
    st.running = true; st.paused = false; st.t0 = now(); st.pausedFor = 0; st.lastPhase = -1; st.lastCycle = -1;
    st.startedAt = Date.now(); st.lastLabel = ''; st.lastCount = '';
    if (st.prefs.tones && AC) {
      try { if (!st.ac) st.ac = new AC(); if (st.ac.state === 'suspended') st.ac.resume(); } catch (e) { st.ac = null; }
    }
    st.p.classList.add('br-running');
    st.p.classList.remove('br-done');
    lockScreen(st);
    buttons();
    loop();
  }
  function pause() {
    var st = S; if (!st || !st.running || st.paused) return;
    st.paused = true; st.pauseAt = now();
    cancelAnimationFrame(st.raf);
    unlockScreen(st);
    st.p.classList.add('br-paused');
    setLabel(st, 'Paused', st.lastCount);
    buttons();
  }
  function resume() {
    var st = S; if (!st || !st.paused) return;
    st.pausedFor += now() - st.pauseAt;
    st.paused = false; st.lastLabel = ''; st.lastPhase = -1;
    st.p.classList.remove('br-paused');
    if (st.ac && st.ac.state === 'suspended') st.ac.resume();
    lockScreen(st);
    buttons();
    loop();
  }
  function stop(completed) {
    var st = S; if (!st || !st.running) return;
    cancelAnimationFrame(st.raf);
    var el = st.paused ? st.pauseAt - st.t0 - st.pausedFor : now() - st.t0 - st.pausedFor;
    var secs = Math.max(0, el / 1000);
    if (completed) secs = Math.min(secs, st.total * st.cyc); // the frame that noticed the end may come late
    var breaths = Math.floor(secs / st.cyc + 1e-6);
    st.running = false; st.paused = false;
    unlockScreen(st);
    st.p.classList.remove('br-running', 'br-paused');
    if (completed || secs >= 30) {
      record({ t: st.startedAt, s: Math.round(secs), p: st.prefs.pattern, b: breaths });
      st.p.classList.add('br-done');
      st.p.querySelector('.br-sum').innerHTML =
        '<div class="br-sum-t">' + (completed ? 'Session complete' : 'Nice \u2014 every breath counts') + '</div>' +
        '<div class="br-sum-s"><b>' + fmtClock(secs) + '</b> \u00b7 ' + breaths + ' breath' + (breaths === 1 ? '' : 's') + ' \u00b7 ' + esc(PATTERNS[st.prefs.pattern].name) + '</div>';
      if (completed) { chime(st, 'in'); buzz(st, 'out'); }
    }
    buttons();
    renderSetup();
  }
  function buttons() {
    var st = S; if (!st) return;
    var main = st.p.querySelector('.br-go');
    main.textContent = !st.running ? (st.p.classList.contains('br-done') ? '\u21bb Again' : '\u25b6 Start') : st.paused ? '\u25b6 Resume' : '\u2759\u2759 Pause';
    main.classList.toggle('primary', !st.running || st.paused);
    st.p.querySelector('.br-stop').hidden = !st.running;
  }

  function loop() {
    var st = S; if (!st || !st.running || st.paused || st.dead) return;
    var el = (now() - st.t0 - st.pausedFor) / 1000;
    var totalS = st.total * st.cyc;
    if (el >= totalS) { setLevel(st, 0); setRing(st, 1); stop(true); return; }
    var cycle = Math.floor(el / st.cyc), inC = el - cycle * st.cyc, i = 0, acc = 0;
    while (i < st.ph.length - 1 && inC >= acc + st.ph[i][1]) { acc += st.ph[i][1]; i++; }
    var phz = st.ph[i], frac = (inC - acc) / phz[1], kind = phz[0], lv;
    if (kind === 'in' || kind === 'in2') {
      var from = phz[2] != null ? phz[2] : 0, to = phz[3] != null ? phz[3] : 1;
      lv = from + (to - from) * ease(frac);
    } else if (kind === 'out') {
      var top = i > 0 && st.ph[i - 1][3] != null ? st.ph[i - 1][3] : 1;
      lv = top * (1 - ease(frac));
    } else lv = kind === 'hold' ? 1 : 0;
    setLevel(st, lv);
    var remain = Math.ceil(phz[1] * (1 - frac) - 1e-6);
    setLabel(st, LABEL[kind], String(Math.max(1, remain)));
    if (i !== st.lastPhase || cycle !== st.lastCycle) {
      if (st.lastPhase !== -1 || cycle !== st.lastCycle) { chime(st, kind); buzz(st, kind); }
      st.lastPhase = i; st.lastCycle = cycle;
    }
    setRing(st, st.total === Infinity ? (inC / st.cyc) : el / totalS);
    var t = st.p.querySelector('.br-time');
    var txt = st.total === Infinity ? fmtClock(el) + ' \u00b7 breath ' + (cycle + 1) : fmtClock(el) + ' / ' + fmtClock(totalS) + ' \u00b7 breath ' + (cycle + 1) + ' of ' + st.total;
    if (t.textContent !== txt) t.textContent = txt;
    st.raf = requestAnimationFrame(loop);
  }

  // ---- open / close ----------------------------------------------------------------------
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }
  function setFull(on) {
    var st = S; if (!st) return;
    st.p.classList.toggle('br-full', on);
    st.p.querySelector('.br-fullbtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    st.p.querySelector('.br-fullbtn').textContent = on ? '\u2922 Exit focus' : '\u2921 Focus';
  }

  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    var prefs = loadPrefs();
    var p = Cade.mkPanel(PANEL_ID, '\u25ef Breathe',
      '<div class="br-stage">' +
        '<svg class="br-ringsvg" viewBox="0 0 100 100" aria-hidden="true"><circle class="br-ring-t" cx="50" cy="50" r="' + RING_R + '"/>' +
          '<circle class="br-ring-p" cx="50" cy="50" r="' + RING_R + '" stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + RING_C.toFixed(2) + '" transform="rotate(-90 50 50)"/></svg>' +
        '<div class="br-orb" aria-hidden="true"><div class="br-orb-core"></div></div>' +
        '<div class="br-barbox" aria-hidden="true"><div class="br-barfill"></div></div>' +
        '<div class="br-center" aria-live="polite"><div class="br-phase">Ready</div><div class="br-count"></div></div>' +
        '<div class="br-sum"></div>' +
      '</div>' +
      '<div class="br-time"></div>' +
      '<div class="br-acts">' +
        '<button type="button" class="br-btn primary br-go">\u25b6 Start</button>' +
        '<button type="button" class="br-btn br-stop" hidden>\u25a0 Stop</button>' +
        '<button type="button" class="br-btn br-fullbtn" aria-pressed="false" title="Fill the window">\u2921 Focus</button>' +
      '</div>' +
      '<div class="br-lock" hidden>\u2600 Screen stays on while breathing</div>' +
      '<div class="br-setup">' + controlsHTML(prefs) + '</div>' +
      '<div class="br-stats"></div>');
    var st = S = {
      p: p, prefs: prefs, running: false, paused: false, dead: false, raf: 0, ac: null, lock: null,
      orb: p.querySelector('.br-orb'), barFill: p.querySelector('.br-barfill'), ring: p.querySelector('.br-ring-p'), stage: p.querySelector('.br-stage'),
    };
    function save() { writeJSON(PREFS_KEY, st.prefs); }

    p.addEventListener('click', function (e) {
      var t = e.target; if (!t.closest) return;
      var b;
      if (t.closest('.br-go')) {
        if (!st.running) { st.p.classList.remove('br-done'); start(); }
        else if (st.paused) resume(); else pause();
      } else if (t.closest('.br-stop')) stop(false);
      else if (t.closest('.br-fullbtn')) setFull(!p.classList.contains('br-full'));
      else if ((b = t.closest('.br-pat'))) {
        if (st.running) return;
        st.prefs.pattern = b.getAttribute('data-p'); save();
        p.classList.remove('br-done'); renderSetup();
      } else if ((b = t.closest('.br-tog'))) {
        if (b.disabled) return;
        var k = b.getAttribute('data-t');
        st.prefs[k] = !st.prefs[k]; save();
        if (k === 'tones' && st.prefs.tones && AC) {
          // Create/resume the context inside this gesture so the first chime plays on iOS.
          try { if (!st.ac) st.ac = new AC(); if (st.ac.state === 'suspended') st.ac.resume(); } catch (er) { st.ac = null; }
          chime(st, 'in');
        }
        if (k === 'haptics' && st.prefs.haptics) buzz(st, 'in');
        renderSetup();
      } else if (t.closest('.br-stage') && !st.running && !t.closest('.br-sum')) {
        start();
      } else if (t.closest('.br-stage') && st.running) {
        if (st.paused) resume(); else pause();
      }
    });
    p.querySelector('.br-len').addEventListener('change', function (e) { st.prefs.len = e.target.value; save(); p.classList.remove('br-done'); renderSetup(); });
    p.querySelector('.br-custom').addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      var lo = k === 'in' || k === 'out' ? 1 : 0, v = parseFloat(e.target.value);
      if (!isFinite(v)) return;
      st.prefs.custom[k] = clampS(v, lo, st.prefs.custom[k]); save(); renderSetup();
    });
    p.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName;
      var field = tag === 'INPUT' || tag === 'SELECT';
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (p.classList.contains('br-full')) setFull(false); else close();
        return;
      }
      if ((e.key === ' ' || e.key === 'Enter') && !field && !(e.target.closest && e.target.closest('button'))) {
        e.preventDefault();
        if (!st.running) start(); else if (st.paused) resume(); else pause();
      }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    });
    var onVis = function () {
      if (document.visibilityState === 'hidden') { if (st.running && !st.paused) pause(); }
      else if (st.running && !st.paused) lockScreen(st);
    };
    document.addEventListener('visibilitychange', onVis);
    p._onClose = function () {
      st.dead = true;
      if (st.running) stop(false);
      cancelAnimationFrame(st.raf);
      unlockScreen(st);
      document.removeEventListener('visibilitychange', onVis);
      if (st.ac) { try { st.ac.close(); } catch (e) {} st.ac = null; }
      if (S === st) S = null;
    };
    renderSetup();
  }

  Cade.registerWidget({
    name: 'Breathing Exercise',
    description: 'Guided breathing \u2014 box, 4-7-8, coherent, physiological sigh or custom',
    icon: '\u25ef',
    tags: 'breathe,breathing,breath,calm,relax,meditation,box breathing,4-7-8,coherent,sigh,stress,anxiety,focus,mindfulness',
    open: open,
    _test: { phasesOf: phasesOf, cycleLen: cycleLen, cyclesFor: cyclesFor, stats: stats, record: record, weekStart: weekStart },
  });
})();
