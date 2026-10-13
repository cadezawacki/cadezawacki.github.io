/* Calculator — a scratch calculator panel. Type an expression and see the
 * result live; Enter saves "expr = result" to a history (persisted, last 100);
 * ↑/↓ recall earlier lines; variables (x = 5) and `ans` carry across lines for
 * the session. Insert the result (or "expr = result") at the editor cursor,
 * or copy it. A compact keypad helps on phones.
 *
 * The maths lives in calc-engine.js (shared with the Unit Converter and the
 * inline-math plugin), loaded on first open. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('calc.css');
  var ENGINE_URL = Cade.asset('calc-engine.js'); // resolve now, while currentScript is us
  var esc = Cade.escapeHtml;

  var PANEL_ID = 'calc-panel';
  var HIST_KEY = 'cade-calc-history';
  var PREFS_KEY = 'cade-calc-prefs';
  var MAX_HIST = 100;

  var engine = null;
  var scope = null;            // variables + ans for this session (survives close/reopen)
  var prefs = { thousands: true, keypad: null };
  var hist = [];               // [{e, r}] oldest first
  var recall = -1, draft = '';  // ↑/↓ history browsing
  var preview = null;          // last evaluation of the input line

  // ---- shared engine loader (one <script> no matter which module asks first) ----
  function loadEngine() {
    if (window.__cadeCalcEngine) return Promise.resolve(window.__cadeCalcEngine);
    if (window.__cadeCalcEngineLoading) return window.__cadeCalcEngineLoading;
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ENGINE_URL; s.async = true;
      s.onload = function () { if (window.__cadeCalcEngine) resolve(window.__cadeCalcEngine); else reject(new Error('no engine')); };
      s.onerror = function () { reject(new Error('engine load failed')); };
      document.head.appendChild(s);
    });
    window.__cadeCalcEngineLoading = p;
    p.then(null, function () { window.__cadeCalcEngineLoading = null; });
    return p;
  }

  // ---- persistence ------------------------------------------------------------
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }
  function loadState() {
    var p = readJSON(PREFS_KEY, {});
    if (typeof p.thousands === 'boolean') prefs.thousands = p.thousands;
    prefs.keypad = typeof p.keypad === 'boolean' ? p.keypad : null;
    var h = readJSON(HIST_KEY, []);
    hist = Array.isArray(h) ? h.filter(function (x) { return x && typeof x.e === 'string' && typeof x.r === 'string'; }).slice(-MAX_HIST) : [];
  }
  function saveHist() { writeJSON(HIST_KEY, hist.slice(-MAX_HIST)); }
  function savePrefs() { writeJSON(PREFS_KEY, prefs); }
  function isTouch() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  // ---- evaluation ---------------------------------------------------------------
  // Live preview runs on a COPY of the scope so typing "x = 5" doesn't assign
  // (or move `ans`) until Enter.
  function evalPreview(src) {
    if (!engine) return null;
    var tmp = { vars: {}, ans: scope.ans };
    for (var k in scope.vars) tmp.vars[k] = scope.vars[k];
    return engine.evaluate(src, { scope: tmp, thousands: prefs.thousands, setAns: false });
  }

  // ---- actions --------------------------------------------------------------------
  function copyText(text) {
    var done = function () { Cade.showToast('Copied ' + text, 'success', 1400); };
    var fail = function () { Cade.showToast('Copy failed', 'error', 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      ta.remove();
    }
  }
  function insertText(text) {
    var ed = Cade.editor;
    if (!ed || !text) return;
    if (ed.state.readOnly) { Cade.showToast('Read-only mode — editing is locked', 'error', 2000); return; }
    ed.dispatch(ed.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
    Cade.showToast('Inserted ' + (text.length > 40 ? text.slice(0, 40) + '…' : text), 'success', 1200);
  }
  // What the action buttons act on: the live line if it evaluates, else the
  // newest history entry.
  function current() {
    var p = panel(), inp = p && p.querySelector('.ca-in');
    var src = inp ? inp.value.trim().replace(/=\s*$/, '').trim() : '';
    if (src && preview && preview.ok) return { e: src, r: preview.text };
    return hist.length ? hist[hist.length - 1] : null;
  }

  function commit() {
    var p = panel(); if (!p || !engine) return;
    var inp = p.querySelector('.ca-in');
    var src = inp.value.trim().replace(/=\s*$/, '').trim();
    if (!src) return;
    var r = engine.evaluate(src, { scope: scope, thousands: prefs.thousands });
    if (!r.ok) {
      p.querySelector('.ca-prev').classList.add('err', 'shake');
      setTimeout(function () { var q = panel(); if (q) q.querySelector('.ca-prev').classList.remove('shake'); }, 400);
      return;
    }
    hist.push({ e: src, r: r.text });
    if (hist.length > MAX_HIST) hist = hist.slice(-MAX_HIST);
    saveHist();
    inp.value = '';
    recall = -1; draft = '';
    renderHist(true);
    renderVars();
    update();
  }

  // ---- rendering ------------------------------------------------------------------
  function panel() { return document.getElementById(PANEL_ID); }

  function renderHist(scroll) {
    var p = panel(); if (!p) return;
    var box = p.querySelector('.ca-hist');
    if (!hist.length) {
      box.innerHTML = '<div class="ca-empty">Results you save with Enter show up here.<br>Try <b>5 km in mi</b>, <b>20% of 80</b>, <b>x = 3</b> then <b>x^2</b>.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < hist.length; i++) {
      html += '<div class="ca-item" data-i="' + i + '" title="Click to reuse">' +
        '<span class="ca-e">' + esc(hist[i].e) + '</span>' +
        '<span class="ca-r">= ' + esc(hist[i].r) + '</span>' +
        '<span class="ca-ia"><button class="ca-ib" data-act="h-copy" title="Copy result" aria-label="Copy result">⧉</button>' +
        '<button class="ca-ib" data-act="h-ins" title="Insert result at cursor" aria-label="Insert result">↵</button></span></div>';
    }
    box.innerHTML = html;
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  function renderVars() {
    var p = panel(); if (!p || !scope) return;
    var box = p.querySelector('.ca-vars');
    var names = Object.keys(scope.vars);
    if (!names.length && !scope.ans) { box.hidden = true; box.innerHTML = ''; return; }
    var html = '';
    if (scope.ans) html += '<button class="ca-var" data-ins="ans" title="Insert ans">ans</button>';
    names.slice(-12).forEach(function (n) {
      var r = engine.evaluate(n, { scope: scope, setAns: false, thousands: prefs.thousands });
      html += '<button class="ca-var" data-ins="' + esc(n) + '" title="' + esc(n + ' = ' + (r.ok ? r.text : '?')) + '">' + esc(n) + '<span>' + esc(r.ok ? r.text : '') + '</span></button>';
    });
    box.innerHTML = html;
    box.hidden = false;
  }

  function update() {
    var p = panel(); if (!p) return;
    var inp = p.querySelector('.ca-in'), out = p.querySelector('.ca-prev');
    var src = inp.value.trim();
    if (!engine) { out.className = 'ca-prev'; out.textContent = 'Loading…'; return; }
    preview = src ? evalPreview(src) : null;
    out.classList.remove('err', 'shake');
    if (!preview || preview.empty) {
      var last = hist[hist.length - 1];
      out.innerHTML = last ? '<span class="ca-dim">ans = ' + esc(last.r) + '</span>' : '<span class="ca-dim">= </span>';
    } else if (preview.ok) {
      out.innerHTML = '<span class="ca-eq">' + (preview.assigned ? esc(preview.assigned) + ' = ' : '= ') + '</span><span class="ca-val" title="Click to copy">' + esc(preview.text) + '</span>';
    } else {
      out.classList.add('err');
      out.textContent = preview.error;
    }
  }

  function renderToggles() {
    var p = panel(); if (!p) return;
    var t = p.querySelector('[data-act="thousands"]'), k = p.querySelector('[data-act="keypad"]');
    var showPad = prefs.keypad == null ? isTouch() : prefs.keypad;
    t.classList.toggle('on', prefs.thousands); t.setAttribute('aria-pressed', String(prefs.thousands));
    k.classList.toggle('on', showPad); k.setAttribute('aria-pressed', String(showPad));
    p.querySelector('.ca-pad').hidden = !showPad;
  }

  var KEYS = [
    ['7', '7'], ['8', '8'], ['9', '9'], ['÷', '/'], ['(', '('], [')', ')'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['×', '*'], ['^', '^'], ['√', 'sqrt('],
    ['1', '1'], ['2', '2'], ['3', '3'], ['−', '-'], ['%', '%'], ['π', 'pi'],
    ['0', '0'], ['.', '.'], ['ans', 'ans'], ['+', '+'], ['⌫', 'BS'], ['=', 'EQ']
  ];
  function padHtml() {
    return KEYS.map(function (k) {
      var cls = 'ca-key' + (/^[0-9.]$/.test(k[0]) ? ' num' : '') + (k[1] === 'EQ' ? ' eq' : '');
      return '<button class="' + cls + '" data-key="' + esc(k[1]) + '" tabindex="-1">' + esc(k[0]) + '</button>';
    }).join('');
  }

  // Type into the input at its caret (keypad + variable chips).
  function typeIntoInput(text) {
    var p = panel(); if (!p) return;
    var inp = p.querySelector('.ca-in');
    var s = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
    var e = inp.selectionEnd == null ? inp.value.length : inp.selectionEnd;
    if (text === 'BS') {
      if (s === e && s > 0) s--;
      inp.value = inp.value.slice(0, s) + inp.value.slice(e);
      inp.setSelectionRange(s, s);
    } else {
      inp.value = inp.value.slice(0, s) + text + inp.value.slice(e);
      inp.setSelectionRange(s + text.length, s + text.length);
    }
    recall = -1;
    update();
  }

  function recallHist(dir) {
    var p = panel(); if (!p || !hist.length) return;
    var inp = p.querySelector('.ca-in');
    if (recall === -1) { if (dir > 0) return; draft = inp.value; recall = hist.length; }
    recall += dir;
    if (recall < 0) recall = 0;
    if (recall >= hist.length) { recall = -1; inp.value = draft; }
    else inp.value = hist[recall].e;
    var n = inp.value.length;
    inp.setSelectionRange(n, n);
    update();
  }

  function close() {
    var p = panel();
    if (!p) return;
    p.remove();
    if (p._onClose) p._onClose();
  }

  function onKey(e) {
    var p = panel(); if (!p) return;
    var inInput = e.target.classList && e.target.classList.contains('ca-in');
    if (e.key === 'Escape') { e.preventDefault(); close(); try { Cade.editor.focus(); } catch (x) {} }
    else if (e.key === 'Enter' && inInput) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { var c = current(); if (c) insertText(c.r); }
      else commit();
    }
    else if (e.key === 'ArrowUp' && inInput) { e.preventDefault(); recallHist(-1); }
    else if (e.key === 'ArrowDown' && inInput) { e.preventDefault(); recallHist(1); }
    e.stopPropagation(); // keep editor/global shortcuts out of the panel
  }

  function selectionText() {
    try {
      var ed = Cade.editor, sel = ed.state.selection.main;
      if (sel.empty || sel.to - sel.from > 300) return '';
      var s = ed.state.sliceDoc(sel.from, sel.to).trim();
      return s.indexOf('\n') === -1 ? s.replace(/\s*=\s*$/, '') : '';
    } catch (e) { return ''; }
  }

  function open() {
    Cade.closeAllMenus();
    var pre = selectionText();
    var existing = panel();
    if (existing) {
      var qi = existing.querySelector('.ca-in');
      if (pre) { qi.value = pre; update(); }
      qi.focus();
      return;
    }
    loadState();
    var p = Cade.mkPanel(PANEL_ID, '🧮 Calculator',
      '<div class="ca-hist" role="log" aria-label="History"></div>' +
      '<div class="ca-vars" hidden></div>' +
      '<input class="ca-in" type="text" placeholder="2+2, 5 km in mi, 20% of 80, x = 3" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Expression">' +
      '<div class="ca-prev" aria-live="polite">Loading…</div>' +
      '<div class="ca-acts">' +
        '<button class="ca-btn primary" data-act="insert" title="Insert the result at the cursor (Ctrl+Enter)">↵ Insert</button>' +
        '<button class="ca-btn" data-act="insert-eq" title="Insert “expression = result”">= Insert both</button>' +
        '<button class="ca-btn" data-act="copy" title="Copy the result">⧉ Copy</button>' +
        '<span class="ca-sp"></span>' +
        '<button class="ca-btn ca-tog" data-act="thousands" title="Thousands separators">1,000</button>' +
        '<button class="ca-btn ca-tog" data-act="keypad" title="Show keypad">⌨</button>' +
      '</div>' +
      '<div class="ca-pad" hidden>' + padHtml() + '</div>' +
      '<div class="ca-foot"><span>Enter save · ↑↓ history · Esc close</span><button class="ca-link" data-act="clear">Clear history</button></div>');

    var inp = p.querySelector('.ca-in');
    if (pre) inp.value = pre;
    renderHist(true);
    renderToggles();

    p.addEventListener('keydown', onKey);
    inp.addEventListener('input', function () { recall = -1; update(); });
    p.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var b = t.closest('[data-act], [data-key], [data-ins], .ca-item, .ca-val');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (b.hasAttribute('data-key')) { typeKey(b.getAttribute('data-key')); return; }
      if (b.hasAttribute('data-ins')) { typeIntoInput(b.getAttribute('data-ins')); inp.focus(); return; }
      var item = b.closest('.ca-item'), h = item ? hist[+item.getAttribute('data-i')] : null;
      if (act === 'h-copy' && h) copyText(h.r);
      else if (act === 'h-ins' && h) insertText(h.r);
      else if (!act && h) { inp.value = h.e; recall = -1; update(); inp.focus(); var n = inp.value.length; inp.setSelectionRange(n, n); }
      else if (b.classList.contains('ca-val')) { if (preview && preview.ok) copyText(preview.text); }
      else if (act === 'insert') { var c = current(); if (c) insertText(c.r); else Cade.showToast('Nothing to insert yet', 'info', 1400); }
      else if (act === 'insert-eq') { var c2 = current(); if (c2) insertText(c2.e + ' = ' + c2.r); else Cade.showToast('Nothing to insert yet', 'info', 1400); }
      else if (act === 'copy') { var c3 = current(); if (c3) copyText(c3.r); }
      else if (act === 'thousands') { prefs.thousands = !prefs.thousands; savePrefs(); renderToggles(); renderVars(); update(); }
      else if (act === 'keypad') { prefs.keypad = p.querySelector('.ca-pad').hidden; savePrefs(); renderToggles(); }
      else if (act === 'clear') {
        if (!hist.length) return;
        hist = []; saveHist(); renderHist(); update();
        Cade.showToast('History cleared', 'info', 1200);
      }
    });
    function typeKey(k) {
      if (k === 'EQ') commit(); else typeIntoInput(k);
    }
    // Keypad / buttons shouldn't steal focus from the input (keeps the caret).
    p.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.ca-key, .ca-var, .ca-ib')) e.preventDefault();
    });
    p._onClose = function () { recall = -1; preview = null; };

    update();
    loadEngine().then(function (E) {
      engine = E;
      if (!scope) scope = E.createScope();
      if (!panel()) return;
      renderVars();
      update();
    }, function () {
      var q = panel();
      if (q) { var o = q.querySelector('.ca-prev'); o.classList.add('err'); o.textContent = 'Couldn’t load the calculator engine' + (navigator.onLine ? '' : ' — it needs one online load to cache'); }
    });
    if (!isTouch()) setTimeout(function () { inp.focus(); var n = inp.value.length; inp.setSelectionRange(n, n); }, 0);
  }

  Cade.registerWidget({
    name: 'Calculator',
    description: 'Scratch calculator with units, %, variables & history — insert results',
    icon: '🧮',
    tags: 'calc,calculator,math,compute,arithmetic,percent,units,convert,expression',
    open: open,
  });
})();
