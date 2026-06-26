/* Code syntax highlighting for fenced Python / JavaScript / HTML blocks.
 * Loaded on demand when the `plugins.codeHighlight` setting is enabled; injects
 * a CodeMirror ViewPlugin via window.Cade.registerPlugin (which survives room
 * switches via the core plugin compartment). Lightweight, viewport-only,
 * regex-per-line tokeniser — not a full parser. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration) return;
  Cade.loadCSS('code-highlight.css');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration;

  // Master regex per language: alternation groups map 1:1 to a CSS class.
  var JS = {
    re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_]*\.?\d*)\b|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|typeof|instanceof|await|async|yield|try|catch|finally|throw|delete|void|in|of|this|null|true|false|undefined)\b/g,
    cls: [null, 'cm-cx-com', 'cm-cx-str', 'cm-cx-num', 'cm-cx-kw']
  };
  var PY = {
    re: /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(\d[\d_]*\.?\d*)\b|\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|assert|del|async|await|print)\b/g,
    cls: [null, 'cm-cx-com', 'cm-cx-str', 'cm-cx-num', 'cm-cx-kw']
  };
  var HTML = {
    re: /(<!--[\s\S]*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<\/?[a-zA-Z][\w:-]*)|(\b[a-zA-Z_:][\w:-]*(?=\s*=))/g,
    cls: [null, 'cm-cx-com', 'cm-cx-str', 'cm-cx-tag', 'cm-cx-attr']
  };
  function langOf(tag) {
    tag = (tag || '').toLowerCase();
    if (tag === 'js' || tag === 'javascript' || tag === 'jsx' || tag === 'ts' || tag === 'typescript') return JS;
    if (tag === 'py' || tag === 'python') return PY;
    if (tag === 'html' || tag === 'htm' || tag === 'xml' || tag === 'svg') return HTML;
    return null;
  }

  function tokenizeLine(text, lineFrom, spec, ranges) {
    if (text.length > 2000) return; // skip data/minified lines
    spec.re.lastIndex = 0;
    var m;
    while ((m = spec.re.exec(text)) !== null) {
      if (m[0].length === 0) { spec.re.lastIndex++; continue; }
      var gi = 1;
      for (; gi < spec.cls.length; gi++) { if (m[gi] != null) break; }
      var cls = spec.cls[gi];
      if (cls) ranges.push(Decoration.mark({ class: cls }).range(lineFrom + m.index, lineFrom + m.index + m[0].length));
    }
  }

  var FENCE = /^\s*(?:```+|~~~+)\s*([A-Za-z0-9_+-]*)/;
  function build(view) {
    var doc = view.state.doc;
    var ranges = [];
    for (var v = 0; v < view.visibleRanges.length; v++) {
      var from = view.visibleRanges[v].from, to = view.visibleRanges[v].to;
      var firstVisible = doc.lineAt(from).number;
      var lastVisible = doc.lineAt(to).number;
      // Establish fence state by scanning from the top (bounded), tokenising only
      // the visible lines that fall inside a recognised code fence.
      var inFence = false, spec = null;
      var cap = Math.min(lastVisible, 6000);
      for (var i = 1; i <= cap; i++) {
        var line = doc.line(i);
        var fm = FENCE.exec(line.text);
        if (fm) {
          if (!inFence) { inFence = true; spec = langOf(fm[1]); }
          else { inFence = false; spec = null; }
          continue; // never tokenise the fence line itself
        }
        if (inFence && spec && i >= firstVisible) tokenizeLine(line.text, line.from, spec, ranges);
      }
    }
    ranges.sort(function (a, b) { return a.from - b.from || a.startSide - b.startSide; });
    return Decoration.set(ranges, true);
  }

  function CodeHL(view) { this.decorations = build(view); }
  CodeHL.prototype.update = function (u) {
    if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
  };
  var plugin = ViewPlugin.fromClass(CodeHL, { decorations: function (v) { return v.decorations; } });

  Cade.registerPlugin({ id: 'code-highlight', ext: plugin });
})();
