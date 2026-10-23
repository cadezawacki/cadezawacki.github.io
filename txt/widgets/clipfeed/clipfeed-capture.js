/* Clipboard feed — capture plugin ("Share copies to my Clipboard feed").
 *
 * While the setting is on, text copied or cut in the app (document copy / cut
 * events) and text the app's own Copy buttons put on the clipboard
 * (navigator.clipboard.writeText, wrapped while enabled) goes into the
 * Clipboard feed — the synced one when Sync is set up, else this device's.
 * Skipped: empty / whitespace-only text, password fields, the Clipboard
 * widget's own tap-to-copy (guard flag window.__cadeClipfeedOwn), copies made
 * in the Clipboard and Password Generator panels, and an immediate repeat.
 * Bursts are debounced (600 ms: only the last copy of a burst is kept).
 *
 * Optional (second setting, "Pop up copies from my other devices"): while the
 * app is visible and Sync is set up, an item arriving from ANOTHER device shows
 * a small chip for 8 s — tap it to copy. One limitToLast(1) listener, attached
 * only while the page is visible; its initial replay is ignored.
 *
 * Cost: this file is all that loads at boot. Its listeners live only while the
 * editor extension is active (ViewPlugin with a refcount — turning the setting
 * off removes the extension, which stops everything and unwraps writeText).
 * The feed model (clipfeed-model.js) loads on the first real copy. */
