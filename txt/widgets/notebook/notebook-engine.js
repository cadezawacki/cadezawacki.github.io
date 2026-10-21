/* Notebook engine — linked, reactive code blocks ("a Jupyter replacement").
 *
 * With linked blocks on (Cade.prefs('codeblocks') 'linked', default on) the
 * ```js / ```ts blocks of a note share ONE live JavaScript scope and its
 * ```python blocks one Python namespace, so `a = 1` in one block is `a` in
 * the next. Each block is a cell:
 * - Runs go through a queue, one at a time. After a block you ran finishes,
 *   the blocks that read what it defines (name analysis in notebook-core.js)
 *   are marked stale and — with "auto-run" on — re-run in dependency order;
 *   an error stops that chain (the rest stay stale), a cycle is reported
 *   instead of looping. Editing a block marks it stale until it runs again.
 * - State per block is shown on the Run chip (✓ time / ● stale / ✕ error /
 *   spinner while running) by the "Run buttons" plugin, via badgeAt().
 * - Output appears under the block as a view-only widget (console, the last
 *   expression's value, errors with line numbers, tables, JSON trees,
 *   HTML/SVG in a sandboxed frame, images, charts via display()). It is not
 *   written into the note — unless the block already has an ```output block
 *   (Code Runner's convention: kept up to date) or "Also save text output"
 *   is on; "As text" writes one on demand.
 * - JavaScript: one persistent <iframe sandbox="allow-scripts"> per note
 *   (opaque origin — no access to the app, its storage or sync keys), see
 *   NB_LIB in notebook-core.js. Stop asks it to abandon the run; if it
 *   doesn't answer, the frame is destroyed (scope lost, blocks go stale).
 * - Python: Code Runner's Pyodide sandbox, this room's namespace, through
 *   E._nb (coderun-engine.js); display(), rich values, matplotlib figures.
 *
 * Nothing here exists until a block is run or the Notebook panel opens; the
 * editor extension (output widgets) and every listener are added on the
 * first run and removed on teardown: room switch (scope is per note), linked
 * blocks turned off, the "Run buttons" plugin turned off.
 *
 * Loaded by coderun-engine.js (E._loadNotebook) after notebook-core.js.
 * Exposes window.__cadeNotebook. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined' || window.__cadeNotebook) return;
  var Cade = window.Cade, NC = window.__cadeNotebookCore, E = window.__cadeCodeRun;
  if (!NC || !E || !E._nb) return;
  var K = E._nb.K, CM = Cade.CM;
  Cade.loadCSS('notebook.css');

  var PLUGIN_ID = 'notebook-outputs', PANEL_ID = 'notebook-panel';
  var MAX_ITEMS = 400, LANG_LABEL = { js: 'JS', ts: 'TS', py: 'PY' };
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, type, ms) { try { Cade.showToast(m, type || 'info', ms || 2600); } catch (e) {} }
  function msg(e) { return String((e && (e.message || e)) || 'error'); }
  function roomKey() { try { var r = Cade.roomsApi && Cade.roomsApi.activeRoom(); return r ? String(r) : 'default'; } catch (e) { return 'default'; } }
  function clamp(v, a, b) { v = Math.round(+v || 0); return Math.max(a, Math.min(b, v)); }
  function hm() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  var CB = NC.prefsOf(Cade, 'codeblocks', NC.CODEBLOCK_FIELDS);
  var NP = NC.prefsOf(Cade, 'notebook', NC.PREFS.fields);
  var DEF = {};
  NC.PREFS.fields.forEach(function (f) { if (f.key) DEF[f.key] = f.default; });
  function pref(k) { var v; try { v = NP.get(k); } catch (e) {} return v == null ? DEF[k] : v; }
  function linked() { try { return CB.get('linked') !== false; } catch (e) { return true; } }

  var S = null;      // this note's notebook: cells, queue, runtimes (null until the first run)
  var N = window.__cadeNotebook = { version: 0 };

  // ---- refresh plumbing ----------------------------------------------------------------------
  function bump() {
    N.version++;
    try { E._nb.bump(); } catch (e) {} // re-renders the Run chips
    renderPanelSoon();
  }
  var decoT = 0, syncT = 0;
  function scheduleDecos() { if (!decoT) decoT = setTimeout(function () { decoT = 0; applyDecos(); }, 50); }
  function touch(c) { c.ver++; scheduleDecos(); }

  // ---- cells ------------------------------------------------------------------------------------
  function newCell(openFrom, lang) {
    return { id: ++S.nextId, lang: lang, rt: NC.RT[lang], openFrom: openFrom, block: null, code: null, an: null,
      ran: null, status: 'idle', stale: '', out: null, ver: 0, n: 0, queued: false, running: false, statusText: '', detected: false };
  }
  // Re-read the fences: match blocks to cells by their (mapped) opening position.
  function sync() {
    var ed = Cade.editor;
    if (!S || !ed) return;
    var doc = ed.state.doc, cells = [], by = {};
    K.scanFences(doc).forEach(function (b) {
      if (b.close === -1) return;
      var c = S.byFrom[b.openFrom], lang = b.lang && NC.RT[b.lang] ? b.lang : null;
      if (!lang && c && c.detected && !String(b.info || '').trim()) lang = c.lang; // untagged, run as a detected language
      if (!lang) return;
      if (c && NC.RT[lang] !== c.rt) c = null;
      if (!c) c = newCell(b.openFrom, lang);
      c.lang = lang; c.block = b; c.openFrom = b.openFrom;
      var code = K.codeOf(doc, b).text;
      if (code !== c.code) { c.code = code; c.an = null; }
      cells.push(c);
      by[b.openFrom] = c;
    });
    S.cells = cells;
    S.byFrom = by;
    S.synced = doc;
  }
  function ensureSynced() { var ed = Cade.editor; if (S && ed && S.synced !== ed.state.doc) sync(); }
  function analysis(c) { return c.an || (c.an = NC.analyze(c.lang, c.code || '')); }
  function cellById(id) { if (!S) return null; for (var i = 0; i < S.cells.length; i++) if (S.cells[i].id === id) return S.cells[i]; return null; }
  function lineOf(c) { return c && c.block ? c.block.open : 0; }
  function edited(c) { return !!(c.ran && c.code !== c.ran.code); }
  function badge(c) {
    if (c.running) return { s: 'running', t: c.statusText || 'Running…' };
    if (c.queued) return { s: 'queued', t: 'Queued' };
    if (!c.ran) return null;
    var ms = c.out && c.out.ms != null ? NC.fmtMs(c.out.ms) : '';
    if (edited(c)) return { s: 'stale', t: 'stale', why: 'Edited since it ran — run it again' };
    if (c.stale) return { s: 'stale', t: 'stale', why: c.stale };
    if (c.status !== 'ok') return { s: 'error', t: ms, why: c.status === 'timeout' ? 'Timed out' : c.status === 'stopped' ? 'Stopped' : 'Error' };
    return { s: 'fresh', t: ms, why: 'Up to date' + (c.n ? ' · run [' + c.n + ']' : '') };
  }

  // ---- the editor extension: output widgets under the blocks -----------------------------------
  var setDecos = CM.StateEffect.define();
  var field = CM.StateField.define({
    create: function () { return CM.Decoration.none; },
    update: function (v, tr) {
      if (tr.docChanged) {
        v = v.map(tr.changes);
        // keep the cells' positions in step with every edit, before any plugin
        // (the Run chips) asks for a block's state in this same update
        if (S && tr.startState.doc === S.doc) {
          S.cells.forEach(function (c) { c.openFrom = tr.changes.mapPos(c.openFrom, 1); });
          var by = {};
          S.cells.forEach(function (c) { by[c.openFrom] = c; });
          S.byFrom = by;
          S.doc = tr.state.doc;
        }
      }
      for (var i = 0; i < tr.effects.length; i++) if (tr.effects[i].is(setDecos)) v = tr.effects[i].value;
      return v;
    },
    provide: function (f) { return CM.EditorView.decorations.from(f); }
  });
  function applyDecos() {
    var ed = Cade.editor;
    if (!ed) return;
    var set = CM.Decoration.none;
    if (S) {
      ensureSynced();
      var doc = ed.state.doc, ranges = [];
      S.cells.forEach(function (c) {
        if (!c.out || !c.block || c.block.close > doc.lines) return;
        var ex = K.findOutputAfter(doc, c.block), saved = !!(ex && c.out.saved);
        var res = c.out.result, show = visibleItems(c, saved).length || c.out.dropped ||
          (saved ? !!(res && res.k !== 'text') : !!(c.out.error || res));
        if (!show) return;
        var pos = ex ? ex.to : doc.line(c.block.close).to;
        ranges.push(CM.Decoration.widget({ widget: new OutWidget(c, saved), block: true, side: 1 }).range(pos));
      });
      set = CM.Decoration.set(ranges, true);
    }
    try { ed.dispatch({ effects: setDecos.of(set) }); } catch (e) {}
  }
  // what the widget shows: everything, or (text already saved in the note) only what text can't hold
  function visibleItems(c, saved) {
    var items = c.out ? c.out.items : [];
    if (!saved) return items;
    return items.filter(function (it) { return it.k !== 'log' && it.k !== 'text'; });
  }

  function OutWidget(c, saved) {
    this.c = c;
    this.saved = saved;
    this.key = c.id + ':' + c.ver + ':' + (saved ? 1 : 0) + ':' + (badge(c) || { s: '' }).s + ':' + (c.stale || '') + ':' + (pref('timings') ? 1 : 0);
  }
  OutWidget.prototype = Object.create(CM.WidgetType.prototype);
  OutWidget.prototype.constructor = OutWidget;
  OutWidget.prototype.eq = function (o) { return o.key === this.key; };
  OutWidget.prototype.toDOM = function () {
    var root = document.createElement('div');
    root.className = 'nb-out';
    root.setAttribute('contenteditable', 'false');
    root.__nbCell = this.c.id;
    root.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });
    root.addEventListener('click', onOutClick);
    renderOut(root, this.c, this.saved);
    return root;
  };
  // same block: patch in place (appending to a running block's output keeps its frames alive)
  OutWidget.prototype.updateDOM = function (dom) {
    if (dom.__nbCell !== this.c.id) return false;
    renderOut(dom, this.c, this.saved);
    return true;
  };
  OutWidget.prototype.ignoreEvent = function () { return true; };
  OutWidget.prototype.destroy = function (dom) { dropFrames(dom); };
  Object.defineProperty(OutWidget.prototype, 'estimatedHeight', { get: function () { return 64; } });

  // ---- rendering output -------------------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderOut(root, c, saved) {
    var o = c.out || { items: [] }, b = badge(c) || { s: '' }, stale = b.s === 'stale';
    root.className = 'nb-out' + (stale ? ' nb-stale' : '') + (o.error ? ' nb-has-err' : '') + (c.running ? ' nb-running' : '');
    // (no margins on the widget itself: CodeMirror measures its border box)
    var box = root.firstElementChild;
    if (!box) { box = el('div', 'nb-out-box'); root.appendChild(box); }
    var head = box.querySelector(':scope > .nb-out-head');
    if (!head) { head = el('div', 'nb-out-head'); box.insertBefore(head, box.firstChild); }
    var meta = c.running ? (c.statusText || 'Running…') : (stale ? '● ' + (b.why || 'stale') : (pref('timings') && o.ms != null ? NC.fmtMs(o.ms) : ''));
    head.innerHTML = '<span class="nb-out-n">' + (c.running ? 'Out […]' : 'Out [' + (c.n || ' ') + ']') + '</span>' +
      '<span class="nb-out-meta' + (stale ? ' nb-meta-stale' : '') + '">' + esc(meta) + '</span>' +
      '<span class="nb-out-acts">' +
        '<button type="button" data-a="copy" title="Copy the output as text">Copy</button>' +
        '<button type="button" data-a="text" title="Insert the output as text below the block (```output)">As text</button>' +
        '<button type="button" data-a="clear" title="Clear this output" aria-label="Clear this output">×</button>' +
      '</span>';
    var body = box.querySelector(':scope > .nb-out-body');
    if (!body) { body = el('div', 'nb-out-body'); box.appendChild(body); }
    body.style.maxHeight = clamp(pref('maxHeight'), 120, 800) + 'px';
    // items render incrementally while the same run streams in
    var items = visibleItems(c, saved), runKey = o.run || 0;
    if (body.__nbRun !== runKey || (body.__nbCount || 0) > items.length || body.__nbSaved !== saved) {
      dropFrames(body);
      body.innerHTML = '';
      body.__nbRun = runKey; body.__nbCount = 0; body.__nbSaved = saved; body.__nbLog = null;
    }
    var oldTail = body.querySelectorAll(':scope > .nb-tail');
    for (var ti = 0; ti < oldTail.length; ti++) { dropFrames(oldTail[ti]); oldTail[ti].remove(); }
    // a streamed chunk that grew since it was drawn (Python stdout)
    var lastDrawn = items[(body.__nbCount || 0) - 1];
    if (lastDrawn && lastDrawn.k === 'log' && body.__nbLog && (body.__nbLastLen || 0) < lastDrawn.text.length) {
      body.__nbLog.appendChild(document.createTextNode(lastDrawn.text.slice(body.__nbLastLen || 0)));
      body.__nbLastLen = lastDrawn.text.length;
    }
    for (var i = body.__nbCount || 0; i < items.length; i++) {
      var it = items[i];
      if (it.k === 'log') {
        var pre = body.__nbLog;
        if (!pre || pre !== body.lastElementChild) { pre = body.__nbLog = el('pre', 'nb-log'); body.appendChild(pre); }
        appendLog(pre, it);
        body.__nbLastLen = it.text.length;
      } else {
        body.__nbLog = null;
        body.appendChild(renderItem(it));
      }
    }
    body.__nbCount = items.length;
    // value and error: re-rendered each time (they come once, at the end)
    if (o.dropped) body.appendChild(el('div', 'nb-note nb-tail', '… ' + o.dropped + ' more output line' + (o.dropped === 1 ? '' : 's') + ' not shown'));
    if (o.result && !(saved && (o.result.k === 'text'))) {
      var res = el('div', 'nb-res nb-tail');
      res.appendChild(el('span', 'nb-arrow', '→'));
      res.appendChild(renderItem(o.result));
      body.appendChild(res);
    }
    if (o.error && !saved) body.appendChild(renderError(c, o.error));
    body.hidden = !body.childNodes.length;
    remeasure();
  }
  function appendLog(pre, it) {
    var t = String(it.text);
    if (!it.raw && pre.childNodes.length) t = '\n' + t;
    if (it.level === 'warn' || it.level === 'error') {
      var sp = el('span', it.level === 'warn' ? 'nb-l-warn' : 'nb-l-error', t);
      pre.appendChild(sp);
    } else pre.appendChild(document.createTextNode(t));
  }
  function renderError(c, er) {
    var box = el('div', 'nb-error nb-tail');
    var pre = el('pre', null, '✖ ' + er.text);
    box.appendChild(pre);
    if (er.line) {
      var a = el('button', 'nb-line', 'line ' + er.line);
      a.type = 'button';
      a.setAttribute('data-a', 'goto');
      a.setAttribute('data-line', String(er.line));
      a.title = 'Go to this line';
      pre.appendChild(document.createTextNode(' '));
      pre.appendChild(a);
    }
    (er.frames || []).slice(er.line ? 1 : 0, 5).forEach(function (f) {
      var other = f.cell !== c.id ? cellById(f.cell) : null;
      box.appendChild(el('div', 'nb-frame', 'at ' + (f.fn ? f.fn + ' — ' : '') + (other ? 'block at line ' + lineOf(other) + ', ' : '') + 'line ' + f.line));
    });
    return box;
  }
  function renderItem(it) {
    try {
      if (it.k === 'text') return el('pre', 'nb-txt', it.text);
      if (it.k === 'table') return renderTable(it);
      if (it.k === 'tree') { var w = el('div', 'nb-tree'); w.appendChild(renderTree(it.tree, true, 0)); return w; }
      if (it.k === 'image') {
        if (!NC.isImageSrc(it.src)) return el('pre', 'nb-txt', '[image]');
        var img = el('img', 'nb-img');
        img.alt = 'output image';
        img.onload = remeasure;
        img.src = it.src;
        return img;
      }
      if (it.k === 'chart') { var cw = el('div', 'nb-chart-wrap'); cw.innerHTML = NC.chartSVG(it.spec); return cw; }
      if (it.k === 'html') return renderFrame(it.html);
    } catch (e) {}
    return el('pre', 'nb-txt', it.text != null ? it.text : '[' + it.k + ']');
  }
  function renderTable(it) {
    var wrap = el('div', 'nb-tbl-wrap'), t = el('table', 'nb-tbl'), thead = el('thead'), tr = el('tr');
    (it.cols || []).forEach(function (c) { tr.appendChild(el('th', null, c)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    (it.rows || []).slice(0, 500).forEach(function (r) {
      var row = el('tr');
      (Array.isArray(r) ? r : []).forEach(function (v, i) { row.appendChild(el(i ? 'td' : 'th', null, v)); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    if (it.total > (it.rows || []).length) wrap.appendChild(el('div', 'nb-note', '… ' + (it.total - it.rows.length) + ' more rows'));
    return wrap;
  }
  function renderTree(node, open, depth) {
    var d = el('details', 'nb-node');
    d.open = !!open;
    d.appendChild(el('summary', null, String(node.h || '')));
    var kids = el('div', 'nb-kids');
    (node.c || []).forEach(function (kv) {
      var v = kv[1];
      if (v && typeof v === 'object' && depth < 8) {
        var wrap = el('div', 'nb-kv');
        var sub = renderTree(v, false, depth + 1);
        sub.querySelector('summary').insertBefore(el('span', 'nb-key', kv[0] + ': '), sub.querySelector('summary').firstChild);
        wrap.appendChild(sub);
        kids.appendChild(wrap);
      } else {
        var row = el('div', 'nb-kv');
        row.appendChild(el('span', 'nb-key', kv[0] + ': '));
        row.appendChild(el('span', 'nb-val', String(v)));
        kids.appendChild(row);
      }
    });
    if (node.more) kids.appendChild(el('div', 'nb-note', '… ' + node.more + ' more'));
    d.appendChild(kids);
    return d;
  }
  // HTML / SVG output: its own sandboxed frame (scripts allowed, opaque
  // origin), sized to its content through a nonce-checked message.
  function renderFrame(html) {
    var tok = 'h' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var f = el('iframe', 'nb-frame-out');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('data-tok', tok);
    f.title = 'HTML output';
    f.style.height = '60px';
    var cs = getComputedStyle(document.documentElement);
    function v(n, d) { var x = cs.getPropertyValue(n).trim(); return /^[#\w(),.%\s-]{1,40}$/.test(x) ? x : d; }
    var style = 'html,body{margin:0;background:transparent}body{padding:6px 2px;font:13px/1.45 -apple-system,system-ui,sans-serif;color:' + v('--text', '#222') + '}' +
      'table{border-collapse:collapse;font-size:12px}th,td{border:1px solid ' + v('--border', '#ccc') + ';padding:3px 8px;text-align:right}' +
      'thead th,tbody th{background:' + v('--surface-2', '#f4f4f4') + '}svg{max-width:100%;height:auto}img{max-width:100%}';
    // the body's own height (the root's scrollHeight never drops below the frame's)
    var js = '(function(){var T=' + JSON.stringify(tok) + ';function s(){var b=document.body;if(!b)return;try{parent.postMessage({__nbh:T,h:Math.ceil(b.getBoundingClientRect().height)},"*")}catch(e){}}' +
      'addEventListener("load",function(){s();if(window.ResizeObserver)new ResizeObserver(s).observe(document.body)});setTimeout(s,60)})()';
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>' + style + '</style><script>' + js + '<\/script></head><body>' + String(html) + '</body></html>';
    if (S) S.frames[tok] = f;
    return f;
  }
  function dropFrames(dom) {
    if (!S || !dom || !dom.querySelectorAll) return;
    var fs = dom.querySelectorAll('iframe[data-tok]');
    for (var i = 0; i < fs.length; i++) delete S.frames[fs[i].getAttribute('data-tok')];
  }
  var measureT = 0;
  function remeasure() {
    if (measureT) return;
    measureT = setTimeout(function () { measureT = 0; try { Cade.editor.requestMeasure(); } catch (e) {} }, 30);
  }
  function onOutClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var root = b.closest('.nb-out'), c = root && cellById(root.__nbCell);
    if (!c) return;
    var a = b.getAttribute('data-a');
    if (a === 'copy') copyText(NC.outputText(c.out));
    else if (a === 'text') { if (writeOutput(c, true)) toast('Output inserted below the block', 'success', 1500); }
    else if (a === 'clear') { c.out = null; touch(c); }
    else if (a === 'goto') gotoLine(c, +b.getAttribute('data-line'));
  }
  function gotoLine(c, line) {
    var ed = Cade.editor;
    ensureSynced();
    if (!ed || !c.block) return;
    var n = Math.min(ed.state.doc.lines, c.block.open + Math.max(1, line || 1));
    var pos = ed.state.doc.line(n).from;
    try { ed.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) }); ed.focus(); } catch (x) {}
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
  // Text output into the note as an ```output block (replacing one that's there).
  function writeOutput(c, force) {
    var ed = Cade.editor;
    if (!ed || !c.out) return false;
    if (ed.state.readOnly) { if (force) toast('Read-only mode — editing is locked', 'info', 2000); return false; }
    sync();
    if (!c.block || S.cells.indexOf(c) === -1) return false;
    var doc = ed.state.doc;
    if (!force && !K.findOutputAfter(doc, c.block) && !pref('saveOutputs')) return false;
    var cm = c.rt === 'py' ? '#' : '//';
    var header = cm + ' ran ' + hm() + (c.out.ms != null ? ' · ' + NC.fmtMs(c.out.ms) : '') + (c.n ? ' · [' + c.n + ']' : '');
    try {
      ed.dispatch({ changes: K.outputChange(doc, c.block, K.formatOutput(NC.outputText(c.out), header)), userEvent: 'input' });
    } catch (e) { return false; }
    c.out.saved = true;
    touch(c);
    return true;
  }

  // ---- untrusted output items from the sandboxes -------------------------------------------------
  function str(x, max) { x = x == null ? '' : String(x); return x.length > max ? x.slice(0, max) + '…' : x; }
  function cleanTree(n, depth, budget) {
    if (!n || typeof n !== 'object' || depth > 12 || budget.n-- <= 0) return str(n, 400);
    return {
      h: str(n.h, 120),
      c: (Array.isArray(n.c) ? n.c : []).slice(0, 200).map(function (kv) {
        return [str(Array.isArray(kv) ? kv[0] : '', 120), Array.isArray(kv) && kv[1] && typeof kv[1] === 'object' ? cleanTree(kv[1], depth + 1, budget) : str(Array.isArray(kv) ? kv[1] : '', 400)];
      }),
      more: Math.max(0, +n.more || 0)
    };
  }
  function cleanItem(it) {
    if (typeof it === 'string') { try { it = JSON.parse(it); } catch (e) { return null; } }
    if (!it || typeof it !== 'object') return null;
    var text = it.text != null ? str(it.text, 200000) : null;
    switch (it.k) {
      case 'text': return { k: 'text', text: text || '' };
      case 'table': return { k: 'table', cols: (Array.isArray(it.cols) ? it.cols : []).slice(0, 41).map(function (c) { return str(c, 80); }),
        rows: (Array.isArray(it.rows) ? it.rows : []).slice(0, 500).map(function (r) { return (Array.isArray(r) ? r : []).slice(0, 41).map(function (v) { return str(v, 300); }); }),
        total: Math.max(0, +it.total || 0), text: text };
      case 'tree': return { k: 'tree', tree: cleanTree(it.tree, 0, { n: 3000 }), text: text };
      case 'image': return NC.isImageSrc(it.src) ? { k: 'image', src: it.src, text: '[image]' } : { k: 'text', text: '[image]' };
      case 'html': return { k: 'html', html: str(it.html, 2000000), text: text != null ? text : '[html]' };
      case 'chart': return it.spec && typeof it.spec === 'object' ? { k: 'chart', spec: it.spec, text: text || '[chart]' } : null;
    }
    return null;
  }
  function pushItem(c, it) {
    if (!c.out || !it) return;
    var items = c.out.items;
    if (items.length >= MAX_ITEMS) { c.out.dropped = (c.out.dropped || 0) + 1; return; }
    items.push(it);
    touch(c);
  }

  // ---- JavaScript runtime: one persistent sandbox per note -----------------------------------------
  function jsHost() {
    if (S.js) return S.js.ready;
    var token = 'nb' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', 'allow-scripts'); // NOT allow-same-origin: opaque origin
    ifr.setAttribute('aria-hidden', 'true');
    ifr.setAttribute('tabindex', '-1');
    ifr.title = 'Notebook sandbox';
    ifr.className = 'cr-sandbox';
    var h = S.js = { ifr: ifr, token: token, pend: {}, seq: 0, onReady: null };
    h.ready = new Promise(function (res, rej) {
      var t = setTimeout(function () { if (S && S.js === h) killJS(''); rej(new Error('the JavaScript sandbox did not start')); }, 10000);
      h.onReady = function () { clearTimeout(t); res(); };
    });
    h.ready.then(null, function () {});
    ifr.srcdoc = NC.sandboxDoc(token, K.libSource());
    (document.body || document.documentElement).appendChild(ifr);
    return h.ready;
  }
  function jsPost(h, m) { m.__nb = h.token; try { h.ifr.contentWindow.postMessage(m, '*'); } catch (e) {} }
  function onMessage(e) {
    if (!S) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.__nbh && typeof m.__nbh === 'string') { // an HTML output frame reporting its height
      var f = S.frames[m.__nbh];
      if (f && e.source === f.contentWindow) {
        f.style.height = Math.max(24, Math.min(clamp(pref('maxHeight'), 120, 800) * 2, +m.h || 0)) + 'px';
        remeasure();
      }
      return;
    }
    var h = S.js;
    if (!h || e.source !== h.ifr.contentWindow || m.__nb !== h.token) return;
    var c;
    if (m.type === 'ready') { if (h.onReady) h.onReady(); }
    else if (m.type === 'out') {
      c = cellById(+m.cell);
      if (!c || !c.out || !Array.isArray(m.items)) return;
      m.items.forEach(function (x) {
        if (!Array.isArray(x)) return;
        var lv = String(x[0]);
        pushItem(c, { k: 'log', level: lv === 'warn' || lv === 'error' ? lv : 'log', text: str(x[1], 20000) });
      });
    } else if (m.type === 'display') { c = cellById(+m.cell); if (c) pushItem(c, cleanItem(m.item)); }
    else if (m.type === 'clear') { c = cellById(+m.cell); if (c && c.out) { c.out.items = []; c.out.run = (c.out.run || 0) + 0.5; touch(c); } }
    else if ((m.type === 'done' || m.type === 'vars' || m.type === 'interrupted') && h.pend[m.id]) { var p = h.pend[m.id]; delete h.pend[m.id]; p(m); }
  }
  // Destroy the sandbox (scope lost): pending runs end, JS blocks go stale.
  function killJS(why) {
    var h = S && S.js;
    if (!h) return;
    S.js = null;
    try { h.ifr.srcdoc = ''; h.ifr.remove(); } catch (e) {}
    Object.keys(h.pend).forEach(function (k) { try { h.pend[k]({ type: 'killed', status: 'stopped', error: { text: why || 'Stopped' } }); } catch (e) {} });
    h.pend = {};
    if (why) markRt('js', why);
  }
  function markRt(rt, why) {
    if (!S) return;
    S.cells.forEach(function (c) { if (c.rt === rt && c.ran && !c.running) { c.stale = why; touch(c); } });
    bump();
  }
  function runJS(job, code) {
    var c = job.cell;
    var src = c.lang === 'ts'
      ? (c.statusText = 'Loading TypeScript…', bump(), E._nb.tsToJs(code).then(null, function (e) { throw { ts: true, e: e }; }))
      : Promise.resolve(code);
    return src.then(function (js) {
      var built = NC.buildJSVariants(js, K, 'nb-' + c.id + '.js');
      if (c.lang === 'ts') { c.statusText = 'Running…'; bump(); }
      return jsHost().then(function () {
        var h = S.js, id = ++h.seq, timeout = clamp(pref('jsTimeout'), 1, 120) * 1000;
        return new Promise(function (resolve) {
          var killT = setTimeout(function () { // the sandbox stopped answering: start over
            delete h.pend[id];
            killJS('The JavaScript runtime stopped responding and was restarted — variables were reset');
            resolve({ status: 'timeout', ms: timeout, error: { text: 'Timed out after ' + NC.fmtMs(timeout) } });
          }, timeout + 4000);
          h.pend[id] = function (m) {
            clearTimeout(killT);
            job.cancel = null;
            var er = m.error && typeof m.error === 'object' ? m.error : null, frames = [];
            if (er && Array.isArray(er.frames)) frames = er.frames.slice(0, 8).map(function (f) { return { cell: +f.cell, line: +f.line || 0, fn: str(f.fn, 80) }; });
            var line = er && +er.line ? +er.line : 0;
            if (!line) for (var i = 0; i < frames.length; i++) if (frames[i].cell === c.id) { line = frames[i].line; break; }
            resolve({
              status: /^(ok|error|timeout|stopped)$/.test(m.status) ? m.status : 'error',
              ms: +m.ms || 0, dropped: +m.dropped || 0,
              result: m.result ? cleanItem(m.result) : null,
              error: er ? { text: str(er.text, 4000), line: line, frames: frames } : null
            });
          };
          job.cancel = function () {
            jsPost(h, { type: 'interrupt', id: 'x' + id });
            // a block stuck in synchronous code can't hear that: replace the runtime
            setTimeout(function () { if (h.pend[id] && S && S.js === h) killJS('Stopped — the JavaScript runtime was restarted, variables were reset'); }, 800);
          };
          jsPost(h, { type: 'run', id: id, cell: c.id, variants: built.variants, timeout: timeout });
        });
      });
    }).then(null, function (e) {
      if (e && e.ts) return { status: 'error', ms: 0, error: { text: 'TypeScript: ' + msg(e.e).replace(/^SyntaxError:\s*/, '') } };
      return { status: 'error', ms: 0, error: { text: msg(e) } };
    });
  }
  function jsVars() {
    var h = S && S.js;
    if (!h) return Promise.resolve(null);
    return h.ready.then(function () {
      return new Promise(function (resolve) {
        var id = 'v' + (++h.seq), t = setTimeout(function () { delete h.pend[id]; resolve(null); }, 3000);
        h.pend[id] = function (m) { clearTimeout(t); resolve(Array.isArray(m.list) ? m.list : null); };
        jsPost(h, { type: 'vars', id: id });
      });
    }, function () { return null; });
  }

  // ---- Python: Code Runner's sandbox, this room's namespace --------------------------------------
  function runPython(job, code) {
    var c = job.cell, seen = 0;
    S.pyUsed = true;
    var r = E._nb.pyRun(code, S.room, {
      rich: true,
      timeout: clamp(pref('pyTimeout'), 1, 600),
      onOut: function (text) {
        var d = String(text).slice(seen);
        seen = String(text).length;
        if (!d || !c.out) return;
        var last = c.out.items[c.out.items.length - 1];
        if (last && last.k === 'log' && last.raw && c.out.items.length === c.out.streamAt) { last.text += d; touch(c); return; } // same stream chunk
        pushItem(c, { k: 'log', level: 'log', raw: true, text: d });
        c.out.streamAt = c.out.items.length;
      },
      onDisplay: function (s) { pushItem(c, cleanItem(s)); },
      onStatus: function (st, t) { c.statusText = st === 'loading' ? t : (t || 'Running…'); bump(); }
    });
    job.cancel = r.cancel;
    return r.promise.then(function (res) {
      // output after the last chunk the stream callback saw (the stream is cumulative)
      if (res.out && String(res.out).length > seen) {
        var d = String(res.out).slice(seen);
        pushItem(c, { k: 'log', level: 'log', raw: true, text: d });
      }
      var out = { status: res.status === 'ok' ? 'ok' : res.status === 'stopped' ? 'stopped' : res.status === 'timeout' ? 'timeout' : 'error', ms: res.ms || 0 };
      if (res.status === 'ok') {
        if (res.rich) { var it = cleanItem(res.rich); if (it) { if (res.result != null && it.k !== 'text') it.text = str(res.result, 200000); out.result = it; } }
        if (!out.result && res.result != null) out.result = { k: 'text', text: str(res.result, 200000) };
      } else {
        var t = res.errText != null ? res.errText : String(res.text || '').slice(String(res.out || '').length);
        out.error = { text: str(String(t).replace(/^[\s✖]+/, ''), 8000) || res.status, line: +res.errLine || 0 };
      }
      return out;
    });
  }

  // ---- the queue ---------------------------------------------------------------------------------------
  function enqueue(c, o) {
    o = o || {};
    if (c.queued || c.running) return c.promise || Promise.resolve('busy');
    var job = { cell: c, chain: o.chain || null, root: !!o.root };
    c.queued = true;
    c.promise = new Promise(function (res) { job.resolve = res; });
    S.queue.push(job);
    bump();
    scheduleDecos();
    setTimeout(pump, 0);
    return c.promise;
  }
  function pump() {
    if (!S || S.cur || !S.queue.length) return;
    var job = S.queue.shift(), c = job.cell;
    c.queued = false;
    sync(); // the code as it is now
    if (S.cells.indexOf(c) === -1) { job.resolve('gone'); bump(); pump(); return; }
    S.cur = job;
    c.running = true;
    c.statusText = 'Running…';
    var code = c.code, an = analysis(c), prev = c.ran ? c.ran.defines : [];
    c.out = { items: [], result: null, error: null, ms: null, run: ++S.runSeq, saved: false };
    bump();
    touch(c);
    var p;
    try { p = c.rt === 'js' ? runJS(job, code) : runPython(job, code); }
    catch (e) { p = Promise.resolve({ status: 'error', ms: 0, error: { text: msg(e) } }); }
    var s0 = S;
    p.then(function (res) { if (S === s0) finish(job, code, an, prev, res); }, function (e) {
      if (S === s0) finish(job, code, an, prev, { status: 'error', ms: 0, error: { text: msg(e) } });
    });
  }
  function names(list) { list = list.slice(0, 3); return list.join(', '); }
  function finish(job, code, an, prev, res) {
    var c = job.cell, ok = res.status === 'ok';
    S.cur = null;
    job.cancel = null;
    c.running = false;
    c.statusText = '';
    c.ran = { code: code, defines: an.defines.slice() };
    c.status = res.status;
    c.stale = '';
    c.n = ++S.count;
    if (c.out) {
      c.out.ms = res.ms;
      c.out.result = res.result || null;
      c.out.error = res.status === 'ok' ? null : (res.error || { text: res.status === 'stopped' ? 'Stopped' : res.status });
      if (res.dropped) c.out.dropped = (c.out.dropped || 0) + res.dropped;
    }
    writeOutput(c, false);
    var line = lineOf(c);
    if (job.root) {
      // who reads what this block defines (or used to define)
      var removed = prev.filter(function (n) { return an.defines.indexOf(n) === -1; });
      // only blocks that have run take part: code never runs before you've run it once
      var cells = S.cells.filter(function (x) { return x.rt === c.rt && (x === c || x.ran); }).map(function (x) {
        var a = x === c ? an : analysis(x);
        return { id: x.id, rt: x.rt, defines: a.defines, uses: a.uses, lateUses: a.lateUses };
      });
      var pl = NC.plan(cells, c.id, removed);
      var defs = names(an.defines.concat(removed));
      pl.dependents.forEach(function (id) {
        var d = cellById(id);
        if (!d || !d.ran || d === c) return;
        d.stale = ok ? 'The block at line ' + line + ' ran again' + (defs ? ' (' + defs + ')' : '') : 'The block at line ' + line + ' failed';
        touch(d);
      });
      pl.cyclic.forEach(function (id) {
        var d = cellById(id);
        if (d && d !== c) { d.stale = 'Circular dependency with the block at line ' + line + ' — not re-run'; touch(d); }
      });
      pl.blocked.forEach(function (id) { var d = cellById(id); if (d) { d.stale = 'Depends on a circular dependency — not re-run'; touch(d); } });
      if (pl.cyclic.length > 1 || (pl.cyclic.length && pl.cyclic[0] !== c.id)) toast('Circular dependency between blocks — they were not re-run', 'info', 3200);
      if (ok && pref('autoRun') && pl.order.length) {
        var chain = { failed: {} };
        pl.order.forEach(function (id) { var d = cellById(id); if (d) enqueue(d, { chain: chain }); });
      }
    }
    if (!ok && job.chain) {
      // an error stops the chain: what's left of it (same language) stays stale
      job.chain.failed[c.rt] = 1;
      S.queue = S.queue.filter(function (j) {
        if (j.chain !== job.chain || j.cell.rt !== c.rt) return true;
        j.cell.queued = false;
        j.cell.stale = 'Not run: the block at line ' + line + ' failed';
        touch(j.cell);
        j.resolve('skipped');
        return false;
      });
    }
    job.resolve(res.status);
    touch(c);
    bump();
    refreshVarsSoon();
    pump();
  }
  function stopCur() {
    var job = S && S.cur;
    if (!job) return false;
    if (job.cancel) job.cancel();
    return true;
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------
  var offCB = null, offNP = null;
  function onUpdate(u) {
    if (!S || !u.docChanged) return;
    if (!syncT) syncT = setTimeout(function () { syncT = 0; if (S) { sync(); scheduleDecos(); bump(); } }, 150);
  }
  function onRoom() { if (S && S.room !== roomKey()) teardown(); renderPanelSoon(); }
  function ensure() {
    if (S && S.room === roomKey()) return S;
    if (S) teardown();
    var ed = Cade.editor;
    S = { room: roomKey(), cells: [], byFrom: {}, nextId: 0, queue: [], cur: null, js: null, count: 0, runSeq: 0,
      frames: {}, pyUsed: false, doc: ed ? ed.state.doc : null, synced: null };
    Cade.registerPlugin({ id: PLUGIN_ID, ext: field });
    window.addEventListener('message', onMessage);
    document.addEventListener('cade-room-switched', onRoom);
    Cade.onEditorUpdate(onUpdate);
    offCB = CB.on(function (k) { if (k === 'linked' && !linked()) { teardown(); renderPanelSoon(); } });
    offNP = NP.on(function () { if (S) { S.cells.forEach(function (c) { c.ver++; }); scheduleDecos(); bump(); } });
    sync();
    return S;
  }
  // Everything goes: runtimes, outputs, the editor extension, listeners.
  function teardown() {
    var s = S;
    if (!s) return;
    s.queue.forEach(function (j) { j.cell.queued = false; j.resolve('stopped'); });
    s.queue = [];
    if (s.cur) { var cur = s.cur; s.cur = null; try { if (cur.cancel) cur.cancel(); } catch (e) {} cur.resolve('stopped'); }
    killJS('');
    if (s.pyUsed) { try { E._nb.pyReset(s.room); } catch (e) {} }
    S = null;
    clearTimeout(syncT); syncT = 0;
    clearTimeout(decoT); decoT = 0;
    window.removeEventListener('message', onMessage);
    document.removeEventListener('cade-room-switched', onRoom);
    Cade.offEditorUpdate(onUpdate);
    if (offCB) { offCB(); offCB = null; }
    if (offNP) { offNP(); offNP = null; }
    try { Cade.editor.dispatch({ effects: setDecos.of(CM.Decoration.none) }); } catch (e) {}
    try { Cade.unregisterPlugin(PLUGIN_ID); } catch (e) {}
    bump();
  }

  // ---- public API (used by coderun-engine.js and the Run buttons plugin) ---------------------------------
  N.runCell = function (openFrom, lang) {
    if (!linked()) return Promise.resolve('unlinked');
    var s = ensure();
    sync();
    var c = s.byFrom[openFrom];
    if (!c && lang && NC.RT[lang]) { // an untagged block, run as its detected language
      var ed = Cade.editor, doc = ed.state.doc, blocks = K.scanFences(doc), b = K.blockAt(blocks, doc.lineAt(openFrom).number);
      if (b && b.openFrom === openFrom && b.close !== -1) {
        c = newCell(openFrom, lang);
        c.detected = true;
        s.byFrom[openFrom] = c;
        sync();
        c = s.byFrom[openFrom];
      }
    }
    if (!c) { toast('Put the cursor inside a closed ``` block to run it', 'info'); return Promise.resolve('none'); }
    if (c.queued || c.running) { toast('Already running — use Stop to cancel', 'info'); return Promise.resolve('busy'); }
    return enqueue(c, { root: true });
  };
  function runList(filter, emptyMsg) {
    if (!linked()) return Promise.resolve();
    var s = ensure();
    sync();
    var list = s.cells.filter(function (c) { return !c.queued && !c.running && filter(c); });
    if (!list.length) { toast(emptyMsg, 'info'); return Promise.resolve(); }
    var chain = { failed: {} };
    return Promise.all(list.map(function (c) { return enqueue(c, { chain: chain }); }));
  }
  N.runAll = function () { return runList(function () { return true; }, 'No js, ts or python blocks in this note'); };
  // blocks that end before pos (default: the block at the cursor / the cursor)
  N.runAbove = function (pos) {
    var ed = Cade.editor;
    if (!ed) return Promise.resolve();
    var doc = ed.state.doc;
    if (pos == null) {
      var head = ed.state.selection.main.head, b = K.blockAt(K.scanFences(doc), doc.lineAt(head).number);
      pos = b ? doc.line(b.open).from : head;
    }
    return runList(function (c) { return c.block && doc.line(c.block.close).to < pos; }, 'No js, ts or python blocks above the cursor');
  };
  // Stop one block (queued or running) or everything; true if something was stopped.
  N.stop = function (openFrom) {
    if (!S) return false;
    if (openFrom == null) {
      var any = !!(S.queue.length || S.cur);
      S.queue.forEach(function (j) { j.cell.queued = false; j.resolve('stopped'); touch(j.cell); });
      S.queue = [];
      stopCur();
      bump();
      return any;
    }
    var c = S.byFrom[openFrom];
    if (!c) return false;
    if (c.queued) {
      S.queue = S.queue.filter(function (j) { if (j.cell !== c) return true; j.resolve('stopped'); return false; });
      c.queued = false;
      touch(c);
      bump();
      return true;
    }
    if (c.running) return stopCur();
    return false;
  };
  // Clear the note's scope (both languages, or rt 'js' / 'py'); blocks that ran go stale.
  N.restart = function (rt) {
    var s = ensure();
    if (!rt || rt === 'js') {
      if (s.cur && s.cur.cell.rt === 'js') stopCur();
      killJS('Runtime restarted — run it again');
      markRt('js', 'Runtime restarted — run it again');
    }
    if (!rt || rt === 'py') {
      if (s.cur && s.cur.cell.rt === 'py') stopCur();
      else E._nb.pyReset(s.room);
      markRt('py', 'Runtime restarted — run it again');
    }
    toast(rt === 'py' ? 'Python variables cleared' : rt === 'js' ? 'JavaScript variables cleared' : 'Runtime restarted — variables cleared', 'success', 1800);
    refreshVarsSoon();
  };
  N.statusAt = function (openFrom) {
    var c = S && S.byFrom[openFrom];
    if (!c) return null;
    if (c.running) return { state: 'running', text: c.statusText || 'Running…' };
    if (c.queued) return { state: 'queued', text: 'Queued' };
    return null;
  };
  N.badgeAt = function (openFrom) {
    var c = S && S.byFrom[openFrom];
    if (!c) return null;
    var b = badge(c);
    if (!b || b.s === 'running' || b.s === 'queued') return null;
    if (!pref('timings') && b.s !== 'stale') b = { s: b.s, t: '', why: b.why };
    return b;
  };
  N.busy = function () { return !!(S && (S.cur || S.queue.length)); };
  N.active = function () { return !!S; };
  N.teardown = function () { teardown(); renderPanelSoon(); };
  N.cells = function () { // for the panel and tests
    if (!S) return [];
    ensureSynced();
    return S.cells.map(function (c) {
      var a = analysis(c), b = badge(c);
      return { id: c.id, lang: c.lang, line: lineOf(c), state: b ? b.s : 'idle', why: b && b.why || '', ms: c.out ? c.out.ms : null,
        defines: a.defines, uses: a.uses.concat(a.lateUses), n: c.n, text: c.out ? NC.outputText(c.out) : '' };
    });
  };
  N._hooks = {
    pyDown: function () { markRt('py', 'Python restarted — variables were reset'); },
    pyReset: function (ns) { if (S && ns === S.room) markRt('py', 'Python variables were reset'); }
  };

  // ---- the Notebook panel -------------------------------------------------------------------------------
  var panel = null, panelT = 0, varsT = 0, panelOff = [];
  var ICON = {
    all: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5l7 7-7 7zM13 5l7 7-7 7z" fill="currentColor"/></svg>',
    above: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l7 8h-4v8H9v-8H5z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
  };
  function btn(a, html, title, cls) { return '<button type="button" class="nb-btn' + (cls ? ' ' + cls : '') + '" data-a="' + a + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + html + '</button>'; }
  function panelHTML() {
    return '<div class="nb-bar">' +
        btn('all', ICON.all + '<span>Run all</span>', 'Run every js / ts / python block in order', 'primary') +
        btn('above', ICON.above + '<span>Above</span>', 'Run the blocks above the cursor') +
        btn('stop', ICON.stop + '<span>Stop</span>', 'Stop the running block and the queue') +
        btn('restart', ICON.restart + '<span>Restart</span>', 'Restart: clear this note’s variables') +
        btn('prefs', ICON.gear, 'Notebook preferences', 'nb-icon') +
      '</div>' +
      '<div class="nb-linked"></div>' +
      '<div class="nb-sec">Blocks</div><div class="nb-cells"></div>' +
      '<details class="nb-vars" open><summary>Variables</summary><div class="nb-vars-body"></div></details>' +
      '<p class="nb-hint">Shift+Enter or the Run chip runs a block. Blocks of the same language share variables in this note; blocks that use what a block defines re-run after it. ' +
      '<code>display(value)</code> shows tables, trees, HTML, images and <code>display.chart(data)</code> charts. Code runs in a sandbox with no access to your notes.</p>';
  }
  function renderPanelSoon() {
    if (!panel || panelT) return;
    panelT = setTimeout(function () { panelT = 0; renderPanel(); }, 120);
  }
  function scanCellsLite() { // before the first run: just the blocks
    var ed = Cade.editor;
    if (!ed) return [];
    var doc = ed.state.doc;
    return K.scanFences(doc).filter(function (b) { return b.close !== -1 && b.lang && NC.RT[b.lang]; }).map(function (b) {
      var a = NC.analyze(b.lang, K.codeOf(doc, b).text);
      return { id: 0, lang: b.lang, line: b.open, state: 'idle', why: 'Not run yet', ms: null, defines: a.defines, uses: a.uses.concat(a.lateUses), n: 0 };
    });
  }
  function renderPanel() {
    if (!panel || !panel.isConnected) { panel = null; return; }
    if (Cade.isMinimized(panel)) return;
    var on = linked(), body = panel.querySelector('.cade-panel-body');
    var lk = body.querySelector('.nb-linked');
    lk.className = 'nb-linked' + (on ? '' : ' off');
    lk.innerHTML = on
      ? '<span><b>Linked blocks on</b> — blocks of one language share variables in this note.</span>'
      : '<span><b>Linked blocks off</b> — every block runs on its own (Code Runner).</span>';
    if (typeof Cade.prefs === 'function' && Cade.prefs.open) lk.innerHTML += '<button type="button" class="nb-link-btn" data-a="cbprefs">Change</button>';
    ['all', 'above', 'restart'].forEach(function (a) { var b = body.querySelector('[data-a="' + a + '"]'); if (b) b.disabled = !on; });
    var sb = body.querySelector('[data-a="stop"]');
    if (sb) sb.disabled = !N.busy();
    var cells = S ? N.cells() : scanCellsLite(), box = body.querySelector('.nb-cells');
    if (!cells.length) box.innerHTML = '<div class="nb-empty">No ```js, ```ts or ```python blocks in this note yet.</div>';
    else box.innerHTML = cells.map(function (c) {
      var st = c.state, glyph = { fresh: '✓', stale: '●', error: '✕', running: '⟳', queued: '…', idle: '○' }[st] || '○';
      var meta = st === 'fresh' || st === 'error' ? (c.ms != null && pref('timings') ? NC.fmtMs(c.ms) : '') : st === 'idle' ? '' : st;
      var io = [];
      if (c.defines.length) io.push('defines ' + c.defines.slice(0, 6).join(', ') + (c.defines.length > 6 ? '…' : ''));
      if (c.uses.length) io.push('uses ' + c.uses.slice(0, 6).join(', ') + (c.uses.length > 6 ? '…' : ''));
      return '<button type="button" class="nb-cell nb-st-' + st + '" data-a="goto-cell" data-line="' + c.line + '" title="' + esc(c.why || '') + '">' +
        '<span class="nb-glyph" aria-hidden="true">' + glyph + '</span>' +
        '<span class="nb-cell-lang">' + (LANG_LABEL[c.lang] || esc(c.lang)) + '</span>' +
        '<span class="nb-cell-main"><span class="nb-cell-line">line ' + c.line + (c.n ? ' · [' + c.n + ']' : '') + (meta ? ' · ' + esc(meta) : '') + '</span>' +
        '<span class="nb-cell-io">' + esc(io.join(' · ') || '—') + '</span></span></button>';
    }).join('');
  }
  function refreshVarsSoon() {
    if (!panel || varsT) return;
    varsT = setTimeout(function () { varsT = 0; refreshVars(); }, 300);
  }
  function varsTable(list) {
    if (!list || !list.length) return '<div class="nb-empty">No variables yet.</div>';
    return '<table class="nb-vt"><tbody>' + list.slice(0, 400).map(function (r) {
      return '<tr><th>' + esc(str(r[0], 60)) + '</th><td class="nb-vt-t">' + esc(str(r[1], 40)) + '</td><td class="nb-vt-v">' + esc(str(r[2], 160)) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function refreshVars() {
    if (!panel || !panel.isConnected || Cade.isMinimized(panel)) return;
    var det = panel.querySelector('.nb-vars');
    if (!det || !det.open) return;
    var room = roomKey();
    Promise.all([
      jsVars(),
      E._nb.pyReady() ? E._nb.pyVars(room) : Promise.resolve(null)
    ]).then(function (r) {
      if (!panel) return;
      var vb = panel.querySelector('.nb-vars-body');
      var js = S && S.js ? varsTable(r[0]) : '<div class="nb-empty">Not running — run a JS block to start it.</div>';
      var py = E._nb.pyReady() ? varsTable(r[1]) : '<div class="nb-empty">' + esc(E._nb.pyLoading() ? E._nb.pyStatus() : 'Not running — run a Python block to start it.') + '</div>';
      vb.innerHTML =
        '<div class="nb-vh"><b>JavaScript</b>' + btn('restart-js', 'Restart', 'Clear JavaScript variables', 'nb-small') + '</div>' + js +
        '<div class="nb-vh"><b>Python</b>' + btn('restart-py', 'Restart', 'Clear Python variables', 'nb-small') + '</div>' + py +
        '<div class="nb-vh-foot">' + btn('vars', 'Refresh', 'Refresh the variables', 'nb-small') + '</div>';
    });
  }
  function onPanelClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-a');
    if (a === 'all') N.runAll();
    else if (a === 'above') N.runAbove();
    else if (a === 'stop') { if (!N.stop()) toast('Nothing is running', 'info', 1400); }
    else if (a === 'restart') N.restart();
    else if (a === 'restart-js') N.restart('js');
    else if (a === 'restart-py') N.restart('py');
    else if (a === 'vars') refreshVars();
    else if (a === 'prefs') { if (typeof Cade.prefs === 'function' && Cade.prefs.open) Cade.prefs.open('notebook'); else toast('Preferences are coming soon', 'info', 1800); }
    else if (a === 'cbprefs') { if (Cade.prefs && Cade.prefs.open) Cade.prefs.open('codeblocks'); }
    else if (a === 'goto-cell') {
      var ed = Cade.editor, ln = +t.getAttribute('data-line');
      if (!ed || !ln || ln > ed.state.doc.lines) return;
      var pos = ed.state.doc.line(Math.min(ed.state.doc.lines, ln + 1)).from;
      try { ed.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) }); } catch (x) {}
    }
  }
  function openPanel() {
    if (panel && panel.isConnected) return panel;
    Cade.closeAllMenus();
    panel = Cade.mkPanel(PANEL_ID, 'Notebook', panelHTML());
    panel.classList.add('nb-panel');
    panel.dataset.prefs = 'notebook'; // the Widget preferences modal opens on this page
    var body = panel.querySelector('.cade-panel-body');
    body.addEventListener('click', onPanelClick);
    panel.querySelector('.nb-vars').addEventListener('toggle', function () { refreshVars(); });
    function onRestore() { renderPanel(); refreshVars(); }
    function onEd(u) { if (u.docChanged && !S) renderPanelSoon(); }
    panel.addEventListener('cade-panel-restore', onRestore);
    document.addEventListener('cade-room-switched', renderPanelSoon);
    Cade.onEditorUpdate(onEd);
    var offL = CB.on(function () { renderPanelSoon(); });
    panelOff = [function () { document.removeEventListener('cade-room-switched', renderPanelSoon); }, function () { Cade.offEditorUpdate(onEd); }, offL];
    panel._onClose = function () {
      panel = null;
      clearTimeout(panelT); panelT = 0;
      clearTimeout(varsT); varsT = 0;
      panelOff.forEach(function (f) { try { f(); } catch (e) {} });
      panelOff = [];
    };
    renderPanel();
    refreshVars();
    return panel;
  }
  N.openPanel = openPanel;
  N.togglePanel = function () {
    if (panel && panel.isConnected) { var p = panel; p.remove(); if (p._onClose) p._onClose(); return; }
    openPanel();
  };
  N.panelOpen = function () { return !!(panel && panel.isConnected); };
})();
