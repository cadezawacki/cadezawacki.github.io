/* Spoiler Text — ||hidden text|| renders blurred on a soft tinted pill (the
 * Discord / Reddit syntax). It reveals while the caret or a selection
 * touches it — click / tap it (the click lands the caret inside), or arrow
 * into it from the keyboard — and blurs again once the caret leaves. In a
 * read-only room, where the caret may not move, a click toggles it instead.
 * The || markers hide like the core's other markdown markers and show on the
 * caret's line, so the source stays plain, editable text.
 *
 * Rules: one line; the hidden text must not start or end with a space (so
 * "a || b || c" stays an expression); never inside ``` fences or `inline
 * code`; markdown table rows (lines starting with a single "|") are left
 * alone. Respects Settings → Markdown styling (off → plain text).
 *
 * The blur is transparent text + a blurred text-shadow rather than CSS
 * filter, which WebKit doesn't apply to inline boxes — so it works on iOS
 * Safari and wraps across lines like any text.
 *
 * Palette / "/" menu: the "Spoiler" script wraps the selection in ||…||, or
 * unwraps it when it is already a spoiler (with no selection: unwraps the
 * spoiler at the caret, or inserts |||| with the caret in the middle).
 * Viewport-only decorations; selection moves only re-render when the set of
 * revealed spoilers changes. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration) return;
  Cade.loadCSS('spoiler.css');
  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration;

  // ||x|| — content starts and ends with a non-space, non-pipe character.
  var SPOIL_RE = /\|\|([^|\s](?:[^\n]*?[^|\s])?)\|\|/g;
  var CODE_RE = /`[^`\n]+`/g;
  var TABLE_RE = /^\s*\|(?!\|)/;
  var MAX_LINE = 2000;

  function inFence(pos) { try { return !!(Cade.inCodeFence && Cade.inCodeFence(pos)); } catch (e) { return false; } }
  function mdOn() {
    try { var v = Cade.Settings && Cade.Settings.get('editor.markdownStyling'); return v !== false; } catch (e) { return true; }
  }

  // Spoilers of one line as [[from, to]] (offsets in the line, markers included).
  function lineSpans(text) {
    if (text.length < 5 || text.length > MAX_LINE || text.indexOf('||') < 0 || TABLE_RE.test(text)) return [];
    var code = null, out = [], m, i;
    if (text.indexOf('`') >= 0) {
      code = [];
      CODE_RE.lastIndex = 0;
      while ((m = CODE_RE.exec(text)) !== null) code.push([m.index, m.index + m[0].length]);
    }
    SPOIL_RE.lastIndex = 0;
    while ((m = SPOIL_RE.exec(text)) !== null) {
      var s = m.index, e = s + m[0].length, bad = false;
      if (code) for (i = 0; i < code.length; i++) if (s < code[i][1] && e > code[i][0]) { bad = true; break; }
      if (bad) { SPOIL_RE.lastIndex = s + 1; continue; } // overlaps `code`: retry past this "||"
      out.push([s, e]);
    }
    return out;
  }
  // The spoiler around line offset `off` (markers included), or null.
  function spanAround(text, off) {
    var sp = lineSpans(text);
    for (var i = 0; i < sp.length; i++) if (off >= sp[i][0] && off <= sp[i][1]) return sp[i];
    return null;
  }

  // ---- decorations --------------------------------------------------------------------
  var MARK = Decoration.mark({ class: 'cm-spl-mk' });
  var HIDDEN = Decoration.mark({ class: 'cm-spl', attributes: { title: 'Spoiler \u2014 click to reveal' } });
  var SHOWN = Decoration.mark({ class: 'cm-spl cm-spl-on' });

  function Spoil(view) {
    this.view = view;
    this.md = mdOn();
    this.spans = [];  // [from, to] absolute, in view
    this.peek = [];   // starts of spoilers opened by a click while the caret can't go there
    this.key = '';
    this.scan(view);
    this.decorations = this.build(view.state);
    var self = this;
    this.onClick = function (e) { self.click(e); };
    view.contentDOM.addEventListener('click', this.onClick);
  }

  Spoil.prototype.scan = function (view) {
    this.spans = [];
    if (!this.md) return;
    var doc = view.state.doc, vr = view.visibleRanges, last = 0;
    for (var r = 0; r < vr.length; r++) {
      var a = Math.max(doc.lineAt(vr[r].from).number, last + 1), b = doc.lineAt(vr[r].to).number;
      for (var i = a; i <= b; i++) {
        var line = doc.line(i);
        if (line.length < 5 || line.text.indexOf('||') < 0 || inFence(line.from)) continue;
        var sp = lineSpans(line.text);
        for (var k = 0; k < sp.length; k++) this.spans.push([line.from + sp[k][0], line.from + sp[k][1]]);
      }
      last = b;
    }
  };
  // Which spoilers are open: touched by the caret / a selection, or peeked.
  Spoil.prototype.openKey = function (st) {
    var ranges = st.selection.ranges, key = '';
    for (var i = 0; i < this.spans.length; i++) {
      var s = this.spans[i], on = this.peek.indexOf(s[0]) >= 0;
      for (var j = 0; j < ranges.length && !on; j++) if (ranges[j].from <= s[1] && ranges[j].to >= s[0]) on = true;
      if (on) key += i + ',';
    }
    return key;
  };
  Spoil.prototype.build = function (st) {
    this.key = this.openKey(st);
    if (!this.spans.length) return Decoration.none;
    var out = [], open = ',' + this.key;
    for (var i = 0; i < this.spans.length; i++) {
      var s = this.spans[i];
      out.push(MARK.range(s[0], s[0] + 2));
      out.push((open.indexOf(',' + i + ',') >= 0 ? SHOWN : HIDDEN).range(s[0] + 2, s[1] - 2));
      out.push(MARK.range(s[1] - 2, s[1]));
    }
    return Decoration.set(out, true);
  };

  Spoil.prototype.update = function (u) {
    var md = mdOn();
    if (u.docChanged && this.peek.length) {
      var ch = u.changes;
      this.peek = this.peek.map(function (p) { return ch.mapPos(p, 1); });
    }
    if (u.docChanged || u.viewportChanged || md !== this.md) {
      this.md = md;
      this.scan(u.view);
      this.dropPeeks(u.state);
      this.decorations = this.build(u.state);
      return;
    }
    if (u.selectionSet) {
      this.dropPeeks(u.state);
      if (this.openKey(u.state) !== this.key) this.decorations = this.build(u.state);
    }
  };
  // A peek lasts until the selection moves somewhere else (or the spoiler goes).
  Spoil.prototype.dropPeeks = function (st) {
    if (!this.peek.length) return;
    var spans = this.spans, sel = st.selection.main;
    this.peek = this.peek.filter(function (p) {
      for (var i = 0; i < spans.length; i++) {
        if (spans[i][0] === p) return st.readOnly || (sel.from <= spans[i][1] && sel.to >= spans[i][0]);
      }
      return false;
    });
  };
  // Read-only / not editable: a click can't park the caret inside, so it
  // toggles a "peek" instead.
  Spoil.prototype.click = function (e) {
    var view = this.view;
    if (!this.md || (!view.state.readOnly && view.contentDOM.getAttribute('contenteditable') === 'true')) return;
    var el = e.target && e.target.closest ? e.target.closest('.cm-spl') : null;
    if (!el) return;
    var pos = null;
    try { pos = view.posAtDOM(el); } catch (x) {}
    if (pos == null) try { pos = view.posAtCoords({ x: e.clientX, y: e.clientY }); } catch (x) { return; }
    if (pos == null) return;
    for (var i = 0; i < this.spans.length; i++) {
      var s = this.spans[i];
      if (pos >= s[0] && pos <= s[1]) {
        var k = this.peek.indexOf(s[0]);
        if (k >= 0) this.peek.splice(k, 1); else this.peek.push(s[0]);
        this.decorations = this.build(view.state);
        view.dispatch({}); // let the view pick up the new decorations
        return;
      }
    }
  };
  Spoil.prototype.destroy = function () { this.view.contentDOM.removeEventListener('click', this.onClick); };

  var plugin = ViewPlugin.fromClass(Spoil, { decorations: function (v) { return v.decorations; } });

  // ---- wrap / unwrap --------------------------------------------------------------------
  // Returns true when it handled the editor (used by the "Spoiler" script).
  function toggleSpoiler() {
    var view = Cade.editor;
    if (!view) return false;
    var st = view.state, doc = st.doc, r = st.selection.main;
    if (st.readOnly) { Cade.showToast('Read-only mode \u2014 unlock to edit', 'error', 2000); return true; }
    var line = doc.lineAt(r.from), sp, a, b;
    function unwrap(s, e, keepSel) {
      view.dispatch({
        changes: [{ from: s, to: s + 2 }, { from: e - 2, to: e }],
        selection: keepSel ? { anchor: s, head: e - 4 } : { anchor: Math.max(s, Math.min(r.head - 2, e - 4)) },
        userEvent: 'input',
      });
      return true;
    }
    if (r.empty) {
      sp = spanAround(line.text, r.head - line.from);
      if (sp) return unwrap(line.from + sp[0], line.from + sp[1], false);
      view.dispatch({ changes: { from: r.head, insert: '||||' }, selection: { anchor: r.head + 2 }, userEvent: 'input' });
      view.focus();
      return true;
    }
    var text = doc.sliceString(r.from, r.to), multi = text.indexOf('\n') >= 0;
    if (!multi) {
      if (text.length >= 5 && /^\|\|[\s\S]*\|\|$/.test(text)) return unwrap(r.from, r.to, true);
      if (doc.sliceString(r.from - 2, r.from) === '||' && doc.sliceString(r.to, r.to + 2) === '||') return unwrap(r.from - 2, r.to + 2, true);
      sp = spanAround(line.text, r.from - line.from);
      if (sp && r.to <= line.from + sp[1]) return unwrap(line.from + sp[0], line.from + sp[1], true);
    }
    // Wrap the selected part of each line, spaces left outside the markers
    // (a spoiler can't start or end with one).
    var changes = [], first = -1, last = -1;
    for (var n = doc.lineAt(r.from).number, end = doc.lineAt(r.to).number; n <= end; n++) {
      var l = doc.line(n);
      a = Math.max(r.from, l.from); b = Math.min(r.to, l.to);
      var seg = doc.sliceString(a, b), lead = seg.length - seg.replace(/^\s+/, '').length, trail = seg.length - seg.replace(/\s+$/, '').length;
      if (!seg.trim()) continue;
      a += lead; b -= trail;
      changes.push({ from: a, insert: '||' }, { from: b, insert: '||' });
      if (first < 0) first = a;
      last = b;
    }
    if (!changes.length) return true;
    var cs = st.changes(changes);
    view.dispatch({
      changes: cs,
      selection: multi ? { anchor: cs.mapPos(r.anchor, 1), head: cs.mapPos(r.head, -1) } : { anchor: first + 2, head: last + 2 },
      userEvent: 'input',
    });
    return true;
  }
  window.__cadeSpoilerToggle = toggleSpoiler;

  Cade.registerScript('/**\n' +
    '  {\n' +
    '    "name": "Spoiler",\n' +
    '    "description": "Hide the selection as ||spoiler|| text (or unwrap one)",\n' +
    '    "icon": "\ud83d\ude48",\n' +
    '    "tags": "spoiler,hide,blur,secret,conceal,reveal"\n' +
    '  }\n' +
    '**/\n' +
    'function main(ctx) {\n' +
    '  if (window.__cadeSpoilerToggle && window.__cadeSpoilerToggle()) return;\n' +
    '  var t = ctx.selection;\n' +
    '  if (!t) { showToast("Select the text to hide first", "info", 2000); return; }\n' +
    '  ctx.selection = /^\\|\\|[\\s\\S]*\\|\\|$/.test(t) ? t.slice(2, -2) : "||" + t + "||";\n' +
    '}\n');

  Cade.registerPlugin({ id: 'spoiler', ext: plugin });
})();
