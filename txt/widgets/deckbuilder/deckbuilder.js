/* Deck Delve — a card-battling roguelite, for Cade.txt.
 * Climb three acts of a branching map (fights, elites, events, shops, rest
 * sites, treasure and a boss at the top of each act). Battles are turn based:
 * three energy a turn; cards you don't play stay in your hand for later turns
 * (up to ten); attacks, block and the classic statuses (Vulnerable, Weak,
 * Frail, Poison, Strength, Dexterity, Plating, Thorns...). Enemies show what
 * they mean to do next, unless they hide it ("?"), and some change plans when
 * hurt or hexed; scouting cards and relics reveal hidden intents, and the
 * Blindfold modifier hides every intent for a whole run. Win a fight, pick a
 * card; beat an elite, take a relic. Rest sites heal or upgrade a card, shops
 * sell cards and relics and remove cards for gold, events tempt you.
 * 77 cards (plus statuses and curses), 28 enemies + 3 bosses, 34 relics, 12 events — all original.
 * Runs are seeded (share a seed, or play the daily delve — the same seed for
 * everyone on a date), saved after every action (resume mid-fight), and the
 * run history keeps records. Monospace DOM cards: tap a card, then a target.
 * Persists in Cade.store (cade-deckbuilder-*). Offline module, no assets. */
