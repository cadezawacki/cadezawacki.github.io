/* Beam — QR stream: move a file or a note between two screens with no
 * network at all, as an animated QR code that the other device's camera reads.
 *
 * beam.js loads this file when its "QR stream" tab first opens and calls
 *   window.__cadeBeamQR.mount(el, { mode: 'send'|'receive', file, onReceived })
 *     → { destroy(), send(file) }          (file = { blob, name, mime })
 * The mount is self-contained: a Send / Receive switch, the file sources
 * (opts.file / send(), a picker, "This note"), the stream and the receiver.
 * It loads its parts next to itself on first mount: beam-qr-core.js (wire
 * format + fountain code, see there), ../qr/qr-core.js (the QR encoder and
 * BarcodeDetector / jsQR decoding shared with the QR Code widget) and
 * beam-qr.css. Pass { controls: false } when the host draws its own switch
 * and file buttons.
 *
 * SEND: frames x = 0, 1, 2, … drawn at an integer number of device pixels per
 * module (4-module white quiet zone, white even in dark theme) at 4/6/10 fps,
 * density S/M/L = QR version ~15/22/30. Full screen on tap. Holds a screen
 * wake lock while streaming; pauses while the panel is minimized or the page
 * hidden.
 *
 * RECEIVE: the rear camera, each new video frame decoded as fast as the
 * device keeps up (BarcodeDetector, else jsQR on the centre square scaled to
 * ≤ 800 px). Progress, ETA and a flash per good frame; when every block is in,
 * the camera stops, the CRC32 is checked and the file is offered (Save, Attach
 * to note, Insert text) and handed to opts.onReceived once.
 *
 * destroy() stops the camera, every timer / video-frame callback, the wake
 * lock and full screen, and removes the DOM and listeners.
 * Test hook: __cadeBeamQR._debugFeed(text | ImageData | canvas | image) decodes
 * like a camera frame into the newest receiving mount → Promise<status>. */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // This file's folder, captured while it evaluates.
  var BASE = (function () {
    try {
      var cs = document.currentScript, src = cs && cs.src;
      if (src) { var path = src.split(/[?#]/)[0]; return path.slice(0, path.lastIndexOf('/') + 1); }
    } catch (e) {}
    return window.Cade && window.Cade.baseURL ? window.Cade.baseURL() : './txt/widgets/beam/';
  })();

  var PREFS_KEY = 'cade-beam-qr-prefs';
  var WARN_BYTES = 2 * 1024 * 1024;
  var DECODE_MAX = 800;          // px: the camera's centre square is scaled to this before jsQR
  var TEXT_INSERT_MAX = 2 * 1024 * 1024;
  var QUIET = 4;                 // modules of white around the code
  var TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|rb|go|rs|java|c|h|cpp|sh|ya?ml|toml|ini|log|svg|tex|srt|vtt)$/i;
  var IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i;

  var BC = null, QC = null;      // beam-qr-core.js, qr-core.js once loaded
  var sessions = [];             // live mounts (newest last), for _debugFeed
  var noop = function () {};

  function C() { return window.Cade || null; }
  function esc(s) { s = String(s == null ? '' : s); return C() && C().escapeHtml ? C().escapeHtml(s) : s.replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function toast(msg, kind, ms) { if (C() && C().showToast) C().showToast(msg, kind || 'info', ms || 2500); }
  function maxBytes() { var f = C() && C().files; return (f && f.MAX_BYTES) || 25 * 1024 * 1024; }
  function fmtBytes(n) {
    var f = C() && C().files;
    if (f && f.fmtBytes) return f.fmtBytes(n);
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtRate(bps) { return bps < 1024 ? Math.round(bps) + ' B/s' : (bps / 1024).toFixed(bps < 10240 ? 1 : 0) + ' KB/s'; }
  function fmtDur(s) {
    if (!isFinite(s) || s < 0) return '—';
    if (s < 1) return '< 1 s';
    if (s < 90) return Math.round(s) + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return (s / 3600).toFixed(1) + ' h';
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ------------------------------------------------------------------ loading
  var deps = null;
  function loadScript(url, global) {
    if (window[global]) return Promise.resolve(window[global]);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { if (window[global]) resolve(window[global]); else reject(new Error('missing ' + global)); };
      s.onerror = function () { s.remove(); reject(new Error('failed to load')); };
      document.head.appendChild(s);
    });
  }
  function loadDeps() {
    if (deps) return deps;
    var css = BASE + 'beam-qr.css';
    if (window.__loadCSSOnce) window.__loadCSSOnce(css);
    else if (!document.querySelector('link[href="' + css + '"]')) {
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = css; document.head.appendChild(l);
    }
    deps = Promise.all([
      loadScript(BASE + 'beam-qr-core.js', '__cadeBeamQRCore'),
      loadScript(new URL('../qr/qr-core.js', new URL(BASE, location.href)).href, '__cadeQRCore')
    ]).then(function (r) { BC = r[0]; QC = r[1]; }, function (e) { deps = null; throw e; });
    return deps;
  }

  // ------------------------------------------------------------------- prefs
  function loadPrefs() {
    var p = { density: 'M', fps: 6 };
    try {
      var s = C() && C().store ? JSON.parse(C().store.get(PREFS_KEY) || '{}') : {};
      if (s && /^[SML]$/.test(s.density)) p.density = s.density;
      if (s && [4, 6, 10].indexOf(s.fps) >= 0) p.fps = s.fps;
    } catch (e) {}
    return p;
  }
  function savePrefs(p) { try { if (C() && C().store) C().store.set(PREFS_KEY, JSON.stringify(p)); } catch (e) {} }

  function readBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error || new Error('read')); };
      r.readAsArrayBuffer(blob);
    });
  }
  function isImage(mime, name) { return /^image\//.test(mime || '') || IMG_EXT.test(name || ''); }
  function isTextish(mime, name) { return /^text\/|json|xml|javascript|csv|markdown|x-sh|yaml|toml/.test(mime || '') || TEXT_EXT.test(name || ''); }
  function noteFile() {
    var Cd = C(), ed = Cd && Cd.editor;
    if (!ed) return null;
    var room = '';
    try { room = (Cd.roomsApi && Cd.roomsApi.activeRoom && Cd.roomsApi.activeRoom()) || ''; } catch (e) {}
    room = String(room).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.-]+|[\s.]+$/g, '').slice(0, 80);
    var text = ed.state.doc.toString();
    return { blob: new Blob([text], { type: 'text/plain' }), name: (room || 'note') + '.txt', mime: 'text/plain' };
  }

  // =================================================================== mount
  function mount(container, opts) {
    opts = opts || {};
    var prefs = loadPrefs();
    var root = document.createElement('div');
    root.className = 'bqr' + (opts.controls === false ? ' bqr-bare' : '');
    root.setAttribute('data-mode', opts.mode === 'receive' ? 'receive' : 'send');
    root.innerHTML = html();
    container.appendChild(root);
    var q = function (s) { return root.querySelector(s); };
    var el = {
      fn: q('.bqr-fn'), input: q('.bqr-input'), warn: q('.bqr-warn'), stage: q('.bqr-stage'), canvas: q('.bqr-canvas'),
      ph: q('.bqr-ph'), stats: q('.bqr-stats'), fsinfo: q('.bqr-fsinfo'), play: q('[data-act="play"]'), fsBtn: q('.bqr-row [data-act="fs"]'),
      video: q('.bqr-video'), rstatus: q('.bqr-rstatus'), dot: q('.bqr-dot'), prog: q('.bqr-prog'), bar: q('.bqr-bar i'),
      ptext: q('.bqr-ptext'), diag: q('.bqr-diag'), cam: q('[data-act="cam"]'), done: q('.bqr-done'), prev: q('.bqr-prev'),
      dname: q('.bqr-dname'), insert: q('[data-act="insert"]'), attach: q('[data-act="attach"]')
    };
    var panel = container.closest ? container.closest('.cade-panel') : null;
    var S = {
      dead: false, ready: false, mode: root.getAttribute('data-mode'),
      // send
      src: null, srcBytes: null, tx: null, x: 0, prepGen: 0, sendTimer: null, nextAt: 0, userPaused: false, lastQR: null,
      fs: false, nativeFs: false, sizeCache: 0, modulePx: 0,
      // receive
      rx: null, stream: null, camPending: false, camOn: opts.mode === 'receive', vfc: null, scanTimer: null, scanArmed: false,
      lastText: null, misses: 0, decodeMs: 0, decodes: 0, decodeT0: 0, freshAt: [], rxDone: false, reported: false, got: null, urls: [],
      frame: null, wl: null, wlPending: false
    };
    var self = { S: S, root: root, feed: null };
    sessions.push(self);

    function alive() { return !S.dead; }
    function blocked() {
      return !root.isConnected || document.hidden || (panel && panel.classList.contains('cade-minimized')) ||
        !!(C() && C().isMinimized && panel && C().isMinimized(panel));
    }

    // --------------------------------------------------------------- wake lock
    function wantWake() { return alive() && !blocked() && ((S.mode === 'send' && !!S.sendTimer) || (S.mode === 'receive' && !!S.stream)); }
    function wake() {
      if (wantWake()) {
        if (S.wl || S.wlPending || !navigator.wakeLock || !navigator.wakeLock.request) return;
        S.wlPending = true;
        navigator.wakeLock.request('screen').then(function (l) {
          S.wlPending = false;
          if (!wantWake()) { l.release().catch(noop); return; }
          S.wl = l;
          l.addEventListener('release', function () { if (S.wl === l) S.wl = null; });
        }, function () { S.wlPending = false; });
      } else if (S.wl) {
        var l = S.wl; S.wl = null;
        try { l.release().catch(noop); } catch (e) {}
      }
    }

    // ==================================================================== SEND
    function capBytes() { return BC.capBytesFor(prefs.density, QC.maxChars); }
    function setSource(file) {
      if (!file || !file.blob) return;
      if (file.blob.size > maxBytes()) {
        toast(file.name + ' is ' + fmtBytes(file.blob.size) + ' — the QR stream takes up to ' + fmtBytes(maxBytes()), 'error', 4000);
        return;
      }
      S.src = { blob: file.blob, name: String(file.name || 'file'), mime: file.mime || file.blob.type || 'application/octet-stream' };
      S.srcBytes = null;
      el.fn.textContent = S.src.name + ' · ' + fmtBytes(S.src.blob.size);
      el.fn.title = S.src.name;
      S.userPaused = false;
      if (S.mode !== 'send') setMode('send');
      prepare();
    }
    function prepare() {
      if (!S.ready || !S.src) return;
      var gen = ++S.prepGen, src = S.src;
      stopSend();
      S.tx = null;
      el.ph.textContent = 'Preparing ' + src.name + '…';
      root.classList.add('bqr-empty');
      paintSend();
      (S.srcBytes ? Promise.resolve(S.srcBytes) : readBytes(src.blob)).then(function (bytes) {
        if (!alive() || gen !== S.prepGen) return null;
        S.srcBytes = bytes;
        return BC.prepare({ bytes: bytes, name: src.name, mime: src.mime }, { capBytes: capBytes() });
      }).then(function (tx) {
        if (!tx || !alive() || gen !== S.prepGen) return;
        S.tx = tx; S.x = 0; S.lastQR = null;
        root.classList.remove('bqr-empty');
        paintSend();
        startSend();
      }).catch(function (e) {
        if (!alive() || gen !== S.prepGen) return;
        el.ph.textContent = 'Couldn’t read ' + src.name + (e && e.message ? ' (' + e.message + ')' : '');
      });
    }
    function startSend() {
      if (!S.tx || S.userPaused || S.mode !== 'send' || S.sendTimer || blocked() || !alive()) { paintSend(); return; }
      S.nextAt = 0;
      S.sendTimer = setTimeout(sendTick, 0);
      paintSend();
      wake();
    }
    function stopSend() {
      if (S.sendTimer) { clearTimeout(S.sendTimer); S.sendTimer = null; }
      wake();
      paintSend();
    }
    function sendTick() {
      S.sendTimer = null;
      if (!alive()) return;
      if (!root.isConnected) { destroy(); return; }
      if (!S.tx || S.userPaused || S.mode !== 'send' || blocked()) { wake(); paintSend(); return; }
      var t0 = now();
      // A one-frame transfer is a still code: nothing to animate.
      if (!(S.tx.K === 1 && S.tx.pieces === 1 && S.lastQR)) {
        S.lastQR = QC.encode(BC.frameText(S.tx, S.x), BC.DENSITY[prefs.density].ecl);
        S.x++;
      }
      drawQR();
      var dt = 1000 / prefs.fps;
      S.nextAt = S.nextAt ? S.nextAt + dt : t0 + dt;
      if (S.nextAt < now()) S.nextAt = now() + dt * 0.5;   // fell behind: don't burst
      S.sendTimer = setTimeout(sendTick, Math.max(0, S.nextAt - now()));
      paintSend();
    }
    function stageSize() {
      if (S.sizeCache) return S.sizeCache;
      var w;
      if (S.fs) w = Math.min(window.innerWidth, window.innerHeight - 64) - 16;
      else w = Math.min(el.stage.clientWidth - 2, 560);
      S.sizeCache = Math.max(120, w || 300);
      return S.sizeCache;
    }
    function drawQR() {
      var qr = S.lastQR;
      if (!qr) return;
      var dpr = window.devicePixelRatio || 1, n = qr.size + QUIET * 2;
      var scale = Math.max(1, Math.floor(stageSize() * dpr / n));
      QC.drawQR(el.canvas, qr, scale, QUIET, '#000000', '#ffffff');
      S.modulePx = scale / dpr;
      var css = (n * scale / dpr) + 'px';
      if (el.canvas.style.width !== css) { el.canvas.style.width = css; el.canvas.style.height = css; }
    }
    function paintSend() {
      if (!alive()) return;
      var t = S.tx, has = !!t;
      el.play.disabled = !has;
      el.fsBtn.disabled = !has;
      el.play.textContent = S.sendTimer ? '❚❚ Pause' : '▶ Stream';
      el.play.setAttribute('aria-pressed', S.sendTimer ? 'true' : 'false');
      if (!has) { el.stats.textContent = ''; el.warn.hidden = true; el.fsinfo.textContent = ''; return; }
      var est = BC.estimate(t, prefs.fps), still = t.K === 1 && t.pieces === 1;
      var state = S.sendTimer ? '' : S.userPaused ? 'Paused · ' : blocked() ? 'Paused while hidden · ' : '';
      var frame = still ? 'One code holds it all' : 'Frame ' + S.x + (S.x <= t.K ? ' of ' + t.K + ' (first pass)' : ' · extra frames cover missed ones');
      var zip = t.compressed ? 'compressed ' + fmtBytes(t.size) + ' → ' + fmtBytes(t.L) : '';
      el.stats.textContent = state + frame + (still ? (zip ? ' · ' + zip : '')
        : ' · ' + fmtRate(est.bps) + (zip ? ' (' + zip + ')' : '') + ' · one pass ' + fmtDur(est.passSec));
      el.fsinfo.textContent = (still ? t.name : 'Frame ' + S.x + ' · ' + t.name) + ' · ' + prefs.fps + ' fps';
      var tips = [];
      if (t.size > WARN_BYTES) tips.push(fmtBytes(t.size) + ' takes a while as a QR stream: about ' + fmtDur(est.passSec * 1.1) +
        ' at this density and speed' + (prefs.density !== 'L' || prefs.fps !== 10 ? ' (L at 10 fps is fastest, if the camera keeps up)' : '') + '.');
      // Dense codes drawn small are hard for a camera: suggest full screen.
      if (!S.fs && S.modulePx && S.modulePx < 2.5) tips.push('Dense code at this size: tap it for full screen so the camera can read it.');
      el.warn.hidden = !tips.length;
      el.warn.textContent = tips.join(' ');
    }

    // ------------------------------------------------------------ full screen
    function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
    function enterFs() {
      if (S.fs || !S.tx) return;
      S.fs = true; S.sizeCache = 0;
      root.classList.add('bqr-fs');
      var st = el.stage, req = st.requestFullscreen || st.webkitRequestFullscreen;
      if (req) {
        try { var p = req.call(st); if (p && p.catch) p.catch(noop); } catch (e) {}
      }
      drawQR();
    }
    function exitFs() {
      if (!S.fs) return;
      S.fs = false; S.nativeFs = false; S.sizeCache = 0;
      root.classList.remove('bqr-fs');
      var fe = fsEl();
      if (fe && (fe === el.stage || el.stage.contains(fe))) {
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        try { var p = ex.call(document); if (p && p.catch) p.catch(noop); } catch (e) {}
      }
      drawQR();
    }
    function onFsChange() {
      var fe = fsEl();
      if (fe === el.stage) { S.nativeFs = true; S.sizeCache = 0; drawQR(); }
      else if (S.fs && S.nativeFs) exitFs();
    }

    // ================================================================= RECEIVE
    function setStatus(msg, cls) {
      el.rstatus.textContent = msg || '';
      el.rstatus.className = 'bqr-rstatus' + (cls ? ' ' + cls : '');
    }
    function camErr(err) {
      var n = err && err.name;
      return n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera permission was denied'
        : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera found'
        : n === 'NotReadableError' ? 'The camera is busy in another app'
        : 'Could not start the camera';
    }
    function startCamera() {
      if (!S.ready || S.stream || S.camPending || S.rxDone || S.mode !== 'receive' || blocked()) return;
      var md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        setStatus(window.isSecureContext === false ? 'The camera needs a secure (https) page' : 'No camera access in this browser', 'bad');
        return;
      }
      S.camOn = true; S.camPending = true;
      setStatus('Starting camera…');
      paintRecv();
      QC.getDetector().then(function (d) { if (!d) QC.loadJsQR().catch(noop); });   // warm the decoder meanwhile
      md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(function (stream) {
        S.camPending = false;
        if (!alive() || S.mode !== 'receive' || !S.camOn || S.rxDone || blocked()) { stream.getTracks().forEach(function (t) { t.stop(); }); paintRecv(); return; }
        S.stream = stream;
        var v = el.video;
        v.srcObject = stream;
        v.setAttribute('playsinline', ''); v.muted = true;
        var pr = v.play();
        if (pr && pr.catch) pr.catch(noop);
        root.classList.add('bqr-live');
        if (!S.rx || !S.rx.tid) setStatus('Point the camera at the other screen’s QR stream');
        paintRecv();
        wake();
        armScan();
      }, function (err) {
        S.camPending = false;
        if (!alive()) return;
        S.camOn = false;
        setStatus(camErr(err), 'bad');
        paintRecv();
      });
    }
    function stopCamera() {
      disarmScan();
      if (S.stream) { S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); S.stream = null; }
      try { el.video.pause(); } catch (e) {}
      el.video.srcObject = null;
      root.classList.remove('bqr-live');
      wake();
      paintRecv();
    }
    // One decode per new camera frame (requestVideoFrameCallback), with a
    // timer as the fallback / watchdog.
    function armScan() {
      if (!S.stream || S.scanArmed) return;
      S.scanArmed = true;
      var v = el.video;
      if (v.requestVideoFrameCallback) S.vfc = v.requestVideoFrameCallback(scanTick);
      S.scanTimer = setTimeout(scanTick, S.vfc != null ? 250 : 30);
    }
    function disarmScan() {
      if (S.vfc != null && el.video.cancelVideoFrameCallback) { try { el.video.cancelVideoFrameCallback(S.vfc); } catch (e) {} }
      S.vfc = null;
      if (S.scanTimer) { clearTimeout(S.scanTimer); S.scanTimer = null; }
      S.scanArmed = false;
    }
    function scanTick() {
      disarmScan();
      if (!alive() || !S.stream) return;
      if (!root.isConnected) { destroy(); return; }
      if (blocked()) { pauseAll(); return; }
      var v = el.video;
      if (v.readyState < 2 || !v.videoWidth) { armScan(); return; }
      var t0 = now();
      decodeSource(v, v.videoWidth, v.videoHeight, true).then(function (texts) {
        if (!alive() || !S.stream) return;
        var dt = now() - t0;
        S.decodeMs = S.decodeMs ? S.decodeMs * 0.85 + dt * 0.15 : dt;
        S.decodes++;
        if (!S.decodeT0) S.decodeT0 = t0;
        if (!texts.length) S.misses++;
        texts.forEach(handleText);
        if (S.stream) armScan();
        paintDiag();
      }, function () {
        if (!alive()) return;
        stopCamera();
        setStatus('The QR decoder isn’t available' + (navigator.onLine === false ? ' offline — it needs one online load to cache' : ''), 'bad');
      });
    }
    // Drawable source → Promise<[text]> (empty when no code was found).
    function decodeSource(src, w, h, crop) {
      return QC.getDetector().then(function (det) {
        if (det) {
          return det.detect(src).then(function (codes) {
            var out = [];
            for (var i = 0; i < codes.length; i++) if (codes[i] && codes[i].rawValue) out.push(String(codes[i].rawValue));
            return out;
          }, function () { QC.dropDetector(); return jsqr(src, w, h, crop); });
        }
        return jsqr(src, w, h, crop);
      });
    }
    function jsqr(src, w, h, crop) {
      return QC.loadJsQR().then(function (jsQR) {
        var rect = null;
        if (crop) {
          // The square the user sees (object-fit: cover); every 4th miss a
          // tighter centre crop at more detail, for a small or distant code.
          var side = Math.min(w, h) * (S.misses % 4 === 3 ? 0.62 : 1);
          rect = [(w - side) / 2, (h - side) / 2, side, side];
        }
        var t = QC.jsqrRegion(jsQR, src, rect, w, h, DECODE_MAX, false, S);
        return t == null ? [] : [t];
      });
    }
    function handleText(text) {
      if (!S.rx || S.rxDone) return null;
      if (text === S.lastText) return null;            // the same code, seen again
      var st = S.rx.push(text);
      if (!st.ok) return st;
      S.lastText = text;
      if (st.other) return st;
      S.misses = 0;
      flash(st.fresh);
      if (st.switched && S.freshAt.length) { S.freshAt = []; toast('A new QR stream started — receiving that one', 'info', 2500); }
      if (st.fresh) { S.freshAt.push(now()); if (S.freshAt.length > 40) S.freshAt.shift(); }
      paintRecv();
      if (st.done) finish();
      return st;
    }
    function flash(fresh) {
      var d = el.dot;
      if (!d.animate) return;
      try { d.animate([{ opacity: 1, transform: 'scale(1.35)' }, { opacity: 0.35, transform: 'scale(1)' }], { duration: fresh ? 380 : 200, easing: 'ease-out' }); } catch (e) {}
    }
    function eta() {
      var a = S.freshAt, rx = S.rx;
      if (!rx || a.length < 3) return null;
      var span = (a[a.length - 1] - a[0]) / 1000;
      if (span <= 0) return null;
      var rate = (a.length - 1) / span, left = rx.K - rx.peeler.progress();
      // Idle since the last good frame: the rate is stale, let it grow.
      var idle = (now() - a[a.length - 1]) / 1000;
      return left * 1.05 / rate + Math.max(0, idle - 2 / rate);
    }
    function paintRecv() {
      if (!alive()) return;
      el.cam.textContent = S.stream || S.camPending ? '■ Stop camera' : '📷 Start camera';
      el.cam.hidden = S.rxDone;
      var rx = S.rx, on = !!(rx && rx.tid !== null && !S.rxDone);
      el.prog.hidden = !on;
      if (!on) return;
      var known = rx.peeler.progress(), K = rx.K, m = rx.meta;
      el.bar.style.width = (100 * known / K).toFixed(1) + '%';
      var e = eta();
      el.ptext.textContent = known + ' of ' + K + ' block' + (K === 1 ? '' : 's') + (e != null && known < K ? ' · ETA ' + fmtDur(e) : '');
      setStatus(m ? 'Receiving ' + m.name + ' · ' + fmtBytes(m.size) : 'Receiving…', 'ok');
    }
    function paintDiag() {
      if (!S.decodes) { el.diag.textContent = ''; return; }
      var secs = (now() - S.decodeT0) / 1000;
      var rate = secs > 0.5 ? S.decodes / secs : 0;
      el.diag.textContent = (rate ? 'decoding ' + rate.toFixed(rate < 10 ? 1 : 0) + ' fps · ' : '') + Math.round(S.decodeMs) + ' ms per frame' +
        (S.rx && S.rx.valid ? ' · ' + S.rx.valid + ' good frame' + (S.rx.valid === 1 ? '' : 's') : '');
    }
    function finish() {
      S.rxDone = true;
      S.camOn = false;
      stopCamera();
      setStatus('Checking…');
      var rx = S.rx;
      rx.finish().then(function (res) {
        if (!alive() || rx !== S.rx) return;
        S.got = { blob: new Blob([res.bytes], { type: res.mime }), name: res.name, mime: res.mime, bytes: res.bytes };
        showDone();
        try { if (C() && C().haptic) C().haptic(30); } catch (e) {}
        if (!S.reported) {
          S.reported = true;
          if (typeof opts.onReceived === 'function') {
            try { opts.onReceived({ blob: S.got.blob, name: S.got.name, mime: S.got.mime }); } catch (e) { if (window.console) console.error(e); }
          }
        }
      }, function (e) {
        if (!alive() || rx !== S.rx) return;
        var m = e && e.message;
        resetReceiver();
        setStatus(m === 'inflate' ? 'This browser can’t unpack the compressed stream — update it, or send with another one'
          : 'The file didn’t check out (' + (m || 'error') + ') — catching it again…', 'bad');
        if (m !== 'inflate') { S.camOn = true; startCamera(); }
      });
    }
    function showDone() {
      var g = S.got, img = isImage(g.mime, g.name), text = null;
      if (!img && isTextish(g.mime, g.name) || /^text\//.test(g.mime)) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(g.bytes); } catch (e) { text = null; }
      }
      g.text = text;
      freeUrls();
      var prev = '';
      if (img) { var u = URL.createObjectURL(g.blob); S.urls.push(u); prev = '<img alt="" src="' + esc(u) + '">'; }
      else if (text != null) {
        var lines = text.split(/\r?\n/).slice(0, 12).join('\n');
        prev = '<pre>' + esc(lines.length > 1200 ? lines.slice(0, 1200) + '…' : lines) + '</pre>';
      } else prev = '<span class="bqr-ic" aria-hidden="true">📄</span>';
      el.prev.innerHTML = prev;
      var im = el.prev.querySelector('img');
      if (im) im.onerror = function () { el.prev.innerHTML = '<span class="bqr-ic" aria-hidden="true">🖼</span>'; };
      el.dname.innerHTML = '<b>' + esc(g.name) + '</b><small>' + fmtBytes(g.blob.size) + ' · ' + esc(g.mime) + ' · checked ✓</small>';
      el.insert.hidden = text == null || g.blob.size > TEXT_INSERT_MAX;
      var tooBig = g.blob.size > maxBytes();
      el.attach.disabled = tooBig;
      el.attach.title = tooBig ? 'Over ' + fmtBytes(maxBytes()) + ' — too big to attach to a note' : 'Store it in the note as a file';
      el.done.hidden = false;
      root.classList.add('bqr-got');
      setStatus('Received ' + g.name, 'ok');
      el.prog.hidden = true;
      paintRecv();
    }
    function freeUrls() { S.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); S.urls = []; }
    function resetReceiver() {
      S.rx = BC.createReceiver();
      S.rxDone = false; S.reported = false; S.got = null; S.lastText = null; S.freshAt = []; S.misses = 0;
      S.decodes = 0; S.decodeT0 = 0; S.decodeMs = 0;
      freeUrls();
      el.done.hidden = true; el.prev.innerHTML = ''; el.diag.textContent = '';
      root.classList.remove('bqr-got');
      setStatus('');
      paintRecv();
    }
    function doSave() { if (S.got && C() && C().files) C().files.save(S.got.blob, S.got.name); }
    function doAttach() {
      var g = S.got, Cd = C();
      if (!g || !Cd || !Cd.files) return;
      if (g.blob.size > maxBytes()) { toast(g.name + ' is too big to attach — Save it instead', 'error', 3000); return; }
      if (Cd.editor && Cd.editor.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
      var f;
      try { f = new File([g.blob], g.name, { type: g.mime }); } catch (e) { f = g.blob; try { f.name = g.name; } catch (e2) {} }
      Cd.files.attach(f);
    }
    function doInsert() {
      var g = S.got, ed = C() && C().editor;
      if (!g || g.text == null || !ed) return;
      if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
      ed.dispatch(ed.state.replaceSelection(g.text), { userEvent: 'input', scrollIntoView: true });
      toast('Inserted ' + g.name, 'success', 1400);
    }

    // ============================================================ mode / life
    function setMode(m) {
      m = m === 'receive' ? 'receive' : 'send';
      S.mode = m;
      root.setAttribute('data-mode', m);
      root.querySelectorAll('.bqr-seg [data-mode]').forEach(function (b) {
        var on = b.getAttribute('data-mode') === m;
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (!S.ready) return;
      if (m === 'send') {
        stopCamera();
        S.sizeCache = 0;
        if (S.tx) { drawQR(); startSend(); } else paintSend();
      } else {
        exitFs();
        stopSend();
        if (!S.rx) resetReceiver();
        if (!S.rxDone) { S.camOn = true; startCamera(); }
      }
    }
    function pauseAll() {
      stopSend();
      if (S.stream || S.camPending) stopCamera();   // S.camOn stays: resume brings it back
      exitFs();
      wake();
    }
    function resumeAll() {
      if (!alive() || blocked() || !S.ready) return;
      if (S.mode === 'send') startSend();
      else if (S.camOn && !S.rxDone) startCamera();
    }
    function onVis() { if (document.hidden) pauseAll(); else resumeAll(); }
    function onMin() { pauseAll(); }
    function onRestore() { setTimeout(resumeAll, 0); }
    function onResize() { S.sizeCache = 0; if (S.lastQR && S.mode === 'send') drawQR(); }
    function onKey(e) {
      if (e.key === 'Escape' && S.fs) { e.preventDefault(); e.stopPropagation(); exitFs(); }
    }
    function onClick(e) {
      var t = e.target.closest ? e.target.closest('[data-act],[data-mode],[data-density],[data-fps]') : null;
      if (!t || !root.contains(t) || t.disabled) return;
      if (t.hasAttribute('data-mode')) { setMode(t.getAttribute('data-mode')); return; }
      if (!S.ready) return;
      if (t.hasAttribute('data-density')) {
        var d = t.getAttribute('data-density');
        if (d === prefs.density) return;
        prefs.density = d; savePrefs(prefs); paintOpts();
        if (S.src) prepare();                         // new block size → a new transfer
        return;
      }
      if (t.hasAttribute('data-fps')) {
        prefs.fps = +t.getAttribute('data-fps'); savePrefs(prefs); paintOpts(); paintSend();
        return;
      }
      switch (t.getAttribute('data-act')) {
        case 'pick': el.input.click(); break;
        case 'note': {
          var nf = noteFile();
          if (!nf) toast('No note open', 'error', 2000); else setSource(nf);
          break;
        }
        case 'play':
          if (S.sendTimer) { S.userPaused = true; stopSend(); }
          else { S.userPaused = false; startSend(); }
          break;
        case 'fs': if (S.fs) exitFs(); else enterFs(); break;
        case 'fs-exit': exitFs(); break;
        case 'cam':
          if (S.stream || S.camPending) { S.camOn = false; stopCamera(); setStatus(''); }
          else { S.camOn = true; startCamera(); }
          break;
        case 'save': doSave(); break;
        case 'attach': doAttach(); break;
        case 'insert': doInsert(); break;
        case 'again': resetReceiver(); S.camOn = true; startCamera(); break;
      }
    }
    function paintOpts() {
      root.querySelectorAll('[data-density]').forEach(function (b) { var on = b.getAttribute('data-density') === prefs.density; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      root.querySelectorAll('[data-fps]').forEach(function (b) { var on = +b.getAttribute('data-fps') === prefs.fps; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }
    function onPick(e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) setSource({ blob: f, name: f.name, mime: f.type });
    }

    var ro = null;
    root.addEventListener('click', onClick);
    el.input.addEventListener('change', onPick);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    window.addEventListener('resize', onResize);
    if (panel) { panel.addEventListener('cade-panel-minimize', onMin); panel.addEventListener('cade-panel-restore', onRestore); }
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(el.stage); }

    function destroy() {
      if (S.dead) return;
      stopSend();
      stopCamera();
      exitFs();
      S.dead = true;
      S.prepGen++;
      if (S.wl) { try { S.wl.release().catch(noop); } catch (e) {} S.wl = null; }
      freeUrls();
      root.removeEventListener('click', onClick);
      el.input.removeEventListener('change', onPick);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      window.removeEventListener('resize', onResize);
      if (panel) { panel.removeEventListener('cade-panel-minimize', onMin); panel.removeEventListener('cade-panel-restore', onRestore); }
      if (ro) { ro.disconnect(); ro = null; }
      S.frame = null; S.srcBytes = null; S.tx = null; S.rx = null; S.lastQR = null;
      root.remove();
      var i = sessions.indexOf(self);
      if (i >= 0) sessions.splice(i, 1);
    }

    // Camera-less entry for tests: text, ImageData or a drawable.
    self.feed = function (src) {
      if (!S.ready) return Promise.reject(new Error('not ready'));
      if (S.mode !== 'receive') setMode('receive');
      if (!S.rx) resetReceiver();
      var p;
      if (typeof src === 'string') p = Promise.resolve([src]);
      else if (typeof ImageData !== 'undefined' && src instanceof ImageData) {
        p = QC.loadJsQR().then(function (jsQR) { var r = jsQR(src.data, src.width, src.height, { inversionAttempts: 'dontInvert' }); return r ? [r.data] : []; });
      } else {
        var w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
        p = decodeSource(src, w, h, false);
      }
      return p.then(function (texts) {
        var st = null;
        texts.forEach(function (t) { st = handleText(t) || st; });
        paintDiag();
        return { found: texts.length > 0, status: st, known: S.rx ? S.rx.peeler.known : 0, progress: S.rx ? S.rx.peeler.progress() : 0, K: S.rx ? S.rx.K : 0, done: S.rxDone, meta: S.rx && S.rx.meta };
      });
    };

    setMode(S.mode);
    paintOpts();
    root.classList.add('bqr-empty', 'bqr-loading');
    el.ph.textContent = 'Loading…';
    loadDeps().then(function () {
      if (!alive()) return;
      S.ready = true;
      root.classList.remove('bqr-loading');
      el.ph.innerHTML = opts.controls === false ? 'Choose a file to stream it here as a moving QR code.'
        : 'Pick a file or <b>This note</b> — it streams here as a moving QR code for the other device’s camera.';
      S.rx = BC.createReceiver();
      if (opts.file && opts.file.blob) setSource(opts.file);
      setMode(S.mode);
    }, function () {
      if (!alive()) return;
      root.classList.remove('bqr-loading');
      el.ph.textContent = 'The QR stream couldn’t load' + (navigator.onLine === false ? ' (offline?)' : '') + '.';
      setStatus('The QR stream couldn’t load' + (navigator.onLine === false ? ' (offline?)' : '') + '.', 'bad');
    });

    return {
      destroy: destroy,
      send: function (file) {
        if (S.dead) return;
        if (!S.ready) { opts.file = file; if (S.mode !== 'send') setMode('send'); return; }
        setSource(file);
      }
    };
  }

  function html() {
    var seg = function (attr, vals, labels) {
      return vals.map(function (v, i) { return '<button type="button" data-' + attr + '="' + v + '">' + labels[i] + '</button>'; }).join('');
    };
    return '<div class="bqr-seg" role="group" aria-label="QR stream direction">' +
        '<button type="button" data-mode="send">Send</button><button type="button" data-mode="receive">Receive</button></div>' +
      '<div class="bqr-pane bqr-send">' +
        '<div class="bqr-src">' +
          '<span class="bqr-fn">No file chosen</span>' +
          '<button type="button" class="bqr-btn" data-act="pick">📎 File</button>' +
          '<button type="button" class="bqr-btn" data-act="note">📝 This note</button>' +
          '<input type="file" class="bqr-input" tabindex="-1" aria-hidden="true">' +
        '</div>' +
        '<div class="bqr-warn" role="note" hidden></div>' +
        '<div class="bqr-stage" data-act="fs" title="Full screen (tap again to leave)">' +
          '<canvas class="bqr-canvas" width="10" height="10" role="img" aria-label="Animated QR code"></canvas>' +
          '<div class="bqr-ph"></div>' +
          '<div class="bqr-fsbar"><span class="bqr-fsinfo"></span><button type="button" class="bqr-btn" data-act="fs-exit">✕ Close</button></div>' +
        '</div>' +
        '<div class="bqr-stats"></div>' +
        '<div class="bqr-row">' +
          '<button type="button" class="bqr-btn primary" data-act="play" disabled>▶ Stream</button>' +
          '<button type="button" class="bqr-btn" data-act="fs" disabled>⛶ Full screen</button>' +
        '</div>' +
        '<div class="bqr-row bqr-opts">' +
          '<span class="bqr-lbl" title="How much each code carries: denser is faster but needs a steadier, closer camera">Density</span>' +
          '<span class="bqr-segs">' + seg('density', ['S', 'M', 'L'], ['S', 'M', 'L']) + '</span>' +
          '<span class="bqr-lbl">Speed</span>' +
          '<span class="bqr-segs">' + seg('fps', [4, 6, 10], ['4', '6', '10 fps']) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="bqr-pane bqr-recv">' +
        '<div class="bqr-cam"><video class="bqr-video" playsinline muted autoplay></video>' +
          '<div class="bqr-reticle" aria-hidden="true"></div><div class="bqr-camoff" aria-hidden="true">📷</div></div>' +
        '<div class="bqr-rrow"><span class="bqr-dot" aria-hidden="true"></span><span class="bqr-rstatus" aria-live="polite"></span></div>' +
        '<div class="bqr-prog" hidden><div class="bqr-bar"><i></i></div><div class="bqr-ptext"></div></div>' +
        '<div class="bqr-diag"></div>' +
        '<div class="bqr-done" hidden>' +
          '<div class="bqr-prev"></div><div class="bqr-dname"></div>' +
          '<div class="bqr-row">' +
            '<button type="button" class="bqr-btn primary" data-act="save">↓ Save</button>' +
            '<button type="button" class="bqr-btn" data-act="attach">📎 Attach to note</button>' +
            '<button type="button" class="bqr-btn" data-act="insert" hidden>⤓ Insert into note</button>' +
            '<button type="button" class="bqr-btn" data-act="again">↻ Receive another</button>' +
          '</div>' +
        '</div>' +
        '<div class="bqr-row"><button type="button" class="bqr-btn" data-act="cam">📷 Start camera</button></div>' +
      '</div>';
  }

  window.__cadeBeamQR = {
    mount: mount,
    _base: BASE,
    // Feed one "camera frame" to the newest receiving mount (tests / debugging).
    _debugFeed: function (src) {
      for (var i = sessions.length - 1; i >= 0; i--) if (sessions[i].S.ready) return sessions[i].feed(src);
      return Promise.reject(new Error('no QR stream mounted'));
    },
    _sessions: function () { return sessions.length; }
  };
})();
