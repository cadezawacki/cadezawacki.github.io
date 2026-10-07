/* ============================================================
   ARG Desk — shared kit (window.Kit)
   Store (games, edits, events, sync through cade.txt), lookup +
   cross-references, field schema, cipher ops + recipes, integrity
   checks, search, LLM export / import, and shared UI helpers
   (palette, pick dialog, sheet, toast, hover cards).

   Structure of a game: chapters → events → puzzles, with clues,
   characters, places, timeline entries, assets, research, ideas,
   questions, tasks and notes around them.

   Storage: when the desk runs inside cade.txt it keeps every game in
   Cade.syncedBlob shards (encrypted, synced across the account's
   devices, 256 KB per blob), merged per entity so edits made on two
   devices don't overwrite each other. Opened on its own (tests, dev)
   it falls back to localStorage under "argdesk-local:".
   Depends on window.ARG_MODEL (model.js).
   ============================================================ */
(function () {
  'use strict';
  var M = window.ARG_MODEL;
  var Kit = {};

  /* ---------- entity types ---------- */
  var TYPES = {
    chapter:   { coll: 'chapters',   label: 'Chapter',        plural: 'Chapters',   icon: 'CH',  prefix: 'CH' },
    event:     { coll: 'events',     label: 'Event',          plural: 'Events',     icon: 'EV',  prefix: 'E' },
    puzzle:    { coll: 'puzzles',    label: 'Puzzle',         plural: 'Puzzles',    icon: 'PZ',  prefix: 'P' },
    clue:      { coll: 'clues',      label: 'Clue',           plural: 'Clues',      icon: 'CL',  prefix: 'C' },
    character: { coll: 'characters', label: 'Character',      plural: 'Characters', icon: 'CHR', prefix: 'c-', slug: true },
    place:     { coll: 'places',     label: 'Place',          plural: 'Places',     icon: 'PL',  prefix: 'pl-', slug: true },
    entry:     { coll: 'timeline',   label: 'Timeline entry', plural: 'Timeline',   icon: 'TL',  prefix: 'TL' },
    asset:     { coll: 'assets',     label: 'Asset',          plural: 'Assets',     icon: 'AS',  prefix: 'AS' },
    research:  { coll: 'research',   label: 'Research',       plural: 'Research',   icon: 'RES', prefix: 'R' },
    idea:      { coll: 'ideas',      label: 'Idea',           plural: 'Ideas',      icon: 'IDA', prefix: 'I' },
    question:  { coll: 'questions',  label: 'Question',       plural: 'Questions',  icon: '?',   prefix: 'Q' },
    task:      { coll: 'tasks',      label: 'Task',           plural: 'Tasks',      icon: 'TD',  prefix: 'T' },
    note:      { coll: 'notes',      label: 'Note',           plural: 'Notes',      icon: 'NT',  prefix: 'N' },
  };
  Kit.TYPES = TYPES;
  var COLLS = Object.keys(TYPES).map(function (t) { return TYPES[t].coll; });
  var TYPE_OF_COLL = {}; Object.keys(TYPES).forEach(function (t) { TYPE_OF_COLL[TYPES[t].coll] = t; });
  /* types whose entries are claims about the world (they carry a reality layer) */
  Kit.CLAIM_TYPES = ['event', 'character', 'place', 'entry', 'clue'];

  /* The live data. Views read from here; every write goes through Kit.update/create/remove. */
  function emptyGame() { return { id: null, title: 'Untitled game', codename: '', tagline: '', premise: '', format: 'Published all at once and left in the wild. Small private group of players. Hints are rare.', players: '' }; }
  var D = window.ARG = { version: 3, game: emptyGame(), layers: M.layers, statuses: M.statuses, puzzleKinds: M.puzzleKinds, designChecks: M.designChecks };
  COLLS.forEach(function (c) { D[c] = []; });

  /* ---------- field schema ----------
     t: text | longtext | number | enum | ref | refs | list | bool | date | url | object
     of: allowed target types for ref/refs; values: enum values; d: description (exported for LLMs) */
  var LAYER_IDS = M.layers.map(function (l) { return l.id; });
  var F = {
    chapter: {
      title: { t: 'text', d: 'Chapter name.' },
      n: { t: 'number', d: 'Order in the game, starting at 0.' },
      summary: { t: 'longtext', d: 'What happens in this chapter.' },
    },
    event: {
      title: { t: 'text', d: 'Event name.' },
      chapter: { t: 'ref', of: ['chapter'], d: 'Chapter the event sits in. null = not placed yet.' },
      order: { t: 'number', d: 'Order inside its chapter, starting at 1.' },
      layer: { t: 'enum', values: LAYER_IDS, d: 'record = settled history; pseudo = unexplained, contested or fringe; fiction = invented.' },
      when: { t: 'date', d: 'When it happens in the world: YYYY, YYYY-MM or YYYY-MM-DD.' },
      place: { t: 'ref', of: ['place'], d: 'Where.' },
      record: { t: 'longtext', d: 'What is actually on the record (real, checkable). Empty for invented events.' },
      twist: { t: 'longtext', d: 'Our fiction layered on top.' },
      research: { t: 'refs', of: ['research'], d: 'Research that supports the record.' },
      puzzles: { t: 'refs', of: ['puzzle'], d: 'Puzzles inside this event.' },
      notes: { t: 'longtext', d: 'Designer notes.' },
    },
    puzzle: {
      title: { t: 'text', d: 'Puzzle name.' },
      chapter: { t: 'ref', of: ['chapter'], d: 'Chapter it belongs to (follows its event).' },
      event: { t: 'ref', of: ['event'], d: 'Event it sits inside.' },
      kind: { t: 'enum', values: M.puzzleKinds.map(function (x) { return x.id; }), d: 'Kind of puzzle.' },
      difficulty: { t: 'number', d: '1 (easy) to 5 (hardest).' },
      status: { t: 'enum', values: M.statuses.map(function (x) { return x.id; }), d: 'Design progress: idea → draft → built → tested → ready.' },
      estMin: { t: 'number', d: 'Estimated solve time in minutes.' },
      premise: { t: 'longtext', d: 'What the player is shown.' },
      mechanic: { t: 'longtext', d: 'How the puzzle works.' },
      solution: { t: 'longtext', d: 'The answer and how it is reached. Spoiler.', spoiler: true },
      solvePath: { t: 'list', d: 'Ordered steps the player takes. Spoiler.', spoiler: true },
      aha: { t: 'text', d: 'The key insight in one line. Spoiler.', spoiler: true },
      hints: { t: 'list', d: 'Optional and rare. Most puzzles have none.' },
      checks: { t: 'list', values: M.designChecks.map(function (x) { return x.id; }), d: 'Design checks passed: ' + M.designChecks.map(function (x) { return x.id + ' = ' + x.label; }).join('; ') + '.' },
      recipe: { t: 'object', d: 'How a cipher is built: {plaintext, steps:[{op, ...params}], output}. Spoiler.', spoiler: true },
      requires: { t: 'refs', of: ['puzzle'], d: 'Puzzles that must be solved first.' },
      inputs: { t: 'refs', of: ['clue'], d: 'Clues the player needs.' },
      reveals: { t: 'refs', d: 'What solving it reveals (timeline entries, characters, …).' },
      assets: { t: 'refs', of: ['asset'], d: 'Assets the puzzle lives in.' },
      final: { t: 'bool', d: 'True for the finale (it is allowed to unlock nothing).' },
      notes: { t: 'longtext', d: 'Designer notes.' },
    },
    clue: {
      text: { t: 'text', d: 'The clue itself.' },
      kind: { t: 'enum', values: ['text', 'image', 'data', 'audio', 'object', 'derived'], d: 'Form of the clue. "derived" = produced by solving a puzzle.' },
      plantedIn: { t: 'ref', of: ['asset', 'puzzle'], d: 'Asset that carries it, or the puzzle whose solution produces it. null = not planted yet.' },
      usedBy: { t: 'refs', of: ['puzzle'], d: 'Puzzles that need it.' },
      layer: { t: 'enum', values: LAYER_IDS, d: 'Reality layer.' },
    },
    character: {
      name: { t: 'text', d: 'Name.' },
      kind: { t: 'enum', values: ['fictional', 'persona', 'historical', 'living', 'faction'], d: 'persona = an account we run in the wild; historical/living = real people.' },
      layer: { t: 'enum', values: LAYER_IDS, d: 'Reality layer.' },
      life: { t: 'text', d: 'Dates.' },
      role: { t: 'longtext', d: 'Role in the game.' },
      voice: { t: 'longtext', d: 'How they write and speak.' },
      secret: { t: 'longtext', d: 'What players learn late. Spoiler.', spoiler: true },
      guard: { t: 'text', d: 'Rule for handling a real person. Always follow it.' },
      appears: { t: 'refs', d: 'Where they appear.' },
      status: { t: 'enum', values: ['canon', 'draft', 'reference'], d: 'Status.' },
    },
    place: {
      name: { t: 'text', d: 'Name.' },
      lat: { t: 'number', d: 'Latitude.' },
      lng: { t: 'number', d: 'Longitude.' },
      layer: { t: 'enum', values: LAYER_IDS, d: 'Reality layer.' },
    },
    entry: {
      date: { t: 'date', d: 'YYYY, YYYY-MM or YYYY-MM-DD.' },
      title: { t: 'text', d: 'What happened.' },
      layer: { t: 'enum', values: LAYER_IDS, d: 'Reality layer.' },
      links: { t: 'refs', d: 'Related things.' },
      revealedBy: { t: 'ref', of: ['puzzle'], d: 'Puzzle that reveals it to players.' },
    },
    asset: {
      name: { t: 'text', d: 'Name.' },
      kind: { t: 'enum', values: ['print', 'domain', 'image', 'social', 'document', 'phone', 'audio', 'physical', 'video', 'other'], d: 'Kind.' },
      status: { t: 'enum', values: ['idea', 'making', 'ready', 'placed'], d: 'idea → making → ready → placed (in the wild).' },
      chapter: { t: 'ref', of: ['chapter'], d: 'First chapter that needs it.' },
      where: { t: 'text', d: 'Where it lives in the wild.' },
      persona: { t: 'ref', of: ['character'], d: 'In-world owner.' },
      renews: { t: 'date', d: 'Renewal date (domains, phone plans). Must stay alive while the game is out.' },
      carries: { t: 'refs', of: ['clue'], d: 'Clues it carries.' },
      cost: { t: 'text', d: 'Cost.' },
      notes: { t: 'longtext', d: 'Notes.' },
    },
    research: {
      title: { t: 'text', d: 'Title.' },
      url: { t: 'url', d: 'Link, if any.' },
      author: { t: 'text', d: 'Author or site.' },
      year: { t: 'number', d: 'Year published.' },
      kind: { t: 'enum', values: ['web', 'book', 'article', 'archive', 'story', 'video', 'other'], d: 'Kind.' },
      reliability: { t: 'enum', values: ['primary', 'scholarly', 'popular', 'fringe'], d: 'How far to trust it.' },
      status: { t: 'enum', values: ['to read', 'read', 'verified'], d: 'Reading status.' },
      excerpt: { t: 'longtext', d: 'Key quote.' },
      notes: { t: 'longtext', d: 'Notes.' },
      supports: { t: 'refs', d: 'What it supports.' },
      tags: { t: 'list', d: 'Tags.' },
    },
    idea: {
      text: { t: 'longtext', d: 'The idea.' },
      url: { t: 'url', d: 'Inspiration link, if any.' },
      tags: { t: 'list', d: 'Tags.' },
      status: { t: 'enum', values: ['raw', 'exploring', 'used', 'parked'], d: 'raw → exploring → used, or parked.' },
      created: { t: 'date', d: 'Date captured.' },
      links: { t: 'refs', d: 'What it relates to.' },
    },
    question: {
      text: { t: 'longtext', d: 'The open question.' },
      kind: { t: 'enum', values: ['continuity', 'research', 'design', 'ethics'], d: 'Kind.' },
      severity: { t: 'enum', values: ['high', 'med', 'low'], d: 'Severity.' },
      status: { t: 'enum', values: ['open', 'resolved'], d: 'Status.' },
      created: { t: 'date', d: 'Date raised.' },
      links: { t: 'refs', d: 'What it affects.' },
      resolution: { t: 'longtext', d: 'How it was resolved.' },
    },
    task: {
      title: { t: 'text', d: 'What to do.' },
      status: { t: 'enum', values: ['todo', 'doing', 'done'], d: 'Status.' },
      links: { t: 'refs', d: 'What it relates to.' },
    },
    note: {
      title: { t: 'text', d: 'Title.' },
      updated: { t: 'date', d: 'Last edited.' },
      body: { t: 'longtext', d: 'Free text. #ID, @Name and [[Name]] link to things.' },
    },
  };
  Kit.FIELDS = F;

  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  Kit.todayIso = todayIso;
  var DEFAULTS = {
    chapter: function () { return { title: 'New chapter', n: D.chapters.length ? Math.max.apply(null, D.chapters.map(function (c) { return +c.n || 0; })) + 1 : 0, summary: '' }; },
    event: function () { return { title: 'New event', chapter: null, order: 1, layer: 'pseudo', when: '', place: null, record: '', twist: '', research: [], puzzles: [], notes: '' }; },
    puzzle: function () { return { title: 'Untitled puzzle', chapter: null, event: null, kind: 'research', difficulty: 3, status: 'idea', estMin: 30,
      premise: '', mechanic: '', solution: '', solvePath: [], aha: '', hints: [], checks: [], requires: [], inputs: [], reveals: [], assets: [], notes: '' }; },
    clue: function () { return { text: 'New clue', kind: 'text', plantedIn: null, usedBy: [], layer: 'fiction' }; },
    character: function () { return { name: 'New character', kind: 'fictional', layer: 'fiction', life: '', role: '', voice: '', secret: '', appears: [], status: 'draft' }; },
    place: function () { return { name: 'New place', lat: 0, lng: 0, layer: 'record' }; },
    entry: function () { return { date: '', title: 'New timeline entry', layer: 'fiction', links: [] }; },
    asset: function () { return { name: 'New asset', kind: 'other', status: 'idea', chapter: null, where: '', persona: null, renews: null, carries: [], notes: '' }; },
    research: function () { return { title: 'New source', url: null, author: '', year: null, kind: 'web', reliability: 'popular', status: 'to read', excerpt: '', notes: '', supports: [], tags: [] }; },
    idea: function () { return { text: '', url: null, tags: [], status: 'raw', created: todayIso(), links: [] }; },
    question: function () { return { text: '', kind: 'design', severity: 'med', status: 'open', created: todayIso(), links: [] }; },
    task: function () { return { title: 'New task', status: 'todo', links: [] }; },
    note: function () { return { title: 'Untitled note', updated: todayIso(), body: '' }; },
  };
  Kit.defaults = function (type) { return DEFAULTS[type] ? DEFAULTS[type]() : {}; };

  /* ---------- index ---------- */
  var index = new Map();
  function rebuildIndex() {
    index.clear();
    Object.keys(TYPES).forEach(function (t) {
      (D[TYPES[t].coll] || []).forEach(function (o) { index.set(o.id, { type: t, obj: o }); });
    });
  }

  Kit.get = function (id) { var e = index.get(id); return e ? e.obj : null; };
  Kit.type = function (id) { var e = index.get(id); return e ? e.type : null; };
  Kit.has = function (id) { return index.has(id); };
  Kit.typeInfo = function (t) { return TYPES[t] || null; };
  Kit.list = function (type) { return (D[TYPES[type].coll] || []).slice(); };
  Kit.all = function (type) {
    var out = [];
    index.forEach(function (e, id) { if (!type || e.type === type) out.push({ id: id, type: e.type, obj: e.obj }); });
    return out;
  };
  Kit.count = function () { return index.size; };
  Kit.label = function (id) {
    var o = Kit.get(id);
    if (!o) return id;
    return o.title || o.name || o.text || id;
  };
  Kit.typeName = function (id) { var t = Kit.type(id); return t ? TYPES[t].label : ''; };
  Kit.layerOf = function (id) {
    var e = index.get(id);
    if (!e || Kit.CLAIM_TYPES.indexOf(e.type) < 0) return null;
    return e.obj.layer || null;
  };
  Kit.layer = function (lid) { return M.layers.find(function (l) { return l.id === lid; }) || null; };
  /* type from an id's shape, for ids that do not exist yet */
  Kit.typeFromId = function (id) {
    if (typeof id !== 'string') return null;
    if (/^CH\d+$/.test(id)) return 'chapter';
    if (/^AS\d+$/.test(id)) return 'asset';
    if (/^TL\d+$/.test(id)) return 'entry';
    if (/^E\d+$/.test(id)) return 'event';
    if (/^P\d+$/.test(id)) return 'puzzle';
    if (/^C\d+$/.test(id)) return 'clue';
    if (/^R\d+$/.test(id)) return 'research';
    if (/^I\d+$/.test(id)) return 'idea';
    if (/^Q\d+$/.test(id)) return 'question';
    if (/^T\d+$/.test(id)) return 'task';
    if (/^N\d+$/.test(id)) return 'note';
    if (/^c-/.test(id)) return 'character';
    if (/^pl-/.test(id)) return 'place';
    return null;
  };

  /* ---------- names in free text (@Name, [[Name]]) ---------- */
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  Kit.resolveName = function (name, types) {
    var n = norm(name); if (!n) return null;
    var best = null, bestScore = 0;
    index.forEach(function (e, id) {
      if (types && types.indexOf(e.type) < 0) return;
      var l = norm(Kit.label(id)), score = 0;
      if (l === n) score = 100;
      else if (l.indexOf(n) === 0) score = 60 + n.length;
      else if ((' ' + l + ' ').indexOf(' ' + n + ' ') >= 0) score = 40 + n.length;
      else if (n.length >= 4 && l.indexOf(n) >= 0) score = 20 + n.length;
      if (score && ['event', 'character', 'place'].indexOf(e.type) >= 0) score += 1;
      if (score > bestScore) { bestScore = score; best = id; }
    });
    return best;
  };
  /* ids referenced inside a free-text body */
  Kit.textRefs = function (body) {
    var out = [];
    String(body || '').replace(/#([A-Za-z]{1,2}\d+|(?:c|pl)-[a-z0-9-]+)/g, function (_, id) { if (index.has(id)) out.push(id); return _; })
      .replace(/\[\[([^\]]+)\]\]/g, function (_, n) { var id = Kit.resolveName(n); if (id) out.push(id); return _; })
      .replace(/@([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3})/g, function (_, n) {
        var words = n.split(/\s+/);
        for (var k = words.length; k > 0; k--) { var id = Kit.resolveName(words.slice(0, k).join(' '), ['character']); if (id) { out.push(id); break; } }
        return _;
      });
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  };

  /* ---------- references ---------- */
  function collectRefs(val, selfId, out) {
    if (val == null) return;
    if (typeof val === 'string') { if (val !== selfId && index.has(val)) out.add(val); return; }
    if (Array.isArray(val)) { val.forEach(function (v) { collectRefs(v, selfId, out); }); return; }
    if (typeof val === 'object') Object.keys(val).forEach(function (k) { if (k !== 'id') collectRefs(val[k], selfId, out); });
  }
  Kit.refs = function (id) {
    var e = index.get(id); if (!e) return [];
    var s = new Set();
    var o = e.obj;
    Object.keys(o).forEach(function (k) {
      if (k === 'id' || k === 'body' || k === 'text' || k === 'title' || k === 'name' || k.charAt(0) === '_') return;
      if (e.type === 'puzzle' && k === 'recipe') return;
      collectRefs(o[k], id, s);
    });
    if (e.type === 'note') Kit.textRefs(o.body).forEach(function (r) { if (r !== id) s.add(r); });
    return Array.from(s);
  };
  var back = new Map();
  function buildBacklinks() {
    back.clear();
    index.forEach(function (e, id) {
      Kit.refs(id).forEach(function (r) {
        if (!back.has(r)) back.set(r, new Set());
        back.get(r).add(id);
      });
    });
  }
  Kit.backlinks = function (id) { return Array.from(back.get(id) || []); };
  Kit.related = function (id) {
    var s = new Set(Kit.refs(id).concat(Kit.backlinks(id)));
    s.delete(id);
    return Array.from(s);
  };
  /* which field of `fromId` points at `toId` (for "requires", "usedBy" labels) */
  Kit.fieldLinking = function (fromId, toId) {
    var o = Kit.get(fromId); if (!o) return null;
    var hit = null;
    Object.keys(o).some(function (k) {
      if (k.charAt(0) === '_') return false;
      var v = o[k];
      if (v === toId || (Array.isArray(v) && v.indexOf(toId) >= 0)) { hit = k; return true; }
      return false;
    });
    if (!hit && Kit.type(fromId) === 'note' && Kit.textRefs(o.body).indexOf(toId) >= 0) hit = 'mentions';
    return hit;
  };

  /* ---------- events ---------- */
  var listeners = {};
  Kit.on = function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return function () { Kit.off(evt, fn); }; };
  Kit.off = function (evt, fn) { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); };
  function emit(evt, data) { (listeners[evt] || []).slice().forEach(function (fn) { try { fn(data); } catch (err) { console.error(err); } }); }
  Kit.emit = emit;

  /* ============================================================
     STORAGE — games, shards, per-entity merge
     ============================================================ */
  var SHARD_MAX = 110000;        /* JSON chars per shard; encrypted it stays well under cade.txt's 256 KB blob cap */
  var TOMBSTONE_DAYS = 120;
  var bridge = null;             /* window.Cade of the host cade.txt, when embedded */
  try { if (window.parent && window.parent !== window && window.parent.Cade && window.parent.Cade.syncedBlob) bridge = window.parent.Cade; } catch (e) { bridge = null; }
  if (!bridge && window.Cade && window.Cade.syncedBlob) bridge = window.Cade;
  var Store = Kit.storage = {
    backend: bridge ? 'cade' : 'local',
    syncConfigured: function () {
      if (!bridge) return false;
      try { var s = bridge.store; return !!(s && s.get('cade-firebase-url') && s.get('cade-sync-key')); } catch (e) { return false; }
    },
    savedAt: null, bytes: 0, shards: 0, pending: false,
  };
  /* blob handles: same {get,set} API for both backends */
  var blobs = new Map();
  function localBlob(id) {
    var key = 'argdesk-local:' + id;
    return {
      get: function () { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } },
      set: function (data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { emit('storage-error', { id: id, error: e }); } },
    };
  }
  function blob(id, onChange) {
    var b = blobs.get(id);
    if (b) { if (onChange) b.onChange = onChange; return b; }
    b = { onChange: onChange || null, handle: null };
    blobs.set(id, b);
    if (bridge) {
      b.handle = bridge.syncedBlob(id, { onChange: function (data, source) { if (b.onChange) { try { b.onChange(data, source); } catch (err) { console.error(err); } } } });
    } else b.handle = localBlob(id);
    return b;
  }
  function blobGet(id) { var d = blob(id).handle.get(); return d == null ? null : JSON.parse(JSON.stringify(d)); }
  function blobSet(id, data) { blob(id).handle.set(data); }

  function hashId(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
  function now() { return Date.now(); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  /* per-game state */
  var G = { id: null, meta: null, dead: {}, lastWritten: {}, dirty: new Set(), metaDirty: false };
  function metaId(gid) { return 'argdesk-' + gid + '-meta'; }
  function shardId(gid, coll, i) { return 'argdesk-' + gid + '-' + coll + '-' + i; }

  function sortColl(coll, arr) {
    var t = TYPE_OF_COLL[coll];
    function natural(a, b) {
      var ma = String(a.id).match(/^(\D*)(\d+)$/), mb = String(b.id).match(/^(\D*)(\d+)$/);
      if (ma && mb && ma[1] === mb[1]) return +ma[2] - +mb[2];
      return (a._c || 0) - (b._c || 0) || String(a.id).localeCompare(String(b.id));
    }
    if (t === 'chapter') arr.sort(function (a, b) { return (+a.n || 0) - (+b.n || 0) || natural(a, b); });
    else if (t === 'event') arr.sort(function (a, b) { return (+a.order || 0) - (+b.order || 0) || natural(a, b); });
    else if (t === 'entry') arr.sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')) || natural(a, b); });
    else arr.sort(natural);
    return arr;
  }
  function assemble(coll, map) {
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    D[coll] = sortColl(coll, arr);
  }
  /* read a whole game from its blobs (synchronous: blobs keep a local copy) */
  function loadGame(gid) {
    G = { id: gid, meta: null, dead: {}, lastWritten: {}, dirty: new Set(), metaDirty: false };
    var meta = blobGet(metaId(gid)) || { v: 3, game: Object.assign(emptyGame(), { id: gid }), gameM: 0, shards: {} };
    G.meta = meta;
    blob(metaId(gid), function (data, source) { onRemoteMeta(gid, data, source); });
    D.game = Object.assign(emptyGame(), meta.game || {}, { id: gid });
    COLLS.forEach(function (coll) {
      var n = (meta.shards && meta.shards[coll]) || 1, map = {};
      for (var i = 0; i < n; i++) {
        var sid = shardId(gid, coll, i);
        blob(sid, onRemoteShard.bind(null, gid, coll, i));
        var data = blobGet(sid);
        if (!data) continue;
        G.lastWritten[sid] = JSON.stringify(data);
        mergeShardInto(map, data, coll);
      }
      assemble(coll, map);
    });
    rebuildIndex(); buildBacklinks(); updateStats();
  }
  function mergeShardInto(map, data, coll) {
    var changed = false;
    var dead = data.dead || {};
    Object.keys(dead).forEach(function (id) {
      if (!G.dead[id] || dead[id] > G.dead[id]) G.dead[id] = dead[id];
      if (map[id] && (map[id]._m || 0) <= G.dead[id]) { delete map[id]; changed = true; }
    });
    var items = data.items || {};
    Object.keys(items).forEach(function (id) {
      var r = items[id]; if (!r || typeof r !== 'object') return;
      if (G.dead[id] && G.dead[id] >= (r._m || 0)) return;
      var l = map[id];
      if (!l || (r._m || 0) > (l._m || 0)) { r.id = id; map[id] = r; changed = true; }
    });
    return changed;
  }
  function collMap(coll) { var m = {}; D[coll].forEach(function (o) { m[o.id] = o; }); return m; }
  function onRemoteShard(gid, coll, i, data, source) {
    if (gid !== G.id || !data) return;
    var map = collMap(coll);
    var changed = mergeShardInto(map, data, coll);
    var sid = shardId(gid, coll, i);
    if (changed) {
      assemble(coll, map); rebuildIndex(); pruneDangling(); buildBacklinks();
      emit('change', { ids: [], kind: 'remote', source: source });
    }
    /* if our merged copy has things the remote shard lacks, push it back */
    var mine = serializeShards(coll, (G.meta.shards && G.meta.shards[coll]) || 1)[i];
    if (mine && JSON.stringify(mine) !== JSON.stringify(data)) { G.dirty.add(coll); scheduleSave(); }
    G.lastWritten[sid] = JSON.stringify(data);
  }
  /* a delete that arrived from another device can leave references behind until the
     referring item syncs too; strip references to deleted ids locally (no stamp: the
     owning device's own edit wins when it arrives) */
  function pruneDangling() {
    index.forEach(function (e) {
      var o = e.obj;
      Object.keys(o).forEach(function (k) {
        if (k === 'id' || k.charAt(0) === '_') return;
        var v = o[k];
        if (typeof v === 'string' && G.dead[v] && !index.has(v)) o[k] = null;
        else if (Array.isArray(v) && v.some(function (x) { return typeof x === 'string' && G.dead[x] && !index.has(x); }))
          o[k] = v.filter(function (x) { return !(typeof x === 'string' && G.dead[x] && !index.has(x)); });
      });
    });
  }
  function onRemoteMeta(gid, data, source) {
    if (gid !== G.id || !data) return;
    var changed = false;
    if ((data.gameM || 0) > (G.meta.gameM || 0)) {
      G.meta.game = data.game; G.meta.gameM = data.gameM;
      D.game = Object.assign(emptyGame(), data.game || {}, { id: gid });
      changed = true;
    }
    var grew = [];
    Object.keys(data.shards || {}).forEach(function (coll) {
      var mineN = (G.meta.shards || {})[coll] || 1;
      if (data.shards[coll] > mineN) { G.meta.shards[coll] = data.shards[coll]; grew.push(coll); }
    });
    grew.forEach(function (coll) {
      var map = collMap(coll);
      for (var i = 0; i < G.meta.shards[coll]; i++) {
        var sid = shardId(gid, coll, i);
        blob(sid, onRemoteShard.bind(null, gid, coll, i));
        var d = blobGet(sid); if (d) mergeShardInto(map, d, coll);
      }
      assemble(coll, map); changed = true;
    });
    if (changed) { rebuildIndex(); buildBacklinks(); emit('change', { ids: [], kind: 'remote', source: source }); }
  }
  function serializeShards(coll, n) {
    var shards = [];
    for (var i = 0; i < n; i++) shards.push({ items: {}, dead: {} });
    D[coll].forEach(function (o) {
      var copy = clone(o); delete copy.id;
      shards[hashId(o.id) % n].items[o.id] = copy;
    });
    var type = TYPE_OF_COLL[coll], cutoff = now() - TOMBSTONE_DAYS * 86400000;
    Object.keys(G.dead).forEach(function (id) {
      if (G.dead[id] < cutoff) { delete G.dead[id]; return; }
      if (Kit.typeFromId(id) === type || (G.deadType && G.deadType[id] === type)) shards[hashId(id) % n].dead[id] = G.dead[id];
    });
    return shards;
  }
  var saveTimer = null;
  function scheduleSave() {
    if (!G.id) return;
    Store.pending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!G.id) return;
    var gid = G.id;
    G.meta.shards = G.meta.shards || {};
    G.dirty.forEach(function (coll) {
      var n = G.meta.shards[coll] || 1, shards;
      for (;;) {
        shards = serializeShards(coll, n);
        var tooBig = shards.some(function (s) { return JSON.stringify(s).length > SHARD_MAX; });
        if (!tooBig || n >= 64) break;
        n *= 2;
      }
      if (n !== (G.meta.shards[coll] || 1)) { G.meta.shards[coll] = n; G.metaDirty = true; }
      shards.forEach(function (s, i) {
        var sid = shardId(gid, coll, i), str = JSON.stringify(s);
        if (G.lastWritten[sid] === str) return;
        blob(sid, onRemoteShard.bind(null, gid, coll, i));
        blobSet(sid, s); G.lastWritten[sid] = str;
      });
    });
    G.dirty.clear();
    if (G.metaDirty) { blobSet(metaId(gid), clone(G.meta)); G.metaDirty = false; }
    Store.pending = false; Store.savedAt = now(); updateStats();
    emit('saved', Store);
  }
  Kit.flush = flushSave;
  /* test hook: deliver a "remote" copy of a blob as cade.txt's sync would */
  Kit._remote = function (id, data, source) { var b = blobs.get(id); if (b && b.onChange) b.onChange(data, source || 'remote'); };
  Kit._blobIds = function () { return Array.from(blobs.keys()); };
  Kit._blobGet = function (id) { return blobGet(id); };
  function updateStats() {
    if (!G.id) { Store.bytes = 0; Store.shards = 0; return; }
    var bytes = 0, shards = 0;
    COLLS.forEach(function (coll) {
      var n = (G.meta && G.meta.shards && G.meta.shards[coll]) || 1;
      for (var i = 0; i < n; i++) { var s = G.lastWritten[shardId(G.id, coll, i)]; if (s) { bytes += s.length; shards++; } }
    });
    Store.bytes = bytes; Store.shards = shards;
  }
  try { window.addEventListener('pagehide', function () { if (Store.pending) flushSave(); }); } catch (e) { /* no window events */ }

  /* ---------- games registry (synced) ---------- */
  var REG_ID = 'argdesk-games';
  var CUR_KEY = 'argdesk-current-game';
  var reg = { games: {}, dead: {} };
  function loadRegistry() {
    var data = blobGet(REG_ID);
    reg = { games: (data && data.games) || {}, dead: (data && data.dead) || {} };
  }
  function saveRegistry() { blobSet(REG_ID, clone(reg)); }
  blob(REG_ID, function (data, source) {
    if (!data) return;
    var changed = false;
    Object.keys(data.games || {}).forEach(function (gid) {
      var r = data.games[gid], l = reg.games[gid];
      if (reg.dead[gid] && reg.dead[gid] >= (r.m || 0)) return;
      if (!l || (r.m || 0) > (l.m || 0)) { reg.games[gid] = r; changed = true; }
    });
    Object.keys(data.dead || {}).forEach(function (gid) {
      if (!reg.dead[gid] || data.dead[gid] > reg.dead[gid]) { reg.dead[gid] = data.dead[gid]; if (reg.games[gid] && (reg.games[gid].m || 0) <= reg.dead[gid]) { delete reg.games[gid]; changed = true; } }
    });
    if (changed) emit('games', { source: source });
    if (!G.id) { var first = Kit.games.list()[0]; if (first) Kit.games.open(first.id); }
  });
  loadRegistry();
  Kit.games = {
    list: function () {
      return Object.keys(reg.games).map(function (id) { return Object.assign({ id: id }, reg.games[id]); })
        .sort(function (a, b) { return (a.id === 'sample') - (b.id === 'sample') || (a.c || 0) - (b.c || 0); });
    },
    current: function () { return G.id; },
    /* open a game by id (loads synchronously from local copies; remote copies merge in as they arrive) */
    open: function (gid) {
      if (G.id && Store.pending) flushSave();
      if (!reg.games[gid]) return false;
      loadGame(gid);
      try { localStorage.setItem(CUR_KEY, gid); } catch (e) { /* storage unavailable */ }
      emit('change', { ids: [], kind: 'load' });
      emit('games', {});
      return true;
    },
    create: function (title, opts) {
      var gid = (opts && opts.id) || ('g' + now().toString(36) + Math.floor(Math.random() * 1296).toString(36));
      reg.games[gid] = { title: title || 'Untitled game', c: now(), m: now() };
      delete reg.dead[gid];
      saveRegistry();
      blobSet(metaId(gid), { v: 3, game: Object.assign(emptyGame(), { id: gid, title: title || 'Untitled game' }), gameM: now(), shards: {} });
      emit('games', {});
      return gid;
    },
    rename: function (gid, title) {
      if (!reg.games[gid]) return;
      reg.games[gid].title = title; reg.games[gid].m = now(); saveRegistry();
      if (gid === G.id) Kit.updateGame({ title: title });
      emit('games', {});
    },
    /* remove a game from this account (its data is cleared) */
    remove: function (gid) {
      if (!reg.games[gid]) return;
      var meta = gid === G.id ? G.meta : (blobGet(metaId(gid)) || { shards: {} });
      COLLS.forEach(function (coll) {
        var n = (meta.shards && meta.shards[coll]) || 1;
        for (var i = 0; i < n; i++) blobSet(shardId(gid, coll, i), { items: {}, dead: {} });
      });
      blobSet(metaId(gid), null);
      delete reg.games[gid]; reg.dead[gid] = now(); saveRegistry();
      if (gid === G.id) {
        G = { id: null, meta: null, dead: {}, lastWritten: {}, dirty: new Set(), metaDirty: false };
        D.game = emptyGame(); COLLS.forEach(function (c) { D[c] = []; }); rebuildIndex(); buildBacklinks();
        try { localStorage.removeItem(CUR_KEY); } catch (e) { /* ignore */ }
        emit('change', { ids: [], kind: 'load' });
      }
      emit('games', {});
    },
    /* load the bundled sample into its own game slot and open it */
    openSample: function () {
      var S = window.ARG_SAMPLE;
      if (!S) return false;
      if (!reg.games.sample) {
        if (G.id && Store.pending) flushSave(); /* the open game's last edits must not wait out the save timer */
        Kit.games.create((S.game.title || 'Sample') + ' (sample)', { id: 'sample' });
        loadGame('sample');
        var t = now(), seq = 0;
        Kit.batch(function () {
          D.game = Object.assign(emptyGame(), S.game, { id: 'sample', title: S.game.title });
          G.meta.game = clone(D.game); G.meta.gameM = t; G.metaDirty = true;
          COLLS.forEach(function (coll) {
            D[coll] = sortColl(coll, (S[coll] || []).map(function (o) { var c = clone(o); c._m = t; c._c = t + (seq++); return c; }));
            G.dirty.add(coll);
          });
        });
        flushSave();
      }
      return Kit.games.open('sample');
    },
    /* open the last game used on this device, or the first one */
    resume: function () {
      var gid = null;
      try { gid = localStorage.getItem(CUR_KEY); } catch (e) { gid = null; }
      if (!gid || !reg.games[gid]) { var first = Kit.games.list()[0]; gid = first ? first.id : null; }
      if (gid) return Kit.games.open(gid);
      return false;
    },
  };

  /* ---------- edits ---------- */
  var batchDepth = 0, batchIds = new Set();
  function changed(ids, kind) {
    rebuildIndex(); buildBacklinks();
    ids.forEach(function (id) { var t = Kit.typeFromId(id) || Kit.type(id); if (t) G.dirty.add(TYPES[t].coll); });
    if (batchDepth) { ids.forEach(function (i) { batchIds.add(i); }); return; }
    scheduleSave();
    emit('change', { ids: ids, kind: kind || 'update' });
  }
  Kit.batch = function (fn) {
    batchDepth++;
    try { fn(); } finally {
      batchDepth--;
      if (!batchDepth) {
        var ids = Array.from(batchIds); batchIds.clear();
        rebuildIndex(); buildBacklinks(); scheduleSave();
        emit('change', { ids: ids, kind: 'batch' });
      }
    }
  };

  /* two-way links kept in sync automatically */
  var PAIRS = [
    { a: 'puzzle', fa: 'inputs', b: 'clue', fb: 'usedBy' },
    { a: 'puzzle', fa: 'event', b: 'event', fb: 'puzzles', single: true },
    { a: 'clue', fa: 'plantedIn', b: 'asset', fb: 'carries', single: true },
    { a: 'event', fa: 'research', b: 'research', fb: 'supports' },
  ];
  function asList(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function stamp(o) { if (o) o._m = Math.max(now(), (o._m || 0) + 1); }
  function syncPairs(id, type, before, after, touched) {
    PAIRS.forEach(function (p) {
      var sides = [];
      if (type === p.a) sides.push({ mine: p.fa, theirs: p.fb, otherType: p.b, theirsSingle: false });
      if (type === p.b) sides.push({ mine: p.fb, theirs: p.fa, otherType: p.a, theirsSingle: !!p.single });
      sides.forEach(function (s) {
        if (!(s.mine in after) && !(s.mine in before)) return;
        var was = asList(before[s.mine]), nowList = asList(after[s.mine]);
        was.filter(function (x) { return nowList.indexOf(x) < 0; }).forEach(function (t) {
          var o = Kit.get(t); if (!o || Kit.type(t) !== s.otherType) return;
          if (s.theirsSingle) { if (o[s.theirs] === id) { o[s.theirs] = null; stamp(o); touched.push(t); } }
          else { o[s.theirs] = asList(o[s.theirs]).filter(function (x) { return x !== id; }); stamp(o); touched.push(t); }
        });
        nowList.filter(function (x) { return was.indexOf(x) < 0; }).forEach(function (t) {
          var o = Kit.get(t); if (!o || Kit.type(t) !== s.otherType) return;
          if (s.theirsSingle) {
            var prev = o[s.theirs];
            if (prev && prev !== id) { var po = Kit.get(prev); if (po && Array.isArray(po[s.mine])) { po[s.mine] = po[s.mine].filter(function (x) { return x !== t; }); stamp(po); touched.push(prev); } }
            o[s.theirs] = id; stamp(o); touched.push(t);
          } else {
            var arr = asList(o[s.theirs]);
            if (arr.indexOf(id) < 0) { o[s.theirs] = arr.concat([id]); stamp(o); touched.push(t); }
          }
        });
      });
    });
  }
  /* a puzzle's chapter follows its event */
  function syncChapters(touched) {
    D.puzzles.forEach(function (p) {
      var ev = p.event && Kit.get(p.event);
      if (ev && Kit.type(p.event) === 'event' && p.chapter !== (ev.chapter || null)) { p.chapter = ev.chapter || null; stamp(p); touched.push(p.id); }
    });
  }

  /* Kit.update('P04', { status: 'tested' }) */
  Kit.update = function (id, patch) {
    var e = index.get(id); if (!e) return false;
    var before = {}; Object.keys(patch).forEach(function (k) { before[k] = clone(e.obj[k]); });
    Object.keys(patch).forEach(function (k) { if (k !== 'id' && k !== 'type' && k.charAt(0) !== '_') e.obj[k] = patch[k]; });
    if (e.type === 'note' && !('updated' in patch)) e.obj.updated = todayIso();
    stamp(e.obj);
    var touched = [id];
    syncPairs(id, e.type, before, patch, touched);
    rebuildIndex();
    if (e.type === 'puzzle' || e.type === 'event') syncChapters(touched);
    changed(touched, 'update');
    return true;
  };
  /* edit the game's own fields (title, tagline, premise, format, players) */
  Kit.updateGame = function (patch) {
    if (!G.id) return;
    ['title', 'tagline', 'premise', 'format', 'players', 'codename'].forEach(function (k) { if (k in patch) D.game[k] = patch[k]; });
    G.meta.game = clone(D.game); G.meta.gameM = now(); G.metaDirty = true;
    if ('title' in patch && reg.games[G.id]) { reg.games[G.id].title = patch.title; reg.games[G.id].m = now(); saveRegistry(); emit('games', {}); }
    scheduleSave();
    emit('change', { ids: [], kind: 'game' });
  };
  /* next free id for a type; slug types derive from a name */
  Kit.nextId = function (type, name, taken) {
    var info = TYPES[type]; taken = taken || new Set();
    if (info.slug) {
      var base = info.prefix + (norm(name).replace(/ /g, '-').slice(0, 28) || 'new');
      var id = base, i = 2;
      while (index.has(id) || taken.has(id) || G.dead[id]) id = base + '-' + (i++);
      return id;
    }
    var max = 0;
    function see(x) { var m = String(x).match(/^(\D+)(\d+)$/); if (m && m[1] === info.prefix) max = Math.max(max, +m[2]); }
    (D[info.coll] || []).forEach(function (o) { see(o.id); });
    taken.forEach(see);
    Object.keys(G.dead).forEach(see); /* never reuse a deleted id: other devices may still hold it */
    var width = type === 'chapter' ? 1 : 2;
    return info.prefix + String(max + 1).padStart(width, '0');
  };
  /* Kit.create('puzzle', { title: 'New' }) → id */
  Kit.create = function (type, obj) {
    var info = TYPES[type]; if (!info) throw new Error('Unknown type ' + type);
    if (!G.id) throw new Error('Open or create a game first');
    obj = obj || {};
    var o = Object.assign(Kit.defaults(type), obj);
    if (!o.id || index.has(o.id)) o.id = Kit.nextId(type, o.name || o.title || o.text);
    if (G.dead[o.id]) delete G.dead[o.id];
    o._c = now(); stamp(o);
    if (type === 'puzzle' && o.event) { var ev = Kit.get(o.event); if (ev) o.chapter = ev.chapter || null; }
    D[info.coll].push(o);
    sortColl(info.coll, D[info.coll]);
    rebuildIndex();
    var before = {}, touched = [o.id];
    Object.keys(o).forEach(function (k) { before[k] = Array.isArray(o[k]) ? [] : null; });
    syncPairs(o.id, type, before, o, touched);
    changed(touched, 'create');
    return o.id;
  };
  /* remove an entity and strip every reference to it */
  Kit.remove = function (id) {
    var e = index.get(id); if (!e) return false;
    var coll = D[TYPES[e.type].coll];
    coll.splice(coll.indexOf(e.obj), 1);
    G.dead[id] = now(); (G.deadType = G.deadType || {})[id] = e.type;
    var touched = [id];
    index.forEach(function (x, xid) {
      if (xid === id) return;
      var o = x.obj, hit = false;
      Object.keys(o).forEach(function (k) {
        if (k === 'id' || k.charAt(0) === '_') return;
        if (o[k] === id) { o[k] = null; hit = true; }
        else if (Array.isArray(o[k]) && o[k].indexOf(id) >= 0) { o[k] = o[k].filter(function (v) { return v !== id; }); hit = true; }
      });
      if (hit) { stamp(o); touched.push(xid); }
    });
    changed(touched, 'remove');
    return true;
  };

  /* snapshots (undo for imports, deletes and big edits) */
  Kit.snapshot = function () { var s = { game: clone(D.game) }; COLLS.forEach(function (c) { s[c] = clone(D[c]); }); return s; };
  Kit.restore = function (snap) {
    if (!snap || !G.id) return;
    var t = now(), keep = new Set();
    COLLS.forEach(function (c) {
      if (!Array.isArray(snap[c])) return;
      var restored = clone(snap[c]);
      restored.forEach(function (o) { o._m = t; keep.add(o.id); delete G.dead[o.id]; });
      D[c].forEach(function (o) { if (!keep.has(o.id)) { G.dead[o.id] = t; (G.deadType = G.deadType || {})[o.id] = TYPE_OF_COLL[c]; } });
      D[c] = sortColl(c, restored);
      G.dirty.add(c);
    });
    if (snap.game) { D.game = Object.assign(emptyGame(), snap.game, { id: G.id }); G.meta.game = clone(D.game); G.meta.gameM = t; G.metaDirty = true; }
    rebuildIndex(); buildBacklinks();
    scheduleSave();
    emit('change', { ids: [], kind: 'restore' });
  };
  Kit.isEmpty = function () { return index.size === 0; };

  rebuildIndex(); buildBacklinks();

  /* ---------- dates ---------- */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  Kit.today = new Date(todayIso() + 'T12:00:00');
  Kit.parseDate = function (iso) {
    if (!iso) return null;
    var p = String(iso).split(/[- :]/).map(Number);
    if (!p[0]) return null;
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1, 12);
  };
  Kit.fmtDate = function (iso, opts) {
    if (!iso) return '—';
    opts = opts || {};
    var p = String(iso).split(/[- ]/);
    if (p.length === 1) return p[0];
    var m = MONTHS[+p[1] - 1];
    if (!m) return String(iso);
    if (p.length === 2) return m + ' ' + p[0];
    return (+p[2]) + ' ' + m + (opts.noYear ? '' : ' ' + p[0]);
  };
  Kit.daysUntil = function (iso) {
    var d = Kit.parseDate(iso); if (!d) return null;
    return Math.round((d - Kit.today) / 86400000);
  };
  Kit.relDays = function (iso) {
    var n = Kit.daysUntil(iso);
    if (n == null) return '';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? 'in ' + n + ' days' : -n + ' days ago';
  };
  Kit.year = function (iso) { return iso ? +String(iso).slice(0, 4) : null; };
  Kit.fmtMinutes = function (m) {
    m = Math.round(m || 0);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  };

  /* ---------- html helpers ---------- */
  Kit.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  Kit.h = function (tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }

  Kit.layerBadge = function (lid, opts) {
    var l = Kit.layer(lid); if (!l) return '';
    opts = opts || {};
    return '<span class="layer layer-' + l.id + (opts.short ? ' short' : '') + '" title="' + Kit.esc(l.label + ': ' + l.desc) + '">' +
      Kit.esc(opts.short ? l.short : l.label) + '</span>';
  };
  Kit.layerDot = function (lid) {
    return lid ? '<span class="layer-dot layer-' + lid + '" title="' + Kit.esc((Kit.layer(lid) || {}).label || '') + '"></span>' : '';
  };
  Kit.statusIndex = function (s) { return D.statuses.findIndex(function (x) { return x.id === s; }); };
  Kit.statusLabel = function (s) { var st = D.statuses.find(function (x) { return x.id === s; }); return st ? st.label : s; };
  Kit.pips = function (status, opts) {
    var n = Kit.statusIndex(status), total = D.statuses.length, html = '';
    for (var i = 0; i < total; i++) html += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return '<span class="pips' + (status === 'ready' ? ' live' : '') + '" title="' + Kit.esc(Kit.statusLabel(status)) + '">' + html + '</span>' +
      (opts && opts.label ? '<span class="pips-label">' + Kit.esc(Kit.statusLabel(status)) + '</span>' : '');
  };
  Kit.diff = function (n) {
    var html = '';
    for (var i = 1; i <= 5; i++) html += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return '<span class="diff' + (n >= 4 ? ' hard' : '') + '" title="Difficulty ' + n + ' of 5">' + html + '</span>';
  };
  Kit.idChip = function (id) { return '<span class="id">' + Kit.esc(id) + '</span>'; };
  Kit.refHtml = function (id, opts) {
    var o = Kit.get(id);
    if (!o) return '<span class="id">' + Kit.esc(id) + '</span>';
    opts = opts || {};
    var lbl = Kit.label(id);
    if (lbl.length > 44) lbl = lbl.slice(0, 42) + '…';
    var lay = Kit.layerOf(id);
    var coded = /^(P|C|AS|R|Q|T|N|I|CH|E|TL)\d/.test(id);
    return '<button type="button" class="ref" data-ref="' + Kit.esc(id) + '">' +
      (lay ? Kit.layerDot(lay) : '') +
      (coded ? '<span class="ref-id">' + Kit.esc(id) + '</span>' : '') +
      (opts.idOnly && coded ? '' : '<span class="ref-name">' + Kit.esc(lbl) + '</span>') + '</button>';
  };
  Kit.domain = function (url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

  Kit.summary = function (id) {
    var e = index.get(id); if (!e) return '';
    var o = e.obj;
    switch (e.type) {
      case 'puzzle':    return o.mechanic || o.premise || '';
      case 'event':     return (o.twist || o.record || '') ;
      case 'character': return (o.role || '') + (o.guard ? ' — ' + o.guard : '');
      case 'clue':      return (o.plantedIn ? 'Planted in ' + o.plantedIn + ' (' + Kit.label(o.plantedIn) + ')' : 'Not planted anywhere yet') + '. Used by ' + ((o.usedBy || []).length ? o.usedBy.join(', ') : 'nothing') + '.';
      case 'asset':     return o.kind + ' · ' + o.status + (o.where ? ' · ' + o.where : '') + (o.renews ? ' · renews ' + Kit.fmtDate(o.renews) : '');
      case 'research':  return [o.author, o.year, o.reliability, o.status].filter(Boolean).join(' · ') + (o.url ? ' · ' + Kit.domain(o.url) : '');
      case 'idea':      return o.status + (o.url ? ' · ' + Kit.domain(o.url) : '') + ((o.tags || []).length ? ' · #' + o.tags.join(' #') : '');
      case 'question':  return o.kind + ' · ' + o.severity + ' · ' + o.status + (o.resolution ? ' — ' + o.resolution : '');
      case 'entry':     return Kit.fmtDate(o.date) + (o.revealedBy ? ' · revealed by ' + o.revealedBy : '');
      case 'place':     return (+o.lat).toFixed(2) + ', ' + (+o.lng).toFixed(2);
      case 'chapter':   return o.summary;
      case 'task':      return o.status;
      case 'note':      return 'Updated ' + Kit.fmtDate(o.updated);
    }
    return '';
  };

  /* ---------- chapters → events → puzzles ---------- */
  Kit.chapter = function (cid) { return D.chapters.find(function (a) { return a.id === cid; }) || null; };
  Kit.chapters = function () { return D.chapters.slice().sort(function (a, b) { return (+a.n || 0) - (+b.n || 0); }); };
  Kit.event = function (eid) { return D.events.find(function (x) { return x.id === eid; }) || null; };
  /* events inside a chapter, in order (chapter null = not placed yet) */
  Kit.eventsIn = function (cid) { return D.events.filter(function (x) { return (x.chapter || null) === (cid || null); }).sort(function (a, b) { return (+a.order || 0) - (+b.order || 0) || String(a.id).localeCompare(String(b.id)); }); };
  Kit.puzzlesIn = function (cid) { return D.puzzles.filter(function (p) { return p.chapter === cid; }); };
  Kit.puzzlesInEvent = function (eid) { return Kit.puzzleOrder().filter(function (p) { return p.event === eid; }); };
  Kit.unlocks = function (pid) { return D.puzzles.filter(function (p) { return (p.requires || []).indexOf(pid) >= 0; }).map(function (p) { return p.id; }); };
  /* topological order: always takes the ready puzzle from the earliest chapter, then event, then data order */
  Kit.puzzleOrder = function () {
    var done = new Set(), out = [];
    var left = D.puzzles.slice();
    function rank(p) {
      var c = Kit.chapter(p.chapter), ev = p.event ? Kit.event(p.event) : null;
      return (c ? +c.n || 0 : 999) * 1e6 + (ev ? +ev.order || 0 : 999) * 1e3 + D.puzzles.indexOf(p);
    }
    while (left.length) {
      var ready = left.filter(function (p) { return (p.requires || []).every(function (r) { return done.has(r) || !Kit.get(r); }); });
      if (!ready.length) { out = out.concat(left); break; }
      ready.sort(function (a, b) { return rank(a) - rank(b); });
      var next = ready[0];
      done.add(next.id); out.push(next);
      left = left.filter(function (p) { return p !== next; });
    }
    return out;
  };
  /* everything a player has seen after solving `solvedIds` */
  Kit.knownAfter = function (solvedIds) {
    var solved = new Set(solvedIds), known = new Set();
    D.puzzles.forEach(function (p) {
      if (!solved.has(p.id)) return;
      (p.inputs || []).forEach(function (c) { known.add(c); });
      (p.reveals || []).forEach(function (r) { known.add(r); });
      if (p.event) known.add(p.event);
    });
    D.clues.forEach(function (c) { if (c.plantedIn && solved.has(c.plantedIn)) known.add(c.id); });
    return Array.from(known);
  };
  /* puzzles on any dependency path from `from` to `to` (inclusive) */
  Kit.sequence = function (from, to) {
    function reach(start, dir) {
      var seen = new Set([start]), stack = [start];
      while (stack.length) {
        var cur = stack.pop();
        var next = dir === 'down' ? Kit.unlocks(cur) : ((Kit.get(cur) || {}).requires || []);
        next.forEach(function (n) { if (!seen.has(n)) { seen.add(n); stack.push(n); } });
      }
      return seen;
    }
    var down = reach(from, 'down'), up = reach(to, 'up');
    return Kit.puzzleOrder().map(function (p) { return p.id; }).filter(function (id) { return down.has(id) && up.has(id); });
  };

  /* ---------- cipher ops + recipes ----------
     Kit.ops[name] = { label, params:[{key,label,type:'text'|'number',def}], encode(text,p), decode(text,p), lossy? } */
  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function shiftChar(c, s) {
    var up = c.toUpperCase(), i = A.indexOf(up);
    if (i < 0) return c;
    return A[((i + s) % 26 + 26) % 26];
  }
  var MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..' };
  var MORSE_R = {}; Object.keys(MORSE).forEach(function (k) { MORSE_R[MORSE[k]] = k; });
  Kit.ops = {
    caesar: { label: 'Caesar shift', params: [{ key: 'shift', label: 'Shift', type: 'number', def: 3 }],
      encode: function (t, p) { var s = +p.shift || 0; return t.replace(/[A-Za-z]/g, function (c) { return shiftChar(c, s); }); },
      decode: function (t, p) { var s = +p.shift || 0; return t.replace(/[A-Za-z]/g, function (c) { return shiftChar(c, -s); }); } },
    vigenere: { label: 'Vigenère', params: [{ key: 'key', label: 'Key', type: 'text', def: 'KEY' }],
      encode: function (t, p) { return vig(t, p.key, 1); }, decode: function (t, p) { return vig(t, p.key, -1); } },
    atbash: { label: 'Atbash', params: [],
      encode: function (t) { return t.replace(/[A-Za-z]/g, function (c) { return A[25 - A.indexOf(c.toUpperCase())]; }); },
      decode: function (t) { return Kit.ops.atbash.encode(t); } },
    a1z26: { label: 'Letters to numbers (A=1)', params: [],
      encode: function (t) { return t.toUpperCase().split(/\s+/).filter(Boolean).map(function (w) { return w.replace(/[^A-Z]/g, '').split('').map(function (c) { return A.indexOf(c) + 1; }).join('-'); }).filter(Boolean).join(' '); },
      decode: function (t) { return t.trim().split(/\s+/).map(function (w) { return w.split(/[-,.]/).filter(Boolean).map(function (n) { return A[(+n - 1)] || '?'; }).join(''); }).join(' '); } },
    morse: { label: 'Morse code', params: [],
      encode: function (t) { return t.toUpperCase().trim().split(/\s+/).map(function (w) { return w.split('').map(function (c) { return MORSE[c] || ''; }).filter(Boolean).join(' '); }).join(' / '); },
      decode: function (t) { return t.trim().split(/\s*\/\s*/).map(function (w) { return w.split(/\s+/).map(function (c) { return MORSE_R[c] || '?'; }).join(''); }).join(' '); } },
    reverse: { label: 'Reverse', params: [],
      encode: function (t) { return t.split('').reverse().join(''); }, decode: function (t) { return t.split('').reverse().join(''); } },
    bigear: { label: 'Big Ear intensity code (0–9, A=10)', params: [],
      encode: function (t) { return t.toUpperCase().replace(/[^0-9A-Z]/g, '').split('').map(function (c) { return /[0-9]/.test(c) ? c : String(A.indexOf(c) + 10); }).join(' '); },
      decode: function (t) { return t.trim().split(/\s+/).map(function (n) { n = +n; return n < 10 ? String(n) : (A[n - 10] || '?'); }).join(''); } },
    railfence: { label: 'Rail fence', params: [{ key: 'rails', label: 'Rails', type: 'number', def: 3 }],
      encode: function (t, p) { var r = Math.max(2, +p.rails || 2), rows = []; for (var i = 0; i < r; i++) rows.push(''); var row = 0, dir = 1;
        t.split('').forEach(function (c) { rows[row] += c; if (row === 0) dir = 1; else if (row === r - 1) dir = -1; row += dir; }); return rows.join(''); },
      decode: function (t, p) { var r = Math.max(2, +p.rails || 2), n = t.length, pattern = [], row = 0, dir = 1, i;
        for (i = 0; i < n; i++) { pattern.push(row); if (row === 0) dir = 1; else if (row === r - 1) dir = -1; row += dir; }
        var counts = []; for (i = 0; i < r; i++) counts.push(pattern.filter(function (x) { return x === i; }).length);
        var rows = [], pos = 0; for (i = 0; i < r; i++) { rows.push(t.slice(pos, pos + counts[i]).split('')); pos += counts[i]; }
        return pattern.map(function (rr) { return rows[rr].shift(); }).join(''); } },
    upper: { label: 'Uppercase', params: [], lossy: true,
      encode: function (t) { return t.toUpperCase(); }, decode: function (t) { return t; } },
    lettersonly: { label: 'Letters only', params: [], lossy: true,
      encode: function (t) { return t.toUpperCase().replace(/[^A-Z]/g, ''); }, decode: function (t) { return t; } },
  };
  function vig(t, key, dir) {
    var k = String(key || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!k) return t;
    var i = 0;
    return t.replace(/[A-Za-z]/g, function (c) { var s = A.indexOf(k[i++ % k.length]); return shiftChar(c, dir * s); });
  }
  Kit.registerOp = function (name, def) { Kit.ops[name] = def; };
  /* run steps; dir 'encode' (in order) or 'decode' (reverse order) */
  Kit.runRecipe = function (input, steps, dir) {
    dir = dir || 'encode';
    var list = (steps || []).slice();
    if (dir === 'decode') list.reverse();
    var cur = String(input == null ? '' : input), trace = [], lossy = false;
    for (var i = 0; i < list.length; i++) {
      var st = list[i], op = Kit.ops[st.op];
      if (!op) return { output: cur, trace: trace, error: 'Unknown step "' + st.op + '"', lossy: lossy };
      if (op.lossy) lossy = true;
      try { cur = op[dir](cur, st); } catch (err) { return { output: cur, trace: trace, error: (op.label || st.op) + ': ' + err.message, lossy: lossy }; }
      trace.push({ op: st.op, out: cur });
    }
    return { output: cur, trace: trace, error: null, lossy: lossy };
  };
  function squash(s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
  /* checks a puzzle's stored recipe: { ok, built, roundTrip, problems[] } */
  Kit.checkRecipe = function (recipe) {
    var res = { ok: true, built: null, roundTrip: null, problems: [] };
    if (!recipe || !recipe.steps || !recipe.steps.length) return res;
    var enc = Kit.runRecipe(recipe.plaintext, recipe.steps, 'encode');
    res.built = enc.output;
    if (enc.error) { res.ok = false; res.problems.push(enc.error); return res; }
    if (recipe.output != null && squash(enc.output) !== squash(recipe.output)) { res.ok = false; res.problems.push('The stored output does not match what the steps produce.'); }
    if (!enc.lossy) {
      var dec = Kit.runRecipe(enc.output, recipe.steps, 'decode');
      res.roundTrip = dec.output;
      if (dec.error || squash(dec.output) !== squash(recipe.plaintext)) { res.ok = false; res.problems.push('Decoding the output does not give the plaintext back.'); }
    }
    return res;
  };

  /* ---------- integrity checks ---------- */
  var SEV = { high: 0, med: 1, low: 2 };
  Kit.integrity = function () {
    var out = [];
    function add(sev, kind, text, ids) { out.push({ severity: sev, kind: kind, text: text, ids: (ids || []).filter(Boolean) }); }
    D.clues.forEach(function (c) {
      if (!(c.usedBy || []).length) add('med', 'Orphan clue', c.id + ' "' + c.text + '" is planted' + (c.plantedIn ? ' in ' + c.plantedIn : '') + ' but no puzzle uses it.', [c.id, c.plantedIn]);
      if (!c.plantedIn && (c.usedBy || []).length) {
        var built = c.usedBy.some(function (pid) { return Kit.statusIndex((Kit.get(pid) || {}).status) >= 2; });
        add(built ? 'high' : 'med', 'Unplanted clue', c.id + ' "' + c.text + '" is needed by ' + c.usedBy.join(', ') + ' but nothing carries it yet.', [c.id].concat(c.usedBy));
      }
    });
    var lastCh = Math.max.apply(null, D.chapters.map(function (c) { return +c.n || 0; }).concat([0]));
    D.puzzles.forEach(function (p) {
      var si = Kit.statusIndex(p.status), placed = !!Kit.chapter(p.chapter), cn = +((Kit.chapter(p.chapter) || {}).n) || 0;
      if (si >= 1 && (!p.solution || /^tbd\.?$/i.test(p.solution.trim()))) add('med', 'No solution', p.id + ' ' + p.title + ' is past Idea but has no solution written down.', [p.id]);
      if (si >= 2 && !(p.solvePath || []).length) add('med', 'No solve path', p.id + ' ' + p.title + ' is built but has no step-by-step solve path.', [p.id]);
      if (si >= 3) {
        var missing = D.designChecks.filter(function (dc) { return (p.checks || []).indexOf(dc.id) < 0; });
        if (missing.length) add('low', 'Design checks', p.id + ' ' + p.title + ' has not passed: ' + missing.map(function (m) { return m.label.toLowerCase(); }).join('; ') + '.', [p.id]);
      }
      if (p.recipe && p.recipe.steps && p.recipe.steps.length) {
        /* the crafter registers a stricter verifier (it also round-trips its lossy ops) */
        var rc = typeof Kit.verifyRecipe === 'function' ? Kit.verifyRecipe(p.recipe) : Kit.checkRecipe(p.recipe);
        if (!rc.ok) add('high', 'Recipe', p.id + ' ' + p.title + ': ' + rc.problems.join(' '), [p.id]);
      }
      (p.requires || []).forEach(function (r) {
        var rp = Kit.get(r);
        if (!rp) add('high', 'Broken link', p.id + ' requires ' + r + ', which does not exist.', [p.id]);
        else if (placed && (Kit.chapter(rp.chapter) || {}).n > cn) add('high', 'Order', p.id + ' requires ' + r + ' from a later chapter.', [p.id, r]);
      });
      (p.inputs || []).forEach(function (cid) {
        var c = Kit.get(cid);
        if (placed && c && c.plantedIn && Kit.type(c.plantedIn) === 'asset') { /* an unplaced puzzle is flagged as "No event" instead */
          var a = Kit.get(c.plantedIn), ach = (Kit.chapter(a.chapter) || {}).n;
          if (ach > cn) add('high', 'Clue too late', cid + ' lives in ' + a.id + ' (chapter ' + ach + ') but ' + p.id + ' needs it in chapter ' + cn + '.', [cid, a.id, p.id]);
        }
      });
      if (!p.final && !Kit.unlocks(p.id).length && cn !== lastCh && D.puzzles.length > 1) add('low', 'Dead end', p.id + ' ' + p.title + ' unlocks nothing. Mark it final or connect it.', [p.id]);
    });
    Kit.chapters().forEach(function (ch) {
      var ps = Kit.puzzlesIn(ch.id), counts = {};
      if (!ps.length) return;
      ps.forEach(function (p) { counts[p.kind] = (counts[p.kind] || 0) + 1; });
      Object.keys(counts).forEach(function (t) {
        if (counts[t] >= 2 && counts[t] / ps.length >= 0.5)
          add('low', 'Variety', 'Chapter ' + ch.n + ': ' + counts[t] + ' of ' + ps.length + ' puzzles are ' + t + '.', [ch.id].concat(ps.filter(function (p) { return p.kind === t; }).map(function (p) { return p.id; })));
      });
    });
    D.events.forEach(function (ev) {
      var hasPuzzles = D.puzzles.some(function (p) { return p.event === ev.id; });
      if (!ev.chapter) add('low', 'Not placed', ev.title + ' isn\'t in a chapter yet.', [ev.id]);
      else if (!hasPuzzles) add('low', 'Empty event', ev.title + ' has no puzzles yet.', [ev.id]);
      var verified = (ev.research || []).some(function (r) { return (Kit.get(r) || {}).status === 'verified'; });
      if (ev.layer !== 'fiction' && hasPuzzles && !verified) add('med', 'Needs a source', ev.title + ' sits on the ' + ((Kit.layer(ev.layer) || {}).label || ev.layer).toLowerCase() + ' layer but has no verified research behind it.', [ev.id].concat(ev.research || []));
    });
    D.puzzles.forEach(function (p) { if (!p.event) add('low', 'No event', p.id + ' ' + p.title + ' isn\'t inside an event.', [p.id]); });
    D.research.forEach(function (r) {
      var deps = (r.supports || []).filter(function (x) { return Kit.type(x) === 'puzzle'; });
      if (r.status !== 'verified' && deps.length) add('med', 'Unverified research', r.id + ' ' + r.title + ' is not verified, and ' + deps.join(', ') + ' depend' + (deps.length === 1 ? 's' : '') + ' on it.', [r.id].concat(deps));
    });
    D.assets.forEach(function (a) {
      if (a.renews) {
        var n = Kit.daysUntil(a.renews);
        if (n <= 45) add(n <= 30 ? 'high' : 'med', 'Renewal', a.name + ' renews ' + Kit.fmtDate(a.renews) + ' (' + Kit.relDays(a.renews) + '). It has to stay alive while the game is out.', [a.id]);
      }
    });
    out.sort(function (a, b) { return SEV[a.severity] - SEV[b.severity]; });
    return out;
  };
  Kit.problemsFor = function (id) { return Kit.integrity().filter(function (i) { return i.ids.indexOf(id) >= 0; }); };

  /* ---------- search ---------- */
  Kit.search = function (q, opts) {
    opts = opts || {};
    q = (q || '').trim().toLowerCase();
    var list = Kit.all().filter(function (e) { return !opts.types || opts.types.indexOf(e.type) >= 0; })
      .filter(function (e) { return !opts.exclude || opts.exclude.indexOf(e.id) < 0; });
    if (!q) return list.slice(0, opts.limit || 60);
    var terms = q.split(/\s+/);
    return list.map(function (e) {
      var hay = (e.id + ' ' + Kit.label(e.id) + ' ' + Kit.summary(e.id) + ' ' + (e.obj.body || '') + ' ' + (e.obj.notes || '') + ' ' + (e.obj.tags || []).join(' ')).toLowerCase();
      var score = 0;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i], at = hay.indexOf(t);
        if (at < 0) return null;
        score += at === 0 ? 0 : 1;
        if (e.id.toLowerCase() === t) score -= 5;
        var lbl = Kit.label(e.id).toLowerCase();
        if (lbl.indexOf(t) === 0) score -= 3; else if (lbl.indexOf(t) >= 0) score -= 2;
        if (['character', 'event', 'puzzle'].indexOf(e.type) >= 0) score -= 0.5;
      }
      return { e: e, score: score };
    }).filter(Boolean).sort(function (a, b) { return a.score - b.score; }).slice(0, opts.limit || 60).map(function (x) { return x.e; });
  };

  /* ============================================================
     LLM EXPORT / IMPORT
     ============================================================ */
  Kit.FORMAT = 'arg-desk/3';
  Kit.LLM_TASKS = [
    { id: '', label: 'No task (just the data)' },
    { id: 'critique', label: 'Critique this puzzle design', text: 'Critique the puzzle design below. Look for alternate solutions, leaps a player could not make from the trail alone, and anything that would not work on a phone. Be specific.' },
    { id: 'continuity', label: 'Find continuity problems', text: 'Find continuity problems: dates, ages, who knows what when, and contradictions between entries.' },
    { id: 'factcheck', label: 'Fact-check the record', text: 'Fact-check every claim on the "record" layer. List anything that is wrong, uncertain, or needs a primary source, and say what source would settle it.' },
    { id: 'variants', label: 'Suggest three variations', text: 'Suggest three distinct variations of this design. Return them as new entities in the same JSON format, with ids NEW-1, NEW-2, NEW-3.' },
    { id: 'extend', label: 'Extend the sequence', text: 'Propose the next puzzle in this sequence. Return it, and any clues it needs, as new entities in the same JSON format (ids NEW-1, NEW-2, …), and set "requires" to link it in.' },
    { id: 'prose', label: 'Write in-world text', text: 'Write the in-world text for these items in the voice of the character who owns them. Stay inside the reality-layer rules.' },
  ];
  Kit.LLM_INSTRUCTIONS = [
    'This is an export from a private planning tool for an alternate reality game (ARG) built on real history, unexplained events and pseudo-history.',
    'The game is published all at once for a small private group of players. Hints are rare.',
    'Structure: chapters contain events (puzzle.event, event.chapter, event.order), and events contain puzzles. Puzzles chain through "requires".',
    'Every entity has a unique "id" and a "type". Fields that hold ids link entities together; "referenced" names ids that are linked but not included.',
    'Reality layers: never present "fiction" or "pseudo" as "record". Characters with a "guard" are real people; always follow the guard.',
    'To propose changes, reply with JSON in this same format containing only the entities you change or add, inside "entities".',
    'Keep existing ids when editing. Include only the fields you change; an array you include replaces the old array.',
    'Give new entities ids like NEW-1, NEW-2 and use those ids when other entities refer to them. Always include "type" for new entities.',
  ];

  var SPOILER_FIELDS = {}; Object.keys(F).forEach(function (t) { SPOILER_FIELDS[t] = Object.keys(F[t]).filter(function (k) { return F[t][k].spoiler; }); });

  /* scope → ordered ids
     { kind: 'entity', ids:[…] } | { kind:'linked', ids:[…], depth:1 } | { kind:'sequence', from, to }
     { kind:'chapter', id } | { kind:'collection', type } | { kind:'game' } */
  Kit.resolveScope = function (scope) {
    scope = scope || { kind: 'game' };
    var ids = [];
    function addAll(list) { list.forEach(function (i) { if (Kit.has(i) && ids.indexOf(i) < 0) ids.push(i); }); }
    function withClues(pids) {
      var extra = [];
      pids.forEach(function (pid) {
        var p = Kit.get(pid); if (!p) return;
        (p.inputs || []).forEach(function (c) { extra.push(c); });
        D.clues.forEach(function (c) { if (c.plantedIn === pid) extra.push(c.id); });
      });
      return extra;
    }
    switch (scope.kind) {
      case 'entity': addAll(scope.ids || []); break;
      case 'linked':
        addAll(scope.ids || []);
        var frontier = (scope.ids || []).slice();
        for (var d = 0; d < (scope.depth || 1); d++) {
          var next = [];
          frontier.forEach(function (id) { Kit.related(id).forEach(function (r) { if (ids.indexOf(r) < 0) next.push(r); }); });
          addAll(next); frontier = next;
        }
        break;
      case 'sequence':
        var seq = Kit.sequence(scope.from, scope.to);
        addAll(seq); addAll(withClues(seq));
        break;
      case 'chapter':
        addAll([scope.id]);
        addAll(Kit.eventsIn(scope.id).map(function (x) { return x.id; }));
        var ps = Kit.puzzleOrder().filter(function (p) { return p.chapter === scope.id; }).map(function (p) { return p.id; });
        addAll(ps); addAll(withClues(ps));
        break;
      case 'event':
        addAll([scope.id]);
        var eps = Kit.puzzlesInEvent(scope.id).map(function (p) { return p.id; });
        addAll(eps); addAll(withClues(eps));
        break;
      case 'collection': addAll(Kit.list(scope.type).map(function (o) { return o.id; })); break;
      default: Object.keys(TYPES).forEach(function (t) { addAll(Kit.list(t).map(function (o) { return o.id; })); });
    }
    return ids;
  };
  Kit.scopeLabel = function (scope) {
    scope = scope || { kind: 'game' };
    switch (scope.kind) {
      case 'entity': return (scope.ids || []).length === 1 ? scope.ids[0] + ' · ' + Kit.label(scope.ids[0]) : (scope.ids || []).length + ' selected items';
      case 'linked': return (scope.ids || []).join(', ') + ' and everything linked to ' + ((scope.ids || []).length === 1 ? 'it' : 'them');
      case 'sequence': return 'Sequence ' + scope.from + ' → ' + scope.to;
      case 'chapter': var c = Kit.chapter(scope.id); return 'Chapter ' + (c ? c.n + ' · ' + c.title : scope.id);
      case 'event': return 'Event ' + scope.id + ' · ' + Kit.label(scope.id);
      case 'collection': return 'All ' + TYPES[scope.type].plural.toLowerCase();
      default: return 'Whole game';
    }
  };
  function serialize(id, opts) {
    var e = index.get(id); if (!e) return null;
    var out = { id: id, type: e.type };
    Object.keys(F[e.type]).forEach(function (k) {
      if (!(k in e.obj)) return;
      if (!opts.solutions && SPOILER_FIELDS[e.type].indexOf(k) >= 0) return;
      var v = e.obj[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      out[k] = clone(v);
    });
    return out;
  }
  /* opts: { solutions: true, guide: true, task: 'critique' | free text } */
  Kit.exportBundle = function (scope, opts) {
    opts = Object.assign({ solutions: true, guide: true, task: '' }, opts || {});
    var ids = Kit.resolveScope(scope);
    var entities = ids.map(function (id) { return serialize(id, opts); }).filter(Boolean);
    var inSet = new Set(ids), referenced = {};
    entities.forEach(function (en) {
      var s = new Set(); collectRefs(en, en.id, s);
      if (en.type === 'note') Kit.textRefs(en.body).forEach(function (r) { s.add(r); });
      s.forEach(function (r) { if (!inSet.has(r)) referenced[r] = Kit.typeName(r).toLowerCase() + ' · ' + Kit.label(r); });
    });
    var b = { format: Kit.FORMAT, exported: todayIso(), game: { title: D.game.title, tagline: D.game.tagline, premise: D.game.premise, format: D.game.format, players: D.game.players }, scope: { kind: (scope || {}).kind || 'game', label: Kit.scopeLabel(scope) } };
    var taskDef = Kit.LLM_TASKS.find(function (t) { return t.id === opts.task; });
    var taskText = taskDef ? taskDef.text : opts.task;
    if (taskText) b.task = taskText;
    if (!opts.solutions) b.spoilers = 'Solutions, solve paths, recipes and secrets were left out of this export.';
    if (opts.guide) {
      b.instructions = Kit.LLM_INSTRUCTIONS.slice();
      b.layers = {}; D.layers.forEach(function (l) { b.layers[l.id] = l.label + ': ' + l.desc; });
      var used = {}; entities.forEach(function (en) { used[en.type] = 1; });
      b.schema = {};
      Object.keys(used).forEach(function (t) {
        b.schema[t] = {};
        Object.keys(F[t]).forEach(function (k) {
          if (!opts.solutions && F[t][k].spoiler) return;
          var f = F[t][k];
          b.schema[t][k] = f.t + (f.values ? ' (' + f.values.join(' | ') + ')' : '') + (f.of ? ' → ' + f.of.join('|') : '') + ' — ' + f.d;
        });
      });
    }
    b.entities = entities;
    if (Object.keys(referenced).length) b.referenced = referenced;
    return b;
  };
  Kit.bundleToJSON = function (b) { return JSON.stringify(b, null, 2); };
  Kit.bundleToMarkdown = function (b) {
    var L = [];
    L.push('# ' + b.game.title + ' — ' + b.scope.label);
    L.push('');
    L.push('> ' + b.format + ' · exported ' + b.exported + ' · ' + b.entities.length + ' items');
    if (b.task) { L.push(''); L.push('## Task'); L.push(''); L.push(b.task); }
    if (b.instructions) {
      L.push(''); L.push('## How to read this'); L.push('');
      b.instructions.forEach(function (s) { L.push('- ' + s); });
      L.push(''); L.push('Reality layers:');
      Object.keys(b.layers).forEach(function (k) { L.push('- **' + k + '** — ' + b.layers[k]); });
    }
    if (b.spoilers) { L.push(''); L.push('_' + b.spoilers + '_'); }
    var groups = {};
    b.entities.forEach(function (en) { (groups[en.type] = groups[en.type] || []).push(en); });
    function refTxt(v) { return Kit.has(v) ? v + ' (' + Kit.label(v) + ')' : v; }
    Object.keys(groups).forEach(function (t) {
      L.push(''); L.push('## ' + TYPES[t].plural);
      groups[t].forEach(function (en) {
        L.push(''); L.push('### ' + en.id + ' · ' + (en.title || en.name || String(en.text || '').slice(0, 60)));
        var meta = [], blocks = [];
        Object.keys(en).forEach(function (k) {
          if (k === 'id' || k === 'type' || k === 'title' || k === 'name') return;
          var f = (F[t] || {})[k] || {}, v = en[k];
          if (f.t === 'longtext' || (f.t === 'text' && String(v).length > 80)) blocks.push('**' + k + '**\n\n' + v);
          else if (f.t === 'list' && k !== 'tags' && k !== 'checks') blocks.push('**' + k + '**\n\n' + v.map(function (x, i) { return (k === 'solvePath' ? (i + 1) + '. ' : '- ') + x; }).join('\n'));
          else if (f.t === 'object') blocks.push('**' + k + '**\n\n```json\n' + JSON.stringify(v, null, 2) + '\n```');
          else if (f.t === 'refs') meta.push(k + ': ' + v.map(refTxt).join(', '));
          else if (f.t === 'ref') meta.push(k + ': ' + refTxt(v));
          else meta.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
        });
        meta.forEach(function (m) { L.push('- ' + m); });
        blocks.forEach(function (bl) { L.push(''); L.push(bl); });
      });
    });
    if (b.referenced) {
      L.push(''); L.push('## Referenced but not included');
      Object.keys(b.referenced).forEach(function (k) { L.push('- ' + k + ' — ' + b.referenced[k]); });
    }
    return L.join('\n');
  };
  Kit.estimateTokens = function (s) { return Math.ceil(String(s || '').length / 4); };

  /* --- import --- */
  function lenientParse(text) {
    var t = String(text || '').trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    var start = t.search(/[\[{]/);
    if (start > 0) t = t.slice(start);
    var end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end >= 0) t = t.slice(0, end + 1);
    try { return { value: JSON.parse(t) }; } catch (e1) {
      try { return { value: JSON.parse(t.replace(/,\s*([}\]])/g, '$1')) }; } catch (e2) { return { error: e1.message }; }
    }
  }
  /* text → { entities:[raw…], task?, errors:[] } */
  Kit.importParse = function (text) {
    if (!String(text || '').trim()) return { entities: [], errors: ['Paste some JSON first.'] };
    var r = lenientParse(text);
    if (r.error) return { entities: [], errors: ['That isn\'t valid JSON: ' + r.error + '. If it came from an LLM, ask it to reply with only the JSON.'] };
    var v = r.value, list, game = v && !Array.isArray(v) && v.game && typeof v.game === 'object' ? v.game : null;
    if (Array.isArray(v)) list = v;
    else if (v && Array.isArray(v.entities)) list = v.entities;
    else if (v && typeof v === 'object' && (v.id || v.type)) list = [v];
    else return { entities: [], errors: ['Found JSON, but no "entities" list or entity in it.'] };
    return { entities: list.filter(function (x) { return x && typeof x === 'object'; }), errors: [], game: game };
  };
  function sameValue(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  function remapIds(val, map) {
    if (typeof val === 'string') return map[val] || val;
    if (Array.isArray(val)) return val.map(function (x) { return remapIds(x, map); });
    if (val && typeof val === 'object') { var o = {}; Object.keys(val).forEach(function (k) { o[k] = remapIds(val[k], map); }); return o; }
    return val;
  }
  /* raw entities → diff items:
     { op:'create'|'update'|'same'|'error', id, newId, type, label, changes:[{field,from,to}], warnings:[], patch } */
  Kit.importDiff = function (raw) {
    var items = [], map = {}, taken = new Set();
    /* pass 1: assign ids for new entities */
    raw.forEach(function (en) {
      var type = en.type || Kit.typeFromId(en.id);
      if (!TYPES[type]) return;
      var exists = en.id && Kit.has(en.id);
      if (!exists) {
        var preferred = en.id && Kit.typeFromId(en.id) === type && !taken.has(en.id) && !G.dead[en.id] ? en.id : null;
        var nid = preferred || Kit.nextId(type, en.name || en.title || en.text, taken);
        taken.add(nid);
        if (en.id) map[en.id] = nid;
        en.__newId = nid;
      }
    });
    var importIds = new Set(Object.keys(map).map(function (k) { return map[k]; }));
    raw.forEach(function (en0) {
      var type = en0.type || Kit.typeFromId(en0.id);
      var item = { op: 'error', id: en0.id || null, newId: null, type: type, label: en0.title || en0.name || en0.text || en0.id || '(untitled)', changes: [], warnings: [], patch: {} };
      if (!TYPES[type]) { item.warnings.push(en0.type ? 'Unknown type "' + en0.type + '".' : 'Missing "type", and the id doesn\'t say what it is.'); items.push(item); return; }
      if (en0.id && Kit.has(en0.id) && Kit.type(en0.id) !== type) { item.warnings.push(en0.id + ' already exists as a ' + Kit.typeName(en0.id).toLowerCase() + ', not a ' + type + '.'); items.push(item); return; }
      var en = remapIds(en0, map);
      var fields = F[type], patch = {};
      Object.keys(en).forEach(function (k) {
        if (k === 'id' || k === 'type' || k === '__newId') return;
        var f = fields[k];
        if (!f) { item.warnings.push('Ignored unknown field "' + k + '".'); return; }
        var v = en[k];
        if (f.t === 'enum' && v != null && f.values.indexOf(v) < 0) { item.warnings.push('"' + k + '" must be one of ' + f.values.join(', ') + '; got "' + v + '". Skipped.'); return; }
        if (f.t === 'number' && v != null && typeof v !== 'number') { if (isNaN(+v)) { item.warnings.push('"' + k + '" should be a number. Skipped.'); return; } v = +v; }
        if ((f.t === 'refs' || f.t === 'list') && v != null && !Array.isArray(v)) v = [v];
        if (f.t === 'refs' || f.t === 'ref') {
          asList(v).forEach(function (r) { if (!Kit.has(r) && !importIds.has(r)) item.warnings.push('"' + k + '" points at ' + r + ', which doesn\'t exist.'); });
        }
        patch[k] = v;
      });
      item.label = patch.title || patch.name || patch.text || (Kit.has(en0.id) ? Kit.label(en0.id) : item.label);
      if (en0.__newId) {
        item.op = 'create'; item.newId = en0.__newId; item.id = en0.id || null;
        Object.keys(patch).forEach(function (k) { item.changes.push({ field: k, from: undefined, to: patch[k] }); });
      } else {
        var cur = Kit.get(en0.id);
        Object.keys(patch).forEach(function (k) { if (!sameValue(cur[k], patch[k])) item.changes.push({ field: k, from: clone(cur[k]), to: patch[k] }); });
        item.op = item.changes.length ? 'update' : 'same';
        item.newId = en0.id;
      }
      item.patch = patch;
      items.push(item);
    });
    raw.forEach(function (en) { delete en.__newId; });
    return items;
  };
  /* apply chosen diff items; returns { created:[], updated:[], undo: snapshot } */
  Kit.importApply = function (items) {
    var snap = Kit.snapshot(), created = [], updated = [];
    Kit.batch(function () {
      items.forEach(function (it) {
        if (it.op === 'create') { var o = clone(it.patch); o.id = it.newId; created.push(Kit.create(it.type, o)); }
      });
      items.forEach(function (it) {
        if (it.op === 'update') { Kit.update(it.newId, clone(it.patch)); updated.push(it.newId); }
      });
    });
    return { created: created, updated: updated, undo: snap };
  };
  /* a worked example of what an LLM might send back (used by the Import panel's "Try an example") */
  Kit.sampleLLMReply = function () {
    return JSON.stringify({
      format: Kit.FORMAT,
      entities: [
        { id: 'P04', type: 'puzzle', solvePath: ['Date both clippings: 30 June and 3 July 1908.', 'Count the gap: three days.', 'Follow the arrow glyph: read the disc from the centre outward.', 'Shift each glyph\'s index by three to read digits 2-8-7.'],
          notes: 'Arrow glyph added to the centre of the disc so the reading direction is no longer ambiguous.' },
        { id: 'NEW-1', type: 'puzzle', title: 'The Bell of the Dei Gratia', event: 'E08', kind: 'audio', status: 'idea', difficulty: 'medium', estMin: 40,
          premise: 'A recording of a ship\'s bell, struck at uneven intervals.', mechanic: 'Long and short gaps between strikes spell a word in Morse code.',
          requires: ['P08'], inputs: ['NEW-2'] },
        { id: 'NEW-2', type: 'clue', text: 'bell_recording.wav', kind: 'audio', layer: 'fiction', usedBy: ['NEW-1'] },
      ],
    }, null, 2);
  };

  /* ---------- theme ----------
     Embedded in cade.txt the desk mirrors the host's data-theme and the toggle flips the host's theme.
     Standalone it keeps its own choice. */
  var THEME_KEY = 'argdesk-theme';
  var hostDoc = null;
  try { if (window.parent && window.parent !== window && window.parent.document) hostDoc = window.parent.document; } catch (e) { hostDoc = null; }
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  function fireTheme() { document.dispatchEvent(new CustomEvent('kit:theme')); }
  if (hostDoc) {
    applyTheme(hostDoc.documentElement.getAttribute('data-theme'));
    try {
      new window.parent.MutationObserver(function () {
        var t = hostDoc.documentElement.getAttribute('data-theme');
        if (t !== document.documentElement.getAttribute('data-theme')) { applyTheme(t); fireTheme(); }
      }).observe(hostDoc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { /* host observer unavailable */ }
  } else {
    try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* storage unavailable */ }
  }
  Kit.isDark = function () {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  Kit.toggleTheme = function () {
    if (hostDoc && window.parent.toggleTheme) { window.parent.toggleTheme(); return; }
    var next = Kit.isDark() ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
    fireTheme();
  };
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onMq = function () { if (!document.documentElement.getAttribute('data-theme')) fireTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  Kit.cssVar = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };

  Kit.ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    exportIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>',
    importIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  };

  /* ---------- Ctrl+K palette ---------- */
  var pal = { el: null, onPick: null, sel: 0, items: [], opts: null };
  Kit.palette = pal;
  function palBuild() {
    var ov = Kit.h('div', { class: 'picker-overlay', hidden: true, onmousedown: function (e) { if (e.target === ov) pal.close(); } });
    var input = Kit.h('input', { class: 'picker-search', id: 'kit-palette-q', placeholder: 'Jump to a puzzle, clue, character, source…', autocomplete: 'off', spellcheck: 'false' });
    var title = Kit.h('div', { class: 'picker-title', hidden: true });
    var list = Kit.h('div', { class: 'picker-list', role: 'listbox' });
    var dlg = Kit.h('div', { class: 'picker-dialog', role: 'dialog', 'aria-label': 'Jump to' },
      title,
      Kit.h('div', { class: 'picker-search-wrap', html: Kit.ICONS.search }, input),
      list,
      Kit.h('div', { class: 'picker-footer', html: '<span><span class="kbd">↑</span> <span class="kbd">↓</span> move</span><span><span class="kbd">↵</span> choose</span><span><span class="kbd">esc</span> close</span>' }));
    ov.appendChild(dlg);
    document.body.appendChild(ov);
    input.addEventListener('input', function () { pal.sel = 0; palRender(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { pal.sel = Math.min(pal.items.length - 1, pal.sel + 1); palRender(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { pal.sel = Math.max(0, pal.sel - 1); palRender(); e.preventDefault(); }
      else if (e.key === 'Enter') { var it = pal.items[pal.sel]; if (it) pal.choose(it.id); e.preventDefault(); }
      else if (e.key === 'Escape') { pal.close(); e.preventDefault(); /* the shell closes the desk on an unhandled Esc */ }
    });
    pal.el = ov; pal.input = input; pal.list = list; pal.titleEl = title;
  }
  function palRender() {
    var o = pal.opts || {};
    pal.items = Kit.search(pal.input.value, { limit: 40, types: o.types, exclude: o.exclude });
    var createRow = '';
    if (o.allowCreate && pal.input.value.trim() && o.types && o.types.length === 1) {
      createRow = '<div class="picker-item picker-create' + (pal.items.length === 0 ? ' selected' : '') + '" data-create="1" role="option"><span class="picker-item-icon">+</span><span class="picker-item-info"><span class="picker-item-name">Create ' + TYPES[o.types[0]].label.toLowerCase() + ' “' + Kit.esc(pal.input.value.trim()) + '”</span></span></div>';
    }
    if (!pal.items.length && !createRow) { pal.list.innerHTML = '<div class="picker-empty">Nothing matches. Try an id like P04 or a name.</div>'; return; }
    pal.list.innerHTML = pal.items.map(function (e, i) {
      var t = TYPES[e.type];
      return '<div class="picker-item' + (i === pal.sel ? ' selected' : '') + '" data-id="' + Kit.esc(e.id) + '" role="option">' +
        '<span class="picker-item-icon">' + t.icon + '</span>' +
        '<span class="picker-item-info"><span class="picker-item-name">' + Kit.esc(Kit.label(e.id)) + '</span>' +
        '<span class="picker-item-desc">' + Kit.esc(t.label + ' · ' + e.id + ' · ' + Kit.summary(e.id)) + '</span></span>' +
        (Kit.layerOf(e.id) ? Kit.layerBadge(Kit.layerOf(e.id), { short: true }) : '') + '</div>';
    }).join('') + createRow;
    var s = pal.list.querySelector('.selected'); if (s) s.scrollIntoView({ block: 'nearest' });
    Array.prototype.forEach.call(pal.list.querySelectorAll('.picker-item'), function (n) {
      n.addEventListener('click', function () {
        if (n.dataset.create) { var id = Kit.create(o.types[0], titleField(o.types[0], pal.input.value.trim())); pal.choose(id); }
        else pal.choose(n.dataset.id);
      });
    });
  }
  function titleField(type, text) {
    var o = {};
    if (F[type].title) o.title = text; else if (F[type].name) o.name = text; else o.text = text;
    return o;
  }
  /* open as the global jump palette */
  pal.open = function () { pal.opts = null; palShow('Jump to a puzzle, clue, character, source…', null); };
  pal.close = function () { if (pal.el) pal.el.hidden = true; pal.opts = null; };
  pal.choose = function (id) {
    var cb = pal.opts && pal.opts.onPick;
    pal.close();
    if (cb) cb(id);
    else if (pal.onPick) pal.onPick(id);
    else Kit.toast(Kit.typeName(id) + ' ' + id + ': ' + Kit.label(id));
  };
  function palShow(placeholder, title) {
    if (!pal.el) palBuild();
    pal.input.placeholder = placeholder;
    pal.titleEl.hidden = !title; pal.titleEl.textContent = title || '';
    pal.el.hidden = false; pal.input.value = ''; pal.sel = 0; palRender();
    setTimeout(function () { pal.input.focus(); }, 0);
  }
  /* Kit.pick({ title, types:['clue'], exclude:[…], allowCreate:true, onPick(id) }) — choose one entity */
  Kit.pick = function (opts) {
    opts = opts || {};
    var o = Object.assign({}, opts);
    palShow(opts.placeholder || 'Search ' + (opts.types ? opts.types.map(function (t) { return TYPES[t].plural.toLowerCase(); }).join(', ') : 'everything') + '…', opts.title || null);
    pal.opts = o; palRender();
  };
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal.el && !pal.el.hidden ? pal.close() : pal.open(); }
  });

  /* ---------- sheet: right drawer on desktop, full-height sheet on phone ----------
     var s = Kit.sheet({ title, width: 520, body: el|html, onClose, footer: el|html, id }); s.close(); s.body */
  var openSheets = [];
  Kit.sheet = function (opts) {
    opts = opts || {};
    var ov = Kit.h('div', { class: 'kit-sheet-overlay', id: opts.id || null });
    var closeBtn = Kit.h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: Kit.ICONS.close });
    var body = Kit.h('div', { class: 'kit-sheet-body scroll' });
    var panel = Kit.h('section', { class: 'kit-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Panel', style: { width: opts.width ? opts.width + 'px' : null } },
      Kit.h('header', { class: 'kit-sheet-head' }, Kit.h('h2', null, opts.title || ''), opts.headExtra || null, closeBtn),
      body);
    if (opts.footer) panel.appendChild(Kit.h('footer', { class: 'kit-sheet-foot' }, typeof opts.footer === 'string' ? Kit.h('div', { html: opts.footer }) : opts.footer));
    if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    var api = { el: panel, body: body, overlay: ov, close: close };
    function close() {
      if (!ov.parentNode) return;
      ov.remove();
      openSheets = openSheets.filter(function (s) { return s !== api; });
      if (opts.onClose) opts.onClose();
    }
    closeBtn.addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    openSheets.push(api);
    setTimeout(function () { var f = panel.querySelector('[autofocus], textarea, input, select, button:not(.icon-btn)'); if (f && !opts.noFocus) f.focus(); }, 30);
    return api;
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openSheets.length && (!pal.el || pal.el.hidden)) { openSheets[openSheets.length - 1].close(); e.preventDefault(); }
  });

  /* ---------- toast (optional action button) ---------- */
  var toastTimer;
  Kit.toast = function (msg, action) {
    var old = document.querySelector('.kit-toast'); if (old) old.remove();
    var t = Kit.h('div', { class: 'kit-toast', role: 'status' }, Kit.h('span', null, msg));
    if (action) t.appendChild(Kit.h('button', { type: 'button', class: 'kit-toast-act', onclick: function () { t.remove(); action.run(); } }, action.label));
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, action ? 6000 : 2600);
  };

  /* ---------- copy to clipboard with a select-text fallback ---------- */
  Kit.copy = function (text, fallbackEl) {
    function fallback() {
      if (fallbackEl) {
        if (fallbackEl.select) { fallbackEl.focus(); fallbackEl.select(); }
        else { var r = document.createRange(); r.selectNodeContents(fallbackEl); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      }
      Kit.toast('Couldn\'t copy automatically. The text is selected; copy it with your keyboard.');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { Kit.toast('Copied ' + Kit.estimateTokens(text).toLocaleString() + ' tokens of text'); return true; }, function () { fallback(); return false; });
      }
    } catch (e) { /* fall through */ }
    fallback();
    return Promise.resolve(false);
  };

  /* ---------- hover cards on [data-ref] ---------- */
  var hover = null;
  Kit.hoverCards = function (root) {
    root = root || document;
    root.addEventListener('mouseover', function (e) {
      if (e.pointerType === 'touch') return;
      var r = e.target.closest && e.target.closest('[data-ref]');
      if (!r || !root.contains(r)) return;
      showHover(r.getAttribute('data-ref'), r);
    });
    root.addEventListener('mouseout', function (e) {
      var r = e.target.closest && e.target.closest('[data-ref]');
      if (r && !r.contains(e.relatedTarget)) hideHover();
    });
    root.addEventListener('click', hideHover, true);
    root.addEventListener('touchstart', hideHover, { passive: true, capture: true });
  };
  function showHover(id, anchor) {
    if (!Kit.get(id)) return;
    hideHover();
    var lay = Kit.layerOf(id);
    hover = Kit.h('div', { class: 'kit-hover', role: 'tooltip',
      html: '<div class="kh-top"><span class="eyebrow">' + Kit.esc(Kit.typeName(id)) + '</span><span class="id">' + Kit.esc(id) + '</span>' + (lay ? Kit.layerBadge(lay) : '') + '</div>' +
        '<div class="kh-name">' + Kit.esc(Kit.label(id)) + '</div><div class="kh-body">' + Kit.esc(Kit.summary(id)) + '</div>' });
    document.body.appendChild(hover);
    var b = anchor.getBoundingClientRect(), hb = hover.getBoundingClientRect();
    var top = b.bottom + 6, left = Math.min(Math.max(8, b.left), window.innerWidth - hb.width - 8);
    if (top + hb.height > window.innerHeight - 8) top = b.top - hb.height - 6;
    hover.style.top = top + 'px'; hover.style.left = left + 'px';
  }
  function hideHover() { if (hover) { hover.remove(); hover = null; } }

  /* ---------- spoilers ---------- */
  document.addEventListener('click', function (e) {
    var s = e.target.closest && e.target.closest('.spoiler');
    if (s) s.classList.add('shown');
  });

  window.Kit = Kit;
})();
