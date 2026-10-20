/* Live Preview — renders the note as you type, in a sandboxed iframe:
 *
 * - Markdown: the whole note, fully rendered (htmlpreview-md.js + marked,
 *   loaded on first use and kept offline in Cache Storage): headings, lists,
 *   tables, task boxes you can tick, callouts, highlights, spoilers, images,
 *   footnotes, code — and every ```html block as a live embedded page. Only
 *   changed blocks are swapped (no reload, scroll kept), the block at the
 *   cursor is marked and kept in view; double-click a block to jump there.
 * - HTML: the ```html block at the cursor (plus the ```css and ```js /
 *   ```javascript blocks right before / after it in the same section).
 * - Auto (default): HTML while the cursor is in an html / css / js block,
 *   Markdown everywhere else.
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
 *   reload, pin to a block, open in a new tab, print, copy as one HTML file.
 * - Tables (Markdown, ```csv / ```tsv blocks, or a note that is itself CSV /
 *   TSV) sort by a header click and get a filter box from 4 rows.
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

  var MD_URL = abs(Cade.asset('htmlpreview-md.js'));
  // marked (MIT) for the Markdown view: pinned, SHA-256-checked, kept in our own
  // Cache Storage bucket so it survives app updates and works offline (the File
  // Converter's bucket is checked first — same file).
  var MARKED = { url: 'https://cdn.jsdelivr.net/npm/marked@18.0.11/lib/marked.umd.js', sha256: '69451c8541c9c1e7a4bf3ffc6f73c4d89633de92bfbe3e484dfe182ef8091f88' };
  var MD_CACHE = 'cade-preview-v1';
  var MODES = ['auto', 'md', 'html'];
  var IMG_MIME = { j: 'image/jpeg', w: 'image/webp', a: 'image/avif' };
  var MD_MAX = 1500000; // characters rendered as Markdown

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

  var prefs = { device: 'fit', dock: 'float', dockPhone: 'full', con: true, fw: 0, fh: 0, sideW: 0, botH: 0, mode: 'auto', conMd: false };
  (function () {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      for (var k in prefs) if (p[k] !== undefined && typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
      if (!DEVICES[prefs.device]) prefs.device = 'fit';
      if (DOCKS.indexOf(prefs.dock) < 0) prefs.dock = 'float';
      if (prefs.dockPhone !== 'bottom') prefs.dockPhone = 'full';
      if (MODES.indexOf(prefs.mode) < 0) prefs.mode = 'auto';
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

  // ---- Markdown renderer (marked + htmlpreview-md.js), loaded on first use ----------------------
  var MDM = null, mdP = null;
  function hex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function markedText() {
    var cs = window.caches;
    var fromCache = function (name) { return cs ? cs.open(name).then(function (c) { return c.match(MARKED.url); }).then(function (r) { return r ? r.text() : null; }, function () { return null; }) : Promise.resolve(null); };
    return fromCache(MD_CACHE).then(function (t) { return t || fromCache('cade-convert-v1'); }).then(function (t) {
      if (t) return t;
      return fetch(MARKED.url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var check = window.crypto && window.crypto.subtle ? window.crypto.subtle.digest('SHA-256', buf).then(hex) : Promise.resolve(MARKED.sha256);
        return check.then(function (h) {
          if (h !== MARKED.sha256) throw new Error('the Markdown renderer failed its checksum');
          var text = new TextDecoder().decode(buf);
          if (cs) cs.open(MD_CACHE).then(function (c) { return c.put(MARKED.url, new Response(text, { headers: { 'Content-Type': 'text/javascript' } })); }).catch(function () {});
          return text;
        });
      });
    });
  }
  function addScript(src, text) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'), url = null;
      if (text != null) { try { url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); } catch (e) {} }
      s.src = url || src; s.async = false;
      s.onload = function () { if (url) URL.revokeObjectURL(url); res(); };
      s.onerror = function () { if (url) URL.revokeObjectURL(url); rej(new Error('Markdown preview failed to load (offline?)')); };
      document.head.appendChild(s);
    });
  }
  function loadMd() {
    if (MDM) return Promise.resolve(MDM);
    if (mdP) return mdP;
    var lib = window.marked && window.marked.Marked ? Promise.resolve() : markedText().then(function (t) { return addScript(MARKED.url, t); });
    mdP = Promise.all([lib, window.__cadeMdPreview ? 0 : addScript(MD_URL, null)]).then(function () {
      if (!window.marked || !window.marked.Marked || !window.__cadeMdPreview) throw new Error('Markdown preview failed to start');
      MDM = window.__cadeMdPreview.create(window.marked);
      return MDM;
    }, function (e) { mdP = null; throw new Error(/offline|HTTP|fetch|network/i.test(e.message) ? 'Markdown preview needs one online load (offline?)' : e.message); });
    return mdP;
  }

  // ---- state ---------------------------------------------------------------------------------
  var panel = null, ifr = null, ro = null, timer = 0, keyHandler = null, openOverride = '';
  var st = null; // per-open state
  function freshState() {
    return { anchor: null, pinned: false, key: '', token: '', scroll: null, cache: { doc: null, blocks: null },
      con: [], errs: 0, built: null, label: '', mode: '', modeOverride: '', md: null };
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
  function partsOf(doc, chain) {
    var parts = { html: null, css: [], js: [] }, label = [];
    chain.forEach(function (b) {
      var c = K.codeOf(doc, b), item = { text: c.text, line: c.firstLine };
      if (b.lang === 'html') { if (!parts.html) parts.html = item; else return; }
      else parts[b.lang].push(item);
      label.push(b.lang + ' ' + b.open);
    });
    return { parts: parts, label: label };
  }
  function collect(doc) {
    var blocks = blocksOf(doc), i = pickAnchor(doc, blocks);
    if (i < 0) return null;
    return partsOf(doc, chainAround(doc, blocks, i));
  }

  // ---- rendering --------------------------------------------------------------------------------
  function modePref() { return st.modeOverride || prefs.mode; }
  // The view to show now. Auto: HTML while the cursor is in an html / css / js
  // block (or the page view is pinned to one), Markdown everywhere else.
  function effectiveMode() {
    var m = modePref();
    if (m !== 'auto') return m;
    if (st.mode === 'html' && st.pinned && st.anchor) return 'html';
    var ed = Cade.editor, doc = ed.state.doc;
    var b = K.blockAt(blocksOf(doc), doc.lineAt(Math.min(ed.state.selection.main.head, doc.length)).number);
    return web(b) ? 'html' : 'md';
  }
  function refresh(force) {
    timer = 0;
    var ed = Cade.editor;
    if (!panel || !K || !ed || !ifr) return;
    if (Cade.isMinimized && Cade.isMinimized(panel)) return; // parked in the dock: catch up on restore
    if (Cade.roomAway && Cade.roomAway(panel)) return;       // locked to a room that isn't open: keep showing it
    var mode = effectiveMode();
    panel.classList.toggle('hp-mdmode', mode === 'md');
    markMode();
    if (mode === 'md') { refreshMd(force); return; }
    if (st.mode !== 'html') { leaveMd(); st.mode = 'html'; st.key = ''; markPin(); applyConsole(); }
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
  function setLabelText(t) {
    var el = panel && panel.querySelector('.hp-src-text');
    if (el) el.textContent = t;
    if (panel) panel.classList.toggle('hp-pinned', st.pinned);
  }
  function setLabel(label) {
    var el = panel && panel.querySelector('.hp-src-text');
    if (!el) return;
    el.textContent = label.length ? label.map(function (s) { var p = s.split(' '); return p[0] + ' · line ' + p[1]; }).join('  +  ') : '';
    panel.classList.toggle('hp-pinned', st.pinned);
  }
  var EMPTY_HTML = 'Put the cursor in an <code>```html</code> block — <code>```css</code> and <code>```js</code> blocks right before or after it are included. A whole HTML document in one block works too. Switch to <b>MD</b> (or <b>Auto</b>) to see the whole note rendered.';
  function showEmpty(on, text) {
    var e = panel && panel.querySelector('.hp-empty');
    if (e) {
      e.hidden = !on;
      var t = e.querySelector('.hp-empty-t');
      if (on && t) { if (text) t.textContent = text; else t.innerHTML = EMPTY_HTML; }
    }
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
      // Markdown re-renders the whole note: give long notes a little more breathing room
      schedule(st.mode === 'md' ? Math.min(1200, 250 + (u.state.doc.length >> 12)) : 300);
    } else if (u.selectionSet && !st.pinned) schedule(150);
  });

  // ---- Markdown view ----------------------------------------------------------------------------
  // One shell document stays in the iframe; blocks are swapped by key (see htmlpreview-md.js).
  function refreshMd(force) {
    if (!MDM) {
      showEmpty(true, 'Loading the Markdown renderer…');
      loadMd().then(function () { if (panel) refresh(true); }, function (e) { if (panel) showEmpty(true, e.message); });
      return;
    }
    var ed = Cade.editor, doc = ed.state.doc;
    if (st.mode !== 'md' || !st.md) startShell();
    showEmpty(false);
    var M = st.md;
    if (force || M.doc !== doc) {
      M.doc = doc; M.used = {}; M.usedImgs = {};
      var big = doc.length > MD_MAX;
      M.blocks = MDM.render(big ? doc.sliceString(0, MD_MAX) : doc.toString(), { embed: embedFor, image: imageFor });
      if (big) M.blocks.push({ k: 'cap', l: doc.lineAt(MD_MAX).number, h: '<p class="md-err">… the rest of this note (' + Math.round(doc.length / 1000) + 'k characters in all) is too long to preview.</p>' });
      Object.keys(M.embeds).forEach(function (k) { if (!M.used[k]) { delete M.embeds[k]; delete M.sentEmbeds[k]; } });
      Object.keys(M.imgs).forEach(function (k) { if (!M.usedImgs[k]) { delete M.imgs[k]; delete M.sentImgs[k]; } });
      resolveImages();
      sendRender();
      setLabelText('Markdown · ' + M.blocks.length + ' block' + (M.blocks.length === 1 ? '' : 's') + (modePref() === 'auto' ? '  (auto)' : ''));
    }
    syncLine(false);
  }
  function startShell() {
    leaveMd();
    st.mode = 'md'; st.key = ''; st.built = null;
    st.token = 'hp' + Math.random().toString(36).slice(2);
    st.md = { token: 'md' + Math.random().toString(36).slice(2), ready: false, keys: {}, doc: null, blocks: [], embeds: {}, sentEmbeds: {},
      imgs: {}, sentImgs: {}, pending: [], used: {}, usedImgs: {}, lastLine: 0, vars: themeVars(), mo: null };
    clearConsole();
    markPin();
    applyConsole();
    ifr.srcdoc = MDM.shellDoc(st.md.token, st.md.vars);
    watchTheme();
  }
  function leaveMd() {
    if (st.md && st.md.mo) { try { st.md.mo.disconnect(); } catch (e) {} }
    st.md = null;
  }
  function shellPost(m) {
    if (!st.md || !st.md.ready || !ifr || !ifr.contentWindow) return;
    m.__md = st.md.token;
    framePost(m);
  }
  function framePost(m) {
    try {
      // Popped out into its own window, that window is the frame's parent — and
      // the shell only listens to its parent: post as that window.
      var host = ifr.ownerDocument.defaultView;
      if (host && host !== window) {
        if (!host.__cadePost) host.__cadePost = new host.Function('w', 'm', 'w.postMessage(m, "*")');
        host.__cadePost(ifr.contentWindow, m);
      } else ifr.contentWindow.postMessage(m, '*');
    } catch (e) {}
  }
  function sendRender() {
    var M = st.md;
    if (!M || !M.ready) return; // the shell asks for everything when it is ready
    var add = [];
    Object.keys(M.embeds).forEach(function (ek) { if (!M.sentEmbeds[ek]) { M.sentEmbeds[ek] = 1; add.push({ ek: ek, html: M.embeds[ek].html }); } });
    if (add.length) shellPost({ type: 'embeds', list: add });
    var next = {};
    var list = M.blocks.map(function (b) { var known = M.keys[b.k]; next[b.k] = 1; return known ? { k: b.k, l: b.l } : b; });
    M.keys = next;
    shellPost({ type: 'render', blocks: list });
    Object.keys(M.imgs).forEach(function (k) { if (M.imgs[k] && !M.sentImgs[k]) { M.sentImgs[k] = 1; shellPost({ type: 'img', key: k, src: M.imgs[k] }); } });
  }
  // ```html blocks inside the note: a live page each (with the css / js beside it), keyed by content.
  function heightReporter(ek) {
    // the content's own height (not the frame's): where the body ends, plus its bottom margin
    return '<script>(function(){var k=' + JSON.stringify(ek) + ',last=0;function s(){var b=document.body;if(!b)return;' +
      'var h=Math.ceil(b.getBoundingClientRect().bottom+(window.scrollY||0)+(parseFloat(getComputedStyle(b).marginBottom)||0));' +
      'if(h!==last){last=h;parent.postMessage({__mdh:k,h:h},"*")}}addEventListener("load",s);' +
      'if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement);setTimeout(s,60);setTimeout(s,700)})();<\/script>';
  }
  function embedFor(line) {
    var M = st.md, doc = M.doc, blocks = blocksOf(doc), i = -1;
    for (var j = 0; j < blocks.length; j++) if (blocks[j].open === line) { i = j; break; }
    if (i < 0 || blocks[i].lang !== 'html') return '';
    var parts = partsOf(doc, chainAround(doc, blocks, i)).parts;
    var ek = 'e' + MDM.hash(JSON.stringify(parts));
    M.used[ek] = 1;
    if (!M.embeds[ek]) {
      var built;
      try { built = K.buildPreviewDoc(parts, { token: st.token }); } catch (e) { return ''; }
      M.embeds[ek] = { html: built.html + heightReporter(ek), clean: built.clean };
    }
    return ek;
  }
  // Pasted / drawn images: inline base64 or a ref the app resolves (IndexedDB / server).
  function imageFor(code, ref, data) {
    var M = st.md, key = ref ? 'r' + data : 'i' + MDM.hash(data);
    M.usedImgs[key] = 1;
    if (!(key in M.imgs)) { M.imgs[key] = ''; M.pending.push({ key: key, code: code, ref: ref, data: data }); }
    return key;
  }
  function resolveImages() {
    var M = st.md, list = M.pending;
    M.pending = [];
    list.forEach(function (p) {
      var mime = IMG_MIME[p.code] || 'image/jpeg';
      if (!p.ref) { M.imgs[p.key] = 'data:' + mime + ';base64,' + p.data; return; }
      if (typeof window.resolveImageRef !== 'function') return;
      window.resolveImageRef(p.code, p.data).then(function (r) {
        if (st.md !== M) return;
        if (!r || !r.b64) { delete M.imgs[p.key]; return; } // try again on a later render
        M.imgs[p.key] = 'data:' + mime + ';base64,' + r.b64;
        if (M.ready && !M.sentImgs[p.key]) { M.sentImgs[p.key] = 1; shellPost({ type: 'img', key: p.key, src: M.imgs[p.key] }); }
      }, function () { if (st.md === M) delete M.imgs[p.key]; });
    });
  }
  // Keep the block at the cursor in view (unless pinned).
  function syncLine(force) {
    var M = st.md;
    if (!M || !M.ready || st.pinned) return;
    var ed = Cade.editor, doc = ed.state.doc, line = doc.lineAt(Math.min(ed.state.selection.main.head, doc.length)).number;
    if (!force && line === M.lastLine) return;
    M.lastLine = line;
    shellPost({ type: 'line', line: line });
  }
  function onShell(m) {
    var M = st.md;
    if (m.type === 'ready' || m.type === 'resync') {
      M.ready = true; M.keys = {}; M.sentEmbeds = {}; M.sentImgs = {};
      sendRender();
      if (m.type === 'ready') { M.lastLine = 0; syncLine(true); }
    } else if (m.type === 'task') toggleTask(+m.line);
    else if (m.type === 'goto') gotoLine(+m.line);
  }
  var TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
  function toggleTask(n) {
    var ed = Cade.editor;
    if (!ed || !(n >= 1) || n > ed.state.doc.lines) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var L = ed.state.doc.line(n), m = TASK_RE.exec(L.text);
    if (!m) return;
    var at = L.from + m[1].length;
    ed.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
  }
  function gotoLine(n) {
    var ed = Cade.editor, CM = Cade.CM || {};
    if (!ed || !(n >= 1)) return;
    var L = ed.state.doc.line(Math.min(n, ed.state.doc.lines)), spec = { selection: { anchor: L.from } };
    if (CM.EditorView && CM.EditorView.scrollIntoView) spec.effects = CM.EditorView.scrollIntoView(L.from, { y: 'center' });
    ed.dispatch(spec);
    if (!isPhone()) ed.focus();
  }
  // The note's colours and fonts, so the preview matches the theme.
  var VARS = ['--bg', '--surface', '--surface-2', '--text', '--text-muted', '--text-faint', '--border', '--accent', '--font-body', '--font-mono'];
  function isDarkColor(c) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c) || /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
    if (!m) return false;
    var v = m[0].charAt(0) === '#' ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [+m[1], +m[2], +m[3]];
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] < 110;
  }
  function themeVars() {
    var cs = getComputedStyle(document.body || document.documentElement), out = [];
    VARS.forEach(function (v) { var x = cs.getPropertyValue(v).trim(); if (x) out.push(v + ':' + x.replace(/[;{}<]/g, '')); });
    var dark = isDarkColor(cs.getPropertyValue('--bg').trim());
    out.push('--tk-s:' + (dark ? '#e3b06b' : '#b45309'), '--tk-n:' + (dark ? '#c4a7ff' : '#7c3aed'), 'color-scheme:' + (dark ? 'dark' : 'light'));
    return ':root{' + out.join(';') + '}';
  }
  function watchTheme() {
    var M = st.md;
    if (!M || typeof MutationObserver !== 'function') return;
    M.mo = new MutationObserver(function () {
      if (st.md !== M) return;
      var v = themeVars();
      if (v !== M.vars) { M.vars = v; shellPost({ type: 'vars', css: v }); }
    });
    var o = { attributes: true, attributeFilter: ['data-theme', 'class'] };
    M.mo.observe(document.documentElement, o);
    if (document.body) M.mo.observe(document.body, o);
  }
  function mdBuilt() {
    var M = st.md;
    if (!M || !MDM) return null;
    var embeds = {};
    Object.keys(M.embeds).forEach(function (k) { embeds[k] = M.embeds[k].clean; });
    var html = MDM.staticDoc(M.blocks, themeVars(), M.imgs, embeds);
    return { html: html, clean: html };
  }

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
    if (m && st.md && m.__md === st.md.token) { onShell(m); return; }
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
    var built = st.mode === 'md' ? mdBuilt() : st.built;
    if (!built) { toast('Nothing to open yet', 'info'); return; }
    var attr = built.html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var title = st.mode === 'md' ? 'Note' : (st.label || 'Preview');
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
  // Print what the preview shows: the frame prints itself (a print stylesheet
  // gives the Markdown view a plain white page; filter boxes and markers hide).
  function printPreview() {
    if (st.mode === 'md') {
      if (!st.md || !st.md.ready) { toast('Nothing to print yet', 'info'); return; }
      shellPost({ type: 'print' });
    } else if (st.built && ifr && ifr.contentWindow) framePost({ __crPrint: st.token });
    else toast('Nothing to print yet', 'info');
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act],[data-dev],[data-dock],[data-mode]') : null;
    if (!t) return;
    var dev = t.getAttribute('data-dev'), dock = t.getAttribute('data-dock'), act = t.getAttribute('data-act'), mode = t.getAttribute('data-mode');
    if (mode) {
      prefs.mode = mode; st.modeOverride = ''; savePrefs();
      if (st.pinned) { st.pinned = false; markPin(); }
      refresh(true);
    } else if (dev) {
      prefs.device = dev; savePrefs();
      markDevice();
      layoutFrame();
    } else if (dock) setDock(dock);
    else if (act === 'reload') { if (st.mode === 'md') startShell(); refresh(true); }
    else if (act === 'pin') {
      st.pinned = !st.pinned && (st.mode === 'md' || !!st.anchor);
      markPin();
      toast(st.pinned ? (st.mode === 'md' ? 'Not following the cursor' : 'Pinned to this block') : 'Following the cursor', 'info', 1400);
      if (!st.pinned) { schedule(0); if (st.md) { st.md.lastLine = 0; syncLine(true); } }
    } else if (act === 'console') {
      var c = panel.querySelector('.hp-console');
      c.hidden = !c.hidden;
      if (st.mode === 'md') prefs.conMd = !c.hidden; else prefs.con = !c.hidden; // separate: the Markdown view rarely needs it
      savePrefs();
      t.classList.toggle('on', !c.hidden);
      renderConsole();
      setTimeout(layoutFrame, 0);
    } else if (act === 'conclear') clearConsole();
    else if (act === 'tab') openInTab();
    else if (act === 'print') printPreview();
    else if (act === 'copy') {
      var built = st.mode === 'md' ? mdBuilt() : st.built;
      if (built) copyText(built.clean, 'HTML file'); else toast('Nothing to copy yet', 'info');
    }
  }
  function applyConsole() {
    var c = panel.querySelector('.hp-console'), on = st.mode === 'md' ? prefs.conMd : prefs.con;
    if (c.hidden === !on) return;
    c.hidden = !on;
    var b = panel.querySelector('[data-act="console"]');
    if (b) b.classList.toggle('on', on);
    renderConsole();
    setTimeout(layoutFrame, 0);
  }
  function markMode() {
    var b = panel.querySelectorAll('[data-mode]'), m = modePref();
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].getAttribute('data-mode') === m);
  }
  function markPin() {
    var pb = panel && panel.querySelector('[data-act="pin"]');
    if (!pb) return;
    pb.classList.toggle('on', st.pinned);
    pb.setAttribute('aria-pressed', st.pinned ? 'true' : 'false');
    var t = st.mode === 'md' ? 'Stop following the cursor (keep this scroll position)' : 'Pin to this block (stop following the cursor)';
    pb.title = t; pb.setAttribute('aria-label', t);
    panel.classList.toggle('hp-pinned', st.pinned);
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
    print: '<svg viewBox="0 0 16 16"><path d="M4.5 6V2.5h7V6M4.5 11.5h-2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1h-2M4.5 9.5h7v4h-7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    float: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="7.5" y="5" width="5" height="5" rx="1" fill="currentColor"/></svg>',
    side: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 2.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9z" fill="currentColor"/></svg>',
    bottom: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 8.5h13V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" fill="currentColor"/></svg>',
    full: '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function ib(attr, icon, title, extra) { return '<button type="button" class="hp-ib" ' + attr + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' + icon + (extra || '') + '</button>'; }
  function panelHTML() {
    return '<div class="hp-bar">' +
        '<div class="hp-seg hp-modes" role="group" aria-label="What to preview">' +
          ib('data-mode="auto"', '<span>Auto</span>', 'Auto — the page while the cursor is in an html / css / js block, otherwise the whole note as Markdown') +
          ib('data-mode="md"', '<span>MD</span>', 'Markdown — the whole note, rendered (html blocks run inside it)') +
          ib('data-mode="html"', '<span>HTML</span>', 'HTML — the html block at the cursor as a page (with its css / js)') +
        '</div>' +
        '<div class="hp-seg" role="group" aria-label="Device size">' +
          ib('data-dev="fit"', I.fit, 'Fit the panel') + ib('data-dev="phone"', I.phone, 'Phone (390 × 844)') +
          ib('data-dev="tablet"', I.tablet, 'Tablet (820 × 1180)') + ib('data-dev="desktop"', I.desktop, 'Desktop (1280 × 800)') +
        '</div>' +
        '<span class="hp-sp"></span>' +
        ib('data-act="pin" aria-pressed="false"', I.pin, 'Pin to this block (stop following the cursor)') +
        ib('data-act="reload"', I.reload, 'Reload') +
        ib('data-act="console"', I.console, 'Console', '<span class="hp-badge"></span>') +
        ib('data-act="tab"', I.tab, 'Open in a new tab') +
        ib('data-act="print"', I.print, 'Print') +
        ib('data-act="copy"', I.copy, 'Copy as a single HTML file') +
        '<div class="hp-seg hp-docks" role="group" aria-label="Layout">' +
          ib('data-dock="float"', I.float, 'Floating window') + ib('data-dock="side"', I.side, 'Dock right') +
          ib('data-dock="bottom"', I.bottom, 'Dock bottom') + ib('data-dock="full"', I.full, 'Full screen') +
        '</div>' +
      '</div>' +
      '<div class="hp-src"><span class="hp-pin-dot" title="Pinned"></span><span class="hp-src-text"></span><span class="hp-size"></span></div>' +
      '<div class="hp-stage"><div class="hp-frame"></div>' +
        '<div class="hp-empty" hidden><div class="hp-empty-t"></div></div>' +
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
    st.modeOverride = openOverride; openOverride = '';
    panel = Cade.mkPanel(PANEL_ID, 'Live Preview', panelHTML());
    panel.addEventListener('cade-panel-restore', function () { refresh(false); });
    // Lock to a room (Origami, Ctrl+P…); re-render whenever the panel's room is the open one again.
    if (Cade.roomLock) { Cade.roomLock(panel); panel.addEventListener('cade-panel-room', function () { refresh(true); }); }
    // Popped out into its own window (or back): the frame reloads there, and it
    // talks to that window — listen on it and rebuild the page.
    var popWin = null;
    var rehome = function () {
      if (popWin) { try { popWin.removeEventListener('message', onMessage); } catch (e) {} popWin = null; }
      var w = panel && panel.ownerDocument.defaultView;
      if (w && w !== window) { popWin = w; w.addEventListener('message', onMessage); }
      if (!panel || !st) return;
      if (st.mode === 'md') startShell();
      refresh(true);
    };
    panel.addEventListener('cade-panel-popout', rehome);
    panel.addEventListener('cade-panel-popin', rehome);
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
      if (Cade.isMinimized && Cade.isMinimized(panel)) return; // parked in the dock: keys belong to the editor
      if (e.key === 'Escape' && panel && dockNow() === 'full' && !isPhone()) { e.preventDefault(); e.stopPropagation(); setDock('float'); }
    };
    document.addEventListener('keydown', keyHandler, true);
    var stage = panel.querySelector('.hp-stage');
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(function () { layoutFrame(); }); ro.observe(stage); }
    else window.addEventListener('resize', layoutFrame);
    applyDock();
    panel._onClose = function () {
      window.removeEventListener('message', onMessage);
      if (popWin) { try { popWin.removeEventListener('message', onMessage); } catch (e) {} popWin = null; }
      document.removeEventListener('keydown', keyHandler, true);
      window.removeEventListener('resize', layoutFrame);
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      if (timer) { clearTimeout(timer); timer = 0; }
      if (conT) { clearTimeout(conT); conT = 0; }
      try { if (ifr) ifr.srcdoc = ''; } catch (e) {}
      leaveMd();
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
      if (!panel) { openOverride = prefs.mode === 'md' ? 'auto' : ''; openPanel(); return; }
      if (prefs.mode === 'md') st.modeOverride = 'auto'; // the Preview chip asks for the page
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
    name: 'Live Preview',
    description: 'See the note rendered as you type — Markdown in full (sortable, filterable tables and CSV, tasks, callouts, images…) and ```html blocks as live pages (+ nearby css / js) — devices, console, print, full screen',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><polyline points="9 12 7 14 9 16"/><polyline points="15 12 17 14 15 16"/></svg>',
    tags: 'markdown,md,preview,live preview,live html preview,render,rendered,reading view,read mode,html,css,js,javascript,live,web,page,browser,sandbox,iframe,frontend,codepen,playground',
    open: toggle
  });
})();
