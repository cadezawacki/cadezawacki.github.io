/* Maze Muncher — a speedy maze chase for Cade.txt.
 * Steer the muncher (C) through four original mazes, munch every dot, and keep
 * clear of four chasers with their own minds: Rook hunts you head-on (and rushes
 * as a maze empties), Vane cuts you off four tiles ahead, Flint flanks with
 * Rook, and Moss chases from afar but loses its nerve up close. Chasers take
 * turns to scatter to their corners and to chase; a power pellet (o) turns them
 * pale and slow — munch them for 200, 400, 800, 1600. Bonus treats bounce in
 * through the side tunnels and wander the maze before leaving again.
 * Every level is faster; the maze changes every couple of levels (with a short
 * intermission). One player, or two taking turns on one device (pass and play).
 * Movement is tile-based with smooth sub-tile positions on a fixed 120 Hz step
 * (accumulator + render interpolation). Turns are buffered and may be taken a
 * little before or after a corner (pre-turn): you cut the corner and gain a hair.
 * Arrows / WASD, swipes (on the maze or the pad) and a gamepad. Drawn in
 * monospace glyphs from a cached atlas over a pre-rendered maze; theme colours.
 * Records persist in Cade.store (cade-mazemuncher-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var STEP = 1 / 120;
  var W = 27, H = 31;
  var DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];   // up, left, down, right (also the tie order)
  var OPP = [2, 3, 0, 1];
  var PRE = 0.42;                 // pre-/post-turn window (tiles) — corners are taken this early or late
  var BASE = 10;                  // tiles / second: the yardstick for every speed
  var GX = 13, GY = 11;           // the tile just outside the chasers' door
  var HOUSE_Y = 13.5;             // the middle of the house (between its two rows)
  var HOME_X = [13, 13, 11, 15];
  var EXTRA_AT = 10000, MAX_LIVES = 6, LIVES = 3;
  var GHOST_PTS = [200, 400, 800, 1600], QUAD_BONUS = 2000;
  var ITEM_AT = [70, 170];        // dots eaten in a level when a treat bounces in
  var T_READY = 2.0, T_READY0 = 2.6, T_DIE = 1.75, T_CLEAR = 1.9, T_EAT = 0.5, T_INTER = 5.2;

  var CHASERS = [
    { id: 'rook', name: 'Rook', ch: '#', how: 'hunts you head-on, and rushes as the maze empties', corner: [W - 3, -3] },
    { id: 'vane', name: 'Vane', ch: '&', how: 'cuts you off: aims four tiles ahead of you', corner: [2, -3] },
    { id: 'flint', name: 'Flint', ch: '%', how: 'flanks: pins you between itself and Rook', corner: [W - 1, H + 1] },
    { id: 'moss', name: 'Moss', ch: '$', how: 'shy: chases from afar, backs off up close', corner: [0, H + 1] }
  ];
  var ITEMS = [
    { id: 'star', name: 'Starfruit', ch: '*', pts: 100 },
    { id: 'clover', name: 'Clover', ch: '+', pts: 200 },
    { id: 'donut', name: 'Donut', ch: '@', pts: 500 },
    { id: 'hat', name: 'Party hat', ch: '^', pts: 700 },
    { id: 'bolt', name: 'Bolt', ch: '!', pts: 1000 },
    { id: 'waffle', name: 'Waffle', ch: '=', pts: 2000 },
    { id: 'box', name: 'Mystery box', ch: '?', pts: 5000 }
  ];

  // Four original mazes, drawn as their left half (14 columns; column 13 is the
  // centre) and mirrored. # wall  . dot  o power pellet  (space) path  t tunnel
  // (chasers slow down)  - the chasers' door  H inside their house  P start.
  // Every maze shares the house (rows 12-15) and the door tile (13, 12).
  var MAZE_DEFS = [
    { id: 'meadow', name: 'Meadow', hue: 'acc', half: [
      '##############',
      '#......#.....#',
      '#o####.#.###.#',
      '#.####.#.###.#',
      '#.............',
      '#.####.##.####',
      '#.####.##....#',
      '#......#####.#',
      '######.#####.#',
      '######.......#',
      '######.##.####',
      '######.##     ',
      '######.## ###-',
      '######.## #HHH',
      'tttttt.## #HHH',
      '######.## ####',
      '######.##     ',
      '######.##.####',
      '######.......#',
      '#......#####.#',
      '#.####.#####.#',
      '#o..##........',
      '###.##.##.###.',
      '#...##.##....P',
      '#.####.##.####',
      '#......#.....#',
      '#.####.#.###.#',
      '#.####.#.###.#',
      '#.####.#.###.#',
      '#............#',
      '##############'] },
    { id: 'lanterns', name: 'Lanterns', hue: 'violet', half: [
      '##############',
      '#......#......',
      '#.####.#.####.',
      '#o####.#.####.',
      '#.............',
      '#.##.####.####',
      '#.##.####....#',
      '#.##......##.#',
      't.##.####.##.#',
      '#....####....#',
      '####.##...####',
      '####.##.#     ',
      '####.##.# ###-',
      '####.##.# #HHH',
      '####....# #HHH',
      '####.##.# ####',
      '####.##.#     ',
      '####.##...####',
      '#....####....#',
      '#.##.####.##.#',
      't.##......##.#',
      '#.####.#.###.#',
      '#o.....#.....P',
      '###.##.#.#.###',
      '#...##...#...#',
      '#.#####.####.#',
      '#.#####.####.#',
      '#.............',
      '#.####.#.####.',
      '#.............',
      '##############'] },
    { id: 'switchback', name: 'Switchback', hue: 'leaf', half: [
      '##############',
      '#o....#......#',
      '#.###.#.####.#',
      '#.###...####.#',
      '#.#####.#.....',
      '#.......#.###.',
      '###.###.#.###.',
      '#...###...#...',
      '#.#####.#.#.##',
      '#.......#...##',
      '#.##.#.####.##',
      '#.##.#.##     ',
      '#.##.#.## ###-',
      '#....#.## #HHH',
      '####.#.## #HHH',
      't......## ####',
      '####.#.##     ',
      '#....#.##.####',
      '#.##.#.......#',
      '#.##.#.#####.#',
      '#.##...#.....P',
      '#.####.#.###.#',
      '#o.....#.###.#',
      '###.##...###.#',
      '#...#####.....',
      '#.#.......###.',
      '#.#.#####.###.',
      '#.#.....#.....',
      '#.#####.#.####',
      '#.............',
      '##############'] },
    { id: 'crossings', name: 'Crossings', hue: 'flame', half: [
      '##############',
      '#.............',
      '#.###.#.#####.',
      '#o###.#.#####.',
      '#.....#.......',
      '###.#.###.###.',
      '###.#...#.###.',
      't...#.#.#.....',
      '#.###.#.#.####',
      '#.....#.......',
      '#.###.###.###.',
      '#.#.....#.....',
      '#.#.###.#.###-',
      '#...###...#HHH',
      '###.###.#.#HHH',
      't.......#.####',
      '###.#.###.....',
      '#...#.....####',
      '#.#####.#.####',
      '#.......#....#',
      '#.##.##.####.#',
      '#o##.##......P',
      '#.##.##.####.#',
      '#....##.####.#',
      '####......#..#',
      't...#.###.#.##',
      '###.#.###.#.##',
      '#...#.....#..#',
      '#.#####.#.##.#',
      '#.......#....#',
      '##############'] }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrapX(x) { return ((x % W) + W) % W; }

  // Small seeded PRNG (mulberry32) — a game is reproducible from its seed.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- mazes ----
  // cell: 0 wall, 1 path, 2 door, 3 house. dot: 0 none, 1 dot, 2 pellet. tun: chaser slow zone.
  function parseMaze(def, idx) {
    var rows = def.half.map(function (r) { return r + r.slice(0, 13).split('').reverse().join(''); });
    var n = W * H, m = {
      id: def.id, name: def.name, hue: def.hue, idx: idx, rows: rows,
      cell: new Uint8Array(n), dot: new Uint8Array(n), tun: new Uint8Array(n), home: null,
      px: 13, py: 23, ndots: 0, npellets: 0, tunRows: [], paths: []
    };
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var ch = rows[y].charAt(x), i = y * W + x;
        if (ch === '#') continue;
        if (ch === '-') { m.cell[i] = 2; continue; }
        if (ch === 'H') { m.cell[i] = 3; continue; }
        m.cell[i] = 1;
        m.paths.push(i);
        if (ch === '.') { m.dot[i] = 1; m.ndots++; }
        else if (ch === 'o') { m.dot[i] = 2; m.ndots++; m.npellets++; }
        else if (ch === 't') m.tun[i] = 1;
        else if (ch === 'P') { m.px = x; m.py = y; }
      }
      if (m.cell[y * W] === 1 && m.cell[y * W + W - 1] === 1) m.tunRows.push(y);
    }
    m.home = fieldTo(m, GX, GY);   // the eyes follow it straight back to the door
    return m;
  }
  var MAZES = MAZE_DEFS.map(parseMaze);
  // breadth-first distances to one tile over the paths (wrapping through tunnels)
  function fieldTo(m, tx, ty) {
    var n = W * H, f = new Int16Array(n), q = [ty * W + tx], h = 0;
    for (var k = 0; k < n; k++) f[k] = -1;
    f[q[0]] = 0;
    while (h < q.length) {
      var c = q[h++], cx = c % W, cy = (c / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = wrapX(cx + DIRS[d][0]), ny = cy + DIRS[d][1];
        if (ny < 0 || ny >= H) continue;
        var j = ny * W + nx;
        if (m.cell[j] === 1 && f[j] < 0) { f[j] = f[c] + 1; q.push(j); }
      }
    }
    return f;
  }
  function cellAt(m, x, y) { if (y < 0 || y >= H) return 0; return m.cell[y * W + wrapX(x)]; }
  function open(m, x, y) { return cellAt(m, x, y) === 1; }

  // ---- level tables ----
  // Levels 1-2 Meadow, 3-4 Lanterns, 5-6 Switchback, 7-8 Crossings, then Lanterns /
  // Switchback / Crossings three levels each, round and round.
  function mazeFor(L) { return L <= 8 ? Math.floor((L - 1) / 2) : 1 + Math.floor((L - 9) / 3) % 3; }
  function speeds(L, turbo) {
    var k = Math.min(L - 1, 8), x = Math.min(Math.max(0, L - 9), 8), b = BASE * (turbo ? 1.22 : 1);
    return {
      pac: b * (0.86 + 0.026 * k + 0.008 * x),       // 8.6 → 10.7 → 11.3 tiles/s
      pacFr: b * (0.94 + 0.02 * k + 0.008 * x),
      ghost: b * (0.79 + 0.033 * k + 0.008 * x),     // 7.9 → 10.5 → 11.1
      ghostFr: b * (0.5 + 0.012 * k),
      tunnel: b * (0.42 + 0.014 * k),
      eyes: b * 1.9,
      leave: b * 0.45,
      item: b * (0.42 + 0.01 * k)
    };
  }
  var FRIGHT = [6, 5, 4, 3.5, 3, 2.6, 2.3, 2, 1.8, 1.6, 1.4, 1.2];
  function frightTime(L) { return L - 1 < FRIGHT.length ? FRIGHT[L - 1] : 1; }
  // Alternating scatter / chase periods (s); after the last, chase for good.
  function modeTable(L) { return L === 1 ? [7, 20, 7, 20, 5, 20, 5] : L < 5 ? [7, 20, 7, 20, 5, 40, 2] : [5, 20, 5, 20, 4, 50, 1]; }
  function releaseRule(L) {
    var f = Math.max(0.25, 1 - 0.15 * (L - 1));
    return { at: [0, 0.4, 3.5 * f, 7 * f], dots: [0, 0, Math.round(24 * f), Math.round(55 * f)], idle: Math.max(2, 4 - 0.25 * (L - 1)) };
  }
  function itemFor(L, r) { return L - 1 < ITEMS.length ? L - 1 : Math.floor(r * ITEMS.length); }
  function rushOf(g) {
    var P = g.ps[g.cur], left = P.left, L = P.level;
    var n1 = 20 + 4 * Math.min(L - 1, 6);
    return left <= n1 / 2 ? 2 : left <= n1 ? 1 : 0;
  }

  // ---- a game ----
  function newGame(opts) {
    opts = opts || {};
    var seed = (opts.seed >>> 0) || 1, np = opts.players === 2 ? 2 : 1, L0 = clamp(opts.level | 0 || 1, 1, 99);
    var g = {
      seed: seed, rnd: rng(seed), np: np, turbo: !!opts.turbo, inter: opts.inter !== false,
      ps: [], cur: 0, phase: 'ready', pt: T_READY0, t: 0, acc: 0, steps: 0, ft: 0,
      m: null, sp: null, pac: null, gh: [], item: null, mode: 'scatter', mi: 0, modeT: 0, modes: null,
      frT: 0, frMax: 0, combo: 0, relT: 0, idleT: 0, lifeDots: 0, rel: null,
      events: [], pops: [], ate: [], dotsVer: 0, deathAt: null, eatAt: null,
      stats: { dots: 0, ghosts: 0, items: 0, pellets: 0, clears: 0, quads: 0 }, autoAt: -1, autoDir: -1
    };
    for (var i = 0; i < np; i++) g.ps.push({ n: i + 1, score: 0, lives: LIVES, level: L0, mi: mazeFor(L0), dots: null, left: 0, eaten: 0, extra: false, items: [], out: false, best: L0 });
    if (np === 2) { g.m = MAZES[g.ps[0].mi]; g.sp = speeds(L0, g.turbo); resetActors(g); g.phase = 'handoff'; g.pt = 0; }
    else startLevel(g);
    return g;
  }
  function cur(g) { return g.ps[g.cur]; }
  function startLevel(g) {
    var P = cur(g);
    P.mi = mazeFor(P.level);
    g.m = MAZES[P.mi];
    P.dots = new Uint8Array(g.m.dot);
    P.left = g.m.ndots; P.eaten = 0; P.itemsSp = 0;
    P.best = Math.max(P.best || 0, P.level);
    enterPlayer(g, T_READY);
  }
  // put the current player's level back on the board (a new level, a new life, a hand-off)
  function enterPlayer(g, readyT) {
    var P = cur(g);
    g.m = MAZES[P.mi];
    g.sp = speeds(P.level, g.turbo);
    g.modes = modeTable(P.level);
    g.rel = releaseRule(P.level);
    g.dotsVer++;
    resetActors(g);
    g.phase = 'ready'; g.pt = readyT;
  }
  function resetActors(g) {
    var m = g.m;
    g.pac = { x: m.px, y: m.py, px: m.px, py: m.py, dir: 1, want: -1, stop: false, face: 1, chew: 0 };
    g.gh = [];
    for (var i = 0; i < 4; i++) {
      var out = i === 0, h = { i: i, x: out ? GX : HOME_X[i], y: out ? GY : HOUSE_Y + (i === 2 ? -0.2 : i === 3 ? 0.2 : 0), dir: out ? 1 : (i === 2 ? 2 : 0), st: out ? 'out' : 'house', fr: false, rev: false, bd: i === 2 ? 1 : -1 };
      h.tx = h.x + (out ? -1 : 0); h.ty = h.y;
      h.px = h.x; h.py = h.y;
      g.gh.push(h);
    }
    g.item = null;
    g.mode = 'scatter'; g.mi = 0; g.modeT = 0;
    g.frT = 0; g.frMax = 0; g.combo = 0; g.relT = 0; g.idleT = 0; g.lifeDots = 0;
    g.autoAt = -1;
  }

  function ev(g, name) { g.events.push(name); }
  function addScore(g, n) {
    var P = cur(g);
    P.score += n;
    if (!P.extra && P.score >= EXTRA_AT) { P.extra = true; if (P.lives < MAX_LIVES) P.lives++; ev(g, 'extra'); }
  }

  // One fixed step.
  function step(g) {
    g.steps++; g.t += STEP; g.ft += STEP;
    var p = g.pac, i;
    if (p) { p.px = p.x; p.py = p.y; }
    for (i = 0; i < g.gh.length; i++) { g.gh[i].px = g.gh[i].x; g.gh[i].py = g.gh[i].y; }
    if (g.item) { g.item.px = g.item.x; g.item.py = g.item.y; }
    switch (g.phase) {
      case 'ready': g.pt -= STEP; if (g.pt <= 0) { g.phase = 'play'; ev(g, 'go'); } return;
      case 'eat': g.pt -= STEP; if (g.pt <= 0) g.phase = 'play'; return;
      case 'dying': g.pt -= STEP; if (g.pt <= 0) afterDeath(g); return;
      case 'clear': g.pt -= STEP; if (g.pt <= 0) nextLevel(g); return;
      case 'inter': g.pt -= STEP; if (g.pt <= 0) { g.phase = 'ready'; g.pt = T_READY; } return;
      case 'play': play(g); return;
      default: return;   // handoff / over: wait for the UI
    }
  }
  // Run real time through the fixed step; returns the interpolation fraction.
  function advance(g, dt, pilot) {
    g.acc = Math.min(g.acc + dt, STEP * 14);
    while (g.acc >= STEP - 1e-9) {   // (the epsilon: 60 Hz frames are exactly two steps)
      if (pilot && g.phase === 'play') pilot(g);
      step(g);
      g.acc = Math.max(0, g.acc - STEP);
    }
    return g.acc / STEP;
  }

  function play(g) {
    var P = cur(g), sp = g.sp, i;
    if (g.frT > 0) {
      g.frT -= STEP;
      if (g.frT <= 0) { g.frT = 0; for (i = 0; i < 4; i++) g.gh[i].fr = false; ev(g, 'frEnd'); }
    } else if (g.mi < g.modes.length) {
      g.modeT += STEP;
      if (g.modeT >= g.modes[g.mi]) {
        g.mi++; g.modeT = 0;
        g.mode = g.mi % 2 === 0 && g.mi < g.modes.length ? 'scatter' : 'chase';
        for (i = 0; i < 4; i++) if (g.gh[i].st === 'out') g.gh[i].rev = true;
      }
    }
    g.relT += STEP; g.idleT += STEP;
    release(g);
    movePac(g, (g.frT > 0 ? sp.pacFr : sp.pac) * STEP);
    eat(g);
    if (P.left <= 0) { g.phase = 'clear'; g.pt = T_CLEAR; g.item = null; g.stats.clears++; ev(g, 'clear'); return; }
    for (i = 0; i < 4; i++) moveGhost(g, g.gh[i]);
    collide(g);
    if (g.phase !== 'play') return;
    moveItem(g);
  }

  function release(g) {
    var R = g.rel;
    for (var i = 1; i < 4; i++) {
      var h = g.gh[i];
      if (h.st !== 'house') continue;
      if (g.relT >= R.at[i] || g.lifeDots >= R.dots[i] || g.idleT >= R.idle) {
        if (g.idleT >= R.idle) g.idleT = 0;
        h.st = 'leave';
      }
      return;   // one at a time, in order
    }
  }

  // ---- the muncher ----
  function movePac(g, d) {
    var p = g.pac, m = g.m, cx = Math.round(p.x), cy = Math.round(p.y), w = p.want;
    if (w >= 0 && w !== p.dir) {
      if (p.dir >= 0 && w === OPP[p.dir]) { p.dir = w; p.stop = false; }
      else {
        var off = p.dir < 0 ? 0 : (DIRS[p.dir][0] ? p.x - cx : p.y - cy);
        if (open(m, cx + DIRS[w][0], cy + DIRS[w][1]) && Math.abs(off) <= PRE) { p.dir = w; p.stop = false; }
      }
    }
    if (p.dir < 0) return;
    var D = DIRS[p.dir], moved = 0;
    if (D[0]) {
      var dy = clamp(cy - p.y, -d, d); p.y += dy;
      var nx = p.x + D[0] * d;
      if (!open(m, cx + D[0], cy) && (nx - cx) * D[0] >= 0) { moved = Math.abs(cx - p.x); nx = cx; p.stop = true; }
      else { moved = d; p.stop = false; }
      p.x = nx;
      if (p.x < -0.5) { p.x += W; p.px += W; } else if (p.x >= W - 0.5) { p.x -= W; p.px -= W; }
    } else {
      var dx = clamp(cx - p.x, -d, d); p.x += dx;
      var ny = p.y + D[1] * d;
      if (!open(m, cx, cy + D[1]) && (ny - cy) * D[1] >= 0) { moved = Math.abs(cy - p.y); ny = cy; p.stop = true; }
      else { moved = d; p.stop = false; }
      p.y = ny;
    }
    p.face = p.dir;
    if (!p.stop) p.chew += moved;
  }
  function eat(g) {
    var p = g.pac, m = g.m, P = cur(g), x = wrapX(Math.round(p.x)), y = Math.round(p.y), i = y * W + x, d = P.dots[i];
    if (d) {
      P.dots[i] = 0; P.left--; P.eaten++; g.lifeDots++; g.idleT = 0; g.stats.dots++;
      g.ate.push(i);
      if (d === 1) { addScore(g, 10); ev(g, 'dot'); }
      else { addScore(g, 50); g.stats.pellets++; ev(g, 'pellet'); fright(g); }
      if (P.itemsSp < ITEM_AT.length && P.eaten >= ITEM_AT[P.itemsSp] && !g.item) { P.itemsSp++; spawnItem(g); }
    }
    var it = g.item;
    if (it && dist2(it.x, it.y, p.x, p.y) < 0.5) {
      var I = ITEMS[it.k];
      addScore(g, I.pts); g.stats.items++;
      P.items.push(it.k); if (P.items.length > 7) P.items.shift();
      g.pops.push({ x: it.x, y: it.y, v: I.pts, k: 'item' });
      g.item = null; ev(g, 'item');
    }
  }
  function fright(g) {
    var L = cur(g).level;
    g.frT = g.frMax = frightTime(L); g.combo = 0;
    for (var i = 0; i < 4; i++) {
      var h = g.gh[i];
      if (h.st === 'eyes' || h.st === 'enter') continue;
      h.fr = true;
      if (h.st === 'out') h.rev = true;
    }
  }
  function dist2(ax, ay, bx, by) {
    var dx = Math.abs(ax - bx); if (dx > W / 2) dx = W - dx;
    var dy = ay - by;
    return dx * dx + dy * dy;
  }

  // ---- chasers ----
  function ghostTarget(g, i) {
    var p = g.pac, h = g.gh[i], C = CHASERS[i];
    var px = wrapX(Math.round(p.x)), py = Math.round(p.y), D = DIRS[p.face >= 0 ? p.face : 1];
    if (g.mode === 'scatter' && !(i === 0 && rushOf(g) > 0)) return C.corner;
    if (i === 0) return [px, py];
    if (i === 1) return [px + 4 * D[0], py + 4 * D[1]];
    if (i === 2) {
      var r = g.gh[0], vx = px + 2 * D[0], vy = py + 2 * D[1];
      return [2 * vx - Math.round(r.x), 2 * vy - Math.round(r.y)];
    }
    return dist2(h.x, h.y, p.x, p.y) > 64 ? [px, py] : C.corner;
  }
  // At a tile centre: the open way (never straight back, unless following a
  // distance field) that brings the target closest — or a random one (pale).
  function chooseDir(g, h, tx, ty, rand, field) {
    var m = g.m, cx = h.x, cy = h.y, best = -1, bd = Infinity, c = [], k;
    for (k = 0; k < 4; k++) {
      if (k === OPP[h.dir] && !field) continue;
      if (open(m, cx + DIRS[k][0], cy + DIRS[k][1])) c.push(k);
    }
    if (!c.length) return OPP[h.dir];
    if (rand) return c[Math.floor(g.rnd() * c.length) % c.length];
    for (var j = 0; j < c.length; j++) {
      k = c[j];
      var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1], dd;
      if (field) { dd = field[ny * W + wrapX(nx)]; if (dd < 0) dd = 1e9; }
      else { var ex = nx - tx, ey = ny - ty; dd = ex * ex + ey * ey; }
      if (dd < bd) { bd = dd; best = k; }
    }
    return best;
  }
  function ghostSpeed(g, h) {
    var sp = g.sp;
    if (h.st === 'eyes' || h.st === 'enter') return sp.eyes;
    if (h.st === 'leave' || h.st === 'house') return sp.leave;
    var tx = wrapX(Math.round(h.x)), ty = Math.round(h.y);
    if (ty >= 0 && ty < H && g.m.tun[ty * W + tx]) return sp.tunnel;
    if (h.fr) return sp.ghostFr;
    if (h.i === 0) { var r = rushOf(g); return sp.ghost * (r === 2 ? 1.1 : r === 1 ? 1.05 : 1); }
    return sp.ghost;
  }
  // Glide along centre lines; decide at each tile centre. Returns nothing.
  function navigate(h, d, decide) {
    if (h.rev) {
      h.rev = false;
      var R = DIRS[h.dir];
      h.tx -= R[0]; h.ty -= R[1]; h.dir = OPP[h.dir];
    }
    var guard = 0;
    while (d > 1e-9 && guard++ < 8) {
      var D = DIRS[h.dir], rem = Math.abs(h.tx - h.x) + Math.abs(h.ty - h.y);
      if (rem > d) { h.x += D[0] * d; h.y += D[1] * d; return; }
      h.x = h.tx; h.y = h.ty; d -= rem;
      if (h.x < 0) { h.x += W; h.px += W; h.wrapped = true; } else if (h.x >= W) { h.x -= W; h.px -= W; h.wrapped = true; }
      if (!decide(h)) return;
      D = DIRS[h.dir];
      h.tx = h.x + D[0]; h.ty = h.y + D[1];
    }
  }
  function moveGhost(g, h) {
    var d = ghostSpeed(g, h) * STEP, i = h.i;
    if (h.st === 'house') {
      h.y += h.bd * 2.2 * STEP;
      if (h.y > HOUSE_Y + 0.3) { h.y = HOUSE_Y + 0.3; h.bd = -1; }
      else if (h.y < HOUSE_Y - 0.3) { h.y = HOUSE_Y - 0.3; h.bd = 1; }
      h.dir = h.bd > 0 ? 2 : 0;
      return;
    }
    if (h.st === 'leave') {
      if (Math.abs(h.x - GX) > 1e-6) { var sx = clamp(GX - h.x, -d, d); h.x += sx; h.dir = sx < 0 ? 1 : 3; return; }
      h.y = Math.max(GY, h.y - d); h.dir = 0;
      if (h.y <= GY) {
        h.y = GY; h.st = 'out'; h.dir = 1; h.tx = GX - 1; h.ty = GY;
        if (g.frT <= 0) h.fr = false;
      }
      return;
    }
    if (h.st === 'enter') {
      if (h.y < HOUSE_Y) { h.y = Math.min(HOUSE_Y, h.y + d); h.dir = 2; return; }
      var hx = HOME_X[i] === 13 ? 13 : HOME_X[i];
      if (Math.abs(h.x - hx) > 1e-6) { var ex = clamp(hx - h.x, -d, d); h.x += ex; h.dir = ex < 0 ? 1 : 3; return; }
      h.st = 'leave'; h.fr = false; ev(g, 'revive');
      return;
    }
    // out / eyes
    navigate(h, d, function (hh) {
      if (hh.st === 'eyes' && hh.x === GX && hh.y === GY) { hh.st = 'enter'; hh.dir = 2; return false; }
      if (hh.st === 'eyes') { hh.dir = chooseDir(g, hh, GX, GY, false, g.m.home); return true; }
      if (hh.fr) { hh.dir = chooseDir(g, hh, 0, 0, true); return true; }
      var T = ghostTarget(g, i);
      hh.dir = chooseDir(g, hh, T[0], T[1], false);
      return true;
    });
  }
  function collide(g) {
    var p = g.pac;
    for (var i = 0; i < 4; i++) {
      var h = g.gh[i];
      if (h.st !== 'out') continue;
      var dx = Math.abs(h.x - p.x); if (dx > W / 2) dx = W - dx;
      if (dx >= 0.62 || Math.abs(h.y - p.y) >= 0.62) continue;
      if (h.fr) {
        var pts = GHOST_PTS[Math.min(g.combo, 3)];
        g.combo++;
        addScore(g, pts); g.stats.ghosts++;
        h.st = 'eyes'; h.fr = false; h.rev = false;
        g.pops.push({ x: h.x, y: h.y, v: pts, k: 'ghost', i: i });
        g.eatAt = { x: h.x, y: h.y, i: i, v: pts };
        g.phase = 'eat'; g.pt = T_EAT;
        ev(g, 'ghost');
        if (g.combo === 4) { addScore(g, QUAD_BONUS); g.stats.quads++; g.pops.push({ x: p.x, y: p.y - 1.4, v: QUAD_BONUS, k: 'quad' }); ev(g, 'quad'); }
        return;
      }
      g.phase = 'dying'; g.pt = T_DIE; g.deathAt = { x: p.x, y: p.y, i: i };
      g.item = null;
      ev(g, 'die');
      return;
    }
  }

  // ---- bouncing treats: in through a tunnel, a wander, out through a tunnel ----
  function spawnItem(g) {
    var m = g.m, rows = m.tunRows;
    if (!rows.length) return;
    var y = rows[Math.floor(g.rnd() * rows.length) % rows.length], left = g.rnd() < 0.5;
    var it = { k: itemFor(cur(g).level, g.rnd()), x: left ? 0 : W - 1, y: y, dir: left ? 3 : 1, st: 'in', life: 0, wrapped: false };
    it.tx = it.x + DIRS[it.dir][0]; it.ty = y; it.px = it.x; it.py = it.y;
    var t = m.paths[Math.floor(g.rnd() * m.paths.length) % m.paths.length];
    it.gx = t % W; it.gy = (t / W) | 0;
    g.item = it;
    ev(g, 'itemIn');
  }
  function moveItem(g) {
    var it = g.item;
    if (!it) return;
    it.life += STEP;
    if (it.st === 'in' && (it.life > 11 || dist2(it.x, it.y, it.gx, it.gy) < 2.5)) {
      it.st = 'leave';
      var rows = g.m.tunRows, y = rows[Math.floor(g.rnd() * rows.length) % rows.length];
      it.ex = g.rnd() < 0.5 ? 0 : W - 1; it.gy = y; it.gx = it.ex ? W + 3 : -4;
      it.field = fieldTo(g.m, it.ex, y);
    }
    it.wrapped = false;
    navigate(it, g.sp.item * STEP, function (h) {
      if (h.wrapped && h.st === 'leave') return false;
      if (h.st === 'leave' && h.x === h.ex && h.y === h.gy) h.dir = h.ex ? 3 : 1;   // out through the tunnel
      else h.dir = chooseDir(g, h, h.gx, h.gy, false, h.st === 'leave' ? h.field : null);
      return true;
    });
    if ((it.wrapped && it.st === 'leave') || it.life > 30) { g.item = null; ev(g, 'itemOut'); }
  }

  // ---- life, level, hand-off ----
  function afterDeath(g) {
    var P = cur(g);
    P.lives--;
    if (P.lives <= 0) { P.out = true; ev(g, 'out'); }
    var nxt = g.cur;
    if (g.np === 2) {
      var o = 1 - g.cur;
      if (!g.ps[o].out) nxt = o;
    }
    if (P.out && nxt === g.cur) { g.phase = 'over'; ev(g, 'over'); return; }
    if (nxt !== g.cur) { g.cur = nxt; g.phase = 'handoff'; g.pt = 0; return; }
    enterPlayer(g, T_READY);
  }
  // The next player tapped "ready".
  function handoffReady(g) {
    if (g.phase !== 'handoff') return false;
    var P = cur(g);
    if (!P.dots) { startLevel(g); g.pt = T_READY0; }
    else enterPlayer(g, T_READY);
    return true;
  }
  function nextLevel(g) {
    var P = cur(g), was = P.mi;
    P.level++;
    startLevel(g);
    ev(g, 'level');
    if (g.inter && P.mi !== was) { g.phase = 'inter'; g.pt = T_INTER; ev(g, 'inter'); }
  }
  function skipInter(g) { if (g.phase === 'inter') { g.phase = 'ready'; g.pt = T_READY; return true; } return false; }

  // ---- autopilot: the attract-mode demo (and the tests' fair player) ----
  // Breadth-first from the muncher's tile, around tiles near a live chaser, to
  // the nearest dot / treat / pale chaser; if hemmed in, the step away.
  function autoPilot(g) {
    var p = g.pac, m = g.m, P = cur(g), cx = wrapX(Math.round(p.x)), cy = Math.round(p.y), here = cy * W + cx;
    if (here === g.autoAt && p.want >= 0) return p.want;
    g.autoAt = here;
    var danger = new Uint8Array(W * H), i, k, hunt = g.frT > 1.2;
    for (i = 0; i < 4; i++) {
      var h = g.gh[i];
      if (h.st !== 'out' && h.st !== 'leave') continue;
      if (h.fr && g.frT > 0.8) continue;
      var hx = wrapX(Math.round(h.x)), hy = Math.round(h.y);
      for (var oy = -2; oy <= 2; oy++) for (var ox = -2; ox <= 2; ox++) {
        if (Math.abs(ox) + Math.abs(oy) > 2) continue;
        var yy = hy + oy;
        if (yy >= 0 && yy < H) danger[yy * W + wrapX(hx + ox)] = 1;
      }
    }
    var prev = new Int16Array(W * H), first = new Int8Array(W * H), q = [here], qh = 0, found = -1;
    for (i = 0; i < W * H; i++) prev[i] = -2;
    prev[here] = -1; first[here] = -1;
    var target = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) if (P.dots[i]) target[i] = 1;
    if (g.item) target[Math.round(g.item.y) * W + wrapX(Math.round(g.item.x))] = 1;
    if (hunt) for (i = 0; i < 4; i++) if (g.gh[i].fr && g.gh[i].st === 'out') target[Math.round(g.gh[i].y) * W + wrapX(Math.round(g.gh[i].x))] = 1;
    while (qh < q.length) {
      var c = q[qh++];
      if (c !== here && target[c]) { found = c; break; }
      var x = c % W, y = (c / W) | 0;
      for (k = 0; k < 4; k++) {
        var nx = wrapX(x + DIRS[k][0]), ny = y + DIRS[k][1];
        if (ny < 0 || ny >= H) continue;
        var j = ny * W + nx;
        if (m.cell[j] !== 1 || prev[j] !== -2 || danger[j]) continue;
        prev[j] = c; first[j] = c === here ? k : first[c];
        q.push(j);
      }
    }
    var dir = found >= 0 ? first[found] : -1;
    if (dir < 0) {                    // hemmed in: the open way that leads furthest from the nearest chaser
      var bd = -1;
      for (k = 0; k < 4; k++) {
        if (!open(m, cx + DIRS[k][0], cy + DIRS[k][1])) continue;
        var md = Infinity;
        for (i = 0; i < 4; i++) if (g.gh[i].st === 'out' && !g.gh[i].fr) md = Math.min(md, dist2(cx + DIRS[k][0], cy + DIRS[k][1], g.gh[i].x, g.gh[i].y));
        if (md > bd) { bd = md; dir = k; }
      }
    }
    if (dir >= 0) p.want = dir;
    return dir;
  }
  function setWant(g, dir) { if (g && g.pac && dir >= 0 && dir < 4) g.pac.want = dir; }

  // ---- results + records ----
  function summary(g) {
    return g.ps.map(function (P) { return { n: P.n, score: P.score, level: P.best || P.level, items: P.items.slice() }; });
  }
  function newSave() {
    return { v: 1, hi: [], best: { score: 0, level: 0 }, stats: { games: 0, dots: 0, ghosts: 0, items: 0, clears: 0, quads: 0 }, opt: { turbo: false, inter: true } };
  }
  function num(v, d) { v = +v; return isFinite(v) && v >= 0 ? Math.floor(v) : d; }
  function normSave(o) {
    var s = newSave();
    if (!o || typeof o !== 'object') return s;
    if (Array.isArray(o.hi)) {
      o.hi.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var sc = num(e.s, -1);
        if (sc < 0) return;
        s.hi.push({ s: sc, l: Math.max(1, num(e.l, 1)), p: e.p === 'P1' || e.p === 'P2' ? e.p : '1P', tb: !!e.tb, d: num(e.d, 0) });
      });
      s.hi.sort(function (a, b) { return b.s - a.s; });
      s.hi = s.hi.slice(0, 8);
    }
    if (o.best && typeof o.best === 'object') { s.best.score = num(o.best.score, 0); s.best.level = num(o.best.level, 0); }
    if (o.stats && typeof o.stats === 'object') for (var k in s.stats) s.stats[k] = num(o.stats[k], 0);
    if (o.opt && typeof o.opt === 'object') { s.opt.turbo = !!o.opt.turbo; s.opt.inter = o.opt.inter !== false; }
    return s;
  }
  // Fold a finished game into the save; returns what the results card shows.
  function settle(save, g, when) {
    var res = summary(g), card = { rows: res, ranks: [], bestScore: false, bestLevel: false };
    res.forEach(function (r) {
      var e = { s: r.score, l: r.level, p: g.np === 2 ? 'P' + r.n : '1P', tb: g.turbo, d: when || 0 };
      var rank = -1;
      if (r.score > 0) {
        save.hi.push(e);
        save.hi.sort(function (a, b) { return b.s - a.s || a.d - b.d; });
        rank = save.hi.indexOf(e);
        if (save.hi.length > 8) save.hi.length = 8;
        if (rank >= 8) rank = -1;
      }
      card.ranks.push(rank);
      if (r.score > save.best.score) { save.best.score = r.score; card.bestScore = true; }
      if (r.level > save.best.level) { save.best.level = r.level; card.bestLevel = true; }
    });
    save.stats.games++;
    ['dots', 'ghosts', 'items', 'clears', 'quads'].forEach(function (k) { save.stats[k] += g.stats[k]; });
    return card;
  }
  function hiScore(save) { return save.hi.length ? save.hi[0].s : 0; }

  var ENGINE = {
    STEP: STEP, W: W, H: H, DIRS: DIRS, OPP: OPP, PRE: PRE, GX: GX, GY: GY, HOUSE_Y: HOUSE_Y, HOME_X: HOME_X,
    GHOST_PTS: GHOST_PTS, QUAD_BONUS: QUAD_BONUS, EXTRA_AT: EXTRA_AT, ITEM_AT: ITEM_AT, LIVES: LIVES,
    CHASERS: CHASERS, ITEMS: ITEMS, MAZE_DEFS: MAZE_DEFS, MAZES: MAZES, T_EAT: T_EAT, T_DIE: T_DIE, T_INTER: T_INTER,
    rng: rng, parseMaze: parseMaze, open: open, cellAt: cellAt, mazeFor: mazeFor, speeds: speeds, frightTime: frightTime,
    modeTable: modeTable, releaseRule: releaseRule, newGame: newGame, step: step, advance: advance, movePac: movePac,
    ghostTarget: ghostTarget, chooseDir: chooseDir, fright: fright, autoPilot: autoPilot, setWant: setWant,
    handoffReady: handoffReady, skipInter: skipInter, nextLevel: nextLevel, spawnItem: spawnItem, rushOf: rushOf,
    summary: summary, newSave: newSave, normSave: normSave, settle: settle, hiScore: hiScore, cur: cur
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('mazemuncher.css');

  var PANEL_ID = 'mazemuncher-panel', NAME = 'Maze Muncher';
  var KEY = 'cade-mazemuncher-', SAVE_KEY = KEY + 'save', SOUND_KEY = KEY + 'sound';
  var T = 12, CW = 8, RH = 12, HUD_T = 26, HUD_B = 18, MY = HUD_T;
  var VW = W * T, VH = HUD_T + H * T + HUD_B;
  var S = null;   // the live session (one panel at a time)
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.mazemuncher = { live: function () { return S; }, engine: ENGINE };   // test-only peek

  // palette slots, filled from the theme (readTheme)
  var C_TEXT = 0, C_MUTED = 1, C_FAINT = 2, C_ACC = 3, C_GOLD = 4, C_RED = 5, C_ICE = 6, C_FLAME = 7, C_LEAF = 8, C_VIOLET = 9,
    C_PALE = 10, C_DOT = 11, NPAL = 12;
  var GHOST_SLOT = [C_RED, C_VIOLET, C_ICE, C_FLAME];
  var ITEM_SLOT = { star: C_GOLD, clover: C_LEAF, donut: C_FLAME, hat: C_VIOLET, bolt: C_ICE, waffle: C_GOLD, box: C_ACC };
  var HUE_SLOT = { acc: C_ACC, violet: C_VIOLET, leaf: C_LEAF, flame: C_FLAME };
  var MOUTH = [79, 67, 60, 67];          // O C < C: the muncher's chew, facing right
  var ROT = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];
  var NPART = 160, NPOP = 12;

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function loadSave() {
    var raw = sget(SAVE_KEY), o = null;
    if (raw) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    return { save: normSave(o), fresh: !raw };
  }
  function persist() { if (S) sset(SAVE_KEY, JSON.stringify(S.save)); }

  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function fmtInt(n) {
    n = Math.round(n);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + M[d.getMonth()];
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), closed with the panel ----
  function Snd(on) { this.on = !!on; this.ac = null; }
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
  Snd.prototype.seq = function (fs, gap, dur, type, vol) {
    for (var i = 0; i < fs.length; i++) if (fs[i]) this.tone(fs[i], dur, type, vol, 0, i * gap);
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_ARROW = [
    svg('<path d="M12 19V5M5 12l7-7 7 7"/>'), svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
    svg('<path d="M12 5v14M19 12l-7 7-7-7"/>'), svg('<path d="M5 12h14M12 5l7 7-7 7"/>')
  ];

  // ---- theme colours (derived from the app's CSS variables) ----
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
  function readTheme() {
    var cs = getComputedStyle(S.panel);
    function v(n) { return cs.getPropertyValue(n); }
    var bg = parseCol(v('--bg'), [250, 250, 249]), tx = parseCol(v('--text'), [28, 25, 23]), ac = parseCol(v('--accent'), [15, 149, 152]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    var mu = parseCol(v('--text-muted'), mix(bg, tx, 0.55)), fa = parseCol(v('--text-faint'), mix(bg, tx, 0.35));
    var P = S.pal;
    S.dark = dark;
    P[C_TEXT] = css(tx); P[C_MUTED] = css(mu); P[C_FAINT] = css(fa); P[C_ACC] = css(ac);
    P[C_GOLD] = dark ? '#f2c544' : '#c08a00'; P[C_RED] = dark ? '#f06a6a' : '#d23c3c';
    P[C_ICE] = dark ? '#6fd3f0' : '#1f86b8'; P[C_FLAME] = dark ? '#ff9a4a' : '#e2611f';
    P[C_LEAF] = dark ? '#7ed37a' : '#2f8f3a'; P[C_VIOLET] = dark ? '#c3a3ff' : '#7a4fd0';
    P[C_PALE] = dark ? '#8ea6ff' : '#3e55d4'; P[C_DOT] = css(mix(bg, tx, dark ? 0.62 : 0.55));
    S.rgb = { bg: bg, tx: tx, ac: ac };
    S.col = { bg: css(bg), hud: css(bg, 0.86), font: (v('--font-mono') || '').trim() || 'ui-monospace, monospace' };
    fitFont();
  }

  // ---- glyph rendering ----
  // Monospace glyphs on a CW × RH grid. Each (colour, character) pair is rendered
  // once into an atlas canvas at device resolution and stamped with drawImage.
  var AT_COLS = 24, AT_ROWS = 14;
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '700 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    S.fpx = CW / adv;
    S.fnt = '700 ' + S.fpx.toFixed(3) + 'px ' + f;
    // optical centres: a sprite glyph sits in the middle of its tile, whatever its shape
    c.font = S.fnt; c.textBaseline = 'middle';
    S.vc = new Float32Array(128);
    for (var k = 33; k < 127; k++) {
      // with textBaseline 'middle' the ink spans [y - ascent, y + descent]: shift it to centre
      var m = c.measureText(String.fromCharCode(k));
      if (m && m.actualBoundingBoxAscent != null) S.vc[k] = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    }
    buildAtlas();
    S.mzKey = ''; S.dotKey = '';
  }
  function freeCanvas(cv) { if (cv) { cv.width = 0; cv.height = 0; } }
  function buildAtlas() {
    if (!S.k || !S.col) return;
    var a = S.atl || (S.atl = { cv: document.createElement('canvas') });
    a.sc = 3;    // cells big enough for glyphs drawn at up to 3x (the intermission's big muncher)
    a.cwp = Math.ceil((CW + 4) * S.k * a.sc); a.chp = Math.ceil((RH + 4) * S.k * a.sc);
    a.cv.width = a.cwp * AT_COLS; a.cv.height = a.chp * AT_ROWS;
    a.c = a.cv.getContext('2d');
    a.c.font = '700 ' + (S.fpx * S.k * a.sc).toFixed(3) + 'px ' + S.col.font;
    a.c.textAlign = 'center'; a.c.textBaseline = 'middle';
    a.cw = a.cwp / S.k / a.sc; a.ch = a.chp / S.k / a.sc; a.n = 0; a.max = AT_COLS * AT_ROWS;
    S.gmap = [];
    for (var i = 0; i < NPAL; i++) { var m = new Int16Array(128); for (var j = 0; j < 128; j++) m[j] = -1; S.gmap.push(m); }
  }
  function gIdx(ci, code) {
    if (code >= 128) return -1;
    var m = S.gmap[ci], i = m[code], a = S.atl;
    if (i >= 0) return i;
    if (a.n >= a.max) return -1;
    i = a.n++;
    a.c.fillStyle = S.pal[ci];
    a.c.fillText(String.fromCharCode(code), (i % AT_COLS) * a.cwp + a.cwp / 2, ((i / AT_COLS) | 0) * a.chp + a.chp / 2);
    m[code] = i;
    return i;
  }
  // One glyph centred on (x, y); `sc` scales it; `vc` centres its ink optically; `rot` turns it.
  function glyph(c, ci, code, x, y, sc, vc, rot) {
    if (code === 32) return;
    var i = gIdx(ci, code), a = S.atl, s = sc || 1;
    if (vc) y += S.vc[code] * s;
    if (i < 0) {
      c.font = S.fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = S.pal[ci];
      c.fillText(String.fromCharCode(code), x, y);
      return;
    }
    var w = a.cw * s, h = a.ch * s;
    if (rot) {
      c.save(); c.translate(x, y); c.rotate(rot);
      c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, -w / 2, -h / 2, w, h);
      c.restore();
      return;
    }
    var dx = x - w / 2, dy = y - h / 2;
    if (!sc || sc === 1) { dx = Math.round(dx * S.k) / S.k; dy = Math.round(dy * S.k) / S.k; }
    c.drawImage(a.cv, (i % AT_COLS) * a.cwp, ((i / AT_COLS) | 0) * a.chp, a.cwp, a.chp, dx, dy, w, h);
  }
  function drawStr(c, ci, s, x, y, align, sc) {
    var n = s.length, cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, s.charCodeAt(i), x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }
  var NB = new Uint8Array(24);
  function writeNum(v) {
    var n = 0, ip = Math.max(0, Math.round(v)), cnt = 0;
    do { if (cnt && cnt % 3 === 0) NB[n++] = 44; NB[n++] = 48 + ip % 10; ip = Math.floor(ip / 10); cnt++; } while (ip > 0 && n < 20);
    for (var a = 0, b = n - 1; a < b; a++, b--) { var t = NB[a]; NB[a] = NB[b]; NB[b] = t; }
    return n;
  }
  function drawNum(c, ci, n, x, y, align, sc) {
    var cw = sc ? CW * sc : CW, x0 = align === 'right' ? x - n * cw : align === 'center' ? x - n * cw / 2 : x;
    for (var i = 0; i < n; i++) glyph(c, ci, NB[i], x0 + i * cw + cw / 2, y, sc);
    return x0 + n * cw;
  }

  // ---- the maze, pre-rendered: outlines inset into the wall tiles ----
  function isWall(m, x, y) {
    if (y < 0 || y >= H || x < 0 || x >= W) return true;
    return m.cell[y * W + x] === 0;
  }
  function mazeCanvas(m, flash) {
    var cv = document.createElement('canvas'), k = S.k;
    cv.width = Math.ceil(VW * k); cv.height = Math.ceil(H * T * k);
    var c = cv.getContext('2d'), hue = parseCol(S.pal[HUE_SLOT[m.hue] || C_ACC], S.rgb.ac);
    c.setTransform(k, 0, 0, k, 0, 0);
    var ins = T * 0.3, segs = [];
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (!isWall(m, x, y)) continue;
      var X0 = x * T, Y0 = y * T, X1 = X0 + T, Y1 = Y0 + T;
      // [open side dx,dy] → a line along that side; each end: inset (convex), flush, or overshoot (concave)
      for (var s = 0; s < 4; s++) {
        var d = DIRS[s];
        if (isWall(m, x + d[0], y + d[1])) continue;
        var px = -d[1], py = d[0];   // along the side
        var ends = [];
        for (var e = -1; e <= 1; e += 2) {
          var ex = px * e, ey = py * e, ext;
          if (!isWall(m, x + ex, y + ey)) ext = -ins;
          else if (!isWall(m, x + ex + d[0], y + ey + d[1])) ext = 0;
          else ext = ins;
          ends.push(ext);
        }
        var cx = X0 + T / 2 + d[0] * (T / 2 - ins), cy = Y0 + T / 2 + d[1] * (T / 2 - ins);
        var h0 = T / 2 + ends[0], h1 = T / 2 + ends[1];
        segs.push(cx - px * h0, cy - py * h0, cx + px * h1, cy + py * h1);
      }
      void X1; void Y1;
    }
    function stroke(w, col) {
      c.lineWidth = w; c.strokeStyle = col; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      for (var i = 0; i < segs.length; i += 4) { c.moveTo(segs[i], segs[i + 1]); c.lineTo(segs[i + 2], segs[i + 3]); }
      c.stroke();
    }
    var bg = S.rgb.bg, tx = S.rgb.tx;
    if (flash) { stroke(4, css(mix(bg, tx, 0.25))); stroke(1.6, css(tx)); }
    else { stroke(4.2, css(mix(bg, hue, S.dark ? 0.22 : 0.14))); stroke(1.6, css(mix(bg, hue, S.dark ? 0.92 : 0.88))); }
    // the door
    c.lineWidth = 2; c.lineCap = 'butt'; c.strokeStyle = css(mix(bg, parseCol(S.pal[C_RED], [210, 60, 60]), 0.6));
    c.beginPath(); c.moveTo(GX * T - 1, 12 * T + T / 2 + 1); c.lineTo(GX * T + T + 1, 12 * T + T / 2 + 1); c.stroke();
    return cv;
  }
  function ensureMaze(m) {
    var key = m.idx + '|' + S.k + '|' + S.pal[C_ACC] + S.pal[C_TEXT];
    if (S.mzKey === key) return;
    freeCanvas(S.mz); freeCanvas(S.mzF);
    S.mz = mazeCanvas(m, false); S.mzF = null; S.mzKey = key;
  }
  // the dots layer: all small dots for the current board; eaten ones are cleared
  function ensureDots(g) {
    var P = g.ps[g.cur], key = g.dotsVer + '|' + g.cur + '|' + S.k + '|' + S.pal[C_DOT];
    if (S.dotKey === key) {
      for (var j = 0; j < g.ate.length; j++) clearDot(g.ate[j]);
      g.ate.length = 0;
      return;
    }
    g.ate.length = 0;
    var k = S.k, cv = S.dl || (S.dl = document.createElement('canvas'));
    cv.width = Math.ceil(VW * k); cv.height = Math.ceil(H * T * k);
    var c = cv.getContext('2d'), r = Math.max(1.1, T * 0.12);
    c.setTransform(k, 0, 0, k, 0, 0);
    c.fillStyle = S.pal[C_DOT];
    if (P.dots) {
      for (var i = 0; i < W * H; i++) {
        if (P.dots[i] !== 1) continue;
        var x = (i % W) * T + T / 2, y = ((i / W) | 0) * T + T / 2;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    S.dotKey = key;
  }
  function clearDot(i) {
    var c = S.dl.getContext('2d'), x = (i % W) * T, y = ((i / W) | 0) * T;
    c.clearRect(x + 1, y + 1, T - 2, T - 2);
  }

  // ---- particles + pop-ups (world = maze pixels) ----
  function makeFx() {
    S.parts = [];
    for (var i = 0; i < NPART; i++) S.parts.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, code: 46, ci: 0 });
    S.popa = [];
    for (i = 0; i < NPOP; i++) S.popa.push({ on: false, x: 0, y: 0, t: 0, v: 0, ci: C_ICE, hold: 0 });
    S.pi = 0; S.qi = 0;
  }
  function clearFx() {
    for (var i = 0; i < NPART; i++) S.parts[i].on = false;
    for (i = 0; i < NPOP; i++) S.popa[i].on = false;
  }
  function burst(x, y, n, sp, codes, ci, life) {
    if (S.rm) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var p = S.parts[S.pi]; S.pi = (S.pi + 1) % NPART;
      var a = Math.random() * Math.PI * 2, v = sp * (0.35 + Math.random() * 0.65);
      p.on = true; p.x = x; p.y = y; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v; p.t = 0;
      p.life = life * (0.6 + Math.random() * 0.5); p.code = codes.charCodeAt(i % codes.length);
      p.ci = Array.isArray(ci) ? ci[i % ci.length] : ci;
    }
  }
  function popup(x, y, v, ci) {
    var p = S.popa[S.qi]; S.qi = (S.qi + 1) % NPOP;
    p.on = true; p.x = x; p.y = y; p.t = 0; p.v = v; p.ci = ci;
  }
  function stepFx(dt) {
    var i, p;
    for (i = 0; i < NPART; i++) {
      p = S.parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      p.vx *= 1 - 2.2 * dt; p.vy *= 1 - 2.2 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = 0; i < NPOP; i++) { p = S.popa[i]; if (p.on && (p.t += dt) > 1.2) p.on = false; }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt);
    if (S.say && (S.say.t -= dt) <= 0) S.say = null;
  }

  // ---- the scene ----
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ax(x) { return x * T + T / 2; }
  function ay(y) { return MY + y * T + T / 2; }
  // draw an actor at tile coords, twice when it straddles a tunnel mouth
  function actor(c, ci, code, x, y, sc, rot) {
    var X = ax(x), Y = ay(y);
    glyph(c, ci, code, X, Y, sc, true, rot);
    if (x < 0.8) glyph(c, ci, code, X + VW, Y, sc, true, rot);
    else if (x > W - 1.8) glyph(c, ci, code, X - VW, Y, sc, true, rot);
  }
  function banner(c, s, row, ci, sc) {
    sc = sc || 1;
    var w = s.length * CW * sc + 10, y = ay(row);
    c.fillStyle = S.col.bg; c.fillRect(VW / 2 - w / 2, y - RH * sc / 2 - 2, w, RH * sc + 4);
    drawStr(c, ci, s, VW / 2, y, 'center', sc);
  }
  function draw(alpha) {
    if (!S || !S.ctx || !S.atl) return;
    var c = S.ctx, g = S.g || S.hg, now = S.clock;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    if (S.shake > 0 && !S.rm) { var sh = S.shake * 10; c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); }
    c.fillStyle = S.col.bg; c.fillRect(-10, -10, VW + 20, VH + 20);
    if (g.phase === 'inter') { drawInter(c, g); hud(c, g); return; }
    var m = g.m, P = g.ps[g.cur], ph = g.phase, i;
    ensureMaze(m);
    var pt = g.pt;
    // walls (flashing when a board is cleared)
    var flashOn = ph === 'clear' && (T_CLEAR - pt) > 0.45 && (((T_CLEAR - pt) / 0.2) | 0) % 2 === 0;
    if (flashOn && !S.mzF) S.mzF = mazeCanvas(m, true);
    c.drawImage(flashOn ? S.mzF : S.mz, 0, MY, VW, H * T);
    if (P.dots) {
      ensureDots(g);
      c.drawImage(S.dl, 0, MY, VW, H * T);
      // power pellets pulse
      var on = ph !== 'play' || ((now * 4) | 0) % 2 === 0 || S.rm;
      for (i = 0; i < m.dot.length; i++) {
        if (P.dots[i] !== 2 || !on) continue;
        glyph(c, C_TEXT, 111, ax(i % W), ay((i / W) | 0), 1.4, true);
      }
    }
    c.save();
    c.beginPath(); c.rect(0, MY, VW, H * T); c.clip();
    // the treat, bouncing
    if (g.item && (ph === 'play' || ph === 'eat')) {
      var it = g.item, I = ITEMS[it.k], ix = lerp(it.px, it.x, alpha), iy = lerp(it.py, it.y, alpha);
      if (Math.abs(it.x - it.px) > 2) ix = it.x;
      var bounce = -Math.abs(Math.sin(it.life * 7)) * 0.38;
      actor(c, ITEM_SLOT[I.id], I.ch.charCodeAt(0), ix, iy + bounce, 1.5);
    }
    // chasers
    var hideGh = (ph === 'dying' && T_DIE - pt > 0.5) || (ph === 'clear' && T_CLEAR - pt > 0.3) || ph === 'over' || ph === 'handoff';
    if (!hideGh) {
      for (i = 3; i >= 0; i--) {
        var h = g.gh[i];
        if (ph === 'eat' && g.eatAt && g.eatAt.i === i && h.st === 'eyes') continue;
        var hx = lerp(h.px, h.x, alpha), hy = lerp(h.py, h.y, alpha);
        if (Math.abs(h.x - h.px) > 2) hx = h.x;
        if (h.st === 'eyes' || h.st === 'enter') { actor(c, C_TEXT, 34, hx, hy, 1.5); continue; }
        if (h.fr) {
          var left = g.frT, blink = left < 1.6 && ((left * 6) | 0) % 2 === 0;
          var wob = S.rm ? 0 : Math.sin(now * 18 + i) * 0.06;
          actor(c, blink ? C_TEXT : C_PALE, 119, hx + wob, hy, 1.55);
        } else actor(c, GHOST_SLOT[i], CHASERS[i].ch.charCodeAt(0), hx, hy, 1.5);
      }
    }
    // the muncher
    var p = g.pac, mx = lerp(p.px, p.x, alpha), my = lerp(p.py, p.y, alpha);
    if (Math.abs(p.x - p.px) > 2) mx = p.x;
    if (ph === 'dying') {
      var dt0 = T_DIE - pt - 0.5;
      if (dt0 < 0) actor(c, C_GOLD, 67, mx, my, 1.5, ROT[p.face]);
      else if (dt0 < 0.9) {
        var u = dt0 / 0.9;
        actor(c, C_GOLD, u < 0.33 ? 67 : u < 0.66 ? 60 : 118, mx, my, 1.5 * (1 - u * 0.75), ROT[p.face] + u * Math.PI * 3);
      }
    } else if (!(ph === 'eat') && ph !== 'over' && ph !== 'handoff') {
      var fr = ph === 'ready' ? 0 : ((p.chew * 3.2) | 0) % 4;
      if ((g.turbo || P.level >= 5) && ph === 'play' && !p.stop && !S.rm) {       // after-images: speed
        var D = DIRS[p.face];
        c.globalAlpha = 0.18; actor(c, C_GOLD, MOUTH[fr], mx - D[0] * 0.55, my - D[1] * 0.55, 1.4, ROT[p.face]);
        c.globalAlpha = 1;
      }
      actor(c, C_GOLD, MOUTH[fr], mx, my, 1.55, fr ? ROT[p.face] : 0);
    }
    // particles + pop-ups
    for (i = 0; i < NPART; i++) {
      var q = S.parts[i];
      if (!q.on) continue;
      c.globalAlpha = Math.min(1, 2.5 * (1 - q.t / q.life));
      glyph(c, q.ci, q.code, q.x, MY + q.y);
    }
    c.globalAlpha = 1;
    c.restore();
    for (i = 0; i < NPOP; i++) {
      var pp = S.popa[i];
      if (!pp.on) continue;
      c.globalAlpha = Math.min(1, 3 * (1.2 - pp.t));
      var n = writeNum(pp.v), py = MY + pp.y - pp.t * 14, pw = n * CW * 0.85 + 6;
      c.fillStyle = S.col.hud; c.fillRect(pp.x - pw / 2, py - 6.5, pw, 13);
      drawNum(c, pp.ci, n, pp.x, py, 'center', 0.85);
    }
    c.globalAlpha = 1;
    // words
    var label = 17;
    if (ph === 'ready') {
      if (g.np === 2) banner(c, 'PLAYER ' + P.n, 9, C_ICE);
      banner(c, P.level > 1 && S.readyLv ? 'LEVEL ' + P.level : 'READY!', label, C_GOLD);
    } else if (ph === 'over') banner(c, 'GAME  OVER', label, C_RED);
    else if (ph === 'clear' && T_CLEAR - pt > 0.45) banner(c, 'CLEAR!', label, C_GOLD);
    if (S.say && S.g && ph !== 'ready') banner(c, S.say.text, 9, C_GOLD);
    hud(c, g);
    if (S.flash > 0 && !S.rm) { c.fillStyle = css(S.dark ? [255, 255, 255] : [255, 255, 255], (S.flash * 1.6).toFixed(3)); c.fillRect(0, 0, VW, VH); }
  }

  function hud(c, g) {
    var P = g.ps[g.cur], yl = 7, yv = 18, n, L = 0.72, hi = Math.max(hiScore(S.save), P.score);
    c.fillStyle = S.col.bg; c.fillRect(0, 0, VW, HUD_T); c.fillRect(0, VH - HUD_B, VW, HUD_B);
    var blink = g.phase !== 'over' && ((S.clock * 2.5) | 0) % 2 === 0;
    drawStr(c, g.cur === 0 && blink && S.g ? C_FAINT : C_MUTED, '1UP', 6, yl, 'left', L);
    n = writeNum(g.ps[0].score); drawNum(c, C_TEXT, n, 6, yv);
    drawStr(c, C_MUTED, 'HIGH SCORE', VW / 2, yl, 'center', L);
    n = writeNum(hi); drawNum(c, C_TEXT, n, VW / 2, yv, 'center');
    if (g.np === 2) {
      drawStr(c, g.cur === 1 && blink && S.g ? C_FAINT : C_MUTED, '2UP', VW - 6, yl, 'right', L);
      n = writeNum(g.ps[1].score); drawNum(c, C_TEXT, n, VW - 6, yv, 'right');
    } else {
      drawStr(c, C_MUTED, 'LEVEL', VW - 6, yl, 'right', L);
      n = writeNum(P.level); drawNum(c, C_TEXT, n, VW - 6, yv, 'right');
    }
    // bottom: lives, the maze, recent treats
    var yb = VH - HUD_B / 2 - 1, lives = P.lives - 1;   // the spares
    if (S.g) for (var i = 0; i < Math.min(5, Math.max(0, lives)); i++) glyph(c, C_GOLD, 67, 10 + i * 13, yb, 1.2, true);
    var nm = (g.np === 2 ? 'LV ' + P.level + '  ' : '') + g.m.name.toUpperCase();
    drawStr(c, C_FAINT, nm, VW / 2, yb, 'center', 0.72);
    var its = P.items;
    for (var j = 0; j < its.length; j++) { var I = ITEMS[its[its.length - 1 - j]]; glyph(c, ITEM_SLOT[I.id], I.ch.charCodeAt(0), VW - 10 - j * 13, yb, 1.15, true); }
  }

  // the intermission: a chase across an empty stage, then the tables turn
  function drawInter(c, g) {
    var t = T_INTER - g.pt, y = VH / 2 + 10, nm = MAZES[mazeFor(g.ps[g.cur].level)].name.toUpperCase();
    drawStr(c, C_FAINT, '- INTERMISSION -', VW / 2, VH * 0.26, 'center', 0.9);
    c.fillStyle = S.pal[C_FAINT];
    c.globalAlpha = 0.5; c.fillRect(0, y + 14, VW, 1); c.globalAlpha = 1;
    var span = VW + 120;
    if (t < 2.6) {
      var u = clamp(t / 2.4, 0, 1), x = -40 + span * u, fr = ((t * 14) | 0) % 4;
      glyph(c, C_GOLD, MOUTH[fr], x, y, 1.6, true, fr ? 0 : 0);
      glyph(c, C_RED, 35, x - 34 - Math.sin(t * 6) * 3, y, 1.6, true);
      if (u > 0.05) drawStr(c, C_FAINT, '!', x - 34, y - 16, 'center');
    } else if (t < 5.2) {
      var v = clamp((t - 2.75) / 2.3, 0, 1), x2 = VW + 40 - span * v, fr2 = ((t * 12) | 0) % 4;
      glyph(c, ((t * 6) | 0) % 2 ? C_PALE : C_TEXT, 119, x2, y + Math.sin(t * 20) * 1.5, 1.6, true);
      glyph(c, C_GOLD, MOUTH[fr2], x2 + 46, y - 6, 3.2, true, fr2 ? Math.PI : 0);
    }
    drawStr(c, C_MUTED, 'NEXT  ' + nm, VW / 2, VH * 0.72, 'center', 0.9);
    drawStr(c, C_FAINT, S.coarse ? 'tap to skip' : 'space to skip', VW / 2, VH * 0.72 + 16, 'center', 0.72);
  }

  // ---- loop: runs only while a game is on screen ----
  function running() {
    return !!S && !!S.g && S.view === 'game' && !S.paused && !document.hidden && !(Cade.isMinimized && Cade.isMinimized(S.panel));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (S && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    if (!running()) return;
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    pollPad();
    if (!running()) return;
    var g = S.g;
    S.clock += dt;
    var alpha = advance(g, dt);
    handleEvents(g);
    if (S.deathBurst && (g.phase !== 'dying' || T_DIE - g.pt >= 1.4)) {
      S.deathBurst = false;
      var gp = g.deathAt;
      if (gp && g.phase === 'dying') burst(ax(gp.x), gp.y * T + T / 2, 16, 70, '*+.\'', [C_GOLD, C_FLAME], 0.7);
    }
    stepFx(dt);
    if (g.phase === 'play' && g.frT > 0 && S.snd.on) {
      S.sirenT -= dt;
      if (S.sirenT <= 0) { S.sirenT = 0.32; S.snd.tone(520, 0.16, 'triangle', 0.012, 760); }
    }
    draw(alpha);
    if (g.phase === 'handoff') { stopLoop(); showHandoff(); return; }
    if (g.phase === 'over') {
      S.overT += dt;
      if (S.overT >= 1.8) { endGame(); return; }
    }
    S.raf = requestAnimationFrame(frame);
  }

  function handleEvents(g) {
    var e = g.events, snd = S.snd, i, p = g.pac;
    for (i = 0; i < g.pops.length; i++) {
      var q = g.pops[i];
      popup(ax(q.x), (q.y * T + T / 2) - (q.k === 'quad' ? 0 : 0), q.v, q.k === 'item' ? C_GOLD : q.k === 'quad' ? C_FLAME : C_ICE);
    }
    g.pops.length = 0;
    for (i = 0; i < e.length; i++) {
      switch (e[i]) {
        case 'dot':
          if (S.clock - S.dotT > 0.055) { S.waka ^= 1; snd.tone(S.waka ? 330 : 262, 0.06, 'triangle', 0.028, S.waka ? 392 : 220); S.dotT = S.clock; }
          break;
        case 'pellet':
          snd.tone(180, 0.28, 'square', 0.03, 90);
          burst(ax(p.x), p.y * T + T / 2, 10, 70, 'o*.', [C_TEXT, C_PALE], 0.5);
          S.sirenT = 0.25; S.flash = 0.05;
          Cade.haptic && Cade.haptic(8);
          break;
        case 'ghost':
          var at = g.eatAt;
          snd.tone(260, 0.2, 'square', 0.03, 1300); snd.tone(1300, 0.12, 'triangle', 0.025, 1800, 0.18);
          if (at) burst(ax(at.x), at.y * T + T / 2, 14, 90, '*+x.', [GHOST_SLOT[at.i], C_PALE, C_TEXT], 0.6);
          Cade.haptic && Cade.haptic(14);
          break;
        case 'quad':
          snd.seq([784, 988, 1175, 1568, 1976], 0.07, 0.1, 'square', 0.025);
          S.flash = 0.12;
          break;
        case 'item':
          snd.seq([784, 988, 1319], 0.06, 0.09, 'triangle', 0.035);
          burst(ax(p.x), p.y * T + T / 2, 12, 80, '*+.', [C_GOLD, C_FLAME, C_LEAF], 0.6);
          Cade.haptic && Cade.haptic(10);
          break;
        case 'itemIn': snd.tone(660, 0.07, 'sine', 0.025); snd.tone(880, 0.09, 'sine', 0.025, 0, 0.08); break;
        case 'extra':
          snd.seq([1047, 1319, 1568, 1047, 1319, 1568], 0.07, 0.08, 'triangle', 0.03);
          S.say = { text: 'EXTRA LIFE!', t: 1.4 };
          break;
        case 'die':
          S.shake = 0.25;
          [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84].forEach(function (d, j) { snd.tone(700 - j * 70, 0.11, 'sawtooth', 0.018, 600 - j * 70, 0.45 + d); });
          S.deathBurst = true;   // (in game time: when the muncher has shrunk away — see frame)
          Cade.haptic && Cade.haptic(30);
          break;
        case 'clear':
          snd.seq([523, 659, 784, 1047, 784, 1047], 0.08, 0.1, 'triangle', 0.035);
          announce('Level ' + g.ps[g.cur].level + ' cleared');
          break;
        case 'go': S.readyLv = false; break;
        case 'level': S.readyLv = true; freeCanvas(S.mzF); S.mzF = null; clearFx(); break;
        case 'inter': snd.seq([392, 494, 587, 784, 0, 587, 784], 0.11, 0.12, 'square', 0.022); break;
        case 'over': snd.seq([392, 330, 262, 196], 0.18, 0.22, 'triangle', 0.035); announce('Game over'); break;
      }
    }
    e.length = 0;
    if (g.phase === 'ready' && S.lastPh !== 'ready' && !S.rm) jingle();
    S.lastPh = g.phase;
  }
  function jingle() { S.snd.seq([392, 523, 659, 523, 784, 0, 659, 784], 0.09, 0.1, 'triangle', 0.03); }
  function announce(s) { if (S && S.liveEl) S.liveEl.textContent = s; }

  // ---- cards ----
  function title(s) { return '<div class="mm-title">' + s + '</div>'; }
  function chaserRow(i) {
    var C = CHASERS[i];
    return '<div><b class="mm-g' + i + '">' + esc(C.ch) + '</b> <b>' + esc(C.name) + '</b> &nbsp;<span>' + esc(C.how) + '</span></div>';
  }
  function homeHtml() {
    var sv = S.save, o = sv.opt;
    return '<div class="mm-card mm-home">' +
      '<pre class="mm-art" aria-hidden="true"><span class="mm-gold">C</span> <span class="mm-dim">&middot; &middot; &middot;</span> <span class="mm-txt">o</span>   <span class="mm-g0">#</span> <span class="mm-g1">&amp;</span> <span class="mm-g2">%</span> <span class="mm-g3">$</span></pre>' +
      title('MAZE MUNCHER') +
      '<div class="mm-sub">' + (sv.best.score ? 'best ' + fmtInt(sv.best.score) + ' &middot; level ' + sv.best.level : 'munch every dot &middot; dodge four chasers') + '</div>' +
      '<div class="mm-btns"><button type="button" class="mm-go" data-act="play1">1 Player</button><button type="button" class="mm-go alt" data-act="play2">2 Players</button></div>' +
      '<div class="mm-opts">' +
      '<div class="mm-opt"><span>Speed</span><span class="mm-seg" role="group" aria-label="Speed">' +
      '<button type="button" data-opt="turbo" data-v="0" class="' + (!o.turbo ? 'on' : '') + '" aria-pressed="' + !o.turbo + '">Normal</button>' +
      '<button type="button" data-opt="turbo" data-v="1" class="' + (o.turbo ? 'on' : '') + '" aria-pressed="' + o.turbo + '">Turbo</button></span></div>' +
      '<div class="mm-opt"><span>Intermissions</span><span class="mm-seg" role="group" aria-label="Intermissions">' +
      '<button type="button" data-opt="inter" data-v="1" class="' + (o.inter ? 'on' : '') + '" aria-pressed="' + o.inter + '">On</button>' +
      '<button type="button" data-opt="inter" data-v="0" class="' + (!o.inter ? 'on' : '') + '" aria-pressed="' + !o.inter + '">Off</button></span></div>' +
      '</div>' +
      '<div class="mm-foot"><button type="button" class="mm-lnk" data-act="records">Records</button><button type="button" class="mm-lnk" data-act="help">How to play</button></div>' +
      '<div class="mm-note">' + (S.coarse ? 'Swipe the maze or the pad to steer' : 'Arrows / WASD to steer &middot; P to pause') + '</div>' +
      '</div>';
  }
  function helpHtml() {
    var keys = S.coarse ?
      '<div><b>swipe</b> on the maze or the pad &nbsp;steer (turns are remembered: swipe early)</div><div><b>arrow pad</b> &nbsp;tap a direction</div><div><b>&#10074;&#10074;</b> &nbsp;pause</div>' :
      '<div><b>arrows / WASD</b> &nbsp;steer &mdash; press a turn early, it waits for the corner</div><div><b>gamepad</b> &nbsp;d-pad / stick, Start pauses</div><div><b>P / Esc</b> &nbsp;pause</div>';
    return '<div class="mm-card mm-help">' + title('HOW TO PLAY') +
      '<p>Munch every dot (<b>&middot;</b>) to clear the maze. Touch a chaser and you lose a life. The side <b>tunnels</b> wrap round &mdash; chasers crawl through them.</p>' +
      '<div class="mm-keys">' + keys + '</div>' +
      '<p>A <b>power pellet</b> (<b>o</b>) turns the chasers pale (<b class="mm-pale">w</b>) for a few seconds: munch them for <b>200, 400, 800, 1600</b> (all four: +2,000). Their eyes (<b>"</b>) race home and they come back.</p>' +
      '<div class="mm-keys mm-legend">' + [0, 1, 2, 3].map(chaserRow).join('') + '</div>' +
      '<p>They take turns to <b>scatter</b> to their corners and to <b>chase</b>. Treats bounce in through the tunnels &mdash; catch them before they leave:</p>' +
      '<div class="mm-items">' + ITEMS.map(function (I) { return '<span><b class="mm-i-' + I.id + '">' + esc(I.ch) + '</b> ' + fmtInt(I.pts) + '</span>'; }).join('') + '</div>' +
      '<p>Every level is faster; the maze changes every few levels. Extra life at <b>10,000</b>. <b>2 Players</b> take turns on one device: pass it on when a life is lost.</p>' +
      '<button type="button" class="mm-go" data-act="back">Back</button></div>';
  }
  function recordsHtml() {
    var sv = S.save, st = sv.stats, rows = '';
    if (sv.hi.length) {
      rows = sv.hi.map(function (e, i) {
        var s = fmtInt(e.s), l = 'L' + e.l;
        return '<span class="' + (S.hl === i ? 'g' : '') + '">' + (i + 1) + '. ' + new Array(Math.max(1, 9 - s.length) + 1).join(' ') + '<b>' + s + '</b>  ' + (l + '   ').slice(0, 4) + ' ' + (e.p + '  ').slice(0, 3) + (e.tb ? ' T ' : '   ') + '<i>' + esc(fmtDate(e.d)) + '</i></span>';
      }).join('\n');
    } else rows = '<i>no games yet</i>';
    function line(a, b) { return esc(a) + new Array(Math.max(1, 28 - a.length - b.length) + 1).join(' ') + '<b>' + esc(b) + '</b>'; }
    var stats = [line('Games', fmtInt(st.games)), line('Dots munched', fmtInt(st.dots)), line('Chasers munched', fmtInt(st.ghosts)),
      line('Treats caught', fmtInt(st.items)), line('Mazes cleared', fmtInt(st.clears)), line('Best level', String(sv.best.level || '-'))].join('\n');
    return '<div class="mm-card mm-rec">' + title('RECORDS') +
      '<pre class="mm-tab">' + rows + '</pre>' +
      (sv.hi.some(function (e) { return e.tb; }) ? '<div class="mm-note">T = turbo speed</div>' : '') +
      '<pre class="mm-tab">' + stats + '</pre>' +
      '<div class="mm-foot">' + (S.resetArm ?
        '<span class="mm-confirm">Erase all records?</span><span><button type="button" class="mm-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="mm-lnk" data-act="reset-no">Keep</button></span>' :
        '<button type="button" class="mm-lnk" data-act="reset">Reset records</button><span></span>') + '</div>' +
      '<button type="button" class="mm-go" data-act="back">Back</button></div>';
  }
  function pauseHtml() {
    var g = S.g, P = g.ps[g.cur];
    return '<div class="mm-card mm-pause">' + title('PAUSED') +
      '<div class="mm-sub">' + (g.np === 2 ? 'Player ' + P.n + ' &middot; ' : '') + fmtInt(P.score) + ' &middot; level ' + P.level + ' &middot; ' + esc(g.m.name) + '</div>' +
      '<div class="mm-btns"><button type="button" class="mm-go" data-act="resume">Resume</button><button type="button" class="mm-go alt" data-act="quit">End game</button></div>' +
      '<div class="mm-note">' + (S.coarse ? 'Tap Resume to carry on' : 'Space / P to resume') + '</div></div>';
  }
  function handoffHtml() {
    var g = S.g, P = g.ps[g.cur], other = g.ps[1 - g.cur], first = !P.dots;
    return '<div class="mm-card mm-hand">' + title('PLAYER ' + P.n) +
      '<pre class="mm-art" aria-hidden="true"><span class="mm-gold">' + (P.n === 1 ? 'C  &gt;&gt;' : '&lt;&lt;  C') + '</span></pre>' +
      '<div class="mm-big">Pass to Player ' + P.n + '</div>' +
      '<div class="mm-sub">' + (first ? 'First turn &mdash; ' : '') + 'Player ' + P.n + ': ' + fmtInt(P.score) + ' &middot; ' + P.lives + ' ' + (P.lives === 1 ? 'life' : 'lives') +
      (other && other.dots ? '<br>Player ' + other.n + ': ' + fmtInt(other.score) + (other.out ? ' (out)' : ' &middot; ' + other.lives + ' ' + (other.lives === 1 ? 'life' : 'lives')) : '') + '</div>' +
      '<button type="button" class="mm-go" data-act="ready">Tap when ready</button>' +
      '<div class="mm-note">' + (S.coarse ? '' : 'Space when ready &middot; ') + 'level ' + P.level + ' &middot; ' + esc(MAZES[P.mi].name) + '</div></div>';
  }
  function resultsHtml() {
    var cd = S.card, g = S.g, two = g.np === 2, h = '';
    h += '<div class="mm-card mm-res">' + title('GAME OVER');
    if (two) {
      var a = cd.rows[0].score, b = cd.rows[1].score, win = a === b ? 'A draw!' : 'Player ' + (a > b ? 1 : 2) + ' wins!';
      h += '<div class="mm-big">' + win + '</div>';
      h += '<pre class="mm-tab">' + cd.rows.map(function (r, i) {
        var s = fmtInt(r.score);
        return '<span class="' + (cd.ranks[i] >= 0 ? 'g' : '') + '">Player ' + r.n + new Array(Math.max(1, 12 - s.length) + 1).join(' ') + '<b>' + s + '</b>  level ' + r.level + (cd.ranks[i] >= 0 ? '  #' + (cd.ranks[i] + 1) : '') + '</span>';
      }).join('\n') + '</pre>';
    } else {
      var r0 = cd.rows[0];
      h += '<div class="mm-big">' + fmtInt(r0.score) + '</div>';
      h += cd.bestScore && r0.score > 0 ? '<div class="mm-new">** new best score **</div>' :
        cd.ranks[0] >= 0 ? '<div class="mm-new">#' + (cd.ranks[0] + 1) + ' on the records</div>' : '<div class="mm-sub">best ' + fmtInt(S.save.best.score) + '</div>';
      h += '<div class="mm-sub">reached level ' + r0.level + ' &middot; ' + esc(MAZES[mazeFor(r0.level)].name) + (g.turbo ? ' &middot; turbo' : '') + '</div>';
    }
    var st = g.stats;
    h += '<div class="mm-note">' + fmtInt(st.dots) + ' dots &middot; ' + st.ghosts + (st.ghosts === 1 ? ' chaser' : ' chasers') + ' &middot; ' + st.items + (st.items === 1 ? ' treat' : ' treats') + (st.quads ? ' &middot; ' + st.quads + ' clean sweep' + (st.quads > 1 ? 's' : '') : '') + '</div>';
    h += '<div class="mm-btns"><button type="button" class="mm-go" data-act="again">Play again</button><button type="button" class="mm-go alt" data-act="home">Menu</button></div>';
    return h + '</div>';
  }
  function showCard(kind) {
    S.cardKind = kind;
    var h = kind === 'home' ? homeHtml() : kind === 'help' ? helpHtml() : kind === 'records' ? recordsHtml() : kind === 'pause' ? pauseHtml() :
      kind === 'handoff' ? handoffHtml() : kind === 'results' ? resultsHtml() : '';
    S.ovl.innerHTML = h;
    S.ovl.style.display = kind ? '' : 'none';
    S.ovl.scrollTop = 0;
    S.stage.classList.toggle('dim', !!kind);
    if (kind && !S.coarse) {
      var b = S.ovl.querySelector('.mm-go');
      if (b && document.activeElement && S.panel.contains(document.activeElement)) { try { b.focus({ preventScroll: true }); } catch (e) {} }
    }
  }
  function syncPad() {
    if (!S) return;
    var live = S.view === 'game' && !S.paused && !!S.g && S.g.phase !== 'handoff' && S.g.phase !== 'over';
    S.pad.classList.toggle('idle', !live);
    var bs = S.pad.querySelectorAll('[data-d]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', !!S.g && live && S.g.pac && S.g.pac.want === +bs[i].getAttribute('data-d'));
  }
  function syncHead() {
    if (!S) return;
    var pb = S.head.querySelector('[data-h="pause"]'), sb = S.head.querySelector('[data-h="sound"]');
    pb.innerHTML = S.paused ? IC_PLAY : IC_PAUSE;
    pb.disabled = S.view !== 'game' || !S.g || S.g.phase === 'handoff' || S.g.phase === 'over';
    pb.title = S.paused ? 'Resume (P)' : 'Pause (P)';
    pb.setAttribute('aria-label', pb.title);
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    sb.setAttribute('aria-pressed', S.snd.on ? 'true' : 'false');
    sb.classList.toggle('on', S.snd.on);
  }

  // ---- flow ----
  function homeScene() {
    var g = newGame({ seed: 1 });
    g.phase = 'home';
    return g;
  }
  function toHome(kind) {
    stopLoop();
    S.view = 'menu'; S.paused = false; S.resetArm = false; S.g = null; S.hl = -1;
    clearFx();
    showCard(kind || 'home'); syncHead(); syncPad();
    draw(1);
  }
  function startGame(np) {
    if (!S) return;
    S.snd.ensure();
    var o = S.save.opt;
    S.np = np;
    S.g = newGame({ seed: (Math.random() * 4294967295) >>> 0 || 1, players: np, turbo: o.turbo, inter: o.inter });
    S.settled = false; S.overT = 0; S.lastPh = ''; S.readyLv = false; S.speedFx = o.turbo;
    S.view = 'game'; S.paused = false;
    clearFx();
    if (S.g.phase === 'handoff') { showHandoff(); return; }
    showCard(null); syncHead(); syncPad();
    kick();
  }
  function showHandoff() {
    S.view = 'game';
    clearFx(); S.shake = 0; S.flash = 0; S.say = null;
    showCard('handoff'); syncHead(); syncPad();
    announce('Pass to player ' + S.g.ps[S.g.cur].n);
    draw(1);
  }
  function handoffGo() {
    if (!S || !S.g || S.g.phase !== 'handoff') return;
    S.snd.ensure();
    handoffReady(S.g);
    S.lastPh = '';
    showCard(null); syncHead(); syncPad();
    kick();
  }
  function settleNow() {
    if (!S || !S.g || S.settled) return null;
    S.settled = true;
    var cd = settle(S.save, S.g, Date.now());
    persist();
    return cd;
  }
  function endGame() {
    stopLoop();
    S.card = settleNow() || S.card;
    S.view = 'results'; S.paused = false;
    S.hl = S.card && S.card.ranks.length ? S.card.ranks[0] : -1;
    showCard('results'); syncHead(); syncPad();
    if (S.card && (S.card.bestScore || S.card.ranks[0] === 0)) S.snd.seq([659, 784, 988, 1319], 0.08, 0.12, 'triangle', 0.035);
    var P = S.g.ps[0];
    announce('Game over: ' + fmtInt(P.score) + ' points, level ' + P.level + '.');
  }
  function pause() {
    if (!S || S.view !== 'game' || S.paused || !S.g) return;
    if (S.g.phase === 'over') { endGame(); return; }   // (blur / minimize while "GAME OVER" shows: go straight to the results)
    if (S.g.phase === 'handoff') { stopLoop(); if (S.cardKind !== 'handoff') showHandoff(); return; }
    S.paused = true;
    stopLoop();
    showCard('pause'); syncHead(); syncPad();
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    S.snd.ensure();
    showCard(null); syncHead(); syncPad();
    kick();
  }
  function quitGame() {
    if (!S || !S.g) return;
    S.paused = false;
    S.g.phase = 'over';
    endGame();
  }
  // the one obvious action for Space / Enter / gamepad A, wherever we are
  function primary() {
    if (!S) return;
    S.snd.ensure();
    if (S.view === 'game') {
      if (S.paused) resume();
      else if (S.g.phase === 'handoff') handoffGo();
      else if (S.g.phase === 'inter') skipInter(S.g);
      return;
    }
    if (S.view === 'results') { startGame(S.np || 1); return; }
    if (S.cardKind === 'home') startGame(1);
    else toHome();
  }

  // ---- input: buffered direction from keys, swipes, the pad and a gamepad ----
  var KEYDIR = { ArrowUp: 0, KeyW: 0, ArrowLeft: 1, KeyA: 1, ArrowDown: 2, KeyS: 2, ArrowRight: 3, KeyD: 3 };
  var KEY2CODE = { arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', ' ': 'Space', p: 'KeyP', enter: 'Enter', escape: 'Escape' };
  function keyCode(e) { return e.code || KEY2CODE[(e.key || '').toLowerCase()] || ''; }
  function steer(d) {
    if (!S || !S.g || S.view !== 'game' || S.paused) return;
    var g = S.g;
    if (g.phase === 'inter') { skipInter(g); return; }
    if (g.phase === 'handoff' || g.phase === 'over') return;
    setWant(g, d);
    syncPad();
  }
  function readPad() {
    var pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) return pads[i];
    return null;
  }
  function btnOn(p, i) { var b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }
  function padDir(p) {
    if (btnOn(p, 12)) return 0; if (btnOn(p, 14)) return 1; if (btnOn(p, 13)) return 2; if (btnOn(p, 15)) return 3;
    var x = p.axes[0] || 0, y = p.axes[1] || 0;
    if (Math.max(Math.abs(x), Math.abs(y)) < 0.5) return -1;
    return Math.abs(x) > Math.abs(y) ? (x < 0 ? 1 : 3) : (y < 0 ? 0 : 2);
  }
  function pollPad() {
    var gp = S.gp, p = readPad();
    if (!p) return;
    var d = padDir(p);
    if (d >= 0 && d !== gp.dir) steer(d);
    gp.dir = d;
    var st = btnOn(p, 9), a = btnOn(p, 0);
    if (st && !gp.start) pause();
    if (a && !gp.a && S.g && (S.g.phase === 'inter')) skipInter(S.g);
    gp.start = st; gp.a = a;
  }
  function pollMenus() {
    if (!S || running()) return;
    var p = readPad();
    if (!p) return;
    var a = btnOn(p, 0) || btnOn(p, 9);
    if (a && !S.gp.menuA) primary();
    S.gp.menuA = a;
    S.gp.start = btnOn(p, 9);
  }
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.panel.isConnected) { teardown(); return; }
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var code = keyCode(e), d = KEYDIR[code];
    if (code === 'Escape') {
      e.preventDefault();
      if (S.view === 'game' && S.g && S.g.phase === 'handoff' && !S.paused) return;
      if (S.view === 'game' && !S.paused) pause();
      else if (S.view === 'game' && S.paused) resume();
      else if (S.cardKind === 'help' || S.cardKind === 'records') toHome();
      else closePanel();
      return;
    }
    if (S.view === 'game') {
      if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) { if (S.paused) resume(); else pause(); } return; }
      if (d != null) { e.preventDefault(); if (!S.paused) steer(d); return; }
      if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
        if (t && t.tagName === 'BUTTON' && S.panel.contains(t) && S.cardKind) return;
        e.preventDefault();
        if (!e.repeat) primary();
      }
      return;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (t && t.tagName === 'BUTTON' && S.panel.contains(t)) return;
      e.preventDefault();
      if (!e.repeat) primary();
    }
  }

  // ---- layout ----
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 200 : 140);
    var chrome = r.height - (S.stage.offsetHeight || 0);
    if (S.panel.classList.contains('cade-solo-panel')) {
      var hd = S.panel.querySelector('.cade-panel-head');
      chrome = (hd ? hd.offsetHeight : 40) + (S.pad.offsetHeight || 0) + 36;
    }
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 10;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var phone = vw <= 560, solo = S.panel.classList.contains('cade-solo-panel');
    S.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    S.panel.classList.toggle('mm-touch', S.coarse);
    var s = Math.min((vw - (phone ? 36 : 48)) / VW, availH(vw, vh) / VH, phone ? 1.6 : solo ? 2.4 : 1.5);
    s = Math.max(0.6, s);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.panel.style.setProperty('--mm-w', cw + 'px');
    S.cv.width = Math.round(cw * dpr); S.cv.height = Math.round(ch * dpr);
    S.k = S.cv.width / VW;
    S.css = s;
    if (S.col) fitFont();
  }
  function redraw() { if (!S) return; if (S.raf) return; draw(S.g ? S.g.acc / STEP : 1); }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    if (S.g && S.view === 'game' && !S.settled && S.g.ps.some(function (P) { return P.score > 0; })) settleNow();   // keep a closed game's score
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    clearInterval(s.gpT);
    window.removeEventListener('gamepadconnected', s.onPad);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
    if (s.atl) freeCanvas(s.atl.cv);
    freeCanvas(s.mz); freeCanvas(s.mzF); freeCanvas(s.dl); freeCanvas(s.cv);
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function openPanel() {
    Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var padH = IC_ARROW.map(function (ic, d) {
      return '<button type="button" class="mm-dir" data-d="' + [1, 0, 2, 3][d] + '" aria-label="' + ['Left', 'Up', 'Down', 'Right'][d] + '">' + IC_ARROW[[1, 0, 2, 3][d]] + '</button>';
    }).join('');
    var body = '<div class="mm"><div class="mm-stage"><canvas class="mm-cv"></canvas><div class="mm-ovl" style="display:none"></div></div>' +
      '<div class="mm-pad">' + padH + '</div><div class="mm-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '🍒 Maze Muncher', body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'mm-hb';
    hb.innerHTML = '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button>' +
      '<button type="button" data-h="sound"></button><button type="button" data-h="pause"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var ld = loadSave(), mm = window.matchMedia;
    S = {
      panel: p, head: hb, stage: p.querySelector('.mm-stage'), cv: p.querySelector('.mm-cv'), ovl: p.querySelector('.mm-ovl'),
      pad: p.querySelector('.mm-pad'), liveEl: p.querySelector('.mm-live'),
      save: ld.save, snd: new Snd(sget(SOUND_KEY) === '1'),
      rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches), coarse: !!(mm && mm('(pointer: coarse)').matches),
      view: 'menu', g: null, hg: null, paused: false, raf: 0, last: 0, clock: 0, overT: 0, np: 1,
      gp: { dir: -1, start: false, a: false, menuA: false }, gpT: 0,
      pal: new Array(NPAL), col: null, atl: null, k: 1, mz: null, mzF: null, dl: null, mzKey: '', dotKey: '',
      shake: 0, flash: 0, waka: 0, dotT: 0, sirenT: 0, lastPh: '', readyLv: false, speedFx: false,
      say: null, cardKind: null, resetArm: false, hl: -1, settled: false, card: null, swipe: null
    };
    makeFx();
    S.ctx = S.cv.getContext('2d');
    S.hg = homeScene();
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { if (S) pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', function () {
      if (!S || S.panel !== p) return;
      pause(); stopLoop();
    });
    p.addEventListener('cade-panel-restore', function () {
      if (!S || S.panel !== p) return;
      requestAnimationFrame(function () {
        if (!S || S.panel !== p) return;
        if (S.themeDirty) { S.themeDirty = false; readTheme(); }
        layout(); redraw();
      });
    });
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) { layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    S.onPad = function () { if (S && !S.gpT) S.gpT = setInterval(pollMenus, 100); };
    window.addEventListener('gamepadconnected', S.onPad);
    if (readPad()) S.onPad();
    try {
      S.themeObs = new MutationObserver(function () {
        if (!S) return;
        if (Cade.isMinimized && Cade.isMinimized(S.panel)) { S.themeDirty = true; return; }
        readTheme(); redraw();
      });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    // header: help / sound / pause (the header drags the panel — these are controls)
    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'pause') { if (S.paused) resume(); else pause(); }
      else if (h === 'help') {
        if (S.view === 'game') { pause(); if (S.paused) showCard('help'); }
        else if (S.cardKind === 'help') toHome();
        else showCard('help');
      }
      try { b.blur(); } catch (er) {}
    });

    // Rapid tapping / swiping must never zoom, select, magnify or open a callout.
    function noTouch(e) { if (e.cancelable) e.preventDefault(); }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('touchstart', noTouch, { passive: false });
      el.addEventListener('touchmove', noTouch, { passive: false });
      el.addEventListener('touchend', noTouch, { passive: false });
    });
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });

    // swipes: on the maze and across the pad; each 14px of travel along an axis is a turn
    // wish (they chain without lifting the finger). A pad button is a turn on touch.
    function sw0(e) {
      if (!S || e.button > 0) return;
      S.snd.ensure();
      var b = e.target.closest ? e.target.closest('[data-d]') : null;
      if (S.view !== 'game' || S.paused) {
        if (e.currentTarget === S.cv && S.view === 'game' && S.g && S.g.phase === 'inter') skipInter(S.g);
        return;
      }
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
      S.swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
      if (b) steer(+b.getAttribute('data-d'));
      else if (S.g && S.g.phase === 'inter') skipInter(S.g);
    }
    function sw1(e) {
      var s = S && S.swipe;
      if (!s || s.id !== e.pointerId) return;
      var dx = e.clientX - s.x, dy = e.clientY - s.y, ad = Math.max(Math.abs(dx), Math.abs(dy));
      if (ad < 14) return;
      steer(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 3) : (dy < 0 ? 0 : 2));
      s.x = e.clientX; s.y = e.clientY;
    }
    function sw2(e) { if (S && S.swipe && S.swipe.id === e.pointerId) S.swipe = null; }
    [S.cv, S.pad].forEach(function (el) {
      el.addEventListener('pointerdown', sw0);
      el.addEventListener('pointermove', sw1);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { el.addEventListener(t, sw2); });
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
    S.cv.addEventListener('click', function () { if (S && S.view === 'game' && S.g && S.g.phase === 'inter') skipInter(S.g); });

    // cards
    S.ovl.addEventListener('click', function (e) {
      if (!S) return;
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      S.snd.ensure();
      var act = b.getAttribute('data-act'), opt = b.getAttribute('data-opt');
      if (opt) {
        S.save.opt[opt] = b.getAttribute('data-v') === '1';
        persist(); S.snd.tone(988, 0.05, 'sine', 0.03);
        showCard('home');
        var nb = e.detail === 0 && S.ovl.querySelector('[data-opt="' + opt + '"][data-v="' + b.getAttribute('data-v') + '"]');
        if (nb) { try { nb.focus({ preventScroll: true }); } catch (er) {} }
        return;
      }
      if (act === 'play1') startGame(1);
      else if (act === 'play2') startGame(2);
      else if (act === 'again') startGame(S.np || 1);
      else if (act === 'home') toHome();
      else if (act === 'records') { S.resetArm = false; showCard('records'); }
      else if (act === 'help') showCard('help');
      else if (act === 'back') { if (S.view === 'game' && S.paused) showCard('pause'); else toHome(); }
      else if (act === 'resume') resume();
      else if (act === 'quit') quitGame();
      else if (act === 'ready') handoffGo();
      else if (act === 'reset') { S.resetArm = true; showCard('records'); }
      else if (act === 'reset-no') { S.resetArm = false; showCard('records'); }
      else if (act === 'reset-yes') {
        var opt0 = S.save.opt;
        S.save = newSave(); S.save.opt = opt0; S.resetArm = false; S.hl = -1;
        persist();
        Cade.showToast && Cade.showToast('Records erased', 'info', 1800);
        showCard('records');
      }
    });

    syncHead();
    if (ld.fresh) persist();
    toHome(ld.fresh ? 'help' : 'home');
    requestAnimationFrame(function () { if (S && S.panel === p) { layout(); redraw(); } });
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); redraw(); } }, function () {});
      }
    } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'A speedy maze chase — munch every dot, outfox four very different chasers',
    icon: '🍒',
    tags: 'game,arcade,fun,maze,chase,dots,ghosts,speed,muncher,power pellet,2 player,ascii',
    open: openPanel,
    _engine: ENGINE   // pure engine, for headless checks (node)
  });
})();
