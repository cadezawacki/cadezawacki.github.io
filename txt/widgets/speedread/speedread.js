/* Speed Reader — read the note (or the selection, or pasted text) one chunk
 * at a time in one spot (RSVP), so the eye never has to travel.
 *
 * DISPLAY: the current chunk large in the middle. A single word is aligned
 * on its optimal-recognition letter (shown in the accent colour) at a fixed
 * fixation point marked by two ticks; chunks of 2–5 words are centred. The
 * text around it — on the same line, or as a line above and below — is
 * shown at the configured opacity (0 hides it). A word too wide for the
 * stage is shrunk to fit.
 *
 * CONTROLS: tap the display (or Space) to play / pause; press and hold it to
 * read only while held (lets go = pause); ⏮ / ⏭ (←/→) back / forward a
 * sentence (back goes to the start of this sentence first); − / + (↓/↑)
 * speed; the scrubber jumps anywhere; "1 word" cycles the chunk size (or
 * keys 1–5); ⚙ opens Widget preferences. Paste reads pasted text instead.
 *
 * PACING (speedread-core.js): long words, numbers and punctuation get extra
 * time, sentence ends by the "pause at sentence ends" multiplier. Playback is
 * one setTimeout per chunk against an absolute schedule (no drift, no rAF
 * loop). Starts at the caret (or the start of the note — a pref; a
 * selection always from its start) and, on close, can put the caret where
 * you stopped (positions are mapped through edits made meanwhile, and only
 * applied when the text there is still the same).
 *
 * PHONE: the panel becomes a full-screen sheet (portrait or landscape) with
 * big controls; a screen wake lock is held while playing. It pauses when the
 * page is hidden or the panel minimized. Close removes every timer,
 * listener, prefs subscription and the wake lock.
 *
 * PREFS: Cade.prefs('speedread') (schema in the manifest; FIELDS below is
 * the same), with a local fallback until the core has it; changes apply
 * live. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('speedread.css');
  var CORE_URL = BASE + 'speedread-core.js';
  var ID = 'speedread', PANEL_ID = 'speedread-panel';
  var MAX_CHARS = 400000;
  var CTX_WORDS = 10;   // words of context rendered on each side

  var META = {
    name: 'Speed Reader',
    description: 'Read the note or selection one word (or a few) at a time in one spot, focus letter highlighted — tap to play, hold to read, scrub, back a sentence',
    icon: '⚡',
    tags: 'speed reader,speed reading,rsvp,spritz,read,reading,fast,focus,words per minute,wpm,skim,study'
  };

  var FIELDS = [
    { key: 'chunk', type: 'number', label: 'Words shown at a time', default: 1, min: 1, max: 5, step: 1 },
    { key: 'wpm', type: 'slider', label: 'Speed', default: 350, min: 100, max: 1000, step: 25, unit: 'wpm' },
    { key: 'ctx', type: 'toggle', label: 'Show the text around it', default: true, hint: 'The words before and after the current one, faded' },
    { key: 'dim', type: 'slider', label: 'Opacity of the text around it', default: 25, min: 0, max: 100, step: 5, unit: '%', showIf: 'ctx', hint: '0 hides it' },
    { key: 'ctxPos', type: 'radio', label: 'Where it goes', default: 'inline', showIf: 'ctx',
      options: [{ value: 'inline', label: 'Same line' }, { value: 'lines', label: 'A line above and below' }] },
    { key: 'orp', type: 'toggle', label: 'Highlight the focus letter', default: true, hint: 'One letter of each word in the accent colour, always at the same spot' },
    { key: 'pause', type: 'slider', label: 'Pause at sentence ends', default: 2, min: 1, max: 4, step: 0.25, unit: '×',
      hint: 'Commas get half as much extra, paragraphs a little more; long words and numbers always get a bit longer' },
    { key: 'size', type: 'slider', label: 'Text size', default: 44, min: 24, max: 96, step: 4, unit: 'px' },
    { key: 'start', type: 'radio', label: 'Start from', default: 'caret',
      options: [{ value: 'caret', label: 'The caret' }, { value: 'top', label: 'The start of the note' }], hint: 'A selection is always read from its start' },
    { key: 'moveCaret', type: 'toggle', label: 'Move the caret to where I stopped', default: true, hint: 'When you close the reader' }
  ];
  var FIELD = {};
  FIELDS.forEach(function (f) { if (f.key) FIELD[f.key] = f; });

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }

  // ---- prefs ---------------------------------------------------------------------------
  var fallbackPrefs = null;
  function prefsOf(id, fields) {
    if (Cade.prefs) return Cade.prefs(id);
    if (fallbackPrefs) return fallbackPrefs;
    var d = {}, ls = [];
    fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    function all() { var o = {}; for (var k in d) o[k] = d[k]; return o; }
    fallbackPrefs = {
      get: function (k) { return d[k]; },
      all: all,
      set: function (k, v) { d[k] = v; ls.slice().forEach(function (fn) { try { fn(k, v, all()); } catch (e) {} }); },
      on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
    };
    return fallbackPrefs;
  }
  // A pref value, coerced to the schema (the real store does this too; the fallback doesn't).
  function coerce(f, v) {
    if (f.type === 'number' || f.type === 'slider') {
      v = +v;
      if (!isFinite(v)) v = f.default;
      return Math.max(f.min, Math.min(f.max, v));
    }
    if (f.type === 'toggle') return typeof v === 'boolean' ? v : !!f.default;
    if (f.type === 'radio' || f.type === 'select') {
      for (var i = 0; i < f.options.length; i++) if (f.options[i].value === v) return v;
      return f.default;
    }
    return v == null ? f.default : v;
  }
  function pv(k) {
    var v;
    try { v = S && S.P ? S.P.get(k) : undefined; } catch (e) {}
    return coerce(FIELD[k], v);
  }
  function setPref(k, v) { if (S && S.P) { try { S.P.set(k, coerce(FIELD[k], v)); } catch (e) {} } }

  // ---- core ----------------------------------------------------------------------------
  var C = null;
  function loadCore() {
    if (window.__cadeSpeedRead) return Promise.resolve(window.__cadeSpeedRead);
    if (!window.__cadeSpeedReadP) {
      window.__cadeSpeedReadP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadeSpeedRead) res(window.__cadeSpeedRead); else { window.__cadeSpeedReadP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadeSpeedReadP = null; rej(new Error('Speed Reader failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeSpeedReadP;
  }

  // ---- wake lock -------------------------------------------------------------------------
  function wakeAcquire() {
    if (!S || S.wake || S.wakeAsk || !navigator.wakeLock || !navigator.wakeLock.request || document.visibilityState !== 'visible') return;
    var s = S;
    s.wakeAsk = true;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        s.wakeAsk = false;
        if (S !== s || !s.playing) { try { lock.release(); } catch (e) {} return; }
        s.wake = lock;
        lock.addEventListener('release', function () { if (s.wake === lock) s.wake = null; });
      }, function () { s.wakeAsk = false; });
    } catch (e) { s.wakeAsk = false; }
  }
  function wakeRelease(s) {
    if (s && s.wake) { var l = s.wake; s.wake = null; try { var r = l.release(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
  }

  // ---- markup --------------------------------------------------------------------------
  var I = function (d) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  };
  var ICON = {
    back: I('<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>'),
    fwd: I('<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>'),
    minus: I('<path d="M5 12h14"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    play: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/></svg>',
    paste: I('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>'),
    note: I('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    gear: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
  };
  function btn(act, title, inner, cls) {
    return '<button type="button" class="sr-b' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" title="' + title + '" aria-label="' + title + '">' + inner + '</button>';
  }
  function bodyHtml() {
    return '<div class="sr" tabindex="-1">' +
      '<div class="sr-stage" role="button" tabindex="0" aria-label="Play or pause. Press and hold to read while held.">' +
        '<div class="sr-ctx sr-above" aria-hidden="true"></div>' +
        '<div class="sr-focus">' +
          '<i class="sr-tick sr-tick-t" aria-hidden="true"></i><i class="sr-tick sr-tick-b" aria-hidden="true"></i>' +
          '<div class="sr-line" aria-live="off"><span class="sr-prev"></span><span class="sr-cur"></span><span class="sr-next"></span></div>' +
        '</div>' +
        '<div class="sr-ctx sr-below" aria-hidden="true"></div>' +
        '<div class="sr-hint"><span class="sr-h1">' + (coarse() ? 'Tap to play · hold to read' : 'Space or click to play · ←/→ sentence · ↑/↓ speed') +
          '</span><span class="sr-h2">The end · tap to read it again</span></div>' +
      '</div>' +
      '<div class="sr-paste" hidden>' +
        '<textarea class="sr-ta" placeholder="Paste or type the text to read…" aria-label="Text to read"></textarea>' +
        '<div class="sr-prow">' + btn('pasteCancel', 'Back to the note', 'Cancel', 'sr-tb') + btn('pasteRead', 'Read this text', 'Read this', 'sr-tb sr-pri') + '</div>' +
      '</div>' +
      '<input class="sr-range" type="range" min="0" max="0" step="1" value="0" aria-label="Position">' +
      '<div class="sr-meta"><span class="sr-src"></span><span class="sr-pct"></span><span class="sr-left"></span></div>' +
      '<div class="sr-ctrls">' +
      '<div class="sr-bar" role="toolbar" aria-label="Speed Reader controls">' +
        btn('back', 'Back a sentence (←)', ICON.back) +
        btn('slower', 'Slower (↓)', ICON.minus, 'sr-sm') +
        btn('play', 'Play (Space)', ICON.play, 'sr-play') +
        btn('faster', 'Faster (↑)', ICON.plus, 'sr-sm') +
        btn('fwd', 'Forward a sentence (→)', ICON.fwd) +
      '</div>' +
      '<div class="sr-bar2">' +
        '<span class="sr-wpm"></span>' +
        btn('chunk', 'Words at a time (1–5)', '1 word', 'sr-tb sr-chunk') +
        btn('paste', 'Read pasted text', ICON.paste, 'sr-tb sr-pastebtn') +
      '</div>' +
      '</div>' +
    '</div>';
  }

  // ---- state ---------------------------------------------------------------------------
  var S = null;

  function buildText(text, base, kind, caret) {
    var words = C.tokenize(text, base);
    S.kind = kind;
    S.words = words;
    S.starts = C.sentenceStarts(words);
    S.range.max = Math.max(0, words.length - 1);
    var wi = kind === 'note' && pv('start') === 'caret' ? C.startIndex(words, caret) : 0;
    rechunk(wi);
    S.startCi = S.ci;
    S.moved = false;
    S.ended = false;
    S.root.classList.remove('sr-ended');
    var label = kind === 'sel' ? 'Selection' : kind === 'paste' ? 'Pasted text' : 'Note';
    S.srcEl.textContent = label + ' · ' + words.length.toLocaleString() + ' word' + (words.length === 1 ? '' : 's');
    render();
  }
  function rechunk(wi) {
    S.chunks = C.chunk(S.words, pv('chunk'));
    retime();
    S.ci = S.chunks.length ? C.chunkOf(S.chunks, wi || 0) : 0;
    var n = pv('chunk');
    S.chunkBtn.textContent = n + (n === 1 ? ' word' : ' words');
    S.root.classList.toggle('sr-multi', n > 1);
  }
  function retime() {
    var t = C.timeline(S.words, S.chunks, pv('wpm'), pv('pause'));
    S.dur = t.dur; S.rest = t.rest;
    S.wpmEl.textContent = pv('wpm') + ' wpm';
  }
  function curWord() { var c = S.chunks[S.ci]; return c ? c.a : 0; }

  function joinWords(a, b) {
    var out = [];
    for (var i = Math.max(0, a); i < Math.min(S.words.length, b); i++) out.push(S.words[i].w);
    return out.join(' ');
  }

  // Draw the current chunk and line it up on the fixation point.
  function render() {
    if (!S) return;
    var c = S.chunks[S.ci];
    var size = pv('size'), ctx = pv('ctx'), dim = pv('dim') / 100, inline = pv('ctxPos') === 'inline';
    var multi = c && c.b - c.a > 1;
    S.root.style.setProperty('--sr-size', size + 'px');
    S.root.style.setProperty('--sr-dim', String(ctx ? dim : 0));
    S.root.classList.toggle('sr-ctx-off', !ctx || dim <= 0);
    S.root.classList.toggle('sr-ctx-lines', ctx && !inline);
    S.root.classList.toggle('sr-orp-off', !pv('orp'));
    S.root.classList.toggle('sr-centred', !!multi);
    S.root.classList.toggle('sr-empty', !c);
    if (!c) {
      S.prev.textContent = ''; S.next.textContent = '';
      S.cur.textContent = 'Nothing to read';
      S.above.textContent = ''; S.below.textContent = '';
      S.line.style.fontSize = '';
      S.line.style.transform = 'translate3d(' + Math.max(0, (S.focus.clientWidth - S.cur.offsetWidth) / 2) + 'px,-50%,0)';
      meta();
      return;
    }
    if (multi) S.cur.textContent = joinWords(c.a, c.b);
    else {
      var w = S.words[c.a].w, k = C.orpIndex(w);
      S.cur.innerHTML = esc(w.slice(0, k)) + '<b class="sr-orp">' + esc(w.charAt(k)) + '</b>' + esc(w.slice(k + 1));
    }
    var showInline = ctx && inline && dim > 0;
    S.prev.textContent = showInline ? joinWords(c.a - CTX_WORDS, c.a) + ' ' : '';
    S.next.textContent = showInline ? ' ' + joinWords(c.b, c.b + CTX_WORDS) : '';
    var showLines = ctx && !inline && dim > 0;
    S.above.textContent = showLines ? joinWords(c.a - CTX_WORDS * 2, c.a) : '';
    S.below.textContent = showLines ? joinWords(c.b, c.b + CTX_WORDS * 2) : '';
    place(size, multi);
    meta();
  }
  // Position the line: ORP letter on the fixation x (single words) or the
  // chunk centred; shrink it when it doesn't fit, then keep it on screen.
  function place(size, multi) {
    var W = S.focus.clientWidth, pad = 10, avail = Math.max(40, W - pad * 2);
    S.line.style.fontSize = size + 'px';
    var cw = S.cur.offsetWidth;
    if (cw > avail) {
      S.line.style.fontSize = Math.max(12, Math.floor(size * avail / cw)) + 'px';
      cw = S.cur.offsetWidth;
    }
    var curL = S.cur.offsetLeft, anchor, x;
    var orp = !multi && S.cur.querySelector('.sr-orp');
    if (orp) {
      anchor = Math.round(W * 0.38);
      x = anchor - (curL + orp.offsetLeft - S.cur.offsetLeft + orp.offsetWidth / 2);
    } else {
      x = W / 2 - (curL + cw / 2);
    }
    // Keep the chunk itself inside the stage.
    if (curL + x + cw > W - pad) x = W - pad - cw - curL;
    if (curL + x < pad) x = pad - curL;
    S.line.style.transform = 'translate3d(' + x.toFixed(1) + 'px,-50%,0)';
    S.focus.style.setProperty('--sr-fix', Math.round(W * 0.38) + 'px');
  }
  function meta() {
    if (!S) return;
    var n = S.words.length, wi = curWord();
    S.range.value = String(wi);
    S.range.style.setProperty('--sr-p', (n > 1 ? wi / (n - 1) * 100 : 0).toFixed(2) + '%');
    S.pctEl.textContent = n ? Math.round((S.chunks.length > 1 ? S.ci / (S.chunks.length - 1) : 1) * 100) + '%' : '';
    S.leftEl.textContent = n ? C.fmtTime(S.rest[S.ci] || 0) + ' left' : '';
  }

  // ---- playback ------------------------------------------------------------------------
  function play() {
    if (!S || S.playing || !S.chunks.length || !S.paste.hidden) return;
    if (S.ended) { S.ci = 0; S.ended = false; S.root.classList.remove('sr-ended'); }
    S.playing = true;
    S.due = now();
    S.root.classList.add('sr-playing');
    playUi();
    wakeAcquire();
    schedule();
  }
  function pause() {
    if (!S) return;
    clearTimeout(S.timer); S.timer = 0;
    if (!S.playing) return;
    S.playing = false;
    S.root.classList.remove('sr-playing');
    playUi();
    wakeRelease(S);
  }
  function toggle() { if (!S) return; if (S.playing) pause(); else play(); }
  // Show the current chunk for its time, then move on. The schedule is
  // absolute (S.due), so timer lateness doesn't add up.
  function schedule() {
    if (!S || !S.playing) return;
    render();
    var t = now();
    if (t - S.due > 250) S.due = t; // woke from a stall: don't rush to catch up
    S.due += S.dur[S.ci] || 100;
    clearTimeout(S.timer);
    S.timer = setTimeout(advance, Math.max(0, S.due - t));
  }
  function advance() {
    if (!S) return;
    S.timer = 0;
    if (S.ci >= S.chunks.length - 1) {
      S.ended = true; S.moved = true;
      S.root.classList.add('sr-ended');
      pause();
      return;
    }
    S.ci++;
    S.moved = true;
    schedule();
  }
  // Jump to word wi (keeps playing from there if playing).
  function seekWord(wi) {
    if (!S || !S.chunks.length) return;
    S.ci = C.chunkOf(S.chunks, Math.max(0, Math.min(S.words.length - 1, wi)));
    S.ended = false; S.moved = true;
    S.root.classList.remove('sr-ended');
    if (S.playing) { S.due = now(); schedule(); } else render();
  }
  function sentence(dir) {
    if (!S || !S.words.length) return;
    seekWord(C.sentenceTarget(S.starts, curWord(), dir, S.words.length));
  }
  function playUi() {
    var b = S.playBtn, on = S.playing;
    b.innerHTML = on ? ICON.pause : ICON.play;
    b.title = on ? 'Pause (Space)' : 'Play (Space)';
    b.setAttribute('aria-label', b.title);
  }
  function speed(d) { setPref('wpm', pv('wpm') + d); }

  // ---- prefs live ----------------------------------------------------------------------
  function onPref(k) {
    if (!S) return;
    if (k === 'chunk') { rechunk(curWord()); if (S.playing) { S.due = now(); schedule(); } else render(); }
    else if (k === 'wpm' || k === 'pause') { retime(); meta(); }
    else render();
  }

  // ---- paste ---------------------------------------------------------------------------
  function showPaste(on) {
    if (!S) return;
    pause();
    S.paste.hidden = !on;
    S.root.classList.toggle('sr-pasting', on);
    if (on) {
      S.ta.value = '';
      try { S.ta.focus({ preventScroll: true }); } catch (e) {}
      if (navigator.clipboard && navigator.clipboard.readText && !coarse()) {
        navigator.clipboard.readText().then(function (t) { if (S && !S.ta.value && t) S.ta.value = t; }, function () {});
      }
    } else {
      try { S.root.focus({ preventScroll: true }); } catch (e) {}
    }
  }
  function readPasted() {
    var t = S.ta.value;
    if (!/[\p{L}\p{N}]/u.test(t)) { toast('Paste some text to read first'); return; }
    S.paste.hidden = true;
    S.root.classList.remove('sr-pasting');
    buildText(t.slice(0, MAX_CHARS), 0, 'paste', null);
    S.pasteBtn.innerHTML = ICON.note;
    S.pasteBtn.title = 'Read the note again';
    S.pasteBtn.setAttribute('aria-label', 'Read the note again');
    S.pasteBtn.setAttribute('data-act', 'note');
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }
  function backToNote() {
    var src = pickSource();
    S.src = src;
    buildText(src.text, src.base, src.kind, src.caret);
    S.pasteBtn.innerHTML = ICON.paste;
    S.pasteBtn.title = 'Read pasted text';
    S.pasteBtn.setAttribute('aria-label', 'Read pasted text');
    S.pasteBtn.setAttribute('data-act', 'paste');
  }

  // ---- input ---------------------------------------------------------------------------
  function act(a) {
    switch (a) {
      case 'play': toggle(); break;
      case 'back': sentence(-1); break;
      case 'fwd': sentence(1); break;
      case 'slower': speed(-25); break;
      case 'faster': speed(25); break;
      case 'chunk': setPref('chunk', pv('chunk') % 5 + 1); break;
      case 'paste': showPaste(true); break;
      case 'note': backToNote(); break;
      case 'pasteCancel': showPaste(false); break;
      case 'pasteRead': readPasted(); break;
      case 'prefs': openPrefs(); break;
    }
  }
  function openPrefs() {
    pause();
    if (Cade.prefs && Cade.prefs.open) { try { Cade.prefs.open(ID); } catch (e) {} }
    else toast('Widget preferences come with the next app update', 'info', 2600);
  }
  function onClick(e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b || !S || !S.panel.contains(b)) return;
    if (e.detail > 0 && b.tagName === 'BUTTON') { try { b.blur(); S.root.focus({ preventScroll: true }); } catch (err) {} }
    act(b.getAttribute('data-act'));
  }
  function onKey(e) {
    if (!S) return;
    var t = e.target, k = e.key;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range'))) {
      if (k === 'Escape') { e.preventDefault(); showPaste(false); }
      else if (k === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); readPasted(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((k === 'Enter' || k === ' ') && t && t.tagName === 'BUTTON') return; // activates the button
    if (t && t.type === 'range' && /^Arrow|^Page|^Home$|^End$/.test(k)) return; // the scrubber's own keys
    var handled = true;
    switch (k) {
      case ' ': case 'k': case 'K': case 'MediaPlayPause': if (!e.repeat) toggle(); break;
      case 'Enter': if (!e.repeat && t === S.stage) toggle(); else handled = false; break;
      case 'ArrowLeft': if (e.shiftKey) seekWord(S.chunks[Math.max(0, S.ci - 1)].a); else sentence(-1); break;
      case 'ArrowRight': if (e.shiftKey) seekWord(S.chunks[Math.min(S.chunks.length - 1, S.ci + 1)].a); else sentence(1); break;
      case 'ArrowUp': speed(25); break;
      case 'ArrowDown': speed(-25); break;
      case 'Home': seekWord(0); break;
      case 'End': pause(); seekWord(S.words.length - 1); break;
      case '1': case '2': case '3': case '4': case '5': setPref('chunk', +k); break;
      case 'Escape': if (!S.paste.hidden) showPaste(false); else close(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  // Tap toggles; press-and-hold reads while held.
  function onDown(e) {
    if (!S || (e.pointerType === 'mouse' && e.button !== 0) || S.press) return;
    if (!S.paste.hidden) return;
    var s = S;
    s.press = { id: e.pointerId, was: s.playing, hold: false, x: e.clientX, y: e.clientY };
    try { s.stage.setPointerCapture(e.pointerId); } catch (err) {}
    s.holdT = setTimeout(function () {
      if (S !== s || !s.press) return;
      s.press.hold = true;
      if (!s.playing) { s.holding = true; s.root.classList.add('sr-holding'); play(); }
    }, 280);
  }
  function onUp(e) {
    if (!S || !S.press || S.press.id !== e.pointerId) return;
    var p = S.press;
    S.press = null;
    clearTimeout(S.holdT); S.holdT = 0;
    if (S.holding) { S.holding = false; S.root.classList.remove('sr-holding'); pause(); return; }
    if (e.type !== 'pointerup' || p.hold) return; // cancelled, or held while already playing
    if (p.was) pause(); else play();
  }
  function onScrubStart() { if (S && S.playing) { S.resume = true; pause(); } }
  function onScrub() { if (S) seekWord(+S.range.value); }
  function onScrubEnd() { if (S && S.resume) { S.resume = false; play(); } }
  function onVis() { if (S && document.visibilityState === 'hidden') pause(); }
  function onMin() { pause(); }
  var resizeT = 0;
  function onResize() {
    if (resizeT || !S) return;
    resizeT = requestAnimationFrame(function () { resizeT = 0; if (S) render(); });
  }
  function onEditorUpdate(u) {
    if (!S || !u || !u.docChanged || !S.changes0) return;
    try { S.changes = S.changes ? S.changes.compose(u.changes) : u.changes; } catch (e) { S.changes0 = false; }
  }

  // ---- open / close --------------------------------------------------------------------
  function pickSource() {
    try {
      var st = Cade.editor.state, sel = st.selection.main;
      if (!sel.empty) return { text: st.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_CHARS)), base: sel.from, kind: 'sel', caret: null };
      return { text: st.doc.sliceString(0, Math.min(st.doc.length, MAX_CHARS)), base: 0, kind: 'note', caret: sel.head };
    } catch (e) { return { text: '', base: 0, kind: 'note', caret: null }; }
  }

  // On close: put the caret at the start of the chunk you stopped on, if
  // that text is still where it was.
  function moveCaret(s) {
    if (s.kind === 'paste' || !s.moved || !s.words.length || !s.doc0) return;
    var w = s.words[s.chunks[s.ci] ? s.chunks[s.ci].a : 0];
    var ed = Cade.editor;
    if (!w || !ed) return;
    try {
      var from = w.from, to = w.to;
      if (s.changes) { from = s.changes.mapPos(from, 1); to = s.changes.mapPos(to, -1); }
      var doc = ed.state.doc;
      if (to > doc.length || doc.sliceString(from, to) !== s.doc0.sliceString(w.from, w.to)) return;
      ed.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      if (!coarse()) ed.focus();
    } catch (e) {}
  }

  function cleanup() {
    if (!S) return;
    var s = S;
    S = null;
    clearTimeout(s.timer); clearTimeout(s.holdT);
    if (resizeT) { cancelAnimationFrame(resizeT); resizeT = 0; }
    if (s.offPrefs) { try { s.offPrefs(); } catch (e) {} }
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    if (s.ro) s.ro.disconnect();
    try { Cade.offEditorUpdate(onEditorUpdate); } catch (e) {}
    wakeRelease(s);
    s.playing = false;
    var mc;
    try { mc = s.P.get('moveCaret'); } catch (e) {}
    if (coerce(FIELD.moveCaret, mc)) moveCaret(s);
  }
  function close() {
    var p = S && S.panel;
    cleanup();
    if (p) p.remove();
  }

  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (Cade.isMinimized(existing)) { Cade.restorePanel(existing); return; }
      close();
      if (existing.isConnected) existing.remove();
      return;
    }
    var src = pickSource();
    loadCore().then(function (core) {
      C = core;
      if (document.getElementById(PANEL_ID)) return;
      build(src);
    }, function (err) { toast(err && err.message || 'Speed Reader failed to load', 'error', 3000); });
  }

  function build(src) {
    var panel = Cade.mkPanel(PANEL_ID, '⚡ Speed Reader', bodyHtml());
    var q = function (sel) { return panel.querySelector(sel); };
    // ⚙ in the header, before the panel's own buttons.
    var head = q('.cade-panel-head');
    var gear = document.createElement('span');
    gear.className = 'sr-gear';
    gear.setAttribute('role', 'button'); gear.setAttribute('tabindex', '0');
    gear.setAttribute('data-act', 'prefs');
    gear.title = 'Preferences'; gear.setAttribute('aria-label', 'Speed Reader preferences');
    gear.innerHTML = ICON.gear;
    gear.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    gear.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openPrefs(); } });
    head.insertBefore(gear, q('.cade-panel-popbtn') || q('.cade-panel-minbtn'));

    S = {
      panel: panel, root: q('.sr'), stage: q('.sr-stage'), focus: q('.sr-focus'), line: q('.sr-line'),
      prev: q('.sr-prev'), cur: q('.sr-cur'), next: q('.sr-next'), above: q('.sr-above'), below: q('.sr-below'),
      range: q('.sr-range'), srcEl: q('.sr-src'), pctEl: q('.sr-pct'), leftEl: q('.sr-left'), wpmEl: q('.sr-wpm'),
      playBtn: q('[data-act="play"]'), chunkBtn: q('[data-act="chunk"]'), pasteBtn: q('.sr-pastebtn'),
      paste: q('.sr-paste'), ta: q('.sr-ta'),
      P: prefsOf(ID, FIELDS), offPrefs: null,
      words: [], chunks: [], dur: [], rest: [0], starts: [], ci: 0, startCi: 0,
      playing: false, timer: 0, due: 0, press: null, holdT: 0, holding: false, resume: false,
      wake: null, wakeAsk: false, kind: src.kind, moved: false, ended: false,
      doc0: null, changes: null, changes0: true, ro: null
    };
    try { S.doc0 = Cade.editor.state.doc; } catch (e) {}
    panel._onClose = cleanup;
    try { S.offPrefs = S.P.on(function (k) { onPref(k); }); } catch (e) {}

    panel.addEventListener('click', onClick);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('cade-panel-minimize', onMin);
    S.stage.addEventListener('pointerdown', onDown);
    S.stage.addEventListener('pointerup', onUp);
    S.stage.addEventListener('pointercancel', onUp);
    S.stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.range.addEventListener('pointerdown', onScrubStart);
    S.range.addEventListener('input', onScrub);
    S.range.addEventListener('change', onScrubEnd);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) { S.ro = new ResizeObserver(onResize); S.ro.observe(S.focus); }
    Cade.onEditorUpdate(onEditorUpdate);

    try { Cade.editor.contentDOM.blur(); } catch (e) {}
    S.src = src;
    buildText(src.text, src.base, src.kind, src.caret);
    playUi();
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
    if (!S.words.length) toast('Nothing to read here — write or select some text, or paste some', 'info', 2800);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S) render(); });
  }

  var W = {
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open, close: close,
    _prefs: function () { return S ? S.P : prefsOf(ID, FIELDS); },
    _state: function () { return S; },
    _fields: FIELDS
  };
  Cade.registerWidget(W);
})();
