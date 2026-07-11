/* Rooms by Date (activity calendar) — browse rooms by the date they were last
   modified. No journaling, no document clobbering: clicking a date lists the
   rooms modified that day; clicking one opens its workspace + room.
   Extracted from txt.html into a lazily-loaded module (core slimming); the
   room system is reached through Cade.roomsApi. Core keeps only a thin
   window.openDailyNote shim that routes through the widget stub. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('daycal.css');
  var RA = Cade.roomsApi;
  var escapeHtml = Cade.escapeHtml;

  function _localDateKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function _roomActivityMap() {
    // dateKey -> [roomNames], from each room's last-modified (fallback created).
    const map = {};
    for (const name of RA.list()) {
      const m = RA.meta(name);
      const ts = m.modified || m.created;
      if (!ts) continue;
      const k = _localDateKey(ts);
      (map[k] = map[k] || []).push(name);
    }
    return map;
  }
  function _openRoomFromActivity(name) {
    // Jump into the room's own workspace (first membership) so its tab is visible.
    const ids = RA.workspaceIds(name) || [];
    const wsId = ids.length ? ids[0] : RA.WS_ALL;
    if (!RA.inWorkspace(name, RA.activeWorkspace()) && !RA.isPinned(name)) {
      RA.setActiveWorkspace(wsId);
    }
    RA.switchRoom(name);
  }
  window._openRoomFromActivity = _openRoomFromActivity;
  let _dayCalMonth = null;
  let _dayCalSel = null; // selected dateKey ('YYYY-MM-DD')
  function renderDayCal() {
    const p = document.getElementById('daycal-panel'); if (!p) return;
    const ref = _dayCalMonth || new Date();
    const y = ref.getFullYear(), mo = ref.getMonth();
    const first = new Date(y, mo, 1);
    const days = new Date(y, mo + 1, 0).getDate();
    const today = new Date();
    const act = _roomActivityMap();
    const monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });
    let grid = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => '<div class="daycal-cell dow">' + d + '</div>').join('');
    for (let i = 0; i < first.getDay(); i++) grid += '<div class="daycal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const date = new Date(y, mo, d);
      const key = _localDateKey(date.getTime());
      const isToday = date.toDateString() === today.toDateString();
      const sel = (_dayCalSel === key) ? ' sel' : '';
      grid += '<div class="daycal-cell' + (isToday ? ' today' : '') + (act[key] ? ' has' : '') + sel + '" onclick="dayCalPick(' + y + ',' + mo + ',' + d + ')">' + d + '</div>';
    }
    const selKey = _dayCalSel || _localDateKey(today.getTime());
    const selLabel = new Date(selKey + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const roomsOn = (act[selKey] || []).slice().sort((a, b) => (RA.modifiedAt(b) - RA.modifiedAt(a)));
    let listHtml;
    if (roomsOn.length) {
      listHtml = roomsOn.map(n => {
        const ids = RA.workspaceIds(n);
        const ws = ids.length ? RA.workspaceById(ids[0]) : null;
        const wsName = ws ? ws.name : 'Unlabeled';
        const escAttr = escapeHtml(n.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
        return '<button class="daycal-room" onclick="_openRoomFromActivity(\'' + escAttr + '\')">' +
          (RA.isPinned(n) ? '<span class="daycal-pin">📌</span>' : '') +
          '<span class="daycal-room-n">' + escapeHtml(n) + '</span>' +
          '<span class="daycal-room-ws">' + escapeHtml(wsName) + '</span></button>';
      }).join('');
    } else {
      listHtml = '<div class="daycal-empty">No rooms modified.</div>';
    }
    p.querySelector('.cade-panel-body').innerHTML =
      '<div class="daycal-head"><button onclick="dayCalNav(-1)">‹</button><span>' + monthName + '</span><button onclick="dayCalNav(1)">›</button></div>' +
      '<div class="daycal-grid">' + grid + '</div>' +
      '<div class="daycal-list-head">' + escapeHtml(selLabel) + '</div>' +
      '<div class="daycal-list">' + listHtml + '</div>';
  }
  window.dayCalNav = function (delta) {
    const ref = _dayCalMonth || new Date();
    _dayCalMonth = new Date(ref.getFullYear(), ref.getMonth() + delta, 1);
    renderDayCal();
  };
  window.dayCalPick = function (y, mo, d) { _dayCalSel = _localDateKey(new Date(y, mo, d).getTime()); renderDayCal(); };
  window.openDailyNote = function () {
    Cade.closeAllMenus();
    const existing = document.getElementById('daycal-panel');
    if (existing) { existing.remove(); return; }
    _dayCalMonth = new Date();
    _dayCalSel = _localDateKey(Date.now());
    Cade.mkPanel('daycal-panel', 'Rooms by Date', '');
    renderDayCal();
  };

  Cade.registerWidget({
    name: 'Daily Notes Calendar',
    description: 'Browse rooms by the date they changed',
    icon: '📅',
    tags: 'calendar,daily,date,journal,activity,rooms',
    open: function () { window.openDailyNote(); },
  });
})();
