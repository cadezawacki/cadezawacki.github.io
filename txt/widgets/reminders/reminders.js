/* Reminders v2 — two sources, one alarm engine:
   1. DOC TOKENS: write `@remind!<when>!<message>` anywhere in a document.
   2. MANAGED REMINDERS: added from this panel — they do NOT touch any
      document; they live in a hidden per-account store (an encrypted synced
      blob under the app's Firebase `rooms/` namespace via Cade.syncedBlob)
      and sync across devices. No Firebase rules change needed.

   <when> forms (local time):
     2026-07-11 18:30      exact datetime ("T" also works)
     2026-07-11            whole day → 09:00
     07-11 18:30           this year (rolls to next year if past)
     18:30                 today — rolls to tomorrow if already past (no date
                           needed; item 24)
   RECURRING forms (item 24):
     daily 08:30           every day at 08:30
     weekdays 09:00        Mon–Fri at 09:00
     every mon 09:00       weekly on that day (sun/mon/tue/wed/thu/fri/sat)
   Each occurrence fires once (fired-keys carry the occurrence date).

   HONEST LIMITATION: a static web app cannot wake your device on its own —
   reminders fire while the app (or its PWA window) is open. This module
   loads eagerly at boot, so having the app open anywhere is enough. One-shot
   reminders missed while the app was closed fire up to 12 hours late on next
   launch, marked "missed"; recurring ones fire only on their day.

   Fired keys live in `cade-reminders-fired` (pruned 30 days / 500 entries).
   The panel also shows a PAST 24H log — every occurrence (fired or missed)
   from any source, each with a ✕ that hides just that occurrence on this
   device via `cade-reminders-dismissed` (pruned 25 h / 200 entries). */
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
  var DISMISSED_KEY = 'cade-reminders-dismissed';
  var GRACE_MS = 12 * 3600 * 1000;
  var DAY_MS = 24 * 3600 * 1000;
  var CHECK_MS = 20 * 1000;
  var DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---- managed store (hidden, synced) ----
  var managed = { items: [] };
  function normalizeManaged(data) {
    var out = { items: [] };
    if (data && Array.isArray(data.items)) {
      data.items.forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        var id = String(it.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
        if (!id) return;
        var rec = null;
        if (it.recur && typeof it.recur === 'object' && /^(daily|weekdays|weekly)$/.test(it.recur.kind)) {
          rec = { kind: it.recur.kind, hh: +it.recur.hh || 0, mm: +it.recur.mm || 0 };
          if (rec.kind === 'weekly') rec.dow = Math.max(0, Math.min(6, +it.recur.dow || 0));
        }
        out.items.push({
          id: id,
          at: rec ? null : (+it.at || null),
          recur: rec,
          msg: String(it.msg || '').slice(0, 300),
          done: !!it.done,
        });
      });
    }
    // Memory care: drop done one-shots older than 7 days; cap at 500.
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    out.items = out.items.filter(function (it) {
      return !(it.done && !it.recur && it.at && it.at < cutoff);
    }).slice(0, 500);
    return out;
  }
  var blobStore = Cade.syncedBlob('reminders', {
    onChange: function (data) { managed = normalizeManaged(data); renderIfOpen(); },
  });
  // Calendar events with a 🔔 (round-4 item 5) become reminders too. Read-only
  // accessor — passing no onChange leaves the calendar module's handler alone.
  var calBlob = Cade.syncedBlob('calendar');
  function calNotifications(now) {
    // → [{key, at, msg}] for events with notify != null (minutes before start)
    var out = [];
    try {
      var data = calBlob.get();
      var evs = data && Array.isArray(data.events) ? data.events : [];
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (!e || e.notify == null || !e.date || !e.start) continue;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.date));
        var t = /^(\d{1,2}):(\d{2})$/.exec(String(e.start));
        if (!m || !t) continue;
        var startTs = new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]).getTime();
        var at = startTs - (Math.max(0, +e.notify) * 60 * 1000);
        out.push({
          key: 'cal:' + e.id,
          at: at,
          msg: '🗓 ' + String(e.title || 'Event') + ' at ' + String(e.start) + (+e.notify > 0 ? ' (in ' + (+e.notify) + ' min)' : ''),
        });
      }
    } catch (err) {}
    return out;
  }
  managed = normalizeManaged(blobStore.get());
  function saveManaged() { blobStore.set(managed); renderIfOpen(); }
  function newId() { return 'r' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

  // ---- spec parsing ----
  // Returns {at} for one-shots, {recur:{kind,hh,mm,dow?}} for recurring, null otherwise.
  function parseSpec(spec, nowDate) {
    spec = String(spec || '').trim().toLowerCase();
    var now = nowDate || new Date();
    var m;
    if ((m = /^daily\s+(\d{1,2}):(\d{2})$/.exec(spec))) return { recur: { kind: 'daily', hh: +m[1], mm: +m[2] } };
    if ((m = /^weekdays\s+(\d{1,2}):(\d{2})$/.exec(spec))) return { recur: { kind: 'weekdays', hh: +m[1], mm: +m[2] } };
    if ((m = /^every\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2}):(\d{2})$/.exec(spec))) {
      return { recur: { kind: 'weekly', dow: DOW[m[1]], hh: +m[2], mm: +m[3] } };
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(spec))) {
      return { at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() };
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(spec))) {
      return { at: new Date(+m[1], +m[2] - 1, +m[3], 9, 0).getTime() };
    }
    if ((m = /^(\d{1,2})-(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(spec))) {
      var d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
      if (d.getTime() < now.getTime() - 60000) d = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4]);
      return { at: d.getTime() };
    }
    if ((m = /^(\d{1,2}):(\d{2})$/.exec(spec))) {
      if (+m[1] > 23 || +m[2] > 59) return null;
      var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
      if (t.getTime() < now.getTime() - 60000) t = new Date(t.getTime() + 24 * 3600 * 1000);
      return { at: t.getTime() };
    }
    return null;
  }

  function _dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Today's occurrence timestamp for a recurrence, or null if it doesn't run today.
  function occurrenceToday(rec, now) {
    var dow = now.getDay();
    if (rec.kind === 'weekdays' && (dow === 0 || dow === 6)) return null;
    if (rec.kind === 'weekly' && dow !== rec.dow) return null;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), rec.hh, rec.mm).getTime();
  }
  // The next upcoming occurrence (for display), within 8 days.
  function nextOccurrence(rec, now) {
    for (var i = 0; i < 8; i++) {
      var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      var occ = occurrenceToday(rec, day);
      if (occ != null && occ > now.getTime()) return occ;
    }
    return null;
  }
  // Occurrences of a recurrence that landed within the last 24 h — today's
  // and/or yesterday's slot (at most two can ever fit in a 24 h window).
  function recentOccurrences(rec, now) {
    var out = [];
    for (var i = -1; i <= 0; i++) {
      var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      var occ = occurrenceToday(rec, day);
      if (occ != null && occ <= now.getTime() && occ > now.getTime() - DAY_MS) out.push(occ);
    }
    return out;
  }
  function recurLabel(rec) {
    var t = String(rec.hh).padStart(2, '0') + ':' + String(rec.mm).padStart(2, '0');
    if (rec.kind === 'daily') return 'daily ' + t;
    if (rec.kind === 'weekdays') return 'weekdays ' + t;
    return 'every ' + DOW_NAMES[rec.dow] + ' ' + t;
  }

  // ---- doc scanning ----
  function scanText(room, text, list) {
    if (!text || text.indexOf('@remind!') === -1) return;
    TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      var parsed = parseSpec(m[1]);
      if (!parsed) continue;
      var msg = (m[2] || '').trim();
      if (!msg) {
        var ls = text.lastIndexOf('\n', m.index) + 1;
        var le = text.indexOf('\n', m.index);
        if (le === -1) le = text.length;
        msg = (text.slice(ls, m.index) + ' ' + text.slice(m.index + m[0].length, le)).trim() || 'Reminder';
      }
      list.push({
        room: room, msg: msg,
        at: parsed.at || null, recur: parsed.recur || null,
        key: room + '|' + m[1].trim() + '|' + msg,
      });
    }
  }
  function collectDoc() {
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
    return out;
  }

  function loadFired() { try { return JSON.parse(store.get(FIRED_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveFired(f) {
    var cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    var keys = Object.keys(f).filter(function (k) { return f[k] >= cutoff; })
      .sort(function (a, b) { return f[b] - f[a]; }).slice(0, 500);
    var out = {};
    keys.forEach(function (k) { out[k] = f[k]; });
    store.set(FIRED_KEY, JSON.stringify(out));
  }
  // Past-24h rows the user ✕-dismissed. Device-local (occurrence-key → ts);
  // anything past the 24 h window drops out of the list on its own, so the
  // store only needs to outlive the window (pruned 25 h / 200 entries).
  function loadDismissed() { try { return JSON.parse(store.get(DISMISSED_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveDismissed(d) {
    var cutoff = Date.now() - 25 * 3600 * 1000;
    var keys = Object.keys(d).filter(function (k) { return d[k] >= cutoff; })
      .sort(function (a, b) { return d[b] - d[a]; }).slice(0, 200);
    var out = {};
    keys.forEach(function (k) { out[k] = d[k]; });
    store.set(DISMISSED_KEY, JSON.stringify(out));
  }

  // ---- the alarm engine ----
  function dueNow() {
    var now = Date.now();
    var today = _dateKey(new Date(now));
    var fired = loadFired();
    var due = [];
    collectDoc().forEach(function (r) {
      if (r.recur) {
        var occ = occurrenceToday(r.recur, new Date(now));
        var k = r.key + '@' + today;
        if (occ != null && occ <= now && now - occ < GRACE_MS && !fired[k]) due.push({ src: r, key: k, at: occ });
      } else if (r.at && r.at <= now && r.at > now - GRACE_MS && !fired[r.key]) {
        due.push({ src: r, key: r.key, at: r.at });
      }
    });
    managed.items.forEach(function (it) {
      if (it.recur) {
        var occ = occurrenceToday(it.recur, new Date(now));
        var k = 'm:' + it.id + '@' + today;
        if (occ != null && occ <= now && now - occ < GRACE_MS && !fired[k]) due.push({ src: it, key: k, at: occ, managed: true });
      } else if (!it.done && it.at && it.at <= now && it.at > now - GRACE_MS && !fired['m:' + it.id]) {
        due.push({ src: it, key: 'm:' + it.id, at: it.at, managed: true });
      }
    });
    calNotifications(now).forEach(function (c) {
      if (c.at <= now && c.at > now - GRACE_MS && !fired[c.key]) {
        due.push({ src: { msg: c.msg }, key: c.key, at: c.at, managed: true });
      }
    });
    return { due: due, fired: fired };
  }
  function checkDue() {
    var r = dueNow();
    if (!r.due.length) return;
    var now = Date.now();
    var changedManaged = false;
    r.due.forEach(function (d) {
      r.fired[d.key] = now;
      if (d.managed && !d.src.recur) { d.src.done = true; changedManaged = true; }
    });
    saveFired(r.fired);
    if (changedManaged) saveManaged();
    notify(r.due);
  }
  function notify(due) {
    try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch (e) {}
    var missed = due.some(function (d) { return Date.now() - d.at > 2 * 60 * 1000; });
    var title = (missed ? '⏰ Missed reminder' : '⏰ Reminder') + (due.length > 1 ? 's (' + due.length + ')' : '');
    var body = due.map(function (d) {
      var where = d.managed ? '' : (d.src.room && d.src.room !== '(local)' ? ' — ' + d.src.room : '');
      return d.src.msg + where;
    }).join('\n');
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body: body, tag: 'cade-reminders' });
      }
    } catch (e) {}
    Cade.showToast(title + ': ' + body.split('\n')[0] + (due.length > 1 ? ' …' : ''), 'success', 8000);
    openPanel(true);
  }

  // ---- panel ----
  var PANEL_ID = 'reminders-panel';
  var _formOpen = false;
  function fmtAt(ts) {
    var d = new Date(ts), now = new Date();
    var opts = { hour: '2-digit', minute: '2-digit' };
    var time = d.toLocaleTimeString([], opts);
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }
  function upcomingRows() {
    // Merge doc + managed into one sorted upcoming view.
    var now = Date.now();
    var fired = loadFired();
    var rows = [];
    collectDoc().forEach(function (r) {
      if (r.recur) {
        var nxt = nextOccurrence(r.recur, new Date(now));
        if (nxt) rows.push({ at: nxt, msg: r.msg, room: r.room, recur: r.recur });
      } else if (r.at && r.at > now && !fired[r.key]) {
        rows.push({ at: r.at, msg: r.msg, room: r.room });
      }
    });
    managed.items.forEach(function (it) {
      if (it.recur) {
        var nxt = nextOccurrence(it.recur, new Date(now));
        if (nxt) rows.push({ at: nxt, msg: it.msg, managed: true, id: it.id, recur: it.recur });
      } else if (!it.done && it.at && it.at > now) {
        rows.push({ at: it.at, msg: it.msg, managed: true, id: it.id });
      }
    });
    calNotifications(now).forEach(function (c) {
      if (c.at > now && !fired[c.key]) rows.push({ at: c.at, msg: c.msg, cal: true });
    });
    rows.sort(function (a, b) { return a.at - b.at; });
    return rows.slice(0, 40);
  }
  function pastRows() {
    // Every occurrence that landed in the last 24 h, newest first — fired or
    // missed alike, it's a log — minus the ones ✕-dismissed on this device.
    // Keys reuse the fired-keys format so each occurrence has one identity:
    // doc `room|spec|msg`, managed `m:<id>`, calendar `cal:<id>`, recurring
    // ones with `@YYYY-MM-DD` (the occurrence date) appended.
    var now = Date.now();
    var dismissed = loadDismissed();
    var rows = [];
    function add(key, at, msg, room) {
      if (at == null || at > now || at <= now - DAY_MS || dismissed[key]) return;
      rows.push({ key: key, at: at, msg: msg, room: room || null });
    }
    collectDoc().forEach(function (r) {
      if (r.recur) {
        recentOccurrences(r.recur, new Date(now)).forEach(function (occ) {
          add(r.key + '@' + _dateKey(new Date(occ)), occ, r.msg, r.room);
        });
      } else add(r.key, r.at, r.msg, r.room);
    });
    managed.items.forEach(function (it) {
      if (it.recur) {
        recentOccurrences(it.recur, new Date(now)).forEach(function (occ) {
          add('m:' + it.id + '@' + _dateKey(new Date(occ)), occ, it.msg);
        });
      } else add('m:' + it.id, it.at, it.msg);
    });
    calNotifications(now).forEach(function (c) { add(c.key, c.at, c.msg); });
    rows.sort(function (a, b) { return b.at - a.at; });
    return rows.slice(0, 40);
  }
  function renderPanel() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var html = '';
    var perm = (window.Notification && Notification.permission) || 'unsupported';
    if (perm === 'default') html += '<button class="btn rem-wide" onclick="window.__remindersAskPerm()">🔔 Enable system notifications</button>';
    else if (perm === 'denied') html += '<div class="rem-hint">System notifications are blocked for this site — reminders will use in-app popups.</div>';

    if (_formOpen) {
      var d = new Date(Date.now() + 30 * 60 * 1000);
      d.setSeconds(0, 0);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var dtVal = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      html += '<div class="rem-form">' +
        '<input type="text" class="form-input rem-in" id="rem-form-msg" placeholder="Remind me to…" maxlength="300">' +
        '<div class="rem-form-row">' +
          '<select id="rem-form-recur" class="rem-sel" onchange="window.__remindersFormMode()">' +
            '<option value="">once</option><option value="daily">daily</option><option value="weekdays">weekdays</option>' +
            DOW_NAMES.map(function (n, i) { return '<option value="w' + i + '">every ' + n + '</option>'; }).join('') +
          '</select>' +
          '<input type="datetime-local" class="form-input rem-in" id="rem-form-dt" value="' + dtVal + '">' +
          '<input type="time" class="form-input rem-in" id="rem-form-time" value="09:00" style="display:none;">' +
        '</div>' +
        '<div class="rem-form-row">' +
          '<button class="btn btn-primary" onclick="window.__remindersFormSave()">Save</button>' +
          '<button class="btn" onclick="window.__remindersFormToggle()">Cancel</button>' +
        '</div>' +
        '<div class="rem-hint">Saved reminders live in your synced account store — not in any document.</div>' +
        '</div>';
    }

    var rows = upcomingRows();
    html += '<div class="rem-sec">Upcoming</div>';
    html += rows.length ? rows.map(function (r) {
      var recur = r.recur ? '<span class="rem-recur" title="recurring">↻ ' + esc(recurLabel(r.recur)) + '</span>' : '';
      var src;
      if (r.managed) {
        src = '<button class="rem-x" title="Delete reminder" onclick="window.__remindersDelete(\'' + esc(r.id) + '\')">✕</button>';
      } else if (r.room && r.room !== '(local)') {
        var roomAttr = esc(r.room.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        src = '<button class="rem-room" title="Open room" onclick="window.__remindersGo(\'' + roomAttr + '\')">' + esc(r.room) + '</button>';
      } else src = '';
      return '<div class="rem-row"><span class="rem-at">' + esc(fmtAt(r.at)) + '</span>' +
        '<span class="rem-msg">' + esc(r.msg) + ' ' + recur + '</span>' + src + '</div>';
    }).join('') : '<div class="rem-empty">None. Add one below, or write <code>@remind!18:30! message</code> in any doc.</div>';

    var past = pastRows();
    if (past.length) {
      html += '<div class="rem-sec">Past 24h</div>';
      html += past.map(function (r) {
        var keyAttr = esc(r.key.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        var hint = r.room && r.room !== '(local)' ? '<span class="rem-src" title="From doc">' + esc(r.room) + '</span>' : '';
        return '<div class="rem-row rem-past"><span class="rem-at">' + esc(fmtAt(r.at)) + '</span>' +
          '<span class="rem-msg">' + esc(r.msg) + '</span>' + hint +
          '<button class="rem-x" title="Dismiss" onclick="window.__remindersDismiss(\'' + keyAttr + '\')">✕</button></div>';
      }).join('');
    }

    html += '<div class="rem-btns">' +
      (_formOpen ? '' : '<button class="btn btn-primary" onclick="window.__remindersFormToggle()">＋ Add reminder</button>') +
      '<button class="btn" onclick="window.__remindersInsert()">Insert Reminder</button>' +
      '</div>';
    html += '<div class="rem-hint">Fires while the app is open · recurring: daily / weekdays / every &lt;day&gt; · one-shots missed while closed fire up to 12h late.</div>';
    p.querySelector('.cade-panel-body').innerHTML = html;
  }
  function renderIfOpen() { if (document.getElementById(PANEL_ID)) renderPanel(); }
  function openPanel(keepFocus) {
    if (!document.getElementById(PANEL_ID)) {
      var p = Cade.mkPanel(PANEL_ID, '⏰ Reminders', '');
      p._onClose = function () { _formOpen = false; };
    }
    renderPanel();
    if (!keepFocus) { try { Cade.closeAllMenus(); } catch (e) {} }
  }

  // ---- window handlers (inline onclick) ----
  window.__remindersGo = function (room) { try { RA.switchRoom(room); } catch (e) {} };
  window.__remindersAskPerm = function () {
    try { Notification.requestPermission().then(function () { renderIfOpen(); }); } catch (e) {}
  };
  window.__remindersFormToggle = function () { _formOpen = !_formOpen; renderPanel(); if (_formOpen) { var el = document.getElementById('rem-form-msg'); if (el) el.focus(); } };
  window.__remindersFormMode = function () {
    var rec = document.getElementById('rem-form-recur').value;
    document.getElementById('rem-form-dt').style.display = rec ? 'none' : '';
    document.getElementById('rem-form-time').style.display = rec ? '' : 'none';
  };
  window.__remindersFormSave = function () {
    var msg = (document.getElementById('rem-form-msg').value || '').trim();
    if (!msg) { Cade.showToast('Write a message first', 'error', 2000); return; }
    var recSel = document.getElementById('rem-form-recur').value;
    var item = { id: newId(), msg: msg, done: false, at: null, recur: null };
    if (recSel) {
      var tm = (document.getElementById('rem-form-time').value || '09:00').split(':');
      var rec = { hh: +tm[0] || 0, mm: +tm[1] || 0 };
      if (recSel === 'daily') rec.kind = 'daily';
      else if (recSel === 'weekdays') rec.kind = 'weekdays';
      else { rec.kind = 'weekly'; rec.dow = +recSel.slice(1); }
      item.recur = rec;
    } else {
      var dt = document.getElementById('rem-form-dt').value;
      var ts = dt ? new Date(dt).getTime() : NaN;
      if (!isFinite(ts)) { Cade.showToast('Pick a date & time', 'error', 2000); return; }
      item.at = ts;
    }
    managed.items.push(item);
    _formOpen = false;
    saveManaged();
    Cade.showToast('Reminder saved (syncs to your devices)', 'success', 2200);
  };
  window.__remindersDelete = function (id) {
    managed.items = managed.items.filter(function (it) { return it.id !== id; });
    saveManaged();
  };
  window.__remindersDismiss = function (key) {
    var d = loadDismissed();
    d[key] = Date.now();
    saveDismissed(d);
    renderIfOpen();
  };
  window.__remindersInsert = function () {
    try {
      var d = new Date(Date.now() + 30 * 60 * 1000);
      d.setSeconds(0, 0);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var spec = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var ins = '@remind!' + spec + '! ';
      var sel = window.editor.state.selection.main;
      window.editor.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length } });
      window.editor.focus();
    } catch (e) {}
  };
  window.__remindersOpen = function () { openPanel(); };

  // ---- background engine (module is eager-loaded at boot) ----
  setInterval(checkDue, CHECK_MS);
  setTimeout(checkDue, 3000);
  var _rerenderT = null;
  Cade.onEditorUpdate(function (u) {
    if (!u.docChanged) return;
    if (!document.getElementById(PANEL_ID)) return;
    clearTimeout(_rerenderT);
    _rerenderT = setTimeout(renderIfOpen, 800);
  });

  Cade.registerWidget({
    name: 'Reminders',
    description: 'Alarms from @remind! tokens plus a synced reminder manager (recurring supported)',
    icon: '⏰',
    tags: 'remind,reminder,alarm,alert,notification,time,schedule,recurring',
    open: function () { openPanel(); },
    // Internal hooks for the Node smoke test (harmless in production).
    _test: {
      parseSpec: parseSpec,
      dueNow: dueNow,
      upcomingRows: upcomingRows,
      pastRows: pastRows,
      recentOccurrences: recentOccurrences,
      loadDismissed: loadDismissed,
    },
  });
})();
