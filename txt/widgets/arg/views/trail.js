/* ============================================================
   ARG DESK — Trail view (v-trail)
   Puzzle dependency graph by chapter, player POV scrubber,
   pacing strip, critical path, problems drawer, and a full
   puzzle inspector (every field editable, phone included).
   Routes: trail · trail.<puzzleId>
   ============================================================ */
(function () {
  'use strict';
  var esc = Kit.esc;
  function D() { return window.ARG; }

  /* UI preferences that survive leaving and coming back to the view */
  var PREF = { pov: 3, flow: true, crit: false, zoom: 1, spoil: false, pacingOpen: null, chapter: 'all', povOpen: true, sel: 'P04', tab: 'puzzle' };

  var NW = 184, NH = 106, CG = 60, RG = 30, LP = 22, HH = 96, TOPPAD = 30, GW = 150, GH = 42;
  var SEVN = { high: 0, med: 1, low: 2 };
  var KEEP = ['Orphan clue', 'Unplanted clue', 'No solution', 'No solve path', 'Design checks', 'Recipe', 'Broken link',
    'Order', 'Clue too late', 'Dead end', 'Variety', 'Unverified research'];

  var ICON = {
    left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    up: '<path d="m18 15-6-6-6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
    out: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  };
  function ic(n, cls) {
    return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>';
  }
  var fmtMin = function (m) { return Kit.fmtMinutes(+m || 0); };
  function chN(cid) { var c = Kit.chapter(cid); return c ? c.n : 99; }
  function chShort(c) { return c ? 'Chapter ' + c.n : 'No chapter'; }
  function kindLabel(k) { var x = D().puzzleKinds.find(function (y) { return y.id === k; }); return x ? x.label : (k || '—'); }
  function isPuzzle(id) { return Kit.type(id) === 'puzzle'; }
  function sum(a) { return a.reduce(function (s, x) { return s + (+x || 0); }, 0); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function layerIds() { return D().layers.map(function (l) { return l.id; }); }
  function reduced() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  Desk.registerView({
    id: 'trail', title: 'Trail',
    routes: function (t) {
      if (t === 'trail') return {};
      var m = /^trail\.(.+)$/.exec(t);
      return m ? { select: m[1] } : null;
    },
    mount: mount,
  });

  function mount(root, params, ctx) {
    var mqPhone = matchMedia('(max-width: 760px)'), mqWide = matchMedia('(min-width: 1600px)');
    var S = {
      sel: null, multi: [], selectMode: false, hiClue: null, scrollClue: false,
      probOpen: false, probSev: 'all', probActive: -1, addOpen: false, draft: null,
      sheet: false, povLayer: null, povMOpen: false, phone: mqPhone.matches, wide: mqWide.matches,
    };
    if (params && params.select && isPuzzle(params.select)) S.sel = params.select;
    else if (isPuzzle(PREF.sel)) S.sel = PREF.sel;
    else S.sel = (Kit.puzzleOrder()[0] || {}).id || null;
    if (PREF.pacingOpen == null) PREF.pacingOpen = !S.phone;
    var M = {}, LAYOUT = null, selfEdit = false, alive = true;
    var cleanups = [];
    function on(target, evt, fn, opts) { target.addEventListener(evt, fn, opts); cleanups.push(function () { target.removeEventListener(evt, fn, opts); }); }

    /* ---------------- model ---------------- */
    function isAncestor(a, b) {
      var seen = {}, stack = [b];
      while (stack.length) {
        var id = stack.pop(), p = Kit.get(id);
        if (!p || seen[id]) continue; seen[id] = 1;
        var req = p.requires || [];
        for (var i = 0; i < req.length; i++) { if (req[i] === a) return true; stack.push(req[i]); }
      }
      return false;
    }
    function critical() {
      var best = {}, prev = {};
      M.order.forEach(function (p) {
        var b = 0, pr = null;
        (p.requires || []).forEach(function (r) { if (best[r] != null && best[r] > b) { b = best[r]; pr = r; } });
        best[p.id] = b + (+p.estMin || 0); prev[p.id] = pr;
      });
      var end = null;
      Object.keys(best).forEach(function (id) { if (end == null || best[id] > best[end]) end = id; });
      var ids = [];
      for (var c = end; c; c = prev[c]) ids.unshift(c);
      var edges = new Set();
      for (var i = 1; i < ids.length; i++) edges.add(ids[i - 1] + '>' + ids[i]);
      return { ids: ids, set: new Set(ids), edges: edges, total: end ? best[end] : 0, end: end };
    }
    function spikes() {
      var out = {};
      M.order.forEach(function (p, i) {
        var prev = M.order[i - 1], why = [];
        if (p.difficulty >= 5 && p.kind !== 'meta' && !p.final) why.push('difficulty 5 of 5');
        if (prev && p.difficulty - prev.difficulty >= 1 && (+p.estMin || 0) >= (+prev.estMin || 0) * 1.4)
          why.push('+' + (p.difficulty - prev.difficulty) + ' difficulty and ' + Math.round(((+p.estMin) / Math.max(1, +prev.estMin) - 1) * 100) + '% longer than ' + prev.id + ' just before it');
        if (why.length) out[p.id] = why.join('; ');
      });
      return out;
    }
    function problems() {
      var out = Kit.integrity().filter(function (x) { return KEEP.indexOf(x.kind) >= 0; });
      D().clues.forEach(function (c) {
        if (!c.plantedIn || !isPuzzle(c.plantedIn)) return;
        (c.usedBy || []).forEach(function (u) {
          if (u !== c.plantedIn && Kit.get(u) && !isAncestor(c.plantedIn, u))
            out.push({ severity: 'high', kind: 'Clue out of order', text: c.id + ' comes from solving ' + c.plantedIn + ', but players can reach ' + u + ' without solving ' + c.plantedIn + '.', ids: [u, c.id, c.plantedIn] });
        });
      });
      Object.keys(M.spikes).forEach(function (id) {
        out.push({ severity: 'low', kind: 'Pacing spike', text: id + ' ' + Kit.label(id) + ': ' + M.spikes[id] + '.', ids: [id] });
      });
      out.sort(function (a, b) { return SEVN[a.severity] - SEVN[b.severity]; });
      return out;
    }
    function frontierOf(solved) {
      return D().puzzles.filter(function (p) { return !solved.has(p.id) && (p.requires || []).every(function (r) { return solved.has(r) || !Kit.get(r); }); })
        .map(function (p) { return p.id; }).sort(function (a, b) { return M.idx[a] - M.idx[b]; });
    }
    function solvedAt(k) { return M.order.slice(0, k).map(function (p) { return p.id; }); }
    function knownAt(k) {
      var ids = solvedAt(k), set = new Set(Kit.knownAfter(ids));
      D().characters.forEach(function (c) { if ((c.appears || []).some(function (a) { return ids.indexOf(a) >= 0; })) set.add(c.id); });
      return set;
    }
    function compute() {
      M.order = Kit.puzzleOrder();
      M.N = M.order.length;
      if (PREF.pov > M.N) PREF.pov = M.N;
      M.idx = {}; M.order.forEach(function (p, i) { M.idx[p.id] = i; });
      if (S.sel && !isPuzzle(S.sel)) S.sel = null;
      S.multi = S.multi.filter(isPuzzle);
      M.crit = critical();
      M.spikes = spikes();
      M.problems = problems();
      M.sev = {};
      M.problems.forEach(function (pr) {
        pr.ids.forEach(function (id) {
          if (!isPuzzle(id)) return;
          if (M.sev[id] == null || SEVN[pr.severity] < SEVN[M.sev[id]]) M.sev[id] = pr.severity;
        });
      });
      var solved = new Set(solvedAt(PREF.pov));
      M.pv = { k: PREF.pov, on: PREF.pov > 0, solved: solved, front: new Set(PREF.pov > 0 ? frontierOf(solved) : []) };
      M.total = sum(D().puzzles.map(function (p) { return p.estMin; }));
    }
    function povState(id) {
      if (!M.pv.on) return null;
      return M.pv.solved.has(id) ? 'solved' : M.pv.front.has(id) ? 'front' : 'locked';
    }
    function puzzleLayers(p) {
      var c = {}; layerIds().forEach(function (l) { c[l] = 0; });
      [].concat(p.inputs || [], p.reveals || [], p.mysteries || []).forEach(function (id) { var l = Kit.layerOf(id); if (l && c[l] != null) c[l]++; });
      return c;
    }
    function layerSegs(c) {
      return layerIds().filter(function (l) { return c[l]; }).map(function (l) {
        return '<i class="layer-' + l + '" style="flex-grow:' + c[l] + '" title="' + esc(Kit.layer(l).label + ': ' + c[l]) + '"></i>';
      }).join('');
    }
    function visibleChapters() { return Kit.chapters().filter(function (c) { return PREF.chapter === 'all' || c.id === PREF.chapter; }); }
    function puzzleForClue(cid) {
      var c = Kit.get(cid); if (!c) return null;
      if ((c.usedBy || []).length) return c.usedBy.slice().sort(function (a, b) { return (M.idx[a] || 0) - (M.idx[b] || 0); })[0];
      if (c.plantedIn && isPuzzle(c.plantedIn)) return c.plantedIn;
      var ap = c.plantedIn && D().puzzles.find(function (p) { return (p.assets || []).indexOf(c.plantedIn) >= 0; });
      return ap ? ap.id : null;
    }
    function lastDownstream(id) {
      var ord = M.order.map(function (p) { return p.id; });
      var chosen = S.multi.filter(function (x) { return x !== id && Kit.sequence(id, x).length > 1; });
      if (chosen.length) return chosen.sort(function (a, b) { return M.idx[a] - M.idx[b]; }).pop();
      var down = ord.filter(function (x) { return x !== id && Kit.sequence(id, x).length > 1; });
      return down.length ? down[down.length - 1] : id;
    }
    function chainOf(ids) {
      if (ids.length < 2) return null;
      var s = ids.slice().sort(function (a, b) { return M.idx[a] - M.idx[b]; });
      var seq = Kit.sequence(s[0], s[s.length - 1]);
      if (seq.length > 1 && s.every(function (id) { return seq.indexOf(id) >= 0; })) return { from: s[0], to: s[s.length - 1], n: seq.length };
      return null;
    }

    /* ---------------- skeleton ---------------- */
    root.innerHTML =
      '<div class="tr" id="tr">' +
      '<div class="tb" role="toolbar" aria-label="Trail controls">' +
        '<div class="tb-g tb-ch"><span class="eyebrow tb-lbl">Ch</span><div class="seg" id="tr-ch" role="group" aria-label="Show chapter"></div></div>' +
        '<div class="tb-g tb-pov">' +
          '<span class="eyebrow tb-lbl">Player view</span>' +
          '<button type="button" class="ib" id="pov-prev" aria-label="Step back one puzzle">' + ic('left') + '</button>' +
          '<div class="scrub"><div class="scrub-track"><div class="scrub-fill" id="scrub-fill"></div></div><div id="scrub-ticks"></div>' +
            '<input type="range" id="pov-range" min="0" max="13" step="1" value="3" aria-label="Player view: how far through the trail players are"></div>' +
          '<button type="button" class="ib" id="pov-next" aria-label="Step forward one puzzle">' + ic('right') + '</button>' +
          '<div class="pov-label" aria-live="polite"><span class="pl-main" id="pl-main"></span><span class="pl-sub" id="pl-sub"></span></div>' +
          '<button type="button" class="ib" id="t-povp" aria-pressed="true" title="Show what players know" aria-label="Show what players know">' + ic('panel') + '</button>' +
        '</div>' +
        '<div class="tb-g tb-tog">' +
          '<button type="button" class="tog" id="t-flow" aria-pressed="true" title="Show clues one puzzle hands to the next">Clue flow</button>' +
          '<button type="button" class="tog" id="t-crit" aria-pressed="false" title="Longest route through the trail by estimated minutes">Critical <span class="lg">path</span> <span class="num" id="crit-min"></span></button>' +
          '<button type="button" class="tog" id="t-sel" aria-pressed="false" title="Tap puzzles to select several (or Shift/Ctrl-click)">Select</button>' +
        '</div>' +
        '<span class="tb-spacer"></span>' +
        '<button type="button" class="btn sm" id="b-add" aria-expanded="false">' + ic('plus') + '<span>Add <span class="lg">puzzle</span></span></button>' +
        '<button type="button" class="btn sm" id="b-prob" aria-expanded="false" aria-label="Problems">' + ic('alert') + '<span class="lg2">Problems</span> <span class="badge" id="prob-badge">0</span></button>' +
      '</div>' +
      '<aside class="pov scroll" id="pov" aria-label="What players know"></aside>' +
      '<section class="center" aria-label="Puzzle trail">' +
        '<div class="gwrap">' +
          '<div class="graph scroll" id="graph"><div class="gsize" id="gsize"><div class="world" id="world"></div></div><div class="tlist" id="tlist"></div></div>' +
          '<div class="mbar" id="mbar" hidden></div>' +
          '<div class="gzoom" role="group" aria-label="Zoom">' +
            '<button type="button" id="z-out" aria-label="Zoom out">' + ic('minus') + '</button>' +
            '<button type="button" id="z-reset" aria-label="Reset zoom">100%</button>' +
            '<button type="button" id="z-in" aria-label="Zoom in">' + ic('plus') + '</button>' +
            '<button type="button" id="z-fit" aria-label="Fit the whole trail">' + ic('fit') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="pacing" id="pacing">' +
          '<div class="pc-head">' +
            '<button type="button" class="pc-toggle" id="pc-toggle" aria-expanded="true" aria-controls="pc-scroll">' + ic('down', 'chev') + '<span class="eyebrow">Pacing</span></button>' +
            '<span class="pc-leg"><span><i class="sw-bar"></i>est. minutes</span><span><i class="sw-dot"></i>difficulty</span><span><i class="sw-spike"></i>spike</span><span class="sw-povw"><i class="sw-pov"></i>player view</span></span>' +
            '<span class="pc-flags" id="pc-flags"></span></div>' +
          '<div class="pc-scroll scroll" id="pc-scroll"></div>' +
        '</div>' +
        '<div class="pop" id="probs" hidden role="dialog" aria-label="Problems"></div>' +
        '<div class="pop" id="addf" hidden role="dialog" aria-label="Add puzzle"></div>' +
      '</section>' +
      '<aside class="side" id="side" aria-label="Inspector">' +
        '<div class="side-tabs seg" role="tablist" id="side-tabs">' +
          '<button type="button" role="tab" data-tab="puzzle" aria-selected="true" aria-pressed="true">Puzzle</button>' +
          '<button type="button" role="tab" data-tab="players" aria-selected="false" aria-pressed="false">What players know</button>' +
        '</div>' +
        '<div class="insp scroll" id="insp"></div>' +
        '<div class="povr scroll" id="povr" hidden></div>' +
      '</aside>' +
      '<div class="pc-tip" id="pc-tip" hidden role="tooltip"></div>' +
      '</div>';
    function $(id) { return root.querySelector('#' + id); }
    var $graph = $('graph'), $gsize = $('gsize'), $world = $('world'), $tlist = $('tlist'), $insp = $('insp'), $side = $('side'),
      $pov = $('pov'), $povr = $('povr'), $pc = $('pc-scroll'), $probs = $('probs'), $addf = $('addf'), $range = $('pov-range'),
      $tip = $('pc-tip'), $mbar = $('mbar');

    (function () {
      var seg = $('tr-ch');
      var items = [{ id: 'all', label: 'All', title: 'All chapters' }].concat(Kit.chapters().map(function (c) {
        return { id: c.id, label: String(c.n), title: 'Chapter ' + c.n + ': ' + c.title };
      }));
      seg.innerHTML = items.map(function (it) {
        return '<button type="button" data-ch="' + esc(it.id) + '" title="' + esc(it.title) + '" aria-pressed="false">' + esc(it.label) + '</button>';
      }).join('');
      seg.addEventListener('click', function (e) { var b = e.target.closest('button[data-ch]'); if (b) setChapter(b.dataset.ch); });
    })();

    /* ---------------- toolbar ---------------- */
    function povTitle(k) {
      if (k === 0) return 'Before the trailhead';
      var p = M.order[k - 1]; return p ? 'After ' + p.id + ' ' + p.title : '';
    }
    function updateToolbar() {
      Array.prototype.forEach.call(root.querySelectorAll('#tr-ch button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.ch === PREF.chapter)); });
      var N = M.N, k = PREF.pov;
      $range.max = String(N);
      if (+$range.value !== k) $range.value = String(k);
      $range.setAttribute('aria-valuetext', povTitle(k));
      $('scrub-fill').style.width = (N ? k / N * 100 : 0) + '%';
      var ticks = '';
      for (var i = 0; i <= N; i++) {
        var cls = 'scrub-tick';
        if (i > 0 && i < N && M.order[i] && M.order[i - 1] && M.order[i].chapter !== M.order[i - 1].chapter) cls += ' act';
        ticks += '<i class="' + cls + '" style="left:calc(7px + (100% - 14px) * ' + (N ? i / N : 0) + ')"></i>';
      }
      $('scrub-ticks').innerHTML = ticks;
      $('pl-main').textContent = povTitle(k); $('pl-main').title = povTitle(k);
      var c = k > 0 && M.order[k - 1] ? Kit.chapter(M.order[k - 1].chapter) : null;
      $('pl-sub').textContent = k + '/' + N + ' solved' + (c ? ' · ' + chShort(c) : '');
      $('pov-prev').disabled = k <= 0;
      $('pov-next').disabled = k >= N;
      $('t-flow').setAttribute('aria-pressed', String(PREF.flow));
      $('t-crit').setAttribute('aria-pressed', String(PREF.crit));
      $('t-sel').setAttribute('aria-pressed', String(S.selectMode));
      var povShown = S.phone ? S.povMOpen : S.wide ? PREF.povOpen : PREF.tab === 'players';
      $('t-povp').setAttribute('aria-pressed', String(povShown));
      $('crit-min').textContent = fmtMin(M.crit.total);
      $('b-add').setAttribute('aria-expanded', String(S.addOpen));
      $('b-prob').setAttribute('aria-expanded', String(S.probOpen));
      var b = $('prob-badge');
      b.textContent = String(M.problems.length);
      b.className = 'badge' + (M.problems.some(function (x) { return x.severity === 'high'; }) ? ' high' : '');
      $('z-reset').textContent = Math.round(PREF.zoom * 100) + '%';
      $('pc-toggle').setAttribute('aria-expanded', String(PREF.pacingOpen));
      $pc.hidden = !PREF.pacingOpen;
    }
    function setPov(k) {
      k = clamp(k, 0, M.N);
      if (k === PREF.pov) return;
      PREF.pov = k;
      renderAll();
    }
    function setChapter(id) {
      PREF.chapter = id;
      renderAll();
      $graph.scrollLeft = 0; $graph.scrollTop = 0;
      if (S.sel) scrollToSel();
    }
    on($range, 'input', function () { setPov(+$range.value); });
    $('pov-prev').addEventListener('click', function () { setPov(PREF.pov - 1); });
    $('pov-next').addEventListener('click', function () { setPov(PREF.pov + 1); });
    $('t-flow').addEventListener('click', function () { PREF.flow = !PREF.flow; renderAll(); });
    $('t-crit').addEventListener('click', function () {
      PREF.crit = !PREF.crit; renderAll();
      if (PREF.crit) Kit.toast('Critical path: ' + M.crit.ids.length + ' puzzles, ' + fmtMin(M.crit.total) + ' of play.');
    });
    $('t-sel').addEventListener('click', function () {
      S.selectMode = !S.selectMode;
      if (S.selectMode && !S.multi.length && S.sel) S.multi = [S.sel];
      renderAll();
    });
    $('t-povp').addEventListener('click', function () {
      if (S.phone) { S.povMOpen = !S.povMOpen; renderAll(); if (S.povMOpen) $graph.scrollTop = 0; return; }
      if (S.wide) PREF.povOpen = !PREF.povOpen;
      else PREF.tab = PREF.tab === 'players' ? 'puzzle' : 'players';
      renderAll();
    });
    $('b-add').addEventListener('click', function () { S.addOpen ? closeAdd() : openAdd(); });
    $('b-prob').addEventListener('click', function () { S.probOpen = !S.probOpen; if (S.probOpen) S.addOpen = false; renderAll(); });
    $('side-tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) { PREF.tab = b.dataset.tab; renderAll(); } });
    $('pc-toggle').addEventListener('click', function () { PREF.pacingOpen = !PREF.pacingOpen; renderAll(); });

    /* ---------------- player view (POV) ---------------- */
    function knRow(id, prev, k) {
      var o = Kit.get(id), t = Kit.type(id), l = Kit.layerOf(id), isNew = k > 0 && !prev.has(id);
      var text = t === 'clue' ? '<span class="kn-t doc">' + esc(o.text) + '</span>'
        : t === 'event' ? '<span class="kn-t"><span class="kn-date">' + esc(Kit.fmtDate(o.date)) + '</span> ' + esc(o.title) + '</span>'
        : '<span class="kn-t">' + esc(Kit.label(id)) + '</span>';
      return '<button type="button" class="kn' + (isNew ? ' new' : '') + '" data-kn="' + esc(id) + '" data-ref="' + esc(id) + '">' +
        (l ? Kit.layerBadge(l, { short: true }) : '<span></span>') + text +
        '<span class="kn-id">' + (isNew ? '<span class="kn-new">new</span> ' : '') + (t === 'clue' ? esc(id) : '') + '</span></button>' +
        (o.guard ? '<div class="guard"><span class="eyebrow">Real person</span><b>' + esc(o.name) + '.</b> ' + esc(o.guard) + '</div>' : '');
    }
    function layerCounts(set) {
      var c = {}; layerIds().forEach(function (l) { c[l] = 0; });
      set.forEach(function (id) { var l = Kit.layerOf(id); if (c[l] != null) c[l]++; });
      return c;
    }
    function povBody(withHead) {
      var k = PREF.pov, N = M.N;
      var known = knownAt(k), prev = k > 0 ? knownAt(k - 1) : new Set();
      var counts = layerCounts(known), total = known.size;
      var h = '';
      if (withHead) {
        h += '<div class="pv-head"><div class="pv-top"><span class="eyebrow">What players know</span><span class="count">' + k + ' / ' + N + '</span>' +
          (S.wide ? '<button type="button" class="ib bare" data-pv="close" aria-label="Hide what players know">' + ic('x') + '</button>' : '') + '</div>' +
          '<h3>' + esc(povTitle(k)) + '</h3></div>';
      }
      h += '<div class="pv-mix"><div class="sec-head"><span class="eyebrow">Layer mix of what they know</span><span class="count">' + total + '</span></div>' +
        (total ? '<div class="lbar">' + layerSegs(counts) + '</div>' : '<div class="lbar empty"></div>') +
        '<div class="lleg">' + layerIds().map(function (l) {
          var L = Kit.layer(l);
          return '<button type="button" class="lchip layer-' + l + '" data-layer="' + l + '" aria-pressed="' + (S.povLayer === l) + '" title="' + esc(L.label + ' — ' + L.desc + ' Click to filter.') + '">' +
            '<span class="layer-dot layer-' + l + '"></span>' + esc(L.short) + ' <b class="num">' + counts[l] + '</b></button>';
        }).join('') + '</div></div>';
      var front = frontierOf(new Set(solvedAt(k)));
      h += '<div class="pv-sec"><div class="sec-head"><span class="eyebrow">Next up</span><span class="count">' + front.length + '</span></div>' +
        (front.length ? front.map(function (id) {
          var p = Kit.get(id), c = Kit.chapter(p.chapter);
          return '<button type="button" class="nx" data-pick="' + id + '"><span class="id">' + id + '</span><span class="t">' + esc(p.title) + '</span>' +
            '<span class="s">' + esc(chShort(c)) + ' · ' + fmtMin(p.estMin) + ' · ' + esc(kindLabel(p.kind)) + ' · ' + esc(Kit.statusLabel(p.status)) + '</span></button>';
        }).join('') : '<div class="kn-empty">Nothing left. Players have finished the trail.</div>') + '</div>';
      [['clue', 'Clues'], ['character', 'Characters'], ['mystery', 'Mysteries'], ['event', 'Timeline']].forEach(function (g) {
        var items = Array.from(known).filter(function (id) { return Kit.type(id) === g[0]; });
        if (S.povLayer) items = items.filter(function (id) { return Kit.layerOf(id) === S.povLayer; });
        items.sort(function (a, b) {
          if (g[0] === 'event') return String(Kit.get(a).date).localeCompare(String(Kit.get(b).date));
          return layerIds().indexOf(Kit.layerOf(a)) - layerIds().indexOf(Kit.layerOf(b)) || a.localeCompare(b);
        });
        h += '<div class="pv-sec"><div class="sec-head"><span class="eyebrow">' + g[1] + '</span><span class="count">' + items.length + '</span></div>' +
          (items.length ? items.map(function (id) { return knRow(id, prev, k); }).join('') : '<div class="kn-empty">' + (S.povLayer ? 'None on this layer' : 'None yet') + '</div>') + '</div>';
      });
      var unsolved = M.order.slice(k);
      var hid = [
        [N - k, 'puzzles'],
        [D().clues.filter(function (c) { return !known.has(c.id); }).length, 'clues'],
        [D().characters.filter(function (c) { return !known.has(c.id); }).length, 'characters'],
        [D().mysteries.filter(function (m) { return m.used && !known.has(m.id); }).length, 'mysteries'],
        [D().events.filter(function (e) { return e.revealedBy && !known.has(e.id); }).length, 'timeline'],
        [fmtMin(sum(unsolved.map(function (p) { return p.estMin; }))), 'play left'],
      ];
      h += '<div class="pv-sec"><div class="sec-head"><span class="eyebrow">Still hidden</span></div><div class="hid">' +
        hid.map(function (x) { return '<div><b>' + x[0] + '</b><span>' + x[1] + '</span></div>'; }).join('') + '</div></div>';
      return h;
    }
    function renderPov() {
      var leftOn = !S.phone && S.wide && PREF.povOpen;
      $pov.hidden = !leftOn;
      if (leftOn) { var st = $pov.scrollTop; $pov.innerHTML = '<div class="pv">' + povBody(true) + '</div>'; $pov.scrollTop = st; }
      else $pov.innerHTML = '';
      var tabbed = !S.phone && !S.wide;
      $('side-tabs').hidden = !tabbed;
      var showPlayers = tabbed && PREF.tab === 'players';
      Array.prototype.forEach.call(root.querySelectorAll('#side-tabs [data-tab]'), function (b) {
        var on = b.dataset.tab === (showPlayers ? 'players' : 'puzzle');
        b.setAttribute('aria-selected', String(on)); b.setAttribute('aria-pressed', String(on));
        if (b.dataset.tab === 'players') b.textContent = 'What players know · ' + knownAt(PREF.pov).size;
      });
      $povr.hidden = !showPlayers; $insp.hidden = showPlayers;
      if (showPlayers) { var s2 = $povr.scrollTop; $povr.innerHTML = '<div class="pv">' + povBody(true) + '</div>'; $povr.scrollTop = s2; }
      else $povr.innerHTML = '';
    }
    function onPovClick(e) {
      var lc = e.target.closest('.lchip[data-layer]');
      if (lc) { e.preventDefault(); S.povLayer = S.povLayer === lc.dataset.layer ? null : lc.dataset.layer; renderAll(); return true; }
      if (e.target.closest('[data-pv="close"]')) { PREF.povOpen = false; renderAll(); return true; }
      var nx = e.target.closest('[data-pick]');
      if (nx) { select(nx.dataset.pick); return true; }
      var kn = e.target.closest('[data-kn]');
      if (kn) {
        var id = kn.dataset.kn;
        if (Kit.type(id) === 'clue') { var pid = puzzleForClue(id); if (pid) { select(pid, { clue: id }); return true; } }
        ctx.go(id); return true;
      }
      return false;
    }
    $pov.addEventListener('click', onPovClick);
    $povr.addEventListener('click', onPovClick);

    /* ---------------- graph layout ---------------- */
    function layout() {
      var chs = visibleChapters();
      var chIds = chs.map(function (c) { return c.id; });
      var vis = D().puzzles.filter(function (p) { return chIds.indexOf(p.chapter) >= 0 || (PREF.chapter === 'all' && !Kit.chapter(p.chapter)); });
      var visSet = new Set(vis.map(function (p) { return p.id; }));
      var lr = {}, visiting = {};
      function rank(p) {
        if (lr[p.id] != null) return lr[p.id];
        if (visiting[p.id]) return 0;
        visiting[p.id] = 1;
        var r = 0;
        (p.requires || []).forEach(function (rid) { var q = Kit.get(rid); if (q && q.chapter === p.chapter && visSet.has(rid)) r = Math.max(r, rank(q) + 1); });
        visiting[p.id] = 0; lr[p.id] = r; return r;
      }
      vis.forEach(rank);
      var gin = [], gout = [];
      vis.forEach(function (p) { (p.requires || []).forEach(function (r) { if (!visSet.has(r) && Kit.get(r) && gin.indexOf(r) < 0) gin.push(r); }); });
      vis.forEach(function (p) { Kit.unlocks(p.id).forEach(function (u) { if (!visSet.has(u) && gout.indexOf(u) < 0) gout.push(u); }); });
      var row = {};
      function mean(a) { return a.length ? sum(a) / a.length : 0; }
      function place(ids, desired) {
        var arr = ids.map(function (id) { return { id: id, d: desired(id) }; });
        arr.sort(function (a, b) { return a.d - b.d || (M.idx[a.id] || 0) - (M.idx[b.id] || 0); });
        var pos = arr.map(function (a) { return a.d; });
        for (var i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + 1);
        var shift = mean(arr.map(function (a, i) { return a.d - pos[i]; }));
        arr.forEach(function (a, i) { row[a.id] = pos[i] + shift; });
      }
      function parentsDesired(id) {
        var p = Kit.get(id);
        return mean((p.requires || []).filter(function (r) { return row[r] != null; }).map(function (r) { return row[r]; }));
      }
      var lanes = [];
      var groups = chs.map(function (c) { return { ch: c, ps: vis.filter(function (p) { return p.chapter === c.id; }) }; });
      var orphans = vis.filter(function (p) { return !Kit.chapter(p.chapter); });
      if (orphans.length) groups.push({ ch: null, ps: orphans });
      groups.forEach(function (g) {
        var nSub = g.ps.length ? Math.max.apply(null, g.ps.map(function (p) { return lr[p.id]; })) + 1 : 1;
        for (var s = 0; s < nSub; s++) place(g.ps.filter(function (p) { return lr[p.id] === s; }).map(function (p) { return p.id; }), parentsDesired);
        lanes.push({ ch: g.ch, ps: g.ps, nSub: nSub });
      });
      place(gout, parentsDesired);
      place(gin, function (id) { return mean(vis.filter(function (p) { return (p.requires || []).indexOf(id) >= 0; }).map(function (p) { return row[p.id] || 0; })); });
      var pos = {}, x = 0;
      if (gin.length) { x += 20; gin.forEach(function (id) { pos[id] = { x: x, w: GW, h: GH, ghost: 'in' }; }); x += GW + 44; }
      lanes.forEach(function (L, i) {
        var inner = L.nSub * NW + (L.nSub - 1) * CG;
        L.w = Math.max(inner + LP * 2, 300); L.x = x; L.last = i === lanes.length - 1;
        var x0 = x + (L.w - inner) / 2;
        L.ps.forEach(function (p) { pos[p.id] = { x: x0 + lr[p.id] * (NW + CG), w: NW, h: NH }; });
        x += L.w;
      });
      if (gout.length) { x += 44; gout.forEach(function (id) { pos[id] = { x: x, w: GW, h: GH, ghost: 'out' }; }); x += GW + 20; }
      var W = x;
      var rows = Object.keys(pos).map(function (id) { return row[id] || 0; });
      var minRow = rows.length ? Math.min.apply(null, rows) : 0, maxRow = rows.length ? Math.max.apply(null, rows) : 0;
      var nRails = PREF.flow ? D().clues.filter(function (c) { return c.plantedIn && isPuzzle(c.plantedIn); }).reduce(function (n, c) { return n + (c.usedBy || []).length; }, 0) : 0;
      var block = (maxRow - minRow) * (NH + RG) + NH + (nRails ? 60 : 0) + (PREF.crit ? 30 : 0);
      var viewH = Math.floor(($graph.clientHeight - 2) / PREF.zoom);
      var top = HH + Math.max(TOPPAD, Math.round((viewH - HH - block) / 2) - 10);
      var maxBottom = top + NH;
      Object.keys(pos).forEach(function (id) {
        var P = pos[id], cy = top + ((row[id] || 0) - minRow) * (NH + RG) + NH / 2;
        P.y = cy - P.h / 2; P.cy = cy;
        maxBottom = Math.max(maxBottom, P.y + P.h);
      });
      var edges = [];
      vis.forEach(function (p) { (p.requires || []).forEach(function (r) { if (pos[r]) edges.push({ from: r, to: p.id, ghost: !visSet.has(r), clues: [] }); }); });
      gout.forEach(function (u) { (Kit.get(u).requires || []).forEach(function (r) { if (visSet.has(r)) edges.push({ from: r, to: u, ghost: true, clues: [] }); }); });
      var rails = [];
      D().clues.forEach(function (c) {
        if (!c.plantedIn || !isPuzzle(c.plantedIn)) return;
        (c.usedBy || []).forEach(function (u) {
          if (!pos[c.plantedIn] || !pos[u] || (pos[u].ghost && pos[c.plantedIn].ghost)) return;
          var e = edges.find(function (x) { return x.from === c.plantedIn && x.to === u; });
          if (e) e.clues.push(c.id); else rails.push({ from: c.plantedIn, to: u, clue: c.id });
        });
      });
      var railY = maxBottom + 34;
      rails.forEach(function (r, i) { r.y = railY + i * 26; });
      var contentH = (rails.length ? railY + (rails.length - 1) * 26 + 30 : maxBottom + 40) + (PREF.crit ? 30 : 0);
      var H = Math.max(contentH, viewH);
      return { lanes: lanes, pos: pos, edges: edges, rails: rails, W: W, H: H, vis: vis, visSet: visSet };
    }

    /* ---------------- graph render ---------------- */
    function clueChip(cid) {
      var c = Kit.get(cid);
      if (!c) return '<span class="cchip">' + esc(cid) + '</span>';
      var cls = 'cchip', t = '';
      if (!c.plantedIn) { cls += ' unplanted'; t = ' — not planted yet'; }
      else if (isPuzzle(c.plantedIn)) { cls += ' derived'; t = ' — from solving ' + c.plantedIn; }
      if (S.hiClue === cid) cls += ' on';
      return '<span class="' + cls + '" data-ref="' + esc(cid) + '" data-clue="' + esc(cid) + '" aria-label="' + esc(cid + ' ' + c.text + t) + '">' + esc(cid) + '</span>';
    }
    function nodeClasses(p) {
      var cls = ['node', 'st-' + p.status];
      if (p.id === S.sel) cls.push('sel');
      if (S.multi.indexOf(p.id) >= 0) cls.push('msel');
      var pv = povState(p.id); if (pv) cls.push(pv);
      var sv = M.sev[p.id]; if (sv === 'high' || sv === 'med') cls.push('prob-' + sv);
      if (PREF.crit && M.crit.set.has(p.id)) cls.push('cp');
      return cls;
    }
    function nodeInner(p) {
      var pv = povState(p.id);
      var unpl = (p.inputs || []).some(function (cid) { var c = Kit.get(cid); return c && !c.plantedIn; });
      var nChecks = (p.checks || []).length, tot = D().designChecks.length;
      var checksShort = nChecks < tot && Kit.statusIndex(p.status) >= 3;
      var glyph = pv === 'solved' ? '<span class="n-st ok" title="Solved at this point">' + ic('check') + '</span>'
        : pv === 'locked' ? '<span class="n-st lk" title="Locked at this point">' + ic('lock') + '</span>'
        : pv === 'front' ? '<span class="n-next" title="Players can start it at this point">next</span>' : '';
      var rc = p.recipe && p.recipe.steps && p.recipe.steps.length ? Kit.checkRecipe(p.recipe) : null;
      return '<div class="n-top"><span class="id">' + esc(p.id) + '</span><span class="n-type">' + esc(kindLabel(p.kind)) + '</span>' +
        (unpl ? '<span class="n-dot" title="An input clue is not planted in any asset"></span>' : '') + Kit.pips(p.status) + '</div>' +
        '<div class="n-title"><span title="' + esc(p.title) + '">' + esc(p.title || 'Untitled') + '</span>' + glyph + '</div>' +
        '<div class="n-meta">' + Kit.diff(p.difficulty) + '<span class="num" title="Estimated solve time">' + fmtMin(p.estMin) + '</span>' +
          '<span class="n-checks' + (checksShort ? ' short' : '') + '" title="Design checks passed: ' + nChecks + ' of ' + tot + '">' + ic('check') + nChecks + '/' + tot + '</span>' +
          (rc ? '<span class="n-rc' + (rc.ok ? ' ok' : ' bad') + '" title="' + (rc.ok ? 'Cipher recipe verified' : 'Cipher recipe has a problem') + '">rcp</span>' : '') +
          ((p.hints || []).length ? '<span class="n-h" title="Has a hint">H' + p.hints.length + '</span>' : '') + '</div>' +
        '<div class="n-clues">' + ((p.inputs || []).length ? p.inputs.map(clueChip).join('') : '<span class="n-none">no input clues</span>') + '</div>' +
        '<div class="n-lay" aria-hidden="true">' + layerSegs(puzzleLayers(p)) + '</div>';
    }
    function nodeLabel(p) {
      var pv = povState(p.id);
      return p.id + ' ' + p.title + ', ' + kindLabel(p.kind) + ', ' + Kit.statusLabel(p.status) + ', difficulty ' + p.difficulty + (pv ? ', ' + (pv === 'front' ? 'next up' : pv) : '') + (S.multi.indexOf(p.id) >= 0 ? ', in selection' : '');
    }
    function curve(a, b) {
      var x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy;
      if (x2 < x1 + 12) {
        var low = Math.max(a.y + a.h, b.y + b.h) + 26;
        return { d: 'M' + x1 + ' ' + y1 + ' C' + (x1 + 70) + ' ' + y1 + ' ' + (x1 + 70) + ' ' + low + ' ' + ((x1 + x2) / 2) + ' ' + low + ' S' + (x2 - 70) + ' ' + y2 + ' ' + (x2 - 2) + ' ' + y2, mx: (x1 + x2) / 2, my: low, back: true };
      }
      var dx = Math.max(30, (x2 - x1) * 0.5);
      return { d: 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + (x2 - 2) + ' ' + y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
    }
    function renderGraph() {
      if (S.phone) { renderTrailList(); return; }
      $tlist.innerHTML = '';
      var L = layout(); LAYOUT = L;
      var z = PREF.zoom, h = '';
      L.lanes.forEach(function (ln) {
        var c = ln.ch, ps = c ? Kit.puzzlesIn(c.id) : ln.ps;
        var ready = ps.filter(function (p) { return p.status === 'ready'; }).length;
        h += '<div class="lane' + (ln.last ? ' last' : '') + '" style="left:' + ln.x + 'px;width:' + ln.w + 'px;height:' + L.H + 'px">' +
          (c ? '<button type="button" class="lane-h" data-lane="' + c.id + '" aria-pressed="' + (PREF.chapter === c.id) + '" title="' + (PREF.chapter === c.id ? 'Show all chapters' : 'Show only chapter ' + c.n) + '">' +
            '<span class="lane-top"><span class="eyebrow">' + esc(chShort(c)) + '</span><span class="lane-n">' + ps.length + ' puzzle' + (ps.length === 1 ? '' : 's') + '</span></span>' +
            '<span class="lane-title">' + esc(c.title) + '</span>' +
            '<span class="lane-sum">' + esc(c.summary || '') + '</span>' +
            '<span class="lane-meta"><span>' + fmtMin(sum(ps.map(function (p) { return p.estMin; }))) + ' play</span><span>' + ready + '/' + ps.length + ' ready</span></span></button>'
            : '<div class="lane-h"><span class="eyebrow">No chapter</span><span class="lane-title">Unassigned</span></div>') +
          (ln.ps.length ? '' : '<span class="lane-empty" style="left:' + LP + 'px;top:' + (HH + TOPPAD) + 'px">No puzzles in this chapter yet.</span>') +
          '</div>';
      });
      var svg = '<svg class="edges" width="' + L.W + '" height="' + L.H + '" viewBox="0 0 ' + L.W + ' ' + L.H + '" aria-hidden="true"><defs>' +
        ['def', 'hi', 'acc', 'faint', 'bad'].map(function (k) {
          return '<marker id="trmk-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="mk-' + k + '" d="M0 0 L10 5 L0 10 z"/></marker>';
        }).join('') + '</defs>';
      var chips = '';
      L.edges.forEach(function (e) {
        var a = L.pos[e.from], b = L.pos[e.to], c = curve(a, b);
        var cls = ['e'], mk = 'def';
        var fp = Kit.get(e.from), tp = Kit.get(e.to);
        var bad = fp && tp && chN(fp.chapter) > chN(tp.chapter);
        if (e.ghost) cls.push('ghostl');
        if (M.pv.on) {
          var fs = povState(e.from), ts = povState(e.to);
          if (fs === 'solved' && ts === 'solved') { cls.push('done'); mk = 'faint'; }
          else if (fs === 'solved' && ts === 'front') { cls.push('next'); mk = 'acc'; }
          else if (ts === 'locked') cls.push('dim');
        }
        if (S.sel && (e.from === S.sel || e.to === S.sel) && mk !== 'acc') { cls.push('hi'); mk = 'hi'; }
        if (PREF.crit && M.crit.edges.has(e.from + '>' + e.to)) { cls.push('cp'); mk = 'acc'; }
        if (bad || c.back) { cls.push('bad'); mk = 'bad'; }
        svg += '<path class="' + cls.join(' ') + '" d="' + c.d + '" marker-end="url(#trmk-' + mk + ')"/>';
        var gap = b.x - (a.x + a.w);
        if (PREF.flow) e.clues.forEach(function (cid, i) {
          var cl = Kit.get(cid);
          chips += '<button type="button" class="echip' + (S.hiClue === cid ? ' on' : '') + '" style="left:' + c.mx + 'px;top:' + (c.my + i * 22) + 'px" data-to="' + e.to + '" data-clue="' + cid + '" data-ref="' + cid + '" aria-label="Clue ' + cid + ' ' + esc(cl.text) + ' passes from ' + e.from + ' to ' + e.to + '">' +
            '<span class="k">' + cid + '</span>' + (gap >= 170 ? '<span class="t">' + esc(cl.text) + '</span>' : '') + '</button>';
        });
      });
      if (PREF.flow) L.rails.forEach(function (r) {
        var a = L.pos[r.from], b = L.pos[r.to], R = 10;
        var sx = a.x + a.w / 2 + 24, tx = b.x + b.w / 2 - 24, y0 = a.y + a.h, y1 = b.y + b.h, ry = r.y;
        var dir = tx >= sx ? 1 : -1;
        var d = 'M' + sx + ' ' + y0 + ' V' + (ry - R) + ' Q' + sx + ' ' + ry + ' ' + (sx + dir * R) + ' ' + ry +
          ' H' + (tx - dir * R) + ' Q' + tx + ' ' + ry + ' ' + tx + ' ' + (ry - R) + ' V' + (y1 + 3);
        svg += '<path class="rail" d="' + d + '" marker-end="url(#trmk-hi)"/>';
        var cl = Kit.get(r.clue);
        chips += '<button type="button" class="echip' + (S.hiClue === r.clue ? ' on' : '') + '" style="left:' + ((sx + tx) / 2) + 'px;top:' + ry + 'px" data-to="' + r.to + '" data-clue="' + r.clue + '" data-ref="' + r.clue + '" aria-label="Clue ' + r.clue + ' passes from ' + r.from + ' to ' + r.to + '">' +
          '<span class="k">' + r.clue + '</span><span class="t">' + esc(cl.text) + '</span><span class="k">' + r.from + '→' + r.to + '</span></button>';
      });
      svg += '</svg>';
      h += svg + chips;
      L.vis.forEach(function (p) {
        var P = L.pos[p.id];
        h += '<div class="' + nodeClasses(p).join(' ') + '" role="button" tabindex="0" data-id="' + p.id + '" aria-pressed="' + (p.id === S.sel || S.multi.indexOf(p.id) >= 0) + '" aria-label="' + esc(nodeLabel(p)) + '" style="left:' + P.x + 'px;top:' + P.y + 'px">' + nodeInner(p) + '</div>';
      });
      Object.keys(L.pos).forEach(function (id) {
        var P = L.pos[id]; if (!P.ghost) return;
        var p = Kit.get(id), c = Kit.chapter(p.chapter);
        h += '<button type="button" class="gnode" data-ghost="' + id + '" style="left:' + P.x + 'px;top:' + P.y + 'px" title="Show ' + id + ' in the full trail">' +
          '<b>' + id + ' ' + esc(p.title) + '</b><span>' + (P.ghost === 'in' ? 'needed from ' : 'continues in ') + esc(chShort(c)) + '</span></button>';
      });
      if (PREF.crit && M.crit.end && L.pos[M.crit.end] && !L.pos[M.crit.end].ghost) {
        var E = L.pos[M.crit.end];
        h += '<span class="cp-end" style="left:' + E.x + 'px;top:' + (E.y + E.h + 10) + 'px">Critical path · ' + M.crit.ids.length + ' puzzles · ' + fmtMin(M.crit.total) + '</span>';
      }
      $world.innerHTML = h;
      $world.style.width = L.W + 'px'; $world.style.height = L.H + 'px';
      $world.style.transform = 'scale(' + z + ')';
      $gsize.style.width = Math.ceil(L.W * z) + 'px'; $gsize.style.height = Math.ceil(L.H * z) + 'px';
    }

    /* ---------------- trail list (phone) ---------------- */
    function renderTrailList() {
      $world.innerHTML = '';
      var k = PREF.pov, known = knownAt(k), front = frontierOf(new Set(solvedAt(k)));
      var h = '<details class="pov-m" id="pov-m"' + (S.povMOpen ? ' open' : '') + '><summary>' +
        '<div class="pv-top"><span class="eyebrow">Player view · ' + k + ' / ' + M.N + '</span><span class="chev">' + ic('down') + '</span></div>' +
        '<div class="sumline"><b>' + esc(povTitle(k)) + '</b></div>' +
        '<div class="lbar">' + (known.size ? layerSegs(layerCounts(known)) : '') + '</div>' +
        '<div class="sumline">Players know ' + known.size + ' things · next up ' + (front.length ? front.join(', ') : 'nothing') + '</div>' +
        '</summary><div class="pv">' + povBody(false) + '</div></details>';
      visibleChapters().forEach(function (c) {
        var ps = M.order.filter(function (p) { return p.chapter === c.id; });
        h += '<section class="tl-act"><button type="button" class="tl-ah" data-lane="' + c.id + '">' +
          '<span class="lane-top"><span class="eyebrow">' + esc(chShort(c)) + '</span><span class="lane-n">' + ps.length + ' puzzles · ' + fmtMin(sum(ps.map(function (p) { return p.estMin; }))) + '</span></span>' +
          '<span class="lane-title">' + esc(c.title) + '</span><span class="lane-sum">' + esc(c.summary || '') + '</span></button><ol class="tl">';
        ps.forEach(function (p) {
          var pv = povState(p.id), cls = nodeClasses(p);
          cls.push('flow');
          var gets = D().clues.filter(function (cl) { return (p.inputs || []).indexOf(cl.id) >= 0 && cl.plantedIn && isPuzzle(cl.plantedIn); });
          h += '<li class="tl-i ' + (pv || '') + (PREF.crit && M.crit.set.has(p.id) ? ' cp' : '') + '"><span class="tl-dot">' + (pv === 'solved' ? ic('check') : pv === 'locked' ? ic('lock') : '') + '</span>' +
            '<div class="' + cls.join(' ') + '" role="button" tabindex="0" data-id="' + p.id + '" aria-pressed="' + (p.id === S.sel || S.multi.indexOf(p.id) >= 0) + '" aria-label="' + esc(nodeLabel(p)) + '">' + nodeInner(p) +
            '<div class="tl-needs">' + ((p.requires || []).length ? '<span><b>needs</b> ' + p.requires.join(', ') + '</span>' : '<span>trailhead</span>') +
            (gets.length ? '<span><b>gets</b> ' + gets.map(function (cl) { return cl.id + ' from ' + cl.plantedIn; }).join(', ') + '</span>' : '') +
            (Kit.unlocks(p.id).length ? '<span><b>unlocks</b> ' + Kit.unlocks(p.id).join(', ') + '</span>' : (p.final ? '<span>finale</span>' : '')) + '</div></div></li>';
        });
        if (!ps.length) h += '<li class="kn-empty">No puzzles in this chapter yet.</li>';
        h += '</ol></section>';
      });
      $tlist.innerHTML = h;
      var det = $('pov-m');
      det.addEventListener('toggle', function () { S.povMOpen = det.open; updateToolbar(); });
      det.addEventListener('click', onPovClick);
    }

    /* ---------------- pacing strip ---------------- */
    function renderPacing() {
      var ord = M.order, n = ord.length;
      $('pc-flags').innerHTML = Object.keys(M.spikes).length ? 'Spikes ' + Object.keys(M.spikes).sort(function (a, b) { return M.idx[a] - M.idx[b]; }).map(function (id) {
        return '<button type="button" class="cchip" data-pc="' + id + '" title="' + esc(M.spikes[id]) + '">' + id + '</button>';
      }).join('') : '';
      if (!PREF.pacingOpen || !n) { $pc.innerHTML = ''; return; }
      var cw = $pc.clientWidth || 600;
      var W = Math.max(cw, 56 + n * (S.phone ? 40 : 34)), H = 92;
      var Lg = 50, Rg = 12, band = (W - Lg - Rg) / n;
      var dTop = 8, dBot = 30, mTop = 40, mBase = 77;
      var maxM = 30;
      ord.forEach(function (p) { maxM = Math.max(maxM, +p.estMin || 0); });
      maxM = Math.ceil(maxM / 30) * 30;
      function ym(m) { return mBase - (m / maxM) * (mBase - mTop); }
      function yd(d) { return dBot - (clamp(+d || 1, 1, 5) - 1) / 4 * (dBot - dTop); }
      var s = '<svg class="pc-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Pacing: estimated minutes and difficulty for each puzzle in trail order">';
      ord.forEach(function (p, i) {
        s += '<rect class="pc-hit" x="' + (Lg + i * band) + '" y="0" width="' + band + '" height="' + H + '" data-id="' + p.id + '" tabindex="0" role="button" aria-label="' + esc(p.id + ' ' + p.title + ', ' + p.estMin + ' minutes, difficulty ' + p.difficulty) + '"/>';
      });
      s += '<g class="mark">';
      [60, 120, 180, 240].forEach(function (m) { if (m <= maxM) s += '<line class="pc-grid" x1="' + Lg + '" x2="' + (W - Rg) + '" y1="' + ym(m) + '" y2="' + ym(m) + '"/><text x="' + (Lg - 6) + '" y="' + (ym(m) + 3) + '" text-anchor="end">' + m + '</text>'; });
      s += '<line class="pc-base" x1="' + Lg + '" x2="' + (W - Rg) + '" y1="' + mBase + '" y2="' + mBase + '"/><text x="' + (Lg - 6) + '" y="' + (mBase + 3) + '" text-anchor="end">0</text>';
      s += '<text class="lab" x="4" y="' + (mBase - 14) + '">min</text><text class="lab" x="4" y="' + (dBot - 6) + '">diff</text>';
      s += '<text x="' + (Lg - 6) + '" y="' + (yd(5) + 3) + '" text-anchor="end">5</text><text x="' + (Lg - 6) + '" y="' + (yd(1) + 3) + '" text-anchor="end">1</text>';
      s += '<line class="pc-grid" x1="' + Lg + '" x2="' + (W - Rg) + '" y1="' + yd(1) + '" y2="' + yd(1) + '"/>';
      ord.forEach(function (p, i) {
        if (i === 0 || p.chapter !== ord[i - 1].chapter) {
          var x = Lg + i * band, c = Kit.chapter(p.chapter);
          if (i > 0) s += '<line class="pc-act" x1="' + x + '" x2="' + x + '" y1="2" y2="' + (mBase + 4) + '"/>';
          s += '<text x="' + (x + 4) + '" y="' + (mTop - 3) + '">' + esc(c ? 'CH ' + c.n : '—') + '</text>';
        }
      });
      var bw = Math.min(22, band * 0.5);
      ord.forEach(function (p, i) {
        var cx = Lg + (i + 0.5) * band, top = ym(+p.estMin || 0), hgt = mBase - top, r = Math.min(4, hgt, bw / 2);
        var dim = PREF.chapter !== 'all' && p.chapter !== PREF.chapter;
        var x0 = cx - bw / 2, x1 = cx + bw / 2;
        var cls = 'pc-bar' + (p.id === S.sel ? ' sel' : S.multi.indexOf(p.id) >= 0 ? ' msel' : '') + (dim ? ' pc-dim' : '');
        if (hgt > 0) s += '<path class="' + cls + '" d="M' + x0 + ' ' + mBase + ' V' + (top + r) + ' Q' + x0 + ' ' + top + ' ' + (x0 + r) + ' ' + top + ' H' + (x1 - r) + ' Q' + x1 + ' ' + top + ' ' + x1 + ' ' + (top + r) + ' V' + mBase + ' Z"/>';
        s += '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" class="' + (p.id === S.sel ? 'sel' : '') + '">' + p.id + '</text>';
      });
      s += '<polyline class="pc-dline" points="' + ord.map(function (p, i) { return (Lg + (i + 0.5) * band) + ',' + yd(p.difficulty); }).join(' ') + '"/>';
      ord.forEach(function (p, i) {
        var cx = Lg + (i + 0.5) * band, cy = yd(p.difficulty), dim = PREF.chapter !== 'all' && p.chapter !== PREF.chapter;
        if (M.spikes[p.id]) s += '<circle class="pc-spike" cx="' + cx + '" cy="' + cy + '" r="7.5"/>';
        s += '<circle class="pc-dot' + (p.difficulty >= 4 ? ' hard' : '') + (dim ? ' pc-dim' : '') + '" cx="' + cx + '" cy="' + cy + '" r="4"/>';
      });
      if (PREF.pov > 0) { var px = Lg + PREF.pov * band; s += '<line class="pc-pov" x1="' + px + '" x2="' + px + '" y1="2" y2="' + (mBase + 4) + '"/>'; }
      s += '</g></svg>';
      $pc.innerHTML = s;
    }
    function showTip(rect) {
      var p = Kit.get(rect.dataset.id); if (!p) return;
      $tip.innerHTML = '<div class="tt">' + esc(p.id + ' · ' + p.title) + '</div>' +
        '<div class="tm">est ' + fmtMin(p.estMin) + ' · difficulty ' + p.difficulty + '/5 · ' + esc(kindLabel(p.kind)) + ' · ' + esc(chShort(Kit.chapter(p.chapter))) + '</div>' +
        (M.spikes[p.id] ? '<div class="tw">Spike: ' + esc(M.spikes[p.id]) + '</div>' : '');
      $tip.hidden = false;
      var r = rect.getBoundingClientRect(), pr = $('pacing').getBoundingClientRect(), tb = $tip.getBoundingClientRect();
      $tip.style.left = clamp(r.left + r.width / 2 - tb.width / 2, 8, window.innerWidth - tb.width - 8) + 'px';
      $tip.style.top = Math.max(8, pr.top - tb.height - 6) + 'px';
      Array.prototype.forEach.call($pc.querySelectorAll('.pc-hit.hover'), function (x) { x.classList.remove('hover'); });
      rect.classList.add('hover');
    }
    function hideTip() { $tip.hidden = true; Array.prototype.forEach.call($pc.querySelectorAll('.pc-hit.hover'), function (x) { x.classList.remove('hover'); }); }
    $pc.addEventListener('pointerover', function (e) { var r = e.target.closest('.pc-hit'); if (r && e.pointerType === 'mouse') showTip(r); });
    $pc.addEventListener('pointerleave', hideTip);
    $pc.addEventListener('focusin', function (e) { var r = e.target.closest('.pc-hit'); if (r) showTip(r); });
    $pc.addEventListener('focusout', hideTip);
    $pc.addEventListener('click', function (e) { var r = e.target.closest('.pc-hit'); if (r) { hideTip(); pickNode(r.dataset.id, e); } });
    $pc.addEventListener('keydown', function (e) { var r = e.target.closest('.pc-hit'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(r.dataset.id); } });
    $('pc-flags').addEventListener('click', function (e) { var c = e.target.closest('[data-pc]'); if (c) select(c.dataset.pc); });

    /* ---------------- inspector ---------------- */
    function sec(title, right, body, extra) {
      return '<section class="in-sec"' + (extra || '') + '><div class="sec-head"><span class="eyebrow">' + title + '</span>' + (right || '') + '</div>' + body + '</section>';
    }
    function refList(ids, removable) {
      if (!ids.length) return '';
      return '<div class="rlist">' + ids.map(function (id) {
        return removable ? '<span class="rm-wrap">' + Kit.refHtml(id) + '<button type="button" class="rm" data-rm="' + removable + '" data-id="' + esc(id) + '" aria-label="Remove ' + esc(id) + '">' + ic('x') + '</button></span>' : Kit.refHtml(id);
      }).join('') + '</div>';
    }
    function assetStatus(a) {
      var cls = a.status === 'placed' || a.status === 'ready' ? 'ok' : a.status === 'idea' ? 'warn' : '';
      return '<span class="st-dot ' + cls + '">' + esc(a.status) + '</span>';
    }
    function ta(fk, field, value, opts) {
      opts = opts || {};
      return '<textarea class="input' + (opts.spoil ? ' spoil' : '') + (opts.doc ? ' doc' : '') + '" rows="' + (opts.rows || 2) + '" data-fk="' + fk + '" data-field="' + field + '"' +
        (opts.i != null ? ' data-i="' + opts.i + '"' : '') + ' aria-label="' + esc(opts.label || field) + '" placeholder="' + esc(opts.ph || '') + '">' + esc(value || '') + '</textarea>';
    }
    function listEditor(p, field, opts) {
      var arr = p[field] || [];
      var n = arr.length;
      return (n ? '<ol class="ladder' + (opts.spoil ? ' spoil-list' : '') + '">' + arr.map(function (t, i) {
        return '<li class="rung" data-i="' + i + '"><span class="rung-n">' + (i + 1) + '</span>' +
          ta(field + i, field, t, { i: i, spoil: opts.spoil, label: opts.item + ' ' + (i + 1), ph: opts.ph }) +
          '<div class="rung-tools">' +
            (opts.order ? '<button type="button" class="ib" data-lop="up" data-field="' + field + '" data-i="' + i + '" data-fk="' + field + 'up' + i + '" aria-label="Move ' + opts.item.toLowerCase() + ' ' + (i + 1) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + ic('up') + '</button>' +
            '<button type="button" class="ib" data-lop="down" data-field="' + field + '" data-i="' + i + '" data-fk="' + field + 'down' + i + '" aria-label="Move ' + opts.item.toLowerCase() + ' ' + (i + 1) + ' down"' + (i === n - 1 ? ' disabled' : '') + '>' + ic('down') + '</button>' : '') +
            '<button type="button" class="ib" data-lop="del" data-field="' + field + '" data-i="' + i + '" data-fk="' + field + 'del' + i + '" aria-label="Remove ' + opts.item.toLowerCase() + ' ' + (i + 1) + '">' + ic('trash') + '</button>' +
          '</div></li>';
      }).join('') + '</ol>' : '<div class="list-empty">' + esc(opts.empty) + '</div>') +
        '<div class="ctl-row"><button type="button" class="btn sm" data-lop="add" data-field="' + field + '" data-fk="' + field + 'add">' + ic('plus') + esc(opts.add) + '</button>' +
        (opts.help ? '<span class="help">' + esc(opts.help) + '</span>' : '') + '</div>';
    }
    function emptyInspector() {
      return '<div class="in-empty"><span class="eyebrow">Nothing selected</span>' +
        '<p>Click a puzzle in the trail or a bar in the pacing strip. Shift-click (or use <b>Select</b>) to pick several and export them together.</p>' +
        '<div class="acts">' + Kit.chapters().map(function (c) {
          var ps = Kit.puzzlesIn(c.id);
          return '<button type="button" data-chpick="' + c.id + '"><b>' + esc(chShort(c) + ' · ' + c.title) + '</b><span>' + ps.length + ' puzzles · ' + fmtMin(sum(ps.map(function (p) { return p.estMin; }))) + '</span>' +
            '<span class="sum">' + esc(c.summary || '') + '</span></button>';
        }).join('') + '</div>' +
        '<div><span class="eyebrow">Critical path · ' + fmtMin(M.crit.total) + '</span><div class="rlist" style="margin-top:6px">' + M.crit.ids.map(function (id) { return Kit.refHtml(id, { idOnly: true }); }).join('') + '</div></div></div>';
    }
    function inspectorHtml(p) {
      var c = Kit.chapter(p.chapter), pv = povState(p.id);
      var probs = M.problems.filter(function (x) { return x.ids.indexOf(p.id) >= 0; });
      var lc = puzzleLayers(p);
      var h = '<div class="in' + (PREF.spoil ? ' reveal' : '') + '">';
      var pvLine = '';
      if (pv) {
        var missing = (p.requires || []).filter(function (r) { return !M.pv.solved.has(r); });
        pvLine = '<div class="in-pov ' + pv + '">' + (pv === 'solved' ? ic('check') + 'Solved by this point (' + esc(povTitle(PREF.pov)) + ')'
          : pv === 'front' ? 'Next up: players at this point can start it now'
          : ic('lock') + 'Locked at this point. Still needs ' + esc(missing.join(', ')) + '.') + '</div>';
      }
      h += '<header class="in-head">' +
        '<div class="in-row1"><span class="eyebrow"><span class="ph-id">' + esc(p.id) + ' · </span>' + esc(c ? chShort(c) + ' · ' + c.title : 'No chapter') + '</span>' +
          '<button type="button" class="ib bare in-close" data-fk="close" aria-label="Close inspector" title="Close (Esc)">' + ic('x') + '</button></div>' +
        '<div class="in-title"><span class="id">' + esc(p.id) + '</span><input class="input title-in" data-fk="title" data-field="title" value="' + esc(p.title) + '" aria-label="Title"></div>' +
        '<div class="in-sub"><span class="chip">' + esc(kindLabel(p.kind)) + '</span>' +
          '<span class="in-touch" title="Reality layers of the clues, reveals and mysteries this puzzle touches">touches <span class="lbar sm">' + layerSegs(lc) + '</span>' +
          layerIds().filter(function (l) { return lc[l]; }).map(function (l) { return Kit.layer(l).short + ' ' + lc[l]; }).join(' · ') + '</span>' +
          (M.crit.set.has(p.id) ? '<span class="cp-tag" title="On the longest route through the trail">critical path</span>' : '') + '</div>' +
        pvLine +
        '<div class="in-acts">' +
          '<button type="button" class="btn sm" data-act="page" data-fk="a-page">' + ic('page') + 'Open page</button>' +
          '<button type="button" class="btn sm" data-act="crafter" data-fk="a-craft">' + ic('wrench') + 'Open in Crafter</button>' +
          '<button type="button" class="btn sm" data-act="export" data-fk="a-exp">' + ic('out') + 'Export from here…</button>' +
        '</div>' +
        '<div class="in-ctrls">' +
          '<label class="lbl" for="tr-status">Status</label><div class="ctl-row"><select id="tr-status" class="input sm" data-fk="status" data-field="status">' +
            D().statuses.map(function (s) { return '<option value="' + s.id + '"' + (s.id === p.status ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') +
            '</select>' + Kit.pips(p.status) + '</div>' +
          '<span class="lbl" id="tr-dlbl">Difficulty</span><div class="dpick' + (p.difficulty >= 4 ? ' hard' : '') + '" role="radiogroup" aria-labelledby="tr-dlbl">' +
            [1, 2, 3, 4, 5].map(function (d) {
              return '<button type="button" role="radio" aria-checked="' + (d === p.difficulty) + '" aria-label="Difficulty ' + d + '" class="' + (d <= p.difficulty ? 'on' : '') + '" data-d="' + d + '" data-fk="d' + d + '"><i style="height:' + (6 + d * 3) + 'px"></i></button>';
            }).join('') + '<span class="num">' + (p.difficulty || '—') + ' / 5</span></div>' +
          '<label class="lbl" for="tr-est">Est. time</label><div class="ctl-row"><input id="tr-est" class="input sm num est" type="number" inputmode="numeric" min="1" max="600" step="5" value="' + esc(p.estMin) + '" data-fk="est" data-field="estMin"><span class="muted">min</span></div>' +
          '<label class="lbl" for="tr-chap">Chapter</label><div class="ctl-row"><select id="tr-chap" class="input sm" data-fk="chapter" data-field="chapter">' +
            Kit.chapters().map(function (x) { return '<option value="' + x.id + '"' + (x.id === p.chapter ? ' selected' : '') + '>' + esc(x.n + ' · ' + x.title) + '</option>'; }).join('') + '</select></div>' +
          '<label class="lbl" for="tr-kind">Kind</label><div class="ctl-row"><select id="tr-kind" class="input sm" data-fk="kind" data-field="kind">' +
            D().puzzleKinds.map(function (x) { return '<option value="' + x.id + '"' + (x.id === p.kind ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select></div>' +
        '</div></header>';
      if (probs.length) {
        h += sec('Watch out', '<span class="count">' + probs.length + '</span>', '<ul class="plist">' + probs.map(function (pr) {
          return '<li class="prow"><span class="sev sev-' + pr.severity + '">' + pr.severity + '</span><span><b>' + esc(pr.kind) + '.</b> <span class="muted">' + esc(pr.text) + '</span></span></li>';
        }).join('') + '</ul>');
      }
      h += sec('Premise', '<span class="count">what players see</span>', ta('premise', 'premise', p.premise, { rows: 3, label: 'Premise', ph: 'What the player is shown…' }));
      h += sec('Mechanic', '<span class="count">how it works</span>', ta('mechanic', 'mechanic', p.mechanic, { rows: 3, label: 'Mechanic', ph: 'How the puzzle works…' }));
      var spoilBtn = '<button type="button" class="linkish" data-act="spoil" data-fk="spoil" aria-pressed="' + PREF.spoil + '">' + ic('eye') + (PREF.spoil ? 'Hide spoilers' : 'Show spoilers') + '</button>';
      h += sec('Solution', spoilBtn, ta('solution', 'solution', p.solution, { rows: 2, spoil: true, label: 'Solution', ph: 'The answer and how it is reached…' }) +
        '<div class="aha"><label class="lbl" for="tr-aha">Aha</label><input id="tr-aha" class="input spoil" data-fk="aha" data-field="aha" value="' + esc(p.aha || '') + '" placeholder="The key insight in one line" aria-label="Aha"></div>');
      h += sec('Solve path', '<span class="count">' + (p.solvePath || []).length + ' steps</span>', listEditor(p, 'solvePath', { spoil: true, order: true, item: 'Step', add: 'Add step', empty: 'No steps yet. Write what the player actually does, in order.', ph: 'What the player does…' }));
      var checks = p.checks || [];
      h += sec('Design checks', '<span class="count' + (checks.length < D().designChecks.length && Kit.statusIndex(p.status) >= 3 ? ' warn' : '') + '">' + checks.length + ' of ' + D().designChecks.length + '</span>',
        '<div class="checks">' + D().designChecks.map(function (dc) {
          return '<label class="check-row"><input type="checkbox" data-check="' + dc.id + '" data-fk="ck-' + dc.id + '"' + (checks.indexOf(dc.id) >= 0 ? ' checked' : '') + '>' + esc(dc.label) + '</label>';
        }).join('') + '</div>');
      if (p.recipe || p.kind === 'cipher' || p.kind === 'audio') {
        var body;
        if (p.recipe && p.recipe.steps && p.recipe.steps.length) {
          var rc = Kit.checkRecipe(p.recipe);
          body = '<div class="rc ' + (rc.ok ? 'ok' : 'bad') + '">' + (rc.ok ? ic('check') + '<span>Recipe verified: the steps build the stored output' + (rc.roundTrip != null ? ' and decode back to the plaintext' : '') + '.</span>'
            : ic('alert') + '<span>' + esc(rc.problems.join(' ')) + '</span>') + '</div>' +
            '<div class="rc-steps spoil-box">' + p.recipe.steps.map(function (st) {
              var op = Kit.ops[st.op]; var params = Object.keys(st).filter(function (k2) { return k2 !== 'op'; }).map(function (k2) { return k2 + ' ' + st[k2]; }).join(', ');
              return '<span class="chip">' + esc(op ? op.label : st.op) + (params ? ' · ' + esc(params) : '') + '</span>';
            }).join('<span class="faint">→</span>') + '</div>';
        } else body = '<p class="small muted">No recipe yet. Build and verify the cipher in the Crafter.</p>';
        h += sec('Recipe', '<button type="button" class="linkish" data-act="crafter">Open in Crafter</button>', body);
      }
      var clues = (p.inputs || []).map(function (cid) {
        var cl = Kit.get(cid); if (!cl) return '';
        var pn = chN(p.chapter), src, bad = false;
        function assetOptions(cur) {
          return D().assets.slice().sort(function (x, y) { return chN(x.chapter) - chN(y.chapter); }).map(function (as) {
            var late = chN(as.chapter) > pn;
            return '<option value="' + as.id + '"' + (as.id === cur ? ' selected' : '') + '>' + esc(as.id + ' · ' + as.name + ' · ' + as.status + (late ? ' (too late)' : '')) + '</option>';
          }).join('');
        }
        if (!cl.plantedIn) {
          bad = true;
          src = '<div class="clue-src bad">Not planted — needs an asset</div><div class="clue-src"><select class="input sm plant" data-clue="' + cid + '" data-fk="pl-' + cid + '" aria-label="Plant ' + cid + ' in an asset">' +
            '<option value="">Plant in an asset…</option>' + assetOptions(null) + '</select></div>';
        } else if (isPuzzle(cl.plantedIn)) {
          src = '<div class="clue-src">From solving ' + Kit.refHtml(cl.plantedIn) + '</div>';
        } else {
          var as = Kit.get(cl.plantedIn);
          src = '<div class="clue-src">Planted in ' + Kit.refHtml(cl.plantedIn, { idOnly: true }) + ' ' + esc(as ? as.name : '') + (as ? assetStatus(as) : '') +
            '<select class="input sm plant mini" data-clue="' + cid + '" data-fk="pl-' + cid + '" aria-label="Move ' + cid + ' to another asset"><option value="">Move…</option>' + assetOptions(null) + '</select></div>';
        }
        var others = (cl.usedBy || []).filter(function (u) { return u !== p.id; });
        return '<li class="clue' + (bad ? ' bad' : '') + (S.hiClue === cid ? ' hi' : '') + '" data-clue-row="' + cid + '">' +
          '<div class="clue-top"><span class="id">' + cid + '</span>' + (cl.layer ? Kit.layerBadge(cl.layer, { short: true }) : '') + '<span>' + esc(cl.kind) + '</span>' +
          '<button type="button" class="rm" data-rm="inputs" data-id="' + cid + '" aria-label="Remove ' + cid + ' from this puzzle">' + ic('x') + '</button></div>' +
          '<div class="clue-text doc">' + esc(cl.text) + '</div>' + src +
          (others.length ? '<div class="clue-src">Also used by ' + others.map(function (u) { return Kit.refHtml(u, { idOnly: true }); }).join(' ') + '</div>' : '') + '</li>';
      }).join('');
      h += sec('Clues in', '<span class="count">' + (p.inputs || []).length + '</span>', (clues ? '<ul class="clues">' + clues + '</ul>' : '<p class="small muted">No input clues yet.</p>') +
        '<div class="ctl-row"><button type="button" class="btn sm" data-act="add-clue" data-fk="add-clue">' + ic('plus') + 'Add clue</button></div>');
      var outs = D().clues.filter(function (cl) { return cl.plantedIn === p.id; });
      var unl = Kit.unlocks(p.id);
      h += sec('Trail', '',
        '<div class="kv">' +
          '<span class="lbl">Needs</span><div class="rows">' + ((p.requires || []).length ? refList(p.requires, 'requires') : '<span class="small muted">Nothing. This is a trailhead.</span>') +
            '<div><button type="button" class="btn sm ghost" data-act="add-req" data-fk="add-req">' + ic('plus') + 'Add requirement</button></div></div>' +
          '<span class="lbl">Unlocks</span>' + (unl.length ? refList(unl) : '<span class="small ' + (p.final ? 'muted' : 'st-dot warn') + '">' + (p.final ? 'Nothing. This is the finale.' : 'Nothing. The trail stops here.') + '</span>') +
          '<span class="lbl">Reveals</span>' + ((p.reveals || []).length ? refList(p.reveals) : '<span class="small muted">Nothing yet</span>') +
          (outs.length ? '<span class="lbl">Hands on</span><div class="rows">' + outs.map(function (cl) {
            return '<div class="row">' + Kit.refHtml(cl.id) + '<span class="muted">→ ' + esc((cl.usedBy || []).join(', ')) + '</span></div>';
          }).join('') + '</div>' : '') +
          '<span class="lbl">Finale</span><label class="check-row small"><input type="checkbox" data-final="1" data-fk="final"' + (p.final ? ' checked' : '') + '>This is the last puzzle (allowed to unlock nothing)</label>' +
        '</div>');
      h += sec('Hints', '<span class="count">rare · ' + (p.hints || []).length + '</span>', listEditor(p, 'hints', { item: 'Hint', add: 'Add hint', empty: 'No hints. Most puzzles have none.', ph: 'A nudge, only if the trail truly needs it…' }));
      h += sec('Assets', '<span class="count">' + (p.assets || []).length + '</span>',
        ((p.assets || []).length ? '<div class="rows">' + p.assets.map(function (aid) {
          var as = Kit.get(aid); if (!as) return '';
          var extra = (as.carries || []).filter(function (cc) { return (p.inputs || []).indexOf(cc) < 0; });
          return '<div class="row">' + Kit.refHtml(aid) + assetStatus(as) +
            (extra.length ? '<span class="muted">also carries</span>' + extra.map(function (cc) {
              var co = Kit.get(cc); return '<span class="cchip' + (co && !(co.usedBy || []).length ? ' unplanted' : '') + (S.hiClue === cc ? ' on' : '') + '" data-ref="' + cc + '" title="' + (co && !(co.usedBy || []).length ? 'Orphan: no puzzle uses it' : '') + '">' + cc + '</span>';
            }).join('') : '') + '</div>';
        }).join('') + '</div>' : '<p class="small muted">No assets yet.</p>'));
      var people = D().characters.filter(function (ch) { return ch.guard && (ch.appears || []).indexOf(p.id) >= 0; });
      h += sec('Mysteries', '<span class="count">' + (p.mysteries || []).length + '</span>',
        ((p.mysteries || []).length ? '<div class="rows">' + p.mysteries.map(function (mid) {
          var m = Kit.get(mid); if (!m) return '';
          return '<div class="row">' + Kit.refHtml(mid) + Kit.layerBadge(m.layer, { short: true }) + '<span class="muted num">' + esc(m.year || '') + '</span></div>';
        }).join('') + '</div>' : '<p class="small muted">Not anchored to a real mystery.</p>') +
        people.map(function (ch) { return '<div class="guard"><span class="eyebrow">Real person</span><b>' + esc(ch.name) + '.</b> ' + esc(ch.guard) + '</div>'; }).join(''));
      var res = D().research.filter(function (r) { return (r.supports || []).indexOf(p.id) >= 0 || (p.mysteries || []).some(function (m) { return (r.supports || []).indexOf(m) >= 0; }); });
      if (res.length) h += sec('Research', '<span class="count">' + res.length + '</span>', '<div class="rows">' + res.map(function (r) {
        var direct = (r.supports || []).indexOf(p.id) >= 0;
        return '<div class="row">' + Kit.refHtml(r.id) + '<span class="st-dot ' + (r.status === 'verified' ? 'ok' : direct ? 'warn' : '') + '">' + esc(r.status) + '</span><span class="muted">' + esc(r.reliability || '') + '</span></div>';
      }).join('') + '</div>');
      var qt = Kit.backlinks(p.id).filter(function (id) {
        var o = Kit.get(id), t = Kit.type(id);
        return (t === 'question' && o.status === 'open') || (t === 'task' && o.status !== 'done');
      });
      if (qt.length) h += sec('Open questions & tasks', '<span class="count">' + qt.length + '</span>', '<ul class="plist">' + qt.map(function (id) {
        var o = Kit.get(id);
        if (Kit.type(id) === 'question') return '<li class="prow"><span class="sev sev-' + o.severity + '">' + o.severity + '</span><span>' + Kit.refHtml(id, { idOnly: true }) + ' ' + esc(o.text) + '</span></li>';
        return '<li class="prow"><span class="st-dot">' + esc(o.status) + '</span><span>' + Kit.refHtml(id, { idOnly: true }) + ' ' + esc(o.title) + '</span></li>';
      }).join('') + '</ul>');
      h += sec('Designer notes', '', ta('notes', 'notes', p.notes, { rows: 3, label: 'Designer notes', ph: 'Test results, worries, to-dos…' }));
      h += '<section class="in-sec danger"><div class="ctl-row"><button type="button" class="btn sm ghost del" data-act="delete" data-fk="delete">' + ic('trash') + 'Delete puzzle</button>' +
        '<button type="button" class="btn sm ghost" data-act="copy" data-fk="copy">Copy as JSON</button></div></section>';
      return h + '</div>';
    }
    function renderInspector() {
      var p = S.sel && Kit.get(S.sel);
      var prevSel = $insp.getAttribute('data-sel'), st = $insp.scrollTop;
      $insp.innerHTML = p ? inspectorHtml(p) : emptyInspector();
      $insp.setAttribute('data-sel', S.sel || '');
      $insp.scrollTop = prevSel === (S.sel || '') ? st : 0;
      if (S.scrollClue) {
        S.scrollClue = false;
        var c = $insp.querySelector('.clue.hi');
        if (c) $insp.scrollTop = Math.max(0, c.offsetTop - 140);
      }
      $side.classList.toggle('open', S.phone && S.sheet);
    }

    /* text fields commit while typing (debounced) without rebuilding the field */
    var commitTimers = {};
    function patchFor(p, field, el) {
      var v = el.value, i = el.getAttribute('data-i');
      if (i != null) { var arr = (p[field] || []).slice(); arr[+i] = v; var o = {}; o[field] = arr; return o; }
      var q = {}; q[field] = v; return q;
    }
    function queueCommit(el, delay) {
      var p = S.sel && Kit.get(S.sel); if (!p) return;
      var key = el.getAttribute('data-fk'), pid = p.id, field = el.getAttribute('data-field');
      clearTimeout(commitTimers[key]);
      var run = function () {
        delete commitTimers[key];
        var cur = Kit.get(pid); if (!cur) return;
        var patch = patchFor(cur, field, el);
        if (JSON.stringify(patch[field]) === JSON.stringify(cur[field])) return;
        selfEdit = true;
        Kit.update(pid, patch);
      };
      if (delay === 0) run(); else commitTimers[key] = setTimeout(run, delay || 280);
    }
    function flushCommits() { Object.keys(commitTimers).forEach(function (k) { clearTimeout(commitTimers[k]); }); commitTimers = {}; }
    $side.addEventListener('input', function (e) {
      var el = e.target;
      if (el.matches('textarea[data-field], input.title-in, #tr-aha')) queueCommit(el);
    });
    $side.addEventListener('change', function (e) {
      var el = e.target, p = S.sel && Kit.get(S.sel); if (!p) return;
      if (el.matches('textarea[data-field], input.title-in, #tr-aha')) {
        var key = el.getAttribute('data-fk');
        if (commitTimers[key]) { clearTimeout(commitTimers[key]); delete commitTimers[key]; }
        var patch = patchFor(p, el.getAttribute('data-field'), el);
        if (JSON.stringify(patch[el.getAttribute('data-field')]) !== JSON.stringify(p[el.getAttribute('data-field')])) Kit.update(p.id, patch);
        else scheduleRender(false);
        return;
      }
      if (el.id === 'tr-status') { var old = p.status; Kit.update(p.id, { status: el.value }); Kit.toast(p.id + ' moved from ' + Kit.statusLabel(old) + ' to ' + Kit.statusLabel(el.value) + '.'); return; }
      if (el.id === 'tr-est') { var v = clamp(Math.round(+el.value || p.estMin || 30), 1, 600); Kit.update(p.id, { estMin: v }); Kit.toast(p.id + ' estimate set to ' + fmtMin(v) + '.'); return; }
      if (el.id === 'tr-chap') { Kit.update(p.id, { chapter: el.value }); Kit.toast(p.id + ' moved to ' + chShort(Kit.chapter(el.value)) + '.'); return; }
      if (el.id === 'tr-kind') { Kit.update(p.id, { kind: el.value }); return; }
      if (el.matches('[data-check]')) {
        var ch = (p.checks || []).filter(function (x) { return x !== el.dataset.check; });
        if (el.checked) ch.push(el.dataset.check);
        ch = D().designChecks.map(function (d) { return d.id; }).filter(function (id) { return ch.indexOf(id) >= 0; });
        Kit.update(p.id, { checks: ch }); return;
      }
      if (el.matches('[data-final]')) { Kit.update(p.id, { final: el.checked }); return; }
      if (el.matches('select.plant') && el.value) {
        var cid = el.dataset.clue, aid = el.value, a = Kit.get(aid);
        S.hiClue = cid;
        Kit.update(cid, { plantedIn: aid });
        var late = (Kit.get(cid).usedBy || []).filter(function (u) { return chN(a.chapter) > chN((Kit.get(u) || {}).chapter); });
        Kit.toast(late.length ? 'Planted ' + cid + ' in ' + aid + ', but that asset arrives after ' + late.join(', ') + ' needs it. See Problems.' : 'Planted ' + cid + ' in ' + aid + ' ' + a.name + '.');
      }
    });
    var pendingDel = null, pendingTimer = null;
    $side.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('.in-close')) { if (S.phone) closeSheet(); else { S.sel = null; S.hiClue = null; S.multi = []; Desk.go('trail', { replace: true }); renderAll(); } return; }
      var cp = t.closest('[data-chpick]'); if (cp) { setChapter(cp.dataset.chpick); return; }
      var p = S.sel && Kit.get(S.sel); if (!p) return;
      var d = t.closest('.dpick button[data-d]');
      if (d) { var nd = +d.dataset.d; if (nd !== p.difficulty) { Kit.update(p.id, { difficulty: nd }); } return; }
      var rm = t.closest('[data-rm]');
      if (rm) {
        var field = rm.dataset.rm, id = rm.dataset.id;
        var o = {}; o[field] = (p[field] || []).filter(function (x) { return x !== id; });
        Kit.update(p.id, o);
        Kit.toast('Removed ' + id + ' from ' + p.id + (field === 'requires' ? '’s requirements.' : '.'));
        return;
      }
      var lop = t.closest('[data-lop]');
      if (lop) {
        var f = lop.dataset.field, i = +lop.dataset.i, arr = (p[f] || []).slice(), fk = null, op = lop.dataset.lop;
        flushCommits();
        arr = (Kit.get(p.id)[f] || []).slice();
        if (op === 'up' && i > 0) { var x = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = x; fk = i - 1 === 0 ? f + 'down0' : f + 'up' + (i - 1); }
        else if (op === 'down' && i < arr.length - 1) { var y = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = y; fk = i + 1 === arr.length - 1 ? f + 'up' + (i + 1) : f + 'down' + (i + 1); }
        else if (op === 'del') {
          var key = p.id + f + i;
          if (pendingDel !== key && arr[i]) {
            pendingDel = key; lop.classList.add('confirm'); lop.textContent = 'Remove?'; lop.setAttribute('aria-label', 'Confirm: remove item ' + (i + 1));
            clearTimeout(pendingTimer);
            pendingTimer = setTimeout(function () { pendingDel = null; if (root.contains(lop)) { lop.classList.remove('confirm'); lop.innerHTML = ic('trash'); } }, 3000);
            return;
          }
          pendingDel = null; arr.splice(i, 1); fk = f + 'add';
        }
        else if (op === 'add') { arr.push(''); fk = f + (arr.length - 1); }
        else return;
        var o2 = {}; o2[f] = arr;
        focusAfter = fk;
        Kit.update(p.id, o2);
        return;
      }
      var act = t.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'page') { flushNow(); ctx.go(p.id); }
      else if (a === 'crafter') { flushNow(); ctx.go('crafter.' + p.id); }
      else if (a === 'export') { flushNow(); ctx.openExport({ kind: 'sequence', from: p.id, to: lastDownstream(p.id) }); }
      else if (a === 'spoil') { PREF.spoil = !PREF.spoil; renderAll({ keepFocus: true }); }
      else if (a === 'copy') { Kit.copy(Kit.bundleToJSON(Kit.exportBundle({ kind: 'entity', ids: [p.id] }, { guide: false }))); }
      else if (a === 'add-clue') {
        Kit.pick({ title: 'Add an input clue to ' + p.id, types: ['clue'], exclude: p.inputs || [], allowCreate: true, onPick: function (cid) {
          var cur = Kit.get(p.id); if (!cur) return;
          S.hiClue = cid; S.scrollClue = true;
          Kit.update(p.id, { inputs: (cur.inputs || []).concat([cid]) });
          Kit.toast('Added ' + cid + ' to ' + p.id + '.');
        } });
      }
      else if (a === 'add-req') {
        var excl = [p.id].concat(D().puzzles.filter(function (q) { return isAncestor(p.id, q.id); }).map(function (q) { return q.id; })).concat(p.requires || []);
        Kit.pick({ title: p.id + ' needs players to solve…', types: ['puzzle'], exclude: excl, onPick: function (rid) {
          var cur = Kit.get(p.id); if (!cur) return;
          Kit.update(p.id, { requires: (cur.requires || []).concat([rid]) });
          Kit.toast(p.id + ' now needs ' + rid + '.');
        } });
      }
      else if (a === 'delete') {
        if (pendingDel !== 'puzzle:' + p.id) {
          pendingDel = 'puzzle:' + p.id; act.textContent = 'Delete ' + p.id + '? Click again'; act.classList.add('confirm');
          clearTimeout(pendingTimer);
          pendingTimer = setTimeout(function () { pendingDel = null; if (root.contains(act)) { act.classList.remove('confirm'); act.innerHTML = ic('trash') + 'Delete puzzle'; } }, 3500);
          return;
        }
        pendingDel = null;
        var snap = Kit.snapshot(), gone = p.id, title = p.title;
        S.sel = null; S.multi = S.multi.filter(function (x) { return x !== gone; });
        Desk.go('trail', { replace: true });
        Kit.remove(gone);
        Kit.toast('Deleted ' + gone + ' ' + title + '.', { label: 'Undo', run: function () { Kit.restore(snap); select(gone); Kit.toast('Restored ' + gone + '.'); } });
      }
    });
    function flushNow() {
      Object.keys(commitTimers).forEach(function (k) { clearTimeout(commitTimers[k]); });
      commitTimers = {};
      Array.prototype.forEach.call($side.querySelectorAll('textarea[data-field], input.title-in, #tr-aha'), function (el) {
        var p = S.sel && Kit.get(S.sel); if (!p) return;
        var f = el.getAttribute('data-field'), patch = patchFor(p, f, el);
        if (JSON.stringify(patch[f]) !== JSON.stringify(p[f])) Kit.update(p.id, patch);
      });
    }
    var focusAfter = null;

    /* ---------------- problems drawer ---------------- */
    function problemTarget(pr) {
      var clue = pr.ids.find(function (id) { return Kit.type(id) === 'clue'; }) || null;
      var pid = pr.ids.find(isPuzzle);
      if (!pid && clue) pid = puzzleForClue(clue);
      if (!pid) { var r = pr.ids.find(function (id) { return Kit.type(id) === 'research'; }); if (r) pid = (Kit.get(r).supports || []).find(isPuzzle); }
      if (!pid) { var ch = pr.ids.find(function (id) { return Kit.type(id) === 'chapter'; }); if (ch) pid = (Kit.puzzlesIn(ch)[0] || {}).id; }
      return { pid: pid, clue: clue };
    }
    function renderProblems() {
      if (!S.probOpen) { $probs.hidden = true; return; }
      $probs.hidden = false;
      var list = M.problems.map(function (pr, i) { return { pr: pr, i: i }; }).filter(function (x) { return S.probSev === 'all' || x.pr.severity === S.probSev; });
      var counts = { high: 0, med: 0, low: 0 };
      M.problems.forEach(function (x) { counts[x.severity]++; });
      $probs.innerHTML = '<div class="pop-head"><span class="eyebrow">Trail problems</span><span class="count">' + M.problems.length + '</span>' +
        '<div class="seg" role="group" aria-label="Filter by severity">' + ['all', 'high', 'med', 'low'].map(function (s) {
          return '<button type="button" data-sev="' + s + '" aria-pressed="' + (S.probSev === s) + '">' + (s === 'all' ? 'All' : s + ' ' + counts[s]) + '</button>';
        }).join('') + '</div>' +
        '<button type="button" class="ib bare" data-pclose="1" aria-label="Close problems">' + ic('x') + '</button></div>' +
        (list.length ? '<ul class="probs">' + list.map(function (x) {
          var tg = problemTarget(x.pr);
          return '<li><button type="button" class="prob' + (S.probActive === x.i ? ' on' : '') + '" data-pi="' + x.i + '">' +
            '<span class="sev sev-' + x.pr.severity + '">' + x.pr.severity + '</span><span class="prob-kind">' + esc(x.pr.kind) + '</span>' +
            '<span class="prob-text">' + esc(x.pr.text) + '</span>' +
            (tg.pid ? '<span class="prob-go">→ show ' + esc(tg.pid) + (tg.clue ? ' · ' + esc(tg.clue) : '') + '</span>' : '') + '</button></li>';
        }).join('') + '</ul>' : '<p class="small muted pad">Nothing at this severity.</p>');
    }
    $probs.addEventListener('click', function (e) {
      var sv = e.target.closest('[data-sev]'); if (sv) { S.probSev = sv.dataset.sev; renderProblems(); return; }
      if (e.target.closest('[data-pclose]')) { closeProblems(); return; }
      var b = e.target.closest('[data-pi]'); if (!b) return;
      var pr = M.problems[+b.dataset.pi], tg = problemTarget(pr);
      S.probActive = +b.dataset.pi;
      if (S.phone) S.probOpen = false;
      if (tg.pid) {
        select(tg.pid, { clue: tg.clue });
        var cl = tg.clue && Kit.get(tg.clue);
        if (cl && !(cl.usedBy || []).length) Kit.toast(tg.clue + ' is planted in ' + cl.plantedIn + ' (used by ' + tg.pid + '), but no puzzle needs it.');
      } else { renderAll(); Kit.toast(pr.text); }
    });
    function closeProblems() { S.probOpen = false; renderAll(); $('b-prob').focus(); }

    /* ---------------- add puzzle ---------------- */
    function openAdd() {
      var sp = S.sel && Kit.get(S.sel);
      S.draft = { title: '', chapter: sp ? sp.chapter : (Kit.chapters()[0] || {}).id, kind: 'research', est: 45, diff: 3, requires: sp ? [sp.id] : [], err: '' };
      S.addOpen = true; S.probOpen = false;
      renderAll();
      var f = $('af-title'); if (f) f.focus();
    }
    function closeAdd() { S.addOpen = false; renderAll(); $('b-add').focus(); }
    function renderAdd() {
      if (!S.addOpen) { $addf.hidden = true; $addf.innerHTML = ''; return; }
      var d = S.draft;
      if ($addf.querySelector('#af') && !$addf.hidden && $addf.dataset.v === String(d.v || 0)) return;
      $addf.dataset.v = String(d.v || 0);
      $addf.hidden = false;
      $addf.innerHTML = '<div class="pop-head"><span class="eyebrow">Add puzzle</span><span class="count">as ' + esc(Kit.nextId('puzzle')) + ' · status idea</span>' +
        '<button type="button" class="ib bare" data-afclose="1" aria-label="Close" style="margin-left:auto">' + ic('x') + '</button></div>' +
        '<form class="af" id="af" novalidate>' +
          '<label class="af-f">Title<input class="input" id="af-title" autocomplete="off" placeholder="e.g. The Antikythera Gear" value="' + esc(d.title) + '"></label>' +
          (d.err ? '<div class="af-err" role="alert">' + esc(d.err) + '</div>' : '') +
          '<div class="af-f">Chapter<div class="seg" role="group" aria-label="Chapter">' + Kit.chapters().map(function (c) {
            return '<button type="button" data-afch="' + c.id + '" aria-pressed="' + (d.chapter === c.id) + '" title="' + esc(c.title) + '">Ch ' + c.n + '</button>';
          }).join('') + '</div></div>' +
          '<div class="af-row"><label class="af-f">Kind<select class="input" id="af-kind">' + D().puzzleKinds.map(function (t) {
            return '<option value="' + t.id + '"' + (t.id === d.kind ? ' selected' : '') + '>' + esc(t.label) + '</option>';
          }).join('') + '</select></label>' +
          '<label class="af-f">Est. minutes<input class="input num" id="af-est" type="number" inputmode="numeric" min="1" max="600" step="5" value="' + d.est + '"></label></div>' +
          '<div class="af-f">Requires <span class="faint">(players solve these first)</span><div class="rq-list">' + M.order.map(function (p) {
            return '<button type="button" class="chip" data-rq="' + p.id + '" aria-pressed="' + (d.requires.indexOf(p.id) >= 0) + '" title="' + esc(p.title + ' · ' + chShort(Kit.chapter(p.chapter))) + '">' + p.id + '</button>';
          }).join('') + '</div></div>' +
          '<div class="af-foot"><button type="button" class="btn ghost" data-afclose="1">Cancel</button><button type="submit" class="btn primary">Add puzzle</button></div>' +
        '</form>';
    }
    function syncDraft() {
      var d = S.draft; if (!d) return;
      var t = $('af-title'), ty = $('af-kind'), es = $('af-est');
      if (t) d.title = t.value; if (ty) d.kind = ty.value; if (es) d.est = clamp(Math.round(+es.value || 45), 1, 600);
    }
    $addf.addEventListener('click', function (e) {
      if (e.target.closest('[data-afclose]')) { closeAdd(); return; }
      var a = e.target.closest('[data-afch]');
      if (a) { syncDraft(); S.draft.chapter = a.dataset.afch; Array.prototype.forEach.call($addf.querySelectorAll('[data-afch]'), function (b) { b.setAttribute('aria-pressed', String(b === a)); }); return; }
      var r = e.target.closest('[data-rq]');
      if (r) {
        var id = r.dataset.rq, rq = S.draft.requires, at = rq.indexOf(id);
        if (at >= 0) rq.splice(at, 1); else rq.push(id);
        r.setAttribute('aria-pressed', String(at < 0));
      }
    });
    $addf.addEventListener('input', syncDraft);
    $addf.addEventListener('submit', function (e) {
      e.preventDefault(); syncDraft();
      var d = S.draft;
      if (!d.title.trim()) { d.err = 'Give the puzzle a title.'; d.v = (d.v || 0) + 1; renderAdd(); $('af-title').focus(); return; }
      var id = Kit.create('puzzle', { title: d.title.trim(), chapter: d.chapter, kind: d.kind, difficulty: d.diff, status: 'idea', estMin: d.est, requires: d.requires.slice() });
      S.addOpen = false; S.draft = null;
      select(id);
      Kit.toast('Added ' + id + ' "' + d.title.trim() + '" to ' + chShort(Kit.chapter(d.chapter)) + (d.requires.length ? '. It needs ' + d.requires.join(', ') + '.' : ' as a new trailhead.'));
    });

    /* ---------------- selection + navigation ---------------- */
    function select(id, o) {
      o = o || {};
      var p = Kit.get(id); if (!p || !isPuzzle(id)) return;
      if (PREF.chapter !== 'all' && p.chapter !== PREF.chapter) PREF.chapter = 'all';
      flushNow();
      S.sel = id; PREF.sel = id; S.hiClue = o.clue || null; S.scrollClue = !!o.clue;
      if (!o.keepMulti) S.multi = [];
      if (!S.wide && !S.phone) PREF.tab = 'puzzle';
      if (S.phone && o.sheet !== false) S.sheet = true;
      if (o.route !== false && Desk.current && Desk.current.root === root) Desk.go('trail.' + id, { replace: true });
      renderAll();
      if (o.scroll !== false) scrollToSel();
    }
    function toggleMulti(id) {
      if (!S.multi.length && S.sel && S.sel !== id && !S.selectMode) S.multi.push(S.sel);
      var at = S.multi.indexOf(id);
      if (at >= 0) S.multi.splice(at, 1); else S.multi.push(id);
      renderAll();
    }
    function pickNode(id, e) {
      if (S.selectMode || (e && (e.shiftKey || e.ctrlKey || e.metaKey))) { toggleMulti(id); return; }
      select(id);
    }
    function renderMbar() {
      var n = S.multi.length;
      if (!n && !S.selectMode) { $mbar.hidden = true; $mbar.innerHTML = ''; return; }
      $mbar.hidden = false;
      var chain = chainOf(S.multi);
      $mbar.innerHTML = '<span class="mb-n"><b class="num">' + n + '</b> selected</span>' +
        (n ? '<span class="mb-ids">' + S.multi.slice().sort(function (a, b) { return M.idx[a] - M.idx[b]; }).join(' ') + '</span>' : '<span class="mb-ids">Tap puzzles to add them</span>') +
        (n ? '<button type="button" class="btn sm" data-mb="export">' + ic('out') + 'Export selection</button>' : '') +
        (chain ? '<button type="button" class="btn sm" data-mb="seq" title="Every puzzle on the trail between them, with their clues">Export as sequence ' + chain.from + '→' + chain.to + '</button>' : '') +
        '<button type="button" class="btn sm ghost" data-mb="clear">' + (S.selectMode ? 'Done' : 'Clear') + '</button>';
    }
    $mbar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mb]'); if (!b) return;
      var a = b.dataset.mb;
      if (a === 'export') ctx.openExport({ kind: 'entity', ids: S.multi.slice() });
      else if (a === 'seq') { var ch = chainOf(S.multi); if (ch) ctx.openExport({ kind: 'sequence', from: ch.from, to: ch.to }); }
      else if (a === 'clear') { S.multi = []; S.selectMode = false; renderAll(); }
    });
    function scrollToSel() {
      if (!S.sel) return;
      var beh = reduced() ? 'auto' : 'smooth';
      if (S.phone) {
        var c = $tlist.querySelector('.node[data-id="' + S.sel + '"]'); if (!c) return;
        var r = c.getBoundingClientRect(), gr = $graph.getBoundingClientRect();
        if (r.top < gr.top + 8 || r.bottom > gr.bottom - 8) $graph.scrollTo({ top: $graph.scrollTop + r.top - gr.top - 60, behavior: beh });
        return;
      }
      var P = LAYOUT && LAYOUT.pos[S.sel]; if (!P) return;
      var z = PREF.zoom, g = $graph, ox = $gsize.offsetLeft, oy = $gsize.offsetTop;
      var x1 = ox + P.x * z, x2 = ox + (P.x + P.w) * z, y1 = oy + P.y * z, y2 = oy + (P.y + P.h) * z;
      var vw = g.clientWidth - (S.probOpen || S.addOpen ? Math.min(444, g.clientWidth * 0.55) : 0), m = 28;
      var left = g.scrollLeft, top = g.scrollTop;
      if (x1 < left + m || x2 > left + vw - m) left = (x1 + x2) / 2 - vw / 2;
      if (y1 < top + m || y2 > top + g.clientHeight - m) top = (y1 + y2) / 2 - g.clientHeight / 2;
      if (left !== g.scrollLeft || top !== g.scrollTop) g.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: beh });
    }
    function closeSheet() {
      flushNow();
      S.sheet = false; $side.classList.remove('open');
      Desk.go('trail', { replace: true });
      var n = $tlist.querySelector('.node[data-id="' + S.sel + '"]'); if (n) n.focus({ preventScroll: true });
    }

    /* graph interactions */
    var pan = null, suppressClick = false;
    function graphClick(e) {
      if (suppressClick) { suppressClick = false; return; }
      var t = e.target;
      var ec = t.closest('.echip'); if (ec) { select(ec.dataset.to, { clue: ec.dataset.clue }); return; }
      var g = t.closest('.gnode'); if (g) { PREF.chapter = 'all'; select(g.dataset.ghost); return; }
      var lh = t.closest('[data-lane]'); if (lh) { setChapter(PREF.chapter === lh.dataset.lane ? 'all' : lh.dataset.lane); return; }
      var n = t.closest('.node[data-id]');
      if (n) {
        if (S.selectMode || e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); toggleMulti(n.dataset.id); return; }
        var ch = t.closest('[data-clue]'); select(n.dataset.id, { clue: ch ? ch.dataset.clue : null });
      }
    }
    $world.addEventListener('click', graphClick);
    $tlist.addEventListener('click', function (e) {
      if (e.target.closest('#pov-m')) return;
      graphClick(e);
    });
    function nodeKeys(e) {
      var n = e.target.closest && e.target.closest('.node[data-id]');
      if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickNode(n.dataset.id, e); }
    }
    $world.addEventListener('keydown', nodeKeys);
    $tlist.addEventListener('keydown', nodeKeys);
    $graph.addEventListener('pointerdown', function (e) {
      if (S.phone || e.pointerType !== 'mouse' || e.button !== 0) return;
      if (e.target.closest('.node, .echip, .gnode, .lane-h, button')) return;
      pan = { x: e.clientX, y: e.clientY, sl: $graph.scrollLeft, st: $graph.scrollTop, moved: false };
    });
    on(window, 'pointermove', function (e) {
      if (!pan) return;
      var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 4) { pan.moved = true; $graph.classList.add('panning'); }
      if (pan.moved) { $graph.scrollLeft = pan.sl - dx; $graph.scrollTop = pan.st - dy; }
    });
    on(window, 'pointerup', function () {
      if (pan && pan.moved) { suppressClick = true; setTimeout(function () { suppressClick = false; }, 0); }
      pan = null; $graph.classList.remove('panning');
    });
    $graph.addEventListener('wheel', function (e) {
      if (S.phone) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(PREF.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); return; }
      if ($graph.scrollHeight <= $graph.clientHeight + 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $graph.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    function setZoom(z) {
      z = clamp(Math.round(z * 100) / 100, 0.4, 1.5);
      var g = $graph, cx = (g.scrollLeft + g.clientWidth / 2 - $gsize.offsetLeft) / PREF.zoom, cy = (g.scrollTop + g.clientHeight / 2 - $gsize.offsetTop) / PREF.zoom;
      PREF.zoom = z;
      renderGraph(); updateToolbar();
      g.scrollLeft = $gsize.offsetLeft + cx * z - g.clientWidth / 2;
      g.scrollTop = $gsize.offsetTop + cy * z - g.clientHeight / 2;
    }
    $('z-in').addEventListener('click', function () { setZoom(PREF.zoom * 1.15); });
    $('z-out').addEventListener('click', function () { setZoom(PREF.zoom / 1.15); });
    $('z-reset').addEventListener('click', function () { setZoom(1); if (S.sel) scrollToSel(); });
    $('z-fit').addEventListener('click', function () { setZoom(Math.min(1, ($graph.clientWidth - 16) / (LAYOUT ? LAYOUT.W : 1000))); $graph.scrollLeft = 0; });

    /* puzzle refs inside the trail select within the trail; other refs navigate as usual */
    root.addEventListener('click', function (e) {
      var r = e.target.closest('.ref[data-ref]');
      if (!r || !root.contains(r)) return;
      var id = r.getAttribute('data-ref');
      if (isPuzzle(id)) { e.preventDefault(); select(id); }
      else flushNow();
    });
    on(document, 'keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (Kit.palette.el && !Kit.palette.el.hidden) return;
      if (document.querySelector('.kit-sheet-overlay')) return;
      var tg = e.target;
      if (tg && root.contains(tg) && (/^(TEXTAREA|SELECT)$/.test(tg.tagName) || (tg.tagName === 'INPUT' && tg.type !== 'range' && !tg.closest('#addf')))) { tg.blur(); return; }
      if (S.addOpen) { closeAdd(); return; }
      if (S.probOpen) { closeProblems(); return; }
      if (S.phone && S.sheet) { closeSheet(); return; }
      if (S.multi.length || S.selectMode) { S.multi = []; S.selectMode = false; renderAll(); return; }
      if (S.sel) { S.sel = null; S.hiClue = null; Desk.go('trail', { replace: true }); renderAll(); Kit.toast('Selection cleared.'); }
    }, true); /* capture: runs before the kit closes its sheets, so one Esc closes one thing */

    /* ---------------- render all ---------------- */
    function renderStatus() {
      ctx.setStatus([
        M.N + ' puzzles', fmtMin(M.total) + ' est. play', 'critical path ' + fmtMin(M.crit.total),
        'player view ' + PREF.pov + '/' + M.N + (PREF.pov ? ' · after ' + (M.order[PREF.pov - 1] || {}).id : ' · before the trailhead'),
        M.problems.length + ' trail problems',
        S.multi.length ? S.multi.length + ' selected' : '',
      ]);
    }
    function renderAll(opt) {
      if (!alive) return;
      opt = opt || {};
      var ae = document.activeElement, fk = null, s0 = null, s1 = null;
      if (ae && root.contains(ae)) {
        fk = ae.getAttribute && ae.getAttribute('data-fk');
        if (fk && typeof ae.selectionStart === 'number') { try { s0 = ae.selectionStart; s1 = ae.selectionEnd; } catch (err) { s0 = null; } }
      }
      if (focusAfter) { fk = focusAfter; s0 = null; focusAfter = null; }
      compute();
      root.classList.toggle('is-wide', S.wide);
      root.classList.toggle('is-phone', S.phone);
      root.classList.toggle('pov-left', !S.phone && S.wide && PREF.povOpen);
      updateToolbar();
      renderPov();
      renderGraph();
      renderPacing();
      if (!opt.skipInspector) renderInspector(); else $side.classList.toggle('open', S.phone && S.sheet);
      renderProblems();
      renderAdd();
      renderMbar();
      renderStatus();
      if (fk && !opt.skipInspector) {
        var el = root.querySelector('[data-fk="' + fk + '"]');
        if (el && document.activeElement !== el) {
          el.focus({ preventScroll: true });
          if (s0 != null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(s0, s1); } catch (err) { /* not a text field */ } }
        }
      }
    }
    var renderT = null;
    function scheduleRender(partial) {
      clearTimeout(renderT);
      renderT = setTimeout(function () { renderAll({ skipInspector: partial }); }, 40);
    }
    cleanups.push(Kit.on('change', function () {
      var partial = selfEdit; selfEdit = false;
      scheduleRender(partial);
    }));
    on(document, 'kit:theme', function () { renderAll({ skipInspector: true }); });
    var onPhone = function (e) { S.phone = e.matches; S.sheet = false; if (!S.phone && PREF.pacingOpen == null) PREF.pacingOpen = true; renderAll(); if (!S.phone) scrollToSel(); };
    var onWide = function (e) { S.wide = e.matches; renderAll(); };
    if (mqPhone.addEventListener) { mqPhone.addEventListener('change', onPhone); mqWide.addEventListener('change', onWide); cleanups.push(function () { mqPhone.removeEventListener('change', onPhone); mqWide.removeEventListener('change', onWide); }); }
    var lastG = '', lastP = 0, rz = 0;
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        cancelAnimationFrame(rz);
        rz = requestAnimationFrame(function () {
          if (!alive) return;
          var gsz = $graph.clientWidth + 'x' + $graph.clientHeight;
          if (gsz !== lastG && !S.phone) { lastG = gsz; renderGraph(); }
          if ($pc.clientWidth !== lastP) { lastP = $pc.clientWidth; renderPacing(); }
        });
      });
      ro.observe(root);
      cleanups.push(function () { ro.disconnect(); cancelAnimationFrame(rz); });
    }

    /* ---------------- go ---------------- */
    if (params && params.select && isPuzzle(params.select) && S.phone) S.sheet = true;
    renderAll();
    lastG = $graph.clientWidth + 'x' + $graph.clientHeight; lastP = $pc.clientWidth;
    if (!S.phone) scrollToSel();

    return {
      update: function (q) {
        q = q || {};
        if (q.select && isPuzzle(q.select)) {
          if (q.select !== S.sel) select(q.select, { route: false });
          else if (S.phone && !S.sheet) { S.sheet = true; renderAll({ skipInspector: true }); }
        }
      },
      unmount: function () {
        flushNow();
        alive = false;
        clearTimeout(renderT); clearTimeout(pendingTimer);
        cleanups.forEach(function (fn) { try { fn(); } catch (err) { /* ignore */ } });
        cleanups = [];
      },
      exportScope: function () {
        if (S.multi.length) return { kind: 'entity', ids: S.multi.slice() };
        if (S.sel && isPuzzle(S.sel)) return { kind: 'entity', ids: [S.sel] };
        return { kind: 'collection', type: 'puzzle' };
      },
      navToken: function () { return 'trail'; },
    };
  }
})();
