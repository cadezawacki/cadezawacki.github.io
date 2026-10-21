/* Prose EKG — see the rhythm and the problems of your writing at a glance.
 *
 * Opening the widget loads the analyzer (ekg-core.js) and the editor view
 * (ekg-view.js) and registers the 'ekg-view' editor extension: a margin
 * strip of sentence-length bars beside the text plus inline marks (run-on
 * tails amber → red, very complex sentences, grammar slips, passive voice,
 * filler words). Closing the panel unregisters it — every mark, the strip
 * and the content padding go with it, and nothing of this module runs while
 * it is closed.
 *
 * The panel is an EKG monitor: one heartbeat per sentence of the caret's
 * paragraph (or of the whole note), the spike as tall as the sentence is
 * long, coloured by its length class, the caret's sentence marked; tap a
 * beat to jump there. Below: sentences / average / variety (std-dev of the
 * lengths) / longest / reading grade, and a drawer with the categories (a
 * legend with counts that doubles as on/off toggles, remembered in
 * Cade.store) and the issue list (tap = select it in the note, "Fix" where a
 * safe fix exists). It follows the caret and re-analyses ~250 ms after
 * typing stops (cached per paragraph, so only the edited one is redone).
 * On phones it is a short strip whose drawer starts closed and hides while
 * the keyboard is up.
 *
 * While the panel is open, nlp-client.js runs the compromise NLP library in a
 * worker (lazily, from the CDN; cached by the service worker afterwards) and
 * hands the analyzer part-of-speech tags for the paragraphs whose checks can
 * use them (its/it's, then/than, comma splices). Until they arrive — or
 * offline, or if the library fails — the word-list rules apply as before;
 * when they do, only the paragraphs that waited are redone. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var BASE = Cade.baseURL();
  Cade.loadCSS('ekg.css');

  var PANEL_ID = 'ekg-panel', PREFS_KEY = 'cade-ekg-prefs', PLUGIN_ID = 'ekg-view';
  var CATS = [
    { id: 'strip', label: 'Margin strip', tip: 'Sentence-length bars beside the text' },
    { id: 'tails', label: 'Run-on tails', tip: 'Words past the 25th, tinted amber → red' },
    { id: 'complex', label: 'Very complex', tip: 'Long, many-clause, hard-word sentences (dotted purple)' },
    { id: 'grammar', label: 'Grammar', tip: 'Repeated words, a/an, spacing, “could of”, then/than, its/it’s, comma splices… (wavy red)' },
    { id: 'passive', label: 'Passive voice', tip: '“was written”, “is being built” (dotted blue)' },
    { id: 'filler', label: 'Filler words', tip: 'very, really, just, actually, basically, literally (grey)' }
  ];
  var CLASS_NAMES = { s: 'short', m: 'medium', l: 'long', r: 'run-on' };
  var DEFAULT_CATS = { strip: true, tails: true, complex: true, grammar: true, passive: true, filler: false };

  var core = null, an = null, view = null, loading = null, nlpOff = null;
  var prefs = null, P = null, el = {}, isOpen = false;
  var timer = 0, flashTimer = 0, ro = null, vv = null, mon = null, lastKey = '', cur = null;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s)); }
  function phone() { return window.matchMedia && window.matchMedia('(max-width: 600px)').matches; }
  function coarse() { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
  function loadPrefs() {
    var p = { cats: {}, scope: 'para', drawer: !phone() };
    for (var k in DEFAULT_CATS) p.cats[k] = DEFAULT_CATS[k];
    try {
      var s = JSON.parse(sget(PREFS_KEY) || 'null');
      if (s && typeof s === 'object') {
        if (s.cats) for (k in DEFAULT_CATS) if (typeof s.cats[k] === 'boolean') p.cats[k] = s.cats[k];
        if (s.scope === 'note' || s.scope === 'para') p.scope = s.scope;
        if (typeof s.drawer === 'boolean') p.drawer = s.drawer;
      }
    } catch (e) {}
    return p;
  }
  function savePrefs() { sset(PREFS_KEY, JSON.stringify(prefs)); }

  function addScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function load() {
    if (core && view) return Promise.resolve();
    if (!loading) {
      loading = (window.__cadeEkgCore ? Promise.resolve() : addScript(BASE + 'ekg-core.js'))
        .then(function () { return window.__cadeEkgView ? null : addScript(BASE + 'ekg-view.js'); })
        .then(function () {
          core = window.__cadeEkgCore;
          an = new core.Analyzer();
          view = window.__cadeEkgView(host);
        });
      loading.catch(function () { loading = null; });
    }
    return loading;
  }
  // What the editor view reads (live).
  var host = {
    get core() { return core; },
    get an() { return an; },
    get cats() { return prefs ? prefs.cats : DEFAULT_CATS; },
    isOpen: function () { return isOpen; },
    noFocus: function () { return coarse(); },
    onPick: function (s) { flash(s.from, s.to); },
    flash: null
  };
  function refreshView() {
    var ed = Cade.editor;
    if (ed && view) try { ed.dispatch({ effects: view.refresh.of(null) }); } catch (e) {}
  }

  // ---- panel ---------------------------------------------------------------------------
  function bodyHtml() {
    return '<div class="ekg">' +
      '<div class="ekg-mon">' +
        '<div class="ekg-trace"><canvas class="ekg-cv" aria-label="Sentence lengths as a heart-monitor trace; tap a beat to jump to that sentence"></canvas>' +
          '<div class="ekg-empty" hidden></div></div>' +
        '<div class="ekg-scope" role="group" aria-label="Show">' +
          '<button type="button" data-scope="para" title="The paragraph with the caret">¶</button>' +
          '<button type="button" data-scope="note" title="The whole note">All</button>' +
        '</div>' +
      '</div>' +
      '<div class="ekg-stats"></div>' +
      '<button type="button" class="ekg-dbtn" aria-expanded="false"><span class="ekg-dsum"></span><span class="ekg-chev" aria-hidden="true">▾</span></button>' +
      '<div class="ekg-drawer">' +
        '<div class="ekg-legend" role="group" aria-label="Show in the note"></div>' +
        '<div class="ekg-key" aria-label="Sentence length colours"></div>' +
        '<div class="ekg-list" role="list"></div>' +
      '</div>' +
    '</div>';
  }
  function q(s) { return P.querySelector(s); }

  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    prefs = loadPrefs();
    P = Cade.mkPanel(PANEL_ID, '〰 Prose EKG', bodyHtml());
    P._onClose = cleanup;
    el = { cv: q('.ekg-cv'), mon: q('.ekg-mon'), empty: q('.ekg-empty'), stats: q('.ekg-stats'), dbtn: q('.ekg-dbtn'), dsum: q('.ekg-dsum'),
      drawer: q('.ekg-drawer'), legend: q('.ekg-legend'), key: q('.ekg-key'), list: q('.ekg-list') };
    el.stats.innerHTML = '<span class="ekg-load">Loading…</span>';
    P.addEventListener('click', onClick);
    P.addEventListener('keydown', onKey);
    // buttons and the monitor never take the caret away from the note
    P.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('button, .ekg-it, .ekg-cv')) e.preventDefault(); });
    el.cv.addEventListener('pointerup', onMonitorTap);
    // the desktop panel sits by its bottom edge; a header drag moves it by its top (or it would stretch)
    var head = P.querySelector('.cade-panel-head');
    if (head) head.addEventListener('pointerdown', function (e) {
      if (!P || P.style.bottom === 'auto' || (e.target.closest && e.target.closest('.cade-panel-x, .cade-panel-minbtn, .cade-panel-popbtn'))) return;
      P.style.top = P.getBoundingClientRect().top + 'px';
      P.style.bottom = 'auto';
    });
    P.addEventListener('cade-panel-minimize', onMinimize);
    P.addEventListener('cade-panel-restore', onRestore);
    paintChrome();
    var p = P;
    load().then(function () {
      if (P !== p) return;                     // closed while loading
      isOpen = true;
      startTags();
      Cade.registerPlugin({ id: PLUGIN_ID, ext: view.ext });
      Cade.onEditorUpdate(onUpdate);
      document.addEventListener('cade-room-switched', onRoom);
      document.addEventListener('visibilitychange', onVisible);
      if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(function () { draw(); }); ro.observe(el.mon); }
      vv = window.visualViewport || null;
      if (vv) vv.addEventListener('resize', onKeyboard);
      onKeyboard();
      render();
    }, function () {
      if (P === p) el.stats.innerHTML = '<span class="ekg-load">Couldn’t load the analyzer — check the connection and reopen.</span>';
    });
  }
  function cleanup() {
    var was = isOpen;
    isOpen = false;
    clearTimeout(timer); timer = 0;
    clearTimeout(flashTimer); flashTimer = 0;
    host.flash = null;
    if (was) {
      Cade.unregisterPlugin(PLUGIN_ID);
      Cade.offEditorUpdate(onUpdate);
      document.removeEventListener('cade-room-switched', onRoom);
      document.removeEventListener('visibilitychange', onVisible);
    }
    if (ro) { ro.disconnect(); ro = null; }
    if (vv) { vv.removeEventListener('resize', onKeyboard); vv = null; }
    if (nlpOff) { nlpOff(); nlpOff = null; }
    if (an) an.setPos(null);
    if (an && an.cache.size > 4000) an.clear();
    P = null; el = {}; mon = null; cur = null; lastKey = '';
  }
  function close() {
    var p = P;
    cleanup();
    if (p) p.remove();
  }

  // ---- part-of-speech tags (optional) ------------------------------------------------------
  // Loaded after the panel is up; nothing waits for it and a failure changes nothing.
  function startTags() {
    var p = P;
    (window.__cadeNlp ? Promise.resolve() : addScript(BASE + 'nlp-client.js')).then(function () {
      var nl = window.__cadeNlp;
      if (!nl || P !== p || !isOpen || nlpOff) return;
      nlpOff = nl.acquire(onTags);
      an.setPos(function (text) { return nl.get(text); });
      refreshView(); schedule(30);
    }, function () {});
  }
  // The marks follow every answer; a whole-note panel waits until a long note is all tagged
  // (re-listing a thousand issues each second would only make the page stutter).
  function onTags() {
    if (!isOpen || !an || !an.settle()) return;            // nothing reads differently: nothing to redraw
    refreshView();
    var nl = window.__cadeNlp, busy = nl && nl.pending() > 0;
    if (prefs.scope === 'note' && busy) return;
    if (!timer) schedule(60);
  }

  // ---- events --------------------------------------------------------------------------
  function onUpdate(u) {
    if (!isOpen || !P) return;
    if (!P.isConnected) { cleanup(); return; }      // removed without its × (belt and braces)
    if (u.docChanged) { schedule(250); return; }
    if (u.selectionSet && !timer) onCaret();
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { timer = 0; render(); }, ms); }
  function onCaret() {
    if (!cur || Cade.isMinimized(P)) return;
    var ed = Cade.editor, head = ed.state.selection.main.head;
    if (prefs.scope === 'para' && keyFor(ed.state.doc, head) !== lastKey) { render(); return; }
    var ci = caretIndex(head);
    if (ci !== cur.caret) { cur.caret = ci; draw(); }
  }
  function onRoom() {
    if (!isOpen) return;
    // a restored room state may lack (or hold a stale copy of) the extension: re-add it
    Cade.unregisterPlugin(PLUGIN_ID);
    Cade.registerPlugin({ id: PLUGIN_ID, ext: view.ext });
    cur = null; lastKey = '';
    render();
  }
  function onVisible() { if (!document.hidden && isOpen) schedule(50); }
  function onMinimize() { clearTimeout(timer); timer = 0; }
  function onRestore() { lastKey = ''; render(); }
  function onKeyboard() {
    if (!P) return;
    var kb = !!(vv && phone() && vv.height < window.innerHeight * 0.78);
    P.classList.toggle('ekg-kb', kb);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); try { Cade.editor.focus(); } catch (x) {} }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ekg-it')) { e.preventDefault(); e.target.click(); }
  }
  function onClick(e) {
    var t = e.target, b = t.closest ? t.closest('[data-scope],[data-cat],.ekg-dbtn,.ekg-fix,.ekg-it,.ekg-jump') : null;
    if (!b || !P || !P.contains(b)) return;
    if (b.hasAttribute('data-scope')) {
      prefs.scope = b.getAttribute('data-scope'); savePrefs(); paintChrome(); lastKey = ''; render();
    } else if (b.hasAttribute('data-cat')) {
      var c = b.getAttribute('data-cat');
      prefs.cats[c] = !prefs.cats[c]; savePrefs(); paintChrome(); refreshView(); render();
    } else if (b.classList.contains('ekg-dbtn')) {
      prefs.drawer = !prefs.drawer; savePrefs(); paintChrome();
    } else if (b.classList.contains('ekg-fix')) {
      e.stopPropagation(); applyFix(cur && cur.list[+b.getAttribute('data-k')]);
    } else if (b.classList.contains('ekg-jump')) {
      var s = cur && cur.sents[+b.getAttribute('data-s')];
      if (s) select(s.from, s.to);
    } else if (b.classList.contains('ekg-it')) {
      var is = cur && cur.list[+b.getAttribute('data-k')];
      if (is) select(is.from, is.to);
    }
  }
  function paintChrome() {
    if (!P) return;
    var bs = P.querySelectorAll('[data-scope]');
    for (var i = 0; i < bs.length; i++) { var on = bs[i].getAttribute('data-scope') === prefs.scope; bs[i].classList.toggle('on', on); bs[i].setAttribute('aria-pressed', on ? 'true' : 'false'); }
    P.classList.toggle('ekg-open', !!prefs.drawer);
    el.dbtn.setAttribute('aria-expanded', prefs.drawer ? 'true' : 'false');
    var cs = P.querySelectorAll('[data-cat]');
    for (i = 0; i < cs.length; i++) { var c = cs[i].getAttribute('data-cat'); cs[i].classList.toggle('on', !!prefs.cats[c]); cs[i].setAttribute('aria-pressed', prefs.cats[c] ? 'true' : 'false'); }
  }

  // Select a range in the note and flash it (a touch screen without the keyboard up
  // shows no selection, and focusing the note there would pop the keyboard).
  function select(from, to) {
    var ed = Cade.editor, CM = Cade.CM, len = ed.state.doc.length;
    from = Math.max(0, Math.min(from, len)); to = Math.max(from, Math.min(to, len));
    host.flash = { from: from, to: to };
    var eff = [CM.EditorView.scrollIntoView(from, { y: 'center' })];
    if (view) eff.push(view.refresh.of(null));
    ed.dispatch({ selection: { anchor: from, head: to }, effects: eff, userEvent: 'select.ekg' });
    if (!coarse() || ed.hasFocus) ed.focus();
    flashOff();
  }
  function flash(from, to) { host.flash = { from: from, to: to }; refreshView(); flashOff(); }
  function flashOff() {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flashTimer = 0; host.flash = null; if (isOpen) refreshView(); }, 1400);
  }
  function applyFix(is) {
    var ed = Cade.editor;
    if (!is || !is.fix) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    var f = is.fix;
    if (f.to > ed.state.doc.length || ed.state.doc.sliceString(f.from, f.to) !== f.expect) { render(); Cade.showToast('The text changed — have another look', 'info', 1800); return; }
    ed.dispatch({ changes: { from: f.from, to: f.to, insert: f.insert }, selection: { anchor: f.from + f.insert.length }, userEvent: 'input.ekg', scrollIntoView: true });
    if (Cade.haptic) Cade.haptic(8);
    clearTimeout(timer); timer = 0;
    render();
  }

  // ---- analysis for the panel ----------------------------------------------------------
  var blocksDoc = null, blocks = null;
  function blocksOf(doc) {
    if (blocksDoc !== doc) { blocks = core.scanBlocks(doc); blocksDoc = doc; }
    return blocks;
  }
  // The caret's paragraph: the block holding it, else the one before, else the first.
  function paraIndex(doc, head) {
    var bl = blocksOf(doc), i = core.blockAt(bl, head);
    return i < 0 ? (bl.length ? 0 : -1) : i;
  }
  function keyFor(doc, head) {
    if (prefs.scope === 'note') return 'note';
    var i = paraIndex(doc, head), bl = blocksOf(doc);
    return i < 0 ? 'none' : 'p' + bl[i].from;
  }
  function caretIndex(head) {
    if (!cur || !cur.sents.length) return -1;
    var i = core.sentenceAt(cur.sents, head);
    if (i < 0) return -1;
    var s = cur.sents[i], nx = cur.sents[i + 1];
    if (head <= s.to + 1) return i;
    return nx && head < nx.from && nx.block === s.block ? i : -1;
  }
  function render() {
    if (!isOpen || !P || !core || Cade.isMinimized(P)) return;
    if (document.hidden) return;
    var ed = Cade.editor, doc = ed.state.doc, head = ed.state.selection.main.head, r;
    var bl = blocksOf(doc);
    if (prefs.scope === 'note') r = an.analyze(doc, null, bl);
    else {
      var i = paraIndex(doc, head);
      r = i < 0 ? { blocks: [], sentences: [], issues: [], stats: core.stats([], []) } : an.analyze(doc, { from: bl[i].from, to: bl[i].to }, [bl[i]]);
    }
    lastKey = keyFor(doc, head);
    var list = [];
    for (var k = 0; k < r.issues.length; k++) if (prefs.cats[r.issues[k].cat]) list.push(r.issues[k]);
    cur = { scope: prefs.scope, sents: r.sentences, issues: r.issues, list: list, stats: r.stats, caret: -1, doc: doc, blocks: r.blocks };
    cur.caret = caretIndex(head);
    renderStats(r.stats);
    renderLegend(r.stats);
    renderList();
    draw();
  }

  function varietyWord(sd, n) { return n < 3 ? '' : sd < 3 ? 'flat' : sd < 5 ? 'steady' : sd < 9 ? 'varied' : 'jumpy'; }
  function renderStats(st) {
    var n = st.sentences;
    el.empty.hidden = n > 0;
    if (!n) el.empty.textContent = prefs.scope === 'note' ? 'No prose in this note yet' : 'Put the caret in a paragraph';
    function cell(v, label, tip, attr) { return '<div class="ekg-st"' + (tip ? ' title="' + esc(tip) + '"' : '') + (attr || '') + '><b>' + v + '</b><small>' + label + '</small></div>'; }
    var vw = varietyWord(st.sd, n);
    var longest = st.longest ? '<button type="button" class="ekg-jump" data-s="' + longestIndex() + '" title="Select the longest sentence">' + st.longest.words + '</button>' : '–';
    el.stats.innerHTML =
      cell(n, n === 1 ? 'sentence' : 'sentences', st.words + ' words') +
      cell(n ? st.mean : '–', 'avg words', 'Average sentence length') +
      cell(n > 1 ? st.sd : '–', 'variety' + (vw ? '<span class="ekg-vw"> · ' + vw + '</span>' : ''), 'Variety: standard deviation of sentence length' + (vw ? ' (' + vw + ')' : '') + ' — mixing short and long sentences reads better') +
      cell(longest, 'longest', 'Words in the longest sentence') +
      cell(n ? st.grade : '–', 'grade', 'Flesch–Kincaid reading grade');
  }
  function longestIndex() {
    var b = -1;
    for (var i = 0; i < cur.sents.length; i++) if (b < 0 || cur.sents[i].words > cur.sents[b].words) b = i;
    return b;
  }
  function renderLegend(st) {
    var c = st.classes, counts = { strip: st.sentences, tails: st.tails, complex: st.complex, grammar: st.byCat.grammar || 0, passive: st.byCat.passive || 0, filler: st.byCat.filler || 0 };
    var h = '';
    for (var i = 0; i < CATS.length; i++) {
      var k = CATS[i], sw = k.id === 'strip'
        ? '<span class="ekg-sw ekg-sw-strip"><i class="ekg-k-s"></i><i class="ekg-k-m"></i><i class="ekg-k-l"></i><i class="ekg-k-r"></i></span>'
        : '<span class="ekg-sw ekg-sw-' + k.id + '">ab</span>';
      h += '<button type="button" class="ekg-cat' + (prefs.cats[k.id] ? ' on' : '') + '" data-cat="' + k.id + '" aria-pressed="' + (prefs.cats[k.id] ? 'true' : 'false') + '" title="' + esc(k.tip) + '">' +
        sw + '<span class="ekg-cl">' + esc(k.label) + '</span><span class="ekg-cn">' + counts[k.id] + '</span></button>';
    }
    el.legend.innerHTML = h;
    el.key.innerHTML = '<span><i class="ekg-k-s"></i>short ' + c.s + '</span><span><i class="ekg-k-m"></i>medium ' + c.m + '</span>' +
      '<span><i class="ekg-k-l"></i>long ' + c.l + '</span><span><i class="ekg-k-r"></i>run-on ' + c.r + '</span>' +
      '<span><i class="ekg-k-cx"></i>very complex ' + st.complex + '</span>';
    var shown = cur.list.length;
    el.dsum.innerHTML = '<b>' + shown + '</b> ' + (shown === 1 ? 'issue' : 'issues') + (shown !== st.issues ? ' <span class="ekg-hid">(' + (st.issues - shown) + ' hidden)</span>' : '') + ' · marks';
  }
  function snippet(doc, is) {
    var bi = core.blockAt(cur.blocks, is.from), b = cur.blocks[bi] || { from: 0, to: doc.length };
    var a = Math.max(b.from, is.from - 30), z = Math.min(b.to, is.to + 30);
    var pre = doc.sliceString(a, is.from), mid = doc.sliceString(is.from, is.to), post = doc.sliceString(is.to, z);
    function clean(s) { return s.replace(/\s+/g, ' '); }
    return (a > b.from ? '…' : '') + esc(clean(pre)) + '<mark>' + esc(clean(mid)) + '</mark>' + esc(clean(post)) + (z < b.to ? '…' : '');
  }
  function fixLabel(f) { return f.insert === '' ? 'Remove “' + f.expect.trim() + '”' : 'Change to “' + f.insert + '”'; }
  function renderList() {
    var list = cur.list, doc = cur.doc, MAX = 200, h = '';
    if (!list.length) h = '<div class="ekg-none">' + (cur.issues.length ? 'Nothing in the categories that are on.' : cur.sents.length ? 'No issues found — nice.' : '') + '</div>';
    for (var k = 0; k < list.length && k < MAX; k++) {
      var is = list[k];
      h += '<div class="ekg-it" role="listitem" tabindex="0" data-k="' + k + '" title="Select it in the note">' +
        '<span class="ekg-dot ekg-c-' + is.cat + '"></span>' +
        '<span class="ekg-it-main"><span class="ekg-it-msg">' + esc(is.message) + '</span><span class="ekg-it-snip">' + snippet(doc, is) + '</span></span>' +
        (is.fix ? '<button type="button" class="ekg-fix" data-k="' + k + '" title="' + esc(fixLabel(is.fix)) + '">Fix</button>' : '') +
        '</div>';
    }
    if (list.length > MAX) h += '<div class="ekg-none">…and ' + (list.length - MAX) + ' more</div>';
    el.list.innerHTML = h;
  }

  // ---- the monitor ---------------------------------------------------------------------
  function cssVar(name, fb) { var v = getComputedStyle(P).getPropertyValue(name); return (v && v.trim()) || fb; }
  function draw() {
    if (!P || !cur || !el.cv) return;
    var cv = el.cv, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var col = { s: cssVar('--ekg-short', '#14b8a6'), m: cssVar('--ekg-medium', '#22c55e'), l: cssVar('--ekg-long', '#f59e0b'), r: cssVar('--ekg-run', '#ef4444'),
      cx: cssVar('--ekg-cx', '#a855f7'), grid: cssVar('--ekg-grid', 'rgba(127,127,127,0.12)'), major: cssVar('--ekg-grid-major', 'rgba(127,127,127,0.22)'),
      faint: cssVar('--text-faint', '#999'), accent: cssVar('--accent', '#0f9598') };
    // paper / monitor grid
    var x, y;
    ctx.lineWidth = 1;
    for (x = 0.5, y = 0; x < W; x += 8, y++) { ctx.strokeStyle = y % 5 === 0 ? col.major : col.grid; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (y = H - 0.5, x = 0; y > 0; y -= 8, x++) { ctx.strokeStyle = x % 5 === 0 ? col.major : col.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    var y0 = H - Math.max(10, Math.round(H * 0.16)), top = 6, CAP = 45;
    function hOf(w) { return Math.min(w, CAP) / CAP * (y0 - top); }
    // length guides at the class limits (8 / 20 / 30 words); labels only where they fit
    ctx.font = '9px ' + (cssVar('--font-mono', 'monospace'));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    var lastLabel = 1e9;
    [8, 20, 30].forEach(function (g) {
      var gy = Math.round(y0 - hOf(g)) + 0.5;
      ctx.strokeStyle = col.faint; ctx.globalAlpha = 0.45; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W - 16, gy); ctx.stroke();
      ctx.setLineDash([]);
      if (lastLabel - gy >= 10) { ctx.globalAlpha = 0.8; ctx.fillStyle = col.faint; ctx.fillText(String(g), W - 2, gy); lastLabel = gy; }
      ctx.globalAlpha = 1;
    });
    var sents = cur.sents, n = sents.length;
    // beats: one per sentence, or per bucket of sentences (the longest stands for it) when crowded
    var avail = W - 20, x0 = 4, beats = [], i, k;
    var maxBeats = Math.max(1, Math.floor(avail / 5));
    if (n <= maxBeats) for (i = 0; i < n; i++) beats.push(i);
    else for (k = 0; k < maxBeats; k++) {
      var a = Math.floor(k * n / maxBeats), b = Math.max(a + 1, Math.floor((k + 1) * n / maxBeats)), best = a;
      for (i = a; i < b; i++) if (sents[i].words > sents[best].words) best = i;
      beats.push(best);
      beats['r' + k] = [a, b];
    }
    var slot = beats.length ? Math.min(58, avail / beats.length) : 58;
    mon = { x0: x0, slot: slot, beats: beats, n: n };
    var glow = dark ? 7 : 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = slot < 8 ? 1.2 : 1.7;
    var caretBeat = -1;
    for (k = 0; k < beats.length; k++) {
      var s = sents[beats[k]], bx = x0 + k * slot, h = hOf(s.words), c = col[s.cls];
      if (beats['r' + k] ? (cur.caret >= beats['r' + k][0] && cur.caret < beats['r' + k][1]) : beats[k] === cur.caret) caretBeat = k;
      ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = glow;
      ctx.beginPath();
      ctx.moveTo(bx, y0);
      if (slot < 9) { ctx.lineTo(bx + slot * 0.5, y0 - h); ctx.lineTo(bx + slot, y0); }
      else {
        var w = slot;
        ctx.lineTo(bx + 0.12 * w, y0);
        ctx.quadraticCurveTo(bx + 0.2 * w, y0 - Math.max(2, 0.1 * h), bx + 0.28 * w, y0);   // P
        ctx.lineTo(bx + 0.40 * w, y0);
        ctx.lineTo(bx + 0.45 * w, y0 + 1 + 0.05 * h);                                       // Q
        ctx.lineTo(bx + 0.50 * w, y0 - h);                                                  // R: the sentence
        ctx.lineTo(bx + 0.56 * w, y0 + 2 + 0.12 * h);                                       // S
        ctx.lineTo(bx + 0.62 * w, y0);
        ctx.quadraticCurveTo(bx + 0.76 * w, y0 - Math.max(2, 0.18 * h), bx + 0.9 * w, y0);  // T
        ctx.lineTo(bx + w, y0);
      }
      ctx.stroke();
      if (s.complex) {                                         // very complex: a purple diamond over the spike
        var px = bx + slot * 0.5, py = y0 - h - 5;
        ctx.shadowBlur = 0; ctx.fillStyle = col.cx;
        ctx.beginPath(); ctx.moveTo(px, py - 3); ctx.lineTo(px + 3, py); ctx.lineTo(px, py + 3); ctx.lineTo(px - 3, py); ctx.closePath(); ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
    // the flat line runs on after the last beat
    var endX = x0 + beats.length * slot;
    if (endX < W - 18) { ctx.strokeStyle = col.faint; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(endX, y0); ctx.lineTo(W - 18, y0); ctx.stroke(); ctx.globalAlpha = 1; }
    // the caret's sentence
    if (caretBeat >= 0) {
      var cs = sents[beats[caretBeat]], cx = x0 + caretBeat * slot + slot * 0.5, cy = y0 - hOf(cs.words);
      ctx.strokeStyle = col.accent; ctx.globalAlpha = 0.55; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, 2); ctx.lineTo(Math.round(cx) + 0.5, H - 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = col[cs.cls]; ctx.shadowColor = col[cs.cls]; ctx.shadowBlur = dark ? 10 : 4;
      ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = cssVar('--surface', '#fff'); ctx.lineWidth = 1.2; ctx.stroke();
    }
    el.cv.setAttribute('data-beats', String(beats.length));
    el.cv.setAttribute('data-caret', String(caretBeat));
  }
  function onMonitorTap(e) {
    if (!mon || !cur || !mon.beats.length) return;
    var r = el.cv.getBoundingClientRect(), x = e.clientX - r.left;
    var k = Math.floor((x - mon.x0) / mon.slot);
    if (k < 0 || k >= mon.beats.length) { if (k >= mon.beats.length && x < mon.x0 + mon.beats.length * mon.slot + 12) k = mon.beats.length - 1; else return; }
    var s = cur.sents[mon.beats[k]];
    if (s) select(s.from, s.to);
  }

  Cade.registerWidget({
    name: 'Prose EKG',
    description: 'Your writing’s heartbeat: sentence lengths as an EKG, run-on tails, complex sentences, passive voice and grammar slips marked right in the note',
    icon: '〰',
    tags: 'writing,prose,sentences,sentence length,rhythm,readability,grammar,style,passive voice,run-on,lint,proofread,ekg',
    open: open,
    close: close
  });
})();
