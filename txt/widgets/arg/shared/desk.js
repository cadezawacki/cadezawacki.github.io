/* ============================================================
   ARG Desk — app shell (window.Desk)
   Router, game switcher, sidebar, phone tabs, statusbar, and the
   LLM export / import panels. Views register themselves:

     Desk.registerView({
       id: 'trail', title: 'Trail',
       routes: function (token) { return token === 'trail' ? {} : null; },   // params or null
       mount: function (host, params, ctx) {
         return { update(params) {}, unmount() {}, exportScope() {}, navToken() {} };
       },
     });

   Route tokens (bare: letters, digits, . _ ~ -):
     overview · trail · trail.P04 · crafter · crafter.P03 · crafter.scratch · research · ideas
     chapters · events · puzzles · clues · characters · places · timeline · assets
     questions · tasks · notes · problems · <any entity id>

   Navigation never adds browser-history entries (the desk lives in an iframe inside
   cade.txt, and history entries there would hijack the app's back gesture). Desk keeps
   its own back stack instead (Desk.back()).
   ============================================================ */
(function () {
  'use strict';
  var D = window.ARG;
  var Desk = { views: [], current: null };

  var COLLECTION_TOKENS = {
    chapter: 'chapters', event: 'events', puzzle: 'puzzles', clue: 'clues', character: 'characters', place: 'places',
    entry: 'timeline', asset: 'assets', question: 'questions', task: 'tasks',
    note: 'notes', research: 'research', idea: 'ideas',
  };
  Desk.collectionToken = function (type) { return COLLECTION_TOKENS[type] || null; };
  Desk.typeFromToken = function (token) {
    var hit = null;
    Object.keys(COLLECTION_TOKENS).forEach(function (t) { if (COLLECTION_TOKENS[t] === token) hit = t; });
    return hit;
  };
  Desk.isPhone = function () { return window.matchMedia('(max-width: 760px)').matches; };
  Desk.embedded = (function () { try { return window.parent !== window && !!window.parent.__argDesk; } catch (e) { return false; } })();

  Desk.registerView = function (def) {
    Desk.views = Desk.views.filter(function (v) { return v.id !== def.id; });
    Desk.views.push(def);
    if (Desk.started) render();
  };

  /* ---------- navigation ---------- */
  var token = 'overview', stack = [];
  var ROUTE_KEY = function () { return 'argdesk-route-' + (Kit.games.current() || 'none'); };
  function writeUrl(t) {
    try { history.replaceState(null, '', '#' + t); } catch (e) { /* sandboxed: keep the route in memory only */ }
    try { localStorage.setItem(ROUTE_KEY(), t); } catch (e) { /* storage unavailable */ }
  }
  Desk.go = function (t, opts) {
    t = String(t || 'overview');
    if (t !== token && !(opts && opts.replace)) { stack.push(token); if (stack.length > 80) stack.shift(); }
    token = t;
    writeUrl(t);
    render();
  };
  Desk.back = function () {
    if (!stack.length) { Desk.go('overview', { replace: true }); return; }
    token = stack.pop(); writeUrl(token); render();
  };
  Desk.canGoBack = function () { return stack.length > 0; };
  function findView(t) {
    for (var i = 0; i < Desk.views.length; i++) {
      var p = null;
      try { p = Desk.views[i].routes(t); } catch (e) { p = null; }
      if (p) return { view: Desk.views[i], params: p };
    }
    return null;
  }
  var host, ctx;
  function unmountCurrent() {
    var cur = Desk.current;
    if (cur && cur.inst && cur.inst.unmount) { try { cur.inst.unmount(); } catch (e) { console.error(e); } }
    Desk.current = null;
  }
  function render() {
    if (!Kit.games.current()) { renderWelcome(); return; }
    var hit = findView(token);
    if (!hit) {
      if (token !== 'overview') { Kit.toast('Nothing lives at "' + token + '" any more. Showing the overview.'); token = 'overview'; writeUrl(token); render(); return; }
      host.innerHTML = '<div class="view-stub">No views are installed.</div>';
      return;
    }
    var cur = Desk.current;
    if (cur && cur.view === hit.view && cur.inst && cur.inst.update) {
      cur.token = token; cur.params = hit.params;
      try { cur.inst.update(hit.params); } catch (e) { console.error(e); }
    } else {
      unmountCurrent();
      host.innerHTML = '';
      var root = Kit.h('div', { class: 'view-root v-' + hit.view.id });
      host.appendChild(root);
      Desk.current = { view: hit.view, params: hit.params, token: token, inst: null, root: root };
      setStatus([]);
      try { Desk.current.inst = hit.view.mount(root, hit.params, ctx) || {}; }
      catch (e) { console.error(e); root.innerHTML = '<div class="view-stub">This view failed to load: ' + Kit.esc(e.message) + '</div>'; Desk.current.inst = {}; }
    }
    document.title = (hit.view.title ? hit.view.title + ' · ' : '') + 'ARG Desk';
    markNav();
  }
  function activeNavToken() {
    var cur = Desk.current; if (!cur) return 'overview';
    if (cur.inst && cur.inst.navToken) { try { var t = cur.inst.navToken(); if (t) return t; } catch (e) { /* ignore */ } }
    if (Kit.has(cur.token)) return COLLECTION_TOKENS[Kit.type(cur.token)] || cur.token;
    return cur.token.split('.')[0];
  }
  var TAB_FAMILY = { overview: 'overview', trail: 'trail', crafter: 'crafter', research: 'library', ideas: 'library' };
  function markNav() {
    var t = activeNavToken();
    Array.prototype.forEach.call(document.querySelectorAll('.side-link[data-route]'), function (a) {
      if (a.dataset.route === t) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var fam = TAB_FAMILY[t] || 'codex';
    Array.prototype.forEach.call(document.querySelectorAll('.desk-tab'), function (a) {
      if (a.dataset.family === fam) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (fam === 'codex') lastCodex = t; if (fam === 'library') lastLibrary = t;
  }
  var lastCodex = 'puzzles', lastLibrary = 'research';

  /* ---------- statusbar ---------- */
  function setStatus(parts) {
    var el = document.getElementById('sb-left');
    if (el) el.textContent = (parts || []).filter(Boolean).join(' · ');
  }
  Desk.setStatus = setStatus;
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function saveLabel() {
    var S = Kit.storage;
    if (S.backend === 'local') return 'Saved in this browser';
    return S.syncConfigured() ? 'Synced with your account' : 'Saved on this device (sync is off)';
  }
  function refreshStatusRight() {
    var issues = Kit.games.current() ? Kit.integrity() : [], high = issues.filter(function (i) { return i.severity === 'high'; }).length;
    var el = document.getElementById('sb-problems');
    if (el) el.textContent = Kit.games.current() ? issues.length + ' problems' + (high ? ' (' + high + ' high)' : '') : '';
    var sv = document.getElementById('sb-save');
    if (sv) sv.textContent = Kit.games.current() ? saveLabel() + (Kit.storage.bytes ? ' · ' + fmtBytes(Kit.storage.bytes) : '') : '';
  }

  /* ---------- close (back to the editor) ---------- */
  Desk.close = function () {
    try { if (Kit.storage.pending) Kit.flush(); } catch (e) { /* ignore */ }
    try { if (window.parent && window.parent.__argDesk) { window.parent.__argDesk.close(); return; } } catch (e) { /* not embedded */ }
    Kit.toast('Open cade.txt to leave the desk.');
  };

  /* ---------- chrome ---------- */
  var SIDE = [
    { group: 'Plan', items: [
      { route: 'overview', icon: 'HOME', name: 'Overview' },
      { route: 'trail', icon: 'TRL', name: 'Trail' },
      { route: 'crafter', icon: 'CRF', name: 'Puzzle crafter' },
    ] },
    { group: 'Codex', items: ['chapter', 'event', 'puzzle', 'clue', 'character', 'place', 'entry', 'asset', 'question', 'task', 'note'].map(function (t) {
      return { route: COLLECTION_TOKENS[t], icon: Kit.TYPES[t].icon, name: Kit.TYPES[t].plural, type: t };
    }) },
    { group: 'Library', items: [
      { route: 'research', icon: 'RES', name: 'Research', type: 'research' },
      { route: 'ideas', icon: 'IDA', name: 'Ideas', type: 'idea' },
    ] },
  ];
  function countFor(it) {
    if (!it.type) return '';
    var n = Kit.list(it.type).length;
    if (it.type === 'question') { var open = Kit.list('question').filter(function (q) { return q.status === 'open'; }).length; return n ? open + '/' + n : '0'; }
    if (it.type === 'idea') { var raw = Kit.list('idea').filter(function (q) { return q.status === 'raw'; }).length; return raw ? raw + ' new' : String(n); }
    return String(n);
  }
  function buildSidebar() {
    var side = document.getElementById('desk-side');
    if (!side) return;
    if (!Kit.games.current()) { side.innerHTML = ''; return; }
    var issues = Kit.integrity(), high = issues.filter(function (i) { return i.severity === 'high'; }).length;
    var html = '<div class="side-scroll">' +
      '<div class="side-game"><b>' + Kit.esc(D.game.title || 'Untitled game') + '</b>' +
      '<span>' + D.chapters.length + ' chapters · ' + D.events.length + ' events · ' + D.puzzles.length + ' puzzles</span>' +
      '<button type="button" class="side-problems" data-go="problems"><span class="sev sev-' + (high ? 'high' : issues.length ? 'med' : 'low') + '">' + issues.length + '</span>' + (issues.length === 1 ? 'problem' : 'problems') + ' to look at</button></div>';
    SIDE.forEach(function (g) {
      html += '<div class="side-group"><span class="eyebrow">' + g.group + '</span>' + g.items.map(function (it) {
        var c = countFor(it);
        return '<a class="side-link" href="#' + it.route + '" data-route="' + it.route + '"><span class="side-ico">' + it.icon + '</span><span class="side-name">' + Kit.esc(it.name) + '</span>' +
          (c ? '<span class="side-count' + (/new/.test(c) ? ' warn' : '') + '">' + c + '</span>' : '') + '</a>';
      }).join('') + '</div>';
    });
    html += '</div><div class="side-foot">' +
      '<div class="row"><button type="button" class="btn sm" data-act="import">Import</button><button type="button" class="btn sm" data-act="export-game">Export game</button></div>' +
      '<span class="side-save' + (Kit.storage.backend === 'cade' && !Kit.storage.syncConfigured() ? ' off' : '') + '" id="side-save">' + Kit.esc(saveLabel()) + '</span>' +
      '</div>';
    side.innerHTML = html;
    markNav();
  }
  function gamePillLabel() {
    var cur = Kit.games.current();
    var g = cur && Kit.games.list().find(function (x) { return x.id === cur; });
    return cur ? (D.game.codename || (g && g.title) || D.game.title || 'Game') : 'No game';
  }
  function refreshPill() {
    var p = document.getElementById('game-pill-name');
    if (p) p.textContent = gamePillLabel();
  }
  function buildChrome() {
    var app = Kit.h('div', { class: 'app' });
    var menubar = Kit.h('header', { class: 'menubar' },
      Kit.h('button', { class: 'mb-back', type: 'button', id: 'mb-close', title: 'Back to the editor (Esc)', 'aria-label': 'Back to the editor',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>' + Kit.ICONS.logo + '<span>Cade.txt</span>',
        onclick: function () { Desk.close(); } }),
      Kit.h('button', { class: 'ws-pill tone-amber game-pill', type: 'button', id: 'game-pill', title: 'Switch game', 'aria-haspopup': 'menu',
        html: '<span class="ws-pill-dot"></span><span>ARG ·&nbsp;</span><span id="game-pill-name">' + Kit.esc(gamePillLabel()) + '</span><span class="ws-pill-caret">▾</span>',
        onclick: function (e) { openGameMenu(e.currentTarget); } }),
      Kit.h('span', { class: 'menubar-spacer' }),
      Kit.h('span', { class: 'mb-actions' },
        Kit.h('button', { class: 'mb-btn', type: 'button', id: 'mb-import', title: 'Import JSON from an LLM', html: Kit.ICONS.importIcon + '<span class="mb-label">Import</span>', onclick: function () { Desk.openImport(); } }),
        Kit.h('button', { class: 'mb-btn', type: 'button', id: 'mb-export', title: 'Export this for an LLM', html: Kit.ICONS.exportIcon + '<span class="mb-label">Export</span>', onclick: function () { Desk.openExport(); } })),
      Kit.h('button', { class: 'icon-btn', type: 'button', title: 'Jump to anything (Ctrl K)', 'aria-label': 'Jump to anything', html: Kit.ICONS.search, onclick: function () { Kit.palette.open(); } }),
      Kit.h('button', { class: 'icon-btn', type: 'button', title: 'Toggle light/dark', 'aria-label': 'Toggle theme', html: Kit.ICONS.theme, onclick: Kit.toggleTheme }));
    var desk = Kit.h('div', { class: 'desk' },
      Kit.h('nav', { class: 'desk-side', id: 'desk-side', 'aria-label': 'Sections' }),
      Kit.h('main', { class: 'desk-view', id: 'desk-view' }));
    var tabs = Kit.h('nav', { class: 'desk-tabs', 'aria-label': 'Sections' },
      [['overview', 'HOME', 'Home', 'overview'], ['trail', 'TRL', 'Trail', 'trail'], ['codex', 'CDX', 'Codex', 'codex'], ['library', 'LIB', 'Library', 'library'], ['crafter', 'CRF', 'Crafter', 'crafter']].map(function (t) {
        return Kit.h('button', { type: 'button', class: 'desk-tab', dataset: { family: t[3] }, onclick: function () {
          Desk.go(t[0] === 'codex' ? lastCodex : t[0] === 'library' ? lastLibrary : t[0]);
        }, html: '<span class="tab-ico">' + t[1] + '</span>' + t[2] });
      }));
    var status = Kit.h('footer', { class: 'statusbar' },
      Kit.h('span', { id: 'sb-left' }),
      Kit.h('span', { class: 'sb-right' },
        Kit.h('span', { class: 'sb-sample', id: 'sb-save' }),
        Kit.h('span', { id: 'sb-problems' }),
        Kit.h('span', null, 'Ctrl K to jump')));
    app.appendChild(menubar); app.appendChild(desk); app.appendChild(tabs); app.appendChild(status);
    document.body.insertBefore(app, document.body.firstChild);
    host = document.getElementById('desk-view');

    document.getElementById('desk-side').addEventListener('click', function (e) {
      var go = e.target.closest('[data-go]'); if (go) { Desk.go(go.dataset.go); return; }
      var link = e.target.closest('.side-link[data-route]'); if (link) { e.preventDefault(); Desk.go(link.dataset.route); return; }
      var act = e.target.closest('[data-act]'); if (!act) return;
      var a = act.dataset.act;
      if (a === 'import') Desk.openImport();
      else if (a === 'export-game') Desk.openExport({ kind: 'game' });
    });
  }

  /* ---------- game switcher ---------- */
  var gameMenu = null;
  function closeGameMenu() { if (gameMenu) { gameMenu.remove(); gameMenu = null; document.removeEventListener('mousedown', outsideMenu, true); } }
  function outsideMenu(e) { if (gameMenu && !gameMenu.contains(e.target) && e.target.id !== 'game-pill' && !e.target.closest('#game-pill')) closeGameMenu(); }
  function openGameMenu(anchor) {
    if (gameMenu) { closeGameMenu(); return; }
    var cur = Kit.games.current(), games = Kit.games.list();
    gameMenu = Kit.h('div', { class: 'game-menu', role: 'menu' });
    var r = anchor.getBoundingClientRect();
    gameMenu.style.top = (r.bottom + 6) + 'px';
    gameMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
    function draw(mode) {
      gameMenu.innerHTML = '';
      if (mode === 'new' || mode === 'rename') {
        var input = Kit.h('input', { class: 'input', id: 'game-name', value: mode === 'rename' ? (D.game.title || '') : '', placeholder: 'Game title', 'aria-label': 'Game title' });
        var ok = function () {
          var v = input.value.trim(); if (!v) { input.focus(); return; }
          closeGameMenu();
          if (mode === 'new') { doSwitch(function () { var gid = Kit.games.create(v); Kit.games.open(gid); Kit.create('chapter', { title: 'Chapter 1', n: 1, summary: '' }); }, 'overview'); Kit.toast('Created ' + v); }
          else { Kit.games.rename(cur, v); refreshPill(); buildSidebar(); Kit.toast('Renamed to ' + v); }
        };
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); if (e.key === 'Escape') draw('list'); });
        gameMenu.appendChild(Kit.h('div', { class: 'gm-form' },
          Kit.h('span', { class: 'eyebrow' }, mode === 'new' ? 'New game' : 'Rename game'), input,
          Kit.h('div', { class: 'row' }, Kit.h('button', { type: 'button', class: 'btn sm primary', onclick: ok }, mode === 'new' ? 'Create' : 'Rename'),
            Kit.h('button', { type: 'button', class: 'btn sm ghost', onclick: function () { draw('list'); } }, 'Cancel'))));
        setTimeout(function () { input.focus(); input.select(); }, 0);
        return;
      }
      if (mode === 'delete') {
        gameMenu.appendChild(Kit.h('div', { class: 'gm-form' },
          Kit.h('span', null, 'Delete “' + (D.game.title || 'this game') + '” from your account? Everything in it goes, on every device. Export it first if you want a copy.'),
          Kit.h('div', { class: 'row' },
            Kit.h('button', { type: 'button', class: 'btn sm danger', id: 'gm-delete-yes', onclick: function () { var t = D.game.title; closeGameMenu(); doSwitch(function () { Kit.games.remove(cur); Kit.games.resume(); }, 'overview'); Kit.toast('Deleted ' + t); } }, 'Delete game'),
            Kit.h('button', { type: 'button', class: 'btn sm ghost', onclick: function () { draw('list'); } }, 'Cancel'))));
        return;
      }
      gameMenu.appendChild(Kit.h('span', { class: 'eyebrow gm-head' }, 'Games'));
      games.forEach(function (g) {
        gameMenu.appendChild(Kit.h('button', { type: 'button', class: 'gm-item', role: 'menuitemradio', 'aria-checked': g.id === cur ? 'true' : 'false',
          onclick: function () { closeGameMenu(); if (g.id !== cur) { doSwitch(function () { Kit.games.open(g.id); }); Kit.toast('Opened ' + g.title); } } },
          Kit.h('span', { class: 'gm-check' }, g.id === cur ? '✓' : ''), Kit.h('span', { class: 'gm-name' }, g.title || 'Untitled game'),
          g.id === 'sample' ? Kit.h('span', { class: 'chip tone-amber' }, 'sample') : null));
      });
      gameMenu.appendChild(Kit.h('div', { class: 'gm-sep' }));
      gameMenu.appendChild(Kit.h('button', { type: 'button', class: 'gm-item', id: 'gm-new', onclick: function () { draw('new'); } }, Kit.h('span', { class: 'gm-check' }, '+'), 'New game…'));
      if (!games.some(function (g) { return g.id === 'sample'; }) && window.ARG_SAMPLE)
        gameMenu.appendChild(Kit.h('button', { type: 'button', class: 'gm-item', id: 'gm-sample', onclick: function () { closeGameMenu(); doSwitch(function () { Kit.games.openSample(); }, 'overview'); Kit.toast('Opened the sample game. Your own games are untouched.'); } }, Kit.h('span', { class: 'gm-check' }, ''), 'Open the sample game'));
      if (cur) {
        gameMenu.appendChild(Kit.h('button', { type: 'button', class: 'gm-item', onclick: function () { draw('rename'); } }, Kit.h('span', { class: 'gm-check' }, ''), 'Rename this game…'));
        gameMenu.appendChild(Kit.h('button', { type: 'button', class: 'gm-item gm-danger', id: 'gm-delete', onclick: function () { draw('delete'); } }, Kit.h('span', { class: 'gm-check' }, ''), cur === 'sample' ? 'Remove the sample game…' : 'Delete this game…'));
      }
    }
    draw('list');
    document.body.appendChild(gameMenu);
    document.addEventListener('mousedown', outsideMenu, true);
  }
  Desk.openGameMenu = function () { openGameMenu(document.getElementById('game-pill')); };
  function restoreRoute() {
    var t = null;
    try { t = localStorage.getItem(ROUTE_KEY()); } catch (e) { t = null; }
    token = t || 'overview'; writeUrl(token);
  }
  /* run a game switch without the 'load' event re-rendering mid-way; then route and render once */
  var switching = false;
  function doSwitch(fn, tok) {
    switching = true;
    try { fn(); } finally { switching = false; }
    stack = [];
    if (tok) { token = tok; writeUrl(token); } else restoreRoute();
    afterGameSwitch();
  }
  function afterGameSwitch() {
    unmountCurrent();
    refreshPill(); buildSidebar(); refreshStatusRight();
    document.querySelector('.app').classList.toggle('no-game', !Kit.games.current());
    render();
  }

  /* ---------- welcome (no game open) ---------- */
  function renderWelcome() {
    unmountCurrent();
    document.querySelector('.app').classList.add('no-game');
    var hasSample = !!window.ARG_SAMPLE;
    var syncing = Kit.storage.backend === 'cade' && Kit.storage.syncConfigured();
    host.innerHTML = '';
    var name = Kit.h('input', { class: 'input', id: 'welcome-title', placeholder: 'e.g. The Meridian Ledger', 'aria-label': 'Game title' });
    function create() {
      var v = name.value.trim() || 'My ARG';
      doSwitch(function () { var gid = Kit.games.create(v); Kit.games.open(gid); Kit.create('chapter', { title: 'Chapter 1', n: 1, summary: '' }); }, 'overview');
      Kit.toast('Created ' + v + ' with a first chapter');
    }
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });
    host.appendChild(Kit.h('div', { class: 'welcome scroll' },
      Kit.h('div', { class: 'welcome-card' },
        Kit.h('span', { class: 'eyebrow' }, 'ARG Desk'),
        Kit.h('h1', null, 'Plan your alternate reality game'),
        Kit.h('p', null, 'Chapters hold events, events hold puzzles. Track clues, characters, research and ideas around them, check every puzzle in the crafter, and hand any part of it to an LLM as JSON.'),
        syncing ? Kit.h('p', { class: 'welcome-sync' }, 'Games you made on another device will appear here once they sync.') : null,
        Kit.h('div', { class: 'field' }, Kit.h('label', { for: 'welcome-title' }, 'Name your game'),
          Kit.h('div', { class: 'field-row' }, name, Kit.h('button', { type: 'button', class: 'btn primary', id: 'welcome-create', onclick: create }, 'Create game'))),
        Kit.h('div', { class: 'welcome-alt' },
          hasSample ? Kit.h('button', { type: 'button', class: 'btn', id: 'welcome-sample', onclick: function () { doSwitch(function () { Kit.games.openSample(); }, 'overview'); } }, 'Explore the sample game') : null,
          Kit.h('button', { type: 'button', class: 'btn ghost', id: 'welcome-import', onclick: function () {
            doSwitch(function () { var gid = Kit.games.create('Imported game'); Kit.games.open(gid); }, 'overview'); Desk.openImport();
          } }, 'Start from a JSON backup…')))));
    setStatus([]);
    refreshPill(); buildSidebar(); refreshStatusRight();
    setTimeout(function () { if (!Desk.isPhone()) name.focus(); }, 30);
  }

  /* global: clicking any .ref navigates (views can preventDefault to handle it themselves) */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var r = e.target.closest && e.target.closest('.ref[data-ref]');
    if (!r) return;
    var id = r.getAttribute('data-ref');
    if (!Kit.has(id)) return;
    e.preventDefault();
    var sheet = r.closest('.kit-sheet-overlay'); if (sheet) sheet.querySelector('.kit-sheet-head .icon-btn').click();
    Desk.go(id);
  });
  /* Esc with nothing open goes back to the editor */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (gameMenu) { closeGameMenu(); e.preventDefault(); return; }
    if (document.querySelector('.kit-sheet-overlay, .picker-overlay:not([hidden])')) return;
    var a = document.activeElement;
    if (a && a !== document.body && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { a.blur(); return; }
    if (a && a.isContentEditable) { a.blur(); return; }
    if (Desk.embedded) Desk.close();
  });

  /* ============================================================
     EXPORT PANEL
     ============================================================ */
  var xpState = { format: 'json', solutions: true, guide: true, task: '' };
  Desk.openExport = function (scope) {
    if (!Kit.games.current()) { Kit.toast('Open or create a game first'); return; }
    if (!scope) {
      var cur = Desk.current;
      try { scope = cur && cur.inst && cur.inst.exportScope ? cur.inst.exportScope() : null; } catch (e) { scope = null; }
    }
    scope = scope || { kind: 'game' };
    var order = Kit.puzzleOrder().map(function (p) { return p.id; });
    var focusIds = scope.ids || (scope.kind === 'sequence' ? [scope.from] : []);
    var focusPuzzle = (scope.kind === 'sequence' && scope.from) || focusIds.filter(function (i) { return Kit.type(i) === 'puzzle'; })[0] || order[0];
    var seqTo = scope.kind === 'sequence' ? scope.to : (function () {
      if (!focusPuzzle) return null;
      var down = order.filter(function (id) { return Kit.sequence(focusPuzzle, id).length > 1; });
      return down.length ? down[Math.min(2, down.length - 1)] : focusPuzzle;
    })();
    var focusEvent = scope.kind === 'event' ? scope.id : (focusIds.filter(function (i) { return Kit.type(i) === 'event'; })[0] || (Kit.get(focusPuzzle) || {}).event || (D.events[0] || {}).id);
    var st = {
      kind: scope.kind,
      ids: focusIds.length ? focusIds : null,
      depth: scope.depth || 1,
      from: focusPuzzle, to: seqTo,
      chapter: (scope.kind === 'chapter' && scope.id) || (Kit.get(focusPuzzle) || {}).chapter || (D.chapters[0] || {}).id,
      event: focusEvent,
      type: scope.type || (focusIds[0] ? Kit.type(focusIds[0]) : 'puzzle'),
    };
    if ((st.kind === 'entity' || st.kind === 'linked') && !st.ids) st.kind = 'game';

    var wrap = Kit.h('div', { class: 'xp' });
    var preview = Kit.h('pre', { class: 'codebox', id: 'xp-preview', tabindex: '0' });
    var sum = Kit.h('div', { class: 'xp-sum' });
    function opt(kind, title, desc, ctl) {
      var on = st.kind === kind;
      return Kit.h('label', { class: 'xp-scope' + (on ? ' on' : '') },
        Kit.h('input', { type: 'radio', name: 'xp-scope', value: kind, checked: on, onchange: function () { st.kind = kind; draw(); } }),
        Kit.h('span', { class: 'xp-t' }, title),
        desc ? Kit.h('span', { class: 'xp-d' }, desc) : null,
        ctl ? Kit.h('span', { class: 'xp-ctl' }, ctl) : null);
    }
    function sel(id, value, options, onchange) {
      return Kit.h('select', { class: 'input', id: id, onchange: function (e) { onchange(e.target.value); } },
        options.map(function (o) { return Kit.h('option', { value: o[0], selected: o[0] === value }, o[1]); }));
    }
    function draw() {
      wrap.innerHTML = '';
      var scopes = Kit.h('div', { class: 'xp-scopes' });
      if (st.ids && st.ids.length) {
        var name = st.ids.length === 1 ? st.ids[0] + ' · ' + Kit.label(st.ids[0]) : st.ids.length + ' selected items';
        scopes.appendChild(opt('entity', 'Just this: ' + name, 'Only the item' + (st.ids.length > 1 ? 's' : '') + ' itself.'));
        scopes.appendChild(opt('linked', 'This and everything linked', 'Adds every page it points at or that points at it.',
          sel('xp-depth', String(st.depth), [['1', 'One step out'], ['2', 'Two steps out']], function (v) { st.depth = +v; st.kind = 'linked'; draw(); })));
      }
      if (order.length) scopes.appendChild(opt('sequence', 'A sequence of puzzles', 'Every puzzle on the trail between two puzzles, with their clues.',
        [sel('xp-from', st.from, order.map(function (id) { return [id, id + ' · ' + Kit.label(id)]; }), function (v) { st.from = v; st.kind = 'sequence'; draw(); }),
         Kit.h('span', { class: 'faint' }, 'to'),
         sel('xp-to', st.to, order.map(function (id) { return [id, id + ' · ' + Kit.label(id)]; }), function (v) { st.to = v; st.kind = 'sequence'; draw(); })]));
      if (D.events.length) scopes.appendChild(opt('event', 'An event', 'The event, its puzzles and their clues.',
        sel('xp-event', st.event, D.events.map(function (x) { var c = Kit.chapter(x.chapter); return [x.id, (c ? 'Ch ' + c.n + ' · ' : '') + x.title]; }), function (v) { st.event = v; st.kind = 'event'; draw(); })));
      if (D.chapters.length) scopes.appendChild(opt('chapter', 'A chapter', 'The chapter, its events, its puzzles and their clues.',
        sel('xp-chapter', st.chapter, Kit.chapters().map(function (c) { return [c.id, c.n + ' · ' + c.title]; }), function (v) { st.chapter = v; st.kind = 'chapter'; draw(); })));
      scopes.appendChild(opt('collection', 'A whole collection', null,
        sel('xp-type', st.type, Object.keys(Kit.TYPES).map(function (t) { return [t, Kit.TYPES[t].plural]; }), function (v) { st.type = v; st.kind = 'collection'; draw(); })));
      scopes.appendChild(opt('game', 'The whole game', 'Everything. Also works as a backup you can import later.'));

      var opts = Kit.h('div', { class: 'xp-opts' },
        Kit.h('div', { class: 'field' }, Kit.h('label', { for: 'xp-task' }, 'Ask the LLM to'),
          sel('xp-task', xpState.task, Kit.LLM_TASKS.map(function (t) { return [t.id, t.label]; }), function (v) { xpState.task = v; draw(); })),
        Kit.h('label', { class: 'check-row' }, Kit.h('input', { type: 'checkbox', id: 'xp-sol', checked: xpState.solutions, onchange: function (e) { xpState.solutions = e.target.checked; draw(); } }), 'Include solutions, solve paths, recipes and secrets'),
        Kit.h('label', { class: 'check-row' }, Kit.h('input', { type: 'checkbox', id: 'xp-guide', checked: xpState.guide, onchange: function (e) { xpState.guide = e.target.checked; draw(); } }), 'Include instructions and a field guide for the LLM'));

      var fmt = Kit.h('div', { class: 'seg', role: 'group', 'aria-label': 'Format' },
        [['json', 'JSON'], ['md', 'Markdown']].map(function (f) {
          return Kit.h('button', { type: 'button', 'aria-pressed': xpState.format === f[0] ? 'true' : 'false', onclick: function () { xpState.format = f[0]; draw(); } }, f[1]);
        }));
      var scopeObj = currentScope();
      var bundle = Kit.exportBundle(scopeObj, { solutions: xpState.solutions, guide: xpState.guide, task: xpState.task });
      var text = xpState.format === 'json' ? Kit.bundleToJSON(bundle) : Kit.bundleToMarkdown(bundle);
      preview.textContent = text;
      sum.innerHTML = '';
      sum.appendChild(fmt);
      sum.appendChild(Kit.h('span', { class: 'mono' }, bundle.entities.length + ' items · ~' + Kit.estimateTokens(text).toLocaleString() + ' tokens'));
      wrap.appendChild(Kit.h('div', { class: 'field' }, Kit.h('span', { class: 'field-label' }, 'What to export'), scopes));
      wrap.appendChild(opts);
      wrap.appendChild(sum);
      wrap.appendChild(preview);
      Desk.lastExport = { scope: scopeObj, text: text, bundle: bundle };
    }
    function currentScope() {
      switch (st.kind) {
        case 'entity': return { kind: 'entity', ids: st.ids };
        case 'linked': return { kind: 'linked', ids: st.ids, depth: st.depth };
        case 'sequence': return { kind: 'sequence', from: st.from, to: st.to };
        case 'event': return { kind: 'event', id: st.event };
        case 'chapter': return { kind: 'chapter', id: st.chapter };
        case 'collection': return { kind: 'collection', type: st.type };
        default: return { kind: 'game' };
      }
    }
    var copyBtn = Kit.h('button', { type: 'button', class: 'btn primary', id: 'xp-copy', html: Kit.ICONS.copy + 'Copy', onclick: function () { Kit.copy(preview.textContent, preview); } });
    var foot = Kit.h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', width: '100%' } },
      copyBtn,
      Kit.h('span', { class: 'faint', style: { fontSize: 'var(--text-xs)' } }, 'Paste it into any LLM. Bring its reply back with Import.'));
    draw();
    Kit.sheet({ title: 'Export for an LLM', width: 580, body: wrap, footer: foot, id: 'export-sheet', noFocus: true });
  };

  /* ============================================================
     IMPORT PANEL — JSON (from an LLM or a backup), or a cade.txt room as a note
     ============================================================ */
  function hostRooms() {
    try {
      var api = window.parent && window.parent !== window && window.parent.Cade && window.parent.Cade.roomsApi;
      if (api && typeof window.parent.loadRoomTextAnywhere === 'function') return { api: api, read: window.parent.loadRoomTextAnywhere };
    } catch (e) { /* not embedded */ }
    return null;
  }
  Desk.openImport = function (prefill) {
    if (!Kit.games.current()) { Kit.toast('Open or create a game first'); return; }
    var rooms = hostRooms();
    var mode = 'json';
    var wrap = Kit.h('div', { class: 'im' });
    var applyBtn = Kit.h('button', { type: 'button', class: 'btn primary', id: 'im-apply', disabled: true }, 'Apply changes');
    var sheet = Kit.sheet({ title: 'Import', width: 580, body: wrap, footer: applyBtn, id: 'import-sheet' });
    function drawMode() {
      wrap.innerHTML = '';
      if (rooms) {
        wrap.appendChild(Kit.h('div', { class: 'seg im-mode', role: 'group', 'aria-label': 'Import from' },
          [['json', 'JSON from an LLM or a backup'], ['room', 'A cade.txt room']].map(function (m) {
            return Kit.h('button', { type: 'button', id: 'im-mode-' + m[0], 'aria-pressed': mode === m[0] ? 'true' : 'false', onclick: function () { mode = m[0]; drawMode(); } }, m[1]);
          })));
      }
      if (mode === 'room') drawRoom(); else drawJson();
    }
    /* ---- a room becomes a note (your existing long notes) ---- */
    function drawRoom() {
      var names = rooms.api.list().filter(function (n) { return !/^__/.test(n); });
      var ordered = rooms.api.orderRooms ? rooms.api.orderRooms(names) : names;
      var chosen = null;
      var search = Kit.h('input', { class: 'input', id: 'im-room-q', placeholder: 'Find a room…', 'aria-label': 'Find a room' });
      var list = Kit.h('div', { class: 'im-rooms' });
      var previewEl = Kit.h('pre', { class: 'codebox im-room-preview', hidden: true });
      function drawList() {
        var q = search.value.trim().toLowerCase();
        list.innerHTML = '';
        ordered.filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0; }).slice(0, 80).forEach(function (n) {
          list.appendChild(Kit.h('button', { type: 'button', class: 'im-room' + (n === chosen ? ' on' : ''), onclick: function () {
            chosen = n; drawList(); previewEl.hidden = false; previewEl.textContent = 'Loading…';
            Promise.resolve(rooms.read(n)).then(function (t) {
              if (chosen !== n) return;
              previewEl.textContent = t ? (t.length > 1800 ? t.slice(0, 1800) + '\n…' : t) : '(empty room, or not available offline)';
              applyBtn.disabled = !t; applyBtn.textContent = t ? 'Import “' + n + '” as a note' : 'Nothing to import';
              applyBtn.onclick = function () {
                var id = Kit.create('note', { title: n, body: t });
                sheet.close();
                Kit.toast('Imported room “' + n + '” as ' + id + '. The room itself is unchanged.');
                Desk.go(id);
              };
            });
          } }, Kit.h('span', null, n)));
        });
        if (!list.children.length) list.appendChild(Kit.h('div', { class: 'faint' }, 'No rooms match.'));
      }
      search.addEventListener('input', drawList);
      wrap.appendChild(Kit.h('p', { class: 'im-help', html: 'Copy the text of one of your cade.txt rooms into a <b>note</b>, where <b>#P04</b>, <b>@Name</b> and <b>[[Name]]</b> link to the game. The room stays as it is.' }));
      wrap.appendChild(search); wrap.appendChild(list); wrap.appendChild(previewEl);
      applyBtn.disabled = true; applyBtn.textContent = 'Choose a room';
      drawList();
    }
    /* ---- JSON ---- */
    function drawJson() {
      var ta = Kit.h('textarea', { class: 'codebox', id: 'im-text', spellcheck: 'false', placeholder: 'Paste the JSON an LLM gave you, or an export from this desk…' });
      if (prefill) ta.value = prefill;
      var file = Kit.h('input', { type: 'file', id: 'im-file', accept: '.json,.txt,.md,application/json,text/plain', hidden: true, onchange: function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        var r = new FileReader();
        r.onload = function () { ta.value = String(r.result || ''); preview(); };
        r.readAsText(f);
      } });
      var out = Kit.h('div', { class: 'im-out' });
      var items = [], gameMeta = null, gameCb = null;
      applyBtn.disabled = true; applyBtn.textContent = 'Apply changes'; applyBtn.onclick = apply;
      wrap.appendChild(Kit.h('p', { class: 'im-help', html: 'Paste JSON in the export format. Nothing changes until you review the list below and press <b>Apply</b>. New items get the next free ids, and you can undo the whole import afterwards.' }));
      wrap.appendChild(ta);
      wrap.appendChild(Kit.h('div', { class: 'im-tools' },
        Kit.h('button', { type: 'button', class: 'btn', id: 'im-preview', onclick: preview }, 'Preview changes'),
        Kit.h('button', { type: 'button', class: 'btn ghost', onclick: function () { file.click(); } }, 'Open a file…'),
        Kit.games.current() === 'sample' ? Kit.h('button', { type: 'button', class: 'btn ghost', id: 'im-example', onclick: function () { ta.value = Kit.sampleLLMReply(); preview(); } }, 'Try an example reply') : null,
        file));
      wrap.appendChild(out);
      function trunc(v) {
        if (v === undefined || v === null || (Array.isArray(v) && !v.length) || v === '') return '—';
        var s;
        if (Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; })) {
          s = v.every(function (x) { return Kit.has(x) || /^NEW-/.test(x); }) ? v.join(', ') : v.map(function (x, i) { return (i + 1) + '. ' + x; }).join('\n');
        } else s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 420 ? s.slice(0, 418) + '…' : s;
      }
      function preview() {
        out.innerHTML = '';
        var parsed = Kit.importParse(ta.value);
        if (parsed.errors.length) { out.appendChild(Kit.h('div', { class: 'im-errors' }, parsed.errors.join(' '))); items = []; syncApply(); return; }
        items = Kit.importDiff(parsed.entities);
        items.forEach(function (it) { it.on = it.op === 'create' || it.op === 'update'; });
        gameMeta = parsed.game; gameCb = null;
        var n = { create: 0, update: 0, same: 0, error: 0 }, warns = 0;
        items.forEach(function (it) { n[it.op]++; warns += it.warnings.length; });
        out.appendChild(Kit.h('div', { class: 'im-sum', html:
          (n.create ? '<span class="chip tone-green">' + n.create + ' new</span>' : '') +
          (n.update ? '<span class="chip tone-blue">' + n.update + ' changed</span>' : '') +
          (n.same ? '<span class="chip">' + n.same + ' unchanged</span>' : '') +
          (n.error ? '<span class="chip tone-orange">' + n.error + ' can\'t import</span>' : '') +
          (warns ? '<span class="chip tone-amber">' + warns + ' warning' + (warns === 1 ? '' : 's') + '</span>' : '') }));
        if (gameMeta && (gameMeta.title || gameMeta.premise) && (gameMeta.title !== D.game.title || gameMeta.premise !== D.game.premise)) {
          /* a game that holds nothing but chapters is still a fresh one */
          var fresh = Kit.count() === Kit.list('chapter').length;
          gameCb = Kit.h('input', { type: 'checkbox', id: 'im-game', checked: fresh || D.game.title === 'Imported game' });
          out.appendChild(Kit.h('label', { class: 'check-row im-game' }, gameCb, 'Also set the game title and premise to “' + (gameMeta.title || D.game.title) + '”'));
        }
        var list = Kit.h('div', { class: 'im-items' });
        items.forEach(function (it, i) {
          var tone = { create: 'tone-green', update: 'tone-blue', same: 'tone-neutral', error: 'tone-orange' }[it.op];
          var opLabel = { create: 'NEW', update: 'EDIT', same: 'SAME', error: 'SKIP' }[it.op];
          var idTxt = it.op === 'create' ? (it.id && it.id !== it.newId ? it.id + ' → ' + it.newId : it.newId) : (it.newId || it.id || '?');
          var body = Kit.h('div', { class: 'im-body', hidden: items.length > 4 && it.op !== 'error' });
          it.changes.forEach(function (c) {
            body.appendChild(Kit.h('div', { class: 'im-change' },
              Kit.h('span', { class: 'f' }, c.field),
              Kit.h('span', { class: 'v' },
                it.op === 'update' ? Kit.h('span', { class: 'from' }, trunc(c.from)) : null,
                Kit.h('span', { class: 'to' }, trunc(c.to)))));
          });
          it.warnings.forEach(function (w) { body.appendChild(Kit.h('div', { class: 'im-warn' }, w)); });
          if (!it.changes.length && !it.warnings.length) body.appendChild(Kit.h('div', { class: 'faint', style: { fontSize: 'var(--text-xs)' } }, 'Nothing to change.'));
          var cb = Kit.h('input', { type: 'checkbox', checked: it.on, disabled: it.op === 'error' || it.op === 'same', 'aria-label': 'Include ' + idTxt, onchange: function (e) { it.on = e.target.checked; card.classList.toggle('off', !it.on); syncApply(); } });
          var tog = Kit.h('button', { type: 'button', class: 'im-toggle', onclick: function () { body.hidden = !body.hidden; tog.textContent = body.hidden ? 'Details' : 'Hide'; } }, body.hidden ? 'Details' : 'Hide');
          var card = Kit.h('div', { class: 'im-item' + (it.on ? '' : ' off'), id: 'im-item-' + i },
            Kit.h('div', { class: 'im-item-head' }, cb,
              Kit.h('span', { class: 'im-op ' + tone }, opLabel),
              Kit.h('span', { class: 'im-label', html: '<span class="id">' + Kit.esc(idTxt) + '</span>' + Kit.esc((Kit.TYPES[it.type] || { label: it.type || '?' }).label + ' · ' + it.label) }),
              tog),
            body);
          list.appendChild(card);
        });
        out.appendChild(list);
        syncApply();
      }
      function syncApply() {
        var k = items.filter(function (it) { return it.on; }).length;
        applyBtn.disabled = !k;
        applyBtn.textContent = k ? 'Apply ' + k + ' change' + (k === 1 ? '' : 's') : 'Apply changes';
      }
      function apply() {
        var chosen = items.filter(function (it) { return it.on; });
        if (!chosen.length) return;
        var res = Kit.importApply(chosen);
        if (gameCb && gameCb.checked && gameMeta) {
          var g = {}; ['title', 'codename', 'tagline', 'premise', 'format', 'players'].forEach(function (k) { if (gameMeta[k]) g[k] = gameMeta[k]; });
          Kit.updateGame(g);
        }
        sheet.close();
        var msg = 'Imported ' + [res.created.length ? res.created.length + ' new' : '', res.updated.length ? res.updated.length + ' changed' : ''].filter(Boolean).join(' and ') + (res.created.length + res.updated.length === 1 ? ' item' : ' items');
        Kit.toast(msg, { label: 'Undo', run: function () { Kit.restore(res.undo); Kit.toast('Import undone'); } });
        var first = res.created[0] || res.updated[0];
        if (first && res.created.length + res.updated.length < 20) Desk.go(first); else Desk.go('overview');
      }
      if (prefill) preview();
    }
    drawMode();
  };

  /* ---------- start ---------- */
  Desk.start = function () {
    ctx = { go: Desk.go, back: Desk.back, setStatus: setStatus, openExport: Desk.openExport, openImport: Desk.openImport, isPhone: Desk.isPhone };
    buildChrome();
    Kit.palette.onPick = function (id) { Desk.go(id); };
    Kit.hoverCards(document.body);
    var rebuildT;
    Kit.on('change', function (ev) {
      clearTimeout(rebuildT);
      rebuildT = setTimeout(function () { refreshPill(); buildSidebar(); refreshStatusRight(); }, 60);
      if (ev && ev.kind === 'load' && !switching && Desk.started) { stack = []; restoreRoute(); afterGameSwitch(); }
    });
    Kit.on('games', function () { refreshPill(); if (!switching && !Kit.games.current() && Kit.games.list().length) doSwitch(function () { Kit.games.resume(); }); });
    Kit.on('saved', refreshStatusRight);
    Kit.on('storage-error', function () { Kit.toast('Couldn\'t save: this browser\'s storage is full. Export your game to keep a copy.'); });
    var initial = decodeURIComponent(location.hash.slice(1) || '');
    Desk.started = true;
    doSwitch(function () { Kit.games.resume(); }, initial || null);
  };

  window.Desk = Desk;
})();
