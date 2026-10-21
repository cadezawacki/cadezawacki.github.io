/* Voice Note — record a short memo; the note gets a small plain-text block
 * (format: voice-core.js) that the voice-view plugin plays as a card with a
 * waveform. The audio itself goes into the encrypted, synced file store
 * (Cade.files.store), so it reaches the owner's other devices and is
 * garbage-collected once the block is deleted.
 *
 * One big record button. While recording: a live scrolling waveform (canvas,
 * from an AnalyserNode on the mic stream), the elapsed time, Pause / Resume
 * and Stop; at most 10 minutes (a warning at 9:30). MediaRecorder at 32 kbps,
 * AAC in .m4a where the browser can (Safari), else Opus in .webm. One rAF
 * loop draws, keeps the clock and samples the RMS envelope every 50 ms — the
 * envelope becomes the block's glyph waveform. After Stop: play the take
 * (tap / drag the waveform to seek), give it a title, then Insert into note
 * (at the caret; after the current ``` block when the caret is inside one;
 * the panel tucks away on a phone) / Record again / Discard.
 * "In this note" lists the note's voice notes: ▶ plays one, a tap jumps to it.
 *
 * Nothing runs until the panel opens. The mic (every track), the
 * AudioContext, the rAF loop, timers and the wake lock are released on stop,
 * on close and when the mic goes away; the panel minimised keeps recording
 * (its chip shows the time). Hidden while recording, it records on as long as
 * the browser keeps the stream (iOS ends it → the take is kept up to there). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('voice.css');
  var CORE_URL = Cade.asset ? Cade.asset('voice-core.js') : './txt/widgets/voice/voice-core.js';
  var PANEL_ID = 'voice-panel';

  var META = {
    name: 'Voice Note',
    description: 'Record a voice memo into your note — a player with a waveform; the audio syncs encrypted to your other devices',
    icon: '🎙',
    tags: 'voice,voice note,voice memo,memo,record,recording,recorder,audio,microphone,mic,dictaphone,speech,sound,waveform,podcast,listen'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2000); } catch (e) {} }
  function isPhone() { try { return window.matchMedia('(max-width: 560px)').matches; } catch (e) { return false; } }
  function dpr() { return Math.min(3, window.devicePixelRatio || 1); }
  function now() { return performance.now(); }
  function noop() {}

  function loadCore() {
    if (window.__cadeVoiceCore) return Promise.resolve(window.__cadeVoiceCore);
    if (!window.__cadeVoiceCoreP) {
      window.__cadeVoiceCoreP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadeVoiceCore) res(window.__cadeVoiceCore); else { window.__cadeVoiceCoreP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadeVoiceCoreP = null; rej(new Error('Voice Note failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeVoiceCoreP;
  }

  var P = null, el = {}, VC = null, R = null, take = null, raf = 0, listTimer = 0, wake = null, busy = false, tab = 'rec';
  var colors = null;

  function bodyHtml() {
    return '<div class="vn">' +
      '<div class="vn-tabs" role="tablist">' +
        '<button type="button" class="vn-tab on" data-tab="rec" role="tab" aria-selected="true">Record</button>' +
        '<button type="button" class="vn-tab" data-tab="list" role="tab" aria-selected="false">In this note <span class="vn-cnt"></span></button>' +
      '</div>' +
      '<div class="vn-rec" data-state="idle">' +
        '<div class="vn-idle">' +
          '<button type="button" class="vn-big" data-act="record" aria-label="Start recording" title="Start recording"><span class="vn-big-dot"></span></button>' +
          '<div class="vn-hint"><b>Tap to record</b><span>up to 10 minutes · kept in this note</span></div>' +
          '<div class="vn-wait">Waiting for the microphone…</div>' +
          '<div class="vn-err" role="alert" hidden></div>' +
        '</div>' +
        '<div class="vn-live">' +
          '<div class="vn-scope"><canvas></canvas></div>' +
          '<div class="vn-clock"><span class="vn-rdot" aria-hidden="true"></span><span class="vn-el" aria-live="off">0:00</span><span class="vn-lim">/ 10:00</span></div>' +
          '<div class="vn-row2">' +
            '<button type="button" class="vn-btn vn-pause" data-act="pause">❚❚ Pause</button>' +
            '<button type="button" class="vn-btn vn-stop" data-act="stop">■ Stop</button>' +
          '</div>' +
        '</div>' +
        '<div class="vn-review">' +
          '<div class="vn-prev">' +
            '<button type="button" class="vn-pp" data-act="pplay" aria-label="Play the take" title="Play"><span class="vn-pp-i"></span></button>' +
            '<div class="vn-pmid"><div class="vn-pwave" title="Tap or drag to seek"><canvas></canvas></div><span class="vn-ptime">0:00 / 0:00</span></div>' +
          '</div>' +
          '<label class="vn-tl"><span>Title</span><input type="text" class="vn-title" maxlength="80" placeholder="Optional — what is it about?" autocomplete="off" enterkeyhint="done"></label>' +
          '<div class="vn-acts">' +
            '<button type="button" class="vn-btn vn-go" data-act="insert">↧ Insert into note</button>' +
            '<button type="button" class="vn-btn" data-act="again">Record again</button>' +
            '<button type="button" class="vn-btn" data-act="discard">Discard</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="vn-list" hidden></div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }
  function setState(s) { if (el.rec) el.rec.setAttribute('data-state', s); }
  function themeColors() {
    var th = document.documentElement.getAttribute('data-theme') || '';
    if (colors && colors.th === th) return colors;
    var cs = getComputedStyle(P);
    colors = { th: th,
      accent: (cs.getPropertyValue('--accent') || '').trim() || '#0f9598',
      faint: (cs.getPropertyValue('--text-faint') || '').trim() || '#a8a29e'
    };
    return colors;
  }
  function fit(cv) {
    var r = dpr(), w = Math.round(cv.clientWidth * r), h = Math.round(cv.clientHeight * r);
    if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    return w && h;
  }

  // ---- wake lock (screen stays on while recording) ----
  function wakeAcquire() {
    if (wake || !R || !R.rec || !navigator.wakeLock || !navigator.wakeLock.request || document.visibilityState !== 'visible') return;
    var s = R;
    try {
      wake = 'pending';
      navigator.wakeLock.request('screen').then(function (lock) {
        if (R !== s || !P) { wake = null; try { lock.release(); } catch (e) {} return; }
        wake = lock;
        lock.addEventListener('release', function () { if (wake === lock) wake = null; });
      }, function () { wake = null; });
    } catch (e) { wake = null; }
  }
  function wakeRelease() {
    var l = wake;
    wake = null;
    if (l && l !== 'pending') { try { var r = l.release(); if (r && r.catch) r.catch(noop); } catch (e) {} }
  }

  // ---- recording ----
  function micError(err) {
    var n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError')
      return 'Microphone access is blocked. Allow it for this site (Safari: aA › Website Settings › Microphone; Chrome: the icon left of the address), then try again.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'No microphone found.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'The microphone is busy in another app — close it and try again.';
    return 'Couldn’t start the microphone' + (n ? ' (' + n + ')' : '') + '.';
  }
  function showErr(msg) {
    if (!el.err) return;
    el.err.textContent = msg || '';
    el.err.hidden = !msg;
  }
  function elapsed(s) { return s.acc + (s.paused || !s.t0 ? 0 : now() - s.t0); }
  function startRec() {
    if (!P || R || busy) return;
    showErr('');
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { showErr(window.isSecureContext === false ? 'Recording needs a secure (https) page.' : 'This browser can’t record audio.'); return; }
    if (typeof window.MediaRecorder !== 'function') { showErr('This browser can’t record audio (no MediaRecorder).'); return; }
    dropTake();
    try { window.dispatchEvent(new CustomEvent('cade-voice-play', { detail: { src: 'rec' } })); } catch (e) {}   // hush any player
    // The AudioContext is made inside the tap: iOS keeps one made later suspended.
    var AC = window.AudioContext || window.webkitAudioContext, ctx = null;
    try { ctx = AC ? new AC() : null; } catch (e) { ctx = null; }
    var s = R = { ctx: ctx, env: [], chunks: [], acc: 0, t0: 0, paused: false, at: new Date(), warned: false, discard: false, lastSec: -1 };
    el.rec.classList.remove('vn-warn');
    el.time.textContent = '0:00';
    setState('starting');
    var gum;
    try { gum = md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch (e) { gum = Promise.reject(e); }
    gum.then(function (stream) {
      if (R !== s || !P) { stopTracks(stream); return null; }
      s.stream = stream;                      // held by the session from here: release() stops it
      return loadCore().then(function (c) { VC = c; return stream; }, function (e) { e.__core = true; throw e; });
    }).then(function (stream) {
      if (!stream || R !== s || !P) return;
      var mime = VC.pickMime(function (t) { return !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(t); }), rec;
      try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }); }
      catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { release(s); R = null; setState('idle'); showErr('This browser can’t record audio.'); return; } }
      s.rec = rec; s.mime = mime;
      rec.ondataavailable = function (e) { if (e.data && e.data.size) s.chunks.push(e.data); };
      rec.onstop = function () { finish(s); };
      rec.onerror = function () { if (R === s) { toast('The recording failed', 'error', 2600); stopRec(); } };
      if (ctx) {
        try {
          var src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(), sink = ctx.createGain();
          an.fftSize = 2048; sink.gain.value = 0;
          src.connect(an); an.connect(sink); sink.connect(ctx.destination);   // WebKit only runs a graph that reaches the output
          s.an = an; s.buf = an.getFloatTimeDomainData ? new Float32Array(an.fftSize) : new Uint8Array(an.fftSize);
          if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(noop);
        } catch (e) { s.an = null; }
      }
      s.onEnded = function () { if (R === s && s.rec && s.rec.state !== 'inactive') { toast('The microphone stopped — the take is kept up to here', 'info', 2800); stopRec(); } };
      stream.getAudioTracks().forEach(function (t) { t.addEventListener('ended', s.onEnded); });
      rec.start(1000);
      s.t0 = now();
      armMax(s);
      setState('rec');
      paintPause();
      wakeAcquire();
      loop();
    }).catch(function (err) {
      if (R !== s) return;
      release(s);
      R = null;
      setState('idle');
      showErr(err && err.__core ? err.message : micError(err));
    });
  }
  function stopTracks(stream) { try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {} }
  // Free everything the session holds (the recorder itself is stopped by the caller).
  function release(s) {
    if (!s) return;
    clearTimeout(s.maxT); s.maxT = 0;
    if (s.bgT) { clearInterval(s.bgT); s.bgT = 0; }
    if (s.stream) {
      s.stream.getAudioTracks().forEach(function (t) { try { t.removeEventListener('ended', s.onEnded); } catch (e) {} });
      stopTracks(s.stream);
      s.stream = null;
    }
    if (s.ctx) { try { var c = s.ctx.close(); if (c && c.catch) c.catch(noop); } catch (e) {} s.ctx = null; }
    s.an = null; s.buf = null;
    wakeRelease();
  }
  function armMax(s) {
    clearTimeout(s.maxT);
    var left = VC.MAX_SEC * 1000 - elapsed(s);
    s.maxT = setTimeout(function () { if (R === s) { toast('Stopped at the 10-minute limit', 'info', 2600); stopRec(); } }, Math.max(0, left));
  }
  function pauseRec() {
    var s = R;
    if (!s || !s.rec || s.stopping) return;
    if (!s.paused) {
      try { s.rec.pause(); } catch (e) { return; }
      s.acc = elapsed(s); s.paused = true; clearTimeout(s.maxT);
      setState('paused');
    } else {
      try { s.rec.resume(); } catch (e) { return; }
      s.paused = false; s.t0 = now(); armMax(s);
      setState('rec');
      loop();
    }
    paintPause();
    drawScope();
  }
  function paintPause() { if (el.pause) el.pause.textContent = R && R.paused ? '● Resume' : '❚❚ Pause'; }
  function stopRec() {
    var s = R;
    if (!s || !s.rec || s.stopping) return;
    s.acc = elapsed(s); s.paused = true; s.stopping = true;
    clearTimeout(s.maxT);
    try { if (s.rec.state !== 'inactive') s.rec.stop(); else finish(s); } catch (e) { finish(s); }
  }
  // The recorder has handed over its last chunk: keep the take, free the mic.
  function finish(s) {
    if (s.finished) return;
    s.finished = true;
    release(s);
    if (R === s) R = null;
    if (s.discard || !P) return;
    var dur = s.acc / 1000, type = (s.rec && s.rec.mimeType) || s.mime || (s.chunks[0] && s.chunks[0].type) || 'audio/webm';
    var blob = new Blob(s.chunks, { type: type });
    s.chunks = [];
    if (dur < 1 || !blob.size) { setState('idle'); toast('Too short — nothing kept', 'info', 1800); return; }
    take = { blob: blob, mime: type, dur: dur, levels: VC.waveFor(s.env, dur), at: s.at, url: null, audio: null, pos: 0 };
    el.title.value = '';
    setState('review');
    paintPreview();
    if (!isPhone()) { try { el.title.focus({ preventScroll: true }); } catch (e) {} }
  }
  // Close / hidden for good: stop and throw the take away.
  function abortRec() {
    var s = R;
    if (!s) return;
    s.discard = true;
    R = null;
    try { if (s.rec && s.rec.state !== 'inactive') s.rec.stop(); } catch (e) {}
    s.finished = true;
    release(s);
  }

  // ---- the one animation loop: clock, envelope, live waveform, preview progress ----
  function loop() { if (!raf && P) raf = requestAnimationFrame(tick); }
  function tick() {
    raf = 0;
    if (!P) return;
    var s = R, again = false;
    if (s && s.rec && !s.stopping) {
      var ms = elapsed(s);
      if (!s.paused) {
        sample(s, ms);
        if (!s.warned && ms >= VC.WARN_SEC * 1000) { s.warned = true; el.rec.classList.add('vn-warn'); toast('30 seconds left — recording stops at 10:00', 'info', 3000); }
        again = true;
      }
      var sec = Math.floor(ms / 1000);
      if (sec !== s.lastSec) {
        s.lastSec = sec;
        el.time.textContent = VC.fmtDuration(sec, true);
        if (Cade.isMinimized(P) && P.__dockChip) P.__dockChip.textContent = chipLabel();
      }
      if (!Cade.isMinimized(P)) drawScope();
    }
    if (take && take.audio && !take.audio.paused) { take.pos = take.audio.currentTime; paintPreview(); again = true; }
    if (again) raf = requestAnimationFrame(tick);
  }
  // The mic's loudness now → the envelope (one value per 50 ms of recording).
  function sample(s, ms) {
    if (!s.an || s.paused || s.stopping) return;
    var v;
    if (s.buf instanceof Float32Array) { s.an.getFloatTimeDomainData(s.buf); v = VC.rms(s.buf); }
    else { s.an.getByteTimeDomainData(s.buf); var sq = 0; for (var i = 0; i < s.buf.length; i++) { var x = (s.buf[i] - 128) / 128; sq += x * x; } v = Math.sqrt(sq / s.buf.length); }
    VC.envPush(s.env, ms == null ? elapsed(s) : ms, v);
  }
  // Hidden while recording (no frames): a slow timer keeps the waveform honest.
  function bgSampling(on) {
    var s = R;
    if (s && s.bgT) { clearInterval(s.bgT); s.bgT = 0; }
    if (on && s && s.rec && !s.stopping) s.bgT = setInterval(function () { if (R === s) sample(s); }, 250);
  }
  // Newest at the right, one bar per 50 ms, scrolling smoothly between samples.
  function drawScope() {
    var cv = el.scope;
    if (!cv || !R || !fit(cv)) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height, r = dpr(), env = R.env, c = themeColors();
    var step = 4 * r, bw = 2.5 * r, n = Math.ceil(w / step) + 1, ms = elapsed(R), off = R.paused ? 0 : (ms % VC.ENV_MS) / VC.ENV_MS * step;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = R.paused ? c.faint : c.accent;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var k = env.length - 1 - i;
      if (k < 0) break;
      var a = Math.min(1, Math.sqrt((env[k] || 0) * 6)), bh = Math.max(2 * r, a * h * 0.92), x = w - (i + 1) * step - off + (step - bw);
      if (x + bw < 0) break;
      if (ctx.roundRect) ctx.roundRect(x, (h - bh) / 2, bw, bh, bw / 2); else ctx.rect(x, (h - bh) / 2, bw, bh);
    }
    ctx.fill();
    // the centre line where nothing has been heard yet
    ctx.fillStyle = c.faint;
    var lineW = Math.max(0, w - Math.min(env.length, n) * step - off);
    if (lineW > 0) ctx.fillRect(0, (h - r) / 2, lineW, r);
  }
  function chipLabel() { return R && R.rec ? (R.paused ? '❚❚ ' : '● ') + VC.fmtDuration(elapsed(R) / 1000, true) : '🎙 Voice Note'; }

  // ---- the take: preview player ----
  function previewAudio() {
    if (!take) return null;
    if (take.audio) return take.audio;
    var a = document.createElement('audio');
    take.url = URL.createObjectURL(take.blob);
    a.preload = 'auto';
    a.onplay = function () { el.review.classList.add('vn-playing'); loop(); };
    a.onpause = function () { if (!take) return; take.pos = a.currentTime; el.review.classList.remove('vn-playing'); paintPreview(); };
    a.onended = function () { if (!take) return; take.pos = 0; try { a.currentTime = 0; } catch (e) {} el.review.classList.remove('vn-playing'); paintPreview(); };
    a.onerror = function () { if (take) { el.review.classList.remove('vn-playing'); toast('This browser can’t play the take back — it is still fine to insert', 'info', 3000); } };
    a.src = take.url;
    take.audio = a;
    return a;
  }
  function previewToggle() {
    var a = previewAudio();
    if (!a) return;
    if (!a.paused) { a.pause(); return; }
    stopList();
    try { window.dispatchEvent(new CustomEvent('cade-voice-play', { detail: { src: 'rec' } })); } catch (e) {}
    if (take.pos > 0 && Math.abs(a.currentTime - take.pos) > 0.05) { try { a.currentTime = take.pos; } catch (e) {} }
    var pr;
    try { pr = a.play(); } catch (e) { pr = null; }
    if (pr && pr.catch) pr.catch(noop);
  }
  function previewDur() { var d = take && take.audio && take.audio.duration; return d > 0 && isFinite(d) ? d : take ? take.dur : 0; }
  function paintPreview() {
    if (!take || !el.pwave) return;
    var cv = el.pwave, d = previewDur(), prog = d > 0 ? Math.min(1, take.pos / d) : 0;
    var t = VC.fmtDuration(take.pos, true) + ' / ' + VC.fmtDuration(take.dur);   // the length the block will say
    if (el.ptime.textContent !== t) el.ptime.textContent = t;
    if (!fit(cv)) return;
    var px = Math.round(prog * cv.width), c = themeColors();
    if (take.px === px && take.pw === cv.width && take.pc === c) return;
    take.px = px; take.pw = cv.width; take.pc = c;
    VC.drawWave(cv.getContext('2d'), take.levels, { w: cv.width, h: cv.height, dpr: dpr(), progress: prog, played: c.accent, rest: c.faint });
  }
  function previewSeek(x) {
    if (!take) return;
    var r = el.pwave.getBoundingClientRect();
    if (!r.width) return;
    var d = previewDur();
    take.pos = Math.max(0, Math.min(1, (x - r.left) / r.width)) * d;
    if (take.audio) { try { take.audio.currentTime = Math.min(take.pos, Math.max(0, d - 0.05)); } catch (e) {} }
    paintPreview();
  }
  function dropTake() {
    var t = take;
    take = null;
    if (!t) return;
    if (t.audio) {
      var a = t.audio;
      a.onplay = a.onpause = a.onended = a.onerror = null;
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
    }
    if (t.url) { try { URL.revokeObjectURL(t.url); } catch (e) {} }
    if (el.review) el.review.classList.remove('vn-playing');
  }

  // ---- insert ----
  function insert() {
    if (!take || busy) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    if (!Cade.files || !Cade.files.store) { toast('This version of the app can’t keep files', 'error', 2600); return; }
    var t = take, name = VC.fileName(t.at, t.mime), title = el.title.value, file;
    try { file = new File([t.blob], name, { type: t.mime }); } catch (e) { file = t.blob; }
    busy = true;
    el.go.disabled = true; el.go.textContent = 'Saving…';
    Promise.resolve().then(function () { return Cade.files.store(file, name); }).then(function (r) {
      busy = false;
      if (el.go) { el.go.disabled = false; el.go.textContent = '↧ Insert into note'; }
      var e2 = Cade.editor;
      if (!e2 || e2.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
      var text = VC.formatBlock({ dur: t.dur, title: title, levels: t.levels, token: r.token });
      var st = e2.state, sel = st.selection.main, end = fenceEndAt(st.doc, sel.from);
      if (end >= 0) {
        // the caret is inside a ``` block: a fence inside a fence would break both — go after it
        var ins2 = '\n' + text + '\n';
        e2.dispatch({ changes: { from: end, insert: ins2 }, selection: { anchor: end + ins2.length }, userEvent: 'input.paste', scrollIntoView: true });
      } else {
        var before = sel.from > 0 ? st.doc.sliceString(sel.from - 1, sel.from) : '\n';
        e2.dispatch(e2.state.replaceSelection((before === '\n' ? '' : '\n') + text + '\n'), { userEvent: 'input.paste', scrollIntoView: true });
      }
      toast('Voice note inserted', 'success', 1400);
      if (take === t) { dropTake(); setState('idle'); }
      if (P && isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
    }, function (e) {
      busy = false;
      if (el.go) { el.go.disabled = false; el.go.textContent = '↧ Insert into note'; }
      toast((e && e.message) || 'Couldn’t keep the recording', 'error', 3600);
    });
  }
  // End of the ``` block holding pos (the editor's rule: a line starting with
  // ``` opens or closes one), or -1 when pos is outside every block.
  function fenceEndAt(doc, pos) {
    var open = -1;
    for (var it = doc.iterLines(), from = 0; !it.next().done;) {
      var t = it.value, lf = from;
      from += t.length + 1;
      if (open < 0 && lf > pos) return -1;          // past the caret outside any block
      if (t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0) {
        if (open < 0) open = lf;
        else { if (pos <= lf + t.length) return lf + t.length; open = -1; }
      }
    }
    return open >= 0 && pos >= open ? doc.length : -1;
  }

  // ---- "In this note" ----
  var LA = null; // the list's player: { fh, audio, url, btn }
  var fetches = new Map();
  function fetchFile(fh) {
    var c = fetches.get(fh);
    if (c) return c;
    c = { done: false, r: null, err: null, p: null };
    c.p = Promise.resolve(fh).then(function (h) { return Cade.files.get(h); }).then(function (r) {
      c.done = true; c.r = r || null; if (!r) fetches.delete(fh); return c.r;
    }, function (e) { c.done = true; c.err = e || new Error('decode'); fetches.delete(fh); throw c.err; });
    c.p.catch(noop);
    fetches.set(fh, c);
    if (fetches.size > 3) fetches.delete(fetches.keys().next().value);
    return c;
  }
  function stopList() {
    var l = LA;
    LA = null;
    if (!l) return;
    if (l.audio) { l.audio.onpause = l.audio.onended = l.audio.onerror = l.audio.onplay = null; try { l.audio.pause(); l.audio.removeAttribute('src'); l.audio.load(); } catch (e) {} }
    if (l.url) { try { URL.revokeObjectURL(l.url); } catch (e) {} }
    if (l.btn) { l.btn.classList.remove('on', 'busy'); l.btn.setAttribute('aria-label', 'Play'); }
  }
  function listPlay(btn) {
    var fh = btn.getAttribute('data-lplay');
    if (!fh || !Cade.files || !Cade.files.get) return;
    if (LA && LA.fh === fh && LA.audio) {
      if (LA.audio.paused) { var p0 = LA.audio.play(); if (p0 && p0.catch) p0.catch(noop); } else LA.audio.pause();
      return;
    }
    stopList();
    if (take && take.audio) take.audio.pause();
    var l = LA = { fh: fh, btn: btn, audio: null, url: null }, c = fetchFile(fh);
    function go(inTap) {
      if (LA !== l) return;
      l.btn.classList.remove('busy');
      if (c.err) { toast('The recording’s data is damaged', 'error', 2600); stopList(); return; }
      if (!c.r) { toast('Still syncing to this device — try again in a moment', 'info', 2600); stopList(); return; }
      var a = document.createElement('audio');
      l.url = URL.createObjectURL(c.r.blob);
      // l.btn: the list may have been redrawn since the tap
      a.onplay = function () { l.btn.classList.add('on'); l.btn.setAttribute('aria-label', 'Pause'); };
      a.onpause = function () { l.btn.classList.remove('on'); l.btn.setAttribute('aria-label', 'Play'); };
      a.onended = function () { if (LA === l) stopList(); };
      a.onerror = function () { if (LA === l) { toast('This browser can’t play this recording — download it from the card', 'info', 3000); stopList(); } };
      a.src = l.url;
      l.audio = a;
      try { window.dispatchEvent(new CustomEvent('cade-voice-play', { detail: { src: 'list' } })); } catch (e) {}
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function (e) { if (LA === l && e && e.name === 'NotAllowedError' && !inTap) toast('Ready — tap ▶ again', 'info', 2000); });
    }
    if (c.done) { go(true); return; }
    btn.classList.add('busy');
    c.p.then(function () { go(false); }, function () { go(false); });
  }
  function onOtherPlay(e) {
    var src = e.detail && e.detail.src;
    if (src !== 'list') stopList();
    if (src !== 'rec' && take && take.audio && !take.audio.paused) take.audio.pause();
  }
  function noteBlocks() {
    var ed = Cade.editor;
    if (!ed || !VC) return [];
    return VC.findBlocks(ed.state.doc.toString());
  }
  function countBadge(n) { var c = q('.vn-cnt'); if (c) c.textContent = n ? '(' + n + ')' : ''; }
  function showTab(t) {
    tab = t;
    var list = t === 'list';
    P.querySelectorAll('.vn-tab').forEach(function (b) { var on = b.getAttribute('data-tab') === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    el.rec.hidden = list;
    el.list.hidden = !list;
    if (list) loadCore().then(function (c) { VC = c; renderList(); }, function (e) { toast(e.message, 'error'); });
    else { colors = null; requestAnimationFrame(function () { if (take) { take.px = -1; paintPreview(); } }); }
  }
  function renderList() {
    if (!P || el.list.hidden) return;
    var bl = noteBlocks();
    countBadge(bl.length);
    if (!bl.length) { stopList(); el.list.innerHTML = '<div class="vn-none">No voice notes in this note yet — record one and insert it.</div>'; return; }
    var keep = LA && LA.fh, html = '';
    bl.forEach(function (b) {
      var v = b.voice || {}, when = VC.dateOf(v.name), ok = !!v.hash;
      html += '<div class="vn-li">' +
        '<button type="button" class="vn-lp" ' + (ok ? 'data-lplay="' + esc(v.hash) + '"' : 'disabled') + ' aria-label="Play" title="Play"><span class="vn-pp-i"></span></button>' +
        '<button type="button" class="vn-item" data-line="' + b.line + '" title="Show it in the note">' +
          '<b>' + esc(v.title || 'Voice note') + '</b>' +
          '<span class="vn-glyphs" aria-hidden="true">' + esc(v.wave || '') + '</span>' +
          '<small>' + esc(VC.fmtDuration(v.dur || 0)) + (when ? ' · ' + esc(fmtWhen(when)) : '') + ' · line ' + b.line + (ok ? '' : ' · no audio') + '</small>' +
        '</button></div>';
    });
    el.list.innerHTML = html;
    // a memo still playing keeps its button
    if (keep) {
      var nb = el.list.querySelector('[data-lplay="' + keep + '"]');
      if (nb) { LA.btn = nb; if (LA.audio && !LA.audio.paused) nb.classList.add('on'); } else stopList();
    }
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtWhen(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getDate() + ' ' + MON[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') + ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function jumpTo(line) {
    var ed = Cade.editor, CM = Cade.CM;
    if (!ed) return;
    var n = Math.min(line, ed.state.doc.lines), pos = ed.state.doc.line(n).from;
    ed.dispatch({ effects: CM.EditorView.scrollIntoView(pos, { y: 'start', yMargin: 70 }) });
    if (isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
  }
  function onEditorUpdate(u) {
    if (!P || !u.docChanged) return;
    clearTimeout(listTimer);
    listTimer = setTimeout(function () {
      if (!P || !VC) return;
      if (!el.list.hidden) renderList();
      else countBadge(noteBlocks().length);
    }, 500);
  }

  // ---- events ----
  var drag = null;
  function onClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !P.contains(b)) return;
    if (b.hasAttribute('data-tab')) { showTab(b.getAttribute('data-tab')); return; }
    if (b.hasAttribute('data-line')) { jumpTo(+b.getAttribute('data-line')); return; }
    if (b.hasAttribute('data-lplay')) { listPlay(b); return; }
    var a = b.getAttribute('data-act');
    if (a === 'record') { if (R) { abortRec(); setState('idle'); } else startRec(); }
    else if (a === 'pause') pauseRec();
    else if (a === 'stop') stopRec();
    else if (a === 'pplay') previewToggle();
    else if (a === 'insert') insert();
    else if (a === 'again') { if (!busy) { dropTake(); startRec(); } }
    else if (a === 'discard') { if (!busy) { dropTake(); setState('idle'); } }
  }
  function onPointerDown(e) {
    var t = e.target;
    // prefetch a memo's bytes on press, so the click can play it inside the tap
    var lp = t.closest && t.closest('[data-lplay]');
    if (lp && Cade.files && Cade.files.get && !(LA && LA.fh === lp.getAttribute('data-lplay'))) fetchFile(lp.getAttribute('data-lplay'));
    if (!take || !el.pwave || !el.pwave.parentNode.contains(t) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { id: e.pointerId, x0: e.clientX, on: e.pointerType === 'mouse' };
    if (drag.on) { try { el.pwave.parentNode.setPointerCapture(e.pointerId); } catch (x) {} previewSeek(e.clientX); }
  }
  function onPointerMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.on && Math.abs(e.clientX - drag.x0) > 6) { drag.on = true; try { el.pwave.parentNode.setPointerCapture(e.pointerId); } catch (x) {} }
    if (drag.on) previewSeek(e.clientX);
  }
  function onPointerUp(e) {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    try { el.pwave.parentNode.releasePointerCapture(e.pointerId); } catch (x) {}
    previewSeek(e.clientX);
  }
  function onPointerCancel() { drag = null; }
  function onKey(e) {
    if (e.key === 'Escape' && !(e.target === el.title && el.title.value)) {
      e.preventDefault();
      if (R || take) { if (Cade.minimizePanel) Cade.minimizePanel(P); } else close();   // Esc never throws a take away
      return;
    }
    if (e.key === 'Enter' && e.target === el.title) { e.preventDefault(); insert(); }
  }
  function onVis() {
    if (!P) return;
    if (document.visibilityState === 'visible') { bgSampling(false); if (R && R.rec && !R.stopping) { wakeAcquire(); loop(); } }
    else { wakeRelease(); bgSampling(true); }   // recording goes on while the browser keeps the stream
  }
  function onMin() {
    if (R && R.rec && P.__dockChip) P.__dockChip.textContent = chipLabel();
  }
  function onRestore() { colors = null; loop(); if (take) { take.px = -1; paintPreview(); } }
  var resizeT = 0;
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { if (P && take) { take.px = -1; paintPreview(); } }, 150); }

  function cleanup() {
    var hadWork = !!(R || (take && !busy));   // a take being saved still lands in the note
    abortRec();
    dropTake();
    stopList();
    wakeRelease();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(listTimer); clearTimeout(resizeT);
    try { Cade.offEditorUpdate(onEditorUpdate); } catch (e) {}
    window.removeEventListener('resize', onResize);
    window.removeEventListener('cade-voice-play', onOtherPlay);
    document.removeEventListener('visibilitychange', onVis);
    fetches.clear();
    if (el.scope) el.scope.width = el.scope.height = 0;
    if (el.pwave) el.pwave.width = el.pwave.height = 0;
    P = null; el = {}; busy = false; drag = null; colors = null; tab = 'rec';
    if (hadWork) toast('Voice note discarded', 'info', 1600);
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
    try { if (!isPhone()) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) { if (!(R || take)) close(); return; }   // never throw a take away by toggling
    P = Cade.mkPanel(PANEL_ID, '🎙 Voice Note', bodyHtml());
    P._onClose = cleanup;
    P.__cadeMinTo = 'footer';
    P.__cadeMinLabel = chipLabel;
    el = {
      rec: q('.vn-rec'), list: q('.vn-list'), err: q('.vn-err'), scope: q('.vn-scope canvas'), time: q('.vn-el'),
      pause: q('.vn-pause'), review: q('.vn-review'), pwave: q('.vn-pwave canvas'), ptime: q('.vn-ptime'), title: q('.vn-title'), go: q('.vn-go')
    };
    P.addEventListener('click', onClick);
    P.addEventListener('keydown', onKey);
    P.addEventListener('pointerdown', onPointerDown);
    P.addEventListener('pointermove', onPointerMove);
    P.addEventListener('pointerup', onPointerUp);
    P.addEventListener('pointercancel', onPointerCancel);
    P.addEventListener('cade-panel-minimize', onMin);
    P.addEventListener('cade-panel-restore', onRestore);
    window.addEventListener('resize', onResize);
    window.addEventListener('cade-voice-play', onOtherPlay);
    document.addEventListener('visibilitychange', onVis);
    Cade.onEditorUpdate(onEditorUpdate);
    loadCore().then(function (c) { VC = c; if (P) countBadge(noteBlocks().length); }, function (e) { if (P) showErr(e.message); });
  }

  Cade.registerWidget({ name: META.name, description: META.description, icon: META.icon, tags: META.tags, open: open, close: close });
})();
