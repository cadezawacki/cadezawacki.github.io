/* Inline math — a line that ends with "=" and holds a maths expression gets
 * its answer as faint ghost text after the "=":   12.5 * 4 + 10% =  55
 * Tab (with the cursor at the end of that line) or a click inserts it.
 *
 * - Understands everything the calculator engine does: %, units and
 *   conversions (5 km in mi =), functions, constants.
 * - Variables: "rate = 0.07" lines above (within ~300 lines of the screen)
 *   feed later lines ("1200 * rate =").
 * - Ignores fenced code blocks, tables, URLs, code-looking lines, dates and
 *   bare numbers ("5 =").
 * - Cheap: viewport-only decorations, nothing at all unless a visible line
 *   ends in "=", per-line result cache, the engine (shared calc-engine.js) is
 *   only fetched the first time such a line appears, and the fence scan is
 *   cached per document and only extended up to the lines it needs.
 * - Tab returns false (core Tab behaviour unchanged) unless a ghost is
 *   showing on the cursor's line. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.WidgetType || !CM.keymap) return;
  Cade.loadCSS('inline-math.css');
  // The engine lives in the calculator's folder; derive its URL from ours.
  var BASE = Cade.baseURL();
  var ENGINE_URL = /plugins\/inline-math\/$/.test(BASE) ? BASE.replace(/plugins\/inline-math\/$/, 'widgets/calc/calc-engine.js') : './txt/widgets/calc/calc-engine.js';

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration, WidgetType = CM.WidgetType;
  var engine = window.__cadeCalcEngine || null;
  var engineFailed = false;

  function loadEngine() {
    if (engine || engineFailed) return;
    if (window.__cadeCalcEngine) { engine = window.__cadeCalcEngine; return; }
    var p = window.__cadeCalcEngineLoading;
    if (!p) {
      p = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = ENGINE_URL; s.async = true;
        s.onload = function () { if (window.__cadeCalcEngine) resolve(window.__cadeCalcEngine); else reject(new Error('no engine')); };
        s.onerror = function () { reject(new Error('engine load failed')); };
        document.head.appendChild(s);
      });
      window.__cadeCalcEngineLoading = p;
      p.then(null, function () { window.__cadeCalcEngineLoading = null; });
    }
    p.then(function (E) {
      engine = E;
      // nudge the editor so the plugin rebuilds with the engine in hand
      try { if (Cade.editor) Cade.editor.dispatch({}); } catch (e) {}
    }, function () { engineFailed = true; });
  }

  // ---- line classification (cheap regexes first) -------------------------------
  // ends in "=" that isn't part of ==, <=, >=, !=, :=, +=, -=, *=, /=, ^=, &=, |=, ~=
  var TRAIL_EQ = /(^|[^=<>!:+\-*\/^&|~?])=\s*$/;
  var ASSIGN = /^\s*(?:[-*+]\s+)?[A-Za-z_][A-Za-z0-9_]{0,30}\s*=\s*[^=\s]/;
  var LEAD = /^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)?/;
  var CODEY = /[;{}`\[\]|\\"<>]|:\/\/|www\.|==|=>|&&/;
  var DATEY = /\d{1,4}[-\/.]\d{1,2}[-\/.]\d{1,4}|^\d+(?:-\d+)+$/;
  var MAX_LINE = 2000, MAX_EXPR = 200, VAR_WINDOW = 300;

  // ---- fenced code blocks: line-start positions of ``` lines, scanned lazily ----
  // (same rule as core: a line starting with ``` toggles a block)
  var fence = { doc: null, pos: [], to: -1 };
  function fenceReset(doc) { fence = { doc: doc, pos: [], to: -1 }; }
  function inFence(doc, line) {
    if (fence.doc !== doc) fenceReset(doc);
    if (fence.to < line.from) {
      // extend the scan through this line (never past what's needed)
      var start = fence.to < 0 ? 1 : doc.lineAt(fence.to).number + 1;
      for (var i = start; i <= line.number; i++) {
        var l = doc.line(i);
        if (l.text.charCodeAt(0) === 96 && l.text.lastIndexOf('```', 0) === 0) fence.pos.push(l.from);
      }
      fence.to = line.to;
    }
    // count fence lines strictly above this line (binary search)
    var lo = 0, hi = fence.pos.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (fence.pos[mid] < line.from) lo = mid + 1; else hi = mid; }
    return lo % 2 === 1;
  }
  function startsFence(text) { return text.lastIndexOf('```', 0) === 0; }
  // Keep the fence cache across edits that can't touch a fence (no backticks
  // typed/deleted, no ``` line edited): just map the positions.
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
    if (may) { fenceReset(b); return; }
    var ch = u.changes;
    fence.pos = fence.pos.map(function (p) { return ch.mapPos(p, 1); });
    fence.to = fence.to < 0 ? -1 : ch.mapPos(fence.to, -1);
    fence.doc = b;
  }

  // ---- evaluation with a small cache ---------------------------------------------
  var cache = new Map();
  function cached(key, fn) {
    if (cache.has(key)) return cache.get(key);
    var v = fn();
    if (cache.size > 3000) cache.clear();
    cache.set(key, v);
    return v;
  }
  function acceptable(r) {
    if (!r.ok || r.info.first === 'unit') return false;
    // must DO something — an operator, function or conversion — or name a variable
    return r.info.ops > 0 || (r.info.first === 'var' && r.info.vars.length > 0);
  }
  // Find the expression at the end of a "… =" line and evaluate it.
  function evalEqLine(text, scope) {
    var body = text.replace(/=\s*$/, '');
    body = body.replace(LEAD, '');
    var colon = body.lastIndexOf(':');
    if (colon !== -1) body = body.slice(colon + 1);
    if (!body.trim() || body.length > MAX_EXPR || CODEY.test(body)) return null;
    var thousands = /\d,\d{3}/.test(body);
    var opts = { scope: scope, setAns: false, thousands: thousands };
    if (body.indexOf('=') !== -1) {
      // one assignment allowed: "total = price * qty ="
      if (!/^\s*[A-Za-z_]\w*\s*=[^=]+$/.test(body)) return null;
      var ra = engine.evaluate(body, opts);
      return acceptable(ra) ? ra : null;
    }
    // Longest trailing run of words that is valid maths: "Rent 1200 * 12" → "1200 * 12"
    var starts = [0], re = /\s+(?=\S)/g, m;
    while ((m = re.exec(body)) && starts.length < 8) starts.push(m.index + m[0].length);
    for (var i = 0; i < starts.length; i++) {
      var expr = body.slice(starts[i]).trim();
      if (!expr || DATEY.test(expr)) continue;
      var c0 = expr.charAt(0);
      if (/[*\/^%!,)=+×÷]/.test(c0)) continue;          // can't start with an operator
      if (/^[-−–]\s/.test(expr)) continue;               // "- 5" is a dash, not minus
      var r = engine.evaluate(expr, opts);
      if (acceptable(r)) return r;
    }
    return null;
  }

  // ---- ghost widget -----------------------------------------------------------------
  function Ghost(text) { this.text = text; }
  Ghost.prototype = Object.create(WidgetType.prototype);
  Ghost.prototype.constructor = Ghost;
  Ghost.prototype.eq = function (o) { return o.text === this.text; };
  Ghost.prototype.toDOM = function (view) {
    var s = document.createElement('span');
    s.className = 'cm-imath-ghost';
    s.textContent = this.text;
    s.title = 'Tab or click to insert';
    s.setAttribute('aria-hidden', 'true');
    s.addEventListener('mousedown', function (e) {
      e.preventDefault();
      try { var pos = view.posAtDOM(s); accept(view, view.state.doc.lineAt(pos)); } catch (x) {}
    });
    return s;
  };
  Ghost.prototype.ignoreEvent = function () { return true; };

  // ---- the view plugin -----------------------------------------------------------------
  function build(view, inst) {
    inst.ghosts = {};
    inst.withEngine = !!engine;
    var ranges = view.visibleRanges;
    if (!ranges.length) return Decoration.none;
    var doc = view.state.doc;
    // 1) any visible line ending in "="? (most of the time: no → nothing to do)
    var eqLines = [];
    for (var r = 0; r < ranges.length; r++) {
      var a = doc.lineAt(ranges[r].from).number, b = doc.lineAt(ranges[r].to).number;
      for (var i = a; i <= b; i++) {
        var line = doc.line(i), t = line.text;
        if (t.length > MAX_LINE || t.length < 2 || t.indexOf('=') === -1) continue;
        if (TRAIL_EQ.test(t) && !CODEY.test(t)) eqLines.push(line);
      }
    }
    if (!eqLines.length) return Decoration.none;
    if (!engine) { loadEngine(); return Decoration.none; }

    // 2) walk from a little above the screen to the last "=" line, collecting
    //    variables from "name = value" lines and answering the "=" lines.
    var scope = engine.createScope(), sig = '';
    var firstEq = eqLines[0].number, lastEq = eqLines[eqLines.length - 1].number;
    var from = Math.max(1, doc.lineAt(ranges[0].from).number - VAR_WINDOW);
    var eqSet = {};
    eqLines.forEach(function (l) { eqSet[l.number] = 1; });
    var widgets = [];
    for (var n = from; n <= lastEq; n++) {
      var ln = doc.line(n), tx = ln.text;
      if (tx.length > MAX_LINE || tx.indexOf('=') === -1) continue;
      var isEq = eqSet[n] === 1;
      var isAssign = !isEq && n < lastEq && ASSIGN.test(tx) && !TRAIL_EQ.test(tx) && !CODEY.test(tx);
      if (!isEq && !isAssign) continue;
      if (inFence(doc, ln)) continue;
      var key = sig + '\u0001' + tx;
      var res = cached(key, isEq ? function () { return evalEqLine(tx, scope); }
        : function () { var rr = engine.evaluate(tx.replace(LEAD, ''), { scope: scope, setAns: false }); return rr.ok && rr.assigned ? rr : null; });
      if (!res) continue;
      if (res.assigned) {
        // (a cache hit didn't run evaluate, so set the variable here)
        scope.vars[res.assigned] = res.q;
        sig += res.assigned + ':' + res.plain + ';';
      }
      if (isEq && n >= firstEq) {
        var txt = (/\s$/.test(tx) ? '' : ' ') + res.text;
        inst.ghosts[ln.from] = txt;
        widgets.push(Decoration.widget({ widget: new Ghost(txt), side: 1 }).range(ln.to));
      }
    }
    return widgets.length ? Decoration.set(widgets, true) : Decoration.none;
  }

  function IMath(view) { this.ghosts = {}; this.withEngine = false; this.decorations = build(view, this); }
  IMath.prototype.update = function (u) {
    if (u.docChanged) mapFences(u);
    if (u.docChanged || u.viewportChanged || this.withEngine !== !!engine) this.decorations = build(u.view, this);
  };
  var imath = ViewPlugin.fromClass(IMath, { decorations: function (v) { return v.decorations; } });

  // Insert the ghost of `line` (if it has one) at its end.
  function accept(view, line) {
    var inst = view.plugin(imath);
    var g = inst && inst.ghosts[line.from];
    if (!g || view.state.readOnly) return false;
    var end = line.to;
    view.dispatch({ changes: { from: end, insert: g }, selection: { anchor: end + g.length }, userEvent: 'input', scrollIntoView: true });
    return true;
  }
  // Tab: only with one empty cursor sitting after the trailing "=" of a ghost line.
  function onTab(view) {
    var sel = view.state.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty) return false;
    var line = view.state.doc.lineAt(sel.main.head);
    var inst = view.plugin(imath);
    if (!inst || !inst.ghosts[line.from]) return false;
    var eqAt = line.from + line.text.replace(/\s+$/, '').length; // just past the "="
    if (sel.main.head < eqAt) return false;
    return accept(view, line);
  }

  Cade.registerPlugin({ id: 'inline-math', ext: [imath, CM.keymap.of([{ key: 'Tab', run: onTab }])] });
})();
