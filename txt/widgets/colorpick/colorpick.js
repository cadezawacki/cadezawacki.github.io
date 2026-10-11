/* Color Picker — a floating panel with a native colour input, an on-screen
 * eyedropper (EyeDropper API: Chrome / Edge desktop), a pick-from-screen
 * mode (screen capture snapshot, reaches other apps), any-CSS-colour entry,
 * HEX / RGB / HSL readouts that copy or insert at the cursor, and a short
 * list of recent picks. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('colorpick.css');

  var PANEL_ID = 'colorpick-panel';
  var RECENT_KEY = 'cade-colorpick-recent';
  var MAX_RECENT = 12;
  var cur = { r: 59, g: 130, b: 246, a: 1 };
  var ctx = null;

  // Any CSS colour → {r,g,b,a} via canvas normalisation (null if rejected).
  function parse(str) {
    str = String(str || '').trim();
    if (!str) return null;
    try {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = '#010203'; ctx.fillStyle = str; var a1 = ctx.fillStyle;
      ctx.fillStyle = '#040506'; ctx.fillStyle = str; var a2 = ctx.fillStyle;
      if (a1 !== a2) return null;
      var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a1);
      if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
      m = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/i.exec(a1);
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
    } catch (e) {}
    return null;
  }
  function hex2(n) { return ('0' + Math.round(n).toString(16)).slice(-2); }
  function toHex(c) {
    return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 1 ? hex2(c.a * 255) : '');
  }
  function round(n, d) { var p = Math.pow(10, d || 0); return Math.round(n * p) / p; }
  function toRgb(c) {
    return c.a < 1 ? 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + round(c.a, 2) + ')'
                   : 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')';
  }
  function toHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    var body = Math.round(h) + ', ' + Math.round(s * 100) + '%, ' + Math.round(l * 100) + '%';
    return c.a < 1 ? 'hsla(' + body + ', ' + round(c.a, 2) + ')' : 'hsl(' + body + ')';
  }
  function lum(c) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function loadRecent() {
    try { var a = JSON.parse(Cade.store.get(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.slice(0, MAX_RECENT) : []; }
    catch (e) { return []; }
  }
  function pushRecent(hex) {
    var a = loadRecent().filter(function (h) { return h.toLowerCase() !== hex.toLowerCase(); });
    a.unshift(hex);
    try { Cade.store.set(RECENT_KEY, JSON.stringify(a.slice(0, MAX_RECENT))); } catch (e) {}
  }

  function copy(text) {
    var done = function () { Cade.showToast('Copied ' + text, 'success', 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { Cade.showToast('Copy failed', 'error', 2000); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { Cade.showToast('Copy failed', 'error', 2000); }
      ta.remove();
    }
  }
  function insert(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input' });
    pushRecent(toHex(cur)); renderRecent();
    Cade.showToast('Inserted ' + text, 'success', 1400);
  }

  function setColor(c, opts) {
    if (!c) return;
    cur = { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a == null ? 1 : c.a };
    render(opts || {});
  }

  function render(opts) {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var hex = toHex(cur);
    var sw = p.querySelector('.cp-swatch');
    sw.style.background = toRgb(cur);
    // Judge translucent colours as they render: composited over the panel.
    var bg = null;
    try { bg = parse(getComputedStyle(p).backgroundColor); } catch (e) {}
    if (!bg || bg.a === 0) bg = { r: 255, g: 255, b: 255 };
    var seen = {
      r: cur.r * cur.a + bg.r * (1 - cur.a),
      g: cur.g * cur.a + bg.g * (1 - cur.a),
      b: cur.b * cur.a + bg.b * (1 - cur.a),
    };
    sw.style.color = lum(seen) < 0.179 ? '#fff' : '#000';
    sw.textContent = hex.toUpperCase();
    p.querySelector('.cp-native').value = hex.slice(0, 7);
    if (!opts.fromText) p.querySelector('.cp-text').value = hex;
    p.querySelector('[data-fmt="hex"] .cp-val').textContent = hex;
    p.querySelector('[data-fmt="rgb"] .cp-val').textContent = toRgb(cur);
    p.querySelector('[data-fmt="hsl"] .cp-val').textContent = toHsl(cur);
  }
  function renderRecent() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var box = p.querySelector('.cp-recent');
    var list = loadRecent();
    box.innerHTML = list.length ? '' : '<span class="cp-empty">Picked colours show up here</span>';
    list.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'cp-chip';
      b.title = h;
      b.style.background = h;
      b.addEventListener('click', function () { setColor(parse(h)); });
      box.appendChild(b);
    });
  }

  function eyedrop() {
    if (!('EyeDropper' in window)) {
      Cade.showToast('Eyedropper isn\'t supported in this browser — try Chrome or Edge on desktop', 'error', 3200);
      return;
    }
    var p = document.getElementById(PANEL_ID);
    if (p) p.classList.add('cp-picking');
    new window.EyeDropper().open().then(function (res) {
      var c = parse(res && res.sRGBHex);
      if (c) { setColor(c); pushRecent(toHex(c)); renderRecent(); }
    }).catch(function () { /* cancelled with Esc */ }).then(function () {
      if (p) p.classList.remove('cp-picking');
    });
  }

  // ---- Pick from screen -------------------------------------------------
  // The EyeDropper API can't always reach outside the browser window (it
  // depends on the browser and OS). Screen capture can: the browser asks which
  // screen or window to share, we grab ONE frame and stop the capture straight
  // away, then show that still full-size with a magnifier; a click picks the
  // pixel. Choosing an app's window in the "Window" tab captures it even when
  // the browser is covering it. Desktop Chrome / Edge / Firefox; not iOS.
  var canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  function grabFrame(stream) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      var done = false;
      var snap = function () {
        if (done) return;
        if (!v.videoWidth) { setTimeout(snap, 50); return; }
        done = true;
        var c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        resolve(c);
      };
      v.play().then(function () {
        // The first frame can be blank; wait for a couple of real ones.
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(function () { v.requestVideoFrameCallback(snap); });
        else setTimeout(snap, 250);
        setTimeout(snap, 1500); // fallback if frame callbacks never fire
      }).catch(reject);
    });
  }

  function pickFromScreen() {
    if (!canCapture) {
      Cade.showToast('Screen capture isn\'t available here — try Chrome or Edge on desktop', 'error', 3200);
      return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' })
      .then(function (stream) {
        var stop = function () { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); };
        return grabFrame(stream).then(function (c) { stop(); showSnapshot(c); }, function (err) { stop(); throw err; });
      })
      .catch(function (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // user cancelled
        Cade.showToast('Couldn\'t capture the screen', 'error', 2500);
      });
  }

  function showSnapshot(src) {
    var W = src.width, H = src.height;
    var data = src.getContext('2d').getImageData(0, 0, W, H).data;
    var px = function (x, y) {
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
      var i = (y * W + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: 1 };
    };

    var ov = document.createElement('div');
    ov.className = 'cp-snap';
    ov.tabIndex = -1;
    src.className = 'cp-snap-img';
    ov.appendChild(src);
    var hint = document.createElement('div');
    hint.className = 'cp-snap-hint';
    hint.textContent = 'Click a pixel to pick it · arrow keys nudge · Enter picks · Esc cancels';
    ov.appendChild(hint);
    var LOUPE = 15, ZOOM = 10; // 15×15 source pixels at 10×
    var loupe = document.createElement('div');
    loupe.className = 'cp-loupe';
    var lc = document.createElement('canvas');
    lc.width = lc.height = LOUPE * ZOOM;
    var lab = document.createElement('div');
    lab.className = 'cp-loupe-lab';
    loupe.appendChild(lc); loupe.appendChild(lab);
    ov.appendChild(loupe);
    document.body.appendChild(ov);
    var lctx = lc.getContext('2d');
    lctx.imageSmoothingEnabled = false;

    var sx = W >> 1, sy = H >> 1, cx = 0, cy = 0;
    // Map a client point to a source pixel via the displayed canvas rect.
    var toSrc = function (clientX, clientY) {
      var r = src.getBoundingClientRect();
      sx = Math.floor((clientX - r.left) * W / r.width);
      sy = Math.floor((clientY - r.top) * H / r.height);
    };
    var draw = function () {
      var half = LOUPE >> 1;
      lctx.clearRect(0, 0, lc.width, lc.height);
      lctx.drawImage(src, sx - half, sy - half, LOUPE, LOUPE, 0, 0, lc.width, lc.height);
      lctx.strokeStyle = '#fff'; lctx.lineWidth = 2;
      lctx.strokeRect(half * ZOOM, half * ZOOM, ZOOM, ZOOM);
      lctx.strokeStyle = '#000'; lctx.lineWidth = 1;
      lctx.strokeRect(half * ZOOM - 1.5, half * ZOOM - 1.5, ZOOM + 3, ZOOM + 3);
      var c = px(sx, sy);
      lab.textContent = toHex(c).toUpperCase();
      lab.style.background = toHex(c);
      lab.style.color = lum(c) < 0.179 ? '#fff' : '#000';
      // Keep the loupe beside the cursor and on screen.
      var size = lc.width + 8;
      var lx = cx + 24, ly = cy + 24;
      if (lx + size > window.innerWidth) lx = cx - size - 24;
      if (ly + size + 28 > window.innerHeight) ly = cy - size - 52;
      loupe.style.left = Math.max(4, lx) + 'px';
      loupe.style.top = Math.max(4, ly) + 'px';
    };
    var close = function () {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
    };
    var pick = function () {
      var c = px(sx, sy);
      close();
      setColor(c); pushRecent(toHex(c)); renderRecent();
      Cade.showToast('Picked ' + toHex(c), 'success', 1400);
    };
    var onKey = function (e) {
      var step = e.shiftKey ? 10 : 1, moved = true;
      if (e.key === 'Escape') { close(); }
      else if (e.key === 'Enter') { pick(); }
      else if (e.key === 'ArrowLeft') sx -= step;
      else if (e.key === 'ArrowRight') sx += step;
      else if (e.key === 'ArrowUp') sy -= step;
      else if (e.key === 'ArrowDown') sy += step;
      else moved = false;
      if (e.key === 'Escape' || e.key === 'Enter' || moved) { e.preventDefault(); e.stopPropagation(); }
      if (moved && e.key.indexOf('Arrow') === 0) {
        sx = Math.max(0, Math.min(W - 1, sx)); sy = Math.max(0, Math.min(H - 1, sy));
        draw();
      }
    };
    ov.addEventListener('pointermove', function (e) { cx = e.clientX; cy = e.clientY; toSrc(cx, cy); draw(); });
    ov.addEventListener('click', function (e) { if (e.target === src) { toSrc(e.clientX, e.clientY); pick(); } });
    ov.addEventListener('contextmenu', function (e) { e.preventDefault(); close(); });
    document.addEventListener('keydown', onKey, true);
    cx = window.innerWidth / 2; cy = window.innerHeight / 2;
    draw();
    ov.focus();
  }

  function row(fmt, label) {
    return '<div class="cp-row" data-fmt="' + fmt + '"><span class="cp-lbl">' + label + '</span>' +
      '<code class="cp-val"></code>' +
      '<button class="cp-btn" data-act="copy" title="Copy">Copy</button>' +
      '<button class="cp-btn" data-act="insert" title="Insert at cursor">Insert</button></div>';
  }

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    var hasDropper = 'EyeDropper' in window;
    var p = Cade.mkPanel(PANEL_ID, '🎨 Color Picker',
      '<div class="cp-top">' +
        '<div class="cp-swatch"></div>' +
        '<div class="cp-tools">' +
          '<button class="cp-btn cp-drop"' + (hasDropper ? '' : ' disabled title="Needs Chrome or Edge on desktop"') + '>🎯 Eyedropper</button>' +
          (canCapture ? '<button class="cp-btn cp-screen" title="Pick from anywhere on screen. In the share prompt, choose Entire screen, or an app under Window (works even if the browser covers it).">🖥 Pick from screen</button>' : '') +
          '<label class="cp-btn cp-native-wrap" title="Open the system colour picker">🎨 Palette<input type="color" class="cp-native"></label>' +
        '</div>' +
      '</div>' +
      '<input class="cp-text" type="text" spellcheck="false" autocomplete="off" placeholder="#hex, rgb(), hsl(), or a name">' +
      row('hex', 'HEX') + row('rgb', 'RGB') + row('hsl', 'HSL') +
      '<div class="cp-sec">Recent</div><div class="cp-recent"></div>');

    // Start from the colour literal under the cursor / in the selection, if any.
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      var seed = null;
      if (!sel.empty && sel.to - sel.from < 64) seed = parse(ed.state.sliceDoc(sel.from, sel.to));
      if (!seed) {
        var line = ed.state.doc.lineAt(sel.head), off = sel.head - line.from;
        var re = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)\n]*\)/gi, m;
        while ((m = re.exec(line.text)) !== null) {
          if (off >= m.index && off <= m.index + m[0].length) { seed = parse(m[0]); break; }
        }
      }
      if (seed) cur = seed;
    } catch (e) {}

    p.querySelector('.cp-drop').addEventListener('click', eyedrop);
    var scr = p.querySelector('.cp-screen');
    if (scr) scr.addEventListener('click', pickFromScreen);
    var native = p.querySelector('.cp-native');
    native.addEventListener('input', function () { setColor(parse(native.value)); });
    native.addEventListener('change', function () { pushRecent(native.value); renderRecent(); });
    var text = p.querySelector('.cp-text');
    text.addEventListener('input', function () {
      var c = parse(text.value);
      text.classList.toggle('bad', !c && !!text.value.trim());
      if (c) setColor(c, { fromText: true });
    });
    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (parse(text.value)) { pushRecent(toHex(cur)); renderRecent(); } }
      e.stopPropagation(); // keep editor/global shortcuts out of the field
    });
    p.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cp-row .cp-btn') : null;
      if (!b) return;
      var val = b.parentNode.querySelector('.cp-val').textContent;
      if (b.getAttribute('data-act') === 'copy') { copy(val); pushRecent(toHex(cur)); renderRecent(); }
      else insert(val);
    });
    p.querySelector('.cp-swatch').addEventListener('click', function () { copy(toHex(cur)); });
    render({});
    renderRecent();
  }

  Cade.registerWidget({
    name: 'Color Picker',
    description: 'Pick a colour — eyedropper from screen, HEX / RGB / HSL, insert or copy',
    icon: '🎨',
    tags: 'color,colour,picker,eyedropper,dropper,hex,rgb,rgba,hsl,swatch,palette',
    open: open,
  });
})();