(function () {
  'use strict';

  // ---- pure core (node-testable; see clipfeed.test.js) ---------------------------------
  // env: { setTimeout, clearTimeout, now(), sink(text), delay?, repeatMs? }
  function makeCapturer(env) {
    var pending = null, timer = 0, last = null, lastAt = 0;
    var DELAY = env.delay == null ? 600 : env.delay, REPEAT = env.repeatMs == null ? 60000 : env.repeatMs;
    function now() { return env.now ? env.now() : Date.now(); }
    function fire() {
      timer = 0;
      var t = pending;
      pending = null;
      if (t == null) return false;
      if (t === last && now() - lastAt < REPEAT) return false;   // the same copy again (the feed dedupes later ones too)
      last = t; lastAt = now();
      try { env.sink(t); } catch (e) {}
      return true;
    }
    return {
      push: function (text) {
        if (typeof text !== 'string' || !/\S/.test(text)) return false;
        pending = text;
        if (timer) env.clearTimeout(timer);
        timer = env.setTimeout(fire, DELAY);
        return true;
      },
      flush: function () { if (timer) env.clearTimeout(timer); return fire(); },
      cancel: function () { if (timer) env.clearTimeout(timer); timer = 0; pending = null; },
      busy: function () { return !!timer; },
    };
  }
  // Which text a copy event copied. info: { data (clipboardData set by a handler,
  // e.g. CodeMirror), field: { type, value, start, end } (input / textarea),
  // editor (CodeMirror selection), sel (window selection) }.
  function pickCopyText(info) {
    info = info || {};
    if (info.field) {
      if (/^password$/i.test(info.field.type || '')) return '';
      if (info.data) return String(info.data);
      var v = String(info.field.value == null ? '' : info.field.value), s = info.field.start, e = info.field.end;
      if (typeof s === 'number' && typeof e === 'number' && e > s) return v.slice(s, e);
      return '';
    }
    if (info.data) return String(info.data);
    if (info.editor) return String(info.editor);
    return info.sel ? String(info.sel) : '';
  }
  var api = { makeCapturer: makeCapturer, pickCopyText: pickCopyText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.ViewPlugin) return;
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var MODEL_URL = abs(Cade.asset('clipfeed-model.js'));   // resolved now, while the module context is ours
  var SKIP = '#clipfeed-panel, #passgen-panel';
  var CHIP_MS = 8000;

  function loadModel() {
    if (window.__cadeClipfeed) return Promise.resolve(window.__cadeClipfeed);
    if (window.__cadeClipfeedLoading) return window.__cadeClipfeedLoading;
    var p = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = MODEL_URL;
      s.async = true;
      s.onload = function () { if (window.__cadeClipfeed) res(window.__cadeClipfeed); else rej(new Error('Clipboard feed did not load')); };
      s.onerror = function () { rej(new Error('Could not load the Clipboard feed')); };
      document.head.appendChild(s);
    });
    window.__cadeClipfeedLoading = p;
    p.catch(function () { if (window.__cadeClipfeedLoading === p) window.__cadeClipfeedLoading = null; });
    return p;
  }
  function own() { return (window.__cadeClipfeedOwn || 0) > 0; }
  function inSkip(el) {
    try { if (el && el.nodeType !== 1) el = el.parentElement; return !!(el && el.closest && el.closest(SKIP)); } catch (e) { return false; }
  }

  var cap = makeCapturer({
    setTimeout: function (f, ms) { return setTimeout(f, ms); },
    clearTimeout: function (t) { clearTimeout(t); },
    sink: function (text) {
      loadModel().then(function (svc) { return svc.add({ text: text }); }).catch(function (e) {
        try { console.warn('Clipboard feed: copy not shared —', (e && e.message) || e); } catch (x) {}
      });
    },
  });

  // ---- lifecycle: a ViewPlugin with a refcount (room switches recreate it) --------------
  var refs = 0, running = false, stopTimer = 0, lastDown = { t: 0, el: null };
  function start() {
    refs++;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = 0; }
    if (!running) enable();
  }
  function stop() {
    refs = Math.max(0, refs - 1);
    if (refs || !running || stopTimer) return;
    // deferred a tick: a state rebuild destroys and recreates the plugin back to back
    stopTimer = setTimeout(function () { stopTimer = 0; if (!refs) disable(); }, 0);
  }
  function enable() {
    running = true;
    document.addEventListener('copy', onCopy, false);
    document.addEventListener('cut', onCopy, false);
    document.addEventListener('pointerdown', onDown, true);
    wrapWriteText();
    chipRefresh();
  }
  function disable() {
    running = false;
    document.removeEventListener('copy', onCopy, false);
    document.removeEventListener('cut', onCopy, false);
    document.removeEventListener('pointerdown', onDown, true);
    unwrapWriteText();
    cap.cancel();
    lastDown.el = null;
    chipRefresh();
  }
  function onDown(e) { lastDown.t = Date.now(); lastDown.el = e.target; }

  // ---- copy / cut events -----------------------------------------------------------------
  // Bubble phase on the document, so CodeMirror's own handler (which fills
  // clipboardData — and on cut has already deleted the text) has run.
  function onCopy(e) {
    if (!running || own()) return;
    var t = e.target;
    if (t && t.nodeType !== 1) t = t.parentElement;
    if (inSkip(t)) return;
    var info = { data: '', field: null, editor: '', sel: '' };
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      var s = null, en = null;
      try { s = t.selectionStart; en = t.selectionEnd; } catch (x) {}
      info.field = { type: t.type, value: t.value, start: s, end: en };
      if (/^password$/i.test(t.type || '')) return;
    }
    try { info.data = e.clipboardData ? e.clipboardData.getData('text/plain') : ''; } catch (x) {}
    if (!info.data && !info.field) {
      var ed = Cade.editor;
      try {
        if (ed && t && ed.dom.contains(t)) {
          var st = ed.state;
          info.editor = st.selection.ranges.map(function (r) { return st.sliceDoc(r.from, r.to); }).filter(Boolean).join(st.lineBreak || '\n');
        }
      } catch (x) {}
      if (!info.editor) { try { info.sel = String((t && t.ownerDocument || document).getSelection() || ''); } catch (x) {} }
    }
    cap.push(pickCopyText(info));
  }

  // ---- the app's Copy buttons: navigator.clipboard.writeText ------------------------------
  var wrap = null;   // { cb, prev, had, fn }
  function wrapWriteText() {
    var cb = navigator.clipboard;
    if (wrap || !cb || typeof cb.writeText !== 'function') return;
    var w = { cb: cb, prev: cb.writeText, had: Object.prototype.hasOwnProperty.call(cb, 'writeText'), fn: null };
    w.fn = function (text) {
      if (wrap === w && running && !own()) {
        var skip = (Date.now() - lastDown.t < 2000 && inSkip(lastDown.el)) || inSkip(document.activeElement);
        if (!skip) cap.push(typeof text === 'string' ? text : String(text == null ? '' : text));
      }
      return w.prev.apply(cb, arguments);
    };
    try { cb.writeText = w.fn; } catch (e) { return; }
    if (cb.writeText === w.fn) wrap = w;
  }
  function unwrapWriteText() {
    var w = wrap;
    wrap = null;
    if (!w) return;
    // Someone wrapped on top of us meanwhile: leave theirs; ours is inert now (wrap !== w).
    try { if (w.cb.writeText === w.fn) { if (w.had) w.cb.writeText = w.prev; else delete w.cb.writeText; } } catch (e) {}
  }

  // ---- "copied on another device" chip ---------------------------------------------------
  var chipOn = true;
  var ch = { q: null, fn: null, primed: false, gen: 0, wait: false, retry: 0, tries: 0, vis: false, el: null, timer: 0 };
  function cloudOk() { try { return !!(Cade.cloud && Cade.cloud.configured()); } catch (e) { return false; } }
  function chipWanted() { return running && chipOn && document.visibilityState === 'visible' && cloudOk(); }
  function chipRefresh() {
    var want = running && chipOn;
    if (want && !ch.vis) { document.addEventListener('visibilitychange', chipRefresh); ch.vis = true; }
    else if (!want && ch.vis) { document.removeEventListener('visibilitychange', chipRefresh); ch.vis = false; }
    if (chipWanted()) chipAttach(); else { chipDetach(); if (!want) chipHide(); }
  }
  function chipAttach() {
    if (ch.q || ch.wait) return;
    var gen = ++ch.gen;
    ch.wait = true;
    Promise.resolve(Cade.cloud.ref('cb', 'items')).then(function (r) {
      if (gen !== ch.gen) return;
      ch.wait = false;
      if (!chipWanted()) return;
      if (!r) {   // database library still loading (cold start): try again a few times, backing off
        if (!ch.retry && ch.tries < 4) ch.retry = setTimeout(function () { ch.retry = 0; if (chipWanted()) chipAttach(); }, 5000 * Math.pow(2, ch.tries++));
        return;
      }
      ch.tries = 0;
      var q = r.orderByKey().limitToLast(1);
      ch.q = q; ch.primed = false;
      ch.fn = q.on('child_added', function (snap) { if (ch.q === q && ch.primed) chipItem(snap.key, snap.val()); }, function () {});
      // value fires after the initial child_added replay: everything later is new
      Promise.resolve(q.once('value')).then(function () { if (ch.q === q) ch.primed = true; }, function () {});
    }, function () { if (gen === ch.gen) ch.wait = false; });
  }
  function chipDetach() {
    ch.gen++;
    ch.wait = false;
    if (ch.retry) { clearTimeout(ch.retry); ch.retry = 0; }
    ch.tries = 0;
    if (ch.q) { try { ch.q.off('child_added', ch.fn); } catch (e) {} }
    ch.q = null; ch.fn = null; ch.primed = false;
  }
  function chipItem(key, raw) {
    if (!raw || typeof raw.s !== 'string') return;
    if (document.getElementById('clipfeed-panel')) return;   // the feed is open: it shows there
    Promise.resolve(Cade.cloud.unseal(raw.s)).then(function (rec) {
      if (!rec || typeof rec !== 'object' || !chipWanted()) return;
      var me = '';
      try { me = Cade.cloud.device.id; } catch (e) {}
      if (rec.did && rec.did === me) return;
      var at = typeof raw.at === 'number' ? raw.at : rec.at;
      if (at && Cade.cloud.serverNow() - at > 120000) return;   // an old one replayed (reconnect)
      chipShow(rec);
    }, function () {});
  }
  function oneLine(t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  var CSS = '.cbf-chip{position:fixed;left:16px;bottom:calc(52px + env(safe-area-inset-bottom,0px));z-index:7050;display:flex;align-items:stretch;' +
    'max-width:min(380px,calc(100vw - 32px));background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--accent,#0f9598);' +
    'border-radius:var(--radius-lg,10px);box-shadow:var(--shadow-lg,0 12px 40px rgba(0,0,0,.15));font-size:var(--text-sm,13px);' +
    'animation:cbf-chip-in .22s cubic-bezier(.16,1,.3,1)}' +
    '.cbf-chip-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left;padding:9px 6px 9px 12px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}' +
    '.cbf-chip-main b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.cbf-chip-t{font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-muted,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.cbf-chip-img{font-family:inherit;font-size:var(--text-sm,13px)}' +
    '.cbf-chip-h{font-size:11px;color:var(--accent,#0f9598)}' +
    '.cbf-chip-x{flex:none;width:40px;border:0;background:none;color:var(--text-muted,#666);font-size:18px;cursor:pointer;border-radius:0 var(--radius-lg,10px) var(--radius-lg,10px) 0}' +
    '.cbf-chip-x:hover{background:var(--surface-hover,rgba(0,0,0,.05))}' +
    '@keyframes cbf-chip-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '@media (max-width:560px){.cbf-chip{left:12px;right:12px;max-width:none;bottom:calc(16px + env(safe-area-inset-bottom,0px))}}' +
    '';
  function chipShow(rec) {
    chipHide();
    if (!document.getElementById('cbf-chip-css')) {
      var st = document.createElement('style');
      st.id = 'cbf-chip-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var text = typeof rec.t === 'string' && !rec.big ? rec.t : null;
    var el = document.createElement('div');
    el.className = 'cbf-chip';
    el.setAttribute('role', 'status');
    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'cbf-chip-main';
    var b = document.createElement('b');
    b.textContent = '📋 from ' + oneLine(rec.by || 'another device', 40) + ':';
    var t = document.createElement('span');
    t.className = rec.img ? 'cbf-chip-t cbf-chip-img' : 'cbf-chip-t';
    t.textContent = rec.img ? 'an image' : oneLine(rec.t, 90);
    var h = document.createElement('span');
    h.className = 'cbf-chip-h';
    h.textContent = text != null ? 'Tap to copy' : 'Tap to open the Clipboard';
    main.appendChild(b); main.appendChild(t); main.appendChild(h);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'cbf-chip-x';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    main.addEventListener('click', function () {
      chipHide();
      if (text != null) chipCopy(text);
      else Cade.runCommand('Clipboard');
    });
    x.addEventListener('click', chipHide);
    el.appendChild(main); el.appendChild(x);
    document.body.appendChild(el);
    ch.el = el;
    ch.timer = setTimeout(chipHide, CHIP_MS);
  }
  function chipHide() {
    if (ch.timer) { clearTimeout(ch.timer); ch.timer = 0; }
    if (ch.el) { if (ch.el.parentNode) ch.el.parentNode.removeChild(ch.el); ch.el = null; }
  }
  function chipCopy(text) {
    var ok = function () { try { Cade.showToast('Copied', 'success', 1200); } catch (e) {} };
    var legacy = function () {
      var ta = document.createElement('textarea'), done = false;
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      window.__cadeClipfeedOwn = (window.__cadeClipfeedOwn || 0) + 1;
      try { done = document.execCommand('copy'); } catch (e) {}
      window.__cadeClipfeedOwn--;
      ta.remove();
      if (done) ok(); else { try { Cade.showToast('Couldn’t copy — open the Clipboard to copy it', 'error', 2600); } catch (e) {} }
    };
    var p = null;
    window.__cadeClipfeedOwn = (window.__cadeClipfeedOwn || 0) + 1;
    try { if (navigator.clipboard && navigator.clipboard.writeText) p = navigator.clipboard.writeText(text); } catch (e) { p = null; }
    window.__cadeClipfeedOwn--;
    if (p) p.then(ok, legacy); else legacy();
  }

  Cade.registerSetting({
    key: 'clipfeed.chip', label: 'Pop up copies from my other devices', type: 'toggle', default: true, section: 'Devices',
    hint: 'While the app is open, something copied on another device shows a small chip for a few seconds — tap it to copy it here. Needs Sync and "Share copies to my Clipboard feed".',
    apply: function (on) { chipOn = !!on; chipRefresh(); },
  });

  // Status for tests / debugging, and
  // the widget hides a waiting chip when it opens (the feed shows the item itself).
  window.__cadeClipCapture = {
    state: function () { return { running: running, refs: refs, wrapped: !!wrap, chip: !!ch.q }; },
    hideChip: chipHide,
  };

  var ext = CM.ViewPlugin.define(function () { start(); return { destroy: stop }; });
  Cade.registerPlugin({ id: 'clipfeed-capture', ext: ext });
})();
