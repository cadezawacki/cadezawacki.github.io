/* Send to device — the sender (widget "Send to device" + the ?send= sheet).
 *
 * Send a link to another of your devices and it opens there by itself: the
 * device must have txt open (a background tab is fine) with "Open links sent
 * from my other devices" on (linksend-recv.js). Everything travels sealed with
 * the sync key through the account's database (linksend-core.js).
 *
 * Ways in:
 *  - txt.html?send=<url>&title=<title>&to=<device> — what the iOS Shortcut
 *    (share sheet → "Send to computer") and the desktop bookmarklet open. The
 *    core strips the parameters at boot and calls openSender(); the sheet sends
 *    straight away when ?to= names a device or exactly one receiver is online,
 *    else shows the receivers to pick from, then follows the receiver's answer
 *    ("Opened on MacBook ✓", "blocked the pop-up — tap Open there", "offline —
 *    it'll open when txt is next open there", "Saved to Missed links").
 *  - A link's menu in the editor: "Send to device…" (same sheet).
 *  - The widget panel: paste / type a link (prefilled from the selection, the
 *    line, or the clipboard when reading it needs no prompt), pick a device,
 *    "Open this note on…", what was received / sent / missed here, and Setup:
 *    this device's receiving switch, pop-up help + Test, the iOS Shortcut and
 *    the bookmarklet.
 * Nothing runs until one of those opens: listeners and timers live only while
 * the sheet or panel is open. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Cade || window.__cadeLinkSend) return;
  var Cade = window.Cade;
  Cade.loadCSS('linksend.css');
  var CORE_URL = Cade.asset('linksend-core.js');
  var PANEL_ID = 'linksend-panel', SETTING = 'plugins.linksend-recv', REQ_KEY = 'cade-linksend-req';
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  var C = null;

  var coreP = null;
  function loadCore() {
    if (window.__cadeLinkCore) return Promise.resolve(C = window.__cadeLinkCore);
    if (coreP) return coreP;
    return (coreP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CORE_URL; s.async = true;
      s.onload = function () { if (window.__cadeLinkCore) res(C = window.__cadeLinkCore); else rej(new Error('Send to device failed to load')); };
      s.onerror = function () { coreP = null; rej(new Error('Send to device failed to load (offline?)')); };
      document.head.appendChild(s);
    }));
  }
  function appBase() { return location.origin + location.pathname; }
  function configured() { try { return !!Cade.cloud.configured(); } catch (e) { return false; } }
  function recvOn() { try { return Cade.Settings.get(SETTING) === true; } catch (e) { return false; } }
  function recvStatus() { return window.__cadeLinkRecv ? window.__cadeLinkRecv.status() : { enabled: false, online: false }; }

  function copyText(text, what) {
    var ok = function () { Cade.showToast((what || 'Copied') + ' ✓', 'success', 1400); };
    var legacy = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (done) ok(); else Cade.showToast('Couldn’t copy — select the text and copy it', 'error', 2600);
    };
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(ok, legacy); return; } } catch (e) {}
    legacy();
  }

  // ======================================================================================
  // Picker: the receivers, sending to one, and the live status of the last send.
  // host holds .ls-devs, .ls-note and .ls-status; opts: { getReq() → req | null,
  // auto: { to } | null (send without asking when ?to= matches / one is online), onSend(dev) }
  // ======================================================================================
  function Picker(host, opts) {
    var P = this;
    P.host = host; P.opts = opts || {};
    P.devs = null; P.cfg = configured(); P.cur = null; P.sends = {}; P.early = {}; P.autoDone = !P.opts.auto; P.note = '';
    P.offDevs = C.devices.on(function (list) { P.onDevs(list); });
    P.offAcks = C.acks.on(function (a) { P.onAck(a); });
    P.tick = setInterval(function () { if (document.visibilityState === 'visible') P.render(); }, 2000);
    P.render();
  }
  Picker.prototype.destroy = function () {
    clearInterval(this.tick);
    if (this.offDevs) this.offDevs();
    if (this.offAcks) this.offAcks();
    this.offDevs = this.offAcks = null;
  };
  Picker.prototype.list = function () {
    var self = Cade.cloud.device.id;
    return this.devs ? C.sortDevices(this.devs, C.now(), self, false) : null;
  };
  Picker.prototype.onDevs = function (list) {
    this.cfg = configured();
    this.devs = list;
    if (list && !this.autoDone) {
      this.autoDone = true;
      var r = C.pickTarget(this.list(), this.opts.auto.to, Cade.cloud.device.id);
      var to = C.oneLine(this.opts.auto.to, 40);
      if (r.target) { this.send(r.target); return; }
      if (to && r.missing) this.note = 'No device called “' + to + '” receives links — pick one:';
      else if (to && r.matches.length > 1) this.note = 'More than one device matches “' + to + '” — pick one:';
    }
    this.render();
  };
  Picker.prototype.onAck = function (a) {
    var hit = false;
    for (var k in this.sends) {
      var e = this.sends[k];
      if (e.id === a.id) { e.st = a.st; e.how = a.how; hit = true; }
    }
    if (!hit) this.early[a.id] = a;
    this.render();
  };
  Picker.prototype.dev = function (id) {
    var d = (this.devs || []).filter(function (x) { return x.id === id; })[0];
    return d || null;
  };
  Picker.prototype.send = function (dev) {
    var P = this, prev = dev && P.sends[dev.id];
    if (prev && (prev.st === 'sending' || Date.now() - prev.t0 < 1500)) return;   // a double tap sends once
    var req = P.opts.getReq ? P.opts.getReq() : null;
    if (!req || !dev) return;
    var e = { id: '', devId: dev.id, name: dev.name, t0: Date.now(), st: 'sending' };
    P.sends[dev.id] = e; P.cur = e; P.note = '';
    if (P.opts.onSend) P.opts.onSend(dev);
    P.render();
    C.send(dev, req).then(function (m) {
      e.id = m.id;
      var a = P.early[m.id];
      if (a) { e.st = a.st; e.how = a.how; delete P.early[m.id]; }
      else if (e.st === 'sending') e.st = 'sent';
      e.t0 = Date.now();
      P.render();
    }, function (err) {
      e.st = 'failed'; e.err = err && err.message;
      P.render();
    });
    try { Cade.haptic(10); } catch (x) {}
  };
  Picker.prototype.again = function () { this.cur = null; this.note = ''; this.render(); };
  Picker.prototype.statusOf = function (e) {
    var d = this.dev(e.devId) || { name: e.name, live: false, ttl: C.TTL_DEFAULT };
    var s = C.statusFor(e, d, Date.now());
    if (e.st === 'failed' && e.err) s.sub = e.err;
    return s;
  };
  Picker.prototype.render = function () {
    var P = this, h = P.host;
    if (!h || !h.isConnected) return;
    var devsEl = h.querySelector('.ls-devs'), noteEl = h.querySelector('.ls-note'), stEl = h.querySelector('.ls-status');
    var html, list = P.list();
    if (!P.cfg) html = syncHtml();
    else if (!list) html = '<div class="ls-wait"><span class="ls-spin" aria-hidden="true"></span>Looking for your devices…</div>';
    else if (!list.length) html = noReceiversHtml();
    else html = list.map(function (d) {
      var e = P.sends[d.id], st = e ? P.statusOf(e) : null;
      var sub = d.live ? 'online' + (d.pop === 'blocked' ? ' · pop-ups blocked there' : '') : 'offline · last seen ' + (d.at ? C.fmtAgo(Math.max(0, C.now() - d.at)) : 'a while ago');
      return '<button type="button" class="ls-dev' + (d.live ? ' on' : '') + (P.cur && P.cur.devId === d.id ? ' sel' : '') + '" data-dev="' + esc(d.id) + '">' +
        '<span class="ls-dev-ic" aria-hidden="true">' + C.kindIcon(d.kind) + '</span>' +
        '<span class="ls-dev-txt"><b>' + esc(d.name) + '</b><small><i class="ls-dot' + (d.live ? ' on' : '') + '"></i>' + esc(sub) + '</small></span>' +
        '<span class="ls-dev-st ls-t-' + (st ? st.tone : '') + '" aria-hidden="true">' + (st ? esc(st.tone === 'ok' ? '✓' : st.icon) : '›') + '</span></button>';
    }).join('');
    if (devsEl && devsEl.__html !== html) { devsEl.innerHTML = html; devsEl.__html = html; }
    if (noteEl) { noteEl.textContent = P.note; noteEl.hidden = !P.note; }
    if (stEl) {
      var s = P.cur ? P.statusOf(P.cur) : null;
      var sh = s ? '<div class="ls-st-ic" aria-hidden="true">' + (s.tone === 'busy' ? '<span class="ls-spin"></span>' : esc(s.icon)) + '</div><div class="ls-st-txt"><b>' + esc(s.text) + '</b>' + (s.sub ? '<span>' + esc(s.sub) + '</span>' : '') + '</div>' : '';
      if (stEl.__html !== sh) { stEl.innerHTML = sh; stEl.__html = sh; stEl.className = 'ls-status' + (s ? ' ls-t-' + s.tone : ''); stEl.hidden = !s; }
    }
    if (P.opts.onRender) P.opts.onRender(P);
  };
  Picker.prototype.restart = function () {
    if (this.offDevs) this.offDevs();
    this.cfg = configured(); this.devs = null;
    var P = this;
    this.offDevs = C.devices.on(function (list) { P.onDevs(list); });
    this.render();
  };
  function syncHtml() {
    return '<div class="ls-empty"><b>Sync isn’t set up on this device.</b>' +
      '<p>Links travel through your own synced database, end-to-end encrypted with your sync key. Set up Sync here and on the device that should open them.</p>' +
      '<button type="button" class="ls-btn ls-primary" data-act="sync">Set up Sync</button></div>';
  }
  function noReceiversHtml() {
    return '<div class="ls-empty"><b>No device is ready to receive links yet.</b>' +
      '<p>On your computer: open txt → Preferences → <b>Devices</b> → turn on <b>Open links sent from my other devices</b>, and keep a txt tab open there (a background tab is fine).</p>' +
      '<button type="button" class="ls-btn" data-act="guide">Setup guide</button></div>';
  }
  // Shared clicks inside a picker host.
  function pickerClick(P, e) {
    var t = e.target.closest ? e.target.closest('[data-dev]') : null;
    if (t) { var d = P.dev(t.getAttribute('data-dev')); if (d) P.send(d); return true; }
    return false;
  }

  // The sync modal is a core dialog: step aside while it is open, then pick up again.
  function viaSync(hideEl, after) {
    if (typeof window.openSyncModal !== 'function') { Cade.showToast('Sync setup isn’t available here', 'error', 2500); return; }
    if (hideEl) hideEl.style.display = 'none';
    window.openSyncModal();
    var t = setInterval(function () {
      var ov = document.getElementById('sync-overlay');
      if (ov && ov.classList.contains('open')) return;
      clearInterval(t);
      if (hideEl) hideEl.style.display = '';
      if (after) after();
    }, 500);
  }

  // ======================================================================================
  // The ?send= sheet
  // ======================================================================================
  var sheet = null;
  function openSender(req) {
    req = req || {};
    return loadCore().then(function () {
      closeSheet(true);
      var url = C.cleanUrl(req.url || ''), title = C.oneLine(req.title, 200), to = C.oneLine(req.to, 60);
      var wrap = document.createElement('div');
      wrap.className = 'ls-sheet-wrap';
      wrap.innerHTML = '<div class="ls-sheet" role="dialog" aria-modal="true" aria-label="Send link" tabindex="-1">' +
        '<div class="ls-sheet-h"><b>📲 Send link</b><button type="button" class="ls-x" data-act="done" aria-label="Close">×</button></div>' +
        (url
          ? '<div class="ls-link"><span class="ls-link-ic" aria-hidden="true">🔗</span><div class="ls-link-txt"><b>' + esc(title || C.hostOf(url)) + '</b><span>' + esc(C.shortUrl(url, 90)) + '</span></div></div>' +
            '<div class="ls-pick"><div class="ls-label">Send to</div><div class="ls-note" hidden></div><div class="ls-devs"></div><div class="ls-status" hidden></div></div>'
          : '<div class="ls-empty ls-bad"><b>That isn’t a web link, so it can’t be sent.</b><p>Only http:// and https:// links travel between devices.</p>' +
            (req.url ? '<code>' + esc(C.oneLine(req.url, 120)) + '</code>' : '') + '</div>') +
        '<div class="ls-sheet-f">' + (url ? '<button type="button" class="ls-btn" data-act="another" hidden>Send to another device</button>' : '') +
        '<button type="button" class="ls-btn ls-primary" data-act="done">Done</button></div></div>';
      document.body.appendChild(wrap);
      var S = sheet = { el: wrap, picker: null, req: req };
      if (url) {
        S.picker = new Picker(wrap.querySelector('.ls-pick'), {
          getReq: function () { return { url: url, title: title }; },
          auto: { to: to },
          onSend: function () { forgetReq(); },
          onRender: function (P) { var b = wrap.querySelector('[data-act="another"]'); if (b) b.hidden = !P.cur; }
        });
      } else forgetReq();
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) { closeSheet(); return; }
        if (S.picker && pickerClick(S.picker, e)) return;
        var a = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!a) return;
        var act = a.getAttribute('data-act');
        if (act === 'done') closeSheet();
        else if (act === 'another') S.picker.again();
        else if (act === 'sync') viaSync(wrap, function () { if (sheet === S && S.picker) S.picker.restart(); });
        else if (act === 'guide') { closeSheet(); openPanel('setup'); }
      });
      S.onKey = function (e) { if (e.key === 'Escape' && sheet === S) { e.preventDefault(); closeSheet(); } };
      document.addEventListener('keydown', S.onKey, true);
      try { wrap.querySelector('.ls-sheet').focus({ preventScroll: true }); } catch (e) {}
      return S;
    });
  }
  function forgetReq() { try { sessionStorage.removeItem(REQ_KEY); } catch (e) {} }
  function closeSheet(quiet) {
    var S = sheet;
    if (!S) return;
    sheet = null;
    if (S.picker) S.picker.destroy();
    document.removeEventListener('keydown', S.onKey, true);
    S.el.remove();
    if (!quiet) forgetReq();
  }

  // ======================================================================================
  // The panel
  // ======================================================================================
  var Pn = null;   // { el, tab, picker, noteMode, offChange, … }
  function prefillUrl() {
    var ed = Cade.editor;
    try {
      var sel = ed.state.selection.main, doc = ed.state.doc;
      if (!sel.empty) { var u = C.findUrl(doc.sliceString(sel.from, sel.to)); if (u) return Promise.resolve(u); }
      var line = doc.lineAt(sel.head), text = line.text, at = sel.head - line.from;
      var re = /https?:\/\/[^\s<>"'`)\]]+/gi, m, best = null;
      while ((m = re.exec(text))) { if (at >= m.index && at <= m.index + m[0].length) best = m[0]; }
      if (best) { var b = C.cleanUrl(best.replace(/[.,;:!?]+$/, '')); if (b) return Promise.resolve(b); }
    } catch (e) {}
    // the clipboard only where reading it needs no prompt (Chrome / Edge once allowed)
    try {
      if (navigator.permissions && navigator.clipboard && navigator.clipboard.readText) {
        return navigator.permissions.query({ name: 'clipboard-read' }).then(function (p) {
          return p.state === 'granted' ? navigator.clipboard.readText().then(C.findUrl, function () { return null; }) : null;
        }, function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }
  function panelHtml() {
    return '<div class="ls-panel">' +
      '<div class="ls-tabs" role="tablist">' +
        '<button type="button" role="tab" data-tab="send">Send</button>' +
        '<button type="button" role="tab" data-tab="inbox">History<span class="ls-badge" hidden></span></button>' +
        '<button type="button" role="tab" data-tab="setup">Setup</button>' +
      '</div>' +
      '<section class="ls-pane" data-pane="send">' +
        '<div class="ls-what">' +
          '<label class="ls-label" for="ls-url">Link</label>' +
          '<div class="ls-urlrow"><input id="ls-url" class="ls-input" type="url" inputmode="url" placeholder="https://…" autocomplete="off" autocapitalize="off" spellcheck="false">' +
          '<button type="button" class="ls-btn" data-act="paste">Paste</button></div>' +
          '<div class="ls-urlerr" hidden></div>' +
        '</div>' +
        '<div class="ls-notebox" hidden><span class="ls-label">Note</span><div class="ls-link"><span class="ls-link-ic" aria-hidden="true">📝</span><div class="ls-link-txt"><b class="ls-notename"></b><span>the other device switches to this note</span></div></div></div>' +
        '<div class="ls-pick"><div class="ls-label">Send to</div><div class="ls-note" hidden></div><div class="ls-devs"></div><div class="ls-status" hidden></div></div>' +
        '<div class="ls-row"><button type="button" class="ls-btn" data-act="notemode">📝 Open this note on…</button></div>' +
      '</section>' +
      '<section class="ls-pane" data-pane="inbox"></section>' +
      '<section class="ls-pane" data-pane="setup"></section>' +
    '</div>';
  }
  function q(s) { return Pn && Pn.el.querySelector(s); }
  function openPanel(tab) {
    return loadCore().then(function () {
      if (Pn && document.getElementById(PANEL_ID)) {
        if (Cade.isMinimized && Cade.isMinimized(Pn.el)) Cade.restorePanel(Pn.el);
        setTab(tab || Pn.tab);
        return Pn;
      }
      var el = Cade.mkPanel(PANEL_ID, '📲 Send to device', panelHtml());
      Pn = { el: el, tab: 'send', picker: null, noteMode: false };
      el._onClose = cleanupPanel;
      el.dataset.prefs = 'linksend-recv';   // Widget preferences opens on the receiver's page (TTL, notifications)
      var input = q('#ls-url');
      Pn.picker = new Picker(q('.ls-pick'), {
        getReq: function () {
          if (Pn.noteMode) {
            var room = Cade.roomsApi.activeRoom();
            if (!room) { Cade.showToast('Open a note first', 'error', 2000); return null; }
            return { url: appBase() + '?room=' + encodeURIComponent(room), title: room, room: room };
          }
          var u = C.cleanUrl(input.value, true);
          showUrlErr(u ? '' : (input.value.trim() ? 'That isn’t a web link — only http:// and https:// links can be sent.' : 'Paste or type a link first.'));
          if (u) input.value = u;
          return u ? { url: u, title: '' } : null;
        },
        // nothing to type or switch to until Sync is set up
        onRender: function (P) {
          if (!Pn) return;
          q('.ls-what').hidden = !P.cfg || Pn.noteMode;
          q('[data-act="notemode"]').hidden = !P.cfg;
        }
      });
      el.addEventListener('click', onPanelClick);
      el.addEventListener('change', onPanelChange);
      input.addEventListener('input', function () { showUrlErr(''); });
      Pn.offChange = function () { document.removeEventListener('cade-linksend-change', onDataChange); };
      document.addEventListener('cade-linksend-change', onDataChange);
      prefillUrl().then(function (u) { if (u && Pn && !input.value) input.value = u; });
      setTab(tab || 'send');
      return Pn;
    });
  }
  function cleanupPanel() {
    if (!Pn) return;
    if (Pn.picker) Pn.picker.destroy();
    if (Pn.offChange) Pn.offChange();
    stopPanelTest();
    Pn = null;
  }
  function closePanel() { var el = Pn && Pn.el; cleanupPanel(); if (el) el.remove(); }
  function showUrlErr(t) { var e = q('.ls-urlerr'); if (e) { e.textContent = t; e.hidden = !t; } }
  function setTab(tab) {
    if (!Pn) return;
    Pn.tab = tab;
    Pn.el.querySelectorAll('[data-tab]').forEach(function (b) { var on = b.getAttribute('data-tab') === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    Pn.el.querySelectorAll('[data-pane]').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== tab; });
    if (tab === 'inbox') renderInbox();
    if (tab === 'setup') renderSetup();
    paintBadge();
  }
  function setNoteMode(on) {
    Pn.noteMode = on;
    q('.ls-what').hidden = on || !configured();
    q('.ls-notebox').hidden = !on;
    var room = Cade.roomsApi.activeRoom() || '';
    q('.ls-notename').textContent = room || 'No note open';
    q('[data-act="notemode"]').textContent = on ? '🔗 Send a link instead' : '📝 Open this note on…';
    Pn.picker.again();
  }
  function onDataChange(e) {
    if (!Pn) return;
    var w = e.detail && e.detail.what;
    if (Pn.tab === 'inbox' && (w === 'recv' || w === 'sent')) renderInbox();
    if (Pn.tab === 'setup' && (w === 'pop' || w === 'recv-status')) renderSetup();
    paintBadge();
  }
  function paintBadge() {
    var b = q('.ls-badge');
    if (!b) return;
    var n = C.missedOf(C.hist.recv()).length;
    b.textContent = n ? String(n) : '';
    b.hidden = !n;
  }
  function onPanelChange(e) {
    var t = e.target;
    if (t.matches('[data-recv]')) {
      try { Cade.Settings.set(SETTING, !!t.checked); } catch (x) {}
      setTimeout(renderSetup, 300); setTimeout(renderSetup, 2500);
    } else if (t.matches('.ls-name')) {
      t.value = Cade.cloud.setDeviceName(t.value);
      if (window.__cadeLinkRecv) window.__cadeLinkRecv.refresh();
    } else if (t.matches('.ls-target')) {
      Pn.target = t.value;
      renderSetup();
    }
  }
  function onPanelClick(e) {
    if (!Pn) return;
    var tb = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (tb) { setTab(tb.getAttribute('data-tab')); return; }
    if (Pn.tab === 'send' && pickerClick(Pn.picker, e)) return;
    var a = e.target.closest ? e.target.closest('[data-act],[data-ropen],[data-rdrop]') : null;
    if (!a) return;
    if (a.hasAttribute('data-ropen')) { var id = a.getAttribute('data-ropen'); setTimeout(function () { openedFromList(id); }, 0); return; }
    if (a.hasAttribute('data-rdrop')) { dropFromList(a.getAttribute('data-rdrop')); return; }
    var act = a.getAttribute('data-act');
    if (act === 'paste') pasteUrl();
    else if (act === 'notemode') setNoteMode(!Pn.noteMode);
    else if (act === 'sync') viaSync(null, function () { if (Pn) { Pn.picker.restart(); renderSetup(); } });
    else if (act === 'guide') setTab('setup');
    else if (act === 'copy') copyText(q('#' + a.getAttribute('data-src')).value, a.getAttribute('data-what'));
    else if (act === 'test') runPanelTest();
    else if (act === 'notify') { if (window.__cadeLinkRecv) window.__cadeLinkRecv.askNotify(); else if (typeof Notification !== 'undefined') Notification.requestPermission().then(renderSetup); }
    else if (act === 'prefs') { try { Cade.prefs.open('linksend-recv'); } catch (x) {} }
    else if (act === 'clear') { C.hist.clear(a.getAttribute('data-which')); renderInbox(); }
  }
  function pasteUrl() {
    var input = q('#ls-url');
    try {
      navigator.clipboard.readText().then(function (t) {
        var u = C.findUrl(t);
        if (u) { input.value = u; showUrlErr(''); }
        else showUrlErr('The clipboard has no web link.');
      }, function () { showUrlErr('Couldn’t read the clipboard — paste into the box instead.'); input.focus(); });
    } catch (x) { input.focus(); }
  }

  // ---- Received / Sent / Missed ------------------------------------------------------------------
  var ST_LABEL = { opened: 'opened', blocked: 'pop-up blocked — not opened', limited: 'not opened (many at once)', expired: 'missed — arrived late', refused: 'refused (not a web link)',
    sending: 'sending…', sent: 'sent — no answer yet', failed: 'couldn’t send', dismissed: 'not opened' };
  function rowHtml(r, kind) {
    var label = r.room ? '📝 ' + r.room : (r.title || C.hostOf(r.url) || C.shortUrl(r.url, 60));
    var who = kind === 'sent' ? '→ ' + (r.toName || 'device') : C.kindIcon(r.fromKind) + ' ' + (r.from || 'device');
    var st = ST_LABEL[r.st] || r.st || '';
    if (r.st === 'opened' && r.how === 'tap') st = 'opened (tapped)';
    if (r.st === 'opened' && kind === 'sent' && r.by) st = 'opened on ' + r.by;
    var when = C.fmtAgo(Math.max(0, Date.now() - (kind === 'sent' ? r.at : (r.rt || Date.now()))));
    var open = r.url && !r.room ? '<a class="ls-mini" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer"' + (kind === 'missed' ? ' data-ropen="' + esc(r.id) + '"' : '') + '>Open</a>' : '';
    return '<div class="ls-hrow ls-st-' + esc(r.st) + '"><div class="ls-hrow-txt"><b>' + esc(label) + '</b>' +
      (r.room ? '' : '<span class="ls-it-url">' + esc(C.shortUrl(r.url, 70)) + '</span>') +
      '<small>' + esc(who + ' · ' + when + ' · ' + st) + '</small></div>' + open +
      (kind === 'missed' ? '<button type="button" class="ls-mini ls-mini-x" data-rdrop="' + esc(r.id) + '" aria-label="Remove">×</button>' : '') + '</div>';
  }
  function renderInbox() {
    var pane = q('[data-pane="inbox"]');
    if (!pane) return;
    var recv = C.hist.recv(), sent = C.hist.sent().filter(function (x) { return !x.test; }), missed = C.missedOf(recv);
    var sec = function (title, rows, kind, which, hint) {
      return '<div class="ls-sec"><div class="ls-sec-h"><span class="ls-label">' + esc(title) + (rows.length ? ' (' + rows.length + ')' : '') + '</span>' +
        (rows.length && which ? '<button type="button" class="ls-mini" data-act="clear" data-which="' + which + '">Clear</button>' : '') + '</div>' +
        (rows.length ? rows.map(function (r) { return rowHtml(r, kind); }).join('') : '<div class="ls-none">' + esc(hint) + '</div>') + '</div>';
    };
    var html = (missed.length ? sec('Missed links', missed, 'missed', '', '') : '') +
      sec('Received here', recv, 'recv', 'recv', recvOn() ? 'Nothing yet. Links sent to this device show up here.' : 'This device doesn’t receive links (Setup tab).') +
      sec('Sent from here', sent, 'sent', 'sent', 'Nothing sent yet.');
    if (pane.__html !== html) { pane.innerHTML = html; pane.__html = html; }
  }
  function openedFromList(id) {
    var r = C.hist.recv().filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    C.hist.updRecv(id, { st: 'opened', how: 'tap' });
    var by = Cade.cloud.device;
    if (r.fromId) C.sendAck(r.fromId, C.makeAck(r.id, 'opened', { id: by.id, name: by.name, kind: by.kind }, C.now(), 'tap'));
  }
  function dropFromList(id) {
    C.hist.updRecv(id, { st: 'dismissed' });
    renderInbox(); paintBadge();
  }

  // ---- Setup --------------------------------------------------------------------------------------
  function renderSetup() {
    var pane = q('[data-pane="setup"]');
    if (!pane) return;
    var on = recvOn(), st = recvStatus(), cfg = configured(), d = Cade.cloud.device;
    var help = C.popupHelp(navigator.userAgent, location.host, navigator.maxTouchPoints);
    var pop = C.popState();
    var steps = function (b) { return '<ol class="ls-steps">' + b.steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>'; };
    var line = !cfg ? esc('Needs Sync — set it up first.') : !on ? esc('Off — this device isn’t offered as a target.')
      : st.online ? '<i class="ls-dot on"></i>' + esc('Listening — links open here in a new tab (txt must stay open; a background tab is fine).') : esc('Starting…');
    var notif = typeof Notification === 'undefined' ? '' : Notification.permission === 'granted' ? '<span class="ls-okline">✓ Notifications on — a blocked link also shows one.</span>'
      : Notification.permission === 'default' ? '<button type="button" class="ls-btn" data-act="notify">Notify me when a link waits</button>' : '';
    var devs = Pn.picker && Pn.picker.list() || [];
    var tgt = Pn.target != null ? Pn.target : '';
    var opts = '<option value="">ask each time</option>' + devs.map(function (x) { return '<option value="' + esc(x.name) + '"' + (x.name === tgt ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('');
    var tmpl = C.shortcutTemplate(appBase(), tgt), bm = C.bookmarklet(appBase(), tgt);
    var ttl = C.ttlPref();
    var html =
      '<div class="ls-sec ls-box"><div class="ls-sec-h"><span class="ls-label">This device</span></div>' +
        '<label class="ls-field"><span>Name</span><input class="ls-input ls-name" value="' + esc(d.name) + '" maxlength="40" autocomplete="off" spellcheck="false"></label>' +
        '<label class="ls-switch"><input type="checkbox" data-recv' + (on ? ' checked' : '') + (cfg ? '' : ' disabled') + '><span><b>Open links sent from my other devices</b><small>' + line + '</small></span></label>' +
        (cfg ? '' : '<button type="button" class="ls-btn ls-primary" data-act="sync">Set up Sync</button>') +
        (on ? '<div class="ls-pop">' +
          (pop === 'ok' ? '<p class="ls-okline">✓ Pop-ups are allowed — links open by themselves.</p>'
            : '<p class="ls-p"><b>Allow pop-ups for ' + esc(location.host) + '</b> so links open by themselves' + (pop === 'blocked' ? ' — the last one was blocked and waited for a tap' : '') + '. In ' + esc(help.name) + ':</p>' + steps(help)) +
          '<details class="ls-more"><summary>Other browsers</summary>' + help.others.map(function (b) { return '<p class="ls-p"><b>' + esc(b.name) + '</b></p>' + steps(b); }).join('') + '</details>' +
          '<div class="ls-row"><button type="button" class="ls-btn ls-primary" data-act="test">Test</button>' + notif + '</div>' +
          '<div class="ls-test" aria-live="polite"></div>' +
          '<p class="ls-hint">Links older than ' + ttl + ' min when they arrive aren’t opened — they wait under Missed links. <button type="button" class="ls-link-btn" data-act="prefs">Change</button></p>' +
        '</div>' : '') +
      '</div>' +
      '<div class="ls-sec ls-box"><div class="ls-sec-h"><span class="ls-label">Send to</span></div>' +
        '<label class="ls-field"><span>Shortcut & bookmarklet send to</span><select class="ls-input ls-target">' + opts + '</select></label>' +
        '<p class="ls-hint">“ask each time” sends to the only device online, else lets you pick.</p>' +
      '</div>' +
      '<div class="ls-sec ls-box"><div class="ls-sec-h"><span class="ls-label">iPhone / iPad — share sheet</span></div>' +
        '<ol class="ls-steps">' +
          '<li>Shortcuts → <b>+</b> → name it <b>Send to computer</b>. In its details turn on <b>Show in Share Sheet</b>; it receives <i>URLs</i> and <i>Safari web pages</i>.</li>' +
          '<li>Add <b>Get Details of Safari Web Page</b> → <i>Name</i> of <i>Shortcut Input</i> (the page title).</li>' +
          '<li>Add <b>URL Encode</b> → <i>Shortcut Input</i>, and another <b>URL Encode</b> → that <i>Name</i>.</li>' +
          '<li>Add <b>Text</b> with the line below, replacing <code>URL</code> with the first <i>URL Encoded Text</i> and <code>TITLE</code> with the second.</li>' +
          '<li>Add <b>Open URLs</b> (input: that Text). Done.</li>' +
        '</ol>' +
        '<div class="ls-copyrow"><input class="ls-input" id="ls-tmpl" readonly value="' + esc(tmpl) + '"><button type="button" class="ls-btn" data-act="copy" data-src="ls-tmpl" data-what="Shortcut text copied">Copy</button></div>' +
        '<p class="ls-hint">Share → <b>Send to computer</b> opens txt in Safari, which sends the link and shows where it opened. The computer needs txt open in a tab with receiving on.</p>' +
      '</div>' +
      '<div class="ls-sec ls-box"><div class="ls-sec-h"><span class="ls-label">Desktop — “Send to phone” bookmarklet</span></div>' +
        '<div class="ls-copyrow"><input class="ls-input" id="ls-bm" readonly value="' + esc(bm) + '"><button type="button" class="ls-btn" data-act="copy" data-src="ls-bm" data-what="Bookmarklet copied">Copy</button></div>' +
        '<p class="ls-hint">New bookmark → paste this as its address, name it “Send to phone”. Clicking it opens txt in a new tab with this page ready to send. On an iPhone, links open while txt is on screen (iOS pauses background tabs) — and Safari blocks pop-ups unless you turn that off, so expect one tap on Open.</p>' +
      '</div>' +
      '<p class="ls-hint ls-sec">Private: only devices that hold your sync key can send or read links; the database sees device ids and times only. Messages are deleted once handled.</p>';
    if (pane.__html !== html) {
      var keep = document.activeElement && pane.contains(document.activeElement) && document.activeElement.matches('.ls-name');
      if (keep) return;   // don't rebuild under the typist
      pane.innerHTML = html; pane.__html = html;
      paintPanelTest();
    }
  }
  var panelTest = null, panelTestState = null;
  function runPanelTest() {
    if (!window.__cadeLinkRecv) { Cade.showToast('Turn on receiving first', 'info', 2000); return; }
    stopPanelTest();
    panelTest = window.__cadeLinkRecv.test(function (state, text) {
      panelTestState = state === 'stopped' ? null : { state: state, text: text };
      paintPanelTest();
      if (state !== 'count' && state !== 'busy') { panelTest = null; renderSetup(); }
    });
  }
  function stopPanelTest() { if (panelTest) { var t = panelTest; panelTest = null; t.stop(); } panelTestState = null; }
  function paintPanelTest() {
    var el = q('[data-pane="setup"] .ls-test');
    if (!el) return;
    el.textContent = panelTestState ? panelTestState.text : '';
    el.className = 'ls-test' + (panelTestState ? ' ls-t-' + panelTestState.state : '');
    var b = q('[data-pane="setup"] [data-act="test"]');
    if (b) b.disabled = !!panelTest;
  }

  // ---- widget ---------------------------------------------------------------------------------
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID) && Pn) { closePanel(); return; }
    openPanel('send').catch(function (e) { Cade.showToast(e.message, 'error', 3000); });
  }

  window.__cadeLinkSend = {
    openSender: openSender,
    openPanel: openPanel,
    closeSheet: closeSheet,
    closePanel: closePanel,
    _sheet: function () { return sheet; },
    _panel: function () { return Pn; }
  };

  Cade.registerWidget({
    name: 'Send to device',
    description: 'Send a link to your computer or phone and it opens there by itself — from the share sheet (iOS Shortcut), a bookmarklet, a link’s menu or here. End-to-end encrypted through Sync',
    icon: '📲',
    tags: 'send,link,url,tab,open,devices,phone,computer,desktop,laptop,handoff,continuity,share,push,browser,shortcut,bookmarklet,send to computer,send to phone,send tab,multi-device',
    open: open,
    close: closePanel
  });
})();
