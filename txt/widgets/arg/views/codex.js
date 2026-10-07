/* ============================================================
   ARG Desk — Codex view (id 'codex')
   Every thing in the game gets a page, and every page knows what
   links to it. Chapters hold events, events hold puzzles. Collections
   (tables / cards / the chapter contents), entity pages with a
   properties grid, type-specific bodies, a fact check, and link /
   backlink rails. All edits go through Kit.update/create/remove/batch.
   ============================================================ */
(function () {
  'use strict';
  var D = window.ARG, K = window.Kit, esc = K.esc;

  /* ---------- icons (inline SVG, currentColor) ---------- */
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
  var IC = {
    back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
    search: K.ICONS.search,
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    chev: svg('<path d="m6 9 6 6 6-6"/>'),
    up: svg('<path d="m18 15-6-6-6 6"/>'),
    down: svg('<path d="m6 9 6 6 6-6"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>'),
    warn: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    exp: svg('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    ext: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    craft: svg('<path d="M4 7h16M4 12h10M4 17h6"/><path d="m16 15 2 2 4-4"/>'),
    trail: svg('<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a4 4 0 0 1 0 8h-2a4 4 0 0 0 0 8"/>'),
  };

  /* ---------- small helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function uniq(a) { return a.filter(function (v, i) { return v != null && a.indexOf(v) === i; }); }
  var LAYER_IDS = D.layers.map(function (l) { return l.id; });
  var SEVL = { high: 'High', med: 'Med', low: 'Low' };
  var SEVR = { high: 0, med: 1, low: 2 };
  var IDPAT = /^(CH|AS|TL|P|C|R|I|Q|T|N|E)\d/;
  var F = K.FIELDS;

  function chapter(cid) { return K.chapter(cid); }
  function chapShort(cid) { var c = chapter(cid); return c ? 'Ch ' + c.n : '—'; }
  /* "Ch 1 · Folio One", or just the title when it already says "Chapter …" */
  function chapTitle(c) { return /^chapter\b/i.test(c.title || '') ? c.title : 'Ch ' + c.n + ' · ' + (c.title || 'Untitled'); }
  function chapFull(cid) { var c = chapter(cid); return c ? chapTitle(c) : 'Not placed yet'; }
  function chapN(cid) { var c = chapter(cid); return c ? (+c.n || 0) : 999; }
  function evOrderKey(e) { return chapN(e.chapter) * 1000 + (+e.order || 0); }
  function eventsSorted() { return K.list('event').sort(function (a, b) { return evOrderKey(a) - evOrderKey(b) || String(a.id).localeCompare(String(b.id)); }); }
  function firstChapter() { return K.chapters()[0] || null; }
  function pkind(k) { var x = D.puzzleKinds.find(function (p) { return p.id === k; }); return x ? x.label : (k || '—'); }
  function isClaim(type) { return K.CLAIM_TYPES.indexOf(type) >= 0; }
  function shown(id) { if (!isClaim(K.type(id))) return true; var l = K.layerOf(id); return !l || S.on[l] !== false; }
  function idc(id) { return '<span class="id">' + esc(id) + '</span>'; }
  function titleField(type) { var f = F[type] || {}; return f.title ? 'title' : f.name ? 'name' : 'text'; }
  function collToken(type) { return Desk.collectionToken(type); }
  function shortTitle(text) {
    var t = String(text || '').trim().split(/\s[—–-]\s/)[0];
    var m = t.match(/^(.*?[.?!])(\s|$)/); if (m) t = m[1];
    t = t.replace(/[.?!]+$/, '');
    return trunc(t || 'Untitled', 64);
  }
  function relShort(iso) {
    var n = K.daysUntil(iso); if (n == null) return '';
    if (n === 0) return 'today';
    return n > 0 ? 'in ' + n + 'd' : -n + 'd ago';
  }
  function urg(n) { if (n == null) return ''; if (n < 0) return 'urg-past'; if (n <= 30) return 'urg-high'; if (n <= 45) return 'urg-med'; return ''; }
  function renewCell(iso) {
    if (!iso) return '<span class="faint">—</span>';
    var n = K.daysUntil(iso);
    return '<span class="t-mono">' + esc(K.fmtDate(iso)) + '</span> <span class="rel ' + urg(n) + '">' + relShort(iso) + '</span>';
  }

  /* entity ref: same markup as Kit.refHtml (so the shell's global handler navigates), with a length cap */
  function R(id, o) {
    o = o || {};
    var ob = K.get(id);
    if (!ob) return id ? '<span class="id">' + esc(id) + '</span>' : '';
    var hasId = IDPAT.test(id), idOnly = o.idOnly && hasId;
    var lbl = K.label(id), max = o.max || 44;
    if (lbl.length > max) lbl = lbl.slice(0, max - 1) + '…';
    var lay = K.layerOf(id);
    return '<button type="button" class="ref' + (o.cls ? ' ' + o.cls : '') + '" data-ref="' + esc(id) + '">' +
      (lay ? K.layerDot(lay) : '') +
      (hasId ? '<span class="ref-id">' + esc(id) + '</span>' : '') +
      (idOnly ? '' : '<span class="ref-name">' + esc(lbl) + '</span>') + '</button>';
  }
  /* look-alike that is not a button (for use inside other buttons) */
  function Rflat(id, o) { return R(id, o).replace(/^<button type="button" class="ref([^"]*)" data-ref="[^"]*">/, '<span class="ref$1">').replace(/<\/button>$/, '</span>'); }
  function Rs(ids, o) {
    ids = (ids || []).filter(function (x) { return x && K.get(x); });
    if (!ids.length) return '<span class="faint">—</span>';
    return '<span class="refs">' + ids.map(function (i) { return R(i, o); }).join('') + '</span>';
  }

  var TONES = {
    asset: { placed: 'green', ready: 'teal', making: 'blue', idea: 'neutral' },
    task: { done: 'green', doing: 'blue', todo: 'neutral' },
    question: { open: 'amber', resolved: 'green' },
    cstatus: { canon: 'teal', draft: 'neutral', reference: 'blue' },
    rel: { primary: 'teal', scholarly: 'blue', popular: 'neutral', fringe: 'purple' },
    ckind: { historical: 'teal', living: 'amber', fictional: 'neutral', persona: 'neutral', faction: 'neutral' },
    rstatus: { verified: 'green', read: 'teal', 'to read': 'amber' },
    istatus: { raw: 'blue', exploring: 'teal', used: 'green', parked: 'neutral' },
  };
  function chip(text, tone) { return '<span class="chip' + (tone ? ' tone-' + tone : '') + '">' + esc(text) + '</span>'; }
  function stChip(g, v) { return v ? chip(v, (TONES[g] || {})[v] || 'neutral') : '<span class="faint">—</span>'; }

  /* puzzles: which reality layers a puzzle touches */
  function puzzleTouch(p) { return [].concat(p.event ? [p.event] : [], p.inputs || [], p.reveals || []); }
  function anchorLayer(p) { return (p.event && K.layerOf(p.event)) || ''; }
  function mixHtml(ids, withLabel) {
    var c = {}, tot = 0, segs = '', tip = [];
    ids.forEach(function (id) { var l = K.layerOf(id); if (l) c[l] = (c[l] || 0) + 1; });
    LAYER_IDS.forEach(function (l) {
      if (!c[l]) return;
      tot += c[l]; segs += '<i class="layer-' + l + '" style="flex-grow:' + c[l] + '"></i>';
      tip.push(K.layer(l).label + ' ' + c[l]);
    });
    if (!tot) return '<span class="faint">—</span>';
    return '<span class="cx-mix" title="' + esc('Touches ' + tip.join(' · ')) + '">' + segs + '</span>' +
      (withLabel ? '<span class="cx-mix-l">' + esc(tip.join(' · ')) + '</span>' : '');
  }
  function checksCell(p) {
    var n = (p.checks || []).length, tot = D.designChecks.length;
    return '<span class="cx-checks' + (n === tot ? ' all' : '') + '" title="' + n + ' of ' + tot + ' design checks passed"><span class="num">' + n + '/' + tot + '</span><span class="cx-cbar"><i style="width:' + Math.round(n / tot * 100) + '%"></i></span></span>';
  }
  function inputsCell(p) {
    if (!(p.inputs || []).length) return '<span class="faint">—</span>';
    return '<span class="refs">' + p.inputs.map(function (cid) {
      var c = K.get(cid); return R(cid, { idOnly: true, cls: c && !c.plantedIn ? 'unplanted' : '' });
    }).join('') + '</span>';
  }
  function guardedFor(id) {
    var t = K.type(id), set = new Set();
    D.characters.forEach(function (c) { if (c.guard && (c.appears || []).indexOf(id) >= 0) set.add(c.id); });
    K.refs(id).forEach(function (r) { var c = K.get(r); if (K.type(r) === 'character' && c.guard) set.add(r); });
    if (t === 'event') D.timeline.forEach(function (e) {
      if ((e.links || []).indexOf(id) >= 0) e.links.forEach(function (l) { var c = K.get(l); if (K.type(l) === 'character' && c && c.guard) set.add(l); });
    });
    if (t === 'character') set.delete(id);
    return Array.from(set);
  }
  /* research that directly supports a claim */
  function directSrc(cid) {
    var o = K.get(cid) || {}, set = new Set((o.research || []).filter(function (s) { return K.type(s) === 'research'; }));
    D.research.forEach(function (s) { if ((s.supports || []).indexOf(cid) >= 0) set.add(s.id); });
    return Array.from(set);
  }
  function researchSummary(ids) {
    ids = (ids || []).filter(function (s) { return K.type(s) === 'research'; });
    if (!ids.length) return '<span class="cx-mk bad">none</span>';
    var v = ids.filter(function (s) { return K.get(s).status === 'verified'; }).length;
    return '<span class="t-mono"><span class="' + (v ? 'ok' : 'bad') + '">' + v + '</span> of ' + ids.length + ' verified</span>';
  }
  function centuryOf(y) { if (y == null || isNaN(y) || !y) return ''; return String(Math.floor((y - 1) / 100) + 1); }
  function ordinal(n) { n = +n; var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  /* ---------- per-viewer state (filters, view prefs) ---------- */
  var S = { on: { record: true, pseudo: true, fiction: true }, views: {}, probSev: 'all' };
  var PREF_KEY = 'argdesk-codex-prefs';
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  if (prefs.__layers) LAYER_IDS.forEach(function (l) { if (prefs.__layers[l] === false) S.on[l] = false; });
  function savePrefs() {
    var out = { __layers: S.on };
    Object.keys(S.views).forEach(function (k) { var v = S.views[k]; out[k] = { group: v.group, sort: v.sort, mode: v.mode }; });
    try { localStorage.setItem(PREF_KEY, JSON.stringify(out)); } catch (e) { /* storage unavailable */ }
  }


  /* ---------- collections: columns, groupings, inline New forms ---------- */
  function col(k, l, v, h, cls) { return { k: k, l: l, v: v, h: h, cls: cls || '' }; }
  var cKey = function (o) { return o.id; };
  var hKey = function (o) { return idc(o.id); };
  function strong(s) { return '<span class="t-strong">' + esc(s) + '</span>'; }
  function muted(s) { return s == null || s === '' ? '<span class="faint">—</span>' : '<span class="t-muted">' + esc(s) + '</span>'; }
  function lay(o) { return o.layer ? K.layerBadge(o.layer) : '<span class="faint">—</span>'; }
  function layOrd(k) { var i = LAYER_IDS.indexOf(k); return i < 0 ? 9 : i; }
  var gLayer = { k: 'layer', l: 'Layer', v: function (o) { return o.layer; }, name: function (k) { return K.layerBadge(k); }, ord: layOrd };
  function idxOrd(list) { return function (k) { var i = list.indexOf(k); return i < 0 ? 99 : i; }; }
  function plainName(k) { return esc(k ? cap(k) : 'None'); }
  function vals(type, field) { return ((F[type] || {})[field] || {}).values || []; }
  var gChapter = { k: 'chapter', l: 'Chapter', v: function (o) { return o.chapter || ''; }, ord: function (k) { return k ? chapN(k) : 9999; }, name: function (k) { return esc(chapFull(k)); } };
  function dateVal(o) { var d = K.parseDate(o.date); return d ? d.getTime() : 9e15; }
  function whenVal(o) { var d = K.parseDate(o.when); return d ? d.getTime() : 9e15; }
  /* <select> of events grouped by chapter (with "Not placed yet" and an optional none) */
  function eventOptions(cur, none) {
    var html = none ? '<option value=""' + (!cur ? ' selected' : '') + '>' + esc(none) + '</option>' : '';
    var groups = K.chapters().map(function (c) { return { label: chapTitle(c), evs: K.eventsIn(c.id) }; }).concat([{ label: 'Not placed yet', evs: K.eventsIn(null) }]);
    groups.forEach(function (g) {
      if (!g.evs.length) return;
      html += '<optgroup label="' + esc(g.label) + '">' + g.evs.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === cur ? ' selected' : '') + '>' + esc(e.id + ' · ' + trunc(e.title, 44)) + '</option>'; }).join('') + '</optgroup>';
    });
    return html;
  }

  var COLL = {};
  var COLL_KEYS = ['chapters', 'events', 'puzzles', 'clues', 'characters', 'places', 'timeline', 'assets', 'questions', 'tasks', 'notes'];

  COLL.puzzles = {
    type: 'puzzle', label: 'Puzzles', desc: 'Everything players solve. Each puzzle sits inside an event, and its chapter follows the event. Status runs Idea → Draft → Built → Tested → Ready.',
    empty: 'No puzzles yet. Puzzles live inside events: open an event and add one there, or start one here and place it later.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('title', 'Title', function (o) { return (o.title || '').toLowerCase(); }, function (o) { return strong(o.title || 'Untitled') + (o.final ? ' <span class="cx-mk">final</span>' : ''); }, 'c-title'),
      col('event', 'Event', function (o) { var e = o.event && K.get(o.event); return e ? evOrderKey(e) : 9e9; }, function (o) { return o.event && K.get(o.event) ? R(o.event, { max: 26 }) : '<span class="cx-mk warn">No event</span>'; }),
      col('kind', 'Kind', function (o) { return pkind(o.kind); }, function (o) { return esc(pkind(o.kind)); }),
      col('difficulty', 'Diff.', function (o) { return o.difficulty; }, function (o) { return K.diff(o.difficulty); }),
      col('status', 'Status', function (o) { return K.statusIndex(o.status); }, function (o) { return K.pips(o.status, { label: true }); }),
      col('checks', 'Checks', function (o) { return (o.checks || []).length; }, checksCell),
      col('steps', 'Path', function (o) { return (o.solvePath || []).length; }, function (o) { var n = (o.solvePath || []).length; return n ? '<span class="t-mono">' + n + ' step' + (n === 1 ? '' : 's') + '</span>' : '<span class="faint">—</span>'; }),
      col('inputs', 'Inputs', function (o) { return (o.inputs || []).length; }, inputsCell),
      col('layer', 'Layers', function (o) { return layOrd(anchorLayer(o)); }, function (o) { return mixHtml(puzzleTouch(o)); }),
    ],
    groups: [gChapter,
      { k: 'event', l: 'Event', v: function (o) { return o.event && K.get(o.event) ? o.event : ''; }, ord: function (k) { var e = k && K.get(k); return e ? evOrderKey(e) : 9e9; },
        name: function (k) { return k ? Rflat(k, { max: 40 }) : '<span class="cx-mk warn">No event</span>'; },
        aside: function (k) { var e = k && K.get(k); return e ? { t: chapFull(e.chapter) } : { t: 'place these inside an event', c: 'urg-med' }; } },
      { k: 'status', l: 'Status', v: function (o) { return o.status; }, ord: function (k) { return K.statusIndex(k); }, name: function (k) { return K.pips(k) + ' ' + esc(K.statusLabel(k)); } },
      { k: 'kind', l: 'Kind', v: function (o) { return o.kind; }, ord: function (k) { return D.puzzleKinds.findIndex(function (t) { return t.id === k; }); }, name: function (k) { return esc(pkind(k)); } },
      { k: 'layer', l: 'Event layer', v: anchorLayer, ord: layOrd, name: function (k) { return k ? K.layerBadge(k) : 'No event'; } }],
    group: 'chapter', sort: { k: 'event', dir: 1 },
    hay: function (o) { return [o.premise, o.mechanic, pkind(o.kind), o.status, chapFull(o.chapter), o.event ? K.label(o.event) : '', o.notes].join(' '); },
    cardCols: ['event', 'status', 'difficulty', 'checks'],
    newF: [['title', 'Title', 'text', { req: 1, ph: 'e.g. The Second Hand', wide: 1 }], ['event', 'Event', 'event'], ['kind', 'Kind', D.puzzleKinds.map(function (t) { return [t.id, t.label]; })], ['difficulty', 'Difficulty', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], { def: '3', num: 1 }]],
  };

  COLL.events = {
    type: 'event', label: 'Events', desc: 'The moments a chapter is built from: real, contested or invented. Each event holds the puzzles that use it, and keeps what is on the record apart from our twist.',
    empty: 'No events yet. An event is a moment in the world, real or invented, that a chapter is built from. Puzzles live inside events.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('title', 'Title', function (o) { return (o.title || '').toLowerCase(); }, function (o) { return strong(o.title || 'Untitled'); }, 'c-title'),
      col('chapter', 'Chapter', function (o) { return chapN(o.chapter); }, function (o) { return o.chapter ? muted(chapShort(o.chapter)) : '<span class="cx-mk warn">Unplaced</span>'; }),
      col('order', 'Order', evOrderKey, function (o) { return o.chapter ? '<span class="t-mono">' + esc(o.order || '—') + '</span>' : '<span class="faint">—</span>'; }),
      col('layer', 'Layer', function (o) { return layOrd(o.layer); }, lay),
      col('when', 'When', whenVal, function (o) { return o.when ? '<span class="t-mono">' + esc(K.fmtDate(o.when)) + '</span>' : '<span class="faint">—</span>'; }),
      col('puzzles', 'Puzzles', function (o) { return K.puzzlesInEvent(o.id).length; }, function (o) { var ps = K.puzzlesInEvent(o.id).map(function (p) { return p.id; }); return ps.length ? Rs(ps, { idOnly: true }) : '<span class="faint">none yet</span>'; }),
      col('research', 'Research', function (o) { return directSrc(o.id).filter(function (r) { return K.get(r).status === 'verified'; }).length; }, function (o) { return o.layer === 'fiction' && !directSrc(o.id).length ? '<span class="faint">invented</span>' : researchSummary(directSrc(o.id)); }),
    ],
    groups: [
      { k: 'chapter', l: 'Chapter', v: function (o) { return o.chapter || ''; }, ord: function (k) { return k ? chapN(k) : 9999; },
        name: function (k) { return k ? esc(chapFull(k)) : '<span class="cx-mk warn">Not placed yet</span>'; },
        aside: function (k) { return k ? '' : { t: 'parking lot: give them a chapter when they earn one', c: 'urg-med' }; } },
      gLayer],
    group: 'chapter', sort: { k: 'order', dir: 1 },
    hay: function (o) { return [o.record, o.twist, o.when, o.notes, chapFull(o.chapter)].join(' '); },
    cardCols: ['chapter', 'when', 'puzzles'],
    newF: [['title', 'Title', 'text', { req: 1, ph: 'e.g. The Antikythera wreck', wide: 1 }], ['chapter', 'Chapter', 'chapter', { none: 'Not placed yet' }], ['layer', 'Layer', 'layer', { def: 'pseudo' }]],
  };

  COLL.clues = {
    type: 'clue', label: 'Clues', desc: 'Atomic pieces of information: where each one is planted and which puzzles need it.',
    empty: 'No clues yet. Clues are the pieces players find: text, images, data, objects. Plant each one in an asset and attach it to the puzzles that need it.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('text', 'Text', function (o) { return o.text.toLowerCase(); }, function (o) { return '<span class="doc">' + esc(o.text) + '</span>'; }, 'c-title c-doc'),
      col('kind', 'Kind', function (o) { return o.kind; }, function (o) { return muted(o.kind); }),
      col('plantedIn', 'Planted in', function (o) { return o.plantedIn || ''; }, function (o) { return o.plantedIn ? R(o.plantedIn, { max: 22 }) : '<span class="cx-mk bad">' + IC.warn + 'Not planted</span>'; }),
      col('usedBy', 'Used by', function (o) { return (o.usedBy || []).length; }, function (o) { return (o.usedBy || []).length ? Rs(o.usedBy, { idOnly: true }) : '<span class="cx-mk warn">Orphan</span>'; }),
      col('layer', 'Layer', function (o) { return layOrd(o.layer); }, function (o) { return K.layerBadge(o.layer, { short: true }); }),
    ],
    groups: [
      { k: 'plantedIn', l: 'Planted in', v: function (o) { return o.plantedIn || ''; }, ord: function (k) { return k ? (K.type(k) === 'asset' ? 1 : 2) : 0; },
        name: function (k) { return k ? Rflat(k, { max: 34 }) : '<span class="cx-mk bad">' + IC.warn + 'Not planted</span>'; },
        aside: function (k) { var a = K.get(k); return a && K.type(k) === 'asset' ? { t: chapShort(a.chapter) + ' · ' + a.status } : k ? { t: 'solution output' } : { t: 'nothing carries these yet', c: 'urg-high' }; } },
      gLayer,
      { k: 'kind', l: 'Kind', v: function (o) { return o.kind; }, ord: idxOrd(vals('clue', 'kind')), name: plainName }],
    group: 'plantedIn', sort: { k: 'id', dir: 1 },
    cardCols: ['plantedIn', 'usedBy', 'layer'],
    newF: [['text', 'Clue text', 'text', { req: 1, ph: 'e.g. A pressed flower between pages 40 and 41', wide: 1 }], ['kind', 'Kind', vals('clue', 'kind').map(function (k) { return [k, cap(k)]; })], ['layer', 'Layer', 'layer', { def: 'fiction' }]],
  };

  var CKINDS = vals('character', 'kind');
  COLL.characters = {
    type: 'character', label: 'Characters', desc: 'Fictional people, the personas we run, and real people we must protect. A guard line marks anyone real.',
    empty: 'No characters yet. Add the people in your story: invented ones, personas you run in the wild, and real people (each real person gets a guard).',
    cols: [
      col('name', 'Name', function (o) { return o.name.toLowerCase(); }, function (o) { return strong(o.name); }, 'c-title'),
      col('kind', 'Kind', function (o) { return CKINDS.indexOf(o.kind); }, function (o) { return stChip('ckind', o.kind); }),
      col('life', 'Life', function (o) { return o.life; }, function (o) { return muted(o.life); }),
      col('layer', 'Layer', function (o) { return layOrd(o.layer); }, lay),
      col('guard', 'Guard', function (o) { return o.guard ? 0 : 1; }, function (o) { return o.guard ? '<span class="cx-guard-cell">' + IC.shield + '<span>' + esc(o.guard) + '</span></span>' : '<span class="faint">—</span>'; }),
      col('status', 'Status', function (o) { return o.status; }, function (o) { return stChip('cstatus', o.status); }),
    ],
    groups: [
      { k: 'kind', l: 'Kind', v: function (o) { return o.kind; }, ord: idxOrd(['fictional', 'persona', 'faction', 'historical', 'living']), name: plainName,
        aside: function (k) { return k === 'historical' || k === 'living' ? { t: 'real people · guarded', c: 'urg-med' } : ''; } },
      gLayer,
      { k: 'status', l: 'Status', v: function (o) { return o.status; }, ord: idxOrd(['canon', 'draft', 'reference']), name: plainName }],
    group: 'kind', sort: { k: 'name', dir: 1 },
    hay: function (o) { return o.role + ' ' + o.voice + ' ' + (o.guard || '') + ' ' + o.kind; },
    cardCols: ['kind', 'layer', 'status'],
    newF: [['name', 'Name', 'text', { req: 1, ph: 'e.g. Ada Fenwick', wide: 1 }], ['kind', 'Kind', CKINDS.map(function (k) { return [k, cap(k)]; })], ['layer', 'Layer', 'layer', { def: 'fiction' }]],
  };

  COLL.places = {
    type: 'place', label: 'Places', desc: 'Where things happened, or where we say they did.',
    empty: 'No places yet. Add where things happened, or where you say they did.',
    cols: [
      col('name', 'Name', function (o) { return o.name.toLowerCase(); }, function (o) { return strong(o.name); }, 'c-title'),
      col('coords', 'Coordinates', function (o) { return +o.lat; }, function (o) { return '<span class="t-mono">' + (+o.lat).toFixed(2) + ', ' + (+o.lng).toFixed(2) + '</span>'; }),
      col('layer', 'Layer', function (o) { return layOrd(o.layer); }, lay),
      col('linked', 'Linked from', function (o) { return K.backlinks(o.id).length; }, function (o) { return Rs(K.backlinks(o.id), { idOnly: true, max: 22 }); }),
    ],
    groups: [gLayer], group: 'none', sort: { k: 'name', dir: 1 },
    cardCols: ['coords', 'linked'],
    newF: [['name', 'Name', 'text', { req: 1, ph: 'e.g. Villa Mondragone, Frascati', wide: 1 }], ['lat', 'Lat', 'number', { ph: '41.80' }], ['lng', 'Lng', 'number', { ph: '12.70' }], ['layer', 'Layer', 'layer', { def: 'record' }]],
  };

  COLL.timeline = {
    type: 'entry', label: 'Timeline', desc: 'The in-world timeline: real dates and our fiction, interleaved.',
    empty: 'No timeline entries yet. Add the dates your story touches, real and invented, and they line up here in order.',
    cols: [
      col('date', 'Date', dateVal, function (o) { return '<span class="t-mono">' + esc(K.fmtDate(o.date)) + '</span>'; }, 'c-key'),
      col('title', 'Entry', function (o) { return (o.title || '').toLowerCase(); }, function (o) { return strong(o.title || 'Untitled'); }, 'c-title'),
      col('layer', 'Layer', function (o) { return layOrd(o.layer); }, lay),
      col('links', 'Links', function (o) { return (o.links || []).length; }, function (o) { return Rs(o.links, { idOnly: true, max: 22 }); }),
      col('revealedBy', 'Revealed by', function (o) { return o.revealedBy || 'zzz'; }, function (o) { return o.revealedBy ? R(o.revealedBy, { idOnly: true }) : '<span class="faint">—</span>'; }),
    ],
    groups: [{ k: 'century', l: 'Century', v: function (o) { return centuryOf(K.year(o.date)); }, ord: function (k) { return +k || 99; }, name: function (k) { return k ? esc(ordinal(k) + ' century') : 'Undated'; } }, gLayer],
    group: 'none', sort: { k: 'date', dir: 1 },
    cardCols: ['date', 'revealedBy'],
    newF: [['title', 'What happened', 'text', { req: 1, ph: 'e.g. Antikythera wreck found by sponge divers', wide: 1 }], ['date', 'Date', 'text', { req: 1, ph: 'YYYY or YYYY-MM-DD' }], ['layer', 'Layer', 'layer', { def: 'record' }]],
  };

  var ASTAT = vals('asset', 'status');
  COLL.assets = {
    type: 'asset', label: 'Assets', desc: 'Everything that has to exist in the wild: domains, documents, accounts, objects. Placed means it is out there.',
    empty: 'No assets yet. Assets are the things that must exist in the wild: domains, documents, accounts, objects.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('name', 'Name', function (o) { return o.name.toLowerCase(); }, function (o) { return strong(o.name); }, 'c-title'),
      col('kind', 'Kind', function (o) { return o.kind; }, function (o) { return muted(o.kind); }),
      col('status', 'Status', function (o) { return ASTAT.indexOf(o.status); }, function (o) { return stChip('asset', o.status); }),
      col('chapter', 'Chapter', function (o) { return chapN(o.chapter); }, function (o) { return muted(chapShort(o.chapter)); }),
      col('persona', 'Persona', function (o) { return o.persona ? K.label(o.persona) : 'zzz'; }, function (o) { return o.persona ? R(o.persona, { max: 18 }) : '<span class="faint">—</span>'; }),
      col('renews', 'Renews', function (o) { return o.renews ? K.daysUntil(o.renews) : 99999; }, function (o) { return renewCell(o.renews); }),
      col('carries', 'Carries', function (o) { return (o.carries || []).length; }, function (o) { return Rs(o.carries, { idOnly: true }); }),
    ],
    groups: [gChapter,
      { k: 'status', l: 'Status', v: function (o) { return o.status; }, ord: idxOrd(ASTAT), name: function (k) { return stChip('asset', k); } },
      { k: 'kind', l: 'Kind', v: function (o) { return o.kind; }, ord: idxOrd(vals('asset', 'kind')), name: plainName }],
    group: 'chapter', sort: { k: 'id', dir: 1 },
    hay: function (o) { return [o.where, o.kind, o.status, o.notes].join(' '); },
    cardCols: ['status', 'renews', 'carries'],
    newF: [['name', 'Name', 'text', { req: 1, ph: 'e.g. ledger-folio-2.pdf', wide: 1 }], ['kind', 'Kind', vals('asset', 'kind').map(function (k) { return [k, cap(k)]; })], ['chapter', 'Chapter', 'chapter']],
  };

  COLL.chapters = {
    type: 'chapter', label: 'Chapters', desc: 'The contents of the game: chapters in order, the events inside each one, and the puzzles inside those.',
    empty: 'No chapters yet. A chapter is a stretch of the trail; events and their puzzles go inside it.',
    toc: true,
    cols: [
      col('n', '#', function (o) { return +o.n || 0; }, function (o) { return '<span class="t-mono">' + esc(o.n) + '</span>'; }, 'c-key'),
      col('title', 'Title', function (o) { return (o.title || '').toLowerCase(); }, function (o) { return strong(o.title) + ' ' + idc(o.id); }, 'c-title'),
      col('events', 'Events', function (o) { return K.eventsIn(o.id).length; }, function (o) { return Rs(K.eventsIn(o.id).map(function (e) { return e.id; }), { idOnly: true }); }),
      col('puzzles', 'Puzzles', function (o) { return K.puzzlesIn(o.id).length; }, function (o) { return Rs(K.puzzlesIn(o.id).map(function (p) { return p.id; }), { idOnly: true }); }),
    ],
    groups: [], group: 'none', sort: { k: 'n', dir: 1 }, cardCols: ['events', 'puzzles'],
    newF: [['title', 'Title', 'text', { req: 1, ph: 'e.g. The Second Folio', wide: 1 }]],
  };

  var QKINDS = vals('question', 'kind');
  COLL.questions = {
    type: 'question', label: 'Questions', desc: 'Open calls: continuity problems, research to do, ethics decisions, design debates.',
    empty: 'No questions. Write down continuity problems, research to do and ethics calls as they come up, so none of them get lost.',
    cols: [
      col('severity', 'Severity', function (o) { return SEVR[o.severity]; }, function (o) { return '<span class="sev sev-' + o.severity + '">' + SEVL[o.severity] + '</span>'; }),
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('text', 'Question', function (o) { return (o.text || '').toLowerCase(); }, function (o) { return '<span class="t-strong">' + esc(o.text) + '</span>'; }, 'c-title'),
      col('kind', 'Kind', function (o) { return o.kind; }, function (o) { return muted(o.kind); }),
      col('status', 'Status', function (o) { return o.status === 'open' ? 0 : 1; }, function (o) { return stChip('question', o.status); }),
      col('created', 'Raised', function (o) { return o.created || ''; }, function (o) { return '<span class="t-mono">' + esc(K.fmtDate(o.created, { noYear: true })) + '</span>'; }),
    ],
    groups: [
      { k: 'status', l: 'Status', v: function (o) { return o.status; }, ord: idxOrd(['open', 'resolved']), name: function (k) { return stChip('question', k); } },
      { k: 'kind', l: 'Kind', v: function (o) { return o.kind; }, ord: idxOrd(QKINDS), name: plainName },
      { k: 'severity', l: 'Severity', v: function (o) { return o.severity; }, ord: function (k) { return SEVR[k]; }, name: function (k) { return '<span class="sev sev-' + k + '">' + SEVL[k] + '</span>'; } }],
    group: 'status', sort: { k: 'severity', dir: 1 },
    hay: function (o) { return o.kind + ' ' + o.status + ' ' + (o.resolution || ''); },
    cardCols: ['severity', 'kind', 'status'],
    newF: [['text', 'Question', 'text', { req: 1, ph: 'e.g. Does the Cartographer know Mira\'s real name?', wide: 1 }], ['kind', 'Kind', QKINDS.map(function (k) { return [k, cap(k)]; })], ['severity', 'Severity', [['high', 'High'], ['med', 'Med'], ['low', 'Low']], { def: 'med' }]],
  };

  var TSTAT = ['doing', 'todo', 'done'];
  COLL.tasks = {
    type: 'task', label: 'Tasks', desc: 'Concrete production work. No due dates: it is done when the game is ready.',
    empty: 'No tasks yet. Concrete production work goes here: things to make, buy, record or check.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('title', 'Task', function (o) { return o.title.toLowerCase(); }, function (o) { return strong(o.title); }, 'c-title'),
      col('status', 'Status', function (o) { return TSTAT.indexOf(o.status); }, function (o) { return stChip('task', o.status); }),
      col('links', 'Links', function (o) { return (o.links || []).length; }, function (o) { return Rs(o.links, { idOnly: true, max: 20 }); }),
    ],
    groups: [{ k: 'status', l: 'Status', v: function (o) { return o.status; }, ord: idxOrd(TSTAT), name: function (k) { return stChip('task', k); } }],
    group: 'status', sort: { k: 'id', dir: 1 },
    cardCols: ['status', 'links'],
    newF: [['title', 'Task', 'text', { req: 1, ph: 'e.g. Proofread Folio One', wide: 1 }]],
  };

  COLL.notes = {
    type: 'note', label: 'Notes', desc: 'Free-form pages. #P04, @Ida Vance and [[Phaistos Disc]] become links.',
    empty: 'No notes yet. Notes are free-form pages where #P04, @Name and [[Name]] link to things. You can also bring in one of your cade.txt rooms.',
    cols: [
      col('id', 'ID', cKey, hKey, 'c-key'),
      col('title', 'Title', function (o) { return o.title.toLowerCase(); }, function (o) { return strong(o.title); }, 'c-title'),
      col('updated', 'Updated', function (o) { return o.updated || ''; }, function (o) { return '<span class="t-mono">' + esc(K.fmtDate(o.updated, { noYear: true })) + '</span>'; }),
      col('mentions', 'Mentions', function (o) { return K.textRefs(o.body).length; }, function (o) { return Rs(K.textRefs(o.body), { idOnly: true, max: 18 }); }),
    ],
    groups: [], group: 'none', sort: { k: 'updated', dir: -1 }, cardCols: ['updated', 'mentions'],
    hay: function (o) { return o.body; },
    newF: [['title', 'Title', 'text', { req: 1, ph: 'e.g. Chapter 2 pacing', wide: 1 }]],
  };

  var TYPE_COLL = {};
  COLL_KEYS.forEach(function (k) { COLL[k].key = k; TYPE_COLL[COLL[k].type] = k; });
  function collData(key) { return K.list(COLL[key].type); }

  function view(key) {
    if (!S.views[key]) {
      var c = COLL[key], p = prefs[key] || {};
      var okGroup = p.group && (p.group === 'none' || (c.groups || []).some(function (g) { return g.k === p.group; }));
      var okSort = p.sort && c.cols.some(function (x) { return x.k === p.sort.k; });
      S.views[key] = {
        q: '', closed: {},
        group: okGroup ? p.group : (c.group || 'none'),
        sort: okSort ? { k: p.sort.k, dir: p.sort.dir === -1 ? -1 : 1 } : { k: c.sort.k, dir: c.sort.dir },
        mode: p.mode === 'cards' ? 'cards' : 'table',
      };
    }
    return S.views[key];
  }


  /* current mount (only one Codex instance exists at a time) */
  var V = null;

  /* ---------- collection data pipeline ---------- */
  function cmp(x, y) {
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
  }
  function rows(key) {
    var c = COLL[key], v = view(key), all = collData(key);
    var vis = all.filter(function (o) { return shown(o.id); });
    var terms = v.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var list = !terms.length ? vis.slice() : vis.filter(function (o) {
      var hay = (o.id + ' ' + K.label(o.id) + ' ' + K.summary(o.id) + ' ' + (o.layer ? K.layer(o.layer).label : '') + ' ' + (c.hay ? c.hay(o) : '')).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
    var sc = c.cols.find(function (x) { return x.k === v.sort.k; }) || c.cols[0];
    list.sort(function (a, b) {
      var x = sc.v(a), y = sc.v(b);
      var xn = x == null || x === '', yn = y == null || y === '';
      if (xn !== yn) return xn ? 1 : -1;
      return (xn ? 0 : cmp(x, y) * v.sort.dir) || cmp(a.id, b.id);
    });
    return { all: all, vis: vis, list: list };
  }
  function groupSpec(key) { var v = view(key); return (COLL[key].groups || []).find(function (g) { return g.k === v.group; }) || null; }
  function grouped(key, list) {
    var g = groupSpec(key);
    if (!g) return [{ key: '', items: list }];
    var map = new Map();
    list.forEach(function (o) { var k = g.v(o); k = k == null ? '' : String(k); if (!map.has(k)) map.set(k, []); map.get(k).push(o); });
    var arr = Array.from(map, function (e) { return { key: e[0], items: e[1] }; });
    arr.sort(function (a, b) { return (g.ord(a.key) - g.ord(b.key)) || cmp(a.key, b.key); });
    return arr;
  }

  /* ---------- reality-layer filter chips (claim collections only) ---------- */
  function layerChips(key) {
    var c = COLL[key]; if (!isClaim(c.type)) return '';
    var all = collData(key), allowed = vals(c.type, 'layer');
    var off = LAYER_IDS.filter(function (l) { return !S.on[l]; }).length;
    return '<div class="cx-layers" role="group" aria-label="Reality layers"><span class="eyebrow">Layers</span>' +
      D.layers.filter(function (l) { return allowed.indexOf(l.id) >= 0; }).map(function (l) {
        var n = all.filter(function (o) { return o.layer === l.id; }).length;
        return '<button type="button" class="cx-lt layer-' + l.id + '" data-act="layer" data-layer="' + l.id + '" aria-pressed="' + !!S.on[l.id] + '" title="' + esc((S.on[l.id] ? 'Hide ' : 'Show ') + l.label + ': ' + l.desc) + '"><span class="sw"></span>' + esc(l.label) + '<span class="n">' + n + '</span></button>';
      }).join('') +
      (off ? '<button type="button" class="btn ghost sm" data-act="all-layers">Show all</button>' : '') + '</div>';
  }

  /* ---------- collection view ---------- */
  function renderColl(key) {
    if (COLL[key].toc) { renderToc(key); return; }
    var c = COLL[key], v = view(key), r = rows(key), hidden = r.all.length - r.vis.length, bare = !r.all.length;
    var groups = c.groups || [];
    var sortOpts = '';
    c.cols.forEach(function (x) {
      [1, -1].forEach(function (d) {
        sortOpts += '<option value="' + x.k + ':' + d + '"' + (v.sort.k === x.k && v.sort.dir === d ? ' selected' : '') + '>' + esc(x.l) + (d > 0 ? ' ↑' : ' ↓') + '</option>';
      });
    });
    V.main.innerHTML =
      '<section class="cx-coll" aria-label="' + esc(c.label) + '">' +
        '<header class="cx-coll-head"><span class="cx-ch-ic">' + esc(K.TYPES[c.type].icon) + '</span><h1>' + esc(c.label) + '</h1>' +
          '<span class="cx-ch-n num">' + r.vis.length + (hidden ? '<span class="faint"> of ' + r.all.length + '</span>' : '') + '</span>' +
          (hidden ? '<span class="cx-ch-hidden">' + hidden + ' on hidden layers</span>' : '') + '</header>' +
        '<p class="cx-coll-desc">' + esc(c.desc) + '</p>' +
        (bare ? '' : layerChips(key)) +
        '<div class="cx-toolbar">' + (bare ? '<span class="cx-tb-sp"></span>' :
          '<label class="cx-filter">' + IC.search + '<input id="cx-flt" data-fk="flt" class="input" type="search" autocomplete="off" spellcheck="false" placeholder="Filter ' + esc(c.label.toLowerCase()) + '" aria-label="Filter ' + esc(c.label) + '" value="' + esc(v.q) + '"><span class="kbd">/</span></label>' +
          (groups.length ? '<label class="cx-tb-l">Group <select id="cx-grp" data-fk="grp" class="input"><option value="none">None</option>' +
            groups.map(function (g) { return '<option value="' + g.k + '"' + (v.group === g.k ? ' selected' : '') + '>' + esc(g.l) + '</option>'; }).join('') + '</select></label>' : '') +
          '<label class="cx-tb-l cx-sort-m">Sort <select id="cx-srt" data-fk="srt" class="input">' + sortOpts + '</select></label>' +
          '<span class="cx-tb-sp"></span>' +
          '<div class="seg" role="group" aria-label="View as"><button type="button" data-act="mode" data-mode="table" data-fk="mode-table" aria-pressed="' + (v.mode === 'table') + '">Table</button><button type="button" data-act="mode" data-mode="cards" data-fk="mode-cards" aria-pressed="' + (v.mode === 'cards') + '">Cards</button></div>' +
          '<button type="button" class="btn sm" data-act="export" data-fk="export" title="Export this collection for an LLM">' + IC.exp + '<span class="cx-hide-s">Export</span></button>') +
          '<button type="button" class="btn primary sm" data-act="new" data-fk="new" aria-expanded="' + !!V.newOpen + '">' + IC.plus + 'New ' + esc(K.TYPES[c.type].label.toLowerCase()) + '</button>' +
        '</div>' +
        '<div id="cx-newform"></div>' +
        '<div id="cx-body"></div>' +
      '</section>';
    renderNewForm(key);
    renderBody(key);
  }

  function groupHead(key, g, n, colspan) {
    var gs = groupSpec(key), v = view(key), closed = !!v.closed[g.key];
    var aside = gs.aside ? gs.aside(g.key) : '';
    var inner = '<button type="button" class="cx-grp-btn" data-act="gtoggle" data-g="' + esc(g.key) + '" aria-expanded="' + !closed + '">' + IC.chev +
      '<span class="cx-grp-name">' + gs.name(g.key) + '</span><span class="count">' + n + '</span>' +
      (aside && aside.t ? '<span class="cx-grp-aside ' + (aside.c || '') + '">' + esc(aside.t) + '</span>' : '') + '</button>';
    return colspan ? '<tr class="cx-grp-row"><th colspan="' + colspan + '">' + inner + '</th></tr>' : '<div class="cx-card-grp">' + inner + '</div>';
  }
  function hasKey(c) { return c.cols.some(function (x) { return x.cls.indexOf('c-key') >= 0; }); }
  function rowHtml(c, o) {
    return '<tr class="row' + (hasKey(c) ? ' has-key' : '') + '" tabindex="0" data-id="' + esc(o.id) + '" data-fk="row-' + esc(o.id) + '"' + (o.layer && isClaim(c.type) ? ' data-layer="' + o.layer + '"' : '') + '>' +
      c.cols.map(function (x) { return '<td class="' + x.cls + '" data-label="' + esc(x.l) + '">' + x.h(o) + '</td>'; }).join('') + '</tr>';
  }
  function cardHtml(c, o) {
    var t = c.type, sum = '';
    if (t === 'puzzle') sum = o.premise || o.mechanic;
    else if (t === 'character') sum = o.role;
    else if (t === 'question') sum = o.resolution || '';
    else if (t === 'event') sum = o.twist || o.record;
    else if (t === 'note') sum = (o.body || '').slice(0, 220);
    else if (t === 'chapter') sum = o.summary;
    else if (t !== 'clue') sum = K.summary(o.id);
    var cols = (c.cardCols || []).map(function (k) { return c.cols.find(function (x) { return x.k === k; }); }).filter(Boolean);
    return '<article class="cx-card" tabindex="0" data-id="' + esc(o.id) + '" data-fk="card-' + esc(o.id) + '"' + (o.layer && isClaim(t) ? ' data-layer="' + o.layer + '"' : '') + '>' +
      '<div class="cx-card-top">' + (IDPAT.test(o.id) ? idc(o.id) : '<span class="eyebrow">' + esc(K.TYPES[t].label) + '</span>') +
        (o.layer && isClaim(t) ? K.layerBadge(o.layer, { short: true }) : '') + '<span class="sp"></span>' + (t === 'puzzle' ? K.pips(o.status) : '') + '</div>' +
      '<div class="cx-card-title' + (t === 'clue' ? ' doc' : '') + '">' + esc(K.label(o.id)) + '</div>' +
      (o.guard ? '<span class="cx-guard-cell">' + IC.shield + '<span>' + esc(o.guard) + '</span></span>' : '') +
      (sum ? '<div class="cx-card-sum">' + esc(sum) + '</div>' : '') +
      (cols.length ? '<div class="cx-card-meta">' + cols.map(function (x) { return '<span class="cm"><span class="cm-l">' + esc(x.l) + '</span>' + x.h(o) + '</span>'; }).join('') + '</div>' : '') +
    '</article>';
  }
  function renderBody(key) {
    var el = V && V.main.querySelector('#cx-body'); if (!el) return;
    var c = COLL[key], v = view(key), r = rows(key), gs = groupSpec(key);
    if (!r.list.length) {
      var hiddenN = r.all.length - r.vis.length;
      var off = D.layers.filter(function (l) { return !S.on[l.id]; }).map(function (l) { return l.label; });
      if (v.q) el.innerHTML = '<div class="cx-empty">Nothing matches “' + esc(v.q) + '”.<div><button type="button" class="btn sm" data-act="clear-q">Clear filter</button></div></div>';
      else if (hiddenN) el.innerHTML = '<div class="cx-empty">All ' + hiddenN + ' ' + esc(c.label.toLowerCase()) + ' are on hidden layers (' + esc(off.join(', ')) + ').<div><button type="button" class="btn sm" data-act="all-layers">Show all layers</button></div></div>';
      else el.innerHTML = emptyState(key);
      return;
    }
    var groups = grouped(key, r.list);
    if (v.mode === 'cards') {
      el.innerHTML = groups.map(function (g) {
        return (gs ? groupHead(key, g, g.items.length) : '') + (gs && v.closed[g.key] ? '' : '<div class="cx-cards">' + g.items.map(function (o) { return cardHtml(c, o); }).join('') + '</div>');
      }).join('');
    } else {
      var head = '<thead><tr>' + c.cols.map(function (x) {
        var on = v.sort.k === x.k;
        return '<th' + (on ? ' aria-sort="' + (v.sort.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '><button type="button" data-act="sort" data-k="' + x.k + '" data-fk="sort-' + x.k + '">' + esc(x.l) + '<span class="arr" aria-hidden="true">' + (on ? (v.sort.dir > 0 ? '↑' : '↓') : '') + '</span></button></th>';
      }).join('') + '</tr></thead>';
      el.innerHTML = '<div class="cx-tbl-wrap"><table class="cx-tbl">' + head + groups.map(function (g) {
        return '<tbody>' + (gs ? groupHead(key, g, g.items.length, c.cols.length) : '') + (gs && v.closed[g.key] ? '' : g.items.map(function (o) { return rowHtml(c, o); }).join('')) + '</tbody>';
      }).join('') + '</table></div>';
    }
    decorate(el);
  }

  /* ---------- inline New ---------- */
  function renderNewForm(key) {
    var el = V && V.main.querySelector('#cx-newform'); if (!el) return;
    var c = COLL[key];
    if (!V.newOpen || !c.newF) { el.innerHTML = ''; return; }
    var tl = K.TYPES[c.type].label.toLowerCase();
    var preview = K.TYPES[c.type].slug ? K.TYPES[c.type].prefix + '…' : K.nextId(c.type);
    el.innerHTML = '<form class="cx-newform" data-form="new" data-key="' + key + '" autocomplete="off" novalidate>' +
      '<div class="cx-nf-h"><span class="eyebrow">New ' + esc(tl) + '</span><span class="id">' + esc(preview) + '</span><span class="faint">Opens its page when created. Fill in the rest there.</span></div>' +
      '<div class="cx-nf-fields">' + c.newF.map(function (f) {
        var name = f[0], label = f[1], kind = f[2], o = f[3] || {}, ctl;
        if (kind === 'layer') ctl = '<select class="input" name="' + name + '" data-fk="nf-' + name + '">' + D.layers.filter(function (l) { return vals(c.type, 'layer').indexOf(l.id) >= 0; }).map(function (l) { return '<option value="' + l.id + '"' + (o.def === l.id ? ' selected' : '') + '>' + esc(l.label) + '</option>'; }).join('') + '</select>';
        else if (kind === 'chapter') ctl = '<select class="input" name="' + name + '" data-fk="nf-' + name + '">' + K.chapters().map(function (a, i) { return '<option value="' + a.id + '"' + (i === 0 ? ' selected' : '') + '>' + esc(chapTitle(a)) + '</option>'; }).join('') + (o.none ? '<option value="">' + esc(o.none) + '</option>' : '') + '</select>';
        else if (kind === 'event') ctl = '<select class="input" name="' + name + '" data-fk="nf-' + name + '">' + eventOptions(V.newEvent || '', 'No event yet') + '</select>';
        else if (Array.isArray(kind)) ctl = '<select class="input" name="' + name + '" data-fk="nf-' + name + '"' + (o.num ? ' data-num="1"' : '') + '>' + kind.map(function (op) { return '<option value="' + esc(op[0]) + '"' + (String(o.def) === String(op[0]) ? ' selected' : '') + '>' + esc(op[1]) + '</option>'; }).join('') + '</select>';
        else ctl = '<input class="input" name="' + name + '" data-fk="nf-' + name + '" type="' + (kind === 'number' ? 'number' : 'text') + '"' + (kind === 'number' ? ' data-num="1" inputmode="decimal"' : '') + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + (o.req ? ' data-req="1"' : '') + '>';
        return '<label class="cx-nf-f' + (o.wide ? ' wide' : '') + '"><span>' + esc(label) + '</span>' + ctl + '</label>';
      }).join('') + '</div>' +
      '<div class="cx-nf-actions"><button type="submit" class="btn primary sm" data-fk="nf-submit">Create ' + esc(tl) + '</button><button type="button" class="btn ghost sm" data-act="new-cancel">Cancel</button></div>' +
    '</form>';
  }
  function createNew(form) {
    var key = form.dataset.key, c = COLL[key], obj = {}, bad = null;
    $$('input, select', form).forEach(function (i) {
      var v = i.value.trim();
      i.classList.remove('invalid');
      if (i.dataset.req && !v && !bad) bad = i;
      if (v === '') return;
      obj[i.name] = i.dataset.num ? +v : v;
    });
    if (bad) { bad.classList.add('invalid'); bad.focus(); K.toast('Give it a ' + bad.closest('label').firstChild.textContent.toLowerCase() + ' first.'); return; }
    if (c.type === 'character' && (obj.kind === 'historical' || obj.kind === 'living')) obj.guard = 'Real person. Use documented facts only. No invented words or deeds.';
    if (c.type === 'event') { obj.chapter = obj.chapter || null; obj.order = nextOrder(obj.chapter); }
    if (c.type === 'puzzle' && !obj.event) obj.event = null;
    V.newOpen = false; V.newEvent = null;
    var id = K.create(c.type, obj);
    V.ctx.go(id);
    K.toast('Created ' + K.typeName(id).toLowerCase() + ' ' + id + ' · ' + trunc(K.label(id), 40) + (obj.guard ? ' (guard added)' : ''));
  }

  /* ---------- phone chip row ---------- */
  function navCurrent() {
    var r = V.route;
    if (r.kind === 'coll') return r.key;
    if (r.kind === 'problems') return 'problems';
    if (r.kind === 'entity') return collToken(K.type(r.id));
    return '';
  }
  function renderMnav() {
    var cur = navCurrent(), n = K.integrity().length;
    var items = COLL_KEYS.map(function (k) { return [k, COLL[k].label, collData(k).length]; })
      .concat([['research', 'Research', K.list('research').length], ['ideas', 'Ideas', K.list('idea').length]]);
    V.mnav.innerHTML = '<div class="cx-mnav-row" role="navigation" aria-label="Codex collections">' +
      '<a class="cx-mchip prob" href="#problems"' + (cur === 'problems' ? ' aria-current="page"' : '') + '>Problems <span class="n">' + n + '</span></a>' +
      items.map(function (it) { return '<a class="cx-mchip' + (it[0] === 'research' || it[0] === 'ideas' ? ' lib' : '') + '" href="#' + it[0] + '"' + (cur === it[0] ? ' aria-current="page"' : '') + '>' + esc(it[1]) + ' <span class="n">' + it[2] + '</span></a>'; }).join('') +
      '</div>';
    scrollChip();
  }
  function scrollChip() {
    if (!V) return;
    var a = $('.cx-mchip[aria-current]', V.mnav);
    if (a) { var row = a.parentNode; row.scrollLeft = Math.max(0, row.scrollLeft + a.getBoundingClientRect().left - row.getBoundingClientRect().left - 16); }
  }

  /* ---------- problems view ---------- */
  function renderProblems() {
    var iss = K.integrity(), n = { high: 0, med: 0, low: 0 };
    iss.forEach(function (i) { n[i.severity]++; });
    var f = S.probSev, list = f === 'all' ? iss : iss.filter(function (i) { return i.severity === f; });
    var kinds = [], by = {};
    list.forEach(function (i) { if (!by[i.kind]) { by[i.kind] = []; kinds.push(i.kind); } by[i.kind].push(i); });
    V.main.innerHTML = '<section class="cx-coll"><header class="cx-coll-head"><span class="cx-ch-ic">!</span><h1>Problems</h1><span class="cx-ch-n num">' + iss.length + '</span></header>' +
      '<p class="cx-coll-desc">Checks across the whole game. They rerun after every edit: unplanted and orphan clues, missing solutions and solve paths, design checks, broken recipes, chapter order, dead ends, unverified research, renewals.</p>' +
      '<div class="cx-toolbar">' + (iss.length ? '<div class="seg" role="group" aria-label="Severity">' + [['all', 'All', iss.length], ['high', 'High', n.high], ['med', 'Med', n.med], ['low', 'Low', n.low]].map(function (s) {
        return '<button type="button" data-act="prob-sev" data-s="' + s[0] + '" data-fk="sev-' + s[0] + '" aria-pressed="' + (f === s[0]) + '">' + s[1] + ' <span class="num">' + s[2] + '</span></button>';
      }).join('') + '</div>' : '') + '<span class="cx-tb-sp"></span><button type="button" class="btn sm" data-act="export" title="Export the whole game for an LLM">' + IC.exp + 'Export game</button></div>' +
      (kinds.length ? kinds.map(function (k) {
        return '<section class="cx-pg"><div class="cx-pg-h"><h2>' + esc(k) + '</h2><span class="count">' + by[k].length + '</span></div><div class="cx-pg-list">' + by[k].map(function (i) {
          return '<div class="cx-pi"><span class="sev sev-' + i.severity + '">' + SEVL[i.severity] + '</span><div><div class="cx-pi-t">' + esc(i.text) + '</div>' + Rs(i.ids, { max: 30 }) + '</div></div>';
        }).join('') + '</div></section>';
      }).join('') : '<div class="cx-empty">' + (iss.length ? 'Nothing at this severity.' : '<b>No problems.</b> Every check passes. They rerun as you add events, puzzles and clues.') + '</div>') + '</section>';
    decorate(V.main);
  }

  /* ---------- empty states: say what goes here, offer the first action ---------- */
  function nextOrder(ch) { var evs = K.eventsIn(ch || null); return evs.length ? Math.max.apply(null, evs.map(function (e) { return +e.order || 0; })) + 1 : 1; }
  function addEventBtn(ch, label, primary) {
    return '<button type="button" class="btn sm' + (primary ? ' primary' : '') + '" data-act="new-event" data-ch="' + esc(ch ? ch.id : '') + '" data-fk="new-event-' + esc(ch ? ch.id : 'none') + '">' + IC.plus + esc(label || ('Add an event to ' + (ch ? chapTitle(ch) : 'the parking lot'))) + '</button>';
  }
  function emptyState(key) {
    var c = COLL[key], t = K.TYPES[c.type].label.toLowerCase(), ch = firstChapter(), btns;
    switch (key) {
      case 'events': btns = ch ? addEventBtn(ch, null, true) : '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Add an event</button>'; break;
      case 'puzzles':
        btns = D.events.length ? '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Add your first puzzle</button>'
          : (ch ? addEventBtn(ch, 'Add an event to ' + chapTitle(ch) + ' first', true) : '') + '<button type="button" class="btn sm" data-act="new">' + IC.plus + 'Add a puzzle without an event</button>';
        break;
      case 'notes': btns = '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Write a note</button><button type="button" class="btn sm" data-act="import">Bring in a cade.txt room…</button>'; break;
      case 'questions': btns = '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Raise a question</button>'; break;
      case 'tasks': btns = '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Add a task</button>'; break;
      case 'timeline': btns = '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Add your first entry</button>'; break;
      default: btns = '<button type="button" class="btn sm primary" data-act="new">' + IC.plus + 'Add your first ' + esc(t) + '</button>';
    }
    return '<div class="cx-empty cx-empty-first"><span class="cx-empty-ic">' + esc(K.TYPES[c.type].icon) + '</span><p>' + esc(c.empty || ('No ' + c.label.toLowerCase() + ' yet.')) + '</p><div class="cx-row-btns">' + btns + '</div></div>';
  }

  /* ---------- Chapters: the game's table of contents ---------- */
  function tocPuzzles(eid) {
    var ps = K.puzzlesInEvent(eid);
    if (!ps.length) return '<span class="faint cx-toc-none">no puzzles yet</span>';
    return ps.map(function (p) { return '<span class="cx-toc-pz">' + R(p.id, { idOnly: true }) + K.pips(p.status) + '</span>'; }).join('');
  }
  function tocEvent(e) {
    return '<li class="cx-toc-ev"' + (e.layer ? ' data-layer="' + e.layer + '"' : '') + '><span class="cx-toc-ord t-mono">' + esc(e.chapter ? (e.order || '·') : '·') + '</span>' +
      '<span class="cx-toc-evmain">' + R(e.id, { max: 60 }) + (e.when ? '<span class="t-mono cx-toc-when">' + esc(K.fmtDate(e.when)) + '</span>' : '') + '</span>' +
      '<span class="cx-toc-pzs">' + tocPuzzles(e.id) + '</span></li>';
  }
  function renderToc(key) {
    var c = COLL[key], chs = K.chapters(), unplaced = K.eventsIn(null);
    var body;
    if (!chs.length) body = emptyState(key);
    else body = chs.map(function (ch) {
      var evs = K.eventsIn(ch.id), np = K.puzzlesIn(ch.id).length;
      return '<section class="cx-toc-ch" aria-label="' + esc(chapTitle(ch)) + '"><header class="cx-toc-h"><span class="cx-toc-n t-mono">' + esc(ch.n) + '</span>' +
        '<button type="button" class="cx-toc-title" data-act="go" data-to="' + esc(ch.id) + '">' + esc(ch.title || 'Untitled chapter') + '</button>' +
        '<span class="cx-toc-meta t-mono">' + evs.length + ' event' + (evs.length === 1 ? '' : 's') + ' · ' + np + ' puzzle' + (np === 1 ? '' : 's') + '</span></header>' +
        (ch.summary ? '<p class="cx-toc-sum">' + esc(ch.summary) + '</p>' : '') +
        (evs.length ? '<ol class="cx-toc-evs">' + evs.map(tocEvent).join('') + '</ol>' : '<p class="cx-toc-emptych">Nothing in this chapter yet. Events are the moments it is built from; puzzles go inside them.</p>') +
        '<div class="cx-toc-foot">' + addEventBtn(ch, 'Add an event', !evs.length) + '</div></section>';
    }).join('') + (unplaced.length ? '<section class="cx-toc-ch cx-toc-unplaced" aria-label="Not placed yet"><header class="cx-toc-h"><span class="cx-toc-n t-mono">·</span><span class="cx-toc-title static">Not placed yet</span><span class="cx-toc-meta t-mono">' + unplaced.length + ' event' + (unplaced.length === 1 ? '' : 's') + '</span></header>' +
      '<p class="cx-toc-sum">The parking lot. Open an event to give it a chapter.</p><ol class="cx-toc-evs">' + unplaced.map(tocEvent).join('') + '</ol></section>' : '');
    var ne = D.events.length, np2 = D.puzzles.length;
    V.main.innerHTML = '<section class="cx-coll cx-toc" aria-label="Chapters">' +
      '<header class="cx-coll-head"><span class="cx-ch-ic">CH</span><h1>Chapters</h1><span class="cx-ch-n num">' + chs.length + '</span><span class="t-mono cx-toc-tot">' + ne + ' event' + (ne === 1 ? '' : 's') + ' · ' + np2 + ' puzzle' + (np2 === 1 ? '' : 's') + '</span></header>' +
      '<p class="cx-coll-desc">' + esc(c.desc) + '</p>' +
      '<div class="cx-toolbar"><span class="cx-tb-sp"></span>' +
        '<button type="button" class="btn sm" data-act="export" data-fk="export" title="Export every chapter for an LLM">' + IC.exp + '<span class="cx-hide-s">Export</span></button>' +
        '<button type="button" class="btn primary sm" data-act="new" data-fk="new" aria-expanded="' + !!V.newOpen + '">' + IC.plus + 'New chapter</button></div>' +
      '<div id="cx-newform"></div><div id="cx-body">' + body + '</div></section>';
    renderNewForm(key);
    decorate(V.main);
  }


  /* ---------- entity page: building blocks ---------- */
  function sec(title, inner, actions, count, cls) {
    return '<section class="cx-sec' + (cls ? ' ' + cls : '') + '"><div class="cx-sec-h"><h2>' + esc(title) + '</h2>' + (count != null ? '<span class="count">' + count + '</span>' : '') +
      '<span class="sp"></span>' + (actions || '') + '</div>' + inner + '</section>';
  }
  /* click-to-edit block or inline value. kind: long | text | num */
  function ed(id, path, val, ph, kind, cls) {
    kind = kind || 'long';
    var tag = kind === 'long' ? 'div' : 'span';
    var shownVal = val == null || val === '' ? '<span class="ph">' + esc(ph || 'Empty') + '</span>' : esc(val);
    return '<' + tag + ' class="cx-ed cx-ed-' + kind + (cls ? ' ' + cls : '') + '" tabindex="0" role="button" data-id="' + esc(id) + '" data-path="' + esc(path) + '" data-kind="' + kind + '" data-fk="ed-' + esc(id) + '-' + esc(path) + '" title="Click to edit">' + shownVal + '</' + tag + '>';
  }
  function psel(id, prop, opts, cur, o) {
    o = o || {};
    if (cur != null && cur !== '' && !opts.some(function (x) { return String(x[0]) === String(cur); })) opts = opts.concat([[cur, cur]]);
    return '<select class="cx-psel" data-set="' + prop + '" data-id="' + esc(id) + '" data-fk="set-' + esc(id) + '-' + prop + '"' + (o.num ? ' data-num="1"' : '') + (o.nul ? ' data-null="1"' : '') + ' aria-label="' + esc(o.label || cap(prop)) + '">' +
      opts.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(cur == null ? '' : cur) ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>';
  }
  function enumOpts(type, field) { return vals(type, field).map(function (x) { return [x, cap(x)]; }); }
  function refOpts(types, none) {
    var out = none ? [['', none]] : [];
    types.forEach(function (t) { K.list(t).forEach(function (o) { out.push([o.id, (IDPAT.test(o.id) ? o.id + ' · ' : '') + trunc(K.label(o.id), 40)]); }); });
    return out;
  }
  function sw(id, prop, on, onTxt, offTxt) {
    return '<button type="button" class="cx-switch" data-act="toggle" data-id="' + esc(id) + '" data-f="' + prop + '" data-fk="sw-' + esc(id) + '-' + prop + '" aria-pressed="' + !!on + '"><span class="tr"></span>' + esc(on ? onTxt : offTxt) + '</button>';
  }
  function diffEdit(o) {
    var h = '<span class="cx-diff-ed' + (o.difficulty >= 4 ? ' hard' : '') + '" role="group" aria-label="Difficulty">';
    for (var i = 1; i <= 5; i++) h += '<button type="button" data-act="diff" data-id="' + o.id + '" data-n="' + i + '" data-fk="diff-' + i + '" class="' + (i <= o.difficulty ? 'on' : '') + '" aria-label="Difficulty ' + i + '" aria-pressed="' + (i === o.difficulty) + '"><i></i></button>';
    return h + '</span><span class="t-mono">' + (o.difficulty || 0) + ' / 5</span>';
  }
  function attachBtn(id, field, label) {
    return '<button type="button" class="btn ghost sm cx-attach" data-act="attach" data-id="' + esc(id) + '" data-f="' + field + '" data-fk="attach-' + field + '">' + IC.plus + esc(label) + '</button>';
  }
  function unlinkBtn(id, field, t) { return '<button type="button" class="cx-tool" data-act="unlink" data-id="' + esc(id) + '" data-f="' + field + '" data-t="' + esc(t) + '" aria-label="Remove ' + esc(t) + ' from ' + esc(field) + '">' + IC.x + '</button>'; }

  /* one-line context for a linked entity */
  function ctxLine(x) {
    var o = K.get(x), t = K.type(x);
    if (!o) return '';
    switch (t) {
      case 'clue': return '<span class="doc">' + esc(o.text) + '</span>';
      case 'question': return '<span class="sev sev-' + o.severity + '"></span>' + esc(o.text) + (o.status === 'resolved' ? ' · resolved' : '');
      case 'task': return esc(o.title) + ' · ' + esc(o.status);
      case 'research': return '<span class="cx-rs ' + (o.status === 'verified' ? 'ok' : o.status === 'read' ? 'mid' : 'bad') + '">' + esc(o.status) + '</span> ' + esc(o.title);
      case 'idea': return esc(o.status + ' · ' + o.text);
      case 'entry': return esc(K.fmtDate(o.date)) + (o.revealedBy ? ' · revealed by ' + esc(o.revealedBy) : '');
      case 'event': return esc([o.title, o.chapter ? chapShort(o.chapter) + (o.order ? ' #' + o.order : '') : 'not placed yet', o.when ? K.fmtDate(o.when) : ''].filter(Boolean).join(' · '));
      case 'puzzle': return esc(o.title) + ' · ' + esc(K.statusLabel(o.status));
      case 'character': return esc(o.kind + ' · ' + (o.role || ''));
      case 'asset': return esc(o.name + ' · ' + o.status);
      case 'chapter': return esc('Chapter ' + o.n + ' · ' + o.title);
      case 'note': return esc(o.title);
      case 'place': return esc((+o.lat).toFixed(2) + ', ' + (+o.lng).toFixed(2));
    }
    return '';
  }
  /* rows: ref + context + side controls */
  function lrows(ids, side, empty) {
    ids = (ids || []).filter(function (x) { return K.get(x); });
    if (!ids.length) return '<p class="cx-empty-note">' + esc(empty || 'Nothing yet.') + '</p>';
    return '<div class="cx-list">' + ids.map(function (x) {
      return '<div class="cx-lr' + (shown(x) ? '' : ' is-dim') + '"><div class="cx-lr-main">' + R(x, { idOnly: true, max: 40 }) + '<span class="cx-lr-ctx">' + ctxLine(x) + '</span></div><div class="cx-lr-side">' + (side ? side(x) : '') + '</div></div>';
    }).join('') + '</div>';
  }
  function layerSide(x) { var l = K.layerOf(x); return l ? K.layerBadge(l, { short: true }) : ''; }
  function pipSide(x) { var o = K.get(x); return K.type(x) === 'puzzle' ? K.pips(o.status, { label: true }) : layerSide(x); }
  /* editable refs list (attach / detach) */
  function refsSec(id, field, title, opts) {
    opts = opts || {};
    var o = K.get(id), ids = (o[field] || []).filter(function (x) { return K.get(x); });
    return sec(title, lrows(ids, function (x) { return (opts.side ? opts.side(x) : pipSide(x)) + unlinkBtn(id, field, x); }, opts.empty || 'Nothing linked yet.'),
      attachBtn(id, field, opts.add || 'Link'), ids.length);
  }

  var TYPE_ORDER = ['chapter', 'event', 'puzzle', 'clue', 'character', 'place', 'entry', 'asset', 'research', 'idea', 'question', 'task', 'note'];
  function railSec(title, ids, self, incoming, note) {
    var by = {};
    ids.forEach(function (x) { var t = K.type(x); if (t) (by[t] = by[t] || []).push(x); });
    var body = TYPE_ORDER.filter(function (t) { return by[t]; }).map(function (t) {
      return '<div class="cx-rail-grp"><div class="cx-rail-grp-l">' + esc(K.TYPES[t].plural) + ' · ' + by[t].length + '</div>' + by[t].map(function (x) {
        var f = (incoming ? K.fieldLinking(x, self) : K.fieldLinking(self, x)) || '';
        return '<div class="cx-lk' + (shown(x) ? '' : ' is-dim') + '"><div class="cx-lk-top">' + R(x, { idOnly: true, max: 30 }) + '<span class="cx-lk-f" title="Field">' + esc(f) + '</span></div><div class="cx-lk-ctx">' + ctxLine(x) + '</div></div>';
      }).join('') + '</div>';
    }).join('');
    return '<section class="cx-rail-sec"><div class="cx-rail-h"><h3>' + esc(title) + '</h3><span class="count">' + ids.length + '</span><span class="note">' + esc(note) + '</span></div>' + (body || '<p class="cx-rail-empty">Nothing yet.</p>') + '</section>';
  }

  /* ---------- fact check (research with status 'verified' counts) ---------- */
  function srcInfo(cid) {
    var t = K.type(cid), o = K.get(cid), direct = directSrc(cid), via = [];
    function viaM(mid) { if (mid === cid || !K.get(mid)) return; var s = directSrc(mid); if (s.length && !via.some(function (v) { return v.via === mid; })) via.push({ via: mid, ids: s }); }
    if (t === 'entry') (o.links || []).filter(function (l) { return K.type(l) === 'event'; }).forEach(viaM);
    if (t === 'character') D.timeline.forEach(function (e) { if ((e.links || []).indexOf(cid) >= 0) e.links.filter(function (l) { return K.type(l) === 'event'; }).forEach(viaM); });
    if (t === 'clue') (o.usedBy || []).forEach(function (pid) { var p = K.get(pid); if (p && p.event) viaM(p.event); });
    var all = direct.slice(); via.forEach(function (v) { v.ids.forEach(function (s) { if (all.indexOf(s) < 0) all.push(s); }); });
    var lay = K.layerOf(cid), ver = all.some(function (s) { return K.get(s).status === 'verified'; }), state;
    if (lay === 'fiction') state = 'inv';
    else state = ver ? 'ok' : all.length ? 'unv' : 'none';
    /* an event no puzzle uses yet is still a plan, not a problem */
    if ((state === 'unv' || state === 'none') && t === 'event' && !K.puzzlesInEvent(cid).length) state = 'todo';
    return { direct: direct, via: via, all: all, state: state, flag: state === 'unv' || state === 'none' };
  }
  function factClaims(id) {
    var t = K.type(id), o = K.get(id), out = [];
    function add(cid, role) { if (cid && K.get(cid) && K.layerOf(cid) && !out.some(function (x) { return x.id === cid; })) out.push({ id: cid, role: role }); }
    if (t === 'puzzle') {
      if (o.event) add(o.event, 'event');
      (o.reveals || []).forEach(function (r) { add(r, 'reveals'); });
      (o.inputs || []).forEach(function (c) { add(c, 'input'); });
      guardedFor(id).forEach(function (c) { add(c, 'real person'); });
    } else if (t === 'event') {
      add(id, 'this page');
      D.timeline.forEach(function (e) { if ((e.links || []).indexOf(id) >= 0) add(e.id, 'timeline'); });
      guardedFor(id).forEach(function (c) { add(c, 'real person'); });
    } else if (t === 'entry') {
      add(id, 'this page');
      (o.links || []).forEach(function (l) { var lt = K.type(l); if (lt === 'event' || lt === 'character') add(l, lt); });
    } else if (t === 'character') {
      add(id, 'this page');
      D.timeline.forEach(function (e) { if ((e.links || []).indexOf(id) >= 0) add(e.id, 'timeline'); });
    } else if (t === 'clue') add(id, 'this page');
    return out;
  }
  var FS = {
    ok: '<span class="cx-fs ok">✓ Verified</span>', unv: '<span class="cx-fs bad">Needs a source</span>', none: '<span class="cx-fs bad">Needs a source</span>',
    inv: '<span class="cx-fs inv">Invented</span>', todo: '<span class="cx-fs mute">No source yet</span>',
  };
  function srcRef(s) { var so = K.get(s); return R(s, { idOnly: true }) + '<span class="cx-vm ' + (so.status === 'verified' ? 'ok' : so.status === 'read' ? 'mid' : 'bad') + '">' + (so.status === 'verified' ? '✓' : esc(so.status)) + '</span>'; }
  function factSec(id) {
    var claims = factClaims(id); if (!claims.length) return '';
    var tally = { ok: 0, flag: 0, inv: 0 };
    var rowsH = claims.map(function (c) {
      var si = srcInfo(c.id), l = K.layerOf(c.id), o = K.get(c.id);
      if (si.flag) tally.flag++; else if (si.state === 'ok') tally.ok++; else if (si.state === 'todo') tally.todo = (tally.todo || 0) + 1; else tally.inv++;
      var claimText = K.type(c.id) === 'event' ? (o.record || (o.layer === 'fiction' ? '' : 'Nothing on the record written down yet.')) : K.type(c.id) === 'character' ? (o.guard || o.role) : '';
      var srcs;
      if (si.state !== 'inv') {
        srcs = si.direct.map(srcRef).join('') +
          si.via.map(function (v) { return '<span>via ' + esc(trunc(K.label(v.via).split(' (')[0], 28)) + '</span>' + v.ids.map(srcRef).join(''); }).join('') ||
          '<span>No research attached yet.</span>';
      } else srcs = '<span>Our fiction needs no source.</span>';
      var cite = si.flag || si.state === 'todo' ? '<button type="button" class="btn sm cx-cite" data-act="cite" data-id="' + esc(c.id) + '" data-fk="cite-' + esc(c.id) + '">' + IC.link + 'Cite research</button>' : '';
      return '<div class="cx-fact-row' + (si.flag ? ' flag' : '') + '">' + K.layerBadge(l, { short: true }) +
        '<div class="cx-fact-c"><div class="cx-fact-c-top">' + R(c.id, { max: 40 }) + '<span class="cx-fact-role">' + esc(c.role) + '</span></div>' +
          (claimText ? '<div class="cx-fact-claim">' + esc(claimText) + '</div>' : '') +
          '<div class="cx-fact-src">' + srcs + '</div></div>' +
        '<div class="cx-fact-st">' + FS[si.state] + cite + '</div></div>';
    }).join('');
    var own = K.type(id) === 'puzzle' ? directSrc(id) : [];
    var head = '<div class="cx-fact-h"><b>' + claims.length + ' claim' + (claims.length === 1 ? '' : 's') + '</b><span class="cx-fact-sum">' +
      (tally.ok ? '<span><span class="cx-fs ok">' + tally.ok + '</span> verified</span>' : '') +
      (tally.flag ? '<span><span class="cx-fs bad">' + tally.flag + '</span> need a source</span>' : '') +
      (tally.todo ? '<span><span class="cx-fs mute">' + tally.todo + '</span> not sourced yet</span>' : '') +
      (tally.inv ? '<span><span class="cx-fs inv">' + tally.inv + '</span> invented</span>' : '') + '</span></div>';
    var foot = '<div class="cx-fact-foot">Record and pseudo-history claims need verified research. Our fiction needs none.' +
      (own.length ? ' <span>Research cited for this puzzle:</span> ' + own.map(srcRef).join(' ') : '') + '</div>';
    return sec('Fact check', '<div class="cx-fact">' + head + rowsH + foot + '</div>', '<span class="note">keeps real history apart from invention</span>');
  }

  /* ---------- needs attention + guard ---------- */
  function attention(id) {
    var rowsA = [];
    V.issues.filter(function (i) { return i.ids.indexOf(id) >= 0; }).forEach(function (i) {
      rowsA.push([SEVR[i.severity], '<div class="cx-at-row"><span class="sev sev-' + i.severity + '">' + SEVL[i.severity] + '</span><span class="cx-at-t"><span class="cx-at-k">' + esc(i.kind) + '</span>' + esc(i.text) + '</span></div>']);
    });
    K.backlinks(id).forEach(function (b) {
      var o = K.get(b), t = K.type(b);
      if (t === 'question' && o.status === 'open') rowsA.push([SEVR[o.severity], '<div class="cx-at-row"><span class="sev sev-' + o.severity + '">' + SEVL[o.severity] + '</span><span class="cx-at-t">' + R(b, { idOnly: true }) + esc(o.text) + '</span></div>']);
      if (t === 'task' && o.status !== 'done') rowsA.push([3, '<div class="cx-at-row"><span class="cx-at-k">' + (o.status === 'doing' ? 'Doing' : 'To do') + '</span><span class="cx-at-t">' + R(b, { idOnly: true }) + esc(o.title) + '</span></div>']);
    });
    if (!rowsA.length) return '';
    rowsA.sort(function (a, b) { return a[0] - b[0]; });
    return '<section class="cx-attn" aria-label="Needs attention"><div class="cx-attn-h"><span class="eyebrow">Needs attention</span><span class="count">' + rowsA.length + '</span><a href="#problems">All problems</a></div>' + rowsA.map(function (r) { return r[1]; }).join('') + '</section>';
  }
  function guardBox(id) {
    var o = K.get(id), t = K.type(id);
    if (t === 'character') {
      var real = o.kind === 'historical' || o.kind === 'living';
      if (o.guard) return '<div class="cx-guard" role="note">' + IC.shield + '<div class="cx-guard-in"><div class="cx-guard-h">Real ' + (o.kind === 'living' ? 'living person' : 'person') + ' · handle with care</div>' + ed(id, 'guard', o.guard, 'Write the rule for using this person.', 'long', 'cx-guard-t') + '</div></div>';
      if (real) return '<div class="cx-guard warn" role="note">' + IC.shield + '<div class="cx-guard-in"><div class="cx-guard-h">Real person with no guard</div><div class="cx-guard-t">Write the rule for how the game may use them.</div><button type="button" class="btn sm" data-act="add-guard" data-id="' + esc(id) + '">Add a guard</button></div></div>';
      return '';
    }
    var g = guardedFor(id); if (!g.length) return '';
    return '<div class="cx-guard" role="note">' + IC.shield + '<div class="cx-guard-in"><div class="cx-guard-h">Real people on this page</div>' +
      g.map(function (c) { return '<div class="cx-guard-row">' + R(c) + '<span>' + esc(K.get(c).guard) + '</span></div>'; }).join('') + '</div></div>';
  }

  /* ordered text list (solve path, hints): edit, reorder, remove, add */
  function listEditor(id, field, opts) {
    var o = K.get(id), list = o[field] || [], key = id + ':' + field;
    var rws = list.map(function (txt, i) {
      var ck = key + ':' + i;
      return '<li class="cx-rung"><span class="cx-rung-n">' + (i + 1) + '</span>' + ed(id, field + '.' + i, txt, 'Empty step', 'long', 'cx-rung-t') +
        '<div class="cx-rung-meta">' +
        '<button type="button" class="cx-tool" data-act="list-move" data-d="-1" data-id="' + id + '" data-f="' + field + '" data-i="' + i + '" aria-label="Move ' + (i + 1) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + IC.up + '</button>' +
        '<button type="button" class="cx-tool" data-act="list-move" data-d="1" data-id="' + id + '" data-f="' + field + '" data-i="' + i + '" aria-label="Move ' + (i + 1) + ' down"' + (i === list.length - 1 ? ' disabled' : '') + '>' + IC.down + '</button>' +
        (V.confirm === ck ? '<button type="button" class="cx-tool confirm" data-act="list-del" data-id="' + id + '" data-f="' + field + '" data-i="' + i + '" data-fk="del-' + ck + '">Remove?</button>'
          : '<button type="button" class="cx-tool" data-act="list-del" data-id="' + id + '" data-f="' + field + '" data-i="' + i + '" aria-label="Remove ' + (i + 1) + '">' + IC.x + '</button>') +
        '</div></li>';
    }).join('');
    if (V.adding === key) rws += '<li class="cx-rung"><span class="cx-rung-n">' + (list.length + 1) + '</span><div class="cx-rung-add"><input class="input cx-add-in" data-id="' + id + '" data-f="' + field + '" data-fk="add-' + key + '" placeholder="' + esc(opts.ph) + '" aria-label="' + esc(opts.addLabel) + '"><button type="button" class="btn primary sm" data-act="list-save" data-id="' + id + '" data-f="' + field + '">Add</button><button type="button" class="btn ghost sm" data-act="list-cancel">Cancel</button></div><span></span></li>';
    else if (!list.length) rws = '<li class="cx-rung empty">' + esc(opts.empty) + '</li>';
    return '<ol class="cx-ladder">' + rws + '</ol>';
  }
  function tagsEditor(id) {
    var tags = K.get(id).tags || [];
    return '<div class="cx-tags">' + tags.map(function (t) {
      return '<span class="chip cx-tag">#' + esc(t) + '<button type="button" class="cx-tag-x" data-act="tag-del" data-id="' + esc(id) + '" data-tag="' + esc(t) + '" aria-label="Remove tag ' + esc(t) + '">' + IC.x + '</button></span>';
    }).join('') + '<input class="input cx-tag-in" data-id="' + esc(id) + '" data-fk="tag-in-' + esc(id) + '" placeholder="Add a tag, press Enter" aria-label="Add a tag"></div>';
  }


  /* ---------- properties per type (every field editable) ---------- */
  function propsFor(id) {
    var o = K.get(id), t = K.type(id), P = [];
    function p(l, h) { P.push('<div class="cx-prop"><span class="cx-prop-l">' + esc(l) + '</span><span class="cx-prop-v">' + h + '</span></div>'); }
    var chOpts = [['', 'No chapter']].concat(K.chapters().map(function (c) { return [c.id, chapFull(c.id)]; }));
    switch (t) {
      case 'puzzle':
        p('Event', '<select class="cx-psel cx-evsel" data-set="event" data-null="1" data-id="' + esc(id) + '" data-fk="set-' + esc(id) + '-event" aria-label="Event">' + eventOptions(o.event || '', 'No event yet') + '</select>' +
          (o.event ? '' : '<span class="cx-mk warn">place it</span>'));
        p('Chapter', '<span class="cx-ro">' + esc(o.chapter ? chapFull(o.chapter) : 'Follows the event') + '</span>' + (o.chapter ? '<span class="faint cx-ro-note">follows the event</span>' : ''));
        p('Status', K.pips(o.status) + psel(id, 'status', D.statuses.map(function (s) { return [s.id, s.label]; }), o.status, { label: 'Status' }));
        p('Kind', psel(id, 'kind', D.puzzleKinds.map(function (x) { return [x.id, x.label]; }), o.kind, { label: 'Kind' }));
        p('Difficulty', diffEdit(o));
        p('Est. time', ed(id, 'estMin', o.estMin, 'Minutes', 'num') + '<span class="faint">min</span>');
        p('Finale', sw(id, 'final', o.final, 'The finale', 'No'));
        p('Unlocks', Rs(K.unlocks(id), { idOnly: true }));
        p('Trail', '<button type="button" class="btn ghost sm" data-act="go" data-to="trail.' + esc(id) + '">' + IC.trail + 'Show on the trail</button>');
        break;
      case 'clue':
        p('Kind', psel(id, 'kind', enumOpts('clue', 'kind'), o.kind));
        p('Planted in', psel(id, 'plantedIn', [['', 'Not planted']].concat(refOpts(['asset'])).concat(refOpts(['puzzle']).map(function (x) { return [x[0], 'Solution of ' + x[1]]; })), o.plantedIn || '', { nul: 1, label: 'Planted in' }) +
          (o.plantedIn ? '' : '<span class="cx-mk bad">' + IC.warn + 'gap</span>'));
        p('Used by', (o.usedBy || []).length ? Rs(o.usedBy, { idOnly: true }) : '<span class="cx-mk warn">Orphan</span>');
        break;
      case 'event':
        p('Chapter', psel(id, 'chapter', chOpts.map(function (x) { return x[0] ? x : ['', 'Not placed yet']; }), o.chapter || '', { nul: 1, label: 'Chapter' }));
        p('Order', o.chapter ? ed(id, 'order', o.order, '1', 'num') + '<span class="cx-ord-tools">' +
          '<button type="button" class="cx-tool" data-act="ev-move" data-d="-1" data-id="' + esc(id) + '" aria-label="Move earlier in the chapter"' + (evIndex(o) <= 0 ? ' disabled' : '') + '>' + IC.up + '</button>' +
          '<button type="button" class="cx-tool" data-act="ev-move" data-d="1" data-id="' + esc(id) + '" aria-label="Move later in the chapter"' + (evIndex(o) >= K.eventsIn(o.chapter).length - 1 ? ' disabled' : '') + '>' + IC.down + '</button></span>' +
          '<span class="faint">of ' + K.eventsIn(o.chapter).length + '</span>' : '<span class="faint">Give it a chapter first</span>');
        p('Layer', psel(id, 'layer', D.layers.map(function (l) { return [l.id, l.label]; }), o.layer, { label: 'Layer' }));
        p('When', ed(id, 'when', o.when, 'YYYY or YYYY-MM-DD', 'text') + (o.when ? '<span class="faint">' + esc(K.fmtDate(o.when)) + '</span>' : ''));
        p('Place', psel(id, 'place', refOpts(['place'], 'No place'), o.place || '', { nul: 1, label: 'Place' }));
        p('Research', o.layer === 'fiction' && !directSrc(id).length ? '<span class="faint">invented, none needed</span>' : researchSummary(directSrc(id)));
        break;
      case 'character':
        p('Kind', psel(id, 'kind', enumOpts('character', 'kind'), o.kind));
        p('Status', psel(id, 'status', enumOpts('character', 'status'), o.status));
        p('Life', ed(id, 'life', o.life, 'Dates', 'text'));
        break;
      case 'place':
        p('Latitude', ed(id, 'lat', o.lat, '0', 'num'));
        p('Longitude', ed(id, 'lng', o.lng, '0', 'num'));
        break;
      case 'entry':
        p('Date', ed(id, 'date', o.date, 'YYYY-MM-DD', 'text') + (o.date ? '<span class="faint">' + esc(K.fmtDate(o.date)) + '</span>' : ''));
        p('Revealed by', psel(id, 'revealedBy', refOpts(['puzzle'], 'Not revealed by a puzzle'), o.revealedBy || '', { nul: 1, label: 'Revealed by' }));
        break;
      case 'asset':
        p('Status', psel(id, 'status', enumOpts('asset', 'status'), o.status));
        p('Kind', psel(id, 'kind', enumOpts('asset', 'kind'), o.kind));
        p('Chapter', psel(id, 'chapter', chOpts, o.chapter || '', { nul: 1, label: 'Chapter' }));
        p('Persona', psel(id, 'persona', refOpts(['character'], 'Nobody'), o.persona || '', { nul: 1, label: 'Persona' }));
        p('Renews', ed(id, 'renews', o.renews, 'YYYY-MM-DD', 'text') + (o.renews ? '<span class="rel ' + urg(K.daysUntil(o.renews)) + '">' + relShort(o.renews) + '</span>' : ''));
        p('Cost', ed(id, 'cost', o.cost, 'e.g. $12/yr', 'text'));
        break;
      case 'chapter':
        p('Number', ed(id, 'n', o.n, '1', 'num'));
        p('Contents', '<span class="t-mono">' + K.eventsIn(id).length + ' events · ' + K.puzzlesIn(id).length + ' puzzles</span>');
        break;
      case 'question':
        p('Severity', '<span class="sev sev-' + o.severity + '"></span>' + psel(id, 'severity', [['high', 'High'], ['med', 'Med'], ['low', 'Low']], o.severity));
        p('Status', psel(id, 'status', enumOpts('question', 'status'), o.status));
        p('Kind', psel(id, 'kind', enumOpts('question', 'kind'), o.kind));
        p('Raised', ed(id, 'created', o.created, 'YYYY-MM-DD', 'text'));
        break;
      case 'task':
        p('Status', psel(id, 'status', enumOpts('task', 'status'), o.status));
        break;
      case 'note':
        p('Updated', '<span class="t-mono">' + esc(K.fmtDate(o.updated)) + '</span>');
        p('Mentions', Rs(K.textRefs(o.body), { idOnly: true }));
        break;
      case 'research':
        p('Status', psel(id, 'status', enumOpts('research', 'status'), o.status) + (o.status === 'verified' ? '<span class="ok t-mono">✓</span>' : ''));
        p('Reliability', psel(id, 'reliability', enumOpts('research', 'reliability'), o.reliability));
        p('Kind', psel(id, 'kind', enumOpts('research', 'kind'), o.kind));
        p('Author', ed(id, 'author', o.author, 'Author or site', 'text'));
        p('Year', ed(id, 'year', o.year, 'Year', 'num'));
        p('Link', urlProp(id, o.url));
        break;
      case 'idea':
        p('Status', psel(id, 'status', enumOpts('idea', 'status'), o.status));
        p('Captured', ed(id, 'created', o.created, 'YYYY-MM-DD', 'text'));
        p('Link', urlProp(id, o.url));
        break;
    }
    return P.length ? '<section class="cx-props" aria-label="Properties">' + P.join('') + '</section>' : '';
  }
  function urlProp(id, url) {
    return (url ? '<a class="cx-ext" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + IC.ext + esc(K.domain(url) || url) + '</a>' : '') +
      ed(id, 'url', url, 'Paste a link', 'text', url ? 'cx-url-ed' : '');
  }

  /* ---------- bodies per type ---------- */
  function bodyPuzzle(p) {
    var id = p.id;
    var h = sec('Premise', ed(id, 'premise', p.premise, 'What does the player see?'));
    h += sec('Mechanic', ed(id, 'mechanic', p.mechanic, 'How does it work?'));
    h += sec('Solution', '<div class="cx-sol" data-id="' + id + '" data-path="solution" data-kind="long" data-fk="ed-' + id + '-solution"><span class="spoiler" title="Click to reveal">' + esc(p.solution || 'TBD.') + '</span></div>',
      '<span class="note">spoiler · click to reveal</span><button type="button" class="btn ghost sm" data-act="edit-target" data-target=".cx-sol">' + IC.edit + 'Edit</button>');
    h += sec('Solve path', listEditor(id, 'solvePath', { ph: 'What does the player do next?', addLabel: 'New step', empty: 'No steps yet. Write what a player actually does, in order.' }),
      '<button type="button" class="btn sm" data-act="list-add" data-id="' + id + '" data-f="solvePath" data-fk="add-step">' + IC.plus + 'Add step</button>', (p.solvePath || []).length);
    h += sec('Aha', ed(id, 'aha', p.aha, 'The key insight, in one line.', 'long', 'cx-aha'));
    var checks = p.checks || [];
    h += sec('Design checks', '<div class="cx-checklist">' + D.designChecks.map(function (dc) {
      return '<label class="check-row"><input type="checkbox" data-check="' + dc.id + '" data-id="' + id + '" data-fk="chk-' + dc.id + '"' + (checks.indexOf(dc.id) >= 0 ? ' checked' : '') + '>' + esc(dc.label) + '</label>';
    }).join('') + '</div>', '<span class="cx-fs ' + (checks.length === D.designChecks.length ? 'ok' : 'mute') + '">' + checks.length + ' of ' + D.designChecks.length + ' passed</span>');
    h += recipeSec(p);
    var nh = (p.hints || []).length;
    h += sec('Hints', (nh || V.adding === id + ':hints' ? listEditor(id, 'hints', { ph: 'A gentle nudge', addLabel: 'New hint', empty: '' }) : '<p class="cx-empty-note">No hints. That is normal: hints are rare in this game.</p>'),
      '<span class="note">optional · rare</span><button type="button" class="btn ghost sm" data-act="list-add" data-id="' + id + '" data-f="hints" data-fk="add-hint">' + IC.plus + 'Add hint</button>', nh || null);
    var unpl = (p.inputs || []).filter(function (c) { var x = K.get(c); return x && !x.plantedIn; }).length;
    var ins = (p.inputs || []).filter(function (c) { return K.get(c); }).map(function (cid) {
      var c = K.get(cid);
      return '<div class="cx-in-row' + (shown(cid) ? '' : ' is-dim') + '"><div class="cx-in-main">' + R(cid, { idOnly: true, cls: c.plantedIn ? '' : 'unplanted' }) + '<span class="doc cx-in-text">' + esc(c.text) + '</span></div>' +
        '<div class="cx-in-where">' + (c.plantedIn ? '<span class="faint">in</span>' + R(c.plantedIn, { max: 22 }) : '<span class="cx-mk bad">' + IC.warn + 'Not planted</span>') + unlinkBtn(id, 'inputs', cid) + '</div></div>';
    }).join('');
    h += sec('Inputs', ins || '<p class="cx-empty-note">No clues feed this puzzle yet.</p>',
      (unpl ? '<span class="cx-mk bad">' + unpl + ' unplanted</span>' : '') + attachBtn(id, 'inputs', 'Attach clue'), (p.inputs || []).length);
    function conn(label, field, add) {
      return '<span class="cx-prop-l">' + esc(label) + '</span><span class="refs">' + (p[field] || []).filter(function (x) { return K.get(x); }).map(function (x) {
        return '<span class="cx-chipref' + (shown(x) ? '' : ' is-dim') + '">' + R(x, { idOnly: true, max: 30 }) + unlinkBtn(id, field, x) + '</span>';
      }).join('') + attachBtn(id, field, add) + '</span>';
    }
    h += sec('Connections', '<div class="cx-conn">' +
      conn('Requires', 'requires', 'Require') + conn('Reveals', 'reveals', 'Reveal') + conn('Assets', 'assets', 'Asset') + '</div>');
    h += sec('Notes', ed(id, 'notes', p.notes, 'Design notes, test results, decisions.'));
    return h;
  }
  function recipeSec(p) {
    var r = p.recipe, has = r && r.steps && r.steps.length;
    var btn = '<button type="button" class="btn sm" data-act="go" data-to="crafter.' + esc(p.id) + '" data-fk="crafter">' + IC.craft + 'Open in Crafter</button>';
    if (!has) return sec('Recipe', '<p class="cx-empty-note">No recipe. If this puzzle hides text with a cipher, build it in the Crafter and it is checked here.</p>', btn);
    var rc = K.checkRecipe(r);
    var steps = r.steps.map(function (s) {
      var op = K.ops[s.op], params = Object.keys(s).filter(function (k) { return k !== 'op'; }).map(function (k) { return k + ' ' + s[k]; });
      return '<span class="cx-rc-step">' + esc(op ? op.label : s.op) + (params.length ? ' <span class="t-mono">' + esc(params.join(', ')) + '</span>' : '') + '</span>';
    }).join('<span class="cx-rc-arr">→</span>');
    return sec('Recipe', '<div class="cx-recipe"><div class="cx-rc-row"><span class="cx-prop-l">Plaintext</span><code class="cx-rc-code">' + esc(r.plaintext) + '</code></div>' +
      '<div class="cx-rc-row"><span class="cx-prop-l">Steps</span><span class="cx-rc-steps">' + steps + '</span></div>' +
      '<div class="cx-rc-row"><span class="cx-prop-l">Output</span><code class="cx-rc-code">' + esc(r.output || rc.built || '') + '</code></div>' +
      '<div class="cx-rc-st">' + (rc.ok ? '<span class="cx-fs ok">✓ Checks out</span><span class="faint">The steps produce the output and decode back to the plaintext.</span>' : '<span class="cx-fs bad">✗ Broken</span><span class="bad">' + esc(rc.problems.join(' ')) + '</span>') + '</div></div>', btn);
  }
  function entriesFor(id) { return D.timeline.filter(function (e) { return (e.links || []).indexOf(id) >= 0; }).sort(function (a, b) { return (K.parseDate(a.date) || 0) - (K.parseDate(b.date) || 0); }).map(function (e) { return e.id; }); }
  function evIndex(e) { return K.eventsIn(e.chapter || null).findIndex(function (x) { return x.id === e.id; }); }
  function bodyEvent(e) {
    var fic = e.layer === 'fiction';
    var recordPanel = fic && !e.record
      ? '<div class="cx-rt-p cx-rt-inv layer-fiction"><div class="cx-rt-h"><span class="eyebrow">On the record</span>' + K.layerBadge('fiction') + '</div><p class="cx-rt-note">Invented for the game. There is nothing on the record to check; the twist is the whole story.</p>' +
        '<button type="button" class="linkish" data-act="edit-target" data-target="#cx-rec-' + esc(e.id) + '">Add a real anchor anyway</button><div id="cx-rec-' + esc(e.id) + '" class="cx-ed cx-ed-long cx-hidden-ed" data-id="' + esc(e.id) + '" data-path="record" data-kind="long" data-fk="ed-' + esc(e.id) + '-record"></div></div>'
      : '<div class="cx-rt-p layer-' + esc(e.layer) + '"><div class="cx-rt-h"><span class="eyebrow">On the record</span>' + K.layerBadge(e.layer) + '</div>' + ed(e.id, 'record', e.record, 'What is documented and checkable? Players will look it up.') + '</div>';
    var h = '<section class="cx-sec"><div class="cx-rt">' + recordPanel +
      '<div class="cx-rt-p layer-fiction"><div class="cx-rt-h"><span class="eyebrow">' + (fic ? 'Our story' : 'Our twist') + '</span>' + K.layerBadge('fiction') + '</div>' + ed(e.id, 'twist', e.twist, fic ? 'What happens in this invented event?' : 'What does the game add on top?') + '</div>' +
      '</div></section>';
    var ps = K.puzzlesInEvent(e.id);
    h += sec('Puzzles in this event', ps.length ? '<div class="cx-list">' + ps.map(function (p) {
      return '<div class="cx-lr"><div class="cx-lr-main">' + R(p.id, { idOnly: true }) + '<span class="cx-lr-ctx"><b class="cx-lr-t">' + esc(p.title || 'Untitled') + '</b> · ' + esc(pkind(p.kind)) + '</span></div><div class="cx-lr-side">' + K.pips(p.status, { label: true }) +
        '<select class="input cx-move" data-move-puzzle="' + esc(p.id) + '" data-fk="move-' + esc(p.id) + '" aria-label="Move ' + esc(p.id) + ' to another event"><option value="' + esc(e.id) + '" selected>Move to…</option>' + eventOptions('\u0000', 'Out of any event').replace('<option value="' + esc(e.id) + '">', '<option value="' + esc(e.id) + '" disabled>') + '</select></div></div>';
    }).join('') + '</div>' : '<div class="cx-empty cx-empty-inline">No puzzles in this event yet. A puzzle here is something players solve with what this event gives them.</div>',
      '<span class="note">in trail order</span><button type="button" class="btn sm' + (ps.length ? '' : ' primary') + '" data-act="new-puzzle-in" data-id="' + esc(e.id) + '" data-fk="new-puzzle-in">' + IC.plus + 'Add puzzle here</button>', ps.length || null);
    h += refsSec(e.id, 'research', 'Research', { add: 'Attach research', empty: fic ? 'Invented events need no research.' : 'No research yet. Players will check this one.', side: function (x) { var o = K.get(x); return stChip('rel', o.reliability) + stChip('rstatus', o.status); } });
    var tl = entriesFor(e.id);
    if (tl.length) h += sec('On the timeline', lrows(tl, layerSide));
    h += sec('Notes', ed(e.id, 'notes', e.notes, 'Design notes for this event.'));
    return h;
  }
  function bodyCharacter(c) {
    var h = sec('Role', ed(c.id, 'role', c.role, 'Who are they in the story?'));
    h += sec('Voice', ed(c.id, 'voice', c.voice, 'How do they write and speak?'));
    h += sec('Secret', '<div class="cx-sol" data-id="' + c.id + '" data-path="secret" data-kind="long" data-fk="ed-' + c.id + '-secret">' + (c.secret && c.secret !== '—' ? '<span class="spoiler" title="Click to reveal">' + esc(c.secret) + '</span>' : '<span class="ph">None.</span>') + '</div>',
      '<span class="note">spoiler</span><button type="button" class="btn ghost sm" data-act="edit-target" data-target=".cx-sol">' + IC.edit + 'Edit</button>');
    h += refsSec(c.id, 'appears', 'Appears in', { add: 'Add appearance', empty: 'Not placed anywhere yet.' });
    var ev = entriesFor(c.id);
    if (ev.length) h += sec('Timeline', lrows(ev, layerSide));
    return h;
  }
  function bodyClue(c) {
    var a = c.plantedIn && K.get(c.plantedIn), h;
    if (!c.plantedIn) {
      var soon = (c.usedBy || []).map(function (pid) { var p = K.get(pid); return p && chapter(p.chapter); }).filter(Boolean).sort(function (x, y) { return x.n - y.n; })[0];
      h = '<p class="cx-prose"><span class="cx-mk bad">' + IC.warn + 'Not planted</span> Nothing carries this clue yet.' + (soon ? ' It is needed in chapter ' + soon.n + '.' : '') + ' Pick an asset under <b>Planted in</b> above.</p>';
    } else if (K.type(c.plantedIn) === 'puzzle') h = '<p class="cx-prose">Derived: solving ' + R(c.plantedIn) + ' produces it.</p>';
    else h = lrows([c.plantedIn], function () { return stChip('asset', a.status) + '<span class="t-mono">' + esc(chapShort(a.chapter)) + '</span>'; });
    return sec('Planted in', h) + refsSec(c.id, 'usedBy', 'Used by', { add: 'Attach to puzzle', empty: 'Orphan: no puzzle uses this clue. Attach it to one or cut it.' });
  }
  function mapSvg(pl) {
    var g = '';
    for (var x = -150; x <= 150; x += 30) g += '<line class="gr" x1="' + (x + 180) + '" y1="0" x2="' + (x + 180) + '" y2="180"/>';
    for (var y = -60; y <= 60; y += 30) g += '<line class="gr' + (y === 0 ? ' eq' : '') + '" x1="0" y1="' + (90 - y) + '" x2="360" y2="' + (90 - y) + '"/>';
    D.places.forEach(function (p) { if (p !== pl) g += '<circle class="pt" cx="' + (+p.lng + 180) + '" cy="' + (90 - p.lat) + '" r="2"><title>' + esc(p.name) + '</title></circle>'; });
    g += '<circle class="pt-ring" cx="' + (+pl.lng + 180) + '" cy="' + (90 - pl.lat) + '" r="7"/><circle class="pt-cur" cx="' + (+pl.lng + 180) + '" cy="' + (90 - pl.lat) + '" r="3"/>';
    return '<svg class="cx-map" viewBox="0 0 360 180" role="img" aria-label="' + esc(pl.name + ' on a world grid') + '">' + g + '</svg>';
  }
  function bodyPlace(pl) {
    return sec('Where', mapSvg(pl), '<span class="note">every place, on a latitude / longitude grid</span>') +
      sec('Linked here', lrows(K.backlinks(pl.id), layerSide, 'Nothing links here.'), '', K.backlinks(pl.id).length);
  }
  function bodyEntry(e) {
    var all = D.timeline.slice().sort(function (a, b) { return (K.parseDate(a.date) || 0) - (K.parseDate(b.date) || 0); });
    var i = all.indexOf(e), near = all.slice(Math.max(0, i - 2), i + 3);
    var tl = '<div class="cx-list">' + near.map(function (x) {
      return '<div class="cx-lr' + (x === e ? ' cur' : '') + '"><div class="cx-lr-main"><span class="t-mono cx-tl-date">' + esc(K.fmtDate(x.date)) + '</span>' + (x === e ? '<span class="t-strong">' + esc(x.title) + '</span>' : R(x.id, { max: 50 })) + '</div><div class="cx-lr-side">' + K.layerBadge(x.layer, { short: true }) + '</div></div>';
    }).join('') + '</div>';
    return sec('On the timeline', tl, '<a href="#timeline" class="btn ghost sm">Full timeline</a>') + refsSec(e.id, 'links', 'Links', { add: 'Link' });
  }
  function bodyAsset(a) {
    var h = '';
    if (a.renews) {
      var n = K.daysUntil(a.renews);
      h += '<section class="cx-sec"><div class="cx-renew ' + urg(n) + '"><span class="big">' + n + '</span><span class="rn-t">days until renewal<br><span class="t-mono">' + esc(K.fmtDate(a.renews)) + (a.cost ? ' · ' + esc(a.cost) : '') + '</span><br>It has to stay alive for as long as the game is out.</span><button type="button" class="btn sm" data-act="renew" data-id="' + a.id + '">Mark renewed</button></div></section>';
    }
    h += sec('Where it lives', ed(a.id, 'where', a.where, 'Where does it live in the wild?'));
    h += refsSec(a.id, 'carries', 'Carries', { add: 'Attach clue', empty: 'Carries no clues.', side: function (x) { var c = K.get(x); return (c.usedBy || []).length ? Rs(c.usedBy, { idOnly: true }) : '<span class="cx-mk warn">Orphan</span>'; } });
    h += sec('Used by puzzles', lrows(K.backlinks(a.id).filter(function (x) { return K.type(x) === 'puzzle'; }), pipSide, 'No puzzle uses it.'));
    h += sec('Notes', ed(a.id, 'notes', a.notes, 'Logins, costs, how to keep it alive.'));
    return h;
  }
  function outlineEvent(e, i, n, chId) {
    var ps = K.puzzlesInEvent(e.id);
    return '<li class="cx-ol-ev"' + (e.layer ? ' data-layer="' + esc(e.layer) + '"' : '') + '>' +
      '<div class="cx-ol-head"><span class="cx-ol-ord t-mono">' + esc(e.order || i + 1) + '</span>' + R(e.id, { idOnly: true }) + ed(e.id, '__title', e.title, 'Name this event', 'text', 'cx-ol-title') +
        (e.when ? '<span class="t-mono cx-ol-when">' + esc(K.fmtDate(e.when)) + '</span>' : '') + K.layerBadge(e.layer, { short: true }) +
        '<span class="cx-ol-tools">' +
        '<button type="button" class="cx-tool" data-act="ev-move" data-d="-1" data-id="' + esc(e.id) + '" aria-label="Move ' + esc(e.id) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>' + IC.up + '</button>' +
        '<button type="button" class="cx-tool" data-act="ev-move" data-d="1" data-id="' + esc(e.id) + '" aria-label="Move ' + esc(e.id) + ' later"' + (i === n - 1 ? ' disabled' : '') + '>' + IC.down + '</button>' +
        '<select class="input cx-move" data-move-event="' + esc(e.id) + '" data-fk="mvch-' + esc(e.id) + '" aria-label="Move ' + esc(e.id) + ' to another chapter"><option value="' + esc(chId) + '" selected>Move to…</option>' +
          K.chapters().filter(function (c) { return c.id !== chId; }).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(chapTitle(c)) + '</option>'; }).join('') + '<option value="">Not placed yet</option></select>' +
        '</span></div>' +
      '<div class="cx-ol-pzs">' + ps.map(function (p) { return '<span class="cx-toc-pz">' + R(p.id, { max: 28 }) + K.pips(p.status) + '</span>'; }).join('') +
        '<button type="button" class="btn ghost sm cx-attach" data-act="new-puzzle-in" data-id="' + esc(e.id) + '">' + IC.plus + (ps.length ? 'Puzzle' : 'Add the first puzzle') + '</button></div></li>';
  }
  function bodyChapter(c) {
    var evs = K.eventsIn(c.id), unplaced = K.eventsIn(null);
    var outline = evs.length
      ? '<ol class="cx-outline">' + evs.map(function (e, i) { return outlineEvent(e, i, evs.length, c.id); }).join('') + '</ol>'
      : '<div class="cx-empty cx-empty-first"><span class="cx-empty-ic">EV</span><p>This chapter is empty. Add the events it is built from: a real mystery, a contested story, or something you invent. Puzzles go inside events.</p><div class="cx-row-btns">' + addEventBtn(c, 'Add an event to ' + chapTitle(c), true) + '</div></div>';
    return sec('Summary', ed(c.id, 'summary', c.summary, 'What happens in this chapter? One or two lines.')) +
      sec('Outline', outline + (evs.length ? '<div class="cx-ol-foot">' + addEventBtn(c, 'Add an event', false) + '</div>' : ''),
        '<span class="note">events in order, puzzles inside them</span><button type="button" class="btn sm" data-act="export-chapter" data-id="' + c.id + '">' + IC.exp + 'Export chapter</button>', evs.length) +
      (unplaced.length ? sec('Not placed yet', lrows(unplaced.map(function (e) { return e.id; }), function (x) { return '<button type="button" class="btn ghost sm" data-act="place-event" data-id="' + esc(x) + '" data-ch="' + esc(c.id) + '">' + IC.plus + 'Add to this chapter</button>'; }), '<span class="note">the parking lot</span>', unplaced.length) : '') +
      sec('Assets first needed here', lrows(D.assets.filter(function (a) { return a.chapter === c.id; }).map(function (a) { return a.id; }), function (x) { return stChip('asset', K.get(x).status); }, 'No assets are first needed in this chapter.'));
  }
  function bodyQuestion(q) {
    var h = refsSec(q.id, 'links', 'Affects', { add: 'Link', side: layerSide });
    if (q.status === 'open') {
      h += sec('Resolution', '<div class="cx-res"><textarea class="input cx-draft" id="cx-res-' + q.id + '" data-fk="res-' + q.id + '" rows="3" placeholder="What did we decide, and why?">' + esc(q.resolution || '') + '</textarea>' +
        '<div class="cx-row-btns"><button type="button" class="btn primary sm" data-act="resolve" data-id="' + q.id + '">Mark resolved</button></div></div>');
    } else {
      h += sec('Resolution', ed(q.id, 'resolution', q.resolution, 'No resolution written.'), '<button type="button" class="btn sm" data-act="reopen" data-id="' + q.id + '">Reopen</button>');
    }
    return h;
  }
  function bodyTask(t) {
    return refsSec(t.id, 'links', 'Links', { add: 'Link', side: layerSide }) +
      '<section class="cx-sec"><button type="button" class="btn ' + (t.status === 'done' ? '' : 'primary') + ' sm" data-act="task-done" data-id="' + t.id + '">' + (t.status === 'done' ? 'Reopen task' : 'Mark done') + '</button></section>';
  }
  function bodyResearch(r) {
    return sec('Excerpt', ed(r.id, 'excerpt', r.excerpt, 'Paste the key quote.', 'long', 'doc cx-excerpt')) +
      sec('Notes', ed(r.id, 'notes', r.notes, 'What it is good for, what to check next.')) +
      sec('Tags', tagsEditor(r.id)) +
      refsSec(r.id, 'supports', 'Supports', { add: 'Link to…', side: layerSide, empty: 'Supports nothing yet.' });
  }
  var PROMOTE = [['puzzle', 'Puzzle'], ['event', 'Event'], ['character', 'Character'], ['question', 'Question'], ['research', 'Research'], ['note', 'Note']];
  function bodyIdea(i) {
    return sec('Tags', tagsEditor(i.id)) +
      refsSec(i.id, 'links', 'Links', { add: 'Link', side: layerSide, empty: 'Not linked to anything yet.' }) +
      sec('Promote to…', '<p class="cx-empty-note">Make a real page from this idea. The new page is prefilled, linked back, and the idea is marked used.</p><div class="cx-promote">' +
        PROMOTE.map(function (x) { return '<button type="button" class="btn sm" data-act="promote" data-as="' + x[0] + '" data-id="' + i.id + '" data-fk="promote-' + x[0] + '">' + IC.plus + esc(x[1]) + '</button>'; }).join('') + '</div>');
  }
  /* note bodies: #ID, @Name and [[Name]] become refs */
  function noteHtml(body) {
    var parts = String(body || '').split(/\n{2,}/);
    return parts.map(function (para) {
      var h = esc(para);
      h = h.replace(/\[\[([^\]]+)\]\]/g, function (m, n) { var id = K.resolveName(n); return id ? R(id) : '<span class="cx-wl" title="No page called this yet">' + n + '</span>'; });
      h = h.replace(/#([A-Za-z]{1,2}\d+|(?:m|c|pl|ev)-[a-z0-9-]+)/g, function (m, id) { return K.has(id) ? R(id, { idOnly: IDPAT.test(id) }) : m; });
      h = h.replace(/@([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3})/g, function (m, n) {
        var words = n.split(/\s+/);
        for (var k = words.length; k > 0; k--) {
          var id = K.resolveName(words.slice(0, k).join(' '), ['character']);
          if (id) return R(id) + (k < words.length ? ' ' + words.slice(k).join(' ') : '');
        }
        return m;
      });
      return '<p>' + h.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function bodyNote(n) {
    var mode = (V.noteMode[n.id]) || (n.body ? 'preview' : 'edit');
    var seg = '<div class="seg" role="group" aria-label="Note mode"><button type="button" data-act="note-mode" data-mode="edit" data-id="' + n.id + '" data-fk="note-edit" aria-pressed="' + (mode === 'edit') + '">Edit</button><button type="button" data-act="note-mode" data-mode="preview" data-id="' + n.id + '" data-fk="note-preview" aria-pressed="' + (mode === 'preview') + '">Preview</button></div>';
    var inner = mode === 'edit'
      ? '<textarea class="input cx-note-ta cx-draft" data-id="' + n.id + '" data-fk="note-ta-' + n.id + '" spellcheck="true" placeholder="Write freely. #P04, @Ida Vance and [[Phaistos Disc]] become links.">' + esc(n.body || '') + '</textarea><div class="cx-note-hint">Saves as you type. <span class="t-mono">#ID</span> · <span class="t-mono">@Name</span> · <span class="t-mono">[[Name]]</span> link to pages.</div>'
      : (n.body ? '<div class="cx-note-body">' + noteHtml(n.body) + '</div>' : '<p class="cx-empty-note">Empty note. Switch to Edit to write.</p>');
    return sec('Body', inner, seg);
  }
  var BODY = { puzzle: bodyPuzzle, event: bodyEvent, entry: bodyEntry, character: bodyCharacter, clue: bodyClue, place: bodyPlace, asset: bodyAsset, chapter: bodyChapter, question: bodyQuestion, task: bodyTask, research: bodyResearch, idea: bodyIdea, note: bodyNote };

  /* ---------- the entity page ---------- */
  function eyebrow(o, t) {
    var bits = [K.TYPES[t].label];
    if (t === 'puzzle') { bits.push(o.chapter ? chapShort(o.chapter) : 'no chapter yet'); bits.push(pkind(o.kind)); }
    if (t === 'clue' || t === 'character' || t === 'question' || t === 'asset' || t === 'research') bits.push(o.kind);
    if (t === 'entry') bits.push(K.fmtDate(o.date));
    if (t === 'event') { bits.push(o.chapter ? chapFull(o.chapter) + (o.order ? ' · #' + o.order : '') : 'not placed yet'); if (o.when) bits.push(K.fmtDate(o.when)); }
    if (t === 'idea' && (o.tags || []).length) bits.push('#' + o.tags.join(' #'));
    return bits.filter(Boolean).join(' · ');
  }
  function renderEntity(id) {
    var o = K.get(id), t = K.type(id), ct = collToken(t), lay = K.layerOf(id);
    var collLabel = t === 'research' ? 'Research' : t === 'idea' ? 'Ideas' : COLL[TYPE_COLL[t]].label;
    var list = (t === 'event' ? eventsSorted() : K.list(t)).filter(function (x) { return shown(x.id) || x.id === id; });
    var ix = list.findIndex(function (x) { return x.id === id; }), prev = list[ix - 1], next = list[ix + 1];
    var label = K.label(id), longT = label.length > 60 || t === 'idea' || t === 'question';
    var titleCls = 'cx-title cx-ed' + (t === 'clue' ? ' doc' : '') + (longT ? ' long' : '');
    var lm = '';
    if (V.lmenu && lay) {
      lm = '<div class="cx-lmenu" role="menu" aria-label="Change layer"><div class="cx-lmenu-h eyebrow">Reality layer</div>' + D.layers.filter(function (l) { return vals(t, 'layer').indexOf(l.id) >= 0; }).map(function (l) {
        return '<button type="button" role="menuitemradio" aria-checked="' + (l.id === lay) + '" data-act="set-layer" data-id="' + esc(id) + '" data-layer="' + l.id + '" data-fk="lm-' + l.id + '">' + K.layerBadge(l.id) + '<span class="d">' + esc(l.desc) + '</span></button>';
      }).join('') + '</div>';
    }
    var nLinks = K.backlinks(id).length;
    var actions = V.confirmDel === id
      ? '<div class="cx-del-confirm" role="alert"><span>Delete ' + esc(id) + (nLinks ? ' and remove ' + nLinks + ' link' + (nLinks === 1 ? '' : 's') + ' to it' : '') + '?</span><button type="button" class="btn sm cx-danger" data-act="delete-yes" data-id="' + esc(id) + '" data-fk="del-yes">Delete</button><button type="button" class="btn ghost sm" data-act="delete-no" data-fk="del-no">Cancel</button></div>'
      : '<div class="cx-head-acts"><button type="button" class="btn ghost sm" data-act="copy-json" data-id="' + esc(id) + '" data-fk="copy-json" title="Copy this page as JSON for an LLM">' + IC.copy + '<span>Copy as JSON</span></button>' +
        '<button type="button" class="btn ghost sm" data-act="export" data-fk="export" title="Export this page, or more, for an LLM">' + IC.exp + '<span>Export…</span></button>' +
        '<button type="button" class="btn ghost sm" data-act="delete" data-fk="delete" title="Delete this page">' + IC.trash + '<span>Delete</span></button></div>';
    V.main.innerHTML = '<article class="cx-ent" aria-label="' + esc(trunc(label, 80)) + '">' +
      '<nav class="cx-crumbs" aria-label="Breadcrumbs"><button type="button" class="icon-btn" data-act="back" aria-label="Back" title="Back">' + IC.back + '</button>' +
        '<a href="#' + ct + '">' + esc(collLabel) + '</a><span class="sep">/</span><span class="cur">' + esc((IDPAT.test(id) ? id + ' · ' : '') + trunc(label, 70)) + '</span><span class="sp"></span>' +
        (prev ? '<a class="pn" href="#' + esc(prev.id) + '" title="' + esc(K.label(prev.id)) + '">‹ ' + esc(IDPAT.test(prev.id) ? prev.id : trunc(K.label(prev.id), 16)) + '</a>' : '') +
        (next ? '<a class="pn" href="#' + esc(next.id) + '" title="' + esc(K.label(next.id)) + '">' + esc(IDPAT.test(next.id) ? next.id : trunc(K.label(next.id), 16)) + ' ›</a>' : '') + '</nav>' +
      '<div class="cx-ent-grid"><div class="cx-ent-main">' +
        '<header class="cx-ent-head"><div class="cx-head-top"><div class="eyebrow">' + esc(eyebrow(o, t)) + '</div>' + actions + '</div>' +
          '<div class="cx-title-row">' + (IDPAT.test(id) ? '<span class="id big">' + esc(id) + '</span>' : '') +
            '<h1 class="' + titleCls + '" tabindex="0" role="button" data-id="' + esc(id) + '" data-path="__title" data-kind="' + (longT ? 'long' : 'text') + '" data-fk="ed-' + esc(id) + '-__title" title="Click to rename">' + esc(label || 'Untitled') + '</h1>' +
            (lay ? '<button type="button" class="cx-layer-btn" data-act="lmenu" data-fk="lmenu" aria-haspopup="menu" aria-expanded="' + !!V.lmenu + '" title="Change reality layer">' + K.layerBadge(lay) + IC.chev + '</button>' : '') + lm +
          '</div></header>' +
        guardBox(id) + propsFor(id) + attention(id) + (BODY[t] ? BODY[t](o) : '') + factSec(id) +
      '</div><aside class="cx-ent-rail" aria-label="Links and backlinks">' +
        (LAYER_IDS.some(function (l) { return !S.on[l]; }) ? '<p class="cx-rail-note">Faded: pages on hidden layers. <button type="button" class="linkish" data-act="all-layers">Show all</button></p>' : '') +
        railSec('Links', K.refs(id), id, false, 'this page points to') + railSec('Backlinks', K.backlinks(id), id, true, 'points here') +
      '</aside></div></article>';
    decorate(V.main);
  }
  function renderMissing(id) {
    V.main.innerHTML = '<section class="cx-coll"><div class="cx-empty">No page called <span class="id">' + esc(id) + '</span>. It may have been deleted.<div><a class="btn sm" href="#puzzles">Go to Puzzles</a></div></div></section>';
  }


  /* ---------- decorate refs: fade hidden layers, mark real people ---------- */
  function decorate(root) {
    $$('.ref[data-ref]', root).forEach(function (b) {
      var id = b.getAttribute('data-ref'), o = K.get(id);
      if (!shown(id)) b.classList.add('is-dim');
      if (o && o.guard && K.type(id) === 'character' && !b.querySelector('.cx-g-mk')) b.insertAdjacentHTML('beforeend', '<span class="cx-g-mk" aria-label="Real person">' + IC.shield + '</span>');
    });
  }

  /* ---------- render loop ---------- */
  function tokenOf(r) { return r.kind === 'coll' ? r.key : r.kind === 'problems' ? 'problems' : r.id; }
  function renderView() {
    V.issues = K.integrity();
    var r = V.route;
    if (r.kind === 'coll') renderColl(r.key);
    else if (r.kind === 'problems') renderProblems();
    else if (K.get(r.id)) renderEntity(r.id);
    else renderMissing(r.id);
  }
  function status() {
    var r = V.route, loc;
    if (r.kind === 'coll') loc = COLL[r.key].label;
    else if (r.kind === 'problems') loc = 'Problems';
    else if (K.get(r.id)) loc = K.TYPES[K.type(r.id)].plural + ' / ' + (IDPAT.test(r.id) ? r.id + ' · ' : '') + trunc(K.label(r.id), 40);
    else loc = 'Not found';
    var pages = 0; Object.keys(K.TYPES).forEach(function (t) { pages += K.list(t).length; });
    var off = D.layers.filter(function (l) { return !S.on[l.id]; }).map(function (l) { return l.label; });
    V.ctx.setStatus(['Codex', loc, pages + (pages === 1 ? ' page' : ' pages'), off.length ? 'Hiding ' + off.join(', ') : '']);
  }
  function fkSel(k) { return '[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"]'; }
  function renderAll(keepScroll) {
    if (!V) return;
    var st = V.scroll.scrollTop, a = document.activeElement, f = null;
    if (V.refocusKey) f = { k: V.refocusKey };
    else if (a && V.root.contains(a) && a.getAttribute('data-fk')) f = { k: a.getAttribute('data-fk'), s: a.selectionStart, e: a.selectionEnd };
    V.refocusKey = null;
    renderMnav(); renderView(); status();
    if (keepScroll) V.scroll.scrollTop = st;
    if (f) {
      var el = V.root.querySelector(fkSel(f.k));
      if (el) { try { el.focus({ preventScroll: true }); if (f.s != null && el.setSelectionRange && /^(text|search|)$/.test(el.type || '')) el.setSelectionRange(f.s, f.e); } catch (e) { /* not focusable */ } }
    }
    if (V.autoEdit) { var ae = V.root.querySelector(fkSel(V.autoEdit)); V.autoEdit = null; if (ae) startEdit(ae); }
    if (V.focusFilter) { V.focusFilter = false; var fl = $('#cx-flt', V.root); if (fl) fl.focus(); }
  }
  function busy() {
    if (V.editing) return true;
    var a = document.activeElement;
    return !!(a && V.root.contains(a) && a.matches('textarea, input:not([type=checkbox]):not([type=radio])'));
  }
  function flush() {
    if (!V) return;
    if (V.pointerDown || (!V.force && busy())) { V.pending = true; return; }
    V.pending = false; V.force = false;
    renderAll(true);
  }
  function onKitChange() { if (!V) return; clearTimeout(V.t); V.t = setTimeout(flush, 40); }
  function update(id, patch, msg) { V.force = true; K.update(id, patch); if (msg) K.toast(msg); }

  /* ---------- inline editing ---------- */
  function getPath(o, path) {
    if (path === '__title') return K.label(o.id) === o.id && !o[titleField(K.type(o.id))] ? '' : K.label(o.id);
    var p = path.split('.'); return p.length === 2 ? (o[p[0]] || [])[+p[1]] : o[path];
  }
  var PATH_LABEL = { __title: 'title', premise: 'premise', mechanic: 'mechanic', solution: 'solution', aha: 'aha', notes: 'notes', record: 'record', twist: 'twist', role: 'role', voice: 'voice', secret: 'secret', guard: 'guard', where: 'location', resolution: 'resolution', summary: 'summary', excerpt: 'excerpt', estMin: 'estimate', url: 'link' };
  function startEdit(el) {
    if (!el || !V || V.editing || el.classList.contains('editing')) return;
    var id = el.dataset.id, path = el.dataset.path, kind = el.dataset.kind || 'long', o = K.get(id); if (!o) return;
    var cur = getPath(o, path), fk = el.getAttribute('data-fk');
    var input = document.createElement(kind === 'long' ? 'textarea' : 'input');
    input.className = 'input'; input.value = cur == null ? '' : cur;
    if (kind === 'num') { input.setAttribute('inputmode', 'decimal'); }
    if (kind === 'long') input.rows = Math.min(10, Math.max(2, Math.ceil(String(input.value).length / 64) + 1));
    input.setAttribute('aria-label', 'Edit ' + (PATH_LABEL[path] || path.replace(/\.\d+$/, ' step')));
    el.classList.add('editing'); el.innerHTML = ''; el.appendChild(input);
    el.insertAdjacentHTML('beforeend', '<span class="cx-edit-hint"><span class="kbd">↵</span> save' + (kind === 'long' ? ' · <span class="kbd">⇧ ↵</span> new line' : '') + ' · <span class="kbd">esc</span> cancel</span>');
    var done = false;
    V.editing = { el: el };
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* number inputs */ }
    function finish(save, viaKey) {
      if (done) return; done = true;
      if (V) V.editing = null;
      if (!V) return;
      if (viaKey) V.refocusKey = fk;
      var v = String(input.value).trim();
      if (save && v !== String(cur == null ? '' : cur).trim()) commitPath(id, path, kind, v);
      else renderAll(true);
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
    });
    input.addEventListener('blur', function () { finish(true, false); });
  }
  function commitPath(id, path, kind, v) {
    var o = K.get(id), t = K.type(id), patch = {}, msg;
    if (path === '__title') {
      if (!v) { K.toast('A page needs a name.'); renderAll(true); return; }
      patch[titleField(t)] = v; msg = 'Renamed ' + (IDPAT.test(id) ? id : 'page') + ' to “' + trunc(v, 40) + '”';
    } else if (/\.\d+$/.test(path)) {
      var f = path.split('.')[0], i = +path.split('.')[1], arr = (o[f] || []).slice();
      if (v) { arr[i] = v; msg = (f === 'solvePath' ? 'Step ' : 'Hint ') + (i + 1) + ' updated'; } else { arr.splice(i, 1); msg = (f === 'solvePath' ? 'Step ' : 'Hint ') + (i + 1) + ' removed'; }
      patch[f] = arr;
    } else if (t === 'event' && path === 'order') {
      if (v === '' || isNaN(+v)) { K.toast('That needs to be a number.'); renderAll(true); return; }
      V.force = true; reorderEvent(id, Math.round(+v) - 1); return;
    } else if (kind === 'num') {
      if (v !== '' && isNaN(+v)) { K.toast('That needs to be a number.'); renderAll(true); return; }
      patch[path] = v === '' ? null : +v; msg = 'Saved ' + (PATH_LABEL[path] || path) + ' on ' + id;
    } else {
      patch[path] = (path === 'url' || path === 'renews') && !v ? null : v;
      msg = 'Saved ' + (PATH_LABEL[path] || path) + ' on ' + (IDPAT.test(id) ? id : trunc(K.label(id), 30));
    }
    update(id, patch, msg);
  }

  /* ---------- actions ---------- */
  /* ---------- events: order inside a chapter, moving between chapters ---------- */
  function renumber(list) { list.forEach(function (e, i) { if (+e.order !== i + 1) K.update(e.id, { order: i + 1 }); }); }
  function reorderEvent(eid, to) {
    var e = K.get(eid); if (!e || !e.chapter) return;
    var list = K.eventsIn(e.chapter).filter(function (x) { return x.id !== eid; });
    to = Math.max(0, Math.min(list.length, to)); list.splice(to, 0, e);
    K.batch(function () { renumber(list); });
    K.toast(eid + ' is now #' + (to + 1) + ' in ' + chapFull(e.chapter));
  }
  function moveEvent(eid, ch) {
    var e = K.get(eid), old = (e && e.chapter) || null; ch = ch || null;
    if (!e || old === ch) return;
    K.batch(function () {
      K.update(eid, { chapter: ch, order: nextOrder(ch) });
      if (old) renumber(K.eventsIn(old));
    });
    K.toast(ch ? 'Moved ' + eid + ' to ' + chapFull(ch) : eid + ' is back in the parking lot');
  }
  function newEvent(ch, stay) {
    var nid = K.create('event', { title: 'New event', chapter: ch || null, order: nextOrder(ch || null), layer: 'pseudo' });
    if (stay) { V.autoEdit = 'ed-' + nid + '-__title'; V.force = true; }
    else { V.ctx.go(nid); if (V) V.autoEdit = 'ed-' + nid + '-__title'; }
    K.toast('Added ' + nid + (ch ? ' to ' + chapFull(ch) : ' to the parking lot') + '. Name it.');
    return nid;
  }
  var confirmTimer;
  function pickInto(id, field) {
    var o = K.get(id), t = K.type(id), f = (F[t] || {})[field] || {}, cur = o[field] || [];
    var types = f.of || null;
    K.pick({
      title: 'Add to ' + (IDPAT.test(id) ? id : trunc(K.label(id), 24)) + ' · ' + field,
      types: types, exclude: [id].concat(cur), allowCreate: !!(types && types.length === 1),
      onPick: function (x) {
        if (!V) return;
        update(id, (function () { var p = {}; p[field] = cur.concat([x]); return p; })(), 'Linked ' + (IDPAT.test(x) ? x : trunc(K.label(x), 28)) + ' to ' + (IDPAT.test(id) ? id : trunc(K.label(id), 24)) + ' · ' + field);
      },
    });
  }
  function promote(ideaId, type) {
    var i = K.get(ideaId), snap = K.snapshot(), title = shortTitle(i.text), newId;
    var obj = {
      puzzle: { title: title, premise: i.text, notes: 'From idea ' + ideaId + '.' + (i.url ? ' ' + i.url : '') },
      event: { title: title, twist: i.text, layer: 'pseudo', chapter: null, order: nextOrder(null) },
      character: { name: title, role: i.text },
      question: { text: i.text, links: (i.links || []).slice() },
      research: { title: title, url: i.url || null, notes: i.text, tags: (i.tags || []).slice(), kind: i.url ? 'web' : 'other' },
      note: { title: title, body: i.text + (i.url ? '\n\n' + i.url : '') + '\n\nFrom #' + ideaId + '.' },
    }[type];
    K.batch(function () {
      newId = K.create(type, obj);
      K.update(ideaId, { status: 'used', links: uniq((i.links || []).concat([newId])) });
    });
    V.ctx.go(newId);
    K.toast('Promoted ' + ideaId + ' to ' + K.TYPES[type].label.toLowerCase() + ' ' + newId, { label: 'Undo', run: function () { K.restore(snap); Desk.go(ideaId); K.toast('Promotion undone'); } });
  }
  function act(name, el) {
    var id = el.dataset.id, o = id ? K.get(id) : null, key = V.route.key, v, snap;
    switch (name) {
      case 'sort': v = view(key); if (v.sort.k === el.dataset.k) v.sort.dir *= -1; else v.sort = { k: el.dataset.k, dir: 1 }; savePrefs(); renderBody(key); break;
      case 'gtoggle': v = view(key); v.closed[el.dataset.g] = !v.closed[el.dataset.g]; renderBody(key); break;
      case 'mode': v = view(key); v.mode = el.dataset.mode; savePrefs(); renderAll(true); break;
      case 'new': V.newOpen = !V.newOpen; renderAll(true); if (V.newOpen) { var nf = $('#cx-newform input, #cx-newform select', V.root); if (nf) nf.focus(); } break;
      case 'new-cancel': V.newOpen = false; renderAll(true); break;
      case 'clear-q': view(key).q = ''; renderAll(true); break;
      case 'layer': S.on[el.dataset.layer] = !S.on[el.dataset.layer]; savePrefs(); renderAll(true); K.toast(K.layer(el.dataset.layer).label + (S.on[el.dataset.layer] ? ' shown again' : ' hidden from the Codex')); break;
      case 'all-layers': LAYER_IDS.forEach(function (l) { S.on[l] = true; }); savePrefs(); renderAll(true); K.toast('All three layers shown'); break;
      case 'prob-sev': S.probSev = el.dataset.s; renderAll(true); break;
      case 'export': V.ctx.openExport(); break;
      case 'export-chapter': V.ctx.openExport({ kind: 'chapter', id: id }); break;
      case 'go': V.ctx.go(el.dataset.to); break;
      case 'back': V.ctx.back(); break;
      case 'import': V.ctx.openImport(); break;
      case 'new-event': newEvent(el.dataset.ch || null, V.route.kind === 'entity' && K.type(V.route.id) === 'chapter'); break;
      case 'new-puzzle-in':
        var pid = K.create('puzzle', { event: id, title: 'Untitled puzzle' });
        V.ctx.go(pid); if (V) V.autoEdit = 'ed-' + pid + '-__title';
        K.toast('Added ' + pid + ' to ' + trunc(K.label(id), 40) + '. Name it.');
        break;
      case 'ev-move': var ev0 = K.get(id), ix = K.eventsIn(ev0.chapter || null).findIndex(function (x) { return x.id === id; }); reorderEvent(id, ix + (+el.dataset.d)); break;
      case 'place-event': moveEvent(id, el.dataset.ch); break;
      case 'lmenu': V.lmenu = !V.lmenu; renderAll(true); if (V.lmenu) { var lb = $('.cx-lmenu button[aria-checked="true"]', V.root); if (lb) lb.focus(); } break;
      case 'set-layer': V.lmenu = false; if (K.layerOf(id) === el.dataset.layer) { renderAll(true); break; } V.refocusKey = 'lmenu'; update(id, { layer: el.dataset.layer }, (IDPAT.test(id) ? id : K.label(id)) + ' moved to ' + K.layer(el.dataset.layer).label); break;
      case 'diff': update(id, { difficulty: +el.dataset.n }, id + ' difficulty: ' + el.dataset.n + ' of 5'); break;
      case 'toggle': v = {}; v[el.dataset.f] = !o[el.dataset.f]; update(id, v, 'Saved ' + el.dataset.f + ' on ' + (IDPAT.test(id) ? id : trunc(K.label(id), 30))); break;
      case 'edit-target': startEdit($(el.dataset.target, V.main)); break;
      case 'list-add': V.adding = id + ':' + el.dataset.f; V.confirm = null; V.refocusKey = 'add-' + V.adding; renderAll(true); break;
      case 'list-cancel': V.adding = null; renderAll(true); break;
      case 'list-save': saveListItem($('.cx-add-in', V.main)); break;
      case 'list-move':
        var f = el.dataset.f, i = +el.dataset.i, j = i + (+el.dataset.d), arr = (o[f] || []).slice();
        if (j < 0 || j >= arr.length) break;
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; V.confirm = null;
        V.refocusKey = null; update(id, (function () { var p = {}; p[f] = arr; return p; })(), 'Moved ' + (f === 'solvePath' ? 'step ' : 'hint ') + (i + 1) + (j < i ? ' up' : ' down')); break;
      case 'list-del':
        var ck = id + ':' + el.dataset.f + ':' + el.dataset.i;
        if (V.confirm !== ck) { V.confirm = ck; V.refocusKey = 'del-' + ck; renderAll(true); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { if (V && V.confirm === ck) { V.confirm = null; renderAll(true); } }, 3500); break; }
        var la = (o[el.dataset.f] || []).slice(), li = +el.dataset.i; la.splice(li, 1); V.confirm = null;
        update(id, (function () { var p = {}; p[el.dataset.f] = la; return p; })(), 'Removed ' + (el.dataset.f === 'solvePath' ? 'step ' : 'hint ') + (li + 1) + ' from ' + id); break;
      case 'attach': pickInto(id, el.dataset.f); break;
      case 'unlink':
        snap = K.snapshot();
        update(id, (function () { var p = {}; p[el.dataset.f] = (o[el.dataset.f] || []).filter(function (x) { return x !== el.dataset.t; }); return p; })());
        K.toast('Removed ' + el.dataset.t + ' from ' + (IDPAT.test(id) ? id : trunc(K.label(id), 24)) + ' · ' + el.dataset.f, { label: 'Undo', run: function () { K.restore(snap); } });
        break;
      case 'cite':
        var cid = id;
        K.pick({ title: 'Research that supports ' + trunc(K.label(cid), 40), types: ['research'], exclude: directSrc(cid), allowCreate: true,
          onPick: function (rid) { var r = K.get(rid); update(rid, { supports: uniq((r.supports || []).concat([cid])) }, rid + ' now supports ' + (IDPAT.test(cid) ? cid : trunc(K.label(cid), 30)) + (r.status === 'verified' ? '' : ' (not verified yet)')); } });
        break;
      case 'tag-del': update(id, { tags: (o.tags || []).filter(function (x) { return x !== el.dataset.tag; }) }, 'Removed tag #' + el.dataset.tag); break;
      case 'copy-json': K.copy(K.bundleToJSON(K.exportBundle({ kind: 'entity', ids: [id] }, { guide: false }))); break;
      case 'delete': V.confirmDel = V.route.id; V.refocusKey = 'del-no'; renderAll(true); break;
      case 'delete-no': V.confirmDel = null; V.refocusKey = 'delete'; renderAll(true); break;
      case 'delete-yes':
        var dl = trunc(K.label(id), 40), back = collToken(K.type(id)) || 'puzzles';
        snap = K.snapshot(); V.confirmDel = null;
        K.remove(id);
        Desk.go(back, { replace: true });
        K.toast('Deleted ' + (IDPAT.test(id) ? id + ' · ' : '') + dl, { label: 'Undo', run: function () { K.restore(snap); Desk.go(id); K.toast('Restored ' + (IDPAT.test(id) ? id : dl)); } });
        break;
      case 'resolve':
        var ta = $('#cx-res-' + id, V.root), txt = ta ? ta.value.trim() : '';
        if (!txt) { if (ta) { ta.focus(); ta.classList.add('invalid'); } K.toast('Write the resolution first.'); break; }
        update(id, { resolution: txt, status: 'resolved' }, id + ' resolved'); break;
      case 'reopen': update(id, { status: 'open' }, id + ' reopened'); break;
      case 'renew':
        var d = K.parseDate(o.renews); d.setFullYear(d.getFullYear() + 1);
        var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        update(id, { renews: iso }, o.name + ' renewed until ' + K.fmtDate(iso)); break;
      case 'task-done': update(id, { status: o.status === 'done' ? 'todo' : 'done' }, id + (o.status === 'done' ? ' reopened' : ' marked done')); break;
      case 'note-mode': saveNoteNow(); V.noteMode[id] = el.dataset.mode; V.refocusKey = el.dataset.mode === 'edit' ? 'note-ta-' + id : 'note-preview'; renderAll(true); break;
      case 'promote': promote(id, el.dataset.as); break;
      case 'add-guard': V.autoEdit = 'ed-' + id + '-guard'; update(id, { guard: 'Real person. Use documented facts only.' }, 'Guard added to ' + K.label(id)); break;
    }
  }
  function saveListItem(inp) {
    if (!inp) return;
    var id = inp.dataset.id, f = inp.dataset.f, o = K.get(id), v = inp.value.trim();
    if (!v) { inp.focus(); K.toast('Write it first.'); return; }
    V.refocusKey = 'add-' + id + ':' + f;
    update(id, (function () { var p = {}; p[f] = (o[f] || []).concat([v]); return p; })(), 'Added ' + (f === 'solvePath' ? 'step ' : 'hint ') + ((o[f] || []).length + 1) + ' to ' + id);
  }
  var noteTimer = null, noteEl = null;
  function saveNoteNow() {
    clearTimeout(noteTimer);
    if (noteEl && V) { var o = K.get(noteEl.dataset.id); if (o && o.body !== noteEl.value) K.update(noteEl.dataset.id, { body: noteEl.value }); }
    noteEl = null;
  }

  /* ---------- the view ---------- */
  Desk.registerView({
    id: 'codex', title: 'Codex',
    routes: function (t) {
      if (COLL[t]) return { kind: 'coll', key: t };
      if (t === 'problems') return { kind: 'problems' };
      if (K.has(t)) return { kind: 'entity', id: t };
      return null;
    },
    mount: function (root, params, ctx) {
      V = { root: root, ctx: ctx, route: params, newOpen: false, lmenu: false, adding: null, confirm: null, confirmDel: null, noteMode: {},
        issues: [], navCount: 0, scrollMem: {}, editing: null, pending: false, pointerDown: false, force: false, t: null, refocusKey: null, autoEdit: null };
      root.innerHTML = '<div class="cx-mnav"></div><div class="cx-scroll" tabindex="-1"><div class="cx-main"></div></div>';
      V.mnav = root.querySelector('.cx-mnav'); V.scroll = root.querySelector('.cx-scroll'); V.main = root.querySelector('.cx-main');
      var me = V;

      function onClick(e) { if (V !== me) return;
        var t = e.target;
        if (V.lmenu && !t.closest('.cx-lmenu') && !t.closest('[data-act="lmenu"]')) { V.lmenu = false; renderAll(true); if (!t.isConnected) return; }
        if (t.closest('.ref[data-ref]') || t.closest('a[href]')) return; /* the shell navigates */
        var a = t.closest('[data-act]');
        if (a && !a.disabled) { act(a.dataset.act, a); return; }
        var edEl = t.closest('.cx-ed');
        if (edEl && !t.closest('.editing')) { startEdit(edEl); return; }
        var row = t.closest('tr.row[data-id], .cx-card[data-id]');
        if (row && !t.closest('select, input, textarea, button')) V.ctx.go(row.dataset.id);
      }
      function onChange(e) { if (V !== me) return;
        var el = e.target, id = el.dataset.id;
        if (el.matches('[data-move-puzzle]')) {
          var mp = el.dataset.movePuzzle, cur = (K.get(mp) || {}).event || '';
          if (el.value === cur) return;
          update(mp, { event: el.value || null }, el.value ? 'Moved ' + mp + ' to ' + trunc(K.label(el.value), 40) : mp + ' is out of any event now');
          return;
        }
        if (el.matches('[data-move-event]')) { if (el.value !== ((K.get(el.dataset.moveEvent) || {}).chapter || '')) moveEvent(el.dataset.moveEvent, el.value || null); return; }
        if (el.matches('[data-set="chapter"]') && K.type(id) === 'event') { V.refocusKey = el.getAttribute('data-fk'); moveEvent(id, el.value || null); return; }
        if (el.matches('[data-set]')) {
          var val = el.value; if (el.dataset.num) val = +val; if (el.dataset.null && val === '') val = null;
          var p = {}; p[el.dataset.set] = val;
          var txt = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : val;
          update(id, p, (IDPAT.test(id) ? id : trunc(K.label(id), 30)) + ' ' + el.dataset.set.replace(/([A-Z])/g, ' $1').toLowerCase() + ': ' + txt);
        } else if (el.matches('[data-check]')) {
          var checks = D.designChecks.filter(function (dc) { var cb = V.root.querySelector('[data-check="' + dc.id + '"]'); return cb && cb.checked; }).map(function (dc) { return dc.id; });
          update(id, { checks: checks }, (el.checked ? 'Passed: ' : 'Unchecked: ') + (D.designChecks.find(function (d) { return d.id === el.dataset.check; }) || {}).label);
        } else if (el.id === 'cx-grp') { view(V.route.key).group = el.value; savePrefs(); renderBody(V.route.key); }
        else if (el.id === 'cx-srt') { var sp = el.value.split(':'); view(V.route.key).sort = { k: sp[0], dir: +sp[1] }; savePrefs(); renderBody(V.route.key); }
      }
      function onInput(e) { if (V !== me) return;
        var el = e.target;
        if (el.id === 'cx-flt' && V.route.kind === 'coll') { view(V.route.key).q = el.value; renderBody(V.route.key); }
        else if (el.classList.contains('cx-note-ta')) { noteEl = el; clearTimeout(noteTimer); noteTimer = setTimeout(saveNoteNow, 450); }
        else if (el.classList.contains('invalid')) el.classList.remove('invalid');
      }
      function onSubmit(e) { if (V !== me) return; if (e.target.matches('[data-form="new"]')) { e.preventDefault(); createNew(e.target); } }
      function onKey(e) { if (V !== me) return;
        var el = e.target;
        if (el.classList.contains('cx-add-in')) { if (e.key === 'Enter') { e.preventDefault(); saveListItem(el); } else if (e.key === 'Escape') { e.preventDefault(); V.adding = null; V.refocusKey = 'add-' + el.dataset.f; renderAll(true); } return; }
        if (el.classList.contains('cx-tag-in')) {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            var tg = el.value.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
            if (!tg) return;
            var o = K.get(el.dataset.id), tags = o.tags || [];
            if (tags.indexOf(tg) >= 0) { el.value = ''; K.toast('Already tagged #' + tg); return; }
            V.refocusKey = el.getAttribute('data-fk');
            update(el.dataset.id, { tags: tags.concat([tg]) }, 'Tagged #' + tg);
          }
          if (e.key === 'Escape') { e.preventDefault(); el.value = ''; el.blur(); }
          return;
        }
        if (el.id === 'cx-flt' && e.key === 'Escape') { e.preventDefault(); if (el.value) { el.value = ''; view(V.route.key).q = ''; renderBody(V.route.key); } else el.blur(); return; }
        if (el.closest && el.closest('[data-form="new"]') && e.key === 'Escape') { e.preventDefault(); V.newOpen = false; V.refocusKey = 'new'; renderAll(true); return; }
        if (el.matches('tr.row, .cx-card')) {
          if (e.key === 'Enter') { e.preventDefault(); V.ctx.go(el.dataset.id); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            var all = $$('tr.row, .cx-card', V.main), i = all.indexOf(el), nx = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (nx) { e.preventDefault(); nx.focus(); }
          }
          return;
        }
        if (el.matches('.cx-ed') && !el.classList.contains('editing') && e.key === 'Enter') { e.preventDefault(); startEdit(el); return; }
        if (e.key === 'Escape' && V.lmenu) { e.preventDefault(); V.lmenu = false; V.refocusKey = 'lmenu'; renderAll(true); return; }
        if (e.key === 'Escape' && V.confirmDel) { e.preventDefault(); V.confirmDel = null; V.refocusKey = 'delete'; renderAll(true); return; }
        if (e.key === 'Escape' && V.confirm) { e.preventDefault(); V.confirm = null; renderAll(true); return; }
        if (e.key === 'Escape' && V.adding) { e.preventDefault(); V.adding = null; renderAll(true); return; }
      }
      function onFocusOut(e) { if (V !== me) return;
        if (e.target.classList && e.target.classList.contains('cx-note-ta')) saveNoteNow();
        if (V.pending) setTimeout(flush, 0);
      }
      function onDown() { if (V === me) V.pointerDown = true; }
      function onUp() { setTimeout(function () { if (!V) return; V.pointerDown = false; if (V.pending) flush(); }, 0); }
      function onDocKey(e) { if (V !== me) return;
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        var t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        var pal = $('.picker-overlay'); if ((pal && !pal.hidden) || $('.kit-sheet-overlay')) return;
        e.preventDefault();
        if (V.route.kind === 'coll') { var f = $('#cx-flt', V.root); if (f) { f.focus(); f.select(); } }
        else { V.focusFilter = true; V.ctx.go(V.route.kind === 'entity' && K.get(V.route.id) && TYPE_COLL[K.type(V.route.id)] || 'puzzles'); }
      }
      function onFonts() { if (V === me) scrollChip(); }

      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      root.addEventListener('input', onInput);
      root.addEventListener('submit', onSubmit);
      root.addEventListener('keydown', onKey);
      root.addEventListener('focusout', onFocusOut);
      root.addEventListener('pointerdown', onDown, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
      document.addEventListener('keydown', onDocKey);
      var off = K.on('change', onKitChange);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(onFonts);

      renderAll(false);

      return {
        update: function (p) {
          if (!V) return;
          saveNoteNow();
          var prev = tokenOf(V.route), same = tokenOf(p) === prev;
          V.scrollMem[prev] = V.scroll.scrollTop;
          V.route = p; V.navCount++;
          if (!same) { V.newOpen = false; V.lmenu = false; V.adding = null; V.confirm = null; V.confirmDel = null; V.editing = null; }
          renderAll(same);
          if (!same) V.scroll.scrollTop = p.kind === 'coll' ? (V.scrollMem[tokenOf(p)] || 0) : 0;
        },
        unmount: function () {
          saveNoteNow();
          off();
          clearTimeout(V && V.t); clearTimeout(confirmTimer); clearTimeout(noteTimer);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('pointercancel', onUp, true);
          document.removeEventListener('keydown', onDocKey);
          V = null;
        },
        exportScope: function () {
          if (!V) return { kind: 'game' };
          var r = V.route;
          if (r.kind === 'entity' && K.has(r.id)) return { kind: 'entity', ids: [r.id] };
          if (r.kind === 'coll') return { kind: 'collection', type: COLL[r.key].type };
          return { kind: 'game' };
        },
        navToken: function () {
          if (!V) return null;
          var r = V.route;
          if (r.kind === 'coll') return r.key;
          if (r.kind === 'entity' && K.has(r.id)) return collToken(K.type(r.id));
          return 'problems';
        },
      };
    },
  });
})();
