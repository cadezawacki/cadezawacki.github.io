/* Decode Lab — translation inside the note (lazy). Loaded only when a
 * Translate chip (plugins/translate-blocks) is pressed or the "Translate to
 * English" palette script runs; exposes window.__cadeTrInline.
 *
 * Same engine as Decode Lab's Translate tab (decodelab-translate.js): Chrome's
 * built-in Translator where it has the language, otherwise Firefox
 * Translations (Bergamot) — whose one-time per-language model download only
 * starts after a tap that shows its size (chip: "Download 26 MB"; script: a
 * confirm dialog). The English goes into a ```English block directly below
 * the source (or below the selection / line); one that is already there is
 * replaced. One transaction per translation, so a single Undo removes it.
 *
 * Jobs run one at a time; their positions are mapped through edits. The
 * translation worker is freed after two idle minutes. decodelab-core.js +
 * data load only when a language has to be detected (no ```language given).
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined' || window.__cadeTrInline) return;
  var Cade = window.Cade, CM = Cade.CM || {};

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var SRC = (document.currentScript && document.currentScript.src) || '';
  var DL = /decodelab-inline\.js/.test(SRC) ? SRC.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') : abs('./txt/widgets/decodelab/');
  var TR_URL = DL + 'decodelab-translate.js';
  var TRW_URL = DL + 'decodelab-translate-worker.js?v=2'; // ?v= must match the manifest precache entry (and decodelab.js)
  var CORE_URL = DL + 'decodelab-core.js', DATA_URL = DL + 'decodelab-data.js';
  var IDLE_MS = 120000, CONSENT_MS = 120000;

  var R = window.__cadeTrInline = { version: 0 };

  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2800); } catch (e) {} }
  function fmtMB(n) { return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + ' MB'; }
  function roomKey() { try { var r = Cade.roomsApi && Cade.roomsApi.activeRoom(); return r ? String(r) : 'default'; } catch (e) { return 'default'; } }
  function startsFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }

  // ---- loading ---------------------------------------------------------------------
  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('Could not load ' + url.split('/').pop().split('?')[0] + ' (offline?)')); };
      document.head.appendChild(s);
    });
    return loads[url];
  }
  var M = null, mOpts = null, core = null;
  function T() { return window.__DecodeLabTranslate; }
  function manager() {
    if (M) return Promise.resolve(M);
    return (T() ? Promise.resolve() : load(TR_URL)).then(function () {
      if (!T()) throw new Error('The translator failed to load');
      if (!M) { mOpts = { workerUrl: TRW_URL, core: core }; M = T().create(mOpts); }
      return M;
    });
  }
  // Decode Lab's scorer helps tell Latin-script languages apart; only needed to detect.
  function withCore() {
    if (core) return Promise.resolve(core);
    return Promise.all([window.__DecodeLabCore ? 0 : load(CORE_URL), window.__decodeLabData ? 0 : load(DATA_URL)]).then(function () {
      if (!window.__DecodeLabCore || !window.__decodeLabData) throw new Error('Language detection failed to load');
      if (!core) { core = window.__DecodeLabCore(); core.setData(window.__decodeLabData); }
      if (mOpts) mOpts.core = core;
      return core;
    });
  }
  var idleT = 0;
  function scheduleIdle() {
    clearTimeout(idleT);
    idleT = setTimeout(function () { if (!jobs.length && M) M.dispose(); }, IDLE_MS); // frees the model (tens of MB)
  }

  // ---- state -------------------------------------------------------------------------
  var jobs = [];     // jobs[0] runs, the rest wait
  var consent = [];  // chips showing "Download N MB": {openFrom, info, code, st, doc, room, t}
  var nudgeT = 0;
  // State changed: re-render the chips (empty transaction; not allowed inside
  // an update, hence the timer) and the progress pill.
  function bump() {
    R.version++;
    renderPill();
    if (nudgeT) return;
    nudgeT = setTimeout(function () {
      nudgeT = 0;
      try { if (Cade.editor) Cade.editor.dispatch({}); } catch (e) {}
    }, 40);
  }
  Cade.onEditorUpdate(function (u) {
    if (!u.docChanged || (!jobs.length && !consent.length)) return;
    pruneConsent();
    var list = jobs.concat(consent);
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (j.doc !== u.startState.doc) continue;
      if (j.openFrom != null) j.openFrom = u.changes.mapPos(j.openFrom, 1);
      if (j.anchor != null) j.anchor = u.changes.mapPos(j.anchor, 1);
      j.doc = u.state.doc;
    }
    bump();
  });
  function sameSpot(j, openFrom) { return j.openFrom === openFrom && j.room === roomKey(); }
  function jobAt(openFrom) { for (var i = 0; i < jobs.length; i++) if (jobs[i].kind === 'fence' && sameSpot(jobs[i], openFrom)) return jobs[i]; return null; }
  // A "Download" offer lapses after two minutes (the chip goes back to "Translate").
  function pruneConsent() { var now = Date.now(); consent = consent.filter(function (c) { return now - c.t < CONSENT_MS; }); }
  function offerConsent(c) {
    consent.push(c);
    setTimeout(function () { pruneConsent(); bump(); }, CONSENT_MS + 50);
    bump();
  }
  function consentAt(openFrom) {
    pruneConsent();
    for (var i = 0; i < consent.length; i++) if (sameSpot(consent[i], openFrom)) return consent[i];
    return null;
  }
  function dropConsent(c) { var i = consent.indexOf(c); if (i >= 0) consent.splice(i, 1); }

  // Chip state for the fence opening at openFrom.
  R.statusAt = function (openFrom) {
    var j = jobAt(openFrom);
    if (j) return j === jobs[0] && j.started ? { state: 'busy', text: j.text } : { state: 'queued', text: 'Queued' };
    var c = consentAt(openFrom);
    if (c) return { state: 'consent', text: c.st.needs === 'download' ? 'Download ' + fmtMB(c.st.size) : 'Download model', title: consentTitle(c.code, c.st) };
    return null;
  };
  function consentTitle(code, st) {
    var name = T().langName(code);
    return st.needs === 'download'
      ? name + ' needs a one-time download of ' + fmtMB(st.size) + ' (' + st.label + '), kept on this device so it also works offline. Tap to download and translate.'
      : 'Chrome downloads its ' + name + ' model once (' + st.label + '). Tap to download and translate.';
  }
  function notAvailable(code, st) {
    var known = T().LANGS.some(function (L) { return L.code === code; });
    return ((st && st.why) || T().langName(code) + ' is not available for on-device translation') +
      (known ? '' : ' — on-device translation covers ' + T().LANGS.length + ' languages (Decode Lab → Translate lists them)');
  }

  // ---- fences in the live document -------------------------------------------------------
  function codeOf(info) { return info ? T().langFromName(info) : ''; }
  // The block whose opening fence starts at openFrom (its closing fence is the next ``` line).
  function blockFrom(doc, openFrom) {
    if (openFrom == null || openFrom < 0 || openFrom > doc.length) return null;
    var ln = doc.lineAt(openFrom);
    if (ln.from !== openFrom || !startsFence(ln.text)) return null;
    var close = null;
    for (var k = ln.number + 1; k <= doc.lines; k++) { var l = doc.line(k); if (startsFence(l.text)) { close = l; break; } }
    return { open: ln, close: close, info: ln.text.slice(3).trim() };
  }
  // The block containing pos (fence lines included) — scans from the top: palette runs only.
  function blockAt(doc, pos) {
    if (Cade.inCodeFence) { try { if (!Cade.inCodeFence(pos)) return null; } catch (e) {} }
    var n = doc.lineAt(pos).number, open = 0, closeAt = 0;
    var it = doc.iterLines ? doc.iterLines(1, n + 1) : null;
    for (var i = 1; i <= n; i++) {
      var t = it ? it.next().value : doc.line(i).text;
      if (!startsFence(t)) continue;
      if (!open) open = i;
      else if (i < n) open = 0;
      else closeAt = i;
    }
    if (!open) return null;
    var b = blockFrom(doc, doc.line(open).from);
    if (b && closeAt) b.close = doc.line(closeAt);
    return b;
  }
  function bodyOf(doc, b) {
    if (!b.close || b.close.number <= b.open.number + 1) return '';
    return doc.sliceString(doc.line(b.open.number + 1).from, doc.line(b.close.number - 1).to);
  }
  var EN_RE = /^```\s*english\s*$/i;
  // The ```English block right below line n (one blank line allowed).
  function englishAfter(doc, n) {
    var k = n + 1;
    if (k <= doc.lines && !doc.line(k).text.trim()) k++;
    if (k > doc.lines || !EN_RE.test(doc.line(k).text)) return null;
    for (var m = k + 1; m <= doc.lines; m++) if (startsFence(doc.line(m).text)) return { from: doc.line(k).from, to: doc.line(m).to };
    return null; // unclosed: leave it alone
  }
  function formatBlock(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    return '```English\n' + lines.map(function (l) { return startsFence(l) ? ' ' + l : l; }).join('\n') + '\n```';
  }
  function liveBlock(job) {
    var ed = Cade.editor;
    if (!ed || job.room !== roomKey() || job.doc !== ed.state.doc) return null;
    var b = blockFrom(ed.state.doc, job.openFrom);
    return b && b.info === job.info && b.close ? b : null;
  }
  // One transaction: the English block below the source, replacing an earlier one.
  function write(job, english) {
    var ed = Cade.editor;
    if (!ed) throw new Error('The editor is not ready');
    if (ed.state.readOnly) throw new Error('Read-only mode — the translation was not inserted');
    if (job.room !== roomKey() || job.doc !== ed.state.doc) throw new Error('The room changed — the translation was not inserted');
    var doc = ed.state.doc, at;
    if (job.kind === 'fence') {
      var b = liveBlock(job);
      if (!b) throw new Error('The block moved — the translation was not inserted');
      at = b.close.number;
    } else {
      if (job.anchor > doc.length) throw new Error('The text moved — the translation was not inserted');
      at = doc.lineAt(job.anchor).number;
    }
    var ex = englishAfter(doc, at), from = doc.line(at).to;
    var spec = { changes: { from: from, to: ex ? ex.to : from, insert: '\n' + formatBlock(english) }, userEvent: 'input.translate' };
    if (job.pill && CM.EditorView && CM.EditorView.scrollIntoView) spec.effects = CM.EditorView.scrollIntoView(from + 1, { y: 'nearest' });
    ed.dispatch(spec);
  }

  // ---- the queue ---------------------------------------------------------------------------
  var STAGE = { download: 'Downloading', engine: 'Starting engine…', model: 'Loading model…', translate: 'Translating' };
  function stage(job, st, f) {
    if (st === 'verify') st = 'download'; // per-file checksum: part of the download
    var s = STAGE[st] || 'Working…';
    job.text = (st === 'download' || st === 'translate') ? s + (f != null && f > 0 ? ' ' + Math.round(Math.min(1, f) * 100) + '%' : '…') : s;
    bump();
  }
  function needsError(st) { var e = new Error('needs a download'); e.needs = st; return e; }
  function enqueue(job) {
    var ed = Cade.editor;
    job.room = roomKey(); job.doc = ed.state.doc; job.text = 'Starting…'; job.started = false;
    var p = new Promise(function (res, rej) { job.resolve = res; job.reject = rej; });
    jobs.push(job);
    clearTimeout(idleT);
    bump();
    if (jobs.length === 1) pump();
    return p;
  }
  function pump() {
    var job = jobs[0];
    if (!job) { scheduleIdle(); return; }
    job.started = true; job.text = 'Checking…';
    bump();
    run(job).then(function (r) { finish(job, null, r); }, function (e) { finish(job, e); });
  }
  function finish(job, err, r) {
    var i = jobs.indexOf(job);
    if (i >= 0) jobs.splice(i, 1);
    if (job.cancelled) job.resolve({ cancelled: true });
    else if (err) job.reject(err);
    else job.resolve(r);
    bump();
    pump();
  }
  function run(job) {
    var m;
    var CANCEL = new Error('cancelled');
    return manager().then(function (x) { m = x; return m.status(job.code); }).then(function (st) {
      if (job.cancelled) throw CANCEL;
      if (st.ready) return st;
      if (!st.needs) throw new Error(notAvailable(job.code, st));
      if (!job.consented) throw needsError(st);
      job.consented = false;
      stage(job, 'download', 0);
      return m.download(job.code, function (f, s) { stage(job, s || 'download', f); }).then(function (s2) {
        if (!s2.ready) throw needsError(s2); // Chrome gave up: Firefox Translations needs its own download
        return s2;
      });
    }).then(function () {
      if (job.cancelled) throw CANCEL;
      var text = job.src;
      if (job.kind === 'fence') { var b = liveBlock(job); text = b ? bodyOf(Cade.editor.state.doc, b) : null; }
      if (text == null) throw new Error('The block moved or the room changed — nothing was translated');
      if (!text.trim()) throw new Error('Nothing to translate');
      stage(job, 'translate', 0);
      return m.translate(text, job.code, function (f, s) { stage(job, s, f); }).catch(function (e) {
        if (job.cancelled) throw CANCEL;
        // Chrome stalled mid-way and Firefox Translations isn't downloaded yet
        return m.status(job.code).then(function (st) { throw st.needs === 'download' ? needsError(st) : e; }, function () { throw e; });
      });
    }).then(function (res) {
      if (job.cancelled) throw CANCEL;
      write(job, res.text);
      return res;
    });
  }
  function cancel(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    if (job === jobs[0] && job.started) { if (M) M.dispose(); } // stops the worker / Chrome translator; run() then settles
    else { var i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); job.resolve({ cancelled: true }); }
    bump();
  }

  // ---- chips ---------------------------------------------------------------------------------
  function chipJob(openFrom, consented) {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
    if (jobAt(openFrom)) return;
    manager().then(function () {
      var b = blockFrom(ed.state.doc, openFrom), code = b ? codeOf(b.info) : '';
      if (!b || !code) { bump(); return; }
      if (!b.close) { toast('Close the block with a ``` line first', 'info'); bump(); return; }
      if (!bodyOf(ed.state.doc, b).trim()) { toast('This block is empty', 'info'); bump(); return; }
      var job = { kind: 'fence', openFrom: openFrom, info: b.info, code: code, consented: consented };
      return enqueue(job).then(function () {}, function (e) {
        if (e.needs) {
          // job.openFrom / job.doc have followed any edits made meanwhile
          offerConsent({ openFrom: job.openFrom, info: job.info, code: code, st: e.needs, doc: job.doc, room: job.room, t: Date.now() });
          toast(e.needs.needs === 'download'
            ? T().langName(code) + ' needs a one-time ' + fmtMB(e.needs.size) + ' download to translate on this device — tap “Download” on the block to start'
            : 'Chrome needs to download its ' + T().langName(code) + ' model once — tap “Download” on the block to start', 'info', 5000);
          return;
        }
        toast(e.message, 'error', 4500);
      });
    }).catch(function (e) { toast(e.message, 'error', 4000); bump(); });
  }
  R.pressAt = function (openFrom) {
    var c = consentAt(openFrom);
    if (c) { dropConsent(c); bump(); }
    chipJob(openFrom, false);
  };
  R.consentAt = function (openFrom) {
    var c = consentAt(openFrom);
    if (!c) { chipJob(openFrom, false); return; }
    dropConsent(c);
    chipJob(openFrom, true);
  };
  R.cancelAt = function (openFrom) {
    var c = consentAt(openFrom);
    if (c) { dropConsent(c); bump(); return; }
    var j = jobAt(openFrom);
    if (j) cancel(j);
  };

  // ---- palette script: selection / fenced block / line at the cursor ------------------------------
  function sourceAtCursor(st) {
    var doc = st.doc, sel = st.selection.main;
    if (!sel.empty) {
      var end = doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to; // selection ending in a line break
      var text = doc.sliceString(sel.from, sel.to).split('\n').filter(function (l) { return !startsFence(l); }).join('\n');
      if (!text.trim()) return { err: 'Nothing to translate in the selection' };
      var bFrom = blockAt(doc, sel.from), bEnd = blockAt(doc, end);
      if (bEnd && !bEnd.close) return { err: 'Close the ``` block first' };
      return { kind: 'range', src: text, code: bFrom ? codeOf(bFrom.info) : '', anchor: bEnd ? bEnd.close.to : doc.lineAt(end).to };
    }
    var b = blockAt(doc, sel.head);
    if (b) {
      if (!b.close) return { err: 'Close the ``` block first (a line with only ```)' };
      var body = bodyOf(doc, b);
      if (!body.trim()) return { err: 'This block is empty' };
      return { kind: 'fence', openFrom: b.open.from, info: b.info, code: codeOf(b.info), src: body };
    }
    var line = doc.lineAt(sel.head);
    if (!line.text.trim()) return { err: 'Select the text to translate — or put the cursor on a line, or in a ```Spanish block' };
    return { kind: 'range', src: line.text, code: '', anchor: line.to };
  }
  // -> {code} | null (cancelled)
  function detectCode(text) {
    return withCore().then(function () { return M.detect(text); }).then(function (d) {
      if (d.code && d.conf >= (d.via === 'chrome' ? 0.5 : 0.55)) return { code: d.code };
      var guess = d.code ? T().langName(d.code) : '';
      var ans = window.prompt('Which language is this? (a name like Spanish or Deutsch, or a code like ja)' + (guess ? '\nBest guess: ' + guess : ''), guess);
      if (ans == null || !ans.trim()) return null;
      var c = T().langFromName(ans);
      if (!c) throw new Error('“' + ans.trim() + '” isn’t a language name I know');
      return { code: c };
    });
  }
  function confirmDownload(code, st) {
    var name = T().langName(code);
    return window.confirm(st.needs === 'download'
      ? 'Translate from ' + name + ' on this device?\n\nThis needs a one-time download of ' + fmtMB(st.size) + ' (' + st.label + '). It stays on this device, so translation also works offline.'
      : 'Translate from ' + name + ' on this device?\n\nChrome will download its ' + name + ' model once (' + st.label + ').');
  }
  // Resolves when done or cancelled; rejects with a readable Error (the
  // palette shows it as the script's error).
  R.translateAtCursor = function () {
    var ed = Cade.editor;
    if (!ed) return Promise.reject(new Error('The editor is not ready'));
    if (ed.state.readOnly) return Promise.reject(new Error('Read-only mode — editing is locked'));
    var src;
    return manager().then(function () {
      src = sourceAtCursor(ed.state);
      if (src.err) throw new Error(src.err);
      if (src.kind === 'fence' && jobAt(src.openFrom)) throw new Error('This block is already being translated');
      return src.code ? { code: src.code } : detectCode(src.src);
    }).then(function (d) {
      if (!d) return null;
      if (d.code === 'en') throw new Error(src.code ? 'This block is already English' : 'This already looks like English');
      src.code = d.code;
      return M.status(d.code).then(function (st) {
        if (st.ready) return go(false);
        if (!st.needs) throw new Error(notAvailable(d.code, st));
        return confirmDownload(d.code, st) ? go(true) : null;
      });
    });
    function go(consented) {
      var job = { kind: src.kind, openFrom: src.openFrom, info: src.info, anchor: src.anchor, src: src.src, code: src.code, consented: consented, pill: true };
      return enqueue(job).then(function (r) {
        if (r && !r.cancelled) pillDone(T().langName(job.code) + ' → English' + (r.label ? ' · ' + r.label : ''));
        return r;
      }, function (e) {
        if (e.needs && confirmDownload(job.code, e.needs)) return go(true);
        if (e.needs) return null;
        throw e;
      });
    }
  };

  // ---- progress pill (palette runs: there may be no chip to show it) ------------------------------
  var pill = null, doneT = 0;
  function pillEl() {
    if (pill) return pill;
    if (!document.getElementById('cade-trpill-css')) {
      var css = document.createElement('style');
      css.id = 'cade-trpill-css';
      css.textContent =
        '.cade-trpill{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 84px);transform:translateX(-50%);z-index:450;' +
        'display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:6px 6px 6px 12px;border-radius:999px;' +
        'background:var(--surface);color:var(--text);border:1px solid var(--accent);box-shadow:var(--shadow-md,0 4px 14px rgba(0,0,0,.18));' +
        'font:500 12px/1.2 var(--font-body,-apple-system,sans-serif);-webkit-user-select:none;user-select:none}' +
        '.cade-trpill[hidden]{display:none}' +
        '.cade-trpill-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.cade-trpill-spin{width:10px;height:10px;flex:0 0 auto;border-radius:50%;border:1.5px solid var(--accent);border-right-color:transparent;animation:cade-trpill-spin .8s linear infinite}' +
        '.cade-trpill.done{border-color:var(--success,#16a34a);padding-right:12px}.cade-trpill.done .cade-trpill-spin,.cade-trpill.done button{display:none}' +
        '.cade-trpill button{flex:0 0 auto;border:1px solid var(--border);background:var(--surface-2,transparent);color:var(--text-muted);border-radius:999px;padding:3px 10px;font:inherit;cursor:pointer}' +
        '.cade-trpill button:hover{color:var(--error,#dc2626);border-color:var(--error,#dc2626)}' +
        '@keyframes cade-trpill-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(css);
    }
    pill = document.createElement('div');
    pill.className = 'cade-trpill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.hidden = true;
    pill.innerHTML = '<span class="cade-trpill-spin" aria-hidden="true"></span><span class="cade-trpill-t"></span><button type="button">Stop</button>';
    pill.querySelector('button').addEventListener('click', function () { jobs.filter(function (j) { return j.pill; }).forEach(cancel); });
    document.body.appendChild(pill);
    return pill;
  }
  function renderPill() {
    var j = null;
    for (var i = 0; i < jobs.length; i++) if (jobs[i].pill && !jobs[i].cancelled) { j = jobs[i]; break; }
    if (!j) { if (pill && !pill.classList.contains('done')) pill.hidden = true; return; }
    var el = pillEl();
    clearTimeout(doneT);
    el.classList.remove('done');
    el.hidden = false;
    el.querySelector('.cade-trpill-t').textContent = (T() ? T().langName(j.code) + ' → English · ' : '') + (j === jobs[0] && j.started ? j.text : 'Queued');
  }
  function pillDone(text) {
    var el = pillEl();
    el.classList.add('done');
    el.hidden = false;
    el.querySelector('.cade-trpill-t').textContent = '✓ ' + text;
    clearTimeout(doneT);
    doneT = setTimeout(function () { el.classList.remove('done'); renderPill(); if (!jobs.some(function (j) { return j.pill; })) el.hidden = true; }, 2200);
  }

  // for tests / other modules
  R._formatBlock = formatBlock;
})();
