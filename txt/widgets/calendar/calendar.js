/* Calendar Events — personal schedule manager. A month grid (Mon-first) on
   the left, the selected day's agenda on the right: each event shows its
   start/end times stacked in a muted column, a bar + label colored by the
   event's WORKSPACE, and the event title. Events are added/edited through an
   inline form in the right column (no browser prompts).

   Data lives in a core synced blob (Cade.syncedBlob('calendar')): stored
   locally at once, encrypted + synced across the account's devices when the
   app has sync configured. Shape:
     {
       events: [ { id:      string  ([A-Za-z0-9_-], generated),
                   date:    'YYYY-MM-DD',
                   start:   'HH:MM'   (24h),
                   end:     'HH:MM'   (24h, optional — '' when absent),
                   title:   string,
                   cat:     string    ('' = none; a WORKSPACE ID since round 7,
                                       though legacy free-text names may still
                                       appear in synced data),
                   color:   string    (one of the 8 legacy palette names; kept
                                       in the schema so older devices render
                                       something — THIS code colors by the
                                       workspace instead) } ],
       cats:   { <name>: <color> }   (legacy category→color map; preserved
                                      untouched for older devices)
     }
   Everything is normalized defensively on read (fields/arrays may be missing
   or malformed after a partial sync). All ids/classes are cal-*.

   Categories ARE workspaces (round 7). The form's category select is the
   workspace list from Cade.roomsApi.workspaces() — "— None —" plus one option
   per workspace (label = workspace name), degrading to a plain "General"
   option when the workspace surface is absent — and the stored `cat` is the
   WORKSPACE ID. Bars/dots take the workspace's color by reusing the core
   ws-color-<name> classes (they set --ws-fg). A cat that doesn't resolve
   (deleted workspace, legacy free-text) renders neutral and never crashes;
   managing workspaces IS managing categories, so there is no category UI.

   Rooms by date (absorbed from the retired daycal widget). The room system is
   reached through Cade.roomsApi — read at call time and null-guarded, so the
   calendar still works when that surface is absent:
   - A DAILY-NOTE room is simply a room named with the day's local date key
     'YYYY-MM-DD' (daycal's key scheme), so existing rooms named that way stay
     reachable. Day cells that have one get a small corner mark, and the
     selected day offers "Open daily note" (exists) or "＋ Daily note" (create
     — via roomsApi.ensureRoom when the core provides it, else plain
     switchRoom, which the core registers on the next boot via the room URL).
   - The selected day also lists every room whose last modification (fallback:
     creation) fell on that day — the old Rooms-by-Date activity view — and
     opening one first jumps into its own workspace, exactly as daycal did.

   window.__calAgenda(dateKey) returns that day's events (copies), exposed for
   a future reminders integration. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('calendar.css');
  var esc = Cade.escapeHtml;

  // The 8 legacy highlight palette names — kept ONLY to normalize the stored
  // event `color` field (older devices still read it; see header).
  var PALETTE = ['yellow', 'green', 'blue', 'red', 'pink', 'purple', 'orange', 'gray'];
  // Core workspace palette (txt.html WS_COLORS) + a best-effort mapping onto
  // the legacy palette for the stored `color` field.
  var WS_COLORS = ['neutral', 'teal', 'blue', 'green', 'amber', 'orange', 'pink', 'purple'];
  var WS_TO_HL = { neutral: 'gray', teal: 'green', blue: 'blue', green: 'green', amber: 'yellow', orange: 'orange', pink: 'pink', purple: 'purple' };
  var MAX_EVENTS = 1000;

  // ---- module state -------------------------------------------------------
  var state = { events: [], cats: {} };
  var month = null;        // Date pinned to the 1st of the displayed month
  var sel = null;          // selected dateKey 'YYYY-MM-DD'
  var form = null;         // null | { id: string|null } (null id = adding)
  var formFresh = false;   // skip draft capture on the render right after open

  var blobStore = Cade.syncedBlob('calendar', {
    onChange: function (data) { state = normalize(data); render(); },
  });

  // ---- helpers ------------------------------------------------------------
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function genId() { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function normColor(c) { return PALETTE.indexOf(c) !== -1 ? c : 'blue'; }
  function normTime(t) {
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t == null ? '' : t).trim());
    if (!m) return '';
    var h = Math.min(23, +m[1]), mi = Math.min(59, +m[2]);
    return p2(h) + ':' + p2(mi);
  }
  function byDateStart(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return 0;
  }
  function fmtTime(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hm || '');
    if (!m) return '';
    var h = +m[1], h12 = h % 12 || 12;
    return h12 + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // Defensive normalization: the blob may be null, partial, or synced from an
  // older/newer version — never trust its shape.
  function normalize(data) {
    var out = { events: [], cats: {} };
    if (!data || typeof data !== 'object') data = {};
    var cats = (data.cats && typeof data.cats === 'object') ? data.cats : {};
    for (var k in cats) {
      if (!Object.prototype.hasOwnProperty.call(cats, k)) continue;
      var name = String(k).slice(0, 40);
      if (name) out.cats[name] = normColor(cats[k]);
    }
    var evs = Array.isArray(data.events) ? data.events : [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (!e || typeof e !== 'object') continue;
      var date = String(e.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      var id = String(e.id || '');
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) id = genId(); // also keeps inline onclick attrs injection-safe
      var notify = null; // minutes before start; 0 = at start; null = no reminder
      if (e.notify != null && isFinite(+e.notify) && +e.notify >= 0 && +e.notify <= 1440) notify = Math.round(+e.notify);
      out.events.push({
        id: id,
        date: date,
        start: normTime(e.start) || '00:00',
        end: normTime(e.end),
        title: String(e.title == null ? '' : e.title).slice(0, 200) || '(untitled)',
        cat: String(e.cat == null ? '' : e.cat).slice(0, 40),
        color: normColor(e.color),
        notify: notify,
      });
    }
    out.events.sort(byDateStart);
    // Memory care: cap at MAX_EVENTS. When over the cap, drop the OLDEST PAST
    // events first (least likely to be needed again); if somehow still over
    // (1000+ future events), trim the farthest-future ones.
    if (out.events.length > MAX_EVENTS) {
      var todayK = dateKey(new Date());
      var over = out.events.length - MAX_EVENTS;
      var kept = [];
      for (var j = 0; j < out.events.length; j++) {
        var ev = out.events[j];
        if (over > 0 && ev.date < todayK) { over--; continue; }
        kept.push(ev);
      }
      if (kept.length > MAX_EVENTS) kept.length = MAX_EVENTS;
      out.events = kept;
    }
    return out;
  }

  function persist() { blobStore.set({ events: state.events, cats: state.cats }); }

  function agenda(key) {
    var list = [];
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].date === key) list.push(state.events[i]);
    }
    return list; // state.events is kept sorted by date+start
  }
  function findEvent(id) {
    for (var i = 0; i < state.events.length; i++) if (state.events[i].id === id) return state.events[i];
    return null;
  }
  function toast(msg) { if (Cade.showToast) Cade.showToast(msg, 'error', 2500); }
  function gv(id) {
    var el = document.getElementById(id);
    return el ? String(el.value == null ? '' : el.value).trim() : '';
  }

  // ---- rooms by date (merged from the retired daycal widget) ---------------
  // A daily-note room is one NAMED with the local date key 'YYYY-MM-DD' —
  // the key scheme daycal used — so any room named that way is recognized,
  // however it was created.
  var DAY_ROOM_RE = /^\d{4}-\d{2}-\d{2}$/;
  function noteRoomSet() {
    var out = {};
    var ra = Cade.roomsApi;
    if (!ra) return out;
    var names = ra.list();
    for (var i = 0; i < names.length; i++) {
      if (DAY_ROOM_RE.test(names[i])) out[names[i]] = 1;
    }
    return out;
  }
  // Rooms whose last modification (fallback: creation) fell on `key`, newest
  // first — daycal's activity list for a day.
  function activityRooms(key) {
    var ra = Cade.roomsApi;
    if (!ra) return [];
    var names = ra.list(), out = [];
    for (var i = 0; i < names.length; i++) {
      var m = ra.meta(names[i]) || {};
      var ts = m.modified || m.created;
      if (ts && dateKey(new Date(ts)) === key) out.push(names[i]);
    }
    out.sort(function (a, b) { return ra.modifiedAt(b) - ra.modifiedAt(a); });
    return out;
  }
  // daycal's open logic: jump into the room's own workspace (first membership)
  // so its tab is visible, unless it's already visible here or pinned.
  function openDayRoom(ra, name) {
    var ids = ra.workspaceIds(name) || [];
    var wsId = ids.length ? ids[0] : ra.WS_ALL;
    if (!ra.inWorkspace(name, ra.activeWorkspace()) && !ra.isPinned(name)) {
      ra.setActiveWorkspace(wsId);
    }
    ra.switchRoom(name);
  }

  // ---- workspaces as categories (round 7) ----------------------------------
  // The user's workspaces [{id, name, color}] — [] when the surface is absent
  // (older core, tests), which degrades the form to a plain "General" option.
  function wsList() {
    var ra = Cade.roomsApi;
    if (!ra || typeof ra.workspaces !== 'function') return [];
    var l = ra.workspaces();
    return Array.isArray(l) ? l : [];
  }
  // Resolve an event's cat (a workspace id) to its workspace, else null —
  // null for '' cats, legacy free-text cats and deleted-workspace ids.
  function wsForCat(cat) {
    var ra = Cade.roomsApi;
    if (!cat || !ra || typeof ra.workspaceById !== 'function') return null;
    var ws = ra.workspaceById(cat);
    return (ws && ws.id) ? ws : null;
  }
  // Sanitize a workspace's color to a known core palette name (the value
  // comes from synced data and lands in a class attribute) — like core does.
  function wsColorName(ws) {
    var c = ws && ws.color != null ? String(ws.color) : 'neutral';
    return WS_COLORS.indexOf(c) !== -1 ? c : 'neutral';
  }

  // ---- rendering ----------------------------------------------------------
  // Preserve typed form values across re-renders (day picks, remote syncs).
  function captureDraft() {
    if (!form || !document.getElementById('cal-f-title')) return null;
    return {
      date: gv('cal-f-date'), start: gv('cal-f-start'), end: gv('cal-f-end'),
      title: gv('cal-f-title'), cat: gv('cal-f-cat'),
      notify: gv('cal-f-notify'),
    };
  }

  function monthHtml() {
    var ref = month || new Date();
    var y = ref.getFullYear(), mo = ref.getMonth();
    var days = new Date(y, mo + 1, 0).getDate();
    var off = (new Date(y, mo, 1).getDay() + 6) % 7; // Mon-first
    var todayK = dateKey(new Date());
    var monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });
    // Per-day workspace dots: one dot per distinct workspace color that day
    // (max 3). Events whose cat doesn't resolve share a single neutral dot.
    var byDay = {};
    for (var i = 0; i < state.events.length; i++) {
      var e = state.events[i];
      var day = byDay[e.date] || (byDay[e.date] = { seen: {}, dots: [] });
      var ws = wsForCat(e.cat);
      var g = ws ? wsColorName(ws) : ''; // '' = the neutral (no-workspace) group
      if (day.seen[g]) continue;
      day.seen[g] = 1;
      if (day.dots.length < 3) day.dots.push('<span class="cal-dot' + (g ? ' ws-color-' + g : '') + '"></span>');
    }
    var noteRooms = noteRoomSet();
    var dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var grid = '';
    for (var w = 0; w < 7; w++) grid += '<div class="cal-cell cal-dow">' + dow[w] + '</div>';
    for (var b = 0; b < off; b++) grid += '<div class="cal-cell cal-empty"></div>';
    for (var d = 1; d <= days; d++) {
      var key = y + '-' + p2(mo + 1) + '-' + p2(d);
      var cls = 'cal-cell cal-day' +
        (key === todayK ? ' today' : '') +
        (key === sel ? ' sel' : '') +
        (byDay[key] ? ' has' : '') +
        (noteRooms[key] ? ' cal-note' : '');
      grid += '<div class="' + cls + '" onclick="__calPick(' + y + ',' + mo + ',' + d + ')"><span class="cal-n">' + d + '</span>' +
        (byDay[key] ? '<span class="cal-dots">' + byDay[key].dots.join('') + '</span>' : '') + '</div>';
    }
    return '<div class="cal-left">' +
      '<div class="cal-head">' +
        '<button class="cal-nav" title="Previous month" onclick="__calNav(-1)">&lsaquo;</button>' +
        '<span class="cal-month">' + esc(monthName) + '</span>' +
        '<button class="cal-nav" title="Next month" onclick="__calNav(1)">&rsaquo;</button>' +
      '</div>' +
      '<div class="cal-grid">' + grid + '</div></div>';
  }

  function rowHtml(ev) {
    // Color + label come from the event's workspace. Unresolvable cats render
    // a neutral bar; legacy free-text cats keep their text as the label, but
    // a dangling workspace id (ws_…) is noise, not a name — show nothing.
    var ws = wsForCat(ev.cat);
    var label = ws ? String(ws.name == null ? '' : ws.name)
                   : (ev.cat && ev.cat.indexOf('ws_') !== 0 ? ev.cat : '');
    return '<button class="cal-ev" onclick="__calEdit(\'' + ev.id + '\')">' +
      '<span class="cal-ev-times"><span class="cal-ev-start">' + esc(fmtTime(ev.start)) + '</span>' +
        (ev.end ? '<span class="cal-ev-end">' + esc(fmtTime(ev.end)) + '</span>' : '') + '</span>' +
      '<span class="cal-ev-bar' + (ws ? ' ws-color-' + wsColorName(ws) : '') + '"></span>' +
      '<span class="cal-ev-main">' +
        (label ? '<span class="cal-ev-cat">' + esc(label) + '</span>' : '') +
        '<span class="cal-ev-title">' + esc(ev.title) + (ev.notify != null ? ' <span class="cal-ev-bell" title="Reminder set">🔔</span>' : '') + '</span>' +
      '</span></button>';
  }

  // Daily-note action + the day's room-activity list (merged daycal UI).
  // Empty string when the room surface isn't available (e.g. tests).
  function dayLinksHtml(selK) {
    var ra = Cade.roomsApi;
    if (!ra) return '';
    var exists = ra.list().indexOf(selK) !== -1;
    var html = '<div class="cal-day-links">' +
      '<button class="cal-note-btn" onclick="__calDayNote()" title="' +
        (exists ? 'Open room ' : 'Create room ') + esc(selK) + '">' +
        (exists ? 'Open daily note' : '＋ Daily note') + '</button>';
    var act = activityRooms(selK);
    if (act.length) {
      html += '<div class="cal-act-head">Rooms active</div><div class="cal-act-list">';
      for (var i = 0; i < act.length; i++) {
        var n = act[i];
        var ids = ra.workspaceIds(n) || [];
        var ws = ids.length ? ra.workspaceById(ids[0]) : null;
        // Room names come from the shared database — escape both the JS-string
        // quotes and the HTML special chars (same pattern as daycal/core tabs).
        var escAttr = esc(n.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        html += '<button class="cal-act-room" onclick="__calOpenRoom(\'' + escAttr + '\')">' +
          (ra.isPinned(n) ? '<span class="cal-act-pin">📌</span>' : '') +
          '<span class="cal-act-n">' + esc(n) + '</span>' +
          '<span class="cal-act-ws">' + esc(ws ? ws.name : 'Unlabeled') + '</span></button>';
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  // The workspace <option> list with `cur` selected ('' = None). Split out of
  // formHtml so __calWsRefresh can rebuild it in place from a fresh wsList().
  function wsOptionsHtml(cur) {
    var list = wsList();
    var opts = '', matched = !cur;
    if (list.length) {
      opts += '<option value=""' + (cur ? '' : ' selected') + '>— None —</option>';
      for (var i = 0; i < list.length; i++) {
        var w = list[i] || {};
        var id = String(w.id == null ? '' : w.id);
        if (!id) continue;
        if (id === cur) matched = true;
        opts += '<option value="' + esc(id) + '"' + (cur === id ? ' selected' : '') + '>' +
          esc(String(w.name == null ? '' : w.name) || 'Untitled') + '</option>';
      }
    } else {
      // No workspace surface (older core / none defined): a plain General
      // option, which stores an empty cat.
      opts += '<option value=""' + (cur ? '' : ' selected') + '>General</option>';
    }
    if (cur && !matched) {
      // A cat that is a deleted workspace or a legacy free-text category:
      // keep it selectable so an unrelated edit (time, title) doesn't
      // silently wipe it. Picking None/a workspace migrates it.
      opts = '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (legacy)</option>' + opts;
    }
    return opts;
  }

  function formHtml(draft) {
    var editing = form.id ? findEvent(form.id) : null;
    var f = draft || {
      date: editing ? editing.date : (sel || dateKey(new Date())),
      start: editing ? editing.start : '',
      end: editing ? editing.end : '',
      title: editing ? editing.title : '',
      cat: editing ? editing.cat : '',
      notify: (editing && editing.notify != null) ? String(editing.notify) : '',
    };
    // Category select = the user's workspaces (value = workspace id), rebuilt
    // fresh on every render AND again on interaction (see __calWsRefresh).
    var opts = wsOptionsHtml(f.cat);
    return '<div class="cal-form">' +
      '<div class="cal-f-row"><input type="date" id="cal-f-date" value="' + esc(f.date) + '"></div>' +
      '<div class="cal-f-row cal-f-times">' +
        '<input type="time" id="cal-f-start" title="Start" value="' + esc(f.start) + '">' +
        '<span class="cal-f-dash">&ndash;</span>' +
        '<input type="time" id="cal-f-end" title="End (optional)" value="' + esc(f.end) + '">' +
      '</div>' +
      '<div class="cal-f-row"><input type="text" id="cal-f-title" placeholder="Event title" maxlength="200" value="' + esc(f.title) + '"></div>' +
      '<div class="cal-f-row"><select id="cal-f-cat" title="Workspace"' +
        ' onpointerdown="__calWsRefresh()" onfocus="__calWsRefresh()" onkeydown="__calWsRefresh()">' + opts + '</select></div>' +
      '<div class="cal-f-row"><select id="cal-f-notify" title="Remind me">' +
        ['', '0', '10', '30', '60'].map(function (v) {
          var lbl = v === '' ? '🔕 No reminder' : v === '0' ? '🔔 Remind at start' : '🔔 Remind ' + v + ' min before';
          return '<option value="' + v + '"' + (String(f.notify) === v ? ' selected' : '') + '>' + lbl + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="cal-f-actions">' +
        (editing ? '<button class="cal-btn cal-btn-danger" onclick="__calDelete()">Delete</button>' : '') +
        '<span class="cal-f-spacer"></span>' +
        '<button class="cal-btn" onclick="__calCancel()">Cancel</button>' +
        '<button class="cal-btn cal-btn-primary" onclick="__calSave()">Save</button>' +
      '</div></div>';
  }

  function render() {
    var p = document.getElementById('cal-panel');
    if (!p) return;
    var body = p.querySelector('.cade-panel-body');
    if (!body) return;
    var draft = (form && !formFresh) ? captureDraft() : null;
    formFresh = false;
    var todayK = dateKey(new Date());
    var selK = sel || todayK;
    var head = selK === todayK ? 'Today'
      : new Date(selK + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    var evs = agenda(selK);
    var rows = '';
    for (var i = 0; i < evs.length; i++) rows += rowHtml(evs[i]);
    if (!rows) rows = '<div class="cal-none">No events</div>';
    body.innerHTML = '<div class="cal-wrap">' +
      monthHtml() +
      '<div class="cal-right">' +
        '<div class="cal-day-head">' + esc(head) + '</div>' +
        '<div class="cal-list">' + rows + '</div>' +
        dayLinksHtml(selK) +
        (form ? formHtml(draft)
              : '<button class="cal-add" onclick="__calAdd()">＋ Add event</button>') +
      '</div></div>';
  }

  // ---- inline-onclick handlers (window.__cal* — needed by rendered HTML) ---
  window.__calNav = function (delta) {
    var ref = month || new Date();
    month = new Date(ref.getFullYear(), ref.getMonth() + delta, 1);
    render();
  };
  window.__calPick = function (y, mo, d) {
    sel = dateKey(new Date(y, mo, d));
    if (form && !form.id) { // adding: picking a day retargets the form's date
      var el = document.getElementById('cal-f-date');
      if (el) el.value = sel;
    }
    render();
  };
  window.__calAdd = function () {
    form = { id: null };
    formFresh = true;
    render();
  };
  window.__calEdit = function (id) {
    var ev = findEvent(String(id || ''));
    if (!ev) return;
    form = { id: ev.id };
    formFresh = true;
    render();
  };
  window.__calCancel = function () { form = null; render(); };
  // Workspaces can appear/rename AFTER the form rendered (fresh-device sync
  // delivering the workspace blob, a workspace created while the form is
  // open) and core has no "workspaces changed" event — so the category select
  // rebuilds its options from a fresh wsList() right before each interaction
  // (pointerdown/focus, keydown for keyboard users), keeping the current
  // selection via its `selected` attribute (incl. the "(legacy)" option).
  window.__calWsRefresh = function () {
    var el = document.getElementById('cal-f-cat');
    if (!el) return;
    el.innerHTML = wsOptionsHtml(String(el.value == null ? '' : el.value));
  };
  window.__calSave = function () {
    if (!form) return;
    var date = gv('cal-f-date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Pick a date'); return; }
    var start = normTime(gv('cal-f-start'));
    if (!start) { toast('Set a start time'); return; }
    var end = normTime(gv('cal-f-end')); // optional
    var title = gv('cal-f-title').slice(0, 200);
    if (!title) { toast('Give the event a title'); return; }
    // cat = the selected workspace id ('' = none; may be a preserved legacy
    // value — see wsOptionsHtml). The stored color field is a best-effort
    // mapping of the workspace's color for OLDER devices; this code ignores it.
    var cat = gv('cal-f-cat').slice(0, 40);
    var ws = wsForCat(cat);
    var ev = form.id ? findEvent(form.id) : null;
    var color;
    if (ws) {
      color = WS_TO_HL[wsColorName(ws)];
    } else if (ev && cat === ev.cat) {
      // Unresolvable cat kept via the "(legacy)" option: an unrelated edit
      // (title/time) must not strip the color older clients still render.
      color = ev.color;
    } else {
      color = 'gray'; // none, or a new unresolvable value (not reachable via the UI)
    }
    var notifyRaw = gv('cal-f-notify');
    var notify = notifyRaw === '' ? null : Math.max(0, Math.min(1440, Math.round(+notifyRaw) || 0));
    if (ev) {
      ev.date = date; ev.start = start; ev.end = end;
      ev.title = title; ev.cat = cat; ev.color = color; ev.notify = notify;
    } else {
      state.events.push({ id: genId(), date: date, start: start, end: end, title: title, cat: cat, color: color, notify: notify });
    }
    state = normalize(state); // re-sort + enforce the event cap
    persist();
    sel = date;
    month = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, 1);
    form = null;
    render();
    if (Cade.showToast) Cade.showToast('Event saved', 'success', 1500);
  };
  window.__calDelete = function () {
    if (!form || !form.id) return;
    var kept = [];
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id !== form.id) kept.push(state.events[i]);
    }
    state.events = kept;
    persist();
    form = null;
    render();
  };
  // Nicety for future integrations (e.g. reminders): a day's agenda as copies.
  window.__calAgenda = function (dk) {
    var list = agenda(String(dk || ''));
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      out.push({ id: e.id, date: e.date, start: e.start, end: e.end, title: e.title, cat: e.cat, color: e.color });
    }
    return out;
  };
  // Open (or create, then open) the selected day's daily-note room.
  window.__calDayNote = function () {
    var ra = Cade.roomsApi;
    if (!ra) return;
    var key = sel || dateKey(new Date());
    if (ra.list().indexOf(key) === -1 && typeof ra.ensureRoom === 'function') {
      ra.ensureRoom(key); // register in the room list before the workspace jump
    }
    openDayRoom(ra, key);
    render(); // the room may now exist — flip the button + corner mark
  };
  // Open a room from the day's activity list.
  window.__calOpenRoom = function (name) {
    var ra = Cade.roomsApi;
    if (!ra) return;
    name = String(name == null ? '' : name);
    if (ra.list().indexOf(name) === -1) return; // stale row (renamed/removed)
    openDayRoom(ra, name);
  };

  // ---- open / register ----------------------------------------------------
  function open() {
    Cade.closeAllMenus();
    var existing = document.getElementById('cal-panel');
    if (existing) { existing.remove(); if (existing._onClose) existing._onClose(); return; }
    state = normalize(blobStore.get());
    var now = new Date();
    month = new Date(now.getFullYear(), now.getMonth(), 1);
    sel = dateKey(now);
    form = null;
    var p = Cade.mkPanel('cal-panel', '🗓 Calendar Events', '');
    p._onClose = function () { form = null; };
    render();
  }

  Cade.registerWidget({
    name: 'Calendar Events',
    description: 'Personal schedule: events synced across your devices',
    icon: '🗓',
    tags: 'calendar,events,schedule,agenda,planner,appointments',
    open: open,
  });
})();
