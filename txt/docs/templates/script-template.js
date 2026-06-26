/* SCRIPT TEMPLATE — copy to txt/scripts/<id>/<id>.js and rename.
 * A Ctrl+K text transform. Add a "type":"script" manifest entry (id, name,
 * description, icon, tags, entry). Bump manifest.version + sw.js CACHE_VERSION.
 * See txt/docs/README.md §6.
 *
 * Inside main(ctx):
 *   ctx.fullText  (get/set)  whole document
 *   ctx.selection (get/set)  selection / current line; '' on an empty line
 *   ctx.text      (get)      effective input (selection or fullText)
 *   globals: window, document, ctx, showToast
 *   async: declare `async function main(ctx)` to also get
 *          secureKeywordPrompt, encryptText, decryptText (host awaits it). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;

  window.Cade.registerScript(`/**
    {
      "name": "<Title>",
      "description": "<what it does>",
      "icon": "✦",
      "tags": "<comma,keywords>"
    }
  **/
  function main(ctx) {
    var text = ctx.selection || ctx.fullText;

    // ... transform text ...
    var out = text;

    if (ctx.selection) ctx.selection = out; else ctx.fullText = out;
  }`);
})();
