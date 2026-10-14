/* Tower Defense — an ASCII tower defense for Cade.txt.
 * Enemies (o > O & @) march down a path of '·' gravel through '"' grass, '^'
 * rocks and '~' water; build Arrow [↑], Cannon [◎], Frost [*], Tesla [≈] and
 * Sniper [+] towers on the grass, upgrade them twice, sell them for 70 %, and
 * pick what each one aims at (first / last / strong / close). Three maps of 30
 * waves (a boss every 10th), then endless free play. Stars and best waves
 * persist; a game in progress is saved when you pause, minimize or close.
 *
 * The engine below is pure (no DOM): a fixed 60 Hz step, deterministic, pooled
 * enemies / projectiles / effects, exported to node for towerdefense.test.js.
 * The UI draws everything as monospace glyphs on a canvas: the map and towers
 * are pre-rendered to an offscreen layer, each frame only adds what moves. The
 * frame loop runs only while a wave is live and the panel is visible. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var COLS = 12, ROWS = 16, STEP = 1 / 60;
  var WAVES = 30, WAVE_GAP = 15, GROUP_GAP = 1.6, MAX_SPAWNERS = 2, SELL_RATE = 0.7;
  var MAX_PROJ = 160, MAX_FX = 240, MAX_ENEMIES = 400;
  var MODES = ['first', 'last', 'strong', 'close'];
  // Balance knobs (tuned with the headless bot in towerdefense.test.js).
  var BAL = { hpLin: 0.12, hpQuad: 0.012, bountyGrow: 0.015, clearBase: 10, clearPer: 2, earlyRate: 1, earlyGrow: 0.05 };

  // Towers: per-level arrays (index 0..2). cost[0] builds, cost[1..2] upgrade.
  var TOWERS = [
    { key: 'arrow', name: 'Arrow', glyph: '↑', role: 'fast single shots', air: true, mode: 0,
      cost: [60, 50, 100], dmg: [7, 13, 22], rate: [2, 2.3, 2.8], range: [2.6, 2.9, 3.2], pspd: 11 },
    { key: 'cannon', name: 'Cannon', glyph: '◎', role: 'splash · ground only', air: false, mode: 0,
      cost: [100, 90, 170], dmg: [18, 34, 60], rate: [0.65, 0.75, 0.85], range: [2.5, 2.7, 2.9],
      splash: [0.85, 1.0, 1.15], pspd: 6 },
    { key: 'frost', name: 'Frost', glyph: '*', role: 'slows everything near', air: true, pulse: true, mode: 0,
      cost: [80, 70, 130], dmg: [3, 6, 12], rate: [1, 1, 1.1], range: [2.0, 2.3, 2.6],
      slow: [0.3, 0.4, 0.5], slowDur: [1.4, 1.7, 2.0] },
    { key: 'tesla', name: 'Tesla', glyph: '≈', role: 'chain lightning', air: true, mode: 0,
      cost: [130, 110, 200], dmg: [15, 26, 44], rate: [0.9, 1, 1.1], range: [2.4, 2.6, 2.9], chain: [2, 3, 4] },
    { key: 'sniper', name: 'Sniper', glyph: '+', role: 'long range · ignores armour', air: true, pierce: true, mode: 2,
      cost: [120, 110, 220], dmg: [50, 100, 190], rate: [0.4, 0.45, 0.5], range: [5, 5.6, 6.2] }
  ];
  var TKEY = {};
  for (var ti = 0; ti < TOWERS.length; ti++) TKEY[TOWERS[ti].key] = ti;

  // Enemies, keyed by their glyph (which is also how waves are written).
  var ENEMIES = {
    'o': { key: 'grunt', name: 'Grunt', glyph: 'o', hp: 24, spd: 1.0, armor: 0, bounty: 4, lives: 1, gap: 0.85 },
    '>': { key: 'runner', name: 'Runner', glyph: '>', hp: 15, spd: 1.8, armor: 0, bounty: 4, lives: 1, gap: 0.55 },
    'O': { key: 'tank', name: 'Tank', glyph: 'O', hp: 90, spd: 0.6, armor: 4, bounty: 10, lives: 2, gap: 1.5 },
    '&': { key: 'flyer', name: 'Flyer', glyph: '&', hp: 16, spd: 1.15, armor: 0, bounty: 5, lives: 1, gap: 0.9, fly: true },
    '@': { key: 'boss', name: 'Boss', glyph: '@', hp: 800, spd: 0.45, armor: 6, bounty: 100, lives: 5, gap: 3, boss: true }
  };

  // 30 hand-made waves: groups spawn one after another ("o8 >6" = 8 grunts, then 6 runners).
  var WAVE_TABLE = [
    'o8', 'o12', 'o8 >6', '>14', 'o10 O2', '&8', 'o12 >10', 'O5 o8', '>16 &6', 'o10 @1',
    'o16 O3', '&12 >8', 'O8', '>24', 'o20 &8 O3', 'O6 >14 &6', 'o30', '&18', 'O10 >16', 'O4 @2',
    '>30 &10', 'O12 o20', '&24', 'o24 >20 O6', 'O16 &12', '>40', 'o30 O10 &14', '&20 O12 >20', 'O20 >30', 'O10 &16 @3'
  ];

  // Maps: 12 x 16 cells. Art: '.' grass (buildable), '#' path, '^' rock, '~' water.
  // The path itself comes from the waypoints (cell coords, entering from off-grid);
  // the art's '#' cells must match them exactly (checked by the tests).
  var MAPS = [
    { id: 'meadow', name: 'Meadow', diff: 'easy', gold: 180, lives: 20, hp: 1.0,
      paths: [[[1, -1], [1, 2], [10, 2], [10, 6], [1, 6], [1, 10], [10, 10], [10, 13], [5, 13], [5, 16]]],
      art: [
        '.#..........',
        '.#..^.......',
        '.##########.',
        '..........#.',
        '.~~.......#.',
        '.~~.......#.',
        '.##########.',
        '.#..........',
        '.#.....^^...',
        '.#..........',
        '.##########.',
        '..........#.',
        '..^.......#.',
        '.....######.',
        '.....#......',
        '.....#..~~..'
      ] },
    { id: 'canyon', name: 'Canyon', diff: 'medium', gold: 200, lives: 20, hp: 1.1,
      paths: [[[-1, 2], [6, 2], [6, 6], [2, 6], [2, 9], [10, 9], [10, 13], [6, 13], [6, 16]]],
      art: [
        '^^^.....^^^^',
        '^^.....~~^^^',
        '#######.~~.^',
        '^.....#.....',
        '^^....#..^^.',
        '......#.....',
        '..#####...~~',
        '..#.......~~',
        '..#..^^.....',
        '..#########.',
        '^.........#.',
        '^^.~~.....#.',
        '^..~~.....#.',
        '......#####.',
        '^^....#...^^',
        '^^^...#..^^^'
      ] },
    { id: 'twin', name: 'Twin Gates', diff: 'hard', gold: 240, lives: 20, hp: 1.0,
      paths: [
        [[1, -1], [1, 3], [4, 3], [4, 7], [5, 7], [5, 10], [9, 10], [9, 13], [4, 13], [4, 16]],
        [[10, -1], [10, 3], [7, 3], [7, 7], [5, 7], [5, 10], [9, 10], [9, 13], [4, 13], [4, 16]]
      ],
      art: [
        '.#.^^..^^.#.',
        '.#.^....~.#.',
        '.#........#.',
        '.####..####.',
        '^...#..#...^',
        '^^..#..#..^^',
        '....#..#....',
        '~...####...~',
        '~~...#....~~',
        '.....#......',
        '^....#####..',
        '^^.......#..',
        '..~~.....#..',
        '..~~######..',
        '^...#.....^^',
        '^^..#....^^^'
      ] }
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- map data (derived once per map, shared by every game on it) ----
  function mkPath(pts) {
    var P = { x: [], y: [], cum: [0], len: 0 };
    for (var i = 0; i < pts.length; i++) {
      P.x.push(pts[i][0] + 0.5); P.y.push(pts[i][1] + 0.5);
      if (i) { P.len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]); P.cum.push(P.len); }
    }
    return P;
  }
  function mkLine(x0, y0, x1, y1) {
    var L = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    return { x: [x0, x1], y: [y0, y1], cum: [0, L], len: L };
  }
  // Every grid cell an axis-aligned waypoint path walks through, in order.
  function pathCells(pts) {
    var out = [];
    for (var i = 1; i < pts.length; i++) {
      var x = pts[i - 1][0], y = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      var dx = x1 > x ? 1 : x1 < x ? -1 : 0, dy = y1 > y ? 1 : y1 < y ? -1 : 0;
      while (true) {
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS) out.push(y * COLS + x);
        if (x === x1 && y === y1) break;
        x += dx; y += dy;
      }
    }
    return out;
  }
  var CELL_GRASS = 0, CELL_PATH = 1, CELL_ROCK = 2, CELL_WATER = 3;
  var MD = [];
  function mapData(mi) {
    if (MD[mi]) return MD[mi];
    var M = MAPS[mi], grid = [], i, j;
    for (i = 0; i < ROWS; i++) for (j = 0; j < COLS; j++) {
      var ch = M.art[i].charAt(j);
      grid.push(ch === '^' ? CELL_ROCK : ch === '~' ? CELL_WATER : CELL_GRASS);
    }
    var paths = [], fly = [], ends = [];
    for (i = 0; i < M.paths.length; i++) {
      var pts = M.paths[i], cells = pathCells(pts);
      for (j = 0; j < cells.length; j++) grid[cells[j]] = CELL_PATH;
      var P = mkPath(pts);
      paths.push(P);
      // Flyers ignore the road: straight from their gate to the exit.
      var n = P.x.length - 1;
      fly.push(mkLine(P.x[0], P.y[0], P.x[n], P.y[n]));
      ends.push(pts[pts.length - 1]);
    }
    MD[mi] = { grid: grid, paths: paths, fly: fly, exit: ends[0] };
    return MD[mi];
  }

  // ---- waves ----
  function parseWave(s) {
    var out = [], parts = s.split(' ');
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].charAt(0), n = parseInt(parts[i].slice(1), 10);
      out.push({ k: k, n: n, gap: ENEMIES[k].gap });
    }
    return out;
  }
  // Wave n (1-based). Past the last wave (free play) the last ten repeat, larger each lap.
  function waveSpec(n) {
    if (n <= WAVES) return parseWave(WAVE_TABLE[n - 1]);
    var lap = Math.floor((n - WAVES - 1) / 10) + 1, spec = parseWave(WAVE_TABLE[WAVES - 10 + (n - WAVES - 1) % 10]);
    for (var i = 0; i < spec.length; i++) {
      spec[i].n = spec[i].k === '@' ? spec[i].n + lap : Math.round(spec[i].n * (1 + 0.25 * lap));
      spec[i].gap *= Math.max(0.6, 1 - 0.1 * lap);
    }
    return spec;
  }
  function waveCount(n) { var s = waveSpec(n), c = 0; for (var i = 0; i < s.length; i++) c += s[i].n; return c; }
  function waveHasBoss(n) { var s = waveSpec(n); for (var i = 0; i < s.length; i++) if (s[i].k === '@') return true; return false; }
  function hpMul(n, mi) { var m = n - 1; return MAPS[mi].hp * (1 + BAL.hpLin * m + BAL.hpQuad * m * m); }
  function bountyFor(k, n) { return Math.round(ENEMIES[k].bounty * (1 + BAL.bountyGrow * (n - 1))); }
  function clearBonus(n) { return BAL.clearBase + BAL.clearPer * n; }

  // ---- tower stats ----
  function towerStat(type, lvl) {
    var T = TOWERS[type];
    return {
      dmg: T.dmg[lvl], rate: T.rate[lvl], range: T.range[lvl], splash: T.splash ? T.splash[lvl] : 0,
      slow: T.slow ? T.slow[lvl] : 0, slowDur: T.slowDur ? T.slowDur[lvl] : 0, chain: T.chain ? T.chain[lvl] : 0
    };
  }
  function upgradeCost(t) { return t.lvl < 2 ? TOWERS[t.type].cost[t.lvl + 1] : 0; }
  function sellValue(t) { return Math.floor(t.spent * SELL_RATE); }

  // ---- game ----
  function newGame(mi) {
    var M = MAPS[mi];
    mapData(mi);
    var g = {
      map: mi, gold: M.gold, lives: M.lives, maxLives: M.lives, wave: 0, phase: 'build', endless: false,
      countdown: 0, t: 0, steps: 0, nextId: 1, kills: 0, leaks: 0, spawnAlt: 0, zap: 0,
      towers: [], enemies: [], proj: [], fx: [], spawners: [], waveLeft: [], tgrid: [],
      epool: [], ppool: [], fxpool: [], events: [], fxOn: true, bonusLast: 0
    };
    for (var i = 0; i < COLS * ROWS; i++) g.tgrid.push(null);
    return g;
  }
  function inGrid(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
  function cellAt(g, c, r) { return inGrid(c, r) ? MD[g.map].grid[r * COLS + c] : -1; }
  function towerAt(g, c, r) { return inGrid(c, r) ? g.tgrid[r * COLS + c] : null; }
  function canBuild(g, c, r) { return cellAt(g, c, r) === CELL_GRASS && !towerAt(g, c, r) && g.phase !== 'won' && g.phase !== 'lost'; }

  function addTower(g, type, c, r, lvl, spent) {
    var T = TOWERS[type], t = {
      id: g.nextId++, type: type, lvl: lvl || 0, c: c, r: r, x: c + 0.5, y: r + 0.5, cd: 0,
      mode: T.mode, spent: spent || T.cost[0], kills: 0, dmg: 0, ax: 0, ay: -1, fireT: 0
    };
    g.towers.push(t);
    g.tgrid[r * COLS + c] = t;
    return t;
  }
  function build(g, c, r, type) {
    if (!canBuild(g, c, r) || type < 0 || type >= TOWERS.length) return null;
    var cost = TOWERS[type].cost[0];
    if (g.gold < cost) return null;
    g.gold -= cost;
    g.events.push('build');
    return addTower(g, type, c, r, 0, cost);
  }
  function upgrade(g, t) {
    if (!t || t.lvl >= 2 || g.phase === 'won' || g.phase === 'lost') return false;
    var cost = upgradeCost(t);
    if (g.gold < cost) return false;
    g.gold -= cost; t.spent += cost; t.lvl++;
    g.events.push('upgrade');
    return true;
  }
  function sell(g, t) {
    var i = g.towers.indexOf(t);
    if (i < 0) return 0;
    var v = sellValue(t);
    g.towers.splice(i, 1);
    g.tgrid[t.r * COLS + t.c] = null;
    g.gold += v;
    g.events.push('sell');
    return v;
  }
  function cycleMode(t) { if (!TOWERS[t.type].pulse) t.mode = (t.mode + 1) % MODES.length; return t.mode; }

  // ---- waves: start / call early ----
  function spawnLeft(sp) {             // seconds of spawning this spawner still has to do
    var s = Math.max(0, sp.t), g = sp.groups;
    if (sp.gi < g.length) s += (sp.left - 1) * g[sp.gi].gap;
    for (var i = sp.gi + 1; i < g.length; i++) s += GROUP_GAP + (g[i].n - 1) * g[i].gap;
    return s;
  }
  function moreWaves(g) { return g.endless || g.wave < WAVES; }
  // Seconds until the next wave would start by itself (null: no next wave / not running).
  function timeToNext(g) {
    if (g.phase !== 'wave' || !moreWaves(g)) return null;
    if (g.spawners.length) {
      var m = 0;
      for (var i = 0; i < g.spawners.length; i++) m = Math.max(m, spawnLeft(g.spawners[i]));
      return m + WAVE_GAP;
    }
    return g.countdown;
  }
  function earlyBonus(g) {
    var t = timeToNext(g);
    return t == null ? 0 : Math.floor(t * BAL.earlyRate * (1 + BAL.earlyGrow * g.wave));
  }
  function canCallWave(g) {
    if (g.phase === 'build') return true;
    return g.phase === 'wave' && moreWaves(g) && g.spawners.length < MAX_SPAWNERS;
  }
  function startWave(g) {
    g.wave++;
    var spec = waveSpec(g.wave), total = 0;
    for (var i = 0; i < spec.length; i++) total += spec[i].n;
    g.spawners.push({ n: g.wave, groups: spec, gi: 0, left: spec[0].n, t: 0.3 });
    g.waveLeft[g.wave] = total;
    g.countdown = 0;
    g.phase = 'wave';
    g.events.push(waveHasBoss(g.wave) ? 'boss' : 'wave');
  }
  // The "Next wave" button: starts the first wave, or calls the next one early for a bonus.
  function nextWave(g) {
    if (!canCallWave(g)) return -1;
    var bonus = g.phase === 'wave' ? earlyBonus(g) : 0;
    g.gold += bonus;
    g.bonusLast = bonus;
    startWave(g);
    return bonus;
  }

  // ---- pools ----
  function spawnEnemy(g, k, wave, pi) {
    if (g.enemies.length >= MAX_ENEMIES) { g.waveLeft[wave]--; return null; }
    var E = ENEMIES[k], e = g.epool.length ? g.epool.pop() : {};
    var id = g.nextId++, h = (id * 2654435761) >>> 0;
    e.id = id; e.k = k; e.wave = wave; e.pi = pi; e.fly = !!E.fly; e.boss = !!E.boss;
    e.maxHp = e.hp = Math.round(E.hp * hpMul(wave, g.map));
    e.spd = E.spd; e.armor = E.armor; e.bounty = bountyFor(k, wave); e.lives = E.lives;
    e.d = 0; e.seg = 0; e.slowF = 0; e.slowT = 0; e.pend = 0; e.flash = 0; e.zap = 0; e.alive = true;
    // A small fixed offset so a crowd doesn't stack on one line (bosses walk the middle).
    e.ox = e.boss ? 0 : ((h & 255) / 255 - 0.5) * 0.34;
    e.oy = e.boss ? 0 : (((h >>> 8) & 255) / 255 - 0.5) * 0.34;
    e.dir = 0; e.x = 0; e.y = 0;
    placeEnemy(g, e);
    e.px = e.x; e.py = e.y;
    g.enemies.push(e);
    return e;
  }
  function pathOf(g, e) { var md = MD[g.map]; return e.fly ? md.fly[e.pi] : md.paths[e.pi]; }
  function placeEnemy(g, e) {
    var P = pathOf(g, e), n = P.cum.length - 1;
    while (e.seg < n - 1 && P.cum[e.seg + 1] <= e.d) e.seg++;
    var s = e.seg, L = P.cum[s + 1] - P.cum[s], f = L > 0 ? (e.d - P.cum[s]) / L : 0;
    if (f > 1) f = 1;
    var dx = P.x[s + 1] - P.x[s], dy = P.y[s + 1] - P.y[s];
    e.x = P.x[s] + dx * f + e.ox; e.y = P.y[s] + dy * f + e.oy;
    e.rem = P.len - e.d;
    e.dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);   // → ↓ ← ↑
  }
  function addFx(g, kind, x, y, x2, y2, life, a, txt) {
    if (!g.fxOn || g.fx.length >= MAX_FX) return null;
    var f = g.fxpool.length ? g.fxpool.pop() : {};
    f.kind = kind; f.x = x; f.y = y; f.x2 = x2; f.y2 = y2; f.t = 0; f.life = life; f.a = a; f.txt = txt || '';
    g.fx.push(f);
    return f;
  }

  // ---- damage ----
  function hurt(g, e, dmg, pierce, t) {
    if (!e.alive) return;
    var eff = pierce ? dmg : Math.max(dmg * 0.25, dmg - e.armor);
    if (eff > e.hp) eff = e.hp;
    e.hp -= eff; e.flash = 0.09;
    if (t) t.dmg += eff;
    if (e.hp <= 0.001) {
      e.alive = false; e.hp = 0;
      g.gold += e.bounty; g.kills++;
      if (t) t.kills++;
      g.events.push(e.boss ? 'bosskill' : 'kill');
      addFx(g, 5, e.x, e.y, 0, 0, 0.9, 0, '+' + e.bounty);
      addFx(g, 6, e.x, e.y, 0, 0, 0.3, e.boss ? 1.4 : 0.5, '');
      waveDone(g, e.wave);
    }
  }
  function waveDone(g, n) {
    if (--g.waveLeft[n] === 0 && g.phase === 'wave') {
      g.gold += clearBonus(n);
      g.events.push('clear');
    }
  }
  function inRange(e, t, r2) { var dx = e.x - t.x, dy = e.y - t.y; return dx * dx + dy * dy <= r2; }

  // Best target for a tower by its mode; enemies already doomed by shots in flight are skipped.
  function pickTarget(g, t, r2, air) {
    var best = null, bv = 0, mode = t.mode, en = g.enemies;
    for (var i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive || (e.fly && !air) || e.pend >= e.hp) continue;
      var dx = e.x - t.x, dy = e.y - t.y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      var v = mode === 0 ? -e.rem : mode === 1 ? e.rem : mode === 2 ? e.hp + e.rem * 0.001 : -d2;
      if (!best || v > bv) { best = e; bv = v; }
    }
    return best;
  }

  function fire(g, t) {
    var T = TOWERS[t.type], lv = t.lvl, range = T.range[lv], r2 = range * range, en = g.enemies, i, e;
    if (T.pulse) {                                         // Frost: chill everything in range
      var hit = false, s = T.slow[lv], dur = T.slowDur[lv];
      for (i = 0; i < en.length; i++) {
        e = en[i];
        if (!e.alive || !inRange(e, t, r2)) continue;
        hit = true;
        var se = e.boss ? s * 0.5 : s;
        if (se >= e.slowF) { e.slowF = se; if (dur > e.slowT) e.slowT = dur; }
        else if (dur > e.slowT && se === e.slowF) e.slowT = dur;
        hurt(g, e, T.dmg[lv], false, t);
      }
      if (hit) { addFx(g, 4, t.x, t.y, 0, 0, 0.4, range, ''); t.fireT = 0.2; g.events.push('frost'); }
      return hit;
    }
    var tg = pickTarget(g, t, r2, T.air);
    if (!tg) return false;
    t.ax = tg.x - t.x; t.ay = tg.y - t.y; t.fireT = 0.12;
    var dmg = T.dmg[lv];
    if (t.type === TKEY.tesla) {                            // chain to the nearest unzapped neighbours
      var stamp = ++g.zap, cur = tg, n = T.chain[lv];
      cur.zap = stamp;
      addFx(g, 2, t.x, t.y - 0.15, cur.x, cur.y, 0.2, 0, '');
      hurt(g, cur, dmg, false, t);
      for (var j = 0; j < n; j++) {
        var nx = null, nd = 1.6 * 1.6;
        for (i = 0; i < en.length; i++) {
          e = en[i];
          if (!e.alive || e.zap === stamp) continue;
          var dx = e.x - cur.x, dy = e.y - cur.y, d2 = dx * dx + dy * dy;
          if (d2 < nd) { nd = d2; nx = e; }
        }
        if (!nx) break;
        nx.zap = stamp; dmg *= 0.8;
        addFx(g, 2, cur.x, cur.y, nx.x, nx.y, 0.2, 0, '');
        hurt(g, nx, dmg, false, t);
        cur = nx;
      }
      g.events.push('zap');
      return true;
    }
    if (t.type === TKEY.sniper) {                           // instant, armour-piercing
      addFx(g, 3, t.x, t.y, tg.x, tg.y, 0.18, 0, '');
      hurt(g, tg, dmg, true, t);
      g.events.push('snipe');
      return true;
    }
    // Arrow / Cannon: a homing projectile from the pool.
    if (g.proj.length >= MAX_PROJ) return false;
    var p = g.ppool.length ? g.ppool.pop() : {};
    p.x = p.px = t.x; p.y = p.py = t.y - 0.1; p.tg = tg; p.tid = tg.id; p.tx = tg.x; p.ty = tg.y;
    p.dmg = dmg; p.spd = T.pspd; p.splash = T.splash ? T.splash[lv] : 0; p.tw = t; p.cannon = t.type === TKEY.cannon;
    p.ex = Math.max(dmg * 0.25, dmg - tg.armor);
    if (!p.cannon) tg.pend += p.ex;
    g.proj.push(p);
    g.events.push(p.cannon ? 'boom0' : 'shot');
    return true;
  }

  function impact(g, p) {
    var tg = p.tg, live = tg && tg.id === p.tid && tg.alive;
    if (live && !p.cannon) tg.pend = Math.max(0, tg.pend - p.ex);
    if (p.cannon) {
      var r2 = p.splash * p.splash, en = g.enemies;
      for (var i = 0; i < en.length; i++) {
        var e = en[i];
        if (!e.alive || e.fly) continue;
        var dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy <= r2) hurt(g, e, p.dmg, false, p.tw);
      }
      addFx(g, 1, p.x, p.y, 0, 0, 0.35, p.splash, '');
      g.events.push('boom');
    } else if (live) {
      hurt(g, tg, p.dmg, false, p.tw);
    }
  }

  // ---- one fixed step ----
  function step(g) {
    if (g.phase !== 'wave') return;
    g.t += STEP; g.steps++;
    var i, en = g.enemies, md = MD[g.map];

    // spawners
    for (i = 0; i < g.spawners.length; i++) {
      var sp = g.spawners[i];
      sp.t -= STEP;
      while (sp.t <= 0 && sp.gi < sp.groups.length) {
        var gr = sp.groups[sp.gi], k = gr.k, pi = 0;
        if (md.paths.length > 1) { pi = g.spawnAlt % md.paths.length; g.spawnAlt++; }
        spawnEnemy(g, k, sp.n, pi);
        if (--sp.left > 0) sp.t += gr.gap;
        else { sp.gi++; if (sp.gi < sp.groups.length) { sp.left = sp.groups[sp.gi].n; sp.t += GROUP_GAP; } }
      }
      if (sp.gi >= sp.groups.length) {
        g.spawners.splice(i, 1); i--;
        if (!g.spawners.length && moreWaves(g)) g.countdown = WAVE_GAP;
      }
    }
    if (!g.spawners.length && g.countdown > 0) {
      g.countdown -= STEP;
      if (g.countdown <= 0) { g.countdown = 0; startWave(g); }
    }

    // enemies walk
    for (i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive) continue;
      e.px = e.x; e.py = e.y;
      var v = e.spd;
      if (e.slowT > 0) { v *= 1 - e.slowF; e.slowT -= STEP; if (e.slowT <= 0) { e.slowT = 0; e.slowF = 0; } }
      if (e.flash > 0) e.flash -= STEP;
      e.d += v * STEP;
      var P = pathOf(g, e);
      if (e.d >= P.len) {                                  // reached the exit
        e.alive = false;
        g.lives -= e.lives; g.leaks += e.lives;
        g.events.push('leak');
        addFx(g, 5, P.x[P.x.length - 1], P.y[P.y.length - 1] - 0.4, 0, 0, 1.0, 1, '-' + e.lives + '♥');
        waveDone(g, e.wave);
        if (g.lives <= 0) { g.lives = 0; g.phase = 'lost'; g.events.push('lose'); }
      } else placeEnemy(g, e);
    }

    // towers
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i];
      if (t.fireT > 0) t.fireT -= STEP;
      if (t.cd > 0) { t.cd -= STEP; if (t.cd > 0) continue; }
      if (fire(g, t)) t.cd += 1 / TOWERS[t.type].rate[t.lvl];
      else t.cd = 0;
    }

    // projectiles
    var pr = g.proj;
    for (i = pr.length - 1; i >= 0; i--) {
      var p = pr[i], tg = p.tg;
      p.px = p.x; p.py = p.y;
      if (tg && tg.id === p.tid && tg.alive) { p.tx = tg.x; p.ty = tg.y; }
      else if (!p.cannon) { pr[i] = pr[pr.length - 1]; pr.pop(); g.ppool.push(p); p.tg = null; continue; }   // target gone: arrow fizzles
      var dx = p.tx - p.x, dy = p.ty - p.y, d = Math.sqrt(dx * dx + dy * dy), s = p.spd * STEP;
      if (d <= s) {
        p.x = p.tx; p.y = p.ty;
        impact(g, p);
        pr[i] = pr[pr.length - 1]; pr.pop(); g.ppool.push(p); p.tg = null; p.tw = null;
      } else { p.x += dx / d * s; p.y += dy / d * s; }
    }

    // sweep the dead (swap-remove into the pool)
    for (i = en.length - 1; i >= 0; i--) {
      if (!en[i].alive) { var dead = en[i]; en[i] = en[en.length - 1]; en.pop(); g.epool.push(dead); }
    }

    // effects age
    var fx = g.fx;
    for (i = fx.length - 1; i >= 0; i--) {
      fx[i].t += STEP;
      if (fx[i].t >= fx[i].life) { var f = fx[i]; fx[i] = fx[fx.length - 1]; fx.pop(); g.fxpool.push(f); }
    }

    if (g.phase === 'wave' && !moreWaves(g) && !g.spawners.length && !en.length) {
      g.phase = 'won';
      g.events.push('win');
    }
  }

  // Fixed-timestep accumulator: real seconds x speed in STEP slices. Returns the render alpha.
  function advance(g, dt, speed) {
    g.acc = (g.acc || 0) + clamp(dt, 0, 0.1) * (speed || 1);
    var n = 0, cap = 8 * (speed || 1);
    while (g.acc >= STEP - 1e-7) {
      step(g);
      g.acc -= STEP;
      if (++n >= cap) { g.acc = 0; break; }
    }
    return clamp(g.acc / STEP, 0, 1);
  }

  function stars(g) {
    if (g.phase !== 'won' && !g.endless) return 0;           // free play only follows a win
    var f = (g.endless ? g.livesAtWin : g.lives) / g.maxLives;
    return f >= 0.9 ? 3 : f >= 0.5 ? 2 : 1;
  }
  function starsFor(lives, maxLives) { var f = lives / maxLives; return f >= 0.9 ? 3 : f >= 0.5 ? 2 : 1; }
  // After a win: keep going with endless waves.
  function goEndless(g) {
    if (g.phase !== 'won') return false;
    g.livesAtWin = g.lives;
    g.endless = true; g.phase = 'wave'; g.countdown = WAVE_GAP;
    return true;
  }

  // ---- save / restore (plain JSON; projectiles and effects are not kept) ----
  function serialize(g) {
    var o = {
      v: 1, map: g.map, gold: g.gold, lives: g.lives, maxLives: g.maxLives, wave: g.wave, phase: g.phase,
      endless: g.endless, livesAtWin: g.livesAtWin || 0, countdown: +g.countdown.toFixed(4), t: +g.t.toFixed(4),
      steps: g.steps, nextId: g.nextId, kills: g.kills, leaks: g.leaks, spawnAlt: g.spawnAlt,
      waveLeft: g.waveLeft.slice(), towers: [], enemies: [], spawners: []
    }, i;
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i];
      o.towers.push([t.id, t.type, t.lvl, t.c, t.r, +t.cd.toFixed(4), t.mode, t.spent, t.kills, Math.round(t.dmg)]);
    }
    for (i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (!e.alive) continue;
      o.enemies.push([e.id, e.k, +e.hp.toFixed(3), e.maxHp, +e.d.toFixed(4), e.pi, e.slowF, +e.slowT.toFixed(3), e.wave, e.bounty]);
    }
    for (i = 0; i < g.spawners.length; i++) {
      var sp = g.spawners[i];
      o.spawners.push({ n: sp.n, gi: sp.gi, left: sp.left, t: +sp.t.toFixed(4) });
    }
    for (i = 0; i < o.waveLeft.length; i++) if (o.waveLeft[i] == null) o.waveLeft[i] = 0;
    return o;
  }
  function restore(o) {
    if (!o || o.v !== 1 || !MAPS[o.map]) return null;
    var g = newGame(o.map), i;
    g.gold = o.gold; g.lives = o.lives; g.maxLives = o.maxLives; g.wave = o.wave; g.phase = o.phase;
    g.endless = !!o.endless; g.livesAtWin = o.livesAtWin || 0; g.countdown = o.countdown; g.t = o.t; g.steps = o.steps;
    g.nextId = o.nextId; g.kills = o.kills; g.leaks = o.leaks; g.spawnAlt = o.spawnAlt || 0;
    g.waveLeft = (o.waveLeft || []).slice();
    for (i = 0; i < o.towers.length; i++) {
      var a = o.towers[i];
      if (!inGrid(a[3], a[4]) || !TOWERS[a[1]] || cellAt(g, a[3], a[4]) !== CELL_GRASS || towerAt(g, a[3], a[4])) continue;
      var t = addTower(g, a[1], a[3], a[4], clamp(a[2] | 0, 0, 2), a[7]);
      t.id = a[0]; t.cd = a[5]; t.mode = a[6] | 0; t.kills = a[8]; t.dmg = a[9];
    }
    var md = MD[g.map];
    for (i = 0; i < o.enemies.length; i++) {
      var b = o.enemies[i];
      if (!ENEMIES[b[1]]) continue;
      var pi = b[5] < (ENEMIES[b[1]].fly ? md.fly.length : md.paths.length) ? b[5] : 0;
      var e = spawnEnemy(g, b[1], b[8], pi);
      if (!e) continue;
      e.id = b[0]; e.hp = b[2]; e.maxHp = b[3]; e.d = b[4]; e.slowF = b[6]; e.slowT = b[7]; e.bounty = b[9];
      var h = (e.id * 2654435761) >>> 0;
      e.ox = e.boss ? 0 : ((h & 255) / 255 - 0.5) * 0.34;
      e.oy = e.boss ? 0 : (((h >>> 8) & 255) / 255 - 0.5) * 0.34;
      placeEnemy(g, e); e.px = e.x; e.py = e.y;
    }
    for (i = 0; i < o.spawners.length; i++) {
      var s = o.spawners[i], spec = waveSpec(s.n);
      g.spawners.push({ n: s.n, groups: spec, gi: s.gi, left: s.left, t: s.t });
    }
    g.nextId = o.nextId;                                   // re-spawning above advanced it
    g.events.length = 0;
    return g;
  }

  var ENGINE = {
    BAL: BAL, COLS: COLS, ROWS: ROWS, STEP: STEP, WAVES: WAVES, WAVE_GAP: WAVE_GAP, SELL_RATE: SELL_RATE, MODES: MODES,
    TOWERS: TOWERS, TKEY: TKEY, ENEMIES: ENEMIES, MAPS: MAPS, WAVE_TABLE: WAVE_TABLE,
    CELL_GRASS: CELL_GRASS, CELL_PATH: CELL_PATH, CELL_ROCK: CELL_ROCK, CELL_WATER: CELL_WATER,
    mapData: mapData, pathCells: pathCells, waveSpec: waveSpec, waveCount: waveCount, waveHasBoss: waveHasBoss,
    hpMul: hpMul, bountyFor: bountyFor, clearBonus: clearBonus, towerStat: towerStat, upgradeCost: upgradeCost,
    sellValue: sellValue, newGame: newGame, canBuild: canBuild, towerAt: towerAt, cellAt: cellAt, build: build,
    upgrade: upgrade, sell: sell, cycleMode: cycleMode, nextWave: nextWave, canCallWave: canCallWave,
    earlyBonus: earlyBonus, timeToNext: timeToNext, pickTarget: pickTarget, step: step, advance: advance,
    stars: stars, starsFor: starsFor, goEndless: goEndless, serialize: serialize, restore: restore,
    spawnEnemy: spawnEnemy, hurt: hurt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= UI =================
  var Cade = window.Cade;
  Cade.loadCSS('towerdefense.css');

  var PANEL_ID = 'towerdefense-panel', TITLE = '🏰 Tower Defense';
  var PROG_KEY = 'cade-td-progress', SAVE_KEY = 'cade-td-save';
  var CELL = 30, VW = COLS * CELL, VH = ROWS * CELL;      // logical canvas units; scaled to fit
  var BRACKETS = [['[', ']'], ['{', '}'], ['«', '»']], PIPS = ['·', '··', '···'];
  var RUNNER = ['>', 'v', '<', '^'];
  var GRASS = ['"', ',', '\'', '`', ',', '.', '"', ','];
  var ROCKS = [[' ^ ', '^ ^'], ['^  ', ' ^^'], ['  ^', '^^ '], [' ^ ', '^^^']];
  var S = null;                                          // the live session (one panel)

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, v); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function perfNow() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }

  // ---- progress: best wave + stars per map ----
  function loadProg() {
    var p = null;
    try { p = JSON.parse(sget(PROG_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p !== 'object') p = {};
    var maps = {};
    for (var i = 0; i < MAPS.length; i++) {
      var m = (p.maps && p.maps[MAPS[i].id]) || {};
      maps[MAPS[i].id] = { best: Math.max(0, m.best | 0), stars: clamp(m.stars | 0, 0, 3) };
    }
    return { maps: maps, sound: !!p.sound };
  }
  function saveProg() { if (S) sset(PROG_KEY, JSON.stringify(S.prog)); }
  function unlocked(i) { return i === 0 || (S && S.prog.maps[MAPS[i - 1].id].stars > 0); }
  function loadSave() {
    try {
      var o = JSON.parse(sget(SAVE_KEY) || 'null');
      return o && o.v === 1 && o.g && MAPS[o.g.map] ? o : null;
    } catch (e) { return null; }
  }
  function saveGame() {
    if (!S || !S.g) return;
    if (S.g.phase === 'lost' || (S.g.phase === 'build' && !S.g.towers.length)) { sdel(SAVE_KEY); return; }
    sset(SAVE_KEY, JSON.stringify({ v: 1, g: serialize(S.g), speed: S.speed }));
  }

  // ---- sound: a tiny WebAudio voice, created on a user gesture (iOS), off by default ----
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
      g.gain.exponentialRampToValueAtTime(vol || 0.04, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_PAUSE = svg('<path d="M9 5v14M15 5v14"/>');
  var IC_PLAY = svg('<path d="M7 5l12 7-12 7z"/>', true);

  // ---- theme colours (from the app's CSS variables) ----
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
    function v(n, d) { return parseCol(cs.getPropertyValue(n), d); }
    var bg = v('--bg', [250, 250, 249]), tx = v('--text', [28, 25, 23]);
    var dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45;
    function pal(n, l, d) { return v(n, dark ? d : l); }
    // Syntax-token colours are theme-tuned by the app: strong on light, pastel on dark.
    var green = pal('--tok-str', [21, 128, 61], [134, 239, 172]), blue = pal('--tok-fn', [2, 132, 199], [125, 211, 252]);
    var amber = pal('--tok-num', [180, 83, 9], [252, 211, 77]), purple = pal('--tok-kw', [124, 58, 237], [196, 181, 253]);
    var pink = pal('--tok-tag', [190, 24, 93], [249, 168, 212]), teal = pal('--tok-bui', [13, 148, 136], [94, 234, 212]);
    var red = pal('--error', [220, 38, 38], [248, 113, 113]), orange = pal('--ws-orange-fg', [194, 65, 12], [253, 186, 116]);
    var ac = v('--accent', [15, 149, 152]), mu = v('--text-muted', [120, 113, 108]);
    var tcs = [amber, orange, blue, purple, teal];
    S.dark = dark;
    S.col = {
      font: (cs.getPropertyValue('--font-mono') || '').trim() || 'ui-monospace, monospace',
      bg: css(bg), text: css(tx), muted: css(mu), accent: css(ac), accentFill: css(ac, 0.1),
      grass: css(mix(bg, green, dark ? 0.42 : 0.4)), grass2: css(mix(bg, green, dark ? 0.26 : 0.24)),
      road: css(mix(bg, tx, dark ? 0.07 : 0.055)), gravel: css(mix(bg, tx, dark ? 0.3 : 0.26)), edge: css(mix(bg, tx, dark ? 0.17 : 0.14)),
      rockFill: css(mix(bg, tx, 0.035)), rock: css(mix(bg, tx, dark ? 0.46 : 0.42)),
      waterFill: css(mix(bg, blue, dark ? 0.12 : 0.1)), water: css(mix(bg, blue, dark ? 0.62 : 0.55)),
      lane: css(mix(bg, pink, dark ? 0.32 : 0.3)), gate: css(ac), base: css(red),
      enemy: css(tx), flyer: css(pink), boss: css(red), hit: css(mix(bg, tx, 0.35)), frost: css(blue),
      shadow: css(mix(bg, tx, 0.22)), hpBack: css(mix(bg, tx, dark ? 0.22 : 0.16)),
      hpHi: css(green), hpMid: css(amber), hpLo: css(red),
      gold: css(amber), bad: css(red), boom: css(orange), zap: css(purple), tracer: css(teal), ring: css(ac),
      shade: css(bg, 0.86), tipBorder: css(mix(bg, tx, 0.45)),
      tc: [], tdim: [], tile: []
    };
    for (var i = 0; i < tcs.length; i++) {
      S.col.tc.push(css(tcs[i]));
      S.col.tdim.push(css(mix(bg, tcs[i], 0.62)));
      S.col.tile.push([css(mix(bg, tcs[i], 0.09)), css(mix(bg, tcs[i], 0.15)), css(mix(bg, tcs[i], 0.24))]);
    }
    fitFont();
    S.baseDirty = true;
  }

  // ---- fonts: glyphs are fitted to the mono font's real advance, 3 per cell ----
  function fitFont() {
    var c = S.ctx, f = S.col.font;
    c.font = '600 100px ' + f;
    var adv = c.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    function fnt(w, advUnits) { return w + ' ' + (advUnits / adv).toFixed(2) + 'px ' + f; }
    S.fG = fnt(600, CELL / 3);          // map tiles, tower brackets
    S.fTower = fnt(800, CELL / 3 * 1.08);
    S.fE = fnt(800, CELL / 3 * 0.98);   // enemies
    S.fTank = fnt(800, CELL / 3 * 1.12);
    S.fBoss = fnt(800, CELL / 3 * 1.6);
    S.fSm = fnt(600, 7.2);              // tooltip text
    S.fSmB = fnt(700, 7.2);
    S.fTiny = fnt(700, 5.6);            // pips, popups
    S.fBan = fnt(800, 12);              // banners
    S.tipAdv = 7.2;
    S.wcache = {};
    S.tipKey = '';
  }

  // ---- static layer: map + towers, pre-rendered once (rebuilt when towers / theme / size change) ----
  function hash(a, b, c) { var h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); return (h ^ (h >>> 15)) >>> 0; }
  function curMap() { return S.g ? S.g.map : S.viewMap; }
  function buildBase() {
    var W = S.cv.width, H = S.cv.height;
    if (!S.base) S.base = document.createElement('canvas');
    if (S.base.width !== W) S.base.width = W;
    if (S.base.height !== H) S.base.height = H;
    var c = S.base.getContext('2d'), k = S.col, mi = curMap(), md = mapData(mi), grid = md.grid, i, j;
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.fillStyle = k.bg; c.fillRect(0, 0, VW, VH);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = S.fG;
    for (j = 0; j < ROWS; j++) for (i = 0; i < COLS; i++) {
      var t = grid[j * COLS + i], x0 = i * CELL, y0 = j * CELL, h = hash(i + 1, j + 1, mi + 1), s, m;
      if (t === CELL_PATH) {
        c.fillStyle = k.road; c.fillRect(x0, y0, CELL, CELL);
        c.fillStyle = k.gravel;
        for (s = 0; s < 6; s++) if (((h >>> (s * 3)) & 7) < 3) c.fillText('·', x0 + 5 + (s % 3) * 10, y0 + 7.5 + (s > 2 ? 15 : 0));
      } else if (t === CELL_ROCK) {
        c.fillStyle = k.rockFill; c.fillRect(x0, y0, CELL, CELL);
        c.fillStyle = k.rock; m = ROCKS[h & 3];
        for (s = 0; s < 3; s++) {
          if (m[0].charAt(s) !== ' ') c.fillText('^', x0 + 5 + s * 10, y0 + 9);
          if (m[1].charAt(s) !== ' ') c.fillText('^', x0 + 5 + s * 10, y0 + 22);
        }
      } else if (t === CELL_WATER) {
        c.fillStyle = k.waterFill; c.fillRect(x0, y0, CELL, CELL);
        c.fillStyle = k.water;
        var odd = (i + j) & 1;
        for (s = 0; s < 3; s++) {
          if ((s + odd) % 2 === 0) c.fillText('~', x0 + 5 + s * 10, y0 + 8);
          else c.fillText('~', x0 + 5 + s * 10, y0 + 22);
        }
      } else {
        for (s = 0; s < 6; s++) {
          var b = (h >>> (s * 4)) & 15;
          if (b < 3) { c.fillStyle = b ? k.grass2 : k.grass; c.fillText(GRASS[(h >>> (s + 7)) & 7], x0 + 5 + (s % 3) * 10, y0 + 7.5 + (s > 2 ? 15 : 0)); }
        }
      }
    }
    // Road edges: a hairline where the road meets anything else.
    c.fillStyle = k.edge;
    for (j = 0; j < ROWS; j++) for (i = 0; i < COLS; i++) {
      if (grid[j * COLS + i] !== CELL_PATH) continue;
      var x = i * CELL, y = j * CELL;
      if (j > 0 && grid[(j - 1) * COLS + i] !== CELL_PATH) c.fillRect(x, y, CELL, 1);
      if (j < ROWS - 1 && grid[(j + 1) * COLS + i] !== CELL_PATH) c.fillRect(x, y + CELL - 1, CELL, 1);
      if (i > 0 && grid[j * COLS + i - 1] !== CELL_PATH) c.fillRect(x, y, 1, CELL);
      if (i < COLS - 1 && grid[j * COLS + i + 1] !== CELL_PATH) c.fillRect(x + CELL - 1, y, 1, CELL);
    }
    // Flyer lanes: a faint dotted line from each gate straight to the base, off the road.
    c.fillStyle = k.lane; c.font = S.fTiny;
    for (i = 0; i < md.fly.length; i++) {
      var F = md.fly[i], n = Math.floor(F.len * 3);
      for (s = 2; s < n; s++) {
        var fx = F.x[0] + (F.x[1] - F.x[0]) * s / n, fy = F.y[0] + (F.y[1] - F.y[0]) * s / n, ci = Math.floor(fx), cj = Math.floor(fy);
        if (ci < 0 || cj < 0 || ci >= COLS || cj >= ROWS || grid[cj * COLS + ci] === CELL_PATH) continue;
        c.fillText('·', fx * CELL, fy * CELL);
      }
    }
    // Gates (arrows pointing in) and the base (⌂) you defend.
    c.font = S.fTower;
    var M = MAPS[mi];
    for (i = 0; i < M.paths.length; i++) {
      var pts = M.paths[i], cells = pathCells(pts), first = cells[0], last = cells[cells.length - 1];
      var dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
      c.fillStyle = k.gate;
      c.fillText(dx > 0 ? '→' : dx < 0 ? '←' : dy > 0 ? '↓' : '↑', (first % COLS) * CELL + CELL / 2, Math.floor(first / COLS) * CELL + CELL / 2);
      if (i === 0) { c.fillStyle = k.base; c.fillText('⌂', (last % COLS) * CELL + CELL / 2, Math.floor(last / COLS) * CELL + CELL / 2); }
    }
    if (S.g) for (i = 0; i < S.g.towers.length; i++) drawTower(c, S.g.towers[i], 1);
    S.baseDirty = false;
  }
  function drawTower(c, t, solid) {
    var k = S.col, T = TOWERS[t.type], x0 = t.c * CELL, y0 = t.r * CELL, cx = x0 + CELL / 2, cy = y0 + CELL / 2 - 2.5, br = BRACKETS[t.lvl];
    if (solid) { c.fillStyle = k.tile[t.type][t.lvl]; c.fillRect(x0 + 1, y0 + 1, CELL - 2, CELL - 2); }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = S.fG; c.fillStyle = t.lvl === 2 ? k.tc[t.type] : k.tdim[t.type];
    c.fillText(br[0], cx - 9.5, cy); c.fillText(br[1], cx + 9.5, cy);
    c.font = S.fTower; c.fillStyle = k.tc[t.type];
    c.fillText(T.glyph, cx, cy);
    c.font = S.fTiny; c.fillText(PIPS[t.lvl], cx, y0 + CELL - 5.5);
  }

  // ---- dynamic drawing ----
  function setFont(c, f) { if (S.curFont !== f) { c.font = f; S.curFont = f; } }
  function ring(c, cx, cy, rad, color, fill) {
    if (fill) { c.fillStyle = fill; c.beginPath(); c.arc(cx, cy, rad, 0, 6.2832); c.fill(); }
    var n = Math.max(20, Math.floor(rad * 6.2832 / 7)), i;
    c.fillStyle = color;
    for (i = 0; i < n; i++) { var a = i / n * 6.2832; c.fillText('·', cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  var ARC_CH = ['-', '\\', '|', '/'];
  function lineChar(dx, dy) {                            // the ASCII stroke closest to a direction
    var a = Math.atan2(dy, dx); if (a < 0) a += Math.PI;
    return ARC_CH[Math.round(a / (Math.PI / 4)) % 4];
  }

  // One frame: the pre-rendered layer, then only what moves. Split into small
  // functions so the engine can optimise each hot loop on its own.
  function draw(alpha) {
    if (!S || !S.ctx || !S.col) return;
    var c = S.ctx, k = S.col, g = S.g, a = alpha == null ? 1 : alpha;
    if (S.baseDirty || !S.base) buildBase();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(S.base, 0, 0);
    c.setTransform(S.k, 0, 0, S.k, 0, 0);
    c.textAlign = 'center'; c.textBaseline = 'middle'; S.curFont = null;
    setFont(c, S.fG);
    if (!g) return;
    drawSel(c, g, k);
    drawEnemies(c, g, k, a);
    drawShots(c, g, k, a);
    if (g.fx.length) drawFx(c, g, k);
    drawTip(c);
    drawNotes(c, g, k);
  }
  // selection, range ring, build preview, towers that just fired
  function drawSel(c, g, k) {
    var i, selT = S.selT, sel = S.sel, armed = S.armed;
    if (selT) {
      ring(c, selT.x * CELL, selT.y * CELL, TOWERS[selT.type].range[selT.lvl] * CELL, k.ring, k.accentFill);
      c.strokeStyle = k.accent; c.lineWidth = 1.5; c.strokeRect(selT.c * CELL + 0.75, selT.r * CELL + 0.75, CELL - 1.5, CELL - 1.5);
    }
    var pc = sel || (armed >= 0 ? S.hover : null);
    if (pc && !towerAt(g, pc.c, pc.r)) {
      var ok = canBuild(g, pc.c, pc.r);
      if (armed >= 0 && ok) {
        ring(c, (pc.c + 0.5) * CELL, (pc.r + 0.5) * CELL, TOWERS[armed].range[0] * CELL, k.ring, k.accentFill);
        c.globalAlpha = 0.75;
        S.ghost.type = armed; S.ghost.c = pc.c; S.ghost.r = pc.r;
        drawTower(c, S.ghost, false);
        c.globalAlpha = 1; S.curFont = null;
      }
      if (sel === pc) { c.strokeStyle = ok ? k.accent : k.bad; c.lineWidth = 1.5; c.strokeRect(pc.c * CELL + 0.75, pc.r * CELL + 0.75, CELL - 1.5, CELL - 1.5); }
    }
    // towers that just fired: the core glyph blinks
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i];
      if (t.fireT > 0.06) { setFont(c, S.fTower); c.fillStyle = k.text; c.fillText(TOWERS[t.type].glyph, t.x * CELL, t.y * CELL - 2.5); }
    }
  }
  // enemies: ground first, flyers above
  function drawEnemies(c, g, k, a) {
    var en = g.enemies, pass, i, j;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < en.length; i++) {
        var e = en[i];
        if (!e.alive || (e.fly ? 0 : 1) === pass) continue;
        var ex = lerp(e.px, e.x, a) * CELL, ey = lerp(e.py, e.y, a) * CELL, E = ENEMIES[e.k], ch = e.k === '>' ? RUNNER[e.dir] : E.glyph;
        if (e.fly) {
          setFont(c, S.fTiny); c.fillStyle = k.shadow; c.fillText('·', ex, ey + 6);
          ey -= 6 + Math.sin(g.t * 6 + e.id) * 1.5;
        }
        setFont(c, e.boss ? S.fBoss : e.k === 'O' ? S.fTank : S.fE);
        c.fillStyle = e.flash > 0 ? k.hit : e.slowT > 0 ? k.frost : e.boss ? k.boss : e.fly ? k.flyer : k.enemy;
        if (e.k === 'O') {                               // tanks: a wide, heavy O (narrow fonts make it read as a 0)
          c.setTransform(S.k * 1.35, 0, 0, S.k, ex * S.k, ey * S.k);
          c.fillText(ch, 0, 0);
          c.setTransform(S.k, 0, 0, S.k, 0, 0);
        } else c.fillText(ch, ex, ey);
        if (e.hp < e.maxHp) {                            // segmented HP bar: ▬▬▬▭▭
          var segs = e.boss ? 10 : 5, sw = e.boss ? 3 : 3.2, w = segs * sw, bx = ex - w / 2, by = ey - (e.boss ? 16 : e.k === 'O' ? 12.5 : 11), f = e.hp / e.maxHp;
          var on = Math.ceil(f * segs);
          c.fillStyle = f > 0.6 ? k.hpHi : f > 0.3 ? k.hpMid : k.hpLo;
          for (j = 0; j < on; j++) c.fillRect(bx + j * sw, by, sw - 0.9, 2.4);
          c.fillStyle = k.hpBack;
          for (; j < segs; j++) c.fillRect(bx + j * sw, by, sw - 0.9, 2.4);
        }
      }
    }
  }
  function drawShots(c, g, k, a) {
    var pr = g.proj, i;
    for (i = 0; i < pr.length; i++) {
      var p = pr[i], qx = lerp(p.px, p.x, a) * CELL, qy = lerp(p.py, p.y, a) * CELL;
      if (p.cannon) { setFont(c, S.fTiny); c.fillStyle = k.boom; c.fillText('●', qx, qy); }
      else { setFont(c, S.fG); c.fillStyle = k.tc[0]; c.fillText(lineChar(p.x - p.px, p.y - p.py), qx, qy); }
    }
  }
  function drawFx(c, g, k) {
    var fx = g.fx, i, j;
    for (i = 0; i < fx.length; i++) {
      var F = fx[i], q = F.t / F.life, fxx = F.x * CELL, fyy = F.y * CELL, n2, r2;
      c.globalAlpha = Math.max(0, 1 - q);
      if (F.kind === 1) {                                // cannon blast: a ring of * growing out
        setFont(c, S.fG); c.fillStyle = k.boom; r2 = F.a * CELL * (0.3 + 0.7 * q);
        for (j = 0; j < 8; j++) c.fillText(j & 1 ? '·' : '*', fxx + Math.cos(j * 0.785) * r2, fyy + Math.sin(j * 0.785) * r2);
        if (q < 0.4) c.fillText('#', fxx, fyy);
      } else if (F.kind === 2) {                         // lightning: ASCII strokes with a jitter
        setFont(c, S.fSmB); c.fillStyle = k.zap;
        var lx = F.x2 * CELL - fxx, ly = F.y2 * CELL - fyy, L = Math.sqrt(lx * lx + ly * ly), ch2 = lineChar(lx, ly);
        n2 = Math.max(2, Math.floor(L / 5));
        for (j = 1; j < n2; j++) {
          var jit = ((j * 7 + Math.floor(F.t * 40)) % 5 - 2) * 0.9;
          c.fillText(j % 3 === 1 ? '~' : ch2, fxx + lx * j / n2 - ly / (L || 1) * jit, fyy + ly * j / n2 + lx / (L || 1) * jit);
        }
      } else if (F.kind === 3) {                         // sniper tracer
        setFont(c, S.fTiny); c.fillStyle = k.tracer;
        var tx2 = F.x2 * CELL - fxx, ty2 = F.y2 * CELL - fyy, L2 = Math.sqrt(tx2 * tx2 + ty2 * ty2);
        n2 = Math.max(2, Math.floor(L2 / 7));
        for (j = 1; j <= n2; j++) c.fillText('·', fxx + tx2 * j / n2, fyy + ty2 * j / n2);
        setFont(c, S.fG); c.fillText('×', F.x2 * CELL, F.y2 * CELL);
      } else if (F.kind === 4) {                         // frost pulse
        setFont(c, S.fSm); c.fillStyle = k.frost; r2 = F.a * CELL * (0.25 + 0.75 * q);
        n2 = Math.max(10, Math.floor(r2 * 6.28 / 12));
        for (j = 0; j < n2; j++) c.fillText('*', fxx + Math.cos(j / n2 * 6.283) * r2, fyy + Math.sin(j / n2 * 6.283) * r2);
      } else if (F.kind === 5) {                         // +gold / -lives popups
        setFont(c, S.fSmB); c.fillStyle = F.a ? k.bad : k.gold;
        c.fillText(F.txt, fxx, fyy - 6 - q * 12);
      } else if (F.kind === 6) {                         // death puff
        setFont(c, S.fSm); c.fillStyle = k.muted; r2 = 3 + q * 9 * (F.a || 0.5) * 2;
        c.fillText(':', fxx - r2, fyy); c.fillText(':', fxx + r2, fyy); c.fillText('·', fxx, fyy - r2); c.fillText('·', fxx, fyy + r2);
      }
    }
    c.globalAlpha = 1;
  }
  // wave banner, messages and hints along the bottom
  function drawNotes(c, g, k) {
    var now = perfNow(), armed = S.armed;
    if (S.banner && now < S.banner.until) {
      var ba = Math.min(1, (S.banner.until - now) / 0.4);
      c.globalAlpha = ba;
      label(c, S.banner.txt, VW / 2, VH * 0.36, S.fBan, S.banner.boss ? k.bad : k.text, true);
      if (S.banner.sub) label(c, S.banner.sub, VW / 2, VH * 0.36 + 22, S.fSmB, k.gold, false);
      c.globalAlpha = 1;
    }
    if (S.msg && now < S.msg.until) label(c, S.msg.txt, VW / 2, VH - 16, S.fSmB, S.msg.bad ? k.bad : k.text, false);
    else if (!S.selT && !S.sel && armed < 0 && g.phase === 'build' && !g.towers.length) {
      label(c, S.hints[TOWERS.length], VW / 2, VH - 16, S.fSmB, k.muted, false);
    } else if (armed >= 0 && !S.sel) {
      label(c, S.hints[armed], VW / 2, VH - 16, S.fSmB, k.muted, false);
    }
  }
  // Text centred on x in a bg box (optionally framed + |  | like the editor's ASCII boxes).
  function textW(c, s, font) {                           // measured once per (font, text)
    var m = S.wcache[font] || (S.wcache[font] = {});
    return m[s] != null ? m[s] : (m[s] = c.measureText(s).width);
  }
  function label(c, s, x, y, font, color, frame) {
    setFont(c, font);
    var w = textW(c, s, font), h = frame ? 26 : 14;
    c.fillStyle = S.col.shade; c.fillRect(x - w / 2 - 8, y - h / 2, w + 16, h);
    if (frame) { c.strokeStyle = color; c.lineWidth = 1; c.strokeRect(x - w / 2 - 7.5, y - h / 2 + 0.5, w + 15, h - 1); }
    c.fillStyle = color; c.fillText(s, x, y + 0.5);
  }

  // ---- ASCII tooltip: what's selected / what you're about to build ----
  function fmt(n) { return n % 1 ? n.toFixed(n < 1 ? 2 : 1) : String(n); }
  function tipLines() {
    var g = S.g, t = S.selT, L = [], T;
    if (t) {
      T = TOWERS[t.type];
      var st = towerStat(t.type, t.lvl);
      L.push(T.name + '  ' + 'lv ' + (t.lvl + 1) + '/3');
      L.push('dmg ' + st.dmg + ' · ' + fmt(st.rate) + '/s · r ' + fmt(st.range));
      L.push(T.pulse ? 'slows ' + Math.round(st.slow * 100) + '% · kills ' + t.kills : 'aim ' + MODES[t.mode] + ' · kills ' + t.kills);
      if (t.lvl < 2) {
        var nx = towerStat(t.type, t.lvl + 1);
        L.push('next: dmg ' + nx.dmg + ' · r ' + fmt(nx.range) + (T.chain ? ' · ' + (nx.chain + 1) + ' hits' : T.splash ? ' · blast ' + fmt(nx.splash) : ''));
      } else L.push('fully upgraded');
      return L;
    }
    if (S.armed >= 0 && S.sel && canBuild(g, S.sel.c, S.sel.r)) {
      T = TOWERS[S.armed];
      var s0 = towerStat(S.armed, 0), cost = T.cost[0];
      L.push(T.name + '  $' + cost);
      L.push(T.role);
      L.push('dmg ' + s0.dmg + ' · ' + fmt(s0.rate) + '/s · r ' + fmt(s0.range));
      L.push(g.gold >= cost ? (S.coarse ? 'tap again to build' : 'click / enter to build') : 'need $' + (cost - g.gold) + ' more');
      return L;
    }
    if (S.sel && canBuild(g, S.sel.c, S.sel.r) && S.armed < 0) {
      L.push('pick a tower below');
      return L;
    }
    return null;
  }
  function drawTip(c) {
    var t = S.selT, sel = S.sel, key;
    if (t) key = 1 + t.id * 1e6 + t.lvl * 1e5 + t.mode * 1e4 + Math.min(9999, t.kills);
    else if (sel) key = -(1 + sel.c + sel.r * COLS + (S.armed + 1) * 1000 + (S.armed >= 0 && S.g.gold >= TOWERS[S.armed].cost[0] ? 10000 : 0));
    else return;
    if (key !== S.tipKey) {                              // rebuilt only when it changes
      S.tipKey = key; S.tip = tipLines(); S.tipW = 0;
      if (S.tip) { for (var m = 0; m < S.tip.length; m++) S.tipW = Math.max(S.tipW, S.tip[m].length); S.tipBar = '+' + new Array(S.tipW + 3).join('-') + '+'; }
    }
    var L = S.tip;
    if (!L || !L.length) return;
    var cc = t || sel, i, w = S.tipW, bar = S.tipBar;
    var adv = S.tipAdv, lh = 12, bw = (w + 4) * adv, bh = (L.length + 2) * lh;
    var cx = (cc.c + 0.5) * CELL, cy = cc.r * CELL;
    var bx = clamp(cx - bw / 2, 2, VW - bw - 2), by = cy - bh - 6;
    if (by < 2) by = cy + CELL + 6;
    if (by + bh > VH - 2) by = VH - bh - 2;
    c.fillStyle = S.col.shade; c.fillRect(bx, by, bw, bh);
    c.textAlign = 'left';
    setFont(c, S.fSm); c.fillStyle = S.col.tipBorder;
    c.fillText(bar, bx, by + lh / 2);
    c.fillText(bar, bx, by + bh - lh / 2);
    for (i = 0; i < L.length; i++) {
      var y = by + lh * (i + 1.5);
      c.fillStyle = S.col.tipBorder; c.fillText('|', bx, y); c.fillText('|', bx + (w + 3) * adv, y);
      setFont(c, i === 0 ? S.fSmB : S.fSm);
      c.fillStyle = i === 0 ? (S.selT ? S.col.tc[S.selT.type] : S.armed >= 0 ? S.col.tc[S.armed] : S.col.text) : i === L.length - 1 && L.length > 1 ? S.col.muted : S.col.text;
      c.fillText(L[i], bx + 2 * adv, y);
      setFont(c, S.fSm);
    }
    c.textAlign = 'center';
  }

  // ---- loop: only while a wave is live, unpaused and visible ----
  function running() {
    return !!(S && S.g && S.g.phase === 'wave' && !S.paused && !S.ovlKind && !document.hidden &&
      !(Cade.isMinimized && Cade.isMinimized(S.panel)));
  }
  function kick() { if (S && !S.raf && running()) { S.last = 0; S.raf = requestAnimationFrame(frame); } }
  function redraw() { if (S && !S.raf) draw(1); }
  function frame(ts) {
    if (!S) return;
    S.raf = 0;
    if (!S.panel.isConnected) { teardown(); return; }
    var dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0;
    S.last = ts;
    var alpha = advance(S.g, dt, S.speed);
    handleEvents();
    syncHud();
    draw(alpha);
    if (!S) return;
    if (S.g.phase === 'won' || S.g.phase === 'lost') { endGame(); return; }
    if (running()) S.raf = requestAnimationFrame(frame);
  }

  function handleEvents() {
    var g = S.g, ev = g.events, snd = S.snd, k = S.played, i;
    for (i = 0; i < 12; i++) k[i] = 0;
    for (i = 0; i < ev.length; i++) {
      switch (ev[i]) {
        case 'build': S.baseDirty = true; if (!k[0]++) { snd.tone(520, 0.08, 'triangle', 0.05, 780); Cade.haptic(10); } break;
        case 'upgrade': S.baseDirty = true; if (!k[0]++) { snd.tone(660, 0.07, 'triangle', 0.05); snd.tone(990, 0.1, 'triangle', 0.04, 0, 0.06); Cade.haptic(12); } break;
        case 'sell': S.baseDirty = true; if (!k[0]++) snd.tone(700, 0.12, 'sine', 0.04, 350); break;
        case 'shot': if (!k[1]++) snd.tone(1400, 0.025, 'square', 0.008); break;
        case 'boom': if (!k[2]++) snd.tone(130, 0.14, 'square', 0.03, 55); break;
        case 'zap': if (!k[3]++) snd.tone(900, 0.06, 'sawtooth', 0.015, 1700); break;
        case 'snipe': if (!k[4]++) snd.tone(1800, 0.05, 'square', 0.015, 600); break;
        case 'frost': if (!k[5]++) snd.tone(2100, 0.09, 'sine', 0.012, 1500); break;
        case 'kill': if (!k[6]++) snd.tone(880, 0.05, 'sine', 0.025, 1200); break;
        case 'bosskill': snd.tone(220, 0.3, 'square', 0.04, 880); Cade.haptic(30); break;
        case 'leak': if (!k[7]++) { snd.tone(160, 0.2, 'sawtooth', 0.035, 90); Cade.haptic(25); } break;
        case 'clear': if (!k[8]++) snd.tone(1046, 0.1, 'triangle', 0.03); break;
        case 'wave': case 'boss': onWaveStart(ev[i] === 'boss'); break;
        case 'win': snd.tone(523, 0.12, 'triangle', 0.05); snd.tone(659, 0.12, 'triangle', 0.05, 0, 0.12); snd.tone(784, 0.25, 'triangle', 0.05, 0, 0.24); break;
        case 'lose': snd.tone(330, 0.3, 'sawtooth', 0.04, 110); Cade.haptic(60); break;
      }
    }
    ev.length = 0;
  }
  function onWaveStart(boss) {
    var g = S.g, m = S.prog.maps[MAPS[g.map].id];
    S.banner = { txt: 'WAVE ' + g.wave + (boss ? '  ·  BOSS @' : ''), sub: g.bonusLast > 0 ? '+$' + g.bonusLast + ' early bonus' : '', until: perfNow() + 1.8, boss: boss };
    g.bonusLast = 0;
    S.snd.tone(boss ? 147 : 392, boss ? 0.5 : 0.12, boss ? 'sawtooth' : 'triangle', 0.04, boss ? 110 : 0);
    if (!boss) S.snd.tone(523, 0.14, 'triangle', 0.04, 0, 0.1);
    if (g.wave > m.best) { m.best = g.wave; saveProg(); }
    S.live.textContent = 'Wave ' + g.wave + (boss ? ', boss wave' : '') + ' started.';
    saveGame();
  }

  // ---- HUD (HTML rows): touched only when a value changes ----
  function setDis(el, d) { d = !!d; if (el.disabled !== d) el.disabled = d; }
  // Called every frame while playing: compares numbers and writes the DOM only on a change.
  function syncHud() {
    if (!S || !S.g) return;
    var g = S.g, h = S.hud;
    if (h.lv !== g.lives) { h.lv = g.lives; h.lives.textContent = '♥ ' + g.lives; h.livesBox.classList.toggle('low', g.lives <= 5); }
    if (h.gd !== g.gold) { h.gd = g.gold; h.gold.textContent = '$ ' + g.gold; }
    var wk = g.wave * 2 + (g.endless ? 1 : 0);
    if (h.wv !== wk) { h.wv = wk; h.wave.textContent = g.endless ? 'wave ' + g.wave + ' · free play' : 'wave ' + g.wave + '/' + WAVES; }
    // Next-wave button: label + early bonus + countdown
    var can = canCallWave(g) && !S.paused && !S.ovlKind, st, a = 0, b = 0;
    if (g.phase === 'build') st = 1;
    else if (g.phase !== 'wave') st = g.phase === 'won' ? 2 : 3;
    else if (!moreWaves(g)) { st = 4; a = g.enemies.length + g.spawners.length * 1000; }
    else if (g.spawners.length >= MAX_SPAWNERS) { st = 5; a = g.wave; }
    else { st = 6; a = g.wave * 10000 + earlyBonus(g); b = Math.ceil(timeToNext(g)); }
    var boss = (st === 5 || st === 6) && waveHasBossCached(g.wave + 1);
    var nk = ((st * 1e7 + a) * 1000 + b) * 4 + (can ? 2 : 0) + (boss ? 1 : 0);
    if (h.nk !== nk) {
      h.nk = nk;
      var l1 = '', l2 = '';
      if (st === 1) { l1 = '▶ Wave 1'; l2 = 'start'; }
      else if (st === 2 || st === 3) { l1 = st === 2 ? 'Victory' : 'Defeat'; }
      else if (st === 4) { l1 = 'Final wave'; l2 = g.spawners.length ? 'incoming' : g.enemies.length + ' left'; }
      else if (st === 5) { l1 = '▶▶ Wave ' + (g.wave + 1); l2 = 'wait…'; }
      else { l1 = '▶▶ Wave ' + (g.wave + 1); l2 = '+$' + (a % 10000) + ' · ' + b + 's'; }
      h.next1.textContent = l1; h.next2.textContent = l2;
      setDis(h.next, !can);
      h.next.classList.toggle('boss', boss);
    }
    if (h.sp !== S.speed) { h.sp = S.speed; h.speed.textContent = S.speed + '×'; }
    var pk = S.paused || (S.ovlKind === 'menu') ? 1 : 0;
    if (h.pauseK !== pk) { h.pauseK = pk; h.pause.innerHTML = pk ? IC_PLAY : IC_PAUSE; h.pause.title = pk ? 'Resume (P)' : 'Pause / menu (P)'; h.pause.setAttribute('aria-label', h.pause.title); }
    syncCtx();
  }
  var bossCache = {};
  function waveHasBossCached(n) { if (!(n in bossCache)) bossCache[n] = waveHasBoss(n); return bossCache[n]; }

  // Row B: the build palette, or the selected tower's actions.
  function syncCtx() {
    var g = S.g, t = S.selT, mode = t ? 'tower' : 'build', h = S.hud, i;
    if (S.ctxMode !== mode) {
      S.ctxMode = mode;
      h.ctx.innerHTML = mode === 'build' ? paletteHtml() : towerMenuHtml();
      h.ctx.className = 'td-ctx td-ctx-' + mode;
      h.ctxKey = '';
    }
    if (mode === 'build') {
      var key = g.gold * 100 + (S.armed + 1) * 10 + (S.sel ? 1 : 0);
      if (h.ctxKey === key) return;
      h.ctxKey = key;
      var bs = h.ctx.querySelectorAll('[data-t]');
      for (i = 0; i < bs.length; i++) {
        var ti2 = +bs[i].getAttribute('data-t'), on = S.armed === ti2;
        bs[i].classList.toggle('armed', on);
        bs[i].classList.toggle('poor', g.gold < TOWERS[ti2].cost[0]);
        bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    } else {
      var up = upgradeCost(t), sv = sellValue(t), arm = S.sellArm && perfNow() < S.sellArm;
      var key2 = -(t.id * 1000 + t.lvl * 100 + t.mode * 10 + (g.gold >= up ? 4 : 0) + (arm ? 2 : 0) + 1);
      if (h.ctxKey === key2) return;
      h.ctxKey = key2;
      var ub = h.ctx.querySelector('[data-act="up"]'), mb = h.ctx.querySelector('[data-act="mode"]'), sb = h.ctx.querySelector('[data-act="sell"]');
      ub.querySelector('b').textContent = t.lvl < 2 ? '▲ Upgrade' : '★ Max';
      ub.querySelector('span').textContent = t.lvl < 2 ? '$' + up : 'level 3';
      setDis(ub, t.lvl >= 2);
      ub.classList.toggle('poor', t.lvl < 2 && g.gold < up);
      var pulse = TOWERS[t.type].pulse;
      mb.querySelector('b').textContent = pulse ? '* Area' : '⌖ Aim';
      mb.querySelector('span').textContent = pulse ? 'all in range' : MODES[t.mode];
      setDis(mb, pulse);
      sb.querySelector('b').textContent = arm ? 'Sure?' : '$ Sell';
      sb.querySelector('span').textContent = '+$' + sv;
      sb.classList.toggle('arm', !!arm);
    }
  }
  function paletteHtml() {
    var s = '';
    for (var i = 0; i < TOWERS.length; i++) {
      var T = TOWERS[i];
      s += '<button type="button" class="td-tw" data-t="' + i + '" title="' + esc(T.name + ' — ' + T.role + ' ($' + T.cost[0] + ') · key ' + (i + 1)) + '" aria-pressed="false">' +
        '<b class="td-c' + i + '">[' + T.glyph + ']</b><span>$' + T.cost[0] + '</span></button>';
    }
    return s;
  }
  function towerMenuHtml() {
    return '<button type="button" class="td-act" data-act="up" title="Upgrade (U)"><b></b><span></span></button>' +
      '<button type="button" class="td-act" data-act="mode" title="Change target (T)"><b></b><span></span></button>' +
      '<button type="button" class="td-act td-sell" data-act="sell" title="Sell for 70% (S)"><b></b><span></span></button>' +
      '<button type="button" class="td-act td-x" data-act="desel" title="Close (Esc)" aria-label="Deselect"><b>✕</b></button>';
  }

  // ---- actions ----
  function flash(txt, bad) { S.msg = { txt: txt, bad: !!bad, until: perfNow() + 1.6 }; redraw(); later(1700); }
  function later(ms) {                                  // one deferred redraw (for banners / messages while idle)
    clearTimeout(S.laterT);
    S.laterT = setTimeout(function () { if (S) { S.laterT = 0; redraw(); } }, ms);
  }
  function deselect() { S.sel = null; S.selT = null; S.armed = -1; S.sellArm = 0; syncHud(); redraw(); }
  function selectCell(c, r) { S.sel = { c: c, r: r }; S.selT = null; S.sellArm = 0; syncHud(); redraw(); }
  function selectTower(t) { S.selT = t; S.sel = null; S.armed = -1; S.sellArm = 0; syncHud(); redraw(); }
  function act() { if (S) S.snd.ensure(); }
  function tryBuild(keepArmed) {
    var g = S.g, sel = S.sel, type = S.armed;
    if (!sel || type < 0) return false;
    if (!canBuild(g, sel.c, sel.r)) { flash('can\'t build there', true); return false; }
    var cost = TOWERS[type].cost[0];
    if (g.gold < cost) { flash('need $' + (cost - g.gold) + ' more', true); return false; }
    var t = build(g, sel.c, sel.r, type);
    if (!t) return false;
    handleEvents();
    S.sel = null; S.selT = null; S.armed = keepArmed ? type : -1;
    syncHud(); redraw();
    return true;
  }
  function armTower(i) {
    if (!S.g || S.ovlKind) return;
    if (S.selT) { S.selT = null; }
    if (S.armed === i && S.sel) { tryBuild(false); return; }
    S.armed = S.armed === i && !S.sel ? -1 : i;
    syncHud(); redraw();
  }
  function tapCell(c, r, mouse, shift) {
    var g = S.g;
    if (!g || !inGrid(c, r)) return;
    var t = towerAt(g, c, r);
    if (t) { if (S.selT === t) deselect(); else selectTower(t); return; }
    if (canBuild(g, c, r)) {
      var same = S.sel && S.sel.c === c && S.sel.r === r;
      if (S.armed >= 0 && (same || mouse)) { S.sel = { c: c, r: r }; tryBuild(mouse && shift); return; }
      if (same && S.armed < 0) { deselect(); return; }
      selectCell(c, r);
      return;
    }
    S.sel = null; S.selT = null; S.sellArm = 0;
    if (cellAt(g, c, r) === CELL_PATH) flash('that\'s the road — build on grass', true);
    syncHud(); redraw();
  }
  function doUpgrade() {
    var t = S.selT;
    if (!t) return;
    if (t.lvl >= 2) { flash('fully upgraded'); return; }
    if (!upgrade(S.g, t)) { flash('need $' + (upgradeCost(t) - S.g.gold) + ' more', true); return; }
    handleEvents(); S.tipKey = ''; syncHud(); redraw();
  }
  function doSell() {
    var t = S.selT;
    if (!t) return;
    var now = perfNow();
    if (!S.sellArm || now > S.sellArm) {            // first press arms, second sells
      S.sellArm = now + 2.5; syncHud();
      clearTimeout(S.sellT);
      S.sellT = setTimeout(function () { if (S) { S.sellArm = 0; S.hud.ctxKey = ''; syncHud(); } }, 2600);
      return;
    }
    var v = sell(S.g, t);
    handleEvents();
    S.selT = null; S.sellArm = 0;
    flash('sold for $' + v);
    syncHud(); redraw();
  }
  function doMode() {
    var t = S.selT;
    if (!t || TOWERS[t.type].pulse) return;
    cycleMode(t); S.tipKey = ''; syncHud(); redraw();
  }
  function doNext() {
    var g = S.g;
    if (!g || S.ovlKind) return;
    var now = perfNow();
    if (now - (S.nextAt || 0) < 0.45) return;       // a double tap must not call two waves
    S.nextAt = now;
    if (S.paused) { resume(); return; }
    var b = nextWave(g);
    if (b < 0) return;
    handleEvents(); syncHud();
    kick(); redraw();
  }
  function cycleSpeed() { S.speed = S.speed >= 3 ? 1 : S.speed + 1; syncHud(); }

  // ---- pause / overlays ----
  function pause() {
    if (!S || !S.g || S.paused || S.g.phase !== 'wave' || S.ovlKind) return;
    S.paused = true;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    saveGame();
    showOverlay('pause');
  }
  function resume() {
    if (!S || !S.paused) return;
    S.paused = false;
    showOverlay(null);
    kick();
  }
  function togglePause() {
    if (!S || !S.g) return;
    if (S.paused) { resume(); return; }
    if (S.g.phase === 'wave') { pause(); return; }
    if (S.ovlKind === 'menu') { showOverlay(null); return; }
    if (!S.ovlKind) showOverlay('menu');              // between games / before wave 1: same menu, nothing to pause
  }
  function endGame() {
    var g = S.g, m = S.prog.maps[MAPS[g.map].id];
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    if (g.phase === 'won') {
      var st = starsFor(g.lives, g.maxLives);
      S.lastStars = st; S.newStars = st > m.stars;
      m.stars = Math.max(m.stars, st); m.best = Math.max(m.best, g.wave);
      saveProg(); saveGame();
      S.live.textContent = 'Victory! ' + st + ' star' + (st > 1 ? 's' : '') + '.';
      showOverlay('won');
    } else {
      m.best = Math.max(m.best, g.wave);
      saveProg(); sdel(SAVE_KEY);
      S.live.textContent = 'Defeat at wave ' + g.wave + '.';
      showOverlay('lost');
    }
  }

  function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '☆'; return s; }
  function miniMap(mi) {
    var md = mapData(mi), out = '', i, j;
    for (j = 0; j < ROWS; j++) {
      for (i = 0; i < COLS; i++) {
        var t = md.grid[j * COLS + i];
        out += t === CELL_PATH ? '<b>#</b>' : t === CELL_ROCK ? '<i>^</i>' : t === CELL_WATER ? '<u>~</u>' : '.';
      }
      if (j < ROWS - 1) out += '\n';
    }
    return out;
  }
  function overlayHtml(kind) {
    var g = S.g, i, s = '';
    if (kind === 'title') {
      var sv = loadSave();
      s += '<div class="td-card td-card-title"><div class="td-title">TOWER DEFENSE</div>';
      if (sv) {
        var sm = MAPS[sv.g.map];
        s += '<button type="button" class="td-go" data-act="continue">▶ Continue ' + esc(sm.name) + ' · wave ' + sv.g.wave + ' · ♥ ' + sv.g.lives + '</button>';
      }
      s += '<div class="td-maps">';
      for (i = 0; i < MAPS.length; i++) {
        var M = MAPS[i], pm = S.prog.maps[M.id], open = unlocked(i);
        s += '<button type="button" class="td-map' + (open ? '' : ' locked') + '" data-act="map" data-i="' + i + '"' + (open ? '' : ' aria-disabled="true"') + '>' +
          '<pre class="td-mini" aria-hidden="true">' + miniMap(i) + '</pre>' +
          '<span class="td-mname">' + esc(M.name) + '</span>' +
          '<span class="td-mdiff">' + M.diff + (M.paths.length > 1 ? ' · 2 gates' : '') + '</span>' +
          (open ? '<span class="td-stars">' + starStr(pm.stars) + '</span><span class="td-mbest">' + (pm.best ? 'best wave ' + pm.best : 'not played') + '</span>'
            : '<span class="td-lock">locked</span><span class="td-mbest">win ' + esc(MAPS[i - 1].name) + '</span>') +
          '</button>';
      }
      s += '</div><div class="td-row"><button type="button" class="td-btn" data-act="help">how to play</button>' +
        '<button type="button" class="td-btn" data-act="sound">sound: ' + (S.snd.on ? 'on' : 'off') + '</button></div></div>';
      return s;
    }
    if (kind === 'help') {
      return '<div class="td-card td-card-help"><div class="td-title">HOW TO PLAY</div><div class="td-help">' +
        '<p>Enemies march down the <b>·</b> road from the gate <b class="td-acc">↓</b> to your base <b class="td-bad">⌂</b>. Each one that gets in costs <b>♥</b> (a boss costs 5). Survive ' + WAVES + ' waves to win; stars for lives left.</p>' +
        '<p><b>Build:</b> ' + (S.coarse ? 'tap' : 'click') + ' a grass tile, pick a tower below, then ' + (S.coarse ? 'tap it again' : 'click again') + ' to build. ' +
        '<b>Tap a tower</b> to upgrade it (twice), change what it aims at, or sell it for 70%.</p>' +
        '<table class="td-legend">' +
        '<tr><td class="td-c0">[↑]</td><td>Arrow — cheap and fast; hits flyers</td></tr>' +
        '<tr><td class="td-c1">[◎]</td><td>Cannon — splash damage; ground only</td></tr>' +
        '<tr><td class="td-c2">[*]</td><td>Frost — slows everything around it</td></tr>' +
        '<tr><td class="td-c3">[≈]</td><td>Tesla — lightning that jumps between enemies</td></tr>' +
        '<tr><td class="td-c4">[+]</td><td>Sniper — huge range; ignores armour</td></tr>' +
        '</table>' +
        '<p><b>o</b> grunt · <b>&gt;</b> runner · <b>O</b> tank (armoured) · <b class="td-pink">&amp;</b> flyer — flies straight over everything along the faint dotted lane · <b class="td-bad">@</b> boss every 10th wave.</p>' +
        '<p><b>▶▶ Wave</b> calls the next wave early for bonus gold; clearing a wave pays too. <b>1× 2× 3×</b> sets the speed. The game pauses when you leave and is saved — continue it later.</p>' +
        (S.coarse ? '' : '<p class="td-keys">Keys: 1–5 tower · Enter build · arrows move · U upgrade · S sell · T aim · Space next wave · F speed · P pause · Esc back</p>') +
        '</div><button type="button" class="td-go" data-act="back">back</button></div>';
    }
    if (kind === 'pause' || kind === 'menu') {
      var M2 = MAPS[g.map];
      return '<div class="td-card"><div class="td-title">' + (kind === 'pause' ? 'PAUSED' : 'MENU') + '</div>' +
        '<div class="td-sub">' + esc(M2.name) + ' · wave ' + g.wave + (g.endless ? ' (free play)' : '/' + WAVES) + ' · ♥ ' + g.lives + '</div>' +
        '<button type="button" class="td-go" data-act="resume">' + (kind === 'pause' ? '▶ resume' : 'back to the map') + '</button>' +
        '<div class="td-row"><button type="button" class="td-btn" data-act="restart">restart</button>' +
        '<button type="button" class="td-btn" data-act="maps">maps</button></div>' +
        '<div class="td-row"><button type="button" class="td-btn" data-act="help">how to play</button>' +
        '<button type="button" class="td-btn" data-act="sound">sound: ' + (S.snd.on ? 'on' : 'off') + '</button></div>' +
        '<div class="td-note">saved automatically</div></div>';
    }
    if (kind === 'won') {
      var hasNext = g.map + 1 < MAPS.length;
      return '<div class="td-card"><div class="td-title">VICTORY</div>' +
        '<div class="td-bigstars">' + starStr(S.lastStars || 1) + '</div>' +
        '<div class="td-sub">' + esc(MAPS[g.map].name) + ' held · ♥ ' + g.lives + '/' + g.maxLives + ' left</div>' +
        (S.newStars ? '<div class="td-new">** new best **</div>' : '') +
        (hasNext && S.lastStars ? '<div class="td-note">' + esc(MAPS[g.map + 1].name) + ' unlocked</div>' : '') +
        '<button type="button" class="td-go" data-act="endless">keep going — free play</button>' +
        '<div class="td-row">' + (hasNext ? '<button type="button" class="td-btn" data-act="nextmap">next map →</button>' : '') +
        '<button type="button" class="td-btn" data-act="maps">maps</button></div></div>';
    }
    if (kind === 'lost') {
      var bm = S.prog.maps[MAPS[g.map].id];
      return '<div class="td-card"><div class="td-title">' + (g.endless ? 'FREE PLAY OVER' : 'DEFEAT') + '</div>' +
        '<div class="td-sub">' + esc(MAPS[g.map].name) + ' fell at wave ' + g.wave + '</div>' +
        '<div class="td-sub">best: wave ' + bm.best + ' · ' + starStr(bm.stars) + '</div>' +
        '<button type="button" class="td-go" data-act="retry">try again</button>' +
        '<div class="td-row"><button type="button" class="td-btn" data-act="maps">maps</button>' +
        '<button type="button" class="td-btn" data-act="help">how to play</button></div></div>';
    }
    return '';
  }
  function showOverlay(kind) {
    if (!S) return;
    S.ovlKind = kind;
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.root.classList.toggle('td-blocked', !!kind);
    S.root.classList.toggle('td-nogame', !S.g || kind === 'title');
    if (kind) {
      S.sel = null; S.selT = null; S.armed = -1;
      var f = S.ovl.querySelector('.td-go');
      if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
    syncHud();
    redraw();
  }

  function startMap(i) {
    if (!unlocked(i)) { Cade.showToast && Cade.showToast('Win ' + MAPS[i - 1].name + ' to unlock ' + MAPS[i].name, 'info', 1800); return; }
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.g = newGame(i); S.viewMap = i; S.paused = false;
    S.sel = null; S.selT = null; S.armed = -1;
    S.baseDirty = true; S.banner = null; S.msg = null; S.ctxMode = '';
    sdel(SAVE_KEY);
    showOverlay(null);
  }
  function continueSave() {
    var sv = loadSave(), g = sv ? restore(sv.g) : null;
    if (!g) { sdel(SAVE_KEY); showOverlay('title'); return; }
    S.g = g; S.viewMap = g.map; S.speed = clamp(sv.speed | 0, 1, 3);
    S.baseDirty = true; S.ctxMode = ''; S.banner = null;
    if (g.phase === 'won') { S.lastStars = starsFor(g.lives, g.maxLives); S.newStars = false; showOverlay('won'); return; }
    if (g.phase === 'wave') { S.paused = true; showOverlay('pause'); return; }   // mid-wave: wait for the player
    S.paused = false;
    showOverlay(null);
  }
  function onOverlayClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S) return;
    act();
    var a = b.getAttribute('data-act');
    if (a === 'map') startMap(+b.getAttribute('data-i'));
    else if (a === 'continue') continueSave();
    else if (a === 'help') { S.helpFrom = S.ovlKind; showOverlay('help'); }
    else if (a === 'back') showOverlay(S.helpFrom || 'title');
    else if (a === 'sound') {
      S.snd.on = !S.snd.on; S.prog.sound = S.snd.on; saveProg();
      S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
      b.textContent = 'sound: ' + (S.snd.on ? 'on' : 'off');
    } else if (a === 'resume') { if (S.paused) resume(); else showOverlay(null); }
    else if (a === 'restart') {
      if (b.getAttribute('data-sure')) startMap(S.g.map);
      else { b.setAttribute('data-sure', '1'); b.textContent = 'tap again to restart'; b.classList.add('arm'); }
    } else if (a === 'maps') { saveGame(); S.paused = false; S.g = null; showOverlay('title'); }
    else if (a === 'endless') { goEndless(S.g); saveGame(); showOverlay(null); kick(); }
    else if (a === 'nextmap') startMap(Math.min(MAPS.length - 1, S.g.map + 1));
    else if (a === 'retry') startMap(S.g.map);
  }

  // ---- input: canvas taps / clicks, hover preview, keys ----
  function cellOf(e) {
    var r = S.cv.getBoundingClientRect();
    if (!r.width) return null;
    return { c: Math.floor((e.clientX - r.left) / r.width * COLS), r: Math.floor((e.clientY - r.top) / r.height * ROWS) };
  }
  function onDown(e) {
    if (!S || !S.g || S.ovlKind || (e.button != null && e.button > 0)) return;
    e.preventDefault();
    act();
    var p = cellOf(e);
    if (p) tapCell(p.c, p.r, e.pointerType === 'mouse', e.shiftKey);
  }
  function onMove(e) {
    if (!S || !S.g || e.pointerType !== 'mouse') return;
    var p = cellOf(e);
    var h = S.hover;
    if (p && (!h || h.c !== p.c || h.r !== p.r)) { S.hover = p; if (S.armed >= 0 && !S.sel) redraw(); }
  }
  function onLeave() { if (S && S.hover) { S.hover = null; if (S.armed >= 0) redraw(); } }
  function onCtxClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S || !S.g || S.ovlKind) return;
    act();
    var tt = b.getAttribute('data-t');
    if (tt != null) armTower(+tt);
    else {
      var a = b.getAttribute('data-act');
      if (a === 'up') doUpgrade(); else if (a === 'mode') doMode(); else if (a === 'sell') doSell(); else if (a === 'desel') deselect();
    }
  }
  function onBarClick(e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !S) return;
    act();
    var a = b.getAttribute('data-act');
    if (a === 'pause') togglePause();
    else if (a === 'speed') cycleSpeed();
    else if (a === 'next') doNext();
    try { if (S.coarse) b.blur(); } catch (er) {}
  }
  function moveSel(dc, dr) {
    var base = S.selT || S.sel || { c: 5, r: 7 };
    var c = clamp(base.c + dc, 0, COLS - 1), r = clamp(base.r + dr, 0, ROWS - 1), t = towerAt(S.g, c, r);
    if (t) selectTower(t); else selectCell(c, r);
  }
  var KEYCODE = { ' ': 'Space', enter: 'Enter', escape: 'Escape', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
  function onKey(e) {
    if (!S || e.ctrlKey || e.metaKey || e.altKey) return;
    if (Cade.isMinimized && Cade.isMinimized(S.panel)) return;   // parked in the dock: keys belong to the editor
    var tg = e.target;
    if (tg && tg !== document.body && !S.panel.contains(tg) && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    var key = (e.key || '').toLowerCase(), code = e.code || KEYCODE[key] || '';
    if (code === 'Escape') {
      e.preventDefault();
      if (S.ovlKind === 'help') { showOverlay(S.helpFrom || 'title'); return; }
      if (S.ovlKind === 'pause') { resume(); return; }
      if (S.ovlKind === 'menu') { showOverlay(null); return; }
      if (S.g && !S.ovlKind && (S.sel || S.selT || S.armed >= 0)) { deselect(); return; }
      if (running()) { pause(); return; }
      closePanel();
      return;
    }
    if (code === 'KeyP') { e.preventDefault(); if (!e.repeat) togglePause(); return; }
    if (!S.g || (S.ovlKind && S.ovlKind !== 'pause')) return;
    if (S.ovlKind === 'pause') {                         // Space / Enter resume, unless another card button has focus
      if ((code === 'Space' || code === 'Enter') && !(tg && tg.tagName === 'BUTTON' && S.ovl.contains(tg))) { e.preventDefault(); if (!e.repeat) resume(); }
      return;
    }
    if (e.repeat && !/^Arrow/.test(code)) { if (/^(Space|Enter|Digit|KeyU|KeyS|KeyT|KeyF|KeyN)/.test(code)) e.preventDefault(); return; }
    var dg = /^(Digit|Numpad)([1-5])$/.exec(code);
    if (dg) { e.preventDefault(); act(); armTower(+dg[2] - 1); return; }
    switch (code) {
      case 'Space': case 'KeyN': e.preventDefault(); act(); doNext(); return;
      case 'Enter': case 'NumpadEnter': e.preventDefault(); act(); if (S.armed >= 0 && S.sel) tryBuild(false); return;
      case 'KeyU': e.preventDefault(); doUpgrade(); return;
      case 'KeyS': e.preventDefault(); doSell(); return;
      case 'KeyT': e.preventDefault(); doMode(); return;
      case 'KeyF': e.preventDefault(); cycleSpeed(); return;
      case 'ArrowUp': e.preventDefault(); moveSel(0, -1); return;
      case 'ArrowDown': e.preventDefault(); moveSel(0, 1); return;
      case 'ArrowLeft': e.preventDefault(); moveSel(-1, 0); return;
      case 'ArrowRight': e.preventDefault(); moveSel(1, 0); return;
    }
  }

  // ---- layout: fit the canvas to the visible viewport ----
  // Height the canvas may use: down to the app's footer (or the visible viewport),
  // minus the panel's real top offset and its chrome (title bar, rows, padding).
  function availH(vw, vh) {
    var r = S.panel.getBoundingClientRect();
    if (!r.height) return vh - (vw <= 560 ? 230 : 250);
    var ft = document.querySelector('.footer'), fr = ft && ft.getBoundingClientRect();
    if (fr && fr.height && fr.top > vh * 0.6) vh = Math.min(vh, fr.top);
    // Measured from the parts (the core may have capped the panel's own height).
    var head = S.panel.querySelector('.cade-panel-head'), body = S.panel.querySelector('.cade-panel-body');
    var bs = body ? getComputedStyle(body) : null;
    var chrome = (head ? head.offsetHeight : 36) + (bs ? (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0) : 20) +
      (S.root.offsetHeight - (S.stage.offsetHeight || 0)) + 2;
    return vh - Math.min(Math.max(0, r.top), 140) - chrome - 6;
  }
  function layout() {
    var vw = window.innerWidth || 800, vh = window.innerHeight || 600, vv = window.visualViewport;
    if (vv && vv.height && vv.scale <= 1.01) vh = Math.min(vh, vv.height);
    var body = S.panel.querySelector('.cade-panel-body');
    if (body) body.scrollTop = 0;                          // a focused button may have scrolled it
    var aw = vw <= 560 ? vw - 26 : Math.min(620, vw - 60);
    var s = Math.min(aw / VW, availH(vw, vh) / VH, 1.35);
    s = Math.max(s, 0.5);
    var cw = Math.floor(VW * s), ch = Math.floor(VH * s), dpr = Math.min(2, window.devicePixelRatio || 1);
    S.cv.style.width = cw + 'px'; S.cv.style.height = ch + 'px';
    S.stage.style.width = cw + 'px'; S.stage.style.height = ch + 'px';
    S.root.style.width = cw + 'px';
    var bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (S.cv.width !== bw) S.cv.width = bw;
    if (S.cv.height !== bh) S.cv.height = bh;
    S.k = S.cv.width / VW;
    S.baseDirty = true;
  }

  // ---- open / close ----
  function teardown() {
    if (!S) return;
    saveGame();
    var s = S; S = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.resizeT); clearTimeout(s.laterT); clearTimeout(s.sellT);
    document.removeEventListener('keydown', s.onKey, true);
    document.removeEventListener('visibilitychange', s.onVis);
    window.removeEventListener('blur', s.onBlur);
    window.removeEventListener('resize', s.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.panel.removeEventListener('cade-panel-minimize', s.onMin);
    s.panel.removeEventListener('cade-panel-restore', s.onRestore);
    s.snd.close();
    s.base = null;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
    try { if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) Cade.editor.focus(); } catch (e) {}
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    var body = '<div class="td td-nogame">' +
      '<div class="td-stage"><canvas class="td-cv" aria-label="Tower defense map"></canvas><div class="td-ovl" style="display:none"></div></div>' +
      '<div class="td-ctx" role="toolbar" aria-label="Build"></div>' +
      '<div class="td-bar">' +
      '<div class="td-stats"><div><span class="td-lives"></span><span class="td-gold"></span></div><div class="td-wave"></div></div>' +
      '<button type="button" class="td-ib" data-act="pause"></button>' +
      '<button type="button" class="td-ib td-spd" data-act="speed" title="Game speed (F)" aria-label="Game speed"></button>' +
      '<button type="button" class="td-next" data-act="next" title="Next wave (Space)"><b></b><span></span></button>' +
      '</div><div class="td-live" aria-live="polite"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, TITLE, body);
    if (Cade.markGamePanel) Cade.markGamePanel(p);
    else { try { Cade.editor.contentDOM.blur(); } catch (e) {} }
    var mm = window.matchMedia, prog = loadProg();
    S = {
      panel: p, root: p.querySelector('.td'), stage: p.querySelector('.td-stage'), cv: p.querySelector('.td-cv'), ovl: p.querySelector('.td-ovl'),
      live: p.querySelector('.td-live'), prog: prog, snd: new Snd(prog.sound),
      coarse: !!(mm && mm('(pointer: coarse)').matches),
      g: null, viewMap: 0, speed: 1, paused: false, ovlKind: null, sel: null, selT: null, armed: -1, hover: null,
      ghost: { type: 0, lvl: 0, c: 0, r: 0 }, played: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      raf: 0, last: 0, k: 1, base: null, baseDirty: true, ctxMode: '', tipKey: '', tip: null, curFont: null
    };
    var q = function (sel) { return p.querySelector(sel); };
    S.hud = {
      ctx: q('.td-ctx'), lives: q('.td-lives'), gold: q('.td-gold'), wave: q('.td-wave'), livesBox: q('.td-stats'),
      next: q('.td-next'), next1: q('.td-next b'), next2: q('.td-next span'), speed: q('.td-spd'), pause: q('[data-act="pause"]'),
      pauseK: -1, ctxKey: ''
    };
    S.ctx = S.cv.getContext('2d');
    S.hints = [];
    for (var hi = 0; hi < TOWERS.length; hi++) S.hints.push((S.coarse ? 'tap' : 'click') + ' a grass tile for the ' + TOWERS[hi].name.toLowerCase());
    S.hints.push(S.coarse ? 'tap a grass tile to build' : 'click a grass tile to build');
    S.onMin = function () { if (S && S.panel === p) { pause(); if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } saveGame(); } };
    S.onRestore = function () { if (S && S.panel === p) { layout(); redraw(); kick(); } };
    p._onClose = teardown;
    layout();
    readTheme();

    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey, true);
    S.onVis = function () { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', S.onVis);
    S.onBlur = function () { pause(); };
    window.addEventListener('blur', S.onBlur);
    p.addEventListener('cade-panel-minimize', S.onMin);
    p.addEventListener('cade-panel-restore', S.onRestore);
    S.onResize = function () {
      if (!S) return;
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(function () { if (S) { layout(); redraw(); } }, 120);
    };
    window.addEventListener('resize', S.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', S.onResize);
    try {
      S.themeObs = new MutationObserver(function () { if (S) { readTheme(); S.ctxMode = ''; syncHud(); redraw(); } });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    S.cv.addEventListener('pointerdown', onDown);
    S.cv.addEventListener('pointermove', onMove);
    S.cv.addEventListener('pointerleave', onLeave);
    S.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    S.cv.addEventListener('pointerup', function () { if (S) S.snd.ensure(); });   // iOS unlocks audio on touchend
    S.ovl.addEventListener('click', onOverlayClick);
    S.hud.ctx.addEventListener('click', onCtxClick);
    p.querySelector('.td-bar').addEventListener('click', onBarClick);

    showOverlay('title');
    // The glyph grid is fitted to the mono font's advance: refit once it has loaded.
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('600 12px ' + S.col.font).then(function () { if (S && S.panel === p) { fitFont(); S.baseDirty = true; redraw(); } }, function () {});
      }
    } catch (e) {}
    // The stylesheet loads alongside the module: once it applies, the panel's real
    // chrome is known — fit the canvas again (a bounded wait, at most ~1.5 s).
    whenStyled(p, 0);
  }
  function whenStyled(p, n) {
    if (!S || S.panel !== p) return;
    var ok = getComputedStyle(S.root).display === 'flex';
    if (ok || n > 90) { layout(); layout(); redraw(); return; }
    requestAnimationFrame(function () { whenStyled(p, n + 1); });
  }

  Cade.registerWidget({
    name: 'Tower Defense',
    description: 'ASCII tower defense — build, upgrade and hold 3 maps for 30 waves',
    icon: '🏰',
    tags: 'game,strategy,tower defense,td,towers,waves,defense,ascii,fun,train',
    open: open,
    // Pure engine, exposed for headless checks — not used by the app.
    _engine: ENGINE
  });
})();
