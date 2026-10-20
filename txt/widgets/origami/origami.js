/* Origami — fold the editor into panes, each showing a room.
 *
 * Split a pane right or down, close it, move it, clone it (the same room
 * twice), drag the dividers, or pick a preset (2 columns, 2 rows, 3 columns,
 * a 2×2 grid, main + side) from the ▦ layout menu — "Single pane" resets.
 * Right-click or long-press a pane's title bar for its menu.
 *
 * One pane at a time is live: it holds the app's real editor, so everything
 * (sync, saving, undo, find, Ctrl+P, widgets) works exactly as without panes,
 * and Ctrl+P / a room tab switches the live pane's room. The other panes are
 * read-only mirrors of their rooms; tap one and it becomes the live pane (the
 * app switches to its room, the caret lands where you tapped), while the pane
 * you left keeps showing its room. Two panes on the same room stay in step as
 * you type. "Compare…" opens the core's diff view for two rooms. Note-driven
 * panels (Kanban, Outline…) can be locked to a room (the core's room lock):
 * tapping one whose room isn't live makes that room's pane live.
 *
 * Cost: nothing loads until Origami is opened. While it's on, mirrors are
 * plain read-only CodeMirror views (line numbers when the editor shows them,
 * no plugins); clones update
 * from the editor's own change sets. The layout persists and comes back after
 * a reload. The layout tree below is pure and unit-tested:
 * node txt/widgets/origami/origami.test.js */
