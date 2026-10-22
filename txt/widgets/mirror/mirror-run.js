/* Folder Mirror — runner (plugin "Keep Folder Mirror running").
 *
 * Off until Folder Mirror's setup turns it on (and off again on Stop
 * mirroring). While on, it starts the mirror engine (mirror-engine.js) so the
 * chosen rooms and the folder stay in step without the widget open — on
 * desktop Chrome / Edge only, with permission to the folder, and only while
 * the page is visible (the engine stops its timers when hidden). Anywhere
 * else (iPhone, Safari, Firefox) it does nothing at all: no script loads.
 *
 * After a reload Chrome may want the folder permission confirmed again, which
 * needs a click: a small "Reconnect Folder Mirror" card (bottom left) asks for
 * it instead of the mirror failing silently. × hides it for this page load.
 *
 * Lifetime is tied to the plugin's editor extension (a ViewPlugin): turning
 * the setting off removes the extension and stops the engine. A room switch
 * rebuilds the extension, so stopping waits a moment to see whether it comes
 * straight back. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeMirrorRun) return;
  window.__cadeMirrorRun = true;
  var Cade = window.Cade, CM = Cade.CM;
  // resolve now, while the loader context is ours
  var CORE_URL = Cade.asset('mirror-core.js'), ENGINE_URL = Cade.asset('mirror-engine.js'), CSS_URL = Cade.asset('mirror.css');

  function supported() {
    if (typeof window.showDirectoryPicker !== 'function') return false;
    var ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
    return !/iPhone|iPad|iPod|Android|Mobile/i.test(ua);
  }
  var loads = {};
  function load(url, glob) {
    if (window[glob]) return Promise.resolve(window[glob]);
    if (!loads[url]) {
      loads[url] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = url; s.async = true;
        s.onload = function () { window[glob] ? res(window[glob]) : rej(new Error('missing ' + glob)); };
        s.onerror = function () { delete loads[url]; rej(new Error('Folder Mirror failed to load')); };
        document.head.appendChild(s);
      });
    }
    return loads[url];
  }
  function loadEngine() {
    return load(CORE_URL, '__cadeMirrorCore').then(function () { return load(ENGINE_URL, '__cadeMirrorEngine'); });
  }
  function css() {
    if (document.querySelector('link[rel="stylesheet"][href="' + CSS_URL + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS_URL;
    document.head.appendChild(l);
  }

  // ---- lifecycle ---------------------------------------------------------------------
  var refs = 0, alive = false, stopT = 0, bootT = 0, offSub = null, chip = null, dismissed = false;
  function acquire() {
    refs++;
    clearTimeout(stopT); stopT = 0;
    if (alive) return;
    alive = true;
    if (!supported()) return;
    bootT = setTimeout(boot, 600);   // after the app's own start-up settles
  }
  function release() {
    if (--refs > 0) return;
    refs = 0;
    clearTimeout(stopT);
    stopT = setTimeout(shutdown, 400);
  }
  function boot() {
    bootT = 0;
    loadEngine().then(function (M) {
      if (!alive) return;
      if (!offSub) offSub = M.subscribe(onStatus);
      M.start('plugin');
    }, function () {});
  }
  function shutdown() {
    stopT = 0;
    if (!alive || refs > 0) return;
    alive = false;
    clearTimeout(bootT); bootT = 0;
    if (offSub) { offSub(); offSub = null; }
    hideChip();
    var M = window.__cadeMirrorEngine;
    if (M) M.stop('plugin');
  }

  // ---- "Reconnect Folder Mirror" ------------------------------------------------------
  function onStatus(s) {
    if (s.started && s.state === 'permission' && !dismissed) showChip(s);
    else hideChip();
  }
  function showChip(s) {
    css();
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'mirror-chip';
      chip.setAttribute('role', 'status');
      chip.innerHTML = '<span class="mirror-chip-ic" aria-hidden="true">🗂</span><span class="mirror-chip-t"></span>' +
        '<button type="button" class="mirror-chip-go">Reconnect</button>' +
        '<button type="button" class="mirror-chip-x" aria-label="Hide" title="Hide">×</button>';
      chip.querySelector('.mirror-chip-go').addEventListener('click', function () {
        var M = window.__cadeMirrorEngine;
        if (!M) return;
        // requestPermission needs this click — call it straight away.
        M.reconnect().then(function (ok) {
          if (!ok) Cade.showToast('Folder Mirror stays paused until the folder is allowed', 'info', 3000);
          else Cade.showToast('Folder Mirror reconnected', 'success', 1800);
        });
      });
      chip.querySelector('.mirror-chip-x').addEventListener('click', function () { dismissed = true; hideChip(); });
      document.body.appendChild(chip);
    }
    chip.querySelector('.mirror-chip-t').textContent = 'Folder Mirror needs your OK to keep using “' + (s.folder || 'the folder') + '”';
  }
  function hideChip() { if (chip) { chip.remove(); chip = null; } }

  Cade.registerPlugin({
    id: 'mirror-run',
    ext: CM.ViewPlugin.define(function () {
      acquire();
      return { destroy: release };
    }),
  });
})();
