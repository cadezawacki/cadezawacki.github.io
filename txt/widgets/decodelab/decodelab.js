/* Decode Lab — paste (or select / drop) mystery text and it tries chains of
 * encodings and classical ciphers, ranking the outputs by how readable they
 * are in a supported language. Analysis tab: letter frequencies vs language
 * profiles, Index of Coincidence (plain + periodic), Kasiski, bigram heatmap,
 * Shannon entropy/diversity and a plain-language cipher identifier. Manual
 * tab: build a step-by-step recipe with editable keys, live preview, Solve
 * buttons for keys that can be attacked, saved recipes.
 *
 * FILES (all lazy — nothing loads until the widget is opened):
 *   decodelab-core.js  engine (decoders, ciphers, attacks, scoring, search)
 *   decodelab-data.js  language statistics (~220 KB, precached)
 *   decodelab-translate.js (+ -worker.js)  on-device translation into English,
 *                      loaded only when a translation feature is used; models
 *                      download only on a tap (see that file)
 * The search runs in a Blob Web Worker built from the core's own source
 * (falls back to time-sliced main-thread work). Nothing touches the network.
 *
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('decodelab.css');
  // resolve now, while the loader's module context is ours
  var CORE_URL = Cade.asset('decodelab-core.js');
  var DATA_URL = Cade.asset('decodelab-data.js');
  var TR_URL = Cade.asset('decodelab-translate.js');
  var TRW_URL = Cade.asset('decodelab-translate-worker.js') + '?v=1'; // ?v= must match the manifest precache entry
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'decodelab-panel';
  var PREFS_KEY = 'cade-decodelab-prefs';
  var RECIPES_KEY = 'cade-decodelab-recipes';
  var MAX_RECIPES = 30;
  var MAX_FILE = 8 * 1024 * 1024;     // bytes accepted from a file
  var SEARCH_CAP = 256 * 1024;        // the chain search works on the first 256 KB
  var ANALYZE_CAP = 300000;           // characters analysed
  var CLEAR = 70;                     // "clearly readable" score

  var prefs = { depth: 3, budget: 6, lang: 'auto', tab: 'results', alang: '', autoTr: false, trFrom: 'auto' };
  var core = null, loading = null, host = null, P = null, lastInput = '', lastBytes = null, lastFile = '';
  var TR = null, trLoading = null; // translation manager (decodelab-translate.js), per panel session

  // ---- persistence ------------------------------------------------------------
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }
  function loadPrefs() {
    var p = readJSON(PREFS_KEY, {});
    for (var k in prefs) if (p[k] !== undefined) prefs[k] = p[k];
    prefs.depth = Math.max(1, Math.min(5, +prefs.depth || 3));
    if ([2, 6, 12, 25].indexOf(+prefs.budget) < 0) prefs.budget = 6;
    if (['results', 'analysis', 'manual', 'translate'].indexOf(prefs.tab) < 0) prefs.tab = 'results';
    prefs.autoTr = !!prefs.autoTr;
  }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function recipes() { var r = readJSON(RECIPES_KEY, []); return Array.isArray(r) ? r : []; }

  // ---- engine loading ---------------------------------------------------------
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + url.split('/').pop())); };
      document.head.appendChild(s);
    });
  }
  function loadEngine() {
    if (core) return Promise.resolve(core);
    if (loading) return loading;
    loading = Promise.all([
      window.__DecodeLabCore ? 0 : loadScript(CORE_URL),
      window.__decodeLabData ? 0 : loadScript(DATA_URL),
    ]).then(function () {
      if (!window.__DecodeLabCore || !window.__decodeLabData) throw new Error('Decode Lab engine missing');
      core = window.__DecodeLabCore();
      core.setData(window.__decodeLabData);
      return core;
    }, function (e) { loading = null; throw e; });
    return loading;
  }

  // ---- engine host: Blob worker (search off the UI thread) or main thread --------
  // workerMain is stringified into the worker: it may only use DecodeLabCore
  // (defined in the same blob) and worker globals.
  function workerMain() {
    var core = null, search = null, runId = 0, last = 0;
    function loop(id) {
      if (!search || id !== runId) return;
      var done = search.step(60), t = Date.now();
      if (done) {
        self.postMessage({ type: 'done', id: id, progress: search.progress(), results: search.top(30, true) });
        search = null;
        return;
      }
      if (t - last > 150) { last = t; self.postMessage({ type: 'progress', id: id, progress: search.progress(), results: search.top(8, false) }); }
      setTimeout(function () { loop(id); }, 0);
    }
    self.onmessage = function (e) {
      var m = e.data;
      try {
        if (m.type === 'init') { core = DecodeLabCore(); core.setData(m.data); }
        else if (m.type === 'run') { runId = m.id; last = 0; search = core.createSearch(m.input, m.opts); loop(m.id); }
        else if (m.type === 'stop') { if (search && m.id === runId) search.stop(); }
        else if (m.type === 'solve') self.postMessage({ type: 'solved', id: m.id, result: core.solve(m.op, m.input, m.opts) });
      } catch (err) { self.postMessage({ type: 'error', id: m.id, error: String(err && err.message || err) }); }
    };
  }
  function makeHost() {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && window.URL && URL.createObjectURL) {
      var url = null;
      try {
        var src = 'var DecodeLabCore = (' + window.__DecodeLabCore.toString() + ');\n(' + workerMain.toString() + ')();';
        url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        var w = new Worker(url);
        URL.revokeObjectURL(url);
        var h = { worker: true, pending: null };
        w.onmessage = function (e) { if (e.data && e.data.type === 'done') h.pending = null; if (h.onmsg) h.onmsg(e.data); };
        w.onerror = function (e) {
          if (e && e.preventDefault) e.preventDefault();
          // blocked or crashed worker: continue on the main thread
          if (host !== h) return;
          h.kill();
          host = mainHost();
          host.onmsg = h.onmsg;
          if (h.pending) host.post(h.pending);
        };
        w.postMessage({ type: 'init', data: window.__decodeLabData });
        h.post = function (m) { if (m.type === 'run') h.pending = m; w.postMessage(m); };
        h.kill = function () { try { w.terminate(); } catch (e) {} };
        return h;
      } catch (err) { if (url) try { URL.revokeObjectURL(url); } catch (e2) {} }
    }
    return mainHost();
  }
  function mainHost() {
    var h = { worker: false }, search = null, runId = 0, timer = 0, last = 0;
    function loop(id) {
      if (!search || id !== runId) return;
      var done = search.step(14), t = Date.now();
      if (done) { var s = search; search = null; if (h.onmsg) h.onmsg({ type: 'done', id: id, progress: s.progress(), results: s.top(30, true) }); return; }
      if (t - last > 200) { last = t; if (h.onmsg) h.onmsg({ type: 'progress', id: id, progress: search.progress(), results: search.top(8, false) }); }
      timer = setTimeout(function () { loop(id); }, 8);
    }
    h.post = function (m) {
      if (m.type === 'run') { clearTimeout(timer); runId = m.id; last = 0; search = core.createSearch(m.input, m.opts); timer = setTimeout(function () { loop(m.id); }, 0); }
      else if (m.type === 'stop') { if (search) search.stop(); }
      else if (m.type === 'solve') {
        setTimeout(function () {
          var r = null;
          try { r = core.solve(m.op, m.input, m.opts); } catch (e) {}
          if (h.onmsg) h.onmsg({ type: 'solved', id: m.id, result: r });
        }, 30);
      }
    };
    h.kill = function () { clearTimeout(timer); search = null; };
    return h;
  }

  // ---- small helpers -------------------------------------------------------------
  function toast(msg, type, ms) { Cade.showToast(msg, type || 'info', ms || 1800); }
  function isBytes(v) { return v instanceof Uint8Array; }
  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function copyText(text, label) {
    var done = function () { toast('Copied' + (label ? ' ' + label : ''), 'success', 1300); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); else fail(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    toast('Inserted ' + fmtN(text.length) + ' chars', 'success', 1200);
  }
  function download(bytes, name) {
    try {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) { toast('Download failed', 'error'); }
  }
  function selectionText() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (sel.empty) return '';
      return ed.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_FILE));
    } catch (e) { return ''; }
  }
  function q(sel) { return P ? P.el.querySelector(sel) : null; }
  function currentInput() {
    if (!P) return '';
    if (P.bytes) return P.bytes;
    return P.inEl.value;
  }
  function chainNames(chain) { return chain.length ? chain.map(function (c) { return c.name; }).join(' → ') : 'input'; }

  // ---- panel ---------------------------------------------------------------------
  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    if (existing) { var ti = existing.querySelector('.dl-in'); if (ti) ti.focus(); return; }
    loadPrefs();
    var el = Cade.mkPanel(PANEL_ID, '🔓 Decode Lab',
      '<div class="dl-top">' +
        '<div class="dl-inwrap">' +
          '<textarea class="dl-in" rows="3" placeholder="Paste mystery text — or select text in the editor, or drop a file…" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Input to decode"></textarea>' +
          '<div class="dl-file" hidden><span class="dl-file-name"></span><button class="dl-ibtn dl-file-x" title="Remove file" aria-label="Remove file">✕</button></div>' +
        '</div>' +
        '<div class="dl-bar">' +
          '<button class="dl-btn primary dl-go" title="Try decoder chains (Ctrl/⌘+Enter)">✨ Auto-decode</button>' +
          '<button class="dl-btn dl-stop" hidden title="Stop and keep what was found (Esc)">■ Stop</button>' +
          '<span class="dl-status" aria-live="polite"></span>' +
          '<span class="dl-sp"></span>' +
          '<button class="dl-ibtn dl-sel" title="Use the editor selection">⇣ Sel</button>' +
          '<button class="dl-ibtn dl-open" title="Open a file (decoded as bytes)">📂</button>' +
          '<button class="dl-ibtn dl-clear" title="Clear input">⌫</button>' +
          '<button class="dl-ibtn dl-optbtn" title="Search options" aria-expanded="false">⚙</button>' +
        '</div>' +
        '<div class="dl-opts" hidden>' +
          '<label>Depth <select class="dl-o-depth"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>' +
          '<label>Time <select class="dl-o-budget"><option value="2">2 s</option><option value="6">6 s</option><option value="12">12 s</option><option value="25">25 s</option></select></label>' +
          '<label>Language <select class="dl-o-lang"><option value="auto">Auto</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="it">Italian</option><option value="pt">Portuguese</option><option value="nl">Dutch</option></select></label>' +
          '<button class="dl-ibtn dl-o-langs" title="Translation languages on this device">🌐 Translation languages</button>' +
        '</div>' +
      '</div>' +
      '<div class="dl-progress" hidden><i></i></div>' +
      '<div class="dl-tabs" role="tablist">' +
        '<button class="dl-tab" data-tab="results" role="tab">Results</button>' +
        '<button class="dl-tab" data-tab="analysis" role="tab">Analysis</button>' +
        '<button class="dl-tab" data-tab="manual" role="tab">Manual</button>' +
        '<button class="dl-tab" data-tab="translate" role="tab">Translate</button>' +
      '</div>' +
      '<div class="dl-body">' +
        '<div class="dl-pane" data-pane="results"></div>' +
        '<div class="dl-pane" data-pane="analysis"></div>' +
        '<div class="dl-pane" data-pane="manual"></div>' +
        '<div class="dl-pane" data-pane="translate"></div>' +
        '<div class="dl-tip" hidden></div>' +
      '</div>' +
      '<input type="file" class="dl-filein" hidden>');

    P = {
      el: el, inEl: el.querySelector('.dl-in'), bytes: null, fileName: '', results: [], running: false, runId: 0,
      progress: null, aTarget: null, aTimer: 0, mTimer: 0, rTimer: 0, steps: [], mQuery: '',
      solveId: 0, solveCbs: {}, showAll: false, expanded: {}, ro: null, lastW: 0, mBrowse: false,
      tr: { text: null, det: null, st: null, busy: false, prog: 0, stage: '', out: null, err: '', mgr: false, dl: {}, dlErr: {}, list: null, chrome: {} },
      trReady: {}, trBusy: {}, trTimer: 0,
    };
    var st = P;

    el.querySelector('.dl-o-depth').value = String(prefs.depth);
    el.querySelector('.dl-o-budget').value = String(prefs.budget);
    el.querySelector('.dl-o-lang').value = prefs.lang;

    // initial input: the selection (auto-run), else what was here last time
    var sel = selectionText(), autoRun = false;
    if (sel && sel.trim()) { P.inEl.value = sel; autoRun = sel.length <= SEARCH_CAP; }
    else if (lastBytes) setBytes(lastBytes, lastFile);
    else P.inEl.value = lastInput;

    bindEvents(el);
    setTab(prefs.tab, true);
    renderResults();
    loadEngine().then(function () {
      if (P !== st) return;
      if (autoRun) startRun();
      else { renderResults(); renderActiveTab(); }
    }, function (e) {
      if (P !== st) return;
      q('[data-pane="results"]').innerHTML = '<div class="dl-empty">' + esc(e.message) + (navigator.onLine ? '' : ' — it needs one online load to cache') + '</div>';
    });

    if (typeof ResizeObserver !== 'undefined') {
      P.ro = new ResizeObserver(function () {
        if (!P || P !== st) return;
        var w = el.querySelector('.dl-body').clientWidth;
        if (Math.abs(w - P.lastW) > 24) { P.lastW = w; clearTimeout(P.rTimer); P.rTimer = setTimeout(function () { if (P === st && currentTab() === 'analysis') renderAnalysis(); }, 160); }
      });
      P.ro.observe(el.querySelector('.dl-body'));
    }
    el._onClose = function () { teardown(st); };
    if (!autoRun && (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches)) setTimeout(function () { if (P === st) P.inEl.focus(); }, 0);
  }
  function teardown(st) {
    if (P !== st) return;
    if (!P.bytes) lastInput = P.inEl.value.length <= 200000 ? P.inEl.value : '';
    lastBytes = P.bytes; lastFile = P.fileName;
    clearTimeout(P.aTimer); clearTimeout(P.mTimer); clearTimeout(P.rTimer); clearTimeout(P.trTimer);
    if (TR) { TR.dispose(); TR = null; } // terminates the translation worker, frees the model
    trLoading = null;
    if (P.ro) try { P.ro.disconnect(); } catch (e) {}
    if (host) { host.kill(); host = null; }
    P = null;
  }
  function close() { var el = document.getElementById(PANEL_ID); if (el) { el.remove(); if (el._onClose) el._onClose(); } }

  function bindEvents(el) {
    var st = P;
    el.addEventListener('keydown', function (e) {
      if (P !== st) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); startRun(); }
      else if (e.key === 'Enter' && e.target.classList.contains('dl-m-q')) {
        e.preventDefault();
        var first = q('[data-addop2]');
        if (first) { addStep(first.getAttribute('data-addop2')); P.mQuery = ''; P.mBrowse = false; renderManual(); }
      }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (P.running) stopRun(); else close();
      }
      e.stopPropagation(); // keep editor/global shortcuts out of the panel's inputs
    });
    P.inEl.addEventListener('input', function () {
      if (P !== st) return;
      if (P.bytes) clearBytes(true);
      onInputChanged();
    });
    el.addEventListener('click', function (e) {
      if (P !== st) return;
      var t = e.target, b;
      if (!t.closest) return;
      if ((b = t.closest('.dl-tab'))) { setTab(b.getAttribute('data-tab')); return; }
      if (t.closest('.dl-go')) { startRun(); return; }
      if (t.closest('.dl-stop')) { stopRun(); return; }
      if (t.closest('.dl-sel')) {
        var s = selectionText();
        if (!s) { toast('Select some text in the editor first'); return; }
        clearBytes(true); P.inEl.value = s; onInputChanged(); return;
      }
      if (t.closest('.dl-open')) { el.querySelector('.dl-filein').click(); return; }
      if (t.closest('.dl-clear')) { clearBytes(true); P.inEl.value = ''; P.results = []; P.progress = null; onInputChanged(); renderResults(); P.inEl.focus(); return; }
      if (t.closest('.dl-file-x')) { clearBytes(true); onInputChanged(); return; }
      if ((b = t.closest('.dl-optbtn'))) {
        var o = el.querySelector('.dl-opts'); o.hidden = !o.hidden; b.setAttribute('aria-expanded', String(!o.hidden)); b.classList.toggle('on', !o.hidden); return;
      }
      if ((b = t.closest('[data-act]'))) { resultAction(b.getAttribute('data-act'), +b.getAttribute('data-i')); return; }
      if ((b = t.closest('.dl-more'))) { P.showAll = true; renderResults(); return; }
      if ((b = t.closest('.dl-expand'))) { var i = b.getAttribute('data-i'); P.expanded[i] = !P.expanded[i]; renderResults(); return; }
      if ((b = t.closest('.dl-atarget-x'))) { P.aTarget = null; renderAnalysis(); return; }
      if ((b = t.closest('[data-addop]'))) { addStep(b.getAttribute('data-addop')); setTab('manual'); return; }
      if (t.closest('.dl-o-langs')) { P.tr.mgr = true; setTab('translate'); return; }
      if (translateClick(e, t)) return;
      if ((b = t.closest('.dl-ftbl'))) { var tb = b.parentNode.querySelector('.dl-table'); if (tb) { tb.hidden = !tb.hidden; b.textContent = tb.hidden ? 'Show table' : 'Hide table'; } return; }
      manualClick(e, t);
    });
    el.addEventListener('change', function (e) {
      if (P !== st) return;
      var t = e.target;
      if (t.classList.contains('dl-o-depth')) { prefs.depth = +t.value; savePrefs(); }
      else if (t.classList.contains('dl-o-budget')) { prefs.budget = +t.value; savePrefs(); }
      else if (t.classList.contains('dl-o-lang')) { prefs.lang = t.value; savePrefs(); }
      else if (t.classList.contains('dl-alang')) { prefs.alang = t.value; savePrefs(); renderAnalysis(); }
      else if (t.classList.contains('dl-tr-from')) { prefs.trFrom = t.value; savePrefs(); P.tr.forced = ''; P.tr.out = null; P.tr.err = ''; renderTrOut(); updateTrStatus(); }
      else if (t.classList.contains('dl-autotr-cb')) { prefs.autoTr = t.checked; savePrefs(); if (prefs.autoTr) autoTranslate(); }
      else if (t.classList.contains('dl-filein')) { if (t.files && t.files[0]) readFile(t.files[0]); t.value = ''; }
      else manualChange(e, t);
    });
    el.addEventListener('input', function (e) {
      if (P !== st) return;
      var t = e.target;
      if (t.classList.contains('dl-m-q') || (t.closest && t.closest('.dl-step-p'))) manualChange(e, t);
      else if (t.classList.contains('dl-tr-in')) { P.tr.text = t.value; P.tr.fromInput = false; scheduleDetect(); }
    });
    // drag & drop: a file becomes bytes, dropped text becomes the input
    el.addEventListener('dragover', function (e) { if (P !== st) return; e.preventDefault(); el.classList.add('dl-drop'); });
    el.addEventListener('dragleave', function (e) { if (e.target === el) el.classList.remove('dl-drop'); });
    el.addEventListener('drop', function (e) {
      if (P !== st) return;
      e.preventDefault(); el.classList.remove('dl-drop');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) readFile(dt.files[0]);
      else if (dt) { var tx = dt.getData('text'); if (tx) { clearBytes(true); P.inEl.value = tx; onInputChanged(); } }
    });
    // tooltips for chart marks (hover on desktop, tap on touch)
    var body = el.querySelector('.dl-body');
    body.addEventListener('pointerover', tipFor);
    body.addEventListener('pointerdown', tipFor);
    body.addEventListener('pointerleave', tipHide);
    body.addEventListener('scroll', tipHide, true);
  }
  function tipFor(e) {
    if (!P) return;
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null, tip = q('.dl-tip');
    if (!t) { tipHide(); return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    var body = q('.dl-body'), br = body.getBoundingClientRect(), r = t.getBoundingClientRect();
    var x = r.left + r.width / 2 - br.left, y = r.top - br.top + body.scrollTop;
    tip.style.left = Math.max(4, Math.min(br.width - tip.offsetWidth - 4, x - tip.offsetWidth / 2)) + 'px';
    tip.style.top = Math.max(body.scrollTop + 2, y - tip.offsetHeight - 6) + 'px';
  }
  function tipHide() { var tip = q('.dl-tip'); if (tip) tip.hidden = true; }

  function readFile(f) {
    if (f.size > MAX_FILE) { toast('File too large (max ' + fmtBytes(MAX_FILE) + ')', 'error', 2500); return; }
    var st = P, rd = new FileReader();
    rd.onload = function () {
      if (P !== st) return;
      var b = new Uint8Array(rd.result), text = null;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { text = null; }
      if (text !== null && text.length <= 512 * 1024 && !/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 20000))) {
        clearBytes(true); P.inEl.value = text; onInputChanged();
        toast('Loaded ' + f.name + ' as text', 'success', 1400);
      } else {
        setBytes(b, f.name); onInputChanged();
        toast('Loaded ' + f.name + ' as bytes', 'success', 1400);
      }
    };
    rd.onerror = function () { toast('Could not read the file', 'error'); };
    rd.readAsArrayBuffer(f);
  }
  function setBytes(b, name) {
    P.bytes = b; P.fileName = name || 'bytes';
    var f = q('.dl-file');
    f.hidden = false;
    f.querySelector('.dl-file-name').textContent = '📄 ' + P.fileName + ' — ' + fmtBytes(b.length) + ' of bytes';
    P.inEl.value = '';
    P.inEl.placeholder = 'Using the loaded file — type here to replace it with text';
    P.inEl.classList.add('dl-has-file');
  }
  function clearBytes(quiet) {
    if (!P || !P.bytes) return;
    P.bytes = null; P.fileName = '';
    q('.dl-file').hidden = true;
    P.inEl.placeholder = 'Paste mystery text — or select text in the editor, or drop a file…';
    P.inEl.classList.remove('dl-has-file');
  }
  function onInputChanged() {
    if (!P) return;
    var tab = currentTab();
    if (tab === 'analysis' && !P.aTarget) { clearTimeout(P.aTimer); P.aTimer = setTimeout(renderAnalysis, 350); }
    if (tab === 'manual') scheduleRecipe();
    if (P.tr.fromInput || P.tr.text == null) {
      // the Translate tab follows the main input until its own box is edited
      P.tr.text = null;
      if (tab === 'translate') { var ti = q('.dl-tr-in'), v = currentInput(); if (ti && !isBytes(v)) { ti.value = v; P.tr.text = v; P.tr.fromInput = true; scheduleDetect(); } }
    }
  }

  // ---- tabs --------------------------------------------------------------------------
  function currentTab() { return prefs.tab; }
  function setTab(tab, initial) {
    if (!P) return;
    prefs.tab = tab;
    if (!initial) savePrefs();
    P.el.querySelectorAll('.dl-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    P.el.querySelectorAll('.dl-pane').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== tab; });
    tipHide();
    if (!initial) renderActiveTab();
  }
  function renderActiveTab() {
    var t = currentTab();
    if (t === 'results') renderResults();
    else if (t === 'analysis') renderAnalysis();
    else if (t === 'translate') renderTranslate();
    else renderManual();
  }

  // ---- search ------------------------------------------------------------------------
  function startRun() {
    if (!P) return;
    var input = currentInput();
    if (!input || !input.length || (!isBytes(input) && !input.trim())) { toast('Paste, select or drop something to decode'); P.inEl.focus(); return; }
    if (input.length > SEARCH_CAP) { input = isBytes(input) ? input.subarray(0, SEARCH_CAP) : input.slice(0, SEARCH_CAP); toast('Searching the first ' + fmtBytes(SEARCH_CAP), 'info', 1600); }
    var st = P;
    loadEngine().then(function () {
      if (P !== st) return;
      if (!host) host = makeHost();
      host.onmsg = onEngineMsg;
      if (P.running) host.post({ type: 'stop', id: P.runId });
      P.runId++;
      P.running = true; P.results = []; P.progress = null; P.showAll = false; P.expanded = {};
      host.post({ type: 'run', id: P.runId, input: isBytes(input) ? input.slice() : input, opts: { depth: prefs.depth, budget: prefs.budget * 1000, lang: prefs.lang, clear: CLEAR } });
      if (currentTab() !== 'results') setTab('results');
      renderRunState(); renderResults();
    }, function (e) { toast(e.message, 'error', 2500); });
  }
  function stopRun() { if (P && P.running && host) host.post({ type: 'stop', id: P.runId }); }
  function onEngineMsg(m) {
    if (!P) return;
    if (m.type === 'solved') { var cb = P.solveCbs[m.id]; delete P.solveCbs[m.id]; if (cb) cb(m.result); return; }
    if (m.id !== P.runId) return;
    if (m.type === 'progress') {
      P.progress = m.progress; P.results = m.results;
      renderRunState();
      // re-render at a calm pace so buttons stay clickable mid-search
      var t = Date.now();
      if (currentTab() === 'results' && t - (P.lastRender || 0) > 450) { P.lastRender = t; renderResults(); }
    } else if (m.type === 'done') {
      P.running = false; P.progress = m.progress; P.results = m.results;
      renderRunState();
      if (currentTab() === 'results') renderResults();
      if (P.results[0] && P.results[0].score >= CLEAR && Cade.haptic) Cade.haptic(8);
      afterSearch();
    } else if (m.type === 'error') {
      P.running = false; renderRunState(); toast('Search failed: ' + m.error, 'error', 3000);
    }
  }
  function renderRunState() {
    if (!P) return;
    var pr = P.progress, s = q('.dl-status');
    q('.dl-go').hidden = P.running;
    q('.dl-stop').hidden = !P.running;
    q('.dl-progress').hidden = !P.running;
    if (P.running) s.textContent = 'Trying… ' + (pr ? fmtN(pr.tried) + ' candidates · depth ' + pr.depth + '/' + pr.maxDepth + ' · ' + (pr.elapsed / 1000).toFixed(1) + ' s' : 'starting');
    else if (pr) s.textContent = fmtN(pr.tried) + ' tried · ' + (pr.elapsed / 1000).toFixed(1) + ' s' + (pr.timedOut ? ' (time limit)' : '');
    else s.textContent = '';
  }
  function scoreCls(s) { return s >= CLEAR ? 'hi' : s >= 40 ? 'mid' : 'lo'; }
  function langLabel(r) {
    if (!r.langName) return r.isBytes ? (r.magic || 'bytes') : '';
    if (/^(flag|json|url|email|file)$/.test(r.lang)) return r.langName;
    return r.langName + (r.conf ? ' · ' + Math.round(r.conf * 100) + '%' : '');
  }
  function renderResults() {
    if (!P) return;
    var pane = q('[data-pane="results"]');
    if (!pane || currentTab() !== 'results') return;
    var pr = P.progress, rs = P.results || [], html = '';
    if (!rs.length && !P.running) {
      if (!pr) {
        pane.innerHTML = '<div class="dl-empty"><b>Paste, select or drop something mysterious</b> and press <b>Auto-decode</b> (Ctrl/⌘+Enter).<br>' +
          'Decode Lab tries Base64/32/58/85, hex, binary, Morse, URL, gzip, JWT … and classical ciphers — Caesar, Atbash, affine, Vigenère, ' +
          'rail fence, columnar, substitution, XOR — in chains up to ' + prefs.depth + ' steps deep, and ranks what reads like real language. ' +
          'Everything runs on this device.</div>';
        return;
      }
    }
    if (pr && pr.input && pr.input.score >= CLEAR) {
      html += '<div class="dl-banner">The input already reads as <b>' + esc(pr.input.langName || 'text') + '</b> (score ' + pr.input.score + ') — the results below are other readings.</div>';
    }
    if (!P.running && pr) {
      var best = rs[0];
      if (!best || best.score < 40) html += '<div class="dl-banner warn">Nothing clearly readable yet. Try a deeper search or more time (⚙), check the <b>Analysis</b> tab for clues, or build it step by step in <b>Manual</b>.</div>';
    }
    if (!P.running && rs.length) html += autoTrToggle();
    var limit = P.showAll ? rs.length : Math.min(rs.length, 10);
    for (var i = 0; i < limit; i++) html += cardHtml(rs[i], i);
    if (rs.length > limit) html += '<button class="dl-more">Show ' + (rs.length - limit) + ' more</button>';
    if (P.running && !rs.length) html += '<div class="dl-empty">Searching…</div>';
    pane.innerHTML = html;
  }
  function cardHtml(r, i) {
    var chain = r.chain.map(function (c) {
      var rot13 = c.id === 'caesar' && c.label === 'ROT13';
      return '<span class="dl-cstep">' + esc(rot13 ? 'ROT13' : c.name) + (c.label && !rot13 ? '<small>' + esc(c.label) + '</small>' : '') + (c.charset ? '<small>as ' + esc(c.charset) + '</small>' : '') + '</span>';
    }).join('<span class="dl-arrow">→</span>');
    var body, long = false, exp = !!P.expanded[i];
    if (r.isBytes) {
      body = '<div class="dl-bytes">' + (r.magic ? '<b>' + esc(r.magic) + '</b> · ' : '') + fmtBytes(r.len) + ' of binary data</div><pre class="dl-out mono">' + esc(r.hex.slice(0, exp ? 6000 : 290)) + (r.hex.length > (exp ? 6000 : 290) ? ' …' : '') + '</pre>';
      long = r.hex.length > 290;
    } else {
      var t = r.text || '';
      long = t.length > 420 || (t.match(/\n/g) || []).length > 6;
      body = '<pre class="dl-out' + (long && !exp ? ' clip' : '') + '">' + esc(exp ? t.slice(0, 60000) : t.slice(0, 600)) + (r.truncated ? '\n…' : '') + '</pre>';
      var tb = P.trBusy[r.id];
      if (r.tr) body += '<div class="dl-trans"><div class="dl-trans-h">English <span>' + esc(r.tr.from + '→en · ' + r.tr.label) + '</span></div><pre class="dl-out">' + esc(r.tr.text.slice(0, exp ? 60000 : 1200)) + '</pre></div>';
      else if (tb) body += '<div class="dl-trans busy"><div class="dl-trans-h">' + esc(tb.err ? '⚠ ' + tb.err : 'Translating… ' + (tb.prog ? Math.round(tb.prog * 100) + '%' : '')) + '</div></div>';
    }
    var lab = langLabel(r);
    return '<div class="dl-card' + (i === 0 && r.score >= CLEAR ? ' best' : '') + '">' +
      '<div class="dl-card-h"><span class="dl-score ' + scoreCls(r.score) + '" title="Readability score (0–100)">' + r.score + '</span>' +
        '<div class="dl-chain" title="Decoding steps, applied left to right">' + chain + '</div>' + (lab ? '<span class="dl-lang">' + esc(lab) + '</span>' : '') + '</div>' +
      body +
      '<div class="dl-acts">' +
        '<button class="dl-abtn" data-act="copy" data-i="' + i + '">Copy</button>' +
        '<button class="dl-abtn" data-act="insert" data-i="' + i + '">Insert</button>' +
        '<button class="dl-abtn" data-act="use" data-i="' + i + '" title="Decode this further">Use as input</button>' +
        '<button class="dl-abtn" data-act="recipe" data-i="' + i + '" title="Open this chain in Manual">Recipe</button>' +
        '<button class="dl-abtn" data-act="analyze" data-i="' + i + '">Analyze</button>' +
        (r.isBytes ? '<button class="dl-abtn" data-act="save" data-i="' + i + '">Save' + (r.ext ? ' .' + esc(r.ext) : '') + '</button>' : '') +
        (trEligible(r) && !r.tr ? '<button class="dl-abtn dl-trbtn" data-act="tr" data-i="' + i + '" title="Translate into English on this device">🌐 English</button>' : '') +
        (long ? '<button class="dl-abtn dl-expand" data-i="' + i + '">' + (exp ? 'Less' : 'More') + '</button>' : '') +
      '</div></div>';
  }
  function resultValue(r) {
    if (r.isBytes) return r.bytes || null;
    return r.text;
  }
  function resultAction(act, i) {
    var r = P.results[i];
    if (!r) return;
    if (P.running && (r.truncated || (r.isBytes && !r.bytes))) { toast('Still searching — stop or wait for it to finish', 'info', 1800); return; }
    var v = resultValue(r);
    if (act === 'copy') copyText(r.isBytes ? r.hex : v, r.isBytes ? 'as hex' : '');
    else if (act === 'insert') insertText(r.isBytes ? r.hex : v);
    else if (act === 'save') { if (r.bytes) download(r.bytes, 'decoded.' + (r.ext || 'bin')); }
    else if (act === 'use') {
      if (isBytes(v)) setBytes(v, 'result ' + (i + 1));
      else { clearBytes(true); P.inEl.value = v; }
      P.results = []; P.progress = null;
      startRun();
    } else if (act === 'recipe') {
      P.steps = [];
      r.chain.forEach(function (c) {
        if (c.id === 'translate') { toast('Translation is not a Manual step — use the Translate tab', 'info', 2200); return; }
        addStep(c.id, c.params);
        if (c.charset) addStep('charset', { charset: c.charset });
      });
      setTab('manual');
    } else if (act === 'analyze') {
      P.aTarget = { label: chainNames(r.chain), value: v };
      setTab('analysis');
    } else if (act === 'tr') translateResult(r);
  }

  // ---- charts (inline SVG, theme colours through CSS classes) ------------------------
  function svgOpen(w, h, label) { return '<svg class="dl-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">'; }
  function barPath(x, y, w, h, r) { // data end rounded, anchored on the baseline
    if (h <= 0.4) return '';
    r = Math.max(0, Math.min(r, w / 2, h));
    return 'M' + x.toFixed(1) + ',' + (y + h).toFixed(1) + 'V' + (y + r).toFixed(1) + 'Q' + x.toFixed(1) + ',' + y.toFixed(1) + ' ' + (x + r).toFixed(1) + ',' + y.toFixed(1) +
      'H' + (x + w - r).toFixed(1) + 'Q' + (x + w).toFixed(1) + ',' + y.toFixed(1) + ' ' + (x + w).toFixed(1) + ',' + (y + r).toFixed(1) + 'V' + (y + h).toFixed(1) + 'Z';
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / e;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e;
  }
  // Vertical bars. o = { w, h, labels, vals, cls(i), tip(i), exp (marker values), refs [{v, cls, label}], fmt, label, every }
  function vbars(o) {
    var W = o.w, H = o.h, padL = 36, padR = o.refs && o.refs.length ? 52 : 8, padT = 8, padB = 18;
    var n = o.vals.length, pw = W - padL - padR, ph = H - padT - padB, bw = pw / n, gap = bw >= 6 ? 2 : bw >= 3 ? 1 : 0;
    var raw = Math.max.apply(null, o.vals.concat(o.exp || [], (o.refs || []).map(function (r) { return r.v; })));
    var max = o.yMax || niceMax(raw * 1.05), fmt = o.fmt || function (v) { return String(v); };
    var s = svgOpen(W, H, o.label || 'chart'), i;
    for (var g = 0; g <= 2; g++) {
      var gv = max * g / 2, gy = padT + ph - ph * gv / max;
      s += '<line class="dl-c-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '"/>' +
        '<text class="dl-c-tick" x="' + (padL - 5) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">' + esc(fmt(gv)) + '</text>';
    }
    for (i = 0; i < n; i++) {
      var v = o.vals[i] || 0, bh = ph * Math.min(v, max) / max, x = padL + i * bw + gap / 2;
      s += '<path class="' + (o.cls ? o.cls(i) : 'dl-c-obs') + '" d="' + barPath(x, padT + ph - bh, Math.max(0.6, bw - gap), bh, Math.min(3, (bw - gap) / 2)) + '"/>';
    }
    if (o.exp) for (i = 0; i < n; i++) {
      var ey = padT + ph - ph * Math.min(o.exp[i] || 0, max) / max, x1 = padL + i * bw + gap / 2;
      s += '<line class="dl-c-exp" x1="' + x1.toFixed(1) + '" x2="' + (x1 + bw - gap).toFixed(1) + '" y1="' + ey.toFixed(1) + '" y2="' + ey.toFixed(1) + '"/>';
    }
    (o.refs || []).forEach(function (r) {
      if (r.v > max) return;
      var ry = padT + ph - ph * r.v / max;
      s += '<line class="dl-c-ref ' + (r.cls || '') + '" x1="' + padL + '" x2="' + (W - padR + 2) + '" y1="' + ry.toFixed(1) + '" y2="' + ry.toFixed(1) + '"/>' +
        '<text class="dl-c-reflbl" x="' + (W - padR + 4) + '" y="' + (ry + 3).toFixed(1) + '">' + esc(r.label) + '</text>';
    });
    s += '<line class="dl-c-axis" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + ph) + '" y2="' + (padT + ph) + '"/>';
    var every = o.every || Math.max(1, Math.ceil(14 / bw));
    for (i = 0; i < n; i++) {
      if (o.labels && i % every === 0) s += '<text class="dl-c-lbl" x="' + (padL + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle">' + esc(o.labels[i]) + '</text>';
      if (o.tip) s += '<rect class="dl-c-hit" x="' + (padL + i * bw).toFixed(1) + '" y="' + padT + '" width="' + Math.max(bw, 1).toFixed(1) + '" height="' + ph + '" data-tip="' + esc(o.tip(i)) + '"/>';
    }
    return s + '</svg>';
  }
  function hrows(rows, max) { // HTML horizontal bars: [{label, v, text, cls}]
    max = max || Math.max.apply(null, rows.map(function (r) { return r.v; })) || 1;
    return '<div class="dl-hrows">' + rows.map(function (r) {
      return '<div class="dl-hrow ' + (r.cls || '') + '"><span class="dl-hlab">' + esc(r.label) + '</span><span class="dl-htrack"><i style="width:' + Math.max(0, Math.min(100, r.v / max * 100)).toFixed(1) + '%"></i></span><span class="dl-hval">' + esc(r.text) + '</span></div>';
    }).join('') + '</div>';
  }
  function heatmap(a, W) {
    var A = a.alpha.length, cell = Math.max(6, Math.min(16, Math.floor((W - 20) / A))), off = 16, size = off + cell * A + 2;
    var s = svgOpen(size, size, 'Bigram heatmap'), mx = a.bigrams.max || 1, i, j;
    for (i = 0; i < A; i++) {
      s += '<text class="dl-c-lbl" x="' + (off + i * cell + cell / 2) + '" y="11" text-anchor="middle">' + esc(a.alpha[i]) + '</text>' +
        '<text class="dl-c-lbl" x="' + (off - 4) + '" y="' + (off + i * cell + cell / 2 + 3) + '" text-anchor="end">' + esc(a.alpha[i]) + '</text>';
    }
    for (i = 0; i < A; i++) for (j = 0; j < A; j++) {
      var v = a.bigrams.matrix[i * A + j], x = off + j * cell, y = off + i * cell;
      if (!v) { s += '<rect class="dl-hm-0" x="' + x + '" y="' + y + '" width="' + (cell - 1) + '" height="' + (cell - 1) + '"/>'; continue; }
      var op = 0.12 + 0.88 * Math.sqrt(v / mx);
      s += '<rect class="dl-hm" x="' + x + '" y="' + y + '" width="' + (cell - 1) + '" height="' + (cell - 1) + '" rx="1.5" fill-opacity="' + op.toFixed(2) + '" data-tip="' + a.alpha[i] + a.alpha[j] + ': ' + v + '"/>';
    }
    return s + '</svg>';
  }
  function sec(title, help, inner, cls) {
    return '<section class="dl-sec' + (cls ? ' ' + cls : '') + '"><h4>' + esc(title) + '</h4>' + (help ? '<p class="dl-note">' + help + '</p>' : '') + inner + '</section>';
  }
  function tile(label, value, sub) { return '<div class="dl-tile"><span>' + esc(label) + '</span><b>' + esc(value) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>'; }

  // ---- analysis tab ------------------------------------------------------------------------
  function renderAnalysis() {
    if (!P) return;
    var pane = q('[data-pane="analysis"]');
    if (!pane || currentTab() !== 'analysis') return;
    if (!core) { pane.innerHTML = '<div class="dl-empty">Loading…</div>'; return; }
    var v = P.aTarget ? P.aTarget.value : currentInput();
    var head = P.aTarget ? '<div class="dl-atarget">Analyzing result <b>' + esc(P.aTarget.label) + '</b><button class="dl-ibtn dl-atarget-x" title="Back to the input">✕</button></div>' : '';
    if (!v || !v.length) { pane.innerHTML = head + '<div class="dl-empty">Analysis of the input appears here: letter frequencies, Index of Coincidence, Kasiski, bigrams, entropy and a cipher identifier.</div>'; return; }
    if (!isBytes(v) && v.length > ANALYZE_CAP) v = v.slice(0, ANALYZE_CAP);
    var W = Math.max(240, Math.min(820, pane.clientWidth - 46)); // pane + section padding and borders
    P.lastW = q('.dl-body').clientWidth;
    var a, clues;
    try { a = core.analyze(v, { lang: prefs.alang }); clues = core.identify(v, a); }
    catch (e) { pane.innerHTML = head + '<div class="dl-empty">Analysis failed: ' + esc(e.message) + '</div>'; return; }
    var langs = core.langs().filter(function (L) { return L.script === (a.script === 'cyr' ? 'Cyrillic' : a.script === 'greek' ? 'Greek' : 'Latin'); });
    var lang = null;
    langs.forEach(function (L) { if (L.code === prefs.alang) lang = L; });
    if (!lang && a.fit[0]) langs.forEach(function (L) { if (L.code === a.fit[0].code) lang = L; });
    if (!lang) lang = langs[0];
    var A = a.alpha.length, N = a.N, html = head;

    // identifier
    var ch = clues.length ? clues.map(function (c) {
      return '<div class="dl-clue"><div class="dl-clue-h"><span class="dl-conf" title="confidence"><i style="width:' + Math.round(c.conf * 100) + '%"></i></span><b>' + esc(c.title) + '</b></div>' +
        '<div class="dl-clue-why">' + esc(c.why) + '</div>' +
        (c.ops.length ? '<div class="dl-clue-ops">' + c.ops.map(function (id) { var o = opById(id); return o ? '<button class="dl-chip" data-addop="' + id + '" title="Add to Manual recipe">+ ' + esc(o.name) + '</button>' : ''; }).join('') + '</div>' : '') +
        '</div>';
    }).join('') : '<div class="dl-note">No strong clues — short or unusual input. Auto-decode still tries everything.</div>';
    html += sec('Cipher identifier', 'What the shape and statistics of the text point to. Tap an operation to try it in Manual.', '<div class="dl-clues">' + ch + '</div>');

    // overview tiles
    var rd = a.readable;
    html += '<div class="dl-tiles">' +
      tile('Length', fmtN(a.len) + ' chars', fmtBytes(a.bytes) + (a.words ? ' · ' + fmtN(a.words) + ' words' : '')) +
      tile('Letters', fmtN(N), a.script === 'cyr' ? 'Cyrillic' : a.script === 'greek' ? 'Greek' : 'Latin A–Z') +
      tile('IC', N > 1 ? a.ic.toFixed(4) : '—', N > 1 ? icVerdict(a) : 'too few letters') +
      tile('Entropy', a.entropy.perChar.toFixed(2) + ' bits/char', a.entropy.perByte.toFixed(2) + ' bits/byte') +
      tile('Readable', rd.score + '/100', rd.langName || '—') +
      '</div>';

    if (N >= 1) {
      // letter frequencies vs language profile
      var obs = a.counts.map(function (c) { return N ? c / N * 100 : 0; }), exp = lang ? lang.uni.map(function (p) { return p * 100; }) : null;
      var langSel = '<label class="dl-inl">Compare with <select class="dl-alang">' + langs.map(function (L) { return '<option value="' + L.code + '"' + (lang && L.code === lang.code ? ' selected' : '') + '>' + esc(L.name) + '</option>'; }).join('') + '</select></label>';
      var fitL = lang ? a.fit.filter(function (f) { return f.code === lang.code; })[0] : null;
      var freq = '<div class="dl-legend"><span><i class="lg-obs"></i>this text</span>' + (lang ? '<span><i class="lg-exp"></i>' + esc(lang.name) + ' (expected)</span>' : '') + langSel + '</div>' +
        vbars({ w: W, h: 150, labels: a.alpha.split(''), vals: obs, exp: exp, fmt: function (x) { return x.toFixed(x < 10 ? 1 : 0) + '%'; }, label: 'Letter frequency',
          tip: function (i) { return a.alpha[i] + ': ' + a.counts[i] + ' (' + obs[i].toFixed(1) + '%)' + (exp ? ' · ' + lang.name + ' ' + exp[i].toFixed(1) + '%' : ''); } }) +
        (fitL ? '<p class="dl-note">Fit with ' + esc(lang.name) + ': cosine ' + fitL.cos.toFixed(3) + ', χ² ' + fmtN(fitL.chi) + '. Best Caesar alignment: shift <b>' + fitL.shift + '</b>' + (a.script === 'latin' ? ' (' + a.alpha[fitL.shift] + ')' : '') + ' — χ² ' + fmtN(fitL.shiftChi) + '.</p>' : '') +
        '<button class="dl-link dl-ftbl">Show table</button><div class="dl-table" hidden><table><tr><th>Letter</th><th>Count</th><th>%</th>' + (exp ? '<th>' + esc(lang.name) + '</th>' : '') + '</tr>' +
        a.alpha.split('').map(function (l, i) { return '<tr><td>' + esc(l) + '</td><td>' + a.counts[i] + '</td><td>' + obs[i].toFixed(2) + '</td>' + (exp ? '<td>' + exp[i].toFixed(2) + '</td>' : '') + '</tr>'; }).join('') + '</table></div>';
      html += sec('Letter frequency', 'Monoalphabetic ciphers keep the bar shapes but move them (Caesar slides them); transpositions keep them exactly; polyalphabetic ciphers flatten them.', freq);

      // IC
      var icRows = [{ label: 'This text', v: a.ic, text: a.ic.toFixed(4), cls: 'me' }].concat(a.icRefs.map(function (r) { return { label: r.name, v: r.ic, text: r.ic.toFixed(4) }; }))
        .concat([{ label: 'Random (1/' + A + ')', v: a.icRandom, text: a.icRandom.toFixed(4), cls: 'rand' }]);
      html += sec('Index of Coincidence', 'IC = Σ nᵢ(nᵢ−1) / (N(N−1)) — the chance two letters picked at random are the same. Natural language is lumpy (English ≈ 0.0667), uniform random letters are flat (≈ 0.0385). Substitution and transposition keep the language value; Vigenère-type ciphers pull it toward random.',
        hrows(icRows, Math.max(0.085, a.ic * 1.05)) + (a.friedman > 0 && a.ic < 0.06 ? '<p class="dl-note">Friedman estimate of key length ≈ <b>' + a.friedman.toFixed(1) + '</b></p>' : ''));

      // periodic IC
      if (a.periodic.length > 1) {
        var refIC = lang ? lang.ic : 0.066;
        var pvals = a.periodic.map(function (p) { return p.ic; });
        var peaks = {}; a.keyLengths.forEach(function (k) { if (k.peak) peaks[k.L] = 1; });
        var sugg = a.keySuggest.map(function (k) { return '<span class="dl-chip static">' + k.L + ' <small>' + Math.round(k.score * 100) + '%</small></span>'; }).join('');
        html += sec('Periodic IC (key length)', 'Split the letters into L columns (every L-th letter) and average the columns\' IC. At the true key length of a polyalphabetic cipher each column is a simple Caesar, so its IC jumps back up to the language level — and so do multiples of it.',
          vbars({ w: W, h: 140, labels: a.periodic.map(function (p) { return String(p.L); }), vals: pvals, every: 1, label: 'Periodic IC',
            cls: function (i) { return peaks[a.periodic[i].L] ? 'dl-c-obs' : 'dl-c-dim'; },
            refs: [{ v: refIC, label: lang ? lang.name.slice(0, 7) : 'lang', cls: 'lang' }, { v: a.icRandom, label: 'random', cls: 'rand' }],
            fmt: function (x) { return x.toFixed(3); }, yMax: Math.max(0.08, niceMax(Math.max.apply(null, pvals) * 1.05)),
            tip: function (i) { var k = a.keyLengths[i - 1]; return 'L = ' + a.periodic[i].L + ': IC ' + a.periodic[i].ic.toFixed(4) + (k ? ' · combined ' + Math.round(k.score * 100) + '%' : ''); } }) +
          (sugg ? '<div class="dl-sugg">Likely key lengths (periodic IC + Kasiski): ' + sugg + '</div>' : '') +
          '<button class="dl-link dl-ftbl">Show table</button><div class="dl-table" hidden><table><tr><th>L</th><th>Avg column IC</th><th>Kasiski</th><th>Combined</th></tr>' +
          a.periodic.map(function (p, i) { var k = a.keyLengths[i - 1]; return '<tr><td>' + p.L + (peaks[p.L] ? ' ▲' : '') + '</td><td>' + p.ic.toFixed(4) + '</td><td>' + (k ? Math.round(k.kasiski * 100) + '%' : '—') + '</td><td>' + (k ? Math.round(k.score * 100) + '%' : '—') + '</td></tr>'; }).join('') + '</table></div>');
      }

      // Kasiski
      var K = a.kasiski;
      if (N >= 12) {
        var maxRows = 12, kt = K.repeats.length ? '<div class="dl-table"><table><tr><th>Sequence</th><th>Positions</th><th>Spacings</th></tr>' + K.repeats.slice(0, maxRows).map(function (r) {
          return '<tr><td class="mono">' + esc(r.seq) + '</td><td>' + r.pos.slice(0, 6).join(', ') + (r.pos.length > 6 ? '…' : '') + '</td><td>' + r.spacings.slice(0, 6).join(', ') + (r.spacings.length > 6 ? '…' : '') + '</td></tr>';
        }).join('') + '</table></div>' + (K.total > maxRows ? '<p class="dl-note">' + fmtN(K.total) + ' repeated sequences in total.</p>' : '') : '<p class="dl-note">No letter sequence of length ≥ 3 repeats.</p>';
        var fmax = 0; K.factors.forEach(function (f) { if (f.count > fmax) fmax = f.count; });
        var kchart = fmax ? vbars({ w: W, h: 120, labels: K.factors.map(function (f) { return String(f.f); }), vals: K.factors.map(function (f) { return f.count; }), every: 1, label: 'Spacing factor counts',
          cls: function (i) { return K.factors[i].count >= fmax * 0.8 ? 'dl-c-obs' : 'dl-c-dim'; }, fmt: function (x) { return fmtN(x); },
          tip: function (i) { return 'factor ' + K.factors[i].f + ': ' + K.factors[i].count + ' (weighted by repeat length)'; } }) : '';
        var ksug = a.keySuggest.length ? '<div class="dl-sugg">Ranked with the periodic IC: ' + a.keySuggest.map(function (k) { return '<span class="dl-chip static">' + k.L + ' <small>' + Math.round(k.score * 100) + '%</small></span>'; }).join('') + '</div>' : '';
        html += sec('Kasiski examination', 'The same plaintext under the same part of a repeating key produces the same ciphertext, so repeats sit a multiple of the key length apart. Count which numbers divide the spacings: the key length (and its factors) stand out.', kt + kchart + ksug);
      }

      // bigrams
      if (N >= 2) {
        var top = a.bigrams.top.slice(0, 16).map(function (b) { return '<span class="dl-chip static mono">' + esc(b.g) + ' <small>' + b.n + '</small></span>'; }).join('');
        var dbl = a.doubles.count ? a.doubles.letters.map(function (d) { return d.l + d.l + ' ×' + d.n; }).join(', ') : 'none';
        html += sec('Bigrams', 'Letter pairs, row = first letter, column = second (darker = more frequent). English favours TH, HE, IN, ER, AN. A square with whole rows or columns missing hints at Playfair-style ciphers; an even spread suggests polyalphabetic or random text.',
          '<div class="dl-chips">' + top + '</div>' +
          '<div class="dl-hmwrap">' + heatmap(a, W) + '</div>' +
          '<div class="dl-legend"><span><i class="lg-hm0"></i>never</span><span><i class="lg-hm1"></i>rare</span><span><i class="lg-hm2"></i>frequent</span></div>' +
          '<p class="dl-note">Doubled letters: <b>' + a.doubles.count + '</b>' + (a.doubles.count ? ' (' + esc(dbl) + ')' : '') + ' — Playfair ciphertext never doubles a letter inside a pair. ' +
          a.bigrams.distinct + ' of ' + (A * A) + ' possible pairs occur.</p>' +
          (a.trigrams.length ? '<p class="dl-note">Top trigrams: ' + a.trigrams.slice(0, 10).map(function (t) { return '<span class="mono">' + esc(t.g) + '</span> ' + t.n; }).join(' · ') + '</p>' : ''));
      }

      // Shannon
      var E = a.entropy, ref = a.entropyRefs.filter(function (r) { return lang && r.code === lang.code; })[0] || a.entropyRefs[0];
      var srows = [{ label: 'This text', v: E.letters, text: E.letters.toFixed(3) + ' bits', cls: 'me' }];
      if (ref) srows.push({ label: ref.name, v: ref.bits, text: ref.bits.toFixed(3) + ' bits' });
      srows.push({ label: 'Random letters', v: E.lettersMax, text: E.lettersMax.toFixed(3) + ' bits', cls: 'rand' });
      html += sec('Shannon entropy & diversity', 'H = −Σ pᵢ log₂ pᵢ — average information per letter. Language sits well below the maximum log₂(' + A + ') = ' + E.lettersMax.toFixed(2) + ' bits because some letters dominate; ciphers that flatten frequencies push H toward the maximum. Over all bytes, compressed or encrypted data approaches 8 bits/byte.',
        hrows(srows, E.lettersMax) +
        '<div class="dl-tiles">' +
          tile('Shannon index H′', E.shannonIndex.toFixed(3) + ' nats', ref ? ref.name + ' ' + ref.nats.toFixed(3) : '') +
          tile('Evenness J', E.evenness.toFixed(3), 'H′ / ln(' + E.distinctLetters + ' letters)' + (ref ? ' · ' + ref.name + ' ' + ref.evenness.toFixed(3) : '')) +
          tile('Per character', E.perChar.toFixed(3) + ' bits', E.distinctChars + ' distinct chars') +
          tile('Per byte', E.perByte.toFixed(3) + ' bits', E.perByte > 7.2 ? 'near random' : E.perByte > 5.5 ? 'encoded / mixed' : 'text-like') +
        '</div>');
    }

    // characters, lengths, words, bytes
    var C = a.classes, tot = Math.max(1, a.len);
    var crow = [['Uppercase', C.upper], ['Lowercase', C.lower], ['Digits', C.digit], ['Whitespace', C.space], ['Punctuation', C.punct], ['Non-ASCII', C.nonAscii], ['Control / invalid', C.control], ['Other symbols', C.other]]
      .map(function (r) { return { label: r[0], v: r[1], text: fmtN(r[1]) + ' · ' + pct(r[1] / tot) }; });
    html += sec('Character classes', 'Base64 mixes cases and digits; hex is digits + A–F; classical ciphertext is mostly letters; binary data shows control and non-ASCII bytes.', hrows(crow, tot));
    var LH = a.lengthHints;
    var lh = '<div class="dl-tiles">' + LH.mods.map(function (m) { return tile('mod ' + m.m, String(m.r), m.m === 4 ? (m.r === 0 ? 'Base64 OK' : m.r === 1 ? 'not Base64' : '') : m.m === 8 ? (m.r === 0 ? 'Base32 / bytes OK' : '') : m.m === 2 ? (m.r === 0 ? 'hex / digraphs OK' : 'not hex') : m.m === 5 ? (m.r === 0 ? 'Bacon / Base85 OK' : '') : ''); }).join('') + '</div>' +
      (LH.grids.length ? '<p class="dl-note">' + fmtN(N) + ' letters fit grids of ' + LH.grids.map(function (g) { return g[0] + '×' + g[1]; }).join(', ') + ' — candidate shapes for columnar / route / scytale transpositions.</p>' : (N > 3 ? '<p class="dl-note">' + fmtN(N) + ' letters is prime — no full rectangular grid.</p>' : ''));
    html += sec('Length', 'Non-space length ' + fmtN(LH.noSpace) + '. Remainders hint at block encodings; the letter count\'s factors suggest transposition grids.', lh);
    var wsum = a.wordLens.reduce(function (x, y) { return x + y; }, 0);
    if (wsum >= 3) {
      html += sec('Word lengths', 'Natural language peaks at 2–5 letters (English mean ≈ 4.7). One long "word" means spaces were removed; uniform 5-letter groups are a classic ciphertext layout.',
        vbars({ w: W, h: 110, labels: a.wordLens.map(function (x, i) { return i === 15 ? '15+' : String(i); }).slice(1), vals: a.wordLens.slice(1), every: 1, label: 'Word lengths',
          fmt: function (x) { return fmtN(x); }, tip: function (i) { return (i + 1) + (i === 14 ? '+' : '') + ' letters: ' + a.wordLens[i + 1] + ' words'; } }));
    }
    if (a.byteHist) {
      var bh = a.byteHist, bl = bh.map(function (x, i) { return i % 64 === 0 ? (i < 16 ? '0' : '') + i.toString(16).toUpperCase() : ''; });
      html += sec('Byte histogram', 'Counts of each byte value 00–FF (UTF-8 bytes for text). Text clusters in 20–7E; flat coverage of all 256 values means compressed or encrypted data.',
        vbars({ w: W, h: 110, labels: bl, vals: bh, every: 1, label: 'Byte histogram', fmt: function (x) { return fmtN(x); },
          cls: function (i) { return i >= 0x20 && i < 0x7f ? 'dl-c-obs' : 'dl-c-dim'; },
          tip: function (i) { return '0x' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase() + (i >= 0x20 && i < 0x7f ? " '" + String.fromCharCode(i) + "'" : '') + ': ' + bh[i]; } }) +
        '<div class="dl-legend"><span><i class="lg-obs"></i>printable ASCII</span><span><i class="lg-dim"></i>other bytes</span></div>');
    }
    pane.innerHTML = html;
  }
  function icVerdict(a) {
    var mono = a.script === 'cyr' ? 0.047 : 0.055;
    if (a.N < 20) return 'few letters';
    if (a.ic >= mono) return 'language-like';
    if (a.ic >= 0.042) return 'polyalphabetic?';
    return 'near random';
  }

  // ---- manual tab ----------------------------------------------------------------------------
  var opsCache = null;
  function ops() { if (!opsCache && core) opsCache = core.ops(); return opsCache || []; }
  function opById(id) { var l = ops(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function addStep(id, given) {
    var o = opById(id);
    if (!o || !P) return;
    var params = {};
    o.params.forEach(function (p) { params[p.k] = p.def; });
    if (given) for (var k in given) if (given[k] !== undefined && given[k] !== null) params[k] = given[k];
    P.steps.push({ op: id, dir: 'dec', params: params });
  }
  function scheduleRecipe() { if (!P) return; clearTimeout(P.mTimer); P.mTimer = setTimeout(runRecipePreview, 140); }
  function renderManual() {
    if (!P) return;
    var pane = q('[data-pane="manual"]');
    if (!pane || currentTab() !== 'manual') return;
    if (!core) { pane.innerHTML = '<div class="dl-empty">Loading…</div>'; return; }
    var focus = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('dl-m-q');
    pane.innerHTML =
      '<div class="dl-m-add"><input class="dl-m-q" type="search" placeholder="Add a step — search ' + ops().length + ' operations…" value="' + esc(P.mQuery) + '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search operations">' +
      '<button class="dl-ibtn dl-m-browse' + (P.mBrowse ? ' on' : '') + '" title="Browse all operations">☰</button></div>' +
      '<div class="dl-m-ops">' + opsListHtml() + '</div>' +
      '<div class="dl-m-steps">' + stepsHtml() + '</div>' +
      '<div class="dl-m-out"></div>' +
      '<div class="dl-m-saved">' + savedHtml() + '</div>';
    if (focus) { var qi = pane.querySelector('.dl-m-q'); qi.focus(); try { qi.setSelectionRange(qi.value.length, qi.value.length); } catch (e) {} }
    runRecipePreview();
  }
  function opsListHtml() {
    var qy = P.mQuery.trim().toLowerCase();
    if (!qy && !P.mBrowse) return '';
    var list = ops().filter(function (o) {
      if (!qy) return true;
      return qy.split(/\s+/).every(function (w) { return (o.name + ' ' + o.desc + ' ' + o.cat + ' ' + o.id).toLowerCase().indexOf(w) >= 0; });
    });
    if (!list.length) return '<div class="dl-note">No operation matches.</div>';
    var html = '', cat = '';
    list.forEach(function (o) {
      if (o.cat !== cat) { cat = o.cat; html += '<div class="dl-m-cat">' + esc(cat) + '</div>'; }
      html += '<button class="dl-chip" data-addop2="' + o.id + '" title="' + esc(o.desc) + '">' + esc(o.name) + '</button>';
    });
    return html;
  }
  function paramHtml(o, s, i) {
    var dec = s.dir !== 'enc';
    return o.params.filter(function (p) { return !(p.enc && dec); }).map(function (p) {
      var v = s.params[p.k], id = 'dlp' + i + '_' + p.k, f;
      if (p.type === 'select') f = '<select data-p="' + p.k + '" id="' + id + '">' + p.options.map(function (op) { return '<option value="' + esc(op[0]) + '"' + (String(v) === String(op[0]) ? ' selected' : '') + '>' + esc(op[1]) + '</option>'; }).join('') + '</select>';
      else if (p.type === 'bool') f = '<input type="checkbox" data-p="' + p.k + '" id="' + id + '"' + (v ? ' checked' : '') + '>';
      else if (p.type === 'int') f = '<span class="dl-num"><button class="dl-nb" data-nb="-1" data-pk="' + p.k + '" aria-label="decrease">−</button><input type="number" inputmode="numeric" data-p="' + p.k + '" id="' + id + '" value="' + esc(String(v)) + '"' + (p.min !== undefined ? ' min="' + p.min + '"' : '') + (p.max !== undefined ? ' max="' + p.max + '"' : '') + '><button class="dl-nb" data-nb="1" data-pk="' + p.k + '" aria-label="increase">+</button></span>';
      else f = '<input type="text" data-p="' + p.k + '" id="' + id + '" value="' + esc(String(v == null ? '' : v)) + '" placeholder="' + esc(p.ph || '') + '" autocomplete="off" autocapitalize="off" spellcheck="false">';
      return '<label class="dl-param' + (p.type === 'bool' ? ' bool' : '') + '" for="' + id + '"><span>' + esc(p.label) + '</span>' + f + '</label>';
    }).join('');
  }
  function stepsHtml() {
    if (!P.steps.length) return '<div class="dl-empty small">No steps yet. Search above (e.g. “base64”, “vigenere”, “rail”), tap ☰ to browse, or press <b>Recipe</b> on a result.</div>';
    return P.steps.map(function (s, i) {
      var o = opById(s.op);
      if (!o) return '';
      return '<div class="dl-step' + (s.off ? ' off' : '') + '" data-s="' + i + '">' +
        '<div class="dl-step-h"><span class="dl-step-n">' + (i + 1) + '</span><b>' + esc(o.name) + '</b>' +
        (o.hasEnc ? '<span class="dl-seg"><button data-dir="dec" class="' + (s.dir !== 'enc' ? 'on' : '') + '">Decode</button><button data-dir="enc" class="' + (s.dir === 'enc' ? 'on' : '') + '">Encode</button></span>' : '') +
        '<span class="dl-sp"></span>' +
        (o.canSolve && s.dir !== 'enc' ? '<button class="dl-sbtn dl-solve" title="Find the key automatically">' + esc(o.solveLabel || 'Solve') + '</button>' : '') +
        '<button class="dl-sbtn" data-mv="toggle" title="' + (s.off ? 'Enable' : 'Disable') + ' this step">' + (s.off ? '▶' : '⏸') + '</button>' +
        '<button class="dl-sbtn" data-mv="up" title="Move up"' + (i ? '' : ' disabled') + '>↑</button>' +
        '<button class="dl-sbtn" data-mv="down" title="Move down"' + (i < P.steps.length - 1 ? '' : ' disabled') + '>↓</button>' +
        '<button class="dl-sbtn" data-mv="del" title="Remove">✕</button></div>' +
        (o.params.length ? '<div class="dl-step-p">' + paramHtml(o, s, i) + '</div>' : '') +
        '<div class="dl-step-o"></div></div>';
    }).join('');
  }
  function savedHtml() {
    var r = recipes();
    return '<div class="dl-m-bar">' +
      (P.steps.length ? '<button class="dl-abtn dl-m-save">Save recipe</button><button class="dl-abtn dl-m-clear">Clear steps</button>' : '') +
      '</div>' + (r.length ? '<div class="dl-m-cat">Saved recipes</div><div class="dl-chips">' + r.map(function (x, i) {
        return '<span class="dl-rchip"><button class="dl-chip" data-load="' + i + '" title="' + esc(x.steps.map(function (s) { var o = opById(s.op); return o ? o.name : s.op; }).join(' → ')) + '">' + esc(x.name) + '</button><button class="dl-rdel" data-rdel="' + i + '" aria-label="Delete recipe">✕</button></span>';
      }).join('') + '</div>' : '');
  }
  function describeVal(v) {
    if (v == null) return '';
    var d = core.describe(v);
    if (d.text != null) return d.text;
    return (d.magic ? '[' + d.magic + '] ' : '[' + fmtBytes(d.len) + ' of bytes] ') + d.hex.slice(0, 600);
  }
  function runRecipePreview() {
    if (!P || currentTab() !== 'manual' || !core) return;
    var pane = q('[data-pane="manual"]'), out = pane.querySelector('.dl-m-out');
    if (!out) return;
    var input = currentInput();
    if (!P.steps.length) { out.innerHTML = ''; return; }
    if (!input || !input.length) { out.innerHTML = '<div class="dl-note">Type or paste input above — every step previews live.</div>'; return; }
    if (!isBytes(input) && input.length > SEARCH_CAP * 4) input = input.slice(0, SEARCH_CAP * 4);
    var r = core.runRecipe(input, P.steps);
    pane.querySelectorAll('.dl-step').forEach(function (el) {
      var i = +el.getAttribute('data-s'), sr = r.steps[i], o = el.querySelector('.dl-step-o');
      if (!sr) { o.textContent = ''; o.className = 'dl-step-o'; return; }
      if (sr.skipped) { o.textContent = 'skipped'; o.className = 'dl-step-o dim'; return; }
      if (!sr.ok) { o.textContent = '⚠ ' + sr.error; o.className = 'dl-step-o err'; return; }
      var t = sr.text != null ? sr.text : (sr.magic ? '[' + sr.magic + '] ' : '[bytes] ') + sr.hex;
      o.textContent = '→ ' + t.slice(0, 160).replace(/\s+/g, ' ') + (t.length > 160 ? '…' : '');
      o.className = 'dl-step-o';
    });
    P.mOut = r.value;
    if (r.error) { out.innerHTML = '<div class="dl-banner warn">' + esc(r.error) + '</div>'; return; }
    var sc = r.value != null ? (isBytes(r.value) ? core.scoreView(r.value).score : core.score(r.value)) : null;
    var txt = describeVal(r.value), bytesOnly = isBytes(r.value) && core.describe(r.value).text == null;
    out.innerHTML = '<div class="dl-card">' +
      '<div class="dl-card-h"><span class="dl-score ' + scoreCls(sc ? sc.score : 0) + '">' + (sc ? sc.score : 0) + '</span><div class="dl-chain"><span class="dl-cstep">Output</span></div>' + (sc && sc.langName ? '<span class="dl-lang">' + esc(sc.langName) + '</span>' : '') + '</div>' +
      '<pre class="dl-out' + (txt.length > 1500 ? ' clip' : '') + '">' + esc(txt.slice(0, 20000)) + '</pre>' +
      '<div class="dl-acts"><button class="dl-abtn" data-mact="copy">Copy</button><button class="dl-abtn" data-mact="insert">Insert</button><button class="dl-abtn" data-mact="use">Use as input</button><button class="dl-abtn" data-mact="analyze">Analyze</button>' +
      (bytesOnly ? '<button class="dl-abtn" data-mact="save">Save</button>' : '') + '</div></div>';
  }
  function manualOutText() {
    var v = P.mOut;
    if (v == null) return null;
    if (!isBytes(v)) return v;
    var d = core.describe(v);
    return d.text != null ? d.text : core.util.toHex(v, ' ');
  }
  function manualClick(e, t) {
    var b, pane = q('[data-pane="manual"]');
    if (!pane || !pane.contains(t)) return;
    if ((b = t.closest('[data-addop2]'))) { addStep(b.getAttribute('data-addop2')); P.mQuery = ''; P.mBrowse = false; renderManual(); return; }
    if (t.closest('.dl-m-browse')) { P.mBrowse = !P.mBrowse; renderManual(); return; }
    var stepEl = t.closest('.dl-step'), i = stepEl ? +stepEl.getAttribute('data-s') : -1, s = P.steps[i];
    if (s && (b = t.closest('[data-dir]'))) { s.dir = b.getAttribute('data-dir'); renderManual(); return; }
    if (s && (b = t.closest('[data-mv]'))) {
      var mv = b.getAttribute('data-mv');
      if (mv === 'del') P.steps.splice(i, 1);
      else if (mv === 'up' && i > 0) { P.steps.splice(i - 1, 0, P.steps.splice(i, 1)[0]); }
      else if (mv === 'down' && i < P.steps.length - 1) { P.steps.splice(i + 1, 0, P.steps.splice(i, 1)[0]); }
      else if (mv === 'toggle') s.off = !s.off;
      renderManual(); return;
    }
    if (s && (b = t.closest('.dl-nb'))) {
      var k = b.getAttribute('data-pk'), o = opById(s.op), spec = o.params.filter(function (p) { return p.k === k; })[0];
      var v = (+s.params[k] || 0) + +b.getAttribute('data-nb');
      if (spec && spec.max !== undefined && v > spec.max) v = spec.min !== undefined ? spec.min : spec.max;
      if (spec && spec.min !== undefined && v < spec.min) v = spec.max !== undefined ? spec.max : spec.min;
      s.params[k] = v;
      var inp = stepEl.querySelector('[data-p="' + k + '"]'); if (inp) inp.value = v;
      scheduleRecipe(); return;
    }
    if (s && t.closest('.dl-solve')) { solveStep(i, t.closest('.dl-solve')); return; }
    if ((b = t.closest('[data-mact]'))) {
      var act = b.getAttribute('data-mact'), txt = manualOutText();
      if (txt == null) return;
      if (act === 'copy') copyText(txt);
      else if (act === 'insert') insertText(txt);
      else if (act === 'save') { if (isBytes(P.mOut)) download(P.mOut, 'output.bin'); }
      else if (act === 'use') { if (isBytes(P.mOut) && core.describe(P.mOut).text == null) setBytes(P.mOut, 'recipe output'); else { clearBytes(true); P.inEl.value = txt; } P.steps = []; renderManual(); }
      else if (act === 'analyze') { P.aTarget = { label: 'recipe output', value: P.mOut }; setTab('analysis'); }
      return;
    }
    if (t.closest('.dl-m-save')) {
      var name = window.prompt('Name this recipe', P.steps.map(function (x) { var o2 = opById(x.op); return o2 ? o2.name : x.op; }).join(' → ').slice(0, 40));
      if (!name) return;
      var list = recipes().filter(function (r) { return r.name !== name; });
      list.unshift({ name: name.slice(0, 60), steps: JSON.parse(JSON.stringify(P.steps)) });
      writeJSON(RECIPES_KEY, list.slice(0, MAX_RECIPES));
      toast('Recipe saved', 'success', 1200); renderManual(); return;
    }
    if (t.closest('.dl-m-clear')) { P.steps = []; renderManual(); return; }
    if ((b = t.closest('[data-load]'))) {
      var rr = recipes()[+b.getAttribute('data-load')];
      if (rr) {
        // saved recipes come from storage: rebuild each step through addStep (defaults + known params only)
        P.steps = [];
        (Array.isArray(rr.steps) ? rr.steps : []).forEach(function (x) {
          if (!x || !opById(x.op)) return;
          addStep(x.op, x.params && typeof x.params === 'object' ? x.params : null);
          var ns = P.steps[P.steps.length - 1];
          ns.dir = x.dir === 'enc' ? 'enc' : 'dec'; ns.off = !!x.off;
        });
        renderManual();
      }
      return;
    }
    if ((b = t.closest('[data-rdel]'))) {
      var all = recipes(), idx = +b.getAttribute('data-rdel');
      if (all[idx] && window.confirm('Delete recipe “' + all[idx].name + '”?')) { all.splice(idx, 1); writeJSON(RECIPES_KEY, all); renderManual(); }
    }
  }
  function manualChange(e, t) {
    if (!P) return;
    if (t.classList.contains('dl-m-q')) {
      P.mQuery = t.value;
      var box = q('.dl-m-ops'); if (box) box.innerHTML = opsListHtml();
      return;
    }
    var stepEl = t.closest && t.closest('.dl-step');
    if (!stepEl || !t.hasAttribute('data-p')) return;
    var s = P.steps[+stepEl.getAttribute('data-s')], k = t.getAttribute('data-p');
    if (!s) return;
    s.params[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? '' : +t.value) : t.value;
    scheduleRecipe();
  }
  function solveStep(i, btn) {
    var s = P.steps[i], st = P;
    var before = core.runRecipe(currentInput(), P.steps.slice(0, i));
    if (before.error || before.value == null) { toast('Fix the earlier steps first', 'error'); return; }
    if (!host) { host = makeHost(); }
    host.onmsg = onEngineMsg;
    var id = ++P.solveId;
    btn.disabled = true; btn.textContent = '…';
    P.solveCbs[id] = function (res) {
      if (P !== st) return;
      if (!res) { toast('No key found', 'info', 1600); renderManual(); return; }
      for (var k in res.params) s.params[k] = res.params[k];
      toast('Best guess' + (res.label ? ': ' + res.label : '') + ' (score ' + res.score + ')', res.score >= CLEAR ? 'success' : 'info', 2200);
      renderManual();
    };
    var v = before.value;
    host.post({ type: 'solve', id: id, op: s.op, input: isBytes(v) ? v.slice() : v, opts: { lang: prefs.lang === 'auto' ? '' : prefs.lang, ms: 2500 } });
  }

  // ---- translation into English (decodelab-translate.js, lazy) ------------------------
  var NOT_LANG = /^(en|flag|json|url|email|file|domain)$/;
  function loadTr() {
    if (TR) return Promise.resolve(TR);
    if (trLoading) return trLoading;
    trLoading = Promise.all([window.__DecodeLabTranslate ? 0 : loadScript(TR_URL), loadEngine()]).then(function () {
      if (!window.__DecodeLabTranslate) throw new Error('translation module missing');
      TR = window.__DecodeLabTranslate.create({ workerUrl: TRW_URL, core: core });
      return TR;
    }, function (e) { trLoading = null; throw e; });
    return trLoading;
  }
  function trEligible(r) {
    return !!(r && r.text && !r.derived && r.lang && !NOT_LANG.test(r.lang) && r.score >= 50 && r.text.trim().length >= 2);
  }
  function fmtMB(n) { return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + ' MB'; }
  // Detect the language of a result's text (Chrome's detector or ours).
  function trCodeFor(text) { return TR.detect(text).then(function (d) { return d.code && d.code !== 'en' ? d : null; }); }

  // After a search: learn which result languages are ready (no download), offer
  // Auto-translate, and translate automatically when it is on.
  function afterSearch() {
    if (!P) return;
    var st = P, cands = P.results.filter(trEligible).slice(0, 4);
    if (!cands.length) return;
    loadTr().then(function () {
      if (P !== st) return null;
      return Promise.all(cands.map(function (r) {
        return trCodeFor(r.text).then(function (d) {
          if (!d) return;
          r.trLang = d.code;
          return TR.status(d.code).then(function (s) { if (s.ready) P.trReady[d.code] = s.label; });
        });
      }));
    }).then(function () {
      if (P !== st) return;
      if (currentTab() === 'results') renderResults();
      if (prefs.autoTr) autoTranslate();
    }, function () {});
  }
  function autoTranslate() {
    if (!P || !TR) return;
    var st = P, list = P.results.filter(function (r) { return trEligible(r) && !r.tr && r.trLang && P.trReady[r.trLang]; }).slice(0, 3);
    var next = function () {
      if (P !== st || !list.length) return;
      var r = list.shift();
      doTranslateResult(r, r.trLang).then(next, next);
    };
    next();
  }
  function doTranslateResult(r, code) {
    var st = P;
    P.trBusy[r.id] = { prog: 0 };
    renderResults();
    return TR.translate(r.text, code, function (f) { if (P === st && P.trBusy[r.id]) { P.trBusy[r.id].prog = f; } }).then(function (res) {
      if (P !== st) return;
      delete P.trBusy[r.id];
      r.tr = res;
      addTranslated(r, res);
      renderResults();
    }, function (e) {
      if (P !== st) return;
      P.trBusy[r.id] = { err: e.message };
      renderResults();
      throw e;
    });
  }
  // The English version joins the ranking as one more decoding step.
  function addTranslated(r, res) {
    if (P.results.some(function (x) { return x.derivedFrom === r.id; })) return;
    var sc = core.score(res.text);
    P.results.push({
      id: 'tr' + r.id, derived: true, derivedFrom: r.id, depth: r.depth + 1, text: res.text, len: res.text.length,
      chain: r.chain.concat([{ id: 'translate', name: 'Translate', label: res.from + '→en', params: null, charset: '' }]),
      score: sc.score, lang: 'en', langName: 'English', conf: sc.conf, script: 'latin', trLabel: res.label,
    });
    P.results.sort(function (a, b) { return b.score - a.score || a.depth - b.depth; });
  }
  function translateResult(r) {
    var st = P;
    loadTr().then(function () { return r.trLang ? { code: r.trLang } : trCodeFor(r.text); }).then(function (d) {
      if (P !== st) return;
      if (!d) { toast('This already looks like English', 'info'); return; }
      r.trLang = d.code;
      return TR.status(d.code).then(function (s) {
        if (P !== st) return;
        if (s.ready) { P.trReady[d.code] = s.label; return doTranslateResult(r, d.code); }
        // needs a download first: hand over to the Translate tab (shows size + Download)
        P.tr.text = r.text; P.tr.fromInput = false; P.tr.forced = d.code; P.tr.out = null; P.tr.err = '';
        setTab('translate');
      });
    }).catch(function (e) { toast(e.message, 'error', 2500); });
  }

  // ---- Translate tab ----------------------------------------------------------------
  function trFrom() { return P.tr.forced || (prefs.trFrom !== 'auto' ? prefs.trFrom : (P.tr.det && P.tr.det.code) || ''); }
  function renderTranslate() {
    if (!P) return;
    var pane = q('[data-pane="translate"]');
    if (!pane || currentTab() !== 'translate') return;
    if (P.tr.text == null) { var v = currentInput(); P.tr.text = isBytes(v) ? '' : v; P.tr.fromInput = true; }
    var st = P;
    pane.innerHTML = '<div class="dl-empty small">Loading the translator…</div>';
    loadTr().then(function () {
      if (P !== st || currentTab() !== 'translate') return;
      var opts = '<option value="auto">Auto-detect</option>' + TR.languages().map(function (L) {
        return '<option value="' + L.code + '"' + (prefs.trFrom === L.code ? ' selected' : '') + '>' + esc(L.name) + '</option>';
      }).join('');
      pane.innerHTML =
        '<div class="dl-tr-bar"><label class="dl-tr-lab">From <select class="dl-tr-from" aria-label="Source language">' + opts + '</select></label>' +
          '<span class="dl-tr-det"></span><span class="dl-sp"></span><span class="dl-tr-to">→ English</span></div>' +
        '<textarea class="dl-tr-in" rows="4" placeholder="Text to translate into English (defaults to the input above)" spellcheck="false" aria-label="Text to translate"></textarea>' +
        '<div class="dl-tr-act"><button class="dl-btn primary dl-tr-go">Translate → English</button><span class="dl-tr-status" aria-live="polite"></span></div>' +
        '<div class="dl-tr-prog" hidden><i></i></div>' +
        '<div class="dl-tr-out"></div>' +
        '<section class="dl-sec dl-tr-mgr"><h4>Languages on this device</h4>' +
          '<p class="dl-note">Translation runs entirely on this device. ' + (TR.hasChrome ? 'Chrome\'s built-in translator is used where it has the language; otherwise ' : '') +
          'the Firefox Translations engine (' + fmtMB(TR.engineSize) + ', downloaded once with the first language) with one model per language. Nothing downloads until you tap.' +
          (TR.simd ? '' : ' <b>This browser lacks WebAssembly SIMD — the Firefox engine needs iOS/Safari 16.4+ or a recent Chrome/Firefox.</b>') + '</p>' +
          '<div class="dl-tr-list"><div class="dl-note">Checking…</div></div></section>';
      var ti = pane.querySelector('.dl-tr-in');
      ti.value = P.tr.text || '';
      if (prefs.trFrom !== 'auto' && P.tr.forced && P.tr.forced !== prefs.trFrom) pane.querySelector('.dl-tr-from').value = 'auto';
      renderTrOut();
      detectNow();
      renderTrList();
      if (P.tr.mgr) { P.tr.mgr = false; var mg = pane.querySelector('.dl-tr-mgr'); if (mg && mg.scrollIntoView) setTimeout(function () { try { mg.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {} }, 30); }
    }, function (e) {
      if (P === st) pane.innerHTML = '<div class="dl-empty">' + esc(e.message) + (navigator.onLine ? '' : ' — it needs one online load to cache') + '</div>';
    });
  }
  function scheduleDetect() { if (!P) return; clearTimeout(P.trTimer); P.trTimer = setTimeout(detectNow, 350); P.tr.forced = ''; }
  function detectNow() {
    if (!P || !TR) return;
    var st = P, text = P.tr.text || '';
    if (!text.trim()) { P.tr.det = null; updateTrStatus(); return; }
    TR.detect(text).then(function (d) { if (P !== st) return; P.tr.det = d; updateTrStatus(); });
  }
  function updateTrStatus() {
    if (!P || !TR || currentTab() !== 'translate') return;
    var st = P, det = q('.dl-tr-det'), stat = q('.dl-tr-status'), go = q('.dl-tr-go');
    if (!det || !stat) return;
    var d = P.tr.det, code = trFrom();
    det.textContent = P.tr.forced ? 'Detected: ' + TR.name(P.tr.forced) : d && d.code ? 'Detected: ' + TR.name(d.code) + (d.conf ? ' (' + Math.round(d.conf * 100) + '%)' : '') : (P.tr.text || '').trim() ? 'Language not recognised — pick it' : '';
    if (P.tr.busy) return;
    if (!code) { stat.textContent = ''; go.disabled = !(P.tr.text || '').trim(); return; }
    if (code === 'en') { stat.textContent = 'Already English.'; go.disabled = true; return; }
    go.disabled = false;
    TR.status(code).then(function (s) {
      if (P !== st || P.tr.busy) return;
      P.tr.st = s;
      if (s.ready) { stat.textContent = '✓ ' + s.label; go.textContent = 'Translate → English'; }
      else if (s.needs === 'download') { stat.textContent = TR.name(code) + ' needs a one-time download of ' + fmtMB(s.size) + ' — ' + s.label; go.textContent = 'Download ' + fmtMB(s.size) + ' & translate'; }
      else if (s.needs === 'chrome-download') { stat.textContent = 'Chrome will download its ' + TR.name(code) + ' model once — ' + s.label; go.textContent = 'Download & translate'; }
      else { stat.textContent = s.why || 'Not available'; go.disabled = true; }
    });
  }
  function setTrProgress(f, stage) {
    var bar = q('.dl-tr-prog'), stat = q('.dl-tr-status');
    if (!bar) return;
    bar.hidden = f == null;
    if (f != null) bar.querySelector('i').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    if (stat && stage) stat.textContent = { download: 'Downloading… ', verify: 'Verifying… ', engine: 'Starting the engine… ', model: 'Loading the model… ', translate: 'Translating… ' }[stage] + (f != null && stage !== 'engine' && stage !== 'model' ? Math.round(f * 100) + '%' : '');
  }
  function runTranslate() {
    if (!P || !TR || P.tr.busy) return;
    var st = P, text = P.tr.text || '', code = trFrom();
    if (!text.trim()) { toast('Nothing to translate'); return; }
    if (!code) { toast('Pick the source language'); return; }
    P.tr.busy = true; P.tr.err = ''; P.tr.out = null;
    q('.dl-tr-go').disabled = true;
    renderTrOut();
    setTrProgress(0, 'translate');
    TR.status(code).then(function (s) {
      if (s.ready) return s;
      if (!s.needs) throw new Error(s.why || 'not available');
      setTrProgress(0, 'download');
      return TR.download(code, function (f, stage) { if (P === st) setTrProgress(f, stage); }).then(function (s2) { if (P === st) renderTrList(); return s2; });
    }).then(function () {
      return TR.translate(text, code, function (f, stage) { if (P === st) setTrProgress(f, stage === 'translate' ? 'translate' : stage); });
    }).then(function (res) {
      if (P !== st) return;
      P.tr.busy = false; P.tr.out = res;
      P.trReady[code] = res.label;
      setTrProgress(null); renderTrOut(); updateTrStatus();
    }, function (e) {
      if (P !== st) return;
      P.tr.busy = false; P.tr.err = e.message;
      setTrProgress(null); renderTrOut(); updateTrStatus();
    });
  }
  function renderTrOut() {
    var box = q('.dl-tr-out');
    if (!box) return;
    if (P.tr.err) { box.innerHTML = '<div class="dl-banner warn">⚠ ' + esc(P.tr.err) + '</div>'; return; }
    var o = P.tr.out;
    if (!o) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="dl-card"><div class="dl-card-h"><div class="dl-chain"><span class="dl-cstep">English<small>' + esc(TR.name(o.from) + ' → English') + '</small></span></div><span class="dl-lang">' + esc(o.label) + '</span></div>' +
      '<pre class="dl-out">' + esc(o.text) + '</pre>' +
      '<div class="dl-acts"><button class="dl-abtn" data-tact="copy">Copy</button><button class="dl-abtn" data-tact="insert">Insert</button><button class="dl-abtn" data-tact="use">Use as input</button></div></div>';
  }
  function renderTrList() {
    if (!P || !TR) return;
    var st = P, box = q('.dl-tr-list');
    if (!box) return;
    Promise.all([TR.downloaded(), TR.usage()]).then(function (r) {
      if (P !== st) return;
      var have = r[0], used = r[1], langs = TR.languages(), n = 0;
      var rows = langs.map(function (L) {
        var got = !!have[L.code], prog = P.tr.dl[L.code], ch = P.tr.chrome[L.code];
        if (got) n++;
        var state = prog != null ? Math.round(prog * 100) + '%' : got ? '✓ on device' : ch === 'available' ? 'Chrome ✓' : '';
        var btn = prog != null ? '' : got ? '<button class="dl-sbtn" data-trm="' + L.code + '">Remove</button>' : '<button class="dl-sbtn dl-solve" data-tdl="' + L.code + '"' + (TR.simd && TR.storage ? '' : ' disabled') + '>Download</button>';
        return '<div class="dl-lrow" data-code="' + L.code + '"><span class="dl-lname">' + esc(L.name) + ' <small>' + esc(L.native) + '</small></span>' +
          '<span class="dl-lsz">' + fmtMB(L.size) + '</span><span class="dl-lst">' + esc(P.tr.dlErr[L.code] ? '⚠ ' + P.tr.dlErr[L.code] : state) + '</span>' + btn + '</div>';
      }).join('');
      box.innerHTML = '<div class="dl-lsum">' + n + ' language' + (n === 1 ? '' : 's') + ' on this device · ' + fmtMB(used) + ' used' + (have._engine ? ' (incl. ' + fmtMB(TR.engineSize) + ' engine)' : '') +
        (used ? ' <button class="dl-sbtn" data-trmall="1">Remove all</button>' : '') + '</div>' + rows;
      if (TR.hasChrome) chromeBadges(langs.filter(function (L) { return P.tr.chrome[L.code] === undefined; }));
    });
  }
  function chromeBadges(list) {
    var st = P;
    list.forEach(function (L) {
      P.tr.chrome[L.code] = null;
      TR.status(L.code).then(function (s) {
        if (P !== st) return;
        P.tr.chrome[L.code] = s.engine === 'chrome' ? (s.ready ? 'available' : 'downloadable') : 'no';
        var row = q('.dl-lrow[data-code="' + L.code + '"] .dl-lst');
        if (row && !row.textContent && s.engine === 'chrome') row.textContent = s.ready ? 'Chrome ✓' : 'Chrome ↓';
      });
    });
  }
  function translateClick(e, t) {
    var pane = q('[data-pane="translate"]'), b;
    if (!pane || !pane.contains(t)) return false;
    var st = P;
    if (t.closest('.dl-tr-go')) { runTranslate(); return true; }
    if ((b = t.closest('[data-tact]'))) {
      var o = P.tr.out, act = b.getAttribute('data-tact');
      if (!o) return true;
      if (act === 'copy') copyText(o.text);
      else if (act === 'insert') insertText(o.text);
      else if (act === 'use') { clearBytes(true); P.inEl.value = o.text; P.tr.fromInput = true; P.tr.text = o.text; P.tr.out = null; onInputChanged(); setTab('results'); }
      return true;
    }
    if ((b = t.closest('[data-tdl]'))) {
      var code = b.getAttribute('data-tdl');
      P.tr.dl[code] = 0; delete P.tr.dlErr[code];
      renderTrList();
      TR.download(code, function (f) {
        if (P !== st) return;
        P.tr.dl[code] = f;
        var cell = q('.dl-lrow[data-code="' + code + '"] .dl-lst'); if (cell) cell.textContent = Math.round(f * 100) + '%';
      }).then(function () {
        if (P !== st) return;
        delete P.tr.dl[code]; P.trReady[code] = 1; renderTrList(); updateTrStatus();
        toast(TR.name(code) + ' is ready offline', 'success', 1600);
      }, function (err) {
        if (P !== st) return;
        delete P.tr.dl[code]; P.tr.dlErr[code] = err.message; renderTrList();
      });
      return true;
    }
    if ((b = t.closest('[data-trm]'))) {
      var rc = b.getAttribute('data-trm');
      TR.remove(rc).then(function () { if (P === st) { delete P.trReady[rc]; renderTrList(); updateTrStatus(); } });
      return true;
    }
    if (t.closest('[data-trmall]')) {
      if (!window.confirm('Remove every translation model and the engine from this device?')) return true;
      TR.removeAll().then(function () { if (P === st) { P.trReady = {}; P.tr.chrome = {}; renderTrList(); updateTrStatus(); } });
      return true;
    }
    return false;
  }
  function autoTrToggle() {
    var codes = Object.keys(P.trReady);
    if (!codes.length || !P.results.some(trEligible)) return '';
    return '<label class="dl-autotr"><input type="checkbox" class="dl-autotr-cb"' + (prefs.autoTr ? ' checked' : '') + '> Auto-translate to English <small>(on-device)</small></label>';
  }

  Cade.registerWidget({
    name: 'Decode Lab',
    description: 'Auto-decode mystery text: Base64/hex/Morse/… chains, Caesar, Vigenère, XOR & more, frequency analysis, offline translation to English',
    icon: '🔓',
    tags: 'decode,decoder,cipher,brute force,base64,caesar,vigenere,xor,crypto,ctf,frequency analysis,identify,magic,rot13,morse,hex,encoding,puzzle,cryptanalysis,kasiski,index of coincidence,translate,translation,offline translation,english',
    open: open,
  });
})();
