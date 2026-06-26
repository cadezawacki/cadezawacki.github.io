/* ============================================================================
 * DEEPDELVE — Dungeon Crawler  (Cade.txt widget, id: "crawler")
 * ----------------------------------------------------------------------------
 * A puzzle-action-adventure roguelite with an *enduring* character.
 *
 *   • Persistent hero — level, stats, gold, inventory, equipment, abilities —
 *     saved to the Firebase room `_dungeon` (path rooms/_dungeon) so the same
 *     character follows you across devices and sessions. Falls back to a local
 *     cache when Firebase isn't configured, and works fully offline.
 *   • Turn-based grid combat with smooth animation, status effects (poison,
 *     burn, stun), criticals, and varied enemy AI (chasers, archers, bombers,
 *     thieves, summoners) plus a boss every 5 floors.
 *   • Puzzles: lever-gates & locked doors that seal the stairs (always
 *     solvable, proven by flood-fill), pushable boulders, pressure plates,
 *     telegraphed spike traps, and paired teleporters.
 *   • A town hub to heal, shop and upgrade. Death is not the end — you wake in
 *     town, lighter of pocket but wiser, and descend again.
 *   • Mobile-first: on-screen D-pad + ability buttons, swipe, and tap-to-travel
 *     pathfinding. Full keyboard support on desktop.
 *
 * Engineering notes:
 *   • Everything lives inside one IIFE. No globals leak.
 *   • The rAF loop self-cancels the instant the canvas leaves the DOM, every
 *     document listener is removed and the Firebase listener detached on close,
 *     and all heavy state is nulled — zero footprint while the widget is shut.
 *   • Nothing is loaded until the widget is opened (lazy); the service worker
 *     precaches this file + css for offline once it's been seen.
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  Cade.loadCSS('crawler.css');

  // ---- geometry --------------------------------------------------------------
  var MW = 42, MH = 34;            // map size in tiles
  var VW = 15, VH = 11;            // viewport size in tiles
  var TILE = 26;                   // logical px per tile
  var CW = VW * TILE, CH = VH * TILE;
  var LIGHT = 6;                   // torch radius

  // ---- tile codes ------------------------------------------------------------
  var T_WALL = 0, T_FLOOR = 1, T_CRACK = 2; // crack = bombable wall

  // ---- persistence keys ------------------------------------------------------
  var LKEY = 'cade-dungeon-save';      // local mirror of the hero
  var CKEY = 'cade-dungeon-client';    // this device's id
  var FB_PATH = 'rooms/_dungeon/hero'; // under rooms/ so existing FB rules apply

  // ---- live (non-persistent) state ------------------------------------------
  var world = null;   // current floor: map, objects, monsters, items, fx, …
  var hero = null;    // THE persistent character
  var ui = null;      // dom refs + animation loop handle
  var raf = 0;
  var saveTimer = 0, fbDirty = false;
  var fbRef = null, fbCb = null, clientId = '';

  // =========================================================================
  //  small utilities
  // =========================================================================
  function ri(n) { return (Math.random() * n) | 0; }                 // 0..n-1
  function rr(a, b) { return a + ri(b - a + 1); }                    // a..b inclusive
  function chance(p) { return Math.random() < p; }
  function pick(a) { return a[ri(a.length)]; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function sgn(n) { return n < 0 ? -1 : n > 0 ? 1 : 0; }
  function key(x, y) { return y * MW + x; }

  // =========================================================================
  //  content tables
  // =========================================================================
  var WEAPONS = {
    fist:    { id: 'fist',    name: 'Bare Fists',     atk: 0,  icon: '👊', slot: 'weapon', tier: 0 },
    dagger:  { id: 'dagger',  name: 'Rusty Dagger',   atk: 2,  icon: '🗡️', slot: 'weapon', tier: 1, price: 30 },
    sword:   { id: 'sword',   name: 'Iron Sword',     atk: 4,  icon: '⚔️', slot: 'weapon', tier: 2, price: 90 },
    mace:    { id: 'mace',    name: 'Spiked Mace',    atk: 6,  icon: '🔨', slot: 'weapon', tier: 3, price: 200, stun: 0.18 },
    axe:     { id: 'axe',     name: 'Great Axe',      atk: 9,  icon: '🪓', slot: 'weapon', tier: 4, price: 420, crit: 0.12 },
    staff:   { id: 'staff',   name: 'Arcane Staff',   atk: 5,  icon: '🪄', slot: 'weapon', tier: 3, price: 260, mp: 10 },
    runeblade:{id: 'runeblade',name:'Runeblade',      atk: 13, icon: '🗡️', slot: 'weapon', tier: 5, price: 900, crit: 0.18 }
  };
  var ARMORS = {
    rags:    { id: 'rags',    name: 'Tattered Rags',  def: 0,  icon: '🧥', slot: 'armor', tier: 0 },
    leather: { id: 'leather', name: 'Leather Armor',  def: 2,  icon: '🦺', slot: 'armor', tier: 1, price: 40 },
    chain:   { id: 'chain',   name: 'Chain Mail',     def: 4,  icon: '⛓️', slot: 'armor', tier: 2, price: 120 },
    plate:   { id: 'plate',   name: 'Plate Armor',    def: 7,  icon: '🛡️', slot: 'armor', tier: 3, price: 300, hp: 10 },
    aegis:   { id: 'aegis',   name: 'Aegis Plate',    def: 11, icon: '🛡️', slot: 'armor', tier: 5, price: 820, hp: 25 }
  };
  var TRINKETS = {
    none:    { id: 'none',    name: '— none —',       icon: '·',  slot: 'trinket', tier: 0 },
    ringreg: { id: 'ringreg', name: 'Ring of Regen',  icon: '💍', slot: 'trinket', tier: 2, price: 150, regen: 1 },
    ampmana: { id: 'ampmana', name: 'Mana Amulet',    icon: '📿', slot: 'trinket', tier: 2, price: 150, mp: 20 },
    bandpow: { id: 'bandpow', name: 'Power Band',     icon: '⭕', slot: 'trinket', tier: 3, price: 240, atk: 3 },
    wardchm: { id: 'wardchm', name: 'Warding Charm',  icon: '🔮', slot: 'trinket', tier: 3, price: 240, def: 3 },
    greed:   { id: 'greed',   name: 'Greed Coin',     icon: '🪙', slot: 'trinket', tier: 3, price: 300, greed: 0.5 }
  };
  function gear(id) { return WEAPONS[id] || ARMORS[id] || TRINKETS[id] || null; }

  // consumables — kept as { id, qty } stacks in hero.bag
  var CONS = {
    potion: { id: 'potion', name: 'Health Potion', icon: '🧪', price: 25, desc: 'Restore 45 HP' },
    elixir: { id: 'elixir', name: 'Mana Elixir',   icon: '⚗️', price: 25, desc: 'Restore 30 MP' },
    bomb:   { id: 'bomb',   name: 'Bomb',          icon: '💣', price: 40, desc: 'Blast 1-tile radius (dmg + cracks walls)' },
    scroll: { id: 'scroll', name: 'Blink Scroll',  icon: '📜', price: 35, desc: 'Teleport to a random explored tile' },
    key:    { id: 'key',    name: 'Skeleton Key',  icon: '🗝️', price: 60, desc: 'Opens one locked door' }
  };

  // abilities — directional/self, cost MP, have cooldowns; unlock by level
  var ABIL = {
    strike: { id: 'strike', name: 'Power Strike', icon: '💥', lvl: 1, mp: 4, cd: 1, kind: 'melee',
              desc: 'Heavy adjacent hit (×2.2 ATK), may stun.' },
    bolt:   { id: 'bolt',   name: 'Firebolt',     icon: '🔥', lvl: 3, mp: 6, cd: 2, kind: 'ray', range: 6,
              desc: 'Fires along your facing; burns the first foe hit.' },
    mend:   { id: 'mend',   name: 'Mend',         icon: '✨', lvl: 4, mp: 8, cd: 4, kind: 'self',
              desc: 'Heal 35% of max HP.' },
    blink:  { id: 'blink',  name: 'Blink',        icon: '🌀', lvl: 6, mp: 5, cd: 3, kind: 'move', range: 4,
              desc: 'Dash up to 4 tiles ahead, slipping past danger.' },
    quake:  { id: 'quake',  name: 'Quake',        icon: '🌋', lvl: 8, mp: 12, cd: 5, kind: 'aoe', range: 2,
              desc: 'Shake the earth — damage + stun all foes nearby.' }
  };
  var ABIL_ORDER = ['strike', 'bolt', 'mend', 'blink', 'quake'];

  // enemies. behavior: chase | archer | bomber | thief | summon. minD = first floor it appears.
  var MOBS = {
    rat:    { ch: 'r', name: 'rat',          col: '#c98b6b', hp: 5,  atk: 2,  def: 0, xp: 3,  minD: 1, behavior: 'chase' },
    bat:    { ch: 'b', name: 'cave bat',     col: '#9a86c0', hp: 6,  atk: 2,  def: 0, xp: 4,  minD: 1, behavior: 'chase', erratic: 0.4 },
    kobold: { ch: 'k', name: 'kobold',       col: '#d0b45a', hp: 9,  atk: 3,  def: 0, xp: 6,  minD: 1, behavior: 'chase' },
    archer: { ch: 'a', name: 'skeleton archer', col: '#cdd3da', hp: 8, atk: 4, def: 0, xp: 9, minD: 3, behavior: 'archer', range: 5 },
    goblin: { ch: 'g', name: 'goblin',       col: '#7fae5b', hp: 14, atk: 4,  def: 1, xp: 10, minD: 2, behavior: 'chase' },
    slime:  { ch: 's', name: 'bloat slime',  col: '#5fc08e', hp: 12, atk: 3,  def: 0, xp: 11, minD: 3, behavior: 'bomber', boom: 8 },
    thief:  { ch: 't', name: 'cutpurse',     col: '#d98cc0', hp: 11, atk: 3,  def: 0, xp: 12, minD: 4, behavior: 'thief' },
    orc:    { ch: 'o', name: 'orc',          col: '#9b7fd8', hp: 22, atk: 6,  def: 2, xp: 16, minD: 5, behavior: 'chase' },
    mage:   { ch: 'm', name: 'dark cultist', col: '#e07fb0', hp: 16, atk: 5,  def: 0, xp: 18, minD: 6, behavior: 'archer', range: 6, burn: true },
    troll:  { ch: 'T', name: 'troll',        col: '#e85d5d', hp: 36, atk: 9,  def: 3, xp: 28, minD: 7, behavior: 'chase', regen: 2 },
    wraith: { ch: 'w', name: 'wraith',       col: '#9fd8e0', hp: 30, atk: 8,  def: 2, xp: 30, minD: 9, behavior: 'chase', erratic: 0.2 }
  };
  var BOSSES = [
    { ch: 'K', name: 'Bone King',        col: '#f0e6c0', hp: 90,  atk: 8,  def: 3, xp: 120, behavior: 'summon', summons: 'archer' },
    { ch: 'H', name: 'Hollow Warden',    col: '#e0a060', hp: 160, atk: 12, def: 5, xp: 220, behavior: 'chase', boom: 0 },
    { ch: 'V', name: 'Venom Matriarch',  col: '#7fe0a0', hp: 220, atk: 14, def: 5, xp: 340, behavior: 'archer', range: 7, poison: true },
    { ch: 'Ω', name: 'The Deep One',     col: '#c08fe0', hp: 320, atk: 18, def: 7, xp: 500, behavior: 'summon', summons: 'wraith' }
  ];

  var BIOMES = [
    { name: 'Catacombs', floor: '#23201c', floor2: '#2a261f', wall: '#4a4038', wallTop: '#5a4e44', accent: '#c9a86b' },
    { name: 'Flooded Caverns', floor: '#1a2226', floor2: '#1f2a30', wall: '#33474d', wallTop: '#3f5860', accent: '#5fc0d0' },
    { name: 'The Foundry', floor: '#241c18', floor2: '#2c211b', wall: '#4a342a', wallTop: '#5e4232', accent: '#e08040' },
    { name: 'The Abyss', floor: '#1c182a', floor2: '#231d33', wall: '#352c50', wallTop: '#443862', accent: '#a87fe0' }
  ];
  function biomeFor(depth) {
    if (depth <= 0) return { name: 'Hearthhold (Town)', floor: '#262a22', floor2: '#2c3027', wall: '#3a4030', wallTop: '#48503c', accent: '#8fbf6f' };
    return BIOMES[Math.floor((depth - 1) / 4) % BIOMES.length];
  }

  // =========================================================================
  //  the hero (persistent character)
  // =========================================================================
  function freshHero() {
    return {
      v: 2,
      name: 'Delver',
      level: 1, xp: 0,
      maxHp: 30, hp: 30, maxMp: 12, mp: 12,
      atk: 4, def: 0, crit: 0.05,
      gold: 0,
      depth: 0, maxDepth: 0,        // current location depth (0 = town), and deepest reached
      equip: { weapon: 'dagger', armor: 'rags', trinket: 'none' },
      bag: { potion: 2, elixir: 1, bomb: 0, scroll: 0, key: 0 },
      owned: ['dagger', 'rags'],   // gear ids in possession (equip swaps among these)
      stats: { kills: 0, deaths: 0, floors: 0, gems: 0, runs: 0 },
      createdAt: Date.now(), updatedAt: Date.now(), rev: 1, client: clientId
    };
  }
  function xpForLevel(l) { return 16 + (l - 1) * (l - 1) * 9 + (l - 1) * 14; }

  // derived stats from base + equipment
  function eqVal(slot, field) { var g = gear(hero.equip[slot]); return (g && g[field]) || 0; }
  function atkOf() { return hero.atk + eqVal('weapon', 'atk') + eqVal('trinket', 'atk'); }
  function defOf() { return hero.def + eqVal('armor', 'def') + eqVal('trinket', 'def'); }
  function critOf() { return clamp(hero.crit + eqVal('weapon', 'crit'), 0, 0.75); }
  function maxHpOf() { return hero.maxHp + eqVal('armor', 'hp'); }
  function maxMpOf() { return hero.maxMp + eqVal('weapon', 'mp') + eqVal('trinket', 'mp'); }
  function regenOf() { return eqVal('trinket', 'regen'); }
  function greedOf() { return 1 + eqVal('trinket', 'greed'); }
  function unlockedAbilities() { return ABIL_ORDER.filter(function (id) { return hero.level >= ABIL[id].lvl; }); }

  function gainXp(n) {
    hero.xp += n;
    while (hero.xp >= xpForLevel(hero.level)) {
      hero.xp -= xpForLevel(hero.level);
      hero.level++;
      hero.maxHp += 7; hero.maxMp += 3; hero.atk += 2;
      if (hero.level % 3 === 0) { hero.def += 1; }
      if (hero.level % 4 === 0) { hero.crit = clamp(hero.crit + 0.02, 0, 0.4); }
      hero.hp = maxHpOf(); hero.mp = maxMpOf();
      logMsg('up', 'Level ' + hero.level + '! You feel stronger.');
      var newly = ABIL_ORDER.filter(function (id) { return ABIL[id].lvl === hero.level; });
      if (newly.length) { logMsg('up', 'Learned ' + ABIL[newly[0]].name + '!'); buildAbilityBar(); }
      fxBurst(world && world.player ? world.player.x : 0, world && world.player ? world.player.y : 0, '#ffe28a');
    }
    markDirty();
  }

  // =========================================================================
  //  message log
  // =========================================================================
  function logMsg(kind, text) {
    if (!world) return;
    world.log.push({ t: text, k: kind || '' });
    if (world.log.length > 30) world.log.shift();
    world._logDirty = true;
  }

  // =========================================================================
  //  floating combat text / particles / shake
  // =========================================================================
  function fxText(x, y, text, color) {
    if (!world) return;
    world.fx.push({ kind: 'text', x: x, y: y, text: text, color: color || '#fff', life: 1, vy: -0.9, born: now() });
  }
  function fxBurst(x, y, color) {
    if (!world) return;
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI * 2 * i) / 8 + Math.random();
      world.fx.push({ kind: 'spark', x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 2.4, color: color, life: 1, born: now() });
    }
  }
  function fxRay(x0, y0, x1, y1, color) {
    if (!world) return;
    world.fx.push({ kind: 'ray', x0: x0, y0: y0, x1: x1, y1: y1, color: color, life: 1, born: now() });
  }
  function shake(amt) { if (world) world.shake = Math.max(world.shake || 0, amt); }

  // =========================================================================
  //  dungeon generation
  // =========================================================================
  function blankMap() {
    var m = new Array(MH);
    for (var y = 0; y < MH; y++) { m[y] = new Array(MW).fill(T_WALL); }
    return m;
  }
  function carve(m, x, y) { if (x > 0 && x < MW - 1 && y > 0 && y < MH - 1) m[y][x] = T_FLOOR; }
  function carveRoom(m, r) { for (var y = r.y; y < r.y + r.h; y++) for (var x = r.x; x < r.x + r.w; x++) carve(m, x, y); }
  function center(r) { return { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) }; }
  function corridor(m, a, b) {
    var x = a.x, y = a.y;
    if (ri(2)) { while (x !== b.x) { carve(m, x, y); x += sgn(b.x - x); } while (y !== b.y) { carve(m, x, y); y += sgn(b.y - y); } }
    else { while (y !== b.y) { carve(m, x, y); y += sgn(b.y - y); } while (x !== b.x) { carve(m, x, y); x += sgn(b.x - x); } }
    carve(m, b.x, b.y);
  }

  function genRooms(m) {
    var rooms = [], tries = 0;
    while (rooms.length < 9 && tries++ < 160) {
      var w = rr(5, 9), h = rr(4, 7);
      var x = rr(1, MW - w - 2), y = rr(1, MH - h - 2);
      var nr = { x: x, y: y, w: w, h: h }, ok = true;
      for (var i = 0; i < rooms.length; i++) {
        var o = rooms[i];
        if (x - 1 < o.x + o.w && x + w + 1 > o.x && y - 1 < o.y + o.h && y + h + 1 > o.y) { ok = false; break; }
      }
      if (ok) { carveRoom(m, nr); rooms.push(nr); }
    }
    // connect sequentially (guarantees full connectivity) + a couple of loops
    for (var k = 1; k < rooms.length; k++) corridor(m, center(rooms[k - 1]), center(rooms[k]));
    for (var l = 0; l < 2 && rooms.length > 3; l++) corridor(m, center(pick(rooms)), center(pick(rooms)));
    return rooms;
  }

  // flood fill of reachable floor from (sx,sy), treating `block` cell as wall.
  function flood(m, sx, sy, blockX, blockY) {
    var seen = {}, stack = [[sx, sy]], reach = [];
    seen[key(sx, sy)] = 1;
    while (stack.length) {
      var c = stack.pop(), cx = c[0], cy = c[1];
      reach.push(c);
      var nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (var i = 0; i < 4; i++) {
        var nx = nb[i][0], ny = nb[i][1];
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
        if (nx === blockX && ny === blockY) continue;
        if (m[ny][nx] !== T_FLOOR) continue;
        var kk = key(nx, ny);
        if (seen[kk]) continue;
        seen[kk] = 1; stack.push([nx, ny]);
      }
    }
    return { seen: seen, reach: reach };
  }

  // find a 1-wide corridor cell whose removal disconnects the stairs from the
  // player (a cut vertex) — used to place a solvable gate/door before the stairs.
  function findSeparator(m, px, py, sx, sy) {
    var cands = [];
    for (var y = 1; y < MH - 1; y++) for (var x = 1; x < MW - 1; x++) {
      if (m[y][x] !== T_FLOOR) continue;
      if (x === px && y === py) continue; if (x === sx && y === sy) continue;
      var horiz = m[y][x - 1] === T_FLOOR && m[y][x + 1] === T_FLOOR && m[y - 1][x] !== T_FLOOR && m[y + 1][x] !== T_FLOOR;
      var vert = m[y - 1][x] === T_FLOOR && m[y + 1][x] === T_FLOOR && m[y][x - 1] !== T_FLOOR && m[y][x + 1] !== T_FLOOR;
      if (horiz || vert) cands.push([x, y]);
    }
    // shuffle and test
    for (var i = cands.length - 1; i > 0; i--) { var j = ri(i + 1); var t = cands[i]; cands[i] = cands[j]; cands[j] = t; }
    for (var c = 0; c < cands.length; c++) {
      var cx = cands[c][0], cy = cands[c][1];
      var f = flood(m, px, py, cx, cy);
      if (!f.seen[key(sx, sy)]) return { gx: cx, gy: cy, near: f.reach }; // player-side cells
    }
    return null;
  }

  function freeFloorIn(m, taken, region) {
    for (var t = 0; t < 60; t++) {
      var c = region ? pick(region) : [rr(1, MW - 2), rr(1, MH - 2)];
      var x = c[0], y = c[1];
      if (m[y] && m[y][x] === T_FLOOR && !taken(x, y)) return { x: x, y: y };
    }
    return null;
  }

  function genFloor(depth) {
    var m = blankMap();
    var rooms = genRooms(m);
    if (rooms.length < 2) { return genFloor(depth); } // pathological; retry
    var biome = biomeFor(depth);
    var objects = [], monsters = [], items = [];
    var occupied = function (x, y) {
      if (world && world.player && world.player.x === x && world.player.y === y) return true;
      for (var i = 0; i < monsters.length; i++) if (monsters[i].x === x && monsters[i].y === y) return true;
      for (var j = 0; j < items.length; j++) if (items[j].x === x && items[j].y === y) return true;
      for (var o = 0; o < objects.length; o++) if (objects[o].x === x && objects[o].y === y) return true;
      return false;
    };

    var start = center(rooms[0]);
    var stairsRoom = rooms[rooms.length - 1];
    var st = center(stairsRoom);
    // make sure stairs tile is floor & distinct from start
    var stairs = { x: st.x, y: st.y, up: false };

    var isBoss = depth > 0 && depth % 5 === 0;

    // ---- optional boulder vault (carves corridors; do this BEFORE the
    //      separator search so the gate is a true cut of the final topology) --
    if (!isBoss && chance(0.4)) placeBoulderVault(m, start, objects, occupied);

    // ---- puzzle gate before the stairs (lever or key) -----------------------
    var puzzle = null;
    if (!isBoss && depth >= 2 && chance(0.62)) {
      var sep = findSeparator(m, start.x, start.y, stairs.x, stairs.y);
      if (sep) {
        if (chance(0.5)) {
          // lever gate
          objects.push({ type: 'gate', x: sep.gx, y: sep.gy, link: 1, open: false });
          var lp = freeFloorIn(m, occupied, sep.near);
          if (lp) { objects.push({ type: 'lever', x: lp.x, y: lp.y, link: 1, on: false });
                    puzzle = { kind: 'lever' }; }
        } else {
          // locked door + key
          objects.push({ type: 'door', x: sep.gx, y: sep.gy, locked: true });
          var kp = freeFloorIn(m, occupied, sep.near);
          if (kp) { items.push({ type: 'cons', id: 'key', x: kp.x, y: kp.y });
                    puzzle = { kind: 'key' }; }
        }
      }
    }

    // ---- spike traps --------------------------------------------------------
    var trapN = isBoss ? 0 : ri(3 + Math.floor(depth / 3));
    for (var tr = 0; tr < trapN; tr++) {
      var tp = freeFloorIn(m, occupied);
      if (tp) objects.push({ type: 'trap', x: tp.x, y: tp.y, phase: ri(4), armed: true });
    }

    // ---- teleporter pair ----------------------------------------------------
    if (!isBoss && chance(0.3)) {
      var pa = freeFloorIn(m, occupied), pb = freeFloorIn(m, occupied);
      if (pa && pb && (pa.x !== pb.x || pa.y !== pb.y)) {
        objects.push({ type: 'tele', x: pa.x, y: pa.y, tox: pb.x, toy: pb.y });
        objects.push({ type: 'tele', x: pb.x, y: pb.y, tox: pa.x, toy: pa.y });
      }
    }

    // ---- chests -------------------------------------------------------------
    var chestN = isBoss ? 1 : 1 + ri(2);
    for (var ch = 0; ch < chestN; ch++) {
      var cp = freeFloorIn(m, occupied);
      if (cp) objects.push({ type: 'chest', x: cp.x, y: cp.y, opened: false });
    }

    // ---- monsters -----------------------------------------------------------
    if (isBoss) {
      var bdef = BOSSES[Math.min(BOSSES.length - 1, Math.floor(depth / 5) - 1)];
      var scale = 1 + (Math.floor(depth / 5) - 1) * 0.5;
      monsters.push(makeMob(bdef, st.x, st.y, true, scale, depth));
      // a couple of guards
      for (var bg = 0; bg < 2; bg++) { var gp = freeFloorIn(m, occupied, null); if (gp) monsters.push(makeMob(MOBS.goblin, gp.x, gp.y, false, 1 + depth * 0.06, depth)); }
    } else {
      var avail = Object.keys(MOBS).filter(function (id) { return MOBS[id].minD <= depth; });
      var mcount = 4 + Math.floor(depth * 1.3);
      for (var mi = 0; mi < mcount; mi++) {
        var sp = freeFloorIn(m, occupied);
        if (!sp) continue;
        // bias toward tougher mobs deeper
        var idp = avail[clamp(ri(avail.length) + (chance(0.3) ? 1 : 0), 0, avail.length - 1)];
        monsters.push(makeMob(MOBS[idp], sp.x, sp.y, false, 1 + depth * 0.05, depth));
      }
    }

    // ---- loot items ---------------------------------------------------------
    var potN = 2 + ri(2);
    for (var pi = 0; pi < potN; pi++) { var s1 = freeFloorIn(m, occupied); if (s1) items.push({ type: 'cons', id: chance(0.7) ? 'potion' : 'elixir', x: s1.x, y: s1.y }); }
    var goldN = 3 + ri(4);
    for (var gi = 0; gi < goldN; gi++) { var s2 = freeFloorIn(m, occupied); if (s2) items.push({ type: 'gold', x: s2.x, y: s2.y, amt: (4 + ri(8)) * Math.max(1, depth) }); }
    if (chance(0.45)) { var s3 = freeFloorIn(m, occupied); if (s3) items.push({ type: 'gem', x: s3.x, y: s3.y }); }
    // occasional gear drop on the floor
    if (chance(0.35)) { var s4 = freeFloorIn(m, occupied); if (s4) items.push({ type: 'gear', id: randomGearId(depth), x: s4.x, y: s4.y }); }

    // a few cracked walls (bombable → secret loot pockets)
    var crackN = ri(4);
    for (var cwi = 0; cwi < crackN; cwi++) { var wx = rr(2, MW - 3), wy = rr(2, MH - 3); if (m[wy][wx] === T_WALL) m[wy][wx] = T_CRACK; }

    return {
      depth: depth, biome: biome, isBoss: isBoss, puzzle: puzzle,
      map: m, rooms: rooms, objects: objects, monsters: monsters, items: items,
      stairs: stairs, start: start,
      explored: mkBoolGrid(), visible: mkBoolGrid(),
      fx: [], proj: [], log: [], shake: 0, steps: 0, mode: 'dungeon',
      player: null, path: null, pathT: 0, _logDirty: true
    };
  }

  function mkBoolGrid() { var g = new Array(MH); for (var y = 0; y < MH; y++) g[y] = new Array(MW).fill(false); return g; }

  function makeMob(def, x, y, boss, scale, depth) {
    scale = scale || 1;
    return {
      x: x, y: y, rx: x, ry: y, ch: def.ch, name: def.name, col: def.col,
      hp: Math.round(def.hp * scale), maxHp: Math.round(def.hp * scale),
      atk: Math.round(def.atk * (boss ? scale : Math.min(scale, 1 + depth * 0.04))), def: def.def || 0,
      xp: Math.round(def.xp * (boss ? 1 : scale)), behavior: def.behavior, range: def.range || 1,
      erratic: def.erratic || 0, boom: def.boom || 0, regen: def.regen || 0,
      summons: def.summons || null, burn: !!def.burn, poison: !!def.poison,
      boss: !!boss, status: {}, awake: false, hit: 0, bump: 0
    };
  }

  function randomGearId(depth) {
    var pool = [];
    function add(tbl) { for (var id in tbl) { var g = tbl[id]; if (g.tier > 0 && g.tier <= 1 + Math.ceil(depth / 2)) pool.push(id); } }
    add(WEAPONS); add(ARMORS); add(TRINKETS);
    return pool.length ? pick(pool) : 'dagger';
  }

  // A hand-laid, guaranteed-solvable boulder vault carved into solid rock and
  // wired back to the dungeon with a corridor. Layout (relative to x,y):
  //   row0:  . . . G C      open area = cols0-2 rows0-3 (all floor)
  //   row1:  . B . # #      B boulder@(1,1)  P plate@(2,2)
  //   row2:  . . P # #      G gate@(3,0) seals chest C@(4,0)
  //   row3:  . . . # #
  // Solution: push B right then down onto P → plate holds gate open →
  // walk row0 to the chest. The boulder on P never blocks that row.
  function placeBoulderVault(m, start, objects, occupied) {
    for (var attempt = 0; attempt < 50; attempt++) {
      var x = rr(2, MW - 7), y = rr(2, MH - 6);
      // require the whole footprint to currently be solid rock (a true secret)
      var solid = true;
      for (var r = 0; r <= 3 && solid; r++) for (var c = 0; c <= 4; c++) {
        if (r > 0 && c >= 3) continue;            // those cells stay as wall
        if (m[y + r][x + c] !== T_WALL) { solid = false; break; }
      }
      if (!solid) continue;
      // carve the open area (cols0-2, rows0-3) + gate cell + chest cell
      for (var rr2 = 0; rr2 <= 3; rr2++) for (var cc = 0; cc <= 2; cc++) carve(m, x + cc, y + rr2);
      carve(m, x + 3, y); carve(m, x + 4, y);
      // connect the far (bottom-left) corner back to the dungeon
      corridor(m, { x: x, y: y + 3 }, start);
      if (occupied(x + 1, y + 1) || occupied(x + 2, y + 2) || occupied(x + 3, y) || occupied(x + 4, y)) continue;
      objects.push({ type: 'boulder', x: x + 1, y: y + 1 });
      objects.push({ type: 'plate', x: x + 2, y: y + 2, link: 99, pressed: false });
      objects.push({ type: 'gate', x: x + 3, y: y, link: 99, open: false });
      objects.push({ type: 'chest', x: x + 4, y: y, opened: false, lush: true });
      return true;
    }
    return false;
  }

  // =========================================================================
  //  town hub
  // =========================================================================
  function genTown() {
    var m = blankMap();
    var room = { x: 6, y: 8, w: 30, h: 18 };
    carveRoom(m, room);
    var objects = [], monsters = [], items = [];
    var cx = Math.floor(MW / 2), cy = Math.floor(MH / 2);
    objects.push({ type: 'npc', role: 'healer',   x: 11, y: 12, icon: '⛑️', col: '#ff8a8a', name: 'Healer' });
    objects.push({ type: 'npc', role: 'merchant', x: 20, y: 11, icon: '🛒', col: '#ffd76a', name: 'Merchant' });
    objects.push({ type: 'npc', role: 'smith',    x: 29, y: 12, icon: '⚒️', col: '#a0c0ff', name: 'Smith' });
    objects.push({ type: 'stairs', x: 20, y: 22, down: true });
    var stairs = { x: 20, y: 22, up: false };
    var start = { x: 20, y: 17 };
    return {
      depth: 0, biome: biomeFor(0), isBoss: false, puzzle: null,
      map: m, rooms: [room], objects: objects, monsters: monsters, items: items,
      stairs: stairs, start: start,
      explored: mkBoolGrid(), visible: mkBoolGrid(),
      fx: [], proj: [], log: [], shake: 0, steps: 0, mode: 'town',
      player: null, path: null, pathT: 0, _logDirty: true
    };
  }

  // =========================================================================
  //  enter a floor / town
  // =========================================================================
  function enter(depth) {
    var w = depth <= 0 ? genTown() : genFloor(depth);
    var spawn = w.start;
    w.player = { x: spawn.x, y: spawn.y, rx: spawn.x, ry: spawn.y, dir: { x: 0, y: 1 }, hit: 0, bump: 0 };
    world = w;
    hero.depth = depth;
    hero.status = {};                       // clear DoTs between areas
    if (depth > hero.maxDepth) { hero.maxDepth = depth; }
    // wake in town with half vitals if we arrived dead
    if (depth <= 0 && hero.hp <= 0) { hero.hp = Math.ceil(maxHpOf() * 0.5); hero.mp = Math.ceil(maxMpOf() * 0.5); }
    // ensure hp/mp within caps
    hero.hp = clamp(hero.hp, 0, maxHpOf()); hero.mp = clamp(hero.mp, 0, maxMpOf());
    computeFov();
    if (depth <= 0) { logMsg('', 'Hearthhold. Rest, shop, then descend ▾.'); }
    else {
      hero.stats.floors++;
      logMsg('', (w.isBoss ? '⚠ ' : '') + w.biome.name + ' — Floor ' + depth + (w.isBoss ? '. A boss stirs.' : '.'));
      if (w.puzzle) logMsg('', w.puzzle.kind === 'lever' ? 'The stairs are barred. Find the lever.' : 'A locked door blocks the way. Find the key.');
    }
    markDirty();
    refreshAll();
  }

  function descend() {
    var d = hero.depth + 1;
    logMsg('', 'You descend…');
    enter(d);
  }

  function startNewRun() {
    // dive straight to the deepest floor reached (QoL); first run starts at 1
    hero.stats.runs = (hero.stats.runs || 0) + 1;
    enter(Math.max(1, hero.maxDepth));
  }

  // =========================================================================
  //  field of view (LOS-limited torch)
  // =========================================================================
  function blocksSight(x, y) { return !world.map[y] || world.map[y][x] !== T_FLOOR; }
  function losClear(x0, y0, x1, y1) {
    // Bresenham; the endpoint may be a wall (visible) but anything past a wall is blocked
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    var x = x0, y = y0;
    while (true) {
      if (x === x1 && y === y1) return true;
      if (!(x === x0 && y === y0) && blocksSight(x, y)) return false;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  function computeFov() {
    var p = world.player, vis = world.visible, exp = world.explored;
    for (var y = 0; y < MH; y++) for (var x = 0; x < MW; x++) vis[y][x] = false;
    var R = world.mode === 'town' ? 99 : LIGHT;
    var x0 = Math.max(0, p.x - R), x1 = Math.min(MW - 1, p.x + R);
    var y0 = Math.max(0, p.y - R), y1 = Math.min(MH - 1, p.y + R);
    for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) {
      if (cheb(p.x, p.y, xx, yy) > R) continue;
      if (world.mode === 'town' || losClear(p.x, p.y, xx, yy)) { vis[yy][xx] = true; exp[yy][xx] = true; }
    }
  }

  // =========================================================================
  //  passability / object lookup
  // =========================================================================
  function objAt(x, y, type) {
    for (var i = 0; i < world.objects.length; i++) { var o = world.objects[i]; if (o.x === x && o.y === y && (!type || o.type === type)) return o; }
    return null;
  }
  function gateClosedAt(x, y) {
    for (var i = 0; i < world.objects.length; i++) { var o = world.objects[i]; if (o.x === x && o.y === y) {
      if (o.type === 'gate' && !o.open) return true;
      if (o.type === 'door' && o.locked) return true;
      if (o.type === 'boulder') return true;
    } }
    return false;
  }
  function mobAt(x, y) { for (var i = 0; i < world.monsters.length; i++) if (world.monsters[i].x === x && world.monsters[i].y === y) return world.monsters[i]; return null; }
  function walkable(x, y) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) return false;
    if (world.map[y][x] !== T_FLOOR) return false;
    if (gateClosedAt(x, y)) return false;
    return true;
  }

  // =========================================================================
  //  combat
  // =========================================================================
  function applyStatus(target, kind, turns) {
    target.status = target.status || {};
    target.status[kind] = Math.max(target.status[kind] || 0, turns);
  }
  function damageMob(m, dmg, kind, color) {
    m.hp -= dmg; m.hit = now();
    fxText(m.x, m.y, '-' + dmg, color || '#ffd2d2');
    if (m.hp <= 0) killMob(m, kind);
  }
  function killMob(m, kind) {
    var idx = world.monsters.indexOf(m); if (idx < 0) return;
    world.monsters.splice(idx, 1);
    hero.stats.kills++;
    fxBurst(m.x, m.y, m.col);
    gainXp(m.xp);
    if (m.boss) { logMsg('win', 'The ' + m.name + ' falls! The way down opens.'); shake(10);
      // boss drops: gold + guaranteed gear + gem
      world.items.push({ type: 'gold', x: m.x, y: m.y, amt: 60 + world.depth * 12 });
      var gp = adjacentFree(m.x, m.y); if (gp) world.items.push({ type: 'gear', id: randomGearId(world.depth + 3), x: gp.x, y: gp.y });
      hero.stats.gems++;
    } else {
      // bomber explodes on death
      if (m.boom) explodeAt(m.x, m.y, m.boom, '#5fc08e');
      if (chance(0.18)) world.items.push({ type: 'cons', id: chance(0.6) ? 'potion' : 'elixir', x: m.x, y: m.y });
      if (chance(0.5)) world.items.push({ type: 'gold', x: m.x, y: m.y, amt: (3 + ri(6)) * Math.max(1, world.depth) });
    }
    markDirty();
  }
  function adjacentFree(x, y) {
    var nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (var i = 0; i < nb.length; i++) if (walkable(nb[i][0], nb[i][1]) && !mobAt(nb[i][0], nb[i][1])) return { x: nb[i][0], y: nb[i][1] };
    return null;
  }
  function heroAttack(m, mult, extraStun) {
    var base = Math.max(1, Math.round(atkOf() * (mult || 1)) - m.def + rr(-1, 2));
    var crit = chance(critOf());
    if (crit) base = Math.round(base * 1.8);
    damageMob(m, base, 'melee', crit ? '#ffec80' : '#ffd2d2');
    if (crit) fxText(m.x, m.y - 0.3, 'CRIT!', '#ffec80');
    var st = eqVal('weapon', 'stun') + (extraStun || 0);
    if (st && chance(st)) { applyStatus(m, 'stun', 2); fxText(m.x, m.y, 'stun', '#9fd8ff'); }
    shake(crit ? 5 : 2);
  }
  function hurtHero(dmg, srcName) {
    dmg = Math.max(1, dmg - Math.floor(defOf() * 0.6));
    hero.hp -= dmg; world.player.hit = now();
    fxText(world.player.x, world.player.y, '-' + dmg, '#ff9a9a');
    shake(3);
    if (hero.hp <= 0) die();
    markDirty();
  }
  function explodeAt(x, y, dmg, color) {
    shake(7); fxBurst(x, y, color || '#ffb060');
    for (var yy = y - 1; yy <= y + 1; yy++) for (var xx = x - 1; xx <= x + 1; xx++) {
      if (xx < 0 || yy < 0 || xx >= MW || yy >= MH) continue;
      fxBurst(xx, yy, color || '#ffb060');
      // crack walls
      if (world.map[yy][xx] === T_CRACK) { world.map[yy][xx] = T_FLOOR; logMsg('', 'The cracked wall crumbles!'); maybeSecretLoot(xx, yy); }
      var mm = mobAt(xx, yy); if (mm) damageMob(mm, dmg, 'blast', '#ffd0a0');
      if (world.player.x === xx && world.player.y === yy && !(xx === x && yy === y)) hurtHero(Math.floor(dmg * 0.6), 'blast');
    }
    computeFov();
  }
  function maybeSecretLoot(x, y) {
    if (chance(0.5)) world.items.push({ type: 'gold', x: x, y: y, amt: (8 + ri(10)) * Math.max(1, world.depth) });
    else world.items.push({ type: 'cons', id: 'potion', x: x, y: y });
  }

  function die() {
    hero.stats.deaths++;
    var lost = Math.floor(hero.gold * 0.35);
    hero.gold -= lost;
    world.mode = 'dead';
    world._deathLost = lost;
    logMsg('die', 'You fall on floor ' + world.depth + '. You lose ' + lost + ' gold.');
    saveNow();
  }

  // =========================================================================
  //  player actions
  // =========================================================================
  function playerActive() { return world && world.mode !== 'dead' && !document.getElementById('cr-overlay'); }

  function tryMove(dx, dy) {
    if (!playerActive()) return false;
    var p = world.player;
    if (dx === 0 && dy === 0) { return rest(); }
    p.dir = { x: dx, y: dy };
    var nx = p.x + dx, ny = p.y + dy;
    if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) return false;
    // attack monster?
    var m = mobAt(nx, ny);
    if (m) { p.bump = now(); p.bumpDir = { x: dx, y: dy }; heroAttack(m, 1, 0); endTurn(); return true; }
    // push boulder?
    var b = objAt(nx, ny, 'boulder');
    if (b) { if (pushBoulder(b, dx, dy)) { p.x = nx; p.y = ny; afterStep(); endTurn(); return true; } else { return false; } }
    // closed gate / locked door?
    var door = objAt(nx, ny, 'door');
    if (door && door.locked) { tryUnlock(door); return false; }
    if (world.map[ny][nx] !== T_FLOOR) {
      if (world.map[ny][nx] === T_CRACK) { logMsg('', 'A cracked wall. A bomb might breach it.'); }
      return false;
    }
    if (gateClosedAt(nx, ny)) { logMsg('', 'A sealed gate blocks the way.'); return false; }
    p.x = nx; p.y = ny;
    afterStep();
    endTurn();
    return true;
  }

  function pushBoulder(b, dx, dy) {
    var tx = b.x + dx, ty = b.y + dy;
    if (!walkable(tx, ty) || mobAt(tx, ty) || objAt(tx, ty, 'boulder')) {
      // pushing into a monster crushes it; into spikes disarms
      var mm = mobAt(tx, ty);
      if (mm && walkableIgnoreMob(tx, ty)) { damageMob(mm, 999, 'crush', '#cfc0a0'); logMsg('', 'The boulder crushes the ' + mm.name + '!'); b.x = tx; b.y = ty; updatePlates(); return true; }
      return false;
    }
    b.x = tx; b.y = ty;
    var tr = objAt(tx, ty, 'trap'); if (tr) { tr.armed = false; logMsg('', 'The boulder jams the spikes.'); }
    updatePlates();
    return true;
  }
  function walkableIgnoreMob(x, y) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) return false;
    if (world.map[y][x] !== T_FLOOR) return false;
    var o = objAt(x, y); if (o && (o.type === 'boulder' || (o.type === 'gate' && !o.open) || (o.type === 'door' && o.locked))) return false;
    return true;
  }
  function updatePlates() {
    // a plate is pressed if a boulder (or the player) stands on it; linked gates open while pressed
    var pressed = {};
    for (var i = 0; i < world.objects.length; i++) {
      var o = world.objects[i];
      if (o.type === 'plate') {
        var on = !!objAt(o.x, o.y, 'boulder') || (world.player.x === o.x && world.player.y === o.y);
        o.pressed = on;
        if (on) pressed[o.link] = true;
      }
    }
    for (var j = 0; j < world.objects.length; j++) {
      var g = world.objects[j];
      if (g.type === 'gate' && g.plateLinked !== false) {
        // gates linked to plates follow the plate; lever-linked gates ignore this (handled by lever)
        if (hasPlateLink(g.link)) g.open = !!pressed[g.link];
      }
    }
  }
  function hasPlateLink(link) { for (var i = 0; i < world.objects.length; i++) { var o = world.objects[i]; if (o.type === 'plate' && o.link === link) return true; } return false; }

  function tryUnlock(door) {
    if (hero.bag.key > 0) { hero.bag.key--; door.locked = false; logMsg('win', 'You unlock the door.'); fxBurst(door.x, door.y, '#ffd76a'); markDirty(); refreshAll(); }
    else logMsg('', 'Locked. You need a key.');
  }

  function afterStep() {
    var p = world.player;
    updatePlates();
    // pick up items
    for (var i = world.items.length - 1; i >= 0; i--) {
      var it = world.items[i];
      if (it.x === p.x && it.y === p.y) pickup(it, i);
    }
    // town NPC — step on to shop
    if (world.mode === 'town') { var npcHere = objAt(p.x, p.y, 'npc'); if (npcHere) { openShop(npcHere.role); return; } }
    // teleporter
    var tp = objAt(p.x, p.y, 'tele');
    if (tp) { p.x = tp.tox; p.y = tp.toy; p.rx = p.x; p.ry = p.y; fxBurst(p.x, p.y, '#a87fe0'); logMsg('', 'Whoosh — teleported.'); }
    // trap
    var tr = objAt(p.x, p.y, 'trap');
    if (tr && tr.armed && trapHot(tr)) { var d = 4 + world.depth; hurtHero(d, 'spikes'); logMsg('die', 'Spikes! (-' + d + ')'); }
    // stairs — defer the transition so the caller's endTurn doesn't run a turn
    // on the freshly-generated floor.
    if (world.mode === 'town') {
      if (p.x === world.stairs.x && p.y === world.stairs.y) { world._pendingDive = true; }
    } else if (p.x === world.stairs.x && p.y === world.stairs.y) {
      if (world.isBoss && bossAlive()) { logMsg('', 'The boss bars the stairs!'); }
      else world._pendingDescend = true;
    }
  }
  function bossAlive() { for (var i = 0; i < world.monsters.length; i++) if (world.monsters[i].boss) return true; return false; }
  function trapHot(tr) { return ((world.steps + tr.phase) % 4) < 2; } // spikes up half the time

  function pickup(it, idx) {
    if (it.type === 'gold') { var g = Math.round(it.amt * greedOf()); hero.gold += g; logMsg('', '+' + g + ' gold.'); fxText(it.x, it.y, '+' + g, '#ffd76a'); }
    else if (it.type === 'gem') { hero.gold += 50; hero.stats.gems++; logMsg('win', 'A gleaming gem! (+50)'); fxText(it.x, it.y, '💎', '#7fe0d0'); }
    else if (it.type === 'cons') { hero.bag[it.id] = (hero.bag[it.id] || 0) + 1; logMsg('', 'Picked up ' + CONS[it.id].name + '.'); fxText(it.x, it.y, CONS[it.id].icon, '#fff'); }
    else if (it.type === 'gear') { acquireGear(it.id); var gg = gear(it.id); logMsg('win', 'Found ' + (gg ? gg.name : 'gear') + '!'); fxText(it.x, it.y, gg ? gg.icon : '?', '#fff'); }
    world.items.splice(idx, 1);
    markDirty();
  }
  function acquireGear(id) {
    if (hero.owned.indexOf(id) < 0) hero.owned.push(id);
    // auto-equip if strictly better tier in that slot
    var g = gear(id); if (!g) return;
    var cur = gear(hero.equip[g.slot]);
    if (!cur || g.tier > cur.tier) { hero.equip[g.slot] = id; logMsg('win', 'Equipped ' + g.name + '.'); }
  }

  function rest() {
    if (!playerActive()) return false;
    if (hero.hp < maxHpOf() && chance(0.6)) hero.hp = Math.min(maxHpOf(), hero.hp + 1);
    if (hero.mp < maxMpOf() && chance(0.5)) hero.mp = Math.min(maxMpOf(), hero.mp + 1);
    endTurn();
    return true;
  }

  // ---- interact (E / center button): NPCs, chests, levers, stairs ----------
  function interact() {
    if (!playerActive()) return;
    var p = world.player;
    // adjacency includes current tile
    var spots = [[p.x, p.y], [p.x + 1, p.y], [p.x - 1, p.y], [p.x, p.y + 1], [p.x, p.y - 1]];
    for (var s = 0; s < spots.length; s++) {
      var ox = spots[s][0], oy = spots[s][1];
      var npc = objAt(ox, oy, 'npc'); if (npc) { openShop(npc.role); return; }
      var lever = objAt(ox, oy, 'lever'); if (lever) { toggleLever(lever); return; }
      var chest = objAt(ox, oy, 'chest'); if (chest && !chest.opened) { openChest(chest); return; }
      var stair = objAt(ox, oy, 'stairs'); if (stair && stair.down) { startNewRun(); return; }
    }
    // on town stairs tile?
    if (world.mode === 'town' && p.x === world.stairs.x && p.y === world.stairs.y) { startNewRun(); return; }
    rest();
  }
  function toggleLever(l) {
    l.on = !l.on;
    for (var i = 0; i < world.objects.length; i++) { var o = world.objects[i]; if (o.type === 'gate' && o.link === l.link && !hasPlateLink(o.link)) o.open = l.on; }
    logMsg('win', l.on ? 'The lever clunks — a gate grinds open.' : 'The lever resets.');
    fxBurst(l.x, l.y, '#c9a86b'); computeFov(); markDirty(); refreshAll();
  }
  function openChest(c) {
    c.opened = true;
    var rolls = c.lush ? 3 : 1 + ri(2);
    for (var i = 0; i < rolls; i++) {
      var roll = Math.random();
      if (roll < 0.4) { var g = (8 + ri(14)) * Math.max(1, world.depth + 1); hero.gold += Math.round(g * greedOf()); fxText(c.x, c.y - i * 0.3, '+' + g + 'g', '#ffd76a'); }
      else if (roll < 0.7) { var id = chance(0.6) ? 'potion' : (chance(0.5) ? 'elixir' : 'bomb'); hero.bag[id] = (hero.bag[id] || 0) + 1; fxText(c.x, c.y - i * 0.3, CONS[id].icon, '#fff'); }
      else { var gid = randomGearId(world.depth + (c.lush ? 3 : 1)); acquireGear(gid); var gg = gear(gid); fxText(c.x, c.y - i * 0.3, gg ? gg.icon : '?', '#fff'); }
    }
    logMsg('win', 'You open the chest!'); fxBurst(c.x, c.y, '#ffd76a'); markDirty(); refreshAll();
  }

  // ---- consumables ----------------------------------------------------------
  function useItem(id) {
    if (!playerActive()) return;
    if (!hero.bag[id] || hero.bag[id] <= 0) { logMsg('', 'No ' + CONS[id].name + '.'); return; }
    var used = true, p = world.player;
    if (id === 'potion') { var h = Math.min(maxHpOf() - hero.hp, 45); if (h <= 0 && hero.hp >= maxHpOf()) { logMsg('', 'Already at full HP.'); return; } hero.hp = Math.min(maxHpOf(), hero.hp + 45); fxText(p.x, p.y, '+' + Math.max(h, 0) + 'hp', '#9fe0a0'); }
    else if (id === 'elixir') { if (hero.mp >= maxMpOf()) { logMsg('', 'Already at full MP.'); return; } hero.mp = Math.min(maxMpOf(), hero.mp + 30); fxText(p.x, p.y, '+mp', '#9fd0ff'); }
    else if (id === 'bomb') { var d = p.dir; var bx = p.x + d.x, by = p.y + d.y; if (!walkable(bx, by)) { bx = p.x; by = p.y; } explodeAt(bx, by, 14 + world.depth, '#ffb060'); }
    else if (id === 'scroll') { blinkToExplored(); }
    else if (id === 'key') { logMsg('', 'Keys open locked doors — walk into one.'); return; }
    if (used) { hero.bag[id]--; markDirty(); refreshHud(); refreshBars(); if (id !== 'key') endTurn(); }
  }
  function blinkToExplored() {
    var cands = [];
    for (var y = 0; y < MH; y++) for (var x = 0; x < MW; x++) if (world.explored[y][x] && walkable(x, y) && !mobAt(x, y)) cands.push([x, y]);
    if (!cands.length) return;
    var c = pick(cands); var p = world.player; p.x = c[0]; p.y = c[1]; p.rx = p.x; p.ry = p.y;
    fxBurst(p.x, p.y, '#a87fe0'); logMsg('', 'The scroll warps you away.'); computeFov();
  }

  // =========================================================================
  //  abilities
  // =========================================================================
  function ensureCd() { if (!hero._cd) hero._cd = {}; return hero._cd; }
  function useAbility(id) {
    if (!playerActive()) return;
    var ab = ABIL[id]; if (!ab) return;
    if (hero.level < ab.lvl) return;
    var cd = ensureCd();
    if ((cd[id] || 0) > 0) { logMsg('', ab.name + ' on cooldown (' + cd[id] + ').'); return; }
    if (hero.mp < ab.mp) { logMsg('', 'Not enough MP for ' + ab.name + '.'); return; }
    var p = world.player, did = false;
    if (ab.kind === 'melee') {
      var tx = p.x + p.dir.x, ty = p.y + p.dir.y, m = mobAt(tx, ty);
      if (!m) { logMsg('', 'Nothing in front to strike.'); return; }
      p.bump = now(); p.bumpDir = p.dir; heroAttack(m, 2.2, 0.5); fxBurst(tx, ty, '#ffd76a'); did = true;
    } else if (ab.kind === 'ray') {
      did = castRay(ab, '#ff8040', true);
    } else if (ab.kind === 'self') {
      var h = Math.round(maxHpOf() * 0.35); hero.hp = Math.min(maxHpOf(), hero.hp + h); fxText(p.x, p.y, '+' + h, '#9fe0a0'); fxBurst(p.x, p.y, '#9fe0a0'); did = true;
    } else if (ab.kind === 'move') {
      did = doBlink(ab.range);
    } else if (ab.kind === 'aoe') {
      did = doQuake(ab.range);
    }
    if (!did) return;
    hero.mp -= ab.mp; cd[id] = ab.cd + 1;
    markDirty(); refreshBars();
    endTurn();
  }
  function castRay(ab, color, burn) {
    var p = world.player, x = p.x, y = p.y, hitMob = null;
    for (var i = 1; i <= ab.range; i++) {
      x += p.dir.x; y += p.dir.y;
      if (x < 0 || y < 0 || x >= MW || y >= MH || world.map[y][x] !== T_FLOOR) { x -= p.dir.x; y -= p.dir.y; break; }
      var m = mobAt(x, y); if (m) { hitMob = m; break; }
    }
    fxRay(p.x, p.y, x, y, color);
    if (hitMob) { var dmg = Math.round(atkOf() * 1.5) + rr(0, 3); damageMob(hitMob, dmg, 'fire', '#ffb060'); if (burn) applyStatus(hitMob, 'burn', 3); }
    shake(3);
    return true;
  }
  function doBlink(range) {
    var p = world.player, lastX = p.x, lastY = p.y, moved = false;
    for (var i = 1; i <= range; i++) {
      var nx = p.x + p.dir.x * i, ny = p.y + p.dir.y * i;
      if (!walkable(nx, ny) || mobAt(nx, ny)) break;
      lastX = nx; lastY = ny; moved = true;
    }
    if (!moved) { logMsg('', 'No room to blink.'); return false; }
    fxRay(p.x, p.y, lastX, lastY, '#a87fe0'); p.x = lastX; p.y = lastY; fxBurst(p.x, p.y, '#a87fe0');
    afterStep();
    return true;
  }
  function doQuake(range) {
    var p = world.player, any = false;
    for (var i = world.monsters.length - 1; i >= 0; i--) {   // backwards: damageMob may splice
      var m = world.monsters[i];
      if (cheb(p.x, p.y, m.x, m.y) <= range) { damageMob(m, Math.round(atkOf() * 1.2) + rr(0, 4), 'quake', '#e0c080'); applyStatus(m, 'stun', 2); any = true; }
    }
    shake(9); fxBurst(p.x, p.y, '#e0c080');
    for (var r = 1; r <= range; r++) { var a = Math.random() * 6.28; world.fx.push({ kind: 'spark', x: p.x + 0.5 + Math.cos(a) * r, y: p.y + 0.5 + Math.sin(a) * r, vx: 0, vy: 0, color: '#e0c080', life: 1, born: now() }); }
    return true;
  }

  // =========================================================================
  //  enemy turn
  // =========================================================================
  function tickStatus(e, isHero) {
    e.status = e.status || {};
    if (e.status.poison > 0) { var pd = 2; if (isHero) hurtHeroSilent(pd); else { e.hp -= pd; fxText(e.x, e.y, '-' + pd, '#9fe0a0'); if (e.hp <= 0) { killMob(e); return false; } } e.status.poison--; }
    if (e.status.burn > 0) { var bd = 3; if (isHero) hurtHeroSilent(bd); else { e.hp -= bd; fxText(e.x, e.y, '-' + bd, '#ffb060'); if (e.hp <= 0) { killMob(e); return false; } } e.status.burn--; }
    if (e.status.stun > 0) { e.status.stun--; return 'stunned'; }
    return true;
  }
  function hurtHeroSilent(d) { hero.hp -= d; fxText(world.player.x, world.player.y, '-' + d, '#c0ffb0'); if (hero.hp <= 0) die(); }

  function enemyTurn() {
    var p = world.player;
    for (var i = 0; i < world.monsters.length; i++) {
      var m = world.monsters[i]; if (!m || m.hp <= 0) continue;
      var alive = tickStatus(m, false);
      if (alive === false) { i--; continue; }
      if (m.regen && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + m.regen);
      if (alive === 'stunned') continue;
      var dist = cheb(m.x, m.y, p.x, p.y);
      var sees = world.visible[m.y] && world.visible[m.y][m.x];
      if (!m.awake) { if (sees && dist <= LIGHT + 1) m.awake = true; else continue; }
      if (world.mode === 'dead') return;

      if (m.behavior === 'archer') { archerAct(m, dist); }
      else if (m.behavior === 'thief') { thiefAct(m, dist); }
      else if (m.behavior === 'summon') { summonAct(m, dist); }
      else { meleeAct(m, dist); }
      if (hero.hp <= 0) return;
    }
  }
  function stepToward(m, p) {
    var dx = sgn(p.x - m.x), dy = sgn(p.y - m.y);
    if (m.erratic && chance(m.erratic)) { dx = rr(-1, 1); dy = rr(-1, 1); }
    var opts = [[m.x + dx, m.y + dy], [m.x + dx, m.y], [m.x, m.y + dy]];
    for (var o = 0; o < opts.length; o++) {
      var tx = opts[o][0], ty = opts[o][1];
      if (tx === m.x && ty === m.y) continue;
      if (tx === p.x && ty === p.y) return false; // adjacent; let caller attack
      if (!walkable(tx, ty) || mobAt(tx, ty)) continue;
      m.x = tx; m.y = ty; return true;
    }
    return false;
  }
  function mobAttack(m) { m.bump = now(); m.bumpDir = { x: sgn(world.player.x - m.x), y: sgn(world.player.y - m.y) };
    var dmg = Math.max(1, m.atk + rr(-1, 1)); hurtHero(dmg, m.name);
    if (m.poison) applyStatus(hero, 'poison', 4); if (m.burn) applyStatus(hero, 'burn', 3);
  }
  function meleeAct(m, dist) {
    var p = world.player;
    if (dist <= 1) { mobAttack(m); return; }
    if (dist > LIGHT + 2) return;
    stepToward(m, p);
    if (cheb(m.x, m.y, p.x, p.y) <= 1) { /* could double-act; keep single */ }
  }
  function archerAct(m, dist) {
    var p = world.player;
    if (dist <= 1) { mobAttack(m); return; }
    var inLine = (m.x === p.x || m.y === p.y) && losClear(m.x, m.y, p.x, p.y);
    if (inLine && dist <= (m.range || 5)) {
      fxRay(m.x, m.y, p.x, p.y, m.burn ? '#ff80c0' : '#cdd3da');
      var dmg = Math.max(1, m.atk + rr(0, 2)); hurtHero(dmg, m.name);
      if (m.burn) applyStatus(hero, 'burn', 3); if (m.poison) applyStatus(hero, 'poison', 4);
      return;
    }
    // reposition to line up or approach
    stepToward(m, p);
  }
  function thiefAct(m, dist) {
    var p = world.player;
    if (m._fleeing) { fleeFrom(m, p); m._fleeT = (m._fleeT || 0) - 1; if (m._fleeT <= 0) m._fleeing = false; return; }
    if (dist <= 1) { var steal = Math.min(hero.gold, 8 + ri(12) + world.depth * 2); if (steal > 0) { hero.gold -= steal; m._loot = (m._loot || 0) + steal; fxText(p.x, p.y, '-' + steal + 'g', '#ffd76a'); logMsg('', 'The ' + m.name + ' steals ' + steal + ' gold!'); } m._fleeing = true; m._fleeT = 6; markDirty(); return; }
    stepToward(m, p);
  }
  function fleeFrom(m, p) {
    var dx = sgn(m.x - p.x), dy = sgn(m.y - p.y);
    var opts = [[m.x + dx, m.y + dy], [m.x + dx, m.y], [m.x, m.y + dy]];
    for (var o = 0; o < opts.length; o++) { var tx = opts[o][0], ty = opts[o][1]; if (walkable(tx, ty) && !mobAt(tx, ty) && !(tx === p.x && ty === p.y)) { m.x = tx; m.y = ty; return; } }
  }
  function summonAct(m, dist) {
    var p = world.player;
    if (dist <= 1) { mobAttack(m); return; }
    if (m.summons && chance(0.25) && world.monsters.length < 16) {
      var sp = adjacentFree(m.x, m.y); if (sp) { world.monsters.push(makeMob(MOBS[m.summons], sp.x, sp.y, false, 1 + world.depth * 0.05, world.depth)); world.monsters[world.monsters.length - 1].awake = true; fxBurst(sp.x, sp.y, m.col); logMsg('', 'The ' + m.name + ' summons aid!'); }
      return;
    }
    stepToward(m, p);
  }

  // =========================================================================
  //  turn pipeline
  // =========================================================================
  function endTurn() {
    if (world.mode === 'dead') { refreshAll(); return; }
    // consume any deferred level transition before spending a turn
    if (world._pendingDescend) { world._pendingDescend = false; descend(); return; }
    if (world._pendingDive) { world._pendingDive = false; startNewRun(); return; }
    world.steps++;
    // hero status (DoT)
    tickStatus(hero, true);
    if (hero.hp <= 0) { refreshAll(); return; }
    // passive regen
    if (world.steps % 5 === 0 && hero.hp < maxHpOf()) hero.hp = Math.min(maxHpOf(), hero.hp + 1 + regenOf());
    if (world.steps % 7 === 0 && hero.mp < maxMpOf()) hero.mp = Math.min(maxMpOf(), hero.mp + 1);
    // cooldowns
    var cd = ensureCd(); for (var k in cd) if (cd[k] > 0) cd[k]--;
    // enemies
    if (world.mode !== 'town') enemyTurn();
    updatePlates();
    computeFov();
    if (hero.hp <= 0 && world.mode !== 'dead') die();
    refreshAll();
    markDirty();
  }

  // =========================================================================
  //  pathfinding (BFS) + tap-to-travel
  // =========================================================================
  function bfsPath(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    var q = [[sx, sy]], prev = {}, seen = {}; seen[key(sx, sy)] = 1;
    while (q.length) {
      var c = q.shift(), cx = c[0], cy = c[1];
      var nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (var i = 0; i < 4; i++) {
        var nx = nb[i][0], ny = nb[i][1];
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
        var kk = key(nx, ny); if (seen[kk]) continue;
        var passable = walkable(nx, ny);
        // allow stepping onto target even if it has a mob/chest/stairs (we stop there)
        if (!passable && !(nx === tx && ny === ty)) continue;
        if (mobAt(nx, ny) && !(nx === tx && ny === ty)) continue;
        seen[kk] = 1; prev[kk] = [cx, cy];
        if (nx === tx && ny === ty) {
          var path = [], cur = [tx, ty];
          while (!(cur[0] === sx && cur[1] === sy)) { path.push(cur); cur = prev[key(cur[0], cur[1])]; if (!cur) break; }
          path.reverse(); return path;
        }
        q.push([nx, ny]);
      }
    }
    return null;
  }
  function startTravel(tx, ty) {
    if (!playerActive()) return;
    if (!world.explored[ty] || !world.explored[ty][tx]) return;
    var p = world.player;
    var path = bfsPath(p.x, p.y, tx, ty);
    if (!path || !path.length) {
      // tapped own tile or unreachable → interact / wait
      if (tx === p.x && ty === p.y) interact();
      return;
    }
    world.path = path; world.pathT = 0;
  }
  function cancelTravel() { if (world) { world.path = null; } }
  function travelStep() {
    if (!world || !world.path || !world.path.length || !playerActive()) { if (world) world.path = null; return; }
    // stop if a visible enemy is near
    for (var i = 0; i < world.monsters.length; i++) { var m = world.monsters[i]; if (m.awake && world.visible[m.y] && world.visible[m.y][m.x] && cheb(m.x, m.y, world.player.x, world.player.y) <= LIGHT) { world.path = null; return; } }
    var nxt = world.path.shift();
    var dx = nxt[0] - world.player.x, dy = nxt[1] - world.player.y;
    var moved = tryMove(dx, dy);
    if (!moved) world.path = null;
    if (!world.path || !world.path.length) world.path = null;
  }

  // =========================================================================
  //  rendering
  // =========================================================================
  function camera() {
    var p = world.player;
    var cx = clamp(p.x - (VW >> 1), 0, MW - VW);
    var cy = clamp(p.y - (VH >> 1), 0, MH - VH);
    return { x: cx, y: cy };
  }
  function lerpEnt(e, dt) {
    var sp = 12 * dt;
    e.rx = e.rx == null ? e.x : e.rx + (e.x - e.rx) * Math.min(1, sp);
    e.ry = e.ry == null ? e.y : e.ry + (e.y - e.ry) * Math.min(1, sp);
    if (Math.abs(e.rx - e.x) < 0.02) e.rx = e.x;
    if (Math.abs(e.ry - e.y) < 0.02) e.ry = e.y;
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  var lastFrame = 0;
  function render(ts) {
    if (!ui || !ui.canvas || !ui.canvas.isConnected) { state_teardown(); return; }
    var dt = lastFrame ? Math.min(0.05, (ts - lastFrame) / 1000) : 0.016; lastFrame = ts;
    var ctx = ui.ctx, w = world;
    if (!w) { return; }
    var cam = camera();
    var b = w.biome;
    // shake
    var sox = 0, soy = 0;
    if (w.shake > 0) { sox = (Math.random() - 0.5) * w.shake; soy = (Math.random() - 0.5) * w.shake; w.shake = Math.max(0, w.shake - dt * 40); }
    ctx.setTransform(ui.dpr, 0, 0, ui.dpr, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#06070a'; ctx.fillRect(0, 0, CW, CH);
    ctx.save(); ctx.translate(sox, soy);

    // tiles
    for (var vy = 0; vy < VH; vy++) for (var vx = 0; vx < VW; vx++) {
      var mx = cam.x + vx, my = cam.y + vy;
      if (mx < 0 || my < 0 || mx >= MW || my >= MH) continue;
      if (!w.explored[my][mx]) continue;
      var vis = w.visible[my][mx];
      var px = vx * TILE, py = vy * TILE;
      var t = w.map[my][mx];
      if (t === T_FLOOR) {
        ctx.fillStyle = ((mx + my) & 1) ? b.floor : b.floor2;
        ctx.fillRect(px, py, TILE, TILE);
      } else {
        // wall
        ctx.fillStyle = b.wall; ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = b.wallTop; ctx.fillRect(px, py, TILE, 4);
        if (t === T_CRACK) { ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + TILE - 6, py + TILE - 8); ctx.moveTo(px + TILE - 6, py + 6); ctx.lineTo(px + 6, py + TILE - 5); ctx.stroke(); }
      }
      if (!vis) { ctx.fillStyle = 'rgba(4,5,9,0.55)'; ctx.fillRect(px, py, TILE, TILE); }
    }

    // objects
    for (var oi = 0; oi < w.objects.length; oi++) drawObject(ctx, w.objects[oi], cam);
    // items
    for (var ii = 0; ii < w.items.length; ii++) drawItem(ctx, w.items[ii], cam);
    // stairs (dungeon)
    if (w.mode !== 'town' && w.explored[w.stairs.y][w.stairs.x]) {
      var svis = w.visible[w.stairs.y][w.stairs.x];
      glyph(ctx, '▼', (w.stairs.x - cam.x) * TILE + TILE / 2, (w.stairs.y - cam.y) * TILE + TILE / 2, w.isBoss && bossAlive() ? '#6a5a44' : '#7fe08a', svis ? 1 : 0.4, 18);
    }
    // monsters
    for (var mi = 0; mi < w.monsters.length; mi++) { var m = w.monsters[mi]; lerpEnt(m, dt); if (w.visible[m.y] && w.visible[m.y][m.x]) drawMob(ctx, m, cam); }
    // player
    var p = w.player; lerpEnt(p, dt); drawPlayer(ctx, p, cam);

    // projectiles / fx
    drawFx(ctx, cam, dt);

    ctx.restore();

    // path dots
    if (w.path && w.path.length) {
      ctx.globalAlpha = 0.5;
      for (var pi = 0; pi < w.path.length; pi++) { var c = w.path[pi]; ctx.fillStyle = b.accent; ctx.beginPath(); ctx.arc((c[0] - cam.x) * TILE + TILE / 2, (c[1] - cam.y) * TILE + TILE / 2, 2.5, 0, 6.3); ctx.fill(); }
      ctx.globalAlpha = 1;
    }

    // dead overlay
    if (w.mode === 'dead') drawDeath(ctx);

    // advance auto-travel on a cadence
    w.pathT = (w.pathT || 0) + dt;
    if (w.path && w.path.length && w.pathT > 0.11) { w.pathT = 0; travelStep(); }

    if (w._logDirty) { refreshLog(); w._logDirty = false; }

    raf = requestAnimationFrame(render);
  }

  function glyph(ctx, ch, cx, cy, color, alpha, size) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color; ctx.font = '600 ' + (size || 16) + 'px ui-monospace, "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, cx, cy + 1);
    ctx.globalAlpha = 1;
  }
  function drawObject(ctx, o, cam) {
    if (!world.explored[o.y][o.x]) return;
    var vis = world.visible[o.y][o.x];
    var cx = (o.x - cam.x) * TILE + TILE / 2, cy = (o.y - cam.y) * TILE + TILE / 2;
    var px = (o.x - cam.x) * TILE, py = (o.y - cam.y) * TILE;
    var a = vis ? 1 : 0.4;
    switch (o.type) {
      case 'gate':
        if (o.open) { glyph(ctx, '╬', cx, cy, 'rgba(150,140,120,0.35)', a, 16); }
        else { ctx.globalAlpha = a; ctx.fillStyle = '#6b5a44'; for (var bx = 0; bx < 3; bx++) ctx.fillRect(px + 3 + bx * 7, py + 2, 4, TILE - 4); ctx.globalAlpha = 1; }
        break;
      case 'door':
        ctx.globalAlpha = a; ctx.fillStyle = o.locked ? '#8a5a3a' : '#5a4a3a'; roundRect(ctx, px + 3, py + 2, TILE - 6, TILE - 4, 3); ctx.fill();
        if (o.locked) glyph(ctx, '🔒', cx, cy, '#fff', a, 12); ctx.globalAlpha = 1; break;
      case 'lever': glyph(ctx, o.on ? '⤵' : '⤴', cx, cy, o.on ? '#9fe08a' : world.biome.accent, a, 18); break;
      case 'plate': ctx.globalAlpha = a; ctx.strokeStyle = o.pressed ? '#9fe08a' : '#8a8270'; ctx.lineWidth = 2; roundRect(ctx, px + 5, py + 5, TILE - 10, TILE - 10, 3); ctx.stroke(); ctx.globalAlpha = 1; break;
      case 'boulder': ctx.globalAlpha = a; ctx.fillStyle = '#7a7062'; ctx.beginPath(); ctx.arc(cx, cy, TILE / 2 - 3, 0, 6.3); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.arc(cx - 3, cy - 3, TILE / 4, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1; break;
      case 'trap':
        if (!o.armed) { glyph(ctx, '⚙', cx, cy, 'rgba(120,120,120,0.5)', a, 12); break; }
        if (trapHot(o)) glyph(ctx, '▲', cx, cy, '#e87a7a', a, 16); else glyph(ctx, '⬚', cx, cy, 'rgba(160,120,120,0.5)', a, 12);
        break;
      case 'tele': glyph(ctx, '◉', cx, cy, '#a87fe0', a * (0.6 + 0.4 * Math.abs(Math.sin(now() / 400))), 18); break;
      case 'chest': glyph(ctx, o.opened ? '📭' : (o.lush ? '🎁' : '📦'), cx, cy, '#ffd76a', a, 16); break;
      case 'npc': glyph(ctx, o.icon, cx, cy, o.col, 1, 18);
        ctx.globalAlpha = 0.8; ctx.fillStyle = o.col; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(o.name, cx, cy + 14); ctx.globalAlpha = 1; break;
      case 'stairs': glyph(ctx, '▾', cx, cy, '#9fe08a', 1, 20);
        ctx.globalAlpha = 0.8; ctx.fillStyle = '#9fe08a'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText('descend', cx, cy + 14); ctx.globalAlpha = 1; break;
    }
  }
  function drawItem(ctx, it, cam) {
    if (!world.visible[it.y] || !world.visible[it.y][it.x]) return;
    var cx = (it.x - cam.x) * TILE + TILE / 2, cy = (it.y - cam.y) * TILE + TILE / 2;
    var bob = Math.sin(now() / 350 + it.x) * 1.5;
    if (it.type === 'gold') { ctx.fillStyle = '#ffd76a'; ctx.beginPath(); ctx.arc(cx, cy + bob, 4, 0, 6.3); ctx.fill(); }
    else if (it.type === 'gem') glyph(ctx, '💎', cx, cy + bob, '#7fe0d0', 1, 14);
    else if (it.type === 'cons') glyph(ctx, CONS[it.id].icon, cx, cy + bob, '#fff', 1, 14);
    else if (it.type === 'gear') { var g = gear(it.id); glyph(ctx, g ? g.icon : '?', cx, cy + bob, '#fff', 1, 14); }
  }
  function entShake(e) { var t = now() - (e.hit || 0); if (t < 160) { var k = (160 - t) / 160; return (Math.random() - 0.5) * 5 * k; } return 0; }
  function bumpOff(e) { var t = now() - (e.bump || 0); if (t < 140 && e.bumpDir) { var k = Math.sin((1 - t / 140) * Math.PI) * 6; return { x: e.bumpDir.x * k, y: e.bumpDir.y * k }; } return { x: 0, y: 0 }; }
  function drawMob(ctx, m, cam) {
    var bo = bumpOff(m), sh = entShake(m);
    var cx = (m.rx - cam.x) * TILE + TILE / 2 + bo.x + sh, cy = (m.ry - cam.y) * TILE + TILE / 2 + bo.y;
    var r = (m.boss ? TILE / 2 + 2 : TILE / 2 - 2);
    ctx.fillStyle = m.col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.font = '700 ' + (m.boss ? 15 : 12) + 'px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(m.ch, cx, cy + 1);
    // status pips
    if (m.status) { var sy2 = cy - r - 3; if (m.status.burn > 0) { ctx.fillStyle = '#ff8040'; ctx.fillRect(cx - 6, sy2, 3, 3); } if (m.status.poison > 0) { ctx.fillStyle = '#7fe0a0'; ctx.fillRect(cx - 1, sy2, 3, 3); } if (m.status.stun > 0) { ctx.fillStyle = '#9fd0ff'; ctx.fillRect(cx + 4, sy2, 3, 3); } }
    // hp bar
    if (m.hp < m.maxHp || m.boss) {
      var bw = m.boss ? TILE + 6 : TILE - 6;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx - bw / 2, cy + r + 2, bw, 3);
      ctx.fillStyle = m.boss ? '#e85d5d' : '#d07a7a'; ctx.fillRect(cx - bw / 2, cy + r + 2, bw * Math.max(0, m.hp / m.maxHp), 3);
    }
  }
  function drawPlayer(ctx, p, cam) {
    var bo = bumpOff(p), sh = entShake(p);
    var cx = (p.rx - cam.x) * TILE + TILE / 2 + bo.x + sh, cy = (p.ry - cam.y) * TILE + TILE / 2 + bo.y;
    var r = TILE / 2 - 2;
    // glow
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#ffe9b0'; ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = '#f4e9d6'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#2a2218'; ctx.beginPath(); ctx.arc(cx, cy, r - 4, 0, 6.3); ctx.fill();
    // facing indicator
    ctx.fillStyle = '#ffe9b0'; ctx.beginPath(); ctx.arc(cx + p.dir.x * (r - 3), cy + p.dir.y * (r - 3), 2.4, 0, 6.3); ctx.fill();
  }
  function drawFx(ctx, cam, dt) {
    var w = world, t = now();
    // projectiles handled as rays in fx
    for (var i = w.fx.length - 1; i >= 0; i--) {
      var f = w.fx[i]; var age = (t - f.born) / 1000;
      if (f.kind === 'text') {
        f.life = 1 - age / 0.9; if (f.life <= 0) { w.fx.splice(i, 1); continue; }
        var tx = (f.x - cam.x) * TILE + TILE / 2, ty = (f.y - cam.y) * TILE + TILE / 2 + f.vy * age * 40 - 6;
        ctx.globalAlpha = Math.max(0, f.life); ctx.fillStyle = f.color; ctx.font = '700 12px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(f.text, tx, ty); ctx.globalAlpha = 1;
      } else if (f.kind === 'spark') {
        f.life = 1 - age / 0.5; if (f.life <= 0) { w.fx.splice(i, 1); continue; }
        var sx = (f.x - cam.x) * TILE + f.vx * age * 14, sy = (f.y - cam.y) * TILE + f.vy * age * 14;
        ctx.globalAlpha = Math.max(0, f.life); ctx.fillStyle = f.color; ctx.fillRect(sx, sy, 3, 3); ctx.globalAlpha = 1;
      } else if (f.kind === 'ray') {
        f.life = 1 - age / 0.25; if (f.life <= 0) { w.fx.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, f.life); ctx.strokeStyle = f.color; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo((f.x0 - cam.x) * TILE + TILE / 2, (f.y0 - cam.y) * TILE + TILE / 2); ctx.lineTo((f.x1 - cam.x) * TILE + TILE / 2, (f.y1 - cam.y) * TILE + TILE / 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }
  function drawDeath(ctx) {
    ctx.setTransform(ui.dpr, 0, 0, ui.dpr, 0, 0);
    ctx.fillStyle = 'rgba(6,7,10,0.82)'; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#e85d5d'; ctx.font = '700 26px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('You fell', CW / 2, CH / 2 - 26);
    ctx.fillStyle = '#cbd2dc'; ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('Floor ' + world.depth + ' · Lost ' + (world._deathLost || 0) + ' gold', CW / 2, CH / 2 + 2);
    ctx.fillText('Your character endures.', CW / 2, CH / 2 + 22);
    ctx.fillStyle = world.biome.accent; ctx.font = '700 13px ui-monospace, monospace';
    ctx.fillText('▶ Tap / Space — wake in town', CW / 2, CH / 2 + 48);
  }

  // =========================================================================
  //  HUD / panels (DOM)
  // =========================================================================
  function bar(cur, max, color, label, icon) {
    var pct = max > 0 ? clamp(cur / max, 0, 1) * 100 : 0;
    return '<div class="cr-bar"><div class="cr-bar-fill" style="width:' + pct + '%;background:' + color + '"></div>' +
      '<span class="cr-bar-lbl">' + icon + ' ' + Math.max(0, Math.round(cur)) + '/' + max + '</span></div>';
  }
  function refreshBars() {
    if (!ui || !ui.bars) return;
    ui.bars.innerHTML =
      bar(hero.hp, maxHpOf(), 'linear-gradient(90deg,#c0392b,#e85d5d)', 'HP', '❤') +
      bar(hero.mp, maxMpOf(), 'linear-gradient(90deg,#2e6da4,#5aa0e0)', 'MP', '✦') +
      xpbar();
  }
  function xpbar() {
    var need = xpForLevel(hero.level);
    var pct = clamp(hero.xp / need, 0, 1) * 100;
    return '<div class="cr-bar cr-xp"><div class="cr-bar-fill" style="width:' + pct + '%;background:linear-gradient(90deg,#b8860b,#ffd76a)"></div><span class="cr-bar-lbl">Lv ' + hero.level + '</span></div>';
  }
  function refreshHud() {
    if (!ui || !ui.hud) return;
    var loc = world.mode === 'town' ? '🏠 Town' : (world.isBoss ? '☠ Floor ' + world.depth : '⌄ Floor ' + world.depth);
    ui.hud.innerHTML =
      '<span>' + loc + '</span>' +
      '<span>🗺 max ' + hero.maxDepth + '</span>' +
      '<span>⚔ ' + atkOf() + '</span>' +
      '<span>🛡 ' + defOf() + '</span>' +
      '<span class="cr-gold">🪙 ' + hero.gold + '</span>';
  }
  function refreshLog() {
    if (!ui || !ui.log || !world) return;
    var last = world.log.slice(-3);
    ui.log.innerHTML = last.map(function (l) { return '<div class="cr-line cr-' + (l.k || '') + '">' + Cade.escapeHtml(l.t) + '</div>'; }).join('');
  }
  function refreshAll() { refreshBars(); refreshHud(); refreshLog(); refreshItemBar(); refreshAbilCd(); }

  // ---- ability bar ----------------------------------------------------------
  function buildAbilityBar() {
    if (!ui || !ui.abil) return;
    var ids = unlockedAbilities();
    ui.abil.innerHTML = ids.map(function (id, i) {
      var a = ABIL[id];
      return '<button class="cr-ab" data-ab="' + id + '" title="' + a.name + ' — ' + a.desc + ' (MP ' + a.mp + ')">' +
        '<span class="cr-ab-ic">' + a.icon + '</span><span class="cr-ab-cd" data-cd="' + id + '"></span>' +
        '<span class="cr-ab-key">' + (i + 1) + '</span></button>';
    }).join('') || '<span class="cr-hint">Level up to learn abilities</span>';
    // bind
    var btns = ui.abil.querySelectorAll('.cr-ab');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); useAbility(btn.getAttribute('data-ab')); });
    })(btns[i]);
    refreshAbilCd();
  }
  function refreshAbilCd() {
    if (!ui || !ui.abil) return;
    var cd = ensureCd();
    var els = ui.abil.querySelectorAll('.cr-ab-cd');
    for (var i = 0; i < els.length; i++) { var id = els[i].getAttribute('data-cd'); var v = cd[id] || 0; els[i].textContent = v > 0 ? v : ''; els[i].parentNode.classList.toggle('cr-ab-down', v > 0 || hero.mp < ABIL[id].mp); }
  }

  // ---- quick item bar -------------------------------------------------------
  function refreshItemBar() {
    if (!ui || !ui.items) return;
    var order = ['potion', 'elixir', 'bomb', 'scroll'];
    ui.items.innerHTML = order.map(function (id) {
      var n = hero.bag[id] || 0;
      return '<button class="cr-it' + (n ? '' : ' cr-it-empty') + '" data-it="' + id + '" title="' + CONS[id].name + ' — ' + CONS[id].desc + '">' +
        '<span>' + CONS[id].icon + '</span><span class="cr-it-n">' + n + '</span></button>';
    }).join('');
    var btns = ui.items.querySelectorAll('.cr-it');
    for (var i = 0; i < btns.length; i++) (function (btn) { btn.addEventListener('click', function (e) { e.preventDefault(); useItem(btn.getAttribute('data-it')); }); })(btns[i]);
  }

  // =========================================================================
  //  overlay: character / inventory
  // =========================================================================
  function openCharacter() {
    closeOverlay();
    var ov = mkOverlay('Character');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-sheet">';
    html += '<div class="cr-sheet-row"><b>' + hero.name + '</b> · Level ' + hero.level + '</div>';
    html += '<div class="cr-grid2">' +
      stat('❤ Max HP', maxHpOf()) + stat('✦ Max MP', maxMpOf()) +
      stat('⚔ Attack', atkOf()) + stat('🛡 Defense', defOf()) +
      stat('🎯 Crit', Math.round(critOf() * 100) + '%') + stat('🪙 Gold', hero.gold) +
      stat('🗺 Deepest', hero.maxDepth) + stat('💀 Deaths', hero.stats.deaths) +
      stat('⚔ Kills', hero.stats.kills) + stat('💎 Gems', hero.stats.gems) + '</div>';
    html += '<div class="cr-sec">Equipment</div><div class="cr-eqrow">' +
      eqSlot('weapon') + eqSlot('armor') + eqSlot('trinket') + '</div>';
    html += '<div class="cr-sec">Owned gear (tap to equip)</div><div class="cr-owned">';
    hero.owned.forEach(function (id) { var g = gear(id); if (!g) return; var on = hero.equip[g.slot] === id;
      html += '<button class="cr-gear' + (on ? ' cr-on' : '') + '" data-eq="' + id + '"><span>' + g.icon + '</span> ' + g.name +
        '<span class="cr-gear-st">' + gearStatStr(g) + '</span></button>'; });
    html += '</div></div>';
    body.innerHTML = html;
    var btns = body.querySelectorAll('[data-eq]');
    for (var i = 0; i < btns.length; i++) (function (btn) { btn.addEventListener('click', function () { var id = btn.getAttribute('data-eq'); var g = gear(id); hero.equip[g.slot] = id; hero.hp = clamp(hero.hp, 0, maxHpOf()); hero.mp = clamp(hero.mp, 0, maxMpOf()); markDirty(); refreshAll(); openCharacter(); }); })(btns[i]);
  }
  function stat(label, val) { return '<div class="cr-stat"><span>' + label + '</span><b>' + val + '</b></div>'; }
  function eqSlot(slot) { var g = gear(hero.equip[slot]); return '<div class="cr-eqslot"><div class="cr-eqic">' + (g ? g.icon : '·') + '</div><div class="cr-eqnm">' + (g ? g.name : '—') + '</div></div>'; }
  function gearStatStr(g) { var s = []; if (g.atk) s.push('+' + g.atk + ' atk'); if (g.def) s.push('+' + g.def + ' def'); if (g.hp) s.push('+' + g.hp + ' hp'); if (g.mp) s.push('+' + g.mp + ' mp'); if (g.crit) s.push('+' + Math.round(g.crit * 100) + '% crit'); if (g.regen) s.push('regen'); if (g.greed) s.push('+gold'); if (g.stun) s.push('stun'); return s.join(' '); }

  // =========================================================================
  //  overlay: shops (town NPCs)
  // =========================================================================
  function openShop(role) {
    closeOverlay();
    if (role === 'healer') return openHealer();
    if (role === 'smith') return openSmith();
    var ov = mkOverlay('Merchant 🛒');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div><div class="cr-shop">';
    // consumables
    ['potion', 'elixir', 'bomb', 'scroll', 'key'].forEach(function (id) { var c = CONS[id];
      html += shopRow('cons:' + id, c.icon, c.name, c.desc, c.price, hero.bag[id] || 0); });
    // a rotating gear selection (deterministic-ish by maxDepth)
    var stock = merchantStock();
    stock.forEach(function (id) { var g = gear(id); var owned = hero.owned.indexOf(id) >= 0;
      html += shopRow('gear:' + id, g.icon, g.name, gearStatStr(g), g.price, owned ? '✓' : 0, owned); });
    html += '</div>';
    body.innerHTML = html;
    bindShop(body, function () { openShop('merchant'); });
  }
  function merchantStock() {
    var pool = [];
    function add(tbl) { for (var id in tbl) { var g = tbl[id]; if (g.tier > 0 && g.price && g.tier <= 2 + Math.ceil(hero.maxDepth / 3)) pool.push(id); } }
    add(WEAPONS); add(ARMORS); add(TRINKETS);
    // stable-ish rotation: pick up to 5 by a hash of maxDepth + runs
    pool.sort(); var out = []; var seed = (hero.maxDepth * 7 + hero.stats.runs * 3) % Math.max(1, pool.length);
    for (var i = 0; i < pool.length && out.length < 5; i++) out.push(pool[(seed + i) % pool.length]);
    // dedupe
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }
  function shopRow(buyId, icon, name, desc, price, qty, owned) {
    return '<div class="cr-srow"><span class="cr-sic">' + icon + '</span>' +
      '<span class="cr-snm">' + name + '<span class="cr-sdesc">' + (desc || '') + '</span></span>' +
      '<button class="cr-buy' + (owned ? ' cr-owned' : '') + '" data-buy="' + buyId + '" data-price="' + price + '">' + (owned ? 'owned' : '🪙 ' + price) +
      (qty && !owned ? ' <small>(' + qty + ')</small>' : '') + '</button></div>';
  }
  function bindShop(body, reopen) {
    var btns = body.querySelectorAll('[data-buy]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () {
        var spec = btn.getAttribute('data-buy'), price = parseInt(btn.getAttribute('data-price'), 10);
        var parts = spec.split(':'), kind = parts[0], id = parts[1];
        if (kind === 'gear' && hero.owned.indexOf(id) >= 0) { Cade.showToast('Already owned', 'info'); return; }
        if (hero.gold < price) { Cade.showToast('Not enough gold', 'error'); return; }
        hero.gold -= price;
        if (kind === 'cons') { hero.bag[id] = (hero.bag[id] || 0) + 1; }
        else { acquireGear(id); }
        Cade.haptic(8); markDirty(); refreshAll(); reopen();
      });
    })(btns[i]);
  }
  function openHealer() {
    var ov = mkOverlay('Healer ⛑️');
    var body = ov.querySelector('.cr-ov-body');
    var hpCost = Math.ceil((maxHpOf() - hero.hp) * 1.2);
    var mpCost = Math.ceil((maxMpOf() - hero.mp) * 1.5);
    var full = 30 + hero.maxDepth * 4;
    body.innerHTML = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div><div class="cr-shop">' +
      shopRow('heal:hp', '❤', 'Restore HP', 'Full heal HP', hpCost || 0, 0) +
      shopRow('heal:mp', '✦', 'Restore MP', 'Full restore MP', mpCost || 0, 0) +
      shopRow('heal:all', '✨', 'Full Rest', 'HP + MP to full', full, 0) +
      '</div><div class="cr-hint">Healing is also free over time as you walk.</div>';
    var btns = body.querySelectorAll('[data-buy]');
    for (var i = 0; i < btns.length; i++) (function (btn) { btn.addEventListener('click', function () {
      var spec = btn.getAttribute('data-buy').split(':')[1], price = parseInt(btn.getAttribute('data-price'), 10);
      if (hero.gold < price) { Cade.showToast('Not enough gold', 'error'); return; }
      hero.gold -= price;
      if (spec === 'hp' || spec === 'all') hero.hp = maxHpOf();
      if (spec === 'mp' || spec === 'all') hero.mp = maxMpOf();
      Cade.haptic(8); markDirty(); refreshAll(); openHealer();
    }); })(btns[i]);
  }
  function openSmith() {
    var ov = mkOverlay('Smith ⚒️');
    var body = ov.querySelector('.cr-ov-body');
    var w = gear(hero.equip.weapon), a = gear(hero.equip.armor);
    var wCost = 60 + (hero._wlvl || 0) * 80 + (w ? w.tier * 40 : 0);
    var aCost = 60 + (hero._alvl || 0) * 80 + (a ? a.tier * 40 : 0);
    body.innerHTML = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div>' +
      '<div class="cr-hint">Permanently temper your equipped gear.</div><div class="cr-shop">' +
      shopRow('smith:atk', '⚔', 'Temper Weapon', '+2 base ATK (current +' + (hero._wlvl || 0) * 2 + ')', wCost, 0) +
      shopRow('smith:def', '🛡', 'Reinforce Armor', '+1 base DEF (current +' + (hero._alvl || 0) + ')', aCost, 0) +
      '</div>';
    var btns = body.querySelectorAll('[data-buy]');
    for (var i = 0; i < btns.length; i++) (function (btn) { btn.addEventListener('click', function () {
      var spec = btn.getAttribute('data-buy').split(':')[1], price = parseInt(btn.getAttribute('data-price'), 10);
      if (hero.gold < price) { Cade.showToast('Not enough gold', 'error'); return; }
      hero.gold -= price;
      if (spec === 'atk') { hero.atk += 2; hero._wlvl = (hero._wlvl || 0) + 1; }
      else { hero.def += 1; hero._alvl = (hero._alvl || 0) + 1; }
      Cade.haptic(8); Cade.showToast('Tempered!', 'success'); markDirty(); refreshAll(); openSmith();
    }); })(btns[i]);
  }

  function mkOverlay(title) {
    closeOverlay();
    var el = document.createElement('div'); el.className = 'cr-overlay'; el.id = 'cr-overlay';
    el.innerHTML = '<div class="cr-ov-card"><div class="cr-ov-head"><span>' + title + '</span><button class="cr-ov-x" aria-label="Close">×</button></div><div class="cr-ov-body"></div></div>';
    ui.wrap.appendChild(el);
    el.querySelector('.cr-ov-x').addEventListener('click', closeOverlay);
    el.addEventListener('click', function (e) { if (e.target === el) closeOverlay(); });
    return el;
  }
  function closeOverlay() { var o = document.getElementById('cr-overlay'); if (o) o.remove(); }

  // =========================================================================
  //  persistence: local + Firebase room _dungeon
  // =========================================================================
  function getClientId() {
    var c = '';
    try { c = Cade.store.get(CKEY) || ''; } catch (e) {}
    if (!c) { c = 'c' + Math.random().toString(36).slice(2, 9) + (Date.now() % 100000); try { Cade.store.set(CKEY, c); } catch (e) {} }
    return c;
  }
  function serialize() {
    return {
      v: 2, name: hero.name, level: hero.level, xp: hero.xp,
      maxHp: hero.maxHp, hp: hero.hp, maxMp: hero.maxMp, mp: hero.mp,
      atk: hero.atk, def: hero.def, crit: hero.crit, gold: hero.gold,
      depth: hero.depth, maxDepth: hero.maxDepth, equip: hero.equip, bag: hero.bag,
      owned: hero.owned, stats: hero.stats, _wlvl: hero._wlvl || 0, _alvl: hero._alvl || 0,
      createdAt: hero.createdAt, updatedAt: Date.now(), rev: hero.rev, client: clientId
    };
  }
  function deserialize(d) {
    if (!d || typeof d !== 'object') return null;
    var h = freshHero();
    for (var k in d) if (d[k] != null) h[k] = d[k];
    // sanity defaults for older/partial saves
    h.equip = h.equip || { weapon: 'dagger', armor: 'rags', trinket: 'none' };
    h.bag = h.bag || { potion: 1 };
    h.owned = h.owned || ['dagger', 'rags'];
    h.stats = h.stats || { kills: 0, deaths: 0, floors: 0, gems: 0, runs: 0 };
    if (h.owned.indexOf(h.equip.weapon) < 0) h.owned.push(h.equip.weapon);
    if (h.owned.indexOf(h.equip.armor) < 0) h.owned.push(h.equip.armor);
    return h;
  }
  function loadLocal() { try { var s = Cade.store.get(LKEY); return s ? deserialize(JSON.parse(s)) : null; } catch (e) { return null; } }
  function saveLocal() { try { Cade.store.set(LKEY, JSON.stringify(serialize())); } catch (e) {} }

  function fbDb() {
    try {
      if (typeof firebase === 'undefined' || !firebase.database) return null;
      var url = Cade.store.get('cade-firebase-url'); if (!url) return null;
      var app;
      try { app = firebase.app('cade-dungeon'); }
      catch (e) { app = firebase.initializeApp({ databaseURL: url }, 'cade-dungeon'); }
      return firebase.database(app);
    } catch (e) { return null; }
  }
  function progressScore(d) { return (d.maxDepth || 0) * 1000 + (d.level || 0) * 100 + (d.rev || 0); }

  function loadHero(done) {
    clientId = getClientId();
    var local = loadLocal();
    var db = fbDb();
    if (!db) { hero = local || freshHero(); hero.client = clientId; done(); attachFbListener(); return; }
    var settled = false;
    var fin = function (h) { if (settled) return; settled = true; hero = h; hero.client = clientId; done(); attachFbListener(); };
    try {
      db.ref(FB_PATH).once('value').then(function (snap) {
        var remote = deserialize(snap.val());
        var chosen;
        if (remote && local) chosen = (progressScore(remote) >= progressScore(local)) ? remote : local;
        else chosen = remote || local || freshHero();
        fin(chosen);
      }).catch(function () { fin(local || freshHero()); });
    } catch (e) { fin(local || freshHero()); }
    // safety timeout if Firebase hangs
    setTimeout(function () { fin(local || freshHero()); }, 4000);
  }

  function attachFbListener() {
    detachFbListener();
    var db = fbDb(); if (!db) return;
    try {
      fbRef = db.ref(FB_PATH);
      fbCb = function (snap) {
        var remote = deserialize(snap.val());
        if (!remote) return;
        if (remote.client === clientId) return;            // our own echo
        if (remote.rev <= hero.rev) return;                 // not newer
        // adopt only when safe (in town and not mid-overlay battle) to avoid disrupting a run
        if (world && world.mode === 'town') {
          hero = remote; hero.client = clientId;
          enter(0); Cade.showToast('Synced character from another device', 'success');
        } else {
          // remember that a newer remote exists; we keep our run but won't clobber blindly
          hero._remoteAhead = remote.rev;
        }
      };
      fbRef.on('value', fbCb);
    } catch (e) {}
  }
  function detachFbListener() { try { if (fbRef && fbCb) fbRef.off('value', fbCb); } catch (e) {} fbRef = null; fbCb = null; }

  function markDirty() { fbDirty = true; scheduleSave(); }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = 0; if (fbDirty) saveNow(); }, 2500);
  }
  function saveNow() {
    fbDirty = false;
    if (!hero) return;
    hero.rev = (hero.rev || 1) + 1;
    saveLocal();
    var db = fbDb(); if (!db) return;
    try { db.ref(FB_PATH).set(serialize()); } catch (e) {}
  }

  // =========================================================================
  //  input
  // =========================================================================
  function onKey(e) {
    if (!document.getElementById('crawler-panel')) return;
    var k = e.key;
    if (k === 'Escape') { if (document.getElementById('cr-overlay')) { e.preventDefault(); closeOverlay(); return; } e.preventDefault(); close(); return; }
    if (document.getElementById('cr-overlay')) return; // overlay captures nothing else
    if (world && world.mode === 'dead') { if (k === ' ' || k === 'Enter') { e.preventDefault(); enter(0); } return; }
    cancelTravel();
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); tryMove(-1, 0); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); tryMove(1, 0); }
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); tryMove(0, -1); }
    else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); tryMove(0, 1); }
    else if (k === ' ') { e.preventDefault(); rest(); }
    else if (k === 'e' || k === 'E' || k === 'Enter') { e.preventDefault(); interact(); }
    else if (k === 'c' || k === 'C') { e.preventDefault(); openCharacter(); }
    else if (k >= '1' && k <= '5') { e.preventDefault(); var ids = unlockedAbilities(); var idx = parseInt(k, 10) - 1; if (ids[idx]) useAbility(ids[idx]); }
    else if (k === 'q' || k === 'Q') { e.preventDefault(); useItem('potion'); }
  }

  function bindCanvasInput(canvas) {
    var sx = 0, sy = 0, st = 0, moved = false, tracking = false;
    canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; st = now(); moved = false; tracking = true; }, { passive: true });
    canvas.addEventListener('pointermove', function (e) { if (tracking && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) moved = true; }, { passive: true });
    canvas.addEventListener('pointerup', function (e) {
      if (!tracking) return; tracking = false;
      if (world && world.mode === 'dead') { enter(0); return; }
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 22 || Math.abs(dy) > 22) {
        cancelTravel();
        if (Math.abs(dx) > Math.abs(dy)) tryMove(dx > 0 ? 1 : -1, 0); else tryMove(0, dy > 0 ? 1 : -1);
        return;
      }
      // tap → travel/interact at tile
      var rect = canvas.getBoundingClientRect();
      var lx = (e.clientX - rect.left) / rect.width * CW;
      var ly = (e.clientY - rect.top) / rect.height * CH;
      var cam = camera();
      var tx = Math.floor(lx / TILE) + cam.x, ty = Math.floor(ly / TILE) + cam.y;
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return;
      var p = world.player;
      // tapping adjacent or own tile interacts; otherwise travel
      if (cheb(tx, ty, p.x, p.y) <= 1) {
        if (tx === p.x && ty === p.y) { interact(); }
        else { cancelTravel(); tryMove(sgn(tx - p.x), sgn(ty - p.y)); }
      } else {
        startTravel(tx, ty);
      }
    });
    canvas.style.touchAction = 'none';
  }

  function bindButton(el, fn) {
    if (!el) return;
    var handler = function (e) { e.preventDefault(); Cade.haptic(6); fn(); };
    el.addEventListener('click', handler);
  }

  // =========================================================================
  //  open / close lifecycle
  // =========================================================================
  function state_teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    lastFrame = 0;
  }
  function close() {
    saveNow();
    state_teardown();
    detachFbListener();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (ui && ui.onKey) document.removeEventListener('keydown', ui.onKey, true);
    if (ui && ui.onResize) window.removeEventListener('resize', ui.onResize);
    closeOverlay();
    var p = document.getElementById('crawler-panel'); if (p) p.remove();
    // null out heavy state so nothing lingers in memory
    world = null; ui = null;
    try { Cade.editor.focus(); } catch (e) {}
  }

  function layoutCanvas() {
    if (!ui || !ui.canvas) return;
    ui.dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = CW * ui.dpr; ui.canvas.height = CH * ui.dpr;
    ui.canvas.style.aspectRatio = CW + ' / ' + CH;
  }

  function open() {
    Cade.closeAllMenus();
    if (document.getElementById('crawler-panel')) { close(); return; }

    var body =
      '<div class="cr-wrap">' +
        '<div class="cr-topbar">' +
          '<div id="cr-bars" class="cr-bars"></div>' +
          '<div class="cr-tbtns">' +
            '<button id="cr-char" class="cr-tbtn" title="Character (C)">🎒</button>' +
          '</div>' +
        '</div>' +
        '<div id="cr-hud" class="cr-hud"></div>' +
        '<div class="cr-stage"><canvas id="crawler-canvas" class="cr-canvas"></canvas>' +
          '<div id="cr-log" class="cr-log"></div></div>' +
        '<div id="cr-items" class="cr-items"></div>' +
        '<div id="cr-abil" class="cr-abil"></div>' +
        '<div class="cr-controls">' +
          '<div class="cr-dpad">' +
            '<button class="cr-d cr-up" data-dir="up">▲</button>' +
            '<button class="cr-d cr-left" data-dir="left">◀</button>' +
            '<button class="cr-d cr-mid" data-dir="wait">•</button>' +
            '<button class="cr-d cr-right" data-dir="right">▶</button>' +
            '<button class="cr-d cr-down" data-dir="down">▼</button>' +
          '</div>' +
          '<div class="cr-actcol">' +
            '<button id="cr-act" class="cr-act" title="Interact (E)">✋</button>' +
          '</div>' +
        '</div>' +
        '<div class="cr-help">Move: swipe / D-pad / WASD · Tap a tile to travel · ✋ interact · 🎒 gear</div>' +
      '</div>';

    var panel = Cade.mkPanel('crawler-panel', '⚔ Deepdelve', body);
    var canvas = document.getElementById('crawler-canvas');
    ui = {
      wrap: panel.querySelector('.cr-wrap'), canvas: canvas, ctx: canvas.getContext('2d'),
      bars: document.getElementById('cr-bars'), hud: document.getElementById('cr-hud'),
      log: document.getElementById('cr-log'), items: document.getElementById('cr-items'),
      abil: document.getElementById('cr-abil'), dpr: 1, onKey: null, onResize: null
    };
    layoutCanvas();

    // input
    ui.onKey = onKey;
    document.addEventListener('keydown', ui.onKey, true);
    ui.onResize = function () { layoutCanvas(); };
    window.addEventListener('resize', ui.onResize);
    bindCanvasInput(canvas);

    // d-pad
    var dpad = panel.querySelectorAll('.cr-d');
    for (var i = 0; i < dpad.length; i++) (function (btn) {
      var dir = btn.getAttribute('data-dir');
      var act = function (e) { e.preventDefault(); cancelTravel(); Cade.haptic(5);
        if (world && world.mode === 'dead') { enter(0); return; }
        if (dir === 'up') tryMove(0, -1); else if (dir === 'down') tryMove(0, 1);
        else if (dir === 'left') tryMove(-1, 0); else if (dir === 'right') tryMove(1, 0);
        else rest(); };
      btn.addEventListener('click', act);
    })(dpad[i]);
    bindButton(document.getElementById('cr-act'), function () { if (world && world.mode === 'dead') { enter(0); return; } interact(); });
    bindButton(document.getElementById('cr-char'), openCharacter);

    panel._onClose = function () {
      saveNow(); state_teardown(); detachFbListener();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      if (ui && ui.onKey) document.removeEventListener('keydown', ui.onKey, true);
      if (ui && ui.onResize) window.removeEventListener('resize', ui.onResize);
      closeOverlay();
      world = null; ui = null;
    };

    // boot: load the enduring hero, then enter town
    Cade.showToast('Loading your delver…', 'info', 1200);
    loadHero(function () {
      if (!ui) return; // closed during async load
      buildAbilityBar();
      // resume into town (always a safe hub); if dead-state somehow, fix
      enter(0);
      refreshAll();
      raf = requestAnimationFrame(render);
    });
  }

  Cade.registerWidget({
    name: 'Dungeon Crawler',
    description: 'Deepdelve — a puzzle-action roguelite with an enduring, synced character',
    icon: '⚔',
    tags: 'game,roguelike,dungeon,crawler,rpg,adventure,puzzle,action,deepdelve,fun',
    open: open
  });
})();
