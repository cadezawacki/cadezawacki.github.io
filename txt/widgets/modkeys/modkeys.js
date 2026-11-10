/* Mobile keys ("modkeys" plugin) — Ctrl / Shift locks for the on-screen
 * keyboard, and an opt-in floating arrow pad.
 *
 *   [Ctrl] [Shift] [✥]        (a small strip above the keyboard)
 *
 * Ctrl / Shift: tap once to arm for the NEXT key — the next key typed on the
 * on-screen keyboard runs as Ctrl+key / Shift+key (Ctrl+Z, Ctrl+B, Ctrl+F,
 * Ctrl+Shift+N, Shift+Enter, Ctrl+Backspace…) and the button turns itself off.
 * Double-tap to LOCK it on (every key gets the modifier) until it's tapped off.
 * Ctrl+C / X / V copy, cut and paste through the clipboard API, since a
 * synthetic key can't. Shift alone on a letter types the capital.
 *
 * How a soft-keyboard key is caught, in order (phone keyboards differ):
 *   1. keydown with a real key (iOS, hardware keyboards) — cancelled, re-sent;
 *   2. a cancelable beforeinput (insertText / delete / Enter) — cancelled, re-sent;
 *   3. otherwise (Android IMEs report key "Unidentified" and type through
 *      composition) the typed edit is taken back right after it lands, and the
 *      key it carried is re-sent.
 * The combo is a synthetic keydown on the editor, so the app's hotkeys and
 * CodeMirror's keymaps both see it. The app reads Ctrl as metaKey only on
 * "Mac" platforms, CodeMirror on every Apple device, so on an iPhone the combo
 * goes to CodeMirror as ⌘ first and, if nothing took it, to the app as Ctrl.
 *
 * ✥ (or View → Arrow Keys Pad) toggles the arrow pad: a floating D-pad that
 * stays until closed, drags by its centre, and remembers where it was put.
 * Arrows repeat while held (keydown … keyup, like a held key) and carry the
 * armed modifiers (Shift+arrow selects). With a game open they go to the game
 * (games listen on document); otherwise to the editor.
 *
 * The strip shows only on coarse-pointer devices, while the editor has focus
 * and the soft keyboard is open (same test as the thumb cursor pad); it sits
 * above that pad when both show. Nothing in it takes focus. Debug/test hook:
 * window.__cadeModkeys. */
