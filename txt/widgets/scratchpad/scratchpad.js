/* Scratchpad — a real editor for a note, in a panel.
 *
 * The panel holds its own CodeMirror view (the app's CodeMirror, the editor's
 * theme and wrapping, Markdown styling with the editor's own classes, undo /
 * redo, Tab indent, Ctrl/Cmd+B / I) editing one room — "scratchpad" by
 * default (made on first use), or any room picked in the panel's bar ("＋"
 * starts a new scratch note). The choice is remembered. Being a panel, it can
 * sit beside other panels, be popped out, or be tiled in the Layouts float
 * window (the always-on-top Picture-in-Picture window) — the view is re-rooted
 * in whichever document holds it.
 *
 * Saving: ~400 ms after typing stops (and on blur, Ctrl/Cmd+S, hiding the page,
 * closing) through Cade.roomsApi.write(room, text, { base }) — the same local
 * store + sync path as any edit, as a compare-and-swap against the text last
 * seen. Changes made elsewhere meanwhile come back merged and are folded into
 * the view without touching what was typed since (change sets mapped through
 * each other); a same-lines conflict is resolved by keeping both sides' text,
 * never by dropping either. Changes from other devices (roomsApi.watch +
 * onChange) and other tabs (storage events) are folded in the same way.
 *
 * The same room open in the main editor: the two are live-linked. Edits made
 * here go straight into the editor as transactions (so the editor saves and
 * syncs them), the editor's own changes (typing, remote edits) are mirrored
 * here; each side keeps its own undo history (the other side's edits are not
 * undoable from here). An identity check on the editor's document catches a
 * swap behind our back (room switch, reconcile) and re-syncs. When the editor
 * is in Read-only mode, so is the scratchpad.
 *
 * Pure helpers (room names, diffs, Markdown line styling, wrap toggling, the
 * sync decisions) are unit-tested: node txt/widgets/scratchpad/scratchpad.test.js */
