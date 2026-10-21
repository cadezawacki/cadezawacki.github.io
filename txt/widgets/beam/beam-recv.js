/* Beam — receiver (plugin "Receive files from my other devices").
 *
 * Keeps this copy of the app findable by Beam on the account's other devices
 * and takes what they send. Same Sync key = same owner, so offers are accepted
 * on their own. Tiny and lazy: nothing happens without Sync; while the page is
 * hidden it goes offline (no presence, no listener — a transfer already under
 * way is allowed to finish); while visible it holds one presence entry
 * (refreshed once a minute) and one listener for offers. beam-core.js and
 * beam-link.js load when the page first goes online; the stylesheet only when
 * something arrives.
 *
 * Incoming files show in a small card (bottom-left, above the footer): who
 * from, progress, speed and path; then a thumbnail for images and Save ·
 * Attach to note · Open · ×. Received files go to the Inbox (IndexedDB, this
 * browser only, 7 days — see beam-link.js); the Beam widget lists them too.
 * The screen stays awake while a transfer runs.
 *
 * Lifetime is tied to the plugin's editor extension (a ViewPlugin): turning
 * the setting off removes the extension, which cancels incoming transfers and
 * takes the receiver offline. A room switch rebuilds the extension, so stopping
 * waits a moment to see whether it comes straight back. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeBeamRecv) return;
  var Cade = window.Cade, CM = Cade.CM;
  // resolve now, while the loader context is ours
  var CORE_URL = Cade.asset('beam-core.js'), LINK_URL = Cade.asset('beam-link.js'), CSS_URL = Cade.asset('beam.css');
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var loads = {};
  function load(url) {
    if (loads[url]) return loads[url];
    return (loads[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loads[url]; rej(new Error('Beam failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }
  function loadLink() {
    if (window.__cadeBeamLink) return Promise.resolve(window.__cadeBeamLink);
    return (window.__cadeBeamCore ? Promise.resolve() : load(CORE_URL)).then(function () { return load(LINK_URL); }).then(function () { return window.__cadeBeamLink; });
  }
  function css() {
    if (document.querySelector('link[rel="stylesheet"][href="' + CSS_URL + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS_URL;
    document.head.appendChild(l);
  }

  // ---- lifecycle ---------------------------------------------------------------------------------
  var refs = 0, alive = false, stopT = 0, bootT = 0, online = false, stopSig = null, touchT = 0, retryT = 0, gen = 0, pruned = false;
  function acquire() {
    refs++;
    clearTimeout(stopT); stopT = 0;
    if (alive) return;
    alive = true;
    document.addEventListener('visibilitychange', onVis);
    bootT = setTimeout(onVis, 1200); // after boot settles
  }
  function release() {
    if (--refs > 0) return;
    refs = 0;
    clearTimeout(stopT);
    stopT = setTimeout(shutdown, 400);
  }
  function shutdown() {
    stopT = 0;
    if (!alive || refs > 0) return;
    alive = false;
    clearTimeout(bootT); bootT = 0;
    document.removeEventListener('visibilitychange', onVis);
    goOffline(false);
    clearTimeout(retryT); retryT = 0;
    var L = window.__cadeBeamLink;
    if (L) L.endAll('in', 'Receiving is turned off on ' + Cade.cloud.device.name);
    closeCard();
    opened.forEach(function (o) { clearTimeout(o.t); try { URL.revokeObjectURL(o.u); } catch (e) {} });
    opened = [];
    if (stopSig) { stopSig(); stopSig = null; }
  }
  function onVis() {
    if (!alive) return;
    if (document.visibilityState === 'visible' && Cade.cloud.configured()) goOnline();
    else goOffline(document.visibilityState !== 'visible');
  }
  function goOnline() {
    clearTimeout(retryT); retryT = 0;
    if (online) return;
    online = true;
    var g = ++gen;
    loadLink().then(function (L) {
      if (!online || g !== gen || !L) return;
      return L.announce().then(function (ok) {
        if (!online || g !== gen) return;
        if (!ok) { online = false; retryT = setTimeout(onVis, 30000); return; } // Firebase not ready yet
        if (!stopSig) stopSig = L.listenSig('r', onSig);
        touchT = setInterval(function () { L.touch(); }, window.__cadeBeamCore.C.TOUCH_EVERY);
        if (!pruned) { pruned = true; L.inbox.list().catch(function () {}); }   // drops week-old files
      });
    }).catch(function () { online = false; });
  }
  function goOffline(hidden) {
    clearTimeout(retryT); retryT = 0;
    if (!online) { if (alive && !hidden && !Cade.cloud.configured()) retryT = setTimeout(onVis, 30000); return; }
    online = false; gen++;
    clearInterval(touchT); touchT = 0;
    var L = window.__cadeBeamLink;
    if (L) L.withdraw();
    // a transfer under way still needs its messages (cancel, switch to relay)
    if (stopSig && !(L && L.active('in').length)) { stopSig(); stopSig = null; }
  }
  function onSig(from, msg) {
    var L = window.__cadeBeamLink;
    if (!L || !msg) return;
    if (msg.t !== 'offer') { L.onSigR(from, msg); return; }
    if (!online) return;                      // hidden: let the sender time out
    css();
    var J = L.receive(from, msg, { onUpdate: paintJob, onFile: onFile, onEnd: onJobEnd });
    if (!J) return;
    if (!sections[J.x]) { addSection(J); try { Cade.haptic(12); } catch (e) {} }
  }
  function onFile(J, i) {
    var F = J.files[i], L = window.__cadeBeamLink;
    if (!L || !F.blob) return;
    L.inbox.add({ name: F.n, mime: F.t, blob: F.blob, from: J.peer, via: J.path }).then(function (id) { F.inboxId = id; paintJob(J); });
  }
  function onJobEnd(J) {
    paintJob(J);
    if (J.state === 'done') { try { Cade.haptic(20); } catch (e) {} }
    // went hidden mid-transfer: now nothing needs the listener
    var L = window.__cadeBeamLink;
    if (!online && stopSig && !(L && L.active('in').length)) { stopSig(); stopSig = null; }
  }

  // ---- the receive card ------------------------------------------------------------------------------
  var card = null, sections = {}, urls = [], opened = [];
  function K() { return window.__cadeBeamCore; }
  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'beam-card';
    card.setAttribute('role', 'region');            // not a live region: progress changes 4× a second
    card.setAttribute('aria-label', 'Beam: incoming files');
    card.innerHTML = '<div class="beam-card-list"></div><div class="beam-card-foot">Kept in 📡 Beam › Inbox for 7 days</div>';
    card.addEventListener('click', onCardClick);
    document.body.appendChild(card);
    return card;
  }
  function closeCard() {
    if (card) { card.remove(); card = null; }
    sections = {};
    urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    urls = [];
  }
  function addSection(J) {
    ensureCard();
    var el = document.createElement('section');
    el.className = 'beam-sec';
    el.setAttribute('data-x', J.x);
    el.innerHTML = '<div class="beam-card-h"><button type="button" class="beam-card-t" data-act="fold"><span></span></button><span class="beam-card-n"></span><button type="button" class="beam-x" data-act="close" aria-label="Cancel">×</button></div>' +
      '<div class="beam-bar"><i></i></div><div class="beam-card-sub"></div><ul class="beam-files"></ul>';
    var list = card.querySelector('.beam-card-list');
    // newest on top; earlier beams fold to their header line (tap it to unfold)
    for (var c = list.firstElementChild; c; c = c.nextElementSibling) c.classList.add('old');
    list.insertBefore(el, list.firstChild);
    // at most five: the oldest finished ones drop off the card (their files stay in the Inbox)
    var all = list.children;
    for (var i = all.length - 1; i >= 5; i--) { var o = sections[all[i].getAttribute('data-x')]; if (o && o.J.over) removeSection(o, true); }
    el.classList.toggle('one', J.files.length === 1);
    sections[J.x] = { J: J, el: el, t: el.querySelector('.beam-card-t span'), n: el.querySelector('.beam-card-n'), bar: el.querySelector('.beam-bar'), fill: el.querySelector('.beam-bar i'), sub: el.querySelector('.beam-card-sub'), list: el.querySelector('.beam-files'), rows: [] };
    paintJob(J);
  }
  function what(J) { return J.files.length === 1 ? J.files[0].n : J.files.length + ' files'; }
  function paintJob(J) {
    var S = sections[J.x], k = K();
    if (!S || !k) return;
    var p = J.prog || { pct: 0, bps: 0, eta: null };
    var live = !J.over;
    // "📡 From <device> · <name> · 45% · 2.1 MB/s" — the numbers in their own span so a long name can't push them out
    S.t.textContent = '📡 From ' + J.peer + ' · ' + what(J);
    S.n.textContent = live ? '· ' + k.fmtPct(p.pct) + (p.bps ? ' · ' + k.fmtRate(p.bps) : '')
      : J.state === 'done' ? '· ✓' : J.state === 'cancelled' ? '· cancelled' : '· failed';
    S.el.classList.toggle('live', live);
    S.el.classList.toggle('bad', J.state === 'error');
    S.fill.style.width = (J.state === 'done' ? 100 : p.pct) + '%';
    S.bar.hidden = !live;
    S.sub.textContent = live ? J.label() + ' · ' + k.fmtBytes(J.done) + ' / ' + k.fmtBytes(J.man.total) + (p.eta != null ? ' · ' + k.fmtEta(p.eta) : '')
      : J.err ? J.err : J.state === 'done' ? J.label() + ' · ' + k.fmtBytes(J.man.total) + ' · checked' : '';
    var x = S.el.querySelector('[data-act="close"]');
    x.setAttribute('aria-label', live ? 'Cancel' : 'Close');
    x.title = live ? 'Cancel' : 'Close';
    J.files.forEach(function (F, i) { paintRow(S, J, F, i); });
  }
  function rowState(J, F) {
    if (F.ok === true) return F.inboxId ? 'kept' : 'done';
    if (F.ok === false) return 'bad';
    if (J.over) return 'gone';
    return F.got > 0 ? 'recv' : 'wait';
  }
  function paintRow(S, J, F, i) {
    var k = K(), st = rowState(J, F), row = S.rows[i];
    if (st === 'gone' && !row) return;
    if (!row) {
      row = S.rows[i] = { el: document.createElement('li'), st: '' };
      row.el.className = 'beam-cf';
      row.el.setAttribute('data-i', i);
      S.list.appendChild(row.el);
    }
    if (row.st === st) {
      if (st === 'recv') { var pc = row.el.querySelector('.beam-cf-s'); if (pc) pc.textContent = k.fmtPct(F.s ? F.got * 100 / F.s : 100) + ' of ' + k.fmtBytes(F.s); }
      return;
    }
    row.st = st;
    var ok = st === 'done' || st === 'kept', ic = '📄', th = '';
    if (ok && k.isImage(F.t, F.n)) {
      var u = URL.createObjectURL(F.blob);
      urls.push(u);
      th = '<img class="beam-th" alt="" src="' + esc(u) + '">';
    }
    var open = ok && k.openKind(F.t, F.n);
    var big = ok && F.blob.size > Cade.files.MAX_BYTES;
    var sub = st === 'wait' ? k.fmtBytes(F.s) + ' · waiting' : st === 'recv' ? k.fmtPct(F.got * 100 / (F.s || 1)) + ' of ' + k.fmtBytes(F.s)
      : st === 'bad' ? (F.err || 'damaged') : st === 'gone' ? 'not received' : k.fmtBytes(F.s);
    row.el.className = 'beam-cf ' + st;
    row.el.innerHTML = (th || '<span class="beam-ic" aria-hidden="true">' + (st === 'bad' ? '⚠' : ic) + '</span>') +
      '<span class="beam-cf-n"><b>' + esc(F.n) + '</b><small class="beam-cf-s">' + esc(sub) + '</small></span>' +
      (ok ? '<span class="beam-acts">' +
        '<button type="button" data-act="save">Save</button>' +
        '<button type="button" data-act="attach"' + (big ? ' class="dim" title="Over 25 MB — too big to attach to a note"' : '') + '>Attach</button>' +
        (open ? '<button type="button" data-act="open">Open</button>' : '') +
        '<button type="button" class="beam-x" data-act="dismiss" title="Remove from Inbox" aria-label="Remove from Inbox">×</button></span>' : '');
    var img = row.el.querySelector('img');
    if (img) img.onerror = function () { img.replaceWith(Object.assign(document.createElement('span'), { className: 'beam-ic', textContent: '🖼' })); };
  }
  function onCardClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var secEl = b.closest('.beam-sec'), S = secEl && sections[secEl.getAttribute('data-x')];
    if (!S) return;
    var a = b.getAttribute('data-act'), J = S.J;
    if (a === 'fold') { if (S.el.classList.contains('old')) S.el.classList.toggle('open'); return; }
    if (a === 'close') {
      if (!J.over) { J.cancel(); return; }
      removeSection(S);
      return;
    }
    var li = b.closest('.beam-cf'), i = li ? +li.getAttribute('data-i') : -1, F = J.files[i];
    if (!F || !F.blob) return;
    if (a === 'save') Cade.files.save(F.blob, F.n);
    else if (a === 'attach') attach(F.blob, F.n, F.t);
    else if (a === 'open') openBlob(F.blob, F.n, F.t);
    else if (a === 'dismiss') {
      var L = window.__cadeBeamLink;
      if (L && F.inboxId) L.inbox.remove(F.inboxId);
      F.blob = null; F.inboxId = null;
      li.remove();
      S.rows[i] = { el: li, st: 'dismissed' };
      if (!S.list.children.length) removeSection(S);
    }
  }
  function removeSection(S, keepCard) {
    S.el.remove();
    delete sections[S.J.x];
    S.el.querySelectorAll('img.beam-th').forEach(function (img) {
      var i = urls.indexOf(img.src);
      if (i >= 0) { try { URL.revokeObjectURL(img.src); } catch (e) {} urls.splice(i, 1); }
    });
    if (!keepCard && !Object.keys(sections).length) closeCard();
  }
  function attach(blob, name, mime) {
    if (blob.size > Cade.files.MAX_BYTES) { Cade.showToast(name + ' is ' + K().fmtBytes(blob.size) + ' — notes take files up to 25 MB. Use Save instead.', 'error', 4000); return; }
    var f;
    try { f = new File([blob], name, { type: mime || blob.type || '' }); } catch (e) { f = blob; f.name = name; }
    Cade.files.attach(f);
  }
  function openBlob(blob, name, mime) {
    var k = K(), kind = k.openKind(mime || blob.type, name);
    if (!kind) { Cade.files.save(blob, name); return; }
    var u = URL.createObjectURL(new Blob([blob], { type: k.openType(kind, mime || blob.type, name) }));
    var w = window.open(u, '_blank');
    if (!w) Cade.showToast('Pop-up blocked — use Save instead', 'error', 2500);
    // the new tab needs the URL for a while; let it go after two minutes
    var o = { u: u, t: 0 };
    o.t = setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) {} opened = opened.filter(function (x) { return x !== o; }); }, 120000);
    opened.push(o);
  }

  window.__cadeBeamRecv = {
    status: function () { return { enabled: alive, online: online, configured: Cade.cloud.configured(), receiving: !!(window.__cadeBeamLink && window.__cadeBeamLink.active('in').length) }; },
    refresh: function () { if (!alive) return; goOffline(false); onVis(); }
  };

  var ext = [];
  if (CM && CM.ViewPlugin) ext = CM.ViewPlugin.define(function () { acquire(); return { destroy: release }; });
  else acquire();
  Cade.registerPlugin({ id: 'beam-recv', ext: ext });
})();
