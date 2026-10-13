/* Live HTML Preview — renders the ```html block at the cursor (plus the
 * ```css and ```js / ```javascript blocks right before / after it in the same
 * section) in a sandboxed iframe that updates as you type.
 *
 * - Sandbox: allow-scripts allow-modals allow-forms allow-popups, never
 *   allow-same-origin, so the page can't reach the app, its storage or cookies.
 *   Loop checks stop a script that hangs (Safari runs iframes on the app's
 *   thread, so a frozen preview would freeze the editor too).
 * - A full HTML document in one block works too (css / js blocks are appended).
 * - Debounced live update (300 ms) while the panel is open; the editor hook is
 *   a single early return while it is closed. Scroll position survives updates.
 * - Device presets (fit / phone / tablet / desktop) in a scaled frame, console
 *   strip (log / warn / error / uncaught errors with editor line numbers),
 *   reload, pin to a block, open in a new tab, copy as one HTML file.
 * - Floating (resizable), docked right, docked bottom or full screen; phones
 *   default to full screen.
 * Shares the sandbox kit with the Code Runner (widgets/coderun/coderun-kit.js).
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('htmlpreview.css');

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var BASE = Cade.baseURL();
  var KIT_URL = abs(/widgets\/htmlpreview\/$/.test(BASE) ? BASE.replace(/widgets\/htmlpreview\/$/, 'widgets/coderun/coderun-kit.js') : './txt/widgets/coderun/coderun-kit.js');

  var PANEL_ID = 'htmlpreview-panel';
  var PREFS_KEY = 'cade-htmlpreview-prefs';
  var SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups';
  var DEVICES = {
    fit: { label: 'Fit' },
    phone: { w: 390, h: 844, label: 'Phone' },
    tablet: { w: 820, h: 1180, label: 'Tablet' },
    desktop: { w: 1280, h: 800, label: 'Desktop' }
  };
  var DOCKS = ['float', 'side', 'bottom', 'full'];
  var MAX_CON = 300;
  var WEB = { html: 1, css: 1, js: 1 };

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, type, ms) { try { Cade.showToast(m, type || 'info', ms || 2200); } catch (e) {} }
  function isPhone() { try { return window.matchMedia('(max-width: 560px)').matches; } catch (e) { return false; } }

  var prefs = { device: 'fit', dock: 'float', dockPhone: 'full', con: true, fw: 0, fh: 0, sideW: 0, botH: 0 };
  (function () {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      for (var k in prefs) if (p[k] !== undefined && typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
      if (!DEVICES[prefs.device]) prefs.device = 'fit';
      if (DOCKS.indexOf(prefs.dock) < 0) prefs.dock = 'float';
      if (prefs.dockPhone !== 'bottom') prefs.dockPhone = 'full';
    } catch (e) {}
  })();
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  var K = null, kitP = null;
  function loadKit() {
    if (window.__cadeCodeRunKit) { K = window.__cadeCodeRunKit; return Promise.resolve(K); }
    if (kitP) return kitP;
    var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});
    kitP = L[KIT_URL] || (L[KIT_URL] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = KIT_URL; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete L[KIT_URL]; rej(new Error('Preview failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
    kitP = kitP.then(function () { K = window.__cadeCodeRunKit; if (!K) throw new Error('Preview failed to start'); return K; }, function (e) { kitP = null; throw e; });
    return kitP;
  }

  // ---- state ---------------------------------------------------------------------------------
  var panel = null, ifr = null, ro = null, timer = 0, keyHandler = null;
  var st = null; // per-open state
  function freshState() {
    return { anchor: null, pinned: false, key: '', token: '', scroll: null, cache: { doc: null, blocks: null },
      con: [], errs: 0, built: null, label: '' };
  }

  // ---- blocks ------------------------------------------------------------------------------------
  function blocksOf(doc) {
    if (st.cache.doc !== doc) st.cache = { doc: doc, blocks: K.scanFences(doc).filter(function (b) { return b.lang !== 'output'; }) };
    return st.cache.blocks;
  }
  function web(b) { return !!b && WEB[b.lang] === 1; }
  // No heading / rule between two blocks, and not too far apart: same section.
  function gapOk(doc, a, b) {
    if (a.close === -1) return false;
    if (b.open - a.close > 80) return false;
    for (var i = a.close + 1; i < b.open; i++) {
      var t = doc.line(i).text;
      if (/^#{1,6}\s/.test(t) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t)) return false;
    }
    return true;
  }
  function chainAround(doc, blocks, i) {
    var lo = i, hi = i, hasHtml = blocks[i].lang === 'html';
    while (lo > 0 && web(blocks[lo - 1]) && gapOk(doc, blocks[lo - 1], blocks[lo]) && !(hasHtml && blocks[lo - 1].lang === 'html')) {
      lo--; if (blocks[lo].lang === 'html') hasHtml = true;
    }
    while (hi < blocks.length - 1 && web(blocks[hi + 1]) && gapOk(doc, blocks[hi], blocks[hi + 1]) && !(hasHtml && blocks[hi + 1].lang === 'html')) {
      hi++; if (blocks[hi].lang === 'html') hasHtml = true;
    }
    return blocks.slice(lo, hi + 1);
  }
  function indexOfOpen(blocks, openFrom) {
    for (var i = 0; i < blocks.length; i++) if (blocks[i].openFrom === openFrom) return i;
    return -1;
  }
  // Which block the preview follows: pinned anchor > web block at the cursor >
  // previous anchor > nearest html block above the cursor > first html block.
  function pickAnchor(doc, blocks) {
    var ed = Cade.editor, i;
    if (st.anchor && st.anchor.doc === doc) {
      i = indexOfOpen(blocks, st.anchor.openFrom);
      if (i >= 0 && web(blocks[i]) && st.pinned) return i;
    } else if (st.anchor) { st.anchor = null; st.pinned = false; }
    var line = doc.lineAt(Math.min(ed.state.selection.main.head, doc.length)).number;
    var b = K.blockAt(blocks, line);
    if (web(b)) { st.anchor = { openFrom: b.openFrom, doc: doc }; return K.blockIndex(blocks, b); }
    if (st.anchor) { i = indexOfOpen(blocks, st.anchor.openFrom); if (i >= 0 && web(blocks[i])) return i; }
    var best = -1;
    for (i = 0; i < blocks.length; i++) {
      if (blocks[i].lang !== 'html') continue;
      if (blocks[i].open <= line || best < 0) best = i;
      if (blocks[i].open > line) break;
    }
    if (best >= 0) st.anchor = { openFrom: blocks[best].openFrom, doc: doc };
    return best;
  }
  function collect(doc) {
    var blocks = blocksOf(doc), i = pickAnchor(doc, blocks);
    if (i < 0) return null;
    var chain = chainAround(doc, blocks, i), parts = { html: null, css: [], js: [] }, label = [];
    chain.forEach(function (b) {
      var c = K.codeOf(doc, b), item = { text: c.text, line: c.firstLine };
      if (b.lang === 'html') { if (!parts.html) parts.html = item; else return; }
      else parts[b.lang].push(item);
      label.push(b.lang + ' ' + b.open);
    });
    return { parts: parts, label: label };
  }

  // ---- rendering --------------------------------------------------------------------------------
  function refresh(force) {
    timer = 0;
    var ed = Cade.editor;
    if (!panel || !K || !ed || !ifr) return;
    var c = collect(ed.state.doc);
    if (!c) { // no html / css / js block left in the room
      st.key = ''; st.built = null;
      setLabel([]);
      showEmpty(true);
      return;
    }
    var key = JSON.stringify(c.parts);
    st.label = c.label.join(' + ');
    if (!force && key === st.key) { setLabel(c.label); return; }
    st.key = key;
    st.token = 'hp' + Math.random().toString(36).slice(2);
    var built;
    try { built = K.buildPreviewDoc(c.parts, { token: st.token, scroll: st.scroll }); }
    catch (e) { toast('Preview failed: ' + (e && e.message), 'error'); return; }
    st.built = built;
    showEmpty(false);
    setLabel(c.label);
    clearConsole();
    ifr.srcdoc = built.html;
  }
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { refresh(false); }, ms);
  }
  function setLabel(label) {
    var el = panel && panel.querySelector('.hp-src-text');
    if (!el) return;
    el.textContent = label.length ? label.map(function (s) { var p = s.split(' '); return p[0] + ' · line ' + p[1]; }).join('  +  ') : '';
    panel.classList.toggle('hp-pinned', st.pinned);
  }
  function showEmpty(on) {
    var e = panel && panel.querySelector('.hp-empty');
    if (e) e.hidden = !on;
    var f = panel && panel.querySelector('.hp-frame');
    if (f) f.style.visibility = on ? 'hidden' : '';
  }

  // Editor hook: registered once; costs one check while the panel is closed.
  Cade.onEditorUpdate(function (u) {
    if (!panel || !st) return;
    if (u.docChanged) {
      if (st.anchor && st.anchor.doc === u.startState.doc) {
        st.anchor.openFrom = u.changes.mapPos(st.anchor.openFrom, 1);
        st.anchor.doc = u.state.doc;
      }
      schedule(300);
    } else if (u.selectionSet && !st.pinned) schedule(150);
  });

  // ---- console strip -------------------------------------------------------------------------------
  function clearConsole() {
    st.con = []; st.errs = 0;
    renderConsole();
  }
  function renderConsole() {
    if (!panel) return;
    var list = panel.querySelector('.hp-con-list'), badge = panel.querySelector('.hp-badge');
    var n = st.con.length;
    badge.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
    badge.className = 'hp-badge' + (st.errs ? ' err' : '');
    if (panel.querySelector('.hp-console').hidden) return;
    list.innerHTML = n ? '' : '<div class="hp-con-empty">No console output.</div>';
    var frag = document.createDocumentFragment();
    st.con.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'hp-con-row hp-' + c[0];
      d.textContent = c[1];
      frag.appendChild(d);
    });
    list.appendChild(frag);
    list.scrollTop = list.scrollHeight;
  }
  var conT = 0;
  function onMessage(e) {
    if (!ifr || e.source !== ifr.contentWindow) return;
    var m = e.data;
    if (!m || m.__cr !== st.token) return;
    if (m.type === 'out' && m.items) {
      m.items.forEach(function (it) {
        var lv = String(it[0]), t = String(it[1]);
        if (lv === 'sys') lv = /^[✖⏱]/.test(t) ? 'error' : 'log';
        if (lv === 'error') st.errs++;
        st.con.push([lv, t]);
      });
      if (st.con.length > MAX_CON) st.con.splice(0, st.con.length - MAX_CON);
      if (!conT) conT = setTimeout(function () { conT = 0; renderConsole(); }, 60);
    } else if (m.type === 'clear') clearConsole();
    else if (m.type === 'scroll') st.scroll = [+m.x || 0, +m.y || 0];
  }

  // ---- device frame -------------------------------------------------------------------------------
  function layoutFrame() {
    if (!panel || !ifr) return;
    var stage = panel.querySelector('.hp-stage'), frame = panel.querySelector('.hp-frame'), size = panel.querySelector('.hp-size');
    if (!panel.classList.contains('hp-' + dockNow())) { applyDock(); return; } // crossed the phone breakpoint
    var d = DEVICES[prefs.device] || DEVICES.fit;
    panel.classList.toggle('hp-dev', !!d.w);
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!d.w) {
      frame.style.width = '100%'; frame.style.height = '100%';
      ifr.style.width = '100%'; ifr.style.height = '100%'; ifr.style.transform = '';
      size.textContent = W && H ? Math.round(W) + ' × ' + Math.round(H) : '';
      return;
    }
    var s = Math.min(1, (W - 16) / d.w, (H - 16) / d.h);
    if (!(s > 0)) s = 0.25;
    frame.style.width = Math.round(d.w * s) + 'px';
    frame.style.height = Math.round(d.h * s) + 'px';
    ifr.style.width = d.w + 'px';
    ifr.style.height = d.h + 'px';
    ifr.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    size.textContent = d.w + ' × ' + d.h + (s < 1 ? ' · ' + Math.round(s * 100) + '%' : '');
  }

  // ---- docking & resizing ---------------------------------------------------------------------------
  function dockNow() { return isPhone() ? prefs.dockPhone : prefs.dock; }
  function applyDock() {
    if (!panel) return;
    var d = dockNow();
    DOCKS.forEach(function (x) { panel.classList.toggle('hp-' + x, x === d); });
    var s = panel.style;
    if (d === 'float') {
      if (prefs.fw) s.width = Math.min(prefs.fw, window.innerWidth - 24) + 'px';
      if (prefs.fh) s.height = Math.min(prefs.fh, window.innerHeight - 70) + 'px';
    } else {
      s.left = ''; s.top = ''; s.right = ''; s.bottom = '';
      s.width = d === 'side' && prefs.sideW ? Math.min(prefs.sideW, window.innerWidth - 60) + 'px' : '';
      s.height = d === 'bottom' && prefs.botH ? Math.min(prefs.botH, window.innerHeight - 80) + 'px' : '';
    }
    var btns = panel.querySelectorAll('[data-dock]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-dock') === d);
    setTimeout(layoutFrame, 0);
  }
  function setDock(d) {
    if (isPhone()) { if (d === 'full' || d === 'bottom') prefs.dockPhone = d; }
    else prefs.dock = d;
    savePrefs();
    applyDock();
  }
  // One handle; what it resizes depends on the dock mode.
  function startResize(e) {
    var d = dockNow();
    if (d === 'full') return;
    e.preventDefault(); e.stopPropagation();
    var r = panel.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, h = e.currentTarget;
    if (d === 'float') { panel.style.right = 'auto'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; }
    panel.classList.add('hp-resizing');
    try { h.setPointerCapture(e.pointerId); } catch (x) {}
    function move(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (d === 'float') {
        panel.style.width = Math.max(280, Math.min(window.innerWidth - r.left - 4, r.width + dx)) + 'px';
        panel.style.height = Math.max(220, Math.min(window.innerHeight - r.top - 4, r.height + dy)) + 'px';
      } else if (d === 'side') panel.style.width = Math.max(280, Math.min(window.innerWidth - 60, r.width - dx)) + 'px';
      else if (d === 'bottom') panel.style.height = Math.max(160, Math.min(window.innerHeight - 80, r.height - dy)) + 'px';
      layoutFrame();
    }
    function up() {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      panel.classList.remove('hp-resizing');
      var nr = panel.getBoundingClientRect();
      if (d === 'float') { prefs.fw = Math.round(nr.width); prefs.fh = Math.round(nr.height); }
      else if (d === 'side') prefs.sideW = Math.round(nr.width);
      else if (d === 'bottom') prefs.botH = Math.round(nr.height);
      savePrefs();
    }
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  }

  // ---- actions ---------------------------------------------------------------------------------------
  function copyText(s, what) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        toast(what + ' copied', 'success', 1500);
      } catch (e) { toast('Copy failed', 'error'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(function () { toast(what + ' copied', 'success', 1500); }, fallback);
    else fallback();
  }
  // The page runs inside a sandboxed iframe of a tiny wrapper document, so the
  // new tab (same origin as the app, being a blob: URL) never runs user code
  // with the app's privileges.
  function openInTab() {
    if (!st.built) { toast('Nothing to open yet', 'info'); return; }
    var attr = st.built.html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var title = (st.label || 'Preview');
    var wrapper = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Preview</title><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>' +
      '<body><iframe sandbox="' + SANDBOX + '" title="' + esc(title) + '" srcdoc="' + attr + '"></iframe></body></html>';
    var url;
    try { url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' })); } catch (e) { toast("Can't open a new tab here", 'error'); return; }
    var w = window.open(url, '_blank');
    if (!w) toast('Pop-up blocked — allow pop-ups to open the preview in a tab', 'error', 3500);
    else { try { w.opener = null; } catch (e) {} }
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 120000);
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act],[data-dev],[data-dock]') : null;
    if (!t) return;
    var dev = t.getAttribute('data-dev'), dock = t.getAttribute('data-dock'), act = t.getAttribute('data-act');
    if (dev) {
      prefs.device = dev; savePrefs();
      markDevice();
      layoutFrame();
    } else if (dock) setDock(dock);
    else if (act === 'reload') { refresh(true); }
    else if (act === 'pin') {
      st.pinned = !st.pinned && !!st.anchor;
      t.classList.toggle('on', st.pinned);
      t.setAttribute('aria-pressed', st.pinned ? 'true' : 'false');
      panel.classList.toggle('hp-pinned', st.pinned);
      toast(st.pinned ? 'Pinned to this block' : 'Following the cursor', 'info', 1400);
      if (!st.pinned) schedule(0);
    } else if (act === 'console') {
      var c = panel.querySelector('.hp-console');
      c.hidden = !c.hidden;
      prefs.con = !c.hidden; savePrefs();
      t.classList.toggle('on', prefs.con);
      renderConsole();
      setTimeout(layoutFrame, 0);
    } else if (act === 'conclear') clearConsole();
    else if (act === 'tab') openInTab();
    else if (act === 'copy') { if (st.built) copyText(st.built.clean, 'HTML file'); else toast('Nothing to copy yet', 'info'); }
  }
  function markDevice() {
    var b = panel.querySelectorAll('[data-dev]');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].getAttribute('data-dev') === prefs.device);
  }

  var I = {
    fit: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    phone: '<svg viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.5h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    tablet: '<svg viewBox="0 0 16 16"><rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.5h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    desktop: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4M8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    pin: '<svg viewBox="0 0 16 16"><path d="M10 1.8l4.2 4.2-2.1.7-2.4 2.4.2 3.3-1.4 1.4-2.6-2.6L3 14.1l-1.1-.1L2 13l2.9-2.9-2.6-2.6 1.4-1.4 3.3.2 2.4-2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    reload: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    console: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tab: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    float: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="5" width="5" height="5" rx="1" fill="currentColor"/></svg>',
    side: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 2.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9z" fill="currentColor"/></svg>',
    bottom: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 8.5h13V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" fill="currentColor"/></svg>',
    full: '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function ib(attr, icon, title, extra) { return '<button type="button" class="hp-ib" ' + attr + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' + icon + (extra || '') + '</button>'; }
  function panelHTML() {
    return '<div class="hp-bar">' +
        '<div class="hp-seg" role="group" aria-label="Device size">' +
          ib('data-dev="fit"', I.fit, 'Fit the panel') + ib('data-dev="phone"', I.phone, 'Phone (390 × 844)') +
          ib('data-dev="tablet"', I.tablet, 'Tablet (820 × 1180)') + ib('data-dev="desktop"', I.desktop, 'Desktop (1280 × 800)') +
        '</div>' +
        '<span class="hp-sp"></span>' +
        ib('data-act="pin" aria-pressed="false"', I.pin, 'Pin to this block (stop following the cursor)') +
        ib('data-act="reload"', I.reload, 'Reload') +
        ib('data-act="console"', I.console, 'Console', '<span class="hp-badge"></span>') +
        ib('data-act="tab"', I.tab, 'Open in a new tab') +
        ib('data-act="copy"', I.copy, 'Copy as a single HTML file') +
        '<div class="hp-seg hp-docks" role="group" aria-label="Layout">' +
          ib('data-dock="float"', I.float, 'Floating window') + ib('data-dock="side"', I.side, 'Dock right') +
          ib('data-dock="bottom"', I.bottom, 'Dock bottom') + ib('data-dock="full"', I.full, 'Full screen') +
        '</div>' +
      '</div>' +
      '<div class="hp-src"><span class="hp-pin-dot" title="Pinned"></span><span class="hp-src-text"></span><span class="hp-size"></span></div>' +
      '<div class="hp-stage"><div class="hp-frame"></div>' +
        '<div class="hp-empty" hidden>Put the cursor in an <code>```html</code> block — <code>```css</code> and <code>```js</code> blocks right before or after it are included. A whole HTML document in one block works too.</div>' +
      '</div>' +
      '<div class="hp-console"' + (prefs.con ? '' : ' hidden') + '><div class="hp-con-head"><span>Console</span><button type="button" class="hp-link" data-act="conclear">Clear</button></div><div class="hp-con-list"></div></div>' +
      '<div class="hp-resize" title="Resize" aria-hidden="true"></div>';
  }

  function close() {
    if (!panel) return;
    var p = panel;
    p.remove();
    if (p._onClose) p._onClose();
  }
  function openPanel() {
    Cade.closeAllMenus();
    st = freshState();
    panel = Cade.mkPanel(PANEL_ID, 'Live HTML Preview', panelHTML());
    panel.classList.add('hp-panel');
    var body = panel.querySelector('.cade-panel-body');
    ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', SANDBOX); // never allow-same-origin
    ifr.setAttribute('title', 'Live preview');
    ifr.setAttribute('referrerpolicy', 'no-referrer');
    ifr.className = 'hp-iframe';
    panel.querySelector('.hp-frame').appendChild(ifr);
    markDevice();
    var cb = panel.querySelector('[data-act="console"]');
    if (cb) cb.classList.toggle('on', prefs.con);
    body.addEventListener('click', onClick);
    var handle = panel.querySelector('.hp-resize');
    handle.addEventListener('pointerdown', startResize);
    // While docked, dragging the title bar must not move the panel.
    panel.addEventListener('pointerdown', function (e) {
      if (dockNow() !== 'float' && e.target.closest && e.target.closest('.cade-panel-head') && !e.target.closest('.cade-panel-x')) e.stopPropagation();
    }, true);
    window.addEventListener('message', onMessage);
    keyHandler = function (e) {
      if (e.key === 'Escape' && panel && dockNow() === 'full' && !isPhone()) { e.preventDefault(); e.stopPropagation(); setDock('float'); }
    };
    document.addEventListener('keydown', keyHandler, true);
    var stage = panel.querySelector('.hp-stage');
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(function () { layoutFrame(); }); ro.observe(stage); }
    else window.addEventListener('resize', layoutFrame);
    applyDock();
    panel._onClose = function () {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('keydown', keyHandler, true);
      window.removeEventListener('resize', layoutFrame);
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      if (timer) { clearTimeout(timer); timer = 0; }
      if (conT) { clearTimeout(conT); conT = 0; }
      try { if (ifr) ifr.srcdoc = ''; } catch (e) {}
      ifr = null; panel = null; st = null; keyHandler = null;
    };
    var ready = function () { if (panel) refresh(true); };
    if (K) ready();
    else loadKit().then(ready, function (e) { toast(e.message, 'error', 3500); close(); });
  }
  function toggle() { if (panel) close(); else openPanel(); }

  // For the Code Runner: open (or retarget) the preview at an html/css block.
  window.__cadeHtmlPreview = {
    openAt: function (pos) {
      if (!panel) { openPanel(); return; }
      st.pinned = false;
      panel.classList.remove('hp-pinned');
      var pb = panel.querySelector('[data-act="pin"]');
      if (pb) pb.classList.remove('on');
      st.anchor = null;
      if (K) refresh(false);
    },
    isOpen: function () { return !!panel; }
  };

  Cade.registerWidget({
    name: 'Live HTML Preview',
    description: 'Live-render the ```html block at the cursor (+ nearby css / js) in a sandbox — devices, console, full screen',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><polyline points="9 12 7 14 9 16"/><polyline points="15 12 17 14 15 16"/></svg>',
    tags: 'html,css,js,javascript,preview,live,render,web,page,browser,sandbox,iframe,frontend,codepen,playground',
    open: toggle
  });
})();
