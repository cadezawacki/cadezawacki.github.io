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
 *   it runs in that frame's page instead). Pyodide's files are fetched by the
 *   app on the sandbox's behalf, only from the pinned jsDelivr prefix, so the
 *   service worker caches them and the first download shows progress. One
 *   namespace per room; stop / timeout destroy the iframe.
 * - JSON: validated (line/column errors) and pretty-printed.
 * - Shell: explained, not run. HTML/CSS open the Live HTML Preview.
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
  var PY_VERSION = '0.29.5';
  var PY_INDEX = 'https://cdn.jsdelivr.net/pyodide/v' + PY_VERSION + '/full/';
  var PY_DL_MB = '5.3';            // compressed download: wasm + stdlib + loader
  var PY_EST_BYTES = 12300000;     // the same, decompressed (what the app counts while proxying)
  var SUCRASE_URL = 'https://cdn.jsdelivr.net/npm/sucrase@3.35.0/+esm';
  var PREFS_KEY = 'cade-coderun-prefs';
  var PYSEEN_KEY = 'cade-coderun-pyseen';
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
  var py = { host: null, state: 'off', ready: null, onInit: null, loaded: 0, pkgBytes: 0, version: '', pending: {}, seq: 0, error: '' };
  var E = window.__cadeCodeRun = { version: 0 };

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
      if (b.lang !== lang || b.close === -1 || K.codeOf(doc, b).text !== code) return;
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
    var j = isQueued(openFrom);
    if (!j) return null;
    return { state: j === cur ? j.state : 'queued', text: j === cur ? (j.statusText || 'Running…') : 'Queued' };
  };
  E.busy = function () { return !!cur || queue.length > 0; };

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
  function pySeen() { try { return Cade.store.get(PYSEEN_KEY) === PY_VERSION; } catch (e) { return false; } }
  function pyStatusText() {
    if (py.state === 'ready') return 'Python ' + py.version + ' ready' + (py.host && py.host.mode === 'page' ? ' (no worker: runs on the page)' : '');
    if (py.state === 'loading') {
      var pct = Math.min(99, Math.round(py.loaded / PY_EST_BYTES * 100));
      return (pySeen() ? 'Starting Python' : 'Downloading Python') + (py.loaded ? ' ' + pct + '%' : '…');
    }
    if (py.state === 'error') return 'Python failed to load';
    return pySeen() ? 'Python not started' : 'Python not loaded (~' + PY_DL_MB + ' MB, first run only)';
  }
  var progT = 0;
  function progress() {
    if (cur && cur.lang === 'py') {
      if (cur.state === 'loading') cur.statusText = pyStatusText();
      else if (py.pkgBytes) cur.statusText = 'Loading packages… ' + (Math.round(py.pkgBytes / 1e5) / 10) + ' MB';
    }
    if (!progT) progT = setTimeout(function () { progT = 0; bump(); }, 250);
  }
  function onPyMsg(m) {
    var p;
    m = m || {};
    if (m.type === 'progress') {
      if (py.state === 'ready' && cur && cur.lang === 'py' && m.phase === 'packages' && m.text) cur.statusText = shortPkgText(m.text);
      progress();
    } else if (m.type === 'ready') {
      py.version = String(m.version || PY_VERSION);
      try { Cade.store.set(PYSEEN_KEY, PY_VERSION); } catch (x) {}
      var init = py.onInit; py.onInit = null;
      if (init) init.resolve();
    } else if (m.type === 'initError') {
      crash(String(m.message || 'failed to start'));
    } else if (m.type === 'crash') {
      crash('the Python worker crashed (' + String(m.message || 'error') + ')');
    } else if ((p = py.pending[m.id])) {
      if (m.type === 'started') p.started();
      else if (m.type === 'out') p.out(m.chunks || [], +m.dropped || 0);
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
      srcP = fetch(WORKER_URL).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(null, function (e) { srcP = null; throw new Error("couldn't load the Python worker (" + msg(e) + ')'); });
    }
    return srcP;
  }
  // Pyodide's files, fetched on the sandbox's behalf: ONLY under the pinned
  // jsDelivr prefix (never the app's own origin), through the service worker
  // (so they're cached for offline use), counted for the progress readout.
  function proxyFetch(host, m) {
    var url = '', allowed = false;
    try { url = new URL(String(m.url || '')).href; allowed = url.indexOf(PY_INDEX) === 0 && url.indexOf('/../') === -1; } catch (e) {}
    function reply(r, tr) {
      if (py.host !== host) return;
      r.__crpy = host.nonce; r.type = 'fetched'; r.rid = m.rid;
      try { host.ifr.contentWindow.postMessage(r, '*', tr || []); } catch (e) {}
    }
    if (!allowed) { reply({ ok: false, error: 'blocked: ' + String(m.url || '').slice(0, 80) }); return; }
    var opts = { credentials: 'omit' };
    if (m.integrity) opts.integrity = String(m.integrity);
    fetch(url, opts).then(function (res) {
      if (!res.ok) { reply({ ok: false, status: res.status, error: 'HTTP ' + res.status + ' for ' + url }); return; }
      var ct = res.headers.get('content-type') || '';
      return readCounting(res, host).then(function (buf) { reply({ ok: true, status: res.status, ct: ct, buf: buf }, [buf]); });
    }).then(null, function (e) { reply({ ok: false, error: msg(e) }); });
  }
  function countBytes(host, n) {
    if (py.host !== host) return;
    if (py.state === 'loading') py.loaded += n; else py.pkgBytes += n;
    progress();
  }
  function readCounting(res, host) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then(function (b) { countBytes(host, b.byteLength); return b; });
    }
    var reader = res.body.getReader(), chunks = [], total = 0;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), o = 0;
          for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].byteLength; }
          return out.buffer;
        }
        chunks.push(r.value); total += r.value.byteLength;
        countBytes(host, r.value.byteLength);
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
            host.post({ type: 'init', indexURL: PY_INDEX, proxy: proxy });
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
    var p = py.pending; py.pending = {};
    Object.keys(p).forEach(function (k) { try { p[k].dead(why); } catch (e) {} });
  }
  // Removing the iframe ends the worker (or the page-hosted fallback) with it.
  function killHost() {
    var h = py.host;
    py.host = null;
    if (!h) return;
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
    if (!pySeen()) toast('Downloading Python (~' + PY_DL_MB + ' MB, first run only)…', 'info', 4000);
    // First attempt: files through the app (service-worker cache + progress).
    // If that fails for any reason, retry once loading straight from jsDelivr.
    var p = py.ready = startHost(true).then(null, function (e) {
      if (e && e.stopped) throw e;
      py.loaded = 0;
      return startHost(false);
    }).then(function () {
      py.state = 'ready'; py.error = '';
      bump();
    }, function (e) {
      if (py.ready === p) py.ready = null;
      if (!(e && e.stopped)) { py.state = 'error'; py.error = msg(e); }
      bump();
      throw e;
    });
    bump();
    return p;
  }
  function runPy(job) {
    job.state = py.state === 'ready' ? 'running' : 'loading';
    job.statusText = job.state === 'loading' ? pyStatusText() : 'Running…';
    bump();
    return new Promise(function (resolve) {
      var finished = false, text = '', killT = 0, t0 = Date.now();
      var timeout = clamp(prefs.pyTimeout, 1, 600) * 1000;
      function nl(t) { return t && !/\n$/.test(t) ? t + '\n' : t; }
      function end(res) {
        if (finished) return;
        finished = true;
        clearTimeout(killT);
        job.cancel = null;
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
        job.state = 'running'; job.statusText = 'Running…'; bump();
        py.pending[id] = {
          started: function () {
            t0 = Date.now();
            job.statusText = 'Running…'; bump();
            killT = setTimeout(function () {
              end({ status: 'timeout', text: nl(text) + '⏱ Timed out after ' + K.fmtMs(timeout) + ' — Python restarted (variables were reset)', ms: timeout });
              pyKill();
            }, timeout);
          },
          out: function (chunks, dropped) {
            for (var i = 0; i < chunks.length; i++) if (text.length < MAX_TEXT) text += String(chunks[i][1]);
            if (dropped) text += '\n… ' + dropped + ' more characters of output dropped\n';
            job.liveText = text;
            liveUpdate(job);
          },
          done: function (m) {
            var t = text;
            if (m.error) t = nl(t) + (m.python ? K.cleanTraceback(m.error) : '✖ ' + m.error);
            else if (m.result != null) t = nl(t) + '→ ' + m.result;
            end({ status: m.error ? 'error' : 'ok', text: t, ms: +m.ms || 0 });
          },
          dead: function (why) { end({ status: 'error', text: nl(text) + '✖ ' + why, ms: Date.now() - t0 }); }
        };
        py.pkgBytes = 0;
        pyPost({ type: 'run', id: id, code: job.code, ns: job.room, requires: K.pyRequires(job.code) });
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
    else if (!Cade.runCommand('Live HTML Preview')) toast("Live HTML Preview isn't available", 'error');
  }
  function runBlock(b, doc) {
    var lang = b.lang;
    if (lang === 'html' || lang === 'css') { openPreview(b, doc); return Promise.resolve('preview'); }
    if (lang === 'shell') { toast(SHELL_MSG, 'info', 6000); return Promise.resolve('shell'); }
    if (!K.RUNNABLE[lang]) {
      var w = (b.info || '').split(/\s/)[0];
      toast(w ? "Can't run “" + w + '” blocks — runnable: js, ts, python, json (html opens the Live HTML Preview)'
              : 'Add a language after the ``` (js, ts, python, json) to run this block', 'info', 4200);
      return Promise.resolve('unsupported');
    }
    if (b.close === -1) { toast('Close the code block with ``` first', 'info'); return Promise.resolve('unclosed'); }
    if (isQueued(b.openFrom)) { toast('Already running — use Stop to cancel', 'info'); return Promise.resolve('busy'); }
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
  E.runAll = function () {
    var ed = Cade.editor;
    if (!ed) return Promise.resolve();
    var doc = ed.state.doc;
    var list = K.scanFences(doc).filter(function (b) { return K.RUNNABLE[b.lang] && b.close !== -1 && !isQueued(b.openFrom); });
    if (!list.length) { toast('No runnable code blocks here (js, ts, python, json)', 'info'); return Promise.resolve(); }
    var bt = { total: list.length, done: 0, errors: 0, stopped: false };
    var p = new Promise(function (res) { bt.resolve = res; });
    toast('Running ' + list.length + ' code block' + (list.length === 1 ? '' : 's') + '…', 'info', 1800);
    list.forEach(function (b) { enqueue(b, doc, bt); });
    return p;
  };
  // Stop one block (openFrom given) or everything.
  E.stop = function (openFrom) {
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
    else if (!q.length) toast('Nothing is running', 'info', 1600);
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
    toast('Python variables reset for this room', 'success', 1800);
  };

  E.pyUnload = function () {
    if (!py.host) { toast('Python isn\u2019t loaded', 'info', 1600); return; }
    if (cur && cur.lang === 'py' && cur.cancel) cur.cancel(); else pyKill();
    toast('Python unloaded', 'success', 1600);
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
        '<p class="cr-hint">JavaScript runs in a sandboxed frame with no access to your notes. Python ' + PY_VERSION + ' (Pyodide) runs in a separate sandboxed worker, also without access to your notes; variables persist per room. ' +
        'Packages you import load automatically; add <code># requires: name</code> for other pure-Python packages from PyPI. Shell blocks can’t run in a browser.</p>' +
      '</div></details>' +
      '<div class="cr-runs"><div class="cr-empty">Put the cursor in a ```js, ```ts, ```python or ```json block and press <b>Run block</b>. Output appears in an ```output block underneath (re-running replaces it).</div></div>';
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
    panel._onClose = function () { panel = null; clearTimeout(liveT); liveT = 0; };
    renderRuns();
    renderStatus();
    return panel;
  }
  E.openPanel = function () { return openPanel(false); };
  E.togglePanel = function () {
    if (panel && panel.isConnected) { panel.remove(); if (panel && panel._onClose) panel._onClose(); return; }
    openPanel(false);
  };
  function onPanelChange(e) {
    var el = e.target, k = el && el.getAttribute('data-pref');
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
