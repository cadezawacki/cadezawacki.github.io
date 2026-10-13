/* Decode Lab palette scripts (script-pack): "Translate to English" — the
 * selection, or the ``` block / line at the cursor, translated on this device
 * and inserted below as a ```English block (an existing one is replaced; one
 * Undo removes it). A ```Spanish / ```es-ES … block's language is used as
 * given; otherwise it is detected (Chrome's detector, else Decode Lab's).
 * A thin wrapper: it loads decodelab-inline.js (shared with the Translate
 * chips plugin) on first use, which does the work and writes the document
 * itself, so ctx is left untouched. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var RUNTIME = abs(Cade.asset('decodelab-inline.js'));

  var ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 5h9M7.5 3v2M10.5 5c-.8 4-3.3 7-7 8.6M5.4 8.4c1.2 2.1 3 3.8 5.2 4.7'/><path d='M12.5 21l4-10 4 10M13.8 18h5.4'/></svg>";

  var meta = {
    name: 'Translate to English',
    description: 'Translate the selection, or the ```language block / line at the cursor, on this device — inserted below as a ```English block (language auto-detected)',
    icon: ICON,
    tags: 'translate,translation,translator,english,to english,language,detect language,foreign,offline translation,on-device,spanish,french,german,dutch,italian,portuguese,russian,chinese,japanese,korean,arabic,decode lab'
  };
  Cade.registerScript('/**\n' + JSON.stringify(meta, null, 2) + '\n**/\nasync function main(ctx) {\n' +
    '  var R = window.__cadeTrInline;\n' +
    '  if (!R) {\n' +
    '    await new Promise(function (res, rej) {\n' +
    '      var s = document.createElement("script"); s.src = ' + JSON.stringify(RUNTIME) + '; s.async = false;\n' +
    '      s.onload = function () { res(); };\n' +
    '      s.onerror = function () { rej(new Error("The translator failed to load (offline?)")); };\n' +
    '      document.head.appendChild(s);\n' +
    '    });\n' +
    '    R = window.__cadeTrInline;\n' +
    '    if (!R) throw new Error("The translator failed to start");\n' +
    '  }\n' +
    '  await R.translateAtCursor();\n' +
    '}');
})();
