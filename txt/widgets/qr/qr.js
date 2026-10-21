/* QR Code — generate and scan QR codes.
 *
 * GENERATE: a text box prefilled from the selection (or the URL / word under
 * the cursor), or a preset form (Wi-Fi, email, phone, SMS, vCard) that builds
 * the standard payload string. Live preview; error correction L/M/Q/H, export
 * size, quiet-zone margin and dark/light colours (default black on white —
 * the most scannable). Insert into the document as an image, copy the PNG
 * (ClipboardItem), download PNG, or copy / download SVG.
 *
 * Insert reuses the core's embedded-image pipeline exactly like the
 * Whiteboard (txt/widgets/draw/draw.js): window.insertImageFile(file)
 * compresses, content-hashes, stores/uploads the bytes and drops the core's
 * own "![img:<code>#<hash>]" token at the cursor — no token format of ours.
 * The PNG is rendered at an INTEGER pixels-per-module size no larger than the
 * core's 800px resize cap, so its lossy re-encode never resamples modules.
 *
 * SCAN: camera (getUserMedia, rear camera preferred) decoded with the native
 * BarcodeDetector when it supports QR, else jsQR lazy-loaded from a pinned
 * CDN URL on first need; frames are sampled ~8 fps from a downscaled canvas.
 * Also decodes an image file / pasted / dropped image. The camera stream and
 * the frame loop always stop on Stop, tab switch, Escape and panel close.
 *
 * The encoder, renderers and decoder loaders live in qr-core.js (shared with
 * Beam's QR stream); it is loaded with a script tag next to this file the
 * first time the panel opens, before anything renders.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();   // this file's folder — only valid while it evaluates
  Cade.loadCSS('qr.css');
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'qr-panel';
  var PREFS_KEY = 'cade-qr-prefs';
  var INSERT_MAX_PX = 800;   // core compressImage resizes anything larger
  var FRAME_MS = 125;        // ~8 fps camera sampling
  var FRAME_MAX = 640;       // downscale frames before jsQR (speed)
  var ECLS = { L: 1, M: 1, Q: 1, H: 1 };

  // ================================================================ qr-core.js
  var Q = null;              // window.__cadeQRCore once loaded
  var coreLoading = null;
  function loadCore() {
    if (window.__cadeQRCore) { Q = window.__cadeQRCore; return Promise.resolve(Q); }
    if (coreLoading) return coreLoading;
    coreLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BASE + 'qr-core.js';
      s.async = true;
      s.onload = function () {
        if (window.__cadeQRCore) { Q = window.__cadeQRCore; resolve(Q); }
        else { coreLoading = null; reject(new Error('qr core missing')); }
      };
      s.onerror = function () { coreLoading = null; s.remove(); reject(new Error('qr core failed to load')); };
      document.head.appendChild(s);
    });
    return coreLoading;
  }

  // ============================================================ payload builders
  var PRESETS = [
    { id: 'text', label: 'Text / URL', icon: '✎' },
    { id: 'wifi', label: 'Wi-Fi', icon: '📶' },
    { id: 'email', label: 'Email', icon: '✉' },
    { id: 'phone', label: 'Phone', icon: '☎' },
    { id: 'sms', label: 'SMS', icon: '💬' },
    { id: 'vcard', label: 'Contact', icon: '👤' }
  ];
  // Field specs per preset: [key, label, type, placeholder]
  var FIELDS = {
    wifi: [['ssid', 'Network name (SSID)', 'text', 'MyNetwork'], ['pass', 'Password', 'text', ''],
           ['sec', 'Security', 'select:WPA=WPA / WPA2 / WPA3|WEP=WEP|nopass=None (open)', ''], ['hidden', 'Hidden network', 'check', '']],
    email: [['to', 'To', 'email', 'name@example.com'], ['subject', 'Subject', 'text', ''], ['body', 'Message', 'area', '']],
    phone: [['tel', 'Phone number', 'tel', '+1 555 123 4567']],
    sms: [['tel', 'Phone number', 'tel', '+1 555 123 4567'], ['msg', 'Message', 'area', '']],
    vcard: [['first', 'First name', 'text', ''], ['last', 'Last name', 'text', ''], ['org', 'Organisation', 'text', ''],
            ['title', 'Job title', 'text', ''], ['tel', 'Phone', 'tel', ''], ['email', 'Email', 'email', ''],
            ['url', 'Website', 'url', ''], ['note', 'Note', 'text', '']]
  };
  function wifiEsc(s) { return String(s).replace(/([\\;,":])/g, '\\$1'); }
  function vEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function cleanTel(s) { return String(s).replace(/[^\d+*#]/g, ''); }
  function buildPayload(preset, f) {
    f = f || {};
    var v = function (k) { return String(f[k] == null ? '' : f[k]).trim(); };
    switch (preset) {
      case 'wifi': {
        if (!v('ssid')) return '';
        var sec = f.sec || 'WPA';
        var out = 'WIFI:T:' + sec + ';S:' + wifiEsc(v('ssid')) + ';';
        if (sec !== 'nopass' && f.pass) out += 'P:' + wifiEsc(f.pass) + ';';
        if (f.hidden) out += 'H:true;';
        return out + ';';
      }
      case 'email': {
        if (!v('to') && !v('subject') && !v('body')) return '';
        var q = [];
        if (v('subject')) q.push('subject=' + encodeURIComponent(v('subject')));
        if (v('body')) q.push('body=' + encodeURIComponent(String(f.body).replace(/\r?\n/g, '\r\n')));
        return 'mailto:' + v('to').replace(/\s+/g, '') + (q.length ? '?' + q.join('&') : '');
      }
      case 'phone':
        return cleanTel(v('tel')) ? 'tel:' + cleanTel(v('tel')) : '';
      case 'sms':
        if (!cleanTel(v('tel')) && !v('msg')) return '';
        return 'SMSTO:' + cleanTel(v('tel')) + ':' + String(f.msg || '');
      case 'vcard': {
        var fn = (v('first') + ' ' + v('last')).trim();
        if (!fn && !v('org') && !v('tel') && !v('email')) return '';
        var L = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vEsc(v('last')) + ';' + vEsc(v('first')) + ';;;', 'FN:' + vEsc(fn || v('org'))];
        if (v('org')) L.push('ORG:' + vEsc(v('org')));
        if (v('title')) L.push('TITLE:' + vEsc(v('title')));
        if (v('tel')) L.push('TEL;TYPE=CELL:' + v('tel'));
        if (v('email')) L.push('EMAIL:' + v('email'));
        if (v('url')) L.push('URL:' + v('url'));
        if (v('note')) L.push('NOTE:' + vEsc(v('note')));
        L.push('END:VCARD');
        return L.join('\n');
      }
      default:
        return String(f.text == null ? '' : f.text);
    }
  }

  // ================================================================== helpers
  var prefs = { ecl: 'M', size: 320, margin: 4, dark: '#000000', light: '#ffffff', preset: 'text' };
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (p.ecl in ECLS) prefs.ecl = p.ecl;
      if (p.size >= 64 && p.size <= 2048) prefs.size = p.size | 0;
      if (p.margin >= 0 && p.margin <= 16) prefs.margin = p.margin | 0;
      if (/^#[0-9a-f]{6}$/i.test(p.dark || '')) prefs.dark = p.dark;
      if (/^#[0-9a-f]{6}$/i.test(p.light || '')) prefs.light = p.light;
      if (FIELDS[p.preset] || p.preset === 'text') prefs.preset = p.preset;
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(h) {
    var c = hexRgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function copyText(text, label) {
    var done = function () { Cade.showToast('Copied ' + (label || 'text'), 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
  }
  function editorWritable() {
    var ed = Cade.editor;
    if (!ed) return null;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return null; }
    return ed;
  }
  function slug(s) {
    var t = String(s || '').replace(/^[a-z]+:\/*/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32).toLowerCase();
    return t || 'code';
  }

  // Selection, else the URL under the cursor, else the word under the cursor.
  function seedFromEditor() {
    try {
      var ed = Cade.editor, st = ed.state, sel = st.selection.main;
      if (!sel.empty) {
        var s = st.sliceDoc(sel.from, Math.min(sel.to, sel.from + 4000));
        if (s.trim()) return s;
      }
      var line = st.doc.lineAt(sel.head);
      if (line.length > 2000) return '';
      var col = sel.head - line.from, t = line.text, m;
      var re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
      while ((m = re.exec(t)) !== null) {
        if (col >= m.index && col <= m.index + m[0].length) return m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
      }
      var a = col, b = col;
      while (a > 0 && !/\s/.test(t.charAt(a - 1))) a--;
      while (b < t.length && !/\s/.test(t.charAt(b))) b++;
      var w = t.slice(a, b).replace(/^[(\["'<]+|[.,;:!?)\]}>'"]+$/g, '');
      if (w.indexOf('![img:') === 0) return '';
      return w;
    } catch (e) { return ''; }
  }

  // ==================================================================== state
  var S = null;           // live panel session (null when closed)
  var lastText = '';      // text box survives panel close (in memory only)
  var forms = {};         // preset form values, in memory only (never stored — passwords)

  function panel() { return document.getElementById(PANEL_ID); }

  // ----------------------------------------------------------------- generate
  function currentPayload() {
    if (prefs.preset === 'text') return lastText;
    return buildPayload(prefs.preset, forms[prefs.preset]);
  }

  function renderForm() {
    var box = S.p.querySelector('.qr-form');
    var pr = prefs.preset;
    if (pr === 'text') {
      box.innerHTML = '<textarea class="qr-text" rows="3" placeholder="Text or URL to encode…" spellcheck="false" aria-label="Text to encode"></textarea>';
      box.querySelector('.qr-text').value = lastText;
    } else {
      var f = forms[pr] || (forms[pr] = pr === 'wifi' ? { sec: 'WPA' } : {});
      var html = '';
      FIELDS[pr].forEach(function (d) {
        var key = d[0], label = d[1], type = d[2], ph = d[3];
        if (type === 'check') {
          html += '<label class="qr-chk"><input type="checkbox" data-k="' + key + '"' + (f[key] ? ' checked' : '') + '> ' + esc(label) + '</label>';
        } else if (type.indexOf('select:') === 0) {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><select data-k="' + key + '">' +
            type.slice(7).split('|').map(function (o) {
              var kv = o.split('=');
              return '<option value="' + esc(kv[0]) + '"' + ((f[key] || '') === kv[0] ? ' selected' : '') + '>' + esc(kv[1]) + '</option>';
            }).join('') + '</select></label>';
        } else if (type === 'area') {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><textarea rows="2" data-k="' + key + '" placeholder="' + esc(ph) + '">' + esc(f[key] || '') + '</textarea></label>';
        } else {
          html += '<label class="qr-fld"><span>' + esc(label) + '</span><input type="' + type + '" data-k="' + key + '" value="' + esc(f[key] || '') +
            '" placeholder="' + esc(ph) + '" autocomplete="off" autocapitalize="off" spellcheck="false"></label>';
        }
      });
      html += '<div class="qr-payload" title="Encoded payload"></div>';
      box.innerHTML = html;
      var pw = box.querySelector('[data-k="pass"]');
      if (pw) pw.disabled = f.sec === 'nopass';
    }
    S.p.querySelectorAll('.qr-preset').forEach(function (b) {
      var on = b.getAttribute('data-p') === pr;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function schedule() {
    if (!S) return;
    clearTimeout(S.genTimer);
    S.genTimer = setTimeout(regenerate, 70);
  }

  function regenerate() {
    if (!S) return;
    var p = S.p, payload = currentPayload();
    var info = p.querySelector('.qr-info'), cv = p.querySelector('.qr-canvas');
    var pl = p.querySelector('.qr-payload');
    if (pl) pl.textContent = payload || '';
    S.qr = null;
    p.classList.toggle('qr-empty', !payload);
    if (!payload) {
      info.textContent = prefs.preset === 'text' ? 'Type or paste something to encode' : 'Fill in the form to build a code';
      info.className = 'qr-info';
      drawPlaceholder(cv);
      return;
    }
    try {
      S.qr = Q.encode(payload, prefs.ecl);
    } catch (e) {
      info.textContent = 'Too long for a QR code at level ' + prefs.ecl + ' — shorten it or use level L (max 2953 bytes)';
      info.className = 'qr-info bad';
      drawPlaceholder(cv);
      return;
    }
    var qr = S.qr, dpr = window.devicePixelRatio || 1;
    var n = qr.size + prefs.margin * 2;
    // Preview at an integer scale near the on-screen size; CSS keeps it pixelated.
    Q.drawQR(cv, qr, Math.max(1, Math.floor(220 * dpr / n)), prefs.margin, prefs.dark, prefs.light);
    var px = n * Q.scaleFor(qr, prefs.margin, prefs.size);
    var msg = 'v' + qr.version + ' · ' + qr.size + '×' + qr.size + ' · ' + qr.bytes + (qr.mode === 'byte' ? ' bytes' : ' chars') +
      ' · ECC ' + qr.ecl + ' · ' + px + 'px';
    var cls = 'qr-info';
    var ld = lum(prefs.dark), ll = lum(prefs.light);
    var ratio = (Math.max(ld, ll) + 0.05) / (Math.min(ld, ll) + 0.05);
    if (ld > ll) { msg += ' — inverted colours: many scanners can\'t read these'; cls += ' warn'; }
    else if (ratio < 4) { msg += ' — low contrast, may not scan'; cls += ' warn'; }
    else if (prefs.margin < 2) { msg += ' — small margin, may not scan'; cls += ' warn'; }
    info.textContent = msg;
    info.className = cls;
  }

  function drawPlaceholder(cv) {
    cv.width = cv.height = 10;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, 10, 10);
  }

  function exportCanvas(maxPx) {
    if (!S || !S.qr) return null;
    var qr = S.qr, n = qr.size + prefs.margin * 2;
    var scale = Q.scaleFor(qr, prefs.margin, prefs.size);
    if (maxPx && n * scale > maxPx) scale = Math.max(1, Math.floor(maxPx / n));
    var c = document.createElement('canvas');
    Q.drawQR(c, qr, scale, prefs.margin, prefs.dark, prefs.light);
    return c;
  }
  function canvasBlob(c) {
    return new Promise(function (resolve) {
      if (!c || !c.toBlob) { resolve(null); return; }
      c.toBlob(function (b) { resolve(b || null); }, 'image/png');
    });
  }
  function needQR() {
    if (S && S.qr) return true;
    Cade.showToast('Nothing to encode yet', 'info', 1600);
    return false;
  }

  function doInsertImage() {
    if (!needQR()) return;
    var ed = editorWritable();
    if (!ed) return;
    if (typeof window.insertImageFile !== 'function') { Cade.showToast('Image pipeline unavailable', 'error', 2500); return; }
    // insertImageFile REPLACES the selection at the cursor. The selection is
    // usually the very text being encoded, and a cursor inside a word/URL
    // would split it — so park the cursor at the end of that line first and
    // the image lands on its own line below.
    var sel = ed.state.selection.main, line = ed.state.doc.lineAt(sel.to);
    if (!sel.empty || (sel.head > line.from && sel.head < line.to)) {
      ed.dispatch({ selection: { anchor: line.to } });
    }
    canvasBlob(exportCanvas(INSERT_MAX_PX)).then(function (blob) {
      if (!blob) { Cade.showToast('Could not render PNG', 'error', 2500); return; }
      // Same path as the Whiteboard: the core compresses, hashes, stores and
      // inserts its own image token at the cursor (and toasts).
      return window.insertImageFile(new File([blob], 'qr-code.png', { type: 'image/png' }));
    }).catch(function (e) { Cade.showToast('Insert failed: ' + ((e && e.message) || e), 'error', 3000); });
  }

  function doCopyImage() {
    if (!needQR()) return;
    if (!navigator.clipboard || !navigator.clipboard.write || typeof window.ClipboardItem === 'undefined') {
      Cade.showToast('Image copy isn\'t supported here — use PNG download', 'error', 2600); return;
    }
    var blobP = canvasBlob(exportCanvas());
    var ok = function () { Cade.showToast('QR image copied', 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed — use PNG download', 'error', 2400); };
    // Safari needs the ClipboardItem built synchronously inside the gesture
    // (promise value); older Chromium only accepts a resolved Blob — retry.
    var item;
    try { item = new window.ClipboardItem({ 'image/png': blobP }); } catch (e) { item = null; }
    var retry = function () {
      return blobP.then(function (b) {
        if (!b) throw new Error('no blob');
        return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': b })]);
      }).then(ok, fail);
    };
    if (!item) { retry(); return; }
    navigator.clipboard.write([item]).then(ok, retry);
  }

  function doDownloadPng() {
    if (!needQR()) return;
    canvasBlob(exportCanvas()).then(function (b) {
      if (b) download(b, 'qr-' + slug(currentPayload()) + '.png');
      else Cade.showToast('Could not render PNG', 'error', 2000);
    });
  }
  function svgString() {
    var qr = S.qr, n = qr.size + prefs.margin * 2;
    return Q.toSVG(qr, prefs.margin, prefs.dark, prefs.light, n * Q.scaleFor(qr, prefs.margin, prefs.size));
  }
  function doCopySvg() { if (needQR()) copyText(svgString(), 'SVG'); }
  function doDownloadSvg() {
    if (!needQR()) return;
    download(new Blob([svgString()], { type: 'image/svg+xml' }), 'qr-' + slug(currentPayload()) + '.svg');
  }

  function renderOpts() {
    var p = S.p;
    p.querySelectorAll('.qr-ecl').forEach(function (b) {
      var on = b.getAttribute('data-e') === prefs.ecl;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    p.querySelector('.qr-size').value = prefs.size;
    p.querySelector('.qr-size-v').textContent = prefs.size + 'px';
    p.querySelector('.qr-margin').value = prefs.margin;
    p.querySelector('.qr-margin-v').textContent = prefs.margin;
    p.querySelector('.qr-dark').value = prefs.dark;
    p.querySelector('.qr-light').value = prefs.light;
  }

  function setStatus(msg, cls) {
    if (!S) return;
    var el = S.p.querySelector('.qr-status');
    el.textContent = msg || '';
    el.className = 'qr-status' + (cls ? ' ' + cls : '');
  }

  function startCamera() {
    if (!S || S.stream) return;
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      setStatus(window.isSecureContext === false ? 'The camera needs a secure (https) page' : 'No camera access in this browser', 'bad');
      return;
    }
    setStatus('Starting camera…');
    var sess = S;
    // Warm the decoder in parallel with the permission prompt.
    Q.getDetector().then(function (d) { if (!d) Q.loadJsQR().catch(function () {}); });
    md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        if (S !== sess || sess.tab !== 'scan') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        sess.stream = stream;
        var v = sess.p.querySelector('.qr-video');
        v.srcObject = stream;
        v.setAttribute('playsinline', '');
        v.muted = true;
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {});
        sess.p.querySelector('.qr-cam').hidden = false;
        sess.p.querySelector('.qr-cam-btn').textContent = '■ Stop camera';
        setStatus('Point the camera at a QR code');
        scanTick();
      }, function (err) {
        var n = err && err.name;
        setStatus(n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera permission was denied'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera found'
          : n === 'NotReadableError' ? 'The camera is busy in another app'
          : 'Could not start the camera', 'bad');
      });
  }

  function stopCamera() {
    if (!S) return;
    clearTimeout(S.scanTimer);
    S.scanTimer = null;
    S.scanBusy = false;
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      S.stream = null;
    }
    var v = S.p.querySelector('.qr-video');
    if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; }
    var cam = S.p.querySelector('.qr-cam');
    if (cam) cam.hidden = true;
    var b = S.p.querySelector('.qr-cam-btn');
    if (b) b.textContent = '📷 Scan with camera';
  }

  function scanTick() {
    var sess = S;
    if (!sess || !sess.stream) return;
    var v = sess.p.querySelector('.qr-video');
    if (!v || v.readyState < 2 || !v.videoWidth) { sess.scanTimer = setTimeout(scanTick, FRAME_MS); return; }
    var t0 = Date.now();
    Q.decodeSource(v, v.videoWidth, v.videoHeight, FRAME_MAX, false, sess).then(function (txt) {
      if (S !== sess || !sess.stream) return;
      if (txt != null && txt !== '') {
        Cade.haptic && Cade.haptic(30);
        stopCamera();
        showResult(txt);
        return;
      }
      sess.scanTimer = setTimeout(scanTick, Math.max(20, FRAME_MS - (Date.now() - t0)));
    }, function (e) {
      if (S !== sess) return;
      stopCamera();
      setStatus('Decoder unavailable' + (navigator.onLine ? '' : ' offline — it needs one online load to cache'), 'bad');
    });
  }

  function loadImageSource(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).then(function (bm) { return { src: bm, w: bm.width, h: bm.height, done: function () { try { bm.close(); } catch (e) {} } }; });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  function scanFile(file) {
    if (!S || !file) return;
    if (!/^image\//.test(file.type || '')) { setStatus('That isn\'t an image', 'bad'); return; }
    if (S.tab !== 'scan') setTab('scan');
    stopCamera();
    setStatus('Reading image…');
    var sess = S;
    loadImageSource(file).then(function (im) {
      // Try full detail first, then a smaller copy (jsQR sometimes locks on
      // better when a huge photo is downscaled).
      return Q.decodeSource(im.src, im.w, im.h, 1400, true, sess).then(function (t) {
        if (t != null || Math.max(im.w, im.h) <= 700) return t;
        return Q.decodeSource(im.src, im.w, im.h, 700, true, sess);
      }).then(function (t) { im.done(); return t; }, function (e) { im.done(); throw e; });
    }).then(function (txt) {
      if (S !== sess) return;
      if (txt != null && txt !== '') showResult(txt);
      else setStatus('No QR code found in that image', 'bad');
    }, function (e) {
      if (S !== sess) return;
      setStatus(/decoder/.test((e && e.message) || '') ? 'Decoder unavailable — needs one online load to cache' : 'Couldn\'t read that image', 'bad');
    });
  }

  function safeHttpUrl(t) {
    var s = String(t).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return null;
    try { var u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null; } catch (e) { return null; }
  }

  function showResult(txt) {
    if (!S) return;
    S.result = txt;
    var box = S.p.querySelector('.qr-result');
    box.hidden = false;
    box.querySelector('.qr-result-text').textContent = txt;
    var a = box.querySelector('.qr-open');
    var url = safeHttpUrl(txt);
    if (url) { a.href = url; a.hidden = false; } else { a.removeAttribute('href'); a.hidden = true; }
    setStatus('Decoded ' + txt.length + ' character' + (txt.length === 1 ? '' : 's'), 'ok');
  }

  function insertResult() {
    if (!S || S.result == null) return;
    var ed = editorWritable();
    if (!ed) return;
    ed.dispatch(ed.state.replaceSelection(S.result), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted', 'success', 1100);
  }

  // ---------------------------------------------------------------- tabs/open
  function setTab(tab) {
    if (!S) return;
    S.tab = tab;
    S.p.querySelectorAll('.qr-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    S.p.querySelector('.qr-gen').hidden = tab !== 'gen';
    S.p.querySelector('.qr-scan').hidden = tab !== 'scan';
    if (tab !== 'scan') stopCamera();
  }

  function cleanup() {
    if (!S) return;
    stopCamera();
    clearTimeout(S.genTimer);
    S = null;
  }
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  // The panel toggles; the first open waits for qr-core.js (a second tap
  // while it loads is ignored rather than queued).
  var opening = false;
  function open() {
    Cade.closeAllMenus();
    if (panel()) { close(); return; }
    if (Q) { build(seedFromEditor()); return; }
    if (opening) return;
    opening = true;
    var seed = seedFromEditor();     // read now: the selection is what was meant
    loadCore().then(function () {
      opening = false;
      if (!panel()) build(seed);
    }, function () {
      opening = false;
      Cade.showToast('QR Code couldn\'t load' + (navigator.onLine === false ? ' offline — it needs one online load to cache' : ''), 'error', 3000);
    });
  }

  function build(seed) {
    loadPrefs();
    if (seed) { lastText = seed; prefs.preset = 'text'; }

    var presetBtns = PRESETS.map(function (pr) {
      return '<button class="qr-preset" data-p="' + pr.id + '" title="' + esc(pr.label) + '"><span aria-hidden="true">' + pr.icon + '</span> ' + esc(pr.label) + '</button>';
    }).join('');
    var p = Cade.mkPanel(PANEL_ID, '▦ QR Code',
      '<div class="qr-tabs" role="tablist">' +
        '<button class="qr-tab on" data-tab="gen" role="tab">Generate</button>' +
        '<button class="qr-tab" data-tab="scan" role="tab">Scan</button>' +
      '</div>' +
      '<div class="qr-gen">' +
        '<div class="qr-presets" role="group" aria-label="Content type">' + presetBtns + '</div>' +
        '<div class="qr-form"></div>' +
        '<div class="qr-preview"><canvas class="qr-canvas" width="10" height="10" aria-label="QR code preview"></canvas></div>' +
        '<div class="qr-info"></div>' +
        '<div class="qr-acts">' +
          '<button class="qr-btn primary" data-act="insert" title="Insert into the document as an image">⤓ Insert</button>' +
          '<button class="qr-btn" data-act="copyimg" title="Copy the PNG image">⧉ Copy image</button>' +
          '<button class="qr-btn" data-act="png" title="Download PNG">↓ PNG</button>' +
          '<button class="qr-btn" data-act="copysvg" title="Copy SVG markup">⧉ SVG</button>' +
          '<button class="qr-btn" data-act="svg" title="Download SVG">↓ SVG</button>' +
        '</div>' +
        '<details class="qr-opts"><summary>Options</summary>' +
          '<div class="qr-row"><span class="qr-lbl" title="Error correction: higher survives more damage but makes a denser code">Error correction</span>' +
            '<span class="qr-seg">' +
              '<button class="qr-ecl" data-e="L" title="Low — ~7% recovery">L</button>' +
              '<button class="qr-ecl" data-e="M" title="Medium — ~15% recovery">M</button>' +
              '<button class="qr-ecl" data-e="Q" title="Quartile — ~25% recovery">Q</button>' +
              '<button class="qr-ecl" data-e="H" title="High — ~30% recovery">H</button>' +
            '</span></div>' +
          '<label class="qr-row"><span class="qr-lbl">Size</span><input class="qr-size" type="range" min="128" max="1024" step="16"><span class="qr-size-v qr-v"></span></label>' +
          '<label class="qr-row"><span class="qr-lbl">Margin</span><input class="qr-margin" type="range" min="0" max="10" step="1"><span class="qr-margin-v qr-v"></span></label>' +
          '<div class="qr-row"><span class="qr-lbl">Colours</span>' +
            '<label class="qr-col" title="Dark modules"><input class="qr-dark" type="color"> Dark</label>' +
            '<label class="qr-col" title="Background"><input class="qr-light" type="color"> Light</label>' +
            '<button class="qr-btn sm" data-act="swap" title="Swap colours">⇄</button>' +
            '<button class="qr-btn sm" data-act="reset" title="Black on white (most scannable)">Reset</button>' +
          '</div>' +
        '</details>' +
      '</div>' +
      '<div class="qr-scan" hidden>' +
        '<div class="qr-acts">' +
          '<button class="qr-btn primary qr-cam-btn" data-act="camera">📷 Scan with camera</button>' +
          '<button class="qr-btn" data-act="pick">🖼 Scan from image</button>' +
          '<input class="qr-file" type="file" accept="image/*" hidden>' +
        '</div>' +
        '<div class="qr-cam" hidden><video class="qr-video" playsinline muted></video><div class="qr-reticle" aria-hidden="true"></div></div>' +
        '<div class="qr-drop" tabindex="0" role="button" aria-label="Paste or drop an image containing a QR code">Paste (Ctrl/⌘+V) or drop an image with a QR code here</div>' +
        '<div class="qr-status" aria-live="polite"></div>' +
        '<div class="qr-result" hidden>' +
          '<div class="qr-result-text"></div>' +
          '<div class="qr-acts">' +
            '<button class="qr-btn primary" data-act="rinsert">⤓ Insert</button>' +
            '<button class="qr-btn" data-act="rcopy">⧉ Copy</button>' +
            '<a class="qr-btn qr-open" target="_blank" rel="noopener noreferrer" hidden>↗ Open link</a>' +
          '</div>' +
        '</div>' +
      '</div>');

    S = { p: p, tab: 'gen', qr: null, stream: null, scanTimer: null, genTimer: null, frame: null, result: null };
    p._onClose = cleanup;

    p.addEventListener('click', function (e) {
      var t = e.target;
      var b = t.closest && t.closest('button, a.qr-btn');
      if (!b || !S) return;
      if (b.classList.contains('qr-tab')) { setTab(b.getAttribute('data-tab')); return; }
      if (b.classList.contains('qr-preset')) {
        prefs.preset = b.getAttribute('data-p'); savePrefs(); renderForm(); regenerate();
        var first = p.querySelector('.qr-form input, .qr-form textarea');
        if (first && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) first.focus();
        return;
      }
      if (b.classList.contains('qr-ecl')) { prefs.ecl = b.getAttribute('data-e'); savePrefs(); renderOpts(); regenerate(); return; }
      switch (b.getAttribute('data-act')) {
        case 'insert': doInsertImage(); break;
        case 'copyimg': doCopyImage(); break;
        case 'png': doDownloadPng(); break;
        case 'copysvg': doCopySvg(); break;
        case 'svg': doDownloadSvg(); break;
        case 'swap': var d = prefs.dark; prefs.dark = prefs.light; prefs.light = d; savePrefs(); renderOpts(); regenerate(); break;
        case 'reset': prefs.dark = '#000000'; prefs.light = '#ffffff'; prefs.margin = 4; savePrefs(); renderOpts(); regenerate(); break;
        case 'camera': if (S.stream) { stopCamera(); setStatus(''); } else startCamera(); break;
        case 'pick': p.querySelector('.qr-file').click(); break;
        case 'rinsert': insertResult(); break;
        case 'rcopy': if (S.result != null) copyText(S.result, 'result'); break;
      }
    });
    // One delegated listener for whichever form is showing (renderForm only
    // swaps innerHTML, so nothing accumulates across preset switches).
    var onField = function (ev) {
      var el = ev.target;
      if (!S || !el || !el.closest || !el.closest('.qr-form')) return;
      if (el.classList.contains('qr-text')) { lastText = el.value; schedule(); return; }
      var k = el.getAttribute('data-k'), f = forms[prefs.preset];
      if (!k || !f) return;
      f[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (k === 'sec') { var pw = p.querySelector('.qr-form [data-k="pass"]'); if (pw) pw.disabled = f.sec === 'nopass'; }
      schedule();
    };
    var form = p.querySelector('.qr-form');
    form.addEventListener('input', onField);
    form.addEventListener('change', onField);
    p.querySelector('.qr-size').addEventListener('input', function (e) {
      prefs.size = +e.target.value; p.querySelector('.qr-size-v').textContent = prefs.size + 'px'; savePrefs(); schedule();
    });
    p.querySelector('.qr-margin').addEventListener('input', function (e) {
      prefs.margin = +e.target.value; p.querySelector('.qr-margin-v').textContent = prefs.margin; savePrefs(); schedule();
    });
    p.querySelector('.qr-dark').addEventListener('input', function (e) { prefs.dark = e.target.value; savePrefs(); schedule(); });
    p.querySelector('.qr-light').addEventListener('input', function (e) { prefs.light = e.target.value; savePrefs(); schedule(); });
    p.querySelector('.qr-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) scanFile(f);
    });
    // Pasted / dropped images decode — handled on the PANEL only, so pasting
    // into the document while the panel is open still embeds as usual.
    p.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); scanFile(f); return; }
        }
      }
    });
    var drop = p.querySelector('.qr-drop');
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) scanFile(f);
    });
    drop.addEventListener('click', function () { drop.focus(); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (S && S.stream) { stopCamera(); setStatus(''); } else close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && S && S.tab === 'gen') { e.preventDefault(); doInsertImage(); }
      e.stopPropagation(); // keep editor/global shortcuts out of the panel's fields
    });

    renderOpts();
    renderForm();
    regenerate();
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(function () {
        var ta = p.querySelector('.qr-text');
        if (ta) { ta.focus(); ta.select(); }
      }, 0);
    }
  }

  Cade.registerWidget({
    name: 'QR Code',
    description: 'Make QR codes (text, URL, Wi-Fi, contact…) — insert, copy or save; scan with the camera or from an image',
    icon: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><path d='M14 14h3v3h-3zM21 14v.01M14 21h.01M17.5 21H21v-3.5'/></svg>",
    tags: 'qr,qr code,qrcode,barcode,2d code,scan,scanner,reader,decode,camera,photo,generate,generator,maker,create,wifi,wi-fi,password,vcard,contact,email,sms,phone,link,url,share,code,png,svg,image',
    open: open,
    // exposed for tests / other modules (the encoder once qr-core.js is in)
    _encode: function (text, ecl, opts) {
      if (!Q && !window.__cadeQRCore) throw new Error('QR core not loaded');
      return (Q || window.__cadeQRCore).encode(text, ecl, opts);
    },
    _payload: buildPayload
  });
})();
