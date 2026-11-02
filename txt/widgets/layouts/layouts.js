/* Layouts — arrange panels and save the arrangement, for Cade.txt.
 * A manager for the core's Cade.layouts (see "Layouts" in txt.html and
 * txt/docs/cade-api.md):
 *  - Float window: one extra window that tiles several panels (2 columns,
 *    2×2, main + side…) with draggable dividers. In Chrome / Edge it is a
 *    Picture-in-Picture window, which stays on top of every other window on
 *    the screen. Browsers allow only one such window per page, so panels
 *    share it rather than each floating alone. While it is open a panel's
 *    pop-out button sends the panel there.
 *  - Arrange: snapping (drag a title bar to an edge / corner / the top),
 *    tile all, cascade.
 *  - Saved layouts: which widgets are open, where (snap zone, or position and
 *    size relative to the window), minimized or floating, and the float
 *    window's layout — saved by name on this device, loaded back in one click.
 * Saved layouts persist in Cade.store (cade-layouts-*). */
(function () {
  'use strict';

  // ================= pure helpers (unit-checked in node) =================
  var MAX_NAME = 40, MAX_ITEMS = 50;
  // A float window tile tree: 'L' (a tile) or [d 'h'|'v', ratio, a, b] — as the core's Cade.layouts.shape().
  function shapeOk(t, depth) {
    depth = depth || 0;
    if (t === 'L') return true;
    return depth < 10 && Array.isArray(t) && t.length === 4 && (t[0] === 'h' || t[0] === 'v') && typeof t[1] === 'number' && t[1] > 0.02 && t[1] < 0.98 &&
      shapeOk(t[2], depth + 1) && shapeOk(t[3], depth + 1);
  }
  function shapeTiles(t) { return t === 'L' ? 1 : shapeTiles(t[2]) + shapeTiles(t[3]); }
  function cleanName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME); }
  function validArr(a) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.panels)) return null;
    var panels = a.panels.filter(function (e) {
      return e && typeof e.widget === 'string' && e.widget && typeof e.id === 'string' && e.id &&
        (e.state === 'open' || e.state === 'min' || e.state === 'float');
    }).map(function (e) {
      var o = { widget: e.widget, id: e.id, state: e.state };
      if (e.state === 'float') o.slot = Math.max(0, e.slot | 0);
      if (typeof e.snap === 'string') o.snap = e.snap;
      if (e.rect && typeof e.rect === 'object') {
        var r = e.rect, n = function (v) { return typeof v === 'number' && isFinite(v) ? Math.max(-0.5, Math.min(1.5, v)) : null; };
        o.rect = { x: n(r.x) || 0, y: n(r.y) || 0, w: n(r.w), h: n(r.h) };
      }
      return o;
    });
    var ws = null;
    if (a.ws && typeof a.ws === 'object' && (typeof a.ws.layout === 'string' || shapeOk(a.ws.shape))) {
      ws = { layout: typeof a.ws.layout === 'string' ? a.ws.layout : 'custom', shape: shapeOk(a.ws.shape) && shapeTiles(a.ws.shape) <= 8 ? a.ws.shape : null, w: +a.ws.w || 0, h: +a.ws.h || 0 };
    }
    return { v: 1, at: +a.at || 0, area: a.area || null, panels: panels, ws: ws };
  }
  function normStore(o) {
    var out = { v: 1, items: [] };
    if (!o || typeof o !== 'object' || !Array.isArray(o.items)) return out;
    var seen = {};
    o.items.forEach(function (it) {
      if (!it || out.items.length >= MAX_ITEMS) return;
      var name = cleanName(it.name), arr = validArr(it.arr);
      if (!name || !arr || seen[name.toLowerCase()]) return;
      seen[name.toLowerCase()] = 1;
      out.items.push({ name: name, at: +it.at || arr.at || 0, arr: arr });
    });
    return out;
  }
  function findItem(st, name) {
    var k = cleanName(name).toLowerCase();
    for (var i = 0; i < st.items.length; i++) if (st.items[i].name.toLowerCase() === k) return i;
    return -1;
  }
  // Save (or overwrite by name, case-insensitive); newest first.
  function upsert(st, name, arr, now) {
    name = cleanName(name); arr = validArr(arr);
    if (!name || !arr) return false;
    var i = findItem(st, name), it = { name: i >= 0 ? st.items[i].name : name, at: now || 0, arr: arr };
    if (i >= 0) st.items.splice(i, 1);
    st.items.unshift(it);
    if (st.items.length > MAX_ITEMS) st.items.length = MAX_ITEMS;
    return true;
  }
  function rename(st, from, to) {
    var i = findItem(st, from), n = cleanName(to);
    if (i < 0 || !n) return false;
    var j = findItem(st, n);
    if (j >= 0 && j !== i) return false;
    st.items[i].name = n;
    return true;
  }
  function remove(st, name) { var i = findItem(st, name); if (i < 0) return false; st.items.splice(i, 1); return true; }
  function suggestName(st, base) {
    base = cleanName(base) || 'Layout';
    if (findItem(st, base) < 0) return base;
    for (var n = 2; n < 999; n++) if (findItem(st, base + ' ' + n) < 0) return base + ' ' + n;
    return base;
  }
  function summary(arr) {
    var open = 0, min = 0, fl = 0;
    arr.panels.forEach(function (e) { if (e.state === 'float') fl++; else if (e.state === 'min') min++; else open++; });
    var parts = [];
    var total = open + min + fl;
    parts.push(total + (total === 1 ? ' panel' : ' panels'));
    if (fl) parts.push(fl + ' floating');
    if (min) parts.push(min + ' minimized');
    return parts.join(' · ');
  }
  function widgetNames(arr) {
    var seen = {}, out = [];
    arr.panels.forEach(function (e) { if (!seen[e.widget]) { seen[e.widget] = 1; out.push(e.widget); } });
    return out;
  }

  var PURE = { shapeOk: shapeOk, shapeTiles: shapeTiles, cleanName: cleanName, validArr: validArr, normStore: normStore, findItem: findItem, upsert: upsert, rename: rename,
    remove: remove, suggestName: suggestName, summary: summary, widgetNames: widgetNames, MAX_ITEMS: MAX_ITEMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('layouts.css');

  var PANEL_ID = 'layouts-panel', NAME = 'Layouts';
  var STORE_KEY = 'cade-layouts-saved', OPTS_KEY = 'cade-layouts-opts';
  var S = null;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function loadStore() { var o = null; try { o = JSON.parse(sget(STORE_KEY) || 'null'); } catch (e) { o = null; } return normStore(o); }
  function saveStore() { if (S) sset(STORE_KEY, JSON.stringify(S.st)); }
  function loadOpts() {
    var o = {}; try { o = JSON.parse(sget(OPTS_KEY) || '{}') || {}; } catch (e) { o = {}; }
    return { replace: o.replace !== false, floatLayout: typeof o.floatLayout === 'string' ? o.floatLayout : 'cols2' };
  }
  function saveOpts() { if (S) sset(OPTS_KEY, JSON.stringify(S.opts)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function L() { return Cade.layouts; }
  function when(t) {
    if (!t) return '';
    var d = new Date(t), now = new Date();
    var same = d.toDateString() === now.toDateString();
    return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function titleOf(p) { var t = p.querySelector('.cade-panel-title'); return (t && t.textContent) || p.id; }
  function appPanels() {
    return Array.prototype.filter.call(document.querySelectorAll('body > .cade-panel'), function (p) {
      return p.id !== PANEL_ID && !p.classList.contains('cade-popped');
    });
  }
  var I_FLOAT = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg>';

  function render() {
    if (!S) return;
    var api = L();
    if (!api) { S.body.innerHTML = '<p class="lay-note">This feature needs the latest app — reload the page.</p>'; return; }
    var sup = api.supported(), open = api.isOpen(), h = '';
    // ---- float window
    h += '<section class="lay-sec"><div class="lay-h">Float window</div>';
    if (!sup.float) h += '<p class="lay-note">Floating panels need a desktop browser.</p>';
    else {
      h += '<p class="lay-note">' + (sup.onTop ? 'One window that <b>stays on top of all your other windows</b> and tiles several panels.' :
        'One extra window that tiles several panels. (Only Chrome and Edge can keep it on top of other windows.)') +
        ' Start from a layout, then make it your own: drag a panel’s title bar to another tile’s edge to dock it there, drag dividers, or use <b>Edit tiles</b> to split and remove tiles.</p>';
      var cur = open ? api.layout() : S.opts.floatLayout;
      h += '<div class="lay-layouts" role="group" aria-label="Float window layout">' + api.layouts().map(function (l) {
        return '<button type="button" class="lay-chip' + (l.id === cur ? ' on' : '') + '" data-layout="' + l.id + '" title="' + esc(l.name + ' — ' + l.slots + (l.slots === 1 ? ' tile' : ' tiles')) + '">' + esc(l.name) + '</button>';
      }).join('') + (open && cur === 'custom' ? '<span class="lay-chip on" title="Your own arrangement of tiles">Custom</span>' : '') + '</div>';
      h += '<div class="lay-row">' + (open ?
        '<button type="button" class="lay-btn" data-act="back-float" title="Bring its widgets back into the app window, then close it">Back in app</button>' +
        '<button type="button" class="lay-btn" data-act="close-float" title="Close the window and the widgets in it">Close</button><span class="lay-dim">' + (api.onTop() ? 'on top' : 'open') + '</span>' :
        '<button type="button" class="lay-btn primary" data-act="open-float">' + I_FLOAT + ' Open float window</button>') + '</div>';
      var fl = api.floating();
      if (open) {
        h += '<div class="lay-list">' + (fl.length ? fl.map(function (p) {
          return '<div class="lay-item"><span class="lay-name">' + esc(titleOf(p)) + '</span><button type="button" class="lay-mini" data-back="' + esc(p.id) + '">Back in app</button></div>';
        }).join('') : '<p class="lay-note">Empty — send panels below, or use a panel’s pop-out button.</p>') + '</div>';
      }
      var ap = appPanels();
      if (ap.length) {
        h += '<div class="lay-sub">Open in the app</div><div class="lay-list">' + ap.map(function (p) {
          var game = p.classList.contains('cade-game-panel');
          return '<div class="lay-item"><span class="lay-name">' + esc(titleOf(p)) + '</span>' +
            (game ? '<span class="lay-dim" title="Games read the keyboard in the app window">game</span>' :
              '<button type="button" class="lay-mini" data-float="' + esc(p.id) + '">' + I_FLOAT + ' Float</button>') + '</div>';
        }).join('') + '</div>';
      }
    }
    h += '</section>';
    // ---- arrange
    h += '<section class="lay-sec"><div class="lay-h">Arrange</div>';
    if (sup.snap) {
      h += '<label class="lay-check"><input type="checkbox" data-opt="snap"' + (api.snapping() ? ' checked' : '') + '> Snap panels to edges and corners</label>' +
        '<p class="lay-note">Drag a title bar to the left or right edge for half the window, a corner for a quarter, the top to fill it. Double-click a title bar to fill / restore.</p>' +
        '<div class="lay-row"><button type="button" class="lay-btn" data-act="tile">Tile all</button><button type="button" class="lay-btn" data-act="cascade">Cascade</button></div>';
    } else h += '<p class="lay-note">Snapping works on wider screens.</p>';
    h += '</section>';
    // ---- saved
    h += '<section class="lay-sec"><div class="lay-h">Saved layouts</div>' +
      '<form class="lay-save" autocomplete="off"><input type="text" maxlength="' + MAX_NAME + '" placeholder="Name this layout" aria-label="Layout name" value="' + esc(S.draft || '') + '">' +
      '<button type="submit" class="lay-btn primary">Save</button></form>';
    if (!S.st.items.length) h += '<p class="lay-note">Arrange your panels, then save the layout here to bring it all back later.</p>';
    else h += '<div class="lay-list">' + S.st.items.map(function (it) {
      var nm = esc(it.name), names = widgetNames(it.arr);
      if (S.renaming === it.name) {
        return '<form class="lay-item lay-ren" data-ren="' + nm + '"><input type="text" maxlength="' + MAX_NAME + '" value="' + nm + '" aria-label="New name">' +
          '<button type="submit" class="lay-mini">OK</button><button type="button" class="lay-mini" data-act="ren-cancel">Cancel</button></form>';
      }
      if (S.deleting === it.name) {
        return '<div class="lay-item"><span class="lay-name">Delete “' + nm + '”?</span><button type="button" class="lay-mini danger" data-del-yes="' + nm + '">Delete</button>' +
          '<button type="button" class="lay-mini" data-act="del-cancel">Keep</button></div>';
      }
      return '<div class="lay-item lay-saved"><div class="lay-info"><span class="lay-name">' + nm + '</span>' +
        '<span class="lay-dim" title="' + esc(names.join(', ')) + '">' + esc(summary(it.arr)) + (it.at ? ' · ' + esc(when(it.at)) : '') + '</span></div>' +
        '<button type="button" class="lay-mini primary" data-load="' + nm + '">Load</button>' +
        '<button type="button" class="lay-mini" data-update="' + nm + '" title="Save the current arrangement over this one">Update</button>' +
        '<button type="button" class="lay-mini" data-ren-start="' + nm + '" title="Rename">Rename</button>' +
        '<button type="button" class="lay-mini" data-del="' + nm + '" title="Delete" aria-label="Delete ' + nm + '">×</button></div>';
    }).join('') + '</div>';
    h += '<label class="lay-check"><input type="checkbox" data-opt="replace"' + (S.opts.replace ? ' checked' : '') + '> Close other panels when loading</label>';
    h += '</section>';
    var focusSave = S.body.contains(document.activeElement) && document.activeElement.matches && document.activeElement.matches('.lay-save input');
    S.body.innerHTML = h;
    if (focusSave) { var inp = S.body.querySelector('.lay-save input'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
    var ren = S.body.querySelector('.lay-ren input'); if (ren) { ren.focus(); ren.select(); }
  }
  var renderT = 0;
  function soon() { clearTimeout(renderT); renderT = setTimeout(render, 80); }

  function saveCurrent(name, quiet) {
    var api = L(); if (!api) return;
    var arr = api.capture();
    if (!arr.panels.length) { Cade.showToast('No widget panels are open to save', 'info', 2200); return; }
    if (upsert(S.st, name, arr, Date.now())) {
      saveStore();
      if (!quiet) Cade.showToast('Saved “' + cleanName(name) + '” — ' + summary(arr), 'success', 2200);
      S.draft = '';
      render();
    }
  }
  function loadItem(name) {
    var i = findItem(S.st, name), api = L();
    if (i < 0 || !api) return;
    var it = S.st.items[i];
    Cade.showToast('Loading “' + it.name + '”…', 'info', 1200);
    api.apply(it.arr, { replace: S.opts.replace }).then(function (res) {
      if (!S) return;
      if (res.missing && res.missing.length) Cade.showToast('Couldn’t open: ' + res.missing.join(', '), 'error', 3500);
      else if (it.arr.ws && res.floated === false && it.arr.panels.some(function (e) { return e.state === 'float'; })) Cade.showToast('The float window didn’t open — its panels stay in the app', 'info', 3000);
      render();
    });
  }

  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      ex.querySelector('.cade-panel-x').click();
      return;
    }
    var p = Cade.mkPanel(PANEL_ID, '🗔️ Layouts', '<div class="lay"></div>');
    S = { panel: p, body: p.querySelector('.lay'), st: loadStore(), opts: loadOpts(), draft: '', renaming: null, deleting: null };
    // keep the lists current: panels opening / closing / floating, the float window
    S.mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i], nodes = [].concat(Array.prototype.slice.call(m.addedNodes), Array.prototype.slice.call(m.removedNodes));
        for (var j = 0; j < nodes.length; j++) if (nodes[j].classList && nodes[j].classList.contains('cade-panel') && nodes[j].id !== PANEL_ID) { soon(); return; }
      }
    });
    S.mo.observe(document.body, { childList: true });
    S.onLay = function () { soon(); };
    document.addEventListener('cade-layouts', S.onLay);
    document.addEventListener('cade-panel-popout', S.onLay);
    document.addEventListener('cade-panel-popin', S.onLay);
    p._onClose = function () {
      if (!S) return;
      S.mo.disconnect();
      document.removeEventListener('cade-layouts', S.onLay);
      document.removeEventListener('cade-panel-popout', S.onLay);
      document.removeEventListener('cade-panel-popin', S.onLay);
      clearTimeout(renderT);
      S = null;
    };
    S.body.addEventListener('input', function (e) { if (e.target.matches('.lay-save input')) S.draft = e.target.value; });
    S.body.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.classList.contains('lay-save')) {
        var nm = cleanName(f.querySelector('input').value) || suggestName(S.st, 'Layout');
        saveCurrent(nm);
      } else if (f.classList.contains('lay-ren')) {
        var to = f.querySelector('input').value;
        if (rename(S.st, f.getAttribute('data-ren'), to)) { saveStore(); S.renaming = null; render(); }
        else Cade.showToast(cleanName(to) ? 'There’s already a layout called that' : 'Give it a name', 'error', 2000);
      }
    });
    S.body.addEventListener('change', function (e) {
      var o = e.target.getAttribute('data-opt'), api = L();
      if (o === 'snap' && api) api.snapping(e.target.checked);
      else if (o === 'replace') { S.opts.replace = e.target.checked; saveOpts(); }
    });
    S.body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null, api = L();
      if (!b || !S || !api) return;
      var act = b.getAttribute('data-act'), a;
      if ((a = b.getAttribute('data-layout'))) {
        S.opts.floatLayout = a; saveOpts();
        if (api.isOpen()) api.layout(a);
        render();
      } else if (act === 'open-float') {
        api.open({ layout: S.opts.floatLayout }).then(function () { soon(); });
      } else if (act === 'close-float') { api.close(); render(); }
      else if (act === 'back-float') { if (api.backInApp) api.backInApp(); else api.close(); render(); }
      else if ((a = b.getAttribute('data-float'))) {
        var p1 = document.getElementById(a);
        if (!p1) return;
        if (api.isOpen()) { api.add(p1); soon(); }
        else api.open({ layout: S.opts.floatLayout }).then(function (ok) { if (ok) api.add(p1); soon(); });   // opens on this click
      } else if ((a = b.getAttribute('data-back'))) { var p2 = document.getElementById(a); if (p2) api.remove(p2); soon(); }
      else if (act === 'tile') { if (!api.tile()) Cade.showToast('No panels to tile', 'info', 1600); }
      else if (act === 'cascade') api.cascade();
      else if ((a = b.getAttribute('data-load'))) loadItem(a);
      else if ((a = b.getAttribute('data-update'))) saveCurrent(a);
      else if ((a = b.getAttribute('data-ren-start'))) { S.renaming = a; S.deleting = null; render(); }
      else if (act === 'ren-cancel') { S.renaming = null; render(); }
      else if ((a = b.getAttribute('data-del'))) { S.deleting = a; S.renaming = null; render(); }
      else if (act === 'del-cancel') { S.deleting = null; render(); }
      else if ((a = b.getAttribute('data-del-yes'))) { remove(S.st, a); saveStore(); S.deleting = null; render(); }
    });
    S.body.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (S.renaming || S.deleting)) { e.preventDefault(); S.renaming = S.deleting = null; render(); }
    });
    render();
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Snap and tile panels, float several in one always-on-top window, and save / load the whole arrangement',
    icon: '🗔️',
    tags: 'layout,layouts,workspace,arrange,snap,tile,cascade,float,always on top,pip,picture in picture,pop out,save,load,windows,panels,bloomberg,launchpad',
    open: open,
    _pure: PURE
  });
})();
