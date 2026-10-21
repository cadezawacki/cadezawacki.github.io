/* Word Echoes — see the words you repeat, by how close the repeat is.
 *
 * Opening the widget loads the analyzer (echoes-core.js, which takes its
 * sentence boundaries from Prose EKG's ekg-core.js) and registers the
 * 'echoes-view' editor extension. Only repeated content words are marked
 * (stopwords, numbers and short words never are): a warm tint (or underline)
 * whose strength follows how near the nearest repeat is, fading out about
 * five sentences away; a repeat inside the same sentence also gets a solid
 * underline. Hover shows "repeats 7 words later" etc.
 *
 * Focus: when the caret lands on (or the selection is exactly) a word that
 * occurs more than once — tap, click or arrow keys — every occurrence gets a
 * strong highlight and the rest of the text fades (a class on the editor plus
 * marks; no per-frame JS). A chip shows "‘river’ × 5" with ‹ › to step through
 * them. It clears when the caret leaves the word, on typing, on Escape or the
 * chip's ×. Tapping still moves the caret as usual.
 *
 * The panel: on/off, a legend, the note's most echoed words (tap = jump to
 * the next one and focus it) and ⚙ for the preferences (Cade.prefs('echoes'),
 * schema in the manifest). Closing the panel removes the extension, so every
 * mark, class, chip and listener goes with it. Only the blocks around the
 * visible range are analysed for marks (cached per paragraph); the whole-note
 * index behind the list and the chip is rebuilt lazily, at most once per
 * document version. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('echoes.css');

  var ID = 'echoes', PANEL_ID = 'echoes-panel', PLUGIN_ID = 'echoes-view';
  var MARGIN = 2500, DEBOUNCE = 200, SCROLL_DEBOUNCE = 60, LIST_DEBOUNCE = 600, TOP_N = 12;
  // The preferences schema (also the manifest entry's "prefs").
  var PREFS = {
    title: 'Word Echoes',
    fields: [
      { key: 'taper', type: 'slider', label: 'Fade out after', default: 5, min: 2, max: 10, step: 1, unit: 'sentences', hint: 'How far apart two uses of a word can be and still be marked. Nearer repeats are always stronger.' },
      { key: 'stem', type: 'toggle', label: 'Match word forms', default: true, hint: 'run / runs / running and idea / ideas count as the same word' },
      { key: 'minLen', type: 'number', label: 'Shortest word to check', default: 3, min: 2, max: 8, step: 1, unit: 'letters' },
      { key: 'ignore', type: 'text', label: 'Also ignore these words', default: '', placeholder: 'e.g. said, Anna, river', hint: 'Comma-separated. Common words (the, a, than, with…) are always ignored.' },
      { key: 'style', type: 'radio', label: 'Highlight style', default: 'tint', options: [{ value: 'tint', label: 'Tint' }, { value: 'underline', label: 'Underline' }] }
    ]
  };

  window.__cadeEchoesPrefs = PREFS;      // (read by the tests)

  var core = null, engine = null, viewApi = null, loading = null;
  var P = null, el = {}, isOpen = false, isOn = false, prefs = null, opts = null, offPrefs = null;
  var listTimer = 0, focusNow = null;
  var dc = { doc: null, blocks: null, index: null };

  function esc(s) { return Cade.escapeHtml(String(s)); }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  // Cade.prefs, or (until the core has it) the schema defaults in memory, live via on().
  var fallback = null;
  function prefsOf(id, fields) {
    if (Cade.prefs) return Cade.prefs(id);
    if (fallback) return fallback;
    var d = {}, ls = [];
    fields.forEach(function (f) { if (f.key) d[f.key] = f.default; });
    function all() { var o = {}; for (var k in d) o[k] = d[k]; return o; }
    return (fallback = {
      get: function (k) { return d[k]; }, all: all,
      set: function (k, v) { d[k] = v; ls.slice().forEach(function (fn) { try { fn(k, v, all()); } catch (e) {} }); },
      on: function (fn) { ls.push(fn); return function () { var i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; }
    });
  }
  // Current values with the schema defaults filled in (a page the core has no schema for yet returns raw values).
  function readOpts() {
    var a = {}, v = {};
    try { v = prefs.all() || {}; } catch (e) {}
    PREFS.fields.forEach(function (f) { if (f.key) a[f.key] = v[f.key] != null && v[f.key] !== '' ? v[f.key] : f.default; });
    a.ignore = v.ignore != null ? String(v.ignore) : '';
    return a;
  }
  function addScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function load() {
    if (core) return Promise.resolve();
    if (!loading) {
      loading = (window.__cadeEkgCore ? Promise.resolve() : addScript(BASE + '../ekg/ekg-core.js'))
        .then(function () { return window.__cadeEchoesCore ? null : addScript(BASE + 'echoes-core.js'); })
        .then(function () { core = window.__cadeEchoesCore; engine = new core.Engine(opts); viewApi = makeView(); });
      loading.catch(function () { loading = null; });
    }
    return loading;
  }

  // ---- shared per-document caches ------------------------------------------------------
  function blocksOf(doc) {
    if (dc.doc !== doc) { dc = { doc: doc, blocks: engine.blocks(doc), index: null }; }
    return dc.blocks;
  }
  function indexOf(doc) {
    blocksOf(doc);
    if (!dc.index) dc.index = engine.index(doc, dc.blocks);
    return dc.index;
  }

  // ---- the editor view -----------------------------------------------------------------
  function makeView() {
    var CM = Cade.CM, Decoration = CM.Decoration, EditorView = CM.EditorView;
    var refresh = CM.StateEffect.define();
    var markCache = new Map();
    var hitDeco = Decoration.mark({ class: 'cm-echo-hit' }), curDeco = Decoration.mark({ class: 'cm-echo-hit cm-echo-cur' });
    function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
    function describe(m) {
      var when = m.dir > 0 ? 'later' : 'earlier', s = '“' + m.lw + '” repeats ';
      if (m.same) s += plural(m.wordGap, 'word') + ' ' + when + ', in the same sentence';
      else if (m.sentGap === 1) s += plural(m.wordGap, 'word') + ' ' + when + ', in the ' + (m.dir > 0 ? 'next' : 'previous') + ' sentence';
      else s += plural(m.sentGap, 'sentence') + ' ' + when + ' (' + plural(m.wordGap, 'word') + ')';
      return s;
    }
    function markOf(m) {
      var cls = 'cm-echo cm-echo-' + m.level + (m.same ? ' cm-echo-same' : ''), title = describe(m), k = cls + '\u0000' + title, d = markCache.get(k);
      if (!d) {
        if (markCache.size > 1500) markCache.clear();
        d = Decoration.mark({ class: cls, attributes: { title: title } });
        markCache.set(k, d);
      }
      return d;
    }

    function Echo(view) {
      var self = this;
      this.view = view; this.live = false; this.timer = 0;
      this.echo = Decoration.none; this.hits = Decoration.none;
      this.cov = null; this.focus = null; this.escaped = null; this.chip = null;
      this.onChipDown = function (e) { e.preventDefault(); };
      this.onChip = function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (!b) return;
        e.preventDefault(); e.stopPropagation();
        if (b.hasAttribute('data-x')) self.escape();
        else self.step(+b.getAttribute('data-d'));
      };
      if (host.isOn()) this.start();
    }
    Echo.prototype.start = function () { this.live = true; this.rebuild(); };
    Echo.prototype.stop = function () {
      this.live = false;
      this.clearTimer();
      this.echo = this.hits = Decoration.none; this.cov = null; this.escaped = null;
      this.setFocus(null);
    };
    Echo.prototype.update = function (u) {
      // (a room's saved state can keep this plugin while the widget is off: it stays dormant)
      if (!host.isOn()) { if (this.live) this.stop(); return; }
      if (!this.live) { this.start(); return; }
      var forced = false, i, j;
      for (i = 0; i < u.transactions.length && !forced; i++) {
        var ef = u.transactions[i].effects;
        for (j = 0; j < ef.length; j++) if (ef[j].is(refresh)) { forced = true; break; }
      }
      if (u.docChanged) {
        var ch = u.changes;
        this.echo = this.echo.map(ch); this.hits = this.hits.map(ch);
        if (this.cov) this.cov = { from: ch.mapPos(this.cov.from, -1), to: ch.mapPos(this.cov.to, 1) };
        this.escaped = null;
        if (this.focus) this.setFocus(null);      // typing never focuses; it clears a focus
        if (!forced) this.schedule(DEBOUNCE);
      } else if (u.selectionSet) this.track(u.state);
      if (forced) { this.clearTimer(); this.rebuild(); }
      else if (u.viewportChanged && !u.docChanged && !this.covers()) this.schedule(SCROLL_DEBOUNCE);
    };
    Echo.prototype.clearTimer = function () { if (this.timer) { clearTimeout(this.timer); this.timer = 0; } };
    Echo.prototype.schedule = function (ms) {
      var self = this;
      this.clearTimer();
      this.timer = setTimeout(function () {
        self.timer = 0;
        if (!self.live) return;
        try { self.view.dispatch({ effects: refresh.of(null) }); } catch (e) {}
      }, ms);
    };
    Echo.prototype.covers = function () {
      var vr = this.view.visibleRanges, c = this.cov;
      if (!c || !vr.length) return !!c;
      return vr[0].from >= c.from && vr[vr.length - 1].to <= c.to;
    };
    Echo.prototype.range = function () {
      var view = this.view, len = view.state.doc.length, vr = view.visibleRanges, vp = view.viewport;
      return { from: Math.max(0, (vr.length ? vr[0].from : vp.from) - MARGIN), to: Math.min(len, (vr.length ? vr[vr.length - 1].to : vp.to) + MARGIN) };
    };
    Echo.prototype.rebuild = function () {
      var doc = this.view.state.doc, r = this.range(), marks = engine.window(doc, blocksOf(doc), r.from, r.to), ranges = [];
      for (var i = 0; i < marks.length; i++) ranges.push(markOf(marks[i]).range(marks[i].from, marks[i].to));
      this.echo = ranges.length ? Decoration.set(ranges, true) : Decoration.none;
      this.cov = r;
      if (this.focus) this.buildHits();
    };
    // The caret's word (or an exactly selected word) with more than one occurrence in the note.
    Echo.prototype.track = function (state) {
      var sel = state.selection.main, doc = state.doc, w = null;
      if (state.selection.ranges.length === 1) {
        w = engine.wordAt(doc, blocksOf(doc), sel.empty ? sel.head : sel.from, sel.empty ? null : sel.to);
        if (w) { var e = indexOf(doc).keys.get(w.key); if (!e || e.n < 2) w = null; else w.n = e.n; }
      }
      if (this.escaped) {
        if (w && w.from === this.escaped.from && w.key === this.escaped.key) w = null;
        else this.escaped = null;
      }
      var f = this.focus;
      if (!w && !f) return;
      if (w && f && w.from === f.from && w.key === f.key && w.n === f.n) return;
      this.setFocus(w);
    };
    Echo.prototype.setFocus = function (w) {
      this.focus = w;
      if (w) this.buildHits(); else this.hits = Decoration.none;
      this.renderChip();
      if (host.onFocus) { try { host.onFocus(w); } catch (e) {} }
    };
    Echo.prototype.buildHits = function () {
      var f = this.focus, doc = this.view.state.doc, e = indexOf(doc).keys.get(f.key);
      if (!e) { this.hits = Decoration.none; return; }
      var r = this.cov || this.range(), pos = e.pos, lo = 0, hi = pos.length, ranges = [];
      while (lo < hi) { var mid = (lo + hi) >> 1; if (pos[mid] < r.from) lo = mid + 1; else hi = mid; }
      for (var i = lo; i < pos.length && pos[i] <= r.to; i++) ranges.push((pos[i] === f.from ? curDeco : hitDeco).range(pos[i], pos[i] + e.len[i]));
      this.hits = ranges.length ? Decoration.set(ranges) : Decoration.none;
      // which one this is (for the chip)
      lo = 0; hi = pos.length;
      while (lo < hi) { var m2 = (lo + hi) >> 1; if (pos[m2] < f.from) lo = m2 + 1; else hi = m2; }
      f.i = lo; f.n = pos.length; f.word = e.word;
    };
    Echo.prototype.renderChip = function () {
      var f = this.focus;
      if (!f) { if (this.chip) { this.chip.removeEventListener('mousedown', this.onChipDown); this.chip.removeEventListener('click', this.onChip); this.chip.remove(); this.chip = null; } return; }
      if (!this.chip) {
        var c = this.chip = document.createElement('div');
        c.className = 'cm-echoes-chip';
        c.setAttribute('role', 'status');
        c.addEventListener('mousedown', this.onChipDown);
        c.addEventListener('click', this.onChip);
        this.view.dom.appendChild(c);
      }
      this.chip.innerHTML = '<span class="cm-echoes-chip-t"><b>‘' + esc(f.lw) + '’</b> × ' + f.n + '<small>' + (f.i + 1) + '/' + f.n + '</small></span>' +
        '<button type="button" data-d="-1" title="Previous" aria-label="Previous">‹</button>' +
        '<button type="button" data-d="1" title="Next" aria-label="Next">›</button>' +
        '<button type="button" data-x title="Clear (Esc)" aria-label="Clear">×</button>';
    };
    Echo.prototype.escape = function () {
      if (!this.focus) return;
      this.escaped = { from: this.focus.from, key: this.focus.key };
      this.setFocus(null);
      try { this.view.dispatch({ effects: refresh.of(null) }); } catch (e) {}
    };
    Echo.prototype.step = function (d) {
      var f = this.focus, view = this.view;
      if (!f) return;
      var e = indexOf(view.state.doc).keys.get(f.key);
      if (!e || !e.pos.length) return;
      var n = e.pos.length, i = ((f.i + d) % n + n) % n;
      goTo(view, e.pos[i]);
    };
    Echo.prototype.destroy = function () { this.stop(); };

    var plugin = CM.ViewPlugin.define(function (view) { return new Echo(view); }, {
      decorations: function (v) { return !v.live ? Decoration.none : v.focus ? v.hits : v.echo; }
    });
    var attrs = EditorView.editorAttributes.of(function (view) {
      if (!host.isOn()) return null;
      var p = view.plugin(plugin);
      return { class: 'cm-echoes-on cm-echoes-' + (opts && opts.style === 'underline' ? 'underline' : 'tint') + (p && p.focus ? ' cm-echoes-focus' : '') };
    });
    var keys = CM.Prec.highest(CM.keymap.of([{ key: 'Escape', run: function (view) {
      var p = view.plugin(plugin);
      if (!p || !p.focus) return false;
      p.escape();
      return true;
    } }]));
    return { ext: [plugin, attrs, keys], refresh: refresh, plugin: plugin };
  }

  // Put the caret at pos (scrolled into view), which focuses the word there. A touch screen
  // without the keyboard up keeps it down (focusing the note would pop it).
  function goTo(view, pos) {
    var CM = Cade.CM;
    view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select.echoes' });
    if (!coarse() || view.hasFocus) view.focus();
  }

  var host = {
    isOn: function () { return isOpen && isOn; },
    onFocus: function (f) { focusNow = f; paintFocus(); }
  };
  function refreshView() {
    var ed = Cade.editor;
    if (ed && viewApi && isOn) try { ed.dispatch({ effects: viewApi.refresh.of(null) }); } catch (e) {}
  }
  function setOn(on) {
    if (on === isOn && isOpen) return;
    isOn = on;
    if (!isOpen || !viewApi) return;
    if (on) Cade.registerPlugin({ id: PLUGIN_ID, ext: viewApi.ext });
    else { Cade.unregisterPlugin(PLUGIN_ID); focusNow = null; paintFocus(); }
  }

  // ---- panel ---------------------------------------------------------------------------
  function bodyHtml() {
    var k = '';
    for (var i = 6; i >= 1; i--) k += '<i class="echo-k echo-k' + i + '"></i>';
    return '<div class="echo">' +
      '<div class="echo-row">' +
        '<button type="button" class="echo-onbtn" role="switch" aria-checked="true"><span class="echo-tog" aria-hidden="true"></span><span>Highlight repeats</span></button>' +
        '<button type="button" class="echo-gear" title="Preferences" aria-label="Word Echoes preferences">⚙</button>' +
      '</div>' +
      '<div class="echo-focus" hidden></div>' +
      '<div class="echo-legend">' +
        '<span class="echo-scale"><span class="echo-ks">' + k + '</span><span class="echo-kl"><span>near</span><span class="echo-far">far</span></span></span>' +
        '<span class="echo-same-k"><span class="echo-sw-same">word</span> same sentence</span>' +
      '</div>' +
      '<div class="echo-hint">Only repeated words are marked — the closer the repeat, the stronger. Tap a word to see all of its repeats.</div>' +
      '<div class="echo-top-h">Most echoed</div>' +
      '<div class="echo-top" role="list"><span class="echo-none">Loading…</span></div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    prefs = prefsOf(ID, PREFS.fields);
    opts = readOpts();
    P = Cade.mkPanel(PANEL_ID, '🔁 Word Echoes', bodyHtml());
    P._onClose = cleanup;
    el = { on: q('.echo-onbtn'), gear: q('.echo-gear'), focus: q('.echo-focus'), top: q('.echo-top'), far: q('.echo-far'), legend: q('.echo-legend') };
    P.addEventListener('click', onClick);
    P.addEventListener('keydown', onKey);
    // the panel's buttons never take the caret away from the note
    P.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });
    P.addEventListener('cade-panel-minimize', onMinimize);
    P.addEventListener('cade-panel-restore', onRestore);
    paintChrome();
    var p = P;
    load().then(function () {
      if (P !== p) return;                       // closed while loading
      engine.setOptions(opts);
      isOpen = true; isOn = false;
      setOn(true);
      offPrefs = prefs.on(onPrefs);
      Cade.onEditorUpdate(onUpdate);
      document.addEventListener('cade-room-switched', onRoom);
      document.addEventListener('visibilitychange', onVisible);
      paintChrome();
      scheduleList(30);
    }, function () {
      if (P === p) el.top.innerHTML = '<span class="echo-none">Couldn’t load the analyzer — check the connection and reopen.</span>';
    });
  }
  function cleanup() {
    var was = isOpen;
    clearTimeout(listTimer); listTimer = 0;
    if (was) {
      if (isOn) Cade.unregisterPlugin(PLUGIN_ID);
      Cade.offEditorUpdate(onUpdate);
      document.removeEventListener('cade-room-switched', onRoom);
      document.removeEventListener('visibilitychange', onVisible);
    }
    isOpen = false; isOn = false;
    if (offPrefs) { try { offPrefs(); } catch (e) {} offPrefs = null; }
    dc = { doc: null, blocks: null, index: null };
    if (engine && engine.cache.size > 4000) engine.clear();
    P = null; el = {}; focusNow = null;
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
  }

  // ---- events --------------------------------------------------------------------------
  function onUpdate(u) {
    if (!isOpen || !P) return;
    if (!P.isConnected) { cleanup(); return; }      // removed without its × (belt and braces)
    if (u.docChanged) scheduleList(LIST_DEBOUNCE);
  }
  function onPrefs() {
    if (!isOpen) return;
    opts = readOpts();
    engine.setOptions(opts);
    dc.index = null;
    refreshView();
    paintChrome();
    scheduleList(60);
  }
  function onRoom() {
    if (!isOpen || !isOn) return;
    // a restored room state may lack (or hold a stale copy of) the extension: re-add it
    Cade.unregisterPlugin(PLUGIN_ID);
    Cade.registerPlugin({ id: PLUGIN_ID, ext: viewApi.ext });
    scheduleList(60);
  }
  function onVisible() { if (!document.hidden && isOpen) scheduleList(60); }
  function onMinimize() { clearTimeout(listTimer); listTimer = 0; }
  function onRestore() { scheduleList(30); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); try { Cade.editor.focus(); } catch (x) {} }
  }
  function onClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !P || !P.contains(b)) return;
    if (b === el.on) { setOn(!isOn); paintChrome(); if (isOn) scheduleList(30); }
    else if (b === el.gear) { if (Cade.prefs && Cade.prefs.open) Cade.prefs.open(ID); else Cade.showToast('Widget preferences aren’t available yet', 'info', 1800); }
    else if (b.hasAttribute('data-key')) jumpTo(b.getAttribute('data-key'));
    else if (b.hasAttribute('data-clear')) { var ed = Cade.editor, pl = viewApi && ed.plugin(viewApi.plugin); if (pl) pl.escape(); }
  }
  // The next occurrence after the caret (wrapping), which then focuses that word.
  function jumpTo(key) {
    var ed = Cade.editor;
    if (!ed || !engine) return;
    var e = indexOf(ed.state.doc).keys.get(key);
    if (!e || !e.pos.length) return;
    var head = ed.state.selection.main.head, cur = focusNow && focusNow.key === key ? focusNow.from : head, i = 0;
    while (i < e.pos.length && e.pos[i] <= cur) i++;
    if (i >= e.pos.length) i = 0;
    if (!isOn) { setOn(true); paintChrome(); }
    goTo(ed, e.pos[i]);
  }
  function scheduleList(ms) {
    clearTimeout(listTimer);
    listTimer = setTimeout(function () { listTimer = 0; renderList(); }, ms);
  }

  function paintChrome() {
    if (!P) return;
    el.on.setAttribute('aria-checked', isOn || !isOpen ? 'true' : 'false');
    el.on.classList.toggle('on', isOn || !isOpen);
    P.classList.toggle('echo-off', isOpen && !isOn);
    P.classList.toggle('echo-ul', !!(opts && opts.style === 'underline'));
    el.far.textContent = 'far (~' + (opts ? opts.taper : 5) + ' sentences)';
  }
  function paintFocus() {
    if (!P || !el.focus) return;
    var f = focusNow;
    el.focus.hidden = !f;
    if (f) el.focus.innerHTML = '<span><b>‘' + esc(f.lw) + '’</b> × ' + f.n + ' in this note</span><button type="button" data-clear title="Clear (Esc)">Clear</button>';
    var bs = el.top ? el.top.querySelectorAll('[data-key]') : [];
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('cur', !!f && bs[i].getAttribute('data-key') === f.key);
  }
  function renderList() {
    if (!isOpen || !P || !engine || Cade.isMinimized(P) || document.hidden) return;
    var ed = Cade.editor, ix = indexOf(ed.state.doc), top = ix.top(TOP_N), h = '';
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      h += '<button type="button" class="echo-w" role="listitem" data-key="' + esc(t.key) + '" title="Jump to the next ‘' + esc(t.word) + '’">' +
        '<span class="echo-w-t">' + esc(t.word) + '</span><span class="echo-w-n">× ' + t.n + '</span></button>';
    }
    el.top.innerHTML = h || '<span class="echo-none">' + (ix.words ? 'No close repeats — nicely varied.' : 'Nothing to check yet.') + '</span>';
    paintFocus();
  }

  Cade.registerWidget({
    name: 'Word Echoes',
    description: 'Highlights only the words you repeat — the closer the repeat, the stronger the tint; tap a word to see every echo',
    icon: '🔁',
    tags: 'writing,prose,repetition,repeated words,echo,echoes,word choice,style,proofread,lint,highlight',
    open: open,
    close: close
  });
})();
