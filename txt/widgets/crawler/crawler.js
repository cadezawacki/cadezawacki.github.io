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
  var PRICE_MULT = 1.5;            // shops charge above base; you sell back at 0.4× base
  var DIFFS = {
    relaxed:   { name: 'Relaxed',   hp: 0.7, atk: 0.7, rew: 0.85, elite: 0.6 },
    normal:    { name: 'Normal',    hp: 1.0, atk: 1.0, rew: 1.0,  elite: 1.0 },
    hard:      { name: 'Hard',      hp: 1.45, atk: 1.35, rew: 1.35, elite: 1.5 },
    nightmare: { name: 'Nightmare', hp: 2.0, atk: 1.7, rew: 1.8,  elite: 2.2 }
  };
  var DIFF_ORDER = ['relaxed', 'normal', 'hard', 'nightmare'];
  function diff() { return DIFFS[hero && hero.difficulty] || DIFFS.normal; }

  // ---- tile codes ------------------------------------------------------------
  var T_WALL = 0, T_FLOOR = 1, T_CRACK = 2; // crack = bombable wall

  // ---- persistence keys ------------------------------------------------------
  var LKEY = 'cade-dungeon-save';      // local mirror of the hero
  var CKEY = 'cade-dungeon-client';    // this device's id
  // Stored under rooms/ so existing Firebase rules apply, but with a __ prefix
  // so it's hidden from the Explore Rooms list (txt.html filters __* keys) and
  // can never collide with or be opened as a real room.
  var FB_PATH = 'rooms/__cade_dungeon/hero';
  var FB_PATH_OLD = 'rooms/_dungeon/hero'; // migrate away from the visible path
  var migrateOld = false;

  // ---- live (non-persistent) state ------------------------------------------
  var world = null;   // current floor: map, objects, monsters, items, fx, …
  var hero = null;    // THE persistent character
  var ui = null;      // dom refs + animation loop handle
  var raf = 0;
  var saveTimer = 0, fbDirty = false;
  var fbRef = null, fbCb = null, clientId = '';
  var merchStock = null;           // merchant's rolled wares for the current town visit

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
  // Effect fields: crit, stun, freeze, poison, burn (chance to apply on hit) ·
  // cleave/chain (fraction of hit dealt to extra foes) · lifesteal (heal frac of
  // damage) · spell (+% spell damage) · mp/hp (+max) · dodge/thorns/resist/regen/
  // greed (defensive & utility). This is what makes each weapon *play* different.
  var WEAPONS = {
    fist:       { id: 'fist',       name: 'Bare Fists',      atk: 0,  icon: '👊', slot: 'weapon', tier: 0 },
    dagger:     { id: 'dagger',     name: 'Rusty Dagger',    atk: 2,  icon: '🗡️', slot: 'weapon', tier: 1, price: 30 },
    shortsword: { id: 'shortsword', name: 'Iron Sword',      atk: 4,  icon: '⚔️', slot: 'weapon', tier: 2, price: 90 },
    rapier:     { id: 'rapier',     name: 'Rapier',          atk: 5,  icon: '🤺', slot: 'weapon', tier: 2, price: 170, crit: 0.15 },
    mace:       { id: 'mace',       name: 'Spiked Mace',     atk: 6,  icon: '🔨', slot: 'weapon', tier: 3, price: 210, stun: 0.20 },
    venomfang:  { id: 'venomfang',  name: 'Venom Fang',      atk: 5,  icon: '🐍', slot: 'weapon', tier: 3, price: 250, poison: 0.5 },
    staff:      { id: 'staff',      name: 'Arcane Staff',    atk: 5,  icon: '🪄', slot: 'weapon', tier: 3, price: 270, mp: 10, spell: 0.20 },
    battleaxe:  { id: 'battleaxe',  name: 'Great Axe',       atk: 9,  icon: '🪓', slot: 'weapon', tier: 4, price: 430, cleave: 0.5 },
    warhammer:  { id: 'warhammer',  name: 'Warhammer',       atk: 8,  icon: '🔨', slot: 'weapon', tier: 4, price: 450, stun: 0.30 },
    frostbrand: { id: 'frostbrand', name: 'Frostbrand',      atk: 8,  icon: '❄️', slot: 'weapon', tier: 4, price: 490, freeze: 0.30 },
    flameberge: { id: 'flameberge', name: 'Flameberge',      atk: 9,  icon: '🔥', slot: 'weapon', tier: 4, price: 510, burn: 0.5 },
    runeblade:  { id: 'runeblade',  name: 'Runeblade',       atk: 12, icon: '⚔️', slot: 'weapon', tier: 5, price: 900, crit: 0.18, lifesteal: 0.15 },
    vampscythe: { id: 'vampscythe', name: 'Vampiric Scythe', atk: 11, icon: '🌑', slot: 'weapon', tier: 5, price: 960, lifesteal: 0.35 },
    thundermaul:{ id: 'thundermaul',name: 'Thunder Maul',    atk: 13, icon: '⚡', slot: 'weapon', tier: 5, price: 1050, chain: 0.6, stun: 0.2 },
    archstaff:  { id: 'archstaff',  name: 'Archmage Staff',  atk: 7,  icon: '🔮', slot: 'weapon', tier: 5, price: 990, mp: 25, spell: 0.5 },
    godsbane:   { id: 'godsbane',   name: 'Godsbane',        atk: 18, icon: '🩸', slot: 'weapon', tier: 6, price: 2800, crit: 0.2, lifesteal: 0.2, cleave: 0.4 }
  };
  var ARMORS = {
    rags:        { id: 'rags',        name: 'Tattered Rags',  def: 0,  icon: '🧥', slot: 'armor', tier: 0 },
    leather:     { id: 'leather',     name: 'Leather Armor',  def: 2,  icon: '🦺', slot: 'armor', tier: 1, price: 40 },
    chain:       { id: 'chain',       name: 'Chain Mail',     def: 4,  icon: '⛓️', slot: 'armor', tier: 2, price: 120 },
    scale:       { id: 'scale',       name: 'Scale Armor',    def: 6,  icon: '🐊', slot: 'armor', tier: 3, price: 280, dodge: 0.08 },
    plate:       { id: 'plate',       name: 'Plate Armor',    def: 7,  icon: '🛡️', slot: 'armor', tier: 3, price: 300, hp: 10 },
    magerobe:    { id: 'magerobe',    name: 'Mage Robe',      def: 4,  icon: '👘', slot: 'armor', tier: 3, price: 330, mp: 20, spell: 0.25 },
    spiked:      { id: 'spiked',      name: 'Spiked Mail',    def: 8,  icon: '🦔', slot: 'armor', tier: 4, price: 490, thorns: 0.30 },
    shadowcloak: { id: 'shadowcloak', name: 'Shadow Cloak',   def: 6,  icon: '🥷', slot: 'armor', tier: 4, price: 540, dodge: 0.20 },
    dragonscale: { id: 'dragonscale', name: 'Dragonscale',    def: 11, icon: '🐉', slot: 'armor', tier: 5, price: 900, hp: 25, resist: 0.15 },
    aegis:       { id: 'aegis',       name: 'Aegis Plate',    def: 12, icon: '🛡️', slot: 'armor', tier: 5, price: 960, hp: 25 },
    titanplate:  { id: 'titanplate',  name: 'Titan Plate',    def: 16, icon: '🏰', slot: 'armor', tier: 6, price: 2400, hp: 50, thorns: 0.2 }
  };
  var TRINKETS = {
    none:      { id: 'none',      name: '— none —',        icon: '·',  slot: 'trinket', tier: 0 },
    ringreg:   { id: 'ringreg',   name: 'Ring of Regen',   icon: '💍', slot: 'trinket', tier: 2, price: 150, regen: 1 },
    ampmana:   { id: 'ampmana',   name: 'Mana Amulet',     icon: '📿', slot: 'trinket', tier: 2, price: 150, mp: 20 },
    bandpow:   { id: 'bandpow',   name: 'Power Band',       icon: '⭕', slot: 'trinket', tier: 3, price: 240, atk: 3 },
    wardchm:   { id: 'wardchm',   name: 'Warding Charm',    icon: '🔱', slot: 'trinket', tier: 3, price: 240, def: 3 },
    greed:     { id: 'greed',     name: 'Greed Coin',       icon: '🪙', slot: 'trinket', tier: 3, price: 300, greed: 0.5 },
    swiftboots:{ id: 'swiftboots',name: 'Swift Boots',      icon: '👢', slot: 'trinket', tier: 4, price: 450, dodge: 0.12 },
    vampring:  { id: 'vampring',  name: 'Vampire Ring',     icon: '🧛', slot: 'trinket', tier: 4, price: 520, lifesteal: 0.15 },
    archring:  { id: 'archring',  name: 'Archmage Ring',    icon: '💠', slot: 'trinket', tier: 4, price: 620, spell: 0.35, mp: 15 },
    berserker: { id: 'berserker', name: 'Berserker Idol',   icon: '😤', slot: 'trinket', tier: 4, price: 660, atk: 6, def: -2 },
    phoenix:   { id: 'phoenix',   name: 'Phoenix Feather',  icon: '🪶', slot: 'trinket', tier: 5, price: 900, hp: 20, regen: 2 },
    kingscrown:{ id: 'kingscrown',name: "King's Signet",    icon: '💍', slot: 'trinket', tier: 6, price: 3000, atk: 5, def: 5, hp: 30, greed: 0.5 },
    lucky:     { id: 'lucky',     name: 'Lucky Clover',     icon: '🍀', slot: 'trinket', tier: 4, crit: 0.08, greed: 0.3 } // easter-egg only (no price)
  };
  function gear(id) { return WEAPONS[id] || ARMORS[id] || TRINKETS[id] || null; }

  // consumables — kept as { id, qty } stacks in hero.bag
  var CONS = {
    potion:   { id: 'potion',   name: 'Health Potion',   icon: '🧪', price: 25, desc: 'Restore 45 HP' },
    hpotion:  { id: 'hpotion',  name: 'Greater Potion',  icon: '🍷', price: 70, desc: 'Restore 110 HP' },
    elixir:   { id: 'elixir',   name: 'Mana Elixir',     icon: '⚗️', price: 25, desc: 'Restore 30 MP' },
    eelixir:  { id: 'eelixir',  name: 'Greater Elixir',  icon: '🧉', price: 70, desc: 'Restore 70 MP' },
    bomb:     { id: 'bomb',     name: 'Bomb',            icon: '💣', price: 40, desc: 'Blast 1-tile radius (dmg + cracks walls)' },
    scroll:   { id: 'scroll',   name: 'Blink Scroll',    icon: '📜', price: 35, desc: 'Teleport to a random explored tile' },
    antidote: { id: 'antidote', name: 'Antidote',        icon: '🧴', price: 30, desc: 'Cure poison & burn' },
    key:      { id: 'key',      name: 'Skeleton Key',    icon: '🗝️', price: 60, desc: 'Opens one locked door' }
  };

  // Cosmetics — pure visual flair for your adventurer, bought at the Tailor.
  var COSMETIC = {
    color: {
      cyan:    { name: 'Azure',   body: '#5ec8e6', line: '#10333f', price: 0 },
      gold:    { name: 'Gilded',  body: '#e6c24a', line: '#4a3a10', price: 250 },
      crimson: { name: 'Crimson', body: '#e05d5d', line: '#3a1010', price: 250 },
      violet:  { name: 'Violet',  body: '#b07fe0', line: '#2a1040', price: 250 },
      emerald: { name: 'Emerald', body: '#5fd08a', line: '#103a22', price: 250 },
      rose:    { name: 'Rose',    body: '#e88ab8', line: '#401028', price: 350 },
      slate:   { name: 'Slate',   body: '#9aa6b4', line: '#1a2230', price: 350 },
      ember:   { name: 'Ember',   body: '#ff8a4a', line: '#401a08', price: 500 },
      void:    { name: 'Void',    body: '#6a5ad0', line: '#140a30', price: 800 }
    },
    hat: {
      none:   { name: '(no hat)',  price: 0 },
      wizard: { name: 'Wizard Hat', price: 300 },
      horns:  { name: 'Horns',     price: 350 },
      top:    { name: 'Top Hat',   price: 450 },
      halo:   { name: 'Halo',      price: 600 },
      crown:  { name: 'Crown',     price: 1200 }
    },
    cape: {
      none:   { name: '(no cape)',  price: 0 },
      red:    { name: 'Red Cape',   color: '#c0392b', price: 250 },
      blue:   { name: 'Blue Cape',  color: '#2e6da4', price: 250 },
      gold:   { name: 'Gold Cape',  color: '#d4a017', price: 400 },
      emerald:{ name: 'Emerald Cape', color: '#2f9e6a', price: 400 },
      shadow: { name: 'Shadow Cape',color: '#2a2440', price: 550 },
      royal:  { name: 'Royal Cape', color: '#6a3fb0', price: 700 }
    },
    eyes: {
      default: { name: 'Eyes',    price: 0 },
      cute:    { name: 'Cute',    price: 150 },
      angry:   { name: 'Fierce',  price: 150 },
      sleepy:  { name: 'Sleepy',  price: 150 },
      glow:    { name: 'Glowing', price: 400 },
      visor:   { name: 'Visor',   price: 500 }
    },
    pattern: {
      none:  { name: '(plain)',  price: 0 },
      belly: { name: 'Belly',    price: 150 },
      spots: { name: 'Spots',    price: 200 },
      stripe:{ name: 'Stripes',  price: 200 },
      rune:  { name: 'Runes',    price: 450 }
    },
    belt: {
      none:  { name: '(no belt)', price: 0 },
      brown: { name: 'Belt',      color: '#6b4a2a', price: 120 },
      gold:  { name: 'Gold Belt', color: '#d4a017', price: 280 },
      sash:  { name: 'Red Sash',  color: '#b03030', price: 280 }
    },
    pet: {
      none:  { name: '(no pet)',   price: 0 },
      cat:   { name: 'Cat',        price: 400, col: '#d0a060' },
      pup:   { name: 'Pup',        price: 400, col: '#b8956a' },
      slime: { name: 'Slimeling',  price: 500, col: '#6fd09a' },
      wisp:  { name: 'Wisp',       price: 700, col: '#bfe0ff' },
      drake: { name: 'Drakeling',  price: 1200, col: '#7fae5b' }
    }
  };
  var COS_SLOTS = ['color', 'eyes', 'pattern', 'belt', 'hat', 'cape', 'pet'];
  function cosKey(slot, id) { return slot + ':' + id; }

  // =========================================================================
  //  ITEM INSTANCES — base type + rarity + rolled affixes (multi-dimensional)
  // =========================================================================
  // Every dropped/bought piece is a unique instance with its own rolled stats,
  // so variety is effectively endless. The curated bases above supply the
  // "interesting" innate effects; affixes layer extra dimensions on top.
  var STAT_FIELDS = ['atk', 'def', 'hp', 'mp', 'crit', 'lifesteal', 'cleave', 'chain', 'spell', 'stun', 'freeze', 'poison', 'burn', 'dodge', 'thorns', 'resist', 'regen', 'greed'];
  var RARITY = {
    common:    { name: 'Common',    color: '#c8cdd6', n: 0 },
    magic:     { name: 'Magic',     color: '#6fb6ff', n: 1 },
    rare:      { name: 'Rare',      color: '#ffd24a', n: 2 },
    epic:      { name: 'Epic',      color: '#c77dff', n: 3 },
    legendary: { name: 'Legendary', color: '#ff8a3d', n: 0 }
  };
  var AFFIX_PRE = [
    { id: 'sharp',   name: 'Sharp',    field: 'atk',       flat: [1, 3] },
    { id: 'cruel',   name: 'Cruel',    field: 'atk',       flat: [3, 7] },
    { id: 'vicious', name: 'Vicious',  field: 'crit',      pct: [0.04, 0.10] },
    { id: 'vamp',    name: 'Vampiric', field: 'lifesteal', pct: [0.05, 0.12] },
    { id: 'arcane',  name: 'Arcane',   field: 'spell',     pct: [0.08, 0.20] },
    { id: 'flaming', name: 'Flaming',  field: 'burn',      pct: [0.20, 0.45] },
    { id: 'toxic',   name: 'Venomous', field: 'poison',    pct: [0.20, 0.45] },
    { id: 'glacial', name: 'Glacial',  field: 'freeze',    pct: [0.15, 0.30] },
    { id: 'brutal',  name: 'Brutal',   field: 'stun',      pct: [0.12, 0.28] }
  ];
  var AFFIX_SUF = [
    { id: 'bear',   name: 'of the Bear',   field: 'hp',     flat: [8, 20] },
    { id: 'owl',    name: 'of the Owl',    field: 'mp',     flat: [8, 20] },
    { id: 'turtle', name: 'of the Turtle', field: 'def',    flat: [1, 4] },
    { id: 'cat',    name: 'of the Cat',    field: 'dodge',  pct: [0.04, 0.10] },
    { id: 'troll',  name: 'of the Troll',  field: 'regen',  flat: [1, 2] },
    { id: 'magpie', name: 'of Greed',      field: 'greed',  pct: [0.10, 0.30] },
    { id: 'golem',  name: 'of Warding',    field: 'resist', pct: [0.05, 0.12] },
    { id: 'giant',  name: 'of the Giant',  field: 'atk',    flat: [2, 5] }
  ];
  var LEGENDARY = {
    gravewhisper:  { base: 'runeblade',  name: 'Gravewhisper, the Last Lament', lore: 'It remembers every life it has taken.', stats: { atk: 16, crit: 0.20, lifesteal: 0.25 } },
    sunderbrand:   { base: 'battleaxe',  name: 'Sunderbrand',                   lore: 'No shield has ever turned it.',         stats: { atk: 20, cleave: 0.6, stun: 0.25 } },
    stormcaller:   { base: 'thundermaul',name: 'Stormcaller',                   lore: 'The sky answers when it swings.',       stats: { atk: 17, chain: 0.8, stun: 0.30 } },
    emberheart:    { base: 'archstaff',  name: 'Emberheart',                    lore: 'A caged sun, furious to be free.',      stats: { atk: 10, spell: 0.70, burn: 0.6, mp: 30 } },
    lastdawn:      { base: 'aegis',      name: 'Aegis of the Last Dawn',        lore: 'It outlasted the kingdom that forged it.', stats: { def: 16, hp: 40, resist: 0.20 } },
    whisperstep:   { base: 'shadowcloak',name: 'Whisperstep',                   lore: 'You will not hear them coming.',        stats: { def: 8, dodge: 0.30, crit: 0.10 } },
    mountainheart: { base: 'kingscrown', name: 'Heart of the Mountain',         lore: 'Patient. Immovable. Eternal.',          stats: { hp: 40, def: 8, thorns: 0.30 } },
    covetous:      { base: 'greed',      name: 'The Covetous Eye',              lore: 'It wants. It always wants more.',       stats: { greed: 0.80, crit: 0.12, lifesteal: 0.12, def: -3 } }
  };

  var _uidc = 0;
  function uid() { return 'i' + Date.now().toString(36) + (_uidc++).toString(36); }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = ri(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function rarityOf(it) { return RARITY[it && it.rarity] || RARITY.common; }
  function makeBaseInstance(baseId, rarity, ilvl) {
    var b = gear(baseId); if (!b) return null;
    var inst = { uid: uid(), base: baseId, slot: b.slot, icon: b.icon, tier: b.tier, rarity: rarity || 'common', ilvl: ilvl || 1, stats: {} };
    for (var i = 0; i < STAT_FIELDS.length; i++) { var f = STAT_FIELDS[i]; if (b[f]) inst.stats[f] = b[f]; }
    inst.name = instanceName(inst);
    return inst;
  }
  function rollAffix(a, ilvl) {
    if (a.flat) return { field: a.field, name: a.name, val: rr(a.flat[0], a.flat[1]) + Math.floor((ilvl || 1) / 4) };
    var v = a.pct[0] + Math.random() * (a.pct[1] - a.pct[0]);
    return { field: a.field, name: a.name, val: Math.round(v * 100) / 100 };
  }
  function applyAffixes(inst, n, ilvl) {
    inst.affixes = [];
    var pres = shuffle(AFFIX_PRE.slice()), sufs = shuffle(AFFIX_SUF.slice()), pi = 0, si = 0;
    for (var k = 0; k < n; k++) {
      var usePre = (k % 2 === 0), a = usePre ? pres[pi++] : sufs[si++];
      if (!a) { a = pres[pi++] || sufs[si++]; usePre = true; }
      if (!a) break;
      var r = rollAffix(a, ilvl);
      inst.stats[r.field] = Math.round(((inst.stats[r.field] || 0) + r.val) * 100) / 100;
      inst.affixes.push(r);
      if (usePre && !inst.pre) inst.pre = a.name; else if (!usePre && !inst.suf) inst.suf = a.name;
    }
  }
  function instanceName(inst) {
    if (inst.legend) return inst.name;
    var bn = (gear(inst.base) || {}).name || 'Relic';
    if (inst.rarity === 'common') return bn;
    return (inst.pre ? inst.pre + ' ' : '') + bn + (inst.suf ? ' ' + inst.suf : '');
  }
  function makeLegendary(legId, ilvl) {
    var L = LEGENDARY[legId]; if (!L) return null;
    var b = gear(L.base) || {};
    var inst = { uid: uid(), base: L.base, slot: b.slot, icon: b.icon, tier: 6, rarity: 'legendary', ilvl: ilvl || 10, legend: legId, name: L.name, lore: L.lore, stats: {} };
    for (var f in L.stats) inst.stats[f] = L.stats[f];
    return inst;
  }
  function rollRarity(luck) {
    var r = Math.random() * 100;
    var leg = 0.6 + (luck || 0);          // legendary % (boss drops pass extra luck)
    var epic = 5 + (luck || 0) * 2, rare = 16, magic = 34;
    if (r < leg) return 'legendary';
    if (r < leg + epic) return 'epic';
    if (r < leg + epic + rare) return 'rare';
    if (r < leg + epic + rare + magic) return 'magic';
    return 'common';
  }
  function baseForSlot(slot, ilvl) {
    var tbl = slot === 'weapon' ? WEAPONS : slot === 'armor' ? ARMORS : TRINKETS;
    var maxTier = 1 + Math.ceil(ilvl / 2), pool = [];
    for (var id in tbl) { var g = tbl[id]; if (g.tier > 0 && g.price && g.tier <= maxTier) pool.push(id); }
    return pool.length ? pick(pool) : (slot === 'weapon' ? 'dagger' : slot === 'armor' ? 'leather' : 'ringreg');
  }
  function generateItem(slot, ilvl, luck) {
    slot = slot || pick(['weapon', 'armor', 'trinket']);
    var rarity = rollRarity(luck);
    if (rarity === 'legendary') {
      var legs = []; for (var k in LEGENDARY) if ((gear(LEGENDARY[k].base) || {}).slot === slot) legs.push(k);
      if (legs.length) return makeLegendary(pick(legs), ilvl);
      rarity = 'epic';
    }
    var inst = makeBaseInstance(baseForSlot(slot, ilvl), rarity, ilvl);
    applyAffixes(inst, RARITY[rarity].n, ilvl);
    inst.name = instanceName(inst);
    return inst;
  }
  function itemScore(it) {
    if (!it) return -1; var s = it.stats;
    return (s.atk || 0) * 3 + (s.def || 0) * 3 + (s.hp || 0) * 0.4 + (s.mp || 0) * 0.3 + (s.crit || 0) * 40 +
      (s.lifesteal || 0) * 40 + (s.spell || 0) * 25 + (s.dodge || 0) * 45 + (s.resist || 0) * 35 + (s.thorns || 0) * 20 +
      (s.regen || 0) * 5 + (s.greed || 0) * 8 + (s.cleave || 0) * 12 + (s.chain || 0) * 12 + (it.rarity === 'legendary' ? 25 : 0);
  }
  function itemPrice(it) {
    var b = gear(it.base) || {}, mult = { common: 1, magic: 1.9, rare: 3.2, epic: 5.5, legendary: 12 }[it.rarity] || 1;
    return Math.max(8, Math.round((b.price || 25) * mult + (it.ilvl || 1) * 4));
  }
  function itemSell(it) { return Math.max(1, Math.floor(itemPrice(it) * 0.4)); }
  function itemByUid(u) { if (!u || !hero.owned) return null; for (var i = 0; i < hero.owned.length; i++) if (hero.owned[i].uid === u) return hero.owned[i]; return null; }
  function equippedItem(slot) { return itemByUid(hero.equip[slot]); }
  function instanceStatStr(it) {
    var s = it.stats, out = [];
    function add(f, label, pct) { if (s[f]) out.push((s[f] > 0 && f !== 'def' && f !== 'atk' ? '+' : (s[f] > 0 ? '+' : '')) + (pct ? Math.round(s[f] * 100) + '%' : s[f]) + ' ' + label); }
    add('atk', 'atk'); add('def', 'def'); add('hp', 'hp'); add('mp', 'mp');
    add('crit', 'crit', 1); add('lifesteal', 'lifesteal', 1); add('spell', 'spell', 1);
    if (s.cleave) out.push('cleave'); if (s.chain) out.push('chain');
    if (s.stun) out.push('stun ' + Math.round(s.stun * 100) + '%'); if (s.freeze) out.push('freeze ' + Math.round(s.freeze * 100) + '%');
    if (s.poison) out.push('poison'); if (s.burn) out.push('burn');
    add('dodge', 'dodge', 1); if (s.thorns) out.push('thorns ' + Math.round(s.thorns * 100) + '%'); add('resist', 'resist', 1);
    if (s.regen) out.push('regen ' + s.regen); add('greed', 'gold', 1);
    return out.join(' · ');
  }
  function rarityTag(it) { var c = rarityOf(it); return '<span style="color:' + c.color + '">' + (it.rarity === 'common' ? '' : c.name + ' ') + '</span>'; }

  // Spells — cost MP, have cooldowns. learn:'auto' is taught on reaching its
  // level; learn:'tome' must be bought at the Arcanist. You can DOCK up to
  // DOCK_MAX of your known spells onto the action bar at once.
  var DOCK_MAX = 4;
  var ABIL = {
    strike: { id: 'strike', name: 'Power Strike', icon: '💥', lvl: 1, mp: 4,  cd: 1, kind: 'melee', learn: 'auto', desc: 'Heavy adjacent hit (×2.2 ATK), may stun.' },
    bolt:   { id: 'bolt',   name: 'Firebolt',     icon: '🔥', lvl: 3, mp: 6,  cd: 2, kind: 'ray',   range: 6, burn: true, learn: 'auto', desc: 'Bolt along your facing; burns the first foe hit.' },
    mend:   { id: 'mend',   name: 'Mend',         icon: '✨', lvl: 4, mp: 8,  cd: 4, kind: 'self',  learn: 'auto', desc: 'Heal 35% of max HP.' },
    blink:  { id: 'blink',  name: 'Blink',        icon: '🌀', lvl: 6, mp: 5,  cd: 3, kind: 'move',  range: 4, learn: 'auto', desc: 'Dash up to 4 tiles ahead, slipping past danger.' },
    quake:  { id: 'quake',  name: 'Quake',        icon: '🌋', lvl: 8, mp: 12, cd: 5, kind: 'aoe',   range: 2, stun: true, learn: 'auto', desc: 'Damage + stun every foe around you.' },
    // ---- tome spells (buy at the Arcanist) ----
    frost:  { id: 'frost',  name: 'Frost Lance',  icon: '❄️', lvl: 3, mp: 7,  cd: 2, kind: 'ray',   range: 6, freeze: true, learn: 'tome', price: 220, desc: 'Pierces your facing; freezes the foe hit.' },
    shield: { id: 'shield', name: 'Aegis',        icon: '🛡️', lvl: 4, mp: 6,  cd: 6, kind: 'buff',  buff: 'shield', turns: 6, learn: 'tome', price: 260, desc: 'Halve incoming damage for 6 turns.' },
    drain:  { id: 'drain',  name: 'Life Drain',   icon: '🩸', lvl: 5, mp: 7,  cd: 2, kind: 'ray',   range: 5, drain: true, learn: 'tome', price: 320, desc: 'Ray that heals you for the damage dealt.' },
    warcry: { id: 'warcry', name: 'War Cry',      icon: '📣', lvl: 5, mp: 6,  cd: 6, kind: 'buff',  buff: 'power', turns: 6, learn: 'tome', price: 300, desc: 'Greatly raise ATK for 6 turns.' },
    venom:  { id: 'venom',  name: 'Venom Nova',   icon: '☠️', lvl: 6, mp: 10, cd: 4, kind: 'aoe',   range: 2, poison: true, learn: 'tome', price: 400, desc: 'Poison every foe around you.' },
    chain:  { id: 'chain',  name: 'Chain Lightning', icon: '⚡', lvl: 7, mp: 10, cd: 3, kind: 'chainspell', range: 6, learn: 'tome', price: 460, desc: 'Strikes a foe, then arcs to others nearby.' },
    meteor: { id: 'meteor', name: 'Meteor',       icon: '☄️', lvl: 9, mp: 16, cd: 6, kind: 'aoe',   range: 2, big: true, burn: true, learn: 'tome', price: 760, desc: 'A massive blast + burn around you.' }
  };
  var ABIL_ORDER = ['strike', 'bolt', 'frost', 'drain', 'mend', 'shield', 'warcry', 'venom', 'blink', 'chain', 'quake', 'meteor'];
  function dockedSpells() { return (hero.docked || []).filter(function (id) { return ABIL[id] && hero.spells && hero.spells.indexOf(id) >= 0; }); }
  function knowsSpell(id) { return hero.spells && hero.spells.indexOf(id) >= 0; }
  function learnSpell(id) {
    if (!ABIL[id]) return false;
    hero.spells = hero.spells || [];
    if (hero.spells.indexOf(id) >= 0) return false;
    hero.spells.push(id);
    hero.docked = hero.docked || [];
    if (hero.docked.length < DOCK_MAX) hero.docked.push(id);
    return true;
  }

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
    wraith: { ch: 'w', name: 'wraith',       col: '#9fd8e0', hp: 30, atk: 8,  def: 2, xp: 30, minD: 9, behavior: 'chase', erratic: 0.2 },
    mimic:  { ch: 'M', name: 'mimic',        col: '#caa24a', hp: 26, atk: 7,  def: 2, xp: 26, minD: 99, behavior: 'chase' }, // spawned only from trapped chests
    // ---- region-themed foes ----
    wolf:    { ch: 'f', name: 'dire wolf',   col: '#b8a890', hp: 12, atk: 4, def: 0, xp: 9,  minD: 6,  behavior: 'chase', erratic: 0.15 },
    spider:  { ch: 'x', name: 'cave spider', col: '#a07fd0', hp: 10, atk: 3, def: 0, xp: 10, minD: 6,  behavior: 'chase', poison: true },
    scorpion:{ ch: 'z', name: 'scorpion',    col: '#e0b060', hp: 16, atk: 4, def: 1, xp: 13, minD: 16, behavior: 'chase', poison: true },
    sandshade:{ ch: 'h', name: 'sand shade', col: '#e8d28a', hp: 12, atk: 5, def: 0, xp: 15, minD: 16, behavior: 'archer', range: 5 },
    imp:     { ch: 'i', name: 'cinder imp',  col: '#ff8a50', hp: 12, atk: 5, def: 0, xp: 14, minD: 21, behavior: 'chase', erratic: 0.1, burn: true },
    magmite: { ch: 'q', name: 'magmite',     col: '#e85d3d', hp: 14, atk: 3, def: 1, xp: 13, minD: 21, behavior: 'bomber', boom: 12 },
    crab:    { ch: 'c', name: 'shell crab',  col: '#5fd0c0', hp: 30, atk: 5, def: 5, xp: 18, minD: 26, behavior: 'chase' },
    siren:   { ch: 'y', name: 'siren',       col: '#7fd0e0', hp: 18, atk: 6, def: 1, xp: 22, minD: 26, behavior: 'archer', range: 6 }
  };

  // =========================================================================
  //  WORLD — ordered regions (a travel map of themed acts), each a 5-floor band
  // =========================================================================
  var REGIONS = [
    { key: 'catacombs', name: 'The Catacombs', icon: '💀', blurb: 'Where the delve begins — bone and dust.',
      pal: { floor: '#23201c', floor2: '#2a261f', wall: '#4a4038', wallTop: '#5a4e44', accent: '#c9a86b' },
      mobs: ['rat', 'bat', 'kobold', 'goblin', 'archer', 'slime', 'thief'],
      boss: { ch: 'K', name: 'The Bone King', col: '#f0e6c0', hp: 90, atk: 9, def: 3, xp: 120, behavior: 'summon', summons: 'archer' } },
    { key: 'wood', name: 'The Whispering Wood', icon: '🌲', blurb: 'Roots that remember; eyes in the canopy.',
      pal: { floor: '#1c241a', floor2: '#22301f', wall: '#2f4a2c', wallTop: '#3c5e38', accent: '#8fd06f' },
      mobs: ['wolf', 'spider', 'goblin', 'bat', 'archer', 'thief'], hazard: 'bramble',
      boss: { ch: 'Y', name: 'The Elder Treant', col: '#9fd060', hp: 170, atk: 12, def: 5, xp: 230, behavior: 'summon', summons: 'spider' } },
    { key: 'caves', name: 'The Sunless Caves', icon: '🕯️', blurb: 'A cold dark that drinks your torchlight.',
      pal: { floor: '#1a2226', floor2: '#1f2a30', wall: '#33474d', wallTop: '#3f5860', accent: '#5fc0d0' },
      mobs: ['bat', 'spider', 'slime', 'troll', 'kobold', 'archer'],
      boss: { ch: 'V', name: 'The Venom Matriarch', col: '#7fe0a0', hp: 240, atk: 15, def: 5, xp: 360, behavior: 'archer', range: 7, poison: true } },
    { key: 'desert', name: 'The Scorched Desert', icon: '🏜️', blurb: 'Endless dunes over a buried, hungry city.',
      pal: { floor: '#2c2614', floor2: '#332c18', wall: '#5a4a28', wallTop: '#6e5a30', accent: '#e0c060' },
      mobs: ['scorpion', 'sandshade', 'kobold', 'orc', 'thief', 'mage'], hazard: 'quicksand',
      boss: { ch: 'P', name: 'The Dune Pharaoh', col: '#e8d060', hp: 300, atk: 16, def: 6, xp: 480, behavior: 'archer', range: 7, poison: true } },
    { key: 'ember', name: 'The Emberforge', icon: '🌋', blurb: 'Stone runs like water; the air is fire.',
      pal: { floor: '#241410', floor2: '#2c1a14', wall: '#4a2a20', wallTop: '#5e3422', accent: '#e86040' },
      mobs: ['imp', 'magmite', 'orc', 'troll', 'mage'], hazard: 'lava',
      boss: { ch: 'M', name: 'The Magma Tyrant', col: '#ff7040', hp: 380, atk: 19, def: 7, xp: 640, behavior: 'chase', boom: 0 } },
    { key: 'coast', name: 'The Drowned Coast', icon: '🌊', blurb: 'Tides that never recede; songs that pull you under.',
      pal: { floor: '#122428', floor2: '#163036', wall: '#234a52', wallTop: '#2f5e66', accent: '#4fd0c0' },
      mobs: ['crab', 'siren', 'slime', 'wraith', 'mage'], hazard: 'brine',
      boss: { ch: 'T', name: 'The Tidemother', col: '#5fd0e0', hp: 440, atk: 21, def: 8, xp: 820, behavior: 'archer', range: 8, poison: true } },
    { key: 'abyss', name: 'The Abyss', icon: '🌀', blurb: 'The bottom of everything. It looks back.',
      pal: { floor: '#1c182a', floor2: '#231d33', wall: '#352c50', wallTop: '#443862', accent: '#a87fe0' },
      mobs: ['wraith', 'mage', 'orc', 'troll', 'slime', 'archer'], hazard: 'voidfire',
      boss: { ch: 'Ω', name: 'The Deep One', col: '#c08fe0', hp: 520, atk: 24, def: 9, xp: 1100, behavior: 'summon', summons: 'wraith' } }
  ];
  var REGION_SPAN = 5;
  function regionIndexAt(depth) { return clamp(Math.floor((depth - 1) / REGION_SPAN), 0, REGIONS.length - 1); }
  function regionAt(depth) { return REGIONS[regionIndexAt(depth)]; }
  function regionStart(idx) { return idx * REGION_SPAN + 1; }
  function regionEnd(idx) { return (idx + 1) * REGION_SPAN; }
  function regionUnlocked(idx) { return idx === 0 || (hero && hero.maxDepth >= regionStart(idx)); }
  function biomeFor(depth) {
    if (depth <= 0) return { name: 'Hearthhold (Town)', floor: '#262a22', floor2: '#2c3027', wall: '#3a4030', wallTop: '#48503c', accent: '#8fbf6f' };
    var r = regionAt(depth), p = r.pal;
    return { name: r.name, floor: p.floor, floor2: p.floor2, wall: p.wall, wallTop: p.wallTop, accent: p.accent };
  }
  // hazard styling per region
  var HAZARDS = {
    bramble:  { ch: '✶', col: '#7fae5b', dmg: 3, status: 'poison', name: 'brambles' },
    quicksand:{ ch: '∴', col: '#cbb068', dmg: 2, status: null,     name: 'quicksand' },
    lava:     { ch: '≈', col: '#ff6a30', dmg: 9, status: 'burn',   name: 'lava' },
    brine:    { ch: '≈', col: '#4fd0c0', dmg: 3, status: null,     name: 'brine' },
    voidfire: { ch: '✷', col: '#b07fe0', dmg: 7, status: 'burn',   name: 'void-fire' }
  };

  // =========================================================================
  //  the hero (persistent character)
  // =========================================================================
  function freshHero() {
    var d = makeBaseInstance('dagger', 'common', 2), r = makeBaseInstance('rags', 'common', 1);
    return {
      v: 4,
      name: 'Delver',
      level: 1, xp: 0,
      maxHp: 30, hp: 30, maxMp: 12, mp: 12,
      atk: 4, def: 0, crit: 0.05,
      gold: 0,
      depth: 0, maxDepth: 0,        // current location depth (0 = town), and deepest reached
      equip: { weapon: d.uid, armor: r.uid, trinket: null },
      bag: { potion: 2, elixir: 1, bomb: 0, scroll: 0, key: 0 },
      owned: [d, r],               // item instances; equip references their uids
      spells: ['strike'], docked: ['strike'],
      cosmetics: { color: 'cyan', eyes: 'default', pattern: 'none', belt: 'none', hat: 'none', cape: 'none', pet: 'none' },
      ownedCos: [],
      quests: [], questsDone: 0,
      difficulty: 'normal',
      buffs: {},
      stats: { kills: 0, deaths: 0, floors: 0, gems: 0, runs: 0 },
      createdAt: Date.now(), updatedAt: Date.now(), rev: 1, client: clientId
    };
  }
  function xpForLevel(l) { return 16 + (l - 1) * (l - 1) * 9 + (l - 1) * 14; }

  // derived stats from base + equipment
  function eqVal(slot, field) { var it = equippedItem(slot); return it ? (it.stats[field] || 0) : 0; }
  function powerBonus() { return 3 + Math.ceil(hero.level / 2); }
  function atkOf() { var a = hero.atk + eqVal('weapon', 'atk') + eqVal('trinket', 'atk'); if (hero.buffs && hero.buffs.power > 0) a += powerBonus(); return a; }
  function defOf() { return hero.def + eqVal('armor', 'def') + eqVal('trinket', 'def'); }
  function critOf() { return clamp(hero.crit + eqVal('weapon', 'crit') + eqVal('trinket', 'crit'), 0, 0.75); }
  function maxHpOf() { return hero.maxHp + eqVal('armor', 'hp') + eqVal('trinket', 'hp'); }
  function maxMpOf() { return hero.maxMp + eqVal('weapon', 'mp') + eqVal('armor', 'mp') + eqVal('trinket', 'mp'); }
  function regenOf() { return eqVal('trinket', 'regen'); }
  function greedOf() { return 1 + eqVal('trinket', 'greed'); }
  function lifestealOf() { return eqVal('weapon', 'lifesteal') + eqVal('trinket', 'lifesteal'); }
  function spellPowerOf() { return 1 + eqVal('weapon', 'spell') + eqVal('armor', 'spell') + eqVal('trinket', 'spell'); }
  function dodgeOf() { return clamp(eqVal('armor', 'dodge') + eqVal('trinket', 'dodge'), 0, 0.6); }
  function thornsOf() { return eqVal('armor', 'thorns'); }
  function resistOf() { return clamp(eqVal('armor', 'resist'), 0, 0.6); }

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
      var newly = ABIL_ORDER.filter(function (id) { return ABIL[id].learn === 'auto' && ABIL[id].lvl === hero.level; });
      newly.forEach(function (id) { if (learnSpell(id)) logMsg('up', 'Learned ' + ABIL[id].name + '!'); });
      if (newly.length) buildAbilityBar();
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
    // Show it as a transient line that fades out on its own (not a sticky toast).
    if (ui && ui.log) {
      var line = document.createElement('div');
      line.className = 'cr-line cr-' + (kind || '');
      line.textContent = text;
      ui.log.appendChild(line);
      while (ui.log.children.length > 3) ui.log.removeChild(ui.log.firstChild);
      setTimeout(function () { if (line.parentNode) line.parentNode.removeChild(line); }, 4200);
    }
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

    // Spawn & stairs first, so the placement predicate can reserve them and
    // nothing (monster/trap/chest/item) lands on the player or on the stairs.
    var start = center(rooms[0]);
    var stairsRoom = rooms[rooms.length - 1];
    var st = center(stairsRoom);
    var stairs = { x: st.x, y: st.y, up: false };

    var isBoss = depth > 0 && depth % 5 === 0;

    var occupied = function (x, y) {
      if (x === start.x && y === start.y) return true;
      if (!isBoss && x === stairs.x && y === stairs.y) return true; // boss spawns ON the stairs deliberately
      for (var i = 0; i < monsters.length; i++) if (monsters[i].x === x && monsters[i].y === y) return true;
      for (var j = 0; j < items.length; j++) if (items[j].x === x && items[j].y === y) return true;
      for (var o = 0; o < objects.length; o++) if (objects[o].x === x && objects[o].y === y) return true;
      return false;
    };

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

    // ---- chests (some are mimics that bite back) ----------------------------
    var chestN = isBoss ? 1 : 1 + ri(2);
    for (var ch = 0; ch < chestN; ch++) {
      var cp = freeFloorIn(m, occupied);
      if (cp) objects.push({ type: 'chest', x: cp.x, y: cp.y, opened: false, mimic: (depth >= 2 && chance(0.16)) });
    }

    // ---- shrine (one-time blessing) -----------------------------------------
    if (!isBoss && depth >= 2 && chance(0.5)) {
      var shp = freeFloorIn(m, occupied);
      if (shp) objects.push({ type: 'shrine', x: shp.x, y: shp.y, used: false });
    }

    // ---- monsters (roster comes from the region) ----------------------------
    var region = regionAt(depth);
    if (isBoss) {
      var ridx = regionIndexAt(depth);
      var loops = Math.floor(depth / (REGION_SPAN * REGIONS.length)); // deeper laps scale the boss up
      var scale = 1 + ridx * 0.18 + loops * 1.2;
      monsters.push(makeMob(region.boss, st.x, st.y, true, scale, depth));
      var guard = region.mobs[region.mobs.length - 1];
      for (var bg = 0; bg < 2; bg++) { var gp = freeFloorIn(m, occupied, null); if (gp) monsters.push(makeMob(MOBS[guard], gp.x, gp.y, false, 1 + depth * 0.06, depth)); }
    } else {
      var avail = region.mobs;
      var mcount = 4 + Math.floor(depth * 1.3);
      for (var mi = 0; mi < mcount; mi++) {
        var sp = freeFloorIn(m, occupied);
        if (!sp) continue;
        var idp = avail[clamp(ri(avail.length) + (chance(0.3) ? 1 : 0), 0, avail.length - 1)];
        var mob = makeMob(MOBS[idp], sp.x, sp.y, false, 1 + depth * 0.05, depth);
        if (depth >= 2 && chance((0.08 + depth * 0.008) * diff().elite)) eliteify(mob);
        monsters.push(mob);
      }
    }
    // ---- region hazard patches ----------------------------------------------
    if (!isBoss && region.hazard) {
      var hazN = 3 + ri(5 + Math.floor(depth / 4));
      for (var hz = 0; hz < hazN; hz++) { var hp2 = freeFloorIn(m, occupied); if (hp2) objects.push({ type: 'hazard', kind: region.hazard, x: hp2.x, y: hp2.y }); }
    }

    // ---- loot items ---------------------------------------------------------
    var potN = 2 + ri(2);
    for (var pi = 0; pi < potN; pi++) { var s1 = freeFloorIn(m, occupied); if (s1) items.push({ type: 'cons', id: chance(0.7) ? 'potion' : 'elixir', x: s1.x, y: s1.y }); }
    var goldN = 2 + ri(3);
    for (var gi = 0; gi < goldN; gi++) { var s2 = freeFloorIn(m, occupied); if (s2) items.push({ type: 'gold', x: s2.x, y: s2.y, amt: (3 + ri(5)) * Math.max(1, Math.ceil(depth * 0.6)) }); }
    if (chance(0.45)) { var s3 = freeFloorIn(m, occupied); if (s3) items.push({ type: 'gem', x: s3.x, y: s3.y }); }
    // occasional gear drop on the floor
    if (chance(0.35)) { var s4 = freeFloorIn(m, occupied); if (s4) items.push({ type: 'gear', item: generateItem(null, depth), x: s4.x, y: s4.y }); }

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
    var dm = diff(), hp = Math.round(def.hp * scale * dm.hp);
    return {
      x: x, y: y, rx: x, ry: y, ch: def.ch, name: def.name, col: def.col,
      hp: hp, maxHp: hp,
      atk: Math.max(1, Math.round(def.atk * (boss ? scale : Math.min(scale, 1 + depth * 0.04)) * dm.atk)), def: def.def || 0,
      xp: Math.round(def.xp * (boss ? 1 : scale)), behavior: def.behavior, range: def.range || 1,
      erratic: def.erratic || 0, boom: def.boom || 0, regen: def.regen || 0,
      summons: def.summons || null, burn: !!def.burn, poison: !!def.poison,
      boss: !!boss, status: {}, awake: false, hit: 0, bump: 0
    };
  }
  // ---- elite monsters: random affixes, tougher, better loot -----------------
  var ELITE_AFFIX = [
    { id: 'tough',     name: 'Tough',     fn: function (m) { m.maxHp = Math.round(m.maxHp * 1.8); m.hp = m.maxHp; } },
    { id: 'fierce',    name: 'Fierce',    fn: function (m) { m.atk = Math.round(m.atk * 1.5); } },
    { id: 'swift',     name: 'Swift',     fn: function (m) { m.swift = true; } },
    { id: 'venomous',  name: 'Venomous',  fn: function (m) { m.poison = true; } },
    { id: 'fiery',     name: 'Fiery',     fn: function (m) { m.burn = true; } },
    { id: 'vampiric',  name: 'Vampiric',  fn: function (m) { m.vamp = true; } },
    { id: 'explosive', name: 'Explosive', fn: function (m) { m.boom = Math.max(m.boom || 0, 10); } },
    { id: 'warded',    name: 'Warded',    fn: function (m) { m.ward = 0.4; } }
  ];
  function eliteify(m) {
    m.elite = true; m.eliteAffix = [];
    var pool = shuffle(ELITE_AFFIX.slice()), n = 1 + (chance(0.4) ? 1 : 0);
    for (var i = 0; i < n && i < pool.length; i++) { pool[i].fn(m); m.eliteAffix.push(pool[i].name); }
    m.name = m.eliteAffix.join(' ') + ' ' + m.name;
    m.xp = Math.round(m.xp * 2.2);
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
    objects.push({ type: 'npc', role: 'healer',   x: 10, y: 12, icon: '⛑️', col: '#ff8a8a', name: 'Healer',   cos: { color: 'rose', eyes: 'cute', belt: 'brown' } });
    objects.push({ type: 'npc', role: 'merchant', x: 16, y: 12, icon: '🛒', col: '#ffd76a', name: 'Merchant', cos: { color: 'gold', eyes: 'default', hat: 'top' } });
    objects.push({ type: 'npc', role: 'smith',    x: 24, y: 12, icon: '⚒️', col: '#a0c0ff', name: 'Smith',    cos: { color: 'slate', eyes: 'angry', belt: 'brown', pattern: 'belly' } });
    objects.push({ type: 'npc', role: 'arcanist', x: 30, y: 12, icon: '🔮', col: '#c79bff', name: 'Arcanist', cos: { color: 'violet', eyes: 'glow', hat: 'wizard' } });
    objects.push({ type: 'npc', role: 'quest',    x: 13, y: 19, icon: '📜', col: '#e0c060', name: 'Bounties', cos: { color: 'ember', eyes: 'default', cape: 'red' } });
    objects.push({ type: 'npc', role: 'tailor',   x: 27, y: 19, icon: '🎩', col: '#9fe0c0', name: 'Tailor',   cos: { color: 'emerald', eyes: 'default', hat: 'top', belt: 'gold' } });
    objects.push({ type: 'stairs', x: 20, y: 23, down: true });
    var stairs = { x: 20, y: 23, up: false };
    var start = { x: 20, y: 16 };
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
    hero.status = {}; hero.buffs = {};      // clear DoTs & buffs between areas
    if (depth <= 0) merchStock = null;      // merchant restocks each town visit
    if (depth > hero.maxDepth) { hero.maxDepth = depth; }
    // wake in town with half vitals if we arrived dead
    if (depth <= 0 && hero.hp <= 0) { hero.hp = Math.ceil(maxHpOf() * 0.5); hero.mp = Math.ceil(maxMpOf() * 0.5); }
    // ensure hp/mp within caps
    hero.hp = clamp(hero.hp, 0, maxHpOf()); hero.mp = clamp(hero.mp, 0, maxMpOf());
    computeFov();
    if (depth <= 0) { logMsg('', 'Hearthhold. Rest, shop, then descend ▾.'); }
    else {
      hero.stats.floors++; questDepth(depth);
      var rg = regionAt(depth);
      if (depth === regionStart(regionIndexAt(depth))) logMsg('win', rg.icon + ' ' + rg.name + ' — ' + rg.blurb);
      logMsg('', (w.isBoss ? '⚠ ' : '') + rg.name + ' · Floor ' + depth + (w.isBoss ? '. ' + rg.boss.name + ' awaits.' : '.'));
      if (w.puzzle) logMsg('', w.puzzle.kind === 'lever' ? 'The stairs are barred. Find the lever.' : 'A locked door blocks the way. Find the key.');
    }
    markDirty();
    buildAbilityBar();   // keep the bar in sync with the hero's level (e.g. after a cross-device sync)
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
  function recall() {
    if (!hero || !world) return;
    if (world.mode === 'town') { Cade.showToast('Already in town', 'info', 1000); return; }
    if (world.mode === 'dead') { enter(0); return; }
    logMsg('', 'You slip away to town.');
    enter(0);
  }

  // =========================================================================
  //  field of view (LOS-limited torch)
  // =========================================================================
  function opaqueObjAt(x, y) {
    for (var i = 0; i < world.objects.length; i++) { var o = world.objects[i]; if (o.x === x && o.y === y) {
      if (o.type === 'gate' && !o.open) return true;
      if (o.type === 'door' && o.locked) return true;
    } }
    return false;
  }
  function blocksSight(x, y) { return !world.map[y] || world.map[y][x] !== T_FLOOR || opaqueObjAt(x, y); }
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
    if (m.ward) dmg = Math.max(1, Math.ceil(dmg * (1 - m.ward)));
    m.hp -= dmg; m.hit = now();
    fxText(m.x, m.y, '-' + dmg, color || '#ffd2d2');
    if (m.hp <= 0) killMob(m, kind);
  }
  function killMob(m, kind) {
    var idx = world.monsters.indexOf(m); if (idx < 0) return;
    world.monsters.splice(idx, 1);
    hero.stats.kills++; questProgress('kills', 1);
    fxBurst(m.x, m.y, m.col);
    gainXp(Math.round(m.xp * diff().rew));
    if (m.elite) { logMsg('win', 'Elite slain: ' + m.name + '!'); var ep = adjacentFree(m.x, m.y) || { x: m.x, y: m.y }; world.items.push({ type: 'gear', item: generateItem(null, world.depth + 2, 1.2), x: ep.x, y: ep.y }); world.items.push({ type: 'gold', x: m.x, y: m.y, amt: (6 + ri(8)) * Math.max(1, world.depth) }); }
    if (m.boss) { questProgress('boss', 1); logMsg('win', 'The ' + m.name + ' falls! The way down opens.'); shake(10);
      // boss drops: gold + guaranteed gear + gem
      world.items.push({ type: 'gold', x: m.x, y: m.y, amt: 40 + world.depth * 7 });
      var gp = adjacentFree(m.x, m.y); if (gp) world.items.push({ type: 'gear', item: generateItem(null, world.depth + 3, 2.5), x: gp.x, y: gp.y });
      hero.stats.gems++;
    } else {
      // bomber explodes on death
      if (m.boom) explodeAt(m.x, m.y, m.boom, '#5fc08e');
      // a slain cutpurse drops whatever gold it pocketed
      if (m._loot) world.items.push({ type: 'gold', x: m.x, y: m.y, amt: m._loot });
      if (chance(0.18)) world.items.push({ type: 'cons', id: chance(0.6) ? 'potion' : 'elixir', x: m.x, y: m.y });
      if (chance(0.35)) world.items.push({ type: 'gold', x: m.x, y: m.y, amt: (2 + ri(4)) * Math.max(1, Math.ceil(world.depth * 0.5)) });
    }
    markDirty();
  }
  function adjacentFree(x, y) {
    var nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (var i = 0; i < nb.length; i++) if (walkable(nb[i][0], nb[i][1]) && !mobAt(nb[i][0], nb[i][1])) return { x: nb[i][0], y: nb[i][1] };
    return null;
  }
  function lifestealHeal(dmg) {
    var ls = lifestealOf(); if (!ls || dmg <= 0) return;
    if (hero.hp >= maxHpOf()) return;
    var h = Math.max(1, Math.floor(dmg * ls));
    hero.hp = Math.min(maxHpOf(), hero.hp + h);
    fxText(world.player.x, world.player.y, '+' + h, '#9fe0a0');
  }
  function cleaveAround(center, dmg) {
    var snap = world.monsters.slice();
    for (var i = 0; i < snap.length; i++) { var o = snap[i]; if (o === center || o.hp <= 0) continue; if (cheb(o.x, o.y, center.x, center.y) <= 1) damageMob(o, dmg, 'cleave', '#ffd2a0'); }
  }
  function chainBounce(from, dmg, hops, color) {
    var cur = from, used = [from];
    for (var h = 0; h < hops; h++) {
      var best = null, bd = 99;
      for (var i = 0; i < world.monsters.length; i++) { var m = world.monsters[i]; if (used.indexOf(m) >= 0 || m.hp <= 0) continue; var d = cheb(m.x, m.y, cur.x, cur.y); if (d <= 3 && d < bd) { bd = d; best = m; } }
      if (!best) break;
      fxRay(cur.x, cur.y, best.x, best.y, color || '#bfe0ff');
      damageMob(best, dmg, 'chain', color || '#bfe0ff'); used.push(best); cur = best;
    }
  }
  function heroAttack(m, mult, extraStun) {
    var w = (equippedItem('weapon') || { stats: {} }).stats;   // on-hit effects from the rolled weapon
    var base = Math.max(1, Math.round(atkOf() * (mult || 1)) - m.def + rr(-1, 2));
    var crit = chance(critOf());
    if (crit) base = Math.round(base * 1.8);
    // SHATTER synergy: striking a frozen/stunned foe deals +60% and breaks it
    var st0 = m.status || {};
    if (st0.stun > 0) { base = Math.round(base * 1.6); fxText(m.x, m.y - 0.3, 'SHATTER!', '#9fd8ff'); st0.stun = 0; }
    var dealt = Math.min(base, m.hp);
    damageMob(m, base, 'melee', crit ? '#ffec80' : '#ffd2d2');
    if (crit) fxText(m.x, m.y - 0.3, 'CRIT!', '#ffec80');
    lifestealHeal(dealt);
    var dead = m.hp <= 0;
    if (!dead && w.poison && chance(w.poison)) { applyStatus(m, 'poison', 4); fxText(m.x, m.y, 'poison', '#7fe0a0'); }
    if (!dead && w.burn && chance(w.burn)) {
      // COMBUST synergy: igniting a poisoned foe detonates the venom
      if (m.status && m.status.poison > 0) { damageMob(m, Math.round(atkOf() * 0.9), 'combust', '#ff9050'); fxText(m.x, m.y - 0.3, 'COMBUST!', '#ff9050'); dead = m.hp <= 0; }
      if (!dead) { applyStatus(m, 'burn', 3); fxText(m.x, m.y, 'burn', '#ffb060'); }
    }
    var st = (w.stun || 0) + (w.freeze || 0) + (extraStun || 0);
    if (!dead && st && chance(st)) { applyStatus(m, 'stun', 2); fxText(m.x, m.y, w.freeze ? 'frozen' : 'stun', '#9fd8ff'); }
    if (w.cleave) cleaveAround(m, Math.max(1, Math.round(base * w.cleave)));
    if (w.chain) chainBounce(m, Math.max(1, Math.round(base * w.chain)), 2, '#ffe28a');
    shake(crit ? 5 : 2);
  }
  function hurtHero(dmg, srcName, srcMob) {
    if (dodgeOf() && chance(dodgeOf())) { fxText(world.player.x, world.player.y, 'dodge', '#bfe0ff'); return; }
    var rz = resistOf(); if (rz) dmg = Math.max(1, Math.round(dmg * (1 - rz)));
    if (hero.buffs && hero.buffs.shield > 0) dmg = Math.max(1, Math.ceil(dmg * 0.4));
    dmg = Math.max(1, dmg - Math.floor(defOf() * 0.6));
    hero.hp -= dmg; world.player.hit = now();
    fxText(world.player.x, world.player.y, '-' + dmg, '#ff9a9a');
    shake(3);
    if (srcMob && thornsOf() && srcMob.hp > 0 && cheb(world.player.x, world.player.y, srcMob.x, srcMob.y) <= 1) {
      damageMob(srcMob, Math.max(1, Math.round(dmg * thornsOf())), 'thorns', '#ffd0a0');
    }
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
    if (chance(0.5)) world.items.push({ type: 'gold', x: x, y: y, amt: (5 + ri(7)) * Math.max(1, Math.ceil(world.depth * 0.6)) });
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
    // region hazard (lava / brambles / quicksand / brine / void-fire)
    var hzo = objAt(p.x, p.y, 'hazard'), HZ = hzo && HAZARDS[hzo.kind];
    if (HZ) { hurtHero(HZ.dmg + Math.floor(world.depth / 4), 'hazard'); if (HZ.status) applyStatus(hero, HZ.status, 3); logMsg('die', 'You cross the ' + HZ.name + '!'); }
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
    else if (it.type === 'gem') { hero.gold += 50; hero.stats.gems++; questProgress('gems', 1); logMsg('win', 'A gleaming gem! (+50)'); fxText(it.x, it.y, '💎', '#7fe0d0'); }
    else if (it.type === 'cons') { hero.bag[it.id] = (hero.bag[it.id] || 0) + 1; logMsg('', 'Picked up ' + CONS[it.id].name + '.'); fxText(it.x, it.y, CONS[it.id].icon, '#fff'); }
    else if (it.type === 'gear') { var inst = it.item || generateItem(null, world.depth); acquireGear(inst); logMsg('win', 'Found ' + inst.name + (inst.rarity !== 'common' ? ' (' + rarityOf(inst).name + ')' : '') + '!'); fxText(it.x, it.y, inst.icon, rarityOf(inst).color); }
    world.items.splice(idx, 1);
    markDirty();
  }
  function buyPrice(p) { return Math.ceil((p || 0) * PRICE_MULT); }
  function capOwned() {
    var CAP = 60; if (!hero.owned || hero.owned.length <= CAP) return;
    var lowIx = -1, lowS = Infinity;
    for (var i = 0; i < hero.owned.length; i++) { var o = hero.owned[i];
      if (o.uid === hero.equip.weapon || o.uid === hero.equip.armor || o.uid === hero.equip.trinket) continue;
      var sc = itemScore(o); if (sc < lowS) { lowS = sc; lowIx = i; } }
    if (lowIx >= 0) hero.owned.splice(lowIx, 1);
  }
  // Add an item instance to the pack; auto-equip if it scores higher than the
  // current piece in that slot. Returns 'equipped' | 'kept'.
  function acquireGear(it) {
    if (!it) return false;
    hero.owned = hero.owned || [];
    hero.owned.push(it); capOwned();
    var cur = equippedItem(it.slot);
    if (!cur || itemScore(it) > itemScore(cur)) { hero.equip[it.slot] = it.uid; logMsg('win', 'Equipped ' + it.name + '.'); return 'equipped'; }
    return 'kept';
  }

  function rest() {
    if (!playerActive()) return false;
    endTurn();   // waiting passes a turn — no free healing (potions matter now)
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
      var shrine = objAt(ox, oy, 'shrine'); if (shrine) { prayShrine(shrine); return; }
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
    if (c.mimic) {
      c.opened = true;
      var sx = c.x, sy = c.y;
      if (world.player.x === sx && world.player.y === sy) { var a = adjacentFree(sx, sy); if (a) { sx = a.x; sy = a.y; } }
      var mb = makeMob(MOBS.mimic, sx, sy, false, 1 + world.depth * 0.12, world.depth);
      mb.awake = true;
      world.monsters.push(mb);
      logMsg('die', 'The chest is a MIMIC!'); shake(6); fxBurst(c.x, c.y, '#caa24a');
      markDirty(); refreshAll();
      return;
    }
    c.opened = true;
    var rolls = c.lush ? 3 : 1 + ri(2);
    for (var i = 0; i < rolls; i++) {
      var roll = Math.random();
      if (roll < 0.4) { var g = (5 + ri(9)) * Math.max(1, Math.ceil((world.depth + 1) * 0.6)); hero.gold += Math.round(g * greedOf()); fxText(c.x, c.y - i * 0.3, '+' + g + 'g', '#ffd76a'); }
      else if (roll < 0.7) { var id = chance(0.6) ? 'potion' : (chance(0.5) ? 'elixir' : 'bomb'); hero.bag[id] = (hero.bag[id] || 0) + 1; fxText(c.x, c.y - i * 0.3, CONS[id].icon, '#fff'); }
      else { var inst = generateItem(null, world.depth + (c.lush ? 3 : 1), c.lush ? 1.5 : 0); acquireGear(inst); fxText(c.x, c.y - i * 0.3, inst.icon, rarityOf(inst).color); if (inst.rarity === 'legendary' || inst.rarity === 'epic') logMsg('win', 'A ' + rarityOf(inst).name + ' drop: ' + inst.name + '!'); }
    }
    logMsg('win', 'You open the chest!'); fxBurst(c.x, c.y, '#ffd76a'); markDirty(); refreshAll();
  }
  function prayShrine(s) {
    if (s.used) { logMsg('', 'The shrine is silent now.'); return; }
    s.used = true;
    var r = Math.random();
    if (r < 0.45) { hero.hp = maxHpOf(); hero.mp = maxMpOf(); logMsg('win', 'The shrine restores you fully.'); fxText(s.x, s.y, 'restored', '#9fe0a0'); }
    else if (r < 0.72) { var g = 20 + world.depth * 10; hero.gold += g; hero.hp = maxHpOf(); logMsg('win', 'A blessing of fortune: +' + g + ' gold.'); fxText(s.x, s.y, '+' + g + 'g', '#ffd76a'); }
    else if (r < 0.9) { hero.maxHp += 3; hero.hp = maxHpOf(); logMsg('win', 'Vitality surges — +3 max HP!'); fxText(s.x, s.y, '+3 HP', '#9fe0a0'); }
    else { hero.atk += 1; logMsg('win', 'A gift of strength — +1 ATK!'); fxText(s.x, s.y, '+1 ATK', '#ffd2d2'); }
    fxBurst(s.x, s.y, '#9fd8ff'); Cade.haptic(8); markDirty(); refreshAll();
  }

  // ---- consumables ----------------------------------------------------------
  function useItem(id) {
    if (!playerActive()) return;
    if (!hero.bag[id] || hero.bag[id] <= 0) { logMsg('', 'No ' + CONS[id].name + '.'); return; }
    var p = world.player;
    if (id === 'potion' || id === 'hpotion') { var amt = id === 'hpotion' ? 110 : 45; if (hero.hp >= maxHpOf()) { logMsg('', 'Already at full HP.'); return; } var h = Math.min(maxHpOf() - hero.hp, amt); hero.hp = Math.min(maxHpOf(), hero.hp + amt); fxText(p.x, p.y, '+' + h + 'hp', '#9fe0a0'); }
    else if (id === 'elixir' || id === 'eelixir') { var mamt = id === 'eelixir' ? 70 : 30; if (hero.mp >= maxMpOf()) { logMsg('', 'Already at full MP.'); return; } hero.mp = Math.min(maxMpOf(), hero.mp + mamt); fxText(p.x, p.y, '+mp', '#9fd0ff'); }
    else if (id === 'antidote') { if (!(hero.status && (hero.status.poison > 0 || hero.status.burn > 0))) { logMsg('', 'Nothing to cure.'); return; } hero.status.poison = 0; hero.status.burn = 0; fxText(p.x, p.y, 'cured', '#9fe0a0'); logMsg('win', 'The antidote cleanses you.'); }
    else if (id === 'bomb') { var d = p.dir; var bx = p.x + d.x, by = p.y + d.y; if (!walkable(bx, by)) { bx = p.x; by = p.y; } explodeAt(bx, by, 14 + world.depth, '#ffb060'); }
    else if (id === 'scroll') { blinkToExplored(); }
    else if (id === 'key') { logMsg('', 'Keys open locked doors — walk into one.'); return; }
    hero.bag[id]--; markDirty(); refreshHud(); refreshBars(); refreshItemBar(); endTurn();
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
  function spellDmg(mult) { return Math.round(atkOf() * mult * spellPowerOf()) + rr(0, 3); }
  function useAbility(id) {
    if (!playerActive()) return;
    var ab = ABIL[id]; if (!ab) return;
    if (!knowsSpell(id)) { logMsg('', 'You haven\'t learned ' + ab.name + '.'); return; }
    if (hero.level < ab.lvl) { logMsg('', ab.name + ' needs level ' + ab.lvl + '.'); return; }
    var cd = ensureCd();
    if ((cd[id] || 0) > 0) { logMsg('', ab.name + ' on cooldown (' + cd[id] + ').'); return; }
    if (hero.mp < ab.mp) { logMsg('', 'Not enough MP for ' + ab.name + '.'); return; }
    var p = world.player, did = false;
    if (ab.kind === 'melee') {
      var tx = p.x + p.dir.x, ty = p.y + p.dir.y, m = mobAt(tx, ty);
      if (!m) { logMsg('', 'Nothing in front to strike.'); return; }
      p.bump = now(); p.bumpDir = p.dir; heroAttack(m, 2.2, 0.5); fxBurst(tx, ty, '#ffd76a'); did = true;
    } else if (ab.kind === 'ray') { did = castRay(ab);
    } else if (ab.kind === 'chainspell') { did = castChainSpell(ab);
    } else if (ab.kind === 'self') {
      var h = Math.round(maxHpOf() * 0.35); hero.hp = Math.min(maxHpOf(), hero.hp + h); fxText(p.x, p.y, '+' + h, '#9fe0a0'); fxBurst(p.x, p.y, '#9fe0a0'); did = true;
    } else if (ab.kind === 'buff') {
      hero.buffs = hero.buffs || {}; hero.buffs[ab.buff] = ab.turns;
      fxBurst(p.x, p.y, ab.buff === 'shield' ? '#9fd8ff' : '#ffb060');
      logMsg('win', ab.name + (ab.buff === 'shield' ? ' — damage halved!' : ' — ATK surges!')); did = true;
    } else if (ab.kind === 'move') { did = doBlink(ab.range);
    } else if (ab.kind === 'aoe') { did = doAoe(ab);
    }
    if (!did) return;
    hero.mp -= ab.mp; cd[id] = ab.cd + 1;
    markDirty(); refreshBars();
    endTurn();
  }
  function castRay(ab) {
    var p = world.player, x = p.x, y = p.y, hitMob = null;
    var color = ab.freeze ? '#9fd8ff' : ab.drain ? '#e05d8a' : '#ff8040';
    for (var i = 1; i <= ab.range; i++) {
      x += p.dir.x; y += p.dir.y;
      if (x < 0 || y < 0 || x >= MW || y >= MH || world.map[y][x] !== T_FLOOR) { x -= p.dir.x; y -= p.dir.y; break; }
      var m = mobAt(x, y); if (m) { hitMob = m; break; }
    }
    fxRay(p.x, p.y, x, y, color);
    if (hitMob) {
      var dmg = spellDmg(1.5), dealt = Math.min(dmg, hitMob.hp);
      damageMob(hitMob, dmg, 'spell', color);
      if (ab.burn) applyStatus(hitMob, 'burn', 3);
      if (ab.freeze) applyStatus(hitMob, 'stun', 2);
      if (ab.drain && hero.hp < maxHpOf()) { var hl = Math.max(1, Math.floor(dealt * 0.7)); hero.hp = Math.min(maxHpOf(), hero.hp + hl); fxText(p.x, p.y, '+' + hl, '#9fe0a0'); }
    }
    shake(3);
    return true;
  }
  function castChainSpell(ab) {
    var p = world.player, x = p.x, y = p.y, hitMob = null;
    for (var i = 1; i <= ab.range; i++) { x += p.dir.x; y += p.dir.y; if (x < 0 || y < 0 || x >= MW || y >= MH || world.map[y][x] !== T_FLOOR) { x -= p.dir.x; y -= p.dir.y; break; } var m = mobAt(x, y); if (m) { hitMob = m; break; } }
    fxRay(p.x, p.y, x, y, '#bfe0ff');
    if (!hitMob) { shake(2); return true; }
    var dmg = spellDmg(1.3);
    damageMob(hitMob, dmg, 'spell', '#bfe0ff');
    chainBounce(hitMob, Math.max(1, Math.round(dmg * 0.7)), 3, '#bfe0ff');
    shake(4);
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
  function doAoe(ab) {
    var p = world.player, range = ab.range || 2;
    var color = ab.poison ? '#7fe0a0' : ab.big ? '#ffb060' : '#e0c080';
    var mult = ab.big ? 2.2 : ab.poison ? 0.8 : 1.2;
    for (var i = world.monsters.length - 1; i >= 0; i--) {   // backwards: damageMob may splice
      var m = world.monsters[i];
      if (cheb(p.x, p.y, m.x, m.y) <= range) {
        damageMob(m, spellDmg(mult), 'spell', color);
        if (ab.stun) applyStatus(m, 'stun', 2);
        if (ab.poison) applyStatus(m, 'poison', 5);
        if (ab.burn) applyStatus(m, 'burn', 3);
      }
    }
    shake(ab.big ? 12 : 9); fxBurst(p.x, p.y, color);
    for (var r = 1; r <= range; r++) { var a = Math.random() * 6.28; world.fx.push({ kind: 'spark', x: p.x + 0.5 + Math.cos(a) * r, y: p.y + 0.5 + Math.sin(a) * r, vx: 0, vy: 0, color: color, life: 1, born: now() }); }
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

  function actMob(m) {
    var dist = cheb(m.x, m.y, world.player.x, world.player.y);
    if (m.behavior === 'archer') archerAct(m, dist);
    else if (m.behavior === 'thief') thiefAct(m, dist);
    else if (m.behavior === 'summon') summonAct(m, dist);
    else meleeAct(m, dist);
  }
  function bossPhase(m) {
    if (m.boss && !m.enraged && m.hp <= m.maxHp * 0.5) {
      m.enraged = true; m.atk = Math.round(m.atk * 1.35); m.swift = true;
      logMsg('die', 'The ' + m.name + ' ENRAGES!'); shake(10); fxBurst(m.x, m.y, '#e85d5d');
    }
  }
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
      bossPhase(m);
      actMob(m);
      if (hero.hp <= 0) return;
      if (m.swift && m.hp > 0 && world.mode !== 'dead') actMob(m);   // swift elites/enraged bosses act twice
      if (hero.hp <= 0) return;
    }
    // foes standing in a hazard take its toll too — lure them into the lava
    for (var hi = world.monsters.length - 1; hi >= 0; hi--) {
      var hm = world.monsters[hi], ho = objAt(hm.x, hm.y, 'hazard'), HH = ho && HAZARDS[ho.kind];
      if (HH) { damageMob(hm, HH.dmg, 'hazard', HH.col); if (HH.status && hm.hp > 0) applyStatus(hm, HH.status, 3); }
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
    var dmg = Math.max(1, m.atk + rr(-1, 1)); hurtHero(dmg, m.name, m);
    if (m.vamp && m.hp > 0) m.hp = Math.min(m.maxHp, m.hp + Math.ceil(dmg * 0.5));
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
    if (m.aiming) {
      // the shot it telegraphed last turn lands now — only if you're still in the lane
      m.aiming = false;
      var lined = (m.x === p.x || m.y === p.y) && losClear(m.x, m.y, p.x, p.y) && cheb(m.x, m.y, p.x, p.y) <= (m.range || 5);
      fxRay(m.x, m.y, lined ? p.x : m.aimT.x, lined ? p.y : m.aimT.y, m.burn ? '#ff80c0' : '#cdd3da');
      if (lined) { var dmg = Math.max(1, m.atk + rr(0, 2)); hurtHero(dmg, m.name, m); if (m.burn) applyStatus(hero, 'burn', 3); if (m.poison) applyStatus(hero, 'poison', 4); }
      else fxText(m.x, m.y, 'miss', '#cdd3da');
      return;
    }
    var inLine = (m.x === p.x || m.y === p.y) && losClear(m.x, m.y, p.x, p.y);
    if (inLine && dist <= (m.range || 5)) {   // wind up — gives you a turn to break the line
      m.aiming = true; m.aimT = { x: p.x, y: p.y };
      logMsg('', 'The ' + m.name + ' takes aim — move!');
      return;
    }
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
    // regen: HP only from a Regen trinket (slow); MP trickles slowly. No free
    // healing just for walking/waiting — that's what potions & elixirs are for.
    var rg = regenOf();
    if (rg && world.steps % 4 === 0 && hero.hp < maxHpOf()) hero.hp = Math.min(maxHpOf(), hero.hp + rg);
    if (world.steps % 12 === 0 && hero.mp < maxMpOf()) hero.mp = Math.min(maxMpOf(), hero.mp + 1);
    // cooldowns + buffs
    var cd = ensureCd(); for (var k in cd) if (cd[k] > 0) cd[k]--;
    if (hero.buffs) { if (hero.buffs.shield > 0) hero.buffs.shield--; if (hero.buffs.power > 0) hero.buffs.power--; }
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
    // only route to a real, reachable floor tile (or a foe/feature standing on
    // floor) — never to a wall, sealed gate, or unexplored void.
    if (!walkable(tx, ty)) return;
    var p = world.player;
    var path = bfsPath(p.x, p.y, tx, ty);
    if (!path || !path.length) return;
    world.path = path; world.pathT = 0;
  }
  function cancelTravel() { if (world) { world.path = null; } }
  function travelStep() {
    if (!world || !world.path || !world.path.length || !playerActive()) { if (world) world.path = null; return; }
    // stop if a visible enemy is near
    for (var i = 0; i < world.monsters.length; i++) { var m = world.monsters[i]; if (m.awake && world.visible[m.y] && world.visible[m.y][m.x] && cheb(m.x, m.y, world.player.x, world.player.y) <= LIGHT) { world.path = null; return; } }
    var hpBefore = hero.hp;
    var nxt = world.path.shift();
    var dx = nxt[0] - world.player.x, dy = nxt[1] - world.player.y;
    var moved = tryMove(dx, dy);
    if (!moved) { world.path = null; return; }
    if (world && hero.hp < hpBefore) world.path = null;   // took damage (trap/ambush) — stop here
    if (!world || !world.path || !world.path.length) { if (world) world.path = null; }
  }

  // =========================================================================
  //  rendering
  // =========================================================================
  function camera() {
    var p = world.player;
    var rx = p.rx == null ? p.x : p.rx, ry = p.ry == null ? p.y : p.ry;
    // centre on the (smoothly-lerped) player position, in float tiles
    var cx = clamp(rx - (VW - 1) / 2, 0, MW - VW);
    var cy = clamp(ry - (VH - 1) / 2, 0, MH - VH);
    return { x: cx, y: cy };
  }
  // Constant-speed glide toward the logical tile — crisp grid steps, no float drift.
  function lerpEnt(e, dt) {
    if (e.rx == null) e.rx = e.x; if (e.ry == null) e.ry = e.y;
    var step = 14 * dt;                       // tiles / second
    var dx = e.x - e.rx, dy = e.y - e.ry;
    // snap if a long jump (teleport/blink across the map) to avoid a slow crawl
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { e.rx = e.x; e.ry = e.y; return; }
    e.rx = Math.abs(dx) <= step ? e.x : e.rx + step * (dx < 0 ? -1 : 1);
    e.ry = Math.abs(dy) <= step ? e.y : e.ry + step * (dy < 0 ? -1 : 1);
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  var lastFrame = 0;
  function render(ts) {
    if (!ui || !ui.canvas || !ui.canvas.isConnected) { state_teardown(); return; }
    var dt = lastFrame ? Math.min(0.05, (ts - lastFrame) / 1000) : 0.016; lastFrame = ts;
    var ctx = ui.ctx, w = world;
    if (!w) { return; }
    lerpEnt(w.player, dt);            // lerp player first so the camera tracks it smoothly
    var cam = camera();
    var b = w.biome;
    // shake
    var sox = 0, soy = 0;
    if (w.shake > 0) { sox = (Math.random() - 0.5) * w.shake; soy = (Math.random() - 0.5) * w.shake; w.shake = Math.max(0, w.shake - dt * 40); }
    ctx.setTransform(ui.dpr, 0, 0, ui.dpr, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#06070a'; ctx.fillRect(0, 0, CW, CH);
    ctx.save(); ctx.translate(sox, soy);

    // tiles — iterate one extra ring so sub-pixel scrolling never shows a gap
    var sx0 = Math.floor(cam.x) - 1, sy0 = Math.floor(cam.y) - 1;
    for (var vy = 0; vy < VH + 2; vy++) for (var vx = 0; vx < VW + 2; vx++) {
      var mx = sx0 + vx, my = sy0 + vy;
      if (mx < 0 || my < 0 || mx >= MW || my >= MH) continue;
      if (!w.explored[my][mx]) continue;
      var vis = w.visible[my][mx];
      var px = (mx - cam.x) * TILE, py = (my - cam.y) * TILE;
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
    // telegraphed shots — dashed warning lane you can step out of
    ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,90,90,0.8)';
    for (var ti = 0; ti < w.monsters.length; ti++) { var am = w.monsters[ti]; if (am.aiming && am.aimT && w.visible[am.y] && w.visible[am.y][am.x]) {
      ctx.beginPath(); ctx.moveTo((am.x - cam.x) * TILE + TILE / 2, (am.y - cam.y) * TILE + TILE / 2); ctx.lineTo((am.aimT.x - cam.x) * TILE + TILE / 2, (am.aimT.y - cam.y) * TILE + TILE / 2); ctx.stroke();
    } }
    ctx.setLineDash([]); ctx.restore();
    // player (already lerped at the top of the frame) + companion pet
    var p = w.player; drawPet(ctx, p, cam, dt); drawPlayer(ctx, p, cam);

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
      case 'shrine': glyph(ctx, '⛩', cx, cy, o.used ? 'rgba(150,160,180,0.45)' : '#bfe0ff', o.used ? a : a * (0.7 + 0.3 * Math.abs(Math.sin(now() / 500))), 18); break;
      case 'hazard': var HZ = HAZARDS[o.kind] || {}; ctx.globalAlpha = a * 0.45; ctx.fillStyle = HZ.col || '#888'; roundRect(ctx, px + 1, py + 1, TILE - 2, TILE - 2, 3); ctx.fill(); ctx.globalAlpha = 1; glyph(ctx, HZ.ch || '≈', cx, cy, 'rgba(0,0,0,0.5)', a, 13); break;
      case 'chest': glyph(ctx, o.opened ? '📭' : (o.lush ? '🎁' : '📦'), cx, cy, '#ffd76a', a, 16); break;
      case 'npc':
        drawCharacter(ctx, cx, cy - 1, TILE / 2 - 3, { x: 0, y: 1 }, o.cos || {}, now() + o.x * 130);
        glyph(ctx, o.icon, cx + TILE * 0.42, cy - TILE * 0.34, '#fff', 1, 12);  // profession token
        ctx.globalAlpha = 0.9; ctx.fillStyle = o.col || '#fff'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(o.name, cx, cy + 14); ctx.globalAlpha = 1; break;
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
    else if (it.type === 'gear') { glyph(ctx, it.item ? it.item.icon : '?', cx, cy + bob, it.item ? rarityOf(it.item).color : '#fff', 1, 14); }
  }
  function entShake(e) { var t = now() - (e.hit || 0); if (t < 160) { var k = (160 - t) / 160; return (Math.random() - 0.5) * 5 * k; } return 0; }
  function bumpOff(e) { var t = now() - (e.bump || 0); if (t < 140 && e.bumpDir) { var k = Math.sin((1 - t / 140) * Math.PI) * 6; return { x: e.bumpDir.x * k, y: e.bumpDir.y * k }; } return { x: 0, y: 0 }; }
  function drawMob(ctx, m, cam) {
    var bo = bumpOff(m), sh = entShake(m);
    var cx = (m.rx - cam.x) * TILE + TILE / 2 + bo.x + sh, cy = (m.ry - cam.y) * TILE + TILE / 2 + bo.y;
    var r = (m.boss ? TILE / 2 + 2 : TILE / 2 - 2);
    if (m.elite) { ctx.strokeStyle = m.enraged ? '#ff5050' : '#ffb84d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r + 2.5, 0, 6.3); ctx.stroke(); }
    ctx.fillStyle = m.col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.fill();
    if (m.boss && m.enraged) { ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 2; ctx.stroke(); }
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
  // ---- unified paper-doll renderer (player + NPCs + tailor preview) ----------
  function drawCharacter(ctx, cx, cy, r, dir, cos, t) {
    cos = cos || {};
    var col = COSMETIC.color[cos.color] || COSMETIC.color.cyan;
    var fx = dir ? dir.x : 0, fy = dir ? dir.y : 1;
    // flowing bezier cape behind the facing direction
    var capeDef = cos.cape && COSMETIC.cape[cos.cape] && COSMETIC.cape[cos.cape].color ? COSMETIC.cape[cos.cape] : null;
    if (capeDef) {
      var bx = -fx, by = -fy, ppx = -by, ppy = bx, sway = Math.sin((t || 0) / 280) * 0.10;
      var sLx = cx + ppx * r * 0.72, sLy = cy + ppy * r * 0.72, sRx = cx - ppx * r * 0.72, sRy = cy - ppy * r * 0.72;
      var tipx = cx + bx * r * 1.95 + ppx * r * sway * 3, tipy = cy + by * r * 1.95 + ppy * r * sway * 3;
      ctx.fillStyle = capeDef.color;
      ctx.beginPath(); ctx.moveTo(sLx, sLy);
      ctx.quadraticCurveTo(cx + bx * r + ppx * r * 1.05, cy + by * r + ppy * r * 1.05, tipx, tipy);
      ctx.quadraticCurveTo(cx + bx * r - ppx * r * 1.05, cy + by * r - ppy * r * 1.05, sRx, sRy);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.beginPath(); ctx.moveTo((sLx + sRx) / 2, (sLy + sRy) / 2); ctx.quadraticCurveTo(cx + bx * r, cy + by * r, tipx, tipy); ctx.lineTo(sRx, sRy); ctx.closePath(); ctx.fill();
    }
    // body
    ctx.fillStyle = col.body; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.fill();
    if (cos.pattern && cos.pattern !== 'none') { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.clip(); drawPattern(ctx, cos.pattern, cx, cy, r, col); ctx.restore(); }
    ctx.lineWidth = 2; ctx.strokeStyle = col.line; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.20)'; ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.4, 0, 6.3); ctx.fill();
    var beltDef = cos.belt && COSMETIC.belt[cos.belt] && COSMETIC.belt[cos.belt].color ? COSMETIC.belt[cos.belt] : null;
    if (beltDef) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.clip(); ctx.fillStyle = beltDef.color; ctx.fillRect(cx - r, cy + r * 0.22, r * 2, r * 0.34); ctx.fillStyle = 'rgba(255,235,150,0.5)'; ctx.fillRect(cx - r * 0.13, cy + r * 0.25, r * 0.26, r * 0.28); ctx.restore(); }
    drawEyes(ctx, cos.eyes || 'default', cx, cy, r, fx, fy, col);
    drawHat(ctx, cos.hat, cx, cy - r * 0.55, r);
  }
  function drawPattern(ctx, pat, cx, cy, r, col) {
    if (pat === 'belly') { ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.25, r * 0.55, r * 0.6, 0, 0, 6.3); ctx.fill(); }
    else if (pat === 'spots') { ctx.fillStyle = 'rgba(0,0,0,0.20)';[[-0.4, -0.2], [0.32, 0.1], [-0.1, 0.42], [0.45, -0.3]].forEach(function (s) { ctx.beginPath(); ctx.arc(cx + s[0] * r, cy + s[1] * r, r * 0.17, 0, 6.3); ctx.fill(); }); }
    else if (pat === 'stripe') { ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.lineWidth = r * 0.22; for (var i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(cx - r + i * r * 0.5, cy - r); ctx.lineTo(cx + r + i * r * 0.5, cy + r); ctx.stroke(); } }
    else if (pat === 'rune') { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '700 ' + Math.round(r * 0.95) + 'px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('ᛟ', cx, cy + 1); }
  }
  function drawEyes(ctx, style, cx, cy, r, fx, fy, col) {
    if (style === 'none') return;
    var px = -fy, py = fx, exC = cx + fx * 3, eyC = cy + fy * 3;
    var e1x = exC + px * 3, e1y = eyC + py * 3, e2x = exC - px * 3, e2y = eyC - py * 3;
    if (style === 'visor') { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.clip(); ctx.fillStyle = '#10333f'; ctx.fillRect(exC - r * 0.72, eyC - 3, r * 1.44, 5); ctx.fillStyle = '#7fe0ff'; ctx.fillRect(exC - r * 0.4, eyC - 1.5, r * 0.8, 2); ctx.restore(); return; }
    if (style === 'sleepy') { ctx.strokeStyle = col.line; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(e1x - 2, e1y); ctx.lineTo(e1x + 2, e1y); ctx.moveTo(e2x - 2, e2y); ctx.lineTo(e2x + 2, e2y); ctx.stroke(); return; }
    var rad = style === 'cute' ? 2.7 : 2, ecol = style === 'glow' ? '#7fe0ff' : col.line;
    if (style === 'glow') { ctx.shadowColor = '#7fe0ff'; ctx.shadowBlur = 6; }
    ctx.fillStyle = ecol;
    ctx.beginPath(); ctx.arc(e1x, e1y, rad, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.arc(e2x, e2y, rad, 0, 6.3); ctx.fill();
    ctx.shadowBlur = 0;
    if (style === 'cute') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(e1x - 0.8, e1y - 0.8, 0.9, 0, 6.3); ctx.fill(); ctx.beginPath(); ctx.arc(e2x - 0.8, e2y - 0.8, 0.9, 0, 6.3); ctx.fill(); }
    if (style === 'angry') { ctx.strokeStyle = col.line; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(e1x - 3, e1y - 3); ctx.lineTo(e1x + 1, e1y - 1); ctx.moveTo(e2x + 3, e2y - 3); ctx.lineTo(e2x - 1, e2y - 1); ctx.stroke(); }
  }
  function drawPetShape(ctx, cx, cy, r, kind, t) {
    var d = COSMETIC.pet[kind]; if (!d || !d.col) return;
    var bob = Math.sin((t || 0) / 250) * (r * 0.12);
    cy += bob;
    if (kind === 'wisp') {
      ctx.globalAlpha = 0.5; ctx.fillStyle = d.col; ctx.beginPath(); ctx.arc(cx, cy, r * 1.4, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#eaf6ff'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.7, 0, 6.3); ctx.fill(); return;
    }
    if (kind === 'slime') {
      ctx.fillStyle = d.col; ctx.beginPath(); ctx.moveTo(cx - r, cy + r * 0.6); ctx.quadraticCurveTo(cx - r, cy - r, cx, cy - r); ctx.quadraticCurveTo(cx + r, cy - r, cx + r, cy + r * 0.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#10333f'; ctx.beginPath(); ctx.arc(cx - r * 0.3, cy, 1.3, 0, 6.3); ctx.fill(); ctx.beginPath(); ctx.arc(cx + r * 0.3, cy, 1.3, 0, 6.3); ctx.fill(); return;
    }
    // cat / pup / drake — body + ears + eyes (+ wings for drake)
    if (kind === 'drake') { ctx.fillStyle = 'rgba(120,180,90,0.85)'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - r * 1.4, cy - r * 0.6); ctx.lineTo(cx - r * 0.6, cy + r * 0.3); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * 1.4, cy - r * 0.6); ctx.lineTo(cx + r * 0.6, cy + r * 0.3); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = d.col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.3); ctx.fill();
    ctx.fillStyle = d.col; // ears
    ctx.beginPath(); ctx.moveTo(cx - r * 0.7, cy - r * 0.4); ctx.lineTo(cx - r * 0.9, cy - r * 1.1); ctx.lineTo(cx - r * 0.2, cy - r * 0.7); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + r * 0.7, cy - r * 0.4); ctx.lineTo(cx + r * 0.9, cy - r * 1.1); ctx.lineTo(cx + r * 0.2, cy - r * 0.7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#10333f'; ctx.beginPath(); ctx.arc(cx - r * 0.32, cy - r * 0.05, 1.4, 0, 6.3); ctx.fill(); ctx.beginPath(); ctx.arc(cx + r * 0.32, cy - r * 0.05, 1.4, 0, 6.3); ctx.fill();
  }
  function drawPet(ctx, p, cam, dt) {
    var kind = hero.cosmetics && hero.cosmetics.pet; if (!kind || kind === 'none' || !COSMETIC.pet[kind] || !COSMETIC.pet[kind].col) return;
    if (!world.pet) world.pet = { rx: p.rx, ry: p.ry };
    var tx = p.x - p.dir.x * 0.85, ty = p.y - p.dir.y * 0.85, sp = Math.min(1, 8 * dt);
    world.pet.rx += (tx - world.pet.rx) * sp; world.pet.ry += (ty - world.pet.ry) * sp;
    var cx = (world.pet.rx - cam.x) * TILE + TILE / 2, cy = (world.pet.ry - cam.y) * TILE + TILE / 2;
    drawPetShape(ctx, cx, cy, TILE * 0.26, kind, now());
  }
  function drawPlayer(ctx, p, cam) {
    var bo = bumpOff(p), sh = entShake(p);
    var cx = (p.rx - cam.x) * TILE + TILE / 2 + bo.x + sh, cy = (p.ry - cam.y) * TILE + TILE / 2 + bo.y;
    var r = TILE / 2 - 2;
    var glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, r + 8);
    glow.addColorStop(0, 'rgba(255,224,150,0.32)'); glow.addColorStop(1, 'rgba(255,224,150,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, 6.3); ctx.fill();
    drawCharacter(ctx, cx, cy, r, p.dir, hero.cosmetics || {}, now());
  }
  function drawHat(ctx, hat, hx, hy, r) {
    if (!hat || hat === 'none') return;
    if (hat === 'wizard') {
      ctx.fillStyle = '#5b3fa0'; ctx.beginPath(); ctx.moveTo(hx, hy - r * 1.3); ctx.lineTo(hx - r * 0.7, hy + r * 0.2); ctx.lineTo(hx + r * 0.7, hy + r * 0.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd76a'; ctx.beginPath(); ctx.arc(hx + r * 0.18, hy - r * 0.5, 1.6, 0, 6.3); ctx.fill();
    } else if (hat === 'horns') {
      ctx.fillStyle = '#e9e4d8';
      ctx.beginPath(); ctx.moveTo(hx - r * 0.5, hy); ctx.lineTo(hx - r * 0.8, hy - r * 0.8); ctx.lineTo(hx - r * 0.2, hy - r * 0.15); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + r * 0.5, hy); ctx.lineTo(hx + r * 0.8, hy - r * 0.8); ctx.lineTo(hx + r * 0.2, hy - r * 0.15); ctx.closePath(); ctx.fill();
    } else if (hat === 'top') {
      ctx.fillStyle = '#1c1c22'; ctx.fillRect(hx - r * 0.75, hy + r * 0.05, r * 1.5, 2.5);
      ctx.fillRect(hx - r * 0.45, hy - r * 0.9, r * 0.9, r * 0.95);
    } else if (hat === 'halo') {
      ctx.strokeStyle = '#ffe28a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(hx, hy - r * 0.7, r * 0.6, r * 0.22, 0, 0, 6.3); ctx.stroke();
    } else if (hat === 'crown') {
      ctx.fillStyle = '#ffd23a';
      ctx.beginPath(); ctx.moveTo(hx - r * 0.6, hy + r * 0.1); ctx.lineTo(hx - r * 0.6, hy - r * 0.4); ctx.lineTo(hx - r * 0.3, hy - r * 0.1);
      ctx.lineTo(hx, hy - r * 0.6); ctx.lineTo(hx + r * 0.3, hy - r * 0.1); ctx.lineTo(hx + r * 0.6, hy - r * 0.4); ctx.lineTo(hx + r * 0.6, hy + r * 0.1); ctx.closePath(); ctx.fill();
    }
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
  // Log lines are now appended + auto-faded by logMsg(); nothing to rebuild here.
  function refreshLog() {}
  function refreshAll() { refreshBars(); refreshHud(); refreshLog(); refreshItemBar(); refreshAbilCd(); }

  // ---- ability bar ----------------------------------------------------------
  function buildAbilityBar() {
    if (!ui || !ui.abil) return;
    var ids = dockedSpells();
    var html = ids.map(function (id, i) {
      var a = ABIL[id];
      return '<button class="cr-ab" data-ab="' + id + '" title="' + a.name + ' — ' + a.desc + ' (MP ' + a.mp + ')">' +
        '<span class="cr-ab-ic">' + a.icon + '</span><span class="cr-ab-cd" data-cd="' + id + '"></span>' +
        '<span class="cr-ab-key">' + (i + 1) + '</span></button>';
    }).join('');
    html += '<button class="cr-ab cr-ab-book" id="cr-book" title="Spellbook — choose which spells to dock">📖</button>';
    ui.abil.innerHTML = html;
    var btns = ui.abil.querySelectorAll('.cr-ab[data-ab]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); useAbility(btn.getAttribute('data-ab')); });
    })(btns[i]);
    var bk = document.getElementById('cr-book'); if (bk) bk.addEventListener('click', function (e) { e.preventDefault(); openSpellbook(); });
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
    // potion + elixir always show; the rest only when owned. Cap to keep it tidy.
    var order = ['potion', 'hpotion', 'elixir', 'eelixir', 'bomb', 'scroll', 'antidote'];
    var show = order.filter(function (id) { return id === 'potion' || id === 'elixir' || (hero.bag[id] || 0) > 0; }).slice(0, 7);
    ui.items.innerHTML = show.map(function (id) {
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
    if (!hero) { Cade.showToast('Still loading your delver…', 'info', 1200); return; }
    closeOverlay();
    var ov = mkOverlay('Character');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-sheet">';
    html += '<div class="cr-sheet-row"><b>' + Cade.escapeHtml(hero.name) + '</b> · Level ' + hero.level +
      ' <button class="cr-rename" data-rename="1">✏ rename</button></div>';
    html += '<div class="cr-grid2">' +
      stat('❤ Max HP', maxHpOf()) + stat('✦ Max MP', maxMpOf()) +
      stat('⚔ Attack', atkOf()) + stat('🛡 Defense', defOf()) +
      stat('🎯 Crit', Math.round(critOf() * 100) + '%') + stat('🪙 Gold', hero.gold) +
      stat('🗺 Deepest', hero.maxDepth) + stat('💀 Deaths', hero.stats.deaths) +
      stat('⚔ Kills', hero.stats.kills) + stat('💎 Gems', hero.stats.gems) + '</div>';
    html += '<div class="cr-sec">Equipment</div><div class="cr-eqrow">' +
      eqSlot('weapon') + eqSlot('armor') + eqSlot('trinket') + '</div>';
    html += '<div class="cr-sec">Inventory — tap to equip / unequip</div><div class="cr-owned">';
    hero.owned.slice().sort(function (a, b) { return a.slot === b.slot ? itemScore(b) - itemScore(a) : (a.slot < b.slot ? -1 : 1); }).forEach(function (it) {
      var on = hero.equip[it.slot] === it.uid, c = rarityOf(it).color;
      html += '<button class="cr-gear' + (on ? ' cr-on' : '') + '" data-eq="' + it.uid + '"><span>' + it.icon + '</span> <span style="color:' + c + '">' + Cade.escapeHtml(it.name) + '</span>' + (on ? ' ✓' : '') +
        '<span class="cr-gear-st">' + instanceStatStr(it) + (it.lore ? ' — <i>' + Cade.escapeHtml(it.lore) + '</i>' : '') + '</span></button>'; });
    html += '</div></div>';
    body.innerHTML = html;
    var btns = body.querySelectorAll('[data-eq]');
    for (var i = 0; i < btns.length; i++) (function (btn) { btn.addEventListener('click', function () {
      var it = itemByUid(btn.getAttribute('data-eq')); if (!it) return;
      hero.equip[it.slot] = (hero.equip[it.slot] === it.uid) ? null : it.uid;
      hero.hp = clamp(hero.hp, 0, maxHpOf()); hero.mp = clamp(hero.mp, 0, maxMpOf());
      markDirty(); refreshAll(); openCharacter();
    }); })(btns[i]);
    var rn = body.querySelector('[data-rename]');
    if (rn) rn.addEventListener('click', function () {
      var v = window.prompt('Name your delver:', hero.name);
      if (v == null) return;
      v = String(v).replace(/[<>]/g, '').trim().slice(0, 24);
      if (v) { hero.name = v; markDirty(); refreshAll(); openCharacter(); }
    });
  }
  function stat(label, val) { return '<div class="cr-stat"><span>' + label + '</span><b>' + val + '</b></div>'; }
  function eqSlot(slot) { var it = equippedItem(slot); return '<div class="cr-eqslot"><div class="cr-eqic">' + (it ? it.icon : '·') + '</div><div class="cr-eqnm" style="' + (it ? 'color:' + rarityOf(it).color : '') + '">' + (it ? Cade.escapeHtml(it.name) : '—') + '</div></div>'; }

  // ---- overlay: spellbook (choose which known spells to dock) ----------------
  function openSpellbook() {
    if (!hero) return;
    closeOverlay();
    var ov = mkOverlay('Spellbook 📖');
    var body = ov.querySelector('.cr-ov-body');
    hero.docked = hero.docked || [];
    var html = '<div class="cr-hint">Dock up to ' + DOCK_MAX + ' known spells onto your action bar. Learn more from the Arcanist in town.</div>';
    html += '<div class="cr-sec">Known spells (' + dockedSpells().length + '/' + DOCK_MAX + ' docked)</div><div class="cr-owned">';
    var known = ABIL_ORDER.filter(knowsSpell);
    known.forEach(function (id) {
      var a = ABIL[id], on = hero.docked.indexOf(id) >= 0, locked = hero.level < a.lvl;
      html += '<button class="cr-gear' + (on ? ' cr-on' : '') + '" data-dock="' + id + '"><span>' + a.icon + '</span> ' + a.name +
        '<span class="cr-gear-st">' + (locked ? 'needs Lv ' + a.lvl : 'MP ' + a.mp + ' · cd ' + a.cd) + (on ? ' · docked' : '') + '</span></button>';
    });
    html += '</div>';
    var unknown = ABIL_ORDER.filter(function (id) { return !knowsSpell(id); });
    if (unknown.length) html += '<div class="cr-sec">Not yet learned</div><div class="cr-hint">' + unknown.map(function (id) { return ABIL[id].icon + ' ' + ABIL[id].name; }).join(' · ') + '<br>Learn these from the Arcanist in town.</div>';
    body.innerHTML = html;
    var btns = body.querySelectorAll('[data-dock]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-dock'), ix = hero.docked.indexOf(id);
        if (ix >= 0) hero.docked.splice(ix, 1);
        else { if (hero.docked.length >= DOCK_MAX) { Cade.showToast('Action bar full — undock one first', 'info', 1600); return; } hero.docked.push(id); }
        markDirty(); buildAbilityBar(); openSpellbook();
      });
    })(btns[i]);
  }

  // =========================================================================
  //  overlay: shops (town NPCs)
  // =========================================================================
  function openShop(role) {
    closeOverlay();
    if (role === 'healer') return openHealer();
    if (role === 'smith') return openSmith();
    if (role === 'arcanist') return openArcanist();
    if (role === 'tailor') return openTailor();
    if (role === 'quest') return openQuestBoard();
    var ov = mkOverlay('Merchant 🛒');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div><div class="cr-shop">';
    // consumables
    ['potion', 'hpotion', 'elixir', 'eelixir', 'bomb', 'scroll', 'antidote', 'key'].forEach(function (id) { var c = CONS[id];
      html += shopRow('cons:' + id, c.icon, c.name, c.desc, buyPrice(c.price), hero.bag[id] || 0); });
    // rotating rolled-item stock (regenerated each town visit; persists while open)
    if (!merchStock) { merchStock = []; var ms = ['weapon', 'armor', 'trinket']; for (var mi = 0; mi < 6; mi++) merchStock.push(generateItem(ms[mi % 3], Math.max(2, hero.maxDepth + 1), mi === 5 ? 0.5 : 0)); }
    html += '<div class="cr-sec">Wares</div><div class="cr-shop">';
    merchStock.forEach(function (it, idx) {
      var price = buyPrice(itemPrice(it)), c = rarityOf(it).color;
      html += '<div class="cr-srow"><span class="cr-sic" style="color:' + c + '">' + it.icon + '</span>' +
        '<span class="cr-snm"><span style="color:' + c + '">' + Cade.escapeHtml(it.name) + '</span><span class="cr-sdesc">' + instanceStatStr(it) + '</span></span>' +
        '<button class="cr-buy" data-gearbuy="' + idx + '" data-price="' + price + '">🪙 ' + price + '</button></div>';
    });
    html += '</div>';
    // Sell back unwanted gear (40%). Excludes equipped pieces and legendaries.
    var sellable = hero.owned.filter(function (it) { return hero.equip[it.slot] !== it.uid && !it.legend; });
    if (sellable.length) {
      html += '<div class="cr-sec">Sell gear (40% back)</div><div class="cr-shop">';
      sellable.sort(function (a, b) { return itemScore(a) - itemScore(b); }).forEach(function (it) {
        html += '<div class="cr-srow"><span class="cr-sic" style="color:' + rarityOf(it).color + '">' + it.icon + '</span>' +
          '<span class="cr-snm"><span style="color:' + rarityOf(it).color + '">' + Cade.escapeHtml(it.name) + '</span><span class="cr-sdesc">' + instanceStatStr(it) + '</span></span>' +
          '<button class="cr-buy cr-sell" data-sell="' + it.uid + '">🪙 ' + itemSell(it) + '</button></div>'; });
      html += '</div>';
    }
    body.innerHTML = html;
    bindShop(body, function () { openShop('merchant'); });
    var gb = body.querySelectorAll('[data-gearbuy]');
    for (var gi = 0; gi < gb.length; gi++) (function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-gearbuy'), 10), price = parseInt(btn.getAttribute('data-price'), 10), it = merchStock[idx];
        if (!it) return;
        if (hero.gold < price) { Cade.showToast('Not enough gold', 'error', 1400); return; }
        hero.gold -= price; merchStock.splice(idx, 1); acquireGear(it);
        Cade.haptic(8); markDirty(); refreshAll(); openShop('merchant');
      });
    })(gb[gi]);
    var sb = body.querySelectorAll('[data-sell]');
    for (var si = 0; si < sb.length; si++) (function (btn) {
      btn.addEventListener('click', function () {
        var it = itemByUid(btn.getAttribute('data-sell')); if (!it) return;
        if (hero.equip[it.slot] === it.uid) { Cade.showToast('Unequip it first', 'info', 1200); return; }
        var ix = hero.owned.indexOf(it); if (ix < 0) return;
        hero.owned.splice(ix, 1); hero.gold += itemSell(it);
        Cade.haptic(8); markDirty(); refreshAll(); openShop('merchant');
      });
    })(sb[si]);
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
        if (kind === 'gear' && hero.owned.indexOf(id) >= 0) { Cade.showToast('Already owned', 'info', 1200); return; }
        if (kind === 'spell' && knowsSpell(id)) { Cade.showToast('Already learned', 'info', 1200); return; }
        if (hero.gold < price) { Cade.showToast('Not enough gold', 'error', 1400); return; }
        hero.gold -= price;
        if (kind === 'cons') { hero.bag[id] = (hero.bag[id] || 0) + 1; }
        else if (kind === 'spell') { learnSpell(id); logMsg('win', 'Learned ' + ABIL[id].name + '!'); buildAbilityBar(); }
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
      '</div><div class="cr-hint">Out in the dungeon, only potions, elixirs and a Ring of Regen restore you.</div>';
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
    var w = equippedItem('weapon'), a = equippedItem('armor');
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
  function openArcanist() {
    var ov = mkOverlay('Arcanist 🔮');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div>' +
      '<div class="cr-hint">Learn spells here, then choose up to ' + DOCK_MAX + ' to dock in the 📖 Spellbook.</div><div class="cr-shop">';
    ABIL_ORDER.forEach(function (id) {
      var a = ABIL[id]; if (a.learn !== 'tome') return;
      var known = knowsSpell(id);
      html += shopRow('spell:' + id, a.icon, a.name, a.desc + ' (Lv ' + a.lvl + ', MP ' + a.mp + ')', buyPrice(a.price), known ? '✓' : 0, known);
    });
    html += '</div>';
    body.innerHTML = html;
    bindShop(body, function () { openArcanist(); });
  }
  function hasCos(slot, id) { return (COSMETIC[slot][id] && COSMETIC[slot][id].price === 0) || (hero.ownedCos || []).indexOf(cosKey(slot, id)) >= 0; }
  function cosSwatch(slot, id, c) {
    if (slot === 'color') return '<span class="cr-swatch" style="background:' + c.body + '"></span>';
    if (slot === 'cape' || slot === 'belt') return '<span class="cr-swatch" style="background:' + (c.color || 'transparent') + '"></span>';
    if (slot === 'pet') return '<span class="cr-swatch" style="background:' + (c.col || 'transparent') + '"></span>';
    var ic = slot === 'eyes' ? '👁' : slot === 'pattern' ? '▧' : '🎩';
    return '<span class="cr-swatch cr-swatch-hat">' + (id === 'none' ? '∅' : ic) + '</span>';
  }
  function renderTailorPreview() {
    var c = document.getElementById('cr-prev'); if (!c) return;
    var x = c.getContext('2d');
    x.clearRect(0, 0, 130, 120); x.fillStyle = '#0a0b0e'; roundRect(x, 0, 0, 130, 120, 10); x.fill();
    drawCharacter(x, 60, 60, 30, { x: 0, y: 1 }, hero.cosmetics, now());
    if (hero.cosmetics.pet && hero.cosmetics.pet !== 'none') drawPetShape(x, 102, 88, 13, hero.cosmetics.pet, now());
  }
  function openTailor() {
    var ov = mkOverlay('Tailor 🎩');
    var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-shopgold">🪙 ' + hero.gold + ' gold</div>' +
      '<div class="cr-tailor-prev"><canvas id="cr-prev" width="130" height="120"></canvas></div>' +
      '<div class="cr-hint">Buy a look, then tap an owned one to wear it.</div>';
    var slots = [['color', 'Body'], ['eyes', 'Eyes'], ['pattern', 'Pattern'], ['belt', 'Belt'], ['hat', 'Hat'], ['cape', 'Cape'], ['pet', 'Pet']];
    slots.forEach(function (sl) {
      var slot = sl[0];
      html += '<div class="cr-sec">' + sl[1] + '</div><div class="cr-cosrow">';
      for (var id in COSMETIC[slot]) {
        var c = COSMETIC[slot][id], owned = hasCos(slot, id), worn = hero.cosmetics[slot] === id;
        var label = owned ? (worn ? 'worn' : 'wear') : ('🪙' + c.price);
        html += '<button class="cr-cos' + (worn ? ' cr-on' : '') + '" data-cos="' + slot + ':' + id + '" data-price="' + c.price + '" data-owned="' + (owned ? 1 : 0) + '">' +
          cosSwatch(slot, id, c) + '<span>' + c.name + '</span><small>' + label + '</small></button>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
    renderTailorPreview();
    var btns = body.querySelectorAll('[data-cos]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () {
        var parts = btn.getAttribute('data-cos').split(':'), slot = parts[0], id = parts[1];
        var owned = btn.getAttribute('data-owned') === '1', price = parseInt(btn.getAttribute('data-price'), 10);
        if (!owned) {
          if (hero.gold < price) { Cade.showToast('Not enough gold', 'error', 1400); return; }
          hero.gold -= price; hero.ownedCos = hero.ownedCos || []; hero.ownedCos.push(cosKey(slot, id));
          Cade.showToast('Unlocked ' + COSMETIC[slot][id].name + '!', 'success', 1400);
        }
        hero.cosmetics[slot] = id;
        Cade.haptic(8); markDirty(); refreshAll(); openTailor();
      });
    })(btns[i]);
  }

  // ---- quests ---------------------------------------------------------------
  function questDesc(q) {
    if (q.type === 'kills') return 'Slay ' + q.goal + ' monsters';
    if (q.type === 'gems') return 'Collect ' + q.goal + ' gems';
    if (q.type === 'depth') return 'Reach floor ' + q.goal;
    if (q.type === 'boss') return 'Defeat a boss';
    return 'Bounty';
  }
  function genQuest() {
    var d = Math.max(1, hero.maxDepth), roll = ri(4), q = { prog: 0, done: false };
    if (roll === 0) q.type = 'kills', q.goal = 8 + ri(10) + d;
    else if (roll === 1) q.type = 'gems', q.goal = 2 + ri(3);
    else if (roll === 2) q.type = 'depth', q.goal = Math.max(2, d + 1 + ri(3));
    else q.type = 'boss', q.goal = 1;
    q.id = 'q' + Date.now().toString(36) + ri(99999).toString(36);
    q.reward = Math.round((40 + d * 18) * (q.type === 'boss' ? 4 : q.type === 'depth' ? 2 : 1) + ri(50));
    q.desc = questDesc(q);
    if (q.type === 'depth') q.prog = Math.min(q.goal, hero.maxDepth);
    return q;
  }
  function questProgress(type, n) {
    if (!hero.quests) return; var changed = false;
    for (var i = 0; i < hero.quests.length; i++) { var q = hero.quests[i];
      if (q.type === type && !q.done) { q.prog = (q.prog || 0) + n; if (q.prog >= q.goal) { q.prog = q.goal; q.done = true; changed = true; logMsg('win', 'Bounty ready to claim: ' + q.desc); } }
    }
    if (changed) markDirty();
  }
  function questDepth(depth) {
    if (!hero.quests) return;
    for (var i = 0; i < hero.quests.length; i++) { var q = hero.quests[i];
      if (q.type === 'depth' && !q.done) { if (depth >= q.goal) { q.prog = q.goal; q.done = true; logMsg('win', 'Bounty ready to claim: ' + q.desc); } else q.prog = Math.max(q.prog || 0, depth); }
    }
  }
  function openQuestBoard() {
    var ov = mkOverlay('Quest Board 📜');
    var body = ov.querySelector('.cr-ov-body');
    hero.quests = hero.quests || [];
    var html = '<div class="cr-shopgold">🪙 ' + hero.gold + ' · bounties done: ' + (hero.questsDone || 0) + '</div><div class="cr-shop">';
    if (!hero.quests.length) html += '<div class="cr-hint">No active bounties — take one below.</div>';
    hero.quests.forEach(function (q) {
      html += '<div class="cr-srow"><span class="cr-sic">' + (q.done ? '✅' : '📜') + '</span>' +
        '<span class="cr-snm">' + q.desc + '<span class="cr-sdesc">' + (q.done ? 'Complete!' : (q.prog || 0) + ' / ' + q.goal) + ' · reward 🪙' + q.reward + '</span></span>' +
        (q.done ? '<button class="cr-buy" data-claim="' + q.id + '">claim</button>' : '<button class="cr-buy" data-abandon="' + q.id + '">drop</button>') + '</div>';
    });
    if (hero.quests.length < 3) html += '<div class="cr-srow"><span class="cr-sic">➕</span><span class="cr-snm">New bounty<span class="cr-sdesc">Take a fresh contract</span></span><button class="cr-buy" data-newquest="1">take</button></div>';
    html += '</div>';
    body.innerHTML = html;
    function findQ(id) { for (var i = 0; i < hero.quests.length; i++) if (hero.quests[i].id === id) return i; return -1; }
    var cb = body.querySelectorAll('[data-claim]');
    for (var i = 0; i < cb.length; i++) (function (btn) { btn.addEventListener('click', function () {
      var ix = findQ(btn.getAttribute('data-claim')); if (ix < 0) return;
      var q = hero.quests[ix]; hero.gold += Math.round(q.reward * greedOf()); hero.questsDone = (hero.questsDone || 0) + 1;
      if (chance(0.5)) acquireGear(generateItem(null, hero.maxDepth + 2, 0.5));
      hero.quests.splice(ix, 1);
      Cade.haptic(10); Cade.showToast('Bounty complete! +' + q.reward + ' gold', 'success', 1800); markDirty(); refreshAll(); openQuestBoard();
    }); })(cb[i]);
    var ab = body.querySelectorAll('[data-abandon]');
    for (var j = 0; j < ab.length; j++) (function (btn) { btn.addEventListener('click', function () {
      var ix = findQ(btn.getAttribute('data-abandon')); if (ix >= 0) hero.quests.splice(ix, 1);
      markDirty(); openQuestBoard();
    }); })(ab[j]);
    var nb = body.querySelector('[data-newquest]');
    if (nb) nb.addEventListener('click', function () { if (hero.quests.length < 3) { hero.quests.push(genQuest()); markDirty(); openQuestBoard(); } });
  }

  // ---- overlay: options (delete save / restart) -----------------------------
  function openOptions() {
    if (!hero) return;
    closeOverlay();
    var ov = mkOverlay('Options ⚙'); var body = ov.querySelector('.cr-ov-body');
    var diffBtns = DIFF_ORDER.map(function (id) {
      return '<button class="cr-cos' + (hero.difficulty === id ? ' cr-on' : '') + '" data-diff="' + id + '"><span>' + DIFFS[id].name + '</span><small>' + (id === 'normal' ? 'baseline' : Math.round(DIFFS[id].atk * 100) + '% dmg') + '</small></button>';
    }).join('');
    body.innerHTML =
      '<div class="cr-hint">Your delver is saved on this device and synced to Firebase (room __cade_dungeon) when configured.</div>' +
      '<div class="cr-grid2">' + stat('Level', hero.level) + stat('Deepest', hero.maxDepth) + stat('Bounties', hero.questsDone || 0) + stat('Runs', hero.stats.runs || 0) + '</div>' +
      '<div class="cr-sec">Difficulty</div><div class="cr-hint">Harder foes hit back — and pay out more XP & loot. Applies as you descend.</div><div class="cr-cosrow">' + diffBtns + '</div>' +
      '<div class="cr-sec">Danger zone</div>' +
      '<button class="cr-buy cr-danger" id="cr-del">🗑 Delete character & start over</button>' +
      '<div class="cr-hint" id="cr-del-hint"></div>';
    var dbs = body.querySelectorAll('[data-diff]');
    for (var i = 0; i < dbs.length; i++) (function (btn) { btn.addEventListener('click', function () { hero.difficulty = btn.getAttribute('data-diff'); Cade.haptic(6); markDirty(); openOptions(); }); })(dbs[i]);
    var del = document.getElementById('cr-del'), armed = false;
    del.addEventListener('click', function () {
      if (!armed) { armed = true; del.textContent = '⚠ Tap again to permanently erase'; document.getElementById('cr-del-hint').textContent = 'Wipes level, gold, gear, spells, cosmetics — everything.'; return; }
      wipeSave();
    });
  }
  function wipeSave() {
    try { Cade.store.remove(LKEY); } catch (e) {}
    var db = fbDb(); if (db) { try { db.ref(FB_PATH).remove(); } catch (e) {} }
    hero = freshHero(); hero.client = clientId; hero.rev = 1;
    saveLocal();
    closeOverlay(); buildAbilityBar(); enter(0); refreshAll();
    Cade.showToast('A fresh delver begins.', 'success', 1800);
  }

  // ---- overlay: world map (travel between regions) ---------------------------
  function travel(idx) {
    if (idx === 'town') { closeOverlay(); enter(0); return; }
    if (!regionUnlocked(idx)) { Cade.showToast('Locked — clear the boss before it', 'info', 1600); return; }
    closeOverlay();
    hero.stats.runs = (hero.stats.runs || 0) + 1;
    enter(regionStart(idx));
  }
  function openWorldMap() {
    if (!hero) return;
    closeOverlay();
    var ov = mkOverlay('World Map 🗺'); var body = ov.querySelector('.cr-ov-body');
    var html = '<div class="cr-hint">Travel anywhere you\'ve opened. Defeat a region\'s boss to unlock the next.</div><div class="cr-shop">';
    html += '<div class="cr-srow"><span class="cr-sic">🏠</span><span class="cr-snm">Hearthhold<span class="cr-sdesc">Safe town — shops, bounties, home</span></span><button class="cr-buy" data-travel="town">go</button></div>';
    REGIONS.forEach(function (r, idx) {
      var unlocked = regionUnlocked(idx), cleared = hero.maxDepth > regionEnd(idx);
      var status = !unlocked ? '🔒 locked' : cleared ? '✓ cleared' : 'floors ' + regionStart(idx) + '–' + regionEnd(idx);
      var sub = unlocked ? r.blurb : 'Defeat the boss of ' + (REGIONS[idx - 1] ? REGIONS[idx - 1].name : 'the prior region');
      html += '<div class="cr-srow"><span class="cr-sic">' + r.icon + '</span>' +
        '<span class="cr-snm"><span style="color:' + (unlocked ? r.pal.accent : '#6b7280') + '">' + r.name + '</span><span class="cr-sdesc">' + sub + ' · ' + status + '</span></span>' +
        (unlocked ? '<button class="cr-buy" data-travel="' + idx + '">enter</button>' : '<span class="cr-buy cr-owned">🔒</span>') + '</div>';
    });
    html += '</div>';
    body.innerHTML = html;
    var btns = body.querySelectorAll('[data-travel]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () { var t = btn.getAttribute('data-travel'); travel(t === 'town' ? 'town' : parseInt(t, 10)); });
    })(btns[i]);
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
      v: 4, name: hero.name, level: hero.level, xp: hero.xp,
      maxHp: hero.maxHp, hp: hero.hp, maxMp: hero.maxMp, mp: hero.mp,
      atk: hero.atk, def: hero.def, crit: hero.crit, gold: hero.gold,
      depth: hero.depth, maxDepth: hero.maxDepth, equip: hero.equip, bag: hero.bag,
      owned: hero.owned, spells: hero.spells, docked: hero.docked,
      cosmetics: hero.cosmetics, ownedCos: hero.ownedCos,
      quests: hero.quests, questsDone: hero.questsDone || 0, difficulty: hero.difficulty || 'normal',
      stats: hero.stats, _wlvl: hero._wlvl || 0, _alvl: hero._alvl || 0,
      _konami: hero._konami || false, _fled: hero._fled || 0,
      createdAt: hero.createdAt, updatedAt: Date.now(), rev: hero.rev, client: clientId
    };
  }
  function deserialize(d) {
    if (!d || typeof d !== 'object') return null;
    var h = freshHero();
    for (var k in d) if (d[k] != null) h[k] = d[k];
    // normalize the only free-form, remotely-settable string
    h.name = String(h.name == null ? 'Delver' : h.name).replace(/[<>]/g, '').slice(0, 24) || 'Delver';
    h.bag = h.bag || { potion: 1 };
    // ---- gear model migration: old saves stored base-id strings; new saves
    //      store rolled item instances. Convert and re-point equipment. --------
    var oldEquip = h.equip || {};
    if (!Array.isArray(h.owned)) h.owned = [];
    if (h.owned.length && typeof h.owned[0] === 'string') {
      var map = {}, inst = [];
      h.owned.forEach(function (id) { var b = gear(id); if (b) { var it = makeBaseInstance(id, 'common', Math.max(1, (b.tier || 1) * 2)); map[id] = it.uid; inst.push(it); } });
      h.owned = inst;
      h.equip = {
        weapon: (oldEquip.weapon && map[oldEquip.weapon]) || null,
        armor: (oldEquip.armor && map[oldEquip.armor]) || null,
        trinket: (oldEquip.trinket && oldEquip.trinket !== 'none' && map[oldEquip.trinket]) || null
      };
    } else {
      h.owned = h.owned.filter(function (it) { return it && it.uid && gear(it.base); });
      h.equip = h.equip || {};
      ['weapon', 'armor', 'trinket'].forEach(function (sl) { var u = h.equip[sl]; if (u && !h.owned.some(function (it) { return it.uid === u; })) h.equip[sl] = null; });
    }
    if (!h.owned.length) { var d0 = makeBaseInstance('dagger', 'common', 2), r0 = makeBaseInstance('rags', 'common', 1); h.owned = [d0, r0]; h.equip = { weapon: d0.uid, armor: r0.uid, trinket: null }; }
    ['weapon', 'armor'].forEach(function (sl) { if (!h.equip[sl]) { for (var i = 0; i < h.owned.length; i++) if (h.owned[i].slot === sl) { h.equip[sl] = h.owned[i].uid; break; } } });
    h.spells = (h.spells || ['strike']).filter(function (id) { return !!ABIL[id]; });
    if (h.spells.indexOf('strike') < 0) h.spells.unshift('strike');
    // BUGFIX: grant every auto-learned spell the hero has already out-leveled.
    // (Auto-spells were only granted on the exact level-up tick, so migrated or
    // high-level characters could never get Firebolt/Blink/etc., and the
    // Arcanist only sells the tome spells — leaving no recovery path.)
    ABIL_ORDER.forEach(function (id) { if (ABIL[id].learn === 'auto' && h.level >= ABIL[id].lvl && h.spells.indexOf(id) < 0) h.spells.push(id); });
    h.docked = (h.docked || []).filter(function (id) { return h.spells.indexOf(id) >= 0; }).slice(0, DOCK_MAX);
    for (var di = 0; di < h.spells.length && h.docked.length < DOCK_MAX; di++) if (h.docked.indexOf(h.spells[di]) < 0) h.docked.push(h.spells[di]);
    h.cosmetics = h.cosmetics || {};
    var COSDEF = { color: 'cyan', eyes: 'default', pattern: 'none', belt: 'none', hat: 'none', cape: 'none', pet: 'none' };
    COS_SLOTS.forEach(function (sl) { if (!COSMETIC[sl] || !COSMETIC[sl][h.cosmetics[sl]]) h.cosmetics[sl] = COSDEF[sl]; });
    h.ownedCos = Array.isArray(h.ownedCos) ? h.ownedCos : [];
    h.quests = Array.isArray(h.quests) ? h.quests : [];
    if (!DIFFS[h.difficulty]) h.difficulty = 'normal';
    h.stats = h.stats || { kills: 0, deaths: 0, floors: 0, gems: 0, runs: 0 };
    h.buffs = {};
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
    var useRemote = function (val) {
      var remote = deserialize(val);
      var chosen;
      if (remote && local) chosen = (progressScore(remote) >= progressScore(local)) ? remote : local;
      else chosen = remote || local || freshHero();
      fin(chosen);
    };
    try {
      db.ref(FB_PATH).once('value').then(function (snap) {
        var v = snap.val();
        if (v != null) { useRemote(v); return; }
        // nothing at the new path — migrate a save left at the old visible path
        db.ref(FB_PATH_OLD).once('value').then(function (s2) {
          var ov = s2.val();
          if (ov != null) migrateOld = true;
          useRemote(ov);
        }).catch(function () { useRemote(null); });
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
          // a newer remote exists but we're mid-run — keep playing, but advance
          // our logical clock past it so an equal-progress tie resolves to the
          // active device and the progressScore transaction stays coherent.
          hero._remoteAhead = remote.rev;
          hero.rev = Math.max(hero.rev || 1, remote.rev || 1);
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
    var mine = serialize(), myScore = progressScore(mine);
    try {
      // Conflict-safe write: keep whichever character is more progressed (same
      // rule loadHero uses), so a second open device can't clobber a better run.
      db.ref(FB_PATH).transaction(function (cur) {
        if (cur && cur.client !== clientId && progressScore(cur) > myScore) return; // abort, keep remote
        return mine;
      }, undefined, false);
    } catch (e) { try { db.ref(FB_PATH).set(mine); } catch (e2) {} }
    if (migrateOld) { migrateOld = false; try { db.ref(FB_PATH_OLD).remove(); } catch (e3) {} }
  }

  // =========================================================================
  //  input
  // =========================================================================
  // ---- Konami easter egg ----------------------------------------------------
  var konamiBuf = [];
  var KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
  function konamiPush(k) {
    if (!k) return;
    konamiBuf.push(k.toLowerCase());
    if (konamiBuf.length > KONAMI.length) konamiBuf.shift();
    if (konamiBuf.length < KONAMI.length) return;
    for (var i = 0; i < KONAMI.length; i++) if (konamiBuf[i] !== KONAMI[i]) return;
    konamiBuf.length = 0; konamiReward();
  }
  function konamiReward() {
    if (!hero) return;
    if (!hero._konami) {
      hero._konami = true; acquireGear('lucky');
      Cade.showToast('🍀 The Delver’s Blessing — a Lucky Clover appears!', 'success', 3000);
      logMsg('win', 'A four-leaf clover materializes in your pack!');
    } else {
      hero.hp = maxHpOf(); hero.mp = maxMpOf();
      Cade.showToast('🍀 Fully restored.', 'success', 1800);
    }
    if (world && world.player) fxBurst(world.player.x, world.player.y, '#7fe08a');
    markDirty(); refreshAll();
  }

  function isTyping(e) {
    var t = e.target; if (!t) return false;
    var tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    if (t.closest && t.closest('.cm-editor')) return true;
    return false;
  }
  function onKey(e) {
    var pan = document.getElementById('crawler-panel');
    if (!pan) return;
    // Don't hijack keys while the user is typing in the editor / an input —
    // only act when the game itself holds focus, or focus is on nothing special.
    if (!pan.contains(document.activeElement) && isTyping(e)) return;
    var k = e.key;
    konamiPush(k);
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
    else if (k >= '1' && k <= '4') { e.preventDefault(); var ids = dockedSpells(); var idx = parseInt(k, 10) - 1; if (ids[idx]) useAbility(ids[idx]); }
    else if (k === 'q' || k === 'Q') { e.preventDefault(); useItem('potion'); }
  }

  function bindCanvasInput(canvas) {
    var sx = 0, sy = 0, st = 0, moved = false, tracking = false;
    canvas.addEventListener('pointerdown', function (e) { try { canvas.focus(); } catch (er) {} sx = e.clientX; sy = e.clientY; st = now(); moved = false; tracking = true; }, { passive: true });
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
      var cam = camera();                       // cam.x/y are floats now
      var tx = Math.floor(lx / TILE + cam.x), ty = Math.floor(ly / TILE + cam.y);
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return;
      var p = world.player;
      if (cheb(tx, ty, p.x, p.y) <= 1) {
        if (tx === p.x && ty === p.y) { interact(); }
        else {
          // collapse a diagonal tap to one cardinal step (movement is 4-dir)
          var ddx = tx - p.x, ddy = ty - p.y;
          if (ddx !== 0 && ddy !== 0) { if (Math.abs(ddx) >= Math.abs(ddy)) ddy = 0; else ddx = 0; }
          cancelTravel(); tryMove(sgn(ddx), sgn(ddy));
        }
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
  // If you bail out while alive in a dungeon (closing the panel rather than
  // using the 🏠 recall), flag it so reopening costs you — no quit-to-escape.
  function markFled() { if (hero && world && world.mode === 'dungeon') hero._fled = world.depth; }
  function close() {
    markFled();
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
            '<button id="cr-home" class="cr-tbtn" title="Return to town">🏠</button>' +
            '<button id="cr-map" class="cr-tbtn" title="World map">🗺</button>' +
            '<button id="cr-char" class="cr-tbtn" title="Character (C)">🎒</button>' +
            '<button id="cr-opts" class="cr-tbtn" title="Options">⚙</button>' +
          '</div>' +
        '</div>' +
        '<div id="cr-hud" class="cr-hud"></div>' +
        '<div class="cr-stage"><canvas id="crawler-canvas" class="cr-canvas" tabindex="0"></canvas>' +
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
    bindButton(document.getElementById('cr-home'), recall);
    bindButton(document.getElementById('cr-opts'), openOptions);
    bindButton(document.getElementById('cr-map'), openWorldMap);

    panel._onClose = function () {
      markFled(); saveNow(); state_teardown(); detachFbListener();
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
      // flee penalty: if we bailed mid-dungeon last session, pay for it now
      if (hero._fled) {
        var fd = hero._fled; hero._fled = 0;
        var loss = Math.floor(hero.gold * 0.1);
        hero.gold = Math.max(0, hero.gold - loss);
        logMsg('die', 'You abandoned floor ' + fd + ' — you stumble back to town' + (loss ? ', ' + loss + ' gold lighter.' : '.'));
        Cade.showToast('You fled floor ' + fd + (loss ? ' — lost ' + loss + ' gold' : ''), 'error', 2800);
        markDirty();
      }
      refreshAll();
      try { ui.canvas.focus(); } catch (e) {}   // so desktop keys drive the game immediately
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
