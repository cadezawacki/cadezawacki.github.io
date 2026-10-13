/* Code Runner widget — the palette entry for the Code Runner panel: run
 * buttons, live output of the running block, run history (copy / insert /
 * go to), and options (output below the block or panel only, JS and Python
 * timeouts, Python load / reset). The engine (coderun-engine.js, after the
 * shared coderun-kit.js) loads on first open; the palette scripts and the
 * "Run buttons" editor plugin load the same engine. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  // resolve now, while currentScript is this file
  var KIT = abs(Cade.asset('coderun-kit.js')), ENGINE = abs(Cade.asset('coderun-engine.js'));

  // Shared, deduped loader (the scripts and the plugin use the same registry).
  function load(url) {
    var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});
    if (L[url]) return L[url];
    L[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete L[url]; rej(new Error('Code Runner failed to load (offline?)')); };
      document.head.appendChild(s);
    });
    return L[url];
  }
  function ensure() {
    if (window.__cadeCodeRun) return Promise.resolve(window.__cadeCodeRun);
    return load(KIT).then(function () { return load(ENGINE); }).then(function () {
      if (!window.__cadeCodeRun) throw new Error('Code Runner failed to start');
      return window.__cadeCodeRun;
    });
  }

  Cade.registerWidget({
    name: 'Code Runner',
    description: 'Run ```js, ts, python & json blocks — output below the block, timeouts, Python packages',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/><path d="M10.5 9v6l4.5-3z" fill="currentColor" stroke-width="1.2"/></svg>',
    tags: 'run,code,execute,javascript,js,typescript,ts,python,py,pyodide,json,console,repl,output,sandbox,notebook,jupyter',
    open: function () {
      Cade.closeAllMenus();
      ensure().then(function (E) { E.togglePanel(); }, function (e) { Cade.showToast(e.message, 'error', 4000); });
    }
  });
})();
