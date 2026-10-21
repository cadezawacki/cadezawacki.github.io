/* Thumb cursor pad ("thumbpad" plugin) — a small trackpad strip just above the
 * on-screen keyboard for precise caret movement and selection on phones.
 *
 *   [⇤ word] [ trackpad ] [word ⇥] [Select] [▾]
 *
 * Trackpad: a horizontal slide moves the caret by characters (one step per
 * ~8 px), a vertical slide by lines (~18 px, view.moveVertically, so wrapped
 * lines and the goal column behave like the arrow keys); fast swipes
 * accelerate, and per step the dominant axis wins (with a little stickiness
 * for the axis already moving, so a thumb's arc doesn't hop lines).
 * Double-tap selects the word at the caret, triple-tap the line; a long press
 * (350 ms) extends the selection while the finger keeps dragging. Select
 * toggles "extend mode" (every move extends from the fixed anchor; tapping it
 * again collapses to the head). The word buttons repeat while held. ▾ tucks
 * the pad into a small handle at the right edge (remembered in Cade.store).
 *
 * When it shows: only on coarse-pointer devices (checked at start and on
 * matchMedia change — elsewhere nothing but that one media listener exists),
 * while the main editor has focus AND the soft keyboard is open (the visual
 * viewport is notably shorter than the layout viewport). Hidden by CSS during
 * the core's Select mode (body.sel-mode). It never takes focus: every press
 * on it is preventDefault-ed, so the editor keeps the caret and the keyboard
 * stays up. It only moves / selects, never edits (fine in read-only rooms),
 * and ignores input during IME composition.
 *
 * Placement: a zero-height flex row (order 4) at the bottom of the editor
 * area, i.e. above the find bar / footer, which the core pins to the visual
 * viewport (#18) — so it rides on top of the keyboard with no measuring. An
 * EditorView.scrollMargins entry keeps the caret line clear of it.
 *
 * Cost: listeners exist only while the plugin is enabled on a touch device;
 * no rAF loop — work happens per touch event, and a dispatch only when a step
 * actually moves the caret. Everything goes on ViewPlugin destroy (the
 * Settings toggle). Debug/test hook: window.__cadeThumbpad.force(bool|null)
 * fakes the keyboard state; .state() reports what's live. */
