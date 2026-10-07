/* ============================================================
   ARG Desk — Overview (the planning home screen)
   Game header · get started (new games) · readiness by chapter →
   events · work on next · pipeline kanban · decisions · problems ·
   library at a glance · assets and renewals · history vs. trail order.
   All edits go through Kit.update / Kit.create / Kit.updateGame; the
   view re-renders on Kit.on('change') (local and remote) without
   losing the field the user is typing in.
   ============================================================ */
(function () {
  'use strict';
  var D = window.ARG;
  var esc = Kit.esc, ref = Kit.refHtml;

  /* ---------------- constants ---------------- */
  var SEV = { high: 0, med: 1, low: 2 };
  var PZ_SCORE = { idea: 0, draft: 0.25, built: 0.5, tested: 0.75, ready: 1 };
  var AS_STATUSES = [['idea', 'Idea'], ['making', 'Making'], ['ready', 'Ready'], ['placed', 'Placed']];
  var AS_SCORE = { idea: 0, making: 0.5, ready: 1, placed: 1 };
  var LAYERS = ['record', 'pseudo', 'fiction'];
  var LAYER_VAR = { record: '--ws-teal-fg', pseudo: '--ws-purple-fg', fiction: '--ws-pink-fg' };
  var PZ_OPACITY = { idea: 0, draft: 0.22, built: 0.5, tested: 0.78, ready: 1 };
  var DEFAULT_TITLES = ['', 'untitled game', 'my arg', 'imported game'];
  var PREF_KEY = 'argdesk-overview-prefs';
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  var CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3 5 8.6l4.5-5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------------- small helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function plural(n, s, p) { return n + ' ' + (n === 1 ? s : (p || s + 's')); }
  function chip(text, tone, cls) { return '<span class="chip' + (tone ? ' tone-' + tone : '') + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
  function refs(ids, opts) { return (ids || []).filter(function (id) { return Kit.has(id); }).map(function (id) { return ref(id, opts); }).join(''); }
  function statusLabel(s) { return Kit.statusLabel(s); }
  function kindLabel(k) { var o = (D.puzzleKinds || []).find(function (x) { return x.id === k; }); return o ? o.label : (k || '—'); }
  function chName(cid) { var c = Kit.chapter(cid); return c ? 'Ch ' + c.n : 'No chapter'; }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function sevCounts(list) { var c = { high: 0, med: 0, low: 0 }; list.forEach(function (s) { if (c[s] != null) c[s]++; }); return c; }
  function noSolution(p) { return !p.solution || /^tbd\.?$/i.test(String(p.solution).trim()); }
  function reduceMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function smooth() { return reduceMotion() ? 'auto' : 'smooth'; }
  /* readiness: puzzles count double, by design stage; assets by making stage. null when there is nothing to measure */
  function readiness(puzzles, assets) {
    var s = 0, w = 0;
    puzzles.forEach(function (p) { s += 2 * (PZ_SCORE[p.status] || 0); w += 2; });
    assets.forEach(function (a) { s += AS_SCORE[a.status] || 0; w += 1; });
    return w ? s / w : null;
  }
  function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function pctNum(x) { return x == null ? 0 : Math.round(x * 100); }
  function textW(str, font) {
    var c = textW.c || (textW.c = document.createElement('canvas').getContext('2d'));
    c.font = font; return c.measureText(str).width;
  }
  /* a short label for a title: the part before ":" / " (" / " — ", then cut at a word boundary */
  function shortTitle(t, max) {
    max = max || 22;
    var s = String(t || '').split(/:\s|\s\(|\s—\s|\s–\s/)[0].trim() || String(t || '');
    if (s.length <= max) return s;
    var cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;.\s]+$/, '') + '…';
  }
  function isUrl(s) { return /^https?:\/\/\S+$/i.test(String(s || '').trim()); }
  function placeLabels(items, maxRows, X0, X1, gap) {
    var ends = [];
    items.forEach(function (o) {
      var s = o.x - 3, en = s + o.w; o.anchor = 'start';
      if (o.center) { s = o.x - o.w / 2; en = o.x + o.w / 2; o.anchor = 'middle'; }
      if (en > X1) { en = X1; s = en - o.w; o.anchor = o.center ? 'middle' : 'end'; }
      if (s < X0) { s = X0; en = s + o.w; o.anchor = o.center ? 'middle' : 'start'; }
      var row = -1;
      for (var r = 0; r < maxRows; r++) { if (ends[r] == null || ends[r] + (gap || 10) <= s) { row = r; break; } }
      if (row < 0) { var mi = 0; ends.forEach(function (v, i) { if (v < ends[mi]) mi = i; }); row = mi; }
      ends[row] = en; o.row = row; o.s = s; o.en = en;
      o.tx = o.anchor === 'end' ? en : o.anchor === 'middle' ? (s + en) / 2 : s;
    });
    return Math.max(1, ends.length);
  }
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function savePrefs(p) {
    try {
      /* tiny and bounded: collapsed chapter ids + dismissed checklists, per game */
      Object.keys(p).forEach(function (k) { if (Array.isArray(p[k]) && p[k].length > 40) p[k] = p[k].slice(-40); });
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch (e) { /* storage unavailable: prefs live in memory */ }
  }

  /* where you go to fix a problem */
  function fixTarget(kind, ids) {
    var first = ids[0], pid = ids.filter(function (x) { return Kit.type(x) === 'puzzle'; })[0];
    switch (kind) {
      case 'Recipe': case 'No solution': case 'No solve path': case 'Design checks':
        return pid ? { go: 'crafter.' + pid, where: 'Crafter · ' + pid } : { go: first, where: first };
      case 'Broken link': case 'Order': case 'Dead end': case 'Variety':
        return pid ? { go: 'trail.' + pid, where: 'Trail · ' + pid } : { go: 'trail', where: 'Trail' };
      default:
        return { go: first, where: first ? (Kit.typeName(first) + ' · ' + first) : '' };
    }
  }

  Desk.registerView({
    id: 'overview', title: 'Overview',
    routes: function (t) { return t === 'overview' ? {} : null; },
    mount: function (root, params, ctx) {
      /* ---------------- state ---------------- */
      var gid = Kit.games.current() || 'none';
      var prefs = loadPrefs();
      var S = {
        chapter: 'all', prob: 'all', showAllNext: false,
        resolving: null, draft: '', showResolved: false,
        touchedTasks: new Set(), touchedAssets: new Set(),
        tlHover: null, tlSticky: null, flash: null, menu: null, refocus: null,
        collapsed: new Set((prefs.collapsed || []).filter(function (k) { return k.indexOf(gid + ':') === 0; }).map(function (k) { return k.slice(gid.length + 1); })),
        gsHidden: (prefs.gsHidden || []).indexOf(gid) >= 0,
      };
      var dead = false;
      var offs = [];
      function listen(target, type, fn, opts) { target.addEventListener(type, fn, opts); offs.push(function () { target.removeEventListener(type, fn, opts); }); }
      var cache = null;
      function issues() { if (!cache) cache = Kit.integrity(); return cache; }
      function isFresh() { return !Kit.list('event').length && !Kit.list('puzzle').length; }
      function persistCollapsed() {
        var p = loadPrefs();
        p.collapsed = (p.collapsed || []).filter(function (k) { return k.indexOf(gid + ':') !== 0; }).concat(Array.from(S.collapsed).map(function (c) { return gid + ':' + c; }));
        savePrefs(p);
      }
      function persistGs() {
        var p = loadPrefs();
        p.gsHidden = (p.gsHidden || []).filter(function (g) { return g !== gid; });
        if (S.gsHidden) p.gsHidden.push(gid);
        savePrefs(p);
      }

      /* ---------------- skeleton ---------------- */
      root.innerHTML =
        '<div class="ov-scroll" id="ov-scroll"><div class="ov-grid">' +
        /* 1. header */
        '<section class="ov-panel ov-s12 ov-head" id="ov-head" aria-label="The game">' +
          '<div class="ov-game">' +
            '<div class="ov-game-top"><span class="eyebrow">The game</span><span class="ov-hint">Click any line to edit it</span></div>' +
            '<textarea class="ov-in ov-grow ov-title" data-g="title" data-line="1" rows="1" aria-label="Game title" placeholder="Name your game" spellcheck="false"></textarea>' +
            '<textarea class="ov-in ov-grow ov-tagline" data-g="tagline" data-line="1" rows="1" aria-label="Tagline" placeholder="A one-line hook (optional)"></textarea>' +
            '<textarea class="ov-in ov-grow ov-premise" data-g="premise" rows="3" aria-label="Premise" placeholder="The premise: what happened, who players are, what they are uncovering. Players never see this; it keeps you and any LLM on the same page."></textarea>' +
            '<div class="ov-meta">' +
              '<label class="ov-meta-l" for="ov-g-format">Format</label><textarea class="ov-in ov-grow ov-meta-in" id="ov-g-format" data-g="format" data-line="1" rows="1"></textarea>' +
              '<label class="ov-meta-l" for="ov-g-players">Players</label><textarea class="ov-in ov-grow ov-meta-in" id="ov-g-players" data-g="players" data-line="1" rows="1" placeholder="Who plays (e.g. 5–8 friends)"></textarea>' +
            '</div>' +
          '</div>' +
          '<div class="ov-overall" id="ov-overall"></div>' +
        '</section>' +
        /* get started (new and nearly-new games) */
        '<section class="ov-panel ov-s12" id="ov-gs" aria-labelledby="ov-h-gs" hidden></section>' +
        /* 2. readiness by chapter → events */
        '<section class="ov-panel ov-s7" id="ov-ready" aria-labelledby="ov-h-ready">' +
          '<header class="ov-ph"><h2 id="ov-h-ready">Readiness by chapter</h2><span class="ov-sp"></span><span class="ov-key" id="ov-ready-key"></span></header>' +
          '<div class="ov-pb" id="ov-ready-b"></div>' +
        '</section>' +
        /* 3. work on next */
        '<section class="ov-panel ov-s5" id="ov-next" aria-labelledby="ov-h-next">' +
          '<header class="ov-ph"><h2 id="ov-h-next">Work on next <span class="ov-count" id="ov-next-n"></span></h2><span class="ov-sp"></span><span class="ov-note">Worst first. Each one opens where you fix it.</span></header>' +
          '<div class="ov-pb" id="ov-next-b"></div>' +
        '</section>' +
        /* 4. pipeline */
        '<section class="ov-panel ov-s12" id="ov-pipe" aria-labelledby="ov-h-pipe">' +
          '<header class="ov-ph"><h2 id="ov-h-pipe">Puzzle pipeline <span class="ov-count" id="ov-pipe-n"></span></h2>' +
          '<div class="seg" id="ov-ch-seg" role="group" aria-label="Filter by chapter"></div><span class="ov-sp"></span>' +
          '<span class="ov-note">Card stripe = reality-layer mix ' + LAYERS.map(function (l) { return Kit.layerBadge(l, { short: true }); }).join('') + '</span></header>' +
          '<div class="ov-kb" id="ov-kb"></div>' +
        '</section>' +
        /* 6. decisions */
        '<section class="ov-panel ov-s8" id="ov-dec" aria-labelledby="ov-h-dec">' +
          '<header class="ov-ph"><h2 id="ov-h-dec">Decisions <span class="ov-count" id="ov-dec-n"></span></h2><span class="ov-sp"></span><span class="ov-note">Open questions, worst first, and your to-do list</span></header>' +
          '<div class="ov-dec">' +
            '<div class="ov-pb ov-dec-q"><div class="ov-sub">Open questions</div><div id="ov-qs"></div></div>' +
            '<div class="ov-pb ov-dec-t"><div class="ov-sub">Tasks</div><div id="ov-tasks"></div>' +
              '<form class="ov-add" id="ov-addtask" autocomplete="off"><input class="input" id="ov-newtask" placeholder="Add a task…" aria-label="New task"><button type="submit" class="btn sm">Add task</button></form>' +
            '</div>' +
          '</div>' +
        '</section>' +
        /* 5. problems */
        '<section class="ov-panel ov-s4" id="ov-probs" aria-labelledby="ov-h-probs">' +
          '<header class="ov-ph"><h2 id="ov-h-probs">Problems <span class="ov-count" id="ov-prob-n"></span></h2><span class="ov-sp"></span><div class="seg" id="ov-prob-seg" role="group" aria-label="Filter by severity"></div></header>' +
          '<div class="ov-plw" id="ov-plw"><ul class="ov-pl" id="ov-probs-b"></ul></div>' +
        '</section>' +
        /* 7. library */
        '<section class="ov-panel ov-s4" id="ov-lib" aria-labelledby="ov-h-lib">' +
          '<header class="ov-ph"><h2 id="ov-h-lib">Library</h2><span class="ov-sp"></span><button type="button" class="btn ghost sm" data-go="ideas">Ideas</button><button type="button" class="btn ghost sm" data-go="research">Research</button></header>' +
          '<div class="ov-pb">' +
            '<form class="ov-add ov-capture" id="ov-capture" autocomplete="off"><input class="input" id="ov-cap" placeholder="Capture an idea… #tags, #P04 links, URLs" aria-label="Capture an idea"><button type="submit" class="btn sm primary">Save idea</button></form>' +
            '<div id="ov-lib-b"></div>' +
          '</div>' +
        '</section>' +
        /* 9. assets */
        '<section class="ov-panel ov-s8" id="ov-assets" aria-labelledby="ov-h-assets">' +
          '<header class="ov-ph"><h2 id="ov-h-assets">Assets <span class="ov-count" id="ov-as-n"></span></h2><span class="ov-sp"></span><button type="button" class="btn ghost sm" data-go="assets">All assets</button></header>' +
          '<div class="ov-as" id="ov-as">' +
            '<div class="ov-pb"><div class="ov-sub">Still to make</div><div id="ov-make"></div></div>' +
            '<div class="ov-pb ov-as-ren"><div class="ov-sub">Renewals <span class="ov-sub-note">must stay alive while the game is out</span></div><div id="ov-renew"></div></div>' +
          '</div>' +
        '</section>' +
        /* 8. history vs trail order */
        '<section class="ov-panel ov-s12" id="ov-hist" aria-labelledby="ov-h-hist">' +
          '<header class="ov-ph"><h2 id="ov-h-hist">History vs. trail order</h2><span class="ov-sp"></span>' +
          '<span class="ov-note">' + LAYERS.map(function (l) { return Kit.layerBadge(l); }).join('') + '</span></header>' +
          '<div class="ov-tl" id="ov-tl"></div><div class="ov-tl-cap" id="ov-tl-cap" aria-live="polite"></div>' +
        '</section>' +
        '</div></div>';

      var SCROLL = $('#ov-scroll', root), KB = $('#ov-kb', root), TLW = $('#ov-tl', root);

      /* ================= 1. game header ================= */
      function fillGame(force) {
        $$('[data-g]', root).forEach(function (el) {
          if (!force && el === document.activeElement) return;
          var v = D.game[el.dataset.g] || '';
          if (el.dataset.g === 'title' && DEFAULT_TITLES.indexOf(v.trim().toLowerCase()) >= 0 && v.trim().toLowerCase() === 'untitled game') v = '';
          if (el.value !== v) el.value = v;
        });
        growAll();
      }
      function growAll() { $$('.ov-grow', root).forEach(grow); }
      function grow(t) { if (!t.offsetParent) return; t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
      function commitGame(el) {
        var k = el.dataset.g, v = el.value.trim();
        if (k === 'title' && !v) { el.value = D.game.title === 'Untitled game' ? '' : (D.game.title || ''); return; }
        if ((D.game[k] || '') === v) return;
        var prev = D.game[k] || '', patch = {}; patch[k] = v;
        Kit.updateGame(patch);
        Kit.toast('Saved the ' + k, { label: 'Undo', run: function () { var p2 = {}; p2[k] = prev; Kit.updateGame(p2); fillGame(true); Kit.toast('Put the old ' + k + ' back'); } });
      }

      function renderOverall() {
        var ps = Kit.list('puzzle'), as = Kit.list('asset');
        var box = $('#ov-overall', root);
        var exportBtn = '<button type="button" class="btn sm" data-act="export-game">' + Kit.ICONS.exportIcon + 'Export whole game for an LLM</button>';
        if (!ps.length && !as.length) {
          box.innerHTML = '<div class="ov-ov-top"><div><span class="eyebrow">Overall readiness</span>' +
            '<p class="ov-ov-empty">Nothing to measure yet. Readiness appears once the game has puzzles or assets.</p></div></div>' +
            '<div class="ov-ov-acts">' + exportBtn + '</div>';
          return;
        }
        var r = readiness(ps, as);
        var pc = {}; D.statuses.forEach(function (s) { pc[s.id] = 0; }); ps.forEach(function (p) { pc[p.status] = (pc[p.status] || 0) + 1; });
        var ac = {}; AS_STATUSES.forEach(function (s) { ac[s[0]] = 0; }); as.forEach(function (a) { ac[a.status] = (ac[a.status] || 0) + 1; });
        var dist = function (counts, list, cls, total) {
          if (!total) return '<span class="ov-dist-none">none yet</span>';
          return '<span class="ov-dist" aria-hidden="true">' + list.filter(function (s) { return counts[s[0]]; }).map(function (s) { return '<i class="' + cls + '-' + s[0] + '" style="flex:' + counts[s[0]] + '"></i>'; }).join('') + '</span>' +
            '<span class="ov-dist-k">' + list.map(function (s) { return '<span class="' + (counts[s[0]] ? '' : 'z') + '"><i class="' + cls + '-' + s[0] + '"></i>' + counts[s[0]] + ' ' + s[1].toLowerCase() + '</span>'; }).join('') + '</span>';
        };
        var pList = D.statuses.map(function (s) { return [s.id, s.label]; });
        var pDone = ps.filter(function (p) { return Kit.statusIndex(p.status) >= 2; }).length;
        var aDone = as.filter(function (a) { return a.status === 'ready' || a.status === 'placed'; }).length;
        box.innerHTML =
          '<div class="ov-ov-top"><div><span class="eyebrow">Overall readiness</span>' +
            '<div class="ov-big">' + pctNum(r) + '<span>%</span></div></div>' +
            '<div class="ov-ov-acts">' + exportBtn + '</div></div>' +
          '<div class="ov-bar" role="img" aria-label="' + pctNum(r) + '% ready"><i style="width:' + pctNum(r) + '%"></i></div>' +
          '<div class="ov-dist-row"><span class="ov-dist-l">Puzzles ' + (ps.length ? '<b>' + pDone + '/' + ps.length + '</b> built+' : '') + '</span>' + dist(pc, pList, 'st', ps.length) + '</div>' +
          '<div class="ov-dist-row"><span class="ov-dist-l">Assets ' + (as.length ? '<b>' + aDone + '/' + as.length + '</b> ready' : '') + '</span>' + dist(ac, AS_STATUSES, 'as', as.length) + '</div>' +
          '<p class="ov-howto">Puzzles count double: Idea 0 · Draft 25 · Built 50 · Tested 75 · Ready 100%. Assets: Idea 0 · Making 50 · Ready 100%.</p>';
      }

      /* ================= get started ================= */
      function firstChapter() { return Kit.chapters()[0] || null; }
      function gsSteps() {
        var g = D.game, events = Kit.list('event'), puzzles = Kit.list('puzzle');
        var named = DEFAULT_TITLES.indexOf(String(g.title || '').trim().toLowerCase()) < 0 && !!String(g.premise || '').trim();
        var placedPz = puzzles.filter(function (p) { return p.event && Kit.has(p.event); });
        var resEv = events.filter(function (e) { return (e.research || []).some(function (r) { return Kit.has(r); }); });
        return [
          { id: 'name', done: named, title: 'Name the game and write a premise',
            help: 'A title and a few lines on what players uncover. It keeps you and any LLM on the same page.',
            doneText: '“' + esc(g.title) + '”' },
          { id: 'event', done: events.length > 0, title: 'Add your first event',
            help: 'Events are the real (or invented) happenings a chapter is built around: a mystery, a find, a date.',
            doneText: refs(events.slice(0, 3).map(function (e) { return e.id; })) + (events.length > 3 ? '<span class="faint">+' + (events.length - 3) + ' more</span>' : '') },
          { id: 'puzzle', done: placedPz.length > 0, title: 'Add a puzzle to it',
            help: 'A puzzle lives inside an event. Name it now; shape it later in the crafter.',
            doneText: refs(placedPz.slice(0, 3).map(function (p) { return p.id; })) + (placedPz.length > 3 ? '<span class="faint">+' + (placedPz.length - 3) + ' more</span>' : '') },
          { id: 'research', done: resEv.length > 0, title: 'Add research behind it',
            help: 'A link or a book that backs the event up. Players will look it up, so it has to check out.',
            doneText: refs(Kit.list('research').filter(function (r) { return (r.supports || []).some(function (x) { return Kit.type(x) === 'event'; }); }).slice(0, 3).map(function (r) { return r.id; })) },
          { id: 'ideas', done: Kit.list('idea').length > 0, title: 'Capture ideas',
            help: 'Half-thoughts and links. Tag them with #words; link them with #E01 or #P01.',
            doneText: '<button type="button" class="ov-linkish" data-go="ideas">' + plural(Kit.list('idea').length, 'idea') + '</button>' },
        ];
      }
      function evOptions(sel, preferEmpty) {
        var evs = [];
        Kit.chapters().forEach(function (c) { Kit.eventsIn(c.id).forEach(function (e) { evs.push(e); }); });
        Kit.eventsIn(null).forEach(function (e) { evs.push(e); });
        var def = sel || (preferEmpty && (evs.find(function (e) { return !(e.puzzles || []).length; }) || {}).id) || (evs[evs.length - 1] || {}).id;
        return { list: evs, def: def, html: evs.map(function (e) { var c = Kit.chapter(e.chapter); return '<option value="' + esc(e.id) + '"' + (e.id === def ? ' selected' : '') + '>' + esc((c ? 'Ch ' + c.n + ' · ' : 'Unplaced · ') + shortTitle(e.title, 34)) + '</option>'; }).join('') };
      }
      function gsAction(step) {
        var chs = Kit.chapters();
        switch (step.id) {
          case 'name':
            return '<button type="button" class="btn sm" data-act="gs-name">' + (DEFAULT_TITLES.indexOf(String(D.game.title || '').trim().toLowerCase()) >= 0 ? 'Name the game' : 'Write the premise') + '</button>';
          case 'event':
            return '<form class="ov-gs-form" data-gs="event" autocomplete="off">' +
              '<input class="input" id="ov-gs-ev" data-fkey="gs-ev" placeholder="Event name, e.g. The Tunguska event, 1908" aria-label="Event name">' +
              (chs.length > 1 ? '<select class="input" id="ov-gs-ev-ch" aria-label="Chapter">' + chs.map(function (c) { return '<option value="' + c.id + '">' + esc('Ch ' + c.n + ' · ' + c.title) + '</option>'; }).join('') + '</select>' : '') +
              '<button type="submit" class="btn sm primary">Add event' + (chs.length === 1 ? ' to ' + esc(shortTitle(chs[0].title, 18)) : '') + '</button></form>';
          case 'puzzle': {
            if (!Kit.list('event').length) return '<p class="ov-gs-wait">Add an event first.</p>';
            var o = evOptions(null, true);
            return '<form class="ov-gs-form" data-gs="puzzle" autocomplete="off">' +
              '<input class="input" id="ov-gs-pz" data-fkey="gs-pz" placeholder="Puzzle name, e.g. The Classified" aria-label="Puzzle name">' +
              (o.list.length > 1 ? '<select class="input" id="ov-gs-pz-ev" aria-label="Event">' + o.html + '</select>' : '<input type="hidden" id="ov-gs-pz-ev" value="' + esc(o.def) + '">') +
              '<button type="submit" class="btn sm primary">Add puzzle' + (o.list.length === 1 ? ' to ' + esc(shortTitle(o.list[0].title, 16)) : '') + '</button></form>';
          }
          case 'research': {
            if (!Kit.list('event').length) return '<p class="ov-gs-wait">Add an event first.</p>';
            var o2 = evOptions(null, false);
            return '<form class="ov-gs-form" data-gs="research" autocomplete="off">' +
              '<input class="input" id="ov-gs-rs" data-fkey="gs-rs" placeholder="A link, or the title of a book or article" aria-label="Research link or title">' +
              (o2.list.length > 1 ? '<select class="input" id="ov-gs-rs-ev" aria-label="Event it backs up">' + o2.html + '</select>' : '<input type="hidden" id="ov-gs-rs-ev" value="' + esc(o2.def) + '">') +
              '<button type="submit" class="btn sm primary">Add research</button></form>';
          }
          case 'ideas':
            return '<form class="ov-gs-form" data-gs="idea" autocomplete="off">' +
              '<input class="input" id="ov-gs-idea" data-fkey="gs-idea" placeholder="An idea… #tags, links" aria-label="Capture an idea">' +
              '<button type="submit" class="btn sm primary">Save idea</button></form>';
        }
        return '';
      }
      function gsVisible() {
        if (isFresh()) return true;
        if (S.gsHidden) return false;
        var steps = gsSteps();
        return steps.some(function (s) { return !s.done; }) && Kit.list('puzzle').length < 6;
      }
      function renderGetStarted() {
        var box = $('#ov-gs', root);
        var show = gsVisible();
        box.hidden = !show;
        if (!show) { box.innerHTML = ''; return; }
        var steps = gsSteps(), done = steps.filter(function (s) { return s.done; }).length;
        var fresh = isFresh();
        var nextIdx = steps.findIndex(function (s) { return !s.done; });
        var alt = '<aside class="ov-gs-alt"><span class="ov-sub">Other ways to start</span>' +
          '<button type="button" class="ov-gs-opt" data-act="gs-import" id="ov-gs-import"><b>Bring in your notes</b><span>Import a cade.txt room as a note, or a JSON backup. In notes, #P04, @Name and [[Name]] link to the game.</span></button>' +
          (window.ARG_SAMPLE ? '<button type="button" class="ov-gs-opt" data-act="gs-sample" id="ov-gs-sample"><b>Explore the sample game</b><span>“' + esc((window.ARG_SAMPLE.game || {}).title || 'The sample') + '” opens in its own slot. Your game stays as it is; switch back from the game menu.</span></button>' : '') +
          '</aside>';
        box.innerHTML =
          '<header class="ov-ph"><h2 id="ov-h-gs">' + (fresh ? 'Get started' : 'Finish setting up') + ' <span class="ov-count">' + done + ' of ' + steps.length + ' done</span></h2>' +
          '<span class="ov-gs-meter" aria-hidden="true">' + steps.map(function (s) { return '<i class="' + (s.done ? 'on' : '') + '"></i>'; }).join('') + '</span>' +
          '<span class="ov-sp"></span>' + (fresh ? '' : '<button type="button" class="btn ghost sm" data-act="gs-hide">Hide checklist</button>') + '</header>' +
          '<div class="ov-gs">' +
          '<ol class="ov-gs-list">' + steps.map(function (s, i) {
            return '<li class="ov-gs-i' + (s.done ? ' done' : '') + (i === nextIdx ? ' next' : '') + '" data-step="' + s.id + '">' +
              '<span class="ov-gs-ck" aria-label="' + (s.done ? 'Done' : 'To do') + '">' + (s.done ? CHECK : (i + 1)) + '</span>' +
              '<div class="ov-gs-body"><div class="ov-gs-t">' + esc(s.title) + '</div>' +
              (s.done ? '<div class="ov-gs-done">' + s.doneText + '</div>' : '<p class="ov-gs-help">' + esc(s.help) + '</p>' + gsAction(s)) +
              '</div></li>';
          }).join('') + '</ol>' + alt + '</div>';
      }
      function gsSubmit(form) {
        var kind = form.dataset.gs, phone = ctx.isPhone();
        if (kind === 'event') {
          var inp = $('#ov-gs-ev', root), title = inp.value.trim();
          if (!title) { Kit.toast('Type the event\'s name first'); inp.focus(); return; }
          var chSel = $('#ov-gs-ev-ch', root), ch = chSel ? chSel.value : (firstChapter() || {}).id || null;
          inp.value = '';
          var order = Kit.eventsIn(ch).length + 1;
          var eid = Kit.create('event', { title: title, chapter: ch, order: order });
          if (!phone) S.refocus = 'gs-pz';
          Kit.toast('Added ' + eid + ' ' + title + (Kit.chapter(ch) ? ' to ' + Kit.chapter(ch).title : ''), { label: 'Open', run: function () { ctx.go(eid); } });
        } else if (kind === 'puzzle') {
          var pi = $('#ov-gs-pz', root), pt = pi.value.trim(), ev = ($('#ov-gs-pz-ev', root) || {}).value;
          if (!pt) { Kit.toast('Type the puzzle\'s name first'); pi.focus(); return; }
          if (!ev || !Kit.has(ev)) { Kit.toast('Add an event first'); return; }
          pi.value = '';
          var pid = Kit.create('puzzle', { title: pt, event: ev });
          if (!phone) S.refocus = 'gs-rs';
          Kit.toast('Added ' + pid + ' ' + pt + ' to ' + Kit.label(ev), { label: 'Open in crafter', run: function () { ctx.go('crafter.' + pid); } });
        } else if (kind === 'research') {
          var ri = $('#ov-gs-rs', root), rv = ri.value.trim(), rev = ($('#ov-gs-rs-ev', root) || {}).value;
          if (!rv) { Kit.toast('Paste a link or type a title first'); ri.focus(); return; }
          if (!rev || !Kit.has(rev)) { Kit.toast('Add an event first'); return; }
          ri.value = '';
          var url = isUrl(rv) ? rv : null;
          var rtitle = url ? (Kit.domain(url) + (function () { try { var u = new URL(url); return u.pathname.length > 1 ? ' · ' + decodeURIComponent(u.pathname.split('/').filter(Boolean).pop()).replace(/[_-]+/g, ' ') : ''; } catch (e) { return ''; } })()) : rv;
          var rid = Kit.create('research', { title: rtitle.slice(0, 120), url: url, kind: url ? 'web' : 'book', supports: [rev] });
          if (!phone) S.refocus = 'gs-idea';
          Kit.toast('Added research ' + rid + ' behind ' + Kit.label(rev), { label: 'Open', run: function () { ctx.go(rid); } });
        } else if (kind === 'idea') {
          var ii = $('#ov-gs-idea', root);
          if (!ii.value.trim()) { Kit.toast('Type an idea first'); ii.focus(); return; }
          var v = ii.value; ii.value = '';
          captureIdea(v);
        }
      }

      /* ================= 2. readiness by chapter → events ================= */
      function segPz(p) {
        return '<button type="button" class="ov-seg st-' + esc(p.status) + '" data-go="' + esc(p.id) + '" data-ref="' + esc(p.id) + '" aria-label="' + esc(p.id + ' ' + p.title + ': ' + statusLabel(p.status)) + '">' + esc(p.id) + '</button>';
      }
      function segAs(a) {
        return '<button type="button" class="ov-seg as-' + esc(a.status) + '" data-go="' + esc(a.id) + '" data-ref="' + esc(a.id) + '" aria-label="' + esc(a.id + ' ' + a.name + ': ' + a.status) + '">' + esc(a.id) + '</button>';
      }
      function evRow(e, rank) {
        var ps = Kit.list('puzzle').filter(function (p) { return p.event === e.id; }).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
        return '<div class="ov-ev">' +
          '<span class="ov-ev-n">' + (e.chapter ? esc(e.order || '·') : '·') + '</span>' + (Kit.layerDot(e.layer) || '<span class="ov-dot-none"></span>') +
          '<button type="button" class="ov-ev-name" data-go="' + esc(e.id) + '" title="' + esc(e.title) + '"><span class="ov-ev-id">' + esc(e.id) + '</span><span class="ov-ev-t">' + esc(e.title) + '</span>' + (e.when ? '<span class="ov-ev-when">' + esc(Kit.year(e.when) || e.when) + '</span>' : '') + '</button>' +
          '<div class="ov-mtr">' + (ps.length ? ps.map(segPz).join('') :
            '<span class="ov-none">no puzzles yet</span><button type="button" class="ov-mini" data-act="ev-add-puzzle" data-id="' + esc(e.id) + '">' + Kit.ICONS.plus + 'Puzzle</button>') + '</div></div>';
      }
      function renderReady() {
        var order = Kit.puzzleOrder();
        var rank = {}; order.forEach(function (p, i) { rank[p.id] = i; });
        var iss = issues();
        $('#ov-ready-key', root).innerHTML =
          '<span class="ov-key-l">Puzzles</span>' + D.statuses.map(function (s) { return '<span><i class="st-' + s.id + '"></i>' + esc(s.label) + '</span>'; }).join('') +
          '<span class="ov-key-l">Assets</span>' + AS_STATUSES.map(function (s) { return '<span><i class="as-' + s[0] + '"></i>' + s[1] + '</span>'; }).join('');
        var rows = Kit.chapters().map(function (ch) {
          var evs = Kit.eventsIn(ch.id);
          var ps = Kit.puzzlesIn(ch.id);
          var loosePs = ps.filter(function (p) { return !p.event || !Kit.has(p.event); }).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
          var as = Kit.list('asset').filter(function (a) { return a.chapter === ch.id; });
          var r = readiness(ps, as);
          var ids = new Set([ch.id].concat(evs.map(function (e) { return e.id; }), ps.map(function (p) { return p.id; }), as.map(function (a) { return a.id; })));
          var chIss = iss.filter(function (i) { return i.ids.some(function (x) { return ids.has(x); }); });
          var high = chIss.filter(function (i) { return i.severity === 'high'; }).length;
          var open = !S.collapsed.has(ch.id);
          return '<div class="ov-ch' + (open ? '' : ' shut') + '">' +
            '<div class="ov-ch-top">' +
              '<button type="button" class="ov-tog" data-act="ch-toggle" data-id="' + esc(ch.id) + '" data-fkey="tog-' + esc(ch.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Collapse' : 'Expand') + ' chapter ' + esc(ch.n) + '">' + CARET + '</button>' +
              '<button type="button" class="ov-ch-name" data-go="' + esc(ch.id) + '" title="Open the chapter page">' + Kit.idChip(ch.id) + '<span>' + esc(ch.title) + '</span>' + CHEV + '</button>' +
              '<span class="ov-ch-meta">' + plural(evs.length, 'event') + ' · ' + plural(ps.length, 'puzzle') + (as.length ? ' · ' + plural(as.length, 'asset') : '') +
                (chIss.length ? ' · <span class="' + (high ? 'ov-hi' : '') + '">' + plural(chIss.length, 'problem') + '</span>' : '') + '</span>' +
              '<span class="ov-ch-pct">' + pct(r) + '</span>' +
              (evs.length || ps.length ? '<button type="button" class="ov-mini" data-act="export-ch" data-id="' + esc(ch.id) + '" title="Export chapter ' + esc(ch.n) + ' for an LLM">Export</button>' : '') +
            '</div>' +
            (r != null ? '<div class="ov-ch-bar" role="img" aria-label="Chapter ' + esc(ch.n) + ' ' + pct(r) + ' ready"><i style="width:' + pctNum(r) + '%"></i></div>' : '<div class="ov-ch-gap"></div>') +
            (open ? '<div class="ov-evs">' +
              (evs.length ? evs.map(function (e) { return evRow(e, rank); }).join('') :
                '<div class="ov-ev-empty"><span>No events in this chapter yet.</span><button type="button" class="btn sm" data-act="ch-add-event" data-id="' + esc(ch.id) + '">' + Kit.ICONS.plus + 'Add an event</button></div>') +
              (loosePs.length ? '<div class="ov-ev ov-ev-loose"><span class="ov-ev-n">·</span><span class="ov-dot-none"></span><span class="ov-ev-name static"><span class="ov-ev-t">Puzzles with no event</span></span><div class="ov-mtr">' + loosePs.map(segPz).join('') + '</div></div>' : '') +
              (as.length ? '<div class="ov-ev ov-ev-as"><span class="ov-ev-n"></span><span class="ov-dot-none"></span><span class="ov-ev-name static"><span class="ov-rl">Assets</span></span><div class="ov-mtr">' + as.map(segAs).join('') + '</div></div>' : '') +
              '</div>' : '') +
            '</div>';
        });
        /* events not in a chapter yet */
        var unplaced = Kit.eventsIn(null);
        if (unplaced.length) {
          var openU = !S.collapsed.has('_unplaced');
          rows.push('<div class="ov-ch ov-ch-unplaced' + (openU ? '' : ' shut') + '"><div class="ov-ch-top">' +
            '<button type="button" class="ov-tog" data-act="ch-toggle" data-id="_unplaced" aria-expanded="' + openU + '" aria-label="' + (openU ? 'Collapse' : 'Expand') + ' unplaced events">' + CARET + '</button>' +
            '<button type="button" class="ov-ch-name" data-go="events"><span>Not placed yet</span>' + CHEV + '</button>' +
            '<span class="ov-ch-meta">' + plural(unplaced.length, 'event') + ' waiting for a chapter</span></div>' +
            (openU ? '<div class="ov-evs">' + unplaced.map(function (e) { return evRow(e, rank); }).join('') + '</div>' : '') + '</div>');
        }
        /* puzzles in no chapter and no event */
        var loose = Kit.list('puzzle').filter(function (p) { return !Kit.chapter(p.chapter) && (!p.event || !Kit.has(p.event)); }).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
        if (loose.length) rows.push('<div class="ov-ch ov-ch-unplaced"><div class="ov-ch-top"><span class="ov-tog-gap"></span><button type="button" class="ov-ch-name" data-go="puzzles"><span>Puzzles not in an event</span>' + CHEV + '</button>' +
          '<span class="ov-ch-meta">open one and pick its event</span></div><div class="ov-evs"><div class="ov-ev ov-ev-loose"><span class="ov-ev-n"></span><span class="ov-dot-none"></span><span class="ov-ev-name static"><span class="ov-ev-t">' + plural(loose.length, 'puzzle') + '</span></span><div class="ov-mtr">' + loose.map(segPz).join('') + '</div></div></div></div>');
        if (!Kit.chapters().length) rows.unshift('<div class="ov-ev-empty"><span>No chapters yet.</span><button type="button" class="btn sm" data-act="add-chapter">' + Kit.ICONS.plus + 'Add a chapter</button></div>');
        $('#ov-ready-b', root).innerHTML = rows.join('');
      }
      function addEventTo(chId) {
        var order = Kit.eventsIn(chId).length + 1;
        var eid = Kit.create('event', { title: 'New event', chapter: chId, order: order });
        Kit.toast('Added ' + eid + ' to ' + Kit.label(chId) + '. Name it on its page.');
        ctx.go(eid);
      }
      function addPuzzleTo(eid) {
        var pid = Kit.create('puzzle', { title: 'Untitled puzzle', event: eid });
        Kit.toast('Added ' + pid + ' to ' + Kit.label(eid) + '. Name it on its page.');
        ctx.go(pid);
      }

      /* ================= 3. work on next ================= */
      function workItems() {
        var out = [], seen = new Set();
        function add(key, it) { if (seen.has(key)) return; seen.add(key); out.push(it); }
        function fromIssues(kind, sev, quick) {
          issues().filter(function (i) { return i.kind === kind; }).forEach(function (i) {
            var t = fixTarget(i.kind, i.ids);
            add(i.kind + ':' + i.ids[0], { sev: sev || i.severity, kind: i.kind, text: i.text, go: t.go, where: t.where, quick: quick ? quick(i) : null });
          });
        }
        issues().filter(function (i) { return i.severity === 'high'; }).forEach(function (i) {
          var t = fixTarget(i.kind, i.ids);
          add(i.kind + ':' + i.ids[0], { sev: 'high', kind: i.kind, text: i.text, go: t.go, where: t.where,
            quick: i.kind === 'Renewal' ? { act: 'renew', id: i.ids[0], label: 'Mark renewed' } : null });
        });
        Kit.list('clue').forEach(function (c) {
          if (c.plantedIn) return;
          var built = (c.usedBy || []).filter(function (pid) { return Kit.statusIndex((Kit.get(pid) || {}).status) >= 2; });
          if (built.length) add('Unplanted clue:' + c.id, { sev: 'high', kind: 'Unplanted clue', text: c.id + ' “' + c.text + '” is needed by ' + built.join(', ') + ' (built) but nothing carries it.', go: c.id, where: 'Clue · ' + c.id });
        });
        var order = Kit.puzzleOrder();
        order.forEach(function (p) {
          if (Kit.statusIndex(p.status) >= 1 && noSolution(p))
            add('No solution:' + p.id, { sev: 'med', kind: 'No solution', text: p.id + ' ' + p.title + ' is ' + statusLabel(p.status).toLowerCase() + ' but has no solution written down.', go: 'crafter.' + p.id, where: 'Crafter · ' + p.id });
        });
        order.forEach(function (p) {
          if (Kit.statusIndex(p.status) >= 2 && !(p.solvePath || []).length)
            add('No solve path:' + p.id, { sev: 'med', kind: 'No solve path', text: p.id + ' ' + p.title + ' is built but has no step-by-step solve path.', go: 'crafter.' + p.id, where: 'Crafter · ' + p.id });
        });
        Kit.list('question').filter(function (q) { return q.status === 'open' && q.severity === 'high'; }).forEach(function (q) {
          add('q:' + q.id, { sev: 'high', kind: 'Open question', text: q.text, go: q.id, where: 'Question · ' + q.id, quick: { act: 'resolve-go', id: q.id, label: 'Resolve' } });
        });
        fromIssues('Needs a source', 'med');
        Kit.list('research').forEach(function (r) {
          var deps = (r.supports || []).filter(function (x) { return Kit.type(x) === 'puzzle'; });
          if (r.status !== 'verified' && deps.length)
            add('r:' + r.id, { sev: 'med', kind: 'Verify research', text: r.id + ' ' + r.title + ' is “' + r.status + '”, and ' + deps.join(', ') + (deps.length === 1 ? ' depends' : ' depend') + ' on it.', go: r.id, where: 'Research · ' + r.id });
        });
        Kit.list('task').filter(function (t) { return t.status === 'doing'; }).forEach(function (t) {
          add('t:' + t.id, { sev: 'low', kind: 'In progress', text: t.title, go: t.id, where: 'Task · ' + t.id, quick: { act: 'task-done', id: t.id, label: 'Mark done' } });
        });
        fromIssues('Empty event', 'low', function (i) { return { act: 'ev-add-puzzle', id: i.ids[0], label: 'Add a puzzle' }; });
        fromIssues('Not placed', 'low');
        fromIssues('No event', 'low');
        return out;
      }
      function renderNext() {
        var items = workItems(), LIMIT = 9;
        var shown = S.showAllNext ? items : items.slice(0, LIMIT);
        $('#ov-next-n', root).textContent = items.length ? String(items.length) : '';
        $('#ov-next-b', root).innerHTML = !items.length ? '<p class="ov-empty">Nothing urgent. Pick a puzzle in Draft and push it to Built.</p>' :
          '<ol class="ov-nx">' + shown.map(function (it, i) {
            return '<li class="ov-nx-i"><span class="ov-nx-n">' + (i + 1) + '</span><span class="ov-bar-s ' + it.sev + '" aria-hidden="true"></span>' +
              '<button type="button" class="ov-nx-main" data-go="' + esc(it.go) + '"><span class="ov-nx-k"><span>' + esc(it.kind) + '</span><span class="ov-nx-w">' + CHEV + esc(it.where) + '</span></span><span class="ov-nx-t">' + esc(it.text) + '</span></button>' +
              (it.quick ? '<button type="button" class="btn sm ov-nx-q" data-act="' + it.quick.act + '" data-id="' + esc(it.quick.id) + '" data-fkey="nxq-' + esc(it.quick.id) + '">' + esc(it.quick.label) + '</button>' : '') +
              '</li>';
          }).join('') + '</ol>' +
          (items.length > LIMIT ? '<button type="button" class="btn ghost sm" data-act="next-all">' + (S.showAllNext ? 'Show the top ' + LIMIT : 'Show all ' + items.length) + '</button>' : '');
      }

      /* ================= 4. pipeline kanban ================= */
      function layerMix(p) {
        var c = { record: 0, pseudo: 0, fiction: 0 };
        [].concat(p.event ? [p.event, p.event] : [], p.inputs || [], p.reveals || []).forEach(function (id) { var l = Kit.layerOf(id); if (l && c[l] != null) c[l]++; });
        return c;
      }
      function puzzleFlags(p) {
        var f = [], si = Kit.statusIndex(p.status);
        if (!p.event || !Kit.has(p.event)) f.push({ cls: 'warn', text: 'No event', title: 'Not inside an event yet. Open it and pick one.' });
        var unpl = (p.inputs || []).filter(function (cid) { var c = Kit.get(cid); return c && !c.plantedIn; });
        if (unpl.length) f.push({ cls: 'bad', text: 'Unplanted ' + unpl.join(', '), title: 'Clue ' + unpl.join(', ') + ' is not carried by any asset yet' });
        if (si >= 1 && noSolution(p)) f.push({ cls: 'warn', text: 'No solution', title: 'Past Idea, but the solution is not written down' });
        if (si >= 2 && !(p.solvePath || []).length) f.push({ cls: 'warn', text: 'No solve path', title: 'Built, but there is no step-by-step solve path' });
        if (p.recipe && p.recipe.steps && p.recipe.steps.length) {
          var rc = typeof Kit.verifyRecipe === 'function' ? Kit.verifyRecipe(p.recipe) : Kit.checkRecipe(p.recipe);
          if (!rc.ok) f.push({ cls: 'bad', text: 'Recipe broken', title: 'The cipher recipe does not round-trip' });
        }
        var unv = Kit.list('research').filter(function (r) { return r.status !== 'verified' && (r.supports || []).indexOf(p.id) >= 0; });
        if (unv.length) f.push({ cls: 'warn', text: 'Unverified ' + unv.map(function (r) { return r.id; }).join(', '), title: 'Research it depends on is not verified' });
        var g = Kit.list('character').filter(function (c) { return c.guard && (c.appears || []).indexOf(p.id) >= 0; });
        if (g.length) f.push({ cls: 'real', text: 'Real person', title: g.map(function (c) { return c.name + ': ' + c.guard; }).join('\n') });
        return f;
      }
      function cardHtml(p) {
        var mix = layerMix(p);
        var stripe = LAYERS.filter(function (l) { return mix[l]; }).map(function (l) { return '<i class="layer-' + l + '" style="flex:' + mix[l] + '"></i>'; }).join('');
        var mixTitle = LAYERS.filter(function (l) { return mix[l]; }).map(function (l) { return mix[l] + ' ' + Kit.layer(l).label; }).join(', ') || 'No claims linked yet';
        var si = Kit.statusIndex(p.status), ev = p.event && Kit.get(p.event);
        var stats = ['<span>' + esc(Kit.fmtMinutes(p.estMin)) + '</span>'];
        if (si >= 2) stats.push('<span class="' + ((p.checks || []).length < D.designChecks.length ? 'warn' : '') + '" title="Design checks passed">checks ' + (p.checks || []).length + '/' + D.designChecks.length + '</span>');
        if ((p.hints || []).length) stats.push('<span title="Hints are rare">' + plural(p.hints.length, 'hint') + '</span>');
        if (p.final) stats.push('<span class="ov-final">finale</span>');
        var flags = puzzleFlags(p).map(function (f) { return '<span class="ov-flag ' + f.cls + '" title="' + esc(f.title) + '">' + esc(f.text) + '</span>'; }).join('');
        return '<article class="ov-card' + (S.flash === p.id ? ' flash' : '') + '" data-pid="' + esc(p.id) + '" tabindex="0" aria-label="' + esc(p.id + ' ' + p.title + ', ' + statusLabel(p.status) + '. Press Enter to open.') + '">' +
          '<span class="ov-stripe" title="Layer mix: ' + esc(mixTitle) + '">' + stripe + '</span>' +
          '<div class="ov-card-top">' + Kit.idChip(p.id) + '<span class="chip ov-chchip">' + esc(chName(p.chapter)) + '</span><span class="ov-kind">' + esc(kindLabel(p.kind)) + '</span>' + Kit.diff(+p.difficulty || 0) + '</div>' +
          '<button type="button" class="ov-card-title" data-go="' + esc(p.id) + '" tabindex="-1">' + esc(p.title || 'Untitled puzzle') + '</button>' +
          (ev ? '<div class="ov-card-ev" title="' + esc(ev.title) + '">' + Kit.layerDot(ev.layer) + '<span>' + esc(ev.title) + '</span></div>' : '') +
          '<div class="ov-card-foot"><span class="ov-card-stats">' + stats.join('') + '</span>' + flags +
          '<button type="button" class="ov-move" data-act="move-menu" data-id="' + esc(p.id) + '" data-fkey="move-' + esc(p.id) + '" aria-haspopup="menu" aria-expanded="false" aria-label="Move ' + esc(p.id) + ' to another stage">Move ▾</button></div>' +
          '</article>';
      }
      function renderKanban() {
        closeMenu();
        var all = Kit.list('puzzle');
        var opts = [['all', 'All', all.length]].concat(Kit.chapters().map(function (c) { return [c.id, 'Ch ' + c.n, Kit.puzzlesIn(c.id).length]; }));
        var noCh = all.filter(function (p) { return !Kit.chapter(p.chapter); }).length;
        if (noCh) opts.push(['_none', 'No chapter', noCh]);
        if (S.chapter !== 'all' && S.chapter !== '_none' && !Kit.chapter(S.chapter)) S.chapter = 'all';
        $('#ov-ch-seg', root).innerHTML = opts.map(function (o) {
          return '<button type="button" data-act="ch-filter" data-v="' + esc(o[0]) + '" aria-pressed="' + (S.chapter === o[0]) + '" title="' + esc(o[0] === 'all' ? 'All chapters' : o[0] === '_none' ? 'Puzzles not in a chapter' : (Kit.chapter(o[0]) || {}).title || '') + '">' + esc(o[1]) + '<span class="ov-n">' + o[2] + '</span></button>';
        }).join('');
        var rank = {}; Kit.puzzleOrder().forEach(function (p, i) { rank[p.id] = i; });
        var ps = all.filter(function (p) { return S.chapter === 'all' || (S.chapter === '_none' ? !Kit.chapter(p.chapter) : p.chapter === S.chapter); }).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
        var flagged = ps.filter(function (p) { return puzzleFlags(p).some(function (f) { return f.cls !== 'real'; }); }).length;
        $('#ov-pipe-n', root).textContent = plural(ps.length, 'puzzle') + (flagged ? ' · ' + flagged + ' flagged' : '');
        KB.innerHTML = D.statuses.map(function (st) {
          var cards = ps.filter(function (p) { return p.status === st.id; });
          return '<div class="ov-col" data-status="' + st.id + '" role="group" aria-label="' + esc(st.label) + '"><div class="ov-col-h">' + Kit.pips(st.id) + '<span>' + esc(st.label) + '</span><span class="ov-n">' + cards.length + '</span></div>' +
            '<div class="ov-col-b">' + (cards.length ? cards.map(cardHtml).join('') : '<div class="ov-col-empty">Drag a card here</div>') + '</div></div>';
        }).join('');
        if (S.flash) { var c = cardEl(S.flash); if (c) { c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } S.flash = null; }
      }
      function cardEl(pid) { return KB.querySelector('.ov-card[data-pid="' + pid + '"]'); }
      function moveCard(pid, status) {
        var p = Kit.get(pid); if (!p || p.status === status) return;
        var from = p.status;
        S.flash = pid;
        Kit.update(pid, { status: status });
        Kit.toast(pid + ' moved to ' + statusLabel(status), { label: 'Undo', run: function () { S.flash = pid; Kit.update(pid, { status: from }); Kit.toast(pid + ' is back in ' + statusLabel(from)); } });
      }

      /* --- drag and drop (mouse drag; touch = long-press then drag) --- */
      var drag = null, justDragged = false;
      listen(KB, 'pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        var card = e.target.closest('.ov-card');
        if (!card || e.target.closest('button, a, input, select, textarea, .ref')) return;
        closeMenu();
        drag = { card: card, pid: card.dataset.pid, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, id: e.pointerId, started: false, timer: 0, target: null };
        if (e.pointerType !== 'mouse') drag.timer = setTimeout(function () { if (drag && !drag.started) beginDrag(); }, 260);
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragUp);
        window.addEventListener('pointercancel', endDrag);
      });
      function beginDrag() {
        var r = drag.card.getBoundingClientRect();
        drag.started = true; drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top;
        var g = drag.card.cloneNode(true);
        g.classList.add('ov-ghost'); g.removeAttribute('tabindex'); g.setAttribute('aria-hidden', 'true');
        g.style.width = r.width + 'px';
        root.appendChild(g); drag.ghost = g;
        drag.card.classList.add('dragging'); root.classList.add('ov-dragging');
        placeGhost();
      }
      function placeGhost() {
        drag.ghost.style.left = (drag.x - drag.dx) + 'px';
        drag.ghost.style.top = (drag.y - drag.dy) + 'px';
        var under = document.elementFromPoint(drag.x, drag.y);
        var col = under && under.closest ? under.closest('.v-overview .ov-col') : null;
        $$('.ov-col.over', KB).forEach(function (c) { if (c !== col) c.classList.remove('over'); });
        if (col) col.classList.add('over');
        drag.target = col ? col.dataset.status : null;
      }
      function autoScroll() {
        var kr = KB.getBoundingClientRect(), sr = SCROLL.getBoundingClientRect();
        if (drag.x < kr.left + 36) KB.scrollLeft -= 14; else if (drag.x > kr.right - 36) KB.scrollLeft += 14;
        if (drag.y < sr.top + 40) SCROLL.scrollTop -= 14; else if (drag.y > sr.bottom - 40) SCROLL.scrollTop += 14;
      }
      function onDragMove(e) {
        if (!drag || e.pointerId !== drag.id) return;
        drag.x = e.clientX; drag.y = e.clientY;
        if (!drag.started) {
          var dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
          if (drag.type !== 'mouse') { if (dist > 8) endDrag(); return; }
          if (dist < 5) return;
          beginDrag();
        }
        e.preventDefault();
        placeGhost(); autoScroll();
      }
      function onDragUp(e) {
        if (!drag || e.pointerId !== drag.id) return;
        var was = drag.started, to = drag.target, pid = drag.pid;
        endDrag();
        if (was) {
          justDragged = true; setTimeout(function () { justDragged = false; }, 60);
          var p = Kit.get(pid);
          if (to && p && to !== p.status) moveCard(pid, to);
        }
      }
      function endDrag() {
        if (!drag) return;
        clearTimeout(drag.timer);
        if (drag.ghost) drag.ghost.remove();
        drag.card.classList.remove('dragging');
        root.classList.remove('ov-dragging');
        $$('.ov-col.over', KB).forEach(function (c) { c.classList.remove('over'); });
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragUp);
        window.removeEventListener('pointercancel', endDrag);
        drag = null;
      }
      listen(document, 'touchmove', function (e) { if (drag && drag.started) e.preventDefault(); }, { passive: false });
      listen(document, 'contextmenu', function (e) { if (drag) e.preventDefault(); });

      /* --- Move ▾ menu (keyboard + tap alternative to dragging) --- */
      function openMoveMenu(btn, pid) {
        if (S.menu && S.menu.pid === pid) { closeMenu(); return; }
        closeMenu();
        var p = Kit.get(pid); if (!p) return;
        var m = Kit.h('div', { class: 'ov-menu', role: 'menu', 'aria-label': 'Move ' + pid + ' to' });
        m.innerHTML = '<span class="eyebrow">Move ' + esc(pid) + ' to</span>' + D.statuses.map(function (s) {
          return '<button type="button" role="menuitem" data-v="' + s.id + '"' + (s.id === p.status ? ' disabled aria-current="true"' : '') + '>' +
            Kit.pips(s.id) + '<span>' + esc(s.label) + '</span>' + (s.id === p.status ? '<span class="faint ov-now">now</span>' : '') + '</button>';
        }).join('') + '<hr><button type="button" role="menuitem" data-open="trail.' + esc(pid) + '">Open on the trail</button><button type="button" role="menuitem" data-open="crafter.' + esc(pid) + '">Open in the crafter</button>';
        root.appendChild(m);
        var r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
        var top = r.bottom + 4; if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
        m.style.top = top + 'px';
        m.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
        btn.setAttribute('aria-expanded', 'true');
        S.menu = { el: m, btn: btn, pid: pid };
        m.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b || b.disabled) return;
          closeMenu();
          if (b.dataset.open) { ctx.go(b.dataset.open); return; }
          S.refocus = 'move-' + pid;
          moveCard(pid, b.dataset.v);
        });
        m.addEventListener('keydown', function (e) {
          var items = $$('button:not(:disabled)', m), i = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
          else if (e.key === 'Tab') { closeMenu(); }
        });
        var first = m.querySelector('button:not(:disabled)'); if (first) first.focus();
      }
      function closeMenu() {
        if (!S.menu) return;
        S.menu.el.remove(); if (S.menu.btn.isConnected) S.menu.btn.setAttribute('aria-expanded', 'false');
        S.menu = null;
      }
      listen(document, 'pointerdown', function (e) {
        if (S.menu && !S.menu.el.contains(e.target) && !S.menu.btn.contains(e.target)) closeMenu();
      }, true);
      listen(SCROLL, 'scroll', closeMenu, { passive: true });
      listen(KB, 'scroll', closeMenu, { passive: true });

      /* ================= 5. problems ================= */
      function renderProblems() {
        var all = issues(), c = sevCounts(all.map(function (i) { return i.severity; }));
        $('#ov-prob-n', root).textContent = all.length ? String(all.length) : '';
        var seg = $('#ov-prob-seg', root);
        seg.hidden = !all.length;
        seg.innerHTML = all.length ? [['all', 'All', all.length], ['high', 'High', c.high], ['med', 'Med', c.med], ['low', 'Low', c.low]].map(function (o) {
          return '<button type="button" data-act="prob-filter" data-v="' + o[0] + '" aria-pressed="' + (S.prob === o[0]) + '">' + o[1] + '<span class="ov-n">' + o[2] + '</span></button>';
        }).join('') : '';
        $('#ov-plw', root).classList.toggle('short', all.length < 3);
        var list = S.prob === 'all' ? all : all.filter(function (i) { return i.severity === S.prob; });
        $('#ov-probs-b', root).innerHTML = !all.length ? '<li class="ov-empty">No problems. The integrity checks all pass.</li>' : list.length ? list.map(function (i) {
          var t = fixTarget(i.kind, i.ids);
          return '<li><span class="ov-bar-s ' + i.severity + '" aria-hidden="true"></span><div>' +
            '<div class="ov-pl-k"><span class="sev sev-' + i.severity + '">' + i.severity + '</span><span>' + esc(i.kind) + '</span>' +
            (t.go ? '<button type="button" class="ov-mini ov-fix" data-go="' + esc(t.go) + '">Fix' + CHEV + '</button>' : '') + '</div>' +
            '<div class="ov-pl-t">' + esc(i.text) + '</div><div class="ov-refs">' + refs(i.ids, { idOnly: true }) + '</div></div></li>';
        }).join('') : '<li class="ov-empty">No problems at this severity.</li>';
      }

      /* ================= 6. decisions ================= */
      function age(d) { var n = Kit.daysUntil(d); if (n == null || isNaN(n)) return ''; n = -n; return n <= 0 ? 'raised today' : n === 1 ? 'raised yesterday' : 'open ' + n + ' days'; }
      function renderDecisions() {
        var qs = Kit.list('question'), open = qs.filter(function (q) { return q.status === 'open'; }).sort(function (a, b) { return (SEV[a.severity] || 0) - (SEV[b.severity] || 0) || String(a.created).localeCompare(String(b.created)); });
        var resolved = qs.filter(function (q) { return q.status !== 'open'; });
        var tasks = Kit.list('task').filter(function (t) { return t.status !== 'done' || S.touchedTasks.has(t.id); })
          .sort(function (a, b) { var r = { doing: 0, todo: 1, done: 2 }; return (r[a.status] || 0) - (r[b.status] || 0) || (a.id < b.id ? -1 : 1); });
        var oc = sevCounts(open.map(function (q) { return q.severity; }));
        var openTasks = tasks.filter(function (t) { return t.status !== 'done'; }).length;
        $('#ov-dec-n', root).textContent = [open.length ? open.length + ' open' + (oc.high ? ' · ' + oc.high + ' high' : '') : '', openTasks ? plural(openTasks, 'task') : ''].filter(Boolean).join(' · ');
        var qItem = function (q) {
          var isOpen = q.status === 'open';
          return '<div class="ov-q' + (isOpen ? '' : ' resolved') + '" data-q="' + esc(q.id) + '">' +
            '<div class="ov-q-top"><span class="sev sev-' + esc(q.severity) + '">' + esc(q.severity) + '</span>' + Kit.idChip(q.id) + chip(q.kind) +
            '<span class="ov-q-age">' + esc(isOpen ? age(q.created) : 'resolved') + '</span>' +
            (isOpen ? (S.resolving !== q.id ? '<button type="button" class="btn sm" data-act="resolve" data-id="' + esc(q.id) + '" data-fkey="resolve-' + esc(q.id) + '">Resolve</button>' : '')
              : '<button type="button" class="btn sm ghost" data-act="reopen" data-id="' + esc(q.id) + '" data-fkey="reopen-' + esc(q.id) + '">Reopen</button>') + '</div>' +
            '<p class="ov-q-text">' + esc(q.text) + '</p><div class="ov-refs">' + refs(q.links) + '</div>' +
            (!isOpen && q.resolution ? '<p class="ov-q-res">' + esc(q.resolution) + '</p>' : '') +
            (S.resolving === q.id ? '<div class="ov-resolve"><label class="ov-sub" for="ov-res-text">How did you decide?</label>' +
              '<textarea id="ov-res-text" class="input" data-fkey="res-text" rows="3" placeholder="e.g. Use our own copy at a friendly bookshop; it can stay put for years.">' + esc(S.draft) + '</textarea>' +
              '<div class="ov-row-end"><button type="button" class="btn sm ghost" data-act="resolve-cancel">Cancel</button><button type="button" class="btn sm primary" data-act="resolve-save" data-id="' + esc(q.id) + '">Save decision</button></div></div>' : '') +
            '</div>';
        };
        $('#ov-qs', root).innerHTML = (open.length ? open.map(qItem).join('') : '<p class="ov-empty">No open questions. When something needs a decision, add it in <button type="button" class="ov-linkish" data-go="questions">Questions</button>.</p>') +
          (resolved.length ? '<button type="button" class="btn ghost sm ov-more" data-act="show-resolved">' + (S.showResolved ? 'Hide' : 'Show') + ' ' + resolved.length + ' resolved</button>' + (S.showResolved ? resolved.map(qItem).join('') : '') : '');
        $('#ov-tasks', root).innerHTML = tasks.length ? tasks.map(function (t) {
          var done = t.status === 'done';
          return '<div class="ov-task' + (done ? ' done' : '') + '"><input type="checkbox" id="ov-tk-' + esc(t.id) + '" data-task="' + esc(t.id) + '" data-fkey="task-' + esc(t.id) + '"' + (done ? ' checked' : '') + '>' +
            '<label for="ov-tk-' + esc(t.id) + '">' + esc(t.title) + '</label>' +
            (t.status === 'doing' ? '<button type="button" class="chip tone-blue ov-doing" data-act="task-pause" data-id="' + esc(t.id) + '" data-fkey="tstat-' + esc(t.id) + '" title="In progress. Click to set back to to-do.">doing</button>'
              : done ? '' : '<button type="button" class="ov-mini" data-act="task-start" data-id="' + esc(t.id) + '" data-fkey="tstat-' + esc(t.id) + '">Start</button>') +
            '<div class="ov-task-refs">' + Kit.idChip(t.id) + refs(t.links, { idOnly: true }) + '</div></div>';
        }).join('') : '<p class="ov-empty">No open tasks. Add one below.</p>';
      }

      /* ================= 7. library ================= */
      function renderLibrary() {
        var ideas = Kit.list('idea').filter(function (i) { return i.status === 'raw'; })
          .sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')) || (b.id < a.id ? -1 : 1); }).slice(0, 4);
        var allIdeas = Kit.list('idea').length;
        var res = Kit.list('research');
        var toRead = res.filter(function (r) { return r.status === 'to read'; });
        var unv = res.filter(function (r) { return r.status !== 'verified' && (r.supports || []).some(function (x) { return Kit.type(x) === 'puzzle'; }); });
        $('#ov-lib-b', root).innerHTML =
          '<div class="ov-sub">Newest raw ideas</div>' +
          (ideas.length ? '<ul class="ov-ideas">' + ideas.map(function (i) {
            return '<li><button type="button" class="ov-idea" data-go="' + esc(i.id) + '"><span class="ov-idea-t">' + esc(i.text || i.url || '(empty idea)') + '</span>' +
              '<span class="ov-idea-m">' + Kit.idChip(i.id) + (i.created ? '<span>' + esc(Kit.fmtDate(i.created, { noYear: true })) + '</span>' : '') +
              (i.url ? '<span class="ov-dom">' + esc(Kit.domain(i.url)) + '</span>' : '') +
              (i.tags || []).map(function (t) { return '<span class="ov-tag">#' + esc(t) + '</span>'; }).join('') + '</span></button></li>';
          }).join('') + '</ul>' : '<p class="ov-empty ov-gap">' + (allIdeas ? 'No raw ideas waiting. ' + plural(allIdeas, 'idea') + ' already sorted.' : 'No ideas yet. Capture one above.') + '</p>') +
          '<div class="ov-sub">Research</div>' +
          (res.length ? '<div class="ov-lib-stats">' +
            '<button type="button" class="ov-stat" data-go="research"><b>' + toRead.length + '</b><span>to read</span></button>' +
            '<button type="button" class="ov-stat" data-go="research"><b>' + res.filter(function (r) { return r.status === 'verified'; }).length + '</b><span>verified of ' + res.length + '</span></button>' +
            '<button type="button" class="ov-stat' + (unv.length ? ' warn' : '') + '" data-go="research"><b>' + unv.length + '</b><span>puzzles lean on, unverified</span></button>' +
          '</div>' + (unv.length ? '<div class="ov-refs ov-unv">' + unv.map(function (r) { return ref(r.id); }).join('') + '</div>' : '')
          : '<p class="ov-empty">No research yet. Add the links and books behind your events in Research.</p>');
      }
      function captureIdea(raw) {
        var text = String(raw || '').trim(); if (!text) return null;
        var url = null, m = text.match(/https?:\/\/\S+/);
        if (m) { url = m[0].replace(/[),.]+$/, ''); var rest = text.replace(m[0], '').trim(); text = rest || url; }
        /* #P08 / #E04 (an existing id) becomes a link; any other #word becomes a tag */
        var tags = [], links = [];
        text.replace(/(^|\s)#([\w-]+)/g, function (all, sp, w) {
          if (Kit.has(w)) { if (links.indexOf(w) < 0) links.push(w); }
          else { var t = w.toLowerCase(); if (tags.indexOf(t) < 0) tags.push(t); }
          return all;
        });
        /* a trailing run of #words is metadata: drop it; inline ones keep their word */
        var body = text.replace(/(\s+#[\w-]+)+\s*$/, '').replace(/(^|\s)#([\w-]+)/g, '$1$2').trim();
        text = body || text.replace(/#/g, '').trim();
        var id = Kit.create('idea', { text: text, url: url, tags: tags, links: links, status: 'raw', created: Kit.todayIso() });
        Kit.toast('Saved idea ' + id + (tags.length ? ' with #' + tags.join(' #') : ''), { label: 'Undo', run: function () { Kit.remove(id); Kit.toast('Removed idea ' + id); } });
        return id;
      }

      /* ================= 9. assets ================= */
      function renewTone(n) { return n == null ? null : n <= 30 ? 'error' : n <= 45 ? 'amber' : null; }
      function renderAssets() {
        var all = Kit.list('asset');
        var make = all.filter(function (a) { return a.status === 'idea' || a.status === 'making' || S.touchedAssets.has(a.id); })
          .sort(function (a, b) { var o = { making: 0, idea: 1, ready: 2, placed: 3 }; return (o[a.status] || 0) - (o[b.status] || 0) || ((Kit.chapter(a.chapter) || {}).n || 0) - ((Kit.chapter(b.chapter) || {}).n || 0); });
        var ren = all.filter(function (a) { return a.renews; }).sort(function (a, b) { return a.renews < b.renews ? -1 : 1; });
        var toMake = all.filter(function (a) { return a.status === 'idea' || a.status === 'making'; }).length;
        $('#ov-as-n', root).textContent = all.length ? toMake + ' to make · ' + ren.length + ' to keep renewed' : '';
        $('#ov-as', root).classList.toggle('none', !all.length);
        if (!all.length) {
          $('#ov-make', root).innerHTML = '<div class="ov-ev-empty"><span>No assets yet. Domains, phone numbers, printouts and photos that must exist in the wild go here.</span><button type="button" class="btn sm" data-act="add-asset">' + Kit.ICONS.plus + 'Add an asset</button></div>';
          $('#ov-renew', root).innerHTML = '';
          return;
        }
        $('#ov-make', root).innerHTML = make.length ? make.map(function (a) {
          return '<div class="ov-mk" data-asset="' + esc(a.id) + '"><div class="ov-mk-main">' +
            '<button type="button" class="ov-mk-name" data-go="' + esc(a.id) + '">' + esc(a.name) + '</button>' + Kit.idChip(a.id) +
            '<div class="ov-mk-sub"><span class="ov-akind">' + esc(a.kind) + '</span><span>' + esc(chName(a.chapter)) + '</span>' +
            ((a.carries || []).length ? '<span>' + plural(a.carries.length, 'clue') + '</span>' : '') +
            (a.persona && Kit.has(a.persona) ? ref(a.persona) : '') + '</div></div>' +
            '<div class="seg ov-as-seg" role="group" aria-label="Status of ' + esc(a.name) + '">' + AS_STATUSES.map(function (s) {
              return '<button type="button" data-act="asset-status" data-id="' + esc(a.id) + '" data-v="' + s[0] + '" data-fkey="ast-' + esc(a.id) + '-' + s[0] + '" aria-pressed="' + (a.status === s[0]) + '">' + s[1] + '</button>';
            }).join('') + '</div></div>';
        }).join('') : '<p class="ov-empty">Everything is made.</p>';
        $('#ov-renew', root).innerHTML = ren.length ? ren.map(function (a) {
          var n = Kit.daysUntil(a.renews), tone = renewTone(n);
          return '<div class="ov-rn" data-asset="' + esc(a.id) + '"><div class="ov-rn-main"><button type="button" class="ov-mk-name" data-go="' + esc(a.id) + '">' + esc(a.name) + '</button>' +
            '<div class="ov-mk-sub"><span class="ov-akind">' + esc(a.kind) + '</span><span>' + esc(a.cost || 'no cost noted') + '</span></div></div>' +
            '<div class="ov-rn-date"><span>' + esc(Kit.fmtDate(a.renews)) + '</span>' + (tone ? chip(n < 0 ? 'lapsed ' + plural(-n, 'day') + ' ago' : plural(n, 'day') + ' left', tone) : '<span class="faint">' + esc(Kit.relDays(a.renews)) + '</span>') + '</div>' +
            '<button type="button" class="btn sm" data-act="renew" data-id="' + esc(a.id) + '" data-fkey="renew-' + esc(a.id) + '">Mark renewed</button></div>';
        }).join('') : '<p class="ov-empty">Nothing needs renewing. Domains and phone plans with a renewal date show up here.</p>';
      }
      function renewAsset(id) {
        var a = Kit.get(id); if (!a || !a.renews) return;
        var prev = a.renews, d = Kit.parseDate(a.renews);
        var yearly = a.kind === 'domain' || /\/\s*yr|year/i.test(a.cost || '');
        if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
        var next = iso(d);
        Kit.update(id, { renews: next });
        Kit.toast(a.name + ' renewed for a ' + (yearly ? 'year' : 'month') + '. Next renewal ' + Kit.fmtDate(next) + '.',
          { label: 'Undo', run: function () { Kit.update(id, { renews: prev }); Kit.toast('Renewal undone'); } });
      }

      /* ================= 8. history vs trail order ================= */
      var TL = { links: [], order: [] };
      function evYear(s) { var p = String(s || '').split('-').map(Number); return (p[0] || 0) + ((p[1] || 1) - 1) / 12 + ((p[2] || 1) - 1) / 365; }
      function entryLabel(e) { return (Kit.year(e.date) || '?') + ' ' + shortTitle(e.title, 26); }
      /* piecewise year scale: spans with more entries get more room; ticks on round years */
      function yearScale(years, X0, X1) {
        var mn = Math.min.apply(null, years), mx = Math.max.apply(null, years);
        if (!isFinite(mn)) { mn = 1900; mx = 2030; }
        var raw = mx - mn, step = raw > 300 ? 50 : raw > 80 ? 10 : 5;
        var lo = Math.floor(mn / step) * step, hi = Math.ceil(mx / step) * step;
        if (hi === mx) hi += step; if (lo === mn && lo % step === 0 && raw < 10) lo -= step;
        while (hi - lo < 4 * step) { lo -= step; hi += step; }
        var parts = Math.max(2, Math.min(6, Math.round((hi - lo) / step)));
        var cuts = [lo];
        for (var i = 1; i < parts; i++) { var c = lo + Math.round((hi - lo) * i / parts / step) * step; if (c > cuts[cuts.length - 1] && c < hi) cuts.push(c); }
        cuts.push(hi);
        var weights = [];
        for (var k = 0; k < cuts.length - 1; k++) {
          var n = years.filter(function (y) { return y >= cuts[k] && (k === cuts.length - 2 ? y <= cuts[k + 1] : y < cuts[k + 1]); }).length;
          weights.push(years.length < 6 ? 1 : 0.6 + n);  /* few entries: keep the scale linear */
        }
        var tot = weights.reduce(function (a, b) { return a + b; }, 0), acc = 0, brk = [[cuts[0], 0]];
        weights.forEach(function (w, k) { acc += w / tot; brk.push([cuts[k + 1], acc]); });
        var fn = function (yr) {
          yr = Math.max(lo, Math.min(hi, yr));
          for (var j = 1; j < brk.length; j++) if (yr <= brk[j][0]) {
            var a = brk[j - 1], b = brk[j];
            return X0 + (a[1] + (yr - a[0]) / ((b[0] - a[0]) || 1) * (b[1] - a[1])) * (X1 - X0);
          }
          return X1;
        };
        /* ticks: the cut years plus round years inside roomy spans */
        var ticks = [];
        for (var t = 0; t < cuts.length - 1; t++) {
          var a0 = cuts[t], b0 = cuts[t + 1], pw = fn(b0) - fn(a0);
          ticks.push(a0);
          var sub = [5, 10, 20, 25, 50, 100].find(function (st) { return st < (b0 - a0) && (st / (b0 - a0)) * pw >= 58; });
          if (sub) for (var y = Math.ceil((a0 + 1) / sub) * sub; y < b0; y += sub) ticks.push(y);
        }
        ticks.push(hi);
        fn.ticks = ticks; fn.lo = lo; fn.hi = hi;
        /* mark where the scale changes a lot (pixels per year jump by 2× or more) */
        fn.breaks = [];
        for (var q = 1; q < cuts.length - 1; q++) {
          var d1 = (fn(cuts[q]) - fn(cuts[q - 1])) / (cuts[q] - cuts[q - 1]), d2 = (fn(cuts[q + 1]) - fn(cuts[q])) / (cuts[q + 1] - cuts[q]);
          if (Math.max(d1, d2) / Math.max(0.0001, Math.min(d1, d2)) >= 2) fn.breaks.push(cuts[q]);
        }
        return fn;
      }
      function renderHistory() {
        if (!TLW.isConnected) return;
        var cap = $('#ov-tl-cap', root);
        var entries = Kit.list('entry').filter(function (e) { return Kit.year(e.date); });
        var order = Kit.puzzleOrder(); TL.order = order.map(function (p) { return p.id; });
        if (!entries.length || !order.length) {
          TL.links = []; TLW.innerHTML = '';
          cap.dataset.key = 'empty';
          var bits = [];
          if (!entries.length) bits.push('<button type="button" class="btn sm" data-act="add-entry">' + Kit.ICONS.plus + 'Add a timeline entry</button>');
          if (!order.length) bits.push(Kit.list('event').length ? '<button type="button" class="btn sm" data-act="ev-add-puzzle" data-id="' + esc(Kit.list('event')[0].id) + '">' + Kit.ICONS.plus + 'Add a puzzle</button>' : '');
          cap.innerHTML = '<span class="ov-empty-line">' + (!entries.length && !order.length ? 'Add dated timeline entries and puzzles to see the order players meet your history.' :
            !entries.length ? 'No dated timeline entries yet. Add the dates behind your events; mark which puzzle reveals each one.' :
            'No puzzles yet, so there is no trail to compare the history with.') + '</span>' + bits.join('');
          return;
        }
        var W = Math.max(TLW.clientWidth || 0, 1000);
        var C = { text: Kit.cssVar('--text'), muted: Kit.cssVar('--text-muted'), faint: Kit.cssVar('--text-faint'), border: Kit.cssVar('--border'),
          strong: Kit.cssVar('--border-strong'), acc: Kit.cssVar('--accent'), surf: Kit.cssVar('--surface'), surf2: Kit.cssVar('--surface-2') };
        var LC = {}; LAYERS.forEach(function (l) { LC[l] = Kit.cssVar(LAYER_VAR[l]); });
        var bodyFont = getComputedStyle(document.body).fontFamily;
        var X0 = 24, X1 = W - 24;
        var xh = yearScale(entries.map(function (e) { return evYear(e.date); }), X0, X1);
        /* puzzles in trail order, grouped by chapter */
        var GAP = 0.9, pos = 0, prev = null;
        order.forEach(function (p) { if (prev !== null && p.chapter !== prev) pos += GAP; p.__pos = pos; pos += 1; prev = p.chapter; });
        var span = Math.max(1, pos - 1), PX0 = X0 + 40, PX1 = X1 - 40;
        if (order.length === 1) { PX0 = PX1 = (X0 + X1) / 2; }
        var px = function (p) { return order.length === 1 ? PX0 : PX0 + (p.__pos / span) * (PX1 - PX0); };
        var slot = order.length > 1 ? (PX1 - PX0) / span : 160;
        var links = []; entries.forEach(function (e) { if (e.revealedBy && Kit.type(e.revealedBy) === 'puzzle') links.push({ ev: e.id, pz: e.revealedBy }); });
        TL.links = links;
        var linked = new Set(links.map(function (l) { return l.ev; }));
        var evs = entries.map(function (e) { return { e: e, x: xh(evYear(e.date)), label: entryLabel(e) }; }).sort(function (a, b) { return a.x - b.x; });
        evs.forEach(function (o) { o.w = textW(o.label, '10.5px ' + bodyFont); });
        var R1 = placeLabels(evs, 6, X0, X1);
        var Ya = 34 + R1 * 15 + 14, Yb = Ya + 170;
        var maxCh = Math.max(14, Math.min(40, Math.floor(slot / 5.2)));
        var pzs = order.map(function (p) { return { p: p, x: px(p), label: shortTitle(p.title || 'Untitled', maxCh), center: true }; });
        pzs.forEach(function (o) { o.w = textW(o.label, '10px ' + bodyFont); });
        var R2 = placeLabels(pzs, 2, X0, X1, 6);
        /* event ticks under the puzzles, where there is room */
        var groups = [];
        pzs.forEach(function (o) {
          var eid = o.p.event && Kit.has(o.p.event) ? o.p.event : null, g = groups[groups.length - 1];
          if (g && g.ev === eid && g.ch === o.p.chapter) { g.x1 = o.x; g.n++; } else groups.push({ ev: eid, ch: o.p.chapter, x0: o.x, x1: o.x, n: 1 });
        });
        var evLabRow = Yb + 46 + R2 * 13 + 12;
        groups.forEach(function (g) {
          if (!g.ev) return;
          g.room = (g.x1 - g.x0) + slot - 8;
          /* a bracket earns its place when the event holds several puzzles, or its whole name fits */
          var full = Kit.label(g.ev);
          g.label = full; g.w = textW(full, 'italic 9.5px ' + bodyFont); g.fits = g.w <= g.room;
          if (!g.fits) { g.label = shortTitle(full, 30); g.w = textW(g.label, 'italic 9.5px ' + bodyFont); g.fits = g.w <= g.room; }
          if (!g.fits && g.n >= 2) { g.label = shortTitle(full, 16); g.w = textW(g.label, 'italic 9.5px ' + bodyFont); g.fits = g.w <= g.room; }
          if (g.fits && g.n < 2 && g.label.indexOf('…') >= 0) g.fits = false;
        });
        var anyEvLab = groups.some(function (g) { return g.fits; });
        var H = evLabRow + (anyEvLab ? 18 : 0) + 34;
        var bands = [], cur = null, half = slot / 2;
        pzs.forEach(function (o) {
          if (!cur || cur.ch !== o.p.chapter) { cur = { ch: o.p.chapter, x0: o.x, x1: o.x }; bands.push(cur); } else cur.x1 = o.x;
        });
        var s = '<svg class="ov-tl-svg" id="ov-tl-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Timeline entries above; puzzles in trail order below; lines show which puzzle reveals which entry">';
        s += '<text x="' + X0 + '" y="16" class="m" fill="' + C.faint + '">IN-WORLD HISTORY · ' + xh.lo + ' → ' + xh.hi + '</text>';
        s += '<text x="' + X1 + '" y="16" text-anchor="end" class="m" fill="' + C.faint + '">● REVEALED ON THE TRAIL   ○ BACKGROUND ONLY' + (xh.breaks.length ? '   // SCALE CHANGES' : '') + '</text>';
        s += '<line x1="' + X0 + '" x2="' + X1 + '" y1="' + Ya + '" y2="' + Ya + '" stroke="' + C.strong + '"/>';
        var lastTx = -1e9;
        xh.ticks.forEach(function (y, ti) {
          var x = xh(y); if (x - lastTx < 34 && ti !== xh.ticks.length - 1) return; if (x - lastTx < 34) return; lastTx = x;
          s += '<line x1="' + x + '" x2="' + x + '" y1="' + Ya + '" y2="' + (Ya + 4) + '" stroke="' + C.strong + '"/>' +
            '<text x="' + x + '" y="' + (Ya + 17) + '" text-anchor="middle" class="m" fill="' + C.faint + '">' + y + '</text>';
        });
        xh.breaks.forEach(function (y) { var x = xh(y); s += '<path d="M' + (x - 4) + ' ' + (Ya - 4) + ' l3 8 M' + (x + 1) + ' ' + (Ya - 4) + ' l3 8" stroke="' + C.faint + '" fill="none"/>'; });
        bands.forEach(function (b) {
          var c = Kit.chapter(b.ch), bx = Math.max(X0, b.x0 - Math.min(half, 90) + 3), bx1 = Math.min(X1, b.x1 + Math.min(half, 90) - 3), bw = bx1 - bx;
          s += '<rect x="' + bx.toFixed(1) + '" y="' + (Yb - 30) + '" width="' + bw.toFixed(1) + '" height="' + (H - Yb + 30 - 26) + '" rx="5" fill="' + C.surf2 + '"/>' +
            '<text x="' + (bx + 8).toFixed(1) + '" y="' + (H - 34) + '" class="m" fill="' + C.faint + '">' + esc(shortTitle(c ? ('CH' + c.n + ' · ' + c.title).toUpperCase() : 'NO CHAPTER', Math.max(8, Math.floor(bw / 7)))) + '</text>';
        });
        s += '<line x1="' + X0 + '" x2="' + X1 + '" y1="' + Yb + '" y2="' + Yb + '" stroke="' + C.border + '"/>';
        links.forEach(function (l) {
          var e = evs.find(function (o) { return o.e.id === l.ev; }), p = pzs.find(function (o) { return o.p.id === l.pz; }); if (!e || !p) return;
          var y0 = Ya + 6, y1 = Yb - 8, my = (y0 + y1) / 2;
          s += '<path class="ov-link" data-ev="' + esc(l.ev) + '" data-pz="' + esc(l.pz) + '" d="M' + e.x.toFixed(1) + ' ' + y0 + ' C' + e.x.toFixed(1) + ' ' + (my + 14) + ' ' + p.x.toFixed(1) + ' ' + (my - 14) + ' ' + p.x.toFixed(1) + ' ' + y1 + '" fill="none" stroke="' + (LC[e.e.layer] || C.muted) + '" stroke-width="1.5"/>';
        });
        var leaders = '', labels = '', marks = '';
        evs.forEach(function (o) {
          var id = o.e.id, ly = Ya - 14 - o.row * 15, col = LC[o.e.layer] || C.muted, has = linked.has(id), x = o.x.toFixed(1);
          leaders += '<line class="ldr" data-tl="' + esc(id) + '" x1="' + x + '" x2="' + x + '" y1="' + (Ya - 6) + '" y2="' + (ly + 3) + '" stroke="' + C.border + '"/>';
          labels += '<text class="lab" data-tl="' + esc(id) + '" x="' + o.tx.toFixed(1) + '" y="' + ly + '" text-anchor="' + o.anchor + '" fill="' + C.muted + '" stroke="' + C.surf + '">' + esc(o.label) + '</text>';
          marks += '<g class="ov-tl-ev" data-tl="' + esc(id) + '" tabindex="0" role="button" aria-label="' + esc(Kit.fmtDate(o.e.date) + ': ' + o.e.title + ' (' + ((Kit.layer(o.e.layer) || {}).label || '') + ')') + '">' +
            '<circle cx="' + x + '" cy="' + Ya + '" r="5" fill="' + (has ? col : C.surf) + '" stroke="' + (has ? C.surf : col) + '" stroke-width="2"/>' +
            (has ? '' : '<circle cx="' + x + '" cy="' + Ya + '" r="3.5" fill="none" stroke="' + col + '" stroke-width="1.5"/>') +
            '<circle class="hit" cx="' + x + '" cy="' + Ya + '" r="10" fill="transparent"/></g>';
        });
        pzs.forEach(function (o, i) {
          var id = o.p.id, x = o.x.toFixed(1), ly = Yb + 34 + o.row * 13;
          labels += '<text class="m" data-tl="' + esc(id) + '" x="' + x + '" y="' + (Yb + 20) + '" text-anchor="middle" fill="' + C.text + '">' + esc(id) + '</text>' +
            '<text class="lab sm" data-tl="' + esc(id) + '" x="' + o.tx.toFixed(1) + '" y="' + ly + '" text-anchor="middle" fill="' + C.muted + '" stroke="' + C.surf2 + '">' + esc(o.label) + '</text>';
          var op = PZ_OPACITY[o.p.status] || 0;
          marks += '<g class="ov-tl-pz" data-tl="' + esc(id) + '" tabindex="0" role="button" aria-label="' + esc('#' + (i + 1) + ' on the trail: ' + id + ' ' + o.p.title + ', ' + statusLabel(o.p.status)) + '">' +
            '<rect x="' + (o.x - 6.5).toFixed(1) + '" y="' + (Yb - 6.5) + '" width="13" height="13" rx="3" fill="' + C.acc + '" fill-opacity="' + op + '" stroke="' + C.acc + '" stroke-width="1.5"/>' +
            (o.p.final ? '<rect x="' + (o.x - 9.5).toFixed(1) + '" y="' + (Yb - 9.5) + '" width="19" height="19" rx="5" fill="none" stroke="' + C.acc + '" stroke-width="1"/>' : '') +
            '<rect class="hit" x="' + (o.x - 13).toFixed(1) + '" y="' + (Yb - 13) + '" width="26" height="26" fill="transparent"/></g>';
        });
        groups.forEach(function (g) {
          if (!g.ev || !g.fits) return;
          var cx = (g.x0 + g.x1) / 2, w2 = Math.max(g.w, g.x1 - g.x0) / 2 + 2;
          labels += '<path class="ov-evtick" d="M' + (cx - w2).toFixed(1) + ' ' + (evLabRow - 11) + ' v-3 h' + (2 * w2).toFixed(1) + ' v3" stroke="' + C.strong + '" fill="none"/>' +
            '<text class="ov-evlab" data-tl="' + esc(g.ev) + '" x="' + cx.toFixed(1) + '" y="' + evLabRow + '" text-anchor="middle" fill="' + C.faint + '">' + esc(g.label) + '</text>';
        });
        s += '<g>' + leaders + '</g><g>' + labels + '</g><g>' + marks + '</g>';
        s += '<text x="' + X0 + '" y="' + (H - 8) + '" class="m" fill="' + C.faint + '">TRAIL ORDER · PUZZLES EVENLY SPACED · SQUARE FILL = DESIGN STAGE (HOLLOW = IDEA, SOLID = READY)' + (anyEvLab ? ' · BRACKETS = EVENTS' : '') + '</text>';
        s += '</svg>';
        TLW.innerHTML = s;
        cap.dataset.key = '';
        applyTlHi();
      }
      function discoveryLine() {
        var seq = [];
        TL.order.forEach(function (pid) {
          var evIds = TL.links.filter(function (l) { return l.pz === pid; }).map(function (l) { return Kit.get(l.ev); }).filter(Boolean)
            .sort(function (a, b) { return evYear(a.date) - evYear(b.date); });
          if (evIds.length) seq.push(evIds);
        });
        return seq.map(function (grp) { return grp.map(function (e) { return '<span class="ov-yr layer-' + esc(e.layer) + '" title="' + esc(e.title) + '">' + esc(Kit.year(e.date)) + '</span>'; }).join('<span class="faint">,</span>'); }).join('<span class="ov-arrow">→</span>');
      }
      function applyTlHi() {
        var svg = $('#ov-tl-svg', root); if (!svg) return;
        var cur = S.tlHover || S.tlSticky;
        if (cur && !Kit.has(cur)) { cur = null; S.tlSticky = null; S.tlHover = null; }
        svg.classList.toggle('hi', !!cur);
        var on = new Set();
        if (cur) {
          on.add(cur);
          var ct = Kit.type(cur);
          if (ct === 'entry') TL.links.filter(function (l) { return l.ev === cur; }).forEach(function (l) { on.add(l.pz); });
          else if (ct === 'event') Kit.list('puzzle').filter(function (p) { return p.event === cur; }).forEach(function (p) { on.add(p.id); TL.links.filter(function (l) { return l.pz === p.id; }).forEach(function (l) { on.add(l.ev); }); });
          else TL.links.filter(function (l) { return l.pz === cur; }).forEach(function (l) { on.add(l.ev); });
        }
        $$('[data-tl]', svg).forEach(function (el) {
          el.classList.toggle('on', on.has(el.dataset.tl));
          if (el.hasAttribute('tabindex')) el.setAttribute('aria-pressed', String(S.tlSticky === el.dataset.tl));
        });
        $$('.ov-link', svg).forEach(function (p) { p.classList.toggle('on', !!cur && (on.has(p.dataset.ev) && on.has(p.dataset.pz))); });
        var cap = $('#ov-tl-cap', root);
        var key = (cur || '') + '|' + (S.tlSticky || '') + '|' + TL.links.length + '|' + TL.order.join(',');
        if (cap.dataset.key === key) return;
        cap.dataset.key = key;
        var clear = S.tlSticky ? '<button type="button" class="btn ghost sm" data-act="tl-clear">Clear</button>' : '';
        if (!cur) {
          var bg = Kit.list('entry').filter(function (e) { return Kit.year(e.date) && !TL.links.some(function (l) { return l.ev === e.id; }); }).length;
          cap.innerHTML = TL.links.length ? '<span class="ov-sub">Players meet history in this order</span><span class="ov-seq">' + discoveryLine() + '</span>' +
            '<span class="faint">' + (bg ? plural(bg, 'entry', 'entries') + (bg === 1 ? ' is' : ' are') + ' background only. ' : '') + 'Hover or tap a dot or a puzzle to trace it.</span>'
            : '<span class="faint">No timeline entry says which puzzle reveals it yet. Set “revealed by” on an entry to draw a line.</span>';
          return;
        }
        var ct2 = Kit.type(cur);
        if (ct2 === 'entry') {
          var e = Kit.get(cur), l = TL.links.find(function (x) { return x.ev === cur; });
          var tail = l ? '<span>revealed by</span>' + ref(l.pz) + '<span class="faint">#' + (TL.order.indexOf(l.pz) + 1) + ' of ' + TL.order.length + ' on the trail, ' + esc(chName(Kit.get(l.pz).chapter)) + '</span>'
            : '<span class="faint">background only: no puzzle reveals it</span>';
          cap.innerHTML = Kit.layerBadge(e.layer) + ref(e.id) + '<span class="faint">' + esc(Kit.fmtDate(e.date)) + '</span>' + tail + clear;
        } else if (ct2 === 'event') {
          var evo = Kit.get(cur), pids = Kit.list('puzzle').filter(function (p) { return p.event === cur; }).map(function (p) { return p.id; });
          cap.innerHTML = Kit.layerBadge(evo.layer) + ref(cur) + '<span class="faint">' + esc(chName(evo.chapter)) + '</span>' + (pids.length ? '<span>holds</span>' + refs(pids, { idOnly: true }) : '') + clear;
        } else {
          var p = Kit.get(cur), evIds = TL.links.filter(function (x) { return x.pz === cur; }).map(function (x) { return x.ev; });
          cap.innerHTML = ref(p.id) + '<span class="faint">#' + (TL.order.indexOf(p.id) + 1) + ' on the trail · ' + esc(chName(p.chapter)) + ' · ' + esc(statusLabel(p.status)) + '</span>' +
            (p.event && Kit.has(p.event) ? '<span>in</span>' + ref(p.event) : '') +
            (evIds.length ? '<span>reveals</span>' + refs(evIds) : '<span class="faint">reveals no timeline entries</span>') +
            '<button type="button" class="btn ghost sm" data-go="trail.' + esc(p.id) + '">Open on the trail</button>' + clear;
        }
      }
      listen(TLW, 'pointerover', function (e) {
        if (e.pointerType !== 'mouse') return;
        var g = e.target.closest('[data-tl]'); if (!g) return;
        if (S.tlHover !== g.dataset.tl) { S.tlHover = g.dataset.tl; applyTlHi(); }
      });
      listen(TLW, 'pointerout', function (e) {
        if (e.pointerType !== 'mouse') return;
        var g = e.target.closest('[data-tl]');
        if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) { S.tlHover = null; applyTlHi(); }
      });
      listen(TLW, 'click', function (e) {
        var g = e.target.closest('[data-tl]');
        if (!g) { if (S.tlSticky) { S.tlSticky = null; applyTlHi(); } return; }
        S.tlSticky = S.tlSticky === g.dataset.tl ? null : g.dataset.tl;
        applyTlHi();
      });
      listen(TLW, 'keydown', function (e) {
        var g = e.target.closest && e.target.closest('[data-tl]');
        if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); S.tlSticky = S.tlSticky === g.dataset.tl ? null : g.dataset.tl; applyTlHi(); }
      });
      listen(TLW, 'focusin', function (e) { var g = e.target.closest('[data-tl]'); if (g) { S.tlHover = g.dataset.tl; applyTlHi(); } });
      listen(TLW, 'focusout', function () { S.tlHover = null; applyTlHi(); });

      /* ================= status + render loop ================= */
      function updateStatus() {
        var ps = Kit.list('puzzle'), r = readiness(ps, Kit.list('asset'));
        var open = Kit.list('question').filter(function (q) { return q.status === 'open'; }).length;
        var doing = Kit.list('task').filter(function (t) { return t.status === 'doing'; }).length;
        ctx.setStatus([
          r == null ? 'Nothing to measure yet' : pctNum(r) + '% ready overall',
          plural(Kit.chapters().length, 'chapter') + ' · ' + plural(Kit.list('event').length, 'event') + ' · ' + plural(ps.length, 'puzzle'),
          open ? plural(open, 'open question') : '', doing ? doing + ' tasks in progress' : '',
        ]);
      }
      /* which panels show, given how much the game has in it */
      function layout() {
        var fresh = isFresh();
        root.classList.toggle('ov-fresh', fresh);
        $('#ov-head', root).classList.toggle('ov-head-solo', fresh);
        var show = {
          'ov-ready': !fresh, 'ov-next': !fresh, 'ov-pipe': !fresh && Kit.list('puzzle').length > 0,
          'ov-probs': !fresh || issues().length > 0, 'ov-hist': !fresh, 'ov-assets': !fresh || Kit.list('asset').length > 0,
          'ov-dec': true, 'ov-lib': true,
        };
        Object.keys(show).forEach(function (id) { var el = $('#' + id, root); if (el) el.hidden = !show[id]; });
        /* the readiness / work-on-next pair keeps its widths only when both show */
        $('#ov-dec', root).classList.toggle('ov-wide', fresh);
      }
      var PANELS = [
        ['ov-overall', renderOverall], ['ov-gs', renderGetStarted], ['ov-ready', renderReady], ['ov-next', renderNext], ['ov-pipe', renderKanban],
        ['ov-dec', renderDecisions], ['ov-probs', renderProblems], ['ov-lib', renderLibrary], ['ov-assets', renderAssets], ['ov-hist', renderHistory],
      ];
      var deferred = new Set();
      function isTyping(el) { return el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /^(text|search|url|email|)$/i.test(el.type || ''))); }
      function renderAll() {
        if (dead) return;
        cache = null;
        var ae = document.activeElement;
        var typing = isTyping(ae) && root.contains(ae) ? ae : null;
        /* remember what the user is typing in (value + caret) so a rebuilt panel can give it back */
        var keep = typing && typing.dataset.fkey ? { fkey: typing.dataset.fkey, value: typing.value, a: typing.selectionStart, b: typing.selectionEnd, dir: typing.selectionDirection } : null;
        var fkey = !typing && ae && ae.dataset ? ae.dataset.fkey : null;
        if (S.refocus) { fkey = S.refocus; S.refocus = null; keep = null; typing = null; }
        layout();
        PANELS.forEach(function (pp) {
          var el = $('#' + pp[0], root); if (!el) return;
          /* a field without a key can't be restored: leave its panel alone until the user leaves it */
          if (typing && !keep && el.contains(typing) && !typing.closest('form.ov-add') && !typing.closest('.ov-game')) { deferred.add(pp[0]); return; }
          if (el.hidden && pp[0] !== 'ov-gs') return;
          try { pp[1](); } catch (err) { console.error(err); }
        });
        fillGame(false);
        updateStatus();
        if (keep) {
          var f = root.querySelector('[data-fkey="' + keep.fkey + '"]');
          if (f && f !== document.activeElement) {
            if (f.value !== keep.value) f.value = keep.value;
            try { f.focus({ preventScroll: true }); if (f.setSelectionRange && keep.a != null) f.setSelectionRange(keep.a, keep.b, keep.dir || 'none'); } catch (err) { /* select or no caret */ }
          }
        } else if (fkey) {
          var g = root.querySelector('[data-fkey="' + fkey + '"]');
          if (g && g !== document.activeElement) g.focus({ preventScroll: true });
        }
      }
      listen(root, 'focusout', function () {
        if (!deferred.size) return;
        setTimeout(function () {
          if (dead || !root.isConnected) return;
          var ae = document.activeElement;
          deferred.forEach(function (id) {
            var el = $('#' + id, root); if (!el || el.contains(ae)) return;
            deferred.delete(id);
            var pp = PANELS.find(function (x) { return x[0] === id; }); if (pp) pp[1]();
          });
        }, 0);
      });
      var renderT = null;
      offs.push(Kit.on('change', function (ev) {
        if (dead) return;
        if (ev && ev.kind === 'load') return; /* the shell remounts views when another game opens */
        clearTimeout(renderT); renderT = setTimeout(renderAll, 40);
      }));
      listen(document, 'kit:theme', function () { if (!dead && !$('#ov-hist', root).hidden) renderHistory(); });
      var rzT = null, lastW = window.innerWidth;
      listen(window, 'resize', function () {
        clearTimeout(rzT);
        rzT = setTimeout(function () { if (dead) return; if (window.innerWidth !== lastW || !$('#ov-tl-svg', root)) { lastW = window.innerWidth; if (!$('#ov-hist', root).hidden) renderHistory(); growAll(); } closeMenu(); }, 150);
      });

      /* ================= events ================= */
      listen(root, 'click', function (e) {
        if (e.target.closest('.ov-ghost')) return;
        var a = e.target.closest('[data-act]');
        if (!a) {
          var g = e.target.closest('[data-go]');
          if (g) { if (g.closest('.ov-card') && justDragged) return; ctx.go(g.dataset.go); return; }
          var card = e.target.closest('.ov-card');
          if (card && !justDragged && !e.target.closest('.ref')) ctx.go(card.dataset.pid);
          return;
        }
        var id = a.dataset.id, v = a.dataset.v;
        switch (a.dataset.act) {
          case 'export-game': ctx.openExport({ kind: 'game' }); break;
          case 'export-ch': ctx.openExport({ kind: 'chapter', id: id }); break;
          case 'next-all': S.showAllNext = !S.showAllNext; renderNext(); break;
          case 'ch-filter': S.chapter = v; renderKanban(); break;
          case 'ch-toggle':
            if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
            persistCollapsed(); S.refocus = 'tog-' + id; renderReady();
            { var t = root.querySelector('[data-fkey="tog-' + id + '"]'); if (t) t.focus({ preventScroll: true }); S.refocus = null; }
            break;
          case 'ch-add-event': addEventTo(id); break;
          case 'ev-add-puzzle': addPuzzleTo(id); break;
          case 'add-chapter': { var cid = Kit.create('chapter', { title: 'Chapter ' + (Kit.chapters().length + 1) }); ctx.go(cid); break; }
          case 'add-asset': { var aid = Kit.create('asset', { name: 'New asset' }); Kit.toast('Added ' + aid + '. Name it on its page.'); ctx.go(aid); break; }
          case 'add-entry': { var tid = Kit.create('entry', { title: 'New timeline entry', date: '' }); Kit.toast('Added ' + tid + '. Give it a date and say which puzzle reveals it.'); ctx.go(tid); break; }
          case 'move-menu': openMoveMenu(a, id); break;
          case 'prob-filter': S.prob = v; renderProblems(); break;
          case 'renew': renewAsset(id); S.refocus = a.dataset.fkey; break;
          case 'asset-status': {
            var as = Kit.get(id); if (!as || as.status === v) break;
            var prevSt = as.status;
            S.touchedAssets.add(id); S.refocus = a.dataset.fkey;
            Kit.update(id, { status: v });
            Kit.toast(as.name + ' is now ' + v, { label: 'Undo', run: function () { Kit.update(id, { status: prevSt }); Kit.toast(as.name + ' is back to ' + prevSt); } });
            break;
          }
          case 'resolve-go': case 'resolve': S.resolving = id; S.draft = ''; renderDecisions(); focusResolve(); break;
          case 'resolve-cancel': S.resolving = null; S.draft = ''; renderDecisions(); break;
          case 'resolve-save': {
            var q = Kit.get(id); if (!q) break;
            var ta = $('#ov-res-text', root), txt = (ta ? ta.value : S.draft).trim();
            var before = { status: q.status, resolution: q.resolution || '' };
            S.resolving = null; S.draft = '';
            if (ta) ta.blur();
            Kit.update(id, { status: 'resolved', resolution: txt || 'Resolved without a note.' });
            Kit.toast(id + ' resolved', { label: 'Undo', run: function () { Kit.update(id, before); Kit.toast(id + ' is open again'); } });
            break;
          }
          case 'reopen': {
            var q2 = Kit.get(id); if (!q2) break;
            var res0 = q2.resolution;
            Kit.update(id, { status: 'open' });
            Kit.toast(id + ' reopened', { label: 'Undo', run: function () { Kit.update(id, { status: 'resolved', resolution: res0 }); } });
            break;
          }
          case 'show-resolved': S.showResolved = !S.showResolved; renderDecisions(); break;
          case 'task-start': setTask(id, 'doing'); S.refocus = a.dataset.fkey; break;
          case 'task-pause': setTask(id, 'todo'); S.refocus = a.dataset.fkey; break;
          case 'task-done': setTask(id, 'done'); break;
          case 'tl-clear': S.tlSticky = null; applyTlHi(); break;
          case 'gs-name': {
            var named = DEFAULT_TITLES.indexOf(String(D.game.title || '').trim().toLowerCase()) < 0;
            var field = $(named ? '.ov-premise' : '.ov-title', root);
            $('#ov-head', root).scrollIntoView({ block: 'start', behavior: smooth() });
            field.focus({ preventScroll: true });
            break;
          }
          case 'gs-hide': S.gsHidden = true; persistGs(); renderGetStarted(); Kit.toast('Checklist hidden', { label: 'Undo', run: function () { S.gsHidden = false; persistGs(); renderGetStarted(); } }); break;
          case 'gs-import': ctx.openImport(); break;
          case 'gs-sample':
            /* opening another game emits 'load'; the shell unmounts this view and mounts the sample's */
            /* save pending edits first: opening the sample the first time loads it without flushing */
            if (Kit.storage.pending && Kit.flush) Kit.flush();
            if (Kit.games.openSample()) Kit.toast('Opened the sample game. Your own game is untouched; switch back from the game menu.');
            else Desk.openGameMenu();
            break;
        }
      });
      function focusResolve() {
        var t = $('#ov-res-text', root);
        if (t) { t.scrollIntoView({ block: 'center', behavior: smooth() }); t.focus({ preventScroll: true }); }
      }
      function setTask(id, status) {
        var t = Kit.get(id); if (!t || t.status === status) return;
        var prev = t.status;
        S.touchedTasks.add(id);
        Kit.update(id, { status: status });
        var msg = status === 'done' ? id + ' done: ' + t.title : status === 'doing' ? id + ' started' : id + ' back to to-do';
        Kit.toast(msg, { label: 'Undo', run: function () { Kit.update(id, { status: prev }); } });
      }
      listen(root, 'change', function (e) {
        var cb = e.target.closest('input[data-task]');
        if (cb) { S.refocus = cb.dataset.fkey; setTask(cb.dataset.task, cb.checked ? 'done' : 'todo'); return; }
        var g = e.target.closest('[data-g]');
        if (g) commitGame(g);
      });
      listen(root, 'input', function (e) {
        if (e.target.id === 'ov-res-text') S.draft = e.target.value;
        if (e.target.classList && e.target.classList.contains('ov-grow')) { if (e.target.dataset.line) e.target.value = e.target.value.replace(/\n/g, ' '); grow(e.target); }
      });
      listen(root, 'keydown', function (e) {
        var g = e.target.closest && e.target.closest('[data-g]');
        if (g) {
          if (e.key === 'Enter' && (g.dataset.line || e.ctrlKey || e.metaKey)) { e.preventDefault(); g.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); g.value = g.dataset.g === 'title' && D.game.title === 'Untitled game' ? '' : (D.game[g.dataset.g] || ''); grow(g); g.blur(); }
          return;
        }
        if (e.target.id === 'ov-res-text') {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); var sv = $('[data-act="resolve-save"]', root); if (sv) sv.click(); return; }
          if (e.key === 'Escape') { e.preventDefault(); S.resolving = null; S.draft = ''; renderDecisions(); var rb = root.querySelector('[data-act="resolve"]'); if (rb) rb.focus({ preventScroll: true }); return; }
        }
        var card = e.target.closest && e.target.closest('.ov-card');
        if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.go(card.dataset.pid); }
      });
      listen(root, 'submit', function (e) {
        e.preventDefault();
        var form = e.target;
        if (form.dataset && form.dataset.gs) { gsSubmit(form); return; }
        if (form.id === 'ov-capture') {
          var inp = $('#ov-cap', root);
          if (!inp.value.trim()) { Kit.toast('Type an idea first'); inp.focus(); return; }
          var val = inp.value; inp.value = '';
          captureIdea(val);
        } else if (form.id === 'ov-addtask') {
          var ti = $('#ov-newtask', root), title = ti.value.trim();
          if (!title) { Kit.toast('Type a task first'); ti.focus(); return; }
          ti.value = '';
          var tid = Kit.create('task', { title: title, status: 'todo', links: Kit.textRefs(title) });
          S.touchedTasks.add(tid);
          Kit.toast('Added task ' + tid, { label: 'Undo', run: function () { Kit.remove(tid); Kit.toast('Removed task ' + tid); } });
        }
      });
      /* Esc in the Move menu closes the menu, not the desk (capture runs before the shell's handler) */
      listen(document, 'keydown', function (e) {
        if (e.key !== 'Escape' || !S.menu) return;
        e.preventDefault();  /* the shell ignores a handled Esc, so the desk stays open */
        var b = S.menu.btn; closeMenu(); if (b.isConnected) b.focus();
      }, true);

      /* first paint */
      fillGame(true);
      renderAll();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!dead && root.isConnected) { if (!$('#ov-hist', root).hidden) renderHistory(); growAll(); } });

      return {
        update: function () { /* only one route */ },
        unmount: function () {
          dead = true;
          clearTimeout(renderT); clearTimeout(rzT);
          endDrag(); closeMenu();
          offs.forEach(function (f) { try { f(); } catch (err) { /* ignore */ } });
          offs = [];
        },
        exportScope: function () { return { kind: 'game' }; },
        navToken: function () { return 'overview'; },
      };
    },
  });
})();