(function () {
  'use strict';

  // ================= pure core =================
  var CORE = (function () {
    var DEFAULT_ROOM = 'scratchpad';

    // Room names as the core keeps them (trimmed, lower-case); '' when invalid.
    function normRoom(n) {
      var s = String(n == null ? '' : n).trim().toLowerCase();
      if (!s || s.indexOf('__') === 0 || s.length > 100) return '';
      return s;
    }
    function normText(t) { return String(t == null ? '' : t).replace(/\r\n?/g, '\n'); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    // A fresh room name for "New scratch note": scratch-YYYY-MM-DD[-n].
    function newScratchName(existing, date) {
      var d = date || new Date();
      var base = 'scratch-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      var have = {};
      (existing || []).forEach(function (x) { have[String(x).toLowerCase()] = 1; });
      if (!have[base]) return base;
      for (var i = 2; i < 10000; i++) if (!have[base + '-' + i]) return base + '-' + i;
      return base + '-' + Date.now().toString(36);
    }

    function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
    function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }
    // The smallest single replacement turning a into b (common start and end
    // kept, never splitting a surrogate pair) → { from, to, insert } or null.
    function diffRange(a, b) {
      a = String(a); b = String(b);
      if (a === b) return null;
      var n = Math.min(a.length, b.length), s = 0;
      while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
      if (s > 0 && isHigh(a.charCodeAt(s - 1))) s--;
      var ea = a.length, eb = b.length;
      while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
      if (ea < a.length && isLow(a.charCodeAt(ea))) { ea++; eb++; }
      return { from: s, to: ea, insert: b.slice(s, eb) };
    }

    // Markdown styling of one line, mirroring the editor's own classes
    // (cm-md-h1…3, cm-md-quote, cm-md-hr, cm-md-code, cm-md-bold/italic/strike
    // with cm-md-mark markers, cm-md-fence / cm-codeblock for ``` blocks).
    // inFence: inside a fenced block before this line. Returns
    // { line: class|null, marks: [[from, to, class]], fence: inFence after }.
    var FENCE_RE = /^\s{0,3}(```|~~~)/, H_RE = /^(#{1,3})\s+\S/, QUOTE_RE = /^>\s/,
      HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
    function mdLine(text, inFence) {
      var out = { line: null, marks: [], fence: !!inFence };
      if (FENCE_RE.test(text)) { out.line = 'cm-md-fence'; out.fence = !inFence; return out; }
      if (inFence) { out.line = 'cm-codeblock'; return out; }
      var h = text.match(H_RE);
      if (h) { out.line = 'cm-md-h' + h[1].length; out.marks.push([0, h[1].length, 'cm-md-hashes']); }
      else if (QUOTE_RE.test(text)) out.line = 'cm-md-quote';
      else if (HR_RE.test(text) && text.trim().length >= 3) { out.line = 'cm-md-hr'; return out; }
      // inline code first; emphasis isn't looked for inside it
      var code = [], m, re = /`([^`\n]+)`/g;
      while ((m = re.exec(text)) !== null) { code.push([m.index, m.index + m[0].length]); out.marks.push([m.index, m.index + m[0].length, 'cm-md-code']); }
      function inCode(s, e) { for (var i = 0; i < code.length; i++) if (s < code[i][1] && e > code[i][0]) return true; return false; }
      function emph(re, open, close, cls, skip) {
        re.lastIndex = 0;
        var x;
        while ((x = re.exec(text)) !== null) {
          var s = x.index, e = s + x[0].length;
          if (inCode(s, e) || (skip && skip(s, e))) { re.lastIndex = s + 1; continue; }
          out.marks.push([s, s + open, 'cm-md-mark']);
          if (e - close > s + open) out.marks.push([s + open, e - close, cls]);
          out.marks.push([e - close, e, 'cm-md-mark']);
        }
      }
      emph(/\*\*([^*\n]+?)\*\*/g, 2, 2, 'cm-md-bold');
      emph(/__([^_\n]+?)__/g, 2, 2, 'cm-md-bold');
      emph(/\*([^*\n]+?)\*/g, 1, 1, 'cm-md-italic', function (s, e) { return text[s - 1] === '*' || text[e] === '*' || text[s + 1] === '*'; });
      emph(/_([^_\n]+?)_/g, 1, 1, 'cm-md-italic', function (s, e) {
        return text[s - 1] === '_' || text[e] === '_' || text[s + 1] === '_' || /[A-Za-z0-9]/.test(text[s - 1] || '') || /[A-Za-z0-9]/.test(text[e] || '');
      });
      emph(/~~([^~\n]+?)~~/g, 2, 2, 'cm-md-strike');
      out.marks.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      return out;
    }

    // Toggle a Markdown wrapper (** or *) around [from, to) of text.
    // → { changes: [{from, to, insert}], anchor, head } (positions after the change).
    function runLen(text, at, ch, dir) {
      var n = 0;
      if (dir < 0) { while (at - n - 1 >= 0 && text[at - n - 1] === ch) n++; }
      else { while (at + n < text.length && text[at + n] === ch) n++; }
      return n;
    }
    function toggleWrap(text, from, to, mark) {
      var m = mark.length, sel = text.slice(from, to), ch = mark[0];
      var r1 = runLen(text, from, ch, -1), r2 = runLen(text, to, ch, 1);
      if (r1 === r2 && (r1 === m || r1 === 3)) {
        return { changes: [{ from: from - m, to: from, insert: '' }, { from: to, to: to + m, insert: '' }], anchor: from - m, head: to - m };
      }
      if (sel.length >= 2 * m && sel.slice(0, m) === mark && sel.slice(-m) === mark && runLen(sel, 0, ch, 1) === runLen(sel, sel.length, ch, -1)) {
        return { changes: [{ from: from, to: to, insert: sel.slice(m, sel.length - m) }], anchor: from, head: to - 2 * m };
      }
      return { changes: [{ from: from, to: to, insert: mark + sel + mark }], anchor: from + m, head: to + m };
    }

    // Text that arrived for the room (another device / tab, a merge): what to do.
    //  'none'   nothing new (or the editor link owns the text)
    //  'defer'  a save is in flight — its result carries the room's text
    //  'base'   the view already shows it; just remember it as the base
    //  'adopt'  nothing unsaved here — take it as is
    //  'rebase' unsaved typing here — fold the change in around it
    function planIncoming(o) {
      if (o.live || o.incoming == null || o.incoming === o.base) return 'none';
      if (o.saving) return 'defer';
      if (o.doc === o.incoming) return 'base';
      if (o.doc === o.base) return 'adopt';
      return 'rebase';
    }
    // Linking with the main editor: 'same' / 'adopt' (take the editor's text)
    // / 'merge' (unsaved typing here — merge into the editor first).
    function planEnterLive(o) {
      if (o.doc === o.main) return 'same';
      if (o.doc === o.base) return 'adopt';
      return 'merge';
    }
    // A main-editor update while linked: 'ignore' / 'track' (our own forwarded
    // change — just remember the editor's new doc) / 'apply' (mirror its
    // changes) / 'resync' (the editor's doc moved without us seeing it).
    function mainAction(o) {
      if (!o.live) return 'ignore';
      if (o.forwarding) return 'track';
      if (!o.docChanged) return o.docIsRef ? 'ignore' : 'resync';
      return o.startIsRef ? 'apply' : 'resync';
    }
    // The picker's rows: ordered rooms (archived ones only when current), the
    // current room always present.
    function roomOptions(list, current, isArchived) {
      var out = [], seen = {};
      (list || []).forEach(function (r) {
        if (seen[r]) return;
        if (isArchived && isArchived(r) && r !== current) return;
        seen[r] = 1; out.push({ value: r, label: r });
      });
      if (current && !seen[current]) out.unshift({ value: current, label: current + ' (not in the room list)' });
      return out;
    }
    // Status line → { text, cls, title }.
    function statusOf(s) {
      if (s.unavailable) return { text: 'Unavailable', cls: 'err', title: 'This note can’t be read here right now' };
      if (s.loading) return { text: 'Loading…', cls: '', title: '' };
      if (s.live) return s.mainRO ? { text: 'Read-only', cls: 'live', title: 'Read-only mode is on in the main editor' }
        : { text: '● Linked', cls: 'live', title: 'Also open in the main editor — edits show up in both and are saved there' };
      if (s.err === 'offline') return { text: 'Offline — not saved', cls: 'err', title: 'The note isn’t on this device and the server can’t be reached; retrying when back online' };
      if (s.err === 'locked') return { text: 'Locked', cls: 'err', title: 'Password-protected note — unlock it in the app to edit here' };
      if (s.err) return { text: 'Not saved', cls: 'err', title: 'Saving failed (' + s.err + ') — will retry' };
      if (s.saving) return { text: 'Saving…', cls: '', title: '' };
      if (s.dirty) return { text: 'Edited', cls: '', title: 'Saves when you pause' };
      return { text: 'Saved', cls: 'ok', title: 'Saved and synced like any note' };
    }

    // The app's own shortcuts are handled in the capture phase on its document
    // — before any editor sees the key — and act on the MAIN editor (Ctrl+L
    // clears it, Ctrl+D toggles a todo, Ctrl+B bolds…). For a key typed in the
    // scratchpad: 'pass' (the app's navigation / palette keys, and every key
    // the app doesn't claim — the scratchpad's CodeMirror gets those), 'block'
    // (would change the main editor), or a scratchpad command to run instead:
    // 'bold' / 'italic' / 'underline' / 'save'.
    var DEFAULT_HOTKEYS = { openPicker: 'Ctrl+K', rerunScript: 'Ctrl+Shift+K', clearEditor: 'Ctrl+L', importFiles: 'Ctrl+Shift+I',
      importFolder: '', uploadFiles: 'Ctrl+Shift+U', openSync: 'Ctrl+S', forceSync: 'Ctrl+Shift+S', toggleTodo: 'Ctrl+D',
      findReplace: 'Ctrl+F', gotoLine: 'Ctrl+G' };
    var HOTKEY_ACTION = { openPicker: 'pass', rerunScript: 'block', clearEditor: 'block', importFiles: 'block', importFolder: 'pass',
      uploadFiles: 'block', openSync: 'save', forceSync: 'pass', toggleTodo: 'block', findReplace: 'pass', gotoLine: 'block' };
    function hotkeyMatch(e, str, isMac) {
      if (!str || typeof e.key !== 'string') return false;
      var parts = String(str).toLowerCase().split('+');
      var ctrl = isMac ? !!e.metaKey : !!e.ctrlKey;
      return ctrl === (parts.indexOf('ctrl') >= 0 || parts.indexOf('mod') >= 0) && !!e.shiftKey === (parts.indexOf('shift') >= 0) &&
        !!e.altKey === (parts.indexOf('alt') >= 0) && e.key.toLowerCase() === parts[parts.length - 1];
    }
    function classifyKey(e, hotkeys, scriptHotkeys, isMac) {
      if (typeof e.key !== 'string') return 'pass';
      var hk = {}, id;
      for (id in DEFAULT_HOTKEYS) hk[id] = DEFAULT_HOTKEYS[id];
      if (hotkeys) for (id in hotkeys) if (Object.prototype.hasOwnProperty.call(hk, id)) hk[id] = hotkeys[id];
      for (id in HOTKEY_ACTION) if (hotkeyMatch(e, hk[id], isMac)) return HOTKEY_ACTION[id];
      var mod = isMac ? !!e.metaKey : !!e.ctrlKey, k = e.key.toLowerCase();
      var quick = mod && !e.shiftKey && !e.altKey && k === 'p';
      if (!quick && scriptHotkeys) for (var s in scriptHotkeys) if (hotkeyMatch(e, s, isMac)) return 'block';
      if (mod && !e.shiftKey && !e.altKey) {
        if (k === 'b') return 'bold';
        if (k === 'i') return 'italic';
        if (k === 'u') return 'underline';
      }
      return 'pass';
    }

    return {
      DEFAULT_HOTKEYS: DEFAULT_HOTKEYS, hotkeyMatch: hotkeyMatch, classifyKey: classifyKey,
      DEFAULT_ROOM: DEFAULT_ROOM, normRoom: normRoom, normText: normText, newScratchName: newScratchName,
      diffRange: diffRange, mdLine: mdLine, toggleWrap: toggleWrap, planIncoming: planIncoming,
      planEnterLive: planEnterLive, mainAction: mainAction, roomOptions: roomOptions, statusOf: statusOf
    };
  })();
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= UI =================
  var Cade = window.Cade, CM = Cade.CM;
  var NAME = 'Scratchpad';
  var WIDGET = {
    name: NAME,
    description: 'A full editor for any note in a panel — keep a scratch note beside your work or tiled in the float window',
    icon: '📝',
    tags: 'scratchpad,scratch,note,notes,editor,room,pad,jot,side,panel,float,workspace,layout',
    open: toggle
  };
  if (!CM || !CM.EditorView || !CM.EditorState) { Cade.registerWidget(WIDGET); return; }
  Cade.loadCSS('scratchpad.css');

  var PANEL_ID = 'scratchpad-panel', K_ROOM = 'cade-scratchpad-room', REASON = 'scratchpad', SAVE_MS = 400;
  var S = null;   // the open panel's session

  function api() { return Cade.roomsApi || null; }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml(String(s)); }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2600); } catch (e) {} }
  function docText() { return S.view.state.doc.toString(); }
  function openInMain() { var a = api(); return !!(a && S && S.room && a.activeRoom() === S.room); }
  function roomExists(n) { var a = api(); return !!(a && n && a.list().indexOf(n) >= 0); }

  // ---- CodeMirror plumbing (classes reached through instances: the bundle
  //      exports neither Transaction nor ChangeSet) ----
  function noHistory() { return S.T && S.T.addToHistory ? [S.T.addToHistory.of(false)] : []; }
  function csEmpty(len) { return S.CS.empty ? S.CS.empty(len) : S.CS.of([], len); }
  function csDiff(a, b) { var d = CORE.diffRange(a, b); return S.CS.of(d ? [d] : [], a.length); }
  // Apply a change that came from elsewhere: not undoable here, not saved again.
  function applyOutside(changes, undoable) {
    if (!changes || (changes.empty === true)) return;
    S.applying = true;
    try { S.view.dispatch({ changes: changes, annotations: undoable ? [] : noHistory() }); }
    finally { S.applying = false; }
  }

  var mdDecoCache = {};
  function mdDeco(kind, cls) {
    var k = kind + cls;
    return mdDecoCache[k] || (mdDecoCache[k] = kind === 'l' ? CM.Decoration.line({ class: cls }) : CM.Decoration.mark({ class: cls }));
  }
  function buildMd(view) {
    var doc = view.state.doc, ranges = [], vis = view.visibleRanges;
    if (!vis.length) return CM.Decoration.none;
    var firstVis = doc.lineAt(vis[0].from).number, lastVis = doc.lineAt(vis[vis.length - 1].to).number;
    var start = doc.lines > 4000 ? Math.max(1, firstVis - 400) : 1, inFence = false;
    for (var i = start; i <= lastVis; i++) {
      var line = doc.line(i), r = CORE.mdLine(line.text, inFence);
      inFence = r.fence;
      if (i < firstVis) continue;
      var shown = false;
      for (var j = 0; j < vis.length; j++) if (line.to >= vis[j].from && line.from <= vis[j].to) { shown = true; break; }
      if (!shown) continue;
      if (r.line) ranges.push(mdDeco('l', r.line).range(line.from));
      for (var k = 0; k < r.marks.length; k++) {
        var mk = r.marks[k];
        if (mk[1] > mk[0]) ranges.push(mdDeco('m', mk[2]).range(line.from + mk[0], line.from + mk[1]));
      }
    }
    return CM.Decoration.set(ranges, true);
  }
  function MdView(view) { this.decorations = buildMd(view); }
  MdView.prototype.update = function (u) { if (u.docChanged || u.viewportChanged) this.decorations = buildMd(u.view); };
  var mdPlugin = CM.ViewPlugin ? CM.ViewPlugin.fromClass(MdView, { decorations: function (v) { return v.decorations; } }) : [];

  function wrapCmd(mark) {
    return function (view) {
      if (view.state.readOnly) return false;
      var sel = view.state.selection.main, r = CORE.toggleWrap(view.state.doc.toString(), sel.from, sel.to, mark);
      view.dispatch({ changes: r.changes, selection: { anchor: r.anchor, head: r.head }, userEvent: 'input' });
      return true;
    };
  }
  function underlineCmd(view) {
    if (view.state.readOnly) return false;
    var sel = view.state.selection.main, text = view.state.doc.toString(), a = '<u>', b = '</u>';
    if (text.slice(sel.from - 3, sel.from) === a && text.slice(sel.to, sel.to + 4) === b) {
      view.dispatch({ changes: [{ from: sel.from - 3, to: sel.from }, { from: sel.to, to: sel.to + 4 }], selection: { anchor: sel.from - 3, head: sel.to - 3 }, userEvent: 'input' });
    } else {
      view.dispatch({ changes: [{ from: sel.from, insert: a }, { from: sel.to, insert: b }], selection: { anchor: sel.from + 3, head: sel.to + 3 }, userEvent: 'input' });
    }
    return true;
  }
  function indentCmd(dir) {
    return function (view) {
      if (view.state.readOnly) return false;
      var st = view.state, sel = st.selection.main, doc = st.doc;
      var a = doc.lineAt(sel.from).number, b = doc.lineAt(sel.to).number, ch = [];
      if (dir > 0 && a === b && sel.empty) { view.dispatch(st.replaceSelection('    '), { userEvent: 'input' }); return true; }
      for (var i = a; i <= b; i++) {
        var l = doc.line(i);
        if (dir > 0) ch.push({ from: l.from, insert: '    ' });
        else { var sp = l.text.match(/^ {1,4}/); if (sp) ch.push({ from: l.from, to: l.from + sp[0].length }); }
      }
      if (ch.length) view.dispatch({ changes: ch, userEvent: dir > 0 ? 'input.indent' : 'input.dedent' });
      return true;
    };
  }
  function roExt(ro) { return [CM.EditorState.readOnly.of(!!ro), CM.EditorView.editable.of(true)]; }
  function extensions() {
    var prec = function (x) { return CM.Prec && CM.Prec.highest ? CM.Prec.highest(x) : x; };
    return [
      // first, so they win over readOnlyExtensions' read-only facets (first value wins)
      prec(S.roComp.of(roExt(S.ro))),
      CM.Prec && CM.Prec.high ? CM.Prec.high(CM.keymap.of(keys())) : CM.keymap.of(keys()),
      CM.basicSetup || [],
      Cade.readOnlyExtensions ? Cade.readOnlyExtensions() : [CM.EditorView.lineWrapping],
      mdPlugin,
      CM.EditorView.updateListener.of(onLocalUpdate),
      CM.EditorView.contentAttributes ? CM.EditorView.contentAttributes.of({ 'aria-label': 'Scratchpad note', spellcheck: 'true' }) : []
    ];
  }
  function keys() {
    return [
      { key: 'Mod-s', run: function () { flush(); return true; } },
      { key: 'Mod-b', run: wrapCmd('**') },
      { key: 'Mod-i', run: wrapCmd('*') },
      { key: 'Mod-u', run: underlineCmd },
      { key: 'Tab', run: indentCmd(1) },
      { key: 'Shift-Tab', run: indentCmd(-1) }
    ];
  }

  // ---- read-only / status painting ----
  function wantRO() {
    return !!(S.loading || S.unavailable || S.settling || S.err === 'locked' || (S.live && S.mainRO));
  }
  function paint() {
    if (!S) return;
    var ro = wantRO();
    if (ro !== S.ro) { S.ro = ro; S.view.dispatch({ effects: S.roComp.reconfigure(roExt(ro)) }); }
    var st = CORE.statusOf({ unavailable: S.unavailable, loading: S.loading, live: S.live, mainRO: S.mainRO, err: S.err,
      saving: S.saving, dirty: !S.live && !S.loading && docText() !== S.base });
    S.status.textContent = st.text;
    S.status.className = 'sp-status' + (st.cls ? ' ' + st.cls : '');
    S.status.title = st.title;
    var msg = '', retry = false;
    if (S.unavailable) { msg = 'Can’t open “' + S.room + '” here right now — it may be password-locked, or offline and not kept on this device.'; retry = true; }
    else if (S.deleted) msg = 'This note was removed elsewhere. Keep typing to bring it back, or pick another note.';
    else if (S.live && S.mainRO) msg = 'Read-only mode is on — turn it off in the app to edit.';
    else if (S.err === 'locked') msg = 'This note is password-locked — unlock it in the app to edit it here.';
    else if (S.live) msg = 'Also open in the main editor — both stay in step.';
    S.banner.hidden = !msg;
    S.banner.className = 'sp-banner' + (S.live && !S.mainRO ? ' info' : '');
    S.banner.innerHTML = msg ? esc(msg) + (retry ? ' <button type="button" class="sp-link" data-act="retry">Retry</button>' : '') : '';
    S.panel.classList.toggle('sp-linked', !!S.live);
    fillPicker();
  }
  function fillPicker() {
    var a = api(); if (!a || !S) return;
    var list = a.list();
    try { list = a.orderRooms(list); } catch (e) {}
    var opts = CORE.roomOptions(list, S.room, function (r) { try { return a.isArchived(r); } catch (e) { return false; } });
    var sig = opts.map(function (o) { return o.value + '\u0001' + o.label; }).join('\u0002');
    if (sig !== S.pickSig) {
      S.pickSig = sig;
      S.pick.innerHTML = opts.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('');
    }
    if (S.pick.value !== S.room) S.pick.value = S.room;
  }

  // ---- saving (not linked) ----
  function scheduleSave(ms) {
    clearTimeout(S.saveT);
    var me = S;
    S.saveT = setTimeout(function () { if (S === me) save(); }, ms == null ? SAVE_MS : ms);
  }
  function save() {
    if (!S) return Promise.resolve();
    var me = S;
    clearTimeout(S.saveT);
    if (S.live || S.loading || S.unavailable || S.settling) return Promise.resolve();
    if (S.saving) { S.saveAgain = true; return S.savePromise; }
    var text = docText();
    if (text === S.base) { paint(); return Promise.resolve(); }
    var a = api(); if (!a) return Promise.resolve();
    var room = S.room, tok = S.loadTok;
    S.saving = true; S.sent = text; S.sinceSend = csEmpty(text.length);
    paint();
    var p = a.write(room, text, { base: S.base, reason: REASON, create: true }).then(function (r) {
      if (S !== me || me.loadTok !== tok) return;
      me.err = null; me.deleted = false;
      var got = CORE.normText(r && r.text != null ? r.text : text);
      if (got === me.sent) { me.base = got; me.local = me.sinceSend; }
      else {                                            // merged with edits made elsewhere
        var d = csDiff(me.sent, got);
        applyOutside(d.map(me.sinceSend));
        me.local = me.sinceSend.map(d, true);
        me.base = got;
      }
    }, function (e) {
      if (S !== me || me.loadTok !== tok) return;
      var code = (e && e.code) || 'error';
      if (code === 'conflict' && typeof e.current === 'string') {
        // both sides changed the same lines: keep both — fold theirs in around ours
        rebaseOnto(CORE.normText(e.current));
        me.err = null; me.saveAgain = true;
        toast('Scratchpad: “' + room + '” was also changed elsewhere — both versions were kept', 'info', 4000);
      } else if (code === 'busy') { me.err = null; me.retryMs = 900; me.saveAgain = true; }
      else me.err = code;
    }).then(function () {
      if (S !== me) return;
      me.saving = false; me.sinceSend = null; me.savePromise = null;
      if (me.loadTok !== tok) return;
      if (me.recheckAfter) { me.recheckAfter = false; recheck(); }
      var again = me.saveAgain; me.saveAgain = false;
      if (!me.err && (again || docText() !== me.base)) scheduleSave(me.retryMs || 0);
      me.retryMs = 0;
      paint();
    });
    S.savePromise = p;
    return p;
  }
  function flush() { if (!S) return Promise.resolve(); clearTimeout(S.saveT); return save(); }
  function idle() { return S && S.savePromise ? S.savePromise.then(idle) : Promise.resolve(); }

  // The room's text moved on from our base (another device, tab, a merge):
  // fold that change in around whatever is unsaved here.
  function rebaseOnto(text) {
    var delta = csDiff(S.base, text);
    applyOutside(delta.map(S.local));
    S.local = S.local.map(delta, true);
    S.base = text;
  }
  function takeIncoming(text) {
    text = CORE.normText(text);
    var plan = CORE.planIncoming({ live: S.live, incoming: text, base: S.base, saving: S.saving, doc: docText() });
    if (plan === 'defer') { S.recheckAfter = true; return; }
    if (plan === 'base') { S.base = text; S.local = csEmpty(text.length); }
    else if (plan === 'adopt' || plan === 'rebase') { rebaseOnto(text); if (plan === 'rebase') scheduleSave(); }
    if (plan !== 'none') paint();
  }
  function recheck() {
    if (!S || S.live || S.loading || S.unavailable || S.settling) return;
    if (S.saving) { S.recheckAfter = true; return; }
    var me = S, tok = S.loadTok, a = api();
    if (!a) return;
    Promise.resolve(a.read(S.room)).then(function (t) {
      if (S !== me || me.loadTok !== tok || me.live || me.settling || t == null) return;
      takeIncoming(t);
    }, function () {});
  }
  function recheckSoon() {
    if (!S) return;
    var me = S;
    clearTimeout(S.checkT);
    S.checkT = setTimeout(function () { if (S === me) recheck(); }, 150);
  }

  // ---- edits made in the scratchpad ----
  function onLocalUpdate(u) {
    if (!S || u.view !== S.view || !u.docChanged || S.applying) return;
    if (S.live) { forwardToMain(u); return; }
    S.local = S.local.compose(u.changes);
    if (S.saving && S.sinceSend) S.sinceSend = S.sinceSend.compose(u.changes);
    scheduleSave();
    paintSoon();
  }
  function paintSoon() {
    if (S.paintQ) return;
    S.paintQ = true;
    var me = S;
    requestAnimationFrame(function () { if (S === me) { me.paintQ = false; paint(); } });
  }

  // ---- the link with the main editor (same room open there) ----
  function forwardToMain(u) {
    var ed = Cade.editor;
    if (!ed || !openInMain()) { S.live = false; S.base = u.startState.doc.toString(); S.local = csEmpty(S.base.length).compose(u.changes); scheduleSave(); paintSoon(); return; }
    if (ed.state.doc !== S.mainRef) {
      // the editor's document changed without an update we saw — merge through the core
      var before = u.startState.doc.toString(), mine = u.state.doc.toString(), me = S;
      S.live = false; S.settling = true; paintSoon();
      Promise.resolve(api().write(S.room, mine, { base: before, reason: REASON })).catch(function () {}).then(function () {
        if (S !== me) return;
        me.settling = false; me.base = before; me.local = csEmpty(before.length);
        enterLive(true);
      });
      return;
    }
    S.forwarding = true;
    try { ed.dispatch({ changes: u.changes, annotations: noHistory(), userEvent: 'input.api' }); }
    finally { S.forwarding = false; }
    S.mainRef = ed.state.doc;
  }
  function onMainUpdate(u) {
    if (!S || !S.live) return;
    if (S.forwarding) { S.mainRef = u.state.doc; return; }   // our own change, mid-update of the scratchpad
    if (!openInMain()) return;
    if (u.state.readOnly !== S.mainRO) { S.mainRO = u.state.readOnly; paint(); }
    var act = CORE.mainAction({ live: S.live, forwarding: S.forwarding, docChanged: u.docChanged,
      startIsRef: u.startState.doc === S.mainRef, docIsRef: u.state.doc === S.mainRef });
    if (act === 'track') S.mainRef = u.state.doc;
    else if (act === 'apply') { applyOutside(u.changes); S.mainRef = u.state.doc; }
    else if (act === 'resync') resyncFromMain();
  }
  function resyncFromMain() {
    var ed = Cade.editor; if (!ed) return;
    applyOutside(csDiff(docText(), ed.state.doc.toString()));
    S.mainRef = ed.state.doc;
  }
  async function enterLive(force) {
    if (!S || (S.live && !force) || S.loading || S.unavailable || !openInMain()) return;
    var me = S, tok = ++S.liveTok;
    clearTimeout(S.saveT);
    S.settling = true; paint();
    try { await flushThenIdle(); } catch (e) {}
    if (S !== me || me.liveTok !== tok) return;
    var ed = Cade.editor;
    if (!ed || !openInMain()) { me.settling = false; paint(); return; }
    var doc = docText(), plan = CORE.planEnterLive({ base: me.base, doc: doc, main: ed.state.doc.toString() }), keepMine = false;
    if (plan === 'merge') {
      try { await api().write(me.room, doc, { base: me.base, reason: REASON }); }
      catch (e) { keepMine = true; }
      if (S !== me || me.liveTok !== tok) return;
      if (!openInMain()) { me.settling = false; paint(); recheck(); return; }
    }
    // the editor's text is the truth from here on
    applyOutside(csDiff(docText(), ed.state.doc.toString()), keepMine);
    if (keepMine) toast('Scratchpad: the main editor’s version is shown — Ctrl/Cmd+Z in the scratchpad brings yours back', 'info', 5000);
    me.live = true; me.mainRef = ed.state.doc; me.mainRO = !!ed.state.readOnly;
    me.base = docText(); me.local = csEmpty(me.base.length); me.err = null;
    me.settling = false;
    paint();
  }
  function flushThenIdle() { return flush().then(idle); }
  function leaveLive() {
    if (!S || !S.live) return;
    S.live = false; S.mainRef = null; S.liveTok++;
    S.base = docText(); S.local = csEmpty(S.base.length);   // the editor persisted exactly this on its way out
    paint();
  }
  function onRoomSwitched(e) {
    if (!S) return;
    var room = e && e.detail && e.detail.room;
    if (room === S.room) enterLive(S.live);   // re-check even when linked: the editor's state was replaced
    else if (S.live) { leaveLive(); recheckSoon(); }
  }

  // ---- loading a room ----
  async function load(name) {
    var a = api(); if (!a || !S) return;
    var me = S, tok = ++S.loadTok;
    S.liveTok++; S.live = false; S.mainRef = null;
    S.room = name; S.loading = true; S.unavailable = false; S.err = null; S.deleted = false;
    sset(K_ROOM, name);
    if (S.unwatch) { try { S.unwatch(); } catch (e) {} S.unwatch = null; }
    paint();
    var text = null;
    try {
      if (!roomExists(name)) {
        var r = await a.write(name, '', { create: true, reason: REASON });
        text = r && r.text != null ? r.text : '';
      } else text = await a.read(name);
    } catch (e) { text = null; }
    if (S !== me || me.loadTok !== tok) return;
    S.loading = false;
    if (text == null) { S.unavailable = true; S.base = ''; replaceState(''); paint(); return; }
    text = CORE.normText(text);
    S.base = text; S.local = csEmpty(text.length);
    replaceState(text);
    try { S.unwatch = a.watch([name]); } catch (e) { S.unwatch = null; }
    paint();
    if (openInMain()) enterLive();
  }
  // A fresh state per room: its own undo history, caret at the end.
  function replaceState(text) {
    S.view.setState(CM.EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: extensions() }));
  }
  async function switchTo(name) {
    name = CORE.normRoom(name);
    if (!S || !name || name === S.room) { if (S) paint(); return; }
    var me = S;
    if (!S.live) { try { await flushThenIdle(); } catch (e) {} }
    if (S !== me) return;
    await load(name);
    if (S === me) S.view.focus();
  }
  async function newNote() {
    var a = api(); if (!a || !S) return;
    var name = CORE.newScratchName(a.list(), new Date());
    await switchTo(name);
  }

  // ---- room events ----
  function onRoomChange(name, text, info) {
    if (!S || !info) return;
    if (info.kind === 'rename' && info.from === S.room) {
      S.room = name; sset(K_ROOM, name);
      if (S.unwatch) { try { S.unwatch(); } catch (e) {} }
      try { S.unwatch = api().watch([name]); } catch (e) { S.unwatch = null; }
      paint(); return;
    }
    if (name !== S.room) { if (info.kind !== 'text') paint(); return; }
    if (info.kind === 'delete') {
      if (S.live) leaveLive();
      // what's here is all ours now: a later save recreates the room with it
      S.deleted = true; S.base = ''; S.local = csDiff('', docText());
      paint(); return;
    }
    if (info.kind === 'text' && !S.live) recheckSoon();
  }
  function onStorage(e) {
    if (!S || S.live || !e || !e.key) return;
    if (e.key.indexOf('cade-room-cache:' + S.room) === 0) recheckSoon();
    else if (e.key === 'cade-rooms') paint();
  }
  function onVisible() {
    if (!S) return;
    if (document.visibilityState === 'hidden') flush();
    else recheckSoon();
  }
  function onPageHide() { if (S) flush(); }
  function onOnline() { if (S && S.err) { S.err = null; scheduleSave(0); paint(); } }

  // ---- moving between windows (pop out / float window) ----
  function onMoved() {
    if (!S) return;
    var d = S.panel.ownerDocument;
    try {
      if (typeof S.view.setRoot === 'function') S.view.setRoot(d);
      else rebuildView();
    } catch (e) { rebuildView(); }
    watchSize();
    S.view.requestMeasure();
    var me = S;
    requestAnimationFrame(function () { if (S === me) me.view.requestMeasure(); });
  }
  // Fallback when setRoot is missing: a new view with the same state (doc, selection, history).
  function rebuildView() {
    var state = S.view.state;
    try { S.view.destroy(); } catch (e) {}
    S.view = new CM.EditorView({ state: state, parent: S.host, root: S.panel.ownerDocument });
    wireView();
  }
  function watchSize() {
    if (S.ro2) { try { S.ro2.disconnect(); } catch (e) {} S.ro2 = null; }
    var w = S.panel.ownerDocument.defaultView;
    if (!w || !w.ResizeObserver) return;
    var me = S;
    S.ro2 = new w.ResizeObserver(function () { if (S === me) me.view.requestMeasure(); });
    S.ro2.observe(S.host);
  }
  function wireView() {
    S.view.contentDOM.addEventListener('blur', function () { if (S) flush(); });
  }

  // Keys typed in the scratchpad belong to it. The app's shortcuts run in the
  // capture phase on its document and act on the main editor (Ctrl+L clears
  // it!), so a capture listener on the window — which runs first — keeps
  // those away from the app while the key is aimed at this panel (see
  // classifyKey). In a pop-out / float window the app's handlers never see
  // the keys at all.
  function readJSON(k) { try { return JSON.parse(sget(k) || 'null'); } catch (e) { return null; } }
  function onWinKey(e) {
    if (!S || !e.target || !S.body.contains(e.target)) return;
    var isMac = /mac/i.test(navigator.platform || '');
    var act = CORE.classifyKey(e, readJSON('cade-hotkeys'), readJSON('cade-script-hotkeys'), isMac);
    if (act === 'pass') return;
    e.preventDefault(); e.stopPropagation();
    if (!S.view.contentDOM.contains(e.target)) return;
    if (act === 'bold') wrapCmd('**')(S.view);
    else if (act === 'italic') wrapCmd('*')(S.view);
    else if (act === 'underline') underlineCmd(S.view);
    else if (act === 'save') flush();
  }
  // Bubbling keys stay in the panel too (Escape and the palette / quick switcher excepted).
  function onKeyDown(e) {
    var k = (e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (k === 'escape') return;
    if (mod && !e.altKey && (k === 'k' || k === 'p') && !e.shiftKey) return;
    e.stopPropagation();
  }

  // ---- open / close ----
  function build(panel) {
    var body = panel.querySelector('.cade-panel-body');
    body.innerHTML =
      '<div class="sp-bar">' +
        '<select class="sp-room" aria-label="Note to edit" title="Note to edit"></select>' +
        '<button type="button" class="sp-btn" data-act="new" title="New scratch note" aria-label="New scratch note">＋</button>' +
        '<button type="button" class="sp-btn" data-act="open" title="Open this note in the main editor" aria-label="Open in the main editor">↗</button>' +
        '<span class="sp-status" aria-live="polite"></span>' +
      '</div>' +
      '<div class="sp-banner" hidden></div>' +
      '<div class="sp-ed"></div>';
    S = {
      panel: panel, body: body, host: body.querySelector('.sp-ed'), pick: body.querySelector('.sp-room'),
      status: body.querySelector('.sp-status'), banner: body.querySelector('.sp-banner'),
      roComp: new CM.Compartment(), ro: true, room: '', base: '', local: null, loadTok: 0, liveTok: 0,
      live: false, mainRef: null, mainRO: false, forwarding: false, applying: false,
      saving: false, savePromise: null, saveT: 0, checkT: 0, loading: true, unavailable: false, settling: false,
      err: null, deleted: false, pickSig: '', offs: []
    };
    S.view = new CM.EditorView({ state: CM.EditorState.create({ doc: '', extensions: extensions() }), parent: S.host });
    S.T = S.view.state.update({}).constructor;
    S.CS = S.view.state.changes([]).constructor;
    S.local = csEmpty(0);
    wireView();
    watchSize();

    body.addEventListener('keydown', onKeyDown);
    S.pick.addEventListener('mousedown', function () { S && fillPicker(); });
    S.pick.addEventListener('focus', function () { S && fillPicker(); });
    S.pick.addEventListener('change', function () { if (S) switchTo(S.pick.value); });
    body.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b || !S) return;
      var act = b.getAttribute('data-act');
      if (act === 'new') newNote();
      else if (act === 'retry') load(S.room);
      else if (act === 'open') {
        var room = S.room;
        flushThenIdle().then(function () {
          return Cade.focusRoom ? Cade.focusRoom(room) : api().switchRoom(room);
        }).catch(function () {});
      }
    });
    panel.addEventListener('cade-panel-popout', onMoved);
    panel.addEventListener('cade-panel-popin', onMoved);

    var a = api();
    Cade.onEditorUpdate(onMainUpdate);
    document.addEventListener('cade-room-switched', onRoomSwitched);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('keydown', onWinKey, true);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', recheckSoon);
    if (a && a.onChange) S.offs.push(a.onChange(onRoomChange));

    panel._onClose = teardown;
    var saved = CORE.normRoom(sget(K_ROOM));
    var start = saved && roomExists(saved) ? saved : CORE.DEFAULT_ROOM;
    load(start).then(function () { if (S && !S.unavailable) S.view.focus(); });
  }
  function teardown() {
    if (!S) return;
    var s = S;
    try { save(); } catch (e) {}                       // the write runs on without the view
    S = null;
    clearTimeout(s.saveT); clearTimeout(s.checkT);
    if (Cade.offEditorUpdate) Cade.offEditorUpdate(onMainUpdate);
    document.removeEventListener('cade-room-switched', onRoomSwitched);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('keydown', onWinKey, true);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', recheckSoon);
    s.offs.forEach(function (off) { try { off(); } catch (e) {} });
    if (s.unwatch) { try { s.unwatch(); } catch (e) {} }
    if (s.ro2) { try { s.ro2.disconnect(); } catch (e) {} }
    try { s.view.destroy(); } catch (e) {}
  }
  function toggle() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex)) { Cade.restorePanel(ex); if (S) S.view.focus(); return; }
      ex.remove();
      if (ex._onClose) ex._onClose();
      return;
    }
    var p = Cade.mkPanel(PANEL_ID, '📝 Scratchpad', '');
    build(p);
  }

  Cade.registerWidget(WIDGET);
})();