(function () {
  'use strict';

  // ================= engine (pure: no DOM — unit-checked in node) =================
  var VERSION = 2;                          // 2: hand retention, hidden / changing intents, Blindfold (v1 saves still load)
  var ROWS = 12, COLS = 7, PATHS = 6;      // map grid per act; the boss sits above the last row
  var FLOORS = ROWS + 1;                    // floors per act (rows + boss)
  var START_HP = 80, BASE_ENERGY = 3, MAX_HAND = 10;
  // Cards you don't play stay in your hand. Each turn after the first (`first` cards) you
  // draw back up to `to` cards in hand, but always at least `min` new ones, so holding
  // 3 cards is free and every card held past that costs a fresh draw. The hand never holds
  // more than MAX_HAND (further draws stay in the draw pile). ehp: enemy HP multiplier per
  // act. Tuned by simulating seeded runs with a greedy bot; exported so it can try variants.
  var RULES = { first: 5, to: 5, min: 2, ehp: [1, 0.9, 1] };
  var ACT_NAMES = ['The Rootways', 'The Drowned Halls', 'The Hollow Crown'];

  // ---- seeded randomness: mulberry32 streams kept as plain numbers in the run (saveable) ----
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return h >>> 0;
  }
  function mix(a, b) {
    var h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h >>> 0;
  }
  function rnd(R, k) {
    var a = ((R.rng[k] >>> 0) + 0x6D2B79F5) | 0;
    R.rng[k] = a >>> 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rint(R, k, n) { return Math.floor(rnd(R, k) * n); }
  function rrange(R, k, a, b) { return a + Math.floor(rnd(R, k) * (b - a + 1)); }
  function pick(R, k, arr) { return arr[rint(R, k, arr.length)]; }
  function shuffle(R, k, arr) {
    for (var i = arr.length - 1; i > 0; i--) { var j = rint(R, k, i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  var STREAMS = ['map', 'cmb', 'shuf', 'loot', 'evt', 'ai'];
  // Seeds are shown as 6 base-36 characters; any text is a seed (hashed).
  function seedCode(n) { var s = (n >>> 0).toString(36).toUpperCase(); while (s.length < 7) s = '0' + s; return s; }
  function parseSeed(text) {
    var t = String(text == null ? '' : text).trim().toUpperCase();
    if (!t) return null;
    if (/^[0-9A-Z]{1,7}$/.test(t)) { var n = parseInt(t, 36); if (n >= 0 && n <= 4294967295) return n >>> 0; }
    return hashStr(t);
  }
  function dailySeed(dateKey) { return mix(hashStr('deck-delve:' + dateKey), 20261031) >>> 0; }
  function dateKey(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ================= cards =================
  // t: atk | skl | pow | sts (status) | crs (curse);  r: basic | common | uncommon | rare | special
  // c: cost (-1 = X: spends all energy); omitted c = unplayable;  tg: e (an enemy) | all | none
  // a: actions;  ex: exhaust;  eth: ethereal (exhausts if still in hand at end of turn)
  // u: what the upgrade changes (any of c, a, ex, eth, tg)
  var CARDS = {
    // --- starter ---
    strike: { n: 'Strike', t: 'atk', r: 'basic', c: 1, tg: 'e', a: [['dmg', 6]], u: { a: [['dmg', 9]] } },
    guard: { n: 'Guard', t: 'skl', r: 'basic', c: 1, tg: 'none', a: [['blk', 5]], u: { a: [['blk', 8]] } },
    lunge: { n: 'Lunge', t: 'atk', r: 'basic', c: 2, tg: 'e', a: [['dmg', 8], ['st', 'vuln', 2]], u: { a: [['dmg', 10], ['st', 'vuln', 3]] } },
    // --- common attacks ---
    twinCut: { n: 'Twin Cut', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 5, 2]], u: { a: [['dmg', 7, 2]] } },
    sweep: { n: 'Sweep', t: 'atk', r: 'common', c: 1, tg: 'all', a: [['dmgAll', 8]], u: { a: [['dmgAll', 11]] } },
    jab: { n: 'Quick Jab', t: 'atk', r: 'common', c: 0, tg: 'e', a: [['dmg', 3], ['draw', 1]], u: { a: [['dmg', 5], ['draw', 1]] } },
    shieldBash: { n: 'Shield Bash', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['bodySlam']], u: { c: 0 } },
    hamstring: { n: 'Hamstring', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 7], ['st', 'weak', 1]], u: { a: [['dmg', 9], ['st', 'weak', 2]] } },
    venomDart: { n: 'Venom Dart', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 4], ['st', 'poison', 3]], u: { a: [['dmg', 5], ['st', 'poison', 4]] } },
    heavyBlow: { n: 'Heavy Blow', t: 'atk', r: 'common', c: 2, tg: 'e', a: [['strMul', 14, 3]], u: { a: [['strMul', 18, 5]] } },
    bracedStrike: { n: 'Braced Strike', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 5], ['blk', 5]], u: { a: [['dmg', 7], ['blk', 7]] } },
    rake: { n: 'Rake', t: 'atk', r: 'common', c: 1, tg: 'all', a: [['dmgRand', 3, 3]], u: { a: [['dmgRand', 3, 4]] } },
    pommel: { n: 'Pommel', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 9], ['draw', 1]], u: { a: [['dmg', 10], ['draw', 2]] } },
    recklessSwing: { n: 'Reckless Swing', t: 'atk', r: 'common', c: 1, tg: 'e', a: [['dmg', 12], ['add', 'wound', 1, 'draw']], u: { a: [['dmg', 16], ['add', 'wound', 1, 'draw']] } },
    spark: { n: 'Spark', t: 'atk', r: 'special', c: 0, tg: 'e', a: [['dmg', 4]], ex: true, u: { a: [['dmg', 6]] } },
    // --- common skills ---
    sidestep: { n: 'Sidestep', t: 'skl', r: 'common', c: 1, tg: 'none', a: [['blk', 8]], u: { a: [['blk', 11]] } },
    shakeOff: { n: 'Shake It Off', t: 'skl', r: 'common', c: 1, tg: 'none', a: [['blk', 7], ['draw', 1]], u: { a: [['blk', 10], ['draw', 1]] } },
    bulwark: { n: 'Bulwark', t: 'skl', r: 'common', c: 2, tg: 'none', a: [['blk', 13]], u: { a: [['blk', 17]] } },
    smokeBomb: { n: 'Smoke Bomb', t: 'skl', r: 'common', c: 1, tg: 'none', a: [['blk', 6], ['stAll', 'weak', 1]], u: { a: [['blk', 8], ['stAll', 'weak', 2]] } },
    rummage: { n: 'Rummage', t: 'skl', r: 'common', c: 1, tg: 'none', a: [['draw', 2]], u: { a: [['draw', 3]] } },
    coatBlade: { n: 'Coat Blade', t: 'skl', r: 'common', c: 1, tg: 'e', a: [['st', 'poison', 5]], u: { a: [['st', 'poison', 7]] } },
    pumpUp: { n: 'Pump Up', t: 'skl', r: 'common', c: 0, tg: 'none', a: [['me', 'tmpStr', 2]], u: { a: [['me', 'tmpStr', 4]] } },
    tripwire: { n: 'Tripwire', t: 'skl', r: 'common', c: 1, tg: 'e', a: [['blk', 5], ['st', 'weak', 1]], u: { a: [['blk', 7], ['st', 'weak', 2]] } },
    bandage: { n: 'Bandage', t: 'skl', r: 'common', c: 0, tg: 'none', a: [['heal', 4]], ex: true, u: { a: [['heal', 6]] } },
    expose: { n: 'Expose', t: 'skl', r: 'common', c: 0, tg: 'e', a: [['st', 'vuln', 1]], u: { a: [['st', 'vuln', 2]] } },
    scout: { n: 'Scout', t: 'skl', r: 'common', c: 0, tg: 'none', a: [['scout'], ['draw', 1]], u: { a: [['scout'], ['draw', 2]] } },
    bide: { n: 'Bide', t: 'skl', r: 'common', c: 1, tg: 'none', a: [['bide', 2]], u: { a: [['bide', 3]] } },
    // --- uncommon attacks ---
    whirl: { n: 'Whirl', t: 'atk', r: 'uncommon', c: -1, tg: 'all', a: [['dmgAll', 5, 'X']], u: { a: [['dmgAll', 8, 'X']] } },
    exploit: { n: 'Exploit', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['dmgVuln', 8]], u: { a: [['dmgVuln', 11]] } },
    siphon: { n: 'Siphon', t: 'atk', r: 'uncommon', c: 2, tg: 'e', a: [['drain', 10]], ex: true, u: { a: [['drain', 14]] } },
    thunderclap: { n: 'Thunderclap', t: 'atk', r: 'uncommon', c: 1, tg: 'all', a: [['dmgAll', 4], ['stAll', 'vuln', 1]], u: { a: [['dmgAll', 7], ['stAll', 'vuln', 1]] } },
    bloodEdge: { n: 'Blood Edge', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['hpLoss', 2], ['dmg', 14]], u: { a: [['hpLoss', 2], ['dmg', 18]] } },
    flurry: { n: 'Flurry', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['dmg', 2, 4]], u: { a: [['dmg', 3, 4]] } },
    momentum: { n: 'Momentum', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['grow', 8, 4]], u: { a: [['grow', 8, 6]] } },
    crushingBlow: { n: 'Crushing Blow', t: 'atk', r: 'uncommon', c: 2, tg: 'e', a: [['dmg', 10], ['st', 'weak', 2], ['st', 'vuln', 2]], u: { a: [['dmg', 13], ['st', 'weak', 2], ['st', 'vuln', 2]] } },
    ricochet: { n: 'Ricochet', t: 'atk', r: 'uncommon', c: 2, tg: 'all', a: [['dmgRand', 4, 5]], u: { a: [['dmgRand', 5, 5]] } },
    toxicStab: { n: 'Toxic Stab', t: 'atk', r: 'uncommon', c: 2, tg: 'e', a: [['dmg', 6], ['st', 'poison', 6]], u: { a: [['dmg', 8], ['st', 'poison', 8]] } },
    counterCut: { n: 'Counter Cut', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['blk', 4], ['bodySlam']], u: { a: [['blk', 7], ['bodySlam']] } },
    dropkick: { n: 'Dropkick', t: 'atk', r: 'uncommon', c: 1, tg: 'e', a: [['dmg', 5], ['ifVuln']], u: { a: [['dmg', 8], ['ifVuln']] } },
    // --- uncommon skills ---
    catalyst: { n: 'Catalyst', t: 'skl', r: 'uncommon', c: 1, tg: 'e', a: [['catalyst', 2]], ex: true, u: { a: [['catalyst', 3]] } },
    disarm: { n: 'Disarm', t: 'skl', r: 'uncommon', c: 1, tg: 'e', a: [['st', 'str', -2]], ex: true, u: { a: [['st', 'str', -3]] } },
    entrench: { n: 'Entrench', t: 'skl', r: 'uncommon', c: 2, tg: 'none', a: [['dblBlk']], u: { c: 1 } },
    adrenaline: { n: 'Adrenaline', t: 'skl', r: 'rare', c: 0, tg: 'none', a: [['energy', 1], ['draw', 2]], ex: true, u: { a: [['energy', 2], ['draw', 2]] } },
    ward: { n: 'Ward', t: 'skl', r: 'uncommon', c: 1, tg: 'none', a: [['blk', 6], ['me', 'nextBlk', 6]], u: { a: [['blk', 8], ['me', 'nextBlk', 8]] } },
    burnBridges: { n: 'Burn Bridges', t: 'skl', r: 'uncommon', c: 1, tg: 'none', a: [['exRand'], ['draw', 2]], u: { a: [['exRand'], ['draw', 3]] } },
    conjure: { n: 'Conjure Blades', t: 'skl', r: 'uncommon', c: 1, tg: 'none', a: [['add', 'spark', 3, 'hand']], ex: true, u: { a: [['add', 'spark', 4, 'hand']] } },
    miasma: { n: 'Miasma', t: 'skl', r: 'uncommon', c: 1, tg: 'all', a: [['stAll', 'poison', 3]], u: { a: [['stAll', 'poison', 5]] } },
    intimidate: { n: 'Intimidate', t: 'skl', r: 'uncommon', c: 0, tg: 'all', a: [['stAll', 'weak', 1]], ex: true, u: { a: [['stAll', 'weak', 2]] } },
    secondWind: { n: 'Second Wind', t: 'skl', r: 'uncommon', c: 1, tg: 'none', a: [['secondWind', 5]], u: { a: [['secondWind', 7]] } },
    rush: { n: 'Rush', t: 'skl', r: 'uncommon', c: 0, tg: 'none', a: [['draw', 2], ['add', 'dazed', 1, 'disc']], u: { a: [['draw', 3], ['add', 'dazed', 1, 'disc']] } },
    fervor: { n: 'Fervor', t: 'skl', r: 'uncommon', c: 0, tg: 'none', a: [['me', 'fervor', 3]], u: { a: [['me', 'fervor', 5]] } },
    mend: { n: 'Mend', t: 'skl', r: 'uncommon', c: 1, tg: 'none', a: [['heal', 7]], ex: true, u: { a: [['heal', 10]] } },
    counterplay: { n: 'Counterplay', t: 'skl', r: 'uncommon', c: 1, tg: 'e', a: [['counter', 14]], u: { a: [['counter', 20]] } },
    parry: { n: 'Parry', t: 'skl', r: 'uncommon', c: 1, tg: 'e', a: [['blk', 8], ['st', 'str', -1, 'turn']], u: { a: [['blk', 11], ['st', 'str', -1, 'turn']] } },
    // --- powers ---
    innerFire: { n: 'Inner Fire', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'str', 2]], u: { a: [['me', 'str', 3]] } },
    footwork: { n: 'Footwork', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'dex', 2]], u: { a: [['me', 'dex', 3]] } },
    thornmail: { n: 'Thornmail', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'thorns', 3]], u: { a: [['me', 'thorns', 5]] } },
    ironBark: { n: 'Iron Bark', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'metal', 3]], u: { a: [['me', 'metal', 5]] } },
    sporeCloud: { n: 'Spore Cloud', t: 'pow', r: 'rare', c: 2, tg: 'none', a: [['me', 'poisonAura', 2]], u: { a: [['me', 'poisonAura', 3]] } },
    flow: { n: 'Flow', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'drawP', 1]], u: { c: 0 } },
    wellspring: { n: 'Wellspring', t: 'pow', r: 'rare', c: 3, tg: 'none', a: [['me', 'energyP', 1]], u: { c: 2 } },
    bloodOath: { n: 'Blood Oath', t: 'pow', r: 'rare', c: 2, tg: 'none', a: [['me', 'ritual', 1]], u: { c: 1 } },
    stoneStance: { n: 'Stone Stance', t: 'pow', r: 'rare', c: 3, tg: 'none', a: [['me', 'keepBlock', 1]], u: { c: 2 } },
    emberRing: { n: 'Ember Ring', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'flameAura', 3]], u: { a: [['me', 'flameAura', 5]] } },
    envenom: { n: 'Envenom', t: 'pow', r: 'rare', c: 2, tg: 'none', a: [['me', 'envenom', 1]], u: { c: 1 } },
    foresight: { n: 'Foresight', t: 'pow', r: 'uncommon', c: 1, tg: 'none', a: [['me', 'foresight', 1]], u: { c: 0 } },
    spikedShell: { n: 'Spiked Shell', t: 'pow', r: 'rare', c: 2, tg: 'none', a: [['me', 'spikes', 5]], u: { a: [['me', 'spikes', 7]] } },
    // --- rares ---
    cataclysm: { n: 'Cataclysm', t: 'atk', r: 'rare', c: 3, tg: 'e', a: [['dmg', 32]], u: { a: [['dmg', 42]] } },
    limitSurge: { n: 'Limit Surge', t: 'skl', r: 'rare', c: 1, tg: 'none', a: [['dblStr']], ex: true, u: { ex: false } },
    reapingWind: { n: 'Reaping Wind', t: 'atk', r: 'rare', c: 2, tg: 'all', a: [['drainAll', 7]], ex: true, u: { a: [['drainAll', 9]] } },
    hone: { n: 'Hone', t: 'skl', r: 'rare', c: 1, tg: 'none', a: [['upHand']], ex: true, u: { c: 0 } },
    rupture: { n: 'Rupture', t: 'atk', r: 'rare', c: 1, tg: 'e', a: [['rupture', 2]], u: { a: [['rupture', 3]] } },
    aegis: { n: 'Aegis', t: 'skl', r: 'rare', c: 2, tg: 'none', a: [['blk', 30]], ex: true, u: { a: [['blk', 40]] } },
    bloodRite: { n: 'Blood Rite', t: 'skl', r: 'rare', c: 0, tg: 'none', a: [['hpLoss', 6], ['energy', 2], ['draw', 3]], ex: true, u: { a: [['hpLoss', 6], ['energy', 2], ['draw', 5]] } },
    devour: { n: 'Devour', t: 'atk', r: 'rare', c: 2, tg: 'e', a: [['devour', 10, 3]], ex: true, u: { a: [['devour', 12, 4]] } },
    tempest: { n: 'Tempest', t: 'atk', r: 'rare', c: 2, tg: 'all', a: [['dmgAll', 6, 3]], u: { a: [['dmgAll', 8, 3]] } },
    mirrorGuard: { n: 'Mirror Guard', t: 'skl', r: 'rare', c: 1, tg: 'none', a: [['blk', 6], ['me', 'thorns', 2]], u: { a: [['blk', 9], ['me', 'thorns', 3]] } },
    // --- statuses (from enemies) and curses (from events) ---
    wound: { n: 'Wound', t: 'sts', r: 'special', tg: 'none', a: [] },
    dazed: { n: 'Dazed', t: 'sts', r: 'special', tg: 'none', a: [], eth: true },
    burn: { n: 'Burn', t: 'sts', r: 'special', tg: 'none', a: [], end: ['burn', 2] },
    ooze: { n: 'Ooze', t: 'sts', r: 'special', c: 1, tg: 'none', a: [], ex: true },
    regret: { n: 'Regret', t: 'crs', r: 'special', tg: 'none', a: [], end: ['regret', 1] },
    doubt: { n: 'Doubt', t: 'crs', r: 'special', tg: 'none', a: [], end: ['doubt', 1] },
    clumsy: { n: 'Clumsy', t: 'crs', r: 'special', tg: 'none', a: [], eth: true }
  };
  var CARD_IDS = Object.keys(CARDS);
  function cdef(card) {
    var d = CARDS[card.id];
    if (!card.u || !d.u) return d;
    var o = {}, k;
    for (k in d) if (k !== 'u') o[k] = d[k];
    for (k in d.u) o[k] = d.u[k];
    o.up = true;
    return o;
  }
  function canUpgrade(card) { return !!(CARDS[card.id] && CARDS[card.id].u && !card.u); }
  function cardName(card) { return CARDS[card.id].n + (card.u && CARDS[card.id].u ? '+' : ''); }
  function playable(d) { return typeof d.c === 'number'; }
  var POOL = { common: [], uncommon: [], rare: [] };
  CARD_IDS.forEach(function (id) { var r = CARDS[id].r; if (POOL[r]) POOL[r].push(id); });

  // ================= statuses =================
  // g: short glyph; good: a buff; dec: ticks down at the end of its owner's turn
  var ST = {
    str: { n: 'Strength', g: 'STR', good: true, d: 'Adds to attack damage.' },
    dex: { n: 'Dexterity', g: 'DEX', good: true, d: 'Adds to Block gained from cards.' },
    vuln: { n: 'Vulnerable', g: 'VUL', dec: true, d: 'Takes 50% more attack damage.' },
    weak: { n: 'Weak', g: 'WK', dec: true, d: 'Deals 25% less attack damage.' },
    frail: { n: 'Frail', g: 'FRL', dec: true, d: 'Gains 25% less Block from cards.' },
    poison: { n: 'Poison', g: 'PSN', d: 'Loses that much HP at the start of its turn, then 1 less.' },
    thorns: { n: 'Thorns', g: 'THN', good: true, d: 'Attackers take this much damage per hit.' },
    metal: { n: 'Plating', g: 'PLT', good: true, d: 'Gains this much Block at the end of its turn.' },
    ritual: { n: 'Ritual', g: 'RIT', good: true, d: 'Gains this much Strength at the end of its turn.' },
    regen: { n: 'Regrowth', g: 'RGN', good: true, d: 'Heals this much at the end of its turn, then 1 less.' },
    tmpStr: { n: 'Pumped', g: 'PMP', good: true, d: 'Strength that fades at the end of your turn.' },
    turnStr: { n: 'Shaken', g: 'SHK', d: 'Strength lost this turn only; comes back at the end of its turn.' },
    nextBlk: { n: 'Ward', g: 'WRD', good: true, d: 'Gain this much Block next turn.' },
    fervor: { n: 'Fervor', g: 'FRV', good: true, d: 'This turn, gain this much Block whenever you play an Attack.' },
    poisonAura: { n: 'Spore Cloud', g: 'SPR', good: true, d: 'At the start of your turn, apply this much Poison to ALL enemies.' },
    drawP: { n: 'Flow', g: 'FLW', good: true, d: 'Draw this many more cards each turn.' },
    energyP: { n: 'Wellspring', g: 'WEL', good: true, d: 'Gain this much more Energy each turn.' },
    keepBlock: { n: 'Stone Stance', g: 'STN', good: true, d: 'Your Block no longer expires.' },
    flameAura: { n: 'Ember Ring', g: 'EMB', good: true, d: 'At the end of your turn, deal this much damage to ALL enemies.' },
    envenom: { n: 'Envenom', g: 'ENV', good: true, d: 'Whenever an attack deals unblocked damage, apply this much Poison.' },
    spikes: { n: 'Spiked Shell', g: 'SPK', good: true, d: 'Whenever you gain Block from a card, deal this much damage to a random enemy.' },
    enrage: { n: 'Enrage', g: 'RAG', good: true, d: 'Gains this much Strength whenever you play a Skill.' },
    foresight: { n: 'Foresight', g: 'FOR', good: true, d: 'Hidden enemy intents are revealed for the rest of the fight.' }
  };

  // ================= enemies =================
  // m: moves — a: actions: ['atk', dmg, hits] ['blk', n] ['st', key, n] (self) ['pst', key, n] (on you)
  //   ['add', card, n, pile] (into your deck for this fight) ['heal', n] ['blkAll', n] (every ally)
  // ai: first (move for turn 1), cyc (cycle of moves) or w (weights; never the same move 3 times running)
  // hide: 'all' (its intent shows only "?") or 'amount' (the kind of move shows, not the numbers)
  // react: changes the planned move on the spot — low: move used once when it first drops under
  //   `at` (default half) of its HP (bosses: a phase change; hideLow then hides its amounts);
  //   dbf: move it switches to when you apply Weak or Vulnerable to it (once per turn)
  var ENEMIES = {
    // --- act I ---
    mossRat: { n: 'Moss Rat', hp: [12, 16], art: [' ()_()', ' (o.o)', ' (")(")'], m: [{ n: 'Bite', a: [['atk', 6]] }, { n: 'Scurry', a: [['blk', 4], ['atk', 3]] }], ai: { w: [3, 2] } },
    caveSlug: { n: 'Cave Slug', hp: [28, 32], art: ['   __', ' _(oo)_', '(______)'], m: [{ n: 'Spit', a: [['atk', 7], ['add', 'ooze', 1, 'disc']] }, { n: 'Gnaw', a: [['atk', 11]] }], ai: { w: [2, 3] } },
    rootCultist: { n: 'Root Cultist', hp: [40, 46], art: ['  /^\\', ' (-_-)', ' /|Y|\\'], m: [{ n: 'Chant', a: [['st', 'ritual', 3]] }, { n: 'Lash', a: [['atk', 6]] }], ai: { first: 0, cyc: [1] } },
    bonePup: { n: 'Bone Pup', hp: [20, 24], art: ['  __', ' /..\\_', ' \\__/ \\'], m: [{ n: 'Snap', a: [['atk', 5]] }, { n: 'Howl', a: [['pst', 'weak', 1], ['st', 'str', 1]] }], ai: { w: [3, 2] }, react: { dbf: 1 } },
    sporePuff: { n: 'Spore Puff', hp: [14, 18], art: ['  .oOo.', ' ( ^ ^ )', "  '-~-'"], m: [{ n: 'Puff', a: [['pst', 'poison', 3]] }, { n: 'Bump', a: [['atk', 4]] }], ai: { cyc: [0, 1] } },
    thornBeetle: { n: 'Thorn Beetle', hp: [30, 34], art: [' \\_/\\_/', ' (####)', ' /\\  /\\'], m: [{ n: 'Harden', a: [['blk', 9], ['st', 'thorns', 2]] }, { n: 'Ram', a: [['atk', 10]] }], ai: { first: 0, w: [1, 2] }, react: { low: 0 } },
    cutpurse: { n: 'Cutpurse', hp: [22, 26], art: ['  ___', ' (>_<)', ' /)$(\\'], m: [{ n: 'Stab', a: [['atk', 8]] }, { n: 'Feint', a: [['blk', 6], ['pst', 'frail', 1]] }], ai: { w: [3, 2] }, hide: 'amount' },
    // act I elites
    ironbark: { n: 'Ironbark Brute', elite: true, hp: [80, 86], art: ['  [###]', ' {(O O)}', ' /|===|\\', '  /   \\'], m: [{ n: 'Smash', a: [['atk', 14]] }, { n: 'Roar', a: [['st', 'str', 2], ['pst', 'weak', 1]] }, { n: 'Batter', a: [['atk', 6, 2]] }], ai: { first: 1, cyc: [0, 2, 1] } },
    lanternWraith: { n: 'Lantern Wraith', elite: true, hp: [64, 70], art: ['   .-.', '  ( * )', ' ~/| |\\~', "  '~~~'"], m: [{ n: 'Hex', a: [['pst', 'vuln', 2], ['pst', 'weak', 2]] }, { n: 'Wail', a: [['atk', 7, 2]] }, { n: 'Drain', a: [['atk', 11], ['heal', 8]] }], ai: { first: 0, cyc: [1, 2, 1, 0] }, hide: 'all' },
    chitinKnight: { n: 'Chitin Knight', elite: true, hp: [72, 78], art: ['  _/^\\_', ' |[o_o]|', ' /|#|#|\\', '  d   b'], m: [{ n: 'Shell Up', a: [['blk', 15], ['st', 'str', 1]] }, { n: 'Lance', a: [['atk', 16]] }], ai: { first: 1, cyc: [0, 1, 1] }, react: { low: 0 } },
    // act I boss
    rootmaw: { n: 'The Rootmaw', boss: true, hp: [160, 160], art: ['  \\\\ || //', ' {=(@ @)=}', ' {  VVVV  }', '  \\ ^^^^ /', '  /|/  \\|\\'], m: [{ n: 'Entangle', a: [['pst', 'weak', 2], ['add', 'wound', 2, 'disc']] }, { n: 'Crush', a: [['atk', 18]] }, { n: 'Grow', a: [['st', 'str', 2], ['blk', 12]] }, { n: 'Thrash', a: [['atk', 5, 3]] }, { n: 'Uproot', a: [['st', 'str', 1], ['heal', 15], ['blk', 10]] }], ai: { first: 0, cyc: [1, 2, 3, 0] }, react: { low: 4 } },
    // --- act II ---
    drownedSailor: { n: 'Drowned Sailor', hp: [48, 54], art: ['  _===_', ' ( x_x )', ' /|~~~|J'], m: [{ n: 'Hook', a: [['atk', 12]] }, { n: 'Brine', a: [['pst', 'frail', 2], ['atk', 6]] }], ai: { w: [3, 2] }, react: { dbf: 0 } },
    inkEel: { n: 'Ink Eel', hp: [40, 44], art: ['  __', ' (o )~~~~', '  ""~~~~~~'], m: [{ n: 'Lash', a: [['atk', 7, 2]] }, { n: 'Ink Cloud', a: [['pst', 'weak', 2], ['blk', 8]] }], ai: { w: [3, 2] }, hide: 'all' },
    shellCrab: { n: 'Shell Crab', hp: [56, 60], art: [' (\\_/)  ', ' {o_o}=', ' /^ ^\\'], m: [{ n: 'Shell', a: [['blk', 14]] }, { n: 'Pinch', a: [['atk', 15]] }], ai: { first: 1, cyc: [0, 1, 1] }, react: { low: 0 } },
    sirenWisp: { n: 'Siren Wisp', hp: [36, 40], art: ['   ~*~', '  (o o)', '  ~~v~~'], m: [{ n: 'Lull', a: [['add', 'dazed', 2, 'draw']] }, { n: 'Shriek', a: [['atk', 10], ['pst', 'vuln', 1]] }], ai: { first: 0, cyc: [1, 1, 0] }, hide: 'amount' },
    leechSwarm: { n: 'Leech Swarm', hp: [44, 48], art: [' ~s ~s', '~s ~s ~s', ' ~s ~s'], m: [{ n: 'Drain', a: [['atk', 9], ['heal', 9]] }, { n: 'Swarm', a: [['atk', 3, 4]] }], ai: { w: [2, 3] } },
    barnacleGolem: { n: 'Barnacle Golem', hp: [64, 70], art: ['  [o.o]', ' /[###]\\', '  || ||'], m: [{ n: 'Encrust', a: [['st', 'metal', 4]] }, { n: 'Pound', a: [['atk', 14]] }, { n: 'Slam', a: [['atk', 8], ['blk', 8]] }], ai: { first: 0, cyc: [1, 2] } },
    // act II elites
    abyssKnight: { n: 'Abyssal Knight', elite: true, hp: [128, 134], art: ['  /|^|\\', ' [ -o- ]', ' /|###|\\', '  |   |'], m: [{ n: 'Charge', a: [['atk', 22]] }, { n: 'Parry', a: [['blk', 20], ['st', 'thorns', 3]] }, { n: 'Rally', a: [['st', 'str', 3]] }], ai: { first: 2, cyc: [0, 1, 0, 2] }, react: { dbf: 0 } },
    brineWitch: { n: 'Brine Witch', elite: true, hp: [108, 114], art: ['   /\\', '  /__\\', ' (o_o)', ' /|~~|\\'], m: [{ n: 'Hex', a: [['pst', 'vuln', 2], ['pst', 'weak', 2]] }, { n: 'Boil', a: [['atk', 7, 3], ['add', 'burn', 1, 'disc']] }, { n: 'Brew', a: [['heal', 15], ['st', 'str', 2]] }], ai: { first: 0, cyc: [1, 2, 1, 0] } },
    coralHydra: { n: 'Coral Hydra', elite: true, hp: [136, 144], art: [' o_  _o_  _o', '  \\\\ || //', '   {####}', '   /    \\'], m: [{ n: 'Bite', a: [['atk', 10, 2]] }, { n: 'Regrow', a: [['st', 'regen', 6], ['blk', 10]] }, { n: 'Spit', a: [['pst', 'poison', 5], ['atk', 8]] }], ai: { first: 2, cyc: [0, 1, 0, 2] } },
    // act II boss
    tideWarden: { n: 'The Tide Warden', boss: true, hp: [240, 240], art: ['   ~~/^\\~~', '  ( [O O] )', ' ~~|=====|~~', '   |#####|', '  ~/~~~~~\\~'], m: [{ n: 'Undertow', a: [['pst', 'weak', 2], ['pst', 'frail', 2], ['blk', 15]] }, { n: 'Breaker', a: [['atk', 24]] }, { n: 'Surge', a: [['atk', 7, 4]] }, { n: 'High Tide', a: [['blk', 25], ['st', 'str', 3]] }, { n: 'Maelstrom', a: [['add', 'dazed', 3, 'draw'], ['st', 'metal', 6]] }], ai: { first: 0, cyc: [1, 2, 3, 0] }, react: { low: 4 } },
    // --- act III ---
    hollowSentinel: { n: 'Hollow Sentinel', hp: [80, 88], art: ['  [===]', ' [ (o) ]', '  [===]'], m: [{ n: 'Beam', a: [['atk', 18]] }, { n: 'Fortify', a: [['blk', 18], ['add', 'dazed', 1, 'disc']] }], ai: { first: 1, cyc: [0, 1] }, react: { dbf: 1 } },
    ashPriest: { n: 'Ash Priest', hp: [70, 76], art: ['   _+_', '  (o o)', ' /|ash|\\'], m: [{ n: 'Pyre', a: [['add', 'burn', 2, 'disc'], ['atk', 6]] }, { n: 'Smite', a: [['atk', 16]] }, { n: 'Bless', a: [['st', 'str', 3]] }], ai: { first: 0, cyc: [1, 2, 1, 0] }, react: { dbf: 2 } },
    mirrorShade: { n: 'Mirror Shade', hp: [60, 66], art: ['  .--.', ' |o  o|', " |'--'|", '  \\__/'], m: [{ n: 'Mimic', a: [['atk', 12], ['pst', 'vuln', 1]] }, { n: 'Shatter', a: [['atk', 5, 4]] }], ai: { w: [1, 1] }, hide: 'all' },
    graveColossus: { n: 'Grave Colossus', hp: [110, 120], art: ['  [O__O]', ' /|####|\\', ' ||####||', '  |_||_|'], m: [{ n: 'Quake', a: [['atk', 24]] }, { n: 'Rest', a: [['blk', 12], ['st', 'str', 3]] }], ai: { first: 1, cyc: [0, 1] }, react: { low: 0 } },
    venomDrake: { n: 'Venom Drake', hp: [90, 96], art: ['  /\\_/\\_', ' <(o>)  >~', '  \\/ \\/'], m: [{ n: 'Bile', a: [['pst', 'poison', 6]] }, { n: 'Claw', a: [['atk', 10, 2]] }], ai: { first: 0, cyc: [1, 1, 0] } },
    spiritMoth: { n: 'Spirit Moth', hp: [50, 54], art: [' \\\\ o //', '  =(_)=', ' // ^ \\\\'], m: [{ n: 'Dust', a: [['pst', 'weak', 2], ['pst', 'frail', 2]] }, { n: 'Flutter', a: [['atk', 7, 3]] }], ai: { first: 0, cyc: [1, 1, 0] } },
    // act III elites
    revenant: { n: 'Crowned Revenant', elite: true, hp: [190, 200], art: ['  _/V\\_', ' ( x x )', ' /|=+=|\\', '  /   \\'], m: [{ n: 'Decree', a: [['st', 'str', 4], ['blk', 15]] }, { n: 'Execute', a: [['atk', 28]] }, { n: 'Cleave', a: [['atk', 12, 2]] }], ai: { first: 0, cyc: [2, 1, 0] }, react: { low: 1 } },
    voidSigil: { n: 'Void Sigil', elite: true, hp: [170, 180], art: ['  .-*-.', ' *  @  *', "  '-*-'"], m: [{ n: 'Pulse', a: [['atk', 6, 5]] }, { n: 'Null', a: [['add', 'dazed', 3, 'draw'], ['blk', 12]] }, { n: 'Charge', a: [['blk', 30], ['st', 'str', 5]] }], ai: { first: 1, cyc: [0, 2, 0, 1] }, hide: 'amount' },
    gargoyle: { n: 'Obsidian Gargoyle', elite: true, hp: [180, 190], art: [' /\\(oo)/\\', ' \\ |##| /', '   /  \\'], m: [{ n: 'Petrify', a: [['pst', 'frail', 3], ['pst', 'vuln', 2]] }, { n: 'Rend', a: [['atk', 20]] }, { n: 'Stoneskin', a: [['st', 'metal', 6], ['blk', 10]] }], ai: { first: 2, cyc: [0, 1, 1] } },
    // act III boss
    hollowMonarch: { n: 'The Hollow Monarch', boss: true, hp: [360, 360], art: ['   _/\\/\\/\\_', '  ( ([o o]) )', '   \\  ==  /', '  /|######|\\', '   /|    |\\'], m: [{ n: 'Command', a: [['st', 'str', 3], ['blk', 20]] }, { n: 'Ruin', a: [['atk', 28]] }, { n: 'Scatter', a: [['atk', 7, 5]] }, { n: 'Despair', a: [['add', 'wound', 2, 'draw'], ['pst', 'weak', 3], ['pst', 'vuln', 3]] }, { n: 'Unmake', a: [['st', 'str', 5], ['heal', 30], ['add', 'burn', 3, 'disc']] }], ai: { first: 3, cyc: [1, 0, 2, 3] }, react: { low: 4, hideLow: 'amount' } }
  };
  var ENEMY_IDS = Object.keys(ENEMIES);
  var ENC = {
    1: {
      weak: [['mossRat', 'mossRat'], ['caveSlug'], ['bonePup', 'sporePuff'], ['rootCultist'], ['cutpurse', 'mossRat']],
      strong: [['rootCultist', 'mossRat'], ['thornBeetle', 'sporePuff'], ['bonePup', 'bonePup', 'mossRat'], ['caveSlug', 'cutpurse'], ['thornBeetle', 'mossRat'], ['sporePuff', 'sporePuff', 'cutpurse']],
      elite: [['ironbark'], ['lanternWraith'], ['chitinKnight']], boss: ['rootmaw']
    },
    2: {
      weak: [['inkEel'], ['drownedSailor'], ['sirenWisp', 'inkEel'], ['shellCrab']],
      strong: [['drownedSailor', 'sirenWisp'], ['leechSwarm', 'inkEel'], ['barnacleGolem'], ['shellCrab', 'sirenWisp'], ['leechSwarm', 'leechSwarm'], ['barnacleGolem', 'inkEel']],
      elite: [['abyssKnight'], ['brineWitch'], ['coralHydra']], boss: ['tideWarden']
    },
    3: {
      weak: [['mirrorShade'], ['hollowSentinel'], ['spiritMoth', 'spiritMoth']],
      strong: [['ashPriest', 'mirrorShade'], ['graveColossus'], ['venomDrake', 'spiritMoth'], ['hollowSentinel', 'ashPriest'], ['venomDrake', 'mirrorShade'], ['graveColossus', 'spiritMoth']],
      elite: [['revenant'], ['voidSigil'], ['gargoyle']], boss: ['hollowMonarch']
    }
  };

  // ================= relics =================
  // r: starter | common | uncommon | rare | shop | boss
  var RELICS = {
    emberHeart: { n: 'Ember Heart', g: '&', r: 'starter', d: 'At the end of each fight, heal 6 HP.' },
    whetstone: { n: 'Whetstone', g: '/', r: 'common', d: 'Start each fight with 1 Strength.' },
    oakWard: { n: 'Oak Ward', g: '#', r: 'common', d: 'Start each fight with 10 Block.' },
    lantern: { n: 'Lantern', g: 'i', r: 'common', d: 'Gain 1 extra Energy on your first turn.' },
    satchel: { n: 'Field Satchel', g: 'u', r: 'common', d: 'Draw 2 extra cards on your first turn.' },
    briarBand: { n: 'Briar Band', g: '@', r: 'common', d: 'Start each fight with 3 Thorns.' },
    markedMap: { n: 'Marked Map', g: 'X', r: 'common', d: 'Start each fight with 1 Vulnerable on ALL enemies.' },
    bloodVial: { n: 'Blood Vial', g: '!', r: 'common', d: 'At the start of each fight, heal 3 HP.' },
    heartyStew: { n: 'Hearty Stew', g: 'U', r: 'common', d: 'On pickup, raise your Max HP by 10.' },
    tallyStick: { n: 'Tally Stick', g: '|', r: 'common', d: 'Every 10th Attack you play deals double damage.' },
    gildedTooth: { n: 'Gilded Tooth', g: 'v', r: 'common', d: 'Gain 10 extra gold after every fight.' },
    warDrum: { n: 'War Drum', g: 'O', r: 'uncommon', d: 'Every time you play 3 Attacks in a turn, gain 1 Strength.' },
    ribbon: { n: "Dancer's Ribbon", g: '~', r: 'uncommon', d: 'Every time you play 3 Attacks in a turn, gain 1 Dexterity.' },
    mossyStone: { n: 'Mossy Stone', g: 'o', r: 'uncommon', d: 'Whenever you take unblocked attack damage, gain 3 Block.' },
    sundial: { n: 'Sundial', g: 'Y', r: 'uncommon', d: 'Every 3rd turn, gain 1 extra Energy.' },
    venomGland: { n: 'Venom Gland', g: '%', r: 'uncommon', d: 'Whenever you apply Poison, apply 1 more.' },
    emberPlate: { n: 'Ember Plate', g: '=', r: 'uncommon', d: 'If you end your turn without Block, gain 6 Block.' },
    journal: { n: 'Ink Journal', g: 'J', r: 'uncommon', d: 'Every 10th card you play draws a card.' },
    hotMeal: { n: 'Hot Meal', g: 'm', r: 'uncommon', d: 'Heal 15 HP whenever you enter a shop.' },
    pillow: { n: 'Down Pillow', g: 'c', r: 'uncommon', d: 'Resting heals 15 more HP.' },
    barkMantle: { n: 'Bark Mantle', g: 'H', r: 'uncommon', d: 'Start each fight with 4 Plating.' },
    phoenix: { n: 'Phoenix Feather', g: 'f', r: 'rare', d: 'The first time you would die, heal to 50% instead. (Once.)' },
    pipe: { n: 'Clay Pipe', g: 'p', r: 'rare', d: 'Rest sites may also remove a card from your deck.' },
    clover: { n: 'Lucky Clover', g: '*', r: 'rare', d: 'Card rewards offer one more card.' },
    goldenIdol: { n: 'Golden Idol', g: '$', r: 'rare', d: 'Gain 25% more gold from fights.' },
    toxinVial: { n: 'Toxin Vial', g: 'T', r: 'rare', d: 'Start each fight with 3 Poison on ALL enemies.' },
    merchantSeal: { n: 'Merchant Seal', g: 'S', r: 'shop', d: 'Everything in shops costs 25% less.' },
    brassToken: { n: 'Brass Token', g: 'b', r: 'shop', d: 'Removing a card at a shop always costs 50 gold.' },
    sunShard: { n: 'Sun Shard', g: '+', r: 'boss', d: '+1 Energy every turn. You can no longer heal at rest sites.' },
    moonShard: { n: 'Moon Shard', g: 'C', r: 'boss', d: '+1 Energy every turn. Each fight starts with 2 Dazed in your draw pile.' },
    starShard: { n: 'Star Shard', g: 'x', r: 'boss', d: '+1 Energy every turn. Card rewards offer one fewer card.' },
    bloodCrown: { n: 'Blood Crown', g: 'W', r: 'boss', d: '+1 Energy every turn. Lose 4 HP at the start of each fight.' },
    deepPockets: { n: 'Deep Pockets', g: 'D', r: 'boss', d: 'Draw 1 more card every turn.' },
    spyglass: { n: 'Spyglass', g: 'Q', r: 'uncommon', d: 'Reveals hidden enemy intents on the first turn of each fight, and every 3rd turn.' }
  };
  var RELIC_IDS = Object.keys(RELICS);
  function has(R, id) { return R.relics.indexOf(id) >= 0; }
  function energyMax(R) {
    var n = BASE_ENERGY;
    ['sunShard', 'moonShard', 'starShard', 'bloodCrown'].forEach(function (id) { if (has(R, id)) n++; });
    return n;
  }

  // ================= the run =================
  function newRun(seed, opts) {
    opts = opts || {};
    seed = seed >>> 0;
    var R = {
      v: VERSION, seed: seed, daily: opts.daily || '', blind: !!opts.blind && !opts.daily, started: opts.now || 0,
      rng: {}, act: 1, floor: 0, hp: START_HP, mhp: START_HP, gold: 99,
      deck: [], nk: 1, relics: ['emberHeart'], counters: { atk: 0, play: 0 }, phoenixUsed: false,
      maps: [], pos: -1, trail: [], phase: 'map', c: null, rew: null, shop: null, evt: null, pick: null, rest: null, treasure: null,
      rmCost: 75, lastEnc: '', actFights: 0, seenEv: [], relicPool: {},
      stats: { kills: 0, elites: 0, bosses: 0, dmg: 0, maxHit: 0, played: 0, gold: 0, turns: 0, fights: 0 },
      won: false, over: false, killedBy: ''
    };
    STREAMS.forEach(function (k, i) { R.rng[k] = mix(seed, i + 1); });
    var i;
    for (i = 0; i < 5; i++) addCard(R, 'strike');
    for (i = 0; i < 4; i++) addCard(R, 'guard');
    addCard(R, 'lunge');
    ['common', 'uncommon', 'rare', 'shop', 'boss'].forEach(function (r) {
      R.relicPool[r] = shuffle(R, 'loot', RELIC_IDS.filter(function (id) { return RELICS[id].r === r; }));
    });
    for (i = 1; i <= 3; i++) R.maps.push(genMap(R, i));
    return R;
  }
  function addCard(R, id, up) {
    var c = { id: id, u: up && CARDS[id].u ? 1 : 0, k: R.nk++ };
    R.deck.push(c);
    return c;
  }
  function floorNo(R) { return R.floor; }

  // ---- the map: PATHS walks up a COLS x ROWS grid that never cross; then types ----
  var NODE = {
    fight: { g: 'x', n: 'Fight' }, elite: { g: '!', n: 'Elite' }, event: { g: '?', n: 'Event' },
    shop: { g: '$', n: 'Shop' }, rest: { g: '+', n: 'Rest site' }, treasure: { g: '#', n: 'Treasure' }, boss: { g: '@', n: 'Boss' }
  };
  function genMap(R, act) {
    var W = COLS, H = ROWS, on = {}, edge = {}, p, r, c, nc, starts = [];
    function key(r, c) { return r * W + c; }
    for (p = 0; p < PATHS; p++) {
      c = rint(R, 'map', W);
      if (p === 1) { var guard = 0; while (c === starts[0] && guard++ < 20) c = rint(R, 'map', W); }
      starts.push(c);
      on[key(0, c)] = 1;
      for (r = 0; r < H - 1; r++) {
        var opts = [c - 1, c, c + 1].filter(function (x) { return x >= 0 && x < W; });
        nc = opts[rint(R, 'map', opts.length)];
        // never cross an existing edge: (r,c)->(r+1,c+1) crosses (r,c+1)->(r+1,c)
        if (nc === c + 1 && edge[key(r, c + 1) + '>' + key(r + 1, c)]) nc = c;
        if (nc === c - 1 && edge[key(r, c - 1) + '>' + key(r + 1, c)]) nc = c;
        edge[key(r, c) + '>' + key(r + 1, nc)] = 1;
        on[key(r + 1, nc)] = 1;
        c = nc;
      }
    }
    var nodes = [], idx = {};
    for (r = 0; r < H; r++) for (c = 0; c < W; c++) if (on[key(r, c)]) { idx[key(r, c)] = nodes.length; nodes.push({ r: r, c: c, t: '', nx: [], pv: [] }); }
    Object.keys(edge).forEach(function (e) {
      var ab = e.split('>'), a = idx[ab[0]], b = idx[ab[1]];
      if (nodes[a].nx.indexOf(b) < 0) { nodes[a].nx.push(b); nodes[b].pv.push(a); }
    });
    nodes.forEach(function (n) { n.nx.sort(function (x, y) { return nodes[x].c - nodes[y].c; }); });
    var mid = Math.floor(H / 2);
    nodes.forEach(function (n) {
      if (n.r === 0) { n.t = 'fight'; return; }
      if (n.r === H - 1) { n.t = 'rest'; return; }
      if (n.r === mid) { n.t = 'treasure'; return; }
      for (var tries = 0; tries < 12; tries++) {
        var t = rollNode(R, n.r, H);
        var clash = (t === 'elite' || t === 'shop' || t === 'rest') && n.pv.some(function (q) { return nodes[q].t === t; });
        if (t === 'rest' && n.r === H - 2) clash = true;
        if (!clash) { n.t = t; break; }
      }
      if (!n.t) n.t = 'fight';
    });
    var boss = ENC[act].boss[0];
    nodes.forEach(function (n) { delete n.pv; });
    return { act: act, nodes: nodes, boss: boss };
  }
  function rollNode(R, r) {
    var w = [['fight', 45], ['event', 22], ['elite', r >= 4 ? 11 : 0], ['shop', r >= 2 ? 7 : 0], ['rest', r >= 4 ? 12 : 0]];
    var tot = 0, i;
    for (i = 0; i < w.length; i++) tot += w[i][1];
    var x = rnd(R, 'map') * tot;
    for (i = 0; i < w.length; i++) { if (x < w[i][1]) return w[i][0]; x -= w[i][1]; }
    return 'fight';
  }
  function curMap(R) { return R.maps[R.act - 1]; }
  // node indices you may move to next; [-2] = the boss
  function nextNodes(R) {
    var M = curMap(R);
    if (R.pos === -2) return [];
    if (R.pos === -1) return M.nodes.map(function (n, i) { return n.r === 0 ? i : -1; }).filter(function (i) { return i >= 0; });
    var n = M.nodes[R.pos];
    if (n.r === ROWS - 1) return [-2];
    return n.nx.slice();
  }
  function chooseNode(R, i) {
    if (R.phase !== 'map' || R.over) return false;
    if (nextNodes(R).indexOf(i) < 0) return false;
    R.pos = i;
    R.trail.push(i);
    R.floor++;
    var t = i === -2 ? 'boss' : curMap(R).nodes[i].t;
    R.rew = null; R.shop = null; R.evt = null; R.pick = null; R.rest = null; R.treasure = null;
    if (t === 'fight') startFight(R, 'fight');
    else if (t === 'elite') startFight(R, 'elite');
    else if (t === 'boss') startFight(R, 'boss');
    else if (t === 'event') startEvent(R);
    else if (t === 'shop') startShop(R);
    else if (t === 'rest') { R.phase = 'rest'; R.rest = { done: false, did: '' }; }
    else if (t === 'treasure') { R.phase = 'treasure'; R.treasure = { relic: takeRelic(R, rollRelicRarity(R)), gold: rrange(R, 'loot', 20, 40), taken: false }; }
    return true;
  }
  function nodeType(R, i) { return i === -2 ? 'boss' : curMap(R).nodes[i].t; }

  // ================= combat =================
  function pickEncounter(R, kind) {
    var E = ENC[R.act], list;
    if (kind === 'boss') return [E.boss[0]];
    if (kind === 'elite') list = E.elite;
    else list = (R.actFights || 0) < (R.act === 1 ? 3 : 2) ? E.weak : E.strong;
    var enc = null;
    for (var t = 0; t < 8; t++) { enc = pick(R, 'cmb', list); if (enc.join() !== R.lastEnc) break; }
    R.lastEnc = enc.join();
    return enc.slice();
  }
  function mkEnemy(R, id) {
    var d = ENEMIES[id], hp = rrange(R, 'cmb', d.hp[0], d.hp[1]), act = d.boss || d.elite ? R.act : actOf(id);
    hp = Math.max(1, Math.round(hp * (RULES.ehp[act - 1] || 1)));
    // hide: what of its intent is hidden now (a boss phase can change it); halfUsed: its low-HP reaction is spent
    return { id: id, hp: hp, mhp: hp, blk: 0, st: {}, mv: -1, hist: [], t: 0, cy: 0, dead: false, halfUsed: false, hide: d.hide || '', rt: 0, acted: 0, held: false, chg: 0 };
  }
  var ACT_OF = {};
  function actOf(id) {
    if (!ACT_OF.done) { [1, 2, 3].forEach(function (a) { ['weak', 'strong', 'elite'].forEach(function (k) { ENC[a][k].forEach(function (enc) { enc.forEach(function (x) { if (!ACT_OF[x]) ACT_OF[x] = a; }); }); }); ACT_OF[ENC[a].boss[0]] = a; }); ACT_OF.done = 1; }
    return ACT_OF[id] || 1;
  }
  function startFight(R, kind, enc) {
    if (R.actFights == null) R.actFights = 0;
    enc = enc || pickEncounter(R, kind);
    R.actFights++;
    R.stats.fights++;
    var C = {
      kind: kind, e: enc.map(function (id) { return mkEnemy(R, id); }), p: { hp: R.hp, mhp: R.mhp, blk: 0, st: {} },
      hand: [], draw: [], disc: [], exh: [], en: 0, turn: 0, phase: 'player', ei: 0, played: 0, atks: 0, log: [], drawn: 0,
      scout: 0, full: 0   // scout: the turn all hidden intents were revealed; full: the turn a draw hit the hand cap
    };
    R.c = C;
    R.phase = 'combat';
    C.draw = shuffle(R, 'shuf', R.deck.map(function (c) { return { id: c.id, u: c.u, k: c.k }; }));
    if (has(R, 'moonShard')) { for (var i = 0; i < 2; i++) C.draw.splice(rint(R, 'shuf', C.draw.length + 1), 0, { id: 'dazed', u: 0, k: R.nk++ }); }
    C.e.forEach(function (e) { chooseIntent(R, e); });
    // relics at the start of the fight
    if (has(R, 'whetstone')) addSt(C.p, 'str', 1);
    if (has(R, 'briarBand')) addSt(C.p, 'thorns', 3);
    if (has(R, 'barkMantle')) addSt(C.p, 'metal', 4);
    if (has(R, 'oakWard')) C.p.blk += 10;
    if (has(R, 'bloodVial')) healP(R, 3);
    if (has(R, 'bloodCrown')) { loseHp(R, 4, 'Blood Crown'); if (R.over) return C; }
    C.e.forEach(function (e) {
      if (has(R, 'markedMap')) addSt(e, 'vuln', 1);
      if (has(R, 'toxinVial')) addSt(e, 'poison', 3);
    });
    startTurn(R);
    return C;
  }
  function addSt(u, k, n) {
    if (!n) return;
    u.st[k] = (u.st[k] || 0) + n;
    if (!u.st[k]) delete u.st[k];
  }
  function log(R, o) { if (R.c) { R.c.log.push(o); if (R.c.log.length > 200) R.c.log.splice(0, R.c.log.length - 200); } }
  function alive(C) { return C.e.filter(function (e) { return !e.dead; }); }
  function startTurn(R) {
    var C = R.c;
    C.turn++;
    R.stats.turns++;
    C.phase = 'player';
    C.played = 0; C.atks = 0;
    var P = C.p;
    if (!P.st.keepBlock && C.turn > 1) P.blk = 0;
    if (P.st.nextBlk) { P.blk += P.st.nextBlk; delete P.st.nextBlk; }
    if (P.st.poison) {
      loseHp(R, P.st.poison, 'Poison');
      addSt(P, 'poison', -1);
      if (R.over || R.phase !== 'combat') return;
    }
    C.en = energyMax(R) + (P.st.energyP || 0);
    if (C.turn === 1 && has(R, 'lantern')) C.en++;
    if (has(R, 'sundial') && C.turn % 3 === 0) C.en++;
    if (has(R, 'spyglass') && (C.turn === 1 || C.turn % 3 === 0)) C.scout = C.turn;
    draw(R, drawCount(R));
    if (P.st.poisonAura) alive(C).forEach(function (e) { applySt(R, e, 'poison', P.st.poisonAura); });
  }
  // how many cards the start of this turn draws (held cards are already in hand)
  function drawCount(R) {
    var C = R.c, P = C.p, bonus = (P.st.drawP || 0) + (has(R, 'deepPockets') ? 1 : 0);
    if (C.turn <= 1) return RULES.first + bonus + (has(R, 'satchel') ? 2 : 0);
    return Math.max(RULES.min, RULES.to - C.hand.length) + bonus;
  }
  // draw n cards; a full hand stops the draw (the rest stay in the draw pile). Returns how many were drawn.
  function draw(R, n) {
    var C = R.c, got = 0;
    for (var i = 0; i < n; i++) {
      if (C.hand.length >= MAX_HAND) { C.full = C.turn; log(R, { k: 'full', n: n - i }); break; }
      if (!C.draw.length) {
        if (!C.disc.length) break;
        C.draw = shuffle(R, 'shuf', C.disc);
        C.disc = [];
        log(R, { k: 'shuffle' });
      }
      var c = C.draw.pop();
      delete c.kept;
      C.hand.push(c);
      got++;
    }
    return got;
  }
  // attack damage from src onto tgt (before block)
  function atkDmg(base, src, tgt) {
    var d = base + (src.st.str || 0);
    if (src.st.weak) d *= 0.75;
    if (tgt && tgt.st.vuln) d *= 1.5;
    return Math.max(0, Math.floor(d));
  }
  function blockGain(R, n) {
    var P = R.c.p, b = n + (P.st.dex || 0);
    if (P.st.frail) b *= 0.75;
    return Math.max(0, Math.floor(b));
  }
  function isP(R, u) { return R.c && u === R.c.p; }
  function healP(R, n) {
    if (R.c) { var P = R.c.p, h = Math.min(n, P.mhp - P.hp); P.hp += h; return h; }
    var h2 = Math.min(n, R.mhp - R.hp); R.hp += h2; return h2;
  }
  function loseHp(R, n, why) {
    var C = R.c;
    if (!C) { R.hp = Math.max(0, R.hp - n); if (R.hp <= 0) dieOut(R, why); return; }
    C.p.hp -= n;
    log(R, { k: 'hp', t: 'p', n: n });
    checkDeath(R, why);
  }
  function checkDeath(R, why) {
    var C = R.c;
    if (!C || C.p.hp > 0) return;
    if (has(R, 'phoenix') && !R.phoenixUsed) {
      R.phoenixUsed = true;
      C.p.hp = Math.max(1, Math.floor(C.p.mhp / 2));
      log(R, { k: 'phoenix' });
      return;
    }
    C.p.hp = 0;
    R.hp = 0;
    C.phase = 'lost';
    dieOut(R, why || 'a fight');
  }
  function dieOut(R, why) {
    R.over = true; R.won = false; R.phase = 'over'; R.killedBy = why || '';
  }
  // deal damage to a unit; atk = from an attack (thorns, envenom, mossy stone)
  function hit(R, tgt, n, src, atk, why) {
    var C = R.c;
    if (!C || tgt.dead || n < 0) return 0;
    var b = Math.min(tgt.blk, n), unb = n - b, P = isP(R, tgt);
    tgt.blk -= b;
    tgt.hp -= unb;
    if (!P) { R.stats.dmg += unb; if (n > R.stats.maxHit) R.stats.maxHit = n; }
    log(R, { k: 'dmg', t: P ? 'p' : C.e.indexOf(tgt), n: n, b: b, u: unb });
    if (atk && src && !src.dead && src !== tgt) {
      if (tgt.st.thorns) {
        var th = tgt.st.thorns, sb = Math.min(src.blk, th);
        src.blk -= sb; src.hp -= th - sb;
        log(R, { k: 'dmg', t: isP(R, src) ? 'p' : C.e.indexOf(src), n: th, b: sb, u: th - sb, thorns: true });
        if (isP(R, src)) { if (src.hp <= 0) checkDeath(R, ENEMIES[tgt.id].n + '\u2019s thorns'); }
        else if (src.hp <= 0) killE(R, src);
        else if (th > sb) react(R, src, 'low');
      }
      if (!P && unb > 0 && C.p.st.envenom) applySt(R, tgt, 'poison', C.p.st.envenom);
      if (P && unb > 0 && has(R, 'mossyStone')) C.p.blk += 3;
    }
    if (P) { if (tgt.hp <= 0) checkDeath(R, why || (src && !isP(R, src) ? ENEMIES[src.id].n : 'a fight')); }
    else if (tgt.hp <= 0) killE(R, tgt);
    else if (unb > 0) react(R, tgt, 'low');
    return unb;
  }
  function killE(R, e) {
    if (e.dead) return;
    e.dead = true; e.hp = 0; e.blk = 0; e.st = {};
    R.stats.kills++;
    log(R, { k: 'kill', t: R.c.e.indexOf(e) });
  }
  function applySt(R, u, k, n) {
    if (!u || u.dead || !n) return;
    if (k === 'poison' && n > 0 && !isP(R, u) && has(R, 'venomGland')) n += 1;
    addSt(u, k, n);
    log(R, { k: 'st', t: isP(R, u) ? 'p' : R.c.e.indexOf(u), s: k, n: n });
    if (n > 0 && (k === 'weak' || k === 'vuln') && !isP(R, u)) react(R, u, 'dbf');
  }

  // ---- intents: hidden ones, and enemies that change their plan mid-turn ----
  // what of an enemy's intent you can't see right now: '' | 'amount' | 'all'
  function hideLevel(R, e) {
    var C = R.c;
    if (!C || !e) return '';
    var h = R.blind ? 'all' : e.hide != null ? e.hide : ENEMIES[e.id].hide || '';
    if (!h) return '';
    if (C.scout === C.turn || C.p.st.foresight || e.seen === C.turn) return '';
    return h;
  }
  function react(R, e, why) {
    var C = R.c, rc = ENEMIES[e.id].react;
    if (!rc || !C || e.dead || R.phase !== 'combat') return;
    if (why === 'low') {
      if (rc.low == null || e.halfUsed || e.hp >= e.mhp * (rc.at || 0.5)) return;
      e.halfUsed = true;
      if (rc.hideLow) e.hide = rc.hideLow;
      switchMove(R, e, rc.low, why);
    } else if (why === 'dbf') {
      if (rc.dbf == null || e.rt === C.turn || e.mv === rc.dbf) return;
      e.rt = C.turn;
      switchMove(R, e, rc.dbf, why);
    }
  }
  function switchMove(R, e, m, why) {
    var C = R.c;
    if (e.mv === m && !(C.phase === 'enemy' && e.acted === C.turn)) return;
    e.mv = m;
    if (e.hist.length) e.hist[e.hist.length - 1] = m; else e.hist.push(m);
    // it already acted this round: keep the new plan for its next turn
    if (C.phase === 'enemy' && e.acted === C.turn) e.held = true;
    e.chg = C.turn;
    log(R, { k: 'intent', t: C.e.indexOf(e), why: why });
  }
  function gainBlk(R, n, fromCard) {
    var C = R.c, b = fromCard ? blockGain(R, n) : n;
    C.p.blk += b;
    log(R, { k: 'blk', t: 'p', n: b });
    if (fromCard && b > 0 && C.p.st.spikes) {
      var al = alive(C);
      if (al.length) hit(R, al[rint(R, 'cmb', al.length)], C.p.st.spikes, C.p, false);
    }
  }

  // why a card can't be played now ('' = it can)
  function whyNot(R, card) {
    var C = R.c;
    if (!C || C.phase !== 'player') return 'Not your turn';
    var d = cdef(card);
    if (!playable(d)) return d.t === 'crs' ? 'Curses can\u2019t be played' : 'Unplayable';
    if (d.c > C.en) return 'Not enough energy';
    return '';
  }
  function playCard(R, hi, ti) {
    var C = R.c;
    if (!C || R.phase !== 'combat' || C.phase !== 'player') return 'Not your turn';
    var card = C.hand[hi];
    if (!card) return 'No such card';
    var why = whyNot(R, card);
    if (why) return why;
    var d = cdef(card), al = alive(C);
    if (!al.length) return 'No enemies';
    var tgt = null;
    if (d.tg === 'e') {
      tgt = C.e[ti];
      if (!tgt || tgt.dead) tgt = al[0];
    }
    var X = 0;
    if (d.c === -1) { X = C.en; C.en = 0; } else C.en -= d.c;
    C.hand.splice(hi, 1);
    C.played++;
    R.stats.played++;
    R.counters.play++;
    var dbl = false;
    if (d.t === 'atk') {
      C.atks++;
      R.counters.atk++;
      if (has(R, 'tallyStick') && R.counters.atk % 10 === 0) dbl = true;
    }
    log(R, { k: 'play', id: card.id, u: card.u, t: tgt ? C.e.indexOf(tgt) : -1 });
    var ctx = { card: card, tgt: tgt, X: X, dbl: dbl };
    for (var i = 0; i < d.a.length; i++) {
      if (R.phase !== 'combat' || C.phase !== 'player') break;
      act(R, d.a[i], ctx);
    }
    if (d.t !== 'pow') { if (d.ex) C.exh.push(card); else C.disc.push(card); }
    if (R.phase !== 'combat' || C.phase !== 'player') { finishIfWon(R); return ''; }
    // after-play triggers
    if (d.t === 'atk' && C.p.st.fervor) gainBlk(R, C.p.st.fervor, false);
    if (d.t === 'skl') alive(C).forEach(function (e) { if (e.st.enrage) addSt(e, 'str', e.st.enrage); });
    if (d.t === 'atk' && C.atks % 3 === 0) {
      if (has(R, 'warDrum')) applySt(R, C.p, 'str', 1);
      if (has(R, 'ribbon')) applySt(R, C.p, 'dex', 1);
    }
    if (has(R, 'journal') && R.counters.play % 10 === 0) draw(R, 1);
    finishIfWon(R);
    return '';
  }
  function act(R, a, ctx) {
    var C = R.c, P = C.p, k = a[0], tgt = ctx.tgt, i, n, al, hits;
    function swing(base, t, mul) {
      if (!t || t.dead) return 0;
      var dmg = atkDmg(base, P, t) * (mul || 1);
      if (ctx.dbl) dmg *= 2;
      return hit(R, t, dmg, P, true);
    }
    switch (k) {
      case 'dmg':
        hits = a[2] === 'X' ? ctx.X : a[2] || 1;
        for (i = 0; i < hits; i++) { if (tgt.dead) break; swing(a[1], tgt); }
        break;
      case 'dmgAll':
        hits = a[2] === 'X' ? ctx.X : a[2] || 1;
        for (i = 0; i < hits; i++) alive(C).forEach(function (e) { swing(a[1], e); });
        break;
      case 'dmgRand':
        for (i = 0; i < a[2]; i++) { al = alive(C); if (!al.length) break; swing(a[1], al[rint(R, 'cmb', al.length)]); }
        break;
      case 'dmgVuln': swing(a[1], tgt, tgt.st.vuln ? 2 : 1); break;
      case 'ifVuln': if (tgt && !tgt.dead && tgt.st.vuln) { C.en++; draw(R, 1); } break;
      case 'strMul':
        if (!tgt.dead) {
          var dm = a[1] + (P.st.str || 0) * a[2];
          if (P.st.weak) dm *= 0.75;
          if (tgt.st.vuln) dm *= 1.5;
          dm = Math.max(0, Math.floor(dm)) * (ctx.dbl ? 2 : 1);
          hit(R, tgt, dm, P, true);
        }
        break;
      case 'grow':
        swing(a[1] + (ctx.card.g || 0), tgt);
        ctx.card.g = (ctx.card.g || 0) + a[2];
        break;
      case 'bodySlam': swing(P.blk, tgt); break;
      case 'drain': n = swing(a[1], tgt); healP(R, n); if (n) log(R, { k: 'heal', t: 'p', n: n }); break;
      case 'drainAll':
        n = 0;
        alive(C).forEach(function (e) { n += swing(a[1], e); });
        healP(R, n); if (n) log(R, { k: 'heal', t: 'p', n: n });
        break;
      case 'devour':
        if (!tgt.dead) {
          swing(a[1], tgt);
          if (tgt.dead) { P.mhp += a[2]; P.hp += a[2]; R.mhp += a[2]; log(R, { k: 'heal', t: 'p', n: a[2] }); }
        }
        break;
      case 'rupture':
        if (!tgt.dead) hit(R, tgt, (tgt.st.poison || 0) * a[1], P, false);
        break;
      case 'catalyst':
        if (!tgt.dead && tgt.st.poison) { n = tgt.st.poison * (a[1] - 1); addSt(tgt, 'poison', n); log(R, { k: 'st', t: C.e.indexOf(tgt), s: 'poison', n: n }); }
        break;
      case 'blk': gainBlk(R, a[1], true); break;
      case 'dblBlk': if (P.blk) gainBlk(R, P.blk, false); break;
      case 'st':
        if (a[1] === 'str' && a[3] === 'turn') { applySt(R, tgt, 'str', a[2]); addSt(tgt, 'turnStr', -a[2]); }
        else applySt(R, tgt, a[1], a[2]);
        break;
      case 'stAll': alive(C).forEach(function (e) { applySt(R, e, a[1], a[2]); }); break;
      case 'me':
        if (a[1] === 'tmpStr') { applySt(R, P, 'str', a[2]); addSt(P, 'tmpStr', a[2]); }
        else applySt(R, P, a[1], a[2]);
        break;
      case 'draw': draw(R, a[1]); break;
      case 'energy': C.en += a[1]; break;
      case 'heal': n = healP(R, a[1]); log(R, { k: 'heal', t: 'p', n: n }); break;
      case 'hpLoss': loseHp(R, a[1], 'your own blade'); break;
      case 'add':
        for (i = 0; i < a[2]; i++) {
          var nc = { id: a[1], u: ctx.card && ctx.card.u && a[1] === 'spark' ? 1 : 0, k: R.nk++ };
          if (a[3] === 'hand' && C.hand.length < MAX_HAND) C.hand.push(nc);
          else if (a[3] === 'draw') C.draw.splice(rint(R, 'shuf', C.draw.length + 1), 0, nc);
          else C.disc.push(nc);
        }
        break;
      case 'exRand':
        if (C.hand.length) { var x = rint(R, 'cmb', C.hand.length); C.exh.push(C.hand.splice(x, 1)[0]); log(R, { k: 'exhaust' }); }
        break;
      case 'secondWind':
        for (i = C.hand.length - 1; i >= 0; i--) {
          if (cdef(C.hand[i]).t !== 'atk') { C.exh.push(C.hand.splice(i, 1)[0]); gainBlk(R, a[1], true); }
        }
        break;
      case 'dblStr': if (P.st.str > 0) applySt(R, P, 'str', P.st.str); break;
      case 'upHand': C.hand.forEach(function (c) { if (canUpgrade(c)) c.u = 1; }); break;
      case 'scout': C.scout = C.turn; log(R, { k: 'scout' }); break;
      case 'bide': gainBlk(R, a[1] * C.hand.length, true); break;
      case 'counter':
        if (tgt && !tgt.dead) {
          tgt.seen = C.turn;
          var ti = realIntent(R, tgt);
          if (ti && ti.atk) gainBlk(R, Math.min(a[1], ti.dmg * ti.hits), false);
          else draw(R, 2);
        }
        break;
    }
  }
  function finishIfWon(R) {
    var C = R.c;
    if (!C || R.phase !== 'combat') return false;
    if (C.phase === 'player' || C.phase === 'enemy') {
      if (!alive(C).length) { C.phase = 'won'; winFight(R); return true; }
    }
    return false;
  }
  // ---- end of your turn, then each enemy acts (one step at a time so the UI can show it) ----
  function endTurn(R) {
    var C = R.c;
    if (!C || R.phase !== 'combat' || C.phase !== 'player') return false;
    var P = C.p, i;
    // cards left in hand
    var hand = C.hand.slice();
    for (i = 0; i < hand.length; i++) {
      var e = cdef(hand[i]).end;
      if (!e) continue;
      if (e[0] === 'burn') hit(R, P, e[1], null, false, 'a Burn');
      else if (e[0] === 'regret') loseHp(R, C.hand.length, 'Regret');
      else if (e[0] === 'doubt') applySt(R, P, 'weak', 1);
      if (R.phase !== 'combat') return true;
    }
    if (P.st.metal) gainBlk(R, P.st.metal, false);
    if (has(R, 'emberPlate') && P.blk === 0) gainBlk(R, 6, false);
    if (P.st.flameAura) alive(C).forEach(function (en) { hit(R, en, P.st.flameAura, P, false); });
    if (P.st.ritual) applySt(R, P, 'str', P.st.ritual);
    if (P.st.tmpStr) { addSt(P, 'str', -P.st.tmpStr); delete P.st.tmpStr; }
    delete P.st.fervor;
    if (P.st.regen) { healP(R, P.st.regen); addSt(P, 'regen', -1); }
    decay(P);
    // you keep the cards you didn't play; Ethereal cards exhaust, statuses and curses are discarded
    var keep = [];
    for (i = 0; i < C.hand.length; i++) {
      var c = C.hand[i], d = cdef(c);
      if (d.eth) C.exh.push(c);
      else if (!playable(d) || d.t === 'sts' || d.t === 'crs') C.disc.push(c);
      else { c.kept = C.turn + 1; keep.push(c); }
    }
    C.hand = keep;
    if (finishIfWon(R)) return true;
    C.phase = 'enemy';
    C.ei = 0;
    // enemies shed their block as their turn begins
    alive(C).forEach(function (en) { en.blk = 0; });
    return true;
  }
  function decay(u) {
    ['vuln', 'weak', 'frail'].forEach(function (k) { if (u.st[k]) addSt(u, k, -1); });
  }
  // one enemy acts; returns false when the enemy phase is over (then the next turn has begun)
  function enemyStep(R) {
    var C = R.c;
    if (!C || R.phase !== 'combat' || C.phase !== 'enemy') return false;
    while (C.ei < C.e.length && C.e[C.ei].dead) C.ei++;
    if (C.ei >= C.e.length) { endRound(R); return false; }
    var e = C.e[C.ei++];
    if (e.st.poison) {
      hit(R, e, e.st.poison, null, false);
      if (!e.dead) addSt(e, 'poison', -1);
      if (finishIfWon(R)) return false;
    }
    if (!e.dead) {
      enemyAct(R, e);
      if (R.phase !== 'combat') return false;
      if (!e.dead) {
        if (e.st.ritual && e.t > 1) addSt(e, 'str', e.st.ritual);
        if (e.st.metal) e.blk += e.st.metal;
        if (e.st.regen) { e.hp = Math.min(e.mhp, e.hp + e.st.regen); addSt(e, 'regen', -1); }
        if (e.st.turnStr) { addSt(e, 'str', -e.st.turnStr); delete e.st.turnStr; }
        decay(e);
      }
      if (finishIfWon(R)) return false;
    }
    return true;
  }
  function enemyAct(R, e) {
    var C = R.c, d = ENEMIES[e.id], mv = d.m[e.mv], P = C.p;
    e.t++;
    e.acted = C.turn; e.held = false;
    log(R, { k: 'move', t: C.e.indexOf(e), n: mv.n });
    for (var i = 0; i < mv.a.length; i++) {
      var a = mv.a[i];
      if (R.phase !== 'combat' || e.dead) return;
      switch (a[0]) {
        case 'atk':
          for (var h = 0; h < (a[2] || 1); h++) { if (R.phase !== 'combat' || e.dead) return; hit(R, P, atkDmg(a[1], e, P), e, true); }
          break;
        case 'blk': e.blk += a[1]; log(R, { k: 'blk', t: C.e.indexOf(e), n: a[1] }); break;
        case 'blkAll': alive(C).forEach(function (x) { x.blk += a[1]; }); break;
        case 'st': applySt(R, e, a[1], a[2]); break;
        case 'pst': applySt(R, P, a[1], a[2]); break;
        case 'heal': e.hp = Math.min(e.mhp, e.hp + a[1]); log(R, { k: 'heal', t: C.e.indexOf(e), n: a[1] }); break;
        case 'add':
          for (var j = 0; j < a[2]; j++) {
            var nc = { id: a[1], u: 0, k: R.nk++ };
            if (a[3] === 'draw') C.draw.splice(rint(R, 'shuf', C.draw.length + 1), 0, nc); else C.disc.push(nc);
          }
          log(R, { k: 'add', id: a[1], n: a[2] });
          break;
      }
    }
  }
  function endRound(R) {
    var C = R.c;
    alive(C).forEach(function (e) { chooseIntent(R, e); });
    startTurn(R);
  }
  function chooseIntent(R, e) {
    var d = ENEMIES[e.id], ai = d.ai, rc = d.react, m;
    if (e.held) { e.held = false; return; }   // it changed its plan after acting: that is its next move
    if (rc && rc.low != null && !e.halfUsed && e.hp < e.mhp * (rc.at || 0.5) && e.hist.length) { e.halfUsed = true; if (rc.hideLow) e.hide = rc.hideLow; m = rc.low; }
    else if (!e.hist.length && ai.first != null) m = ai.first;
    else if (ai.cyc) { m = ai.cyc[(e.cy || 0) % ai.cyc.length]; e.cy = (e.cy || 0) + 1;
    } else {
      var w = ai.w.slice(), L = e.hist.length;
      if (L >= 2 && e.hist[L - 1] === e.hist[L - 2]) w[e.hist[L - 1]] = 0;
      var tot = 0, i;
      for (i = 0; i < w.length; i++) tot += w[i];
      var x = rnd(R, 'ai') * tot;
      for (m = 0; m < w.length - 1; m++) { if (x < w[m]) break; x -= w[m]; }
      if (!w[m]) for (m = 0; m < w.length && !w[m]; m++);
    }
    e.mv = m;
    e.hist.push(m);
    if (e.hist.length > 12) e.hist.splice(0, e.hist.length - 12);
  }
  // what an enemy is about to do, for display: hidden parts never leave the engine
  // (hide 'all': only "?"; 'amount': the kinds of action, dmg/hits null). chg: it just changed its plan.
  function intentOf(R, e) {
    var o = realIntent(R, e), h;
    if (!o) return null;
    h = hideLevel(R, e);
    o.hide = h;
    o.chg = e.chg === R.c.turn;
    if (h === 'all') return { n: '?', atk: false, dmg: null, hits: null, def: false, buf: false, dbf: false, heal: false, add: false, hide: h, chg: o.chg };
    if (h === 'amount') { o.n = '?'; o.dmg = o.atk ? null : 0; o.hits = o.atk ? null : 0; }
    return o;
  }
  // the real plan (the engine and its tests only)
  function realIntent(R, e) {
    if (!R.c || e.dead || e.mv < 0) return null;
    var mv = ENEMIES[e.id].m[e.mv], o = { n: mv.n, atk: false, dmg: 0, hits: 0, def: false, buf: false, dbf: false, heal: false, add: false, hide: '' };
    mv.a.forEach(function (a) {
      if (a[0] === 'atk') { o.atk = true; o.dmg = atkDmg(a[1], e, R.c.p); o.hits = a[2] || 1; }
      else if (a[0] === 'blk' || a[0] === 'blkAll') o.def = true;
      else if (a[0] === 'st') o.buf = true;
      else if (a[0] === 'pst') o.dbf = true;
      else if (a[0] === 'heal') o.heal = true;
      else if (a[0] === 'add') { o.add = true; o.dbf = true; }
    });
    return o;
  }
  // the attack damage you can see coming (hidden attacks are not counted: see incomingInfo)
  function incoming(R) { return incomingInfo(R).dmg; }
  // { dmg: visible incoming damage, unknown: how many enemies might attack for an unknown amount }
  function incomingInfo(R) {
    var t = 0, u = 0;
    if (R.c) alive(R.c).forEach(function (e) {
      var o = intentOf(R, e);
      if (!o) return;
      if (o.hide === 'all' || (o.atk && o.dmg == null)) u++;
      else if (o.atk) t += o.dmg * o.hits;
    });
    return { dmg: t, unknown: u };
  }

  // ---- after the fight ----
  function winFight(R) {
    var C = R.c;
    R.hp = Math.max(1, C.p.hp);
    R.mhp = C.p.mhp;
    if (has(R, 'emberHeart')) R.hp = Math.min(R.mhp, R.hp + 6);
    var kind = C.kind;
    if (kind === 'elite') R.stats.elites++;
    if (kind === 'boss') R.stats.bosses++;
    var gold = kind === 'boss' ? rrange(R, 'loot', 95, 105) : kind === 'elite' ? rrange(R, 'loot', 25, 35) : rrange(R, 'loot', 10, 20);
    if (has(R, 'goldenIdol')) gold = Math.round(gold * 1.25);
    if (has(R, 'gildedTooth')) gold += 10;
    gold += C.bonus || 0;
    R.gold += gold;
    R.stats.gold += gold;
    R.rew = { kind: kind, gold: gold, cards: cardChoices(R, kind), cardDone: false, relic: kind === 'elite' ? takeRelic(R, rollRelicRarity(R)) : '', relicDone: false, boss: null, bossDone: false };
    if (kind === 'boss') {
      R.rew.boss = [];
      for (var i = 0; i < 3; i++) { var b = takeRelic(R, 'boss'); if (b) R.rew.boss.push(b); }
      if (R.act === 3) { R.rew = null; winRun(R); return; }
    }
    R.c = null;
    R.phase = 'reward';
  }
  function winRun(R) {
    R.c = null;
    R.over = true; R.won = true; R.phase = 'over';
  }
  function rollRelicRarity(R) {
    var x = rnd(R, 'loot');
    return x < 0.5 ? 'common' : x < 0.83 ? 'uncommon' : 'rare';
  }
  function takeRelic(R, rar) {
    var order = rar === 'boss' ? ['boss'] : rar === 'shop' ? ['shop', 'common', 'uncommon', 'rare'] : [rar, 'common', 'uncommon', 'rare'];
    for (var i = 0; i < order.length; i++) {
      var pool = R.relicPool[order[i]] || [];
      while (pool.length) { var id = pool.shift(); if (!has(R, id)) return id; }
    }
    return '';
  }
  function gainRelic(R, id) {
    if (!id || !RELICS[id] || has(R, id)) return false;
    R.relics.push(id);
    if (id === 'heartyStew') { R.mhp += 10; R.hp += 10; }
    return true;
  }
  function rollRarity(R, kind) {
    if (kind === 'boss') return 'rare';
    var x = rnd(R, 'loot'), rare = kind === 'elite' ? 0.12 : 0.05, unc = kind === 'elite' ? 0.42 : 0.35;
    return x < rare ? 'rare' : x < rare + unc ? 'uncommon' : 'common';
  }
  function cardChoices(R, kind, n) {
    n = n || 3 + (has(R, 'clover') ? 1 : 0) - (has(R, 'starShard') ? 1 : 0);
    var out = [], tries = 0;
    while (out.length < n && tries++ < 60) {
      var id = pick(R, 'loot', POOL[rollRarity(R, kind)]);
      if (out.some(function (c) { return c.id === id; })) continue;
      var up = CARDS[id].r !== 'rare' && rnd(R, 'loot') < (R.act - 1) * 0.12 ? 1 : 0;
      out.push({ id: id, u: up });
    }
    return out;
  }
  function takeCard(R, i) {
    if (R.phase !== 'reward' || !R.rew || R.rew.cardDone || !R.rew.cards) return false;
    var c = R.rew.cards[i];
    if (!c) return false;
    addCard(R, c.id, c.u);
    R.rew.cardDone = true;
    return true;
  }
  function skipCards(R) { if (R.rew) R.rew.cardDone = true; }
  function takeRewardRelic(R) {
    if (!R.rew || R.rew.relicDone || !R.rew.relic) return false;
    gainRelic(R, R.rew.relic);
    R.rew.relicDone = true;
    return true;
  }
  function takeBossRelic(R, i) {
    if (!R.rew || !R.rew.boss || R.rew.bossDone || !R.rew.boss[i]) return false;
    gainRelic(R, R.rew.boss[i]);
    R.rew.bossDone = true;
    return true;
  }
  // leave a reward / event / shop / rest / treasure screen
  function proceed(R) {
    if (R.over) return false;
    if (R.phase === 'reward' && R.rew && R.rew.relic && !R.rew.relicDone) takeRewardRelic(R);
    if (R.phase === 'treasure' && R.treasure && !R.treasure.taken) takeTreasure(R);
    var wasBoss = R.phase === 'reward' && R.rew && R.rew.kind === 'boss';
    if (['reward', 'event', 'shop', 'rest', 'treasure'].indexOf(R.phase) < 0) return false;
    if (R.phase === 'event' && R.evt && !R.evt.done) return false;
    R.rew = null; R.shop = null; R.evt = null; R.rest = null; R.treasure = null; R.pick = null;
    if (wasBoss) {
      R.act++;
      R.pos = -1;
      R.trail = [];
      R.actFights = 0;
      R.hp = R.mhp;
    }
    R.phase = 'map';
    return true;
  }
  function takeTreasure(R) {
    var T = R.treasure;
    if (!T || T.taken) return false;
    T.taken = true;
    if (T.relic) gainRelic(R, T.relic);
    R.gold += T.gold;
    R.stats.gold += T.gold;
    return true;
  }

  // ================= rest sites =================
  function restHealAmt(R) { return has(R, 'sunShard') ? 0 : Math.floor(R.mhp * 0.3) + (has(R, 'pillow') ? 15 : 0); }
  function restHeal(R) {
    if (R.phase !== 'rest' || !R.rest || R.rest.done || has(R, 'sunShard')) return false;
    var h = healP(R, restHealAmt(R));
    R.rest.done = true; R.rest.did = 'heal'; R.rest.n = h;
    return true;
  }
  function restUpgrade(R) {
    if (R.phase !== 'rest' || !R.rest || R.rest.done) return false;
    if (!R.deck.some(canUpgrade)) return false;
    R.pick = { kind: 'upgrade', from: 'rest' };
    R.phase = 'pick';
    return true;
  }
  function restRemove(R) {
    if (R.phase !== 'rest' || !R.rest || R.rest.done || !has(R, 'pipe') || R.deck.length < 2) return false;
    R.pick = { kind: 'remove', from: 'rest' };
    R.phase = 'pick';
    return true;
  }

  // ================= picking a card from your deck =================
  function pickable(R, card) {
    var k = R.pick && R.pick.kind;
    if (k === 'upgrade') return canUpgrade(card);
    return true;
  }
  function pickCard(R, deckIdx) {
    if (R.phase !== 'pick' || !R.pick) return false;
    var card = R.deck[deckIdx], P = R.pick;
    if (!card || !pickable(R, card)) return false;
    var msg = '';
    if (P.kind === 'upgrade') { card.u = 1; msg = 'Upgraded ' + cardName(card); }
    else if (P.kind === 'remove') {
      if (R.deck.length < 2) return false;
      R.deck.splice(deckIdx, 1); msg = 'Removed ' + cardName(card);
      if (P.from === 'shop') { R.gold -= P.cost; R.shop.removed = true; R.rmCost += 25; }
    } else if (P.kind === 'transform') {
      var pool = POOL.common.concat(POOL.uncommon, POOL.common, POOL.uncommon, POOL.rare).filter(function (id) { return id !== card.id; });
      var nid = pick(R, 'evt', pool);
      msg = 'Transformed ' + cardName(card) + ' into ' + CARDS[nid].n;
      R.deck[deckIdx] = { id: nid, u: 0, k: R.nk++ };
    } else if (P.kind === 'dup') {
      var cp = { id: card.id, u: card.u, k: R.nk++ };
      R.deck.splice(deckIdx + 1, 0, cp); msg = 'Copied ' + cardName(card);
    }
    P.left = (P.left || 1) - 1;
    if (P.left > 0) { P.msg = msg; return true; }
    endPick(R, msg);
    return true;
  }
  function cancelPick(R) {
    if (R.phase !== 'pick' || !R.pick) return false;
    // backing out of an event choice you already paid for gives the price back
    var rf = R.pick.refund;
    if (rf && R.pick.from === 'event') {
      if (rf.gold > 0) R.gold += Math.floor(rf.gold);
      if (rf.hp > 0) R.hp = Math.min(R.mhp, R.hp + Math.floor(rf.hp));
      if (R.evt) R.evt.msg = '';
    }
    endPick(R, '');
    return true;
  }
  function endPick(R, msg) {
    var from = R.pick.from, kind = R.pick.kind;
    R.pick = null;
    if (from === 'rest') { R.phase = 'rest'; if (msg) { R.rest.done = true; R.rest.did = kind; R.rest.msg = msg; } }
    else if (from === 'shop') { R.phase = 'shop'; if (msg) R.shop.msg = msg; }
    else { R.phase = 'event'; if (R.evt) { R.evt.done = true; R.evt.msg = (R.evt.msg ? R.evt.msg + ' ' : '') + (msg || 'You think better of it.'); } }
  }

  // ================= shops =================
  function priceMul(R) { return has(R, 'merchantSeal') ? 0.75 : 1; }
  function startShop(R) {
    R.phase = 'shop';
    var cards = [], seen = {}, i;
    var rars = ['common', 'common', 'uncommon', 'uncommon', 'rare'];
    for (i = 0; i < rars.length; i++) {
      for (var t = 0; t < 20; t++) {
        var id = pick(R, 'loot', POOL[rars[i]]);
        if (!seen[id]) { seen[id] = 1; break; }
      }
      var base = rars[i] === 'rare' ? 150 : rars[i] === 'uncommon' ? 75 : 50;
      cards.push({ id: id, u: 0, p: Math.round(base * (0.9 + rnd(R, 'loot') * 0.2)), sold: false });
    }
    var sale = rint(R, 'loot', cards.length);
    cards[sale].p = Math.round(cards[sale].p / 2); cards[sale].sale = true;
    var relics = [];
    [rollRelicRarity(R), rollRelicRarity(R), 'shop'].forEach(function (r) {
      var id = takeRelic(R, r);
      if (id) relics.push({ id: id, p: Math.round((RELICS[id].r === 'rare' ? 260 : RELICS[id].r === 'uncommon' ? 200 : RELICS[id].r === 'shop' ? 180 : 150) * (0.92 + rnd(R, 'loot') * 0.16)), sold: false });
    });
    R.shop = { cards: cards, relics: relics, removed: false, msg: '' };
    if (has(R, 'hotMeal')) { var h = healP(R, 15); R.shop.msg = h ? 'Hot Meal: healed ' + h + ' HP.' : ''; }
  }
  function shopPrice(R, p) { return Math.round(p * priceMul(R)); }
  function removeCost(R) { return has(R, 'brassToken') ? 50 : shopPrice(R, R.rmCost); }
  function buyCard(R, i) {
    var S = R.shop, it = S && S.cards[i];
    if (R.phase !== 'shop' || !it || it.sold) return false;
    var p = shopPrice(R, it.p);
    if (R.gold < p) return false;
    R.gold -= p; it.sold = true;
    addCard(R, it.id, it.u);
    S.msg = 'Bought ' + CARDS[it.id].n + '.';
    return true;
  }
  function buyRelic(R, i) {
    var S = R.shop, it = S && S.relics[i];
    if (R.phase !== 'shop' || !it || it.sold) return false;
    var p = shopPrice(R, it.p);
    if (R.gold < p) return false;
    R.gold -= p; it.sold = true;
    gainRelic(R, it.id);
    S.msg = 'Bought ' + RELICS[it.id].n + '.';
    return true;
  }
  function buyRemove(R) {
    var S = R.shop;
    if (R.phase !== 'shop' || !S || S.removed || R.gold < removeCost(R) || R.deck.length < 2) return false;
    R.pick = { kind: 'remove', from: 'shop', cost: removeCost(R) };
    R.phase = 'pick';
    return true;
  }

  // ================= events =================
  // opts(R) -> [{ l: label, d: detail, ok: bool }]; go(R, i) -> { msg, pick?, fight?, left? }
  function randCardOf(R, rar) { return pick(R, 'evt', POOL[rar]); }
  function upgradeRandom(R, n) {
    var names = [];
    for (var i = 0; i < n; i++) {
      var ups = R.deck.filter(canUpgrade);
      if (!ups.length) break;
      var c = ups[rint(R, 'evt', ups.length)];
      c.u = 1; names.push(cardName(c));
    }
    return names;
  }
  function pct(R, f) { return Math.max(1, Math.round(R.mhp * f)); }
  var EVENTS = {
    shrine: {
      n: 'The Mossy Shrine', art: ['    _/\\_', '   |o  o|', '   | /\\ |', ' __|____|__'],
      txt: 'A shrine half swallowed by moss. Coins glint in the offering bowl, and something hums beneath the stone.',
      opts: function (R) { return [{ l: 'Pray', d: 'Upgrade a random card.', ok: R.deck.some(canUpgrade) }, { l: 'Desecrate', d: 'Gain 90 gold. Become cursed: Regret.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) return { msg: 'A warm light. Upgraded ' + upgradeRandom(R, 1).join('') + '.' };
        if (i === 1) { R.gold += 90; addCard(R, 'regret'); return { msg: 'You pocket the coins. The humming stops. Something follows you now.' }; }
        return { msg: 'You leave the shrine in peace.' };
      }
    },
    smith: {
      n: 'The Wandering Smith', art: ['   ___', '  [___]==', '   | |', '  /___\\'],
      txt: 'A smith with a portable anvil sits by the path. "Steel needs work," she says, eyeing your pack. "Some of it needs melting."',
      opts: function (R) { return [{ l: 'Temper', d: 'Upgrade a card of your choice.', ok: R.deck.some(canUpgrade) }, { l: 'Reforge', d: 'Transform a card of your choice.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) return { pick: 'upgrade' };
        if (i === 1) return { pick: 'transform' };
        return { msg: 'You nod and walk on.' };
      }
    },
    fountain: {
      n: 'Bleeding Fountain', art: ['   .~~~.', '  ( ~~~ )', '   \\___/', '   _|_|_'],
      txt: 'Red water spills from a cracked stone basin. It smells of iron, and of power.',
      opts: function (R) { return [{ l: 'Drink deep', d: 'Lose ' + pct(R, 0.12) + ' HP. Gain a random rare card.', ok: R.hp > pct(R, 0.12) }, { l: 'Wash', d: 'Remove a curse from your deck.', ok: R.deck.some(function (c) { return CARDS[c.id].t === 'crs'; }) }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { R.hp -= pct(R, 0.12); var id = randCardOf(R, 'rare'); addCard(R, id); return { msg: 'It burns going down. You learned ' + CARDS[id].n + '.' }; }
        if (i === 1) {
          for (var k = 0; k < R.deck.length; k++) if (CARDS[R.deck[k].id].t === 'crs') { var nm = cardName(R.deck[k]); R.deck.splice(k, 1); return { msg: 'The water washes ' + nm + ' away.' }; }
        }
        return { msg: 'You leave the fountain be.' };
      }
    },
    gamble: {
      n: 'The Dice Den', art: ['  .---.  .---.', '  | o |  |o o|', "  '---'  '---'"],
      txt: 'A hooded figure rattles two bone dice. "Double or nothing, delver? Thirty gold says the bones like you."',
      opts: function (R) { return [{ l: 'Bet 30 gold', d: '50%: win 75 gold.', ok: R.gold >= 30 }, { l: 'Bet everything', d: '35%: double your gold.', ok: R.gold >= 10 }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { R.gold -= 30; if (rnd(R, 'evt') < 0.5) { R.gold += 75; return { msg: 'Snake eyes... no, sixes! You win 75 gold.' }; } return { msg: 'The bones are cold to you. 30 gold gone.' }; }
        if (i === 1) { var g = R.gold; if (rnd(R, 'evt') < 0.35) { R.gold += g; return { msg: 'Fortune smiles. You walk away with ' + (g * 2) + ' gold!' }; } R.gold = 0; return { msg: 'The figure laughs and sweeps your purse away.' }; }
        return { msg: 'You keep your gold.' };
      }
    },
    traveler: {
      n: 'A Lost Traveler', art: ['    o', '   /|\\_', '   / \\ |'],
      txt: 'A traveler sits by a dead lantern, lost. They clutch a small trinket and eye your purse.',
      opts: function (R) { return [{ l: 'Help (25 gold)', d: 'Lose 25 gold. Gain a relic.', ok: R.gold >= 25 }, { l: 'Rob them', d: 'Gain 40 gold. Become cursed: Doubt.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { R.gold -= 25; var id = takeRelic(R, 'common'); gainRelic(R, id); return { msg: 'They press the trinket into your hand: ' + (id ? RELICS[id].n : 'nothing') + '.' }; }
        if (i === 1) { R.gold += 40; addCard(R, 'doubt'); return { msg: 'You take their coins. You cannot quite forget their face.' }; }
        return { msg: 'You point them toward the exit and move on.' };
      }
    },
    pool: {
      n: 'The Glowing Pool', art: ['  ~ ~ ~ ~ ~', ' ~ (     ) ~', '  ~ ~ ~ ~ ~'],
      txt: 'A pool lit from below. Its warmth soothes, but the bottom is lined with things people dropped and never fetched.',
      opts: function (R) { return [{ l: 'Bathe', d: 'Heal ' + pct(R, 0.33) + ' HP.', ok: true }, { l: 'Dive', d: 'Lose 6 HP. Remove a card from your deck.', ok: R.hp > 6 && R.deck.length > 1 }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { var h = healP(R, pct(R, 0.33)); return { msg: 'You soak until your wounds close. Healed ' + h + ' HP.' }; }
        if (i === 1) { R.hp -= 6; return { pick: 'remove', msg: 'The cold steals your breath.', refund: { hp: 6 } }; }
        return { msg: 'You leave the pool undisturbed.' };
      }
    },
    library: {
      n: 'The Sunken Library', art: ['  |=|=|=|=|', '  |=|=|=|=|', '  |_|_|_|_|'],
      txt: 'Shelves of waterlogged books. A few are still readable, and one armchair is still dry.',
      opts: function (R) { return [{ l: 'Read', d: 'Choose 1 of 4 cards to add to your deck.', ok: true }, { l: 'Nap', d: 'Heal 20 HP.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) return { cards: cardChoices(R, 'elite', 4), msg: 'Choose a technique to learn.' };
        if (i === 1) { var h = healP(R, 20); return { msg: 'You doze among the pages. Healed ' + h + ' HP.' }; }
        return { msg: 'You leave the books to rot.' };
      }
    },
    grove: {
      n: 'Fungal Grove', art: ['  .-.  .--.', ' (   )(    )', '  | |  |  |'],
      txt: 'Giant mushrooms glow softly. Some look delicious. Some look like they want to eat you back.',
      opts: function (R) { return [{ l: 'Feast', d: 'Raise Max HP by 6. Lose 4 HP.', ok: R.hp > 4 }, { l: 'Harvest spores', d: 'Gain a random uncommon card. Become cursed: Clumsy.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { R.mhp += 6; R.hp = Math.max(1, R.hp + 6 - 4); return { msg: 'Earthy and strange. You feel sturdier.' }; }
        if (i === 1) { var id = randCardOf(R, 'uncommon'); addCard(R, id); addCard(R, 'clumsy'); return { msg: 'The spores make your fingers tingle. You learned ' + CARDS[id].n + '.' }; }
        return { msg: 'You give the grove a wide berth.' };
      }
    },
    mirror: {
      n: 'The Hall of Mirrors', art: ['  |\\  /|', '  | \\/ |', '  | /\\ |', '  |/  \\|'],
      txt: 'Your reflection moves a moment after you do. It offers you something from your own pack.',
      opts: function (R) { return [{ l: 'Reach in', d: 'Duplicate a card in your deck.', ok: true }, { l: 'Shatter it', d: 'Lose 5 HP. Gain 50 gold.', ok: R.hp > 5 }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) return { pick: 'dup' };
        if (i === 1) { R.hp -= 5; R.gold += 50; return { msg: 'Glass and silver everywhere. You scoop up 50 gold.' }; }
        return { msg: 'You hurry past.' };
      }
    },
    ambush: {
      n: 'Ambush!', art: ['  !  !  !', ' (o_o)(o_o)'],
      txt: 'Shapes peel away from the walls. There is no talking your way out of this one.',
      opts: function (R) { return [{ l: 'Fight', d: 'A fight; the spoils are richer.', ok: true }, { l: 'Flee', d: 'Lose ' + pct(R, 0.1) + ' HP.', ok: R.hp > pct(R, 0.1) }]; },
      go: function (R, i) {
        if (i === 0) return { fight: true };
        R.hp -= pct(R, 0.1);
        return { msg: 'You escape, bleeding but alive.' };
      }
    },
    statue: {
      n: 'The Golden Statue', art: ['    ___', '   (o o)', '   /|$|\\', '   _|_|_'],
      txt: 'A statue holds out a gilded relic. The plinth is covered in claw marks.',
      opts: function (R) { return [{ l: 'Take it', d: 'Gain a relic. Become cursed: Regret.', ok: true }, { l: 'Pry off gold', d: 'Gain 35 gold.', ok: true }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { var id = takeRelic(R, 'uncommon'); gainRelic(R, id); addCard(R, 'regret'); return { msg: 'The statue sighs as you take ' + (id ? RELICS[id].n : 'nothing') + '.' }; }
        if (i === 1) { R.gold += 35; return { msg: 'A few flakes come away: 35 gold.' }; }
        return { msg: 'You leave the statue its prize.' };
      }
    },
    altar: {
      n: 'The Forgotten Altar', art: ['   _____', '  |  +  |', '  |_____|', '  /     \\'],
      txt: 'An altar of old black stone. It asks for blood or for gold, and it promises to sharpen what you carry.',
      opts: function (R) { return [{ l: 'Offer blood', d: 'Lose 6 Max HP. Upgrade 2 random cards.', ok: R.mhp > 20 && R.deck.some(canUpgrade) }, { l: 'Offer gold (60)', d: 'Lose 60 gold. Remove a card.', ok: R.gold >= 60 && R.deck.length > 1 }, { l: 'Leave', d: '', ok: true }]; },
      go: function (R, i) {
        if (i === 0) { R.mhp -= 6; R.hp = Math.min(R.hp, R.mhp); return { msg: 'The stone drinks. Upgraded ' + upgradeRandom(R, 2).join(' and ') + '.' }; }
        if (i === 1) { R.gold -= 60; return { pick: 'remove', refund: { gold: 60 } }; }
        return { msg: 'You leave the altar hungry.' };
      }
    }
  };
  var EVENT_IDS = Object.keys(EVENTS);
  function startEvent(R) {
    var pool = EVENT_IDS.filter(function (id) { return R.seenEv.indexOf(id) < 0; });
    if (!pool.length) { R.seenEv = []; pool = EVENT_IDS.slice(); }
    var id = pick(R, 'evt', pool);
    R.seenEv.push(id);
    R.evt = { id: id, done: false, msg: '', cards: null };
    R.phase = 'event';
  }
  function eventOptions(R) { return R.evt ? EVENTS[R.evt.id].opts(R) : []; }
  function eventChoose(R, i) {
    if (R.phase !== 'event' || !R.evt || R.evt.done) return false;
    var o = eventOptions(R)[i];
    if (!o || !o.ok) return false;
    var res = EVENTS[R.evt.id].go(R, i) || {};
    if (R.hp <= 0) { R.hp = 0; dieOut(R, EVENTS[R.evt.id].n); return true; }
    R.evt.msg = res.msg || '';
    if (res.pick) { R.pick = { kind: res.pick, from: 'event' }; if (res.refund) R.pick.refund = res.refund; R.phase = 'pick'; return true; }
    if (res.cards) { R.evt.cards = res.cards; return true; }
    if (res.fight) {
      R.evt = null;
      startFight(R, 'fight', pickEncounterStrong(R));
      R.c.bonus = 25;
      return true;
    }
    R.evt.done = true;
    return true;
  }
  function pickEncounterStrong(R) { return pick(R, 'evt', ENC[R.act].strong).slice(); }
  function eventTakeCard(R, i) {
    if (R.phase !== 'event' || !R.evt || !R.evt.cards) return false;
    var c = R.evt.cards[i];
    if (c) { addCard(R, c.id, c.u); R.evt.msg = 'You learned ' + CARDS[c.id].n + (c.u ? '+' : '') + '.'; }
    else R.evt.msg = 'Nothing catches your eye.';
    R.evt.cards = null; R.evt.done = true;
    return true;
  }

  // ================= scoring, history, saves =================
  var BLIND_BONUS = 1.5;   // Blindfold runs score half again as much
  function score(R) {
    var s = R.floor * 5 + R.stats.kills * 2 + R.stats.elites * 20 + R.stats.bosses * 60;
    if (R.won) s += 300 + Math.round(R.hp / Math.max(1, R.mhp) * 100);
    if (R.blind) s = Math.round(s * BLIND_BONUS);
    return s;
  }
  function summary(R, now) {
    return {
      seed: R.seed, daily: R.daily || '', blind: !!R.blind, won: !!R.won, act: R.act, floor: R.floor, score: score(R),
      by: R.won ? '' : String(R.killedBy || ''), deck: R.deck.length, relics: R.relics.length,
      kills: R.stats.kills, elites: R.stats.elites, bosses: R.stats.bosses, maxHit: R.stats.maxHit, t: now || 0
    };
  }
  // runs / wins / bests / streaks count normal runs; Blindfold runs keep their own record in .blind
  function newBlindStats() { return { runs: 0, wins: 0, bestFloor: 0, bestScore: 0, streak: 0, bestStreak: 0 }; }
  function newStats() { return { runs: 0, wins: 0, bestFloor: 0, bestScore: 0, maxHit: 0, kills: 0, streak: 0, bestStreak: 0, hist: [], daily: {}, blind: newBlindStats() }; }
  function num(v, d, lo, hi) { v = Number(v); if (!isFinite(v)) return d; if (lo != null && v < lo) v = lo; if (hi != null && v > hi) v = hi; return v; }
  function normStats(o) {
    var s = newStats();
    if (!o || typeof o !== 'object') return s;
    ['runs', 'wins', 'bestFloor', 'bestScore', 'maxHit', 'kills', 'streak', 'bestStreak'].forEach(function (k) { s[k] = Math.floor(num(o[k], 0, 0, 1e9)); });
    if (Array.isArray(o.hist)) {
      s.hist = o.hist.filter(function (h) { return h && typeof h === 'object'; }).slice(0, 30).map(function (h) {
        return {
          seed: num(h.seed, 0, 0, 4294967295) >>> 0, daily: typeof h.daily === 'string' ? h.daily.slice(0, 10) : '', blind: !!h.blind, won: !!h.won,
          act: Math.floor(num(h.act, 1, 1, 3)), floor: Math.floor(num(h.floor, 0, 0, 99)), score: Math.floor(num(h.score, 0, 0, 1e6)),
          by: typeof h.by === 'string' ? h.by.slice(0, 40) : '', deck: Math.floor(num(h.deck, 0, 0, 999)), relics: Math.floor(num(h.relics, 0, 0, 99)),
          kills: Math.floor(num(h.kills, 0, 0, 9999)), elites: Math.floor(num(h.elites, 0, 0, 99)), bosses: Math.floor(num(h.bosses, 0, 0, 3)),
          maxHit: Math.floor(num(h.maxHit, 0, 0, 1e6)), t: num(h.t, 0, 0, 1e14)
        };
      });
    }
    if (o.blind && typeof o.blind === 'object') ['runs', 'wins', 'bestFloor', 'bestScore', 'streak', 'bestStreak'].forEach(function (k) { s.blind[k] = Math.floor(num(o.blind[k], 0, 0, 1e9)); });
    if (o.daily && typeof o.daily === 'object') {
      Object.keys(o.daily).slice(-60).forEach(function (k) {
        var d = o.daily[k];
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && d && typeof d === 'object') s.daily[k] = { score: Math.floor(num(d.score, 0, 0, 1e6)), won: !!d.won, floor: Math.floor(num(d.floor, 0, 0, 99)) };
      });
    }
    return s;
  }
  function recordRun(stats, R, now) {
    var sm = summary(R, now);
    if (!stats.blind) stats.blind = newBlindStats();
    var rec = sm.blind ? stats.blind : stats;
    rec.runs++;
    if (sm.won) { rec.wins++; rec.streak++; } else rec.streak = 0;
    rec.bestStreak = Math.max(rec.bestStreak, rec.streak);
    var newBest = sm.score > rec.bestScore;
    rec.bestFloor = Math.max(rec.bestFloor, sm.floor);
    rec.bestScore = Math.max(rec.bestScore, sm.score);
    stats.maxHit = Math.max(stats.maxHit, sm.maxHit);
    stats.kills += sm.kills;
    stats.hist.unshift(sm);
    if (stats.hist.length > 30) stats.hist.length = 30;
    if (sm.daily) {
      var prev = stats.daily[sm.daily];
      if (!prev || sm.score > prev.score) stats.daily[sm.daily] = { score: sm.score, won: sm.won, floor: sm.floor };
      var ks = Object.keys(stats.daily).sort();
      while (ks.length > 60) delete stats.daily[ks.shift()];
    }
    return { summary: sm, newBest: newBest };
  }
  // A saved run is trusted only if it is structurally sound; anything odd means start over.
  function validCard(c) { return c && typeof c === 'object' && CARDS.hasOwnProperty(c.id) && (c.u === 0 || c.u === 1) && isFinite(c.k); }
  function validCards(a) { return Array.isArray(a) && a.every(validCard); }
  function normRun(o) {
    try {
      // v1 saves (before hand retention / hidden intents) load too: the new fields get defaults below
      if (!o || typeof o !== 'object' || (o.v !== VERSION && o.v !== 1)) return null;
      if (!validCards(o.deck) || !o.deck.length || !Array.isArray(o.relics) || !o.relics.every(function (r) { return RELICS.hasOwnProperty(r); })) return null;
      if (!Array.isArray(o.maps) || o.maps.length !== 3) return null;
      for (var m = 0; m < 3; m++) {
        var M = o.maps[m];
        if (!M || !Array.isArray(M.nodes) || !M.nodes.length || !ENEMIES[M.boss]) return null;
        for (var j = 0; j < M.nodes.length; j++) {
          var n = M.nodes[j];
          if (!n || !NODE[n.t] || !Array.isArray(n.nx) || !n.nx.every(function (x) { return x >= 0 && x < M.nodes.length; })) return null;
        }
      }
      if (!o.rng || STREAMS.some(function (k) { return !isFinite(o.rng[k]); })) return null;
      var R = o;
      R.act = Math.floor(num(R.act, 1, 1, 3));
      R.mhp = Math.floor(num(R.mhp, START_HP, 1, 999));
      R.hp = Math.floor(num(R.hp, R.mhp, 0, R.mhp));
      R.gold = Math.floor(num(R.gold, 0, 0, 99999));
      R.floor = Math.floor(num(R.floor, 0, 0, 99));
      R.nk = Math.floor(num(R.nk, 1000, 1, 1e9));
      R.rmCost = Math.floor(num(R.rmCost, 75, 0, 9999));
      R.seed = num(R.seed, 0, 0, 4294967295) >>> 0;
      R.pos = Math.floor(num(R.pos, -1, -2, 999));
      if (R.pos >= o.maps[R.act - 1].nodes.length) return null;
      if (!R.counters || typeof R.counters !== 'object') R.counters = { atk: 0, play: 0 };
      R.counters.atk = Math.floor(num(R.counters.atk, 0, 0, 1e9)); R.counters.play = Math.floor(num(R.counters.play, 0, 0, 1e9));
      if (!R.stats || typeof R.stats !== 'object') R.stats = {};
      ['kills', 'elites', 'bosses', 'dmg', 'maxHit', 'played', 'gold', 'turns', 'fights'].forEach(function (k) { R.stats[k] = Math.floor(num(R.stats[k], 0, 0, 1e12)); });
      if (!Array.isArray(R.seenEv)) R.seenEv = [];
      R.trail = Array.isArray(R.trail) ? R.trail.filter(function (x) { return x === -2 || (x >= 0 && x < o.maps[R.act - 1].nodes.length); }) : [];
      R.seenEv = R.seenEv.filter(function (e) { return EVENTS.hasOwnProperty(e); });
      if (!R.relicPool || typeof R.relicPool !== 'object') R.relicPool = {};
      ['common', 'uncommon', 'rare', 'shop', 'boss'].forEach(function (r) {
        R.relicPool[r] = Array.isArray(R.relicPool[r]) ? R.relicPool[r].filter(function (id) { return RELICS.hasOwnProperty(id); }) : [];
      });
      R.daily = typeof R.daily === 'string' ? R.daily.slice(0, 10) : '';
      R.blind = !!R.blind && !R.daily;
      R.v = VERSION;
      R.phoenixUsed = !!R.phoenixUsed;
      R.over = !!R.over; R.won = !!R.won;
      var ph = R.phase;
      if (['map', 'combat', 'reward', 'shop', 'rest', 'event', 'pick', 'treasure', 'over'].indexOf(ph) < 0) return null;
      if (ph === 'combat') {
        var C = R.c;
        if (!C || !Array.isArray(C.e) || !C.e.length || !C.p || !C.p.st || !validCards(C.hand) || !validCards(C.draw) || !validCards(C.disc) || !validCards(C.exh)) return null;
        if (!C.e.every(function (e) { return e && ENEMIES[e.id] && e.st && isFinite(e.hp) && Array.isArray(e.hist) && e.mv >= -1 && e.mv < ENEMIES[e.id].m.length; })) return null;
        if (['player', 'enemy'].indexOf(C.phase) < 0) return null;
        C.log = [];
        C.e.forEach(function (e) {
          var d = ENEMIES[e.id];
          e.hide = e.hide === 'all' || e.hide === 'amount' || e.hide === '' ? e.hide : d.hide || '';
          e.halfUsed = !!e.halfUsed; e.held = !!e.held;
          e.rt = Math.floor(num(e.rt, 0, 0, 1e6)); e.acted = Math.floor(num(e.acted, 0, 0, 1e6)); e.chg = Math.floor(num(e.chg, 0, 0, 1e6));
          if (e.seen != null) e.seen = Math.floor(num(e.seen, 0, 0, 1e6));
        });
        C.scout = Math.floor(num(C.scout, 0, 0, 1e6)); C.full = Math.floor(num(C.full, 0, 0, 1e6));
        if (C.hand.length > MAX_HAND) C.disc = C.disc.concat(C.hand.splice(MAX_HAND));
        C.en = Math.floor(num(C.en, 0, 0, 99));
        C.p.hp = Math.floor(num(C.p.hp, 1, 0, 9999)); C.p.mhp = Math.floor(num(C.p.mhp, R.mhp, 1, 9999)); C.p.blk = Math.floor(num(C.p.blk, 0, 0, 99999));
      } else R.c = null;
      if (ph === 'reward' && (!R.rew || (R.rew.cards && !R.rew.cards.every(function (c) { return CARDS[c.id]; })))) return null;
      if (ph === 'shop' && (!R.shop || !Array.isArray(R.shop.cards) || !Array.isArray(R.shop.relics) || !R.shop.cards.every(function (c) { return CARDS[c.id]; }) || !R.shop.relics.every(function (c) { return RELICS[c.id]; }))) return null;
      if (ph === 'rest' && !R.rest) return null;
      if (ph === 'event' && (!R.evt || !EVENTS[R.evt.id])) return null;
      if (ph === 'pick' && (!R.pick || ['upgrade', 'remove', 'transform', 'dup'].indexOf(R.pick.kind) < 0)) return null;
      if (ph === 'pick' && R.pick.from === 'rest' && !R.rest) return null;
      if (ph === 'pick' && R.pick.from === 'shop' && !R.shop) return null;
      if (ph === 'treasure' && !R.treasure) return null;
      return R;
    } catch (e) { return null; }
  }

  // ================= text =================
  var SHORT = { vuln: 'Vulnerable', weak: 'Weak', frail: 'Frail', poison: 'Poison', str: 'Strength', dex: 'Dexterity' };
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  // text for a card; ctx { R, tgt } shows live numbers in a fight
  function cardText(card, ctx) {
    var d = cdef(card), out = [], R = ctx && ctx.R, C = R && R.c, P = C && C.p, tgt = ctx && ctx.tgt;
    function dmg(n) { if (!P) return n; return atkDmg(n, P, tgt && !tgt.dead ? tgt : null); }
    d.a.forEach(function (a) {
      var k = a[0], h = a[2];
      switch (k) {
        case 'dmg': out.push('Deal ' + dmg(a[1]) + ' damage' + (h === 'X' ? ' X times' : h > 1 ? ' ' + h + ' times' : '') + '.'); break;
        case 'dmgAll': out.push('Deal ' + (P ? atkDmg(a[1], P, null) : a[1]) + ' damage to ALL enemies' + (h === 'X' ? ' X times' : h > 1 ? ' ' + h + ' times' : '') + '.'); break;
        case 'dmgRand': out.push('Deal ' + (P ? atkDmg(a[1], P, null) : a[1]) + ' damage to a random enemy ' + h + ' times.'); break;
        case 'dmgVuln': out.push('Deal ' + dmg(a[1]) + ' damage. Double vs Vulnerable.'); break;
        case 'ifVuln': out.push('If the enemy is Vulnerable, gain 1 Energy and draw 1.'); break;
        case 'strMul': out.push('Deal ' + (P ? Math.floor((a[1] + (P.st.str || 0) * a[2]) * (P.st.weak ? 0.75 : 1) * (tgt && tgt.st.vuln ? 1.5 : 1)) : a[1]) + ' damage. Strength counts ' + a[2] + 'x.'); break;
        case 'grow': out.push('Deal ' + dmg(a[1] + (card.g || 0)) + ' damage. +' + a[2] + ' damage each play this fight.'); break;
        case 'bodySlam': out.push('Deal damage equal to your Block' + (P ? ' (' + dmg(P.blk) + ')' : '') + '.'); break;
        case 'drain': out.push('Deal ' + dmg(a[1]) + ' damage. Heal the unblocked damage.'); break;
        case 'drainAll': out.push('Deal ' + (P ? atkDmg(a[1], P, null) : a[1]) + ' damage to ALL enemies. Heal the unblocked damage.'); break;
        case 'devour': out.push('Deal ' + dmg(a[1]) + ' damage. If it kills, gain ' + a[2] + ' Max HP.'); break;
        case 'rupture': out.push('Deal ' + a[1] + 'x the enemy\u2019s Poison as damage' + (tgt && !tgt.dead ? ' (' + (tgt.st.poison || 0) * a[1] + ')' : '') + '.'); break;
        case 'catalyst': out.push((a[1] === 2 ? 'Double' : 'Triple') + ' the enemy\u2019s Poison.'); break;
        case 'blk': out.push('Gain ' + (P ? blockGainP(P, a[1]) : a[1]) + ' Block.'); break;
        case 'dblBlk': out.push('Double your Block.'); break;
        case 'st':
          if (a[1] === 'str' && a[3] === 'turn') out.push('The enemy loses ' + (-a[2]) + ' Strength this turn.');
          else if (a[1] === 'str') out.push('The enemy loses ' + (-a[2]) + ' Strength.');
          else out.push('Apply ' + a[2] + ' ' + SHORT[a[1]] + '.');
          break;
        case 'stAll': out.push('Apply ' + a[2] + ' ' + SHORT[a[1]] + ' to ALL enemies.'); break;
        case 'me': out.push(meText(a[1], a[2])); break;
        case 'draw': out.push('Draw ' + plural(a[1], 'card') + '.'); break;
        case 'energy': out.push('Gain ' + a[1] + ' Energy.'); break;
        case 'heal': out.push('Heal ' + a[1] + ' HP.'); break;
        case 'hpLoss': out.push('Lose ' + a[1] + ' HP.'); break;
        case 'add': out.push('Add ' + (a[2] === 1 ? 'a' : a[2]) + ' ' + CARDS[a[1]].n + (a[2] === 1 ? '' : 's') + (card.u && a[1] === 'spark' ? '+' : '') + ' to your ' + (a[3] === 'hand' ? 'hand' : a[3] === 'draw' ? 'draw pile' : 'discard pile') + '.'); break;
        case 'exRand': out.push('Exhaust a random card in your hand.'); break;
        case 'secondWind': out.push('Exhaust all non-Attacks in your hand; gain ' + a[1] + ' Block for each.'); break;
        case 'dblStr': out.push('Double your Strength.'); break;
        case 'upHand': out.push('Upgrade every card in your hand for this fight.'); break;
        case 'scout': out.push('Reveal all hidden enemy intents this turn.'); break;
        case 'bide': out.push(P ? 'Gain ' + blockGainP(P, a[1] * Math.max(0, C.hand.length - (C.hand.indexOf(card) >= 0 ? 1 : 0))) + ' Block (' + a[1] + ' per other card in your hand).' : 'Gain ' + a[1] + ' Block per other card in your hand.'); break;
        case 'counter': out.push('Reveal the enemy\u2019s intent. If it means to attack, gain Block equal to its attack damage (up to ' + a[1] + '). Otherwise, draw 2 cards.'); break;
      }
    });
    if (d.t === 'sts' || d.t === 'crs') {
      if (d.end && d.end[0] === 'burn') out.push('Unplayable. At the end of your turn, take 2 damage.');
      else if (d.end && d.end[0] === 'regret') out.push('Unplayable. At the end of your turn, lose 1 HP per card in your hand (held cards count).');
      else if (d.end && d.end[0] === 'doubt') out.push('Unplayable. At the end of your turn, gain 1 Weak.');
      else if (card.id === 'ooze') out.push('Does nothing. Costs 1 to exhaust; never held past your turn.');
      else out.push('Unplayable.');
    }
    if (d.eth) out.push('Ethereal.');
    if (d.ex) out.push('Exhaust.');
    if (d.c === -1) out.unshift('X = all your Energy.');
    return out.join(' ');
  }
  function blockGainP(P, n) { var b = n + (P.st.dex || 0); if (P.st.frail) b *= 0.75; return Math.max(0, Math.floor(b)); }
  function meText(k, n) {
    switch (k) {
      case 'str': return 'Gain ' + n + ' Strength.';
      case 'dex': return 'Gain ' + n + ' Dexterity.';
      case 'tmpStr': return 'Gain ' + n + ' Strength this turn.';
      case 'thorns': return 'Gain ' + n + ' Thorns.';
      case 'metal': return 'Gain ' + n + ' Plating (Block at the end of each turn).';
      case 'ritual': return 'At the end of your turn, gain ' + n + ' Strength.';
      case 'poisonAura': return 'At the start of your turn, apply ' + n + ' Poison to ALL enemies.';
      case 'drawP': return 'Draw ' + n + ' more card each turn.';
      case 'energyP': return 'Gain ' + n + ' more Energy each turn.';
      case 'keepBlock': return 'Your Block no longer expires.';
      case 'flameAura': return 'At the end of your turn, deal ' + n + ' damage to ALL enemies.';
      case 'envenom': return 'Whenever your attacks deal unblocked damage, apply ' + n + ' Poison.';
      case 'spikes': return 'Whenever you gain Block from a card, deal ' + n + ' damage to a random enemy.';
      case 'fervor': return 'This turn, whenever you play an Attack, gain ' + n + ' Block.';
      case 'nextBlk': return 'Next turn, gain ' + n + ' Block.';
      case 'foresight': return 'Hidden enemy intents are revealed for the rest of this fight.';
    }
    return '';
  }
  // a terse line for small cards: 6⚔  5◈ ...
  function cardShort(card, ctx) {
    var d = cdef(card), out = [], R = ctx && ctx.R, P = R && R.c && R.c.p, tgt = ctx && ctx.tgt;
    function dm(n, t) { return P ? atkDmg(n, P, t && !t.dead ? t : null) : n; }
    d.a.forEach(function (a) {
      var k = a[0], h = a[2];
      if (k === 'dmg') out.push(dm(a[1], tgt) + (h === 'X' ? 'xX' : h > 1 ? 'x' + h : '') + ' dmg');
      else if (k === 'dmgAll') out.push(dm(a[1]) + (h === 'X' ? 'xX' : h > 1 ? 'x' + h : '') + ' all');
      else if (k === 'dmgRand') out.push(dm(a[1]) + 'x' + h + ' rnd');
      else if (k === 'dmgVuln' || k === 'drain' || k === 'devour') out.push(dm(a[1], tgt) + ' dmg');
      else if (k === 'grow') out.push(dm(a[1] + (card.g || 0), tgt) + ' dmg');
      else if (k === 'drainAll') out.push(dm(a[1]) + ' all');
      else if (k === 'strMul') out.push(a[1] + '+S' + a[2]);
      else if (k === 'bodySlam') out.push(P ? dm(P.blk, tgt) + ' dmg' : '=blk dmg');
      else if (k === 'blk') out.push((P ? blockGainP(P, a[1]) : a[1]) + ' blk');
      else if (k === 'dblBlk') out.push('2x blk');
      else if (k === 'st' || k === 'stAll') out.push((a[2] > 0 ? '+' : '') + a[2] + ' ' + (ST[a[1]] ? ST[a[1]].g : a[1]) + (k === 'stAll' ? '*' : ''));
      else if (k === 'me') out.push((ST[a[1]] ? ST[a[1]].g : a[1]) + ' ' + a[2]);
      else if (k === 'draw') out.push('+' + a[1] + ' card');
      else if (k === 'energy') out.push('+' + a[1] + ' en');
      else if (k === 'heal') out.push('+' + a[1] + ' hp');
      else if (k === 'hpLoss') out.push('-' + a[1] + ' hp');
      else if (k === 'add') out.push('+' + a[2] + ' ' + CARDS[a[1]].n);
      else if (k === 'rupture') out.push('PSN x' + a[1]);
      else if (k === 'catalyst') out.push('PSN x' + a[1]);
      else if (k === 'dblStr') out.push('2x STR');
      else if (k === 'upHand') out.push('upgrade');
      else if (k === 'secondWind') out.push(a[1] + ' blk ea');
      else if (k === 'exRand') out.push('exh 1');
      else if (k === 'ifVuln') out.push('VUL:+1en');
      else if (k === 'scout') out.push('reveal');
      else if (k === 'bide') out.push(a[1] + ' blk/card');
      else if (k === 'counter') out.push('blk=atk');
    });
    if (d.t === 'sts' || d.t === 'crs') out.push(d.end ? d.end[0] : 'unplayable');
    return out.slice(0, 3).join(' \u00b7 ');
  }

  // A simple heuristic player, used by the tests to play whole runs (and handy to sanity-check balance).
  function autoTurn(R) {
    var C = R.c, guard = 0;
    while (C && R.phase === 'combat' && C.phase === 'player' && guard++ < 40) {
      var inc = incoming(R), best = -1, bestV = -1e9, i;
      for (i = 0; i < C.hand.length; i++) {
        var c = C.hand[i], d = cdef(c);
        if (whyNot(R, c)) continue;
        var v = 0;
        d.a.forEach(function (a) {
          if (a[0] === 'blk') v += inc > C.p.blk ? a[1] * 1.3 : a[1] * 0.2;
          else if (/^dmg|strMul|grow|drain|devour|bodySlam/.test(a[0])) v += (a[1] || 6) * (a[2] > 1 ? a[2] : 1);
          else if (a[0] === 'me') v += 12;
          else if (a[0] === 'draw' || a[0] === 'energy') v += 6;
          else v += 4;
        });
        if (d.t === 'pow') v += 8;
        v -= (d.c > 0 ? d.c : 0) * 0.5;
        if (d.t === 'sts') v = 0.5;
        if (v > bestV) { bestV = v; best = i; }
      }
      if (best < 0) break;
      var al = alive(C), ti = 0, lo = 1e9;
      al.forEach(function (e) { if (e.hp < lo) { lo = e.hp; ti = C.e.indexOf(e); } });
      if (playCard(R, best, ti)) break;
      C = R.c;
    }
    if (R.phase === 'combat' && R.c && R.c.phase === 'player') { endTurn(R); while (enemyStep(R)); }
  }
  function autoRun(R, choose, maxSteps) {
    choose = choose || function (n) { return 0; };
    for (var s = 0; s < (maxSteps || 4000) && !R.over; s++) {
      var ph = R.phase;
      if (ph === 'map') { var nx = nextNodes(R); chooseNode(R, nx[choose(nx.length, 'map', R)]); }
      else if (ph === 'combat') autoTurn(R);
      else if (ph === 'reward') {
        if (R.rew.cards && !R.rew.cardDone) { if (R.rew.cards.length) takeCard(R, choose(R.rew.cards.length, 'card', R)); else skipCards(R); }
        if (R.rew.boss && !R.rew.bossDone) takeBossRelic(R, 0);
        proceed(R);
      } else if (ph === 'rest') { if (R.hp < R.mhp * 0.6 && !has(R, 'sunShard')) restHeal(R); else if (!restUpgrade(R)) restHeal(R); if (R.phase === 'rest') proceed(R); }
      else if (ph === 'pick') { var k = -1; for (var j = 0; j < R.deck.length; j++) if (pickable(R, R.deck[j]) && (R.pick.kind !== 'remove' || R.deck[j].id === 'strike' || CARDS[R.deck[j].id].t === 'crs')) { k = j; break; } if (k < 0 || !pickCard(R, k)) cancelPick(R); }
      else if (ph === 'event') {
        if (R.evt.cards) eventTakeCard(R, 0);
        else if (!R.evt.done) { var os = eventOptions(R), oi = os.length - 1; for (var q = 0; q < os.length; q++) if (os[q].ok) { oi = q; break; } eventChoose(R, oi); }
        else proceed(R);
      } else if (ph === 'shop') { if (R.gold > 200) buyCard(R, 0); proceed(R); }
      else if (ph === 'treasure') proceed(R);
      else break;
    }
    return R;
  }

  var ENGINE = {
    VERSION: VERSION, ROWS: ROWS, COLS: COLS, FLOORS: FLOORS, START_HP: START_HP, MAX_HAND: MAX_HAND, ACT_NAMES: ACT_NAMES, RULES: RULES, BLIND_BONUS: BLIND_BONUS,
    CARDS: CARDS, ENEMIES: ENEMIES, RELICS: RELICS, EVENTS: EVENTS, ENC: ENC, ST: ST, NODE: NODE, POOL: POOL,
    hashStr: hashStr, mix: mix, rnd: rnd, seedCode: seedCode, parseSeed: parseSeed, dailySeed: dailySeed, dateKey: dateKey,
    cdef: cdef, canUpgrade: canUpgrade, cardName: cardName, playable: playable,
    newRun: newRun, addCard: addCard, genMap: genMap, nextNodes: nextNodes, chooseNode: chooseNode, nodeType: nodeType, curMap: curMap, floorNo: floorNo,
    startFight: startFight, playCard: playCard, whyNot: whyNot, endTurn: endTurn, enemyStep: enemyStep, intentOf: intentOf, incoming: incoming,
    incomingInfo: incomingInfo, realIntent: realIntent, hideLevel: hideLevel, drawCount: drawCount,
    atkDmg: atkDmg, alive: alive, energyMax: energyMax, has: has, gainRelic: gainRelic,
    takeCard: takeCard, skipCards: skipCards, takeRewardRelic: takeRewardRelic, takeBossRelic: takeBossRelic, proceed: proceed, takeTreasure: takeTreasure,
    restHeal: restHeal, restHealAmt: restHealAmt, restUpgrade: restUpgrade, restRemove: restRemove,
    pickable: pickable, pickCard: pickCard, cancelPick: cancelPick,
    shopPrice: shopPrice, removeCost: removeCost, buyCard: buyCard, buyRelic: buyRelic, buyRemove: buyRemove,
    eventOptions: eventOptions, eventChoose: eventChoose, eventTakeCard: eventTakeCard,
    score: score, summary: summary, newStats: newStats, normStats: normStats, recordRun: recordRun, normRun: normRun,
    cardText: cardText, cardShort: cardShort, autoTurn: autoTurn, autoRun: autoRun
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;

  // ================= UI =================
  if (typeof window === 'undefined' || typeof window.Cade === 'undefined') return;
  var Cade = window.Cade;
  var E = ENGINE;
  Cade.loadCSS('deckbuilder.css');

  var PANEL_ID = 'deckbuilder-panel', NAME = 'Deck Delve';
  var KEY = 'cade-deckbuilder-', RUN_KEY = KEY + 'run', STATS_KEY = KEY + 'stats', SOUND_KEY = KEY + 'sound', SEEN_KEY = KEY + 'seen', BLIND_KEY = KEY + 'blind';
  var S = null;
  if (window.__CADE_UNIT__) window.__CADE_UNIT__.deckbuilder = { live: function () { return S; }, render: function () { render(); }, E: ENGINE };
  var ROMAN = ['', 'I', 'II', 'III'];
  var TYPE = { atk: 'Attack', skl: 'Skill', pow: 'Power', sts: 'Status', crs: 'Curse' };
  var RAR = { basic: 'starter', common: 'common', uncommon: 'uncommon', rare: 'rare', special: '' };

  function sget(k) { try { return Cade.store.get(k); } catch (e) { return null; } }
  function sset(k, v) { try { Cade.store.set(k, String(v)); } catch (e) {} }
  function sdel(k) { try { Cade.store.remove(k); } catch (e) {} }
  function jget(k) { var r = sget(k); if (!r) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  function esc(s) { return Cade.escapeHtml ? Cade.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function saveRun() { if (S && S.R && !S.R.over) sset(RUN_KEY, JSON.stringify(S.R)); }
  function saveStats() { if (S) sset(STATS_KEY, JSON.stringify(S.stats)); }

  // ---- sound: a tiny WebAudio voice, made on a user gesture, off by default ----
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
  Snd.prototype.close = function () { if (this.ac) { try { this.ac.close(); } catch (e) {} this.ac = null; } };
  var SFX = {
    tap: function (s) { s.tone(660, 0.04, 'sine', 0.025); },
    atk: function (s) { s.tone(320, 0.09, 'sawtooth', 0.035, 140); },
    skl: function (s) { s.tone(520, 0.08, 'triangle', 0.04, 780); },
    pow: function (s) { s.tone(392, 0.12, 'triangle', 0.04, 784); s.tone(587, 0.16, 'sine', 0.03, 0, 0.08); },
    hit: function (s) { s.tone(140, 0.12, 'square', 0.04, 70); },
    blk: function (s) { s.tone(1200, 0.05, 'triangle', 0.03, 900); },
    hurt: function (s) { s.tone(110, 0.2, 'sawtooth', 0.05, 55); },
    kill: function (s) { s.tone(300, 0.18, 'square', 0.035, 60); },
    no: function (s) { s.tone(180, 0.08, 'square', 0.03, 150); },
    coin: function (s) { s.tone(988, 0.06, 'square', 0.025); s.tone(1319, 0.1, 'square', 0.022, 0, 0.06); },
    win: function (s) { [523, 659, 784, 1047].forEach(function (f, i) { s.tone(f, 0.14, 'triangle', 0.04, 0, i * 0.09); }); },
    lose: function (s) { [392, 330, 262, 196].forEach(function (f, i) { s.tone(f, 0.22, 'triangle', 0.04, 0, i * 0.14); }); },
    step: function (s) { s.tone(440, 0.05, 'sine', 0.025, 520); },
    chg: function (s) { s.tone(740, 0.06, 'square', 0.025); s.tone(554, 0.09, 'square', 0.022, 0, 0.07); }
  };
  function sfx(n) { if (S && S.snd.on && SFX[n]) SFX[n](S.snd); }

  function svg(path, fill) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="' + (fill ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var IC_SND_ON = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>');
  var IC_SND_OFF = svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>');
  var IC_HELP = svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>');
  var IC_HOME = svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>');
  var IC_DECK = svg('<rect x="7" y="3" width="12" height="16" rx="2"/><path d="M5 7v12a2 2 0 0 0 2 2h9"/>');

  var BANNER = [
    ' ___  ___ ___ _  __',
    '|   \\| __/ __| |/ /',
    '| |) | _| (__| \' < ',
    '|___/|___\\___|_|\\_\\',
    '   D  E  L  V  E'
  ].join('\n');
  var ART = {
    rest: ['      (', '     ) )', '    ( ( (', '   .-----.', "  '-------'"].join('\n'),
    shop: ['   _______', '  /  $$$  \\', ' |  o   o  |', ' |   ___   |', "  '-------'"].join('\n'),
    chest: ['   _______', '  /_______\\', '  |  [#]  |', '  |_______|'].join('\n'),
    chestOpen: ['   _______', '  |\\  *  /|', '  | \\___/ |', '  |_______|'].join('\n'),
    grave: ['    _____', '   /     \\', '  |  RIP  |', '  |       |', ' _|_______|_'].join('\n'),
    crown: ['   _/\\/\\/\\_', '  |  * *  |', '  |_______|'].join('\n')
  };

  // ================= rendering =================
  function costOf(d) { return d.c == null ? '' : d.c === -1 ? 'X' : String(d.c); }
  function cardHTML(c, o) {
    o = o || {};
    var d = E.cdef(c), cost = costOf(d), cls = 'dk-card t-' + d.t + (c.u ? ' up' : '') + (o.sel ? ' sel' : '') + (o.no ? ' no' : '') + (o.full ? ' full' : '') + (o.cls ? ' ' + o.cls : '');
    var rar = RAR[d.r] || '';
    return '<button type="button" class="' + cls + '" ' + (o.attr || '') + (o.dis ? ' disabled' : '') + '>' +
      '<span class="dk-ch"><span class="dk-cc' + (cost ? '' : ' x') + '">' + (cost || '-') + '</span><span class="dk-cn">' + esc(E.cardName(c)) + '</span></span>' +
      '<span class="dk-ct">' + TYPE[d.t] + (rar && o.full ? ' \u00b7 ' + rar : '') + '</span>' +
      '<span class="dk-cd">' + esc(E.cardText(c, o.ctx)) + '</span>' +
      '<span class="dk-cs">' + esc(E.cardShort(c, o.ctx)) + '</span>' +
      (o.price != null ? '<span class="dk-pr' + (o.poor ? ' poor' : '') + '">' + (o.sold ? 'sold' : '$' + o.price) + '</span>' : '') +
      '</button>';
  }
  function relicChip(id, attr) {
    var r = E.RELICS[id];
    return '<span class="dk-rel r-' + r.r + '" ' + (attr || '') + ' title="' + esc(r.n + ': ' + r.d) + '">' + esc(r.g) + '</span>';
  }
  function bar(hp, mhp, w) {
    w = w || 10;
    var f = mhp ? Math.max(hp > 0 ? 1 : 0, Math.round(hp / mhp * w)) : 0;
    return '<span class="dk-bar"><i>' + '#'.repeat(f) + '</i>' + '-'.repeat(w - f) + '</span>';
  }
  function stChips(u) {
    var out = '';
    Object.keys(u.st).forEach(function (k) {
      var v = u.st[k], d = E.ST[k];
      if (!d || !v || k === 'tmpStr' || k === 'turnStr') return;
      var good = d.good ? v > 0 : v < 0;
      if (k === 'str' && v < 0) good = false;
      out += '<span class="dk-st ' + (good ? 'good' : 'bad') + '" data-st="' + k + '">' + d.g + (k === 'keepBlock' ? '' : ' ' + v) + '</span>';
    });
    return out;
  }
  function topHTML() {
    var R = S.R;
    if (!R) return '';
    var hp = R.c ? R.c.p.hp : R.hp, mhp = R.c ? R.c.p.mhp : R.mhp;
    var rel = R.relics.map(function (id) { return relicChip(id); }).join('');
    return '<div class="dk-stat"><span class="dk-hpv' + (hp <= mhp * 0.3 ? ' low' : '') + '">\u2665 ' + hp + '/' + mhp + '</span>' +
      '<span class="dk-gold">$' + R.gold + '</span><span class="dk-fl">Act ' + ROMAN[R.act] + ' \u00b7 F' + R.floor + '</span>' +
      (R.daily ? '<span class="dk-daily">daily</span>' : '') + (R.blind ? '<span class="dk-blind" title="Blindfold: every intent is hidden; score \u00d7' + E.BLIND_BONUS + '">blindfold</span>' : '') +
      '<button type="button" class="dk-rels" data-act="relics" aria-label="Relics">' + rel + '</button></div>';
  }

  function render() {
    if (!S) return;
    var R = S.R;
    // a run can end outside a fight animation (e.g. Blood Crown at a fight's start): record it once
    if (R && R.over && !S.holdC && S.recorded !== R) finishRun();
    S.top.innerHTML = topHTML();
    S.top.style.display = R && S.view !== 'home' ? '' : 'none';
    var html, v = S.view;
    if (v === 'home' || !R) html = homeHTML();
    else if (S.holdC) html = combatHTML(S.holdC, true);
    else if (R.phase === 'combat') html = combatHTML(R.c, false);
    else if (R.phase === 'map') html = mapHTML();
    else if (R.phase === 'reward') html = rewardHTML();
    else if (R.phase === 'shop') html = shopHTML();
    else if (R.phase === 'rest') html = restHTML();
    else if (R.phase === 'event') html = eventHTML();
    else if (R.phase === 'pick') html = pickHTML();
    else if (R.phase === 'treasure') html = treasureHTML();
    else if (R.phase === 'over') html = overHTML();
    else html = homeHTML();
    var kind = v === 'home' || !R ? 'home' : S.holdC ? 'combat' : R.phase;
    S.main.className = 'dk-main v-' + kind;
    S.main.innerHTML = html;
    if (kind === 'map') scrollMap();
    if (kind !== S.lastKind) { S.main.scrollTop = 0; if (S.body) S.body.scrollTop = 0; }
    S.lastKind = kind;
    syncHead();
    renderCard();
  }

  // ---- home ----
  function homeHTML() {
    var st = S.stats, saved = S.R && !S.R.over ? S.R : null, today = E.dateKey(), dd = st.daily[today];
    var h = '<div class="dk-home"><pre class="dk-banner">' + esc(BANNER) + '</pre>' +
      '<p class="dk-sub">Build a deck. Climb three acts. Topple the Hollow Monarch.</p><div class="dk-menu">';
    if (saved) {
      h += '<button type="button" class="dk-go" data-act="continue">Continue run<small>Act ' + ROMAN[saved.act] + ' \u00b7 floor ' + saved.floor + ' \u00b7 \u2665 ' + (saved.c ? saved.c.p.hp : saved.hp) + ' \u00b7 seed ' + E.seedCode(saved.seed) + (saved.daily ? ' \u00b7 daily' : '') + (saved.blind ? ' \u00b7 blindfold' : '') + '</small></button>';
    }
    h += '<button type="button" class="dk-go' + (saved ? ' alt' : '') + '" data-act="new">New run<small>a random seed' + (S.blind ? ' \u00b7 blindfolded' : '') + '</small></button>';
    h += '<button type="button" class="dk-go alt" data-act="daily">Daily delve<small>' + today + (dd ? ' \u00b7 best ' + dd.score + (dd.won ? ' \u00b7 won' : '') : ' \u00b7 the same seed for everyone') + '</small></button>';
    h += '<div class="dk-seedrow"><input class="dk-in" type="text" maxlength="24" placeholder="seed (e.g. 0BADGER)" aria-label="Seed" autocomplete="off" autocapitalize="characters" spellcheck="false"><button type="button" class="dk-go alt sm" data-act="seed">Play seed</button></div>';
    h += '<button type="button" class="dk-mod' + (S.blind ? ' on' : '') + '" data-act="blind" role="switch" aria-checked="' + (S.blind ? 'true' : 'false') + '"><span class="dk-tog" aria-hidden="true"></span><span><b>Blindfold</b> <span class="dk-dim">' + (S.blind ? 'on' : 'off') + '</span><br><span class="dk-dim">Every enemy intent is hidden for the whole run (scouting still works). Score \u00d7' + E.BLIND_BONUS + ', separate records. New runs and seeds only \u2014 not the daily.</span></span></button>';
    h += '</div>';
    if (S.confirmNew) h += '<div class="dk-confirm">Abandon the current run? It counts as a loss. <button type="button" class="dk-lnk danger" data-act="new-yes">Abandon &amp; start</button> <button type="button" class="dk-lnk" data-act="new-no">Keep it</button></div>';
    h += '<div class="dk-foot"><span>' + st.runs + ' runs \u00b7 ' + st.wins + ' wins \u00b7 best ' + st.bestScore + (st.blind && st.blind.runs ? ' \u00b7 blindfold ' + st.blind.wins + '/' + st.blind.runs : '') + '</span><span><button type="button" class="dk-lnk" data-act="records">Records</button> <button type="button" class="dk-lnk" data-act="help">How to play</button></span></div></div>';
    return h;
  }

  // ---- map ----
  function mapHTML() {
    var R = S.R, M = E.curMap(R), N = M.nodes, W = E.COLS * 2 - 1, nx = E.nextNodes(R), grid = {}, onTrail = {};
    N.forEach(function (n, i) { grid[n.r + ':' + n.c] = i; });
    R.trail.forEach(function (i) { onTrail[i] = 1; });
    var curRow = R.pos >= 0 ? N[R.pos].r : -1;
    var h = '<div class="dk-mhead"><div class="dk-title">Act ' + ROMAN[R.act] + '</div><div class="dk-sub">' + esc(E.ACT_NAMES[R.act - 1]) + ' \u2014 choose your path</div></div>';
    h += '<div class="dk-map" style="--cols:' + W + '">';
    var bossAvail = nx.indexOf(-2) >= 0;
    h += '<button type="button" class="dk-boss' + (bossAvail ? ' avail' : '') + '" data-node="-2"' + (bossAvail ? '' : ' tabindex="-1"') + '><span class="g">@</span> ' + esc(E.ENEMIES[M.boss].n) + '</button>';
    var top = '';
    for (var c = 0; c < W; c++) top += c % 2 === 0 && grid[(E.ROWS - 1) + ':' + c / 2] != null ? (c / 2 < (E.COLS - 1) / 2 ? '/' : c / 2 > (E.COLS - 1) / 2 ? '\\' : '|') : ' ';
    h += '<div class="dk-mrow e">' + top.split('').map(function (ch) { return '<span>' + esc(ch) + '</span>'; }).join('') + '</div>';
    for (var r = E.ROWS - 1; r >= 0; r--) {
      h += '<div class="dk-mrow n">';
      for (c = 0; c < W; c++) {
        var i = c % 2 === 0 ? grid[r + ':' + (c / 2)] : null;
        if (i == null) { h += '<span></span>'; continue; }
        var n = N[i], av = nx.indexOf(i) >= 0, cls = 'dk-node t-' + n.t + (av ? ' avail' : '') + (i === R.pos ? ' cur' : '') + (onTrail[i] ? ' done' : '') + (r <= curRow && !onTrail[i] ? ' past' : '');
        h += '<button type="button" class="' + cls + '" data-node="' + i + '" title="' + E.NODE[n.t].n + '"' + (av ? '' : ' tabindex="-1"') + '>' + E.NODE[n.t].g + '</button>';
      }
      h += '</div>';
      if (r > 0) {
        var cells = [];
        for (c = 0; c < W; c++) cells.push({ ch: ' ', on: false });
        N.forEach(function (a, ai) {
          if (a.r !== r - 1) return;
          a.nx.forEach(function (bi) {
            var b = N[bi], x = a.c + b.c, ch = b.c === a.c ? '|' : b.c > a.c ? '/' : '\\';
            cells[x].ch = ch;
            if (onTrail[ai] && onTrail[bi]) cells[x].on = true;
          });
        });
        h += '<div class="dk-mrow e">' + cells.map(function (x) { return '<span' + (x.on ? ' class="on"' : '') + '>' + esc(x.ch) + '</span>'; }).join('') + '</div>';
      }
    }
    h += '</div><div class="dk-legend">';
    ['fight', 'elite', 'event', 'shop', 'rest', 'treasure'].forEach(function (t) { h += '<span class="t-' + t + '"><b>' + E.NODE[t].g + '</b> ' + E.NODE[t].n + '</span>'; });
    h += '</div>';
    return h;
  }
  function scrollMap() {
    var m = S.main.querySelector('.dk-map');
    if (!m) return;
    var t = m.querySelector('.dk-node.avail') || m.querySelector('.dk-boss.avail') || m.querySelector('.dk-node.cur');
    if (!t) { m.scrollTop = m.scrollHeight; return; }
    var y = t.offsetTop - m.offsetTop;
    m.scrollTop = Math.max(0, y - m.clientHeight * 0.55);
  }

  // ---- combat ----
  // could this enemy's intent be hidden (Blindfold, or its own nature)?
  function hideable(R, e) { return R.blind ? 'all' : e.hide != null ? e.hide : E.ENEMIES[e.id].hide || ''; }
  function intentHTML(R, e) {
    var o = E.intentOf(R, e);
    if (!o) return '<div class="dk-int">&nbsp;</div>';
    var parts = [], title, rev = !o.hide && hideable(R, e);
    if (o.hide === 'all') { parts.push('<b class="i-unk">?</b>'); title = 'Hidden intent \u2014 scout to reveal it'; }
    else {
      if (o.atk) parts.push('<b class="i-atk">ATK ' + (o.dmg == null ? '?' : o.dmg + (o.hits > 1 ? '\u00d7' + o.hits : '')) + '</b>');
      if (o.def) parts.push('<b class="i-def">DEF</b>');
      if (o.buf) parts.push('<b class="i-buf">BUFF</b>');
      if (o.dbf) parts.push('<b class="i-dbf">' + (o.add ? 'CURSE' : 'DEBUFF') + '</b>');
      if (o.heal) parts.push('<b class="i-heal">HEAL</b>');
      title = o.hide ? 'Amounts hidden \u2014 scout to reveal them' : o.n + (rev ? ' (revealed)' : '');
    }
    if (rev) parts.unshift('<i class="i-rev" aria-hidden="true">\u25c9</i>');
    if (o.chg) parts.unshift('<i class="i-chg" aria-hidden="true">!</i>');
    return '<div class="dk-int' + (o.hide ? ' hid' : '') + (o.chg ? ' chg' : '') + '" title="' + esc(title) + (o.chg ? ' \u2014 it changed its plan' : '') + '">' + parts.join(' ') + '</div>';
  }
  function needsTarget(R, c) { var d = E.cdef(c); return d.tg === 'e' && E.alive(R.c).length > 1; }
  function combatHTML(C, frozen) {
    var R = S.R, sel = frozen ? -1 : S.sel, selCard = sel >= 0 ? C.hand[sel] : null, tgtMode = selCard && E.cdef(selCard).tg === 'e';
    if (S.tgt < 0 || !C.e[S.tgt] || C.e[S.tgt].dead) S.tgt = C.e.findIndex(function (e) { return !e.dead; });
    var h = '<div class="dk-foes n' + C.e.length + '">';
    C.e.forEach(function (e, i) {
      var d = E.ENEMIES[e.id], cls = 'dk-foe' + (e.dead ? ' dead' : '') + (d.boss ? ' boss' : d.elite ? ' elite' : '') + (tgtMode && !e.dead ? ' aim' : '') + (tgtMode && i === S.tgt && !e.dead ? ' tgt' : '');
      h += '<button type="button" class="' + cls + '" data-e="' + i + '"' + (e.dead ? ' tabindex="-1"' : '') + '>' +
        (e.dead ? '<div class="dk-int">&nbsp;</div>' : intentHTML(R, e)) +
        '<pre class="dk-art">' + esc(d.art.join('\n')) + '</pre>' +
        '<div class="dk-fn">' + esc(d.n) + '</div>' +
        '<div class="dk-hp">' + bar(e.hp, e.mhp, 8) + ' ' + e.hp + '/' + e.mhp + '</div>' +
        '<div class="dk-sts">' + (e.blk ? '<span class="dk-st blk">BLK ' + e.blk + '</span>' : '') + stChips(e) + '</div></button>';
    });
    h += '</div>';
    var P = C.p, en = C.en, emax = E.energyMax(R) + (P.st.energyP || 0), pips = '';
    for (var k = 0; k < Math.max(en, emax); k++) pips += k < en ? '\u25c6' : '\u25c7';
    var ii = frozen ? { dmg: 0, unknown: 0 } : E.incomingInfo(R), inc = ii.dmg, unk = ii.unknown ? '+?' : '';
    h += '<div class="dk-me" data-me="1"><div class="dk-en" title="Energy"><b>' + en + '/' + emax + '</b><span>' + pips + '</span></div>' +
      '<div class="dk-pl"><div class="dk-plh"><span class="dk-who">YOU</span> ' + bar(P.hp, P.mhp, 10) + ' <b>' + P.hp + '/' + P.mhp + '</b>' +
      (P.blk ? ' <span class="dk-st blk">BLK ' + P.blk + '</span>' : '') + '</div><div class="dk-sts">' + stChips(P) +
      (inc || unk ? '<span class="dk-inc' + (inc > P.blk ? ' bad' : '') + '" title="' + (unk ? 'Some intents are hidden: ? may be more' : 'Damage the enemies will deal') + '">incoming ' + (inc || !unk ? inc : '') + (unk && inc ? unk : unk ? '?' : '') +
        (inc && P.blk ? (inc > P.blk ? ' (' + (inc - P.blk) + unk + ' through)' : unk ? ' (' + P.blk + ' blk)' : ' (blocked)') : '') + '</span>' : '') + '</div></div></div>';
    var hint = S.hint;
    if (!hint) {
      if (frozen) hint = C.phase === 'won' || R.phase === 'reward' ? '<b>Victory!</b>' : '';
      else if (C.phase === 'enemy') hint = '<span class="dk-dim">Enemy turn\u2026</span>';
      else if (selCard) {
        var why = E.whyNot(R, selCard);
        hint = '<b>' + esc(E.cardName(selCard)) + '</b> ' + esc(E.cardText(selCard, { R: R, tgt: C.e[S.tgt] })) +
          '<span class="dk-dim"> \u2014 ' + (why ? esc(why) : tgtMode ? (needsTarget(R, selCard) ? 'tap an enemy (or the card again)' : 'tap again to play') : 'tap again to play') + '</span>';
      } else if (C.full === C.turn && C.hand.length >= E.MAX_HAND) hint = '<b>Hand full</b> <span class="dk-dim">\u2014 ' + E.MAX_HAND + ' cards is the most you can hold; extra draws stay in your draw pile.</span>';
      else hint = '<span class="dk-dim">' + (S.coarse ? 'Tap a card, then a target. Cards you don\u2019t play stay in your hand. Tap an enemy to see what it will do.' : 'Click a card (or 1\u20139, 0), then a target (\u2190 \u2192, Enter). Cards you don\u2019t play stay in your hand. E ends the turn.') + '</span>';
    }
    h += '<div class="dk-hint" aria-live="polite">' + hint + '</div>';
    // cards held from last turn carry a small marker; it glows the first time the turn is shown
    var fresh = S.keptC !== C || S.keptTurn !== C.turn;
    S.keptC = C; S.keptTurn = C.turn;
    h += '<div class="dk-hand n' + C.hand.length + (C.hand.length > 5 ? ' many' : '') + '" style="--n:' + Math.max(1, C.hand.length) + '">';
    C.hand.forEach(function (c, i) {
      var why = frozen ? 'x' : E.whyNot(R, c), kept = c.kept === C.turn;
      h += cardHTML(c, { attr: 'data-h="' + i + '"' + (kept ? ' title="Held from last turn"' : ''), sel: i === sel, no: !!why, ctx: { R: R, tgt: tgtMode || E.cdef(c).tg === 'e' ? C.e[S.tgt] : null }, cls: 'k' + ((i + 1) % 10) + (kept ? ' kept' + (fresh && !frozen ? ' fresh' : '') : '') });
    });
    if (!C.hand.length) h += '<div class="dk-empty">' + (C.phase === 'enemy' ? '' : 'No cards in hand') + '</div>';
    h += '</div>';
    var busy = frozen || C.phase !== 'player' || S.busy;
    var full = C.hand.length >= E.MAX_HAND;
    h += '<div class="dk-bar2"><span class="dk-hc' + (full ? ' full' : '') + '" title="Cards in hand / the most you can hold">Hand <b>' + C.hand.length + '/' + E.MAX_HAND + '</b>' + (full ? '<i> full</i>' : '') + '</span>' +
      '<button type="button" class="dk-pile" data-pile="draw">Draw <b>' + C.draw.length + '</b></button>' +
      '<button type="button" class="dk-pile" data-pile="disc">Discard <b>' + C.disc.length + '</b></button>' +
      '<button type="button" class="dk-pile" data-pile="exh">Exhaust <b>' + C.exh.length + '</b></button>' +
      '<button type="button" class="dk-end' + (!busy && !C.hand.some(function (c) { return !E.whyNot(R, c); }) ? ' hot' : '') + '" data-act="end"' + (busy ? ' disabled' : '') + '>End turn</button></div>';
    return h;
  }

  // ---- reward ----
  function rewardHTML() {
    var R = S.R, W = R.rew;
    var h = '<div class="dk-scr"><div class="dk-title">' + (W.kind === 'boss' ? 'Boss slain' : W.kind === 'elite' ? 'Elite defeated' : 'Victory') + '</div>';
    h += '<div class="dk-rews"><div class="dk-rw got"><span class="dk-gold">$' + W.gold + '</span> gold</div>';
    if (W.relic) {
      var rl = E.RELICS[W.relic];
      h += W.relicDone ? '<div class="dk-rw got">' + relicChip(W.relic) + ' ' + esc(rl.n) + ' <span class="dk-dim">taken</span></div>'
        : '<button type="button" class="dk-rw" data-act="relic">' + relicChip(W.relic) + ' <span><b>' + esc(rl.n) + '</b><br><span class="dk-dim">' + esc(rl.d) + '</span></span></button>';
    }
    h += '</div>';
    if (W.boss && !W.bossDone) {
      h += '<div class="dk-h">Choose a boss relic</div><div class="dk-rews">';
      W.boss.forEach(function (id, i) { var rl2 = E.RELICS[id]; h += '<button type="button" class="dk-rw" data-boss="' + i + '">' + relicChip(id) + ' <span><b>' + esc(rl2.n) + '</b><br><span class="dk-dim">' + esc(rl2.d) + '</span></span></button>'; });
      h += '</div>';
    }
    if (W.cards && !W.cardDone && W.cards.length) {
      h += '<div class="dk-h">Add a card to your deck</div><div class="dk-grid">';
      W.cards.forEach(function (c, i) { h += cardHTML(c, { full: true, attr: 'data-rc="' + i + '"' }); });
      h += '</div><div class="dk-btns"><button type="button" class="dk-go alt" data-act="skip">Skip card</button><button type="button" class="dk-go alt" data-act="deck">View deck</button></div>';
    } else h += '<p class="dk-note">' + (W.cards && W.cards.length ? 'Your deck has ' + R.deck.length + ' cards.' : '') + '</p>';
    h += '<button type="button" class="dk-go" data-act="proceed">' + (W.kind === 'boss' ? 'Onward to Act ' + ROMAN[R.act + 1] : 'Continue') + '</button></div>';
    return h;
  }

  // ---- shop ----
  function shopHTML() {
    var R = S.R, SH = R.shop;
    var h = '<div class="dk-scr"><div class="dk-scrh"><pre class="dk-art2">' + esc(ART.shop) + '</pre><div><div class="dk-title">Shop</div><p class="dk-sub">"Coin for cards, friend. Coin for anything."</p></div></div>';
    h += '<div class="dk-h">Cards</div><div class="dk-grid">';
    SH.cards.forEach(function (it, i) {
      var p = E.shopPrice(R, it.p);
      h += cardHTML({ id: it.id, u: it.u }, { full: true, attr: 'data-buy="' + i + '"', price: p, poor: R.gold < p, sold: it.sold, dis: it.sold, cls: (it.sale ? 'sale ' : '') + (it.sold ? 'sold' : '') });
    });
    h += '</div><div class="dk-h">Relics</div><div class="dk-rews">';
    SH.relics.forEach(function (it, i) {
      var rl = E.RELICS[it.id], p = E.shopPrice(R, it.p);
      h += '<button type="button" class="dk-rw' + (it.sold ? ' sold' : '') + '" data-buyr="' + i + '"' + (it.sold ? ' disabled' : '') + '>' + relicChip(it.id) + ' <span><b>' + esc(rl.n) + '</b> <span class="dk-pr' + (R.gold < p ? ' poor' : '') + '">' + (it.sold ? 'sold' : '$' + p) + '</span><br><span class="dk-dim">' + esc(rl.d) + '</span></span></button>';
    });
    var rc = E.removeCost(R);
    h += '<button type="button" class="dk-rw' + (SH.removed ? ' sold' : '') + '" data-act="remove"' + (SH.removed ? ' disabled' : '') + '><span class="dk-rel r-svc">-</span> <span><b>Remove a card</b> <span class="dk-pr' + (R.gold < rc ? ' poor' : '') + '">' + (SH.removed ? 'done' : '$' + rc) + '</span><br><span class="dk-dim">Thin your deck: take one card out for good.</span></span></button></div>';
    if (SH.msg) h += '<p class="dk-note">' + esc(SH.msg) + '</p>';
    h += '<button type="button" class="dk-go" data-act="proceed">Leave shop</button></div>';
    return h;
  }

  // ---- rest ----
  function restHTML() {
    var R = S.R, RS = R.rest, amt = E.restHealAmt(R);
    var h = '<div class="dk-scr"><pre class="dk-art2 fire">' + esc(ART.rest) + '</pre><div class="dk-title">Rest site</div>';
    if (RS.done) {
      h += '<p class="dk-sub">' + (RS.did === 'heal' ? 'You sleep by the fire. Healed ' + (RS.n || 0) + ' HP.' : esc(RS.msg || 'Done.')) + '</p>';
      h += '<button type="button" class="dk-go" data-act="proceed">Continue</button></div>';
      return h;
    }
    h += '<p class="dk-sub">The fire crackles. You have time for one thing.</p><div class="dk-rews">';
    var sun = E.has(R, 'sunShard');
    h += '<button type="button" class="dk-rw big" data-act="rest-heal"' + (sun ? ' disabled' : '') + '><span class="dk-rel r-svc">z</span> <span><b>Rest</b><br><span class="dk-dim">' + (sun ? 'The Sun Shard will not let you sleep.' : 'Heal ' + Math.min(amt, R.mhp - R.hp) + ' HP (30% of max' + (E.has(R, 'pillow') ? ' + 15' : '') + ').') + '</span></span></button>';
    var canUp = R.deck.some(E.canUpgrade);
    h += '<button type="button" class="dk-rw big" data-act="rest-up"' + (canUp ? '' : ' disabled') + '><span class="dk-rel r-svc">^</span> <span><b>Smith</b><br><span class="dk-dim">' + (canUp ? 'Upgrade a card of your choice.' : 'Every card is already upgraded.') + '</span></span></button>';
    if (E.has(R, 'pipe')) h += '<button type="button" class="dk-rw big" data-act="rest-rm"><span class="dk-rel r-svc">-</span> <span><b>Toke</b><br><span class="dk-dim">Remove a card from your deck.</span></span></button>';
    h += '</div></div>';
    return h;
  }

  // ---- event ----
  function eventHTML() {
    var R = S.R, V = R.evt, ev = E.EVENTS[V.id];
    var h = '<div class="dk-scr"><pre class="dk-art2">' + esc(ev.art.join('\n')) + '</pre><div class="dk-title">' + esc(ev.n) + '</div>';
    h += '<p class="dk-story">' + esc(ev.txt) + '</p>';
    if (V.cards) {
      h += '<p class="dk-sub">' + esc(V.msg) + '</p><div class="dk-grid">';
      V.cards.forEach(function (c, i) { h += cardHTML(c, { full: true, attr: 'data-ec="' + i + '"' }); });
      h += '</div><button type="button" class="dk-go alt" data-ec="-1">Take nothing</button></div>';
      return h;
    }
    if (V.done) {
      h += '<p class="dk-result">' + esc(V.msg) + '</p><button type="button" class="dk-go" data-act="proceed">Continue</button></div>';
      return h;
    }
    h += '<div class="dk-rews">';
    E.eventOptions(R).forEach(function (o, i) {
      h += '<button type="button" class="dk-rw opt" data-opt="' + i + '"' + (o.ok ? '' : ' disabled') + '><span class="dk-on">' + (i + 1) + '</span> <span><b>' + esc(o.l) + '</b>' + (o.d ? '<br><span class="dk-dim">' + esc(o.d) + '</span>' : '') + '</span></button>';
    });
    h += '</div></div>';
    return h;
  }

  // ---- choose a card from the deck ----
  var PICK_T = { upgrade: 'Upgrade a card', remove: 'Remove a card', transform: 'Transform a card', dup: 'Duplicate a card' };
  var PICK_V = { upgrade: 'Upgrade', remove: 'Remove', transform: 'Transform', dup: 'Duplicate' };
  function pickHTML() {
    var R = S.R, P = R.pick, sel = S.pickSel;
    var h = '<div class="dk-scr"><div class="dk-title">' + PICK_T[P.kind] + '</div>';
    if (P.kind === 'remove' && P.from === 'shop') h += '<p class="dk-sub">Costs $' + P.cost + '.</p>';
    if (sel >= 0 && R.deck[sel]) {
      var c = R.deck[sel];
      h += '<div class="dk-pickc">' + cardHTML(c, { full: true }) + (P.kind === 'upgrade' ? '<span class="dk-arrow">\u2192</span>' + cardHTML({ id: c.id, u: 1 }, { full: true }) : '') + '</div>';
      h += '<div class="dk-btns"><button type="button" class="dk-go" data-act="pick-ok">' + PICK_V[P.kind] + ' ' + esc(E.cardName(c)) + '</button><button type="button" class="dk-go alt" data-act="pick-back">Back</button></div>';
    } else {
      h += '<p class="dk-sub">Tap a card.</p><div class="dk-grid deck">';
      sortedDeck(R.deck).forEach(function (o) {
        var ok = E.pickable(R, o.c);
        h += cardHTML(o.c, { full: true, attr: 'data-pk="' + o.i + '"', dis: !ok, no: !ok });
      });
      h += '</div><button type="button" class="dk-go alt" data-act="pick-cancel">' + (P.from === 'event' ? 'Never mind' : 'Cancel') + '</button>';
    }
    return h + '</div>';
  }
  var TORD = { atk: 0, skl: 1, pow: 2, sts: 3, crs: 4 };
  function sortedDeck(deck) {
    return deck.map(function (c, i) { return { c: c, i: i }; }).sort(function (a, b) {
      var da = E.cdef(a.c), db = E.cdef(b.c);
      return TORD[da.t] - TORD[db.t] || (da.n < db.n ? -1 : da.n > db.n ? 1 : 0) || b.c.u - a.c.u;
    });
  }

  // ---- treasure ----
  function treasureHTML() {
    var R = S.R, T = R.treasure;
    var h = '<div class="dk-scr"><pre class="dk-art2 gold">' + esc(T.taken ? ART.chestOpen : ART.chest) + '</pre><div class="dk-title">Treasure</div>';
    if (!T.taken) return h + '<p class="dk-sub">A chest, iron-bound and unguarded. Suspicious, but tempting.</p><button type="button" class="dk-go" data-act="open">Open the chest</button></div>';
    var rl = T.relic && E.RELICS[T.relic];
    h += '<div class="dk-rews"><div class="dk-rw got"><span class="dk-gold">$' + T.gold + '</span> gold</div>';
    if (rl) h += '<div class="dk-rw got">' + relicChip(T.relic) + ' <span><b>' + esc(rl.n) + '</b><br><span class="dk-dim">' + esc(rl.d) + '</span></span></div>';
    return h + '</div><button type="button" class="dk-go" data-act="proceed">Continue</button></div>';
  }

  // ---- end of a run ----
  function overHTML() {
    var R = S.R, res = S.result || { summary: E.summary(R), newBest: false }, sm = res.summary;
    var h = '<div class="dk-scr"><pre class="dk-art2' + (R.won ? ' gold' : '') + '">' + esc(R.won ? ART.crown : ART.grave) + '</pre>';
    h += '<div class="dk-title">' + (R.won ? 'Victory' : 'Fallen') + '</div>';
    h += '<p class="dk-sub">' + (R.won ? 'The Hollow Monarch crumbles. The crown is yours.' : 'Slain by ' + esc(R.killedBy || 'the dark') + ' on floor ' + R.floor + ' (Act ' + ROMAN[R.act] + ').') + '</p>';
    h += '<div class="dk-big">' + sm.score + '</div>' + (res.newBest ? '<div class="dk-new">NEW BEST' + (R.blind ? ' BLINDFOLD' : '') + ' SCORE</div>' : '<div class="dk-note">' + (R.blind ? 'blindfold score' : 'score') + '</div>');
    h += '<pre class="dk-tab">' +
      'floor     <b>' + R.floor + '</b>\n' +
      'enemies   <b>' + R.stats.kills + '</b>  elites <b>' + R.stats.elites + '</b>  bosses <b>' + R.stats.bosses + '</b>\n' +
      'best hit  <b>' + R.stats.maxHit + '</b>  cards played <b>' + R.stats.played + '</b>\n' +
      'deck      <b>' + R.deck.length + '</b>  relics <b>' + R.relics.length + '</b>  gold <b>' + R.gold + '</b>\n' +
      'seed      <b>' + E.seedCode(R.seed) + '</b>' + (R.daily ? '  daily ' + R.daily : '') + (R.blind ? '\nblindfold <b>score \u00d7' + E.BLIND_BONUS + '</b>' : '') + '</pre>';
    h += '<div class="dk-btns"><button type="button" class="dk-go" data-act="new">New run</button><button type="button" class="dk-go alt" data-act="home">Home</button></div>';
    return h + '<div class="dk-btns"><button type="button" class="dk-lnk" data-act="deck">Final deck</button><button type="button" class="dk-lnk" data-act="records">Records</button></div></div>';
  }

  // ================= overlay cards =================
  function showCard(k, arg) { S.card = k; S.cardArg = arg; renderCard(); }
  function closeCard() { S.card = null; renderCard(); try { S.root.focus({ preventScroll: true }); } catch (e) {} }
  function renderCard() {
    var o = S.ovl, k = S.card, R = S.R, h = '';
    if (!k) { o.style.display = 'none'; o.innerHTML = ''; S.wrap.classList.remove('dim'); return; }
    if (k === 'help') {
      h = '<div class="dk-title">How to play</div>' +
        '<p>Climb three acts. Each act is a map: pick a path from the bottom to the <b>boss</b> at the top. Beat the third boss to win.</p>' +
        '<p><b>Battles.</b> You get <b>3 energy</b> a turn. A card\u2019s cost is in its corner. Attacks deal damage, <b>Block</b> soaks damage until your next turn, Powers last the whole fight. Every enemy shows its <b>intent</b> \u2014 what it will do next \u2014 so block when an attack is coming and hit hard when it is not.</p>' +
        '<p><b>Your hand carries over.</b> Cards you don\u2019t play stay in your hand for the next turn (a small <b>\u25b4</b> marks cards you held). Each turn you draw back up to <b>5</b> cards \u2014 but always at least <b>2</b> new ones \u2014 so holding up to 3 cards is free and holding more costs fresh draws. You can hold at most <b>10</b>; past that, draws stay in your pile (\u201cHand full\u201d). <b>Ethereal</b> cards still vanish at the end of your turn, and statuses and curses are always discarded.</p>' +
        '<p><b>Hidden intents.</b> Sneaky enemies hide their plans: <b class="i-unk">?</b> means you can\u2019t tell what is coming; <b>ATK ?</b> means an attack of unknown size. <b>Changing intents:</b> some enemies change their plan on the spot when badly hurt or when you make them Weak or Vulnerable \u2014 watch for the <b>intent changed!</b> flash. <b>Scouting</b> (the Scout and Counterplay cards, the Foresight power, the Spyglass relic) reveals hidden intents (<b>\u25c9</b>).</p>' +
        '<p><b>Blindfold</b> (on the start screen) hides every enemy\u2019s intent for a whole run. Scouting still works. Blindfold runs score \u00d7' + E.BLIND_BONUS + ' and keep their own records.</p>' +
        '<p><b>Statuses.</b> <b>VUL</b>nerable: +50% damage taken. <b>WK</b> (weak): \u221225% damage dealt. <b>FRL</b> (frail): \u221225% Block. <b>PSN</b> (poison): loses HP each turn. <b>STR</b>ength / <b>DEX</b>terity add to damage / Block. Tap any status for details.</p>' +
        '<p><b>Between fights</b> you add cards, find relics (passive powers), heal or upgrade at rest sites, and buy or remove cards in shops. A lean deck draws its best cards more often.</p>' +
        '<div class="dk-keys"><span><b>Tap a card</b>, then an enemy (or tap the card again)</span><span><b>1\u20139, 0</b> pick a card \u00b7 <b>\u2190 \u2192</b> target \u00b7 <b>Enter</b> play</span><span><b>E</b> end turn \u00b7 <b>D</b> deck \u00b7 <b>Esc</b> cancel</span></div>' +
        '<p class="dk-note">Map: <b>x</b> fight, <b>!</b> elite, <b>?</b> event, <b>$</b> shop, <b>+</b> rest, <b>#</b> treasure, <b>@</b> boss. Runs save after every move; seeds make a run repeatable.</p>' +
        '<button type="button" class="dk-go" data-act="close">Got it</button>';
    } else if (k === 'pile') {
      var C = (R && (R.c || S.holdC)) || null, which = S.cardArg, cards;
      if (which === 'deck' || !C) { cards = R ? sortedDeck(R.deck).map(function (x) { return x.c; }) : []; which = 'deck'; }
      else {
        cards = C[which].slice();
        if (which === 'draw') cards = sortedDeck(cards).map(function (x) { return x.c; });
      }
      var title = { deck: 'Your deck', draw: 'Draw pile', disc: 'Discard pile', exh: 'Exhausted' }[which];
      h = '<div class="dk-title">' + title + '</div><p class="dk-sub">' + cards.length + ' cards' + (which === 'draw' ? ' (shown sorted, not in order)' : '') + '</p><div class="dk-grid deck">' +
        cards.map(function (c) { return cardHTML(c, { full: true, attr: 'tabindex="-1"' }); }).join('') + '</div><button type="button" class="dk-go" data-act="close">Close</button>';
    } else if (k === 'relics') {
      h = '<div class="dk-title">Relics</div><div class="dk-rews">' + (R ? R.relics : []).map(function (id) {
        var rl = E.RELICS[id];
        return '<div class="dk-rw got">' + relicChip(id) + ' <span><b>' + esc(rl.n) + '</b> <span class="dk-dim">' + rl.r + '</span><br><span class="dk-dim">' + esc(rl.d) + '</span></span></div>';
      }).join('') + '</div>' + (R ? '<p class="dk-note">Seed ' + E.seedCode(R.seed) + (R.daily ? ' \u00b7 daily ' + R.daily : '') + '</p>' : '') +
        '<button type="button" class="dk-go" data-act="close">Close</button>';
    } else if (k === 'records') {
      var st = S.stats;
      h = '<div class="dk-title">Records</div><pre class="dk-tab">' +
        'runs <b>' + st.runs + '</b>  wins <b>' + st.wins + '</b>  win rate <b>' + (st.runs ? Math.round(st.wins / st.runs * 100) : 0) + '%</b>\n' +
        'best score <b>' + st.bestScore + '</b>  best floor <b>' + st.bestFloor + '</b>\n' +
        'streak <b>' + st.streak + '</b>  best streak <b>' + st.bestStreak + '</b>\n' +
        'biggest hit <b>' + st.maxHit + '</b>  enemies slain <b>' + st.kills + '</b></pre>';
      var bl = st.blind;
      if (bl && bl.runs) h += '<div class="dk-h">Blindfold runs</div><pre class="dk-tab">' +
        'runs <b>' + bl.runs + '</b>  wins <b>' + bl.wins + '</b>  win rate <b>' + Math.round(bl.wins / bl.runs * 100) + '%</b>\n' +
        'best score <b>' + bl.bestScore + '</b>  best floor <b>' + bl.bestFloor + '</b>  best streak <b>' + bl.bestStreak + '</b></pre>';
      if (st.hist.length) {
        h += '<div class="dk-h">Recent runs</div><pre class="dk-tab hist">' + st.hist.slice(0, 12).map(function (x) {
          var res = x.won ? '<span class="g">WON  </span>' : 'act ' + x.act;
          return res + ' F' + pad(x.floor, 2) + ' <b>' + pad(x.score, 4) + '</b> ' + E.seedCode(x.seed) + (x.daily ? ' D' : x.blind ? ' B' : '  ') + ' <i>' + esc((x.won ? '' : x.by).slice(0, 18)) + '</i>';
        }).join('\n') + '</pre><p class="dk-note">D daily \u00b7 B blindfold. Run counts, wins and bests above are for normal runs; Blindfold keeps its own.</p>';
      } else h += '<p class="dk-note">No runs yet.</p>';
      var days = Object.keys(st.daily).sort().reverse().slice(0, 5);
      if (days.length) h += '<div class="dk-h">Daily delves</div><pre class="dk-tab">' + days.map(function (d) { var x = st.daily[d]; return d + '  <b>' + pad(x.score, 4) + '</b>  F' + x.floor + (x.won ? ' <span class="g">won</span>' : ''); }).join('\n') + '</pre>';
      h += S.resetArm ? '<div class="dk-confirm">Erase all records? <button type="button" class="dk-lnk danger" data-act="reset-yes">Erase</button> <button type="button" class="dk-lnk" data-act="reset-no">Keep</button></div>'
        : '<div class="dk-btns"><button type="button" class="dk-go" data-act="close">Close</button><button type="button" class="dk-lnk" data-act="reset">Reset records</button></div>';
    } else if (k === 'info') {
      h = S.cardArg + '<button type="button" class="dk-go" data-act="close">Close</button>';
    }
    o.innerHTML = '<div class="dk-ocard">' + h + '</div>';
    o.style.display = '';
    S.wrap.classList.add('dim');
    if (S.body) S.body.scrollTop = 0;
    var f = o.querySelector('.dk-go');
    if (f && !S.coarse) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = ' ' + n; return n; }

  function syncHead() {
    if (!S) return;
    var sb = S.head.querySelector('[data-h="sound"]');
    sb.innerHTML = S.snd.on ? IC_SND_ON : IC_SND_OFF;
    sb.classList.toggle('on', S.snd.on);
    sb.title = S.snd.on ? 'Sound on' : 'Sound off';
    sb.setAttribute('aria-label', sb.title);
    S.head.querySelector('[data-h="deck"]').disabled = !S.R || S.view === 'home';
    S.head.querySelector('[data-h="home"]').disabled = S.view === 'home';
  }

  // ================= effects =================
  function fxTarget(t) {
    if (t === 'p') return S.main.querySelector('.dk-me');
    return S.main.querySelector('.dk-foe[data-e="' + t + '"]');
  }
  function pop(el, text, cls, i) {
    if (!el) return;
    var s = document.createElement('span');
    s.className = 'dk-pop ' + (cls || '');
    s.textContent = text;
    s.style.animationDelay = (i * 0.11) + 's';
    s.style.left = (38 + ((i * 23) % 30)) + '%';
    el.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 1100 + i * 110);
  }
  function shake(el, cls) {
    if (!el || S.rm) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }
  function flash(el) {
    var it = el && el.querySelector('.dk-int');
    if (!it || S.rm) return;
    it.classList.remove('flash'); void it.offsetWidth; it.classList.add('flash');
  }
  function playFx(L) {
    if (!L || !L.length) return;
    var per = {}, snd = {}, R0 = S.R;
    L.forEach(function (x) {
      var t = x.t, el = t != null && t !== -1 ? fxTarget(t) : null, i = per[t] = (per[t] || 0) + 1;
      if (x.k === 'dmg') {
        if (x.u > 0) { pop(el, '-' + x.u, x.thorns ? 'thn' : 'dmg', i - 1); shake(el, 'hit'); snd[t === 'p' ? 'hurt' : 'hit'] = 1; }
        else { pop(el, 'blocked', 'blkd', i - 1); snd.blk = 1; }
      } else if (x.k === 'blk') { pop(el, '+' + x.n + ' blk', 'blk', i - 1); snd.blk = 1; }
      else if (x.k === 'heal' && x.n) pop(el, '+' + x.n, 'heal', i - 1);
      else if (x.k === 'hp') { pop(fxTarget('p'), '-' + x.n, 'dmg', i - 1); shake(fxTarget('p'), 'hit'); }
      else if (x.k === 'st') pop(el, (x.n > 0 ? '+' : '') + x.n + ' ' + (E.ST[x.s] ? E.ST[x.s].g : x.s), 'st', i - 1);
      else if (x.k === 'kill') { snd.kill = 1; Cade.haptic && Cade.haptic(10); }
      else if (x.k === 'move') pop(el, x.n, 'mv', 0);
      else if (x.k === 'intent') { pop(el, 'intent changed!', 'chg', 0); flash(el); snd.chg = 1; }
      else if (x.k === 'scout') { E.alive(R0.c || { e: [] }).forEach(function (en) { var fe = fxTarget(R0.c.e.indexOf(en)); if (fe && hideable(R0, en)) { pop(fe, 'revealed', 'rev', 0); flash(fe); } }); }
      else if (x.k === 'full') { pop(S.main.querySelector('.dk-hand'), 'Hand full', 'full', 0); snd.no = 1; }
      else if (x.k === 'phoenix') { pop(fxTarget('p'), 'REBORN', 'heal', 2); if (Cade.showToast) Cade.showToast('The Phoenix Feather burns away \u2014 you rise again!', 'success', 2400); }
      else if (x.k === 'play') { var d = E.CARDS[x.id]; snd[d.t === 'atk' ? 'atk' : d.t === 'pow' ? 'pow' : 'skl'] = 1; }
    });
    ['atk', 'skl', 'pow', 'hit', 'blk', 'hurt', 'kill', 'chg', 'no'].forEach(function (k) { if (snd[k]) sfx(k); });
    if (snd.hurt) Cade.haptic && Cade.haptic(15);
  }

  // ================= actions =================
  // run an engine call in a fight, then redraw and replay what happened
  function cmb(fn) {
    var R = S.R, C = R.c;
    var res = fn();
    var L = C ? C.log.splice(0) : [];
    if (R.phase !== 'combat' && C) {
      // the fight just ended: keep showing it for a moment so the last blow lands
      S.holdC = C; S.sel = -1;
      clearTimeout(S.holdT);
      var won = R.phase !== 'over' || R.won;
      S.holdT = setTimeout(function () {
        if (!S) return;
        S.holdC = null; S.hint = '';
        if (R.over) finishRun(); else { sfx('coin'); }
        render();
      }, won ? 750 : 1200);
      if (won) setTimeout(function () { sfx('win'); }, 250); else sfx('lose');
    }
    render();
    playFx(L);
    saveRun();
    return res;
  }
  function selectCard(i) {
    var R = S.R, C = R.c;
    if (!C || C.phase !== 'player' || S.busy || S.holdC) return;
    var c = C.hand[i];
    if (!c) return;
    S.hint = '';
    if (S.sel === i) { playSel(S.tgt); return; }
    S.sel = i;
    var why = E.whyNot(R, c);
    if (why) sfx('no'); else sfx('tap');
    render();
  }
  function playSel(ti) {
    var R = S.R, C = R.c, i = S.sel;
    if (!C || i < 0 || !C.hand[i]) return;
    var why = E.whyNot(R, C.hand[i]);
    if (why) {
      sfx('no');
      var el = S.main.querySelector('.dk-card[data-h="' + i + '"]');
      shake(el, 'nope');
      return;
    }
    S.sel = -1; S.hint = '';
    cmb(function () { return E.playCard(R, i, ti); });
  }
  function tapFoe(i) {
    var R = S.R, C = R.c;
    if (!C || S.holdC) return;
    var e = C.e[i];
    if (!e || e.dead) return;
    var selC = S.sel >= 0 ? C.hand[S.sel] : null;
    if (selC && E.cdef(selC).tg === 'e' && C.phase === 'player' && !S.busy) { S.tgt = i; playSel(i); return; }
    S.tgt = i;
    // tell what it is and what it will do
    var d = E.ENEMIES[e.id], o = E.intentOf(R, e), mv = o && !o.hide ? d.m[e.mv] : null;
    var parts = [];
    if (o && o.hide === 'amount') {
      if (o.atk) parts.push('attack for ? damage');
      if (o.def) parts.push('block');
      if (o.buf) parts.push('buff itself');
      if (o.dbf) parts.push(o.add ? 'curse your deck' : 'weaken you');
      if (o.heal) parts.push('heal');
    }
    if (mv) mv.a.forEach(function (a) {
      if (a[0] === 'atk') parts.push('attack ' + o.dmg + (o.hits > 1 ? ' \u00d7' + o.hits : ''));
      else if (a[0] === 'blk') parts.push('block ' + a[1]);
      else if (a[0] === 'blkAll') parts.push('block ' + a[1] + ' for all');
      else if (a[0] === 'st') parts.push((a[2] > 0 ? 'gain ' : 'lose ') + Math.abs(a[2]) + ' ' + E.ST[a[1]].n);
      else if (a[0] === 'pst') parts.push('give you ' + a[2] + ' ' + E.ST[a[1]].n);
      else if (a[0] === 'heal') parts.push('heal ' + a[1]);
      else if (a[0] === 'add') parts.push('shuffle ' + a[2] + ' ' + E.CARDS[a[1]].n + ' into your deck');
    });
    var sts = Object.keys(e.st).filter(function (k) { return E.ST[k] && e.st[k] && k !== 'turnStr'; }).map(function (k) { return E.ST[k].g + ' ' + e.st[k] + ': ' + E.ST[k].d; });
    var what = !o ? '' : o.hide === 'all' ? 'hides its intent (<b>?</b>). <span class="dk-dim">Scout to reveal it.</span>' : o.hide === 'amount' ? 'will ' + esc(parts.join(', ')) + '. <span class="dk-dim">The numbers are hidden: scout to reveal them.</span>'
      : 'will <b>' + esc(mv.n) + '</b>: ' + esc(parts.join(', ')) + '.' + (o.chg ? ' <span class="dk-dim">(it changed its plan)</span>' : '');
    var re = d.react, tell = re ? (re.low != null ? ' It changes plans when badly hurt.' : '') + (re.dbf != null ? ' It reacts to Weak / Vulnerable.' : '') : '';
    S.hint = '<b>' + esc(d.n) + '</b> ' + what + (tell ? ' <span class="dk-dim">' + tell + '</span>' : '') + (sts.length ? ' <span class="dk-dim">' + esc(sts.join(' ')) + '</span>' : '');
    sfx('tap');
    render();
  }
  function uiEndTurn() {
    var R = S.R, C = R.c;
    if (!C || C.phase !== 'player' || S.busy || S.holdC) return;
    S.sel = -1; S.hint = '';
    cmb(function () { return E.endTurn(R); });
    if (R.phase === 'combat' && R.c && R.c.phase === 'enemy') runEnemies();
  }
  function runEnemies() {
    S.busy = true;
    var R = S.R;
    function step() {
      if (!S || S.R !== R) return;
      // hold the enemy turn while the panel is minimised or the tab is hidden
      if ((Cade.isMinimized && Cade.isMinimized(S.panel)) || document.hidden) { S.timer = setTimeout(step, 400); return; }
      if (R.phase !== 'combat' || !R.c || R.c.phase !== 'enemy') { S.busy = false; render(); return; }
      var more = cmb(function () { return E.enemyStep(R); });
      if (more) S.timer = setTimeout(step, S.rm ? 220 : 520);
      else { S.busy = false; if (R.phase === 'combat') { render(); } }
    }
    clearTimeout(S.timer);
    S.timer = setTimeout(step, S.rm ? 150 : 380);
  }
  function finishRun() {
    var R = S.R;
    if (!R || !R.over || S.recorded === R) return;
    S.recorded = R;
    S.result = E.recordRun(S.stats, R, Date.now());
    saveStats();
    sdel(RUN_KEY);
  }
  function startRun(seed, daily) {
    var blind = !daily && !!S.blind;
    if (S.R && !S.R.over && S.recorded !== S.R && S.R.floor > 0) { S.R.killedBy = 'abandoned'; S.R.over = true; finishRun(); }
    else if (S.R && S.R.over && S.recorded !== S.R) finishRun();
    clearTimeout(S.timer); clearTimeout(S.holdT);
    S.R = E.newRun(seed, { daily: daily || '', blind: blind, now: Date.now() });
    S.result = null; S.recorded = null; S.holdC = null; S.busy = false; S.sel = -1; S.hint = ''; S.confirmNew = false; S.view = 'run';
    saveRun();
    sfx('step');
    render();
    if (!sget(SEEN_KEY)) { sset(SEEN_KEY, '1'); showCard('help'); }
  }
  function toHome() {
    clearTimeout(S.timer); S.busy = false;
    if (S.R && S.R.over) finishRun();
    if (S.R && S.R.phase === 'combat' && S.R.c && S.R.c.phase === 'enemy') { /* resumes on continue */ }
    S.view = 'home'; S.card = null; S.confirmNew = false;
    render();
  }
  function cont() {
    if (!S.R || S.R.over) return;
    S.view = 'run'; S.sel = -1; S.hint = '';
    render();
    if (S.R.phase === 'combat' && S.R.c.phase === 'enemy') runEnemies();
  }
  function afterMove() { saveRun(); render(); }

  function onMainClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button, [data-st]') : null;
    if (!b || !S.main.contains(b) || b.disabled) return;
    S.snd.ensure();
    var R = S.R, a = b.getAttribute('data-act');
    if (b.hasAttribute('data-st')) {
      var foe = b.closest('.dk-foe'), k = b.getAttribute('data-st'), d = E.ST[k];
      if (foe) b = foe;
      else if (d && R && R.c) { S.hint = '<b>' + d.n + '</b> <span class="dk-dim">' + esc(d.d) + '</span>'; render(); return; }
      else return;
    }
    if (b.hasAttribute('data-h')) { selectCard(+b.getAttribute('data-h')); return; }
    if (b.hasAttribute('data-e')) { tapFoe(+b.getAttribute('data-e')); return; }
    if (b.hasAttribute('data-pile')) { showCard('pile', b.getAttribute('data-pile')); return; }
    if (b.hasAttribute('data-node')) {
      var n = +b.getAttribute('data-node');
      if (R && E.chooseNode(R, n)) { sfx('step'); S.sel = -1; S.hint = ''; S.pickSel = -1; afterMove(); if (R.phase === 'treasure' || R.phase === 'shop') sfx('coin'); }
      else sfx('no');
      return;
    }
    if (b.hasAttribute('data-rc')) { if (E.takeCard(R, +b.getAttribute('data-rc'))) { sfx('pow'); afterMove(); } return; }
    if (b.hasAttribute('data-boss')) { if (E.takeBossRelic(R, +b.getAttribute('data-boss'))) { sfx('win'); afterMove(); } return; }
    if (b.hasAttribute('data-buy')) {
      var i = +b.getAttribute('data-buy');
      if (E.buyCard(R, i)) { sfx('coin'); afterMove(); } else { sfx('no'); if (Cade.showToast && R.shop.cards[i] && !R.shop.cards[i].sold) Cade.showToast('Not enough gold', 'info', 1400); }
      return;
    }
    if (b.hasAttribute('data-buyr')) {
      if (E.buyRelic(R, +b.getAttribute('data-buyr'))) { sfx('coin'); afterMove(); } else { sfx('no'); Cade.showToast && Cade.showToast('Not enough gold', 'info', 1400); }
      return;
    }
    if (b.hasAttribute('data-opt')) { if (E.eventChoose(R, +b.getAttribute('data-opt'))) { sfx('step'); S.pickSel = -1; afterMove(); } return; }
    if (b.hasAttribute('data-ec')) { E.eventTakeCard(R, +b.getAttribute('data-ec')); sfx('pow'); afterMove(); return; }
    if (b.hasAttribute('data-pk')) { S.pickSel = +b.getAttribute('data-pk'); sfx('tap'); render(); return; }
    switch (a) {
      case 'continue': cont(); break;
      case 'new':
        if (S.R && !S.R.over && S.view === 'home' && S.R.floor > 0) { S.confirmNew = 'new'; render(); break; }
        startRun((Math.random() * 4294967296) >>> 0); break;
      case 'new-yes': {
        var what = S.confirmNew;
        S.confirmNew = false;
        if (what === 'daily') startRun(E.dailySeed(E.dateKey()), E.dateKey());
        else if (typeof what === 'number') startRun(what);
        else startRun((Math.random() * 4294967296) >>> 0);
        break;
      }
      case 'new-no': S.confirmNew = false; render(); break;
      case 'daily': {
        var dk = E.dateKey();
        if (S.R && !S.R.over && S.R.daily === dk) { cont(); break; }
        if (S.R && !S.R.over && S.R.floor > 0) { S.confirmNew = 'daily'; render(); break; }
        startRun(E.dailySeed(dk), dk); break;
      }
      case 'seed': {
        var inp = S.main.querySelector('.dk-in'), sd = E.parseSeed(inp && inp.value);
        if (sd == null) { sfx('no'); if (inp) { inp.focus(); shake(inp, 'nope'); } break; }
        if (S.R && !S.R.over && S.R.floor > 0) { S.confirmNew = sd; render(); break; }
        startRun(sd); break;
      }
      case 'blind': S.blind = !S.blind; sset(BLIND_KEY, S.blind ? '1' : '0'); sfx('tap'); render(); break;
      case 'records': S.resetArm = false; showCard('records'); break;
      case 'help': showCard('help'); break;
      case 'home': toHome(); break;
      case 'deck': showCard('pile', 'deck'); break;
      case 'relics': showCard('relics'); break;
      case 'end': uiEndTurn(); break;
      case 'relic': if (E.takeRewardRelic(R)) { sfx('pow'); afterMove(); } break;
      case 'skip': E.skipCards(R); afterMove(); break;
      case 'proceed': {
        var boss = R.phase === 'reward' && R.rew && R.rew.kind === 'boss';
        if (E.proceed(R)) { sfx('step'); S.pickSel = -1; afterMove(); if (boss && Cade.showToast) Cade.showToast('Act ' + ROMAN[R.act] + ': ' + E.ACT_NAMES[R.act - 1] + ' \u2014 fully healed', 'success', 2600); }
        break;
      }
      case 'open': if (E.takeTreasure(R)) { sfx('coin'); afterMove(); } break;
      case 'rest-heal': if (E.restHeal(R)) { sfx('pow'); afterMove(); } break;
      case 'rest-up': if (E.restUpgrade(R)) { S.pickSel = -1; afterMove(); } break;
      case 'rest-rm': if (E.restRemove(R)) { S.pickSel = -1; afterMove(); } break;
      case 'remove': if (E.buyRemove(R)) { S.pickSel = -1; afterMove(); } else { sfx('no'); Cade.showToast && Cade.showToast('Not enough gold', 'info', 1400); } break;
      case 'pick-ok': if (S.pickSel >= 0 && E.pickCard(R, S.pickSel)) { sfx(R.pick ? 'tap' : 'pow'); S.pickSel = -1; afterMove(); } break;
      case 'pick-back': S.pickSel = -1; render(); break;
      case 'pick-cancel': E.cancelPick(R); S.pickSel = -1; afterMove(); break;
    }
  }
  function onOvlClick(e) {
    if (!S) return;
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    var a = b.getAttribute('data-act');
    if (a === 'close') closeCard();
    else if (a === 'reset') { S.resetArm = true; renderCard(); }
    else if (a === 'reset-no') { S.resetArm = false; renderCard(); }
    else if (a === 'reset-yes') { S.resetArm = false; S.stats = E.newStats(); saveStats(); renderCard(); render(); Cade.showToast && Cade.showToast('Records erased', 'info', 1600); }
  }

  // ================= keys =================
  function onKey(e) {
    if (!S || (Cade.isMinimized && Cade.isMinimized(S.panel))) return;
    var t = e.target, k = e.key;
    if (!t || !(S.panel.contains(t) || t === document.body || t === document.documentElement)) return;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
      if (k === 'Enter' && t.classList && t.classList.contains('dk-in')) { e.preventDefault(); var b = S.main.querySelector('[data-act="seed"]'); if (b) b.click(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (S.card) { if (k === 'Escape') { e.preventDefault(); closeCard(); } return; }
    var R = S.R;
    if (k === '?' || (k === 'h' && S.view === 'home')) { e.preventDefault(); showCard('help'); return; }
    if (!R || S.view === 'home') return;
    if ((k === 'd' || k === 'D') && R) { e.preventDefault(); showCard('pile', 'deck'); return; }
    if (R.phase === 'combat' && !S.holdC) {
      var C = R.c;
      if (/^[0-9]$/.test(k)) {
        e.preventDefault();
        var i = k === '0' ? 9 : +k - 1;
        if (C.hand[i]) { if (S.sel === i) playSel(S.tgt); else selectCard(i); }
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        var al = C.e.map(function (x, j) { return x.dead ? -1 : j; }).filter(function (j) { return j >= 0; });
        if (!al.length) return;
        var p = al.indexOf(S.tgt);
        S.tgt = al[(p + (k === 'ArrowLeft' ? -1 : 1) + al.length) % al.length];
        S.hint = '';
        render();
        return;
      }
      if ((k === 'Enter' || k === ' ') && S.sel >= 0) { e.preventDefault(); playSel(S.tgt); return; }
      if (k === 'e' || k === 'E') { e.preventDefault(); uiEndTurn(); return; }
      if (k === 'Escape' && (S.sel >= 0 || S.hint)) { e.preventDefault(); S.sel = -1; S.hint = ''; render(); return; }
      return;
    }
    if (R.phase === 'map' && /^[1-9]$/.test(k)) {
      var nx = E.nextNodes(R), n = nx[+k - 1];
      if (n != null) { e.preventDefault(); var nb = S.main.querySelector('[data-node="' + n + '"]'); if (nb) nb.click(); }
      return;
    }
    if (R.phase === 'event' && /^[1-9]$/.test(k)) {
      var ob = S.main.querySelector('[data-opt="' + (+k - 1) + '"]');
      if (ob && !ob.disabled) { e.preventDefault(); ob.click(); }
    }
  }

  // ================= open / close =================
  function teardown() {
    if (!S) return;
    var s = S; S = null;
    clearTimeout(s.timer); clearTimeout(s.holdT);
    if (s.R && s.R.over && s.recorded !== s.R) { try { s.recorded = s.R; s.stats && E.recordRun(s.stats, s.R, Date.now()); sset(STATS_KEY, JSON.stringify(s.stats)); sdel(RUN_KEY); } catch (e) {} }
    else if (s.R && !s.R.over) { try { sset(RUN_KEY, JSON.stringify(s.R)); } catch (e) {} }
    document.removeEventListener('keydown', s.onKey);
    window.removeEventListener('resize', s.onResize);
    if (s.themeObs) s.themeObs.disconnect();
    s.snd.close();
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    teardown();
    if (p) p.remove();
  }
  function open() {
    if (Cade.closeAllMenus) Cade.closeAllMenus();
    var ex = document.getElementById(PANEL_ID);
    if (ex) {
      if (Cade.isMinimized && Cade.isMinimized(ex) && Cade.restorePanel) { Cade.restorePanel(ex); return; }
      closePanel();
      return;
    }
    var body = '<div class="dk" tabindex="-1"><div class="dk-wrap"><div class="dk-top"></div><div class="dk-main"></div></div><div class="dk-ovl" style="display:none"></div></div>';
    var p = Cade.mkPanel(PANEL_ID, '\ud83d\udde1\ufe0f Deck Delve', body);
    var head = p.querySelector('.cade-panel-head'), hb = document.createElement('div');
    hb.className = 'dk-hb';
    hb.innerHTML = '<button type="button" data-h="home" title="Home (the run is saved)" aria-label="Home">' + IC_HOME + '</button>' +
      '<button type="button" data-h="deck" title="Your deck (D)" aria-label="Your deck">' + IC_DECK + '</button>' +
      '<button type="button" data-h="help" title="How to play" aria-label="How to play">' + IC_HELP + '</button><button type="button" data-h="sound"></button>';
    if (head) head.insertBefore(hb, p.querySelector('.cade-panel-minbtn') || p.querySelector('.cade-panel-x'));
    var mm = window.matchMedia, saved = E.normRun(jget(RUN_KEY));
    if (!saved && sget(RUN_KEY)) sdel(RUN_KEY);
    S = {
      panel: p, head: hb, root: p.querySelector('.dk'), wrap: p.querySelector('.dk-wrap'), top: p.querySelector('.dk-top'), main: p.querySelector('.dk-main'),
      ovl: p.querySelector('.dk-ovl'), body: p.querySelector('.cade-panel-body'),
      R: saved, stats: E.normStats(jget(STATS_KEY)), snd: new Snd(sget(SOUND_KEY) === '1'), blind: sget(BLIND_KEY) === '1',
      coarse: !!(mm && mm('(pointer: coarse)').matches), rm: !!(mm && mm('(prefers-reduced-motion: reduce)').matches),
      view: 'home', sel: -1, tgt: 0, hint: '', busy: false, timer: 0, holdC: null, holdT: 0, card: null, cardArg: null, pickSel: -1,
      result: null, recorded: null, confirmNew: false, resetArm: false, lastKind: ''
    };
    p._onClose = teardown;
    S.onKey = onKey;
    document.addEventListener('keydown', S.onKey);
    S.onResize = function () { if (S) S.coarse = !!(mm && mm('(pointer: coarse)').matches); };
    window.addEventListener('resize', S.onResize);
    p.addEventListener('cade-panel-minimize', function () { if (S && S.panel === p) saveRun(); });
    try {
      S.themeObs = new MutationObserver(function () { if (S && !(Cade.isMinimized && Cade.isMinimized(S.panel))) render(); });
      S.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}

    hb.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    hb.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !S || b.disabled) return;
      var h = b.getAttribute('data-h');
      if (h === 'sound') {
        S.snd.on = !S.snd.on;
        sset(SOUND_KEY, S.snd.on ? '1' : '0');
        S.snd.ensure(); S.snd.tone(880, 0.07, 'sine', 0.04);
        syncHead();
      } else if (h === 'help') { if (S.card === 'help') closeCard(); else showCard('help'); }
      else if (h === 'deck') { if (S.card === 'pile') closeCard(); else if (S.R) showCard('pile', 'deck'); }
      else if (h === 'home') toHome();
      try { b.blur(); } catch (er) {}
    });
    S.main.addEventListener('click', onMainClick);
    S.top.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="relics"]') : null;
      if (b && S) showCard('relics');
    });
    S.ovl.addEventListener('click', onOvlClick);

    // Fast taps must never zoom, select, magnify or open a callout: the hand and
    // the enemies are play surfaces (no browser gestures; a tap is a click), the
    // panel swallows double-tap / pinch gestures. The seed field stays a real input.
    function noTouch(ev) { if (ev.cancelable) ev.preventDefault(); }
    ['gesturestart', 'gesturechange', 'dblclick'].forEach(function (t) { p.addEventListener(t, noTouch, { passive: false }); });
    S.main.addEventListener('touchstart', function (ev) {
      if (ev.touches.length > 1 && ev.cancelable) ev.preventDefault();
    }, { passive: false });
    S.main.addEventListener('touchend', function (ev) {
      if (!ev.cancelable || ev.touches.length) return;
      var b = ev.target.closest ? ev.target.closest('.dk-hand button, .dk-foes button, .dk-bar2 button, .dk-me') : null;
      if (!b || !S.main.contains(b)) return;
      ev.preventDefault();
      if (b.classList.contains('dk-me')) { var st = ev.target.closest('[data-st]'); if (st) st.click(); return; }
      if (!b.disabled) b.click();
    }, { passive: false });
    S.main.addEventListener('contextmenu', function (ev) { if (ev.target.closest && ev.target.closest('.dk-hand, .dk-foes, .dk-map')) ev.preventDefault(); });

    if (S.R && S.R.over) { S.R = null; sdel(RUN_KEY); }
    render();
    try { S.root.focus({ preventScroll: true }); } catch (e) {}
  }

  Cade.registerWidget({
    name: NAME,
    description: 'A card-battling roguelite \u2014 build a deck, hold cards between turns, read (or scout) hidden enemy intents, climb three acts; seeded runs, daily delve, Blindfold mode, saves mid-run',
    icon: '\ud83d\udde1\ufe0f',
    tags: 'game,cards,roguelite,deckbuilder,strategy,dungeon,relics,daily,seed,turn based,solo,ascii,blindfold,intents',
    open: open,
    _engine: ENGINE
  });
})();
