/* Notebook widget — the palette entry for the Notebook panel: Run all, Run
 * above, Stop, Restart (clears the note's variables), the note's blocks with
 * their state and what each defines / uses, and a Variables inspector per
 * language. The machinery is notebook-engine.js (after notebook-core.js),
 * loaded through the Code Runner engine, which also routes every js / ts /
 * python run to it while linked blocks are on. Nothing loads until the panel
 * opens or a block runs. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  // resolve now, while currentScript is this file
  var BASE = abs(Cade.baseURL());
  var CR = BASE.replace(/notebook\/$/, 'coderun/');
  var KIT = CR + 'coderun-kit.js', ENGINE = CR + 'coderun-engine.js';

  // the loader registry shared with Code Runner, its scripts and the Run buttons plugin
  function load(url) {
    var L = window.__cadeCrLoads || (window.__cadeCrLoads = {});
    if (L[url]) return L[url];
    L[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { res(); };
      s.onerror = function () { delete L[url]; rej(new Error('The notebook failed to load (offline?)')); };
      document.head.appendChild(s);
    });
    return L[url];
  }
  function ensure() {
    var E = window.__cadeCodeRun;
    var p = E ? Promise.resolve(E) : load(KIT).then(function () { return load(ENGINE); }).then(function () {
      if (!window.__cadeCodeRun) throw new Error('Code Runner failed to start');
      return window.__cadeCodeRun;
    });
    return p.then(function (E2) { return E2._loadNotebook(); });
  }

  Cade.registerWidget({
    name: 'Notebook',
    description: 'Linked, reactive code blocks: js & python blocks in a note share variables, dependents re-run, rich output, variables',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="15" height="18" rx="2"/><path d="M8 3v18"/><path d="M11.5 8.5l3 2.5-3 2.5"/><path d="M11.5 16.5h4"/></svg>',
    tags: 'notebook,jupyter,observable,reactive,linked,cells,kernel,restart,run all,variables,inspector,display,chart,table,javascript,js,typescript,python,py,code',
    open: function () {
      Cade.closeAllMenus();
      ensure().then(function (N) { N.togglePanel(); }, function (e) { Cade.showToast(e.message, 'error', 4000); });
    }
  });
})();
