/* Calendar Events — personal schedule manager. A month grid (Mon-first) on
   the left, the selected day's agenda on the right: each event shows its
   start/end times stacked in a muted column, a colored category bar, the
   category label and the event title. Events are added/edited through an
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
                   cat:     string    (category name, '' = none),
                   color:   string    (one of the 8 palette names) } ],
       cats:   { <name>: <color> }   (category -> palette color)
     }
   Everything is normalized defensively on read (fields/arrays may be missing
   or malformed after a partial sync). This widget is separate from the
   daycal (Rooms by Date) widget — all ids/classes are cal-*.

   window.__calAgenda(dateKey) returns that day's events (copies), exposed for
   a future reminders integration. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('calendar.css');
  var esc = Cade.escapeHtml;

  // The 8 app-wide highlight palette names (rendered via --hl-* CSS vars).
  var PALETTE = ['yellow', 'green', 'blue', 'red', 'pink', 'purple', 'orange', 'gray'];
  var MAX_EVENTS = 1000;

  // ---- module state -------------------------------------------------------
  var state = { events: [], cats: {} };
  var month = null;        // Date pinned to the 1st of the displayed month
  var sel = null;          // selected dateKey 'YYYY-MM-DD'
  var form = null;         // null | { id: string|null } (null id = adding)
  var formColor = 'blue';  // swatch-picked color for a new category
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
      out.events.push({
        id: id,
        date: date,
        start: normTime(e.start) || '00:00',
        end: normTime(e.end),
        title: String(e.title == null ? '' : e.title).slice(0, 200) || '(untitled)',
        cat: String(e.cat == null ? '' : e.cat).slice(0, 40),
        color: normColor(e.color),
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

  // ---- rendering ----------------------------------------------------------
  // Preserve typed form values across re-renders (day picks, remote syncs).
  function captureDraft() {
    if (!form || !document.getElementById('cal-f-title')) return null;
    return {
      date: gv('cal-f-date'), start: gv('cal-f-start'), end: gv('cal-f-end'),
      title: gv('cal-f-title'), cat: gv('cal-f-cat'), newname: gv('cal-f-newname'),
    };
  }

  function monthHtml() {
    var ref = month || new Date();
    var y = ref.getFullYear(), mo = ref.getMonth();
    var days = new Date(y, mo + 1, 0).getDate();
    var off = (new Date(y, mo, 1).getDay() + 6) % 7; // Mon-first
    var todayK = dateKey(new Date());
    var monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });
    var byDay = {};
    for (var i = 0; i < state.events.length; i++) byDay[state.events[i].date] = 1;
    var dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var grid = '';
    for (var w = 0; w < 7; w++) grid += '<div class="cal-cell cal-dow">' + dow[w] + '</div>';
    for (var b = 0; b < off; b++) grid += '<div class="cal-cell cal-empty"></div>';
    for (var d = 1; d <= days; d++) {
      var key = y + '-' + p2(mo + 1) + '-' + p2(d);
      var cls = 'cal-cell cal-day' +
        (key === todayK ? ' today' : '') +
        (key === sel ? ' sel' : '') +
        (byDay[key] ? ' has' : '');
      grid += '<div class="' + cls + '" onclick="__calPick(' + y + ',' + mo + ',' + d + ')"><span class="cal-n">' + d + '</span></div>';
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
    return '<button class="cal-ev" onclick="__calEdit(\'' + ev.id + '\')">' +
      '<span class="cal-ev-times"><span class="cal-ev-start">' + esc(fmtTime(ev.start)) + '</span>' +
        (ev.end ? '<span class="cal-ev-end">' + esc(fmtTime(ev.end)) + '</span>' : '') + '</span>' +
      '<span class="cal-ev-bar cal-c-' + ev.color + '"></span>' +
      '<span class="cal-ev-main">' +
        (ev.cat ? '<span class="cal-ev-cat">' + esc(ev.cat) + '</span>' : '') +
        '<span class="cal-ev-title">' + esc(ev.title) + '</span>' +
      '</span></button>';
  }

  function formHtml(draft) {
    var editing = form.id ? findEvent(form.id) : null;
    var catNames = [];
    for (var k in state.cats) if (Object.prototype.hasOwnProperty.call(state.cats, k)) catNames.push(k);
    var defCat = editing
      ? (editing.cat && state.cats[editing.cat] ? 'c:' + editing.cat : 'new')
      : (catNames.length ? 'c:' + catNames[0] : 'new');
    var f = draft || {
      date: editing ? editing.date : (sel || dateKey(new Date())),
      start: editing ? editing.start : '',
      end: editing ? editing.end : '',
      title: editing ? editing.title : '',
      cat: defCat,
      newname: (editing && !editing.cat) ? '' : (editing ? editing.cat : ''),
    };
    if (draft && !draft.cat) f.cat = defCat;
    var opts = '';
    for (var i = 0; i < catNames.length; i++) {
      var n = catNames[i];
      opts += '<option value="c:' + esc(n) + '"' + (f.cat === 'c:' + n ? ' selected' : '') + '>' + esc(n) + '</option>';
    }
    opts += '<option value="new"' + (f.cat === 'new' ? ' selected' : '') + '>New…</option>';
    var sw = '';
    for (var c = 0; c < PALETTE.length; c++) {
      var col = PALETTE[c];
      sw += '<button type="button" class="cal-sw cal-c-' + col + (formColor === col ? ' on' : '') + '"' +
        ' title="' + col + '" onclick="__calPickColor(\'' + col + '\')"></button>';
    }
    return '<div class="cal-form">' +
      '<div class="cal-f-row"><input type="date" id="cal-f-date" value="' + esc(f.date) + '"></div>' +
      '<div class="cal-f-row cal-f-times">' +
        '<input type="time" id="cal-f-start" title="Start" value="' + esc(f.start) + '">' +
        '<span class="cal-f-dash">&ndash;</span>' +
        '<input type="time" id="cal-f-end" title="End (optional)" value="' + esc(f.end) + '">' +
      '</div>' +
      '<div class="cal-f-row"><input type="text" id="cal-f-title" placeholder="Event title" maxlength="200" value="' + esc(f.title) + '"></div>' +
      '<div class="cal-f-row"><select id="cal-f-cat" onchange="__calCatChange()">' + opts + '</select></div>' +
      '<div id="cal-f-newcat" class="cal-f-newcat"' + (f.cat === 'new' ? '' : ' style="display:none"') + '>' +
        '<input type="text" id="cal-f-newname" placeholder="Category name" maxlength="40" value="' + esc(f.newname) + '">' +
        '<div class="cal-f-swatches" id="cal-f-swatches">' + sw + '</div>' +
      '</div>' +
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
    formColor = 'blue';
    formFresh = true;
    render();
  };
  window.__calEdit = function (id) {
    var ev = findEvent(String(id || ''));
    if (!ev) return;
    form = { id: ev.id };
    formColor = ev.color;
    formFresh = true;
    render();
  };
  window.__calCancel = function () { form = null; render(); };
  window.__calCatChange = function () {
    var s = document.getElementById('cal-f-cat');
    var nc = document.getElementById('cal-f-newcat');
    if (s && nc && nc.style) nc.style.display = (s.value === 'new') ? '' : 'none';
  };
  window.__calPickColor = function (c) {
    if (PALETTE.indexOf(c) === -1) return;
    formColor = c;
    var box = document.getElementById('cal-f-swatches');
    if (box && box.querySelectorAll) {
      var sws = box.querySelectorAll('.cal-sw');
      for (var i = 0; i < sws.length; i++) {
        sws[i].classList.toggle('on', sws[i].classList.contains('cal-c-' + c));
      }
    }
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
    var catSel = gv('cal-f-cat');
    var cat = '', color = 'blue';
    if (catSel.indexOf('c:') === 0 && state.cats[catSel.slice(2)]) {
      cat = catSel.slice(2);
      color = state.cats[cat];
    } else { // 'New…' (an empty name = no category, colored as picked)
      cat = gv('cal-f-newname').slice(0, 40);
      color = formColor;
      if (cat) state.cats[cat] = color;
    }
    var ev = form.id ? findEvent(form.id) : null;
    if (ev) {
      ev.date = date; ev.start = start; ev.end = end;
      ev.title = title; ev.cat = cat; ev.color = color;
    } else {
      state.events.push({ id: genId(), date: date, start: start, end: end, title: title, cat: cat, color: color });
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
