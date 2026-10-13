/* Translate — on-device translation, both ways: into English, out of English,
 * and between two other languages (through English, as Firefox does). Type or
 * paste, or open it with text selected in the editor.
 *
 * The engine is Decode Lab's (widgets/decodelab/decodelab-translate.js +
 * its worker): Chrome's built-in Translator where it has the pair, otherwise
 * Firefox Translations (Bergamot, WebAssembly) with Mozilla's models — one
 * per direction (Spanish → English and English → Spanish are two downloads),
 * served from this site's own mirrors and SHA-256-checked. Nothing downloads
 * until a tap that shows the size; once a pair is on the device it translates
 * as you type, offline. Language detection: Chrome's detector where present,
 * otherwise Decode Lab's scorer (decodelab-core.js + data, loaded on first
 * use of Auto-detect).
 *
 * Memory: the worker (engine + one model, two while pivoting) is freed when
 * the panel closes and after three idle minutes. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('translate.css');

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var DL = abs(Cade.asset('../decodelab/'));
  var TR_URL = DL + 'decodelab-translate.js';
  var TRW_URL = DL + 'decodelab-translate-worker.js?v=3'; // ?v= must match the manifest precache entry (and decodelab.js)
  var CORE_URL = DL + 'decodelab-core.js', DATA_URL = DL + 'decodelab-data.js';
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'translate-panel';
  var PREFS_KEY = 'cade-translate-prefs';
  var IDLE_MS = 180000;       // free the worker after 3 idle minutes
  var AUTO_MAX = 5000;        // translate as you type up to this many characters
  var MAX_TEXT = 200000;

  var prefs = { from: 'auto', to: 'en', other: 'es', live: true };
  var TR = null, trP = null, core = null, coreP = null, mOpts = null, P = null, lastText = '';

  function loadPrefs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); if (p) for (var k in prefs) if (p[k] !== undefined) prefs[k] = p[k]; } catch (e) {}
    prefs.live = prefs.live !== false;
  }
  function savePrefs() { try { Cade.store.set(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function fmtMB(n) { return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + ' MB'; }
  function q(sel) { return P ? P.el.querySelector(sel) : null; }

  // ---- loading -------------------------------------------------------------------------
  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('Could not load ' + url.split('/').pop().split('?')[0] + (navigator.onLine ? '' : ' — it needs one online load to cache'))); };
      document.head.appendChild(s);
    });
    return loads[url];
  }
  function T() { return window.__DecodeLabTranslate; }
  function loadTr() {
    if (TR) return Promise.resolve(TR);
    if (trP) return trP;
    trP = (T() ? Promise.resolve() : load(TR_URL)).then(function () {
      if (!T()) throw new Error('The translator failed to load');
      mOpts = { workerUrl: TRW_URL, core: core };
      TR = T().create(mOpts);
      return TR;
    });
    trP.catch(function () { trP = null; });
    return trP;
  }
  // Decode Lab's scorer tells Latin-script languages apart; only needed to detect.
  function withCore() {
    if (core) return Promise.resolve(core);
    if (coreP) return coreP;
    coreP = Promise.all([window.__DecodeLabCore ? 0 : load(CORE_URL), window.__decodeLabData ? 0 : load(DATA_URL)]).then(function () {
      if (!window.__DecodeLabCore || !window.__decodeLabData) throw new Error('Language detection failed to load');
      core = window.__DecodeLabCore(); core.setData(window.__decodeLabData);
      if (mOpts) mOpts.core = core;
      return core;
    });
    coreP.catch(function () { coreP = null; });
    return coreP;
  }

  // ---- languages -------------------------------------------------------------------------
  function langs() { return T().LANGS.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }); }
  function name(c) { return c === 'auto' ? 'Auto-detect' : T().langName(c); }
  function options(sel, withAuto) {
    var h = withAuto ? '<option value="auto">Auto-detect</option>' : '';
    h += '<option value="en">English</option>';
    langs().forEach(function (L) { h += '<option value="' + L.code + '">' + esc(L.name) + '</option>'; });
    return h;
  }
  var SPEAK = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en-US' };
  function bcp(c) { return SPEAK[c] || c; }
  var RTL = { ar: 1, fa: 1, he: 1 };

  // ---- panel -------------------------------------------------------------------------------
  function selectionText() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      return sel.empty ? '' : ed.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_TEXT));
    } catch (e) { return ''; }
  }
  var ICON_SWAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById(PANEL_ID);
    var sel = selectionText();
    if (existing) {
      if (P && sel.trim() && P.el === existing) { P.src.value = sel; onText(true); }
      else { var ta = existing.querySelector('.tw-src'); if (ta) ta.focus(); }
      return;
    }
    loadPrefs();
    var el = Cade.mkPanel(PANEL_ID, '🌐 Translate',
      '<div class="tw-langs">' +
        '<select class="tw-from" aria-label="Translate from"><option>Auto-detect</option></select>' +
        '<button class="tw-swap" title="Swap languages (and texts)" aria-label="Swap languages">' + ICON_SWAP + '</button>' +
        '<select class="tw-to" aria-label="Translate to"><option>English</option></select>' +
      '</div>' +
      '<div class="tw-box">' +
        '<textarea class="tw-src" rows="4" dir="auto" placeholder="Type or paste text — or select text in the editor before opening" spellcheck="false" aria-label="Text to translate"></textarea>' +
        '<div class="tw-srcbar"><span class="tw-det" aria-live="polite"></span><span class="tw-sp"></span>' +
          '<button class="tw-ibtn tw-sel" title="Use the editor selection">⇣ Sel</button>' +
          '<button class="tw-ibtn tw-clear" title="Clear" aria-label="Clear">⌫</button></div>' +
      '</div>' +
      '<div class="tw-act">' +
        '<button class="tw-btn primary tw-go" title="Translate (Ctrl/⌘+Enter)">Translate</button>' +
        '<button class="tw-btn tw-stop" hidden>■ Stop</button>' +
        '<span class="tw-status" aria-live="polite"></span>' +
      '</div>' +
      '<div class="tw-prog" hidden><i></i></div>' +
      '<div class="tw-box tw-outbox">' +
        '<div class="tw-out" dir="auto" aria-live="polite" aria-label="Translation"></div>' +
        '<div class="tw-outbar"><span class="tw-via"></span><span class="tw-sp"></span>' +
          '<button class="tw-ibtn tw-speak" title="Listen" aria-label="Listen" hidden>🔊</button>' +
          '<button class="tw-ibtn tw-copy" title="Copy the translation">Copy</button>' +
          '<button class="tw-ibtn tw-insert" title="Insert at the cursor in the note (replaces the selection)">Insert</button></div>' +
      '</div>' +
      '<label class="tw-live"><input type="checkbox" class="tw-live-cb"> Translate as I type <small>(once a pair is on this device)</small></label>' +
      '<details class="tw-mgr"><summary>Languages on this device <span class="tw-sum"></span></summary>' +
        '<div class="tw-mgr-body"><div class="tw-note">Checking…</div></div></details>');

    P = {
      el: el, src: el.querySelector('.tw-src'), outEl: el.querySelector('.tw-out'),
      det: null, detFor: null, res: null, err: '', busy: false, again: false, seq: 0, st: null,
      tText: 0, tIdle: 0, dl: {}, dlErr: {}, flipped: '',
    };
    var st = P;
    el.querySelector('.tw-live-cb').checked = prefs.live;
    if ('speechSynthesis' in window) el.querySelector('.tw-speak').hidden = false;
    else el.querySelector('.tw-speak').remove();
    P.src.value = sel.trim() ? sel : lastText;
    bind(el, st);
    renderOut();
    el._onClose = function () { teardown(st); };
    el.addEventListener('cade-panel-minimize', function () { stopSpeech(); });

    setStatus('Loading the translator…');
    loadTr().then(function () {
      if (P !== st) return;
      el.querySelector('.tw-from').innerHTML = options(prefs.from, true);
      el.querySelector('.tw-to').innerHTML = options(prefs.to, false);
      if (prefs.from !== 'auto' && !validCode(prefs.from)) prefs.from = 'auto';
      if (!validCode(prefs.to)) prefs.to = 'en';
      syncSelects();
      setStatus('');
      summary();
      onText(true);
    }, function (e) { if (P === st) setStatus(e.message); });
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) setTimeout(function () { if (P === st) P.src.focus(); }, 0);
  }
  function validCode(c) { return c === 'en' || T().LANGS.some(function (L) { return L.code === c; }); }
  function syncSelects() {
    var f = q('.tw-from'), t = q('.tw-to');
    if (f) f.value = prefs.from;
    if (t) t.value = P.flipped || prefs.to;
    applyDir();
  }
  function teardown(st) {
    if (P !== st) return;
    lastText = P.src.value.length <= 20000 ? P.src.value : '';
    clearTimeout(P.tText); clearTimeout(P.tIdle);
    stopSpeech();
    if (TR) { TR.dispose(); TR = null; trP = null; } // terminates the worker, frees the models
    P = null;
  }
  function close() { var el = document.getElementById(PANEL_ID); if (el) { el.remove(); if (el._onClose) el._onClose(); } }

  function bind(el, st) {
    P.src.addEventListener('input', function () { if (P === st) { markStale(); onText(false); } });
    P.src.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(true); }
    });
    el.querySelector('.tw-from').addEventListener('change', function (e) {
      prefs.from = e.target.value; P.flipped = ''; savePrefs(); onText(true);
    });
    el.querySelector('.tw-to').addEventListener('change', function (e) {
      prefs.to = e.target.value; P.flipped = '';
      if (prefs.to !== 'en') prefs.other = prefs.to;
      savePrefs(); onText(true);
    });
    el.querySelector('.tw-live-cb').addEventListener('change', function (e) { prefs.live = e.target.checked; savePrefs(); if (prefs.live) onText(true); });
    el.querySelector('.tw-mgr').addEventListener('toggle', function (e) { if (e.target.open) renderMgr(); });
    el.addEventListener('click', function (e) {
      var t = e.target, b;
      if (!t || !t.closest || P !== st) return;
      if (t.closest('.tw-go')) run(true);
      else if (t.closest('.tw-stop')) stop();
      else if (t.closest('.tw-swap')) swap();
      else if (t.closest('.tw-sel')) { var s = selectionText(); if (!s.trim()) { toast('Select some text in the editor first'); return; } P.src.value = s; onText(true); }
      else if (t.closest('.tw-clear')) { P.src.value = ''; onText(true); P.src.focus(); }
      else if (t.closest('.tw-copy')) { if (P.res) copyText(P.res.text); }
      else if (t.closest('.tw-insert')) { if (P.res) insertText(P.res.text); }
      else if (t.closest('.tw-speak')) speak();
      else if ((b = t.closest('[data-dl]'))) dlModel(b.getAttribute('data-code'), b.getAttribute('data-dl'));
      else if ((b = t.closest('[data-rm]'))) rmModel(b.getAttribute('data-code'), b.getAttribute('data-rm'));
      else if (t.closest('.tw-rmall')) rmAll();
    });
  }

  // ---- the pair in effect --------------------------------------------------------------------
  function curFrom() { return prefs.from === 'auto' ? (P.det && P.det.code) || '' : prefs.from; }
  function curTo() { return P.flipped || prefs.to; }
  function applyDir() {
    if (!P) return;
    var f = curFrom(), t = curTo();
    P.src.setAttribute('dir', RTL[f] ? 'rtl' : 'auto');
    P.outEl.setAttribute('dir', RTL[t] ? 'rtl' : 'auto');
  }

  // Text changed (or a language): detect, then translate when the pair is ready.
  function onText(now) {
    if (!P) return;
    P.err = '';
    clearTimeout(P.tText);
    var st = P;
    if (now) step(st);
    else P.tText = setTimeout(function () { step(st); }, 450);
  }
  function step(st) {
    if (P !== st || !TR) return;
    var text = P.src.value;
    if (!text.trim()) { P.det = null; P.flipped = ''; syncSelects(); P.res = null; P.err = ''; renderOut(); setDet(''); updateStatus(); return; }
    detect(text).then(function () {
      if (P !== st) return;
      // Typing in the target language (Auto-detect): translate the other way.
      var f = curFrom();
      var want = prefs.to;
      P.flipped = prefs.from === 'auto' && f && f === want ? (want === 'en' ? prefs.other || 'es' : 'en') : '';
      syncSelects();
      updateStatus(prefs.live);
    });
  }
  function detect(text) {
    if (prefs.from !== 'auto') { P.det = null; setDet(''); return Promise.resolve(); }
    var key = text.slice(0, 600), st = P;
    if (P.detFor === key) return Promise.resolve();
    var go = function () {
      return TR.detect(text).then(function (d) {
        if (P !== st) return;
        P.detFor = key;
        P.det = d && d.code && d.conf >= 0.3 ? d : null;
        setDet(P.det ? 'Detected: ' + name(P.det.code) + (P.det.conf ? ' (' + Math.round(P.det.conf * 100) + '%)' : '') : 'Language not recognised — pick it above');
      });
    };
    // Latin-script languages need Decode Lab's scorer (Chrome's detector covers them on desktop)
    return (core || TR.hasChrome && 'LanguageDetector' in self ? go() : withCore().then(go, go));
  }
  function setDet(s) { var d = q('.tw-det'); if (d) d.textContent = s; }
  function setStatus(s) { var d = q('.tw-status'); if (d) d.textContent = s; }

  // Button + status for the current pair; translates when ready and `auto`.
  function updateStatus(auto) {
    if (!P || !TR || P.busy) { if (P && P.busy && auto) P.again = true; return; }
    var st = P, go = q('.tw-go'), text = P.src.value, f = curFrom(), t = curTo();
    markStale();
    if (!text.trim()) { go.textContent = 'Translate'; go.disabled = true; setStatus(''); return; }
    if (!f) { go.textContent = 'Translate'; go.disabled = true; setStatus('Pick the language of the text'); return; }
    if (f === t) { go.textContent = 'Translate'; go.disabled = true; setStatus('Already ' + name(t) + (prefs.from === 'auto' ? '' : ' — pick another language')); P.res = null; renderOut(); return; }
    TR.status(f, t).then(function (s) {
      if (P !== st || P.busy) return;
      P.st = s;
      go.disabled = !s.ready && !s.needs;
      var note = P.flipped ? name(f) + ' detected — translating to ' + name(t) + '. ' : '';
      // a failed attempt stays on screen until the text or the languages change
      var say = function (msg) { setStatus(P.err ? '⚠ ' + P.err : note + msg); };
      if (s.ready) {
        go.textContent = 'Translate';
        say('✓ ' + s.label);
        if (auto && !P.err && text.length <= AUTO_MAX) run(false);
      } else if (s.needs === 'download') {
        go.textContent = 'Download ' + fmtMB(s.size) + ' & translate';
        say(T().pairName(f, t) + ' needs a one-time download of ' + fmtMB(s.size) + (s.route && s.route.length > 1 ? ' (both halves: ' + name(f) + ' → English → ' + name(t) + ')' : '') + ' — kept on this device for offline use');
      } else if (s.needs === 'chrome-download') {
        go.textContent = 'Download & translate';
        say('Chrome will download its ' + T().pairName(f, t) + ' model once');
      } else { go.textContent = 'Translate'; setStatus(s.why || 'Not available'); }
    });
  }

  // ---- translating ----------------------------------------------------------------------------
  var STAGE = { download: 'Downloading… ', verify: 'Verifying… ', engine: 'Starting the engine… ', model: 'Loading the model… ', translate: 'Translating… ' };
  function progress(f, stage) {
    var bar = q('.tw-prog');
    if (!bar) return;
    bar.hidden = f == null;
    if (f != null) bar.querySelector('i').style.width = Math.round(Math.max(0.02, Math.min(1, f)) * 100) + '%';
    if (stage) setStatus((STAGE[stage] || '') + (f != null && stage !== 'engine' && stage !== 'model' ? Math.round(f * 100) + '%' : ''));
  }
  function setBusy(b) {
    P.busy = b;
    q('.tw-go').hidden = b; q('.tw-stop').hidden = !b;
  }
  // consent: a tap — may download; otherwise only translate a ready pair
  function run(consent) {
    if (!P || !TR) return;
    if (P.busy) { P.again = true; return; }
    var st = P, text = P.src.value, f = curFrom(), t = curTo(), seq = ++P.seq;
    if (!text.trim()) { if (consent) toast('Nothing to translate'); return; }
    if (!f) { if (consent) toast('Pick the language of the text'); return; }
    if (f === t) return;
    if (text.length > MAX_TEXT) { toast('That is too long — translate up to ' + (MAX_TEXT / 1000) + 'k characters at a time', 'error', 3000); return; }
    clearTimeout(P.tIdle);
    P.err = '';
    setBusy(true);
    var quiet = !consent; // live translation: no flashing progress for quick runs
    P.showProg = !quiet;
    var showT = quiet ? setTimeout(function () { if (P === st && P.busy) { P.showProg = true; progress(0, 'translate'); } }, 400) : 0;
    if (!quiet) progress(0, 'translate');
    TR.status(f, t).then(function (s) {
      if (s.ready) return s;
      if (!consent || !s.needs) throw new Error(s.why || 'not downloaded');
      progress(0, 'download');
      return TR.download(f, function (x, stage) { if (P === st) progress(x, stage); }, t).then(function (s2) { if (P === st) refreshMgr(); return s2; });
    }).then(function () {
      return TR.translate(text, f, function (x, stage) { if (P === st && P.showProg) progress(x, stage); }, t);
    }).then(function (res) {
      clearTimeout(showT);
      if (P !== st) return;
      setBusy(false); progress(null);
      if (seq === P.seq) { res.src = text; P.res = res; P.err = ''; renderOut(); }
      idle();
      if (P.again || P.src.value !== text || curFrom() !== f || curTo() !== t) { P.again = false; updateStatus(true); }
      else updateStatus(false);
    }, function (e) {
      clearTimeout(showT);
      if (P !== st) return;
      setBusy(false); progress(null);
      P.err = /cancelled/.test(e.message) ? '' : e.message;
      if (P.err) { P.res = null; renderOut(); }
      P.again = false;
      updateStatus(false);
    });
  }
  function stop() {
    if (!P || !P.busy || !TR) return;
    TR.dispose(); // rejects the running request ('cancelled'); the next one starts a fresh worker
    toast('Stopped', 'info', 1200);
  }
  function idle() {
    clearTimeout(P.tIdle);
    var st = P;
    P.tIdle = setTimeout(function () { if (P === st && !P.busy && TR) TR.dispose(); }, IDLE_MS);
  }
  function renderOut() {
    var o = P.res, box = P.outEl;
    box.classList.toggle('empty', !o);
    box.textContent = o ? o.text : '';
    var via = q('.tw-via');
    if (via) via.textContent = o ? name(o.from) + ' → ' + name(o.to) + (o.engine === 'chrome' ? ' · Chrome' : '') : '';
    markStale();
    ['.tw-copy', '.tw-insert', '.tw-speak'].forEach(function (s) { var b = q(s); if (b) b.disabled = !o; });
    stopSpeech();
  }
  // The output no longer matches the text / languages: dim it until re-translated.
  function markStale() {
    if (!P) return;
    var o = P.res;
    P.outEl.classList.toggle('stale', !!o && (o.src !== P.src.value || o.from !== curFrom() || o.to !== curTo()));
  }
  function swap() {
    if (!P || !TR) return;
    var f = curFrom(), t = curTo();
    if (!f) { toast('Pick the language of the text first'); return; }
    prefs.from = t; prefs.to = f; P.flipped = '';
    if (f !== 'en') prefs.other = f;
    savePrefs();
    if (P.res && P.res.text) P.src.value = P.res.text;
    P.res = null; P.det = null; P.detFor = null;
    syncSelects(); renderOut();
    onText(true);
  }

  // ---- output actions ---------------------------------------------------------------------------
  function copyText(text) {
    var done = function () { toast('Copied', 'success', 1200); };
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
    toast('Inserted', 'success', 1200);
  }
  function speak() {
    if (!P || !P.res || !('speechSynthesis' in window)) return;
    var ss = window.speechSynthesis;
    if (ss.speaking) { stopSpeech(); return; }
    try {
      var u = new SpeechSynthesisUtterance(P.res.text.slice(0, 4000));
      u.lang = bcp(P.res.to);
      var v = (ss.getVoices() || []).filter(function (x) { return x.lang && x.lang.replace('_', '-').toLowerCase().indexOf(bcp(P.res.to).toLowerCase().split('-')[0]) === 0; })[0];
      if (v) u.voice = v;
      else toast('No ' + name(P.res.to) + ' voice on this device — it may read it with another voice', 'info', 2600);
      var b = q('.tw-speak');
      if (b) b.classList.add('on');
      u.onend = u.onerror = function () { var bb = q('.tw-speak'); if (bb) bb.classList.remove('on'); };
      ss.speak(u);
    } catch (e) { toast('Speech is unavailable', 'error'); }
  }
  function stopSpeech() {
    try { if ('speechSynthesis' in window && window.speechSynthesis.speaking) window.speechSynthesis.cancel(); } catch (e) {}
    var b = q('.tw-speak'); if (b) b.classList.remove('on');
  }

  // ---- languages on this device -------------------------------------------------------------------
  function refreshMgr() { var d = q('.tw-mgr'); if (d && d.open) renderMgr(); else summary(); }
  function summary() {
    if (!P || !TR) return;
    var st = P;
    Promise.all([TR.downloaded(), TR.usage()]).then(function (r) {
      if (P !== st) return;
      var n = Object.keys(r[0]).filter(function (k) { return k[0] !== '_'; }).length + Object.keys(r[0]._to).length;
      var s = q('.tw-sum'); if (s) s.textContent = n ? '· ' + n + ' model' + (n === 1 ? '' : 's') + ' · ' + fmtMB(r[1]) : '';
    });
  }
  function pill(L, dir, have) {
    var key = dir === 'from' ? L.code + '>en' : 'en>' + L.code, m = dir === 'from' ? L : L.to;
    var label = dir === 'from' ? L.name + ' → English' : 'English → ' + L.name + (m.pre ? ' (preview model)' : '');
    var prog = P.dl[key], err = P.dlErr[key];
    if (prog != null) return '<span class="tw-pill busy" title="Downloading ' + esc(label) + '">' + Math.round(prog * 100) + '%</span>';
    if (have) return '<button class="tw-pill have" data-rm="' + dir + '" data-code="' + L.code + '" title="Remove ' + esc(label) + ' (' + fmtMB(m.size) + ')">✓<span aria-hidden="true">✕</span></button>';
    return '<button class="tw-pill' + (err ? ' err' : '') + '" data-dl="' + dir + '" data-code="' + L.code + '" title="' + esc(err ? '⚠ ' + err : 'Download ' + label) + '"' + (TR.simd && TR.storage ? '' : ' disabled') + '>' + (err ? '⚠ ' : '↓ ') + fmtMB(m.size) + '</button>';
  }
  function renderMgr() {
    if (!P || !TR) return;
    var st = P, body = q('.tw-mgr-body');
    if (!body) return;
    Promise.all([TR.downloaded(), TR.usage()]).then(function (r) {
      if (P !== st) return;
      var have = r[0], used = r[1], n = 0;
      // languages with something on the device first
      var list = langs(), mine = list.filter(function (L) { return have[L.code] || have._to[L.code]; });
      list = mine.concat(list.filter(function (L) { return mine.indexOf(L) < 0; }));
      var rows = list.map(function (L) {
        if (have[L.code]) n++;
        if (have._to[L.code]) n++;
        return '<div class="tw-lrow"><span class="tw-lname">' + esc(L.name) + ' <small>' + esc(L.native) + '</small></span>' +
          pill(L, 'from', have[L.code]) + pill(L, 'to', have._to[L.code]) + '</div>';
      }).join('');
      body.innerHTML =
        '<p class="tw-note">Translation runs on this device' + (TR.hasChrome ? ': Chrome\'s built-in translator where it has the pair, otherwise ' : ', with ') +
          'the Firefox Translations engine (' + fmtMB(TR.engineSize) + ', downloaded once) and one model per direction. Between two other languages the text goes through English, so it needs both halves. Nothing downloads until you tap.' +
          (TR.simd ? '' : ' <b>This browser lacks WebAssembly SIMD — the Firefox engine needs iOS/Safari 16.4+ or a recent Chrome/Firefox.</b>') + '</p>' +
        '<div class="tw-lsum">' + n + ' model' + (n === 1 ? '' : 's') + ' · ' + fmtMB(used) + ' used' + (have._engine ? ' (incl. ' + fmtMB(TR.engineSize) + ' engine)' : '') +
          (used ? ' <button class="tw-ibtn tw-rmall">Remove all</button>' : '') + '</div>' +
        '<div class="tw-lhead"><span></span><span>→ English</span><span>English →</span></div>' + rows;
      var s = q('.tw-sum'); if (s) s.textContent = n ? '· ' + n + ' model' + (n === 1 ? '' : 's') + ' · ' + fmtMB(used) : '';
    });
  }
  function dlModel(code, dir) {
    var st = P, key = dir === 'from' ? code + '>en' : 'en>' + code;
    var from = dir === 'from' ? code : 'en', to = dir === 'from' ? 'en' : code;
    P.dl[key] = 0; delete P.dlErr[key];
    renderMgr();
    var last = 0;
    TR.download(from, function (f) {
      if (P !== st) return;
      P.dl[key] = f;
      var now = Date.now();
      if (now - last > 250) { last = now; renderMgr(); }
    }, to, [key]).then(function () {
      if (P !== st) return;
      delete P.dl[key]; P.err = ''; renderMgr(); updateStatus(false);
      toast(T().pairName(from, to) + ' is ready offline', 'success', 1600);
    }, function (e) {
      if (P !== st) return;
      delete P.dl[key]; P.dlErr[key] = e.message; renderMgr();
      toast(e.message, 'error', 3200);
    });
  }
  function rmModel(code, dir) {
    var st = P;
    TR.remove(code, dir).then(function () { if (P === st) { P.err = ''; renderMgr(); updateStatus(false); } });
  }
  function rmAll() {
    if (!window.confirm('Remove every translation model and the engine from this device?')) return;
    var st = P;
    TR.removeAll().then(function () { if (P === st) { P.err = ''; renderMgr(); updateStatus(false); } });
  }

  Cade.registerWidget({
    name: 'Translate',
    description: 'Translate on this device, both ways — into English, from English, or between two languages; offline once a language is downloaded',
    icon: '🌐',
    tags: 'translate,translation,translator,translate to english,translate from english,english to spanish,spanish to english,language,languages,offline translation,on-device,detect language,foreign language,interpreter,spanish,french,german,italian,portuguese,dutch,russian,ukrainian,polish,turkish,chinese,japanese,korean,arabic,hindi,greek,swedish,vietnamese,thai',
    open: open,
    close: close,
  });
})();
