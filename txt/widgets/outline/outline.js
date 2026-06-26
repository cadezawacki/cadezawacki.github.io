/* Outline / table-of-contents widget for Cade.txt.
 * A floating panel listing the document's "# Heading" lines; click to jump.
 * Rebuilds on edit via Cade.onEditorUpdate. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('outline.css');
  var EV = Cade.CM.EditorView;
  var rebuildTimer = 0;

  function build() {
    var list = document.getElementById('outline-list');
    if (!list) return;
    var doc = Cade.editor.state.doc;
    var items = [];
    var cap = Math.min(doc.lines, 6000);
    for (var i = 1; i <= cap; i++) {
      var m = doc.line(i).text.match(/^(#{1,6})\s+(.*)$/);
      if (m) items.push({ level: m[1].length, text: m[2].trim() || '(untitled)', line: i });
    }
    if (!items.length) { list.innerHTML = '<div class="outline-empty">No headings yet. Use "# Heading" lines to build an outline.</div>'; return; }
    list.innerHTML = items.map(function (it) {
      return '<button class="outline-item h' + it.level + '" data-line="' + it.line + '">' + Cade.escapeHtml(it.text) + '</button>';
    }).join('');
  }
  function goTo(lineNo) {
    var doc = Cade.editor.state.doc;
    var line = doc.line(Math.max(1, Math.min(lineNo, doc.lines)));
    Cade.editor.dispatch({ selection: { anchor: line.from }, effects: EV.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) });
    Cade.editor.focus();
  }
  function toggle() {
    Cade.closeAllMenus();
    var existing = document.getElementById('outline-panel');
    if (existing) { existing.remove(); Cade.store.set('cade-outline-open', '0'); return; }
    var p = Cade.mkPanel('outline-panel', 'Outline', '<div id="outline-list"></div>');
    p._onClose = function () { Cade.store.set('cade-outline-open', '0'); };
    var list = document.getElementById('outline-list');
    if (list) list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.outline-item') : null;
      if (b) goTo(parseInt(b.getAttribute('data-line'), 10) || 1);
    });
    build();
    Cade.store.set('cade-outline-open', '1');
  }

  // Debounced rebuild on edits while the panel is open.
  Cade.onEditorUpdate(function (u) {
    if (u.docChanged && document.getElementById('outline-panel')) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(build, 300);
    }
  });

  Cade.registerWidget({
    name: 'Outline',
    description: 'Jump between headings (table of contents)',
    icon: '≡',
    tags: 'outline,toc,headings,navigate',
    open: toggle,
  });
})();