(function () {
  'use strict';

  // ---- pure core (node-testable; see modkeys.test.js) -------------------------
  var CFG = {
    dblTap: 350,                     // ms: a second tap this soon locks the modifier
    repeatDelay: 350, repeatEvery: 60,
    kbRatio: 0.8,
  };
  var MOD_KEYS = { Control: 1, Shift: 1, Alt: 1, Meta: 1, AltGraph: 1, CapsLock: 1, Fn: 1, OS: 1 };

  // A modifier button's next state after a tap at `now`.
  // off → once; once → lock (double tap) or off (a later tap); lock → off.
  function modTap(st, now) {
    st = st || { mode: 'off', at: 0 };
    if (st.mode === 'off') return { mode: 'once', at: now };
    if (st.mode === 'once' && now - st.at <= CFG.dblTap) return { mode: 'lock', at: now };
    return { mode: 'off', at: now };
  }
  // After a key used the modifier: a one-shot turns off, a lock stays.
  function modUsed(st) { return st && st.mode === 'once' ? { mode: 'off', at: st.at } : st; }

  // Is this keydown's key something we can re-send? (Android IMEs say
  // "Unidentified" / keyCode 229; modifier keys themselves are left alone.)
  function usableKey(key, keyCode) {
    if (typeof key !== 'string' || !key || keyCode === 229) return false;
    if (key === 'Unidentified' || key === 'Process' || key === 'Dead') return false;
    return !MOD_KEYS[key];
  }
  // The key a beforeinput / typed edit stands for, or null.
  function keyFromInput(inputType, data) {
    if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') return 'Enter';
    if (inputType === 'deleteContentBackward') return 'Backspace';
    if (inputType === 'deleteContentForward') return 'Delete';
    if (inputType === 'insertText' || inputType === 'insertCompositionText' || inputType === 'insertReplacementText') return lastChar(data);
    return null;
  }
  function lastChar(s) {
    if (typeof s !== 'string' || !s) return null;
    var c = Array.from(s).pop();
    if (c === '\n') return 'Enter';
    if (c === '\t') return 'Tab';
    return c;
  }
  // KeyboardEvent.code / keyCode for a key, so keymaps that look at either agree.
  function codeFor(key) {
    if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
    if (/^[0-9]$/.test(key)) return 'Digit' + key;
    var m = { ' ': 'Space', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
      '/': 'Slash', '\\': 'Backslash', '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote',
      '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote' };
    return m[key] || '';
  }
  function keyCodeFor(key) {
    if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
    var m = { ' ': 32, Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      '/': 191, '\\': 220, '.': 190, ',': 188, ';': 186, "'": 222, '[': 219, ']': 221, '-': 189, '=': 187, '`': 192 };
    return m[key] || 0;
  }
  // Which modifier flag means "Ctrl" to the app (navigator.platform has MAC →
  // metaKey) and to CodeMirror (every Apple platform → metaKey).
  function platformMeta(platform, ua, vendor, touchPoints) {
    var p = String(platform || ''), app = p.toUpperCase().indexOf('MAC') >= 0;
    var ios = /Apple Computer/.test(vendor || '') && (/Mobile\/\w+/.test(ua || '') || touchPoints > 2);
    return { app: app, cm: ios || /Mac/.test(p) };
  }
  function keyboardOpen(vvH, baseH, scale, ratio) {
    if (!(vvH > 0) || !(baseH > 0)) return false;
    return vvH * (scale > 0 ? scale : 1) < baseH * (ratio || CFG.kbRatio);
  }
  function clampPos(x, y, w, h, vw, vh) {
    return { x: Math.max(4, Math.min(vw - w - 4, x)), y: Math.max(4, Math.min(vh - h - 4, y)) };
  }

  var api = { CFG: CFG, modTap: modTap, modUsed: modUsed, usableKey: usableKey, keyFromInput: keyFromInput, lastChar: lastChar, codeFor: codeFor, keyCodeFor: keyCodeFor, platformMeta: platformMeta, keyboardOpen: keyboardOpen, clampPos: clampPos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ---- runtime ------------------------------------------------------------------
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.EditorView) return;
  var BASE = Cade.baseURL();
  var POS_KEY = 'cade-arrowpad-pos';
  var META = platformMeta(navigator.platform, navigator.userAgent, navigator.vendor, navigator.maxTouchPoints || 0);

  var S = {
    view: null, refs: 0, stopT: 0, running: false,
    mq: null, coarse: false, attached: false, forced: null,
    anchor: null, root: null, ctrlBtn: null, shiftBtn: null, padBtn: null,
    visible: false, refreshT: 0, raf: 0, margins: null,
    ctrl: { mode: 'off', at: 0 }, shift: { mode: 'off', at: 0 },
    firing: false, pad: null, padOpen: false,
  };
  var L = [];                         // strip / keyboard listeners (only while attached)
  var PL = [];                        // arrow pad listeners (only while it's open)
  var cssDone = false;

  function on(list, t, type, fn, opts) { if (!t) return; t.addEventListener(type, fn, opts); list.push([t, type, fn, opts]); }
  function offAll(list) {
    for (var i = 0; i < list.length; i++) { try { list[i][0].removeEventListener(list[i][1], list[i][2], list[i][3]); } catch (e) {} }
    list.length = 0;
  }
  function loadCSS() {
    if (cssDone) return;
    cssDone = true;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = BASE + 'modkeys.css';
    document.head.appendChild(l);
  }
  function store() { try { return Cade.store; } catch (e) { return null; } }
  function buzz(ms) { try { Cade.haptic(ms); } catch (e) {} }

  // ---- lifecycle (refcounted: a room switch destroys + recreates the plugin) ----
  function start(view) {
    if (S.stopT) { clearTimeout(S.stopT); S.stopT = 0; }
    S.refs++;
    if (S.running && S.view === view) return;
    if (S.running) stopAll();
    S.view = view; S.running = true;
    try { S.mq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null; } catch (e) { S.mq = null; }
    if (S.mq) {
      if (S.mq.addEventListener) S.mq.addEventListener('change', onMQ);
      else if (S.mq.addListener) S.mq.addListener(onMQ);
    }
    onMQ();
  }
  function release() {
    S.refs = Math.max(0, S.refs - 1);
    if (!S.refs && S.running && !S.stopT) S.stopT = setTimeout(function () { S.stopT = 0; if (!S.refs) stopAll(true); }, 0);
  }
  function stopAll(final) {
    detach();
    if (S.mq) {
      if (S.mq.removeEventListener) S.mq.removeEventListener('change', onMQ);
      else if (S.mq.removeListener) S.mq.removeListener(onMQ);
    }
    S.mq = null; S.coarse = false; S.running = false; S.view = null;
    if (final) closePad();            // plugin switched off: the pad goes too
  }
  function onMQ() {
    S.coarse = !!(S.mq && S.mq.matches) || S.forced != null;
    if (S.coarse) attach(); else detach();
  }
  function attach() {
    if (S.attached || !S.view) return;
    S.attached = true;
    loadCSS();
    if (window.visualViewport) on(L, window.visualViewport, 'resize', onViewport);
    on(L, window, 'orientationchange', onViewport);
    on(L, S.view.contentDOM, 'focus', scheduleRefresh);
    on(L, S.view.contentDOM, 'blur', scheduleRefresh);
    on(L, window, 'keydown', onKeyDown, true);
    on(L, window, 'beforeinput', onBeforeInput, true);
    scheduleRefresh();
  }
  function detach() {
    if (!S.attached && !S.anchor) return;
    S.attached = false;
    hide();
    if (S.refreshT) { clearTimeout(S.refreshT); S.refreshT = 0; }
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    offAll(L);
    if (S.anchor && S.anchor.parentNode) S.anchor.parentNode.removeChild(S.anchor);
    S.anchor = S.root = S.ctrlBtn = S.shiftBtn = S.padBtn = null;
    S.ctrl = { mode: 'off', at: 0 }; S.shift = { mode: 'off', at: 0 };
  }

  // ---- strip visibility ----------------------------------------------------------
  function scheduleRefresh() {
    if (!S.attached || S.refreshT) return;
    S.refreshT = setTimeout(refresh, 0);
  }
  function onViewport() {
    if (!S.raf) S.raf = requestAnimationFrame(function () { S.raf = 0; refresh(); });
  }
  function editorFocused() {
    var v = S.view, ae = document.activeElement;
    if (!v || !ae || !v.contentDOM.contains(ae)) return false;
    return !(ae.closest && ae.closest('.cade-panel'));
  }
  function kbOpen() {
    if (S.forced != null) return S.forced;
    var vv = window.visualViewport;
    if (!vv) return false;
    var base = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
    return keyboardOpen(vv.height, base, vv.scale, CFG.kbRatio);
  }
  function refresh() {
    S.refreshT = 0;
    if (S.attached && S.view && editorFocused() && kbOpen()) show(); else hide();
  }
  function show() {
    build();
    if (!S.visible) {
      S.visible = true;
      S.anchor.hidden = false;
      document.body.classList.add('cade-mk-on');
    }
    measure();
  }
  function hide() {
    if (!S.visible) return;
    S.visible = false;
    if (S.anchor) S.anchor.hidden = true;
    document.body.classList.remove('cade-mk-on');
    // The keyboard went away: an armed one-shot would otherwise fire on the
    // next hardware key long after; locks stay (they're deliberate).
    if (S.ctrl.mode === 'once') S.ctrl = { mode: 'off', at: 0 };
    if (S.shift.mode === 'once') S.shift = { mode: 'off', at: 0 };
    paint();
  }
  function measure() {
    var v = S.view, m = { top: 0, bottom: 0 };
    try {
      var sr = v.scrollDOM.getBoundingClientRect();
      m.bottom = Math.max(0, sr.bottom - S.root.getBoundingClientRect().top) + 8;
    } catch (e) {}
    S.margins = m;
  }
  function marginsFor(view) {
    if (!S.visible || view !== S.view || !S.margins || document.body.classList.contains('sel-mode')) return null;
    return S.margins;
  }

  // ---- strip DOM ---------------------------------------------------------------------
  var PAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l-3 3h6zM12 21l-3-3h6zM3 12l3-3v6zM21 12l-3-3v6z" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2"/></svg>';
  function build() {
    if (S.anchor) return;
    var anchor = document.createElement('div');
    anchor.className = 'cade-mk-anchor';
    anchor.hidden = true;
    anchor.innerHTML =
      '<div class="cade-mk" role="toolbar" aria-label="Modifier keys">' +
        '<button type="button" tabindex="-1" class="cade-mk-b" data-a="ctrl" aria-pressed="false" title="Ctrl for the next key — double-tap to lock">Ctrl</button>' +
        '<button type="button" tabindex="-1" class="cade-mk-b" data-a="shift" aria-pressed="false" title="Shift for the next key — double-tap to lock">Shift</button>' +
        '<button type="button" tabindex="-1" class="cade-mk-b cade-mk-padbtn" data-a="pad" aria-pressed="false" aria-label="Arrow keys pad" title="Arrow keys pad">' + PAD_ICON + '</button>' +
      '</div>';
    document.body.appendChild(anchor);
    S.anchor = anchor;
    S.root = anchor.firstChild;
    S.ctrlBtn = S.root.querySelector('[data-a="ctrl"]');
    S.shiftBtn = S.root.querySelector('[data-a="shift"]');
    S.padBtn = S.root.querySelector('[data-a="pad"]');
    // touchstart/pointerdown are cancelled so the editor keeps focus (and the keyboard stays up).
    on(L, S.root, 'touchstart', onStripPress, { passive: false });
    on(L, S.root, 'pointerdown', function (e) { e.preventDefault(); if (e.pointerType !== 'touch') onStripPress(e); });
    on(L, S.root, 'mousedown', prevent);
    on(L, S.root, 'click', prevent);
    on(L, S.root, 'contextmenu', prevent);
    paint();
  }
  function prevent(e) { e.preventDefault(); }
  function onStripPress(e) {
    e.preventDefault();
    var el = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
    if (!el) return;
    var a = el.getAttribute('data-a');
    if (a === 'ctrl' || a === 'shift') tapMod(a);
    else if (a === 'pad') togglePad();
  }
  function tapMod(which) {
    S[which] = modTap(S[which], Date.now());
    buzz(S[which].mode === 'lock' ? 14 : 8);
    paint();
  }
  function paint() {
    [['ctrl', S.ctrlBtn], ['shift', S.shiftBtn]].forEach(function (p) {
      var b = p[1], m = S[p[0]].mode;
      if (!b) return;
      b.classList.toggle('once', m === 'once');
      b.classList.toggle('lock', m === 'lock');
      b.setAttribute('aria-pressed', m === 'off' ? 'false' : 'true');
    });
    if (S.padBtn) { S.padBtn.classList.toggle('lock', S.padOpen); S.padBtn.setAttribute('aria-pressed', S.padOpen ? 'true' : 'false'); }
    if (S.pad) {
      S.pad.classList.toggle('mod-ctrl', S.ctrl.mode !== 'off');
      S.pad.classList.toggle('mod-shift', S.shift.mode !== 'off');
    }
  }
  function armed() { return S.ctrl.mode !== 'off' || S.shift.mode !== 'off'; }
  function consume() {
    var c = S.ctrl.mode !== 'off', s = S.shift.mode !== 'off';
    S.ctrl = modUsed(S.ctrl); S.shift = modUsed(S.shift);
    paint();
    return { ctrl: c, shift: s };
  }

  // ---- catching keyboard keys --------------------------------------------------------
  function inEditor(t) { var v = S.view; return !!(v && t && t.nodeType && v.contentDOM.contains(t)); }
  // 1. a keydown that names its key
  function onKeyDown(e) {
    if (S.firing || !e.isTrusted || !armed() || !inEditor(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !usableKey(e.key, e.keyCode)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fire(e.key, e.shiftKey);
  }
  // 2. a cancelable beforeinput
  function onBeforeInput(e) {
    if (S.firing || !armed() || !e.cancelable || !inEditor(e.target)) return;
    var k = keyFromInput(e.inputType, e.data);
    if (!k) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fire(k, false);
  }
  // 3. the edit already happened (Android composition): take it back, re-send its key
  function onUpdate(u) {
    if (u.focusChanged) scheduleRefresh();
    if (S.firing || !armed() || !u.docChanged || u.view !== S.view) return;
    var tr = null;
    for (var i = 0; i < u.transactions.length; i++) if (u.transactions[i].docChanged) { if (tr) return; tr = u.transactions[i]; }
    if (!tr) return;
    var key = null;
    if (tr.isUserEvent('input.type')) {
      var ins = '';
      tr.changes.iterChanges(function (fa, ta, fb, tb, text) { ins += text.toString(); });
      key = lastChar(ins);
    } else if (tr.isUserEvent('delete.backward')) key = 'Backspace';
    else if (tr.isUserEvent('delete.forward')) key = 'Delete';
    if (!key) return;
    var view = u.view, undo = tr.changes.invert(u.startState.doc), sel = u.startState.selection;
    var T = tr.constructor;
    Promise.resolve().then(function () {
      if (S.view !== view) return;
      S.firing = true;
      try {
        view.dispatch({ changes: undo, selection: sel, annotations: T.addToHistory ? T.addToHistory.of(false) : undefined });
      } catch (e) { S.firing = false; return; }
      S.firing = false;
      fire(key, false);
    });
  }

  // Run `key` with the armed modifiers (and a physical Shift, if any).
  function fire(key, physShift) {
    var m = consume(), ctrl = m.ctrl, shift = m.shift || !!physShift;
    var v = S.view;
    if (!v || (!ctrl && !shift)) return;
    S.firing = true;
    try {
      if (ctrl && key.length === 1) {
        var k = key.toLowerCase();
        if (k === 'c') return copy();
        if (k === 'x') return cut();
        if (k === 'v') return paste();
      }
      if (!ctrl && key.length === 1) {               // Shift + a character: type the capital
        insert(key.toUpperCase());
        return;
      }
      sendKey(v.contentDOM, 'keydown', key, { ctrl: ctrl, shift: shift }, false);
    } finally { S.firing = false; }
  }
  function makeKey(type, key, mods, meta, repeat) {
    var ev = new KeyboardEvent(type, {
      key: key, code: codeFor(key), bubbles: true, cancelable: true, composed: true, repeat: !!repeat,
      ctrlKey: !!mods.ctrl && !meta, metaKey: !!mods.ctrl && meta, shiftKey: !!mods.shift,
    });
    var kc = keyCodeFor(key);
    if (kc) {
      try {
        Object.defineProperty(ev, 'keyCode', { get: function () { return kc; } });
        Object.defineProperty(ev, 'which', { get: function () { return kc; } });
      } catch (e) {}
    }
    return ev;
  }
  // Dispatch a synthetic key; true when something handled it. Where the app
  // and CodeMirror disagree on Ctrl (iPhone: app Ctrl, CodeMirror ⌘), the ⌘
  // form goes first so the editor's own Ctrl+A / Z / Y… win over CodeMirror's
  // Emacs-style Ctrl bindings for Apple; unhandled, it's re-sent as Ctrl for
  // the app's hotkeys.
  function sendKey(target, type, key, mods, repeat) {
    var split = mods.ctrl && META.cm !== META.app;
    var ev = makeKey(type, key, mods, split ? META.cm : META.app, repeat);
    target.dispatchEvent(ev);
    if (split && !ev.defaultPrevented && type === 'keydown') {
      ev = makeKey(type, key, mods, META.app, repeat);
      target.dispatchEvent(ev);
    }
    return ev.defaultPrevented;
  }
  function insert(text) {
    var v = S.view;
    v.dispatch(v.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
  }
  function selected() { var v = S.view, r = v.state.selection.main; return r.empty ? '' : v.state.sliceDoc(r.from, r.to); }
  function copy() {
    if (window.mobileCopy) { window.mobileCopy(); return; }
    var t = selected();
    if (t && navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
  }
  function cut() {
    var v = S.view, r = v.state.selection.main, t = selected();
    if (!t) return;
    var del = function () {
      if (S.view !== v || v.state.sliceDoc(r.from, r.to) !== t) return;
      v.dispatch({ changes: { from: r.from, to: r.to }, userEvent: 'delete.cut' });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(del, function () { Cade.showToast('Failed to cut — clipboard unavailable', 'error', 2000); });
  }
  function paste() {
    if (window.mobilePaste) { window.mobilePaste(); return; }
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then(function (t) { if (t) insert(t); }).catch(function () {});
  }

  // ---- arrow pad -------------------------------------------------------------------
  var ARROW = {
    ArrowUp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6l-6 8h12z"/></svg>',
    ArrowDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18l-6-8h12z"/></svg>',
    ArrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12l8-6v12z"/></svg>',
    ArrowRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 12l-8-6v12z"/></svg>',
  };
  var P = {};                          // active presses on the pad: id → { key, mods, target, t, n } | { drag }
  function padTarget() {
    // An open game takes the keys (games listen on document); else the editor.
    var game = document.querySelector('.cade-game-panel:not(.cade-minimized)');
    if (game) {
      var ae = document.activeElement;
      return ae && game.contains(ae) ? ae : document;
    }
    var ae2 = document.activeElement;
    if (ae2 && ae2 !== document.body && !(S.view && S.view.contentDOM.contains(ae2)) && ae2.closest && ae2.closest('.cade-panel')) return ae2;
    return S.view ? S.view.contentDOM : document;
  }
  function openPad() {
    if (S.pad) return;
    loadCSS();
    var pad = document.createElement('div');
    pad.className = 'cade-mk-pad';
    pad.setAttribute('role', 'group');
    pad.setAttribute('aria-label', 'Arrow keys');
    function b(k, label) { return '<button type="button" tabindex="-1" class="cade-mk-arrow" data-k="' + k + '" aria-label="' + label + '">' + ARROW[k] + '</button>'; }
    pad.innerHTML =
      b('ArrowUp', 'Up') + b('ArrowLeft', 'Left') +
      '<button type="button" tabindex="-1" class="cade-mk-grip" data-k="grip" aria-label="Drag to move the arrow pad" title="Drag to move"><i></i></button>' +
      b('ArrowRight', 'Right') + b('ArrowDown', 'Down') +
      '<button type="button" tabindex="-1" class="cade-mk-close" data-k="close" aria-label="Close the arrow pad" title="Close">×</button>';
    document.body.appendChild(pad);
    S.pad = pad;
    S.padOpen = true;
    placePad();
    on(PL, pad, 'touchstart', padTouch, { passive: false });
    on(PL, pad, 'touchmove', padTouch, { passive: false });
    on(PL, pad, 'touchend', padTouch, { passive: false });
    on(PL, pad, 'touchcancel', padTouch, { passive: false });
    on(PL, pad, 'pointerdown', padPointer);
    on(PL, pad, 'pointermove', padPointer);
    on(PL, pad, 'pointerup', padPointer);
    on(PL, pad, 'pointercancel', padPointer);
    on(PL, pad, 'mousedown', prevent);
    on(PL, pad, 'click', prevent);
    on(PL, pad, 'contextmenu', prevent);
    on(PL, window, 'resize', placePad);
    if (window.visualViewport) on(PL, window.visualViewport, 'resize', placePad);
    on(PL, window, 'blur', releaseAll);
    paint();
  }
  function closePad() {
    releaseAll();
    offAll(PL);
    if (S.pad && S.pad.parentNode) S.pad.parentNode.removeChild(S.pad);
    S.pad = null;
    S.padOpen = false;
    paint();
  }
  function togglePad(force) {
    var want = force == null ? !S.padOpen : !!force;
    if (want) openPad(); else closePad();
    buzz(8);
    return S.padOpen;
  }
  function viewportBox() {
    var vv = window.visualViewport;
    return vv ? { w: vv.width, h: vv.height, x: vv.offsetLeft, y: vv.offsetTop } : { w: window.innerWidth, h: window.innerHeight, x: 0, y: 0 };
  }
  // Saved as a fraction of the viewport, so rotation keeps it in the same corner.
  function placePad() {
    if (!S.pad) return;
    var vb = viewportBox(), w = S.pad.offsetWidth || 156, h = S.pad.offsetHeight || 156, pos = null;
    try { pos = JSON.parse((store() && store().get(POS_KEY)) || 'null'); } catch (e) {}
    var x = pos && pos.fx >= 0 ? pos.fx * (vb.w - w) : vb.w - w - 12;
    var y = pos && pos.fy >= 0 ? pos.fy * (vb.h - h) : vb.h - h - 170;   // default: clear of the scroll buttons
    var c = clampPos(x, y, w, h, vb.w, vb.h);
    S.pad.style.left = (vb.x + c.x) + 'px';
    S.pad.style.top = (vb.y + c.y) + 'px';
  }
  function savePos(x, y) {
    var vb = viewportBox(), w = S.pad.offsetWidth, h = S.pad.offsetHeight;
    var c = clampPos(x - vb.x, y - vb.y, w, h, vb.w, vb.h);
    S.pad.style.left = (vb.x + c.x) + 'px';
    S.pad.style.top = (vb.y + c.y) + 'px';
    var st = store();
    try { if (st) st.set(POS_KEY, JSON.stringify({ fx: c.x / Math.max(1, vb.w - w), fy: c.y / Math.max(1, vb.h - h) })); } catch (e) {}
  }
  function padTouch(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], id = 't' + t.identifier;
      if (e.type === 'touchstart') pressStart(id, document.elementFromPoint(t.clientX, t.clientY) || e.target, t.clientX, t.clientY);
      else if (e.type === 'touchmove') pressMove(id, t.clientX, t.clientY);
      else pressEnd(id);
    }
  }
  function padPointer(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    var id = 'p' + e.pointerId;
    if (e.type === 'pointerdown') { try { S.pad.setPointerCapture(e.pointerId); } catch (x) {} pressStart(id, e.target, e.clientX, e.clientY); }
    else if (e.type === 'pointermove') pressMove(id, e.clientX, e.clientY);
    else pressEnd(id);
  }
  function pressStart(id, target, x, y) {
    var el = target && target.closest ? target.closest('[data-k]') : null;
    if (!el || !S.pad || !S.pad.contains(el) || P[id]) return;
    var k = el.getAttribute('data-k');
    el.classList.add('is-down');
    if (k === 'close') { P[id] = { el: el, close: true }; return; }
    if (k === 'grip') {
      var r = S.pad.getBoundingClientRect();
      P[id] = { el: el, drag: true, dx: x - r.left, dy: y - r.top };
      return;
    }
    // Several arrows can be held at once (diagonals in games); the modifiers
    // armed at the press stay with it until it's released.
    var mods = consume();
    var p = P[id] = { el: el, key: k, mods: mods, target: padTarget(), t: 0 };
    buzz(6);
    sendKey(p.target, 'keydown', k, mods, false);
    var tick = function (n) {
      p.t = setTimeout(function () {
        if (P[id] !== p) return;
        sendKey(p.target, 'keydown', k, p.mods, true);
        tick(n + 1);
      }, n === 0 ? CFG.repeatDelay : CFG.repeatEvery);
    };
    tick(0);
  }
  function pressMove(id, x, y) {
    var p = P[id];
    if (p && p.drag && S.pad) savePos(x - p.dx, y - p.dy);
  }
  function pressEnd(id) {
    var p = P[id];
    if (!p) return;
    delete P[id];
    if (p.el) p.el.classList.remove('is-down');
    if (p.close) { closePad(); return; }
    if (p.key) {
      clearTimeout(p.t);
      sendKey(p.target, 'keyup', p.key, p.mods, false);
    }
  }
  function releaseAll() { Object.keys(P).forEach(function (id) { if (!P[id].close) pressEnd(id); else delete P[id]; }); }

  // Core hooks (View → Arrow Keys Pad) and a debug / test hook.
  window.__cadeArrowPad = { toggle: togglePad, isOpen: function () { return S.padOpen; } };
  window.__cadeModkeys = {
    force: function (v) { S.forced = v == null ? null : !!v; if (S.running) onMQ(); if (S.attached) refresh(); return S.forced; },
    tap: function (which) { tapMod(which); return S[which].mode; },
    state: function () {
      return { running: S.running, coarse: S.coarse, attached: S.attached, visible: S.visible, ctrl: S.ctrl.mode, shift: S.shift.mode, padOpen: S.padOpen, listeners: L.length, padListeners: PL.length, margins: S.margins, meta: META };
    },
  };

  var plugin = CM.ViewPlugin.define(function (view) {
    start(view);
    return { update: onUpdate, destroy: release };
  });
  var ext = [plugin];
  if (CM.EditorView.scrollMargins) ext.push(CM.EditorView.scrollMargins.of(marginsFor));
  Cade.registerPlugin({ id: 'modkeys', ext: ext });
})();
