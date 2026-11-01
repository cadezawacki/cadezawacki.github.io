/* Factory Lines — an automation puzzle for Cade.txt.
 * Build production lines on a grid: extractors on ore, conveyor belts,
 * splitters, mergers and crossings, and machines (smelter, cutter, assembler,
 * painter) that turn raw ore into parts. Each level asks for N of an item
 * delivered to its port at a sustained rate; 16 levels introduce one mechanic
 * at a time, then a free sandbox. Stars for solving, for building at or under
 * the par cost and for using no more tiles than par.
 * The simulation is a deterministic tick engine (pure, unit-checked in node):
 * belts move one tile per tick, machines craft on fixed timers, and every
 * transfer is resolved in a fixed order so a layout always plays the same.
 * Drawn as monospace glyphs (cached in a glyph atlas) on a canvas; the tick
 * runs on a fixed step with an accumulator and items are interpolated between
 * tiles, so motion is smooth at 60 or 120 Hz. Progress, working layouts and
 * best solutions persist in Cade.store (cade-factory-*). Offline, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];       // 0 E, 1 S, 2 W, 3 N (y grows down)
  var DIRCH = '>v<^';
  function back(d) { return (d + 2) & 3; }
  function left(d) { return (d + 3) & 3; }
  function right(d) { return (d + 1) & 3; }
  var WIN = 60;                                      // a "minute" is 60 ticks: rates are items per 60 ticks

  // Items. ch: the glyph; col: palette name the UI maps to a theme colour.
  var ITEMS = {
    fe: { name: 'Iron ore', ch: 'o', col: 'iron' },
    cu: { name: 'Copper ore', ch: 'o', col: 'copper' },
    sand: { name: 'Sand', ch: ':', col: 'sand' },
    red: { name: 'Red dye', ch: '%', col: 'red' },
    blu: { name: 'Blue dye', ch: '%', col: 'blue' },
    plate: { name: 'Iron plate', ch: '=', col: 'iron' },
    cbar: { name: 'Copper bar', ch: '-', col: 'copper' },
    glass: { name: 'Glass', ch: '0', col: 'ice' },
    gear: { name: 'Gear', ch: '*', col: 'iron' },
    wire: { name: 'Wire', ch: '~', col: 'copper' },
    motor: { name: 'Motor', ch: 'M', col: 'violet' },
    lamp: { name: 'Lamp', ch: 'L', col: 'gold' },
    frame: { name: 'Frame', ch: '#', col: 'text' },
    robot: { name: 'Robot', ch: '&', col: 'accent' }
  };
  var PAINTABLE = ['gear', 'plate', 'frame', 'robot'];
  var DYES = { red: { suf: 'r', name: 'Red' }, blu: { suf: 'b', name: 'Blue' } };
  PAINTABLE.forEach(function (p) {
    ITEMS[p + '_r'] = { name: 'Red ' + ITEMS[p].name.toLowerCase(), ch: ITEMS[p].ch, col: 'red', base: p };
    ITEMS[p + '_b'] = { name: 'Blue ' + ITEMS[p].name.toLowerCase(), ch: ITEMS[p].ch, col: 'blue', base: p };
  });

  // Ground tiles. Ores feed an extractor placed on them; ports are fixed.
  var ORES = { i: { res: 'fe', t: 4 }, I: { res: 'fe', t: 2, rich: true }, c: { res: 'cu', t: 4 }, s: { res: 'sand', t: 4 }, r: { res: 'red', t: 4 }, b: { res: 'blu', t: 4 } };
  function isPortCh(ch) { return ch === 'P' || (ch >= '1' && ch <= '4'); }

  // Buildable pieces. code: one char in saved layouts.
  var PIECES = {
    belt: { code: 'b', name: 'Belt', cost: 1, info: 'moves items one tile per tick; takes items from behind, or turns a corner from one side' },
    extractor: { code: 'e', name: 'Extractor', cost: 6, info: 'on an ore tile: mines 1 ore every 4 ticks (15/min; rich ore 30/min)' },
    merger: { code: 'm', name: 'Merger', cost: 3, info: 'joins lines: takes from behind and both sides in turn, outputs ahead' },
    splitter: { code: 's', name: 'Splitter', cost: 3, info: 'takes from behind, deals items ahead / left / right in turn — skipping an output that can\'t take the item' },
    cross: { code: 'x', name: 'Crossing', cost: 3, info: 'two lines pass straight through each other' },
    smelter: { code: 'S', name: 'Smelter', cost: 10, info: 'ore to bar / plate / glass (4 ticks)' },
    cutter: { code: 'C', name: 'Cutter', cost: 10, info: '1 plate or bar into 2 gears or wires (6 ticks)' },
    assembler: { code: 'A', name: 'Assembler', cost: 15, info: 'combines parts (6 ticks)' },
    painter: { code: 'P', name: 'Painter', cost: 12, info: 'item + dye = painted item (3 ticks)' },
    port: { code: 'D', name: 'Port', cost: 0, info: 'sandbox delivery point: accepts anything' }
  };
  var PIECE_ORDER = ['belt', 'extractor', 'merger', 'splitter', 'cross', 'smelter', 'cutter', 'assembler', 'painter', 'port'];
  var CODE2PIECE = {};
  PIECE_ORDER.forEach(function (k) { CODE2PIECE[PIECES[k].code] = k; });
  var MACHINES = { smelter: 1, cutter: 1, assembler: 1, painter: 1 };

  var RECIPES = {
    smelter: [
      { in: { fe: 1 }, out: 'plate', n: 1, t: 4 },
      { in: { cu: 1 }, out: 'cbar', n: 1, t: 4 },
      { in: { sand: 1 }, out: 'glass', n: 1, t: 4 }
    ],
    cutter: [
      { in: { plate: 1 }, out: 'gear', n: 2, t: 6 },
      { in: { cbar: 1 }, out: 'wire', n: 2, t: 6 }
    ],
    assembler: [
      { in: { gear: 1, wire: 1 }, out: 'motor', n: 1, t: 6 },
      { in: { glass: 1, wire: 2 }, out: 'lamp', n: 1, t: 6 },
      { in: { plate: 2, gear: 1 }, out: 'frame', n: 1, t: 6 },
      { in: { motor: 1, lamp: 1 }, out: 'robot', n: 1, t: 6 }
    ],
    painter: []
  };
  PAINTABLE.forEach(function (p) {
    Object.keys(DYES).forEach(function (dy) {
      var inp = {}; inp[p] = 1; inp[dy] = 1;
      RECIPES.painter.push({ in: inp, out: p + '_' + DYES[dy].suf, n: 1, t: 3 });
    });
  });
  var OUTCAP = 4;
  // per machine type: how many of each item its input buffer holds
  var INCAP = {};
  Object.keys(RECIPES).forEach(function (m) {
    var c = {};
    RECIPES[m].forEach(function (r) { for (var k in r.in) c[k] = Math.max(c[k] || 2, 2 * r.in[k]); });
    INCAP[m] = c;
  });

  // ---- levels ----
  // map: '.' floor, '#' rock, ores (i I c s r b), ports ('P' takes any goal item without a port
  // number; '1'..'4' only the goals naming that port). goals: [{ item, n, rate, port }].
  // par: the cost and the tile count of a known good solution (a star each).
  var LEVELS = [
    { id: 'belt', name: 'First Belt', tools: ['belt', 'extractor'],
      intro: 'Put an <b>extractor</b> on the iron ore (o), facing the port, then lay <b>belts</b> to the port. Drag to paint a belt line.',
      map: ['.........', '.........', '.i.....P.', '.........', '.........'],
      goals: [{ item: 'fe', n: 8, rate: 10 }], par: { cost: 11, tiles: 6 } },
    { id: 'detour', name: 'Detour', tools: ['belt', 'extractor'],
      intro: 'Rock is in the way. Belts turn a corner by taking items from one side.',
      map: ['.........', '.i..#....', '....#....', '....#..P.', '....#....', '.........', '.........'],
      goals: [{ item: 'fe', n: 10, rate: 12 }], par: { cost: 15, tiles: 10 } },
    { id: 'merge', name: 'Two Seams', tools: ['belt', 'extractor', 'merger'],
      intro: 'One extractor makes 15 ore a minute; the port wants more. A belt takes only one input, so join two lines with a <b>merger</b>.',
      map: ['..........', '.i........', '.......#..', '.......#P#', '.......###', '.i........', '..........'],
      goals: [{ item: 'fe', n: 20, rate: 24 }], par: { cost: 26, tiles: 14 } },
    { id: 'smelt', name: 'Smelter', tools: ['belt', 'extractor', 'merger', 'smelter'],
      intro: 'A <b>smelter</b> turns iron ore into iron plates (=). Machines output ahead and take items from the other three sides.',
      map: ['...........', '.i.........', '...........', '.........P.', '...........'],
      goals: [{ item: 'plate', n: 10, rate: 12 }], par: { cost: 24, tiles: 10 } },
    { id: 'rich', name: 'Rich Vein', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter'],
      intro: 'Rich ore (the dense, darker tile) mines twice as fast — more than one smelter can keep up with. A <b>splitter</b> deals items to its outputs in turn.',
      map: ['............', '............', '.I..........', '............', '..........P.', '............'],
      goals: [{ item: 'plate', n: 20, rate: 24 }], par: { cost: 37, tiles: 12 } },
    { id: 'twin', name: 'Twin Ports', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter'],
      intro: 'Two numbered ports each want their own share of plates. Balance one vein between them.',
      map: ['...........', '.........1.', '...........', '.I.........', '...........', '.........2.', '...........'],
      goals: [{ item: 'plate', n: 12, rate: 12, port: 1 }, { item: 'plate', n: 12, rate: 12, port: 2 }], par: { cost: 36, tiles: 11 } },
    { id: 'gears', name: 'Gears', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter'],
      intro: 'A <b>cutter</b> turns one plate into two gears (*). It is slower than a smelter, so a little ore backs up — that is fine.',
      map: ['............', '.i..........', '............', '.......##...', '.......#P...', '............'],
      goals: [{ item: 'gear', n: 20, rate: 18 }], par: { cost: 35, tiles: 12 } },
    { id: 'wire', name: 'Copper Wire', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter'],
      intro: 'Copper ore smelts to copper bars (-), and a cutter turns a bar into two wires (~). Leave the iron where it is.',
      map: ['............', '.c....#.....', '......#.....', '......#.....', '...i..#.....', '......#...P.', '............'],
      goals: [{ item: 'wire', n: 24, rate: 18 }], par: { cost: 38, tiles: 15 } },
    { id: 'cross', name: 'Crossroads', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross'],
      intro: 'Each port takes one kind of ore, and the lines have to cross. A <b>crossing</b> lets two lines pass through each other.',
      map: ['#############', '#i.........2#', '#...........#', '#...........#', '#c.........1#', '#############'],
      goals: [{ item: 'fe', n: 10, rate: 12, port: 1 }, { item: 'cu', n: 10, rate: 12, port: 2 }], par: { cost: 37, tiles: 25 } },
    { id: 'motor', name: 'Assembly', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler'],
      intro: 'An <b>assembler</b> makes a motor (M) from a gear and a wire. Feed it both — from different sides or on one belt.',
      map: ['.............', '.i...........', '.............', '.............', '..........P..', '.............', '.c...........', '.............'],
      goals: [{ item: 'motor', n: 8, rate: 8 }], par: { cost: 82, tiles: 22 } },
    { id: 'lamp', name: 'Glass Works', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler'],
      intro: 'Sand (:) smelts to glass (0). A lamp (L) takes one glass and two wires. The rock wall has two gaps.',
      map: ['.............', '.s.....#.....', '.......#.....', '.......#.....', '..........P..', '.......#.....', '.c.....#.....', '.......#.....'],
      goals: [{ item: 'lamp', n: 8, rate: 8 }], par: { cost: 75, tiles: 24 } },
    { id: 'paint', name: 'Paint Shop', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler', 'painter'],
      intro: 'Extract red dye (%) from the vent. A <b>painter</b> takes a gear and a dye and makes a red gear.',
      map: ['............', '.i..........', '............', '.........P..', '............', '.r..........', '............'],
      goals: [{ item: 'gear_r', n: 15, rate: 14 }], par: { cost: 58, tiles: 19 } },
    { id: 'twotone', name: 'Two Tone', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler', 'painter'],
      intro: 'Red gears to port 1, blue gears to port 2 — from a single gear line.',
      map: ['.............', '.r.........1.', '.............', '.............', '.i...........', '.............', '.............', '.b.........2.', '.............'],
      goals: [{ item: 'gear_r', n: 10, rate: 8, port: 1 }, { item: 'gear_b', n: 10, rate: 8, port: 2 }], par: { cost: 91, tiles: 34 } },
    { id: 'frame', name: 'Frames', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler', 'painter'],
      intro: 'A frame (#) takes two plates and a gear. Plates are needed twice: whole, and cut into gears.',
      map: ['.............', '.i...........', '.............', '...........P.', '.............', '.i...........', '.............', '.............'],
      goals: [{ item: 'frame', n: 8, rate: 8 }], par: { cost: 84, tiles: 31 } },
    { id: 'double', name: 'Double Time', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler', 'painter'],
      intro: 'One assembler makes 10 motors a minute. This order needs 15. Run two in parallel.',
      map: ['..............', '.i............', '..............', '..............', '............P.', '..............', '..............', '.c............', '..............'],
      goals: [{ item: 'motor', n: 20, rate: 15 }], par: { cost: 114, tiles: 36 } },
    { id: 'robot', name: 'Robots', tools: ['belt', 'extractor', 'merger', 'smelter', 'splitter', 'cutter', 'cross', 'assembler', 'painter'],
      intro: 'The big one: a robot (&) is a motor plus a lamp. Iron, copper and sand, three assemblers.',
      map: ['...............', '.i.............', '...............', '...............', '.c.............', '...............', '...............', '.s..........P..', '...............', '...............'],
      goals: [{ item: 'robot', n: 6, rate: 5 }], par: { cost: 151, tiles: 45 } }
  ];
  var SANDBOX = {
    id: 'sandbox', name: 'Sandbox', sandbox: true, tools: PIECE_ORDER.slice(),
    intro: 'Everything unlocked, no goal. Place ports anywhere: they accept any item and count it.',
    map: [
      '................',
      '.ii.......cc....',
      '.ii.......cc....',
      '................',
      '.....##.........',
      '.s...##.....rr..',
      '.s..........rr..',
      '................',
      '.I.......#......',
      '.........#...bb.',
      '.cc..........bb.',
      '................'
    ],
    goals: [], par: { cost: 0, tiles: 0 }
  };
  function levelById(id) {
    if (id === 'sandbox') return SANDBOX;
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return LEVELS[i];
    return null;
  }
  function levelSize(lv) { return { w: lv.map[0].length, h: lv.map.length }; }
  function tileAt(lv, x, y) { var r = lv.map[y]; return r ? r.charAt(x) || '#' : '#'; }

  // ---- layouts: one piece per cell, { t: piece key, d: dir } or null ----
  function emptyLayout(lv) { var s = levelSize(lv), a = new Array(s.w * s.h); for (var i = 0; i < a.length; i++) a[i] = null; return a; }
  // can `t` go on (x, y)? (ignores what is there now)
  function canPlace(lv, x, y, t) {
    var s = levelSize(lv);
    if (x < 0 || y < 0 || x >= s.w || y >= s.h || !PIECES[t]) return false;
    var ch = tileAt(lv, x, y);
    if (ch === '#' || isPortCh(ch)) return false;
    if (t === 'port' && !lv.sandbox) return false;
    if (t === 'extractor') return !!ORES[ch];
    return true;
  }
  function encode(lv, L) {
    var out = '';
    for (var i = 0; i < L.length; i++) out += L[i] ? PIECES[L[i].t].code + DIRCH.charAt(L[i].d) : '..';
    return out;
  }
  // a saved string back to a layout; pieces that no longer fit are dropped. null if not a layout at all.
  function decode(lv, str) {
    var s = levelSize(lv), L = emptyLayout(lv);
    if (typeof str !== 'string' || str.length !== s.w * s.h * 2) return null;
    for (var i = 0; i < s.w * s.h; i++) {
      var c = str.charAt(i * 2), dc = str.charAt(i * 2 + 1);
      if (c === '.') continue;
      var t = CODE2PIECE[c], d = DIRCH.indexOf(dc);
      if (!t || d < 0) return null;
      if (canPlace(lv, i % s.w, (i / s.w) | 0, t)) L[i] = { t: t, d: d };
    }
    return L;
  }
  // Rows of space-separated tokens ('.' or piece code + arrow) — handy for writing solutions.
  function fromRows(lv, rows) {
    var s = levelSize(lv), str = '';
    for (var y = 0; y < s.h; y++) {
      var tk = (rows[y] || '').trim().split(/\s+/).filter(Boolean);
      for (var x = 0; x < s.w; x++) { var t = tk[x] || '.'; str += t === '.' ? '..' : t; }
    }
    return decode(lv, str);
  }
  function stats(L) {
    var cost = 0, tiles = 0;
    for (var i = 0; i < L.length; i++) if (L[i]) { cost += PIECES[L[i].t].cost; tiles++; }
    return { cost: cost, tiles: tiles };
  }
  function starsFor(lv, st) {
    if (lv.sandbox) return 0;
    return 1 + (st.cost <= lv.par.cost ? 1 : 0) + (st.tiles <= lv.par.tiles ? 1 : 0);
  }

  // ---- simulation ----
  // Entities: one per piece and per port. Static links (who feeds whom) are
  // computed once; each tick runs the machines' timers, then moves items in
  // passes until nothing more can move (so a whole packed belt advances at once).
  function potentialOuts(e) {
    switch (e.t) {
      case 'belt': case 'merger': case 'extractor': case 'smelter': case 'cutter': case 'assembler': case 'painter': return [e.d];
      case 'splitter': return [e.d, left(e.d), right(e.d)];
      case 'cross': return [0, 1, 2, 3];
      default: return [];
    }
  }
  function staticAccepts(e, side) {
    switch (e.t) {
      case 'belt': return side === e.inSide;
      case 'splitter': return side === back(e.d);
      case 'merger': case 'smelter': case 'cutter': case 'assembler': case 'painter': return side !== e.d;
      case 'cross': case 'port': return true;
      default: return false;
    }
  }
  function newSim(lv, L) {
    var s = levelSize(lv), W = s.w, H = s.h, grid = new Array(W * H), ents = [], i, x, y;
    for (i = 0; i < W * H; i++) {
      x = i % W; y = (i / W) | 0;
      var ch = tileAt(lv, x, y), p = L[i], e = null;
      if (isPortCh(ch)) e = { t: 'port', d: 0, pid: ch === 'P' ? 0 : +ch };
      else if (p && p.t === 'port') e = { t: 'port', d: p.d, pid: 0 };
      else if (p) e = { t: p.t, d: p.d };
      if (!e) continue;
      e.i = i; e.x = x; e.y = y; e.n = ents.length;
      e.item = null; e.slots = [null, null]; e.buf = {}; e.out = []; e.timer = 0; e.cur = null; e.rr = 0; e.lastOut = -1;
      e.ring = new Uint8Array(WIN); e.rin = new Uint8Array(WIN); e.made = 0; e.recv = 0;
      if (e.t === 'extractor') { var o = ORES[ch]; e.res = o.res; e.rt = o.t; }
      grid[i] = e; ents.push(e);
    }
    function nb(e, d) { var nx = e.x + DX[d], ny = e.y + DY[d]; return nx < 0 || ny < 0 || nx >= W || ny >= H ? null : grid[ny * W + nx] || null; }
    function feeds(n, toward) { return !!n && potentialOuts(n).indexOf(toward) >= 0; }
    ents.forEach(function (e) {
      if (e.t !== 'belt') return;
      var c = [back(e.d), left(e.d), right(e.d)];
      e.inSide = c[0];
      for (var k = 0; k < 3; k++) if (feeds(nb(e, c[k]), back(c[k]))) { e.inSide = c[k]; break; }
    });
    ents.forEach(function (e) {
      e.nbs = [nb(e, 0), nb(e, 1), nb(e, 2), nb(e, 3)];
      e.outs = potentialOuts(e).filter(function (d) { var n = e.nbs[d]; return n && staticAccepts(n, back(d)); });
      if (e.t !== 'splitter' && e.t !== 'cross') e.outs = e.outs.length ? e.outs : [];
    });
    var goals = (lv.goals || []).map(function (g) { return { item: g.item, n: g.n, rate: g.rate, port: g.port || 0, got: 0, ring: new Uint16Array(WIN) }; });
    return {
      lv: lv, w: W, h: H, grid: grid, ents: ents, tick: 0, goals: goals, won: 0, uid: 0,
      box: {}, boxRing: {}, ghosts: [], delivered: 0, events: []
    };
  }
  function goalFor(sim, pid, k) {
    for (var i = 0; i < sim.goals.length; i++) { var g = sim.goals[i]; if (g.item === k && g.port === pid) return g; }
    return null;
  }
  function machineTakes(e, k) {
    var cap = INCAP[e.t][k];
    return !!cap && (e.buf[k] || 0) < cap;
  }
  function canAccept(sim, t, side, k) {
    switch (t.t) {
      case 'belt': return side === t.inSide && !t.item;
      case 'splitter': return side === back(t.d) && !t.item;
      case 'merger': return side !== t.d && !t.item;
      case 'cross': return !t.slots[side & 1];
      case 'port': return sim.lv.sandbox ? true : !!goalFor(sim, t.pid, k);
      case 'smelter': case 'cutter': case 'assembler': case 'painter': return side !== t.d && machineTakes(t, k);
      default: return false;
    }
  }
  // order in which a target serves competing inputs (lower first)
  function prio(t, side) {
    var o = side === back(t.d) ? 0 : side === left(t.d) ? 1 : side === right(t.d) ? 2 : 3;
    if (t.t === 'merger') return (o - t.rr + 3) % 3;
    if (t.t === 'cross' || t.t === 'port') return side;
    return o;
  }
  function runMachines(sim) {
    var ents = sim.ents;
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.t === 'extractor') {
        if (e.timer > 0 && --e.timer === 0) { e.out.push(e.res); e.made++; }
        if (!e.timer && e.out.length < 2) e.timer = e.rt;
      } else if (MACHINES[e.t]) {
        if (e.timer > 0 && --e.timer === 0) { for (var q = 0; q < e.cur.n; q++) e.out.push(e.cur.out); e.made += e.cur.n; e.cur = null; }
        if (!e.timer) {
          var R = RECIPES[e.t];
          for (var r = 0; r < R.length; r++) {
            var rc = R[r], ok = e.out.length + rc.n <= OUTCAP;
            for (var k in rc.in) if ((e.buf[k] || 0) < rc.in[k]) { ok = false; break; }
            if (!ok) continue;
            for (var k2 in rc.in) e.buf[k2] -= rc.in[k2];
            e.cur = rc; e.timer = rc.t;
            break;
          }
        }
      }
    }
  }
  // what an entity offers this tick: [{ slot, k, dirs }]
  function offers(e, T, list) {
    var it;
    switch (e.t) {
      case 'belt': case 'merger':
        it = e.item; if (it && it.mt < T && e.outs.length) list.push({ e: e, slot: -1, k: it.k, dirs: e.outs }); break;
      case 'splitter':
        it = e.item;
        if (it && it.mt < T && e.outs.length) {
          var n = e.outs.length, ds = [];
          for (var j = 0; j < n; j++) ds.push(e.outs[(e.rr + j) % n]);
          list.push({ e: e, slot: -1, k: it.k, dirs: ds });
        }
        break;
      case 'cross':
        for (var s = 0; s < 2; s++) { it = e.slots[s]; if (it && it.mt < T) list.push({ e: e, slot: s, k: it.k, dirs: [it.dir] }); }
        break;
      case 'extractor': case 'smelter': case 'cutter': case 'assembler': case 'painter':
        if (e.out.length && e.lastOut < T && e.outs.length) list.push({ e: e, slot: -2, k: e.out[0], dirs: e.outs });
        break;
    }
  }
  function transfer(sim, o, t, d, T) {
    var e = o.e, it, side = back(d), slot = T % WIN;
    if (o.slot === -1) { it = e.item; e.item = null; }
    else if (o.slot >= 0) { it = e.slots[o.slot]; e.slots[o.slot] = null; }
    else { it = { k: e.out.shift(), id: ++sim.uid }; e.lastOut = T; }
    if (e.t === 'splitter') e.rr = (e.outs.indexOf(d) + 1) % e.outs.length;
    e.ring[slot]++;
    it.fx = e.x; it.fy = e.y; it.mt = T;
    if (o.slot === -2) { it.fx += DX[d] * 0.4; it.fy += DY[d] * 0.4; }
    t.recv++; t.rin[slot]++;
    switch (t.t) {
      case 'belt': case 'splitter': t.item = it; break;
      case 'merger': t.item = it; t.rr = (prio(t, side) + t.rr + 1) % 3; break;
      case 'cross': it.dir = d; t.slots[side & 1] = it; break;
      case 'port':
        sim.ghosts.push({ k: it.k, fx: e.x, fy: e.y, tx: t.x, ty: t.y, port: 1 });
        sim.delivered++;
        if (sim.lv.sandbox) {
          sim.box[it.k] = (sim.box[it.k] || 0) + 1;
          var br = sim.boxRing[it.k] || (sim.boxRing[it.k] = new Uint16Array(WIN));
          br[slot]++;
        } else {
          var g = goalFor(sim, t.pid, it.k);
          g.got++; g.ring[slot]++;
        }
        sim.events.push('deliver');
        break;
      default:   // a machine
        t.buf[it.k] = (t.buf[it.k] || 0) + 1;
        sim.ghosts.push({ k: it.k, fx: e.x, fy: e.y, tx: t.x, ty: t.y });
    }
  }
  function moveItems(sim, T) {
    var ents = sim.ents, guard = 0;
    for (;;) {
      var list = [], reqs = [], i, j;
      for (i = 0; i < ents.length; i++) offers(ents[i], T, list);
      for (i = 0; i < list.length; i++) {
        var o = list[i];
        for (j = 0; j < o.dirs.length; j++) {
          var d = o.dirs[j], t = o.e.nbs[d];
          if (t && canAccept(sim, t, back(d), o.k)) { reqs.push({ o: o, t: t, d: d, p: prio(t, back(d)) }); break; }
        }
      }
      if (!reqs.length) break;
      reqs.sort(function (a, b) { return a.t.n - b.t.n || a.p - b.p || a.o.e.n - b.o.e.n; });
      var moved = 0;
      for (i = 0; i < reqs.length; i++) {
        var r = reqs[i];
        if (!canAccept(sim, r.t, back(r.d), r.o.k)) continue;
        transfer(sim, r.o, r.t, r.d, T);
        moved++;
      }
      if (!moved || ++guard > 10000) break;
    }
  }
  function rateOf(ring) { var s = 0; for (var i = 0; i < ring.length; i++) s += ring[i]; return s; }
  function step(sim) {
    var T = ++sim.tick, slot = T % WIN, i;
    sim.ghosts.length = 0;
    sim.events.length = 0;
    for (i = 0; i < sim.ents.length; i++) { sim.ents[i].ring[slot] = 0; sim.ents[i].rin[slot] = 0; }
    for (i = 0; i < sim.goals.length; i++) sim.goals[i].ring[slot] = 0;
    for (var k in sim.boxRing) sim.boxRing[k][slot] = 0;
    runMachines(sim);
    moveItems(sim, T);
    if (!sim.won && sim.goals.length) {
      var ok = true;
      for (i = 0; i < sim.goals.length; i++) { var g = sim.goals[i]; if (g.got < g.n || rateOf(g.ring) < g.rate) { ok = false; break; } }
      if (ok) { sim.won = T; sim.events.push('win'); }
    }
    return sim;
  }
  // status of a machine / extractor for display: work | full | idle
  function status(e) {
    if (e.t !== 'extractor' && !MACHINES[e.t]) return '';
    if (e.timer > 0) return 'work';
    if (e.out.length >= (e.t === 'extractor' ? 2 : OUTCAP) || (e.out.length && !e.outs.length)) return 'full';
    return 'idle';
  }
  // run a layout headlessly until it wins or maxTicks
  function simulate(lv, L, maxTicks) {
    var sim = newSim(lv, L), max = maxTicks || 3000;
    while (!sim.won && sim.tick < max) step(sim);
    return sim;
  }
  // a deterministic fingerprint of the whole state (for the determinism check)
  function digest(sim) {
    var h = 2166136261 >>> 0;
    function mixs(s) { for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } }
    sim.ents.forEach(function (e) {
      mixs(e.i + ':' + (e.item ? e.item.k : '') + (e.slots[0] ? e.slots[0].k : '') + (e.slots[1] ? e.slots[1].k : '') + ':' + e.out.join(',') + ':' + e.timer + ':' + JSON.stringify(e.buf) + ';');
    });
    sim.goals.forEach(function (g) { mixs(g.got + ','); });
    return h;
  }

  // ---- save ----
  function newSave() { return { v: 1, lv: {}, sb: ['', '', ''], sbWork: '', last: 'belt', seen: {}, fast: 1, speedIx: 1 }; }
  function normRec(lv, r) {
    if (!r || typeof r !== 'object') return null;
    var o = { stars: 0, cost: 0, tiles: 0, ticks: 0, best: '', work: '' };
    var st = Math.floor(+r.stars);
    o.stars = st >= 1 && st <= 3 ? st : 0;
    ['cost', 'tiles', 'ticks'].forEach(function (k) { var v = Math.floor(+r[k]); o[k] = isFinite(v) && v > 0 ? v : 0; });
    if (typeof r.best === 'string' && decode(lv, r.best)) o.best = r.best;
    if (typeof r.work === 'string' && decode(lv, r.work)) o.work = r.work;
    if (!o.best) { o.stars = 0; o.cost = 0; o.tiles = 0; o.ticks = 0; }
    return o;
  }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (o.lv && typeof o.lv === 'object') {
      LEVELS.forEach(function (lv) { var r = normRec(lv, o.lv[lv.id]); if (r) s.lv[lv.id] = r; });
    }
    if (Array.isArray(o.sb)) for (var i = 0; i < 3; i++) s.sb[i] = typeof o.sb[i] === 'string' && decode(SANDBOX, o.sb[i]) ? o.sb[i] : '';
    if (typeof o.sbWork === 'string' && decode(SANDBOX, o.sbWork)) s.sbWork = o.sbWork;
    if (typeof o.last === 'string' && levelById(o.last)) s.last = o.last;
    if (o.seen && typeof o.seen === 'object') for (var k in o.seen) if (levelById(k)) s.seen[k] = true;
    var sp = Math.floor(+o.speedIx);
    s.speedIx = sp >= 0 && sp <= 3 ? sp : 1;
    return s;
  }
  function solved(save, id) { var r = save.lv[id]; return !!(r && r.stars); }
  function unlocked(save, idx) {
    if (idx <= 0) return true;
    // the next unsolved level and every one before it; two ahead to allow a skip
    var firstOpen = 0;
    while (firstOpen < LEVELS.length && solved(save, LEVELS[firstOpen].id)) firstOpen++;
    return idx <= firstOpen + 1;
  }
  function allSolved(save) { for (var i = 0; i < LEVELS.length; i++) if (!solved(save, LEVELS[i].id)) return false; return true; }
  function totalStars(save) { var n = 0; for (var k in save.lv) n += save.lv[k].stars || 0; return n; }
  // record a win; returns { stars, newBest, first }
  function record(save, lv, L, ticks) {
    var st = stats(L), stars = starsFor(lv, st), r = save.lv[lv.id] || { stars: 0, cost: 0, tiles: 0, ticks: 0, best: '', work: '' };
    var first = !r.stars, better = first || stars > r.stars || (stars === r.stars && (st.cost < r.cost || (st.cost === r.cost && st.tiles < r.tiles)));
    if (better) { r.stars = stars; r.cost = st.cost; r.tiles = st.tiles; r.ticks = ticks; r.best = encode(lv, L); }
    save.lv[lv.id] = r;
    return { stars: stars, cost: st.cost, tiles: st.tiles, newBest: better && !first, first: first, best: r };
  }

  var ENGINE = {
    DX: DX, DY: DY, WIN: WIN, ITEMS: ITEMS, PIECES: PIECES, PIECE_ORDER: PIECE_ORDER, RECIPES: RECIPES, INCAP: INCAP, ORES: ORES,
    LEVELS: LEVELS, SANDBOX: SANDBOX, levelById: levelById, levelSize: levelSize, tileAt: tileAt, isPortCh: isPortCh,
    emptyLayout: emptyLayout, canPlace: canPlace, encode: encode, decode: decode, fromRows: fromRows, stats: stats, starsFor: starsFor,
    newSim: newSim, step: step, simulate: simulate, status: status, rateOf: rateOf, digest: digest, canAccept: canAccept,
    newSave: newSave, normSave: normSave, record: record, unlocked: unlocked, totalStars: totalStars, allSolved: allSolved, solved: solved,
    back: back, left: left, right: right
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('factory.css');

  var PANEL_ID = 'factory-panel', NAME = 'Factory Lines';
  var KEY = 'cade-factory-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var SPEEDS = [{ n: '½×', tps: 3 }, { n: '1×', tps: 6 }, { n: '4×', tps: 24 }, { n: '16×', tps: 96 }];
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.factory = { live: function () { return S; } };   // test-only peek

  // palette slots (filled from the theme)
  var PN = ['text', 'muted', 'faint', 'accent', 'iron', 'copper', 'sand', 'red', 'blue', 'ice', 'violet', 'gold', 'green', 'flame'];
  var PI = {};
  PN.forEach(function (n, i) { PI[n] = i; });
  var MCOL = { extractor: null, smelter: 'flame', cutter: 'ice', assembler: 'violet', painter: 'red', splitter: 'muted', merger: 'muted', cross: 'muted', port: 'accent' };
  var PGLYPH = { belt: '>', extractor: 'E', merger: '>', splitter: 'Y', cross: '+', smelter: 'S', cutter: 'C', assembler: 'A', painter: 'P', port: '@' };
  var DIRNAME = ['east', 'south', 'west', 'north'];
  var DIRARROW = ['→', '↓', '←', '↑'];

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function starStr(n) { return '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n); }
  function itemTag(k) { var it = ITEMS[k]; return '<b class="fl-ig fl-c-' + it.col + '">' + esc(it.ch) + '</b>'; }
  function itemLabel(k) { return itemTag(k) + ' ' + esc(ITEMS[k].name); }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; this.lastPing = 0; }
  Snd.prototype.ensure = function () {
    if (!this.on) return;
    if (!this.ac) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) {} }
  };
  Snd.prototype.tone = function (f, dur, type, vol, slide, delay) {
    var ac = this.ac;
    if (!this.on || !ac || ac.state === 'closed') return;
    try {
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  function sfx(kind) {
    if (!S || !S.snd.on) return;
    var s = S.snd;
    switch (kind) {
      case 'place': s.tone(520, 0.04, 'square', 0.025); break;
      case 'belt': s.tone(700 + Math.random() * 60, 0.025, 'square', 0.015); break;
      case 'rot': s.tone(660, 0.04, 'triangle', 0.035, 880); break;
      case 'erase': s.tone(300, 0.06, 'triangle', 0.04, 160); break;
      case 'no': s.tone(150, 0.09, 'sawtooth', 0.025); break;
      case 'run': s.tone(440, 0.06, 'triangle', 0.04); s.tone(660, 0.08, 'triangle', 0.04, 0, 0.06); break;
      case 'stop': s.tone(520, 0.06, 'triangle', 0.035); s.tone(330, 0.08, 'triangle', 0.035, 0, 0.05); break;
      case 'ping': {
        var now = Date.now();
        if (now - s.lastPing < 90) return;
        s.lastPing = now;
        s.tone(1180 + Math.random() * 120, 0.05, 'sine', 0.025); break;
      }
      case 'win':
        [523, 659, 784, 1047].forEach(function (f, i) { s.tone(f, 0.16, 'square', 0.03, 0, i * 0.09); });
        s.tone(1568, 0.3, 'triangle', 0.035, 0, 0.38); break;
      case 'click': s.tone(880, 0.04, 'sine', 0.03); break;
    }
  }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC = {
    sndOn: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
    sndOff: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>'),
    play: svg('<path d="M7 5l12 7-12 7z"/>', true),
    pause: svg('<path d="M9 5v14M15 5v14"/>'),
    step: svg('<path d="M6 5l9 7-9 7z" fill="currentColor"/><path d="M18 5v14"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    rot: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    flow: svg('<path d="M4 18V12M9 18V6M14 18v-4M19 18V9"/>')
  };

  // ---- theme ----
  function parseCol(s, d) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    return a == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  var HUES = {
    iron: ['#56677a', '#a9b8c9'], copper: ['#bd5d24', '#f0955a'], sand: ['#a8820f', '#e3c46a'], red: ['#cf3f3f', '#f06a6a'],
    blue: ['#2f6fd0', '#7aa8f5'], ice: ['#21879f', '#7fd6ea'], violet: ['#7351c4', '#b79cf5'], gold: ['#b07d06', '#f2c544'],
    green: ['#2f8f3a', '#7ed37a'], flame: ['#e2611f', '#ff8f3f']
  };
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.6)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.38));
    var sf = parseCol(v('--surface'), mix(bg, tx, 0.04));
    S.dark = dark;
    var P = S.pal, RGB = {};
    RGB.text = tx; RGB.muted = mu; RGB.faint = fa; RGB.accent = ac;
    for (var k in HUES) RGB[k] = parseCol(HUES[k][dark ? 1 : 0]);
    PN.forEach(function (n, i) { P[i] = css(RGB[n]); });
    S.rgb = RGB;
    S.col = {
      bg: css(bg), surface: css(mix(bg, sf, 1)), grid: css(mix(bg, tx, dark ? 0.2 : 0.16)),
      rock: css(mix(bg, tx, dark ? 0.12 : 0.08)), rockEdge: css(mix(bg, tx, dark ? 0.2 : 0.15)),
      track: css(mix(bg, tx, dark ? 0.15 : 0.1)), trackEdge: css(mix(bg, tx, dark ? 0.24 : 0.18)),
      box: css(mix(bg, tx, dark ? 0.07 : 0.035)), chip: css(mix(bg, tx, dark ? 0.04 : 0.02)),
      accBg: css(mix(bg, ac, dark ? 0.18 : 0.12)), bad: css(RGB.red, 0.85), sel: css(ac),
      font: (v('--font-mono') || '').trim() || 'ui-monospace, Menlo, Consolas, monospace'
    };
    S.oreTint = {};
    for (var oc in ORES) S.oreTint[oc] = css(mix(bg, RGB[ITEMS[ORES[oc].res].col], (dark ? 0.2 : 0.15) * (ORES[oc].rich ? 1.8 : 1)));
    buildAtlas();
  }

  // ---- glyph atlas: every (colour, char) pair rendered once at device resolution ----
  var AT_COLS = 24, AT_ROWS = 14;
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.col || !S.CS) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    var fs = Math.max(9, Math.round(S.CS * 0.6));
    S.fs = fs;
    a.cwp = Math.ceil((fs * 0.75 + 6) * S.k); a.chp = Math.ceil((fs * 1.25 + 6) * S.k);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (fs * S.k).toFixed(2) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k; a.ch = a.chp / S.k; a.n = 0; a.max = AT_COLS * AT_ROWS;
    a.map = {};
  }
  function gIdx(ci, ch) {
    var a = S.atl, key = ci + ch, i = a.map[key];
    if (i !== undefined) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(ch, (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    a.map[key] = i;
    return i;
  }
  // a glyph centred on (x, y) (logical px), scaled by sc, rotated by rot quarter turns
  function glyph(c, ci, ch, x, y, sc, rot) {
    var i = gIdx(ci, ch), a = S.atl;
    sc = sc || 1;
    if (i < 0) {
      c.font = '700 ' + (S.fs * sc).toFixed(1) + 'px ' + S.col.font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(ch, x, y);
      return;
    }
    var w = a.cw * sc, h = a.ch * sc, sx = (i % AT_COLS) * a.cwp, sy = ((i / AT_COLS) | 0) * a.chp;
    if (rot) {
      c.save(); c.translate(x, y); c.rotate(rot * Math.PI / 2);
      c.drawImage(a.cv, sx, sy, a.cwp, a.chp, -w / 2, -h / 2, w, h);
      c.restore();
    } else {
      var dx = Math.round((x - w / 2) * S.k) / S.k, dy = Math.round((y - h / 2) * S.k) / S.k;
      c.drawImage(a.cv, sx, sy, a.cwp, a.chp, dx, dy, w, h);
    }
  }
  function text(c, ci, s, x, y, sc, align) {
    var cw = S.fs * 0.62 * (sc || 1), n = s.length, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) if (s.charAt(i) !== ' ') glyph(c, ci, s.charAt(i), x0 + i * cw + cw / 2, y, sc);
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  }

  // ---- the board ----
  function view() { return S.sim || S.link; }
  function relink() { S.link = newSim(S.lv, S.L); }
  function cellIndex(x, y) { return y * S.gw + x; }
  function inGrid(x, y) { return x >= 0 && y >= 0 && x < S.gw && y < S.gh; }

  function draw() {
    if (!S || !S.ctx || !S.atl || !S.lv || !S.L) return;
    var c = S.ctx, cs = S.CS, W = S.gw, H = S.gh, lv = S.lv, col = S.col, V = view(), x, y, i, e;
    var alpha = S.sim ? S.alpha : 1, tick = S.sim ? S.sim.tick : 0, ease = alpha;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = col.bg; c.fillRect(0, 0, W * cs, H * cs);
    // ground
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var ch = tileAt(lv, x, y), px = x * cs, py = y * cs;
      if (ch === '#') {
        c.fillStyle = col.rock; c.fillRect(px, py, cs, cs);
        c.fillStyle = col.rockEdge;
        var hs = ((x * 7 + y * 13) % 3);
        c.fillRect(px + cs * (0.2 + hs * 0.18), py + cs * 0.3, Math.max(2, cs * 0.12), Math.max(1, cs * 0.06));
        c.fillRect(px + cs * (0.55 - hs * 0.1), py + cs * 0.68, Math.max(2, cs * 0.16), Math.max(1, cs * 0.06));
      } else if (ORES[ch]) {
        c.fillStyle = S.oreTint[ch]; rrect(c, px + 1, py + 1, cs - 2, cs - 2, Math.max(2, cs * 0.14)); c.fill();
        if (!S.L[cellIndex(x, y)]) {
          var it = ITEMS[ORES[ch].res], ci = PI[it.col];
          if (ORES[ch].rich) { glyph(c, ci, it.ch, px + cs * 0.3, py + cs * 0.32, 0.6); glyph(c, ci, it.ch, px + cs * 0.7, py + cs * 0.4, 0.6); glyph(c, ci, it.ch, px + cs * 0.42, py + cs * 0.7, 0.6); }
          else { glyph(c, ci, it.ch, px + cs * 0.32, py + cs * 0.36, 0.6); glyph(c, ci, it.ch, px + cs * 0.68, py + cs * 0.64, 0.6); }
        }
      } else if (!isPortCh(ch)) {
        c.fillStyle = col.grid;
        var dd = Math.max(1.5, cs * 0.06);
        c.fillRect(px + cs / 2 - dd / 2, py + cs / 2 - dd / 2, dd, dd);
      }
    }
    // belt tracks under everything
    c.lineCap = 'butt'; c.lineJoin = 'round';
    for (i = 0; i < V.ents.length; i++) {
      e = V.ents[i];
      if (e.t !== 'belt') continue;
      var cx = (e.x + 0.5) * cs, cy = (e.y + 0.5) * cs, a = e.inSide, d = e.d;
      c.beginPath();
      c.moveTo(cx + DX[a] * cs / 2, cy + DY[a] * cs / 2); c.lineTo(cx, cy); c.lineTo(cx + DX[d] * cs / 2, cy + DY[d] * cs / 2);
      c.strokeStyle = col.trackEdge; c.lineWidth = cs * 0.54; c.stroke();
      c.strokeStyle = col.track; c.lineWidth = cs * 0.42; c.stroke();
    }
    for (i = 0; i < V.ents.length; i++) {
      e = V.ents[i];
      if (e.t === 'belt') {
        var ph = S.sim && S.running ? ((tick + alpha) * 0.5) % 1 : 0.5;
        glyph(c, PI.faint, '>', (e.x + 0.5) * cs + DX[e.d] * cs * (ph - 0.5) * 0.4, (e.y + 0.5) * cs + DY[e.d] * cs * (ph - 0.5) * 0.4, 0.7, e.d);
      } else drawPiece(c, e, cs, tick, alpha);
    }
    // items on the move
    if (S.sim) {
      var ents = S.sim.ents;
      for (i = 0; i < ents.length; i++) {
        e = ents[i];
        if (e.item) drawItem(c, e.item, e.x, e.y, tick, ease, 1);
        if (e.slots[0]) drawItem(c, e.slots[0], e.x, e.y, tick, ease, 1);
        if (e.slots[1]) drawItem(c, e.slots[1], e.x, e.y, tick, ease, 1);
      }
      var gh = S.sim.ghosts;
      for (i = 0; i < gh.length; i++) {
        var g = gh[i], gx = g.fx + (g.tx - g.fx) * ease, gy = g.fy + (g.ty - g.fy) * ease;
        c.globalAlpha = Math.max(0, 1 - ease * ease);
        glyph(c, PI[ITEMS[g.k].col], ITEMS[g.k].ch, (gx + 0.5) * cs, (gy + 0.5) * cs, 0.9 - 0.35 * ease);
        c.globalAlpha = 1;
      }
    }
    if (S.flow) drawFlow(c, V, cs);
    // cursor: hover preview / selection
    var hv = S.hover;
    if (hv && inGrid(hv.x, hv.y) && !S.drag) drawCursor(c, hv.x, hv.y, cs);
    if (S.sel && S.tool === 'inspect') {
      c.strokeStyle = col.sel; c.lineWidth = 2; c.setLineDash([4, 3]);
      rrect(c, S.sel.x * cs + 1, S.sel.y * cs + 1, cs - 2, cs - 2, 4); c.stroke(); c.setLineDash([]);
    }
    drawFx(c, cs);
  }
  function drawItem(c, it, x, y, tick, ease, sc) {
    var t = it.mt === tick ? ease : 1, ix = it.fx + (x - it.fx) * t, iy = it.fy + (y - it.fy) * t, d = ITEMS[it.k];
    var px = (ix + 0.5) * S.CS, py = (iy + 0.5) * S.CS;
    c.fillStyle = S.col.chip;
    c.beginPath(); c.arc(px, py, S.CS * 0.25, 0, Math.PI * 2); c.fill();
    glyph(c, PI[d.col], d.ch, px, py, 0.85 * sc);
  }
  function pieceCol(e) {
    if (e.t === 'extractor') { var o = ORES[tileAt(S.lv, e.x, e.y)]; return PI[ITEMS[o ? o.res : 'fe'].col]; }
    return PI[MCOL[e.t] || 'muted'];
  }
  function drawPiece(c, e, cs, tick, alpha) {
    var px = e.x * cs, py = e.y * cs, cx = px + cs / 2, cy = py + cs / 2, ci = pieceCol(e), col = S.col;
    var ins = Math.max(2, Math.round(cs * 0.09)), rad = Math.max(3, cs * 0.18);
    if (e.t === 'port') {
      var ch = tileAt(S.lv, e.x, e.y);
      c.fillStyle = col.accBg; rrect(c, px + ins, py + ins, cs - ins * 2, cs - ins * 2, rad); c.fill();
      c.strokeStyle = S.pal[PI.accent]; c.lineWidth = 2; c.stroke();
      var want = portWants(e), done = false;
      if (S.sim && !S.lv.sandbox) {
        done = true;
        S.sim.goals.forEach(function (g) { if (g.port === e.pid && (g.got < g.n || rateOf(g.ring) < g.rate)) done = false; });
      }
      if (done) glyph(c, PI.green, '+', cx, cy, 0.95);
      else if (want.length) glyph(c, PI[ITEMS[want[0]].col], ITEMS[want[0]].ch, cx, cy, 0.8);
      else glyph(c, PI.accent, '@', cx, cy, 0.8);
      if (ch >= '1' && ch <= '4') text(c, PI.accent, ch, px + cs * 0.2, py + cs * 0.22, 0.5);
      return;
    }
    c.fillStyle = e.t === 'extractor' ? S.oreTint[tileAt(S.lv, e.x, e.y)] || col.box : col.box;
    rrect(c, px + ins, py + ins, cs - ins * 2, cs - ins * 2, rad); c.fill();
    c.strokeStyle = S.pal[ci]; c.lineWidth = MACHINES[e.t] ? 1.8 : 1.4; c.stroke();
    var big = 0.95;
    if (e.t === 'splitter' || e.t === 'merger') {
      // splitter: a fork with its stem to the input; merger: an arrowhead pointing out
      if (e.t === 'splitter') glyph(c, ci, 'Y', cx, cy, big, (e.d + 1) & 3);
      else glyph(c, ci, '>', cx, cy, big, e.d);
      var outs = e.t === 'splitter' ? e.outs : [e.d];
      for (var k = 0; k < outs.length; k++) glyph(c, PI.faint, '>', cx + DX[outs[k]] * cs * 0.4, cy + DY[outs[k]] * cs * 0.4, 0.5, outs[k]);
    } else if (e.t === 'cross') {
      glyph(c, ci, '+', cx, cy, big);
    } else {
      glyph(c, ci, PGLYPH[e.t], cx, cy - (S.sim ? cs * 0.04 : 0), 0.82);
      glyph(c, ci, '>', cx + DX[e.d] * cs * 0.38, cy + DY[e.d] * cs * 0.38, 0.55, e.d);
      if (S.sim) {
        if (e.timer > 0) {
          var tot = e.t === 'extractor' ? e.rt : e.cur.t, f = Math.min(1, (tot - e.timer + alpha) / tot);
          c.fillStyle = S.pal[ci];
          c.fillRect(px + ins + 3, py + cs - ins - 4, (cs - ins * 2 - 6) * f, Math.max(1.5, cs * 0.05));
        }
        var st = status(e);
        if (st === 'full') glyph(c, PI.red, '!', px + cs - ins - cs * 0.12, py + ins + cs * 0.14, 0.55);
        else if (st === 'idle' && S.sim.tick > 12) glyph(c, PI.faint, '.', px + cs - ins - cs * 0.12, py + ins + cs * 0.1, 0.6);
      }
    }
  }
  function portWants(e) {
    if (S.lv.sandbox) return [];
    var out = [];
    S.lv.goals.forEach(function (g) { if ((g.port || 0) === e.pid && out.indexOf(g.item) < 0) out.push(g.item); });
    return out;
  }
  function drawFlow(c, V, cs) {
    for (var i = 0; i < V.ents.length; i++) {
      var e = V.ents[i];
      if (e.t === 'belt' || e.t === 'cross') continue;
      var r = e.t === 'port' ? portRate(e) : rateOf(e.ring);
      var s = String(r);
      c.fillStyle = S.col.bg; c.globalAlpha = 0.85;
      var w = s.length * S.fs * 0.62 * 0.5 + 4;
      c.fillRect(e.x * cs + 1, e.y * cs + 1, w, S.fs * 0.6);
      c.globalAlpha = 1;
      text(c, r ? PI.accent : PI.faint, s, e.x * cs + 3, e.y * cs + 1 + S.fs * 0.3, 0.5);
    }
  }
  function portRate(e) {
    return S.sim ? rateOf(e.rin) : 0;
  }
  function drawCursor(c, x, y, cs) {
    var px = x * cs, py = y * cs, t = S.tool, col = S.col;
    if (t === 'inspect') {
      c.strokeStyle = col.sel; c.globalAlpha = 0.5; c.lineWidth = 1.5;
      rrect(c, px + 1, py + 1, cs - 2, cs - 2, 4); c.stroke(); c.globalAlpha = 1;
      return;
    }
    if (t === 'erase') {
      c.strokeStyle = col.bad; c.lineWidth = 1.5;
      rrect(c, px + 1, py + 1, cs - 2, cs - 2, 4); c.stroke();
      glyph(c, PI.red, 'x', px + cs / 2, py + cs / 2, 0.8);
      return;
    }
    var ok = canPlace(S.lv, x, y, t), cur = S.L[cellIndex(x, y)];
    if (cur && cur.t === t) {   // a tap here rotates it
      c.strokeStyle = col.sel; c.lineWidth = 1.5; rrect(c, px + 1, py + 1, cs - 2, cs - 2, 4); c.stroke();
      glyph(c, PI.accent, '>', px + cs / 2 + DX[(cur.d + 1) & 3] * cs * 0.3, py + cs / 2 + DY[(cur.d + 1) & 3] * cs * 0.3, 0.5, (cur.d + 1) & 3);
      return;
    }
    c.globalAlpha = ok ? 0.55 : 0.35;
    var ghost = { t: t, d: S.dir, x: x, y: y, outs: [S.dir], inSide: back(S.dir), timer: 0, out: [] };
    if (t === 'belt') {
      var cx = px + cs / 2, cy = py + cs / 2;
      c.strokeStyle = col.track; c.lineWidth = cs * 0.42; c.beginPath();
      c.moveTo(cx - DX[S.dir] * cs / 2, cy - DY[S.dir] * cs / 2); c.lineTo(cx + DX[S.dir] * cs / 2, cy + DY[S.dir] * cs / 2); c.stroke();
      glyph(c, PI.accent, '>', cx, cy, 0.8, S.dir);
    } else {
      if (t === 'splitter') ghost.outs = [S.dir, left(S.dir), right(S.dir)];
      var keep = S.sim; S.sim = null;
      drawPiece(c, ghost, cs, 0, 1);
      S.sim = keep;
    }
    c.globalAlpha = 1;
    if (!ok) { c.strokeStyle = col.bad; c.lineWidth = 1.5; rrect(c, px + 1, py + 1, cs - 2, cs - 2, 4); c.stroke(); }
  }

  // ---- particles ----
  function burst(x, y, n, chars, ci, spd) {
    if (S.rm) n = Math.min(n, 3);
    for (var i = 0; i < n && S.fx.length < 120; i++) {
      var a = Math.random() * Math.PI * 2, v = (spd || 1.4) * (0.4 + Math.random());
      S.fx.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.6, t: 0, life: 0.5 + Math.random() * 0.5, ch: chars.charAt(i % chars.length), ci: ci });
    }
  }
  function stepFx(dt) {
    var fx = S.fx;
    for (var i = fx.length - 1; i >= 0; i--) {
      var p = fx[i];
      p.t += dt;
      if (p.t >= p.life) { fx.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 2.2 * dt;
    }
  }
  function drawFx(c, cs) {
    for (var i = 0; i < S.fx.length; i++) {
      var p = S.fx[i];
      c.globalAlpha = Math.max(0, 1 - p.t / p.life);
      glyph(c, p.ci, p.ch, p.x * cs, p.y * cs, 0.6);
    }
    c.globalAlpha = 1;
  }

  // ---- running the line ----
  function startLoop() { if (S && !S.raf && !S.hidden) { S.last = performance.now(); S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(now) {
    if (!S) return;
    S.raf = 0;
    var dt = Math.min(0.1, Math.max(0, (now - S.last) / 1000));
    S.last = now;
    if (S.running && S.sim) {
      S.acc += dt * SPEEDS[S.speedIx].tps;
      var n = 0;
      while (S.acc >= 1 && n < 240) { S.acc -= 1; tick(); n++; if (!S || !S.running) break; }
      if (!S) return;
      S.alpha = S.running ? Math.min(1, S.acc) : 1;
    } else if (S.anim) {
      S.alpha = Math.min(1, (now - S.anim) / (1000 / 8));
      if (S.alpha >= 1) S.anim = 0;
    }
    stepFx(dt);
    draw();
    updateHud();
    if (S.running || S.anim || S.fx.length) S.raf = requestAnimationFrame(frame);
  }
  function ensureSim() { if (!S.sim) { S.sim = newSim(S.lv, S.L); S.acc = 0; S.alpha = 1; } }
  function tick() {
    var sim = S.sim;
    step(sim);
    var ev = sim.events, gh = sim.ghosts, pinged = false;
    for (var i = 0; i < gh.length; i++) {
      if (!gh[i].port) continue;
      if (!pinged) { sfx('ping'); pinged = true; }
      if (S.fx.length < 60) burst(gh[i].tx + 0.5, gh[i].ty + 0.3, 1, '+', PI[ITEMS[gh[i].k].col], 0.8);
    }
    if (ev.indexOf('win') >= 0) onWin();
  }
  function run() {
    if (!S || S.card) return;
    S.snd.ensure();
    ensureSim();
    if (S.sim.won && !S.lv.sandbox && S.winSeen === S.sim) { /* keep running after a win: fine */ }
    S.running = true; S.anim = 0;
    sfx('run');
    syncCtl(); startLoop();
  }
  function pauseSim() {
    if (!S || !S.running) return;
    S.running = false;
    syncCtl(); draw(); updateHud();
  }
  function stepOnce() {
    if (!S || S.card) return;
    S.snd.ensure();
    ensureSim();
    S.running = false;
    tick();
    S.alpha = 0; S.anim = performance.now();
    syncCtl(); startLoop();
  }
  function resetSim(quiet) {
    if (!S) return;
    var had = !!S.sim;
    S.sim = null; S.running = false; S.anim = 0; S.acc = 0; S.alpha = 1;
    if (had && !quiet) sfx('stop');
    syncCtl(); draw(); updateHud();
  }
  function cycleSpeed() {
    S.speedIx = (S.speedIx + 1) % SPEEDS.length;
    S.save.speedIx = S.speedIx; persist();
    sfx('click'); syncCtl();
  }
  function onWin() {
    var sim = S.sim, lv = S.lv;
    S.running = false; S.alpha = 1; S.acc = 0;
    var res = record(S.save, lv, S.L, sim.tick);
    S.save.lv[lv.id].work = encode(lv, S.L);
    persist();
    sfx('win');
    if (Cade.haptic) Cade.haptic(18);
    sim.ents.forEach(function (e) { if (e.t === 'port') burst(e.x + 0.5, e.y + 0.5, 14, '*+.o', PI.gold, 2.4); });
    S.winSeen = sim;
    setTimeout(function () { if (S && S.sim === sim) showCard('win', res); }, S.rm ? 0 : 450);
    syncCtl(); startLoop();
  }

  // ---- editing ----
  function setInfo(html) { if (S && S.infoHtml !== html) { S.infoHtml = html; S.info.innerHTML = html; } }
  function toolHint() {
    var t = S.tool;
    if (t === 'inspect') return '<b>Inspect</b> — tap a tile to see what it is doing' + (S.coarse ? '' : ' · hover works too');
    if (t === 'erase') return '<b>Erase</b> — tap or drag to remove' + (S.coarse ? '' : ' · right-drag erases with any tool');
    var p = PIECES[t];
    return '<b>' + esc(p.name) + '</b> <span class="fl-cost">$' + p.cost + '</span> — ' + esc(p.info) +
      (t === 'belt' ? ' · drag to paint a line' : '') + ' · facing ' + DIRARROW[S.dir] + ' (' + (S.coarse ? 'tap a placed one to turn it' : 'R / arrows turn') + ')';
  }
  function info(x, y) {
    if (!inGrid(x, y)) return toolHint();
    var i = cellIndex(x, y), ch = tileAt(S.lv, x, y), V = view(), e = V.grid[i], sim = S.sim, out;
    if (ch === '#') return '<b>Rock</b> — nothing can be built here';
    if (!e) {
      if (ORES[ch]) return '<b>' + esc(ITEMS[ORES[ch].res].name) + (ORES[ch].rich ? ' (rich)' : '') + '</b> — put an extractor here (' + (ORES[ch].rich ? 30 : 15) + '/min)';
      return S.tool === 'inspect' ? 'Empty floor' : toolHint();
    }
    var name = e.t === 'port' ? (e.pid ? 'Port ' + e.pid : 'Port') : PIECES[e.t].name;
    out = '<b>' + esc(name) + '</b>';
    if (e.t !== 'port' && e.t !== 'cross') out += ' ' + DIRARROW[e.d];
    if (e.t === 'port') {
      if (S.lv.sandbox) {
        out += ' — accepts anything';
      } else {
        var w = portWants(e);
        out += ' — wants ' + w.map(function (k) { return itemLabel(k); }).join(', ');
        if (sim) sim.goals.forEach(function (g) { if (g.port === e.pid) out += ' · ' + g.got + '/' + g.n + ' · ' + rateOf(g.ring) + '/min'; });
      }
      return out;
    }
    if (e.t === 'extractor') out += ' on ' + esc(ITEMS[e.res].name.toLowerCase());
    if (e.t === 'belt' && sim && e.item) out += ' · carrying ' + itemLabel(e.item.k);
    if (e.t === 'splitter') out += ' · ' + (e.outs.length ? e.outs.length + ' output' + (e.outs.length > 1 ? 's' : '') : '<span class="fl-bad">no outputs</span>');
    if (MACHINES[e.t] && sim) {
      var bits = [];
      for (var k in e.buf) if (e.buf[k]) bits.push(itemTag(k) + '×' + e.buf[k]);
      if (bits.length) out += ' · in ' + bits.join(' ');
      if (e.cur) out += ' · making ' + itemLabel(e.cur.out);
    }
    if (sim && (MACHINES[e.t] || e.t === 'extractor')) {
      var st = status(e);
      out += ' · ' + (st === 'work' ? 'working' : st === 'full' ? '<span class="fl-bad">output blocked</span>' : '<span class="fl-dim">waiting for input</span>');
    }
    if (!sim && (MACHINES[e.t] || e.t === 'extractor') && !e.outs.length) out += ' · <span class="fl-dim">nothing ahead to take its output</span>';
    if (sim) out += ' · <b>' + rateOf(e.ring) + '</b>/min out';
    return out;
  }
  function refreshInfo() {
    if (!S) return;
    var c = S.sel && S.tool === 'inspect' ? S.sel : S.hover;
    setInfo(c ? info(c.x, c.y) : toolHint());
  }
  function layoutChanged() {
    if (S.sim) resetSim(true);
    relink();
    syncCost();
  }
  function placeAt(x, y, t, d, quiet) {
    if (!canPlace(S.lv, x, y, t)) {
      if (!quiet) {
        sfx('no');
        var ch = tileAt(S.lv, x, y);
        setInfo('<span class="fl-bad">' + (t === 'extractor' && ch !== '#' && !isPortCh(ch) ? 'Extractors only go on ore tiles' : ch === '#' ? 'Rock — build somewhere else' : 'Can\'t build on a port') + '</span>');
      }
      return false;
    }
    var i = cellIndex(x, y), cur = S.L[i];
    if (cur && cur.t === t && cur.d === d) return false;
    S.L[i] = { t: t, d: d };
    return true;
  }
  function eraseAt(x, y) {
    if (!inGrid(x, y)) return false;
    var i = cellIndex(x, y);
    if (!S.L[i]) return false;
    S.L[i] = null;
    burst(x + 0.5, y + 0.5, 4, '.\'`', PI.faint, 1);
    return true;
  }
  function pushUndo(before) {
    S.undo.push(before);
    if (S.undo.length > 200) S.undo.shift();
    S.redo.length = 0;
  }
  function restore(str) {
    var L = decode(S.lv, str);
    if (!L) return;
    S.L = L; layoutChanged(); saveWork(); draw(); refreshInfo(); syncCtl();
  }
  function undo() { if (!S.undo.length) return; S.redo.push(encode(S.lv, S.L)); restore(S.undo.pop()); sfx('rot'); }
  function redo() { if (!S.redo.length) return; S.undo.push(encode(S.lv, S.L)); restore(S.redo.pop()); sfx('rot'); }
  function saveWork() {
    var str = encode(S.lv, S.L);
    if (S.lv.sandbox) S.save.sbWork = str;
    else {
      var r = S.save.lv[S.lv.id] || (S.save.lv[S.lv.id] = { stars: 0, cost: 0, tiles: 0, ticks: 0, best: '', work: '' });
      r.work = str;
    }
    clearTimeout(S.saveT);
    S.saveT = setTimeout(persist, 300);
  }
  function setTool(t) {
    if (t !== 'inspect' && t !== 'erase' && S.lv.tools.indexOf(t) < 0) return;
    S.tool = t;
    if (t !== 'inspect') S.sel = null;
    syncTools(); refreshInfo(); draw();
  }
  function setDir(d) { S.dir = d & 3; syncCtl(); refreshInfo(); draw(); }
  function rotateAction(ccw) {
    var c = S.tool === 'inspect' ? S.sel : null, i = c ? cellIndex(c.x, c.y) : -1;
    if (c && S.L[i]) {
      var before = encode(S.lv, S.L);
      S.L[i] = { t: S.L[i].t, d: (S.L[i].d + (ccw ? 3 : 1)) & 3 };
      pushUndo(before); layoutChanged(); saveWork(); sfx('rot'); draw(); refreshInfo();
      return;
    }
    setDir(S.dir + (ccw ? 3 : 1)); sfx('rot');
  }

  // pointer gestures on the board
  function cellFromEvent(ev) {
    var r = S.cv.getBoundingClientRect();
    if (!r.width) return null;
    var x = Math.floor((ev.clientX - r.left) / r.width * S.gw), y = Math.floor((ev.clientY - r.top) / r.height * S.gh);
    return inGrid(x, y) ? { x: x, y: y } : null;
  }
  function dirTo(a, b) { return b.x > a.x ? 0 : b.y > a.y ? 1 : b.x < a.x ? 2 : 3; }
  function onDown(ev) {
    if (!S || S.card || ev.button === 1) return;
    ev.preventDefault();
    S.snd.ensure();
    var c = cellFromEvent(ev);
    if (!c) return;
    try { S.cv.setPointerCapture(ev.pointerId); } catch (x) {}
    var erase = ev.button === 2 || S.tool === 'erase', i = cellIndex(c.x, c.y), cur = S.L[i];
    S.drag = { id: ev.pointerId, erase: erase, last: c, moved: false, before: encode(S.lv, S.L), start: cur ? { t: cur.t, d: cur.d } : null, lastBelt: false, shift: ev.shiftKey };
    S.hover = c;
    if (S.tool === 'inspect' && !erase) { S.sel = c; refreshInfo(); draw(); return; }
    var changed = false;
    if (erase) { changed = eraseAt(c.x, c.y); if (changed) sfx('erase'); }
    else if (cur && cur.t === S.tool) { S.drag.lastBelt = cur.t === 'belt'; }
    else {
      changed = placeAt(c.x, c.y, S.tool, S.dir);
      if (changed) { sfx(S.tool === 'belt' ? 'belt' : 'place'); S.drag.lastBelt = S.tool === 'belt'; }
    }
    if (changed) { layoutChanged(); draw(); refreshInfo(); }
  }
  function onMove(ev) {
    if (!S) return;
    var c = cellFromEvent(ev), d = S.drag;
    if (!d || d.id !== ev.pointerId) {
      if (ev.pointerType === 'mouse') {
        var h = S.hover;
        if ((!c && h) || (c && (!h || h.x !== c.x || h.y !== c.y))) { S.hover = c; refreshInfo(); if (!S.raf) draw(); }
      }
      return;
    }
    if (!c || (c.x === d.last.x && c.y === d.last.y)) return;
    var changed = false;
    // walk one tile at a time from the last cell to this one
    var guard = 0;
    while ((d.last.x !== c.x || d.last.y !== c.y) && guard++ < 64) {
      var dx = c.x - d.last.x, dy = c.y - d.last.y, n;
      if (Math.abs(dx) >= Math.abs(dy)) n = { x: d.last.x + (dx > 0 ? 1 : -1), y: d.last.y };
      else n = { x: d.last.x, y: d.last.y + (dy > 0 ? 1 : -1) };
      d.moved = true;
      if (d.erase) { if (eraseAt(n.x, n.y)) { changed = true; sfx('erase'); } }
      else if (S.tool === 'belt') {
        var dir = dirTo(d.last, n), li = cellIndex(d.last.x, d.last.y), lp = S.L[li];
        if (d.lastBelt && lp && lp.t === 'belt' && lp.d !== dir) { S.L[li] = { t: 'belt', d: dir }; changed = true; }
        var ni = cellIndex(n.x, n.y), np = S.L[ni];
        if (!np || np.t === 'belt') {
          if (placeAt(n.x, n.y, 'belt', dir, true)) { changed = true; sfx('belt'); }
          d.lastBelt = !!S.L[ni] && S.L[ni].t === 'belt';
        } else d.lastBelt = false;
        S.dir = dir;
      } else if (S.tool === 'inspect') { S.sel = n; }
      d.last = n;
    }
    S.hover = c;
    if (changed) layoutChanged();
    if (changed || S.tool === 'inspect') { draw(); refreshInfo(); syncCtl(); }
  }
  function onUp(ev) {
    if (!S) return;
    var d = S.drag;
    if (!d || d.id !== ev.pointerId) return;
    S.drag = null;
    if (!d.moved && !d.erase && S.tool !== 'inspect' && d.start && d.start.t === S.tool) {
      var i = cellIndex(d.last.x, d.last.y);
      S.L[i] = { t: d.start.t, d: (d.start.d + (d.shift ? 3 : 1)) & 3 };
      S.dir = S.L[i].d;
      sfx('rot');
      layoutChanged();
    }
    var after = encode(S.lv, S.L);
    if (after !== d.before) { pushUndo(d.before); saveWork(); }
    if (ev.pointerType !== 'mouse') S.hover = null;
    draw(); refreshInfo(); syncCtl();
  }

  // ---- DOM: hud, tools, controls ----
  function lvIndex(lv) { return LEVELS.indexOf(lv); }
  function lvTitle(lv) { return lv.sandbox ? 'Sandbox' : pad2(lvIndex(lv) + 1) + ' · ' + lv.name; }
  function renderHud() {
    var lv = S.lv, h = '<div class="fl-hl"><button type="button" class="fl-lvbtn" data-a="intro" title="Level info">' + esc(lvTitle(lv)) + '</button>' +
      '<span class="fl-coststat"></span></div><div class="fl-goals">';
    if (lv.sandbox) h += '<span class="fl-goal fl-sbx">Ports count everything delivered</span>';
    lv.goals.forEach(function (g, i) {
      h += '<span class="fl-goal" data-g="' + i + '">' + itemTag(g.item) + (g.port ? '<i class="fl-port">→' + g.port + '</i>' : '') +
        '<span class="fl-gn"></span><span class="fl-gr"></span></span>';
    });
    h += '</div>';
    S.hud.innerHTML = h;
    S.hudKey = '';
    updateHud(); syncCost();
  }
  function syncCost() {
    var st = stats(S.L), el = S.hud.querySelector('.fl-coststat'), lv = S.lv;
    if (!el) return;
    var cOk = !lv.sandbox && st.tiles > 0 && st.cost <= lv.par.cost, tOk = !lv.sandbox && st.tiles > 0 && st.tiles <= lv.par.tiles;
    el.innerHTML = '<span class="' + (cOk ? 'ok' : '') + '" title="Cost' + (lv.sandbox ? '' : ' (par $' + lv.par.cost + ')') + '">$' + st.cost + (lv.sandbox ? '' : '<i>/' + lv.par.cost + '</i>') + '</span>' +
      '<span class="' + (tOk ? 'ok' : '') + '" title="Tiles used' + (lv.sandbox ? '' : ' (par ' + lv.par.tiles + ')') + '">' + st.tiles + (lv.sandbox ? '' : '<i>/' + lv.par.tiles + '</i>') + ' tiles</span>';
  }
  function updateHud() {
    if (!S || !S.lv) return;
    var sim = S.sim, lv = S.lv, key = sim ? sim.tick + ':' + (S.running ? 1 : 0) : 'none';
    if (key === S.hudKey) return;
    S.hudKey = key;
    if (lv.sandbox) {
      var g0 = S.hud.querySelector('.fl-goals');
      if (!sim || !Object.keys(sim.box).length) { g0.innerHTML = '<span class="fl-goal fl-sbx">' + (sim ? 'Running · t ' + sim.tick : 'Ports count everything delivered') + '</span>'; }
      else {
        var ks = Object.keys(sim.box).sort(function (a, b) { return sim.box[b] - sim.box[a]; }).slice(0, 5);
        g0.innerHTML = ks.map(function (k) {
          return '<span class="fl-goal">' + itemTag(k) + '<span class="fl-gn">' + sim.box[k] + '</span><span class="fl-gr">' + rateOf(sim.boxRing[k]) + '/min</span></span>';
        }).join('');
      }
    } else {
      lv.goals.forEach(function (g, i) {
        var el = S.hud.querySelector('[data-g="' + i + '"]');
        if (!el) return;
        var sg = sim ? sim.goals[i] : null, got = sg ? sg.got : 0, rate = sg ? rateOf(sg.ring) : 0;
        var nOk = got >= g.n, rOk = rate >= g.rate;
        el.querySelector('.fl-gn').textContent = Math.min(got, 999) + '/' + g.n;
        var gr = el.querySelector('.fl-gr');
        gr.textContent = (sim ? rate : '–') + '/' + g.rate + ' per min';
        gr.classList.toggle('ok', !!sim && rOk);
        el.querySelector('.fl-gn').classList.toggle('ok', nOk);
        el.classList.toggle('done', nOk && rOk);
        el.title = ITEMS[g.item].name + ': deliver ' + g.n + (g.port ? ' to port ' + g.port : '') + ' at ' + g.rate + ' or more a minute (60 ticks)';
      });
    }
    if (S.tool === 'inspect' && S.sel && sim) refreshInfo();
    else if (S.hover && sim && S.running) refreshInfo();
    var tk = S.ctl.querySelector('.fl-tick');
    if (tk) tk.textContent = sim ? 't ' + sim.tick : '';
  }
  function buildTools() {
    var lv = S.lv, h = '';
    var list = ['inspect'].concat(lv.tools).concat(['erase']);
    list.forEach(function (t, n) {
      var g, nm, cost = '', key = '';
      if (t === 'inspect') { g = '?'; nm = 'Inspect'; key = 'Q'; }
      else if (t === 'erase') { g = 'x'; nm = 'Erase'; key = 'X'; }
      else { g = PGLYPH[t]; nm = PIECES[t].name; cost = '$' + PIECES[t].cost; key = n <= 10 ? String(n === 10 ? 0 : n) : ''; }
      var colc = t === 'erase' ? 'red' : t === 'inspect' ? 'muted' : t === 'extractor' ? 'iron' : (MCOL[t] || 'muted');
      h += '<button type="button" class="fl-tool" data-t="' + t + '" title="' + esc(nm) + (cost ? ' ' + cost : '') + (key ? ' (' + key + ')' : '') + '">' +
        '<b class="fl-tg fl-c-' + colc + (t === 'belt' || t === 'merger' || t === 'splitter' ? ' fl-rot' : '') + '">' + esc(g) + '</b><span class="fl-tn">' + esc(nm) + '</span>' +
        (cost ? '<i>' + cost + '</i>' : '') + '</button>';
    });
    S.tools.innerHTML = h;
    syncTools();
  }
  function syncTools() {
    var bs = S.tools.querySelectorAll('.fl-tool');
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute('data-t') === S.tool;
      bs[i].classList.toggle('on', on);
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      var g = bs[i].querySelector('.fl-rot');
      if (g) g.style.transform = 'rotate(' + (S.dir * 90 + (bs[i].getAttribute('data-t') === 'splitter' ? 90 : 0)) + 'deg)';
    }
  }
  function buildCtl() {
    S.ctl.innerHTML =
      '<div class="fl-cg"><button type="button" data-c="rot" title="Turn (R)">' + IC.rot + '<span class="fl-dir"></span></button>' +
      '<button type="button" data-c="undo" title="Undo (Ctrl+Z)">' + IC.undo + '</button>' +
      '<button type="button" data-c="redo" title="Redo (Ctrl+Y)">' + IC.redo + '</button></div>' +
      '<div class="fl-cg fl-sim"><button type="button" data-c="reset" title="Stop and clear items (Backspace)">' + IC.stop + '</button>' +
      '<button type="button" data-c="step" title="One tick (N)">' + IC.step + '</button>' +
      '<button type="button" data-c="run" class="fl-run"></button>' +
      '<button type="button" data-c="speed" class="fl-speed" title="Speed (F)"></button><span class="fl-tick"></span></div>' +
      '<div class="fl-cg"><button type="button" data-c="flow" title="Show rates (T)">' + IC.flow + '</button>' +
      '<button type="button" data-c="menu" title="Menu (Esc)">' + IC.menu + '</button></div>';
    syncCtl();
  }
  function syncCtl() {
    if (!S) return;
    var q = function (c) { return S.ctl.querySelector('[data-c="' + c + '"]'); };
    var rb = q('run');
    rb.innerHTML = (S.running ? IC.pause : IC.play) + '<span>' + (S.running ? 'Pause' : S.sim ? 'Resume' : 'Run') + '</span>';
    rb.title = (S.running ? 'Pause' : 'Run') + ' (Space)';
    rb.classList.toggle('on', S.running);
    q('speed').textContent = SPEEDS[S.speedIx].n;
    q('reset').disabled = !S.sim;
    q('undo').disabled = !S.undo.length;
    q('redo').disabled = !S.redo.length;
    q('flow').classList.toggle('on', !!S.flow);
    q('rot').querySelector('.fl-dir').textContent = DIRARROW[S.dir];
    var tk = S.ctl.querySelector('.fl-tick');
    if (tk) tk.textContent = S.sim ? 't ' + S.sim.tick : '';
    syncTools(); syncHead();
  }
  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]'), pb = S.head.querySelector('[data-h="pause"]');
    sb.innerHTML = S.snd.on ? IC.sndOn : IC.sndOff;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
    pb.innerHTML = S.running ? IC.pause : IC.play;
    pb.title = S.running ? 'Pause (Space)' : 'Run (Space)';
    pb.setAttribute('aria-label', pb.title);
    pb.disabled = !!S.card;
  }

  // ---- overlay cards ----
  function newTools(lv) {
    var i = lvIndex(lv);
    if (i <= 0) return lv.tools.slice();
    var prev = LEVELS[i - 1].tools;
    return lv.tools.filter(function (t) { return prev.indexOf(t) < 0; });
  }
  function goalLine(g) {
    return 'Deliver <b>' + g.n + ' × ' + itemLabel(g.item) + '</b>' + (g.port ? ' to port <b>' + g.port + '</b>' : '') + ' at <b>' + g.rate + '/min</b> or more';
  }
  function recipeRows(machines) {
    var h = '';
    machines.forEach(function (m) {
      var rs = RECIPES[m];
      if (m === 'painter') {
        h += '<div><span class="fl-rm fl-c-' + MCOL[m] + '">' + PIECES[m].name + '</span> gear / plate / frame / robot + ' + itemTag('red') + ' or ' + itemTag('blu') + ' → painted <i>(' + rs[0].t + ' t)</i></div>';
        return;
      }
      rs.forEach(function (r) {
        var ins = Object.keys(r.in).map(function (k) { return (r.in[k] > 1 ? r.in[k] + '×' : '') + itemTag(k); }).join(' + ');
        h += '<div><span class="fl-rm fl-c-' + MCOL[m] + '">' + PIECES[m].name + '</span> ' + ins + ' → ' + (r.n > 1 ? r.n + '×' : '') + itemLabel(r.out) + ' <i>(' + r.t + ' t)</i></div>';
      });
    });
    return h;
  }
  function showCard(kind, data) {
    if (!S) return;
    if (S.running) pauseSim();
    S.card = kind;
    var lv = S.lv, h = '', sv = S.save;
    if (kind === 'levels') {
      h = '<div class="fl-card fl-wide"><div class="fl-title">FACTORY LINES</div>' +
        '<div class="fl-sub">★ ' + totalStars(sv) + ' / ' + LEVELS.length * 3 + ' · build lines that hit the rate</div><div class="fl-lvls">';
      LEVELS.forEach(function (L2, i) {
        var r = sv.lv[L2.id], st = r ? r.stars : 0, open2 = unlocked(sv, i);
        h += '<button type="button" class="fl-lv' + (st ? ' done' : '') + (open2 ? '' : ' locked') + (L2 === lv ? ' cur' : '') + '" data-lv="' + L2.id + '"' + (open2 ? '' : ' aria-disabled="true"') + '>' +
          '<span class="no">' + pad2(i + 1) + '</span><span class="nm">' + esc(L2.name) + '</span><span class="st">' + (open2 ? starStr(st) : '—') + '</span></button>';
      });
      h += '</div><div class="fl-btns"><button type="button" class="fl-go" data-lv="sandbox">Sandbox</button>' +
        '<button type="button" class="fl-go alt" data-a="help">How to play</button></div>' +
        (S.sim || lv ? '<div class="fl-foot"><button type="button" class="fl-lnk" data-a="close">Back to ' + esc(lvTitle(lv)) + '</button></div>' : '') + '</div>';
    } else if (kind === 'intro') {
      var nt = newTools(lv), r0 = sv.lv[lv.id];
      h = '<div class="fl-card"><div class="fl-title">' + esc(lvTitle(lv).toUpperCase()) + '</div><p>' + lv.intro + '</p>';
      if (!lv.sandbox) {
        h += '<div class="fl-goalbox">' + lv.goals.map(goalLine).join('<br>') + '</div>';
        if (nt.length) h += '<div class="fl-new">' + nt.map(function (t) { return 'New: <b>' + esc(PIECES[t].name) + '</b> — ' + esc(PIECES[t].info); }).join('<br>') + '</div>';
        var ms = lv.tools.filter(function (t) { return MACHINES[t]; });
        if (ms.length) h += '<details class="fl-rec"><summary>Recipes</summary>' + recipeRows(ms) + '</details>';
        h += '<div class="fl-note">Par $' + lv.par.cost + ' · ' + lv.par.tiles + ' tiles' + (r0 && r0.stars ? ' · best ' + starStr(r0.stars) + ' $' + r0.cost + ' · ' + r0.tiles + ' tiles' : '') + '</div>';
      }
      h += '<div class="fl-btns"><button type="button" class="fl-go" data-a="close">Build</button><button type="button" class="fl-go alt" data-a="levels">Levels</button></div></div>';
    } else if (kind === 'help') {
      var tl = S.lv.tools;
      h = '<div class="fl-card fl-wide"><div class="fl-title">HOW TO PLAY</div>' +
        '<p>Mine ore with <b>extractors</b>, carry it on <b>belts</b>, turn it into parts in <b>machines</b> and deliver it to the <b>port</b>. ' +
        'A level is won when the port has its count <b>and</b> the last 60 ticks (a minute) delivered at least the asked rate.</p>' +
        '<p>Belts move an item one tile per tick and take items from behind — or from one side to turn a corner. Machines output ahead (the little arrow) and accept from the other three sides. ' +
        'A full machine shows <b class="fl-c-red">!</b>; a waiting one a dot.</p>' +
        '<div class="fl-h">Controls</div><div class="fl-keys">' +
        (S.coarse ? '<span><b>Tap</b> to place · <b>drag</b> to paint belts · tap a placed piece to <b>turn</b> it</span><span><b>Erase</b> tool removes · <b>?</b> inspects a tile</span>'
          : '<span><b>Click</b> to place · <b>drag</b> paints belts · click a placed piece to turn it</span><span><b>Right-drag</b> erases · <b>R</b> / arrows set the facing · <b>1–9</b> pick a piece · <b>Q</b> inspect · <b>X</b> erase</span>' +
            '<span><b>Space</b> run / pause · <b>N</b> one tick · <b>F</b> speed · <b>Backspace</b> stop · <b>T</b> rates · <b>Ctrl+Z / Y</b> undo / redo</span>') +
        '</div><div class="fl-h">Pieces</div><div class="fl-tab">';
      PIECE_ORDER.forEach(function (t) {
        if (t === 'port' && !S.lv.sandbox) return;
        var have = tl.indexOf(t) >= 0;
        h += '<div class="' + (have ? '' : 'off') + '"><b class="fl-ig fl-c-' + (t === 'extractor' ? 'iron' : MCOL[t] || 'muted') + '">' + esc(PGLYPH[t]) + '</b> <b>' + esc(PIECES[t].name) + '</b> <i>$' + PIECES[t].cost + '</i> — ' + (have ? esc(PIECES[t].info) : 'unlocks later') + '</div>';
      });
      h += '</div><div class="fl-h">Recipes</div><div class="fl-tab">' + recipeRows(['smelter', 'cutter', 'assembler', 'painter']) + '</div>' +
        '<div class="fl-h">Stars</div><p>★ for solving · ★ for a cost at or under par · ★ for using no more tiles than par. Your best solution is saved per level.</p>' +
        '<div class="fl-btns"><button type="button" class="fl-go" data-a="close">Got it</button></div></div>';
    } else if (kind === 'win') {
      var res = data, best = res.best;
      h = '<div class="fl-card"><div class="fl-title">LINE COMPLETE</div><div class="fl-stars">' +
        [0, 1, 2].map(function (i) { return '<span class="' + (i < res.stars ? 'on' : '') + '" style="animation-delay:' + (i * 0.15) + 's">' + (i < res.stars ? '★' : '☆') + '</span>'; }).join('') + '</div>' +
        '<div class="fl-tab fl-res"><div>Solved in ' + S.sim.tick + ' ticks <b class="fl-c-gold">★</b></div>' +
        '<div>Cost <b>$' + res.cost + '</b> <i>par $' + lv.par.cost + '</i> ' + (res.cost <= lv.par.cost ? '<b class="fl-c-gold">★</b>' : '<i>☆</i>') + '</div>' +
        '<div>Tiles <b>' + res.tiles + '</b> <i>par ' + lv.par.tiles + '</i> ' + (res.tiles <= lv.par.tiles ? '<b class="fl-c-gold">★</b>' : '<i>☆</i>') + '</div></div>' +
        (res.newBest ? '<div class="fl-new2">New best solution saved</div>' : res.first ? '<div class="fl-new2">Solution saved</div>' : '<div class="fl-note">Best: ' + starStr(best.stars) + ' $' + best.cost + ' · ' + best.tiles + ' tiles</div>') +
        (res.stars < 3 ? '<div class="fl-note">' + (res.cost > lv.par.cost ? 'Fewer machines or shorter belts beat the par cost. ' : '') + (res.tiles > lv.par.tiles ? 'A tighter footprint beats the par tiles.' : '') + '</div>' : '');
      var ni = lvIndex(lv) + 1;
      h += '<div class="fl-btns">' + (ni < LEVELS.length ? '<button type="button" class="fl-go" data-lv="' + LEVELS[ni].id + '">Next level</button>' : '<button type="button" class="fl-go" data-lv="sandbox">Sandbox</button>') +
        '<button type="button" class="fl-go alt" data-a="close">Keep building</button></div>' +
        '<div class="fl-foot"><button type="button" class="fl-lnk" data-a="levels">Levels</button>' + (allSolved(sv) ? '<span>All levels done!</span>' : ni >= LEVELS.length ? '<span>' + LEVELS.filter(function (L4) { return !solved(sv, L4.id); }).length + ' level(s) still to solve</span>' : '') + '</div></div>';
    } else if (kind === 'menu') {
      var rr = sv.lv[lv.id];
      h = '<div class="fl-card"><div class="fl-title">MENU</div><div class="fl-menu">' +
        '<button type="button" class="fl-go" data-a="close">Back to the board</button>' +
        '<button type="button" class="fl-go alt" data-a="levels">Levels</button>' +
        (lv.sandbox ? '' : '<button type="button" class="fl-go alt" data-a="intro">Level brief</button>') +
        '<button type="button" class="fl-go alt" data-a="help">How to play</button>' +
        (!lv.sandbox && rr && rr.best ? '<button type="button" class="fl-go alt" data-a="loadbest">Load best solution · ' + starStr(rr.stars) + ' $' + rr.cost + '</button>' : '') +
        (S.clearArm ? '<div class="fl-confirm">Clear the whole board? <button type="button" class="fl-lnk danger" data-a="clear-yes">Clear</button> <button type="button" class="fl-lnk" data-a="clear-no">Keep</button></div>'
          : '<button type="button" class="fl-go alt" data-a="clear">Clear board</button>') +
        '</div>';
      if (lv.sandbox) {
        h += '<div class="fl-h">Saved layouts</div><div class="fl-slots">';
        for (var s = 0; s < 3; s++) {
          var str = sv.sb[s], L3 = str ? decode(SANDBOX, str) : null, st3 = L3 ? stats(L3) : null;
          h += '<div class="fl-slot"><span>Slot ' + (s + 1) + ' <i>' + (st3 ? '$' + st3.cost + ' · ' + st3.tiles + ' tiles' : 'empty') + '</i></span>' +
            '<button type="button" class="fl-lnk" data-a="sbsave" data-s="' + s + '">Save</button>' +
            (st3 ? '<button type="button" class="fl-lnk" data-a="sbload" data-s="' + s + '">Load</button>' : '') + '</div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }
    S.ovl.innerHTML = h;
    S.ovl.style.display = 'flex';
    S.ovl.scrollTop = 0;
    S.root.classList.add('dim');
    fitCard();
    syncHead();
    var f = S.ovl.querySelector('.fl-go');
    if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  // let the stage grow to fit a card (up to what the window allows)
  function fitCard() {
    var card = S.ovl.firstChild;
    S.root.style.minHeight = '';
    if (!card) return;
    var want = card.offsetHeight + 16, vh = window.innerHeight || 600, vv = window.visualViewport, r = S.root.getBoundingClientRect();
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var room = vh - Math.max(0, r.top) - 16;
    if (want > S.root.offsetHeight) S.root.style.minHeight = Math.max(S.root.offsetHeight, Math.min(want, room)) + 'px';
  }
  function hideCard() {
    if (!S) return;
    S.card = null; S.clearArm = false;
    S.ovl.style.display = 'none'; S.ovl.innerHTML = '';
    S.root.style.minHeight = '';
    S.root.classList.remove('dim');
    syncHead(); draw();
  }
  function onCard(ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b || !S) return;
    S.snd.ensure();
    var a = b.getAttribute('data-a'), lvId = b.getAttribute('data-lv');
    if (lvId) {
      var idx = LEVELS.indexOf(levelById(lvId));
      if (idx >= 0 && !unlocked(S.save, idx)) { sfx('no'); if (Cade.showToast) Cade.showToast('Solve the earlier levels first', 'info', 1600); return; }
      sfx('click'); hideCard(); loadLevel(lvId);
      return;
    }
    sfx('click');
    if (a === 'close') hideCard();
    else if (a === 'levels') showCard('levels');
    else if (a === 'help') showCard('help');
    else if (a === 'intro') showCard('intro');
    else if (a === 'loadbest') {
      var r = S.save.lv[S.lv.id];
      if (r && r.best) { pushUndo(encode(S.lv, S.L)); restore(r.best); }
      hideCard();
    } else if (a === 'clear') { S.clearArm = true; showCard('menu'); }
    else if (a === 'clear-no') { S.clearArm = false; showCard('menu'); }
    else if (a === 'clear-yes') {
      pushUndo(encode(S.lv, S.L)); restore(encode(S.lv, emptyLayout(S.lv)));
      hideCard();
    } else if (a === 'sbsave') {
      var si = +b.getAttribute('data-s');
      S.save.sb[si] = encode(S.lv, S.L); persist();
      if (Cade.showToast) Cade.showToast('Saved to slot ' + (si + 1), 'success', 1400);
      showCard('menu');
    } else if (a === 'sbload') {
      var sj = +b.getAttribute('data-s'), str = S.save.sb[sj];
      if (str) { pushUndo(encode(S.lv, S.L)); restore(str); }
      hideCard();
    }
  }

  // ---- levels ----
  function loadLevel(id) {
    var lv = levelById(id) || LEVELS[0];
    S.sim = null; S.running = false; S.anim = 0; S.acc = 0; S.alpha = 1;
    S.lv = lv;
    var sz = levelSize(lv);
    S.gw = sz.w; S.gh = sz.h;
    var work = lv.sandbox ? S.save.sbWork : (S.save.lv[lv.id] && S.save.lv[lv.id].work);
    S.L = (work && decode(lv, work)) || emptyLayout(lv);
    S.undo = []; S.redo = []; S.sel = null; S.hover = null; S.fx.length = 0; S.winSeen = null;
    if (S.tool !== 'inspect' && S.tool !== 'erase' && lv.tools.indexOf(S.tool) < 0) S.tool = 'belt';
    S.save.last = lv.id;
    relink();
    var first = !S.save.seen[lv.id];
    S.save.seen[lv.id] = true;
    persist();
    renderHud(); buildTools(); syncCtl();
    layout();
    refreshInfo();
    draw();
    if (first) showCard('intro');
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height || !S.stage.offsetHeight) return vh - (vw <= 560 ? 300 : 280);
    var chrome = r.height - S.stage.offsetHeight;
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.root.offsetHeight - S.stage.offsetHeight) + 30;
    }
    return vh - Math.min(Math.max(0, r.top), 120) - chrome - 12;
  }
  function layout() {
    if (!S) return;
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    var maxW = phone ? vw - 34 : Math.min(vw - 60, solo ? 1000 : 660);
    var ah = Math.max(160, availH(vw, vh));
    var cs = Math.floor(Math.min(maxW / S.gw, ah / S.gh, phone ? 44 : solo ? 56 : 46));
    cs = Math.max(16, cs);
    var cw = cs * S.gw, ch = cs * S.gh, dpr = Math.min(2, window.devicePixelRatio || 1);
    var rootW = phone ? Math.max(cw, Math.min(maxW, 520)) : Math.max(cw, Math.min(maxW, 460));
    S.panel.style.setProperty('--fl-w', rootW + 'px');
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.minHeight = ch + 'px';
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / cw;
    S.CS = cs;
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (S.col) buildAtlas();
    if (S.card) fitCard();
  }

  // ---- keys ----
  function onKey(e) {
    if (!S) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;
    var t = e.target, inPanel = t && S.panel.contains(t);
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !inPanel) return;
    if (e.altKey) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey;
    if (S.card) {
      if (k === 'Escape') { e.preventDefault(); if (S.card === 'win' || S.card === 'intro' || S.card === 'help' || S.card === 'menu' || S.card === 'levels') hideCard(); }
      return;
    }
    if (mod) {
      if (k === 'z' || k === 'Z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y' || k === 'Y') { e.preventDefault(); redo(); }
      return;
    }
    if (t && t.tagName === 'BUTTON' && inPanel && (k === ' ' || k === 'Enter')) return;
    var handled = true;
    if (k === ' ' || k === 'Enter') { if (S.running) pauseSim(); else run(); }
    else if (k === 'r' || k === 'R') rotateAction(e.shiftKey);
    else if (k === 'ArrowRight') setDir(0);
    else if (k === 'ArrowDown') setDir(1);
    else if (k === 'ArrowLeft') setDir(2);
    else if (k === 'ArrowUp') setDir(3);
    else if (k === 'n' || k === 'N' || k === '.') stepOnce();
    else if (k === 'f' || k === 'F') cycleSpeed();
    else if (k === 'Backspace') resetSim();
    else if (k === 't' || k === 'T') { S.flow = !S.flow; syncCtl(); draw(); }
    else if (k === 'q' || k === 'Q') setTool('inspect');
    else if (k === 'x' || k === 'X' || k === 'Delete') setTool('erase');
    else if (k === 'Escape') showCard('menu');
    else if (k === 'h' || k === 'H' || k === '?') showCard('help');
    else if (/^[0-9]$/.test(k)) { var n = k === '0' ? 10 : +k, tl = S.lv.tools[n - 1]; if (tl) setTool(tl); else handled = false; }
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    var s = S;
    persist();
    S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.saveT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function open() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="fl"><div class="fl-hud"></div>' +
      '<div class="fl-stage"><canvas class="fl-cv" aria-label="Factory floor"></canvas></div>' +
      '<div class="fl-tools" role="toolbar" aria-label="Pieces"></div><div class="fl-ctl"></div><div class="fl-info" aria-live="polite"></div>' +
      '<div class="fl-ovl" style="display:none"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🏭 Factory Lines', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'fl-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC.help + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, root: p.querySelector('.fl'), hud: p.querySelector('.fl-hud'), stage: p.querySelector('.fl-stage'), cv: p.querySelector('.fl-cv'),
      ovl: p.querySelector('.fl-ovl'), tools: p.querySelector('.fl-tools'), ctl: p.querySelector('.fl-ctl'), info: p.querySelector('.fl-info'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      lv: null, L: null, link: null, sim: null, running: false, anim: 0, acc: 0, alpha: 1, raf: 0, last: 0,
      speedIx: ld.save.speedIx, tool: 'belt', dir: 0, hover: null, sel: null, drag: null, undo: [], redo: [], flow: false,
      pal: new Array(PN.length), col: null, atl: null, CS: 0, k: 1, gw: 1, gh: 1, fx: [], card: null, infoHtml: ''
    };
    S.ctx = S.cv.getContext('2d');
    p._onClose = teardown;
    buildCtl();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (!S) return; S.hidden = document.hidden; if (document.hidden) { pauseSim(); stopLoop(); } };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) { pauseSim(); S.drag = null; } };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () { if (!S || S.panel !== p) return; pauseSim(); S.drag = null; stopLoop(); });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); draw();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); draw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); draw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound / run-pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); sfx('click'); syncHead();
      } else if (h === 'pause') { if (S.running) pauseSim(); else run(); }
      else if (h === 'help') { if (S.card === 'help') hideCard(); else showCard('help'); }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    S.cv.addEventListener('touchstart', noTouch, { passive: false });
    S.cv.addEventListener('touchmove', noTouch, { passive: false });
    S.cv.addEventListener('touchend', noTouch, { passive: false });
    [S.tools, S.ctl].forEach(function (el) {
      el.addEventListener('touchend', function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (b && !b.disabled && e.cancelable) { e.preventDefault(); b.click(); }
      }, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerup', onUp);
    S.cv.addEventListener('pointercancel', onUp);
    S.cv.addEventListener('pointerleave', function (e) { if (S && e.pointerType === 'mouse' && !S.drag) { S.hover = null; refreshInfo(); draw(); } });
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.tools.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-t]') : null;
      if (!b || !S) return;
      S.snd.ensure(); sfx('click');
      var t = b.getAttribute('data-t');
      if (t === S.tool && t !== 'inspect' && t !== 'erase') { setDir(S.dir + 1); sfx('rot'); }
      else setTool(t);
    });
    S.ctl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-c]') : null;
      if (!b || !S || b.disabled) return;
      S.snd.ensure();
      var c = b.getAttribute('data-c');
      if (c === 'run') { if (S.running) pauseSim(); else run(); }
      else if (c === 'step') stepOnce();
      else if (c === 'reset') resetSim();
      else if (c === 'speed') cycleSpeed();
      else if (c === 'rot') rotateAction(false);
      else if (c === 'undo') undo();
      else if (c === 'redo') redo();
      else if (c === 'flow') { S.flow = !S.flow; sfx('click'); syncCtl(); draw(); }
      else if (c === 'menu') { sfx('click'); showCard('menu'); }
    });
    S.hud.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-a="intro"]') : null;
      if (b && S) { sfx('click'); showCard('intro'); }
    });
    S.ovl.addEventListener('click', onCard);

    layout();
    readTheme();
    loadLevel(S.save.last);
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); draw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { buildAtlas(); draw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'Automation puzzles — mine ore, run belts, splitters and machines, hit the delivery rate; 16 levels, star ratings and a sandbox',
    icon: '🏭',
    tags: 'game,puzzle,automation,factory,conveyor,logistics,belts,machines,sandbox',
    open: open,
    _engine: ENGINE
  });
})();
