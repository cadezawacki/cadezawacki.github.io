/* Remote — receiver (plugin "Let my other devices control this one").
 *
 * Keeps this copy of the app findable by the Remote widget on the account's
 * other devices, and answers when one connects. It is deliberately tiny and
 * lazy: nothing happens without Sync set up; while the page is hidden it goes
 * offline (no presence, no listener); while visible it holds one presence
 * entry (refreshed once a minute) and one listener for incoming hellos. The
 * link (remote-link.js) loads when the page first goes online, the host
 * (remote-host.js: sessions, WebRTC, key injection) only when a controller
 * actually connects.
 *
 * Lifetime is tied to the plugin's editor extension (a ViewPlugin): turning the
 * setting off removes the extension, which takes the receiver offline. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeRemoteRecv) return;
  var Cade = window.Cade, CM = Cade.CM;
  var LINK_URL = Cade.asset('remote-link.js'), HOST_URL = Cade.asset('remote-host.js'); // resolve now, while the loader context is ours
  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    return (loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('Remote failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }

  var refs = 0, online = false, stopSig = null, touchT = 0, retryT = 0, gen = 0;
  function onVis() {
    if (!refs) return;
    if (document.visibilityState === 'visible' && Cade.cloud.configured()) goOnline();
    else goOffline(document.visibilityState !== 'visible');
  }
  function goOnline() {
    clearTimeout(retryT); retryT = 0;
    if (online) return;
    online = true;
    var g = ++gen;
    load(LINK_URL).then(function () {
      var L = window.__cadeRemoteLink;
      if (!online || g !== gen) return;
      return L.announce().then(function (ok) {
        if (!online || g !== gen) return;
        if (!ok) { online = false; retryT = setTimeout(onVis, 30000); return; } // Firebase not ready yet
        stopSig = L.listenSig('r', onSig);
        touchT = setInterval(function () { L.touch(); }, 60000);
      });
    }).catch(function () { online = false; });
  }
  function goOffline(hidden) {
    clearTimeout(retryT); retryT = 0;
    if (!online) { if (refs && !hidden && !Cade.cloud.configured()) retryT = setTimeout(onVis, 30000); return; }
    online = false; gen++;
    clearInterval(touchT); touchT = 0;
    if (stopSig) { stopSig(); stopSig = null; }
    var L = window.__cadeRemoteLink;
    if (L) L.withdraw();
    if (window.__cadeRemoteHost) window.__cadeRemoteHost.endAll('offline');
  }
  function onSig(from, msg) {
    if (!online || !msg) return;
    if (msg.t === 'bye' && !window.__cadeRemoteHost) return;
    load(HOST_URL).then(function () { if (online && window.__cadeRemoteHost) window.__cadeRemoteHost.onSig(from, msg); }).catch(function () {});
  }

  function start() {
    if (++refs > 1) return;
    document.addEventListener('visibilitychange', onVis);
    setTimeout(onVis, 1200); // after boot settles
  }
  function stop() {
    if (--refs > 0) return;
    refs = 0;
    document.removeEventListener('visibilitychange', onVis);
    goOffline(false);
    clearTimeout(retryT); retryT = 0;
  }

  // For the Remote widget: is this copy ready to be controlled, and a nudge
  // after the user changes something (device name, Sync set up).
  window.__cadeRemoteRecv = {
    status: function () { return { enabled: refs > 0, online: online, configured: Cade.cloud.configured() }; },
    refresh: function () { if (!refs) return; goOffline(false); onVis(); }
  };

  var ext = [];
  if (CM && CM.ViewPlugin) ext = CM.ViewPlugin.define(function () { start(); return { destroy: stop }; });
  else start();
  Cade.registerPlugin({ id: 'remote-recv', ext: ext });
})();
