/* Photo Palette — pull the main colours out of a photo and show them as
 * colour cards (extraction and every copied / inserted text: palette-core.js).
 *
 * Sources: Photo… (the file picker offers camera or library on a phone), a
 * live camera (rear camera; a rough palette of a 72 px frame is shown a few
 * times a second, the real one is made from the frozen frame, and the camera
 * is released at once), paste (⌘V on the panel, or 📋 where the clipboard can
 * be read), drop, and the pictures already in the note (![img:…] tokens).
 * A picture is decoded (EXIF orientation applied), kept as a ≤ 720 px preview
 * and analysed at ≤ 200 px.
 *
 * Cards: tap HEX / RGB / HSL / OKLCH to copy that string; tap the swatch to
 * find the colour on the photo (and a marker to find its card); long-press a
 * card (right-click on desktop) or "Copy all" for CSS variables, JSON or a hex
 * list. Insert puts a Markdown "Palette" block at the caret (after the code
 * block when the caret is inside one); PNG saves a swatch strip.
 * Nothing runs until the panel opens; close (and hiding the page or
 * minimizing the panel, for the camera) releases the camera, every timer and
 * listener and the object URLs this widget made. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL ? Cade.baseURL() : './txt/widgets/palette/';
  Cade.loadCSS('palette.css');
  var CORE_URL = BASE + 'palette-core.js';
  var PANEL_ID = 'palette-panel', PREFS_KEY = 'cade-palette-prefs';
  var MAX_PREVIEW = 720, MAX_ANALYSE = 200, LIVE_SIZE = 72, LIVE_MS = 350, MAX_NOTE_IMGS = 12;

  var META = {
    name: 'Photo Palette',
    description: 'Pull the main colours out of a photo or the live camera — colour cards with HEX, RGB and HSL to copy, a palette for your note or a PNG strip',
    icon: '🖌',
    tags: 'palette,colour palette,color palette,colours,colors,extract,photo,picture,image,camera,swatch,swatches,hex,rgb,hsl,oklch,css,design,theme,scheme,copy'
  };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2000); } catch (e) {} }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function isPhone() { try { return window.matchMedia('(max-width: 560px)').matches; } catch (e) { return false; } }

  function loadCore() {
    if (window.__cadePaletteCore) return Promise.resolve(window.__cadePaletteCore);
    if (!window.__cadePaletteCoreP) {
      window.__cadePaletteCoreP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadePaletteCore) res(window.__cadePaletteCore); else { window.__cadePaletteCoreP = null; rej(new Error('missing')); } };
        s.onerror = function () { window.__cadePaletteCoreP = null; rej(new Error('Photo Palette failed to load (offline?)')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadePaletteCoreP;
  }

  var prefs = { k: 6 };
  function loadPrefs() {
    try { var p = JSON.parse(sget(PREFS_KEY) || '{}') || {}; if ([5, 6, 8, 10].indexOf(p.k) >= 0) prefs.k = p.k; } catch (e) {}
  }
  function savePrefs() { sset(PREFS_KEY, JSON.stringify(prefs)); }

  // ---- state (all reset on close) ----
  var P = null, el = {}, PC = null, src = null, colors = [], busy = false, gen = 0;
  var cam = null;            // { stream, timer, small }
  var ownUrls = [];          // object URLs made here (note thumbnails)
  var timers = [];           // "Copied" flashes
  var noteKey = '', noteT = 0, resizeT = 0, lp = null, lpFired = false, hlIdx = -1;

  var ROWS = [['hex', 'HEX'], ['rgb', 'RGB'], ['hsl', 'HSL'], ['oklch', 'OKLCH']];

  function bodyHtml() {
    return '<div class="pp">' +
      '<div class="pp-stage" tabindex="0" role="button" aria-label="Photo — tap to choose one, paste or drop">' +
        '<div class="pp-pic" hidden><canvas class="pp-cv"></canvas><div class="pp-mks"></div></div>' +
        '<div class="pp-live" hidden>' +
          '<video class="pp-video" playsinline muted autoplay></video>' +
          '<div class="pp-live-strip" aria-hidden="true"></div>' +
          '<button type="button" class="pp-freeze" data-act="freeze" title="Freeze this frame and make its palette" aria-label="Freeze this frame"><span></span></button>' +
          '<button type="button" class="pp-live-x" data-act="stop" title="Stop the camera" aria-label="Stop the camera">✕</button>' +
        '</div>' +
        '<div class="pp-empty"><div class="pp-empty-i" aria-hidden="true">🖌</div><b>Choose a photo</b><span>take or pick one · live camera · paste · drop</span></div>' +
        '<div class="pp-dropping">Drop the photo here</div>' +
      '</div>' +
      '<div class="pp-row">' +
        '<button type="button" class="pp-btn" data-act="pick">📷 Photo…</button>' +
        '<button type="button" class="pp-btn" data-act="live" title="Live camera — freeze a frame to make its palette">◉ Live</button>' +
        '<button type="button" class="pp-btn" data-act="paste" title="Paste a copied image">📋 Paste</button>' +
      '</div>' +
      '<div class="pp-note" hidden><span class="pp-l">In note</span><div class="pp-strip"></div></div>' +
      '<input type="file" accept="image/*" class="pp-file" tabindex="-1" aria-hidden="true">' +
      '<div class="pp-row pp-krow"><span class="pp-l">Colours</span><div class="pp-seg" role="group" aria-label="How many colours">' +
        [5, 6, 8, 10].map(function (n) { return '<button type="button" class="pp-sb" data-k="' + n + '">' + n + '</button>'; }).join('') +
      '</div><span class="pp-meta" aria-live="polite"></span></div>' +
      '<div class="pp-cards" aria-live="polite"><div class="pp-none">The colours of your photo appear here as cards — tap a code to copy it.</div></div>' +
      '<div class="pp-foot">' +
        '<input type="text" class="pp-cap" maxlength="80" placeholder="Caption (optional)" autocomplete="off" aria-label="Caption">' +
        '<div class="pp-acts">' +
          '<button type="button" class="pp-btn pp-go" data-act="insert" title="Insert the palette at the cursor">↧ Insert<span class="pp-wide"> into note</span></button>' +
          '<button type="button" class="pp-btn" data-act="menu" title="Copy every colour at once" aria-haspopup="menu">Copy all ⋯</button>' +
          '<button type="button" class="pp-btn" data-act="png" title="Download the palette as a PNG strip">PNG</button>' +
        '</div>' +
      '</div>' +
      '<div class="pp-menu" role="menu" hidden>' +
        '<button type="button" role="menuitem" data-all="css">Copy as CSS variables</button>' +
        '<button type="button" role="menuitem" data-all="json">Copy as JSON</button>' +
        '<button type="button" role="menuitem" data-all="hex">Copy hex list</button>' +
      '</div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }
  // status line; `extra` (timings) is dropped on a phone
  function setMeta(t, extra) {
    if (!el.meta) return;
    el.meta.textContent = t || '';
    if (extra) { var s = document.createElement('span'); s.className = 'pp-ms'; s.textContent = ' · ' + extra; el.meta.appendChild(s); }
  }
  function paintK() {
    var bs = P.querySelectorAll('[data-k]');
    for (var i = 0; i < bs.length; i++) {
      var on = +bs[i].getAttribute('data-k') === prefs.k;
      bs[i].classList.toggle('on', on);
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  // which of empty / picture / live the stage shows
  function stageMode(m) {
    P.setAttribute('data-stage', m);
    el.pic.hidden = m !== 'pic';
    el.live.hidden = m !== 'live';
  }

  // ---- getting a picture in ----
  function isImage(f) { return !!f && (/^image\//.test(f.type || '') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(f.name || '')); }
  function viaImg(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { res({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); img.src = ''; } }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  function decodeImage(blob) {
    if (typeof createImageBitmap !== 'function') return viaImg(blob);
    function wrap(b) { return { src: b, w: b.width, h: b.height, done: function () { try { b.close(); } catch (e) {} } }; }
    return createImageBitmap(blob, { imageOrientation: 'from-image' }).then(wrap, function () {
      return createImageBitmap(blob).then(wrap);
    }).catch(function () { return viaImg(blob); });
  }
  // Halve until close, then one smooth step: a canvas of at most max px.
  function shrinkTo(source, w, h, max) {
    var s = Math.min(1, max / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    var cur = source, cw = w, ch = h, tmp = null;
    while (cw > tw * 2 && ch > th * 2) {
      var nw = Math.round(cw / 2), nh = Math.round(ch / 2), c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      var cx = c.getContext('2d'); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, nw, nh);
      if (tmp) tmp.width = tmp.height = 0;
      cur = tmp = c; cw = nw; ch = nh;
    }
    var f = document.createElement('canvas');
    f.width = tw; f.height = th;
    var fx = f.getContext('2d', { willReadFrequently: true });
    fx.imageSmoothingEnabled = true; fx.imageSmoothingQuality = 'high';
    fx.drawImage(cur, 0, 0, tw, th);
    if (tmp) tmp.width = tmp.height = 0;
    return f;
  }
  function pixels(cv) { return cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; }

  function takeBlob(blob) {
    if (!P) return;
    if (!isImage(blob)) { toast('That isn’t a picture', 'error'); return; }
    if (busy) return;
    busy = true;
    var g = ++gen;
    setMeta('reading…');
    Promise.all([loadCore(), decodeImage(blob)]).then(function (r) {
      PC = r[0];
      var im = r[1], cv;
      try { cv = shrinkTo(im.src, im.w, im.h, MAX_PREVIEW); } finally { im.done(); }
      busy = false;
      if (!P || g !== gen) { cv.width = cv.height = 0; return; }
      setSource(cv);
    }).catch(function (e) {
      busy = false;
      setMeta('');
      toast(/load/.test(e && e.message) ? e.message : 'Couldn’t read that picture', 'error', 2600);
    });
  }
  // The preview canvas becomes the stage picture; the analysis copy is small.
  function setSource(cv) {
    if (cam) stopCamera();
    var old = el.cv;
    cv.className = 'pp-cv';
    old.parentNode.replaceChild(cv, old);
    if (old) old.width = old.height = 0;
    el.cv = cv;
    var a = shrinkTo(cv, cv.width, cv.height, MAX_ANALYSE);
    src = { data: pixels(a), w: a.width, h: a.height, pw: cv.width, ph: cv.height };
    a.width = a.height = 0;
    stageMode('pic');
    P.classList.add('pp-has');
    fit();
    analyse();
  }
  function analyse() {
    if (!P || !src || !PC) return;
    var t0 = performance.now();
    var res = PC.extract(src.data, src.w, src.h, { k: prefs.k });
    colors = res.colors;
    hlIdx = -1;
    renderCards();
    renderMarkers();
    setMeta(colors.length + ' colour' + (colors.length === 1 ? '' : 's'), Math.round(performance.now() - t0) + ' ms');
  }
  function fit() {
    if (!P || !src || !el.cv) return;
    var sw = Math.max(120, el.stage.clientWidth - 4);
    var maxH = isPhone() ? Math.max(130, Math.min(180, window.innerHeight * 0.24)) : 280;
    var s = Math.min(sw / src.pw, maxH / src.ph);
    el.cv.style.width = Math.round(src.pw * s) + 'px';
    el.cv.style.height = Math.round(src.ph * s) + 'px';
  }

  function pasteButton() {
    var cb = navigator.clipboard;
    if (!cb || !cb.read) { toast('Copy a picture, then press ' + (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V') + ' on the photo area', 'info', 2800); el.stage.focus(); return; }
    cb.read().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var types = items[i].types || [];
        for (var j = 0; j < types.length; j++) {
          if (/^image\//.test(types[j])) {
            var t = types[j];
            return items[i].getType(t).then(function (blob) { takeBlob(new File([blob], 'pasted', { type: blob.type || t })); });
          }
        }
      }
      toast('No picture on the clipboard', 'info');
    }).catch(function () { toast('Couldn’t read the clipboard — try ⌘V / Ctrl+V on the photo area', 'info', 2800); });
  }
  function onPaste(e) {
    var cd = e.clipboardData, items = cd && cd.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); e.stopPropagation(); takeBlob(f); return; }
      }
    }
  }
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
  var dragN = 0;
  function onDragEnter(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dragN++; P.classList.add('pp-drag'); }
  function onDragOver(e) { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {} }
  function onDragLeave(e) { if (!hasFiles(e)) return; e.stopPropagation(); dragN = Math.max(0, dragN - 1); if (!dragN) P.classList.remove('pp-drag'); }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragN = 0; P.classList.remove('pp-drag');
    try { window.dispatchEvent(new Event('dragleave')); } catch (x) {}   // let the app's own drop overlay reset
    var fs = e.dataTransfer.files;
    for (var i = 0; i < fs.length; i++) if (isImage(fs[i])) { takeBlob(fs[i]); return; }
    toast('That isn’t a picture', 'error');
  }

  // ---- pictures already in the note ----
  var IMG_RE = /!\[img:(?:([jwa])([:#]))?([A-Za-z0-9+/=]+)(?:\|w(\d{2,4}))?\]/g;
  var MIME = { j: 'image/jpeg', w: 'image/webp', a: 'image/avif' };
  function noteImages() {
    var ed = Cade.editor, out = [], seen = {};
    if (!ed) return out;
    var t = ed.state.doc.toString();
    if (t.indexOf('![img:') < 0) return out;
    IMG_RE.lastIndex = 0;
    var m;
    while ((m = IMG_RE.exec(t)) !== null && out.length < MAX_NOTE_IMGS) {
      var ref = m[2] === '#', key = ref ? m[3] : m[3].slice(0, 48) + m[3].length;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ code: m[1] || 'j', ref: ref, data: m[3], key: key });
    }
    return out;
  }
  function inlineUrl(code, b64) {
    try {
      var bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var u = URL.createObjectURL(new Blob([bytes], { type: MIME[code] || 'image/jpeg' }));
      ownUrls.push(u);
      return u;
    } catch (e) { return null; }
  }
  function refreshNote(force) {
    if (!P) return;
    var list = noteImages(), key = list.map(function (x) { return x.key; }).join(',');
    if (!force && key === noteKey) return;
    noteKey = key;
    ownUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    ownUrls = [];
    el.strip.innerHTML = '';
    el.note.hidden = true;
    list.forEach(function (it) {
      var got = it.ref
        ? (typeof window.resolveImageRef === 'function' ? Promise.resolve(window.resolveImageRef(it.code, it.data)).then(function (r) { return r && r.url; }, function () { return null; }) : Promise.resolve(null))
        : Promise.resolve(inlineUrl(it.code, it.data));
      got.then(function (url) {
        if (!url || !P || noteKey !== key) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pp-ni';
        b.title = 'Use this picture from the note';
        b.setAttribute('data-url', url);
        var img = document.createElement('img');
        img.alt = 'Picture in the note';
        img.decoding = 'async';
        img.src = url;
        b.appendChild(img);
        el.strip.appendChild(b);
        el.note.hidden = false;
      });
    });
  }
  // blob: / data: URLs only (the core's own and ours) — no network
  function useUrl(url) {
    if (!/^(blob|data):/.test(url)) return;
    fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      takeBlob(b.type ? b : new File([b], 'note-image.jpg', { type: 'image/jpeg' }));
    }).catch(function () { toast('Couldn’t read that picture', 'error'); });
  }
  function onEditorUpdate(u) {
    if (!P || !u.docChanged) return;
    clearTimeout(noteT);
    noteT = setTimeout(function () { refreshNote(false); }, 800);
  }

  // ---- live camera ----
  function startCamera() {
    if (!P || cam) return;
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      toast(window.isSecureContext === false ? 'The camera needs a secure (https) page' : 'No camera access in this browser', 'error', 2600);
      return;
    }
    var mine = cam = { stream: null, timer: 0, small: null, pending: true };
    setMeta('starting camera…');
    loadCore().then(function (c) { PC = c; }, function () {});
    md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        if (cam !== mine || !P) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        mine.stream = stream;
        mine.pending = false;
        var v = el.video;
        v.srcObject = stream;
        v.muted = true;
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {});
        stageMode('live');
        el.liveStrip.innerHTML = '';
        setMeta('live');
        mine.timer = setTimeout(liveTick, LIVE_MS);
      }, function (err) {
        if (cam === mine) cam = null;
        setMeta('');
        var n = err && err.name;
        toast(n === 'NotAllowedError' || n === 'SecurityError' ? 'Camera permission was denied'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera found'
          : n === 'NotReadableError' ? 'The camera is busy in another app'
          : 'Could not start the camera', 'error', 2600);
      });
  }
  // A rough palette of a tiny frame, a few times a second, never while hidden.
  function liveTick() {
    if (!cam || !cam.stream || !P) return;
    cam.timer = setTimeout(liveTick, LIVE_MS);
    var v = el.video;
    if (document.hidden || (Cade.isMinimized && Cade.isMinimized(P)) || !PC || !v.videoWidth || v.readyState < 2) return;
    var s = Math.min(1, LIVE_SIZE / Math.max(v.videoWidth, v.videoHeight)), w = Math.max(1, Math.round(v.videoWidth * s)), h = Math.max(1, Math.round(v.videoHeight * s));
    var c = cam.small || (cam.small = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(v, 0, 0, w, h);
    var res = PC.extract(x.getImageData(0, 0, w, h).data, w, h, { k: prefs.k, iters: 6 });
    el.liveStrip.innerHTML = res.colors.map(function (col) {
      return '<span style="background:' + col.hex + ';flex-grow:' + Math.max(0.04, col.share).toFixed(3) + '"></span>';
    }).join('');
  }
  function freeze() {
    var v = el.video;
    if (!cam || !cam.stream || !v.videoWidth) { toast('The camera isn’t ready yet', 'info', 1400); return; }
    var s = Math.min(1, MAX_PREVIEW / Math.max(v.videoWidth, v.videoHeight));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * s)); c.height = Math.max(1, Math.round(v.videoHeight * s));
    var x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(v, 0, 0, c.width, c.height);
    try { Cade.haptic(20); } catch (e) {}
    gen++;
    loadCore().then(function (core) { PC = core; if (P) setSource(c); }, function (e) { toast(e.message, 'error'); });
  }
  function stopCamera() {
    if (!cam) return;
    clearTimeout(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    if (cam.small) cam.small.width = cam.small.height = 0;
    cam = null;
    if (el.video) { try { el.video.pause(); } catch (e) {} el.video.srcObject = null; }
    if (P) { stageMode(src ? 'pic' : 'empty'); if (el.meta && /live|camera/.test(el.meta.textContent)) setMeta(''); }
  }
  function onVisibility() {
    if (document.hidden && cam) { stopCamera(); setMeta('camera stopped'); }
  }

  // ---- cards & markers ----
  function renderCards() {
    if (!colors.length) { el.cards.innerHTML = '<div class="pp-none">No colours found — is the picture transparent?</div>'; return; }
    el.cards.innerHTML = colors.map(function (c, i) {
      return '<div class="pp-card" data-i="' + i + '" style="--pp-c:' + c.hex + ';--pp-t:' + c.text + '">' +
        '<button type="button" class="pp-sw" data-sw="' + i + '" title="Show where it is on the photo" aria-label="' + esc(c.name + ', ' + PC.pct(c.share) + ' — show it on the photo') + '">' +
          '<span class="pp-n">' + (i + 1) + '</span><b class="pp-name">' + esc(c.name) + '</b><span class="pp-share">' + PC.pct(c.share) + '</span>' +
        '</button>' +
        ROWS.map(function (r) {
          return '<button type="button" class="pp-cp" data-copy="' + r[0] + '" data-i="' + i + '" title="Copy ' + esc(c[r[0]]) + '">' +
            '<span class="pp-k">' + r[1] + '</span><span class="pp-v">' + esc(c[r[0]]) + '</span></button>';
        }).join('') +
      '</div>';
    }).join('');
  }
  function renderMarkers() {
    el.mks.innerHTML = colors.map(function (c, i) {
      return '<button type="button" class="pp-mk" data-mk="' + i + '" style="left:' + (c.x * 100).toFixed(2) + '%;top:' + (c.y * 100).toFixed(2) + '%;--pp-c:' + c.hex + '" title="' + esc(c.name + ' ' + c.hex) + '" aria-label="' + esc('Colour ' + (i + 1) + ', ' + c.name) + '"><span></span></button>';
    }).join('');
  }
  function highlight(i, fromMarker) {
    hlIdx = i;
    var cs = el.cards.querySelectorAll('.pp-card'), ms = el.mks.querySelectorAll('.pp-mk');
    for (var j = 0; j < cs.length; j++) cs[j].classList.toggle('pp-hl', j === i);
    for (j = 0; j < ms.length; j++) ms[j].classList.toggle('pp-hl', j === i);
    if (fromMarker && cs[i]) { try { cs[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { cs[i].scrollIntoView(false); } }
  }

  // ---- copying ----
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) res(); else rej(new Error('copy failed'));
    });
  }
  function copy(s, label, row) {
    copyText(s).then(function () {
      if (row && P) {
        row.classList.add('pp-ok');
        timers.push(setTimeout(function () { row.classList.remove('pp-ok'); }, 900));
      }
      try { Cade.haptic(10); } catch (e) {}
      toast('Copied ' + (label || s), 'success', 1400);
    }, function () { toast('Copy failed', 'error'); });
  }
  function copyAll(kind) {
    if (needColors()) return;
    if (kind === 'css') copy(PC.cssVars(colors), 'as CSS variables');
    else if (kind === 'json') copy(PC.jsonArray(colors), 'as JSON');
    else copy(PC.hexList(colors), colors.length + ' hex codes');
  }
  function needColors() { if (!colors.length) { toast('Choose a photo first', 'info'); return true; } return false; }

  // ---- the "copy all" menu (⋯ button, long-press or right-click on a card) ----
  function openMenu(anchor, x, y) {
    if (needColors()) return;
    var m = el.menu;
    m.hidden = false;
    var r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
    var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = x != null ? x : r.right - mw, top = y != null ? y : r.top - mh - 6;
    if (top < 8) top = (anchor ? r.bottom + 6 : y + 6);
    left = Math.max(8, Math.min(vw - mw - 8, left));
    top = Math.max(8, Math.min(vh - mh - 8, top));
    m.style.left = left + 'px'; m.style.top = top + 'px';
    var first = m.querySelector('button');
    if (first && !isPhone()) first.focus();
    document.addEventListener('pointerdown', onDocDown, true);
  }
  function closeMenu() {
    if (!el.menu || el.menu.hidden) return;
    el.menu.hidden = true;
    document.removeEventListener('pointerdown', onDocDown, true);
  }
  function onDocDown(e) { if (el.menu && !el.menu.contains(e.target)) closeMenu(); }
  function onPointerDown(e) {
    var card = e.target.closest ? e.target.closest('.pp-card') : null;
    lpFired = false;   // iOS sends no click after a long press: never swallow a later tap
    if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var sx = e.clientX, sy = e.clientY;
    cancelLp();
    lp = { x: sx, y: sy, t: setTimeout(function () { lp = null; lpFired = true; try { Cade.haptic(15); } catch (x) {} openMenu(null, sx, sy); }, 520) };
  }
  function onPointerMove(e) { if (lp && Math.abs(e.clientX - lp.x) + Math.abs(e.clientY - lp.y) > 10) cancelLp(); }
  function cancelLp() { if (lp) { clearTimeout(lp.t); lp = null; } }
  function onContextMenu(e) {
    var card = e.target.closest ? e.target.closest('.pp-card') : null;
    if (!card) return;
    e.preventDefault();
    cancelLp();
    openMenu(null, e.clientX, e.clientY);
  }

  // ---- note & PNG ----
  function insert() {
    if (needColors()) return;
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var st = ed.state, sel = st.selection.main;
    var plan = PC.insertPlan(st.doc.toString(), sel.from, sel.to, PC.noteBlock(colors, el.cap.value));
    ed.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: { anchor: plan.cursor }, userEvent: 'input.paste', scrollIntoView: true });
    toast('Palette inserted', 'success', 1400);
    if (isPhone() && Cade.minimizePanel) Cade.minimizePanel(P);
  }
  function savePng() {
    if (needColors()) return;
    var sz = PC.stripSize(colors.length), c = document.createElement('canvas');
    c.width = sz.width; c.height = sz.height;
    var mono = '';
    try { mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(); } catch (e) {}
    PC.drawStrip(c.getContext('2d'), colors, { caption: el.cap.value, mono: mono || undefined });
    var name = PC.pngName(el.cap.value);
    c.toBlob(function (blob) {
      c.width = c.height = 0;
      if (!blob) { toast('Couldn’t make the picture', 'error'); return; }
      if (Cade.files && Cade.files.save) Cade.files.save(blob, name);
      else {
        var u = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 0);
      }
      toast('Palette saved as a PNG', 'success', 1400);
    }, 'image/png');
  }

  // ---- events ----
  function onClick(e) {
    if (lpFired) { lpFired = false; e.preventDefault(); e.stopPropagation(); return; }
    var b = e.target.closest ? e.target.closest('button,.pp-stage') : null;
    if (!b || !P.contains(b)) return;
    if (b.classList.contains('pp-stage')) { if (P.getAttribute('data-stage') === 'empty') el.file.click(); return; }
    if (b.hasAttribute('data-all')) { closeMenu(); copyAll(b.getAttribute('data-all')); return; }
    if (b.hasAttribute('data-copy')) {
      var c = colors[+b.getAttribute('data-i')], k = b.getAttribute('data-copy');
      if (c) copy(c[k], null, b);
      return;
    }
    if (b.hasAttribute('data-sw')) { highlight(+b.getAttribute('data-sw'), false); return; }
    if (b.hasAttribute('data-mk')) { highlight(+b.getAttribute('data-mk'), true); return; }
    if (b.hasAttribute('data-k')) {
      prefs.k = +b.getAttribute('data-k');
      savePrefs(); paintK(); analyse();
      return;
    }
    if (b.hasAttribute('data-url')) { useUrl(b.getAttribute('data-url')); return; }
    var a = b.getAttribute('data-act');
    if (a === 'pick') el.file.click();
    else if (a === 'live') { if (cam) stopCamera(); else startCamera(); }
    else if (a === 'freeze') freeze();
    else if (a === 'stop') stopCamera();
    else if (a === 'paste') pasteButton();
    else if (a === 'insert') insert();
    else if (a === 'png') savePng();
    else if (a === 'menu') { if (el.menu.hidden) openMenu(b); else closeMenu(); }
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      if (!el.menu.hidden) { e.preventDefault(); closeMenu(); return; }
      if (!(e.target === el.cap && el.cap.value)) { e.preventDefault(); close(); return; }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el.stage) { e.preventDefault(); if (P.getAttribute('data-stage') === 'empty') el.file.click(); }
    if (e.target === el.cap) e.stopPropagation();   // keep editor shortcuts out of the caption
  }
  function onFile() {
    var f = el.file.files && el.file.files[0];
    if (f) takeBlob(f);
    el.file.value = '';
  }
  function onMin() { stopCamera(); closeMenu(); }
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { fit(); closeMenu(); }, 150); }

  function cleanup() {
    stopCamera();
    closeMenu();
    cancelLp();
    clearTimeout(noteT); clearTimeout(resizeT);
    timers.forEach(clearTimeout); timers = [];
    try { Cade.offEditorUpdate(onEditorUpdate); } catch (e) {}
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerdown', onDocDown, true);
    ownUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    ownUrls = [];
    if (el.cv) el.cv.width = el.cv.height = 0;
    gen++;
    P = null; el = {}; src = null; colors = []; busy = false; dragN = 0; noteKey = ''; lpFired = false; hlIdx = -1;
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
    try { if (!isPhone()) Cade.editor.focus(); } catch (e) {}
  }
  function open() {
    try { Cade.closeAllMenus(); } catch (e) {}
    if (document.getElementById(PANEL_ID)) { close(); return; }
    loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '🖌 Photo Palette', bodyHtml());
    P._onClose = cleanup;
    el = {
      stage: q('.pp-stage'), pic: q('.pp-pic'), cv: q('.pp-cv'), mks: q('.pp-mks'), live: q('.pp-live'), video: q('.pp-video'),
      liveStrip: q('.pp-live-strip'), file: q('.pp-file'), meta: q('.pp-meta'), note: q('.pp-note'), strip: q('.pp-strip'),
      cards: q('.pp-cards'), cap: q('.pp-cap'), menu: q('.pp-menu')
    };
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) q('[data-act="live"]').hidden = true;
    P.addEventListener('click', onClick);
    P.addEventListener('keydown', onKey);
    P.addEventListener('paste', onPaste);
    P.addEventListener('dragenter', onDragEnter);
    P.addEventListener('dragover', onDragOver);
    P.addEventListener('dragleave', onDragLeave);
    P.addEventListener('drop', onDrop);
    P.addEventListener('pointerdown', onPointerDown);
    P.addEventListener('pointermove', onPointerMove);
    P.addEventListener('pointerup', cancelLp);
    P.addEventListener('pointercancel', cancelLp);
    P.addEventListener('contextmenu', onContextMenu);
    P.addEventListener('cade-panel-minimize', onMin);
    P.addEventListener('scroll', closeMenu, true);
    el.file.addEventListener('change', onFile);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    Cade.onEditorUpdate(onEditorUpdate);
    stageMode('empty');
    paintK();
    refreshNote(true);
    loadCore().then(function (c) { PC = c; }, function () {});
  }

  Cade.registerWidget({
    name: META.name, description: META.description, icon: META.icon, tags: META.tags,
    open: open, close: close
  });
})();
