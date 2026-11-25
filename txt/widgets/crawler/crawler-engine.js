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
  function addObj(G, o) { o.oid = G.nid++; G.objs.push(o); return o; }
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
    G.floorTurns = 0; G.wanderT = 0; G.wanderers = 0; G.bossSeen = false; G.arena = null; G.seenMons = []; G.mapped = false;
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

  // ===========================================================================
  //  monsters
  // ===========================================================================
  function curve(L, a, b) { return 1 + a * (L - 1) + b * (L - 1) * (L - 1); }
  function hpCurve(L) { return curve(L, 0.22, 0.008); }
  function powCurve(L) { return curve(L, 0.2, 0.006); }
  function monAt(G, x, y) { for (var i = 0; i < G.mons.length; i++) { var m = G.mons[i]; if (m.x === x && m.y === y && m.hp > 0) return m; } return null; }
  function actorAt(G, x, y) { if (G.p.x === x && G.p.y === y && G.p.hp > 0) return G.p; return monAt(G, x, y); }
  function eliteChance(G, s) {
    var d = difficulty(G.hero), base = 0.05 + Math.min(0.12, G.depth * 0.004);
    if (G.daily && G.daily.mod === 'elites') base *= 3;
    return Math.min(0.5, base * d.elite * (1 + (s.eliteFind || 0) * 2));
  }
  function eliteAffixes(G, r) {
    var keys = Object.keys(D.ELITE), n = 1;
    var d = G.hero.difficulty;
    if (G.depth >= 11 || d === 'hard') n = 2;
    if (d === 'nightmare' && G.depth >= 16) n = 3;
    shuffle(r, keys); return keys.slice(0, n);
  }
  function spawnMon(G, k, x, y, o) {
    o = o || {};
    var M = MON[k], h = G.hero, diff = difficulty(h);
    var ally = !!o.ally, ml = ally ? h.level + (G.hero.story.ng || 0) * 3 : (o.lvl || G.ml);
    var hpM = ally ? 1 + 0.18 * (ml - 1) : hpCurve(ml) * diff.hp, powM = ally ? 1 + 0.14 * (ml - 1) : powCurve(ml) * diff.pow;
    var m = {
      id: G.nid++, k: k, name: M.name, ch: M.ch, col: M.col, fam: M.fam, ai: M.ai, x: x, y: y, lvl: ml,
      maxHp: Math.max(1, Math.round(M.hp * hpM)), pow: M.pow * powM, arm: Math.round(M.arm * (1 + 0.07 * (ml - 1))), spd: M.spd,
      energy: ri(G.r, 100), xp: Math.round(M.xp * (1 + 0.33 * (ml - 1))), gold: M.gold, st: {}, cd: {}, aware: !!o.aware, asleep: false, intent: null,
      range: M.range || 0, ally: ally, owner: ally ? 'p' : null, ttl: o.ttl || 0, elite: null
    };
    if (G.daily && G.daily.mod === 'haste' && !ally) m.spd = Math.round(m.spd * 1.25);
    if (o.elite && o.elite.length) {
      m.elite = o.elite; m.maxHp = Math.round(m.maxHp * 2.4); m.pow *= 1.3; m.xp *= 3; m.gold *= 3;
      if (m.elite.indexOf('hasted') >= 0) m.spd = Math.min(220, m.spd * 2);
      if (m.elite.indexOf('shielded') >= 0) m.st.shield = { v: Math.round(m.maxHp * 0.3), t: 999 };
    }
    if (o.scale) { m.maxHp = Math.max(1, Math.round(m.maxHp * o.scale)); m.pow *= Math.sqrt(o.scale); m.xp = Math.round(m.xp * o.scale); }
    if (k === 'mimic') m.disguised = true;
    if (M.ai === 'ambush' || M.ai === 'ghost') m.lurk = true;
    m.hp = m.maxHp;
    G.mons.push(m);
    return m;
  }
  function spawnBoss(G, id, x, y) {
    var B = D.BOSSES[id], diff = difficulty(G.hero), ml = G.ml;
    var echo = G.depth > D.STORY_FLOORS && G.mode !== 'daily';
    var mult = (echo ? 1.35 : 1) * (G.mode === 'daily' ? 0.7 : 1);
    var m = {
      id: G.nid++, k: 'boss', boss: id, name: (echo ? 'Echo of ' : '') + B.name, ch: B.ch, col: B.col, fam: B.fam, ai: 'boss', x: x, y: y, lvl: ml,
      maxHp: Math.round(B.hp * hpCurve(ml) * diff.hp * mult), pow: B.pow * powCurve(ml) * diff.pow * (echo ? 1.15 : 1), arm: Math.round(B.arm * (1 + 0.07 * (ml - 1))),
      spd: B.spd, energy: 0, xp: Math.round(B.xp * (1 + 0.33 * (ml - 1))), gold: B.gold, st: {}, cd: {}, aware: false, asleep: true, intent: null, range: 7,
      phase: 0, mcd: {}, gcd: 0, elite: null, fireproof: B.fireproof
    };
    m.hp = m.maxHp;
    G.mons.push(m);
    return m;
  }
  function monDef(m) { return m.boss ? D.BOSSES[m.boss] : MON[m.k]; }
  function hostile(a, b) { var ap = a.id === 0 || a.ally, bp = b.id === 0 || b.ally; return ap !== bp; }
  function hasElite(m, a) { return m.elite && m.elite.indexOf(a) >= 0; }
  function displayName(m) {
    if (!m.elite) return m.name;
    return m.elite.map(function (e) { return D.ELITE[e].name; }).join(' ') + ' ' + m.name;
  }

  // ===========================================================================
  //  field of view, line of sight, distance maps
  // ===========================================================================
  function lightRadius(G) {
    var s = stats(G.hero, G), L = D.BIOMES[G.biome].light + s.light;
    if (G.p.st.dark) L -= 3;
    return clamp(L, 2, 9);
  }
  function emitsLight(G, x, y) {
    var t = tile(G, x, y);
    if (t === T.LAVA || t === T.PORTAL) return true;
    if (G.fire[y * G.w + x]) return true;
    return false;
  }
  function computeFov(G) {
    var n = G.w * G.h, vis = new Uint8Array(n), los = new Uint8Array(n), p = G.p, R = 12, L = lightRadius(G);
    var px = p.x, py = p.y;
    function trace(tx, ty) {
      var x0 = px, y0 = py, dx = Math.abs(tx - x0), dy = -Math.abs(ty - y0), sx = x0 < tx ? 1 : -1, sy = y0 < ty ? 1 : -1, err = dx + dy;
      for (;;) {
        if (!inb(G, x0, y0)) return;
        var d2 = (x0 - px) * (x0 - px) + (y0 - py) * (y0 - py);
        if (d2 > R * R) return;
        los[y0 * G.w + x0] = 1;
        if ((x0 !== px || y0 !== py) && OPAQUE[tile(G, x0, y0)]) return;
        if (x0 === tx && y0 === ty) return;
        var e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    for (var i = -R; i <= R; i++) { trace(px + i, py - R); trace(px + i, py + R); trace(px - R, py + i); trace(px + R, py + i); }
    // light: inside the torch radius, or glowing tiles (and their neighbors)
    var glow = [];
    for (var y = Math.max(0, py - R); y <= Math.min(G.h - 1, py + R); y++) for (var x = Math.max(0, px - R); x <= Math.min(G.w - 1, px + R); x++) {
      var k = y * G.w + x; if (!los[k]) continue;
      var d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 <= L * L + L) vis[k] = 1;
      else if (emitsLight(G, x, y)) { vis[k] = 1; glow.push(x, y); }
    }
    for (i = 0; i < glow.length; i += 2) for (var k2 = 0; k2 < 8; k2++) { var gx = glow[i] + DIRS8[k2][0], gy = glow[i + 1] + DIRS8[k2][1]; if (inb(G, gx, gy) && los[gy * G.w + gx]) vis[gy * G.w + gx] = 1; }
    // walls next to visible floor light up too (fixes ray-cast corner gaps)
    for (y = Math.max(0, py - L - 1); y <= Math.min(G.h - 1, py + L + 1); y++) for (x = Math.max(0, px - L - 1); x <= Math.min(G.w - 1, px + L + 1); x++) {
      var kk = y * G.w + x; if (vis[kk] || !OPAQUE[tile(G, x, y)]) continue;
      for (var k3 = 0; k3 < 8; k3++) { var nx = x + DIRS8[k3][0], ny = y + DIRS8[k3][1]; if (inb(G, nx, ny) && vis[ny * G.w + nx] && !OPAQUE[tile(G, nx, ny)] && (nx - px) * (nx - px) + (ny - py) * (ny - py) <= (L + 1) * (L + 1)) { vis[kk] = 1; break; } }
    }
    G.vis = vis;
    for (i = 0; i < n; i++) if (vis[i] && !G.seen[i]) G.seen[i] = 1;
    // traps within 2 tiles may be spotted
    var s = stats(G.hero, G);
    G.objs.forEach(function (o) {
      if (o.k === 'trap' && o.hidden && vis[o.y * G.w + o.x] && cheb(o.x, o.y, px, py) <= 2) {
        var c = G.hero.cls === 'rogue' ? 0.45 : 0.22;
        if (s.flags.traps || s.flags.u_eye || chance(G.r, c)) { o.hidden = false; log(G, 'You spot a ' + D.TRAPS[o.id].name.toLowerCase() + '.', 'info'); }
      }
    });
    return vis;
  }
  function visible(G, x, y) { return !!(G.vis && inb(G, x, y) && G.vis[y * G.w + x]); }
  function monVisible(G, m) {
    if (!visible(G, m.x, m.y)) return false;
    if (m.ally) return true;
    var s = stats(G.hero, G);
    if (m.k === 'lurker' && (tile(G, m.x, m.y) === T.WATER || tile(G, m.x, m.y) === T.DEEP) && manh(m.x, m.y, G.p.x, G.p.y) > 1 && !s.flags.u_eye) return false;
    if (m.k === 'shade' && cheb(m.x, m.y, G.p.x, G.p.y) > 2 && !m.revealed && !s.flags.u_eye) return false;
    return true;
  }
  function los(G, x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      if (x0 === x1 && y0 === y1) return true;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
      if (x0 === x1 && y0 === y1) return true;
      if (OPAQUE[tile(G, x0, y0)]) return false;
    }
  }
  function lineTiles(G, x0, y0, x1, y1, maxLen, throughActors) {
    // tiles from (x0,y0) toward (x1,y1), extended to maxLen, stopping at walls
    var out = [], dx = x1 - x0, dy = y1 - y0, n = Math.max(Math.abs(dx), Math.abs(dy));
    if (!n) return out;
    var sx = dx / n, sy = dy / n;
    for (var i = 1; i <= maxLen; i++) {
      var x = Math.round(x0 + sx * i), y = Math.round(y0 + sy * i);
      if (!inb(G, x, y) || OPAQUE[tile(G, x, y)] || tile(G, x, y) === T.GATE) break;
      out.push([x, y]);
    }
    return out;
  }
  function bfs(G, sx, sy, pass, maxD) {
    var n = G.w * G.h, dist = new Int16Array(n); for (var i = 0; i < n; i++) dist[i] = 9999;
    var q = [sx, sy]; dist[sy * G.w + sx] = 0; maxD = maxD || 9999;
    for (var qi = 0; qi < q.length; qi += 2) {
      var x = q[qi], y = q[qi + 1], d = dist[y * G.w + x];
      if (d >= maxD) continue;
      for (var k = 0; k < 4; k++) {
        var nx = x + DIRS4[k][0], ny = y + DIRS4[k][1];
        if (!inb(G, nx, ny)) continue;
        var j = ny * G.w + nx; if (dist[j] <= d + 1 || !pass(nx, ny)) continue;
        dist[j] = d + 1; q.push(nx, ny);
      }
    }
    return dist;
  }
  function canEnter(G, m, x, y) {
    var t = tile(G, x, y);
    if (m.ai === 'ghost') return inb(G, x, y) && x > 0 && y > 0 && x < G.w - 1 && y < G.h - 1;
    if (m.k === 'lurker') return t === T.WATER || t === T.DEEP;
    if (!WALKABLE[t]) return false;
    if (t === T.CHASM) return false;
    if (t === T.LAVA && !m.fireproof && !(MON[m.k] && MON[m.k].fireproof)) return false;
    if (blocksObj(G, x, y)) return false;
    return true;
  }

  // ===========================================================================
  //  events + log (the UI drains G.ev each frame)
  // ===========================================================================
  function emit(G, e) { G.ev.push(e); }
  function log(G, s, c) { G.log.push({ s: s, c: c || '', t: G.turn }); if (G.log.length > 120) G.log.splice(0, G.log.length - 120); emit(G, { t: 'log', s: s, c: c || '' }); }
  function nameOf(G, a) { return a === G.p ? 'You' : displayName(a); }

  // ===========================================================================
  //  statuses
  // ===========================================================================
  var DOTS = { poison: 1, burn: 1, bleed: 1 };
  var CC = { stun: 1, frozen: 1, root: 1 };
  function addStatus(G, a, key, t, v) {
    if (!a || a.hp <= 0 || t <= 0) return;
    var isP = a === G.p;
    if (isP) {
      var s = stats(G.hero, G);
      if (a.st.inv && (DOTS[key] || CC[key] || key === 'weaken' || key === 'slow')) return;
      if (key === 'burn' && (s.flags.u_ember || s.flags.s_ember)) return;
      if (DOTS[key]) t = Math.max(1, Math.round(t * (1 - s.resist)));
      if (CC[key]) t = Math.min(t, 2);
    } else {
      if (CC[key] && hasElite(a, 'warded')) return;
      if (a.boss && CC[key]) { if (a.cd.cc > 0) return; t = 1; a.cd.cc = 5; }
      if (key === 'burn' && (a.fireproof || (MON[a.k] && MON[a.k].fireproof))) return;
      if (key === 'poison' && a.fam === 'construct') return;
    }
    if (DOTS[key]) {
      var cur = a.st[key];
      a.st[key] = { t: Math.max(cur ? cur.t : 0, t), d: Math.max(cur ? cur.d : 0, Math.max(1, Math.round(v || 1))) };
    } else if (key === 'shield') a.st.shield = { v: Math.round(v), t: t };
    else a.st[key] = Math.max(a.st[key] || 0, t);
    if ((key === 'stun' || key === 'frozen') && !isP && a.intent && !a.boss) { a.intent = null; log(G, displayName(a) + '\'s attack is interrupted!', 'good'); }
    if ((key === 'stun' || key === 'frozen') && a.boss && a.intent) { a.intent = null; log(G, displayName(a) + ' staggers!', 'good'); }
    emit(G, { t: 'status', x: a.x, y: a.y, k: key });
  }
  function cleanse(a) { ['poison', 'burn', 'bleed', 'root', 'slow', 'weaken', 'dark'].forEach(function (k) { delete a.st[k]; }); }

  // ===========================================================================
  //  combat
  // ===========================================================================
  var UNDEADISH = { undead: 1, abyssal: 1 };
  // strike(G, attacker, defender, opts) → damage dealt (0 = missed/blocked)
  function strike(G, att, def, o) {
    if (!def || def.hp <= 0) return 0;
    o = o || {};
    var h = G.hero, isP = att === G.p, defP = def === G.p, s = (isP || defP || (att && att.ally)) ? pstats(G) : null;
    var r = G.r, kind = o.kind || 'melee';
    var dmg, crit = false;
    if (o.flat != null) dmg = o.flat;
    else {
      var pow = isP ? s.pow : att.ally ? att.pow : att.pow;
      if (!isP && hasElite(att, 'berserk') && att.hp < att.maxHp * 0.5) pow *= 1.6;
      if (att.st && att.st.weaken) pow *= 0.7;
      dmg = pow * (o.mult == null ? 1 : o.mult) * (0.85 + rf(r) * 0.3);
    }
    if (isP) {
      if (o.ability) dmg *= 1 + s.abilPct + (s.flags.archmage ? 0.2 : 0);
      if (o.elem === 'fire' && s.flags.pyro) dmg *= 1.25;
      if (def.elite || def.boss) dmg *= 1 + s.elite + (s.flags.wrath ? 0.3 : 0);
      if (def.boss && s.flags.u_king) dmg *= 1.4;
      if (UNDEADISH[def.fam] && s.flags.u_dawn) dmg *= 1.5;
      if (def.fam === 'undead' && s.flags.s_lantern) dmg *= 1.25;
      if (s.flags.pack && G.mons.some(function (m) { return m.ally && m.k === 'wolf' && cheb(m.x, m.y, def.x, def.y) <= 1; })) dmg *= 1.25;
      if (G.p.st.unbreak && s.flags.avatar) dmg *= 1.35;
      if (G.p.st.invis && s.flags.cloak && (kind === 'melee' || kind === 'ranged')) dmg *= 3;
      if (G.daily && G.daily.mod === 'glass') dmg *= 1.5;
    }
    if (att && att.ally && s && s.flags.frenzy) dmg *= 1.5;
    if (att && att.ally && att.k === 'skelally' && s && s.flags.u_gravecaller) dmg *= 1.5;
    if (!defP) {
      if (def.st.mark) dmg *= 1.25;
      if (def.st.frozen && G.hero.cls === 'mage' && pstats(G).flags.shatter) dmg *= 1.5;
      if (def.st.burn && pstats(G).flags.combust) dmg *= 1.25;
      if (def.st.burn && pstats(G).flags.s_ember) dmg *= 1.3;
    } else if (G.daily && G.daily.mod === 'glass') dmg *= 1.5;
    // critical
    if (o.flat == null) {
      var cc = isP ? s.crit + (o.critBonus || 0) : att.ally ? 0.05 : ((MON[att.k] && MON[att.k].crit) || 0.05);
      if (isP && s.flags.deadeye && (kind === 'ranged') && cheb(att.x, att.y, def.x, def.y) >= 4) cc += 0.25;
      var force = o.forceCrit;
      if (isP && G.p.st.critNext && kind !== 'dot') { force = true; delete G.p.st.critNext; }
      if (isP && s.flags.u_whisper && !G.p.hitIds[def.id]) force = true;
      if (force || rf(r) < cc) { crit = true; dmg *= 1.5 + (isP ? s.critDmg : 0); }
      if (isP) G.p.hitIds[def.id] = 1;
    }
    // dodge / block (telegraphed and true damage can't be dodged — you dodge those by moving)
    if (!o.noDodge && (kind === 'melee' || kind === 'ranged')) {
      var dg = defP ? s.dodge : (def.k === 'shade' ? 0.15 : 0);
      if (dg > 0 && rf(r) < dg) {
        emit(G, { t: 'miss', x: def.x, y: def.y });
        if (defP && s.flags.s_shadow) G.p.st.critNext = 1;
        if (defP && kind === 'melee' && s.flags.riposte && att.hp > 0) { log(G, 'Riposte!', 'good'); strike(G, def, att, { mult: 1, kind: 'melee', noDodge: true, counter: true }); }
        return 0;
      }
      if (defP && s.block > 0 && rf(r) < s.block) { emit(G, { t: 'block', x: def.x, y: def.y }); log(G, 'Blocked!', 'good'); return 0; }
    }
    // armor
    if (kind !== 'true' && kind !== 'dot') {
      var arm = defP ? s.arm : def.arm, lv = isP ? h.level : att.lvl || h.level;
      if (def.st && def.st.frozen) arm *= 0.7;
      dmg *= 1 - arm / (arm + 12 + 2 * lv);
    }
    dmg = Math.max(1, Math.round(dmg));
    if (defP && G.p.st.inv) { emit(G, { t: 'immune', x: def.x, y: def.y }); return 0; }
    if (defP && G.p.st.unbreak) dmg = Math.max(1, Math.round(dmg * 0.4));
    // shield, mana shield
    var absorbed = 0;
    if (def.st.shield && def.st.shield.v > 0) {
      absorbed = Math.min(def.st.shield.v, dmg); def.st.shield.v -= absorbed; dmg -= absorbed;
      if (def.st.shield.v <= 0) { delete def.st.shield; emit(G, { t: 'fx', k: 'shieldbreak', x: def.x, y: def.y }); if (defP && s.flags.martyr) martyr(G); }
    }
    if (defP && dmg > 0 && s.flags.manashield && G.p.res > 0) { var take = Math.min(Math.round(dmg * 0.3), G.p.res); G.p.res -= take; dmg -= take; absorbed += take; }
    def.hp -= dmg;
    if (defP && G.p.st.unbreak && def.hp < 1) def.hp = 1;
    emit(G, { t: 'dmg', x: def.x, y: def.y, n: dmg, ab: absorbed, crit: crit, p: defP, ally: !!def.ally, elem: o.elem || kind, from: att ? [att.x, att.y] : null });
    if (!defP) { def.asleep = false; def.aware = true; if (def.disguised) def.disguised = false; }
    // after-effects
    if (isP && dmg > 0) {
      if (s.lifesteal > 0) heal(G, G.p, dmg * s.lifesteal, true);
      if (o.basic) {
        var cr = C[h.cls].res;
        if (cr.hit) gainRes(G, cr.hit * (s.flags.avatar && G.p.st.unbreak ? 2 : 1));
        if (s.flags.crusader) gainRes(G, 6);
        if (s.flags.spellblade) gainRes(G, 3);
        if (s.flags.hitHeal) heal(G, G.p, s.maxHp * 0.03, true);
      }
      if (crit && s.flags.steady) gainRes(G, 10);
      if (crit && s.flags.deathmark) addStatus(G, def, 'mark', 4);
      if (o.basic || o.procs) {
        if (s.burnOnHit && rf(r) < s.burnOnHit) addStatus(G, def, 'burn', 4, s.pow * 0.25);
        if (s.poisonOnHit && rf(r) < s.poisonOnHit) addStatus(G, def, 'poison', 5, s.pow * 0.2 * (s.flags.virulence ? 1.5 : 1));
        if (s.stunOnHit && rf(r) < s.stunOnHit) addStatus(G, def, 'stun', 1);
        if (s.freezeOnHit && rf(r) < s.freezeOnHit) addStatus(G, def, 'frozen', 1);
        if (s.flags.u_storm && rf(r) < 0.15) arcTo(G, def, s.pow * 0.6);
      }
    }
    if (!isP && !(att && att.ally) && defP && dmg > 0 && att) {
      var M = MON[att.k];
      if (M && M.onHit) for (var k in M.onHit) if (rf(r) < M.onHit[k]) addStatus(G, def, k, k === 'root' ? 2 : k === 'weaken' ? 3 : 4, att.pow * 0.22);
      if (hasElite(att, 'venomous') && rf(r) < 0.5) addStatus(G, def, 'poison', 4, att.pow * 0.25);
      if (hasElite(att, 'molten') && rf(r) < 0.4) addStatus(G, def, 'burn', 3, att.pow * 0.25);
      if (hasElite(att, 'vampiric')) heal(G, att, dmg * 0.6, true);
      if (att.k === 'cutpurse' && !att.stolen && G.hero.gold > 0) {
        var st = Math.min(G.hero.gold, Math.max(5, Math.round(G.hero.gold * 0.12)));
        G.hero.gold -= st; att.stolen = st; att.fleeT = 0; log(G, 'The cutpurse snatches ' + st + ' gold!', 'bad'); emit(G, { t: 'fx', k: 'steal', x: def.x, y: def.y });
      }
      if (M && M.pull && def.hp > 0) pullToward(G, def, att);
      gainRes(G, C[h.cls].res.hurt || 0);
    }
    if (defP && kind === 'melee' && att && att.hp > 0 && !o.counter) {
      if (s.thorns > 0) strike(G, def, att, { flat: Math.max(1, Math.round(dmg * s.thorns)), kind: 'true', counter: true });
      if (s.flags.retaliate && rf(r) < 0.25) { log(G, 'You retaliate!', 'good'); strike(G, def, att, { mult: 1, kind: 'melee', counter: true, noDodge: true }); }
      if (s.flags.glacial && rf(r) < 0.3) addStatus(G, att, 'frozen', 1);
    }
    if (!defP && kind === 'melee' && hasElite(def, 'thorned') && isP && !o.counter) strike(G, def, att, { flat: Math.max(1, Math.round(dmg * 0.25)), kind: 'true', counter: true });
    if (def.boss) bossPhaseCheck(G, def);
    if (def.hp <= 0) { if (defP) playerDown(G, att); else killMon(G, def, att); }
    else if (defP) lowHpCheck(G);
    return dmg;
  }
  function pstats(G) { if (!G._ps) G._ps = stats(G.hero, G); return G._ps; }
  function gainRes(G, n) { if (!n) return; var s = pstats(G); G.p.res = clamp(G.p.res + n, 0, s.maxRes); }
  function heal(G, a, n, quiet) {
    n = Math.round(n); if (n <= 0 || a.hp <= 0) return 0;
    var mx = a === G.p ? pstats(G).maxHp : a.maxHp, before = a.hp;
    a.hp = Math.min(mx, a.hp + n);
    var got = a.hp - before;
    if (got > 0) emit(G, { t: 'heal', x: a.x, y: a.y, n: got, quiet: !!quiet });
    return got;
  }
  function arcTo(G, from, d) {
    var best = null;
    G.mons.forEach(function (m) { if (m !== from && !m.ally && m.hp > 0 && cheb(m.x, m.y, from.x, from.y) <= 3 && (!best || cheb(m.x, m.y, from.x, from.y) < cheb(best.x, best.y, from.x, from.y))) best = m; });
    if (best) { emit(G, { t: 'proj', k: 'zap', x0: from.x, y0: from.y, x1: best.x, y1: best.y }); strike(G, G.p, best, { flat: Math.round(d), kind: 'true', elem: 'shock' }); }
  }
  function pullToward(G, who, to) {
    var dx = sgn(to.x - who.x), dy = sgn(to.y - who.y);
    if (Math.abs(to.x - who.x) >= Math.abs(to.y - who.y)) dy = 0; else dx = 0;
    var nx = who.x + dx, ny = who.y + dy;
    if (WALKABLE[tile(G, nx, ny)] && !actorAt(G, nx, ny) && !blocksObj(G, nx, ny) && tile(G, nx, ny) !== T.CHASM) {
      who.x = nx; who.y = ny; log(G, 'The siren\'s song drags you closer!', 'bad');
      if (who === G.p) stepOn(G, true);
    }
  }
  function martyr(G) {
    var s = pstats(G);
    emit(G, { t: 'fx', k: 'nova', x: G.p.x, y: G.p.y, r: 1, col: '#ffe08a' });
    G.mons.slice().forEach(function (m) { if (!m.ally && m.hp > 0 && cheb(m.x, m.y, G.p.x, G.p.y) <= 1) strike(G, G.p, m, { mult: 1.5, kind: 'spell', elem: 'holy', ability: true, noDodge: true }); });
  }
  function lowHpCheck(G) {
    var s = pstats(G), tf = talentFlags(G.hero);
    for (var id in tf) {
      var t = tf[id]; if (!t.lowhp || G.p.onceFloor[id]) continue;
      if (G.p.hp < s.maxHp * (t.lowhp.at || 0.3)) {
        G.p.onceFloor[id] = 1;
        if (t.lowhp.heal) { heal(G, G.p, s.maxHp * t.lowhp.heal); log(G, t.name + '!', 'good'); }
        if (t.lowhp.invis) { G.p.st.invis = t.lowhp.invis; loseTrack(G); log(G, t.name + ' — you vanish in smoke!', 'good'); emit(G, { t: 'fx', k: 'smoke', x: G.p.x, y: G.p.y }); }
      }
    }
  }
  function playerDown(G, killer) {
    var s = pstats(G), tf = talentFlags(G.hero);
    for (var id in tf) {
      var t = tf[id]; if (!t.cheat || G.p.onceFloor[id]) continue;
      G.p.onceFloor[id] = 1;
      G.p.hp = Math.max(1, Math.round(s.maxHp * t.cheat.heal));
      if (t.cheat.inv) G.p.st.inv = t.cheat.inv;
      log(G, t.name + '! You refuse to fall.', 'good');
      emit(G, { t: 'fx', k: 'revive', x: G.p.x, y: G.p.y });
      return;
    }
    G.p.hp = 0;
    G.over = 'dead';
    G.killer = killer && killer !== G.p ? displayName(killer) : (G.lastHazard || 'the Deep');
    emit(G, { t: 'death' });
  }
  function goldAmount(G, r, base) {
    var s = stats(G.hero, G), d = difficulty(G.hero);
    var g = base * (1 + 0.35 * (G.ml - 1)) * (0.7 + rf(r) * 0.6) * d.rew * (1 + s.goldFind);
    if (G.daily && G.daily.mod === 'rich') g *= 2;
    return Math.max(1, Math.round(g));
  }
  function dropNear(G, x, y, o) {
    var spots = [[0, 0]].concat(DIRS8, [[2, 0], [-2, 0], [0, 2], [0, -2]]);
    for (var i = 0; i < spots.length; i++) {
      var nx = x + spots[i][0], ny = y + spots[i][1];
      if (!WALKABLE[tile(G, nx, ny)] || tile(G, nx, ny) === T.CHASM || tile(G, nx, ny) === T.LAVA || tile(G, nx, ny) === T.STAIRS) continue;
      if (G.objs.some(function (q) { return q.x === nx && q.y === ny && (BLOCKING[q.k] || q.k === 'item' || q.k === 'gold' || q.k === 'cons'); })) continue;
      o.x = nx; o.y = ny; return addObj(G, o);
    }
    o.x = x; o.y = y; return addObj(G, o);
  }
  function lootItem(G, o) {
    var s = pstats(G);
    o = o || {};
    return makeItem(G.r, { ilvl: G.ml, luck: (o.luck || 0) + s.magicFind, cls: chance(G.r, 0.7) ? G.hero.cls : null, minRarity: o.minRarity, act: clamp(actAt(((G.depth - 1) % 25) + 1) + (G.hero.story.ng || 0), 1, 5), slot: o.slot });
  }
  function dropLoot(G, m) {
    var r = G.r, d = difficulty(G.hero);
    if (m.stolen) dropNear(G, m.x, m.y, { k: 'gold', n: m.stolen });
    if (chance(r, m.elite ? 1 : 0.45)) dropNear(G, m.x, m.y, { k: 'gold', n: goldAmount(G, r, m.gold) });
    if (m.elite || chance(r, 0.07 * d.rew * (G.daily && G.daily.mod === 'elites' ? 1.5 : 1))) dropNear(G, m.x, m.y, { k: 'item', it: lootItem(G, { minRarity: m.elite ? 'magic' : null, luck: m.elite ? 0.4 : 0 }) });
    if (chance(r, 0.05)) dropNear(G, m.x, m.y, { k: 'cons', id: pick(r, ['potion', 'potion', 'potion', 'tonic', 'elixir', 'bomb']), n: 1 });
  }
  function killMon(G, m, killer) {
    m.hp = 0;
    var i = G.mons.indexOf(m); if (i >= 0) G.mons.splice(i, 1);
    emit(G, { t: 'die', id: m.id, x: m.x, y: m.y, ch: m.ch, col: m.col, boss: !!m.boss, ally: !!m.ally, elite: !!m.elite });
    if (m.ally) { log(G, m.name + ' crumbles.', 'info'); return; }
    var h = G.hero, s = pstats(G), r = G.r;
    if (m.intent && m.intent.k === 'fuse') { m.intent.t = 0; resolveIntent(G, m, true); }
    if (m.k === 'magmite' && !m.exploded) { m.exploded = true; explodeAt(G, m.x, m.y, 1, m.pow * 1.2, m, '#ff6a2a'); }
    var xpMult = G.mode === 'daily' ? 2.5 : 1;
    gainXp(G, h, m.xp * xpMult);
    G.run.kills++; h.stats.kills++;
    if (m.elite) { G.run.elites++; h.stats.elites++; }
    if (m.k !== 'boss') h.bestiary[m.k] = (h.bestiary[m.k] || 0) + 1; else h.bestiary['boss:' + m.boss] = (h.bestiary['boss:' + m.boss] || 0) + 1;
    bounty(G, 'kill', { fam: m.fam, elite: !!m.elite });
    log(G, (killer === G.p ? 'You slay ' : '') + (killer === G.p ? 'the ' + displayName(m) : displayName(m) + ' dies') + '.', 'kill');
    if (cheb(m.x, m.y, G.p.x, G.p.y) <= 6 && s.resKill) gainRes(G, s.resKill);
    if (s.flags.rampage) { var rs = G.p.st.ramp || { n: 0, t: 0 }; G.p.st.ramp = { n: Math.min(5, rs.n + 1), t: 8 }; }
    if (s.flags.harvest) G.p.harvest = Math.min(15, (G.p.harvest || 0) + 1);
    if (s.flags.dance) gainRes(G, 15);
    if (s.flags.u_blood) heal(G, G.p, s.maxHp * 0.05, true);
    if (s.flags.s_lantern) heal(G, G.p, s.maxHp * 0.04, true);
    G._ps = null;
    var M = MON[m.k] || {};
    var t = tile(G, m.x, m.y);
    if (m.fam !== 'spirit' && m.fam !== 'elemental' && t !== T.CHASM && t !== T.LAVA && t !== T.DEEP && !m.boss && !m.small) {
      var corpses = G.objs.filter(function (o) { return o.k === 'corpse'; });
      if (corpses.length > 30) G.objs.splice(G.objs.indexOf(corpses[0]), 1);
      addObj(G, { k: 'corpse', x: m.x, y: m.y, ch: m.ch, col: m.col, fam: m.fam });
    }
    if (s.flags.u_gravecaller && chance(r, 0.2)) raiseAt(G, m.x, m.y, 0);
    if (M.deathGas) { gasAt(G, m.x, m.y, 1, 4, m.pow * 0.4); log(G, 'The sporeling bursts into a toxic cloud!', 'bad'); }
    if ((M.splits || hasElite(m, 'splitting')) && !m.small) {
      var n = 0;
      for (var k = 0; k < 8 && n < 2; k++) {
        var nx = m.x + DIRS8[k][0], ny = m.y + DIRS8[k][1];
        if (!canEnter(G, { k: m.k, ai: 'melee' }, nx, ny) || actorAt(G, nx, ny)) continue;
        var c = spawnMon(G, m.k, nx, ny, { aware: true, scale: 0.45, lvl: m.lvl }); c.small = true; c.name = 'Lesser ' + c.name; n++;
      }
      if (n) log(G, displayName(m) + ' splits apart!', 'bad');
    }
    if (hasElite(m, 'molten')) fireAt(G, m.x, m.y, 1, 4, m.pow * 0.3);
    if (s.flags.plague && m.st.poison) G.mons.forEach(function (o) { if (!o.ally && cheb(o.x, o.y, m.x, m.y) <= 1) addStatus(G, o, 'poison', 5, m.st.poison.d); });
    if (m.boss) bossDown(G, m);
    else dropLoot(G, m);
  }

  // ---- area helpers ----------------------------------------------------------
  function gasAt(G, x, y, rad, t, d) {
    for (var yy = y - rad; yy <= y + rad; yy++) for (var xx = x - rad; xx <= x + rad; xx++) {
      if (!inb(G, xx, yy) || !WALKABLE[tile(G, xx, yy)]) continue;
      var k = yy * G.w + xx, cur = G.gas[k];
      G.gas[k] = { t: Math.max(cur ? cur.t : 0, t), d: Math.max(cur ? cur.d : 0, Math.max(1, Math.round(d))) };
    }
  }
  function fireAt(G, x, y, rad, t, d) {
    for (var yy = y - rad; yy <= y + rad; yy++) for (var xx = x - rad; xx <= x + rad; xx++) {
      if (!inb(G, xx, yy) || !WALKABLE[tile(G, xx, yy)]) continue;
      var tt = tile(G, xx, yy); if (tt === T.WATER || tt === T.DEEP) continue;
      var k = yy * G.w + xx; G.fire[k] = { t: t, d: Math.max(1, Math.round(d)) };
    }
  }
  function explodeAt(G, x, y, rad, d, src, col) {
    emit(G, { t: 'fx', k: 'boom', x: x, y: y, r: rad, col: col || '#ff8a3a' }); emit(G, { t: 'shake', n: 6 });
    var hits = [];
    for (var yy = y - rad; yy <= y + rad; yy++) for (var xx = x - rad; xx <= x + rad; xx++) {
      var a = actorAt(G, xx, yy); if (a && a !== src) hits.push(a);
      if (tile(G, xx, yy) === T.CRACK) { setT(G, xx, yy, T.FLOOR); log(G, 'The cracked wall crumbles!', 'info'); }
    }
    hits.forEach(function (a) { if (a.hp > 0) strike(G, src && src.hp > 0 ? src : null, a, { flat: Math.round(d), kind: 'true', elem: 'fire' }); });
  }
  function noise(G, x, y, rad) { G.mons.forEach(function (m) { if (!m.ally && m.asleep && cheb(m.x, m.y, x, y) <= rad && chance(G.r, 0.5)) { m.asleep = false; m.aware = true; } }); }
  function loseTrack(G) { G.mons.forEach(function (m) { if (!m.ally && !m.boss) { m.aware = false; m.intent = null; m.lastSeen = [G.p.x, G.p.y]; } }); }

  // ===========================================================================
  //  player actions
  // ===========================================================================
  function hostilesVisible(G) { return G.mons.filter(function (m) { return !m.ally && m.hp > 0 && monVisible(G, m) && !m.disguised; }); }
  function basicAttack(G, m) {
    var h = G.hero, s = pstats(G), p = G.p;
    var mult = h.cls === 'ranger' ? 0.7 : 1;
    if (s.flags.crusader) mult *= 1.2;
    if (s.flags.spellblade) mult *= 1.4;
    emit(G, { t: 'atk', id: 0, x: p.x, y: p.y, tx: m.x, ty: m.y });
    var dealt = strike(G, p, m, { mult: mult, kind: 'melee', basic: true });
    noise(G, p.x, p.y, 5);
    if (s.flags.hammer) G.mons.slice().forEach(function (o) { if (o !== m && !o.ally && o.hp > 0 && cheb(o.x, o.y, p.x, p.y) <= 1) strike(G, p, o, { mult: 0.35, kind: 'spell', elem: 'holy', noDodge: true }); });
    if (s.flags.flurry) { var o2 = G.mons.filter(function (o) { return o !== m && !o.ally && o.hp > 0 && cheb(o.x, o.y, p.x, p.y) <= 1; })[0]; if (o2) strike(G, p, o2, { mult: 0.5 * mult, kind: 'melee', basic: true }); }
    if (s.flags.quake) { p.swings = (p.swings || 0) + 1; if (p.swings % 4 === 0) { emit(G, { t: 'fx', k: 'nova', x: p.x, y: p.y, r: 1, col: '#d0a060' }); emit(G, { t: 'shake', n: 4 }); G.mons.slice().forEach(function (o) { if (!o.ally && o.hp > 0 && cheb(o.x, o.y, p.x, p.y) <= 1) strike(G, p, o, { mult: 0.8, kind: 'melee', noDodge: true }); }); } }
    if (p.st.invis && !(s.flags.cloak && m.hp <= 0)) delete p.st.invis;
    return dealt;
  }
  function playerMove(G, dx, dy) {
    var p = G.p, nx = p.x + dx, ny = p.y + dy;
    p.face = [dx, dy];
    if (!inb(G, nx, ny)) return 0;
    var m = monAt(G, nx, ny);
    if (m && m.ally) {
      if (p.st.root) { log(G, 'You are rooted in place!', 'bad'); return 100; }
      m.x = p.x; m.y = p.y; p.x = nx; p.y = ny; stepOn(G); return 100;
    }
    if (m) {
      if (m.disguised) { m.disguised = false; m.aware = true; log(G, 'The chest has TEETH!', 'bad'); emit(G, { t: 'shake', n: 5 }); }
      basicAttack(G, m); return 100;
    }
    var o = blocksObj(G, nx, ny);
    if (o) {
      if (o.k === 'boulder') return pushBoulder(G, o, dx, dy);
      return interact(G, o);
    }
    var t = tile(G, nx, ny);
    if (t === T.WALL || t === T.CRACK) { emit(G, { t: 'bump', dx: dx, dy: dy }); return 0; }
    if (t === T.GATE) { log(G, G.hero.cons.key ? 'The gate is sealed. (Press Use with a Skeleton Key to force it.)' : 'The gate is sealed. Something nearby must open it.', 'info'); return 0; }
    if (t === T.DEEP) { log(G, 'The water is too deep to wade.', 'info'); return 0; }
    var s = pstats(G);
    if (t === T.CHASM && p.confirm !== 'c' + nx + ',' + ny) { p.confirm = 'c' + nx + ',' + ny; log(G, 'The chasm yawns below. Step again to jump down to the next floor (and take a fall).', 'warn'); return 0; }
    if (t === T.LAVA && !s.flags.u_ember && p.confirm !== 'l' + nx + ',' + ny) { p.confirm = 'l' + nx + ',' + ny; log(G, 'That is lava. Step again if you really mean it.', 'warn'); return 0; }
    p.confirm = null;
    if (p.st.root) { log(G, 'You are rooted in place!', 'bad'); return 100; }
    var wasAdj = s.flags.hop && G.mons.some(function (q) { return !q.ally && q.hp > 0 && manh(q.x, q.y, p.x, p.y) === 1; });
    if (t === T.DOOR) setT(G, nx, ny, T.ODOOR);
    p.x = nx; p.y = ny; p.moved = true;
    if (wasAdj && !G.mons.some(function (q) { return !q.ally && q.hp > 0 && manh(q.x, q.y, p.x, p.y) === 1; })) gainRes(G, 20);
    if (s.flags.sanctified && p.st.sanct) consecrateAt(G, p.x, p.y, s.flags.holyground ? 2 : 1, p.st.sanct, s.pow * 0.55);
    stepOn(G);
    return 100;
  }
  function pushBoulder(G, o, dx, dy) {
    var bx = o.x + dx, by = o.y + dy, t = tile(G, bx, by);
    if (!(t === T.FLOOR || t === T.ODOOR || t === T.WATER || t === T.OGATE) || actorAt(G, bx, by) || G.objs.some(function (q) { return q.x === bx && q.y === by && q.k !== 'plate' && q.k !== 'corpse'; })) { log(G, 'The boulder won\'t budge that way.', 'info'); return 0; }
    o.x = bx; o.y = by; G.p.x += dx; G.p.y += dy; G.p.moved = true;
    emit(G, { t: 'snd', k: 'push' });
    checkPlates(G, o.pz);
    stepOn(G);
    return 100;
  }
  function checkPlates(G, pz) {
    var P = G.pz[pz]; if (!P || P.solved) return;
    var plates = G.objs.filter(function (q) { return q.k === 'plate' && q.pz === pz; });
    plates.forEach(function (pl) { pl.on = !!objAt(G, pl.x, pl.y, 'boulder'); });
    if (plates.length && plates.every(function (pl) { return pl.on; })) solve(G, pz);
  }
  function solve(G, pz) {
    var P = G.pz[pz]; if (!P || P.solved) return;
    P.solved = true;
    P.gates.forEach(function (g) { setT(G, g[0], g[1], T.OGATE); emit(G, { t: 'fx', k: 'gate', x: g[0], y: g[1] }); });
    G.run.puzzles++; G.hero.stats.puzzles++;
    bounty(G, 'puzzle');
    gainXp(G, G.hero, 12 * G.ml);
    log(G, P.kind === 'stairvault' ? 'With a groan, the gate to the stairs grinds open!' : 'Somewhere nearby, a gate grinds open!', 'good');
    emit(G, { t: 'snd', k: 'solve' });
  }
  function interact(G, o) {
    var h = G.hero;
    if (o.k === 'chest') return openChest(G, o);
    if (o.k === 'lever') {
      var P = G.pz[o.pz];
      if (o.reset) {
        if (P && P.solved) { log(G, 'The mechanism has already done its work.', 'info'); return 0; }
        G.objs.forEach(function (b) { if (b.k === 'boulder' && b.pz === o.pz && !actorAt(G, b.home[0], b.home[1])) { b.x = b.home[0]; b.y = b.home[1]; } });
        checkPlates(G, o.pz); log(G, 'Clank — the boulders roll back to where they started.', 'info'); emit(G, { t: 'snd', k: 'lever' }); return 100;
      }
      if (o.on) { log(G, 'The lever is already pulled.', 'info'); return 0; }
      o.on = true; emit(G, { t: 'snd', k: 'lever' });
      var all = G.objs.filter(function (q) { return q.k === 'lever' && q.pz === o.pz && !q.reset; });
      var left = all.filter(function (q) { return !q.on; }).length;
      if (!left) solve(G, o.pz); else log(G, 'Clunk. Somewhere a mechanism shifts — ' + left + ' more lever' + (left > 1 ? 's' : '') + ' to go.', 'info');
      return 100;
    }
    if (o.k === 'tablet') { G.modal = { k: 'tablet', pz: o.pz }; return 0; }
    if (o.k === 'event') {
      if (o.used) { log(G, 'Nothing more happens here.', 'info'); return 0; }
      G.modal = { k: 'event', id: o.id, oid: o.oid };
      return 0;
    }
    return 0;
  }
  function openChest(G, o) {
    var r = G.r;
    if (o.mimic) {
      G.objs.splice(G.objs.indexOf(o), 1);
      var m = spawnMon(G, 'mimic', o.x, o.y, { aware: true });
      log(G, 'The chest lunges at you — a MIMIC!', 'bad'); emit(G, { t: 'shake', n: 6 });
      strike(G, m, G.p, { mult: 1.2, kind: 'melee' });
      return 100;
    }
    G.objs.splice(G.objs.indexOf(o), 1);
    G.deco.push({ x: o.x, y: o.y, k: 'openchest' });
    emit(G, { t: 'snd', k: 'chest' }); emit(G, { t: 'fx', k: 'sparkle', x: o.x, y: o.y });
    dropNear(G, o.x, o.y, { k: 'gold', n: goldAmount(G, r, o.vault ? 30 : 12) });
    var n = o.vault ? rr(r, 1, 2) : 1;
    for (var i = 0; i < n; i++) dropNear(G, o.x, o.y, { k: 'item', it: lootItem(G, { minRarity: o.vault ? 'rare' : (chance(r, 0.5) ? 'magic' : null), luck: o.vault ? 0.8 : 0.2 }) });
    if (chance(r, 0.35)) dropNear(G, o.x, o.y, { k: 'cons', id: pick(r, ['potion', 'potion', 'tonic', 'bomb', 'elixir', 'recall']), n: 1 });
    log(G, o.vault ? 'The vault chest spills its treasure!' : 'You open the chest.', 'good');
    stepOn(G, true);
    return 100;
  }
  // stepping onto a tile: pick things up, spring traps, press runes
  function stepOn(G, quiet) {
    var p = G.p, h = G.hero, here = objsAt(G, p.x, p.y);
    for (var i = 0; i < here.length; i++) {
      var o = here[i];
      if (o.k === 'gold') { h.gold += o.n; G.run.gold += o.n; h.stats.gold += o.n; bounty(G, 'gold', { n: o.n }); rm(G, o); emit(G, { t: 'pick', k: 'gold', x: p.x, y: p.y, n: o.n }); }
      else if (o.k === 'cons') { h.cons[o.id] = (h.cons[o.id] || 0) + o.n; rm(G, o); log(G, 'Picked up ' + D.CONSUMABLES[o.id].name + (o.n > 1 ? ' ×' + o.n : '') + '.', 'loot'); emit(G, { t: 'pick', k: 'cons', x: p.x, y: p.y }); }
      else if (o.k === 'item') {
        if (h.bag.length >= BAG_MAX) { if (!quiet) log(G, 'Your pack is full (' + BAG_MAX + '). Drop or salvage something.', 'warn'); continue; }
        o.it.fresh = 1; h.bag.push(o.it); rm(G, o); G.run.items++;
        log(G, 'Found: ' + o.it.name + ' (' + D.RARITIES[o.it.rarity].name + ').', 'loot:' + o.it.rarity);
        emit(G, { t: 'pick', k: 'item', x: p.x, y: p.y, rarity: o.it.rarity });
      }
      else if (o.k === 'lore') {
        rm(G, o);
        if (h.lore.indexOf(o.idx) < 0) { h.lore.push(o.idx); G.run.lore++; bounty(G, 'lore'); gainXp(G, h, 8 * G.ml); }
        G.modal = { k: 'lore', idx: o.idx };
      }
      else if (o.k === 'quest') {
        rm(G, o); h.quests.side[o.q] = 'found';
        var SQ = D.SIDEQUESTS[o.q]; log(G, 'Found ' + SQ.item + '! Bring it to ' + D.NPCS[SQ.giver].name + '.', 'good');
        G.modal = { k: 'found', q: o.q };
      }
      else if (o.k === 'trap') springTrap(G, o);
      else if (o.k === 'rune') pressRune(G, o);
    }
  }
  function rm(G, o) { var i = G.objs.indexOf(o); if (i >= 0) G.objs.splice(i, 1); }
  function springTrap(G, o) {
    var TR = D.TRAPS[o.id], s = pstats(G), p = G.p;
    rm(G, o);
    log(G, TR.desc, 'bad'); emit(G, { t: 'fx', k: 'trap', x: p.x, y: p.y }); emit(G, { t: 'shake', n: 4 });
    G.lastHazard = 'a ' + TR.name.toLowerCase();
    if (TR.dmg) strike(G, null, p, { flat: Math.max(1, Math.round(s.maxHp * TR.dmg)), kind: 'true', elem: 'trap' });
    for (var k in TR.status || {}) addStatus(G, p, k, TR.status[k], s.maxHp * 0.03);
    if (TR.gas) gasAt(G, p.x, p.y, 1, 5, s.maxHp * 0.04);
    if (TR.alarm) G.mons.forEach(function (m) { if (!m.ally && cheb(m.x, m.y, p.x, p.y) <= 16) { m.asleep = false; m.aware = true; } });
    if (TR.tele) teleportRandom(G, p);
  }
  function teleportRandom(G, a) {
    for (var t = 0; t < 200; t++) {
      var x = ri(G.r, G.w), y = ri(G.r, G.h);
      if (tile(G, x, y) === T.FLOOR && !actorAt(G, x, y) && !blocksObj(G, x, y) && cheb(x, y, a.x, a.y) > 6) { a.x = x; a.y = y; return true; }
    }
    return false;
  }
  function pressRune(G, o) {
    var P = G.pz[o.pz]; if (!P || P.solved || o.lit) return;
    if (P.order[P.prog] === o.sym) {
      o.lit = true; P.prog++; emit(G, { t: 'fx', k: 'rune', x: o.x, y: o.y }); emit(G, { t: 'snd', k: 'rune' });
      if (P.prog >= 4) solve(G, o.pz); else log(G, 'The rune flares to life. (' + P.prog + '/4)', 'good');
    } else {
      var s = pstats(G);
      log(G, 'Wrong rune! A jolt of arcane force hurls the pattern back to darkness.', 'bad');
      strike(G, null, G.p, { flat: Math.max(1, Math.round(s.maxHp * 0.08)), kind: 'true', elem: 'shock' });
      G.lastHazard = 'a rune ward';
      P.prog = 0; G.objs.forEach(function (q) { if (q.k === 'rune' && q.pz === o.pz) q.lit = false; });
    }
  }
  function playerUse(G) {
    var p = G.p, t = tile(G, p.x, p.y), h = G.hero;
    if (t === T.STAIRS) { descend(G); return -1; }
    if (t === T.PORTAL) { G.over = 'portal'; emit(G, { t: 'portal' }); return -1; }
    // facing first, then any neighbor
    var order = [p.face].concat(DIRS4);
    for (var i = 0; i < order.length; i++) {
      var x = p.x + order[i][0], y = p.y + order[i][1], o = blocksObj(G, x, y);
      if (o && o.k !== 'boulder') return interact(G, o);
      if (tile(G, x, y) === T.GATE && h.cons.key) return useKeyAt(G, x, y);
    }
    var trap = null;
    for (i = 0; i < DIRS4.length; i++) { var q = objAt(G, p.x + DIRS4[i][0], p.y + DIRS4[i][1], 'trap'); if (q && !q.hidden) trap = q; }
    if (trap) return disarm(G, trap);
    var mons = G.mons.filter(function (m) { return !m.ally && m.hp > 0 && manh(m.x, m.y, p.x, p.y) === 1; });
    if (mons.length) { basicAttack(G, mons[0]); return 100; }
    log(G, 'Nothing to use here.', 'info');
    return 0;
  }
  function disarm(G, o) {
    var s = pstats(G), c = G.hero.cls === 'rogue' ? 0.85 : 0.55;
    if (s.flags.traps) c = 1;
    if (chance(G.r, c)) {
      rm(G, o); log(G, 'You disarm the ' + D.TRAPS[o.id].name.toLowerCase() + '.', 'good');
      gainXp(G, G.hero, 4 * G.ml);
      if (s.flags.traps) { var g = goldAmount(G, G.r, 6); G.hero.gold += g; G.run.gold += g; log(G, 'Salvaged ' + g + ' gold of trap parts.', 'loot'); }
    } else { log(G, 'Your hand slips…', 'bad'); var px = G.p.x, py = G.p.y; G.p.x = o.x; G.p.y = o.y; springTrap(G, o); G.p.x = px; G.p.y = py; }
    return 100;
  }
  function useKeyAt(G, x, y) {
    var h = G.hero; if (!h.cons.key) return 0;
    h.cons.key--;
    for (var pz in G.pz) if (G.pz[pz].gates.some(function (g) { return g[0] === x && g[1] === y; })) { solve(G, pz); return 100; }
    setT(G, x, y, T.OGATE); log(G, 'The skeleton key turns. The gate opens.', 'good'); return 100;
  }
  function descend(G, fell) {
    var h = G.hero, s = pstats(G);
    G.run.floors++; h.stats.floors++;
    // blessings/curses last a number of floors
    h.bless = (h.bless || []).filter(function (b) { b.n--; if (b.n <= 0) log(G, D.BLESSINGS[b.id].name + ' fades.', 'info'); return b.n > 0; });
    var nd = G.depth + 1;
    if (G.mode === 'story') {
      h.story.deepest = Math.max(h.story.deepest, nd);
      if ((nd - 1) % 5 === 0 && h.story.waypoints.indexOf(nd) < 0) { h.story.waypoints.push(nd); h.story.waypoints.sort(function (a, b) { return a - b; }); }
      if (nd > D.STORY_FLOORS) h.story.endless = Math.max(h.story.endless || 0, nd);
    }
    bounty(G, 'depth', { d: nd });
    // minions stay behind, except wolves
    var keep = G.mons.filter(function (m) { return m.ally && m.k === 'wolf'; });
    genFloor(G, nd);
    keep.forEach(function (m) {
      for (var k = 0; k < 8; k++) { var x = G.p.x + DIRS8[k][0], y = G.p.y + DIRS8[k][1]; if (WALKABLE[tile(G, x, y)] && !actorAt(G, x, y) && !blocksObj(G, x, y)) { m.x = x; m.y = y; m.intent = null; G.mons.push(m); break; } }
    });
    if (fell) { var d = Math.round(s.maxHp * 0.12); G.p.hp = Math.max(1, G.p.hp - d); log(G, 'You plummet into the dark and land hard (−' + d + ').', 'bad'); emit(G, { t: 'shake', n: 8 }); }
    var B = D.BIOMES[G.biome];
    log(G, (G.boss ? '⚠ ' : '') + 'Floor ' + nd + ' — ' + B.name + '. ' + (G.boss ? 'Something vast waits ahead.' : pick(G.r, B.flavor)), G.boss ? 'warn' : 'floor');
    if (G.mode === 'story' && (nd - 1) % 5 === 0 && nd <= D.STORY_FLOORS) emit(G, { t: 'act', act: actAt(nd), biome: G.biome });
    return -1;
  }

  // ===========================================================================
  //  abilities
  // ===========================================================================
  function abilityCost(G, id) {
    var A = AB[id], s = pstats(G), c = A.cost;
    if (id === 'fan' && s.flags.cuts) c = 25;
    if (id === 'rain' && s.flags.volley) c -= 20;
    if (id === 'blink' && s.flags.phase) c = 0;
    if (s.flags.archmage) c *= 0.75;
    if (s.flags.s_deep) c *= 0.8;
    return Math.round(c);
  }
  function abilityCd(G, id) {
    var A = AB[id], s = pstats(G), cd = A.cd;
    if (id === 'charge' && s.flags.jugg) cd -= 3;
    if (id === 'shadowstep' && s.flags.dance) cd -= 3;
    if (id === 'snare' && s.flags.barbed) cd -= 4;
    if (id === 'dshield' && s.flags.aegis) cd -= 6;
    return Math.max(0, cd);
  }
  function abilityRange(G, id) {
    var A = AB[id], s = pstats(G), r = A.range || 0;
    if (id === 'charge' && s.flags.jugg) r = 6;
    if ((id === 'quickshot' || id === 'aimed') && s.range) r += s.range;
    return r;
  }
  function abilityState(G, id) {
    var h = G.hero, list = abilitiesFor(h), a = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) a = list[i];
    if (!a) return { ok: false, why: 'Not your ability.' };
    if (!a.known) return { ok: false, why: 'Unlocks at level ' + a.lvl + '.', locked: true };
    var cd = G.p.cd[id] || 0; if (cd > 0) return { ok: false, why: AB[id].name + ' recharges in ' + cd + '.', cd: cd };
    var cost = abilityCost(G, id); if (G.p.res < cost) return { ok: false, why: 'Not enough ' + C[h.cls].res.name + ' (' + cost + ').', cost: cost, short: true };
    return { ok: true, cost: cost };
  }
  // valid targets for the UI: [{x,y}], plus a default
  function abilityTargets(G, id) {
    var A = AB[id], p = G.p, R = abilityRange(G, id), out = [];
    if (A.target === 'enemy') {
      hostilesVisible(G).forEach(function (m) {
        var d = cheb(m.x, m.y, p.x, p.y);
        if (d > R || !los(G, p.x, p.y, m.x, m.y)) return;
        if (A.straight) { if ((m.x !== p.x && m.y !== p.y) || d < 2 || !clearPath(G, p.x, p.y, m.x, m.y)) return; }
        out.push({ x: m.x, y: m.y, m: m.id });
      });
      out.sort(function (a, b) { return cheb(a.x, a.y, p.x, p.y) - cheb(b.x, b.y, p.x, p.y); });
      var tgt = G.p.target && out.filter(function (o) { return o.m === G.p.target; })[0];
      return { list: out, def: tgt || out[0] || null };
    }
    if (A.target === 'corpse') {
      G.objs.forEach(function (o) { if (o.k === 'corpse' && visible(G, o.x, o.y) && cheb(o.x, o.y, p.x, p.y) <= R) out.push({ x: o.x, y: o.y }); });
      out.sort(function (a, b) { return cheb(a.x, a.y, p.x, p.y) - cheb(b.x, b.y, p.x, p.y); });
      if (id === 'corpseboom') { // prefer the corpse with the most enemies near it
        var bestN = -1, bestT = null;
        out.forEach(function (o) { var n = G.mons.filter(function (m) { return !m.ally && cheb(m.x, m.y, o.x, o.y) <= 1; }).length; if (n > bestN) { bestN = n; bestT = o; } });
        return { list: out, def: bestT };
      }
      return { list: out, def: out[0] || null };
    }
    if (A.target === 'tile' || A.target === 'line') {
      for (var y = p.y - R; y <= p.y + R; y++) for (var x = p.x - R; x <= p.x + R; x++) {
        if (!inb(G, x, y) || !visible(G, x, y) || (x === p.x && y === p.y)) continue;
        var t = tile(G, x, y);
        if (id === 'blink') { if (!WALKABLE[t] || t === T.CHASM || t === T.LAVA || actorAt(G, x, y) || blocksObj(G, x, y) || t === T.STAIRS && false) continue; }
        else if (OPAQUE[t]) continue;
        if (A.target === 'line' && !los(G, p.x, p.y, x, y)) continue;
        if (id === 'snare' && (!WALKABLE[t] || actorAt(G, x, y))) continue;
        out.push({ x: x, y: y });
      }
      // default: the nearest visible enemy (or the cluster center for area spells)
      var hv = hostilesVisible(G).filter(function (m) { return cheb(m.x, m.y, p.x, p.y) <= R; });
      var def = null;
      if (id === 'blink') {
        // away from the nearest enemy
        var near = hostilesVisible(G)[0];
        var best = -1; out.forEach(function (o) { var sc = cheb(o.x, o.y, p.x, p.y) + (near ? cheb(o.x, o.y, near.x, near.y) * 2 : 0); if (sc > best) { best = sc; def = o; } });
      } else if (hv.length) {
        var bc = -1; hv.forEach(function (m) { var n = hv.filter(function (o) { return cheb(o.x, o.y, m.x, m.y) <= (A.radius || 1); }).length; if (n > bc) { bc = n; def = { x: m.x, y: m.y }; } });
      } else if (out.length) def = out[0];
      return { list: out, def: def };
    }
    return { list: [], def: null };
  }
  function clearPath(G, x0, y0, x1, y1) {
    var dx = sgn(x1 - x0), dy = sgn(y1 - y0), x = x0 + dx, y = y0 + dy;
    while (x !== x1 || y !== y1) { if (!WALKABLE[tile(G, x, y)] || tile(G, x, y) === T.CHASM || actorAt(G, x, y) || blocksObj(G, x, y)) return false; x += dx; y += dy; }
    return true;
  }
  function hostileIn(G, cx, cy, rad) { return G.mons.filter(function (m) { return !m.ally && m.hp > 0 && cheb(m.x, m.y, cx, cy) <= rad && !m.disguised; }); }
  function minions(G) { return G.mons.filter(function (m) { return m.ally && m.owner === 'p' && m.k !== 'wolf'; }); }
  function raiseAt(G, x, y, ttl) {
    var s = pstats(G), spot = null;
    if (!actorAt(G, x, y) && WALKABLE[tile(G, x, y)]) spot = [x, y];
    for (var k = 0; k < 8 && !spot; k++) { var nx = x + DIRS8[k][0], ny = y + DIRS8[k][1]; if (WALKABLE[tile(G, nx, ny)] && tile(G, nx, ny) !== T.CHASM && !actorAt(G, nx, ny) && !blocksObj(G, nx, ny)) spot = [nx, ny]; }
    if (!spot) return null;
    var kind = s.flags.skelmages ? 'skelmage' : 'skelally';
    var m = spawnMon(G, kind, spot[0], spot[1], { ally: true, ttl: ttl || 0 });
    m.maxHp = m.hp = Math.round(s.maxHp * 0.42); m.pow = s.pow * (kind === 'skelmage' ? 0.42 : 0.5); m.arm = Math.round(s.arm * 0.5);
    if (s.flags.frenzy) m.spd = 150;
    emit(G, { t: 'fx', k: 'raise', x: spot[0], y: spot[1] });
    return m;
  }
  function consecrateAt(G, x, y, rad, t, d) {
    for (var yy = y - rad; yy <= y + rad; yy++) for (var xx = x - rad; xx <= x + rad; xx++) {
      if (!inb(G, xx, yy) || !WALKABLE[tile(G, xx, yy)]) continue;
      G.holy[yy * G.w + xx] = { t: t, d: Math.round(d) };
    }
  }
  function useAbility(G, id, tx, ty) {
    var st = abilityState(G, id); if (!st.ok) { log(G, st.why, 'info'); return 0; }
    var A = AB[id], p = G.p, h = G.hero, s = pstats(G), R = abilityRange(G, id), r = G.r;
    var target = null, did = true;
    if (A.target === 'enemy') {
      target = monAt(G, tx, ty);
      var tl = abilityTargets(G, id).list;
      if (!target || !tl.some(function (o) { return o.m === target.id; })) { log(G, 'No valid target there.', 'info'); return 0; }
      p.target = target.id;
    }
    if ((A.target === 'tile' || A.target === 'line' || A.target === 'corpse') && !abilityTargets(G, id).list.some(function (o) { return o.x === tx && o.y === ty; })) { log(G, 'Can\'t target that.', 'info'); return 0; }
    var opt = function (mult, extra) { var o = { mult: mult, kind: 'spell', ability: true, noDodge: true, procs: false }; for (var k in extra || {}) o[k] = extra[k]; return o; };
    switch (id) {
      case 'cleave':
        var adj = hostileIn(G, p.x, p.y, 1);
        if (!adj.length) { log(G, 'No enemies within reach.', 'info'); return 0; }
        emit(G, { t: 'fx', k: 'sweep', x: p.x, y: p.y, col: '#ffb070' });
        adj.forEach(function (m) { strike(G, p, m, opt(A.mult * (s.flags.cleaveBleed ? 1.4 : 1), { kind: 'melee', procs: true })); if (s.flags.cleaveBleed && m.hp > 0) addStatus(G, m, 'bleed', 4, s.pow * 0.25); });
        break;
      case 'charge':
        var dx = sgn(target.x - p.x), dy = sgn(target.y - p.y);
        var x0 = p.x, y0 = p.y;
        while (p.x + dx !== target.x || p.y + dy !== target.y) { p.x += dx; p.y += dy; }
        emit(G, { t: 'dash', x0: x0, y0: y0, x1: p.x, y1: p.y });
        strike(G, p, target, opt(A.mult, { kind: 'melee', procs: true }));
        if (target.hp > 0) addStatus(G, target, 'stun', 1);
        emit(G, { t: 'shake', n: 4 }); stepOn(G, true);
        break;
      case 'warcry':
        gainRes(G, A.gain * (s.flags.avatar && p.st.unbreak ? 2 : 1));
        emit(G, { t: 'fx', k: 'nova', x: p.x, y: p.y, r: 3, col: '#ff8a5a' });
        hostileIn(G, p.x, p.y, A.radius).forEach(function (m) { addStatus(G, m, 'weaken', 4); if (s.flags.cryStun) addStatus(G, m, 'stun', 1); });
        noise(G, p.x, p.y, 10);
        break;
      case 'execute':
        var thr = s.flags.execHi ? 0.5 : 0.35, mul = A.mult * (target.hp < target.maxHp * thr ? 2 : 1);
        emit(G, { t: 'atk', id: 0, x: p.x, y: p.y, tx: target.x, ty: target.y, heavy: true });
        strike(G, p, target, opt(mul, { kind: 'melee', procs: true }));
        if (target.hp <= 0) { gainRes(G, 20); emit(G, { t: 'shake', n: 5 }); }
        break;
      case 'unbreakable':
        p.st.unbreak = A.turns; emit(G, { t: 'fx', k: 'shield', x: p.x, y: p.y, col: '#ffb070' });
        log(G, 'You are UNBREAKABLE!', 'good'); break;
      case 'backstab':
        var force = target.asleep || target.st.stun || target.st.frozen || !target.aware;
        emit(G, { t: 'atk', id: 0, x: p.x, y: p.y, tx: target.x, ty: target.y });
        strike(G, p, target, opt(A.mult * (s.flags.assassin && target.hp < target.maxHp * 0.5 ? 1.6 : 1), { kind: 'melee', forceCrit: force, procs: true }));
        if (p.st.invis && !s.flags.cloak) delete p.st.invis;
        break;
      case 'shadowstep':
        var spots = DIRS4.concat(DIRS8.slice(4)).map(function (d) { return [target.x + d[0], target.y + d[1]]; }).filter(function (q) { return WALKABLE[tile(G, q[0], q[1])] && tile(G, q[0], q[1]) !== T.CHASM && tile(G, q[0], q[1]) !== T.LAVA && !actorAt(G, q[0], q[1]) && !blocksObj(G, q[0], q[1]); });
        if (!spots.length) { log(G, 'No room to step out beside it.', 'info'); return 0; }
        spots.sort(function (a, b) { return manh(b[0], b[1], p.x, p.y) - manh(a[0], a[1], p.x, p.y); });
        emit(G, { t: 'fx', k: 'smoke', x: p.x, y: p.y });
        p.x = spots[0][0]; p.y = spots[0][1]; p.st.critNext = 1;
        emit(G, { t: 'fx', k: 'smoke', x: p.x, y: p.y }); stepOn(G, true);
        break;
      case 'envenom':
        emit(G, { t: 'atk', id: 0, x: p.x, y: p.y, tx: target.x, ty: target.y });
        strike(G, p, target, opt(A.mult, { kind: 'melee', procs: true }));
        if (target.hp > 0) addStatus(G, target, 'poison', 6, s.pow * 0.38 * (s.flags.virulence ? 1.5 : 1));
        break;
      case 'fan':
        var rad = s.flags.cuts ? 3 : A.radius, hit = hostileIn(G, p.x, p.y, rad).filter(function (m) { return los(G, p.x, p.y, m.x, m.y); });
        if (!hit.length) { log(G, 'No enemies close enough.', 'info'); return 0; }
        hit.forEach(function (m) { emit(G, { t: 'proj', k: 'knife', x0: p.x, y0: p.y, x1: m.x, y1: m.y }); strike(G, p, m, opt(A.mult, { kind: 'ranged' })); if (m.hp > 0) addStatus(G, m, 'bleed', 4, s.pow * 0.22 * (s.flags.virulence ? 1.5 : 1)); });
        break;
      case 'smoke':
        p.st.invis = A.turns; emit(G, { t: 'fx', k: 'smoke', x: p.x, y: p.y, r: 1 });
        hostileIn(G, p.x, p.y, 1).forEach(function (m) { addStatus(G, m, 'stun', 2); });
        loseTrack(G); log(G, 'You vanish into smoke.', 'good');
        break;
      case 'firebolt':
        emit(G, { t: 'proj', k: 'fire', x0: p.x, y0: p.y, x1: target.x, y1: target.y });
        strike(G, p, target, opt(A.mult, { kind: 'ranged', elem: 'fire' }));
        if (target.hp > 0 && (s.flags.ignite || chance(r, 0.5))) addStatus(G, target, 'burn', 4, s.pow * 0.3 * (s.flags.pyro ? 1.4 : 1));
        break;
      case 'frostnova':
        emit(G, { t: 'fx', k: 'nova', x: p.x, y: p.y, r: A.radius, col: '#9fdcff' });
        hostileIn(G, p.x, p.y, A.radius).forEach(function (m) { strike(G, p, m, opt(A.mult, { elem: 'frost' })); if (m.hp > 0) addStatus(G, m, 'frozen', 2); });
        break;
      case 'blink':
        emit(G, { t: 'fx', k: 'blink', x: p.x, y: p.y });
        p.x = tx; p.y = ty; if (s.flags.phase) p.st.dodgeBuff = { v: 0.5, t: 2 };
        emit(G, { t: 'fx', k: 'blink', x: p.x, y: p.y }); stepOn(G, true);
        break;
      case 'chain':
        var jumps = A.jumps + (s.flags.overload ? 2 : 0), cur = target, hitIds = {}, from = p, m2 = A.mult;
        for (var j = 0; j <= jumps && cur; j++) {
          emit(G, { t: 'proj', k: 'zap', x0: from.x, y0: from.y, x1: cur.x, y1: cur.y });
          hitIds[cur.id] = 1; var cx = cur.x, cy = cur.y;
          strike(G, p, cur, opt(m2, { elem: 'shock' }));
          from = { x: cx, y: cy }; m2 *= 0.85;
          var nxt = null; G.mons.forEach(function (o) { if (!o.ally && o.hp > 0 && !hitIds[o.id] && cheb(o.x, o.y, cx, cy) <= 3 && (!nxt || cheb(o.x, o.y, cx, cy) < cheb(nxt.x, nxt.y, cx, cy))) nxt = o; });
          cur = nxt;
        }
        break;
      case 'meteor':
        var mr = s.flags.armageddon ? 2 : A.radius;
        G.delayed.push({ k: 'meteor', x: tx, y: ty, rad: mr, t: A.delay, d: s.pow * A.mult * (1 + s.abilPct + (s.flags.archmage ? 0.2 : 0)) * (s.flags.pyro ? 1.25 : 1) });
        log(G, 'A meteor streaks down from somewhere far above…', 'good');
        break;
      case 'quickshot':
        var shots = s.flags.doubletap ? 2 : 1;
        for (var k = 0; k < shots && target.hp > 0; k++) { emit(G, { t: 'proj', k: 'arrow', x0: p.x, y0: p.y, x1: target.x, y1: target.y, delay: k * 90 }); strike(G, p, target, { mult: A.mult * (shots > 1 ? 0.65 : 1), kind: 'ranged', ability: true, procs: true }); }
        gainRes(G, A.gain);
        if (s.flags.ricochet) { var rc = null; G.mons.forEach(function (o) { if (o !== target && !o.ally && o.hp > 0 && cheb(o.x, o.y, target.x, target.y) <= 3 && (!rc || cheb(o.x, o.y, target.x, target.y) < cheb(rc.x, rc.y, target.x, target.y))) rc = o; }); if (rc) { emit(G, { t: 'proj', k: 'arrow', x0: target.x, y0: target.y, x1: rc.x, y1: rc.y }); strike(G, p, rc, { mult: A.mult * 0.7, kind: 'ranged', ability: true }); } }
        noise(G, p.x, p.y, 4);
        break;
      case 'aimed':
        var line = lineTiles(G, p.x, p.y, target.x, target.y, R), first = true;
        emit(G, { t: 'proj', k: 'bigarrow', x0: p.x, y0: p.y, x1: line.length ? line[line.length - 1][0] : target.x, y1: line.length ? line[line.length - 1][1] : target.y });
        line.forEach(function (q) { var m = monAt(G, q[0], q[1]); if (m && !m.ally) { strike(G, p, m, { mult: A.mult, kind: 'ranged', ability: true, procs: true, forceCrit: s.flags.u_heart }); if (first && s.flags.huntmark && m.hp > 0) addStatus(G, m, 'mark', 5); first = false; } });
        break;
      case 'snare':
        addObj(G, { k: 'snare', x: tx, y: ty, d: s.pow * A.mult, turns: A.turns, barbed: !!s.flags.barbed });
        emit(G, { t: 'fx', k: 'sparkle', x: tx, y: ty }); log(G, 'You set a snare.', 'info');
        break;
      case 'wolf':
        G.mons.filter(function (m) { return m.ally && m.k === 'wolf'; }).forEach(function (m) { G.mons.splice(G.mons.indexOf(m), 1); });
        var nw = s.flags.twowolves ? 2 : 1, made = 0;
        for (var kk = 0; kk < 8 && made < nw; kk++) {
          var wx = p.x + DIRS8[kk][0], wy = p.y + DIRS8[kk][1];
          if (!WALKABLE[tile(G, wx, wy)] || tile(G, wx, wy) === T.CHASM || actorAt(G, wx, wy) || blocksObj(G, wx, wy)) continue;
          var w = spawnMon(G, 'wolf', wx, wy, { ally: true }), am = s.flags.alpha ? 1.6 : 1;
          w.maxHp = w.hp = Math.round(s.maxHp * 0.55 * am); w.pow = s.pow * 0.55 * am; w.arm = Math.round(s.arm * 0.6); made++;
          emit(G, { t: 'fx', k: 'raise', x: wx, y: wy, col: '#d0c0a0' });
        }
        if (!made) { log(G, 'No room for a wolf here.', 'info'); return 0; }
        log(G, made > 1 ? 'Two wolves answer your call!' : 'A wolf answers your call!', 'good');
        break;
      case 'rain':
        var rr2 = s.flags.volley ? 3 : A.radius;
        emit(G, { t: 'fx', k: 'rain', x: tx, y: ty, r: rr2 });
        hostileIn(G, tx, ty, rr2).forEach(function (m) { strike(G, p, m, opt(A.mult, { kind: 'ranged' })); });
        break;
      case 'smite':
        var tg = [target];
        if (s.flags.radiance) { var o2 = hostilesVisible(G).filter(function (m) { return m !== target && cheb(m.x, m.y, p.x, p.y) <= R && los(G, p.x, p.y, m.x, m.y); })[0]; if (o2) tg.push(o2); }
        tg.forEach(function (m) {
          emit(G, { t: 'proj', k: 'holy', x0: p.x, y0: p.y, x1: m.x, y1: m.y });
          strike(G, p, m, opt(A.mult * (UNDEADISH[m.fam] ? 2 : 1), { elem: 'holy' }));
          if (m.hp > 0 && s.flags.penance && chance(r, 0.35)) addStatus(G, m, 'stun', 1);
        });
        break;
      case 'mend':
        heal(G, p, s.maxHp * A.heal); cleanse(p);
        if (s.flags.renew) p.st.regen = { t: 5, v: Math.round(s.maxHp * 0.04) };
        emit(G, { t: 'fx', k: 'heal', x: p.x, y: p.y });
        break;
      case 'consecrate':
        var cr = s.flags.holyground ? 2 : A.radius, ct = s.flags.sanctified ? 10 : A.turns;
        consecrateAt(G, p.x, p.y, cr, ct, s.pow * A.mult * (1 + s.abilPct));
        if (s.flags.sanctified) p.st.sanct = ct;
        emit(G, { t: 'fx', k: 'nova', x: p.x, y: p.y, r: cr, col: '#ffe08a' });
        break;
      case 'dshield':
        addStatus(G, p, 'shield', A.turns, s.maxHp * A.shield);
        if (s.flags.aegis) cleanse(p);
        emit(G, { t: 'fx', k: 'shield', x: p.x, y: p.y, col: '#ffe08a' });
        break;
      case 'judgment':
        var vis = hostilesVisible(G);
        if (!vis.length) { log(G, 'No enemy in sight to judge.', 'info'); return 0; }
        emit(G, { t: 'fx', k: 'flash', col: '#fff4c0' });
        vis.forEach(function (m) { strike(G, p, m, opt(A.mult, { elem: 'holy' })); if (m.hp > 0 && m.fam === 'undead') addStatus(G, m, 'stun', 1); });
        if (s.flags.dayjudge) heal(G, p, s.maxHp * 0.04 * vis.length);
        break;
      case 'bonespear':
        var ln = lineTiles(G, p.x, p.y, tx, ty, R);
        emit(G, { t: 'proj', k: 'bone', x0: p.x, y0: p.y, x1: ln.length ? ln[ln.length - 1][0] : tx, y1: ln.length ? ln[ln.length - 1][1] : ty });
        ln.forEach(function (q) { var m = monAt(G, q[0], q[1]); if (m && !m.ally) { strike(G, p, m, opt(A.mult * (s.flags.marrow ? 1.4 : 1), { kind: 'ranged' })); if (m.hp > 0 && s.flags.marrow) addStatus(G, m, 'slow', 3); if (m.hp > 0 && s.flags.plague) addStatus(G, m, 'poison', 5, s.pow * 0.25); } });
        break;
      case 'raise':
        var corpse = objAt(G, tx, ty, 'corpse'); if (!corpse) return 0;
        var cap = 2 + (s.flags.gravelord ? 1 : 0), mins = minions(G).filter(function (m) { return !m.ttl; });
        if (mins.length >= cap) { var old = mins[0]; G.mons.splice(G.mons.indexOf(old), 1); emit(G, { t: 'die', id: old.id, x: old.x, y: old.y, ch: old.ch, col: old.col, ally: true }); }
        rm(G, corpse);
        if (!raiseAt(G, tx, ty, 0)) { log(G, 'No room for it to rise.', 'info'); return 0; }
        log(G, 'The dead answer you.', 'good');
        break;
      case 'drain':
        emit(G, { t: 'proj', k: 'drain', x0: target.x, y0: target.y, x1: p.x, y1: p.y });
        var got = strike(G, p, target, opt(A.mult, { elem: 'void' }));
        heal(G, p, got * A.drain * (s.flags.pact ? 1.3 : 1));
        if (target.hp > 0 && s.flags.wither) addStatus(G, target, 'weaken', 3);
        break;
      case 'corpseboom':
        var cp = objAt(G, tx, ty, 'corpse'); if (!cp) return 0; rm(G, cp);
        var br = s.flags.chainboom ? 2 : A.radius;
        emit(G, { t: 'fx', k: 'boom', x: tx, y: ty, r: br, col: '#c0ff9a' }); emit(G, { t: 'shake', n: 5 });
        hostileIn(G, tx, ty, br).forEach(function (m) { strike(G, p, m, opt(A.mult)); });
        break;
      case 'army':
        var cs = G.objs.filter(function (o) { return o.k === 'corpse' && cheb(o.x, o.y, p.x, p.y) <= A.radius; }), n2 = 0;
        cs.forEach(function (o) { rm(G, o); if (raiseAt(G, o.x, o.y, A.turns)) n2++; });
        if (s.flags.legion) while (n2 < 4) { if (!raiseAt(G, p.x, p.y, A.turns)) break; n2++; }
        if (!n2) { log(G, 'There are no dead here to call.', 'info'); return 0; }
        log(G, n2 + ' of the dead rise to fight for you!', 'good'); emit(G, { t: 'shake', n: 4 });
        break;
      default: did = false;
    }
    if (!did) return 0;
    var cost = st.cost;
    if ((s.flags.clearcast && h.cls === 'mage' && chance(r, 0.2)) || (s.flags.u_echo && chance(r, 0.2))) { cost = 0; if (st.cost) log(G, 'Clearcasting — that one was free.', 'good'); }
    p.res = Math.max(0, p.res - cost);
    var cd = abilityCd(G, id); if (cd) p.cd[id] = cd + 1;
    emit(G, { t: 'cast', id: id });
    if (id !== 'smoke' && id !== 'shadowstep' && id !== 'backstab' && p.st.invis && !(s.flags.cloak)) delete p.st.invis;
    return 100;
  }

  // ---- consumables -----------------------------------------------------------
  function useCons(G, id, tx, ty) {
    var h = G.hero, p = G.p, s = pstats(G);
    if (!h.cons[id]) { log(G, 'You have no ' + D.CONSUMABLES[id].name + '.', 'info'); return 0; }
    switch (id) {
      case 'potion':
        if (p.hp >= s.maxHp) { log(G, 'You are already at full health.', 'info'); return 0; }
        heal(G, p, s.maxHp * 0.4 * Math.max(0.2, 1 + s.potionPct)); emit(G, { t: 'fx', k: 'heal', x: p.x, y: p.y }); break;
      case 'tonic': gainRes(G, s.maxRes * 0.6); emit(G, { t: 'fx', k: 'sparkle', x: p.x, y: p.y, col: C[h.cls].res.color }); break;
      case 'elixir': cleanse(p); log(G, 'You feel clean.', 'good'); emit(G, { t: 'fx', k: 'heal', x: p.x, y: p.y }); break;
      case 'bomb':
        if (tx == null || cheb(tx, ty, p.x, p.y) > 4 || !visible(G, tx, ty)) { log(G, 'Throw it at a visible tile within 4.', 'info'); return 0; }
        emit(G, { t: 'proj', k: 'bomb', x0: p.x, y0: p.y, x1: tx, y1: ty });
        explodeAt(G, tx, ty, 1, s.pow * 1.5, p, '#ff8a3a'); noise(G, tx, ty, 10);
        break;
      case 'recall':
        h.cons[id]--; G.over = 'recall'; emit(G, { t: 'portal' }); log(G, 'The scroll folds space around you…', 'good'); return -1;
      case 'mapping':
        for (var i = 0; i < G.seen.length; i++) if (G.t[i] !== T.WALL || hasFloorNeighbor(G, i)) G.seen[i] = 1;
        G.objs.forEach(function (o) { if (o.k === 'trap') o.hidden = false; });
        G.mapped = true; log(G, 'The floor\'s layout burns itself into your mind.', 'good'); break;
      case 'key':
        for (i = 0; i < 4; i++) { var x = p.x + DIRS4[i][0], y = p.y + DIRS4[i][1]; if (tile(G, x, y) === T.GATE) return useKeyAt(G, x, y); }
        log(G, 'Stand beside a sealed gate to use the key.', 'info'); return 0;
      default: return 0;
    }
    h.cons[id]--;
    return 100;
  }
  function hasFloorNeighbor(G, i) { var x = i % G.w, y = (i - x) / G.w; for (var k = 0; k < 8; k++) { var t = tile(G, x + DIRS8[k][0], y + DIRS8[k][1]); if (t !== T.WALL && inb(G, x + DIRS8[k][0], y + DIRS8[k][1])) return true; } return false; }

  // ===========================================================================
  //  monster AI
  // ===========================================================================
  function fieldPass(G) { return function (x, y) { var t = tile(G, x, y); return WALKABLE[t] && t !== T.CHASM && t !== T.LAVA && !blocksObj(G, x, y); }; }
  function buildFields(G) {
    G.distP = bfs(G, G.p.x, G.p.y, fieldPass(G), 40);
  }
  function free(G, m, x, y) { return canEnter(G, m, x, y) && !actorAt(G, x, y) && !(m.ai !== 'ghost' && tile(G, x, y) === T.DOOR && false); }
  function moveMon(G, m, x, y) {
    if (tile(G, x, y) === T.DOOR) setT(G, x, y, T.ODOOR);
    m.x = x; m.y = y;
    var M = MON[m.k];
    if (M && M.trail === 'fire') fireAt(G, m.x, m.y, 0, 3, m.pow * 0.3);
    if (hasElite(m, 'molten') && chance(G.r, 0.3)) fireAt(G, m.x, m.y, 0, 3, m.pow * 0.25);
    var sn = objAt(G, x, y, 'snare');
    if (sn && !m.ally) { rm(G, sn); log(G, displayName(m) + ' is caught in your snare!', 'good'); strike(G, G.p, m, { flat: Math.round(sn.d), kind: 'true' }); if (m.hp > 0) { addStatus(G, m, 'root', sn.turns); if (sn.barbed) addStatus(G, m, 'bleed', 4, sn.d * 0.25); } }
  }
  function stepToward(G, m, tx, ty) {
    var best = null, bd = 1e9, useField = tx === G.p.x && ty === G.p.y && m.ai !== 'ghost' && m.k !== 'lurker' && G.distP;
    var cur = useField ? G.distP[m.y * G.w + m.x] : manh(m.x, m.y, tx, ty);
    var dirs = shuffle(G.r, DIRS4.slice());
    for (var k = 0; k < 4; k++) {
      var nx = m.x + dirs[k][0], ny = m.y + dirs[k][1];
      if (!free(G, m, nx, ny)) continue;
      var d = useField ? G.distP[ny * G.w + nx] : manh(nx, ny, tx, ty);
      if (useField && d >= 9999) d = 500 + manh(nx, ny, tx, ty);
      if (d < bd) { bd = d; best = [nx, ny]; }
    }
    if (best && (bd < cur || (bd === cur && chance(G.r, 0.3)))) { moveMon(G, m, best[0], best[1]); return true; }
    return false;
  }
  function stepAway(G, m, tx, ty) {
    var best = null, bd = manh(m.x, m.y, tx, ty);
    for (var k = 0; k < 4; k++) {
      var nx = m.x + DIRS4[k][0], ny = m.y + DIRS4[k][1];
      if (!free(G, m, nx, ny)) continue;
      var d = manh(nx, ny, tx, ty); if (d > bd) { bd = d; best = [nx, ny]; }
    }
    if (best) { moveMon(G, m, best[0], best[1]); return true; }
    return false;
  }
  function wander(G, m) {
    if (m.lastSeen) { if (m.x === m.lastSeen[0] && m.y === m.lastSeen[1]) m.lastSeen = null; else { stepToward(G, m, m.lastSeen[0], m.lastSeen[1]); return; } }
    if (chance(G.r, 0.3)) { var d = pick(G.r, DIRS4); if (free(G, m, m.x + d[0], m.y + d[1])) moveMon(G, m, m.x + d[0], m.y + d[1]); }
  }
  function monAttack(G, m, t, mult) {
    emit(G, { t: 'atk', id: m.id, x: m.x, y: m.y, tx: t.x, ty: t.y });
    strike(G, m, t, { mult: mult || 1, kind: 'melee' });
  }
  // the creature's chosen victim: the player, or a minion that's closer
  function pickTarget(G, m) {
    var p = G.p, best = null, bd = 1e9;
    var pd = manh(m.x, m.y, p.x, p.y);
    var hidden = p.st.invis && pd > 1;
    if (G.hero && pstats(G).flags.camo && p.still >= 2 && cheb(m.x, m.y, p.x, p.y) > 2) hidden = true;
    if (!hidden) { best = p; bd = pd; }
    G.mons.forEach(function (a) { if (!a.ally || a.hp <= 0) return; var d = manh(m.x, m.y, a.x, a.y); if (d < bd - (best === p ? 1 : 0) && d <= 6) { bd = d; best = a; } });
    return best;
  }
  function areaTiles(cx, cy, rad, skipCenter) {
    var out = [];
    for (var y = cy - rad; y <= cy + rad; y++) for (var x = cx - rad; x <= cx + rad; x++) if (!(skipCenter && x === cx && y === cy)) out.push([x, y]);
    return out;
  }
  function crossTiles(G, cx, cy, horiz, vert, maxLen) {
    var out = [];
    function ray(dx, dy) { for (var i = 1; i <= maxLen; i++) { var x = cx + dx * i, y = cy + dy * i; if (!inb(G, x, y) || OPAQUE[tile(G, x, y)]) break; out.push([x, y]); } }
    out.push([cx, cy]);
    if (horiz) { ray(1, 0); ray(-1, 0); }
    if (vert) { ray(0, 1); ray(0, -1); }
    return out;
  }
  function setIntent(G, m, it) {
    it.tiles = it.tiles.filter(function (q) { return inb(G, q[0], q[1]) && !OPAQUE[tile(G, q[0], q[1])]; });
    m.intent = it;
    emit(G, { t: 'intent', id: m.id });
  }
  function aligned(G, m, t, maxD) {
    if (m.x !== t.x && m.y !== t.y) return false;
    var d = manh(m.x, m.y, t.x, t.y); if (d < 2 || d > maxD) return false;
    var dx = sgn(t.x - m.x), dy = sgn(t.y - m.y), x = m.x + dx, y = m.y + dy;
    while (x !== t.x || y !== t.y) { if (!canEnter(G, m, x, y) || actorAt(G, x, y)) return false; x += dx; y += dy; }
    return true;
  }
  function chargeTiles(G, m, t, len) {
    var dx = sgn(t.x - m.x), dy = sgn(t.y - m.y), out = [];
    for (var i = 1; i <= len; i++) { var x = m.x + dx * i, y = m.y + dy * i; if (!inb(G, x, y) || OPAQUE[tile(G, x, y)] || !WALKABLE[tile(G, x, y)]) break; out.push([x, y]); }
    return out;
  }
  function resolveIntent(G, m, dying) {
    var it = m.intent; if (!it) return;
    it.t--; if (it.t > 0 && !dying) return;
    m.intent = null;
    var r = G.r, hitAny = false;
    function hitTile(x, y, mult, extra) {
      var a = actorAt(G, x, y);
      if (!a || a === m || !hostile(m, a) && !it.friendly) return false;
      var o = { mult: mult, kind: 'spell', noDodge: true, elem: it.elem };
      strike(G, m.hp > 0 ? m : null, a, o.flat ? o : (m.hp > 0 ? o : { flat: Math.round(m.pow * mult), kind: 'true' }));
      if (a.hp > 0 && extra) for (var k in extra) addStatus(G, a, k, extra[k], m.pow * 0.25);
      hitAny = true; return true;
    }
    switch (it.k) {
      case 'shot': case 'bolt':
        emit(G, { t: 'proj', k: it.elem === 'fire' ? 'fire' : it.beam ? 'beam' : 'arrow', x0: m.x, y0: m.y, x1: it.tiles.length ? it.tiles[it.tiles.length - 1][0] : m.x, y1: it.tiles.length ? it.tiles[it.tiles.length - 1][1] : m.y, hostile: true });
        for (var i = 0; i < it.tiles.length; i++) {
          var q = it.tiles[i], a = actorAt(G, q[0], q[1]);
          if (a && a !== m) { if (hostile(m, a)) hitTile(q[0], q[1], it.mult, it.status); if (!it.beam) break; }
          if (blocksObj(G, q[0], q[1]) && !it.beam) break;
        }
        break;
      case 'charge':
        var x0 = m.x, y0 = m.y;
        for (var j = 0; j < it.tiles.length; j++) {
          var c = it.tiles[j], o = actorAt(G, c[0], c[1]);
          if (o) { if (hostile(m, o)) { hitTile(c[0], c[1], it.mult); if (o.hp > 0) addStatus(G, o, 'stun', 1); emit(G, { t: 'shake', n: 5 }); } break; }
          if (!canEnter(G, m, c[0], c[1])) break;
          m.x = c[0]; m.y = c[1];
        }
        emit(G, { t: 'dash', id: m.id, x0: x0, y0: y0, x1: m.x, y1: m.y });
        break;
      case 'fuse':
        emit(G, { t: 'fx', k: 'boom', x: m.x, y: m.y, r: 1, col: '#ff6a2a' }); emit(G, { t: 'shake', n: 7 });
        it.tiles.forEach(function (q) { var a = actorAt(G, q[0], q[1]); if (a && a !== m) strike(G, null, a, { flat: Math.round(m.pow * it.mult * (0.9 + rf(r) * 0.2) * (a === G.p ? 1 - Math.min(0.5, pstats(G).arm / (pstats(G).arm + 12 + 2 * m.lvl)) : 1)), kind: 'true', elem: 'fire' }); });
        fireAt(G, m.x, m.y, 1, 2, m.pow * 0.25);
        m.exploded = true;
        if (!dying && m.hp > 0) { G.lastHazard = displayName(m); killMon(G, m, null); }
        return;
      default:
        // area: slam, sweep, spores, wave, erupt, beam, cloud…
        var fxk = it.elem === 'fire' ? 'boom' : it.elem === 'poison' ? 'gas' : it.elem === 'wave' ? 'wave' : it.elem === 'void' ? 'void' : 'slam';
        emit(G, { t: 'area', k: fxk, tiles: it.tiles });
        if (it.k === 'slam' || it.k === 'sweep' || it.k === 'bigslam') emit(G, { t: 'shake', n: 5 });
        it.tiles.forEach(function (q) { hitTile(q[0], q[1], it.mult, it.status); });
        if (it.gas) it.tiles.forEach(function (q) { gasAt(G, q[0], q[1], 0, it.gas, m.pow * 0.3); });
        if (it.fire) it.tiles.forEach(function (q) { fireAt(G, q[0], q[1], 0, it.fire, m.pow * 0.3); });
    }
  }
  function monTurn(G, m) {
    if (m.hp <= 0) return;
    if (m.ally) return allyTurn(G, m);
    if (m.st.stun || m.st.frozen) return;
    if (m.intent) { resolveIntent(G, m); return; }
    if (m.disguised) return;
    var p = G.p, M = MON[m.k] || {};
    if (m.asleep) {
      if (visible(G, m.x, m.y) && cheb(m.x, m.y, p.x, p.y) <= 3 && !p.st.invis && chance(G.r, G.hero.cls === 'rogue' ? 0.25 : 0.5)) { m.asleep = false; m.aware = true; emit(G, { t: 'alert', id: m.id, x: m.x, y: m.y }); }
      return;
    }
    if (m.boss) return bossTurn(G, m);
    var t = pickTarget(G, m);
    if (!m.aware) {
      if (t === p && cheb(m.x, m.y, p.x, p.y) <= 8 && los(G, m.x, m.y, p.x, p.y)) { m.aware = true; emit(G, { t: 'alert', id: m.id, x: m.x, y: m.y }); }
      else if (t && t !== p && manh(m.x, m.y, t.x, t.y) <= 5) m.aware = true;
      else { wander(G, m); return; }
    }
    if (!t) { wander(G, m); return; }
    if (t === p) m.lastSeen = [p.x, p.y];
    if (m.st.root && m.ai !== 'archer' && m.ai !== 'caster' && m.ai !== 'turret') { if (manh(m.x, m.y, t.x, t.y) === 1) monAttack(G, m, t); return; }
    var d = manh(m.x, m.y, t.x, t.y), ch = cheb(m.x, m.y, t.x, t.y), sight = los(G, m.x, m.y, t.x, t.y);
    if (hasElite(m, 'blinking') && !m.cd.blink && d > 3 && sight) {
      for (var k = 0; k < 4; k++) { var bx = t.x + DIRS4[k][0], by = t.y + DIRS4[k][1]; if (free(G, m, bx, by)) { emit(G, { t: 'fx', k: 'blink', x: m.x, y: m.y }); m.x = bx; m.y = by; m.cd.blink = 5; emit(G, { t: 'fx', k: 'blink', x: m.x, y: m.y }); return; } }
    }
    switch (m.ai) {
      case 'brute':
        if (ch <= 1 && !m.cd.slam) { setIntent(G, m, { k: 'slam', tiles: areaTiles(m.x, m.y, 1, true), t: 1, mult: 2.0 }); m.cd.slam = 4; return; }
        if (d === 1) { monAttack(G, m, t, 0.9); return; }
        stepToward(G, m, t.x, t.y); return;
      case 'archer': case 'turret':
        if (sight && ch <= m.range) {
          if (d <= 1 && m.ai !== 'turret' && chance(G.r, 0.6) && stepAway(G, m, t.x, t.y)) return;
          if (!m.cd.shot) {
            var line = lineTiles(G, m.x, m.y, t.x, t.y, m.range + 2);
            setIntent(G, m, { k: 'shot', tiles: line, t: 1, mult: M.beam ? 1.6 : 1.35, beam: !!M.beam, elem: m.k === 'imp' ? 'fire' : null, status: m.k === 'imp' ? { burn: 3 } : m.k === 'spitter' ? { poison: 4 } : null });
            m.cd.shot = M.beam ? 3 : 2; return;
          }
          if (d === 1) { monAttack(G, m, t, 0.7); return; }
          if (d <= 2 && m.ai !== 'turret') stepAway(G, m, t.x, t.y);
          return;
        }
        if (m.ai !== 'turret') stepToward(G, m, t.x, t.y);
        return;
      case 'caster':
        if (sight && ch <= m.range && !m.cd.cast) {
          if (M.elem === 'wave') {
            var horiz = Math.abs(t.x - m.x) < Math.abs(t.y - m.y);
            setIntent(G, m, { k: 'wave', tiles: crossTiles(G, t.x, t.y, horiz, !horiz, 9), t: 1, mult: 1.5, elem: 'wave' });
          } else setIntent(G, m, { k: 'area', tiles: areaTiles(t.x, t.y, 1), t: 2, mult: 1.6, elem: M.elem, status: M.elem === 'fire' ? { burn: 3 } : M.elem === 'void' ? { weaken: 3 } : null, fire: M.elem === 'fire' ? 3 : 0 });
          m.cd.cast = 4; return;
        }
        if (d === 1) { monAttack(G, m, t, 0.8); return; }
        if (sight && d <= 2) { stepAway(G, m, t.x, t.y); return; }
        if (!sight || ch > m.range) stepToward(G, m, t.x, t.y);
        return;
      case 'charger':
        if (!m.cd.charge && aligned(G, m, t, 6)) { setIntent(G, m, { k: 'charge', tiles: chargeTiles(G, m, t, 7), t: 1, mult: 1.8 }); m.cd.charge = 5; return; }
        if (M.slam && ch <= 1 && !m.cd.slam) { setIntent(G, m, { k: 'slam', tiles: areaTiles(m.x, m.y, 1, true), t: 1, mult: 1.9 }); m.cd.slam = 4; return; }
        if (d === 1) { monAttack(G, m, t); return; }
        stepToward(G, m, t.x, t.y); return;
      case 'bomber':
        if (d <= 1) { setIntent(G, m, { k: 'fuse', tiles: areaTiles(m.x, m.y, 1, true), t: 1, mult: 2.0, elem: 'fire' }); log(G, displayName(m) + ' begins to glow white-hot!', 'warn'); return; }
        stepToward(G, m, t.x, t.y); return;
      case 'summoner':
        var mine = G.mons.filter(function (o) { return o.summoner === m.id; }).length;
        if (!m.cd.summon && mine < 4 && sight) {
          var made = 0;
          for (var k2 = 0; k2 < 8 && made < 2; k2++) { var sx = m.x + DIRS8[k2][0], sy = m.y + DIRS8[k2][1]; if (free(G, { k: M.summons, ai: 'melee' }, sx, sy)) { var c = spawnMon(G, M.summons, sx, sy, { aware: true, lvl: m.lvl }); c.summoner = m.id; c.xp = Math.round(c.xp * 0.3); c.gold = 0; made++; emit(G, { t: 'fx', k: 'raise', x: sx, y: sy, col: m.col }); } }
          if (made) { log(G, displayName(m) + ' calls forth help!', 'warn'); m.cd.summon = 7; return; }
        }
        if (d === 1) { monAttack(G, m, t, 0.8); return; }
        if (d <= 3) { stepAway(G, m, t.x, t.y); return; }
        if (d > 6 || !sight) stepToward(G, m, t.x, t.y);
        return;
      case 'healer':
        if (!m.cd.heal) {
          var hurt = G.mons.filter(function (o) { return !o.ally && o !== m && o.hp > 0 && o.hp < o.maxHp * 0.7 && cheb(o.x, o.y, m.x, m.y) <= 5; })[0];
          if (hurt) {
            if (M.shields) { addStatus(G, hurt, 'shield', 6, hurt.maxHp * 0.3); log(G, displayName(m) + ' wards ' + displayName(hurt) + '.', 'warn'); }
            else { heal(G, hurt, hurt.maxHp * 0.3); log(G, displayName(m) + ' mends ' + displayName(hurt) + '.', 'warn'); }
            emit(G, { t: 'proj', k: 'heal', x0: m.x, y0: m.y, x1: hurt.x, y1: hurt.y, hostile: true });
            m.cd.heal = 3; return;
          }
        }
        if (M.raises && !m.cd.raise) {
          var cp = G.objs.filter(function (o) { return o.k === 'corpse' && cheb(o.x, o.y, m.x, m.y) <= 4 && !actorAt(G, o.x, o.y); })[0];
          if (cp) { rm(G, cp); var sk = spawnMon(G, M.raises, cp.x, cp.y, { aware: true, lvl: m.lvl }); sk.xp = Math.round(sk.xp * 0.4); sk.gold = 0; emit(G, { t: 'fx', k: 'raise', x: cp.x, y: cp.y, col: m.col }); log(G, displayName(m) + ' raises the dead!', 'warn'); m.cd.raise = 8; return; }
        }
        if (d === 1) { monAttack(G, m, t, 0.8); return; }
        if (d <= 3) { stepAway(G, m, t.x, t.y); return; }
        if (d > 5 || !sight) stepToward(G, m, t.x, t.y);
        return;
      case 'thief':
        if (m.stolen) {
          m.fleeT = (m.fleeT || 0) + 1;
          if (m.fleeT > 10 && !visible(G, m.x, m.y)) { G.mons.splice(G.mons.indexOf(m), 1); log(G, 'You hear mocking laughter fade into the dark. Your gold is gone.', 'bad'); return; }
          stepAway(G, m, p.x, p.y); return;
        }
        if (d === 1) { monAttack(G, m, t); return; }
        stepToward(G, m, t.x, t.y); return;
      case 'ambush':
        if (m.k === 'shade' && ch <= 2) m.revealed = true;
        if (d === 1) { monAttack(G, m, t); return; }
        if (m.k === 'lurker' && d > 5) return;
        stepToward(G, m, t.x, t.y); return;
      default: // melee, swarm, ghost
        if (d === 1) { monAttack(G, m, t); return; }
        stepToward(G, m, t.x, t.y);
    }
  }
  function allyTurn(G, m) {
    if (m.ttl) { m.ttl--; if (m.ttl <= 0) { killMon(G, m, null); return; } }
    if (m.st.stun || m.st.frozen) return;
    var best = null, bd = 1e9, p = G.p;
    G.mons.forEach(function (o) {
      if (o.ally || o.hp <= 0 || o.disguised || o.asleep && cheb(o.x, o.y, p.x, p.y) > 3) return;
      var d = manh(o.x, o.y, m.x, m.y);
      if (d <= 8 && d < bd && (visible(G, o.x, o.y) || d <= 3)) { bd = d; best = o; }
    });
    if (best) {
      if (m.k === 'skelmage' && bd <= 5 && los(G, m.x, m.y, best.x, best.y)) { emit(G, { t: 'proj', k: 'bone', x0: m.x, y0: m.y, x1: best.x, y1: best.y }); strike(G, m, best, { mult: 0.9, kind: 'ranged' }); return; }
      if (bd === 1) { monAttack(G, m, best); return; }
      if (stepToward(G, m, best.x, best.y)) return;
    }
    if (manh(m.x, m.y, p.x, p.y) > 2) stepToward(G, m, p.x, p.y);
  }

  // ---- bosses ----------------------------------------------------------------
  var MOVE_CD = { sweep: 3, strike: 0, lunge: 4, raise: 9, spores: 4, brood: 6, cloud: 5, wave: 4, crosswave: 6, bolt: 2, phase: 4, drowned: 10, slam: 3, bigslam: 5, erupt: 4, beam: 4, shades: 10, darkness: 14, crossbeam: 5 };
  function bossMinions(G, m) { return G.mons.filter(function (o) { return o.summoner === m.id; }).length; }
  function bossSummon(G, m, kind, n) {
    var made = 0;
    for (var k = 0; k < 16 && made < n; k++) {
      var d = DIRS8[k % 8], dist = k < 8 ? 1 : 2, x = m.x + d[0] * dist, y = m.y + d[1] * dist;
      if (!free(G, { k: kind, ai: 'melee' }, x, y)) continue;
      var c = spawnMon(G, kind, x, y, { aware: true, lvl: m.lvl }); c.summoner = m.id; c.xp = Math.round(c.xp * 0.3); c.gold = 0; made++;
      emit(G, { t: 'fx', k: 'raise', x: x, y: y, col: m.col });
    }
    return made;
  }
  function bossTurn(G, m) {
    var p = G.p, B = D.BOSSES[m.boss], ph = B.phases[m.phase];
    var d = manh(m.x, m.y, p.x, p.y), ch = cheb(m.x, m.y, p.x, p.y), sight = los(G, m.x, m.y, p.x, p.y);
    if (!m.aware) {
      if (sight && ch <= 7) { m.aware = true; if (!G.bossSeen) { G.bossSeen = true; G.modal = { k: 'dialog', who: m.boss, lines: B.intro, intro: true }; emit(G, { t: 'boss', id: m.id }); } }
      return;
    }
    if (m.gcd > 0) { m.gcd--; }
    else {
      var cands = ph.moves.filter(function (mv) {
        if (m.mcd[mv] > 0) return false;
        switch (mv) {
          case 'sweep': case 'slam': return ch <= 1;
          case 'bigslam': return ch <= 2;
          case 'lunge': return aligned(G, m, p, 7);
          case 'phase': return ch <= 1;
          case 'raise': case 'brood': case 'drowned': case 'shades': return bossMinions(G, m) < 3;
          case 'darkness': return !p.st.dark;
          case 'strike': return false;
          default: return sight && ch <= 10;
        }
      });
      if (cands.length && chance(G.r, 0.75)) {
        var mv = pick(G.r, cands);
        m.mcd[mv] = MOVE_CD[mv] || 3; m.gcd = 1;
        bossMove(G, m, mv); return;
      }
    }
    if (d === 1) { monAttack(G, m, p, 1.0); return; }
    stepToward(G, m, p.x, p.y);
  }
  function bossMove(G, m, mv) {
    var p = G.p, B = D.BOSSES[m.boss];
    switch (mv) {
      case 'sweep': setIntent(G, m, { k: 'sweep', tiles: areaTiles(m.x, m.y, 1, true), t: 1, mult: 1.9 }); break;
      case 'slam': setIntent(G, m, { k: 'slam', tiles: areaTiles(m.x, m.y, 1, true), t: 1, mult: 2.1, elem: 'fire', fire: 2 }); break;
      case 'bigslam': setIntent(G, m, { k: 'bigslam', tiles: areaTiles(m.x, m.y, 2, true), t: 2, mult: 2.3, elem: 'fire', fire: 3 }); log(G, B.name + ' raises the hammer high!', 'warn'); break;
      case 'lunge': setIntent(G, m, { k: 'charge', tiles: chargeTiles(G, m, p, 8), t: 1, mult: 1.9 }); break;
      case 'raise': if (bossSummon(G, m, 'skeleton', 2)) log(G, 'Skeletons claw their way up from the floor!', 'warn'); break;
      case 'brood': if (bossSummon(G, m, 'sporeling', 3)) log(G, 'The Mother births a brood of sporelings!', 'warn'); break;
      case 'drowned': if (bossSummon(G, m, 'drowned', 2)) log(G, 'Drowned scribes rise from the water!', 'warn'); break;
      case 'shades': if (bossSummon(G, m, 'shade', 2)) log(G, 'Shades peel away from the King\'s shadow!', 'warn'); break;
      case 'spores': setIntent(G, m, { k: 'area', tiles: areaTiles(p.x, p.y, 1), t: 2, mult: 1.3, elem: 'poison', status: { poison: 4 }, gas: 4 }); break;
      case 'cloud':
        var tl = [];
        for (var i = 0; i < 4; i++) { var cx = p.x + rr(G.r, -3, 3), cy = p.y + rr(G.r, -3, 3); tl = tl.concat(areaTiles(cx, cy, 1)); }
        tl = tl.concat([[p.x, p.y]]);
        setIntent(G, m, { k: 'area', tiles: tl, t: 2, mult: 1.0, elem: 'poison', status: { poison: 3 }, gas: 5 }); break;
      case 'wave': var hz = chance(G.r, 0.5); setIntent(G, m, { k: 'wave', tiles: crossTiles(G, p.x, p.y, hz, !hz, 12), t: 1, mult: 1.6, elem: 'wave' }); break;
      case 'crosswave': setIntent(G, m, { k: 'wave', tiles: crossTiles(G, p.x, p.y, true, true, 12), t: 2, mult: 1.7, elem: 'wave' }); log(G, 'The tide gathers from every direction!', 'warn'); break;
      case 'bolt': setIntent(G, m, { k: 'bolt', tiles: lineTiles(G, m.x, m.y, p.x, p.y, 12), t: 1, mult: 1.4, elem: 'wave' }); break;
      case 'beam': setIntent(G, m, { k: 'bolt', tiles: lineTiles(G, m.x, m.y, p.x, p.y, 14), t: 1, mult: 2.2, beam: true, elem: 'void' }); break;
      case 'crossbeam': setIntent(G, m, { k: 'area', tiles: crossTiles(G, m.x, m.y, true, true, 14).slice(1), t: 1, mult: 2.2, elem: 'void' }); log(G, 'The Black Lantern blazes in four directions!', 'warn'); break;
      case 'phase':
        var best = null;
        for (var t = 0; t < 60; t++) { var x = m.x + rr(G.r, -7, 7), y = m.y + rr(G.r, -7, 7); var dd = cheb(x, y, p.x, p.y); if (dd >= 4 && dd <= 7 && free(G, m, x, y) && tile(G, x, y) !== T.LAVA) { best = [x, y]; break; } }
        if (best) { emit(G, { t: 'fx', k: 'blink', x: m.x, y: m.y }); m.x = best[0]; m.y = best[1]; emit(G, { t: 'fx', k: 'blink', x: m.x, y: m.y }); log(G, B.name + ' dissolves into ink and reforms across the room.', 'info'); }
        break;
      case 'erupt':
        var et = [[p.x, p.y]];
        for (var j = 0; j < 5; j++) et.push([p.x + rr(G.r, -3, 3), p.y + rr(G.r, -3, 3)]);
        setIntent(G, m, { k: 'area', tiles: et.concat(et.map(function (q) { return [q[0] + 1, q[1]]; })), t: 1, mult: 1.5, elem: 'fire', status: { burn: 3 }, fire: 3 });
        log(G, 'The floor glows red beneath you!', 'warn'); break;
      case 'darkness': p.st.dark = 8; log(G, 'The Black Lantern drinks your torchlight!', 'bad'); emit(G, { t: 'fx', k: 'flash', col: '#1a0a2a' }); break;
    }
  }
  function bossPhaseCheck(G, m) {
    var B = D.BOSSES[m.boss], nx = B.phases[m.phase + 1];
    if (nx && m.hp > 0 && m.hp / m.maxHp <= nx.at) {
      m.phase++; m.intent = null; m.gcd = 0;
      if (nx.spd) m.spd = nx.spd;
      emit(G, { t: 'phase', id: m.id, line: nx.line, name: B.name });
      log(G, B.name + ': ' + nx.line, 'boss');
      emit(G, { t: 'shake', n: 8 });
    }
  }
  function bossDown(G, m) {
    var h = G.hero, B = D.BOSSES[m.boss], r = G.r, s = pstats(G);
    h.stats.bosses++; G.run.bosses++;
    G.mons.filter(function (o) { return o.summoner === m.id; }).forEach(function (o) { o.hp = 0; G.mons.splice(G.mons.indexOf(o), 1); emit(G, { t: 'die', id: o.id, x: o.x, y: o.y, ch: o.ch, col: o.col }); });
    emit(G, { t: 'shake', n: 12 }); emit(G, { t: 'fx', k: 'flash', col: '#ffffff' });
    for (var i = 0; i < 3; i++) dropNear(G, m.x, m.y, { k: 'item', it: lootItem(G, { minRarity: i === 0 ? 'epic' : 'rare', luck: 1 + s.magicFind }) });
    if (chance(r, 0.3)) dropNear(G, m.x, m.y, { k: 'item', it: lootItem(G, { minRarity: 'legendary', luck: 2 }) });
    dropNear(G, m.x, m.y, { k: 'gold', n: goldAmount(G, r, m.gold) });
    var embers = 1 + (G.depth >= 15 ? 1 : 0); h.mats.soul = (h.mats.soul || 0) + embers;
    log(G, 'You claim ' + embers + ' Soul Ember' + (embers > 1 ? 's' : '') + '.', 'loot');
    // the way on — and the way home
    var cx = G.arena ? G.arena.x + (G.arena.w >> 1) : m.x, cy = G.arena ? G.arena.y + 2 : m.y;
    setT(G, cx - 1, cy, T.STAIRS); setT(G, cx + 1, cy, T.PORTAL); G.stairs = [cx - 1, cy];
    G.objs = G.objs.filter(function (o) { return !((o.x === cx - 1 || o.x === cx + 1) && o.y === cy && o.k !== 'item' && o.k !== 'gold'); });
    var lines = [B.death];
    if (G.mode === 'story' && G.depth <= D.STORY_FLOORS) {
      var act = G.depth / 5;
      if (h.story.cleared < act) { h.story.cleared = act; lines = lines.concat(D.STORY.cleared[act] || []); }
      if (B.final) { h.story.ended = true; G.ending = true; }
    }
    G.modal = { k: 'dialog', who: m.boss, lines: lines, outro: true, ending: !!G.ending };
    log(G, B.name + ' falls! A portal home shimmers open — and stairs lead deeper.', 'good');
  }

  // ===========================================================================
  //  turn pipeline
  // ===========================================================================
  function act(G, a) {
    if (G.over || G.modal) return false;
    G._ps = null; G.p.moved = false;
    var cost = 0;
    if (a.t === 'move') cost = playerMove(G, a.dx, a.dy);
    else if (a.t === 'wait') { cost = 100; G.p.rested = true; }
    else if (a.t === 'use') cost = playerUse(G);
    else if (a.t === 'ability') cost = useAbility(G, a.id, a.x, a.y);
    else if (a.t === 'cons') cost = useCons(G, a.id, a.x, a.y);
    if (cost < 0) { G._ps = null; computeFov(G); return true; }   // changed floor / left the dungeon
    if (cost > 0) endTurn(G, G.p.st.haste ? 50 : cost);
    else computeFov(G);
    return cost > 0;
  }
  function endTurn(G, cost) {
    var p = G.p, h = G.hero;
    h.stats.turns++;
    if (p.moved) p.still = 0; else p.still++;
    G._ps = null;
    advance(G, cost);
    // stunned / frozen: the world keeps moving without you
    var guard = 0;
    while (!G.over && !G.modal && (p.st.stun || p.st.frozen) && guard++ < 6) { log(G, p.st.frozen ? 'You are frozen solid!' : 'You are stunned!', 'bad'); advance(G, 100); }
    G._ps = null;
    computeFov(G);
    // notice newly visible enemies (UI uses this to interrupt travel)
    var seenNow = hostilesVisible(G).map(function (m) { return m.id; });
    var fresh = seenNow.filter(function (id) { return !(G.seenMons || []).some(function (x) { return x === id; }); });
    G.seenMons = seenNow;
    if (fresh.length) emit(G, { t: 'spot', n: fresh.length });
    p.rested = false;
  }
  function advance(G, cost) {
    buildFields(G);
    var list = G.mons.slice();
    for (var i = 0; i < list.length; i++) {
      var m = list[i]; if (m.hp <= 0 || G.mons.indexOf(m) < 0) continue;
      var spd = m.spd * (m.st.slow ? 0.5 : 1) * (m.st.haste ? 2 : 1);
      m.energy += spd * cost / 100;
      var n = 0;
      while (m.energy >= 100 && m.hp > 0 && !G.over && n++ < 3) { m.energy -= 100; monTurn(G, m); if (G.modal && G.modal.k === 'dialog') break; }
    }
    G.time += cost;
    while (G.time >= 100 && !G.over) { G.time -= 100; worldTick(G); }
  }
  function tickStatuses(G, a) {
    var isP = a === G.p, st = a.st, s = isP ? pstats(G) : null;
    var t = tile(G, a.x, a.y);
    if (st.burn && (t === T.WATER || t === T.DEEP)) delete st.burn;
    ['poison', 'burn', 'bleed'].forEach(function (k) {
      var e = st[k]; if (!e || a.hp <= 0) return;
      var d = e.d;
      if (isP) G.lastHazard = k === 'poison' ? 'poison' : k === 'burn' ? 'flames' : 'blood loss';
      strike(G, null, a, { flat: d, kind: 'dot', elem: k });
      e.t--; if (e.t <= 0) delete st[k];
    });
    if (a.hp <= 0) return;
    if (st.regen) { heal(G, a, st.regen.v, true); st.regen.t--; if (st.regen.t <= 0) delete st.regen; }
    ['stun', 'frozen', 'root', 'slow', 'weaken', 'mark', 'invis', 'haste', 'unbreak', 'inv', 'dark', 'sanct'].forEach(function (k) { if (st[k]) { st[k]--; if (st[k] <= 0) delete st[k]; } });
    if (st.dodgeBuff) { st.dodgeBuff.t--; if (st.dodgeBuff.t <= 0) delete st.dodgeBuff; }
    if (st.ramp) { st.ramp.t--; if (st.ramp.t <= 0) delete st.ramp; }
    if (st.shield && st.shield.t < 900) { st.shield.t--; if (st.shield.t <= 0) delete st.shield; }
    // ground effects
    var k2 = a.y * G.w + a.x;
    if (G.gas[k2] && a.fam !== 'fungus') { if (isP) G.lastHazard = 'poison gas'; addStatus(G, a, 'poison', 2, G.gas[k2].d); }
    if (G.fire[k2]) { if (isP) G.lastHazard = 'fire'; addStatus(G, a, 'burn', 2, G.fire[k2].d); }
    if (t === T.LAVA && !(a.fireproof || (MON[a.k] && MON[a.k].fireproof))) {
      var mx = isP ? s.maxHp : a.maxHp, ld = Math.round(mx * (isP && s.flags.u_ember ? 0.08 : 0.16));
      if (isP) G.lastHazard = 'lava';
      strike(G, null, a, { flat: ld, kind: 'true', elem: 'fire' }); if (a.hp > 0) addStatus(G, a, 'burn', 3, ld * 0.3);
    }
    if (G.holy[k2]) { if (isP) heal(G, a, s.maxHp * 0.03, true); else if (!a.ally) strike(G, G.p, a, { flat: G.holy[k2].d * (UNDEADISH[a.fam] ? 1.5 : 1), kind: 'true', elem: 'holy' }); }
  }
  function worldTick(G) {
    var p = G.p, h = G.hero, s = pstats(G), r = G.r, cr = C[h.cls].res;
    G.turn++; G.floorTurns++;
    // player upkeep
    tickStatuses(G, p);
    if (G.over) return;
    var foes = hostilesVisible(G).length;
    if (!s.noRegen) {
      if (s.regen && G.turn % 4 === 0) heal(G, p, s.regen, true);
      if (!foes && p.hp < s.maxHp) heal(G, p, Math.max(1, s.maxHp * 0.012), true);
    }
    var rg = s.resRegen;
    if (cr.still && !p.moved) rg += cr.still;
    if (cr.decay && !foes && !s.flags.trance) rg -= cr.decay;
    if (h.cls === 'mage' && p.rested && s.flags.leyline) rg += s.resRegen * 3;
    p.res = clamp(p.res + rg, 0, s.maxRes);
    for (var id in p.cd) if (p.cd[id] > 0) p.cd[id]--;
    if (s.flags.sanctified && p.st.sanct) consecrateAt(G, p.x, p.y, s.flags.holyground ? 2 : 1, 1, s.pow * 0.55);
    // monsters upkeep
    G.mons.slice().forEach(function (m) {
      if (m.hp <= 0) return;
      tickStatuses(G, m);
      for (var k in m.cd) if (m.cd[k] > 0) m.cd[k]--;
      if (m.mcd) for (var k3 in m.mcd) if (m.mcd[k3] > 0) m.mcd[k3]--;
      if (hasElite(m, 'shielded') && G.turn % 5 === 0 && !(m.st.shield && m.st.shield.v > 0)) m.st.shield = { v: Math.round(m.maxHp * 0.25), t: 999 };
    });
    // ground effects decay
    ['gas', 'fire', 'holy'].forEach(function (f) { for (var k in G[f]) { G[f][k].t--; if (G[f][k].t <= 0) delete G[f][k]; } });
    // vents cycle: 0..3 — 2 = warning, 3 = burst
    G.objs.forEach(function (o) {
      if (o.k !== 'vent') return;
      o.ph = (o.ph + 1) % 4;
      if (o.ph === 3) {
        var a = actorAt(G, o.x, o.y);
        if (visible(G, o.x, o.y)) emit(G, { t: 'area', k: o.kind === 'gas' ? 'gas' : o.kind === 'flame' ? 'boom' : o.kind === 'void' ? 'void' : 'slam', tiles: [[o.x, o.y]], small: true });
        if (o.kind === 'gas') gasAt(G, o.x, o.y, 1, 3, Math.max(2, G.ml * 1.2));
        if (a) {
          var mx = a === p ? s.maxHp : a.maxHp;
          if (a === p) G.lastHazard = 'a ' + o.kind + ' vent';
          if (o.kind === 'flame') { strike(G, null, a, { flat: Math.round(mx * 0.12), kind: 'true', elem: 'fire' }); if (a.hp > 0) addStatus(G, a, 'burn', 3, mx * 0.03); }
          else if (o.kind === 'spike') { strike(G, null, a, { flat: Math.round(mx * 0.1), kind: 'true' }); if (a.hp > 0) addStatus(G, a, 'bleed', 3, mx * 0.02); }
          else if (o.kind === 'void') { strike(G, null, a, { flat: Math.round(mx * 0.1), kind: 'true', elem: 'void' }); if (a.hp > 0) addStatus(G, a, 'weaken', 3); }
        }
      }
    });
    // delayed spells (meteor)
    G.delayed = G.delayed.filter(function (e) {
      e.t--; if (e.t > 0) return true;
      emit(G, { t: 'fx', k: 'meteor', x: e.x, y: e.y, r: e.rad }); emit(G, { t: 'shake', n: 9 });
      hostileIn(G, e.x, e.y, e.rad).forEach(function (m) { strike(G, G.p, m, { flat: Math.round(e.d * (0.9 + rf(r) * 0.2) * (1 - m.arm / (m.arm + 12 + 2 * h.level))), kind: 'true', elem: 'fire' }); if (m.hp > 0) addStatus(G, m, 'burn', 3, e.d * 0.1); });
      fireAt(G, e.x, e.y, e.rad, 3, e.d * 0.08);
      return false;
    });
    // the dark stirs: wandering monsters arrive over time
    if (!G.boss && G.mode !== 'town') {
      G.wanderT = (G.wanderT || 0) + 1;
      if (G.wanderT >= 90 && (G.wanderers || 0) < 4) {
        G.wanderT = 0;
        var B = D.BIOMES[G.biome];
        for (var t = 0; t < 80; t++) {
          var x = ri(r, G.w), y = ri(r, G.h);
          if (tile(G, x, y) !== T.FLOOR || actorAt(G, x, y) || blocksObj(G, x, y) || cheb(x, y, p.x, p.y) < 12 || visible(G, x, y)) continue;
          var mk = pick(r, B.mons.filter(function (k) { return !MON[k].rare; }));
          var wm = spawnMon(G, mk, x, y, { aware: true }); wm.lastSeen = [p.x, p.y];
          G.wanderers = (G.wanderers || 0) + 1;
          log(G, 'You hear something moving in the dark.', 'warn');
          break;
        }
      }
    }
  }

  // ===========================================================================
  //  events (shrines, strangers) — G.modal = {k:'event', id, oid}
  // ===========================================================================
  function scaleOf(G) { return 1 + 0.3 * ((G ? G.ml : 1) - 1); }
  function addBlessing(h, id, n) {
    h.bless = h.bless || [];
    for (var i = 0; i < h.bless.length; i++) if (h.bless[i].id === id) { h.bless[i].n = Math.max(h.bless[i].n, n || 3); return; }
    h.bless.push({ id: id, n: n || 3 });
  }
  function applyOps(G, ops, out) {
    var h = G.hero, p = G.p, s = pstats(G), r = G.r, sc = scaleOf(G);
    if (ops.heal) heal(G, p, s.maxHp * ops.heal);
    if (ops.res) p.res = s.maxRes;
    if (ops.hurt) { var d = Math.round(s.maxHp * ops.hurt); p.hp = Math.max(1, p.hp - d); emit(G, { t: 'dmg', x: p.x, y: p.y, n: d, p: true, elem: 'blood' }); }
    if (ops.gold) { var g = Math.round(ops.gold * sc); h.gold += g; G.run.gold += g; out.push('+' + g + ' gold'); }
    if (ops.bless) { addBlessing(h, ops.bless, 3); out.push(D.BLESSINGS[ops.bless].name); }
    if (ops.bless2) { addBlessing(h, ops.bless2, 3); out.push(D.BLESSINGS[ops.bless2].name); }
    if (ops.curse) { addBlessing(h, ops.curse, 3); out.push(D.BLESSINGS[ops.curse].name); }
    if (ops.curseRandom) { var cs = Object.keys(D.BLESSINGS).filter(function (k) { return !D.BLESSINGS[k].good; }), c = pick(r, cs); addBlessing(h, c, 3); out.push(D.BLESSINGS[c].name); }
    if (ops.item) { var it = lootItem(G, { minRarity: ops.item, luck: 0.5 }); dropNear(G, p.x, p.y, { k: 'item', it: it }); out.push(it.name); }
    if (ops.cons) for (var k in ops.cons) { h.cons[k] = Math.max(0, (h.cons[k] || 0) + ops.cons[k]); if (ops.cons[k] > 0) out.push('+' + ops.cons[k] + ' ' + D.CONSUMABLES[k].name); }
    if (ops.xp) { var x = Math.round(ops.xp * sc); gainXp(G, h, x); out.push('+' + x + ' XP'); }
    if (ops.map) { for (var i = 0; i < G.seen.length; i++) if (G.t[i] !== T.WALL || hasFloorNeighbor(G, i)) G.seen[i] = 1; out.push('the floor revealed'); }
    if (ops.cleanse) cleanse(p);
    if (ops.uncurse) h.bless = (h.bless || []).filter(function (b) { return D.BLESSINGS[b.id].good; });
    if (ops.mats) for (var mk in ops.mats) { h.mats[mk] = (h.mats[mk] || 0) + ops.mats[mk]; out.push('+' + ops.mats[mk] + ' ' + D.MATERIALS[mk].name); }
    if (ops.status) for (var sk in ops.status) addStatus(G, p, sk, ops.status[sk], s.maxHp * 0.03);
    if (ops.temper) { var tt = h.equip[ops.temper]; if (tt && (tt.plus || 0) < 10) { tt.plus = (tt.plus || 0) + 1; out.push(tt.name + ' +' + tt.plus); } }
    if (ops.lore) { var act = clamp(actAt(((G.depth - 1) % 25) + 1), 1, 5); for (var L = 0; L < D.LORE.length; L++) if (D.LORE[L].act === act && h.lore.indexOf(L) < 0) { h.lore.push(L); out.push('“' + D.LORE[L].title + '”'); break; } }
    if (ops.elite) {
      var B = D.BIOMES[G.biome];
      for (var t = 0; t < 40; t++) {
        var ex = p.x + rr(r, -4, 4), ey = p.y + rr(r, -4, 4);
        if (tile(G, ex, ey) !== T.FLOOR || actorAt(G, ex, ey) || blocksObj(G, ex, ey) || cheb(ex, ey, p.x, p.y) < 2) continue;
        spawnMon(G, pick(r, B.mons.filter(function (k) { return !MON[k].rare; })), ex, ey, { aware: true, elite: eliteAffixes(G, r) });
        out.push('an ambush!'); break;
      }
    }
  }
  function eventChoice(G, idx) {
    var md = G.modal; if (!md || md.k !== 'event') return null;
    var EV = D.EVENTS[md.id], ch = EV && EV.choices[idx]; if (!ch) return null;
    var h = G.hero, ops = ch.ops || {}, out = [], obj = null;
    G.objs.forEach(function (o) { if (o.oid === md.oid) obj = o; });
    if (ops.shop) { G.modal = { k: 'shop', stock: dungeonStock(G), oid: md.oid, title: EV.name }; return { shop: true }; }
    if (ops.needCons && !h.cons[ops.needCons]) return { ok: false, text: 'You have nothing to give.' };
    if (ops.pay) { var cost = Math.round(ops.pay * scaleOf(G)); if (h.gold < cost) return { ok: false, text: 'You can\'t afford that (' + cost + ' gold).' }; h.gold -= cost; out.push('−' + cost + ' gold'); }
    applyOps(G, ops, out);
    var text = ch.text || '';
    if (ops.roll) { var rl = wpick(G.r, ops.roll, function (x) { return x.w; }); applyOps(G, rl.ops || {}, out); text = rl.text; }
    var meaningful = Object.keys(ops).length > 0;
    if (meaningful && obj) { obj.used = true; G.run.events++; h.stats.events++; bounty(G, 'event'); }
    G._ps = null;
    G.modal = null;
    return { ok: true, text: text, gains: out, done: meaningful };
  }
  function dungeonStock(G) {
    var r = rng(hashStr(G.seed + ':shop:' + G.depth)), stock = [];
    for (var i = 0; i < 3; i++) { var it = makeItem(r, { ilvl: G.ml, luck: 0.6, minRarity: 'magic', cls: chance(r, 0.7) ? G.hero.cls : null }); stock.push({ it: it, price: itemValue(it) * 4 }); }
    ['potion', 'recall', 'elixir'].forEach(function (id) { stock.push({ cons: id, n: 1, price: Math.round(D.CONSUMABLES[id].price * 1.8 * (1 + 0.1 * G.ml)) }); });
    return stock;
  }
  function closeModal(G) { G.modal = null; }

  // ===========================================================================
  //  town: shop, temple, board, side quests
  // ===========================================================================
  function townArrive(h) {
    var s = stats(h);
    h.town = h.town || { visit: 0 }; h.town.visit++;
    h.hp = s.maxHp; h.res = C[h.cls].res.start;
    h.bag.forEach(function (it) { delete it.fresh; });
    D.SLOTS.forEach(function (sl) { if (h.equip[sl]) delete h.equip[sl].fresh; });
    rollBoard(h);
  }
  function consPrice(h, id) { return Math.round(D.CONSUMABLES[id].price * (1 + 0.2 * (h.story.cleared || 0) + 0.5 * (h.story.ng || 0))); }
  function shopStock(h) {
    var r = rng(hashStr(h.id + ':shop:' + ((h.town && h.town.visit) || 0))), items = [];
    var il = Math.max(1, (h.story.deepest || 1) + (h.story.ng || 0) * 25);
    for (var i = 0; i < 6; i++) {
      var it = makeItem(r, { ilvl: il, luck: 0.25, minRarity: i < 2 ? 'magic' : null, cls: i < 4 ? h.cls : null, slot: i === 0 ? 'weapon' : i === 1 ? 'armor' : null });
      items.push({ it: it, price: itemValue(it) * 3 });
    }
    return { cons: D.CONS_ORDER.map(function (id) { return { cons: id, price: consPrice(h, id) }; }), items: items };
  }
  function buy(h, entry) {
    if (entry.sold) return { ok: false, msg: 'Sold out.' };
    if (h.gold < entry.price) return { ok: false, msg: 'Not enough gold.' };
    if (entry.it && h.bag.length >= BAG_MAX) return { ok: false, msg: 'Your pack is full.' };
    h.gold -= entry.price;
    if (entry.it) { h.bag.push(entry.it); entry.sold = true; }
    else h.cons[entry.cons] = (h.cons[entry.cons] || 0) + (entry.n || 1);
    if (entry.n && entry.it == null && entry.once) entry.sold = true;
    return { ok: true };
  }
  function templeCosts(h) {
    var a = 1 + (h.story.cleared || 0) + 2 * (h.story.ng || 0);
    return { uncurse: 35 * a, bless: 70 * a, respec: 25 * h.level };
  }
  function uncurse(h) { var c = templeCosts(h).uncurse; if (h.gold < c) return false; var had = (h.bless || []).some(function (b) { return !D.BLESSINGS[b.id].good; }); if (!had) return false; h.gold -= c; h.bless = h.bless.filter(function (b) { return D.BLESSINGS[b.id].good; }); return true; }
  function buyBlessing(h, id) { var c = templeCosts(h).bless; if (h.gold < c || !D.BLESSINGS[id] || !D.BLESSINGS[id].good) return false; h.gold -= c; addBlessing(h, id, 3); return true; }
  function respec(h) { var c = templeCosts(h).respec; if (h.gold < c) return false; h.gold -= c; h.talents = [null, null, null, null, null]; return true; }

  function frontierAct(h) { return clamp((h.story.cleared || 0) + 1, 1, 5); }
  function makeBounty(h, r) {
    var tpl = pick(r, D.BOUNTIES), act = frontierAct(h), b = { id: 'b' + uid(r), tpl: tpl.id, have: 0, done: false };
    var sc = 1 + act * 0.8 + (h.story.ng || 0) * 2;
    if (tpl.id === 'kill') {
      var fams = {}; D.BIOMES[D.BIOME_ORDER[act - 1]].mons.forEach(function (k) { fams[MON[k].fam] = 1; });
      var fam = pick(r, Object.keys(fams)); b.fam = fam; b.need = rr(r, tpl.n[0], tpl.n[1]);
      b.name = tpl.name.replace('{fam}', D.FAMILIES[fam][0]); b.text = tpl.text.replace('{n}', b.need).replace('{famPlural}', D.FAMILIES[fam][1]);
    } else if (tpl.id === 'depth') {
      var top = h.story.ended ? 999 : D.STORY_FLOORS;
      b.d = Math.min(top, Math.max(2, (h.story.deepest || 1) + rr(r, 1, 3))); b.need = 1;
      b.name = tpl.name; b.text = tpl.text.replace('{d}', b.d);
    } else if (tpl.id === 'gold') {
      b.need = Math.round(120 * sc); b.name = tpl.name; b.text = tpl.text.replace('{n}', b.need);
    } else {
      b.need = rr(r, tpl.n[0], tpl.n[1]); b.name = tpl.name; b.text = tpl.text.replace('{n}', b.need);
    }
    b.reward = { gold: Math.round(45 * sc * (tpl.id === 'gold' ? 0.6 : 1) * (1 + b.need * 0.04)), xp: Math.round(40 * sc * sc) };
    return b;
  }
  function rollBoard(h) {
    h.quests = h.quests || { board: [], boardSeed: 1, side: {}, done: 0 };
    var r = rng(h.quests.boardSeed || 1);
    while (h.quests.board.length < 3) { h.quests.board.push(makeBounty(h, r)); h.quests.boardSeed = (h.quests.boardSeed || 1) + 7919; r = rng(h.quests.boardSeed); }
  }
  function bounty(G, kind, data) {
    if (G.mode === 'daily') return;
    var h = G.hero; data = data || {};
    (h.quests.board || []).forEach(function (b) {
      if (b.done) return;
      var inc = 0;
      if (b.tpl === 'kill' && kind === 'kill' && data.fam === b.fam) inc = 1;
      else if (b.tpl === 'elite' && kind === 'kill' && data.elite) inc = 1;
      else if (b.tpl === 'depth' && kind === 'depth' && data.d >= b.d) inc = 1;
      else if (b.tpl === 'puzzle' && kind === 'puzzle') inc = 1;
      else if (b.tpl === 'lore' && kind === 'lore') inc = 1;
      else if (b.tpl === 'event' && kind === 'event') inc = 1;
      else if (b.tpl === 'gold' && kind === 'gold') inc = data.n || 0;
      if (!inc) return;
      b.have = Math.min(b.need, b.have + inc);
      if (b.have >= b.need) { b.done = true; log(G, 'Bounty complete: ' + b.name + '! Claim it at the Quest Board.', 'good'); emit(G, { t: 'bounty' }); }
    });
  }
  function claimBounty(h, id) {
    var q = h.quests.board, i;
    for (i = 0; i < q.length; i++) if (q[i].id === id) break;
    if (i >= q.length || !q[i].done) return null;
    var b = q.splice(i, 1)[0];
    h.gold += b.reward.gold; gainXp(null, h, b.reward.xp); h.quests.done++;
    rollBoard(h);
    return b.reward;
  }
  function sideOffers(h, npc) {
    var out = [];
    for (var id in D.SIDEQUESTS) { var SQ = D.SIDEQUESTS[id]; if (SQ.giver === npc && (h.story.cleared || 0) >= SQ.act - 1) out.push({ id: id, state: h.quests.side[id] || 'new' }); }
    return out;
  }
  function acceptSide(h, id) { if (!D.SIDEQUESTS[id] || h.quests.side[id]) return false; h.quests.side[id] = 'active'; return true; }
  function turnInSide(h, id) {
    var SQ = D.SIDEQUESTS[id]; if (!SQ || h.quests.side[id] !== 'found') return null;
    h.quests.side[id] = 'done';
    var rw = SQ.reward, r = rng(hashStr(h.id + id)), got = [];
    if (rw.gold) { h.gold += rw.gold; got.push('+' + rw.gold + ' gold'); }
    if (rw.xp) { gainXp(null, h, rw.xp); got.push('+' + rw.xp + ' XP'); }
    if (rw.item) { var it = makeItem(r, { ilvl: Math.max(2, h.story.deepest), rarity: rw.item, cls: h.cls }); h.bag.push(it); got.push(it.name); }
    if (rw.cons) for (var k in rw.cons) { h.cons[k] = (h.cons[k] || 0) + rw.cons[k]; got.push('+' + rw.cons[k] + ' ' + D.CONSUMABLES[k].name); }
    if (rw.mats) for (var m in rw.mats) { h.mats[m] = (h.mats[m] || 0) + rw.mats[m]; got.push('+' + rw.mats[m] + ' ' + D.MATERIALS[m].name); }
    if (rw.bless) { addBlessing(h, rw.bless, 3); got.push(D.BLESSINGS[rw.bless].name); }
    if (rw.flag) h.flags[rw.flag] = 1;
    return got;
  }
  // the story stage NPC lines key off (0..5 acts cleared, 6 after the ending)
  function storyStage(h) { return h.story.ended ? 6 : clamp(h.story.cleared || 0, 0, 5); }
  function npcLine(h, npc, r) {
    var N = D.NPCS[npc], st = storyStage(h), best = 0;
    for (var k in N.lines) if (+k <= st && +k >= best) best = +k;
    var pool = N.lines[best] || N.lines[0];
    if (N.barks.length && r && chance(r, 0.35)) return pick(r, N.barks);
    return r ? pick(r, pool) : pool[0];
  }

  // ===========================================================================
  //  starting and ending a delve
  // ===========================================================================
  function startRun(h, depth, o) {
    o = o || {};
    var G = newRunShell(h, o);
    h.stats.runs++;
    genFloor(G, depth);
    var B = D.BIOMES[G.biome];
    log(G, 'Floor ' + depth + ' — ' + B.name + '. ' + pick(G.r, B.flavor), 'floor');
    if (G.mode === 'story' && (depth - 1) % 5 === 0 && depth <= D.STORY_FLOORS) emit(G, { t: 'act', act: actAt(depth), biome: G.biome });
    return G;
  }
  // sync the run's player back into the hero (hp, resource)
  function syncHero(G) { if (!G || !G.hero) return; G.hero.hp = Math.max(1, G.p.hp); G.hero.res = Math.round(G.p.res); G.hero.updated = Date.now(); }
  function applyDeath(G) {
    var h = G.hero, d = difficulty(h), lost = { gold: 0, items: [] };
    h.stats.deaths++;
    lost.gold = Math.floor(h.gold * d.goldLoss); h.gold -= lost.gold;
    if (!d.keepLoot) { h.bag = h.bag.filter(function (it) { if (it.fresh) { lost.items.push(it.name); return false; } return true; }); }
    // a little xp toward the next level, never a level
    var xl = Math.floor(h.xp * 0.2); h.xp -= xl; lost.xp = xl;
    h.bless = (h.bless || []).filter(function (b) { return D.BLESSINGS[b.id].good; });
    return lost;
  }
  function newGamePlus(h) {
    if (!h.story.ended) return false;
    h.story.ng = (h.story.ng || 0) + 1; h.story.cleared = 0; h.story.ended = false; h.story.deepest = 1; h.story.waypoints = [1];
    h.quests.side = {};
    return true;
  }

  // ===========================================================================
  //  daily challenge
  // ===========================================================================
  function dailyInfo(date) {
    var seed = hashStr('deepdelve-daily:' + date), mods = Object.keys(D.DAILY_MODS);
    return { date: date, seed: seed, cls: D.CLASS_ORDER[seed % D.CLASS_ORDER.length], mod: mods[(seed >>> 5) % mods.length] };
  }
  function dailyHero(info) {
    var r = rng(info.seed);
    var h = newHero(info.cls, 'Daily Delver', 'normal', r);
    h.id = 'daily'; h.level = 3; h.gold = 0;
    h.equip.weapon = makeItem(r, { base: C[info.cls].kit.weapon, ilvl: 3, rarity: 'magic' });
    h.cons.potion = info.mod === 'frail' ? 8 : 4; h.cons.recall = 0;
    h.story.waypoints = [1];
    h.hp = stats(h).maxHp;
    return h;
  }
  function dailyScore(G) { var r = G.run; return Math.max(0, (G.depth - 1) * 100 + r.kills * 4 + r.elites * 25 + r.bosses * 300 + Math.floor(r.gold / 4) + (G.hero.level - 3) * 15); }

  // ===========================================================================
  //  travel & auto-explore (paths over what you've seen)
  // ===========================================================================
  function knownSafe(G, x, y) {
    var i = y * G.w + x; if (!G.seen[i]) return false;
    var t = G.t[i]; if (!WALKABLE[t] || t === T.LAVA || t === T.CHASM) return false;
    if (G.gas[i] || G.fire[i]) return false;
    for (var k = 0; k < G.objs.length; k++) { var o = G.objs[k]; if (o.x === x && o.y === y && ((o.k === 'trap' && !o.hidden) || BLOCKING[o.k] || o.k === 'vent')) return false; }
    var m = monAt(G, x, y); if (m && !m.ally && monVisible(G, m)) return false;
    return true;
  }
  function pathFrom(G, dist, tx, ty) {
    if (dist[ty * G.w + tx] >= 9999) return null;
    var path = [[tx, ty]], x = tx, y = ty;
    while (dist[y * G.w + x] > 1) {
      var d = dist[y * G.w + x], moved = false;
      for (var k = 0; k < 4; k++) { var nx = x + DIRS4[k][0], ny = y + DIRS4[k][1]; if (inb(G, nx, ny) && dist[ny * G.w + nx] === d - 1) { x = nx; y = ny; path.unshift([x, y]); moved = true; break; } }
      if (!moved) return null;
    }
    return path;
  }
  function travelPath(G, tx, ty) {
    if (!inb(G, tx, ty) || !G.seen[ty * G.w + tx]) return null;
    var dist = bfs(G, G.p.x, G.p.y, function (x, y) { return (x === tx && y === ty) || knownSafe(G, x, y); });
    return pathFrom(G, dist, tx, ty);
  }
  var LOOT_K = { gold: 1, item: 1, cons: 1, lore: 1, quest: 1 };
  function explorePath(G) {
    var dist = bfs(G, G.p.x, G.p.y, function (x, y) { return knownSafe(G, x, y); }), best = null, bd = 9999;
    for (var i = 0; i < G.objs.length; i++) { var o = G.objs[i]; if (LOOT_K[o.k] && G.seen[o.y * G.w + o.x] && !(o.k === 'item' && G.hero.bag.length >= BAG_MAX)) { var d = dist[o.y * G.w + o.x]; if (d > 0 && d < bd) { bd = d; best = [o.x, o.y]; } } }
    if (!best) for (var y = 0; y < G.h; y++) for (var x = 0; x < G.w; x++) {
      var j = y * G.w + x, dj = dist[j]; if (dj >= 9999 || dj === 0 || dj >= bd) continue;
      for (var k = 0; k < 4; k++) { var nx = x + DIRS4[k][0], ny = y + DIRS4[k][1]; if (inb(G, nx, ny) && !G.seen[ny * G.w + nx]) { bd = dj; best = [x, y]; break; } }
    }
    if (!best) return null;
    return pathFrom(G, dist, best[0], best[1]);
  }

  // ===========================================================================
  //  saves: runs, heroes, the roster; legacy migration; merging devices
  // ===========================================================================
  function serializeRun(G) {
    var o = {};
    for (var k in G) {
      if (k === 'hero' || k === 'vis' || k === 'distP' || k === '_ps' || k === 'ev' || k === 'rooms' || k === 'startRoom') continue;
      o[k] = G[k];
    }
    o.t = G.t.map(function (v) { return String.fromCharCode(48 + v); }).join('');
    o.seen = G.seen.join('');
    o.log = G.log.slice(-40);
    if (G.mode === 'daily') o.dailyHero = G.hero;
    return JSON.parse(JSON.stringify(o));
  }
  function loadRun(o, h) {
    if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.t !== 'string') return null;
    var G = copy(o);
    G.t = o.t.split('').map(function (c) { return c.charCodeAt(0) - 48; });
    G.seen = o.seen.split('').map(function (c) { return c === '1' ? 1 : 0; });
    if (G.t.length !== G.w * G.h || G.seen.length !== G.t.length) return null;
    G.hero = o.dailyHero ? normHero(o.dailyHero) : h; delete G.dailyHero;
    if (!G.hero) return null;
    G.ev = []; G._ps = null; G.modal = G.modal && G.modal.k === 'dialog' ? null : G.modal;
    computeFov(G);
    return G;
  }
  function progressScore(h) {
    if (!h || !h.story) return 0;
    return ((h.story.ng || 0) * 100 + (h.story.cleared || 0) * 10 + (h.story.ended ? 5 : 0)) * 100000 + (h.level || 1) * 1000 + (h.story.deepest || 0) * 10 + Math.min(9, (h.lore || []).length / 5);
  }
  function validItem(it) {
    if (!it || typeof it !== 'object' || !D.BASES[it.base]) return null;
    it.slot = D.BASES[it.base].slot;
    if (!D.RARITIES[it.rarity]) it.rarity = 'common';
    it.ilvl = clamp(+it.ilvl || 1, 1, 99); it.plus = clamp(+it.plus || 0, 0, 10);
    if (it.uq && !D.UNIQUES[it.uq]) delete it.uq;
    if (it.set && !D.SETS[it.set]) delete it.set;
    var aff = {}; for (var k in it.aff || {}) if (D.AFFIXES[k] && typeof it.aff[k] === 'number' && isFinite(it.aff[k])) aff[k] = it.aff[k];
    it.aff = aff;
    if (!it.uid) it.uid = 'i' + Math.random().toString(36).slice(2, 10);
    it.name = itemName(it);
    return it;
  }
  function normHero(h) {
    if (!h || typeof h !== 'object') return null;
    var base = newHero(C[h.cls] ? h.cls : 'warrior', h.name, h.difficulty, rng(hashStr(String(h.id || 'x'))));
    var out = base;
    out.id = typeof h.id === 'string' ? h.id.slice(0, 40) : base.id;
    out.name = cleanName(h.name);
    out.cls = C[h.cls] ? h.cls : 'warrior';
    out.level = clamp(Math.floor(+h.level || 1), 1, LEVEL_CAP); out.xp = Math.max(0, Math.floor(+h.xp || 0));
    out.difficulty = D.DIFFICULTIES[h.difficulty] ? h.difficulty : 'normal';
    out.gold = Math.max(0, Math.floor(+h.gold || 0));
    out.equip = { weapon: null, armor: null, helm: null, charm: null };
    if (h.equip) D.SLOTS.forEach(function (sl) { var it = validItem(h.equip[sl]); if (it && it.slot === sl) out.equip[sl] = it; });
    if (!out.equip.weapon || C[out.cls].weapons.indexOf(out.equip.weapon.base) < 0) out.equip.weapon = out.equip.weapon && C[out.cls].weapons.indexOf(out.equip.weapon.base) >= 0 ? out.equip.weapon : base.equip.weapon || makeItem(rng(7), { base: C[out.cls].kit.weapon, ilvl: 1, rarity: 'common' });
    out.bag = (Array.isArray(h.bag) ? h.bag : []).map(validItem).filter(Boolean).slice(0, BAG_MAX + 8);
    out.cons = {}; if (h.cons) D.CONS_ORDER.forEach(function (k) { if (h.cons[k] > 0) out.cons[k] = Math.min(99, Math.floor(h.cons[k])); });
    out.mats = { scrap: 0, dust: 0, soul: 0 }; if (h.mats) for (var mk in out.mats) out.mats[mk] = Math.max(0, Math.floor(+h.mats[mk] || 0));
    out.talents = [null, null, null, null, null];
    if (Array.isArray(h.talents)) for (var i = 0; i < 5; i++) { var tid = h.talents[i]; if (tid && D.TALENTS[out.cls][i].some(function (t) { return t.id === tid; }) && out.level >= D.TALENT_LEVELS[i]) out.talents[i] = tid; }
    var st = h.story || {};
    out.story = { cleared: clamp(+st.cleared || 0, 0, 5), ng: clamp(+st.ng || 0, 0, 99), ended: !!st.ended, deepest: clamp(+st.deepest || 0, 0, 999), waypoints: [1], endless: +st.endless || 0, seen: (st.seen && typeof st.seen === 'object') ? st.seen : {} };
    (Array.isArray(st.waypoints) ? st.waypoints : [1]).forEach(function (w) { w = Math.floor(+w); if (w >= 1 && (w - 1) % 5 === 0 && w <= Math.max(out.story.deepest, 1) && out.story.waypoints.indexOf(w) < 0) out.story.waypoints.push(w); });
    out.story.waypoints.sort(function (a, b) { return a - b; });
    out.lore = (Array.isArray(h.lore) ? h.lore : []).filter(function (n) { return typeof n === 'number' && D.LORE[n]; });
    out.bestiary = (h.bestiary && typeof h.bestiary === 'object' && !Array.isArray(h.bestiary)) ? h.bestiary : {};
    var q = h.quests || {};
    out.quests = { board: Array.isArray(q.board) ? q.board.filter(function (b) { return b && b.id && b.reward; }).slice(0, 3) : [], boardSeed: +q.boardSeed || 1, side: {}, done: +q.done || 0 };
    if (q.side) for (var sq in q.side) if (D.SIDEQUESTS[sq] && ['active', 'found', 'done'].indexOf(q.side[sq]) >= 0) out.quests.side[sq] = q.side[sq];
    rollBoard(out);
    out.bless = (Array.isArray(h.bless) ? h.bless : []).filter(function (b) { return b && D.BLESSINGS[b.id] && b.n > 0; });
    out.flags = (h.flags && typeof h.flags === 'object') ? h.flags : {};
    out.town = { visit: +(h.town && h.town.visit) || 0 };
    out.stats = base.stats; if (h.stats) for (var sk in out.stats) out.stats[sk] = Math.max(0, +h.stats[sk] || 0);
    out.created = +h.created || Date.now(); out.updated = +h.updated || 0; out.rev = +h.rev || 1;
    if (h.needsClass) { out.needsClass = true; out.legacy = Array.isArray(h.legacy) ? h.legacy.slice(0, 20) : []; }
    var s = stats(out);
    out.hp = clamp(+h.hp || s.maxHp, 1, s.maxHp); out.res = clamp(+h.res || 0, 0, s.maxRes);
    out.v = SAVE_V;
    return out;
  }
  // The old single "Deepdelve" hero (schema v4) becomes a veteran in the roster.
  // Their class is unknown, so they pick one on first open; old gear is reforged
  // into equivalents of the same rarity and item level, materials become scrap.
  function migrateLegacy(old) {
    if (!old || typeof old !== 'object' || !(old.level >= 1)) return null;
    var r = rng(hashStr('legacy:' + (old.createdAt || 0) + ':' + (old.name || '')));
    var h = newHero('warrior', old.name || 'Veteran', D.DIFFICULTIES[old.difficulty] ? old.difficulty : 'normal', r);
    h.needsClass = true;
    h.level = clamp(Math.floor(old.level), 1, 30);
    h.gold = Math.max(0, Math.floor(+old.gold || 0));
    var trophies = Array.isArray(old.trophies) ? old.trophies.length : 0;
    h.story.cleared = clamp(trophies, 0, 4);
    h.story.deepest = clamp(Math.round((+old.maxDepth || 0) * 25 / 35), h.story.cleared * 5, 25);
    for (var a = 1; a <= h.story.cleared; a++) h.story.waypoints.push(a * 5 + 1);
    h.story.deepest = Math.max(h.story.deepest, h.story.waypoints[h.story.waypoints.length - 1]);
    var st = old.stats || {};
    h.stats.kills = +st.kills || 0; h.stats.deaths = +st.deaths || 0; h.stats.floors = +st.floors || 0; h.stats.runs = +st.runs || 0;
    var items = [].concat(Array.isArray(old.owned) ? old.owned : [], Array.isArray(old.stash) ? old.stash : []);
    var rmap = { common: 'common', magic: 'magic', rare: 'rare', epic: 'epic', legendary: 'legendary' };
    h.legacy = items.filter(function (it) { return it && typeof it === 'object' && it.slot; }).map(function (it) {
      return { slot: it.slot === 'trinket' ? 'charm' : it.slot, rarity: rmap[it.rarity] || 'common', ilvl: clamp(Math.round((+it.ilvl || 1) * 25 / 35 + 1), 1, 30) };
    }).sort(function (x, y) { return D.RARITY_ORDER.indexOf(y.rarity) - D.RARITY_ORDER.indexOf(x.rarity); }).slice(0, 12);
    var bag = old.bag || {};
    h.cons = { potion: Math.min(20, (+bag.potion || 0) + (+bag.hpotion || 0)), tonic: Math.min(20, (+bag.elixir || 0) + (+bag.eelixir || 0)), bomb: Math.min(20, +bag.bomb || 0), recall: 2, key: Math.min(10, +bag.key || 0), elixir: Math.min(10, +bag.antidote || 0) };
    var mats = old.mats || {}, tot = 0; for (var m in mats) tot += +mats[m] || 0;
    h.mats.scrap = Math.floor(tot / 2); h.mats.dust = Math.floor((+mats.crystal || 0) / 3) + Math.floor((+mats.essence || 0) / 2);
    h.flags.veteran = 1;
    h.created = +old.createdAt || Date.now();
    h.hp = stats(h).maxHp;
    return h;
  }
  // setClass: for a migrated veteran (or a fresh hero before their first delve)
  function setClass(h, cls) {
    if (!C[cls]) return false;
    h.cls = cls; h.talents = [null, null, null, null, null];
    var r = rng(hashStr(h.id + ':cls:' + cls)), k = C[cls].kit;
    h.equip.weapon = makeItem(r, { base: k.weapon, ilvl: Math.max(1, h.level - 1), rarity: 'magic' });
    h.equip.armor = makeItem(r, { base: k.armor, ilvl: Math.max(1, h.level - 1), rarity: 'magic' });
    (h.legacy || []).forEach(function (L) {
      if (h.bag.length >= BAG_MAX) return;
      var o = { slot: L.slot, ilvl: L.ilvl, rarity: L.rarity, cls: cls };
      if (L.slot === 'weapon') o.base = pick(r, C[cls].weapons);
      var it = makeItem(r, o); if (it.slot !== L.slot && L.rarity !== 'legendary') it = makeItem(r, { slot: L.slot, ilvl: L.ilvl, rarity: L.rarity === 'legendary' ? 'epic' : L.rarity, cls: cls });
      h.bag.push(it);
    });
    // auto-equip the best piece per slot
    D.SLOTS.forEach(function (sl) {
      var best = null;
      h.bag.forEach(function (it) { if (it.slot === sl && canWield(h, it) && itemScore(it, cls) > itemScore(h.equip[sl], cls) && (!best || itemScore(it, cls) > itemScore(best, cls))) best = it; });
      if (best) equip(h, best.uid);
    });
    delete h.needsClass; delete h.legacy;
    h.hp = stats(h).maxHp; h.res = C[cls].res.start;
    return true;
  }
  function newRoster() { return { v: SAVE_V, slots: {}, order: [], active: null, stash: [], stashRev: 0, daily: { days: {}, best: null }, deleted: {}, rev: 0 }; }
  function normRoster(r) {
    var o = newRoster();
    if (!r || typeof r !== 'object') return o;
    if (r.slots && typeof r.slots === 'object') for (var id in r.slots) { var h = normHero(r.slots[id]); if (h) { h.id = id; o.slots[id] = h; } }
    o.deleted = (r.deleted && typeof r.deleted === 'object') ? r.deleted : {};
    for (var d in o.deleted) delete o.slots[d];
    o.order = (Array.isArray(r.order) ? r.order : []).filter(function (id) { return o.slots[id]; });
    for (id in o.slots) if (o.order.indexOf(id) < 0) o.order.push(id);
    o.active = o.slots[r.active] ? r.active : (o.order[0] || null);
    o.stash = (Array.isArray(r.stash) ? r.stash : []).map(validItem).filter(Boolean).slice(0, STASH_MAX);
    o.stashRev = +r.stashRev || 0;
    if (r.daily && typeof r.daily === 'object') {
      if (r.daily.days && typeof r.daily.days === 'object') for (var day in r.daily.days) { var v = r.daily.days[day]; if (v && typeof v.best === 'number') o.daily.days[day] = { best: v.best, tries: +v.tries || 0, cls: v.cls, depth: +v.depth || 0 }; }
      if (r.daily.best && typeof r.daily.best.score === 'number') o.daily.best = r.daily.best;
    }
    // keep only the last 60 days
    var days = Object.keys(o.daily.days).sort(); while (days.length > 60) delete o.daily.days[days.shift()];
    o.rev = +r.rev || 0;
    return o;
  }
  function betterHero(a, b) {
    var pa = progressScore(a), pb = progressScore(b);
    if (pa !== pb) return pa > pb ? a : b;
    if ((a.rev || 0) !== (b.rev || 0)) return (a.rev || 0) > (b.rev || 0) ? a : b;
    return (a.updated || 0) >= (b.updated || 0) ? a : b;
  }
  // merge(local, remote): union of heroes (each the more progressed copy),
  // deletions win, the newer stash, the best daily scores. Local keeps `active`.
  function mergeRoster(local, remote) {
    var a = normRoster(local), b = normRoster(remote), o = newRoster();
    var del = {}, k;
    for (k in a.deleted) del[k] = Math.max(a.deleted[k], del[k] || 0);
    for (k in b.deleted) del[k] = Math.max(b.deleted[k], del[k] || 0);
    o.deleted = del;
    var ids = a.order.concat(b.order.filter(function (id) { return a.order.indexOf(id) < 0; }));
    ids.forEach(function (id) {
      if (del[id]) return;
      var x = a.slots[id], y = b.slots[id];
      o.slots[id] = x && y ? betterHero(x, y) : (x || y);
      o.order.push(id);
    });
    o.active = o.slots[a.active] ? a.active : (o.order[0] || null);
    var sa = a.stashRev || 0, sb = b.stashRev || 0;
    o.stash = sa >= sb ? a.stash : b.stash; o.stashRev = Math.max(sa, sb);
    [a, b].forEach(function (src) {
      for (var day in src.daily.days) {
        var v = src.daily.days[day], cur = o.daily.days[day];
        if (!cur) o.daily.days[day] = copy(v);
        else { if (v.best > cur.best) { cur.best = v.best; cur.cls = v.cls; cur.depth = v.depth; } cur.tries = Math.max(cur.tries, v.tries); }
      }
      if (src.daily.best && (!o.daily.best || src.daily.best.score > o.daily.best.score)) o.daily.best = copy(src.daily.best);
    });
    o.rev = Math.max(a.rev, b.rev);
    return o;
  }
  function recordDaily(roster, info, score, depth) {
    var d = roster.daily.days[info.date] || { best: 0, tries: 0, cls: info.cls, depth: 0 };
    d.tries++;
    var isBest = score > d.best;
    if (isBest) { d.best = score; d.depth = depth; d.cls = info.cls; }
    roster.daily.days[info.date] = d;
    var allTime = !roster.daily.best || score > roster.daily.best.score;
    if (allTime) roster.daily.best = { score: score, date: info.date, cls: info.cls, depth: depth };
    return { best: isBest, allTime: allTime };
  }
  function stashPut(roster, h, uid_) {
    if (roster.stash.length >= STASH_MAX) return false;
    var f = findItem(h, uid_); if (!f || f.where !== 'bag') return false;
    h.bag.splice(f.idx, 1); delete f.it.fresh; roster.stash.push(f.it); roster.stashRev++; return true;
  }
  function stashTake(roster, h, uid_) {
    if (h.bag.length >= BAG_MAX) return false;
    for (var i = 0; i < roster.stash.length; i++) if (roster.stash[i].uid === uid_) { h.bag.push(roster.stash.splice(i, 1)[0]); roster.stashRev++; return true; }
    return false;
  }

  // ===========================================================================
  //  exports
  // ===========================================================================
  return {
    D: D, T: T, WALKABLE: WALKABLE, OPAQUE: OPAQUE, DIRS4: DIRS4, MW: MW, MH: MH, SAVE_V: SAVE_V, BAG_MAX: BAG_MAX, STASH_MAX: STASH_MAX, ROSTER_MAX: ROSTER_MAX, LEVEL_CAP: LEVEL_CAP, TPL: TPL,
    // utils
    rng: rng, rf: rf, ri: ri, hashStr: hashStr, clamp: clamp, cheb: cheb, manh: manh,
    // heroes
    newHero: newHero, randomName: randomName, cleanName: cleanName, stats: stats, xpForLevel: xpForLevel, gainXp: gainXp, abilitiesFor: abilitiesFor,
    talentPoints: talentPoints, chooseTalent: chooseTalent, talentFlags: talentFlags, hasTalentFlag: hasTalentFlag, setClass: setClass,
    // items
    makeItem: makeItem, itemStats: itemStats, itemLines: itemLines, itemName: itemName, itemScore: itemScore, itemValue: itemValue, mainValue: mainValue, canWield: canWield,
    equip: equip, unequip: unequip, findItem: findItem, upgradeItem: upgradeItem, upgradeCost: upgradeCost, maxPlus: maxPlus, reforgeItem: reforgeItem, reforgeCost: reforgeCost,
    salvageItem: salvageItem, salvageYield: salvageYield, sellItem: sellItem, craftItem: craftItem, craftCost: craftCost, hasMats: hasMats, setCounts: setCounts,
    // world
    biomeAt: biomeAt, actAt: actAt, isBossFloor: isBossFloor, startRun: startRun, genFloor: genFloor, newRunShell: newRunShell, computeFov: computeFov, visible: visible, monVisible: monVisible,
    los: los, bfs: bfs, flood: flood, tile: tile, objAt: objAt, monAt: monAt, actorAt: actorAt, blocksObj: blocksObj, displayName: displayName, monDef: monDef, lightRadius: lightRadius,
    hpCurve: hpCurve, powCurve: powCurve, spawnMon: spawnMon, spawnBoss: spawnBoss,
    // turns
    act: act, abilityState: abilityState, abilityTargets: abilityTargets, abilityCost: abilityCost, abilityRange: abilityRange, hostilesVisible: hostilesVisible,
    eventChoice: eventChoice, closeModal: closeModal, travelPath: travelPath, explorePath: explorePath, strike: strike, killMon: killMon, addStatus: addStatus,
    // town
    townArrive: townArrive, shopStock: shopStock, buy: buy, consPrice: consPrice, templeCosts: templeCosts, uncurse: uncurse, buyBlessing: buyBlessing, respec: respec,
    rollBoard: rollBoard, claimBounty: claimBounty, sideOffers: sideOffers, acceptSide: acceptSide, turnInSide: turnInSide, npcLine: npcLine, storyStage: storyStage,
    // runs + saves
    syncHero: syncHero, applyDeath: applyDeath, newGamePlus: newGamePlus, serializeRun: serializeRun, loadRun: loadRun,
    normHero: normHero, migrateLegacy: migrateLegacy, newRoster: newRoster, normRoster: normRoster, mergeRoster: mergeRoster, progressScore: progressScore,
    stashPut: stashPut, stashTake: stashTake,
    dailyInfo: dailyInfo, dailyHero: dailyHero, dailyScore: dailyScore, recordDaily: recordDaily
  };
});
