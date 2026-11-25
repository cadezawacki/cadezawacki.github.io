/* Deepdelve — the pure game engine for the Dungeon Crawler widget.
 *
 * No DOM, no timers, no globals beyond the export: heroes, stats, items,
 * dungeon generation (rooms + puzzle templates, proven connected), field of
 * view, pathfinding, turn-based combat on an energy clock, statuses, monster
 * AI with telegraphed attacks, multi-phase bosses, events, bounties, the town's
 * services, save normalization, legacy-save migration and roster merging.
 *
 * Everything random flows from a seeded mulberry32 state kept on the run
 * (G.r.s), so a run serializes to plain JSON and replays deterministically.
 * The UI calls E.act(G, action) and then drains G.ev (events to animate).
 *
 * Browser: window.__cadeCrawlerEngine (needs window.__cadeCrawlerData first).
 * Node: module.exports (requires ./crawler-data.js) — see crawler.test.js.
 */
(function (root, factory) {
  var isNode = typeof module !== 'undefined' && module.exports;
  var D = isNode ? require('./crawler-data.js') : root.__cadeCrawlerData;
  var E = factory(D);
  if (isNode) module.exports = E; else root.__cadeCrawlerEngine = E;
})(typeof window !== 'undefined' ? window : this, function (D) {
  'use strict';

  // ===========================================================================
  //  constants
  // ===========================================================================
  var MW = 42, MH = 32;
  var T = { WALL: 0, FLOOR: 1, DOOR: 2, ODOOR: 3, STAIRS: 4, WATER: 5, DEEP: 6, LAVA: 7, CHASM: 8, GATE: 9, CRACK: 10, FUNGUS: 11, PORTAL: 12, OGATE: 13 };
  var WALKABLE = [0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1, 1];
  var OPAQUE = [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0];
  var DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  var DIRS8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  var SAVE_V = 5;
  var BAG_MAX = 24, STASH_MAX = 40, LEVEL_CAP = 40, ROSTER_MAX = 4;
  var C = D.CLASSES, AB = D.ABILITIES, MON = D.MONSTERS;

  // ===========================================================================
  //  tiny utils + seeded rng (state lives in a plain object so it serializes)
  // ===========================================================================
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function manh(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
  function sgn(n) { return n < 0 ? -1 : n > 0 ? 1 : 0; }
  function hashStr(s) {
    s = String(s); var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) { return { s: (seed >>> 0) || 1 }; }
  function rf(r) {
    var a = r.s = (r.s + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(r, n) { return Math.floor(rf(r) * n); }
  function rr(r, a, b) { return a + ri(r, b - a + 1); }
  function chance(r, p) { return rf(r) < p; }
  function pick(r, a) { return a[ri(r, a.length)]; }
  function wpick(r, items, wf) {
    var tot = 0, i;
    for (i = 0; i < items.length; i++) tot += Math.max(0, wf(items[i]));
    var x = rf(r) * tot;
    for (i = 0; i < items.length; i++) { x -= Math.max(0, wf(items[i])); if (x < 0) return items[i]; }
    return items[items.length - 1];
  }
  function shuffle(r, a) { for (var i = a.length - 1; i > 0; i--) { var j = ri(r, i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function uid(r) { return 'i' + (ri(r, 2176782336)).toString(36) + (ri(r, 46656)).toString(36); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function fmtPct(v) { return Math.round(v * 100) + '%'; }
  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ===========================================================================
  //  story progression helpers
  // ===========================================================================
  function biomeAt(depth) {
    if (depth <= D.STORY_FLOORS) return D.BIOME_ORDER[clamp(Math.ceil(depth / D.ACT_FLOORS), 1, 5) - 1];
    return D.BIOME_ORDER[Math.floor((depth - D.STORY_FLOORS - 1) / D.ACT_FLOORS) % 5];
  }
  function actAt(depth) { return clamp(Math.ceil(depth / D.ACT_FLOORS), 1, 99); }
  function isBossFloor(depth) { return depth % D.ACT_FLOORS === 0; }
  function difficulty(h) { return D.DIFFICULTIES[h && h.difficulty] || D.DIFFICULTIES.normal; }

  // ===========================================================================
  //  heroes
  // ===========================================================================
  function xpForLevel(l) { return Math.round(16 * Math.pow(l, 1.72) + 12); }
  function newHero(cls, name, diff, r) {
    r = r || rng(Date.now());
    var c = C[cls] || C.warrior;
    var h = {
      v: SAVE_V, id: 'h' + uid(r), name: cleanName(name), cls: C[cls] ? cls : 'warrior', level: 1, xp: 0,
      difficulty: D.DIFFICULTIES[diff] ? diff : 'normal', hp: 1, res: c.res.start, gold: 40,
      equip: { weapon: null, armor: null, helm: null, charm: null }, bag: [], cons: {}, mats: { scrap: 0, dust: 0, soul: 0 },
      talents: [null, null, null, null, null],
      story: { cleared: 0, ng: 0, ended: false, deepest: 0, waypoints: [1], endless: 0, seen: {} },
      lore: [], bestiary: {}, quests: { board: [], boardSeed: ri(r, 1e9), side: {}, done: 0 },
      bless: [], flags: {}, town: { visit: 0 },
      stats: { kills: 0, deaths: 0, floors: 0, bosses: 0, elites: 0, gold: 0, puzzles: 0, events: 0, runs: 0, turns: 0 },
      created: Date.now(), updated: Date.now(), rev: 1
    };
    var k = c.kit;
    h.equip.weapon = makeItem(r, { base: k.weapon, ilvl: 1, rarity: 'common' });
    h.equip.armor = makeItem(r, { base: k.armor, ilvl: 1, rarity: 'common' });
    for (var id in k.cons) h.cons[id] = k.cons[id];
    h.hp = stats(h).maxHp;
    rollBoard(h);
    return h;
  }
  function cleanName(n) {
    n = String(n == null ? '' : n).replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
    return n || 'Delver';
  }
  function randomName(r) { return pick(r, D.NAMES) + (chance(r, 0.35) ? ' ' + pick(r, D.EPITHETS) : ''); }
  function abilitiesFor(h) {
    var c = C[h.cls]; var out = [];
    for (var i = 0; i < c.abilities.length; i++) out.push({ id: c.abilities[i], lvl: D.ABILITY_LEVELS[i], known: h.level >= D.ABILITY_LEVELS[i] });
    return out;
  }
  function talentFlags(h) {
    var f = {}, tl = D.TALENTS[h.cls] || [];
    for (var i = 0; i < tl.length; i++) {
      var pickId = h.talents && h.talents[i]; if (!pickId) continue;
      for (var j = 0; j < tl[i].length; j++) if (tl[i][j].id === pickId) f[pickId] = tl[i][j];
    }
    return f;
  }
  function hasTalentFlag(h, flag) {
    var f = talentFlags(h);
    for (var k in f) if (f[k].flag === flag) return true;
    return false;
  }
  function talentPoints(h) {
    var n = 0; for (var i = 0; i < D.TALENT_LEVELS.length; i++) if (h.level >= D.TALENT_LEVELS[i] && !(h.talents && h.talents[i])) n++;
    return n;
  }
  function chooseTalent(h, tier, id) {
    if (tier < 0 || tier >= D.TALENT_LEVELS.length) return false;
    if (h.level < D.TALENT_LEVELS[tier] || h.talents[tier]) return false;
    var opts = D.TALENTS[h.cls][tier];
    for (var i = 0; i < opts.length; i++) if (opts[i].id === id) { h.talents[tier] = id; return true; }
    return false;
  }

  // ---- derived stats ---------------------------------------------------------
  var STAT_KEYS = ['maxHp', 'pow', 'arm', 'crit', 'critDmg', 'dodge', 'block', 'lifesteal', 'regen', 'maxRes', 'resRegen', 'thorns', 'burnOnHit', 'poisonOnHit', 'stunOnHit', 'freezeOnHit',
    'goldFind', 'magicFind', 'abilPct', 'light', 'resist', 'elite', 'potionPct', 'range', 'resKill', 'hpPct', 'powPct', 'armPct', 'resPct', 'eliteFind', 'doom'];
  function addMods(s, mods, mult) {
    mult = mult == null ? 1 : mult;
    for (var k in mods) {
      if (k === 'hp') s.maxHp += mods[k] * mult;
      else if (k === 'res') s.maxRes += mods[k] * mult;
      else if (k === 'regen' && mods[k] <= -99) s.noRegen = true;
      else if (s[k] != null) s[k] += mods[k] * mult;
    }
  }
  function setCounts(h) {
    var n = {};
    D.SLOTS.forEach(function (sl) { var it = h.equip && h.equip[sl]; if (it && it.set) n[it.set] = (n[it.set] || 0) + 1; });
    return n;
  }
  // stats(hero, G?) — everything combat reads. G adds run-time buffs.
  function stats(h, G) {
    var c = C[h.cls] || C.warrior, L = h.level, s = { flags: {} };
    STAT_KEYS.forEach(function (k) { s[k] = 0; });
    s.maxHp = c.base.hp + c.grow.hp * (L - 1);
    s.pow = c.base.pow + c.grow.pow * (L - 1);
    s.arm = c.base.arm + c.grow.arm * (L - 1);
    s.crit = c.base.crit; s.dodge = c.base.dodge; s.critDmg = 0.5;
    s.maxRes = c.res.max + (c.grow.res || 0) * (L - 1);
    s.resRegen = c.res.regen; s.resKill = c.res.kill || 0;
    D.SLOTS.forEach(function (sl) {
      var it = h.equip && h.equip[sl]; if (!it) return;
      var st = itemStats(it);
      addMods(s, st);
      if (it.uq && D.UNIQUES[it.uq]) s.flags[D.UNIQUES[it.uq].flag] = 1;
    });
    var sc = setCounts(h);
    for (var sid in sc) {
      var S = D.SETS[sid]; if (!S) continue;
      if (sc[sid] >= 2) addMods(s, S.b2.mods || {});
      if (sc[sid] >= 3 && S.b3.flag) s.flags[S.b3.flag] = 1;
    }
    var tf = talentFlags(h);
    for (var tid in tf) { var t = tf[tid]; if (t.mods) addMods(s, t.mods); if (t.flag) s.flags[t.flag] = 1; }
    (h.bless || []).forEach(function (b) { var B = D.BLESSINGS[b.id]; if (B) addMods(s, B.mods); });
    if (G && G.daily && G.daily.mod === 'dark') s.light -= 2;
    if (G && G.daily && G.daily.mod === 'frail') s.potionPct -= 0.5;
    if (s.flags.u_ironwall) s.armPct += 0.3;
    if (G && G.p) {
      if (G.p.st.ramp) s.powPct += 0.06 * G.p.st.ramp.n;
      if (G.p.harvest) s.powPct += Math.min(0.3, 0.02 * G.p.harvest);
      if (s.flags.bonearmor) s.arm += 4 * G.mons.filter(function (m) { return m.ally && m.owner === 'p'; }).length;
      if (G.p.st.dodgeBuff) s.dodge += G.p.st.dodgeBuff.v;
    }
    s.maxHp = Math.round(s.maxHp * (1 + s.hpPct));
    s.pow = s.pow * (1 + s.powPct);
    s.arm = Math.max(0, s.arm * (1 + s.armPct));
    s.maxRes = Math.round(s.maxRes * (1 + s.resPct));
    s.crit = clamp(s.crit, 0, 0.75); s.dodge = clamp(s.dodge, 0, 0.6); s.block = clamp(s.block, 0, 0.4);
    s.lifesteal = clamp(s.lifesteal, 0, 0.3); s.resist = clamp(s.resist, 0, 0.7);
    s.light = clamp(s.light, -4, 4);
    return s;
  }
  function gainXp(G, h, n) {
    if (h.level >= LEVEL_CAP) return 0;
    h.xp += Math.round(n);
    var ups = 0;
    while (h.level < LEVEL_CAP && h.xp >= xpForLevel(h.level)) {
      h.xp -= xpForLevel(h.level); h.level++; ups++;
      var s = stats(h, G);
      if (G && G.p) { G.p.hp = s.maxHp; G.p.res = Math.max(G.p.res, Math.round(s.maxRes * 0.5)); }
      else h.hp = s.maxHp;
      if (G) {
        emit(G, { t: 'level', lvl: h.level });
        log(G, 'Level ' + h.level + '! You feel stronger.', 'up');
        var ab = abilitiesFor(h).filter(function (a) { return a.lvl === h.level; });
        ab.forEach(function (a) { log(G, 'New ability: ' + AB[a.id].name + '!', 'up'); });
        if (D.TALENT_LEVELS.indexOf(h.level) >= 0) log(G, 'A talent point awaits — open your character sheet (C).', 'up');
      }
    }
    if (h.level >= LEVEL_CAP) h.xp = 0;
    return ups;
  }

  // ===========================================================================
  //  items
  // ===========================================================================
  function tierOf(ilvl) { return clamp(Math.floor((ilvl - 1) / 6), 0, 5); }
  function affixValue(a, ilvl, r) {
    if (a.pct) return Math.round((a.pct[0] + rf(r) * (a.pct[1] - a.pct[0])) * (1 + Math.min(ilvl, 60) * 0.012) * 1000) / 1000;
    var v = a.v[0] + a.v[1] * ilvl; v = v * (0.75 + rf(r) * 0.5);
    if (a.max) v = Math.min(a.max, Math.max(1, Math.round(v)));
    return Math.max(1, Math.round(v));
  }
  function rollRarity(r, luck, minR) {
    var order = ['common', 'magic', 'rare', 'epic', 'legendary', 'set'];
    var w = order.map(function (k) { var x = D.RARITIES[k].w; if (k !== 'common' && k !== 'magic') x *= (1 + luck); if (k === 'common') x /= (1 + luck); return x; });
    var mi = order.indexOf(minR || 'common');
    var tot = 0, i; for (i = mi; i < order.length; i++) tot += w[i];
    var x = rf(r) * tot;
    for (i = mi; i < order.length; i++) { x -= w[i]; if (x < 0) return order[i]; }
    return order[mi];
  }
  // makeItem(r, {slot, base, ilvl, rarity, cls, luck, minRarity, act})
  function makeItem(r, o) {
    o = o || {};
    var ilvl = clamp(Math.round(o.ilvl || 1), 1, 99), act = o.act || clamp(Math.ceil(ilvl / 5), 1, 5);
    var rarity = o.rarity || rollRarity(r, o.luck || 0, o.minRarity);
    if (rarity === 'legendary') {
      var us = Object.keys(D.UNIQUES).filter(function (k) {
        var U = D.UNIQUES[k]; if (U.minAct > act) return false;
        if (o.slot && D.BASES[U.base].slot !== o.slot) return false;
        if (o.cls && D.BASES[U.base].slot === 'weapon' && C[o.cls].weapons.indexOf(U.base) < 0) return chance(r, 0.25);
        return true;
      });
      if (us.length) return makeUnique(r, pick(r, us), ilvl);
      rarity = 'epic';
    }
    if (rarity === 'set') {
      var sets = Object.keys(D.SETS).filter(function (k) { return D.SETS[k].minAct <= act; });
      var slots = ['helm', 'armor', 'charm'];
      if (o.slot && slots.indexOf(o.slot) < 0) sets = [];
      if (sets.length) return makeSetPiece(r, pick(r, sets), o.slot && slots.indexOf(o.slot) >= 0 ? o.slot : pick(r, slots), ilvl);
      rarity = 'epic';
    }
    var base = o.base;
    if (!base) {
      var slot = o.slot || wpick(r, D.SLOTS, function (s) { return s === 'weapon' ? 3 : s === 'armor' ? 3 : 2; });
      var pool = D.SLOT_BASES[slot];
      if (slot === 'weapon' && o.cls && chance(r, 0.75)) pool = C[o.cls].weapons;
      base = pick(r, pool);
    }
    var B = D.BASES[base];
    var it = { uid: uid(r), base: base, slot: B.slot, rarity: rarity, ilvl: ilvl, plus: 0, aff: {} };
    var R = D.RARITIES[rarity], n = rr(r, R.n[0], R.n[1]);
    rollAffixes(r, it, n);
    it.name = itemName(it);
    return it;
  }
  function rollAffixes(r, it, n) {
    it.aff = {};
    var cands = Object.keys(D.AFFIXES).filter(function (k) { return D.AFFIXES[k].slots.indexOf(it.slot) >= 0; });
    for (var i = 0; i < n && cands.length; i++) {
      var k = wpick(r, cands, function (x) { return D.AFFIXES[x].w; });
      cands.splice(cands.indexOf(k), 1);
      it.aff[k] = affixValue(D.AFFIXES[k], it.ilvl, r);
    }
  }
  function makeUnique(r, id, ilvl) {
    var U = D.UNIQUES[id], B = D.BASES[U.base];
    var it = { uid: uid(r), base: U.base, slot: B.slot, rarity: 'legendary', ilvl: ilvl, plus: 0, uq: id, aff: {}, name: U.name };
    for (var k in U.aff) {
      var A = D.AFFIXES[k], v = U.aff[k];
      // values < 3 on flat affixes are "multipliers of a normal roll" so uniques scale with ilvl
      if (A.v && v < 3) v = Math.max(1, Math.round((A.v[0] + A.v[1] * ilvl) * v));
      it.aff[k] = v;
    }
    return it;
  }
  function makeSetPiece(r, sid, slot, ilvl) {
    var S = D.SETS[sid], pc = S.pieces[slot], B = D.BASES[pc[0]];
    var it = { uid: uid(r), base: pc[0], slot: B.slot, rarity: 'set', ilvl: ilvl, plus: 0, set: sid, aff: {}, name: pc[1] };
    rollAffixes(r, it, 2);
    return it;
  }
  function itemName(it) {
    if (it.uq) return D.UNIQUES[it.uq].name;
    if (it.set) return D.SETS[it.set].pieces[it.slot][1];
    var B = D.BASES[it.base], bn = B.names[tierOf(it.ilvl)];
    if (it.rarity === 'common') return bn;
    var keys = Object.keys(it.aff || {}), pre = '', suf = '';
    for (var i = 0; i < keys.length; i++) {
      var A = D.AFFIXES[keys[i]];
      if (!pre && A.pre) pre = A.pre; else if (!suf && A.suf) suf = A.suf;
    }
    return (pre ? pre + ' ' : '') + bn + (suf ? ' ' + suf : '');
  }
  function mainValue(it) {
    var B = D.BASES[it.base]; if (!B || !B.main) return 0;
    var R = D.RARITIES[it.rarity] || D.RARITIES.common, v;
    if (B.main === 'pow') v = (2.5 + it.ilvl * 1.15) * B.m;
    else v = (1.2 + it.ilvl * 0.62) * B.m;
    return Math.round(v * R.main * (1 + 0.1 * (it.plus || 0)) * 10) / 10;
  }
  // itemStats → the mods an item adds (main stat + innate + affixes, upgrade-boosted)
  function itemStats(it) {
    var B = D.BASES[it.base], s = {};
    if (!B) return s;
    if (B.main) s[B.main] = mainValue(it);
    for (var k in B.innate) s[k] = (s[k] || 0) + B.innate[k];
    var up = 1 + 0.05 * (it.plus || 0);
    for (var a in it.aff || {}) {
      var A = D.AFFIXES[a]; if (!A) continue;
      var v = it.aff[a] * (A.max ? 1 : up);
      s[a] = (s[a] || 0) + (A.pct ? Math.round(v * 1000) / 1000 : Math.round(v));
    }
    return s;
  }
  function itemLines(it) {
    var B = D.BASES[it.base], out = [];
    if (B.main === 'pow') out.push(Math.round(mainValue(it)) + ' power');
    else if (B.main === 'arm') out.push(Math.round(mainValue(it)) + ' armor');
    for (var k in B.innate) out.push(fmtStat(k, B.innate[k]));
    var up = 1 + 0.05 * (it.plus || 0);
    for (var a in it.aff || {}) {
      var A = D.AFFIXES[a]; if (!A) continue;
      var v = it.aff[a] * (A.max ? 1 : up);
      out.push(A.fmt.replace('{v}', Math.round(v)).replace('{p}', fmtPct(v)));
    }
    if (it.uq) out.push('★ ' + D.UNIQUES[it.uq].power);
    return out;
  }
  function fmtStat(k, v) {
    var A = D.AFFIXES[k];
    if (A) return A.fmt.replace('{v}', (v > 0 ? '' : '') + Math.round(v)).replace('{p}', fmtPct(v));
    return k + ' ' + v;
  }
  function itemScore(it, cls) {
    if (!it) return 0;
    var s = itemStats(it), w = { pow: 3, arm: 2.2, hp: 0.35, hpPct: 60, powPct: 70, crit: 90, critDmg: 25, dodge: 90, lifesteal: 120, regen: 6, res: 0.6, resRegen: 12, resPct: 20,
      thorns: 25, burnOnHit: 25, poisonOnHit: 25, stunOnHit: 50, freezeOnHit: 50, goldFind: 10, magicFind: 12, abilPct: 60, light: 6, resist: 20, elite: 30, armPct: 50 };
    var t = 0; for (var k in s) t += (w[k] || 0) * s[k];
    if (it.uq || it.set) t += 25;
    if (it.slot === 'weapon' && cls && C[cls].weapons.indexOf(it.base) < 0) t *= 0.5;
    return Math.round(t);
  }
  function itemValue(it) {
    var R = D.RARITIES[it.rarity] || D.RARITIES.common;
    return Math.max(5, Math.round((8 + it.ilvl * 5) * R.val * (1 + 0.35 * (it.plus || 0))));
  }
  function canWield(h, it) { return it.slot !== 'weapon' || C[h.cls].weapons.indexOf(it.base) >= 0; }
  function maxPlus(h) { return clamp(3 + (h.story.cleared || 0) + (h.story.ng ? 2 : 0), 3, 10); }
  function upgradeCost(h, it) {
    var p = (it.plus || 0) + 1, g = Math.round(25 * Math.pow(p, 1.7) * (1 + it.ilvl / 12));
    if (h.flags && h.flags.smithDiscount) g = Math.round(g * 0.7);
    var m = { scrap: p + 1 };
    if (p >= 4) m.dust = p - 2;
    if (p >= 7) m.soul = p - 6;
    return { gold: g, mats: m };
  }
  function reforgeCost(h, it) {
    var ri_ = D.RARITY_ORDER.indexOf(it.rarity);
    return { gold: Math.round(30 + it.ilvl * 4), mats: { dust: 1 + ri_ } };
  }
  function salvageYield(it) {
    var y = { scrap: 1 + Math.floor(it.ilvl / 10) + (it.plus || 0) };
    if (it.rarity === 'magic') y.scrap += 1;
    if (it.rarity === 'rare') y.dust = 1;
    if (it.rarity === 'epic') { y.dust = 2; y.soul = it.ilvl >= 15 ? 1 : 0; }
    if (it.rarity === 'legendary' || it.rarity === 'set') { y.dust = 3; y.soul = 1; }
    return y;
  }
  function hasMats(h, cost) { for (var k in cost.mats || {}) if ((h.mats[k] || 0) < cost.mats[k]) return false; return h.gold >= (cost.gold || 0); }
  function payMats(h, cost) { for (var k in cost.mats || {}) h.mats[k] -= cost.mats[k]; h.gold -= cost.gold || 0; }
  function findItem(h, uid_) {
    for (var s in h.equip) if (h.equip[s] && h.equip[s].uid === uid_) return { it: h.equip[s], where: 'equip', slot: s };
    for (var i = 0; i < h.bag.length; i++) if (h.bag[i].uid === uid_) return { it: h.bag[i], where: 'bag', idx: i };
    return null;
  }
  function equip(h, uid_) {
    var f = findItem(h, uid_); if (!f || f.where !== 'bag') return false;
    if (!canWield(h, f.it)) return false;
    var old = h.equip[f.it.slot];
    h.bag.splice(f.idx, 1);
    h.equip[f.it.slot] = f.it;
    if (old) h.bag.splice(f.idx, 0, old);
    return true;
  }
  function unequip(h, slot) {
    var it = h.equip[slot]; if (!it || h.bag.length >= BAG_MAX) return false;
    if (slot === 'weapon' || slot === 'armor') return false;
    h.equip[slot] = null; h.bag.push(it); return true;
  }
  function upgradeItem(h, uid_) {
    var f = findItem(h, uid_); if (!f) return { ok: false, msg: 'No such item.' };
    if ((f.it.plus || 0) >= maxPlus(h)) return { ok: false, msg: 'Torvald can\'t take it further yet.' };
    var c = upgradeCost(h, f.it); if (!hasMats(h, c)) return { ok: false, msg: 'Not enough gold or materials.' };
    payMats(h, c); f.it.plus = (f.it.plus || 0) + 1; return { ok: true, it: f.it };
  }
  function reforgeItem(h, uid_, r) {
    var f = findItem(h, uid_); if (!f) return { ok: false };
    var it = f.it; if (it.uq || it.rarity === 'common') return { ok: false, msg: 'Nothing to reforge.' };
    var c = reforgeCost(h, it); if (!hasMats(h, c)) return { ok: false, msg: 'Not enough gold or dust.' };
    payMats(h, c);
    rollAffixes(r, it, it.set ? 2 : rr(r, D.RARITIES[it.rarity].n[0], D.RARITIES[it.rarity].n[1]));
    it.name = itemName(it);
    return { ok: true, it: it };
  }
  function salvageItem(h, uid_) {
    var f = findItem(h, uid_); if (!f || f.where !== 'bag') return null;
    var y = salvageYield(f.it); h.bag.splice(f.idx, 1);
    for (var k in y) h.mats[k] = (h.mats[k] || 0) + y[k];
    return y;
  }
  function sellItem(h, uid_) {
    var f = findItem(h, uid_); if (!f || f.where !== 'bag') return 0;
    var v = itemValue(f.it); h.bag.splice(f.idx, 1); h.gold += v; return v;
  }
  function craftCost(kind) { return kind === 'epic' ? { gold: 400, mats: { soul: 2, dust: 6 } } : { gold: 150, mats: { scrap: 8, dust: 3 } }; }
  function craftItem(h, slot, kind, r) {
    var c = craftCost(kind); if (!hasMats(h, c)) return null;
    if (h.bag.length >= BAG_MAX) return null;
    payMats(h, c);
    var it = makeItem(r, { slot: slot, ilvl: Math.max(1, h.story.deepest + h.story.ng * 25), rarity: kind === 'epic' ? 'epic' : 'rare', cls: h.cls });
    h.bag.push(it); return it;
  }

  // ===========================================================================
  //  dungeon generation
  // ===========================================================================
  // Puzzle/vault templates. # wall . floor B boulder _ plate G gate C chest
  // L reset lever 1-4 runes T rune tablet > stairs E entrance (door, or a
  // gate for vaults). Every boulder template is proven solvable in the tests.
  var TPL = {
    boulder1: ['###########', '#L....#C.C#', '#.B...G...#', '#.....#####', '#...._....#', '#.........#', '#####E#####'],
    boulder2: ['###########', '#C.G......#', '#C.#..B...#', '####......#', '#...B.....#', '#L......_.#', '#...._....#', '#####E#####'],
    rune: ['###########', '#1...#C.C.#', '#....G....#', '#..T.######', '#4.....2..#', '#....3....#', '#####E#####'],
    vault: ['#######', '#C...C#', '#..C..#', '###E###'],
    stairvault: ['#######', '#.....#', '#..>..#', '###E###']
  };
  function tplRows(name, fx, fy) {
    var rows = TPL[name].slice();
    if (fy) rows.reverse();
    if (fx) rows = rows.map(function (s) { return s.split('').reverse().join(''); });
    return rows;
  }
  function idx(G, x, y) { return y * G.w + x; }
  function inb(G, x, y) { return x >= 0 && y >= 0 && x < G.w && y < G.h; }
  function tile(G, x, y) { return inb(G, x, y) ? G.t[y * G.w + x] : T.WALL; }
  function setT(G, x, y, v) { if (inb(G, x, y)) G.t[y * G.w + x] = v; }

  function newGrid(w, h) { var a = new Array(w * h); for (var i = 0; i < a.length; i++) a[i] = T.WALL; return a; }

  // Dijkstra corridor carve over a cost grid (walls cost more, so corridors
  // reuse each other; locked template cells are impassable).
  function carve(G, lock, ax, ay, bx, by, r) {
    var n = G.w * G.h, dist = new Float64Array(n), prev = new Int32Array(n), heap = [];
    for (var i = 0; i < n; i++) { dist[i] = Infinity; prev[i] = -1; }
    var s = ay * G.w + ax, goal = by * G.w + bx;
    dist[s] = 0; heapPush(heap, [0, s]);
    var jitter = []; for (i = 0; i < n; i++) jitter[i] = rf(r) * 1.5;
    while (heap.length) {
      var top = heapPop(heap), d = top[0], u = top[1];
      if (d > dist[u]) continue;
      if (u === goal) break;
      var ux = u % G.w, uy = (u - ux) / G.w;
      for (var k = 0; k < 4; k++) {
        var vx = ux + DIRS4[k][0], vy = uy + DIRS4[k][1];
        if (vx < 1 || vy < 1 || vx >= G.w - 1 || vy >= G.h - 1) continue;
        var v = vy * G.w + vx;
        if (lock[v] && v !== goal) continue;
        var c = G.t[v] === T.WALL ? 3 + jitter[v] : 1;
        if (d + c < dist[v]) { dist[v] = d + c; prev[v] = u; heapPush(heap, [d + c, v]); }
      }
    }
    if (prev[goal] < 0 && goal !== s) return false;
    for (var p = goal; p >= 0; p = prev[p]) { if (G.t[p] === T.WALL) G.t[p] = T.FLOOR; if (p === s) break; }
    return true;
  }
  function heapPush(h, x) { h.push(x); var i = h.length - 1; while (i > 0) { var p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; var t = h[p]; h[p] = h[i]; h[i] = t; i = p; } }
  function heapPop(h) {
    var top = h[0], last = h.pop();
    if (h.length) { h[0] = last; var i = 0; for (;;) { var l = i * 2 + 1, rt = l + 1, m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (rt < h.length && h[rt][0] < h[m][0]) m = rt; if (m === i) break; var t = h[m]; h[m] = h[i]; h[i] = t; i = m; } }
    return top;
  }

  function overlaps(rooms, x, y, w, h) {
    for (var i = 0; i < rooms.length; i++) {
      var q = rooms[i];
      if (x - 2 < q.x + q.w + 1 && x + w + 2 > q.x - 1 && y - 2 < q.y + q.h + 1 && y + h + 2 > q.y - 1) return true;
    }
    return false;
  }
  // flood over tiles where pass(x,y) — returns reach array
  function flood(G, sx, sy, pass) {
    var seen = new Uint8Array(G.w * G.h), q = [sx, sy]; seen[sy * G.w + sx] = 1;
    for (var qi = 0; qi < q.length; qi += 2) {
      var x = q[qi], y = q[qi + 1];
      for (var k = 0; k < 4; k++) {
        var nx = x + DIRS4[k][0], ny = y + DIRS4[k][1];
        if (!inb(G, nx, ny)) continue;
        var i = ny * G.w + nx; if (seen[i] || !pass(nx, ny)) continue;
        seen[i] = 1; q.push(nx, ny);
      }
    }
    return seen;
  }
  function safeWalk(G) { return function (x, y) { var t = tile(G, x, y); return WALKABLE[t] && t !== T.LAVA && t !== T.CHASM; }; }

  function objAt(G, x, y, k) { for (var i = 0; i < G.objs.length; i++) { var o = G.objs[i]; if (o.x === x && o.y === y && (!k || o.k === k)) return o; } return null; }
  function objsAt(G, x, y) { return G.objs.filter(function (o) { return o.x === x && o.y === y; }); }
  var BLOCKING = { chest: 1, boulder: 1, lever: 1, tablet: 1, event: 1, vent: 0 };
  function blocksObj(G, x, y) { for (var i = 0; i < G.objs.length; i++) { var o = G.objs[i]; if (o.x === x && o.y === y && BLOCKING[o.k]) return o; } return null; }
  function addObj(G, o) { o.id = G.nid++; G.objs.push(o); return o; }
  function freeFloor(G, room, r, opts) {
    opts = opts || {};
    for (var tries = 0; tries < 60; tries++) {
      var x = room.x + ri(r, room.w), y = room.y + ri(r, room.h);
      if (tile(G, x, y) !== T.FLOOR) continue;
      if (objAt(G, x, y) || monAt(G, x, y)) continue;
      if (G.start && x === G.start[0] && y === G.start[1]) continue;
      if (opts.wallAdj === false) { var nb = 0; for (var k = 0; k < 4; k++) if (tile(G, x + DIRS4[k][0], y + DIRS4[k][1]) !== T.FLOOR) nb++; if (nb) continue; }
      if (opts.notNear && cheb(x, y, opts.notNear[0], opts.notNear[1]) < (opts.dist || 6)) continue;
      return [x, y];
    }
    return null;
  }

  function newRunShell(h, o) {
    o = o || {};
    var seed = o.seed != null ? o.seed >>> 0 : (hashStr(h.id + ':' + Date.now() + ':' + Math.random()) >>> 0);
    var G = {
      v: 1, heroId: h.id, mode: o.daily ? 'daily' : 'story', seed: seed, depth: 0, r: rng(seed ^ 0x9e3779b9),
      w: MW, h: MH, t: [], seen: [], objs: [], mons: [], deco: [], gas: {}, fire: {}, holy: {}, delayed: [], pz: {},
      nid: 1, turn: 0, time: 0, log: [], ev: [], modal: null, over: null, floorTurns: 0,
      run: { kills: 0, gold: 0, elites: 0, items: 0, floors: 0, start: o.depth || 1, bosses: 0, puzzles: 0, events: 0, lore: 0 },
      p: { id: 0, x: 1, y: 1, hp: 1, res: 0, st: {}, cd: {}, face: [0, 1], still: 0, onceFloor: {}, swings: 0, harvest: 0, hitIds: {} },
      daily: o.daily || null
    };
    G.hero = h;
    var s = stats(h, G);
    G.p.hp = clamp(h.hp || s.maxHp, 1, s.maxHp);
    G.p.res = clamp(h.res == null ? C[h.cls].res.start : h.res, 0, s.maxRes);
    return G;
  }
  function monLevel(G, depth) {
    var h = G.hero, ng = (h.story && h.story.ng) || 0;
    if (G.mode === 'daily') return depth + 1;
    return depth + ng * 25;
  }

  // genFloor(G, depth): builds a new floor into G (keeps the player & hero).
  function genFloor(G, depth) {
    G.depth = depth; G.biome = biomeAt(depth); G.ml = monLevel(G, depth);
    if (G.mode === 'daily') G.biome = D.BIOME_ORDER[clamp(Math.floor((depth - 1) / 3), 0, 4)];
    G.boss = isBossFloor(depth) && !(G.mode === 'daily' && depth % 5 !== 0);
    var r = rng(hashStr(G.seed + ':' + depth));
    G.objs = []; G.mons = []; G.deco = []; G.gas = {}; G.fire = {}; G.holy = {}; G.delayed = []; G.pz = {}; G.start = null; G.stairs = null;
    G.floorTurns = 0; G.wanderT = 0; G.bossSeen = false;
    if (G.boss) genBossFloor(G, r);
    else {
      var ok = false;
      for (var attempt = 0; attempt < 30 && !ok; attempt++) ok = genRooms(G, r);
      if (!ok) genFallback(G, r);
    }
    G.seen = []; for (var i = 0; i < G.w * G.h; i++) G.seen.push(0);
    var p = G.p; p.x = G.start[0]; p.y = G.start[1]; p.st = keepBuffs(p.st); p.onceFloor = {}; p.harvest = 0; p.hitIds = {}; p.still = 0; p.swings = 0;
    // minions don't follow you down (wolves do — they are part of the hunt)
    p.cd.wolf = 0;
    var h = G.hero, s = stats(h, G);
    if (s.flags.trance && h.cls === 'warrior') p.res = Math.max(p.res, 30);
    if (s.flags.u_hood) p.st.invis = 3;
    if (s.doom) { var dd = Math.round(s.maxHp * 0.1); p.hp = Math.max(1, p.hp - dd); log(G, 'The curse of Doom takes its toll (−' + dd + ').', 'bad'); }
    computeFov(G);
    emit(G, { t: 'floor', depth: depth });
    return G;
  }
  function keepBuffs(st) { var o = {}; if (st.shield) o.shield = st.shield; return o; }

  function genRooms(G, r) {
    var w = G.w, h = G.h;
    G.t = newGrid(w, h);
    var lock = new Uint8Array(w * h), rooms = [], tpls = [];
    var B = D.BIOMES[G.biome];
    // which puzzle (if any) — and whether the stairs are sealed behind it
    var puzzle = null, stairVault = false;
    if (chance(r, 0.6) && G.depth > 1) puzzle = pick(r, ['lever', 'lever', 'boulder', 'rune']);
    if (puzzle && chance(r, 0.3)) stairVault = true;
    var want = [];
    if (puzzle === 'boulder') want.push(pick(r, ['boulder1', 'boulder2']));
    if (puzzle === 'rune') want.push('rune');
    if (puzzle === 'lever' && !stairVault) want.push('vault');
    if (stairVault) want.push('stairvault');
    for (var wi = 0; wi < want.length; wi++) {
      var rows = tplRows(want[wi], chance(r, 0.5), want[wi].indexOf('vault') >= 0 ? false : chance(r, 0.5));
      var th = rows.length, tw = rows[0].length, placed = false;
      for (var tries = 0; tries < 80 && !placed; tries++) {
        var x0 = rr(r, 1, w - tw - 1), y0 = rr(r, 1, h - th - 1);
        if (overlaps(rooms.concat(tpls), x0 + 1, y0 + 1, tw - 2, th - 2)) continue;
        var t = stampTpl(G, lock, rows, x0, y0, want[wi]);
        if (!t) continue;
        tpls.push(t); placed = true;
      }
      if (!placed) return false;
    }
    // normal rooms
    var target = rr(r, 8, 11);
    for (var tries2 = 0; tries2 < 260 && rooms.length < target; tries2++) {
      var rw = rr(r, 4, 9), rh = rr(r, 3, 7);
      var rx = rr(r, 2, w - rw - 2), ry = rr(r, 2, h - rh - 2);
      if (overlaps(rooms.concat(tpls), rx, ry, rw, rh)) continue;
      for (var yy = ry; yy < ry + rh; yy++) for (var xx = rx; xx < rx + rw; xx++) G.t[yy * w + xx] = T.FLOOR;
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) });
    }
    if (rooms.length < 6) return false;
    // connect normal rooms: MST (Prim) on centers + a few loops
    var inTree = [0], edges = [];
    while (inTree.length < rooms.length) {
      var best = null;
      for (var a = 0; a < inTree.length; a++) for (var b = 0; b < rooms.length; b++) {
        if (inTree.indexOf(b) >= 0) continue;
        var ra = rooms[inTree[a]], rb = rooms[b], d = manh(ra.cx, ra.cy, rb.cx, rb.cy);
        if (!best || d < best[2]) best = [inTree[a], b, d];
      }
      edges.push(best); inTree.push(best[1]);
    }
    for (var e = 0; e < 2 + ri(r, 3); e++) { var i1 = ri(r, rooms.length), i2 = ri(r, rooms.length); if (i1 !== i2) edges.push([i1, i2, 0]); }
    for (e = 0; e < edges.length; e++) {
      var A = rooms[edges[e][0]], Bq = rooms[edges[e][1]];
      if (!carve(G, lock, A.cx, A.cy, Bq.cx, Bq.cy, r)) return false;
    }
    // attach each template to its nearest room (a leaf: one way in)
    for (var ti = 0; ti < tpls.length; ti++) {
      var tp = tpls[ti], near = null;
      rooms.forEach(function (q) { var d = manh(q.cx, q.cy, tp.ox, tp.oy); if (!near || d < near[1]) near = [q, d]; });
      if (!carve(G, lock, near[0].cx, near[0].cy, tp.ox, tp.oy, r)) return false;
      setT(G, tp.ox, tp.oy, T.FLOOR);
      setT(G, tp.ex, tp.ey, tp.kind === 'vault' || tp.kind === 'stairvault' ? T.GATE : T.DOOR);
    }
    // doors where corridors meet rooms
    rooms.forEach(function (q) {
      for (var x = q.x - 1; x <= q.x + q.w; x++) for (var y = q.y - 1; y <= q.y + q.h; y++) {
        if (x !== q.x - 1 && x !== q.x + q.w && y !== q.y - 1 && y !== q.y + q.h) continue;
        if (tile(G, x, y) !== T.FLOOR || lock[y * w + x]) continue;
        var horiz = tile(G, x - 1, y) === T.WALL && tile(G, x + 1, y) === T.WALL, vert = tile(G, x, y - 1) === T.WALL && tile(G, x, y + 1) === T.WALL;
        if ((horiz || vert) && chance(r, 0.4)) setT(G, x, y, T.DOOR);
      }
    });
    // start room: random; stairs: the room farthest by walking distance
    var startRoom = rooms[ri(r, rooms.length)];
    G.start = [startRoom.cx, startRoom.cy];
    var reach = flood(G, G.start[0], G.start[1], function (x, y) { return WALKABLE[tile(G, x, y)]; });
    for (var q = 0; q < rooms.length; q++) if (!reach[rooms[q].cy * w + rooms[q].cx]) return false;
    for (ti = 0; ti < tpls.length; ti++) if (!reach[tpls[ti].oy * w + tpls[ti].ox]) return false;
    var dist = bfs(G, G.start[0], G.start[1], function (x, y) { return WALKABLE[tile(G, x, y)]; });
    var far = rooms.slice().sort(function (p1, p2) { return dist[p2.cy * w + p2.cx] - dist[p1.cy * w + p1.cx]; })[0];
    G.rooms = rooms; G.startRoom = startRoom;
    // hazards first (keeping everything connected), then the stairs and contents
    addHazards(G, r, rooms, startRoom, tpls, lock);
    if (!stairVault) {
      var sp = freeFloor(G, far, r, { wallAdj: false }) || freeFloor(G, far, r) || [far.cx, far.cy];
      setT(G, sp[0], sp[1], T.STAIRS); G.stairs = sp;
    }
    tpls.forEach(function (tp) { finishTpl(G, r, tp, rooms, startRoom); });
    populate(G, r, rooms, startRoom);
    return true;
  }
  function stampTpl(G, lock, rows, x0, y0, kind) {
    var th = rows.length, tw = rows[0].length, t = { kind: kind, x: x0, y: y0, w: tw, h: th, pz: G.nid++, items: [] };
    for (var y = 0; y < th; y++) for (var x = 0; x < tw; x++) {
      var c = rows[y][x], gx = x0 + x, gy = y0 + y, i = gy * G.w + gx;
      if (G.t[i] !== T.WALL) return null;
      lock[i] = 1;
    }
    for (y = 0; y < th; y++) for (x = 0; x < tw; x++) {
      var ch = rows[y][x], X = x0 + x, Y = y0 + y;
      if (ch === '#') { G.t[Y * G.w + X] = T.WALL; continue; }
      G.t[Y * G.w + X] = T.FLOOR;
      if (ch === 'E') {
        t.ex = X; t.ey = Y;
        var dx = x === 0 ? -1 : x === tw - 1 ? 1 : 0, dy = y === 0 ? -1 : y === th - 1 ? 1 : 0;
        t.ox = X + dx; t.oy = Y + dy;
      } else if (ch !== '.') t.items.push([ch, X, Y]);
    }
    return t;
  }
  function finishTpl(G, r, tp, rooms, startRoom) {
    var pz = tp.pz, gates = [];
    G.pz[pz] = { kind: tp.kind, solved: false, gates: gates };
    if (tp.kind === 'vault' || tp.kind === 'stairvault') gates.push([tp.ex, tp.ey]);
    tp.items.forEach(function (it) {
      var c = it[0], x = it[1], y = it[2];
      if (c === 'B') addObj(G, { k: 'boulder', x: x, y: y, pz: pz, home: [x, y] });
      else if (c === '_') addObj(G, { k: 'plate', x: x, y: y, pz: pz, on: false });
      else if (c === 'G') { setT(G, x, y, T.GATE); gates.push([x, y]); }
      else if (c === 'C') addObj(G, { k: 'chest', x: x, y: y, vault: 1 });
      else if (c === 'L') addObj(G, { k: 'lever', x: x, y: y, pz: pz, reset: 1 });
      else if (c === 'T') addObj(G, { k: 'tablet', x: x, y: y, pz: pz });
      else if (c === '>') { setT(G, x, y, T.STAIRS); G.stairs = [x, y]; }
      else if (c >= '1' && c <= '4') addObj(G, { k: 'rune', x: x, y: y, pz: pz, sym: +c - 1, lit: false });
    });
    if (tp.kind === 'rune') { G.pz[pz].order = shuffle(r, [0, 1, 2, 3]); G.pz[pz].prog = 0; }
    if (tp.kind === 'vault' || tp.kind === 'stairvault') {
      // 1-2 levers in other rooms (reachable without passing the gate: rooms are all on the open side)
      var n = G.depth >= 8 && chance(r, 0.5) ? 2 : 1, cands = rooms.filter(function (q) { return q !== startRoom; });
      shuffle(r, cands);
      for (var i = 0; i < n && i < cands.length; i++) {
        var spot = freeFloor(G, cands[i], r);
        if (spot) addObj(G, { k: 'lever', x: spot[0], y: spot[1], pz: pz, on: false });
      }
      if (!G.objs.some(function (o) { return o.k === 'lever' && o.pz === pz; })) {   // no room for a lever: just open it
        gates.forEach(function (g) { setT(G, g[0], g[1], T.OGATE); }); G.pz[pz].solved = true;
      }
    }
  }
  function addHazards(G, r, rooms, startRoom, tpls, lock) {
    var B = D.BIOMES[G.biome], hz = B.hazards, keys = [];
    rooms.forEach(function (q) { keys.push([q.cx, q.cy]); });
    tpls.forEach(function (t) { keys.push([t.ox, t.oy]); });
    keys.push(G.start);
    function connected() {
      var reach = flood(G, G.start[0], G.start[1], safeWalk(G));
      for (var i = 0; i < keys.length; i++) if (!reach[keys[i][1] * G.w + keys[i][0]]) return false;
      return true;
    }
    function blob(q, kind, inner) {
      var cx = q.x + ri(r, q.w), cy = q.y + ri(r, q.h), rad = rr(r, 1, Math.max(1, Math.min(3, Math.floor(Math.min(q.w, q.h) / 2))));
      var changed = [];
      for (var y = cy - rad; y <= cy + rad; y++) for (var x = cx - rad; x <= cx + rad; x++) {
        if (x < q.x || y < q.y || x >= q.x + q.w || y >= q.y + q.h) continue;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad + 0.5 + rf(r)) continue;
        if (tile(G, x, y) !== T.FLOOR || lock[y * G.w + x]) continue;
        var d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        var tt = (inner != null && d2 <= (rad - 1) * (rad - 1)) ? inner : kind;
        changed.push([x, y, tile(G, x, y)]); setT(G, x, y, tt);
      }
      if ((kind === T.LAVA || kind === T.CHASM || inner != null) && !connected()) changed.forEach(function (c) { setT(G, c[0], c[1], c[2]); });
    }
    rooms.forEach(function (q) {
      if (q === startRoom) return;
      if (hz.water && chance(r, hz.water)) blob(q, T.WATER, q.w >= 6 && q.h >= 5 && chance(r, 0.6) ? T.DEEP : null);
      if (hz.lava && chance(r, hz.lava * 0.7)) blob(q, T.LAVA);
      if (hz.chasm && chance(r, hz.chasm * 0.6)) blob(q, T.CHASM);
      if (hz.fungus && chance(r, hz.fungus)) {
        for (var n = 0; n < q.w * q.h * 0.18; n++) { var x = q.x + ri(r, q.w), y = q.y + ri(r, q.h); if (tile(G, x, y) === T.FLOOR) setT(G, x, y, T.FUNGUS); }
      }
    });
    // flooded archive: corridors are shallow water too
    if (G.biome === 'flooded') for (var i = 0; i < G.t.length; i++) if (G.t[i] === T.FLOOR && chance(r, 0.35)) G.t[i] = T.WATER;
  }

  function populate(G, r, rooms, startRoom) {
    var B = D.BIOMES[G.biome], h = G.hero, d = G.depth, s = stats(h, G);
    var others = rooms.filter(function (q) { return q !== startRoom; });
    // decor
    rooms.forEach(function (q) { for (var n = 0; n < 2; n++) { var sp = freeFloor(G, q, r); if (sp && chance(r, 0.6)) G.deco.push({ x: sp[0], y: sp[1], k: pick(r, B.decor) }); } });
    // monsters
    var count = Math.round((9 + Math.min(9, d * 0.35)) * (G.daily && G.daily.mod === 'swarm' ? 1.5 : 1));
    var pool = B.mons.filter(function (k) { return !MON[k].minDepth || (G.mode === 'daily' ? d * 1.6 : ((d - 1) % 25) + 1) >= MON[k].minDepth || G.ml > 25; });
    var guard = 0;
    while (count > 0 && guard++ < 80) {
      var q = pick(r, others), k = wpick(r, pool, function (m) { return MON[m].rare ? 0.4 : 1; });
      var M = MON[k], n = M.pack ? rr(r, M.pack[0], M.pack[1]) : 1, elite = chance(r, eliteChance(G, s));
      for (var j = 0; j < n && count > 0; j++) {
        var sp = freeFloor(G, q, r, { notNear: G.start, dist: 7 });
        if (!sp) break;
        var m = spawnMon(G, k, sp[0], sp[1], { elite: elite && j === 0 ? eliteAffixes(G, r) : null });
        m.asleep = chance(r, 0.35); count--;
      }
    }
    // chests (some are mimics)
    var nChest = rr(r, 2, 3) + (chance(r, 0.3) ? 1 : 0);
    for (var c = 0; c < nChest; c++) {
      var sp2 = freeFloor(G, pick(r, others), r);
      if (sp2) addObj(G, { k: 'chest', x: sp2[0], y: sp2[1], mimic: d >= 3 && chance(r, 0.12) ? 1 : 0 });
    }
    // gold, a consumable or two
    for (c = 0; c < rr(r, 3, 5); c++) { var sp3 = freeFloor(G, pick(r, rooms), r); if (sp3) addObj(G, { k: 'gold', x: sp3[0], y: sp3[1], n: goldAmount(G, r, 4) }); }
    if (chance(r, 0.6)) { var sp4 = freeFloor(G, pick(r, others), r); if (sp4) addObj(G, { k: 'cons', x: sp4[0], y: sp4[1], id: pick(r, ['potion', 'potion', 'tonic', 'elixir', 'bomb', 'mapping']), n: 1 }); }
    // events / shrines
    var nev = (chance(r, 0.75) ? 1 : 0) + (chance(r, 0.3) ? 1 : 0);
    var evs = D.EVENT_ORDER.filter(function (id) { var e = D.EVENTS[id]; return !e.biomes || e.biomes.indexOf(G.biome) >= 0; });
    for (c = 0; c < nev; c++) {
      var sp5 = freeFloor(G, pick(r, others), r, { wallAdj: false }) || freeFloor(G, pick(r, others), r);
      if (sp5) addObj(G, { k: 'event', x: sp5[0], y: sp5[1], id: pick(r, evs), used: false });
    }
    // lore page
    if (G.mode !== 'daily' && chance(r, 0.5)) {
      var act = clamp(actAt(((d - 1) % 25) + 1), 1, 5), li = -1;
      for (var L = 0; L < D.LORE.length; L++) if (D.LORE[L].act === act && h.lore.indexOf(L) < 0) { li = L; break; }
      if (li < 0 && chance(r, 0.3)) li = -2;
      var sp6 = freeFloor(G, pick(r, others), r);
      if (sp6 && li >= 0) addObj(G, { k: 'lore', x: sp6[0], y: sp6[1], idx: li });
    }
    // side-quest item
    if (G.mode !== 'daily' && d <= 25) for (var qid in D.SIDEQUESTS) {
      var SQ = D.SIDEQUESTS[qid];
      if (h.quests.side[qid] === 'active' && actAt(d) === SQ.act && (d % 5 === 4 || chance(r, 0.4))) {
        var sp7 = freeFloor(G, pick(r, others), r); if (sp7) addObj(G, { k: 'quest', x: sp7[0], y: sp7[1], q: qid });
      }
    }
    // hidden traps + visible vents
    var nTrap = 3 + Math.floor(Math.min(d, 30) / 4);
    for (c = 0; c < nTrap; c++) {
      var x = rr(r, 1, G.w - 2), y = rr(r, 1, G.h - 2);
      if (tile(G, x, y) !== T.FLOOR || objAt(G, x, y) || cheb(x, y, G.start[0], G.start[1]) < 4) continue;
      if (G.stairs && cheb(x, y, G.stairs[0], G.stairs[1]) < 1) continue;
      addObj(G, { k: 'trap', x: x, y: y, id: pick(r, B.traps), hidden: !s.flags.traps && !s.flags.u_eye });
    }
    if (B.hazards.vents) others.forEach(function (q) {
      if (!chance(r, B.hazards.vents)) return;
      for (var n = rr(r, 1, 3); n > 0; n--) { var sp8 = freeFloor(G, q, r); if (sp8) addObj(G, { k: 'vent', x: sp8[0], y: sp8[1], ph: ri(r, 4), kind: { crypt: 'spike', fungal: 'gas', forge: 'flame', abyss: 'void', flooded: 'spike' }[G.biome] }); }
    });
  }
  function genFallback(G, r) {
    // a guaranteed-valid simple floor: a ring of rooms around a hall
    G.t = newGrid(G.w, G.h);
    for (var y = 3; y < G.h - 3; y++) for (var x = 3; x < G.w - 3; x++) G.t[y * G.w + x] = T.FLOOR;
    for (y = 8; y < G.h - 8; y++) for (x = 10; x < G.w - 10; x++) if ((x + y) % 7 === 0) G.t[y * G.w + x] = T.WALL;
    var room = { x: 3, y: 3, w: G.w - 6, h: G.h - 6, cx: G.w >> 1, cy: G.h >> 1 };
    G.start = [4, 4]; G.stairs = [G.w - 5, G.h - 5]; setT(G, G.stairs[0], G.stairs[1], T.STAIRS);
    G.rooms = [room]; G.startRoom = { x: 3, y: 3, w: 4, h: 4, cx: 4, cy: 4 };
    populate(G, r, [G.startRoom, room], G.startRoom);
  }
  function genBossFloor(G, r) {
    var w = G.w, h = G.h;
    G.t = newGrid(w, h);
    function rect(x0, y0, x1, y1, t) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) setT(G, x, y, t); }
    // antechamber (bottom) → hall → arena (top)
    rect(16, 24, 25, 28, T.FLOOR);
    rect(20, 19, 21, 23, T.FLOOR);
    rect(9, 4, 32, 18, T.FLOOR);
    // pillars
    [[13, 8], [28, 8], [13, 14], [28, 14]].forEach(function (p) { rect(p[0], p[1], p[0] + 1, p[1] + 1, T.WALL); });
    // biome flavor in the arena (kept away from the center)
    var B = D.BIOMES[G.biome];
    var flavor = B.hazards.lava ? T.LAVA : B.hazards.chasm ? T.CHASM : B.hazards.water ? T.WATER : B.hazards.fungus ? T.FUNGUS : null;
    if (flavor != null) [[10, 5], [31, 5], [10, 17], [31, 17]].forEach(function (p) { setT(G, p[0], p[1], flavor); setT(G, p[0] + (p[0] < 20 ? 1 : -1), p[1], flavor); });
    setT(G, 20, 23, T.DOOR);
    G.start = [20, 27];
    G.rooms = [{ x: 9, y: 4, w: 24, h: 15, cx: 20, cy: 10 }];
    G.startRoom = { x: 16, y: 24, w: 10, h: 5, cx: 20, cy: 26 };
    G.arena = { x: 9, y: 4, w: 24, h: 15 };
    addObj(G, { k: 'event', x: 17, y: 25, id: 'fountain', used: false });
    G.deco.push({ x: 24, y: 25, k: B.decor[0] }, { x: 16, y: 28, k: B.decor[1] });
    var bid = bossIdFor(G);
    spawnBoss(G, bid, 20, 7);
  }
  function bossIdFor(G) {
    if (G.mode === 'daily') return D.BIOMES[G.biome].boss;
    if (G.depth <= D.STORY_FLOORS) return D.BIOMES[biomeAt(G.depth)].boss;
    return D.ECHO_ORDER[Math.floor((G.depth - D.STORY_FLOORS - 1) / 5) % 5];
  }
