/* Snippets — a personal library of reusable text for Cade.txt.
 *
 * Each snippet: name, optional abbreviation (";sig", ";mtg" — typed in a note
 * and expanded by the "Snippet abbreviations" editor plugin), body, optional
 * folder, favourite flag. The panel lists favourites first, then recently used,
 * then everything A–Z; search is fuzzy over name / abbreviation / folder /
 * body. Tap a snippet to insert it at the cursor (replacing the selection),
 * with placeholders expanded:
 *   {{date}} {{date:ddd, MMM D}} {{date+3}} {{date-1w:YYYY-MM-DD}} {{time}}
 *   {{now}} {{weekday}} {{tomorrow}} {{yesterday}} {{clipboard}} {{selection}}
 *   {{cursor}} (caret ends here) and fill-in fields {{input:Client name}},
 *   {{input:Size=Small}} (default), {{input:Priority=High|Low}} (choice) —
 *   one small form asks for each distinct field before inserting.
 * Multi-line snippets take the indentation of the line they go into. Every
 * insert is ONE editor transaction (one Undo).
 *
 * Also: one-tap "From selection", an editor with live preview, duplicate,
 * delete (confirmed), import / export as JSON or a markdown list, options
 * (trigger character, Space/Enter expansion, code blocks) and a set of
 * starter snippets (meeting notes, journal, weekly review, bug report, email
 * replies, signature, timestamp, link-from-clipboard) that can be deleted.
 *
 * The model, sync and insertion live in snippets-core.js (shared with the
 * abbreviation plugin, loaded on first open). Sync: Cade.syncedBlob
 * ('snippets'); usage stats stay on this device. Nothing runs while the panel
 * is closed: no timers, no global listeners (keys are handled on the panel
 * itself), and the sync subscription is dropped on close. */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('snippets.css');

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
  var CORE_URL = abs(Cade.asset('snippets-core.js'));
  var PANEL_ID = 'snippets-panel';
  var PREFS_KEY = 'cade-snippets-prefs';
  var FAV = '\u0001fav';
  var esc = function (s) { return Cade.escapeHtml(String(s == null ? '' : s)); };
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 2200); } catch (e) {} }

  // ---- shared core (also loaded by the abbreviation plugin) ---------------------
  function loadCore() {
    if (window.__cadeSnippets) return Promise.resolve(window.__cadeSnippets);
    if (window.__cadeSnippetsLoading) return window.__cadeSnippetsLoading;
    var p = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = CORE_URL;
      s.async = true;
      s.onload = function () { if (window.__cadeSnippets) res(window.__cadeSnippets); else rej(new Error('Snippets did not load')); };
      s.onerror = function () { rej(new Error('Could not load Snippets' + (navigator.onLine ? '' : ' — it needs one online load to cache'))); };
      document.head.appendChild(s);
    });
    window.__cadeSnippetsLoading = p;
    p.catch(function () { if (window.__cadeSnippetsLoading === p) window.__cadeSnippetsLoading = null; });
    return p;
  }

  var C = null, P = null;  // core + pure model once loaded
  var V = null;            // panel state while open

  function loadPrefs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); return p && typeof p === 'object' ? p : {}; } catch (e) { return {}; }
  }
  function savePrefs() { if (V) { try { Cade.store.set(PREFS_KEY, JSON.stringify({ folder: V.folder })); } catch (e) {} } }
  function narrow() { return window.innerWidth < 600; }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  // ---- open / close ---------------------------------------------------------------
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    var el = Cade.mkPanel(PANEL_ID, '✂\ufe0f Snippets', '<div class="snx-root"><div class="snx-loading">Loading…</div></div>');
    var st = V = { el: el, root: el.querySelector('.snx-root'), view: 'list', q: '', folder: loadPrefs().folder || '', hi: 0, rows: [], hiId: null, editId: null, menu: false, unsub: null, exportFmt: 'json' };
    el._onClose = function () { teardown(st); };
    loadCore().then(function (core) {
      if (V !== st) return;
      C = core; P = core.P;
      st.unsub = C.subscribe(function (why) { if (V === st && why === 'remote') refresh(); });
      bind(st);
      showList(!coarse());
    }, function (e) {
      if (V === st) st.root.innerHTML = '<div class="snx-loading">' + esc(e.message) + '</div>';
    });
  }
  function teardown(st) {
    if (V !== st) return;
    if (st.unsub) st.unsub();
    V = null;
  }
  function close() {
    var el = document.getElementById(PANEL_ID);
    if (el) { el.remove(); if (el._onClose) el._onClose(); }
  }
  function q(sel) { return V ? V.root.querySelector(sel) : null; }
  function snippets() { return C.state().snippets; }
  function byId(id) { var l = snippets(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function draftState() { var s = P.clone(C.state()); delete s.virtual; return s; }
  function refresh() {
    if (!V) return;
    if (V.view === 'list') renderRows();
  }

  // ---- events (all on the panel: nothing global) ---------------------------------------
  function bind(st) {
    st.root.addEventListener('click', function (e) {
      if (V !== st) return;
      var t = e.target, a = t && t.closest ? t.closest('[data-act]') : null;
      if (st.menu && !(t.closest && t.closest('.snx-menu, [data-act="menu"]'))) toggleMenu(false);
      if (!a) return;
      var act = a.getAttribute('data-act'), row = a.closest('.snx-row'), id = row ? row.getAttribute('data-id') : null;
      switch (act) {
        case 'insert': insertById(id); break;
        case 'fav': toggleFav(id); break;
        case 'edit': openEdit(id); break;
        case 'new': openEdit(null, { name: st.q.trim() }); break;
        case 'menu': toggleMenu(!st.menu); break;
        case 'fromsel': fromSelection(); break;
        case 'chip': st.folder = a.getAttribute('data-folder') || ''; st.hi = 0; savePrefs(); renderRows(); break;
        case 'clearq': st.q = ''; var qi = q('.snx-q'); if (qi) { qi.value = ''; qi.focus(); } st.hi = 0; renderRows(); break;
        case 'cancel': cancelEdit(); break;
        case 'dup': duplicate(); break;
        case 'delete': remove(); break;
        case 'token': addToken(a.getAttribute('data-tok')); break;
        case 'import': toggleMenu(false); showImport(); break;
        case 'export': toggleMenu(false); showExport(); break;
        case 'settings': toggleMenu(false); showSettings(); break;
        case 'restore': toggleMenu(false); restore(); break;
        case 'back': showList(!coarse()); break;
        case 'doimport': doImport(); break;
        case 'fmt': st.exportFmt = a.getAttribute('data-fmt'); showExport(); break;
        case 'copy': copyExport(); break;
        case 'download': downloadExport(); break;
        case 'insertexport': insertExport(); break;
        case 'savesettings': saveSettings(); break;
      }
    });
    st.root.addEventListener('input', function (e) {
      if (V !== st) return;
      var t = e.target;
      if (t.classList.contains('snx-q')) { st.q = t.value; st.hi = 0; renderRows(); }
      else if (st.view === 'edit') { st.dirty = true; renderPreview(); checkAbbr(false); }
      else if (st.view === 'import' && t.classList.contains('snx-io-text')) importSummary();
    });
    st.root.addEventListener('change', function (e) {
      if (V === st && e.target && e.target.classList.contains('snx-file')) readFile(e.target);
    });
    st.root.addEventListener('submit', function (e) { e.preventDefault(); if (V === st && st.view === 'edit') saveEdit(); });
    st.root.addEventListener('keydown', function (e) { if (V === st) key(e); });
  }

  function key(e) {
    var k = e.key, mod = e.ctrlKey || e.metaKey;
    if (e.isComposing || e.keyCode === 229) return;
    if (k === 'Escape' && V.menu) { e.preventDefault(); e.stopPropagation(); toggleMenu(false); return; }
    if (V.view === 'list') {
      var inQ = e.target && e.target.classList && e.target.classList.contains('snx-q');
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (!V.rows.length) return;
        e.preventDefault();
        if (!V.kbd && !V.q.trim()) V.hi = k === 'ArrowDown' ? -1 : 0; // first press lands on the first / last row
        V.kbd = true;
        V.hi = (V.hi + (k === 'ArrowDown' ? 1 : -1) + V.rows.length) % V.rows.length;
        markHi(true);
      } else if (k === 'Enter' && inQ && !mod) {
        e.preventDefault();
        if (V.rows[V.hi]) insertById(V.rows[V.hi].id);
        else if (V.q.trim()) openEdit(null, { name: V.q.trim() });
      } else if (k === 'Enter' && inQ && mod && V.rows[V.hi]) {
        e.preventDefault(); openEdit(V.rows[V.hi].id);
      } else if (k === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (V.q) { V.q = ''; var qi = q('.snx-q'); if (qi) qi.value = ''; V.hi = 0; renderRows(); }
        else close();
      }
    } else if (V.view === 'edit') {
      if ((k === 'Enter' && mod) || ((k === 's' || k === 'S') && mod)) { e.preventDefault(); saveEdit(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
      else if (k === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        // Enter in a one-line field moves on instead of saving half a snippet.
        e.preventDefault();
        var order = ['.snx-e-name', '.snx-e-abbr', '.snx-e-folder', '.snx-e-body'];
        for (var i = 0; i < order.length - 1; i++) if (e.target.matches(order[i])) { q(order[i + 1]).focus(); break; }
      }
    } else if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation(); showList(!coarse());
    }
  }

  // ---- list view ---------------------------------------------------------------------
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function showList(focus) {
    V.view = 'list'; V.dirty = false; V.menu = false; V.kbd = false;
    V.root.innerHTML =
      '<div class="snx-top">' +
        '<div class="snx-search">' + ICON_SEARCH +
          '<input class="snx-q" type="search" placeholder="Search snippets" aria-label="Search snippets" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">' +
          '<button type="button" class="snx-clearq" data-act="clearq" aria-label="Clear search" hidden>×</button>' +
        '</div>' +
        '<button type="button" class="snx-ibtn" data-act="new" title="New snippet" aria-label="New snippet">＋</button>' +
        '<button type="button" class="snx-ibtn" data-act="menu" title="Import, export, options" aria-label="More" aria-haspopup="true">⋯</button>' +
        '<div class="snx-menu" role="menu" hidden>' +
          '<button type="button" role="menuitem" data-act="import">Import…</button>' +
          '<button type="button" role="menuitem" data-act="export">Export…</button>' +
          '<button type="button" role="menuitem" data-act="settings">Options…</button>' +
          '<button type="button" role="menuitem" data-act="restore">Restore starter snippets</button>' +
        '</div>' +
      '</div>' +
      '<div class="snx-chips" role="tablist"></div>' +
      '<div class="snx-list" role="listbox" aria-label="Snippets"></div>' +
      '<div class="snx-foot">' +
        '<button type="button" class="snx-btn snx-fromsel" data-act="fromsel" title="Save the text selected in the note as a new snippet">＋ From selection</button>' +
        '<span class="snx-hint"></span>' +
      '</div>';
    var qi = q('.snx-q');
    qi.value = V.q;
    renderRows();
    if (focus) setTimeout(function () { if (V && V.view === 'list' && qi.isConnected) qi.focus(); }, 0);
  }
  function bodyPreview(b) {
    var t = String(b || '').replace(/\s*\n\s*/g, ' ↵ ').replace(/\s+/g, ' ').trim();
    return t.length > 140 ? t.slice(0, 140) + '…' : t;
  }
  function renderRows() {
    var list = q('.snx-list'), chips = q('.snx-chips');
    if (!list) return;
    var st = C.state(), all = st.snippets, use = C.usage(), folders = P.folders(all);
    if (V.folder && V.folder !== FAV && !folders.some(function (f) { return f.toLowerCase() === V.folder.toLowerCase(); })) V.folder = '';
    var favCount = all.filter(function (s) { return s.fav; }).length;
    if (V.folder === FAV && !favCount) V.folder = '';
    // chips
    var ch = '<button type="button" class="snx-chip' + (!V.folder ? ' on' : '') + '" data-act="chip" data-folder="">All <span>' + all.length + '</span></button>';
    if (favCount) ch += '<button type="button" class="snx-chip' + (V.folder === FAV ? ' on' : '') + '" data-act="chip" data-folder="' + FAV + '">★ Favourites <span>' + favCount + '</span></button>';
    folders.forEach(function (f) {
      var n = all.filter(function (s) { return s.folder.toLowerCase() === f.toLowerCase(); }).length;
      ch += '<button type="button" class="snx-chip' + (V.folder.toLowerCase() === f.toLowerCase() ? ' on' : '') + '" data-act="chip" data-folder="' + esc(f) + '">' + esc(f) + ' <span>' + n + '</span></button>';
    });
    chips.innerHTML = ch;
    chips.hidden = !favCount && !folders.length;
    var pool = all.filter(function (s) {
      if (!V.folder) return true;
      if (V.folder === FAV) return s.fav;
      return s.folder.toLowerCase() === V.folder.toLowerCase();
    });
    var html = '', rows = [];
    var qv = V.q.trim();
    var clr = q('.snx-clearq'); if (clr) clr.hidden = !V.q;
    var add = function (s) { html += rowHtml(s, rows.length); rows.push(s); };
    if (qv) {
      P.search(pool, qv, use).forEach(add);
    } else {
      var o = P.ordered(pool, use, 5);
      if (o.favs.length && V.folder !== FAV) { html += '<div class="snx-sec">★ Favourites</div>'; o.favs.forEach(add); }
      else o.favs.forEach(add);
      if (o.recent.length) { html += '<div class="snx-sec">Recently used</div>'; o.recent.forEach(add); }
      if (o.rest.length && (o.favs.length && V.folder !== FAV || o.recent.length)) html += '<div class="snx-sec">' + (V.folder && V.folder !== FAV ? esc(V.folder) : 'All snippets') + '</div>';
      o.rest.forEach(add);
    }
    if (!rows.length) {
      html = qv
        ? '<div class="snx-empty">No snippet matches “' + esc(qv) + '”.<br><button type="button" class="snx-btn" data-act="new">＋ Create “' + esc(qv.length > 40 ? qv.slice(0, 40) + '…' : qv) + '”</button></div>'
        : '<div class="snx-empty">No snippets yet. Select text in a note and tap <b>＋ From selection</b>, or tap <b>＋</b> to write one.</div>';
    }
    if (V.hiId) { for (var i = 0; i < rows.length; i++) if (rows[i].id === V.hiId) { V.hi = i; break; } V.hiId = null; }
    if (V.hi >= rows.length) V.hi = Math.max(0, rows.length - 1);
    V.rows = rows;
    list.innerHTML = html;
    markHi(false);
    var hint = q('.snx-hint');
    if (hint) {
      var tr = st.opts.trigger, ex = null;
      for (var j = 0; j < all.length && !ex; j++) if (all[j].abbr) ex = all[j].abbr;
      hint.innerHTML = ex ? 'Type <code>' + esc(ex) + '</code> then ' + (coarse() ? 'Space' : 'Tab') + ' in a note' : 'Abbreviations start with <code>' + esc(tr) + '</code>';
    }
  }
  function rowHtml(s, i) {
    return '<div class="snx-row" role="option" data-i="' + i + '" data-id="' + esc(s.id) + '">' +
      '<button type="button" class="snx-star' + (s.fav ? ' on' : '') + '" data-act="fav" aria-pressed="' + (s.fav ? 'true' : 'false') + '" title="' + (s.fav ? 'Remove from favourites' : 'Add to favourites') + '" aria-label="Favourite">' + (s.fav ? '★' : '☆') + '</button>' +
      '<button type="button" class="snx-main" data-act="insert" title="Insert at the cursor">' +
        '<span class="snx-l1"><span class="snx-name">' + esc(s.name) + '</span>' +
          (s.abbr ? '<code class="snx-abbr">' + esc(s.abbr) + '</code>' : '') +
          (s.folder && !V.folder ? '<span class="snx-tag">' + esc(s.folder) + '</span>' : '') + '</span>' +
        '<span class="snx-l2">' + esc(bodyPreview(s.body)).replace(/\{\{[^{}\n]{1,60}\}\}/g, '<span class="snx-phl">$&</span>') + '</span>' +
      '</button>' +
      '<button type="button" class="snx-ibtn snx-edit" data-act="edit" title="Edit" aria-label="Edit ' + esc(s.name) + '">✎</button>' +
    '</div>';
  }
  // The highlighted row is what Enter / "Go" inserts: shown while searching or
  // after arrow keys, not as a stray selection on a fresh list.
  function markHi(scroll) {
    var rows = V.root.querySelectorAll('.snx-row'), show = !!V.q.trim() || V.kbd;
    for (var i = 0; i < rows.length; i++) {
      var on = show && i === V.hi;
      rows[i].classList.toggle('on', on);
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) rows[i].scrollIntoView({ block: 'nearest' });
    }
  }
  function toggleMenu(on) {
    V.menu = !!on;
    var m = q('.snx-menu');
    if (!m) return;
    m.hidden = !on;
    if (on) {
      var missing = P.restoreStarters(C.state(), 0).added;
      var r = m.querySelector('[data-act="restore"]');
      if (r) r.hidden = !missing || C.state().virtual;
    }
  }

  // ---- actions ------------------------------------------------------------------------
  function insertById(id) {
    var s = byId(id), ed = Cade.editor;
    if (!s || !ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
    var info = C.plan(s);
    var clip = info.clipboard ? C.readClipboard() : null; // read inside this tap
    V.hiId = s.id;
    var phone = narrow();
    if (phone) close(); // let the note (and keyboard) have the screen
    var r = C.insert(ed, s, {
      source: 'widget', clip: clip,
      done: function (ok) { if (ok && V && V.view === 'list') renderRows(); },
    });
    if (r === true && V && V.view === 'list') renderRows();
  }
  function toggleFav(id) {
    var st = draftState();
    for (var i = 0; i < st.snippets.length; i++) if (st.snippets[i].id === id) { st.snippets[i].fav = !st.snippets[i].fav; break; }
    V.hiId = id;
    if (C.save(st)) renderRows();
  }
  function fromSelection() {
    var ed = Cade.editor;
    if (!ed) return;
    var sel = ed.state.selection.main;
    if (sel.empty) { toast('Select some text in the note first', 'info'); return; }
    var text = P.dedent(ed.state.sliceDoc(sel.from, sel.to)).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
    if (!text) { toast('The selection is empty', 'info'); return; }
    if (text.length > P.MAX_BODY) { toast('That selection is too long for a snippet (max ' + Math.round(P.MAX_BODY / 1000) + 'k characters)', 'error', 3500); return; }
    var st = draftState();
    if (st.snippets.length >= P.MAX_SNIPPETS) { toast('The library is full (' + P.MAX_SNIPPETS + ' snippets)', 'error'); return; }
    var now = Date.now(), ids = {};
    st.snippets.forEach(function (s) { ids[s.id] = 1; });
    var s = { id: P.newId(ids), name: P.firstLine(text) || 'New snippet', abbr: '', body: text, folder: V.folder && V.folder !== FAV ? V.folder : '', fav: false, created: now, updated: now };
    st.snippets.push(s);
    if (!C.save(st)) return;
    toast('Saved “' + s.name + '” — add an abbreviation to expand it while typing', 'success', 3200);
    openEdit(s.id, { focus: 'abbr' });
  }
  function restore() {
    var r = P.restoreStarters(C.state(), Date.now());
    if (!r.added) { toast('All starter snippets are already here', 'info'); return; }
    if (C.save(r.state)) { toast('Restored ' + r.added + ' starter snippet' + (r.added === 1 ? '' : 's'), 'success'); renderRows(); }
  }

  // ---- editor view ----------------------------------------------------------------------
  var TOKENS = [
    ['{{date}}', 'date'], ['{{time}}', 'time'], ['{{weekday}}', 'weekday'], ['{{tomorrow}}', 'tomorrow'],
    ['{{clipboard}}', 'clipboard'], ['{{selection}}', 'selection'], ['{{cursor}}', 'cursor'], ['{{input:Name}}', 'input…'],
  ];
  function openEdit(id, o) {
    o = o || {};
    var s = id ? byId(id) : null;
    if (id && !s) { showList(!coarse()); return; }
    if (!s && snippets().length >= P.MAX_SNIPPETS) { toast('The library is full (' + P.MAX_SNIPPETS + ' snippets)', 'error'); return; }
    V.view = 'edit'; V.editId = s ? s.id : null; V.dirty = false; V.menu = false;
    var tr = C.state().opts.trigger, folders = P.folders(snippets());
    V.root.innerHTML =
      '<form class="snx-editor" novalidate>' +
        '<div class="snx-etitle">' + (s ? 'Edit snippet' : 'New snippet') + '</div>' +
        '<label class="snx-f"><span>Name</span><input class="snx-in snx-e-name" maxlength="120" placeholder="e.g. Email signature" autocomplete="off" enterkeyhint="next"></label>' +
        '<div class="snx-two">' +
          '<label class="snx-f"><span>Abbreviation <small>optional</small></span><input class="snx-in snx-mono snx-e-abbr" maxlength="' + P.MAX_ABBR + '" placeholder="' + esc(tr) + 'sig" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="next"></label>' +
          '<label class="snx-f"><span>Folder <small>optional</small></span><input class="snx-in snx-e-folder" maxlength="40" list="snx-folders" placeholder="e.g. Email" autocomplete="off" enterkeyhint="next">' +
            '<datalist id="snx-folders">' + folders.map(function (f) { return '<option value="' + esc(f) + '">'; }).join('') + '</datalist></label>' +
        '</div>' +
        '<div class="snx-err" aria-live="polite"></div>' +
        '<label class="snx-f"><span>Text</span><textarea class="snx-in snx-mono snx-e-body" rows="8" spellcheck="false" autocapitalize="sentences" placeholder="Text to insert. Placeholders: {{date}}, {{input:Client name}}, {{cursor}}…"></textarea></label>' +
        '<div class="snx-tokens" aria-label="Insert a placeholder">' + TOKENS.map(function (t) {
          return '<button type="button" class="snx-tok" data-act="token" data-tok="' + esc(t[0]) + '">' + esc(t[1]) + '</button>';
        }).join('') + '</div>' +
        '<details class="snx-help"><summary>Placeholder help</summary><div class="snx-helpbody">' +
          '<code>{{date}}</code> 2026-10-14 · <code>{{date:ddd, MMM D}}</code> Wed, Oct 14 · <code>{{date+3}}</code> in 3 days (<code>d w m y</code>) · ' +
          '<code>{{tomorrow}}</code> <code>{{yesterday}}</code> · <code>{{time}}</code> <code>{{time:HH:mm}}</code> · <code>{{now}}</code> · <code>{{weekday}}</code><br>' +
          'Date parts: <code>YYYY YY MMMM MMM MM M Do DD D dddd ddd HH H hh h mm ss A a W Q</code>, <code>[text]</code> stays literal.<br>' +
          '<code>{{clipboard}}</code> what you copied · <code>{{selection}}</code> the selected text it replaces · <code>{{cursor}}</code> where the caret ends up<br>' +
          '<code>{{input:Client}}</code> asks before inserting (same name = same answer) · <code>{{input:Size=M}}</code> with a default · <code>{{input:Pri=High|Low}}</code> a choice<br>' +
          'Write <code>\\{{</code> for literal braces. Lines after the first take the indentation of the line you insert into.' +
        '</div></details>' +
        '<div class="snx-prevlabel">Preview</div><div class="snx-prev"></div>' +
        '<div class="snx-actions">' +
          (s ? '<button type="button" class="snx-btn danger" data-act="delete">Delete</button><button type="button" class="snx-btn" data-act="dup">Duplicate</button>' : '') +
          '<span class="snx-sp"></span>' +
          '<button type="button" class="snx-btn" data-act="cancel">Cancel</button>' +
          '<button type="submit" class="snx-btn primary">Save</button>' +
        '</div>' +
      '</form>';
    q('.snx-e-name').value = s ? s.name : (o.name || '');
    q('.snx-e-abbr').value = s ? s.abbr : '';
    q('.snx-e-folder').value = s ? s.folder : (V.folder && V.folder !== FAV ? V.folder : '');
    q('.snx-e-body').value = s ? s.body : '';
    renderPreview();
    var f = o.focus === 'abbr' ? q('.snx-e-abbr') : (s ? q('.snx-e-body') : (o.name ? q('.snx-e-body') : q('.snx-e-name')));
    if (f && (!coarse() || o.focus)) setTimeout(function () { if (f.isConnected) f.focus(); }, 0);
  }
  function renderPreview() {
    var p = q('.snx-prev'), b = q('.snx-e-body');
    if (p && b) p.innerHTML = C.previewHtml(b.value, {}, false);
  }
  function checkAbbr(final) {
    var a = q('.snx-e-abbr'), err = q('.snx-err');
    if (!a || !err) return '';
    var tr = C.state().opts.trigger;
    var v = final ? P.cleanAbbr(a.value, tr) : a.value.replace(/\s+/g, '');
    var msg = v && (final || v.length > 1) ? P.abbrError(final ? v : P.cleanAbbr(v, tr), tr, snippets(), V.editId) : '';
    err.textContent = msg;
    a.classList.toggle('bad', !!msg);
    return msg;
  }
  function formValues() {
    var tr = C.state().opts.trigger;
    var body = q('.snx-e-body').value.replace(/\r\n?/g, '\n');
    return {
      name: q('.snx-e-name').value.replace(/\s+/g, ' ').trim() || P.firstLine(body) || 'Untitled',
      abbr: P.cleanAbbr(q('.snx-e-abbr').value, tr),
      folder: q('.snx-e-folder').value.replace(/\s+/g, ' ').trim().slice(0, 40),
      body: body,
    };
  }
  // Validate + write the form. Returns the saved snippet id or null.
  function commitEdit() {
    var v = formValues(), err = q('.snx-err');
    if (!v.body.trim()) { err.textContent = 'Add the text to insert'; q('.snx-e-body').focus(); return null; }
    if (v.body.length > P.MAX_BODY) { err.textContent = 'That is too long (max ' + Math.round(P.MAX_BODY / 1000) + 'k characters)'; return null; }
    if (checkAbbr(true)) { q('.snx-e-abbr').focus(); return null; }
    var st = draftState(), now = Date.now(), id = V.editId, found = false;
    for (var i = 0; i < st.snippets.length; i++) {
      var s = st.snippets[i];
      if (s.id === id) { s.name = v.name; s.abbr = v.abbr; s.folder = v.folder; s.body = v.body; s.updated = now; found = true; break; }
    }
    if (!found) {
      var ids = {};
      st.snippets.forEach(function (x) { ids[x.id] = 1; });
      id = P.newId(ids);
      st.snippets.push({ id: id, name: v.name, abbr: v.abbr, folder: v.folder, body: v.body, fav: false, created: now, updated: now });
    }
    if (!C.save(st)) return null;
    V.editId = id; V.dirty = false;
    return id;
  }
  function saveEdit() {
    var id = commitEdit();
    if (!id) return;
    V.hiId = id;
    showList(!coarse());
  }
  function cancelEdit() {
    if (V.dirty && !window.confirm('Discard your changes to this snippet?')) return;
    V.hiId = V.editId;
    showList(!coarse());
  }
  function duplicate() {
    var id = commitEdit();
    if (!id) return;
    var src = byId(id), st = draftState(), ids = {}, now = Date.now();
    st.snippets.forEach(function (x) { ids[x.id] = 1; });
    var copy = { id: P.newId(ids), name: (src.name + ' (copy)').slice(0, 120), abbr: '', folder: src.folder, body: src.body, fav: false, created: now, updated: now };
    st.snippets.push(copy);
    if (!C.save(st)) return;
    toast('Duplicated — now editing the copy', 'success');
    openEdit(copy.id);
  }
  function remove() {
    var s = byId(V.editId);
    if (!s) { showList(!coarse()); return; }
    if (!window.confirm('Delete the snippet “' + s.name + '”?')) return;
    var st = draftState();
    st.snippets = st.snippets.filter(function (x) { return x.id !== s.id; });
    if (!C.save(st)) return;
    toast('Deleted “' + s.name + '”', 'success');
    showList(!coarse());
  }
  function addToken(tok) {
    var ta = q('.snx-e-body');
    if (!ta || !tok) return;
    var a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
    ta.value = v.slice(0, a) + tok + v.slice(b);
    var selA = a + tok.length, selB = selA;
    var m = /^\{\{input:(.*)\}\}$/.exec(tok);
    if (m) { selA = a + 8; selB = selA + m[1].length; } // select "Name" to type over
    ta.focus();
    try { ta.setSelectionRange(selA, selB); } catch (e) {}
    V.dirty = true;
    renderPreview();
  }

  // ---- import / export ------------------------------------------------------------------------
  function showImport() {
    V.view = 'import';
    V.root.innerHTML =
      '<div class="snx-io">' +
        '<div class="snx-etitle">Import snippets</div>' +
        '<p class="snx-note">Paste an export (JSON or markdown) or choose a file. A hand-written markdown list works too: one <code>- Name: text</code> line per snippet, or <code>- **Name** `' + esc(C.state().opts.trigger) + 'abbr`</code> with the text in an indented <code>```</code> block below it. Snippets you already have are skipped.</p>' +
        '<textarea class="snx-in snx-mono snx-io-text" rows="8" spellcheck="false" placeholder="Paste JSON or a markdown list…"></textarea>' +
        '<div class="snx-io-sum" aria-live="polite"></div>' +
        '<div class="snx-actions">' +
          '<label class="snx-btn snx-filebtn">Choose file…<input type="file" class="snx-file" accept=".json,.md,.markdown,.txt,application/json,text/markdown,text/plain"></label>' +
          '<span class="snx-sp"></span>' +
          '<button type="button" class="snx-btn" data-act="back">Back</button>' +
          '<button type="button" class="snx-btn primary" data-act="doimport">Import</button>' +
        '</div>' +
      '</div>';
    if (!coarse()) q('.snx-io-text').focus();
  }
  function importSummary() {
    var t = q('.snx-io-text'), sum = q('.snx-io-sum');
    if (!t || !sum) return;
    if (!t.value.trim()) { sum.textContent = ''; return; }
    var r = P.parseImport(t.value);
    sum.textContent = r.error ? r.error : 'Found ' + r.snippets.length + ' snippet' + (r.snippets.length === 1 ? '' : 's') + (r.format ? ' (' + r.format + ')' : '');
    sum.classList.toggle('bad', !!r.error || !r.snippets.length);
  }
  function readFile(input) {
    var f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    if (f.size > 2000000) { toast('That file is too large to import', 'error'); return; }
    var rd = new FileReader();
    rd.onload = function () { if (V && V.view === 'import') { q('.snx-io-text').value = String(rd.result || ''); importSummary(); } };
    rd.onerror = function () { toast('Could not read that file', 'error'); };
    rd.readAsText(f);
  }
  function doImport() {
    var t = q('.snx-io-text');
    var r = P.parseImport(t ? t.value : '');
    if (r.error) { toast(r.error, 'error', 3500); return; }
    if (!r.snippets.length) { toast('Nothing to import — paste JSON or a markdown list first', 'info', 3000); return; }
    var m = P.mergeImport(C.state(), r.snippets, Date.now());
    if (!m.added) { toast('Nothing new — ' + m.skipped + ' already in your library', 'info', 3000); return; }
    if (!C.save(m.state)) return;
    toast('Imported ' + m.added + ' snippet' + (m.added === 1 ? '' : 's') + (m.skipped ? ' · skipped ' + m.skipped : '') + (m.conflicts ? ' · ' + m.conflicts + ' abbreviation' + (m.conflicts === 1 ? ' was' : 's were') + ' taken, left blank' : ''), 'success', 3500);
    V.folder = '';
    showList(!coarse());
  }
  function exportText() { return V.exportFmt === 'md' ? P.exportMarkdown(C.state()) : P.exportJSON(C.state()); }
  function showExport() {
    V.view = 'export';
    var n = snippets().length, fmt = V.exportFmt;
    V.root.innerHTML =
      '<div class="snx-io">' +
        '<div class="snx-etitle">Export ' + n + ' snippet' + (n === 1 ? '' : 's') + '</div>' +
        '<div class="snx-seg" role="tablist">' +
          '<button type="button" role="tab" class="snx-segb' + (fmt === 'json' ? ' on' : '') + '" data-act="fmt" data-fmt="json" aria-selected="' + (fmt === 'json') + '">JSON</button>' +
          '<button type="button" role="tab" class="snx-segb' + (fmt === 'md' ? ' on' : '') + '" data-act="fmt" data-fmt="md" aria-selected="' + (fmt === 'md') + '">Markdown list</button>' +
        '</div>' +
        '<textarea class="snx-in snx-mono snx-io-text" rows="9" readonly spellcheck="false"></textarea>' +
        '<div class="snx-actions">' +
          '<button type="button" class="snx-btn" data-act="back">Back</button>' +
          '<span class="snx-sp"></span>' +
          '<button type="button" class="snx-btn" data-act="insertexport" title="Insert at the cursor in the note">Insert in note</button>' +
          '<button type="button" class="snx-btn" data-act="download">Download</button>' +
          '<button type="button" class="snx-btn primary" data-act="copy">Copy</button>' +
        '</div>' +
      '</div>';
    q('.snx-io-text').value = exportText();
  }
  function copyExport() {
    var text = exportText();
    var ok = function () { toast('Copied', 'success', 1400); };
    var fallback = function () {
      var ta = q('.snx-io-text');
      try { ta.focus(); ta.select(); if (document.execCommand('copy')) ok(); else toast('Copy failed — select the text and copy it', 'error'); }
      catch (e) { toast('Copy failed — select the text and copy it', 'error'); }
    };
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(ok, fallback); return; } } catch (e) {}
    fallback();
  }
  function downloadExport() {
    var md = V.exportFmt === 'md';
    var d = new Date(), stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var url = URL.createObjectURL(new Blob([exportText()], { type: md ? 'text/markdown' : 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'snippets-' + stamp + (md ? '.md' : '.json');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function insertExport() {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error'); return; }
    ed.dispatch(ed.state.replaceSelection(exportText()), { userEvent: 'input.snippet', scrollIntoView: true });
    toast('Inserted into the note', 'success', 1400);
  }

  // ---- options ------------------------------------------------------------------------------
  function showSettings() {
    V.view = 'settings';
    var o = C.state().opts, plug = null;
    try { plug = Cade.Settings && Cade.Settings.get ? Cade.Settings.get('plugins.snippet-expand') : null; } catch (e) {}
    V.root.innerHTML =
      '<div class="snx-io snx-settings">' +
        '<div class="snx-etitle">Options <small>(synced)</small></div>' +
        '<label class="snx-f snx-trig"><span>Trigger character</span><input class="snx-in snx-mono snx-s-trig" maxlength="1" value="' + esc(o.trigger) + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>' +
        '<label class="snx-check"><input type="checkbox" class="snx-s-retrig" checked><span>Also switch existing abbreviations to the new character</span></label>' +
        '<label class="snx-check"><input type="checkbox" class="snx-s-space"' + (o.space ? ' checked' : '') + '><span>Expand when I press Space or Enter after an abbreviation <small>(Tab always expands)</small></span></label>' +
        '<label class="snx-check"><input type="checkbox" class="snx-s-fences"' + (o.fences ? ' checked' : '') + '><span>Expand inside <code>```</code> code blocks too</span></label>' +
        '<div class="snx-err" aria-live="polite"></div>' +
        '<p class="snx-note">Typing an abbreviation in a note expands it when <b>Settings → Editor → Snippet abbreviations</b> is on' +
          (plug === false ? ' — <b>it is off on this device</b>.' : '.') +
          ' Type the trigger twice (<code>' + esc(o.trigger + o.trigger) + 'sig</code>) to keep an abbreviation as plain text.</p>' +
        '<div class="snx-actions"><button type="button" class="snx-btn" data-act="back">Back</button><span class="snx-sp"></span>' +
          '<button type="button" class="snx-btn primary" data-act="savesettings">Save</button></div>' +
      '</div>';
  }
  function saveSettings() {
    var cur = C.state(), t = q('.snx-s-trig').value.trim(), err = q('.snx-err');
    if (!P.validTrigger(t)) { err.textContent = 'Use one symbol such as ; ! , / \\ ` ~ or #'; q('.snx-s-trig').focus(); return; }
    var next = draftState();
    if (t !== cur.opts.trigger && q('.snx-s-retrig').checked) next = P.retrigger(next, cur.opts.trigger, t);
    next.opts.trigger = t;
    next.opts.space = q('.snx-s-space').checked;
    next.opts.fences = q('.snx-s-fences').checked;
    if (!C.save(next)) return;
    toast('Options saved', 'success', 1400);
    showList(!coarse());
  }

  Cade.registerWidget({
    name: 'Snippets',
    description: 'Reusable text with placeholders — insert templates, signatures and replies, or type ;abbreviations to expand them',
    icon: '✂\ufe0f',
    tags: 'snippets,snippet,text expander,expand,abbreviation,abbreviations,template,templates,boilerplate,canned response,reply,signature,macro,placeholder,insert,clipboard,meeting notes,journal',
    open: open,
    close: close,
  });
})();
