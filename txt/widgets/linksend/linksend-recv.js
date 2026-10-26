/* Send to device — receiver (plugin "Open links sent from my other devices", off by default).
 *
 * While it is on, this copy of the app is a target for links sent from the
 * account's other devices (the ?send= sheet from the iOS Shortcut or the
 * bookmarklet, a link's "Send to device…", the Send to device widget): it
 * keeps a presence entry and listens on its own inbox (linksend-core.js) —
 * also while the tab sits in the background, which is the point. Only the
 * presence heartbeat stops while the page is hidden.
 *
 * Each link that arrives: refused unless http / https; older than the TTL
 * (Widget preferences, default 10 min) → not opened, listed under Missed
 * links (no tab springing open hours later); more than 5 in a minute → listed,
 * not opened; else window.open(url, '_blank'). Without a user gesture a
 * browser opens that only when pop-ups are allowed for this site — when it
 * returns null the link waits on a card (one tap opens it) and, if allowed, a
 * system notification whose click opens it. The sender gets a sealed ack
 * (opened / blocked / limited / expired / refused) and the message is deleted.
 * A one-time hint explains how to allow pop-ups per browser, with a Test.
 *
 * Lifetime is tied to the plugin's editor extension (a ViewPlugin, refcounted
 * and debounced across room switches): switching the setting off removes the
 * extension, which takes this device out of the list and drops its inbox. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeLinkRecv) return;
  var Cade = window.Cade, CM = Cade.CM;
  var CORE_URL = Cade.asset('linksend-core.js');
  var TEST_URL = new URL(Cade.asset('opened.html'), location.href).href;
  var SETTING = 'plugins.linksend-recv';
  var K_HINT = 'cade-linksend-hint', K_WELCOME = 'cade-linksend-welcome';
  var TITLE_MARK = '🔗 ';
  Cade.loadCSS('linksend.css');
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };

  var coreP = null;
  function loadCore() {
    if (window.__cadeLinkCore) return Promise.resolve(window.__cadeLinkCore);
    if (coreP) return coreP;
    return (coreP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CORE_URL; s.async = true;
      s.onload = function () { window.__cadeLinkCore ? res(window.__cadeLinkCore) : rej(new Error('linksend core missing')); };
      s.onerror = function () { coreP = null; rej(new Error('Send to device failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }

  // ---- lifecycle -----------------------------------------------------------------------------
  var refs = 0, alive = false, stopT = 0, bootT = 0, retryT = 0, beatT = 0;
  var C = null, pres = null, stopInbox = null, online = false, listening = false, gen = 0, limiter = null;
  function visible() { return document.visibilityState === 'visible'; }
  function acquire() {
    refs++;
    clearTimeout(stopT); stopT = 0;
    if (alive) return;
    alive = true;
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('storage', onStorage);
    bootT = setTimeout(function () { bootT = 0; goOnline(); }, 1200);   // after boot settles
  }
  function release() {
    if (--refs > 0) return;
    refs = 0;
    clearTimeout(stopT);
    stopT = setTimeout(shutdown, 400);   // a room switch rebuilds the extension: don't flap
  }
  function shutdown() {
    stopT = 0;
    if (!alive || refs > 0) return;
    alive = false;
    clearTimeout(bootT); bootT = 0;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('storage', onStorage);
    var off = false;
    try { off = Cade.Settings && Cade.Settings.get(SETTING) === false; } catch (e) {}
    goOffline(off);
    closeCard();
    closeNotes();
  }
  function goOnline() {
    clearTimeout(retryT); retryT = 0;
    if (!alive || online) return;
    var g = ++gen;
    loadCore().then(function (core) {
      C = core;
      if (!alive || g !== gen || online) return;
      if (!C.configured()) { if (visible()) retryT = setTimeout(goOnline, 30000); return; }
      limiter = limiter || C.makeLimiter(C.RATE_MAX, C.RATE_WINDOW);
      online = true;
      pres = C.presence();
      pres.start().then(function (ok) {
        if (g !== gen || !online) return;
        if (!ok) { online = false; pres.stop(false); pres = null; retryT = setTimeout(goOnline, 30000); return; }
        stopInbox = C.listenInbox(onMessage, visible);
        listening = true;
        if (visible()) startBeat();
        welcome();
        C.changed('recv-status');
      });
    }).catch(function (e) { console.warn('linksend:', e && e.message); });
  }
  function goOffline(withdraw) {
    gen++;
    clearTimeout(retryT); retryT = 0;
    stopBeat();
    if (stopInbox) { stopInbox(); stopInbox = null; }
    if (pres) { pres.stop(withdraw); pres = null; }
    var was = online;
    online = listening = false;
    if (was && C) C.changed('recv-status');
  }
  // Settings live per browser but don't reach its other tabs: switched off in
  // one, the others follow (else they would keep listening, unlisted).
  function onStorage(e) {
    if (e && e.key === 'cade-pref:' + SETTING && e.newValue === 'false') { try { Cade.Settings.set(SETTING, false); } catch (x) {} }
  }
  function startBeat() { if (!beatT && pres) beatT = setInterval(function () { if (pres) pres.touch(); }, 60000); }
  function stopBeat() { clearInterval(beatT); beatT = 0; }
  function onVis() {
    if (!alive) return;
    if (!online) { if (visible()) goOnline(); return; }
    if (pres) pres.touch();   // visible again, or leaving: either way "last seen" is now
    if (visible()) { startBeat(); syncTitle(); } else stopBeat();
  }

  // ---- incoming ------------------------------------------------------------------------------
  function meDev() { var d = Cade.cloud.device; return { id: d.id, name: d.name, kind: d.kind }; }
  function isTest(url) { return typeof url === 'string' && url.indexOf(TEST_URL) === 0; }
  function onMessage(item) {
    var msg = item.msg;
    if (!msg) { item.done(); return; }
    var t = C.now(), at = C.sentAt(msg.at, item.at), ttl = C.ttlMs(C.ttlPref());
    var rec = { id: msg.id, url: msg.url || '', title: msg.title, room: msg.room || '', from: msg.from.name, fromKind: msg.from.kind, fromId: msg.from.id, at: at || t, rt: Date.now() };
    if (isTest(rec.url)) rec.test = true;
    function finish(st, how) {
      rec.st = st;
      if (how) rec.how = how;
      if (!rec.test) C.hist.addRecv(rec);
      C.sendAck(rec.fromId, C.makeAck(rec.id, st, meDev(), C.now(), how));
      item.done();
      try { document.dispatchEvent(new CustomEvent('cade-linksend-handled', { detail: { id: rec.id, st: st, how: how || '' } })); } catch (e) {}
    }
    var what = C.decide(msg, item.at, t, ttl, limiter, Date.now());
    if (what === 'refused') {
      finish('refused');
      Cade.showToast(msg.from.name + ' sent something that isn’t a web link — not opened', 'error', 4000);
      return;
    }
    if (what === 'expired') { finish('expired'); showCard([rec], 'missed'); return; }
    if (what === 'limited') { finish('limited'); showCard([rec], 'waiting'); return; }
    if (rec.room && openNote(rec)) {
      finish('opened', 'note');
      Cade.showToast('Opened “' + rec.room + '” from ' + rec.from, 'success', 3000);
      return;
    }
    if (openUrl(rec.url)) {
      if (C.popState() !== 'ok') { C.setPopState('ok'); if (pres) pres.touch(); }
      finish('opened', 'auto');
      Cade.showToast((rec.test ? 'Test link opened by itself ✓' : 'Opened a link from ' + rec.from), 'success', 2500);
      return;
    }
    if (C.popState() !== 'blocked') { C.setPopState('blocked'); if (pres) pres.touch(); }
    finish('blocked');
    showCard([rec], 'waiting');
    notify(rec);
  }
  // No 'noopener' feature string: with it window.open returns null even when
  // the tab opened, so a block couldn't be told apart. The opener is cut by hand.
  function openUrl(url) {
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (!w) return false;
    try { w.opener = null; } catch (e) {}
    return true;
  }
  // "Open this note on…": switch to the room here instead of opening a second copy of the app.
  function findRoom(name) {
    var api = Cade.roomsApi, list = [];
    try { list = api.list() || []; } catch (e) { return null; }
    if (list.indexOf(name) >= 0) return name;
    var low = String(name).toLowerCase();
    return list.filter(function (r) { return String(r).toLowerCase() === low; })[0] || null;
  }
  // A note this device doesn't list yet is added first (as a ?room= link would
  // do) — notes sync by name, so its text comes from the server.
  function openNote(rec) {
    var api = Cade.roomsApi, name = findRoom(rec.room);
    try {
      if (!name) {
        if (!api.ensureRoom) return false;
        api.ensureRoom(rec.room);
        name = findRoom(rec.room);
        if (!name) return false;
      }
      Promise.resolve(api.switchRoom(name)).catch(function () {});
    } catch (e) { return false; }
    return true;
  }
  function markOpened(rec, how) {
    if (!rec.test) C.hist.updRecv(rec.id, { st: 'opened', how: how || 'tap' });
    C.sendAck(rec.fromId, C.makeAck(rec.id, 'opened', meDev(), C.now(), how || 'tap'));
    dropItem(rec.id);
    var n = notes[rec.id];
    if (n) { try { n.close(); } catch (e) {} delete notes[rec.id]; }
    try { document.dispatchEvent(new CustomEvent('cade-linksend-handled', { detail: { id: rec.id, st: 'opened', how: how || 'tap' } })); } catch (e) {}
  }

  // ---- system notification (only when the page isn't in front) -------------------------------
  var notes = {};
  function prefNotify() { try { return Cade.prefs('linksend-recv').get('notify') !== false; } catch (e) { return true; } }
  function notify(rec) {
    if (!prefNotify() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (visible() && document.hasFocus && document.hasFocus()) return;
    try {
      var n = new Notification(C.kindIcon(rec.fromKind) + ' ' + rec.from + ' sent a link', {
        body: (rec.title ? rec.title + '\n' : '') + C.shortUrl(rec.url, 80) + '\nClick to open it.',
        tag: 'cade-linksend-' + rec.id, requireInteraction: true
      });
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        // a notification click counts as a user gesture in Chrome / Edge / Firefox
        if (openUrl(rec.url)) markOpened(rec, 'tap');
        try { n.close(); } catch (e) {}
      };
      notes[rec.id] = n;
    } catch (e) {}
  }
  function closeNotes() { for (var k in notes) { try { notes[k].close(); } catch (e) {} } notes = {}; }

  // ---- the card --------------------------------------------------------------------------------
  // One card at the bottom right (a sheet across the bottom on phones) listing
  // the links waiting here: blocked pop-ups / rate-limited ("waiting") and
  // ones that came in after the TTL ("missed"). Each opens with one tap (a real
  // link, so no pop-up blocker is involved).
  var card = null, items = [], hintOpen = false;
  function showCard(recs, kind) {
    recs.forEach(function (r) {
      if (items.some(function (x) { return x.rec.id === r.id; })) return;
      items.push({ rec: r, kind: kind });
    });
    if (kind === 'waiting' && !seenHint()) { hintOpen = true; markHint(); }
    renderCard();
    try { Cade.haptic(15); } catch (e) {}
  }
  function seenHint() { try { return Cade.store.get(K_HINT) === '1'; } catch (e) { return true; } }
  function markHint() { try { Cade.store.set(K_HINT, '1'); } catch (e) {} }
  // First start on this device (page in front): explain pop-ups once.
  function welcome() {
    var done = true;
    try { done = Cade.store.get(K_WELCOME) === '1'; } catch (e) {}
    if (done || !visible() || C.popState() === 'ok') return;
    try { Cade.store.set(K_WELCOME, '1'); } catch (e) {}
    markHint();
    if (document.getElementById('linksend-panel')) return;   // its Setup tab is already explaining
    hintOpen = true;
    renderCard(true);
  }
  function dropItem(id) {
    items = items.filter(function (x) { return x.rec.id !== id; });
    if (!items.length && !hintOpen) closeCard(); else renderCard();
  }
  function closeCard() {
    items = []; hintOpen = false;
    stopTest();
    if (card) { card.remove(); card = null; }
    syncTitle();
  }
  function ago(rec) { return C.fmtAgo(Math.max(0, C.now() - (rec.at || C.now()))); }
  function itemHtml(x) {
    var r = x.rec, label = r.room ? '📝 ' + r.room : (r.title || C.hostOf(r.url) || C.shortUrl(r.url, 60));
    var why = x.kind === 'missed' ? 'arrived after ' + C.ttlPref() + ' min' : (r.st === 'limited' ? 'many links at once' : 'pop-up blocked');
    var open = r.room
      ? '<button type="button" class="ls-open" data-note="' + esc(r.id) + '">Open</button>'
      : '<a class="ls-open" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" data-open="' + esc(r.id) + '">Open</a>';
    return '<div class="ls-it" data-id="' + esc(r.id) + '">' +
      '<div class="ls-it-txt"><b>' + esc(label) + '</b>' +
      (r.room ? '' : '<span class="ls-it-url">' + esc(C.shortUrl(r.url, 70)) + '</span>') +
      '<small>' + esc(C.kindIcon(r.fromKind) + ' ' + r.from + ' · ' + ago(r) + ' · ' + why) + '</small></div>' +
      open + '<button type="button" class="ls-it-x" data-drop="' + esc(r.id) + '" aria-label="Dismiss">×</button></div>';
  }
  function title() {
    var w = items.filter(function (x) { return x.kind === 'waiting'; }), m = items.length - w.length;
    if (!items.length) return 'Links from your other devices will open here';
    if (w.length && !m) {
      var from = w[0].rec.from, same = w.every(function (x) { return x.rec.from === from; });
      return C.kindIcon(w[0].rec.fromKind) + ' ' + (same ? from : 'Your devices') + ' sent ' + (w.length === 1 ? 'a link' : w.length + ' links');
    }
    if (!w.length) return '📥 Missed while txt was away';
    return '🔗 ' + items.length + ' links from your devices';
  }
  function renderCard(welcomeOnly) {
    if (!C) return;
    if (!card) {
      card = document.createElement('div');
      card.className = 'ls-card';
      card.setAttribute('role', 'region');
      card.setAttribute('aria-label', 'Links sent from your other devices');
      card.addEventListener('click', onCardClick);
      document.body.appendChild(card);
    }
    var waiting = items.some(function (x) { return x.kind === 'waiting'; });
    var showWhy = waiting && C.popState() !== 'ok';
    card.innerHTML =
      '<div class="ls-card-h"><span class="ls-card-t">' + esc(title()) + '</span>' +
      '<button type="button" class="ls-x" data-act="close" aria-label="Dismiss all">×</button></div>' +
      (items.length ? '<div class="ls-card-items">' + items.map(itemHtml).join('') + '</div>' : '') +
      (hintOpen ? '<div class="ls-card-hint">' + hintHtml(welcomeOnly || !items.length) + '</div>'
        : (showWhy ? '<button type="button" class="ls-why" data-act="why">Make links open by themselves…</button>' : ''));
    card.classList.toggle('ls-card-hinting', hintOpen);
    paintTest();
    syncTitle();
  }
  function onCardClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-open],[data-note],[data-drop]') : null;
    if (!t) return;
    var find = function (id) { var x = items.filter(function (i) { return i.rec.id === id; })[0]; return x && x.rec; };
    if (t.hasAttribute('data-open')) { var r = find(t.getAttribute('data-open')); if (r) setTimeout(function () { markOpened(r, 'tap'); }, 0); return; }
    if (t.hasAttribute('data-note')) { var n = find(t.getAttribute('data-note')); if (n) { if (!openNote(n) && n.url) window.open(n.url, '_blank', 'noopener'); markOpened(n, 'note'); } return; }
    if (t.hasAttribute('data-drop')) { dropItem(t.getAttribute('data-drop')); return; }
    var a = t.getAttribute('data-act');
    if (a === 'close' || a === 'gotit') closeCard();
    else if (a === 'why') { hintOpen = true; renderCard(); }
    else if (a === 'test') runTest();
    else if (a === 'notify') askNotify();
    else if (a === 'guide') { closeCard(); openGuide(); }
  }
  function openGuide() {
    if (window.__cadeLinkSend) { window.__cadeLinkSend.openPanel('setup'); return; }
    Cade.runCommand('Send to device');   // loads the widget (its panel opens), then show its Setup tab
    var n = 0;
    (function wait() { if (window.__cadeLinkSend) window.__cadeLinkSend.openPanel('setup'); else if (n++ < 50) setTimeout(wait, 100); })();
  }
  // The page title carries a mark while links wait here (a background tab shows it).
  function syncTitle() {
    var want = items.some(function (x) { return x.kind === 'waiting'; });
    var has = document.title.indexOf(TITLE_MARK) === 0;
    if (want && !has) document.title = TITLE_MARK + document.title;
    else if (!want && has) document.title = document.title.slice(TITLE_MARK.length);
  }

  // ---- pop-up help (the card's hint and the widget's Setup tab share it) -------------------------
  function hintHtml(intro) {
    var h = C.popupHelp(navigator.userAgent, location.host, navigator.maxTouchPoints);
    var ok = C.popState() === 'ok';
    var steps = function (b) { return '<ol class="ls-steps">' + b.steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>'; };
    var notifyBtn = typeof Notification !== 'undefined' && Notification.permission === 'default'
      ? '<button type="button" class="ls-btn" data-act="notify">Notify me when one waits</button>' : '';
    return (intro ? '<p class="ls-p">Links you send from your other devices open here in a new tab — while txt is open, even in a background tab.</p>' : '') +
      (ok ? '<p class="ls-p ls-ok">✓ Pop-ups are allowed here — links open by themselves.</p>'
        : '<p class="ls-p"><b>Allow pop-ups for ' + esc(location.host) + '</b> so links open by themselves (otherwise each one waits here for a tap). In ' + esc(h.name) + ':</p>' + steps(h)) +
      (h.others.length ? '<details class="ls-more"><summary>Other browsers</summary>' + h.others.map(function (b) { return '<p class="ls-p"><b>' + esc(b.name) + '</b></p>' + steps(b); }).join('') + '</details>' : '') +
      '<div class="ls-row"><button type="button" class="ls-btn ls-primary" data-act="test">Test</button>' + notifyBtn +
      '<button type="button" class="ls-btn" data-act="guide">Setup guide</button>' +
      '<button type="button" class="ls-btn" data-act="gotit">Got it</button></div>' +
      '<div class="ls-test" aria-live="polite"></div>';
  }
  function askNotify() {
    if (typeof Notification === 'undefined') return;
    try {
      Promise.resolve(Notification.requestPermission()).then(function (p) {
        Cade.showToast(p === 'granted' ? 'You’ll get a notification when a link waits here' : 'Notifications stay off', p === 'granted' ? 'success' : 'info', 2500);
        if (card) renderCard();
        if (C) C.changed('recv-status');
      });
    } catch (e) {}
  }

  // ---- Test: a real link through the cloud to this device ---------------------------------------
  // It is sent after a 6 s countdown: a browser lets a page open a tab for a
  // few seconds after a click (a "user activation"), so an immediate test
  // would pass even with pop-ups blocked. The countdown also leaves time to
  // switch tabs and try it in the background.
  var testRun = null;
  function test(report) {
    stopTest();
    var T = { report: report, t: 0, id: '', offAck: null, done: false, timeout: 0 };
    testRun = T;
    function end(state, text) {
      if (T.done) return;
      T.done = true;
      clearInterval(T.t); clearTimeout(T.timeout);
      if (T.offAck) { T.offAck(); T.offAck = null; }
      document.removeEventListener('cade-linksend-handled', onHandled);
      T.report(state, text);
      if (testRun === T) testRun = null;
    }
    function result(st) {
      if (st === 'opened') end('ok', '✓ It opened by itself — pop-ups are allowed. You’re set.');
      else if (st === 'blocked') end('blocked', 'Blocked: the test is waiting on the card. Allow pop-ups (steps above), then Test again.');
      else end('bad', 'The test came back “' + st + '”.');
    }
    function onHandled(e) { if (e.detail && e.detail.id === T.id) result(e.detail.st); }
    T.stop = function () { end('stopped', ''); };
    loadCore().then(function (core) {
      C = core;
      if (T.done) return;
      if (!C.configured()) { end('bad', 'Set up Sync first — links travel through your synced database, end-to-end encrypted.'); return; }
      if (!alive) { end('bad', 'Turn on “Open links sent from my other devices” on this device first.'); return; }
      var n = 6;
      T.report('count', 'Sending a test link in ' + n + ' s — switch to another tab now to try it in the background.');
      T.t = setInterval(function () {
        if (--n > 0) { T.report('count', 'Sending a test link in ' + n + ' s — switch to another tab now to try it in the background.'); return; }
        clearInterval(T.t); T.t = 0;
        T.report('busy', 'Sent — watch for a new tab…');
        document.addEventListener('cade-linksend-handled', onHandled);
        T.offAck = C.acks.on(function (a) { if (a.id === T.id) result(a.st); });
        var d = meDev();
        C.send({ id: d.id, name: d.name, kind: d.kind }, { url: TEST_URL + '?from=' + encodeURIComponent(d.name), title: 'Cade.txt — test link', test: true })
          .then(function (m) { T.id = m.id; }, function (e) { end('bad', 'Couldn’t send: ' + (e && e.message)); });
        T.timeout = setTimeout(function () { end('bad', 'Nothing came back in 20 s — is this tab connected? Try again.'); }, 20000);
      }, 1000);
    }, function (e) { end('bad', e.message); });
    return T;
  }
  function stopTest() { if (testRun) testRun.stop(); testRun = null; }
  var testState = null;
  function runTest() {
    test(function (state, text) {
      testState = state === 'stopped' ? null : { state: state, text: text };
      paintTest();
      if (state === 'ok' && card && !items.length) setTimeout(function () { if (card && !items.length && testState && testState.state === 'ok') closeCard(); }, 4000);
    });
  }
  function paintTest() {
    var el = card && card.querySelector('.ls-test');
    if (!el) return;
    el.textContent = testState ? testState.text : '';
    el.className = 'ls-test' + (testState ? ' ls-t-' + testState.state : '');
    var b = card.querySelector('[data-act="test"]');
    if (b) b.disabled = !!(testState && (testState.state === 'count' || testState.state === 'busy'));
  }

  // For the widget: status, the test, the hint text.
  window.__cadeLinkRecv = {
    status: function () {
      return { enabled: alive, online: listening, configured: !!(C ? C.configured() : (Cade.cloud && Cade.cloud.configured())), pop: C ? C.popState() : '',
        notify: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission, waiting: items.length };
    },
    refresh: function () { if (pres) pres.touch(); else if (alive) goOnline(); },
    test: test,
    hintHtml: function () { return C ? hintHtml(false) : ''; },
    askNotify: askNotify,
    showHint: function () { hintOpen = true; renderCard(); },
    TEST_URL: TEST_URL
  };

  var ext = [];
  if (CM && CM.ViewPlugin) ext = CM.ViewPlugin.define(function () { acquire(); return { destroy: release }; });
  else acquire();
  Cade.registerPlugin({ id: 'linksend-recv', ext: ext });
})();
