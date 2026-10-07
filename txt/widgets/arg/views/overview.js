/* ============================================================
   ARG DESK — Overview (the planning home screen)
   Game header · readiness by chapter · work on next · pipeline
   kanban · decisions · problems · library at a glance · assets
   and renewals · history vs. trail order.
   All edits go through Kit.update / Kit.create / Kit.updateGame;
   the view re-renders on Kit.on('change').
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
  var ID_RE = /^(P|C|AS|R|Q|T|N|I|CH)\d/;
  var EV_SHORT = {
    'ev-1404': 'Voynich vellum', 'ev-1513': 'Piri Reis map', 'ev-1518': 'Dancing plague', 'ev-1518b': 'Ledger entry I', 'ev-1587': 'Roanoke founded',
    'ev-1590': '“CROATOAN”', 'ev-1750': 'Shepherd’s Monument', 'ev-1872': 'Mary Celeste', 'ev-1884': 'Doyle’s story', 'ev-1889': 'Ida born',
    'ev-1908a': 'Tunguska', 'ev-1908b': 'Phaistos Disc', 'ev-1912': 'Voynich buys MS', 'ev-1912b': 'Ida starts ledger', 'ev-1937': 'Ida vanishes',
    'ev-1948': 'Somerton Man', 'ev-1959': 'Dyatlov Pass', 'ev-1959b': 'Different hand', 'ev-1966': 'Hapgood', 'ev-1977': 'Wow! signal',
    'ev-1991': 'Phantom time', 'ev-2022': 'Somerton named', 'ev-2026': 'Ledger found',
  };
  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  /* ---------------- small helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function plural(n, s, p) { return n + ' ' + (n === 1 ? s : (p || s + 's')); }
  function chip(text, tone, cls) { return '<span class="chip' + (tone ? ' tone-' + tone : '') + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
  function refSmart(id, opts) { return ref(id, opts && opts.idOnly && !ID_RE.test(id) ? {} : opts); }
  function refs(ids, opts) { return (ids || []).filter(function (id) { return Kit.has(id); }).map(function (id) { return refSmart(id, opts); }).join(''); }
  function statusLabel(s) { return Kit.statusLabel(s); }
  function kindLabel(k) { var o = D.puzzleKinds.find(function (x) { return x.id === k; }); return o ? o.label : (k || '—'); }
  function chName(cid) { var c = Kit.chapter(cid); return c ? 'Ch ' + c.n : '—'; }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function sevCounts(list) { var c = { high: 0, med: 0, low: 0 }; list.forEach(function (s) { c[s]++; }); return c; }
  function noSolution(p) { return !p.solution || /^tbd\.?$/i.test(String(p.solution).trim()); }
  function reduceMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function readiness(puzzles, assets) {
    var s = 0, w = 0;
    puzzles.forEach(function (p) { s += 2 * (PZ_SCORE[p.status] || 0); w += 2; });
    assets.forEach(function (a) { s += AS_SCORE[a.status] || 0; w += 1; });
    return w ? s / w : 0;
  }
  function pct(x) { return Math.round(x * 100); }
  function textW(str, font) {
    var c = textW.c || (textW.c = document.createElement('canvas').getContext('2d'));
    c.font = font; return c.measureText(str).width;
  }
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

  /* where you go to fix a problem */
  function fixTarget(kind, ids) {
    var first = ids[0], pid = ids.filter(function (x) { return Kit.type(x) === 'puzzle'; })[0];
    switch (kind) {
      case 'Recipe': case 'No solution': case 'No solve path': case 'Design checks':
        return pid ? { go: 'crafter.' + pid, where: 'Crafter · ' + pid } : { go: first, where: first };
      case 'Broken link': case 'Order': case 'Dead end':
        return pid ? { go: 'trail.' + pid, where: 'Trail · ' + pid } : { go: 'trail', where: 'Trail' };
      case 'Variety':
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
      var S = {
        chapter: 'all', prob: 'all', showAllNext: false,
        resolving: null, draft: '', showResolved: false,
        touchedTasks: new Set(), touchedAssets: new Set(),
        tlHover: null, tlSticky: null, flash: null, menu: null,
      };
      var offs = [];
      function listen(target, type, fn, opts) { target.addEventListener(type, fn, opts); offs.push(function () { target.removeEventListener(type, fn, opts); }); }
      var cache = null;
      function issues() { if (!cache) cache = Kit.integrity(); return cache; }

      /* ---------------- skeleton ---------------- */
      root.innerHTML =
        '<div class="ov-scroll" id="ov-scroll"><div class="ov-grid">' +
        /* 1. header */
        '<section class="ov-panel ov-s12 ov-head" aria-label="The game">' +
          '<div class="ov-game">' +
            '<div class="ov-game-top"><span class="eyebrow">The game</span><span class="ov-hint">Click any line to edit it</span><span class="ov-saved" id="ov-saved" aria-live="polite"></span></div>' +
            '<textarea class="ov-in ov-grow ov-title" data-g="title" data-line="1" rows="1" aria-label="Game title" spellcheck="false"></textarea>' +
            '<textarea class="ov-in ov-grow ov-tagline" data-g="tagline" data-line="1" rows="1" aria-label="Tagline"></textarea>' +
            '<textarea class="ov-in ov-grow ov-premise" data-g="premise" rows="3" aria-label="Premise"></textarea>' +
            '<div class="ov-meta">' +
              '<label class="ov-meta-l" for="ov-g-format">Format</label><textarea class="ov-in ov-grow ov-meta-in" id="ov-g-format" data-g="format" data-line="1" rows="1"></textarea>' +
              '<label class="ov-meta-l" for="ov-g-players">Players</label><textarea class="ov-in ov-grow ov-meta-in" id="ov-g-players" data-g="players" data-line="1" rows="1"></textarea>' +
            '</div>' +
          '</div>' +
          '<div class="ov-overall" id="ov-overall"></div>' +
        '</section>' +
        /* 2. readiness by chapter */
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
          '<div class="ov-plw"><ul class="ov-pl" id="ov-probs-b"></ul></div>' +
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
          '<div class="ov-as">' +
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
          el.value = D.game[el.dataset.g] || '';
        });
        growPremise();
      }
      function growPremise() { $$('.ov-grow', root).forEach(grow); }
      function grow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
      function commitGame(el) {
        var k = el.dataset.g, v = el.value.trim();
        if (k === 'title' && !v) { el.value = D.game.title; return; }
        if ((D.game[k] || '') === v) return;
        var prev = D.game[k], patch = {}; patch[k] = v;
        Kit.updateGame(patch);
        var lab = { title: 'title', tagline: 'tagline', premise: 'premise', format: 'format', players: 'players' }[k];
        Kit.toast('Saved the ' + lab, { label: 'Undo', run: function () { var p2 = {}; p2[k] = prev; Kit.updateGame(p2); fillGame(true); Kit.toast('Put the old ' + lab + ' back'); } });
      }

      function renderOverall() {
        var ps = Kit.list('puzzle'), as = Kit.list('asset');
        var r = readiness(ps, as);
        var pc = {}; D.statuses.forEach(function (s) { pc[s.id] = 0; }); ps.forEach(function (p) { pc[p.status] = (pc[p.status] || 0) + 1; });
        var ac = {}; AS_STATUSES.forEach(function (s) { ac[s[0]] = 0; }); as.forEach(function (a) { ac[a.status] = (ac[a.status] || 0) + 1; });
        var dist = function (counts, list, cls) {
          return '<span class="ov-dist" aria-hidden="true">' + list.filter(function (s) { return counts[s[0]]; }).map(function (s) { return '<i class="' + cls + '-' + s[0] + '" style="flex:' + counts[s[0]] + '"></i>'; }).join('') + '</span>' +
            '<span class="ov-dist-k">' + list.map(function (s) { return '<span class="' + (counts[s[0]] ? '' : 'z') + '"><i class="' + cls + '-' + s[0] + '"></i>' + counts[s[0]] + ' ' + s[1].toLowerCase() + '</span>'; }).join('') + '</span>';
        };
        var pList = D.statuses.map(function (s) { return [s.id, s.label]; });
        var pDone = ps.filter(function (p) { return Kit.statusIndex(p.status) >= 2; }).length;
        var aDone = as.filter(function (a) { return a.status === 'ready' || a.status === 'placed'; }).length;
        $('#ov-overall', root).innerHTML =
          '<div class="ov-ov-top"><div><span class="eyebrow">Overall readiness</span>' +
            '<div class="ov-big">' + pct(r) + '<span>%</span></div></div>' +
            '<div class="ov-ov-acts"><button type="button" class="btn sm" data-act="export-game">' + Kit.ICONS.exportIcon + 'Export whole game for an LLM</button></div></div>' +
          '<div class="ov-bar" role="img" aria-label="' + pct(r) + '% ready"><i style="width:' + pct(r) + '%"></i></div>' +
          '<div class="ov-dist-row"><span class="ov-dist-l">Puzzles <b>' + pDone + '/' + ps.length + '</b> built+</span>' + dist(pc, pList, 'st') + '</div>' +
          '<div class="ov-dist-row"><span class="ov-dist-l">Assets <b>' + aDone + '/' + as.length + '</b> ready</span>' + dist(ac, AS_STATUSES, 'as') + '</div>' +
          '<p class="ov-howto">Puzzles count double: Idea 0 · Draft 25 · Built 50 · Tested 75 · Ready 100%. Assets: Idea 0 · Making 50 · Ready 100%.</p>';
      }

      /* ================= 2. readiness by chapter ================= */
      function segPz(p) {
        return '<button type="button" class="ov-seg st-' + p.status + '" data-go="' + p.id + '" data-ref="' + p.id + '" aria-label="' + esc(p.id + ' ' + p.title + ': ' + statusLabel(p.status)) + '">' + p.id + '</button>';
      }
      function segAs(a) {
        return '<button type="button" class="ov-seg as-' + a.status + '" data-go="' + a.id + '" data-ref="' + a.id + '" aria-label="' + esc(a.id + ' ' + a.name + ': ' + a.status) + '">' + a.id + '</button>';
      }
      function renderReady() {
        var order = Kit.puzzleOrder();
        var rank = {}; order.forEach(function (p, i) { rank[p.id] = i; });
        var iss = issues();
        $('#ov-ready-key', root).innerHTML =
          '<span class="ov-key-l">Puzzles</span>' + D.statuses.map(function (s) { return '<span><i class="st-' + s.id + '"></i>' + esc(s.label) + '</span>'; }).join('') +
          '<span class="ov-key-l">Assets</span>' + AS_STATUSES.map(function (s) { return '<span><i class="as-' + s[0] + '"></i>' + s[1] + '</span>'; }).join('');
        var chs = Kit.chapters();
        var rows = chs.map(function (ch) {
          var ps = Kit.puzzlesIn(ch.id).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
          var as = Kit.list('asset').filter(function (a) { return a.chapter === ch.id; });
          var r = readiness(ps, as);
          var ids = new Set([ch.id].concat(ps.map(function (p) { return p.id; }), as.map(function (a) { return a.id; })));
          var chIss = iss.filter(function (i) { return i.ids.some(function (x) { return ids.has(x); }); });
          var high = chIss.filter(function (i) { return i.severity === 'high'; }).length;
          var go = ps.length ? 'trail.' + ps[0].id : 'trail';
          return '<div class="ov-ch">' +
            '<div class="ov-ch-top">' +
              '<button type="button" class="ov-ch-name" data-go="' + go + '" title="Open chapter ' + ch.n + ' on the trail">' + Kit.idChip(ch.id) + '<span>' + esc(ch.title) + '</span>' + CHEV + '</button>' +
              '<span class="ov-ch-meta">' + plural(ps.length, 'puzzle') + ' · ' + plural(as.length, 'asset') +
                (chIss.length ? ' · <span class="' + (high ? 'ov-hi' : '') + '">' + plural(chIss.length, 'problem') + '</span>' : '') + '</span>' +
              '<span class="ov-ch-pct">' + pct(r) + '%</span>' +
              '<button type="button" class="ov-mini" data-act="export-ch" data-id="' + ch.id + '" title="Export chapter ' + ch.n + ' for an LLM">Export</button>' +
            '</div>' +
            '<div class="ov-ch-bar" role="img" aria-label="Chapter ' + ch.n + ' ' + pct(r) + '% ready"><i style="width:' + pct(r) + '%"></i></div>' +
            '<div class="ov-ch-rows">' +
              '<span class="ov-rl">Puzzles</span><div class="ov-mtr">' + (ps.length ? ps.map(segPz).join('') : '<span class="faint">none yet</span>') + '</div>' +
              '<span class="ov-rl">Assets</span><div class="ov-mtr">' + (as.length ? as.map(segAs).join('') : '<span class="faint">none yet</span>') + '</div>' +
            '</div></div>';
        });
        var loose = Kit.list('puzzle').filter(function (p) { return !Kit.chapter(p.chapter); });
        if (loose.length) rows.push('<div class="ov-ch"><div class="ov-ch-top"><span class="ov-ch-name">No chapter</span><span class="ov-ch-meta">' + plural(loose.length, 'puzzle') + ' not in any chapter</span></div><div class="ov-ch-rows"><span class="ov-rl">Puzzles</span><div class="ov-mtr">' + loose.map(segPz).join('') + '</div></div></div>');
        $('#ov-ready-b', root).innerHTML = rows.join('');
      }

      /* ================= 3. work on next ================= */
      function workItems() {
        var out = [], seen = new Set();
        function add(key, it) { if (seen.has(key)) return; seen.add(key); out.push(it); }
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
        Kit.list('research').forEach(function (r) {
          var deps = (r.supports || []).filter(function (x) { return Kit.type(x) === 'puzzle'; });
          if (r.status !== 'verified' && deps.length)
            add('r:' + r.id, { sev: 'med', kind: 'Verify research', text: r.id + ' ' + r.title + ' is “' + r.status + '”, and ' + deps.join(', ') + (deps.length === 1 ? ' depends' : ' depend') + ' on it.', go: r.id, where: 'Research · ' + r.id });
        });
        Kit.list('task').filter(function (t) { return t.status === 'doing'; }).forEach(function (t) {
          add('t:' + t.id, { sev: 'low', kind: 'In progress', text: t.title, go: t.id, where: 'Task · ' + t.id, quick: { act: 'task-done', id: t.id, label: 'Mark done' } });
        });
        return out;
      }
      function renderNext() {
        var items = workItems(), LIMIT = 7;
        var shown = S.showAllNext ? items : items.slice(0, LIMIT);
        $('#ov-next-n', root).textContent = items.length ? String(items.length) : '';
        $('#ov-next-b', root).innerHTML = !items.length ? '<p class="ov-empty">Nothing urgent. Pick a puzzle in Draft and push it to Built.</p>' :
          '<ol class="ov-nx">' + shown.map(function (it, i) {
            return '<li class="ov-nx-i"><span class="ov-nx-n">' + (i + 1) + '</span><span class="ov-bar-s ' + it.sev + '" aria-hidden="true"></span>' +
              '<button type="button" class="ov-nx-main" data-go="' + esc(it.go) + '"><span class="ov-nx-k"><span>' + esc(it.kind) + '</span><span class="ov-nx-w">' + CHEV + esc(it.where) + '</span></span><span class="ov-nx-t">' + esc(it.text) + '</span></button>' +
              (it.quick ? '<button type="button" class="btn sm ov-nx-q" data-act="' + it.quick.act + '" data-id="' + it.quick.id + '" data-fkey="nxq-' + it.quick.id + '">' + esc(it.quick.label) + '</button>' : '') +
              '</li>';
          }).join('') + '</ol>' +
          (items.length > LIMIT ? '<button type="button" class="btn ghost sm" data-act="next-all">' + (S.showAllNext ? 'Show the top ' + LIMIT : 'Show all ' + items.length) + '</button>' : '');
      }

      /* ================= 4. pipeline kanban ================= */
      function layerMix(p) {
        var c = { record: 0, pseudo: 0, fiction: 0 };
        [].concat(p.inputs || [], p.mysteries || [], p.reveals || []).forEach(function (id) { var l = Kit.layerOf(id); if (l && c[l] != null) c[l]++; });
        return c;
      }
      function puzzleFlags(p) {
        var f = [], si = Kit.statusIndex(p.status);
        var unpl = (p.inputs || []).filter(function (cid) { var c = Kit.get(cid); return c && !c.plantedIn; });
        if (unpl.length) f.push({ cls: 'bad', text: 'Unplanted ' + unpl.join(', '), title: 'Clue ' + unpl.join(', ') + ' is not carried by any asset yet' });
        if (si >= 1 && noSolution(p)) f.push({ cls: 'warn', text: 'No solution', title: 'Past Idea, but the solution is not written down' });
        if (si >= 2 && !(p.solvePath || []).length) f.push({ cls: 'warn', text: 'No solve path', title: 'Built, but there is no step-by-step solve path' });
        if (p.recipe && p.recipe.steps && p.recipe.steps.length && !Kit.checkRecipe(p.recipe).ok) f.push({ cls: 'bad', text: 'Recipe broken', title: 'The cipher recipe does not round-trip' });
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
        var si = Kit.statusIndex(p.status);
        var stats = ['<span>' + esc(Kit.fmtMinutes(p.estMin)) + '</span>'];
        if (si >= 2) stats.push('<span class="' + ((p.checks || []).length < D.designChecks.length ? 'warn' : '') + '" title="Design checks passed">checks ' + (p.checks || []).length + '/' + D.designChecks.length + '</span>');
        if ((p.hints || []).length) stats.push('<span title="Hints are rare">' + plural(p.hints.length, 'hint') + '</span>');
        if (p.final) stats.push('<span class="ov-final">finale</span>');
        var flags = puzzleFlags(p).map(function (f) { return '<span class="ov-flag ' + f.cls + '" title="' + esc(f.title) + '">' + esc(f.text) + '</span>'; }).join('');
        return '<article class="ov-card' + (S.flash === p.id ? ' flash' : '') + '" data-pid="' + p.id + '" tabindex="0" aria-label="' + esc(p.id + ' ' + p.title + ', ' + statusLabel(p.status) + '. Press Enter to open.') + '">' +
          '<span class="ov-stripe" title="Layer mix: ' + esc(mixTitle) + '">' + stripe + '</span>' +
          '<div class="ov-card-top">' + Kit.idChip(p.id) + '<span class="chip ov-chchip">' + esc(chName(p.chapter)) + '</span><span class="ov-kind">' + esc(kindLabel(p.kind)) + '</span>' + Kit.diff(p.difficulty || 0) + '</div>' +
          '<button type="button" class="ov-card-title" data-go="' + p.id + '" tabindex="-1">' + esc(p.title) + '</button>' +
          '<div class="ov-card-foot"><span class="ov-card-stats">' + stats.join('') + '</span>' + flags +
          '<button type="button" class="ov-move" data-act="move-menu" data-id="' + p.id + '" data-fkey="move-' + p.id + '" aria-haspopup="menu" aria-expanded="false" aria-label="Move ' + p.id + ' to another stage">Move ▾</button></div>' +
          '</article>';
      }
      function renderKanban() {
        closeMenu();
        var opts = [['all', 'All', Kit.list('puzzle').length]].concat(Kit.chapters().map(function (c) { return [c.id, 'Ch ' + c.n, Kit.puzzlesIn(c.id).length]; }));
        if (S.chapter !== 'all' && !Kit.chapter(S.chapter)) S.chapter = 'all';
        $('#ov-ch-seg', root).innerHTML = opts.map(function (o) {
          return '<button type="button" data-act="ch-filter" data-v="' + o[0] + '" aria-pressed="' + (S.chapter === o[0]) + '" title="' + esc(o[0] === 'all' ? 'All chapters' : (Kit.chapter(o[0]) || {}).title || '') + '">' + esc(o[1]) + '<span class="ov-n">' + o[2] + '</span></button>';
        }).join('');
        var rank = {}; Kit.puzzleOrder().forEach(function (p, i) { rank[p.id] = i; });
        var ps = Kit.list('puzzle').filter(function (p) { return S.chapter === 'all' || p.chapter === S.chapter; }).sort(function (a, b) { return rank[a.id] - rank[b.id]; });
        var flagged = ps.filter(function (p) { return puzzleFlags(p).some(function (f) { return f.cls !== 'real'; }); }).length;
        $('#ov-pipe-n', root).textContent = plural(ps.length, 'puzzle') + ' · ' + flagged + ' flagged';
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
        }).join('') + '<hr><button type="button" role="menuitem" data-open="trail.' + pid + '">Open on the trail</button><button type="button" role="menuitem" data-open="crafter.' + pid + '">Open in the crafter</button>';
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
          moveCard(pid, b.dataset.v);
          S.refocus = 'move-' + pid;
        });
        m.addEventListener('keydown', function (e) {
          var items = $$('button:not(:disabled)', m), i = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
          else if (e.key === 'Escape') { closeMenu(); btn.focus(); e.stopPropagation(); e.preventDefault(); }
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
        $('#ov-prob-n', root).textContent = String(all.length);
        $('#ov-prob-seg', root).innerHTML = [['all', 'All', all.length], ['high', 'High', c.high], ['med', 'Med', c.med], ['low', 'Low', c.low]].map(function (o) {
          return '<button type="button" data-act="prob-filter" data-v="' + o[0] + '" aria-pressed="' + (S.prob === o[0]) + '">' + o[1] + '<span class="ov-n">' + o[2] + '</span></button>';
        }).join('');
        var list = S.prob === 'all' ? all : all.filter(function (i) { return i.severity === S.prob; });
        $('#ov-probs-b', root).innerHTML = list.length ? list.map(function (i) {
          var t = fixTarget(i.kind, i.ids);
          return '<li><span class="ov-bar-s ' + i.severity + '" aria-hidden="true"></span><div>' +
            '<div class="ov-pl-k"><span class="sev sev-' + i.severity + '">' + i.severity + '</span><span>' + esc(i.kind) + '</span>' +
            (t.go ? '<button type="button" class="ov-mini ov-fix" data-go="' + esc(t.go) + '">Fix' + CHEV + '</button>' : '') + '</div>' +
            '<div class="ov-pl-t">' + esc(i.text) + '</div><div class="ov-refs">' + refs(i.ids, { idOnly: true }) + '</div></div></li>';
        }).join('') : '<li class="ov-empty">No problems at this severity.</li>';
      }

      /* ================= 6. decisions ================= */
      function age(d) { var n = -Kit.daysUntil(d); return n == null || isNaN(n) ? '' : n <= 0 ? 'raised today' : n === 1 ? 'raised yesterday' : 'open ' + n + ' days'; }
      function renderDecisions() {
        var qs = Kit.list('question'), open = qs.filter(function (q) { return q.status === 'open'; }).sort(function (a, b) { return SEV[a.severity] - SEV[b.severity] || String(a.created).localeCompare(String(b.created)); });
        var resolved = qs.filter(function (q) { return q.status !== 'open'; });
        var tasks = Kit.list('task').filter(function (t) { return t.status !== 'done' || S.touchedTasks.has(t.id); })
          .sort(function (a, b) { var r = { doing: 0, todo: 1, done: 2 }; return r[a.status] - r[b.status] || (a.id < b.id ? -1 : 1); });
        var oc = sevCounts(open.map(function (q) { return q.severity; }));
        $('#ov-dec-n', root).textContent = open.length + ' open · ' + oc.high + ' high · ' + tasks.filter(function (t) { return t.status !== 'done'; }).length + ' tasks';
        var qItem = function (q) {
          var isOpen = q.status === 'open';
          return '<div class="ov-q' + (isOpen ? '' : ' resolved') + '" data-q="' + q.id + '">' +
            '<div class="ov-q-top"><span class="sev sev-' + q.severity + '">' + q.severity + '</span>' + Kit.idChip(q.id) + chip(q.kind) +
            '<span class="ov-q-age">' + esc(isOpen ? age(q.created) : 'resolved') + '</span>' +
            (isOpen ? (S.resolving !== q.id ? '<button type="button" class="btn sm" data-act="resolve" data-id="' + q.id + '" data-fkey="resolve-' + q.id + '">Resolve</button>' : '')
              : '<button type="button" class="btn sm ghost" data-act="reopen" data-id="' + q.id + '" data-fkey="reopen-' + q.id + '">Reopen</button>') + '</div>' +
            '<p class="ov-q-text">' + esc(q.text) + '</p><div class="ov-refs">' + refs(q.links) + '</div>' +
            (!isOpen && q.resolution ? '<p class="ov-q-res">' + esc(q.resolution) + '</p>' : '') +
            (S.resolving === q.id ? '<div class="ov-resolve"><label class="ov-sub" for="ov-res-text">How did you decide?</label>' +
              '<textarea id="ov-res-text" class="input" rows="3" placeholder="e.g. Use our own copy at a friendly bookshop; it can stay put for years.">' + esc(S.draft) + '</textarea>' +
              '<div class="ov-row-end"><button type="button" class="btn sm ghost" data-act="resolve-cancel">Cancel</button><button type="button" class="btn sm primary" data-act="resolve-save" data-id="' + q.id + '">Save decision</button></div></div>' : '') +
            '</div>';
        };
        $('#ov-qs', root).innerHTML = (open.length ? open.map(qItem).join('') : '<p class="ov-empty">No open questions.</p>') +
          (resolved.length ? '<button type="button" class="btn ghost sm ov-more" data-act="show-resolved">' + (S.showResolved ? 'Hide' : 'Show') + ' ' + resolved.length + ' resolved</button>' + (S.showResolved ? resolved.map(qItem).join('') : '') : '');
        $('#ov-tasks', root).innerHTML = tasks.length ? tasks.map(function (t) {
          var done = t.status === 'done';
          return '<div class="ov-task' + (done ? ' done' : '') + '"><input type="checkbox" id="ov-tk-' + t.id + '" data-task="' + t.id + '" data-fkey="task-' + t.id + '"' + (done ? ' checked' : '') + '>' +
            '<label for="ov-tk-' + t.id + '">' + esc(t.title) + '</label>' +
            (t.status === 'doing' ? '<button type="button" class="chip tone-blue ov-doing" data-act="task-pause" data-id="' + t.id + '" data-fkey="tstat-' + t.id + '" title="In progress. Click to set back to to-do.">doing</button>'
              : done ? '' : '<button type="button" class="ov-mini" data-act="task-start" data-id="' + t.id + '" data-fkey="tstat-' + t.id + '">Start</button>') +
            '<div class="ov-task-refs">' + Kit.idChip(t.id) + refs(t.links, { idOnly: true }) + '</div></div>';
        }).join('') : '<p class="ov-empty">No open tasks.</p>';
      }

      /* ================= 7. library ================= */
      function renderLibrary() {
        var ideas = Kit.list('idea').filter(function (i) { return i.status === 'raw'; })
          .sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')) || (b.id < a.id ? -1 : 1); }).slice(0, 4);
        var res = Kit.list('research');
        var toRead = res.filter(function (r) { return r.status === 'to read'; });
        var unv = res.filter(function (r) { return r.status !== 'verified' && (r.supports || []).some(function (x) { return Kit.type(x) === 'puzzle'; }); });
        $('#ov-lib-b', root).innerHTML =
          '<div class="ov-sub">Newest raw ideas</div>' +
          (ideas.length ? '<ul class="ov-ideas">' + ideas.map(function (i) {
            return '<li><button type="button" class="ov-idea" data-go="' + i.id + '"><span class="ov-idea-t">' + esc(i.text || i.url || '(empty idea)') + '</span>' +
              '<span class="ov-idea-m">' + Kit.idChip(i.id) + (i.created ? '<span>' + esc(Kit.fmtDate(i.created, { noYear: true })) + '</span>' : '') +
              (i.url ? '<span class="ov-dom">' + esc(Kit.domain(i.url)) + '</span>' : '') +
              (i.tags || []).map(function (t) { return '<span class="ov-tag">#' + esc(t) + '</span>'; }).join('') + '</span></button></li>';
          }).join('') + '</ul>' : '<p class="ov-empty">No raw ideas. Capture one above.</p>') +
          '<div class="ov-sub">Research</div>' +
          '<div class="ov-lib-stats">' +
            '<button type="button" class="ov-stat" data-go="research"><b>' + toRead.length + '</b><span>to read</span></button>' +
            '<button type="button" class="ov-stat" data-go="research"><b>' + res.filter(function (r) { return r.status === 'verified'; }).length + '</b><span>verified of ' + res.length + '</span></button>' +
            '<button type="button" class="ov-stat' + (unv.length ? ' warn' : '') + '" data-go="research"><b>' + unv.length + '</b><span>puzzles lean on, unverified</span></button>' +
          '</div>' +
          (unv.length ? '<div class="ov-refs ov-unv">' + unv.map(function (r) { return ref(r.id); }).join('') + '</div>' : '');
      }
      function captureIdea(raw) {
        var text = String(raw || '').trim(); if (!text) return null;
        var url = null, m = text.match(/https?:\/\/\S+/);
        if (m) { url = m[0].replace(/[),.]+$/, ''); var rest = text.replace(m[0], '').trim(); text = rest || url; }
        /* #P08 (an existing id) becomes a link; any other #word becomes a tag */
        var tags = [], links = [];
        text.replace(/(^|\s)#([\w-]+)/g, function (all, sp, w) {
          if (Kit.has(w)) { if (links.indexOf(w) < 0) links.push(w); }
          else { var t = w.toLowerCase(); if (tags.indexOf(t) < 0) tags.push(t); }
          return all;
        });
        /* a trailing run of #words is metadata: drop it; inline ones keep their word */
        var body = text.replace(/(\s+#[\w-]+)+\s*$/, '').replace(/(^|\s)#([\w-]+)/g, '$1$2').trim();
        text = body || text.replace(/#/g, '').trim();
        var id = Kit.create('idea', { text: text, url: url, tags: tags, links: links, status: 'raw', created: D.game.today });
        Kit.toast('Saved idea ' + id + (tags.length ? ' with #' + tags.join(' #') : ''), { label: 'Undo', run: function () { Kit.remove(id); Kit.toast('Removed idea ' + id); } });
        return id;
      }

      /* ================= 9. assets ================= */
      function renewTone(n) { return n <= 30 ? 'error' : n <= 45 ? 'amber' : null; }
      function renderAssets() {
        var all = Kit.list('asset');
        var make = all.filter(function (a) { return a.status === 'idea' || a.status === 'making' || S.touchedAssets.has(a.id); })
          .sort(function (a, b) { var o = { making: 0, idea: 1, ready: 2, placed: 3 }; return o[a.status] - o[b.status] || ((Kit.chapter(a.chapter) || {}).n || 0) - ((Kit.chapter(b.chapter) || {}).n || 0); });
        var ren = all.filter(function (a) { return a.renews; }).sort(function (a, b) { return a.renews < b.renews ? -1 : 1; });
        var toMake = all.filter(function (a) { return a.status === 'idea' || a.status === 'making'; }).length;
        $('#ov-as-n', root).textContent = toMake + ' to make · ' + ren.length + ' to keep renewed';
        $('#ov-make', root).innerHTML = make.length ? make.map(function (a) {
          return '<div class="ov-mk" data-asset="' + a.id + '"><div class="ov-mk-main">' +
            '<button type="button" class="ov-mk-name" data-go="' + a.id + '">' + esc(a.name) + '</button>' + Kit.idChip(a.id) +
            '<div class="ov-mk-sub"><span class="ov-akind">' + esc(a.kind) + '</span><span>' + esc(chName(a.chapter)) + '</span>' +
            ((a.carries || []).length ? '<span>' + plural(a.carries.length, 'clue') + '</span>' : '') +
            (a.persona && Kit.has(a.persona) ? ref(a.persona) : '') + '</div></div>' +
            '<div class="seg ov-as-seg" role="group" aria-label="Status of ' + esc(a.name) + '">' + AS_STATUSES.map(function (s) {
              return '<button type="button" data-act="asset-status" data-id="' + a.id + '" data-v="' + s[0] + '" data-fkey="ast-' + a.id + '-' + s[0] + '" aria-pressed="' + (a.status === s[0]) + '">' + s[1] + '</button>';
            }).join('') + '</div></div>';
        }).join('') : '<p class="ov-empty">Everything is made. Nice.</p>';
        $('#ov-renew', root).innerHTML = ren.length ? ren.map(function (a) {
          var n = Kit.daysUntil(a.renews), tone = renewTone(n);
          return '<div class="ov-rn" data-asset="' + a.id + '"><div class="ov-rn-main"><button type="button" class="ov-mk-name" data-go="' + a.id + '">' + esc(a.name) + '</button>' +
            '<div class="ov-mk-sub"><span class="ov-akind">' + esc(a.kind) + '</span><span>' + esc(a.cost || 'no cost noted') + '</span></div></div>' +
            '<div class="ov-rn-date"><span>' + esc(Kit.fmtDate(a.renews)) + '</span>' + (tone ? chip(plural(n, 'day') + ' left', tone) : '<span class="faint">' + esc(Kit.relDays(a.renews)) + '</span>') + '</div>' +
            '<button type="button" class="btn sm" data-act="renew" data-id="' + a.id + '" data-fkey="renew-' + a.id + '">Mark renewed</button></div>';
        }).join('') : '<p class="ov-empty">Nothing needs renewing.</p>';
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
      function evShort(e) { return (Kit.year(e.date) || '?') + ' ' + (EV_SHORT[e.id] || (e.title.length > 20 ? e.title.slice(0, 19) + '…' : e.title)); }
      function renderHistory() {
        if (!TLW.isConnected) return;
        var W = Math.max(TLW.clientWidth || 0, 1000);
        var C = { text: Kit.cssVar('--text'), muted: Kit.cssVar('--text-muted'), faint: Kit.cssVar('--text-faint'), border: Kit.cssVar('--border'),
          strong: Kit.cssVar('--border-strong'), acc: Kit.cssVar('--accent'), surf: Kit.cssVar('--surface'), surf2: Kit.cssVar('--surface-2') };
        var LC = {}; LAYERS.forEach(function (l) { LC[l] = Kit.cssVar(LAYER_VAR[l]); });
        var bodyFont = getComputedStyle(document.body).fontFamily;
        var X0 = 24, X1 = W - 24;
        var BRK = [[1400, 0], [1700, 0.19], [1860, 0.3], [2030, 1]];
        var xh = function (yr) {
          for (var i = 1; i < BRK.length; i++) if (yr <= BRK[i][0]) {
            var a = BRK[i - 1], b = BRK[i];
            return X0 + (a[1] + (Math.max(yr, 1400) - a[0]) / (b[0] - a[0]) * (b[1] - a[1])) * (X1 - X0);
          }
          return X1;
        };
        /* puzzles in trail order, grouped by chapter */
        var order = Kit.puzzleOrder(); TL.order = order.map(function (p) { return p.id; });
        var GAP = 0.9, pos = 0, prev = null;
        order.forEach(function (p) { if (prev !== null && p.chapter !== prev) pos += GAP; p.__pos = pos; pos += 1; prev = p.chapter; });
        var span = Math.max(1, pos - 1), PX0 = X0 + 34, PX1 = X1 - 34;
        var px = function (p) { return PX0 + (p.__pos / span) * (PX1 - PX0); };
        var events = Kit.list('event').filter(function (e) { return e.date; });
        var links = []; events.forEach(function (e) { if (e.revealedBy && Kit.type(e.revealedBy) === 'puzzle') links.push({ ev: e.id, pz: e.revealedBy }); });
        TL.links = links;
        var linked = new Set(links.map(function (l) { return l.ev; }));
        var evs = events.map(function (e) { return { e: e, x: xh(evYear(e.date)), label: evShort(e) }; }).sort(function (a, b) { return a.x - b.x; });
        evs.forEach(function (o) { o.w = textW(o.label, '10.5px ' + bodyFont); });
        var R1 = placeLabels(evs, 6, X0, X1);
        var Ya = 34 + R1 * 15 + 14, Yb = Ya + 170;
        var pzs = order.map(function (p) {
          var t = p.title.length > 18 ? p.title.slice(0, 17) + '…' : p.title;
          return { p: p, x: px(p), label: t, center: true };
        });
        pzs.forEach(function (o) { o.w = textW(o.label, '10px ' + bodyFont); });
        var R2 = placeLabels(pzs, 2, X0, X1, 6);
        var H = Yb + 46 + R2 * 13 + 44;
        /* chapter bands (contiguous runs) */
        var bands = [], cur = null, half = (PX1 - PX0) / span / 2;
        pzs.forEach(function (o) {
          if (!cur || cur.ch !== o.p.chapter) { cur = { ch: o.p.chapter, x0: o.x, x1: o.x }; bands.push(cur); } else cur.x1 = o.x;
        });
        var s = '<svg class="ov-tl-svg" id="ov-tl-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="In-world history above; puzzles in trail order below; lines show which puzzle reveals which event">';
        s += '<text x="' + X0 + '" y="16" class="m" fill="' + C.faint + '">IN-WORLD HISTORY · 1400 → 2026</text>';
        s += '<text x="' + X1 + '" y="16" text-anchor="end" class="m" fill="' + C.faint + '">● REVEALED ON THE TRAIL   ○ BACKGROUND ONLY   // SCALE CHANGES</text>';
        s += '<line x1="' + X0 + '" x2="' + X1 + '" y1="' + Ya + '" y2="' + Ya + '" stroke="' + C.strong + '"/>';
        [1400, 1500, 1600, 1700, 1800, 1860, 1880, 1900, 1920, 1940, 1960, 1980, 2000, 2026].forEach(function (y) {
          var x = xh(y), brk = y === 1700 || y === 1860;
          s += '<line x1="' + x + '" x2="' + x + '" y1="' + Ya + '" y2="' + (Ya + (brk ? 7 : 4)) + '" stroke="' + C.strong + '"/>' +
            '<text x="' + x + '" y="' + (Ya + 17) + '" text-anchor="middle" class="m" fill="' + C.faint + '">' + y + '</text>';
        });
        [1700, 1860].forEach(function (y) { var x = xh(y); s += '<path d="M' + (x - 4) + ' ' + (Ya - 4) + ' l3 8 M' + (x + 1) + ' ' + (Ya - 4) + ' l3 8" stroke="' + C.faint + '" fill="none"/>'; });
        /* chapter bands */
        bands.forEach(function (b) {
          var c = Kit.chapter(b.ch), bx = b.x0 - half + 3, bw = (b.x1 - b.x0) + 2 * half - 6;
          s += '<rect x="' + bx.toFixed(1) + '" y="' + (Yb - 30) + '" width="' + bw.toFixed(1) + '" height="' + (H - Yb + 30 - 26) + '" rx="5" fill="' + C.surf2 + '"/>' +
            '<text x="' + (bx + 8).toFixed(1) + '" y="' + (H - 34) + '" class="m" fill="' + C.faint + '">' + esc(c ? ('CH' + c.n + ' · ' + c.title).toUpperCase() : 'NO CHAPTER') + '</text>';
        });
        s += '<line x1="' + X0 + '" x2="' + X1 + '" y1="' + Yb + '" y2="' + Yb + '" stroke="' + C.border + '"/>';
        /* connections */
        links.forEach(function (l) {
          var e = evs.find(function (o) { return o.e.id === l.ev; }), p = pzs.find(function (o) { return o.p.id === l.pz; }); if (!e || !p) return;
          var y0 = Ya + 6, y1 = Yb - 8, my = (y0 + y1) / 2;
          s += '<path class="ov-link" data-ev="' + l.ev + '" data-pz="' + l.pz + '" d="M' + e.x.toFixed(1) + ' ' + y0 + ' C' + e.x.toFixed(1) + ' ' + (my + 14) + ' ' + p.x.toFixed(1) + ' ' + (my - 14) + ' ' + p.x.toFixed(1) + ' ' + y1 + '" fill="none" stroke="' + (LC[e.e.layer] || C.muted) + '" stroke-width="1.5"/>';
        });
        var leaders = '', labels = '', marks = '';
        evs.forEach(function (o) {
          var id = o.e.id, ly = Ya - 14 - o.row * 15, col = LC[o.e.layer] || C.muted, has = linked.has(id), x = o.x.toFixed(1);
          leaders += '<line class="ldr" data-tl="' + id + '" x1="' + x + '" x2="' + x + '" y1="' + (Ya - 6) + '" y2="' + (ly + 3) + '" stroke="' + C.border + '"/>';
          labels += '<text class="lab" data-tl="' + id + '" x="' + o.tx.toFixed(1) + '" y="' + ly + '" text-anchor="' + o.anchor + '" fill="' + C.muted + '" stroke="' + C.surf + '">' + esc(o.label) + '</text>';
          marks += '<g class="ov-tl-ev" data-tl="' + id + '" tabindex="0" role="button" aria-label="' + esc(Kit.fmtDate(o.e.date) + ': ' + o.e.title + ' (' + ((Kit.layer(o.e.layer) || {}).label || '') + ')') + '">' +
            '<circle cx="' + x + '" cy="' + Ya + '" r="5" fill="' + (has ? col : C.surf) + '" stroke="' + (has ? C.surf : col) + '" stroke-width="2"/>' +
            (has ? '' : '<circle cx="' + x + '" cy="' + Ya + '" r="3.5" fill="none" stroke="' + col + '" stroke-width="1.5"/>') +
            '<circle class="hit" cx="' + x + '" cy="' + Ya + '" r="10" fill="transparent"/></g>';
        });
        pzs.forEach(function (o, i) {
          var id = o.p.id, x = o.x.toFixed(1), ly = Yb + 34 + o.row * 13;
          labels += '<text class="m" data-tl="' + id + '" x="' + x + '" y="' + (Yb + 20) + '" text-anchor="middle" fill="' + C.text + '">' + id + '</text>' +
            '<text class="lab sm" data-tl="' + id + '" x="' + o.tx.toFixed(1) + '" y="' + ly + '" text-anchor="middle" fill="' + C.muted + '" stroke="' + C.surf2 + '">' + esc(o.label) + '</text>';
          var op = PZ_OPACITY[o.p.status] || 0;
          marks += '<g class="ov-tl-pz" data-tl="' + id + '" tabindex="0" role="button" aria-label="' + esc('#' + (i + 1) + ' on the trail: ' + id + ' ' + o.p.title + ', ' + statusLabel(o.p.status)) + '">' +
            '<rect x="' + (o.x - 6.5).toFixed(1) + '" y="' + (Yb - 6.5) + '" width="13" height="13" rx="3" fill="' + C.acc + '" fill-opacity="' + op + '" stroke="' + C.acc + '" stroke-width="1.5"/>' +
            (o.p.final ? '<rect x="' + (o.x - 9.5).toFixed(1) + '" y="' + (Yb - 9.5) + '" width="19" height="19" rx="5" fill="none" stroke="' + C.acc + '" stroke-width="1"/>' : '') +
            '<rect class="hit" x="' + (o.x - 13).toFixed(1) + '" y="' + (Yb - 13) + '" width="26" height="26" fill="transparent"/></g>';
        });
        s += '<g>' + leaders + '</g><g>' + labels + '</g><g>' + marks + '</g>';
        s += '<text x="' + X0 + '" y="' + (H - 8) + '" class="m" fill="' + C.faint + '">TRAIL ORDER · PUZZLES EVENLY SPACED · SQUARE FILL = DESIGN STAGE (HOLLOW = IDEA, SOLID = READY)</text>';
        s += '</svg>';
        TLW.innerHTML = s;
        $('#ov-tl-cap', root).dataset.key = '';
        applyTlHi();
      }
      function discoveryLine() {
        var seq = [];
        TL.order.forEach(function (pid) {
          var evIds = TL.links.filter(function (l) { return l.pz === pid; }).map(function (l) { return Kit.get(l.ev); }).filter(Boolean)
            .sort(function (a, b) { return evYear(a.date) - evYear(b.date); });
          if (evIds.length) seq.push(evIds);
        });
        return seq.map(function (grp) { return grp.map(function (e) { return '<span class="ov-yr layer-' + esc(e.layer) + '" title="' + esc(e.title) + '">' + Kit.year(e.date) + '</span>'; }).join('<span class="faint">,</span>'); }).join('<span class="ov-arrow">→</span>');
      }
      function applyTlHi() {
        var svg = $('#ov-tl-svg', root); if (!svg) return;
        var cur = S.tlHover || S.tlSticky;
        if (cur && !Kit.has(cur)) { cur = null; S.tlSticky = null; S.tlHover = null; }
        svg.classList.toggle('hi', !!cur);
        var on = new Set();
        if (cur) {
          on.add(cur);
          if (Kit.type(cur) === 'event') TL.links.filter(function (l) { return l.ev === cur; }).forEach(function (l) { on.add(l.pz); });
          else TL.links.filter(function (l) { return l.pz === cur; }).forEach(function (l) { on.add(l.ev); });
        }
        $$('[data-tl]', svg).forEach(function (el) {
          el.classList.toggle('on', on.has(el.dataset.tl));
          if (el.hasAttribute('tabindex')) el.setAttribute('aria-pressed', String(S.tlSticky === el.dataset.tl));
        });
        $$('.ov-link', svg).forEach(function (p) { p.classList.toggle('on', !!cur && (p.dataset.ev === cur || p.dataset.pz === cur)); });
        var cap = $('#ov-tl-cap', root);
        var key = (cur || '') + '|' + (S.tlSticky || '') + '|' + TL.links.length + '|' + TL.order.join(',');
        if (cap.dataset.key === key) return;
        cap.dataset.key = key;
        var clear = S.tlSticky ? '<button type="button" class="btn ghost sm" data-act="tl-clear">Clear</button>' : '';
        if (!cur) {
          var bg = Kit.list('event').filter(function (e) { return !TL.links.some(function (l) { return l.ev === e.id; }); }).length;
          cap.innerHTML = '<span class="ov-sub">Players meet history in this order</span><span class="ov-seq">' + discoveryLine() + '</span>' +
            '<span class="faint">' + plural(bg, 'event') + ' are background only. Hover or tap a dot or a puzzle to trace it.</span>';
          return;
        }
        if (Kit.type(cur) === 'event') {
          var e = Kit.get(cur), l = TL.links.find(function (x) { return x.ev === cur; });
          var tail = l ? '<span>revealed by</span>' + ref(l.pz) + '<span class="faint">#' + (TL.order.indexOf(l.pz) + 1) + ' of ' + TL.order.length + ' on the trail, ' + esc(chName(Kit.get(l.pz).chapter)) + '</span>'
            : '<span class="faint">background only: no puzzle reveals it</span>';
          cap.innerHTML = Kit.layerBadge(e.layer) + ref(e.id) + '<span class="faint">' + esc(Kit.fmtDate(e.date)) + '</span>' + tail + clear;
        } else {
          var p = Kit.get(cur), evIds = TL.links.filter(function (x) { return x.pz === cur; }).map(function (x) { return x.ev; });
          cap.innerHTML = ref(p.id) + '<span class="faint">#' + (TL.order.indexOf(p.id) + 1) + ' on the trail · ' + esc(chName(p.chapter)) + ' · ' + esc(statusLabel(p.status)) + '</span>' +
            (evIds.length ? '<span>reveals</span>' + refs(evIds) : '<span class="faint">reveals no history events</span>') +
            '<button type="button" class="btn ghost sm" data-go="trail.' + p.id + '">Open on the trail</button>' + clear;
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
        var r = readiness(Kit.list('puzzle'), Kit.list('asset'));
        var open = Kit.list('question').filter(function (q) { return q.status === 'open'; }).length;
        var doing = Kit.list('task').filter(function (t) { return t.status === 'doing'; }).length;
        ctx.setStatus([pct(r) + '% ready overall', plural(Kit.list('puzzle').length, 'puzzle') + ' in ' + plural(Kit.chapters().length, 'chapter'), plural(open, 'open question'), doing + ' tasks in progress']);
      }
      var PANELS = [
        ['ov-overall', renderOverall], ['ov-ready', renderReady], ['ov-next', renderNext], ['ov-pipe', renderKanban],
        ['ov-dec', renderDecisions], ['ov-probs', renderProblems], ['ov-lib', renderLibrary], ['ov-assets', renderAssets], ['ov-hist', renderHistory],
      ];
      var deferred = new Set();
      function isTyping(el) { return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|email|)$/i.test(el.type || ''))); }
      function renderAll() {
        cache = null;
        var ae = document.activeElement, fkey = ae && ae.dataset ? ae.dataset.fkey : null;
        if (S.refocus) { fkey = S.refocus; S.refocus = null; }
        PANELS.forEach(function (pp) {
          var el = $('#' + pp[0], root);
          /* keep a text field the user is typing in: rebuild that panel when they leave it */
          if (isTyping(ae) && el.contains(ae) && !ae.closest('form.ov-add')) { deferred.add(pp[0]); return; }
          try { pp[1](); } catch (err) { console.error(err); }
        });
        fillGame(false);
        updateStatus();
        if (fkey) { var f = root.querySelector('[data-fkey="' + fkey + '"]'); if (f && f !== document.activeElement) f.focus({ preventScroll: true }); }
      }
      listen(root, 'focusout', function (e) {
        if (!deferred.size) return;
        setTimeout(function () {
          if (!root.isConnected) return;
          var ae = document.activeElement;
          deferred.forEach(function (id) {
            var el = $('#' + id, root); if (!el || el.contains(ae)) return;
            deferred.delete(id);
            var pp = PANELS.find(function (x) { return x[0] === id; }); if (pp) pp[1]();
          });
        }, 0);
      });
      var renderT = null;
      offs.push(Kit.on('change', function () { clearTimeout(renderT); renderT = setTimeout(renderAll, 40); }));
      listen(document, 'kit:theme', function () { renderHistory(); });
      var rzT = null, lastW = window.innerWidth;
      listen(window, 'resize', function () {
        clearTimeout(rzT);
        rzT = setTimeout(function () { if (window.innerWidth !== lastW) { lastW = window.innerWidth; renderHistory(); growPremise(); } closeMenu(); }, 150);
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
          case 'resolve-go':
            S.resolving = id; S.draft = ''; renderDecisions();
            focusResolve();
            break;
          case 'resolve': S.resolving = id; S.draft = ''; renderDecisions(); focusResolve(); break;
          case 'resolve-cancel': S.resolving = null; S.draft = ''; renderDecisions(); break;
          case 'resolve-save': {
            var q = Kit.get(id); if (!q) break;
            var ta = $('#ov-res-text', root), txt = (ta ? ta.value : S.draft).trim();
            var before = { status: q.status, resolution: q.resolution || '' };
            S.resolving = null; S.draft = '';
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
        }
      });
      function focusResolve() {
        var t = $('#ov-res-text', root);
        if (t) { t.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); t.focus({ preventScroll: true }); }
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
          else if (e.key === 'Escape') { g.value = D.game[g.dataset.g] || ''; growPremise(); g.blur(); e.stopPropagation(); }
          return;
        }
        if (e.target.id === 'ov-res-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); var sv = $('[data-act="resolve-save"]', root); if (sv) sv.click(); return; }
        var card = e.target.closest && e.target.closest('.ov-card');
        if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.go(card.dataset.pid); }
      });
      listen(root, 'submit', function (e) {
        e.preventDefault();
        if (e.target.id === 'ov-capture') {
          var inp = $('#ov-cap', root);
          if (!inp.value.trim()) { Kit.toast('Type an idea first'); inp.focus(); return; }
          if (captureIdea(inp.value)) inp.value = '';
        } else if (e.target.id === 'ov-addtask') {
          var ti = $('#ov-newtask', root), title = ti.value.trim();
          if (!title) { Kit.toast('Type a task first'); ti.focus(); return; }
          var tid = Kit.create('task', { title: title, status: 'todo', links: Kit.textRefs(title) });
          S.touchedTasks.add(tid);
          ti.value = '';
          Kit.toast('Added task ' + tid, { label: 'Undo', run: function () { Kit.remove(tid); Kit.toast('Removed task ' + tid); } });
        }
      });
      listen(document, 'keydown', function (e) {
        if (e.key === 'Escape' && S.menu) { var b = S.menu.btn; closeMenu(); if (b.isConnected) b.focus(); }
      });

      /* first paint */
      fillGame(true);
      renderAll();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (root.isConnected) { renderHistory(); growPremise(); } });

      return {
        update: function () { /* only one route */ },
        unmount: function () {
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
