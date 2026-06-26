/* WIDGET TEMPLATE — copy to txt/widgets/<id>/<id>.js and rename.
 * Then add a "type":"widget" entry to txt/manifest.json (id, name, description,
 * icon, tags, entry, css), bump manifest.version + sw.js CACHE_VERSION, validate.
 * See txt/docs/README.md §5. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  // Load CSS HERE (module-load time), never inside open().
  Cade.loadCSS('<id>.css'); // delete if you have no stylesheet

  var PANEL_ID = '<id>-panel';

  function open() {
    Cade.closeAllMenus();
    // Toggle: close if already open.
    var existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }

    var html = '<div class="<id>-body">Hello from <id>!</div>';
    var panel = Cade.mkPanel(PANEL_ID, '🧩 <Title>', html);

    // Clean up timers/listeners when the panel closes.
    panel._onClose = function () { /* cancelAnimationFrame(raf); document.removeEventListener(...) */ };

    // Persist state example:
    //   var n = parseInt(Cade.store.get('cade-<id>-count') || '0', 10);
    //   Cade.store.set('cade-<id>-count', String(n + 1));

    // Use the editor example:
    //   Cade.editor.dispatch({ changes: { from: 0, insert: 'hi' } });
  }

  Cade.registerWidget({
    name: '<Title>',            // MUST match manifest "name"
    description: '<what it does>',
    icon: '🧩',                 // emoji or inline <svg> string
    tags: '<comma,keywords>',
    open: open,
  });
})();