(function () {
  'use strict';

  // ---- pure core (node-testable; see thumbpad.test.js) ----------------------
  var CFG = {
    xStep: 8, yStep: 18,          // px of finger travel per character / line
    v0: 0.3, v1: 1.5,             // px/ms: below v0 no acceleration, at v1 the max
    xGain: 4, yGain: 2.5,         // max acceleration per axis
    lock: 1.4,                    // the axis that moved last wins unless the other beats it by this much
    maxSteps: 40,                 // per touch event
    repeatDelay: 350, repeatEvery: 90,
    longPress: 350,
    tapMs: 300, tapSlop: 10,      // a tap: shorter than this, moved less than this
    tapGap: 320, multiSlop: 36,   // double / triple tap: next press within this gap, this close
    kbRatio: 0.8,                 // keyboard open: visual viewport < 0.8 × layout height
  };

  function gain(v, max) {
    if (!(v > CFG.v0)) return 1;
    if (v >= CFG.v1) return max;
    return 1 + (max - 1) * (v - CFG.v0) / (CFG.v1 - CFG.v0);
  }

  // Turns finger deltas into caret steps: move(dx, dy, dtMs) -> { axis, n }
  // (axis 'x' | 'y' | null, n signed). Remainders carry over; the losing
  // axis's travel is dropped, so a sideways swipe never drifts down a line.
  function makeTracker(cfg) {
    cfg = cfg || CFG;
    var ax = 0, ay = 0, axis = null;
    return {
      reset: function () { ax = 0; ay = 0; axis = null; },
      axis: function () { return axis; },
      move: function (dx, dy, dt) {
        dx = +dx || 0; dy = +dy || 0;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var v = dt > 0 && dt < 120 ? dist / Math.max(dt, 4) : 0;
        ax += dx * gain(v, cfg.xGain);
        ay += dy * gain(v, cfg.yGain);
        var nx = Math.abs(ax) / cfg.xStep, ny = Math.abs(ay) / cfg.yStep;
        var wx = nx * (axis === 'x' ? cfg.lock : 1), wy = ny * (axis === 'y' ? cfg.lock : 1);
        var n;
        if (wx >= wy) {
          if (nx < 1) return { axis: null, n: 0 };
          n = ax < 0 ? Math.ceil(ax / cfg.xStep) : Math.floor(ax / cfg.xStep);
          ax -= n * cfg.xStep; ay = 0; axis = 'x';
        } else {
          if (ny < 1) return { axis: null, n: 0 };
          n = ay < 0 ? Math.ceil(ay / cfg.yStep) : Math.floor(ay / cfg.yStep);
          ay -= n * cfg.yStep; ax = 0; axis = 'y';
        }
        if (n > cfg.maxSteps) n = cfg.maxSteps;
        if (n < -cfg.maxSteps) n = -cfg.maxSteps;
        return { axis: axis, n: n };
      },
    };
  }

  // Hold-to-repeat: the i-th wait (0 = the first, after the initial press).
  function repeatDelay(i) { return i === 0 ? CFG.repeatDelay : CFG.repeatEvery; }
  // How many steps a press held for `ms` has produced (the press itself is one).
  function repeatCount(ms) {
    if (!(ms >= CFG.repeatDelay)) return 1;
    return 2 + Math.floor((ms - CFG.repeatDelay) / CFG.repeatEvery);
  }

  // Soft keyboard open? vvH = visualViewport.height, baseH = the layout
  // viewport height (unchanged by the keyboard on iOS / Android Chrome).
  function keyboardOpen(vvH, baseH, scale, ratio) {
    if (!(vvH > 0) || !(baseH > 0)) return false;
    return vvH * (scale > 0 ? scale : 1) < baseH * (ratio || CFG.kbRatio);
  }

  function isTap(moved, steps, dur) { return !steps && moved < CFG.tapSlop && dur < CFG.tapMs; }
  // Multi-tap counting: prev = the last tap { up, x, y, n } (or null); this tap
  // went down at `down`, up at `up`. Returns this tap's record (n: 1, 2, 3, 1…).
  function nextTap(prev, down, up, x, y) {
    var n = 1;
    if (prev && down - prev.up <= CFG.tapGap && Math.abs(x - prev.x) <= CFG.multiSlop && Math.abs(y - prev.y) <= CFG.multiSlop) {
      n = prev.n >= 3 ? 1 : prev.n + 1;
    }
    return { up: up, x: x, y: y, n: n };
  }

  var api = { CFG: CFG, gain: gain, makeTracker: makeTracker, repeatDelay: repeatDelay, repeatCount: repeatCount, keyboardOpen: keyboardOpen, isTap: isTap, nextTap: nextTap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ---- runtime ---------------------------------------------------------------
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.EditorView) return;
  var BASE = Cade.baseURL();
  var STORE_KEY = 'cade-thumbpad-collapsed';

  var S = {
    view: null, refs: 0, stopT: 0, running: false,
    mq: null, coarse: false, attached: false, forced: null,
    anchor: null, root: null, pad: null, glow: null, hint: null, selBtn: null,
    visible: false, collapsed: false, selOn: false,
    refreshT: 0, raf: 0, margins: null, tap: null, buzzAt: 0, pulseAt: 0, gx: 0, gy: 0,
  };
  var L = [];                       // [target, type, fn, opts] — everything we listen to
  var G = null;                     // the active press
  var tracker = makeTracker();
  var cssDone = false;

  function on(t, type, fn, opts) { if (!t) return; t.addEventListener(type, fn, opts); L.push([t, type, fn, opts]); }
  function offAll() {
    for (var i = 0; i < L.length; i++) { try { L[i][0].removeEventListener(L[i][1], L[i][2], L[i][3]); } catch (e) {} }
    L = [];
  }
  function loadCSS() {
    if (cssDone) return;
    cssDone = true;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = BASE + 'thumbpad.css';
    document.head.appendChild(l);
  }
  function store() { try { return Cade.store; } catch (e) { return null; } }

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
    if (!S.refs && S.running && !S.stopT) S.stopT = setTimeout(function () { S.stopT = 0; if (!S.refs) stopAll(); }, 0);
  }
  function stopAll() {
    detach();
    if (S.mq) {
      if (S.mq.removeEventListener) S.mq.removeEventListener('change', onMQ);
      else if (S.mq.removeListener) S.mq.removeListener(onMQ);
    }
    S.mq = null; S.coarse = false; S.running = false; S.view = null;
  }
  function onMQ() {
    S.coarse = !!(S.mq && S.mq.matches);
    if (S.coarse) attach(); else detach();
  }
  function attach() {
    if (S.attached || !S.view) return;
    S.attached = true;
    loadCSS();
    var st = store();
    S.collapsed = !!(st && st.get(STORE_KEY) === '1');
    if (window.visualViewport) on(window.visualViewport, 'resize', onViewport);
    on(window, 'orientationchange', onViewport);
    on(S.view.contentDOM, 'focus', scheduleRefresh);
    on(S.view.contentDOM, 'blur', scheduleRefresh);
    scheduleRefresh();
  }
  function detach() {
    if (!S.attached && !S.anchor) return;
    S.attached = false;
    hide();
    if (S.refreshT) { clearTimeout(S.refreshT); S.refreshT = 0; }
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    offAll();
    if (S.anchor && S.anchor.parentNode) S.anchor.parentNode.removeChild(S.anchor);
    S.anchor = S.root = S.pad = S.glow = S.hint = S.selBtn = null;
    S.tap = null;
  }

  // ---- visibility -------------------------------------------------------------
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
    var was = S.visible;
    if (!was) {
      S.visible = true;
      S.anchor.hidden = false;
      document.body.classList.add('cade-tp-on');
    }
    measure();
    if (was) return;
    // The pad now covers the editor's bottom edge: keep a bare caret clear of
    // it (once, when it appears — later viewport resizes leave the scroll alone).
    var v = S.view, r = v.state.selection.main;
    if (r.empty) { try { v.dispatch({ effects: CM.EditorView.scrollIntoView(r.head, { y: 'nearest', yMargin: 8 }) }); } catch (e) {} }
  }
  function hide() {
    endPress(true);
    if (!S.visible) return;
    S.visible = false;
    if (S.anchor) S.anchor.hidden = true;
    document.body.classList.remove('cade-tp-on');
    setSel(false, true);
  }
  // Space the pad (and the floating toolbar at the top) take from the editor's
  // scroll area, for EditorView.scrollMargins.
  function measure() {
    var v = S.view, m = { top: 0, bottom: 0 };
    try {
      var sr = v.scrollDOM.getBoundingClientRect();
      m.bottom = Math.max(0, sr.bottom - S.root.getBoundingClientRect().top) + 8;
      var tb = document.getElementById('mobile-toolbar');
      if (tb && tb.offsetParent !== null) m.top = Math.max(0, Math.min(80, tb.getBoundingClientRect().bottom - sr.top));
    } catch (e) {}
    S.margins = m;
  }
  function marginsFor(view) {
    if (!S.visible || view !== S.view || !S.margins || document.body.classList.contains('sel-mode')) return null;
    return S.margins;
  }

  // ---- DOM ----------------------------------------------------------------------
  var ICON = {
    wl: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 12H9m4.5-5L8.5 12l5 5"/></svg>',
    wr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M5 12h10m-4.5-5 5 5-5 5"/></svg>',
    col: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6"/></svg>',
    exp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14.5 6-6 6 6"/><path d="M8 19h8" opacity=".55"/></svg>',
  };
  function btn(a, cls, label, html) {
    return '<button type="button" tabindex="-1" class="cade-tp-b ' + cls + '" data-a="' + a + '" aria-label="' + label + '" title="' + label + '">' + html + '</button>';
  }
  function build() {
    if (S.anchor) return;
    var anchor = document.createElement('div');
    anchor.className = 'cade-tp-anchor';
    anchor.hidden = true;
    anchor.innerHTML =
      '<div class="cade-tp' + (S.collapsed ? ' collapsed' : '') + '" role="toolbar" aria-label="Cursor pad">' +
        btn('wl', 'cade-tp-word', 'Previous word', ICON.wl) +
        '<div class="cade-tp-pad" data-a="pad" aria-hidden="true"><span class="cade-tp-hint">slide to move</span><i class="cade-tp-glow"></i></div>' +
        btn('wr', 'cade-tp-word', 'Next word', ICON.wr) +
        '<button type="button" tabindex="-1" class="cade-tp-b cade-tp-sel" data-a="sel" aria-pressed="false" title="Select: moves extend the selection">Select</button>' +
        btn('col', 'cade-tp-col', 'Hide the cursor pad', ICON.col) +
        btn('exp', 'cade-tp-handle', 'Show the cursor pad', ICON.exp) +
      '</div>';
    document.body.appendChild(anchor);
    S.anchor = anchor;
    S.root = anchor.firstChild;
    S.pad = S.root.querySelector('.cade-tp-pad');
    S.glow = S.root.querySelector('.cade-tp-glow');
    S.hint = S.root.querySelector('.cade-tp-hint');
    S.selBtn = S.root.querySelector('.cade-tp-sel');
    var r = S.root;
    on(r, 'touchstart', onTouchStart, { passive: false });
    on(r, 'touchmove', onTouchMove, { passive: false });
    on(r, 'touchend', onTouchEnd, { passive: false });
    on(r, 'touchcancel', onTouchEnd, { passive: false });
    on(r, 'pointerdown', onPointerDown);
    on(r, 'pointermove', onPointerMove);
    on(r, 'pointerup', onPointerUp);
    on(r, 'pointercancel', onPointerUp);
    on(r, 'mousedown', prevent);
    on(r, 'click', prevent);
    on(r, 'contextmenu', prevent);
  }
  function prevent(e) { e.preventDefault(); }
  function setHint() {
    if (S.hint) S.hint.textContent = (G && G.ext) || S.selOn ? 'slide to select' : 'slide to move';
  }
  function setSel(onOff, quiet) {
    onOff = !!onOff;
    if (S.selOn === onOff) return;
    S.selOn = onOff;
    if (S.selBtn) { S.selBtn.classList.toggle('on', onOff); S.selBtn.setAttribute('aria-pressed', onOff ? 'true' : 'false'); }
    if (S.root) S.root.classList.toggle('selecting', onOff);
    setHint();
    if (quiet) return;
    buzz(8, true);
    if (!onOff && S.view) {             // tapping it off collapses to the head
      var r = S.view.state.selection.main;
      if (!r.empty) select(ES().cursor(r.head));
    }
  }
  function setCollapsed(c) {
    S.collapsed = !!c;
    var st = store();
    try { if (st) st.set(STORE_KEY, S.collapsed ? '1' : '0'); } catch (e) {}
    if (S.root) S.root.classList.toggle('collapsed', S.collapsed);
    if (S.collapsed) setSel(false, true);
    if (S.visible) measure();
    buzz(8, true);
  }

  // ---- input ------------------------------------------------------------------
  // Touch events drive it (they also let us keep focus: a cancelled touchstart
  // never blurs the editor or synthesises a click); pointer events only for a
  // mouse / trackpad on a touch device.
  function findTouch(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }
  function onTouchStart(e) {
    e.preventDefault();
    if (G) return;                      // one finger at a time
    var t = e.changedTouches[0];
    if (t) begin('t' + t.identifier, e.target, t.clientX, t.clientY, stamp(e));
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (!G) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if ('t' + t.identifier === G.id) { motion(t.clientX, t.clientY, stamp(e)); return; }
    }
  }
  function onTouchEnd(e) {
    e.preventDefault();
    if (!G) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      if ('t' + e.changedTouches[i].identifier === G.id) { finish(e.type === 'touchcancel', stamp(e)); return; }
    }
  }
  function onPointerDown(e) {
    e.preventDefault();                 // keeps the editor focused
    if (e.pointerType === 'touch' || G) return;
    try { S.root.setPointerCapture(e.pointerId); } catch (x) {}
    begin('p' + e.pointerId, e.target, e.clientX, e.clientY, stamp(e));
  }
  function onPointerMove(e) { if (G && G.id === 'p' + e.pointerId) motion(e.clientX, e.clientY, stamp(e)); }
  function onPointerUp(e) { if (G && G.id === 'p' + e.pointerId) finish(e.type === 'pointercancel', stamp(e)); }
  function stamp(e) { return e.timeStamp > 0 ? e.timeStamp : (window.performance ? performance.now() : Date.now()); }
  function composing() { var v = S.view; return !!(v && (v.composing || v.compositionStarted)); }

  function begin(id, target, x, y, t) {
    var el = target && target.closest ? target.closest('[data-a]') : null;
    if (!el || !S.root || !S.root.contains(el) || !S.view) return;
    var a = el.getAttribute('data-a');
    G = { id: id, a: a, el: el, x0: x, y0: y, lx: x, ly: y, lt: t, t0: t, steps: 0, moved: 0, ext: false, lpT: 0, repT: 0, repN: 0 };
    el.classList.add('is-down');
    if (a === 'pad') {
      tracker.reset();
      G.lpT = setTimeout(longPress, CFG.longPress);
    } else if (a === 'wl' || a === 'wr') {
      var fwd = a === 'wr';
      moveBy('w', fwd ? 1 : -1, S.selOn);
      var g = G;
      var tick = function () {
        if (G !== g) return;
        moveBy('w', fwd ? 1 : -1, S.selOn);
        g.repN++;
        g.repT = setTimeout(tick, repeatDelay(g.repN));
      };
      g.repT = setTimeout(tick, repeatDelay(0));
    }
  }
  function motion(x, y, t) {
    var g = G, dx = x - g.x0, dy = y - g.y0;
    g.moved = Math.max(g.moved, Math.sqrt(dx * dx + dy * dy));
    if (g.a === 'pad') {
      if (g.lpT && g.moved >= CFG.tapSlop) { clearTimeout(g.lpT); g.lpT = 0; }
      var r = tracker.move(x - g.lx, y - g.ly, t - g.lt);
      g.lx = x; g.ly = y; g.lt = t;
      if (r.n && moveBy(r.axis, r.n, S.selOn || g.ext)) g.steps += Math.abs(r.n);
    } else if (g.moved > 44 && g.repT) {       // slid off a word button: stop repeating
      clearTimeout(g.repT); g.repT = 0;
    }
  }
  function longPress() {
    var g = G;
    if (!g) return;
    g.lpT = 0;
    g.ext = true;
    S.root.classList.add('extending');
    setHint();
    buzz(12, true);
  }
  function finish(cancelled, t) {
    var g = G;
    endPress(false);
    if (!g || cancelled) return;
    if (g.a === 'pad') {
      if (!g.ext && isTap(g.moved, g.steps, t - g.t0)) {
        S.tap = nextTap(S.tap, g.t0, t, g.x0, g.y0);
        if (S.tap.n === 2) selectWord();
        else if (S.tap.n === 3) selectLine();
      } else S.tap = null;
    } else if (g.moved < 30) {
      if (g.a === 'sel') setSel(!S.selOn);
      else if (g.a === 'col') setCollapsed(true);
      else if (g.a === 'exp') setCollapsed(false);
    }
  }
  function endPress(drop) {
    var g = G;
    if (!g) return;
    G = null;
    if (g.lpT) clearTimeout(g.lpT);
    if (g.repT) clearTimeout(g.repT);
    if (g.el) g.el.classList.remove('is-down');
    if (g.ext && S.root) { S.root.classList.remove('extending'); setHint(); }
    if (drop) S.tap = null;
  }

  // ---- caret / selection ------------------------------------------------------
  function ES() { return S.view.state.selection.constructor; }   // EditorSelection (not exported by the core)
  function select(range) {
    var v = S.view;
    v.dispatch({
      selection: v.state.selection.replaceRange(range),
      effects: CM.EditorView.scrollIntoView(range.head, { y: 'nearest', yMargin: 8 }),
      userEvent: 'select',
    });
  }
  // axis: 'x' chars, 'y' lines, 'w' word groups; n signed. Returns whether the caret moved.
  function moveBy(axis, n, extend) {
    var v = S.view;
    if (!v || !n || composing()) return false;
    var r = v.state.selection.main, E = ES(), fwd = n > 0, k = Math.min(Math.abs(n), CFG.maxSteps), cur = r;
    if (!extend && !r.empty) {          // like an arrow key: a selection collapses to its edge first
      cur = E.cursor(fwd ? r.to : r.from);
      if (axis !== 'y') k--;
    }
    for (var i = 0; i < k; i++) {
      var nx = axis === 'x' ? v.moveByChar(cur, fwd) : axis === 'y' ? v.moveVertically(cur, fwd) : v.moveByGroup(cur, fwd);
      if (nx.head === cur.head) break;  // start / end of the document
      cur = nx;
    }
    var out = extend ? E.range(r.anchor, cur.head, cur.goalColumn) : (cur.empty ? cur : E.cursor(cur.head));
    if (out.anchor === r.anchor && out.head === r.head) return false;
    select(out);
    feedback(axis, fwd ? 1 : -1);
    return true;
  }
  function selectWord() {
    var v = S.view, st = v.state, h = st.selection.main.head;
    var w = st.wordAt(h) || (h > 0 ? st.wordAt(h - 1) : null);
    if (!w || composing()) return;
    select(ES().range(w.from, w.to));
    buzz(10, true);
  }
  function selectLine() {
    var v = S.view, line = v.state.doc.lineAt(v.state.selection.main.head);
    if (composing()) return;
    select(ES().range(line.from, line.to));
    buzz(10, true);
  }

  // ---- feedback: a light tick + a short glow; the grip dots drift with the move ----
  function buzz(ms, force) {
    var now = Date.now();
    if (!force && now - S.buzzAt < 40) return;
    S.buzzAt = now;
    try { Cade.haptic(ms); } catch (e) {}
  }
  function feedback(axis, dir) {
    buzz(5, false);
    if (S.pad && axis !== 'w') {
      if (axis === 'x') S.gx = (S.gx + dir * 2 + 8) % 8; else S.gy = (S.gy + dir * 3 + 9) % 9;
      S.pad.style.setProperty('--tp-g', S.gx + 'px ' + S.gy + 'px');
    }
    var now = Date.now();
    if (S.glow && S.glow.animate && now - S.pulseAt > 70) {
      S.pulseAt = now;
      try { S.glow.animate([{ opacity: 0.22 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' }); } catch (e) {}
    }
  }

  // ---- debug / test hook ------------------------------------------------------------
  window.__cadeThumbpad = {
    force: function (v) { S.forced = v == null ? null : !!v; if (S.attached) refresh(); return S.forced; },
    state: function () {
      return { running: S.running, coarse: S.coarse, attached: S.attached, visible: S.visible, collapsed: S.collapsed, selOn: S.selOn, forced: S.forced, listeners: L.length, mediaListener: !!S.mq, margins: S.margins };
    },
  };

  var plugin = CM.ViewPlugin.define(function (view) {
    start(view);
    return {
      update: function (u) { if (u.focusChanged) scheduleRefresh(); },
      destroy: release,
    };
  });
  var ext = [plugin];
  if (CM.EditorView.scrollMargins) ext.push(CM.EditorView.scrollMargins.of(marginsFor));
  Cade.registerPlugin({ id: 'thumbpad', ext: ext });
})();
