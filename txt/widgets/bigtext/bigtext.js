/* Big Text — show the selection full-screen in the biggest type that fits:
 * for showing a phone across a room, a pickup sign at arrivals, a Wi-Fi
 * password, a "can you hear me?" on a muted call.
 *
 * TEXT: the selection, else the current line, else an inline box asks for
 * some. Light Markdown is stripped (heading / list / quote markers, emphasis,
 * links -> text, highlight sentinels). Several lines show one per screen:
 * ←/→ (or a swipe, or the ‹ › buttons) steps through them.
 *
 * FITTING: binary search on font-size against the real layout (wrapping on
 * word boundaries, so a long word shrinks the type instead of being split)
 * until the text fills the width or height. Refits on resize / rotation.
 *
 * SCREEN: a fixed overlay above everything (safe-area aware), plus the
 * Fullscreen API where the browser allows it (not on iPhone, where Safari
 * only full-screens video — the overlay is the fallback). The Screen Wake
 * Lock API keeps the display on while it's open (feature-detected; iOS 16.4+).
 *
 * CONTROLS: colours (white on black / black on white / accent / yellow),
 * rotate 90° for a sideways sign on a portrait phone, flash (1 Hz inversion,
 * a gentle pulse with reduced motion), edit. Tap / click / Esc closes.
 * Self-contained IIFE; nothing runs until opened and everything is released
 * on close. Pure helpers are exposed as widget._lib for node unit checks. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('bigtext.css');

  var OV_ID = 'bigtext-overlay';
  var PREFS_KEY = 'cade-bigtext-prefs';
  var THEMES = ['dark', 'light', 'accent', 'yellow'];
  var THEME_NAME = { dark: 'White on black', light: 'Black on white', accent: 'Accent', yellow: 'Black on yellow' };
  var MAX_LINES = 1000, MAX_LINE = 2000;
  var prefs = { theme: 'dark', rot: false };
  var S = null; // state while open

  // ======================================================================
  // Pure helpers
  // ======================================================================
  // One Markdown-ish line -> plain display text.
  function cleanLine(s) {
    s = String(s || '')
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
      .replace(/^\s*%%(?:center|right)%%\s?/, '')        // alignment sentinel
      .replace(/^\s{0,3}(?:>\s?)+/, '')                    // quote
      .replace(/^\s{0,3}#{1,6}\s+/, '')                    // heading
      .replace(/^\s*(?:[-*+\u2022]|\d{1,3}[.)])\s+/, '')   // list marker
      .replace(/^\s*\[[ xX]\]\s+/, '')                     // task box
      .replace(/!\[(?:img|file):[^\]\n]*\]/g, '')          // core image / attachment tokens
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')            // markdown images
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, '$1')
      .replace(/%%[^|%\n]{1,32}\|([^\n]+?)%%/g, '$1')     // highlight sentinel
      .replace(/==[a-zA-Z]{3,10}\|([^\n]+?)==/g, '$1')    // legacy highlight
      .replace(/<\/?(?:u|b|i|em|strong|br|s|del|ins|sub|sup|mark|span|kbd|small|big|code|p|div)\b[^>\n]*>/gi, '')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/__([^_\n]+?)__/g, '$1')
      .replace(/~~([^~\n]+?)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*([^*\s][^*\n]*?)\*/g, '$1')
      .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2');
    return s.replace(/\s+/g, ' ').trim();
  }
  // Text -> one page per non-empty line (fences / rules dropped, capped).
  function toPages(text) {
    var out = [], lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length && out.length < MAX_LINES; i++) {
      var ln = lines[i];
      if (/^\s{0,3}(```|~~~)/.test(ln) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) continue;
      var c = cleanLine(ln.length > MAX_LINE ? ln.slice(0, MAX_LINE) : ln);
      if (c) out.push(c);
    }
    return out;
  }
  // Largest size in [lo, hi] for which fits(size) holds (fits is monotone:
  // true up to some size, false after). Half-pixel precision, ~10 layouts.
  function fitSize(fits, lo, hi) {
    if (!fits(lo)) return lo;
    if (fits(hi)) return hi;
    while (hi - lo > 0.5) {
      var mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  // ======================================================================
  // Platform helpers: wake lock + fullscreen (all feature-detected)
  // ======================================================================
  function wakeAcquire() {
    if (!S || !navigator.wakeLock || !navigator.wakeLock.request || S.wake || document.visibilityState !== 'visible') return;
    var s = S;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        if (S !== s) { try { lock.release(); } catch (e) {} return; }
        s.wake = lock;
        lock.addEventListener('release', function () { if (s.wake === lock) s.wake = null; });
      }, function () { /* denied (battery saver, iOS standalone < 18.4 …): screen may dim */ });
    } catch (e) {}
  }
  function wakeRelease(s) {
    if (s && s.wake) { var l = s.wake; s.wake = null; try { var r = l.release(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
  }
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function canFs() { return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
  function enterFs(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try { var r = fn.call(el); if (r && r.catch) r.catch(function () {}); } catch (e) {}
  }
  function exitFs() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn || !fsEl()) return;
    try { var r = fn.call(document); if (r && r.catch) r.catch(function () {}); } catch (e) {}
  }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  // ======================================================================
  // Overlay
  // ======================================================================
  var I = function (d, fill) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  };
  var ICON = {
    prev: I('<polyline points="15 18 9 12 15 6"/>'),
    next: I('<polyline points="9 18 15 12 9 6"/>'),
    theme: I('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
    rot: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><polyline points="20 4 20 11 13 11"/>'),
    flash: I('<polygon points="13 2 4 14 11 14 10 22 20 9 13 9 13 2"/>'),
    fs: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    edit: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  };
  function btn(act, title, icon) {
    return '<button type="button" class="bt-b" data-act="' + act + '" title="' + title + '" aria-label="' + title + '">' + icon + '</button>';
  }

  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (THEMES.indexOf(p.theme) !== -1) prefs.theme = p.theme;
      prefs.rot = !!p.rot;
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // The selection, else the current line, else nothing (-> ask).
  function pickText() {
    try {
      var st = Cade.editor.state, sel = st.selection.main;
      if (!sel.empty) return st.sliceDoc(sel.from, Math.min(sel.to, sel.from + 200000));
      var line = st.doc.lineAt(sel.head).text;
      return line.trim() ? line : '';
    } catch (e) { return ''; }
  }

  function fit() {
    if (!S || S.editing || !S.pages.length) return;
    // The area is the screen minus safe-area insets and the toolbar strip;
    // rotated, the box swaps its sides and is turned 90° about its centre.
    var W = S.area.clientWidth, H = S.area.clientHeight;
    if (prefs.rot) { var t = W; W = H; H = t; }
    W = Math.max(40, Math.floor(W)); H = Math.max(40, Math.floor(H));
    S.box.style.width = W + 'px';
    S.box.style.height = H + 'px';
    var el = S.text;
    el.style.width = W + 'px';
    // scrollWidth/Height report the laid-out text even when it overflows
    // (an unbreakable word sticks out sideways, extra lines push down).
    var fits = function (px) {
      el.style.fontSize = px + 'px';
      return el.scrollWidth <= W + 0.5 && el.scrollHeight <= H + 0.5;
    };
    var size = fitSize(fits, 8, Math.max(8, H));
    el.style.fontSize = Math.floor(size) + 'px';
  }
  var resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; fit(); });
  }

  function show(i) {
    if (!S) return;
    var n = S.pages.length;
    if (!n) return;
    S.idx = Math.max(0, Math.min(n - 1, i));
    S.text.textContent = S.pages[S.idx];
    S.count.textContent = n > 1 ? (S.idx + 1) + ' / ' + n : '';
    S.count.hidden = n < 2;
    S.ov.classList.toggle('bt-multi', n > 1);
    S.ov.querySelector('[data-act="prev"]').disabled = S.idx === 0;
    S.ov.querySelector('[data-act="next"]').disabled = S.idx === n - 1;
    fit();
  }
  function step(d) {
    if (!S || S.pages.length < 2) return;
    var j = Math.max(0, Math.min(S.pages.length - 1, S.idx + d));
    if (j !== S.idx) { show(j); Cade.haptic(8); }
  }

  function applyLook() {
    if (!S) return;
    S.ov.setAttribute('data-bt', prefs.theme);
    S.ov.classList.toggle('bt-rot', !!prefs.rot);
    var tb = S.ov.querySelector('[data-act="theme"]');
    tb.title = 'Colours: ' + THEME_NAME[prefs.theme] + ' (T)';
    S.ov.querySelector('[data-act="rot"]').classList.toggle('on', !!prefs.rot);
    S.ov.querySelector('[data-act="flash"]').classList.toggle('on', S.ov.classList.contains('bt-flashing'));
  }

  function poke() {
    if (!S) return;
    S.ov.classList.remove('bt-idle');
    clearTimeout(S.idleT);
    S.idleT = setTimeout(function () { if (S && !S.editing) S.ov.classList.add('bt-idle'); }, 2500);
  }

  function startEdit() {
    if (!S) return;
    S.editing = true;
    S.ov.classList.add('bt-editing');
    S.form.hidden = false;
    S.ta.value = S.pages.join('\n');
    poke();
    try { S.ta.focus(); S.ta.select(); } catch (e) {}
  }
  function endEdit(apply) {
    if (!S) return;
    if (apply) {
      var pages = toPages(S.ta.value);
      if (!pages.length) { S.ta.focus(); return; }
      S.pages = pages;
    } else if (!S.pages.length) { close(); return; }
    S.editing = false;
    S.ov.classList.remove('bt-editing');
    S.form.hidden = true;
    try { S.ta.blur(); } catch (e) {}
    S.ov.focus();
    show(apply ? 0 : S.idx);
  }

  function act(a) {
    if (!S) return;
    switch (a) {
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'theme':
        prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length];
        savePrefs(); applyLook();
        break;
      case 'rot': prefs.rot = !prefs.rot; savePrefs(); applyLook(); fit(); break;
      case 'flash': S.ov.classList.toggle('bt-flashing'); applyLook(); break;
      case 'fs':
        if (fsEl()) { S.fsOurs = false; exitFs(); } else { S.fsOurs = true; enterFs(S.ov); }
        break;
      case 'edit': startEdit(); break;
      case 'close': close(); break;
    }
  }

  function onKey(e) {
    if (!S) return;
    var k = e.key;
    // Enter / Space on a focused toolbar button activate the button.
    if ((k === 'Enter' || k === ' ') && e.target.closest && e.target.closest('.bt-bar')) { e.stopPropagation(); return; }
    if (S.editing) {
      if (k === 'Escape') { e.preventDefault(); endEdit(false); }
      else if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); endEdit(true); }
      e.stopPropagation(); // typing goes to the box, never to the editor / app shortcuts
      return;
    }
    var handled = true;
    switch (k) {
      case 'Escape': close(); break;
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter': step(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': step(-1); break;
      case 'Home': if (S.pages.length > 1) show(0); break;
      case 'End': if (S.pages.length > 1) show(S.pages.length - 1); break;
      default:
        if (e.ctrlKey || e.metaKey || e.altKey) { handled = false; break; }
        var c = k.toLowerCase();
        if (c === 't') act('theme');
        else if (c === 'r') act('rot');
        else if (c === 'f') act('flash');
        else if (c === 'e') act('edit');
        else handled = false;
    }
    if (handled) e.preventDefault();
    e.stopPropagation(); // the overlay is modal: keep keys away from the editor behind it
    poke();
  }
  function onVis() {
    if (!S) return;
    if (document.visibilityState === 'visible') wakeAcquire();
  }
  function onFsChange() {
    if (!S) return;
    // Leaving browser fullscreen with Esc (the key never reaches the page in
    // fullscreen) means "I'm done": close, unless our own button exited.
    if (!fsEl() && S.fsOurs) { close(); return; }
    onResize();
  }

  function close() {
    if (!S) return;
    var s = S;
    S = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    clearTimeout(s.idleT);
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
    wakeRelease(s);
    if (fsEl() === s.ov) exitFs();
    s.ov.remove();
    // Desktop: hand the editor its focus back. Touch: don't pop the keyboard.
    if (!coarse()) { try { Cade.editor.focus(); } catch (e) {} }
  }

  function open() {
    Cade.closeAllMenus();
    if (S) { close(); return; }
    loadPrefs();
    var pages = toPages(pickText());
    var ov = document.createElement('div');
    ov.id = OV_ID;
    ov.className = 'bt-ov';
    ov.tabIndex = -1;
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Big text');
    ov.innerHTML =
      '<div class="bt-stage"><div class="bt-area"><div class="bt-box"><div class="bt-text" aria-live="polite"></div></div></div></div>' +
      '<div class="bt-count" hidden></div>' +
      '<div class="bt-bar" role="toolbar" aria-label="Big text controls">' +
        btn('prev', 'Previous line (←)', ICON.prev) + btn('next', 'Next line (→)', ICON.next) +
        btn('theme', 'Colours (T)', ICON.theme) + btn('rot', 'Rotate 90° (R)', ICON.rot) +
        btn('flash', 'Flash (F)', ICON.flash) + (canFs() ? btn('fs', 'Full screen', ICON.fs) : '') +
        btn('edit', 'Edit text (E)', ICON.edit) + btn('close', 'Close (Esc)', ICON.close) +
      '</div>' +
      '<form class="bt-edit" hidden>' +
        '<textarea class="bt-ta" rows="3" placeholder="Type something to show big…" aria-label="Text to show" ' +
          'autocomplete="off" spellcheck="false"></textarea>' +
        '<div class="bt-eacts"><span class="bt-ehint">One screen per line</span>' +
          '<button type="button" class="bt-eb" data-edit="cancel">Cancel</button>' +
          '<button type="submit" class="bt-eb primary">Show</button></div>' +
      '</form>';
    document.body.appendChild(ov);
    S = {
      ov: ov, stage: ov.querySelector('.bt-stage'), area: ov.querySelector('.bt-area'), box: ov.querySelector('.bt-box'), text: ov.querySelector('.bt-text'),
      count: ov.querySelector('.bt-count'), form: ov.querySelector('.bt-edit'), ta: ov.querySelector('.bt-ta'),
      pages: pages, idx: 0, editing: false, wake: null, idleT: 0, fsOurs: false, pd: null, swipedAt: 0,
    };

    // A swipe steps lines (either axis, so it also works rotated); a tap or
    // click closes. Closing on `click` (not pointerup) consumes the tap, so
    // iOS can't deliver a ghost click to the editor underneath.
    S.stage.addEventListener('pointerdown', function (e) {
      if (S) S.pd = { x: e.clientX, y: e.clientY };
    });
    S.stage.addEventListener('pointerup', function (e) {
      if (!S || !S.pd) return;
      var d = S.pd; S.pd = null;
      var dx = e.clientX - d.x, dy = e.clientY - d.y, ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) > 40) { S.swipedAt = Date.now(); step((ax > ay ? dx : dy) < 0 ? 1 : -1); }
      else if (Math.max(ax, ay) > 12) S.swipedAt = Date.now(); // a drag, not a tap
    });
    S.stage.addEventListener('pointercancel', function () { if (S) S.pd = null; });
    S.stage.addEventListener('click', function (e) {
      if (!S || e.button !== 0 || Date.now() - S.swipedAt < 400) return;
      e.preventDefault();
      close();
    });
    ov.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') poke(); });
    ov.querySelector('.bt-bar').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (b) { act(b.getAttribute('data-act')); poke(); }
    });
    S.form.addEventListener('submit', function (e) { e.preventDefault(); endEdit(true); });
    S.form.querySelector('[data-edit="cancel"]').addEventListener('click', function () { endEdit(false); });

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    try { Cade.editor.contentDOM.blur(); } catch (e) {}
    applyLook();
    poke();
    wakeAcquire();
    if (pages.length) {
      ov.focus();
      show(0);
      // Fullscreen needs a fresh user gesture; on a first (lazy-loaded) open it
      // may be refused, which is fine: the overlay already fills the window.
      if (canFs()) { S.fsOurs = true; enterFs(ov); }
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fit(); });
    } else {
      startEdit();
    }
  }

  Cade.registerWidget({
    name: 'Big Text',
    description: 'Show the selection full-screen in huge type — signs, passwords, messages across a room',
    icon: '🔠',
    tags: 'big,text,large,huge,fullscreen,full screen,sign,display,show,present,flash,banner,zoom,airport,pickup',
    open: open,
    _lib: { cleanLine: cleanLine, toPages: toPages, fitSize: fitSize },
  });
})();
