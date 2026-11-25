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
