/* Digest & Todo for Cade.txt — two rooms that work as one capture system.
 *
 *   digest  Type anything. When you leave the room it is filed into the todo
 *           room — grouped, tagged and stamped — and the digest room is
 *           cleared, ready for the next batch. Ctrl/⌘+D (or the pill's
 *           "Digest now") files it without leaving. Nothing is cleared while
 *           you're still in the room otherwise.
 *   todo    A checklist over the room's text: stats, collapsible groups,
 *           search, filters by tag / when it was added / workspace / room,
 *           inline edit, move, delete, an undo bar. A List | Text pill shows
 *           the raw "[ GROUP ]" / "[ ] entry" text, which stays the only
 *           source of truth — every change is an ordinary edit of it, so
 *           sync, undo and snapshots treat it like typing.
 *   @digest In any other room, an "@digest" line sends the lines under it to
 *           the todo room the same way (see digest-core.js for where a block
 *           ends). A border shows what will go; its chip files it now.
 *
 * The format (groups, entries, tags, the metadata suffix) is documented in
 * digest-core.js, the pure model this file loads first. Tags: ¥tag or #tag
 * (filed with the tag sentinel); "yy" at the start of a word types ¥.
 *
 * Safety: the source is cleared first (one editor transaction — Ctrl+Z
 * brings it back) and the job is journalled in localStorage until the todo
 * room has it. If the todo room can't take it (offline and not on this
 * device, locked, read-only…) the text is put back where it was. A journal
 * entry left by a crash is filed on the next start; filing is idempotent
 * (the same capture is never added twice) and entries already open in the
 * same group are skipped (Widget preferences → Digest & Todo). All writes go
 * through Cade.roomsApi.write, which merges with edits from other devices.
 *
 * Room / prefs: Widget preferences → Digest & Todo (room names, @digest,
 * duplicates, list view, metadata, done stamps, yy → ¥).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.ViewPlugin || !CM.Decoration || !CM.WidgetType || !CM.EditorView) return;
  Cade.loadCSS('digest.css');
  var CORE_URL = Cade.asset('digest-core.js');

  var ViewPlugin = CM.ViewPlugin, Decoration = CM.Decoration, WidgetType = CM.WidgetType, EditorView = CM.EditorView;
  var ID = 'digest', SETTING = 'plugins.digest';
  var YEN = '¥';
  var ANDROID = /Android\b/.test(navigator.userAgent || '');
  var IS_MAC = String(navigator.platform || '').toUpperCase().indexOf('MAC') >= 0;
  var MOD = IS_MAC ? '⌘' : 'Ctrl';
  var D = null;                                  // digest-core.js, once loaded

  var MODE_KEY = 'cade-digest-mode';             // 'list' | 'text', per device
  var FOLDS_KEY = 'cade-digest-folds';           // { GROUP: 1 } folded in the list
  var VIEW_KEY = 'cade-digest-view';             // { status, filtersOpen }
  var JOURNAL_KEY = 'cade-digest-journal';       // jobs not yet filed

  function loadCore() {
    if (window.__cadeDigestCore) return Promise.resolve(window.__cadeDigestCore);
    if (!window.__cadeDigestCoreP) {
      window.__cadeDigestCoreP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = CORE_URL;
        s.onload = function () { if (window.__cadeDigestCore) res(window.__cadeDigestCore); else { window.__cadeDigestCoreP = null; rej(new Error('digest core missing')); } };
        s.onerror = function () { window.__cadeDigestCoreP = null; rej(new Error('digest core failed to load')); };
        document.head.appendChild(s);
      });
    }
    return window.__cadeDigestCoreP;
  }

  // ---- small utils -------------------------------------------------------------------
  function noop() {}
  function esc(s) { return Cade.escapeHtml(s == null ? '' : String(s)); }
  function toast(msg, type, ms) { try { Cade.showToast(msg, type || 'info', ms || 2200); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function codeErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function isCoarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function readJSON(key, dflt) {
    try { var v = JSON.parse(Cade.store.get(key) || 'null'); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) { try { Cade.store.set(key, JSON.stringify(v)); } catch (e) {} }

  var _prefs = null;
  function prefs() { if (!_prefs) { try { _prefs = Cade.prefs(ID); } catch (e) { _prefs = null; } } return _prefs; }
  function pref(k, d) {
    try { var p = prefs(), v = p ? p.get(k) : undefined; return v === undefined || v === null ? d : v; } catch (e) { return d; }
  }
  function enabled() { try { return Cade.Settings.get(SETTING) !== false; } catch (e) { return true; } }

  function cleanRoom(v) {
    v = String(v == null ? '' : v).trim().toLowerCase();
    return v && v.length <= 100 && v.indexOf('__') !== 0 ? v : '';
  }
  function todoRoom() { return cleanRoom(pref('todoRoom', 'todo')) || 'todo'; }
  function digestRoom() { var d = cleanRoom(pref('digestRoom', 'digest')) || 'digest'; return d === todoRoom() ? '' : d; }
  function roomList() { try { return Cade.roomsApi.list(); } catch (e) { return []; } }
  function roomExists(n) { return roomList().indexOf(n) >= 0; }
  function activeRoom() { try { return Cade.roomsApi.activeRoom() || ''; } catch (e) { return ''; } }
  function sentinel() { var s = null; try { s = Cade.Settings.get('editor.tagSentinel'); } catch (e) {} return D.validSentinel(s); }
  function editorText() { return Cade.editor ? Cade.editor.state.doc.toString() : ''; }

  // The workspace a capture came from: where you are working (the active
  // workspace) for the digest room; the room's own workspace for an @digest
  // block — the active one when the room is in it.
  function wsNameFor(room) {
    var api = Cade.roomsApi;
    function name(id) { var w = id && api.workspaceById(id); return w && w.name ? String(w.name) : ''; }
    try {
      var act = api.activeWorkspace(), real = !!act && act !== api.WS_ALL && act !== api.WS_UNLABELED && !!name(act);
      var ids = (api.workspaceIds(room) || []).filter(function (id) { return !!name(id); });
      if (room === digestRoom()) return real ? name(act) : ids.length ? name(ids[0]) : '';
      if (real && ids.indexOf(act) >= 0) return name(act);
      if (ids.length) return name(ids[0]);
      return real ? name(act) : '';
    } catch (e) { return ''; }
  }

  function minimalChange(cur, next) {
    var p = 0, max = Math.min(cur.length, next.length);
    while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
    var s = 0;
    while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    return { from: p, to: cur.length - s, insert: next.slice(p, next.length - s) };
  }
  // The open room's text → `next`, as ONE transaction (one undo step).
  function applyOpen(next, userEvent) {
    var ed = Cade.editor;
    if (!ed) return false;
    var cur = ed.state.doc.toString();
    if (cur === next) return false;
    ed.dispatch({ changes: minimalChange(cur, next), userEvent: userEvent || 'input.digest' });
    return true;
  }
  function errText(e) {
    var c = e && e.code, t = '“' + todoRoom() + '”';
    if (c === 'offline') return t + ' can’t be reached right now';
    if (c === 'locked') return t + ' is locked — unlock it first';
    if (c === 'read-only') return 'read-only mode is on';
    if (c === 'busy') return t + ' is busy syncing';
    if (c === 'conflict') return t + ' changed meanwhile';
    if (c === 'invalid') return 'the todo room’s name isn’t valid';
    return (e && e.message) || 'something went wrong';
  }

  // ============================================================================
  // DIGESTING
  // ============================================================================
  // How a room feeds the todo list: 'room' (the digest room — all of it),
  // 'blocks' (another room with @digest lines), '' (nothing to take).
  function modeFor(room, text) {
    if (!D || !room || !enabled()) return '';
    if (room === todoRoom()) return '';
    if (room === digestRoom()) return 'room';
    if (pref('atDigest', true) !== false && /@digest/i.test(text) && D.findBlocks(D.splitLines(text)).length) return 'blocks';
    return '';
  }

  // ---- the journal: jobs whose entries aren't in the todo room yet -----------
  function journal() { var a = readJSON(JOURNAL_KEY, []); return Array.isArray(a) ? a.filter(function (j) { return j && j.id; }) : []; }
  function journalSave(a) {
    try { if (a.length) Cade.store.set(JOURNAL_KEY, JSON.stringify(a.slice(-30))); else Cade.store.remove(JOURNAL_KEY); } catch (e) {}
  }
  function journalAdd(job) {
    var big = (job.before || '').length > 200000;    // a huge room: keep the taken text only
    var rec = { id: job.id, t: job.t, room: job.room, mode: job.mode, entries: job.entries, groups: job.groups, removed: job.removed };
    if (!big) { rec.before = job.before; rec.after = job.after; }
    journalSave(journal().filter(function (j) { return j.id !== job.id; }).concat([rec]));
  }
  function journalDrop(id) { journalSave(journal().filter(function (j) { return j.id !== id; })); }

  // One job at a time, so two digests never race for the todo room.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn, fn); chain = p.then(noop, noop); return p; }

  function readRoom(name) {
    if (!roomExists(name)) return Promise.resolve(null);
    return Promise.resolve(Cade.roomsApi.read(name));
  }
  function readTodo() {
    var t = todoRoom();
    if (!roomExists(t)) return Promise.resolve('');
    return readRoom(t).then(function (text) { if (text == null) throw codeErr('offline'); return text; });
  }

  // Put the entries into the todo room (retrying while it's mid-sync).
  function fileEntries(job) {
    var tries = 0;
    function attempt() {
      return readTodo().then(function (cur) {
        var r = D.insertEntries(cur, job.entries, { sentinel: sentinel(), dedupe: pref('dedupe', true) !== false, groups: job.groups });
        if (!r.added.length) return r;
        return Cade.roomsApi.write(todoRoom(), r.text, { create: true, base: cur, reason: 'digest' }).then(function () { return r; });
      }).catch(function (e) {
        var c = e && e.code;
        if ((c === 'busy' || c === 'conflict') && ++tries < 8) return sleep(c === 'busy' ? 700 : 150).then(attempt);
        throw e;
      });
    }
    return attempt();
  }

  // The taken text back into its room: where it was (a three-way merge with
  // whatever was typed since), else appended at the end.
  function restore(job) {
    var api = Cade.roomsApi;
    function append() {
      return readRoom(job.room).then(function (cur) {
        if (cur == null) throw codeErr('offline');
        var add = String(job.removed || '').trim();
        if (!add) return null;
        var next = cur.replace(/\s+$/, '') + (cur.trim() ? '\n\n' : '') + add;
        return api.write(job.room, next, { base: cur, reason: 'digest-restore' });
      });
    }
    if (!roomExists(job.room) && job.room !== activeRoom()) return Promise.resolve(false);
    var p = job.before != null && job.after != null
      ? Promise.resolve(api.write(job.room, job.before, { base: job.after, reason: 'digest-restore' })).catch(function (e) {
          if (e && e.code === 'conflict') return append();
          throw e;
        })
      : append();
    return p.then(function () { return true; }, function () { return false; });
  }

  function runJob(job, trigger) {
    return fileEntries(job).then(function (r) {
      journalDrop(job.id);
      job.result = r;
      announce(job, r, trigger);
      return r;
    }, function (e) {
      return restore(job).then(function (ok) {
        if (ok) journalDrop(job.id);         // else it stays journalled, to be filed on the next start
        toast('Couldn’t file to ' + todoRoom() + ': ' + errText(e) + (ok ? ' — kept in “' + job.room + '”' : ' — will retry'), 'error', 4500);
        return null;
      });
    });
  }

  function announce(job, r, trigger) {
    var n = r.added.length, sk = r.skipped, t = todoRoom();
    var msg = n ? n + (n === 1 ? ' item' : ' items') + ' → ' + t + (sk ? ' · ' + sk + ' already there' : '')
      : 'Already in ' + t;
    if (trigger === 'leave' || trigger === 'replay') toast(msg, n ? 'success' : 'info', 2400);
    else showUndoPill(job, msg);
  }

  // Digest the OPEN room: clear what's taken now (one undo step), then file it.
  // trigger: 'leave' | 'hotkey' | 'button' | 'command'
  function digestOpen(trigger) {
    var room = activeRoom(), ed = Cade.editor;
    if (!D || !ed || !room) return null;
    var text = ed.state.doc.toString(), mode = modeFor(room, text), quiet = trigger === 'leave';
    if (!mode) { if (!quiet) toast('Nothing to digest here — that’s the “' + (digestRoom() || 'digest') + '” room or an @digest line', 'info', 3200); return null; }
    var ex = D.extract(text, { mode: mode, sentinel: sentinel() });
    if (!ex.entries.length) { if (!quiet) toast(mode === 'room' ? 'Nothing to digest yet' : 'Nothing under @digest yet', 'info'); return null; }
    if (ed.state.readOnly) { if (!quiet) toast('Read-only mode is on — nothing moved', 'info'); return null; }
    var meta = { at: D.stamp(new Date()), ws: wsNameFor(room), room: room, done: '', extra: [] };
    ex.entries.forEach(function (e) { if (!e.meta) e.meta = { at: meta.at, ws: meta.ws, room: meta.room, done: '', extra: [] }; });
    var job = { id: uid(), t: Date.now(), room: room, mode: mode, entries: ex.entries, groups: ex.groups, removed: ex.removed, before: text, after: ex.remainder };
    journalAdd(job);
    try { applyOpen(ex.remainder, 'input.digest'); }
    catch (e) { journalDrop(job.id); console.error('digest: clearing the source failed', e); toast('Couldn’t digest: ' + errText(e), 'error'); return null; }
    try { Cade.haptic(12); } catch (e) {}
    return serial(function () { return runJob(job, trigger); });
  }

  // Undo a digest made with the hotkey / button: its lines come back out of
  // the todo room and its text goes back where it was.
  function undoJob(job) {
    hideUndoPill();
    return serial(function () {
      var r = job.result;
      var out = r && r.added.length ? readTodo().then(function (cur) {
        var next = D.removeLines(cur, r.added.map(function (a) { return a.line; }), r.created);
        return next === cur ? null : Cade.roomsApi.write(todoRoom(), next, { base: cur, reason: 'digest-undo' });
      }) : Promise.resolve(null);
      return out.then(function () { return restore(job); }).then(function (ok) {
        toast(ok ? 'Put back in “' + job.room + '”' : 'Couldn’t put it back', ok ? 'info' : 'error');
      });
    }).catch(function (e) { toast('Couldn’t undo: ' + errText(e), 'error'); });
  }

  // Jobs a previous session didn't get to finish (the app closed between the
  // clear and the filing). Old enough not to be another tab's job in flight.
  function replayJournal() {
    var now = Date.now();
    journal().filter(function (j) { return now - (j.t || 0) > 10000; }).forEach(function (j) {
      serial(function () {
        return fileEntries(j).then(function (r) {
          journalDrop(j.id);
          if (r.added.length) toast(r.added.length + ' item' + (r.added.length === 1 ? '' : 's') + ' from an earlier digest → ' + todoRoom(), 'success', 3000);
        }, function () {
          return restore(j).then(function (ok) { if (ok) journalDrop(j.id); });
        });
      });
    });
  }

  // Leaving a room files what it had for the todo list. switchRoom is wrapped
  // (as the core does for clips) so this runs while the room is still open:
  // the clear is a normal edit the switch then saves and pushes with the rest.
  function hookSwitch() {
    var orig = window.switchRoom;
    if (typeof orig !== 'function' || orig.__cadeDigest) return;
    var wrapped = function (name) {
      try {
        var from = activeRoom(), to = String(name == null ? '' : name).trim().toLowerCase();
        if (D && enabled() && from && to && to !== from) digestOpen('leave');
      } catch (e) { console.error('digest: on leave', e); }
      return orig.apply(this, arguments);
    };
    wrapped.__cadeDigest = true;
    window.switchRoom = wrapped;
  }

  // ---- keyboard ------------------------------------------------------------------
  function isModD(e) {
    if (typeof e.key !== 'string' || e.key.toLowerCase() !== 'd' || e.shiftKey || e.altKey) return false;
    return IS_MAC ? e.metaKey : e.ctrlKey;
  }
  function toggleHotkey() {
    var h = readJSON('cade-hotkeys', null);
    return h && typeof h.toggleTodo === 'string' ? h.toggleTodo : 'Ctrl+D';
  }
  function matchesHotkey(e, str) {
    if (!str || typeof e.key !== 'string') return false;
    var parts = str.toLowerCase().split('+');
    var ctrl = parts.indexOf('ctrl') >= 0 || parts.indexOf('mod') >= 0;
    var mod = IS_MAC ? e.metaKey : e.ctrlKey;
    return mod === ctrl && e.shiftKey === (parts.indexOf('shift') >= 0) && e.altKey === (parts.indexOf('alt') >= 0) && e.key.toLowerCase() === parts[parts.length - 1];
  }
  function inEditableField(t) {
    if (!t || !t.tagName) return false;
    if (t.closest && t.closest('.cm-editor')) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable;
  }
  // In a room with @digest blocks, a [ ] line under the caret OUTSIDE them
  // keeps the core's Ctrl+D (toggle that todo).
  function caretOnTodoOutside(text) {
    var st = Cade.editor.state, line = st.doc.lineAt(st.selection.main.head);
    if (!D.parseTodoLine(line.text)) return false;
    var n = line.number - 1;
    return !D.findBlocks(D.splitLines(text)).some(function (b) { return n >= b.start && n <= b.end; });
  }
  // The todo room's Text view: toggle without the core's strike-through
  // characters, with a done stamp — the same edit the list makes.
  function toggleAtCaret() {
    var ed = Cade.editor;
    if (!ed || ed.state.readOnly) return false;
    var line = ed.state.doc.lineAt(ed.state.selection.main.head);
    try { if (Cade.inCodeFence(line.from)) return false; } catch (e) {}
    var nl = D.toggleLine(line.text, { stamp: pref('doneStamp', true) !== false, now: D.stamp(new Date()) });
    if (nl == null) return false;
    var c = minimalChange(line.text, nl);
    ed.dispatch({ changes: { from: line.from + c.from, to: line.from + c.to, insert: c.insert }, userEvent: 'input.todo' });
    try { Cade.haptic(10); } catch (e) {}
    return true;
  }
  function onKeydown(e) {
    if (!D || !enabled() || e.defaultPrevented || e.isComposing) return;
    var room = activeRoom();
    if (!room) return;
    var field = inEditableField(e.target);
    if (room === todoRoom()) {
      if (field || !matchesHotkey(e, toggleHotkey())) return;
      if (V.visible) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (V.focus >= 0) toggleItem(V.focus);
        return;
      }
      if (toggleAtCaret()) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (field || !isModD(e)) return;
    var text = editorText(), mode = modeFor(room, text);
    if (!mode || (mode === 'blocks' && caretOnTodoOutside(text))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    digestOpen('hotkey');
  }

  // ============================================================================
  // EDITOR: yy → ¥, the live preview of what will be filed, todo metadata
  // ============================================================================
  function composing(view) { return ANDROID ? view.composing : view.compositionStarted; }
  function inCodeAt(state, pos) {
    try { if (Cade.inCodeFence(pos)) return true; } catch (e) {}
    var line = state.doc.lineAt(pos), before = state.doc.sliceString(line.from, pos), ticks = 0;
    for (var i = 0; i < before.length; i++) if (before.charCodeAt(i) === 96) ticks++;
    return (ticks & 1) === 1;
  }
  function yyOn() { return !!D && enabled() && pref('yyYen', true) !== false; }
  var NAME_CH = /^[A-Za-z0-9_]$/;

  // Remembers the ¥ it just typed until the next keystroke tells what it was:
  // a name character → a tag under way, keep it; anything else ("yy ", "yy=")
  // → the two y's come back; "yyyy" → four y's (a date format). Backspace
  // right after turns it back into "yy", and that "yy" is then left alone.
  function Yy(view) {
    this.view = view; this.fresh = -1; this.yAfter = false; this.keep = -1;
    var self = this;
    this.onKey = function (e) {
      if (e.key !== 'Backspace' || self.fresh < 0 || self.yAfter || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      var st = self.view.state, sel = st.selection;
      if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== self.fresh + 1) return;
      if (st.doc.sliceString(self.fresh, self.fresh + 1) !== YEN) return;
      var at = self.fresh;
      e.preventDefault(); e.stopImmediatePropagation();
      self.view.dispatch({ changes: { from: at, to: at + 1, insert: 'yy' }, selection: { anchor: at + 2 }, userEvent: 'delete.backward' });
      self.fresh = -1; self.keep = at;
    };
    view.dom.addEventListener('keydown', this.onKey, true);
  }
  Yy.prototype.update = function (u) {
    if (u.docChanged) {
      if (this.fresh >= 0) this.fresh = u.changes.mapPos(this.fresh, 1);
      if (this.keep >= 0) this.keep = u.changes.mapPos(this.keep, 1);
    }
    var doc = u.state.doc;
    if (this.keep >= 0 && doc.sliceString(this.keep, this.keep + 2) !== 'yy') this.keep = -1;
    if (this.fresh >= 0) {
      var head = u.state.selection.main.head;
      if (doc.sliceString(this.fresh, this.fresh + 1) !== YEN) this.fresh = -1;
      else if (head === this.fresh + 1) this.yAfter = false;
      else if (head === this.fresh + 2 && doc.sliceString(this.fresh + 1, this.fresh + 2) === 'y') this.yAfter = true;
      else this.fresh = -1;
    }
  };
  Yy.prototype.destroy = function () { this.view.dom.removeEventListener('keydown', this.onKey, true); };
  var yyPlugin = ViewPlugin.fromClass(Yy);

  var yyInput = EditorView.inputHandler.of(function (view, from, to, text) {
    if (!yyOn() || from !== to || text.length !== 1) return false;
    var st = view.state, sel = st.selection;
    if (st.readOnly || composing(view) || sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== from) return false;
    var P = view.plugin(yyPlugin);
    if (!P) return false;
    var line = st.doc.lineAt(from);
    if (line.length > 2000) return false;
    if (P.fresh >= 0 && from === P.fresh + 1 + (P.yAfter ? 1 : 0)) {
      var at = P.fresh;
      if (NAME_CH.test(text)) {
        if (text === 'y' && P.yAfter) {                   // "yyyy"
          view.dispatch({ changes: { from: at, to: from, insert: 'yyyy' }, selection: { anchor: at + 4 }, userEvent: 'input.type' });
          P.fresh = -1; P.keep = -1;
          return true;
        }
        return false;                                     // a tag name under way
      }
      if (!P.yAfter) {                                     // "yy " — not a tag after all
        view.dispatch({ changes: { from: at, to: from, insert: 'yy' + text }, selection: { anchor: at + 2 + text.length }, userEvent: 'input.type' });
        P.fresh = -1; P.keep = at;
        return true;
      }
      P.fresh = -1;
      return false;
    }
    if (text === 'y' && from > line.from && st.doc.sliceString(from - 1, from) === 'y') {
      var at2 = from - 1;
      if (P.keep === at2 || !D.yyTrigger(st.doc.sliceString(line.from, from) + 'y') || inCodeAt(st, at2)) return false;
      view.dispatch({ changes: { from: at2, to: from, insert: YEN }, selection: { anchor: at2 + 1 }, userEvent: 'input.type' });
      P.fresh = at2; P.yAfter = false;
      return true;
    }
    // Android keyboards compose a whole word, so "yyhome" only arrives as the
    // Space / punctuation that commits it.
    if (ANDROID && /^[\s.,;:!?)\]]$/.test(text)) {
      var m = /(^|[\s(\[{])yy([A-Za-z0-9_][A-Za-z0-9_\/-]*)$/.exec(st.doc.sliceString(line.from, from));
      if (m && m[2].slice(0, 2) !== 'yy') {
        var s = from - m[2].length - 2;
        if (P.keep !== s && !inCodeAt(st, s)) {
          view.dispatch({ changes: [{ from: s, to: s + 2, insert: YEN }, { from: from, insert: text }], selection: { anchor: from - 1 + text.length }, userEvent: 'input.type' });
          return true;
        }
      }
    }
    return false;
  });

  // ---- live preview: which lines will be filed, and as what ------------------
  var decoVersion = 0;
  function bumpDeco() { decoVersion++; try { if (Cade.editor) Cade.editor.dispatch({}); } catch (e) {} }

  function Chip(n, room) { this.n = n; this.room = room; }
  Chip.prototype = Object.create(WidgetType.prototype);
  Chip.prototype.constructor = Chip;
  Chip.prototype.eq = function (o) { return o.n === this.n && o.room === this.room; };
  Chip.prototype.toDOM = function () {
    var b = document.createElement('span');
    b.className = 'cm-dg-chip';
    b.setAttribute('contenteditable', 'false');
    b.setAttribute('role', 'button');
    b.title = this.n ? 'Moves to “' + this.room + '” when you leave this room — click (or ' + MOD + '+D) to file it now' : 'Lines under @digest go to “' + this.room + '”';
    b.textContent = this.n ? '↪ ' + this.n + ' → ' + this.room : '↪ ' + this.room;
    function swallow(e) { e.preventDefault(); e.stopPropagation(); }
    b.addEventListener('mousedown', swallow);
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    var n = this.n;
    b.addEventListener('click', function (e) { swallow(e); if (n) digestOpen('button'); });
    return b;
  };
  Chip.prototype.ignoreEvent = function () { return true; };

  function GroupTag(name) { this.name = name; }
  GroupTag.prototype = Object.create(WidgetType.prototype);
  GroupTag.prototype.constructor = GroupTag;
  GroupTag.prototype.eq = function (o) { return o.name === this.name; };
  GroupTag.prototype.toDOM = function () {
    var s = document.createElement('span');
    s.className = 'cm-dg-gtag';
    s.setAttribute('contenteditable', 'false');
    s.setAttribute('aria-hidden', 'true');
    s.textContent = 'group';
    s.title = 'Filed under [ ' + this.name + ' ]';
    return s;
  };
  GroupTag.prototype.ignoreEvent = function () { return false; };

  var META_TAIL_RE = /[ \t]\(((?:✓ ?)?\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?: · .*)?)\)[ \t]*$/;
  var MAX_PREVIEW_LINES = 5000;

  function buildDecos(view, self) {
    var room = activeRoom(), doc = view.state.doc, ranges = [];
    self.mode = !D || !enabled() ? '' : room === todoRoom() ? 'todo' : room === digestRoom() ? 'room' : pref('atDigest', true) !== false ? 'blocks' : '';
    self.blocks = 0;
    if (!self.mode || doc.lines > MAX_PREVIEW_LINES) return Decoration.none;
    if (self.mode === 'todo') {
      // Text view: section headings stand out, the metadata suffix steps back.
      for (var r = 0; r < view.visibleRanges.length; r++) {
        var a = doc.lineAt(view.visibleRanges[r].from).number, z = doc.lineAt(view.visibleRanges[r].to).number;
        for (var i = a; i <= z; i++) {
          var ln = doc.line(i);
          if (ln.length > 2000) continue;
          if (D.sectionHead(ln.text) && /^[ \t]*\[/.test(ln.text)) { ranges.push(Decoration.line({ class: 'cm-dg-sec' }).range(ln.from)); continue; }
          if (!D.parseTodoLine(ln.text)) continue;
          var m = META_TAIL_RE.exec(ln.text.replace(/\u0336/g, ''));
          if (m && ln.text.indexOf('\u0336') < 0) ranges.push(Decoration.mark({ class: 'cm-dg-meta' }).range(ln.from + m.index + 1, ln.to));
        }
      }
      return Decoration.set(ranges, true);
    }
    var text = doc.toString();
    if (self.mode === 'blocks' && !/@digest/i.test(text)) return Decoration.none;
    var ex = D.extract(text, { mode: self.mode });
    var count = ex.entries.length;
    if (self.mode === 'blocks') {
      self.blocks = ex.blocks.length;
      ex.blocks.forEach(function (b) {
        var n = 0;
        ex.entries.forEach(function (e) { if (e.line >= b.start && e.line <= b.last) n++; });
        for (var k = b.start; k <= b.end && k < doc.lines; k++) {
          var cls = k === b.start ? 'cm-dg-block cm-dg-directive' : 'cm-dg-block' + (k === b.end ? ' cm-dg-block-end' : '');
          ranges.push(Decoration.line({ class: cls }).range(doc.line(k + 1).from));
        }
        var dl = doc.line(b.start + 1);
        ranges.push(Decoration.widget({ widget: new Chip(n, todoRoom()), side: 1 }).range(dl.to));
      });
    }
    ex.marks.forEach(function (mk) {
      if (mk.kind !== 'head' || mk.line == null || mk.line >= doc.lines) return;
      var hl = doc.line(mk.line + 1);
      ranges.push(Decoration.line({ class: 'cm-dg-head' }).range(hl.from));
      // A bare line the key rule made a title says so — that's the surprising case.
      if (mk.implicit) ranges.push(Decoration.widget({ widget: new GroupTag(mk.group), side: 1 }).range(hl.to));
    });
    self.count = count;
    ranges.sort(function (x, y) { return x.from - y.from || x.startSide - y.startSide; });
    return Decoration.set(ranges, true);
  }
  // Could this change add or remove an @digest line? (Only then is a room
  // without one worth scanning again.)
  function touchesDirective(u) {
    var hit = false;
    u.changes.iterChanges(function (fa, ta, fb, tb, ins) {
      if (hit) return;
      if (/@|digest/i.test(ins.toString()) || /@/.test(u.startState.doc.sliceString(fa, ta))) { hit = true; return; }
      var d = u.state.doc, l1 = d.lineAt(fb).number, l2 = d.lineAt(Math.min(tb, d.length)).number;
      for (var i = l1; i <= l2 && !hit; i++) if (/@digest/i.test(d.line(i).text)) hit = true;
    });
    return hit;
  }
  function Preview(view) { this.v = decoVersion; this.decorations = buildDecos(view, this); }
  Preview.prototype.update = function (u) {
    if (this.v !== decoVersion) { this.v = decoVersion; this.decorations = buildDecos(u.view, this); return; }
    if (this.mode === 'todo') { if (u.docChanged || u.viewportChanged) this.decorations = buildDecos(u.view, this); return; }
    if (!u.docChanged) return;
    if (this.mode === 'blocks' && !this.blocks && !touchesDirective(u)) { this.decorations = this.decorations.map(u.changes); return; }
    this.decorations = buildDecos(u.view, this);
  };
  var previewPlugin = ViewPlugin.fromClass(Preview, { decorations: function (v) { return v.decorations; } });

  // ============================================================================
  // THE TODO LIST VIEW
  // ============================================================================
  var ICON = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h13l-3-3M21 17H8l3 3"/></svg>',
    go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><polyline points="8 12 11 15 16 9"/></svg>',
    sweep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M6 17l3-9 6 2-3 9"/><path d="M14 4l3 1-1 3"/></svg>',
    fold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 15 12 20 17 15"/><polyline points="7 9 12 4 17 9"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  var RULE = '─'.repeat(200);
  var WHEN = [
    { v: 'today', label: 'Today', test: function (d) { return d === 0; } },
    { v: '7d', label: 'Last 7 days', test: function (d) { return d >= 0 && d <= 6; } },
    { v: '30d', label: 'Last 30 days', test: function (d) { return d >= 0 && d <= 30; } },
    { v: 'older', label: 'Older', test: function (d) { return d > 30; } },
    { v: 'none', label: 'No date', test: function (d) { return d < 0; } },
  ];

  var V = {
    inited: false, visible: false,
    q: '', status: 'all', f: { tag: {}, ws: {}, room: {}, when: '' },
    filtersOpen: false, folds: {}, searchFolds: {},
    items: [], P: null, seen: null, focus: -1, editing: -1, adding: '', pending: false,
    undo: null, sheet: null, renderTimer: 0, pillTimer: 0,
  };
  var els = {};

  function loadViewPrefs() {
    var v = readJSON(VIEW_KEY, {}) || {};
    if (v.status === 'open' || v.status === 'done' || v.status === 'all') V.status = v.status;
    V.filtersOpen = !!v.filtersOpen;
    var f = readJSON(FOLDS_KEY, {});
    V.folds = f && typeof f === 'object' ? f : {};
  }
  function saveViewPrefs() { writeJSON(VIEW_KEY, { status: V.status, filtersOpen: V.filtersOpen }); }

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function buildDom() {
    var wrap = document.getElementById('editor-wrap');
    if (!wrap) return false;
    var view = el('div', 'dg');
    view.id = 'dg-view';
    view.hidden = true;
    view.setAttribute('aria-label', 'Todo list');
    view.innerHTML =
      '<div class="dg-top">' +
        '<div class="dg-bar">' +
          '<label class="dg-search">' + ICON.search +
            '<input class="dg-q" id="dg-q" type="search" placeholder="Search todos" aria-label="Search todos" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">' +
            '<button class="dg-clear" id="dg-clear" type="button" aria-label="Clear search" hidden>' + ICON.x + '</button>' +
          '</label>' +
          '<button class="dg-ibtn" id="dg-fbtn" type="button" aria-expanded="false" aria-controls="dg-filters" title="Filters">' + ICON.filter + '<span class="dg-badge" id="dg-fcount" hidden></span></button>' +
          '<button class="dg-ibtn" id="dg-menu" type="button" aria-haspopup="dialog" title="More">' + ICON.dots + '</button>' +
        '</div>' +
        '<div class="dg-stats" id="dg-stats"></div>' +
        '<div class="dg-seg" id="dg-seg" role="group" aria-label="Show"></div>' +
        '<div class="dg-filters" id="dg-filters" hidden></div>' +
        '<div class="dg-active" id="dg-active" hidden></div>' +
      '</div>' +
      '<div class="dg-list" id="dg-list">' +
        '<form class="dg-add" id="dg-add" autocomplete="off">' +
          '<span class="dg-add-ico" aria-hidden="true">' + ICON.plus + '</span>' +
          '<textarea id="dg-add-in" rows="1" placeholder="Add a todo…  (¥tag, or paste a whole digest)" aria-label="Add a todo" spellcheck="true" enterkeyhint="done"></textarea>' +
          '<button class="dg-add-go" type="submit" hidden>Add</button>' +
        '</form>' +
        '<div id="dg-secs" role="list"></div>' +
      '</div>' +
      '<div class="dg-undo" id="dg-undo" role="status" hidden><span id="dg-undo-msg"></span><button type="button" id="dg-undo-btn">Undo</button></div>';
    wrap.appendChild(view);

    var mode = el('div', 'dg-mode');
    mode.id = 'dg-mode';
    mode.hidden = true;
    mode.setAttribute('role', 'group');
    mode.setAttribute('aria-label', 'Todo view');
    mode.innerHTML = '<button type="button" data-mode="list" aria-pressed="true">List</button><button type="button" data-mode="text" aria-pressed="false">Text</button>';
    wrap.appendChild(mode);

    var pill = el('div', 'dg-pill');
    pill.id = 'dg-pill';
    pill.hidden = true;
    pill.setAttribute('role', 'status');
    pill.innerHTML =
      '<span class="dg-pill-msg" id="dg-pill-msg"></span>' +
      '<button type="button" class="dg-pill-btn" data-pill="now">Digest now <kbd>' + MOD + '+D</kbd></button>' +
      '<button type="button" class="dg-pill-btn" data-pill="undo" hidden>Undo</button>' +
      '<button type="button" class="dg-pill-btn dim" data-pill="todo" title="Open the todo list">' + ICON.box + '<span></span></button>';
    wrap.appendChild(pill);

    var sheet = el('div', 'dg-sheet-wrap');
    sheet.id = 'dg-sheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="dg-sheet" role="dialog" aria-modal="true" aria-labelledby="dg-sheet-title"><div class="dg-sheet-head"><div class="dg-sheet-title" id="dg-sheet-title"></div><div class="dg-sheet-sub" id="dg-sheet-sub"></div></div><div id="dg-sheet-body"></div></div>';
    document.body.appendChild(sheet);

    els = {
      wrap: wrap, view: view, mode: mode, pill: pill, sheet: sheet,
      q: view.querySelector('#dg-q'), clear: view.querySelector('#dg-clear'), fbtn: view.querySelector('#dg-fbtn'),
      fcount: view.querySelector('#dg-fcount'), menu: view.querySelector('#dg-menu'), stats: view.querySelector('#dg-stats'),
      seg: view.querySelector('#dg-seg'), filters: view.querySelector('#dg-filters'), active: view.querySelector('#dg-active'),
      list: view.querySelector('#dg-list'), add: view.querySelector('#dg-add'), addIn: view.querySelector('#dg-add-in'),
      secs: view.querySelector('#dg-secs'), undo: view.querySelector('#dg-undo'), undoMsg: view.querySelector('#dg-undo-msg'),
      undoBtn: view.querySelector('#dg-undo-btn'), pillMsg: pill.querySelector('#dg-pill-msg'),
      sheetTitle: sheet.querySelector('#dg-sheet-title'), sheetSub: sheet.querySelector('#dg-sheet-sub'), sheetBody: sheet.querySelector('#dg-sheet-body'),
    };
    return true;
  }

  // ---- reading the document ------------------------------------------------------------
  function itemInfo(it, now) {
    var w = D.when(it.meta && it.meta.at, now);
    it.whenLabel = w.label;
    it.days = w.days;
    it.ws = (it.meta && it.meta.ws) || '';
    it.room = (it.meta && it.meta.room) || '';
    it.uid = it.key + '|' + ((it.meta && it.meta.at) || '') + '|' + it.sec;
    return it;
  }
  function activeFilterCount() {
    var f = V.f;
    return Object.keys(f.tag).length + Object.keys(f.ws).length + Object.keys(f.room).length + (f.when ? 1 : 0);
  }
  // Narrowed = a search or a facet is on: the list goes flat and folds are
  // temporary. The All | Open | Done segment is a view, not a search — the
  // groups, their nesting and their folds stay.
  function narrowed() { return !!V.q.trim() || activeFilterCount() > 0; }
  function filtering() { return narrowed() || V.status !== 'all'; }
  function terms() { return V.q.toLowerCase().split(/\s+/).filter(Boolean); }

  function matchSearch(it, sec, T) {
    if (!T.length) return true;
    var hay = [it.text, (it.tags || []).map(function (t) { return YEN + t + ' #' + t; }).join(' '), sec.name, it.ws, it.room, it.meta && it.meta.at, it.meta && it.meta.done].join(' ').toLowerCase();
    return T.every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function matchStatus(it) {
    if (it.kind !== 'todo') return V.status === 'all';
    return V.status === 'all' || (V.status === 'done' ? it.done : !it.done);
  }
  // facets: skip = the facet whose own filter is ignored (for its chip counts)
  function matchFacets(it, skip) {
    var f = V.f, k;
    if (skip !== 'tag' && (k = Object.keys(f.tag)).length) {
      var tg = it.tags || [];
      if (!k.some(function (t) { return t === '∅' ? !tg.length : tg.indexOf(t) >= 0; })) return false;
    }
    if (skip !== 'ws' && (k = Object.keys(f.ws)).length && !f.ws[it.ws || '∅']) return false;
    if (skip !== 'room' && (k = Object.keys(f.room)).length && !f.room[it.room || '∅']) return false;
    if (skip !== 'when' && f.when) {
      var w = WHEN.filter(function (x) { return x.v === f.when; })[0];
      if (w && !w.test(it.days)) return false;
    }
    return true;
  }
  function visibleItem(it, sec, T) {
    if (it.kind === 'note') return !filtering() || (matchSearch(it, sec, T) && V.status === 'all' && !activeFilterCount());
    return matchStatus(it) && matchSearch(it, sec, T) && matchFacets(it, null);
  }

  // ---- rich text: tags (click to filter), links, search hits -----------------------
  var LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])/g;
  function markTerms(s, T) {
    if (!T.length || !s) return esc(s);
    var low = s.toLowerCase();
    if (low.length !== s.length) return esc(s);
    var hits = [];
    T.forEach(function (t) { for (var i = low.indexOf(t); i !== -1; i = low.indexOf(t, i + t.length)) hits.push([i, i + t.length]); });
    if (!hits.length) return esc(s);
    hits.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    hits.forEach(function (h) {
      if (h[1] <= pos) return;
      var a = Math.max(h[0], pos);
      out += esc(s.slice(pos, a)) + '<mark class="dg-hit">' + esc(s.slice(a, h[1])) + '</mark>';
      pos = h[1];
    });
    return out + esc(s.slice(pos));
  }
  function richText(text, T) {
    var spans = [], m;
    D.findTags(text, sentinel()).forEach(function (g) { spans.push({ a: g.start, b: g.end, kind: 'tag', name: g.name }); });
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text)) !== null) {
      var a = m.index, b = a + m[0].length;
      if (spans.some(function (s) { return a < s.b && b > s.a; })) continue;
      spans.push({ a: a, b: b, kind: 'link', label: m[1] || m[3], url: m[2] || m[3] });
    }
    spans = spans.filter(function (s, i) { return !spans.some(function (o, j) { return j !== i && o.kind === 'link' && s.kind === 'tag' && s.a >= o.a && s.b <= o.b; }); });
    spans.sort(function (x, y) { return x.a - y.a; });
    var out = '', pos = 0;
    spans.forEach(function (s) {
      if (s.a < pos) return;
      out += markTerms(text.slice(pos, s.a), T);
      if (s.kind === 'tag') {
        out += '<button type="button" class="dg-tag" data-ftag="' + esc(s.name.toLowerCase()) + '" title="Show only ' + esc(YEN + s.name) + '">' + markTerms(text.slice(s.a, s.b), T) + '</button>';
      } else {
        var lbl = s.label.length > 60 ? s.label.slice(0, 57) + '…' : s.label;
        out += '<a class="dg-link" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + markTerms(lbl, T) + '</a>';
      }
      pos = s.b;
    });
    return out + markTerms(text.slice(pos), T);
  }

  // ---- rendering ---------------------------------------------------------------------
  function chip(attr, val, label, n, on, extra) {
    return '<button type="button" class="dg-chip' + (on ? ' on' : '') + (n === 0 && !on ? ' none' : '') + (extra ? ' ' + extra : '') + '" ' + attr + '="' + esc(val) + '" aria-pressed="' + !!on + '">' +
      esc(label) + (n != null ? ' <span class="n">' + n + '</span>' : '') + '</button>';
  }
  function scheduleRender() {
    clearTimeout(V.renderTimer);
    V.renderTimer = setTimeout(render, 120);
  }
  function editingNow() {
    var a = document.activeElement;
    return V.editing >= 0 || !!(a && a.closest && a.closest('.dg-inline-add, .dg-edit'));
  }

  function render(force) {
    clearTimeout(V.renderTimer);
    V.renderTimer = 0;
    if (!V.visible || !D || !Cade.editor) return;
    if (!force && editingNow()) { V.pending = true; return; }   // never pull an input out from under the user
    V.pending = false;
    var now = new Date(), T = terms();
    var P = D.parseTodo(Cade.editor.state.doc.toString(), { sentinel: sentinel() });
    V.P = P;
    P.items.forEach(function (it) { itemInfo(it, now); });
    var todos = P.items.filter(function (it) { return it.kind === 'todo'; });

    // the numbers: the whole list, or what the filters leave
    var shown = todos.filter(function (it) { return matchSearch(it, P.sections[it.sec], T) && matchFacets(it, null); });
    var s = D.stats(narrowed() ? shown : todos, now);
    var oldest = s.oldest ? D.when(s.oldest, now) : null;
    els.stats.innerHTML = s.total
      ? '<div class="dg-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + s.pct + '" aria-label="Done"><span style="width:' + s.pct + '%"></span></div>' +
        '<div class="dg-statline"><span><b>' + s.open + '</b> open</span><span><b>' + s.done + '</b> done</span><span>' + s.pct + '%</span>' +
        (s.addedToday ? '<span class="dim">+' + s.addedToday + ' today</span>' : '') +
        (s.doneToday ? '<span class="dim">✓' + s.doneToday + ' today</span>' : '') +
        (oldest && oldest.days >= 2 ? '<span class="dim" title="Oldest open item: ' + esc(s.oldest) + '">oldest ' + oldest.days + 'd</span>' : '') +
        ((T.length || activeFilterCount()) ? '<span class="dim">of ' + todos.length + '</span>' : '') + '</div>'
      : '';

    // status segment
    var base = todos.filter(function (it) { return matchSearch(it, P.sections[it.sec], T) && matchFacets(it, null); });
    var nOpen = base.filter(function (it) { return !it.done; }).length;
    els.seg.innerHTML = ['all', 'open', 'done'].map(function (st) {
      var n = st === 'all' ? base.length : st === 'open' ? nOpen : base.length - nOpen;
      return '<button type="button" data-status="' + st + '" aria-pressed="' + (V.status === st) + '">' + (st === 'all' ? 'All' : st === 'open' ? 'Open' : 'Done') + ' <span class="n">' + n + '</span></button>';
    }).join('');
    els.seg.hidden = !todos.length;

    // facets: counts ignore the facet's own selection (so a chip says what picking it would show)
    function counts(facet, keyOf) {
      var c = {};
      todos.forEach(function (it) {
        if (!matchStatus(it) || !matchSearch(it, P.sections[it.sec], T) || !matchFacets(it, facet)) return;
        keyOf(it).forEach(function (k) { c[k] = (c[k] || 0) + 1; });
      });
      return c;
    }
    function allKeys(keyOf) { var k = {}; todos.forEach(function (it) { keyOf(it).forEach(function (x) { k[x] = 1; }); }); return Object.keys(k); }
    var tagOf = function (it) { return it.tags.length ? it.tags : ['∅']; };
    var wsOf = function (it) { return [it.ws || '∅']; };
    var roomOf = function (it) { return [it.room || '∅']; };
    var rows = [];
    var tagKeys = allKeys(tagOf).sort(function (a, b) { return a === '∅' ? 1 : b === '∅' ? -1 : a < b ? -1 : 1; });
    if (tagKeys.length > 1 || (tagKeys.length === 1 && tagKeys[0] !== '∅')) {
      var tc = counts('tag', tagOf);
      rows.push(['Tags', tagKeys.map(function (k) { return chip('data-ft', k, k === '∅' ? 'untagged' : YEN + k, tc[k] || 0, !!V.f.tag[k], k === '∅' ? 'quiet' : ''); }).join('')]);
    }
    var wc = counts('when', function (it) { return WHEN.filter(function (w) { return w.test(it.days); }).map(function (w) { return w.v; }); });
    rows.push(['Added', WHEN.filter(function (w) { return wc[w.v] || V.f.when === w.v; }).map(function (w) { return chip('data-fw', w.v, w.label, wc[w.v] || 0, V.f.when === w.v); }).join('')]);
    var wsKeys = allKeys(wsOf);
    if (wsKeys.length > 1 || (wsKeys.length === 1 && wsKeys[0] !== '∅')) {
      var wsc = counts('ws', wsOf);
      rows.push(['Workspace', wsKeys.sort().map(function (k) { return chip('data-fs', k, k === '∅' ? 'none' : k, wsc[k] || 0, !!V.f.ws[k], k === '∅' ? 'quiet' : ''); }).join('')]);
    }
    var roomKeys = allKeys(roomOf);
    if (roomKeys.length > 1 || (roomKeys.length === 1 && roomKeys[0] !== '∅')) {
      var rc = counts('room', roomOf);
      rows.push(['Room', roomKeys.sort().map(function (k) { return chip('data-fr', k, k === '∅' ? 'typed here' : k, rc[k] || 0, !!V.f.room[k], k === '∅' ? 'quiet' : ''); }).join('')]);
    }
    els.filters.innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div class="dg-frow"><span class="dg-flabel">' + esc(r[0]) + '</span><div class="dg-chips">' + r[1] + '</div></div>';
    }).join('') || '<div class="dg-frow"><span class="dg-flabel">Nothing to filter by yet</span></div>';
    els.filters.hidden = !V.filtersOpen || !todos.length;
    els.fbtn.setAttribute('aria-expanded', String(V.filtersOpen));
    els.fbtn.hidden = !todos.length;
    var nf = activeFilterCount();
    els.fcount.hidden = !nf;
    els.fcount.textContent = nf;
    // what's picked, while the panel is shut
    var act = [];
    Object.keys(V.f.tag).forEach(function (k) { act.push(chip('data-ft', k, (k === '∅' ? 'untagged' : YEN + k) + ' ×', null, true)); });
    if (V.f.when) act.push(chip('data-fw', V.f.when, WHEN.filter(function (w) { return w.v === V.f.when; })[0].label + ' ×', null, true));
    Object.keys(V.f.ws).forEach(function (k) { act.push(chip('data-fs', k, (k === '∅' ? 'no workspace' : k) + ' ×', null, true)); });
    Object.keys(V.f.room).forEach(function (k) { act.push(chip('data-fr', k, (k === '∅' ? 'typed here' : k) + ' ×', null, true)); });
    if (act.length) act.push('<button type="button" class="dg-chip quiet" data-fclear="1">Clear</button>');
    els.active.innerHTML = act.join('');
    els.active.hidden = V.filtersOpen || !act.length;
    els.q.placeholder = 'Search ' + todos.length + ' todo' + (todos.length === 1 ? '' : 's');
    els.addIn.placeholder = window.innerWidth < 560 ? 'Add a todo…' : 'Add a todo…  (¥tag, or paste a whole digest)';

    // sections
    var showMeta = pref('showMeta', true) !== false, flat = narrowed(), hideEmpty = filtering(), seen = {}, parts = [], list = [], matched = 0;
    var fresh = V.seen;
    P.sections.forEach(function (sec, si) {
      var its = sec.items.map(function (n) { return P.items[n]; });
      var vis = its.filter(function (it) { return visibleItem(it, sec, T); });
      var tTodos = its.filter(function (it) { return it.kind === 'todo'; });
      if (sec.line < 0 && !its.length) return;
      if (hideEmpty && !vis.length) return;
      matched += vis.filter(function (it) { return it.kind === 'todo'; }).length;
      var rowsHtml = '';
      vis.forEach(function (it) {
        seen[it.uid] = 1;
        var isNew = !!fresh && !fresh[it.uid] && it.kind === 'todo';
        rowsHtml += rowHtml(it, list.length, T, isNew, flat, showMeta);
        list.push(it);
      });
      var key = sec.key || '';
      if (V.adding === key && sec.line >= 0) rowsHtml += '<div class="dg-inline-add"><input class="dg-inline-in" data-addto="' + esc(key) + '" type="text" placeholder="Add to ' + esc(sec.name) + '…" aria-label="Add to ' + esc(sec.name) + '" enterkeyhint="done" spellcheck="true"></div>';
      if (sec.line < 0) { parts.push({ key: '\u0000loose', html: '<div class="dg-rows dg-loose">' + rowsHtml + '</div>' }); return; }
      var done = tTodos.filter(function (it) { return it.done; }).length;
      var folded = flat ? !!V.searchFolds[key] : !!V.folds[key];
      var pct = tTodos.length ? Math.round(done / tTodos.length * 100) : 0;
      parts.push({ key: 'sec:' + key, html: '<section class="dg-sec' + (folded ? ' folded' : '') + (tTodos.length && done === tTodos.length ? ' complete' : '') + '" data-sec="' + esc(key) + '">' +
        '<h2 class="dg-h"><button class="dg-sec-head" type="button" data-fold="' + esc(key) + '" aria-expanded="' + !folded + '">' +
          '<span class="dg-rule" aria-hidden="true">──</span><span class="dg-sec-name">' + markTerms(sec.name.toUpperCase() === sec.key ? sec.key : sec.name, T) + '</span>' +
          '<span class="dg-rule fill" aria-hidden="true">' + RULE + '</span>' +
          '<span class="dg-sec-n" title="' + done + ' of ' + tTodos.length + ' done">' + (tTodos.length ? done + '/' + tTodos.length : '0') + '</span>' +
          '<span class="dg-sec-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
          '<span class="dg-chev" aria-hidden="true">' + ICON.chev + '</span>' +
        '</button><button class="dg-sec-add" type="button" data-add="' + esc(key) + '" aria-label="Add to ' + esc(sec.name) + '" title="Add to ' + esc(sec.name) + '">' + ICON.plus + '</button></h2>' +
        '<div class="dg-rows">' + (rowsHtml || '<div class="dg-empty-sec">Nothing here' + (flat ? ' that matches' : '') + '</div>') + '</div></section>' });
    });
    if (!todos.length && !P.items.length) {
      parts = [{ key: '\u0000empty', html: '<div class="dg-empty"><div class="dg-empty-ico">' + ICON.inbox + '</div><b>Nothing to do yet.</b><br>Jot things down in the “' + esc(digestRoom() || 'digest') + '” room — they land here when you leave it.<br>Or add one above, or put <code>@digest</code> over a list in any room.' +
        (digestRoom() ? '<br><button class="btn" type="button" data-empty="digest">Open “' + esc(digestRoom()) + '”</button>' : '') + '</div>' }];
    } else if (hideEmpty && !matched && todos.length) {
      parts = [{ key: '\u0000nomatch', html: !narrowed() && V.status === 'open'
        ? '<div class="dg-empty"><div class="dg-empty-ico">' + ICON.box + '</div><b>Nothing open — all done.</b><br><button class="btn" type="button" data-empty="clear">Show everything</button></div>'
        : '<div class="dg-empty">No todos match' + (V.q.trim() ? ' <b>' + esc(V.q.trim()) + '</b>' : '') + '.<br><button class="btn" type="button" data-empty="clear">Clear search &amp; filters</button></div>' }];
    }
    V.items = list;
    V.seen = seen;
    if (V.focus >= list.length) V.focus = list.length - 1;
    patch(els.secs, parts);
    if (V.focus >= 0) paintFocus(false);
  }

  // A row's DOM was changed by hand (an instant tick, an edit box): its section
  // must be rebuilt on the next render even if its HTML comes out the same.
  function dirty(node) {
    while (node && node.parentNode && node.parentNode !== els.secs) node = node.parentNode;
    if (node && node.parentNode === els.secs) node.__dgHtml = null;
  }
  // Put the parts (one element each) into the container, rebuilding only those
  // whose HTML changed — a tick re-renders its own section, not the whole list.
  function patch(box, parts) {
    var old = {}, k, n;
    for (k = 0; k < box.children.length; k++) { n = box.children[k]; if (n.__dgKey) old[n.__dgKey] = n; }
    var prev = null, tmp = document.createElement('div');
    parts.forEach(function (p) {
      var node = old[p.key];
      if (!node || node.__dgHtml !== p.html) {
        tmp.innerHTML = p.html;
        var made = tmp.firstElementChild;
        if (!made) return;
        made.__dgKey = p.key;
        made.__dgHtml = p.html;
        if (node) box.replaceChild(made, node);
        node = made;
      }
      delete old[p.key];
      var want = prev ? prev.nextSibling : box.firstChild;
      if (node !== want) box.insertBefore(node, want);
      prev = node;
    });
    Object.keys(old).forEach(function (key) { if (old[key].parentNode === box) box.removeChild(old[key]); });
    if (!prev) { box.innerHTML = ''; return; }
    while (prev.nextSibling) box.removeChild(prev.nextSibling);
    while (box.firstChild && !box.firstChild.__dgKey) box.removeChild(box.firstChild);
  }

  function rowHtml(it, i, T, isNew, flat, showMeta) {
    var depth = flat ? 0 : Math.min(it.depth || 0, 4);
    if (it.kind === 'note') {
      return '<div class="dg-item note' + (it.code ? ' code' : '') + '" data-i="' + i + '" style="--d:' + depth + '" role="listitem" tabindex="-1">' +
        '<span class="dg-dot" aria-hidden="true"></span><div class="dg-body"><div class="dg-text">' + (it.code ? esc(it.text) : richText(it.text, T)) + '</div></div>' +
        '<button class="dg-more" type="button" data-more="' + i + '" aria-label="Actions"></button></div>';
    }
    var label = it.text || '(empty)';
    var text = '<div class="dg-text" data-edit="' + i + '" title="Tap to edit">' + (it.text ? richText(it.text, T) : '<span class="dg-faint">(empty)</span>') + '</div>';
    var whenHtml = '', meta = '';
    if (showMeta) {
      // when — on the first line, right-aligned; where from — a line of its own
      if (it.done && it.meta.done) {
        var dw = D.when(it.meta.done, new Date());
        whenHtml = '<span class="dg-when done" title="Added ' + esc(it.meta.at || '?') + ' · done ' + esc(it.meta.done) + '">✓ ' + esc(dw.label) + '</span>';
      } else if (it.whenLabel) {
        whenHtml = '<span class="dg-when' + (it.days === 0 ? ' fresh' : '') + '" title="Added ' + esc(it.meta.at) + '">' + esc(it.whenLabel) + '</span>';
      }
      var bits = [], src = '';
      if (it.ws) src += '<button type="button" class="dg-mchip" data-fs="' + esc(it.ws) + '" title="Show only ' + esc(it.ws) + '">' + markTerms(it.ws, T) + '</button>';
      if (it.room && it.room !== digestRoom() && it.room !== todoRoom()) src += (src ? '<span class="dg-sep">›</span>' : '') + '<button type="button" class="dg-mchip" data-fr="' + esc(it.room) + '" title="Show only ' + esc(it.room) + '">' + markTerms(it.room, T) + '</button>';
      if (src) bits.push(src);
      if (flat && depth === 0 && (it.depth || 0) > 0) bits.push('<span class="dg-faint">sub-item</span>');
      if (bits.length) meta = '<div class="dg-meta">' + bits.join('<span class="dg-dotsep" aria-hidden="true">·</span>') + '</div>';
    }
    return '<div class="dg-item' + (it.done ? ' done' : '') + (isNew ? ' fresh' : '') + '" data-i="' + i + '" style="--d:' + depth + '" role="listitem" tabindex="-1">' +
      '<button class="dg-box" type="button" role="checkbox" aria-checked="' + !!it.done + '" data-toggle="' + i + '" aria-label="' + (it.done ? 'Mark not done: ' : 'Mark done: ') + esc(label) + '"></button>' +
      '<div class="dg-body"><div class="dg-l1">' + text + whenHtml + '</div>' + meta + '</div>' +
      '<button class="dg-more" type="button" data-more="' + i + '" aria-label="Actions for ' + esc(label) + '"></button></div>';
  }

  // ---- edits (each ONE editor transaction on the open todo room) ---------------------
  function canEdit() {
    var ed = Cade.editor;
    if (!ed || activeRoom() !== todoRoom()) return false;
    if (ed.state.readOnly) { toast('Read-only mode is on', 'info'); return false; }
    return true;
  }
  function commit(next, undoMsg) {
    if (!canEdit()) return false;
    if (next == null) { toast('That item changed — try again', 'info'); render(); return false; }
    var ed = Cade.editor, before = ed.state.doc.toString();
    if (next === before) return false;
    ed.dispatch({ changes: minimalChange(before, next), userEvent: 'input.todo' });
    if (undoMsg) showListUndo(undoMsg, before, ed.state.doc.toString());
    return true;
  }
  function cur() { return Cade.editor.state.doc.toString(); }
  function toggleItem(i) {
    var it = V.items[i];
    if (!it || it.kind !== 'todo' || !canEdit()) return;
    if (commit(D.toggleAt(cur(), it.line, it.raw, { stamp: pref('doneStamp', true) !== false, now: D.stamp(new Date()) }))) {
      try { Cade.haptic(10); } catch (e) {}
      // repaint this row now, so the tick doesn't wait for the debounce
      var row = els.secs.querySelector('.dg-item[data-i="' + i + '"]');
      if (row) {
        dirty(row);
        row.classList.toggle('done', !it.done);
        var b = row.querySelector('.dg-box');
        if (b) b.setAttribute('aria-checked', String(!it.done));
      }
    }
  }
  function startEdit(i) {
    var it = V.items[i];
    if (!it || !canEdit()) return;
    V.editing = i;
    V.pending = false;
    var row = els.secs.querySelector('.dg-item[data-i="' + i + '"] .dg-body');
    if (!row) return;
    dirty(row);
    var input = document.createElement('input');
    input.className = 'dg-edit';
    input.type = 'text';
    input.value = it.text;
    input.setAttribute('aria-label', 'Edit');
    input.setAttribute('enterkeyhint', 'done');
    row.innerHTML = '';
    row.appendChild(input);
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      V.editing = -1;
      try { input.blur(); } catch (e) {}           // (its blur handler sees `done`)
      var v = input.value.replace(/\s+/g, ' ').trim();
      if (save && v !== it.text) {
        if (!v) commit((D.deleteAt(cur(), it.line, it.raw) || {}).text, 'Deleted');
        else commit(D.setTextAt(cur(), it.line, it.raw, v, { sentinel: sentinel() }));
      }
      render();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }
  function deleteItem(i) {
    var it = V.items[i];
    if (!it || !canEdit()) return;
    var r = D.deleteAt(cur(), it.line, it.raw);
    if (!r) { commit(null); return; }
    var name = it.text.length > 40 ? it.text.slice(0, 40) + '…' : it.text;
    commit(r.text, 'Deleted ' + (r.count > 1 ? name + ' + ' + (r.count - 1) + ' sub-item' + (r.count > 2 ? 's' : '') : name || 'item'));
  }
  function moveItem(i, group) {
    var it = V.items[i];
    if (!it || !canEdit()) return;
    var g = D.normGroup(group);
    if (!g) return;
    if (commit(D.moveAt(cur(), it.line, it.raw, g, { sentinel: sentinel() }), 'Moved to ' + g)) {
      if (V.folds[g]) { delete V.folds[g]; writeJSON(FOLDS_KEY, V.folds); }
    }
  }
  function makeTodo(i) {
    var it = V.items[i];
    if (it && canEdit()) commit(D.makeTodoAt(cur(), it.line, it.raw));
  }
  function clearCompleted() {
    if (!canEdit()) return;
    var r = D.clearDone(cur(), { sentinel: sentinel() });
    if (!r.removed) { toast('Nothing checked off yet', 'info'); return; }
    commit(r.text, 'Cleared ' + r.removed + ' done');
  }
  // Add typed text — one entry, or a pasted digest — to the todo room.
  function addText(text, group) {
    if (!canEdit()) return false;
    var raw = String(text || '');
    if (!raw.trim()) return false;
    var ex = D.extract(raw, { mode: 'room', sentinel: sentinel() });
    if (!ex.entries.length) return false;
    var g = group ? D.normGroup(group) : '';
    var meta = { at: D.stamp(new Date()), ws: wsNameFor(todoRoom()), room: todoRoom(), done: '', extra: [] };
    ex.entries.forEach(function (e) {
      if (g && e.group === D.UNCAT) e.group = g;
      if (!e.meta) e.meta = { at: meta.at, ws: meta.ws, room: meta.room, done: '', extra: [] };
    });
    var r = D.insertEntries(cur(), ex.entries, { sentinel: sentinel(), dedupe: pref('dedupe', true) !== false, groups: g ? [] : ex.groups });
    if (!r.added.length) { toast(r.skipped ? 'Already on the list' : 'Nothing to add', 'info'); return true; }
    commit(r.text);
    if (r.skipped) toast(r.skipped + ' already on the list', 'info');
    return true;
  }

  // ---- undo bar (list view) ------------------------------------------------------------
  function showListUndo(msg, before, after) {
    clearTimeout(V.undo && V.undo.timer);
    V.undo = { before: before, after: after, timer: setTimeout(hideListUndo, 6500) };
    els.undoMsg.textContent = msg;
    els.undo.hidden = false;
  }
  function hideListUndo() {
    if (V.undo) clearTimeout(V.undo.timer);
    V.undo = null;
    if (els.undo) els.undo.hidden = true;
  }
  function undoList() {
    var u = V.undo;
    hideListUndo();
    if (!u || activeRoom() !== todoRoom() || !Cade.editor) return;
    var now = cur();
    if (now !== u.after) { toast('The list changed since — use the Text view’s undo', 'info', 3000); return; }
    Cade.editor.dispatch({ changes: minimalChange(now, u.before), userEvent: 'input.todo' });
  }

  // ---- folds ------------------------------------------------------------------------------
  function toggleFold(key) {
    if (narrowed()) { if (V.searchFolds[key]) delete V.searchFolds[key]; else V.searchFolds[key] = 1; }
    else { if (V.folds[key]) delete V.folds[key]; else V.folds[key] = 1; writeJSON(FOLDS_KEY, V.folds); }
    render();
  }
  function foldAll(fold) {
    if (!V.P) return;
    V.P.sections.forEach(function (s) { if (s.line >= 0 && s.key) { if (fold) V.folds[s.key] = 1; else delete V.folds[s.key]; } });
    writeJSON(FOLDS_KEY, V.folds);
    V.searchFolds = {};
    render();
  }

  // ---- row focus (keyboard) -----------------------------------------------------------
  function paintFocus(scroll) {
    var rows = els.secs.querySelectorAll('.dg-item');
    for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('focus', +rows[k].getAttribute('data-i') === V.focus);
    var r = els.secs.querySelector('.dg-item[data-i="' + V.focus + '"]');
    if (r && scroll) { try { r.focus({ preventScroll: true }); } catch (e) {} r.scrollIntoView({ block: 'nearest' }); }
  }
  function moveFocus(d) {
    if (!V.items.length) return;
    V.focus = V.focus < 0 ? (d > 0 ? 0 : V.items.length - 1) : Math.max(0, Math.min(V.items.length - 1, V.focus + d));
    paintFocus(true);
  }

  // ---- sheet (row actions, the ⋯ menu) ------------------------------------------------------
  function act(a, icon, label, opts) {
    opts = opts || {};
    return '<button class="dg-act' + (opts.danger ? ' danger' : '') + '" type="button" data-act="' + a + '"' + (opts.expanded != null ? ' aria-expanded="' + opts.expanded + '"' : '') + '>' + icon + '<span>' + esc(label) + '</span></button>';
  }
  function openSheet(spec) {
    V.sheet = spec;
    els.sheetTitle.textContent = spec.title || '';
    els.sheetSub.textContent = spec.sub || '';
    els.sheetSub.hidden = !spec.sub;
    els.sheetBody.innerHTML = spec.html;
    els.sheet.hidden = false;
    try { (els.sheetBody.querySelector('.dg-act') || els.sheet).focus({ preventScroll: true }); } catch (e) {}
  }
  function closeSheet() { if (els.sheet) els.sheet.hidden = true; V.sheet = null; }
  function groupNames() {
    var out = [];
    (V.P ? V.P.sections : []).forEach(function (s) { if (s.line >= 0 && s.key && out.indexOf(s.key) < 0) out.push(s.key); });
    if (out.indexOf(D.UNCAT) < 0) out.push(D.UNCAT);
    return out;
  }
  function openRowSheet(i) {
    var it = V.items[i];
    if (!it) return;
    var sec = V.P.sections[it.sec];
    var html = '';
    if (it.kind === 'todo') {
      html += act('toggle', ICON.box, it.done ? 'Mark not done' : 'Mark done');
      html += act('edit', ICON.edit, 'Edit');
      html += act('move', ICON.move, 'Move to…', { expanded: false });
      html += '<div class="dg-movebox" id="dg-movebox" hidden></div>';
      if (it.room && roomExists(it.room) && it.room !== todoRoom() && it.room !== digestRoom()) html += act('source', ICON.go, 'Open “' + it.room + '”');
    } else {
      html += act('maketodo', ICON.box, 'Make it a todo');
      html += act('move', ICON.move, 'Move to…', { expanded: false });
      html += '<div class="dg-movebox" id="dg-movebox" hidden></div>';
    }
    html += act('text', ICON.text, 'Show in text');
    html += act('copy', ICON.copy, 'Copy text');
    html += act('delete', ICON.trash, 'Delete', { danger: true });
    var sub = [];
    if (sec && sec.line >= 0) sub.push(sec.name);
    if (it.meta && it.meta.at) sub.push('added ' + it.meta.at + (it.ws || it.room ? ' from ' + [it.ws, it.room].filter(Boolean).join(' › ') : ''));
    if (it.meta && it.meta.done) sub.push('done ' + it.meta.done);
    openSheet({ kind: 'row', i: i, title: it.text || '(empty)', sub: sub.join(' · '), html: html });
  }
  function showMoveBox() {
    var box = document.getElementById('dg-movebox'), btn = els.sheetBody.querySelector('[data-act="move"]');
    if (!box || !V.sheet) return;
    if (!box.hidden) { box.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false'); return; }
    var it = V.items[V.sheet.i], here = it ? V.P.sections[it.sec].key : '';
    var html = groupNames().filter(function (g) { return g !== here; }).map(function (g) { return '<button type="button" class="dg-chip" data-moveto="' + esc(g) + '">' + esc(g) + '</button>'; }).join('');
    html += '<form class="dg-newgroup" id="dg-newgroup"><input id="dg-newgroup-in" type="text" placeholder="new group" aria-label="New group name" autocapitalize="characters" spellcheck="false" enterkeyhint="done"><button class="btn" type="submit">Move</button></form>';
    box.innerHTML = html;
    box.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
  function openMenu() {
    var nDone = V.P ? V.P.items.filter(function (it) { return it.kind === 'todo' && it.done; }).length : 0;
    var html = '';
    if (nDone) html += act('clear', ICON.sweep, 'Clear completed (' + nDone + ')');
    html += act('foldall', ICON.fold, 'Collapse all groups');
    html += act('unfoldall', ICON.fold, 'Expand all groups');
    if (digestRoom()) html += act('digest', ICON.inbox, 'Open “' + digestRoom() + '”');
    html += act('textmode', ICON.text, 'Show the text');
    html += act('prefs', ICON.gear, 'Preferences…');
    openSheet({ kind: 'menu', title: 'Todo', sub: 'Typed in “' + (digestRoom() || 'digest') + '”, or under @digest in any room — filed here when you leave', html: html });
  }
  function sheetAction(a, target) {
    var s = V.sheet;
    if (!s) return;
    if (a === 'move') { showMoveBox(); return; }
    var i = s.i, it = s.kind === 'row' ? V.items[i] : null;
    closeSheet();
    if (a === 'toggle') toggleItem(i);
    else if (a === 'edit') startEdit(i);
    else if (a === 'maketodo') makeTodo(i);
    else if (a === 'source' && it) goRoom(it.room);
    else if (a === 'text' && it) showInText(it);
    else if (a === 'copy' && it) copyText(it.text);
    else if (a === 'delete') deleteItem(i);
    else if (a === 'clear') clearCompleted();
    else if (a === 'foldall') foldAll(true);
    else if (a === 'unfoldall') foldAll(false);
    else if (a === 'digest') goRoom(digestRoom());
    else if (a === 'textmode') setMode('text');
    else if (a === 'prefs') { try { Cade.prefs.open(ID); } catch (e) {} }
  }
  function copyText(t) {
    try { navigator.clipboard.writeText(t).then(function () { toast('Copied', 'success', 1000); }, function () { toast('Copy failed', 'error'); }); }
    catch (e) { toast('Copy failed', 'error'); }
  }
  function showInText(it) {
    var L = D.splitLines(cur()), n = D.locate(L, it.line, it.raw);
    setMode('text');
    if (n < 0) return;
    requestAnimationFrame(function () {
      try {
        var ln = Cade.editor.state.doc.line(n + 1);
        Cade.editor.dispatch({ selection: { anchor: ln.from, head: ln.to }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
        if (!isCoarse()) Cade.editor.focus();
      } catch (e) {}
    });
  }
  function goRoom(name) {
    if (!name) { toast('The digest and todo rooms need different names (Widget preferences)', 'info', 3200); return; }
    try {
      if (!roomExists(name)) Cade.roomsApi.ensureRoom(name);
      Promise.resolve(Cade.roomsApi.switchRoom(name)).catch(function () {});
    } catch (e) { console.error(e); }
  }

  // ---- visibility -------------------------------------------------------------------------
  function splitOpen() { var sp = document.getElementById('split-pane'); return !!(sp && !sp.hidden); }
  function applicable() {
    if (!D || !enabled() || pref('listView', true) === false || !Cade.editor) return false;
    if (activeRoom() !== todoRoom() || splitOpen()) return false;
    return !document.body.classList.contains('inbox-room');      // the clip inbox owns that room
  }
  function viewMode() { return Cade.store.get(MODE_KEY) === 'text' ? 'text' : 'list'; }
  function setMode(m) {
    try { Cade.store.set(MODE_KEY, m === 'text' ? 'text' : 'list'); } catch (e) {}
    sync();
    if (m === 'text' && !isCoarse()) { try { Cade.editor.focus(); } catch (e) {} }
  }
  function sync() {
    if (!V.inited) return;
    var ok = applicable(), mode = viewMode(), show = ok && mode === 'list';
    document.body.classList.toggle('dg-todo-room', ok);
    els.mode.hidden = !ok;
    els.mode.querySelectorAll('button[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode)); });
    if (show !== V.visible) {
      V.visible = show;
      els.view.hidden = !show;
      document.body.classList.toggle('dg-list-on', show);
      if (show) {
        try {
          var fp = document.getElementById('find-panel');
          if (fp && fp.classList.contains('open') && typeof window.closeFindPanel === 'function') window.closeFindPanel();
        } catch (e) {}
        try { Cade.editor.contentDOM.blur(); } catch (e) {}
        V.seen = null;
        V.focus = -1;
      } else {
        closeSheet();
        hideListUndo();
        V.editing = -1;
        V.adding = '';
      }
    }
    if (show) render();
    syncPill();
  }

  // ---- the pill: the digest room's count + "Digest now", an undo after one ----------------
  var undoPill = null;      // { job, room, timer }
  function showUndoPill(job, msg) {
    clearTimeout(undoPill && undoPill.timer);
    undoPill = { job: job, room: activeRoom(), msg: msg, timer: setTimeout(hideUndoPill, 8000) };
    syncPill();
  }
  function hideUndoPill() {
    if (undoPill) clearTimeout(undoPill.timer);
    undoPill = null;
    syncPill();
  }
  function schedulePill() { clearTimeout(V.pillTimer); V.pillTimer = setTimeout(syncPill, 150); }
  function syncPill() {
    if (!V.inited) return;
    var room = activeRoom(), p = els.pill, btn = function (k) { return p.querySelector('[data-pill="' + k + '"]'); };
    if (undoPill && undoPill.room !== room) { clearTimeout(undoPill.timer); undoPill = null; }
    var inDigest = !!D && enabled() && !!room && room === digestRoom() && !splitOpen();
    function say(long, short) { els.pillMsg.innerHTML = '<span class="long">' + esc(long) + '</span><span class="short">' + esc(short || long) + '</span>'; }
    btn('todo').lastChild.textContent = todoRoom();
    if (undoPill) {
      p.hidden = false;
      p.classList.add('done');
      say(undoPill.msg, undoPill.msg.replace(/ · .*$/, ''));
      btn('now').hidden = true;
      btn('undo').hidden = false;
      return;
    }
    p.classList.remove('done');
    btn('undo').hidden = true;
    if (!inDigest) { p.hidden = true; return; }
    var n = 0;
    try { n = D.extract(editorText(), { mode: 'room' }).entries.length; } catch (e) {}
    p.hidden = false;
    p.classList.toggle('empty', !n);
    if (n) say(n + (n === 1 ? ' item goes' : ' items go') + ' to ' + todoRoom() + ' when you leave', n + ' → ' + todoRoom());
    else say('Jot todos here — they move to ' + todoRoom() + ' when you leave', 'Jot todos here');
    btn('now').hidden = !n;
  }

  // ---- typing yy in the list's own inputs --------------------------------------------------
  function yyInField(input, e) {
    if (!yyOn() || (e && e.isComposing)) return;
    var pos = input.selectionStart;
    if (pos == null || pos !== input.selectionEnd || pos < 2) return;
    var v = input.value;
    if (v.slice(pos - 2, pos) !== 'yy' || !D.yyTrigger(v.slice(0, pos))) return;
    input.value = v.slice(0, pos - 2) + YEN + v.slice(pos);
    try { input.setSelectionRange(pos - 1, pos - 1); } catch (x) {}
  }
  function attachYy(input) { input.addEventListener('input', function (e) { yyInField(input, e); }); }

  // ---- wiring ----------------------------------------------------------------------------------
  function setQuery(v) {
    V.q = v;
    V.searchFolds = {};
    els.clear.hidden = !v;
    els.list.scrollTop = 0;
    V.focus = -1;
    render();
  }
  function toggleFacet(kind, val) {
    if (kind === 'when') V.f.when = V.f.when === val ? '' : val;
    else { var o = V.f[kind]; if (o[val]) delete o[val]; else o[val] = 1; }
    V.searchFolds = {};
    V.focus = -1;
    render();
  }
  function clearFilters() {
    V.f = { tag: {}, ws: {}, room: {}, when: '' };
    V.status = 'all';
    saveViewPrefs();
    els.q.value = '';
    setQuery('');
  }
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }

  function wire() {
    var list = els.list, secs = els.secs;
    secs.addEventListener('click', function (e) {
      var t = e.target.closest('[data-toggle], [data-more], [data-fold], [data-add], [data-ftag], [data-fs], [data-fr], [data-edit], [data-empty], a');
      if (!t) return;
      if (t.tagName === 'A') return;                          // links open as links
      if (t.hasAttribute('data-toggle')) { toggleItem(+t.getAttribute('data-toggle')); return; }
      if (t.hasAttribute('data-more')) { e.preventDefault(); openRowSheet(+t.getAttribute('data-more')); return; }
      if (t.hasAttribute('data-fold')) { toggleFold(t.getAttribute('data-fold')); return; }
      if (t.hasAttribute('data-add')) {
        var k = t.getAttribute('data-add');
        V.adding = V.adding === k ? '' : k;
        if (V.adding && V.folds[k]) { delete V.folds[k]; writeJSON(FOLDS_KEY, V.folds); }
        render(true);
        var inp = secs.querySelector('.dg-inline-in');
        if (inp) inp.focus();
        return;
      }
      if (t.hasAttribute('data-ftag')) { e.stopPropagation(); if (!V.f.tag[t.getAttribute('data-ftag')]) toggleFacet('tag', t.getAttribute('data-ftag')); return; }
      if (t.hasAttribute('data-fs')) { if (!V.f.ws[t.getAttribute('data-fs')]) toggleFacet('ws', t.getAttribute('data-fs')); return; }
      if (t.hasAttribute('data-fr')) { if (!V.f.room[t.getAttribute('data-fr')]) toggleFacet('room', t.getAttribute('data-fr')); return; }
      if (t.hasAttribute('data-edit')) { startEdit(+t.getAttribute('data-edit')); return; }
      if (t.getAttribute('data-empty') === 'clear') clearFilters();
      else if (t.getAttribute('data-empty') === 'digest') goRoom(digestRoom());
    });
    secs.addEventListener('keydown', function (e) {
      var inp = e.target.closest && e.target.closest('.dg-inline-in');
      if (!inp) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        var v = inp.value;
        if (v.trim()) {
          inp.value = '';
          addText(v, inp.getAttribute('data-addto'));
          // the section is rebuilt with the new row; keep typing in its fresh input
          render(true);
          var again = secs.querySelector('.dg-inline-in');
          if (again) again.focus();
        }
        else { V.adding = ''; inp.blur(); render(true); }
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); V.adding = ''; inp.blur(); render(true); }
    });
    // yy → ¥ in the inputs the list makes (edit box, inline add)
    secs.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.tagName === 'INPUT' && t.matches('.dg-inline-in, .dg-edit')) yyInField(t, e);
    });
    secs.addEventListener('focusout', function (e) {
      if (e.target.closest && e.target.closest('.dg-inline-in') && !e.target.value.trim()) {
        setTimeout(function () { if (!secs.contains(document.activeElement) || !document.activeElement.closest('.dg-inline-in')) { V.adding = ''; render(); } }, 150);
      } else if (V.pending) setTimeout(function () { if (V.pending && !editingNow()) render(); }, 0);
    });
    list.addEventListener('touchmove', function () { var a = document.activeElement; if (a === els.q) a.blur(); }, { passive: true });

    var filterClick = function (e) {
      var t = e.target.closest('[data-ft], [data-fw], [data-fs], [data-fr], [data-fclear]');
      if (!t) return;
      if (t.hasAttribute('data-fclear')) { V.f = { tag: {}, ws: {}, room: {}, when: '' }; render(); return; }
      if (t.hasAttribute('data-ft')) toggleFacet('tag', t.getAttribute('data-ft'));
      else if (t.hasAttribute('data-fw')) toggleFacet('when', t.getAttribute('data-fw'));
      else if (t.hasAttribute('data-fs')) toggleFacet('ws', t.getAttribute('data-fs'));
      else if (t.hasAttribute('data-fr')) toggleFacet('room', t.getAttribute('data-fr'));
    };
    els.filters.addEventListener('click', filterClick);
    els.active.addEventListener('click', filterClick);
    els.seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-status]');
      if (!b) return;
      V.status = b.getAttribute('data-status');
      saveViewPrefs();
      V.focus = -1;
      render();
    });
    els.fbtn.addEventListener('click', function () { V.filtersOpen = !V.filtersOpen; saveViewPrefs(); render(); });
    els.menu.addEventListener('click', openMenu);

    var qt = 0;
    els.q.addEventListener('input', function () {
      els.clear.hidden = !els.q.value;
      clearTimeout(qt);
      qt = setTimeout(function () { setQuery(els.q.value); }, 80);
    });
    els.q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); els.q.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (els.q.value) { els.q.value = ''; setQuery(''); } else els.q.blur(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); els.q.blur(); moveFocus(1); }
    });
    els.clear.addEventListener('click', function (e) { e.preventDefault(); els.q.value = ''; setQuery(''); els.q.focus(); });

    attachYy(els.addIn);
    els.addIn.addEventListener('input', function () { autosize(els.addIn); els.add.querySelector('.dg-add-go').hidden = !els.addIn.value.trim(); });
    els.addIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitAdd(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); els.addIn.value = ''; autosize(els.addIn); els.addIn.blur(); }
    });
    els.add.addEventListener('submit', function (e) { e.preventDefault(); submitAdd(); });
    function submitAdd() {
      var v = els.addIn.value;
      if (!v.trim()) return;
      if (addText(v, '')) { els.addIn.value = ''; autosize(els.addIn); els.add.querySelector('.dg-add-go').hidden = true; }
    }

    els.mode.addEventListener('click', function (e) { var b = e.target.closest('button[data-mode]'); if (b) setMode(b.getAttribute('data-mode')); });
    els.undoBtn.addEventListener('click', undoList);
    els.pill.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pill]');
      if (!b) return;
      var k = b.getAttribute('data-pill');
      if (k === 'now') digestOpen('button');
      else if (k === 'undo' && undoPill) undoJob(undoPill.job);
      else if (k === 'todo') goRoom(todoRoom());
    });

    els.sheet.addEventListener('click', function (e) {
      if (e.target === els.sheet) { closeSheet(); return; }
      var a = e.target.closest('[data-act]');
      if (a) { sheetAction(a.getAttribute('data-act'), a); return; }
      var m = e.target.closest('[data-moveto]');
      if (m && V.sheet) { var i = V.sheet.i; closeSheet(); moveItem(i, m.getAttribute('data-moveto')); }
    });
    els.sheet.addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = document.getElementById('dg-newgroup-in'), v = inp ? inp.value.trim() : '';
      if (!v || !V.sheet) return;
      var i = V.sheet.i;
      closeSheet();
      moveItem(i, v);
    });

    // keys while the list is up: / search · n add · j k ↑ ↓ move · x / Space tick · e / Enter edit · Delete · Esc
    document.addEventListener('keydown', function (e) {
      if (!els.sheet.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
      if (!V.visible || e.ctrlKey || e.metaKey || e.altKey || !els.sheet.hidden) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      var k = e.key, hit = true;
      // Space / Enter on a focused button or link keep doing what they do natively.
      if ((k === ' ' || k === 'Enter') && t && t.closest && t.closest('button, a')) return;
      if (k === '/') els.q.focus();
      else if (k === 'n' || k === 'a') els.addIn.focus();
      else if (k === 'j' || k === 'ArrowDown') moveFocus(1);
      else if (k === 'k' || k === 'ArrowUp') moveFocus(-1);
      else if ((k === 'x' || k === ' ') && V.focus >= 0) toggleItem(V.focus);
      else if ((k === 'e' || k === 'Enter') && V.focus >= 0) startEdit(V.focus);
      else if ((k === 'Delete' || k === 'Backspace') && V.focus >= 0) deleteItem(V.focus);
      else if (k === 'Escape' && (V.focus >= 0 || V.q)) { V.focus = -1; paintFocus(false); if (V.q) { els.q.value = ''; setQuery(''); } }
      else hit = false;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // Keep the last rows (and the pill) above the on-screen keyboard.
    var vv = window.visualViewport;
    if (vv) {
      var fit = function () {
        var r = els.wrap.getBoundingClientRect();
        var kb = Math.max(0, Math.round(r.bottom - (vv.offsetTop + vv.height)));
        els.wrap.style.setProperty('--dg-kb', kb + 'px');
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
    }
    // Nothing should focus the hidden editor while the list is up (on a phone
    // that would raise the keyboard over the list).
    Cade.editor.contentDOM.addEventListener('focus', function () { if (V.visible) Cade.editor.contentDOM.blur(); });
    // The split view needs the editor — the list steps aside while it's open.
    var sp = document.getElementById('split-pane');
    if (sp && window.MutationObserver) new MutationObserver(function () { sync(); }).observe(sp, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ============================================================================
  // BOOT
  // ============================================================================
  function registerCommands() {
    Cade.registerWidget({
      name: 'Digest now', icon: '↪',
      description: 'File the digest room — or this room’s @digest lines — into your todo list now (' + MOD + '+D)',
      tags: 'digest,todo,file,move,capture,inbox,tasks,@digest,send to todo',
      open: function () { try { Cade.closeAllMenus(); } catch (e) {} digestOpen('command'); },
    });
    Cade.registerWidget({
      name: 'Open Todo', icon: '☑',
      description: 'Your todo list — groups, tags, stats, filters by when and where things came from',
      tags: 'todo,todos,tasks,checklist,list,digest,done,stats',
      open: function () { goRoom(todoRoom()); },
    });
    Cade.registerWidget({
      name: 'Open Digest', icon: '📥',
      description: 'The capture room — anything typed there moves to your todo list when you leave',
      tags: 'digest,capture,inbox,quick,jot,todo,brain dump',
      open: function () { goRoom(digestRoom()); },
    });
    try {
      if (typeof Cade.addAtItem === 'function') {
        Cade.addAtItem({ name: 'digest', insert: '@digest', desc: 'Send the lines below to your todo list', kind: 'block', when: function () { return enabled() && pref('atDigest', true) !== false; } });
      }
    } catch (e) {}
  }

  function init() {
    if (V.inited || !Cade.editor) return;
    if (!buildDom()) return;
    V.inited = true;
    loadViewPrefs();
    Cade.registerPlugin({ id: ID, ext: [yyPlugin, yyInput, previewPlugin] });
    hookSwitch();
    window.addEventListener('keydown', onKeydown, true);
    wire();
    registerCommands();

    document.addEventListener('cade-room-switched', function () {
      V.editing = -1;
      V.adding = '';
      V.focus = -1;
      setTimeout(sync, 0);         // after the core's own post-switch work (the clip inbox's claim)
    });
    Cade.onEditorUpdate(function (u) {
      if (!u.docChanged) return;
      if (V.visible) scheduleRender();
      if (activeRoom() === digestRoom()) schedulePill();
    });
    try { var p = prefs(); if (p && p.on) p.on(function () { bumpDeco(); sync(); }); } catch (e) {}
    try { Cade.Settings.onChange(SETTING, function () { bumpDeco(); sync(); }); } catch (e) {}
    try { Cade.Settings.onChange('editor.tagSentinel', function () { if (V.visible) scheduleRender(); }); } catch (e) {}
    window.addEventListener('online', function () { setTimeout(replayJournal, 1500); });
    setTimeout(replayJournal, 3000);
    sync();
  }

  loadCore().then(function (core) {
    D = core;
    if (Cade.editor) init();
    else {
      var tries = 0, t = setInterval(function () { if (Cade.editor || ++tries > 100) { clearInterval(t); init(); } }, 100);
    }
  }, function (e) { console.error('Digest & Todo: ' + e.message); });
})();
