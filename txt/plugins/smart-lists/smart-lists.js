/* Smart lists & pairs — fills the gaps around the core's list handling (the
 * core already continues lists on Enter and exits on an empty item; that is
 * left alone):
 *   - Tab / Shift-Tab on a list item (caret anywhere in it, or a multi-line
 *     selection starting on one) indents / outdents the item WITH its children
 *     by the core's 4-space unit and renumbers numbered lists (a new nested
 *     level restarts at 1, the level it left closes the gap).
 *   - Backspace right after an empty marker ("- ", "1. ", "- [ ] ") outdents
 *     it, or removes it at the top level.
 *   - Enter continues a "> " quote / callout (an empty last "> " line exits).
 *   - Auto-pairs `code`, **bold**, __bold__, ~~strike~~, ==mark== when the
 *     delimiter is typed at a word boundary, wraps a selection when * _ ` ~ =
 *     is typed over it (the selection stays on the inner text, so * twice
 *     makes bold), overtypes its own closers, and undoes a pair that turns out
 *     not to be markup (space or a third delimiter right after the opener:
 *     "2 ** 3", "***", "```"; Backspace there too). ( [ { " ' are left to the
 *     editor's closeBrackets, which already pairs and wraps them.
 *
 * Keyboard routing: Tab / Shift-Tab are a keymap (plugins sit before the core
 * keymap and basicSetup binds neither). Backspace and Enter need a capture
 * listener on the editor — basicSetup's defaultKeymap is first in the
 * extension list and would always win — registered after the core's own
 * capture-phase Enter (list continuation), which therefore still goes first.
 * Every handler returns false / does nothing when it doesn't apply, during
 * IME composition, in read-only mode and inside ``` fences, and Tab yields to
 * an inline-math ghost result shown at the end of the line.
 * Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.keymap || !CM.EditorView) return;

  var ViewPlugin = CM.ViewPlugin, EditorView = CM.EditorView, keymap = CM.keymap;
  var UNIT = '    ';   // the core's indent unit (Tab, Mod-], list hanging indent)
  var WIN = 400;       // lines scanned either way when renumbering / collecting children
  // closeBrackets' own composition test: Android keyboards always "compose".
  var ANDROID = /Android\b/.test(navigator.userAgent || '');

  // A list item: indent + bullet / number / letter / [n] marker (+ checkbox),
  // or a bare "[ ] " checkbox line (todo pages).
  var ITEM_RE = /^[ \t]*(?:(?:[-*+•]|\d{1,9}[.)]|[A-Za-z][.)]|\[\d{1,9}\])[ \t]+|\[[ xX]\][ \t]+)/;
  var EMPTY_RE = /^[ \t]*(?:(?:[-*+•]|\d{1,9}[.)]|[A-Za-z][.)]|\[\d{1,9}\])[ \t]+(?:\[[ xX]\][ \t]+)?|\[[ xX]\][ \t]+)$/;
  var NUM_RE = /^([ \t]*)(\d{1,9})([.)])([ \t])/;
  var QUOTE_RE = /^[ \t]{0,3}(?:>[ \t]?)+/;

  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  function composing(view) { return ANDROID ? view.composing : view.compositionStarted; }
  function indentOf(t) {
    var w = 0;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charCodeAt(i);
      if (ch === 32) w++; else if (ch === 9) w += 4; else break;
    }
    return w;
  }
  function outdentText(t) {
    if (t.charAt(0) === '\t') return t.slice(1);
    var n = 0;
    while (n < 4 && t.charAt(n) === ' ') n++;
    return t.slice(n);
  }
  function blank(t) { return !/\S/.test(t); }

  // The inline-math plugin shows its result as a "ghost" widget at the line
  // end and accepts it with Tab; while one is showing there, Tab is its key.
  function ghostOnLine(view, line) {
    try {
      var d = view.domAtPos(line.to), n = d.node;
      if (n && n.nodeType !== 1) n = n.parentNode;
      var el = n && n.closest ? n.closest('.cm-line') : null;
      return !!(el && el.querySelector('[class*="ghost"]'));
    } catch (e) { return false; }
  }

  // ---- list indent / outdent + renumbering ---------------------------------------
  // Numbered items at indent `w` forming one list around L[idx]: deeper lines
  // (children) are skipped, a shallower line, a blank line or a non-numbered
  // line at the same level ends it.
  function runAt(L, idx, w) {
    var out = [], i, t, iw;
    for (i = idx; i >= 0; i--) {
      t = L[i];
      if (blank(t)) break;
      iw = indentOf(t);
      if (iw > w) continue;
      if (iw < w || !NUM_RE.test(t)) break;
      out.unshift(i);
    }
    for (i = idx + 1; i < L.length; i++) {
      t = L[i];
      if (blank(t)) break;
      iw = indentOf(t);
      if (iw > w) continue;
      if (iw < w || !NUM_RE.test(t)) break;
      out.push(i);
    }
    return out;
  }
  function numOf(t) { var m = NUM_RE.exec(t); return m ? parseInt(m[2], 10) : 1; }
  function setNum(t, n) { return t.replace(NUM_RE, function (all, ind, d, sep, ws) { return ind + n + sep + ws; }); }

  // Minimal change turning text a into b.
  function minChange(from, a, b) {
    var p = 0, max = Math.min(a.length, b.length);
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    var s = 0;
    while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return { from: from + p, to: from + a.length - s, insert: b.slice(p, b.length - s) };
  }
  // Line a → b as an indentation change AT THE LINE START (a pure insert /
  // delete, so carets and selection ends there follow the text) plus a minimal
  // change to the rest (the renumbered digits).
  function lineChanges(from, a, b, out) {
    var la = /^[ \t]*/.exec(a)[0].length, lb = /^[ \t]*/.exec(b)[0].length;
    var wa = a.slice(0, la), wb = b.slice(0, lb);
    if (wa !== wb) {
      if (lb > la && wb.slice(lb - la) === wa) out.push({ from: from, insert: wb.slice(0, lb - la) });
      else if (la > lb && wa.slice(la - lb) === wb) out.push({ from: from, to: from + la - lb });
      else out.push({ from: from, to: from + la, insert: wb });
    }
    if (a.slice(la) !== b.slice(lb)) out.push(minChange(from + la, a.slice(la), b.slice(lb)));
  }

  // Pure core of Tab / Shift-Tab: given the window's line texts and the moved
  // range (window indices), return the new texts (null if nothing moves).
  function shiftLines(orig, a, b, dir) {
    var neu = orig.slice(), moved = {}, any = false, k;
    for (k = a; k <= b; k++) {
      if (blank(orig[k])) continue;
      var nt = dir > 0 ? UNIT + orig[k] : outdentText(orig[k]);
      if (nt !== orig[k]) { neu[k] = nt; moved[k] = true; any = true; }
    }
    if (!any) return null;
    // Work out every affected numbered list BEFORE renumbering any of them.
    var runs = [], seen = {};
    function addRun(items, start, w) {
      if (!items.length) return;
      var key = items[0] + ':' + w;
      if (seen[key]) return;
      seen[key] = true;
      runs.push({ items: items, start: start });
    }
    for (k = a; k <= b; k++) {
      if (!moved[k] || !NUM_RE.test(neu[k])) continue;
      var ow = indentOf(orig[k]), nw = indentOf(neu[k]);
      // The level it joined: continue a previous sibling there, else restart at 1.
      var nr = runAt(neu, k, nw);
      addRun(nr, moved[nr[0]] ? 1 : numOf(neu[nr[0]]), nw);
      // The level it left: close the gap, keeping that list's first number.
      var or = runAt(orig, k, ow), rest = [];
      for (var j = 0; j < or.length; j++) if (!moved[or[j]]) rest.push(or[j]);
      if (rest.length) addRun(runAt(neu, rest[0], ow), numOf(orig[or[0]]), ow);
    }
    runs.forEach(function (r) {
      var n = r.start;
      r.items.forEach(function (i) { neu[i] = setNum(neu[i], n++); });
    });
    return neu;
  }

  function shift(view, dir) {
    var st = view.state;
    if (st.readOnly || st.selection.ranges.length !== 1) return false;
    var sel = st.selection.main, doc = st.doc;
    var l1 = doc.lineAt(sel.from).number, l2 = doc.lineAt(sel.to).number;
    if (l2 > l1 && sel.to === doc.line(l2).from) l2--; // a selection ending at a line start excludes that line
    var first = doc.line(l1);
    if (first.length > 2000 || !ITEM_RE.test(first.text) || inFence(first.from)) return false;
    if (l1 === l2 && sel.empty && sel.head === first.to && ghostOnLine(view, first)) return false;
    // The last selected line's children move with it.
    var end = l2, base = indentOf(doc.line(l2).text);
    for (var i = l2 + 1; i <= doc.lines && i - l2 <= WIN; i++) {
      var t = doc.line(i).text;
      if (blank(t) || indentOf(t) <= base) break;
      end = i;
    }
    // Window = the surrounding non-blank block (lists never span blank lines here).
    var w0 = l1, w1 = end;
    while (w0 > 1 && l1 - w0 < WIN && !blank(doc.line(w0 - 1).text)) w0--;
    while (w1 < doc.lines && w1 - end < WIN && !blank(doc.line(w1 + 1).text)) w1++;
    var orig = [];
    for (i = w0; i <= w1; i++) orig.push(doc.line(i).text);
    var neu = shiftLines(orig, l1 - w0, end - w0, dir);
    if (!neu) return false; // nothing to outdent: let the core's Shift-Tab have it
    var specs = [];
    for (i = 0; i < orig.length; i++) {
      if (neu[i] !== orig[i]) lineChanges(doc.line(w0 + i).from, orig[i], neu[i], specs);
    }
    var changes = st.changes(specs);
    view.dispatch({
      changes: changes,
      selection: st.selection.map(changes, 1), // a caret in the indentation moves with the text
      userEvent: dir > 0 ? 'input.indent' : 'input.dedent',
      scrollIntoView: true,
    });
    return true;
  }

  // ---- Backspace / Enter -------------------------------------------------------------
  function backspaceMarker(view) {
    var st = view.state, sel = st.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty) return false;
    var head = sel.main.head, line = st.doc.lineAt(head);
    if (head !== line.to || line.length > 200 || !EMPTY_RE.test(line.text) || inFence(line.from)) return false;
    if (indentOf(line.text) > 0) return shift(view, -1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'delete.backward' });
    return true;
  }

  function quoteEnter(view) {
    var st = view.state, sel = st.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty) return false;
    var head = sel.main.head, doc = st.doc, line = doc.lineAt(head);
    if (line.length > 2000) return false;
    var m = QUOTE_RE.exec(line.text);
    if (!m || head - line.from < m[0].length || inFence(line.from)) return false;
    var cont = m[0].replace(/>[ \t]?/g, '> ');
    if (blank(line.text.slice(m[0].length))) {
      // An empty "> " line ends the quote — but only at its end, so a blank
      // paragraph line inside a callout doesn't split it in two.
      var next = line.number < doc.lines ? doc.line(line.number + 1).text : '';
      if (!QUOTE_RE.test(next)) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'input' });
        return true;
      }
    }
    var ins = '\n' + cont;
    view.dispatch({ changes: { from: head, insert: ins }, selection: { anchor: head + ins.length }, userEvent: 'input', scrollIntoView: true });
    return true;
  }

  // ---- auto-pairs ---------------------------------------------------------------------
  var MD = '*_~=`';
  var OPEN_BEFORE = /[\s([{<"'*_~=>|“‘]/; // may precede an opener
  var CLOSE_AFTER = /[\s)\]}>.,;:!?"'*_~=`|”’]/; // may follow the caret

  // Tracks the closers this plugin inserted (positions mapped through edits),
  // so only those are overtyped / undone, and owns the capture keydown.
  function Pairs(view) {
    this.view = view;
    this.pairs = []; // { open, olen, from, to, ch, close }
    var self = this;
    this.onKey = function (e) { self.key(e); };
    view.dom.addEventListener('keydown', this.onKey, true);
  }
  Pairs.prototype.update = function (u) {
    if (!this.pairs.length || (!u.docChanged && !u.selectionSet)) return;
    var st = u.state, doc = st.doc, ch = u.changes, sel = st.selection.main;
    this.pairs = this.pairs.filter(function (p) {
      if (u.docChanged) {
        var f = ch.mapPos(p.from, 1), t = ch.mapPos(p.to, -1);
        if (t - f !== p.to - p.from) return false;
        p.open = ch.mapPos(p.open, 1);
        p.from = f; p.to = t;
        if (doc.sliceString(f, t) !== p.close.slice(p.close.length - (t - f))) return false;
      }
      // Forget a pair once the caret leaves the span between opener and closer.
      return sel.empty && sel.head <= p.from && sel.head >= p.open + p.olen &&
        doc.lineAt(sel.head).number === doc.lineAt(p.from).number;
    });
  };
  Pairs.prototype.destroy = function () { this.view.dom.removeEventListener('keydown', this.onKey, true); };
  Pairs.prototype.at = function (pos) {
    for (var i = this.pairs.length - 1; i >= 0; i--) if (this.pairs[i].from === pos) return this.pairs[i];
    return null;
  };
  Pairs.prototype.drop = function (p) { var i = this.pairs.indexOf(p); if (i >= 0) this.pairs.splice(i, 1); };
  Pairs.prototype.add = function (p) { this.pairs.push(p); if (this.pairs.length > 16) this.pairs.shift(); };

  Pairs.prototype.key = function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    var view = this.view;
    if (view.state.readOnly) return;
    var done = false;
    if (e.key === 'Backspace') done = this.backspacePair() || backspaceMarker(view);
    else if (e.key === 'Enter') done = quoteEnter(view);
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  // Backspace straight after an auto-paired opener: "**|**" → "*".
  Pairs.prototype.backspacePair = function () {
    var st = this.view.state, sel = st.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty) return false;
    var head = sel.main.head, p = this.at(head);
    if (!p || head - p.open !== p.olen) return false;
    this.drop(p);
    this.view.dispatch({ changes: { from: head - 1, to: p.to }, userEvent: 'delete.backward' });
    return true;
  };

  function wrap(view, r, c) {
    var doc = view.state.doc, line = doc.lineAt(r.from);
    if (r.to > line.to || inFence(line.from)) return false; // multi-line: plain replace
    view.dispatch({
      changes: [{ from: r.from, insert: c }, { from: r.to, insert: c }],
      selection: { anchor: r.anchor + 1, head: r.head + 1 },
      userEvent: 'input.type',
    });
    return true;
  }

  function typed(view, P, p, c) {
    var doc = view.state.doc, line = doc.lineAt(p);
    if (line.length > 2000) return false;
    var pr = P.at(p);
    if (pr) {
      var empty = p - pr.open === pr.olen;
      if (empty && (c === ' ' || c === pr.ch)) {
        // Not markup after all ("2 ** 3", "***" rule, "```" fence): drop the
        // closer and type the char plainly.
        P.drop(pr);
        view.dispatch({ changes: { from: p, to: pr.to, insert: c }, selection: { anchor: p + 1 }, userEvent: 'input.type' });
        return true;
      }
      if (c === pr.ch && doc.sliceString(p, p + 1) === c) {
        pr.from++;
        if (pr.from >= pr.to) P.drop(pr);
        view.dispatch({ selection: { anchor: p + 1 }, userEvent: 'select' }); // overtype the closer
        return true;
      }
    }
    if (c === ' ' || inFence(line.from)) return false;
    var t = line.text, col = p - line.from;
    var prev = t.charAt(col - 1), next = t.charAt(col);
    if (next && !CLOSE_AFTER.test(next)) return false;
    var ticks = 0;
    for (var i = 0; i < col; i++) if (t.charCodeAt(i) === 96) ticks++;
    if (ticks & 1) return false; // inside / closing an `inline code` span
    if (c === '`') {
      if (prev === '`' || (prev && !OPEN_BEFORE.test(prev))) return false;
      view.dispatch({ changes: { from: p, insert: '``' }, selection: { anchor: p + 1 }, userEvent: 'input.type' });
      P.add({ open: p, olen: 1, from: p + 1, to: p + 2, ch: c, close: c });
      return true;
    }
    // ** __ ~~ == : this is the 2nd char of an opener that starts at a boundary.
    var pp = t.charAt(col - 2);
    if (prev !== c || pp === c || (pp && !OPEN_BEFORE.test(pp))) return false;
    view.dispatch({ changes: { from: p, insert: c + c + c }, selection: { anchor: p + 1 }, userEvent: 'input.type' });
    P.add({ open: p - 1, olen: 2, from: p + 1, to: p + 3, ch: c, close: c + c });
    return true;
  }

  var pairsPlugin = ViewPlugin.fromClass(Pairs);

  var input = EditorView.inputHandler.of(function (view, from, to, text) {
    if (text !== ' ' && (text.length !== 1 || MD.indexOf(text) < 0)) return false;
    if (composing(view) || view.state.readOnly) return false;
    var P = view.plugin(pairsPlugin), sel = view.state.selection;
    if (!P || sel.ranges.length !== 1) return false;
    var r = sel.main;
    if (from !== r.from || to !== r.to) return false;
    if (!r.empty) return text !== ' ' && wrap(view, r, text);
    return typed(view, P, r.head, text);
  });

  var keys = keymap.of([
    { key: 'Tab', run: function (v) { return shift(v, 1); } },
    { key: 'Shift-Tab', run: function (v) { return shift(v, -1); } },
  ]);

  Cade.registerPlugin({ id: 'smart-lists', ext: [pairsPlugin, input, keys] });
})();
