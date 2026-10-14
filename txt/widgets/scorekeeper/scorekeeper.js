/* Score Keeper — scores for card and board games, one tile per player.
 *
 * 1–8 players as tiles that fill the panel (2 = halves, 3–4 = quadrants,
 * 5–6 = 2×3, 7–8 = 2×4, turned to 3×2 / 4×2 when the panel is wider than
 * tall), each with a name (tap it to edit), a colour from the app's syntax
 * accents and an optional 180° turn so people around a table read their own.
 * Tap the upper half of a tile (the ＋) to add the step, the lower half (the
 * －) to take it away; hold to use the big step, repeating. A small "+5"
 * floats by the score and keeps adding up for 1.5 s — that burst is one
 * action, so one Undo takes it back. Count up from 0 or down from a start
 * value (20, 40, 501 …); the leader (highest or lowest — your choice) is
 * marked, and in a count-down game anyone at or below 0. Optional rounds
 * counter, a history with undo, "new game with the same players" (undoable
 * too), reset, full screen for the table, and "insert the scores into the
 * note" as a small markdown table at the cursor (one editor transaction, so
 * one Undo in the editor removes it).
 *
 * State: the game (players, scores, settings, history) is written through to
 * Cade.store ('cade-scorekeeper-game') on every change, so it survives reloads;
 * per-device prefs ('cade-scorekeeper-prefs': full screen). The DOM-free model
 * below is exported for node: scorekeeper.test.js.
 *
 * Cost: nothing runs until the panel opens and nothing runs while it waits —
 * no loop; the only timers are a held button's repeat, the floating deltas'
 * 1.5 s fade and the "tap again" confirmations, all cleared on close with the
 * one ResizeObserver (it re-flows the tiles when the panel turns). Self-
 * contained IIFE, ES5.
 */
