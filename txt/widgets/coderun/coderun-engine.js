/* Code Runner engine — runs fenced code blocks and writes a ```output block
 * directly below them (replaced on re-run), or shows output in the Code Runner
 * panel only.
 *
 * - JavaScript / TypeScript: a hidden <iframe sandbox="allow-scripts"> with a
 *   srcdoc document (opaque origin: no access to the app, its storage or
 *   cookies). Console calls, uncaught errors and unhandled rejections come
 *   back over postMessage with line numbers mapped to the block; top-level
 *   await works (the block runs inside an async function, or as a module when
 *   it has import/export). Loop checks stop runaway loops at the timeout (on
 *   Safari the iframe shares the app's thread, so a timer alone couldn't), and
 *   the frame is removed afterwards. TypeScript types are stripped by sucrase
 *   (pinned, lazy, from jsDelivr).
 * - Python: Pyodide in a worker that lives inside its own sandboxed,
 *   opaque-origin iframe (coderun-py-worker.js is fetched as text and started
 *   there from a blob:/data: URL; if a browser refuses workers in such a frame
 *   it runs in that frame's page instead). Pyodide's files and micropip's PyPI
 *   downloads are fetched by the app on the sandbox's behalf (an allowlist:
 *   the pinned jsDelivr folder, pypi.org index JSON, files.pythonhosted.org)
 *   and kept in a 'cade-py-<version>' Cache Storage bucket that app updates
 *   don't touch, so Python and its packages work offline; the first download
 *   shows progress. Options -> "Python packages" keeps a list of packages to
 *   have offline (sizes, download, remove, load at start). One namespace per
 *   room; stop / timeout destroy the iframe.
 * - JSON: validated (line/column errors) and pretty-printed.
 * - Shell: explained, not run. HTML/CSS open the Live Preview.
 * - Linked blocks (Cade.prefs('codeblocks') 'linked', default on): js / ts /
 *   python runs go to the notebook (../notebook/notebook-engine.js, loaded on
 *   the first such run) — one live scope per language per note, dependents
 *   re-run, rich output. E._nb is the bridge it uses for Python and TS.
 *
 * Loaded on demand by the Code Runner widget, its palette scripts and the
 * "Run buttons" plugin (after coderun-kit.js). Exposes window.__cadeCodeRun.
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined' || window.__cadeCodeRun) return;
  var Cade = window.Cade;
  var K = window.__cadeCodeRunKit;
  if (!K) return;
  Cade.loadCSS('coderun.css');

  var WORKER_URL = Cade.asset('coderun-py-worker.js'); // resolve now, while currentScript is us
  function absURL(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var NB_DIR = absURL(WORKER_URL).replace(/coderun\/coderun-py-worker\.js(\?.*)?$/, 'notebook/');
  var NB_CORE = NB_DIR + 'notebook-core.js', NB_ENGINE = NB_DIR + 'notebook-engine.js';
  var PY_VERSION = '0.29.5';
  var PY_INDEX = 'https://cdn.jsdelivr.net/pyodide/v' + PY_VERSION + '/full/';
  var PY_DL_MB = '5.3';            // compressed download: wasm + stdlib + loader
  var PY_EST_BYTES = 12300000;     // the same, decompressed (what the app counts while proxying)
  var SUCRASE_URL = 'https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm';
  var PREFS_KEY = 'cade-coderun-prefs';
  var PYSEEN_KEY = 'cade-coderun-pyseen';
  var PKGS_KEY = 'cade-coderun-pypkgs';     // the "Python packages" list (+ which PyPI files each needs)
  // Python's own Cache Storage bucket, keyed by the Pyodide version (see "Python cache" below).
  var PY_CACHE = 'cade-py-' + PY_VERSION;
  var PY_RUNTIME = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
  var MAX_FILE = 200 * 1048576, MAX_INDEX = 40 * 1048576, INDEX_WAIT = 12000;
  var SUGGESTED = ['pandas', 'numpy', 'pyarrow', 'matplotlib', 'openpyxl'];
  var PANEL_ID = 'coderun-panel';
  var MAX_RUNS = 20, MAX_TEXT = 200000, MAX_ITEMS = 5000;
  var SHELL_MSG = "Shell commands can't run here — the browser has no terminal or file system. Copy the block into a terminal instead.";

  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, type, ms) { try { Cade.showToast(m, type || 'info', ms || 2600); } catch (e) {} }
  function msg(e) { return String((e && (e.message || e)) || 'error'); }
  function roomKey() { try { var r = Cade.roomsApi && Cade.roomsApi.activeRoom(); return r ? String(r) : 'default'; } catch (e) { return 'default'; } }
  function hm() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { var d = new Date(); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); } }

  // ---- prefs -------------------------------------------------------------------------
  var prefs = { target: 'inline', jsTimeout: 5, pyTimeout: 30 };
  (function () {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || '{}') || {};
      if (p.target === 'inline' || p.target === 'panel') prefs.target = p.target;
      if (p.jsTimeout > 0) prefs.jsTimeout = clamp(p.jsTimeout, 1, 120);
      if (p.pyTimeout > 0) prefs.pyTimeout = clamp(p.pyTimeout, 1, 600);
    } catch (e) {}
  })();
  function clamp(v, a, b) { v = Math.round(+v || 0); return Math.max(a, Math.min(b, v)); }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ---- state ----------------------------------------------------------------------------
  var queue = [], cur = null, seq = 0;
  var runs = []; // panel history, newest first
  var py = { host: null, state: 'off', ready: null, onInit: null, loaded: 0, pkgBytes: 0, version: '', pending: {}, ops: {}, seq: 0, error: '', preloading: false };
  var E = window.__cadeCodeRun = { version: 0 };

  // ---- linked blocks: the notebook takes js / ts / python runs ------------------------------
  // The contract's fallback until the core has Cade.prefs (shared with the
  // notebook through window.__cadePrefsFallback, so a set() there is seen here).
  function prefsOf(id, fields) {
    if (typeof Cade.prefs === 'function') { try { var p = Cade.prefs(id); if (p && typeof p.get === 'function') return p; } catch (e) {} }
    var reg = window.__cadePrefsFallback || (window.__cadePrefsFallback = {});
    if (reg[id]) return reg[id];
    var d = {}, ls = [];
    fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    return (reg[id] = {
      fallback: true,
      get: function (k) { return d[k]; },
      all: function () { var o = {}; for (var k in d) o[k] = d[k]; return o; },
      set: function (k, v) { d[k] = v; var all = this.all(); ls.slice().forEach(function (fn) { try { fn(k, v, all); } catch (e) {} }); },
      on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
    });
  }
  function linkedOn() {
    try { return prefsOf('codeblocks', [{ key: 'linked', type: 'toggle', default: true }]).get('linked') !== false; } catch (e) { return true; }
  }
  function nbLang(lang) { return lang === 'js' || lang === 'ts' || lang === 'py'; }
  function nbLoaded() { return window.__cadeNotebook || null; }
  function loadScript(url) {
    var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});
    if (L[url]) return L[url];
    L[url] = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = url; sc.async = false;
      sc.onload = function () { res(); };
      sc.onerror = function () { delete L[url]; rej(new Error('The notebook failed to load (offline?)')); };
      document.head.appendChild(sc);
    });
    return L[url];
  }
  function loadNotebook() {
    if (window.__cadeNotebook) return Promise.resolve(window.__cadeNotebook);
    return loadScript(NB_CORE).then(function () { return loadScript(NB_ENGINE); }).then(function () {
      if (!window.__cadeNotebook) throw new Error('The notebook failed to start');
      return window.__cadeNotebook;
    });
  }
  E._loadNotebook = loadNotebook;
  E.linkedOn = linkedOn;

  var nudgeT = 0;
  // State changed: re-render the editor chips (empty transaction; dispatching
  // inside an update isn't allowed, hence the timer) and the panel status.
  function bump() {
    E.version++;
    if (nudgeT) return;
    nudgeT = setTimeout(function () {
      nudgeT = 0;
      try { if (Cade.editor) Cade.editor.dispatch({}); } catch (e) {}
      renderStatus();
    }, 40);
  }

  // Map queued/running jobs through edits so output lands below the right block.
  Cade.onEditorUpdate(function (u) {
    if ((!cur && !queue.length) || !u.docChanged) return;
    var jobs = cur ? queue.concat([cur]) : queue;
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (j.doc !== u.startState.doc) continue;
      j.openFrom = u.changes.mapPos(j.openFrom, 1);
      j.doc = u.state.doc;
    }
    bump();
  });

  // The job's block in the live document, or null if it moved away / the room changed.
  function liveBlock(job) {
    var ed = Cade.editor;
    if (!ed) return null;
    var doc = ed.state.doc;
    if (job.doc !== doc || job.room !== roomKey() || job.openFrom > doc.length) return null;
    var ln = doc.lineAt(job.openFrom);
    if (ln.from !== job.openFrom || !K.isFence(ln.text)) return null;
    var blocks = K.scanFences(doc), b = K.blockAt(blocks, ln.number);
    if (!b || b.open !== ln.number || b.close === -1) return null;
    return { doc: doc, block: b };
  }
  // Fallback for finished runs (no longer mapped): same language + same code.
  function findByCode(lang, code, nearLine) {
    var ed = Cade.editor; if (!ed) return null;
    var doc = ed.state.doc, best = null, bestD = Infinity;
    K.scanFences(doc).forEach(function (b) {
      // an untagged block may have been run under a detected language
      if ((b.lang !== lang && (b.lang || String(b.info || '').trim())) || b.close === -1 || K.codeOf(doc, b).text !== code) return;
      var d = Math.abs(b.open - (nearLine || 0));
      if (d < bestD) { bestD = d; best = b; }
    });
    return best ? { doc: doc, block: best } : null;
  }

  // ---- queue -------------------------------------------------------------------------------
  function isQueued(openFrom) {
    var room = roomKey();
    if (cur && cur.openFrom === openFrom && cur.room === room) return cur;
    for (var i = 0; i < queue.length; i++) if (queue[i].openFrom === openFrom && queue[i].room === room) return queue[i];
    return null;
  }
  E.statusAt = function (openFrom) {
    var N = nbLoaded(), ns = N ? N.statusAt(openFrom) : null;
    if (ns) return ns;
    var j = isQueued(openFrom);
    if (!j) return null;
    return { state: j === cur ? j.state : 'queued', text: j === cur ? (j.statusText || 'Running…') : 'Queued' };
  };
  E.busy = function () { var N = nbLoaded(); return !!cur || queue.length > 0 || !!(N && N.busy()); };

  function titleOf(code) {
    var first = '';
    String(code).split('\n').some(function (l) { l = l.trim(); if (l) { first = l; return true; } return false; });
    return first.length > 60 ? first.slice(0, 60) + '…' : first;
  }
  function enqueue(b, doc, batch) {
    var job = { id: ++seq, lang: b.lang, openFrom: b.openFrom, doc: doc, room: roomKey(), line: b.open,
      code: K.codeOf(doc, b).text, state: 'queued', statusText: 'Queued', batch: batch || null, items: null, liveText: '' };
    job.promise = new Promise(function (res) { job.resolve = res; });
    queue.push(job);
    bump();
    pump();
    return job;
  }
  function settleBatch(job, status) {
    var bt = job.batch;
    if (!bt) return;
    bt.done++;
    if (status === 'error' || status === 'timeout') bt.errors++;
    if (bt.done >= bt.total) {
      if (!bt.stopped) toast('Ran ' + bt.total + ' block' + (bt.total === 1 ? '' : 's') + (bt.errors ? ' · ' + bt.errors + ' with errors' : ''), bt.errors ? 'info' : 'success', 2600);
      bt.resolve();
    }
  }
  function drop(job, status) {
    job.state = 'done';
    settleBatch(job, status);
    job.resolve(status);
  }
  function pump() {
    if (cur || !queue.length) return;
    var job = cur = queue.shift();
    var lb = liveBlock(job);
    if (!lb) { cur = null; drop(job, 'skipped'); toast('A queued code block moved away — skipped', 'info'); pump(); return; }
    job.code = K.codeOf(lb.doc, lb.block).text;
    job.line = lb.block.open;
    job.state = 'running'; job.statusText = 'Running…';
    job.title = titleOf(job.code);
    addRun(job);
    bump();
    var p;
    try { p = execute(job); } catch (e) { p = Promise.resolve({ status: 'error', text: '✖ ' + msg(e), ms: 0 }); }
    p.then(function (res) { finishJob(job, res); }, function (e) { finishJob(job, { status: 'error', text: '✖ ' + msg(e), ms: 0 }); });
  }
  function execute(job) {
    if (job.lang === 'json') {
      var r = K.jsonReport(job.code);
      return Promise.resolve({ status: r.ok ? 'ok' : 'error', text: r.text, ms: 0 });
    }
    if (job.lang === 'py') return runPy(job);
    if (job.lang === 'ts') {
      job.statusText = 'Loading TypeScript…'; bump();
      job.cancel = function () { job.cancel = null; finishJob(job, { status: 'stopped', text: '■ Stopped', ms: 0 }); };
      return tsToJs(job.code).then(function (js) {
        if (cur !== job) return { status: 'stopped', text: '', ms: 0 };
        job.cancel = null;
        job.statusText = 'Running…'; bump();
        return runJS(job, js);
      }, function (e) {
        return { status: 'error', text: '✖ TypeScript: ' + msg(e).replace(/^SyntaxError:\s*/, ''), ms: 0 };
      });
    }
    return runJS(job, job.code);
  }
  function headerFor(job, res) {
    var c = job.lang === 'py' ? '#' : '//';
    if (job.lang === 'json') return c + ' checked ' + hm();
    return c + ' ran ' + hm() + ' · ' + K.fmtMs(res.ms);
  }
  function finishJob(job, res) {
    if (cur !== job) return;
    var text = res.text != null ? res.text : itemsText(res.items || []);
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n… (output cut at ' + Math.round(MAX_TEXT / 1000) + ' KB)';
    var header = headerFor(job, res);
    job.state = 'done';
    finishRun(job, res.status, text, header);
    if (res.status !== 'stopped' && prefs.target === 'inline') {
      if (!writeInline(job, text, header)) openPanel(true);
    } else if (res.status !== 'stopped') openPanel(true);
    cur = null;
    settleBatch(job, res.status);
    job.resolve(res.status);
    bump();
    pump();
  }
  function writeInline(job, text, header, lbOverride) {
    var ed = Cade.editor;
    if (!ed) return false;
    if (ed.state.readOnly) { toast('Read-only mode — output is in the Code Runner panel', 'info', 2600); return false; }
    var lb = lbOverride || liveBlock(job);
    if (!lb) { toast('The block moved or the room changed — output is in the Code Runner panel', 'info', 3200); return false; }
    try {
      ed.dispatch({ changes: K.outputChange(lb.doc, lb.block, K.formatOutput(text, header)), userEvent: 'input' });
      return true;
    } catch (e) { return false; }
  }

  // ---- JavaScript sandbox ----------------------------------------------------------------------
  function itemsText(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var lv = items[i][0], t = String(items[i][1]);
      if (lv === 'warn') t = '⚠ ' + t;
      else if (lv === 'error' && !/^[✖⏱]/.test(t)) t = '✖ ' + t;
      out.push(t);
    }
    return out.join('\n');
  }
  function runJS(job, code) {
    return new Promise(function (resolve) {
      var token = 'cr' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      var timeout = clamp(prefs.jsTimeout, 1, 120) * 1000;
      var built;
      try { built = K.buildRunnerDoc(code, { token: token, timeout: timeout }); }
      catch (e) { resolve({ status: 'error', text: '✖ ' + msg(e), ms: 0 }); return; }
      var ifr = document.createElement('iframe');
      ifr.setAttribute('sandbox', 'allow-scripts'); // NOT allow-same-origin: opaque origin
      ifr.setAttribute('aria-hidden', 'true');
      ifr.setAttribute('tabindex', '-1');
      ifr.title = 'Code Runner sandbox';
      ifr.className = 'cr-sandbox';
      var items = job.items = [], done = false, killT = 0, t0 = Date.now();
      function onMsg(e) {
        if (done || e.source !== ifr.contentWindow) return;
        var m = e.data;
        if (!m || m.__cr !== token) return;
        if (m.type === 'out' && m.items && m.items.length) {
          for (var i = 0; i < m.items.length && items.length < MAX_ITEMS; i++) items.push([String(m.items[i][0]), String(m.items[i][1])]);
          liveUpdate(job);
        } else if (m.type === 'clear') { items.length = 0; liveUpdate(job); }
        else if (m.type === 'done') end(m.status === 'timeout' || m.status === 'error' ? m.status : 'ok', +m.ms || 0, +m.dropped || 0);
      }
      function end(status, ms, dropped, note) {
        if (done) return;
        done = true;
        clearTimeout(killT);
        window.removeEventListener('message', onMsg);
        try { ifr.remove(); } catch (e) {} // also ends any timers left running inside
        if (dropped) items.push(['sys', '… ' + dropped + ' more console line' + (dropped === 1 ? '' : 's') + ' not captured']);
        if (note) items.push(['sys', note]);
        job.cancel = null;
        resolve({ status: status, items: items, ms: ms });
      }
      job.cancel = function () { end('stopped', Date.now() - t0, 0, '■ Stopped'); };
      window.addEventListener('message', onMsg);
      killT = setTimeout(function () {
        end('timeout', timeout, 0, '⏱ Timed out after ' + K.fmtMs(timeout) + ' — stopped (a timer, interval or promise was still pending)');
      }, timeout + 1500);
      ifr.srcdoc = built.html;
      (document.body || document.documentElement).appendChild(ifr);
    });
  }

  // TypeScript -> JavaScript (types stripped, lines preserved).
  var sucraseP = null;
  function tsToJs(code) {
    if (!sucraseP) {
      sucraseP = new Promise(function (resolve, reject) {
        if (window.__cadeSucrase) { resolve(window.__cadeSucrase); return; }
        var ev = 'cade-sucrase-' + Date.now();
        var t = setTimeout(function () { fail(new Error('timed out loading the TypeScript transform')); }, 30000);
        function fail(e) { clearTimeout(t); window.removeEventListener(ev, ok); sucraseP = null; reject(e); }
        function ok() { clearTimeout(t); window.removeEventListener(ev, ok); if (window.__cadeSucrase) resolve(window.__cadeSucrase); else fail(new Error('TypeScript transform unavailable')); }
        window.addEventListener(ev, ok);
        var s = document.createElement('script');
        s.type = 'module';
        s.onerror = function () { fail(new Error("couldn't download the TypeScript transform (offline?)")); };
        s.textContent = 'import { transform } from ' + JSON.stringify(SUCRASE_URL) + ';\nwindow.__cadeSucrase = { transform: transform };\nwindow.dispatchEvent(new Event(' + JSON.stringify(ev) + '));';
        document.head.appendChild(s);
      });
    }
    return sucraseP.then(function (S) {
      return S.transform(code, { transforms: ['typescript'], disableESTransforms: true, keepUnusedImports: true }).code;
    });
  }

  // ---- Python -------------------------------------------------------------------------------------
  // Is the runtime on this device? Known exactly once the bucket was looked at
  // (pyc.runtime); until then, whether Python ever started here.
  function pySeen() {
    if (pyc.runtime != null) return pyc.runtime;
    try { return Cade.store.get(PYSEEN_KEY) === PY_VERSION; } catch (e) { return false; }
  }
  function pyStatusText() {
    if (py.state === 'ready') return 'Python ' + py.version + ' ready' + (py.preloading ? ' · loading start-up packages…' : '') + (py.host && py.host.mode === 'page' ? ' (no worker: runs on the page)' : '');
    if (py.state === 'loading') {
      var pct = Math.min(99, Math.round(py.loaded / PY_EST_BYTES * 100));
      return (pySeen() ? 'Starting Python' : 'Downloading Python') + (py.loaded ? ' ' + pct + '%' : '…');
    }
    if (py.state === 'error') return 'Python failed to load';
    return pySeen() ? 'Python not started' : 'Python not loaded (~' + PY_DL_MB + ' MB, first run only)';
  }
  var progT = 0;
  function progress() {
    var pj = cur && cur.lang === 'py' ? cur : py.nbJob;
    if (pj) {
      if (pj.state === 'loading') pj.statusText = pyStatusText();
      else if (py.pkgBytes) pj.statusText = 'Loading packages… ' + (Math.round(py.pkgBytes / 1e5) / 10) + ' MB';
      if (pj.nb && pj.nb.onStatus) pj.nb.onStatus(pj.state, pj.statusText);
    }
    if (!progT) progT = setTimeout(function () { progT = 0; bump(); }, 250);
  }
  function onPyMsg(m) {
    var p;
    m = m || {};
    if (m.type === 'progress') {
      var pj = cur && cur.lang === 'py' ? cur : py.nbJob;
      if (py.state === 'ready' && pj && m.phase === 'packages' && m.text) pj.statusText = shortPkgText(m.text);
      progress();
    } else if (m.type === 'ready') {
      py.version = String(m.version || PY_VERSION);
      try { Cade.store.set(PYSEEN_KEY, PY_VERSION); } catch (x) {}
      var init = py.onInit; py.onInit = null;
      if (init) init.resolve();
    } else if (m.type === 'preloaded') {
      py.preloading = false;
      var errs = Array.isArray(m.errors) ? m.errors : [];
      if (errs.length) toast("Couldn't load at start: " + K.pyPkgError(errs.join('\n'), isOffline(), ''), 'error', 6000);
      bump();
    } else if (m.type === 'pkgsDone' || m.type === 'varsDone') {
      var op = py.ops[m.id];
      if (op) { delete py.ops[m.id]; op(m); }
    } else if (m.type === 'initError') {
      crash(String(m.message || 'failed to start'));
    } else if (m.type === 'crash') {
      crash('the Python worker crashed (' + String(m.message || 'error') + ')');
    } else if ((p = py.pending[m.id])) {
      if (m.type === 'started') p.started();
      else if (m.type === 'out') p.out(m.chunks || [], +m.dropped || 0);
      else if (m.type === 'display') { if (p.display) p.display(m.item); }
      else if (m.type === 'done') { delete py.pending[m.id]; p.done(m); }
    }
  }
  function shortPkgText(t) {
    t = String(t);
    var m = /^Loading (.+)$/.exec(t);
    if (m) return 'Loading ' + (m[1].length > 40 ? m[1].slice(0, 40) + '…' : m[1]);
    if (/^Installing /.test(t)) return t.length > 50 ? t.slice(0, 50) + '…' : t;
    return 'Loading packages…';
  }

  // The worker source is fetched as text from our own folder (precached) and
  // only ever started inside the opaque-origin sandbox below.
  var srcP = null;
  function workerSource() {
    if (!srcP) {
      srcP = Promise.resolve().then(function () { return fetch(WORKER_URL); }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(null, function (e) { srcP = null; throw new Error("couldn't load the Python worker (" + msg(e) + ')'); });
    }
    return srcP;
  }
  // ---- Python cache ----
  // Pyodide's files and the PyPI packages micropip installs live in their own
  // Cache Storage bucket, keyed by the Pyodide version — NOT the service
  // worker's 'cade-v<N>' cache, which is replaced on every app update (that
  // used to throw the ~12 MB runtime and every package away each time). sw.js
  // leaves these hosts alone, so nothing is stored twice. Version-pinned files
  // (jsDelivr's /pyodide/v<ver>/, files.pythonhosted.org) never change:
  // cache-first. PyPI's index JSON does: network-first, with the cached copy as
  // the offline fallback. A new Pyodide version starts a new bucket; the old
  // 'cade-py-*' ones are deleted the first time this one is opened.
  var pyc = { p: null, runtime: null, putFailed: false, netFail: {} };
  function isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  // navigator.onLine stays true on a dead connection; a PyPI index request that
  // just failed at the network level (not a 404) means the same thing here.
  function offlineFor(text) {
    var m = /Can't fetch metadata for '([^']+)'/.exec(String(text || ''));
    return isOffline() || !!(m && pyc.netFail[K.pyCanon(m[1])]);
  }
  function pyCache() {
    if (!pyc.p) {
      pyc.p = Promise.resolve().then(function () {
        if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') throw new Error('Cache Storage unavailable');
        caches.keys().then(function (ks) {
          ks.forEach(function (k) { if (/^cade-py-/.test(k) && k !== PY_CACHE) caches.delete(k); });
        }).then(null, function () {});
        return caches.open(PY_CACHE);
      });
      pyc.p.then(null, function () {});
    }
    return pyc.p;
  }
  // Stored responses carry their own size (bodies are rebuilt from bytes, so a
  // scan never has to read them).
  function sizeOf(res) { return +(res.headers.get('x-cade-size') || res.headers.get('content-length') || 0); }
  function storePut(cache, url, buf, ct) {
    var h = { 'Content-Type': ct || 'application/octet-stream', 'Content-Length': String(buf.byteLength), 'X-Cade-Size': String(buf.byteLength), 'X-Cade-Saved': new Date().toISOString() };
    var res;
    try { res = new Response(buf, { status: 200, headers: h }); } catch (e) { return Promise.resolve(); }
    return cache.put(url, res).then(function () { pyc.putFailed = false; }, function () { pyc.putFailed = true; }); // quota: still served, just not kept
  }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function hexToSri(hex) {
    if (!/^[0-9a-f]{64}$/i.test(String(hex || ''))) return '';
    var b = new Uint8Array(32);
    for (var i = 0; i < 32; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    return 'sha256-' + b64(b);
  }
  // A cached package is checked against the hash Pyodide asked for (a damaged
  // entry is dropped and fetched again); the network fetch checks it itself.
  function verify(buf, integrity) {
    var m = /^sha256-([A-Za-z0-9+\/]+=*)$/.exec(String(integrity || '')), subtle = window.crypto && window.crypto.subtle;
    if (!m || !subtle) return Promise.resolve(true);
    return Promise.resolve().then(function () { return subtle.digest('SHA-256', buf); })
      .then(function (d) { return b64(new Uint8Array(d)) === m[1]; }, function () { return true; });
  }
  // The network side: GET, no credentials or referrer, a redirect must stay on
  // the allowlist, the body is read with a size cap (and counted for progress).
  function netGet(t, o) {
    var init = { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' };
    if (t.kind === 'index') {
      init.cache = 'no-cache';
      if (/^https:\/\/pypi\.org\/simple\//.test(t.url)) init.headers = { Accept: 'application/vnd.pypi.simple.v1+json' };
    }
    if (o.integrity) init.integrity = o.integrity;
    var ctl = o.timeout && typeof AbortController === 'function' ? new AbortController() : null, timer = 0;
    if (ctl) { init.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, o.timeout); }
    return fetch(t.url, init).then(function (res) {
      var fin = res.url ? K.pyUrlKind(res.url, PY_INDEX) : t;
      if (!fin || fin.kind !== t.kind) throw new Error('redirected off the allowed hosts');
      if (!res.ok) { var e = new Error('HTTP ' + res.status + ' for ' + t.url); e.status = res.status; throw e; }
      var cap = t.kind === 'index' ? MAX_INDEX : MAX_FILE;
      if (+res.headers.get('content-length') > cap) throw new Error('too large: ' + t.url);
      return readCapped(res, cap, o.onBytes).then(function (buf) { return { buf: buf, ct: res.headers.get('content-type') || '' }; });
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }
  function fresh(cache, t, o) {
    // stored before the bytes are handed on (they're transferred, i.e. detached)
    return netGet(t, o).then(function (r) { return storePut(cache, t.url, r.buf, r.ct).then(function () { return r; }); });
  }
  // One allowlisted URL ({kind, url} from K.pyUrlKind) through the bucket ->
  // {buf, ct, cached}. o: {integrity, onBytes}. No Cache Storage: plain network.
  function pyGet(t, o) {
    o = o || {};
    return pyCache().then(function (cache) {
      return cache.match(t.url).then(function (hit) {
        if (t.kind === 'index') {
          // network-first; a slow network gives up after a while when there's a copy
          return fresh(cache, t, { onBytes: o.onBytes, timeout: hit ? INDEX_WAIT : 0 }).then(null, function (e) {
            if (!hit || e.status === 404 || e.status === 410) throw e;
            return hit.arrayBuffer().then(function (buf) { return { buf: buf, ct: hit.headers.get('content-type') || '', cached: true }; });
          });
        }
        if (!hit) return fresh(cache, t, o);
        return hit.arrayBuffer().then(function (buf) {
          return verify(buf, o.integrity).then(function (good) {
            if (!good) return cache.delete(t.url).then(function () { return fresh(cache, t, o); });
            if (o.onBytes) o.onBytes(buf.byteLength);
            return { buf: buf, ct: hit.headers.get('content-type') || '', cached: true };
          });
        });
      });
    }, function () { return netGet(t, o); });
  }
  // Files fetched on the sandbox's behalf: ONLY the allowlist above (never the
  // app's own origin), through the Python bucket, counted for the progress readout.
  function proxyFetch(host, m) {
    var t = K.pyUrlKind(m.url, PY_INDEX);
    function reply(r, tr) {
      if (py.host !== host) return;
      r.__crpy = host.nonce; r.type = 'fetched'; r.rid = m.rid;
      try { host.ifr.contentWindow.postMessage(r, '*', tr || []); } catch (e) {}
    }
    if (!t) { reply({ ok: false, error: 'blocked: ' + String(m.url || '').slice(0, 80) }); return; }
    var integ = /^sha256-[A-Za-z0-9+\/]+=*$/.test(String(m.integrity || '')) ? String(m.integrity) : '';
    var dist = t.kind === 'index' ? K.pyDistOfUrl(t.url) : '';
    pyGet(t, { integrity: integ, onBytes: function (n) { countBytes(host, n); } }).then(function (r) {
      notePypiFile(t.url);
      if (dist) delete pyc.netFail[dist];
      reply({ ok: true, status: 200, ct: r.ct, buf: r.buf }, [r.buf]);
    }, function (e) {
      if (dist && !(e && e.status)) pyc.netFail[dist] = 1;
      reply({ ok: false, status: (e && e.status) || 0, error: msg(e) });
    });
  }
  function countBytes(host, n) {
    if (py.host !== host) return;
    if (py.state === 'loading') py.loaded += n; else py.pkgBytes += n;
    if (pk.busy) pk.busy.bytes += n;
    progress();
  }
  function readCapped(res, cap, onBytes) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then(function (b) {
        if (b.byteLength > cap) throw new Error('too large');
        if (onBytes) onBytes(b.byteLength);
        return b;
      });
    }
    var reader = res.body.getReader(), chunks = [], total = 0;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), o = 0;
          for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].byteLength; }
          return out.buffer;
        }
        total += r.value.byteLength;
        if (total > cap) { try { reader.cancel(); } catch (e) {} throw new Error('too large (over ' + Math.round(cap / 1048576) + ' MB)'); }
        chunks.push(r.value);
        if (onBytes) onBytes(r.value.byteLength);
        return step();
      });
    }
    return step();
  }
  // One Python session = one sandboxed iframe (sandbox="allow-scripts", no
  // allow-same-origin) that hosts the worker and relays its messages.
  function startHost(proxy) {
    return workerSource().then(function (src) {
      return new Promise(function (resolve, reject) {
        var nonce = 'py' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        var ifr = document.createElement('iframe');
        ifr.setAttribute('sandbox', 'allow-scripts'); // NOT allow-same-origin: opaque origin
        ifr.setAttribute('aria-hidden', 'true');
        ifr.setAttribute('tabindex', '-1');
        ifr.title = 'Python sandbox';
        ifr.className = 'cr-sandbox';
        var host = { ifr: ifr, nonce: nonce, mode: '', onMsg: null };
        host.post = function (m) { try { ifr.contentWindow.postMessage({ __crpy: nonce, type: 'cmd', m: m }, '*'); } catch (e) {} };
        host.onMsg = function (e) {
          if (py.host !== host || e.source !== ifr.contentWindow) return;
          var d = e.data;
          if (!d || d.__crpy !== nonce) return;
          if (d.type === 'host-ready') {
            try { ifr.contentWindow.postMessage({ __crpy: nonce, type: 'boot', src: src }, '*'); } catch (x) {}
          } else if (d.type === 'mode') {
            host.mode = String(d.mode || '');
            var pre = preloadSpec();
            py.preloading = !!(pre.lock.length || pre.pypi.length);
            host.post({ type: 'init', indexURL: PY_INDEX, proxy: proxy, preload: py.preloading ? pre : null });
          } else if (d.type === 'fetch') proxyFetch(host, d);
          else if (d.type === 'w') onPyMsg(d.m);
        };
        py.host = host;
        py.onInit = { resolve: resolve, reject: reject };
        window.addEventListener('message', host.onMsg);
        ifr.srcdoc = K.pyHostDoc(nonce);
        (document.body || document.documentElement).appendChild(ifr);
      });
    });
  }
  function pyPost(m) { if (py.host) py.host.post(m); }
  function failPending(why) {
    var p = py.pending, ops = py.ops; py.pending = {}; py.ops = {};
    py.preloading = false;
    Object.keys(p).forEach(function (k) { try { p[k].dead(why); } catch (e) {} });
    Object.keys(ops).forEach(function (k) { try { ops[k]({ ok: false, error: why }); } catch (e) {} });
  }
  // Removing the iframe ends the worker (or the page-hosted fallback) with it.
  function killHost() {
    var h = py.host;
    py.host = null;
    if (!h) return;
    // every namespace went with it: the notebook marks its Python blocks stale
    nbHook('pyDown');
    window.removeEventListener('message', h.onMsg);
    try { h.ifr.srcdoc = ''; } catch (e) {}
    try { h.ifr.remove(); } catch (e) {}
  }
  // The worker died or failed to start.
  function crash(why) {
    var init = py.onInit; py.onInit = null;
    killHost();
    if (py.state === 'ready') { py.state = 'off'; py.ready = null; }
    failPending(why);
    if (init) init.reject(new Error(why));
    bump();
  }
  // Stop / timeout: destroy the sandbox (the namespace goes with it).
  function pyKill() {
    var init = py.onInit; py.onInit = null;
    killHost();
    py.state = 'off'; py.ready = null;
    failPending('Python stopped');
    if (init) { var e = new Error('stopped'); e.stopped = true; init.reject(e); }
    bump();
  }
  function pyEnsure() {
    if (py.state === 'ready' && py.host) return Promise.resolve();
    if (py.ready) return py.ready;
    py.state = 'loading'; py.loaded = 0; py.pkgBytes = 0; py.error = '';
    hasRuntime().then(function (has) {
      if (!has && py.state === 'loading') toast('Downloading Python (~' + PY_DL_MB + ' MB, first run only)…', 'info', 4000);
      bump();
    });
    // First attempt: files through the app (Python cache + progress). If that
    // fails for any reason, retry once loading straight from jsDelivr.
    var p = py.ready = startHost(true).then(null, function (e) {
      if (e && e.stopped) throw e;
      py.loaded = 0;
      return startHost(false);
    }).then(function () {
      py.state = 'ready'; py.error = '';
      pyc.runtime = null; // look again (the proxy just stored it — or, without one, didn't)
      bump();
      var d = pkEl('.cr-pk');
      if (d && d.open && !pk.busy) { pk.scan = null; refreshPkgs(); }
    }, function (e) {
      if (py.ready === p) py.ready = null;
      if (!(e && e.stopped)) { py.state = 'error'; py.error = msg(e); }
      bump();
      throw e;
    });
    bump();
    return p;
  }
  // o (notebook runs): { timeout, rich, onOut(text), onDisplay(itemJSON), onStatus(state, text) }
  function runPy(job, o) {
    // "# requires: polars" can never work here — say why without starting Python
    var nw = '';
    K.pyRequires(job.code).some(function (r) { nw = K.pyNoWasm(K.pyReqName(r)); return !!nw; });
    if (nw) return Promise.resolve({ status: 'error', text: '✖ ' + nw, ms: 0 });
    job.state = py.state === 'ready' ? 'running' : 'loading';
    job.statusText = job.state === 'loading' ? pyStatusText() : 'Running…';
    function status() { bump(); if (o && o.onStatus) o.onStatus(job.state, job.statusText); }
    status();
    if (o) py.nbJob = job;
    return new Promise(function (resolve) {
      var finished = false, text = '', killT = 0, t0 = Date.now();
      var timeout = clamp(o && o.timeout ? o.timeout : prefs.pyTimeout, 1, 600) * 1000;
      function nl(t) { return t && !/\n$/.test(t) ? t + '\n' : t; }
      function end(res) {
        if (finished) return;
        finished = true;
        clearTimeout(killT);
        job.cancel = null;
        if (py.nbJob === job) py.nbJob = null;
        if (o) res.out = text;
        resolve(res);
      }
      job.cancel = function () {
        end({ status: 'stopped', text: nl(text) + '■ Stopped — Python restarted (variables were reset)', ms: Date.now() - t0 });
        pyKill();
      };
      pyEnsure().then(function () {
        if (finished) return;
        if (!py.host) { end({ status: 'error', text: nl(text) + '\u2716 Python stopped unexpectedly \u2014 run again', ms: 0 }); return; }
        var id = ++py.seq;
        job.state = 'running'; job.statusText = 'Running…'; status();
        py.pending[id] = {
          started: function () {
            t0 = Date.now();
            job.statusText = 'Running…'; status();
            killT = setTimeout(function () {
              end({ status: 'timeout', text: nl(text) + '⏱ Timed out after ' + K.fmtMs(timeout) + ' — Python restarted (variables were reset)', ms: timeout });
              pyKill();
            }, timeout);
          },
          out: function (chunks, dropped) {
            for (var i = 0; i < chunks.length; i++) if (text.length < MAX_TEXT) text += String(chunks[i][1]);
            if (dropped) text += '\n… ' + dropped + ' more characters of output dropped\n';
            job.liveText = text;
            if (o && o.onOut) o.onOut(text); else liveUpdate(job);
          },
          display: function (item) { if (o && o.onDisplay) o.onDisplay(item); },
          done: function (m) {
            var t = text, off = isOffline(), failed = !!(m.loadErrors && m.loadErrors.length);
            if (m.error && m.stage === 'packages') t = nl(t) + '✖ ' + K.pyPkgError(String(m.error).replace(/^Could not load packages:\s*/, ''), off || offlineFor(m.error), 'Could not load packages: ');
            else if (m.error) t = nl(t) + (m.python ? K.cleanTraceback(m.error, { loadFailed: !!(failed && /ModuleNotFoundError/.test(m.error)) }) : '✖ ' + m.error);
            else if (m.result != null) t = nl(t) + '→ ' + m.result;
            // a package that failed to download explains the ModuleNotFoundError that follows
            if (failed && m.error && /ModuleNotFoundError/.test(m.error)) {
              t += '\n(' + K.pyPkgError(m.loadErrors.join('\n'), off, 'a package failed to download: ') + ')';
            }
            var r = { status: m.error ? 'error' : 'ok', text: t, ms: +m.ms || 0 };
            if (o) {
              r.result = m.result != null ? String(m.result) : null;
              r.rich = m.rich || null;
              if (m.error) {
                var lines = [], re = /File "block\.py", line (\d+)/g, mm;
                while ((mm = re.exec(String(m.error)))) lines.push(+mm[1]);
                r.errText = t.slice(text.length).replace(/^\n/, '');
                r.errLine = lines.length ? lines[lines.length - 1] : 0;
              }
            }
            end(r);
          },
          dead: function (why) { end({ status: 'error', text: nl(text) + '✖ ' + why, ms: Date.now() - t0 }); }
        };
        py.pkgBytes = 0;
        pyPost({ type: 'run', id: id, code: job.code, ns: job.room, requires: K.pyRequires(job.code), auto: autoSpec(), rich: !!(o && o.rich) });
      }, function (err) {
        var off = typeof navigator !== 'undefined' && navigator.onLine === false;
        end({ status: 'error', text: "✖ Couldn't start Python: " + msg(err) + (off ? " — you're offline; the first run needs a connection (~" + PY_DL_MB + ' MB)' : ''), ms: 0 });
      });
    });
  }

  // ---- public actions ---------------------------------------------------------------------------
  function openPreview(b, doc) {
    var ed = Cade.editor, c = K.codeOf(doc, b);
    try { ed.dispatch({ selection: { anchor: c.from } }); } catch (e) {}
    var HP = window.__cadeHtmlPreview;
    if (HP && HP.openAt) HP.openAt(c.from);
    else if (!Cade.runCommand('Live Preview')) toast("Live Preview isn't available", 'error');
  }
  // No language after the ```: work it out now (this block only) from the
  // file name above it or the code itself; complain only if that fails.
  function detectFor(b, doc) {
    var g = K.guessLang(K.codeOf(doc, b).text, K.fileHint(doc, b));
    if (!g || !g.sure) {
      toast("Couldn't tell what language this block is — add one after the ``` (js, ts, python, json) to run it", 'info', 4600);
      return null;
    }
    var how = g.via === 'file' ? ' (from the file name)' : '';
    if (!g.lang || g.lang === 'output' || !(K.RUNNABLE[g.lang] || g.lang === 'html' || g.lang === 'css' || g.lang === 'shell')) {
      toast('Looks like ' + g.label + how + " — can't run " + g.label + ' here (runnable: js, ts, python, json; html opens the preview)', 'info', 5200);
      return null;
    }
    if (K.RUNNABLE[g.lang]) toast('No language on this block — running it as ' + g.label + how + '. "Identify Code Blocks" can tag blocks for you.', 'info', 4200);
    return g.lang;
  }
  function runBlock(b, doc) {
    var lang = b.lang;
    if (!lang && !String(b.info || '').trim()) {
      lang = detectFor(b, doc);
      if (!lang) return Promise.resolve('unsupported');
      b.lang = lang;
    }
    if (lang === 'html' || lang === 'css') { openPreview(b, doc); return Promise.resolve('preview'); }
    if (lang === 'shell') { toast(SHELL_MSG, 'info', 6000); return Promise.resolve('shell'); }
    if (!K.RUNNABLE[lang]) {
      var w = (b.info || '').split(/\s/)[0];
      toast(w ? "Can't run “" + w + '” blocks — runnable: js, ts, python, json (html opens the Live Preview)'
              : 'Add a language after the ``` (js, ts, python, json) to run this block', 'info', 4200);
      return Promise.resolve('unsupported');
    }
    if (b.close === -1) { toast('Close the code block with ``` first', 'info'); return Promise.resolve('unclosed'); }
    if (isQueued(b.openFrom)) { toast('Already running — use Stop to cancel', 'info'); return Promise.resolve('busy'); }
    if (nbLang(lang) && linkedOn()) {
      var from = b.openFrom;
      return loadNotebook().then(function (N) { return N.runCell(from, lang); }, function (e) {
        toast(msg(e) + ' — running this block on its own', 'error', 3600);
        return enqueue(b, doc).promise;
      });
    }
    return enqueue(b, doc).promise;
  }
  E.runBlockAt = function (pos) {
    var ed = Cade.editor;
    if (!ed) return Promise.resolve('no-editor');
    var doc = ed.state.doc;
    pos = Math.max(0, Math.min(+pos || 0, doc.length));
    var blocks = K.scanFences(doc), b = K.blockAt(blocks, doc.lineAt(pos).number);
    if (b && b.lang === 'output') {
      // inside an ```output block: run the code block it belongs to
      var prev = blocks[K.blockIndex(blocks, b) - 1], ex = prev && K.findOutputAfter(doc, prev);
      b = ex && ex.open === b.open ? prev : null;
    }
    if (!b) { toast('Put the cursor inside a ``` code block to run it', 'info', 2600); return Promise.resolve('none'); }
    return runBlock(b, doc);
  };
  E.runAtCursor = function () {
    var ed = Cade.editor;
    return ed ? E.runBlockAt(ed.state.selection.main.head) : Promise.resolve('no-editor');
  };
  // above: only blocks that end before this position ("Run Code Blocks Above")
  function runMany(above) {
    var ed = Cade.editor;
    if (!ed) return Promise.resolve();
    var doc = ed.state.doc, linked = linkedOn();
    var list = K.scanFences(doc).filter(function (b) {
      return K.RUNNABLE[b.lang] && b.close !== -1 && !isQueued(b.openFrom) && (above == null || doc.line(b.close).to < above);
    });
    var nbList = linked ? list.filter(function (b) { return nbLang(b.lang); }) : [];
    if (nbList.length) {
      list = list.filter(function (b) { return !nbLang(b.lang); });
      var nbP = loadNotebook().then(function (N) { return above == null ? N.runAll() : N.runAbove(above); }, function (e) { toast(msg(e), 'error', 3600); });
      return Promise.all([nbP, list.length ? queueMany(list, doc) : null]);
    }
    if (!list.length) { toast(above == null ? 'No runnable code blocks here (js, ts, python, json)' : 'No runnable code blocks above the cursor', 'info'); return Promise.resolve(); }
    return queueMany(list, doc);
  }
  E.runAll = function () { return runMany(null); };
  E.runAbove = function () {
    var ed = Cade.editor;
    if (!ed) return Promise.resolve();
    var doc = ed.state.doc, head = ed.state.selection.main.head, b = K.blockAt(K.scanFences(doc), doc.lineAt(head).number);
    return runMany(b ? doc.line(b.open).from : head);
  };
  // Restart: the note's linked runtimes (notebook), else Python's variables for this room.
  E.restart = function () {
    var N = nbLoaded();
    if (N && linkedOn()) return N.restart();
    E.pyReset();
  };
  function queueMany(list, doc) {
    var bt = { total: list.length, done: 0, errors: 0, stopped: false };
    var p = new Promise(function (res) { bt.resolve = res; });
    toast('Running ' + list.length + ' code block' + (list.length === 1 ? '' : 's') + '…', 'info', 1800);
    list.forEach(function (b) { enqueue(b, doc, bt); });
    return p;
  }
  // Stop one block (openFrom given) or everything.
  E.stop = function (openFrom) {
    var N = nbLoaded(), nbStopped = N ? N.stop(openFrom) : false;
    if (nbStopped && openFrom != null) { bump(); return; }
    if (openFrom != null) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].openFrom === openFrom) { var j = queue.splice(i, 1)[0]; drop(j, 'stopped'); bump(); return; }
      }
      if (cur && cur.openFrom === openFrom && cur.cancel) cur.cancel();
      return;
    }
    var q = queue; queue = [];
    q.forEach(function (j) { if (j.batch) j.batch.stopped = true; drop(j, 'stopped'); });
    if (cur) { if (cur.batch) cur.batch.stopped = true; if (cur.cancel) cur.cancel(); }
    else if (!q.length && !nbStopped) toast('Nothing is running', 'info', 1600);
    bump();
  };
  E.clearOutputs = function () {
    var ed = Cade.editor;
    if (!ed) return 0;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return 0; }
    var rem = K.outputRemovals(ed.state.doc);
    if (!rem.length) { toast('No ```output blocks to clear', 'info', 1800); return 0; }
    ed.dispatch({ changes: rem.map(function (r) { return { from: r.from, to: r.to, insert: '' }; }), userEvent: 'delete' });
    toast('Cleared ' + rem.length + ' output block' + (rem.length === 1 ? '' : 's'), 'success', 1800);
    return rem.length;
  };
  // "Identify Code Blocks": add the detected language after the ``` of every
  // block that has none (in the selection, or the whole note). Only sure
  // guesses are written; one transaction, so a single undo reverts it.
  E.identifyBlocks = function () {
    var ed = Cade.editor;
    if (!ed) return 0;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return 0; }
    var doc = ed.state.doc, sel = ed.state.selection.main;
    var a = sel.empty ? 1 : doc.lineAt(sel.from).number, z = sel.empty ? doc.lines : doc.lineAt(sel.to).number;
    var blocks = K.scanFences(doc).filter(function (b) {
      return !String(b.info || '').trim() && b.close !== -1 && b.close >= a && b.open <= z;
    });
    if (!blocks.length) { toast(sel.empty ? 'Every code block already has a language' : 'No untagged code blocks in the selection', 'info', 2400); return 0; }
    var changes = [], tally = {}, unsure = 0;
    blocks.forEach(function (b) {
      var g = K.guessLang(K.codeOf(doc, b).text, K.fileHint(doc, b));
      if (!g || !g.sure) { unsure++; return; }
      var line = doc.line(b.open), ticks = /^`+/.exec(line.text)[0].length;
      changes.push({ from: line.from + ticks, to: line.to, insert: g.tag });
      tally[g.label] = (tally[g.label] || 0) + 1;
    });
    if (!changes.length) {
      toast("Couldn't identify " + (blocks.length === 1 ? 'the untagged block' : 'any of the ' + blocks.length + ' untagged blocks') + ' confidently — left as is', 'info', 3600);
      return 0;
    }
    ed.dispatch({ changes: changes, userEvent: 'input' });
    var parts = Object.keys(tally).map(function (k) { return tally[k] + ' ' + k; });
    toast('Tagged ' + changes.length + ' code block' + (changes.length === 1 ? '' : 's') + ': ' + parts.join(', ') +
      (unsure ? ' · ' + unsure + ' left as is (not sure)' : ''), 'success', 4200);
    return changes.length;
  };
  // Remove the ```output block whose opening fence starts at pos.
  E.clearOutputAt = function (pos) {
    var ed = Cade.editor;
    if (!ed || ed.state.readOnly) return;
    var doc = ed.state.doc, b = K.blockAt(K.scanFences(doc), doc.lineAt(Math.min(pos, doc.length)).number);
    if (!b || b.lang !== 'output' || b.close === -1) return;
    var to = doc.line(b.close).to, from = b.open > 1 ? doc.line(b.open - 1).to : 0;
    ed.dispatch({ changes: { from: from, to: b.open > 1 ? to : Math.min(doc.length, to + 1), insert: '' }, userEvent: 'delete' });
  };
  E.pyLoad = function () { return pyEnsure().then(function () { toast('Python ' + py.version + ' ready', 'success', 1800); }, function (e) { toast("Couldn't start Python: " + msg(e), 'error', 4000); }); };
  E.pyReset = function () {
    if (!py.host || py.state !== 'ready') { toast('Python isn’t running — nothing to reset', 'info', 1800); return; }
    pyPost({ type: 'reset', ns: roomKey() });
    nbHook('pyReset', roomKey());
    toast('Python variables reset for this room', 'success', 1800);
  };

  E.pyUnload = function () {
    if (!py.host) { toast('Python isn\u2019t loaded', 'info', 1600); return; }
    if (cur && cur.lang === 'py' && cur.cancel) cur.cancel(); else pyKill();
    toast('Python unloaded', 'success', 1600);
  };

  // ---- the notebook's bridge ---------------------------------------------------------------------------
  // Python runs into the note's namespace (one per room, the same one Code
  // Runner uses), TS transform, Pyodide state; nbHook tells the notebook when
  // Python's namespaces went away.
  function nbHook(name, arg) {
    var N = nbLoaded();
    if (N && N._hooks && typeof N._hooks[name] === 'function') { try { N._hooks[name](arg); } catch (e) {} }
  }
  E._nb = {
    K: K,
    bump: bump,
    // -> { promise -> {status, out, result, rich, errText, errLine, ms, text}, cancel() }
    pyRun: function (code, ns, o) {
      var job = { lang: 'py', code: String(code), room: String(ns), state: 'queued', statusText: '', items: null, liveText: '', nb: o || {} };
      var p = runPy(job, o || {});
      return { promise: p, cancel: function () { if (job.cancel) job.cancel(); } };
    },
    pyReady: function () { return py.state === 'ready' && !!py.host; },
    pyLoading: function () { return py.state === 'loading'; },
    pyStatus: function () { return pyStatusText(); },
    pyReset: function (ns) { if (py.host && py.state === 'ready') pyPost({ type: 'reset', ns: String(ns) }); },
    // -> Promise<[[name, type, preview]] | null> (null: Python isn't running — never starts it)
    pyVars: function (ns) {
      if (!py.host || py.state !== 'ready') return Promise.resolve(null);
      return new Promise(function (resolve) {
        var id = 'v' + (++py.seq), t = setTimeout(function () { delete py.ops[id]; resolve(null); }, 8000);
        py.ops[id] = function (m) { clearTimeout(t); resolve(Array.isArray(m.list) ? m.list : null); };
        pyPost({ type: 'vars', id: id, ns: String(ns) });
      });
    },
    tsToJs: function (code) { return tsToJs(code); },
    jsTimeout: function () { return prefs.jsTimeout; },
    pyTimeout: function () { return prefs.pyTimeout; }
  };

  // ---- Python packages (Options -> "Python packages") ----------------------------------------------
  // A short list of packages to have offline. Pyodide's own builds (pandas,
  // numpy, matplotlib…) are fetched straight into the Python bucket from the
  // lock file's dependency closure; PyPI packages are installed once by
  // micropip in the Python session, whose requests (index JSON, metadata,
  // wheels) go through proxyFetch and so land in the bucket — that is exactly
  // what micropip asks for again offline. Which PyPI files belong to which
  // distribution is remembered (pk.files) so status, sizes and Remove work.
  var pk = { list: [], files: {}, lock: null, lockP: null, names: null, alias: {}, heads: {}, scan: null, scanP: null, busy: null, check: null, saveT: 0 };
  (function () {
    try {
      var d = JSON.parse(Cade.store.get(PKGS_KEY) || 'null') || {};
      if (Array.isArray(d.pkgs)) {
        pk.list = d.pkgs.filter(function (e) {
          return e && typeof e.name === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(e.name) && (e.src === 'pyodide' || e.src === 'pypi');
        }).slice(0, 60);
      }
      if (d.files && typeof d.files === 'object') pk.files = d.files;
    } catch (e) {}
  })();
  function savePkgs() {
    clearTimeout(pk.saveT); pk.saveT = 0;
    try { Cade.store.set(PKGS_KEY, JSON.stringify({ v: 1, pkgs: pk.list, files: pk.files })); } catch (e) {}
  }
  function findPkg(name) { for (var i = 0; i < pk.list.length; i++) if (pk.list[i].name === name) return pk.list[i]; return null; }
  function isIndexUrl(u) { return /^https:\/\/pypi\.org\/simple\//.test(u); }
  function isWheelUrl(u) { return /\.whl$/.test(u); }
  // proxyFetch saw a PyPI file: remember it under its distribution
  function notePypiFile(url) {
    var d = K.pyDistOfUrl(url);
    if (!d) return;
    var f = pk.files[d] || (pk.files[d] = []);
    if (f.indexOf(url) !== -1) return;
    f.push(url);
    if (f.length > 8) f.splice(0, f.length - 8);
    var ks = Object.keys(pk.files);
    if (ks.length > 80) delete pk.files[ks[0]];
    if (!pk.saveT) pk.saveT = setTimeout(savePkgs, 600);
  }
  // What "Load at start" sends to the worker (and the import that makes `import x` instant).
  function mainImport(e) {
    var imps = e.imports || [], want = e.name.replace(/-/g, '_');
    if (imps.indexOf(want) !== -1) return want;
    return imps.length === 1 ? imps[0] : '';
  }
  function preloadSpec(only) {
    var out = { lock: [], pypi: [], imports: [] };
    pk.list.forEach(function (e) {
      if (only ? e !== only : !e.start) return;
      (e.src === 'pyodide' ? out.lock : out.pypi).push(e.name);
      var imp = mainImport(e);
      if (imp) out.imports.push(imp);
    });
    return out;
  }
  // Listed PyPI packages install themselves (from the cache) when a block imports them.
  function autoSpec() {
    return pk.list.filter(function (e) { return e.src === 'pypi'; }).map(function (e) {
      return { name: e.name, imports: e.imports && e.imports.length ? e.imports : [e.name.replace(/-/g, '_')] };
    });
  }

  // Pyodide's lock file: every package it builds, with dependencies and hashes.
  function getLock() {
    if (pk.lock) return Promise.resolve(pk.lock);
    if (!pk.lockP) {
      pk.lockP = pyGet({ kind: 'py', url: PY_INDEX + 'pyodide-lock.json' }).then(function (r) {
        var lock = JSON.parse(new TextDecoder().decode(r.buf));
        if (!lock || !lock.packages) throw new Error('unexpected lock file');
        var names = [], alias = {};
        Object.keys(lock.packages).forEach(function (k) {
          var e = lock.packages[k];
          if (e.package_type === 'shared_library' || /-tests$/.test(k)) return;
          names.push(k);
          (e.imports || []).forEach(function (i) { var c = K.pyCanon(i); if (c !== k && !lock.packages[c]) alias[c] = k; });
        });
        pk.names = names.sort(); pk.alias = alias; pk.lock = lock;
        return lock;
      }).then(null, function (e) { pk.lockP = null; throw e; });
    }
    return pk.lockP;
  }
  function lockName(name) {
    var c = K.pyCanon(name);
    if (!pk.lock) return '';
    return pk.lock.packages[c] && pk.names.indexOf(c) !== -1 ? c : (pk.alias[c] || '');
  }
  function lockFile(n) { var e = pk.lock && pk.lock.packages[n]; return e ? { url: PY_INDEX + e.file_name, sri: hexToSri(e.sha256) } : null; }
  function runtimeUrls() { return PY_RUNTIME.map(function (f) { return PY_INDEX + f; }); }
  // Files one list entry needs offline: Pyodide builds (dependency closure;
  // micropip too for PyPI ones) + each PyPI distribution's index page and wheel.
  function needOf(e) {
    var lockNames = [], pypiNames = [], files = [];
    if (e.src === 'pyodide') lockNames.push(e.name);
    else {
      lockNames.push('micropip');
      [e.name].concat(e.deps || []).forEach(function (d) {
        if (pk.lock && pk.lock.packages[d]) lockNames.push(d); else if (pypiNames.indexOf(d) === -1) pypiNames.push(d);
      });
    }
    K.pyLockClosure(pk.lock, lockNames).forEach(function (n) { var f = lockFile(n); if (f) files.push(f); });
    return { files: files, pypi: pypiNames };
  }
  function pypiReady(d, sizes) {
    var f = pk.files[d] || [];
    return f.some(function (u) { return isIndexUrl(u) && u in sizes; }) && f.some(function (u) { return isWheelUrl(u) && u in sizes; });
  }
  // {state: 'offline'|'partial'|'none'|'?', stored, est, estUnknown, missing:[lock files]}
  function statusOf(e) {
    if (!pk.scan) return { state: '?', stored: 0, est: 0, estUnknown: true, missing: [] };
    if (!pk.lock) return { state: 'none', stored: 0, est: e.est || 0, estUnknown: !e.est, missing: [] }; // no lock file = nothing downloaded
    var need = needOf(e), sizes = pk.scan.sizes, stored = 0, est = 0, unknown = false, missing = [], seen = {};
    need.files.forEach(function (f) {
      if (f.url in sizes) stored += sizes[f.url];
      else { missing.push(f); var h = pk.heads[f.url]; if (h) est += h; else unknown = true; }
    });
    var pyOk = true;
    need.pypi.forEach(function (d) {
      (pk.files[d] || []).forEach(function (u) { if (u in sizes && !seen[u]) { seen[u] = 1; stored += sizes[u]; } });
      if (!pypiReady(d, sizes)) pyOk = false;
    });
    if (!pyOk) { if (e.est) est += e.est; else unknown = true; }
    var state = !missing.length && pyOk ? 'offline' : (stored ? 'partial' : 'none');
    return { state: state, stored: stored, est: est, estUnknown: unknown, missing: missing };
  }
  // Everything in the bucket with its size (from our own header; bodies aren't read).
  function scanBucket() {
    if (pk.scanP) return pk.scanP;
    pk.scanP = pyCache().then(function (cache) {
      return cache.keys().then(function (reqs) {
        var sizes = {}, total = 0;
        return Promise.all(reqs.map(function (rq) {
          return cache.match(rq).then(function (res) { var n = res ? sizeOf(res) : 0; sizes[rq.url] = n; total += n; });
        })).then(function () { return { sizes: sizes, total: total, count: reqs.length }; });
      });
    }).then(null, function () { return { sizes: {}, total: 0, count: 0, unavailable: true }; }).then(function (sc) {
      pk.scan = sc; pk.scanP = null;
      pyc.runtime = (PY_INDEX + 'pyodide.asm.wasm') in sc.sizes;
      return sc;
    });
    return pk.scanP;
  }
  function hasRuntime() {
    return pyCache().then(function (c) { return c.match(PY_INDEX + 'pyodide.asm.wasm'); })
      .then(function (r) { pyc.runtime = !!r; return pyc.runtime; }, function () { return pySeen(); });
  }
  // Download sizes before downloading: HEAD (Content-Length is what goes over
  // the wire — compressed when the CDN compresses). 0 = the server didn't say.
  function headSizes(urls) {
    var todo = urls.filter(function (u) { return !(u in pk.heads); }), i = 0;
    if (!todo.length || isOffline()) return Promise.resolve();
    todo.forEach(function (u) { pk.heads[u] = 0; });
    function next() {
      if (i >= todo.length) return Promise.resolve();
      var u = todo[i++];
      return fetch(u, { method: 'HEAD', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
        pk.heads[u] = r.ok ? (+r.headers.get('content-length') || 0) : 0;
      }, function () { delete pk.heads[u]; }).then(next);
    }
    return Promise.all([next(), next(), next(), next()]);
  }
  function refreshPkgs() {
    return Promise.all([getLock().then(null, function () { return null; }), scanBucket()]).then(function () {
      renderPk();
      if (!pk.lock) return;
      var urls = [];
      pk.list.forEach(function (e) { statusOf(e).missing.forEach(function (f) { urls.push(f.url); }); });
      return headSizes(urls).then(renderPk);
    });
  }

  // ---- adding: Pyodide build, or a PyPI package that can actually install here ----
  function pyEnv() {
    var v = String((pk.lock && pk.lock.info && pk.lock.info.python) || '3.13.2');
    return {
      python_version: v.split('.').slice(0, 2).join('.'), python_full_version: v, implementation_version: v,
      sys_platform: 'emscripten', platform_system: 'Emscripten', os_name: 'posix', platform_machine: 'wasm32',
      implementation_name: 'cpython', platform_python_implementation: 'CPython', platform_release: '', platform_version: ''
    };
  }
  function pypiJson(name, ver) {
    var u = 'https://pypi.org/pypi/' + encodeURIComponent(name) + (ver ? '/' + encodeURIComponent(ver) : '') + '/json';
    return fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('PyPI answered HTTP ' + r.status);
      return r.json();
    });
  }
  // Like micropip: the newest non-pre-release that has a wheel that runs here.
  function pickWheel(j) {
    var abi = String((pk.lock && pk.lock.info && pk.lock.info.abi_version) || '2025_0');
    var pyv = pyEnv().python_version.replace('.', '');
    function best(files) {
      var w = null;
      (files || []).forEach(function (f) {
        if (f.yanked) return;
        var k = K.pyWheelKind(f.filename, abi, pyv);
        if (k && (!w || (k === 'wasm' && w.kind !== 'wasm'))) w = { file: f, kind: k };
      });
      return w;
    }
    var w = best(j.urls);
    if (w) return { ver: j.info.version, file: w.file, kind: w.kind, latest: true };
    var rel = j.releases || {}, when = {};
    var vs = Object.keys(rel).filter(function (v) {
      if (!rel[v] || !rel[v].length || /\d(a|b|c|rc|alpha|beta|pre|preview)\d*|dev/i.test(v)) return false;
      when[v] = rel[v].reduce(function (m, f) { return f.upload_time_iso_8601 > m ? f.upload_time_iso_8601 : m; }, '');
      return true;
    }).sort(function (a, b) { return when[a] < when[b] ? 1 : when[a] > when[b] ? -1 : 0; });
    for (var i = 0; i < vs.length; i++) {
      w = best(rel[vs[i]]);
      if (w) return { ver: vs[i], file: w.file, kind: w.kind, latest: false };
    }
    var wheels = (j.urls || []).some(function (f) { return /\.whl$/.test(f.filename); });
    return { why: wheels ? 'compiled' : 'sdist' };
  }
  // Walk a PyPI package's dependencies (up to 25) and check each can install:
  // {ok, ver, kind, size, deps, older, latest} or {ok:false, why}.
  function resolvePypi(root) {
    var env = pyEnv(), seen = {}, queue = [root], n = 0;
    var out = { ok: true, ver: '', kind: '', size: 0, deps: [], older: false, latest: '' };
    function fail(why) { out.ok = false; out.why = why; return out; }
    function who(d) { return d === root ? root : root + ' needs ' + d + ', which'; }
    function next() {
      if (!queue.length) return Promise.resolve(out);
      var d = queue.shift();
      if (seen[d]) return next();
      seen[d] = 1;
      if (d !== root && pk.lock && pk.lock.packages[d]) { out.deps.push(d); return next(); }
      var nw = K.pyNoWasm(d);
      if (nw) return Promise.resolve(fail(d === root ? nw : root + ' needs ' + d + ' — ' + nw));
      if (++n > 25) return Promise.resolve(out);
      return pypiJson(d).then(function (j) {
        if (!j) return fail(d === root ? 'There’s no package called “' + root + '” on PyPI' : root + ' needs ' + d + ', which isn’t on PyPI');
        var w = pickWheel(j);
        if (!w.file) {
          return fail(w.why === 'sdist' ? who(d) + ' only publishes source code (no wheel), which can’t be built in the browser'
            : who(d) + ' has no WebAssembly build (PyPI only has compiled desktop wheels), so it can’t run in the browser');
        }
        if (d === root) { out.ver = w.ver; out.kind = w.kind; out.older = !w.latest; out.latest = j.info.version; } else out.deps.push(d);
        out.size += +w.file.size || 0;
        var reqP = w.latest ? Promise.resolve(j) : pypiJson(d, w.ver).then(null, function () { return j; });
        return reqP.then(function (jj) {
          K.pyDeps(((jj || j).info || {}).requires_dist, env).forEach(function (x) { if (!seen[x]) queue.push(x); });
          return next();
        });
      });
    }
    return next();
  }
  function setCheck(kind, text) { pk.check = text ? { kind: kind, text: text } : null; renderPkCheck(); }
  function listText(a, max) { return a.length > max ? a.slice(0, max).join(', ') + ' +' + (a.length - max) + ' more' : a.join(', '); }
  function addPkg(raw) {
    var name = K.pyReqName(raw);
    if (!name || name.length > 80) { setCheck('err', 'Type a package name — e.g. pandas or openpyxl'); return Promise.resolve(false); }
    if (pk.busy) { setCheck('info', 'Wait for the download to finish'); return Promise.resolve(false); }
    if (findPkg(name)) { setCheck('info', name + ' is already in the list'); return Promise.resolve(false); }
    setCheck('busy', 'Checking ' + name + '…');
    return getLock().then(function () {
      var ln = lockName(name);
      if (ln) {
        if (findPkg(ln)) { setCheck('info', ln + ' is already in the list'); return false; }
        var le = pk.lock.packages[ln], deps = K.pyLockClosure(pk.lock, [ln]).slice(1);
        pk.list.push({ name: ln, src: 'pyodide', start: false, ver: le.version || '', deps: deps, imports: (le.imports || []).slice(0, 12) });
        savePkgs();
        setCheck('ok', '✓ ' + ln + ' ' + (le.version || '') + ' — Pyodide build' + (ln !== name ? ' (it provides “' + name + '”)' : '') +
          (deps.length ? ', with ' + listText(deps, 6) : '') + '. Tap “Download for offline” to keep it on this device.');
        return true;
      }
      var nw = K.pyNoWasm(name);
      if (nw) { setCheck('err', '✖ ' + nw); return false; }
      return resolvePypi(name).then(function (r) {
        if (!r.ok) { setCheck('err', '✖ ' + r.why); return false; }
        if (findPkg(name)) return false;
        pk.list.push({ name: name, src: 'pypi', start: false, ver: r.ver, deps: r.deps, imports: [], est: r.size });
        savePkgs();
        setCheck('ok', '✓ ' + name + ' ' + r.ver + ' — ' + (r.kind === 'wasm' ? 'WebAssembly build' : 'pure-Python wheel') + ' from PyPI' +
          (r.older ? ' (the newest, ' + r.latest + ', has none — this is the latest that does)' : '') +
          (r.deps.length ? ', needs ' + listText(r.deps, 6) : '') + ' · ≈ ' + K.fmtBytes(r.size) + (r.deps.some(function (d) { return pk.lock.packages[d]; }) ? ' + Pyodide builds' : '') +
          '. Tap “Download for offline” to fetch it.');
        return true;
      }, function (e) {
        setCheck('err', '✖ Couldn’t check PyPI' + (isOffline() ? ' — you’re offline' : ' (' + msg(e) + ')'));
        return false;
      });
    }, function (e) {
      setCheck('err', '✖ Couldn’t load Pyodide’s package list' + (isOffline() ? ' — you’re offline (connect once to set packages up)' : ' (' + msg(e) + ')'));
      return false;
    }).then(function (added) {
      if (added) { clearPkInput(); refreshPkgs(); }
      return added;
    });
  }
  // Remove one entry and the cached files nothing else on the list (or Python itself) needs.
  function removePkg(name) {
    var e = findPkg(name);
    if (!e || pk.busy) return Promise.resolve();
    var mine = needOf(e), mineUrls = mine.files.map(function (f) { return f.url; });
    mine.pypi.forEach(function (d) { mineUrls = mineUrls.concat(pk.files[d] || []); });
    pk.list = pk.list.filter(function (x) { return x !== e; });
    var keep = {}, keepDist = {};
    runtimeUrls().forEach(function (u) { keep[u] = 1; });
    pk.list.forEach(function (x) {
      var nx = needOf(x);
      nx.files.forEach(function (f) { keep[f.url] = 1; });
      nx.pypi.forEach(function (d) { keepDist[d] = 1; (pk.files[d] || []).forEach(function (u) { keep[u] = 1; }); });
    });
    mine.pypi.forEach(function (d) { if (!keepDist[d]) delete pk.files[d]; });
    var drop = mineUrls.filter(function (u) { return !keep[u]; }), freed = 0;
    drop.forEach(function (u) { if (pk.scan && u in pk.scan.sizes) freed += pk.scan.sizes[u]; });
    savePkgs();
    if (pk.check && pk.check.text.indexOf(name) !== -1) setCheck('', '');
    renderPk();
    return pyCache().then(function (cache) {
      return Promise.all(drop.map(function (u) { return cache.delete(u); }));
    }).then(null, function () {}).then(function () {
      toast('Removed ' + name + (freed ? ' · freed ' + K.fmtBytes(freed) : ''), 'success', 2200);
      pk.scan = null;
      return refreshPkgs();
    });
  }
  function clearPyCache() {
    if (pk.busy) { toast('Wait for the download to finish', 'info'); return Promise.resolve(false); }
    var size = pk.scan ? pk.scan.total : 0;
    if (!window.confirm('Delete Python and every downloaded package from this device' + (size ? ' (' + K.fmtBytes(size) + ')' : '') +
      '?\nYour package list stays — tap “Download for offline” to fetch them again.')) return Promise.resolve(false);
    var p = (typeof caches !== 'undefined' && caches.delete) ? caches.delete(PY_CACHE) : Promise.resolve();
    return Promise.resolve(p).then(null, function () {}).then(function () {
      pyc.p = null; pyc.runtime = false; pk.files = {}; pk.scan = null;
      savePkgs();
      toast('Python cache cleared', 'success', 1800);
      return refreshPkgs();
    }).then(function () { bump(); return true; });
  }
  // One request to the Python worker that answers with {ok, info|error}.
  function pyOp(m) {
    return new Promise(function (resolve) {
      var id = ++py.seq;
      m.id = id;
      py.ops[id] = resolve;
      pyPost(m);
    });
  }
  // "Download for offline": the runtime + every listed package with its
  // dependencies, into the Python bucket, with progress.
  function pkgDownload() {
    if (pk.busy) return Promise.resolve();
    var errors = [];
    pk.busy = { text: 'Preparing…', done: 0, total: 0, bytes: 0 };
    pk.check = null; // an old "added …" / "no such package" note is stale now
    renderPk();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(null, function () {}); } catch (e) {}
    return getLock().then(function () { pk.scan = null; return scanBucket(); }).then(function (sc) {
      if (sc.unavailable) throw new Error('this browser won’t let the app store files (private browsing?)');
      var want = [], seen = {};
      function add(url, sri, label) { if (!seen[url] && !(url in sc.sizes)) { seen[url] = 1; want.push({ url: url, sri: sri || '', label: label }); } }
      runtimeUrls().forEach(function (u) { add(u, '', 'Python runtime'); });
      pk.list.forEach(function (e) { needOf(e).files.forEach(function (f) { add(f.url, f.sri, e.name); }); });
      var pypi = pk.list.filter(function (e) { return e.src === 'pypi' && statusOf(e).state !== 'offline'; });
      if (!want.length && !pypi.length) { pk.busy.nothing = true; return; }
      if (isOffline()) throw new Error('you’re offline — connect to download');
      pk.busy.total = want.length + pypi.length;
      var i = 0;
      function nextFile() {
        if (i >= want.length) return Promise.resolve();
        var w = want[i++];
        pk.busy.text = 'Downloading ' + w.label + '…';
        renderPkProg();
        return pyGet({ kind: 'py', url: w.url }, { integrity: w.sri, onBytes: function (n) { pk.busy.bytes += n; renderPkProg(); } })
          .then(function (r) {
            if (pyc.putFailed || !pk.scan) return;
            pk.scan.sizes[w.url] = r.buf.byteLength; pk.scan.total += r.buf.byteLength; pk.scan.count++;
            if (/pyodide\.asm\.wasm$/.test(w.url)) pyc.runtime = true;
          }, function (e) { errors.push(w.label + ': ' + msg(e)); })
          .then(function () { pk.busy.done++; renderPkProg(true); return nextFile(); });
      }
      return nextFile().then(function () {
        if (!pypi.length) return;
        pk.busy.text = 'Starting Python for the PyPI packages…';
        renderPkProg();
        return pyEnsure().then(function () {
          var j = 0;
          function nextPkg() {
            if (j >= pypi.length) return Promise.resolve();
            var e = pypi[j++];
            pk.busy.text = 'Installing ' + e.name + ' from PyPI…';
            renderPkProg();
            var sizes = (pk.scan && pk.scan.sizes) || {};
            var forget = needOf(e).pypi.filter(function (d) { return !pypiReady(d, sizes); });
            return pyOp({ type: 'pkgs', names: [e.name], forget: forget }).then(function (m) {
              pk.busy.done++;
              if (!m.ok) { e.err = K.pyPkgError(String(m.error || ''), offlineFor(m.error), ''); errors.push(e.name + ': ' + e.err); savePkgs(); return nextPkg(); }
              var inf = (m.info && m.info[e.name]) || {};
              if (inf.version) e.ver = inf.version;
              if (Array.isArray(inf.imports)) e.imports = inf.imports.slice(0, 12);
              if (Array.isArray(inf.deps)) e.deps = inf.deps.slice(0, 60);
              delete e.err;
              savePkgs();
              return nextPkg();
            });
          }
          return nextPkg();
        }, function (e) { errors.push('Python: ' + msg(e)); });
      });
    }).then(null, function (e) { errors.push(isOffline() ? 'you’re offline — connect to download' : msg(e)); }).then(function () {
      var nothing = pk.busy && pk.busy.nothing;
      pk.busy = null;
      pk.scan = null;
      return refreshPkgs().then(function () {
        bump();
        if (errors.length) toast('Download finished with ' + errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ': ' + errors[0], 'error', 6000);
        else toast(nothing ? 'Everything here is already on this device ✓' : 'Python' + (pk.list.length ? ' and your packages are' : ' is') + ' ready to use offline ✓', 'success', 3200);
      });
    });
  }
  // "At start" ticked while Python runs: load it now as well.
  function setStart(name, on) {
    var e = findPkg(name);
    if (!e) return;
    e.start = !!on;
    savePkgs();
    if (on && py.state === 'ready' && py.host) {
      py.preloading = true;
      pyPost({ type: 'preload', preload: preloadSpec(e) });
      toast('Loading ' + name + ' into Python now — and whenever Python starts', 'info', 2600);
      bump();
    }
  }
  E.pyPkgs = {
    add: addPkg, remove: removePkg, download: pkgDownload, clear: clearPyCache, refresh: refreshPkgs, setStart: setStart,
    list: function () { return pk.list; }, status: function (n) { var e = findPkg(n); return e ? statusOf(e) : null; },
    scan: function () { pk.scan = null; return scanBucket(); }, cacheName: PY_CACHE
  };

  // ---- panel --------------------------------------------------------------------------------------
  var ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
    all: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3v10l5.5-5zM8.5 3v10L14 8z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>',
    clear: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  var panel = null, liveT = 0;
  function btn(act, html, title, cls) { return '<button type="button" class="cr-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" title="' + esc(title) + '">' + html + '</button>'; }
  function panelHTML() {
    return '<div class="cr-bar">' +
        btn('run', ICON.play + '<span>Run block</span>', 'Run the code block at the cursor (Ctrl/⌘+Enter in a block)', 'primary') +
        btn('all', ICON.all + '<span>Run all</span>', 'Run every js / ts / python / json block in order') +
        btn('stop', ICON.stop + '<span>Stop</span>', 'Stop the running block and clear the queue') +
        btn('clear', ICON.clear + '<span>Clear</span>', 'Remove every ```output block from this room') +
      '</div>' +
      '<div class="cr-status" aria-live="polite"><span class="cr-dot"></span><span class="cr-status-text"></span></div>' +
      '<details class="cr-opts"><summary>Options</summary><div class="cr-opts-body">' +
        '<label class="cr-field"><span>Output</span><select data-pref="target"><option value="inline">Below the block (```output)</option><option value="panel">Only in this panel</option></select></label>' +
        '<label class="cr-field"><span>JavaScript timeout</span><span class="cr-num"><input type="number" inputmode="numeric" min="1" max="120" step="1" data-pref="jsTimeout"> s</span></label>' +
        '<label class="cr-field"><span>Python timeout</span><span class="cr-num"><input type="number" inputmode="numeric" min="1" max="600" step="1" data-pref="pyTimeout"> s</span></label>' +
        '<div class="cr-pyrow"><span class="cr-py-state"></span><button type="button" class="cr-btn" data-act="pyload">Load Python</button><button type="button" class="cr-btn" data-act="pyreset">Reset variables</button><button type="button" class="cr-btn" data-act="pyunload" title="Stop the Python worker and free its memory">Unload</button></div>' +
        pkSectionHTML() +
        '<p class="cr-hint">JavaScript runs in a sandboxed frame with no access to your notes. Python ' + PY_VERSION + ' (Pyodide) runs in a separate sandboxed worker, also without access to your notes; variables persist per room. ' +
        'Pyodide’s packages (pandas, numpy, matplotlib…) load when you import them; add <code># requires: name</code> for pure-Python packages from PyPI, or list them under Python packages to keep them offline. Shell blocks can’t run in a browser.</p>' +
      '</div></details>' +
      '<div class="cr-runs"><div class="cr-empty">Put the cursor in a ```js, ```ts, ```python or ```json block and press <b>Run block</b>. Output appears in an ```output block underneath (re-running replaces it).</div></div>';
  }
  // ---- "Python packages" section of the panel's options ----
  function pkSectionHTML() {
    return '<details class="cr-pk"><summary><span>Python packages</span><span class="cr-pk-sum"></span></summary>' +
      '<div class="cr-pk-body">' +
        '<div class="cr-pk-add">' +
          '<input type="text" class="cr-pk-in" data-pk-in placeholder="Add a package — pandas, openpyxl…" aria-label="Package name" ' +
            'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="80">' +
          '<button type="button" class="cr-btn" data-act="pkadd">Add</button>' +
        '</div>' +
        '<div class="cr-pk-sugg" role="listbox" aria-label="Matching packages" hidden></div>' +
        '<div class="cr-pk-check" aria-live="polite" hidden></div>' +
        '<div class="cr-pk-list"></div>' +
        '<div class="cr-pk-foot"></div>' +
      '</div></details>';
  }
  function pkEl(sel) { return panel ? panel.querySelector(sel) : null; }
  function renderPkSummary() {
    var el = pkEl('.cr-pk-sum');
    if (!el) return;
    var n = pk.list.length, parts = [];
    if (n) parts.push(n + (n === 1 ? ' package' : ' packages'));
    if (pk.scan && pk.scan.total) parts.push(K.fmtBytes(pk.scan.total) + ' on device');
    el.textContent = parts.length ? ' · ' + parts.join(' · ') : '';
  }
  function itemHTML(e) {
    var st = statusOf(e), bits = [], stTxt;
    if (e.err && st.state !== 'offline') stTxt = '<span class="cr-pk-bad">✖ ' + esc(e.err.length > 140 ? e.err.slice(0, 140) + '…' : e.err) + '</span>';
    else if (st.state === 'offline') stTxt = '<span class="cr-pk-ok">✓ offline</span>';
    else if (st.state === 'partial') stTxt = '<span class="cr-pk-part">partly downloaded</span>';
    else if (st.state === 'none') stTxt = '<span class="cr-pk-no">not downloaded</span>';
    else stTxt = '<span class="cr-pk-no">…</span>';
    bits.push(stTxt);
    if (e.ver) bits.push(esc(e.ver));
    var nd = (e.deps || []).length;
    if (nd) bits.push('<span title="' + esc((e.deps || []).join(', ')) + '">+' + nd + ' dep' + (nd === 1 ? '' : 's') + '</span>');
    if (st.state === 'offline') bits.push(K.fmtBytes(st.stored) + (nd ? ' with deps' : ''));
    else if (st.state !== '?') {
      if (st.est && !st.estUnknown) bits.push('≈ ' + K.fmtBytes(st.est) + ' to download');
      else if (st.est) bits.push('≥ ' + K.fmtBytes(st.est) + ' to download');
      else bits.push(isOffline() ? 'size unknown (offline)' : 'size known once downloaded');
    }
    var src = e.src === 'pyodide' ? '<span class="cr-pk-src" title="Built for the browser by Pyodide">Pyodide</span>'
      : '<span class="cr-pk-src pypi" title="Pure-Python package from PyPI, installed by micropip">PyPI</span>';
    // each bit stays on one line; wrapping happens between them
    return '<div class="cr-pk-item" data-pk="' + esc(e.name) + '">' +
      '<div class="cr-pk-name"><b>' + esc(e.name) + '</b>' + src + '</div>' +
      '<label class="cr-pk-start" title="Load (and import) it as soon as Python starts, so `import ' + esc(mainImport(e) || e.name) + '` is instant">' +
        '<input type="checkbox" data-pk-start' + (e.start ? ' checked' : '') + '><span>At start</span></label>' +
      '<button type="button" class="cr-pk-x" data-act="pkrm" title="Remove ' + esc(e.name) + ' (and its downloaded files)" aria-label="Remove ' + esc(e.name) + '">×</button>' +
      '<div class="cr-pk-meta"><span>' + bits.join('</span> · <span>') + '</span></div>' +
    '</div>';
  }
  function renderPkList() {
    var el = pkEl('.cr-pk-list');
    if (!el) return;
    if (!pk.list.length) {
      el.innerHTML = '<div class="cr-pk-empty">Nothing here yet. Packages on this list can be downloaded for offline use, sizes included. Good places to start:' +
        '<div class="cr-pk-chips">' + SUGGESTED.map(function (n) { return '<button type="button" data-act="pkpick" data-name="' + n + '">+ ' + n + '</button>'; }).join('') + '</div></div>';
      return;
    }
    el.innerHTML = pk.list.map(itemHTML).join('');
  }
  function renderPkCheck() {
    var el = pkEl('.cr-pk-check');
    if (!el) return;
    el.hidden = !pk.check;
    el.className = 'cr-pk-check' + (pk.check ? ' ' + pk.check.kind : '');
    el.textContent = pk.check ? pk.check.text : '';
  }
  function progHTML() {
    var b = pk.busy, pct = b.total ? Math.round(b.done / b.total * 100) : 0;
    return '<div class="cr-pk-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + Math.max(3, pct) + '%"></i></div>' +
      '<div class="cr-pk-ptext">' + esc(b.text) + (b.total ? ' · ' + b.done + ' of ' + b.total : '') + (b.bytes ? ' · ' + K.fmtBytes(b.bytes) : '') + '</div>';
  }
  var pkProgT = 0;
  function renderPkProg(fileDone) {
    if (fileDone) pk.progFiles = true;
    if (pkProgT) return;
    pkProgT = setTimeout(function () {
      pkProgT = 0;
      var el = pkEl('.cr-pk-prog');
      if (!el || !pk.busy) { renderPkFoot(); return; }
      el.innerHTML = progHTML();
      if (pk.progFiles) {
        pk.progFiles = false;
        renderPkSummary(); renderPkList();
        var rt = pkEl('.cr-pk-rt'), tot = pkEl('.cr-pk-total');
        if (rt) rt.innerHTML = rtHTML();
        if (tot) tot.innerHTML = totalHTML();
      }
    }, 120);
  }
  function rtHTML() {
    var sc = pk.scan, rt;
    if (!sc) rt = '<span class="cr-pk-no">…</span>';
    else if (sc.unavailable) rt = '<span class="cr-pk-bad">this browser won’t let the app store files (private browsing?) — Python needs a connection</span>';
    else if (pyc.runtime) {
      var rs = 0; runtimeUrls().forEach(function (u) { rs += sc.sizes[u] || 0; });
      rt = runtimeUrls().every(function (u) { return u in sc.sizes; }) ? '<span class="cr-pk-ok">✓ offline</span> · ' + K.fmtBytes(rs) : '<span class="cr-pk-part">partly downloaded</span>';
    } else rt = '<span class="cr-pk-no">not downloaded</span> · ≈ ' + PY_DL_MB + ' MB to download';
    return '<b>Python ' + PY_VERSION + '</b> runtime · ' + rt;
  }
  function totalHTML() {
    var sc = pk.scan;
    return (sc && !sc.unavailable ? 'Python cache on this device: <b>' + K.fmtBytes(sc.total) + '</b>' : '') +
      (pyc.putFailed ? ' · <span class="cr-pk-bad">some files couldn’t be saved (storage full?)</span>' : '');
  }
  function renderPkFoot() {
    var el = pkEl('.cr-pk-foot');
    if (!el) return;
    var sc = pk.scan;
    el.innerHTML = '<div class="cr-pk-rt">' + rtHTML() + '</div>' +
      (pk.busy ? '<div class="cr-pk-prog">' + progHTML() + '</div>' : '') +
      '<div class="cr-pk-acts">' +
        '<button type="button" class="cr-btn primary" data-act="pkdl"' + (pk.busy ? ' disabled' : '') + '>' + (pk.busy ? 'Downloading…' : 'Download for offline') + '</button>' +
        '<button type="button" class="cr-btn" data-act="pkclear"' + (pk.busy || !sc || !sc.count ? ' disabled' : '') + '>Clear Python cache</button>' +
      '</div>' +
      '<div class="cr-pk-total">' + totalHTML() + '</div>';
  }
  function renderPk() {
    if (!panel) return;
    renderPkSummary();
    var d = pkEl('.cr-pk');
    if (!d || !d.open) return;
    renderPkList(); renderPkCheck(); renderPkFoot();
  }
  function clearPkInput() {
    var i = pkEl('[data-pk-in]');
    if (i) i.value = '';
    renderPkSugg('');
  }
  // Autocomplete over Pyodide's own builds (plus import names like sklearn,
  // PIL, cv2); anything else is offered as a PyPI lookup.
  function renderPkSugg(q) {
    var el = pkEl('.cr-pk-sugg');
    if (!el) return;
    var c = K.pyCanon(q);
    if (!c || !pk.names || !/^[a-z0-9][a-z0-9.-]*$/.test(c)) { el.hidden = true; el.innerHTML = ''; return; }
    var pre = [], mid = [], seen = {};
    function push(arr, n, via) { if (!seen[n] && !findPkg(n)) { seen[n] = 1; arr.push({ n: n, via: via }); } }
    pk.names.forEach(function (n) { if (n.indexOf(c) === 0) push(pre, n); });
    Object.keys(pk.alias).forEach(function (a) { if (a.indexOf(c) === 0) push(pre, pk.alias[a], a); });
    pk.names.forEach(function (n) { if (n.indexOf(c) > 0) push(mid, n); });
    pre.sort(function (a, b) { return a.n.length - b.n.length || (a.n < b.n ? -1 : 1); });
    var items = pre.concat(mid).slice(0, 6);
    var exact = pk.lock && (pk.lock.packages[c] || pk.alias[c]);
    var html = items.map(function (it) {
      var le = pk.lock.packages[it.n] || {};
      return '<button type="button" role="option" data-act="pkpick" data-name="' + esc(it.n) + '"><b>' + esc(it.n) + '</b><span>' +
        (it.via ? 'import ' + esc(it.via) + ' · ' : '') + 'Pyodide ' + esc(le.version || '') + '</span></button>';
    });
    if (!exact && !findPkg(c)) html.push('<button type="button" role="option" data-act="pkpick" data-name="' + esc(c) + '"><b>' + esc(c) + '</b><span>look up on PyPI</span></button>');
    el.innerHTML = html.join('');
    el.hidden = !html.length;
  }
  function onPkToggle(e) {
    var d = e.target;
    if (!d.open) return;
    renderPk();
    refreshPkgs();
  }
  function openPanel(quiet) {
    if (panel && panel.isConnected) return panel;
    if (!quiet) Cade.closeAllMenus();
    panel = Cade.mkPanel(PANEL_ID, 'Code Runner', panelHTML());
    panel.classList.add('cr-panel');
    var body = panel.querySelector('.cade-panel-body');
    body.querySelector('[data-pref="target"]').value = prefs.target;
    body.querySelector('[data-pref="jsTimeout"]').value = prefs.jsTimeout;
    body.querySelector('[data-pref="pyTimeout"]').value = prefs.pyTimeout;
    body.addEventListener('click', onPanelClick);
    body.addEventListener('change', onPanelChange);
    body.querySelector('.cr-pk').addEventListener('toggle', onPkToggle);
    body.addEventListener('input', function (e) { if (e.target && e.target.hasAttribute('data-pk-in')) renderPkSugg(e.target.value); });
    body.addEventListener('keydown', function (e) {
      if (!e.target || !e.target.hasAttribute('data-pk-in')) return;
      if (e.key === 'Enter') { e.preventDefault(); renderPkSugg(''); addPkg(e.target.value); }
      else if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); clearPkInput(); }
    });
    panel._onClose = function () { panel = null; clearTimeout(liveT); liveT = 0; };
    renderRuns();
    renderStatus();
    renderPkSummary();
    return panel;
  }
  E.openPanel = function () { return openPanel(false); };
  E.togglePanel = function () {
    if (panel && panel.isConnected) { panel.remove(); if (panel && panel._onClose) panel._onClose(); return; }
    openPanel(false);
  };
  function onPanelChange(e) {
    var el = e.target, k = el && el.getAttribute('data-pref');
    if (el && el.hasAttribute && el.hasAttribute('data-pk-start')) {
      var it = el.closest('.cr-pk-item');
      if (it) setStart(it.getAttribute('data-pk'), el.checked);
      return;
    }
    if (!k) return;
    if (k === 'target') prefs.target = el.value === 'panel' ? 'panel' : 'inline';
    else if (k === 'jsTimeout') { prefs.jsTimeout = clamp(el.value, 1, 120); el.value = prefs.jsTimeout; }
    else if (k === 'pyTimeout') { prefs.pyTimeout = clamp(el.value, 1, 600); el.value = prefs.pyTimeout; }
    savePrefs();
  }
  function runById(id) { for (var i = 0; i < runs.length; i++) if (runs[i].job.id === id) return runs[i]; return null; }
  function onPanelClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'run') E.runAtCursor();
    else if (act === 'all') E.runAll();
    else if (act === 'stop') E.stop();
    else if (act === 'clear') E.clearOutputs();
    else if (act === 'pyload') E.pyLoad();
    else if (act === 'pyreset') E.pyReset();
    else if (act === 'pyunload') E.pyUnload();
    else if (act === 'pkadd') { var inp = pkEl('[data-pk-in]'); renderPkSugg(''); addPkg(inp ? inp.value : ''); }
    else if (act === 'pkpick') { renderPkSugg(''); addPkg(t.getAttribute('data-name') || ''); }
    else if (act === 'pkrm') { var row = t.closest('.cr-pk-item'); if (row) removePkg(row.getAttribute('data-pk')); }
    else if (act === 'pkdl') pkgDownload();
    else if (act === 'pkclear') clearPyCache();
    else {
      var item = t.closest('.cr-run'), r = item && runById(+item.getAttribute('data-id'));
      if (!r) return;
      if (act === 'copy') copyText(r.text);
      else if (act === 'insert') {
        var lb = (r.job.state !== 'done' && liveBlock(r.job)) || findByCode(r.job.lang, r.job.code, r.job.line);
        if (!lb) toast("Can't find that code block any more", 'info');
        else if (writeInline(r.job, r.text, r.header, lb)) toast('Output inserted below the block', 'success', 1500);
      } else if (act === 'goto') {
        var g = findByCode(r.job.lang, r.job.code, r.job.line), ed = Cade.editor;
        if (!g || !ed) { toast("Can't find that code block any more", 'info'); return; }
        var pos = g.doc.line(g.block.open).from;
        try { ed.dispatch({ selection: { anchor: pos }, effects: Cade.CM.EditorView.scrollIntoView(pos, { y: 'center' }) }); ed.focus(); } catch (x) {}
      }
    }
  }
  function copyText(s) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        toast('Copied', 'success', 1200);
      } catch (e) { toast('Copy failed', 'error'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(function () { toast('Copied', 'success', 1200); }, fallback);
    else fallback();
  }
  function addRun(job) {
    runs.unshift({ job: job, text: '', header: '', status: 'running', when: hm() });
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
    renderRuns();
  }
  function finishRun(job, status, text, header) {
    var r = runById(job.id);
    if (!r) return;
    r.status = status; r.text = text; r.header = header;
    renderRuns();
  }
  function currentText(job) { return job.lang === 'py' ? (job.liveText || '') : itemsText(job.items || []); }
  function liveUpdate(job) {
    if (!panel || liveT) return;
    liveT = setTimeout(function () {
      liveT = 0;
      if (!panel) return;
      var el = panel.querySelector('.cr-run[data-id="' + job.id + '"] .cr-out');
      if (el && job.state !== 'done') { var t = currentText(job); el.textContent = t.length > 60000 ? t.slice(-60000) : t; }
    }, 150);
  }
  var LANG_LABEL = { js: 'JS', ts: 'TS', py: 'PY', json: 'JSON' };
  function renderRuns() {
    if (!panel) return;
    var box = panel.querySelector('.cr-runs');
    if (!runs.length) return;
    box.innerHTML = runs.map(function (r) {
      var j = r.job, st = r.status;
      var meta = st === 'running' ? 'running…' : (r.header.replace(/^(#|\/\/)\s*/, ''));
      return '<div class="cr-run cr-' + st + '" data-id="' + j.id + '">' +
        '<div class="cr-run-head"><span class="cr-lang">' + (LANG_LABEL[j.lang] || esc(j.lang)) + '</span>' +
        '<span class="cr-run-title" title="' + esc(j.title || '') + '">line ' + j.line + (j.title ? ' · ' + esc(j.title) : '') + '</span>' +
        '<span class="cr-run-meta">' + esc(meta) + '</span></div>' +
        '<pre class="cr-out"></pre>' +
        (st === 'running' ? '' : '<div class="cr-run-acts"><button type="button" data-act="copy">Copy</button><button type="button" data-act="insert">Insert below block</button><button type="button" data-act="goto">Go to block</button></div>') +
      '</div>';
    }).join('');
    var pres = box.querySelectorAll('.cr-out');
    for (var i = 0; i < pres.length; i++) {
      var r = runs[i], t = r.status === 'running' ? currentText(r.job) : r.text;
      pres[i].textContent = t.length > 60000 ? t.slice(0, 60000) + '\n…' : (t || (r.status === 'running' ? '' : '(no output)'));
    }
  }
  function renderStatus() {
    if (!panel) return;
    var txt = panel.querySelector('.cr-status-text'), dot = panel.querySelector('.cr-dot');
    var s = 'Idle', busy = false;
    if (cur) {
      busy = true;
      s = (LANG_LABEL[cur.lang] || cur.lang) + ' · line ' + cur.line + ' · ' + (cur.statusText || 'Running…');
      if (queue.length) s += ' (+' + queue.length + ' queued)';
    }
    txt.textContent = s;
    dot.className = 'cr-dot' + (busy ? ' busy' : '');
    var ps = panel.querySelector('.cr-py-state');
    if (ps) ps.textContent = pyStatusText() + (py.state === 'error' && py.error ? ': ' + py.error : '');
    var stop = panel.querySelector('[data-act="stop"]');
    if (stop) stop.disabled = !busy;
  }
})();
