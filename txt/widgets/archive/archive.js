/* Archive Utility - open, browse, extract and create archives entirely on this
 * device: ZIP (AES-256 / ZipCrypto), 7z (AES-256, encrypted names, volumes),
 * TAR, TAR.GZ, GZIP; extract-only RAR, XZ, BZIP2, ZSTD, LZMA, CAB, ISO ...
 *
 * PRIVACY: files are read and written locally. Nothing is uploaded, synced,
 * or stored in rooms / Cade.store; passwords live in memory only (optionally
 * for the browser session) and are never persisted.
 *
 * ENGINES run in archive-worker.js (a dedicated worker) and are fetched only
 * when needed, pinned, then kept in our own Cache Storage bucket for offline:
 * zip.js (BSD-3) for ZIP; 7-Zip compiled to WebAssembly (7z-wasm, LGPL +
 * unRAR restriction) for 7z and the read-only formats; TAR / GZIP are ours
 * (native CompressionStream).
 *
 * OUTPUT: on desktop Chromium the result streams straight into a file /
 * folder the user picks. Everywhere else (iPhone) the worker writes it to the
 * Origin Private File System and hands back a disk-backed File for Download
 * or the Share sheet ("Save to Files"). Temp files are removed when the panel
 * closes (after a short grace for downloads in flight) and on the next open.
 */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('archive.css');
  // Resolved now, while the loader's module context is ours. The ?v= tag
  // changes with the worker protocol so a cached old worker never pairs with
  // a newer panel.
  var WORKER_URL = Cade.asset('archive-worker.js') + '?v=1';
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'archive-panel';
  var PREFS_KEY = 'cade-archive-prefs';
  var CACHE = 'cade-archive-v1';          // must match archive-worker.js
  var TMP = 'cade-archive-tmp';           // must match archive-worker.js
  var ENGINES = {
    zip: { url: 'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.18.2/dist/zip.min.js', size: 169377 },
    sz: {
      js: 'https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.umd.js', jsSize: 83122,
      wasm: 'https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.wasm', wasmSize: 1651931,
    },
  };
  var TEXT_MAX = 2 * 1048576;   // preview / insert limit for text
  var IMG_MAX = 20 * 1048576;   // preview limit for images
  var KIDS_PAGE = 400;          // rows per folder before "show more"
  var FILTER_MAX = 500;         // search results shown
  var RES_MAX = 200;            // result rows shown

  var S = null;                 // panel state (null while closed)
  var W = { w: null, ready: null, seq: 0, pending: {}, caps: null, sess: null };
  var PW_SESSION = [];          // "remember for this session" - memory only
  var cleanupTimer = null;

  // ---- prefs (small, no passwords) -------------------------------------------
  var prefs = { fmt: 'zip', zipLevel: 6, szLevel: 5, method: 'aes', encNames: true, vol: '', ask: true, tab: 'extract' };
  function loadPrefs() {
    try {
      var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null') || {};
      for (var k in prefs) if (p[k] !== undefined && typeof p[k] === typeof prefs[k]) prefs[k] = p[k];
    } catch (e) {}
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ---- small helpers ------------------------------------------------------------
  function toast(m, t, ms) { Cade.showToast(m, t || 'info', ms || 2200); }
  function panel() { return document.getElementById(PANEL_ID); }
  function $(sel) { var p = panel(); return p ? p.querySelector(sel) : null; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtBytes(n) {
    if (n == null || n < 0 || !isFinite(n)) return '\u2014';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < 3);
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtDate(t) {
    if (!t) return '';
    var d = new Date(t);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDur(s) {
    if (!isFinite(s) || s < 0) return '';
    s = Math.round(s);
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function baseName(p) { p = String(p).replace(/\/+$/, ''); var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function ext(p) { var m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ''; }
  var TEXT_EXT = /^(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|bat|ps1|ini|cfg|conf|toml|ya?ml|log|sql|tex|rtf|srt|vtt|svg|gitignore|env|lua|swift|r|pl|vue|svelte|diff|patch|nfo|properties)$/;
  var IMG_EXT = /^(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/;
  var IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
  function icon(e, dir) {
    if (dir) return '\ud83d\udcc1';
    var x = ext(e);
    if (IMG_EXT.test(x)) return '\ud83d\uddbc\ufe0f';
    if (/^(zip|7z|rar|gz|tgz|tar|xz|bz2|zst|cab|iso)$/.test(x)) return '\ud83d\udddc\ufe0f';
    if (/^(mp3|m4a|wav|flac|ogg|aac|opus)$/.test(x)) return '\ud83c\udfb5';
    if (/^(mp4|mov|webm|mkv|avi|m4v)$/.test(x)) return '\ud83c\udf9e\ufe0f';
    if (x === 'pdf') return '\ud83d\udcd5';
    if (TEXT_EXT.test(x)) return '\ud83d\udcdd';
    return '\ud83d\udcc4';
  }
  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
    var fail = function () { toast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode \u2014 editing is locked', 'error'); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    toast('Inserted ' + fmtBytes(new Blob([text]).size) + ' of text', 'success', 1400);
  }
  function canPickFile() { return typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false; }
  function canPickDir() { return typeof window.showDirectoryPicker === 'function' && window.isSecureContext !== false; }
  function isAbort(e) { return e && (e.name === 'AbortError' || e.code === 'cancel'); }
  function newErr(code, msg) { var e = new Error(msg); e.code = code; return e; }

  // ---- worker RPC ------------------------------------------------------------------
  function worker() {
    if (W.ready) return W.ready;
    var w;
    try { w = new window.Worker(WORKER_URL); } catch (e) { return Promise.reject(newErr('worker', 'This browser can\u2019t start the archive engine.')); }
    W.w = w; W.sess = null;
    w.onmessage = function (e) {
      if (w !== W.w) return;
      var m = e.data || {}, p = W.pending[m.id];
      if (m.type === 'warn') { toast(m.message, 'info', 4000); return; }
      if (!p) return;
      if (m.type === 'done') { delete W.pending[m.id]; p.resolve(m); }
      else if (m.type === 'error') {
        delete W.pending[m.id];
        var err = newErr(m.code || 'engine', m.message || 'Failed');
        err.path = m.path; err.wrong = m.wrong;
        p.reject(err);
      } else if (p.on) p.on(m);
    };
    w.onerror = function (e) {
      if (w !== W.w) return;
      try { e.preventDefault(); } catch (x) {}
      killWorker(newErr('worker', (e && e.message) || 'The archive engine crashed'));
    };
    W.ready = rpc('init', { engines: ENGINES }).then(function (m) { W.caps = m; return m; });
    return W.ready;
  }
  function rpc(op, payload, on) {
    var id = ++W.seq, w = W.w;
    return new Promise(function (resolve, reject) {
      W.pending[id] = { resolve: resolve, reject: reject, on: on };
      try { w.postMessage(Object.assign({ id: id, op: op }, payload || {})); }
      catch (e) { delete W.pending[id]; reject(e); }
    });
  }
  function call(op, payload, on) { return worker().then(function () { return rpc(op, payload, on); }); }
  function killWorker(err) {
    if (W.w) { try { W.w.terminate(); } catch (e) {} }
    W.w = null; W.ready = null; W.sess = null;
    var p = W.pending; W.pending = {};
    for (var k in p) p[k].reject(err || newErr('cancel', 'Cancelled'));
  }
  // The worker holds the open archive; after a cancel (worker terminated) it
  // is reopened silently - from the decompressed inner tar when there is one.
  function ensureOpen() {
    var a = S && S.arc;
    if (!a || !a.ready) return Promise.reject(newErr('state', 'No archive is open'));
    if (W.w && W.sess === a) return Promise.resolve();
    var files = a.innerTar ? [a.innerTar] : a.files;
    return call('open', { files: files, password: a.openPw || '' }).then(function () { W.sess = a; });
  }

  // ---- OPFS temp cleanup (main thread) ----------------------------------------------
  function cleanupTemps() {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return Promise.resolve();
      return navigator.storage.getDirectory().then(function (root) {
        return root.removeEntry(TMP, { recursive: true });
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  // ---- engines in Cache Storage ---------------------------------------------------
  function engineBytes() {
    if (!window.caches) return Promise.resolve(0);
    return window.caches.has(CACHE).then(function (has) {
      if (!has) return 0;
      return window.caches.open(CACHE).then(function (c) {
        return c.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) {
            return c.match(k).then(function (r) { return r ? r.blob().then(function (b) { return b.size; }) : 0; });
          }));
        });
      }).then(function (sizes) { return sizes.reduce(function (a, b) { return a + b; }, 0); });
    }).catch(function () { return 0; });
  }
  function renderEngines() {
    var el = $('.ar-eng');
    if (!el) return;
    engineBytes().then(function (n) {
      if (!S || !el.isConnected) return;
      S.engBytes = n;
      el.innerHTML = n
        ? 'Engines saved for offline use (' + fmtBytes(n) + ') \u00b7 <button class="ar-link" data-act="rm-eng">Remove downloaded engines (' + fmtBytes(n) + ')</button>'
        : 'Engines download once on first use (ZIP ' + fmtBytes(ENGINES.zip.size) + ', 7-Zip ' + fmtBytes(ENGINES.sz.jsSize + ENGINES.sz.wasmSize) + '), then work offline.';
    });
  }

  // ---- password dialog --------------------------------------------------------------
  function askPassword(opts) {
    return new Promise(function (resolve) {
      var m = $('.ar-modal');
      if (!m) { resolve(null); return; }
      m.innerHTML =
        '<div class="ar-dlg" role="dialog" aria-modal="true" aria-label="Password">' +
          '<div class="ar-dlg-t">\ud83d\udd12 Password required</div>' +
          '<div class="ar-dlg-m">' + esc(opts.msg) + '</div>' +
          (opts.wrong ? '<div class="ar-dlg-err">Wrong password \u2014 try again.</div>' : '') +
          '<div class="ar-pwrow"><input class="ar-in ar-dlg-pw" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Password">' +
          '<button class="ar-btn ar-eye" data-dlg="eye" type="button" aria-label="Show password">Show</button></div>' +
          '<label class="ar-chk"><input type="checkbox" class="ar-dlg-rem"' + (S && S.remember ? ' checked' : '') + '> Remember for this session (never saved)</label>' +
          '<div class="ar-dlg-a"><button class="ar-btn" data-dlg="cancel" type="button">Cancel</button><button class="ar-btn primary" data-dlg="ok" type="button">Unlock</button></div>' +
        '</div>';
      m.hidden = false;
      var inp = m.querySelector('.ar-dlg-pw');
      function finish(v) {
        m.hidden = true; m.innerHTML = ''; m.onclick = null;
        resolve(v);
      }
      m.onclick = function (e) {
        var b = e.target.closest && e.target.closest('[data-dlg]');
        if (!b) return;
        var a = b.getAttribute('data-dlg');
        if (a === 'eye') { var show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; inp.focus(); }
        else if (a === 'cancel') finish(null);
        else if (a === 'ok') ok();
      };
      function ok() {
        var v = inp.value;
        if (!v) { inp.focus(); return; }
        var rem = m.querySelector('.ar-dlg-rem').checked;
        if (S) S.remember = rem;
        if (rem) { PW_SESSION = PW_SESSION.filter(function (x) { return x !== v; }); PW_SESSION.push(v); if (PW_SESSION.length > 12) PW_SESSION.shift(); }
        finish(v);
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      });
      setTimeout(function () { inp.focus(); }, 30);
    });
  }
  // Candidates: remembered session passwords, then this archive's (newest last).
  function passwords() {
    var a = S && S.arc, out = [];
    PW_SESSION.concat(a ? a.pws : []).forEach(function (p) { var i = out.indexOf(p); if (i >= 0) out.splice(i, 1); out.push(p); });
    return out;
  }
  // Run fn(passwords) and, while it fails for want of a password, ask.
  function withPasswords(fn) {
    return fn(passwords()).catch(function (e) {
      if (!e || e.code !== 'password' || !S || !S.arc) throw e;
      var who = e.path ? '\u201c' + baseName(e.path) + '\u201d is encrypted.' : '\u201c' + S.arc.name + '\u201d is encrypted.';
      return askPassword({ msg: who, wrong: e.wrong }).then(function (pw) {
        if (pw == null) throw newErr('cancel', 'Cancelled');
        S.arc.pws = S.arc.pws.filter(function (x) { return x !== pw; }).concat([pw]);
        return withPasswords(fn);
      });
    });
  }

  // ---- jobs (progress, ETA, cancel) ---------------------------------------------------
  function runJob(label, op, payload, opts) {
    opts = opts || {};
    if (S.job) return Promise.reject(newErr('busy', 'Another task is running'));
    var job = { label: label, t0: Date.now(), done: 0, total: 0, speed: 0, lastT: 0, lastD: 0, text: '', eng: null };
    S.job = job;
    renderJob(); renderBusy();
    var before = S.cleanP || Promise.resolve();
    var p = before.then(function () {
      if (job.cancelled) throw newErr('cancel', 'Cancelled');
      return (opts.needsArchive ? ensureOpen() : Promise.resolve());
    }).then(function () {
      if (job.cancelled) throw newErr('cancel', 'Cancelled');
      return call(op, payload, function (m) { onJobMsg(job, m); });
    });
    return p.then(function (r) { endJob(job); return r; }, function (e) { endJob(job); throw e; });
  }
  function onJobMsg(job, m) {
    if (m.type === 'progress') {
      var now = Date.now();
      if (job.lastT && now > job.lastT) {
        var inst = (m.done - job.lastD) / ((now - job.lastT) / 1000);
        if (inst >= 0) job.speed = job.speed ? job.speed * 0.8 + inst * 0.2 : inst;
      }
      job.lastT = now; job.lastD = m.done;
      job.done = m.done; job.total = m.total; job.text = m.label || '';
      job.eng = null;
    } else if (m.type === 'engine') {
      job.eng = m;
    } else if (m.type === 'stage') {
      job.text = m.text; job.eng = null;
    }
    renderJob();
  }
  function endJob(job) {
    if (S && S.job === job) { S.job = null; renderJob(); renderBusy(); }
  }
  function cancelJob() {
    if (!S || !S.job) return;
    S.job.cancelled = true;
    killWorker(newErr('cancel', 'Cancelled'));
    // Partial output is discarded; results already handed out are kept.
    S.cleanP = cleanupTempsExcept();
    toast('Cancelled', 'info', 1400);
  }
  // After a cancel: delete temp files that no result / open archive uses.
  function cleanupTempsExcept() {
    var keep = {};
    if (S.arc && S.arc.innerTarTmp) keep[S.arc.innerTarTmp] = 1;
    if (S.results && S.results.tmp) keep[S.results.tmp] = 1;
    try {
      return navigator.storage.getDirectory().then(function (root) {
        return root.getDirectoryHandle(TMP).then(function (d) {
          var names = [];
          var it = d.keys ? d.keys() : null;
          if (!it) return;
          function next() {
            return it.next().then(function (r) {
              if (r.done) return;
              if (!keep[r.value]) names.push(r.value);
              return next();
            });
          }
          return next().then(function () {
            return Promise.all(names.map(function (n) { return d.removeEntry(n).catch(function () {}); }));
          });
        });
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }
  function renderJob() {
    if (!S) return;
    var el = $('.ar-job');
    if (!el) return;
    var j = S.job;
    if (!j) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    var pct = 0, title = j.label, sub = '';
    if (j.eng) {
      pct = j.eng.total ? j.eng.loaded / j.eng.total : 0;
      title = 'Downloading the ' + j.eng.name + ' engine (one time)\u2026';
      sub = fmtBytes(j.eng.loaded) + ' of ' + fmtBytes(j.eng.total);
    } else if (j.total > 0) {
      pct = Math.min(1, j.done / j.total);
      sub = fmtBytes(j.done) + ' of ' + fmtBytes(j.total);
      var el2 = (Date.now() - j.t0) / 1000;
      if (j.speed > 0 && el2 > 1.5) {
        sub += ' \u00b7 ' + fmtBytes(j.speed) + '/s';
        var left = (j.total - j.done) / j.speed;
        if (left > 1 && pct < 0.995) sub += ' \u00b7 about ' + fmtDur(left) + ' left';
      }
    }
    var bar = el.querySelector('.ar-bar > span');
    if (!bar) {
      el.innerHTML = '<div class="ar-job-row"><div class="ar-job-t"></div><button class="ar-btn" data-act="cancel" type="button">Cancel</button></div>' +
        '<div class="ar-bar' + '"><span></span></div><div class="ar-job-s"></div><div class="ar-job-f"></div>';
      bar = el.querySelector('.ar-bar > span');
    }
    el.querySelector('.ar-job-t').textContent = title;
    el.querySelector('.ar-bar').classList.toggle('ind', !j.eng && !(j.total > 0));
    bar.style.width = (pct * 100).toFixed(1) + '%';
    el.querySelector('.ar-job-s').textContent = sub;
    el.querySelector('.ar-job-f').textContent = j.eng ? '' : (j.text || '');
  }
  function renderBusy() {
    if (!S) return;
    var p = panel();
    if (!p) return;
    var busy = !!S.job;
    p.classList.toggle('ar-busy', busy);
    var bs = p.querySelectorAll('[data-idle]');
    for (var i = 0; i < bs.length; i++) bs[i].disabled = busy;
  }
  function jobError(e, what) {
    if (isAbort(e) || (e && e.code === 'cancel')) return;
    var msg = (e && e.message) || 'Something went wrong';
    toast((what ? what + ': ' : '') + msg, 'error', 4500);
  }

  // ---- results (download / share / bundle) --------------------------------------------
  function trackUrl(u) { S.urls.push(u); }
  function download(file) {
    var url = URL.createObjectURL(file);
    trackUrl(url);
    var a = document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: files })); } catch (e) { return false; }
  }
  // Must run inside the click (iOS requires the user gesture for share()).
  function share(files) {
    if (!canShareFiles(files)) { toast('This browser can\u2019t share files \u2014 use Download', 'info', 2600); return; }
    navigator.share({ files: files, title: files.length === 1 ? files[0].name : plural(files.length, 'file') }).catch(function (e) {
      if (!isAbort(e)) toast('Couldn\u2019t share: ' + (e && e.message || e), 'error', 3000);
    });
  }
  function showResults(r, title) {
    if (!S) return;
    var files = (r.files || []).filter(function (x) { return x.f; });
    var dirs = (r.files || []).filter(function (x) { return x.d; });
    S.results = { title: title, files: files, dirs: dirs, tmp: r.tmp || '', warn: r.warn || '' };
    renderResults();
  }
  function renderResults() {
    if (!S) return;
    var el = $('.ar-res');
    if (!el) return;
    var R = S.results;
    if (!R) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    if (R.report) {
      el.innerHTML = '<div class="ar-res-h"><span class="ar-res-t ' + (R.ok ? 'ok' : 'bad') + '">' + esc(R.title) + '</span>' +
        '<button class="ar-x" data-act="res-close" type="button" aria-label="Dismiss">\u00d7</button></div>' +
        (R.lines.length ? '<div class="ar-res-list">' + R.lines.map(function (l) {
          return '<div class="ar-res-err"><b>' + esc(l.p || 'Archive') + '</b> \u2014 ' + esc(l.m) + '</div>';
        }).join('') + '</div>' : '');
      return;
    }
    var files = R.files, total = 0;
    files.forEach(function (x) { total += x.f.size; });
    var many = files.length > 1;
    var head = '<div class="ar-res-h"><span class="ar-res-t ok">\u2713 ' + esc(R.title) + '</span><span class="ar-res-m">' +
      (many ? plural(files.length, 'file') + ' \u00b7 ' : '') + fmtBytes(total) + '</span>' +
      '<button class="ar-x" data-act="res-close" type="button" aria-label="Dismiss">\u00d7</button></div>';
    var acts = '';
    if (many) {
      acts = '<div class="ar-res-acts">' +
        '<button class="ar-btn primary" data-act="res-zip" data-idle type="button">\u2b07 Save all as .zip</button>' +
        (files.length <= 20 && canShareFiles(files.map(function (x) { return x.f; })) ? '<button class="ar-btn" data-act="res-share-all" data-idle type="button">Share all</button>' : '') +
        '</div>';
    }
    var rows = files.slice(0, RES_MAX).map(function (x, i) {
      return '<div class="ar-res-row"><span class="ar-ic">' + icon(x.p) + '</span>' +
        '<span class="ar-res-n" title="' + esc(x.p) + '">' + esc(many ? x.p : x.f.name) + '</span>' +
        '<span class="ar-res-s">' + fmtBytes(x.f.size) + '</span>' +
        '<button class="ar-btn' + (many ? '' : ' primary') + '" data-act="res-dl" data-i="' + i + '" type="button" title="Download">\u2b07' + (many ? '' : ' Download') + '</button>' +
        (canShareFiles([x.f]) ? '<button class="ar-btn" data-act="res-share" data-i="' + i + '" type="button" title="Share / Save to Files">' + (many ? '\u2197' : '\u2197 Share') + '</button>' : '') +
        '</div>';
    }).join('');
    if (files.length > RES_MAX) rows += '<div class="ar-more-n">\u2026 and ' + (files.length - RES_MAX) + ' more \u2014 use \u201cSave all as .zip\u201d</div>';
    el.innerHTML = head + acts + '<div class="ar-res-list">' + rows + '</div>' +
      (R.warn ? '<div class="ar-res-w">' + esc(R.warn) + '</div>' : '');
    renderBusy();
  }
  function bundleResults() {
    var R = S.results;
    if (!R || !R.files.length) return;
    var name = (S.arc ? S.arc.name.replace(/\.[^.]+$/, '').replace(/\.tar$/i, '') : 'files') + '-extracted.zip';
    var list = R.dirs.map(function (d) { return { p: d.p, d: 1 }; }).concat(R.files.map(function (x) { return { p: x.p, f: x.f }; }));
    pickSave(name).then(function (fh) {
      return runJob('Packing ' + name, 'bundle', { name: name, files: list, fileHandle: fh || undefined });
    }).then(function (r) {
      if (r.saved) toast('Saved ' + (r.name || name), 'success');
      else showResults(r, name + ' ready');
    }, function (e) { jobError(e, 'Couldn\u2019t pack'); });
  }
  // Desktop Chromium: ask where to save (must be the first await of a click).
  function pickSave(name) {
    if (!canPickFile() || !prefs.ask) return Promise.resolve(null);
    return window.showSaveFilePicker({ suggestedName: name, id: 'cade-archive' }).catch(function (e) {
      if (isAbort(e)) throw newErr('cancel', 'Cancelled');
      return null; // picker refused (e.g. blocked name): fall back to download
    });
  }

  // ---- extract: open / tree ----------------------------------------------------------------
  function arcKey(files) { return files.map(function (f) { return f.name + '|' + f.size + '|' + f.lastModified; }).join('/'); }
  function openArchive(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (S.job) { toast('Wait for the current task to finish (or cancel it)', 'info'); return; }
    closeArchive(true);
    var total = 0;
    files.forEach(function (f) { total += f.size; });
    var a = { files: files, name: files.length > 1 ? files.slice().sort(function (x, y) { return x.name < y.name ? -1 : 1; })[0].name : files[0].name, size: total, pws: [], key: arcKey(files), ready: false, openPw: '' };
    S.arc = a; S.results = null; renderResults();
    setTab('extract');
    renderExtract();
    var attempt = function (pw, auto) {
      return runJob('Opening ' + a.name, 'open', { files: files, password: pw || '' }).then(function (r) {
        if (S.arc !== a) return;
        a.openPw = pw || '';
        if (pw) a.pws = [pw];
        onOpened(a, r);
      }, function (e) {
        if (S.arc !== a) return;
        if (e && e.code === 'password') {
          return askPassword({ msg: '\u201c' + a.name + '\u201d has encrypted file names.', wrong: e.wrong && !auto }).then(function (p2) {
            if (p2 == null) { closeArchive(); return; }
            return attempt(p2);
          });
        }
        closeArchive();
        if (!isAbort(e) && e.code !== 'cancel') toast(e.code === 'format' ? 'Can\u2019t open \u201c' + a.name + '\u201d: ' + e.message : (e.message || 'Couldn\u2019t open the archive'), 'error', 4500);
      });
    };
    // A remembered session password may already unlock encrypted names.
    attempt(PW_SESSION.length ? PW_SESSION[PW_SESSION.length - 1] : '', true).catch(function () {});
  }
  function onOpened(a, r) {
    if (!S) return;
    a.ready = true;
    a.label = r.label || '';
    a.entries = r.entries || [];
    a.comment = r.comment || '';
    a.notes = r.notes || [];
    if (r.innerTar) { a.innerTar = r.innerTar.file; a.innerTarTmp = r.innerTar.tmp; }
    W.sess = a;
    buildTree(a);
    // Small archives open fully expanded; otherwise a lone top folder opens.
    a.root.open = true;
    if (a.nodes.length <= 40) a.nodes.forEach(function (n) { if (n.dir) n.open = true; });
    else if (a.root.kids.length === 1 && a.root.kids[0].dir) a.root.kids[0].open = true;
    renderExtract();
  }
  function closeArchive(silent) {
    if (S.arc && W.w) { rpc('close', {}).catch(function () {}); }
    if (S.prev && S.prev.url) URL.revokeObjectURL(S.prev.url);
    S.arc = null; S.prev = null; S.q = '';
    W.sess = null;
    if (!silent) renderExtract();
  }
  function buildTree(a) {
    var root = { id: 0, name: '', path: '', dir: true, kids: [], map: {}, parent: null, n: 0, nsel: 0, size: 0, depth: -1, entry: -1 };
    var nodes = [root], eNode = new Int32Array(a.entries.length);
    function dirNode(parent, name) {
      var k = parent.map[name];
      if (k && k.dir) return k;
      var d = { id: nodes.length, name: name, path: parent.path ? parent.path + '/' + name : name, dir: true, kids: [], map: {}, parent: parent, n: 0, nsel: 0, size: 0, depth: parent.depth + 1, entry: -1 };
      nodes.push(d); parent.kids.push(d); parent.map[name] = d;
      return d;
    }
    for (var i = 0; i < a.entries.length; i++) {
      var e = a.entries[i];
      var parts = e.p.split('/').filter(Boolean);
      if (!parts.length) { eNode[i] = 0; continue; }
      var cur = root;
      for (var j = 0; j < parts.length - 1; j++) cur = dirNode(cur, parts[j]);
      var nm = parts[parts.length - 1];
      var node;
      if (e.d) { node = dirNode(cur, nm); node.entry = i; }
      else {
        node = { id: nodes.length, name: nm, path: e.p, dir: false, parent: cur, depth: cur.depth + 1, entry: i, n: 1, nsel: 0, size: e.s };
        nodes.push(node); cur.kids.push(node);
        if (!cur.map[nm]) cur.map[nm] = node;
      }
      eNode[i] = node.id;
    }
    // Aggregates bottom-up (children always have larger ids than parents).
    for (var k = nodes.length - 1; k > 0; k--) {
      var n = nodes[k];
      if (n.dir) n.n += n.entry >= 0 ? 1 : 0;
      n.parent.n += n.n;
      n.parent.size += n.size > 0 ? n.size : 0;
    }
    var coll = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
    nodes.forEach(function (d) {
      if (!d.dir) return;
      d.kids.sort(function (x, y) {
        if (x.dir !== y.dir) return x.dir ? -1 : 1;
        return coll ? coll.compare(x.name, y.name) : (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
      });
    });
    a.root = root; a.nodes = nodes; a.eNode = eNode;
    a.sel = new Uint8Array(a.entries.length);
    a.nFiles = 0; a.bytes = 0;
    a.entries.forEach(function (e) { if (!e.d) { a.nFiles++; if (e.s > 0) a.bytes += e.s; } });
  }
  function setEntrySel(a, i, v) {
    if (a.sel[i] === v) return;
    a.sel[i] = v;
    var d = v ? 1 : -1, node = a.nodes[a.eNode[i]];
    for (var n = node; n; n = n.parent) n.nsel += d;
  }
  function toggleNode(a, node) {
    var v = node.nsel < node.n ? 1 : 0;
    (function walk(n) {
      if (n.entry >= 0) setEntrySel(a, n.entry, v);
      if (n.dir) for (var i = 0; i < n.kids.length; i++) walk(n.kids[i]);
    })(node);
  }
  function selIndices(a) {
    var out = [];
    for (var i = 0; i < a.sel.length; i++) if (a.sel[i]) out.push(i);
    return out;
  }
  function selStats(a) {
    var n = 0, b = 0;
    for (var i = 0; i < a.sel.length; i++) if (a.sel[i] && !a.entries[i].d) { n++; if (a.entries[i].s > 0) b += a.entries[i].s; }
    return { n: n, b: b };
  }

  // ---- extract: render -----------------------------------------------------------------------
  function renderExtract() {
    if (!S) return;
    var el = $('.ar-xt');
    if (!el) return;
    var a = S.arc;
    if (!a) {
      el.innerHTML =
        '<div class="ar-drop" data-act="pick-arc" role="button" tabindex="0">' +
          '<div class="ar-drop-ic">\ud83d\udddc\ufe0f</div>' +
          '<div class="ar-drop-t">Drop an archive here or <u>choose a file</u></div>' +
          '<div class="ar-drop-s">ZIP \u00b7 7z \u00b7 RAR \u00b7 TAR \u00b7 TGZ \u00b7 GZ \u00b7 BZ2 \u00b7 XZ \u00b7 ZST \u00b7 CAB \u00b7 ISO \u2026<br>Split sets: pick every part (.001, .002 \u2026 / .part1.rar \u2026)</div>' +
        '</div>' +
        '<div class="ar-quick"><span class="ar-quick-l">Quick:</span>' +
          '<button class="ar-btn" data-act="quick-gz" data-idle type="button">Gzip a file</button>' +
          '<button class="ar-btn" data-act="quick-gunzip" data-idle type="button">Gunzip a .gz</button>' +
        '</div>';
      renderBusy();
      return;
    }
    if (!a.ready) {
      el.innerHTML = '<div class="ar-arc-h"><span class="ar-arc-n">' + esc(a.name) + '</span><span class="ar-arc-m">' + fmtBytes(a.size) + '</span></div>' +
        '<div class="ar-empty">Opening\u2026</div>';
      return;
    }
    var enc = a.entries.some(function (e) { return e.e; });
    var info = plural(a.nFiles, 'file') + ' \u00b7 ' + fmtBytes(a.bytes) + (a.size ? ' (' + fmtBytes(a.size) + ' packed)' : '');
    var notes = a.notes.slice();
    if (a.comment) notes.unshift('Comment: ' + a.comment);
    el.innerHTML =
      '<div class="ar-arc-h">' +
        '<span class="ar-arc-n" title="' + esc(a.name) + '">' + esc(a.name) + '</span>' +
        (a.label ? '<span class="ar-badge">' + esc(a.label) + '</span>' : '') +
        (enc ? '<span class="ar-badge lock" title="Contains encrypted files">\ud83d\udd12</span>' : '') +
        '<button class="ar-x" data-act="close-arc" data-idle type="button" aria-label="Close archive" title="Close archive">\u00d7</button>' +
      '</div>' +
      '<div class="ar-arc-m2">' + esc(info) + '</div>' +
      (notes.length ? '<div class="ar-note">' + notes.map(esc).join('<br>') + '</div>' : '') +
      '<div class="ar-tools">' +
        '<input class="ar-in ar-q" type="search" placeholder="Filter files\u2026" aria-label="Filter files" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="' + esc(S.q || '') + '">' +
        '<button class="ar-btn" data-act="sel-all" type="button">Select all</button>' +
        '<button class="ar-btn" data-act="sel-none" type="button">None</button>' +
      '</div>' +
      '<div class="ar-tree" role="tree"></div>' +
      '<div class="ar-prev" hidden></div>' +
      '<div class="ar-acts">' +
        '<button class="ar-btn primary ar-x-sel" data-act="extract" data-idle type="button"></button>' +
        '<button class="ar-btn" data-act="extract-all" data-idle type="button">Extract all</button>' +
        (canPickDir() ? '<button class="ar-btn" data-act="extract-dir" data-idle type="button" title="Write the selection (or everything) into a folder">To folder\u2026</button>' : '') +
        '<button class="ar-btn" data-act="test" data-idle type="button" title="Check every file\u2019s checksum">Test</button>' +
      '</div>';
    renderTree();
    renderPreview();
    renderBusy();
  }
  function renderSelBtn() {
    if (!S) return;
    var b = $('.ar-x-sel');
    if (!b || !S.arc || !S.arc.ready) return;
    var st = selStats(S.arc);
    b.textContent = st.n ? 'Extract ' + plural(st.n, 'file') + ' (' + fmtBytes(st.b) + ')' : 'Extract selected';
  }
  function rowHtml(a, node, showPath) {
    var e = node.entry >= 0 ? a.entries[node.entry] : null;
    var state = node.nsel === 0 ? '' : node.nsel >= node.n ? ' checked' : '';
    var partial = node.nsel > 0 && node.nsel < node.n;
    var pad = showPath ? 0 : Math.max(0, node.depth) * 14;
    var nm = showPath ? node.path : node.name;
    var meta = node.dir
      ? '<span class="ar-sz">' + (node.n ? plural(countFiles(node), 'file') : 'empty') + '</span>'
      : '<span class="ar-sz">' + fmtBytes(e.s) + '</span>' +
        '<span class="ar-cs">' + (e.c >= 0 && e.c !== undefined ? fmtBytes(e.c) : '') + '</span>' +
        '<span class="ar-dt">' + esc(fmtDate(e.t)) + '</span>';
    return '<div class="ar-row' + (node.dir ? ' dir' : '') + (S.prev && S.prev.node === node.id ? ' on' : '') + '" data-n="' + node.id + '" role="treeitem"' + (node.dir ? ' aria-expanded="' + !!node.open + '"' : '') + '>' +
      '<span class="ar-pad" style="width:' + pad + 'px"></span>' +
      (node.dir && !showPath ? '<button class="ar-tw" data-act="twist" type="button" aria-label="' + (node.open ? 'Collapse' : 'Expand') + '">' + (node.open ? '\u25be' : '\u25b8') + '</button>' : '<span class="ar-tw sp"></span>') +
      '<label class="ar-ckw"><input type="checkbox" class="ar-ck" data-act="ck"' + state + (partial ? ' data-ind="1"' : '') + ' aria-label="Select ' + esc(node.name) + '"></label>' +
      '<span class="ar-ic">' + icon(node.name, node.dir) + '</span>' +
      '<span class="ar-nm" data-act="' + (node.dir ? 'twist' : 'peek') + '" title="' + esc(node.path) + '">' + esc(nm) + '</span>' +
      (e && e.e ? '<span class="ar-lock" title="Encrypted">\ud83d\udd12</span>' : '') +
      (e && e.k === 'l' ? '<span class="ar-lock" title="Link to ' + esc(e.link || '') + '">\u21aa</span>' : '') +
      meta +
    '</div>';
  }
  function countFiles(node) {
    if (node._files != null) return node._files;
    var c = 0;
    (function walk(n) { for (var i = 0; i < n.kids.length; i++) { if (n.kids[i].dir) walk(n.kids[i]); else c++; } })(node);
    node._files = c;
    return c;
  }
  function renderTree() {
    if (!S) return;
    var el = $('.ar-tree');
    if (!el || !S.arc || !S.arc.ready) return;
    var a = S.arc, out = [], q = (S.q || '').toLowerCase();
    if (q) {
      var hits = 0, more = 0;
      for (var i = 1; i < a.nodes.length; i++) {
        var n = a.nodes[i];
        if (n.dir || n.path.toLowerCase().indexOf(q) < 0) continue;
        if (hits < FILTER_MAX) out.push(rowHtml(a, n, true)); else more++;
        hits++;
      }
      if (!hits) out.push('<div class="ar-empty">No files match \u201c' + esc(S.q) + '\u201d</div>');
      if (more) out.push('<div class="ar-more-n">' + more + ' more matches \u2014 refine the filter</div>');
    } else {
      (function walk(d) {
        var lim = d.showAll ? d.kids.length : Math.min(d.kids.length, KIDS_PAGE);
        for (var i = 0; i < lim; i++) {
          var k = d.kids[i];
          out.push(rowHtml(a, k, false));
          if (k.dir && k.open) walk(k);
        }
        if (lim < d.kids.length) out.push('<button class="ar-more" data-act="more" data-n="' + d.id + '" type="button" style="margin-left:' + ((d.depth + 1) * 14 + 30) + 'px">Show ' + (d.kids.length - lim) + ' more\u2026</button>');
      })(a.root);
      if (!a.root.kids.length) out.push('<div class="ar-empty">This archive is empty.</div>');
    }
    var st = el.scrollTop;
    el.innerHTML = out.join('');
    el.scrollTop = st;
    var ind = el.querySelectorAll('[data-ind]');
    for (var j = 0; j < ind.length; j++) ind[j].indeterminate = true;
    renderSelBtn();
  }

  // ---- extract: preview ----------------------------------------------------------------------
  function renderPreview() {
    if (!S) return;
    var el = $('.ar-prev');
    if (!el) return;
    var P = S.prev;
    if (!P) { el.hidden = true; el.innerHTML = ''; return; }
    var a = S.arc, e = a.entries[P.i];
    el.hidden = false;
    var body;
    if (P.loading) body = '<div class="ar-empty">Loading\u2026</div>';
    else if (P.err) body = '<div class="ar-empty">' + esc(P.err) + '</div>';
    else if (P.url) body = '<div class="ar-prev-img"><img alt="' + esc(baseName(e.p)) + '" src="' + P.url + '"></div>';
    else if (P.text != null) body = '<pre class="ar-prev-txt">' + esc(P.text.length > 200000 ? P.text.slice(0, 200000) + '\n\u2026' : P.text) + '</pre>';
    else body = '<div class="ar-empty">No preview for this file type.</div>';
    el.innerHTML =
      '<div class="ar-prev-h"><span class="ar-ic">' + icon(e.p) + '</span><b title="' + esc(e.p) + '">' + esc(baseName(e.p)) + '</b>' +
        '<span class="ar-prev-m">' + fmtBytes(e.s) + (e.t ? ' \u00b7 ' + esc(fmtDate(e.t)) : '') + '</span>' +
        '<button class="ar-x" data-act="prev-close" type="button" aria-label="Close preview">\u00d7</button></div>' +
      body +
      '<div class="ar-prev-a">' +
        (P.text != null && !P.truncated ? '<button class="ar-btn primary" data-act="prev-insert" type="button">Insert into document</button><button class="ar-btn" data-act="prev-copy" type="button">Copy</button>' : '') +
        (P.text != null && P.truncated ? '<span class="ar-hint">Showing the first ' + fmtBytes(TEXT_MAX) + ' \u2014 extract to get it all</span>' : '') +
        '<button class="ar-btn" data-act="prev-extract" data-idle type="button">Extract this file</button>' +
      '</div>';
    renderBusy();
  }
  function peek(nodeId) {
    var a = S.arc, node = a.nodes[nodeId];
    if (!node || node.dir) return;
    var e = a.entries[node.entry];
    if (S.prev && S.prev.url) URL.revokeObjectURL(S.prev.url);
    var x = ext(e.p), isImg = IMG_EXT.test(x), isText = TEXT_EXT.test(x) || (!isImg && e.s <= 65536);
    S.prev = { i: node.entry, node: nodeId };
    var max = isImg ? IMG_MAX : TEXT_MAX;
    if (e.k === 'l' || (!isImg && !isText) || (isImg && e.s > IMG_MAX) || e.s < 0 || S.job) {
      if (S.job) S.prev.err = 'Busy \u2014 try again when the current task finishes.';
      else if (isImg) S.prev.err = 'Too large to preview here.';
      renderTree(); renderPreview();
      return;
    }
    S.prev.loading = true;
    renderTree(); renderPreview();
    var P = S.prev;
    withPasswords(function (pws) {
      return runJob('Reading ' + baseName(e.p), 'read', { i: node.entry, max: max, passwords: pws }, { needsArchive: true });
    }).then(function (r) {
      if (S.prev !== P) return;
      P.loading = false;
      var bytes = r.bytes;
      if (isImg) P.url = URL.createObjectURL(new Blob([bytes], { type: IMG_MIME[x] || 'application/octet-stream' }));
      else {
        var sample = bytes.subarray(0, 8192), bin = false;
        for (var i = 0; i < sample.length; i++) if (sample[i] === 0) { bin = true; break; }
        if (bin) P.err = 'Binary file \u2014 no text preview.';
        else { P.text = new TextDecoder('utf-8').decode(bytes); P.truncated = r.truncated; }
      }
      renderPreview();
    }, function (e2) {
      if (S.prev !== P) return;
      P.loading = false;
      P.err = e2 && e2.code === 'cancel' ? 'Cancelled.' : (e2 && e2.message) || 'Couldn\u2019t read it.';
      renderPreview();
    });
  }

  // ---- extract: actions ----------------------------------------------------------------------
  function extract(mode) {
    var a = S.arc;
    if (!a || !a.ready) return;
    var idx = null, files = 0, single = null;
    if (mode === 'one') { idx = [S.prev.i]; files = 1; single = a.entries[S.prev.i]; }
    else if (mode === 'sel' || (mode === 'dir' && selStats(a).n)) {
      idx = selIndices(a);
      idx.forEach(function (i) { if (!a.entries[i].d) { files++; single = a.entries[i]; } });
      if (!files) { toast('Select files first (or use Extract all)', 'info'); return; }
    } else {
      files = a.nFiles;
      if (files === 1) a.entries.forEach(function (e) { if (!e.d) single = e; });
    }
    if (files !== 1) single = null;
    // Pickers must be the first await inside the click.
    var dest;
    if (mode === 'dir') {
      dest = window.showDirectoryPicker({ mode: 'readwrite', id: 'cade-archive-x' }).then(function (h) { return { dirHandle: h }; }, function (e) {
        throw isAbort(e) ? newErr('cancel', 'Cancelled') : e;
      });
    } else if (single) dest = pickSave(baseName(single.p)).then(function (fh) { return fh ? { fileHandle: fh } : {}; });
    else dest = Promise.resolve({});
    dest.then(function (d) {
      return withPasswords(function (pws) {
        return runJob(files === 1 ? 'Extracting ' + baseName(single ? single.p : a.name) : 'Extracting ' + plural(files, 'file'), 'extract',
          Object.assign({ sel: idx, passwords: pws }, d), { needsArchive: true });
      });
    }).then(function (r) {
      if (r.saved != null) {
        toast(r.dir != null ? 'Extracted ' + plural(r.saved, 'file') + ' into \u201c' + (r.dir || 'the folder') + '\u201d' : 'Saved ' + (r.name || ''), 'success', 2600);
        if (r.warn) toast(r.warn, 'info', 4000);
        return;
      }
      var n = (r.files || []).filter(function (x) { return x.f; }).length;
      showResults(r, n === 1 ? 'Extracted' : 'Extracted ' + plural(n, 'file'));
    }, function (e) { jobError(e, 'Extract failed'); });
  }
  function testArchive() {
    withPasswords(function (pws) {
      return runJob('Testing ' + S.arc.name, 'test', { passwords: pws }, { needsArchive: true });
    }).then(function (r) {
      S.results = {
        report: true, ok: r.ok,
        title: r.ok ? '\u2713 All ' + plural(r.checked, 'file') + ' passed the integrity check' : '\u2717 ' + plural(r.errors.length, 'problem') + ' found',
        lines: r.errors || [],
      };
      renderResults();
    }, function (e) { jobError(e, 'Test failed'); });
  }

  // ---- create ------------------------------------------------------------------------------
  var FMT = {
    zip: { label: 'ZIP', ext: '.zip', levels: [[0, 'Store (no compression)'], [1, 'Fastest'], [6, 'Normal'], [9, 'Maximum']], pw: true },
    '7z': { label: '7z', ext: '.7z', levels: [[0, 'Store'], [1, 'Fastest'], [3, 'Fast'], [5, 'Normal'], [7, 'Maximum'], [9, 'Ultra (lots of memory)']], pw: true },
    tar: { label: 'TAR', ext: '.tar', levels: null, pw: false },
    tgz: { label: 'TAR.GZ', ext: '.tar.gz', levels: null, pw: false },
    gz: { label: 'GZ (one file)', ext: '.gz', levels: null, pw: false },
  };
  var VOLS = [['', 'No split'], ['10m', '10 MB parts'], ['100m', '100 MB parts'], ['700m', '700 MB parts'], ['1g', '1 GB parts'], ['4g', '4 GB parts (FAT32)']];
  var COMMON_PW = /^(password|passw0rd|123456|12345678|123456789|qwerty|abc123|letmein|welcome|iloveyou|admin|monkey|dragon|football|baseball|111111|000000|sunshine|princess)\d*$/;
  function strength(pw) {
    if (!pw) return null;
    var pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
    var uniq = {};
    for (var i = 0; i < pw.length; i++) uniq[pw[i]] = 1;
    var len = Math.min(pw.length, Object.keys(uniq).length * 2); // "aaaaaaaa" is not long
    var bits = len * Math.log(pool || 1) / Math.LN2;
    if (COMMON_PW.test(pw.toLowerCase())) bits = Math.min(bits, 10);
    if (/^(?:0123|1234|2345|abcd|qwer|asdf|zxcv)/i.test(pw)) bits *= 0.6;
    var lv = bits < 28 ? 0 : bits < 45 ? 1 : bits < 70 ? 2 : 3;
    return { bits: bits, lv: lv, label: ['Weak', 'Fair', 'Good', 'Strong'][lv] };
  }
  function uniqueTop(name) {
    var taken = {};
    S.items.forEach(function (g) { taken[g.name.toLowerCase()] = 1; });
    if (!taken[name.toLowerCase()]) return name;
    var m = /^(.*?)(\.[^.]*)?$/.exec(name), i = 2;
    while (taken[(m[1] + ' (' + i + ')' + (m[2] || '')).toLowerCase()]) i++;
    return m[1] + ' (' + i + ')' + (m[2] || '');
  }
  var gid = 0;
  function addGroup(name, kind, files, dirs) {
    var top = uniqueTop(name);
    var g = { id: ++gid, name: top, kind: kind, files: [], dirs: [], size: 0 };
    files.forEach(function (x) {
      var rest = kind === 'dir' ? x.p.slice(x.p.indexOf('/') + 1) : '';
      g.files.push({ p: kind === 'dir' ? top + '/' + rest : top, f: x.f });
      g.size += x.f.size;
    });
    (dirs || []).forEach(function (d) {
      var rest = d.indexOf('/') >= 0 ? d.slice(d.indexOf('/') + 1) : '';
      g.dirs.push(rest ? top + '/' + rest : top);
    });
    S.items.push(g);
  }
  function addFiles(list) {
    Array.prototype.forEach.call(list || [], function (f) { addGroup(f.name, 'file', [{ p: f.name, f: f }]); });
    afterAdd();
  }
  function addFolderInput(list) {
    var groups = {};
    Array.prototype.forEach.call(list || [], function (f) {
      var rel = f.webkitRelativePath || f.name;
      var top = rel.split('/')[0];
      (groups[top] = groups[top] || []).push({ p: rel, f: f });
    });
    Object.keys(groups).forEach(function (top) { addGroup(top, 'dir', groups[top], [top]); });
    afterAdd();
  }
  // Drag & drop, folders included (DataTransferItem.webkitGetAsEntry).
  function readAllEntries(dirEntry) {
    var reader = dirEntry.createReader(), all = [];
    return new Promise(function (resolve) {
      (function more() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          more();
        }, function () { resolve(all); });
      })();
    });
  }
  function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (f) { out.files.push({ p: prefix + entry.name, f: f }); resolve(); }, function () { resolve(); });
      });
    }
    if (entry.isDirectory) {
      out.dirs.push(prefix + entry.name);
      return readAllEntries(entry).then(function (kids) {
        var p = Promise.resolve();
        kids.forEach(function (k) { p = p.then(function () { return walkEntry(k, prefix + entry.name + '/', out); }); });
        return p;
      });
    }
    return Promise.resolve();
  }
  function addFromDrop(dt) {
    var entries = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      for (var i = 0; i < dt.items.length; i++) {
        var en = dt.items[i].kind === 'file' && dt.items[i].webkitGetAsEntry();
        if (en) entries.push(en);
      }
    }
    if (!entries.length) { addFiles(dt.files); return; }
    S.adding = true; renderCreate();
    var p = Promise.resolve();
    entries.forEach(function (en) {
      p = p.then(function () {
        var out = { files: [], dirs: [] };
        return walkEntry(en, '', out).then(function () {
          if (en.isDirectory) addGroup(en.name, 'dir', out.files, out.dirs);
          else if (out.files.length) addGroup(out.files[0].f.name, 'file', out.files);
        });
      });
    });
    p.then(function () { S.adding = false; afterAdd(); }, function () { S.adding = false; afterAdd(); });
  }
  // The name follows the content until the user types one.
  function defaultName() {
    if (!S.cnameTouched) S.cname = S.items.length === 1 ? S.items[0].name.replace(/\.[^.\/]+$/, '') : S.items.length ? 'archive' : '';
  }
  function afterAdd() {
    defaultName();
    setTab('create');
    renderCreate();
  }
  function flatItems() {
    var out = [];
    S.items.forEach(function (g) {
      if (g.kind === 'dir') {
        var dirs = {};
        g.dirs.forEach(function (d) { dirs[d] = 1; });
        g.files.forEach(function (x) {
          var parts = x.p.split('/');
          for (var i = 1; i < parts.length; i++) dirs[parts.slice(0, i).join('/')] = 1;
        });
        Object.keys(dirs).sort().forEach(function (d) { out.push({ p: d, d: 1 }); });
      }
      g.files.forEach(function (x) { out.push({ p: x.p, f: x.f, t: x.f.lastModified }); });
    });
    return out;
  }
  function renderCreate() {
    if (!S) return;
    var el = $('.ar-ct');
    if (!el) return;
    var caps = W.caps || {};
    var fmt = prefs.fmt, F = FMT[fmt];
    var total = 0, nfiles = 0;
    S.items.forEach(function (g) { total += g.size; nfiles += g.files.length; });
    var rows = S.items.map(function (g, i) {
      return '<div class="ar-item" data-g="' + i + '">' +
        '<span class="ar-ic">' + icon(g.name, g.kind === 'dir') + '</span>' +
        '<span class="ar-item-n" title="' + esc(g.name) + '">' + esc(g.name) + '</span>' +
        '<span class="ar-item-m">' + (g.kind === 'dir' ? plural(g.files.length, 'file') + ' \u00b7 ' : '') + fmtBytes(g.size) + '</span>' +
        '<button class="ar-ib" data-act="item-up" data-idle type="button" aria-label="Move up"' + (i ? '' : ' disabled') + '>\u2191</button>' +
        '<button class="ar-ib" data-act="item-down" data-idle type="button" aria-label="Move down"' + (i < S.items.length - 1 ? '' : ' disabled') + '>\u2193</button>' +
        '<button class="ar-ib" data-act="item-rm" data-idle type="button" aria-label="Remove">\u00d7</button>' +
      '</div>';
    }).join('');
    var folderOk = !isIOS() && 'webkitdirectory' in document.createElement('input');
    var fmtOpts = Object.keys(FMT).map(function (k) {
      var dis = ((k === 'tgz' || k === 'gz') && caps.cs === false) || (k === '7z' && caps.wasm === false);
      return '<option value="' + k + '"' + (k === fmt ? ' selected' : '') + (dis ? ' disabled' : '') + '>' + FMT[k].label + '</option>';
    }).join('');
    var lvKey = fmt === '7z' ? 'szLevel' : 'zipLevel';
    var lvl = F.levels ? '<label class="ar-f"><span>Compression</span><select class="ar-in ar-lvl" data-idle>' + F.levels.map(function (l) {
      return '<option value="' + l[0] + '"' + (l[0] === prefs[lvKey] ? ' selected' : '') + '>' + l[1] + '</option>';
    }).join('') + '</select></label>' : '<div class="ar-f"><span>Compression</span><div class="ar-hint">' + (fmt === 'tar' ? 'None (TAR only bundles files)' : 'Standard gzip level (set by the browser)') + '</div></div>';
    var pw1 = S.pw1 || '', pw2 = S.pw2 || '', st = strength(pw1);
    var pwHtml;
    if (F.pw) {
      pwHtml =
        '<div class="ar-pw">' +
          '<label class="ar-f"><span>Password <i>(optional)</i></span><div class="ar-pwrow">' +
            '<input class="ar-in ar-pw1" type="' + (S.showPw ? 'text' : 'password') + '" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" value="' + esc(pw1) + '" aria-label="Password">' +
            '<button class="ar-btn ar-eye" data-act="pw-eye" type="button">' + (S.showPw ? 'Hide' : 'Show') + '</button></div></label>' +
          (pw1 ? '<input class="ar-in ar-pw2" type="' + (S.showPw ? 'text' : 'password') + '" autocomplete="new-password" placeholder="Confirm password" aria-label="Confirm password" value="' + esc(pw2) + '">' +
            '<div class="ar-meter lv' + st.lv + '"><span style="width:' + Math.min(100, Math.max(8, st.bits / 80 * 100)).toFixed(0) + '%"></span></div>' +
            '<div class="ar-hint ar-pwhint">' + st.label + ' \u00b7 ~' + Math.round(st.bits) + ' bits' + (st.lv < 2 ? ' \u2014 longer is better: try 4+ random words' : '') +
              (pw2 && pw2 !== pw1 ? ' \u00b7 <b class="ar-bad">passwords don\u2019t match</b>' : '') + '</div>' : '') +
          (fmt === 'zip' ? '<label class="ar-f"><span>Encryption</span><select class="ar-in ar-enc" data-idle>' +
              '<option value="aes"' + (prefs.method === 'aes' ? ' selected' : '') + '>AES-256 (recommended)</option>' +
              '<option value="zc"' + (prefs.method === 'zc' ? ' selected' : '') + '>ZipCrypto (legacy, weak)</option></select></label>' +
            '<div class="ar-hint">' + (prefs.method === 'zc'
              ? '\u26a0 ZipCrypto is easily cracked \u2014 use it only for old unzip tools (Windows Explorer opens it).'
              : 'AES ZIPs open in 7-Zip, WinZip, Keka, The Unarchiver and here \u2014 not in Windows Explorer or the iPhone Files app.') + '</div>' : '') +
          (fmt === '7z' ? '<label class="ar-chk"><input type="checkbox" class="ar-encnames"' + (prefs.encNames ? ' checked' : '') + '> Also encrypt file names (AES-256)</label>' : '') +
        '</div>';
    } else {
      pwHtml = '<div class="ar-pw"><div class="ar-hint">' + FMT[fmt].label + ' can\u2019t be encrypted. Need a password? ' +
        '<button class="ar-link" data-act="fmt-zip" type="button">Use ZIP (AES-256)</button> or <button class="ar-link" data-act="fmt-7z" type="button">7z (AES-256)</button></div></div>';
    }
    var vol = fmt === '7z' ? '<label class="ar-f"><span>Split into parts</span><select class="ar-in ar-vol" data-idle>' + VOLS.map(function (v) {
      return '<option value="' + v[0] + '"' + (v[0] === prefs.vol ? ' selected' : '') + '>' + v[1] + '</option>';
    }).join('') + '</select></label>' : '';
    var warn = [];
    if (fmt === 'gz' && nfiles !== 1) warn.push('GZ holds exactly one file \u2014 use TAR.GZ for several.');
    if (fmt === '7z' && prefs.szLevel >= 9) warn.push('Ultra needs ~700 MB of memory while compressing \u2014 it may fail on a phone.');
    if (caps.opfs === false && total > 300 * 1048576) warn.push('This browser has no on-device temp storage here, so the archive is built in memory \u2014 very large inputs may fail.');
    el.innerHTML =
      '<div class="ar-add">' +
        '<button class="ar-btn" data-act="add-files" data-idle type="button">+ Files</button>' +
        (folderOk ? '<button class="ar-btn" data-act="add-dir" data-idle type="button">+ Folder</button>' : '') +
        '<span class="ar-hint">' + (S.adding ? 'Reading dropped folders\u2026' : 'or drop files' + (folderOk ? ' & folders' : '') + ' here') + '</span>' +
        (S.items.length ? '<button class="ar-link ar-clear" data-act="items-clear" data-idle type="button">Clear</button>' : '') +
      '</div>' +
      '<div class="ar-items">' + (rows || '<div class="ar-empty">Nothing added yet.</div>') + '</div>' +
      (S.items.length ? '<div class="ar-hint ar-sum">' + plural(nfiles, 'file') + ' \u00b7 ' + fmtBytes(total) + '</div>' : '') +
      '<div class="ar-opts">' +
        '<label class="ar-f"><span>Format</span><select class="ar-in ar-fmt" data-idle>' + fmtOpts + '</select></label>' +
        lvl +
        '<label class="ar-f ar-f-name"><span>Archive name</span><div class="ar-namerow"><input class="ar-in ar-name" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="' + esc(S.cname || '') + '" placeholder="archive"><span class="ar-ext">' + F.ext + (fmt === '7z' && prefs.vol ? '.001\u2026' : '') + '</span></div></label>' +
        vol +
      '</div>' +
      pwHtml +
      (warn.length ? '<div class="ar-note">' + warn.map(esc).join('<br>') + '</div>' : '') +
      '<div class="ar-acts"><button class="ar-btn primary" data-act="create" data-idle type="button">Create ' + F.label.replace(/ \(.*\)/, '') + '</button></div>';
    renderBusy();
  }
  function isIOS() {
    return /iP(hone|od|ad)/.test(navigator.platform || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function doCreate() {
    var fmt = prefs.fmt, F = FMT[fmt];
    if (!S.items.length) { toast('Add some files first', 'info'); return; }
    var items = flatItems();
    var nfiles = items.filter(function (x) { return !x.d; }).length;
    if (fmt === 'gz' && nfiles !== 1) { toast('GZ holds exactly one file \u2014 choose TAR.GZ for several', 'error', 3000); return; }
    var pw = F.pw ? (S.pw1 || '') : '';
    if (pw && pw !== (S.pw2 || '')) { toast('The passwords don\u2019t match', 'error'); var p2 = $('.ar-pw2'); if (p2) p2.focus(); return; }
    var base = (S.cname || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || (S.items.length === 1 ? S.items[0].name.replace(/\.[^.\/]+$/, '') : 'archive');
    if (base.toLowerCase().slice(-F.ext.length) === F.ext) base = base.slice(0, -F.ext.length);
    var name = base + F.ext;
    var payload = {
      fmt: fmt, items: items, name: name,
      level: fmt === '7z' ? prefs.szLevel : fmt === 'zip' ? prefs.zipLevel : undefined,
      password: pw || undefined, zipCrypto: fmt === 'zip' && pw && prefs.method === 'zc',
      encNames: fmt === '7z' && pw && prefs.encNames, vol: fmt === '7z' ? prefs.vol || undefined : undefined,
    };
    var chosen = fmt === '7z' && payload.vol ? Promise.resolve(null) : pickSave(name);
    chosen.then(function (fh) {
      if (fh) payload.fileHandle = fh;
      return runJob('Creating ' + name, 'create', payload);
    }).then(function (r) {
      if (r.saved) { toast('Saved ' + (r.name || name), 'success', 2400); return; }
      showResults(r, (r.files && r.files.length > 1 ? plural(r.files.length, 'part') + ' of ' + name : name) + ' ready');
      // Clear the password fields once used (they never leave this panel).
      S.pw1 = S.pw2 = '';
      renderCreate();
    }, function (e) { jobError(e, 'Couldn\u2019t create the archive'); });
  }
  function quickGzip(f) {
    var name = f.name + '.gz';
    pickSave(name).then(function (fh) {
      return runJob('Gzipping ' + f.name, 'create', { fmt: 'gz', items: [{ p: f.name, f: f, t: f.lastModified }], name: name, fileHandle: fh || undefined });
    }).then(function (r) {
      if (r.saved) toast('Saved ' + (r.name || name), 'success');
      else showResults(r, name + ' ready');
    }, function (e) { jobError(e, 'Gzip failed'); });
  }
  function quickGunzip(f) {
    var name = f.name.replace(/\.(gz|gzip)$/i, '').replace(/\.tgz$/i, '.tar') || 'file';
    if (name === f.name) name += '.out';
    pickSave(name).then(function (fh) {
      return runJob('Gunzipping ' + f.name, 'gunzip', { file: f, fileHandle: fh || undefined });
    }).then(function (r) {
      if (r.saved) toast('Saved ' + (r.name || name), 'success');
      else showResults(r, 'Decompressed');
    }, function (e) { jobError(e, 'Gunzip failed'); });
  }

  // ---- panel ------------------------------------------------------------------------------
  function setTab(t) {
    if (!S) return;
    S.tab = t; prefs.tab = t; savePrefs();
    var p = panel();
    if (!p) return;
    p.querySelector('.ar-xt').hidden = t !== 'extract';
    p.querySelector('.ar-ct').hidden = t !== 'create';
    var tabs = p.querySelectorAll('.ar-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === t;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (t === 'create') renderCreate();
  }
  function pick(sel) {
    var i = $(sel);
    if (!i) return;
    i.value = '';
    i.click();
  }
  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var b = t.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    var a = S.arc;
    if (act === 'ck') return; // handled on change
    if (act === 'tab') { setTab(b.getAttribute('data-tab')); return; }
    if (act === 'cancel') { cancelJob(); return; }
    if (act === 'pick-arc') { pick('.ar-f-arc'); return; }
    if (act === 'quick-gz') { pick('.ar-f-gz'); return; }
    if (act === 'quick-gunzip') { pick('.ar-f-gunzip'); return; }
    if (act === 'close-arc') { closeArchive(); return; }
    if (act === 'rm-eng') {
      if (S.job) { toast('Wait for the current task to finish', 'info'); return; }
      if (!window.confirm('Remove the downloaded archive engines (' + fmtBytes(S.engBytes || 0) + ') from this device? They download again when needed.')) return;
      killWorker(); // the open archive is reopened lazily on next use
      window.caches['delete'](CACHE).then(function () { toast('Engines removed', 'success'); renderEngines(); }, function () { toast('Couldn\u2019t remove them', 'error'); });
      return;
    }
    if (act === 'res-close') { S.results = null; renderResults(); return; }
    if (act === 'res-dl') { var x = S.results.files[+b.getAttribute('data-i')]; if (x) download(x.f); return; }
    if (act === 'res-share') { var y = S.results.files[+b.getAttribute('data-i')]; if (y) share([y.f]); return; }
    if (act === 'res-share-all') { share(S.results.files.map(function (z) { return z.f; })); return; }
    if (act === 'res-zip') { bundleResults(); return; }
    // extract tab
    if (a && a.ready) {
      var row = t.closest('.ar-row');
      var node = row ? a.nodes[+row.getAttribute('data-n')] : null;
      if (act === 'twist' && node && node.dir) {
        if (S.q) { S.q = ''; var qi = $('.ar-q'); if (qi) qi.value = ''; }
        node.open = !node.open; renderTree(); return;
      }
      if (act === 'peek' && node) { peek(node.id); return; }
      if (act === 'more') { a.nodes[+b.getAttribute('data-n')].showAll = true; renderTree(); return; }
      if (act === 'sel-all' || act === 'sel-none') {
        var v = act === 'sel-all' ? 1 : 0, q = (S.q || '').toLowerCase();
        for (var i = 0; i < a.entries.length; i++) {
          if (q && a.entries[i].p.toLowerCase().indexOf(q) < 0) continue; // "all" = all matches
          setEntrySel(a, i, v);
        }
        renderTree(); return;
      }
      if (act === 'extract') { extract('sel'); return; }
      if (act === 'extract-all') { extract('all'); return; }
      if (act === 'extract-dir') { extract('dir'); return; }
      if (act === 'test') { testArchive(); return; }
      if (act === 'prev-close') { if (S.prev && S.prev.url) URL.revokeObjectURL(S.prev.url); S.prev = null; renderPreview(); renderTree(); return; }
      if (act === 'prev-insert' && S.prev && S.prev.text != null) { insertText(S.prev.text); return; }
      if (act === 'prev-copy' && S.prev && S.prev.text != null) { copyText(S.prev.text); return; }
      if (act === 'prev-extract' && S.prev) { extract('one'); return; }
    }
    // create tab
    if (act === 'add-files') { pick('.ar-f-files'); return; }
    if (act === 'add-dir') { pick('.ar-f-dir'); return; }
    if (act === 'items-clear') { S.items = []; S.cnameTouched = false; defaultName(); renderCreate(); return; }
    var it = t.closest('.ar-item'), gi = it ? +it.getAttribute('data-g') : -1;
    if (act === 'item-rm' && gi >= 0) { S.items.splice(gi, 1); defaultName(); renderCreate(); return; }
    if ((act === 'item-up' || act === 'item-down') && gi >= 0) {
      var j = act === 'item-up' ? gi - 1 : gi + 1;
      if (j < 0 || j >= S.items.length) return;
      var tmp = S.items[gi]; S.items[gi] = S.items[j]; S.items[j] = tmp;
      renderCreate(); return;
    }
    if (act === 'pw-eye') { S.showPw = !S.showPw; renderCreate(); var p1 = $('.ar-pw1'); if (p1) p1.focus(); return; }
    if (act === 'fmt-zip' || act === 'fmt-7z') { prefs.fmt = act === 'fmt-zip' ? 'zip' : '7z'; savePrefs(); renderCreate(); var p3 = $('.ar-pw1'); if (p3) p3.focus(); return; }
    if (act === 'create') { doCreate(); return; }
  }
  function onChange(e) {
    var t = e.target, a = S.arc;
    if (t.classList.contains('ar-ck') && a && a.ready) {
      var row = t.closest('.ar-row'), node = row && a.nodes[+row.getAttribute('data-n')];
      if (node) { toggleNode(a, node); renderTree(); }
      return;
    }
    if (t.classList.contains('ar-f-arc')) { if (t.files && t.files.length) openArchive(t.files); return; }
    if (t.classList.contains('ar-f-files')) { addFiles(t.files); return; }
    if (t.classList.contains('ar-f-dir')) { addFolderInput(t.files); return; }
    if (t.classList.contains('ar-f-gz')) { if (t.files && t.files[0]) quickGzip(t.files[0]); return; }
    if (t.classList.contains('ar-f-gunzip')) { if (t.files && t.files[0]) quickGunzip(t.files[0]); return; }
    if (t.classList.contains('ar-fmt')) { prefs.fmt = t.value; savePrefs(); renderCreate(); return; }
    if (t.classList.contains('ar-lvl')) { prefs[prefs.fmt === '7z' ? 'szLevel' : 'zipLevel'] = +t.value; savePrefs(); renderCreate(); return; }
    if (t.classList.contains('ar-enc')) { prefs.method = t.value; savePrefs(); renderCreate(); return; }
    if (t.classList.contains('ar-encnames')) { prefs.encNames = t.checked; savePrefs(); return; }
    if (t.classList.contains('ar-vol')) { prefs.vol = t.value; savePrefs(); renderCreate(); return; }
  }
  var qTimer = null;
  function onInput(e) {
    var t = e.target;
    if (t.classList.contains('ar-q')) {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { if (S) { S.q = t.value.trim(); renderTree(); } }, 120);
    } else if (t.classList.contains('ar-name')) {
      S.cname = t.value; S.cnameTouched = !!t.value;
    } else if (t.classList.contains('ar-pw1') || t.classList.contains('ar-pw2')) {
      var had = !!S.pw1;
      if (t.classList.contains('ar-pw1')) S.pw1 = t.value; else S.pw2 = t.value;
      // Re-render only the meter/hint so typing never loses focus.
      if (had !== !!S.pw1) { var pos = t.selectionStart; renderCreate(); var n = $(t.classList.contains('ar-pw1') ? '.ar-pw1' : '.ar-pw2'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) {} } }
      else updateMeter();
    }
  }
  function updateMeter() {
    var st = strength(S.pw1 || ''), m = $('.ar-meter'), h = $('.ar-pwhint');
    if (!st || !m || !h) return;
    m.className = 'ar-meter lv' + st.lv;
    m.firstChild.style.width = Math.min(100, Math.max(8, st.bits / 80 * 100)).toFixed(0) + '%';
    h.innerHTML = st.label + ' \u00b7 ~' + Math.round(st.bits) + ' bits' + (st.lv < 2 ? ' \u2014 longer is better: try 4+ random words' : '') +
      (S.pw2 && S.pw2 !== S.pw1 ? ' \u00b7 <b class="ar-bad">passwords don\u2019t match</b>' : '');
  }
  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    var ty = dt.types || [];
    for (var i = 0; i < ty.length; i++) if (ty[i] === 'Files') return true;
    return false;
  }
  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {}
    panel().classList.add('ar-dragging');
  }
  function onDragLeave(e) {
    var p = panel();
    if (p && (!e.relatedTarget || !p.contains(e.relatedTarget))) p.classList.remove('ar-dragging');
  }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    var p = panel();
    p.classList.remove('ar-dragging');
    if (S.job) { toast('Wait for the current task to finish', 'info'); return; }
    if (S.tab === 'create') addFromDrop(e.dataTransfer);
    else openArchive(e.dataTransfer.files);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      var m = $('.ar-modal');
      if (m && !m.hidden) return; // the dialog handles its own Escape
      e.preventDefault();
      if (S.prev) { S.prev = null; renderPreview(); renderTree(); }
      else if (S.q) { S.q = ''; var qi = $('.ar-q'); if (qi) qi.value = ''; renderTree(); }
      else if (!S.job) close();
      e.stopPropagation();
    } else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('ar-drop')) {
      e.preventDefault(); pick('.ar-f-arc');
    }
  }
  function close() {
    var p = panel();
    if (p) { p.remove(); if (p._onClose) p._onClose(); }
  }

  function open() {
    Cade.closeAllMenus();
    var existing = panel();
    if (existing) { close(); return; }
    loadPrefs();
    clearTimeout(cleanupTimer); cleanupTimer = null;
    S = { tab: prefs.tab === 'create' ? 'create' : 'extract', arc: null, items: [], results: null, job: null, urls: [], q: '', prev: null, cname: '', pw1: '', pw2: '', showPw: false, remember: PW_SESSION.length > 0 };
    // Stale temp files from a previous session go first; jobs wait for it.
    S.cleanP = cleanupTemps();
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udddc\ufe0f Archive Utility',
      '<div class="ar-tabs" role="tablist">' +
        '<button class="ar-tab" data-act="tab" data-tab="extract" role="tab" type="button">Open / Extract</button>' +
        '<button class="ar-tab" data-act="tab" data-tab="create" role="tab" type="button">Create</button>' +
      '</div>' +
      '<div class="ar-main">' +
        '<div class="ar-xt"></div>' +
        '<div class="ar-ct" hidden></div>' +
      '</div>' +
      '<div class="ar-job" hidden aria-live="polite"></div>' +
      '<div class="ar-res" hidden></div>' +
      '<div class="ar-foot"><span class="ar-priv">\ud83d\udd12 Files never leave this device.</span> <span class="ar-eng"></span></div>' +
      '<div class="ar-modal" hidden></div>' +
      '<input type="file" class="ar-f-arc" hidden multiple>' +
      '<input type="file" class="ar-f-files" hidden multiple>' +
      '<input type="file" class="ar-f-dir" hidden webkitdirectory multiple>' +
      '<input type="file" class="ar-f-gz" hidden>' +
      '<input type="file" class="ar-f-gunzip" hidden>');
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
    p.addEventListener('keydown', onKey);
    p.addEventListener('dragover', onDragOver);
    p.addEventListener('dragleave', onDragLeave);
    p.addEventListener('drop', onDrop);
    p._onClose = function () {
      killWorker();
      if (S) {
        if (S.prev && S.prev.url) URL.revokeObjectURL(S.prev.url);
        S.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      }
      clearTimeout(qTimer);
      S = null;
      // Downloads started from this panel may still be reading their temp
      // file; give them a minute before the OPFS temp folder goes.
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(function () { cleanupTimer = null; if (!S) cleanupTemps(); }, 60000);
    };
    setTab(S.tab);
    renderExtract();
    renderEngines();
    // Warm up the worker so capability flags (OPFS / gzip) are known early.
    worker().then(function () { if (S && S.tab === 'create') renderCreate(); }, function () {});
  }

  Cade.registerWidget({
    name: 'Archive Utility',
    description: 'Open, extract & create ZIP, 7z, TAR/GZ (plus RAR, XZ, BZ2\u2026) with passwords \u2014 all on this device',
    icon: '\ud83d\udddc\ufe0f',
    tags: 'archive,zip,unzip,7z,7zip,rar,unrar,tar,tgz,gz,gzip,gunzip,bz2,xz,zst,zstd,iso,cab,compress,decompress,extract,password,encrypt,aes,files',
    open: open,
  });
})();
