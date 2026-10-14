/* Tower Defense — an ASCII tower defense for Cade.txt.
 * Enemies march down a road of '·' gravel through '"' grass, '^' rocks and '~'
 * water. Ten towers — Arrow [↑], Cannon [◎], Frost [*], Tesla [≈], Sniper [+],
 * Flame [§], Missile [⇑], Beam [≡], Bank [$] and Beacon [♦] — upgrade twice,
 * then specialise into one of two forms, and pick what they aim at (first /
 * last / strong / close). Thirteen kinds of enemy — healers, splitters, stealth
 * ghosts, regenerating trolls, slow-proof golems, bat swarms and three bosses —
 * over eight maps of 30 waves, then endless free play. Stars buy permanent
 * perks in the Armory. Stars, perks and best waves persist; a game in progress
 * is saved when you pause, minimize or close.
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
  var WAVES = 30, WAVE_GAP = 15, GROUP_GAP = 1.6, MAX_SPAWNERS = 2, SELL_RATE = 0.7, MAX_LVL = 3;
  var MAX_PROJ = 200, MAX_FX = 260, MAX_ENEMIES = 400;
  var REVEAL = 1.5;                  // seconds a ghost stays targetable after it's hit
  var FLICK = [2.6, 0.6];            // ...and it flickers into view for 0.6 s of every 2.6 s
  var MODES = ['first', 'last', 'strong', 'close'];
  // Balance knobs (tuned with the headless bot in towerdefense.test.js).
  var BAL = { hpLin: 0.12, hpQuad: 0.012, bountyGrow: 0.015, clearBase: 10, clearPer: 2, earlyRate: 1, earlyGrow: 0.05 };

  // Towers: per-level arrays for levels 1–3 (index 0..2) — cost[0] builds,
  // cost[1..2] upgrade — then level 4 is one of two specialisations, each a full
  // stat set (anything it leaves out carries over from level 3).
  //   pulse: hits everything in range (no aim) · support: never attacks
  //   beam: continuous, ramps up on one target · airFirst: prefers flyers
  var TOWERS = [
    { key: 'arrow', name: 'Arrow', glyph: '↑', role: 'fast single shots', air: true, mode: 0,
      cost: [60, 50, 100], dmg: [7, 13, 22], rate: [2, 2.3, 2.8], range: [2.6, 2.9, 3.2], pspd: 11,
      spec: [
        { key: 'longbow', name: 'Longbow', note: 'long reach, heavy arrows', cost: 180, dmg: 44, rate: 2.6, range: 4.4 },
        { key: 'volley', name: 'Volley', note: '3 arrows at 3 targets', cost: 190, dmg: 26, rate: 3, range: 3.4, multi: 3 }] },
    { key: 'cannon', name: 'Cannon', glyph: '◎', role: 'splash · ground only', air: false, mode: 0,
      cost: [100, 90, 170], dmg: [18, 34, 60], rate: [0.65, 0.75, 0.85], range: [2.5, 2.7, 2.9],
      splash: [0.85, 1.0, 1.15], pspd: 6,
      spec: [
        { key: 'siege', name: 'Siege', note: 'huge blast', cost: 280, dmg: 135, rate: 0.75, range: 3.4, splash: 1.6 },
        { key: 'breaker', name: 'Breaker', note: 'each hit strips 2 armour', cost: 250, dmg: 85, rate: 1.05, range: 3.1, splash: 1.15, shred: 2 }] },
    { key: 'frost', name: 'Frost', glyph: '*', role: 'slows everything near', air: true, pulse: true, mode: 0,
      cost: [80, 70, 130], dmg: [3, 6, 12], rate: [1, 1, 1.1], range: [2.0, 2.3, 2.6],
      slow: [0.3, 0.4, 0.5], slowDur: [1.4, 1.7, 2.0],
      spec: [
        { key: 'glacier', name: 'Glacier', note: 'deep, wide chill', cost: 200, dmg: 16, rate: 1.1, range: 3.2, slow: 0.65, slowDur: 2.6 },
        { key: 'shatter', name: 'Shatter', note: 'chilled foes take +30% damage', cost: 220, dmg: 24, rate: 1.2, range: 2.8, slow: 0.5, slowDur: 2, brittle: 0.3 }] },
    { key: 'tesla', name: 'Tesla', glyph: '≈', role: 'chain lightning', air: true, mode: 0,
      cost: [130, 110, 200], dmg: [15, 26, 44], rate: [0.9, 1, 1.1], range: [2.4, 2.6, 2.9], chain: [2, 3, 4],
      spec: [
        { key: 'storm', name: 'Storm', note: 'jumps 8 times', cost: 300, dmg: 64, rate: 1.2, range: 3.2, chain: 8 },
        { key: 'overload', name: 'Overload', note: 'stuns everything it hits', cost: 300, dmg: 125, rate: 1.1, range: 3, chain: 3, stun: 0.5 }] },
    { key: 'sniper', name: 'Sniper', glyph: '+', role: 'long range · ignores armour', air: true, pierce: true, mode: 2,
      cost: [120, 110, 220], dmg: [50, 100, 190], rate: [0.4, 0.45, 0.5], range: [5, 5.6, 6.2],
      spec: [
        { key: 'deadeye', name: 'Deadeye', note: 'one enormous shot', cost: 320, dmg: 480, rate: 0.45, range: 7.6 },
        { key: 'rapid', name: 'Rapid Fire', note: 'twice the rate of fire', cost: 300, dmg: 210, rate: 1.1, range: 6.2 }] },
    { key: 'flame', name: 'Flame', glyph: '§', role: 'burns all around · stops healing', air: true, pulse: true, mode: 0,
      cost: [110, 90, 160], dmg: [4, 7, 12], rate: [1.4, 1.5, 1.6], range: [1.8, 2.0, 2.2], burn: [7, 13, 22], burnDur: [2.5, 2.5, 3],
      spec: [
        { key: 'inferno', name: 'Inferno', note: 'hotter and wider', cost: 260, dmg: 18, rate: 1.7, range: 2.6, burn: 44 },
        { key: 'scorch', name: 'Scorch', note: 'burning foes lose 4 armour', cost: 240, dmg: 14, range: 2.4, burn: 30, burnDur: 3.5, scorch: 4 }] },
    { key: 'missile', name: 'Missile', glyph: '⇑', role: 'rockets · flyers first, take 1.8×', air: true, airFirst: true, mode: 0,
      cost: [120, 100, 180], dmg: [16, 28, 48], rate: [0.8, 0.9, 1], range: [3.2, 3.5, 3.8], splash: [0.6, 0.7, 0.8],
      airMul: [1.8, 1.8, 2], pspd: 7,
      spec: [
        { key: 'hydra', name: 'Hydra', note: 'two rockets, two targets', cost: 270, dmg: 56, range: 4, multi: 2 },
        { key: 'skyhammer', name: 'Skyhammer', note: 'flyers take 2.6×, wide blast', cost: 280, dmg: 90, rate: 0.9, range: 4.4, splash: 1.1, airMul: 2.6 }] },
    { key: 'beam', name: 'Beam', glyph: '≡', role: 'laser that ramps up · ignores armour', air: true, beam: true, mode: 2,
      cost: [150, 130, 220], dmg: [12, 22, 38], rate: [1, 1, 1], range: [2.6, 2.8, 3.1], ramp: [3, 3.5, 4], rampT: [2.5, 2.5, 2.5],
      spec: [
        { key: 'prism', name: 'Prism', note: 'two beams at once', cost: 320, dmg: 44, range: 3.3, ramp: 4, beams: 2 },
        { key: 'focus', name: 'Focus', note: 'ramps up to 8×', cost: 320, dmg: 52, range: 3.3, ramp: 8, rampT: 4 }] },
    { key: 'bank', name: 'Bank', glyph: '$', role: 'earns gold every wave', support: true, mode: 0,
      cost: [120, 110, 170], income: [14, 30, 52],
      spec: [
        { key: 'vault', name: 'Vault', note: '+$95 every wave', cost: 240, income: 95 },
        { key: 'tax', name: 'Tax Office', note: '+40% gold from kills nearby', cost: 220, income: 60, range: 2.6, tax: 0.4 }] },
    { key: 'beacon', name: 'Beacon', glyph: '♦', role: 'buffs neighbours · reveals ghosts', support: true, mode: 0,
      cost: [90, 80, 140], buff: [0.15, 0.2, 0.25], aura: [1.5, 1.5, 2.1], detect: [2.5, 3, 3.5], range: [2.5, 3, 3.5],
      spec: [
        { key: 'warcry', name: 'Warcry', note: 'neighbours: +40% damage, +15% speed', cost: 240, buff: 0.4, haste: 0.15 },
        { key: 'oracle', name: 'Oracle', note: 'sees ghosts far off · +20% range', cost: 200, reach: 0.2, detect: 6, range: 6 }] }
  ];
  var TKEY = {};
  for (var ti = 0; ti < TOWERS.length; ti++) TKEY[TOWERS[ti].key] = ti;
  var STAT_KEYS = ['dmg', 'rate', 'range', 'splash', 'slow', 'slowDur', 'chain', 'burn', 'burnDur', 'scorch', 'multi', 'shred',
    'brittle', 'stun', 'airMul', 'ramp', 'rampT', 'beams', 'income', 'tax', 'buff', 'haste', 'reach', 'aura', 'detect'];

  // Enemies, keyed by their glyph (which is also how waves are written).
  //   heal: mends neighbours · split: breaks into smaller ones · stealth: only
  //   targetable when revealed (or flickering into view, FLICK) · regen: heals itself (not while burning) ·
  //   steady: can't be slowed or stunned · summon: calls in escorts
  var ENEMIES = {
    'o': { key: 'grunt', name: 'Grunt', glyph: 'o', hp: 24, spd: 1.0, armor: 0, bounty: 4, lives: 1, gap: 0.85 },
    '>': { key: 'runner', name: 'Runner', glyph: '>', hp: 15, spd: 1.8, armor: 0, bounty: 4, lives: 1, gap: 0.55 },
    'O': { key: 'tank', name: 'Tank', glyph: 'O', hp: 90, spd: 0.6, armor: 4, bounty: 10, lives: 2, gap: 1.5 },
    '&': { key: 'flyer', name: 'Flyer', glyph: '&', hp: 16, spd: 1.15, armor: 0, bounty: 5, lives: 1, gap: 0.9, fly: true },
    'h': { key: 'healer', name: 'Healer', glyph: 'h', hp: 42, spd: 0.9, armor: 0, bounty: 8, lives: 1, gap: 1.2, heal: { every: 2.5, pct: 0.12, r: 1.7 } },
    '8': { key: 'splitter', name: 'Splitter', glyph: '8', hp: 60, spd: 0.8, armor: 1, bounty: 6, lives: 1, gap: 1.1, split: { k: 'o', n: 3, hp: 0.4 } },
    '?': { key: 'ghost', name: 'Ghost', glyph: '?', hp: 30, spd: 1.25, armor: 0, bounty: 7, lives: 1, gap: 0.8, stealth: true },
    'w': { key: 'bat', name: 'Bat', glyph: 'w', hp: 9, spd: 1.6, armor: 0, bounty: 2, lives: 1, gap: 0.45, fly: true },
    'T': { key: 'troll', name: 'Troll', glyph: 'T', hp: 150, spd: 0.7, armor: 2, bounty: 14, lives: 2, gap: 1.6, regen: 0.02 },
    'M': { key: 'golem', name: 'Golem', glyph: 'M', hp: 330, spd: 0.45, armor: 12, bounty: 30, lives: 3, gap: 2.2, steady: true },
    '@': { key: 'boss', name: 'Ogre', glyph: '@', hp: 800, spd: 0.45, armor: 6, bounty: 100, lives: 5, gap: 3, boss: true },
    'Ω': { key: 'warlord', name: 'Warlord', glyph: 'Ω', hp: 1200, spd: 0.42, armor: 6, bounty: 180, lives: 5, gap: 3, boss: true, summon: { k: 'o', n: 2, every: 8 } },
    'W': { key: 'wyrm', name: 'Wyrm', glyph: 'W', hp: 1100, spd: 0.36, armor: 5, bounty: 220, lives: 6, gap: 3, boss: true, fly: true }
  };

  // 30 hand-made waves: groups spawn one after another ("o8 >6" = 8 grunts, then 6 runners).
  var WAVE_TABLE = [
    'o8', 'o12', 'o8 >6', '>14', 'o10 O2', '&8', 'o10 h2 >8', 'O5 o8', '>16 &6', 'o10 @1',
    'o12 84 O2', '&12 w10', '?10 O6', '>20 h3 84', 'o16 &8 O3 T2', 'O6 >14 ?8', 'o24 h4 86', '&14 w20', 'O8 T4 >16', 'M2 o12 Ω1',
    '>26 ?12 &10', 'O10 T6 h4', 'w30 &16', 'o20 >20 88 M2', 'O12 ?16 &10', '>36 T6', 'o24 O10 M4 h6', '&18 w24 O10', 'O16 T8 ?20 M4', 'O10 &12 @2 W1'
  ];

  // Maps: 12 x 16 cells. Art: '.' grass (buildable), '#' path, '^' rock, '~' water.
  // The path itself comes from the waypoints (cell coords, entering from off-grid);
  // the art's '#' cells must match them exactly (checked by the tests). `swap`
  // trades enemy kinds from wave `swapFrom` on (a map's own flavour).
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
      ] },
    { id: 'river', name: 'Riverbend', diff: 'hard', gold: 220, lives: 20, hp: 1.25,
      paths: [[[-1, 1], [5, 1], [5, 5], [1, 5], [1, 11], [7, 11], [7, 3], [10, 3], [10, 13], [4, 13], [4, 16]]],
      art: [
        '..^.........',
        '######......',
        '.....#.^^...',
        '.....#.####.',
        '..~..#.#..#.',
        '.#####.#..#.',
        '.#~....#..#.',
        '~#~~..~#.~#~',
        '~#~~~.~#~.#~',
        '.#.....#..#.',
        '.#^....#..#.',
        '.#######..#.',
        '..........#.',
        '....#######^',
        '.~~.#.....^^',
        '.~~.#....^^^'
      ] },
    { id: 'hollow', name: 'Haunted Hollow', diff: 'hard', gold: 220, lives: 20, hp: 1.7, swap: { '>': '?' }, swapFrom: 6,
      paths: [[[10, -1], [10, 2], [2, 2], [2, 5], [9, 5], [9, 8], [2, 8], [2, 11], [9, 11], [9, 14], [1, 14], [1, 16]]],
      art: [
        '^^.......^#.',
        '^.........#.',
        '..#########.',
        '.^#.........',
        '^^#.........',
        '..########..',
        '.........#.^',
        '.........#^^',
        '..########..',
        '^.#.........',
        '^^#.........',
        '..########..',
        '.........#.^',
        '.........#^^',
        '.#########..',
        '^#^.........'
      ] },
    { id: 'cross', name: 'Crossroads', diff: 'expert', gold: 230, lives: 20, hp: 1.6,
      paths: [[[3, -1], [3, 10], [9, 10], [9, 4], [1, 4], [1, 13], [7, 13], [7, 16]]],
      art: [
        '^^.#.....^^^',
        '^..#......^^',
        '...#.~~.....',
        '...#.~~.....',
        '.#########..',
        '.#.#.....#^.',
        '.#.#.....#..',
        '.#.#.....#~~',
        '.#.#.....#~~',
        '^#.#.....#..',
        '.#.#######..',
        '^#..........',
        '^#^.......^.',
        '.#######..^^',
        '^^^^...#.^^^',
        '^^^^^..#^^^^'
      ] },
    { id: 'three', name: 'Three Gates', diff: 'expert', gold: 300, lives: 20, hp: 1.15,
      paths: [
        [[1, -1], [1, 5], [5, 5], [5, 8], [9, 8], [9, 12], [3, 12], [3, 16]],
        [[8, -1], [8, 2], [10, 2], [10, 5], [7, 5], [7, 8], [9, 8], [9, 12], [3, 12], [3, 16]],
        [[-1, 10], [2, 10], [2, 8], [5, 8], [9, 8], [9, 12], [3, 12], [3, 16]]
      ],
      art: [
        '.#^...^.#...',
        '.#......#..^',
        '.#...~..###.',
        '.#..~~....#.',
        '.#........#.',
        '.#####.####.',
        '.....#.#...^',
        '.....#.#..^^',
        '..########..',
        '..#......#.^',
        '###......#..',
        '.~.......#.^',
        '.~~#######..',
        '...#.......^',
        '^^.#.....^^^',
        '^^^#....^^^^'
      ] },
    { id: 'sky', name: 'Sky Fortress', diff: 'expert', gold: 260, lives: 20, hp: 1.3, swap: { 'o': '&', '>': 'w' }, swapFrom: 5,
      paths: [[[0, -1], [0, 3], [5, 3], [5, 8], [9, 8], [9, 12], [11, 12], [11, 16]]],
      art: [
        '#^^^....^^^^',
        '#.^.....^^^^',
        '#.........^^',
        '######...~^^',
        '.....#....^.',
        '^^...#...~..',
        '^^...#......',
        '^....#......',
        '.....#####^.',
        '.^^......#..',
        '^^^......#..',
        '^^.......#..',
        '^........###',
        '^^........^#',
        '^^^.....^^^#',
        '^^^^...^^^^#'
      ] }
  ];

  // The Armory: permanent perks bought with stars (respec is free).
  var PERKS = [
    { id: 'chest', name: 'War Chest', max: 3, cost: 1, desc: '+$50 to start' },
    { id: 'steel', name: 'Sharpened Steel', max: 3, cost: 2, desc: '+6% tower damage' },
    { id: 'optics', name: 'Optics', max: 2, cost: 2, desc: '+6% tower range' },
    { id: 'walls', name: 'Fortify', max: 2, cost: 2, desc: '+5 lives' },
    { id: 'plunder', name: 'Plunder', max: 2, cost: 2, desc: '+10% gold per kill' },
    { id: 'eng', name: 'Engineering', max: 2, cost: 2, desc: '-8% upgrade costs' },
    { id: 'salvage', name: 'Salvage', max: 2, cost: 1, desc: 'sell for +10% more' },
    { id: 'early', name: 'Early Bird', max: 1, cost: 1, desc: '+50% early-wave bonus' },
    { id: 'scouts', name: 'Scouts', max: 1, cost: 3, desc: 'every tower sees ghosts within 1.2' }
  ];
  function cleanPerks(p) {
    var o = {};
    for (var i = 0; i < PERKS.length; i++) {
      var v = p && typeof p === 'object' ? p[PERKS[i].id] | 0 : 0;
      if (v > 0) o[PERKS[i].id] = clamp(v, 0, PERKS[i].max);
    }
    return o;
  }
  function perkCost(p) { var s = 0; for (var i = 0; i < PERKS.length; i++) s += (p[PERKS[i].id] | 0) * PERKS[i].cost; return s; }
  function mods(p) {
    p = cleanPerks(p);
    function r(id) { return p[id] | 0; }
    return {
      gold: 50 * r('chest'), dmg: 1 + 0.06 * r('steel'), range: 1 + 0.06 * r('optics'), lives: 5 * r('walls'),
      bounty: 1 + 0.1 * r('plunder'), upCost: 1 - 0.08 * r('eng'), sell: Math.round((SELL_RATE + 0.1 * r('salvage')) * 100) / 100,
      early: 1 + 0.5 * r('early'), spot: r('scouts') ? 1.2 : 0
    };
  }

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
  function parseWave(s, mi, n) {
    var M = mi != null ? MAPS[mi] : null, sw = M && M.swap && n >= (M.swapFrom || 1) ? M.swap : null, out = [], parts = s.split(' ');
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].charAt(0), n = parseInt(parts[i].slice(1), 10);
      if (sw && sw[k]) k = sw[k];
      out.push({ k: k, n: n, gap: ENEMIES[k].gap });
    }
    return out;
  }
  // Wave n (1-based) on map mi (its enemy swaps; none without a map). Past the
  // last wave (free play) the last ten repeat, larger each lap.
  function waveSpec(n, mi) {
    if (n <= WAVES) return parseWave(WAVE_TABLE[n - 1], mi, n);
    var lap = Math.floor((n - WAVES - 1) / 10) + 1, spec = parseWave(WAVE_TABLE[WAVES - 10 + (n - WAVES - 1) % 10], mi, n);
    for (var i = 0; i < spec.length; i++) {
      spec[i].n = ENEMIES[spec[i].k].boss ? spec[i].n + lap : Math.round(spec[i].n * (1 + 0.25 * lap));
      spec[i].gap *= Math.max(0.6, 1 - 0.1 * lap);
    }
    return spec;
  }
  function waveCount(n, mi) { var s = waveSpec(n, mi), c = 0; for (var i = 0; i < s.length; i++) c += s[i].n; return c; }
  function waveHasBoss(n) { var s = waveSpec(n); for (var i = 0; i < s.length; i++) if (ENEMIES[s[i].k].boss) return true; return false; }
  function hpMul(n, mi) { var m = n - 1; return MAPS[mi].hp * (1 + BAL.hpLin * m + BAL.hpQuad * m * m); }
  function bountyFor(k, n) { return Math.round(ENEMIES[k].bounty * (1 + BAL.bountyGrow * (n - 1))); }
  function clearBonus(n) { return BAL.clearBase + BAL.clearPer * n; }

  // ---- tower stats ----
  // Base stats for a level (0..3; 3 = specialisation `spec`). Every key is present.
  function towerStat(type, lvl, spec) {
    var T = TOWERS[type], src = lvl >= MAX_LVL ? T.spec[spec | 0] : null, o = {}, L = Math.min(lvl, 2);
    for (var i = 0; i < STAT_KEYS.length; i++) {
      var k = STAT_KEYS[i], v = src && src[k] != null ? src[k] : T[k] ? T[k][L] : 0;
      o[k] = v || 0;
    }
    return o;
  }
  // What one more level costs; at level 3 the branch b (0/1) picks the specialisation.
  function upgradeCost(t, b) {
    var T = TOWERS[t.type];
    if (t.lvl >= MAX_LVL) return 0;
    var c = t.lvl < 2 ? T.cost[t.lvl + 1] : T.spec[b | 0].cost;
    return Math.round(c * (t.cm || 1));
  }
  function sellValue(t) { return Math.floor(t.spent * (t.sr || SELL_RATE)); }

  // The live stats every tower works from: base stats, then perks and Beacon
  // buffs. Rebuilt only when towers change (g.dirty), never per shot.
  function recalc(g) {
    g.dirty = false;
    var tw = g.towers, m = g.mod, i, j, t, b;
    g.detectors.length = 0; g.taxers.length = 0;
    for (i = 0; i < tw.length; i++) { t = tw[i]; t.st = towerStat(t.type, t.lvl, t.spec); t.bf = 0; t.bh = 0; t.br = 0; }
    for (i = 0; i < tw.length; i++) {
      b = tw[i];
      if (!b.st.aura) continue;
      var a2 = b.st.aura * b.st.aura;
      for (j = 0; j < tw.length; j++) {
        t = tw[j];
        if (t === b || TOWERS[t.type].support) continue;
        var dx = t.x - b.x, dy = t.y - b.y;
        if (dx * dx + dy * dy > a2) continue;
        t.bf = Math.max(t.bf, b.st.buff); t.bh = Math.max(t.bh, b.st.haste); t.br = Math.max(t.br, b.st.reach);
      }
    }
    for (i = 0; i < tw.length; i++) {
      t = tw[i];
      var st = t.st, dm = m.dmg * (1 + t.bf);
      st.dmg *= dm; st.burn *= dm; st.rate *= 1 + t.bh;
      st.range *= m.range * (1 + t.br); st.detect *= m.range;
      if (m.spot && !TOWERS[t.type].support) st.detect = Math.max(st.detect, m.spot);
      if (st.detect > 0) g.detectors.push(t);
      if (st.tax > 0) g.taxers.push(t);
    }
  }
  function stats(g, t) { if (g.dirty || !t.st) recalc(g); return t.st; }

  // ---- game ----
  function newGame(mi, perks) {
    var M = MAPS[mi], mod = mods(perks);
    mapData(mi);
    var g = {
      map: mi, perks: cleanPerks(perks), mod: mod, gold: M.gold + mod.gold, lives: M.lives + mod.lives, maxLives: M.lives + mod.lives,
      wave: 0, phase: 'build', endless: false,
      countdown: 0, t: 0, steps: 0, nextId: 1, kills: 0, leaks: 0, spawnAlt: 0, zap: 0,
      towers: [], enemies: [], proj: [], fx: [], spawners: [], waveLeft: [], tgrid: [], detectors: [], taxers: [],
      epool: [], ppool: [], fxpool: [], events: [], fxOn: true, bonusLast: 0, dirty: true
    };
    for (var i = 0; i < COLS * ROWS; i++) g.tgrid.push(null);
    return g;
  }
  function inGrid(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
  function cellAt(g, c, r) { return inGrid(c, r) ? MD[g.map].grid[r * COLS + c] : -1; }
  function towerAt(g, c, r) { return inGrid(c, r) ? g.tgrid[r * COLS + c] : null; }
  function canBuild(g, c, r) { return cellAt(g, c, r) === CELL_GRASS && !towerAt(g, c, r) && g.phase !== 'won' && g.phase !== 'lost'; }

  function addTower(g, type, c, r, lvl, spent, spec) {
    var T = TOWERS[type], t = {
      id: g.nextId++, type: type, lvl: lvl || 0, spec: spec | 0, c: c, r: r, x: c + 0.5, y: r + 0.5, cd: 0,
      mode: T.mode, spent: spent || T.cost[0], kills: 0, dmg: 0, ax: 0, ay: -1, fireT: 0,
      cm: g.mod.upCost, sr: g.mod.sell, st: null, bf: 0, bh: 0, br: 0, bt: null, bid: null, bT: null
    };
    g.towers.push(t);
    g.tgrid[r * COLS + c] = t;
    g.dirty = true;
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
  // One level up; from level 3 the branch b (0 or 1) is required — it's the specialisation.
  function upgrade(g, t, b) {
    if (!t || t.lvl >= MAX_LVL || g.phase === 'won' || g.phase === 'lost') return false;
    if (t.lvl === 2 && b !== 0 && b !== 1) return false;
    var cost = upgradeCost(t, b);
    if (g.gold < cost) return false;
    g.gold -= cost; t.spent += cost; t.lvl++;
    if (t.lvl === MAX_LVL) t.spec = b;
    g.dirty = true;
    g.events.push(t.lvl === MAX_LVL ? 'spec' : 'upgrade');
    return true;
  }
  function sell(g, t) {
    var i = g.towers.indexOf(t);
    if (i < 0) return 0;
    var v = sellValue(t);
    g.towers.splice(i, 1);
    g.tgrid[t.r * COLS + t.c] = null;
    g.gold += v;
    g.dirty = true;
    g.events.push('sell');
    return v;
  }
  function aims(type) { var T = TOWERS[type]; return !T.pulse && !T.support; }
  function cycleMode(t) { if (aims(t.type)) t.mode = (t.mode + 1) % MODES.length; return t.mode; }

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
    return t == null ? 0 : Math.floor(t * BAL.earlyRate * (1 + BAL.earlyGrow * g.wave) * g.mod.early);
  }
  function canCallWave(g) {
    if (g.phase === 'build') return true;
    return g.phase === 'wave' && moreWaves(g) && g.spawners.length < MAX_SPAWNERS;
  }
  function startWave(g) {
    g.wave++;
    var spec = waveSpec(g.wave, g.map), total = 0, i;
    for (i = 0; i < spec.length; i++) total += spec[i].n;
    g.spawners.push({ n: g.wave, groups: spec, gi: 0, left: spec[0].n, t: 0.3 });
    g.waveLeft[g.wave] = total;
    g.countdown = 0;
    g.phase = 'wave';
    g.events.push(waveHasBoss(g.wave) ? 'boss' : 'wave');
    // Banks pay out as each wave starts.
    if (g.dirty) recalc(g);
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], inc = Math.round(t.st.income);
      if (!inc) continue;
      g.gold += inc;
      addFx(g, 5, t.x, t.y - 0.3, 0, 0, 1.1, 0, '+$' + inc);
      g.events.push('income');
    }
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
  function spawnEnemy(g, k, wave, pi, hpScale) {
    if (g.enemies.length >= MAX_ENEMIES) { g.waveLeft[wave]--; return null; }
    var E = ENEMIES[k], e = g.epool.length ? g.epool.pop() : {};
    var id = g.nextId++, h = (id * 2654435761) >>> 0;
    e.id = id; e.k = k; e.wave = wave; e.pi = pi; e.fly = !!E.fly; e.boss = !!E.boss;
    e.maxHp = e.hp = Math.round(E.hp * hpMul(wave, g.map) * (hpScale || 1));
    e.spd = E.spd; e.armor = E.armor; e.bounty = Math.round(bountyFor(k, wave) * g.mod.bounty); e.lives = E.lives;
    e.stealth = !!E.stealth; e.steady = !!E.steady; e.regen = E.regen || 0; e.heal = E.heal || null; e.split = E.split || null; e.summon = E.summon || null;
    e.healT = E.heal ? E.heal.every * 0.6 : 0; e.sumT = E.summon ? E.summon.every * 0.8 : 0;
    e.d = 0; e.seg = 0; e.slowF = 0; e.slowT = 0; e.pend = 0; e.flash = 0; e.zap = 0; e.alive = true;
    e.burnT = 0; e.burnD = 0; e.burnBy = null; e.scorch = 0; e.stunT = 0; e.shred = 0; e.brit = 0; e.britT = 0; e.revealT = 0; e.det = false;
    e.ph = (id * 0.37) % FLICK[0];
    // A small fixed offset so a crowd doesn't stack on one line (bosses walk the middle).
    e.ox = e.boss ? 0 : ((h & 255) / 255 - 0.5) * 0.34;
    e.oy = e.boss ? 0 : (((h >>> 8) & 255) / 255 - 0.5) * 0.34;
    e.dir = 0; e.x = 0; e.y = 0;
    placeEnemy(g, e);
    e.px = e.x; e.py = e.y;
    g.enemies.push(e);
    return e;
  }
  // An extra enemy mid-road (a splitter's pieces, a warlord's escort): it counts
  // towards the wave, and starts at distance d along the parent's road.
  function spawnAt(g, k, wave, pi, d, hpScale, bounty) {
    g.waveLeft[wave] = (g.waveLeft[wave] || 0) + 1;
    var c = spawnEnemy(g, k, wave, pi, hpScale);
    if (!c) return null;
    c.d = Math.max(0, d); c.seg = 0;
    placeEnemy(g, c); c.px = c.x; c.py = c.y;
    if (bounty != null) c.bounty = bounty;
    return c;
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
  // A ghost can be aimed at only while revealed: just hit, burning, in sight of a
  // detector, or flickering into view.
  function visible(e) { return !e.stealth || e.revealT > 0 || e.burnT > 0 || e.det || e.ph < FLICK[1]; }
  // soft: a damage-over-time tick (burn, beam) — no hit flash.
  function hurt(g, e, dmg, pierce, t, soft) {
    if (!e.alive) return;
    var eff = dmg;
    if (!pierce) {
      var arm = Math.max(0, e.armor - e.shred - (e.burnT > 0 ? e.scorch : 0));
      eff = Math.max(dmg * 0.25, dmg - arm);
    }
    if (e.britT > 0) eff *= 1 + e.brit;
    if (eff > e.hp) eff = e.hp;
    e.hp -= eff;
    if (!soft) e.flash = 0.09;
    if (e.stealth) e.revealT = REVEAL;
    if (t) t.dmg += eff;
    if (e.hp <= 0.001) kill(g, e, t);
  }
  function kill(g, e, t) {
    e.alive = false; e.hp = 0;
    var b = e.bounty;
    if (g.taxers.length) {                               // a Tax Office nearby takes its cut — for you
      var x = 0;
      for (var i = 0; i < g.taxers.length; i++) {
        var tx = g.taxers[i], dx = e.x - tx.x, dy = e.y - tx.y, r = tx.st.range;
        if (dx * dx + dy * dy <= r * r) x = Math.max(x, tx.st.tax);
      }
      b = Math.round(b * (1 + x));
    }
    g.gold += b; g.kills++;
    if (t) t.kills++;
    g.events.push(e.boss ? 'bosskill' : 'kill');
    addFx(g, 5, e.x, e.y, 0, 0, 0.9, 0, '+' + b);
    addFx(g, 6, e.x, e.y, 0, 0, 0.3, e.boss ? 1.4 : 0.5, '');
    if (e.split) {                                       // the pieces count before the parent is done
      for (var j = 0; j < e.split.n; j++) spawnAt(g, e.split.k, e.wave, e.pi, e.d - 0.22 * j, e.split.hp, 1);
      g.events.push('split');
    }
    waveDone(g, e.wave);
  }
  function waveDone(g, n) {
    if (--g.waveLeft[n] === 0 && g.phase === 'wave') {
      g.gold += clearBonus(n);
      g.events.push('clear');
    }
  }
  function inRange(e, t, r2) { var dx = e.x - t.x, dy = e.y - t.y; return dx * dx + dy * dy <= r2; }
  function stun(e, s) { if (s && !e.steady) e.stunT = Math.max(e.stunT, e.boss ? s * 0.5 : s); }

  // Best target for a tower by its mode; enemies already doomed by shots in flight
  // are skipped, and so are unrevealed ghosts and (with skip) anything tagged skip.
  function pickTarget(g, t, r2, air, skip) {
    var best = null, bv = 0, mode = t.mode, en = g.enemies, af = TOWERS[t.type].airFirst;
    for (var i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive || (e.fly && !air) || e.pend >= e.hp || (skip && e.zap === skip) || (e.stealth && !visible(e))) continue;
      var dx = e.x - t.x, dy = e.y - t.y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      var v = mode === 0 ? -e.rem : mode === 1 ? e.rem : mode === 2 ? e.hp + e.rem * 0.001 : -d2;
      if (af && e.fly) v += 1e7;
      if (!best || v > bv) { best = e; bv = v; }
    }
    return best;
  }

  // Frost and Flame: everything in range, ghosts included (it reveals them).
  function pulse(g, t, st, r2) {
    var en = g.enemies, hit = false, frost = st.slow > 0, i, e;
    for (i = 0; i < en.length; i++) {
      e = en[i];
      if (!e.alive || !inRange(e, t, r2)) continue;
      hit = true;
      if (frost && !e.steady) {
        var se = e.boss ? st.slow * 0.5 : st.slow, dur = st.slowDur;
        if (se >= e.slowF) { e.slowF = se; if (dur > e.slowT) e.slowT = dur; }
        else if (dur > e.slowT && se === e.slowF) e.slowT = dur;
        if (st.brittle) { e.brit = Math.max(e.brit, st.brittle); e.britT = Math.max(e.britT, dur); }
      }
      if (st.burn) {
        if (e.burnT <= 0 || st.burn >= e.burnD) { e.burnD = st.burn; e.burnBy = t; }
        e.burnT = Math.max(e.burnT, st.burnDur);
        if (st.scorch) e.scorch = Math.max(e.scorch, st.scorch);
      }
      hurt(g, e, st.dmg, false, t);
    }
    if (hit) { addFx(g, frost ? 4 : 7, t.x, t.y, 0, 0, 0.4, st.range, ''); t.fireT = 0.2; g.events.push(frost ? 'frost' : 'flame'); }
    return hit;
  }

  function fire(g, t) {
    var T = TOWERS[t.type], st = t.st, r2 = st.range * st.range, en = g.enemies, i, e;
    if (T.support) return false;
    if (T.pulse) return pulse(g, t, st, r2);
    var tg = pickTarget(g, t, r2, T.air);
    if (!tg) return false;
    t.ax = tg.x - t.x; t.ay = tg.y - t.y; t.fireT = 0.12;
    var dmg = st.dmg;
    if (t.type === TKEY.tesla) {                            // chain to the nearest unzapped neighbours
      var stamp = ++g.zap, cur = tg, n = st.chain;
      cur.zap = stamp;
      addFx(g, 2, t.x, t.y - 0.15, cur.x, cur.y, 0.2, 0, '');
      hurt(g, cur, dmg, false, t); stun(cur, st.stun);
      for (var j = 0; j < n; j++) {
        var nx = null, nd = 1.6 * 1.6;
        for (i = 0; i < en.length; i++) {
          e = en[i];
          if (!e.alive || e.zap === stamp || (e.stealth && !visible(e))) continue;
          var dx = e.x - cur.x, dy = e.y - cur.y, d2 = dx * dx + dy * dy;
          if (d2 < nd) { nd = d2; nx = e; }
        }
        if (!nx) break;
        nx.zap = stamp; dmg *= 0.8;
        addFx(g, 2, cur.x, cur.y, nx.x, nx.y, 0.2, 0, '');
        hurt(g, nx, dmg, false, t); stun(nx, st.stun);
        cur = nx;
      }
      g.events.push('zap');
      return true;
    }
    if (T.pierce) {                                         // Sniper: instant, armour-piercing
      addFx(g, 3, t.x, t.y, tg.x, tg.y, 0.18, 0, '');
      hurt(g, tg, dmg, true, t);
      g.events.push('snipe');
      return true;
    }
    // Arrow / Cannon / Missile: homing projectiles, one per target (Volley, Hydra: several).
    if (!launch(g, t, tg)) return false;
    var multi = st.multi | 0;
    if (multi > 1) {
      var tag = ++g.zap;
      tg.zap = tag;
      for (var m = 1; m < multi; m++) {
        var o = pickTarget(g, t, r2, T.air, tag);
        if (!o) break;
        o.zap = tag;
        launch(g, t, o);
      }
    }
    return true;
  }
  function launch(g, t, tg) {
    if (g.proj.length >= MAX_PROJ) return false;
    var T = TOWERS[t.type], st = t.st, p = g.ppool.length ? g.ppool.pop() : {};
    p.kind = t.type === TKEY.cannon ? 1 : t.type === TKEY.missile ? 2 : 0;
    p.x = p.px = t.x; p.y = p.py = t.y - 0.1; p.tg = tg; p.tid = tg.id; p.tx = tg.x; p.ty = tg.y;
    p.dmg = st.dmg; p.spd = T.pspd; p.splash = st.splash; p.tw = t; p.shred = st.shred; p.airMul = st.airMul || 1;
    p.ex = p.kind ? 0 : Math.max(st.dmg * 0.25, st.dmg - tg.armor);
    if (!p.kind) tg.pend += p.ex;
    g.proj.push(p);
    g.events.push(p.kind === 1 ? 'boom0' : p.kind === 2 ? 'rocket' : 'shot');
    return true;
  }

  function impact(g, p) {
    var tg = p.tg, live = tg && tg.id === p.tid && tg.alive;
    if (live && !p.kind) tg.pend = Math.max(0, tg.pend - p.ex);
    if (p.kind) {                                         // cannon (ground only) / missile (both) blast
      var r2 = p.splash * p.splash, en = g.enemies;
      for (var i = 0; i < en.length; i++) {
        var e = en[i];
        if (!e.alive || (e.fly && p.kind === 1)) continue;
        var dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy > r2) continue;
        hurt(g, e, e.fly ? p.dmg * p.airMul : p.dmg, false, p.tw);
        if (p.shred) e.shred = Math.min(e.armor, e.shred + p.shred);
      }
      addFx(g, 1, p.x, p.y, 0, 0, 0.35, p.splash, p.kind === 2 ? 'm' : '');
      g.events.push('boom');
    } else if (live) {
      hurt(g, tg, p.dmg, false, p.tw);
    }
  }

  // Beam: sticks to its target and ramps up while it holds; a new target keeps
  // half the charge (none after a gap); armour doesn't apply.
  function beamStep(g, t) {
    var st = t.st, r2 = st.range * st.range, nb = Math.max(1, st.beams), any = false;
    if (!t.bt) { t.bt = [null, null]; t.bid = [0, 0]; t.bT = [0, 0]; }
    for (var b = 0; b < 2; b++) {
      var e = b < nb ? t.bt[b] : null;
      if (b >= nb) { t.bt[b] = null; continue; }
      if (!e || e.id !== t.bid[b] || !e.alive || !inRange(e, t, r2) || !visible(e)) {
        var skip = 0;
        if (b && t.bt[0]) { skip = ++g.zap; t.bt[0].zap = skip; }
        e = pickTarget(g, t, r2, true, skip);
        t.bt[b] = e; t.bid[b] = e ? e.id : 0; t.bT[b] = e ? t.bT[b] * 0.5 : 0;
        if (e) g.events.push('beam');
      }
      if (!e) continue;
      any = true;
      t.bT[b] = Math.min(st.rampT, t.bT[b] + STEP);
      var mult = 1 + (st.ramp - 1) * Math.min(1, t.bT[b] / (st.rampT || 1));
      if (!b) { t.ax = e.x - t.x; t.ay = e.y - t.y; }
      hurt(g, e, st.dmg * mult * STEP, true, t, true);
    }
    return any;
  }

  // A healer mends everything near it (itself too) — but nothing that's burning.
  function healAround(g, h) {
    var H = h.heal, r2 = H.r * H.r, en = g.enemies, any = false;
    for (var i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive || e.burnT > 0 || e.hp >= e.maxHp || !inRange(e, h, r2)) continue;
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * H.pct * (e.boss ? 0.25 : 1));
      any = true;
    }
    if (any) { addFx(g, 8, h.x, h.y, 0, 0, 0.6, H.r, ''); g.events.push('heal'); }
  }
  function detected(g, e) {
    var d = g.detectors;
    for (var i = 0; i < d.length; i++) {
      var t = d[i], r = t.st.detect, dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  // ---- one fixed step ----
  function step(g) {
    if (g.phase !== 'wave') return;
    g.t += STEP; g.steps++;
    if (g.dirty) recalc(g);
    var i, en = g.enemies, md = MD[g.map];

    // spawners
    for (i = 0; i < g.spawners.length; i++) {
      var sp = g.spawners[i];
      sp.t -= STEP;
      while (sp.t <= 0 && sp.gi < sp.groups.length) {
        var gr = sp.groups[sp.gi], k = gr.k, pi = 0;
        var np = ENEMIES[k].fly ? md.fly.length : md.paths.length;
        if (np > 1) { pi = g.spawnAlt % np; g.spawnAlt++; }
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

    // enemies: burn, abilities, walk
    for (i = 0; i < en.length; i++) {
      var e = en[i];
      if (!e.alive) continue;
      e.px = e.x; e.py = e.y;
      if (e.burnT > 0) {
        hurt(g, e, e.burnD * STEP, true, e.burnBy, true);
        e.burnT -= STEP;
        if (e.burnT <= 0) { e.burnT = 0; e.burnD = 0; e.scorch = 0; e.burnBy = null; }
        if (!e.alive) continue;
      } else if (e.regen && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.regen * e.maxHp * STEP);
      if (e.heal) { e.healT -= STEP; if (e.healT <= 0) { e.healT += e.heal.every; healAround(g, e); } }
      if (e.summon) {
        e.sumT -= STEP;
        if (e.sumT <= 0) {
          e.sumT += e.summon.every;
          for (var s2 = 0; s2 < e.summon.n; s2++) spawnAt(g, e.summon.k, e.wave, e.pi, e.d - 0.35 * (s2 + 1), 1, 1);
          g.events.push('summon');
        }
      }
      var v = e.spd;
      if (e.stunT > 0) { v = 0; e.stunT -= STEP; if (e.stunT < 0) e.stunT = 0; }
      if (e.slowT > 0) { v *= 1 - e.slowF; e.slowT -= STEP; if (e.slowT <= 0) { e.slowT = 0; e.slowF = 0; } }
      if (e.britT > 0) { e.britT -= STEP; if (e.britT <= 0) { e.britT = 0; e.brit = 0; } }
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
      } else {
        placeEnemy(g, e);
        if (e.stealth) { if (e.revealT > 0) e.revealT -= STEP; e.ph = (e.ph + STEP) % FLICK[0]; e.det = detected(g, e); }
      }
    }

    // towers
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i], T = TOWERS[t.type];
      if (t.fireT > 0) t.fireT -= STEP;
      if (T.support) continue;
      if (T.beam) { if (beamStep(g, t)) t.fireT = 0.1; continue; }
      if (t.cd > 0) { t.cd -= STEP; if (t.cd > 0) continue; }
      if (fire(g, t)) t.cd += 1 / t.st.rate;
      else t.cd = 0;
    }

    // projectiles
    var pr = g.proj;
    for (i = pr.length - 1; i >= 0; i--) {
      var p = pr[i], tg = p.tg;
      p.px = p.x; p.py = p.y;
      if (tg && tg.id === p.tid && tg.alive) { p.tx = tg.x; p.ty = tg.y; }
      else if (!p.kind) { pr[i] = pr[pr.length - 1]; pr.pop(); g.ppool.push(p); p.tg = null; p.tw = null; continue; }   // target gone: arrow fizzles
      var dx = p.tx - p.x, dy = p.ty - p.y, d = Math.sqrt(dx * dx + dy * dy), s = p.spd * STEP;
      if (d <= s) {
        p.x = p.tx; p.y = p.ty;
        impact(g, p);
        pr[i] = pr[pr.length - 1]; pr.pop(); g.ppool.push(p); p.tg = null; p.tw = null;
      } else { p.x += dx / d * s; p.y += dy / d * s; }
    }

    // sweep the dead (swap-remove into the pool)
    for (i = en.length - 1; i >= 0; i--) {
      if (!en[i].alive) { var dead = en[i]; dead.burnBy = null; en[i] = en[en.length - 1]; en.pop(); g.epool.push(dead); }
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

  // ---- save / restore (plain JSON; projectiles, effects and beam locks are not kept) ----
  function fix(n, d) { return +(+n || 0).toFixed(d); }
  function serialize(g) {
    var o = {
      v: 2, map: g.map, perks: cleanPerks(g.perks), gold: g.gold, lives: g.lives, maxLives: g.maxLives, wave: g.wave, phase: g.phase,
      endless: g.endless, livesAtWin: g.livesAtWin || 0, countdown: fix(g.countdown, 4), t: fix(g.t, 4),
      steps: g.steps, nextId: g.nextId, kills: g.kills, leaks: g.leaks, spawnAlt: g.spawnAlt,
      waveLeft: g.waveLeft.slice(), towers: [], enemies: [], spawners: []
    }, i;
    for (i = 0; i < g.towers.length; i++) {
      var t = g.towers[i];
      o.towers.push([t.id, t.type, t.lvl, t.c, t.r, fix(t.cd, 4), t.mode, t.spent, t.kills, Math.round(t.dmg), t.spec | 0]);
    }
    for (i = 0; i < g.enemies.length; i++) {
      var e = g.enemies[i];
      if (!e.alive) continue;
      o.enemies.push([e.id, e.k, fix(e.hp, 3), e.maxHp, fix(e.d, 4), e.pi, e.slowF, fix(e.slowT, 3), e.wave, e.bounty,
        fix(e.burnT, 3), fix(e.burnD, 3), fix(e.stunT, 3), e.shred, fix(e.britT, 3), e.brit, e.scorch, fix(e.revealT, 3), fix(e.healT, 3), fix(e.sumT, 3)]);
    }
    for (i = 0; i < g.spawners.length; i++) {
      var sp = g.spawners[i];
      o.spawners.push({ n: sp.n, gi: sp.gi, left: sp.left, t: fix(sp.t, 4) });
    }
    for (i = 0; i < o.waveLeft.length; i++) if (o.waveLeft[i] == null) o.waveLeft[i] = 0;
    return o;
  }
  // Takes this version's saves and the first one's (v1: five towers, three maps, no perks).
  function restore(o) {
    if (!o || (o.v !== 1 && o.v !== 2) || !MAPS[o.map]) return null;
    var g = newGame(o.map, o.perks), i;
    g.gold = o.gold; g.lives = o.lives; g.maxLives = o.maxLives; g.wave = o.wave; g.phase = o.phase;
    g.endless = !!o.endless; g.livesAtWin = o.livesAtWin || 0; g.countdown = o.countdown; g.t = o.t; g.steps = o.steps;
    g.nextId = o.nextId; g.kills = o.kills; g.leaks = o.leaks; g.spawnAlt = o.spawnAlt || 0;
    g.waveLeft = (o.waveLeft || []).slice();
    for (i = 0; i < o.towers.length; i++) {
      var a = o.towers[i];
      if (!inGrid(a[3], a[4]) || !TOWERS[a[1]] || cellAt(g, a[3], a[4]) !== CELL_GRASS || towerAt(g, a[3], a[4])) continue;
      var t = addTower(g, a[1], a[3], a[4], clamp(a[2] | 0, 0, MAX_LVL), a[7], clamp(a[10] | 0, 0, 1));
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
      if (b.length > 10) {
        e.burnT = b[10]; e.burnD = b[11]; e.stunT = b[12]; e.shred = b[13]; e.britT = b[14]; e.brit = b[15]; e.scorch = b[16];
        e.revealT = b[17]; e.healT = b[18]; e.sumT = b[19];
      }
      var h = (e.id * 2654435761) >>> 0;
      e.ox = e.boss ? 0 : ((h & 255) / 255 - 0.5) * 0.34;
      e.oy = e.boss ? 0 : (((h >>> 8) & 255) / 255 - 0.5) * 0.34;
      placeEnemy(g, e); e.px = e.x; e.py = e.y;
    }
    for (i = 0; i < o.spawners.length; i++) {
      var s = o.spawners[i], spec = waveSpec(s.n, g.map);
      g.spawners.push({ n: s.n, groups: spec, gi: s.gi, left: s.left, t: s.t });
    }
    g.nextId = o.nextId;                                   // re-spawning above advanced it
    g.events.length = 0;
    recalc(g);
    return g;
  }

  var ENGINE = {
    BAL: BAL, COLS: COLS, ROWS: ROWS, STEP: STEP, WAVES: WAVES, WAVE_GAP: WAVE_GAP, SELL_RATE: SELL_RATE, MODES: MODES, MAX_LVL: MAX_LVL,
    TOWERS: TOWERS, TKEY: TKEY, ENEMIES: ENEMIES, MAPS: MAPS, WAVE_TABLE: WAVE_TABLE, PERKS: PERKS,
    CELL_GRASS: CELL_GRASS, CELL_PATH: CELL_PATH, CELL_ROCK: CELL_ROCK, CELL_WATER: CELL_WATER,
    mapData: mapData, pathCells: pathCells, waveSpec: waveSpec, waveCount: waveCount, waveHasBoss: waveHasBoss,
    hpMul: hpMul, bountyFor: bountyFor, clearBonus: clearBonus, towerStat: towerStat, upgradeCost: upgradeCost,
    sellValue: sellValue, newGame: newGame, canBuild: canBuild, towerAt: towerAt, cellAt: cellAt, build: build,
    upgrade: upgrade, sell: sell, cycleMode: cycleMode, aims: aims, nextWave: nextWave, canCallWave: canCallWave,
    earlyBonus: earlyBonus, timeToNext: timeToNext, pickTarget: pickTarget, step: step, advance: advance,
    stars: stars, starsFor: starsFor, goEndless: goEndless, serialize: serialize, restore: restore,
    spawnEnemy: spawnEnemy, hurt: hurt, visible: visible, recalc: recalc, stats: stats,
    mods: mods, cleanPerks: cleanPerks, perkCost: perkCost
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;

  // ================= UI =================
  var Cade = window.Cade;
  Cade.loadCSS('towerdefense.css');

  var PANEL_ID = 'towerdefense-panel', TITLE = '🏰 Tower Defense';
  var PROG_KEY = 'cade-td-progress', SAVE_KEY = 'cade-td-save';
  var CELL = 30, VW = COLS * CELL, VH = ROWS * CELL;      // logical canvas units; scaled to fit
  var BRACKETS = [['[', ']'], ['{', '}'], ['«', '»'], ['«', '»']], PIPS = ['·', '··', '···', '★'];
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
    var prog = { maps: maps, sound: !!p.sound, perks: cleanPerks(p.perks) };
    if (perkCost(prog.perks) > starsEarned(prog)) prog.perks = {};   // more spent than earned: refund
    return prog;
  }
  function starsEarned(prog) { var n = 0; for (var i = 0; i < MAPS.length; i++) n += prog.maps[MAPS[i].id].stars; return n; }
  function starsFree() { return starsEarned(S.prog) - perkCost(S.prog.perks); }
  function saveProg() { if (S) sset(PROG_KEY, JSON.stringify(S.prog)); }
  function unlocked(i) { return i === 0 || (S && S.prog.maps[MAPS[i - 1].id].stars > 0); }
  function loadSave() {
    try {
      var o = JSON.parse(sget(SAVE_KEY) || 'null');
      return o && o.v === 1 && o.g && MAPS[o.g.map] ? o : null;     // (the wrapper's v; the game inside has its own)
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
    // one colour per tower, in TOWERS order (Bank in the text colour, Beacon in the accent)
    var tcs = [amber, orange, blue, purple, teal, red, pink, green, tx, ac];
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
      heal: css(green), beam: css(green), rocket: css(pink), flame: css(red),
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
    if (solid) {
      c.fillStyle = k.tile[t.type][Math.min(t.lvl, 2)]; c.fillRect(x0 + 1, y0 + 1, CELL - 2, CELL - 2);
      if (t.lvl >= MAX_LVL) { c.strokeStyle = k.tc[t.type]; c.lineWidth = 1; c.strokeRect(x0 + 1.5, y0 + 1.5, CELL - 3, CELL - 3); }   // specialised
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = S.fG; c.fillStyle = t.lvl >= 2 ? k.tc[t.type] : k.tdim[t.type];
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
    drawBeams(c, g, k, a);
    if (g.fx.length) drawFx(c, g, k);
    drawTip(c);
    drawNotes(c, g, k);
  }
  // selection, range ring, build preview, towers that just fired
  function drawSel(c, g, k) {
    var i, selT = S.selT, sel = S.sel, armed = S.armed;
    if (selT) {
      var st = stats(g, selT);
      if (st.range > 0) ring(c, selT.x * CELL, selT.y * CELL, st.range * CELL, k.ring, k.accentFill);
      if (st.aura > 0) {                                 // a Beacon: its aura, and the towers it lifts
        var bc = k.tc[TKEY.beacon], a2 = st.aura * st.aura;
        ring(c, selT.x * CELL, selT.y * CELL, st.aura * CELL, bc, null);
        c.strokeStyle = bc; c.lineWidth = 1;
        for (i = 0; i < g.towers.length; i++) {
          var o = g.towers[i], ox = o.x - selT.x, oy = o.y - selT.y;
          if (o !== selT && !TOWERS[o.type].support && ox * ox + oy * oy <= a2) c.strokeRect(o.c * CELL + 3.5, o.r * CELL + 3.5, CELL - 7, CELL - 7);
        }
      }
      c.strokeStyle = k.accent; c.lineWidth = 1.5; c.strokeRect(selT.c * CELL + 0.75, selT.r * CELL + 0.75, CELL - 1.5, CELL - 1.5);
    }
    var pc = sel || (armed >= 0 ? S.hover : null);
    if (pc && !towerAt(g, pc.c, pc.r)) {
      var ok = canBuild(g, pc.c, pc.r);
      if (armed >= 0 && ok) {
        var s0 = towerStat(armed, 0), rr = s0.range * g.mod.range;
        if (rr > 0) ring(c, (pc.c + 0.5) * CELL, (pc.r + 0.5) * CELL, rr * CELL, k.ring, k.accentFill);
        if (s0.aura > 0) ring(c, (pc.c + 0.5) * CELL, (pc.r + 0.5) * CELL, s0.aura * CELL, k.tc[TKEY.beacon], null);
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
      if (t.fireT > 0.06 && !TOWERS[t.type].beam) { setFont(c, S.fTower); c.fillStyle = k.text; c.fillText(TOWERS[t.type].glyph, t.x * CELL, t.y * CELL - 2.5); }
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
        var wide = e.k === 'O' || e.k === 'M', hidden = e.stealth && !visible(e);
        if (e.fly) {
          setFont(c, S.fTiny); c.fillStyle = k.shadow; c.fillText('·', ex, ey + 6);
          ey -= 6 + Math.sin(g.t * 6 + e.id) * 1.5;
        }
        if (e.stealth) c.globalAlpha = hidden ? 0.2 : 0.8;   // ghosts: a faint shimmer until revealed
        setFont(c, e.boss ? S.fBoss : wide ? S.fTank : S.fE);
        c.fillStyle = e.flash > 0 ? k.hit : e.stunT > 0 ? k.zap : e.burnT > 0 ? k.boom : e.slowT > 0 ? k.frost :
          e.boss ? k.boss : e.fly ? k.flyer : e.heal ? k.heal : k.enemy;
        if (wide) {                                      // tanks, golems: wide and heavy (narrow fonts make O read as 0)
          c.setTransform(S.k * 1.35, 0, 0, S.k, ex * S.k, ey * S.k);
          c.fillText(ch, 0, 0);
          c.setTransform(S.k, 0, 0, S.k, 0, 0);
        } else c.fillText(ch, ex, ey);
        if (e.stealth) c.globalAlpha = 1;
        if (e.hp < e.maxHp && !hidden) {                 // segmented HP bar: ▬▬▬▭▭
          var segs = e.boss ? 10 : 5, sw = e.boss ? 3 : 3.2, w = segs * sw, bx = ex - w / 2, by = ey - (e.boss ? 16 : wide ? 12.5 : 11), f = e.hp / e.maxHp;
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
      if (p.kind === 1) { setFont(c, S.fTiny); c.fillStyle = k.boom; c.fillText('●', qx, qy); }
      else if (p.kind === 2) {                          // rocket: a head and a smoke puff behind
        setFont(c, S.fTiny); c.fillStyle = k.muted; c.fillText('·', qx - (p.x - p.px) * CELL * 2.5, qy - (p.y - p.py) * CELL * 2.5);
        setFont(c, S.fSmB); c.fillStyle = k.rocket; c.fillText('*', qx, qy);
      } else { setFont(c, S.fG); c.fillStyle = k.tc[0]; c.fillText(lineChar(p.x - p.px, p.y - p.py), qx, qy); }
    }
  }
  // Beam towers: a stroke of glyphs to what they hold, brighter as they ramp up.
  function drawBeams(c, g, k, a) {
    var tw = g.towers, i, b, j;
    for (i = 0; i < tw.length; i++) {
      var t = tw[i];
      if (!t.bt || !TOWERS[t.type].beam) continue;
      for (b = 0; b < 2; b++) {
        var e = t.bt[b];
        if (!e || !e.alive || e.id !== t.bid[b]) continue;
        var q = Math.min(1, t.bT[b] / (t.st.rampT || 1)), x0 = t.x * CELL, y0 = t.y * CELL - 2.5;
        var dx = lerp(e.px, e.x, a) * CELL - x0, dy = lerp(e.py, e.y, a) * CELL - y0, L = Math.sqrt(dx * dx + dy * dy), n = Math.max(2, Math.floor(L / 5.5));
        var ch = lineChar(dx, dy);
        setFont(c, q > 0.6 ? S.fSmB : S.fSm); c.fillStyle = k.beam; c.globalAlpha = 0.35 + 0.65 * q;
        for (j = 1; j < n; j++) c.fillText(ch, x0 + dx * j / n, y0 + dy * j / n);
        c.globalAlpha = 1;
      }
    }
  }
  function drawFx(c, g, k) {
    var fx = g.fx, i, j;
    for (i = 0; i < fx.length; i++) {
      var F = fx[i], q = F.t / F.life, fxx = F.x * CELL, fyy = F.y * CELL, n2, r2;
      c.globalAlpha = Math.max(0, 1 - q);
      if (F.kind === 1) {                                // cannon / rocket blast: a ring of * growing out
        setFont(c, S.fG); c.fillStyle = F.txt === 'm' ? k.rocket : k.boom; r2 = F.a * CELL * (0.3 + 0.7 * q);
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
      } else if (F.kind === 7) {                         // flame burst: tongues of ^ licking outwards
        setFont(c, S.fSmB); r2 = F.a * CELL * (0.3 + 0.7 * q);
        n2 = Math.max(8, Math.floor(r2 * 6.28 / 11));
        for (j = 0; j < n2; j++) {
          c.fillStyle = j & 1 ? k.boom : k.flame;
          c.fillText(j % 3 ? '^' : ',', fxx + Math.cos(j / n2 * 6.283) * r2, fyy + Math.sin(j / n2 * 6.283) * r2 - q * 3);
        }
      } else if (F.kind === 8) {                         // healer's pulse: a ring of +
        setFont(c, S.fSmB); c.fillStyle = k.heal; r2 = F.a * CELL * (0.2 + 0.8 * q);
        for (j = 0; j < 8; j++) c.fillText('+', fxx + Math.cos(j * 0.785) * r2, fyy + Math.sin(j * 0.785) * r2);
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
  function num(n) { return n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n >= 100 ? String(Math.round(n)) : fmt(Math.round(n * 10) / 10); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  // The headline numbers for a tower's stats.
  function statLine(type, st) {
    var T = TOWERS[type];
    if (T.key === 'bank') return '+$' + Math.round(st.income) + ' a wave' + (st.tax ? ' · kills +' + pct(st.tax) + ' (r ' + fmt(+st.range.toFixed(1)) + ')' : '');
    if (T.key === 'beacon') return 'nearby +' + pct(st.buff) + ' dmg' + (st.haste ? ' +' + pct(st.haste) + ' spd' : '') + (st.reach ? ' +' + pct(st.reach) + ' rng' : '');
    var r = ' · r ' + fmt(+st.range.toFixed(1));
    if (T.beam) return num(st.dmg) + '→' + num(st.dmg * st.ramp) + ' dps' + r;
    if (st.burn) return 'dmg ' + num(st.dmg) + ' + burn ' + num(st.burn) + '/s' + r;
    return 'dmg ' + num(st.dmg) + ' · ' + fmt(+st.rate.toFixed(2)) + '/s' + r;
  }
  // What else it does (slows, chains, blasts...), or '' for nothing special.
  function effectLine(type, st) {
    var T = TOWERS[type], b = [];
    if (T.key === 'beacon') return 'reveals ghosts within ' + fmt(+st.detect.toFixed(1));
    if (st.slow) b.push('slows ' + pct(st.slow) + ' for ' + fmt(st.slowDur) + 's');
    if (st.brittle) b.push('+' + pct(st.brittle) + ' dmg taken');
    if (st.chain) b.push('jumps ' + st.chain + '×');
    if (st.stun) b.push('stuns ' + fmt(st.stun) + 's');
    if (st.splash) b.push('blast ' + fmt(+st.splash.toFixed(2)));
    if (st.airMul > 1) b.push('flyers ' + fmt(st.airMul) + '×');
    if (st.multi > 1) b.push(st.multi + ' targets');
    if (st.beams > 1) b.push('2 beams');
    if (st.shred) b.push('-' + st.shred + ' armour a hit');
    if (st.scorch) b.push('burning: -' + st.scorch + ' armour');
    if (st.burn && !st.scorch) b.push('burns ' + fmt(st.burnDur) + 's · stops healing');
    if (T.pierce) b.push('ignores armour');
    if (T.beam) b.push('ramps up in ' + fmt(st.rampT) + 's');
    return b.join(' · ');
  }
  function tipLines() {
    var g = S.g, t = S.selT, L = [], T, x;
    if (t) {
      T = TOWERS[t.type];
      var st = stats(g, t), sp = t.lvl >= MAX_LVL ? T.spec[t.spec] : null;
      L.push((sp ? sp.name + ' (' + T.name + ')' : T.name) + '  lv ' + (t.lvl + 1) + '/4');
      L.push(statLine(t.type, st));
      x = effectLine(t.type, st); if (x) L.push(x);
      L.push(T.key === 'bank' ? 'pays as each wave starts' : T.key === 'beacon' ? 'lifting ' + liftCount(g, t) + ' tower' + (liftCount(g, t) === 1 ? '' : 's') :
        (aims(t.type) ? 'aim ' + MODES[t.mode] : 'all in range') + ' · ' + t.kills + ' kill' + (t.kills === 1 ? '' : 's') + ' · ' + num(t.dmg) + ' dmg');
      if (t.bf || t.bh || t.br) L.push('♦ beacon: +' + pct(t.bf) + ' dmg' + (t.bh ? ' +' + pct(t.bh) + ' spd' : '') + (t.br ? ' +' + pct(t.br) + ' rng' : ''));
      if (t.lvl < 2) L.push('next: ' + statLine(t.type, towerStat(t.type, t.lvl + 1)));
      else if (t.lvl === 2) { L.push('A ' + T.spec[0].name + ': ' + T.spec[0].note); L.push('B ' + T.spec[1].name + ': ' + T.spec[1].note); }
      else L.push(sp.note);
      return L;
    }
    if (S.armed >= 0 && S.sel && canBuild(g, S.sel.c, S.sel.r)) {
      T = TOWERS[S.armed];
      var s0 = towerStat(S.armed, 0), cost = T.cost[0];
      L.push(T.name + '  $' + cost);
      L.push(T.role);
      L.push(statLine(S.armed, s0));
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
    if (t) key = t.id + ':' + t.lvl + ':' + t.mode + ':' + S.stamp + ':' + t.kills + ':' + Math.round(t.dmg / 50);
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
        case 'build': S.baseDirty = true; S.stamp++; if (!k[0]++) { snd.tone(520, 0.08, 'triangle', 0.05, 780); Cade.haptic(10); } break;
        case 'upgrade': S.baseDirty = true; S.stamp++; if (!k[0]++) { snd.tone(660, 0.07, 'triangle', 0.05); snd.tone(990, 0.1, 'triangle', 0.04, 0, 0.06); Cade.haptic(12); } break;
        case 'spec': S.baseDirty = true; S.stamp++; if (!k[0]++) { snd.tone(523, 0.1, 'triangle', 0.05); snd.tone(784, 0.1, 'triangle', 0.05, 0, 0.08); snd.tone(1046, 0.18, 'triangle', 0.05, 0, 0.16); Cade.haptic(20); } break;
        case 'sell': S.baseDirty = true; S.stamp++; if (!k[0]++) snd.tone(700, 0.12, 'sine', 0.04, 350); break;
        case 'shot': if (!k[1]++) snd.tone(1400, 0.025, 'square', 0.008); break;
        case 'boom': if (!k[2]++) snd.tone(130, 0.14, 'square', 0.03, 55); break;
        case 'zap': if (!k[3]++) snd.tone(900, 0.06, 'sawtooth', 0.015, 1700); break;
        case 'snipe': if (!k[4]++) snd.tone(1800, 0.05, 'square', 0.015, 600); break;
        case 'frost': if (!k[5]++) snd.tone(2100, 0.09, 'sine', 0.012, 1500); break;
        case 'flame': if (!k[5]++) snd.tone(180, 0.12, 'sawtooth', 0.012, 90); break;
        case 'rocket': if (!k[1]++) snd.tone(300, 0.12, 'sawtooth', 0.01, 900); break;
        case 'beam': if (!k[4]++) snd.tone(1200, 0.08, 'sine', 0.01, 1500); break;
        case 'income': if (!k[9]++) { snd.tone(1318, 0.06, 'triangle', 0.03); snd.tone(1760, 0.08, 'triangle', 0.03, 0, 0.05); } break;
        case 'heal': if (!k[10]++) snd.tone(660, 0.12, 'sine', 0.012, 990); break;
        case 'split': case 'summon': if (!k[11]++) snd.tone(240, 0.08, 'square', 0.012, 160); break;
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

  // Row B (two rows high): the build palette, or the selected tower's actions.
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
      var T = TOWERS[t.type], fork = t.lvl === 2, top = t.lvl >= MAX_LVL, up = upgradeCost(t, 0), up2 = fork ? upgradeCost(t, 1) : 0;
      var sv = sellValue(t), arm = S.sellArm && perfNow() < S.sellArm;
      var key2 = [t.id, t.lvl, t.mode, g.gold >= up, g.gold >= up2, !!arm].join(':');
      if (h.ctxKey === key2) return;
      h.ctxKey = key2;
      var q = function (a) { return h.ctx.querySelector('[data-act="' + a + '"]'); };
      var ub = q('up'), vb = q('up2'), mb = q('mode'), sb = q('sell');
      h.ctx.classList.toggle('fork', fork);
      if (fork) {
        ub.querySelector('b').textContent = T.spec[0].name; ub.querySelector('span').textContent = 'A · $' + up;
        vb.querySelector('b').textContent = T.spec[1].name; vb.querySelector('span').textContent = 'B · $' + up2;
        ub.title = T.spec[0].name + ' — ' + T.spec[0].note + ' (U)'; vb.title = T.spec[1].name + ' — ' + T.spec[1].note + ' (I)';
      } else {
        ub.querySelector('b').textContent = top ? '★ ' + T.spec[t.spec].name : '▲ Upgrade';
        ub.querySelector('span').textContent = top ? 'max level' : '$' + up + ' · lv ' + (t.lvl + 2);
        ub.title = top ? T.spec[t.spec].note : 'Upgrade (U)';
      }
      setDis(ub, top);
      ub.classList.toggle('poor', !top && g.gold < up);
      vb.classList.toggle('poor', fork && g.gold < up2);
      var aim = aims(t.type);
      mb.querySelector('b').textContent = aim ? '⌖ Aim' : T.support ? '· Support' : '* Area';
      mb.querySelector('span').textContent = aim ? MODES[t.mode] : T.support ? 'no aim' : 'all in range';
      setDis(mb, !aim);
      sb.querySelector('b').textContent = arm ? 'Sure?' : '$ Sell';
      sb.querySelector('span').textContent = '+$' + sv;
      sb.classList.toggle('arm', !!arm);
    }
  }
  function liftCount(g, b) {
    var a2 = stats(g, b).aura * b.st.aura, n = 0;
    for (var i = 0; i < g.towers.length; i++) {
      var o = g.towers[i], dx = o.x - b.x, dy = o.y - b.y;
      if (o !== b && !TOWERS[o.type].support && dx * dx + dy * dy <= a2) n++;
    }
    return n;
  }
  var DIGITS = '1234567890';
  function paletteHtml() {
    var s = '';
    for (var i = 0; i < TOWERS.length; i++) {
      var T = TOWERS[i];
      s += '<button type="button" class="td-tw" data-t="' + i + '" title="' + esc(T.name + ' — ' + T.role + ' ($' + T.cost[0] + ') · key ' + DIGITS.charAt(i)) + '" aria-label="' + esc(T.name + ', $' + T.cost[0]) + '" aria-pressed="false">' +
        '<b class="td-c' + i + '">' + T.glyph + '</b><span>$' + T.cost[0] + '</span></button>';
    }
    return s;
  }
  function towerMenuHtml() {
    return '<button type="button" class="td-act td-up" data-act="up" title="Upgrade (U)"><b></b><span></span></button>' +
      '<button type="button" class="td-act td-up2" data-act="up2"><b></b><span></span></button>' +
      '<button type="button" class="td-act td-mode" data-act="mode" title="Change target (T)"><b></b><span></span></button>' +
      '<button type="button" class="td-act td-x" data-act="desel" title="Close (Esc)" aria-label="Deselect"><b>✕</b></button>' +
      '<button type="button" class="td-act td-sell" data-act="sell" title="Sell (S)"><b></b><span></span></button>';
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
  // b: which specialisation at the fork (0 = A, 1 = B); ignored below it.
  function doUpgrade(b) {
    var t = S.selT;
    if (!t) return;
    if (t.lvl >= MAX_LVL) { flash('fully upgraded'); return; }
    b = t.lvl === 2 ? (b === 1 ? 1 : 0) : undefined;
    if (!upgrade(S.g, t, b)) { flash('need $' + (upgradeCost(t, b) - S.g.gold) + ' more', true); return; }
    if (t.lvl === MAX_LVL) flash(TOWERS[t.type].spec[t.spec].name + '!');
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
    if (!t || !aims(t.type)) return;
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
  function mapTag(M) {
    var g = M.paths.length > 1 ? ' ×' + M.paths.length : '';
    var sw = M.swap ? ' · ' + Object.keys(M.swap).map(function (k) { return M.swap[k]; }).join('') : '';
    return M.diff + g + sw;
  }
  function mapTitle(M) {
    var bits = [M.name + ' — ' + M.diff];
    if (M.paths.length > 1) bits.push(M.paths.length + ' gates');
    if (M.swap) bits.push(Object.keys(M.swap).map(function (k) { return ENEMIES[M.swap[k]].name.toLowerCase() + 's for ' + ENEMIES[k].name.toLowerCase() + 's'; }).join(', ') + ' from wave ' + (M.swapFrom || 1));
    return bits.join(' · ');
  }
  function overlayHtml(kind) {
    var g = S.g, i, s = '';
    if (kind === 'title') {
      var sv = loadSave(), free = starsFree();
      s += '<div class="td-card td-card-title"><div class="td-title">TOWER DEFENSE</div>';
      if (sv) {
        var sm = MAPS[sv.g.map];
        s += '<button type="button" class="td-go" data-act="continue">▶ Continue ' + esc(sm.name) + ' · wave ' + sv.g.wave + ' · ♥ ' + sv.g.lives + '</button>';
      }
      s += '<div class="td-maps">';
      for (i = 0; i < MAPS.length; i++) {
        var M = MAPS[i], pm = S.prog.maps[M.id], open = unlocked(i);
        s += '<button type="button" class="td-map' + (open ? '' : ' locked') + '" data-act="map" data-i="' + i + '" title="' + esc(mapTitle(M)) + '"' + (open ? '' : ' aria-disabled="true"') + '>' +
          '<pre class="td-mini" aria-hidden="true">' + miniMap(i) + '</pre>' +
          '<span class="td-mname">' + esc(M.name) + '</span>' +
          '<span class="td-mdiff">' + esc(mapTag(M)) + '</span>' +
          (open ? '<span class="td-stars">' + starStr(pm.stars) + '</span><span class="td-mbest">' + (pm.best ? 'best ' + pm.best : 'new') + '</span>'
            : '<span class="td-lock">locked</span><span class="td-mbest">win ' + esc(MAPS[i - 1].name) + '</span>') +
          '</button>';
      }
      s += '</div><div class="td-row"><button type="button" class="td-btn" data-act="help">how to play</button>' +
        '<button type="button" class="td-btn td-armbtn" data-act="armory">armory ★' + free + '</button>' +
        '<button type="button" class="td-btn" data-act="sound">sound: ' + (S.snd.on ? 'on' : 'off') + '</button></div></div>';
      return s;
    }
    if (kind === 'armory') {
      var have = starsEarned(S.prog), left = starsFree(), pk = S.prog.perks;
      s += '<div class="td-card td-card-arm"><div class="td-title">ARMORY</div>' +
        '<div class="td-sub">★ ' + left + ' to spend · ' + have + ' earned' + (have ? '' : ' — win maps for stars') + '</div><div class="td-perks">';
      for (i = 0; i < PERKS.length; i++) {
        var P = PERKS[i], r = pk[P.id] | 0, pips = '';
        for (var j = 0; j < P.max; j++) pips += j < r ? '●' : '○';
        s += '<div class="td-perk' + (r ? ' on' : '') + '"><div class="td-pk"><b>' + esc(P.name) + '</b><span>' + esc(P.desc) + (P.max > 1 ? ' · up to ×' + P.max : '') + '</span></div>' +
          '<span class="td-pips" aria-label="' + r + ' of ' + P.max + '">' + pips + '</span>' +
          '<button type="button" class="td-pb" data-act="perk-" data-p="' + P.id + '"' + (r ? '' : ' disabled') + ' aria-label="Refund ' + esc(P.name) + '">−</button>' +
          '<button type="button" class="td-pb td-pb-buy" data-act="perk+" data-p="' + P.id + '"' + (r < P.max && left >= P.cost ? '' : ' disabled') + ' aria-label="Buy ' + esc(P.name) + ' for ' + P.cost + ' stars">★' + P.cost + '</button></div>';
      }
      s += '</div><div class="td-note">perks apply to maps you start from now on · refunds are free</div>' +
        '<div class="td-row"><button type="button" class="td-btn" data-act="perkreset"' + (perkCost(pk) ? '' : ' disabled') + '>refund all</button>' +
        '<button type="button" class="td-go" data-act="armback">done</button></div></div>';
      return s;
    }
    if (kind === 'help') {
      var rows = '';
      for (i = 0; i < TOWERS.length; i++) {
        var T = TOWERS[i];
        rows += '<tr><td class="td-c' + i + '">[' + esc(T.glyph) + ']</td><td><b class="td-tn">' + esc(T.name) + '</b> — ' + esc(T.role) +
          '<br><small>→ ' + esc(T.spec[0].name) + ': ' + esc(T.spec[0].note) + ' · ' + esc(T.spec[1].name) + ': ' + esc(T.spec[1].note) + '</small></td></tr>';
      }
      return '<div class="td-card td-card-help"><div class="td-title">HOW TO PLAY</div><div class="td-help">' +
        '<p>Enemies march down the <b>·</b> road from the gate <b class="td-acc">↓</b> to your base <b class="td-bad">⌂</b>. Each one that gets in costs <b>♥</b> (bosses 5 or more). Survive ' + WAVES + ' waves to win; stars for lives left.</p>' +
        '<p><b>Build:</b> ' + (S.coarse ? 'tap' : 'click') + ' a grass tile, pick a tower below, then ' + (S.coarse ? 'tap it again' : 'click again') + ' to build. ' +
        '<b>Tap a tower</b> to upgrade it twice, then <b>specialise</b> it into one of two forms (A or B); change what it aims at, or sell it.</p>' +
        '<table class="td-legend">' + rows + '</table>' +
        '<p><b>o</b> grunt · <b>&gt;</b> runner · <b>O</b> tank (armoured) · <b class="td-pink">&amp;</b> flyer and <b class="td-pink">w</b> bats — fly straight over everything along the faint dotted lane · ' +
        '<b class="td-grn">h</b> healer — mends its neighbours · <b>8</b> splitter — breaks into three · <b>?</b> ghost — only flickers into view; a Beacon, a hit or a burn reveals it · ' +
        '<b>T</b> troll — regenerates · <b>M</b> golem — heavy armour, can\'t be slowed or stunned. Bosses: <b class="td-bad">@</b> ogre, <b class="td-bad">Ω</b> warlord (calls escorts), <b class="td-bad">W</b> wyrm (flies).</p>' +
        '<p><b>Burning</b> stops healing and regeneration. Frost, Flame and blasts hit ghosts even unseen.</p>' +
        '<p><b>▶▶ Wave</b> calls the next wave early for bonus gold; clearing a wave pays too, and Banks pay as each wave starts. <b>1× 2× 3×</b> sets the speed. Win maps for <b>★</b> and spend them in the <b>Armory</b>. The game pauses when you leave and is saved — continue it later.</p>' +
        (S.coarse ? '' : '<p class="td-keys">Keys: 1–9, 0 tower · Enter build · arrows move · U upgrade (A) · I specialise B · S sell · T aim · Space next wave · F speed · P pause · Esc back</p>') +
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
        (starsFree() > 0 ? '<div class="td-note">★ ' + starsFree() + ' to spend in the Armory</div>' : '') +
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
  function showOverlay(kind, focusPerk) {
    if (!S) return;
    var keepScroll = kind === 'armory' && S.ovlKind === 'armory' ? (S.ovl.querySelector('.td-perks') || {}).scrollTop : 0;
    S.ovlKind = kind;
    S.ovl.innerHTML = kind ? overlayHtml(kind) : '';
    if (keepScroll) S.ovl.querySelector('.td-perks').scrollTop = keepScroll;
    S.ovl.style.display = kind ? '' : 'none';
    S.stage.classList.toggle('dim', !!kind);
    S.root.classList.toggle('td-blocked', !!kind);
    S.root.classList.toggle('td-nogame', !S.g || kind === 'title');
    if (kind) {
      S.sel = null; S.selT = null; S.armed = -1;
      var f = focusPerk ? S.ovl.querySelector('[data-p="' + focusPerk + '"]:not(:disabled)') : null;
      f = f || S.ovl.querySelector('.td-go');
      if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
    syncHud();
    redraw();
  }

  function startMap(i) {
    if (!unlocked(i)) { Cade.showToast && Cade.showToast('Win ' + MAPS[i - 1].name + ' to unlock ' + MAPS[i].name, 'info', 1800); return; }
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    S.g = newGame(i, S.prog.perks); S.viewMap = i; S.paused = false;
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
    else if (a === 'armory') showOverlay('armory');
    else if (a === 'armback') showOverlay('title');
    else if (a === 'perk+' || a === 'perk-') {
      var id = b.getAttribute('data-p'), P = null, pk = S.prog.perks;
      for (var i = 0; i < PERKS.length; i++) if (PERKS[i].id === id) P = PERKS[i];
      if (!P) return;
      var r = pk[id] | 0;
      if (a === 'perk+' && r < P.max && starsFree() >= P.cost) pk[id] = r + 1;
      else if (a === 'perk-' && r > 0) { if (r > 1) pk[id] = r - 1; else delete pk[id]; }
      else return;
      saveProg(); S.snd.tone(a === 'perk+' ? 880 : 520, 0.06, 'triangle', 0.04);
      showOverlay('armory', id);
    } else if (a === 'perkreset') { S.prog.perks = {}; saveProg(); showOverlay('armory'); }
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
      if (a === 'up') doUpgrade(0); else if (a === 'up2') doUpgrade(1); else if (a === 'mode') doMode(); else if (a === 'sell') doSell(); else if (a === 'desel') deselect();
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
      if (S.ovlKind === 'armory') { showOverlay('title'); return; }
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
    if (e.repeat && !/^Arrow/.test(code)) { if (/^(Space|Enter|Digit|KeyU|KeyI|KeyS|KeyT|KeyF|KeyN)/.test(code)) e.preventDefault(); return; }
    var dg = /^(Digit|Numpad)([0-9])$/.exec(code);
    if (dg) { e.preventDefault(); act(); armTower(DIGITS.indexOf(dg[2])); return; }
    switch (code) {
      case 'Space': case 'KeyN': e.preventDefault(); act(); doNext(); return;
      case 'Enter': case 'NumpadEnter': e.preventDefault(); act(); if (S.armed >= 0 && S.sel) tryBuild(false); return;
      case 'KeyU': e.preventDefault(); doUpgrade(0); return;
      case 'KeyI': e.preventDefault(); doUpgrade(1); return;
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
      raf: 0, last: 0, k: 1, base: null, baseDirty: true, ctxMode: '', tipKey: '', tip: null, curFont: null, stamp: 0
    };
    var q = function (sel) { return p.querySelector(sel); };
    S.hud = {
      ctx: q('.td-ctx'), lives: q('.td-lives'), gold: q('.td-gold'), wave: q('.td-wave'), livesBox: q('.td-stats'),
      next: q('.td-next'), next1: q('.td-next b'), next2: q('.td-next span'), speed: q('.td-spd'), pause: q('[data-act="pause"]'),
      pauseK: -1, ctxKey: '', info: null
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
    description: 'ASCII tower defense — 10 towers with specialisations, 13 enemy types, 8 maps of 30 waves and an Armory of perks',
    icon: '🏰',
    tags: 'game,strategy,tower defense,td,towers,waves,defense,ascii,fun,train',
    open: open,
    // Pure engine, exposed for headless checks — not used by the app.
    _engine: ENGINE
  });
})();