(function () {
  'use strict';

  // ================= layout tree (pure) =================
  //   pane:  { t: 'p', id, room }
  //   split: { t: 's', d: 'h' (side by side) | 'v' (stacked), k: [nodes], f: [fractions] }
  var MAX_PANES = 6, MIN_FRAC = 0.12;

  function mkPane(id, room) { return { t: 'p', id: id, room: room || '' }; }
  function mkSplit(d, kids, f) {
    var n = kids.length;
    if (!f || f.length !== n) { f = []; for (var i = 0; i < n; i++) f.push(1 / n); }
    return { t: 's', d: d === 'v' ? 'v' : 'h', k: kids, f: f };
  }
  function panes(n, out) {
    out = out || [];
    if (!n) return out;
    if (n.t === 'p') out.push(n);
    else for (var i = 0; i < n.k.length; i++) panes(n.k[i], out);
    return out;
  }
  // { node, parent, index } for a pane id (parent null at the root).
  function locate(n, id, parent, index) {
    if (!n) return null;
    if (n.t === 'p') return n.id === id ? { node: n, parent: parent || null, index: index == null ? -1 : index } : null;
    for (var i = 0; i < n.k.length; i++) { var r = locate(n.k[i], id, n, i); if (r) return r; }
    return null;
  }
  function replaceChild(root, parent, index, node) {
    if (!parent) return node;
    parent.k[index] = node;
    return root;
  }
  function parentOf(root, node) {
    if (!root || root.t !== 's') return null;
    for (var i = 0; i < root.k.length; i++) {
      if (root.k[i] === node) return { parent: root, index: i };
      var r = parentOf(root.k[i], node);
      if (r) return r;
    }
    return null;
  }
  // Put `fresh` next to pane `id` along direction d (after it, or before). Returns the new root.
  function splitAt(root, id, d, fresh, before) {
    var at = locate(root, id);
    if (!at || panes(root).length >= MAX_PANES) return root;
    var P = at.parent;
    if (P && P.d === d) {                                  // same direction: one more kid, sharing this one's room
      var half = P.f[at.index] / 2, j = before ? at.index : at.index + 1;
      P.f[at.index] = half;
      P.k.splice(j, 0, fresh); P.f.splice(j, 0, half);
      return root;
    }
    var s = mkSplit(d, before ? [fresh, at.node] : [at.node, fresh]);
    return replaceChild(root, P, at.index, s);
  }
  // Close pane id (never the last one); a split left with one kid folds away.
  function removePane(root, id) {
    var at = locate(root, id);
    if (!at || !at.parent) return root;
    var P = at.parent, sum = 0, i;
    P.k.splice(at.index, 1); P.f.splice(at.index, 1);
    for (i = 0; i < P.f.length; i++) sum += P.f[i];
    for (i = 0; i < P.f.length; i++) P.f[i] = sum > 0 ? P.f[i] / sum : 1 / P.f.length;
    if (P.k.length === 1) {
      var only = P.k[0], gp = parentOf(root, P);
      if (!gp) return only;
      // A single kid with the grandparent's direction merges into it.
      if (only.t === 's' && only.d === gp.parent.d) {
        var w = gp.parent.f[gp.index], args = [gp.index, 1].concat(only.k), fs = [gp.index, 1];
        for (i = 0; i < only.f.length; i++) fs.push(only.f[i] * w);
        Array.prototype.splice.apply(gp.parent.k, args);
        Array.prototype.splice.apply(gp.parent.f, fs);
        return root;
      }
      gp.parent.k[gp.index] = only;
    }
    return root;
  }
  // Swap two panes' places (their ids and rooms travel together).
  function swapPanes(root, a, b) {
    var A = locate(root, a), B = locate(root, b);
    if (!A || !B || a === b) return root;
    var t = { id: A.node.id, room: A.node.room };
    A.node.id = B.node.id; A.node.room = B.node.room;
    B.node.id = t.id; B.node.room = t.room;
    return root;
  }
  // Drag the divider after kid i of a split by `delta` (a fraction of the split).
  function resize(s, i, delta) {
    if (!s || s.t !== 's' || i < 0 || i >= s.k.length - 1) return false;
    var a = s.f[i] + delta, b = s.f[i + 1] - delta, tot = s.f[i] + s.f[i + 1];
    if (a < MIN_FRAC) { a = MIN_FRAC; b = tot - a; }
    if (b < MIN_FRAC) { b = MIN_FRAC; a = tot - b; }
    s.f[i] = a; s.f[i + 1] = b;
    return true;
  }
  function equalize(n) {
    if (!n || n.t !== 's') return n;
    for (var i = 0; i < n.k.length; i++) { n.f[i] = 1 / n.k.length; equalize(n.k[i]); }
    return n;
  }
  var PRESETS = [
    { id: 'single', name: 'Single pane', n: 1, phone: true },
    { id: 'cols2', name: '2 columns', n: 2 },
    { id: 'rows2', name: '2 rows', n: 2, phone: true },
    { id: 'cols3', name: '3 columns', n: 3 },
    { id: 'rows3', name: '3 rows', n: 3, phone: true },
    { id: 'grid', name: '2 × 2 grid', n: 4 },
    { id: 'main2', name: 'Main + 2 side', n: 3 }
  ];
  // A preset filled with rooms (first = the live room); newId() makes ids.
  function preset(name, rooms, newId) {
    var r = function (i) { return mkPane(newId(), rooms[Math.min(i, rooms.length - 1)] || rooms[0] || ''); };
    switch (name) {
      case 'cols2': return mkSplit('h', [r(0), r(1)]);
      case 'rows2': return mkSplit('v', [r(0), r(1)]);
      case 'cols3': return mkSplit('h', [r(0), r(1), r(2)]);
      case 'rows3': return mkSplit('v', [r(0), r(1), r(2)]);
      case 'grid': return mkSplit('v', [mkSplit('h', [r(0), r(1)]), mkSplit('h', [r(2), r(3)])]);
      case 'main2': return mkSplit('h', [r(0), mkSplit('v', [r(1), r(2)])], [0.6, 0.4]);
      default: return r(0);
    }
  }
  // Anything stored (old, foreign, damaged) → a valid tree, or null.
  function normalize(o, depth, seen) {
    depth = depth || 0; seen = seen || {};
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if (o.t === 'p') {
      var id = typeof o.id === 'string' && /^[\w-]{1,24}$/.test(o.id) ? o.id : null;
      if (!id || seen[id]) return null;
      seen[id] = 1;
      return mkPane(id, typeof o.room === 'string' ? o.room.slice(0, 200) : '');
    }
    if (o.t !== 's' || !Array.isArray(o.k)) return null;
    var kids = [], f = [], i;
    for (i = 0; i < o.k.length && kids.length < MAX_PANES; i++) {
      var c = normalize(o.k[i], depth + 1, seen);
      if (!c) continue;
      kids.push(c);
      var x = Array.isArray(o.f) ? +o.f[i] : NaN;
      f.push(isFinite(x) && x > 0 ? x : 1);
    }
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    var sum = 0;
    for (i = 0; i < f.length; i++) sum += f[i];
    for (i = 0; i < f.length; i++) f[i] = Math.max(MIN_FRAC / 2, f[i] / sum);
    var root = mkSplit(o.d, kids, f);
    // over the pane limit (a damaged save): keep the first MAX_PANES
    while (panes(root).length > MAX_PANES) root = removePane(root, panes(root).pop().id);
    return root;
  }

  var CORE = { MAX_PANES: MAX_PANES, MIN_FRAC: MIN_FRAC, PRESETS: PRESETS, mkPane: mkPane, mkSplit: mkSplit, panes: panes, locate: locate,
    splitAt: splitAt, removePane: removePane, swapPanes: swapPanes, resize: resize, equalize: equalize, preset: preset, normalize: normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= UI =================
  var Cade = window.Cade, CM = Cade.CM;
  if (!CM || !CM.EditorView || !CM.EditorState) return;
  Cade.loadCSS('origami.css');
  var KEY = 'cade-origami', ON = 'cade-origami-on';
  var O = null;                                            // the live session while Origami is on

  function esc(s) { return Cade.escapeHtml(String(s)); }
  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function api() { return Cade.roomsApi || null; }
  function activeRoom() { var r = api(); return r ? r.activeRoom() : ''; }
  function roomExists(name) { var r = api(); return !!(r && name && r.list().indexOf(name) >= 0); }
  function phone() { return window.innerWidth < 640; }
  function maxPanes() { return phone() ? 3 : MAX_PANES; }
  function nid() { return 'p' + (O.seq++).toString(36); }
  function paneById(id) { var at = locate(O.tree, id); return at ? at.node : null; }

  function save() {
    if (!O) return;
    sset(KEY, JSON.stringify({ tree: O.tree, live: O.live, seq: O.seq }));
  }
  function loadSaved() {
    try { var o = JSON.parse(sget(KEY) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  }

  // ---- mirrors: read-only views of other rooms ----
  function mirrorFor(p) {
    var v = O.views[p.id];
    if (v && v.__room === p.room) return v;
    if (v) { try { v.destroy(); } catch (e) {} }
    v = new CM.EditorView({ state: CM.EditorState.create({ doc: '', extensions: Cade.readOnlyExtensions({ lineNumbers: true }) }) });
    v.__room = p.room;
    v.dom.classList.add('ori-mirror');
    O.views[p.id] = v;
    fillMirror(v);
    return v;
  }
  function setText(v, text) {
    if (v.state.doc.toString() === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }
  // The live room's text comes straight from the editor; others from the room store.
  function fillMirror(v) {
    var room = v.__room;
    if (room === activeRoom()) { setText(v, Cade.editor.state.doc.toString()); return; }
    var tok = v.__tok = (v.__tok || 0) + 1;
    Promise.resolve(Cade.roomText ? Cade.roomText(room) : '').then(function (t) {
      if (!O || v.__tok !== tok || O.views[idOfView(v)] !== v) return;
      setText(v, t || '');
    }, function () {});
  }
  function idOfView(v) { for (var id in O.views) if (O.views[id] === v) return id; return null; }

  // ---- building the panes ----
  function build(n) {
    if (n.t === 'p') {
      var el = document.createElement('div');
      el.className = 'ori-pane';
      el.setAttribute('data-id', n.id);
      el.innerHTML = '<div class="ori-head" data-id="' + n.id + '">' +
        '<button type="button" class="ori-room" data-act="room" title="Change this pane’s room (Ctrl+P in the live pane)"><span class="ori-dot" aria-hidden="true"></span><span class="ori-name"></span><span class="ori-car" aria-hidden="true">▾</span></button>' +
        '<span class="ori-sp"></span>' +
        '<button type="button" class="ori-ib" data-act="layout" title="Layout — presets, reset to one pane" aria-label="Layout">▦</button>' +
        '<button type="button" class="ori-ib" data-act="menu" title="Pane menu (or right-click the title bar)" aria-label="Pane menu">⋯</button>' +
        '<button type="button" class="ori-ib" data-act="close" title="Close this pane" aria-label="Close pane">✕</button>' +
        '</div><div class="ori-body" data-id="' + n.id + '"></div>';
      return el;
    }
    var s = document.createElement('div');
    s.className = 'ori-split ori-' + n.d;
    var si = O.splits.push(n) - 1;
    for (var i = 0; i < n.k.length; i++) {
      if (i) {
        var gut = document.createElement('div');
        gut.className = 'ori-gut';
        gut.setAttribute('data-s', si); gut.setAttribute('data-i', i - 1);
        gut.setAttribute('role', 'separator');
        gut.setAttribute('aria-orientation', n.d === 'h' ? 'vertical' : 'horizontal');
        gut.title = 'Drag to resize · double-click to even out';
        s.appendChild(gut);
      }
      var kid = build(n.k[i]);
      kid.style.flex = n.f[i] + ' 1 0px';
      s.appendChild(kid);
    }
    return s;
  }
  function render() {
    var ed = Cade.editor, hadFocus = ed.hasFocus, scroll = ed.scrollDOM.scrollTop, ms = {}, id;
    for (id in O.views) ms[id] = O.views[id].scrollDOM.scrollTop;
    O.splits = [];
    O.root.textContent = '';
    O.root.appendChild(build(O.tree));
    var list = panes(O.tree), alive = {};
    if (!locate(O.tree, O.live)) O.live = list[0].id;
    list.forEach(function (p) {
      alive[p.id] = 1;
      var body = O.root.querySelector('.ori-body[data-id="' + p.id + '"]');
      if (p.id === O.live) body.appendChild(ed.dom);
      else body.appendChild(mirrorFor(p).dom);
    });
    for (id in O.views) if (!alive[id] || id === O.live) { try { O.views[id].destroy(); } catch (e) {} delete O.views[id]; }
    ed.scrollDOM.scrollTop = scroll;
    for (id in O.views) if (ms[id] != null) O.views[id].scrollDOM.scrollTop = ms[id];
    ed.requestMeasure();
    if (hadFocus) { try { ed.focus(); } catch (e) {} }
    paintHeads();
    place();
    save();
  }
  function paintHeads() {
    if (!O) return;
    var one = panes(O.tree).length === 1;
    O.root.classList.toggle('ori-one', one);
    panes(O.tree).forEach(function (p) {
      var el = O.root.querySelector('.ori-pane[data-id="' + p.id + '"]');
      if (!el) return;
      var live = p.id === O.live;
      el.classList.toggle('live', live);
      el.querySelector('.ori-name').textContent = p.room || 'Untitled';
      el.querySelector('.ori-room').title = (live ? 'Live pane — ' : 'Tap the text to edit here — ') + (p.room || '') + ' · change room';
      el.querySelector('[data-act="close"]').disabled = one;
    });
  }
  // Clear the floating toolbar band at the top, and the sidebar on the left.
  function place() {
    if (!O) return;
    var tb = document.querySelector('.mobile-toolbar'), top = 0, wr = O.wrap.getBoundingClientRect();
    if (tb && tb.offsetParent !== null && getComputedStyle(tb).display !== 'none') top = Math.max(0, Math.round(tb.getBoundingClientRect().bottom - wr.top) - 2);
    O.root.style.top = top + 'px';
  }

  // ---- switching which pane is live ----
  async function activate(id, at, noFocus) {
    if (!O || id === O.live || O.busy) return;
    var p = paneById(id);
    if (!p) return;
    var v = O.views[id], pos = null, scroll = 0;
    if (v) {
      scroll = v.scrollDOM.scrollTop;
      if (at) { try { pos = v.posAtCoords(at); } catch (e) { pos = null; } }
    }
    O.busy = true;
    try {
      if (p.room && !roomExists(p.room)) p.room = activeRoom();        // a room deleted meanwhile: show the live one
      O.live = id;
      render();                                                         // the old live pane turns into a mirror of its room
      if (p.room && p.room !== activeRoom()) {
        var r = api();
        if (r) await r.switchRoom(p.room);
        if (!O) return;
        if (activeRoom() !== p.room) { p.room = activeRoom(); paintHeads(); save(); }   // locked / cancelled: it shows what's open
      }
      var ed = Cade.editor;
      ed.scrollDOM.scrollTop = scroll;
      if (pos != null) {
        pos = Math.max(0, Math.min(pos, ed.state.doc.length));
        ed.dispatch({ selection: { anchor: pos } });
      }
      if (!noFocus) { try { ed.focus(); } catch (e) {} }
    } finally { if (O) O.busy = false; }
  }
  // Cade.focusRoom (a locked panel tapped while its room isn't open): make the
  // pane showing that room live — without focusing the editor, so a phone's
  // keyboard stays down. False when no pane shows it (the core switches rooms).
  function activateRoom(room) {
    if (!O || O.busy) return false;
    var p = panes(O.tree).filter(function (x) { return x.room === room && x.id !== O.live; })[0];
    if (!p) return false;
    return activate(p.id, null, true).then(function () { return true; });
  }

  // ---- editing the layout ----
  function rooms() {
    // The live room first, then the panes' other rooms, then recent rooms.
    var out = [activeRoom()], r = api(), seen = {};
    seen[out[0]] = 1;
    panes(O.tree).forEach(function (p) { if (p.room && !seen[p.room] && roomExists(p.room)) { seen[p.room] = 1; out.push(p.room); } });
    if (r) {
      var list = r.list().filter(function (x) { return !seen[x] && !(r.isArchived && r.isArchived(x)); });
      list.sort(function (a, b) { return (r.modifiedAt(b) || 0) - (r.modifiedAt(a) || 0); });
      out = out.concat(list);
    }
    return out;
  }
  function applyPreset(name) {
    var P = PRESETS.filter(function (x) { return x.id === name; })[0];
    if (!P) return;
    O.tree = preset(name, rooms(), nid);
    O.live = panes(O.tree)[0].id;
    render();
    if (name === 'single') Cade.showToast && Cade.showToast('Back to one pane', 'info', 1200);
  }
  function splitPane(id, d) {
    var p = paneById(id);
    if (!p) return;
    if (panes(O.tree).length >= maxPanes()) { Cade.showToast && Cade.showToast('That’s as many panes as fit (' + maxPanes() + ')', 'info', 1800); return null; }
    if (phone()) d = 'v';
    var fresh = mkPane(nid(), p.room);
    O.tree = splitAt(O.tree, id, d, fresh, false);
    render();
    return fresh;
  }
  function closePane(id) {
    if (panes(O.tree).length < 2) return;
    var wasLive = id === O.live;
    O.tree = removePane(O.tree, id);
    if (wasLive) {
      // the editor moves to the first pane; it shows whatever room is open, which that pane now shows
      var first = panes(O.tree)[0];
      O.live = first.id; first.room = activeRoom();
    }
    render();
  }
  function movePane(id, dir) {
    var list = panes(O.tree), i = -1;
    for (var j = 0; j < list.length; j++) if (list[j].id === id) i = j;
    var k = i + dir;
    if (i < 0 || k < 0 || k >= list.length) return;
    O.tree = swapPanes(O.tree, id, list[k].id);
    render();
  }
  function changeRoom(id) {
    var open = function () { if (window.openQuickSwitcher) window.openQuickSwitcher(''); };
    if (id === O.live) { open(); return; }
    activate(id).then(open);
  }
  function compare(id) {
    var p = paneById(id), live = paneById(O.live);
    if (!p || !live || p.room === live.room) return;
    var room = p.room;
    turnOff();
    Promise.resolve(window.openSplit && window.openSplit(room)).then(function () {
      try { if (window.toggleSplitDiff && !document.querySelector('#split-diff-btn.on')) window.toggleSplitDiff(); } catch (e) {}
    });
    Cade.showToast && Cade.showToast('Comparing in the split view — reopen Origami to get your panes back', 'info', 2600);
  }

  // ---- menus ----
  function closeMenu() {
    if (O && O.menu) { O.menu.remove(); O.menu = null; }
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onMenuOutside(e) { if (O && O.menu && !O.menu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }
  function openMenu(items, x, y) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'ori-menu';
    m.setAttribute('role', 'menu');
    items.forEach(function (it) {
      if (it === '-') { var hr = document.createElement('div'); hr.className = 'ori-msep'; m.appendChild(hr); return; }
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ori-mi' + (it.on ? ' on' : ''); b.setAttribute('role', 'menuitem');
      b.innerHTML = '<span class="ori-mic" aria-hidden="true">' + (it.icon || '') + '</span><span>' + esc(it.label) + '</span>';
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', function () { closeMenu(); it.run(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    O.menu = m;
    setTimeout(function () {
      document.addEventListener('pointerdown', onMenuOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
      var f = m.querySelector('button:not(:disabled)'); if (f && !matchMedia('(pointer: coarse)').matches) f.focus();
    }, 0);
  }
  function layoutItems() {
    var ph = phone(), items = PRESETS.filter(function (P) { return !ph || P.phone; }).map(function (P) {
      return { icon: P.id === 'single' ? '□' : '▦', label: P.id === 'single' ? 'Single pane (reset)' : P.name, run: function () { applyPreset(P.id); } };
    });
    items.push('-');
    items.push({ icon: '↔', label: 'Even out sizes', run: function () { equalize(O.tree); render(); } });
    items.push({ icon: '✕', label: 'Exit Origami', run: turnOff });
    return items;
  }
  function paneItems(id) {
    var p = paneById(id), list = panes(O.tree), i = list.indexOf(p), full = list.length >= maxPanes(), ph = phone();
    var live = paneById(O.live);
    var items = [];
    if (!ph) items.push({ icon: '◨', label: 'Split right', disabled: full, run: function () { splitPane(id, 'h'); } });
    items.push({ icon: '⬓', label: 'Split down', disabled: full, run: function () { splitPane(id, 'v'); } });
    items.push({ icon: '⎘', label: 'Open another room beside…', disabled: full, run: function () {
      var f = splitPane(id, ph ? 'v' : 'h');
      if (f) activate(f.id).then(function () { if (window.openQuickSwitcher) window.openQuickSwitcher(''); });
    } });
    items.push({ icon: '⇄', label: 'Change room…', run: function () { changeRoom(id); } });
    items.push('-');
    items.push({ icon: ph ? '↑' : '←', label: ph ? 'Move up' : 'Move back', disabled: i <= 0, run: function () { movePane(id, -1); } });
    items.push({ icon: ph ? '↓' : '→', label: ph ? 'Move down' : 'Move forward', disabled: i >= list.length - 1, run: function () { movePane(id, 1); } });
    items.push({ icon: '≡', label: 'Compare with the live pane', disabled: id === O.live || !live || p.room === live.room, run: function () { compare(id); } });
    items.push('-');
    items.push({ icon: '▦', label: 'Layout…', run: function () { var r = O.root.querySelector('.ori-pane[data-id="' + id + '"] [data-act="layout"]').getBoundingClientRect(); openMenu(layoutItems(), r.left, r.bottom + 4); } });
    items.push({ icon: '✕', label: 'Close pane', disabled: list.length < 2, run: function () { closePane(id); } });
    return items;
  }

  // ---- events ----
  function onRootClick(e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (b && O.root.contains(b)) {
      var id = b.closest('.ori-head').getAttribute('data-id'), a = b.getAttribute('data-act'), r = b.getBoundingClientRect();
      if (a === 'room') changeRoom(id);
      else if (a === 'layout') openMenu(layoutItems(), r.left - 120, r.bottom + 4);
      else if (a === 'menu') openMenu(paneItems(id), r.left - 160, r.bottom + 4);
      else if (a === 'close') closePane(id);
      return;
    }
    // a tap in a mirror's text makes that pane live, caret where it landed
    var body = e.target.closest ? e.target.closest('.ori-body') : null;
    if (body && O.root.contains(body)) {
      var pid = body.getAttribute('data-id');
      if (pid !== O.live) activate(pid, { x: e.clientX, y: e.clientY });
    }
  }
  function onContext(e) {
    var head = e.target.closest ? e.target.closest('.ori-head') : null;
    if (!head || !O.root.contains(head)) return;
    e.preventDefault();
    openMenu(paneItems(head.getAttribute('data-id')), e.clientX, e.clientY);
  }
  // long-press on a title bar (touch) = the same menu
  function onHeadDown(e) {
    var head = e.target.closest ? e.target.closest('.ori-head') : null;
    if (!head || e.pointerType === 'mouse') return;
    clearTimeout(O.lpT);
    var x = e.clientX, y = e.clientY, id = head.getAttribute('data-id');
    O.lpT = setTimeout(function () { O.lpFired = true; openMenu(paneItems(id), x, y); }, 520);
    O.lpFired = false;
  }
  function onHeadUp() { if (O) clearTimeout(O.lpT); }
  function onHeadClickCapture(e) { if (O && O.lpFired) { O.lpFired = false; e.preventDefault(); e.stopPropagation(); } }
  // drag a divider
  function onGutDown(e) {
    var g = e.target.closest ? e.target.closest('.ori-gut') : null;
    if (!g) return;
    e.preventDefault();
    var s = O.splits[+g.getAttribute('data-s')], i = +g.getAttribute('data-i'), box = g.parentNode.getBoundingClientRect();
    var horiz = s.d === 'h', size = horiz ? box.width : box.height, last = horiz ? e.clientX : e.clientY;
    var kids = Array.prototype.filter.call(g.parentNode.children, function (c) { return !c.classList.contains('ori-gut'); });
    try { g.setPointerCapture(e.pointerId); } catch (er) {}
    g.classList.add('drag'); document.body.classList.add('ori-dragging', horiz ? 'ori-dh' : 'ori-dv');
    var tot = 0; for (var j = 0; j < s.f.length; j++) tot += s.f[j];
    var move = function (ev) {
      var cur = horiz ? ev.clientX : ev.clientY, d = (cur - last) / Math.max(1, size) * tot;
      if (!d) return;
      last = cur;
      if (resize(s, i, d)) { kids[i].style.flex = s.f[i] + ' 1 0px'; kids[i + 1].style.flex = s.f[i + 1] + ' 1 0px'; }
    };
    var up = function () {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      g.classList.remove('drag'); document.body.classList.remove('ori-dragging', 'ori-dh', 'ori-dv');
      Cade.editor.requestMeasure(); for (var id in O.views) O.views[id].requestMeasure();
      save();
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  }
  function onGutDbl(e) {
    var g = e.target.closest ? e.target.closest('.ori-gut') : null;
    if (!g) return;
    var s = O.splits[+g.getAttribute('data-s')];
    for (var j = 0; j < s.f.length; j++) s.f[j] = 1 / s.f.length;
    render();
  }
  // Clones follow the live editor keystroke by keystroke (from its change sets).
  function onUpdate(u) {
    if (!O || !u.docChanged) return;
    var room = activeRoom();
    for (var id in O.views) {
      var v = O.views[id];
      if (v.__room !== room) continue;
      if (v.state.doc.length === u.startState.doc.length) { try { v.dispatch({ changes: u.changes }); continue; } catch (e) {} }
      setText(v, u.state.doc.toString());
    }
  }
  // Ctrl+P, a room tab, a link…: the live pane now shows that room.
  function onSwitched() {
    if (!O) return;
    var p = paneById(O.live), room = activeRoom();
    if (p && p.room !== room) { p.room = room; paintHeads(); save(); }
    for (var id in O.views) if (O.views[id].__room === room) setText(O.views[id], Cade.editor.state.doc.toString());
  }
  function onVis() {
    if (!O || document.visibilityState !== 'visible') return;
    for (var id in O.views) fillMirror(O.views[id]);
  }
  function onResize() {
    if (!O) return;
    clearTimeout(O.rzT);
    O.rzT = setTimeout(function () {
      if (!O) return;
      // a phone holds at most three stacked panes
      if (phone()) {
        var list = panes(O.tree);
        while (list.length > maxPanes()) { O.tree = removePane(O.tree, list[list.length - 1].id === O.live ? list[0].id : list[list.length - 1].id); list = panes(O.tree); }
      }
      place(); Cade.editor.requestMeasure();
    }, 150);
  }

  // ---- on / off ----
  // Line numbers shown / hidden in the editor: rebuild the mirrors to match, so
  // a pane's text doesn't jump sideways when it becomes the live one.
  function onLineNums() {
    if (!O) return;
    for (var id in O.views) { try { O.views[id].destroy(); } catch (e) {} delete O.views[id]; }
    render();
  }
  function turnOn() {
    if (O) return;
    var ed = Cade.editor, wrap = document.getElementById('editor-wrap');
    if (!ed || !wrap || !api()) return;
    try { if (document.body.classList.contains('split-open') && window.closeSplit) window.closeSplit(); } catch (e) {}
    var saved = loadSaved(), room = activeRoom();
    O = { wrap: wrap, root: document.createElement('div'), views: {}, splits: [], seq: Math.max(1, (saved && +saved.seq) || 1),
      home: { parent: ed.dom.parentNode, next: ed.dom.nextSibling }, tree: null, live: null, menu: null, busy: false };
    var tree = saved ? normalize(saved.tree) : null;
    if (!tree) tree = preset(phone() ? 'rows2' : 'cols2', [room].concat(otherRooms(room)), nid);
    // the live pane shows the open room; panes whose room is gone show it too
    panes(tree).forEach(function (p) { if (!roomExists(p.room)) p.room = room; });
    var live = saved && locate(tree, saved.live) ? saved.live : null;
    if (!live) { var on = panes(tree).filter(function (p) { return p.room === room; })[0]; live = on ? on.id : panes(tree)[0].id; }
    O.tree = tree; O.live = live;
    paneById(live).room = room;
    if (phone()) { var l2 = panes(O.tree); while (l2.length > maxPanes()) { O.tree = removePane(O.tree, l2[l2.length - 1].id === O.live ? l2[0].id : l2[l2.length - 1].id); l2 = panes(O.tree); } }
    O.root.className = 'ori';
    wrap.classList.add('origami');
    document.body.classList.add('origami-on');
    wrap.appendChild(O.root);
    O.onClick = onRootClick; O.onCtx = onContext;
    O.root.addEventListener('click', O.onClick);
    O.root.addEventListener('contextmenu', O.onCtx);
    O.root.addEventListener('pointerdown', onGutDown);
    O.root.addEventListener('pointerdown', onHeadDown);
    O.root.addEventListener('pointerup', onHeadUp);
    O.root.addEventListener('pointercancel', onHeadUp);
    O.root.addEventListener('click', onHeadClickCapture, true);
    O.root.addEventListener('dblclick', onGutDbl);
    Cade.onEditorUpdate(onUpdate);
    window.__cadeRoomActivator = activateRoom;
    document.addEventListener('cade-room-switched', onSwitched);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    window.addEventListener('cade-linenums', onLineNums);
    sset(ON, '1');
    render();
  }
  // The first time: the open room beside the most recently changed other room.
  function otherRooms(room) {
    var r = api(); if (!r) return [];
    var list = r.list().filter(function (x) { return x !== room && !(r.isArchived && r.isArchived(x)); });
    list.sort(function (a, b) { return (r.modifiedAt(b) || 0) - (r.modifiedAt(a) || 0); });
    return list;
  }
  function turnOff() {
    if (!O) return;
    closeMenu();
    save();
    var ed = Cade.editor, s = O, scroll = ed.scrollDOM.scrollTop, hadFocus = ed.hasFocus;
    O = null;
    clearTimeout(s.rzT); clearTimeout(s.lpT);
    var home = s.home;
    if (home.parent && home.parent.isConnected) home.parent.insertBefore(ed.dom, home.next && home.next.parentNode === home.parent ? home.next : null);
    else s.wrap.appendChild(ed.dom);
    for (var id in s.views) { try { s.views[id].destroy(); } catch (e) {} }
    s.root.remove();
    s.wrap.classList.remove('origami');
    document.body.classList.remove('origami-on', 'ori-dragging', 'ori-dh', 'ori-dv');
    if (Cade.offEditorUpdate) Cade.offEditorUpdate(onUpdate);
    if (window.__cadeRoomActivator === activateRoom) window.__cadeRoomActivator = null;
    document.removeEventListener('cade-room-switched', onSwitched);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('cade-linenums', onLineNums);
    sset(ON, '0');
    ed.scrollDOM.scrollTop = scroll;
    ed.requestMeasure();
    if (hadFocus) { try { ed.focus(); } catch (e) {} }
  }
  function toggle() { Cade.closeAllMenus && Cade.closeAllMenus(); if (O) turnOff(); else turnOn(); }

  window.__cadeOrigami = { isOn: function () { return !!O; }, close: turnOff, open: turnOn };
  Cade.registerWidget({
    name: 'Origami',
    description: 'Split the window into panes, each a room — split, close, move, clone, compare; layouts and presets',
    icon: '🪟',
    tags: 'origami,split,panes,pane,tile,tiles,layout,side by side,columns,rows,grid,windows,multi,compare,clone,rooms',
    open: toggle
  });
})();
