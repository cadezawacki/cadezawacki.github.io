/* AI — sharing plugin ("Share my AI models with my other devices"; off by
 * default, turned on by the AI widget's setup when you choose to share).
 *
 * While it is on and this device is set up with "This device" (it calls its
 * model services itself), the AI service (ai-service.js) keeps this copy of
 * txt findable by the account's other devices and answers their questions —
 * with its local models, and with its cloud services (its own API keys) only
 * when "Share cloud services too" is on — end-to-end encrypted with the Sync
 * key, one question at a time with a short queue, every request / answer
 * deleted once delivered. The keys never leave this device. It
 * keeps going while the tab is in the background (the phone asks while the
 * laptop's tab sits behind other windows); one tab per browser hosts (a Web
 * Lock), the others stand by.
 *
 * "Ask me each time" (AI preferences): each question shows a card here — who
 * asks which model (and whether it's a paid cloud one), Answer / Decline —
 * and the tab title flashes while one waits; no decision
 * within a minute counts as Decline.
 *
 * Lifetime is tied to the plugin's editor extension (a ViewPlugin): turning
 * the setting off removes it, which withdraws the presence, stops listening
 * and tells anyone waiting. A room switch rebuilds the extension, so stopping
 * waits a moment to see whether it comes straight back. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeAiHostPlugin) return;
  window.__cadeAiHostPlugin = true;
  var Cade = window.Cade, CM = Cade.CM;
  // resolve now, while the loader context is ours
  var CORE_URL = Cade.asset('ai-core.js'), SVC_URL = Cade.asset('ai-service.js'), CSS_URL = Cade.asset('ai.css');
  var SETTING = 'plugins.ai-host';
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    return (loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('AI failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }
  function loadSvc() {
    if (window.__cadeAi) return Promise.resolve(window.__cadeAi);
    return (window.__cadeAiCore ? Promise.resolve() : load(CORE_URL)).then(function () { return load(SVC_URL); }).then(function () {
      if (!window.__cadeAi) throw new Error('AI did not start');
      return window.__cadeAi;
    });
  }
  function css() {
    if (document.querySelector('link[rel="stylesheet"][href="' + CSS_URL + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS_URL;
    document.head.appendChild(l);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------
  var refs = 0, alive = false, stopT = 0, bootT = 0, svc = null, unuse = null, offCfg = null, told = false;
  function acquire() {
    refs++;
    clearTimeout(stopT); stopT = 0;
    if (alive) return;
    alive = true;
    bootT = setTimeout(boot, 800);   // after boot settles
  }
  function release() {
    if (--refs > 0) return;
    refs = 0;
    clearTimeout(stopT);
    stopT = setTimeout(shutdown, 400);
  }
  function boot() {
    bootT = 0;
    loadSvc().then(function (S) {
      if (!alive) return;
      svc = S;
      unuse = S.use();
      var lc = S.local();
      if (lc.role === 'local' && !S.pref('share')) { try { S.P.set('share', true); } catch (e) {} S.setLocal({ shareSeen: true }); }
      if (lc.role !== 'local' && !told) {
        told = true;
        Cade.showToast('AI sharing is on, but this device has no model set up — open AI and choose “This computer”', 'info', 5000);
      }
      S.host.enable(ask);
    }).catch(function (e) { console.warn('ai-host:', e && e.message); });
  }
  function shutdown() {
    stopT = 0;
    if (!alive || refs > 0) return;
    alive = false;
    clearTimeout(bootT); bootT = 0;
    closeCards(false);
    if (svc) {
      svc.host.disable();
      // switched off in Preferences → Devices: the AI page's "share" follows
      var st;
      try { st = Cade.Settings && Cade.Settings.get(SETTING); } catch (e) {}
      if (st === false && svc.pref('share')) { svc.setLocal({ shareSeen: false }); try { svc.P.set('share', false); } catch (e) {} }
    }
    if (unuse) { unuse(); unuse = null; }
    if (offCfg) { offCfg(); offCfg = null; }
  }

  // ---- "Ask me each time" ----------------------------------------------------------------------------
  var cards = [], title0 = null, flashT = 0, flashOn = false;
  function flash() {
    if (!cards.length) { stopFlash(); return; }
    if (title0 == null) title0 = document.title;
    if (flashT) return;
    flashT = setInterval(function () {
      flashOn = !flashOn;
      document.title = flashOn ? '✨ ' + cards[0].who + ' is asking…' : title0;
    }, 1200);
  }
  function stopFlash() {
    clearInterval(flashT); flashT = 0; flashOn = false;
    if (title0 != null) { document.title = title0; title0 = null; }
  }
  function closeCards(answer) {
    cards.slice().forEach(function (c) { c.done(answer); });
  }
  function ask(job) {
    css();
    return new Promise(function (resolve) {
      var r = job.req || {}, last = '', t = job.target || {}, ep = t.ep || {}, mname = t.model || r.model || '';
      if (mname && ep.models) ep.models.some(function (m) { if (m.id === mname && m.name) { mname = m.name; return true; } return false; });
      for (var i = (r.messages || []).length - 1; i >= 0; i--) if (r.messages[i].role === 'user') { last = r.messages[i].content; break; }
      var q = last.split('\n--- ')[0].replace(/\s+/g, ' ').trim();
      var el = document.createElement('div');
      el.className = 'ai-ask';
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-label', 'AI question from ' + (r.name || 'another device'));
      el.innerHTML = '<div class="ai-ask-t"><span class="ai-ask-ic" aria-hidden="true">✨</span><span><b>' + esc(r.name || 'Another device') + '</b> asks ' +
        (mname ? '<span class="ai-ask-m">' + esc(mname) + '</span>' : 'your model') + (ep.label ? ' · ' + esc(ep.label) : '') +
        (ep.where === 'cloud' ? ' <span class="ai-ask-cloud">cloud — uses your API key</span>' : '') + '</span></div>' +
        (q ? '<div class="ai-ask-q">“' + esc(q.length > 140 ? q.slice(0, 140) + '…' : q) + '”</div>' : '') +
        '<div class="ai-ask-b"><button type="button" class="ai-ask-no">Decline</button><button type="button" class="ai-ask-yes">Answer</button></div>';
      var stack = document.querySelector('.ai-ask-stack');
      if (!stack) { stack = document.createElement('div'); stack.className = 'ai-ask-stack'; document.body.appendChild(stack); }
      stack.appendChild(el);
      var t = 0, c = {
        who: r.name || 'A device',
        done: function (yes) {
          var i = cards.indexOf(c);
          if (i < 0) return;
          clearTimeout(t);
          cards.splice(i, 1);
          el.remove();
          if (stack && !stack.children.length) stack.remove();
          flash();
          resolve(!!yes);
        }
      };
      cards.push(c);
      el.querySelector('.ai-ask-no').addEventListener('click', function () { c.done(false); });
      el.querySelector('.ai-ask-yes').addEventListener('click', function () { c.done(true); });
      // the host times out the question after a minute; take the card down with it
      t = setTimeout(function () { c.done(false); }, (window.__cadeAiCore ? window.__cadeAiCore.RELAY.ASK_MS : 60000) + 500);
      flash();
      try { Cade.haptic(20); } catch (e) {}
    });
  }

  window.__cadeAiHostPlugin = { status: function () { return svc ? svc.host.status() : { enabled: alive, phase: 'loading' }; }, cards: function () { return cards.length; } };

  var ext = [];
  if (CM && CM.ViewPlugin) ext = CM.ViewPlugin.define(function () { acquire(); return { destroy: release }; });
  else acquire();
  Cade.registerPlugin({ id: 'ai-host', ext: ext });
})();
