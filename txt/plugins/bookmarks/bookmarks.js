/* Line Bookmarks — mark lines and hop between them.
 *
 *   Ctrl/Cmd+F2   toggle a bookmark on the caret's line (every cursor's line)
 *   F2 / Shift+F2 jump to the next / previous bookmark (wraps around)
 *   Palette       "Bookmarks" (list with line previews, click to jump, remove,
 *                 clear all), "Toggle Bookmark", "Next Bookmark",
 *                 "Previous Bookmark"
 *   Gutter        a bookmarked line's number is drawn as an accent tab; click
 *                 it to remove the bookmark. Long-press any line number
 *                 (touch or mouse) toggles one.
 * Alt+↑/↓ are taken (move line) and Alt+letter types characters on macOS,
 * hence F2. Bookmarked lines also get a thin accent bar at their left edge,
 * which is what shows them while line numbers are hidden (the core hides
 * the whole gutter then).
 *
 * Bookmarks live in a StateField of line-start positions, so they follow
 * edits live: text inserted above shifts them, Enter at the start of a line
 * carries its bookmark down with the text, and deleting a line (its text plus
 * a line break) deletes its bookmark. A line that is cut and re-inserted in
 * the same edit (move line up/down, a script or sync rewriting the doc) is
 * found again by its text. Each room keeps its own set (the core rebuilds the
 * editor state per room): persisted in Cade.store as line number + text hash
 * + length, and restored on room open — the stored line if its text still
 * matches, else the nearest line with the same text, else the old line
 * number. Capped at 200 bookmarks per room and 60 rooms (least recently
 * changed dropped first).
 *
 * The gutter tab uses the bundle's gutterLineClass facet (Cade.CM, exported
 * for plugins); StateField / StateEffect fall back to the classes behind
 * history() / scrollIntoView() on an older core. Self-contained IIFE. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.EditorView || !CM.keymap) return;
  var EditorView = CM.EditorView, Decoration = CM.Decoration, ViewPlugin = CM.ViewPlugin;
  var StateField = CM.StateField, StateEffect = CM.StateEffect;
  if (!StateField || !StateEffect) {
    try {
      StateField = CM.history()[0].constructor;
      StateEffect = EditorView.scrollIntoView(0).constructor;
      if (typeof StateField.define !== 'function' || typeof StateEffect.define !== 'function') StateField = StateEffect = null;
    } catch (e) { StateField = StateEffect = null; }
  }
  if (!StateField || !StateEffect) return;
  Cade.loadCSS('bookmarks.css');

  var KEY = 'cade-bookmarks';
  var MAX_MARKS = 200, MAX_ROOMS = 60, SAVE_MS = 700, LONG_MS = 500;
  var PANEL_ID = 'bm-panel';

  function toast(m, type, ms) { try { Cade.showToast(m, type || 'info', ms || 1600); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s == null ? '' : s)); }
  function fine() { try { return window.matchMedia('(pointer: fine)').matches; } catch (e) { return true; } }
  // FNV-1a, base 36: enough to recognise a line's text again.
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function roomName() {
    try { var r = Cade.roomsApi && Cade.roomsApi.activeRoom(); return r ? String(r) : '(local)'; } catch (e) { return '(local)'; }
  }
  function sortNum(a, b) { return a - b; }
  // Sorted, unique, capped.
  function norm(arr) {
    arr.sort(sortNum);
    var out = [];
    for (var i = 0; i < arr.length && out.length < MAX_MARKS; i++) if (!out.length || arr[i] !== out[out.length - 1]) out.push(arr[i]);
    return out;
  }

  // ---- persistence: { v, rooms: { <room>: { t, m: [[line, hash, len], …] } } } ----------
  function loadAll() {
    try {
      var o = JSON.parse(Cade.store.get(KEY) || 'null');
      if (o && typeof o === 'object' && o.rooms && typeof o.rooms === 'object') return o;
    } catch (e) {}
    return { v: 1, rooms: {} };
  }
  function loadRoom(room) {
    var e = loadAll().rooms[room];
    return e && Array.isArray(e.m) ? e.m : [];
  }
  var lastSaved = {}; // room → JSON last written (skips identical writes)
  function saveRoom(room, list) {
    var str = JSON.stringify(list);
    if (lastSaved[room] === str) return;
    lastSaved[room] = str;
    var all = loadAll(), rooms = all.rooms;
    if (list.length) rooms[room] = { t: Date.now(), m: list }; else delete rooms[room];
    var names = Object.keys(rooms);
    if (names.length > MAX_ROOMS) {
      names.sort(function (a, b) { return ((rooms[a] && rooms[a].t) || 0) - ((rooms[b] && rooms[b].t) || 0); });
      for (var i = 0; i < names.length - MAX_ROOMS; i++) delete rooms[names[i]];
    }
    try {
      if (Object.keys(rooms).length) Cade.store.set(KEY, JSON.stringify({ v: 1, rooms: rooms }));
      else Cade.store.remove(KEY);
    } catch (e) {}
  }
  function serialize(doc, marks) {
    return marks.map(function (p) { var l = doc.lineAt(p); return [l.number, hash(l.text), l.length]; });
  }
  // Saved [[line, hash, len]] → positions in `doc`: the same line if its text
  // still matches, else the nearest line with that text, else the old number.
  function restore(doc, saved) {
    var out = [], miss = [], i;
    for (i = 0; i < saved.length && i < MAX_MARKS; i++) {
      var s = saved[i];
      if (!Array.isArray(s) || !(+s[0] >= 1)) continue;
      var n = Math.floor(+s[0]), h = String(s[1] || ''), len = +s[2];
      if (n <= doc.lines && hash(doc.line(n).text) === h) out.push(doc.line(n).from);
      else miss.push({ n: n, h: h, len: isFinite(len) ? len : -1 });
    }
    if (!miss.length) return norm(out);
    var want = {}, lens = {}, at = {}, used = {};
    miss.forEach(function (m) { want[m.h] = 1; lens[m.len] = 1; });
    // One pass over the doc, hashing only lines of a wanted length.
    if (doc.length <= 5e6) {
      var ln = 1;
      for (var it = doc.iterLines(); !it.next().done; ln++) {
        var t = it.value;
        if (!lens[t.length] && !lens[-1]) continue;
        var hh = hash(t);
        if (want[hh]) (at[hh] || (at[hh] = [])).push(ln);
      }
    }
    out.forEach(function (p) { used[doc.lineAt(p).number] = 1; });
    miss.forEach(function (m) {
      var c = at[m.h], best = 0, bd = Infinity;
      if (c) for (var k = 0; k < c.length; k++) {
        var d = Math.abs(c[k] - m.n);
        if (d < bd && !used[c[k]]) { bd = d; best = c[k]; }
      }
      if (!best) best = Math.min(m.n, doc.lines);
      used[best] = 1;
      out.push(doc.line(best).from);
    });
    return norm(out);
  }

  // ---- mapping through edits ----------------------------------------------------------------
  // A bookmark is the start of its line and maps like a cursor that sticks to
  // the text after it (Enter at the start of the line carries it down).
  // Deleting a line removes its bookmark: a change that wipes out k line
  // breaks removes k of the lines whose text it fully covers (lines with text
  // first, then empty ones), so deleting a line never takes the empty line
  // below it along. A removed line whose text this same transaction inserts
  // elsewhere (move line up/down, a script or a sync rewriting the doc) is
  // found again by its text, nearest copy first; so is a line whose content a
  // replacement rewrote, which otherwise just keeps its place.
  function goneLines(od, c) {
    if (c.gone) return c.gone;
    var g = {}, a = od.lineAt(c.fa), b = od.lineAt(c.ta), need = b.number - a.number, n, l;
    var first = a.from >= c.fa ? a.number : a.number + 1, last = b.to <= c.ta ? b.number : b.number - 1;
    if (last - first > 200000) { for (n = first; n <= last; n++) g[n] = 1; return (c.gone = g); }
    for (n = first; n <= last && need > 0; n++) { l = od.line(n); if (l.length) { g[n] = 1; need--; } }
    for (n = first; n <= last && need > 0; n++) { l = od.line(n); if (!l.length) { g[n] = 1; need--; } }
    return (c.gone = g);
  }
  function mapMarks(marks, tr) {
    var od = tr.startState.doc, nd = tr.state.doc, ch = tr.changes, cs = [], ins = [];
    ch.iterChanges(function (fa, ta, fb, tb) { cs.push({ fa: fa, ta: ta, fb: fb, tb: tb, gone: null }); if (tb > fb) ins.push([fb, tb]); });
    var out = [], lost = [], same = true, ci = 0, i, j;
    for (i = 0; i < marks.length; i++) {
      var p = marks[i], L = od.lineAt(p), q = nd.lineAt(ch.mapPos(p, 1)).from;
      while (ci < cs.length && cs[ci].ta < L.to) ci++;
      var c = cs[ci];
      if (!c || c.ta === c.fa || c.fa > L.from || c.ta < L.to) { // not wholly covered: just map
        if (q !== p) same = false;
        out.push(q);
        continue;
      }
      same = false;
      var gone = goneLines(od, c)[L.number] === 1;
      if (gone && !ins.length) continue;
      // `near`: the same offset inside the rewritten span (a whole-doc rewrite
      // keeps every line where it was when its text is unchanged)
      if (gone || c.tb > c.fb) lost.push({ text: L.text, near: c.fb + Math.min(p - c.fa, c.tb - c.fb), keep: gone ? -1 : q });
      else out.push(q);
    }
    if (same) return marks;
    if (lost.length) {
      var want = {}, at = {}, budget = 100000;
      lost.forEach(function (l) { want[l.text] = 1; });
      for (i = 0; i < ins.length && budget > 0; i++) {
        var a = nd.lineAt(ins[i][0]).number, b = nd.lineAt(ins[i][1]).number;
        for (j = a; j <= b && budget-- > 0; j++) {
          var ln = nd.line(j);
          if (want[ln.text] === 1) (at[ln.text] || (at[ln.text] = [])).push(ln.from);
        }
      }
      lost.forEach(function (l) {
        var c2 = at[l.text], best = -1, bd = Infinity;
        if (c2) for (var k = 0; k < c2.length; k++) {
          var d = Math.abs(c2[k] - l.near);
          if (d < bd && out.indexOf(c2[k]) < 0) { bd = d; best = c2[k]; }
        }
        if (best < 0) best = l.keep;
        if (best >= 0) out.push(best);
      });
    }
    return norm(out);
  }

  // ---- state ----------------------------------------------------------------------------------
  var toggleFx = StateEffect.define({ map: function (v, m) { return m.mapPos(v, 1); } }); // a position: its line toggles
  var setFx = StateEffect.define();                                                       // positions: replace all

  var LINE = Decoration.line({ class: 'cm-bm-line' });
  var GM = null;
  if (CM.GutterMarker && CM.gutterLineClass && CM.RangeSet) {
    // ES5 subclass of the bundle's GutterMarker (no constructor state; its
    // compare() uses constructor + eq()). elementClass lands on every gutter
    // element of the line — the CSS styles the line-number one.
    var BmGutter = function () {};
    BmGutter.prototype = Object.create(CM.GutterMarker.prototype);
    BmGutter.prototype.constructor = BmGutter;
    BmGutter.prototype.elementClass = 'cm-bm-g';
    BmGutter.prototype.eq = function (o) { return o instanceof BmGutter; };
    GM = new BmGutter();
  }

  function mk(room, marks) {
    return {
      room: room, marks: marks,
      deco: marks.length ? Decoration.set(marks.map(function (p) { return LINE.range(p); })) : Decoration.none,
      gm: GM ? CM.RangeSet.of(marks.map(function (p) { return GM.range(p); })) : null,
    };
  }
  function toggleAt(marks, doc, pos) {
    if (pos < 0 || pos > doc.length) return marks;
    var p = doc.lineAt(pos).from, i = marks.indexOf(p), out = marks.slice();
    if (i >= 0) out.splice(i, 1);
    else if (marks.length >= MAX_MARKS) { toast('Bookmark limit reached (' + MAX_MARKS + ')', 'error'); return marks; }
    else { out.push(p); out.sort(sortNum); }
    return out;
  }

  var field = StateField.define({
    create: function (st) {
      var room = roomName(), marks = [];
      try { marks = restore(st.doc, loadRoom(room)); } catch (e) { marks = []; }
      return mk(room, marks);
    },
    update: function (v, tr) {
      var marks = v.marks;
      if (tr.docChanged && marks.length) marks = mapMarks(marks, tr);
      for (var i = 0; i < tr.effects.length; i++) {
        var e = tr.effects[i];
        if (e.is(toggleFx)) marks = toggleAt(marks, tr.state.doc, e.value);
        else if (e.is(setFx)) marks = norm(e.value.filter(function (p) { return p >= 0 && p <= tr.state.doc.length; }).map(function (p) { return tr.state.doc.lineAt(p).from; }));
      }
      return marks === v.marks ? v : mk(v.room, marks);
    },
    provide: function (f) {
      var out = [EditorView.decorations.from(f, function (v) { return v.deco; })];
      if (GM) out.push(CM.gutterLineClass.from(f, function (v) { return v.gm; }));
      return out;
    },
  });

  // ---- commands --------------------------------------------------------------------------------
  function marksOf(view) { var v = view && view.state.field(field, false); return v ? v.marks : null; }
  function offMsg() { toast('Line Bookmarks is off \u2014 Settings \u2192 Editor', 'info', 2400); }
  function goTo(view, pos, focus) {
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select' });
    if (focus) view.focus();
  }
  function toggle(view, quiet) {
    var marks = marksOf(view);
    if (!marks) { offMsg(); return true; }
    var st = view.state, seen = {}, fx = [];
    st.selection.ranges.forEach(function (r) {
      var l = st.doc.lineAt(r.head);
      if (!seen[l.from]) { seen[l.from] = 1; fx.push(toggleFx.of(l.from)); }
    });
    view.dispatch({ effects: fx });
    if (!quiet && fx.length === 1) {
      var l = st.doc.lineAt(st.selection.main.head), on = marksOf(view).indexOf(l.from) >= 0;
      toast(on ? 'Bookmarked line ' + l.number + ' \u00b7 F2 / Shift+F2 to jump' : 'Bookmark removed', on ? 'success' : 'info', 1400);
    }
    try { Cade.haptic(10); } catch (e) {}
    return true;
  }
  function jump(view, dir, focus) {
    var marks = marksOf(view);
    if (!marks) { offMsg(); return true; }
    if (!marks.length) { toast('No bookmarks yet \u2014 Ctrl/Cmd+F2 adds one', 'info', 2000); return true; }
    var cur = view.state.doc.lineAt(view.state.selection.main.head).from, t = -1, i;
    if (dir > 0) { for (i = 0; i < marks.length; i++) if (marks[i] > cur) { t = marks[i]; break; } if (t < 0) t = marks[0]; }
    else { for (i = marks.length - 1; i >= 0; i--) if (marks[i] < cur) { t = marks[i]; break; } if (t < 0) t = marks[marks.length - 1]; }
    goTo(view, t, focus);
    return true;
  }
  function clearAll(view) {
    var marks = marksOf(view);
    if (!marks || !marks.length) return;
    if (!window.confirm('Remove all ' + marks.length + ' bookmark' + (marks.length === 1 ? '' : 's') + ' in this room?')) return;
    view.dispatch({ effects: setFx.of([]) });
  }

  var keys = CM.keymap.of([
    { key: 'Mod-F2', run: function (v) { return toggle(v); } },
    { key: 'F2', run: function (v) { return jump(v, 1); } },
    { key: 'Shift-F2', run: function (v) { return jump(v, -1); } },
  ]);

  // ---- panel ----------------------------------------------------------------------------------
  var panelTimer = 0;
  function panelOpen() { return !!document.getElementById(PANEL_ID); }
  function schedulePanel() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(renderPanel, 200);
  }
  function preview(t) {
    t = t.replace(/\s+/g, ' ').trim();
    return t ? (t.length > 140 ? t.slice(0, 140) + '\u2026' : t) : '';
  }
  function renderPanel() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var body = p.querySelector('.bm-body');
    if (!body) return;
    var ed = Cade.editor, marks = marksOf(ed), html = '';
    var room = roomName();
    if (!marks) {
      body.innerHTML = '<div class="bm-empty">Line Bookmarks is turned off. Turn it on in Settings \u2192 Editor.</div>';
      return;
    }
    html += '<div class="bm-bar"><span class="bm-room" title="' + esc(room) + '">' + esc(room) + '</span>' +
      '<span class="bm-count">' + marks.length + '</span><span class="bm-sp"></span>' +
      '<button type="button" class="bm-btn" data-act="toggle" title="Toggle a bookmark on the caret\u2019s line">\u2295 Caret line</button>' +
      (marks.length ? '<button type="button" class="bm-btn bm-btn-danger" data-act="clear">Clear all</button>' : '') + '</div>';
    if (!marks.length) {
      html += '<div class="bm-empty">No bookmarks in this room yet.<br><b>Ctrl/Cmd+F2</b> toggles one on the caret\u2019s line, <b>F2</b> / <b>Shift+F2</b> jump between them. On touch: long-press a line number.</div>';
    } else {
      var doc = ed.state.doc, cur = doc.lineAt(ed.state.selection.main.head).from;
      html += '<div class="bm-list">';
      for (var i = 0; i < marks.length; i++) {
        var l = doc.lineAt(marks[i]), pv = preview(l.text);
        html += '<div class="bm-row' + (marks[i] === cur ? ' on' : '') + '">' +
          '<button type="button" class="bm-go" data-i="' + i + '"><span class="bm-ln">' + l.number + '</span>' +
          '<span class="bm-txt' + (pv ? '' : ' bm-blank') + '">' + esc(pv || '(empty line)') + '</span></button>' +
          '<button type="button" class="bm-x" data-del="' + i + '" title="Remove bookmark" aria-label="Remove bookmark on line ' + l.number + '">\u00d7</button></div>';
      }
      html += '</div>';
    }
    body.innerHTML = html;
  }
  function onPanelClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('button') : null, ed = Cade.editor;
    if (!t || !ed) return;
    var marks = marksOf(ed) || [];
    if (t.hasAttribute('data-i')) {
      var p = marks[+t.getAttribute('data-i')];
      if (p != null) goTo(ed, p, fine());
    } else if (t.hasAttribute('data-del')) {
      var q = marks[+t.getAttribute('data-del')];
      if (q != null) ed.dispatch({ effects: toggleFx.of(q) });
    } else if (t.getAttribute('data-act') === 'toggle') {
      toggle(ed, true);
    } else if (t.getAttribute('data-act') === 'clear') {
      clearAll(ed);
    }
    renderPanel();
  }
  function openPanel() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) { ex.remove(); if (ex._onClose) ex._onClose(); return; }
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udd16 Bookmarks', '<div class="bm-body"></div>');
    p.querySelector('.bm-body').addEventListener('click', onPanelClick);
    p._onClose = function () { clearTimeout(panelTimer); };
    renderPanel();
  }

  // ---- view: persistence + gutter gestures ----------------------------------------------------
  function BmView(view) {
    this.view = view;
    this.pending = null; // state whose bookmarks still need saving
    this.timer = 0;
    this.lp = null;      // long-press { x, y, timer }
    this.fired = false;  // a long-press just toggled: swallow its click
    var self = this;
    this.onDown = function (e) { self.down(e); };
    this.onUp = function () { self.cancelLP(); };
    this.onMove = function (e) {
      if (self.lp && (Math.abs(e.clientX - self.lp.x) > 8 || Math.abs(e.clientY - self.lp.y) > 8)) self.cancelLP();
    };
    this.onClick = function (e) { self.click(e); };
    this.onMenu = function (e) { if (self.fired && inGutter(e.target)) e.preventDefault(); };
    this.onHide = function () { if (document.visibilityState === 'hidden') self.flush(); };
    this.onPageHide = function () { self.flush(); };
    var d = view.dom;
    d.addEventListener('pointerdown', this.onDown);
    d.addEventListener('pointerup', this.onUp);
    d.addEventListener('pointercancel', this.onUp);
    d.addEventListener('pointermove', this.onMove);
    d.addEventListener('click', this.onClick, true);
    d.addEventListener('contextmenu', this.onMenu);
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onPageHide);
    if (panelOpen()) schedulePanel(); // a room switch rebuilt the view
  }
  function inGutter(t) { return !!(t && t.closest && t.closest('.cm-gutters')); }

  BmView.prototype.update = function (u) {
    var a = u.startState.field(field, false), b = u.state.field(field, false);
    if (b && a !== b) {
      this.pending = u.state;
      var self = this;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.flush(); }, SAVE_MS);
    }
    if (panelOpen() && (a !== b || u.docChanged)) schedulePanel();
  };
  BmView.prototype.flush = function () {
    clearTimeout(this.timer);
    var st = this.pending;
    this.pending = null;
    var v = st && st.field(field, false);
    if (v) { try { saveRoom(v.room, serialize(st.doc, v.marks)); } catch (e) {} }
  };
  BmView.prototype.lineAtY = function (y) {
    var view = this.view;
    try { return view.state.doc.lineAt(view.lineBlockAtHeight(y - view.documentTop).from); } catch (e) { return null; }
  };
  BmView.prototype.down = function (e) {
    this.cancelLP();
    this.fired = false;
    if (!inGutter(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var self = this, x = e.clientX, y = e.clientY;
    this.lp = {
      x: x, y: y,
      timer: setTimeout(function () {
        self.lp = null;
        var l = self.lineAtY(y);
        if (!l || !self.view.state.field(field, false)) return;
        self.fired = true;
        self.view.dispatch({ effects: toggleFx.of(l.from) });
        try { Cade.haptic(15); } catch (x2) {}
        var on = (marksOf(self.view) || []).indexOf(l.from) >= 0;
        toast(on ? 'Bookmarked line ' + l.number : 'Bookmark removed', on ? 'success' : 'info', 1200);
      }, LONG_MS),
    };
  };
  BmView.prototype.cancelLP = function () {
    if (this.lp) { clearTimeout(this.lp.timer); this.lp = null; }
  };
  BmView.prototype.click = function (e) {
    if (!inGutter(e.target)) return;
    if (this.fired) { this.fired = false; e.preventDefault(); e.stopPropagation(); return; }
    var el = e.target.closest('.cm-gutterElement');
    if (!el || !el.classList.contains('cm-bm-g')) return;
    var l = this.lineAtY(e.clientY);
    if (!l || (marksOf(this.view) || []).indexOf(l.from) < 0) return;
    e.preventDefault();
    this.view.dispatch({ effects: toggleFx.of(l.from) });
    toast('Bookmark removed', 'info', 1200);
  };
  BmView.prototype.destroy = function () {
    this.flush();
    this.cancelLP();
    var d = this.view.dom;
    d.removeEventListener('pointerdown', this.onDown);
    d.removeEventListener('pointerup', this.onUp);
    d.removeEventListener('pointercancel', this.onUp);
    d.removeEventListener('pointermove', this.onMove);
    d.removeEventListener('click', this.onClick, true);
    d.removeEventListener('contextmenu', this.onMenu);
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onPageHide);
  };
  var viewPlugin = ViewPlugin.fromClass(BmView);

  // ---- palette rows (registered here, not in the manifest: they exist only
  //      while the plugin is loaded) -------------------------------------------------------------
  function withEditor(fn) {
    return function () {
      var ed = Cade.editor;
      if (!ed) return;
      fn(ed);
    };
  }
  Cade.registerWidget({
    name: 'Bookmarks', description: 'Bookmarked lines of this room \u2014 click to jump, remove, clear all',
    icon: '\ud83d\udd16', tags: 'bookmark,bookmarks,mark,line,jump,goto,navigate,f2', open: openPanel,
  });
  Cade.registerWidget({
    name: 'Toggle Bookmark', description: 'Bookmark the caret\u2019s line, or remove its bookmark (Ctrl/Cmd+F2)',
    icon: '\ud83d\udccc', tags: 'bookmark,toggle,mark,line,pin',
    open: withEditor(function (ed) { toggle(ed); if (fine()) ed.focus(); }),
  });
  Cade.registerWidget({
    name: 'Next Bookmark', description: 'Jump to the next bookmarked line (F2)',
    icon: '\u2b07\ufe0f', tags: 'bookmark,next,jump,goto,line,navigate',
    open: withEditor(function (ed) { jump(ed, 1, fine()); }),
  });
  Cade.registerWidget({
    name: 'Previous Bookmark', description: 'Jump to the previous bookmarked line (Shift+F2)',
    icon: '\u2b06\ufe0f', tags: 'bookmark,previous,prev,jump,goto,line,navigate',
    open: withEditor(function (ed) { jump(ed, -1, fine()); }),
  });

  Cade.registerPlugin({ id: 'bookmarks', ext: [field, viewPlugin, keys] });
})();
