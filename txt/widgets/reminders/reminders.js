/* Reminders — write `@remind!<datetime>!<message>` anywhere in a document and
   get a notification (system notification where permitted, plus an in-app
   popup/toast) when the time arrives.

   Accepted datetime forms (local time):
     @remind!2026-07-11 18:30! water the plants
     @remind!2026-07-11T18:30!  (T works too)
     @remind!2026-07-11!        (whole-day → fires at 09:00)
     @remind!07-11 18:30!       (this year; rolls to next year if past)
     @remind!18:30!             (today; rolls to tomorrow if already past)
   The second `!` ends the datetime; the message runs to the end of the line.
   With no message part, the rest of the line (minus the token) is used.

   HONEST LIMITATION: a static web app cannot wake your device on its own —
   reminders fire while the app (or its PWA window) is open. The widget loads
   eagerly at boot (manifest `eager: true`), so having the app open anywhere
   is enough; you do NOT need the panel open. Reminders missed while the app
   was closed fire on next launch (up to 12 hours late), marked "missed".

   Fired reminders are remembered in `cade-reminders-fired` (deduped by
   room+time+message, pruned after 30 days / 500 entries — memory care). */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('reminders.css');
  var store = Cade.store;
  var RA = Cade.roomsApi;
  var esc = Cade.escapeHtml;

  var TOKEN_RE = /@remind!([^!\n]{3,40})(?:!([^\n]*))?/g;
  var FIRED_KEY = 'cade-reminders-fired';
  var GRACE_MS = 12 * 3600 * 1000;  // fire missed reminders up to 12h late
  var CHECK_MS = 20 * 1000;

  // ---- datetime spec parsing (local time; null = not a reminder) ----
  function parseSpec(spec, nowDate) {
    spec = String(spec || '').trim();
    var now = nowDate || new Date();
    var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(spec))) {
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(spec))) {
      return new Date(+m[1], +m[2] - 1, +m[3], 9, 0).getTime();
    }
    if ((m = /^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(spec))) {
      var d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
      if (d.getTime() < now.getTime() - 60000) d = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4]);
      return d.getTime();
    }
    if ((m = /^(\d{1,2}):(\d{2})$/.exec(spec))) {
      var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
      if (t.getTime() < now.getTime() - 60000) t = new Date(t.getTime() + 24 * 3600 * 1000);
      return t.getTime();
    }
    return null;
  }

  function scanText(room, text, list) {
    if (!text || text.indexOf('@remind!') === -1) return;
    TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      var at = parseSpec(m[1]);
      if (at == null) continue;
      var msg = (m[2] || '').trim();
      if (!msg) {
        var ls = text.lastIndexOf('\n', m.index) + 1;
        var le = text.indexOf('\n', m.index);
        if (le === -1) le = text.length;
        msg = (text.slice(ls, m.index) + ' ' + text.slice(m.index + m[0].length, le)).trim() || 'Reminder';
      }
      list.push({ room: room, at: at, msg: msg, key: room + '|' + m[1].trim() + '|' + msg });
    }
  }

  // Scan the live doc plus every room's local cache (cheap indexOf pre-check).
  function collect() {
    var list = [];
    var act = null;
    try { act = RA.activeRoom(); } catch (e) {}
    try { scanText(act || '(local)', window.editor.state.doc.toString(), list); } catch (e) {}
    try {
      RA.list().forEach(function (r) {
        if (r === act) return;
        scanText(r, store.get('cade-room-cache:' + r), list);
      });
    } catch (e) {}
    var seen = {}, out = [];
    list.forEach(function (r) { if (!seen[r.key]) { seen[r.key] = 1; out.push(r); } });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  function loadFired() { try { return JSON.parse(store.get(FIRED_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveFired(f) {
    var cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    var entries = Object.keys(f)
      .filter(function (k) { return f[k] >= cutoff; })
      .sort(function (a, b) { return f[b] - f[a]; })
      .slice(0, 500);
    var out = {};
    entries.forEach(function (k) { out[k] = f[k]; });
    store.set(FIRED_KEY, JSON.stringify(out));
  }

  // ---- firing ----
  function notify(due) {
    try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch (e) {}
    var missed = due.some(function (r) { return Date.now() - r.at > 2 * 60 * 1000; });
    var title = (missed ? '⏰ Missed reminder' : '⏰ Reminder') + (due.length > 1 ? 's (' + due.length + ')' : '');
    var body = due.map(function (r) { return r.msg + (r.room && r.room !== '(local)' ? ' — ' + r.room : ''); }).join('\n');
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body: body, tag: 'cade-reminders' });
      }
    } catch (e) {}
    Cade.showToast(title + ': ' + body.split('\n')[0] + (due.length > 1 ? ' …' : ''), 'success', 8000);
    openPanel(true); // the in-app popup
  }

  function checkDue() {
    var now = Date.now();
    var fired = loadFired();
    var due = collect().filter(function (r) {
      return r.at <= now && r.at > now - GRACE_MS && !fired[r.key];
    });
    if (!due.length) return;
    due.forEach(function (r) { fired[r.key] = now; });
    saveFired(fired);
    notify(due);
  }

  // ---- panel ----
  var PANEL_ID = 'reminders-panel';
  function fmtAt(ts) {
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var opts = { hour: '2-digit', minute: '2-digit' };
    var time = d.toLocaleTimeString([], opts);
    if (sameDay) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }
  function renderPanel() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var fired = loadFired();
    var all = collect();
    var now = Date.now();
    var upcoming = all.filter(function (r) { return !fired[r.key] && r.at > now; }).slice(0, 30);
    var overdue = all.filter(function (r) { return fired[r.key] && now - fired[r.key] < 24 * 3600 * 1000; }).slice(-6);
    var rows = function (list, cls) {
      return list.map(function (r) {
        var roomAttr = esc(r.room.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        return '<div class="rem-row ' + cls + '">' +
          '<span class="rem-at">' + esc(fmtAt(r.at)) + '</span>' +
          '<span class="rem-msg">' + esc(r.msg) + '</span>' +
          (r.room && r.room !== '(local)' ? '<button class="rem-room" title="Open room" onclick="window.__remindersGo(\'' + roomAttr + '\')">' + esc(r.room) + '</button>' : '') +
          '</div>';
      }).join('');
    };
    var html = '';
    var perm = (window.Notification && Notification.permission) || 'unsupported';
    if (perm === 'default') {
      html += '<button class="btn rem-wide" onclick="window.__remindersAskPerm()">🔔 Enable system notifications</button>';
    } else if (perm === 'denied') {
      html += '<div class="rem-hint">System notifications are blocked for this site — reminders will use in-app popups.</div>';
    }
    html += '<div class="rem-sec">Upcoming</div>';
    html += upcoming.length ? rows(upcoming, '') : '<div class="rem-empty">None. Write <code>@remind!18:30! message</code> in any doc.</div>';
    if (overdue.length) {
      html += '<div class="rem-sec">Fired recently</div>' + rows(overdue, 'fired');
    }
    html += '<div class="rem-btns">' +
      '<button class="btn" onclick="window.__remindersInsert()">＋ Insert reminder</button>' +
      '<button class="btn" onclick="window.__remindersRefresh()">↻ Rescan</button>' +
      '</div>';
    html += '<div class="rem-hint">Fires while the app is open (up to 12h late on next launch if it was closed).</div>';
    p.querySelector('.cade-panel-body').innerHTML = html;
  }
  function renderIfOpen() { if (document.getElementById(PANEL_ID)) renderPanel(); }

  function openPanel(keepFocus) {
    if (!document.getElementById(PANEL_ID)) {
      var p = Cade.mkPanel(PANEL_ID, '⏰ Reminders', '');
      p._onClose = function () {};
    }
    renderPanel();
    if (!keepFocus) { try { Cade.closeAllMenus(); } catch (e) {} }
  }

  window.__remindersGo = function (room) { try { RA.switchRoom(room); } catch (e) {} };
  window.__remindersAskPerm = function () {
    try {
      Notification.requestPermission().then(function () { renderIfOpen(); });
    } catch (e) {}
  };
  window.__remindersRefresh = function () { renderPanel(); Cade.showToast('Rescanned', 'success', 1200); };
  window.__remindersInsert = function () {
    try {
      var d = new Date(Date.now() + 30 * 60 * 1000);
      d.setSeconds(0, 0);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var spec = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var ins = '@remind!' + spec + '! ';
      var sel = window.editor.state.selection.main;
      window.editor.dispatch({
        changes: { from: sel.from, to: sel.to, insert: ins },
        selection: { anchor: sel.from + ins.length },
      });
      window.editor.focus();
    } catch (e) {}
  };

  // ---- background engine (module is eager-loaded at boot) ----
  setInterval(checkDue, CHECK_MS);
  setTimeout(checkDue, 3000);
  // Keep an open panel fresh as the user types (debounced).
  var _rerenderT = null;
  Cade.onEditorUpdate(function (u) {
    if (!u.docChanged) return;
    if (!document.getElementById(PANEL_ID)) return;
    clearTimeout(_rerenderT);
    _rerenderT = setTimeout(renderIfOpen, 800);
  });

  Cade.registerWidget({
    name: 'Reminders',
    description: 'Fire alerts from @remind!datetime!message tokens in your docs',
    icon: '⏰',
    tags: 'remind,reminder,alarm,alert,notification,time,schedule',
    open: function () { openPanel(); },
  });
})();
