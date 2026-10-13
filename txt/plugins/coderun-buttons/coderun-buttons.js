/* Run buttons — a small "Run" chip at the end of the opening line of every
 * runnable ``` block (js / ts / python / json; html gets "Preview"), a spinner
 * + Stop while it runs, and a faint "x" on ```output blocks to remove them.
 * Ctrl/Cmd+Enter inside a runnable block runs it.
 *
 * Cheap: viewport-only widget decorations, rebuilt only on doc / viewport /
 * read-only changes or when the runner's state changes; fence state comes
 * from a cached list of ``` line positions (core's rule: a ``` line toggles a
 * block) that is mapped through edits and only rescanned when an edit touches
 * a backtick or a fence line. Hidden in read-only mode. The runner itself
 * (widgets/coderun) loads only when a chip is used. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.WidgetType) return;
  Cade.loadCSS('coderun-buttons.css');

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var BASE = Cade.baseURL();
  var CR = /plugins\/coderun-buttons\/$/.test(BASE) ? BASE.replace(/plugins\/coderun-buttons\/$/, 'widgets/coderun/') : './txt/widgets/coderun/';
  var KIT = abs(CR + 'coderun-kit.js'), ENGINE = abs(CR + 'coderun-engine.js');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration, WidgetType = CM.WidgetType;
  var MAX_LINE = 300;

  // ---- engine loading (shared registry with the widget and the scripts) ----
  function load(url) {
    var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});
    if (L[url]) return L[url];
    L[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete L[url]; rej(new Error('Code Runner failed to load (offline?)')); };
      document.head.appendChild(s);
    });
    return L[url];
  }
  function ensure() {
    if (window.__cadeCodeRun) return Promise.resolve(window.__cadeCodeRun);
    return load(KIT).then(function () { return load(ENGINE); }).then(function () {
      if (!window.__cadeCodeRun) throw new Error('Code Runner failed to start');
      return window.__cadeCodeRun;
    });
  }
  function withEngine(fn) {
    ensure().then(fn, function (e) { try { Cade.showToast(e.message, 'error', 4000); } catch (x) {} });
  }

  // ---- languages (a copy of the runner's map: chips must not need the engine) ----
  var LANG = {
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js', es6: 'js',
    ts: 'ts', typescript: 'ts', mts: 'ts', cts: 'ts',
    py: 'py', python: 'py', python3: 'py', py3: 'py', pyodide: 'py',
    json: 'json', html: 'html', htm: 'html', xhtml: 'html', output: 'output'
  };
  function langOf(info) {
    var w = String(info || '').trim().replace(/^[{.]+/, '').split(/[\s},:;]/)[0].toLowerCase();
    return Object.prototype.hasOwnProperty.call(LANG, w) ? LANG[w] : null;
  }

  // ---- fence positions, scanned lazily from the top and mapped through edits ----
  var fence = { doc: null, pos: [], to: -1 };
  function startsFence(t) { return t.charCodeAt(0) === 96 && t.lastIndexOf('```', 0) === 0; }
  function ensureScan(doc, line) {
    if (fence.doc !== doc) fence = { doc: doc, pos: [], to: -1 };
    if (fence.to >= line.to) return;
    var start = fence.to < 0 ? 1 : doc.lineAt(fence.to).number + 1;
    for (var i = start; i <= line.number; i++) {
      var l = doc.line(i);
      if (startsFence(l.text)) fence.pos.push(l.from);
    }
    fence.to = line.to;
  }
  // index of the first fence line at or after `from`
  function lowerBound(from) {
    var lo = 0, hi = fence.pos.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (fence.pos[mid] < from) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Opening fence line of the block containing `line`, or null.
  function openingFor(doc, line) {
    ensureScan(doc, line);
    var i = lowerBound(line.from);
    if (fence.pos[i] === line.from) return i % 2 === 0 ? line : doc.lineAt(fence.pos[i - 1]);
    return i % 2 === 1 ? doc.lineAt(fence.pos[i - 1]) : null;
  }
  function isOpening(doc, line) {
    ensureScan(doc, line);
    var i = lowerBound(line.from);
    return fence.pos[i] === line.from && i % 2 === 0;
  }
  function mapFences(u) {
    if (fence.doc !== u.startState.doc) return;
    var may = false, a = u.startState.doc, b = u.state.doc;
    u.changes.iterChanges(function (fromA, toA, fromB, toB, ins) {
      if (may) return;
      if (ins.length && ins.toString().indexOf('`') !== -1) may = true;
      else if (toA > fromA && a.sliceString(fromA, toA).indexOf('`') !== -1) may = true;
      else if (startsFence(a.lineAt(fromA).text) || startsFence(a.lineAt(toA).text) ||
               startsFence(b.lineAt(fromB).text) || startsFence(b.lineAt(toB).text)) may = true;
    });
    if (may) { fence = { doc: b, pos: [], to: -1 }; return; }
    var ch = u.changes;
    fence.pos = fence.pos.map(function (p) { return ch.mapPos(p, 1); });
    fence.to = fence.to < 0 ? -1 : ch.mapPos(fence.to, -1);
    fence.doc = b;
  }

  // ---- chip widget ----
  var ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/></svg>';
  var ICON_X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function Chip(lang, st) {
    this.lang = lang;
    this.st = st;
    this.key = lang + '|' + (st ? st.state + '|' + st.text : '');
  }
  Chip.prototype = Object.create(WidgetType.prototype);
  Chip.prototype.constructor = Chip;
  Chip.prototype.eq = function (o) { return o.key === this.key; };
  Chip.prototype.toDOM = function (view) {
    var wrap = document.createElement('span');
    wrap.className = 'cm-crun';
    wrap.setAttribute('contenteditable', 'false');
    var st = this.st, lang = this.lang;
    function button(cls, act, html, title) {
      var b = document.createElement('span');
      b.className = 'cm-crun-btn ' + cls;
      b.setAttribute('role', 'button');
      b.setAttribute('data-act', act);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = html;
      wrap.appendChild(b);
      return b;
    }
    if (lang === 'output') {
      button('cm-crun-x', 'clear', ICON_X, 'Remove this output');
    } else if (!st) {
      button('cm-crun-run', 'run', ICON_PLAY + '<span>' + (lang === 'html' ? 'Preview' : 'Run') + '</span>',
        lang === 'html' ? 'Open this block in Live HTML Preview' : 'Run this block (Ctrl/⌘+Enter)');
    } else {
      var pill = document.createElement('span');
      pill.className = 'cm-crun-state' + (st.state === 'queued' ? ' queued' : '');
      pill.innerHTML = (st.state === 'queued' ? '' : '<span class="cm-crun-spin" aria-hidden="true"></span>') + '<span></span>';
      pill.lastChild.textContent = st.text || 'Running…';
      wrap.appendChild(pill);
      button('cm-crun-stop', 'stop', ICON_STOP + '<span>' + (st.state === 'queued' ? 'Cancel' : 'Stop') + '</span>', st.state === 'queued' ? 'Remove from the queue' : 'Stop this run');
    }
    function swallow(e) { e.preventDefault(); e.stopPropagation(); } // keep the caret & focus where they are
    wrap.addEventListener('mousedown', swallow);
    wrap.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    wrap.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      swallow(e);
      if (!t) return;
      var line;
      try { line = view.state.doc.lineAt(view.posAtDOM(wrap)); } catch (x) { return; }
      var act = t.getAttribute('data-act'), from = line.from;
      if (act === 'run') { wrap.classList.add('pressed'); withEngine(function (E) { E.runBlockAt(from); }); }
      else if (act === 'stop') withEngine(function (E) { E.stop(from); });
      else if (act === 'clear') withEngine(function (E) { E.clearOutputAt(from); });
    });
    return wrap;
  };
  Chip.prototype.ignoreEvent = function () { return true; };

  // ---- the view plugin ----
  function build(view) {
    if (view.state.readOnly) return Decoration.none;
    var doc = view.state.doc, out = [], E = window.__cadeCodeRun || null;
    var ranges = view.visibleRanges;
    for (var r = 0; r < ranges.length; r++) {
      var a = doc.lineAt(ranges[r].from).number, b = doc.lineAt(ranges[r].to).number;
      for (var i = a; i <= b; i++) {
        var line = doc.line(i), t = line.text;
        if (t.length > MAX_LINE || !startsFence(t)) continue;
        var lang = langOf(t.slice(3));
        if (!lang || !isOpening(doc, line)) continue;
        var st = lang !== 'output' && lang !== 'html' && E && E.statusAt ? E.statusAt(line.from) : null;
        out.push(Decoration.widget({ widget: new Chip(lang, st), side: 1 }).range(line.to));
      }
    }
    return out.length ? Decoration.set(out, true) : Decoration.none;
  }
  function engineVersion() { var E = window.__cadeCodeRun; return E ? E.version : 0; }
  function RunButtons(view) { this.v = engineVersion(); this.decorations = build(view); }
  RunButtons.prototype.update = function (u) {
    if (u.docChanged) mapFences(u);
    var v = engineVersion();
    if (u.docChanged || u.viewportChanged || v !== this.v || u.state.readOnly !== u.startState.readOnly) {
      this.v = v;
      this.decorations = build(u.view);
    }
  };
  var plugin = ViewPlugin.fromClass(RunButtons, { decorations: function (p) { return p.decorations; } });

  // Ctrl/Cmd+Enter in a runnable block runs it; anywhere else the key keeps
  // its default meaning.
  function runKey(view) {
    if (view.state.readOnly) return false;
    var sel = view.state.selection.main, doc = view.state.doc;
    try { if (Cade.inCodeFence && !Cade.inCodeFence(sel.head)) return false; } catch (e) {}
    var open = openingFor(doc, doc.lineAt(sel.head));
    if (!open) return false;
    var lang = langOf(open.text.slice(3));
    if (lang !== 'js' && lang !== 'ts' && lang !== 'py' && lang !== 'json' && lang !== 'html') return false;
    var from = open.from;
    withEngine(function (E) { E.runBlockAt(from); });
    return true;
  }
  var keys = CM.keymap ? CM.keymap.of([{ key: 'Mod-Enter', run: runKey }]) : [];
  if (CM.Prec && CM.keymap) keys = CM.Prec.high(keys); // ahead of the default Mod-Enter (insert blank line)

  Cade.registerPlugin({ id: 'coderun-buttons', ext: [plugin, keys] });
})();