(function () {
  'use strict';

  // ======================================================================
  // Pure model (no DOM)
  // ======================================================================
  var Model = (function () {
    var MAX_PLAYERS = 8, MAX_ABS = 1e9, MAX_STEP = 1e6, MAX_HIST = 300, MERGE_MS = 1500, NAME_MAX = 24, NCOLORS = 8;

    function r6(x) { return Math.round(x * 1e6) / 1e6; }
    function num(x, d) {
      if (typeof x === 'string' && x.trim() !== '') x = +x;
      return typeof x === 'number' && isFinite(x) ? x : d;
    }
    function int(x, lo, hi, d) { x = num(x, NaN); return isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d; }
    function score(x) {
      x = r6(Math.max(-MAX_ABS, Math.min(MAX_ABS, x)));
      return x === 0 ? 0 : x; // no -0
    }
    function stepVal(x, d) {
      x = num(x, NaN);
      x = isFinite(x) ? r6(Math.abs(x)) : NaN;
      return x > 0 && x <= MAX_STEP ? x : d;
    }
    function cleanName(s) {
      return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    }
    function startScore(g) { return g.mode === 'down' ? g.start : 0; }
    function freeColor(players) {
      var used = {};
      players.forEach(function (p) { used[p.color] = 1; });
      for (var c = 0; c < NCOLORS; c++) if (!used[c]) return c;
      return players.length % NCOLORS;
    }
    function freeId(players) {
      var n = 1;
      while (players.some(function (p) { return p.id === 'p' + n; })) n++;
      return 'p' + n;
    }
    function indexOf(g, id) {
      for (var i = 0; i < g.players.length; i++) if (g.players[i].id === id) return i;
      return -1;
    }
    function displayName(g, i) { return g.players[i].name || 'Player ' + (i + 1); }

    function addPlayer(g) {
      if (g.players.length >= MAX_PLAYERS) return null;
      var p = { id: freeId(g.players), name: '', color: freeColor(g.players), rot: 0, score: startScore(g) };
      g.players.push(p);
      return p;
    }
    function create() {
      var g = { v: 1, mode: 'up', start: 20, step: 1, big: 5, high: true, rounds: false, round: 1, players: [], hist: [] };
      addPlayer(g); addPlayer(g);
      return g;
    }
    function push(g, e) {
      g.hist.push(e);
      if (g.hist.length > MAX_HIST) g.hist.splice(0, g.hist.length - MAX_HIST);
    }
    // Add `delta` to player i. Changes to the same player less than MERGE_MS apart are ONE
    // action (the floating "+N" burst): one history entry, one undo. → the change applied.
    function add(g, i, delta, now) {
      var p = g.players[i];
      delta = num(delta, 0);
      if (!p || !delta) return 0;
      var before = p.score;
      p.score = score(before + delta);
      var d = r6(p.score - before);
      if (!d) return 0;
      var last = g.hist[g.hist.length - 1];
      if (last && last.k === 's' && last.id === p.id && now - last.t >= 0 && now - last.t < MERGE_MS) {
        last.d = r6(last.d + d);
        last.t = now;
        if (!last.d) g.hist.pop();
      } else push(g, { k: 's', id: p.id, d: d, t: now });
      return d;
    }
    function nextRound(g, now) {
      if (g.round >= 1e6) return false;
      g.round++;
      push(g, { k: 'r', t: now });
      return true;
    }
    function pristine(g) {
      var s = startScore(g);
      return g.round === 1 && g.players.every(function (p) { return p.score === s; });
    }
    // A new game with the same players (optionally switching the count mode / start value).
    // Undoable: the previous scores, round and mode go into the history. → false if nothing to clear.
    function newGame(g, now, mode, start) {
      var nm = mode === 'up' || mode === 'down' ? mode : g.mode;
      var ns = start == null ? g.start : score(num(start, g.start));
      if (pristine(g)) {
        g.mode = nm; g.start = ns;
        var s0 = startScore(g);
        g.players.forEach(function (p) { p.score = s0; });
        return false;
      }
      var prev = { s: {}, round: g.round, mode: g.mode, start: g.start };
      g.players.forEach(function (p) { prev.s[p.id] = p.score; });
      push(g, { k: 'n', t: now, prev: prev });
      g.mode = nm; g.start = ns; g.round = 1;
      var s = startScore(g);
      g.players.forEach(function (p) { p.score = s; });
      return true;
    }
    function undo(g) {
      var e = g.hist.pop();
      if (!e) return null;
      if (e.k === 's') {
        var i = indexOf(g, e.id);
        if (i >= 0) g.players[i].score = score(g.players[i].score - e.d);
      } else if (e.k === 'r') g.round = Math.max(1, g.round - 1);
      else if (e.k === 'n') {
        g.mode = e.prev.mode; g.start = e.prev.start; g.round = e.prev.round;
        g.players.forEach(function (p) { if (Object.prototype.hasOwnProperty.call(e.prev.s, p.id)) p.score = e.prev.s[p.id]; });
      }
      return e;
    }
    function removePlayer(g, i) {
      if (g.players.length <= 1) return null;
      if (i == null) i = g.players.length - 1;
      var p = g.players.splice(i, 1)[0];
      if (!p) return null;
      g.hist = g.hist.filter(function (e) { return !(e.k === 's' && e.id === p.id); });
      return p;
    }
    // Back to two fresh players; the scoring settings stay.
    function reset(g) {
      g.players = []; g.hist = []; g.round = 1;
      addPlayer(g); addPlayer(g);
    }
    function rename(g, i, name) {
      var n = cleanName(name);
      g.players[i].name = n === 'Player ' + (i + 1) ? '' : n;
    }
    // Leader(s): best score in a count-up game (none while everyone is level).
    function leaders(g) {
      if (g.mode !== 'up' || g.players.length < 2) return [];
      var best = null;
      g.players.forEach(function (p) { if (best === null || (g.high ? p.score > best : p.score < best)) best = p.score; });
      var out = [];
      g.players.forEach(function (p, i) { if (p.score === best) out.push(i); });
      return out.length === g.players.length ? [] : out;
    }
    // Count-down game: everyone at or below 0.
    function outs(g) {
      var out = [];
      if (g.mode === 'down') g.players.forEach(function (p, i) { if (p.score <= 0) out.push(i); });
      return out;
    }
    // Up to 3 decimals, no exponent, ASCII minus.
    function fmt(x) {
      x = score(num(x, 0));
      var s = String(Math.round(x * 1000) / 1000);
      return s === '-0' ? '0' : s;
    }
    // Standings (best first; ties share a rank: 1, 2, 2, 4) as a small markdown table.
    function markdown(g) {
      var order = g.players.map(function (p, i) { return i; });
      order.sort(function (a, b) {
        var d = g.players[b].score - g.players[a].score;
        return (g.high ? d : -d) || a - b;
      });
      var rows = [], rank = 0, prev = null;
      order.forEach(function (i, k) {
        var s = g.players[i].score;
        if (k === 0 || s !== prev) rank = k + 1;
        prev = s;
        rows.push([String(rank), displayName(g, i).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'), fmt(s)]);
      });
      var head = ['#', 'Player', g.rounds ? 'Score (round ' + g.round + ')' : 'Score'];
      var w = [0, 1, 2].map(function (c) {
        return rows.reduce(function (m, r) { return Math.max(m, r[c].length); }, Math.max(3, head[c].length));
      });
      function pad(s, n, left) { while (s.length < n) s = left ? s + ' ' : ' ' + s; return s; }
      function dash(n) { return new Array(n + 1).join('-'); }
      function line(cells) { return '| ' + cells.map(function (c, j) { return pad(c, w[j], j === 1); }).join(' | ') + ' |'; }
      var sep = '|' + w.map(function (n, j) { return j === 1 ? ':' + dash(n + 1) : dash(n + 1) + ':'; }).join('|') + '|';
      return [line(head), sep].concat(rows.map(line)).join('\n');
    }
    // Tiles per row for n players: 2 = halves, 3–4 = quadrants, 5–6 = 2×3, 7–8 = 2×4
    // (columns × rows swapped when the area is wider than tall). Last row may be short.
    function layout(n, landscape) {
      n = Math.max(1, Math.min(MAX_PLAYERS, n | 0));
      var cols = n === 1 ? 1 : n === 2 ? (landscape ? 2 : 1) : n <= 4 ? 2 : n <= 6 ? (landscape ? 3 : 2) : (landscape ? 4 : 2);
      var rows = [];
      for (var left = n; left > 0; left -= cols) rows.push(Math.min(cols, left));
      return rows;
    }
    // Anything (a stored copy from an older version, a hand-edited value, junk) → a valid game.
    function normalize(raw) {
      var g = create();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return g;
      g.mode = raw.mode === 'down' ? 'down' : 'up';
      g.start = score(num(raw.start, 20));
      g.step = stepVal(raw.step, 1);
      g.big = stepVal(raw.big, 5);
      g.high = raw.high !== false;
      g.rounds = raw.rounds === true;
      g.round = int(raw.round, 1, 1e6, 1);
      if (Array.isArray(raw.players)) {
        var ps = [];
        raw.players.forEach(function (r) {
          if (!r || typeof r !== 'object' || ps.length >= MAX_PLAYERS) return;
          var id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(r.id) && !ps.some(function (q) { return q.id === r.id; }) ? r.id : null;
          var c = int(r.color, 0, NCOLORS - 1, -1);
          var p = { id: id, name: cleanName(r.name), color: c, rot: r.rot === 180 ? 180 : 0, score: score(num(r.score, startScore(g))) };
          if (!id) p.id = freeId(ps.concat([]));
          if (c < 0) p.color = freeColor(ps);
          ps.push(p);
        });
        if (ps.length) g.players = ps;
      }
      if (Array.isArray(raw.hist)) {
        var ids = {};
        g.players.forEach(function (p) { ids[p.id] = 1; });
        g.hist = raw.hist.filter(function (e) {
          if (!e || typeof e !== 'object' || !isFinite(+e.t)) return false;
          if (e.k === 's') return ids[e.id] === 1 && typeof e.d === 'number' && isFinite(e.d) && e.d !== 0 && Math.abs(e.d) <= 2 * MAX_ABS;
          if (e.k === 'r') return true;
          if (e.k === 'n') {
            var pv = e.prev;
            return !!pv && typeof pv === 'object' && !!pv.s && typeof pv.s === 'object' && (pv.mode === 'up' || pv.mode === 'down') &&
              isFinite(+pv.start) && isFinite(+pv.round);
          }
          return false;
        }).slice(-MAX_HIST).map(function (e) {
          if (e.k === 's') return { k: 's', id: e.id, d: r6(e.d), t: +e.t };
          if (e.k === 'r') return { k: 'r', t: +e.t };
          var s = {};
          Object.keys(e.prev.s).forEach(function (id) { var v = num(e.prev.s[id], NaN); if (ids[id] === 1 && isFinite(v)) s[id] = score(v); });
          return { k: 'n', t: +e.t, prev: { s: s, round: int(e.prev.round, 1, 1e6, 1), mode: e.prev.mode, start: score(+e.prev.start) } };
        });
      }
      return g;
    }

    return {
      MAX_PLAYERS: MAX_PLAYERS, MERGE_MS: MERGE_MS, NAME_MAX: NAME_MAX, NCOLORS: NCOLORS, MAX_HIST: MAX_HIST,
      create: create, normalize: normalize, addPlayer: addPlayer, removePlayer: removePlayer, reset: reset, rename: rename,
      add: add, nextRound: nextRound, newGame: newGame, undo: undo, pristine: pristine, startScore: startScore,
      leaders: leaders, outs: outs, fmt: fmt, markdown: markdown, layout: layout, indexOf: indexOf, displayName: displayName,
      stepVal: stepVal, cleanName: cleanName,
    };
  })();

  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ======================================================================
  // Panel
  // ======================================================================
  var Cade = window.Cade;
  Cade.loadCSS('scorekeeper.css');

  var PANEL_ID = 'scorekeeper-panel';
  var GAME_KEY = 'cade-scorekeeper-game';
  var PREFS_KEY = 'cade-scorekeeper-prefs';
  var LONG_MS = 450, REPEAT_MS = 380, ARM_MS = 3000;
  // Theme-friendly accents — the editor's syntax colours, plus the core's workspace orange
  // and muted grey (all tuned for light and dark by the core). No red: red marks "at / below 0".
  var PALETTE = ['--tok-fn', '--tok-tag', '--tok-str', '--tok-num', '--tok-kw', '--tok-bui', '--ws-orange-fg', '--text-muted'];
  var COLOR_NAMES = ['Blue', 'Pink', 'Green', 'Amber', 'Violet', 'Teal', 'Orange', 'Grey'];

  var I = function (d) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  };
  var ICON = {
    undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    hist: I('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    table: I('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>'),
    newg: I('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V9h-4.5"/>'),
    gear: I('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    rot: I('<path d="M3.5 12h2.5M10.75 12h2.5M18 12h2.5"/><path d="M7 9l5-5.5L17 9z"/><path d="M7 15l5 5.5 5-5.5z"/>'), // flip upside down
    fs: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    fsExit: I('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m, t, ms) { try { Cade.showToast(m, t || 'info', ms || 1800); } catch (e) {} }
  function coarse() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  function disp(x) { return Model.fmt(x).replace('-', '−'); }         // a real minus on the tiles
  function signed(x) { return (x > 0 ? '+' : x < 0 ? '−' : '±') + Model.fmt(Math.abs(x)); }

  var g = null;        // the game (loaded on open)
  var ui = null;       // { panel, root, grid, bar, sheet, tiles: {id: {el, name, score, delta}}, holds, float, armed, editing, sheetKind, ro, land, fs }

  function load() {
    var raw = null;
    try { raw = JSON.parse(Cade.store.get(GAME_KEY) || 'null'); } catch (e) { raw = null; }
    g = Model.normalize(raw);
  }
  // Written through on every change: a few KB at most, and a phone may drop the page any time.
  function save() { try { Cade.store.set(GAME_KEY, JSON.stringify(g)); } catch (e) {} }
  function loadFs() {
    try { var p = JSON.parse(Cade.store.get(PREFS_KEY) || 'null'); if (p && typeof p.fs === 'boolean') return p.fs; } catch (e) {}
    return null;
  }
  function saveFs(on) { try { Cade.store.set(PREFS_KEY, JSON.stringify({ fs: !!on })); } catch (e) {} }

  // ======================================================================
  // Open / close
  // ======================================================================
  function bodyHtml() {
    return '<div class="sk" tabindex="-1">' +
      '<div class="sk-main"><div class="sk-grid"></div><div class="sk-sheet" hidden></div></div>' +
      '<div class="sk-bar" role="toolbar" aria-label="Score Keeper">' +
        '<button type="button" class="sk-b" data-act="undo" title="Undo the last change" aria-label="Undo">' + ICON.undo + '</button>' +
        '<button type="button" class="sk-b sk-round" data-act="round" title="Next round" hidden></button>' +
        '<span class="sk-sp"></span>' +
        '<button type="button" class="sk-b" data-act="hist" title="History" aria-label="History">' + ICON.hist + '</button>' +
        '<button type="button" class="sk-b" data-act="insert" title="Insert the scores into the note (a markdown table)" aria-label="Insert into the note">' + ICON.table + '</button>' +
        '<button type="button" class="sk-b" data-act="new" title="New game — same players (tap twice)" aria-label="New game">' + ICON.newg + '</button>' +
        '<button type="button" class="sk-b" data-act="settings" title="Players & scoring" aria-label="Players and scoring">' + ICON.gear + '</button>' +
      '</div>' +
    '</div>';
  }
  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { close(); return; }
    load();
    var p = Cade.mkPanel(PANEL_ID, '🏆 Score Keeper', bodyHtml());
    var q = function (s) { return p.querySelector(s); };
    var hb = document.createElement('button');
    hb.type = 'button';
    hb.className = 'sk-hbtn';
    hb.setAttribute('data-act', 'fs');
    var head = q('.cade-panel-head');
    if (head) head.insertBefore(hb, q('.cade-panel-minbtn') || q('.cade-panel-x'));
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // a control, not a drag handle

    ui = {
      panel: p, root: q('.sk'), grid: q('.sk-grid'), bar: q('.sk-bar'), sheet: q('.sk-sheet'), hbtn: hb,
      tiles: {}, holds: {}, float: {}, armed: null, editing: null, sheetKind: '', ro: null, land: null, fs: false,
    };
    var grid = ui.grid;
    grid.addEventListener('pointerdown', onGridDown);
    grid.addEventListener('pointerup', onGridUp);
    grid.addEventListener('pointercancel', onGridUp);
    grid.addEventListener('lostpointercapture', onGridUp);
    grid.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    p.addEventListener('pointerdown', onPanelDown, true);
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('change', onChange);
    p.addEventListener('keydown', onPanelKey);
    p.addEventListener('cade-panel-minimize', onMin);
    p.addEventListener('cade-panel-restore', onRestore);
    p._onClose = teardown;
    if (typeof ResizeObserver === 'function') {
      ui.ro = new ResizeObserver(function () { flow(false); });
      ui.ro.observe(grid);
    }
    var fs = loadFs();
    setFs(fs == null ? window.innerWidth < 600 && coarse() : fs);
    build();
  }
  function teardown() {
    if (!ui) return;
    var u = ui;
    ui = null;
    if (u.ro) u.ro.disconnect();
    Object.keys(u.holds).forEach(function (k) { clearTimeout(u.holds[k].t); });
    Object.keys(u.float).forEach(function (k) { clearTimeout(u.float[k].t); });
    if (u.armed) clearTimeout(u.armed.t);
    if (u.editing) { var ed = u.editing; u.editing = null; commitName(ed); }
    g = null; // saved already; reloaded on the next open
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    teardown();
  }
  function alive() {
    if (!ui) return false;
    if (!ui.panel.isConnected) { teardown(); return false; }
    return true;
  }
  function setFs(on) {
    ui.fs = !!on;
    ui.panel.classList.toggle('sk-fs', ui.fs);
    var t = ui.fs ? 'Exit full screen' : 'Full screen';
    ui.hbtn.innerHTML = ui.fs ? ICON.fsExit : ICON.fs;
    ui.hbtn.title = t; ui.hbtn.setAttribute('aria-label', t);
  }

  // ======================================================================
  // Tiles
  // ======================================================================
  function tileHtml() {
    return '<div class="sk-face">' +
      '<div class="sk-zone sk-plus" data-z="1"></div>' +
      '<div class="sk-zone sk-minus" data-z="-1"></div>' +
      '<div class="sk-top"><button type="button" class="sk-name" data-act="name" title="Rename"></button>' +
        '<span class="sk-star" aria-hidden="true">★</span><span class="sk-tsp"></span>' +
        '<button type="button" class="sk-rot" data-act="rot" title="Turn this tile around" aria-label="Turn this tile around">' + ICON.rot + '</button></div>' +
      '<div class="sk-mid"><span class="sk-glyph" aria-hidden="true">+</span>' +
        '<span class="sk-sw"><span class="sk-score"></span><span class="sk-delta" aria-hidden="true"></span></span>' +
        '<span class="sk-glyph" aria-hidden="true">−</span></div>' +
    '</div>';
  }
  // (Re)build every tile — on open and when players are added / removed / reset.
  function build() {
    if (ui.editing) finishEdit(true);
    Object.keys(ui.float).forEach(function (k) { clearTimeout(ui.float[k].t); });
    ui.float = {};
    ui.tiles = {};
    ui.grid.textContent = '';
    g.players.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'sk-tile';
      el.setAttribute('data-id', p.id);
      el.innerHTML = tileHtml();
      ui.tiles[p.id] = { el: el, name: el.querySelector('.sk-name'), score: el.querySelector('.sk-score'), delta: el.querySelector('.sk-delta') };
    });
    ui.land = null;
    flow(true);
    paintAll();
  }
  // Group the tiles into rows for the current shape of the grid.
  function flow(force) {
    if (!ui) return;
    var w = ui.grid.clientWidth, h = ui.grid.clientHeight;
    if (!force && (!w || !h)) return;                 // minimized / not laid out yet
    var land = w > h * 1.15;
    if (!force && land === ui.land) return;
    ui.land = land;
    var rows = Model.layout(g.players.length, land), k = 0, frag = document.createDocumentFragment();
    rows.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'sk-row';
      for (var j = 0; j < n; j++, k++) row.appendChild(ui.tiles[g.players[k].id].el);
      frag.appendChild(row);
    });
    ui.grid.textContent = '';
    ui.grid.appendChild(frag);
    ui.grid.setAttribute('data-n', String(g.players.length));
  }
  function paintTile(i) {
    var p = g.players[i], t = ui.tiles[p.id];
    if (!t) return;
    t.el.style.setProperty('--sk-c', 'var(' + PALETTE[p.color] + ')');
    t.el.classList.toggle('rot', p.rot === 180);
    if (!(ui.editing && ui.editing.id === p.id)) t.name.textContent = Model.displayName(g, i);
    t.name.classList.toggle('dflt', !p.name);
    var s = disp(p.score);
    t.score.textContent = s;
    t.score.setAttribute('data-len', String(Math.max(2, Math.min(7, s.length))));
    t.el.setAttribute('aria-label', Model.displayName(g, i) + ': ' + s + '. Tap the top half to add, the bottom half to subtract; hold for the big step.');
  }
  function paintMarks() {
    var lead = Model.leaders(g), out = Model.outs(g);
    g.players.forEach(function (p, i) {
      var t = ui.tiles[p.id];
      if (!t) return;
      t.el.classList.toggle('lead', lead.indexOf(i) >= 0);
      t.el.classList.toggle('out', out.indexOf(i) >= 0);
    });
  }
  function paintBar() {
    var b = ui.bar;
    b.querySelector('[data-act="undo"]').disabled = !g.hist.length;
    var r = b.querySelector('[data-act="round"]');
    r.hidden = !g.rounds;
    r.textContent = 'Round ' + g.round + ' +';
    var nb = b.querySelector('[data-act="new"]');
    if (!(ui.armed && ui.armed.btn === nb)) nb.disabled = Model.pristine(g);
  }
  function paintAll() {
    g.players.forEach(function (p, i) { paintTile(i); });
    paintMarks();
    paintBar();
    if (ui.sheetKind) renderSheet();
  }

  // ---- scoring ----
  function bump(id, delta) {
    var i = Model.indexOf(g, id);
    if (i < 0) return;
    var d = Model.add(g, i, delta, Date.now());
    if (!d) return;
    save();
    paintTile(i);
    paintMarks();
    paintBar();
    floatDelta(id, d);
    if (ui.sheetKind === 'hist') renderSheet();
  }
  // The "+5" by the score: it keeps adding up until 1.5 s pass without a change, then fades.
  function floatDelta(id, d) {
    var t = ui.tiles[id];
    if (!t) return;
    var f = ui.float[id] || (ui.float[id] = { sum: 0, t: 0 });
    f.sum = Math.round((f.sum + d) * 1e6) / 1e6;
    t.delta.textContent = signed(f.sum);
    t.delta.classList.toggle('neg', f.sum < 0);
    t.delta.classList.remove('fade');
    t.delta.classList.add('show');
    clearTimeout(f.t);
    f.t = setTimeout(function () {
      f.sum = 0; f.t = 0;
      t.delta.classList.remove('show');
      t.delta.classList.add('fade');
    }, Model.MERGE_MS);
  }

  // ---- taps & holds on a tile half ----
  function onGridDown(e) {
    if (!alive() || e.button > 0) return;
    var z = e.target.closest ? e.target.closest('.sk-zone') : null;
    if (!z) return;
    var tile = z.closest('.sk-tile');
    if (!tile) return;
    if (ui.editing) finishEdit(true); // iOS keeps an input focused when a plain div is tapped
    var pid = e.pointerId, h ={ id: tile.getAttribute('data-id'), sign: +z.getAttribute('data-z'), zone: z, long: false, t: 0 };
    if (ui.holds[pid]) clearTimeout(ui.holds[pid].t);
    ui.holds[pid] = h;
    z.classList.add('down');
    try { z.setPointerCapture(pid); } catch (er) {}
    h.t = setTimeout(function () { holdFire(pid); }, LONG_MS);
  }
  function holdFire(pid) {
    var h = ui && ui.holds[pid];
    if (!h) return;
    if (!alive() || (Cade.isMinimized && Cade.isMinimized(ui.panel))) { endHold(pid); return; }
    if (!h.long) { try { Cade.haptic(10); } catch (e) {} }
    h.long = true;
    bump(h.id, h.sign * g.big);
    h.t = setTimeout(function () { holdFire(pid); }, REPEAT_MS);
  }
  function endHold(pid) {
    var h = ui && ui.holds[pid];
    if (!h) return null;
    delete ui.holds[pid];
    clearTimeout(h.t);
    h.zone.classList.remove('down');
    return h;
  }
  function onGridUp(e) {
    if (!ui) return;
    var h = endHold(e.pointerId);
    if (h && e.type === 'pointerup' && !h.long && alive()) {
      bump(h.id, h.sign * g.step);
      try { Cade.haptic(6); } catch (er) {}
    }
  }

  // ---- names ----
  function startEdit(id) {
    if (ui.editing) finishEdit(true);
    var i = Model.indexOf(g, id), t = ui.tiles[id];
    if (i < 0 || !t) return;
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'sk-name-in';
    inp.maxLength = Model.NAME_MAX;
    inp.value = g.players[i].name;
    inp.placeholder = 'Player ' + (i + 1);
    inp.setAttribute('aria-label', 'Name');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('enterkeyhint', 'done');
    inp.spellcheck = false;
    t.name.hidden = true;
    t.name.parentNode.insertBefore(inp, t.name);
    ui.editing = { id: id, inp: inp, btn: t.name };
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
    inp.addEventListener('blur', function () { if (ui && ui.editing && ui.editing.inp === inp) finishEdit(true); });
    try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    inp.select();
  }
  function commitName(ed) {
    var i = Model.indexOf(g, ed.id);
    if (i < 0) return -1;
    Model.rename(g, i, ed.inp.value);
    save();
    return i;
  }
  function finishEdit(ok) {
    var ed = ui && ui.editing;
    if (!ed) return;
    ui.editing = null;
    var i = ok ? commitName(ed) : Model.indexOf(g, ed.id);
    ed.btn.hidden = false;
    ed.inp.remove();
    if (i >= 0) { paintTile(i); if (ui.sheetKind) renderSheet(); }
  }

  // ======================================================================
  // Controls
  // ======================================================================
  function arm(key, btn, label, fn) {
    var a = ui.armed;
    if (a && a.key === key && a.btn === btn) { disarm(); fn(); return; }
    disarm();
    ui.armed = { key: key, btn: btn, html: btn.innerHTML, t: setTimeout(disarm, ARM_MS) };
    btn.classList.add('armed');
    btn.textContent = label;
  }
  function disarm() {
    var a = ui && ui.armed;
    if (!a) return;
    clearTimeout(a.t);
    ui.armed = null;
    if (a.btn.isConnected) { a.btn.classList.remove('armed'); a.btn.innerHTML = a.html; }
  }
  function doUndo() {
    var e = Model.undo(g);
    if (!e) return;
    save();
    if (e.k === 's') {
      var i = Model.indexOf(g, e.id);
      if (i >= 0) toast('Undone: ' + Model.displayName(g, i) + ' ' + signed(e.d), 'info', 1400);
      if (ui.float[e.id]) { clearTimeout(ui.float[e.id].t); ui.float[e.id].sum = 0; var t = ui.tiles[e.id]; if (t) t.delta.classList.remove('show'); }
    } else if (e.k === 'r') toast('Back to round ' + g.round, 'info', 1400);
    else toast('Scores restored', 'info', 1400);
    paintAll();
  }
  function newGameNow() {
    if (Model.newGame(g, Date.now())) { save(); paintAll(); toast('New game — Undo brings the scores back', 'success', 2200); }
  }
  // Markdown table at the cursor, on its own lines; one transaction = one Undo in the editor.
  function insertTable() {
    var ed = Cade.editor;
    if (!ed) return;
    if (ed.state.readOnly) { toast('Read-only mode — editing is locked', 'error', 2000); return; }
    var text = Model.markdown(g), st = ed.state, sel = st.selection.main, doc = st.doc;
    var lf = doc.lineAt(sel.from), lt = doc.lineAt(sel.to);
    var before = lf.text.slice(0, sel.from - lf.from), after = lt.text.slice(sel.to - lt.from);
    var pre = '';
    if (before.trim()) pre = '\n\n';
    else if (!before && lf.number > 1 && doc.line(lf.number - 1).text.trim()) pre = '\n';
    var ins = pre + text + (after.trim() ? '\n\n' : '\n');
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: ins }, selection: { anchor: sel.from + ins.length }, scrollIntoView: true, userEvent: 'input' });
    toast('Scores inserted into the note', 'success', 1600);
  }
  function onPanelDown(e) {
    if (!alive()) return;
    var t = e.target;
    if (ui.fs && t.closest && t.closest('.cade-panel-head') && !t.closest('.sk-hbtn') &&
      !(t.classList && (t.classList.contains('cade-panel-x') || t.classList.contains('cade-panel-minbtn')))) e.stopPropagation(); // full screen: no drag
  }
  function onClick(e) {
    if (!alive()) return;
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !ui.panel.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act'), tile = b.closest('.sk-tile'), row = b.closest('[data-pid]');
    var id = tile ? tile.getAttribute('data-id') : row ? row.getAttribute('data-pid') : '';
    switch (act) {
      case 'name': startEdit(id); break;
      case 'rot': case 'prot': {
        var i = Model.indexOf(g, id);
        if (i >= 0) { g.players[i].rot = g.players[i].rot === 180 ? 0 : 180; save(); paintTile(i); if (ui.sheetKind) renderSheet(); }
        break;
      }
      case 'color': {
        var k = Model.indexOf(g, id);
        if (k >= 0) { g.players[k].color = (g.players[k].color + 1) % Model.NCOLORS; save(); paintTile(k); renderSheet(); }
        break;
      }
      case 'undo': doUndo(); break;
      case 'round': if (Model.nextRound(g, Date.now())) { save(); paintBar(); if (ui.sheetKind === 'hist') renderSheet(); } break;
      case 'hist': toggleSheet('hist'); break;
      case 'settings': toggleSheet('settings'); break;
      case 'sheet-close': closeSheet(); break;
      case 'insert': insertTable(); break;
      case 'new': arm('new', b, 'New game?', newGameNow); break;
      case 'new2': arm('new2', b, 'Tap again — new game', function () { newGameNow(); }); break;
      case 'resetall': arm('reset', b, 'Tap again — reset everything', function () {
        Model.reset(g); save(); closeSheet(); build(); toast('Reset — two fresh players', 'info', 1600);
      }); break;
      case 'pl+':
        if (Model.addPlayer(g)) { save(); build(); renderSheet(); }
        break;
      case 'pl-': {
        var last = g.players[g.players.length - 1];
        if (!last || g.players.length <= 1) break;
        var rm = function () { Model.removePlayer(g); save(); build(); renderSheet(); };
        if (last.name || last.score !== Model.startScore(g)) arm('pl-', b, 'Remove ' + Model.displayName(g, g.players.length - 1) + '?', rm);
        else rm();
        break;
      }
      case 'mode': setMode(b.getAttribute('data-v'), g.start); break;
      case 'start': setMode('down', +b.getAttribute('data-v')); break;
      case 'high': g.high = b.getAttribute('data-v') === '1'; save(); paintMarks(); renderSheet(); break;
      case 'step': case 'big': g[act] = Model.stepVal(b.getAttribute('data-v'), g[act]); save(); renderSheet(); break;
      case 'fs': setFs(!ui.fs); saveFs(ui.fs); break;
    }
  }
  function setMode(mode, start) {
    if (mode === g.mode && (mode === 'up' || start === g.start)) return;
    var cleared = Model.newGame(g, Date.now(), mode, start);
    save();
    paintAll();
    if (cleared) toast('New game, counting ' + (g.mode === 'down' ? 'down from ' + Model.fmt(g.start) : 'up from 0') + ' — Undo brings the scores back', 'success', 2600);
  }
  function onInput(e) {
    if (!alive()) return;
    var t = e.target, f = t.getAttribute('data-f');
    if (f === 'pname') {
      var i = Model.indexOf(g, t.closest('[data-pid]').getAttribute('data-pid'));
      if (i >= 0) { Model.rename(g, i, t.value); save(); paintTile(i); }
    }
  }
  function onChange(e) {
    if (!alive()) return;
    var t = e.target, f = t.getAttribute('data-f');
    if (f === 'step' || f === 'big') {
      var v = Model.stepVal(String(t.value).replace(',', '.'), NaN);
      if (isFinite(v)) { g[f] = v; save(); }
      else toast('A step is a number above 0', 'error', 1800);
      renderSheet();
    } else if (f === 'start') {
      var s = parseFloat(String(t.value).replace(',', '.'));
      if (isFinite(s)) setMode('down', s);
      else renderSheet();
    } else if (f === 'rounds') { g.rounds = !!t.checked; save(); paintBar(); }
    else if (f === 'pname') renderSheet();
  }
  function onPanelKey(e) {
    if (!alive() || e.defaultPrevented) return;
    var ae = document.activeElement, typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
    if (e.key === 'Escape' && ui.sheetKind) { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
    if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); e.stopPropagation(); doUndo();
    }
  }
  function onMin() {
    if (!alive()) return;
    Object.keys(ui.holds).forEach(endHold);
    if (ui.editing) finishEdit(true);
  }
  function onRestore() { if (alive()) flow(false); }

  // ======================================================================
  // Sheets: settings, history
  // ======================================================================
  function toggleSheet(kind) {
    if (ui.sheetKind === kind) { closeSheet(); return; }
    if (ui.editing) finishEdit(true);
    disarm();
    ui.sheetKind = kind;
    renderSheet();
    ui.sheet.hidden = false;
    ui.sheet.scrollTop = 0;
    ui.bar.querySelectorAll('[data-act="hist"],[data-act="settings"]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-act') === (kind === 'hist' ? 'hist' : 'settings'));
    });
  }
  function closeSheet() {
    if (!ui || !ui.sheetKind) return;
    disarm();
    ui.sheetKind = '';
    ui.sheet.hidden = true;
    ui.sheet.textContent = '';
    ui.bar.querySelectorAll('.sk-b.on').forEach(function (b) { b.classList.remove('on'); });
    try { ui.root.focus({ preventScroll: true }); } catch (e) {}
  }
  function seg(act, opts, cur) {
    return '<div class="sk-seg" role="group">' + opts.map(function (o) {
      return '<button type="button" data-act="' + act + '" data-v="' + esc(o[0]) + '" class="' + (String(cur) === String(o[0]) ? 'on' : '') + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function chips(act, vals, cur) {
    return vals.map(function (v) {
      return '<button type="button" class="sk-chip' + (v === cur ? ' on' : '') + '" data-act="' + act + '" data-v="' + v + '">' + esc(Model.fmt(v)) + '</button>';
    }).join('');
  }
  function numInput(f, val, label) {
    return '<input class="sk-num" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-f="' + f + '" value="' + esc(Model.fmt(val)) + '" aria-label="' + label + '">';
  }
  function renderSheet() {
    if (!ui || !ui.sheetKind) return;
    // Don't rebuild under a field being typed in (it would lose the caret).
    var ae = document.activeElement;
    if (ae && ui.sheet.contains(ae) && ae.tagName === 'INPUT' && ae.type === 'text') {
      if (ui.sheetKind === 'settings') syncSettings();
      return;
    }
    ui.sheet.innerHTML = ui.sheetKind === 'hist' ? histHtml() : settingsHtml();
  }
  // Light refresh of the settings sheet's non-input parts while a field has the caret.
  function syncSettings() {
    var n = ui.sheet.querySelector('.sk-n');
    if (n) n.textContent = String(g.players.length);
  }
  function settingsHtml() {
    var rows = g.players.map(function (p, i) {
      return '<div class="sk-prow" data-pid="' + esc(p.id) + '" style="--sk-c: var(' + PALETTE[p.color] + ')">' +
        '<button type="button" class="sk-dot" data-act="color" title="Colour: ' + COLOR_NAMES[p.color] + ' — tap to change" aria-label="Colour ' + COLOR_NAMES[p.color] + '"></button>' +
        '<input class="sk-pin" type="text" data-f="pname" maxlength="' + Model.NAME_MAX + '" autocomplete="off" spellcheck="false" enterkeyhint="done" value="' + esc(p.name) +
          '" placeholder="Player ' + (i + 1) + '" aria-label="Name of player ' + (i + 1) + '">' +
        '<button type="button" class="sk-tog' + (p.rot === 180 ? ' on' : '') + '" data-act="prot" title="Turn this player\'s tile upside down (for someone across the table)">' +
          ICON.rot + '<span>' + (p.rot === 180 ? 'Turned' : 'Upright') + '</span></button>' +
      '</div>';
    }).join('');
    var down = g.mode === 'down';
    return '<div class="sk-sh">' +
      '<div class="sk-sh-head"><b>Players &amp; scoring</b><span class="sk-sp"></span><button type="button" class="sk-btn" data-act="sheet-close">Done</button></div>' +
      '<div class="sk-sec">' +
        '<div class="sk-line"><span class="sk-lbl">Players</span><span class="sk-stepper">' +
          '<button type="button" class="sk-btn sk-sq" data-act="pl-" aria-label="One player fewer"' + (g.players.length <= 1 ? ' disabled' : '') + '>−</button>' +
          '<b class="sk-n">' + g.players.length + '</b>' +
          '<button type="button" class="sk-btn sk-sq" data-act="pl+" aria-label="One more player"' + (g.players.length >= Model.MAX_PLAYERS ? ' disabled' : '') + '>+</button>' +
        '</span></div>' +
        '<div class="sk-plist">' + rows + '</div>' +
      '</div>' +
      '<div class="sk-sec">' +
        '<div class="sk-line"><span class="sk-lbl">Count</span>' + seg('mode', [['up', 'Up from 0'], ['down', 'Down from ' + Model.fmt(g.start)]], g.mode) + '</div>' +
        (down ? '<div class="sk-line"><span class="sk-lbl">Start at</span><span class="sk-wrap">' + chips('start', [20, 40, 301, 501], g.start) +
          numInput('start', g.start, 'Start value') + '</span></div>' : '') +
        '<div class="sk-line"><span class="sk-lbl">' + (down ? 'Ranking' : 'Leader') + '</span>' + seg('high', [['1', 'Highest score'], ['0', 'Lowest score']], g.high ? '1' : '0') + '</div>' +
        '<p class="sk-note">' + (down ? 'Tiles at or below 0 are marked. Changing the count or the start value starts a new game (Undo brings the scores back).'
          : 'The leader is starred. Changing the count starts a new game (Undo brings the scores back).') + '</p>' +
      '</div>' +
      '<div class="sk-sec">' +
        '<div class="sk-line"><span class="sk-lbl">Tap</span><span class="sk-wrap">± ' + chips('step', [1, 5, 10], g.step) + numInput('step', g.step, 'Step for a tap') + '</span></div>' +
        '<div class="sk-line"><span class="sk-lbl">Hold</span><span class="sk-wrap">± ' + chips('big', [5, 10, 25, 50], g.big) + numInput('big', g.big, 'Step while holding') + '</span></div>' +
        '<label class="sk-ck"><input type="checkbox" data-f="rounds"' + (g.rounds ? ' checked' : '') + '> <span>Count rounds</span></label>' +
      '</div>' +
      '<div class="sk-sec sk-acts">' +
        '<button type="button" class="sk-btn" data-act="new2"' + (Model.pristine(g) ? ' disabled' : '') + '>New game — same players</button>' +
        '<button type="button" class="sk-btn danger" data-act="resetall">Reset everything</button>' +
      '</div>' +
    '</div>';
  }
  function histHtml() {
    // Walk back from the current scores to show each change with the total it led to.
    var cur = {}, round = g.round, mode = g.mode, start = g.start, items = [];
    g.players.forEach(function (p) { cur[p.id] = p.score; });
    for (var k = g.hist.length - 1; k >= 0; k--) {
      var e = g.hist[k];
      if (e.k === 's') {
        var i = Model.indexOf(g, e.id);
        if (i < 0) continue;
        var p = g.players[i];
        items.push('<li class="sk-hi" style="--sk-c: var(' + PALETTE[p.color] + ')"><i class="sk-hdot"></i><span class="sk-hn">' + esc(Model.displayName(g, i)) +
          '</span><b class="sk-hd' + (e.d < 0 ? ' neg' : '') + '">' + esc(signed(e.d)) + '</b><span class="sk-ht">' + esc(disp(cur[e.id])) + '</span></li>');
        cur[e.id] = Math.round((cur[e.id] - e.d) * 1e6) / 1e6;
      } else if (e.k === 'r') {
        items.push('<li class="sk-hsep">Round ' + round + '</li>');
        round = Math.max(1, round - 1);
      } else {
        var changed = e.prev.mode !== mode || (mode === 'down' && e.prev.start !== start);
        items.push('<li class="sk-hsep">New game' + (changed ? ' — counting ' + (mode === 'down' ? 'down from ' + esc(Model.fmt(start)) : 'up') : '') + '</li>');
        Object.keys(e.prev.s).forEach(function (id) { cur[id] = e.prev.s[id]; });
        round = e.prev.round; mode = e.prev.mode; start = e.prev.start;
      }
    }
    return '<div class="sk-sh">' +
      '<div class="sk-sh-head"><b>History</b><span class="sk-sp"></span>' +
        '<button type="button" class="sk-btn" data-act="undo"' + (g.hist.length ? '' : ' disabled') + '>' + ICON.undo + ' Undo</button>' +
        '<button type="button" class="sk-btn" data-act="sheet-close">Done</button></div>' +
      (items.length ? '<ol class="sk-hist">' + items.join('') + '</ol>' : '<p class="sk-note">Nothing yet — tap a tile’s top half to add, its bottom half to subtract.</p>') +
    '</div>';
  }

  Cade.registerWidget({
    name: 'Score Keeper',
    description: 'Scores for 1–8 players at the table — tap to add, hold for big steps, count up or down, undo, rounds, insert as a table',
    icon: '🏆',
    tags: 'score,scores,score keeper,scorekeeper,scoreboard,tally,counter,points,card game,board game,game night,life counter,life total,mtg,magic,darts,golf,hearts,rummy,uno,players,rounds,leaderboard',
    open: open,
    close: close,
  });
})();
