/* Code Runner palette scripts (script-pack): Run Code Block, Run All Code
 * Blocks, Run Code Blocks Above, Restart Code Runtime (linked blocks: the
 * note's variables), Clear Code Outputs, Stop Running Code, Identify Code
 * Blocks. Each is
 * a thin wrapper that loads the shared engine (coderun-kit.js +
 * coderun-engine.js) on first use and calls it; the engine writes into the
 * document itself, so ctx is left untouched.
 * Script sources are evaluated in isolation, so the engine URLs are baked
 * into each source string here. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var KIT = abs(Cade.asset('coderun-kit.js')), ENGINE = abs(Cade.asset('coderun-engine.js'));

  var ENSURE =
    'var E = window.__cadeCodeRun;\n' +
    'if (!E) {\n' +
    '  var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});\n' +
    '  var load = function (u) {\n' +
    '    if (L[u]) return L[u];\n' +
    '    L[u] = new Promise(function (res, rej) {\n' +
    '      var s = document.createElement("script"); s.src = u; s.async = false;\n' +
    '      s.onload = function () { res(); };\n' +
    '      s.onerror = function () { delete L[u]; rej(new Error("Code Runner failed to load (offline?)")); };\n' +
    '      document.head.appendChild(s);\n' +
    '    });\n' +
    '    return L[u];\n' +
    '  };\n' +
    '  try { await load(' + JSON.stringify(KIT) + '); await load(' + JSON.stringify(ENGINE) + '); }\n' +
    '  catch (e) { showToast(e.message, "error", 4000); return; }\n' +
    '  E = window.__cadeCodeRun;\n' +
    '}\n' +
    'if (!E) { showToast("Code Runner failed to start", "error", 4000); return; }\n';

  function reg(meta, body) {
    Cade.registerScript('/**\n' + JSON.stringify(meta, null, 2) + '\n**/\nasync function main(ctx) {\n' + ENSURE + body + '\n}');
  }

  var PLAY = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='7 4 19 12 7 20 7 4'/></svg>";
  var ALL = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='4 5 11 12 4 19 4 5'/><polygon points='13 5 20 12 13 19 13 5'/></svg>";
  var CLEAR = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 6h18'/><path d='M8 6V4h8v2'/><path d='M6 6l1 14h10l1-14'/></svg>";
  var TAG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z'/><circle cx='7.5' cy='7.5' r='1.5'/></svg>";
  var STOP = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='5' y='5' width='14' height='14' rx='2'/></svg>";

  reg({
    name: 'Run Code Block',
    description: 'Run the ```js / ts / python / json block at the cursor — output goes below it',
    icon: PLAY,
    tags: 'run,execute,code,block,javascript,js,typescript,ts,python,py,json,output,console'
  }, 'await E.runAtCursor();');

  reg({
    name: 'Run All Code Blocks',
    description: 'Run every runnable code block in order (linked blocks share variables)',
    icon: ALL,
    tags: 'run,all,execute,code,blocks,notebook,javascript,python,json'
  }, 'await E.runAll();');

  var ABOVE = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='7 4 19 12 7 20 7 4'/><path d='M4 3v18'/></svg>";
  var RESTART = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 12a9 9 0 1 0 3-6.7'/><polyline points='3 3 3 9 9 9'/></svg>";
  reg({
    name: 'Run Code Blocks Above',
    description: 'Run every runnable code block above the cursor, in order',
    icon: ABOVE,
    tags: 'run,above,before,execute,code,blocks,notebook,cells,javascript,python'
  }, 'await E.runAbove();');

  reg({
    name: 'Restart Code Runtime',
    description: "Clear this note's variables (linked JS & Python blocks) — blocks that ran are marked stale",
    icon: RESTART,
    tags: 'restart,reset,kernel,runtime,clear,variables,scope,notebook,javascript,python'
  }, 'E.restart();');

  reg({
    name: 'Clear Code Outputs',
    description: 'Remove every ```output block from the document',
    icon: CLEAR,
    tags: 'clear,output,outputs,remove,code,results'
  }, 'E.clearOutputs();');

  reg({
    name: 'Identify Code Blocks',
    description: 'Add the detected language after ``` on code blocks that have none (imported file names count) — selection or whole note',
    icon: TAG,
    tags: 'identify,detect,guess,language,tag,label,code,blocks,fence,syntax,auto,imported,files,python,javascript'
  }, 'E.identifyBlocks();');

  reg({
    name: 'Stop Running Code',
    description: 'Stop the running code block and clear the queue',
    icon: STOP,
    tags: 'stop,cancel,kill,abort,interrupt,code,run'
  }, 'E.stop();');
})();
