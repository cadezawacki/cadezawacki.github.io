/* PLUGIN TEMPLATE — copy to txt/plugins/<id>/<id>.js and rename.
 * Injects a CodeMirror 6 extension, gated by a Settings toggle. Add a
 * "type":"plugin" manifest entry with: id, name, description, entry, css,
 * settingKey, section, default. Bump manifest.version + sw.js CACHE_VERSION.
 * The plugin id MUST equal the manifest id. See txt/docs/README.md §7. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration) return;
  Cade.loadCSS('<id>.css'); // delete if no stylesheet

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration;

  // Build decorations for the VISIBLE viewport only (fast on big docs).
  function build(view) {
    var ranges = [], doc = view.state.doc;
    for (var v = 0; v < view.visibleRanges.length; v++) {
      var from = view.visibleRanges[v].from, to = view.visibleRanges[v].to;
      var startLine = doc.lineAt(from).number, endLine = doc.lineAt(to).number;
      for (var i = startLine; i <= endLine; i++) {
        var line = doc.line(i);
        if (line.length > 2000) continue; // skip data/image lines
        // EXAMPLE: mark a literal you care about. Replace with your own logic.
        var re = /YOURPATTERN/g, m;
        re.lastIndex = 0;
        while ((m = re.exec(line.text)) !== null) {
          ranges.push(Decoration.mark({ class: 'cm-<id>-mark' })
            .range(line.from + m.index, line.from + m.index + m[0].length));
        }
      }
    }
    ranges.sort(function (a, b) { return a.from - b.from || a.startSide - b.startSide; });
    return Decoration.set(ranges, true);
  }

  function P(view) { this.decorations = build(view); }
  P.prototype.update = function (u) {
    if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
  };
  var ext = ViewPlugin.fromClass(P, { decorations: function (v) { return v.decorations; } });

  // id MUST equal the manifest id (so the on/off toggle can re-activate it).
  Cade.registerPlugin({ id: '<id>', ext: ext });
})();
